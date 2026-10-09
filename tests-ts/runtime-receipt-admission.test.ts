// Fork of mixelpixx/KiCAD-MCP-Server (MIT, see ATTRIBUTION.md).
// SlncTrZ provider adaptation test coverage.
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { KiCADMcpServer } from "../src/server.js";
import { WorkstationKiCADRuntimeAgent } from "../src/runtime/workstation-kicad-runtime-agent.js";
import { RemoteRuntimeTransport } from "../src/runtime/runtime-transport.js";

describe("native receipt admission over the runtime transport", () => {
  it("keeps a changed-payload conflict typed without dispatching Python", async () => {
    const bridge = fileURLToPath(new URL("../python/kicad_interface.py", import.meta.url));
    const server = new KiCADMcpServer(bridge, "error") as any;
    const writes: unknown[] = [];
    server.readyDetected = true;
    server.pythonProcess = { stdin: { write: (line: string) => {
      writes.push(JSON.parse(line)); return true;
    } } };
    server.operationReceipts.begin("same-id", "add_via", { x: 12 });
    const agent = new WorkstationKiCADRuntimeAgent(server.getRuntimePort(), {
      authToken: "fixture-secret", generation: "fixture-generation",
    });
    const { baseUrl } = await agent.listen();
    const remote = new RemoteRuntimeTransport(baseUrl, "fixture-secret");
    try {
      await expect(remote.call("add_via", { operation_id: "same-id", x: 18 }, {
        expectedGeneration: "fixture-generation",
      })).rejects.toMatchObject({
        kind: "conflict", retryable: false,
        details: { dispatched: false },
      });
      expect(writes).toHaveLength(0);
    } finally {
      await remote.close();
      await agent.close();
    }
  });
});
