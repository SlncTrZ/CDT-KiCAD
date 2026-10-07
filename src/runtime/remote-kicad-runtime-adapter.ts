/**
 * Fork of mixelpixx/KiCAD-MCP-Server (MIT, see ATTRIBUTION.md).
 * SlncTrZ provider adaptation by SlncTrZ / Truong Cong Dinh.
 *
 * RemoteKiCADRuntimeAdapter — provider-side adapter over RuntimeTransport (K2).
 *
 * Reuses the execution implementation WITHOUT duplication: the workstation
 * agent owns the local execution core in its process, and this class only
 * forwards typed command names + JSON params over the transport boundary.
 * No CAD validation, PID, fingerprint, recovery, interpreter probing or
 * native logic lives here — unknown completion, generation and fencing
 * flow through the same typed errors as the local path.
 *
 * CONSTRAINT: this module must never import the discovery module, probe
 * host install directories, or launch a worker process. A remote provider
 * has no local KiCad to discover; enforced by
 * tests-ts/runtime-remote-adapter.test.ts. Mutation fencing stays
 * provider-side (operation receipts in server.ts); reads and writes alike
 * travel the transport, and timeout-after-dispatch stays uncertain where
 * it was uncertain before.
 */

import type {
  KiCADRuntimePort,
  RuntimeHealth,
  RuntimeTransportKind,
} from "./kicad-runtime-port.js";
import {
  RuntimeGenerationMismatchError,
  type RuntimeTransport,
} from "./runtime-transport.js";

export class RemoteKiCADRuntimeAdapter implements KiCADRuntimePort {
  readonly transportKind: RuntimeTransportKind = "remote";

  private expectedGeneration: string | null;

  private readonly transport: RuntimeTransport;

  private readonly defaultDeadlineMs?: number;

  constructor(
    transport: RuntimeTransport,
    options: { expectedGeneration?: string; defaultDeadlineMs?: number } = {},
  ) {
    if (!transport || typeof transport.call !== "function") {
      throw new TypeError("RemoteKiCADRuntimeAdapter requires a RuntimeTransport");
    }
    if (transport.kind !== "remote") {
      throw new TypeError("RemoteKiCADRuntimeAdapter requires a remote RuntimeTransport (use LocalRuntimeTransport for in-process ports)");
    }
    const pinned = String(options.expectedGeneration ?? "").trim();
    this.expectedGeneration = pinned || null;
    this.transport = transport;
    this.defaultDeadlineMs = options.defaultDeadlineMs;
  }

  get generation(): string {
    return this.expectedGeneration ?? "unpinned-remote";
  }

  /** Pin the expected runtime generation; stale generations refuse before trusting results. */
  pinGeneration(generation: string): void {
    const value = String(generation ?? "").trim();
    if (!value) throw new Error("generation pin must be non-empty");
    this.expectedGeneration = value;
  }

  async execute(command: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const op = String(command ?? "").trim();
    if (!op) throw new Error("KiCAD remote runtime execute refused: empty command");
    try {
      return await this.transport.call(op, params ?? {}, {
        ...(this.defaultDeadlineMs === undefined ? {} : { deadlineMs: this.defaultDeadlineMs }),
        ...(this.expectedGeneration === null ? {} : { expectedGeneration: this.expectedGeneration }),
      });
    } catch (error) {
      if (error instanceof RuntimeGenerationMismatchError) {
        // Keep the pin: a stale generation must stay refused until the
        // operator reconciles and re-pins explicitly.
        throw error;
      }
      throw error;
    }
  }

  async health(): Promise<RuntimeHealth> {
    const agent = await this.transport.health();
    const detail = agent as Record<string, unknown>;
    const generation =
      typeof detail["agent_generation"] === "string"
        ? (detail["agent_generation"] as string)
        : typeof detail["generation"] === "string"
          ? (detail["generation"] as string)
          : this.generation;
    if (this.expectedGeneration !== null && generation !== this.expectedGeneration) {
      throw new RuntimeGenerationMismatchError(
        `runtime generation mismatch: expected ${JSON.stringify(this.expectedGeneration)}, ` +
          `got ${JSON.stringify(generation)}; result discarded`,
      );
    }
    return {
      transport: "remote",
      reachable: true,
      generation,
      detail: agent,
    };
  }

  async close(): Promise<void> {
    await this.transport.close();
  }
}
