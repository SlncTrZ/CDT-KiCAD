"""Regression tests for the legacy export_position_file compatibility route."""

import sys
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent.parent / "python"))

from kicad_interface import KiCADInterface  # noqa: E402


def _iface() -> KiCADInterface:
    return KiCADInterface.__new__(KiCADInterface)


def test_export_position_file_normalizes_legacy_vocabulary(tmp_path: Path) -> None:
    iface = _iface()
    output = tmp_path / "placement.csv"

    with patch.object(
        iface,
        "_handle_export_pos",
        return_value={"success": True, "outputPath": str(output)},
    ) as delegate:
        result = iface._handle_export_position_file(
            {
                "outputPath": str(output),
                "format": "CSV",
                "units": "inch",
                "side": "top",
            }
        )

    assert result["success"] is True
    delegate.assert_called_once_with(
        {
            "outputPath": str(output),
            "format": "csv",
            "units": "in",
            "side": "front",
        }
    )


def test_export_position_file_converts_csv_inches_to_mil(tmp_path: Path) -> None:
    iface = _iface()
    output = tmp_path / "placement.csv"

    def fake_export(params):
        assert params["format"] == "csv"
        assert params["units"] == "in"
        assert params["side"] == "both"
        output.write_text(
            'Ref,Val,Package,PosX,PosY,Rot,Side\n'
            '"R1","1k","R_0603_1608Metric",0.787402,-0.787402,0.000000,top\n',
            encoding="utf-8",
        )
        return {"success": True, "outputPath": str(output)}

    with patch.object(iface, "_handle_export_pos", side_effect=fake_export):
        result = iface._handle_export_position_file(
            {
                "outputPath": str(output),
                "format": "CSV",
                "units": "mil",
                "side": "both",
            }
        )

    assert result["success"] is True
    assert result["units"] == "mil"
    text = output.read_text(encoding="utf-8")
    assert "787.402000" in text
    assert "-787.402000" in text


def test_export_position_file_converts_ascii_inches_to_mil(tmp_path: Path) -> None:
    iface = _iface()
    output = tmp_path / "placement.pos"

    def fake_export(params):
        assert params["format"] == "ascii"
        assert params["units"] == "in"
        output.write_text(
            "### Footprint positions\n"
            "## Unit = inches, Angle = deg.\n"
            "# Ref     Val       Package                 PosX       PosY       Rot  Side\n"
            "R1        1k        R_0603_1608Metric     0.7874    -0.7874    0.0000  top\n"
            "## End\n",
            encoding="utf-8",
        )
        return {"success": True, "outputPath": str(output)}

    with patch.object(iface, "_handle_export_pos", side_effect=fake_export):
        result = iface._handle_export_position_file(
            {
                "outputPath": str(output),
                "format": "ASCII",
                "units": "mil",
                "side": "bottom",
            }
        )

    assert result["success"] is True
    assert result["units"] == "mil"
    text = output.read_text(encoding="utf-8")
    assert "## Unit = mils" in text
    assert "787.4000" in text
    assert "-787.4000" in text
