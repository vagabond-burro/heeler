// Develop's section list and the settings data its panel reads: which
// sections there are and what each holds, each parameter's default, the
// tips beside rows, and the questions asked of a section (is it on, is it
// hidden, what it exports). No components live here, so the panel's file,
// simple.tsx, exports components alone and Vite can refresh it in place
// as it is edited instead of reloading the window.
import { gridWarpNode, shapeWarpNode, colorCheckerNode, MODEL_DENOISE_ID, denoiseMethodIsModel } from "../state";
import type { Command, NodeCard, State } from "../state";
import { NEUTRAL_PARAMS, REGISTRY_DEFAULTS, PARAM_TEXT_DEFAULT, migrateNodes, categoryPieceNode, BEND_FALLOFF_DEFAULT, PROFILE_DEFAULTS, toolNode, reduce } from "../state";
import type { LayerMaskType, LayerToolKey } from "../state";
import { CATEGORY_OF, TOOL_GROUP_DEFAULTS, CATEGORY_PIECES, denoisePieces, skyPieces, toCard, type Recipe, RECIPE_PREFIX } from "../recipes";
import { buildTargets, type NavTarget, type SectionTargets } from "../keynav";
import { layerGroupPrefix, isLayerNode } from "../layerids";

type D = (c: Command) => void;

/** Mask parameter rows per layer mask type, rendered under Layers and in
 * the Graph inspector (same params, both surfaces, 1:1 with the graph). */
export const MASK_ROWS: Record<
  LayerMaskType,
  { label: string; param: string; centered?: boolean }[]
> = {
  range: [
    { label: "Luma low", param: "luma_low", centered: false },
    { label: "Luma high", param: "luma_high", centered: false },
    { label: "Sat low", param: "sat_low", centered: false },
    { label: "Sat high", param: "sat_high", centered: false },
    { label: "Hue center", param: "hue_center" },
    { label: "Hue width", param: "hue_width", centered: false },
    { label: "Softness", param: "softness", centered: false },
  ],
  radial: [
    { label: "Center X", param: "center_x", centered: false },
    { label: "Center Y", param: "center_y", centered: false },
    { label: "Radius", param: "radius", centered: false },
    { label: "Feather", param: "feather", centered: false },
    { label: "Aspect", param: "aspect", centered: false },
    { label: "Rotation", param: "rotation" },
  ],
  linear: [
    { label: "Angle", param: "angle" },
    { label: "Position", param: "position", centered: false },
    { label: "Span", param: "span", centered: false },
  ],
  brush: [],
  selection: [
    { label: "Grow", param: "grow" },
    { label: "Smooth", param: "smooth", centered: false },
    { label: "Feather", param: "feather", centered: false },
    // A layer editor's fourth refine setting, run by the engine all along
    // with no seat (2026-09-29): it moves only the soft part of the edge,
    // so it follows Feather.
    { label: "Ramp", param: "ramp" },
    // The matte dials the Polish panel hosts, on the layer's own seat
    // too (features reach their nodes).
    { label: "Contrast", param: "matte_contrast", centered: false },
    { label: "Reach", param: "matte_reach", centered: false },
  ],
  smart: [
    { label: "Threshold", param: "threshold", centered: false },
    { label: "Expand", param: "expand" },
    { label: "Feather", param: "feather", centered: false },
  ],
  object: [{ label: "Feather", param: "feather", centered: false }],
};

/** Reset values per param, mirroring registry defaults. */
/** Where a param resets to when its node overrides the shared answer.
 *
 * The same collision the ranges have: `amount` is 100 on a bend, because a
 * bend at zero amount does nothing, and 0 on an unsharp mask, because a
 * photograph does not arrive sharpened. One table keyed on the name alone
 * has to pick one of those and be wrong about the other.
 */
export const PARAM_DEFAULT_BY_TYPE: Record<string, Record<string, number>> = {
  // Smoothing is a quality dial, not an adjustment: Reset keeps it.
  "heeler.tone_eq": { smoothing: 50 },
  "heeler.recolor": { neutral_guard: 10, smoothing: 50, around_radius: 15 },
  "heeler.color_console": { smoothing: 50 },
  "heeler.sharpen": { amount: 0, radius: 1, threshold: 0 },
  // The recipe tools reset to the recipes' shipping numbers, the same
  // rule the section Reset kept for the blocks ("RESET is
  // setting intensity to 100 and not 50").
  "heeler.sharpening": { radius: 3, intensity: 50 },
  // The tool groups' mirrors (Sharpening, Skin Softening as groups).
  "heeler.group": { radius: 3, intensity: 50, keep_color: 100, softening: 8, detail_back: 4, strength: 50 },
  "heeler.skin_soften": { softening: 8, detail_back: 4, strength: 50 },
  "heeler.grain": { intensity: 0, size: 25 },
  "heeler.blur": { radius: 0 },
  "heeler.high_pass": { radius: 3 },
  "heeler.blend": { opacity: 100 },
  // Fraction-scale nodes: the shared `amount` default is the bend's 100
  // percent, which on these read as a hundred times full strength.
  "heeler.desaturate": { amount: 1 },
  "heeler.invert": { amount: 1 },
  // The shared `falloff` default is the bend's third-of-a-wheel; this
  // one is a 0..1 distance around the picked color.
  "heeler.color_range_mask": { falloff: 0.1 },
  // Reset returns the SHIPPED default look, not the registry's neutral
  // zero: zeroed baseline is the underexposed rendering the comparison
  // work against the reference editors was done to fix.
  "heeler.tone_profile": { ...PROFILE_DEFAULTS },
  // The B&W treatment's strength. Its neutral is 0, which is "not black
  // and white at all", and the only place this row is on screen is
  // inside the mixer that opens when the treatment is ON: a Reset there
  // that turned the treatment off would be resetting the section above
  // it. Full strength is what this control's own reset means. The
  // section's Reset still puts the whole treatment back to color, and
  // does it explicitly.
  "heeler.black_white": { amount: 100 },
};

/** What a param resets to, and what an unset one displays as, for a node
 * of a given type.
 *
 * Three tables in order, and the middle one is the fix for a whole class
 * of bug rather than a list of instances. It used to be the per-type
 * overrides and then PARAM_DEFAULT, a table keyed on the WORD, so any
 * param whose name this app happens to use twice took the other
 * meaning's value, and any param in neither table reset to zero. That is
 * how Depth of Field's Blades came to reset to 0 when the node ships 6
 * and its own slider starts at 3, and how Fog's Falloff reset to the
 * bend's third-of-a-wheel when the node ships 50.
 *
 * NEUTRAL_PARAMS is the app's own per-type record of what a node ships
 * with, checked against the engine's registry by the sweep in
 * state.test.ts, so consulting it before the shared table means a param
 * gets its OWN default unless someone has deliberately said otherwise.
 * The deliberate ones stay first: the tone profile resets to the shipped
 * look rather than the registry's neutral zero, and black_white's
 * strength resets to full rather than to off.
 */
/** What a card resets to: every numeric dial it carries or its type
 * declares, at the section reset's default, and every choice at the
 * type's default text. The same tables Develop's Reset reads, so the
 * two cannot disagree. */
export function nodeResetValues(node: NodeCard): { values: Record<string, number>; textValues: Record<string, string> } {
  if (node.tool && TOOL_GROUP_DEFAULTS[node.tool]) {
    return { values: { ...TOOL_GROUP_DEFAULTS[node.tool] }, textValues: node.tool === "sharpening" ? { mode: "vivid" } : {} };
  }
  const keys = new Set<string>([
    ...Object.keys(NEUTRAL_PARAMS[node.type] ?? {}),
    ...Object.keys(node.params),
  ]);
  const values: Record<string, number> = {};
  // A mask turned off is a switch, and a reset keeps the switch.
  for (const k of keys) if (k !== "mask_off") values[k] = paramDefault(k, node.type);
  const textValues: Record<string, string> = { ...(PARAM_TEXT_DEFAULT[node.type] ?? {}) };
  return { values, textValues };
}

export function paramDefault(param: string, nodeType?: string): number {
  const override = nodeType ? PARAM_DEFAULT_BY_TYPE[nodeType]?.[param] : undefined;
  const shipped = nodeType ? NEUTRAL_PARAMS[nodeType]?.[param] : undefined;
  // The registry's own default before the table keyed on the word: a
  // type the app keeps no identity set for (Luminance Mask, the logic
  // family, the fx layers) showed an unset dial at the word's other
  // meaning or at zero (High 0 on a fresh Luminance Mask).
  const declared = nodeType ? REGISTRY_DEFAULTS[nodeType]?.[param] : undefined;
  return override ?? shipped ?? declared ?? PARAM_DEFAULT[param] ?? 0;
}

