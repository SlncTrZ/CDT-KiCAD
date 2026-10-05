import { describe, expect, it } from "vitest";
import type { ZodTypeAny } from "zod";
import { registerFreeroutingTools } from "../src/tools/freerouting.js";

// The unbound-DoS caps on `autoroute` live in the registered zod schemas, so
// they are read back off a stub server (same pattern as digikey-schemas) —
// this asserts what is actually registered, not a separately exported copy.

interface RegisteredTool {
  name: string;
  schema: Record<string, ZodTypeAny>;
}

function autorouteSchema(): Record<string, ZodTypeAny> {
  const tools: RegisteredTool[] = [];
  const server = {
    tool(name: string, _description: string, schema: Record<string, ZodTypeAny>) {
      tools.push({ name, schema });
    },
  };
  registerFreeroutingTools(server as never, (() => Promise.resolve({})) as never);
  const autoroute = tools.find((t) => t.name === "autoroute");
  if (!autoroute) throw new Error("autoroute tool not registered");
  return autoroute.schema;
}

describe("autoroute input ceilings (unbound-DoS caps)", () => {
  it("rejects non-positive or over-ceiling timeouts", () => {
    const schema = autorouteSchema();
    expect(schema.timeout.safeParse(300).success).toBe(true);
    expect(schema.timeout.safeParse(1800).success).toBe(true);
    expect(schema.timeout.safeParse(undefined).success).toBe(true);
    for (const bad of [0, -5, 1801, 3600, Number.POSITIVE_INFINITY, Number.NaN]) {
      expect(schema.timeout.safeParse(bad).success).toBe(false);
    }
  });

  it("rejects non-integer or over-ceiling attempts", () => {
    const schema = autorouteSchema();
    expect(schema.attempts.safeParse(1).success).toBe(true);
    expect(schema.attempts.safeParse(10).success).toBe(true);
    expect(schema.attempts.safeParse(undefined).success).toBe(true);
    for (const bad of [0, -1, 2.5, 11, 100]) {
      expect(schema.attempts.safeParse(bad).success).toBe(false);
    }
  });
});
