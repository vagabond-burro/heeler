"""Shared helpers for the Heeler build scripts. OS-agnostic."""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
APP_DIR = REPO_ROOT / "apps" / "heeler-app"


def tool(name: str) -> str:
    """Resolve a CLI tool cross-platform (npm -> npm.cmd on Windows)."""
    path = shutil.which(name)
    if path is None:
        sys.exit(f"error: required tool '{name}' not found on PATH")
    return path


def nasm_warning(platform: str, machine: str, nasm: str | None) -> str | None:
    """What to say when an x64 build would compile mozjpeg without SIMD.

    mozjpeg-sys assembles its x86 SIMD with NASM and, finding none,
    quietly builds the scalar C path instead: the build still works,
    but LibRaw's lossy DNG decode and the viewer's JPEG frames (the
    frames a slider drag streams) run at about half speed. macOS arm64
    needs nothing: its NEON code goes through the system assembler.
    """
    if nasm is not None or machine.lower() not in ("x86_64", "amd64"):
        return None
    if platform == "win32":
        how = "winget install NASM.NASM (then open a new terminal so PATH has it)"
    elif platform.startswith("linux"):
        how = "./scripts/linux-setup.sh, or sudo apt install nasm"
    else:
        how = "your package manager's nasm"
    return ("warning: nasm not found on PATH, so mozjpeg builds without SIMD and the viewer's "
            f"JPEG frames encode slower. Install it: {how}")


def warn_without_nasm() -> None:
    import platform as _platform
    message = nasm_warning(sys.platform, _platform.machine(), shutil.which("nasm"))
    if message:
        print(message, file=sys.stderr)


def require_cargo() -> None:
    """Fail early, and legibly, when cargo is missing.

    The Tauri CLI shells out to `cargo metadata` before it does anything
    else, and with no cargo to run all it reports is "No such file or
    directory (os error 2)", which reads like a missing project file
    rather than a missing toolchain. Say the real thing here instead,
    while there is still room to say what to do about it.
    """
    if shutil.which("cargo"):
        warn_without_nasm()
        return
    lines = ["error: cargo not found on PATH, and the Tauri build needs it"]
    if (Path.home() / ".cargo" / "bin" / "cargo").exists():
        lines.append("  Rust is installed but your shell cannot see it. Run:")
        lines.append('      . "$HOME/.cargo/env"')
        lines.append("  or open a new terminal, then try again.")
    elif sys.platform.startswith("linux"):
        lines.append("  Install the build dependencies first: ./scripts/linux-setup.sh")
    else:
        lines.append("  Install Rust from https://rustup.rs and try again.")
    for line in lines:
        print(line, file=sys.stderr)
    sys.exit(1)


def run(args: list[str], cwd: Path = REPO_ROOT, env: dict[str, str] | None = None) -> None:
    print(f"$ {' '.join(args)}  (cwd: {cwd.relative_to(REPO_ROOT) if cwd != REPO_ROOT else '.'})")
    result = subprocess.run(args, cwd=cwd, env=env)
    if result.returncode != 0:
        sys.exit(result.returncode)


# Loose debug objects under target/<profile>/deps. On macOS a dev build
# keeps every codegen unit's .o beside the crate (split debuginfo), and
# each new build fingerprint of a crate (a version bump, a branch
# switch, `cargo test` against `tauri dev`) writes a fresh set without
# removing the old. On 2026-09-27 target/debug/deps held 402,133 of
# them, 75 GiB, and anything that walks the folder (cargo clean -p, the
# link step) crawled. Cargo decides freshness from the .rlib and .rmeta
# files, never from these, so removing them rebuilds nothing; only the
# debugger's symbols for crates not rebuilt since are lost, and the next
# build of a crate writes its set again.
PRUNE_AT = 30_000


def debug_objects(target: Path) -> list[Path]:
    """Every loose .o under target/*/deps."""
    found: list[Path] = []
    if not target.is_dir():
        return found
    for profile in target.iterdir():
        deps = profile / "deps"
        if not deps.is_dir():
            continue
        with os.scandir(deps) as entries:
            found.extend(Path(e.path) for e in entries if e.name.endswith(".o") and e.is_file(follow_symlinks=False))
    return found