export const PARAM_DEFAULT: Record<string, number> = {
  matte_contrast: 25,
  matte_reach: 50,
  highlight_rolloff: 0,
  temperature: 6500,
  // The grain node's own names. Reset writes what the engine reads.
  size: 25,
  radius: 1,
  white: 1,
  gamma: 1,
  red: 30,
  green: 59,
  blue: 11,
  crop_w: 1,
  crop_h: 1,
  camera_wb: 1,
  camera_matrix: 1,
  shadows_gain: 100,
  midtones_gain: 100,
  highlights_gain: 100,
  red_gain: 100,
  green_gain: 100,
  blue_gain: 100,
  // Bend: an unset Amount is full strength in the engine, so showing 0
  // here said the tool was off when it was not.
  amount: 100,
  falloff: BEND_FALLOFF_DEFAULT,
  // Reset puts the vignette range back to the middle of the frame, not to
  // zero: a range of zero would ramp from the center, which brightens the
  // whole picture instead of only its corners.
  vignette_mid: 50,
  src_sat: 0,
  dst_sat: 0,
  // Opacity is all of it until someone says otherwise: a Develop
  // layer's node carries none until its slider moves, and an unset
  // opacity read as 0 would show a full-strength layer at nothing.
  opacity: 100,
  // Detail weighting: even is 100, same as grain's gains.
  ...Object.fromEntries(
    ["texture", "clarity", "dehaze"].flatMap((e) =>
      ["shadows", "midtones", "highlights", "red", "green", "blue"].map((w) => [
        `${e}_${w}`,
        100,
      ]),
    ),
  ),
};

export function sliderHint(tip: string | undefined, overridden: boolean): string | undefined {
  if (!overridden) return tip;
  const suffix = "Overridden: keeps its own value inside the link.";
  const room = 165 - suffix.length - 1;
  const base = tip && tip.length > room ? `${tip.slice(0, room - 3).trimEnd()}...` : tip;
  return base ? `${base} ${suffix}` : suffix;
}

/** Which detail effect the advanced weights are editing. Three effects
 * times six weights is eighteen sliders, which is a wall; showing one
 * effect at a time keeps it to six and a picker. */
export const DETAIL_EFFECTS = ["texture", "clarity", "dehaze"] as const;

export const DETAIL_WEIGHTS: [string, string][] = [
  ["shadows", "Shadows"],
  ["midtones", "Midtones"],
  ["highlights", "Highlights"],
  ["red", "Red"],
  ["green", "Green"],
  ["blue", "Blue"],
];

/** Every weight DetailAdvanced writes, space-separated, for the face's
 * data-params (the Inspector's coverage test reads it). */
export const DETAIL_WEIGHT_PARAMS = DETAIL_EFFECTS.flatMap((e) => DETAIL_WEIGHTS.map(([w]) => `${e}_${w}`)).join(" ");

/** The Detail Equalizer's five bands, finest first, and what each holds. */
export const DETAIL_EQ_BANDS: [string, string, string][] = [
  ["fine", "Fine", "The finest texture: pores, grain, fabric weave, noise"],
  ["small", "Small", "Small detail: leaves, hair, feathers, gravel"],
  ["medium", "Medium", "Medium structure: branches, rocks, facial features"],
  ["large", "Large", "Large forms: buildings, hillsides, clouds"],
  ["broad", "Broad", "Broad shapes: the light across whole areas of the frame"],
];

/** Every param the Detail Equalizer sub-section writes, space-separated,
 * for the face's data-params. */
export const DETAIL_EQ_PARAMS = [...DETAIL_EQ_BANDS.map(([p]) => p), ...DETAIL_WEIGHTS.map(([w]) => w)].join(" ");

export interface SectionSpec {
  title: string;
  /** Which layer tool this section edits. Present means the section
   * follows the selected layer (and so sits behind its mask); absent
   * means it is global no matter what is selected, which is only true of
   * the source and the crop. */
  layerTool?: LayerToolKey;
  node: (s: State) => NodeCard | undefined;
  rows: {
    label: string;
    param: string;
    centered?: boolean;
    node?: (s: State) => NodeCard | undefined;
    /** Renders a small sub-section kicker above this row. */
    heading?: string;
    /** Editorial slider span for this row, where the param's shared
     * range suits a different context. */
    range?: [number, number];
    /** The row is shown only while this holds (Noise Reduction's rows
     * follow its Method). */
    when?: (s: State) => boolean;
  }[];
  /** A line of plain words above the rows, for a section whose dials
   * need a sentence of context (Depth Map: whose settings these are). */
  note?: string;
  hasAuto?: boolean;
  /** Noise Reduction's measured Auto: estimates the source's noise
   * floor and SETS both sliders, visibly, one undo step. */
  noiseAuto?: boolean;
  /** Noise Reduction's Method row: Classic (the luma/chroma pair in
   * the graph) or Model (the SCUNet answer blended in), with the
   * model's status line under it. */
  denoiseMethod?: boolean;
  /** Tone Equalizer's parametric EQ widget above the rows */
  eqWidget?: boolean;
  /** Recolor's routing grid and curve widget, drawn just above its
   * Neutral guard row */
  recolorWidget?: boolean;
  /** the Color Tune's band strip and wheel above the rows */
  consoleWidget?: boolean;
  /** Lens: names the lensfun profile this photograph's lens matches
   *. */
  lensProfile?: boolean;
  /** Grid Warp: the tool, density, reach, heat, picks and edges chips
   * (src/ui/gridwarp.tsx). No slider rows: every number here is a
   * count, and the mesh itself is dragged in the viewport. */
  gridWarpWidget?: boolean;
  /** Geometry: Photo > Flip Horizontal and Flip Vertical as switches
   * (src/ui/flipphoto.tsx), the same component the crop node's
   * inspector mounts. */
  flipWidget?: boolean;
  /** Shape Warp: the list of shapes, the tool and mode, Amount, Twist
   * and Pinch on the picked shape, Edges (src/ui/shapewarp.tsx). */
  shapeWarpWidget?: boolean;
  /** Color Checker: the chart dropdown and the Place chart button
   * (src/ui/colorchecker.tsx), the same component the graph mounts on
   * the node. Amount stays an ordinary slider row. */
  colorCheckerWidget?: boolean;
  /** Color hosts the B&W treatment selector and nested channel mixer. */
  bwHost?: boolean;
  /** Every other node this section's controls write to. The on/off switch
   * bypasses all of them along with its own, because a section that
   * hosts a control has to be able to turn it off: Tone owns the curve
   * editor, Detail owns Sharpen and Denoise, Color owns the B&W
   * treatment. sectionNodes below is the contract that keeps this list
   * honest. */
  alsoToggles?: (s: State) => (NodeCard | undefined)[];
  /** Source has no meaningful enable switch: never disable the source. */
  hideToggle?: boolean;
  /** an off-by-default recipe: its nodes are spliced in on first use and
   * disabled rather than deleted when it is switched back off */
  recipe?: Recipe;
  /** The depth sections: renders the view-depth eye (and Key Light's
   * invert chip) above the rows. */
  depthTools?: "depthmap" | "fog" | "keylight" | "dof" | "flare" | "halation";
  /** Levels: the histogram with the three classic handles above the rows. */
  levelsWidget?: boolean;
  /** Exposure: the Zone System's ruler below the rows, since a placement
   * sets the two dials above it (2026-09-14: "Move Zones into the
   * Exposure section"). */
  zonesWidget?: boolean;
  /** Print: the paper's controls (src/ui/print.tsx), the same component
   * the graph mounts on the Print node. No slider rows: the grade and
   * the split pair swap places.*/
  printWidget?: boolean;
  /** Grain: the Film row above the dials (src/ui/grainfilm.tsx), the
   * stock's grain as a starting point; the same component the graph
   * mounts on the Grain node.*/
  grainFilmWidget?: boolean;
  /** Detail hosts the per-band and per-channel weighting for texture,
   * clarity and dehaze. */
  detailAdvanced?: boolean;
  /** Draw the Detail Equalizer's fold after the rows. */
  detailEq?: boolean;
}

/** The Source section's controls are not rows: they hang off the tone
 * profile node and render in their own block, in an order that was
 * chosen deliberately. Described once here so the keyboard and the panel
 * agree on what exists and what each one is called. */
export const SOURCE_ROWS: { label: string; param: string }[] = [
  { label: "Baseline", param: "baseline_ev" },
  { label: "Profile amt", param: "contrast" },
  { label: "Toe", param: "shadow_toe" },
  { label: "Highlight roll", param: "highlight_rolloff" },
  { label: "Colorfulness", param: "colorfulness" },
];

/** The panel as the keyboard sees it.
 *
 * Built from the same SECTIONS the panel renders from, so a control that
 * exists is reachable and one that does not is not offered. Sections
 * whose node is missing for this image drop out, which is why this takes
 * state rather than being a constant.
 */
