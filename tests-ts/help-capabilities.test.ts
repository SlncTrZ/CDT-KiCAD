import { describe, expect, it } from "vitest";
import { buildRuntimeCapabilityMap } from "../src/tools/help.js";

type Capability = {
  implemented: boolean;
  available_now: boolean;
  reason?: string;
  backend: string;
  context: {
    session_state: string;
    session_backend: string | null;
    source: string;
  };
};

function cap(map: Record<string, unknown>, name: string): Capability {
  return map[name] as Capability;
}

describe("runtime capability truth", () => {
  it("separates implemented from unavailable during degraded IPC ownership", () => {
    const map = buildRuntimeCapabilityMap({
      backend: "degraded_uncertain",
      sessionBackend: "ipc",
      sessionState: "degraded_uncertain",
      loadedBoard: true,
      realtime_sync: false,
      sessionReason: "ipc_connection_lost",
    });

    expect(cap(map, "common.document.save")).toMatchObject({
      implemented: true,
      available_now: false,
      reason: "ipc_session_degraded_uncertain",
      backend: "degraded_uncertain",
    });
    expect(cap(map, "common.document.info")).toMatchObject({
      implemented: true,
      available_now: true,
      reason: "saved_disk_read_only_while_live_state_uncertain",
    });
    expect(cap(map, "common.document.info").context).toMatchObject({
      session_state: "degraded_uncertain",
      session_backend: "ipc",
      source: "disk",
    });
  });

  it("reports board-scoped capability unavailable when no board is loaded", () => {
    const map = buildRuntimeCapabilityMap({
      backend: "swig",
      sessionBackend: null,
      sessionState: "none",
      loadedBoard: false,
      realtime_sync: false,
    });

    expect(cap(map, "kicad.board.edit")).toMatchObject({
      implemented: true,
      available_now: false,
      reason: "no_board_loaded",
    });
    expect(cap(map, "common.document.open")).toMatchObject({
      implemented: true,
      available_now: true,
    });
  });

  it("keeps permanent unsupported truth distinct from runtime availability", () => {
    const map = buildRuntimeCapabilityMap({
      backend: "ipc",
      sessionBackend: "ipc",
      sessionState: "ipc",
      loadedBoard: true,
      realtime_sync: true,
    });

    expect(cap(map, "common.document.save")).toMatchObject({
      implemented: true,
      available_now: true,
      backend: "ipc",
    });
    expect(cap(map, "common.undo")).toMatchObject({
      implemented: false,
      available_now: false,
      reason: "no_unified_undo_use_snapshot_project",
    });
  });
});
