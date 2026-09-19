"""Cross-platform KiCad paths used only by native integration tests."""

from __future__ import annotations

from pathlib import Path

from utils.kicad_roots import kicad_install_roots


def find_kicad_data_path(*parts: str) -> Path | None:
    candidates = [
        *(root / "share" / "kicad" / Path(*parts) for root in kicad_install_roots()),
        Path("/usr/share/kicad").joinpath(*parts),
        Path("/usr/local/share/kicad").joinpath(*parts),
    ]
    return next((path for path in candidates if path.exists()), None)


def find_kicad_python() -> Path | None:
    for root in kicad_install_roots():
        for relative in (Path("bin/python.exe"), Path("bin/python3.exe")):
            candidate = root / relative
            if candidate.is_file():
                return candidate
    return None
