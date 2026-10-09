# Versioning

Heeler's version is the year it shipped and the update within that year, with a third number only when a patch is needed: `2026.1`, then `2026.2`, then `2026.2.1` for a bug fix to it. It fits how Heeler is sold: bought once, updated for as long as it is maintained, with no roadmap toward a version 2. The first release of a year is `.1`; a year with no release gets no number.

- **YEAR**: the year the release ships.
- **UPDATE**: counts up within the year for releases that add or change something.
- **PATCH**: counts up for releases that only fix.

## What the code carries

Cargo and the Windows installer want a semantic version whose first number fits in a byte, and 2026 does not. The crates, `tauri.conf.json` and `package.json` therefore carry `YY.UPDATE.PATCH`, for example `26.1.0`, and the app puts the century back wherever a person reads the version: `display_version()` in the desktop crate turns `26.1.0` into `2026.1` and `26.1.2` into `2026.1.2`. The build string in About and in the log reads `2026.1 build 412 (a8219f0)`: the version, the commit count, and the commit.

## Before the first release

The number is 2026.1 from the start; the scheme has no 0.x stage, and a beta of 2026.1 is still 2026.1. What tells a tester's build from the release is the build number, which rises with every commit, and the word pre-release in the build string: `2026.1 pre-release build 412 (a8219f0)`. The number and the hash are stamped by `scripts/dist.py` from the commit it builds; a build made by hand (`tauri dev`, `cargo build`) reads `build dev (dev)` and is never given to anyone. The setting is `PRE_RELEASE_DEFAULT` in `apps/heeler-app/src-tauri/src/version.rs`, false; a build overrules it with `--pre-release` or `--no-pre-release` on `scripts/dist.py`, which set `HEELER_PRE_RELEASE` for `build.rs` to bake in. So a tester bundle is stamped on the fly and nothing in the source changes between it and the release.

## Cutting a release

Since 2026-09-16 ("I definitely approve of this") a release is one
edit, two builds and one command, then a merge:

1. Set `version` in the **workspace `Cargo.toml`** to the new `YY.UPDATE.PATCH`. That is the only place the number is written: every crate takes it with `version.workspace = true`, the binary reads it as `CARGO_PKG_VERSION`, and the bundle takes it from there too, because `tauri.conf.json` declares no version of its own (Tauri: "if removed the version number from `Cargo.toml` is used"). A test, `the_bundle_version_is_the_crate_version` in `version.rs`, fails if anyone puts a conflicting one back.
2. Commit, run `python scripts/test.py` on both platforms, and build the installers from that commit with `python scripts/dist.py` on each; the build number and hash come from the commit itself (the scripts read them from git and pass them to the build), so neither is ever edited by hand. `PRE_RELEASE_DEFAULT` in `apps/heeler-app/src-tauri/src/version.rs` is not part of this: it stays false, and a build that should say pre-release is given the flag (above). The constant used to be flipped in the release commit and back in the next, at line 12582 of a twenty-thousand-line `lib.rs` before it had a file of its own, and the first version bump that followed that rule went the wrong way round (2026-09-15), which is why the flag overrules it now.
3. `python scripts/release.py <the .dmg> <the .exe> --notes-file NOTES.md`, the notes a bullet list of what is new. It refuses a tag or release that already exists, creates and publishes the GitHub release with the installers, `models.json` and `latest.json` in one step, checks every upload answers, and commits `latest.json` to the public repo's `dev` branch. `--dry-run` shows the body and manifest first.
4. Merge `dev` into `main` on the public repo. That is the moment the release is live: the app and the website both read `latest.json` from `main`. Then `python scripts/latest_json.py --check`, and Check for Updates in the previous version.
5. Never reuse a number. A rebuilt release with any change is the next patch. Anything that lands on `main` after the build is the next patch's, whether or not it touches the binary.

`apps/heeler-app/package.json` also carries a `version`. Nothing reads it: the package is `"private": true`, Tauri takes the bundle version from Cargo, and no code imports it. It is not part of cutting a release and may be left where it is.

Build scripts set `HEELER_BUILD_STAMPED=1` only in the child build environment, alongside the number and hash. Hand builds ignore ambient `HEELER_BUILD_NUMBER` and `HEELER_BUILD_HASH` without that explicit stamp. Do not export the stamp in your shell. Moving from a stamped build to a hand build rebuilds once to restore `build dev (dev)`; the reverse transition also rebuilds once. Linux bundles use `python3 scripts/dist.py` too. Bare `tauri build`, including `--debug` bundles, is for local use only.
