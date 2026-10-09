#!/usr/bin/env python3
"""Builds the Heeler help kit: the user guide packaged for the AI
assistants people already use, so "how do I ... in Heeler?" is answered
from Heeler's own guide rather than from memory of other editors.

    python scripts/build_help_kit.py
    python scripts/build_help_kit.py --out some/folder

2026-09-28: answer those questions through the assistants people
already use, and give users instructions, with nothing to maintain and
no account anywhere. Three files, each attached to every GitHub release
by release.py and reachable at releases/latest/download/<name>:

heeler-help-kit.zip a Claude Skill: the ZIP's top level is the heeler-help
folder (heeler-help/SKILL.md plus heeler-help/references/), which is what
Claude's "Upload a skill" reads, so a Claude user uploads the download as it
is. heeler-user-guide.md the whole guide as one file, for a ChatGPT Project
or a Gemini Gem, which take files rather than folders.
heeler-help-instructions.txt the same instructions SKILL.md carries, as
plain text to paste into the Project's or the Gem's instructions.

Three downloads rather than one kit a user unzips first: a Claude user
needs the skill ZIP whole, and a ChatGPT or Gemini user needs two plain
files, so nobody has to unpack, find and re-zip anything.

The chapters come from the bundled guide in its own order (the order the
Help viewer's sidebar draws, docstree.ts: each README's links, folders
followed downward, pages no README links appended sorted), with the
screenshot placeholder notes and image references taken out (the images
are not included) and two long legal texts left out that answer no
question about using Heeler: the generated third-party notices and the
CDDL. The version is the workspace Cargo.toml's. The output is
deterministic: the same guide gives byte-identical files, ZIP included
(sorted entries, fixed timestamps and permissions).

The files land in target/release/bundle/help-kit/, beside the
installers dist.py leaves in target/release/bundle/ (target/ is
ignored by git). Each build overwrites its three files.
"""

from __future__ import annotations

import argparse
import re
import sys
import zipfile
from pathlib import Path

import latest_json as manifest

REPO_ROOT = Path(__file__).resolve().parent.parent
GUIDE = REPO_ROOT / "docs" / "user-guide"
OUT = REPO_ROOT / "target" / "release" / "bundle" / "help-kit"

SKILL_NAME = "heeler-help"
KIT_ZIP = "heeler-help-kit.zip"
GUIDE_FILE = "heeler-user-guide.md"
INSTRUCTIONS_FILE = "heeler-help-instructions.txt"
# The release files, in the order the release lists them.
RELEASE_FILES = (KIT_ZIP, GUIDE_FILE, INSTRUCTIONS_FILE)

# Long legal texts that answer no question about using Heeler.
EXCLUDED = {"legal/third-party-notices.md", "legal/cddl.md"}

# 1980-01-01, the earliest time a ZIP can carry: the same guide gives
# the same bytes whenever and wherever it is built.
ZIP_TIME = (1980, 1, 1, 0, 0, 0)

DESCRIPTION = (
    "Answers questions about using the Heeler photo editor (a node-based RAW editor), such as "
    "how to do something in Heeler, what a Heeler control, panel, node, menu command or "
    "preference does, and where to find it. Use it whenever the user asks how to edit, "
    "adjust, mask, export, organize or script photographs in Heeler, or names a Heeler "
    "tool. Answers come from the Heeler user guide in references/."
)

PLACEHOLDER = re.compile(r"screenshot placeholder", re.IGNORECASE)
IMAGE = re.compile(r"!\[[^\]]*\]\([^)]*\)[ \t]*")
FENCE = re.compile(r"^\s*(```|~~~)")
LINK = re.compile(r"\[[^\]]*\]\(([^)\s]+)\)")


def rules(version: str) -> list[str]:
    """The instructions both SKILL.md and the pasted text carry."""
    shown = manifest.display_version(version)
    return [
        f"You answer questions about using Heeler, a node-based RAW photo editor for macOS, Windows and Linux. This help was built from the user guide of Heeler {shown} (version {version}).",
        "",
        "Rules:",
        "1. Answer only from the Heeler user guide provided with these instructions. Do not fill gaps from what you know of other photo editors: their tools, menus and shortcuts are not Heeler's.",
        "2. Cite the chapter you used by its title, for example: (see the Sky Rescue chapter).",
        "3. Suggest the most direct tool for exactly what was asked. Lead with the simplest one and mention at most one alternative.",
        "4. Never assume a mode, look or workflow the user did not mention. Do not suggest Black and White for a color photograph unless they ask for black and white: to darken a sky in a color photograph, the chapters are Sky Rescue and Color Tune.",
        "5. If the guide does not cover the question, say so plainly rather than guess at controls, menus or shortcuts.",
        "6. You cannot see the user's Heeler window. Work from what they describe, and when the answer depends on what is on their screen (the workspace, the selected layer or node), ask one short question.",
        "7. Keep answers short and in numbered steps, with controls named exactly as the guide writes them.",
        "8. The guide writes shortcuts with Ctrl; on macOS that is Command.",
        "9. Use US spelling.",
    ]