export function navSections(state: State): SectionTargets[] {
  const out: SectionTargets[] = [];
  for (const sec of SECTIONS) {
    if (sectionHidden(state, sec)) continue;
    const node = sec.node(state);
    // Off the way the header's switch reads it: no node, or none of
    // its nodes live. (It used to be "no node", which was the same
    // thing while every off section had none; the sample now carries
    // its paid tools switched off, and a switched-off section is off.)
    const off = !sectionIsOn(state, sec);
    if (!node || off) {
      // Keyboard navigation "won't work on those that are turned
      // off." An off section has exactly one thing the keyboard can honestly
      // reach: its power switch. One target means picking the section's
      // letter lands straight on it, d turns it on, and the section's real
      // controls join the map on the next keystroke.
      if (!sec.hideToggle) {
        out.push({
          section: sec.title,
          targets: [
            {
              section: sec.title,
              label: "On / Off",
              param: "__switch__",
              kind: "switch",
              nodeId: "",
            },
          ],
        });
      }
      continue;
    }
    const targets: NavTarget[] = sec.rows.filter((row) => !row.when || row.when(state)).map((row) => ({
      section: sec.title,
      label: row.label,
      param: row.param,
      kind: "slider" as const,
      nodeId: (row.node?.(state) ?? node).id,
    }));
    if (sec.title === "Source") {
      const profile = state.nodes.find((n) => n.type === "heeler.tone_profile");
      // A profile switched off offers none of its rows: the panel hides
      // them, and none would act.
      if (profile && profile.enabled !== false) {
        for (const row of SOURCE_ROWS) {
          targets.push({
            section: sec.title,
            label: row.label,
            param: row.param,
            kind: "slider",
            nodeId: profile.id,
          });
        }
      }
    }
    // The wheels are not rows: they are two dimensional, which is the
    // whole reason the second pair of movement keys exists.
    if (sec.title === "Color Wheels") {
      for (const [label, range] of [
        ["Shadows", "shadows"],
        ["Mids", "midtones"],
        ["Highs", "highlights"],
      ] as const) {
        targets.push({
          section: sec.title,
          label,
          param: `${range}_hue`,
          kind: "wheel",
          nodeId: node.id,
        });
      }
    }
    if (targets.length > 0) out.push({ section: sec.title, targets });
  }
  return buildTargets(out);
}

/** A recipe category before its nodes exist.
 *
 * "Any category in the Develop that is off by default should
 * not create nodes until its been turned on." So this is what an untouched
 * category looks like: its name and its switch, and nothing in the graph
 * behind it.
 */
/** The nodes a switched-off category would build, so its controls can be
 * looked at without building them.
 *
 * "I should be able to expand disabled categories in Develop
 * mode to see the controls they have. They might be curious what the
 * controls are."
 *
 * A title and a switch answers nothing. The controls are the description of
 * what the category does, and a photographer deciding whether they want
 * split toning wants to see that it is two colors and a balance, not take
 * it on faith and find out.
 *
 * These are not in the graph and never go near the engine. They exist for
 * the length of a render so the panel has something to draw, and the moment
 * anybody moves one of them the real node is built underneath it.
 */
export function previewNodes(nodes: NodeCard[]): NodeCard[] {
  const have = new Set(nodes.map((n) => n.id));
  const out: NodeCard[] = [];
  for (const pieces of Object.values(CATEGORY_PIECES))
    for (const p of pieces)
      // The switch's own builder, so a tool group previews as the group
      // its build makes (its tool, dials and mode), and reads off.
      if (!have.has(p.id)) out.push({ ...categoryPieceNode(p, 0, 0), enabled: false });
  for (const p of [...denoisePieces(), ...skyPieces()])
    if (!have.has(p.id)) out.push(toCard(p, false));
  // Backfilled the same way a real node is, so a preview slider cannot be
  // missing a control the built node would have had.
  return migrateNodes(out);
}

/** Which build a command should be preceded by, if any. */
export function buildFor(
  id: string | undefined,
): { type: "set_category"; title: string; on: boolean } | { type: "set_recipe"; recipe: Recipe; on: boolean } | undefined {
  if (!id) return undefined;
  if (CATEGORY_OF[id]) return { type: "set_category", title: CATEGORY_OF[id], on: true };
  if (id.startsWith("dn_")) return { type: "set_recipe", recipe: "denoise", on: true };
  if (id.startsWith("sky_")) return { type: "set_recipe", recipe: "sky", on: true };
  return undefined;
}

/** Switches an off section on and opens it: a recipe builds its block
 * of nodes, a category builds its own. Exported because the keyboard
 * navigation drives the same switch (an off section's one nav target),
 * and two copies of "what turning a section on means" would drift. */
export function powerOnSection(sec: SectionSpec, dispatch: D, expand: boolean): void {
  if (sec.recipe) dispatch({ type: "set_recipe", recipe: sec.recipe, on: true });
  else dispatch({ type: "set_category", title: sec.title, on: true });
  // Unfolding is the user's preference (Interface, Open a section when
  // switched on), off by default.
  if (expand) dispatch({ type: "open_section", title: sec.title });
}

/** One sentence per section, shown in the status line when the
 * pointer rests on the section's name ("there needs to
 * be a summary about what the controls/attributes in that section
 * does"). Outcome first, plain words, per the hint rules.*/
export const SECTION_BLURBS: Record<string, string> = {
  Source: "The RAW's own development: white balance as shot, the tone profile, and the baseline everything else builds on",
  Exposure: "The picture's light: overall brightness, contrast in luminance and chroma, and how much room highlights and shadows keep",
  "Tone Equalizer": "Exposure by brightness zone: darken one zone, lift another, a graduated dodge over tones instead of places",
  Color: "White balance and color strength: temperature and tint, then saturation and vibrance's gentler hand",
  Levels: "Where black and white sit, and how the middle rises between them",
  Curves: "Tone as a drawn curve: points bend the picture's response, per channel or all at once",
  Print: "The paper the print is made on: a grade or the split pair with their times, the paper's black and base, toning by density",
  "Color Wheels": "Grade like a suite: push shadows, midtones, and highlights each toward a color of their own",
  "Color Tune": "Color by band: pick a hue range and move its hue, saturation, and brightness without touching the rest",
  "Color Bend": "Steer one color toward another: choose a source hue, aim it, and only that color moves",
  Recolor: "Reroute colors wholesale: a routing grid from the picture's hues to the ones you want",
  Detail: "Midtone contrast at three scales: texture for the fine grain, clarity for presence, dehaze for atmosphere",
  "Noise Reduction": "Quiet the sensor's noise by averaging similar patches, so flat areas calm down and edges stay edges",
  Sharpening: "Edge contrast: how much, how wide, and how much of the original color to keep",
  "Skin Softening": "Softens texture inside skin tones and leaves eyes, hair, and edges sharp",
  "Sky Rescue": "Brings a blown sky back: finds the sky, recovers its highlights, and blends the seam",
  Grain: "Film grain: amount and size, then how much rides each tonal band and channel",
  Vignette: "A darkened or brightened falloff toward the corners, placed on purpose. The lens's own vignetting is corrected in Lens",
  Fog: "Atmosphere by distance, from the depth model: how thick, where it starts, how it rolls in, and what it looks like",
  "Depth Map": "How the depth every depth tool reads is drawn from the photograph: Fog, Depth Lighting, Depth of Field, Recolor and Lens Character all share it",
  "Depth Lighting": "Relight the scene by its depth: suns and lamps, colored, bright or dark, with a rig in the viewer",
  "Depth of Field": "Focus that falls off with distance: pick the focal plane, open the aperture, and shape the lens's character",
  "Lens Flare": "The lens's flare for the rig's lights: glow, rays, aperture ghosts, streak and veil, hidden by what stands in front of the light",
  Halation: "Highlights bleed a colored mist into their dark surroundings, the film's own glow: what blooms, how far, what color, and a wider bloom with it",
  Geometry: "The frame itself: straighten, aspect, and the crop box",
  Lens: "The lens's corrections: distortion, color fringing at edges, and vignette",
  "Grid Warp": "A grid of handles over the photograph: drag them and the picture bends smoothly with them, before every mask and stroke",
  "Shape Warp": "Shapes placed over the photograph, each moving, twisting or pinching the picture under it; where shapes overlap they share the pull, so a still shape holds",
  "Color Checker": "Calibrates the camera against a photographed reference chart: the fit sets white balance, exposure and a 3x3 matrix so the chart's patches land on their published values",
};

/** One sentence per slider, keyed "Section|Label", shown in the
 * status line when the pointer rests on the row ("When
 * ever the mouse hovers a slider or its label, display a tool tip
 * on what it does"). Kept in one table beside the sections so a
 * renamed row fails loudly in the guard test rather than silently
 * losing its help.*/
/** The Source section's Sharpening buttons, outcome first. */

