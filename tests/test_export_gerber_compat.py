"""Regression tests for legacy export_gerber artifact truth."""

import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).parent.parent / "python"))

from kicad_interface import KiCADInterface  # noqa: E402


def _iface(board_path: Path) -> KiCADInterface:
    iface = KiCADInterface.__new__(KiCADInterface)
    iface.board = MagicMock()
    iface.board.GetFileName.return_value = str(board_path)
    return iface


def test_legacy_export_gerber_uses_cli_and_returns_real_files(tmp_path: Path) -> None:
    board_path = tmp_path / "board.kicad_pcb"
    board_path.write_text("(kicad_pcb)\n", encoding="utf-8")
    output = tmp_path / "fab"
    output.mkdir()
    iface = _iface(board_path)

    def fake_gerbers(params):
        assert params == {
            "outputDir": str(output),
            "boardPath": str(board_path.resolve()),
            "layers": ["F.Cu", "B.Cu"],
            "useDrillFileOrigin": False,
            "noProtelExt": True,
        }
        (output / "board-F_Cu.gbr").write_text("G04 front*\n", encoding="utf-8")
        (output / "board-B_Cu.gbr").write_text("G04 back*\n", encoding="utf-8")
        (output / "board-job.gbrjob").write_text("{}\n", encoding="utf-8")
        return {
            "success": True,
            "outputDir": str(output),
            "files": ["board-F_Cu.gbr", "board-B_Cu.gbr", "board-job.gbrjob"],
        }

    with (
        patch.object(iface, "_current_board_path", return_value=str(board_path.resolve())),
        patch.object(iface, "_handle_export_gerbers", side_effect=fake_gerbers),
        patch.object(iface, "_handle_export_drill") as drill,
    ):
        result = iface._handle_export_gerber_compat(
            {
                "outputDir": str(output),
                "layers": ["F.Cu", "B.Cu"],
                "generateDrillFiles": False,
                "generateMapFile": False,
            }
        )

    assert result["success"] is True
    assert result["files"]["gerber"] == ["board-B_Cu.gbr", "board-F_Cu.gbr"]
    assert result["files"]["drill"] == []
    assert result["files"]["map"] == []
    assert not (output / "board-job.gbrjob").exists()
    drill.assert_not_called()


def test_legacy_export_gerber_refuses_false_success_with_no_artifacts(tmp_path: Path) -> None:
    board_path = tmp_path / "board.kicad_pcb"
    board_path.write_text("(kicad_pcb)\n", encoding="utf-8")
    output = tmp_path / "fab"
    output.mkdir()
    iface = _iface(board_path)

    with (
        patch.object(iface, "_current_board_path", return_value=str(board_path.resolve())),
        patch.object(
            iface,
            "_handle_export_gerbers",
            return_value={"success": True, "outputDir": str(output), "files": []},
        ),
    ):
        result = iface._handle_export_gerber_compat(
            {
                "outputDir": str(output),
                "layers": ["F.Cu"],
                "generateDrillFiles": False,
            }
        )

    assert result["success"] is False
    assert "no manufacturing files" in result["message"].lower()


def test_legacy_export_gerber_preserves_requested_drill_and_job_outputs(tmp_path: Path) -> None:
    board_path = tmp_path / "board.kicad_pcb"
    board_path.write_text("(kicad_pcb)\n", encoding="utf-8")
    output = tmp_path / "fab"
    output.mkdir()
    iface = _iface(board_path)

    def fake_gerbers(params):
        assert params["noProtelExt"] is False
        assert params["useDrillFileOrigin"] is True
        (output / "board-F_Cu.gtl").write_text("G04 front*\n", encoding="utf-8")
        (output / "board-job.gbrjob").write_text("{}\n", encoding="utf-8")
        return {"success": True, "outputDir": str(output)}

    with (
        patch.object(iface, "_current_board_path", return_value=str(board_path.resolve())),
        patch.object(iface, "_handle_export_gerbers", side_effect=fake_gerbers),
        patch.object(
            iface,
            "_handle_export_drill",
            return_value={"success": True, "files": ["board.drl"]},
        ) as drill,
    ):
        result = iface._handle_export_gerber_compat(
            {
                "outputDir": str(output),
                "layers": ["F.Cu"],
                "useProtelExtensions": True,
                "generateDrillFiles": True,
                "generateMapFile": True,
                "useAuxOrigin": True,
            }
        )

    assert result["success"] is True
    assert result["files"] == {
        "gerber": ["board-F_Cu.gtl"],
        "drill": ["board.drl"],
        "map": ["board-job.gbrjob"],
    }
    drill.assert_called_once()
