#!/usr/bin/env python3
"""Clean Heeler build data.

Usage:
  python scripts/clean.py          bundles and frontend output (seconds)
  python scripts/clean.py --prune  also the loose debug objects and a bloated
                                   incremental cache: the fix for a slow dev
                                   build, and nothing has to rebuild
  python scripts/clean.py --full   also cargo clean, so Rust rebuilds from scratch
  python scripts/clean.py --deep   also node_modules (next dev run reinstalls)

A slow dev build or a `cargo clean -p` that seems to hang is almost always
target/ grown to hundreds of thousands of files, not the code: reach for
--prune first (see prune_debug_objects in heeler_build.py). `cargo clean
-p heeler-desktop` walks every file in target/ to find its own and takes
minutes at that size; this goes straight to the files that pile up.

Never touches project files, only reconstructible build state.

The default is deliberately the small one, because what a release build
actually needs is to not ship a bundle left over from the last one.
dist.py writes identically named files into target/<profile>/bundle on
every build, so whatever an earlier build left sitting there is what the
next one overwrites. That is a bundle directory problem, and
discarding all of target/ to solve it is a bad trade: a full cargo
clean also throws away the ONNX Runtime that ort downloads into
target/release/build/ort-sys-*, sending the next build back to the
network for it, and it recompiles LibRaw, SQLite, zlib and mozjpeg from
source. Cleaning before every release build quietly turns every release
build into one that needs the network.

So reach for --full when you mean it: a toolchain change, a target/ you
suspect is corrupt, or reclaiming the several GB it holds.
"""

import os
import shutil
import sys
from pathlib import Path

from heeler_build import APP_DIR, REPO_ROOT, prune_debug_objects, require_cargo, run, tool

# A ladder, each rung including the one below it.
OPTIONS = {"--prune", "--full", "--deep"}

# An incremental cache past this is sessions from old fingerprints; the
# next build of a changed crate is a little slower once without it.
INCREMENTAL_LIMIT = 5 * 2**30


def remove(path: Path) -> None:
    if path.exists():
        print(f"removing {path.relative_to(REPO_ROOT)}")
        shutil.rmtree(path, ignore_errors=True)


def folder_size(path: Path) -> int:
    total = 0
    for root, _dirs, files in os.walk(path):
        for name in files:
            try:
                total += os.lstat(os.path.join(root, name)).st_size
            except OSError:
                pass
    return total


def main() -> None:
    args = sys.argv[1:]
    # A misspelled --full silently becomes the light clean, and the
    # build after it is not the one you asked for. Catch it here.
    unknown = [a for a in args if a not in OPTIONS]
    if unknown:
        sys.exit(f"error: unknown option(s): {' '.join(unknown)} (try --prune, --full or --deep)")

    if "--full" in args or "--deep" in args:
        # The loose objects first: cargo clean walks every file in
        # target/ and takes minutes when they have piled up.
        prune_debug_objects(REPO_ROOT / "target")
        require_cargo()
        run([tool("cargo"), "clean"], cwd=REPO_ROOT)
    else:
        if "--prune" in args:
            prune_debug_objects(REPO_ROOT / "target")
            for profile in ("debug", "release"):
                incremental = REPO_ROOT / "target" / profile / "incremental"
                if incremental.is_dir() and folder_size(incremental) > INCREMENTAL_LIMIT:
                    remove(incremental)
        # Both profiles: `tauri build --debug` bundles under debug/.
        for profile in ("release", "debug"):
            remove(REPO_ROOT / "target" / profile / "bundle")

    remove(APP_DIR / "dist")
    remove(APP_DIR / "node_modules" / ".vite")
    remove(APP_DIR / "src-tauri" / "gen")
    if "--deep" in args:
        remove(APP_DIR / "node_modules")
    print("clean.")


if __name__ == "__main__":
    main()