export const ROW_TIPS: Record<string, string> = {
  // Source: the tone profile's own dials, which render from their own
  // block rather than as rows and so had no line in the status bar
  // ("the attributes are missing help text").
  "Source|Baseline": "The lift the profile gives the RAW before your edits, in stops: what makes an unedited frame look developed rather than flat",
  "Source|Profile amt": "How much of the profile's curve is applied: 100 is the shipped look, less flattens toward the plain decode",
  "Source|Toe": "How dense the blacks stay under the profile: higher keeps shadows heavy, lower lets them lift",
  "Source|Highlight roll": "How softly the brightest values compress into white: higher holds more of a bright sky, lower clips sooner",
  "Source|Colorfulness": "The profile's color strength: pushes saturation up or back before the Color section sees it",
  "Exposure|Exposure": "Brighter or darker overall, in stops: one whole stop doubles the light",
  "Exposure|Luminance": "Contrast in brightness alone: colors keep their strength while tones spread apart",
  "Exposure|Chroma": "Contrast in color alone: saturated areas push further apart without changing brightness",
  "Exposure|Highlights": "Pulls the bright areas back down (left) or lifts them further (right)",
  "Exposure|Shadows": "Opens the dark areas up (right) or deepens them (left)",
  "Exposure|Whites": "Where the very brightest values sit: pull left to protect them from clipping",
  "Exposure|Blacks": "Where the very darkest values sit: pull left for solid blacks, right to lift them",
  "Tone Equalizer|Range shift": "Slides the zone boundaries so the zones grab brighter or darker parts of the picture",
  "Tone Equalizer|Smoothing": "Softens the transitions between zones so lifts and cuts blend instead of banding",
  "Color|Temp": "Warmer (right, toward amber) or cooler (left, toward blue)",
  "Color|Tint": "Green (left) against magenta (right): the other axis of white balance",
  "Color|Saturation": "All colors stronger or weaker, equally",
  "Color|Vibrance": "Strengthens the muted colors first and goes easy on skin and what is already rich",
  "Levels|Black point": "The input level that becomes pure black: raise it to deepen the shadows",
  "Levels|White point": "The input level that becomes pure white: lower it to brighten toward clipping",
  "Levels|Gamma": "How the middle rises between the two points: brighter or darker midtones",
  "Levels|Black falloff": "A soft knee at the black point: shadows roll into black instead of snapping",
  "Levels|White falloff": "A soft knee at the white point: highlights roll into white instead of clipping",
  "Color Bend|Falloff": "How far around the chosen hue the bend reaches: narrow takes one color, wide takes its neighbors",
  "Color Bend|Amount": "How far the source color travels toward the destination",
  "Color Tune|Smoothing": "Softens the band edges so neighboring hues blend instead of posterizing",
  "Recolor|Neutral guard": "Keeps grays and near-grays out of the Hue rows, whose hue is mostly noise. Lower it for muted scenes (dusk, haze, overcast) when a Hue curve barely changes the picture; the strip below shows how much it holds back",
  "Recolor|Smoothing": "Softens the mapping's edges so routed and unrouted colors meet cleanly",
  "Detail|Unsharp": "Classic unsharp masking layered over Texture and Clarity: broad, film-era sharpening",
  "Sharpening|Intensity": "How much edge contrast is added",
  "Skin Softening|Softening": "How much the skin's texture is smoothed",
  "Skin Softening|Strength": "How strongly the softening applies inside the detected skin",
  "Skin Softening|Detail back": "Returns fine texture the softening took, so skin stays skin instead of plastic",
  "Sky Rescue|Threshold": "How bright a region must be to count as sky",
  "Detail|Texture": "Emphasizes or softens surface detail, with edge protection; its scale follows the frame",
  "Detail|Clarity": "Broader local contrast with edge protection; use Advanced to keep it out of shadows or highlights",
  "Detail|Dehaze": "Reduces a neutral veil and restores color (right), or adds a neutral veil (left)",
  "Detail|Radius": "Width of Unsharp detail in pixels: small favors fine detail, large adds broader contrast",
  "Detail|Threshold": "How much detail a spot needs before Unsharp touches it: protects sky, skin and noise, and reaches fewer edges as it rises",
  "Detail|Smoothing": "Softens fine detail: the gentle opposite of Texture",
  "Vignette|Amount": "How far the corners fall away, or rise: negative darkens them, positive lifts them",
  "Vignette|Midpoint": "Where the falloff sits between the center and the corners: lower reaches further in",
  "Vignette|Softness": "How gradual the shoulder is, from a hard edge to a slow fade",
  "Grain|Grain amount": "How much grain lies over the picture",
  "Grain|Grain size": "The size of the grain clumps, from fine stock to coarse",
  "Grain|Shadow grain": "How much of the grain rides the shadows",
  "Grain|Midtone grain": "How much of the grain rides the midtones",
  "Grain|Highlight grain": "How much of the grain rides the highlights",
  "Grain|Red grain": "Grain strength in the red channel: uneven channels read as color grain",
  "Grain|Green grain": "Grain strength in the green channel",
  "Grain|Blue grain": "Grain strength in the blue channel",
  "Fog|Density": "How thick the fog is at full distance",
  "Fog|Start distance": "Where the fog begins: 0 at the lens, higher pushes it back into the scene",
  "Fog|Falloff": "How the fog arrives: low front-loads it, 50 is a straight ramp, high holds it off then rolls it in late",
  "Fog|Fog brightness": "The veil's own light: high is a daylight haze, low is night haze and smoke that darkens",
  "Fog|Texture": "Drifts in the veil instead of a flat wash",
  "Fog|Texture size": "The drifts' size, from rolling banks to fine wisps",
  "Fog|Texture shift": "Walks the drifts to a different arrangement, so two fogs never match",
  "Fog|Fog hue": "The color the fog leans toward",
  "Fog|Fog color": "How strongly the fog wears its hue: 0 is neutral gray",
  "Fog|Far desaturate": "Aerial perspective: the far scene loses its own color before the fog lays over",
  "Depth Map|Edges": "How firmly the depth's edges are snapped onto the photograph's: takes the halo off a subject against its background",
  "Depth Map|Flatten": "How much of the depth's ripple is smoothed out of what the photograph shows as flat: walls, sky, skin",
  "Depth Map|Near clip": "How much of the nearest depth is folded into 'nearest': spreads the rest of the scene when one close thing eats the range",
  "Depth Map|Far clip": "How much of the farthest depth is folded into 'farthest': spreads the rest of the scene when the far end is one flat wall or sky",
  "Depth Lighting|Ambient": "How dark the unlit side of things goes: high is soft fill, low is hard shadow",
  "Depth Lighting|Relief": "How much height the depth is worth: how strongly surfaces catch and lose the light",
  "Depth of Field|Aperture": "How far out of focus the rest of the scene falls: 0 is everything sharp",
  "Depth of Field|Focus distance": "The distance that stays sharp: 0 the nearest thing, 100 the farthest, or click Set focus",
  "Depth of Field|Blades": "How many aperture blades shape the bokeh: fewer reads more vintage",
  "Depth of Field|Blade curve": "From hard-edged polygon bokeh (left) to fully round (right)",
  "Depth of Field|Fringing": "Color splitting on out-of-focus edges: magenta behind the focal plane, green in front",
  "Depth of Field|Field curvature": "Bends the focal plane: negative focuses the edges nearer than the center, the vintage look",
  "Depth of Field|Glow": "A soft halo around bright in-focus points: the under-corrected wide-open look",
  "Depth of Field|Bubble": "The soap-bubble bokeh: a bright rim over a hollow center on the right, a flat disc on the left",
  "Depth of Field|Squeeze": "The disc squeezed tall (left, the anamorphic oval) or wide (right)",
  "Depth of Field|Swirl": "Discs stretch around the frame's center the farther out they sit: the spinning field of a Petzval or a Helios",
  "Lens Flare|Intensity": "How bright the whole flare is; each light's own flare strength multiplies it",
  "Lens Flare|Temp": "Warms (right) or cools (left) every element of the flare",
  "Lens Flare|Size": "The source glow's radius, as a share of the frame's short side",
  "Lens Flare|Falloff": "How the glow falls off: a hard disc on the left, a haze on the right",
  "Lens Flare|Rays": "How many diffraction rays the star has; a real aperture makes twice as many as it has sides",
  "Lens Flare|Length": "How far the rays reach, as a share of the frame's short side",
  "Lens Flare|Ray softness": "How wide each ray is around its direction",
  "Lens Flare|Rotation": "Turns the star",
  "Lens Flare|Ghosts": "How many aperture images walk away from the light through the frame's center",
  "Lens Flare|Spacing": "How far along that axis the chain of ghosts spreads",
  "Lens Flare|Ghost size": "How big the first ghost is; later ones taper",
  "Lens Flare|Blades": "The aperture's blade count, which is the ghosts' shape",
  "Lens Flare|Dispersion": "Color fringing on the ghosts' edges",
  "Lens Flare|Ghost opacity": "How strongly the ghosts show",
  "Lens Flare|Strength": "How bright the anamorphic streak is; none on the left",
  "Lens Flare|Thickness": "How thick the streak is, as a share of the frame's short side",
  "Lens Flare|Reach": "How far the streak reaches from the source, as a share of the frame's short side",
  "Lens Flare|Taper": "How much the streak thins toward its ends",
  "Lens Flare|Angle": "Turns the streak; anamorphic glass makes it horizontal",
  "Lens Flare|Offset": "Slides the streak along its own line, away from the source",
  "Lens Flare|Shift": "Slides the streak across its line, above or below the source",
  "Lens Flare|Breakup": "The streak swelling and thinning, denser and sparser, along its length; a clean ribbon on the left",
  "Halation|Threshold": "The brightness a highlight must reach to bloom, in stops above middle gray; lower lets dimmer lights bloom",
  "Halation|Background gain": "How dark the surroundings must be for the bloom to show: halation hides against a bright field, so this keeps it to high-contrast borders",
  "Halation|By depth": "Weights the bloom by distance on the depth plane: far highlights bloom more (right) or less (left)",
  "Halation|Spread": "How far the light leaks from the highlight's edge, as a share of the frame's short side; the film format scales it",
  "Halation|Diffusion": "The halo's shape: a hard visible ring on the left, a soft blended gradient on the right",
  "Halation|Hue": "The glow's hue; the red-orange of film by default",
  "Halation|Saturation": "How vivid the glow is; zero is the white mist",
  "Halation|Blue comp": "Blue compensation: keeps the bloom visible on blue highlights, like skies, that would neutralize a red halo",
  "Halation|Strength": "How bright the bloom is",
  "Halation|Mix": "How much of the finished bloom shows over the frame",
  "Halation|Bloom": "A wider, neutral glow around the same sources, the diffusion-filter look",
  "Halation|Bloom radius": "How far the bloom reaches",
  "Lens Flare|Veil": "The low haze that lifts the blacks around the light",
  "Lens Flare|Veil radius": "How far the veil reaches",
  "Lens Flare|Veil by depth": "Lands the veil on the far plane (right) or the near one (left)",
  "Lens Flare|Amount": "How much something nearer than the light hides the flare, read from the depth plane",
  "Lens Flare|Softness": "How gently the flare fades as the light is covered",
  "Geometry|Straighten": "Rotates the picture level: degrees either way",
  "Geometry|Aspect": "Squeezes or stretches the frame's proportions: negative widens, positive heightens",
  "Geometry|Crop width": "The crop box's width",
  "Geometry|Crop height": "The crop box's height",
  "Geometry|Crop left": "Slides the crop box left and right",
  "Geometry|Crop top": "Slides the crop box up and down",
  "Lens|Distortion": "Straightens barrel (bulge) or pincushion (pinch) bending",
  "Lens|Fringe R/C": "Removes red and cyan color fringing along hard edges",
  "Lens|Fringe B/Y": "Removes blue and yellow color fringing along hard edges",
  "Lens|Lens vignetting": "Undoes the corner falloff this lens puts there: right brightens the corners back up. For a falloff you WANT, use the Vignette section",
  "Lens|Lens vig. range": "How far from the corners the vignette correction reaches",
  "Noise Reduction|Luminance": "Quiets brightness noise: the speckle",
  "Noise Reduction|Chroma": "Quiets color noise: the confetti",
  "Noise Reduction|Edge detail": "Returns the fine luminance the model took, where its own answer shows an edge; flat areas stay quiet",
  "Sharpening|Radius": "How wide each edge's sharpening halo is: keep small for fine detail",
  "Sharpening|Keep color": "Sharpens the brightness and leaves the color as it was; lower lets the recipe recolor the edges, which reads as a green rim on a dark spot",
  "Sky Rescue|Recovery": "How hard the recovered sky is pulled back down",
  "Sky Rescue|Feather": "Softens the seam where the rescued sky meets the land",
  "Color Checker|Amount": "How much of the fitted calibration is applied: 100 is the full fit, 0 is the photograph as shot",
  "Color Checker|Sample": "The sample circle's size as a percent of the chart cell: the overlay draws it and Calibrate measures exactly that region",
};

