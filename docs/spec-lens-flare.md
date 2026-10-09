# Lens Flare, an extension of Depth Lighting

Status: **v1 BUILT 2026-09-03** (engine op, registry, raster and ROI plumbing, rig mirroring, section, presets, Match chip, user guide). Second draft, decisions closed. The first
put the flare in the Finish tab as a layer; the owner, reading it: "I wonder
if this should be in the Finish tab, now that I think about it. Feels
like a hybrid or extension of Depth lighting." It is. This draft puts
it where the light already is.

the owner's brief: "lens flares to add glowing flares to part of an image. It
should be non-destructive. Light position should be editable, and also
work with depth masks. We will need attributes to control the
characteristics of the flare. Presets of attributes could be based on
lens types/focal-lengths."

Anchors: the depth tools (ops_depth.rs: the key light's rig of lights,
each with a position, a depth on the NEAR-FAR axis, a color, a
strength and a switch; the Position lights picker in viewer.tsx), the
layer-tool pattern in state.ts (`LAYER_TOOLS`: a develop section is a
node in the main chain, maskable through a layer copy), the Color Sets
pair (two nodes carrying one shared number, written together by the
panel), docs/spec-lens-presets.md (static parameter snapshots named
for glass), and the raster planting the depth tools and Recolor's
Depth row share.

## What it is

A **Lens Flare** section in Develop, beside the depth tools,
that renders the optical signature of a lens for the lights already in
the Depth Lighting rig: the source glow, the diffraction rays, the
chain of aperture ghosts down the axis, the anamorphic streak when the
glass was anamorphic, and the veiling glare that lifts the blacks
around a bright source. Each light in the rig can flare or not, at its
own strength; the lens is one per photograph, so its character (the
preset and the look dials) lives on the section, not on the light.

It is NOT a paint of a flare picture. Every element is drawn from a
light's position and the lens's description, which is what makes the
position editable after the fact, the look presettable by lens, and
the whole thing depth-aware for free: the light was in the scene
before the flare existed.

## Why here and not in Finish

- **The light already exists.** A point lamp in the rig has a
  position, a depth, a color, a strength and an on/off. A flare is
  what the lens makes of that same light. A Finish layer would invent
  a second light object with the same five properties and a second
  gizmo, and the two would drift.
- **The chain position is physical.** The flare is light entering the
  lens, so it belongs in the scene-linear chain, after Depth of Field
  (the flare happens in the lens; the scene's defocus must not soften
  it) and before the Tone Profile (the profile rolls flare into the
  highlights the way a real flare blooms). Finish composites after all
  of that, and a flare pasted onto a tone-mapped picture looks pasted.
- **The lens is a property of the photograph.** A lens preset on a
  layer was the awkward part of the first draft. On a section it is
  node-level, one lens per photo, suggested from the shot's own focal
  length and lens name.

What Finish would have given and this does not: blend modes, groups,
and opacity as a separate dial. None of them earns its place for
light. The blend is always Add (scene-linear light adds), opacity is
intensity, and a mask is still there through a layer copy of the
section, as for every develop section. The one real loss is ordering
a flare above a Finish retouch; if that ever matters it argues for a
Finish version later, not against this one.

## The architecture in one sentence

A new main-chain node, `heeler.flare`, spliced after Depth of Field
and before the Tone Profile like any section tool, carrying its own
look params and a **copy of the rig** (`lights`, the same JSON the key
light holds) that the panel writes to both nodes in one step, the
Color Sets pair's rule for a number two nodes must agree on; the op
reads the rig, renders each flaring light's elements into the frame in
scene-linear light, and adds them.

Two nodes rather than one op doing two jobs, so relighting and flaring
are separately switchable, separately reset, separately masked through
their layer copies, and a photograph with a flare and no relight does
not carry a key light doing nothing.

## The rig, extended

Each light in the rig (`lights` JSON on the key light; see
`KeyLightSpec`) gains two fields, both defaulting so that every saved
rig opens unchanged:

- `flare`: bool, default false. Whether this light flares.
- `flare_strength`: 0..300, default 100. This light's flare intensity,
  relative to the section's.

Everything else a flare needs from the light is already there:
`px`, `py` (a point lamp's place; a directional light flares from the
direction it comes from, projected to the frame edge along its
azimuth), `depth` (the lamp's place NEAR to FAR, which is what the
occlusion reads), `color` (the flare's tint), `on` (an off light does
not flare). The Position lights picker moves a flaring light exactly
as it moves any other; the only change is that the handle may be
dragged past the frame edge and stays visible at the edge with an
arrow, because a light just out of frame is the classic flare.

The key light ignores the two new fields; the flare node ignores
everything it does not need. Mirroring is the panel's job: every write
to the rig lands on both nodes in one dispatch, and a photograph whose
graph predates the flare node has no flare node until the section is
first switched on, per the section-tool materialization rule.

