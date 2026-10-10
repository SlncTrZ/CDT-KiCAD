/**
 * CDT-KiCAD provider contract constants.
 *
 * Fork of mixelpixx/KiCAD-MCP-Server (MIT, see ATTRIBUTION.md).
 * SlncTrZ provider-shell adaptation by SlncTrZ / Truong Cong Dinh.
 *
 * Centralises the stable provider identity, versioning and capability
 * declarations required by MCP_PROVIDER_STANDARD.md §5/§6/§9 so the help,
 * status and HTTP layers can never drift apart.
 */

import { createHash } from "crypto";
import { existsSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

export const PROVIDER_ID = "kicad";

/** Provider software version — must track package.json. */
export const PROVIDER_VERSION = "0.1.3";

/** Version of this help/tool contract. Bump on any tool/capability change. */
export const CONTRACT_VERSION = "cdt-kicad-contract-v2";

/** Applied CDT common CAD semantics version (subset claim, see capabilities). */
export const COMMON_CONTRACT_VERSION = "cdt-common-v1";

/** MCP protocol / SDK compatibility declaration. */
export const PROTOCOL_VERSION = "MCP 2025-06-18 / SDK 1.21.0";

export type CapabilityMode = "native" | "snapshot" | "unsupported";

export interface CapabilityEntry {
  supported: boolean;
  mode: CapabilityMode;
  reason?: string;
}

/**
 * Honest capability map. Unsupported entries MUST fail with a typed refusal
 * (kind: unsupported_capability), never fake success.
 */
export const CAPABILITIES: Record<string, CapabilityEntry> = {
  "common.document.new": { supported: true, mode: "native" },
  "common.document.open": { supported: true, mode: "native" },
  "common.document.info": { supported: true, mode: "native" },
  "common.document.save": { supported: true, mode: "native" },
  "common.document.save_as": { supported: true, mode: "native" },
  "common.document.close": { supported: true, mode: "native" },
  "common.object.list": { supported: true, mode: "native" },
  "common.object.get": { supported: true, mode: "native" },
  "common.object.count": { supported: true, mode: "native" },
  "common.organization.list": { supported: true, mode: "native" },
  "common.transform.move": { supported: true, mode: "native" },
  "common.transform.rotate": { supported: true, mode: "native" },
  "common.transaction.begin": {
    supported: false,
    mode: "unsupported",
    reason: "no_native_atomic_transaction_verified_checkpoint_recovery_only",
  },
  "common.transaction.commit": {
    supported: false,
    mode: "unsupported",
    reason: "no_native_atomic_transaction_verified_checkpoint_recovery_only",
  },
  "common.transaction.rollback": {
    supported: false,
    mode: "unsupported",
    reason: "no_native_atomic_transaction_verified_checkpoint_recovery_only",
  },
  "common.undo": {
    supported: false,
    mode: "unsupported",
    reason: "no_unified_undo_use_restore_checkpoint",
  },
  "common.redo": {
    supported: false,
    mode: "unsupported",
    reason: "no_unified_undo_use_restore_checkpoint",
  },
  "common.import_asset": { supported: true, mode: "native" },
  "common.export_asset": { supported: true, mode: "native" },
  "common.validate.document": { supported: true, mode: "native" },
  "common.inspect.object": { supported: true, mode: "native" },
  "common.measure.bounds": { supported: true, mode: "native" },
  "kicad.schematic.authoring": { supported: true, mode: "native" },
  "kicad.board.edit": { supported: true, mode: "native" },
  "kicad.routing.autoroute": { supported: true, mode: "native" },
  "kicad.library.manage": { supported: true, mode: "native" },
  "kicad.export.fabrication": { supported: true, mode: "native" },
  "kicad.drc.erc": { supported: true, mode: "native" },
  "kicad.parts.sourcing": { supported: true, mode: "native" },
  "kicad.recovery.checkpoint": {
    supported: true,
    mode: "snapshot",
    reason: "checkpointed_atomic_only_after_hash_restore_reopen_semantic_verification",
  },
};

export const ERROR_KINDS = [
  "authentication_error",
  "authorization_error",
  "validation_error",
  "not_found",
  "conflict",
  "rate_limited",
  "timeout",
  "provider_unavailable",
  "internal_error",
  "unsupported_capability",
] as const;

const GUIDE_RELATIVE = join("..", "docs", "TOOL_GUIDE.md");

/** Absolute path of the runtime guide backing the help contract. */
export function guidePath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, GUIDE_RELATIVE);
}

/** Read the current runtime guide; empty string when unreadable (never throws). */
export function readGuide(): string {
  try {
    const path = guidePath();
    if (!existsSync(path)) return "";
    return readFileSync(path, "utf-8");
  } catch {
    return "";
  }
}

/** Deterministic SHA-256 fingerprint of the canonical guide content. */
export function contractHash(content?: string): string {
  const canonical = (content ?? readGuide()).replace(/\r\n/g, "\n");
  return createHash("sha256").update(canonical, "utf-8").digest("hex");
}
