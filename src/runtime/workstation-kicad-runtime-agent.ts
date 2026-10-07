/**
 * Fork of mixelpixx/KiCAD-MCP-Server (MIT, see ATTRIBUTION.md).
 * SlncTrZ provider adaptation by SlncTrZ / Truong Cong Dinh.
 *
 * WorkstationKiCADRuntimeAgent — workstation-side executor (migration K2).
 *
 * This agent HOLDS the Python discovery/spawn/PYTHONPATH/KICAD_BACKEND logic:
 * it resolves the worker executable via python-discovery, builds the spawn
 * environment (PYTHONPATH precedence + KICAD_BACKEND passthrough) and owns
 * the child-process lifecycle. The remote provider path must never import
 * discovery or spawn — it only talks to this agent over an authenticated
 * loopback transport (enforced by tests-ts/runtime-remote-adapter.test.ts).
 *
 * The agent reuses the SAME local execution core (a KiCADRuntimePort, by
 * default a LocalKiCADRuntimeAdapter bound to a caller-supplied dispatch)
 * behind the transport boundary: native code is not duplicated into two
 * diverging implementations. The agent holds NO receipt authority — only a
 * serial dispatch lock that prevents transport interleaving; quarantine and
 * uncertainty decisions stay provider-side.
 */

import { randomUUID } from "crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "http";
import {
  type KiCADRuntimePort,
  type RuntimeHealth,
} from "./kicad-runtime-port.js";
import {
  bearerMatches,
  checkTransportOp,
  checkTransportRequestSize,
  MAX_TRANSPORT_RESPONSE_BYTES,
  RuntimeOpRefusedError,
} from "./runtime-transport.js";
import {
  findPythonExecutable,
  resolveWorkerPythonPath,
} from "./python-discovery.js";

export interface WorkstationAgentOptions {
  /** Pre-shared bearer token for loopback dispatch/health (required to listen). */
  authToken?: string;
  /** Runtime generation; a fresh id is minted when omitted (restart = new generation). */
  generation?: string;
  /** Bind host for listen(); loopback only by default. */
  host?: string;
  /** Port for listen(); 0 picks an ephemeral loopback port. */
  port?: number;
}

export interface AgentDispatchWireRequest {
  request_id?: string;
  op: string;
  params?: Record<string, unknown>;
  deadline_ms?: number;
  expected_generation?: string | null;
}

export class WorkstationKiCADRuntimeAgent {
  readonly generation: string;

  private readonly port: KiCADRuntimePort;

  private readonly authToken: string;

  private readonly lock: { busy: boolean; queue: Array<() => void> } = { busy: false, queue: [] };

  private httpServer: Server | null = null;

  constructor(port: KiCADRuntimePort, options: WorkstationAgentOptions = {}) {
    if (!port || typeof port.execute !== "function") {
      throw new TypeError("WorkstationKiCADRuntimeAgent requires a KiCADRuntimePort");
    }
    this.port = port;
    this.generation = String(options.generation ?? "").trim() || randomUUID();
    this.authToken = String(options.authToken ?? "");
  }

  // -- canonical spawn environment (single implementation shared by local server path) --

