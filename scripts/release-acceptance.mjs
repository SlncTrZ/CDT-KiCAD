#!/usr/bin/env node
/**
 * CDT-KiCAD release-acceptance CLI.
 *
 * Fork of mixelpixx/KiCAD-MCP-Server (MIT, see ATTRIBUTION.md).
 * SlncTrZ release-proof adaptation by SlncTrZ / Truong Cong Dinh.
 *
 * Build first so this script imports the exact compiled acceptance primitives:
 *   npm run build
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import {
  NEGATIVE_RELEASE_FIXTURES,
  buildEvidenceManifest,
  buildNativeVerticalSliceFixture,
  buildScoreReport,
  hashArtifact,
} from "../dist/release-acceptance.js";

function usage() {
  console.log(`CDT-KiCAD release acceptance tooling

Commands:
  fixture  --workspace <disposable-root> --out-dir <dir> [--project-name <name>]
  score    --input <checks.json> --out <score.json>
  manifest --input <manifest-input.json> --out <manifest.json>

fixture:
  Writes native-vertical-slice.json and negative-release-fixtures.json plus hashes.
  It prepares the run plan only; it does NOT claim native execution/certification.

score input:
  {"checks":[{"id":"registry","weight":20,"passed":true,"hardGate":true}],"threshold":95}

manifest input:
  Fields accepted by buildEvidenceManifest plus either precomputed
  fixtureHashes/artifacts or fixturePaths/artifactPaths. Paths may be files or
  directories; directory contents are hashed recursively in lexical order.
`);
}

function parseOptions(args) {
  const options = new Map();
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    const current = args[i];
    if (!current.startsWith("--")) {
      positional.push(current);
      continue;
    }
    const value = args[i + 1];
    if (value === undefined || value.startsWith("--")) {
      options.set(current, true);
      continue;
    }
    options.set(current, value);
    i += 1;
  }
  return { options, positional };
}

function requiredOption(options, name) {
  const value = options.get(name);
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Missing required option ${name}`);
  }
  return value;
}

function writeJson(path, value) {
  const absolute = resolve(path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, JSON.stringify(value, null, 2) + "\n", "utf-8");
  return absolute;
}

function readJson(path) {
  return JSON.parse(readFileSync(resolve(path), "utf-8"));
}

function filesUnder(path) {
  const absolute = resolve(path);
  if (!existsSync(absolute)) {
    throw new Error(`Evidence path does not exist: ${absolute}`);
  }
  const stat = statSync(absolute);
  if (stat.isFile()) return [absolute];
  if (!stat.isDirectory()) {
    throw new Error(`Evidence path is neither a regular file nor directory: ${absolute}`);
  }

  const found = [];
  for (const name of readdirSync(absolute).sort()) {
    const child = join(absolute, name);
    const childStat = statSync(child);
    if (childStat.isDirectory()) found.push(...filesUnder(child));
    else if (childStat.isFile()) found.push(child);
  }
  return found;
}

function hashPaths(paths) {
  const files = [...new Set(paths.flatMap((path) => filesUnder(path)))].sort();
  return files.map((path) => hashArtifact(path));
}

function runFixture(options) {
  const workspace = requiredOption(options, "--workspace");
  const outDir = resolve(requiredOption(options, "--out-dir"));
  const projectName =
    typeof options.get("--project-name") === "string"
      ? options.get("--project-name")
      : "release_probe";

  const nativePath = writeJson(
    join(outDir, "native-vertical-slice.json"),
    buildNativeVerticalSliceFixture(workspace, projectName),
  );
  const negativePath = writeJson(
    join(outDir, "negative-release-fixtures.json"),
    NEGATIVE_RELEASE_FIXTURES,
  );

  const result = {
    fixture_hashes: [hashArtifact(nativePath), hashArtifact(negativePath)],
    limitation:
      "Fixture plans are prepared only. Execute them natively on final integration HEAD before certification.",
  };
  console.log(JSON.stringify(result, null, 2));
}

function runScore(options) {
  const input = readJson(requiredOption(options, "--input"));
  const output = requiredOption(options, "--out");
  const checks = Array.isArray(input) ? input : input.checks;
  const threshold = Array.isArray(input) ? undefined : input.threshold;

  if (!Array.isArray(checks)) {
    throw new Error("Score input must be an array or an object containing checks[].");
  }

  const report = buildScoreReport(checks, threshold);
  const path = writeJson(output, report);
  console.log(`Wrote ${path}: ${report.status} (${report.score})`);
}

function runManifest(options) {
  const input = readJson(requiredOption(options, "--input"));
  const output = requiredOption(options, "--out");

  if (Array.isArray(input.fixturePaths)) {
    input.fixtureHashes = hashPaths(input.fixturePaths);
    delete input.fixturePaths;
  }
  if (Array.isArray(input.artifactPaths)) {
    input.artifacts = hashPaths(input.artifactPaths);
    delete input.artifactPaths;
  }

  if (!Array.isArray(input.fixtureHashes)) input.fixtureHashes = [];
  if (!Array.isArray(input.artifacts)) input.artifacts = [];

  const manifest = buildEvidenceManifest(input);
  const path = writeJson(output, manifest);
  console.log(`Wrote ${path}`);
}

const [command, ...args] = process.argv.slice(2);
if (!command || command === "--help" || command === "-h" || command === "help") {
  usage();
  process.exit(0);
}

try {
  const { options } = parseOptions(args);
  if (command === "fixture") runFixture(options);
  else if (command === "score") runScore(options);
  else if (command === "manifest") runManifest(options);
  else throw new Error(`Unknown command: ${command}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
