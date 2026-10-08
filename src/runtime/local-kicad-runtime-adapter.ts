/**
 * Fork of mixelpixx/KiCAD-MCP-Server (MIT, see ATTRIBUTION.md).
 * SlncTrZ provider adaptation by SlncTrZ / Truong Cong Dinh.
 *
 * LocalKiCADRuntimeAdapter — K1 seam over the existing local worker (K2: also
 * the execution core reused by the workstation agent).
 *
 * Single-host adapter: 1:1 delegation over the current Node -> Python
 * child-process dispatch. Transport stays provider-local: the injected
 * `dispatch` callback owns spawn/queue/correlation/timeouts exactly as
 * before — this class creates no transport of its own and never retries
 * dispatch deadlines. Unknown commands, timeout uncertainty, session
 * pinning and IPC/SWIG capability honesty flow through unchanged.
 */

import {
  type KiCADRuntimePort,
  type RuntimeExecutionOptions,
  type RuntimeHealth,
  type RuntimeTransportKind,
} from "./kicad-runtime-port.js";

export type LocalDispatchFn = (
  command: string,
  params: Record<string, unknown>,
  options?: RuntimeExecutionOptions,
) => Promise<unknown>;

export interface LocalAdapterHooks {
  /** Read-only backend label (e.g. from get_backend_state); never throws. */
  healthBackend?: () => Promise<string | undefined>;
  /** Release worker resources; defaults to a no-op. */
  onClose?: () => Promise<void> | void;
}

export class LocalKiCADRuntimeAdapter implements KiCADRuntimePort {
  readonly transportKind: RuntimeTransportKind = "local";

  readonly generation: string;

  private readonly dispatch: LocalDispatchFn;

  private readonly hooks: LocalAdapterHooks;

  private closed = false;

  constructor(dispatch: LocalDispatchFn, hooks: LocalAdapterHooks = {}, generation = "local") {
    if (typeof dispatch !== "function") {
      throw new TypeError("LocalKiCADRuntimeAdapter requires a dispatch function");
    }
    const pinned = String(generation ?? "").trim();
    if (!pinned) throw new Error("LocalKiCADRuntimeAdapter requires a non-empty generation");
    this.dispatch = dispatch;
    this.hooks = hooks;
    this.generation = pinned;
  }

  async execute(
    command: string,
    params: Record<string, unknown> = {},
    options?: RuntimeExecutionOptions,
  ): Promise<unknown> {
    const name = String(command ?? "").trim();
    if (!name) throw new Error("KiCAD runtime execute refused: empty command");
    if (this.closed) throw new Error("KiCAD local runtime is closed");
    return this.dispatch(name, params ?? {}, options);
  }

  async health(): Promise<RuntimeHealth> {
    let backend: string | undefined;
    try {
      backend = this.hooks.healthBackend ? await this.hooks.healthBackend() : undefined;
    } catch {
      backend = undefined;
    }
    return {
      transport: "local",
      reachable: !this.closed,
      generation: this.generation,
      ...(backend === undefined ? {} : { backend }),
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.hooks.onClose?.();
  }
}
