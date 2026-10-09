"""Real KiCad persistence must preserve outline bounds used by recovery."""
import os
import pytest
from commands.board.outline import BoardOutlineCommands

pytestmark = pytest.mark.skipif(
    os.environ.get("KICAD_USE_REAL_PCBNEW") != "1",
    reason="requires native pcbnew",
)

@pytest.mark.parametrize("shape,params", [
    ("rectangle", {"width": 60, "height": 40, "centerX": 30, "centerY": 20}),
    ("circle", {"radius": 20, "centerX": 30, "centerY": 20}),
    ("rounded_rectangle", {"width": 60, "height": 40, "radius": 4, "centerX": 30, "centerY": 20}),
])
def test_outline_bounds_survive_native_save_reopen(tmp_path, shape, params):
    import pcbnew
    board = pcbnew.BOARD()
    result = BoardOutlineCommands(board).add_board_outline({"shape": shape, **params})
    assert result["success"], result
    def bounds(value):
        box = value.GetBoardEdgesBoundingBox()
        return box.GetX(), box.GetY(), box.GetWidth(), box.GetHeight()
    before = bounds(board)
    path = tmp_path / "outline.kicad_pcb"
    pcbnew.SaveBoard(str(path), board)
    reopened = pcbnew.LoadBoard(str(path))
    assert bounds(reopened) == before
