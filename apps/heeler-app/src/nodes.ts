// Every node the engine can execute, as the UI offers it.
//
// Only the type, a display name and a category live here. Parameters do
// not: the backend instantiates each node from the registry, which fills
// in its own defaults, and the UI's values override from there. So a
// node added with no params at all renders correctly, and there is no
// second copy of every default to drift out of step.
//
// The list itself is checked against the registry by a Rust test, so a
// node added to the engine and forgotten here fails the build rather
// than being quietly unreachable.

import type { Category, NodeCard } from "./state";
import registryInputsJson from "./registry-inputs.json";

/** Every node's inputs as the engine's registry declares them, port
 * name to kind ("image", "mask", "channel"). Generated from spec.rs and
 * held to it by the desktop (lib.rs
 * the_registry_inputs_mirror_matches_the_engine_registry). */
const REGISTRY_INPUTS = registryInputsJson as Record<string, Record<string, string>>;

/** Whether a node of `type` takes a mask on the port its card's mask
 * diamond stands for (portName(type, "mask")): the one rule for drawing
 * the diamond, read from the engine rather than a hand list (docs
 * review 2026-10-01: Color Transform, Channel Gain, Channel Mixer,
 * Invert and Blend Mode took a mask in the engine and drew none, so no
 * mask could be wired; Noise, Depth Map and the layer effects drew one
 * the engine has no port for, so a mask wired there did nothing). The
 * logic family and Invert Mask are left out: their field IS the input,
 * drawn as "in". */
export function engineTakesMask(type: string): boolean {
  if (MASK_IN_TYPES.has(type)) return false;
  return REGISTRY_INPUTS[type]?.[portName(type, "mask")] === "mask";
}

/** Whether the engine's registry lists a node of `type` at all. */
export function engineKnows(type: string): boolean {
  return type in REGISTRY_INPUTS;
}

export interface NodeSpec {
  type: string;
  name: string;
  cat: Category;
  /** what it is for, one line, shown in the palette */
  blurb: string;
}

/** Engine types the palette no longer offers. The engine renders them
 * forever (saved graphs never break); the palette moved on. The quoted
 * names keep the palette-vs-registry cross-check honest about the
 * retirement being deliberate.
 * - "heeler.split_tone": retired 2026-08-23 for Recolor's Lum▸Hue
 *   curve (brightness-indexed hue, arbitrary structure) and the Color
 *   Wheels' tonal tinting, which covered both of its jobs. */
export const RETIRED_TYPES = new Set(["heeler.split_tone"]);