def prune_debug_objects(target: Path, quiet: bool = False) -> tuple[int, int]:
    """Removes the loose .o files under target/*/deps; returns (files, bytes)."""
    objects = debug_objects(target)
    count, size = 0, 0
    for i, path in enumerate(objects, 1):
        try:
            size += path.stat().st_size
            path.unlink()
            count += 1
        except OSError:
            pass
        if not quiet and i % 50_000 == 0:
            print(f"  {i:,} of {len(objects):,}")
    if not quiet:
        print(f"pruned {count:,} debug objects ({size / 2**30:.1f} GiB) from {target}")
    return count, size


def ensure_node_modules() -> None:
    sync_package_version()
    if not (APP_DIR / "node_modules").exists():
        run([tool("npm"), "install"], cwd=APP_DIR)


def workspace_version() -> str:
    """The one version, from the workspace Cargo.toml."""
    text = (REPO_ROOT / "Cargo.toml").read_text(encoding="utf-8")
    section = text.split("[workspace.package]", 1)[1].split("\n[", 1)[0]
    match = re.search(r'^version\s*=\s*"([^"]+)"', section, re.MULTILINE)
    if not match:
        sys.exit("Cargo.toml: no version under [workspace.package]")
    return match.group(1)


def sync_package_version() -> None:
    """package.json and its lock carry a version nothing reads, but npm prints
    it in its banner, and a stale one there read as the wrong build
    (2026-09-13: "I see 26.1.1 under Help > About but in the shell I see
    heeler-app@26.1.0"). They follow Cargo.toml, so the release's one edit
    stays one edit."""
    version = workspace_version()
    # ONLY the root entries: the file's own top-level version, at two
    # spaces of indentation, and in the lock the root package's entry
    # under "". A first version of this counted "the first two version
    # lines that differ", which once the roots agreed walked on into the
    # dependencies and rewrote @adobe/css-tools to 26.1.1 in the owner's
    # lock (2026-09-13). Each pattern names its place; nothing else in
    # either file has a version at these positions.
    edits = {
        "package.json": [re.compile(r'^(  "version": ")([^"]+)(",)$', re.MULTILINE)],
        "package-lock.json": [
            re.compile(r'^(  "version": ")([^"]+)(",)$', re.MULTILINE),
            re.compile(r'("": \{\n\s+"name": "[^"]+",\n\s+"version": ")([^"]+)(")'),
        ],
    }
    for name, patterns in edits.items():
        path = APP_DIR / name
        if not path.exists():
            continue
        text = path.read_text(encoding="utf-8")
        updated = text
        for pattern in patterns:
            match = pattern.search(updated)
            if match is None:
                sys.exit(f"{name}: the root version entry was not where sync_package_version expects it; nothing written")
            if match.group(2) != version:
                updated = updated[: match.start(2)] + version + updated[match.end(2) :]
        if updated != text:
            path.write_text(updated, encoding="utf-8")
            print(f"{name}: version {version}, following Cargo.toml")


def run_suites() -> None:
    """Every test suite Heeler has: the release scripts' and the help
    kit's, the Rust workspace, the frontend's type check, then the
    frontend.

    One function because the same commands were written out in dev.py
    and dist.py, and a further suite (or a flag on the first) would have
    meant remembering both. Nothing here
    touches signing, credentials or the bundler: testing and shipping
    are separate jobs that the build scripts merely happen to run in
    that order.

    Exits non-zero on the first failing suite, via run(), so a red
    workspace never reaches `npm test` and a red build never reaches
    the bundler.
    """
    # The cheapest first: release.py's pure parts, without gh or the
    # network, so a broken release body is found before a build.
    run([sys.executable, str(REPO_ROOT / "scripts" / "test_release.py")], cwd=REPO_ROOT)
    run([sys.executable, str(REPO_ROOT / "scripts" / "test_help_kit.py")], cwd=REPO_ROOT)
    require_cargo()
    run([tool("cargo"), "test", "--workspace"], cwd=REPO_ROOT)
    ensure_node_modules()
    # vitest strips types without checking them, so the type check is
    # its own step: `npm run build` starts with it, and a type error
    # that only the build found would surface at release time.
    run([tool("npx"), "tsc", "--noEmit", "-p", "."], cwd=APP_DIR)
    run([tool("npm"), "test"], cwd=APP_DIR)


