#!/usr/bin/env python3
"""Writes the update manifest for a release, attaches it, and stages it
on the public repo's dev branch.

The app and the website read one file at one fixed URL,
https://raw.githubusercontent.com/vagabond-burro/heeler/main/latest.json,
and that file goes live when dev is merged into main (2026-09-16: "a
better way to work" than a workflow copying a release attachment, which
ran at publish time, before the manifest existed). The release page stays
the source of truth for what shipped: this script looks up the release
for the version's tag through gh, takes the installers from what is
actually attached, writes latest.json pointing at them, attaches it to
the release, and commits it to the dev branch of the public repo through
the GitHub contents API. Merging dev into main makes the release live for
the website and for every app from 2026.2.1 on.

    python scripts/latest_json.py --notes-file NOTES.md
    python scripts/latest_json.py --notes "What changed." --dry-run
    python scripts/latest_json.py --check

The flow: publish the release on GitHub with the installers attached,
run this, then merge dev into main. In that order: a merge before the
release is published points the website and the app at installers that
are not public yet. --check confirms the order held: main serves this
version and every installer it names answers.

The attachment is for the apps already out. 2026.1 through 2026.2 read
GitHub's releases/latest/download/latest.json redirect, so a release with
no attached manifest is invisible to them; --no-attach skips it for the
day that no longer matters. A release marked pre-release on GitHub is
attached to and never staged: a beta manifest must not reach main.

The version is the workspace Cargo.toml's, the same one the binary
carries, and the tag is v<version>; --tag names another release. The
installers carry the release names dist.py gives them, with the version
in the name; the two releases that shipped before 2026-09-14 carry the
names without one, and both forms are read:

Heeler-26.1.1-macos.dmg Heeler-macos.dmg darwin-aarch64
Heeler-26.1.1-windows.exe Heeler-windows.exe windows-x86_64
Heeler-26.3.0-linux.AppImage linux-x86_64

plus -macos-intel, -windows-arm64 and -linux-arm64 for platforms not
built yet. A
version in a name that is not the release's is refused, as is a release
with no installer or with a name this pattern does not know. gh must be
installed and signed in to the account that owns the vagabond-burro
organization.
"""

from __future__ import annotations

import argparse
import base64
import datetime as dt
import json
import re
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
PUBLIC_REPO = "vagabond-burro/heeler"
LIVE_BRANCH = "main"
STAGE_BRANCH = "dev"
MANIFEST_PATH = "latest.json"
# What the app and the website read.
RAW_URL = f"https://raw.githubusercontent.com/{PUBLIC_REPO}/{LIVE_BRANCH}/{MANIFEST_PATH}"
# What the apps before 2026.2.1 read.
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
# Attached beside the installers and not an installer.
COMPANIONS = {"latest.json", "models.json"}


def installer_platform(name: str, version: str) -> str | None:
    """The manifest key an attached file's name says it is for, None
    for a file that is not an installer; a name carrying another
    version is refused outright."""
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


def gh_api(path: str, *fields: str, method: str = "GET", missing_ok: bool = False, payload: dict | None = None) -> dict | None:
    """One call to the GitHub REST API through gh, parsed. A 404 is None
    when the caller says it may be, an error otherwise; every other
    failure ends the run."""
    args = ["api", f"repos/{PUBLIC_REPO}/{path}"]
    if method != "GET":
        args += ["-X", method]
    for field in fields:
        args += ["-f", field]
    if payload is not None:
        # A manifest's notes can exceed Windows' command-line limit once
        # base64 encoded. Send the JSON body on stdin instead.
        args += ["--input", "-"]
        done = run_gh(args, input=json.dumps(payload))
    else:
        done = run_gh(args)
    if done.returncode != 0:
        if missing_ok and "HTTP 404" in done.stderr:
            return None
        sys.exit(f"gh api {path}: {done.stderr.strip() or done.stdout.strip()}")
    return json.loads(done.stdout) if done.stdout.strip() else {}


def release(tag: str) -> dict:
    """The release for the tag, draft or published; gh sees drafts when
    signed in to the owning account."""
    raw = gh("release", "view", tag, "--json", "tagName,isDraft,isPrerelease,url,assets")
    return json.loads(raw)


def manifest_for(tag: str, version: str, notes: str, assets: list[str]) -> tuple[dict, list[str]]:
    platforms = {}
    strangers = []
    for name in assets:
        # The MSI rides beside the setup exe for people who want it; the
        # manifest points at the exe, which the in-place updater will want.
        if name in COMPANIONS or name.lower().endswith(".msi"):
            continue
        key = installer_platform(name, version)
        if key is None:
            strangers.append(name)
            continue
        if key in platforms:
            sys.exit(f"{tag} carries two installers for {key}; keep one")
        platforms[key] = {
            "url": f"https://github.com/{PUBLIC_REPO}/releases/download/{tag}/{name}",
            "signature": "",
        }
    manifest = {
        "version": version,
        "notes": notes,
        "pub_date": dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "platforms": dict(sorted(platforms.items())),
    }
    return manifest, strangers


