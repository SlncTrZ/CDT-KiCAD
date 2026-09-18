/**
 * CDT-KiCAD release acceptance primitives.
 *
 * Fork of mixelpixx/KiCAD-MCP-Server (MIT, see ATTRIBUTION.md).
 * SlncTrZ release-proof adaptation by SlncTrZ / Truong Cong Dinh.
 *
 * This module prepares evidence collection only. It does not claim native
 * certification; the native fixtures must be executed on the final integration
 * HEAD with the target KiCAD build before a release can be certified.
 */

import { createHash } from "crypto";
import { readFileSync } from "fs";
import { join, resolve } from "path";

export const RELEASE_SCORE_THRESHOLD = 95;

export interface ReleaseFixtureStep {
  id: string;
  phase:
    | "project"
    | "schematic"
    | "connectivity"
    | "board-sync"
    | "placement"
    | "routing"
    | "validation"
    | "persistence"
    | "read-back"
    | "export";
  tool: string;
  arguments: Record<string, unknown>;
  evidence: string[];
}

export interface NativeVerticalSliceFixture {
  id: "native-vertical-slice";
  disposable: true;
  workspaceRoot: string;
  projectName: string;
  projectPath: string;
  schematicPath: string;
  boardPath: string;
  environmentRequirements: {
    footprintLibraries: Array<{
      nickname: string;
      footprint: string;
      requirement: string;
    }>;
  };
  steps: ReleaseFixtureStep[];
  artifactsToHash: string[];
  artifactRootsToHash: string[];
}

