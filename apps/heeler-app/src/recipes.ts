// Layer-stack recipes, built as nodes.
//
// The owner gave three of these out of the layer editors and said what
// they are for: "Huge as in what makes Heeler stand out... under the hood
// its adding the necessary node utilities for the Graph mode to the graph
// and then adding a user-facing abstraction in the Develop mode."
//
// So each recipe is a real subgraph. Turn the category on in Develop and
// these nodes appear in Graph mode, wired the way the layer stack was, and
// you can take them apart or wire something else into the middle. The
// Develop controls are the two or three parameters worth reaching for
// without going to the graph.
//
// Two things hold throughout.
//
// A wire that forks IS the duplicate layer. None of these recipes needs a
// "copy" node, because a layer stack's duplicate and a graph's fan-out are
// the same idea drawn differently: the middle and bottom copies in the
// owner's first recipe are one output read twice.
//
// And every block starts with To Display and ends with To Scene. Overlay
// and Vivid Light are defined on 0-to-1 display values and this engine is
// scene-linear, so the numbers from the tutorials only mean what they say
// inside that pair. the product decision, and the better one: "Adding more
// nodes means adding more capabilities rather than rewiring something
// unnatural to how the engine was working just to match [a layer editor]."

import { producesMask, takesTwoImages } from "./nodes";
import type { Category, NodeCard, Wire } from "./state";

// The UI's wires speak in / in2 / mask, and the bridge maps those to each
// node type's real port names on the way to the engine. So a blend's base
// is "in" here and its top layer is "in2", which is what every other
// two-input node in this app already does.

/** A node this module owns, before it becomes a NodeCard. */
interface Piece {
  id: string;
  type: string;
  name: string;
  params?: Record<string, number>;
  textParams?: Record<string, string>;
  x: number;
  y: number;
  /** Most pieces take a mask. A color-space conversion does not: the
   * registry declares no mask port on the luma/color pair, and a port
   * the UI draws but the engine has never heard of is a wire that goes
   * quietly nowhere. */
  maskIn?: boolean;
}

export type Recipe = "denoise" | "sky";

/** Which recipe owns which node ids.
 *
 * Prefixes rather than a list, so a node added to a recipe later does not
 * have to be registered in a second place to be found again.
 */
export const RECIPE_PREFIX: Record<Recipe, string> = {
  denoise: "dn_",
  sky: "sky_",
};

/** The two recipes that became layer tools (heeler.sharpening and
 * heeler.skin_soften, 2026-09-03: the owner, "You would always
 * smooth or sharpen via layers and masking"). Their blocks still
 * exist in saved graphs and presets; migrateRecipeBlocks turns each
 * into its node, and until then the ids keep the recipe prefix like
 * every recipe's.*/
export const LEGACY_RECIPE_PREFIX = { sharpen: "sharp_", skin: "skin_" } as const;

/** Whether an id belongs to some recipe's block.
 *
 * Two things need to ask. Splicing needs to know which block is first in
 * the chain, and the Develop panel needs to not mistake a recipe's node
 * for the main chain's node of the same type: the noise reduction block
 * contains two Denoise nodes, and Detail's Smoothing slider must go on
 * driving the one in the chain. */
export const isRecipeNode = (id: string): boolean =>
  Object.values(RECIPE_PREFIX).some((p) => id.startsWith(p)) ||
  Object.values(LEGACY_RECIPE_PREFIX).some((p) => id.startsWith(p));

/** Whether a recipe is on: its block is in the graph and live. There is
 * no flag beside the graph saying so (there was one, and every door
 * that swapped the graph had to remember to update it); the graph is
 * the record. */
export function recipeIsOn(recipe: Recipe, nodes: NodeCard[]): boolean {
  return nodes.some((n) => n.id.startsWith(RECIPE_PREFIX[recipe]) && n.enabled);
}

export function recipeNodeIds(recipe: Recipe, nodes: NodeCard[]): string[] {
  return nodes.filter((n) => n.id.startsWith(RECIPE_PREFIX[recipe])).map((n) => n.id);
}

const CAT: Category = "detail";

function piece(
  id: string,
  type: string,
  name: string,
  x: number,
  y: number,
  params?: Record<string, number>,
  textParams?: Record<string, string>,
  maskIn = true,
): Piece {
  return { id, type, name, params, textParams, x, y, maskIn };
}

/** The owner's first recipe, and his second, which share three of their
* nodes.
 *
 * Vivid: "Duplicate the image 3 times... Top image: invert, change the
 * blend mode to Vivid light, Apply Gaussian Blur... Select the Top image
 * and the middle image and group them, then on the group node the blend
 * mode is set to overlay."
 *
 * Hi Pass: "Duplicate the image. With the duplicated image: completely
 * desaturate, change the blend mode to overlay, apply the high pass
 * filter."
 *
 * Both branches are built whichever mode is chosen, and the unused one is
 * left disabled and unwired. Switching modes then costs nothing and keeps
 * the radius you had dialed into the other one, which is the same promise
 * the category toggle makes.
 */
/** The value a recipe node's param ships at, for Reset. Derived from
 * the pieces themselves so it cannot drift: the section Reset used to
 * fall back to the node TYPE's default, which for the intensity
 * blends meant 100 where the recipe ships 50 ("RESET is
 * setting intensity to 100 and not 50").*/
export function recipeParamDefault(nodeId: string, param: string): number | undefined {
  for (const p of [...denoisePieces(), ...skyPieces()]) {
    if (p.id === nodeId && p.params && param in p.params) {
      return p.params[param];
    }
  }
  return undefined;
}

/** The luma/color split, as a block.
 *
 * The feature research asked for exactly this shape: "split luma/chroma
 * -> denoise(luma, strength A) -> denoise(chroma, strength B) -> join".
 * It is the Denoise node used twice, once on each half, which is the
 * point: it is not a secret better algorithm, it is the same honest
 * kernel wired into a pipeline you can open.
 *
 * Chroma noise is blobby and low frequency and the eye forgives smoothing
 * it; luma noise sits right next to detail and the eye does not. So the
 * two halves start at different strengths, and the whole reason the block
 * exists is that they can.
 */
