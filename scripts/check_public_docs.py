#!/usr/bin/env python3
"""Validate KiCAD public release docs using stdlib only (CI-safe)."""

from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DOC_LINK = re.compile(r"!?\[[^\]]*\]\(([^)]+)\)")


def main() -> None:
    package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    version = package["version"]
    assert re.fullmatch(r"0\.\d+\.\d+", version), version
    readme = (ROOT / "README.md").read_text(encoding="utf-8")
    release = ROOT / "docs/RELEASE_AND_DEPLOYMENT.md"
    assert release.is_file()
    assert "docs/RELEASE_AND_DEPLOYMENT.md" in readme
    contents = release.read_text(encoding="utf-8")
    assert version in contents and f"v.{version}" in contents
    assert "rollback" in contents.lower()

    tracked = subprocess.check_output(
        ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
        cwd=ROOT,
    ).split(b"\0")
    missing = []
    for encoded in tracked:
        if not encoded or not encoded.lower().endswith((b".md", b".mdx", b".rst")):
            continue
        if encoded.startswith(b"_private/"):
            continue
        file = ROOT / encoded.decode("utf-8")
        if not file.is_file():
            continue
        for match in DOC_LINK.finditer(file.read_text(encoding="utf-8")):
            target = match.group(1).split("#", 1)[0].split("?", 1)[0].strip("<>")
            if not target or target.startswith(
                ("/", "#", "https:", "http:", "mailto:", "data:")
            ):
                continue
            if not (file.parent / target.replace("%20", " ")).exists():
                missing.append(f"{file.relative_to(ROOT)} -> {target}")
    if missing:
        raise SystemExit("Missing documentation targets:\n" + "\n".join(missing[:20]))
    print("PUBLIC_DOCS_CHECK=PASS", version)


if __name__ == "__main__":
    main()
