#!/usr/bin/env python3
"""Cuts a release in one command: from the built installers to a
published GitHub release carrying them, models.json and latest.json.

    python scripts/release.py dist/Heeler-26.2.1-macos.dmg dist/Heeler-26.2.1-windows.exe
    python scripts/release.py ... --dry-run

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

The update manifest is written before this runs: latest_json.py writes
latest.json at the repository's root from What's New, and it is reviewed
and committed (2026-10-10: "release.py simple uploads and makes the new
release, it no longer has to stage the latest.json"). This attaches the
committed file as it stands, refusing one with uncommitted changes, one
for another version, and one whose download URLs are not the installers
given here. Its notes go into the release body where release_body.md
beside this script says, under Updates, each under its What's New
heading (New, Fixes) when every bullet is found there, as one list when
the review changed one; the rest of the body is the template, and the
"Which file" list is written from the files actually uploaded (the
2026.2 body named the wrong macOS file by hand), followed by the help
kit's line.

The version is the workspace Cargo.toml's, which the installers carry,
and the tag is v<version>; a tag or release that already exists is
refused, since a number is never reused.

Every release also carries the help kit (build_help_kit.py,
2026-09-28): heeler-help-kit.zip, heeler-user-guide.md and
heeler-help-instructions.txt, built here from this checkout's the
bundled guide, so the kit behind releases/latest/download/ is always
the guide of the latest release. The release is marked Latest;
--pre-release marks it a pre-release instead, which the redirect skips.
models.json comes from the published model manifest and must name no
releases/latest/download URL. After publishing, every uploaded file is
fetched by HEAD.

The release is tagged on the commit this checkout is at, the one the
installers were built from (dist.py stamps its hash into them), not on a
branch: main is behind until the release is live, and a branch moves
(2026-10-10: "main is used as the bundle for a release, but the problem is
main is behind until I merge"). That commit must be clean and pushed to
origin's dev, or GitHub has nothing to tag. Last, once every upload
answers, main is fast-forwarded to that commit and pushed, which is what
makes the release live: the app and the website read latest.json from
main, so main moves only after the installers it names are up. main never
merges: if it has commits that commit lacks, the release stops before
publishing and says so. --no-merge leaves that last step to you; a
pre-release never moves main, since its latest.json must not reach it.

gh must be installed and signed in to the account that owns the
vagabond-burro organization.
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
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


def bullets(text: str) -> list[str]:
    """The manifest's notes as items: one "- " line each, any marker
    accepted, blank lines dropped, a bare line taken as an item."""
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


def sections(items: list[str], whats_new: str, version: str) -> list[tuple[str | None, list[str]]]:
    """The items under their What's New headings, in the manifest's order
    within each (2026-10-02, on the 26.4 notes: "separate bullet lists for
    what is new and bug fixes"). The manifest is a flat list, which is all
    the update dialog draws; the headings come from the section it was
    written from. When the review changed or added an item, so one is not
    found there, the body is one untitled list rather than a guess."""
    try:
        groups = manifest.whats_new_section(whats_new, version)
    except SystemExit:
        return [(None, items)]
    title_of = {manifest.site_links(item): title for title, group in groups for item in group}
    if not all(item in title_of for item in items):
        return [(None, items)]
    order = [title for title, _ in groups]
    return [(title, [i for i in items if title_of[i] == title]) for title in order if any(title_of[i] == title for i in items)]


def committed(path: Path) -> str | None:
    """None when the file is tracked and has no uncommitted change, else
    what is wrong; git missing or no repository is said as such."""
    try:
        done = subprocess.run(["git", "status", "--porcelain", "--", str(path)], cwd=REPO_ROOT, capture_output=True, text=True, check=False)
    except FileNotFoundError:
        return "git is not installed"
    if done.returncode != 0:
        return done.stderr.strip() or "not in a git repository"
    return "has uncommitted changes" if done.stdout.strip() else None


def platforms_match(doc: dict, names: dict[str, str], tag: str) -> str | None:
    """None when the manifest names exactly the update installers being
    uploaded (the MSI rides beside the .exe and is not one), else what
    differs."""
    want = {
        f"{DOWNLOADS}/{tag}/{name}"
        for ext, name in names.items()
        if ext != ".msi"
    }
    have = {entry.get("url", "") for entry in doc.get("platforms", {}).values()}
    if want == have:
        return None
    parts = []
    if have - want:
        parts.append(f"it names {', '.join(sorted(u.rsplit('/', 1)[-1] for u in have - want))}, which this release does not carry")
    if want - have:
        parts.append(f"it does not name {', '.join(sorted(u.rsplit('/', 1)[-1] for u in want - have))}")
    return "; ".join(parts)


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


def git(*args: str) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(["git", *args], cwd=REPO_ROOT, capture_output=True, text=True, check=False)
    except FileNotFoundError:
        sys.exit("git is not installed, or not on PATH")


def release_commit(merge: bool) -> str:
    """The commit this checkout is at, checked before anything is
    published: no uncommitted change to a tracked file, on origin's dev
    (GitHub tags only what it has), and, when main is to follow it,
    main able to fast-forward to it. Exits with the reason otherwise."""
    head = git("rev-parse", "HEAD")
    if head.returncode != 0:
        sys.exit(f"git rev-parse HEAD: {head.stderr.strip() or 'not in a git repository'}")
    sha = head.stdout.strip()
    dirty = git("status", "--porcelain", "--untracked-files=no")
    if dirty.stdout.strip():
        sys.exit("this checkout has uncommitted changes: commit them, rebuild if they reach the app, then release; the tag is the commit the installers were built from")
    for branch in (manifest.STAGE_BRANCH, *( [manifest.LIVE_BRANCH] if merge else [])):
        fetched = git("fetch", "--quiet", "origin", branch)
        if fetched.returncode != 0:
            sys.exit(f"git fetch origin {branch}: {fetched.stderr.strip()}")
    if git("merge-base", "--is-ancestor", sha, f"origin/{manifest.STAGE_BRANCH}").returncode != 0:
        sys.exit(f"{sha[:9]} is not on origin/{manifest.STAGE_BRANCH}: push it first (git push), since the tag is cut on GitHub")
    if merge and git("merge-base", "--is-ancestor", f"origin/{manifest.LIVE_BRANCH}", sha).returncode != 0:
        # Merge commits left on main by the pull requests of releases
        # before release.py moved main itself carry no change, and one
        # merge into dev brings them in (2026-10-10, the first run).
        if git("diff", "--quiet", f"{sha}...origin/{manifest.LIVE_BRANCH}").returncode == 0:
            sys.exit(f"origin/{manifest.LIVE_BRANCH} has commits {sha[:9]} lacks, but they change nothing (merges from earlier releases): bring them in with git merge origin/{manifest.LIVE_BRANCH}, then git push, and run this again")
        sys.exit(f"origin/{manifest.LIVE_BRANCH} has commits {sha[:9]} lacks, so it cannot fast-forward to the release: bring them into {manifest.STAGE_BRANCH} first, or release with --no-merge and merge by hand")
    return sha


def fast_forward_live(sha: str) -> str | None:
    """Pushes the release's commit to origin's main, a fast-forward only
    (git refuses anything else); None when it went, else why not."""
    done = git("push", "origin", f"{sha}:refs/heads/{manifest.LIVE_BRANCH}")
    return None if done.returncode == 0 else (done.stderr.strip() or "git push failed")


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
    parser.add_argument("--tag", help="the release tag (default v<Cargo.toml version>)")
    parser.add_argument("--title", help="the release title (default Heeler <version as shown>)")
    parser.add_argument("--target", help="the commit or branch the tag is cut on (default: the commit this checkout is at, which must be clean and on origin/dev)")
    parser.add_argument("--no-merge", action="store_true", help=f"leave {manifest.LIVE_BRANCH} where it is; by default it is fast-forwarded to the release's commit once the release is up, which makes it live")
    parser.add_argument("--pre-release", action="store_true", help="mark the release a pre-release: not Latest")
    parser.add_argument("--one-platform", action="store_true", help="allow a release with only one of the .dmg and .exe")
    parser.add_argument("--out", type=Path, help="also keep a copy of the release body here")
    parser.add_argument("--dry-run", action="store_true", help="check everything and print the body and manifest; publish nothing")
    args = parser.parse_args()

    version = args.tag.lstrip("v") if args.tag else manifest.workspace_version()
    manifest.parse_version(version)
    tag = args.tag or f"v{version}"
    shown = manifest.display_version(version)
    title = args.title or f"Heeler {shown}"

    doc = manifest.read_manifest()
    if manifest.parse_version(str(doc["version"])) != manifest.parse_version(version):
        sys.exit(f"latest.json is for {doc['version']}, not {version}: write it again with python scripts/latest_json.py")
    problem = committed(manifest.MANIFEST_FILE)
    if problem:
        sys.exit(f"latest.json {problem}: review it and commit it first, since main serves the committed file")
    items = bullets(str(doc["notes"]))
    if not items:
        sys.exit("latest.json: the notes are empty")
    groups = sections(items, manifest.WHATS_NEW.read_text(encoding="utf-8"), version)

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

    # Pinned before anything is published: a release that could not then
    # move main stops here, not after the installers are up.
    merge = not args.pre_release and not args.no_merge
    target = args.target or release_commit(merge)

    mismatch = platforms_match(doc, names, tag)
    if mismatch:
        sys.exit(f"latest.json does not match the installers given: {mismatch}; write it with --platforms to match, or give the installers it names")
    text = body(items, names, groups)
    doc_body = manifest.MANIFEST_FILE.read_text(encoding="utf-8")

    state = "pre-release" if args.pre_release else "release"
    print(text)
    print(doc_body, end="")
    print(f"# {tag} ({state}) \"{title}\" on {manifest.PUBLIC_REPO}, tagged on {target}:", file=sys.stderr)
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
    if merge:
        print(f"# then {manifest.LIVE_BRANCH} fast-forwards to {target[:9]}, which makes {shown} live", file=sys.stderr)
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
        flags = ["--title", title, "--notes-file", str(notes_path), "--target", target]
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
        print(f"# a pre-release: the redirect skips it; keep this latest.json off {manifest.LIVE_BRANCH}, which serves the current release", file=sys.stderr)
        return 0
    if not merge:
        print(f"# next: merge {manifest.STAGE_BRANCH} into {manifest.LIVE_BRANCH} to make {shown} live for the app and the website: {manifest.COMPARE_URL}", file=sys.stderr)
        print("#       then python scripts/latest_json.py --check, and Help > Check for Updates in the previous version", file=sys.stderr)
        return 0
    why = fast_forward_live(target)
    if why:
        print(f"# the release is up, but {manifest.LIVE_BRANCH} did not move: {why}", file=sys.stderr)
        print(f"#   fast-forward it by hand to make {shown} live: git push origin {target}:refs/heads/{manifest.LIVE_BRANCH}", file=sys.stderr)
        return 1
    print(f"# {manifest.LIVE_BRANCH} is at {target[:9]}: {shown} is live for the app and the website (raw can lag by five minutes)", file=sys.stderr)
    print("#   check with python scripts/latest_json.py --check, and Help > Check for Updates in the previous version", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
