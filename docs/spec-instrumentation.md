# Instrumentation: stage probes and scopes (M5.1, M5.2)

Status: **5.1 through 5.7 BUILT (v1s), tail pass done** (2026-08-23).

## Tail pass (BUILT)

- **Chromaticity diagram** (proposal §2.2): a fifth scope kind, "CIE".
  The 1931 horseshoe (spectral locus at drawing resolution), the sRGB
  triangle, the Planckian locus with the same CCT fits the Chromatic
  Adaptation node uses, D65 marked as home, and the photograph as a
  cloud. Out-of-gamut stops being a phrase and becomes a place.
- **EV graticule** on the waveform and parade: an EV chip swaps the
  quarter-level grid for lines at each stop around middle gray, placed
  where each stop lands AFTER the display encode, since that is the
  axis the plot draws. (Scene-linear engine-side scope taps remain the
  deluxe answer; this is the honest display-referred version.)
- **Tone EQ guided filter**: the illuminance estimate upgraded from a
  box blur to the guided filter (He, Sun, Tang 2010), self-guided on
  log2 luminance, eps = (0.3 EV)². The halo test pins it: shadows
  lifted 1.5 EV at maximum smoothing leave the bright side of a hard
  edge within noise of untouched.
- **In-image zone picking**: the ◎ PICK chip in the Tone EQ section
  arms the targeted-adjustment gesture: click a brightness on the
  photo, drag vertically, the zone under the cursor re-exposes (80px
  per stop, one gesture, one undo entry). Sampling rides the existing
  sample-at-node-input command, aimed at the Tone EQ's feed.

## Remaining tail, and where each piece belongs

- Working Space Convert node and Soft Proof: they ARE wide-gamut and
  monitor-path work; folded into the M2 return where they belong.
- 5.4's draggable curve face, LUT baking (needs headless branch
  render), clip forensics, edge badges, harmony constraints, branch
  A/B, Color Sets expert curves: parked as polish behind the M2/M3
  ledger, each a self-contained later pass.

## 5.7 Chromatic Adaptation + Channel Mixer (BUILT)

**heeler.chromatic_adapt** (ops_adapt.rs): CAT16 (Li et al. 2017),
XYZ through the published M16 matrix, von Kries gains from the source
white to the D65 working white, partial adaptation blended in the
gains as CAT16 defines it. Source illuminant by preset (D65/D50/
A/F2, CIE chromaticities) or by temperature through the published
CCT-to-xy fits (Kim cubic below 4000K, CIE daylight locus above).
The load-bearing test: a pixel that IS illuminant A's white, adapted
from A, comes out achromatic. Mixed lighting = the node's mask input,
no special mode needed. Distinct from White Balance on purpose: WB is
creative per-channel gains, this is colorimetry.

**heeler.channel_mixer** (ops_primitives.rs, beside the Channel Gain
it generalizes): the full 3x3, each output channel a weighted sum of
all three inputs. `preserve_gray` on by default renormalizes each row
to sum to one, so neutrals hold under any weights; off is how the
classic red-filter monochrome looks get built.

## 5.6 3D LUT node (v1 BUILT)

`heeler.lut` (ops_lut.rs): a .cube file applied by trilinear
interpolation, in DISPLAY-ENCODED space, because creative LUTs are
built against encoded video and feeding them scene-linear light
shreds their shadows. The path is a parameter; the file never enters
the graph (a 33³ table is 400KB and a graph file should not carry
it). Parsed tables cache per path, mtime-invalidated. A missing file
is an ERROR at render, never a silent identity: a graph that quietly
renders without its LUT lies about what it will export. The inspector
shows the filename, the LUT's own title and size (the inspection the
plan asked for), a CHOOSE… picker, and the generic amount slider.
Deferred [P3]: LUT baking from a graph branch (needs headless branch
render, shared with export) and 1D .cube support.

## The Color Tune (BUILT 2026-08-23, designed with the owner)

