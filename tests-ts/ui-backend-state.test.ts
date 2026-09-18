import { describe, expect, it } from "vitest";
import { registerUITools } from "../src/tools/ui.js";

type ToolCallback = (...args: any[]) => Promise<any>;

function registeredUiTools(callKicadScript: (command: string, args: unknown) => Promise<unknown>) {
  const callbacks = new Map<string, ToolCallback>();
  const server = {
    tool(name: string, ...rest: any[]) {
      const callback = rest.at(-1);
      if (typeof callback !== "function") {
        throw new TypeError(`Tool ${name} missing callback`);
      }
      callbacks.set(name, callback);
    },
  };

  registerUITools(server as never, callKicadScript);
  return callbacks;
}

describe("backend ownership MCP tools", () => {
  it("marks reconnect backend failures as MCP errors", async () => {
    const callbacks = registeredUiTools(async (command) => {
      expect(command).toBe("reconnect_backend");
      return {
        success: false,
        kind: "provider_unavailable",
        retryable: true,
        message: "IPC session is unavailable",
      };
    });

    const result = await callbacks.get("reconnect_backend")!();

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      success: false,
      kind: "provider_unavailable",
      retryable: true,
    });
  });

  it("marks explicit rebind conflicts as MCP errors", async () => {
    const callbacks = registeredUiTools(async (command, args) => {
      expect(command).toBe("rebind_backend_session");
      expect(args).toMatchObject({ targetBackend: "swig" });
      return {
        success: false,
        kind: "conflict",
        retryable: false,
        message: "Explicit discard confirmation required",
      };
    });

    const result = await callbacks.get("rebind_backend_session")!({
      targetBackend: "swig",
    });

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      success: false,
      kind: "conflict",
      retryable: false,
    });
  });
});