export const NODE_CATALOG: NodeSpec[] = [
  { type: "heeler.image_source", name: "Image Source", cat: "source", blurb: "The decoded photograph" },
  { type: "heeler.file", name: "File", cat: "source", blurb: "Any image from disk: a second photograph, a texture, a logo" },
  { type: "heeler.catalog", name: "Catalog", cat: "source", blurb: "Another photograph from the catalog, as developed or as shot: the double-exposure source" },
  { type: "heeler.crop_rotate", name: "Crop & Rotate", cat: "source", blurb: "Straighten and crop the frame" },
  { type: "heeler.white_balance", name: "White Balance", cat: "color", blurb: "Neutralize a color cast" },
  { type: "heeler.exposure", name: "Exposure", cat: "color", blurb: "Brightness, contrast and the tonal ends" },
  { type: "heeler.standard_color", name: "Color", cat: "color", blurb: "Temperature, saturation and vibrance" },
  { type: "heeler.curves", name: "Curves", cat: "color", blurb: "Freehand tone curve, per channel" },
  { type: "heeler.levels", name: "Levels", cat: "color", blurb: "Black point, white point, gamma" },
  { type: "heeler.color_balance", name: "Color Balance", cat: "color", blurb: "Push shadows, mids and highlights toward a hue" },
  { type: "heeler.color_bend", name: "Color Bend", cat: "color", blurb: "Move one neighborhood of color to another" },
  { type: "heeler.black_white", name: "Black & White", cat: "color", blurb: "Channel-mixer monochrome" },
  { type: "heeler.color_grade", name: "Color Grade", cat: "color", blurb: "Hue shift, chroma, exposure and uniformity in OkLCh" },
  { type: "heeler.tone_profile", name: "Tone Profile", cat: "color", blurb: "Base rendering and the highlight shoulder" },
  { type: "heeler.sharpen", name: "Sharpen", cat: "detail", blurb: "Local contrast at the fine scale" },
  { type: "heeler.detail", name: "Detail", cat: "detail", blurb: "Texture, clarity and dehaze: local contrast by scale, weighted per band and channel" },
  { type: "heeler.clarity", name: "Clarity", cat: "detail", blurb: "Texture, clarity and dehaze" },
  { type: "heeler.denoise", name: "Denoise", cat: "detail", blurb: "Smooth sensor noise" },
  { type: "heeler.model_denoise", name: "Model Denoise", cat: "detail", blurb: "The SCUNet denoiser's answer for the source, blended in: luminance, chroma, edge detail" },
  { type: "heeler.hot_pixel", name: "Hot Pixels", cat: "detail", blurb: "Remove stuck photosites, touch nothing else" },
  { type: "heeler.nlm_denoise", name: "Detail Denoise", cat: "detail", blurb: "Similarity-weighted smoothing that spares edges; KNN fast, NLM thorough" },
  { type: "heeler.vignette", name: "Vignette", cat: "detail", blurb: "An elliptical falloff from the center; a look, not the lens fix" },
  { type: "heeler.grain", name: "Grain", cat: "detail", blurb: "Film grain, by tone and channel" },
  // The depth tools: shaped by the photograph's computed farness plane
  // (Depth Anything V2 Small; passthrough until depth is computed).
  { type: "heeler.depth_map", name: "Depth Map", cat: "detail", blurb: "How the depth plane every depth tool reads is refined against the photograph: edges and flatten" },
  { type: "heeler.fog", name: "Fog", cat: "detail", blurb: "Atmosphere by distance, from the depth model" },
  { type: "heeler.key_light", name: "Depth Lighting", cat: "detail", blurb: "Synthetic lights - suns and lamps - over the scene's depth" },
  { type: "heeler.dof", name: "Depth of Field", cat: "detail", blurb: "Focus falls off with distance from a chosen plane" },
  { type: "heeler.flare", name: "Lens Flare", cat: "detail", blurb: "The lens's flare for the Depth Lighting rig's lights: glow, rays, ghosts, veil" },
  { type: "heeler.halation", name: "Halation", cat: "detail", blurb: "Highlights bleed a colored mist into their dark surroundings, the film's own glow" },
  { type: "heeler.paper", name: "Print", cat: "color", blurb: "The paper the print is made on: grade or split grade, the paper's black and base, toning by density" },
  { type: "heeler.sharpening", name: "Sharpening", cat: "detail", blurb: "The Develop sharpening recipe as one node: Vivid or Hi Pass, radius and intensity, behind a mask" },
  { type: "heeler.skin_soften", name: "Skin Softening", cat: "detail", blurb: "Smooths skin texture and brings detail back, as one node behind a mask" },
  // The nodes that let a graph do what a layer stack does.
  // "Adding more nodes means adding more capabilities rather than rewiring
  // something unnatural to how the engine was working just to match [a layer
  // editor]." All six are useful on their own, not only inside the sharpening
  // recipes that needed them.
  { type: "heeler.lens_correct", name: "Lens Correction", cat: "source", blurb: "Distortion, fringing and vignetting" },
  { type: "heeler.perspective", name: "Perspective", cat: "source", blurb: "Stand leaning verticals up; keystone correction" },
  { type: "heeler.grid_warp", name: "Grid Warp", cat: "source", blurb: "A grid of handles over the frame; drag them and the picture bends smoothly with them" },
  { type: "heeler.shape_warp", name: "Shape Warp", cat: "source", blurb: "Radial shapes placed over the frame, each moving, twisting or pinching the picture under it; a still shape holds" },
  { type: "heeler.layer_warp", name: "Warp", cat: "source", blurb: "Grid Warp and Shape Warp on one node: a Finish Warp layer, or an image layer's warp of its own picture" },
  { type: "heeler.color_checker", name: "Color Checker", cat: "source", blurb: "Calibrate the camera against a photographed reference chart: the fit sets white balance, exposure and a 3x3 matrix" },
  { type: "heeler.transform", name: "Transform", cat: "utility", blurb: "Move, scale and rotate about a pivot, resampled once" },
  { type: "heeler.blur", name: "Blur", cat: "detail", blurb: "Gaussian softening, radius in pixels" },
  { type: "heeler.high_pass", name: "High Pass", cat: "detail", blurb: "Only what is sharper than the radius, over mid gray" },
  // Graph-only (ops_field.rs): the second input is the guide.
  { type: "heeler.guided_filter", name: "Guided Filter", cat: "detail", blurb: "Smooth where the guide is flat, keep where it has an edge; unwired, the picture guides itself" },
  // Graph-only (ops_advanced.rs), the second batch.
  { type: "heeler.median", name: "Median / Percentile", cat: "detail", blurb: "Each pixel the median (or any percentile) of a round window: specks and dust gone, edges kept" },
  // The pieces effects are built out of. "I want to go beyond
  // 'here is a grain node' and rather show the user 'this is how grain
  // effects are built' to educate and empower them." Grain's six gain sliders
  // are six Channel Gains and three Tone Masks; anybody can wire the same
  // pieces up differently.
  { type: "heeler.noise", name: "Grain Field", cat: "detail", blurb: "The grain itself: size, stock, seed. Add it to a picture" },
  { type: "heeler.channel_gain", name: "Channel Gain", cat: "utility", blurb: "More or less of one channel, 100 is unchanged" },
  { type: "heeler.tone_mask", name: "Tone Mask", cat: "utility", blurb: "Shadows, midtones, highlights, or the midtone bell" },
  { type: "heeler.invert", name: "Invert", cat: "utility", blurb: "One minus the value" },
  { type: "heeler.desaturate", name: "Desaturate", cat: "color", blurb: "Take the color out, keep the brightness" },
  { type: "heeler.gamut_map", name: "Gamut Map", cat: "color", blurb: "Ease colors no display can show back inside, hue held" },
  // The second batch of advanced nodes (ops_advanced.rs), graph-only.
  // 2026-09-30: "queue those up next as they don't look too extensive."
  { type: "heeler.soft_clip", name: "Technical Soft Clip", cat: "color", blurb: "Values past a ceiling rolled smoothly into it, everything below the knee untouched" },
  { type: "heeler.chroma_key_despill", name: "Chroma Key (Despill)", cat: "color", blurb: "A key color's spill taken out of the picture, lightness kept: green fringes go neutral" },
  { type: "heeler.view_transform", name: "View Transform", cat: "color", blurb: "The scene-to-display rendering, chosen: sigmoid, filmic, AgX, ACES. Use instead of Tone Profile" },
  { type: "heeler.tone_eq", name: "Relight", cat: "color", blurb: "Re-expose by brightness zone: lift the shadows without touching the sky" },
  { type: "heeler.recolor", name: "Recolor", cat: "color", blurb: "The channel-routing color EQ: select by hue, sat or lum; adjust the same" },
  { type: "heeler.color_console", name: "Color Tune", cat: "color", blurb: "Per-family grading strips: R G B C Y M plus bands you pick, each with a wheel" },
  { type: "heeler.lut", name: "3D LUT", cat: "color", blurb: "A .cube look-up table from disk, film emulations and grades included" },
  { type: "heeler.chromatic_adapt", name: "Chromatic Adaptation", cat: "color", blurb: "CAT16: undo the color of the light itself; mask it for mixed lighting" },
  { type: "heeler.channel_mixer", name: "Channel Mixer", cat: "utility", blurb: "Each channel rebuilt from all three; preserve-gray keeps neutrals safe" },
  { type: "heeler.invert_mask", name: "Invert Mask", cat: "masking", blurb: "One minus the mask: the Outside half of a pair" },
  // The advanced field nodes (ops_field.rs), graph-only. 2026-09-30: "go
  // ahead with the first batch of nodes".
  { type: "heeler.morphology", name: "Morphology", cat: "masking", blurb: "Erode, dilate, open or close a mask by a radius, soft values kept" },
  { type: "heeler.guided_filter_mask", name: "Guided Filter (Mask)", cat: "masking", blurb: "A mask's edge settled onto the picture's edges: the picture in, the mask on the diamond" },
  { type: "heeler.edge_field", name: "Edge Field", cat: "masking", blurb: "Where the picture changes, as a mask: Sobel, Scharr or Laplacian, the same at every zoom" },
  // The second batch (ops_advanced.rs).
  { type: "heeler.median_mask", name: "Median / Percentile (Mask)", cat: "masking", blurb: "A mask's specks gone (median), or shrunk and grown by a percentile of a round window" },
  { type: "heeler.distance_field", name: "Signed Distance Field", cat: "masking", blurb: "How far each pixel is from the mask's edge: 0.5 on it, white inside, black outside, exact" },
  { type: "heeler.chroma_key", name: "Chroma Key", cat: "masking", blurb: "A green or blue screen's matte: black on the key color, white on the subject" },
  { type: "heeler.smart_mask", name: "Smart Mask", cat: "masking", blurb: "A model's selection (subject, sky, or your clicks) as a mask; computed on demand, cached beside the photo" },
  { type: "heeler.matte_mask", name: "Object Mask", cat: "masking", blurb: "Objects a render named in its own OpenEXR (Cryptomatte or a matte channel) as a mask, exact to the pixel" },
  { type: "heeler.to_display", name: "To Display", cat: "utility", blurb: "Into display space, where Overlay and Vivid Light are defined" },
  { type: "heeler.to_scene", name: "To Scene", cat: "utility", blurb: "Back to scene-linear afterwards" },
  // Brightness and color apart, and back together. Same there-and-back
  // shape as the pair above: fan a source into two splits, filter each
  // half at its own strength, and join. What it is for is noise, which
  // is blobby and forgivable in color and unforgivable in brightness.
  { type: "heeler.luma_chroma_split", name: "Luma / Color Split", cat: "utility", blurb: "Brightness or color on its own, so noise in each can be smoothed apart" },
  { type: "heeler.luma_chroma_join", name: "Luma / Color Join", cat: "utility", blurb: "Puts a split brightness and color back together" },
  { type: "heeler.luminance_range_mask", name: "Luminance Mask", cat: "masking", blurb: "Select a band of brightness" },
  { type: "heeler.color_range_mask", name: "Color Range Mask", cat: "masking", blurb: "Select a band of color" },
  { type: "heeler.hue_range_mask", name: "Hue Range Mask", cat: "masking", blurb: "Select a band of hue, neutrals excluded" },
  { type: "heeler.range_mask", name: "Range Mask", cat: "masking", blurb: "Select by luma, saturation and hue together" },
  { type: "heeler.radial_mask", name: "Radial Mask", cat: "masking", blurb: "An ellipse, feathered" },
  { type: "heeler.linear_mask", name: "Linear Mask", cat: "masking", blurb: "A gradient across the frame" },
  { type: "heeler.brush_mask", name: "Brush Mask", cat: "masking", blurb: "Painted by hand" },
  { type: "heeler.selection_mask", name: "Selection Mask", cat: "masking", blurb: "Outlines and color picks, kept as editable geometry" },
  { type: "heeler.luminance_extract", name: "Luminance Extract", cat: "utility", blurb: "Brightness as a mask" },
  { type: "heeler.channel_extract", name: "Channel", cat: "utility", blurb: "One channel as a mask" },
  { type: "heeler.channel_join", name: "Channel Join", cat: "utility", blurb: "Three fields become an image: r, g and b in (alpha too, optional), rgb out" },
  // The logic family (ops_logic.rs): Blend If, unbundled into nodes.
  // Measure picks the channel to read (Blend If's Gray/Red/Blue, plus
  // hue, chroma and saturation), Compare is the threshold with the
  // split-handle feather, and the resulting condition drives the mask
  // port of ANY edit (color correction included, which is where Blend
  // If could never go) or the Conditional node's else/then branches.
  { type: "heeler.measure", name: "Measure", cat: "masking", blurb: "The picture as numbers: luma, a channel, hue, chroma, saturation, alpha" },
  { type: "heeler.compare", name: "Compare", cat: "masking", blurb: "Where the field passes a threshold, feathered: the Blend If handles" },
  { type: "heeler.logic", name: "Logic", cat: "masking", blurb: "Two conditions combined: and, or, xor, subtract" },
  { type: "heeler.math", name: "Math", cat: "utility", blurb: "Arithmetic on fields: add, multiply, divide, power, and a constant" },
  { type: "heeler.remap", name: "Remap", cat: "utility", blurb: "Levels for a field: window, gamma, output range" },
  { type: "heeler.conditional", name: "Conditional", cat: "utility", blurb: "If the condition holds, the then branch; else the else branch" },
  { type: "heeler.blend", name: "Blend Mode", cat: "utility", blurb: "Combine two images by a mode" },
  { type: "heeler.paint", name: "Paint", cat: "utility", blurb: "RGBA strokes on a transparent canvas; the Finish tab's pixel layer" },
  { type: "heeler.clone", name: "Clone / Heal", cat: "utility", blurb: "Repairs that re-execute: strokes that read pixels from elsewhere in the frame" },
  { type: "heeler.inpaint", name: "Inpaint", cat: "detail", blurb: "The model fills the hole a mask describes: wire any mask as the hole, computed locally on demand" },
  { type: "heeler.lift", name: "Lift", cat: "utility", blurb: "The picture below, as this layer's own pixels" },
  { type: "heeler.fill", name: "Fill", cat: "utility", blurb: "A solid color, for a fill layer and its mask" },
  { type: "heeler.gradient", name: "Gradient", cat: "utility", blurb: "Stops with alpha, across the frame (linear, radial) or by tone" },
  { type: "heeler.gradient_map", name: "Gradient Map", cat: "color", blurb: "Brightness decides color: three stops from shadows to highlights" },
  // Layer effects: each one a function of a layer's alpha, so they are
  // useful on any node that carries transparency, not only in Finish.
  { type: "heeler.fx_shadow", name: "Shadow", cat: "detail", blurb: "Drop or inner shadow, cast from the layer's own shape" },
  { type: "heeler.fx_glow", name: "Glow", cat: "detail", blurb: "Outer or inner glow, with no offset to fall by" },
  { type: "heeler.fx_color_overlay", name: "Color Overlay", cat: "detail", blurb: "A flat color, kept inside the layer's alpha" },
  { type: "heeler.fx_gradient_overlay", name: "Gradient Overlay", cat: "detail", blurb: "A gradient, kept inside the layer's alpha" },
  { type: "heeler.fx_bevel", name: "Bevel / Emboss", cat: "detail", blurb: "Light the layer as though its alpha were a hill" },
  { type: "heeler.merge", name: "Merge", cat: "utility", blurb: "Lay one image over another" },
  { type: "heeler.output", name: "Output", cat: "utility", blurb: "What gets exported" },
  { type: "heeler.export_layer", name: "Export Layer", cat: "utility", blurb: "Tap a wire and write it as a layer with the export: inside the EXR or as a sibling TIFF" },
  // Graph-only (ops_field.rs): the alpha diamond takes Replace's mask.
  { type: "heeler.alpha_association", name: "Alpha Association", cat: "utility", blurb: "Extract or replace a picture's alpha, or premultiply and unpremultiply its color" },
  // The second batch (ops_advanced.rs): a field in, a normal map out.
  { type: "heeler.depth_normals", name: "Normals from Depth", cat: "utility", blurb: "A depth plane as a normal map: slopes per photograph pixel, cliffs kept as seams" },
  { type: "heeler.color_transform", name: "Color Transform", cat: "utility", blurb: "From one declared color space to another, exactly: Rec. 709, Rec. 2020, ACEScg, ACEScct, Display P3" },
  // Its X field rides the mask diamond, its Y field the alpha diamond.
  { type: "heeler.displacement_map", name: "Displacement Map", cat: "utility", blurb: "The picture's pixels moved by two fields, X and Y, up to a set number of pixels" },
];

