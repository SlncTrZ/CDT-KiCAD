"""Caller-controlled filesystem containment for CDT-KiCAD."""

from __future__ import annotations

import os
import tempfile
from pathlib import Path
from typing import Any, Iterable, Mapping, Optional


class PathPolicyError(ValueError):
    """A caller path escapes the operator-owned filesystem boundary."""


# Top-level filesystem fields exposed by tool schemas. KiCad semantic hierarchy
# fields such as sheetPath are intentionally not filesystem paths.
FILESYSTEM_PATH_KEYS = frozenset(
    {
        "path",
        "filename",
        "boardPath",
        "pcbPath",
        "filePath",
        "svgPath",
        "reportPath",
        "libraryPath",
        "outputDir",
        "outputPath",
        "schematicPath",
        "schematicPaths",
        "schematic_path",
        "modelsDir",
        "footprintPath",
        "modelPath",
        "projectPath",
        "libraryDir",
        "searchPath",
        "searchPaths",
        "search_paths",
        "sesPath",
        "backupPath",
        "backupDir",
        "tablePath",
        "drawingSheet",
        "dest_dir",
        "inputFile",
        "outputFile",
        "projectsDir",
        "subsheetPath",
        "parentSchematicPath",
        "sourceLibraryPath",
        "targetLibraryPath",
        "board_file",
        "schematic_file",
        "output_dir",
        "freeroutingJar",
    }
)

OPEN_CREATE_COMMANDS = frozenset(
    {
        "create_project",
        "open_project",
        "open_board",
        "create_schematic",
        "load_schematic",
        "launch_kicad_ui",
    }
)

SEMANTIC_PATH_FIELDS = {
    # KiCad variable references are stored verbatim in footprint/model records;
    # they are not host filesystem dereferences at this boundary.
    "add_footprint_3d_model": frozenset({"modelPath"}),
    "add_component_3d_model": frozenset({"modelPath"}),
    # remove_hierarchical_sheet uses basename matching only and never opens this field.
    "remove_hierarchical_sheet": frozenset({"subsheetPath"}),
}


TRUSTED_IO_COMMANDS = frozenset(
    {
        "save_project",
        "save_board",
        "save_as",
        "run_drc",
        "get_drc_violations",
        "download_registry_part",
        "create_board_from_schematic",
        "repair_flat_symbols",
        "set_symbol_pin_type",
        "find_duplicate_symbols",
        "add_footprint_3d_model",
        "add_component_3d_model",
        "register_footprint_library",
        "register_symbol_library",
        "create_footprint",
        "create_symbol",
        "delete_symbol",
        "add_symbol_property",
        "add_library_symbol_property",
        "list_library_table",
        "remove_library_table_entry",
        "set_library_table_uri",
        "autoroute",
        "check_freerouting",
    }
)


def is_path_within(candidate: str, root: str, *, path_module: Any = os.path) -> bool:
    """Use commonpath semantics, never string-prefix containment."""

    candidate_key = path_module.normcase(path_module.abspath(candidate))
    root_key = path_module.normcase(path_module.abspath(root))
    try:
        return path_module.commonpath([candidate_key, root_key]) == root_key
    except ValueError:
        return False


def _canonical(raw: str | os.PathLike[str], base: Path) -> Path:
    candidate = Path(os.path.expanduser(os.fspath(raw)))
    if not candidate.is_absolute():
        candidate = base / candidate
    try:
        # strict=False preserves new output tails but resolves existing symlink
        # and Windows junction/reparse ancestors before containment checks.
        return candidate.resolve(strict=False)
    except (OSError, RuntimeError) as exc:
        raise PathPolicyError("filesystem path could not be canonicalized") from exc


def _unique_roots(values: Iterable[str | os.PathLike[str]], base: Path) -> list[Path]:
    roots: list[Path] = []
    seen: set[str] = set()
    for value in values:
        root = _canonical(value, base)
        key = os.path.normcase(str(root))
        if key not in seen:
            seen.add(key)
            roots.append(root)
    return roots


def _project_dir(project_root: Optional[str | os.PathLike[str]], cwd: Path) -> Optional[Path]:
    if project_root is None:
        return None
    root = _canonical(project_root, cwd)
    if root.suffix in {".kicad_pro", ".kicad_pcb", ".kicad_sch"}:
        return root.parent
    return root


def _root_class(command: str) -> str:
    if command in OPEN_CREATE_COMMANDS:
        return "open_create"
    if (
        command in TRUSTED_IO_COMMANDS
        or command.startswith(("export_", "import_", "validate_"))
        or any(word in command for word in ("librar", "footprint", "symbol"))
    ):
        return "trusted_io"
    return "project"


def _env_trusted_roots() -> list[str]:
    return [
        item.strip()
        for item in os.environ.get("KICAD_MCP_TRUSTED_ROOTS", "").split(os.pathsep)
        if item.strip()
    ]


def validate_command_paths(
    command: str,
    params: Mapping[str, Any],
    *,
    project_root: Optional[str | os.PathLike[str]] = None,
    cwd: Optional[str | os.PathLike[str]] = None,
    trusted_roots: Optional[Iterable[str | os.PathLike[str]]] = None,
    temp_root: Optional[str | os.PathLike[str]] = None,
) -> dict[str, Any]:
    """Canonicalize known filesystem params and reject root escape."""

    cwd_path = _canonical(cwd or Path.cwd(), Path.cwd())
    project = _project_dir(project_root, cwd_path)
    trusted = list(_env_trusted_roots() if trusted_roots is None else trusted_roots)
    root_class = _root_class(command)

    if root_class == "open_create":
        allowed = [cwd_path, *trusted, temp_root or tempfile.gettempdir()]
        if project is not None:
            allowed.append(project)
        base = cwd_path
    elif root_class == "trusted_io":
        allowed = [project or cwd_path, *trusted, temp_root or tempfile.gettempdir()]
        base = project or cwd_path
    else:
        if project is not None:
            allowed = [project]
        else:
            allowed = [cwd_path, *trusted, temp_root or tempfile.gettempdir()]
        base = project or cwd_path

    roots = _unique_roots(allowed, cwd_path)
    rewritten = dict(params)
    semantic_fields = SEMANTIC_PATH_FIELDS.get(command, frozenset())
    for field in FILESYSTEM_PATH_KEYS:
        if field in semantic_fields:
            continue
        value = rewritten.get(field)
        if value is None or value == "":
            continue

        def checked(item: str) -> str:
            resolved = _canonical(item, base)
            if not any(is_path_within(str(resolved), str(root)) for root in roots):
                raise PathPolicyError(f"{field} is outside allowed roots")
            return str(resolved)

        if isinstance(value, str):
            rewritten[field] = checked(value)
        elif isinstance(value, list) and all(isinstance(item, str) for item in value):
            rewritten[field] = [checked(item) for item in value]

    return rewritten
