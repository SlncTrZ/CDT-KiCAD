import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { RemoteKiCADRuntimeAdapter } from "../src/runtime/remote-kicad-runtime-adapter.js";
import { RuntimeUncertainError, type RuntimeTransport } from "../src/runtime/runtime-transport.js";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { KiCADMcpServer } from "../src/server.js";

const pythonBridge = fileURLToPath(new URL("../python/kicad_interface.py", import.meta.url));
type TestServer = {
  pythonProcess: EventEmitter | { stdin: { write: ReturnType<typeof vi.fn> } } | null;
  waitForReady(timeoutMs: number): Promise<void>;
  resolveReady(): void;
  validatePrerequisites(pythonExe: string): Promise<boolean>;
  readyDetected: boolean;
  requestQueue: Array<{
    request: { command: string; params: object; timeout: number };
    resolve: ReturnType<typeof vi.fn>;
    reject: ReturnType<typeof vi.fn>;
  }>;
  processingRequest: boolean;
  processNextRequest(): void;
};

afterEach(() => {
  vi.useRealTimers();
});

describe("K5 independent provider with remote workstation", () => {
  it("serves without local Python and forwards reads to the runtime", async () => {
    const calls: string[] = [];
    const transport = {
      kind: "remote" as const,
      async call(command: string) {
        calls.push(command);
        return { success: true, backend: "swig" };
      },
      async health() {
        return { agent_generation: "gen-1" };
      },
      async close() {},
    } satisfies RuntimeTransport;
    const server = new KiCADMcpServer(
      pythonBridge,
      "error",
      {},
      new RemoteKiCADRuntimeAdapter(transport),
    ) as unknown as TestServer & {
      startBridge(): Promise<void>;
      callKicadScript(command: string, params: object): Promise<unknown>;
    };
    await server.startBridge();
    await expect(server.callKicadScript("get_backend_state", {})).resolves.toMatchObject({
      backend: "swig",
    });
    expect(calls).toEqual(["get_backend_state"]);
    expect(server.pythonProcess).toBeNull();
  });

  it("quarantines completion-unknown mutations instead of retrying", async () => {
    const calls: string[] = [];
    const transport = {
      kind: "remote" as const,
      async call(command: string) {
        calls.push(command);
        throw new RuntimeUncertainError("disconnected after dispatch");
      },
      async health() {
        return { agent_generation: "gen-1" };
      },
      async close() {},
    } satisfies RuntimeTransport;
    const server = new KiCADMcpServer(
      pythonBridge,
      "error",
      {},
      new RemoteKiCADRuntimeAdapter(transport),
    ) as unknown as {
      callKicadScript(command: string, params: object): Promise<unknown>;
    };
    await expect(
      server.callKicadScript("move_component", { operationId: "k5-op", x: 1 }),
    ).rejects.toMatchObject({ code: "operation_uncertain" });
    await expect(
      server.callKicadScript("move_component", { operationId: "k5-op", x: 1 }),
    ).rejects.toMatchObject({ code: "operation_uncertain" });
    expect(calls).toEqual(["move_component"]);
  });
});

describe("startup ready gate (#377)", () => {
  it("fails immediately with provider_unavailable when the child exits before READY", async () => {
    vi.useFakeTimers();
    const server = new KiCADMcpServer(pythonBridge, "error") as unknown as TestServer;
    const child = new EventEmitter();
    server.pythonProcess = child;

    const ready = expect(server.waitForReady(120_000)).rejects.toMatchObject({
      kind: "provider_unavailable",
      retryable: true,
    });
    child.emit("exit", 1, null);
    await ready;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("waits for a live child and clears the timer when READY arrives", async () => {
    vi.useFakeTimers();
    const server = new KiCADMcpServer(pythonBridge, "error") as unknown as TestServer;
    server.pythonProcess = new EventEmitter();
    const ready = server.waitForReady(120_000);
    await vi.advanceTimersByTimeAsync(100);
    expect(vi.getTimerCount()).toBe(1);
    server.resolveReady();
    await ready;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("skipping pcbnew validation still rejects missing build artifacts", async () => {
    const root = mkdtempSync(join(tmpdir(), "kicad-preflight-"));
    const script = join(root, "python", "bridge.py");
    mkdirSync(join(root, "python"));
    writeFileSync(script, "# test bridge");
    expect(existsSync(join(root, "dist", "index.js"))).toBe(false);
    const previous = process.env.KICAD_SKIP_PCBNEW_VALIDATION;
    process.env.KICAD_SKIP_PCBNEW_VALIDATION = "1";
    try {
      const server = new KiCADMcpServer(script, "error") as unknown as TestServer;
      expect(await server.validatePrerequisites(process.execPath)).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.KICAD_SKIP_PCBNEW_VALIDATION;
      else process.env.KICAD_SKIP_PCBNEW_VALIDATION = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("holds queued tool calls until the backend reports READY", () => {
    vi.useFakeTimers();
    const server = new KiCADMcpServer(pythonBridge, "error") as unknown as TestServer;
    const stdin = { write: vi.fn() };
    server.pythonProcess = { stdin };
    server.readyDetected = false;

    server.requestQueue.push({
      request: { command: "get_board_info", params: {}, timeout: 30_000 },
      resolve: vi.fn(),
      reject: vi.fn(),
    });

    server.processNextRequest();

    // Held: nothing written, no timeout started against Python's own startup.
    expect(stdin.write).not.toHaveBeenCalled();
    expect(server.processingRequest).toBe(false);
    expect(server.requestQueue.length).toBe(1);

    // READY fires: the queue drains and the request dispatches.
    server.readyDetected = true;
    server.processNextRequest();
    expect(stdin.write).toHaveBeenCalledOnce();
    expect(server.requestQueue.length).toBe(0);
  });
});