/** On means ANY of the section's nodes is live, the same set the
 * header's switch flips, and only nodes that are IN the graph count:
 * the rows' stand-ins are born on, and counting them lit Detail
 * whenever its node existed. One predicate for the switch, the
 * keyboard navigator and the On filter, so they cannot disagree. */
export function sectionIsOn(state: State, sec: SectionSpec): boolean {
  const live = (n?: NodeCard | null) => !!n && n.enabled && state.nodes.some((k) => k.id === n.id);
  return live(sec.node(state)) || (sec.alsoToggles?.(state) ?? []).some(live);
}

/** Whether a section has been taken out of the panel in Preferences.
 * Source cannot be: it has no switch to lose. */
export function sectionHidden(state: State, sec: SectionSpec): boolean {
  return !sec.hideToggle && state.prefs.hiddenSections.includes(sec.title);
}

/** The sections a user can hide, and the count hidden now. */
export function hiddenSectionCount(state: State): number {
  return SECTIONS.filter((sec) => sectionHidden(state, sec)).length;
}

/** The section titles the panel lists, in the order it lists them: the
 * pinned ones first, in the order they were pinned, then the rest in
 * the panel's own order; narrowed by the filter. Unknown pinned titles
 * (a section renamed since) are skipped. Exported for the tests and
 * for anything else that must agree with the panel. */
export function visibleSections(state: State): { sections: SectionSpec[]; pinnedCount: number } {
  // A section hidden in Preferences leaves every view, pinned or not;
  // its node is untouched (sectionHidden).
  const pinned = state.prefs.pinnedSections
    .map((title) => SECTIONS.find((sec) => sec.title === title))
    .filter((sec): sec is SectionSpec => !!sec && !sectionHidden(state, sec));
  const rest = SECTIONS.filter((sec) => !state.prefs.pinnedSections.includes(sec.title) && !sectionHidden(state, sec));
  if (state.sectionFilter === "pinned") return { sections: pinned, pinnedCount: pinned.length };
  if (state.sectionFilter === "on") {
    const on = [...pinned, ...rest].filter((sec) => sectionIsOn(state, sec));
    return { sections: on, pinnedCount: on.filter((sec) => pinned.includes(sec)).length };
  }
  return { sections: [...pinned, ...rest], pinnedCount: pinned.length };
}

