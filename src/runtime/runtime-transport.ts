/**
 * Fork of mixelpixx/KiCAD-MCP-Server (MIT, see ATTRIBUTION.md).
 * SlncTrZ provider adaptation by SlncTrZ / Truong Cong Dinh.
 *
 * RuntimeTransport abstraction — provider/execution boundary (migration K2).
 *
 * Typed bounded request/response between the MCP provider process and the
 * workstation-side runtime agent. Two implementations share one contract:
 *
 * - `LocalRuntimeTransport` — in-process delegate over a KiCADRuntimePort.
 *   Default single-host path; behavior unchanged.
 * - `RemoteRuntimeTransport` — loopback HTTP client to a
 *   WorkstationKiCADRuntimeAgent (see workstation-kicad-runtime-agent.ts).
 *   Proves the split-process path on one host; split-host deploy comes later.
 *
 * This module owns NO CAD semantics: the only operation vocabulary is the
 * command name (same string the local dispatch already accepts) plus opaque
 * JSON params. PID/fingerprint/recovery/session-pinning semantics stay inside
 * the reused implementation behind the port. Mutation fencing stays
 * provider-side (operation receipts); the agent holds a serial dispatch lock
 * only, never a second receipt authority.
 *
 * Errors are structurally compatible with the tool boundary
 * (`kind`/`retryable`/`providerMessage`, JSON message payload) so
 * `formatKicadException` classifies them exactly like bridge errors.
 */

import { Buffer } from "node:buffer";
import { randomUUID, timingSafeEqual } from "crypto";
import type { KiCADRuntimePort } from "./kicad-runtime-port.js";
import { AUTOROUTE_MAX_BUDGET_MS } from "../command-timeout.js";

export const DEFAULT_TRANSPORT_DEADLINE_MS = 60_000;
export const MAX_TRANSPORT_DEADLINE_MS = AUTOROUTE_MAX_BUDGET_MS + 30_000;
export const MIN_TRANSPORT_DEADLINE_MS = 100;
export const MAX_TRANSPORT_REQUEST_BYTES = 256 * 1024;
export const MAX_TRANSPORT_RESPONSE_BYTES = 4 * 1024 * 1024;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

export type RuntimeErrorKind =
  | "rate_limited"
  | "timeout"
  | "provider_unavailable"
  | "internal_error";

/**
 * Transport-local error carrying the canonical provider error fields.
 * Same wire shape as server ProviderRuntimeError; recognised structurally by
 * the tool-response boundary (no import cycle with server.ts).
 */
export class RuntimeTransportFailure extends Error {
  public readonly providerMessage: string;

  constructor(
    public readonly kind: string,
    public readonly retryable: boolean,
    message: string,
    public readonly details?: Readonly<Record<string, unknown>>,
  ) {
    const payload = {
      success: false,
      kind,
      retryable,
      message,
      ...(details ? { details } : {}),
    };
    super(JSON.stringify(payload));
    this.name = "RuntimeTransportFailure";
    this.providerMessage = message;
  }

  toJSON(): Record<string, unknown> {
    return {
      success: false,
      kind: this.kind,
      retryable: this.retryable,
      message: this.providerMessage,
      ...(this.details ? { details: this.details } : {}),
    };
  }
}

export class RuntimeUnavailableError extends RuntimeTransportFailure {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super("provider_unavailable", true, message, details);
    this.name = "RuntimeUnavailableError";
  }
}

export class RuntimeAuthError extends RuntimeTransportFailure {
  constructor(message: string) {
    super("provider_unavailable", false, message, { code: "RUNTIME_AUTH" });
    this.name = "RuntimeAuthError";
  }
}

/** Timeout/disconnect after dispatch started — completion unknown, no blind replay. */
export class RuntimeUncertainError extends RuntimeTransportFailure {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super("timeout", false, message, { completion_unknown: true, ...(details ?? {}) });
    this.name = "RuntimeUncertainError";
  }
}

