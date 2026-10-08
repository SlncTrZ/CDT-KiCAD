/**
 * Fork of mixelpixx/KiCAD-MCP-Server (MIT, see ATTRIBUTION.md).
 * SlncTrZ provider adaptation by SlncTrZ / Truong Cong Dinh.
 *
 * Python/KiCad discovery + spawn environment (migration K1/K2).
 *
 * Moved verbatim from src/server.ts: project-venv priority, KICAD_PYTHON
 * override, platform KiCAD-bundled Python detection (Windows Program Files /
 * %LOCALAPPDATA%, macOS app bundles, Linux kicad paths + system fallback),
 * bundled site-packages derivation and PYTHONPATH precedence. No behavior
 * change — the workstation agent and the local server path share this one
 * implementation. The REMOTE provider path must never import this module
 * (enforced by tests-ts/runtime-remote-adapter.test.ts).
 */

import { execSync } from "child_process";
import { existsSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { logger } from "../logger.js";

export function getWindowsKiCadPythonCandidates(): string[] {
  const roots = [
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Programs", "KiCad") : undefined,
    "C:\\Program Files\\KiCad",
    "C:\\Program Files (x86)\\KiCad",
  ].filter((root): root is string => Boolean(root));

  const candidates: string[] = [];

  for (const root of roots) {
    if (!existsSync(root)) {
      continue;
    }

    try {
      const versionDirs = readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));

      for (const versionDir of versionDirs) {
        candidates.push(join(root, versionDir, "bin", "python.exe"));
      }
    } catch (error: any) {
      logger.warn(`Failed to inspect KiCAD install directory ${root}: ${error.message}`);
    }
  }

  return [...new Set(candidates)];
}

/**
 * Derive the KiCAD bundled-Python site-packages path for a detected python.exe,
 * so PYTHONPATH follows the *same* install we picked (any version, Program Files
 * or per-user %LOCALAPPDATA%) instead of a hardcoded KiCad 9.0 path.
 *
 * KiCAD on Windows installs python at `<root>/<version>/bin/python.exe`, with
 * pcbnew under `<...>/bin/Lib/site-packages` (older/alt layouts use
 * `<version>/lib/python3/dist-packages`). Returns the first existing candidate,
 * or undefined if pythonExe isn't a KiCAD bundled python.
 */
export function deriveKiCadSitePackages(pythonExe: string): string | undefined {
  if (process.platform !== "win32") return undefined;
  const lower = pythonExe.toLowerCase();
  if (!lower.endsWith("python.exe") || !lower.includes("kicad")) return undefined;
  const binDir = dirname(pythonExe); // <root>/<version>/bin
  const versionDir = dirname(binDir); // <root>/<version>
  const candidates = [
    join(binDir, "Lib", "site-packages"),
    join(versionDir, "lib", "python3", "dist-packages"),
  ];
  return candidates.find((p) => existsSync(p));
}

/**
 * Find the Python executable to use.
 * Prioritizes project venvs, then explicit overrides, then KiCAD-bundled Python
 * before falling back to system Python.
 */