export function denoisePieces(): Piece[] {
  const x = 300;
  // Below the sample graph's three rows rather than across them: the
  // block is two parallel branches and needs the height, and landing it
  // on top of Split Tone reads as a mess before anybody has looked at
  // what it does.
  const y = 640;
  return [
    // No mask port on either end of the pair: they are conversions, not
    // effects, the same way To Display and To Scene are.
    piece("dn_luma", "heeler.luma_chroma_split", "Luma / Color Split", x, y, undefined, { part: "luma" }, false),
    // Conservative: smoothing brightness is smoothing detail.
    piece("dn_luma_nr", "heeler.denoise", "Luma Denoise", x + 190, y, { strength: 20 }),
    piece("dn_color", "heeler.luma_chroma_split", "Luma / Color Split", x, y + 120, undefined, { part: "color" }, false),
    // Harder, because this half carries no detail to lose.
    piece("dn_color_nr", "heeler.denoise", "Color Denoise", x + 190, y + 120, { strength: 60 }),
    piece("dn_join", "heeler.luma_chroma_join", "Luma / Color Join", x + 380, y + 60, undefined, undefined, false),
  ];
}

/** Blend If, the node-graph way: the logic family's worked example.
 *
 * A layer editor's Blend If decides per pixel whether a layer shows, by a
 * channel read with a feathered threshold. Unbundled into nodes (The
 * report: "extend that past just blending... drive color correction as
 * well"), the same three decisions become wires, and the "what happens
 * where the condition holds" stops being layer visibility and becomes ANY
 * edit, here a highlight recovery, because a bright sky is the case every
 * photographer already understands:
 *
 * feed ──→ sky_meas (Measure: luma) ──→ sky_cond (Compare: > 0.55, │
 * feathered 0.15) ├──→ sky_fix (Exposure: highlights −50, whites −20)
 * ─┐ │ └──→ sky_if (Conditional: else=feed) ◄── then ───────┘ │ ▲────
 * condition ──────────────────────────────────────┘
 *
 * The condition reads the picture AT THE SPLICE POINT, Blend If's
 * "this layer" - and the wire there is SCENE-LINEAR (tone profile and
 * curves both convert back with to_scene on their way out; the
 * sharpen and skin blocks add their own To Display nodes for exactly
 * that reason). So a level of 0.55 means 0.55 in scene light, about
 * 0.77 on screen: the rescue was tuned against that reading and the
 * engine pins it (sky_rescue_threshold_reads_scene_linear_not_display
 * in ops_logic.rs). This comment used to claim the display-shaped
 * value; the accuracy audit caught it saying otherwise than the wire.
 * Opening the graph shows all four nodes; unwiring sky_cond and
 * pointing a hue measurement at sky_if instead is the intended next
 * move, and the reason this is a recipe and not a fixed effect.
 */
export function skyPieces(): Piece[] {
  const x = 300;
  // Below the noise block's band, for the same reason it is not across
  // the sample rows: four nodes in two rows need the room.
  const y = 840;
  return [
    // Neither Measure nor Compare declares a mask port (their operand
    // IS the input), so the card must not draw one (a wire into a port
    // the engine never heard of is dropped without a word).
    piece("sky_meas", "heeler.measure", "Measure", x, y, undefined, { metric: "luma" }, false),
    piece("sky_cond", "heeler.compare", "Compare", x + 190, y, { level: 0.55, softness: 0.15 }, { op: "gt" }, false),
    piece("sky_fix", "heeler.exposure", "Highlight Recovery", x, y + 120, {
      exposure: 0,
      contrast: 0,
      color_contrast: 0,
      highlights: -50,
      shadows: 0,
      whites: -20,
      blacks: 0,
    }),
    piece("sky_if", "heeler.conditional", "Conditional", x + 380, y + 60),
  ];
}

/** The wires inside a sky-rescue block: one feed read three ways:
 * measured for the condition, recovered for the then branch, and held
 * untouched as the else branch. */
export function skyWires(feed: string): Wire[] {
  return [
    { from: feed, to: "sky_meas", toPort: "in", kind: "image" },
    { from: "sky_meas", to: "sky_cond", toPort: "in", kind: "mask" },
    { from: feed, to: "sky_fix", toPort: "in", kind: "image" },
    { from: feed, to: "sky_if", toPort: "in", kind: "image" },
    { from: "sky_fix", to: "sky_if", toPort: "in2", kind: "image" },
    { from: "sky_cond", to: "sky_if", toPort: "mask", kind: "mask" },
  ];
}

/** The wires inside a noise reduction block.
 *
 * One feed read twice, which is the same duplicate-layer idea the other
 * two recipes use, and a join that puts the halves back.
 */
export function denoiseWires(feed: string): Wire[] {
  return [
    { from: feed, to: "dn_luma", toPort: "in", kind: "image" },
    { from: feed, to: "dn_color", toPort: "in", kind: "image" },
    { from: "dn_luma", to: "dn_luma_nr", toPort: "in", kind: "image" },
    { from: "dn_color", to: "dn_color_nr", toPort: "in", kind: "image" },
    { from: "dn_luma_nr", to: "dn_join", toPort: "in", kind: "image" },
    { from: "dn_color_nr", to: "dn_join", toPort: "in2", kind: "image" },
  ];
}

/** The mode a blend is set to, for the card's badge.
 *
 * "Vivid Light - This should be a blending mode node where
 * one of the blending modes is Vivid Light." It always was one: the node
 * type is heeler.blend and vivid light is one of six modes. Naming the
 * instance after its mode made it look like a node type of its own, which
 * is the opposite of what the graph should be teaching. The name is the
 * node now and the mode is the badge.
 */