# ---- macOS signing and notarization -------------------------------------
#
# Tauri's bundler does the actual work: with APPLE_SIGNING_IDENTITY set
# it signs the .app (hardened runtime on), and with one of the two
# credential sets below present it also submits the .app to Apple's
# notary service, waits, and staples the ticket, all BEFORE the DMG is
# packed around it. The DMG itself gets a signature but no ticket, so
# dist.py notarizes and staples the DMG as a second step. These helpers
# find the identity and check the credentials, so a build that would
# ship unsigned fails before spending twenty minutes compiling.

NOTARY_APPLE_ID_VARS = ("APPLE_ID", "APPLE_PASSWORD", "APPLE_TEAM_ID")
NOTARY_API_KEY_VARS = ("APPLE_API_KEY", "APPLE_API_ISSUER", "APPLE_API_KEY_PATH")


def find_developer_id() -> str | None:
    """The one Developer ID Application identity in the keychain, or None.

    Several would be ambiguous; that case exits and asks for
    APPLE_SIGNING_IDENTITY to be set explicitly.
    """
    result = subprocess.run(
        ["security", "find-identity", "-v", "-p", "codesigning"],
        capture_output=True,
        text=True,
    )
    names = sorted(set(re.findall(r'"(Developer ID Application: [^"]+)"', result.stdout)))
    if len(names) > 1:
        sys.exit(
            "error: more than one Developer ID Application identity in the keychain;\n"
            "  set APPLE_SIGNING_IDENTITY to the one to use:\n    "
            + "\n    ".join(names)
        )
    return names[0] if names else None


def notarization_credentials(env: dict[str, str]) -> list[str] | None:
    """notarytool auth arguments from the environment, or None if incomplete.

    The same two credential sets Tauri's bundler reads, so the .app (Tauri)
    and the DMG (dist.py) are notarized under one identity.
    """
    if all(env.get(v) for v in NOTARY_APPLE_ID_VARS):
        return [
            "--apple-id", env["APPLE_ID"],
            "--team-id", env["APPLE_TEAM_ID"],
            "--password", env["APPLE_PASSWORD"],
        ]
    if all(env.get(v) for v in NOTARY_API_KEY_VARS):
        return [
            "--key", env["APPLE_API_KEY_PATH"],
            "--key-id", env["APPLE_API_KEY"],
            "--issuer", env["APPLE_API_ISSUER"],
        ]
    return None


def explain_missing_notarization() -> str:
    return (
        "error: no notarization credentials in the environment. Export either\n"
        "    APPLE_ID        the Apple ID that owns the Developer ID certificate\n"
        "    APPLE_PASSWORD  an app-specific password for it (appleid.apple.com,\n"
        "                    Sign-In and Security > App-Specific Passwords),\n"
        "                    never the account password\n"
        "    APPLE_TEAM_ID   the ten-character team ID in the certificate name\n"
        "  or the App Store Connect API key trio APPLE_API_KEY, APPLE_API_ISSUER,\n"
        "  APPLE_API_KEY_PATH. Without them Tauri signs but skips notarization,\n"
        "  and Gatekeeper refuses the app on every other Mac. Pass --unsigned\n"
        "  for a build that stays on this machine."
    )


def verify_macos_bundle(app: Path, dmg: Path | None, notarized: bool) -> None:
    """Prove the bundle is what we think it is, loudly, after the build.

    codesign checks the signature, stapler checks the notarization
    ticket is attached, and spctl asks Gatekeeper the question a user's
    Mac will ask: would this open? Any failure exits non-zero, so a
    bundle that would be refused never gets reported as a success.
    """
    run(["codesign", "--verify", "--deep", "--strict", str(app)])
    subprocess.run(["codesign", "-dv", str(app)])  # what it was signed as, for the record
    if not notarized:
        return
    run(["xcrun", "stapler", "validate", str(app)])
    run(["spctl", "--assess", "--type", "execute", "--verbose=4", str(app)])
    if dmg is not None:
        run(["xcrun", "stapler", "validate", str(dmg)])
        run(["spctl", "--assess", "--type", "open", "--context", "context:primary-signature",
             "--verbose=4", str(dmg)])