export class RuntimeGenerationMismatchError extends RuntimeTransportFailure {
  constructor(message: string, completionUnknown = false) {
    super("provider_unavailable", false, message, {
      code: "GENERATION_MISMATCH",
      ...(completionUnknown ? { completion_unknown: true } : {}),
    });
    this.name = "RuntimeGenerationMismatchError";
  }
}

/** Unknown/refused op rejected before dispatch — no CAD effect. */
export class RuntimeOpRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeOpRefusedError";
  }
}

export function checkTransportOp(command: string): string {
  const name = String(command ?? "").trim();
  if (!name) throw new RuntimeOpRefusedError("runtime op refused: empty command");
  if (name.length > 256) throw new RuntimeOpRefusedError("runtime op refused: command too long");
  return name;
}

export function checkTransportDeadline(deadlineMs: number | undefined): number {
  const value = deadlineMs === undefined ? DEFAULT_TRANSPORT_DEADLINE_MS : Math.floor(deadlineMs);
  if (
    !Number.isFinite(value) ||
    value < MIN_TRANSPORT_DEADLINE_MS ||
    value > MAX_TRANSPORT_DEADLINE_MS
  ) {
    throw new RuntimeOpRefusedError(
      `deadline_ms must be within [${MIN_TRANSPORT_DEADLINE_MS}, ${MAX_TRANSPORT_DEADLINE_MS}], got ${deadlineMs}`,
    );
  }
  return value;
}

export function checkTransportRequestSize(payload: unknown): void {
  const raw = JSON.stringify(payload) ?? "";
  const bytes = Buffer.byteLength(raw, "utf-8");
  if (bytes > MAX_TRANSPORT_REQUEST_BYTES) {
    throw new RuntimeOpRefusedError(
      `runtime request oversized: ${bytes} bytes > ${MAX_TRANSPORT_REQUEST_BYTES}`,
    );
  }
}

export interface TransportCallOptions {
  deadlineMs?: number;
  expectedGeneration?: string;
  requestId?: string;
}

export interface RuntimeTransport {
  readonly kind: "local" | "remote";
  call(
    command: string,
    params?: Record<string, unknown>,
    options?: TransportCallOptions,
  ): Promise<unknown>;
  health(): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

function newRequestId(): string {
  try {
    return randomUUID();
  } catch {
    return `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  }
}

/**
 * In-process delegate over a KiCADRuntimePort. Default single-host path.
 * Generation pinning is enforced before dispatch; a pinned value refuses
 * stale generations without trusting results.
 */
export class LocalRuntimeTransport implements RuntimeTransport {
  readonly kind = "local" as const;

  private readonly port: KiCADRuntimePort;

  private closed = false;

  constructor(port: KiCADRuntimePort) {
    if (!port || typeof port.execute !== "function") {
      throw new TypeError("LocalRuntimeTransport requires a KiCADRuntimePort");
    }
    this.port = port;
  }

  async call(
    command: string,
    params: Record<string, unknown> = {},
    options: TransportCallOptions = {},
  ): Promise<unknown> {
    if (this.closed) throw new RuntimeUnavailableError("local runtime transport is closed");
    const op = checkTransportOp(command);
    const expected = options.expectedGeneration;
    if (expected !== undefined && expected !== this.port.generation) {
      throw new RuntimeGenerationMismatchError(
        `runtime generation mismatch: expected ${JSON.stringify(expected)}, ` +
          `local generation is ${JSON.stringify(this.port.generation)}; result discarded`,
      );
    }
    return this.port.execute(op, params ?? {}, { timeoutMs: options.deadlineMs });
  }

  async health(): Promise<Record<string, unknown>> {
    if (this.closed) throw new RuntimeUnavailableError("local runtime transport is closed");
    const portHealth = await this.port.health();
    return {
      ...portHealth,
      transport: "local" as const,
      reachable: !this.closed,
      via: "local-transport",
    };
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

export function bearerMatches(presented: string, expected: string): boolean {
  if (!expected) return false;
  const a = Buffer.from(String(presented ?? ""), "utf-8");
  const b = Buffer.from(String(expected ?? ""), "utf-8");
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function requireLoopback(
  baseUrl: string,
  allowRemote: boolean,
): { base: string; host: string; port: number } {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new RuntimeOpRefusedError(`invalid runtime endpoint: ${baseUrl}`);
  }
  const host = (parsed.hostname || "").toLowerCase();
  if (!LOOPBACK_HOSTS.has(host) && !allowRemote) {
    throw new RuntimeOpRefusedError(
      `refusing non-loopback runtime endpoint ${JSON.stringify(host)}; split-host deploy is out of scope`,
    );
  }
  const port = parsed.port ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80;
  return { base: baseUrl.replace(/\/+$/, ""), host, port };
}

async function httpJson(
  url: string,
  init: { method: string; token: string; body?: string; timeoutMs: number },
): Promise<{ status: number; raw: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs);
  try {
    const response = await fetch(url, {
      method: init.method,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${init.token}`,
      },
      body: init.body,
      signal: controller.signal,
    });
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > MAX_TRANSPORT_RESPONSE_BYTES) {
      controller.abort();
      throw new RuntimeTransportFailure(
        "internal_error",
        false,
        `runtime response oversized (${contentLength} bytes); discarded without trust`,
        { code: "TRANSPORT_RESPONSE_TOO_LARGE" },
      );
    }
    if (!response.body) {
      return { status: response.status, raw: "" };
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytesReceived = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          bytesReceived += value.byteLength;
          if (bytesReceived > MAX_TRANSPORT_RESPONSE_BYTES) {
            controller.abort();
            throw new RuntimeTransportFailure(
              "internal_error",
              false,
              `runtime response oversized (>${MAX_TRANSPORT_RESPONSE_BYTES} bytes); discarded without trust`,
              { code: "TRANSPORT_RESPONSE_TOO_LARGE" },
            );
          }
          chunks.push(value);
        }
      }
    } finally {
      reader.releaseLock();
    }
    const raw = Buffer.concat(chunks).toString("utf-8");
    return { status: response.status, raw };
  } catch (error) {
    if (error instanceof RuntimeTransportFailure) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new RuntimeUncertainError(
      `runtime transport I/O failed after dispatch may have started (${message}); ` +
        `completion is unknown, blind retry is forbidden`,
    );
  } finally {
    clearTimeout(timer);
  }
}

