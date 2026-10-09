#!/usr/bin/env bash
#
# The test machine's one command: bring this checkout up to its remote
# and run every suite. It was a shell function in .bash_aliases
# (2026-10-03: "I want as a script so I don't lose it"):
#
# heeler-test { cd ~/heeler; git -C ~/heeler pull --ff-only; python3 scripts/test.py; }
#
# The checkout is the one this script lives in, wherever that is. A pull
# that cannot fast-forward stops here, before any test runs.
#
#   ./scripts/linux-test.sh
#
# To keep the old name: alias heeler-test=~/heeler/scripts/linux-test.sh

set -euo pipefail

# One function, called on the last line: the pull can rewrite this very
# file, and bash reads a script as it goes. By the time the pull runs
# the whole of main is already read, and exec leaves nothing after it.
main() {
  case ${1:-} in
    -h | --help)
      sed -n '3,14p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    "") ;;
    *)
      echo "unknown option: $1 (this takes none; see --help)" >&2
      exit 2
      ;;
  esac
  local repo
  repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
  cd "$repo"
  git pull --ff-only
  exec python3 scripts/test.py
}
main "$@"
