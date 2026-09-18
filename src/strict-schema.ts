/**
 * Shared strict Zod object constructor for nested tool schemas.
 *
 * Top-level raw tool shapes are hardened by the MCP contract boundary; explicit
 * nested object schemas use this helper so undeclared fields are rejected at
 * every declared object boundary instead of being silently stripped.
 */
import { z } from "zod";

export function strictObject<T extends z.ZodRawShape>(shape: T): z.ZodObject<T, "strict"> {
  return z.object(shape).strict();
}
