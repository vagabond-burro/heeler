#!/usr/bin/env python3
"""Writes the update manifest for the next release, latest.json at the
repository's root, for review before it is committed.

The app and the website read one file at one fixed URL,
https://raw.githubusercontent.com/vagabond-burro/heeler/main/latest.json.
Everything is in this one public repository now, so the manifest is an
ordinary file in it (2026-10-10: "a script that prepares the latest.json
with what the files paths will look like for the next release ... This
only creates the file, I have to manually review before committing").
Nothing here needs the release to exist, and nothing is uploaded or
committed:

    python scripts/latest_json.py              write latest.json
    python scripts/latest_json.py --print      show it, write nothing
    python scripts/latest_json.py --check      confirm main serves it live

The version is the workspace Cargo.toml's, the same one the binary
carries, and the tag is v<version>. The download URLs name the installers
the release will carry under the names dist.py and release.py give them:

    Heeler-<version>-macos.dmg            darwin-aarch64
    Heeler-<version>-windows.exe          windows-x86_64
    Heeler-<version>-linux.AppImage       linux-x86_64

--platforms names another set (macos, windows, linux; and macos-intel,
windows-arm64, linux-arm64 for platforms not built yet). release.py
refuses to publish installers that do not match the manifest, so a
platform left out here is one the release cannot carry by mistake.

The notes are the version's section of the user guide's What's New
(whats-new.md beside the guide), the same words Help > What's New shows:
every bullet of every subsection, New first, as one list, since the
update dialog draws a list only when every line is a bullet. A link into
the guide becomes the page's address on the website. Edit latest.json
freely before committing it: release.py takes the notes from it as they
stand.

The flow: run this, review latest.json, commit it; build the installers;
run release.py, which publishes the release with latest.json attached;
then merge dev into main, which is what makes the release live for the
app and the website. In that order: a merge before the release is
published points both at installers that are not public yet. --check
confirms the order held: main serves this version and every installer it
names answers.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
PUBLIC_REPO = "vagabond-burro/heeler"
LIVE_BRANCH = "main"
STAGE_BRANCH = "dev"
MANIFEST_PATH = "latest.json"
MANIFEST_FILE = REPO_ROOT / MANIFEST_PATH
WHATS_NEW = REPO_ROOT / "docs" / "whats-new.md"
# Where the website serves the user guide: user-guide/legal/license.md is
# the page legal/license/ under this address.
GUIDE_SITE = "https://www.heeler.app/docs/"
# What the app and the website read.
RAW_URL = f"https://raw.githubusercontent.com/{PUBLIC_REPO}/{LIVE_BRANCH}/{MANIFEST_PATH}"
# What the apps before 2026.2.1 read: the latest release's attachment.
REDIRECT_URL = f"https://github.com/{PUBLIC_REPO}/releases/latest/download/{MANIFEST_PATH}"
COMPARE_URL = f"https://github.com/{PUBLIC_REPO}/compare/{LIVE_BRANCH}...{STAGE_BRANCH}"

# The installers as the release page names them, with or without the
# version, one per platform; the manifest's key for each platform word.
INSTALLER = re.compile(
    r"^Heeler(?:-(?P<version>\d+\.\d+(?:\.\d+)?))?-(?P<platform>macos-intel|macos|windows-arm64|windows|linux-arm64|linux)(?:-setup)?\.(?:dmg|exe|AppImage)$"
)
PLATFORMS = {
    "macos": "darwin-aarch64",
    "macos-intel": "darwin-x86_64",
    "windows": "windows-x86_64",
    "windows-arm64": "windows-aarch64",
    # Tauri's updater asks for linux-<arch> from an AppImage.
    "linux": "linux-x86_64",
    "linux-arm64": "linux-aarch64",
}
EXTENSION = {"macos": "dmg", "macos-intel": "dmg", "windows": "exe", "windows-arm64": "exe", "linux": "AppImage", "linux-arm64": "AppImage"}
DEFAULT_PLATFORMS = ("macos", "windows", "linux")


def installer_name(platform: str, version: str) -> str:
    """The release name of a platform's installer."""
    return f"Heeler-{version}-{platform}.{EXTENSION[platform]}"


