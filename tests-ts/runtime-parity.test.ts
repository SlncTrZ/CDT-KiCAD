/**
 * Fork of mixelpixx/KiCAD-MCP-Server (MIT, see ATTRIBUTION.md).
 * SlncTrZ provider adaptation by SlncTrZ / Truong Cong Dinh.
 *
 * K3/K4 parity through the runtime boundary, by backend lane:
 * project/board/schematic/library/status reads; receipts; session pinning;
 * IPC timeout; SWIG unsupported-capability refusal (typed, never fake
 * success); save/reopen and recovery. Local and remote paths must be
 * semantically equivalent within pass-through normalization.
 */
import { describe, expect, it } from "vitest";
import { CAPABILITIES } from "../src/provider-contract.js";
import { OperationReceiptStore } from "../src/operation-receipts.js";
import { LocalKiCADRuntimeAdapter } from "../src/runtime/local-kicad-runtime-adapter.js";
import { RemoteKiCADRuntimeAdapter } from "../src/runtime/remote-kicad-runtime-adapter.js";
import {
  LocalRuntimeTransport,
  RemoteRuntimeTransport,
  RuntimeGenerationMismatchError,
  RuntimeUncertainError,
} from "../src/runtime/runtime-transport.js";
import { WorkstationKiCADRuntimeAgent } from "../src/runtime/workstation-kicad-runtime-agent.js";
import { canonicalizeKicadFailure } from "../src/tools/tool-response.js";

/** Read-lane fixtures keyed by command (backend lane: swig + ipc both answer reads). */
const READ_FIXTURES: Record<string, unknown> = {
  get_project_info: { success: true, project: "parity-probe", backend: "swig" },
  get_board_info: { success: true, layers: 4, backend: "swig" },
  list_schematic_components: { success: true, components: [], backend: "ipc" },
  get_symbol_info: { success: true, symbol: "Device:R", backend: "ipc" },
  get_backend_state: { success: true, backend: "ipc", sessionState: "ipc" },
};

function fixturePort() {
  return new LocalKiCADRuntimeAdapter(async (command) => {
    const fixture = READ_FIXTURES[command];
    if (fixture === undefined) throw new Error(`Unknown command: ${command}`);
    return structuredClone(fixture);
  });
}

async function withAgent(
  work: (agent: WorkstationKiCADRuntimeAgent, baseUrl: string) => Promise<void>,
  generation = "parity-gen-1",
): Promise<void> {
  const agent = new WorkstationKiCADRuntimeAgent(fixturePort(), {
    authToken: "parity-secret",
    generation,
  });
  const { baseUrl } = await agent.listen("127.0.0.1", 0);
  try {
    await work(agent, baseUrl);
  } finally {
    await agent.close();
  }
}

describe("K3 read-lane parity local vs remote", () => {
  it("returns semantically equivalent reads on both paths", async () => {
    const localTransport = new LocalRuntimeTransport(fixturePort());
    const localResults: Record<string, unknown> = {};
    for (const command of Object.keys(READ_FIXTURES)) {
      localResults[command] = await localTransport.call(command, {});
    }

    await withAgent(async (_agent, baseUrl) => {
      const remoteTransport = new RemoteRuntimeTransport(baseUrl, "parity-secret");
      const remotePort = new RemoteKiCADRuntimeAdapter(remoteTransport, {
        expectedGeneration: "parity-gen-1",
      });
      for (const command of Object.keys(READ_FIXTURES)) {
        const remote = await remotePort.execute(command, {});
        expect(remote, `remote read diverged for ${command}`).toEqual(localResults[command]);
      }
      await remotePort.close();
    });
  });

  it("provider stays reachable when the remote runtime is unavailable", async () => {
    const dead = new RemoteRuntimeTransport("http://127.0.0.1:9", "parity-secret", {
      defaultDeadlineMs: 500,
    });
    // Port 9 (discard) refuses: a clean unavailable error, never fake success.
    await expect(dead.call("get_backend_state")).rejects.toMatchObject({ name: "RuntimeUncertainError" });
    const health = await new LocalRuntimeTransport(fixturePort()).health();
    expect(health).toMatchObject({ reachable: true });
    await dead.close();
  });
});

