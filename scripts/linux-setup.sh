#!/usr/bin/env bash
#
# Heeler build dependencies for Ubuntu. Install the packages before
# a VM build session so the session starts building instead of hunting
# dependencies.
#
# ./scripts/linux-setup.sh install everything, then verify
# ./scripts/linux-setup.sh --verify check only, change nothing
# ./scripts/linux-setup.sh --no-node skip the Node install
# ./scripts/linux-setup.sh --no-npm skip `npm install`
#
# Safe to re-run: every step checks before it acts.

set -euo pipefail

VERIFY_ONLY=0
NEW_SHELL_NEEDED=0
DO_NODE=1
DO_NPM=1
for arg in "$@"; do
  case "$arg" in
    --verify) VERIFY_ONLY=1 ;;
    --no-node) DO_NODE=0 ;;
    --no-npm) DO_NPM=0 ;;
    -h|--help) sed -n '2,13p' "$0" | sed 's/^# \?//'; exit 0 ;;
    *) echo "unknown option: $arg (try --help)" >&2; exit 2 ;;
  esac
done

# Color only when a terminal is watching, so piping to a file stays readable.
if [ -t 1 ]; then
  B=$'\033[1m'; DIM=$'\033[2m'; OK=$'\033[32m'; WARN=$'\033[33m'; ERR=$'\033[31m'; R=$'\033[0m'
else
  B=""; DIM=""; OK=""; WARN=""; ERR=""; R=""
fi
say()  { printf '%s\n' "$*"; }
step() { printf '\n%s==> %s%s\n' "$B" "$*" "$R"; }
good() { printf '  %s+%s %s\n' "$OK" "$R" "$*"; }
warn() { printf '  %s!%s %s\n' "$WARN" "$R" "$*"; }
bad()  { printf '  %sx%s %s\n' "$ERR" "$R" "$*"; }

# Every package below, with the reason it is here. A list without reasons
# is a list nobody can prune later.
#
# Not included, and deliberately: libasound2-dev, which the plan's
# package list carried. Nothing in Cargo.lock links alsa (no alsa-sys,
# no cpal, no rodio), and WebKit brings its own runtime audio libraries.
# Added since the plan was written: libxdo-dev, wget and file, which
# Tauri v2 asks for on Linux and the plan's list predates.
APT_PACKAGES=(
  build-essential            # cc/c++ for LibRaw, SQLite, zlib, mozjpeg
  curl                       # rustup, and Tauri's bundler fetches with it
  wget                       # Tauri's AppImage step
  file                       # Tauri's AppImage step inspects binaries
  git
  pkg-config
  libwebkit2gtk-4.1-dev      # the webview Heeler's UI runs in
  libgtk-3-dev               # windowing, and the file pickers
  libayatana-appindicator3-dev
  librsvg2-dev
  libssl-dev
  libxdo-dev                 # Tauri v2 on Linux
  nasm                       # mozjpeg-sys SIMD: the lossy DNG decoder and the viewer's JPEG frames
  patchelf                   # AppImage packaging
  desktop-file-utils         # .deb packaging
)

# Not needed to compile, needed to actually run the app in the VM: wgpu
# speaks Vulkan on Linux, and a fresh VM often has no ICD at all.
RUNTIME_PACKAGES=(
  mesa-vulkan-drivers
  vulkan-tools               # vulkaninfo, to tell "no GPU" from "bad shader"
)

repo_root() {
  local d
  d="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  [ -f "$d/Cargo.toml" ] && [ -d "$d/apps/heeler-app" ] && printf '%s' "$d"
}

# Prints one missing package per line, and nothing at all when none are
# missing, so mapfile yields a genuinely empty array rather than one
# containing a single empty string (which would reach apt as "").
missing_packages() {
  local p
  for p in "$@"; do
    dpkg-query -W -f='${Status}' "$p" 2>/dev/null | grep -q "ok installed" || printf '%s\n' "$p"
  done
}

# ---------------------------------------------------------------- preflight

step "Checking the machine"

if [ "$(id -u)" -eq 0 ]; then
  bad "Run this as your normal user, not root. It calls sudo where it needs to,"
  bad "and a root-owned ~/.cargo or node_modules will bite you later."
  exit 1
fi

if [ -r /etc/os-release ]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  say "  ${DIM}${PRETTY_NAME:-unknown}${R}"
  case "${ID:-}:${VERSION_ID:-}" in
    ubuntu:24.*) good "Ubuntu 24.x, the version the Linux plan targets" ;;
    ubuntu:22.*) warn "Ubuntu 22.04: supported, but 24.04 is what the plan targets" ;;
    ubuntu:*)    warn "Untested Ubuntu release; libwebkit2gtk-4.1-dev must exist for this to work" ;;
    debian:*)    warn "Debian, not Ubuntu. Package names usually match; nothing here is guaranteed" ;;
    *)           bad  "Not Ubuntu or Debian. This script only knows apt; stopping."; exit 1 ;;
  esac