def installer_platform(name: str, version: str) -> str | None:
    """The manifest key an installer's name says it is for, None for a
    file that is not an installer; a name carrying another version is
    refused outright."""
    match = INSTALLER.match(name)
    if match is None:
        return None
    named = match.group("version")
    if named and parse_version(named) != parse_version(version):
        sys.exit(f"{name} is named for {named}, not {version}: the wrong installer for this release")
    return PLATFORMS[match.group("platform")]


def workspace_version() -> str:
    text = (REPO_ROOT / "Cargo.toml").read_text(encoding="utf-8")
    section = text.split("[workspace.package]", 1)[1].split("\n[", 1)[0]
    match = re.search(r'^version\s*=\s*"([^"]+)"', section, re.MULTILINE)
    if not match:
        sys.exit("Cargo.toml: no version under [workspace.package]")
    return match.group(1)


def parse_version(s: str) -> tuple[int, int, int]:
    """YY.UPDATE.PATCH as three integers, the app's own rule; a missing
    patch reads as zero."""
    parts = s.strip().lstrip("v").split(".")
    if len(parts) not in (2, 3) or not all(p.isdigit() for p in parts):
        sys.exit(f"unreadable version: {s!r} (expected YY.UPDATE or YY.UPDATE.PATCH)")
    yy, update = int(parts[0]), int(parts[1])
    patch = int(parts[2]) if len(parts) == 3 else 0
    return yy, update, patch


def display_version(version: str) -> str:
    """As the app shows it: 26.1.0 is 2026.1, 26.1.1 is 2026.1.1."""
    yy, update, patch = parse_version(version)
    year = 2000 + yy if yy < 100 else yy
    return f"{year}.{update}" if patch == 0 else f"{year}.{update}.{patch}"


def whats_new_section(text: str, version: str) -> list[tuple[str | None, list[str]]]:
    """The version's section of What's New as titled lists: each "### "
    subsection one list, its bullets with their continuation lines joined.
    Exits when the version has no section or the section no bullets."""
    shown = display_version(version)
    lines = text.splitlines()
    start = next((i for i, line in enumerate(lines) if line.strip() == f"## {shown}"), None)
    if start is None:
        sys.exit(f"What's New has no '## {shown}' section; write the release's notes there first")
    groups: list[tuple[str | None, list[str]]] = [(None, [])]
    for line in lines[start + 1:]:
        if line.startswith("## "):
            break
        stripped = line.strip()
        if line.startswith("### "):
            groups.append((stripped.lstrip("#").strip(), []))
        elif stripped.startswith(("- ", "* ")):
            groups[-1][1].append(stripped[2:].strip())
        elif stripped and groups[-1][1]:
            # A bullet wrapped onto the next line.
            groups[-1][1][-1] += " " + stripped
    groups = [(title, items) for title, items in groups if items]
    if not groups:
        sys.exit(f"What's New's '## {shown}' section has no bullets")
    return groups


def site_links(item: str) -> str:
    """Links into the guide (relative, as What's New writes them) as the
    pages' addresses on the website; any other link is left alone."""
    def site(match: re.Match[str]) -> str:
        label, target = match.group(1), match.group(2)
        if re.match(r"^[a-z]+:", target) or target.startswith("#"):
            return match.group(0)
        path, _, anchor = target.partition("#")
        if not path.startswith("user-guide/") or not path.endswith(".md"):
            return match.group(0)
        page = path[len("user-guide/"):-len(".md")]
        page = page[: -len("README")] if page.endswith("README") else page + "/"
        return f"[{label}]({GUIDE_SITE}{page}{'#' + anchor if anchor else ''})"
    return re.sub(r"\[([^\]]+)\]\(([^)\s]+)\)", site, item)