Per-hue-family grading strips: the hue-indexed sibling of the tonal
Color Wheels, and the tool that (with Recolor's L▸H) retired Split
Tone. Six fixed bands on the OkLab hues of the sRGB primaries and
secondaries (the vectorscope's landmarks, computed from the published
matrices), plus CUSTOM bands born from an eyedropper pick: no preset
"Skin" band, because subjects vary (the product decision); pick the skin and the
band is born on that hue, with a Width dial and a delete. The custom
cap is a Preference (default 4, range 1-8).

Per band: a 2D wheel (drag toward a hue = pull the band's colors
toward that direction, radius = how much of the way), Hue shift,
Saturation, Vibrance (weighted toward the band's LESS saturated
pixels, so rich color does not clip), and Luminance in EV. The
Recolor contract throughout: OkLCh at constant companions, exposure
multiply for luminance, parallel evaluation, the chroma gate, the
smoothed lookup field. All bands ride one `bands` JSON param; empty
is the engine's identity fast path.

The face (the owner's constraint: seven wheels do not fit a panel): ONE
wheel at a time, chosen from the band strip; RGB and CMY group views
show editable trios of smaller wheels; the pop-out window gives the
whole thing room. Reset empties the bands. In the default graph after
Recolor, identity until touched.

## 5.5 redesign: Relight, the parametric EQ (BUILT 2026-08-23)

the owner's redesign session, after an open-source RAW editor's tone and color equalizers:
"neither [face] makes sense at a glance... make an intuitive widget
over more vague sliders... a parametric EQ (like what is used in
audio)". Renamed **Relight** (avoid similar feature names; the
internal type stays heeler.tone_eq so saved graphs keep rendering).

- **One widget, three homes**: the same EqEditor component renders in
  the Adjustments panel, the graph inspector, and a pop-out window
  (redrawn at window size like the Curves pop-out, never stretched).
  That is the structural fix for the panel and inspector disagreeing.
- **Parametric, not graphic**: points move freely in x and y
  (that editor pins its nodes to fixed columns); double-click adds,
  ALT-click removes, layouts (3/5/9-zone) are presets. Tangent
  handles appear on the selected point: automatic Catmull-Rom until a
  handle is dragged (symmetric; ALT breaks the pair), double-click
  the point to return to automatic.
- **The photograph behind the curve**: an illuminance histogram in EV
  bins, plus edge markers when mass sits outside the window.
- **Fixed axis, -6..+3 EV** (settled with the owner): muscle memory,
  portable presets, pixels per stop. The **Range shift** dial slides
  the photo's tones through the window instead of the window over the
  tones (the open-source editor's "mask exposure compensation", named honestly).
  Sliders that survived the redesign: Range shift and Smoothing, the
  two that are not curve shape.
- **Engine**: a `points` JSON param (x, y, optional tangent vectors),
  cubic Hermite with Catmull-Rom auto slopes: nine evenly spaced
  points with no tangents is bit-for-bit the old zone curve, so the
  zone sliders convert losslessly and remain the no-points fallback
  for old graphs. eqcurve.ts and ops.rs carry the same hand-computed
  test vectors; either side drifting fails its own suite.
- **Recolor (BUILT, same design session)**: the channel-routing color
  EQ. Every curve is one machine: an input channel selects pixels, an
  output channel changes them; a leading color grader ships six such curves as
  unrelated tools, the open-source editor ships the hue row, Recolor exposes the
  MATRIX as a routing grid (rows select-by, columns adjust; cells with
  a live curve wear a dot; reserved cells hidden: lum→lum is Relight
  and Curves, lum→hue is Split Tone, sat→hue is the rare bird).
  Cells: hue→hue/sat/lum, sat→sat/lum, lum→sat. Honest channels:
  OkLCh h and C, EV for lum (Relight's axis, settled with the owner over
  a color grader's video percent); hue rotates at constant L and C, sat is a
  chroma scale at constant L and h, lum is the exposure multiply.
  PARALLEL evaluation: all curves read the ORIGINAL channels and
  compose once, so curves cannot feed back (the engine test pins it);
  sequential is what node chains are for. The open-source editor's scar tissue
  kept: Neutral guard (hue curves fade below a chroma floor: at the
  default it is exactly the Color Sets gate) and a smoothed chroma
  field for the LOOKUP only. The hue axis is periodic: the point list
  is repeated a period each side, seam tested on both sides in both
  languages. Same widget, same tangent mechanics, same PICK gesture
  (adds a point when none is near); sat axis normalized 0-100% of
  OkLab C=0.3. In the default graph after Color Bend under the
  identity bargain. The popout machinery is now DERIVED from
  TOOL_WINDOWS (the six hand-lists are one registry plus the static
  capabilities file).

## 5.5 Tone Zone Equalizer (v1 BUILT)

`heeler.tone_eq`, an on-demand section (not in the graph until its
switch goes on; the Relight switch splices it in between Exposure and
B&W, and a load never adds it, nor any other off-by-default section). Exposure as a function of illuminance:

- Nine zones, one EV apart, -4 to +4 around middle gray. The zone
  curve is a Catmull-Rom interpolant through the slider values, and
  deliberately CARDINAL: a slider at +1 EV delivers exactly +1 EV at
  its zone's center. (The first draft's normalized-gaussian basis
  delivered 0.42 of the label, which is a slider that lies.)
- The adjustment is a pure exposure multiply, so chromaticity never
  moves; illuminance comes from box-blurred luminance so one surface
  gets one exposure and local contrast survives. Honest limitation: a
  gaussian estimate can halo around hard backlit edges at strong
  settings; the open-source editor's guided filter is the deluxe answer and stays
  on the ledger.
- Faces: the Develop "Tone EQ" section is the simple face (Shadows =
  -2 EV zone, Midtones = 0, Highlights = +2 EV, plus Smoothing); the
  graph inspector is the expert face with all nine zones.
- Deferred, pending the owner's UX read: in-image zone picking (click the
  photo, adjust the zone under the cursor). This is the promotion document the
color-science-depth-proposal (in git history at 10e324f0) requires before its P2 items are
buildable: §2.3 (stage probes), the §2.1 scopes deltas, §2.4 (gamut
warning with attribution), and §3.3 (View Transform node).

## 5.4 View Transform node (v1 BUILT)

`heeler.view_transform` (ops_view.rs): the scene-to-display rendering
as an explicit node with a selectable curve family, meant in place of
the Tone Profile for people who want a different rendering answer.
Same contract as tone_profile: scene-linear in, values shaped so the
output encode produces the intended display picture.

The curves are published, cited in the source, not house inventions:

- **Sigmoid** (default): power sigmoid on the encoded axis, middle
  gray anchored at encoded 0.5 whatever the contrast slope (the
  anchor is tested; the open-source editor's sigmoid family).
- **Filmic**: Hable's filmic operator, white point as stops
  above middle gray (6 EV default lands at 11.5, beside the classic
  11.2).
- **AgX**: the default view transform of a popular open-source 3D suite: inset matrix, log2
  encode over [-12.47, 4.03] EV, the 6th-order sigmoid fit, outset,
  2.2 decode. The neutrality test (gray in, gray out) is the guard
  against the classic transposed-matrix shipping accident.
- **ACES**: Narkowicz's RRT+ODT rational fit, labeled the
  approximation it is.

Params: mode, exposure_ev trim, contrast (sigmoid), white_ev
(filmic). Deferred to a later phase: the directly-draggable curve
face with scene-vs-display range bars, GPU mirrors, and the
highlight-reconstruction tab pairing.

Answer to proposal §8 Q2, settled here: **explicit placement always,
no auto-insert**. The default graph ships with the calibrated Tone
Profile visible; swapping it for a View Transform is deliberate graph
surgery the graph shows. A hidden fallback transform would be the one
node the graph lies about.

## 5.3 Gamut warning with attribution (BUILT)

- **Gamut view**: a viewer toolbar toggle. The frame renders dimmed to
  gray with the unshowable marked: RED where a channel went negative
  (a hue outside the working gamut), WHITE where a channel will clip
  at encode. A view, not an overlay, so it rides the whole existing
  render delivery path and needs no frame-locked layering.
- **Attribution**: `gamut_report` walks the graph's image spine source
  to output (each step a session-executor cache read against the frame
  on screen), measures the out-of-gamut fraction at every stage, and
  names the FIRST node whose output has meaningfully more than its
  input. The badge shows OUT and CLIP fractions, the culprit's name,
  and "from the source" when the camera matrix brought it in.
- **One-click fix**: ADD GAMUT MAP splices a `heeler.gamut_map` node
  onto the culprit's image output: ordinary undoable graph surgery.
- **The Gamut Map node itself** (proposal §3.8 / plan 2.6, built early
  because the fix needed it): the shared constant-luminance soft clip
  from M1 (`compress_gamut`), with an `amount` blend. This closes plan
  item 2.6 ahead of its milestone.
- Deferred: RAW-clip vs edit-clip forensic overlays (the report's
  source_fraction is the seed for it).

## What already exists (found, not planned)

The scopes panel the proposal asks for is substantially BUILT:
`spectrums.ts` computes histogram, waveform, RGB parade, and
vectorscope; the Adjustments panel hosts them and a pop-out window
gives them room. They deliberately read the frame on screen: a scope
answers "what is going to the display", and sampling the rendered
frame IS that, not an approximation of it.

That design choice pays off now: anything that changes what the viewer
shows automatically feeds every scope. So probes do not need a scope
plumbing project; soloing a probe IS feeding the scopes.

The engine side of probes also exists: the session executor caches
per-node outputs by content key, and `exec.render(&g, &terminal, ...)`
accepts any node as terminal (the curve eyedropper and mask view
already use it). Probing is a cache read, not a re-render, which is
the proposal's stated architectural requirement, already met.

## 5.1 Stage probes

A probe shows one node's OUTPUT in the viewer, live. The proposal says
"any edge"; a node's output IS the edge's source, so probing by node
covers every edge with one affordance and no wire hit-testing.

- **State**: `probeNode: string | null`, transient view state (like
  the Color Set mask eye), never saved, cleared on photo switch.
- **Render path**: the existing `mask_node` redirect in
  render_preview. It already accepts any node, handles image and mask
  values both, encodes losslessly, and sRGB-encodes a scene-linear
  intermediate on the way out, which is exactly what "show me the
  image at this stage" means. Probing rides it unchanged; the GPU tail
  skip on that path is acceptable (the executor cache carries the
  cost).
- **Affordance**: the graph node context menu gains "Probe output" /
  "Stop probing" (single selection). The old menu comment promising
  "View this node's output" is finally paid.
- **Viewer**: a badge names what is being probed and clicks away to
  the developed photograph. Without the badge a probe looks like a
  broken edit, which is how mystery bug reports are born.
- **Scopes follow for free** (see above). Slider drags re-render the
  probed view through the same interactive path as the normal preview.

Deferred within 5.1: per-channel clipping state at the probe point
(RAW-clip vs edit-clip is §2.4's forensics; it lands with the gamut
warning pass).

## 5.2 Scopes deltas (the gap between built and proposed)

- **Vectorscope skin-tone line** (this pass): the classic I-line
  reference at the flesh-tone hue angle, drawn on the existing wheel.
- **Graticule modes** (IRE / EV / nits) and per-channel histogram
  extensions: deferred; EV graticules want scene-linear data, which
  means engine-side scope taps, a bigger seam than the payoff today.
- Log-scale histogram already exists (log1p normalization).

## Answers to the proposal's open questions (§8)

1. Dockable vs floating scopes: both already exist (panel + pop-out
   window). Settled by the shipped design.
2. View Transform auto-insert: unchanged by this pass.
3. Point-cloud decimation: moot for now; scopes read the on-screen
   frame, whose resolution is already the preview tier's.

## Tests

- maskPreviewNode precedence: an active probe outranks mask views and
  the dropper overlay.
- probe_node toggles and photo switch clears.
- Menu drives it: probe via the graph context menu, badge appears,
  badge click returns the developed photograph.
