import { afterEach, describe, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";
import {
  KiCADMcpServer,
  ProviderRuntimeError,
  type BridgeRuntimeMetric,
} from "../src/server.js";

const pythonBridge = fileURLToPath(new URL("../python/kicad_interface.py", import.meta.url));

afterEach(() => {
  vi.useRealTimers();
});

describe("bounded Node→Python bridge queue", () => {
  it("keeps canonical error fields in the SDK-visible error message", () => {
    const error = new ProviderRuntimeError("rate_limited", true, "queue full", {
      queue_depth: 32,
    });

    expect(JSON.parse(error.message)).toMatchObject({
      kind: "rate_limited",
      retryable: true,
      message: "queue full",
      details: { queue_depth: 32 },
    });
    expect(error.toJSON()).toMatchObject({
      kind: "rate_limited",
      retryable: true,
      message: "queue full",
    });
  });

  it("rejects overload with a typed rate_limited error and expires queued work", async () => {
    vi.useFakeTimers();
    const metrics: BridgeRuntimeMetric[] = [];
    const server = new KiCADMcpServer(pythonBridge, "error", {
      maxQueueDepth: 1,
      enqueueDeadlineMs: 100,
      metricsSink: (metric) => metrics.push(metric),
    }) as any;

    server.pythonProcess = { stdin: { write: vi.fn() } };
    server.readyDetected = false;

    const first = server.callKicadScript("first", {});
    const second = server.callKicadScript("second", {});

    await expect(second).rejects.toMatchObject({
      kind: "rate_limited",
      retryable: true,
    });
    expect(server.getBridgeRuntimeMetrics()).toMatchObject({
      queue_depth: 1,
      rejection_count: 1,
      timeout_count: 0,
    });

    const firstRejection = expect(first).rejects.toMatchObject({
      kind: "timeout",
      retryable: true,
    });
    await vi.advanceTimersByTimeAsync(100);
    await firstRejection;

    expect(server.getBridgeRuntimeMetrics()).toMatchObject({
      queue_depth: 0,
      rejection_count: 1,
      timeout_count: 1,
    });
    expect(metrics.at(-1)).toMatchObject({
      event: "timeout",
      command: "first",
      queue_depth: 0,
      queue_wait_ms: 100,
      execution_ms: 0,
      total_latency_ms: 100,
      timeout_count: 1,
      rejection_count: 1,
    });
  });

  it("does not strand an operation receipt when enqueue deadline expires before dispatch", async () => {
    vi.useFakeTimers();
    const server = new KiCADMcpServer(pythonBridge, "error", {
      maxQueueDepth: 2,
      enqueueDeadlineMs: 100,
      metricsSink: () => undefined,
    }) as any;

    server.pythonProcess = { stdin: { write: vi.fn() } };
    server.readyDetected = false;

    const args = {
      operationId: "op-queue-expire",
      reference: "R1",
      position: { x: 1, y: 2, unit: "mm" },
    };
    const first = server.callKicadScript("move_component", args);
    const firstRejection = expect(first).rejects.toMatchObject({
      kind: "timeout",
      retryable: true,
    });

    await vi.advanceTimersByTimeAsync(100);
    await firstRejection;
    expect(server.operationReceipts.get("op-queue-expire")).toBeUndefined();

    const retry = server.callKicadScript("move_component", args);
    expect(server.operationReceipts.get("op-queue-expire")).toBeDefined();
    const retryRejection = expect(retry).rejects.toMatchObject({
      kind: "timeout",
      retryable: true,
    });

    await vi.advanceTimersByTimeAsync(100);
    await retryRejection;
    expect(server.operationReceipts.get("op-queue-expire")).toBeUndefined();
  });

  it("preserves one-at-a-time dispatch and records queue/execution latency", async () => {
    vi.useFakeTimers();
    const metrics: BridgeRuntimeMetric[] = [];
    const server = new KiCADMcpServer(pythonBridge, "error", {
      maxQueueDepth: 4,
      enqueueDeadlineMs: 1_000,
      metricsSink: (metric) => metrics.push(metric),
    }) as any;

    const writes: string[] = [];
    const stdin = {
      write: vi.fn((line: string) => {
        writes.push(line);
        const request = JSON.parse(line);
        setTimeout(() => {
          server.handlePythonResponse(
            Buffer.from(
              JSON.stringify({
                success: true,
                command: request.command,
                _requestId: request.requestId,
              }) + "\n",
            ),
          );
        }, 10);
      }),
    };
    server.pythonProcess = { stdin };
    server.readyDetected = true;

    const first = server.callKicadScript("first", {});
    const second = server.callKicadScript("second", {});

    expect(stdin.write).toHaveBeenCalledTimes(1);
    expect(server.getBridgeRuntimeMetrics().queue_depth).toBe(1);

    await vi.advanceTimersByTimeAsync(11);
    expect(stdin.write).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(11);

    await expect(first).resolves.toMatchObject({ success: true, command: "first" });
    await expect(second).resolves.toMatchObject({ success: true, command: "second" });

    const completed = metrics.filter((metric) => metric.event === "completed");
    expect(completed).toHaveLength(2);
    expect(completed[0]).toMatchObject({
      command: "first",
      queue_wait_ms: 0,
      execution_ms: 10,
      total_latency_ms: 10,
    });
    expect(completed[1].queue_wait_ms).toBeGreaterThanOrEqual(10);
    expect(completed[1].execution_ms).toBe(10);
    expect(completed[1].total_latency_ms).toBeGreaterThanOrEqual(20);
  });

  it("counts execution timeouts and returns the canonical timeout kind", async () => {
    vi.useFakeTimers();
    const metrics: BridgeRuntimeMetric[] = [];
    const server = new KiCADMcpServer(pythonBridge, "error", {
      enqueueDeadlineMs: 60_000,
      metricsSink: (metric) => metrics.push(metric),
    }) as any;

    server.pythonProcess = { stdin: { write: vi.fn() } };
    server.readyDetected = true;

    const call = server.callKicadScript("get_board_info", {});
    const rejection = expect(call).rejects.toMatchObject({
      kind: "timeout",
      retryable: true,
    });

    await vi.advanceTimersByTimeAsync(30_000);
    await rejection;

    expect(server.getBridgeRuntimeMetrics()).toMatchObject({
      queue_depth: 0,
      timeout_count: 1,
      rejection_count: 0,
    });
    expect(metrics.at(-1)).toMatchObject({
      event: "timeout",
      command: "get_board_info",
      timeout_count: 1,
    });
  });
});