export function buildNativeVerticalSliceFixture(
  workspaceRoot: string,
  projectName = "release_probe",
): NativeVerticalSliceFixture {
  const root = resolve(workspaceRoot);
  const base = join(root, projectName);
  const projectPath = `${base}.kicad_pro`;
  const schematicPath = `${base}.kicad_sch`;
  const boardPath = `${base}.kicad_pcb`;
  const fabricationDir = join(root, "fabrication");
  const drillDir = join(root, "drill");
  const bomPath = join(root, "bom.csv");
  const placementPath = join(root, "placement.csv");

  const steps: ReleaseFixtureStep[] = [
    {
      id: "create-project",
      phase: "project",
      tool: "create_project",
      arguments: { path: root, name: projectName },
      evidence: ["successful tool result", "project/schematic/board files exist"],
    },
    {
      id: "add-r1",
      phase: "schematic",
      tool: "add_schematic_component",
      arguments: {
        schematicPath,
        symbol: "Device:R",
        reference: "R1",
        value: "1k",
        footprint: "Resistor_SMD:R_0603_1608Metric",
        position: { x: 100, y: 100 },
      },
      evidence: ["R1 is present with requested footprint"],
    },
    {
      id: "add-r2",
      phase: "schematic",
      tool: "add_schematic_component",
      arguments: {
        schematicPath,
        symbol: "Device:R",
        reference: "R2",
        value: "1k",
        footprint: "Resistor_SMD:R_0603_1608Metric",
        position: { x: 120, y: 100 },
      },
      evidence: ["R2 is present with requested footprint"],
    },
    {
      id: "connect-r1-signal",
      phase: "connectivity",
      tool: "connect_to_net",
      arguments: { schematicPath, componentRef: "R1", pinName: "1", netName: "SIG" },
      evidence: ["R1 pin 1 resolves to SIG"],
    },
    {
      id: "connect-r2-signal",
      phase: "connectivity",
      tool: "connect_to_net",
      arguments: { schematicPath, componentRef: "R2", pinName: "1", netName: "SIG" },
      evidence: ["R2 pin 1 resolves to SIG"],
    },
    {
      id: "connect-r1-return",
      phase: "connectivity",
      tool: "connect_to_net",
      arguments: { schematicPath, componentRef: "R1", pinName: "2", netName: "RET" },
      evidence: ["R1 pin 2 resolves to RET"],
    },
    {
      id: "connect-r2-return",
      phase: "connectivity",
      tool: "connect_to_net",
      arguments: { schematicPath, componentRef: "R2", pinName: "2", netName: "RET" },
      evidence: ["R2 pin 2 resolves to RET"],
    },
    {
      id: "connectivity-read",
      phase: "connectivity",
      tool: "generate_netlist",
      arguments: { schematicPath },
      evidence: ["SIG contains R1.1 and R2.1", "RET contains R1.2 and R2.2"],
    },
    {
      id: "sync-board",
      phase: "board-sync",
      tool: "sync_schematic_to_board",
      arguments: { schematicPath, boardPath },
      evidence: ["R1/R2 footprints exist on board", "SIG/RET pad nets exist"],
    },
    {
      id: "place-r1",
      phase: "placement",
      tool: "move_component",
      arguments: {
        reference: "R1",
        position: { x: 20, y: 20, unit: "mm" },
        rotation: 0,
      },
      evidence: ["R1 position reads back as 20 mm, 20 mm"],
    },
    {
      id: "place-r2",
      phase: "placement",
      tool: "move_component",
      arguments: {
        reference: "R2",
        position: { x: 35, y: 20, unit: "mm" },
        rotation: 0,
      },
      evidence: ["R2 position reads back as 35 mm, 20 mm"],
    },
    {
      id: "route-signal",
      phase: "routing",
      tool: "route_pad_to_pad",
      arguments: { fromRef: "R1", fromPad: "1", toRef: "R2", toPad: "1", width: 0.25 },
      evidence: ["route result succeeds", "SIG gains copper connection"],
    },
    {
      id: "erc",
      phase: "validation",
      tool: "run_erc",
      arguments: { schematicPath },
      evidence: ["ERC command completes", "violation counts captured verbatim"],
    },
    {
      id: "drc",
      phase: "validation",
      tool: "run_drc",
      arguments: {},
      evidence: ["DRC command completes", "violation counts captured verbatim"],
    },
    {
      id: "save",
      phase: "persistence",
      tool: "save_project",
      arguments: {},
      evidence: ["save succeeds without force override"],
    },
    {
      id: "close",
      phase: "persistence",
      tool: "close_project",
      arguments: { save: true },
      evidence: ["session closes cleanly"],
    },
    {
      id: "reopen",
      phase: "read-back",
      tool: "open_project",
      arguments: { filename: projectPath },
      evidence: ["project reopens from disk"],
    },
    {
      id: "connectivity-read-back",
      phase: "read-back",
      tool: "generate_netlist",
      arguments: { schematicPath },
      evidence: ["SIG/RET connectivity matches the pre-close snapshot"],
    },
    {
      id: "board-read-back",
      phase: "read-back",
      tool: "get_board_info",
      arguments: {},
      evidence: ["board loads with expected footprints/layers"],
    },
    {
      id: "export-gerber",
      phase: "export",
      tool: "export_gerber",
      arguments: { outputDir: fabricationDir, generateDrillFiles: false },
      evidence: ["Gerber export succeeds", "all emitted files are hashed"],
    },
    {
      id: "export-drill",
      phase: "export",
      tool: "export_drill",
      arguments: { outputDir: drillDir, boardPath },
      evidence: ["drill export succeeds", "all emitted files are hashed"],
    },
    {
      id: "export-bom",
      phase: "export",
      tool: "export_bom",
      arguments: { outputPath: bomPath, format: "CSV" },
      evidence: ["BOM exists and is hashed"],
    },
    {
      id: "export-placement",
      phase: "export",
      tool: "export_position_file",
      arguments: { outputPath: placementPath, format: "CSV", units: "mm", side: "both" },
      evidence: ["placement export exists and is hashed"],
    },
  ];

  return {
    id: "native-vertical-slice",
    disposable: true,
    workspaceRoot: root,
    projectName,
    projectPath,
    schematicPath,
    boardPath,
    environmentRequirements: {
      footprintLibraries: [
        {
          nickname: "Resistor_SMD",
          footprint: "R_0603_1608Metric",
          requirement:
            "The native runner must resolve this installed KiCad library through a global or project fp-lib-table before board sync. If the target user has no global table, stage a disposable project-local mapping and record its path/hash as evidence.",
        },
      ],
    },
    steps,
    artifactsToHash: [projectPath, schematicPath, boardPath, bomPath, placementPath],
    artifactRootsToHash: [fabricationDir, drillDir],
  };
}

export interface NegativeReleaseFixture {
  id:
    | "ipc-loss"
    | "external-edit"
    | "timeout-late-completion"
    | "bad-auth"
    | "path-escape"
    | "corrupt-checkpoint";
  hardGate: true;
  setup: string;
  expectedInvariant: string;
  requiredEvidence: string[];
}

