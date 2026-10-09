# Spec: Finish (art layers)

Status: phase 1 core landed 2026-08-12 (Layers tab, pixel layers with
RGBA strokes, full blend-mode set with real top-alpha, opacity,
visibility, reorder, delete, per-layer masks with paint-to-hide, the
icons-only bottom toolbar, ROI integration). Naming, : the layer
type is a PIXEL layer (paint is a tool that writes on it; clone, heal
and fill will write on the same kind). Phase 1 is COMPLETE as of the
same day: stack groups landed with isolation semantics (members merge
over a transparent canvas; the group blends onto the photo as one unit
with its own mode, opacity and mask; member blend modes do not exist
inside a group, the documented trade), the Select tool grows selection
masks on bare layers, and the stack multi-selects for grouping. Known
v1 limits: groups do not nest, a masked layer sheds its mask before
grouping, members reorder by ungrouping.

Phase 2 (retouch) landed 2026-08-13: heeler.clone (clone and heal, with
per-stroke source offsets and a per-stroke heal flag), heeler.fill and
heeler.gradient, all three as layer kinds in the same stack. Clone and
heal are ALT-click to set the source, then the first stroke locks an
offset that travels with the brush (aligned, as a clone stamp does).
Heal v1 matches the destination by the coverage-weighted mean
difference per stroke: texture from the source, tone from where it
lands. Honest limits, to revisit as heal v2 (Criminisi + PatchMatch):
the match is per stroke rather than spatially varying, so a repair
across a strong gradient can band; and nothing synthesizes texture, so
a hole with no good source elsewhere in the frame stays a hole.

Content nodes are now fed by the layer BELOW them rather than the bare
photograph, which is what makes a clone sample the composite the way a
retoucher expects. Inside a group that composite is the group's own
isolated canvas, so a retouch layer belongs at the top level unless you
mean to repair only the group's contents. The ROI path grows the patch
by the largest clone offset in the graph, so cloning is correct at 1:1;
a clone reaching most of the way across the picture falls back to a
whole-frame render rather than patching.

Named FINISH, 2026-08-13. "LAYERS ... is confusing with the masking
layers in the exposure tab. The LAYERS tab isn't just about layers, it's
about a second layer of editing." RAW editors taught everyone that
"layers" means masked adjustments and layer editors taught everyone it means
a compositing stack; Heeler was using the word both ways on one screen.
FINISH names the job instead of the mechanism and states the pipeline in
one breath: Develop, Finish, Export. It also holds the no-flyers line
better than "Layers", the word that invites layer-editor expectations
wholesale. Inside the tab, rows are still layers; that is correct once
the tab-level collision is gone. Display strings only: the internal ids
(`art`, `panelTab: "layers"`, every testid) stay put so saved sessions
and tests do not churn.

Naming rules for this feature set, agreed the same day: name surfaces by
the job rather than the mechanism (nodes, layers and masks live INSIDE a
surface, never name one); one word one meaning everywhere (layer, mask,
node, take, group); no sub-brands, no trademarked feature names, because
twenty clever names make an app feel like a bundle of acquisitions and
boring surface names make Heeler the brand; the differentiator gets a
sentence of marketing copy ("finishing that never flattens") rather than
a product name in the UI; and renames touch display strings only.

Phase 3 (adjustment layers) landed 2026-08-13: Exposure, Curves, Levels,
White Balance, Color, Color Balance, Black & White, Invert and the new
heeler.gradient_map, added from an ADJUSTMENT menu in the tab. They need
almost no new machinery, because content nodes already read the layer
below: an adjustment layer IS its engine op fed by the composite below,
blended back through the layer's own mode, opacity and mask. The
inspector renders the node's numeric params from PARAM_RANGE, and a
curves layer gets the real curve editor; controls show only for the
SELECTED layer, or seven exposure sliders per row would bury the stack.
White Balance and Color are the same standard_color node showing
different halves of itself, so the layer kind is recorded on the content
card (`artKind`, UI-only, never serialized): the node type alone cannot
say which set of controls was asked for. Gradient Map takes three stops
rather than two, because cool shadows with warm highlights and untouched
mids is the thing people reach for a gradient map to do.

One pixel layer, every tool (2026-08-13). "I don't like the two
layer types. Dividing pixel from retouch... We should have one layer
that works with all the tools." A repair is now just a stroke carrying
a source offset, handled by the paint op alongside color strokes, so
paint, clone, heal, dodge and burn all write to one node's stroke list.
heeler.clone survives as a node type delegating to the same code, for
graphs that already carry one. On his memory of a selection constraining
the clone stamp: the layer's own mask does that here, and better, since
it stays editable afterwards rather than being a modal state you have to
hold.

Dodge & Burn (2026-08-13) is a layer kind, not a destructive tool. "How could a dodge/burn be done where it creates an empty layer and sets
the right blending mode and when you dodge/burn it simply applies gray
scale pixels that are blended into the image?" Exactly that: a pixel
layer preset to Soft Light, with Dodge painting white and Burn painting
black at their own strength (default 15, kept apart from the paint flow
because dodging wants a tenth of what painting wants). No 50% gray fill
and no duplicated pixel layer, which is what a layer editor needs because its
layer must be opaque for Soft Light to reach the picture. Here an
unpainted canvas is transparent and the blend already reads transparent
as "leave it alone", so the ALPHA is the neutral and the file carries
strokes and nothing else. It also stays non-destructive in a way the layer-editor
technique cannot: the strokes re-execute after a re-develop.

Phase 4 (layer FX) landed 2026-08-13: Shadow, Glow, Outline, Color
Overlay, Gradient Overlay, Bevel/Emboss and Blur, each a node on a
chain that runs between the layer's content and its blend. Every one is
a function of the layer's ALPHA, which is what lets a paint layer have
a shadow nobody drew.

Where this deliberately beats the precedent: a layer editor's layer styles
are one of each effect per layer, in a fixed order, behind a modal
dialog. These are nodes, so a layer can carry two glows at different
radii, an outline before a shadow reads differently from one after, and
every control is edited against the real photograph. Shadow and glow
share an implementation (a glow is a shadow with nowhere to fall) and
Blur is the existing heeler.blur node, which already switches between
Gaussian, Box and Motion, rather than a fourth copy of it.

Two pieces of engine care worth remembering. Spread sigma is HALF the
stated size, not the third a blur radius uses: the blur convention puts
the radius at the far tail, which is right for softening a picture and
wrong for spreading an edge, so a size-12 shadow has to be visible
twelve pixels out. The spread is then gained to saturation so it sits
solid against the shape and tapers outward, EXCEPT for the bevel, which
reads the slope of that plane as a surface normal and would light
nothing at all if handed a saturated one. And the outline uses a
chamfer distance transform rather than a blur, because an outline is a
band of constant width and a blur is a falloff; the bevel's light
vector is the opposite of the direction a shadow at the same angle
falls, which is the sign error the first pass had.