def ensure_branch(branch: str) -> None:
    """The staging branch, made from main the first time."""
    if gh_api(f"branches/{branch}", missing_ok=True) is not None:
        return
    head = gh_api(f"git/ref/heads/{LIVE_BRANCH}")
    sha = head["object"]["sha"] if head else ""
    if not sha:
        sys.exit(f"{PUBLIC_REPO} has no {LIVE_BRANCH} branch to make {branch} from")
    gh_api("git/refs", f"ref=refs/heads/{branch}", f"sha={sha}", method="POST")
    print(f"# made {branch} from {LIVE_BRANCH} ({sha[:7]}) in {PUBLIC_REPO}", file=sys.stderr)


def stage_manifest(body: str, branch: str, message: str) -> str | None:
    """Commits the manifest to the branch through the contents API,
    replacing what is there; None when the branch already holds this
    exact text. Returns the commit's URL."""
    ensure_branch(branch)
    current = gh_api(f"contents/{MANIFEST_PATH}?ref={branch}", missing_ok=True)
    sha = None
    if current:
        sha = current.get("sha")
        held = base64.b64decode(current.get("content", "")).decode("utf-8")
        if held == body:
            return None
    payload = {
        "branch": branch,
        "message": message,
        "content": base64.b64encode(body.encode("utf-8")).decode("ascii"),
    }
    if sha:
        payload["sha"] = sha
    result = gh_api(f"contents/{MANIFEST_PATH}", method="PUT", payload=payload)
    return (result or {}).get("commit", {}).get("html_url", f"{branch} in {PUBLIC_REPO}")


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
    parser.add_argument("--notes", help="what changed, one plain paragraph")
    parser.add_argument("--notes-file", type=Path, help="a file holding the notes instead")
    parser.add_argument("--tag", help="the release to write for (default v<Cargo.toml version>)")
    parser.add_argument("--out", type=Path, help="also keep a copy of latest.json here")
    parser.add_argument("--branch", default=STAGE_BRANCH, help=f"the public repo branch to stage on (default {STAGE_BRANCH})")
    parser.add_argument("--no-attach", action="store_true", help="do not attach the manifest to the release (the apps before 2026.2.1 read it there)")
    parser.add_argument("--dry-run", action="store_true", help="read the release and print the manifest, attach and stage nothing")
    parser.add_argument("--check", action="store_true", help=f"only confirm {LIVE_BRANCH} serves this version's manifest and its installers answer")
    args = parser.parse_args()

    version = args.tag.lstrip("v") if args.tag else workspace_version()
    parse_version(version)
    tag = args.tag or f"v{version}"
    if args.check:
        return check_live(version)

    if args.notes_file:
        notes = args.notes_file.read_text(encoding="utf-8").strip()
    elif args.notes:
        notes = args.notes.strip()
    else:
        sys.exit("say what changed: --notes \"...\" or --notes-file NOTES.md")
    if not notes:
        sys.exit("the notes are empty")

    rel = release(tag)
    names = [a["name"] for a in rel.get("assets", [])]
    manifest, strangers = manifest_for(tag, version, notes, names)
    if strangers:
        sys.exit(f"{tag} carries a file this script does not know: {', '.join(strangers)}; installers are named Heeler-<version>-macos.dmg, Heeler-<version>-windows.exe and Heeler-<version>-linux.AppImage")
    if not manifest["platforms"]:
        sys.exit(f"{tag} has no installer attached; attach Heeler-{version}-macos.dmg and Heeler-{version}-windows.exe to the release first")
    body = json.dumps(manifest, indent=2) + "\n"

    state = "draft" if rel.get("isDraft") else "pre-release" if rel.get("isPrerelease") else "published"
    print(body, end="")
    print(f"# {tag} ({state}): Heeler {display_version(version)}, {', '.join(sorted(manifest['platforms']))}", file=sys.stderr)
    missing = {"darwin-aarch64", "windows-x86_64"} - set(manifest["platforms"])
    if missing:
        print(f"# no installer for {', '.join(sorted(missing))}: that platform will see no update from this release", file=sys.stderr)
    if "latest.json" in names and not args.no_attach:
        print("# the release already carries a latest.json; it will be replaced", file=sys.stderr)
    if args.out:
        args.out.write_text(body, encoding="utf-8")
        print(f"# wrote {args.out}", file=sys.stderr)
    if args.dry_run:
        return 0

    if not args.no_attach:
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / MANIFEST_PATH
            path.write_text(body, encoding="utf-8")
            gh("release", "upload", tag, str(path), "--clobber")
        print(f"# attached latest.json to {rel.get('url', tag)}, for the apps before 2026.2.1", file=sys.stderr)

    if rel.get("isPrerelease"):
        print(f"# {tag} is a pre-release: not staged on {args.branch}, a beta manifest must not reach {LIVE_BRANCH}", file=sys.stderr)
        return 0
    commit = stage_manifest(body, args.branch, f"latest.json: Heeler {display_version(version)} ({tag})")
    if commit is None:
        print(f"# {args.branch} already holds this manifest", file=sys.stderr)
    else:
        print(f"# staged latest.json on {args.branch}: {commit}", file=sys.stderr)
    if state == "draft":
        print(f"# publish {tag} on GitHub FIRST, then merge {args.branch} into {LIVE_BRANCH}: {COMPARE_URL}", file=sys.stderr)
    else:
        print(f"# merge {args.branch} into {LIVE_BRANCH} to make it live: {COMPARE_URL}; then python scripts/latest_json.py --check", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