def macos_signing_env(unsigned: bool) -> tuple[dict[str, str], list[str] | None]:
    """The environment Tauri's bundler signs and notarizes under.

    Returns the environment and the notarytool auth arguments for the
    DMG step (None when the build is unsigned). Fails before the build
    when the shipping configuration cannot be met.
    """
    env = dict(os.environ)
    if unsigned:
        env["APPLE_SIGNING_IDENTITY"] = "-"
        for var in ("APPLE_ID", "APPLE_PASSWORD", "APPLE_TEAM_ID",
                    "APPLE_API_KEY", "APPLE_API_ISSUER", "APPLE_API_KEY_PATH"):
            env.pop(var, None)  # no accidental notarization of an ad-hoc build
        print("note: --unsigned build; ad-hoc signature, no notarization. This DMG cannot leave this machine.")
        return env, None

    identity = env.get("APPLE_SIGNING_IDENTITY") or find_developer_id()
    if identity == "-":
        sys.exit("error: APPLE_SIGNING_IDENTITY is '-' (ad-hoc). Pass --unsigned if that is what you want.")
    if not identity:
        sys.exit(
            "error: no Developer ID Application certificate in the keychain.\n"
            "  Install one from developer.apple.com (Certificates > Developer ID\n"
            "  Application) or set APPLE_SIGNING_IDENTITY. Pass --unsigned for a\n"
            "  build that stays on this machine."
        )
    env["APPLE_SIGNING_IDENTITY"] = identity
    auth = notarization_credentials(env)
    if auth is None:
        sys.exit(explain_missing_notarization())
    print(f"Signing as: {identity}")
    print("Notarizing: yes (Tauri notarizes and staples the .app; the DMG follows after the build)")
    return env, auth


def notarize_dmg(dmg: Path, auth: list[str]) -> None:
    """Submit the DMG to Apple's notary service, wait, and staple the ticket.

    Tauri signs the DMG but only notarizes the .app inside it. A stapled
    app already opens fine, but a notarized DMG is what a downloaded
    file's first Gatekeeper check sees, so the download itself is clean.
    """
    run(["xcrun", "notarytool", "submit", str(dmg), *auth, "--wait"])
    run(["xcrun", "stapler", "staple", str(dmg)])


def check_credentials() -> None:
    """Prove the signing identity and notary credentials work, without building.

    Exactly one request goes to Apple: the notary service's submission
    history for this account. It succeeds (possibly with an empty
    history) or fails once with the service's own message.
    """
    if sys.platform != "darwin":
        sys.exit("error: --check-credentials only means something on macOS")
    env, auth = macos_signing_env(unsigned=False)
    run(["xcrun", "notarytool", "history", *auth])
    print("Credentials accepted by the notary service. A signed, notarized build will work.")


# ---- Windows signing ----------------------------------------------------
#
# Azure Artifact Signing (called Trusted Signing until 2026) issues
# short-lived certificates from Microsoft's cloud, so unlike a bought
# OV certificate there is no key file or USB token on the build machine:
# there is a login, and a command line. Tauri runs `signCommand` once per
# file it bundles, with %1 standing for that file, so the integration is
# the command below plus `az login` on the machine doing the build.
#
# The account, profile and region come from the build machine's
# environment, like the credentials: the repository is public and names
# no one's signing account.

WINDOWS_SIGNING_VARS = {
    "account": "HEELER_SIGNING_ACCOUNT",
    "profile": "HEELER_SIGNING_PROFILE",
    "region": "HEELER_SIGNING_REGION",
}

# Only some Azure regions host the service, and each has its own
# endpoint host. Mapping them here means a typo in a region name fails
# with a list of the real ones instead of an authentication error.
# The signing tool takes these as required arguments; it has no
# interactive login, so there is no `az login` shortcut around them.
SIGNING_CREDENTIAL_VARS = ("AZURE_TENANT_ID", "AZURE_CLIENT_ID", "AZURE_CLIENT_SECRET")

ARTIFACT_SIGNING_ENDPOINTS = {
    "brazilsouth": "brs", "centralus": "cus", "eastus": "eus",
    "japaneast": "jpe", "koreacentral": "krc", "northcentralus": "ncus",
    "northeurope": "neu", "polandcentral": "plc", "southcentralus": "scus",
    "switzerlandnorth": "swn", "westcentralus": "wcus", "westeurope": "weu",
    "westus": "wus", "westus2": "wus2", "westus3": "wus3",
}