type RuntimeWireResult = Record<string, unknown> | unknown[] | string | number | boolean | null;

function decodeEnvelope(
  op: string,
  status: number,
  raw: string,
  expectedGeneration?: string,
): RuntimeWireResult {
  if (status === 401 || status === 403) {
    throw new RuntimeAuthError(
      `runtime endpoint rejected credentials for op ${JSON.stringify(op)} (http ${status})`,
    );
  }
  if (status === 404)
    throw new RuntimeUnavailableError(`runtime endpoint has no route for op ${JSON.stringify(op)}`);
  if (status === 409) {
    throw new RuntimeGenerationMismatchError(
      `runtime generation mismatch for op ${JSON.stringify(op)}; result discarded`,
    );
  }
  if (status >= 500) {
    throw new RuntimeUncertainError(
      `runtime endpoint error ${status} for op ${JSON.stringify(op)} after dispatch; ` +
        `completion is unknown, blind retry is forbidden`,
    );
  }
  if (status < 200 || status >= 300) {
    throw new RuntimeTransportFailure(
      "internal_error",
      false,
      `runtime endpoint http ${status} for op ${JSON.stringify(op)}`,
    );
  }
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(raw || "{}") as Record<string, unknown>;
  } catch {
    throw new RuntimeUncertainError(
      `malformed runtime response for op ${JSON.stringify(op)}; completion is unknown`,
    );
  }
  if (
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    typeof payload["ok"] !== "boolean"
  ) {
    throw new RuntimeUncertainError(
      `malformed runtime envelope for op ${JSON.stringify(op)}; completion is unknown`,
    );
  }
  if (payload["ok"] !== true) {
    const code = String(payload["error_code"] || "error");
    const message = String(
      payload["error_message"] || `runtime op ${JSON.stringify(op)} failed: ${code}`,
    );
    // Typed worker failure passthrough (agent forwards the canonical worker
    // payload verbatim, e.g. SWIG unsupported_capability): preserve kind +
    // retryability end-to-end instead of collapsing to internal_error.
    if (payload["success"] === false && typeof payload["kind"] === "string") {
      throw new RuntimeTransportFailure(
        payload["kind"] as string,
        payload["retryable"] === true,
        typeof payload["message"] === "string" && payload["message"]
          ? (payload["message"] as string)
          : message,
        payload["details"] && typeof payload["details"] === "object"
          ? (payload["details"] as Record<string, unknown>)
          : undefined,
      );
    }
    if (
      code === "op_refused" ||
      code === "bad_request" ||
      code === "oversized" ||
      code === "unknown_op"
    ) {
      throw new RuntimeOpRefusedError(message);
    }
    if (code === "uncertain" || payload["completion_unknown"] === true) {
      throw new RuntimeUncertainError(message);
    }
    if (code === "unavailable") throw new RuntimeUnavailableError(message);
    if (code === "unauthorized" || code === "forbidden") throw new RuntimeAuthError(message);
    throw new RuntimeTransportFailure("internal_error", false, `${message} [${code}]`);
  }
  if (
    typeof expectedGeneration === "string" &&
    (typeof payload["generation"] !== "string" ||
      !payload["generation"].trim() ||
      payload["generation"] !== expectedGeneration)
  ) {
    throw new RuntimeGenerationMismatchError(
      `runtime generation mismatch for op ${JSON.stringify(op)}; result discarded`,
      true,
    );
  }
  return payload["result"] as RuntimeWireResult;
}

