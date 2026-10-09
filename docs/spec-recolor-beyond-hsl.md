# Recolor beyond HSL

Status: **v1 BUILT 2026-09-03** (engine op, executor and desktop
planting, panel seats, Match picker, user guide), and the deferred
list cleared the same day: sat→hue, the Around row, the Mask row, hue
spread, the Hue × Lum surface, the Pastel rename with the Temp, Tint
and Vibrance outputs, and the cropped depth view. What remains open
is listed at the end. Two things changed
between proposal and build and are recorded in place: the tint walks
in OkLab rather than linear RGB (Part 2 says why), and a Recolor whose
only active cells are depth cells with no plane planted is a bit-exact
identity. the owner's brief: "Recolor, where
the user can toggle combinations between Hue, Sat, and Luminance. This
is more or less what [the color grader] does, and it's strong. But what else can we
add, beyond those 3? How can we push the boundaries further than [the color grader]
did?" This document is the answer, sized for one milestone. The ideas
that did not make the cut are listed at the end so they are not lost.

Anchors: docs/spec-color-sets.md (the OkLCh science floor and its
invariant tests, which every new path here inherits), the Recolor op's
own header (crates/heeler-engine/src/ops_recolor.rs, the honest-channels
contract and parallel evaluation), and the depth tools
(ops_depth.rs), whose farness plane the new axis reads.

## What Recolor is today

A routing matrix. A curve's x-axis is a channel that decides WHICH
pixels (BY: hue, sat, lum), its y-axis a channel that decides WHAT
changes (ADJUST: hue, sat, lum). Seven of the nine cells ship. Every
curve reads the ORIGINAL pixel and the effects compose once, so curves
cannot feed back into each other. Hue-indexed cells fade out through
the Neutral guard, and the index reads a spatially smoothed chroma
field so shadow noise does not become confetti.

A leading color grader ships six of those cells as six unrelated tools. Adding the
missing two cells would make Recolor a tidier copy of it. This proposal
adds new KINDS of axis instead, in three parts.

## Part 1: Depth as a BY axis

Heeler computes a farness plane per photograph (Depth Anything V2,
planted for the fog, key light and depth-of-field nodes). Nothing in a
colorist's toolset can select by it without a hand-made matte. Recolor
gains a fourth BY row, **Depth**, with cells depth→hue, depth→sat,
depth→lum and (from Part 2) depth→tint.

What it is for: atmospheric perspective as a curve. Cool and desaturate
with distance, or the reverse to pull a subject forward; darken the far
plane a third of a stop; tint the far plane toward the sky. Fog does one
fixed version of this; a curve does whichever one the photograph needs.

- **Axis**: x is farness 0..100, NEAR on the left, FAR on the right,
  ticks at 0, 50, 100, snap 10. The plane is already 0..1 and already
  smooth, so no field blur and no guard: the index is reliable for
  every pixel, neutrals included, exactly like the lum-indexed row.
- **Plumbing**: the op reads a `raster` input like the depth tools do
  (`plane_from`, resampled to the render size). `wants_planted_raster`
  and `raster_fed` gain `heeler.recolor` WHEN any depth cell is active,
  so a Recolor without depth curves costs nothing and plants nothing.
  Planted rasters follow the chain's crop since 2026-09-03
  (`conform_rasters_to_geometry`), so a cropped photo's depth row lines
  up; the ROI slice path is covered by the same pass.
