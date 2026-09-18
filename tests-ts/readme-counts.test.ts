import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { BASELINE_UNINDEXED_AUDIT } from "../src/tools/discovery-audit.js";
import { getRegistryStats } from "../src/tools/registry.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function intentionalUnindexedCount(): number {
  return Object.values(BASELINE_UNINDEXED_AUDIT).filter(
    (entry) => entry.disposition !== "should-index",
  ).length;
}

describe("discovery documentation counts", () => {
  it("README registered/indexed/category counts match the discovery contract", () => {
    const readme = readFileSync(join(ROOT, "README.md"), "utf-8");
    const stats = getRegistryStats();
    const registered = stats.total_tools + intentionalUnindexedCount();

    const headline = readme.match(
      /(\d+) tools registered; (\d+) indexed for keyword discovery and (\d+) discovery controls intentionally direct-only/,
    );
    expect(headline, "README should state registered/indexed/direct-only counts").toBeTruthy();
    expect(Number(headline![1]), "README registered tool count").toBe(registered);
    expect(Number(headline![2]), "README indexed tool count").toBe(stats.total_tools);
    expect(Number(headline![3]), "README intentional direct-only count").toBe(
      intentionalUnindexedCount(),
    );

    const categories = readme.match(/(\d+) discoverable tools across (\d+) categories/);
    expect(categories, "README should state discoverable tool/category counts").toBeTruthy();
    expect(Number(categories![1]), "README discoverable tool count").toBe(stats.total_tools);
    expect(Number(categories![2]), "README category count").toBe(stats.total_categories);
  });

  it("runtime TOOL_GUIDE discovery counts match the registry", () => {
    const guide = readFileSync(join(ROOT, "docs", "TOOL_GUIDE.md"), "utf-8");
    const stats = getRegistryStats();

    expect(guide).toContain(
      `\`list_tool_categories\` — browse the ${stats.total_categories} indexed ECAD categories.`,
    );
    expect(guide).toContain(
      `\`search_tools\` — keyword search across ${stats.total_tools} indexed tools.`,
    );
    expect(guide).toContain(
      `Of ${stats.total_tools + intentionalUnindexedCount()} registered tools, ${stats.total_tools} are indexed.`,
    );
  });
});
