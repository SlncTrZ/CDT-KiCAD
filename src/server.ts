/**
 * KiCAD MCP Server implementation
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import express from "express";
import { spawn, exec, ChildProcess } from "child_process";
import { randomUUID } from "crypto";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { logger } from "./logger.js";
import { LocalKiCADRuntimeAdapter } from "./runtime/local-kicad-runtime-adapter.js";
import { deriveKiCadSitePackages, findPythonExecutable } from "./runtime/python-discovery.js";
import { computeCommandTimeout, DEFAULT_COMMAND_TIMEOUT_MS } from "./command-timeout.js";
import { PROVIDER_ID, PROVIDER_VERSION } from "./provider-contract.js";
import { createContractToolTarget } from "./tool-contract-boundary.js";
import {
  commandMayMutate,
  decorateWithReceipt,
  hasAutomaticReconciliation,
  OperationBlockedError,
  OperationReceiptStore,
  OperationUncertainError,
  splitOperationId,
} from "./operation-receipts.js";
import { ensureKicadSuccess } from "./tools/tool-response.js";

export const DEFAULT_MAX_QUEUE_DEPTH = 32;
export const DEFAULT_ENQUEUE_DEADLINE_MS = 120_000;

/**
 * Fail-closed ceilings for the Node-side Python response buffer.
 *
 * Responses are single-line JSON frames; the largest legitimate payloads are
 * inline base64 board/schematic renders (default 1600×1200 PNG ≈ single-digit
 * MB), so 32 MiB per frame leaves wide headroom while a runaway worker costs
 * bounded heap. Lengths count UTF-16 units, which over-counts non-ASCII —
 * the fail-safe direction for a cap.
 */
export const MAX_BRIDGE_LINE_BYTES = 32 * 1024 * 1024;
export const MAX_BRIDGE_BUFFER_BYTES = 64 * 1024 * 1024;

export type BridgeRuntimeEvent = "completed" | "timeout" | "error" | "rejected";

export interface BridgeRuntimeMetric {
  event: BridgeRuntimeEvent;
  command: string;
  request_id: number;
  queue_depth: number;
  queue_wait_ms: number;
  execution_ms: number;
  total_latency_ms: number;
  timeout_count: number;
  error_count: number;
  rejection_count: number;
}

export interface BridgeRuntimeMetricsSnapshot {
  queue_depth: number;
  in_flight: number;
  max_queue_depth: number;
  enqueue_deadline_ms: number;
  timeout_count: number;
  error_count: number;
  rejection_count: number;
}

export interface BridgeRuntimeOptions {
  maxQueueDepth?: number;
  enqueueDeadlineMs?: number;
  now?: () => number;
  metricsSink?: (metric: BridgeRuntimeMetric) => void;
}

type ProviderRuntimeErrorKind =
  | "rate_limited"
  | "timeout"
  | "provider_unavailable"
  | "internal_error";

/**
 * Bridge-local error carrying the canonical provider error fields.
 * MCP callers still receive the SDK's tool error envelope, while direct
 * bridge consumers/tests can inspect kind + retryable deterministically.
 */
export class ProviderRuntimeError extends Error {
  public readonly providerMessage: string;

  constructor(
    public readonly kind: ProviderRuntimeErrorKind,
    public readonly retryable: boolean,
    message: string,
    public readonly details?: Readonly<Record<string, unknown>>,
  ) {
    // The MCP SDK converts thrown tool errors into isError results using only
    // Error.message. Encode the canonical provider payload there so kind and
    // retryability survive the SDK boundary as parseable JSON text.
    const payload = {
      success: false,
      kind,
      retryable,
      message,
      ...(details ? { details } : {}),
    };
    super(JSON.stringify(payload));
    this.name = "ProviderRuntimeError";
    this.providerMessage = message;
  }

  toJSON(): Record<string, unknown> {
    return {
      success: false,
      kind: this.kind,
      retryable: this.retryable,
      message: this.providerMessage,
      ...(this.details ? { details: this.details } : {}),
    };
  }
}

function positiveInteger(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : fallback;
}

// Import tool registration functions
import { registerHelpTools } from "./tools/help.js";
import { registerProjectTools } from "./tools/project.js";
import { registerBoardTools } from "./tools/board.js";
import { registerComponentTools } from "./tools/component.js";
import { registerRoutingTools } from "./tools/routing.js";
import { registerDesignRuleTools } from "./tools/design-rules.js";
import { registerExportTools } from "./tools/export.js";
import { registerSchematicTools } from "./tools/schematic.js";
import { registerLibraryTools } from "./tools/library.js";
import { registerSymbolLibraryTools } from "./tools/library-symbol.js";
import { registerSchematicHierarchyTools } from "./tools/schematic-hierarchy.js";
import { registerSchematicLayoutTools } from "./tools/schematic-layout.js";
import { registerSchematicBatchTools } from "./tools/schematic-batch.js";
import { registerJLCPCBApiTools } from "./tools/jlcpcb-api.js";
import { registerDigiKeyApiTools } from "./tools/digikey-api.js";
import { registerPartsRegistryTools } from "./tools/parts-registry.js";
import { registerDatasheetTools } from "./tools/datasheet.js";
import { registerFootprintTools } from "./tools/footprint.js";
import { registerSymbolCreatorTools } from "./tools/symbol-creator.js";
import { registerUITools } from "./tools/ui.js";
import { registerFreeroutingTools } from "./tools/freerouting.js";
import { registerEagleTools } from "./tools/eagle.js";
import { registerPcbImportTools } from "./tools/pcb-import.js";
import { registerValidationTools } from "./tools/validation.js";
import { registerRouterTools } from "./tools/router.js";

// Import resource registration functions
import { registerProjectResources } from "./resources/project.js";
import { registerBoardResources } from "./resources/board.js";
import { registerComponentResources } from "./resources/component.js";
import { registerLibraryResources } from "./resources/library.js";

// Import prompt registration functions
import { registerComponentPrompts } from "./prompts/component.js";
import { registerRoutingPrompts } from "./prompts/routing.js";
import { registerDesignPrompts } from "./prompts/design.js";
import { registerFootprintPrompts } from "./prompts/footprint.js";

/**
 * Python/KiCad discovery lives in src/runtime/python-discovery.ts (single
 * canonical implementation shared with the workstation agent). The local
 * server path below consumes it without behavior change.
 */

