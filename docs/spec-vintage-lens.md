# Vintage lens simulation

Status: **v1 BUILT 2026-09-03**: Depth of Field's disc dials (Bubble, Squeeze, Swirl), the Halation section with its full control set, and the Lens Character block with six presets across seven sections. Decisions closed below. the owner's brief: "vintage lens
simulation. I think with the depth mapping, there is opportunity to
apply simulated vintage lens effects that can be effected through
depth masks for a more convincing effect," with a list of thirteen
effects in four groups. This document maps each onto Heeler as it
stands, names what is new, says where depth makes the difference, and
proposes how the whole becomes one feature rather than thirteen dials
scattered across the panel.

Anchors: Depth of Field (ops_depth.rs, which already carries the
lens's vices: a real aperture gather with blades and blade curve,
field curvature, longitudinal fringe, and a spherical-aberration glow),
Lens Correction (the distortion, transverse CA and vignetting models,
signed, so they run uncorrected as well as corrected),
docs/spec-lens-flare.md (veil and ghosts, depth-occluded),
docs/spec-lens-presets.md (static snapshots named for glass), Detail
(texture, signed), and Recolor (a Lum row against Temp and Tint).

## The finding: most of the list already exists in pieces

| the owner's effect | Where it lives today | What is new |
|---|---|---|
| Swirly bokeh | nothing | **Swirl** on Depth of Field: the disc kernel warps tangentially with radius from the frame center |
| Bokeh edge sharpness (soap bubble) | nothing | **Bubble** on Depth of Field: the disc's radial weight profile, flat at 0, a bright rim over a hollow center at 100 |
| Edge radial blur (field curvature) | Depth of Field's **Field curvature** (bends the focal plane by distance from center) | nothing; the dial exists |
| Anamorphic stretch of bokeh | nothing | **Squeeze** on Depth of Field: the disc kernel scaled on one axis |
| Veiling flare intensity | Lens Flare's **Veil**, per light, depth-occluded | nothing |
| Ghosting artifacts | Lens Flare's **Ghosts** | nothing |
| Highlight glow (halation) | Depth of Field's **Glow** is the in-focus halo of spherical aberration; not the same thing | **Halation**, a new node: bright highlights bleed a colored mist into their surroundings, everywhere, not only in focus |
| Chromatic aberration | Lens Correction's transverse CA (radial, per channel) and Depth of Field's **Fringe** (longitudinal: magenta behind the plane, green in front, by defocus) | nothing; both halves exist, and the longitudinal half is already depth-driven |
| Barrel / pincushion | Lens Correction's **Distortion**, signed | nothing |
| Mechanical vignette with falloff | Vignette's amount, midpoint and softness | nothing; the falloff is the midpoint and softness pair |
| Micro-contrast suppression | Detail's **Texture** at negative values, with its shadow, midtone and highlight weights | nothing |
| Coating color tint on mids and highlights | Recolor's Lum row against **Temp** and **Tint** | nothing; a preset can write it |

Three engine additions, then: **Swirl**, **Bubble** and **Squeeze** on
Depth of Field's disc, and a **Halation** node. Everything else is a
dial that exists and a preset that knows which way to turn it. Halation
grew from a node into a section with a control set of its own on the owner's
notes (below).

## Where depth does the convincing

- **Bokeh geometry is depth by construction.** Swirl, Bubble and
  Squeeze shape the disc that Depth of Field gathers, and that disc's
  radius is the pixel's defocus from the plane. In-focus areas keep
  their pixels; the character appears only where the lens would have
  drawn it. A flat overlay of "swirl" over the whole frame is exactly
  the thing a real Helios does not do.
- **Longitudinal fringe already reads the plane**: magenta behind,
  green in front, scaled by defocus. Transverse CA (Lens Correction)
  is radial and depth-blind, which is also correct: it is a property
  of the field, not the scene.
- **Field curvature bends the plane itself**, so the corners go soft
  only where the corners' depth leaves the curved plane. A photograph
  with a subject in the corner at the right distance stays sharp
  there, which a radial blur never gets right.