def read_guide() -> dict[str, str]:
    """Every chapter the kit carries, by its path under the guide."""
    pages = {}
    for path in sorted(GUIDE.rglob("*.md")):
        rel = path.relative_to(GUIDE).as_posix()
        if rel in EXCLUDED:
            continue
        pages[rel] = path.read_text(encoding="utf-8").replace("\r\n", "\n")
    return pages


def title_of(rel: str, text: str) -> str:
    for line in text.splitlines():
        if line.startswith("# "):
            return line[2:].replace("`", "").replace("*", "").strip()
    return rel


def resolve(src: str, href: str) -> str:
    """A link in `src` against the guide root, as docstree.ts does."""
    href = href.split("#", 1)[0]
    if href.startswith("/"):
        return href[1:]
    out = src.split("/")[:-1]
    for part in href.split("/"):
        if part in ("", "."):
            continue
        if part == "..":
            if out:
                out.pop()
        else:
            out.append(part)
    return "/".join(out)


def folder_of(rel: str) -> str:
    return rel.rsplit("/", 1)[0] if "/" in rel else ""


def guide_order(pages: dict[str, str]) -> list[str]:
    """The chapters in the Help viewer's sidebar order (docstree.ts)."""
    placed: set[str] = set()

    def branch(readme: str, depth: int) -> list:
        placed.add(readme)
        children: list = []
        if depth > 5:
            return [readme, children]
        here = folder_of(readme)
        for href in LINK.findall(pages[readme]):
            if not href.split("#", 1)[0].endswith(".md") or re.match(r"^[a-z]+://", href, re.IGNORECASE):
                continue
            link = resolve(readme, href)
            if link in placed or link not in pages:
                continue
            there = folder_of(link)
            if here and not (there == here or there.startswith(f"{here}/")):
                continue
            if link == "README.md" or link.endswith("/README.md"):
                children.append(branch(link, depth + 1))
            else:
                placed.add(link)
                children.append([link, []])
        return [readme, children]

    tree: list = []
    if "README.md" in pages:
        root = branch("README.md", 0)
        tree = [["README.md", []], *root[1]]
    for rel in sorted(p for p in pages if p not in placed):
        parent = next((n for n in tree if n[0].endswith("README.md") and folder_of(n[0]) == folder_of(rel)), None)
        (parent[1] if parent else tree).append([rel, []])

    def flatten(nodes: list) -> list[str]:
        return [name for node in nodes for name in (node[0], *flatten(node[1]))]

    return flatten(tree)


def clean(text: str) -> str:
    """A chapter without its screenshot notes or image references."""
    out: list[str] = []
    fenced = False
    for line in text.split("\n"):
        if FENCE.match(line):
            fenced = not fenced
        if not fenced:
            if PLACEHOLDER.search(line):
                continue
            if IMAGE.search(line):
                stripped = IMAGE.sub("", line)
                if not stripped.strip() or stripped.strip() in ("-", "*"):
                    continue
                line = stripped
        out.append(line.rstrip())
    joined = re.sub(r"\n{3,}", "\n\n", "\n".join(out)).strip("\n")
    return joined + "\n"


def summary_of(text: str) -> str:
    """One line on what the chapter covers: the first sentence of its
    introduction (a paragraph can be wrapped over several lines), or,
    for a page that opens straight into sections (the scripting
    reference), the names of its first sections."""
    fenced = False
    paragraph: list[str] = []
    sections: list[str] = []
    for line in text.split("\n") + [""]:
        if FENCE.match(line):
            fenced = not fenced
            continue
        stripped = line.strip()
        if fenced:
            continue
        if stripped.startswith("## "):
            if paragraph:
                break
            sections.append(stripped[3:].replace("`", "").replace("*", "").strip())
            continue
        if sections:
            continue
        if not stripped:
            if paragraph:
                break
            continue
        if not paragraph and (stripped.startswith(("#", ">", "|", "- ", "* ", "<")) or re.match(r"^\d+\.", stripped)):
            continue
        paragraph.append(stripped)
    if not paragraph:
        if not sections:
            return ""
        shown = ", ".join(sections[:8])
        return f"Covers {shown}" + (", and more." if len(sections) > 8 else ".")
    plain = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", " ".join(paragraph))
    plain = plain.replace("**", "").replace("`", "").replace("*", "")
    sentence = re.split(r"(?<=[.!?])\s", plain, maxsplit=1)[0]
    return sentence if len(sentence) <= 220 else sentence[:217].rstrip() + "..."


