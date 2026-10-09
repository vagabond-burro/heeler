#!/usr/bin/env python3
"""Build distributable Heeler packages for the current OS.

Produces platform bundles via Tauri: MSI/NSIS on Windows, .app/.dmg on
macOS. Output lands in target/release/bundle/. The test suites are
opt-in through `--run-tests`.

Both platforms produce the shipping configuration by default. On Windows
that means the installers are signed through Azure Artifact Signing,
which needs `az login` on this machine and the settings in
heeler_build.py; `--unsigned` skips it. On macOS it means signed
with the Developer ID Application certificate in the keychain, notarized
by Apple, and stapled, both the .app and the DMG. That needs the
notarization credentials in the environment (APPLE_ID, APPLE_PASSWORD,
APPLE_TEAM_ID, or the App Store Connect API key trio); without them the
build stops before compiling rather than producing a DMG that every
other Mac refuses. `--unsigned` is the escape hatch for a build that
stays on this machine: ad-hoc signature, no notarization.

Usage: python scripts/dist.py build, signed for release python scripts/dist.py
--run-tests full suites first, then build python scripts/dist.py --bundler-names keep
the bundler's own filenames (Heeler_26.1.1_aarch64.dmg). By default the installers
are renamed to the release names, Heeler-26.1.1-macos.dmg and
Heeler-26.1.1-windows.exe: the website and the app read the download URLs from
latest.json at the public repo's root, so the names carry the version again
(2026-09-14) python scripts/dist.py --unsigned skip signing; the result stays on this
machine (macOS: ad-hoc, no notarization. Windows: no signature at all) python
scripts/dist.py --pre-release stamp the build "pre-release" in About and license
requests (the word only; the version and names are unchanged); --no-pre-release
stamps it as the release. Without either the build follows PRE_RELEASE_DEFAULT in
apps/heeler-app/src-tauri/src/version.rs python scripts/dist.py --store Windows: the
Microsoft Store build. MSI only, signed, with the WebView2 offline installer inside
(about 210 MB more), named Heeler-26.4.1-windows-store.msi so it never replaces the
website's MSI. Partner Center needs it at a URL that does not redirect, so not a
GitHub release python scripts/dist.py --check-credentials macOS: one authenticated
request to the notary service (its submission history), no build. Run this first with
fresh credentials: a wrong password fails once, here, instead of at the end of a
build, and repeated failures can lock an Apple ID.
"""

import json
import os
import sys
import time

from heeler_build import (
    workspace_version,
    APP_DIR,
    REPO_ROOT,
    check_credentials,
    ensure_node_modules,
    macos_signing_env,
    notarize_dmg,
    require_cargo,
    run,
    run_suites,
    stamp_build_identity,
    stamp_pre_release,
    tool,
    verify_macos_bundle,
    verify_windows_bundles,
    windows_build_config,
    windows_installers,
)


# The release names, with the version in them. They were version-less
# for a day (2026.1 and 2026.1.1 shipped as Heeler-macos.dmg and
# Heeler-windows.exe) so that the website's releases/latest/download/
# <name> links would survive the next release; since 2026-09-14 the
# website reads its download URLs from latest.json at the public repo's
# root (and since 2026-09-16 the app does too, latest_json.py staging
# the file on the repo's dev branch), so a name may say which version
# it is again, and a person holding two installers can tell them apart
# (2026-09-14). latest_json.py reads the names off the release either
# way.
RELEASE_NAMES = {
    ".dmg": "Heeler-{version}-macos.dmg",
    ".exe": "Heeler-{version}-windows.exe",
    ".msi": "Heeler-{version}-windows.msi",
    ".AppImage": "Heeler-{version}-linux.AppImage",
}

# Where installers land, by bundler. Named rather than globbed from the
# bundle root, so nothing inside Heeler.app is ever mistaken for one.
INSTALLER_DIRS = ("dmg", "nsis", "msi", "appimage")

# The Microsoft Store build's name (2026-10-05). Its own name so it
# never overwrites the website's MSI, and one release.py and
# latest_json.py refuse or skip: it is for Partner Center, not for the
# release's file list or the update manifest.
STORE_MSI_NAME = "Heeler-{version}-windows-store.msi"


def store_build_args(build_config: list[str]) -> list[str]:
    """The `tauri build` arguments for the Microsoft Store MSI.

    MSI only, since that is what Partner Center takes, and the WebView2
    offline installer inside it: Tauri's default downloads WebView2
    during the install, and the Store installs from the package alone.
    The signing override from windows_build_config is merged into the
    same --config rather than passed beside it, so one JSON says the
    whole build.
    """
    config = json.loads(build_config[1]) if build_config else {}
    windows = config.setdefault("bundle", {}).setdefault("windows", {})
    windows["webviewInstallMode"] = {"type": "offlineInstaller"}
    return ["--bundles", "msi", "--config", json.dumps(config)]