- **Halation by depth** (a dial, default off): the mist a highlight
  throws can be weighted by the highlight's farness, so distant
  lights bloom more than near ones, the way haze between them and the
  lens would scatter. Physically a stretch (halation is in the film),
  offered as the look it produces.
- **Veil and ghosts** are already occluded by the plane
  (spec-lens-flare.md): a vintage look with a light behind the subject
  gets a veil that the subject does not wear.

## The three engine additions

### Depth of Field: Swirl, Bubble, Squeeze

The aperture kernel (`aperture_kernel`) is a list of taps with
weights, built once per distinct radius. Three params reshape it:

- `swirl` (0..100): each tap is rotated about the disc's center by an
  angle that grows with the disc's distance from the FRAME center and
  with the tap's own radius, so discs near the edge stretch
  tangentially into the spinning "cat's eye" pattern. The kernel
  therefore becomes per-pixel in orientation; the implementation
  builds it per band per angular sector (say 16 sectors) rather than
  per pixel, which keeps the cost near the current gather.
- `bubble` (0..100): the tap weight profile along the disc's radius,
  `w(d) = 1 - bubble * (1 - (d/r)^k)` with k from the blade curve, so
  0 is the flat disc it is now and 100 a bright rim over a hollow
  center. Normalized, so exposure holds.
- `squeeze` (-100..100): the kernel scaled on one axis, negative
  vertical (the anamorphic oval), positive horizontal. Applied before
  the swirl so the oval spins as an oval.

All three are zero in every existing graph, and zero reproduces the
current kernel tap for tap: the tests pin that.

### Halation, its own section

"Halation itself sounds like a missing feature... halation plugins
can be popular so we should include this as its own section." So a
**Halation** section and node, `heeler.halation`, after Depth of Field
and before the Tone Profile (light spreading in the emulsion is
scene-linear, and it must bloom into the highlights the profile then
rolls off). the owner's control list, mapped onto the node:

| Group | Param | Range | Meaning |
|---|---|---|---|
| Source | `threshold` | 0..100 | the brightness cutoff, in stops above middle gray; lower lets dimmer highlights bloom |
| | `background` | 0..100 | Background gain: how dark the surroundings must be for the bloom to show, so the effect keeps to high-contrast borders; 0 blooms everywhere |
| | `by_depth` | -100..100 | weights the bloom by the highlight's farness on the depth plane, positive far, like the anamorphic flare |
| Spread | `radius` | 0.5..30 | how far the light leaks, % of the short side |
| | `diffusion` | 0..100 | the halo's distribution: low is a hard visible ring, high a blended gradient |
| | `format` | text | Film format preset: 8mm, 16mm, 35mm, 65mm; a smaller gauge is enlarged more, so it scales the spread up |
| Color | `hue` | 0..360 | the glow's hue, default the red-orange of film |
| | `saturation` | 0..100 | its vividness; 0 is the white mist |
| | `blue_comp` | 0..100 | Blue compensation: keeps the bloom visible on cool highlights (skies) that neutralize a red halo |
| Intensity | `amount` | 0..300 | Strength: the bloom's brightness |
| | `mix` | 0..100 | Global blend: the finished bloom over the frame |
| Bloom | `bloom` | 0..100 | the secondary glow: a wider, neutral, ProMist-like diffusion around the same sources |
| | `bloom_radius` | 5..60 | its reach, % of the short side |

- **View isolated regions** is the mask-view eye every masked tool
  carries: the halation node renders its source map (the thresholded,
  background-gated plane) as the frame, black elsewhere, so the
  thresholds are tuned against exactly what will bloom.
- **Film grain**: Heeler already has a Grain section, and one word
  means one thing. Halation does not grow a grain of its own; its
  presets (and the lens-character presets) set the Grain section
  alongside, so a bloom never lands on a clean digital surface unless
  the user wants it to.
