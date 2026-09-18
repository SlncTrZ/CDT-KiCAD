// Fork of mixelpixx/KiCAD-MCP-Server (MIT, see ATTRIBUTION.md).
// SlncTrZ provider adaptation test coverage.
import { afterEach, describe, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { KiCADMcpServer } from "../src/server.js";
import {
  OperationBlockedError,
  OperationReceiptStore,
  OperationUncertainError,
} from "../src/operation-receipts.js";

const pythonBridge = fileURLToPath(new URL("../python/kicad_interface.py", import.meta.url));

afterEach(() => {
  vi.useRealTimers();
});

describe("operation receipts", () => {
  it("keeps bridge request correlation separate from semantic operation identity", () => {
    const receipts = new OperationReceiptStore();
    const begun = receipts.begin("op-semantic-1", "move_component", {
      reference: "R1",
      position: { x: 10, y: 20, unit: "mm" },
    });

    expect(begun.kind).toBe("new");
    expect(receipts.get("op-semantic-1")?.operation_id).toBe("op-semantic-1");
    expect(receipts.get("op-semantic-1")?.state).toBeUndefined();
  });

  it("rejects reuse of an operation_id with different semantics", () => {
    const receipts = new OperationReceiptStore();
    receipts.begin("op-1", "move_component", {
      reference: "R1",
      position: { x: 1, y: 2, unit: "mm" },
    });

    expect(() =>
      receipts.begin("op-1", "move_component", {
        reference: "R1",
        position: { x: 3, y: 4, unit: "mm" },
      }),
    ).toThrow(/different command or parameters/i);
  });
});

describe("timeout recovery bridge", () => {
  it("does not duplicate or release a dependent mutation after caller timeout", async () => {
    vi.useFakeTimers();
    const server = new KiCADMcpServer(pythonBridge, "error") as any;
    const writes: any[] = [];

    server.readyDetected = true;
    server.pythonProcess = {
      stdin: {
        write: (line: string) => {
          writes.push(JSON.parse(line));
          return true;
        },
      },
    };

    const first = server.callKicadScript("move_component", {
      operationId: "op-move-r1",
      reference: "R1",
      position: { x: 10, y: 20, unit: "mm" },
    });
    const firstRejected = expect(first).rejects.toBeInstanceOf(OperationUncertainError);

    await vi.advanceTimersByTimeAsync(30_000);
    await firstRejected;
    expect(writes).toHaveLength(1);
    expect(server.operationReceipts.get("op-move-r1")).toMatchObject({
      state: "uncertain",
      backend_owner: "degraded_uncertain",
    });
    expect(writes[0].requestId).toBeTypeOf("number");
    expect(writes[0].operationId).toBe("op-move-r1");
    expect(writes[0].params.operationId).toBeUndefined();

    await expect(
      server.callKicadScript("move_component", {
        operationId: "op-move-r1",
        reference: "R1",
        position: { x: 10, y: 20, unit: "mm" },
      }),
    ).rejects.toBeInstanceOf(OperationUncertainError);

    await expect(
      server.callKicadScript("save_project", { operationId: "op-save-after-uncertain" }),
    ).rejects.toBeInstanceOf(OperationBlockedError);
    expect(writes).toHaveLength(1);
  });

  it("reconciles a late successful response before a retry can return committed", async () => {
    vi.useFakeTimers();
    const server = new KiCADMcpServer(pythonBridge, "error") as any;
    const writes: any[] = [];

    server.readyDetected = true;
    server.pythonProcess = {
      stdin: {
        write: (line: string) => {
          writes.push(JSON.parse(line));
          return true;
        },
      },
    };

    const first = server.callKicadScript("move_component", {
      operationId: "op-late",
      reference: "R1",
      position: { x: 5, y: 6, unit: "mm" },
    });
    const firstRejected = expect(first).rejects.toBeInstanceOf(OperationUncertainError);
    await vi.advanceTimersByTimeAsync(30_000);
    await firstRejected;

    const firstRequestId = writes[0].requestId;
    server.handlePythonResponse(
      Buffer.from(
        JSON.stringify({
          success: true,
          component: { reference: "R1" },
          _backend: "ipc",
          _requestId: firstRequestId,
        }) + "\n",
      ),
    );
    await vi.runOnlyPendingTimersAsync();

    expect(writes).toHaveLength(2);
    expect(writes[1].command).toBe("_reconcile_operation");
    expect(writes[1].params.operation_id).toBe("op-late");
    expect(writes[1].params.command).toBe("move_component");

    server.handlePythonResponse(
      Buffer.from(
        JSON.stringify({
          success: true,
          state: "committed",
          evidence: { reference: "R1", position_match: true },
          _backend: "ipc",
          _requestId: writes[1].requestId,
        }) + "\n",
      ),
    );
    await vi.runOnlyPendingTimersAsync();

    const retried = await server.callKicadScript("move_component", {
      operationId: "op-late",
      reference: "R1",
      position: { x: 5, y: 6, unit: "mm" },
    });

    expect(writes).toHaveLength(2);
    expect(retried.operation_receipt).toMatchObject({
      operation_id: "op-late",
      state: "committed",
      backend_owner: "ipc",
    });
  });
});