export const NEGATIVE_RELEASE_FIXTURES: readonly NegativeReleaseFixture[] = [
  {
    id: "ipc-loss",
    hardGate: true,
    setup: "Start an IPC-pinned session, then make the IPC dependency unavailable.",
    expectedInvariant:
      "IPC-only behavior fails explicitly; the provider must not silently downgrade to SWIG and report success.",
    requiredEvidence: [
      "backend state before/after",
      "typed error result",
      "no silent-success mutation",
    ],
  },
  {
    id: "external-edit",
    hardGate: true,
    setup: "Open a board, modify its file externally, then call save_project without force.",
    expectedInvariant:
      "The external-edit guard refuses overwrite and preserves the external file unless force is explicit.",
    requiredEvidence: ["pre/post file hashes", "conflict result", "unchanged external bytes"],
  },
  {
    id: "timeout-late-completion",
    hardGate: true,
    setup: "Force one bridge request past its timeout and allow its response to arrive late.",
    expectedInvariant:
      "Caller timeout marks the semantic operation uncertain; the late response stays correlated to the original bridge request and, for supported mutations, must be reconciled by read-after-write before retry/dependent mutation. It must never satisfy an unrelated request or be treated as cancellation.",
    requiredEvidence: [
      "semantic operation_id and uncertain receipt",
      "original/late bridge request id",
      "reconciliation result when supported",
      "next unrelated request id/result",
    ],
  },
  {
    id: "bad-auth",
    hardGate: true,
    setup: "Call network MCP with missing and invalid credentials.",
    expectedInvariant:
      "Authentication fails closed before tool execution and no credential is echoed.",
    requiredEvidence: ["HTTP status", "sanitized error body", "zero tool side effects"],
  },
  {
    id: "path-escape",
    hardGate: true,
    setup: "Submit a file-operation path that escapes the allowed project/destination root.",
    expectedInvariant: "Traversal is rejected before any write outside the allowed root.",
    requiredEvidence: ["validation/authorization error", "outside-root hash unchanged"],
  },
  {
    id: "corrupt-checkpoint",
    hardGate: true,
    setup: "Damage a disposable checkpoint/snapshot artifact before attempting recovery/read-back.",
    expectedInvariant:
      "Corruption is reported explicitly; recovery must not claim success or overwrite the healthy project state.",
    requiredEvidence: ["corrupt artifact hash", "typed failure", "healthy project hash unchanged"],
  },
] as const;

export interface ScoreCheck {
  id: string;
  weight: number;
  passed: boolean;
  hardGate: boolean;
}

export interface ScoreReport {
  threshold: number;
  score: number;
  status: "CERTIFIED" | "NOT CERTIFIED";
  hardGateFailures: string[];
  failedChecks: string[];
  checks: ScoreCheck[];
}

export function buildScoreReport(
  checks: ScoreCheck[],
  threshold = RELEASE_SCORE_THRESHOLD,
): ScoreReport {
  if (checks.length === 0) {
    throw new Error("At least one acceptance check is required.");
  }
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) {
    throw new Error("Acceptance threshold must be between 0 and 100.");
  }

  let totalWeight = 0;
  let passedWeight = 0;
  for (const check of checks) {
    if (!check.id || !Number.isFinite(check.weight) || check.weight <= 0) {
      throw new Error("Each acceptance check needs a non-empty id and positive finite weight.");
    }
    totalWeight += check.weight;
    if (check.passed) passedWeight += check.weight;
  }

  const score = Math.round((passedWeight / totalWeight) * 10000) / 100;
  const hardGateFailures = checks
    .filter((check) => check.hardGate && !check.passed)
    .map((c) => c.id);
  const failedChecks = checks.filter((check) => !check.passed).map((check) => check.id);
  const status =
    hardGateFailures.length === 0 && score >= threshold ? "CERTIFIED" : "NOT CERTIFIED";

  return {
    threshold,
    score,
    status,
    hardGateFailures,
    failedChecks,
    checks: checks.map((check) => ({ ...check })),
  };
}

export interface EvidenceStatusRecord {
  id?: string;
  command?: string;
  status: "PASS" | "FAIL" | "LIMITED" | "SKIPPED";
  details?: unknown;
  [key: string]: unknown;
}

export interface ArtifactEvidence {
  path: string;
  sha256: string;
  bytes?: number;
}

