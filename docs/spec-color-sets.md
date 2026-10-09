# Color Sets

Status: **v1 BUILT 2026-08-23** (engine, graph nodes, Develop panel).
This document is the design record the feature-development plan's M1
called for; the deferred tail is listed at the end. Anchors: the
engineering spec's HSL/color-zones node [P2] (this is that node's
concrete form), and the color-science depth proposal section 3.5, whose
Hue-True curves are the planned expert face over the same parameters.
Pro-gated per the spec's tier table; the flag itself arrives with the
paid-tier milestone (M9), like every other pro surface.

## What it is

User-created, named, collapsible sets in the Develop panel, directly
below Color Bend. Each set selects a range of hue with a falloff and
grades only that range: hue shift, saturation, exposure, uniformity.
The canonical use is a set named "Skin tones."

## The architecture in one sentence

A set is not new state: it is two ordinary graph nodes with a naming
convention (`csetN_mask`, `csetN_grade`), spliced into the chain below
Color Bend, and the Develop section is a lens over those nodes, exactly
the recipe pattern (src/colorsets.ts, ui/colorsets.tsx). Persistence,
undo, copy/paste edits, takes and Graph-mode visibility all come along
for free because nodes and wires already do all of those things.

Chain placement, decided in review: sets are the FINAL say on their
hues, downstream of the global grade tools (Wheels, Split Tone, Bend)
that users will reach for first and then patch. The mask samples the
set's INPUT, never its output, so a set cannot re-select what it just
changed; a second set's mask samples the first set's output, in chain
order.

## The science floor

- **Space**: OkLab/OkLCh (crates/heeler-engine/src/color.rs), published
  Ottosson matrices, round-trip and reference-value tested. OkLab over
  JzAzBz for SDR cost reasons; the space is a seam, and the JzAzBz
  question is filed in the depth proposal's section 8.
- **Selection** (`heeler.hue_range_mask`): hue distance in OkLab hue
  angle with the wraparound handled in one place; quintic smootherstep
  falloff; **chroma-gated**, because hue is undefined at zero chroma
  and an ungated hue mask dapples grays with noise. The gate is fixed,
  not a slider: no hue range can honestly select "gray."
- **Grade** (`heeler.color_grade`): hue rotate, chroma scale and hue
  uniformity (compress toward `band_center`, the skin-evening tool) in
  OkLCh; exposure as a scene-linear 2^EV gain, which preserves
  chromaticity exactly. Zero params short-circuit to a bit-exact
  identity. Output passes through a constant-luminance soft gamut
  floor (color::compress_gamut), written as the shared helper the
  future Gamut Map node reuses.
- **Invariant tests** (ops_grade.rs, ops_masks.rs, color.rs): identity
  at zero, exposure preserves chromaticity, hue rotation preserves L
  and C, full uniformity lands every hue on the center, saturation
  -100 is neutral, extremes never leave a negative channel, the mask
  refuses neutrals and wraps across the red seam.

## Parameters

Mask: `band_center` (0..360 deg), `hue_range` (0..180, full core
width), `hue_falloff` (0..120, each side), `invert`. Grade:
`hue_shift` (-180..180), `saturation` (-100..100), `exposure` (-3..3
EV), `uniformity` (0..100), `band_center` (uniformity's target; the
panel writes it in step with the mask's). Named to dodge the global
PARAM_RANGE table's existing `hue_center` (Color Bend's, a -180..180
wheel) and `range`/`falloff` (color_range_mask's, 0..1).

Forward-compatibility note honored from review: a set's range+falloff
is exactly a control point with falloff on a hue axis, so the proposal
section 3.5 curves face is a re-rendering of these parameters, not a
migration.

## The panel

The block renders below Color Bend whether or not the bend is on. Add
button creates "Set N"; each set has a header (hue swatch, name with
double-click rename onto the grade node's own name, enable toggle,
delete) and a body: the hue strip plus six sliders. The strip's
gradient is painted with CSS `oklch()` at the same angles the engine
measures, so the color under a handle is the color the mask selects;
drag the center to move the band (writes both nodes' `band_center`),
drag either edge to resize, click open strip to re-center. Collapse is
per-set and view-local: which drawer is open is not part of the
photograph. Delete really deletes (sets are user-created; the toggle
is the reversible half) and heals the chain, and add/delete are one
undo step each.

The CSS-filter dev preview approximates the grade globally (bridge.ts
notes the honest ceiling: filters cannot scope to a hue range); the
engine path is the truth.

## Deferred (the plan's later phases)

- Eyedropper: **BUILT 2026-08-23** (same day the spec below was
  settled). The dropper button on each set's header arms it; the
  viewer overlay samples via the existing `sample_image` command with
  the grade node as target, which renders the graph up to whatever
  feeds it server-side: the set's INPUT, exactly as specified, no new
  engine code. Neutral picks (OkLab chroma under the gate) are
  refused with a console note. Later the same day the rest landed
  too: drag-sweep sampling accumulates as one gesture (one undo
  entry), the cursor is a two-tone eyedropper wearing a +/- badge for
  the held modifier, and discrete band moves glide (180ms ease) while
  drags stay glued to the hand. REVISED 2026-08-31: arming the
  dropper no longer forces the mask overlay on ("It should not
  default to mask on, only when the mask button is toggled on while
  using the picker"), Escape disarms it and the status bar carries
  its seat while armed. A hover-tracking candidate band (strip
  follows the cursor, mask eye previews the would-be pick) was built
  the same day and pulled the same day; the owner's final ruling is that the
  selection updates ONLY while the left button is held (the sweep),
  and a bare hover changes nothing. ADDED 2026-10-06 ("a ghosted
  preview on the color bar of the hue the eyedropper is hovering"): a
  bare hover now draws a see-through ghost on the set's hue strip at
  the hue under the cursor. The ghost is all it moves: the band, its
  width and the mask stay put until the button is pressed, so the
  ruling above stands. A neutral keeps the ghost at its last hue, and
  leaving the photograph or putting the picker away removes it.
  Original interaction spec:
  - click picks a color and the range CENTERS on its hue;
  - SHIFT-click ADDS: the band grows just enough to include the picked
    hue (both center and width move so existing coverage is kept);
  - ALT/CMD-click REMOVES: the band shrinks so the picked hue falls
    outside the core (into or past the falloff);
  - sampling averages a small neighborhood (single pixels are noise),
    and drag-sampling updates live with the mask overlay showing while
    the dropper is armed, so you watch the selection grow as you sweep;
  - the sample must be the color AS SEEN AT THE SET'S INPUT (after the
    global grade, before this set), which is what makes this wait on
    the stage-probe seam: sampling the final output would pick a hue
    later sets or the set itself already moved.
- Mask overlay preview toggle: **DONE 2026-08-23**, the per-set eye
  button; maskPreviewNode in state.ts is the one derivation the
  preview render, ROI patch and viewer all share.
- WGSL kernels + parity tests: **DONE 2026-08-23** for the grade
  (color_grade kernel, OkLab in WGSL, parity 5e-4 across every control
  including gamut-floor combinations; the identity case is refused so
  the CPU's bit-exact short-circuit stays the identity). The mask node
  stays CPU by the gpu crate's image-in/image-out contract and falls
  back cleanly. Per-set mask caching turned out to be free: the
  executor's keyed cache holds mask outputs like any node. The perf
  tripwire (three sets on a preview frame) is in ops_grade tests,
  measured ~30ms debug against an 8s budget.
- The expert curves face (hue-vs-hue / sat / lum) over these params.
- Guide-blurred mask sampling if real photos show chroma-noise dapple
  the chroma gate does not already damp.
