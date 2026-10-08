/**
 * Single-layer Bearer authentication for CDT-KiCAD network transport.
 *
 * Fork of mixelpixx/KiCAD-MCP-Server (MIT, see ATTRIBUTION.md).
 * SlncTrZ provider-shell adaptation by SlncTrZ / Truong Cong Dinh.
 *
 * Both supported credential forms (Authorization: Bearer / X-API-Key)
 * resolve through verifyToken() — never through separate logic paths.
 * Fail-closed: missing/invalid identity -> 401; valid but denied -> 403.
 * Tokens are never logged, echoed, or placed in tool arguments/results.
 */

export interface AuthResult {
  ok: boolean;
  /** "missing" | "invalid" -> 401, "forbidden" -> 403 */
  reason?: "missing" | "invalid" | "forbidden";
}

/** Token source of truth: deployment-managed env, never source control. */
export function expectedToken(): string | undefined {
  const token = process.env.KICAD_MCP_TOKEN?.trim();
  return token ? token : undefined;
}

/** Explicit local-testing escape hatch; default is fail-closed. */
export function allowUnauthenticated(): boolean {
  return process.env.MCP_ALLOW_UNAUTHENTICATED === "1";
}

/** Extract the presented credential without logging it. */
export function extractPresentedToken(headers: Record<string, unknown>): string | undefined {
  const authHeader = headers["authorization"];
  if (typeof authHeader === "string") {
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (match) return match[1].trim() || undefined;
  }
  const apiKey = headers["x-api-key"];
  if (typeof apiKey === "string" && apiKey.trim()) return apiKey.trim();
  return undefined;
}

/** One authorization layer for every credential form. */
export function verifyToken(headers: Record<string, unknown>): AuthResult {
  const expected = expectedToken();
  if (!expected) {
    // No token configured: closed unless the operator explicitly opted into
    // unauthenticated local testing.
    return allowUnauthenticated() ? { ok: true } : { ok: false, reason: "missing" };
  }
  const presented = extractPresentedToken(headers);
  if (!presented) return { ok: false, reason: "missing" };
  if (presented.length !== expected.length) return { ok: false, reason: "invalid" };
  // Constant-time comparison to avoid length/timing oracles on the secret.
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ presented.charCodeAt(i);
  }
  return diff === 0 ? { ok: true } : { ok: false, reason: "invalid" };
}

/** Map an auth failure to HTTP status without leaking the secret. */
export function authFailureStatus(reason: AuthResult["reason"]): number {
  return reason === "forbidden" ? 403 : 401;
}
