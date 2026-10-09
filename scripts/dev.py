#!/usr/bin/env python3
"""Run a developer build of Heeler.

Usage:
  python scripts/dev.py            full desktop app (tauri dev: Rust shell + hot-reload UI)
  python scripts/dev.py --ui       frontend only, in the browser at http://localhost:5173
  python scripts/dev.py --test     run every test suite (Rust workspace + frontend),
                                   the same as scripts/test.py
"""

import sys

from heeler_build import APP_DIR, PRUNE_AT, REPO_ROOT, debug_objects, ensure_node_modules, prune_debug_objects, require_cargo, run, run_suites, tool


def main() -> None:
    args = sys.argv[1:]
    if "--test" in args:
        # Kept for muscle memory; scripts/test.py is the same suites
        # under the name somebody scanning the directory would look for.
        run_suites()
        return
    ensure_node_modules()
    if "--ui" in args:
        run([tool("npm"), "run", "dev"], cwd=APP_DIR)
    else:
        require_cargo()
        # Keep target/ from growing into the slow build (see
        # prune_debug_objects): once the loose debug objects pass a few
        # builds' worth, clear them before cargo has to walk past them.
        if len(debug_objects(REPO_ROOT / "target")) > PRUNE_AT:
            prune_debug_objects(REPO_ROOT / "target")
        run([tool("npm"), "run", "tauri", "--", "dev"], cwd=APP_DIR)


if __name__ == "__main__":
    main()
