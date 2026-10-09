#!/usr/bin/env zsh
#
# Publishes the release from the Mac: this machine's DMG plus the
# installers the other machines left on the shared volume, handed to
# release.py with NOTES.md. The version is read from the workspace
# Cargo.toml, so nothing here changes from one release to the next.
#
#   ./scripts/macos-release.zsh                  publish
#   ./scripts/macos-release.zsh --dry-run        check everything, publish nothing
#   ./scripts/macos-release.zsh --builds DIR     take the other installers from DIR
#
# Anything else is passed to release.py as given (--pre-release,
# --one-platform, --out FILE). HEELER_BUILDS names the shared folder
# when --builds is not given; PYTHON names the interpreter.

set -euo pipefail

repo=${0:A:h:h}
cd "$repo"

builds=${HEELER_BUILDS:-/Volumes/DATA/tmp/builds}
dry_run=0
passed=()
while (( $# )); do
  case $1 in
    --dry-run|--dryrun|-n) dry_run=1 ;;
    --builds)
      (( $# > 1 )) || { print -u2 "--builds needs a folder"; exit 2 }
      builds=$2
      shift
      ;;
    --builds=*) builds=${1#--builds=} ;;
    -h|--help)
      sed -n '3,14p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) passed+=("$1") ;;
  esac
  shift
done

# The one version, as release.py reads it: [workspace.package] in Cargo.toml.
version=$(awk -F'"' '/^\[workspace\.package\]/ {s=1; next} /^\[/ {s=0} s && /^version[ \t]*=/ {print $2; exit}' Cargo.toml)
[[ -n $version ]] || { print -u2 "Cargo.toml: no version under [workspace.package]"; exit 1 }

dmg=target/release/bundle/dmg/Heeler-$version-macos.dmg
[[ -f $dmg ]] || { print -u2 "No $dmg. Build it first: python scripts/dist.py"; exit 1 }

[[ -d $builds ]] || { print -u2 "No folder $builds. Mount the shared volume, or name the folder with --builds DIR."; exit 1 }
# Every installer of this version the other machines built; a DMG left
# there is passed over, since this machine's own is the one that ships.
others=("$builds"/Heeler-$version-*(N.))
others=(${others:#*.dmg})
(( $#others )) || { print -u2 "Nothing named Heeler-$version-* in $builds. Copy the Windows and Linux installers there, or pass --one-platform after checking that is what you mean."; }

python=${PYTHON:-${commands[python]:-${commands[python3]:-}}}
[[ -n $python ]] || { print -u2 "No python on the PATH; set PYTHON."; exit 1 }

run=("$python" scripts/release.py "$dmg" $others --notes-file NOTES.md $passed)
(( dry_run )) && run+=(--dry-run)

print -u2 "Heeler $version"
print -u2 "  $dmg"
for f in $others; do print -u2 "  $f"; done
print -u2 "> ${(j: :)${(q-)run[@]}}"
exec $run