- **No plane**: depth cells are inert (the depth tools' contract), and
  the panel shows the same compute affordance those tools show, so the
  first drag on a depth cell asks the DepthRunner for the plane rather
  than silently doing nothing.
- **Composition**: depth-indexed values join the same accumulators as
  the other rows. Hue shift adds in degrees, sat multiplies as
  `1 + y/100`, lum adds in EV, all clamped exactly as the existing rows
  are. Parallel evaluation is unchanged: the depth index is read from
  the plane, never from a pixel a curve already moved.

## Part 2: Pastel, the painter's mix

Named Tint in the first draft and the first build. the owner, seeing a Depth
row drive it: "how I see Tint in By being used is like that Tint
slider in Color... Maybe I am confused on how tint is being used right
now." He was not confused; the name was wrong for this app, where
Tint already means the green/magenta half of white balance. The mix
toward white is **Pastel**, and Tint is now what it says everywhere
else (Part 4).

HSL tools move lightness at constant chroma. That is not how pigment
or print behaves, and it is why a brightened color in an HSL tool goes
neon and clips instead of going pastel. Painters have three mixes:

| Mix   | Toward | In Heeler today                                    |
|-------|--------|----------------------------------------------------|
| Tone  | gray   | the **sat** output (chroma scale at constant L)    |
| Shade | black  | the **lum** output at negative EV (a gain preserves chromaticity, which IS mixing black) |
| Tint  | white  | **missing**                                        |

Two of the three exist under other names. The third is the gap, and it
is the one HSL cannot express: brightening that walks the straight line
to white, so a red becomes pink rather than a brighter, harsher red.
Recolor gains an ADJUST column, **Pastel**, on every BY row.

- **Math**, in OkLab, applied to the graded color: `W` is white at
  `L = max(1, L)` (a pixel already above diffuse white mixes toward
  its own gray, which is tone, rather than being pulled down).
  `L' = L + t * (L_W - L)`, `a' = a * (1 - t)`, `b' = b * (1 - t)`,
  t in -1..1. Positive t is tint. Negative t walks the same line away
  from white (more chroma, less lightness); the conversion back floors
  any channel that leaves the gamut. A "de-pastel" that HSL also
  cannot do.
- **Why OkLab and not linear RGB**: the first draft of this spec argued
  for a straight line in linear light, as mixing white light or paint
  does. Built and measured, that line drifts OkLab hue by about six
  degrees on a saturated red (the Abney effect, in effect). Hue is the
  one thing a tint must hold, and every other Recolor path already
  speaks OkLCh, so the walk is in OkLab, where hue is held by
  construction and a test pins it to a thousandth of a radian.
- **Axis**: y is -100..100 percent of the way to white, snap 10.
- **Guard**: hue-indexed tint is chroma-gated like every hue-indexed
  effect (the INDEX is unreliable on neutrals); sat-, lum- and
  depth-indexed tint are not gated, since tinting a near-neutral
  shadow toward white is a legitimate intent.
- **Composition**: tint amounts from every row sum and clamp to
  -1..1, and the mix applies AFTER the hue, sat and lum effects, as
  the last step of the one composed transform. Order matters here and
  the choice is deliberate: tint reads as "then mix white into the
  graded color," which is how a painter would do it.

## Part 4: the Color section's dials as outputs

"We adjust tint globally, what if we could drive tint colors (that
greenish to magenta) by adjusting depth... To be able to drive
temperature values by other attributes seems powerful to me, and
original, and since vibrance goes hand in hand with saturation a lot
why not consider that?" Three more ADJUST columns, on every BY row:

- **Temp**: a warm/cool cast, positive warm. In OkLab, an offset along
  b (toward yellow) at constant L; full scale is 0.08, a quarter of a
  deep primary's chroma. A gray shifts too, unlike hue rotation,
  because a cast is a cast.
- **Tint**: the magenta/green cast, positive magenta: the same offset
  along a.
- **Vibrance**: a chroma scale weighted by how muted the pixel already
  is, `1 + v * (1 - C / C_FULL)`, so the vivid stay put while the muted
  come up, and negative takes the muted down first.

Both casts apply after hue, sat and vibrance and before the exposure
gain and the pastel mix, so "cool the far plane, then let it go pastel"
composes in the order a painter would do it. Built the same day, with
the op restructured as rows × outputs (`Row`, `Terms`) so a seventh
column is a field, not a rewrite.

## Part 3: the Match picker

Recolor's picker today places one point: sample a pixel, land on its
position in the editor. The Match picker places an intent. Click the
color you have, click the color you want, and Heeler writes the points
that carry the first to the second.

- **Gesture**: the picker gains a second mode, Match, beside Pick.
  First click pins the source (a marker on the photo, status bar:
  "Now click the color it should become"). Second click writes.
  Escape between the clicks cancels and drops the pin. One undo entry.
- **What it writes**, from the two ORIGINAL pixels S and T through
  the engine's own channel definitions (OkLCh h and C, EV):
  hue→hue at h_S: `wrap(h_T - h_S)` clamped ±60;
  hue→sat at h_S: `(C_T / C_S - 1) * 100` clamped ±100;
  hue→lum at h_S: `log2(Y_T / Y_S)` clamped ±2.
  A point already within 10° of h_S on a cell is replaced, not
  doubled. A source pixel under the Neutral guard has no hue to key on;
  the picker says so in the status bar and writes nothing.
- **Pure core**: `matchPoints(S, T, curves)` in eqcurve.ts, tested
  headless: the written points, evaluated through the frontend twins of
  the engine formulas, take S to T within a tolerance, and a second
  Match on the same source replaces rather than stacks.
- **Why it belongs here and not in Color Sets**: a set is a range with
  one grade; Match is a point on three curves at once, and the curves
  stay editable afterwards. It is the fastest way into the matrix for
  someone who has never used a hue curve.

## Parameters and persistence

The `curves` text param's keys are `{by}_{adjust}` for every BY row
(hue, sat, lum, depth, around) and ADJUST column (hue, sat, lum,
pastel, temp, tint, vib), bar `lum_lum`: 34 cells. The first build
carried `*_tint` for the pastel mix; it was renamed before anything
shipped, so no saved graph carries the old key. An
absent key is an inactive cell, so every saved graph renders exactly as
before. `RecolorCellId` and `RECOLOR_CELLS` grow the same seven
entries; `RECOLOR_AXIS` gains `depth`, `RECOLOR_OUT` gains `tint`.
No new numeric params: Neutral guard and Smoothing keep their meaning.