else
  bad "No /etc/os-release, so this is not a distro I can identify. Stopping."
  exit 1
fi

command -v apt-get >/dev/null || { bad "apt-get not found."; exit 1; }

# ------------------------------------------------------------------- apt

step "System packages"

need=(); need_rt=()
mapfile -t need < <(missing_packages "${APT_PACKAGES[@]}")
mapfile -t need_rt < <(missing_packages "${RUNTIME_PACKAGES[@]}")

if [ ${#need[@]} -eq 0 ] && [ ${#need_rt[@]} -eq 0 ]; then
  good "All ${#APT_PACKAGES[@]} build packages and ${#RUNTIME_PACKAGES[@]} runtime packages already present"
elif [ "$VERIFY_ONLY" -eq 1 ]; then
  if [ ${#need[@]} -gt 0 ]; then warn "Missing build packages: ${need[*]}"; fi
  if [ ${#need_rt[@]} -gt 0 ]; then warn "Missing runtime packages: ${need_rt[*]}"; fi
else
  say "  Installing ${#need[@]} build and ${#need_rt[@]} runtime package(s) with sudo."
  sudo apt-get update
  sudo apt-get install -y "${need[@]}" "${need_rt[@]}"
  good "apt done"
fi

# ------------------------------------------------------------------ rust

step "Rust"

# Make sure a future shell can find cargo. rustup normally does this
# itself; this is here for when rustup is already installed but its
# PATH line never made it into the profile. Appends only where the line
# is absent, so re-running the script cannot stack duplicates.
ensure_cargo_on_path() {
  local line='. "$HOME/.cargo/env"'
  local f
  for f in "$HOME/.bashrc" "$HOME/.profile"; do
    [ -f "$f" ] || continue
    if ! grep -qF '.cargo/env' "$f"; then
      printf '
# Added by heeler linux-setup.sh
%s
' "$line" >> "$f"
      good "Added cargo to PATH in $f"
    fi
  done
}

# True when some login file already sources cargo's env, which is a
# different question from whether this shell can see cargo: source
# ~/.cargo/env by hand once and every PATH check below passes while a
# new terminal still comes up without cargo. So ask the files.
profile_has_cargo() {
  local f
  for f in "$HOME/.bashrc" "$HOME/.profile"; do
    [ -f "$f" ] || continue
    grep -qF '.cargo/env' "$f" && return 0
  done
  return 1
}

if command -v cargo >/dev/null; then
  good "cargo $(cargo --version | awk '{print $2}')"
elif [ -x "$HOME/.cargo/bin/cargo" ]; then
  # Installed, but the shell cannot see it. An earlier version of this
  # script ran rustup with --no-modify-path, which installs cargo and
  # then tells nothing about it: a new shell did not help either,
  # because nothing was ever written to the profile. Repair rather than
  # reinstall; rustup-init refuses a second run anyway.
  # shellcheck disable=SC1091
  . "$HOME/.cargo/env"
  warn "cargo was installed but not on your PATH."
  good "cargo $(cargo --version | awk '{print $2}')"
  NEW_SHELL_NEEDED=1
elif [ "$VERIFY_ONLY" -eq 1 ]; then
  warn "No cargo on PATH and none installed"
else
  say "  Installing rustup (stable toolchain, no prompts)."
  # No --no-modify-path: rustup should write its own PATH line, or the
  # install is useless the moment this script exits.
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
  # shellcheck disable=SC1091
  . "$HOME/.cargo/env"
  good "cargo $(cargo --version | awk '{print $2}')"
  NEW_SHELL_NEEDED=1
fi

# Whichever way we got here, make the next terminal work too. Sourcing
# ~/.cargo/env by hand fixes one shell and nothing else, and the VM is
# rebooted more often than that line is remembered.
if [ -x "$HOME/.cargo/bin/cargo" ] && ! profile_has_cargo; then
  if [ "$VERIFY_ONLY" -eq 1 ]; then
    warn "Nothing in ~/.bashrc or ~/.profile sources ~/.cargo/env, so a new"
    warn "terminal will come up with no cargo. Re-run without --verify to fix."
  else
    ensure_cargo_on_path
  fi
fi

# ------------------------------------------------------------------ node

step "Node"

node_major() { node --version 2>/dev/null | sed 's/^v//; s/\..*//'; }

if [ "$DO_NODE" -eq 0 ]; then
  say "  ${DIM}skipped (--no-node)${R}"
elif command -v node >/dev/null && [ "$(node_major)" -ge 20 ] 2>/dev/null; then
  good "node $(node --version), npm $(npm --version 2>/dev/null || echo '?')"
elif [ "$VERIFY_ONLY" -eq 1 ]; then
  if command -v node >/dev/null; then
    warn "node $(node --version) is older than the 20 the Linux plan asks for"
  else
    warn "No node on PATH"
  fi
else
  # Ubuntu 24.04 ships Node 18, which builds Heeler but is behind what
  # the plan asks for, so take 20 LTS from NodeSource.
  say "  Installing Node 20 LTS from NodeSource."
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
  good "node $(node --version), npm $(npm --version)"
fi

# ------------------------------------------------------- frontend packages

step "Frontend packages"

ROOT="$(repo_root || true)"

# A checkout on a mounted Windows drive is the wrong place to build from,
# and it fails in a way that blames something else. node_modules and
# target/ both hold platform-specific binaries: npm installs
# @rollup/rollup-win32-x64-msvc on Windows and rollup-linux-x64-gnu here,
# so a Windows-installed tree gives "Cannot find module
# @rollup/rollup-linux-x64-gnu" and an error message that points at an
# npm bug instead of at the mount. /mnt is also slow for the
# many-small-file work npm and cargo do.
case "$ROOT" in
  /mnt/*|/media/*|/cygdrive/*)
    warn "This checkout lives on $ROOT, which looks like a mounted Windows drive."
    warn "node_modules and target/ hold per-platform binaries and cannot be shared"
    warn "with a Windows build. Clone to the Linux filesystem instead:"
    warn "    git clone $ROOT ~/heeler && cd ~/heeler"
    ;;
esac

# The same fault, found directly: a node_modules built for another OS.
if [ -n "$ROOT" ] && [ -d "$ROOT/apps/heeler-app/node_modules/@rollup" ]; then
  if ! ls "$ROOT/apps/heeler-app/node_modules/@rollup" 2>/dev/null | grep -q linux; then
    warn "node_modules holds no linux rollup binary, so it was installed on another OS."
    warn "Its natives will not load here. Reinstall in a Linux-side checkout."
  fi
fi

if [ -z "$ROOT" ]; then
  warn "Not inside a Heeler checkout, so nothing to npm install."
  warn "Clone the repo and re-run from inside it to finish this step."
elif [ "$DO_NPM" -eq 0 ]; then
  say "  ${DIM}skipped (--no-npm)${R}"
elif [ "$VERIFY_ONLY" -eq 1 ]; then
  if [ -d "$ROOT/apps/heeler-app/node_modules" ]; then
    good "node_modules present"
  else
    warn "node_modules missing; run npm install in apps/heeler-app"
  fi
elif ! command -v npm >/dev/null; then
  warn "No npm, so skipping. Re-run without --no-node."
else
  say "  npm install in apps/heeler-app (this takes a minute)"
  (cd "$ROOT/apps/heeler-app" && npm install --no-fund --no-audit)
  good "node_modules ready"
fi

# ---------------------------------------------------------------- verify

step "Where that leaves you"

fail=0
check() { # name, command
  if command -v "$2" >/dev/null; then good "$1: $("${@:3}" 2>/dev/null | head -1)"; else bad "$1: not found"; fail=1; fi
}
check "cargo" cargo cargo --version
check "rustc" rustc rustc --version
if [ "$DO_NODE" -eq 1 ]; then check "node " node node --version; fi

if pkg-config --exists webkit2gtk-4.1 2>/dev/null; then
  good "webkit2gtk-4.1: $(pkg-config --modversion webkit2gtk-4.1)"
else
  bad "webkit2gtk-4.1 not visible to pkg-config; the Tauri build will fail here first"
  fail=1
fi

if command -v vulkaninfo >/dev/null; then
  if vulkaninfo --summary >/dev/null 2>&1; then
    good "Vulkan: a device answered"
  else
    warn "Vulkan: no working device. The app may fall back or fail to render."
    warn "In a VM this is normal; enable 3D acceleration in the hypervisor if previews are wrong."
  fi
fi

say ""
if [ "$fail" -eq 0 ]; then
  say "${OK}Dependencies are in place.${R}"
else
  say "${ERR}Something above is missing. Fix that before building.${R}"
fi

if [ "$NEW_SHELL_NEEDED" -eq 1 ]; then
  say ""
  say "${WARN}cargo is on the PATH for this script, but not yet for your shell.${R}"
  say "Before the commands below will work, either open a new terminal, or run:"
  say ""
  say "  . \"\$HOME/.cargo/env\""
fi

cat <<'NEXT'

Next, from the repo root:

  cargo test --workspace --features heeler-io/libraw    the Rust suites
  cd apps/heeler-app && npm test                        the frontend suites
  cd apps/heeler-app && npx tauri dev                   run it
  python3 scripts/dist.py                              stamped .deb and AppImage

Three things to expect on Linux specifically, none of them a broken setup:

  - HEIC does not open. Heeler decodes HEIC through the OS codec on
    macOS and Windows and ships no HEVC decoder of its own, and there is
    no Linux equivalent wired up. See docs/user-guide/legal/open-source.md.
  - The first build downloads an ONNX Runtime binary for the smart
    selection models, so it needs network and takes a while.
  - The first build also compiles LibRaw, SQLite, zlib and mozjpeg from
    source. Nothing links a distro package for those, which is the whole
    point, but it means the first build is slow and later ones are not.
NEXT