export const SECTIONS: SectionSpec[] = [
  {
    title: "Source",
    node: (s) => s.nodes.find((n) => n.type === "heeler.image_source"),
    rows: [],
    hideToggle: true,
  },
  {
    title: "Exposure",
    layerTool: "adj",
    node: (s) => toolNode(s, "adj"),
    zonesWidget: true,
    rows: [
      { label: "Exposure", param: "exposure" },
      // Contrast, decomposed. The majors hard-wire one blend of
      // these two ("this is where both companies missed the mark"). Luminance is
      // tonal punch with chroma untouched; Color steepens the channels against
      // each other at constant luminance, which is where saturating darks come
      // from. One reference editor's Contrast is roughly Luminance + some Color;
      // the other couples Color harder.
      { label: "Luminance", param: "contrast", heading: "Contrast" },
      { label: "Chroma", param: "color_contrast" },
      { label: "Highlights", param: "highlights", heading: "Range" },
      { label: "Shadows", param: "shadows" },
      { label: "Whites", param: "whites" },
      { label: "Blacks", param: "blacks" },
    ],
  },
  {
    title: "Color",
    layerTool: "color",
    node: (s) => toolNode(s, "color"),
    hasAuto: true,
    bwHost: true,
    alsoToggles: (s) => [toolNode(s, "bw")],
    rows: [
      { label: "Temp", param: "temperature" },
      { label: "Tint", param: "tint" },
      { label: "Saturation", param: "saturation" },
      { label: "Vibrance", param: "vibrance" },
    ],
  },
  {
    // Its own section, above Curves. "Putting the levels
    // sliders inside the Curves section is nothing short of
    // confusing."
    title: "Levels",
    layerTool: "levels",
    levelsWidget: true,
    node: (s) => toolNode(s, "levels"),
    rows: [
      { label: "Black point", param: "black", centered: false },
      { label: "White point", param: "white", centered: false },
      { label: "Gamma", param: "gamma", centered: false },
      { label: "Black falloff", param: "black_soft", centered: false },
      { label: "White falloff", param: "white_soft", centered: false },
    ],
  },
  {
    // The curve alone now, and its switch reads the curve's own node:
    // an unedited photograph shows Curves off because it IS off.
    title: "Curves",
    layerTool: "curves",
    node: (s) => toolNode(s, "curves"),
    rows: [],
  },
  {
    // The print: the paper the finished picture is printed on, after
    // Levels and Curves have shaped the negative-to-print. The owner named
    // the section (2026-09-14): Film is a block in the treatment, Print is
    // the section.
    title: "Print",
    layerTool: "paper",
    printWidget: true,
    node: (s) => toolNode(s, "paper"),
    rows: [],
  },
  {
    // Below Curves. Both reshape tones, and this is the one you reach
    // for second: Curves is the general instrument, Tone Equalizer is the
    // zone-by-zone re-exposure you do once the curve is settled.
    //
    // The zone system's simple face: three of the node's nine zones,
    // the ones people mean when they say shadows, midtones,
    // highlights. The graph inspector is the expert face with all
    // nine.
    title: "Tone Equalizer",
    eqWidget: true,
    layerTool: "toneeq",
    node: (s) => toolNode(s, "toneeq"),
    // The sliders that survived the EQ redesign (kill sliders
    // except what does not fit the curve): the widget is the control.
    rows: [
      { label: "Range shift", param: "range_shift" },
      { label: "Smoothing", param: "smoothing", centered: false },
    ],
  },
  {
    title: "Color Wheels",
    layerTool: "wheels",
    node: (s) => toolNode(s, "wheels"),
    rows: [],
  },
  {
    // Per-hue-family grading strips: the hue-indexed sibling of the
    // tonal Color Wheels above it.
    title: "Color Tune",
    consoleWidget: true,
    layerTool: "colorconsole",
    node: (s) => toolNode(s, "colorconsole"),
    rows: [{ label: "Smoothing", param: "smoothing", centered: false }],
  },
  {
    // "Color Bend", matching its node: plain "Bend" said nothing about
    // what it bends.
    title: "Color Bend",
    layerTool: "bend",
    node: (s) => toolNode(s, "bend"),
    rows: [
      { label: "Falloff", param: "falloff", centered: false },
      { label: "Amount", param: "amount", centered: false },
    ],
  },
  {
    // The channel-routing color EQ: after Color Bend, per the
    // design session.
    title: "Recolor",
    recolorWidget: true,
    layerTool: "recolor",
    node: (s) => toolNode(s, "recolor"),
    rows: [
      { label: "Smoothing", param: "smoothing", centered: false },
      // Drawn under the routing grid and curve, which render just above
      // this row.
      { label: "Neutral guard", param: "neutral_guard", centered: false },
    ],
  },
  {
    title: "Detail",
    layerTool: "detail",
    node: (s) => toolNode(s, "detail"),
    detailAdvanced: true,
    detailEq: true,
    // Unsharp, Smoothing and the Equalizer are their own nodes, so the
    // section switch has to reach them as well.
    alsoToggles: (s) => [toolNode(s, "sharpen"), toolNode(s, "denoise"), toolNode(s, "detaileq")],
    rows: [
      { label: "Texture", param: "texture" },
      { label: "Clarity", param: "clarity" },
      // One slider, both halves: luminance veil and color recovery move
      // together. Dehaze briefly had the Contrast-style Luminance/Chroma
      // split; the owner reverted it because the advanced per-band weighting
      // below already slices dehaze, and two decompositions of one control is
      // a question nobody should have to answer.
      { label: "Dehaze", param: "dehaze" },
      {
        // Renamed once the recipe category became plain "Sharpening": two
        // controls with the same name at different levels of the panel is
        // a question nobody should have to answer. This one is the plain
        // unsharp mask that has always been here.
        label: "Unsharp",
        // The engine's sharpen op reads `amount`. This wrote `sharpening`, which
        // no node in the registry declares, so the slider moved and nothing
        // happened. Found while answering the owner's question about what
        // attributes a node has that Develop does not show.
        param: "amount",
        centered: false,
        node: (s) => toolNode(s, "sharpen"),
      },
      // Unsharp's other two dials, which the engine has always read and the
      // panel never offered. Without them the sharpening was amount at a
      // fixed 1px radius and no threshold. Nothing was needed from the engine
      // or the registry:
      // ops_detail.rs already reads both, and PARAM_RANGE_BY_TYPE already spans
      // them.
      {
        label: "Radius",
        param: "radius",
        centered: false,
        node: (s) => toolNode(s, "sharpen"),
      },
      {
        // The floor a difference must clear before it is sharpened at
        // all, which is what keeps an unsharp mask off flat sky and skin.
        label: "Threshold",
        param: "threshold",
        centered: false,
        node: (s) => toolNode(s, "sharpen"),
      },
      {
        // Named for what it does, not for what it is aimed at, which is the same
        // choice Unsharp makes two rows up. It was "Noise Red.", which promised
        // to be THE noise control and then sat next to a Noise Reduction section
        // that is the fuller one: On trying to explain the pair to somebody, "I
        // just don't want to answer dumb user questions."
        //
        // So the pattern is stated once and holds twice. The Detail row
        // is the quick technique and follows the selected layer, so it
        // can work behind a mask. The section is the outcome, has the
        // control that matters, and is always the whole photograph.
        label: "Smoothing",
        param: "strength",
        centered: false,
        node: (s) => toolNode(s, "denoise"),
      },
    ],
  },
  // Noise reduction, as a pipeline rather than a slider.
  //
  // Detail's Smoothing slider above stays exactly where it is and keeps
  // driving heeler.denoise. The two are not rivals and the names now say
  // so: Smoothing is one dial over the whole picture (or over a layer's
  // mask), and set both dials here to the same number and you get it back
  // exactly, which is a test rather than a claim. What this section adds
  // is the second dial, and that is the whole of the difference: chroma
  // noise can be smoothed hard because color changes slowly, while luma
  // noise sits next to the detail and cannot.
  //
  // It reads directly under Detail because that is where somebody
  // fighting noise is already looking, and above Sharpening because that
  // is the order the two run in.
  {
    title: "Noise Reduction",
    recipe: "denoise",
    noiseAuto: true,
    denoiseMethod: true,
    node: (s) => s.nodes.find((n) => n.id === "dn_luma_nr"),
    // The Model method's node takes the section's switch when it is the
    // method (2026-09-09): on in either method reads as on.
    alsoToggles: (s) => [s.nodes.find((n) => n.id === MODEL_DENOISE_ID)],
    rows: [
      {
        // Not "Color": there is a Color section, and a control named
        // after a different section is a question nobody should have to
        // answer. Luminance and Chroma is the pair Exposure already uses
        // for the same decomposition, so the panel says it one way.
        label: "Luminance",
        param: "strength",
        centered: false,
        node: (s) => s.nodes.find((n) => n.id === "dn_luma_nr"),
        when: (s) => !denoiseMethodIsModel(s.nodes),
      },
      {
        label: "Chroma",
        param: "strength",
        centered: false,
        node: (s) => s.nodes.find((n) => n.id === "dn_color_nr"),
        when: (s) => !denoiseMethodIsModel(s.nodes),
      },
      // The Model method's three: the same two names, meaning the same
      // two halves of the model's answer, and Edge detail, the dial the
      // model needs (the fine luminance it took, returned on edges).
      {
        label: "Luminance",
        param: "luminance",
        centered: false,
        node: (s) => s.nodes.find((n) => n.id === MODEL_DENOISE_ID),
        when: (s) => denoiseMethodIsModel(s.nodes),
      },
      {
        label: "Chroma",
        param: "chroma",
        centered: false,
        node: (s) => s.nodes.find((n) => n.id === MODEL_DENOISE_ID),
        when: (s) => denoiseMethodIsModel(s.nodes),
      },
      {
        // Not "Detail": there is a Detail section, and a control named
        // after another section is the question the Luminance row's
        // note already refuses to ask.
        label: "Edge detail",
        param: "detail",
        centered: false,
        node: (s) => s.nodes.find((n) => n.id === MODEL_DENOISE_ID),
        when: (s) => denoiseMethodIsModel(s.nodes),
      },
    ],
  },
  // The owner's first two recipes, behind one switch. "I could a single
  // Sharpening category with a toggle button to switch between Vivid and Hi
  // Pass, and other hood that rewires the node graph."
  //
  // Off by default, so the nodes are not in the graph until it is turned
  // on, and disabled rather than deleted when it is turned off again.
  {
    // One node since 2026-09-03 (heeler.sharpening), so it rides a layer
    // behind its mask. "I've done plenty of masked sharpening
    // in landscapes when I found it creating artifacts in water reflections
    // or sky details. Like I wanted to sharpen the ground, but not the
    // clouds."
    title: "Sharpening",
    layerTool: "sharpening",
    node: (s) => toolNode(s, "sharpening"),
    rows: [
      {
        // The blur radius in Vivid, the high pass radius in Hi Pass. Both
        // are the same idea: how thick the sharpening lines are.
        label: "Radius",
        param: "radius",
        centered: false,
        // "A user may be able to manually type in a great value but
        // I doubt they'd go over 50 much, if at all." The node's 0..200 span
        // stays for the field; the drag works where the work is.
        range: [0, 50],
      },
      { label: "Intensity", param: "intensity", centered: false },
      // The Color blend at the recipe's end: the sharpening lands on
      // the brightness and the color stays the picture's
      // (2026-09-23, the green rim along the jaguar's spots).
      { label: "Keep color", param: "keep_color", centered: false },
    ],
  },
  // Skin Softening reads above Effects: retouching a face is part of
  // finishing the subject; grain is a treatment over the whole frame.
  // The owner set it apart from the start: "I think the skin softening
  // in third recipe is its own thing, also off by default." One node
  // since 2026-09-03, so a face mask scopes it.
  {
    title: "Skin Softening",
    layerTool: "skin",
    node: (s) => toolNode(s, "skin"),
    rows: [
      {
        label: "Softening",
        param: "softening",
        centered: false,
        // "20 is probably the max anyone would possibly use." The
        // node's 0..200 span belongs to sharpening contexts; skin works in
        // single digits. Typing past 20 still works.
        range: [0, 20],
      },
      { label: "Detail back", param: "detail_back", centered: false, range: [0, 50] },
      { label: "Strength", param: "strength", centered: false },
    ],
  },
  // Sky Rescue is the first recipe built on the logic family: a measure
  // node reads the feed's luminance, a compare node turns that into a soft
  // sky mask (Blend If, as a node), and a conditional node lets an
  // exposure grade through only where the mask says "sky". The owner's
  // framing: "what if Blend If could drive color correction, not just
  // blending." Off by default like the other recipes; three sliders are
  // the whole surface because the point is that the graph does the
  // thinking.
  {
    title: "Sky Rescue",
    recipe: "sky",
    node: (s) => s.nodes.find((n) => n.id === "sky_if"),
    rows: [
      {
        // The compare level: how bright a pixel must be before the mask
        // claims it as sky.
        label: "Threshold",
        param: "level",
        centered: false,
        node: (s) => s.nodes.find((n) => n.id === "sky_cond"),
      },
      {
        // The compare softness: how gradual the mask's edge is. This is
        // the Blend If feather.
        label: "Feather",
        param: "softness",
        centered: false,
        node: (s) => s.nodes.find((n) => n.id === "sky_cond"),
      },
      {
        // The exposure node's highlights: how hard the recovered sky is
        // pulled back down. No `centered`: it follows the Light section's
        // Highlights row, same param on the same node type.
        label: "Recovery",
        param: "highlights",
        node: (s) => s.nodes.find((n) => n.id === "sky_fix"),
      },
    ],
  },
  {
    // A look, not the lens fix. Lens Correction's `vignette` undoes what
    // the glass did; this one puts a falloff there on purpose, and the
    // two live in different sections so nobody reaches for the wrong
    // one. It sits above Grain because that is the order it runs in.
    //
    // The op has shipped in the engine since ops_stylize was written and
    // had no seat in Develop until now: reachable only by adding the node
    // by hand in Graph, which is not a feature so much as a rumor.
    title: "Vignette",
    node: (s) => s.nodes.find((n) => n.type === "heeler.vignette"),
    rows: [
      { label: "Amount", param: "vignette" },
      { label: "Midpoint", param: "vignette_mid", centered: false },
      { label: "Softness", param: "softness", centered: false },
    ],
  },
  {
    // Named for what is in it. It was "Effects" and held one effect,
    // which is what the owner noticed.
    title: "Grain",
    layerTool: "grain",
    grainFilmWidget: true,
    node: (s) => toolNode(s, "grain"),
    rows: [
      // The engine's grain op reads `intensity` and `size`. These wrote
      // `grain_amount` and `grain_size`, which no node declares, so both
      // sliders moved and nothing happened. The same mistake as Sharpening,
      // found by the same guard.
      { label: "Grain amount", param: "intensity", centered: false },
      { label: "Grain size", param: "size", centered: false },
      { label: "Shadow grain", param: "shadows_gain", centered: false },
      { label: "Midtone grain", param: "midtones_gain", centered: false },
      { label: "Highlight grain", param: "highlights_gain", centered: false },
      { label: "Red grain", param: "red_gain", centered: false },
      { label: "Green grain", param: "green_gain", centered: false },
      { label: "Blue grain", param: "blue_gain", centered: false },
    ],
  },
  // The depth tools: shaped by the photograph's computed depth (Depth
  // Anything V2 Small, downloaded on consent like every model). Each
  // is an identity at zero and an identity without depth, so the
  // sections are safe to show everywhere; the DepthRunner computes
  // the depth plane the first time any of these dials moves.
  {
    // The depth map's settings (2026-09-05): ahead of the first tool
    // that reads the map, so the map is made before it is used.
    title: "Depth Map",
    depthTools: "depthmap",
    note: "This photograph's own depth settings. They start at the defaults in Preferences and Reset returns to them; switched off, every depth tool reads the raw map.",
    node: (s) => s.nodes.find((n) => n.type === "heeler.depth_map"),
    rows: [
      { label: "Edges", param: "edges", centered: false },
      { label: "Flatten", param: "flatten", centered: false },
      { label: "Near clip", param: "near_clip", centered: false },
      { label: "Far clip", param: "far_clip", centered: false },
    ],
  },
  {
    title: "Fog",
    layerTool: "fog",
    depthTools: "fog",
    node: (s) => toolNode(s, "fog"),
    rows: [
      { label: "Density", param: "density", centered: false },
      { label: "Start distance", param: "start", centered: false },
      { label: "Falloff", param: "falloff", centered: false },
      { label: "Fog brightness", param: "fog_level", centered: false },
      { label: "Texture", param: "texture", centered: false },
      { label: "Texture size", param: "texture_size", centered: false },
      { label: "Texture shift", param: "texture_shift", centered: false },
      { label: "Fog hue", param: "fog_hue", centered: false },
      { label: "Fog color", param: "fog_sat", centered: false },
      { label: "Far desaturate", param: "desat", centered: false },
    ],
  },
  {
    // Depth Lighting (the owner's rename once the rig grew point
    // lights). Per-light dials live with the SELECTED light in the rig
    // controls; these rows are the scene's: how dark the unlit side of
    // things goes, and how much height the depth is worth.
    title: "Depth Lighting",
    layerTool: "keylight",
    depthTools: "keylight",
    node: (s) => toolNode(s, "keylight"),
    rows: [
      { label: "Ambient", param: "ambient", centered: false },
      { label: "Relief", param: "relief", centered: false },
    ],
  },
  {
    title: "Depth of Field",
    layerTool: "dof",
    depthTools: "dof",
    node: (s) => toolNode(s, "dof"),
    rows: [
      { label: "Aperture", param: "aperture", centered: false },
      { label: "Focus distance", param: "focus", centered: false },
      { label: "Blades", param: "blades", centered: false },
      { label: "Blade curve", param: "blade_curve", centered: false },
      { label: "Fringing", param: "fringe", centered: false },
      { label: "Field curvature", param: "field_curve" },
      { label: "Glow", param: "glow", centered: false },
      // The disc's character.
      { label: "Bubble", param: "bubble", centered: false, heading: "Character" },
      { label: "Squeeze", param: "squeeze" },
      { label: "Swirl", param: "swirl", centered: false },
    ],
  },
  {
    // The lens flare: the rig is Depth Lighting's; these rows
    // are the lens's look.
    title: "Lens Flare",
    layerTool: "flare",
    depthTools: "flare",
    node: (s) => toolNode(s, "flare"),
    rows: [
      { label: "Intensity", param: "intensity", centered: false },
      { label: "Temp", param: "temp" },
      { label: "Size", param: "size", centered: false, heading: "Source" },
      { label: "Falloff", param: "softness", centered: false },
      { label: "Rays", param: "rays", centered: false, heading: "Rays" },
      { label: "Length", param: "ray_length", centered: false },
      { label: "Ray softness", param: "ray_softness", centered: false },
      { label: "Rotation", param: "rotation", centered: false },
      { label: "Ghosts", param: "ghosts", centered: false, heading: "Ghosts" },
      { label: "Spacing", param: "ghost_spacing", centered: false },
      { label: "Ghost size", param: "ghost_size", centered: false },
      { label: "Blades", param: "blades", centered: false },
      { label: "Dispersion", param: "dispersion", centered: false },
      { label: "Ghost opacity", param: "ghost_opacity", centered: false },
      // The anamorphic streak, a group of its own: its strength, shape,
      // angle, offset from the source, and grain; its color ribbon sits
      // below the rows.
      { label: "Strength", param: "anamorphic", centered: false, heading: "Anamorphic" },
      { label: "Thickness", param: "streak_size", centered: false },
      { label: "Reach", param: "streak_length", centered: false },
      { label: "Taper", param: "streak_taper", centered: false },
      { label: "Angle", param: "streak_angle" },
      { label: "Offset", param: "streak_offset" },
      { label: "Shift", param: "streak_shift" },
      { label: "Breakup", param: "streak_noise", centered: false },
      { label: "Veil", param: "veil", centered: false, heading: "Veil" },
      { label: "Veil radius", param: "veil_radius", centered: false },
      { label: "Veil by depth", param: "veil_depth" },
      // Its own group: both dials are the occlusion, so the heading
      // carries the word and the labels stay short enough to sit beside
      // their sliders.
      { label: "Amount", param: "occlusion", centered: false, heading: "Occlusion" },
      { label: "Softness", param: "occlusion_soft", centered: false },
    ],
  },
  {
    // Halation: the film's glow around highlights, with the
    // isolated-regions eye and the format menu in its chips.
    title: "Halation",
    layerTool: "halation",
    depthTools: "halation",
    node: (s) => toolNode(s, "halation"),
    rows: [
      { label: "Threshold", param: "threshold", centered: false, heading: "Source" },
      { label: "Background gain", param: "background", centered: false },
      { label: "By depth", param: "by_depth" },
      { label: "Spread", param: "radius", centered: false, heading: "Spread" },
      { label: "Diffusion", param: "diffusion", centered: false },
      { label: "Hue", param: "hue", centered: false, heading: "Color" },
      { label: "Saturation", param: "saturation", centered: false },
      { label: "Blue comp", param: "blue_comp", centered: false },
      { label: "Strength", param: "amount", centered: false, heading: "Intensity" },
      { label: "Mix", param: "mix", centered: false },
      { label: "Bloom", param: "bloom", centered: false, heading: "Bloom" },
      { label: "Bloom radius", param: "bloom_radius", centered: false },
    ],
  },
  // Geometry and Lens close the panel out: the sections above are the
  // look, these two are the physical frame, and the owner wants the panel
  // read top to bottom in that order.
  {
    title: "Geometry",
    node: (s) => s.nodes.find((n) => n.type === "heeler.crop_rotate"),
    flipWidget: true,
    rows: [
      { label: "Straighten", param: "angle" },
      // The RAW editors' Transform vocabulary: negative widens, positive heightens.
      { label: "Aspect", param: "aspect" },
      { label: "Crop width", param: "crop_w", centered: false },
      { label: "Crop height", param: "crop_h", centered: false },
      { label: "Crop left", param: "crop_x", centered: false },
      { label: "Crop top", param: "crop_y", centered: false },
    ],
  },
  // Grid Warp (2026-09-06): the mesh warp of the whole frame, in
  // Adjustments because it is geometry, like Straighten: it sits
  // upstream of every mask and stroke, so what is painted afterwards
  // lands where it was painted. Directly below Geometry in the panel,
  // where the owner expected it; in the chain it runs after the lens,
  // so the optics are corrected before the picture is reshaped.
  {
    title: "Grid Warp",
    gridWarpWidget: true,
    node: (s) => gridWarpNode(s),
    rows: [],
  },
  // Shape Warp (2026-09-07): the Radial layer's shapes as regions of
  // influence, each moving, twisting or pinching the picture under it,
  // overlapping shapes sharing the pull so a still one holds. After Grid
  // Warp in the chain and below it here.
  {
    title: "Shape Warp",
    shapeWarpWidget: true,
    node: (s) => shapeWarpNode(s),
    rows: [],
  },
  // "We are missing a lens correction category in
// adjustments."
  //
  // Manual controls rather than a profile database, which is a large job
  // with a license question attached.
  {
    title: "Lens",
    lensProfile: true,
    node: (s) => s.nodes.find((n) => n.type === "heeler.lens_correct"),
    rows: [
      { label: "Distortion", param: "distortion" },
      { label: "Fringe R/C", param: "ca_red" },
      { label: "Fringe B/Y", param: "ca_blue" },
      { label: "Lens vignetting", param: "vignette" },
      { label: "Lens vig. range", param: "vignette_mid", centered: false },
    ],
  },
  // Color Checker calibration (26.3 Phase 11): a color grader's Color
  // Match. The section's widget is the chart dropdown and the Place
  // chart button; Amount is the one dial. In the chain it corrects the
  // camera after the warps and the depth map, before Color.
  {
    title: "Color Checker",
    colorCheckerWidget: true,
    node: (s) => colorCheckerNode(s),
    rows: [
      { label: "Amount", param: "amount", centered: false },
      // The chart tool's circle size: the overlay draws it, the sampler
      // measures it. Never touches the render, like every view setting
      // that rides a node.
      { label: "Sample", param: "sample", centered: false },
    ],
  },
];

