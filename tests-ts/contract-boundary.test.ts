import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { KiCADMcpServer } from "../src/server.js";
import { createContractToolTarget } from "../src/tool-contract-boundary.js";

const pythonBridge = fileURLToPath(new URL("../python/kicad_interface.py", import.meta.url));

function registeredTools(server: McpServer): Record<string, any> {
  return (server as any)._registeredTools;
}

function expectedRegisteredToolCount(): number {
  const inventory = readFileSync(
    fileURLToPath(new URL("../docs/TOOL_INVENTORY.md", import.meta.url)),
    "utf8",
  );
  const match = inventory.match(/\*\*Tools registered on the server:\*\*\s+(\d+)/);
  if (!match) throw new Error("Generated tool inventory is missing the registered-tool count");
  return Number(match[1]);
}

function collectNonStrictObjects(
  schema: any,
  path: string,
  issues: string[],
  seen = new Set<unknown>(),
): void {
  if (typeof schema !== "object" || schema === null || seen.has(schema)) return;
  seen.add(schema);

  const definition = schema._def;
  if (!definition || typeof definition !== "object") return;

  if (definition.typeName === "ZodObject") {
    if (definition.unknownKeys !== "strict") issues.push(path);

    const shape = typeof definition.shape === "function" ? definition.shape() : definition.shape;
    if (shape && typeof shape === "object") {
      for (const [key, child] of Object.entries(shape)) {
        collectNonStrictObjects(child, `${path}.${key}`, issues, seen);
      }
    }
  }

  for (const [key, child] of Object.entries(definition)) {
    if (key === "shape") continue;
    if (Array.isArray(child)) {
      child.forEach((item, index) =>
        collectNonStrictObjects(item, `${path}.${key}[${index}]`, issues, seen),
      );
    } else if (child instanceof Map) {
      for (const [mapKey, item] of child.entries()) {
        collectNonStrictObjects(item, `${path}.${key}.${String(mapKey)}`, issues, seen);
      }
    } else if (typeof child === "object" && child !== null && "_def" in child) {
      collectNonStrictObjects(child, `${path}.${key}`, issues, seen);
    }
  }
}

describe("provider tool contract boundary", () => {
  it("registers every tool with a strict object input schema", () => {
    const host = new KiCADMcpServer(pythonBridge, "error");
    const target = new McpServer({ name: "test-kicad", version: "0.0.0" });

    host.registerAllOn(target);

    const tools = registeredTools(target);
    expect(Object.keys(tools)).toHaveLength(expectedRegisteredToolCount());

    const nonStrict: string[] = [];
    for (const [name, tool] of Object.entries(tools)) {
      collectNonStrictObjects(tool.inputSchema, name, nonStrict);
    }

    expect(nonStrict).toEqual([]);

    const createProjectSchema = tools.create_project.inputSchema;
    expect(createProjectSchema.safeParse({ name: "demo", unexpected: true }).success).toBe(false);

    const digikeySchema = tools.digikey_search_parts.inputSchema;
    expect(
      digikeySchema.safeParse({
        keywords: "fixture",
        locale: { site: "US", unexpected: true },
      }).success,
    ).toBe(false);
  });

  it.each([
    ["create_project", { name: "demo" }],
    ["set_board_size", { width: 100, height: 80 }],
    [
      "move_component",
      { reference: "R1", position: { x: 10, y: 20, unit: "mm" } },
    ],
    ["create_schematic", { name: "demo" }],
    [
      "route_trace",
      {
        start: { x: 0, y: 0, unit: "mm" },
        end: { x: 10, y: 10, unit: "mm" },
        layer: "F.Cu",
        width: 0.25,
        net: "N1",
      },
    ],
    ["run_drc", {}],
    ["export_gerbers", { boardPath: "demo.kicad_pcb", outputDir: "out" }],
    ["list_libraries", {}],
  ])("turns backend failure into an MCP error for %s", async (toolName, args) => {
    const host = new KiCADMcpServer(pythonBridge, "error") as any;
    host.callKicadScript = vi.fn().mockResolvedValue({
      success: false,
      kind: "validation_error",
      retryable: false,
      message: "invalid fixture",
      errorDetails: "fixture detail",
    });

    const target = new McpServer({ name: "test-kicad", version: "0.0.0" });
    host.registerAllOn(target);

    const tool = registeredTools(target)[toolName];
    expect(tool, `expected registered tool ${toolName}`).toBeDefined();

    const result = await tool.handler(args, {});
    expect(result.isError).toBe(true);

    const payload = JSON.parse(result.content[0].text);
    expect(payload).toMatchObject({
      success: false,
      kind: "validation_error",
      retryable: false,
      message: "invalid fixture",
    });
  });

  it("keeps successful direct tool payloads unchanged", async () => {
    const target = new McpServer({ name: "test-kicad", version: "0.0.0" });
    const boundary = createContractToolTarget(target);
    const expected = {
      content: [{ type: "text" as const, text: JSON.stringify({ success: true, value: 42 }) }],
    };

    boundary.tool("local_success", "fixture", {}, async () => expected);

    await expect(registeredTools(target).local_success.handler({}, {})).resolves.toEqual(expected);
  });

  it("normalizes direct tool errors that do not use the Python bridge", async () => {
    const target = new McpServer({ name: "test-kicad", version: "0.0.0" });
    const boundary = createContractToolTarget(target);

    boundary.tool("local_failure", "fixture", {}, async () => ({
      content: [{ type: "text" as const, text: "registry unavailable" }],
      isError: true as const,
    }));

    const result = await registeredTools(target).local_failure.handler({}, {});
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toEqual({
      success: false,
      kind: "internal_error",
      retryable: false,
      message: "registry unavailable",
    });
  });

  it("classifies direct registry validation failures precisely", async () => {
    const host = new KiCADMcpServer(pythonBridge, "error");
    const target = new McpServer({ name: "test-kicad", version: "0.0.0" });

    host.registerAllOn(target);

    const result = await registeredTools(target).download_registry_part.handler(
      {
        id: "fixture",
        format: "kicad_mod",
        dest_dir: join(process.cwd(), "__missing_registry_validation_dir__"),
      },
      {},
    );

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      success: false,
      kind: "validation_error",
      retryable: false,
    });
  });
});
