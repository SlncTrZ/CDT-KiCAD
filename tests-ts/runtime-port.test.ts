/**
 * Fork of mixelpixx/KiCAD-MCP-Server (MIT, see ATTRIBUTION.md).
 * SlncTrZ provider adaptation by SlncTrZ / Truong Cong Dinh.
 *
 * K1 parity: KiCADRuntimePort + LocalKiCADRuntimeAdapter around the existing
 * Node -> Python dispatch. Local child-process dispatch stays the default;
 * no public tool-schema drift.
 */
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { KiCADMcpServer } from "../src/server.js";
import { LocalKiCADRuntimeAdapter } from "../src/runtime/local-kicad-runtime-adapter.js";
import {
  LEGACY_KICAD_SITE_PACKAGES,
  resolveWorkerPythonPath,
} from "../src/runtime/python-discovery.js";

const pythonBridge = fileURLToPath(new URL("../python/kicad_interface.py", import.meta.url));

describe("K1 KiCADRuntimePort seam", () => {
  it("delegates execute 1:1 to the injected dispatch without reinterpretation", async () => {
    const seen: Array<{ command: string; params: Record<string, unknown> }> = [];
    const sentinel = { success: true, backend: "swig", value: 42 };
    const adapter = new LocalKiCADRuntimeAdapter(async (command, params) => {
      seen.push({ command, params });
      return sentinel;
    });

    expect(adapter.transportKind).toBe("local");
    expect(adapter.generation).toBe("local");

    const result = await adapter.execute("get_backend_state", { verbose: true });
    expect(result).toBe(sentinel);
    expect(seen).toEqual([{ command: "get_backend_state", params: { verbose: true } }]);
  });

  it("refuses empty commands and post-close dispatch before any worker effect", async () => {
    const adapter = new LocalKiCADRuntimeAdapter(async () => ({ ok: true }));
    await expect(adapter.execute("  ")).rejects.toThrow(/empty command/);
    await adapter.close();
    await expect(adapter.execute("get_backend_state")).rejects.toThrow(/closed/);
    await expect(adapter.close()).resolves.toBeUndefined();
    const health = await adapter.health();
    expect(health).toMatchObject({ transport: "local", reachable: false, generation: "local" });
  });

  it("requires a dispatch function and a non-empty generation", () => {
    expect(() => new LocalKiCADRuntimeAdapter(undefined as never)).toThrow(TypeError);
    expect(() => new LocalKiCADRuntimeAdapter(async () => ({}), {}, "  ")).toThrow(/generation/);
  });

  it("exposes a healthy local port on the provider without starting the worker", async () => {
    const server = new KiCADMcpServer(pythonBridge, "error");
    const port = server.getRuntimePort();
    expect(port).toBeInstanceOf(LocalKiCADRuntimeAdapter);
    expect(port.transportKind).toBe("local");
    await expect(port.health()).resolves.toMatchObject({
      transport: "local",
      reachable: true,
      generation: "local",
    });
    await server.stop();
  });

  it("keeps PYTHONPATH precedence: explicit env wins, legacy fallback is stable", () => {
    const previous = process.env.PYTHONPATH;
    try {
      process.env.PYTHONPATH = "C:\\custom\\site-packages";
      expect(resolveWorkerPythonPath("C:\\whatever\\python.exe")).toBe("C:\\custom\\site-packages");
      delete process.env.PYTHONPATH;
      // Non-KiCad executable on this host: no derived path, legacy fallback.
      expect(resolveWorkerPythonPath("C:\\whatever\\python.exe")).toBe(LEGACY_KICAD_SITE_PACKAGES);
    } finally {
      if (previous === undefined) delete process.env.PYTHONPATH;
      else process.env.PYTHONPATH = previous;
    }
  });
});