/** The develop controls: every section, in order.
 *
 * Its own component so either pane of a split right panel can hold it.
 * Kept mounted and merely hidden when the pane is showing another tab
 * (`display: none` on `showing` below), which is what preserves the
 * scroll position and every open section across a tab switch. */
export const sectionPinHint = (pinned: boolean) => pinned
  ? "Takes this section out of the pinned group at the top of the panel"
  : "Keeps this section at the top of the panel, in every photograph";

/** The node ids a section owns for the purpose of an override: its own
 * node, the ones its switch also flips, and its category pieces. */
export function sectionNodeIds(state: State, sec: SectionSpec): string[] {
  const ids = new Set<string>();
  const own = sec.node(state);
  if (own) ids.add(own.id);
  for (const n of sec.alsoToggles?.(state) ?? []) if (n) ids.add(n.id);
  for (const piece of CATEGORY_PIECES[sec.title] ?? []) ids.add(piece.id);
  return [...ids];
}

/** Where a Develop section's Export checkbox taps the graph
 * (2026-09-30), or null when the section has nothing on the picture's
 * path to tap: the section's last node on the main chain, the picture
 * as it leaves the section. "Last" is the chain's order, not the
 * panel's: the candidate no other candidate sits downstream of, among
 * every node the section writes to (its own, the ones its switch
 * flips, its category pieces and recipe block, its rows' nodes) that
 * is on the top-level graph and reaches the Output. Depth Map taps
 * its depth output instead: the plane, not the picture.
 *
 * Source has no checkbox: its node is the photograph before the crop,
 * a different frame from the export's (Geometry's checkbox writes the
 * cropped original).
 *
 * With a Develop layer selected, a section that edits the layer taps
 * the layer's own copy (2026-10-03: "adjustment layer sections do not
 * have the option to enable the export layer... at the end of the day
 * everything is a node network"): the last of the section's nodes
 * under that layer's prefix, the picture as the section leaves it on
 * that layer. A section that stays global with a layer selected taps
 * the main chain as ever.*/
