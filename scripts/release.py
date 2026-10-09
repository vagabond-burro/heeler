#!/usr/bin/env python3
"""Cuts a release in one command: from the built installers to a
published GitHub release carrying them, models.json and latest.json,
with the update manifest staged on the public repo's dev branch.

    python scripts/release.py dist/Heeler-26.2.1-macos.dmg dist/Heeler-26.2.1-windows.exe --notes-file NOTES.md
    python scripts/release.py ... --notes "- What is new.
    - And what else." --dry-run

2026-09-16: "I would like to get this down to a single script release
process." The arguments are the installers dist.py built, one per platform,
told apart by extension: .dmg is macOS (Apple Silicon), .exe is the Windows
installer, .msi rides beside it for people who want one, and .AppImage is
Linux (x86_64), optional until the Linux build ships. Each is uploaded
under its release name, Heeler-<version>-macos.dmg,
Heeler-<version>-windows.exe and Heeler-<version>-linux.AppImage, so the
manifest can be written before the release exists and publish with it in
one command: no manual draft or attach-after step, no window in which an
app finds a release with no manifest. A file whose name carries another
version is refused.

The notes are a bullet list of what is new, from --notes-file or
--notes, and they go into the release body where release_body.md beside
this script says, under Updates; the rest of the body is the template,
and the "Which file" list is written from the files actually uploaded
(the 2026.2 body named the wrong macOS file by hand), followed by the
help kit's line. The same bullets, one a line, are the manifest's
notes: the app draws them as a list (2026-09-16, on the 2026.2.1
dialog: "The list is coming in as one huge paragraph").

The version is the workspace Cargo.toml's, which the installers carry,
and the tag is v<version>; a tag or release that already exists is
refused, since a number is never reused.

Every release also carries the help kit (build_help_kit.py,
2026-09-28): heeler-help-kit.zip, heeler-user-guide.md and
heeler-help-instructions.txt, built here from this checkout's the
bundled guide, so the kit behind releases/latest/download/ is always
the guide of the latest release. The release is marked Latest;
--pre-release marks it a pre-release instead, which the redirect skips
and which is never staged on dev. models.json comes from the published
model manifest and must name no releases/latest/download URL. After
publishing, every uploaded file is fetched by HEAD, and latest.json is
committed to dev through latest_json.py. The last step stays yours:
merge dev into main when the release is checked, which is what makes it
live for the app and the website.

gh must be installed and signed in to the account that owns the
vagabond-burro organization.
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
import tempfile
from pathlib import Path

import build_help_kit as help_kit
import latest_json as manifest

REPO_ROOT = Path(__file__).resolve().parent.parent
TEMPLATE = Path(__file__).resolve().parent / "release_body.md"
MODELS = REPO_ROOT / "docs" / "models.json"
DOWNLOADS = f"https://github.com/{manifest.PUBLIC_REPO}/releases/download"

# The release name for each kind of file, and how the body names it.
KINDS = {
    ".dmg": ("Heeler-{version}-macos.dmg", "macOS (Apple Silicon)"),
    ".exe": ("Heeler-{version}-windows.exe", "Windows"),
    ".msi": ("Heeler-{version}-windows.msi", "Windows (MSI)"),
    ".appimage": ("Heeler-{version}-linux.AppImage", "Linux (AppImage, x86_64)"),
}
# The help kit's line under "Which file", after the installers.
HELP_KIT_LINE = (
    f"- **Ask an AI about Heeler:** `{help_kit.KIT_ZIP}` for Claude, `{help_kit.GUIDE_FILE}` and "
    f"`{help_kit.INSTRUCTIONS_FILE}` for ChatGPT and Gemini "
    "([how to use them](https://www.heeler.app/docs/ask-an-ai/))"
)
# The order the body lists them in.
KIND_ORDER = (".dmg", ".exe", ".msi", ".appimage")
# A release wants both of these; the MSI and the AppImage are optional
# (2026-09-20: Linux builds are right around the corner).
REQUIRED = {".dmg", ".exe"}
# Tauri's bundler names: Heeler_26.3.0_aarch64.dmg, Heeler_26.3.0_x64-setup.exe,
# Heeler_26.3.0_x64_en-US.msi; on Linux the product name and Debian's arch
# word, Heeler_26.3.0_amd64.AppImage (Tauri 2.11 source; the crate name
# is read too in case a bundler version names it heeler-desktop_...).
BUNDLER_INSTALLER = re.compile(r"^(?:Heeler|heeler-desktop)_(?P<version>\d+\.\d+(?:\.\d+)?)_(?P<arch>[^_.-]+)(?:[-_].*)?\.(?:dmg|exe|msi|AppImage)$", re.IGNORECASE)
# The bundler's architecture word each kind is released under.
BUNDLER_ARCH = {".dmg": "aarch64", ".exe": "x64", ".msi": "x64", ".appimage": "amd64"}
# The manifest key each kind's release name answers to.
PLATFORM_KEY = {".dmg": "darwin-aarch64", ".exe": "windows-x86_64", ".msi": "windows-x86_64", ".appimage": "linux-x86_64"}


def sections(text: str) -> list[tuple[str | None, list[str]]]:
    """The notes as titled lists. A Markdown heading ("## New") starts a
    section (2026-10-02, on the 26.4 notes: "separate bullet lists for what
    is new and bug fixes"); items before any heading belong to an untitled
    one. Each item is read the way bullets reads it."""
    groups: list[tuple[str | None, list[str]]] = [(None, [])]
    for raw in text.splitlines():
        line = raw.strip()
        if line.startswith("#"):
            title = line.lstrip("#").strip()
            if title:
                groups.append((title, []))
            continue
        groups[-1][1].extend(bullets(line))
    return [(t, items) for t, items in groups if items]


def bullets(text: str) -> list[str]:
    """The notes as a clean bullet list: one "- " line per item, any
    marker accepted, blank lines dropped, a bare line taken as an item.
    Heading lines title a section (sections()) and are not items."""
    items = []
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        for marker in ("- ", "* ", "• ", "-", "*", "•"):
            if line.startswith(marker):
                line = line[len(marker):].strip()
                break
        line = re.sub(r"^\d+[.)]\s+", "", line)
        if line:
            items.append(line)
    return items


def notes_text(items: list[str]) -> str:
    """The bullets as the manifest carries them: one a line, marked, so
    the app's dialog can draw them as the list they are and an older
    app, which keeps line breaks, still shows one a line."""
    return "\n".join(f"- {item}" for item in items)


def classify(paths: list[Path], version: str) -> dict[str, Path]:
    """Each given installer by its extension, checked: it exists, its
    kind is known, no kind is given twice, and a version in its name is
    this one."""
    kinds: dict[str, Path] = {}
    for path in paths:
        if not path.is_file():
            sys.exit(f"{path}: no such file")
        ext = path.suffix.lower()
        if ext not in KINDS:
            sys.exit(f"{path}: not an installer this script knows (.dmg, .exe, .msi or .AppImage)")
        if ext in kinds:
            sys.exit(f"two {ext} files given: {kinds[ext]} and {path}; one per platform")
        # Both dist.py's names and Tauri's names carry a version. Check
        # the MSI too, before renaming could disguise an older build.
        if path.name.startswith(("Heeler_", "heeler-desktop_")):
            named = BUNDLER_INSTALLER.fullmatch(path.name)
            if not named:
                sys.exit(f"{path.name}: a Heeler bundler name this script does not read")
            if manifest.parse_version(named["version"]) != manifest.parse_version(version):
                sys.exit(f"{path.name} is named for {named['version']}, not {version}: the wrong installer for this release")
            expected = BUNDLER_ARCH[ext]
            if named["arch"].lower() != expected:
                sys.exit(f"{path.name}: expected {expected}; this release name would mislabel the architecture")
        elif path.name.startswith("Heeler-"):
            # The manifest reads the update installers' names; the MSI
            # is checked as if it were the .exe beside it.
            probe = path.with_suffix(".exe").name if ext == ".msi" else path.name
            key = manifest.installer_platform(probe, version)
            if key is None:
                sys.exit(f"{path.name}: a Heeler installer name this script does not read")
            expected = PLATFORM_KEY[ext]
            if key != expected:
                sys.exit(f"{path.name}: expected {expected}; this release name would mislabel the platform")
        kinds[ext] = path
    return kinds


def body(items: list[str], names: dict[str, str], groups: list[tuple[str | None, list[str]]] | None = None) -> str:
    """The release body: the template with the bullets under Updates and
    the file list from what is uploaded. With titled sections, each list
    goes under its own bold title; the manifest keeps one flat list,
    since the dialog in copies already installed draws only that."""
    template = TEMPLATE.read_text(encoding="utf-8")
    for slot in ("{{updates}}", "{{files}}", "{{signed}}"):
        if slot not in template:
            sys.exit(f"{TEMPLATE.name} has no {slot} slot")
    files = "\n".join([*(f"- **{KINDS[ext][1]}:** `{names[ext]}`" for ext in KIND_ORDER if ext in names), HELP_KIT_LINE])
    mac, win, linux = ".dmg" in names, ".exe" in names or ".msi" in names, ".appimage" in names
    windows = "the Windows installers are" if ".exe" in names and ".msi" in names else "the Windows installer is"
    if linux:
        # An AppImage carries no platform signature, so "all installers
        # are signed" would be false with one listed: name the signed
        # platforms and say what the AppImage offers instead.
        parts = []
        if mac:
            parts.append("The Mac installer is signed and notarized by Apple.")
        if win:
            parts.append(f"{windows[0].upper()}{windows[1:]} signed through Azure Artifact Signing.")
        parts.append("The Linux AppImage is not signed; verify it by the SHA-256 GitHub shows beside it, and mark it executable before running it.")
        signed = " ".join(parts)
    elif mac and win:
        count = "All" if len(names) > 2 else "Both"
        signed = f"{count} installers are signed. The Mac build is notarized by Apple; {windows} signed through Azure Artifact Signing."
    elif mac:
        signed = "The installer is signed and notarized by Apple."
    else:
        subject = "The installers are" if len(names) > 1 else "The installer is"
        signed = f"{subject} signed through Azure Artifact Signing."
    return (
        template.replace("{{updates}}", updates_text(items, groups))
        .replace("{{files}}", files)
        .replace("{{signed}}", signed)
    )


def updates_text(items: list[str], groups: list[tuple[str | None, list[str]]] | None) -> str:
    """The Updates slot: one list, or one titled list per section."""
    if not groups or all(title is None for title, _ in groups):
        return "\n".join(f"- {item}" for item in items)
    return "\n\n".join(
        (f"**{title}**\n" if title else "") + "\n".join(f"- {item}" for item in group)
        for title, group in groups
    )


def models_manifest() -> str:
    """The model manifest, checked: valid, and every URL tagged rather
    than through the latest redirect (the weights live on their own
    release)."""
    if not MODELS.is_file():
        sys.exit(f"{MODELS} is missing: the app reads models.json from every release")
    text = MODELS.read_text(encoding="utf-8")
    try:
        json.loads(text)
    except json.JSONDecodeError as error:
        sys.exit(f"{MODELS}: not JSON ({error})")
    if "releases/latest/download" in text:
        sys.exit(f"{MODELS} links through releases/latest/download; the weights must be linked by their own tag")
    return text


def release_exists(tag: str) -> bool:
    done = manifest.run_gh(["release", "view", tag, "--repo", manifest.PUBLIC_REPO, "--json", "tagName"])
    if done.returncode == 0:
        return True
    if done.stderr.strip().lower() == "release not found":
        return False
    sys.exit(f"gh release view {tag}: {done.stderr.strip()}")


def tag_exists(tag: str) -> bool:
    return manifest.gh_api(f"git/ref/tags/{tag}", missing_ok=True) is not None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0])
    parser.add_argument("installers", nargs="+", type=Path, help="the built installers: a .dmg, a .exe, optionally a .msi and a Linux .AppImage")
    parser.add_argument("--notes", help="what is new, as a bullet list")
    parser.add_argument("--notes-file", type=Path, help="a file holding the bullet list instead")
    parser.add_argument("--tag", help="the release tag (default v<Cargo.toml version>)")
    parser.add_argument("--title", help="the release title (default Heeler <version as shown>)")
    parser.add_argument("--target", default=manifest.LIVE_BRANCH, help=f"the public repo branch the tag is cut on (default {manifest.LIVE_BRANCH})")
    parser.add_argument("--branch", default=manifest.STAGE_BRANCH, help=f"the public repo branch latest.json is staged on (default {manifest.STAGE_BRANCH})")
    parser.add_argument("--pre-release", action="store_true", help="mark the release a pre-release: not Latest, not staged")
    parser.add_argument("--one-platform", action="store_true", help="allow a release with only one of the .dmg and .exe")
    parser.add_argument("--out", type=Path, help="also keep a copy of the release body here")
    parser.add_argument("--dry-run", action="store_true", help="check everything and print the body and manifest; publish nothing")
    args = parser.parse_args()

    version = args.tag.lstrip("v") if args.tag else manifest.workspace_version()
    manifest.parse_version(version)
    tag = args.tag or f"v{version}"
    shown = manifest.display_version(version)
    title = args.title or f"Heeler {shown}"

    if args.notes_file:
        raw = args.notes_file.read_text(encoding="utf-8")
    elif args.notes:
        raw = args.notes
    else:
        sys.exit("say what is new: --notes \"- ...\" or --notes-file NOTES.md")
    items, groups = bullets(raw), sections(raw)
    if not items:
        sys.exit("the notes are empty")

    given = classify(args.installers, version)
    if not REQUIRED.intersection(given):
        sys.exit("no .dmg or .exe given; an MSI is a companion and the AppImage is optional, so a release needs one of the two")
    missing = REQUIRED - set(given)
    if missing and not args.one_platform:
        sys.exit(f"no {', '.join(sorted(missing))} given; a release carries both installers (--one-platform to ship one)")
    names = {ext: KINDS[ext][0].format(version=version) for ext in given}
    models = models_manifest()

    if release_exists(tag):
        sys.exit(f"{tag} already exists on {manifest.PUBLIC_REPO}: a number is never reused, bump the version")
    if tag_exists(tag):
        sys.exit(f"the tag {tag} already exists on {manifest.PUBLIC_REPO} without a release; a number is never reused")

    text = body(items, names, groups)
    doc, strangers = manifest.manifest_for(tag, version, notes_text(items), list(names.values()))
    assert not strangers, strangers
    doc_body = json.dumps(doc, indent=2) + "\n"

    state = "pre-release" if args.pre_release else "release"
    print(text)
    print(doc_body, end="")
    print(f"# {tag} ({state}) \"{title}\" on {manifest.PUBLIC_REPO}, tagged on {args.target}:", file=sys.stderr)
    for ext, path in given.items():
        print(f"#   {names[ext]}  <- {path}  ({path.stat().st_size / 1e6:.1f} MB)", file=sys.stderr)
    print(f"#   latest.json ({', '.join(sorted(doc['platforms']))}), models.json <- {MODELS.relative_to(REPO_ROOT)}", file=sys.stderr)
    with tempfile.TemporaryDirectory() as folder:
        # Built now, dry run or not, so a guide the kit cannot be built
        # from stops the release before anything is published.
        for name, path in help_kit.build(Path(folder), version).items():
            print(f"#   {name}  <- {help_kit.GUIDE.relative_to(REPO_ROOT)}  ({path.stat().st_size / 1e3:.1f} KB)", file=sys.stderr)
    if args.out:
        args.out.write_text(text, encoding="utf-8")
        print(f"# wrote {args.out}", file=sys.stderr)
    if args.dry_run:
        print("# dry run: nothing published", file=sys.stderr)
        return 0

    with tempfile.TemporaryDirectory() as folder:
        stage = Path(folder)
        uploads = []
        for ext, path in given.items():
            copy = stage / names[ext]
            shutil.copyfile(path, copy)
            uploads.append(copy)
        (stage / "latest.json").write_text(doc_body, encoding="utf-8")
        (stage / "models.json").write_text(models, encoding="utf-8")
        uploads += [stage / "latest.json", stage / "models.json"]
        uploads += help_kit.build(stage, version).values()
        notes_path = stage / "body.md"
        notes_path.write_text(text, encoding="utf-8")
        flags = ["--title", title, "--notes-file", str(notes_path), "--target", args.target]
        flags += ["--prerelease"] if args.pre_release else ["--latest"]
        url = manifest.gh("release", "create", tag, *map(str, uploads), *flags).strip()
    print(f"# published {url or tag}", file=sys.stderr)

    failed = False
    for name in [*names.values(), "latest.json", "models.json", *help_kit.RELEASE_FILES]:
        link = f"{DOWNLOADS}/{tag}/{name}"
        problem = manifest.answers(link)
        if problem:
            print(f"# {link} does not answer ({problem})", file=sys.stderr)
            failed = True
        else:
            print(f"# {link} answers", file=sys.stderr)
    if failed:
        print("# an upload is missing from the release; fix it before merging", file=sys.stderr)
        return 1

    if args.pre_release:
        print(f"# a pre-release is not staged on {args.branch}; the redirect skips it and {manifest.LIVE_BRANCH} keeps the current release", file=sys.stderr)
        return 0
    commit = manifest.stage_manifest(doc_body, args.branch, f"latest.json: Heeler {shown} ({tag})")
    print(f"# staged latest.json on {args.branch}: {commit or 'already there'}", file=sys.stderr)
    print(f"# next: merge {args.branch} into {manifest.LIVE_BRANCH} to make {shown} live for the app and the website: {manifest.COMPARE_URL}", file=sys.stderr)
    print("#       then python scripts/latest_json.py --check, and Help > Check for Updates in the previous version", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
