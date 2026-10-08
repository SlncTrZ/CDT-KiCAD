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

type RuntimeBackendState = {
  backend: string;
  sessionState: string;
  sessionBackend: string | null;
  loadedBoard: boolean | null;
  realtime: boolean;
  reason: string | null;
};

const BOARD_REQUIRED_CAPABILITIES = new Set([
  "common.document.info",
  "common.document.save",
  "common.document.save_as",
  "common.document.close",
  "common.object.list",
  "common.object.get",
  "common.object.count",
  "common.organization.list",
  "common.transform.move",
  "common.transform.rotate",
  "common.export_asset",
  "common.validate.document",
  "common.inspect.object",
  "common.measure.bounds",
  "kicad.board.edit",
  "kicad.routing.autoroute",
  "kicad.export.fabrication",
  "kicad.drc.erc",
]);

const DEGRADED_DISK_READ_CAPABILITIES = new Set(["common.document.info", "common.object.get"]);

function normalizeBackendState(raw: unknown): RuntimeBackendState | null {
  if (!raw || typeof raw !== "object") return null;
  const state = raw as Record<string, unknown>;
  const backend = typeof state.backend === "string" ? state.backend : "unknown";
  const sessionState =
    typeof state.sessionState === "string"
      ? state.sessionState
      : typeof state.session_state === "string"
        ? state.session_state
        : backend;
  const sessionBackend =
    typeof state.sessionBackend === "string"
      ? state.sessionBackend
      : typeof state.session_backend === "string"
        ? state.session_backend
        : null;
  const loadedBoard =
    typeof state.loadedBoard === "boolean"
      ? state.loadedBoard
      : typeof state.loaded_board === "boolean"
        ? state.loaded_board
        : null;
  const realtime =
    typeof state.realtime_sync === "boolean"
      ? state.realtime_sync
      : typeof state.realtime === "boolean"
        ? state.realtime
        : false;
  const reason =
    typeof state.sessionReason === "string"
      ? state.sessionReason
      : typeof state.session_reason === "string"
        ? state.session_reason
        : null;

  return { backend, sessionState, sessionBackend, loadedBoard, realtime, reason };
}

/**
 * Project static implementation declarations into truthful runtime availability.
 * supported is kept for compatibility; implemented and available_now distinguish
 * code existence from whether the current session can safely use it.
 */
export function buildRuntimeCapabilityMap(backendInfo: unknown): Record<string, unknown> {
  const state = normalizeBackendState(backendInfo);

  return Object.fromEntries(
    Object.entries(CAPABILITIES).map(([name, entry]) => {
      let availableNow = entry.supported;
      let reason = entry.reason;

      if (
        entry.supported &&
        (!state || state.backend === "unknown" || state.sessionState === "unknown")
      ) {
        availableNow = false;
        reason = "runtime_context_unavailable";
      } else if (entry.supported && state) {
        const boardRequired = BOARD_REQUIRED_CAPABILITIES.has(name);
        if (boardRequired && state.sessionState === "degraded_uncertain") {
          if (DEGRADED_DISK_READ_CAPABILITIES.has(name)) {
            availableNow = true;
            reason = "saved_disk_read_only_while_live_state_uncertain";
          } else {
            availableNow = false;
            reason = "ipc_session_degraded_uncertain";
          }
        } else if (boardRequired && state.loadedBoard === false) {
          availableNow = false;
          reason = "no_board_loaded";
        }
      }

      return [
        name,
        {
          ...entry,
          implemented: entry.supported,
          available_now: availableNow,
          reason,
          backend: state?.backend ?? "unknown",
          context: {
            session_state: state?.sessionState ?? "unknown",
            session_backend: state?.sessionBackend ?? null,
            loaded_board: state?.loadedBoard ?? null,
            realtime: state?.realtime ?? false,
            source:
              state?.sessionState === "degraded_uncertain" &&
              DEGRADED_DISK_READ_CAPABILITIES.has(name)
                ? "disk"
                : (state?.backend ?? "unknown"),
            state_reason: state?.reason ?? null,
          },
        },
      ];
    }),
  );
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
    "Read-only machine-readable capability map separating implementation from live availability. Preflight before mutating tools. No side effects.",
    {},
    async () => {
      let backendInfo: unknown = null;
      if (getBackendInfo) {
        try {
          backendInfo = await getBackendInfo();
        } catch (error) {
          backendInfo = {
            backend: "unknown",
            sessionState: "unknown",
            sessionReason:
              "backend_state_unavailable: " +
              (error instanceof Error ? error.message : String(error)),
          };
        }
      }

      const result = {
        provider_name: PROVIDER_ID,
        contract_version: CONTRACT_VERSION,
        common_contract_version: COMMON_CONTRACT_VERSION,
        backend_note:
          "Session states are none|swig|ipc|degraded_uncertain. An IPC-owned session never silently downgrades to SWIG; degraded mutations fail closed until explicit reconnect/rebind.",
        backend: backendInfo,
        capabilities: buildRuntimeCapabilityMap(backendInfo),
        error_kinds: [...ERROR_KINDS],
        refusal_policy:
          "implemented describes code support; available_now describes the current session. Temporary degraded-state refusals use provider_unavailable; permanently unsupported capabilities use unsupported_capability.",
      };
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  logger.info("SlncTrZ provider tools registered successfully");
}
