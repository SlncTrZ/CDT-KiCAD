import { afterEach, describe, expect, it } from "vitest";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import type { Express } from "express";
import { createHttpApp, isLoopbackHost } from "../src/http-transport.js";

const originalToken = process.env.KICAD_MCP_TOKEN;
const originalAllowUnauth = process.env.MCP_ALLOW_UNAUTHENTICATED;

function restoreEnv(): void {
  if (originalToken === undefined) delete process.env.KICAD_MCP_TOKEN;
  else process.env.KICAD_MCP_TOKEN = originalToken;
  if (originalAllowUnauth === undefined) delete process.env.MCP_ALLOW_UNAUTHENTICATED;
  else process.env.MCP_ALLOW_UNAUTHENTICATED = originalAllowUnauth;
}

afterEach(() => {
  restoreEnv();
});

async function getMcp(
  app: Express,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      const req = request(
        {
          host: "127.0.0.1",
          port: address.port,
          path: "/mcp",
          method: "GET",
          headers,
        },
        (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => {
            body += chunk;
          });
          res.on("end", () => {
            server.close(() => resolve({ status: res.statusCode ?? 0, body }));
          });
        },
      );
      req.on("error", (error) => {
        server.close(() => reject(error));
      });
      req.end();
    });
    server.on("error", reject);
  });
}

const unusedFactory = (() => {
  throw new Error("MCP server factory must not be called by GET /mcp auth tests");
}) as any;

describe("HTTP unauthenticated test-mode boundary", () => {
  it("recognizes IPv4 and IPv6 loopback but rejects wildcard/LAN hosts", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("127.12.34.56")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("[::1]")).toBe(true);
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
    expect(isLoopbackHost("::")).toBe(false);
    expect(isLoopbackHost("192.168.1.50")).toBe(false);
  });

  it("allows loopback + MCP_ALLOW_UNAUTHENTICATED=1 through actual HTTP auth", async () => {
    delete process.env.KICAD_MCP_TOKEN;
    process.env.MCP_ALLOW_UNAUTHENTICATED = "1";
    const response = await getMcp(createHttpApp(unusedFactory, "127.0.0.1"));
    expect(response.status).toBe(405);
  });

  it("treats ::1 as an allowed unauthenticated bind target", () => {
    delete process.env.KICAD_MCP_TOKEN;
    process.env.MCP_ALLOW_UNAUTHENTICATED = "1";
    expect(() => createHttpApp(unusedFactory, "::1")).not.toThrow();
  });

  it.each(["0.0.0.0", "::", "192.168.1.50"])(
    "refuses allowUnauth startup on non-loopback host %s",
    (host) => {
      delete process.env.KICAD_MCP_TOKEN;
      process.env.MCP_ALLOW_UNAUTHENTICATED = "1";
      expect(() => createHttpApp(unusedFactory, host)).toThrow(/loopback/i);
    },
  );

  it("allows network bind when a valid token is presented", async () => {
    process.env.KICAD_MCP_TOKEN = "test-network-token";
    delete process.env.MCP_ALLOW_UNAUTHENTICATED;
    const response = await getMcp(createHttpApp(unusedFactory, "0.0.0.0"), {
      Authorization: "Bearer test-network-token",
    });
    expect(response.status).toBe(405);
  });

  it("rejects a missing request token when allowUnauth is false", async () => {
    process.env.KICAD_MCP_TOKEN = "test-network-token";
    delete process.env.MCP_ALLOW_UNAUTHENTICATED;
    const response = await getMcp(createHttpApp(unusedFactory, "0.0.0.0"));
    expect(response.status).toBe(401);
    expect(response.body).toContain("authentication_error");
  });

  it("still refuses startup with neither token nor explicit local test mode", () => {
    delete process.env.KICAD_MCP_TOKEN;
    delete process.env.MCP_ALLOW_UNAUTHENTICATED;
    expect(() => createHttpApp(unusedFactory, "127.0.0.1")).toThrow(/KICAD_MCP_TOKEN/);
  });
});