export interface EvidenceManifestInput {
  generatedAt: string;
  sourceSha: string;
  kicadBuild: string;
  provider: {
    version: string;
    contractVersion: string;
    contractHash: string;
  };
  capabilitySnapshot: unknown;
  fixtureResults: EvidenceStatusRecord[];
  fixtureHashes: ArtifactEvidence[];
  testResults: EvidenceStatusRecord[];
  artifacts: ArtifactEvidence[];
  limitations: string[];
}

export interface ReleaseEvidenceManifest {
  schema: "cdt-kicad-release-evidence-v1";
  generated_at: string;
  source_sha: string;
  kicad_build: string;
  provider: {
    version: string;
    contract_version: string;
    contract_hash: string;
  };
  capability_snapshot: unknown;
  fixture_results: EvidenceStatusRecord[];
  fixture_hashes: ArtifactEvidence[];
  test_results: EvidenceStatusRecord[];
  artifacts: ArtifactEvidence[];
  limitations: string[];
}

const FORBIDDEN_EVIDENCE_KEY =
  /(prompt|token|secret|authorization|api[_-]?key|passphrase|password|credential)/i;
const BEARER_VALUE = /\bBearer\s+\S+/i;
const CREDENTIAL_VALUE =
  /(?:\bAuthorization\s*:\s*\S+|\bKICAD_MCP_TOKEN\s*=\s*\S+|--token(?:=|\s+)\S+|\b(?:api[_-]?key|password|passphrase|secret|credential)\s*=\s*\S+)/i;

function assertNoForbiddenEvidence(value: unknown, path = "manifest"): void {
  if (typeof value === "string") {
    if (BEARER_VALUE.test(value) || CREDENTIAL_VALUE.test(value)) {
      throw new Error(`Forbidden evidence value at ${path}: credential-like value`);
    }
    return;
  }
  if (value === null || typeof value !== "object") return;

  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoForbiddenEvidence(entry, `${path}[${index}]`));
    return;
  }

  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_EVIDENCE_KEY.test(key)) {
      throw new Error(`Forbidden evidence field at ${path}.${key}`);
    }
    assertNoForbiddenEvidence(nested, `${path}.${key}`);
  }
}

function requireHash(value: string, label: string, lengths: number[]): void {
  if (!lengths.includes(value.length) || !/^[a-f0-9]+$/i.test(value)) {
    throw new Error(`${label} must be a ${lengths.join("-or-")}-character hexadecimal hash.`);
  }
}

export function buildEvidenceManifest(input: EvidenceManifestInput): ReleaseEvidenceManifest {
  if (!input.generatedAt || Number.isNaN(Date.parse(input.generatedAt))) {
    throw new Error("generatedAt must be an ISO-compatible timestamp.");
  }
  if (!input.kicadBuild.trim()) {
    throw new Error("kicadBuild is required; unavailable builds must be reported as a limitation.");
  }
  requireHash(input.sourceSha, "sourceSha", [40, 64]);
  requireHash(input.provider.contractHash, "provider.contractHash", [64]);

  for (const fixture of input.fixtureHashes) {
    if (!fixture.path) throw new Error("Fixture hash path is required.");
    requireHash(fixture.sha256, `fixture ${fixture.path} sha256`, [64]);
  }
  for (const artifact of input.artifacts) {
    if (!artifact.path) throw new Error("Artifact path is required.");
    requireHash(artifact.sha256, `artifact ${artifact.path} sha256`, [64]);
  }

  assertNoForbiddenEvidence(input);

  return {
    schema: "cdt-kicad-release-evidence-v1",
    generated_at: input.generatedAt,
    source_sha: input.sourceSha,
    kicad_build: input.kicadBuild,
    provider: {
      version: input.provider.version,
      contract_version: input.provider.contractVersion,
      contract_hash: input.provider.contractHash,
    },
    capability_snapshot: input.capabilitySnapshot,
    fixture_results: input.fixtureResults.map((result) => ({ ...result })),
    fixture_hashes: input.fixtureHashes.map((fixture) => ({ ...fixture })),
    test_results: input.testResults.map((result) => ({ ...result })),
    artifacts: input.artifacts.map((artifact) => ({ ...artifact })),
    limitations: [...input.limitations],
  };
}

export function hashArtifact(path: string): ArtifactEvidence {
  const bytes = readFileSync(path);
  return {
    path,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.byteLength,
  };
}
