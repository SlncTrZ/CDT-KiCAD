/**
 * Fork of mixelpixx/KiCAD-MCP-Server (MIT, see ATTRIBUTION.md).
 * SlncTrZ provider adaptation by SlncTrZ / Truong Cong Dinh.
 *
 * KiCADRuntimePort — provider/execution seam (migration K1).
 *
 * Structural port only: it declares the boundary between the MCP provider
 * layer (tool registration, receipts, path policy) and KiCAD execution
 * (Node -> Python stdin/stdout worker, IPC/SWIG backends). Nothing is
 * redefined — implementations satisfy the SAME dispatch contract the
 * provider already uses: one command name plus JSON params in, one JSON
 * result out. PID, fingerprint, recovery, timeout and session-pinning
 * semantics stay inside the reused implementation behind this port.
 *
 * - `execute` mirrors the existing callKicadScript dispatch (read-only).
 * - `health` is read-only liveness without CAD mutation.
 * - `backend` is the controlled escape hatch to local execution detail.
 * - `generation` carries the runtime generation for cross-boundary pinning.
 */

export type RuntimeTransportKind = "local" | "remote";

export interface RuntimeExecutionOptions {
  /** Per-call deadline override in milliseconds (bounded by the transport). */
  timeoutMs?: number;
}

export interface RuntimeHealth {
  transport: RuntimeTransportKind;
  reachable: boolean;
  generation: string;
  backend?: string;
  detail?: unknown;
}

export interface KiCADRuntimePort {
  /** Which side of the boundary executes: in-process child worker or remote agent. */
  readonly transportKind: RuntimeTransportKind;

  /** Runtime generation id; restarts create a new generation. */
  readonly generation: string;

  /**
   * Execute one KiCAD command with JSON params.
   * Same contract as the existing Node -> Python dispatch: unknown commands
   * fail Python-side, timeouts stay uncertain, IPC-only capabilities on SWIG
   * return typed unsupported_capability — never fake success.
   */
  execute(
    command: string,
    params?: Record<string, unknown>,
    options?: RuntimeExecutionOptions,
  ): Promise<unknown>;

  /** Read-only liveness without CAD mutation. */
  health(): Promise<RuntimeHealth>;

  /** Release runtime resources; safe to call on an unstarted port. */
  close(): Promise<void>;
}