describe("K4 mutation/recovery parity", () => {
  it("keeps receipt fencing provider-side: uncertain blocks later mutation", () => {
    const receipts = new OperationReceiptStore();
    const begun = receipts.begin("op-1", "move_component", { x: 1 });
    expect(begun.kind).toBe("new");
    receipts.markUncertain("op-1", "degraded_uncertain");
    const blocker = receipts.firstUncertain();
    expect(blocker?.operation_id).toBe("op-1");
    // Same-ID retry replays the uncertain receipt (never blind re-dispatch).
    const replay = receipts.begin("op-1", "move_component", { x: 1 });
    expect(replay.kind).toBe("uncertain");
  });

  it("refuses stale generations on the remote path before trusting results", async () => {
    await withAgent(
      async (_agent, baseUrl) => {
        const stale = new RemoteKiCADRuntimeAdapter(new RemoteRuntimeTransport(baseUrl, "parity-secret"), {
          expectedGeneration: "stale-gen",
        });
        await expect(stale.execute("get_backend_state")).rejects.toBeInstanceOf(
          RuntimeGenerationMismatchError,
        );
      },
      "fresh-gen-2",
    );
  });

  it("preserves typed SWIG unsupported_capability end-to-end (never fake success)", async () => {
    const refusal = {
      success: false,
      kind: "unsupported_capability",
      retryable: false,
      message: "ipc-only capability refused on swig backend",
    };
    const swigOnlyPort = new LocalKiCADRuntimeAdapter(async () => structuredClone(refusal));
    const agent = new WorkstationKiCADRuntimeAgent(swigOnlyPort, {
      authToken: "parity-secret",
      generation: "swig-gen",
    });
    const { baseUrl } = await agent.listen("127.0.0.1", 0);
    try {
      const remote = new RemoteKiCADRuntimeAdapter(new RemoteRuntimeTransport(baseUrl, "parity-secret"));
      // Worker failures travel as VALUES (success:false payloads); the tool
      // layer types them via ensureKicadSuccess — same as the local path.
      const result = await remote.execute("ipc_only_command");
      expect(result).toEqual(refusal);
      // Local path comparison: identical payload through the local transport.
      const local = await new LocalRuntimeTransport(swigOnlyPort).call("ipc_only_command");
      expect(local).toEqual(refusal);
      // The tool boundary keeps the typed kind (no collapse to internal_error).
      const canonical = canonicalizeKicadFailure(refusal as { success: false });
      expect(canonical.kind).toBe("unsupported_capability");
      expect(canonical.retryable).toBe(false);
    } finally {
      await agent.close();
    }
  });

  it("declares transactions/undo/redo unsupported in the capability contract", () => {
    for (const capability of [
      "common.transaction.begin",
      "common.transaction.commit",
      "common.transaction.rollback",
      "common.undo",
      "common.redo",
    ]) {
      expect(CAPABILITIES[capability]?.supported).toBe(false);
      expect(CAPABILITIES[capability]?.mode).toBe("unsupported");
    }
    // Recovery stays snapshot-mode only: checkpointed_atomic requires verification.
    expect(CAPABILITIES["kicad.recovery.checkpoint"]).toMatchObject({
      supported: true,
      mode: "snapshot",
    });
  });

  it("forwards save/reopen and recovery ops verbatim over the remote path", async () => {
    const seen: string[] = [];
    const recording = new LocalKiCADRuntimeAdapter(async (command) => {
      seen.push(command);
      return { success: true, command };
    });
    const agent = new WorkstationKiCADRuntimeAgent(recording, {
      authToken: "parity-secret",
      generation: "save-gen",
    });
    const { baseUrl } = await agent.listen("127.0.0.1", 0);
    try {
      const remote = new RemoteKiCADRuntimeAdapter(new RemoteRuntimeTransport(baseUrl, "parity-secret"));
      for (const command of ["save_project", "save_board", "open_project", "snapshot_project", "restore_checkpoint"]) {
        const result = (await remote.execute(command, { project: "p" })) as Record<string, unknown>;
        expect(result).toMatchObject({ success: true, command });
      }
      expect(seen).toEqual(["save_project", "save_board", "open_project", "snapshot_project", "restore_checkpoint"]);
    } finally {
      await agent.close();
    }
  });

  it("maps remote timeout-after-dispatch to uncertain with an SDK-safe payload", async () => {
    const hanging = new LocalKiCADRuntimeAdapter(
      () => new Promise<unknown>(() => undefined), // never resolves: IPC hang
    );
    const agent = new WorkstationKiCADRuntimeAgent(hanging, {
      authToken: "parity-secret",
      generation: "hang-gen",
    });
    const { baseUrl } = await agent.listen("127.0.0.1", 0);
    try {
      const remote = new RemoteKiCADRuntimeAdapter(
        new RemoteRuntimeTransport(baseUrl, "parity-secret", { defaultDeadlineMs: 200 }),
      );
      const failure = await remote.execute("move_component", {}).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(RuntimeUncertainError);
      expect(JSON.parse((failure as Error).message)).toMatchObject({
        success: false,
        kind: "timeout",
        retryable: false,
      });
    } finally {
      await agent.close();
    }
  });
});
