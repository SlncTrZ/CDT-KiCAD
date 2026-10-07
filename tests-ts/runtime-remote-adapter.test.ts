/**
 * Fork of mixelpixx/KiCAD-MCP-Server (MIT, see ATTRIBUTION.md).
 * SlncTrZ provider adaptation by SlncTrZ / Truong Cong Dinh.
 *
 * K2 constraint: the REMOTE provider path must never search the local
 * machine for KiCad (no Program Files / %LOCALAPPDATA% / pcbnew discovery,
 * no worker spawn). Discovery + spawn stay workstation-side. Enforced both
 * statically (module sources) and behaviorally (adapter has no spawn path).
 */
import { readFileSync } from "fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "path";
import { describe, expect, it } from "vitest";
import { LocalKiCADRuntimeAdapter } from "../src/runtime/local-kicad-runtime-adapter.js";
import { RemoteKiCADRuntimeAdapter } from "../src/runtime/remote-kicad-runtime-adapter.js";
import {
  LocalRuntimeTransport,
  RemoteRuntimeTransport,
  RuntimeGenerationMismatchError,
  type RuntimeTransport,
} from "../src/runtime/runtime-transport.js";

const here = dirname(fileURLToPath(import.meta.url));
const runtimeDir = join(here, "..", "src", "runtime");

function readRuntimeModule(name: string): string {
  return readFileSync(join(runtimeDir, name), "utf-8");
}

describe("K2 remote provider never discovers local KiCad", () => {
  const forbidden = ["Program Files", "LOCALAPPDATA", "pcbnew", "python-discovery", "spawn", "PYTHONPATH"];

  it("remote adapter + remote transport sources stay free of local discovery", () => {
    for (const module of ["remote-kicad-runtime-adapter.ts", "runtime-transport.ts"]) {
      const source = readRuntimeModule(module);
      for (const marker of forbidden) {
        expect(source, `${module} must not reference ${JSON.stringify(marker)}`).not.toContain(marker);
      }
    }
  });

  it("workstation side still owns discovery (no silent relocation loss)", () => {
    const agentSource = readRuntimeModule("workstation-kicad-runtime-agent.ts");
    expect(agentSource).toContain("python-discovery");
    const discoverySource = readRuntimeModule("python-discovery.ts");
    expect(discoverySource).toContain("Program Files");
  });

  it("remote adapter requires a remote transport (local transport refused)", () => {
    const local = new LocalRuntimeTransport(
      new LocalKiCADRuntimeAdapter(async () => ({})),
    );
    expect(
      () => new RemoteKiCADRuntimeAdapter(local as unknown as RuntimeTransport),
    ).toThrow(/remote RuntimeTransport/);
  });
});

describe("K2 remote adapter typed forwarding", () => {
  function recordingTransport(calls: Array<{ op: string; params: unknown; options: unknown }>) {
    return {
      kind: "remote",
      async call(op: string, params: unknown, options: unknown) {
        calls.push({ op, params, options });
        return { forwarded: op };
      },
      async health() {
        return { agent_generation: "agent-gen-9" };
      },
      async close() {
        calls.push({ op: "__close__", params: {}, options: {} });
      },
    } as unknown as RemoteRuntimeTransport;
  }

  it("forwards command + params verbatim and pins generations", async () => {
    const calls: Array<{ op: string; params: unknown; options: unknown }> = [];
    const adapter = new RemoteKiCADRuntimeAdapter(recordingTransport(calls), {
      expectedGeneration: "agent-gen-9",
    });
    expect(adapter.transportKind).toBe("remote");
    await expect(adapter.execute("get_backend_state", { a: 1 })).resolves.toEqual({
      forwarded: "get_backend_state",
    });
    expect(calls[0]).toMatchObject({
      op: "get_backend_state",
      params: { a: 1 },
      options: { expectedGeneration: "agent-gen-9" },
    });
    await expect(adapter.execute("  ")).rejects.toThrow(/empty command/);
    expect(() => adapter.pinGeneration("  ")).toThrow(/non-empty/);
    adapter.pinGeneration("agent-gen-9");
    await adapter.close();
    expect(calls.at(-1)).toMatchObject({ op: "__close__" });
  });

  it("refuses stale agent health before trusting results", async () => {
    const calls: Array<{ op: string; params: unknown; options: unknown }> = [];
    const adapter = new RemoteKiCADRuntimeAdapter(recordingTransport(calls), {
      expectedGeneration: "pinned-gen",
    });
    await expect(adapter.health()).rejects.toBeInstanceOf(RuntimeGenerationMismatchError);
    const unpinned = new RemoteKiCADRuntimeAdapter(recordingTransport(calls));
    await expect(unpinned.health()).resolves.toMatchObject({
      transport: "remote",
      reachable: true,
      generation: "agent-gen-9",
    });
  });
});
