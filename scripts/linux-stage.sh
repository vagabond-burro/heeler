#!/usr/bin/env bash
#
# Stages the Linux build: moves the AppImage dist.py built onto the
# shared builds folder, where the Mac's release script picks it up. The
# version is read from the workspace Cargo.toml, so nothing here changes
# from one release to the next, and an older AppImage still sitting in
# the bundle folder stays where it is.
#
#   ./scripts/linux-stage.sh                  move it
#   ./scripts/linux-stage.sh --dry-run        say what would move, move nothing
#   ./scripts/linux-stage.sh --builds DIR     stage on DIR instead
#   ./scripts/linux-stage.sh --force          replace one already staged
#
# HEELER_BUILDS names the shared folder when --builds is not given.

set -euo pipefail

repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$repo"

builds=${HEELER_BUILDS:-/mnt/f/tmp/builds}
dry_run=0
force=0
while (($#)); do
  case $1 in
    --dry-run | --dryrun | -n) dry_run=1 ;;
    --force | -f) force=1 ;;
    --builds)
      (($# > 1)) || { echo "--builds needs a folder" >&2; exit 2; }
      builds=$2
      shift
      ;;
    --builds=*) builds=${1#--builds=} ;;
    -h | --help)
      sed -n '3,14p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "unknown option: $1 (see --help)" >&2
      exit 2
      ;;
  esac
  shift
done

# The one version, as release.py reads it: [workspace.package] in Cargo.toml.
version=$(awk -F'"' '/^\[workspace\.package\]/ {s=1; next} /^\[/ {s=0} s && /^version[ \t]*=/ {print $2; exit}' Cargo.toml)
[[ -n $version ]] || { echo "Cargo.toml: no version under [workspace.package]" >&2; exit 1; }

installer=target/release/bundle/appimage/Heeler-$version-linux.AppImage
[[ -f $installer ]] || { echo "No $installer. Build it first: python3 scripts/dist.py" >&2; exit 1; }
[[ -d $builds ]] || { echo "No folder $builds. Mount the shared drive, or name the folder with --builds DIR." >&2; exit 1; }

dest=${builds%/}/Heeler-$version-linux.AppImage
if [[ -e $dest ]] && ((!force)); then
  echo "$dest is already there. --force replaces it." >&2
  exit 1
fi

echo "Heeler $version"
echo "  $installer -> $dest"
if ((dry_run)); then
  echo "dry run: nothing moved"
  exit 0
fi
mv -f -- "$installer" "$dest"
echo "staged"