export function sectionExportTap(state: State, sec: SectionSpec): { tap: string; depth: boolean } | null {
  if (sec.hideToggle) return null;
  const layer = sectionExportLayer(state, sec);
  const prefix = layer ? layerGroupPrefix(layer) : undefined;
  const top = new Map(state.nodes.map((n) => [n.id, n]));
  if (sec.depthTools === "depthmap") {
    // A wired one: the panel's state carries an unbuilt section's
    // stand-in (previewNodes), which is in no chain and never renders.
    const dm = sec.node(state);
    return dm && top.has(dm.id) && state.wires.some((w) => w.to === dm.id || w.from === dm.id) ? { tap: dm.id, depth: true } : null;
  }
  const ids = new Set(sectionNodeIds(state, sec));
  for (const row of sec.rows) {
    const n = row.node?.(state);
    if (n) ids.add(n.id);
  }
  if (sec.recipe) for (const n of state.nodes) if (n.id.startsWith(RECIPE_PREFIX[sec.recipe])) ids.add(n.id);
  // Downstream of each node along the picture's wires (masks and depth
  // planes are not the picture).
  const next = new Map<string, string[]>();
  for (const w of state.wires) {
    if (w.kind === "mask" || w.fromPort === "depth" || w.fromPort === "mask") continue;
    next.set(w.from, [...(next.get(w.from) ?? []), w.to]);
  }
  const reach = (from: string): Set<string> => {
    const seen = new Set<string>();
    const stack = [...(next.get(from) ?? [])];
    while (stack.length) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      stack.push(...(next.get(id) ?? []));
    }
    return seen;
  };
  const output = state.nodes.find((n) => n.type === "heeler.output");
  const candidates = [...ids].filter((id) => {
    const n = top.get(id);
    if (!n || n.type === "heeler.export_layer") return false;
    if (prefix ? !id.startsWith(prefix) : isLayerNode(id)) return false;
    return !!output && reach(id).has(output.id);
  });
  const last = candidates.find((id) => {
    const below = reach(id);
    return !candidates.some((other) => other !== id && below.has(other));
  });
  return last ? { tap: last, depth: false } : null;
}

/** The command a section's switch sends to build its nodes the first
 * time (powerOnSection's), or null for a section that builds nothing. */
export function sectionBuild(sec: SectionSpec): { type: "set_recipe"; recipe: Recipe; on: boolean } | { type: "set_category"; title: string; on: boolean } | null {
  if (sec.recipe) return { type: "set_recipe", recipe: sec.recipe, on: true };
  if (CATEGORY_PIECES[sec.title]?.length) return { type: "set_category", title: sec.title, on: true };
  return null;
}

/** The graph without the panel's stand-ins: SimplePanel hands its
 * sections the real nodes plus a preview of every unbuilt section's
 * (previewNodes), which sit in no chain. A buildable node no wire
 * touches is one of those. */
export function withoutPreviews(state: State): State {
  const wired = new Set<string>();
  for (const w of state.wires) {
    wired.add(w.from);
    wired.add(w.to);
  }
  const nodes = state.nodes.filter((n) => wired.has(n.id) || !buildFor(n.id));
  return nodes.length === state.nodes.length ? state : { ...state, nodes };
}

/** Whether a section's header offers the Export checkbox (2026-09-30:
 * "every section should have the option for export layer"): every
 * section with a node to tap now, or one its switch would build.
 * Cheap, for the render; the tap of an unbuilt section is found on
 * the click (sectionExportCommand).*/
export function sectionExportOffered(state: State, sec: SectionSpec): boolean {
  if (sec.hideToggle) return false;
  // On a layer: its copy of the section, there already or brought in
  // by the tick.
  if (sectionExportLayer(state, sec)) return !!sec.node(state);
  return !!sectionBuild(sec) || !!sectionExportTap(state, sec);
}

/** The Develop layer a section's Export box taps: the selected layer
 * for a section that edits it, none for a section that stays global
 * (and for every section with no layer selected). */
export function sectionExportLayer(state: State, sec: SectionSpec): string | null {
  return state.activeLayer && sec.layerTool ? state.activeLayer : null;
}

/** The command a section's Export checkbox sends to turn on or off.
 *
 * A section the photograph has not used yet has nothing to tap, so the
 * tick builds it first, the way touching one of its controls does (:
 * the build carries the edit as `then`, one undo step for both). The
 * build is the switch's own, and the nodes it made are switched off as
 * the tick lands, still wired in their places, so a tick never changes
 * the picture: the layer is the picture as it leaves the section, which
 * until the section is used is the picture as it arrives. (Not the
 * switch's own off: a recipe's off takes its block out of the chain,
 * which would leave the tap feeding nothing.) Unticking leaves them, as
 * the switch does. Depth Map's stays on: its node passes the picture
 * through untouched and it is what computes the plane the layer writes.
 * The tap is found on the graph the build makes, by the same reducer
 * run on a copy.*/
export function sectionExportCommand(state: State, sec: SectionSpec, on: boolean): Command | null {
  const layer = sectionExportLayer(state, sec);
  const onLayer = layer ? { layer } : {};
  if (!on) return { type: "set_section_export", title: sec.title, tap: "", on: false, ...onLayer };
  const real = withoutPreviews(state);
  const now = sectionExportTap(real, sec);
  if (now) return { type: "set_section_export", title: sec.title, tap: now.tap, depth: now.depth, on: true, ...onLayer };
  // A layer's copy of the section that is not in the graph yet: the
  // command names the seat, and the reducer brings the copy in,
  // switched off, in the same undo step.
  if (layer) {
    const seat = sec.node(state);
    return seat ? { type: "set_section_export", title: sec.title, tap: seat.id, on: true, layer } : null;
  }
  const build = sectionBuild(sec);
  if (!build) return null;
  const built = reduce(real, build);
  const tap = sectionExportTap(built, sec);
  if (!tap) return null;
  const had = new Set(real.nodes.map((n) => n.id));
  const off = tap.depth ? [] : built.nodes.filter((n) => !had.has(n.id)).map((n) => n.id);
  return {
    ...build,
    then: { type: "set_section_export", title: sec.title, tap: tap.tap, depth: tap.depth, on: true, ...(off.length ? { off } : {}) },
  };
}
