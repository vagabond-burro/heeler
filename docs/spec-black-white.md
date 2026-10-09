# Black and White

Status: **phases 1 to 7, including 4b, BUILT 2026-09-15** (branch
`ansel`). Read the as-built sections below for decisions that supersede
parts of the initial plan. Film curves, filter transmissions, film
sensitivities, paper parameters and grain presets are models from general
knowledge of the families, not fits to digitized datasheets.
the owner's brief: "The black and white treatment is pretty average. Where could
Heeler go that no other app has gone in black and white controls?"
This document is the design record and the phased plan.

What exists today: Color's Treatment switch builds `heeler.black_white`
(crates/heeler-engine/src/ops.rs, `black_white`), a three-weight
channel mixer (red 30, green 59, blue 11, applied directly, negative
weights allowed) with an Amount that fades color to mono. It sits in
the scene-linear stretch right after Relight (apps/heeler-app/src/recipes.ts,
the `bw` slot). That is the channel mixer a layer editor shipped in 1998 and
every editor since has copied; the monochrome plugins and RAW editors
dress the same weights up as eight hue sliders and call it a day.

## The thesis

Every app treats black and white as color with the color removed:
the tools are color tools, minus a channel. The ground nobody has
taken is the process itself. A monochrome photograph was made by a
filter in front of a film, a development that set the negative's
contrast, and a paper that rendered the negative's densities, with a
hand dodging and burning between them. Ansel Adams wrote the method
down as the Zone System. Digital editors threw all of it away and kept
a slider called Contrast.

Heeler has four things in the develop stage that let it model the
process rather than imitate its results: scene-linear light all the
way to the Tone Profile, a depth map for every photograph, Recolor's
curves and surfaces as a ready-made selection face, and Relight's
stop-spaced zones. This spec spends those four on eight ideas, ordered
so the cheapest and most felt ships first.

## The architecture in one sentence

A mono edit is the darkroom's own chain, in its order: **filter and
film** (the conversion, scene-linear, the slot `black_white` already
holds), **development** (the negative's characteristic curve, a mono
mode of the Tone Profile), **the print** (paper grade, base and toning,
in the display domain after Curves), and the **darkroom hand** (zone
placement driving Exposure and Development, grain by density). Each
stage is an ordinary node or a mode of one; the Treatment switch
stays the single seat that builds the chain; and the Adjustments
section "Black & White" is a lens over those nodes, the Color Sets
pattern (docs/spec-color-sets.md), so persistence, undo, takes, links
and Graph-mode visibility come for free.

## The eight ideas

### 1. Separation: the collision overlay and the two-point solver

The failure of every conversion is two colors landing on one gray:
the red flower and its green leaves both at Zone V. No app shows you
this is happening; you find out on the print.

- **Collision overlay**: a viewport overlay that paints every pixel
  whose gray has a twin at a different hue. Built from a 2D histogram
  of (gray bin, OkLCh hue bin) over the conversion's output; a gray
  bin with mass in two hue bins more than 40 degrees apart is a
  collision, and the pixels in those bins are painted, one tint per
  colliding pair. Chroma-gated like the hue mask, so grays never
  collide with themselves.
- **Two-point solver**: click a region A, click a region B, and the app
  finds the conversion that separates them most. With the mixer, the
  answer is closed-form: move the weights along the direction of the
  mean-color difference (c_A minus c_B), bounded so the running total
  stays inside the range the panel already shows. With the hue curve
  (below), the answer is two bumps of opposite sign at the two hues,
  smoothed. Either way the gesture is "make these two different",
  which is what the photographer was reaching for with the weights.
- **Hue-to-luminance curve as the conversion's face**: the mixer is
  kept as the simple face; the expert face is a periodic hue curve,
  evaluated exactly as Recolor's hue axis is (ops_recolor.rs,
  `eval_eq_periodic`, chroma-gated), scaling the gray per hue. Recolor's
  own hue-to-luminance cell does this today on a color picture; here
  it is the conversion, not an adjustment after it.

### 2. Keep the color alive

The node discards hue, so every hue mask below it loses its best axis:
on a mono picture, "select the sky by its blue" cannot work today.

The fix is a splice rule, not an engine change. When Treatment is on,
every hue-indexed mask downstream of the conversion (the Develop
tools' Hue Range masks and the Finish stack's) takes its image input
from the conversion's **input**, by fan-out, while the mask is still
applied at its own position in the chain. The color stays in the
graph as the wire it always was. Color Sets already sample their
input rather than their output for the same reason; this extends the
rule across the conversion.

### 3. The Zone System: placement, not sliders

Adams' method: place one tone, let the rest fall, then develop so the
highlights land. The digital equivalent is two clicks.

- **Zone ruler**: eleven zones, 0 to X, one stop apart, under the
  viewport, Zone V at the display middle gray. Zones are print values,
  so the ruler reads the display domain the way Levels does
  (docs/user-guide/adjustments/levels.md), after the profile.
  Hovering a zone paints the pixels in it; a Zones overlay paints all
  eleven as a false-color map, a spot meter reading the whole scene.