The Recolor node's `armed` rule (a bypassed node switches on when a
curve says something) already reads the curves text, so a first depth
or tint point turns the node on like any other.

## UI seats

Recolor's block is a BY segment over an ADJUST segment. BY gains
**Depth** as its fourth seat (the depth tools' icon), ADJUST gains
**Tint** as its fourth. The matrix stays a lens over the same node; the
Graph inspector shows the same cells. The pop-out window follows for
free (it renders the same component).

Depth's axis labels read NEAR and FAR where the others read degrees,
percent and stops; the Layout menu offers every 25 and every 10. The
Match mode sits in the picker's own seat as a toggle pair (Pick / Match)
rather than a new button, per the one-seat-per-control rule.

## Invariant tests

Engine (ops_recolor.rs), beside the existing ones:

- Tint 0 is bit-exact identity; tint 100 lands every pixel at or below
  diffuse white on `W`; tint preserves the OkLab a,b direction until
  chroma is zero; negative tint never produces a negative channel.
- Depth cells are inert without a raster and read the plane resampled
  to the render size; a cropped render with a planted plane matches the
  same render on a pre-cropped plane (the conform pass's contract, but
  driven through Recolor).
- The ingest rule from the debugging notes: a test drives a depth curve
  THROUGH build_graph, not only the op, so a param dropped at ingest
  cannot hide behind a green op test.

Frontend (eqcurve, recolor tests):

- `matchPoints` round-trips S to T; a second Match replaces; a neutral
  source writes nothing and explains why.
- Seven new cells parse, serialize and survive the popout's snapshot
  echo.

## Effort

Engine: one day (raster plumbing mirrors the depth tools; tint is one
more term in the composed transform). Panel: one day (two seats, one
axis table entry, the depth compute affordance reused). Match picker:
half a day plus tests. Documentation: the Recolor user page gains a
Depth section, a Tint paragraph, and the Match gesture.

## Deferred, deliberately

Each of these was real and none blocked the above. All are now built
(struck through below, with what changed in the building). Still open,
because it needs a design conversation rather than a cell: a second
surface pair (Hue × Sat, Sat × Lum) on the same grid editor, and
whether the Match picker should also write onto the surfaces.

- ~~Neighborhood hue as a BY axis~~: **built 2026-09-03** as the
  **Around** row (around→hue, sat, lum, tint) with one dial,
  `around_radius`, in percent of the short side (default 15, 2..50).
  The index is the unsmoothed OkLab a,b field box-blurred at that
  radius, gated by the SURROUNDINGS' chroma through the Neutral guard.
  At the frame edge the blur reads what is there, which is the honest
  answer. The dial is seated beside the editor only while an Around
  cell is up; the picker samples as wide as the dial.
- ~~Two-input cells (surfaces)~~: **built 2026-09-03** as the
  **Hue × Lum** row, one surface per output, in the node's `surfaces`
  text param: five rows (EV -6..+3, evenly) by twelve columns (every
  30°), read bilinearly, periodic across and clamped up, gated like
  the hue row. The editor is a grid with drag-to-set cells rather than
  a heat-map with pins: a cell is a seat, the numbers show on the
  cells, and there is nothing to place. Flat grids serialize away.
- ~~Hue spread~~: **built 2026-09-03** as a verb on the hue→hue cell
  (`hue_hue_mode`: "" or "shift", or "spread"), a Shift/Spread pair
  beside the menus. In spread mode the curve s(h), in percent, becomes
  an offset table whose slope is `1 + (s - mean(s))/100`: subtracting
  the mean keeps it periodic, so nothing turns overall and +100 over a
  band doubles the separation of the hues in it. The same points serve
  both verbs; the y axis relabels to percent.
- ~~Sat → hue, the rare bird~~: **built 2026-09-03**, the day after
  the rest, once the generalized matrix made it one cell. Not gated:
  the sat axis already reads zero for a neutral, and a rotation at
  zero chroma is nothing.
- ~~Any mask as a BY axis~~: **built 2026-09-03** as the **Mask** row.
  The node names a mask in `by_mask`; the serializer wires that mask
  to a new `by` port (a Mask input the registry declares beside the
  gating `mask` port), in the serialized graph only, the way the ROI
  splice never shows in the editor. The op resamples the mask to the
  render size and folds the row at coverage × 100; `inject_roi` crops
  `by` feeds like `mask` feeds so sharp slices line up. Inert with
  nothing wired, rather than reading zero coverage everywhere.
- ~~Depth for the depth view~~: **done 2026-09-03**; the view takes
  the crop nodes the terminal sits behind, sharp slices included.