function modeBadge(p: Piece): string | undefined {
  // The split's half is the same kind of fact as a blend's mode: what
  // this instance of a shared type is doing. Two Luma / Color Splits in
  // one block are told apart by it.
  const mode = p.textParams?.mode ?? p.textParams?.part;
  if (!mode) return undefined;
  // Title case: the first letter of each word rather than every letter.
  return mode
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export function toCard(p: Piece, enabled: boolean): NodeCard {
  return {
    id: p.id,
    type: p.type,
    name: p.name,
    ...(modeBadge(p) ? { badge: modeBadge(p) } : {}),
    cat: CAT,
    x: p.x,
    y: p.y,
    enabled,
    params: { ...(p.params ?? {}) },
    ...(p.textParams ? { textParams: { ...p.textParams } } : {}),
    hasIn: true,
    hasOut: true,
    // The blends take two images; everything else takes one. The second
    // port has to be drawn or there is nowhere to put the second image,
    // which is how a hand-wired join loses its color half.
    hasIn2: takesTwoImages(p.type),
    // Measure and Compare (the sky block) produce fields, not images:
    // without the flag their out dot drags an image pipe that the
    // connect rules then refuse to land anywhere.
    maskOut: producesMask(p.type),
    // Both blend nodes accept a mask, which is what makes "sharpen only
    // where I painted" a thing you can wire without any new machinery.
    // The conversions do not; see Piece.
    maskIn: p.maskIn ?? true,
  } as NodeCard;
}

/** The recipe block nearest the front of the chain, if any is spliced in.
 *
 * "Nearest the front" by wiring rather than by activation order, because
 * activation order is exactly what cannot be trusted here: the head that
 * nothing else in a recipe feeds is the first one. Returns undefined when
 * no block is wired in, which means the answer is Output.
 */
/** What follows the noise slot in the main chain, so a block can be put
 * where a single node would have gone.
 *
 * Wired as well as present: a category that is switched off keeps its
 * node and its wires, but a node nothing feeds is not in the chain and
 * splicing in front of it would strand the block. */
function noiseSlot(nodes: NodeCard[], wires: Wire[]): string | undefined {
  return CHAIN_ORDER.slice(CHAIN_ORDER.indexOf("denoise") + 1).find(
    (id) =>
      nodes.some((n) => n.id === id) && wires.some((w) => w.to === id && w.kind === "image"),
  );
}

function firstBlockInChain(wires: Wire[]): string | undefined {
  // Sky Rescue is deliberately NOT among the heads. Its block taps the
  // feed three times (measure, the then branch, the else branch), and
  // this machinery can only re-head a single-head block: anchoring a
  // noise block "in front" of sky would redirect the measure tap alone,
  // leave both image branches reading the undenoised feed, and render
  // the undenoised picture without a word. Left out, sky simply chains
  // at the end with the other looks and a later denoise anchors at the
  // main chain's own noise slot instead.
  // The sharpening and skin blocks that used to head the chain here
  // are single nodes now (migrateRecipeBlocks), so nothing is left to
  // anchor in front of: a denoise lands at the main chain's noise slot.
  void wires;
  return undefined;
}

/** Splices a recipe into a graph, or takes it out again.
 *
 * "Any category in the Develop that is off by default
 * should not create nodes until its been turned on. Once on and
 * turned back off preserve the nodes just disable them."
 *
 * So `on: false` never deletes: it disables the block and reconnects the
 * graph around it, and the parameters are still there when it comes back.
 */
export function applyRecipe(
  nodes: NodeCard[],
  wires: Wire[],
  recipe: Recipe,
  on: boolean,
): { nodes: NodeCard[]; wires: Wire[] } {
  const pieces = recipe === "denoise" ? denoisePieces() : skyPieces();
  const first = pieces[0].id;
  const last = pieces[pieces.length - 1].id;
  const output = nodes.find((n) => n.type === "heeler.output");
  if (!output) return { nodes, wires };

  // Where the block goes in.
  //
  // Sharpening and Skin Softening are looks laid over the finished
  // picture, and they chain in the order they were switched on, which is
  // The owner's rule and is left exactly as it was.
  //
  // Noise reduction is not a look. It is a correction, and its place is
  // the one the main chain already gives noise: CHAIN_ORDER runs denoise
  // -> sharpen -> grain, and that order is not editorial. Sharpening a
  // noisy frame amplifies the noise and smoothing afterwards rubs the
  // sharpening out; and grain is something a photographer ADDED, so a
  // Chroma slider at 60 arriving afterwards would quietly eat the
  // colored grain they just asked for. Splicing in front of the other
  // recipe blocks is not enough, because all three of them sit at the end
  // of the chain, past the tone profile and the curves.
  //
  // So this one anchors at the chain's own noise slot and lets the rest
  // of the picture happen downstream of it, exactly as Detail's Smoothing
  // node does two nodes earlier.
  const anchor =
    (recipe === "denoise" && (noiseSlot(nodes, wires) ?? firstBlockInChain(wires))) || output.id;

  const present = nodes.some((n) => n.id === first);
  const active = pieces.map((p) => p.id);

  // Create on first use only, and never a second time.
  let outNodes = present
    ? nodes.map((n) =>
        n.id.startsWith(RECIPE_PREFIX[recipe])
          ? { ...n, enabled: on && active.includes(n.id) }
          : n,
      )
    : [...nodes, ...pieces.map((p) => toCard(p, on && active.includes(p.id)))];

  // What fed the block before, which is the thing that has to be
  // remembered: pull the block's wires first and Output is left with
  // nothing coming into it, and the feed is gone for good. That was a real
  // bug, and it is why this is read before anything is removed.
  const intoBlock = wires.find((w) => w.to === first && w.kind === "image");
  const outOfBlock = wires.filter((w) => w.from === last);
  const straightToAnchor = wires.find((w) => w.to === anchor && w.kind === "image");
  const feed = intoBlock?.from ?? straightToAnchor?.from;

  // And where it hands its result ON, read from the wiring as it stands
  // rather than looked up again afterwards.
  //
  // That distinction is the whole of a real bug. Re-applying a block that
  // is already spliced (switching Vivid to Hi Pass does exactly this) used
  // to rejoin the feed to whatever the block fed, and then go looking for
  // a "feed -> anchor" wire to replace. With another block downstream
  // there is no such wire, so nothing was replaced and the block's tail
  // was added as a SECOND feed into the anchor: two blocks running in
  // parallel off one source, with the bridge silently dropping whichever
  // connect lost. Asking the wiring once, before touching it, cannot go
  // wrong that way.
  const destinations: { to: string; toPort: Wire["toPort"]; kind: Wire["kind"] }[] = intoBlock
    ? outOfBlock.map((w) => ({ to: w.to, toPort: w.toPort, kind: w.kind }))
    : straightToAnchor
      ? [{ to: straightToAnchor.to, toPort: straightToAnchor.toPort, kind: straightToAnchor.kind }]
      : [];

  // Take the block out of the wiring entirely, joining whatever it fed
  // back to whatever fed it. A block that was never spliced has no wires
  // here and this does nothing.
  let outWires = wires.filter(
    (w) => !w.from.startsWith(RECIPE_PREFIX[recipe]) && !w.to.startsWith(RECIPE_PREFIX[recipe]),
  );
  if (intoBlock && feed) {
    outWires = [
      ...outWires,
      ...destinations.map((d) => ({ from: feed, to: d.to, toPort: d.toPort, kind: d.kind })),
    ];
  }

  if (!on || !feed) {
    // Off: the nodes stay where they are with their settings, and the
    // graph runs straight past them.
    return { nodes: outNodes, wires: outWires };
  }

  // And splice it back in, between the feed and those destinations.
  // Whatever carried the feed straight past comes out, whether that is
  // the original wire into the anchor or the rejoin made just above.
  const inner = recipe === "denoise" ? denoiseWires(feed) : skyWires(feed);
  // A block that fed nothing at all still has to land somewhere.
  const landing = destinations.length
    ? destinations
    : [{ to: anchor, toPort: "in" as const, kind: "image" as const }];
  outWires = [
    ...outWires.filter(
      (w) => !(w.from === feed && landing.some((d) => d.to === w.to && d.toPort === w.toPort)),
    ),
    ...inner,
    ...landing.map((d) => ({
      from: last,
      to: d.to,
      toPort: d.toPort,
      kind: "image" as const,
    })),
  ];
  return { nodes: outNodes, wires: outWires };
}

/** What each off-by-default Develop category builds, the first time it is
 * switched on.
 *
 * "Any category in the Develop that is off by default should
 * not create nodes until its been turned on. Once on and turned back off
 * preserve the nodes just disable them."
 *
 * The two halves matter equally. A photograph nobody has touched should not
 * be carrying a color bend and a grain node it will never use, and a
 * photograph somebody has touched should not lose the settings on those
 * nodes just because the switch went back to off. So: created on demand,
 * disabled rather than deleted.
 *
 * Params are not listed. A node is built neutral and then filled in from
 * what its type declares, which is a stronger guarantee than a copy of the
 * sample graph: it cannot go stale when a node gains a control.
 */
export interface CategoryPiece {
  id: string;
  type: string;
  name: string;
  cat: string;
  /** A piece that is a layer tool built as a group (Sharpening, Skin
   * Softening): the switch builds it through the tool's own builder. */
  tool?: string;
}

export const CATEGORY_PIECES: Record<string, CategoryPiece[]> = {
  Curves: [{ id: "curves", type: "heeler.curves", name: "Curves", cat: "color" }],
  // On demand ("RELIGHT should be off by default (no nodes in the
  // graph)"). Being a category piece is what makes that true: the node
  // leaves the default graph and comes back with its points intact when
  // the switch goes on.
  Relight: [{ id: "toneeq", type: "heeler.tone_eq", name: "Relight", cat: "color" }],
  // Its own section now, and on-demand like its neighbor: off means
  // not in the graph. "Remove the node from the default
  // graph since the Levels section is off."
  Levels: [{ id: "levels", type: "heeler.levels", name: "Levels", cat: "color" }],
  // Texture, clarity and dehaze, on their own node since 2026-09-02 so
  // the section can be off ("The only two that should be on
  // by default are Exposure and Color"). Before that they were params
  // of Standard Color and Detail's switch was Color's switch.
  Detail: [{ id: "detail", type: "heeler.detail", name: "Detail", cat: "detail" }],
  "Color Wheels": [
    { id: "cbal", type: "heeler.color_balance", name: "Color Balance", cat: "color" },
  ],
  "Color Bend": [{ id: "bend", type: "heeler.color_bend", name: "Color Bend", cat: "color" }],
  // The paid color tools ship dark (2026-08-25): on-demand like
  // their neighbors, so a fresh photograph does not carry them.
  Recolor: [{ id: "recolor", type: "heeler.recolor", name: "Recolor", cat: "color" }],
  "Color Tune": [
    { id: "colorconsole", type: "heeler.color_console", name: "Color Tune", cat: "color" },
  ],
  Lens: [
    { id: "lens", type: "heeler.lens_correct", name: "Lens Correction", cat: "source" },
  ],
  // The mesh warp, after the lens in the chain: the optics corrected
  // first, then the picture reshaped, and everything painted later
  // lands on the reshaped frame.
  "Grid Warp": [{ id: "gridwarp", type: "heeler.grid_warp", name: "Grid Warp", cat: "source" }],
  // After the grid in the chain: a shape's pull is measured in the
  // frame the grid has already reshaped, which is what makes the drag
  // preview honest.
  "Shape Warp": [{ id: "shapewarp", type: "heeler.shape_warp", name: "Shape Warp", cat: "source" }],
  // Geometry stayed in the default graph for a while because the Crop and
  // Straighten tools write to its node. They now write to a stand-in and
  // the first real write builds the node (materializeMainTool), so the
  // section can go on-demand like the rest. "Do we need to
  // have Crop & Rotate by default? ... Let's remove that one too."
  Geometry: [{ id: "crop", type: "heeler.crop_rotate", name: "Crop & Rotate", cat: "source" }],
  // Color Checker calibration (26.3 Phase 11): on demand like the
  // warps. In the chain it sits after the depth map and before
  // Color: it corrects the camera before anything creative, and a
  // calibration never rekeys the depth plane.
  "Color Checker": [
    { id: "colorchecker", type: "heeler.color_checker", name: "Color Checker", cat: "source" },
  ],
  // "Effects" held exactly one effect, which is the whole of why it was
  // called that. "Why is EFFECTS call that when its just GRAIN
  // controls?" It is Grain now, and Vignette is its own section rather
  // than a second thing under the old name: every category here is one
  // node, and a section's switch reads one node, so a bucket holding two
  // would need a switch that lies about one of them. Two looks, two
  // switches, either one usable without the other.
  Grain: [{ id: "grain", type: "heeler.grain", name: "Grain", cat: "detail" }],
  Vignette: [{ id: "vignette", type: "heeler.vignette", name: "Vignette", cat: "detail" }],
  // The depth tools, each its own section and its own switch. Fog and
  // the key light act on scene light so they sit before the profile;
  // depth of field is optics and sits with them (blur after grading
  // would smear the grain). The depth map's settings (2026-09-05): one
  // node every depth tool reads through, ahead of the first of them, so
  // the map is made before it is used. The engine passes the picture
  // through; the desktop reads the params when it computes the plane.
  "Depth Map": [{ id: "depthmap", type: "heeler.depth_map", name: "Depth Map", cat: "detail" }],
  Fog: [{ id: "fog", type: "heeler.fog", name: "Fog", cat: "detail" }],
  "Depth Lighting": [
    { id: "keylight", type: "heeler.key_light", name: "Depth Lighting", cat: "detail" },
  ],
  "Depth of Field": [{ id: "dof", type: "heeler.dof", name: "Depth of Field", cat: "detail" }],
  // The lens flare: the lens's signature for the Depth Lighting rig's
  // flaring lights, after Depth of Field (the flare happens in the lens,
  // so the scene's defocus must not soften it) and before the profile,
  // which blooms it into the highlights.
  "Lens Flare": [{ id: "flare", type: "heeler.flare", name: "Lens Flare", cat: "detail" }],
  // Halation: after the flare, before the bend, in scene-linear light
  // like the rest of the optics.
  Halation: [{ id: "halation", type: "heeler.halation", name: "Halation", cat: "detail" }],
  // The print: the paper, display domain, last before Output. On
  // demand like the rest of the darkroom.
  Print: [{ id: "paper", type: "heeler.paper", name: "Print", cat: "color" }],
  // The two recipes that became single nodes, so they ride a layer
  // behind its mask ("You would always smooth or sharpen
  // via layers and masking"). On demand and off, like their
  // neighbors.
  Sharpening: [{ id: "sharpening", type: "heeler.group", name: "Sharpening", cat: "detail", tool: "sharpening" }],
  "Skin Softening": [{ id: "skin", type: "heeler.group", name: "Skin Softening", cat: "detail", tool: "skin" }],
};

/** Every id that a category owns, so the rest of the app can ask "is this
 * node one that comes and goes" without knowing which category it is. */
/** Which category owns a node, for the nodes that come and go. */
export const CATEGORY_OF: Record<string, string> = Object.fromEntries(
  Object.entries(CATEGORY_PIECES).flatMap(([title, ps]) =>
    ps.map((p) => [p.id, title] as const),
  ),
);

/** Main-chain tools that ship without a node: rows inside sections that
 * are on by default (Detail's Unsharp and Smoothing, Color's B&W
 * treatment), so no switch builds them. The panel draws a stand-in at
 * identity (toolNode) and the first write that says something splices
 * the real node into the chain (materializeMainTool), exactly the
 * layer tools' bargain. "let's remove Denoise and Sharpen.
 * Even Black and White." Keyed by the LAYER_TOOLS key the panel asks
 * toolNode for.*/
export const TOOL_PIECES: Record<string, CategoryPiece> = {
  sharpen: { id: "sharpen", type: "heeler.sharpen", name: "Sharpen", cat: "detail" },
  denoise: { id: "denoise", type: "heeler.denoise", name: "Denoise", cat: "detail" },
  bw: { id: "bw", type: "heeler.black_white", name: "Black & White", cat: "color" },
};

/** Every id that comes and goes: the category pieces and the tool
 * pieces. A fresh graph carries none of them. */
export const ON_DEMAND_IDS = new Set([
  ...Object.values(CATEGORY_PIECES).flatMap((ps) => ps.map((p) => p.id)),
  ...Object.values(TOOL_PIECES).map((p) => p.id),
]);

/** The main image chain, in the order it runs.
 *
 * This is what says where a node goes back in. A category that has been off
 * cannot be put back "where it was", because nothing remembers, and it
 * cannot go on the end, because grain before a color bend is a different
 * photograph than grain after it. The order is the answer, and a test holds
 * it against the sample graph's wiring so the two cannot drift apart.
 */
export const CHAIN_ORDER = [
  "src",
  // Noise Reduction's Model method, first after the source: the
  // SCUNet answer the desktop computed from the source is exactly the
  // picture this node sees, so nothing upstream can drift it.
  "modeldenoise",
  "merge",
  "crop",
  "lens",
  "gridwarp",
  "shapewarp",
  // The Depth Map's one fixed seat (26.3 Phase 10): after geometry,
  // before anything tonal, so the map reads the straightened photograph
  // and the seat never wanders with what is enabled. The picture passes
  // through untouched; the plane leaves by the depth port, and every
  // consumer reads it by wire.
  "depthmap",
  // The Color Checker's seat (26.3 Phase 11): after the warps and the
  // depth map, before Color, so it corrects the camera before anything
  // creative and toggling a calibration never rekeys the depth plane
  // (the sampler reads the geometry-corrected photograph either way).
  "colorchecker",
  "stdcolor",
  // Detail right after Color, which is where its dials ran while they
  // were Color's own.
  "detail",
  "cbal",
  "exposure",
  // Directly after Exposure, which is where it was wired when it was
  // always in the graph: Relight re-exposes brightness zones, and that
  // is exposure work in the scene-linear stretch. Splicing it in
  // anywhere later would be a different operation wearing the same
  // name.
  "toneeq",
  "bw",
  "denoise",
  "sharpen",
  // The recipe tools, after Detail's own unsharp: the same slot the
  // recipe blocks used to be spliced into, ahead of the vignette.
  "sharpening",
  "skin",
  // Vignette before grain, the order both the optics and the other
  // editors use: a lens shades the corners of the light BEFORE the
  // film records it, so the grain lies over the vignette rather than
  // being darkened by it.
  "vignette",
  "grain",
  // The depth tools: the key light shades the scene's light, fog lays
  // the atmosphere over it, depth of field defocuses the result.
  "keylight",
  "fog",
  "dof",
  // The flare is light entering the lens: after the scene's defocus,
  // before the profile rolls it into the highlights.
  "flare",
  // Halation is the emulsion catching the lens's light: last of the
  // optics, still scene-linear.
  "halation",
  "bend",
  "recolor",
  "colorconsole",
  "profile",
  // Levels rides on the finished profile too (2026-09-13), ahead of
  // Curves as the panel lists them: its handles sit on the histogram of
  // the picture as shown, and before Exposure in scene-linear a black
  // point of 0.01 cut the darkest tenth of the screen ("the
  // smallest nudge of a slider has huge changes").
  "levels",
  // Curves ride on top of the finished profile, the way the reference editors put
  // their point curve over the picture you are looking at: a photograph
  // that reads 97% bright on screen is at 0.97 on the curve's axis.
  // Anywhere earlier and the profile's lift happens after the curve,
  // and no eyedropper can reconcile the axis with the screen.
  "curves",
  // The print: the paper the finished picture is printed on, after
  // Levels and Curves have shaped the negative-to-print and before
  // the art layers paint on the print.
  "paper",
  // The art-layer stack: a group of paint/blend pairs riding on the
  // finished, display-shaped photograph. Last before output because
  // paint and blend modes speak display values, and because cleanup is
  // the thing you do to the picture you are otherwise done with.
  "art",
  "output",
];

// ---------------------------------------------------------------------
// Sharpening and Skin Softening as GROUPS of the real nodes
// (2026-09-23: "I was very specific when this was built that the
// Sharpening node should be a group. Within the group are all the nodes
// for inverting, gaussian blur, and blending. So I could 1) verify they
// were setup correct and 2) make modifications as I see fit." And the
// same for Hi Pass.) From 2026-09-03 to today each was one engine node
// (heeler.sharpening, heeler.skin_soften) so it could ride a layer's
// mask; a group carries a mask port too, routed to the recipe's final
// blend, so the group rides the layer and stays a graph.
//
// The group's own params are a MIRROR of the recipe's dials (radius,
// intensity; softening, detail back, strength), kept in step both ways
// by syncToolGroup: a Develop slider writes the mirror and the members
// follow, an edit inside the opened group moves a member and the mirror
// follows. The published controls are the same dials for the graph
// inspector's face of the group.

export type SharpenMode = "vivid" | "hipass";
export const SHARPEN_MODES: readonly SharpenMode[] = ["vivid", "hipass"];

/** A member's id: the recipe's prefix (which isRecipeNode reads)
 * and its part, then the group's id so two groups never share a member. */
export function toolMemberId(group: string, prefix: "sharp" | "skin", part: string): string {
  return `${prefix}_${part}_${group}`;
}

function memberCard(
  id: string,
  type: string,
  name: string,
  x: number,
  y: number,
  params: Record<string, number> = {},
  textParams?: Record<string, string>,
  maskIn = true,
): NodeCard {
  return {
    id,
    type,
    name,
    cat: CAT,
    x,
    y,
    enabled: true,
    params,
    ...(textParams ? { textParams } : {}),
    hasIn: true,
    hasOut: true,
    ...(takesTwoImages(type) ? { hasIn2: true } : {}),
    ...(maskIn ? { maskIn: true } : {}),
  } as NodeCard;
}

const wire = (from: string, to: string, toPort: "in" | "in2" | "mask" = "in"): Wire =>
  ({ from, to, toPort, kind: toPort === "mask" ? "mask" : "image" }) as Wire;

/** The owner's first two recipes as one group with a Recipe
* switch.
 *
 * Vivid: "Duplicate the image 3 times... Top image: invert, change the
 * blend mode to Vivid light, Apply Gaussian Blur... Select the Top image
 * and the middle image and group them, then on the group node the blend
 * mode is set to overlay."
 *
 * Hi Pass: "Duplicate the image. With the duplicated image: completely
 * desaturate, change the blend mode to overlay, apply the high pass
 * filter."
 *
 * Both branches are built whichever mode is chosen; the unused one is
 * left disabled and unwired, so switching costs nothing. The mask a
 * layer hands the group lands on the Overlay blend: the executor blends
 * that node's result back toward its base by the mask, which is the
 * display picture, so a masked group is the recipe inside the mask and
 * the picture outside it.
 *
 * One node past the recipe (2026-09-23, the green rim along the jaguar's
 * spots): the picture's color laid over the recipe's result through a
 * Color blend, so the sharpening lands on the brightness and the color
 * stays the picture's. The recipe pushes each channel on its own, and at a
 * dark spot against tan fur the cyan shadow pixels beside the edge come
 * out a green rim; the picture had no chromatic aberration to blame (its
 * three channels cross the edge within a quarter pixel). A layer editor's
 * own advice for the recipe is to set the group to Luminosity, the same
 * arithmetic from the other side; here it is the Keep color dial, the
 * Color blend's opacity, 100 by default and 0 for the recipe's own color
 * (the sharpening stays either way, which a Luminosity blend's opacity
 * could not give: at 0 it was the picture again, the groups review's
 * finding).
 *
 * Two more nodes are the group's own plumbing, not the recipe's: a
 * Picture pass-through at the entrance, which hands the untouched
 * scene-linear picture to To Scene as its highlight reference (the
 * trip through display encoding clamps at white, and without it a
 * specular at 2.5 came out at 1.0 with the dials at zero) and to the
 * final Apply mask blend, where the layer's mask lands, so the mask
 * interpolates the scene-linear picture as every other layer's does.
 */
export function sharpeningGroup(
  id: string,
  x: number,
  y: number,
  opts: { radius?: number; intensity?: number; keep_color?: number; mode?: SharpenMode; enabled?: boolean } = {},
): NodeCard {
  const radius = opts.radius ?? 3;
  const intensity = opts.intensity ?? 50;
  const keep_color = opts.keep_color ?? 100;
  const m = (part: string) => toolMemberId(id, "sharp", part);
  const members: NodeCard[] = [
    memberCard(m("display"), "heeler.to_display", "To Display", 0, 60, {}, undefined, false),
    memberCard(m("inv"), "heeler.invert", "Invert", 150, 0, { amount: 1 }),
    memberCard(m("blur"), "heeler.blur", "Blur", 300, 0, { radius, angle: 0 }, { kind: "gaussian" }),
    memberCard(m("vivid"), "heeler.blend", "Blend Mode", 450, 30, { opacity: 100 }, { mode: "vivid_light" }),
    memberCard(m("desat"), "heeler.desaturate", "Desaturate", 150, 130, { amount: 1 }),
    memberCard(m("hp"), "heeler.high_pass", "High Pass", 300, 130, { radius }),
    memberCard(m("over"), "heeler.blend", "Blend Mode", 620, 60, { opacity: intensity }, { mode: "overlay" }),
    memberCard(m("color"), "heeler.blend", "Keep color", 780, 60, { opacity: keep_color }, { mode: "color" }),
    memberCard(m("scene"), "heeler.to_scene", "To Scene", 940, 60, {}, undefined, false),
  ];
  const group: NodeCard = {
    id,
    type: "heeler.group",
    name: "Sharpening",
    cat: CAT,
    x,
    y,
    enabled: opts.enabled ?? true,
    params: { radius, intensity, keep_color },
    textParams: { mode: opts.mode ?? "vivid" },
    isGroup: true,
    tool: "sharpening",
    groupNodes: members,
    groupWires: [],
    groupBoundary: [
      { from: "", to: m("display"), toPort: "in", kind: "image" },
      { from: m("scene"), to: "", toPort: "in", kind: "image" },
      { from: "", to: m("over"), toPort: "mask", kind: "mask" },
    ] as Wire[],
    published: [],
    hasIn: true,
    hasOut: true,
    maskIn: true,
  };
  return sceneSafeToolGroup(pushToolGroup(group));
}

/** The owner's third recipe. Not sharpening: "This is mean to smooth
 * out skin blemishes, yet recover detail."
 *
 * "In the group: take the top image and invert it and set the blending
 * mode to vivid. On the top image apply a high pass filter (the radius
 * control softens the image to clean up blemishes, usually 20px is a good
 * starting point). On the top image apply a Gaussian blur, this will bring
 * detail back... a value of 4 px should be a default."
 */
export function skinGroup(
  id: string,
  x: number,
  y: number,
  opts: { softening?: number; detail_back?: number; strength?: number; enabled?: boolean } = {},
): NodeCard {
  const softening = opts.softening ?? 8;
  const detail_back = opts.detail_back ?? 4;
  const strength = opts.strength ?? 50;
  const m = (part: string) => toolMemberId(id, "skin", part);
  const members: NodeCard[] = [
    memberCard(m("display"), "heeler.to_display", "To Display", 0, 60, {}, undefined, false),
    memberCard(m("inv"), "heeler.invert", "Invert", 150, 0, { amount: 1 }),
    memberCard(m("hp"), "heeler.high_pass", "High Pass", 300, 0, { radius: softening }),
    memberCard(m("blur"), "heeler.blur", "Blur", 450, 0, { radius: detail_back, angle: 0 }, { kind: "gaussian" }),
    memberCard(m("vivid"), "heeler.blend", "Blend Mode", 600, 30, { opacity: 100 }, { mode: "vivid_light" }),
    memberCard(m("over"), "heeler.blend", "Blend Mode", 760, 60, { opacity: strength }, { mode: "normal" }),
    memberCard(m("scene"), "heeler.to_scene", "To Scene", 920, 60, {}, undefined, false),
  ];
  const group: NodeCard = {
    id,
    type: "heeler.group",
    name: "Skin Softening",
    cat: CAT,
    x,
    y,
    enabled: opts.enabled ?? true,
    params: { softening, detail_back, strength },
    isGroup: true,
    tool: "skin",
    groupNodes: members,
    groupWires: [
      wire(m("display"), m("inv")),
      wire(m("inv"), m("hp")),
      wire(m("hp"), m("blur")),
      wire(m("display"), m("vivid")),
      wire(m("blur"), m("vivid"), "in2"),
      wire(m("display"), m("over")),
      wire(m("vivid"), m("over"), "in2"),
      wire(m("over"), m("scene")),
    ],
    groupBoundary: [
      { from: "", to: m("display"), toPort: "in", kind: "image" },
      { from: m("scene"), to: "", toPort: "in", kind: "image" },
      { from: "", to: m("over"), toPort: "mask", kind: "mask" },
    ] as Wire[],
    published: [
      { label: "Softening", node: m("hp"), param: "radius", range: [0, 200] },
      { label: "Detail back", node: m("blur"), param: "radius", range: [0, 200] },
      { label: "Strength", node: m("over"), param: "opacity", range: [0, 100] },
    ],
    hasIn: true,
    hasOut: true,
    maskIn: true,
  };
  return sceneSafeToolGroup(pushToolGroup(group));
}

/** Keep the display recipe editable while its layer mask interpolates
 * the final scene-linear picture. The neutral Merge carries the original
 * input without a pixel pass, including highlights above white. */
export function sceneSafeToolGroup(group: NodeCard): NodeCard {
  if (!group.tool || !group.groupNodes) return group;
  const prefix = group.tool === "sharpening" ? "sharp" : "skin";
  const m = (part: string) => toolMemberId(group.id, prefix, part);
  // A Sharpening group from before the Keep color stage, or from the
  // day it was a Luminosity blend and a mix (both 2026-09-23), gets
  // the one Color blend at its dial; everything else inside is kept.
  if (group.tool === "sharpening" && !group.groupNodes.some(n => n.id === m("color") && n.textParams?.mode === "color")) {
    const stale = [m("lum"), m("color")];
    const oldColor = group.groupNodes.find(n => n.id === m("color"));
    const oldLum = group.groupNodes.find(n => n.id === m("lum"));
    const keep = group.params.keep_color ?? oldColor?.params.opacity ?? oldLum?.params.opacity ?? 100;
    group = { ...group,
      groupNodes: [...group.groupNodes.filter(n => !stale.includes(n.id)),
        memberCard(m("color"), "heeler.blend", "Keep color", 780, 60, { opacity: keep }, { mode: "color" })],
      groupWires: [...(group.groupWires ?? []).filter(w => !stale.includes(w.from) && !stale.includes(w.to) && !(w.from === m("over") && w.to === m("scene"))),
        wire(m("over"), m("color")), wire(m("display"), m("color"), "in2"), wire(m("color"), m("scene"))],
      published: [...(group.published ?? []).filter(p => p.label !== "Keep color"),
        { label: "Keep color", node: m("color"), param: "opacity", range: [0, 100] }],
    };
  }
  if (group.groupNodes!.some(n => n.id === m("mask"))) return group;
  return {
    ...group,
    groupNodes: [
      memberCard(m("input"), "heeler.merge", "Picture", -160, 60, { opacity: 100 }),
      ...group.groupNodes!.map(n => n.id === m("scene") ? { ...n, hasIn2: true } : n),
      memberCard(m("mask"), "heeler.blend", "Apply mask", 1100, 60, { opacity: 100 }, { mode: "normal" }),
    ],
    groupWires: [...(group.groupWires ?? []),
      wire(m("input"), m("display")), wire(m("input"), m("scene"), "in2"),
      wire(m("input"), m("mask")), wire(m("scene"), m("mask"), "in2")],
    groupBoundary: (group.groupBoundary ?? []).map(w => ({ ...w,
      to: w.to === m("display") ? m("input") : w.to === m("over") && w.toPort === "mask" ? m("mask") : w.to,
      from: w.from === m("scene") ? m("mask") : w.from,
    })),
  };
}

/** The group's dials, and where each one writes inside. */
export const TOOL_GROUP_DEFAULTS: Record<string, Record<string, number>> = {
  sharpening: { radius: 3, intensity: 50, keep_color: 100 },
  skin: { softening: 8, detail_back: 4, strength: 50 },
};

/** The mirror written INTO the members: a Develop slider, a section
 * reset, a migration or the Recipe switch moved the group's own params
 * or mode, and the nodes inside follow. Sharpening's Radius lands on
 * both branches so the one the switch brings in reads the dial. */
export function pushToolGroup(group: NodeCard, rewire = true): NodeCard {
  if (!group.groupNodes) return group;
  if (group.tool === "sharpening") {
    const mode: SharpenMode = group.textParams?.mode === "hipass" ? "hipass" : "vivid";
    const m = (part: string) => toolMemberId(group.id, "sharp", part);
    const radius = group.params.radius ?? 3;
    const intensity = group.params.intensity ?? 50;
    const keep_color = group.params.keep_color ?? 100;
    const active = new Set(
      mode === "vivid"
        ? [m("input"), m("mask"), m("display"), m("inv"), m("blur"), m("vivid"), m("over"), m("color"), m("scene")]
        : [m("input"), m("mask"), m("display"), m("desat"), m("hp"), m("over"), m("color"), m("scene")],
    );
    const groupNodes = group.groupNodes.map((n) => {
      const enabled = rewire ? active.has(n.id) : n.enabled;
      const params =
        n.id === m("blur") || n.id === m("hp")
          ? { ...n.params, radius }
          : n.id === m("over")
            ? { ...n.params, opacity: intensity }
            : n.id === m("color")
              ? { ...n.params, opacity: keep_color }
              : n.params;
      return n.enabled === enabled && params === n.params ? n : { ...n, enabled, params };
    });
    const groupWires: Wire[] = [
      wire(m("display"), m("over")),
      ...(mode === "vivid"
        ? [
            wire(m("display"), m("inv")),
            wire(m("inv"), m("blur")),
            wire(m("display"), m("vivid")),
            wire(m("blur"), m("vivid"), "in2"),
            wire(m("vivid"), m("over"), "in2"),
          ]
        : [wire(m("display"), m("desat")), wire(m("desat"), m("hp")), wire(m("hp"), m("over"), "in2")]),
      // The picture's color over the sharpened picture, at Keep color.
      wire(m("over"), m("color")),
      wire(m("display"), m("color"), "in2"),
      wire(m("color"), m("scene")),
      ...(group.groupNodes.some(n => n.id === m("input")) ? [
        wire(m("input"), m("display")), wire(m("input"), m("scene"), "in2"),
        wire(m("input"), m("mask")), wire(m("scene"), m("mask"), "in2"),
      ] : []),
    ];
    return {
      ...group,
      textParams: { ...group.textParams, mode },
      groupNodes,
      groupWires: rewire ? groupWires : group.groupWires,
      published: rewire ? [
        { label: "Radius", node: mode === "vivid" ? m("blur") : m("hp"), param: "radius", range: [0, 200] },
        { label: "Intensity", node: m("over"), param: "opacity", range: [0, 100] },
        { label: "Keep color", node: m("color"), param: "opacity", range: [0, 100] },
      ] : group.published,
    };
  }
  if (group.tool === "skin") {
    const m = (part: string) => toolMemberId(group.id, "skin", part);
    const writes: Record<string, [string, number]> = {
      [m("hp")]: ["radius", group.params.softening ?? 8],
      [m("blur")]: ["radius", group.params.detail_back ?? 4],
      [m("over")]: ["opacity", group.params.strength ?? 50],
    };
    return {
      ...group,
      groupNodes: group.groupNodes.map((n) => {
        const w = writes[n.id];
        if (!w || n.params[w[0]] === w[1]) return n;
        return { ...n, params: { ...n.params, [w[0]]: w[1] } };
      }),
    };
  }
  return group;
}

/** Reset restores the stock recipe, including members the user deleted.
 * Extra cards stay available for rewiring; their edits are not settings
 * of the stock recipe. Ordinary dial writes never call this. */
export function resetToolGroup(group: NodeCard): NodeCard {
  const stock = group.tool === "sharpening"
    ? sharpeningGroup(group.id, group.x, group.y, { ...group.params, mode: group.textParams?.mode as SharpenMode })
    : group.tool === "skin" ? skinGroup(group.id, group.x, group.y, group.params) : null;
  if (!stock) return group;
  const ids = new Set(stock.groupNodes!.map((n) => n.id));
  return {
    ...group,
    groupNodes: [...stock.groupNodes!.map((n) => {
      const old = group.groupNodes?.find((m) => m.id === n.id);
      return old ? { ...n, x: old.x, y: old.y } : n;
    }), ...(group.groupNodes ?? []).filter((n) => !ids.has(n.id))],
    groupWires: stock.groupWires,
    groupBoundary: stock.groupBoundary,
    published: stock.published,
  };
}

/** The mirror read OUT of the members: an edit inside the opened group,
 * or a published control, moved a node, and the group's own params say
 * what the members say. The same object back when nothing moved. */
export function pullToolGroup(group: NodeCard): NodeCard {
  if (!group.groupNodes || !group.tool) return group;
  const read = (id: string, param: string, fallback: number) =>
    group.groupNodes!.find((n) => n.id === id)?.params[param] ?? fallback;
  let params: Record<string, number>;
  if (group.tool === "sharpening") {
    const m = (part: string) => toolMemberId(group.id, "sharp", part);
    const mode: SharpenMode = group.textParams?.mode === "hipass" ? "hipass" : "vivid";
    params = {
      radius: read(mode === "vivid" ? m("blur") : m("hp"), "radius", group.params.radius ?? 3),
      intensity: read(m("over"), "opacity", group.params.intensity ?? 50),
      keep_color: read(m("color"), "opacity", group.params.keep_color ?? 100),
    };
  } else if (group.tool === "skin") {
    const m = (part: string) => toolMemberId(group.id, "skin", part);
    params = {
      softening: read(m("hp"), "radius", group.params.softening ?? 8),
      detail_back: read(m("blur"), "radius", group.params.detail_back ?? 4),
      strength: read(m("over"), "opacity", group.params.strength ?? 50),
    };
  } else {
    return group;
  }
  const same = Object.entries(params).every(([k, v]) => group.params[k] === v);
  return same ? group : { ...group, params: { ...group.params, ...params } };
}
