#!/usr/bin/env python3
"""Run every Heeler test suite, and nothing else.

The last-minute check before a dist build. It runs the release
script's tests, the Rust workspace, the frontend's type check and the
frontend suite and stops: no frontend build, no bundler, no signing, no
notarization, nothing written to target/release/bundle.
Testing and shipping are separate jobs, and this is the one that
answers "is the tree green right now?".

The same suites are reachable as `dev.py --test`, which stays for
muscle memory, and as `--run-tests` on dist.py, which runs them just
before building. All three call run_suites() in
heeler_build.py, so there is one definition of what "the tests" means.

Exits non-zero on the first failing suite, so this is safe to chain:

  python scripts/test.py && python scripts/dist.py

Usage:
  python scripts/test.py
"""

import sys

from heeler_build import run_suites


def main() -> None:
    if len(sys.argv) > 1:
        sys.exit(f"error: {sys.argv[0]} takes no arguments; got {' '.join(sys.argv[1:])}")
    run_suites()
    print("\nAll suites passed.")


if __name__ == "__main__":
    main()
