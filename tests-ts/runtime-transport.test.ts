/**
 * Fork of mixelpixx/KiCAD-MCP-Server (MIT, see ATTRIBUTION.md).
 * SlncTrZ provider adaptation by SlncTrZ / Truong Cong Dinh.
 *
 * K2 parity: RuntimeTransport Local|Remote. Local stays behavior-identical;
 * remote proves the split-process path over authenticated loopback HTTP with
 * bounded deadlines, size caps, generation checks and uncertain timeouts.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { describe, expect, it } from "vitest";
import { LocalKiCADRuntimeAdapter } from "../src/runtime/local-kicad-runtime-adapter.js";
import {
  bearerMatches,
  LocalRuntimeTransport,
  RemoteRuntimeTransport,
  RuntimeAuthError,
  RuntimeGenerationMismatchError,
  RuntimeOpRefusedError,
  RuntimeUncertainError,
  RuntimeUnavailableError,
} from "../src/runtime/runtime-transport.js";

function fakePort(executor: (command: string, params: Record<string, unknown>) => Promise<unknown>) {
  return new LocalKiCADRuntimeAdapter(executor);
}

describe("K2 local runtime transport", () => {
  it("delegates calls 1:1 and reports port health", async () => {
    const transport = new LocalRuntimeTransport(fakePort(async (command) => ({ echo: command })));
    await expect(transport.call("get_backend_state", {})).resolves.toEqual({ echo: "get_backend_state" });
    const health = await transport.health();
    expect(health).toMatchObject({ transport: "local", reachable: true, generation: "local" });
  });

  it("refuses stale generations and closed transports before dispatch", async () => {
    let dispatched = 0;
    const transport = new LocalRuntimeTransport(
      fakePort(async () => {
        dispatched += 1;
        return {};
      }),
    );
    await expect(
      transport.call("get_backend_state", {}, { expectedGeneration: "stale-gen" }),
    ).rejects.toBeInstanceOf(RuntimeGenerationMismatchError);
    expect(dispatched).toBe(0);
    await expect(
      transport.call("get_backend_state", {}, { expectedGeneration: "local" }),
    ).resolves.toEqual({});
    await transport.close();
    await expect(transport.call("get_backend_state")).rejects.toBeInstanceOf(RuntimeUnavailableError);
    await expect(transport.health()).rejects.toBeInstanceOf(RuntimeUnavailableError);
  });

  it("refuses empty commands without dispatch", async () => {
    const transport = new LocalRuntimeTransport(fakePort(async () => ({})));
    await expect(transport.call("  ")).rejects.toBeInstanceOf(RuntimeOpRefusedError);
  });
});

describe("K2 remote runtime transport guards", () => {
  it("requires a token and refuses non-loopback endpoints", () => {
    expect(() => new RemoteRuntimeTransport("http://127.0.0.1:9", "")).toThrow(/auth_token/);
    expect(() => new RemoteRuntimeTransport("http://192.168.1.227:3100", "secret")).toThrow(
      /non-loopback/,
    );
    expect(
      new RemoteRuntimeTransport("http://127.0.0.1:9", "secret").toJSON(),
    ).toMatchObject({ kind: "remote", auth: "<redacted>" });
  });

  it("refuses bad ops, deadlines and oversized requests before I/O", async () => {
    const transport = new RemoteRuntimeTransport("http://127.0.0.1:9", "secret");
    await expect(transport.call("")).rejects.toBeInstanceOf(RuntimeOpRefusedError);
    await expect(transport.call("x", {}, { deadlineMs: 1 })).rejects.toBeInstanceOf(RuntimeOpRefusedError);
    await expect(
      transport.call("x", { blob: "y".repeat(300 * 1024) }),
    ).rejects.toBeInstanceOf(RuntimeOpRefusedError);
  });

  it("compares bearers in constant time and never matches an empty expected token", () => {
    expect(bearerMatches("secret", "secret")).toBe(true);
    expect(bearerMatches("secret", "other")).toBe(false);
    expect(bearerMatches("secret", "")).toBe(false);
    expect(bearerMatches("", "")).toBe(false);
  });
});

describe("K2 remote runtime transport over loopback stub", () => {
  async function withStub(
    handler: (request: IncomingMessage, response: ServerResponse, body: string) => void,
    work: (baseUrl: string) => Promise<void>,
  ): Promise<void> {
    const server = createServer((request: IncomingMessage, response: ServerResponse) => {
      let body = "";
      request.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      request.on("end", () => handler(request, response, body));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    try {
      await work(`http://127.0.0.1:${port}`);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  function json(response: ServerResponse, status: number, payload: unknown): void {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(payload));
  }

  it("round-trips a successful dispatch and health", async () => {
    await withStub(
      (request, response, body) => {
        if (request.url === "/health") {
          json(response, 200, { ok: true, result: { reachable: true }, generation: "gen-1" });
          return;
        }
        const wire = JSON.parse(body) as { op: string };
        json(response, 200, { ok: true, result: { echo: wire.op }, generation: "gen-1" });
      },
      async (baseUrl) => {
        const transport = new RemoteRuntimeTransport(baseUrl, "secret");
        await expect(transport.call("get_backend_state")).resolves.toEqual({ echo: "get_backend_state" });
        await expect(transport.health()).resolves.toMatchObject({ reachable: true });
      },
    );
  });

  it("maps 401 to auth error and stale generation to mismatch", async () => {
    await withStub(
      (request, response) => {
        if (request.headers["authorization"] !== "Bearer secret") {
          json(response, 401, { ok: false });
          return;
        }
        json(response, 200, { ok: true, result: {}, generation: "gen-2" });
      },
      async (baseUrl) => {
        const badCreds = new RemoteRuntimeTransport(baseUrl, "wrong");
        await expect(badCreds.call("get_backend_state")).rejects.toBeInstanceOf(RuntimeAuthError);
        const pinned = new RemoteRuntimeTransport(baseUrl, "secret");
        await expect(
          pinned.call("get_backend_state", {}, { expectedGeneration: "gen-1" }),
        ).rejects.toBeInstanceOf(RuntimeGenerationMismatchError);
        await expect(
          pinned.call("get_backend_state", {}, { expectedGeneration: "gen-2" }),
        ).resolves.toEqual({});
      },
    );
  });

  it("treats timeout and 5xx after dispatch as uncertain (no blind replay)", async () => {
    await withStub(
      () => {
        // Never answers: the client deadline fires after dispatch started.
      },
      async (baseUrl) => {
        const transport = new RemoteRuntimeTransport(baseUrl, "secret", { defaultDeadlineMs: 200 });
        const failure = await transport.call("move_component").catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(RuntimeUncertainError);
        const payload = JSON.parse((failure as Error).message) as Record<string, unknown>;
        expect(payload).toMatchObject({ success: false, kind: "timeout", retryable: false });
        expect(payload["details"]).toMatchObject({ completion_unknown: true });
      },
    );
    await withStub(
      (_request, response) => json(response, 500, { ok: false }),
      async (baseUrl) => {
        const transport = new RemoteRuntimeTransport(baseUrl, "secret");
        await expect(transport.call("move_component")).rejects.toBeInstanceOf(RuntimeUncertainError);
      },
    );
  });


  it("refuses multibyte requests by UTF-8 bytes before dispatch", async () => {
    let dispatches = 0;
    await withStub(
      (_request, response) => {
        dispatches += 1;
        json(response, 200, { ok: true, result: {}, generation: "g1" });
      },
      async (baseUrl) => {
        const transport = new RemoteRuntimeTransport(baseUrl, "secret");
        await expect(transport.call("move_component", { text: "汉".repeat(100_000) }))
          .rejects.toBeInstanceOf(RuntimeOpRefusedError);
        expect(dispatches).toBe(0);
      },
    );
  });

  it.each([undefined, null, "", 9, false, "other"])(
    "rejects unbound success generation %s without changing the pin",
    async (generation) => {
      let dispatches = 0;
      await withStub(
        (_request, response, body) => {
          dispatches += 1;
          expect(JSON.parse(body).expected_generation).toBe("g1");
          json(response, 200, { ok: true, result: { committed: true }, generation });
        },
        async (baseUrl) => {
          const transport = new RemoteRuntimeTransport(baseUrl, "secret");
          const error = await transport.call("move_component", {}, { expectedGeneration: "g1" })
            .catch((failure: unknown) => failure);
          expect(error).toBeInstanceOf(RuntimeGenerationMismatchError);
          expect(error).toMatchObject({ retryable: false, details: { completion_unknown: true } });
          expect(dispatches).toBe(1);
        },
      );
    },
  );

  it.each(["{", "null", "[]", "{}", '{"ok":"true","result":{}}'])(
    "reports malformed post-dispatch envelope %s as uncertain",
    async (raw) => {
      await withStub(
        (_request, response) => { response.writeHead(200); response.end(raw); },
        async (baseUrl) => {
          const transport = new RemoteRuntimeTransport(baseUrl, "secret");
          await expect(transport.call("move_component")).rejects.toBeInstanceOf(RuntimeUncertainError);
        },
      );
    },
  );

  it("enforces UTF-8 byte limit on responses, rejecting responses that exceed 4 MiB", async () => {
    // 2.5 million 2-byte characters: 2.5M chars (< 4M char cap) but 5.0 MiB UTF-8 (> 4 MiB byte cap)
    const multibytePayload = "é".repeat(2_500_000);
    await withStub(
      (_request, response) => {
        const raw = JSON.stringify({ ok: true, result: multibytePayload });
        const bytes = Buffer.byteLength(raw, "utf-8");
        response.writeHead(200, {
          "content-type": "application/json",
          "content-length": String(bytes),
        });
        response.end(raw);
      },
      async (baseUrl) => {
        const transport = new RemoteRuntimeTransport(baseUrl, "secret");
        await expect(transport.call("get_backend_state")).rejects.toMatchObject({
          message: expect.stringContaining("TRANSPORT_RESPONSE_TOO_LARGE"),
        });
      },
    );
  });
});
