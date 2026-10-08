/**
 * Fork of mixelpixx/KiCAD-MCP-Server (MIT, see ATTRIBUTION.md).
 * SlncTrZ provider adaptation by SlncTrZ / Truong Cong Dinh.
 *
 * Semantic operation receipts for timeout-safe ECAD mutations.
 *
 * Bridge request IDs correlate one Node<->Python frame only. operation_id is
 * caller-visible semantic identity and survives a caller timeout/retry.
 */

import { createHash } from "crypto";

export type OperationReceiptState = "committed" | "failed" | "uncertain";

export interface OperationReconciliation {
  strategy: "direct_response" | "read_after_write";
  evidence?: unknown;
}

export interface OperationReceipt {
  operation_id: string;
  command: string;
  fingerprint: string;
  state?: OperationReceiptState;
  backend_owner?: string;
  reconciliation?: OperationReconciliation;
  result?: any;
}

export type BeginResult =
  | { kind: "new"; receipt: OperationReceipt }
  | { kind: "in_flight"; receipt: OperationReceipt }
  | { kind: OperationReceiptState; receipt: OperationReceipt };

const RECONCILABLE_OPERATIONS = new Set([
  "move_component",
  "set_board_size",
  "save_project",
  "export_pdf",
]);

const SAFE_READ_PREFIXES = [
  "get_",
  "list_",
  "find_",
  "search_",
  "check_",
  "validate_",
  "is_",
  "system_",
];

const SAFE_READ_COMMANDS = new Set([
  "help",
  "_warmup",
  "_reconcile_operation",
]);

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(source)
        .sort()
        .map((key) => [key, stableValue(source[key])]),
    );
  }
  return value;
}

export function operationFingerprint(command: string, params: Record<string, unknown>): string {
  const canonical = JSON.stringify({ command, params: stableValue(params) });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export function commandMayMutate(command: string): boolean {
  if (SAFE_READ_COMMANDS.has(command)) return false;
  return !SAFE_READ_PREFIXES.some((prefix) => command.startsWith(prefix));
}

export function hasAutomaticReconciliation(command: string): boolean {
  return RECONCILABLE_OPERATIONS.has(command);
}

export function splitOperationId(params: Record<string, unknown> | null | undefined): {
  operationId?: string;
  params: Record<string, unknown>;
} {
  const copy = { ...(params ?? {}) };
  const camel = copy.operationId;
  const snake = copy.operation_id;
  delete copy.operationId;
  delete copy.operation_id;
  if (camel !== undefined && snake !== undefined && camel !== snake) {
    throw new Error("operationId and operation_id must match when both are provided");
  }
  const raw = camel ?? snake;
  if (raw === undefined) return { params: copy };
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new Error("operationId/operation_id must be a non-empty string when provided");
  }
  return { operationId: raw, params: copy };
}

export class OperationReceiptStore {
  private readonly receipts = new Map<string, OperationReceipt>();

  public begin(
    operationId: string,
    command: string,
    params: Record<string, unknown>,
  ): BeginResult {
    const fingerprint = operationFingerprint(command, params);
    const existing = this.receipts.get(operationId);
    if (existing) {
      if (existing.command !== command || existing.fingerprint !== fingerprint) {
        throw new Error(
          `operation_id ${operationId} was already used for a different command or parameters`,
        );
      }
      if (!existing.state) return { kind: "in_flight", receipt: existing };
      return { kind: existing.state, receipt: existing } as BeginResult;
    }

    const receipt: OperationReceipt = {
      operation_id: operationId,
      command,
      fingerprint,
    };
    this.receipts.set(operationId, receipt);
    return { kind: "new", receipt };
  }

  public get(operationId: string): OperationReceipt | undefined {
    return this.receipts.get(operationId);
  }

  /**
   * Remove a semantic receipt only while it is still waiting for bridge dispatch.
   * Callers use this for bounded-queue refusal/expiry, where no backend side effect
   * could have started and retrying the same operation_id is therefore safe.
   */
  public abandonBeforeDispatch(operationId: string): void {
    const receipt = this.receipts.get(operationId);
    if (!receipt) return;
    if (receipt.state !== undefined) {
      throw new Error(`Cannot abandon terminal operation_id: ${operationId}`);
    }
    this.receipts.delete(operationId);
  }

  public firstUncertain(excludeOperationId?: string): OperationReceipt | undefined {
    for (const receipt of this.receipts.values()) {
      if (receipt.state === "uncertain" && receipt.operation_id !== excludeOperationId) {
        return receipt;
      }
    }
    return undefined;
  }

  public markUncertain(operationId: string, backendOwner?: string): OperationReceipt {
    return this.update(operationId, {
      state: "uncertain",
      ...(backendOwner ? { backend_owner: backendOwner } : {}),
    });
  }

  public markCommitted(
    operationId: string,
    result: any,
    backendOwner?: string,
    reconciliation: OperationReconciliation = { strategy: "direct_response" },
  ): OperationReceipt {
    return this.update(operationId, {
      state: "committed",
      result,
      ...(backendOwner ? { backend_owner: backendOwner } : {}),
      reconciliation,
    });
  }

  public markFailed(
    operationId: string,
    result: any,
    backendOwner?: string,
    reconciliation: OperationReconciliation = { strategy: "direct_response" },
  ): OperationReceipt {
    return this.update(operationId, {
      state: "failed",
      result,
      ...(backendOwner ? { backend_owner: backendOwner } : {}),
      reconciliation,
    });
  }

  private update(operationId: string, patch: Partial<OperationReceipt>): OperationReceipt {
    const receipt = this.receipts.get(operationId);
    if (!receipt) {
      throw new Error(`Unknown operation_id: ${operationId}`);
    }
    Object.assign(receipt, patch);
    return receipt;
  }
}

export function decorateWithReceipt(result: any, receipt: OperationReceipt): any {
  const publicReceipt = {
    operation_id: receipt.operation_id,
    state: receipt.state,
    command: receipt.command,
    ...(receipt.backend_owner ? { backend_owner: receipt.backend_owner } : {}),
    ...(receipt.reconciliation ? { reconciliation: receipt.reconciliation } : {}),
  };

  if (result && typeof result === "object") {
    return { ...result, operation_receipt: publicReceipt };
  }
  return { result, operation_receipt: publicReceipt };
}

export class OperationUncertainError extends Error {
  public readonly code = "operation_uncertain";
  public readonly receipt: OperationReceipt;

  constructor(receipt: OperationReceipt) {
    super(
      `Operation completion is uncertain after timeout; operation_id=${receipt.operation_id}. ` +
        "Do not blindly retry or issue a dependent mutation until reconciliation commits or fails it.",
    );
    this.name = "OperationUncertainError";
    this.receipt = receipt;
  }
}

export class OperationBlockedError extends Error {
  public readonly code = "operation_blocked_by_uncertain_predecessor";
  public readonly blockingReceipt: OperationReceipt;

  constructor(receipt: OperationReceipt) {
    super(
      `Mutation blocked while operation_id=${receipt.operation_id} is uncertain; ` +
        "read-only inspection is still allowed.",
    );
    this.name = "OperationBlockedError";
    this.blockingReceipt = receipt;
  }
}
