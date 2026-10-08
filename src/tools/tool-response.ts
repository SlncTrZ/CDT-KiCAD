import {
  OperationBlockedError,
  type OperationReceipt,
  OperationUncertainError,
} from "../operation-receipts.js";
import { ERROR_KINDS } from "../provider-contract.js";

export type McpTextResult = {
  content: Array<{
    type: "text";
    text: string;
  }>;
  isError?: true;
};

type ErrorKind = (typeof ERROR_KINDS)[number];

export type KicadFailurePayload = Record<string, unknown> & {
  success: false;
  kind: ErrorKind;
  retryable: boolean;
  message: string;
  details?: unknown;
};

const RETRYABLE_KINDS = new Set<ErrorKind>(["rate_limited", "timeout", "provider_unavailable"]);

export function isKicadFailure(result: unknown): result is Record<string, unknown> & { success: false } {
  return (
    typeof result === "object" &&
    result !== null &&
    "success" in result &&
    (result as { success?: unknown }).success === false
  );
}

function isErrorKind(value: unknown): value is ErrorKind {
  return typeof value === "string" && (ERROR_KINDS as readonly string[]).includes(value);
}

function isProviderRuntimeError(
  error: unknown,
): error is Error & {
  kind: ErrorKind;
  retryable: boolean;
  providerMessage: string;
  details?: unknown;
} {
  return (
    error instanceof Error &&
    isErrorKind((error as { kind?: unknown }).kind) &&
    typeof (error as { retryable?: unknown }).retryable === "boolean" &&
    typeof (error as { providerMessage?: unknown }).providerMessage === "string"
  );
}

function sanitizeDiagnosticText(value: string): string {
  let sanitized = value;
  const sysPathMarker = "Python sys.path:";
  if (sanitized.includes(sysPathMarker)) {
    sanitized = sanitized.split(sysPathMarker, 1)[0].trimEnd();
  }

  const tracebackMarker = "Traceback (most recent call last):";
  if (sanitized.includes(tracebackMarker)) {
    const [prefix, tail] = sanitized.split(tracebackMarker, 2);
    if (prefix.trim()) return prefix.trim();

    const lines = tail
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => !line.startsWith('File "') && !line.startsWith("File '"));
    return lines.at(-1) ?? "Internal provider error";
  }

  const filtered = sanitized
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      return !trimmed.startsWith('File "') && !trimmed.startsWith("File '");
    })
    .join("\n")
    .trim();

  return filtered || "Internal provider error";
}

function sanitizeValue(value: unknown): unknown {
  if (typeof value === "string") return sanitizeDiagnosticText(value);
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, sanitizeValue(item)]),
    );
  }
  return value;
}

export function canonicalizeKicadFailure(
  result: Record<string, unknown> & { success: false },
): KicadFailurePayload {
  const sanitized = sanitizeValue(result) as Record<string, unknown> & { success: false };
  const kind: ErrorKind = isErrorKind(sanitized.kind) ? sanitized.kind : "internal_error";
  const retryable =
    typeof sanitized.retryable === "boolean" ? sanitized.retryable : RETRYABLE_KINDS.has(kind);

  const rawMessage =
    typeof sanitized.message === "string" && sanitized.message.trim()
      ? sanitized.message
      : typeof sanitized.errorDetails === "string" && sanitized.errorDetails.trim()
        ? sanitized.errorDetails
        : typeof sanitized.reason === "string" && sanitized.reason.trim()
          ? sanitized.reason
          : typeof sanitized.error === "string" && sanitized.error.trim()
            ? sanitized.error
            : "KiCAD backend operation failed";

  const normalized: KicadFailurePayload = {
    ...sanitized,
    success: false,
    kind,
    retryable,
    message: rawMessage,
  };

  if (normalized.details === undefined && normalized.errorDetails !== undefined) {
    normalized.details = normalized.errorDetails;
  }

  return normalized;
}

export class KicadBackendError extends Error {
  readonly failure: KicadFailurePayload;

  constructor(failure: KicadFailurePayload) {
    super(failure.message);
    this.name = "KicadBackendError";
    this.failure = failure;
  }
}

export function ensureKicadSuccess<T>(result: T): T {
  if (isKicadFailure(result)) {
    throw new KicadBackendError(canonicalizeKicadFailure(result));
  }
  return result;
}

function publicOperationReceipt(receipt: OperationReceipt): Record<string, unknown> {
  return {
    operation_id: receipt.operation_id,
    command: receipt.command,
    state: receipt.state,
    ...(receipt.backend_owner ? { backend_owner: receipt.backend_owner } : {}),
    ...(receipt.reconciliation ? { reconciliation: receipt.reconciliation } : {}),
  };
}

export function formatKicadException(error: unknown): McpTextResult {
  if (error instanceof KicadBackendError) {
    return formatKicadResult(error.failure);
  }

  if (error instanceof OperationUncertainError) {
    return formatKicadResult({
      success: false,
      kind: "timeout",
      retryable: false,
      message: error.message,
      code: error.code,
      operation_receipt: publicOperationReceipt(error.receipt),
    });
  }

  if (error instanceof OperationBlockedError) {
    return formatKicadResult({
      success: false,
      kind: "conflict",
      retryable: false,
      message: error.message,
      code: error.code,
      blocking_operation_receipt: publicOperationReceipt(error.blockingReceipt),
    });
  }

  if (isProviderRuntimeError(error)) {
    return formatKicadResult({
      success: false,
      kind: error.kind,
      retryable: error.retryable,
      message: sanitizeDiagnosticText(error.providerMessage),
      ...(error.details === undefined ? {} : { details: sanitizeValue(error.details) }),
    });
  }

  const message = sanitizeDiagnosticText(error instanceof Error ? error.message : String(error));
  return formatKicadResult({
    success: false,
    kind: "internal_error",
    retryable: false,
    message,
  });
}

export function normalizeMcpToolResult(result: unknown): unknown {
  if (
    typeof result !== "object" ||
    result === null ||
    !("isError" in result) ||
    (result as { isError?: unknown }).isError !== true
  ) {
    return result;
  }

  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return formatKicadResult({
      success: false,
      kind: "internal_error",
      retryable: false,
      message: "Tool operation failed without an error payload",
    });
  }

  const text = content.find(
    (item): item is { type: "text"; text: string } =>
      typeof item === "object" &&
      item !== null &&
      (item as { type?: unknown }).type === "text" &&
      typeof (item as { text?: unknown }).text === "string",
  )?.text;

  if (!text) {
    return formatKicadResult({
      success: false,
      kind: "internal_error",
      retryable: false,
      message: "Tool operation failed without a text error",
    });
  }

  try {
    const parsed = JSON.parse(text);
    if (isKicadFailure(parsed)) {
      return formatKicadResult(canonicalizeKicadFailure(parsed));
    }
  } catch {
    // Legacy/direct tools may return human-readable error text.
  }

  return formatKicadResult({
    success: false,
    kind: "internal_error",
    retryable: false,
    message: sanitizeDiagnosticText(text),
  });
}

export function formatKicadResult(result: unknown): McpTextResult {
  const text = JSON.stringify(result) ?? String(result);

  return {
    content: [
      {
        type: "text",
        text,
      },
    ],
    ...(isKicadFailure(result) ? { isError: true as const } : {}),
  };
}