Phase 5 (pen and heal v2) landed 2026-08-13, which completes every
phase. The TEXT half of the original phase 5 stays rejected and bevel
shipped in phase 4, so what remained was the pen and content-aware
healing.

The pen is a bezier region kind: anchors carrying a symmetric out
handle, stored as anchors rather than as a flattened polygon so the
curve subdivides to whatever the render needs instead of freezing one
resolution's worth of points. Click for a corner, drag for a curve,
ENTER or a click on the first anchor closes it, ESCAPE gives up. The
frontend mirrors flatten_bezier for the marching ants so the outline on
screen is the shape the engine fills. A bug worth remembering: the
keydown effect that owns ENTER and ESCAPE was gated on the polygon
method alone, so the pen silently had no way to finish.

Heal v2 (Criminisi exemplar inpainting, reached by healing with NO
source picked) was built and then removed; see the roadmap section
below for why. Clone still
demands an ALT-click, and heal without one finds its own texture. Fill
order is confidence times isophote strength, which carries edges across
the hole before texture fills the rest, and the search is seeded
deterministically because a render that changed between two previews of
one graph would be a bug rather than a feature. Two bounds keep it
usable at full resolution: the boundary scan is limited to the hole's
bounding box (otherwise it is the whole frame per patch, billions of
pixels to remove a dust spot) and the source search to a window around
it, which is also better quality since the texture that matches a hole
is nearly always the texture beside it. v3, the Bugeau/Bertalmío/
Caselles/Sapiro unified energy from the owner's INRIA paper, adds coherence
and diffusion terms on top of exactly this substrate.

Gradient rework and the Outline removal, 2026-08-13.

Outline is GONE. "actually, this was a stupid idea. This kind of
thing only gets used on text and we decided to not add text." Correct,
and the same reasoning that rejected type applies to the effects that
exist to decorate it.

Gradient Overlay "doesn't seem to work" turned out to be a real
defect, though not the one it looked like: both gradient ops measured
t across the BUFFER, and at 1:1 the buffer is an ROI patch, so the
gradient restarted inside every patch and looked like a different
picture at every zoom. Both now take the roi rect (inject_roi hands it
to them alongside paint and clone) and measure against the frame. Note
for testing: an overlay only tints pixels the layer actually has, so on
a sparsely painted layer it is correctly almost invisible; that is the
layer-editor semantic and not a bug.

Gradients now share one stop machinery between simple and advanced
mode: `stops_of` builds a two-stop list from color_a/color_b when there
is no explicit list, so both modes are one code path with different
data and switching to ADVANCED writes the simple pair out rather than
changing the picture. Stops carry position, color, alpha and a
MIDPOINT, where the blend to the next stop reaches halfway, which is
the control that makes a gradient look right and the one the owner asked for
("could use a center weighting so it is not always an even split"). It
appears as a Center slider in simple mode and as a per-segment Falloff
in the stop editor, drawn as a diamond on the ramp the way layer editors
draw it.

Advanced mode is a DRILL-DOWN, not a dialog. The first attempt was a
popover and the owner rejected it: "the pop-up pushed up and got cut off by
the header bars. Maybe, what advanced does is a drill down. It uses the
right panel space but the layers are hidden and what it does is
basically takes over that view and each custom point, and it's
properties, has vertical space to be displayed (similar to layers) and
edited." He is right beyond the clipping: a popup has to guess a size
that fits somewhere, and a stop list grows. The drill-down has the
whole panel and the same shape as the stack it replaces, so a stop
reads like a layer, which is what it is. `artGradientEdit` holds the
layer being edited, cleared when that layer is deleted or the session
changes, and the panel keeps the BRUSH strip below it so the tools do
not vanish mid-edit. SIMPLE clears the stop list, handing the engine
back to the two-color params it never stopped carrying.

Two UI bugs fixed the same day. Context menus inside the library and
ribbon panels were drawing low by a growing margin, because `.ctx-menu`
is position:fixed but those panels carry `ui-zoom` (CSS zoom 1.15) and
zoom rescales fixed descendants too; they now portal to the body. And
the color picker measures at open time and flips above the swatch when
there is no room below, which there never is in the Finish toolbar.

2026-08-12: "I would just
like to offer a place for a user to do additional cleanup on a photo
without needing [a layer editor]." And the boundary, same day: the text tool is
rejected. "Heeler is photo editing, otherwise people will start asking
for tools to design flyers." Pixels in, pixels out. Nothing in this
feature renders type, and that stays true even when someone asks nicely.

## What this is

A fifth tab in the right panel: a layer-editor-style stack for photo
finishing. Paint, retouch, adjustment layers, layer FX, groups, masks,
opacity, blend modes. A tools menu plus a toolbar across the BOTTOM of
the viewer (the product decision; the left side stays clean).

What it is not: a design tool. No text, no shape libraries, no export
of anything but the photograph.

The differentiator worth saying out loud: nothing here ever flattens.
In a layer editor a healed patch is baked pixels, and re-editing exposure
afterward makes it stop matching. In Heeler every stroke is a live node
that re-executes after upstream changes, so retouching survives
re-develops. Slider-based RAW editors punt this workflow to other apps; Heeler keeps
it, on the graph, non-destructively.

## Architecture rules (the ones that must not bend)

1. **Layers are a view over the graph.** Same 1:1 rule as Develop. The
   whole stack lives inside one group node ("Layers") spliced after
   `curves` and before `output`, so Graph mode shows one box that opens
   up. Each layer inside is `content -> blend(base, layer, mask)`, and
   a layer group is a nested group node. Group nodes already exist,
   open, and publish params; this reuses all of it.

2. **Replayable data only, never stored pixels.** A paint layer is
   stroke data (RGBA color per stroke) rasterized at render resolution,
   exactly like brush masks today. Clone and heal are strokes plus
   source offsets. Fill and gradient are params. This keeps graphs
   small, keeps takes cheap, keeps undo sane, and keeps the ROI preview
   valid: strokes rasterize into the visible patch at 1:1. If a layer
   ever stores a pixel buffer, ROI, proxies, and export resolution all
   break at once.

3. **The stack runs display-referred.** Blend modes and FX are defined
   on display values; scene-linear multiply is nonsense. The stack sits
   after the profile and curves, which is already display-shaped.
   Debt to write down: when the wide-gamut working space lands,
   "display-referred" here becomes "output-referred through the working
   space"; the group boundary is the planned seam.

4. **Alpha becomes real.** ImageBuf is already RGBA; the art ops
   respect and produce alpha. Every layer FX is a derived operation on
   the layer's alpha (dilate, blur, offset, colorize, composite), which
   makes one coherent piece of engine work unlock the whole FX menu.