def rename_for_release(bundle_dir, built_after: float, store: bool = False) -> list:
    """Rename this build's installers to their release names.

    Only files written since the build started, the same rule
    windows_installers uses: an older version's bundle sitting in the
    directory is not this build's output and renaming it would both lie
    and overwrite.
    """
    renamed = []
    version = workspace_version()
    for sub in INSTALLER_DIRS:
        d = bundle_dir / sub
        if not d.is_dir():
            continue
        for f in sorted(d.iterdir()):
            if not f.is_file() or f.suffix not in RELEASE_NAMES:
                continue
            if f.stat().st_mtime < built_after:
                continue
            name = STORE_MSI_NAME if store and f.suffix == ".msi" else RELEASE_NAMES[f.suffix]
            target = f.with_name(name.format(version=version))
            if target == f:
                renamed.append(f)
                continue
            if target.exists():
                target.unlink()
            f.rename(target)
            renamed.append(target)
    return renamed


def main() -> None:
    args = sys.argv[1:]
    if "--help" in args or "-h" in args:
        print(__doc__)
        return
    if "--check-credentials" in args:
        check_credentials()
        return
    unsigned = "--unsigned" in args
    store = "--store" in args
    if store and sys.platform != "win32":
        sys.exit("error: --store builds the Microsoft Store MSI, which only a Windows machine can make")
    if store and unsigned:
        sys.exit("error: --store with --unsigned: the Store refuses an installer without a trusted signature")
    if store and "--bundler-names" in args:
        sys.exit("error: --store with --bundler-names: the bundler names the Store MSI the same as the website's")
    require_cargo()
    ensure_node_modules()

    env = dict(os.environ)
    auth = None
    if sys.platform == "darwin":
        env, auth = macos_signing_env(unsigned)
    # Every signing check runs before anything is built.
    build_config = windows_build_config(unsigned)
    if store:
        build_config = store_build_args(build_config)
    env = stamp_build_identity(stamp_pre_release(env, args))

    # Opt-in, not opt-out: the suites already gate every commit, and waiting for them on a build that is
    # only being packaged is a toll nobody asked for. scripts/test.py is
    # the same suites without a build, for the check before this one.
    if "--run-tests" in args:
        run_suites()
    run([tool("npm"), "run", "build"], cwd=APP_DIR)
    started = time.time()
    run([tool("npm"), "run", "tauri", "--", "build", *build_config],
        cwd=APP_DIR, env=env)

    bundle_dir = REPO_ROOT / "target" / "release" / "bundle"
    if sys.platform == "darwin":
        app = bundle_dir / "macos" / "Heeler.app"
        dmgs = sorted((bundle_dir / "dmg").glob("*.dmg")) if (bundle_dir / "dmg").exists() else []
        dmg = dmgs[-1] if dmgs else None
        if not app.exists():
            sys.exit(f"error: expected {app.relative_to(REPO_ROOT)} not found")
        if auth is not None and dmg is not None:
            notarize_dmg(dmg, auth)
        verify_macos_bundle(app, dmg, notarized=auth is not None)
    elif sys.platform == "win32" and not unsigned:
        installers = windows_installers(bundle_dir, started)
        if not installers:
            sys.exit("error: no Windows installers were produced; nothing to verify")
        verify_windows_bundles(installers)

    # Last, so signing, notarization, stapling and verification all ran
    # against the files the bundler produced. Renaming afterwards is
    # safe: a staple is carried inside the file and checked by content,
    # not by name.
    if "--bundler-names" not in args and "--versioned" not in args:
        renamed = rename_for_release(bundle_dir, started, store=store)
        if renamed:
            print("\nRenamed for the release (--bundler-names keeps the bundler's own):")
            for p in renamed:
                print(f"  {p.relative_to(REPO_ROOT)}")

    if bundle_dir.exists():
        print("\nBundles:")
        for p in sorted(bundle_dir.rglob("*")):
            if p.is_file() and p.suffix in {".msi", ".exe", ".dmg", ".app", ".deb", ".AppImage"}:
                print(f"  {p.relative_to(REPO_ROOT)}")
    else:
        print(f"warning: expected bundle dir {bundle_dir} not found")


if __name__ == "__main__":
    main()
