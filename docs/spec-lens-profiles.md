# Lens profiles (lensfun database)

Status: **P1 and P2 BUILT** (2026-08-23). P2: the lens_correct op
speaks the real lensfun models (ptlens/poly3/poly5) behind dist_*
parameters; `LensProfile::distortion_at` interpolates calibration rows
to the shot's focal length (linear between same-model rows, nearest
across model changes, clamped outside the range, single-row primes
apply without a focal length); crop-factor mismatch scales the
polynomial's argument (dist_scale = profile crop / camera crop, from
the file's own focal_35/focal). The panel's profile line gained APPLY,
which writes model + coefficients onto the node as ONE undo step (the
set_params command grew an optional text map for exactly this). The
profile factor multiplies with the manual sliders: a profile plus a
hand trim is two radial maps composed. Radius convention: r = 1 at
half the shorter side, the ptlens convention the database is
calibrated in; the manual slider keeps its corner-normalized radius.
P3 BUILT the same day (testers may well shoot calibrated glass,
so the profile should finish the job): TCA (poly3, with the database's
linear model folded into the same shape at parse time) and vignetting
(pa model, interpolated over focal AND aperture, farthest calibration
distance preferred) ride the same Apply. Convention note, verified
against lensfun's own source comments: distortion and TCA are
calibrated with r = 1 at HALF THE SHORTER SIDE; the pa vignetting
model uses r = 1 at the CORNER. The op keeps both radii and documents
which model reads which. Vignetting without a known aperture is
refused rather than guessed: falloff changes too much between wide
open and stopped down. All profile parameters are written on every
Apply, neutral where uncalibrated, so switching photos never leaves a
previous lens's coefficients behind. The database is vendored under
`third_party/lensfun-db` (full snapshot, per the product decision; NOTICE.md
carries the CC-BY-SA attribution, and the user-facing paragraph is on
the open-source page). The parser and matcher live in
`heeler-io/src/lensdb.rs`; the Lens panel names the profile (or says
"no profile" with the lens's own name). P2 and P3 below remain.

What building P1 against the owner's real library taught us:

- Panasonic bodies write the lens name ONLY in the MakerNote (tag
  0x51) of the RW2's EMBEDDED JPEG; the outer TIFF has no LensModel at
  all, or the literal sentinel `NO-LENS` for adapted glass. exif.rs
  now descends JpgFromRaw (0x2e) and reads the note; sentinels are
  filtered everywhere.
- Matching needs two guards beyond numeric-token identity: a name with
  no numbers must match in full (or `NO-LENS` lands on a Zeiss), and
  when the EXIF name carries brand words at least one must appear in
  the candidate (or a Lumix 24-70 lands on the Nikkor 24-70).
- the owner's own glass: the Fuji XF50mmF2 matches with calibration; the
  Sigma 60-600mm DG DN 023 and Lumix S Pro 24-70/2.8 are not in
  lensfun's database (the DSLR 60-600 DG OS HSM is a different lens
  and is correctly refused), so they report "no profile" honestly.

## The licensing question, answered first

the owner asked: "because it uses GPL we can't directly use it in the app?"
The situation is better than that, because lensfun is two things with
two different licenses, and Heeler only wants one of them:

- **The lensfun LIBRARY (C code): LGPL-3.** We never link it. The
  research doc's plan was always to parse the database ourselves in
  original Rust, so the library's license is irrelevant to us.
- **The lensfun DATABASE (the XML files describing lenses): Creative
  Commons BY-SA 3.0.** That is a DATA license, not GPL, and it is
  commercial-friendly: we may bundle and use it in a paid app provided
  we (a) attribute the lensfun project visibly (the open-source page,
  next to the LibRaw and HEIC notes), and (b) if we modify the
  database files themselves, share those modifications under the same
  license. Share-alike binds the DATABASE, not the application that
  reads it. Heeler stays proprietary; the XML stays CC-BY-SA.

So: no GPL anywhere in the plan, no "leave it to users" fallback
needed. The one obligation is an attribution paragraph and publishing
any database edits we ever make, which costs nothing.

## Design

1. **Vendor the database** (the `data/db/*.xml` tree from the lensfun
   project, a few MB) under `third_party/lensfun-db/` with its license
   text, pinned to a dated snapshot. A build-time check hashes it so
   drift is deliberate.
2. **Parser** (original Rust, heeler-io or a small crate): the XML is
   flat and stable: `<lens>` entries with maker/model/mount/crop
   factor and `<calibration>` blocks holding `<distortion>` (models:
   ptlens, poly3, poly5), `<tca>`, and `<vignetting>` (pa model) rows
   at discrete focal lengths / apertures / distances.
3. **Matching**: EXIF already carries maker, camera model, lens model
   and focal length (our own reader). Match lens by normalized model
   string against the database (lensfun's own fuzzy rules are
   documented: case-insensitive token subset). Camera crop factor
   scales the profile when the lens was profiled on a different
   sensor. No match is a quiet nothing: the node stays manual.
4. **Evaluation**: interpolate the calibration rows to the shot's
   focal length (and aperture for vignetting), producing coefficients
   for the exact models. The current `heeler.lens_correct` op speaks
   its own simplified distortion/ca/vignette params, which is NOT the
   same math; the op grows the real models (ptlens/poly3/poly5 for
   distortion, pa for vignetting) behind new params the profile
   writes, keeping the manual sliders as the fallback face.
5. **The panel**: the Lens section gains "Profile: <matched name>"
   with an apply/auto toggle; applying writes the evaluated
   coefficients onto the node, visibly, the same
   measurement-sets-parameters contract Auto noise follows.
6. **Tests**: parser against vendored fixtures; interpolation pinned
   against lensfun's own reference values for one well-known lens;
   matching table-driven (exact, fuzzy, crop-scaled, miss).

## Phases

- P1: vendor + parse + match, report-only (the panel names the lens it
  would use). Proves matching against the owner's real library.
- P2: distortion model in the op + apply flow.
- P3: TCA and vignetting models; aperture interpolation.

## Open question for the owner

Bundle the whole database (~10 MB installed, everything matches out of
the box) or a curated subset (Panasonic + Fuji mounts now, the rest
downloadable later)? Recommendation: bundle everything; 10 MB is
nothing against one RAW file and "my lens isn't found" is a support
question we never want.