- **Placement picker**: click a shadow, name it Zone III, and
  Exposure's exposure moves so that spot lands there (one log2 and a
  write to the node). Click a highlight, name it Zone VII, and
  **Development** (idea 4's contrast parameter) is solved so the
  second spot lands while the first holds. The profile is monotone, so
  a bisection over the development parameter finds it. This is
  "expose for the shadows, develop for the highlights" made literal,
  and it is two-point Levels wearing the vocabulary printers already
  think in.
- Both placements are ordinary parameter writes to nodes that exist,
  so they are undoable, take-able and mirrored across links with
  nothing new.

### 4. Development: characteristic curves from the datasheets

Ilford and Kodak publish density-against-log-exposure curves for
their stocks at several development times each; the first cut is the
five films of idea 5 (HP5 Plus, FP4 Plus, Tri-X, T-Max 400, Ortho
Plus), the same list in both places so a film is one choice. A **mono mode of the
Tone Profile** carries a curve family per film, with **Development**
in N steps (N-2 to N+2) as the family parameter, so contrast walks a
real negative's curve rather than a generic slope.

Each film is fitted, not tabulated: a toe, a straight-line gamma and a
shoulder, with the fit checked against the published points at every
development the sheet shows. The fits are Heeler's own parameters
"modeled on" the sheets, which is both the honest label and the one
that keeps the code free of anyone's tables. Together with the paper
(idea 7) this is a two-stage negative-and-print process built from
published sensitometry, which no editor has done.

### 5. Filter and film: spectral conversion

A red filter is not "red 150, green 0, blue 0". It is a transmission
curve, and the film behind it has a sensitivity curve, and the gray is
the integral of the pixel's spectrum through both.

- **Spectral reconstruction**: a plausible reflectance spectrum per
  pixel from linear RGB, by the sigmoid-polynomial upsampling
  renderers use (Jakob and Hanika 2019), or the Smits basis if the
  fit proves fussy; either is a smooth function of RGB.
- **Filters**: Wratten 8, 11, 15, 21, 25, 29, 47, 58 and none, as
  published transmission curves.
- **Films**: the first cut is HP5 Plus, FP4 Plus, Tri-X, T-Max 400
  and Ilford Ortho Plus, which cover the four looks (cubic-grain
  panchromatic, fine-grain panchromatic, T-grain, orthochromatic), as
  published sensitivity curves; extended-red stocks (Rollei Retro
  80S, Tech Pan) follow if asked for. Orthochromatic becomes a true difference: lips
  and freckles go dark, skies go white, and no weight triplet
  reproduces it.
- **Cost**: for a given (filter, film) pair the mapping is RGB to
  gray, so it is baked to a 3D LUT at parameter change (33 cubed, a
  millisecond) and the per-pixel cost is one lookup; the mixer path
  stays as fast as today.
- **The honest limit**: the spectrum is a metameric guess, good for
  the visible band. Past 700 nm the sensor's cut filter recorded
  nothing, so infrared is a material prior standing in for a band
  that is not in the RAW. the product decision (2026-09-14, second thought): try
  it anyway, since it is "an extension of faking black and white
  photography that we are already doing". The design is below.

#### Infrared: the Wood effect as a material prior

What makes an infrared photograph recognizable is a short list of
materials, each with a predictable near-infrared behavior. The
spectral stage extends the reconstructed spectrum past 700 nm by a
prior chosen from what the pixel and its masks say the material is:

- **Foliage** goes white: chlorophyll's red edge lifts reflectance
  from about 0.1 in the red to about 0.5 past 720 nm. Green chroma
  extends high.
- **Blue sky** goes black: Rayleigh scattering falls as the fourth
  power of wavelength, the one material whose infrared is physics
  rather than a guess. Sky hue at low chroma gradient extends to near
  zero; the Smart Mask's sky class makes it exact where present.
- **Water** goes black: near-infrared absorption.
- **Skin** goes pale and waxy, veins and blemishes gone: reflectance
  climbs from about 0.4 to about 0.6 and light scatters deeper. The
  Smart Mask's subject class plus skin hue.
- **Neutrals** (cloud, concrete, stone) stay flat, which is why the
  clouds stay white against the black sky.
- **Haze** vanishes: infrared passes through it, so far tones regain
  contrast, lifted along the depth map. Only Heeler has this handle.

The look on top of the conversion is not new code: HIE's glow (no
anti-halation layer) is the Halation node, its coarse grain is the
Grain film row. Filters 720 nm and 850 nm and films Rollei IR 400 and
Kodak HIE join the same rows the visible stocks use, labeled
"simulated" in their tips.

**Tunable, not constant.** the owner's condition for trying it at all: the
guessed spectrum must be something a user can dial in. The material
priors are exposed as five controls (Foliage, Sky, Water, Skin, Haze
lift), and behind a fold the extension curve itself: near-infrared
reflectance against visible hue, the conversion's own periodic hue
curve (idea 1) reused, so disagreeing with the guess for one
material is moving one point. The Smart Mask's classes sharpen where
each control lands; the curve says how far.

**Bench first.** A Rust example beside the depth lab
(apps/heeler-app/src-tauri/examples/depth_lab.rs; this one
ir_lab.rs) renders a folder of frames through the prior with the
Smart Mask's sky and subject, so the owner can judge a dozen results before
the feature costs a panel. A day for the bench; two for the feature
if the bench earns them. Phase 4b in the table.

### 6. Depth-graded conversion