def notes_from_whats_new(text: str, version: str) -> str:
    """The manifest's notes: every bullet of the section, one a line, as
    the update dialog draws a list."""
    return "\n".join(f"- {site_links(item)}" for _, items in whats_new_section(text, version) for item in items)


def manifest_for(version: str, notes: str, platforms: list[str], now: dt.datetime | None = None) -> dict:
    tag = f"v{version}"
    entries = {
        PLATFORMS[p]: {"url": f"https://github.com/{PUBLIC_REPO}/releases/download/{tag}/{installer_name(p, version)}", "signature": ""}
        for p in platforms
    }
    stamp = (now or dt.datetime.now(dt.timezone.utc)).replace(microsecond=0)
    return {
        "version": version,
        "notes": notes,
        "pub_date": stamp.isoformat().replace("+00:00", "Z"),
        "platforms": dict(sorted(entries.items())),
    }


def manifest_text(manifest: dict) -> str:
    return json.dumps(manifest, indent=2, ensure_ascii=False) + "\n"


def read_manifest(path: Path | None = None) -> dict:
    """The committed manifest, checked enough for release.py to trust."""
    path = path or MANIFEST_FILE
    if not path.is_file():
        sys.exit(f"{path.name} is missing: write it with python scripts/latest_json.py, review it and commit it")
    try:
        manifest = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        sys.exit(f"{path.name}: not JSON ({error})")
    for key in ("version", "notes", "platforms"):
        if key not in manifest:
            sys.exit(f"{path.name} has no {key}")
    if not str(manifest["notes"]).strip():
        sys.exit(f"{path.name}: the notes are empty")
    return manifest


def run_gh(args: list[str], *, input: str | None = None) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(["gh", *args], check=False, capture_output=True, text=True, encoding="utf-8", input=input)
    except FileNotFoundError:
        sys.exit("gh is not installed (brew install gh), or not on PATH")


def gh(*args: str) -> str:
    """A gh subcommand against the public repo; any failure ends the run."""
    done = run_gh([*args, "--repo", PUBLIC_REPO])
    if done.returncode != 0:
        sys.exit(f"gh {' '.join(args)}: {done.stderr.strip() or done.stdout.strip()}")
    return done.stdout


def gh_api(path: str, *fields: str, method: str = "GET", missing_ok: bool = False) -> dict | None:
    """One call to the GitHub REST API through gh, parsed. A 404 is None
    when the caller says it may be, an error otherwise; every other
    failure ends the run."""
    args = ["api", f"repos/{PUBLIC_REPO}/{path}"]
    if method != "GET":
        args += ["-X", method]
    for field in fields:
        args += ["-f", field]
    done = run_gh(args)
    if done.returncode != 0:
        if missing_ok and "HTTP 404" in done.stderr:
            return None
        sys.exit(f"gh api {path}: {done.stderr.strip() or done.stdout.strip()}")
    return json.loads(done.stdout) if done.stdout.strip() else {}


def fetch_json(url: str) -> tuple[dict | None, str | None]:
    """The manifest a URL serves, or why not."""
    try:
        with urllib.request.urlopen(url, timeout=15) as response:
            body = response.read().decode("utf-8")
    except Exception as error:  # noqa: BLE001
        return None, f"not reachable: {error}"
    try:
        return json.loads(body), None
    except json.JSONDecodeError:
        return None, "not a manifest"


