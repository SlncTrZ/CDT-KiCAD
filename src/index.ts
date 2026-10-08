/**
 * KiCAD Model Context Protocol Server
 * Main entry point
 */

import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { KiCADMcpServer } from "./server.js";
import { loadConfig } from "./config.js";
import { logger } from "./logger.js";
import { listenHttp } from "./http-transport.js";

// Get the current directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Main function to start the KiCAD MCP server
 */
async function main() {
  try {
    // Parse command line arguments
    const args = process.argv.slice(2);
    const options = parseCommandLineArgs(args);

    // Load configuration
    const config = await loadConfig(options.configPath);

    // Path to the Python script that interfaces with KiCAD
    const kicadScriptPath = join(dirname(__dirname), "python", "kicad_interface.py");

    // Create the server
    const server = new KiCADMcpServer(kicadScriptPath, config.logLevel);

    // Transport selection: STDIO stays the default (local/desktop clients).
    // MCP_TRANSPORT=http|both enables opt-in Streamable HTTP network mode.
    const transport = (
      options.transport ??
      process.env.MCP_TRANSPORT ??
      config.transport ??
      "stdio"
    ).toLowerCase();
    const port =
      options.port ?? (process.env.MCP_PORT ? Number(process.env.MCP_PORT) : config.port ?? 3100);
    const host = options.host ?? process.env.MCP_HOST ?? config.host ?? "127.0.0.1";

    if (transport === "http") {
      // Network-only: bridge first so every accepted request can execute.
      await server.startBridge();
      await listenHttp(() => server.newHttpServer(), port, host);
    } else if (transport === "both") {
      // Bind HTTP + STDIO first (fast), bridge last (slow warm-up) so both
      // transports are live while Python initialises — same reason as #377.
      await listenHttp(() => server.newHttpServer(), port, host);
      await server.connectStdio();
      await server.startBridge();
    } else {
      // Start the server (STDIO transport)
      await server.start();
    }

    // Setup graceful shutdown
    setupGracefulShutdown(server);

    logger.info(`KiCAD MCP server started with ${transport.toUpperCase()} transport`);
  } catch (error) {
    logger.error(`Failed to start KiCAD MCP server: ${error}`);
    process.exit(1);
  }
}

/**
 * Parse command line arguments
 */
function parseCommandLineArgs(args: string[]) {
  let configPath: string | undefined = undefined;
  let transport: string | undefined = undefined;
  let port: number | undefined = undefined;
  let host: string | undefined = undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--config" && i + 1 < args.length) {
      configPath = args[i + 1];
      i++;
    } else if (args[i] === "--transport" && i + 1 < args.length) {
      transport = args[i + 1];
      i++;
    } else if (args[i] === "--port" && i + 1 < args.length) {
      port = Number(args[i + 1]);
      i++;
    } else if (args[i] === "--host" && i + 1 < args.length) {
      host = args[i + 1];
      i++;
    }
  }

  return { configPath, transport, port, host };
}

/**
 * Setup graceful shutdown handlers
 */
function setupGracefulShutdown(server: KiCADMcpServer) {
  // Handle stdin close (EOF) when parent process exits
  process.stdin.on("close", async () => {
    logger.info("process.stdin closed. Shutting down...");
    await shutdownServer(server);
  });

  // Handle termination signals
  process.on("SIGINT", async () => {
    logger.info("Received SIGINT signal. Shutting down...");
    await shutdownServer(server);
  });

  process.on("SIGTERM", async () => {
    logger.info("Received SIGTERM signal. Shutting down...");
    await shutdownServer(server);
  });

  // Handle uncaught exceptions
  process.on("uncaughtException", async (error) => {
    logger.error(`Uncaught exception: ${error}`);
    await shutdownServer(server);
  });

  // Handle unhandled promise rejections
  process.on("unhandledRejection", async (reason) => {
    logger.error(`Unhandled promise rejection: ${reason}`);
    await shutdownServer(server);
  });
}

/**
 * Shut down the server and exit
 */
async function shutdownServer(server: KiCADMcpServer) {
  try {
    logger.info("Shutting down KiCAD MCP server...");
    await server.stop();
    logger.info("Server shutdown complete. Exiting...");
    process.exit(0);
  } catch (error) {
    logger.error(`Error during shutdown: ${error}`);
    process.exit(1);
  }
}

// Run the main function - always run when imported as module entry point
// The import.meta.url check was failing on Windows due to path separators
main().catch((error) => {
  console.error(`Unhandled error in main: ${error}`);
  process.exit(1);
});

// For testing and programmatic usage
export { KiCADMcpServer };
