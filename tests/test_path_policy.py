"""Security tests for caller-controlled filesystem path containment."""

from __future__ import annotations

import ntpath
import os
import subprocess
from pathlib import Path

import pytest

from utils.path_policy import PathPolicyError, is_path_within, validate_command_paths


def _validate(
    command: str,
    params: dict[str, object],
    *,
    project_root: Path | None = None,
    cwd: Path,
    trusted_roots: list[Path] | None = None,
    temp_root: Path | None = None,
) -> dict[str, object]:
    return validate_command_paths(
        command,
        params,
        project_root=project_root,
        cwd=cwd,
        trusted_roots=trusted_roots or [],
        temp_root=temp_root or cwd / ".tmp",
    )


def test_parent_escape_is_rejected(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    project = workspace / "project"
    outside = workspace / "outside"
    project.mkdir(parents=True)
    outside.mkdir()
    with pytest.raises(PathPolicyError, match="outside allowed roots"):
        _validate(
            "save_project",
            {"path": "../outside/escape.kicad_pcb"},
            project_root=project,
            cwd=workspace,
        )


def test_absolute_outside_path_is_rejected(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    project = workspace / "project"
    outside = tmp_path / "outside"
    project.mkdir(parents=True)
    outside.mkdir()
    with pytest.raises(PathPolicyError, match="outside allowed roots"):
        _validate(
            "save_project",
            {"path": str(outside / "escape.kicad_pcb")},
            project_root=project,
            cwd=workspace,
        )


def test_symlink_escape_is_rejected(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    project = workspace / "project"
    outside = tmp_path / "outside"
    project.mkdir(parents=True)
    outside.mkdir()
    link = project / "link"
    try:
        link.symlink_to(outside, target_is_directory=True)
    except (OSError, NotImplementedError) as exc:
        pytest.skip(f"symlink creation unavailable: {exc}")

    with pytest.raises(PathPolicyError, match="outside allowed roots"):
        _validate(
            "save_project",
            {"path": str(link / "escape.kicad_pcb")},
            project_root=project,
            cwd=workspace,
        )


@pytest.mark.skipif(os.name != "nt", reason="Windows junction/reparse-point coverage")
def test_windows_junction_escape_is_rejected(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    project = workspace / "project"
    outside = tmp_path / "outside"
    project.mkdir(parents=True)
    outside.mkdir()
    junction = project / "junction"
    result = subprocess.run(
        ["cmd", "/c", "mklink", "/J", str(junction), str(outside)],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        pytest.skip(f"junction creation unavailable: {result.stderr or result.stdout}")
    try:
        with pytest.raises(PathPolicyError, match="outside allowed roots"):
            _validate(
                "save_project",
                {"path": str(junction / "escape.kicad_pcb")},
                project_root=project,
                cwd=workspace,
            )
    finally:
        subprocess.run(
            ["cmd", "/c", "rmdir", str(junction)],
            capture_output=True,
            text=True,
            check=False,
        )


def test_valid_project_path_is_canonicalized_and_allowed(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    project = workspace / "project"
    project.mkdir(parents=True)
    result = _validate(
        "save_project",
        {"path": "nested/../board.kicad_pcb"},
        project_root=project,
        cwd=workspace,
    )
    assert result["path"] == str((project / "board.kicad_pcb").resolve())


def test_explicit_trusted_import_export_roots_still_work(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    project = workspace / "project"
    trusted = tmp_path / "trusted"
    project.mkdir(parents=True)
    trusted.mkdir()
    source = trusted / "vendor.brd"
    source.write_bytes(b"vendor")
    result = _validate(
        "import_pcb",
        {
            "inputFile": str(source),
            "outputFile": str(trusted / "converted.kicad_pcb"),
        },
        project_root=project,
        cwd=workspace,
        trusted_roots=[trusted],
    )
    assert result["inputFile"] == str(source.resolve())
    assert result["outputFile"] == str((trusted / "converted.kicad_pcb").resolve())


def test_open_create_is_limited_to_cwd_or_explicit_trusted_root(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    trusted = tmp_path / "trusted"
    workspace.mkdir()
    trusted.mkdir()
    result = _validate(
        "create_project",
        {"path": str(trusted / "new-project"), "name": "demo"},
        cwd=workspace,
        trusted_roots=[trusted],
    )
    assert result["path"] == str((trusted / "new-project").resolve())


def test_open_create_allows_bounded_temp_workspace(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    temp_workspace = tmp_path / "temp"
    workspace.mkdir()
    temp_workspace.mkdir()

    result = _validate(
        "open_project",
        {"filename": str(temp_workspace / "test.kicad_pro")},
        cwd=workspace,
        temp_root=temp_workspace,
    )

    assert result["filename"] == str((temp_workspace / "test.kicad_pro").resolve())


def test_standalone_project_operation_allows_temp_before_project_is_loaded(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    temp_workspace = tmp_path / "temp"
    workspace.mkdir()
    temp_workspace.mkdir()

    result = _validate(
        "move_schematic_component",
        {"schematicPath": str(temp_workspace / "test.kicad_sch")},
        cwd=workspace,
        temp_root=temp_workspace,
    )

    assert result["schematicPath"] == str((temp_workspace / "test.kicad_sch").resolve())


def test_active_project_blocks_temp_escape_for_project_operation(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    project = workspace / "project"
    temp_workspace = tmp_path / "temp"
    project.mkdir(parents=True)
    temp_workspace.mkdir()

    with pytest.raises(PathPolicyError, match="outside allowed roots"):
        _validate(
            "move_schematic_component",
            {"schematicPath": str(temp_workspace / "test.kicad_sch")},
            project_root=project,
            cwd=workspace,
            temp_root=temp_workspace,
        )


def test_kicad_model_reference_is_not_rewritten_as_host_filesystem_path(tmp_path: Path) -> None:
    project = tmp_path / "project"
    footprint = project / "Local.pretty" / "Part.kicad_mod"
    footprint.parent.mkdir(parents=True)
    footprint.write_text("(footprint)")
    portable_model = "${KIPRJMOD}/Models.3dshapes/Part.step"

    result = _validate(
        "add_footprint_3d_model",
        {"footprintPath": str(footprint), "modelPath": portable_model},
        project_root=project,
        cwd=project,
    )

    assert result["footprintPath"] == str(footprint.resolve())
    assert result["modelPath"] == portable_model


def test_import_3d_model_treats_source_model_as_real_filesystem_path(tmp_path: Path) -> None:
    project = tmp_path / "project"
    trusted = tmp_path / "trusted"
    project.mkdir()
    trusted.mkdir()
    model = trusted / "Part.step"
    model.write_bytes(b"step")

    result = _validate(
        "import_3d_model",
        {
            "modelPath": str(model),
            "projectPath": str(project),
            "libraryDir": "Models.3dshapes",
        },
        project_root=project,
        cwd=project,
        trusted_roots=[trusted],
    )

    assert result["modelPath"] == str(model.resolve())
    assert result["projectPath"] == str(project.resolve())
    assert result["libraryDir"] == str((project / "Models.3dshapes").resolve())


def test_remove_hierarchical_sheet_keeps_basename_identifier_verbatim(tmp_path: Path) -> None:
    project = tmp_path / "project"
    project.mkdir()
    parent = project / "root.kicad_sch"
    parent.write_text("(kicad_sch)")

    result = _validate(
        "remove_hierarchical_sheet",
        {"schematicPath": str(parent), "subsheetPath": "power.kicad_sch"},
        project_root=project,
        cwd=project,
    )

    assert result["schematicPath"] == str(parent.resolve())
    assert result["subsheetPath"] == "power.kicad_sch"


def test_snake_case_eagle_paths_and_path_lists_are_contained(tmp_path: Path) -> None:
    project = tmp_path / "project"
    trusted = tmp_path / "trusted"
    project.mkdir()
    trusted.mkdir()
    eagle = trusted / "board.brd"
    eagle.write_bytes(b"eagle")

    eagle_result = _validate(
        "import_eagle_project",
        {"board_file": str(eagle), "output_dir": str(project / "converted")},
        project_root=project,
        cwd=project,
        trusted_roots=[trusted],
    )
    assert eagle_result["board_file"] == str(eagle.resolve())
    assert eagle_result["output_dir"] == str((project / "converted").resolve())

    list_result = _validate(
        "list_libraries",
        {"search_paths": [str(trusted)]},
        project_root=project,
        cwd=project,
        trusted_roots=[trusted],
    )
    assert list_result["search_paths"] == [str(trusted.resolve())]

    outside = tmp_path / "outside"
    outside.mkdir()
    with pytest.raises(PathPolicyError, match="outside allowed roots"):
        _validate(
            "enrich_datasheets",
            {"schematic_path": str(outside / "main.kicad_sch"), "dry_run": True},
            project_root=project,
            cwd=project,
        )


def test_windows_case_and_drive_comparison_is_not_prefix_based() -> None:
    assert is_path_within(
        r"C:\Work\Project\board.kicad_pcb",
        r"c:\work\project",
        path_module=ntpath,
    )
    assert not is_path_within(
        r"D:\Work\Project\board.kicad_pcb",
        r"C:\Work\Project",
        path_module=ntpath,
    )
    assert not is_path_within(
        r"C:\Work\Project-Escape\board.kicad_pcb",
        r"C:\Work\Project",
        path_module=ntpath,
    )