/**
 * KiCAD MCP Server class
 */
export class KiCADMcpServer {
  private server: McpServer;
  private pythonProcess: ChildProcess | null = null;
  private kicadScriptPath: string;
  private stdioTransport!: StdioServerTransport;
  private requestQueue: Array<{
    request: {
      command: string;
      params: any;
      timeout: number;
      requestId: number;
      operationId?: string;
      mutating?: boolean;
      reconciliationFor?: string;
    };
    enqueuedAtMs?: number;
    enqueueTimeoutHandle?: NodeJS.Timeout;
    resolve: Function;
    reject: Function;
  }> = [];
  private processingRequest = false;
  private responseBuffer: string = "";
  /** Monotonic bridge-local ID; Python echoes it back as `_requestId` (#373). */
  private nextInternalRequestId = 1;
  private currentRequestHandler: {
    requestId: number;
    command?: string;
    enqueuedAtMs?: number;
    startedAtMs?: number;
    resolve: Function;
    reject: Function;
    timeoutHandle: NodeJS.Timeout;
    params?: Record<string, unknown>;
    operationId?: string;
    mutating?: boolean;
    reconciliationFor?: string;
    timedOut?: boolean;
  } | null = null;
  private readonly maxQueueDepth: number;
  private readonly enqueueDeadlineMs: number;
  private readonly now: () => number;
  private readonly metricsSink: (metric: BridgeRuntimeMetric) => void;
  private timeoutCount = 0;
  private errorCount = 0;
  private rejectionCount = 0;

  /** Semantic operation receipts survive bridge correlation timeouts/retries. */
  private readonly operationReceipts = new OperationReceiptStore();
  private readonly lateOperationResults = new Map<string, any>();

  /** Resolved when Python prints {"type":"ready"} — stdin loop is live. */
  private readyPromise: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (err: Error) => void;
  /** Accumulates stdout until the READY marker is seen. */
  private startupBuffer: string = "";
  /** True after READY marker detected; persistent handler takes over. */
  private readyDetected: boolean = false;
  /** True once the Python bridge has started; shared by STDIO + HTTP modes. */
  private bridgeStarted: boolean = false;

  /**
   * K1 provider/execution seam. Local child-process dispatch stays the
   * default implementation; the bound dispatch below is the same
   * callKicadScript queue (receipts, correlation, timeouts) with identical
   * behavior. Remote transports compose against this port, never against
   * server internals. NOTE: per-call `timeoutMs` passed via the port is not
   * yet plumbed into the queue — the command-timeout policy still applies.
   */
  private readonly runtimePort: LocalKiCADRuntimeAdapter;

