# Building Heeler

Developer documentation: how to run, test, and build the app in each
of its contexts, and what to check before an installer leaves the
machine. The user guide ships in the app; this file is for whoever holds the repo.

## Prerequisites, once per machine

- Rust stable via rustup (the workspace pins nothing exotic).
- Node 18 or newer, with npm.
- On Windows and Linux x64, NASM on PATH (`winget install NASM.NASM`;
  `scripts/linux-setup.sh` installs it on Linux). mozjpeg assembles its
  x86 SIMD with it, and that SIMD is what encodes the viewer's frames
  and decodes lossy DNGs quickly. Without it the build still succeeds,
  on mozjpeg's scalar path at about half the speed, and the build
  scripts print a warning. macOS arm64 needs nothing.
- One-time frontend setup:

  ```
  cd apps/heeler-app
  npm install
  ```

The first Rust build compiles the whole engine workspace and takes a
while; every build after that is incremental.

## Day-to-day development

Everything runs from `apps/heeler-app`:

```
cd apps/heeler-app
npx tauri dev
```

That starts Vite on port 5173 and opens the app against the live
frontend. Edits to the React side hot-reload; edits to Rust rebuild
and relaunch.

### Tests

```
cd apps/heeler-app
npm test
```

Run the frontend tests from `apps/heeler-app`, not the repo root: a
root-level vitest run picks up the wrong config and fails hundreds of
tests that are actually fine.

Rust tests, per crate from the repo root:

```
cargo test -p heeler-desktop
cargo test -p heeler-io -p heeler-catalog -p heeler-graph -p heeler-engine
```

The JPEG XL sanity helper and its synthetic test also build without either
optional RAW decoder feature. The real-file comparisons remain opt-in.

For an offline test run with an already installed ONNX Runtime library,
set `ORT_LIB_LOCATION` to the directory holding `libonnxruntime.a` (the
ort build cache under `~/Library/Caches/ort.pyke.io` on a machine that
has built the app before) and `CARGO_NET_OFFLINE=true`. A missing
runtime is a setup failure; do not skip the vision suite to make a
desktop test run appear green.

Two caveats:

- `heeler-gpu` tests talk to the real GPU adapter and can hang on some
  machines. Run that crate deliberately, not as part of a blanket
  `cargo test` you plan to walk away from.
- `cargo test` for `heeler-desktop` runs the serve and batch
  suites too; nothing needs a display.

## The build contexts

There is one build, plus the headless modes that ride along in it.
Every build is the same product, with every feature.

### 1. The build

```
cd apps/heeler-app
npx tauri build
```

This bare command carries `build dev (dev)` and is for local use. Use
`python scripts/dist.py` from the repository root for any bundle sent to
a tester, including Linux.

Signing failures on Windows now happen before the frontend build, just
as on macOS. Store builds retain the signing override and add the
WebView2 offline installer to it.

The one-command form is `python scripts/dist.py`, which on
macOS produces the shipping configuration:
signed with the Developer ID Application certificate in the keychain,
notarized by Apple, and stapled (the .app and the DMG both). It needs
notarization credentials exported and refuses to start without them
rather than spend the build on a DMG other Macs will not open. The
credentials in use are an App Store Connect team API key with the
Developer role: `APPLE_API_KEY` (key ID), `APPLE_API_ISSUER` (issuer
ID) and `APPLE_API_KEY_PATH` (the downloaded .p8, kept outside every
repo). An Apple ID plus app-specific password (`APPLE_ID`,
`APPLE_PASSWORD`, `APPLE_TEAM_ID`) also works, but a failed sign-in
with those can lock the Apple ID, which has happened; the key cannot.
`--unsigned` gives an ad-hoc build for this machine only, and
`--run-tests` runs the full suites before the build (opt-in). With fresh
credentials run `python scripts/dist.py --check-credentials` first: it
makes one authenticated request to the notary service and no build, so
a wrong password fails once, immediately, rather than after a compile
(repeated failed sign-ins can lock an Apple ID, and unlocking one is a
bad afternoon; the API key never touches that sign-in). Notarization is a round trip to Apple, usually a minute or two,
occasionally longer the first time. Installers land in:

```
target\release\bundle\nsis\Heeler_<version>_x64-setup.exe
target\release\bundle\msi\Heeler_<version>_x64_en-US.msi
```

The NSIS `-setup.exe` is the one to hand to people; the MSI exists for
managed installs.

On Linux the same command emits, under `target/release/bundle/`:

```
deb/Heeler_<version>_amd64.deb
appimage/Heeler_<version>_amd64.AppImage
```

Installing the .deb needs a path apt recognizes AS a path, which means a
leading `./`:

```
sudo apt install ./target/release/bundle/deb/Heeler_<version>_amd64.deb
```

Without it apt reads the argument as a package name and answers "Unable
to locate package target/release/bundle/deb", which sounds like a broken
build and is not one. `sudo dpkg -i <file>` followed by `sudo apt -f
install` does the same job. Worth putting in the note that goes out with
a tester build, because the error names the wrong problem.

### 2. Headless modes (no separate build)

Every built Heeler.exe also answers the command line; there is nothing
extra to build or bundle:

- **Batch mode**: `Heeler.exe -x script.heeler` runs a Python script
  against the catalog with no window, exit codes honest for `.bat`
  chaining. See the Scripting pages in the user guide.
- **Media server**: `Heeler.exe serve <catalog> --collection NAME`
  serves a collection as a view-only gallery. See Sharing a collection
  on the user guide's Library page.

## Before an installer goes out

1. Bump `version` in the workspace `Cargo.toml`. That is the only place
   it is written: every crate takes it with `version.workspace = true`,
   the binary reads it as `CARGO_PKG_VERSION`, and the bundle takes it
   from Cargo because `tauri.conf.json` declares no version of its own.
   `apps/heeler-app/package.json` also carries one, but nothing reads
   it. Nothing to edit for pre-release: the setting in `version.rs`
   stays false, and `--pre-release` on `dist.py` stamps a pre-release
   build on the fly. See
   [versioning.md](versioning.md).
2. Full test pass: `python scripts/test.py`, which runs the release
   tests, the Rust workspace, the frontend's type check and the frontend
   suite and nothing else. Safe to chain:
   `python scripts/test.py && python scripts/dist.py`.
3. Install on a machine (or VM) that is not your editing machine.
   Confirm: a fresh install opens straight into the app, every feature
   works, and Help > User Documentation shows every chapter (the guide ships as bundle
   resources).
4. Build with `python scripts/dist.py` on both platforms, so the result
   is signed: on macOS the DMG is notarized and stapled and proven with
   `spctl`, and on Windows the installers are signed through Azure
   Artifact Signing and proven with `Get-AuthenticodeSignature`.
   Neither reports success on a bundle the other machine would warn
   about.

### Windows signing, once per machine

Creating the service principal and renewing its secret, in full, is
kept with the signing account's own records, outside this repository.
The short version:

The certificate lives in Microsoft's cloud, so there is no key file on
the build machine. There is a tool and a set of credentials:

```
cargo install artifact-signing-cli
```