def windows_signing_settings() -> dict[str, str]:
    """Account, profile and region for signing, from the environment."""
    return {key: os.environ.get(var, "").strip() for key, var in WINDOWS_SIGNING_VARS.items()}


def windows_sign_command() -> str:
    """The `signCommand` Tauri runs for each file it bundles.

    Exits with something readable when the machine or the settings are
    not ready, because the alternative is an installer that looks built
    and warns every customer who runs it.
    """
    cfg = windows_signing_settings()
    missing = [k for k in ("account", "profile", "region") if not cfg[k]]
    if missing:
        sys.exit(
            "error: Windows signing is not configured (missing: "
            + ", ".join(WINDOWS_SIGNING_VARS[k] for k in missing)
            + ").\n  Set HEELER_SIGNING_ACCOUNT (the Artifact Signing account's name),\n"
            "  HEELER_SIGNING_PROFILE (its certificate profile) and HEELER_SIGNING_REGION\n"
            "  (the account's Azure region, such as eastus) in this machine's environment.\n"
            "  Pass --unsigned to build an installer that stays on this machine."
        )
    region = cfg["region"].replace(" ", "").lower()
    if region not in ARTIFACT_SIGNING_ENDPOINTS:
        sys.exit(
            f"error: '{cfg['region']}' is not an Azure region that hosts Artifact Signing.\n"
            "  The account's region is on its Overview page in the portal. One of:\n    "
            + ", ".join(sorted(ARTIFACT_SIGNING_ENDPOINTS))
        )
    # Tauri runs signCommand as a raw process, not through a shell, and
    # splits it on spaces: a value containing one would silently become
    # two arguments.
    for key in ("account", "profile"):
        if " " in cfg[key]:
            sys.exit(f"error: the signing {key} name contains a space, which Tauri's signCommand cannot pass")
    if shutil.which("artifact-signing-cli") is None:
        sys.exit(
            "error: artifact-signing-cli not found on PATH. Install it with:\n"
            "      cargo install artifact-signing-cli\n"
            "  and sign in to Azure on this machine with `az login` (the CLI signs as\n"
            "  whoever is logged in, and needs the Artifact Signing Certificate Profile\n"
            "  Signer role on the account)."
        )
    check_signing_credentials()
    endpoint = f"https://{ARTIFACT_SIGNING_ENDPOINTS[region]}.codesigning.azure.net"
    return (
        f"artifact-signing-cli -e {endpoint} -a {cfg['account']} "
        f"-c {cfg['profile']} -d Heeler %1"
    )


def check_signing_credentials() -> None:
    """Confirm the signing tool has credentials before a build needs them.

    artifact-signing-cli authenticates only as a service principal: it
    takes the three values below as required arguments and has no
    interactive login, so an `az login` session does not help it. Without
    them it fails inside Tauri's bundler, which reports only "failed to
    run artifact-signing-cli" and swallows the reason, after the whole
    compile. Ask here, where the answer is legible.
    """
    missing = [v for v in SIGNING_CREDENTIAL_VARS if not os.environ.get(v)]
    if not missing:
        return
    sys.exit(
        "error: Windows signing has no credentials (missing: " + ", ".join(missing) + ").\n"
        "  The signing tool signs as a service principal, not as you. In the Azure\n"
        "  portal: Microsoft Entra ID > App registrations > New registration, then\n"
        "  Certificates & secrets > New client secret. Give that app the 'Artifact\n"
        "  Signing Certificate Profile Signer' role on the signing account under\n"
        "  Access control (IAM). Then set, in the build machine's environment:\n"
        "      AZURE_TENANT_ID      the app's Directory (tenant) ID\n"
        "      AZURE_CLIENT_ID      the app's Application (client) ID\n"
        "      AZURE_CLIENT_SECRET  the secret Value (not its Secret ID; it is shown\n"
        "                           once, and it expires on the date you chose)\n"
        "  Pass --unsigned to build an installer that stays on this machine."
    )


