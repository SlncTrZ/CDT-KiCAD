import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { delimiter } from "node:path";

export class PathContainmentError extends Error {
  constructor() {
    super("Filesystem path is outside allowed roots");
    this.name = "PathContainmentError";
  }
}

export function isPathWithin(
  candidate: string,
  root: string,
  pathImpl: typeof path.posix | typeof path.win32 = path,
): boolean {
  const relative = pathImpl.relative(pathImpl.resolve(root), pathImpl.resolve(candidate));
  return (
    relative === "" ||
    (!relative.startsWith(".." + pathImpl.sep) && relative !== ".." && !pathImpl.isAbsolute(relative))
  );
}

function canonicalize(pathname: string, base = process.cwd()): string {
  let absolute = path.resolve(base, pathname);
  const missing: string[] = [];

  while (!existsSync(absolute)) {
    const parent = path.dirname(absolute);
    if (parent === absolute) break;
    missing.unshift(path.basename(absolute));
    absolute = parent;
  }

  const existing = existsSync(absolute) ? realpathSync.native(absolute) : path.resolve(absolute);
  return path.resolve(existing, ...missing);
}

export function resolveContainedPath(
  pathname: string,
  roots: readonly string[],
  base = process.cwd(),
): string {
  const canonical = canonicalize(pathname, base);
  const canonicalRoots = roots.map((root) => canonicalize(root, base));
  if (!canonicalRoots.some((root) => isPathWithin(canonical, root))) {
    throw new PathContainmentError();
  }
  return canonical;
}

export function configuredTrustedRoots(): string[] {
  return (process.env.KICAD_MCP_TRUSTED_ROOTS ?? "")
    .split(delimiter)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function trustedIoRoots(): string[] {
  return [process.cwd(), ...configuredTrustedRoots(), tmpdir()];
}
