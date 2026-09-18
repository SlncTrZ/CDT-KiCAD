import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import {
  NEGATIVE_RELEASE_FIXTURES,
  RELEASE_SCORE_THRESHOLD,
  buildEvidenceManifest,
  buildNativeVerticalSliceFixture,
  buildScoreReport,
  hashArtifact,
} from "../src/release-acceptance.js";

describe("native release fixture", () => {
  it("covers the required end-to-end ECAD vertical slice", () => {
    const fixture = buildNativeVerticalSliceFixture(join(process.cwd(), ".release-native-fixture"));
    const tools = fixture.steps.map((step) => step.tool);

    for (const required of [
      "create_project",
      "add_schematic_component",
      "connect_to_net",
      "generate_netlist",
      "sync_schematic_to_board",
      "move_component",
      "route_pad_to_pad",
      "run_erc",
      "run_drc",
      "save_project",
      "close_project",
      "open_project",
      "get_board_info",
      "export_gerber",
      "export_drill",
      "export_bom",
      "export_position_file",
    ]) {
      expect(tools, `fixture should exercise ${required}`).toContain(required);
    }

    expect(fixture.disposable).toBe(true);
    expect(fixture.artifactsToHash).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/\.kicad_pro$/),
        expect.stringMatching(/\.kicad_sch$/),
        expect.stringMatching(/\.kicad_pcb$/),
        expect.stringMatching(/bom\.csv$/),
        expect.stringMatching(/placement\.csv$/),
      ]),
    );
  });
});

describe("negative release fixtures", () => {
  it("covers every release-negative scenario required by D12", () => {
    expect(NEGATIVE_RELEASE_FIXTURES.map((fixture) => fixture.id).sort()).toEqual(
      [
        "bad-auth",
        "corrupt-checkpoint",
        "external-edit",
        "ipc-loss",
        "path-escape",
        "timeout-late-completion",
      ].sort(),
    );
    expect(NEGATIVE_RELEASE_FIXTURES.every((fixture) => fixture.hardGate)).toBe(true);
  });
});

describe("weighted acceptance score", () => {
  it("certifies only when the weighted score reaches the threshold and hard gates pass", () => {
    const report = buildScoreReport([
      { id: "registry", weight: 40, passed: true, hardGate: true },
      { id: "native", weight: 55, passed: true, hardGate: true },
      { id: "docs", weight: 5, passed: true, hardGate: false },
    ]);

    expect(RELEASE_SCORE_THRESHOLD).toBe(95);
    expect(report.score).toBe(100);
    expect(report.status).toBe("CERTIFIED");
    expect(report.hardGateFailures).toEqual([]);
  });

  it("hard-gate failure forces NOT CERTIFIED regardless of arithmetic", () => {
    const report = buildScoreReport([
      { id: "registry", weight: 99, passed: true, hardGate: false },
      { id: "native", weight: 1, passed: false, hardGate: true },
    ]);

    expect(report.score).toBe(99);
    expect(report.status).toBe("NOT CERTIFIED");
    expect(report.hardGateFailures).toEqual(["native"]);
  });

  it("a score below threshold is NOT CERTIFIED even when hard gates pass", () => {
    const report = buildScoreReport([
      { id: "native", weight: 90, passed: true, hardGate: true },
      { id: "docs", weight: 10, passed: false, hardGate: false },
    ]);

    expect(report.score).toBe(90);
    expect(report.status).toBe("NOT CERTIFIED");
  });
});

describe("release evidence manifest", () => {
  const baseInput = {
    generatedAt: "2026-09-18T05:00:00.000Z",
    sourceSha: "a".repeat(40),
    kicadBuild: "KiCad 10.0.0",
    provider: {
      version: "2.7.0-cdt.1",
      contractVersion: "cdt-kicad-contract-v2",
      contractHash: "b".repeat(64),
    },
    capabilitySnapshot: { backend: "swig", capabilities: { export: true } },
    fixtureResults: [{ id: "native-vertical-slice", status: "PASS" as const }],
    fixtureHashes: [{ path: "native-vertical-slice.json", sha256: "d".repeat(64) }],
    testResults: [{ command: "vitest run", status: "PASS" as const }],
    artifacts: [{ path: "evidence.json", sha256: "c".repeat(64) }],
    limitations: ["Final native run must be repeated on integration HEAD."],
  };

  it("keeps the required release evidence fields", () => {
    const manifest = buildEvidenceManifest(baseInput);
    expect(manifest.source_sha).toBe(baseInput.sourceSha);
    expect(manifest.kicad_build).toBe(baseInput.kicadBuild);
    expect(manifest.provider.contract_hash).toBe(baseInput.provider.contractHash);
    expect(manifest.capability_snapshot).toEqual(baseInput.capabilitySnapshot);
    expect(manifest.fixture_results).toHaveLength(1);
    expect(manifest.fixture_hashes).toHaveLength(1);
    expect(manifest.test_results).toHaveLength(1);
    expect(manifest.artifacts).toHaveLength(1);
    expect(manifest.limitations).toEqual(baseInput.limitations);
  });

  it("rejects prompt or secret material anywhere in evidence payloads", () => {
    expect(() =>
      buildEvidenceManifest({
        ...baseInput,
        capabilitySnapshot: { nested: { prompt: "do not persist me" } },
      }),
    ).toThrow(/forbidden evidence field/i);

    expect(() =>
      buildEvidenceManifest({
        ...baseInput,
        testResults: [
          {
            command: "http smoke",
            status: "PASS" as const,
            details: { authorization: "Bearer super-secret" },
          },
        ],
      }),
    ).toThrow(/forbidden evidence field/i);
  });

  it("hashArtifact records deterministic SHA-256 evidence", () => {
    const dir = mkdtempSync(join(process.cwd(), ".release-evidence-test-"));
    try {
      const file = join(dir, "artifact.txt");
      writeFileSync(file, "release-proof\n", "utf-8");
      const evidence = hashArtifact(file);
      expect(evidence.path).toBe(file);
      expect(evidence.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(evidence.bytes).toBe(readFileSync(file).byteLength);
      expect(hashArtifact(file).sha256).toBe(evidence.sha256);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
