import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { join, win32 } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PathContainmentError,
  isPathWithin,
  resolveContainedPath,
} from "../src/path-policy.js";

const cleanup: string[] = [];

function makeTemp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of cleanup.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("TypeScript filesystem containment", () => {
  it("rejects parent traversal and absolute escape", () => {
    const workspace = makeTemp("kicad-path-");
    const project = join(workspace, "project");
    const outside = join(workspace, "outside");
    mkdirSync(project);
    mkdirSync(outside);

    expect(() => resolveContainedPath("../outside/x.kicad_pcb", [project], project)).toThrow(
      PathContainmentError,
    );
    expect(() => resolveContainedPath(join(outside, "x.kicad_pcb"), [project], project)).toThrow(
      PathContainmentError,
    );
  });

  it("rejects an escape through an existing symlink ancestor", () => {
    const workspace = makeTemp("kicad-path-");
    const project = join(workspace, "project");
    const outside = join(workspace, "outside");
    mkdirSync(project);
    mkdirSync(outside);
    const link = join(project, "link");
    try {
      symlinkSync(outside, link, "dir");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }

    expect(() => resolveContainedPath(join(link, "x.kicad_pcb"), [project], project)).toThrow(
      PathContainmentError,
    );
  });

  it.skipIf(process.platform !== "win32")("rejects Windows junction/reparse escape", () => {
    const workspace = makeTemp("kicad-path-");
    const project = join(workspace, "project");
    const outside = join(workspace, "outside");
    mkdirSync(project);
    mkdirSync(outside);
    const junction = join(project, "junction");
    symlinkSync(outside, junction, "junction");

    expect(() => resolveContainedPath(join(junction, "x.kicad_pcb"), [project], project)).toThrow(
      PathContainmentError,
    );
  });

  it("allows and canonicalizes a valid in-root output", () => {
    const workspace = makeTemp("kicad-path-");
    const project = join(workspace, "project");
    mkdirSync(project);

    expect(resolveContainedPath("nested/../board.kicad_pcb", [project], project)).toBe(
      join(project, "board.kicad_pcb"),
    );
  });

  it("uses Windows drive/case semantics instead of prefix matching", () => {
    expect(isPathWithin("C:\\Work\\Project\\board.kicad_pcb", "c:\\work\\project", win32)).toBe(
      true,
    );
    expect(isPathWithin("D:\\Work\\Project\\board.kicad_pcb", "C:\\Work\\Project", win32)).toBe(
      false,
    );
    expect(
      isPathWithin("C:\\Work\\Project-Escape\\board.kicad_pcb", "C:\\Work\\Project", win32),
    ).toBe(false);
  });
});