/** The order categories appear in menus: what a photograph goes through,
 * roughly in the order it goes through it. */
export const CATEGORY_ORDER: Category[] = ["source", "color", "detail", "masking", "utility"];

export const CATEGORY_LABEL: Record<Category, string> = {
  source: "Source",
  color: "Color",
  detail: "Detail",
  masking: "Masking",
  utility: "Utility",
  group: "Group",
};

/** Alphabetical by the name a person reads, so a menu can be scanned
 * ("it's a little hard to browse the menus because they
 * have no sorting"). The catalog itself stays in the order it was
 * written, which groups kin together for anyone reading the source.*/
export function byName(nodes: NodeSpec[]): NodeSpec[] {
  return [...nodes].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

export function byCategory(): { cat: Category; label: string; nodes: NodeSpec[] }[] {
  return CATEGORY_ORDER.map((cat) => ({
    cat,
    label: CATEGORY_LABEL[cat],
    nodes: byName(NODE_CATALOG.filter((n) => n.cat === cat)),
  })).filter((g) => g.nodes.length > 0);
}

/** The menus' groups inside each category (2026-10-01: "Either Utility
 * nodes get broken out into different (sub?) categories or the menu
 * needs to be scrollable. It's quite long and I can see someone with
 * a small window layout not seeing all the nodes", then "detail and
 * masking are kind of long menus too").
 *
 * A section is a menu grouping and the Inspector's kicker
 * ("CHANNELS / CHANNEL"), nothing more. The node's own `cat` stays what
 * it was: it is saved on every card, picks the stripe color, and
 * decides behavior (a masking card's round glyph and mask port), so no
 * saved graph changes meaning. A section sits under the category a
 * photographer would look in, which is not always the node's stripe:
 * Transform wears Utility's blue and sits in Source > Geometry beside
 * Crop & Rotate; Measure, Compare and Logic wear Masking's purple and sit
 * in Utility > Math & Logic, where the arithmetic they feed lives.
 *
 * Kept under SECTION_LIMIT nodes each, so a section's list fits a small
 * window at a large UI zoom without scrolling (it scrolls anyway when it
 * cannot fit). The catalog test checks every node is in exactly one. */
export interface NodeSection {
  id: string;
  label: string;
  /** the category whose menu this section is listed under */
  family: Exclude<Category, "group">;
}

/** No section holds more than this many nodes. */
export const SECTION_LIMIT = 12;

export const NODE_SECTIONS: NodeSection[] = [
  { id: "source", label: "Source", family: "source" },
  { id: "geometry", label: "Geometry", family: "source" },
  { id: "tone", label: "Tone", family: "color" },
  { id: "color", label: "Color", family: "color" },
  { id: "looks", label: "Looks", family: "color" },
  { id: "sharpen", label: "Sharpen & Detail", family: "detail" },
  { id: "blur", label: "Blur & Smooth", family: "detail" },
  { id: "noise", label: "Noise", family: "detail" },
  { id: "film", label: "Film & Lens", family: "detail" },
  { id: "depth", label: "Depth", family: "detail" },
  { id: "retouch", label: "Retouch & Paint", family: "detail" },
  { id: "masks", label: "Masks", family: "masking" },
  { id: "range_masks", label: "Range Masks", family: "masking" },
  { id: "mask_tools", label: "Mask Tools", family: "masking" },
  { id: "channels", label: "Channels", family: "utility" },
  { id: "math", label: "Math & Logic", family: "utility" },
  { id: "color_space", label: "Color Space", family: "utility" },
  { id: "composite", label: "Composite", family: "utility" },
  { id: "layer_fx", label: "Layer Effects", family: "utility" },
  { id: "output", label: "Output", family: "utility" },
];

/** Each palette type's section. A map beside the catalog rather than a
 * field in it, so the catalog's lines stay as they were written. */
export const NODE_SECTION: Readonly<Record<string, string>> = {
  // Source
  "heeler.image_source": "source",
  "heeler.file": "source",
  "heeler.catalog": "source",
  "heeler.color_checker": "source",
  "heeler.crop_rotate": "geometry",
  "heeler.lens_correct": "geometry",
  "heeler.perspective": "geometry",
  "heeler.grid_warp": "geometry",
  "heeler.shape_warp": "geometry",
  "heeler.layer_warp": "geometry",
  "heeler.transform": "geometry",
  "heeler.displacement_map": "geometry",
  // Color
  "heeler.exposure": "tone",
  "heeler.curves": "tone",
  "heeler.levels": "tone",
  "heeler.tone_eq": "tone",
  "heeler.tone_profile": "tone",
  "heeler.view_transform": "tone",
  "heeler.soft_clip": "tone",
  "heeler.white_balance": "color",
  "heeler.standard_color": "color",
  "heeler.chromatic_adapt": "color",
  "heeler.color_balance": "color",
  "heeler.color_bend": "color",
  "heeler.recolor": "color",
  "heeler.color_console": "color",
  "heeler.color_grade": "color",
  "heeler.chroma_key_despill": "color",
  "heeler.black_white": "looks",
  "heeler.desaturate": "looks",
  "heeler.paper": "looks",
  "heeler.lut": "looks",
  "heeler.gradient_map": "looks",
  // Detail
  "heeler.sharpen": "sharpen",
  "heeler.sharpening": "sharpen",
  "heeler.detail": "sharpen",
  "heeler.clarity": "sharpen",
  "heeler.high_pass": "sharpen",
  "heeler.blur": "blur",
  "heeler.guided_filter": "blur",
  "heeler.median": "blur",
  "heeler.skin_soften": "blur",
  "heeler.denoise": "noise",
  "heeler.nlm_denoise": "noise",
  "heeler.model_denoise": "noise",
  "heeler.hot_pixel": "noise",
  "heeler.vignette": "film",
  "heeler.grain": "film",
  "heeler.noise": "film",
  "heeler.halation": "film",
  "heeler.depth_map": "depth",
  "heeler.fog": "depth",
  "heeler.key_light": "depth",
  "heeler.dof": "depth",
  "heeler.flare": "depth",
  "heeler.depth_normals": "depth",
  "heeler.inpaint": "retouch",
  "heeler.clone": "retouch",
  "heeler.paint": "retouch",
  // Masking
  "heeler.brush_mask": "masks",
  "heeler.radial_mask": "masks",
  "heeler.linear_mask": "masks",
  "heeler.selection_mask": "masks",
  "heeler.smart_mask": "masks",
  "heeler.matte_mask": "masks",
  "heeler.luminance_range_mask": "range_masks",
  "heeler.color_range_mask": "range_masks",
  "heeler.hue_range_mask": "range_masks",
  "heeler.range_mask": "range_masks",
  "heeler.tone_mask": "range_masks",
  "heeler.chroma_key": "range_masks",
  "heeler.invert_mask": "mask_tools",
  "heeler.morphology": "mask_tools",
  "heeler.guided_filter_mask": "mask_tools",
  "heeler.median_mask": "mask_tools",
  "heeler.distance_field": "mask_tools",
  "heeler.edge_field": "mask_tools",
  // Utility
  "heeler.channel_gain": "channels",
  "heeler.channel_extract": "channels",
  "heeler.channel_join": "channels",
  "heeler.channel_mixer": "channels",
  "heeler.luminance_extract": "channels",
  "heeler.luma_chroma_split": "channels",
  "heeler.luma_chroma_join": "channels",
  "heeler.alpha_association": "channels",
  "heeler.math": "math",
  "heeler.remap": "math",
  "heeler.conditional": "math",
  "heeler.invert": "math",
  "heeler.measure": "math",
  "heeler.compare": "math",
  "heeler.logic": "math",
  "heeler.to_display": "color_space",
  "heeler.to_scene": "color_space",
  "heeler.color_transform": "color_space",
  "heeler.gamut_map": "color_space",
  "heeler.merge": "composite",
  "heeler.blend": "composite",
  "heeler.lift": "composite",
  "heeler.fill": "composite",
  "heeler.gradient": "composite",
  "heeler.fx_shadow": "layer_fx",
  "heeler.fx_glow": "layer_fx",
  "heeler.fx_color_overlay": "layer_fx",
  "heeler.fx_gradient_overlay": "layer_fx",
  "heeler.fx_bevel": "layer_fx",
  "heeler.output": "output",
  "heeler.export_layer": "output",
};

/** A node's section. A palette node nobody gave a section (the catalog
 * test fails on one) falls back to a section named after its category,
 * so it is still listed somewhere rather than lost. */
export function sectionOf(spec: Pick<NodeSpec, "type" | "cat">): NodeSection {
  const id = NODE_SECTION[spec.type];
  const found = id ? NODE_SECTIONS.find((s) => s.id === id) : undefined;
  if (found) return found;
  const family = spec.cat === "group" ? "utility" : spec.cat;
  return { id: `more_${family}`, label: CATEGORY_LABEL[family], family };
}

/** Where a node is in the add menus, the whole way down: category,
 * section, node ("Masking > Mask Tools > Morphology"). The one source
 * of every "where is this node" the app or the assistant says
 * (2026-10-01: "in the text instructions where to find a node in the
 * menu it did not include the full menu path (it used the old menu
 * paths before add sub-categories)"). The Node menu puts "Node > " in
 * front of it; the graph's right-click menu, "Add > ". Null for a type
 * the palette does not offer.*/
export function nodeMenuPath(type: string): string | null {
  const spec = NODE_CATALOG.find((n) => n.type === type);
  if (!spec || RETIRED_TYPES.has(type)) return null;
  const s = sectionOf(spec);
  return `${CATEGORY_LABEL[s.family]} > ${s.label} > ${spec.name}`;
}

export interface MenuFamily {
  cat: Exclude<Category, "group">;
  label: string;
  sections: { id: string; label: string; nodes: NodeSpec[] }[];
}

/** What every add menu lists: the categories in CATEGORY_ORDER, each
 * holding its sections in NODE_SECTIONS order, each section's nodes by
 * name. */
export function menuTree(): MenuFamily[] {
  return CATEGORY_ORDER.filter((c): c is MenuFamily["cat"] => c !== "group")
    .map((cat) => {
      const sections = new Map<string, { id: string; label: string; nodes: NodeSpec[] }>();
      for (const s of NODE_SECTIONS) if (s.family === cat) sections.set(s.id, { id: s.id, label: s.label, nodes: [] });
      for (const spec of NODE_CATALOG) {
        const s = sectionOf(spec);
        if (s.family !== cat) continue;
        if (!sections.has(s.id)) sections.set(s.id, { id: s.id, label: s.label, nodes: [] });
        sections.get(s.id)!.nodes.push(spec);
      }
      return {
        cat,
        label: CATEGORY_LABEL[cat],
        sections: [...sections.values()]
          .filter((s) => s.nodes.length > 0)
          .map((s) => ({ ...s, nodes: byName(s.nodes) })),
      };
    })
    .filter((f) => f.sections.length > 0);
}

/** The words a node is also found by in the palette: its section, the
 * category it is listed under, and its own category, the one the menus
 * named before sections existed (so "utility" still finds Channel
 * Mixer). */
function categoryWords(spec: NodeSpec): string[] {
  const s = sectionOf(spec);
  return [s.label, CATEGORY_LABEL[s.family], CATEGORY_LABEL[spec.cat]].map((w) => w.toLowerCase());
}

/** Palette search.
 *
 * Matches the name first and the blurb second, so typing "grain" finds
 * Grain rather than everything that mentions it. Subsequence rather than
 * substring on the name, so "cbal" finds Color Balance: nobody types the
 * spaces. A category or section word comes last (categoryWords).
 */
export function searchNodes(query: string): NodeSpec[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const scored: { spec: NodeSpec; score: number }[] = [];
  for (const spec of NODE_CATALOG) {
    const name = spec.name.toLowerCase();
    let score = -1;
    if (name.startsWith(q)) score = 0;
    else if (name.includes(q)) score = 1;
    else if (isSubsequence(q, name.replace(/[^a-z0-9]/g, ""))) score = 2;
    else if (spec.blurb.toLowerCase().includes(q)) score = 3;
    // A category's word finds its nodes last: "utility" still lists
    // what the Utility menu held, "channels" what its section holds.
    else if (q.length >= 3 && categoryWords(spec).some((w) => w.startsWith(q) || w.split(/[^a-z0-9]+/).some((part) => part.startsWith(q)))) score = 4;
    if (score >= 0) scored.push({ spec, score });
  }
  // Same quality of match: the shorter name is the closer one. Typing
  // "gra" means Grain more than it means Gradient, because there is
  // less of Grain left over.
  scored.sort(
    (a, b) =>
      a.score - b.score ||
      a.spec.name.length - b.spec.name.length ||
      a.spec.name.localeCompare(b.spec.name),
  );
  return scored.map((s) => s.spec);
}

function isSubsequence(needle: string, hay: string): boolean {
  let i = 0;
  for (const ch of hay) {
    if (ch === needle[i]) i++;
    if (i === needle.length) return true;
  }
  return needle.length === 0;
}

export function specFor(type: string): NodeSpec | undefined {
  return NODE_CATALOG.find((n) => n.type === type);
}

/** A fresh node card for the graph.
 *
 * No params: the backend instantiates from the registry, which supplies
 * its own defaults, so an added node renders correctly without the UI
 * carrying a second copy of every default.
 */
/** Nodes that take a second image, and so need a second input port drawn.
 *
 * Placed by hand these had no way to receive one: the flag was only ever
 * set by the demo graph and the layer builder, so a Merge dragged out of
 * the palette showed one port and quietly ignored anything wired into its
 * lower half. The recipes never noticed because they write their wires
 * themselves.
 *
 * New cards get the flag here; saved ones are healed in migrateNodes,
 * since a card placed before this existed was persisted without it. */
const TWO_IMAGE_INPUTS = new Set([
  "heeler.to_scene",
  "heeler.merge",
  "heeler.blend",
  "heeler.luma_chroma_join",
  // The conditional's second image is its then branch (the engine's
  // "fg" port; bridge.ts already rewrites in2 to fg for every node).
  "heeler.conditional",
  // The Guided Filter's guide (the desktop maps fg to "guide").
  "heeler.guided_filter",
]);

/** Cards that draw the alpha diamond: Output's export transparency
 * (26.3 Phase 5), the Export Layer's written alpha (Phase 8), Channel
 * Join's alpha plane (node recipes, 2026-09-30), Alpha Association's
 * new alpha for Replace, and the Displacement Map's Y field. */
export const ALPHA_IN_TYPES = new Set([
  "heeler.output",
  "heeler.export_layer",
  "heeler.channel_join",
  "heeler.alpha_association",
  "heeler.displacement_map",
]);

/** Nodes that read the picture on "in" AND take a field on the mask
 * diamond that is the node's material, not a limit on its effect (on
 * the masking nodes there is no diamond otherwise; the Displacement
 * Map's carries its X field, its alpha diamond its Y). The desktop's
 * build_graph maps the diamond's "mask" to the engine's name for it
 * (FIELD_DIAMOND_PORT). */
export const FIELD_DIAMOND_TYPES = new Set(["heeler.guided_filter_mask", "heeler.edge_field", "heeler.displacement_map"]);

/** The engine's name for a FIELD_DIAMOND_TYPES card's diamond. */
const FIELD_DIAMOND_PORT: Record<string, string> = {
  "heeler.guided_filter_mask": "target",
  "heeler.edge_field": "field",
  "heeler.displacement_map": "x",
};

/** The engine's name for an ALPHA_IN_TYPES card's alpha diamond, where
 * it is not "alpha". */
const ALPHA_DIAMOND_PORT: Record<string, string> = {
  "heeler.displacement_map": "y",
};

/** Nodes whose main input is a mask/field rather than the picture.
 *
 * On every other node a mask pipe means "limit my effect" and lands on
 * the dedicated mask port. On these the mask IS the input: pipes from
 * mask/field sources land on the in port (or in2 for the second
 * operand of a Logic/Math), and image pipes have nothing to do here.
 * invert_mask predates the logic family and joins it here, which is
 * also the fix for a real wart: its only input is the registry's
 * "mask" port, and the canvas used to refuse mask pipes onto any
 * mask-producing node, so a hand-placed Invert Mask could not be wired
 * by drag at all; only recipes wrote its wire. (The desktop ingest
 * maps the landing name "in" back to "mask" for it.) */
export const MASK_IN_TYPES = new Set([
  "heeler.invert_mask",
  "heeler.morphology",
  "heeler.median_mask",
  "heeler.distance_field",
  "heeler.depth_normals",
  "heeler.channel_join",
  "heeler.compare",
  "heeler.logic",
  "heeler.math",
  "heeler.remap",
]);

/** The logic family's two-operand nodes: a mask pipe dropped on the
 * lower half of the card addresses the second operand. */
const MASK_TWO_OPERANDS = new Set(["heeler.logic", "heeler.math"]);

/** The one card with three inputs: Channel Join's r, g and b. */
export const THREE_FIELD_INPUTS = new Set(["heeler.channel_join"]);

/** Types whose out port carries a mask/field even though their
 * category says otherwise: the canvas needs to know a pipe from one is
 * a mask pipe, or the connect rules misroute it. */
const MASK_OUT_EXTRA = new Set([
  "heeler.luminance_extract",
  "heeler.channel_extract",
  "heeler.measure",
  "heeler.compare",
  "heeler.logic",
  "heeler.math",
  "heeler.remap",
]);

/** The depth consumers (26.3 Phase 10.3): every node that reads the
 * Depth Map's farness plane draws a depth input, wired from the map's
 * `depth` output. The picture tools read it as their light/atmosphere
 * plane; the masks read it in their Depth block. The same list lives in
 * the engine's registry as the optional `depth` input on each spec, and
 * in state.ts, which wires the port when a section asks for the plane. */
export const DEPTH_IN_TYPES = new Set([
  "heeler.fog",
  "heeler.key_light",
  "heeler.dof",
  "heeler.flare",
  "heeler.halation",
  "heeler.recolor",
  "heeler.range_mask",
  "heeler.hue_range_mask",
  "heeler.radial_mask",
  "heeler.linear_mask",
  "heeler.brush_mask",
  "heeler.smart_mask",
  "heeler.matte_mask",
  "heeler.selection_mask",
]);

/** Exported because the recipes build their own cards rather than going
 * through makeNode, and a recipe's join needs the port just as much. */
export const takesTwoImages = (type: string): boolean => TWO_IMAGE_INPUTS.has(type);

/** Whether a card of this type draws a second stacked input: two images
 * (Merge, Blend), two field operands (Logic, Math), or the first two of
 * three planes (Channel Join). One rule for makeNode and for the load
 * migration, so a saved card and a fresh one agree. */
export const hasSecondInput = (type: string): boolean =>
  TWO_IMAGE_INPUTS.has(type) || MASK_TWO_OPERANDS.has(type) || THREE_FIELD_INPUTS.has(type);

/** Whether a card of this type draws a third input (Channel Join's b). */
export const hasThirdInput = (type: string): boolean => THREE_FIELD_INPUTS.has(type);

/** Whether a type's out port carries a mask/field. The recipes build
 * their cards by hand (every one is cat "detail", so makeNode's
 * category rule never fires for them) and a Measure or Compare without
 * the flag drags an image pipe the connect rules then refuse. */
export const producesMask = (type: string): boolean => MASK_OUT_EXTRA.has(type);

/** The field pass-through seats of a card that may splice into a mask
 * or alpha pipe (26.3): invert_mask and the logic family read fields on
 * their operand ports and write one, and the Export Layer's gray pair
 * passes its field through unchanged (its field out is the port named
 * "mask"). A card with a field in but an image out (Channel Join), or
 * an image in but a field out (Measure), would break the pipe it sat
 * on, so it is not one. */
export function fieldSpliceSeats(n: { type: string; maskOut?: boolean }): { inSeat: "in" | "mask"; outPort?: "mask" } | null {
  if (n.type === "heeler.export_layer") return { inSeat: "mask", outPort: "mask" };
  if (n.type === "heeler.invert_mask") return { inSeat: "mask" };
  // The mask to refine on its diamond; the guide picture on its in is
  // a side input that stays (2026-10-01: dropped on a Finish layer's
  // mask wire inside the Finish group).
  if (n.type === "heeler.guided_filter_mask") return { inSeat: "mask" };
  if (n.type === "heeler.morphology" || n.type === "heeler.median_mask" || n.type === "heeler.distance_field") return { inSeat: "in" };
  if (
    (n.type === "heeler.compare" || n.type === "heeler.logic" || n.type === "heeler.math" || n.type === "heeler.remap") &&
    n.maskOut
  ) {
    return { inSeat: "in" };
  }
  return null;
}

export function makeNode(spec: NodeSpec, id: string, x: number, y: number): NodeCard {
  const masking = spec.cat === "masking";
  return {
    id,
    type: spec.type,
    name: spec.name,
    cat: spec.cat,
    x,
    y,
    enabled: true,
    params: {},
    hasIn: spec.type !== "heeler.image_source" && spec.type !== "heeler.file" && spec.type !== "heeler.catalog",
    hasIn2: hasSecondInput(spec.type),
    hasIn3: hasThirdInput(spec.type),
    // A new Merge or Blend Mode fits a second picture of another shape;
    // a saved one without the key stretched, and keeps stretching.
    ...(spec.type === "heeler.merge" || spec.type === "heeler.blend" ? { textParams: { fit: "fit" } } : {}),
    hasOut: spec.type !== "heeler.output",
    // Depth Map is the one node with TWO outputs: its image passthrough
    // and the farness plane as a field (26.3 Phase 4). Derived from the
    // type, and migrateNodes re-derives it, so a saved card gains the
    // port on load.
    depthOut: spec.type === "heeler.depth_map",
    // Output takes the export's transparency as a wired field (26.3
    // Phase 5); the Export Layer takes the written layer's alpha the
    // same way (Phase 8). A diamond where a mask diamond would sit -
    // beside the mask diamond on the Export Layer, which has both.
    // Channel Join's alpha plane rides the same diamond (node recipes,
    // 2026-09-30), and Alpha Association's Replace alpha.
    alphaIn: ALPHA_IN_TYPES.has(spec.type),
    // File offers its page's alpha as a field output (26.3 Phase 6);
    // the Export Layer's mask pair passes its field through the same
    // seat (Phase 8): a second diamond below the image out.
    fileMaskOut: spec.type === "heeler.file" || spec.type === "heeler.export_layer",
    // Every depth consumer draws the input the Depth Map's plane lands
    // on (26.3 Phase 10.3): a second field diamond beside the mask one.
    // migrateNodes re-derives it, so a saved card gains the port on load.
    depthIn: DEPTH_IN_TYPES.has(spec.type),
    // The diamond is drawn exactly when the engine takes a mask there
    // (engineTakesMask): the conditional's if, the Export Layer's gray
    // input, a mask node's second field (FIELD_DIAMOND_TYPES) and every
    // node the executor blends through its mask. migrateNodes adds it to
    // a saved card that lacks it.
    maskIn: engineTakesMask(spec.type),
    maskOut: masking || MASK_OUT_EXTRA.has(spec.type),
  };
}

/** Which port of a card the pointer is on. `maskIn` is the diamond at the
 * bottom left (the node's mask input); `maskOut` the diamond on the right
 * of a masking node (its field output); `depthOut` the second diamond on
 * a Depth Map's right edge (its farness plane, below the image out);
 * `depthIn` the diamond beside the mask diamond on every depth consumer
 * (where the plane lands); `fileMask` the second diamond on a File card's
 * right edge (the page's alpha or the named channel); `alpha` the diamond
 * on Output's bottom left (the export's transparency). */
export type PortSeat = "in" | "in2" | "in3" | "mask" | "out" | "maskOut" | "depthOut" | "depthIn" | "fileMask" | "alpha";

/** The engine's own name for a card's port, which is what the tooltip
 * prints after the dot. The card draws every second input as "in2"; the
 * engine calls it what it is (Merge.fg, Blend Mode.blend, Luma / Color
 * Join.chroma), and the serializer already maps the one to the other. */
export function portName(type: string, seat: PortSeat): string {
  if (THREE_FIELD_INPUTS.has(type)) {
    if (seat === "in") return "r";
    if (seat === "in2") return "g";
    if (seat === "in3") return "b";
  }
  switch (seat) {
    case "in":
      // Export Layer's image port is named "image" in the engine (its
      // other input is the mask), and the tooltip prints the truth.
      return type === "heeler.merge" || type === "heeler.blend" ? "base" : type === "heeler.export_layer" ? "image" : "in";
    case "in2":
      return type === "heeler.blend"
        ? "blend"
        : type === "heeler.luma_chroma_join"
          ? "chroma"
          : type === "heeler.guided_filter"
            ? "guide"
            : "fg";
    case "in3":
      return "in3";
    case "mask":
      return FIELD_DIAMOND_PORT[type] ?? "mask";
    case "alpha":
      return ALPHA_DIAMOND_PORT[type] ?? "alpha";
    case "out":
      // The Export Layer's pass-through image output is named "image"
      // in the engine; the tooltip prints the truth here too.
      return type === "heeler.export_layer" ? "image" : "out";
    case "maskOut":
      return "out";
    case "depthOut":
      return "depth";
    case "depthIn":
      return "depth";
    case "fileMask":
      return "mask";
  }
}

/** What a port carries, for the status bar. Two kinds of data flow in a
 * Heeler graph and they do not mix without a node in between (ports.rs):
 * rgb, an image; and alpha, a single-channel float field, which is what
 * every mask and every logic-family output is. */
export function portData(type: string, seat: PortSeat): string {
  const field = MASK_IN_TYPES.has(type);
  if (THREE_FIELD_INPUTS.has(type) && (seat === "in" || seat === "in2" || seat === "in3")) {
    const channel = seat === "in" ? "red" : seat === "in2" ? "green" : "blue";
    return `The ${channel} plane: takes alpha (any mask or field, single-channel float). Unwired reads as zero.`;
  }
  switch (seat) {
    case "in3":
      return "Third input: takes alpha (any mask or field, single-channel float).";
    case "in":
      return field
        ? "Field input: takes alpha (any mask or field, single-channel float). Not rgb."
        : "Image input: takes rgb from any node's image output. Not a mask.";
    case "in2":
      return field
        ? "Second operand: takes alpha (any mask or field, single-channel float)."
        : type === "heeler.guided_filter"
          ? "Guide input: takes rgb; its edges decide where the picture is kept. Optional: unwired, the picture guides itself."
          : "Second image input: takes rgb from any node's image output.";
    case "mask":
      return type === "heeler.export_layer"
        ? "Gray layer input: takes alpha (any mask or field, including a depth plane) and exports it as a named layer."
        : type === "heeler.guided_filter_mask"
          ? "Mask to refine: takes alpha (any mask or field), filtered against the picture on the image input. Unwired, the answer is empty."
          : type === "heeler.edge_field"
            ? "Field input: takes alpha (any mask or field) and finds its edges instead of the picture's. Optional; wired, it wins over the image input."
            : type === "heeler.displacement_map"
              ? "X field: takes alpha (any mask or field); 0.5 is no move, 1 moves the picture Strength pixels right, 0 left. Optional."
              : "Mask input: takes alpha (any mask or field) and limits where this node applies. Optional.";
    case "alpha":
      if (type === "heeler.channel_join") return "The alpha plane: takes alpha (any mask or field, single-channel float) as the image's transparency. Unwired is opaque.";
      if (type === "heeler.displacement_map") return "Y field: takes alpha (any mask or field); 0.5 is no move, 1 moves the picture Strength pixels down, 0 up. Optional.";
      return type === "heeler.export_layer"
        ? "Alpha input: takes alpha (any mask or field) as the written layer's transparency, replacing the image's own alpha at export. Optional."
        : type === "heeler.alpha_association"
          ? "Alpha input: takes alpha (any mask or field); in Replace mode it becomes the picture's alpha, exactly. Optional; the other modes read the picture's own alpha."
        : "Alpha input: takes alpha (any mask or field) as the export's transparency. Optional; a wire here wins over the Matte toggle. Needs PNG, TIFF or EXR.";
    case "out":
      return type === "heeler.export_layer"
        ? "Pass-through image output: rgb, the wired input unchanged. Feeds image inputs; the tap changes nothing downstream."
        : "Image output: rgb. Feeds image inputs; a mask input needs Luminance Extract or Channel first.";
    case "maskOut":
      return "Field output: alpha, single-channel float. Feeds mask inputs, Compare, Logic, Math and Remap. Not an image input.";
    case "depthOut":
      return "Depth field output: alpha, single-channel float, farness 0 near to 1 far after Edges, Flatten and the clips. Feeds mask inputs, Compare, Logic, Math and Remap. Not an image input.";
    case "depthIn":
      return "Depth input: takes alpha (any mask or field), the farness plane this node reads. Wire it from a Depth Map's depth output; unwired, the depth work renders flat. Optional.";
    case "fileMask":
      return type === "heeler.export_layer"
        ? "Pass-through field output: alpha, single-channel float, the wired gray layer unchanged. Feeds mask inputs, Compare, Logic, Math and Remap."
        : "Page alpha output: alpha, single-channel float, the read page's transparency (or the channel the Layer field names). Feeds mask inputs, Compare, Logic, Math and Remap. Not an image input.";
  }
}

/** What a port means on the nodes whose whole configuration is their
 * wiring, in the words a person would use: Conditional's else, then
 * and condition; Merge's base and the picture over it. Read by the
 * inspector's port guide, which stands in for dials on such nodes. */
export const PORT_ROLES: Record<string, Partial<Record<PortSeat, string>>> = {
  "heeler.conditional": { in: "else branch", in2: "then branch", mask: "condition" },
  "heeler.merge": { in: "base", in2: "over the base" },
  "heeler.blend": { in: "base", in2: "top layer", mask: "where it applies" },
  "heeler.luma_chroma_join": { in: "brightness", in2: "color" },
  "heeler.channel_join": { in: "red plane", in2: "green plane", in3: "blue plane", alpha: "alpha plane" },
  "heeler.logic": { in: "operand a", in2: "operand b" },
  "heeler.math": { in: "operand a", in2: "operand b" },
  "heeler.export_layer": { in: "image layer", mask: "gray layer", alpha: "written alpha" },
  "heeler.guided_filter": { in: "picture to filter", in2: "guide", mask: "where it applies" },
  "heeler.guided_filter_mask": { in: "guide picture", mask: "mask to refine" },
  "heeler.edge_field": { in: "picture", mask: "field (wins over the picture)" },
  "heeler.alpha_association": { in: "picture", alpha: "new alpha (Replace)" },
  "heeler.depth_normals": { in: "depth or height field" },
  "heeler.displacement_map": { in: "picture", mask: "X move", alpha: "Y move" },
  "heeler.output": { alpha: "export transparency" },
};

/** The tooltip and status line for a port. "Whenever I
 * hover an input or output, a tooltip below the mouse should read
 * {Node name}.{attribute} and the status bar should also show that
 * plus a brief message about the supported input and output data."*/
export function portHint(node: { name: string; type: string; id?: string }, seat: PortSeat): { tip: string; hint: string } {
  // The Finish group's second input (2026-10-01): the photograph its
  // layer masks read, which the masks inside the group take from here.
  if (node.id === "art" && seat === "in2") {
    const tip = `${node.name}.frame`;
    return {
      tip,
      hint: `${tip} · The photograph the Finish layer masks read, after the crop, the lens correction and the warps: takes rgb, wired by Finish itself. Each mask inside the group reads it from here.`,
    };
  }
  const tip = `${node.name}.${portName(node.type, seat)}`;
  return { tip, hint: `${tip} · ${portData(node.type, seat)}` };
}
