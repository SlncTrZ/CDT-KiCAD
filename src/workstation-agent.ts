/**
 * CDT-KiCAD workstation runtime entrypoint — local Python worker, loopback-only agent.
 * Fork of mixelpixx/KiCAD-MCP-Server (MIT, see ATTRIBUTION.md).
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { KiCADMcpServer } from "./server.js";
import { WorkstationKiCADRuntimeAgent } from "./runtime/workstation-kicad-runtime-agent.js";
import { logger } from "./logger.js";

async function main(): Promise<void> {
  const token = process.env.KICAD_RUNTIME_TOKEN;
  if (!token) throw new Error("KICAD_RUNTIME_TOKEN is required");
  const port = Number(process.env.KICAD_RUNTIME_PORT ?? "19816");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("KICAD_RUNTIME_PORT must be a valid TCP port");
  }
  const script = join(
    dirname(dirname(fileURLToPath(import.meta.url))),
    "python",
    "kicad_interface.py",
  );
  const server = new KiCADMcpServer(script);
  await server.startBridge();
  const agent = new WorkstationKiCADRuntimeAgent(server.getRuntimePort(), { authToken: token });
  await agent.listen("127.0.0.1", port);
  logger.info(`KiCAD workstation runtime listening on loopback port ${port}`);
  const stop = async () => {
    await agent.close();
    await server.stop();
    process.exit(0);
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
}

main().catch((error: unknown) => {
  logger.error(
    `KiCAD workstation runtime failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