def demote(text: str) -> str:
    """Headings one level down, outside code, so each chapter sits under
    the heading naming its path in the single file."""
    out = []
    fenced = False
    for line in text.split("\n"):
        if FENCE.match(line):
            fenced = not fenced
        if not fenced and re.match(r"^#{1,5} ", line):
            line = "#" + line
        out.append(line)
    return "\n".join(out)


def skill_md(version: str, order: list[str], pages: dict[str, str]) -> str:
    lines = [
        "---",
        f"name: {SKILL_NAME}",
        f"description: \"{DESCRIPTION}\"",
        "---",
        "",
        "# Heeler help",
        "",
        *rules(version),
        "",
        "How to answer: pick the chapters in the index below that match the question, read them from references/, then answer from what they say. The index is in the guide's own order.",
        "",
        "## Reference index",
        "",
    ]
    for rel in order:
        summary = summary_of(pages[rel])
        line = f"- `references/{rel}`: {title_of(rel, pages[rel])}"
        lines.append(f"{line}. {summary}" if summary else line)
    return "\n".join(lines) + "\n"


def instructions_txt(version: str) -> str:
    return "\n".join([
        *rules(version),
        "",
        f"The user guide is the attached file {GUIDE_FILE}. Each chapter in it starts with a heading naming its file, such as adjustments/sky-rescue.md, followed by the chapter's title. Search it for the chapters that match the question, then answer from what they say.",
    ]) + "\n"


def single_file(version: str, order: list[str], pages: dict[str, str]) -> str:
    shown = manifest.display_version(version)
    parts = [
        f"# Heeler user guide ({shown}, version {version})",
        "",
        "Every chapter of the Heeler user guide in one file, in the guide's own order. Each chapter starts with a heading naming its file.",
        "",
    ]
    for rel in order:
        parts += [f"# {rel}", "", demote(pages[rel]).rstrip("\n"), ""]
    return "\n".join(parts)


def zip_bytes(files: dict[str, str]) -> bytes:
    """The ZIP, deterministic: sorted entries, fixed time and modes."""
    import io

    folders = sorted({"/".join(name.split("/")[:i]) + "/" for name in files for i in range(1, name.count("/") + 1)})
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        for name in sorted([*folders, *files]):
            info = zipfile.ZipInfo(name, ZIP_TIME)
            info.create_system = 3
            if name.endswith("/"):
                info.external_attr = (0o40755 << 16) | 0x10
                archive.writestr(info, b"")
            else:
                info.external_attr = 0o100644 << 16
                info.compress_type = zipfile.ZIP_DEFLATED
                archive.writestr(info, files[name].encode("utf-8"), compresslevel=9)
    return buffer.getvalue()


def build(out: Path = OUT, version: str | None = None) -> dict[str, Path]:
    """Writes the three release files into `out`; returns them by name."""
    version = version or manifest.workspace_version()
    manifest.parse_version(version)
    pages = {rel: clean(text) for rel, text in read_guide().items()}
    order = guide_order(pages)
    skill = {f"{SKILL_NAME}/SKILL.md": skill_md(version, order, pages)}
    skill.update({f"{SKILL_NAME}/references/{rel}": text for rel, text in pages.items()})
    out.mkdir(parents=True, exist_ok=True)
    written = {
        KIT_ZIP: out / KIT_ZIP,
        GUIDE_FILE: out / GUIDE_FILE,
        INSTRUCTIONS_FILE: out / INSTRUCTIONS_FILE,
    }
    written[KIT_ZIP].write_bytes(zip_bytes(skill))
    written[GUIDE_FILE].write_bytes(single_file(version, order, pages).encode("utf-8"))
    written[INSTRUCTIONS_FILE].write_bytes(instructions_txt(version).encode("utf-8"))
    return written


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0])
    parser.add_argument("--out", type=Path, default=OUT, help=f"where the kit is written (default {OUT.relative_to(REPO_ROOT)})")
    args = parser.parse_args()
    for name, path in build(args.out).items():
        print(f"{path}  ({path.stat().st_size / 1e3:.1f} KB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
