/**
 * Streamable HTTP transport for CDT-KiCAD network mode.
 *
 * Fork of mixelpixx/KiCAD-MCP-Server (MIT, see ATTRIBUTION.md).
 * SlncTrZ provider-shell adaptation by SlncTrZ / Truong Cong Dinh.
 *
 * Stateless per-request servers share one Python bridge owned by the
 * KiCADMcpServer instance (its internal queue already serialises Node→Python
 * traffic). MCP 2025-06-18 / SDK 1.21.0. Default endpoint POST /mcp.
 * GET /healthz is unauthenticated liveness only — never a business operation.
 */

import express, { type Express, type Request, type Response, type NextFunction } from "express";
import { isIP } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { logger } from "./logger.js";
import {
  verifyToken,
  expectedToken,
  allowUnauthenticated,
  authFailureStatus,
} from "./auth.js";
import { PROVIDER_ID, PROVIDER_VERSION, CONTRACT_VERSION } from "./provider-contract.js";

/** Builds a fully-registered MCP server sharing the running bridge. */
export type HttpServerFactory = () => McpServer;

/** True only for hostnames/addresses that cannot expose unauthenticated HTTP off-host. */
export function isLoopbackHost(host: string): boolean {
  let normalized = host.trim().toLowerCase();
  if (normalized.startsWith("[") && normalized.endsWith("]")) {
    normalized = normalized.slice(1, -1);
  }
  if (normalized === "localhost" || normalized === "::1" || normalized === "0:0:0:0:0:0:0:1") {
    return true;
  }
  if (isIP(normalized) !== 4) return false;
  return normalized.split(".", 1)[0] === "127";
}

function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const verdict = verifyToken(req.headers as Record<string, unknown>);
  if (verdict.ok) {
    next();
    return;
  }
  // Never log, echo, or differentiate the presented credential.
  logger.warn(`HTTP auth rejected on ${req.path} (reason: ${verdict.reason})`);
  res.status(authFailureStatus(verdict.reason)).json({
    error: {
      kind: verdict.reason === "forbidden" ? "authorization_error" : "authentication_error",
      retryable: false,
      message:
        verdict.reason === "missing"
          ? "Missing credentials. Send Authorization: Bearer <token> or X-API-Key: <token>."
          : "Invalid credentials.",
    },
  });
}

/**
 * Create the Express app. Throws fail-closed when network auth is not
 * configured and no explicit local-testing opt-out is set.
 */
export function createHttpApp(
  factory: HttpServerFactory,
  intendedHost = process.env.MCP_HOST?.trim() || "127.0.0.1",
): Express {
  if (!expectedToken()) {
    if (!allowUnauthenticated()) {
      throw new Error(
        "Refusing network transport without KICAD_MCP_TOKEN. " +
          "Set KICAD_MCP_TOKEN (recommended) or MCP_ALLOW_UNAUTHENTICATED=1 for local loopback testing only.",
      );
    }
    if (!isLoopbackHost(intendedHost)) {
      throw new Error(
        "MCP_ALLOW_UNAUTHENTICATED=1 is loopback-only; refusing non-loopback HTTP bind.",
      );
    }
  }

  const app = express();
  // Schematic/symbol S-expression payloads can be multi-megabyte; the STDIO
  // path has no framing limit, so HTTP must not impose a small default one.
  app.use(express.json({ limit: "25mb" }));

  app.get("/healthz", (_req: Request, res: Response) => {
    res.json({
      status: "ok",
      provider: PROVIDER_ID,
      provider_version: PROVIDER_VERSION,
      contract_version: CONTRACT_VERSION,
    });
  });

  app.post("/mcp", authMiddleware, async (req: Request, res: Response) => {
    const startedAt = Date.now();
    let server: McpServer | null = null;
    let transport: StreamableHTTPServerTransport | null = null;
    try {
      server = factory();
      transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        transport?.close().catch(() => undefined);
        server?.close().catch(() => undefined);
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      logger.debug(`POST /mcp ${res.statusCode} in ${Date.now() - startedAt}ms`);
    } catch (error) {
      logger.error(`POST /mcp failed: ${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent) {
        res.status(500).json({
          error: { kind: "internal_error", retryable: true, message: "Provider request failed." },
        });
      }
      try {
        await transport?.close();
      } catch {
        // best-effort cleanup
      }
      try {
        await server?.close();
      } catch {
        // best-effort cleanup
      }
    }
  });

  const methodNotAllowed = (_req: Request, res: Response) => {
    res.setHeader("Allow", "POST");
    res.status(405).json({
      error: {
        kind: "validation_error",
        retryable: false,
        message: "Stateless /mcp supports POST only.",
      },
    });
  };
  app.get("/mcp", authMiddleware, methodNotAllowed);
  app.delete("/mcp", authMiddleware, methodNotAllowed);

  return app;
}

/** Listen on the intended interface/port for this deployment. */
export async function listenHttp(
  factory: HttpServerFactory,
  port: number,
  host: string,
): Promise<void> {
  const app = createHttpApp(factory, host);
  await new Promise<void>((resolve) => {
    app.listen(port, host, () => {
      logger.info(`CDT-KiCAD (${PROVIDER_ID}) Streamable HTTP listening on http://${host}:${port}/mcp`);
      resolve();
    });
  });
}