## Layer stack, blending, masks

- Blend node grows the standard mode set: normal, darken, multiply,
  color burn, lighten, screen, color dodge, overlay, soft light, hard
  light, difference, exclusion, hue, saturation, color, luminosity.
  Each mode gets a CPU op with a WGSL mirror only if profiling asks.
- Opacity per layer (blend node param, already exists).
- Masks: existing mask nodes wire into the blend's mask port. The mask
  editing tools (brush, range, radial, linear, selection) work as they
  do for develop layers.
- Groups: nested group node, with its own opacity, mode, mask, FX.
  A group composites its children to a buffer, then blends that.

## Tools (bottom toolbar + Tools menu)

- Selection: existing selection engine, as-is.
- Paint: brush engine extended from mask painting (scalar) to color
  painting (RGBA strokes with the same tips, flow, hardness, grain).
- Gradient: linear/radial fill into a layer, params only.
- Fill: solid color / selection-bounded fill.
- Clone Stamp: strokes plus a source offset; sampled from the composite
  below the layer, re-executed live.
- Healing Brush: see roadmap below. Ships in phases and is honestly
  named at each stage.
- Pen tool: paths for selections and masks (reuses the selection
  engine's region math). Paths never become stroked artwork; they make
  selections and masks.

Rejected: Text tool (and with it the character/paragraph dialog).

Toolbar: the Select button IS the shape picker. "the user should be
able to change selection types by clicking and hold the selection tool,
a popup menu extends vertically (above the toolbar)... Then you can
remove the option menu for selection type." Tap arms the tool, hold
(320ms) opens the seven methods above the bar, and the button then wears
that method's own glyph, so the row says what it will draw without a
second control saying it. Right-click and arrow keys open the same list,
since hold is a mouse-only gesture.

The selection mode (New / Add / Subtract / Intersect) stays visible at
all times and grays out when the tool is not armed, rather than
appearing and disappearing with it: a control that comes and goes takes
the row's layout with it and slides the next button under the cursor
mid-reach. Its labels are icons: two overlapping squares with the kept
part solid, the same sentence four ways.

Removed: the Polygon selection method, in both Develop's layer masks and
Finish. "I think Pen and Polygon are mostly the same, except Pen
allows you to make smooth tangents from a point. I don't see any good
reason to have Polygon."

There wasn't one. A pen anchor placed with a click carries no handles,
and a cubic whose control points sit on its endpoints is exactly a
straight line, so clicking pen anchors around a shape already drew the
polygon Polygon drew, to the bit. The only thing Polygon genuinely
guaranteed was that a corner could not accidentally become a curve, so
the pen absorbed that: a drag under three screen pixels leaves the
handles at zero. It also answers to double-click now, which is how
Polygon closed. The engine short-circuits a handleless segment to one
point rather than sixteen, so a pen path of pure corners costs what the
polygon it replaced cost.

## The Select menu

Its own top-level menu, holding everything that makes or reshapes a
selection. Select All / Deselect / Invert moved here out of Edit.

Smooth, Feather and Resize are one dialog with a different param name.
All three are numbers the selection mask node already carried, so no
engine work was needed: the slider drives the live param through the
live graph, the photograph under the dialog IS the preview, and Cancel
restores what was there.

Fill Selection makes a Fill layer wearing a copy of the selection as its
mask, using the toolbar color. Not pixels burned into the active layer:
the color stays a parameter and the shape stays geometry, so both are
editable tomorrow. A copy rather than a reference, because growing the
selection to make a second fill should not silently reshape the first.

Select by Luma Range, by Color Range and by Contrast are one engine
region kind (`Region::Range`) with a channel name, since they differ
only in which plane they read. Limits are stated in DISPLAY units, which
is the axis the dialog's histogram is drawn on: a range set against a
histogram has to mean what the histogram showed. Contrast reads local
contrast (the pixel against its own neighborhood), so a flat sky scores
low however bright it is and an edge scores high however dark.

### Manual entry, and limits that are real

App-wide rule, not a Finish one. "The sliders go from X to Y. A user
may be able to type in larger or smaller values (when possible, like for
Radius you should not be able to go below 0 but go as high as you
want)... Let's make this a whole pass on its own and set it as a rule in
the app."

A parameter has two ranges. The **control range** (`paramRange`, the
spec's min/max) is what the slider spans: where dragging feels right and
where the useful settings live. The **hard range** (`hardRange` in
state.ts, `hard_limits` in heeler-graph/spec.rs) is what a value may
actually be, and it is what survives a typed number.

The hard range is derived rather than declared per parameter, because
there is one honest rule to derive: a slider that starts at zero starts
there because below zero is meaningless (a radius, a kelvin, a size), and
a slider that already goes negative admits both directions. Everything
else is editorial and a typed number may exceed it.

Every numeric readout is a field. Past the slider's reach the number
turns gold and the handle parks at the end, so a pinned handle is never
mistaken for the value. Ops still clamp for their own correctness; the
rule only stops the graph throwing the number away before the op sees
it.

### A selection is not a mask

Arming the select tool used to grow a selection mask on the active
layer. "This is not expected... There are a lot of reasons I may be
using a selection that have nothing to do with masking. Like create a
selection then pick the paint tool and start painting and strokes only
appear within the selection."

So a selection belongs to the PICTURE, not to a layer: one
`heeler.selection_mask` node (`sel_doc`), made when the tool is first
armed, wired to nothing. What it goes on to do is then a separate
decision:

- **Clip the paint.** The engine's paint op takes an optional `clip`
  mask input, and the document selection is wired to a layer's paint
  node the first time you paint under a live selection. Wired rather
  than baked, so the strokes stay strokes and the stencil stays
  editable. The layer's own mask slot is untouched.
- **Become a mask, on request.** An icon in the layer row, offered only
  when there is a selection to make one from.

`Wire.toPort` gained "clip" alongside "mask" so a layer can carry both.

### Object selection: what the two papers actually buy

the owner supplied Xu et al., *Deep Interactive Object Selection* (CVPR 2016),
then Uijlings et al., *Selective Search for Object Recognition* (IJCV
2013). They point at two different products.

**Xu 2016 is not shippable here as it stands.** It is an FCN over a
VGG-derived backbone, and the interaction trick, encoding positive and
negative clicks as extra input channels holding distance-to-click maps,
only works because the network was TRAINED with clicks sampled that way.
Without the trained weights there is nothing to run, and with them
Heeler acquires: a neural inference runtime in the Rust engine, a
weights file that dwarfs the whole application, a GPU story, and a
license question about the training set. That is a dependency of a
different character from anything else in this codebase, and it buys one
menu item.

**Selective Search is the tractable half, and it is the better fit
anyway.** It is classical: a Felzenszwalb-Huttenlocher over-segmentation,
then greedy hierarchical merging of neighboring regions scored on
color, texture, size and fill. No training, no weights, no runtime; it
is arithmetic over the pixels the engine already holds, and it is
deterministic, which is a hard requirement here since the same graph has
to render the same picture every time.

The interaction it affords is better than the paper's own use of it.
Selective Search generates thousands of ranked proposals for a detector
to sift; an editor does not need proposals, it needs the ONE region
under the cursor. The merge tree is the useful artifact: click and take
the region containing the click, then widen or narrow the selection by
walking up or down that tree, which is a gesture with no equivalent in
a layer editor's object selection and is the sort of thing worth building
rather than cloning.

Two honest caveats. The segmentation is a similarity grouping, not an
object detector: it will happily hand back "the sunlit half of the dog"
because that is a coherent region, and it has no idea what a dog is.
And building the hierarchy over a full frame is seconds of work, so it
wants computing once per image at preview resolution and caching, which
is a different shape from every other op here.

Shipped as Region Select (v1), following the recommendation above:
Felzenszwalb-Huttenlocher segmentation in heeler-engine/segment.rs at a
capped 320px scale, cached per image and tolerance bucket in the Tauri
layer, deterministic throughout. The Tolerance slider maps onto the
segmenter's k on a log scale, which is the "widen/narrow" gesture: how
much counts as one region is a slider, not a fixed opinion. A click
returns a coverage grid; the frontend traces it into an ORDINARY path
region, so what lands in the mask is geometry, replayable and editable
like any hand-drawn selection, and the segmenter is only the pencil that
drew it. Modifier keys compose as everywhere else: SHIFT-click adds a
region, ALT removes one. The full merge-tree walk (click then scrub up
and down the hierarchy) remains open; the deep path (Xu 2016) remains
deliberately untaken.

## Image layers (2026-09-30)

2026-09-30: "some new finish layers. We already had file and
catalog for nodes. Expose these as layers, that a user can bring in an
image. They will need to have transform controls (which we already have
nodes for) so a user can interactively position on the canvas."

- Two kinds, `image` (content `heeler.file`) and `catalog_image`
  (content `heeler.catalog`, developed). The content's `space` is
  `display`, so the desktop plants the decode encoded into the stack's
  display space.
- The blend's `fit` is `place`: the picture's whole extent goes onto
  the layer transform's corners (`warp_bx`..`warp_y3`, the params
  Transform and Warp already write), in one premultiplied resample from
  the picture's own pixels (halved first when shown much smaller). The
  rest box is the picture fitted inside the frame, centered, written at
  creation from the picture's upright size (`image_layer_probe`). No box
  means the whole frame, as stretch.
- One transform, three seats: the canvas handles (corners per axis from
  the opposite corner, edges, turning rings outside the corners, Shift
  for proportions, Option from the center, snapping to the frame's
  center and edges), the typed fields in the layer panel and the same
  component on the blend node in the graph inspector. Enter commits,
  Escape restores the snapshot taken when the tool was picked up.
- `layer_on_frame` in the engine is the one placement: the blend, a
  layer clipped to a placed or moved layer (the base's placement rides
  to the clipped blend as `clip_place`, folded at serialization), and
  the export of a ticked layer all call it.
- The frame-shape rule (2026-09-30: "yes, fix the frame shape
  issue for Finish layers"). The corners are written as fractions of
  the frame they were placed on, and the blend records that frame's
  shape as `warp_aspect` (width over height). On a frame of another
  shape (a crop to another ratio, the crop turned a quarter, Paste
  Edits or a linked photograph of another shape) the layer's center,
  where its diagonals cross, stays at the same fraction of the frame,
  and its extent keeps its size in units of the frame's short side:
  x' = cx + (x - cx) * max(A0, 1) / max(A1, 1), y' = cy + (y - cy) *
  max(1, 1/A0) / max(1, 1/A1), box and corners alike. So a square stays
  square, angles and warps are kept in pixels, a crop that only trims
  the long side leaves the picture the same size in pixels, and a
  corner logo stays in its corner. Why this and not photograph pixels:
  a placed picture is laid on the frame, not on the scene, so it should
  neither turn with the crop nor land off the frame on a photograph of
  another size; and why the short side: it is the side a crop to a
  squarer ratio leaves alone, and a landscape turned portrait keeps the
  same short side in pixels.
- One arithmetic, three readers: the engine's `placement_on_frame`
  (ops.rs) runs ahead of `layer_on_frame` in the blend, in the export's
  layer placement and on the mask, and a clipped blend's `clip_place`
  carries the base's stamp as a thirteenth number; the frontend's
  `reframeQuad` (imagelayers.ts) runs in `placedOnFrame`, which
  `layerBox` and `layerQuad` read, so the handles, the typed fields and
  the drag preview sit where the render draws. The frame's shape comes
  from the viewer (`noteFrameAspect`, noted while it renders). Every
  write of a placed layer's quad (`art_set_quad`, a new layer, a new
  source) stamps the frame it was made on; a crop writes nothing to the
  layer, so undo across a crop is the crop's own undo.
- The rule per layer kind. Placed pictures (`image`, `catalog_image`)
  follow the frame-shape rule. Painted content (Pixel strokes, Clone
  and Heal, Dodge & Burn, the Fill brush's layer) is stroke data on the
  photograph, stored as fractions of the frame the stack sees, and
  belongs to the scene rather than the frame, so the logo's rule is the
  wrong one for it: it must not keep a shape of its own against the
  photograph it was painted on. Masks are the photograph's, measured on
  the frame they gate like every Develop mask, and this rule does not
  touch them (see Masks and the crop, below). Fill, Gradient (a linear gradient already runs corner to corner
  in pixels, a radial one is the frame's own ellipse) and the
  adjustment layers fill whatever frame there is. A Transform or Warp
  on any layer that is not a placed picture carries no stamp and
  travels with its content, in fractions of the frame, as before. There
  is no text or shape layer. Painted content follows the photograph
  through a re-crop: see The stroke remap, below (the known limit that
  stood here is closed).
- Masks and the crop (2026-09-30). A layer mask read the image source
  ahead of the crop, so behind a crop it came out the photograph's size
  while its blend worked on the crop's, and the blend dropped a mask of
  another size: every masked Finish layer covered the whole frame after
  a crop, and so did a Develop layer made before the first crop. Now a
  mask reads the crop (`frameFeed`, state.ts), the first crop moves the
  masks already reading the source onto itself in the same undo step
  (`masksReadTheFrame`), and the desktop reads every graph by the same
  rule on the way in (`masks_read_the_frame`, lib.rs: a wire from the
  image source into a node's "in" moves to the render's user crop when
  everything the node gates sits behind that crop), which covers saved
  graphs, Paste Edits, presets and hand wiring. Smart and object mattes
  and the depth plane then follow the crop the way the picture does,
  since the planting and the 1:1 slice measure a mask by what it reads.
  Brush strokes and selection regions are fractions of the frame and
  follow the photograph through every later crop change (The stroke
  remap, below). The engine's
  rule for a mask it still cannot place (`mask_on_frame`, ops.rs, in
  the blend, the per-node gate in the executor and a ticked layer's
  folded alpha): a mask buffer of another size than its frame closes
  the layer, which shows nowhere, and is logged at WARN naming the node
  and the two sizes; never dropped, since dropped means everywhere.
  Tests: src-tauri/src/finish_mask_crop.rs over the reducer's own
  graphs (src/__tests__/finishmaskcrop.test.ts).
- Masks and the rest of the geometry (2026-09-30). Reading the crop
  still put a mask on the frame BEFORE the lens correction, the Grid
  Warp and the Shape Warp, while its layer lands on the frame after
  them: under a warp or a lens distortion the mask sat off its layer by
  the warp. The frame is now the LAST geometry node on the picture's
  chain (crop, then lens correction, then Grid Warp, then Shape Warp:
  `frameGeometry` and `frameFeed`, state.ts; `is_frame_geometry` and
  `upstream_crops`, lib.rs). Building any of them moves the masks on in
  the same undo step (`masksReadTheFrame`, from the source or from
  earlier geometry, to the last geometry every gate sits behind, never
  back up the chain: a mask gating the lens correction reads the crop),
  and the desktop applies the same rule to every graph it reads, so
  graphs saved reading the crop or the source are corrected on load.
  The rule per mask kind, all reading that one node:
  - Drawn on screen (brush strokes, selection regions and polish
    strokes, radial and linear shapes): drawn on the warped picture the
    viewer shows, stored in fractions of that frame, and read there.
  - Computed from the picture (luminance, color, hue and tone ranges):
    computed on the warped picture, so they follow the content.
  - Planted rasters made on the photograph (the Smart mask's matte, an
    Object mask, a selection's refined or baked base, a depth plane
    from the file's own pass): bent by the same geometry on the way to
    the mask (`conform_rasters_to_geometry`), the lens correction's
    distortion included since this change (`lens_geometry_buf`: the
    distortion only, never its vignette or fringe terms, which would
    shade or split a matte). The pickers that read the photograph
    (`original_with_geometry`) and the Smart click's walk back to the
    photograph (`sourceMapOf`, pickgeometry.ts) take the lens the same
    way.
  - Depth masks: the Depth Map is seated after the geometry, so its
    plane is already on the warped frame and the mask reads it there.
  The stroke remap is unchanged (a crop change carries frame fractions,
  and the warps ride the same frame), and the 1:1 slice needs no new
  case: it is cut after the last geometry (`roi_feed`), a mask reading
  that node is whole-frame and takes its `mask_crop` at the patch
  consumer as before. Tests: the warp half of finish_mask_crop.rs (a
  masked Finish layer, a Develop brush layer, a Finish brush mask, a
  Smart mask and a depth mask, each under a lens distortion, a Grid
  Warp and a Shape Warp after three crops, at export, Fit and 1:1, as
  built, as saved reading the crop and as saved reading the source)
  over src/__tests__/maskafterwarp.test.ts's graphs.
- Subject's aim (2026-09-30). Without the matte model, Subject falls
  back to SAM with one prompt, which aimed at the middle of the
  uncropped photograph. The panel now stores the middle of the frame on
  screen, carried to the photograph like a click (`subjectAim`,
  smartpoints.ts), in the Smart node's own `aim` text param when
  Subject is chosen; the compute prompts there (`subject_prompt_points`,
  lib.rs). The clicks stay in `prompts`, untouched, so switching back to
  Click finds them. The recipe key reads the mode (`smart_recipe_prompts`):
  Click keys by its clicks, Subject by its aim, Sky by nothing, so a
  one-shot raster computed on a node that kept clicks is found again
  by the render, the badge and Refine (it was filed under no clicks and
  looked for under the kept ones). The document selection's Subject
  asks with the same aim; its baked base is keyed by the answer.
- Graphs saved before the rule carry no stamp and read the corners as
  plain fractions, stretched to a new shape, until the layer is moved,
  sized or turned once. No migration: there were no customers (image
  layers landed the same day).

### The stroke remap (done, 2026-09-30)

2026-09-30: "yes, do the stroke remap for 26.4". The plan's test,
built: a dot painted on a feature, the photograph cropped by a third
on each axis and turned 5 degrees; the dot stays on the feature at
Fit, on the 1:1 slice and in the export, and undo restores the crop
and the painting together.

- The approach: remap on the crop change, not storage in the
  photograph's coordinates. Every stroke, region and placed mask shape
  stays stored in fractions of the frame the stack sees; every edit
  that changes the crop's geometry (its rectangle, the stretch dial,
  the angle, switching Geometry off, Esc out of the crop tool) carries
  them onto the new frame in the same reducer step, so the same undo
  snapshot holds both (followCrop in state.ts over framemap.ts).
- Why remap. Every reader already speaks frame fractions: the engine's
  ops, the 1:1 slice's ROI splice, the export, the overlays that draw
  and hit-test strokes and outlines, the magnetic lasso, the polish
  brush, the assistant's view. Photograph coordinates would need a
  mapping in each, on both sides of the bridge, each a place for the
  preview and the render to disagree. The remap is one seat, and it
  cannot drift: the map between two crops is an exact affine (the crop
  op's own walk, frameToSource, checked against pickgeometry's
  independent reading of it), composed in doubles with nothing rounded
  or clamped, so a thousand re-crops land where one does and a crop
  dragged in forty moves lands where one move does (both tested to
  1e-12). Undo needs no inverse, since the crop and the moved painting
  are one snapshot; and a graph saved before this reads exactly as it
  did, since the stored format is unchanged: no version field, no
  migration.
- The photograph's shape. A turn is a rotation in pixels, so the map
  needs the aspect of the photograph the crop reads: the viewer notes
  the file's oriented size (noteSourceAspect, the size the crop tool's
  ratio lock already trusts); before that, the frame the viewer last
  showed undone by its crop; before that, 3:2, logged. A crop change
  that does not turn needs no aspect at all.
- Which edits follow. Any command that changes the effective crop of
  the photograph on screen, except the ones that land a whole graph
  (load, Takes, undo and redo, Paste Edits, presets, resets, link
  bookkeeping: CROP_LANDINGS), whose painting was written on the crop
  it came with. A node the command wrote itself is left alone. The
  crop tool's opened frame (cropPreviewGraph) remaps the same way for
  its render, so the painting sits on the scene while the rectangle is
  chosen.
- Lengths. A crop never rescales pixels (the frame is a window: one
  frame pixel is one photograph pixel), so a length stored as a share
  of the frame's short side (a stroke's radius, a brush region's
  width, a selection's Grow, Smooth and Feather, a lamp's range) is
  multiplied by the old short side over the new one and keeps its size
  on the photograph. The stretch dial is the one crop control that
  changes scale, differently per axis; a length takes the geometric
  mean (the square root of the map's determinant), the size of a
  circle of the same area. Relative lengths (a stroke's blur strength,
  a radial's feather, which is measured in the shape's own units)
  need nothing.
- The rule per kind. On the scene, remapped: Pixel, clone and heal
  strokes (points, radius, and the clone's source offset src_dx,
  src_dy, which is a vector: it turns with the crop and is not moved
  by it), Dodge & Burn, the Fill brush's mask strokes (the fill reruns
  for the new frame because its strokes changed), Develop and Finish
  brush masks, every selection region (freehand, magnetic and pen
  paths, samples, brush regions, a key's sample point, pen handles as
  vectors; a rectangle or ellipse marquee stays a marquee while the
  map keeps the frame's axes and becomes the same outline as a
  four-corner path, or a four-arc pen path within 0.03% of the oval's
  radius, once the crop turns), a stroke's baked selection clip, Polish
  strokes not yet applied, radial masks (center as a point, axes
  through the map in the short-side units the engine measures them
  in, so size, shape and turn keep; a radial placed before shapes
  existed in its own plain-fraction units), linear masks (the level
  lines of the old gradient read in the new frame: angle, position and
  span recomputed exactly), Shape Warp shapes (as the radial, with the
  move as a vector; twist and pinch are the shape's own), Grid Warp
  (below), Depth Lighting's and Lens Flare's lamps (position, range)
  and sun directions (the key light's azimuth and each directional
  light's, turned with the picture), and the Transform or Warp quad of
  any layer that is not a placed picture (the homography conjugated by
  the crop's map, on the new box's corners). On the frame, untouched:
  placed pictures (Image layers keep the frame-shape rule above), Fill
  and Gradient content and adjustment layers (they fill whatever frame
  there is), the vignette, grain, Lens Correction, and a Transform
  utility node placed by hand in the graph. Smart, object and depth
  masks already follow their subject (the rasters are computed on the
  photograph and planted through the crop, b72e9c3a); their click
  prompts are not remapped, since the model reads them on the
  uncropped photograph.
- Grid Warp. The grid is the frame's lattice (its lines run 0 to 1),
  so a crop cannot move its vertices without resampling the field,
  which would drift a little with every re-crop. Instead the node
  carries a `lattice` (six numbers: the affine from the frame to the
  grid's own fractions, empty for the frame's own grid) and the crop's
  inverse map composes into it; the engine reads the displacement
  through it (GridMesh::field), exactly, through any number of
  re-crops. The tool's handles belong to the frame, so meshFromNode
  hands the tool the same warp resampled onto the frame's grid, and
  its first write stores that grid and clears the lattice (the one
  resample, at the moment the grid is edited).
- Old graphs. Nothing to migrate: strokes were and are fractions of
  the frame under the crop they were saved with. A graph saved before
  this renders exactly as it did, and its next crop change carries its
  painting from the crop it was saved under.
- Paste Edits. Strokes are the photograph's own work, and a paste
  brings the source's whole graph with the source's crop, so the
  pasted strokes land at the same place in the frame, as before. The
  target's own Grid Warp and Shape Warp, which a paste keeps, are now
  carried from the target's crop onto the pasted one (when the
  target's shape is known this session; otherwise their numbers are
  kept as they are, as before).
- Clamps. center_x, center_y (radial) and position (linear) may now be
  negative (the spec's slider ranges start at -1): a subject cropped
  out of the frame carries its oval with it, and a zero floor would
  have pinned it to the edge in the render.
- Known limits. Lens Correction runs after the crop, so with a
  distortion set the frame's content is a warped window and the remap
  is exact at its center and off by the difference in distortion
  elsewhere (a crop change moves the distortion's center). Under the
  stretch dial a turned radial or Shape Warp shape keeps its axes'
  images and drops the shear the stretch adds. A brush tip's texture
  is anchored to frame pixels and shifts under the stroke.
- Tests. src/__tests__/strokeremap.test.ts (the reducer: every kind's
  points name the same place on the photograph, brush sizes, the clone
  offset's turn, radial and linear exactness, lamps, Shape Warp, Grid
  Warp's lattice and its fold on edit, a moved Pixel layer, placed
  pictures untouched, undo and redo, a drag in forty moves, Esc,
  Geometry switched off, the crop tool's opened frame, an old graph,
  Paste Edits), src-tauri/src/stroke_remap.rs (pixels: each kind's
  rendered work after the crop is its work before the crop carried
  through the crop, at Fit, on the 1:1 slice and in the export),
  ops_warp.rs a_lattice_carries_the_warp_onto_a_moved_frame.

## Finish warps (2026-09-30)

2026-09-30: "build both, A for image layers and B for the photo".
A Grid Warp and a Shape Warp on a Finish layer, two ways: A, an image
layer's own warp, bending its picture before it is placed; B, a Warp
layer, bending everything below it and shown through its own mask
(his use case: scale a head with a Shape Warp, mask to the head, the
background stays). The Develop Grid Warp and Shape Warp are unchanged.

- The mask travels with the warp (2026-09-30, after the first cut
  clipped the enlarged head to its old outline: "My intent to mask
  warp layers was to do something like warp a subject (like the
  Lemur's head). Then the mask would be used to removed warped pixels
  that were near the subject"). A Warp layer is lerp(below,
  warp(below), warp(mask)): build_graph (warp_layer_masks_travel)
  splices `heeler.layer_warp_mask` between the mask and the blend of
  any blend whose top is a frame-space `heeler.layer_warp` (through
  its effects), with the warp node's own params, so the mask takes
  the same field, passes, lattice and Edges rule (ops_warp.rs
  layer_warp_mask). Spliced on the engine graph only: the UI graph,
  the mask eye and the brush keep the mask as painted, unwarped. A
  moving warp already renders whole at 1:1, so the slice needs no
  extra reach. The lattice now solves per pixel any cell whose middle
  the bilinear guess misses by over a quarter source pixel (`rough`):
  the squeezed ring round an enlarged shape was several pixels off on
  the export, exact at Fit, and the traveling mask now shows it.

- One engine node, `heeler.layer_warp` (ops_warp.rs layer_warp): the
  Develop warps' own params under their own names (`cols`, `rows`,
  `cols_u`, `rows_v`, `mesh`, `lattice`, `shapes`, `edges`), read by
  GridMesh::from_node and ShapeWarp::from_node, through the same
  resampler, grid first; plus `space` (`frame` or `picture`) and
  `room`. One set of gizmos and sections edits it: GridWarpControls
  and ShapeWarpControls take a `target` (the node's id; null is the
  photograph's own warp), aimedDispatch stamps it on every write, and
  the reducer's grid_warp_* and shape_warp_* commands resolve it
  (warpCmdTarget: the command's own, else `State.warpTarget`, which
  arming the tool sets). The canvas overlays follow warpTarget. A
  Finish warp is never built by a write; it exists because its layer
  does. The node's face in the graph inspector is the same component
  (finishwarp.tsx FinishWarpControls).
- B, the Warp layer: ART_KINDS `warp`, the node as the layer's content
  in `frame` space. Content reads what is below it (artWires), so it
  warps the photograph and every layer under it, image layers
  included, in whatever order the user arranges ("a user will
  have to use some common sense when applying a warp layer over an
  image layer, and order layers correctly": no guard on order). The
  blend lays it over the same through the layer's mask, opacity and
  mode. Its grid and shapes describe the scene, so the crop remap
  carries them (framemap.ts remapNode: shapes as Shape Warp's, the
  grid through its lattice).
- Clipping is allowed and not special-cased: a clipped Warp layer
  warps what is below it and shows only inside the base layer's
  outline, which the panel says in one line. No refusal, no dialog.
- A, an image layer's own warp: `art_layer_warp` puts the node FIRST
  on the layer's effect chain, `space` `picture`, `edges`
  `transparent`. The stack walks (artLayers, artGroupMembers) treat a
  picture warp as a chain link (isChainFx), so everything that carries
  effects carries it: Duplicate, grouping, ungrouping, copy and paste,
  takes, saving. Effects never move ahead of it (art_fx_move). The
  field is in the picture's fractions, so it rides every transform;
  the crop remap leaves it alone.
- The room. A pull must be able to carry the picture past its own
  rectangle, so the node pads the picture with `room` percent of
  transparent margin per side (room_px, the one rounding) and warps
  premultiplied (a logo's clear surround never darkens its edge). The
  blend must know or it would squeeze the margin onto the corners:
  bridge.ts placePads folds `place_pad` (the room) onto a placed blend
  whose chain holds an enabled picture warp, in the serialized graph
  only, and layer_on_frame grows the quad by the margin through the
  box's own homography (Quad::padded), recovering the picture's size
  from the padded one (unpadded_len). A layer clipped to it carries the
  room as clip_place's fourteenth number. The Transform drag preview
  places the padded raster the same way (previewSourceBox).
- The lattice. A picture's own warp solves the inverse every 2 pixels
  (PICTURE_LATTICE) rather than 8: a hard, transparent outline shows
  the bilinear lattice's wobble where a pull eases off. A strong pull
  with a narrow feather still folds the field; the guide says to widen
  the feather.
- The gizmos on a picture: warpspace.ts carries the grid's handles and
  lines, the shape rings and the pointer between the picture's
  fractions and the frame's through the layer's rest box and corners
  (the same homography the engine places with). Shape Warp's Position
  gizmo works on the frame, so the picked shape's center, radius and
  turn go through the placement's local similarity (exact for a moved,
  sized and turned layer; the nearest likeness under skew or
  distort). The frame-wide drag preview canvas is the frame warps'
  picture; a picture's own warp shows its handles live and the render
  on release. Twist and Pinch on a Finish warp work while its tool is
  up (the preview they lean on without the tool is the Develop one).
- The 1:1 slice. A Finish warp that moves anything reads across the
  frame, and its field is in fractions of the whole frame, so a graph
  with one after the cut renders the whole frame sharp
  (inject_roi_sized, layer_warp_moves), the answer a File layer and a
  far-reaching clone already get; the slice then IS the export. A warp
  at rest slices like any node, within 1e-5 of the export. Growing
  the slice by the warp's reach instead is possible (the shapes'
  boxes plus their pulls) and is not done: the whole frame is exact
  and simple, and a Warp layer is a finishing move, not a live dial.
- Pro: the Finish tab's rule. art_* and grid_warp_* / shape_warp_*
  commands are refused on a free copy whatever their target; the node
  type is in PRO_NODE_TYPES for pastes and presets; a free copy views,
  renders and exports.
- Tests. src/__tests__/finishwarps.test.tsx (both graphs, targets,
  retargeting, the crop remap and its undo, clipping, Duplicate, save
  and reload, Paste Edits, takes, Escape, one undo step per canvas
  drag on a picture and on a Warp layer, handles drawn on a distorted
  layer's corners, the drag preview's box, the tier gate, and the
  pixel fixture), src-tauri/src/finish_warps.rs (pixels from the
  reducer's graphs: the picture's enlarged end past its rectangle as
  it arrived, moved and distorted, the photograph untouched away from
  it, Fit against export; a Warp layer changing only where its
  carried mask went, the head grown past its outline, at Fit and
  export, whole at 1:1, a still one's slice equal to the
  export within 1e-5, the crop keeping it on the scene), ops_warp.rs
  (the room's rounding both ways, the picture past its rectangle, a
  still picture in its room, frame space equal to the Develop grid
  then shapes, the margin placed outside the corners).

### Compact, one type at a time (2026-09-30)

2026-09-30: "Warp layer is too big, too much stack and redundant
controls. This layer should by default look like a pixel layer (in
size), with an additional button to go into edit mode which then
expands to show the controls. The first control is type: Either GRID
or SHAPES."

- The Type. `kind` on the node (`auto`, `grid`, `shapes`; heeler-graph
  spec.rs). One type applies: ops_warp.rs layer_warp_applied puts the
  other at rest in the render (the grid at a 1x1 rest mesh, the shapes
  an empty list) and leaves it stored, so switching back restores it.
  `auto` (every warp made before the Type, and a new one until its
  first edit) applies the shapes when the list has any, the grid
  otherwise (layer_warp_uses_shapes; state.ts warpKindOf reads the same
  rule, so the panel names what renders). The first grid_warp_* or
  shape_warp_* write on an `auto` warp pins that type in the same step
  (pinnedWarpKind), so removing the last shape cannot flip the Type
  under the user. `art_warp_kind` sets it, one undo step; in edit mode
  it swaps the tool to the new type's. layer_warp_moves in the desktop
  counts only the applied type. This replaces "grid first, then
  shapes" above: two Warp layers stack for both.
- Edit mode is the warp's own tool in hand and aimed at it
  (warpEditing: tool gridwarp or shapewarp, warpTarget the node), so
  one warp at a time, and every existing way the tool goes down closes
  it: the button again (set_tool's own toggle), Enter (tool.apply, which
  now names the target; before, it moved the tool to the photograph's
  own warp), another layer, another tool, the warp's removal. Escape is
  the tool's revert. set_tool refuses a tool of the type a warp has not
  chosen, and an undo or redo that changes the type under the tool puts
  it down.
- The row. A Warp layer's collapsed row is a Pixel layer's row; the
  adjustment layers' export mark in the name row is the only
  difference, in kind, not size. The Edit warp button is gone (2026-09-30: "I think we can remove the EDIT WARP button, when the
  layer is expanded it should just turn on warp editing. Turn warp
  editing off when collapsed"): opening the settings sends
  `art_warp_edit` on (the chevron through toggleLayerSettings; with
  Expand settings on select, the reducer on a select_art_layer or
  art_add_layer that makes a top-level Warp layer active; a group
  member through its own chevron), closing them sends it off (a
  commit). `art_warp_edit` is idempotent, unlike the tool's toggle.
  Enter and Escape put the tool down and leave the settings open;
  opening them again re-arms. A photograph or Take switch closes the
  Warp layers' settings in the panel, and leaving Finish
  (artToolbarVisible going false) puts a Finish warp's tool down.
  Expanded, FinishWarpControls
  shows Type (SourceMenuRow, MenuField at the regular size, fitted to
  its own two labels), an image layer's Room, then the chosen type's
  section with its arm chip and lines rows off. Removed from the panel:
  the two arm chips (Warp handles, Place shapes: opening the settings
  is edit mode), the second type's section, the GRID and SHAPES
  kickers, the lines' color (seated in the Develop warp sections, one
  setting for every overlay) and thickness (Preferences), and the line
  on what a Warp layer bends (the chevron's hint says it). Opacity,
  blend and mask were never in it and stay on the row.
- An image layer's own warp: the transform row's Warp button adds it
  straight into edit mode (`art_layer_warp` with `edit`); with one, the
  button is Edit warp and Remove Warp sits beside it. It keeps the
  button: opening an image layer opens its picture and transform,
  which is not a warp edit. The graph inspector shows the same
  component with its own Edit warp button (no chevron there).
  art_layer_warp is an undo step now (it was missing from UNDOABLE).
- Tests: src/__tests__/finishwarpcompact.test.tsx; finish_warps.rs
  a_warp_layer_applies_only_its_chosen_type over the fixture's
  warp_layer_grid_chosen and warp_layer_both_unchosen; ops_warp.rs
  a_frame_warp_applies_only_its_chosen_type.

## Adjustment layers

All existing engine ops, restacked: Levels, White Balance, Saturation
and Vibrance, Curves, Exposure (with highlights/shadows), Invert,
Color Balance, Black & White. One new small op: Gradient Map (luma
through a two-or-more-stop color ramp). An adjustment layer is the op
node applied to the composite below, through the layer's mask, with
the blend node's opacity/mode. No new UI editors: the Develop editors
render in the layer's inspector.

## Layer FX

Derived from the layer's alpha, in this priority order:

- Drop / inner shadow (alpha blur + offset + colorize, inner = inverted)
- Outer / inner glow (alpha blur, no offset)
- Outline (alpha dilate minus alpha)
- Color Overlay, Gradient Overlay
- Blur with a type switch: Gaussian, Box, Motion (engine has Gaussian
  today; Box is trivial; Motion is a directional kernel)
- Bevel / Emboss: kept because the owner listed it, but LAST among FX. Its
  main use everywhere else is styling type, and type is rejected, so it
  earns its slot only after everything above ships.

## Healing: content-aware fill, built and removed (2026-08-19)

Content-aware fill shipped as heal-with-no-source and was taken out
again. Recorded here rather than deleted, because the reasoning is worth
more than the code was.

the owner tested it against a reference editor's inpainting on a real photograph. It was
not close. The standard he set: "I would not want to include a feature
just to say 'it has inpainting' if it wasn't in the same ballpark as
[the other editor]." He also reaches for healing over inpainting in that editor
anyway, and quality fell off sharply as the brush grew, which is the
signature of patches being stamped hard with no blending at the seams.

Closing that gap was never mainly a search problem. It wanted seam
blending, coarse-to-fine synthesis of the fill itself rather than only of
the search, and probably a gradient-domain pass at the end: weeks of work
with a ceiling still well under a competitor who has already done it
well.

Three things went with the removal. The only live patent question in the
codebase went with it, since Criminisi and PatchMatch were the sole
flagged lineage (see docs/research-ip-review.md). Heal-with-a-source is
untouched and is the tool actually wanted. And the differentiator was
never this: it is that repairs are replayable instructions in the graph,
so a heal survives an upstream develop change instead of going stale,
which slider-based RAW editors cannot say because they have no pixel
layers, and layer editors cannot say because they bake.

If content-aware ever returns it arrives because there is an approach
that clears the reference editor's bar, not because a roadmap said v2. The search
work done in the meantime is on the `inpaint-search` branch with
docs/spec-inpaint-search.md, which is worth reading for the measurements
even though the feature went.

## Phases

Each ships alone, tests first-class at every step:

1. **Foundation.** Layers tab, stack UI over a blend-node subgraph in
   one group, RGBA paint layers, opacity, blend-mode set, per-layer
   masks, groups. Bottom toolbar with Selection and Paint.
2. **Retouch.** Clone Stamp, Heal v1, Fill, Gradient. This phase alone
   is the "don't need a layer editor" promise for most photographs.
3. **Adjustment layers** plus the Gradient Map op.
4. **Alpha FX.** Shadow, glow, outline, color/gradient overlay, blur
   type switch. Bevel/emboss last within the phase.
5. **Pen paths and Heal v2** (exemplar synthesis), then v3 when v2's
   limits actually bite in the field.

Sizing: phase 1 is on the order of the curves + media-server work
combined; 2 through 4 each comparable or smaller; heal v2 is the
largest single algorithm in phase 5.

## Testing

- Engine: per-op unit tests (blend modes against reference formulas,
  FX alpha math, gradient map stops); ROI equivalence tests extended to
  art-stack graphs (patch == full render cropped, through paint and
  clone layers).
- Frontend: reducer tests for stack operations (add, reorder, group,
  mask, opacity, mode), mock-bridge fidelity for any new persistence.
- Healing v2: golden-image tests on synthetic textures (the classic
  checkerboard-with-hole and brick-wall cases) with perceptual deltas,
  not pixel equality.

## Open questions

- Sampling scope for clone/heal: composite-below only, or allow "all
  layers" and "current layer" like a layer editor? (Lean: composite-below only in
  v1; it is the honest graph semantics.)
- Does the Layers group render into Before/After as "after" only?
  (Lean: yes; before is the develop-only frame.)
- Keyboard map for tool switching at the bottom bar.