- **The math**: the source plane is luminance above the threshold,
  multiplied by a background gate (one minus the local mean luminance
  over the radius, raised by `background`); it is blurred at the
  radius with a kernel whose shape runs from a ring (low diffusion, a
  Gaussian minus a narrower Gaussian) to a plain Gaussian (high
  diffusion); tinted by hue and saturation; boosted where the source
  is blue by `blue_comp`; weighted by the plane when `by_depth` is on;
  scaled by `amount`; the bloom is a second, wider, neutral pass over
  the same source; both are ADDED and the sum is mixed by `mix`. One
  separable-blur pass each, the Gaussian Detail already uses.
  ROI-aware like every spatial node: the patch grows by the larger
  radius, the clone's rule.

### Presets across sections: the product

A vintage lens is not one dial; it is a coordinated setting of eight.
The feature is a **lens character** preset library, on the lens-preset
pattern (static snapshots, apply writes every param the entry names,
never applied silently):

| Preset | Character |
|---|---|
| Helios 44-2 | strong swirl, bubble 30, warm coating, mild barrel, deep vignette, soft corners |
| Meyer Trioplan | bubble 90, swirl 0, hard blades, fringe, halation white |
| Petzval | swirl 100, sharp center, strong field curvature, vignette |
| Takumar 50 f/1.4 | amber coating, glow, gentle vignette, fringe |
| Uncoated 1930s | veil 60 on every flaring light, halation, low micro-contrast, cyan-less cast |
| Anamorphic 2x | squeeze -60, the flare's anamorphic preset, oval bubble 40 |
| Jupiter-9 85 | glow wide open, swirl 35, round highlights at every stop, warm |
| Canon 50 f/0.95 | glow 60, swirl 55 with cat's-eye outlining, hard vignette, barrel |

Each preset names params on Depth of Field, Lens Correction, Vignette,
Halation, Detail, Recolor (a two-point Lum→Temp curve for the coating)
and Lens Flare (the veil and ghost dials, not the rig). Apply is one
undo step. Every section stays its own section afterwards: the preset
sets dials, it does not own them, and Reset on any section resets that
section alone. This is the cross-section write the flare's Match chip
refused, and the difference is that a preset is an explicit act on a
menu whose name says it writes many things.

Seat: a **Lens Character** section of its own (the product decision), carrying
the preset menu, the metadata suggestion the flare uses (focal length
and lens name; stays a suggestion), and a short summary of what the
chosen preset set and where. It has no dials and no node: it is a
menu over the sections it writes, and the sections keep their own
switches. Depth is in the picture through those sections (Depth of
Field, Halation, the flare), which is how the owner expects to use it, and
nothing in the section requires the plane.

## Invariant tests

- Zero swirl, bubble and squeeze reproduce today's kernel tap for tap,
  so every existing DoF golden holds.
- Bubble 100 puts the disc's peak weight on its rim; swirl rotates a
  tap at the frame edge by more than one at the center; squeeze halves
  the kernel's height at -100.
- Halation: nothing below threshold blooms; a lone highlight's bloom
  is radially symmetric, its integral scales with amount, and by_depth
  weights a far highlight over a near one on a planted plane; ROI
  patch matches the whole frame.
- A preset names only params that exist, one undo step, and Reset on
  one section leaves the others as the preset set them.
- The ingest rule: every new param driven THROUGH build_graph.

## Effort

Depth of Field's three dials: one day (the sectored kernel is the
work). Halation section: a day and a half (two blur passes, the
background gate, the mask view, the format presets). Lens Character
section, presets, the suggestion, user guide: one day. Three and a
half days for the milestone.

## Decisions (2026-09-03)

- **Lens Character is a section of its own**, the menu and the
  summary; depth reaches it through the sections it writes.
- **Halation is its own section**, with the control set above rather
  than a single color dial: source isolation with a background gate
  and a mask view, spread and diffusion with film-format presets, hue,
  saturation and blue compensation, strength and mix, and a secondary
  bloom. Grain stays the Grain section's.
- **Swirl anchors on the frame center with the crop's offset**, since
  that is where the optical axis was.
- Spelling: the American "color", everywhere in the product.