## Depth: the light is in the scene

A flare is the image of a light source, so when something in the scene
stands between the lens and the light, the flare dims, and when the
light is hidden the flare is gone. Nothing in a compositing tool does
this; Heeler has the plane to do it.

- **Occlusion**: a light's visibility is the fraction of its core disc
  whose plane reads farther than the light's `depth`, sampled on the
  planted farness plane (`plane_from`, resampled to the render size,
  the depth tools' reader). A person walking in front of a low sun
  cuts the flare as they cross it. `occlusion` 0..100 is how much of
  that to apply (100 is physical; 0 ignores the scene);
  `occlusion_soft` feathers the transition across the disc.
- **Everything scales by visibility**: the core, the rays, every ghost
  and the veil are all images of the source, so they fade together.
- **The foreground cut** (added 2026-09-03 after "a lens flare
  will get obscured by foreground objects between the light source
  and camera... a window of opportunity"): the core, the rays and the
  streak are also masked PER PIXEL by the same test, this pixel's
  plane against the light's depth, with the Occlusion group's Strength
  and Softness as amount and feather. A person crossing in front of a
  low sun cuts the glow at their silhouette instead of wearing it.
  Ghosts and veil are formed inside the lens, so an object at their
  screen position does not block them; they follow the source's
  visibility alone. Physically honest, and the thing overlaid flares
  never do.
- **Veil by depth** `veil_depth`: the veiling glare is atmosphere
  reading light, so it can be told to land more on the far plane than
  the near one (positive), or the reverse. Zero is uniform.
- **No plane**: the flare renders in full with occlusion off, and the
  depth runner computes the plane the moment `occlusion` or
  `veil_depth` is non-zero, through the depth tools' consent card.
  `wants_planted_raster` and `raster_fed` gain `heeler.flare` under
  that rule, and the View depth eye sits in the section the way it
  sits in Depth Lighting. Planted rasters already follow the crop.
- **A mask** through the section's layer copy, for what depth cannot
  say ("not over her face").

## Anatomy and attributes

Every element is analytic, drawn per pixel from a light's position and
a handful of numbers, so the render is one pass over the frame per
flaring light plus one small pass per ghost. Sizes are fractions of
the short side, so a preset means the same thing on a 12 and a 45
megapixel frame.

| Group | Param | Range | Meaning |
|---|---|---|---|
| Lens | `intensity` | 0..300 | the section's brightness, %; each light's `flare_strength` multiplies it |
| | `temp` | -100..100 | warm/cool shift on the whole flare (the Recolor Temp output's reach) |
| Source | `size` | 0..30 | core radius, % of the short side |
| | `softness` | 0..100 | shown as Falloff: how the core falls off (0 a disc, 100 a haze) |
| Rays | `rays` | 0..32 | count; 0 is none; a diffraction star is 2 × blades |
| | `ray_length` | 0..100 | % of the short side |
| | `ray_softness` | 0..100 | angular width |
| | `rotation` | 0..360 | the star's orientation |
| Ghosts | `ghosts` | 0..16 | how many aperture images down the axis |
| | `ghost_spacing` | 10..200 | spread along the axis through the center, % |
| | `ghost_size` | 0..30 | % of the short side, tapering with distance |
| | `blades` | 3..12 | aperture shape: the ghosts are this polygon |
| | `dispersion` | 0..100 | chromatic fringing on the ghost edges |
| | `ghost_opacity` | 0..100 | |
| Anamorphic | `anamorphic` | 0..100 | shown as Strength; 0 is none |
| | `streak_size` | 0.2..8 | Thickness, % of the short side |
| | `streak_length` | 10..300 | Reach, % of the short side |
| | `streak_taper` | 0..100 | how much it thins toward its ends |
| | `streak_angle` | -90..90 | degrees; anamorphic glass makes it horizontal |
| | `streak_offset` | -50..50 | along its line, away from the source, % of the short side |
| | `streak_shift` | -50..50 | across its line, % of the short side |
| | `streak_noise` | 0..100 | Breakup: slow noise along the length swelling and thinning the thickness and making it denser and sparser ("thicker in some places than others, and more dense, not just a noise") |
| | `streak_stops` | text | the color ribbon, the gradient layer's stop list from the source (0) to the end (100); empty means `streak_color` |
| Veil | `veil` | 0..100 | low-frequency glare lifting the blacks |
| | `veil_radius` | 5..100 | % of the short side |
| | `veil_depth` | -100..100 | see Depth |
| Occlusion | `occlusion` | 0..100 | shown as Strength |
| | `occlusion_soft` | 0..100 | shown as Softness |

Text params: `lights` (the mirrored rig), `streak_color` (default the
anamorphic blue), and `preset` (the id the dials were last set from,
so the panel can say "Vintage prime, edited" rather than pretending).

Depth of Field already owns `blades` for its bokeh; the flare's
`blades` is its own number, because a preset describes the lens as a
whole and the two tools may be set independently. The suggestion
below seeds both from the same guess.

### How each element is drawn

- **Core**: a radial falloff `exp(-(r/size)^k)` with `k` from
  `softness` (2 for a disc's edge, 1 for a haze), in the light's color.
- **Rays**: angular Gaussians around `rays` equally spaced directions
  from `rotation`, each multiplied by a radial falloff out to
  `ray_length`; the star a real aperture makes has `2 × blades` rays,
  which is what a preset sets.
- **Ghosts**: for `i` in 1..=ghosts, a regular `blades`-gon centered at
  `C + (i / ghosts) × spacing × (C - L)`, `L` the light and `C` the
  frame center (ghosts mirror the light through the center, which is
  why they walk away from it), sized `ghost_size × (1 - 0.6 i /
  ghosts)`, drawn by a signed-distance function with a soft edge,
  tinted by a hue that advances with `i`, fringed by `dispersion` (the
  polygon sampled at three slightly different scales for R, G, B).
- **Anamorphic streak** (regrouped 2026-09-03 on the owner's notes: "Size,
  taper, scaling, and most important color... a color ribbon... its
  own internal artifacts and noise... rotational values and offsets
  from source"): the pixel's offset from the light is turned into the
  streak's frame by `streak_angle` and moved by the offsets; across
  the line a Gaussian of the thickness, which tapers with distance;
  along the line full brightness to two thirds of the reach and a
  smooth fall to nothing exactly at the end, so the ribbon's 100 is
  the visible end; breakup from integer-hashed value noise along the
  length, two slow signals for thickness and density, so renders stay
  bit-identical; and the color from the ribbon sampled at the
  distance along, alpha included, so a ribbon can fade the streak
  out. The editor is an interactive ribbon (the owner's design): handles you
  drag along the bar, a swatch under each that opens Heeler's own
  picker, a click on the bar adding a point in the color found there,
  an X above each point, and an opacity field for the selected point.
  Stops stay in stored order while dragged (sorting on every write
  swapped rows under the pointer); the engine and the preview sort for
  themselves. Occluded per pixel
  like the core and the rays.
- **Veil**: the core rendered at `veil_radius` and low intensity, then
  weighted by `veil_depth` against the plane.
- **Composition**: each light's elements sum in scene-linear light,
  scaled by its visibility and `flare_strength`; the lights sum; the
  sum is added to the frame. The alpha channel passes through: the
  flare is light, not coverage.
- **A directional light** flares from where its direction meets the
  frame edge (azimuth projected from the center), at a depth of 100;
  the sun is behind everything.

## Presets by lens

Static parameter snapshots, the lens-preset pattern: apply writes
every look param the table names and only those, so a photo can never
inherit half of one lens and half of another. The rig, the intensity
and the Scene group are not part of a preset: they are about this
photograph, not this glass. Shipped set for v1, tuned by eye and kept
small on purpose:

| Preset | Character |
|---|---|
| Modern prime, coated | tight core, faint ghosts (2), 14 rays from 7 blades, little veil |
| Modern zoom | more ghosts (6), wider spacing, moderate veil |
| Vintage prime, uncoated | strong veil, 4 large ghosts, warm, soft core |
| Telephoto | small core, long rays, ghosts bunched near the light |
| Wide angle | large soft core, ghosts spread across the frame |
| Anamorphic 2x | the streak on, cool core, oval-leaning ghosts |
| Phone | one bright ghost, no rays, strong veil |

**Suggested from the photograph**: the menu proposes a preset from the
shot's metadata (`focal_35` and the lens name, already in
`imageMetadata`): a name with a dash is a zoom, at or under 24 mm is
wide, at or over 135 mm is telephoto, else prime. A suggestion in the
menu ("Suggested: Modern zoom"), never applied silently; the section
switches on to "Modern prime" and the user picks.

User presets come later through the file the lens presets use; v1
ships the table in `state.ts` beside `LAYER_TOOLS`.

## UI seats

- **Depth Lighting** keeps the rig. Each light's row gains a flare
  toggle (a small sun) and, when on, a strength dial. Nothing else in
  the section moves.
- **Lens Flare** is a new section below Depth of Field (the panel
  reads in the chain's order: the flare is optics after the defocus),
  with
  the section switch, reset and layer-copy affordances every section
  has. Inside, in this order: the Preset menu with the suggestion; the
  View depth eye and Position lights (the same two chips Depth
  Lighting carries, because the rig is shared and the gizmo is the
  same); then the groups Lens, Source, Rays, Ghosts, Anamorphic (with the color
  ribbon under its dials), Veil,
  Occlusion (the group carries the word, so its two dials read
  Strength and Softness; the Source group's softness dial is Falloff,
  one label per section). With no light flaring, the section says so in its own words
  ("No light is flaring: switch one on in Depth Lighting") rather than
  rendering nothing silently.
- **Viewer**: the rig gizmo, plus a **source marker** for every
  flaring light: a sun glyph where the flare comes from, pinned to the
  frame edge (dashed) when the source is off-frame, joined to the
  aiming handle by a dotted line. Built 2026-09-03 after "Does it
  make sense that the flare isn't aligned with the handle?" It did
  not: the directional handle aims (its distance from the target is
  the elevation), it is not the source, and nothing showed the source
  until this.
- **Graph mode**: the flare card shows the same inspector; its wiring
  is the ordinary section-tool wiring.

## Non-destructive by construction

Nothing is baked. The node carries numbers; the render is a function
of those numbers, the rig and the frame size. Crop, resize, export at
any size, switch takes, switch the section off: the flare follows. The
one thing not recomputed is the depth plane, which is per photograph
and already survives everything.

ROI: the node gets `roi_x/y/w/h` like paint and gradient do, and maps
every light and element into the patch, so a sharp slice at 1:1 shows
the same flare as the fit view.

## Invariant tests

Engine (`ops_flare.rs`):
- No flaring light, or intensity 0, is a bit-exact identity.
- The brightest added pixel of a core-only flare is at the light, and
  the addition is radially symmetric about it to a tolerance.
- Ghosts sit on the line through the center on the far side from the
  light, at the spacing asked for.
- Occlusion: a plane nearer than the light over the whole core removes
  the flare; over half the core, halves it; with no plane, changes
  nothing.
- A directional light flares at the frame edge its azimuth names.
- ROI: a patch rendered with `roi_*` matches the same region of the
  whole-frame render pixel for pixel.
- Sizes scale with the short side: the same params at 1000 and 2000
  pixels give the same picture at half resolution.
- Two renders of the same node are bit-identical.
- The ingest rule: a flare driven THROUGH build_graph with a planted
  plane, so a param dropped at ingest cannot hide behind a green op
  test.

Frontend:
- A rig write from the Depth Lighting panel or the gizmo lands on
  both nodes; a graph with a key light and no flare node stays valid
  and gains the flare node only when the section is switched on.
- A preset applies every look param it names and only those; the
  `preset` text records it; editing a dial marks it edited; the rig
  and Scene are untouched by a preset.
- The suggestion picks zoom, wide, telephoto or prime from metadata
  and stays a suggestion.
- The gizmo handle can be dragged past the frame edge and reports the
  out-of-frame position.
- A layer copy of the section masks the flare like any section.
- The Match chip appears only when both sections are on and disagree,
  writes Depth of Field's `blades` alone, and is one undo step.

## Effort

Engine: two days (ghost polygons with dispersion and the occlusion
sampling are the work; the rest is falloffs). Panel, rig mirroring,
gizmo allowance, presets: one day. Tests and the user-guide page: half
a day.

## Decisions (2026-09-03)

- **Directional lights flare.** "Since the direction is only two
  dimensional, having it be able to flare could sell the effect of
  faking a Z axis (depth) on the light's directional abilities." So a
  directional light flares from where its azimuth meets the frame
  edge, and its elevation sets how far past the edge the source sits
  (a high sun is well out of frame, a low one just past it), which is
  the third dimension the rig cannot otherwise show.
- **Preset names by lens family**, carrying the focal-length
  suggestion.

- **No cross-section writes.** Depth of Field owns a `blades` dial
  for its bokeh and the flare owns one for its ghosts; a real lens has
  one aperture, so the two agree on a real photograph. A flare preset
  still writes only the flare. Nothing in Heeler is written implicitly
  (the rule that took the Brush button out), a preset touching two
  nodes would leave Reset restoring one of them, and six against seven
  blades is barely visible in soft shapes anyway. Instead, when both
  sections are on and their counts differ, the flare's Ghosts group
  shows one line ("Depth of Field is drawing 6 blades") with a
  **Match** chip beside it: an explicit click, one node written,
  undoable on its own, shown only when there is something to match.
  Same rule as the preset suggestion: Heeler tells you, you decide.

## Deferred, deliberately

- **Occlusion from the Finish stack** (a painted layer hiding the sun):
  the plane is the only occluder in v1.
- **Starburst from real diffraction** (a physically computed pattern
  from blade geometry): the analytic rays are the artist's version.
- **Bloom on actual highlights** (every bright pixel flaring): a
  different tool, closer to Glow, worth its own section rather than a
  mode here.
- **A Finish-tab flare layer**, if ordering above a retouch ever
  matters; the op would be the same, wearing a layer's clothes.
