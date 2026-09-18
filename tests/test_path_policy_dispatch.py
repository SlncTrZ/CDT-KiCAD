"""Integration test proving path policy runs before command dispatch."""

from pathlib import Path
import sys
from unittest.mock import MagicMock

sys.modules.setdefault("sexpdata", MagicMock())

from kicad_interface import KiCADInterface


def test_dispatch_rejects_escape_before_handler_runs(tmp_path: Path) -> None:
    project = tmp_path / "project"
    outside = tmp_path / "outside"
    project.mkdir()
    outside.mkdir()

    iface = KiCADInterface.__new__(KiCADInterface)
    iface._current_project_path = project
    iface.session_board_path = None
    handler = MagicMock(return_value={"success": True})
    iface.command_routes = {"get_board_2d_view": handler}

    result = iface.handle_command(
        "get_board_2d_view",
        {"pcbPath": str(outside / "board.kicad_pcb")},
    )

    assert result["success"] is False
    assert result["kind"] == "authorization_error"
    handler.assert_not_called()
