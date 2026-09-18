import { describe, it, expect } from "vitest";
import {
  canonicalizeKicadFailure,
  formatKicadResult,
} from "../src/tools/tool-response.js";

describe("formatKicadResult", () => {
  it("wraps a successful object result as JSON text content", () => {
    const response = formatKicadResult({ success: true, value: 42 });
    expect(response.content).toEqual([
      { type: "text", text: JSON.stringify({ success: true, value: 42 }) },
    ]);
    expect(response.isError).toBeUndefined();
  });

  it("flags isError when the KiCAD payload reports success=false", () => {
    const response = formatKicadResult({ success: false, error: "boom" });
    expect(response.isError).toBe(true);
    expect(response.content[0].text).toBe(JSON.stringify({ success: false, error: "boom" }));
  });

  it("does not flag isError for payloads without a success field", () => {
    const response = formatKicadResult({ data: [1, 2, 3] });
    expect(response.isError).toBeUndefined();
  });

  it("does not flag isError for success=true", () => {
    const response = formatKicadResult({ success: true });
    expect(response.isError).toBeUndefined();
  });

  it("does not flag isError when success is a truthy non-false value", () => {
    const response = formatKicadResult({ success: "ok" });
    expect(response.isError).toBeUndefined();
  });

  it("handles string results", () => {
    const response = formatKicadResult("hello");
    expect(response.content[0].text).toBe(JSON.stringify("hello"));
    expect(response.isError).toBeUndefined();
  });

  it("handles null without throwing", () => {
    const response = formatKicadResult(null);
    expect(response.content[0].type).toBe("text");
    expect(response.isError).toBeUndefined();
  });

  it("sanitizes Python sys.path and nested diagnostic details", () => {
    const failure = canonicalizeKicadFailure({
      success: false,
      kind: "internal_error",
      message: "backend failed",
      errorDetails:
        "Import failed\n\nPython sys.path:\n/mnt/pc-dev/CDT-KiCAD/python\n/usr/lib/python3.12",
      details: {
        diagnostic:
          'Traceback (most recent call last):\n  File "/mnt/pc-dev/CDT-KiCAD/python/kicad_interface.py", line 42\nRuntimeError: boom',
      },
    });

    expect(failure.errorDetails).toBe("Import failed");
    expect(failure.details).toEqual({ diagnostic: "RuntimeError: boom" });
    expect(JSON.stringify(failure)).not.toContain("/mnt/pc-dev");
    expect(JSON.stringify(failure)).not.toContain("Traceback");
  });
});
