#!/usr/bin/env python3
"""The license, copied where the installers and the user guide read it.

Tauri hands one license file to every bundle: the disk image's license
pane, the NSIS installer and the MSI (which wraps a non-RTF file's lines
into RTF paragraphs) all show it as it is. This copies the repository's
LICENSE into apps/heeler-app/src-tauri/license.txt, which tauri.conf.json
names, and into the user guide's legal/license.md, which Help > Legal
Documents opens. The MPL's plain text is already Markdown except its
title, which is underlined: the guide's page writes it as a "# " heading,
the form every chapter opens with (the help kit reads it), and changes no
word. It must stay ASCII: the disk image's license pane reads the file as
MacRoman, and ASCII decodes the same either way.

python3 scripts/license_text.py          # write both copies
python3 scripts/license_text.py --check  # exit 1 if either is stale

The test apps/heeler-app/src-tauri/tests/license_text.rs runs the check.
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "LICENSE"
INSTALLER = ROOT / "apps" / "heeler-app" / "src-tauri" / "license.txt"
GUIDE = ROOT / "docs" / "user-guide" / "legal" / "license.md"


def rendered() -> str:
    text = SOURCE.read_text(encoding="utf-8").replace("\r\n", "\n")
    if not text.isascii():
        sys.exit(f"error: {SOURCE} is not ASCII; the disk image's license pane would garble it")
    return text if text.endswith("\n") else text + "\n"


def as_chapter(text: str) -> str:
    """The license with its underlined title written as a "# " heading."""
    title, rule, rest = text.split("\n", 2)
    if not rule or set(rule) != {"="}:
        sys.exit(f"error: {SOURCE} does not open with an underlined title")
    return f"# {title}\n{rest}"


def main() -> None:
    text = rendered()
    check = "--check" in sys.argv[1:]
    for target, want in [(INSTALLER, text), (GUIDE, as_chapter(text))]:
        if check:
            have = target.read_text(encoding="utf-8") if target.exists() else ""
            if have != want:
                sys.exit(f"error: {target.relative_to(ROOT)} is stale; run python3 scripts/license_text.py")
            continue
        target.write_text(want, encoding="utf-8")
        print(f"wrote {target.relative_to(ROOT)} ({len(want.encode())} bytes)")


if __name__ == "__main__":
    main()
