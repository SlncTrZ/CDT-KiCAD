import { afterEach, describe, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";
import {
  KiCADMcpServer,
  MAX_BRIDGE_BUFFER_BYTES,
  MAX_BRIDGE_LINE_BYTES,
} from "../src/server.js";

const pythonBridge = fileURLToPath(new URL("../python/kicad_interface.py", import.meta.url));

afterEach(() => {
  vi.useRealTimers();
});

// A pending bridge request with the fields the metric path needs, so the
// fail-closed aborts below also exercise metric emission.
function pendingServer() {
  vi.useFakeTimers();
  const server = new KiCADMcpServer(pythonBridge, "error") as any;
  const resolve = vi.fn();
  const reject = vi.fn();
  server.processingRequest = true;
  server.currentRequestHandler = {
    requestId: 9,
    command: "get_board_info",
    enqueuedAtMs: 1000,
    startedAtMs: 1100,
    resolve,
    reject,
    timeoutHandle: setTimeout(() => undefined, 30_000),
  };
  return { server, resolve, reject };
}

describe("Python bridge response caps (fail-closed)", () => {
  it("fails the pending request with a clear code when one frame exceeds the line cap", () => {
    const { server, resolve, reject } = pendingServer();
    const pad = "y".repeat(MAX_BRIDGE_LINE_BYTES); // well past the cap either way
    server.responseBuffer =
      `${JSON.stringify({ success: true, _requestId: 9, pad })}\n` +
      `${JSON.stringify({ success: true, value: "orphan-after-abort", _requestId: 9 })}\n`;

    server.tryParseResponse();

    expect(resolve).not.toHaveBeenCalled();
    expect(reject).toHaveBeenCalledOnce();
    expect(reject.mock.calls[0][0].toJSON().details).toMatchObject({
      code: "BRIDGE_RESPONSE_LINE_TOO_LONG",
    });
    // The abort drops the pending request, so the frame behind it is an
    // orphan and must be discarded, never delivered.
    expect(server.currentRequestHandler).toBeNull();
    expect(server.processingRequest).toBe(false);
    expect(server.responseBuffer).toBe("");
  });

  it("accepts a frame at exactly the line cap", () => {
    const { server, resolve, reject } = pendingServer();
    const prefix = '{"success":true,"_requestId":9,"pad":"';
    const suffix = '"}';
    const pad = "x".repeat(MAX_BRIDGE_LINE_BYTES - prefix.length - suffix.length);
    server.responseBuffer = `${prefix}${pad}${suffix}\n`;

    server.tryParseResponse();

    expect(reject).not.toHaveBeenCalled();
    expect(resolve).toHaveBeenCalledOnce();
    expect(server.responseBuffer).toBe("");
  });

  it("fails the pending request with a clear code when the buffer overflows without a frame", () => {
    const { server, resolve, reject } = pendingServer();
    server.handlePythonResponse(Buffer.from("a".repeat(40 * 1024 * 1024)));
    expect(reject).not.toHaveBeenCalled(); // no complete frame yet — keep collecting

    server.handlePythonResponse(Buffer.from("b".repeat(30 * 1024 * 1024)));

    expect(resolve).not.toHaveBeenCalled();
    expect(reject).toHaveBeenCalledOnce();
    expect(reject.mock.calls[0][0].toJSON().details).toMatchObject({
      code: "BRIDGE_RESPONSE_BUFFER_OVERFLOW",
      cap_chars: MAX_BRIDGE_BUFFER_BYTES,
    });
    expect(server.responseBuffer).toBe("");
    expect(server.processingRequest).toBe(false);
  });
});
