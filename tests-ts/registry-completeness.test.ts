import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import {
  BASELINE_UNINDEXED_AUDIT,
  type DiscoveryAuditEntry,
} from "../src/tools/discovery-audit.js";
import {
  directToolNames,
  getRegistryStats,
  getRoutedToolNames,
  getToolCategory,
  toolCategories,
} from "../src/tools/registry.js";

const TOOLS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "tools");

function registeredToolNames(): Set<string> {
  return new Set<string>([...getRoutedToolNames(), ...directToolNames]);
}

function serverToolNames(): Map<string, string> {
  // name -> declaring file, for a useful failure message
  const found = new Map<string, string>();
  for (const file of readdirSync(TOOLS_DIR)) {
    if (!file.endsWith(".ts")) continue;
    const src = readFileSync(join(TOOLS_DIR, file), "utf-8");
    const re = /server\.tool\(\s*"([a-z0-9_]+)"/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      if (!found.has(m[1])) found.set(m[1], file);
    }
  }
  return found;
}

function auditEntries(): Array<[string, DiscoveryAuditEntry]> {
  return Object.entries(BASELINE_UNINDEXED_AUDIT);
}

describe("registry completeness", () => {
  it("finds the server.tool registrations at all", () => {
    // Guards the regex itself: a refactor that changes the call shape must
    // fail loudly here rather than silently making the checks below vacuous.
    expect(serverToolNames().size).toBeGreaterThan(150);
  });

  it("keeps an explicit classification for all 60 baseline unindexed tools", () => {
    expect(auditEntries()).toHaveLength(60);
    const onServer = serverToolNames();
    const missingFromServer = auditEntries()
      .map(([name]) => name)
      .filter((name) => !onServer.has(name));
    expect(missingFromServer).toEqual([]);
  });

  it("all baseline should-index tools are discoverable now", () => {
    const registered = registeredToolNames();
    const missing = auditEntries()
      .filter(([, entry]) => entry.disposition === "should-index")
      .map(([name]) => name)
      .filter((name) => !registered.has(name));
    expect(missing).toEqual([]);
  });

  it("should-index category assignments match the audit", () => {
    const mismatches = auditEntries()
      .filter(
        ([name, entry]) =>
          entry.disposition === "should-index" &&
          entry.category !== undefined &&
          getToolCategory(name) !== entry.category,
      )
      .map(([name, entry]) => ({
        name,
        expected: entry.category,
        actual: getToolCategory(name),
      }));
    expect(mismatches).toEqual([]);
  });

  it("every remaining unindexed tool has an intentional classification", () => {
    const registered = registeredToolNames();
    const onServer = serverToolNames();
    const actualUnindexed = [...onServer.keys()].filter((name) => !registered.has(name)).sort();
    const expectedUnindexed = auditEntries()
      .filter(([, entry]) => entry.disposition !== "should-index")
      .map(([name]) => name)
      .sort();

    expect(actualUnindexed).toEqual(expectedUnindexed);
  });

  it("no NEW tool is registered on the server but absent from registry and audit", () => {
    const registered = registeredToolNames();
    const classified = new Set(Object.keys(BASELINE_UNINDEXED_AUDIT));
    const novel: string[] = [];

    for (const [name, file] of serverToolNames()) {
      if (registered.has(name) || classified.has(name)) continue;
      novel.push(`${name} (${file})`);
    }

    expect(
      novel,
      "A newly registered tool must either be discoverable or explicitly classified.",
    ).toEqual([]);
  });

  it("every registry entry is actually registered on the server", () => {
    const onServer = serverToolNames();
    const ghosts = [...registeredToolNames()].filter((name) => !onServer.has(name));
    expect(ghosts, "Registry advertises tools the server does not register").toEqual([]);
  });

  it("total_tools counts distinct tools, not category+direct with overlap", () => {
    const distinct = new Set<string>(directToolNames);
    for (const category of toolCategories) {
      for (const tool of category.tools) distinct.add(tool);
    }
    expect(getRegistryStats().total_tools).toBe(distinct.size);
  });

  it("no tool name is claimed by two categories", () => {
    const seen = new Map<string, string>();
    const clashes: string[] = [];
    for (const category of toolCategories) {
      for (const tool of category.tools) {
        const prior = seen.get(tool);
        if (prior) clashes.push(`${tool}: '${prior}' and '${category.name}'`);
        else seen.set(tool, category.name);
      }
    }
    expect(clashes).toEqual([]);
  });
});