export function findPythonExecutable(scriptPath: string): string {
  const isWindows = process.platform === "win32";
  const isMac = process.platform === "darwin";
  const isLinux = !isWindows && !isMac;

  // Get the project root (parent of the python/ directory)
  const projectRoot = dirname(dirname(scriptPath));

  // Check for virtual environment
  const venvPaths = [
    join(projectRoot, "venv", isWindows ? "Scripts" : "bin", isWindows ? "python.exe" : "python"),
    join(projectRoot, ".venv", isWindows ? "Scripts" : "bin", isWindows ? "python.exe" : "python"),
  ];

  for (const venvPath of venvPaths) {
    if (existsSync(venvPath)) {
      logger.info(`Found virtual environment Python at: ${venvPath}`);
      return venvPath;
    }
  }

  // Allow override via KICAD_PYTHON environment variable (any platform)
  if (process.env.KICAD_PYTHON) {
    logger.info(`Using KICAD_PYTHON environment variable: ${process.env.KICAD_PYTHON}`);
    return process.env.KICAD_PYTHON;
  }

  // Platform-specific KiCAD bundled Python detection
  if (isWindows) {
    // Windows: Always prefer KiCAD's bundled Python (pcbnew.pyd is compiled for it).
    for (const kicadPython of getWindowsKiCadPythonCandidates()) {
      if (existsSync(kicadPython)) {
        logger.info(`Found KiCAD bundled Python at: ${kicadPython}`);
        return kicadPython;
      }
    }
  } else if (isMac) {
    // macOS: Try KiCAD's bundled Python (check multiple versions and locations)
    const kicadPythonVersions = ["3.9", "3.10", "3.11", "3.12", "3.13"];

    // Standard KiCAD installation paths
    const kicadAppPaths = [
      "/Applications/KiCad/KiCad.app",
      "/Applications/KiCAD/KiCad.app", // Alternative capitalization
      `${process.env.HOME}/Applications/KiCad/KiCad.app`, // User Applications folder
    ];

    // Check all KiCAD app locations with all Python versions
    for (const appPath of kicadAppPaths) {
      for (const version of kicadPythonVersions) {
        const kicadPython = `${appPath}/Contents/Frameworks/Python.framework/Versions/${version}/bin/python3`;
        if (existsSync(kicadPython)) {
          logger.info(`Found KiCAD bundled Python at: ${kicadPython}`);
          return kicadPython;
        }
      }
    }

    // Fallback to Homebrew Python (if pcbnew is installed via pip)
    const homebrewPaths = [
      "/opt/homebrew/bin/python3", // Apple Silicon
      "/usr/local/bin/python3", // Intel Mac
      "/opt/homebrew/bin/python3.12",
      "/opt/homebrew/bin/python3.11",
    ];

    for (const path of homebrewPaths) {
      if (existsSync(path)) {
        logger.info(`Found Homebrew Python at: ${path} (ensure pcbnew is importable)`);
        return path;
      }
    }
  } else if (isLinux) {
    // Linux: Try KiCAD bundled Python locations first
    const linuxKicadPaths = [
      "/usr/lib/kicad/bin/python3",
      "/usr/local/lib/kicad/bin/python3",
      "/opt/kicad/bin/python3",
    ];

    for (const path of linuxKicadPaths) {
      if (existsSync(path)) {
        logger.info(`Found KiCAD bundled Python at: ${path}`);
        return path;
      }
    }

    // Resolve system python3 to full path using 'which'
    try {
      const result = execSync("which python3", { encoding: "utf-8" }).trim();
      if (result && existsSync(result)) {
        logger.info(`Resolved system Python via which: ${result}`);
        return result;
      }
    } catch {
      logger.warn("Failed to resolve python3 via which command");
    }

    // Fallback to common system paths
    const systemPaths = ["/usr/bin/python3", "/bin/python3"];
    for (const path of systemPaths) {
      if (existsSync(path)) {
        logger.info(`Found system Python at: ${path}`);
        return path;
      }
    }
  }

  // Default to system Python (last resort)
  logger.info("Using system Python (no venv found)");
  return isWindows ? "python.exe" : "python3";
}

/** Legacy KiCad 9.0 fallback used only when no explicit or derived path exists. */
export const LEGACY_KICAD_SITE_PACKAGES = "C:/Program Files/KiCad/9.0/lib/python3/dist-packages";

/**
 * Resolve the PYTHONPATH for spawning the worker.
 * Precedence: explicit env override → site-packages derived from the detected
 * KiCAD python (any version / install location) → legacy 9.0 fallback.
 */
export function resolveWorkerPythonPath(pythonExe: string): string {
  if (process.env.PYTHONPATH) return process.env.PYTHONPATH;
  return deriveKiCadSitePackages(pythonExe) ?? LEGACY_KICAD_SITE_PACKAGES;
}