class HeadRedirect(urllib.request.HTTPRedirectHandler):
    """A redirect that keeps a HEAD a HEAD. Python before 3.13 rebuilt the
    request without its method, so a HEAD of a release asset, which GitHub
    answers with a redirect to its CDN, became a GET of the whole installer
    (the owner's 3.12, 2026-09-16: the check would have downloaded every
    file it was only asking about)."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        redirected = super().redirect_request(req, fp, code, msg, headers, newurl)
        if redirected is not None and req.get_method() == "HEAD":
            redirected = urllib.request.Request(
                redirected.full_url, headers=redirected.headers, origin_req_host=redirected.origin_req_host,
                unverifiable=True, method="HEAD",
            )
        return redirected


def answers(url: str) -> str | None:
    """None when a HEAD of the URL (redirects followed, as HEADs) is 200, else why."""
    try:
        opener = urllib.request.build_opener(HeadRedirect())
        with opener.open(urllib.request.Request(url, method="HEAD"), timeout=15) as response:
            return None if response.status == 200 else f"HTTP {response.status}"
    except urllib.error.HTTPError as error:
        return f"HTTP {error.code}"
    except Exception as error:  # noqa: BLE001
        return str(error)


def check_live(version: str) -> int:
    """Whether main serves this version's manifest with installers that
    answer, and what the redirect the older apps read serves."""
    failed = False
    served, why = fetch_json(RAW_URL)
    if served is None:
        print(f"{RAW_URL} is {why}", file=sys.stderr)
        return 1
    got = served.get("version", "")
    if parse_version(got) != parse_version(version):
        print(f"{LIVE_BRANCH} still serves {got or 'nothing'}, not {version}: merge {STAGE_BRANCH} into {LIVE_BRANCH} ({COMPARE_URL}); raw can lag by five minutes after the merge", file=sys.stderr)
        failed = True
    else:
        print(f"live: {RAW_URL} serves {got} with {', '.join(sorted(served.get('platforms', {})))}")
    for key, entry in sorted(served.get("platforms", {}).items()):
        url = entry.get("url", "")
        problem = answers(url)
        if problem:
            print(f"{key}: {url} does not answer ({problem}): the release is not published, or the file is not attached", file=sys.stderr)
            failed = True
        else:
            print(f"{key}: {url} answers")
    old, why = fetch_json(REDIRECT_URL)
    old_version = (old or {}).get("version", "")
    if old is None:
        print(f"# the redirect the apps before 2026.2.1 read is {why}", file=sys.stderr)
    elif parse_version(old_version) != parse_version(version):
        print(f"# the redirect the apps before 2026.2.1 read serves {old_version or 'nothing'}, not {version}: the release is not published, has no latest.json attached, or the redirect has not caught up (a minute)", file=sys.stderr)
    else:
        print(f"redirect: {REDIRECT_URL} serves {old_version} for the apps before 2026.2.1")
    return 1 if failed else 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0])
    parser.add_argument("--platforms", default=",".join(DEFAULT_PLATFORMS), help=f"the installers the release will carry, comma separated (default {','.join(DEFAULT_PLATFORMS)}; also {', '.join(p for p in PLATFORMS if p not in DEFAULT_PLATFORMS)})")
    parser.add_argument("--print", action="store_true", help="print the manifest, write nothing")
    parser.add_argument("--check", action="store_true", help=f"only confirm {LIVE_BRANCH} serves this version's manifest and its installers answer")
    args = parser.parse_args()

    version = workspace_version()
    parse_version(version)
    if args.check:
        return check_live(version)

    platforms = [p.strip() for p in args.platforms.split(",") if p.strip()]
    unknown = [p for p in platforms if p not in PLATFORMS]
    if unknown or not platforms:
        sys.exit(f"unknown platform {', '.join(unknown) or '(none)'}: choose from {', '.join(PLATFORMS)}")
    notes = notes_from_whats_new(WHATS_NEW.read_text(encoding="utf-8"), version)
    body = manifest_text(manifest_for(version, notes, platforms))
    if args.print:
        print(body, end="")
        return 0
    MANIFEST_FILE.write_text(body, encoding="utf-8")
    count = notes.count("\n") + 1
    print(f"# wrote {MANIFEST_FILE.name}: Heeler {display_version(version)} (v{version}), {', '.join(PLATFORMS[p] for p in platforms)}, {count} notes from What's New", file=sys.stderr)
    print("# review it (the notes read as the update dialog shows them), then commit it", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
