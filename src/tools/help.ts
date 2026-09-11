/**
 * SlncTrZ first-class provider tools: help, system_status, system_capabilities.
 *
 * Fork of mixelpixx/KiCAD-MCP-Server (MIT, see ATTRIBUTION.md).
 * SlncTrZ provider-shell adaptation by SlncTrZ / Truong Cong Dinh.
 *
 * All three are read-only: they never mutate provider state and never touch
 * the KiCAD backend except for a best-effort backend label in system_status.
 * Help content is served from the runtime docs/TOOL_GUIDE.md so the running
 * contract is always what the client reads (standard §6.3).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { existsSync, statSync } from "fs";
import { logger } from "../logger.js";
import {
  PROVIDER_ID,
  PROVIDER_VERSION,
  CONTRACT_VERSION,
  COMMON_CONTRACT_VERSION,
  PROTOCOL_VERSION,
  CAPABILITIES,
  ERROR_KINDS,
  guidePath,
  readGuide,
  contractHash,
} from "../provider-contract.js";

/** Optional backend label provider (e.g. get_backend_state); never throws. */
export type BackendInfoProvider = () => Promise<unknown> | unknown;

function guideUpdatedAt(): string | null {
  try {
    const path = guidePath();
    if (!existsSync(path)) return null;
    return statSync(path).mtime.toISOString();
  } catch {
    return null;
  }
}

function authenticationDescription(): string {
  return [
    "Network (Streamable HTTP /mcp): Authorization: Bearer <token> (primary) or X-API-Key: <token> (compatibility); single authorization layer; fail-closed 401/403.",
    "Credential source: KICAD_MCP_TOKEN env / secret manager. Never in URLs, tool args, logs, or Git-tracked config.",
    "Local STDIO mode: no token (process-local transport).",
    "Vendor keys (JLCPCB_*, DIGIKEY_*) are server-side env only, never tool arguments.",
  ].join(" ");
}

function capabilitySummary(): string[] {
  return [
    "ECAD document lifecycle: project/board/schematic open, info, save, close",
    "Board editing: outline, layers, zones, graphics, origins, clearance checks",
    "Component placement: place/move/rotate/array/align with geometry queries",
    "Routing: traces, vias, zones, differential pairs, ratsnest analysis",
    "Schematic authoring: ~10k dynamic symbols, wiring, hierarchy, batch edits",
    "Libraries: footprint/symbol search, create, register, table management",
    "Validation: validate_schematic/library, run_drc, run_erc with violations",
    "Export: gerber/drill/BOM/netlist/STEP/PDF/SVG/fabrication formats",
    "Sourcing: JLCPCB 2.5M+ catalog, Digi-Key lookup, parts registry",
    "Autoroute: Freerouting DSN/SES workflow with bounded timeouts",
    "No atomic transactions or undo: use snapshot_project checkpoints",
  ];
}

/**
 * Register help, system_status and system_capabilities on the MCP server.
 */
export function registerHelpTools(server: McpServer, getBackendInfo?: BackendInfoProvider): void {
  logger.info("Registering SlncTrZ provider tools (help, system_status, system_capabilities)");

  server.tool(
    "help",
    "Read-only operating contract for the kicad provider: versions, authentication, capabilities and the complete usage guide. Call first; no side effects.",
    {},
    async () => {
      const content = readGuide();
      const result = {
        provider_name: PROVIDER_ID,
        provider_version: PROVIDER_VERSION,
        protocol_version: PROTOCOL_VERSION,
        contract_version: CONTRACT_VERSION,
        common_contract_version: COMMON_CONTRACT_VERSION,
        contract_hash: contractHash(content),
        updated_at: guideUpdatedAt(),
        authentication: authenticationDescription(),
        capabilities: capabilitySummary(),
        content,
      };
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "system_status",
    "Read-only liveness report: provider versions, transport mode, guide availability and best-effort KiCAD backend state. No side effects.",
    {},
    async () => {
      let backend: unknown = "unknown (call get_backend_state for live backend detail)";
      if (getBackendInfo) {
        try {
          backend = await getBackendInfo();
        } catch (error) {
          backend = `unavailable: ${error instanceof Error ? error.message : String(error)}`;
        }
      }
      const guide = readGuide();
      const result = {
        status: "ok",
        provider_name: PROVIDER_ID,
        provider_version: PROVIDER_VERSION,
        contract_version: CONTRACT_VERSION,
        contract_hash: contractHash(guide),
        transport: process.env.MCP_TRANSPORT ?? "stdio",
        guide_available: guide.length > 0,
        backend,
      };
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "system_capabilities",
    "Read-only machine-readable capability map with supported/unsupported modes and refusal reasons. Preflight before calling mutating tools. No side effects.",
    {},
    async () => {
      const result = {
        provider_name: PROVIDER_ID,
        contract_version: CONTRACT_VERSION,
        common_contract_version: COMMON_CONTRACT_VERSION,
        backend_note:
          "swig (file-based pcbnew) or ipc (live KiCAD UI, experimental); never silently downgraded — mismatched backend returns unsupported_capability",
        capabilities: CAPABILITIES,
        error_kinds: [...ERROR_KINDS],
        refusal_policy:
          "Unsupported capabilities fail with kind unsupported_capability (retryable: false). No fake success, no silent fallback.",
      };
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  logger.info("SlncTrZ provider tools registered successfully");
}