  /**
   * Resolve the worker executable + environment for `scriptPath`.
   * Pure discovery: no spawn here, so the provider can log/validate first.
   */
  static resolveWorkerLaunch(scriptPath: string): { pythonExe: string; env: Record<string, string> } {
    const pythonExe = findPythonExecutable(scriptPath);
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) env[key] = value;
    }
    env["PYTHONPATH"] = resolveWorkerPythonPath(pythonExe);
    // KICAD_BACKEND ('auto' | 'ipc' | 'swig') stays an env passthrough: the
    // Python worker reads it directly; the agent never interprets it.
    return { pythonExe, env };
  }

  // -- typed dispatch (same execution contract local and remote) --

  private async withSerialLock<T>(work: () => Promise<T>): Promise<T> {
    if (this.lock.busy) {
      await new Promise<void>((resolve) => this.lock.queue.push(resolve));
    }
    this.lock.busy = true;
    try {
      return await work();
    } finally {
      this.lock.busy = false;
      const next = this.lock.queue.shift();
      if (next) next();
    }
  }

  /**
   * Execute one op through the reused local port.
   * Refuses empty ops and stale generations BEFORE dispatch (no CAD effect);
   * timeout after dispatch started stays completion-unknown upstream.
   */
  async dispatch(
    command: string,
    params: Record<string, unknown> = {},
    expectedGeneration?: string | null,
  ): Promise<unknown> {
    const op = checkTransportOp(command);
    checkTransportRequestSize({ op, params });
    if (expectedGeneration !== undefined && expectedGeneration !== null && expectedGeneration !== this.generation) {
      throw new RuntimeOpRefusedError(
        `stale runtime generation: expected ${JSON.stringify(expectedGeneration)}, ` +
          `agent generation is ${JSON.stringify(this.generation)}; refused before dispatch`,
      );
    }
    return this.withSerialLock(() => this.port.execute(op, params ?? {}));
  }

  async health(): Promise<RuntimeHealth & { agent_generation: string }> {
    const portHealth = await this.port.health();
    return { ...portHealth, transport: portHealth.transport, agent_generation: this.generation };
  }

  // -- loopback HTTP surface for the remote transport --

  private readBody(request: IncomingMessage, limit = 512 * 1024): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      request.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > limit) {
          reject(new RuntimeOpRefusedError(`agent request oversized (>${limit} bytes)`));
          request.destroy();
          return;
        }
        chunks.push(chunk);
      });
      request.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
      request.on("error", reject);
    });
  }

  private send(response: ServerResponse, status: number, payload: Record<string, unknown>): void {
    const raw = JSON.stringify(payload);
    if (raw.length > MAX_TRANSPORT_RESPONSE_BYTES) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          ok: false,
          error_code: "oversized",
          error_message: "agent response oversized; discarded without trust",
          generation: this.generation,
        }),
      );
      return;
    }
    response.writeHead(status, { "content-type": "application/json" });
    response.end(raw);
  }

  private authorized(request: IncomingMessage): boolean {
    if (!this.authToken) return false;
    const header = String(request.headers["authorization"] ?? "");
    const presented = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
    return bearerMatches(presented, this.authToken);
  }

  /** node:http handler: GET /health + POST /dispatch, bearer-gated, loopback-bound by listen(). */
  createHttpHandler(): (request: IncomingMessage, response: ServerResponse) => void {
    return (request: IncomingMessage, response: ServerResponse) => {
      void (async () => {
        if (!this.authorized(request)) {
          this.send(response, 401, {
            ok: false,
            error_code: "unauthorized",
            error_message: "missing or rejected runtime credential",
            generation: this.generation,
          });
          return;
        }
        const url = String(request.url ?? "").split("?")[0];
        if (request.method === "GET" && url === "/health") {
          const health = await this.health();
          this.send(response, 200, { ok: true, result: health, generation: this.generation });
          return;
        }
        if (request.method === "POST" && url === "/dispatch") {
          let wire: AgentDispatchWireRequest;
          try {
            const raw = await this.readBody(request);
            wire = JSON.parse(raw || "{}") as AgentDispatchWireRequest;
          } catch (error) {
            this.send(response, 400, {
              ok: false,
              error_code: "bad_request",
              error_message: error instanceof Error ? error.message : "malformed agent request",
              generation: this.generation,
            });
            return;
          }
          try {
            const op = checkTransportOp(wire.op);
            const result = await this.dispatch(
              op,
              (wire.params ?? {}) as Record<string, unknown>,
              wire.expected_generation ?? undefined,
            );
            this.send(response, 200, { ok: true, result, generation: this.generation });
          } catch (error) {
            if (error instanceof RuntimeOpRefusedError) {
              const stale = String(error.message).startsWith("stale runtime generation");
              this.send(response, stale ? 409 : 400, {
                ok: false,
                error_code: stale ? "generation_mismatch" : "op_refused",
                error_message: error.message,
                generation: this.generation,
              });
              return;
            }
            const message = error instanceof Error ? error.message : String(error);
            let payload: Record<string, unknown> | null = null;
            try {
              const parsed = JSON.parse(message) as Record<string, unknown>;
              if (parsed && typeof parsed === "object" && parsed["success"] === false) payload = parsed;
            } catch {
              payload = null;
            }
            if (payload) {
              // Typed worker failure (incl. unsupported_capability): pass the
              // canonical kind through without reinterpretation.
              this.send(response, 200, { ok: false, ...payload, generation: this.generation });
              return;
            }
            this.send(response, 500, {
              ok: false,
              error_code: "uncertain",
              error_message: `${message}; completion is unknown, blind retry is forbidden`,
              completion_unknown: true,
              generation: this.generation,
            });
          }
          return;
        }
        this.send(response, 404, {
          ok: false,
          error_code: "unknown_op",
          error_message: `no route for ${request.method} ${url}`,
          generation: this.generation,
        });
      })().catch(() => {
        try {
          this.send(response, 500, {
            ok: false,
            error_code: "uncertain",
            error_message: "agent dispatch failed; completion is unknown, blind retry is forbidden",
            completion_unknown: true,
            generation: this.generation,
          });
        } catch {
          // Response already committed; nothing left to report.
        }
      });
    };
  }

  /** Bind loopback-only by default; resolves the bound address for the remote transport. */
  async listen(host = "127.0.0.1", port = 0): Promise<{ host: string; port: number; baseUrl: string }> {
    if (!this.authToken) throw new Error("WorkstationKiCADRuntimeAgent requires an authToken to listen");
    if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
      throw new Error(`refusing non-loopback agent bind ${JSON.stringify(host)}`);
    }
    this.httpServer = createServer(this.createHttpHandler());
    await new Promise<void>((resolve, reject) => {
      this.httpServer!.once("error", reject);
      this.httpServer!.listen(port, host, () => resolve());
    });
    const address = this.httpServer.address();
    const boundPort = typeof address === "object" && address ? address.port : port;
    const boundHost = typeof address === "object" && address ? address.address : host;
    return { host: boundHost, port: boundPort, baseUrl: `http://${boundHost}:${boundPort}` };
  }

  async close(): Promise<void> {
    if (this.httpServer) {
      await new Promise<void>((resolve) => this.httpServer!.close(() => resolve()));
      this.httpServer = null;
    }
  }
}
