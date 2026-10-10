import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PROVIDER_VERSION } from "../src/provider-contract.js";

// package.json carries stable CDT product version 0.x.x; the provider
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
    expect(pkg.version).toMatch(/^0\.\d+\.\d+$/);
    const lock = JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf-8")) as {
      version: string;
      packages: Record<string, { version: string }>;
    };
    expect(lock.version).toBe(pkg.version);
    expect(lock.packages[""]?.version).toBe(pkg.version);
    const defaults = JSON.parse(
      readFileSync(join(ROOT, "config/default-config.json"), "utf-8"),
    ) as { version: string };
    expect(defaults.version).toBe(pkg.version);
  });

  it("publishes only stable v.0.x.x release tags", () => {
    const workflow = readFileSync(join(ROOT, ".github/workflows/publish-release.yml"), "utf-8");
    expect(workflow).toContain('tags: ["v.0.*.*"]');
    expect(workflow).toContain('tag != f"v.{version}"');
    expect(workflow).not.toContain("--prerelease");
    expect(workflow).toContain("--verify-tag");
  });
});
