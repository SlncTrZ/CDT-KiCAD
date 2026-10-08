/**
 * Provider-wide MCP tool contract boundary.
 *
 * All legacy server.tool() registrations pass through this adapter so the
 * provider has one strict-input and error-normalization policy instead of
 * hundreds of handler-local variants.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { formatKicadException, normalizeMcpToolResult } from "./tools/tool-response.js";

type ToolCallback = (...args: any[]) => any;

function isZodSchemaLike(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    ("_def" in value ||
      "_zod" in value ||
      ("safeParse" in value && typeof (value as { safeParse?: unknown }).safeParse === "function"))
  );
}

function isRawShape(value: unknown): value is z.ZodRawShape {
  if (typeof value !== "object" || value === null || isZodSchemaLike(value)) {
    return false;
  }

  const values = Object.values(value);
  return values.length === 0 || values.some(isZodSchemaLike);
}

function isAnnotations(value: unknown): boolean {
  return typeof value === "object" && value !== null && !isRawShape(value) && !isZodSchemaLike(value);
}

function strictInputSchema(inputSchema: unknown): unknown {
  if (inputSchema === undefined) {
    return z.object({}).strict();
  }
  if (isRawShape(inputSchema)) {
    return z.object(inputSchema).strict();
  }
  if (inputSchema instanceof z.ZodObject) {
    return inputSchema.strict();
  }
  return inputSchema;
}

function wrapToolCallback(callback: ToolCallback): ToolCallback {
  return async (...args: any[]) => {
    try {
      return normalizeMcpToolResult(await callback(...args));
    } catch (error) {
      return formatKicadException(error);
    }
  };
}

function registerLegacyTool(target: McpServer, name: string, rest: any[]): unknown {
  const args = [...rest];
  let description: string | undefined;
  let inputSchema: unknown;
  let annotations: unknown;

  if (typeof args[0] === "string") {
    description = args.shift();
  }

  if (args.length > 1) {
    const first = args[0];
    if (isRawShape(first)) {
      inputSchema = args.shift();
      if (args.length > 1 && isAnnotations(args[0])) {
        annotations = args.shift();
      }
    } else if (isAnnotations(first)) {
      annotations = args.shift();
    }
  }

  const callback = args[0];
  if (typeof callback !== "function") {
    throw new TypeError(`Tool ${name} is missing a callback`);
  }

  return target.registerTool(
    name,
    {
      description,
      inputSchema: strictInputSchema(inputSchema) as any,
      ...(annotations ? { annotations: annotations as any } : {}),
    },
    wrapToolCallback(callback) as any,
  );
}

export function createContractToolTarget(target: McpServer): McpServer {
  const tool = (name: string, ...rest: any[]) => registerLegacyTool(target, name, rest);

  const registerTool = (name: string, config: Record<string, any>, callback: ToolCallback) =>
    target.registerTool(
      name,
      {
        ...config,
        inputSchema: strictInputSchema(config.inputSchema) as any,
      },
      wrapToolCallback(callback) as any,
    );

  return new Proxy(target, {
    get(object, property) {
      if (property === "tool") return tool;
      if (property === "registerTool") return registerTool;

      const value = Reflect.get(object, property, object);
      return typeof value === "function" ? value.bind(object) : value;
    },
  }) as McpServer;
}
