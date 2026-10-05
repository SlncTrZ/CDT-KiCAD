import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PROVIDER_VERSION } from "../src/provider-contract.js";

// package.json carries the fork release version (2.7.0-cdt.1); the provider
// contract and the Python bridge metadata must track it. pyproject.toml once
// drifted to a stale 2.4.0 with no test to catch it.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("release version sync", () => {
  it("package.json, provider contract and pyproject agree", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8")) as {
      version: string;
    };
    const pyproject = readFileSync(join(ROOT, "pyproject.toml"), "utf-8");
    const match = pyproject.match(/^version\s*=\s*"([^"]+)"\s*$/m);
    expect(match?.[1]).toBe(pkg.version);
    expect(PROVIDER_VERSION).toBe(pkg.version);
  });
});