The tool signs as a service principal, not as you: it takes the tenant,
client and secret as required arguments and has no interactive login, so
`az login` does not help it and the Azure CLI is not needed at all.
Create the principal once (Microsoft Entra ID > App registrations > New
registration, then Certificates & secrets > New client secret), give it
the "Artifact Signing Certificate Profile Signer" role on the signing
account under Access control (IAM), and set `AZURE_TENANT_ID`,
`AZURE_CLIENT_ID` and `AZURE_CLIENT_SECRET` in the build machine's
environment. **The secret expires** on the date chosen when it was
created; signing stops working that day, and the fix is a new secret in
the same app registration. The account,
certificate profile and region come from the environment too:
`HEELER_SIGNING_ACCOUNT` (the Artifact Signing account's name),
`HEELER_SIGNING_PROFILE` (its certificate profile) and
`HEELER_SIGNING_REGION` (its Azure region, such as `eastus`).
Signing happens only in the build scripts: a plain `npx tauri build`
stays unsigned and offline.
7. `python scripts/release.py <the .dmg> <the .exe> --notes-file NOTES.md`,
   with the notes a bullet list of what is new. It creates and publishes
   the GitHub release under `v<version>` with the installers under their
   release names, `models.json` from `docs/`, and `latest.json` written
   for those names, all in one step; then it checks every upload answers
   and commits `latest.json` to the public repo's `dev` branch. Merge
   `dev` into `main` when you want the release live: the app and the
   website both read `latest.json` from `main`. Then
   `python scripts/latest_json.py --check` confirms `main` serves the
   new manifest and every installer it names answers. `--dry-run` shows
   what would be published.

## Gotchas that have actually happened

- **Ghost chapters in Help during dev**: `tauri dev` copies
  `docs/user-guide/` into `target\debug\docs\` as bundle resources and
  never deletes files that were renamed away, so old chapters can
  haunt the docs viewer. Delete `target\debug\docs\` and rerun; real
  installs never hit this because the installer replaces resources
  wholesale.
- **Linker errors (LNK2019/LNK1120) out of nowhere**: a stale
  incremental cache, usually after an interrupted build. `cargo clean
  -p heeler-io -p heeler-desktop` and rebuild.
- **Port 5173 already in use**: another `tauri dev` (or its orphaned
  Vite) is still running; kill it rather than letting two dev servers
  fight.
- **`cargo test -p heeler-desktop` on Windows dies before the first test
  with `STATUS_ENTRYPOINT_NOT_FOUND` (0xc0000139)**: the test executable
  has no Windows manifest, so the loader binds `comctl32.dll` to the
  5.82 copy in System32, which has no `TaskDialogIndirect`, and refuses
  the process. The import rides in through rfd and muda as soon as any
  test reaches the dialog plugin or event emission, and the MSVC linker
  keeps it after discarding the code (26.3, 2026-09-20: no dependency
  had changed, only what the tests reach). Cargo has no link-arg key
  that reaches the lib's own harness and not the bin, so `build.rs` now
  embeds the manifest through the linker into every target the crate
  links (`windows_manifest`), Tauri's resource carries the icon and
  version block only, and the lib test
  `the_test_executable_asks_for_common_controls_6` reads the manifest
  back. For any crash of this shape, run the test exe by hand from
  `target\debug\deps`: Windows then shows the dialog naming the DLL and
  the procedure, which cargo swallows.

## Offline accessibility and performance fixtures

The accessibility matrix extends the keynav, hint, disabled-control and theme
suites. Run it with installed tools from `apps/heeler-app`:

```
npx --no-install vitest run src/__tests__/accessibilitymatrix.test.tsx
```

Native screen reader acceptance uses the
[VoiceOver and Narrator checklist](user-guide/accessibility.md). DOM tests check
roles, names, keyboard actions and focus ownership; they do not certify what a
particular operating-system screen reader speaks.

Performance fixtures are opt-in. They use synthetic rows or pixels and no
photographs, network services, model downloads or development server. From
`apps/heeler-app`, run:

```
HEELER_PERF=1 npx --no-install vitest run src/__tests__/performancefixtures.test.tsx
node scripts/libraryperf.mjs
```

The Vitest fixture mounts the real Ribbon with the real reducer and 5,000 rows.
It records commit plus animation-frame latency, dispatched scrolling, filtering,
sorting, sampled heap use and serialized session size. jsdom has no paint or
layout: its scroll-dispatch figure is not a browser paint measurement. It also
writes `/tmp/heeler-phase6-default-graph.json` from the app's actual neutral graph;
run it before the CPU drag fixture below.

The browser fixture uses the installed test browser at the same macOS path as
`docshots.mjs`, bundles the synthetic scene with the installed Vite, and loads a
file URL. It blocks external requests and closes the browser itself. It records first
paint after two animation frames, 101 scroll positions across the entire strip,
filter and sort paints, sampled peak JavaScript heap, retained heap after garbage
collection and DOM counts. Scroll time includes two animation frames at each
position; this pacing is intentionally the same before and after an optimization.
The sample interval is 25 ms, so the heap peak is a sampled lower bound, not an
allocator high-water mark. The CPU profile and temporary bundle are under
`/tmp/heeler-phase6-browser/`.

To compare the ribbon implementation at a known local commit, the same browser
fixture can read that file directly from Git, without changing the checkout:

```
HEELER_PERF_REF=a8be7b7 node scripts/libraryperf.mjs
```

This replaces only the ribbon/menu source module in the fixture. Other modules,
the synthetic rows, viewport and pacing stay the same. Omit the variable to
measure the working tree. Save each command's output separately when comparing.

From the repository root, run the native fixtures with cached dependencies:

```
CARGO_NET_OFFLINE=true cargo test -p heeler-catalog --release bench_library_5000 -- --ignored --nocapture
CARGO_NET_OFFLINE=true cargo test -p heeler-engine --release --test bench_preview_drags -- --ignored --nocapture
CARGO_NET_OFFLINE=true cargo test -p heeler-stitch --release bench_member_counts -- --ignored --nocapture
```

The catalog fixture reopens an on-disk catalog containing 5,000 generated rows,
then lists, filters and sorts them. SQLite reports its retained page-cache,
schema and statement memory; the row-vector figure separately counts struct
storage and excludes owned strings. The preview fixture performs 200 exposure
steps on 6000 by 4000 synthetic pixels through the exported default chain, using
the CPU executor and the app's 1,500,000,000-byte cache trim. It repeats with the
machine allowance and an injected 4 GiB allowance. It prints minimum, median and
95th-percentile step latency, a separate admission probe, retained cache memory
and an output check. The probe is outside the timed render; render still runs
its normal admission internally.

The panorama fixture uses two, four, eight and sixteen 260 by 200 views of one
synthetic world, with a fixed angular span and increasing overlap. It records
feature detection, pair matching, camera solving, alignment total, compositing,
canvas dimensions and peak accounted memory. These fixtures measure increasing
member count, not increasing source resolution.

Native peak and retained frame figures come from
`heeler_engine::memory::Budget::snapshot`. Peak means the high-water sum of
admitted reservations and tracked live buffers, with shared buffers counted
once. It is conservative accounting, not process RSS; untracked small Rust
allocations and frontend heaps are outside that figure. Snapshot counters do not
change admission limits or pixel processing. For native sampling on macOS,
`sample <fixture-process-id> 3 -file /tmp/heeler-profile.txt` captures a three-second
CPU profile of a running release fixture.

The field-chain goldens remain the pixel guard. The normal suite checks the
small synthetic frame. The optional full demo-frame comparison can use an
explicit, independently verified baseline directory:

```
CARGO_NET_OFFLINE=true HEELER_FIELD_GOLDEN_DIR=/absolute/path/to/baseline/crates/heeler-engine/tests cargo test -p heeler-engine --release --test bench_field_chain -- --include-ignored --nocapture
```

An explicit directory is read-only: missing references fail rather than
bootstrap. Without it, the harness retains its existing per-machine reference
behavior. To establish a comparison across revisions, build the requested Git
revision in a separate temporary source directory and a separate Cargo target
directory, run its field harness there, then use that directory as the reference
for the working tree. A shared target directory can reuse a binary containing a
different `CARGO_MANIFEST_DIR`; it is not valid baseline evidence.