def stamp_build_identity(env: dict[str, str]) -> dict[str, str]:
    """Give the build its number and its receipt, from the commit.

    build.rs bakes HEELER_BUILD_NUMBER (the commit count, monotonic and
    human-sized) and HEELER_BUILD_HASH (the short hash) into the build
    string About and the log show. The script used to run git
    itself and watch the repository, so every commit recompiled the desktop
    crate in the owner's dev app (2026-09-24); now a build made by hand
    reads "build dev (dev)" and only the builds these scripts make carry
    the real identity. Outside a checkout both read "unknown", as before,
    so a source tarball still builds.
    """
    env = dict(env)

    def git(*args: str) -> str:
        try:
            out = subprocess.run(["git", *args], cwd=REPO_ROOT, capture_output=True, text=True, check=True).stdout.strip()
        except (OSError, subprocess.CalledProcessError):
            return "unknown"
        return out or "unknown"

    env["HEELER_BUILD_STAMPED"] = "1"
    env["HEELER_BUILD_NUMBER"] = git("rev-list", "--count", "HEAD")
    env["HEELER_BUILD_HASH"] = git("rev-parse", "--short", "HEAD")
    print(f"build identity: build {env['HEELER_BUILD_NUMBER']} ({env['HEELER_BUILD_HASH']})")
    return env


def stamp_pre_release(env: dict[str, str], args: list[str]) -> dict[str, str]:
    """Tell the build whether it is a pre-release, when the flags say.

    build.rs reads HEELER_PRE_RELEASE and bakes the word into the build
    string About shows: "2026.2 pre-release build N" against "2026.2
    build N". The setting lives in version.rs
    (PRE_RELEASE_DEFAULT, false); `--pre-release` overrules it to on and
    `--no-pre-release` to off, so a pre-release bundle is stamped on the fly
    rather than by editing the constant back and forth (2026-09-15). With
    neither flag the code's setting stands, and an ambient value in the
    shell is dropped so it cannot leak into the build.
    """
    env = dict(env)
    env.pop("HEELER_PRE_RELEASE", None)
    if "--pre-release" in args and "--no-pre-release" in args:
        sys.exit("error: --pre-release and --no-pre-release together")
    if "--pre-release" in args:
        env["HEELER_PRE_RELEASE"] = "1"
        print("build identity: pre-release (--pre-release)")
    elif "--no-pre-release" in args:
        env["HEELER_PRE_RELEASE"] = "0"
        print("build identity: release (--no-pre-release)")
    else:
        print("build identity: as version.rs has it")
    return env



def windows_build_config(unsigned: bool) -> list[str]:
    """The `--config` override that turns signing on for one build.

    Keeping signCommand out of tauri.conf.json means an ordinary
    `npx tauri build` stays unsigned and offline, and the scripts that
    produce something for other people are the ones that sign, which is
    how macOS works here too.
    """
    if sys.platform != "win32":
        return []
    if unsigned:
        print("note: --unsigned build; the installer is not signed, so Windows will warn "
              "every machine but this one.")
        return []
    command = windows_sign_command()
    print(f"Signing with: {command.replace(' %1', '')}")
    return ["--config", json.dumps({"bundle": {"windows": {"signCommand": command}}})]


def windows_installers(bundle_dir: Path, built_after: float) -> list[Path]:
    """The installers this build just wrote.

    Bundles accumulate: a build of an older version leaves its .exe and
    .msi behind under a different filename, and verifying those would
    fail a perfectly good build. Only files written since the build
    started count.
    """
    if not bundle_dir.exists():
        return []
    return sorted(
        p for p in bundle_dir.rglob("*")
        if p.suffix in {".exe", ".msi"} and p.stat().st_mtime >= built_after
    )


def verify_windows_bundles(paths: list[Path]) -> None:
    """Check each installer carries a valid Authenticode signature.

    signtool is not reliably on PATH, but PowerShell is always there.
    A bundle that fails this would warn every customer, so it fails the
    build rather than being reported as a success.
    """
    for path in paths:
        script = (
            f"$s = Get-AuthenticodeSignature -LiteralPath '{path}'; "
            "$s | Format-List Status, StatusMessage, SignerCertificate; "
            "if ($s.Status -ne 'Valid') { exit 1 }"
        )
        run(["powershell", "-NoProfile", "-Command", script])
