/**
 * UI/Process management tools for KiCAD MCP server
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { logger } from "../logger.js";

export function registerUITools(server: McpServer, callKicadScript: Function) {
  // Get MCP/KiCAD backend and loaded file state
  server.tool(
    "get_backend_state",
    "Return the active backend, realtime status, loaded project/board paths, and dirty state.",
    {},
    async () => {
      logger.info("Getting KiCAD backend state");
      const result = await callKicadScript("get_backend_state", {});
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    },
  );

  server.tool(
    "reconnect_backend",
    "Reconnect an IPC-owned board session only when the live KiCAD document identity still matches the pinned board. Never falls back to SWIG.",
    {},
    async () => {
      logger.info("Reconnecting KiCAD backend session");
      const result = await callKicadScript("reconnect_backend", {});
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    },
  );

  server.tool(
    "rebind_backend_session",
    "Explicitly rebind backend ownership. IPC requires matching live document identity; SWIG requires the same board path and explicit confirmation before discarding possibly-unsaved live GUI state.",
    {
      targetBackend: z.enum(["ipc", "swig"]),
      boardPath: z
        .string()
        .optional()
        .describe("Expected .kicad_pcb identity; defaults to pinned path"),
      confirmDiscardLiveState: z
        .boolean()
        .optional()
        .describe("Required for IPC->SWIG rebind because unsaved GUI edits may be discarded"),
    },
    async (args: {
      targetBackend: "ipc" | "swig";
      boardPath?: string;
      confirmDiscardLiveState?: boolean;
    }) => {
      logger.info("Explicitly rebinding KiCAD backend session");
      const result = await callKicadScript("rebind_backend_session", args);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    },
  );

  // Check if KiCAD UI is running
  server.tool("check_kicad_ui", "Check if KiCAD UI is currently running", {}, async () => {
    logger.info("Checking KiCAD UI status");
    const result = await callKicadScript("check_kicad_ui", {});
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  });

  // Launch KiCAD UI
  server.tool(
    "launch_kicad_ui",
    "Launch KiCAD UI, optionally with a project file",
    {
      projectPath: z.string().optional().describe("Optional path to .kicad_pcb file to open"),
      autoLaunch: z
        .boolean()
        .optional()
        .describe("Whether to launch KiCAD if not running (default: true)"),
    },
    async (args: { projectPath?: string; autoLaunch?: boolean }) => {
      logger.info(
        `Launching KiCAD UI${args.projectPath ? " with project: " + args.projectPath : ""}`,
      );
      const result = await callKicadScript("launch_kicad_ui", args);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    },
  );

  logger.info("UI management tools registered");
}