/**
 * Loopback HTTP client to a WorkstationKiCADRuntimeAgent (split-process path).
 * Auth is a bearer token compared server-side with timingSafeEqual; never logged.
 * Any timeout/disconnect once dispatch may have started is completion-unknown.
 */
export class RemoteRuntimeTransport implements RuntimeTransport {
  readonly kind = "remote" as const;

  private readonly base: string;

  private readonly token: string;

  private readonly defaultDeadlineMs: number;

  private closed = false;

  constructor(
    baseUrl: string,
    authToken: string,
    options: { allowRemote?: boolean; defaultDeadlineMs?: number } = {},
  ) {
    if (!String(authToken ?? "").trim())
      throw new Error("RemoteRuntimeTransport requires a non-empty auth_token");
    this.base = requireLoopback(baseUrl, options.allowRemote === true).base;
    this.token = String(authToken);
    this.defaultDeadlineMs = checkTransportDeadline(options.defaultDeadlineMs);
  }

  /** Redacts the credential; never logs the token. */
  toJSON(): Record<string, unknown> {
    return { kind: "remote", base: this.base, auth: "<redacted>" };
  }

  async call(
    command: string,
    params: Record<string, unknown> = {},
    options: TransportCallOptions = {},
  ): Promise<unknown> {
    if (this.closed) throw new RuntimeUnavailableError("remote runtime transport is closed");
    const op = checkTransportOp(command);
    const deadlineMs =
      options.deadlineMs === undefined
        ? this.defaultDeadlineMs
        : checkTransportDeadline(options.deadlineMs);
    const wire = {
      request_id: options.requestId ?? newRequestId(),
      op,
      params: params ?? {},
      deadline_ms: deadlineMs,
      expected_generation: options.expectedGeneration ?? null,
    };
    checkTransportRequestSize(wire);
    const { status, raw } = await httpJson(`${this.base}/dispatch`, {
      method: "POST",
      token: this.token,
      body: JSON.stringify(wire),
      timeoutMs: deadlineMs,
    });
    return decodeEnvelope(op, status, raw, options.expectedGeneration ?? undefined);
  }

  async health(): Promise<Record<string, unknown>> {
    if (this.closed) throw new RuntimeUnavailableError("remote runtime transport is closed");
    const { status, raw } = await httpJson(`${this.base}/health`, {
      method: "GET",
      token: this.token,
      timeoutMs: 5_000,
    });
    const result = decodeEnvelope("health", status, raw);
    return (result && typeof result === "object" ? result : { ok: true, detail: result }) as Record<
      string,
      unknown
    >;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}