  /**
   * Constructor for the KiCAD MCP Server
   * @param kicadScriptPath Path to the Python KiCAD interface script
   * @param logLevel Log level for the server
   */
  constructor(
    kicadScriptPath: string,
    logLevel: "error" | "warn" | "info" | "debug" = "info",
    runtimeOptions: BridgeRuntimeOptions = {},
  ) {
    // Set up the logger
    logger.setLogLevel(logLevel);

    this.maxQueueDepth = positiveInteger(
      runtimeOptions.maxQueueDepth ?? process.env.KICAD_MCP_MAX_QUEUE_DEPTH,
      DEFAULT_MAX_QUEUE_DEPTH,
    );
    this.enqueueDeadlineMs = positiveInteger(
      runtimeOptions.enqueueDeadlineMs ?? process.env.KICAD_MCP_ENQUEUE_DEADLINE_MS,
      DEFAULT_ENQUEUE_DEADLINE_MS,
    );
    this.now = runtimeOptions.now ?? Date.now;
    this.metricsSink =
      runtimeOptions.metricsSink ??
      ((metric) => {
        logger.info(`bridge_metric ${JSON.stringify(metric)}`);
      });

    // Check if KiCAD script exists
    this.kicadScriptPath = kicadScriptPath;
    if (!existsSync(this.kicadScriptPath)) {
      throw new Error(`KiCAD interface script not found: ${this.kicadScriptPath}`);
    }

    // Initialize the MCP server (SlncTrZ provider identity: kicad)
    this.server = new McpServer({
      name: PROVIDER_ID,
      version: PROVIDER_VERSION,
      description: "CDT-KiCAD generic ECAD execution engine (SlncTrZ provider: kicad)",
    });
    // Create the ready promise (resolved when Python sends {"type":"ready"})
    this.readyPromise = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });

    // Initialize STDIO transport
    this.stdioTransport = new StdioServerTransport();
    logger.info("Using STDIO transport for local communication");

    // Register tools, resources, and prompts
    this.registerAll();

    // K1 seam: local adapter delegates to this instance's dispatch queue.
    this.runtimePort = new LocalKiCADRuntimeAdapter((command, params) =>
      this.callKicadScript(command, params),
    );
  }

  /** Provider-facing runtime seam (local child-process dispatch by default). */
  public getRuntimePort(): LocalKiCADRuntimeAdapter {
    return this.runtimePort;
  }

  /**
   * Register all tools, resources, and prompts on the primary server.
   */
  private registerAll(): void {
    this.registerAllOn(this.server);
  }

  /**
   * Register everything on any MCP server instance. HTTP network mode builds
   * one stateless server per request sharing this instance's Python bridge.
   */
  public registerAllOn(target: McpServer): void {
    logger.info("Registering KiCAD tools, resources, and prompts...");

    const toolTarget = createContractToolTarget(target);
    const callToolBackend = async (command: string, params: any): Promise<any> =>
      ensureKicadSuccess(await this.callKicadScript(command, params));

    // SlncTrZ provider contract FIRST (help, system_status, system_capabilities)
    registerHelpTools(toolTarget, () => callToolBackend("get_backend_state", {}));

    // Register router tools (for tool discovery and execution)
    registerRouterTools(toolTarget, callToolBackend);

    // Register all tools through the provider-wide strict/error boundary.
    registerProjectTools(toolTarget, callToolBackend);
    registerBoardTools(toolTarget, callToolBackend);
    registerComponentTools(toolTarget, callToolBackend);
    registerRoutingTools(toolTarget, callToolBackend);
    registerDesignRuleTools(toolTarget, callToolBackend);
    registerExportTools(toolTarget, callToolBackend);
    registerSchematicTools(toolTarget, callToolBackend);
    registerLibraryTools(toolTarget, callToolBackend);
    registerSymbolLibraryTools(toolTarget, callToolBackend);
    registerSchematicHierarchyTools(toolTarget, callToolBackend);
    registerSchematicLayoutTools(toolTarget, callToolBackend);
    registerSchematicBatchTools(toolTarget, callToolBackend);
    registerJLCPCBApiTools(toolTarget, callToolBackend);
    registerDigiKeyApiTools(toolTarget, callToolBackend);
    registerPartsRegistryTools(toolTarget);
    registerDatasheetTools(toolTarget, callToolBackend);
    registerFootprintTools(toolTarget, callToolBackend);
    registerSymbolCreatorTools(toolTarget, callToolBackend);
    registerUITools(toolTarget, callToolBackend);
    registerFreeroutingTools(toolTarget, callToolBackend);
    registerEagleTools(toolTarget, callToolBackend);
    registerPcbImportTools(toolTarget, callToolBackend);
    registerValidationTools(toolTarget, callToolBackend);

    // Register all resources
    registerProjectResources(target, this.callKicadScript.bind(this));
    registerBoardResources(target, this.callKicadScript.bind(this));
    registerComponentResources(target, this.callKicadScript.bind(this));
    registerLibraryResources(target, this.callKicadScript.bind(this));

    // Register all prompts
    registerComponentPrompts(target);
    registerRoutingPrompts(target);
    registerDesignPrompts(target);
    registerFootprintPrompts(target);

    logger.info("All KiCAD tools, resources, and prompts registered");
  }

  /**
   * Validate prerequisites before starting the server
   */
  private async validatePrerequisites(pythonExe: string): Promise<boolean> {
    const isWindows = process.platform === "win32";
    const isLinux = process.platform !== "win32" && process.platform !== "darwin";
    const errors: string[] = [];

    // Check if Python executable exists (for absolute paths) or is executable (for commands)
    const isAbsolutePath =
      pythonExe.startsWith("/") || pythonExe.startsWith("C:") || pythonExe.startsWith("\\");
    let pythonExecutableAvailable = true;

    if (isAbsolutePath) {
      // Absolute path: use existsSync
      if (!existsSync(pythonExe)) {
        pythonExecutableAvailable = false;
        errors.push(`Python executable not found: ${pythonExe}`);

        if (isWindows) {
          errors.push("Windows: Install KiCAD 9.0+ from https://www.kicad.org/download/windows/");
          errors.push("Or run: .\\setup-windows.ps1 for automatic configuration");
        } else if (isLinux) {
          errors.push("Linux: Install KiCAD 9.0+ or set KICAD_PYTHON environment variable");
          errors.push("Set KICAD_PYTHON to specify a custom Python path");
        }
      }
    } else {
      // Command name: verify it's executable via --version test
      logger.info(`Validating command-based Python executable: ${pythonExe}`);
      try {
        const { stdout } = await new Promise<{
          stdout: string;
          stderr: string;
        }>((resolve, reject) => {
          exec(
            `"${pythonExe}" --version`,
            {
              timeout: 3000,
              env: { ...process.env },
            },
            (error: any, stdout: string, stderr: string) => {
              if (error) {
                reject(error);
              } else {
                resolve({ stdout, stderr });
              }
            },
          );
        });

        logger.info(`Python version check passed: ${stdout.trim()}`);
      } catch (error: any) {
        pythonExecutableAvailable = false;
        errors.push(`Python executable not found in PATH: ${pythonExe}`);
        errors.push(`Error: ${error.message}`);
        errors.push("Set KICAD_PYTHON environment variable to specify full path");

        if (isLinux) {
          errors.push("");
          errors.push("Linux troubleshooting:");
          errors.push("1. Check if python3 is installed: which python3");
          errors.push("2. Install KiCAD: sudo apt install kicad (Ubuntu/Debian)");
          errors.push("3. Set KICAD_PYTHON=/usr/bin/python3 in your MCP config");
        }
      }
    }

    // Check if kicad_interface.py exists
    if (!existsSync(this.kicadScriptPath)) {
      errors.push(`KiCAD interface script not found: ${this.kicadScriptPath}`);
    }

    // Check if dist/index.js exists (if running from compiled code)
    const distPath = join(dirname(dirname(this.kicadScriptPath)), "dist", "index.js");
    if (!existsSync(distPath)) {
      errors.push("Project not built. Run: npm run build");
    }

    // Try to test pcbnew import (quick validation)
    if (pythonExecutableAvailable && existsSync(this.kicadScriptPath)) {
      logger.info("Validating pcbnew module access...");

      const testCommand = `"${pythonExe}" -c "import pcbnew; print('OK')"`;

      try {
        const { stdout, stderr } = await new Promise<{
          stdout: string;
          stderr: string;
        }>((resolve, reject) => {
          exec(
            testCommand,
            {
              timeout: 5000,
              env: { ...process.env },
            },
            (error: any, stdout: string, stderr: string) => {
              if (error) {
                reject(error);
              } else {
                resolve({ stdout, stderr });
              }
            },
          );
        });

        if (!stdout.includes("OK")) {
          errors.push("pcbnew module import test failed");
          errors.push(`Output: ${stdout}`);
          errors.push(`Errors: ${stderr}`);

          if (isWindows) {
            errors.push("");
            errors.push("Windows troubleshooting:");
            errors.push(
              "1. Set PYTHONPATH=C:\\Program Files\\KiCad\\9.0\\lib\\python3\\dist-packages",
            );
            errors.push(
              '2. Test: "C:\\Program Files\\KiCad\\9.0\\bin\\python.exe" -c "import pcbnew"',
            );
            errors.push("3. Run: .\\setup-windows.ps1 for automatic fix");
            errors.push("4. See: docs/WINDOWS_TROUBLESHOOTING.md");
          }
        } else {
          logger.info("✓ pcbnew module validated successfully");
        }
      } catch (error: any) {
        errors.push(`pcbnew validation failed: ${error.message}`);

        if (isWindows) {
          errors.push("");
          errors.push("This usually means:");
          errors.push("- KiCAD is not installed");
          errors.push("- PYTHONPATH is incorrect");
          errors.push("- Python cannot find pcbnew module");
          errors.push("");
          errors.push("Quick fix: Run .\\setup-windows.ps1");
        }
      }
    }

    // Log all errors
    if (errors.length > 0) {
      logger.error("=".repeat(70));
      logger.error("STARTUP VALIDATION FAILED");
      logger.error("=".repeat(70));
      errors.forEach((err) => logger.error(err));
      logger.error("=".repeat(70));

      // Also write to stderr for Claude Desktop to capture
      process.stderr.write("\n" + "=".repeat(70) + "\n");
      process.stderr.write("KiCAD MCP Server - Startup Validation Failed\n");
      process.stderr.write("=".repeat(70) + "\n");
      errors.forEach((err) => process.stderr.write(err + "\n"));
      process.stderr.write("=".repeat(70) + "\n\n");

      return false;
    }

    return true;
  }

  /**
   * Start the MCP server and the Python KiCAD interface
   */
  async start(): Promise<void> {
    await this.connectStdio();
    await this.startBridge();
  }

  /**
   * Connect the primary server to STDIO.
   *
   * Phase 0 stays FIRST (see #377): Python + pcbnew/wxApp initialisation can
   * take 55-125 s, and the transport must already be live so client requests
   * do not stack up against a silent server. Tools, resources and prompts are
   * all registered in the constructor, so initialize/tools/list/prompts/get
   * need no Python; tool CALLS queue until the backend is ready (see
   * processNextRequest's ready gate).
   */
  public async connectStdio(): Promise<void> {
    logger.info("Starting KiCAD MCP server...");
    logger.info("Connecting MCP server to STDIO transport...");
    try {
      await this.server.connect(this.stdioTransport);
      logger.info("Successfully connected to STDIO transport");
    } catch (error) {
      logger.error(`Failed to connect to STDIO transport: ${error}`);
      throw error;
    }
  }

  /**
   * Spawn the Python KiCAD bridge, wait for READY and warm up.
   * Idempotent: STDIO + HTTP modes share one bridge.
   */
  public async startBridge(): Promise<void> {
    if (this.bridgeStarted) {
      logger.info("Python bridge already running — reusing it");
      return;
    }
    try {
      // Start the Python process for KiCAD scripting
      logger.info(`Starting Python process with script: ${this.kicadScriptPath}`);
      const pythonExe = findPythonExecutable(this.kicadScriptPath);

      logger.info(`Using Python executable: ${pythonExe}`);

      // Validate prerequisites
      const isValid = await this.validatePrerequisites(pythonExe);
      if (!isValid) {
        throw new Error("Prerequisites validation failed. See logs above for details.");
      }
      // PYTHONPATH precedence: explicit env override → site-packages derived
      // from the detected KiCAD python (any version / install location) →
      // legacy 9.0 fallback as a last resort.
      const derivedSitePackages = deriveKiCadSitePackages(pythonExe);
      if (derivedSitePackages && !process.env.PYTHONPATH) {
        logger.info(`Using KiCAD site-packages: ${derivedSitePackages}`);
      }
      this.pythonProcess = spawn(pythonExe, [this.kicadScriptPath], {
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          PYTHONPATH:
            process.env.PYTHONPATH ||
            derivedSitePackages ||
            "C:/Program Files/KiCad/9.0/lib/python3/dist-packages",
        },
      });

      // Listen for process exit
      this.pythonProcess.on("exit", (code, signal) => {
        logger.warn(`Python process exited with code ${code} and signal ${signal}`);
        this.pythonProcess = null;
      });

      // Listen for process errors
      this.pythonProcess.on("error", (err) => {
        logger.error(`Python process error: ${err.message}`);
      });

      // Set up error logging for stderr
      if (this.pythonProcess.stderr) {
        this.pythonProcess.stderr.on("data", (data: Buffer) => {
          logger.error(`Python stderr: ${data.toString()}`);
        });
      }

      // ——— Phase 1: stdout handler that detects the READY marker ———
      // Before Python reaches main() it may spend 55-65 s on wxApp init.
      // The stdin loop is only live after main() prints {"type":"ready"}.
      // Until then we buffer everything and scan for that exact JSON line.
      if (this.pythonProcess.stdout) {
        this.pythonProcess.stdout.on("data", (data: Buffer) => {
          if (this.readyDetected) {
            // Persistent handler (post-warm-up)
            this.handlePythonResponse(data);
          } else {
            this.startupBuffer += data.toString();
            const lines = this.startupBuffer.split("\n");
            for (let i = 0; i < lines.length; i++) {
              const line = lines[i].trim();
              if (!line) continue;
              try {
                const obj = JSON.parse(line);
                if (obj.type === "ready") {
                  logger.info("Python process READY — stdin loop is live");
                  this.readyDetected = true;
                  // Replay any remaining buffered lines through the persistent handler
                  const remaining = lines.slice(i + 1).join("\n");
                  if (remaining.trim()) {
                    this.handlePythonResponse(Buffer.from(remaining));
                  }
                  this.resolveReady();
                  // Drain any tool calls that queued while Python was
                  // initialising (the ready gate in processNextRequest).
                  setTimeout(() => this.processNextRequest(), 0);
                  return;
                }
              } catch {
                // Not valid JSON yet; keep buffering
              }
            }
          }
        });
      }

      // ——— Phase 2: wait for Python READY ———
      logger.info("Waiting for Python process to be ready...");
      await this.waitForReady(120_000);
      logger.info("Python process is ready.");
      // ——— Phase 3: background warm-up (transport already live) ———
      // Warm-up can take 55-125 s (wxApp + symbol library parse), but
      // the MCP transport is already live so the client timeout does not
      // apply.  Tools invoked during warm-up will work; the first
      // search_symbols may be slower if warm-up hasn't completed yet.
      logger.info("Sending warm-up command (background)...");
      await this.runWarmup(120_000);
      logger.info("Warm-up complete — pcbnew/wxApp initialised");

      // Write a ready message to stderr (for debugging)
      process.stderr.write("KiCAD MCP SERVER READY\n");

      logger.info("KiCAD MCP server started and ready");
      this.bridgeStarted = true;
    } catch (error) {
      logger.error(`Failed to start KiCAD MCP server: ${error}`);
      throw error;
    }
  }

  /**
   * Build a stateless per-request server sharing this instance's Python
   * bridge. Used once per HTTP request in network mode; the internal
   * Node→Python queue serialises concurrent calls.
   */
  public newHttpServer(): McpServer {
    const httpServer = new McpServer({
      name: PROVIDER_ID,
      version: PROVIDER_VERSION,
      description: "CDT-KiCAD generic ECAD execution engine (SlncTrZ provider: kicad)",
    });
    this.registerAllOn(httpServer);
    return httpServer;
  }

  /**
   * Stop the MCP server and clean up resources
   */
  async stop(): Promise<void> {
    logger.info("Stopping KiCAD MCP server...");

    // Kill the Python process if it's running
    if (this.pythonProcess) {
      this.pythonProcess.kill();
      this.pythonProcess = null;
    }

    logger.info("KiCAD MCP server stopped");
  }

  /**
   * Wait for the Python process to print {"type":"ready"} on stdout,
   * signalling that the stdin loop is live and the process can accept
   * commands.
   */
  private async waitForReady(timeoutMs: number): Promise<void> {
    return new Promise((_resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Python process did not send READY within ${timeoutMs / 1000} s`));
      }, timeoutMs);
      this.readyPromise
        .then(() => {
          clearTimeout(timeout);
          _resolve();
        })
        .catch(reject);
    });
  }

  /**
   * Send a _warmup command to the Python process to force full
   * pcbnew/wxApp initialisation.  On macOS this can take 55-65 s;
   * we use a generous timeout so the cost is paid during startup
   * rather than on the first user tool call.
   *
   * Wires into the existing request infrastructure so the persistent
   * stdout handler (already active post-READY) processes the response.
   */
  private async runWarmup(timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      if (!this.pythonProcess || !this.pythonProcess.stdin) {
        logger.warn("Python process not running — skipping warm-up");
        resolve();
        return;
      }

      // With the transport connected before Python is up (#377), a tool call
      // may already have queued and dispatched the moment READY fired. A real
      // command exercises pcbnew exactly like _warmup would -- and writing
      // into its handler slot would corrupt the in-flight request.
      if (this.processingRequest || this.currentRequestHandler) {
        logger.info("Skipping explicit warm-up — a queued command is already warming the backend");
        resolve();
        return;
      }

      const requestId = this.allocateInternalRequestId();
      const requestStr = JSON.stringify({ command: "_warmup", params: {}, requestId });

      const timeoutHandle = setTimeout(() => {
        // Only abandon our own slot: if the warm-up response already arrived,
        // the handler belongs to a later request (#373).
        if (this.currentRequestHandler?.requestId !== requestId) return;
        logger.warn(
          `Warm-up timed out after ${timeoutMs / 1000} s — ` +
            "continuing without full initialisation",
        );
        this.processingRequest = false;
        this.currentRequestHandler = null;
        resolve();
        setTimeout(() => this.processNextRequest(), 0);
      }, timeoutMs);

      // Use the existing request infrastructure to avoid race conditions
      // with the persistent stdout handler.
      this.processingRequest = true;
      this.currentRequestHandler = {
        requestId,
        resolve: (result: any) => {
          clearTimeout(timeoutHandle);
          if (result?.success) {
            logger.info(`Warm-up succeeded: pcbnew ${result.version} (${result.elapsed_s}s)`);
          } else {
            logger.warn(`Warm-up returned failure: ${result?.message || "unknown"} — continuing`);
          }
          resolve();
        },
        reject: (err: Error) => {
          clearTimeout(timeoutHandle);
          logger.warn(`Warm-up failed: ${err.message} — continuing`);
          resolve(); // don't fail the whole server
        },
        timeoutHandle,
      };

      this.pythonProcess.stdin.write(requestStr + "\n");
    });
  }

  /** Current bounded-queue counters for diagnostics and deterministic fixtures. */
  public getBridgeRuntimeMetrics(): BridgeRuntimeMetricsSnapshot {
    return {
      queue_depth: this.requestQueue.length,
      in_flight: this.processingRequest ? 1 : 0,
      max_queue_depth: this.maxQueueDepth,
      enqueue_deadline_ms: this.enqueueDeadlineMs,
      timeout_count: this.timeoutCount,
      error_count: this.errorCount,
      rejection_count: this.rejectionCount,
    };
  }

  private emitBridgeMetric(
    event: BridgeRuntimeEvent,
    command: string,
    requestId: number,
    enqueuedAtMs: number,
    startedAtMs?: number,
    endedAtMs = this.now(),
  ): void {
    const queueWaitEnd = startedAtMs ?? endedAtMs;
    const metric: BridgeRuntimeMetric = {
      event,
      command,
      request_id: requestId,
      queue_depth: this.requestQueue.length,
      queue_wait_ms: Math.max(0, queueWaitEnd - enqueuedAtMs),
      execution_ms: startedAtMs === undefined ? 0 : Math.max(0, endedAtMs - startedAtMs),
      total_latency_ms: Math.max(0, endedAtMs - enqueuedAtMs),
      timeout_count: this.timeoutCount,
      error_count: this.errorCount,
      rejection_count: this.rejectionCount,
    };

    try {
      this.metricsSink(metric);
    } catch (error) {
      logger.warn(
        `Bridge metrics sink failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private expireQueuedRequest(requestId: number): void {
    const index = this.requestQueue.findIndex((entry) => entry.request.requestId === requestId);
    if (index < 0) return;

    const [entry] = this.requestQueue.splice(index, 1);
    if (entry.enqueueTimeoutHandle) clearTimeout(entry.enqueueTimeoutHandle);

    const endedAtMs = this.now();
    const enqueuedAtMs = entry.enqueuedAtMs ?? endedAtMs;
    this.timeoutCount += 1;

    const error = new ProviderRuntimeError(
      "timeout",
      true,
      `KiCAD bridge queue wait exceeded ${this.enqueueDeadlineMs}ms for ${entry.request.command}`,
      {
        queue_depth: this.requestQueue.length,
        enqueue_deadline_ms: this.enqueueDeadlineMs,
      },
    );
    if (entry.request.operationId) {
      this.operationReceipts.abandonBeforeDispatch(entry.request.operationId);
    }
    entry.reject(error);
    this.emitBridgeMetric(
      "timeout",
      entry.request.command,
      entry.request.requestId,
      enqueuedAtMs,
      undefined,
      endedAtMs,
    );

    if (!this.processingRequest) {
      setTimeout(() => this.processNextRequest(), 0);
    }
  }

  /**
   * Call the KiCAD scripting interface to execute commands.
   *
   * The existing serializer remains one-at-a-time, but waiting work is bounded
   * by both queue depth and a wall-clock enqueue deadline.
   *
   * @param command The command to execute
   * @param params The parameters for the command
   * @returns The result of the command execution
   */
  private async callKicadScript(command: string, rawParams: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const requestId = this.allocateInternalRequestId();
      const enqueuedAtMs = this.now();

      if (!this.pythonProcess) {
        logger.error("Python process is not running");
        this.errorCount += 1;
        const error = new ProviderRuntimeError(
          "provider_unavailable",
          true,
          "Python process for KiCAD scripting is not running",
        );
        this.emitBridgeMetric("error", command, requestId, enqueuedAtMs, undefined, enqueuedAtMs);
        reject(error);
        return;
      }

      let operationId: string | undefined;
      let params: Record<string, unknown>;
      try {
        const split = splitOperationId(rawParams);
        operationId = split.operationId;
        params = split.params;
      } catch (error) {
        reject(error);
        return;
      }

      const mutating = commandMayMutate(command);
      if (mutating) {
        operationId = operationId ?? randomUUID();
        const existing = this.operationReceipts.get(operationId);
        if (existing) {
          let begun;
          try {
            begun = this.operationReceipts.begin(operationId, command, params);
          } catch (error) {
            reject(error);
            return;
          }

          if (begun.kind === "committed" || begun.kind === "failed") {
            resolve(decorateWithReceipt(begun.receipt.result, begun.receipt));
            return;
          }
          if (begun.kind === "uncertain") {
            reject(new OperationUncertainError(begun.receipt));
            return;
          }
          reject(new Error(`operation_id=${operationId} is already in flight`));
          return;
        }

        const blocker = this.operationReceipts.firstUncertain();
        if (blocker) {
          reject(new OperationBlockedError(blocker));
          return;
        }
      }

      if (this.requestQueue.length >= this.maxQueueDepth) {
        this.rejectionCount += 1;
        const error = new ProviderRuntimeError(
          "rate_limited",
          true,
          `KiCAD bridge queue is full (${this.maxQueueDepth} waiting requests)`,
          {
            queue_depth: this.requestQueue.length,
            max_queue_depth: this.maxQueueDepth,
          },
        );
        this.emitBridgeMetric(
          "rejected",
          command,
          requestId,
          enqueuedAtMs,
          undefined,
          enqueuedAtMs,
        );
        reject(error);
        return;
      }

      if (mutating && operationId) {
        try {
          this.operationReceipts.begin(operationId, command, params);
        } catch (error) {
          reject(error);
          return;
        }
      }

      const commandTimeout = computeCommandTimeout(command, params);
      if (commandTimeout !== DEFAULT_COMMAND_TIMEOUT_MS) {
        logger.info(`Using extended timeout (${commandTimeout / 1000}s) for command: ${command}`);
      }

      const enqueueTimeoutHandle = setTimeout(
        () => this.expireQueuedRequest(requestId),
        this.enqueueDeadlineMs,
      );

      this.requestQueue.push({
        request: {
          command,
          params,
          timeout: commandTimeout,
          requestId,
          operationId,
          mutating,
        },
        enqueuedAtMs,
        enqueueTimeoutHandle,
        resolve,
        reject,
      });

      if (!this.processingRequest) {
        this.processNextRequest();
      }
    });
  }

  private enqueueReconciliation(
    operationId: string,
    command: string,
    params: Record<string, unknown>,
    lateResult: any,
  ): void {
    this.lateOperationResults.set(operationId, lateResult);
    this.requestQueue.unshift({
      request: {
        command: "_reconcile_operation",
        params: {
          operation_id: operationId,
          command,
          params,
          late_result: lateResult,
        },
        timeout: DEFAULT_COMMAND_TIMEOUT_MS,
        requestId: this.allocateInternalRequestId(),
        mutating: false,
        reconciliationFor: operationId,
      },
      resolve: () => undefined,
      reject: () => undefined,
    });
  }

  private static backendOwner(result: any): string | undefined {
    if (!result || typeof result !== "object") return undefined;
    const owner = result.backend_owner ?? result._backend ?? result.backend;
    return typeof owner === "string" ? owner : undefined;
  }

  /**
   * Handle incoming data from Python process stdout
   * This is a persistent handler that processes all responses
   */
  private handlePythonResponse(data: Buffer): void {
    const chunk = data.toString();
    logger.debug(`Received data chunk: ${chunk.length} bytes`);
    this.responseBuffer += chunk;

    // An unbounded append is a memory-exhaustion vector: a misbehaving worker
    // that never emits '\n' would grow the heap without limit. Fail closed —
    // discard the bytes and fail the pending request with a clear error code.
    if (this.responseBuffer.length > MAX_BRIDGE_BUFFER_BYTES) {
      const received = this.responseBuffer.length;
      this.responseBuffer = "";
      logger.error(
        `Bridge response buffer overflow (${received} chars without a complete frame); ` +
          `discarding and failing the pending request`,
      );
      this.abortPendingRequest(
        new ProviderRuntimeError(
          "internal_error",
          false,
          `KiCAD bridge response exceeded the ${MAX_BRIDGE_BUFFER_BYTES}-char buffer cap ` +
            `(${received} chars without a complete frame)`,
          {
            code: "BRIDGE_RESPONSE_BUFFER_OVERFLOW",
            cap_chars: MAX_BRIDGE_BUFFER_BYTES,
            received_chars: received,
          },
        ),
      );
      return;
    }

    // Try to parse complete JSON responses (may have multiple or partial)
    this.tryParseResponse();
  }

  /**
   * Fail-closed abort of the in-flight bridge request: clears its timer,
   * records the error, leaves a semantic receipt uncertain when a mutation
   * may have been dispatched, and resumes the queue. Used when the response
   * channel itself is untrustworthy (oversized frame/buffer), where
   * correlation with a late response can no longer be relied upon.
   */
  private abortPendingRequest(error: ProviderRuntimeError): void {
    const handler = this.currentRequestHandler;
    if (!handler) {
      this.processingRequest = false;
      setTimeout(() => this.processNextRequest(), 0);
      return;
    }
    clearTimeout(handler.timeoutHandle);
    this.currentRequestHandler = null;
    this.processingRequest = false;
    this.errorCount += 1;
    if (handler.command && handler.enqueuedAtMs !== undefined) {
      this.emitBridgeMetric(
        "error",
        handler.command,
        handler.requestId,
        handler.enqueuedAtMs,
        handler.startedAtMs,
        this.now(),
      );
    }
    // The worker may have acted before misbehaving; uncertain is the honest
    // receipt state, mirroring the execution-timeout path.
    if (handler.operationId) {
      this.operationReceipts.markUncertain(handler.operationId, "degraded_uncertain");
    }
    if (handler.reconciliationFor) {
      this.operationReceipts.markUncertain(handler.reconciliationFor, "degraded_uncertain");
    }
    handler.reject(error);
    setTimeout(() => this.processNextRequest(), 0);
  }

  /**
   * Try to parse complete JSON response frames from the buffer.
   *
   * Responses from the Python side are single-line JSON terminated by '\n'
   * (written via _write_response). The buffer may also contain non-JSON
   * preamble lines (e.g. C-level warnings from pcbnew that leaked to the
   * response fd before the redirect took effect).
   *
   * Consume only newline-delimited frames. Each bridge request carries a
   * process-local request ID which Python echoes back as `_requestId`; a
   * response whose ID does not match the pending request is discarded
   * instead of being delivered to whichever request happens to be pending
   * (#373). Without this, one timeout desynced the pipeline permanently:
   * request A times out, request B dispatches, A's late response resolves
   * B's handler, and every response after that is off by one.
   */
  private tryParseResponse(): void {
    while (true) {
      const newlineIndex = this.responseBuffer.indexOf("\n");
      if (newlineIndex < 0) return; // frame still arriving — keep collecting

      const line = this.responseBuffer.slice(0, newlineIndex).trim();
      this.responseBuffer = this.responseBuffer.slice(newlineIndex + 1);
      if (!line) continue;

      // A single frame past the cap can never be a legitimate tool result
      // (see MAX_BRIDGE_LINE_BYTES headroom note). Drop it fail-closed rather
      // than JSON-parsing tens of megabytes into the heap: the pending request
      // — whose response this frame may have been — is failed with a clear
      // error code, and parsing continues with the remaining frames.
      if (line.length > MAX_BRIDGE_LINE_BYTES) {
        logger.error(
          `Discarding oversized Python response frame (${line.length} chars > ` +
            `${MAX_BRIDGE_LINE_BYTES} cap); failing the pending request`,
        );
        this.abortPendingRequest(
          new ProviderRuntimeError(
            "internal_error",
            false,
            `KiCAD bridge response frame exceeded the ${MAX_BRIDGE_LINE_BYTES}-char ` +
              `frame cap (${line.length} chars)`,
            {
              code: "BRIDGE_RESPONSE_LINE_TOO_LONG",
              cap_chars: MAX_BRIDGE_LINE_BYTES,
              received_chars: line.length,
            },
          ),
        );
        continue;
      }

      let result: any;
      try {
        result = JSON.parse(line);
      } catch {
        logger.warn(`Stripped non-JSON preamble from Python response: ${line.substring(0, 200)}`);
        continue;
      }

      const responseRequestId =
        result && typeof result === "object" ? result._requestId : undefined;
      const handler = this.currentRequestHandler;
      if (!handler) {
        logger.warn(
          `Discarding Python response ${String(responseRequestId)} with no pending request`,
        );
        continue;
      }

      if (responseRequestId !== handler.requestId) {
        // A late response from a request that already timed out. Discarding
        // it (rather than resolving the current handler with it) is the fix:
        // the pending request's own response is still on its way.
        logger.warn(
          `Discarding stale Python response ${String(responseRequestId)}; ` +
            `waiting for ${handler.requestId}`,
        );
        continue;
      }

      delete result._requestId;
      logger.debug(
        `Completed KiCAD command ${handler.requestId} with result: ` +
          `${result.success ? "success" : "failure"}`,
      );

      clearTimeout(handler.timeoutHandle);
      this.currentRequestHandler = null;
      this.processingRequest = false;

      if (!handler.timedOut && handler.command && handler.enqueuedAtMs !== undefined) {
        const endedAtMs = this.now();
        const failed = result?.success === false;
        if (failed) this.errorCount += 1;
        this.emitBridgeMetric(
          failed ? "error" : "completed",
          handler.command,
          handler.requestId,
          handler.enqueuedAtMs,
          handler.startedAtMs,
          endedAtMs,
        );
      }

      if (handler.reconciliationFor) {
        const operationId = handler.reconciliationFor;
        const lateResult = this.lateOperationResults.get(operationId);
        const backendOwner =
          KiCADMcpServer.backendOwner(result) ?? KiCADMcpServer.backendOwner(lateResult);
        if (result?.success && result?.state === "committed") {
          this.operationReceipts.markCommitted(operationId, lateResult, backendOwner, {
            strategy: "read_after_write",
            evidence: result.evidence,
          });
          this.lateOperationResults.delete(operationId);
        } else if (result?.state === "failed") {
          this.operationReceipts.markFailed(operationId, lateResult ?? result, backendOwner, {
            strategy: "read_after_write",
            evidence: result.evidence,
          });
          this.lateOperationResults.delete(operationId);
        } else {
          this.operationReceipts.markUncertain(operationId, backendOwner);
        }
        handler.resolve(result);
        setTimeout(() => this.processNextRequest(), 0);
        return;
      }

      if (handler.timedOut) {
        if (handler.operationId) {
          const backendOwner = KiCADMcpServer.backendOwner(result);
          if (result?.success === false) {
            this.operationReceipts.markFailed(handler.operationId, result, backendOwner);
          } else if (handler.command && hasAutomaticReconciliation(handler.command)) {
            this.enqueueReconciliation(
              handler.operationId,
              handler.command,
              handler.params ?? {},
              result,
            );
          } else {
            this.operationReceipts.markUncertain(handler.operationId, backendOwner);
          }
        }
        setTimeout(() => this.processNextRequest(), 0);
        return;
      }

      let deliveredResult = result;
      if (handler.operationId) {
        const backendOwner = KiCADMcpServer.backendOwner(result);
        const receipt =
          result?.success === false
            ? this.operationReceipts.markFailed(handler.operationId, result, backendOwner)
            : this.operationReceipts.markCommitted(handler.operationId, result, backendOwner);
        deliveredResult = decorateWithReceipt(result, receipt);
      }

      handler.resolve(deliveredResult);
      setTimeout(() => this.processNextRequest(), 0);
      return;
    }
  }

  private allocateInternalRequestId(): number {
    return this.nextInternalRequestId++;
  }

  /**
   * Process the next request in the queue
   */
  private processNextRequest(): void {
    // If no more requests or already processing, return
    if (this.requestQueue.length === 0 || this.processingRequest) {
      return;
    }

    // Backend still initialising: hold the queue. Drained when the READY
    // marker fires (see the startup stdout handler). Without this gate, a
    // tool called during the 55-125 s init window would start its 30 s
    // timeout against Python's own startup and always lose (#377).
    if (!this.readyDetected) {
      return;
    }

    const queued = this.requestQueue[0];
    if (queued.request.mutating && !queued.request.reconciliationFor) {
      const blocker = this.operationReceipts.firstUncertain(queued.request.operationId);
      if (blocker) {
        const blocked = this.requestQueue.shift()!;
        if (blocked.enqueueTimeoutHandle) clearTimeout(blocked.enqueueTimeoutHandle);
        if (blocked.request.operationId) {
          this.operationReceipts.abandonBeforeDispatch(blocked.request.operationId);
        }

        const endedAtMs = this.now();
        const enqueuedAtMs = blocked.enqueuedAtMs ?? endedAtMs;
        this.rejectionCount += 1;
        const error = new OperationBlockedError(blocker);
        blocked.reject(error);
        this.emitBridgeMetric(
          "rejected",
          blocked.request.command,
          blocked.request.requestId,
          enqueuedAtMs,
          undefined,
          endedAtMs,
        );
        setTimeout(() => this.processNextRequest(), 0);
        return;
      }
    }

    this.processingRequest = true;

    const entry = this.requestQueue.shift()!;
    const { request, resolve, reject } = entry;
    if (entry.enqueueTimeoutHandle) clearTimeout(entry.enqueueTimeoutHandle);
    const startedAtMs = this.now();
    const enqueuedAtMs = entry.enqueuedAtMs ?? startedAtMs;
    let dispatchAttempted = false;

    try {
      logger.debug(`Processing KiCAD command: ${request.command}`);

      // Bridge correlation and semantic operation identity are distinct:
      // requestId is one frame; operationId survives caller timeout/retry.
      const requestStr = JSON.stringify({
        command: request.command,
        params: request.params,
        timeout: request.timeout,
        requestId: request.requestId,
        ...(request.operationId ? { operationId: request.operationId } : {}),
      });

      // Set a timeout (use command-specific timeout or default)
      const timeoutDuration = request.timeout || DEFAULT_COMMAND_TIMEOUT_MS;
      const timeoutHandle = setTimeout(() => {
        // The response may have arrived between the timer firing and this
        // callback running; only abandon our own request (#373).
        if (this.currentRequestHandler?.requestId !== request.requestId) return;
        logger.error(`Command timeout after ${timeoutDuration / 1000}s: ${request.command}`);
        logger.error(`Buffer contents: ${this.responseBuffer.substring(0, 200)}...`);

        const handler = this.currentRequestHandler;
        const endedAtMs = this.now();
        this.timeoutCount += 1;
        this.emitBridgeMetric(
          "timeout",
          request.command,
          request.requestId,
          enqueuedAtMs,
          startedAtMs,
          endedAtMs,
        );

        if (request.reconciliationFor) {
          // Reconciliation is read-only. If it times out, the original receipt
          // stays uncertain but the bridge itself may continue serving reads.
          this.operationReceipts.markUncertain(
            request.reconciliationFor,
            "degraded_uncertain",
          );
          this.currentRequestHandler = null;
          this.processingRequest = false;
          reject(
            new ProviderRuntimeError(
              "timeout",
              true,
              `Reconciliation timeout for operation_id=${request.reconciliationFor}`,
            ),
          );
          setTimeout(() => this.processNextRequest(), 0);
          return;
        }

        if (request.operationId && handler) {
          // A caller timeout is not cancellation. Keep this exact request as
          // the active bridge frame so its late response can be correlated and
          // reconciled before another mutation is admitted.
          const receipt = this.operationReceipts.markUncertain(
            request.operationId,
            "degraded_uncertain",
          );
          handler.timedOut = true;
          reject(new OperationUncertainError(receipt));
          return;
        }

        this.currentRequestHandler = null;
        this.processingRequest = false;
        reject(
          new ProviderRuntimeError(
            "timeout",
            true,
            `Command timeout after ${timeoutDuration / 1000}s: ${request.command}`,
          ),
        );
        setTimeout(() => this.processNextRequest(), 0);
      }, timeoutDuration);

      this.currentRequestHandler = {
        requestId: request.requestId,
        command: request.command,
        enqueuedAtMs,
        startedAtMs,
        resolve,
        reject,
        timeoutHandle,
        params: request.params,
        operationId: request.operationId,
        mutating: request.mutating,
        reconciliationFor: request.reconciliationFor,
      };

      // Write the request to the Python process.
      logger.debug(`Sending request: ${requestStr}`);
      dispatchAttempted = true;
      this.pythonProcess?.stdin?.write(requestStr + "\n");
    } catch (error) {
      logger.error(`Error processing request: ${error}`);

      // Reset processing state and cancel any live execution timer.
      if (this.currentRequestHandler?.requestId === request.requestId) {
        clearTimeout(this.currentRequestHandler.timeoutHandle);
      }
      this.processingRequest = false;
      this.currentRequestHandler = null;
      this.errorCount += 1;
      this.emitBridgeMetric(
        "error",
        request.command,
        request.requestId,
        enqueuedAtMs,
        startedAtMs,
        this.now(),
      );

      // Process next request
      setTimeout(() => this.processNextRequest(), 0);

      if (request.operationId) {
        if (dispatchAttempted) {
          const receipt = this.operationReceipts.markUncertain(
            request.operationId,
            "degraded_uncertain",
          );
          reject(new OperationUncertainError(receipt));
        } else {
          this.operationReceipts.abandonBeforeDispatch(request.operationId);
          reject(
            new ProviderRuntimeError(
              "internal_error",
              false,
              `Failed to prepare KiCAD command: ${request.command}`,
            ),
          );
        }
        return;
      }

      reject(
        new ProviderRuntimeError(
          "internal_error",
          false,
          `Failed to dispatch KiCAD command: ${request.command}`,
        ),
      );
    }
  }
}