Atmospheric perspective is the oldest mono depth cue, and every other
editor is stuck with one conversion for the whole frame because it has
no depth at develop time. The conversion gains a depth input (the same
port Recolor's depth axis reads, `recolor_wants_depth`) and a **Near**
and a **Far** filter with a curve along depth between them: a red
filter on the subject, a yellow one on the distant sky, lifted soft
tones at the horizon. Contrast may ride the same curve. Two LUT
lookups and a lerp per pixel. This is also the natural home of the
"darken the sky, hold the foreground" gesture that used to be a
graduated filter and a burn.

The View depth eye: the owner's rule of 2026-09-05 is that every Adjustments
section that reads the depth map carries the eye on its header,
effect on or off (Fog, Depth Lighting, DoF, Flare, Depth Map), so a
user mid-edit never scrolls to Depth Map to see the map and the eye
itself marks the section as a depth consumer. The one section with an
optional depth row, Halation's By depth, is excluded from the eye.
Black & White's Near / Far row is the second optional case, and the
recommendation is Fog's side, not Halation's: By depth is a single
weight judged from the bloom, while Near / Far is a curve along depth
choosing which filter lands where, which cannot be judged without the
map. So the eye is always on the section, by setting its `depthTools`
in simple.tsx, with no new gating.

### 7. The print: split-grade paper, base and toning

A **Paper** node, display domain, last before Output (Levels and
Curves shape the negative-to-print; the paper is the paper).

- **Grade**: 0 to 5, a contrast family with a real Dmax, about 2.1 for
  glossy fiber and 1.7 for matte, so the deepest black is the paper's
  and not the screen's.
- **Split grade**: two exposures, a soft one (grade 0, controls the
  highlights) and a hard one (grade 5, controls the shadows), each
  with its own time in log exposure. Printers know this pair
  intimately and no editor models it; it is also a better contrast
  model than one slider because the two ends move independently.
- **Base**: warm tone, neutral, cold tone, as a paper white.
- **Toning by density**: selenium (cools and deepens the shadows
  first), sepia (warms the highlights first), gold (blue-black), and
  a split by density crossover. Toning is a function of density, not
  of hue band, which is what separates it from Split Tone.

### 8. Grain by density and enlargement

Grain is strongest in the midtones, scales with film speed, and its
size on the print depends on the enlargement. The Grain node already
has band gains and a size (ops_stylize.rs, `grain`); this adds a
**Film** preset row that sets the bands and size from the film chosen
in idea 4, and an **Enlargement** that fixes grain size in negative
pixels so an 8x10 and a 16x20 from the same negative differ the way
real prints do. Enlargement ties preview grain to export size, which
touches the preview scale path and is the one invasive piece here; it
gets a test plan before it gets code.

## The section

One Adjustments section, "Black & White", born when Treatment is
switched, rows in process order per the UI language rules (one seat
per control, workflow order, outcome-first hints):

1. **Filter** and **Film** (idea 5), the mixer as the simple face
   behind a fold, the hue curve as the expert face (idea 1).
2. **Separation**: the collision overlay toggle and the two-point
   solver button (idea 1).
3. **Near / Far** depth row (idea 6), folded until the map is present.
4. **Zones**: the ruler toggle, Zones overlay, and the placement
   picker (idea 3); **Development** (idea 4) sits here because the
   picker writes it.
5. **Print** (idea 7): Grade or Split grade, Base, Toning.
6. **Grain** stays in its own section; the Film row there reads the
   film chosen here (idea 8).

The Treatment switch remains the one seat that says "this is a mono
photograph"; Amount stays as the fade. Nothing in Color changes.

## Phase 1 as built (2026-09-14)

- `heeler.black_white` gains `hue_curve` (ops.rs `black_white`,
  `black_white_hue_ev`, `black_white_hue_gate`): Recolor's periodic
  point list on a 0..360 OkLCh axis, EV clamped to ±2, hue read from
  a,b box-smoothed over one percent of the short side, gated by the
  Color Sets chroma window. Empty or all-zero is the mixer bit for bit.
  A conversion with any point list is kept off the GPU tail
  (`gpu_tail_of`), because heeler-gpu's mixer kernel has no curve.
- The separation view: `heeler_engine::collision_overlay`
  (separation.rs), rendered as the `__collision__` pseudo target with
  a second render at the conversion's input. Thirty-two gray bins in
  display encoding, twenty-four hue bins, a collision at three bins
  apart; colliding pixels painted in their own hue at their own gray,
  the rest dimmed the gamut view's way. Frontend `collisionView`,
  named by `previewTarget` only while `treatmentOn`.
- The panel (simple.tsx, the mixer block): a Hue kicker with the
  Collisions eye, and the EqEditor with Separate as its two-click
  chip. `blackwhite.ts` carries `separatePoints` (half a stop each
  way, brighter up, replace within ten degrees, anchors at forty) and
  `convertedGray`, the engine's formula for the direction call.
  Viewer overlay `bw-separate-overlay`, picker arm `bwSeparate`.
- Keep the color alive: `hueMaskFeedBelowConversion` in bridge.ts
  rewires the `in` of every `heeler.hue_range_mask` and
  `heeler.color_range_mask` downstream of an active conversion to the
  conversion's feed, in the serialized graph only. Range masks stay
  (they key on luma too, and read the mono picture for it); Recolor's
  hue axis below the conversion is not rewired (it is a full node,
  not a mask) and is noted under Deferred.
- From the owner's first day with it (2026-09-14), the same day: the section
  reset clears the curve and the curve has its own reset; the bars
  under the curve are the input's hue histogram in their own hues
  (bwcurve.tsx asks node_thumbs for the conversion's feed); the
  eyedropper with a hover ghost and press-and-drag (bwPick,
  bwHoverHue, PickSessions.reuse so the sample in flight is not
  canceled per move); the curve's own switch (hue_curve_on); the
  Layout menu and the interpolation faces (eq_interp, expand then
  interpolate, Recolor's order); and Separate shows the collision
  view while armed and narrows it after the first click to the
  picked color and its partners (the target carries the click as
  __collision__@x,y, collision_overlay takes a focus). Recolor below the conversion
  indexes hue by the conversion's input through a new optional "ref"
  image port the serializer wires (the owner compared the two histograms and
  found them different; now both, and Recolor's lookup, read the same
  picture through useHueSourceThumb).
- Not done in phase 1: a smoothing dial for the hue index (fixed at
  Recolor's default).

## Phase 2 as built (2026-09-14)

- Zones are print values (zones.rs): eleven zones with Zone V at the
  encoded gray of 18% reflectance, five equal steps of print value to
  black and five to white, a band reaching halfway to its neighbors.
  Adams' zones are a stop apart on the negative; on the print they are
  steps of tone, which is what the ruler shows and a placement lands
  on. The frontend twin is in blackwhite.ts, held to the same numbers.
- Views: `__zones__` posterizes the rendered frame to its zone centers
  (the spot meter reading the whole scene); `__zones__@k` lights zone k
  in gold over the picture dimmed. Session state zonesView (the eye)
  and zoneHover (the ruler's hover), the hover ahead of every other
  view while the cursor is on the ruler.
- Placement: `place_zone` renders trial graphs through the session
  executor at the gesture tier's edge and solves with zones.rs
  `solve_placement`: one spot by regula falsi on Exposure's exposure;
  two spots by damped Newton on a numerical Jacobian over exposure and
  the Tone Profile's contrast together, since solving them in turn
  oscillates (the contrast pivots on middle gray and moves the shadow
  the exposure just placed). The frontend writes the answers as
  ordinary set_param edits in one gesture. Picker arm zonePlace, the
  gold pin on the first spot, Escape drops it.
- The ruler (ui/zones.tsx) lives in the Exposure section, under the
  two dials a placement sets, on any photograph (2026-09-14:
  "Move Zones into the Exposure section"; the Zone System is about
  tone, and a placement replaces a dial's setting rather than adding
  to it, which is plainest beside the dial), as a fold closed by
  default with no reset of its own (the Exposure reset and Undo
  cover it). The development is Exposure's Luminance contrast, named
  so in every hint.

## Phase 3 as built (2026-09-14)

- film.rs: a parametric characteristic curve per stock (a softplus
  toe into a straight line of the stock's gamma, a soft-minimum
  shoulder toward its density range), Development in N steps scaling
  the gamma and nudging the speed; the display value is the negative
  on a grade 2 paper, 10^(1.65 (D(x) - D(x_white))), scene white on
  paper white, until the Print section makes the paper a dial. (The
  first cut printed the negative straight, with no paper contrast,
  and every stock came out flat and bright: the owner, "all it did was get
  bright".) Wired as the Tone
  Profile's `film` and `development` params: a stock renders through
  its curve in place of the modes, Baseline before, Profile amt
  scaling the gamma, colorfulness after; a profile developing a stock
  stays off the GPU tail. Film is black and white only: the serializer
  sends the profile without its stock and development while the
  treatment is off (2026-09-14: "aren't all these film stocks
  black and white only?"; a B&W film's curve on a color photograph
  was a tone curve wearing a film's name, and nearly invisible).
- Film lives inside the black and white treatment block in Color
  (2026-09-14: "It should be under B&W treatment then"; these are
  black and white films): the Film menu with the "modeled on" line
  and the Development row beside the Filter, the Color reset clearing
  them with the rest of the treatment, pro through the gate on the
  two params. The Zone System's second placement moves Film >
  Development when a stock is on under the treatment (place_zone
  answers `development`), Exposure's Luminance otherwise, and every
  hint names whichever it is. So of the two section names the owner chose,
  Film is a block and Print will be the section.
- HONESTY: the five stocks' parameters describe the published
  families' shapes from general knowledge of them (speed, normal
  gamma, toe length, how straight the line runs, how the family fans
  with time). They are not fitted to the sheets' points, and the
  invariant test "each film fit hits its datasheet points within
  0.05 density" is not written, because the points are not in hand.
  That fit is the first follow-up: the owner supplies the sheets (Ilford and
  Kodak publish them), the points are digitized, the parameters
  refitted, the test added. Until then every stock says "modeled
  on" in the panel and the guide, and the tests hold only the shape:
  monotone, white to white, a push steeper, a toe that compresses,
  cubic grain's toe longer than T-grain's.

## Phase 4 as built (2026-09-14)

- spectral.rs: Smits' reconstruction (seven smooth basis spectra by
  channel order, linear and homogeneous in the pixel), a Wratten
  table (8, 11, 15, 21, 25, 29, 47, 58; sharp cuts as logistic edges,
  the blue and green as bands, the 11 a band with a red shoulder), a
  sensitivity per stock (panchromatic with a green dip and a red
  roll-off at the stock's reach; Ortho Plus blind past 590 nm). A
  filter-and-film pair is seven integrals, normalized so a neutral
  keeps its value; the gray is one dot product per pixel, so no LUT
  after all. The conversion's `filter` and `film` params switch the
  mixer out; the hue curve and Amount ride on top; such a node stays
  off the GPU tail.
- One film, one choice: the serializer copies the Film section's
  stock onto the conversion; the panel's Filter menu sits above the
  Hue curve in the treatment block with a note saying what the gray
  is going through, and the mixer's weights dim while it stands down.
  Filters are pro with the films (decision 1).
- Tests: a neutral holds under every pair; 25 lightens red and
  darkens blue, 47 the reverse; the spec's invariant, orthochromatic
  renders a red darker than a cyan of equal luminance and
  panchromatic within a stop; the yellow-to-red filters order the sky
  from light to dark; linearity.
- HONESTY: as with the stocks, the basis spectra, the transmissions
  and the sensitivities are smooth models of the published shapes,
  labeled "modeled on"; digitizing them is the same follow-up.

## One component, two hosts (2026-09-14)

"all Adjustments does is take the controls for each node and wrap
them in collapsible sections... I fear you've been doing this in the
least effective way by making duplicates." The treatment's controls are
one component, `BwControls` (ui/bwcontrols.tsx): the mixer, the Hue
curve with its switch, eye, reset and chips, Film with Development, the
Filter. Color's treatment block mounts it in Develop; the graph
inspector mounts it on the Black & White node; the Tone Profile's node
shows Film and Development through the same FilmBlock. Nothing about
the treatment is written twice. The rule for every phase from here.

## Phase 4b, the bench (2026-09-14)

- spectral.rs reaches to 900 nm: the visible integrals stop at 700,
  and past it a pixel's reflectance is its visible gray lifted by the
  prior at its hue through the chroma gate, so a neutral stays exactly
  itself and a panchromatic pair is unchanged (its infrared share is
  nil). `IrPrior` is a periodic hue-to-stops curve, `IrPrior::DEFAULT`
  the Wood effect (foliage +2.4, sky -2.5, water -0.8, skin +0.6,
  magenta flat), `Conversion::with_prior` takes a user's. Filters 720
  (R72) and 850; films Rollei Infrared 400 (to 820 nm) and HIE (to
  900). A pair that passes nothing (an 850 on HP5) is a black frame,
  not the mixer.
- The bench: `cargo run -p heeler-desktop --example ir_lab -- OUT
  FILE...` writes each frame as four panels (color, HP5 plain,
  720 on Rollei IR, 850 on HIE). Run on five of the owner's frames the same
  day: trees and grass glow, sky and water go dark, clouds stand,
  the red rock sits mid-gray under foliage brighter than it.
- the owner judged the sheets the same day: "I like the samples, I think
  we just document this isn't meant to be an exact simulation and
  just an artistic tool"; and: "The user can't rely on this feature
  for accurate simulation, Heeler tries to give them the tools to
  dial it in but if they don't know what they working towards (not
  familiar with infrared) Heeler isn't going to course correct
  them."
- The feature, as built: the 720 and 850 filters and Rollei
  Infrared 400 and HIE in the menus (the two films also carry
  characteristic curves in film.rs, so they develop like the rest);
  the conversion node's ir_foliage, ir_sky, ir_water, ir_skin in
  stops and ir_curve, the curve outranking the four when drawn; an
  Infrared fold in BwControls (so on the node too) with the four
  sliders, a Curve chip opening the guess as an editor seeded from
  the sliders, and its own reset; the Color reset covers them; pro
  with the filters. Haze waits on the depth plane (phase 5). Every
  hint and the guide say artistic tool, guess, not a simulation.
  Sets (masks that point a filter or the guess at a region, the
  Color Sets pattern) are the follow-up the owner raised, to build after
  this is in use, not before.
- Neutral (2026-09-15). the owner's ridge pines took none of the foliage
  lift: in the JPEG they are a gray with a whisper of green (OkLab
  chroma 0.0135, a third of the old window's top at 0.05), so the
  chroma gate held them as neutrals while the lit cottonwoods at
  0.049 passed. Chroma scales with lightness, so a fixed chroma
  window read every dark green as a gray. The gate now reads
  saturation (chroma over lightness, the lightness floored at 0.15
  so a near-black's noise is not color; `black_white_saturation`),
  which is one number for a color and that color in shade, above a
  floor the conversion's `neutral` dial sets (0..100 over saturation
  0..0.06, default 10, `black_white_neutral_floor`; the fade 0.04
  wide). One dial for every hue, since the gate is asked before any
  hue is looked up; "sliders instead of relying on one fixed
  float value to try and solve for every photo". The row sits under
  the Hue curve in BwControls (so on the node), free with the curve,
  because the same field feeds the curve, the infrared guess, the
  pickers' neutral checks and the collision overlay (which takes the
  dial as an argument). Tests: the pine passes at the default and the
  gray of its lightness does not, the same green lit gates the same,
  the dial at 0 and 100 on the node, the frontend mirror, the row and
  the Color reset.
- The halo, third time (2026-09-15, "The halo is bad again"). The
  first cut of the gate faded over 0.02 of saturation from a floor of
  0.012, and a hazy sky measures 0.013 at the horizon and 0.025 higher
  up: the sky's own haze gradient became a tone knee along every
  skyline, and any smear of tree or rock hue into the sky pushed it
  under the floor as a bright rim. The old chroma window had been
  twice as gentle at a sky's lightness. Two changes: the fade is 0.04
  wide and the default floor 0.006 (dial at 10), so the haze reads as
  the gradient it is; and the field is smoothed by the guided filter's
  color form (`guided_blur_lab`, the guide L, 2a, 2b, eps 0.02
  squared), so a hue edge with no lightness step (sky against a sunlit
  rock rim or twigs) is an edge too. A JPEG's chroma blocks measure a
  thousandth or two in a and b and still flatten; a lone strong color
  is now an edge the guide keeps, which is right (a berry in gravel).
  Tests: a hazy sky over rock of the same lightness keeps its gate to
  the ridge and the rock its hue; the faint tint smooths and the
  strong speck holds.
- Film on a rendered source (2026-09-15, "no change when I switch
  Film between None and Rollei"): a JPEG's profile is bypassed and the
  characteristic curve lives on it, so no stock developed a JPEG. The
  serializer now sends the profile enabled when a stock is on under
  the treatment, with baseline_ev and colorfulness at zero (the RAW
  rendering's, not the film's); the photograph's own node stays
  bypassed.
- The mixer's weights, dimmed under a filter or a stock, now say why
  in the status line ("why are the Red Green and Blue sliders
  grayed out?").
- Neutral moved into the Infrared fold (2026-09-15: "Move Neutral
  into the Infrared fold"), and with it became the infrared guess's
  dial alone: the field now carries saturation and each reader gates
  it at its own floor, the curve, the pickers and the Collisions view
  at the default, the guess at the dial. So nothing outside the fold
  moves when the fold is hidden; pro with the guess; the fold's reset
  returns it.

## Phase 5 as built (2026-09-15)

- The conversion node gains `far_filter` (a Wratten key, empty is one
  conversion, so is the near key repeated) and `depth_curve` (x depth
  0..100 near to far, y the far share 0..100, empty is linear, the
  node's `eq_interp` face applies). With a Far named and a plane
  planted, ops.rs builds a second `Conversion` on the same film and
  prior and lerps the two grays per pixel by the curve at the plane's
  value; the hue curve rides on top of the graded gray as it does on
  the mixer, and an infrared Far reads the guess through the same
  gate. No plane, no Far, or Far the same as Near: the near
  conversion alone, bit for bit what phase 4 rendered.
- Planting: `black_white_wants_depth` (a Far that differs from Near on
  a conversion with amount above zero) joins the desktop's planting
  rule, its raster version rule (`smart_want`) and the depth consumers
  at the cache key; the executor feeds the node its `raster`; the GPU
  tail is refused with a Far named, as with a filter. And the
  frontend's `depthWanted` asks for the map on the same condition:
  the owner's first try (2026-09-15) changed nothing because the desktop
  knew to plant a plane nobody had computed. Lesson, the fourth list:
  a new depth reader is entered in FOUR places, wants_planted_raster,
  smart_want, the cache-key consumers, and depthWanted.
- The row: FilterMenu grew a `param`, a label, a none label and a
  trailing chip, so the Far menu is the same component as Filter with
  "Same as Filter" for empty; under it the depth curve as an EqEditor
  on the depth axis (the Recolor depth row's dress, NEAR to FAR),
  shown only with a Far that differs from Near. The View depth eye
  rides the Far row rather than the Color section's header: the row
  is the depth reader, the section that hosts the treatment is not,
  and an eye on Color for every color photograph would say the
  wrong thing. This is the one departure from the depth-eye rule's
  letter, kept to its meaning.
- Pro with the filters; the Color reset drops both; on the node too.
  Tests: the engine grades near to far with the mean half way and the
  curve moving the crossing, stands alone without a plane, and the
  planting rule; the row, the curve's showing, the node, the tier.
- Deferred from the idea: contrast riding the depth curve, and the
  infrared haze cut (a lift of far tones under an infrared pair, the
  scene clearing with distance). Both wait on the owner's use of Far.

## Phase 6 as built (2026-09-15)

- `heeler.paper` (crates/heeler-engine/src/paper.rs), display domain,
  on the main chain between Curves and the art layers, last before
  Output; the template carries it off, like Halation, so the Print
  section's switch turns it on and the tier guards find its node.
  The picture arriving is read as the ideal print's density
  D = -log10(v); a grade is a contrast about middle gray's density
  (a sixth per grade, grade 2 the ideal print), a time is a paper
  gamma of a stop per stop, no density below the paper's white, and
  a soft shoulder into Dmax; split grade is the grade 0 curve at the
  Soft time and the grade 5 curve at the Hard time, met by density
  through the midtones, so Soft owns the highlights and Hard the
  shadows. Base is a unit-luminance tint on every value; toning is a
  unit-luminance tint weighted by density about the crossover,
  selenium and gold in the shadows, sepia in the highlights, split
  both, selenium also deepening what it tones. A color photograph
  is printed by its luminance and keeps its color ratios.
- The section: Print, pro, after Curves, `printWidget` mounting
  PrintControls (src/ui/print.tsx), the same component the graph
  inspector mounts on the node: Paper with the Split chip, Grade and
  Time or Soft and Hard, Dmax, Base, the Toner menu, Toning and
  Crossover once a toner is chosen. Every hint says what the dial
  makes. Params: grade, time, split (a flag), soft, hard, dmax, base,
  toner (text), toning, crossover.
- Tests: grade 2 is the ideal print through the mids and black is the
  paper's; grade is contrast about middle gray and time is exposure;
  the split times own their ends; toning is by density and keeps
  luminance, base tints the white; the node prints by luminance and
  keeps color. The section switches on and swaps the pair in, the
  sent graph carries the paper last before Output, the node carries
  the controls, a free copy is refused.
- HONESTY, as with the films: the grades' contrast ladder, the Dmax
  defaults and the toners' colors are from general knowledge of the
  papers and the baths, not fitted to a measured sheet.
- Deferred: the paper's reflectance tint on a matte surface, and any
  coupling of Print to Export's size; grain by enlargement (phase 7)
  is next.

## Phase 7 as built, second half: Enlargement (2026-09-15)

- Built to the plan below, in order. `grain_sigma` (ops_stylize.rs)
  reads `size` against `GRAIN_REFERENCE_SHORT` (4000 px) when the
  node's `by_frame` flag is on, times the format's scale
  (`grain_format_scale`: 35mm 1, 645 0.62, 6x6 0.55, 6x7 0.5, 4x5
  0.28), with the full frame's short side from `roi_w` and `roi_h`
  as Halation reads it (the desktop plants them on the grain and the
  Grain Field nodes now). Without the flag the count of pixels is
  the old one, whatever the render. The Grain Field node takes the
  same flag and format, so a grain rebuilt from fields is the grain.
- The open decision (plan item 6) taken: under one pixel the blur
  holds at half a pixel and the amplitude fades with the sigma, so a
  small preview shows a faint, fine trace rather than full-strength
  per-pixel noise; the true grain shows at 1:1 or on the export. the owner
  sees it on his frames; the fade is one line to change.
- Fresh graphs carry the flag (NEUTRAL_PARAMS, LAYER_TOOLS, the
  template); a saved graph without it renders as before and the
  Grain section shows one chip, "Size by the frame", that sets it
  (undoable). Format is a segmented control on the Grain section and
  the node (GrainFrameRow, src/ui/grainfilm.tsx), with aria-pressed
  as the accessibility matrix wants.
- Tests: the sigma rule at the reference, at twice it, at 4x5, under
  a pixel, and without the flag; the parity the plan asked for, one
  graph rendered as a patch of a 4000 px frame and of an 8000 px
  frame holding the same share of the short side within fifteen
  percent (the blur read off the output's lag-one autocorrelation,
  which reads a two-pixel blur a tenth short), and an older graph
  holding its count of pixels; the cache telling the two fields
  apart under its cap of four; the flag on a fresh graph's sent
  node, the Format row, the migration chip on an older node.
- Measured while writing the parity test: the finite patch's mean
  removal leaves a negative tail in the autocorrelation past four
  lags, so an integral estimate of the blur reads short and drifts
  with the patch size; the lag-one estimate is the stable one.
  Performance (plan item 8) unchanged in kind: one field build per
  (size, frame) pair, cached.

## Phase 7 as built, first half (2026-09-15)

- The Film row on Grain: `GRAIN_BY_STOCK` and `grainFromFilm(stock,
  n)` in film.ts hold each stock's Grain dials at normal development
  (intensity, size, pattern, the three tonal bands; channels neutral,
  color grain off), a push scaling size by 12% and intensity by 18%
  per N step, a pull the reverse. `GrainFilmRow` (src/ui/grainfilm.tsx)
  shows above the Grain dials only with a stock on under the
  treatment, names the stock and its N, and one click writes the
  dials through set_params (undoable, every value visible, the Zones
  lesson); the graph mounts the same row on the Grain node. The
  numbers are from general knowledge of the families, not RMS
  granularity from a sheet, and the row says so. The first cut put
  HP5 at Grain amount 35 and the owner found it "way too strong": the
  amounts are now on Heeler's scale, where his own sample sits at
  14 (HP5 18, Tri-X 24, HIE 32, the fine stocks 8 to 12).
- Deferred to the second half, with its test plan below:
  Enlargement.

### Enlargement: the test plan (invasive, not yet code)

The problem, measured in the code: `grain_field` in ops_stylize.rs
builds its blur from `size` as a fixed count of pixels (sigma = 0.35 +
size / 45), and the field is built at the render's own width and
height. A preview at a 1024 px edge and an export at 6000 px carry
the same grain in pixels, which is six times coarser in picture terms
on the preview than on the print. Halation already sizes as a fraction
of the full frame's short side through the `roi_w` and `roi_h` params
the desktop plants (ops_halation.rs, `short = (w / roi_w).min(h /
roi_h)`), and carries a `format` scale; Enlargement is Grain adopting
the same two ideas. Grain has no GPU kernel (`GpuEngine::supports` is
false for it), so there is no parity kernel to keep in step.

1. Engine: `size` becomes a fraction of the full frame's short side.
   Sigma in render pixels = size_fraction × short × enlargement,
   with `short` from `roi_w`/`roi_h` as Halation reads it. The
   calibration constant is chosen so a saved graph renders its
   full-resolution export the same as before at a 4000 px short side:
   test, an export render at that size before and after the change is
   bit-close (the field is stochastic per size key, so compare the
   field's autocorrelation width and RMS, not bytes).
2. A flag, `by_frame`, false on graphs saved before the change and
   true on fresh ones (NEUTRAL_PARAMS, the template, PARAM_RANGE), so
   an old graph's pixel semantics never move under its owner; the
   Grain section's rows write the new units only when the flag is on,
   and a one-click migration ("size in the frame's terms") converts
   the old value with the constant of step 1. Test: an old graph loads
   with the flag off and renders as before; a fresh one has it on.
3. Preview to export parity: render one graph at edge 1024 and at
   full 4000 and hold the grain's autocorrelation width as a fraction
   of the short side within 10% between them. This is the test that
   did not exist and whose absence let the drift live.
4. ROI parity: a zoomed preview (roi_w 0.25) must carry the same
   sigma in picture terms as the whole-frame render; test with the
   same measure, since `short` corrects for the patch.
5. The finished-field cache is keyed on sigma bits, so per-scale
   fields separate on their own; test that a preview and an export
   do not share a field entry, and that the cap of four still holds
   with the extra keys a zoom session makes.
6. Small previews: at 1024 px a 35mm grain fraction gives a sigma
   under the 0.05 floor, which reads as per-pixel noise rather than
   grain. Decide and test: either the floor rises to 0.5 px and the
   preview shows a faint, honest small-print grain, or the preview
   shows the 1:1 field only in a zoomed ROI. the product decision, shown on his
   frames before landing.
7. Enlargement itself: a `format` choice on Grain (35mm, 645, 6x6,
   6x7, 4x5), the negative's size against the print, scaling the
   fraction (35mm the coarsest); the Film row's presets rewrite in
   the new units. Test: the same stock on 4x5 is a quarter of the
   35mm fraction.
8. Performance: the field build is cached per key, so the cost is one
   build per (size, scale) pair; measure the first preview after a
   size change at 1024 and at a 4000 export and record both.
9. Docs: grain.md gains Enlargement and the parity promise; the
   honesty note stands.

## Review follow-ups (2026-09-15)

- Item 9, the hue field cache: `black_white_hue_field_cached` keys
  the smoothed field on the input buffer's identity (a Weak that must
  upgrade to the Arc in hand), two entries, so a curve, Neutral or
  material dial moving reads the field once; 1739 ms to 25 ms at
  24 MP on the review's bench.
- Item 2, the profile bypass: the serializer wakes a bypassed profile
  for a stock only on a rendered source (`renderedSource(state)`,
  the JPEG and bake case), so a profile the user bypassed on a RAW
  stays bypassed; the Film row dims and says so, and the Zones dial
  rule (`filmDevelops`) reads the same test as the desktop's
  `place_zone`.
- Item 1, ownership by chain position: each active conversion's
  profile is the nearest Tone Profile below it on the image chain
  (`profileBelow`), so two conversions with two profiles each take
  their own stock, a conversion with no profile below keeps the film
  it carries itself, and a profile serving no active conversion is
  sent without its stock; each hue-keyed mask and Recolor reads the
  input of the nearest active conversion above it (`conversionAbove`,
  `hueMaskFeedBelowConversion` now a per-node map), so parallel
  branches feed their own and a node below two conversions in a row
  reads the nearer one's; the viewer's pickers and Develop's stand-ins
  address the main chain's conversion (`mainConversion`), never a
  layer's. A layer's own conversion, whose chain ends at its blend,
  has no profile below and so keeps its own film.

## Review follow-ups, the taste calls (2026-09-15)

the owner took every recommendation: 3 show the miss, 4 fix the bars, 5 make
light add up, 6 switch the curve on, 7 one face per curve with a
migration, 8 keep the guidance and name the exception.

- 3: `Solved.landed` and `ZonePlaced.landed`; the log says "placed as
  far as it goes" or "fell short" with the zone the spot came to rest
  on, as a warning.
- 4: the bars read a plain 200 px render of the chain's end
  (`usePlainEndThumb` through node_thumbs), never the frame on screen
  while a zone view is up.
- 5: the split print sums the grade 0 and grade 5 densities at half
  each; a sum of rising curves rises, so order holds for any two times
  (a grid test). A stop more Hard reaches the highlights, as it does
  under an enlarger; the hints say so.
- 6: Separate's push sends `hue_curve_on: 1` with the points.
- 7: `ir_interp` and `depth_interp` on the conversion, read by the
  engine with a fallback to `eq_interp`; EqEditor's `interpParam`
  writes them; `split_curve_faces` at load copies a saved shared face
  into both; `set_curve_interp` on the conversion freezes the two at
  the face they had; both pro.
- 8: the rule that help lives in the status line gains its exception,
  written into the UI language rules: a multi-step gesture may say its
  next step where the gesture is, since the status line explains the
  control under the cursor and cannot explain a sequence you are in
  the middle of. Zones' guidance line stays.

## Chain placement

- Conversion: the existing `bw` slot, after Relight, scene-linear.
  Depth is read from the Depth Map node the way the depth tools do,
  so the map's Edges and Flatten refinements apply.
- Development: a mode of the Tone Profile node, in place.
- Paper: a new slot after Curves, before Output.
- Hue masks downstream of the conversion: fed by fan-out from the
  conversion's input (idea 2).

## Invariant tests

- Conversion with Amount 0 is a bit-exact identity; with every filter
  and film at Amount 100 the output is neutral (r = g = b).
- Every filter and film is monotone in luminance: a brighter neutral
  never converts darker (the existing green-slider monotonicity test,
  extended across the LUT).
- The spectral LUT reproduces the direct integration within 0.5% at
  a thousand random RGBs.
- Orthochromatic film renders a saturated red darker than a saturated
  cyan of equal luminance; panchromatic renders them within a stop.
- The solver never moves a weight past the panel's range and always
  increases |g_A minus g_B| against the starting mix.
- Zone placement is exact: after placing a spot on Zone N, its
  display value is that zone's value within one part in a thousand;
  a second placement leaves the first within the same tolerance.
- Each film fit hits its datasheet points within 0.05 density at
  every published development.
- Paper output never exceeds the grade's Dmax; split grade with the
  hard time at zero equals grade 0 alone.
- Toning by density is the identity at zero and preserves luminance
  ordering at every strength.
- The hue-mask splice: with Treatment on, a Hue Range mask below the
  conversion selects the sky by blue on a mono picture; with
  Treatment off, its input is the ordinary chain.

## Phases

Each phase ships on its own, in this order; none needs the one after
it. Effort is at the usual pace, engine plus panel plus tests plus a
user-guide page per phase.

| Phase | Ideas | What ships | Effort |
| --- | --- | --- | --- |
| 1 | 1, 2 | Hue curve conversion, collision overlay, two-point solver, hue masks stay live below the conversion | 2 days |
| 2 | 3 | Zone ruler, Zones overlay, placement picker driving Exposure; Development as a plain contrast until phase 3 | 2 days |
| 3 | 4 | Mono Tone Profile mode with the film curve families; Development in N steps; the picker's second point lands on it | 3 days |
| 4 | 5 | Spectral conversion: filters and films by curve, baked LUT | 3 days |
| 4b | 5 | Infrared: the lab bench, then the material prior, 720 and 850 nm filters, Rollei IR 400 and HIE, if the bench convinces | 1 day bench, 2 days feature |
| 5 | 6 | Near / Far depth-graded conversion, after the product decision on the depth eye | 1 day |
| 6 | 7 | Paper node: grade, split grade, base, toning by density | 3 days |
| 7 | 8 | Grain film presets, then Enlargement after its test plan | 1 day plus the plan |

Phase 1 first because it is the cheapest and the one users feel
immediately. Phases 2 and 3 are the product; together they are the
branch's name. Phases 4 and 6 are the two claims no competitor can
answer: a filter that is glass and a paper that is paper. Phase 5 is
small once 4 exists and is the one only Heeler can build at all.

## Decisions (2026-09-14)

1. **Tier**: the mixer, hue curve and separation tools free; films,
   zones, spectral filters, depth grading and the paper pro, like
   Color Sets. Agreed.
2. **The depth eye**: always on the section, Fog's side of the
   2026-09-05 rule rather than Halation's exclusion (idea 6). Agreed.
3. **Film list**: the first cut of five, HP5 Plus, FP4 Plus, Tri-X,
   T-Max 400 and Ortho Plus, one list shared by ideas 4 and 5. Agreed.
4. **Infrared**: first "we would be inventing a band not existing in
   the RAW", then on second thought "it would be fun to try and
   emulate it": a lab bench first, the feature if the bench convinces
   (idea 5, phase 4b). The prior is labeled simulated. the owner's
   condition: "ensure the features are in place for a user to fine
   tune the guessed spectrum to dial it in", so the prior is not a
   constant. Each material's infrared lift is a control (Foliage,
   Sky, Water, Skin, Haze), and the expert face is the extension
   curve itself: reflectance past 700 nm against the visible hue,
   the same periodic hue curve the conversion uses (idea 1), so a
   user who disagrees with the guess for one material moves that
   hue's point. Agreed.
5. **Paper white on the viewport surround**: dropped. the owner has kept
   borders and surrounds out of Heeler ("this feels like something
   [a layer editor] is for"); the paper's base tone stays as a control on
   the picture itself, and the surround is left alone.

6. **The sections** (2026-09-14): "Will the pro features be in
   their own section? What do you plan on naming it? Others apps
   already used the name Ansel for their black and white tools. Cute,
   but also low effort." Proposal: yes, two pro sections named for the
   two halves of the process, not for the man. **Negative**: the
   scene-linear half, the filter and film (phase 4) and the
   development curves (phase 3); the Zone System went to the Exposure
   section instead, since it is an exposure tool for any photograph. **Print**: the display-
   domain half, the paper (phase 6). The mixer, the Hue curve,
   Separate and Collisions stay free in Color's treatment block, as
   decision 1 has them. Plain nouns in the house style (Levels,
   Curves, Relight, Recolor), each naming what the section makes, and
   the chain placement in the spec is already this split. Awaiting
   the owner's word.

## Deferred, deliberately


- Enlargement-tied grain: completed in phase 7 above.
- A negative view (edit the picture as the negative); a real darkroom
  skill, but a view toggle with no new control, so it waits for a
  request.
- Dodge and burn in exposure time: the Dodge and Burn layer already
  exists; a seconds-and-f-stops face over it is a rename, not a
  feature, until the paper's log-exposure model is in.
- Push and pull as a speed change rather than a contrast change
  (development also moves the film's effective speed); folded into
  Development once the curve families show how much each film's
  speed moves per N step.
