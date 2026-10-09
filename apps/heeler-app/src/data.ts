// Sample session data replicating the approved design frames exactly.
// Swapped for real project data when running inside Tauri.

import { uiPref } from "./uiprefs";
import type { ImageEntry, NodeCard, State, Wire } from "./state";
import { arrange } from "./ui/arrange";
import {
  BEND_FALLOFF_DEFAULT,
  DEFAULT_PANEL_SIZES,
  DEFAULT_PREFS,
  freshExportGroup,
  NEUTRAL_PARAMS,
  NODE_H,
  NODE_W,
  DEFAULT_SECTIONS_CLOSED,
  PROFILE_DEFAULTS,
  spliceOut,
  SPLIT_DEFAULTS,
  COLLISION_TOLERANCE_DEFAULT,
  TOOL_SESSION_DEFAULTS,
} from "./state";
import { ON_DEMAND_IDS, sharpeningGroup, skinGroup } from "./recipes";

export const PHOTO = "/sample/photo.jpg";
export const TEST_PATTERN = "/sample/test-pattern.png";

/** The demo library's own photographs: whatever is dropped into
 * src/demo-photos, in filename order, cycling across the strip. On
 * the guide's screenshots: "What I don't like is that black and white
 * photo used. Especially in screenshots that is supposed to represent
 * a library of photos in the thumbnail view." One photo thirteen
 * times reads as a test rig; a folder of real ones reads as a
 * library, and a folder is something he can fill without touching
 * this file. Empty, everything falls back to the single sample, so
 * tests and a fresh clone behave exactly as before.*/
const DEMO_PHOTOS: string[] = Object.entries(
  import.meta.glob("./demo-photos/*.{jpg,jpeg,png,webp}", {
    eager: true,
    import: "default",
    query: "?url",
  }),
)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([, url]) => url as string);

const stripSpec: [string, number, boolean, string][] = [
  ["4866", 2, true, "contrast(1.05)"],
  ["4867", 1, false, "brightness(.9)"],
  ["4868", 3, true, "contrast(1.15) brightness(1.05)"],
  ["4869", 0, false, "brightness(1.1)"],
  ["4870", 2, true, "sepia(.2)"],
  ["4871", 4, true, "contrast(1.1)"],
  ["4872", 2, false, "brightness(.95)"],
  ["4873", 1, true, "contrast(1.2)"],
  ["4874", 0, false, "brightness(1.05)"],
  ["4875", 3, true, "sepia(.15) contrast(1.05)"],
  ["4876", 1, false, "brightness(.88)"],
  ["4877", 2, true, "contrast(1.08)"],
  ["4878", 0, false, "brightness(1.02)"],
];

export const IMAGES: ImageEntry[] = stripSpec.map(
  ([name, stars, edited, filter], i) => ({
    id: name,
    name: `DSC_0${name}.NEF`,
    stars,
    edited,
    filter,
    flag: i % 4 === 0 ? "pick" : i % 7 === 3 ? "reject" : "",
    // The ids, names, ratings and flags stay exactly as they were
    // whatever fills the folder: tests point at thumb-4866 and friends,
    // and a library's worth of metadata is part of what the demo
    // demonstrates. Only the pixels change.
    src:
      name === "4878"
        ? TEST_PATTERN
        : DEMO_PHOTOS.length
          ? DEMO_PHOTOS[i % DEMO_PHOTOS.length]
          : PHOTO,
  }),
);

export const PRESETS = [
  {
    name: "Cinematic Portrait Grade",
    meta: "6 nodes · 2 exposed",
    filter: "contrast(1.15) brightness(.92)",
  },
  {
    name: "Kodak Portra Portrait",
    meta: "5 nodes · 3 exposed",
    filter: "sepia(.25) contrast(1.05)",
  },
  {
    name: "Alvarez Mori, house look",
    meta: "9 nodes · 4 exposed",
    filter: "contrast(1.25) brightness(1.05)",
  },
  {
    name: "Reception Warm",
    meta: "4 nodes · 1 exposed",
    filter: "sepia(.4) brightness(1.08)",
  },
];

// The wedding graph from frame 5a: eleven nodes, Portra group feeding Merge,
// two masks routed into Color Balance and Exposure.
export const SAMPLE_NODES: NodeCard[] = [
  {
    id: "src",
    type: "heeler.image_source",
    name: "Image Source",
    cat: "source",
    x: 24,
    y: 96,
    enabled: true,
    params: { camera_wb: 1, camera_matrix: 1 },
    badge: "NEF",
    hasOut: true,
  },
  {
    id: "portra",
    type: "heeler.group",
    name: "Portra Grade",
    cat: "group",
    x: 24,
    y: 290,
    enabled: true,
    params: { grade_strength: 78 },
    isGroup: true,
    hasOut: true,
    // No node-count badge: the group is memberless (the engine's image
    // source by design), and the inspector counts real groupNodes, so a
    // hardcoded "6 nodes" here contradicted its "GROUP · 0 NODES".
  },
  {
    id: "merge",
    type: "heeler.merge",
    name: "Merge",
    cat: "utility",
    x: 199,
    y: 96,
    enabled: true,
    params: { opacity: 72 },
    badge: "72%",
    hasIn: true,
    hasIn2: true,
    hasOut: true,
  },
  {
    id: "stdcolor",
    type: "heeler.standard_color",
    name: "Standard Color",
    cat: "color",
    x: 374,
    y: 96,
    enabled: true,
    params: {
      temperature: 5480,
      tint: 6,
      saturation: 4,
      vibrance: 22,
    },
    hasIn: true,
    hasOut: true,
    maskIn: true,
  },
  {
    id: "detail",
    type: "heeler.detail",
    name: "Detail",
    cat: "detail",
    x: 549,
    y: 96,
    // Off in the demo like every on-demand section; the sample's old
    // texture and clarity ride here so the card has something to show.
    enabled: false,
    params: { texture: 12, clarity: 9, dehaze: 0 },
    hasIn: true,
    hasOut: true,
    maskIn: true,
  },
  {
    id: "cbal",
    type: "heeler.color_balance",
    name: "Color Balance",
    cat: "color",
    x: 549,
    y: 96,
    enabled: true,
    params: {
      shadows_lum: -4,
      midtones_lum: 2,
      highlights_lum: 6,
      shadows_hue: 0,
      midtones_hue: 0,
      highlights_hue: 0,
      shadows_sat: 0,
      midtones_sat: 0,
      highlights_sat: 0,
    },
    hasIn: true,
    hasOut: true,
    maskIn: true,
  },
  {
    id: "exposure",
    type: "heeler.exposure",
    name: "Exposure",
    cat: "color",
    x: 724,
    y: 96,
    enabled: true,
    params: {
      exposure: 0.62,
      contrast: 18,
      color_contrast: 0,
      highlights: -42,
      shadows: 35,
      whites: 8,
      blacks: -14,
    },
    badge: "+0.62",
    hasIn: true,
    hasOut: true,
    maskIn: true,
  },
  {
    id: "sharpen",
    type: "heeler.sharpen",
    name: "Sharpen",
    cat: "detail",
    x: 899,
    y: 96,
    enabled: true,
    params: { amount: 42, radius: 1, threshold: 0 },
    badge: "42",
    hasIn: true,
    hasOut: true,
  },
  // The two recipes as groups of their nodes, off in the sample like
  // every paid tool, at the recipes' own numbers; the section's switch
  // turns them on, and on a layer they follow its mask.
  sharpeningGroup("sharpening", 899, 196, { enabled: false }),
  skinGroup("skin", 899, 296, { enabled: false }),
  {
    // The creative falloff, distinct from Lens Correction's undo of the
    // one the glass made. On demand and off like Grain beside it, so a
    // fresh photograph carries neither.
    id: "vignette",
    type: "heeler.vignette",
    name: "Vignette",
    cat: "detail",
    x: 1074,
    y: 4,
    enabled: false,
    params: { vignette: 0, vignette_mid: 50, softness: 0.5 },
    hasIn: true,
    hasOut: true,
  },
  {
    id: "grain",
    type: "heeler.grain",
    name: "Grain",
    cat: "detail",
    x: 1074,
    y: 96,
    enabled: true,
    params: {
      intensity: 14,
      size: 28,
      // Grain as a share of the frame (Enlargement, idea 8).
      by_frame: 1,
      // The tonal and channel weights the engine declares. A node carries
      // every parameter it has, or the inspector has nothing to show a
      // control for: it renders what the node holds.
      shadows_gain: 100,
      midtones_gain: 100,
      highlights_gain: 100,
      red_gain: 100,
      green_gain: 100,
      blue_gain: 100,
    },
    badge: "14",
    hasIn: true,
    hasOut: true,
  },
  // The depth tools, neutral in the sample so it renders identically
  // with or without a computed depth plane. Key light shades the
  // scene, fog lays atmosphere over it, depth of field defocuses the
  // result: that order, and before the color bend like grain is.
  {
    // The depth map's settings, ahead of every tool that reads the
    // map. Off in the demo like the depth tools it serves.
    id: "depthmap",
    type: "heeler.depth_map",
    name: "Depth Map",
    cat: "detail",
    x: 1074,
    y: 96,
    enabled: false,
    params: { edges: 50, flatten: 25, near_clip: 0, far_clip: 0, size: 518 },
    hasIn: true,
    hasOut: true,
    // The second output: the farness plane as a field (26.3 Phase 4).
    depthOut: true,
  },
  {
    // The Color Checker (26.3 Phase 11): the camera calibration fitted
    // against a chart. Off in the demo like every on-demand section
    // the photograph never asked for: unit matrix, no exposure, a passthrough.
    id: "colorchecker",
    type: "heeler.color_checker",
    name: "Color Checker",
    cat: "source",
    x: 1214,
    y: 96,
    enabled: false,
    params: { ...NEUTRAL_PARAMS["heeler.color_checker"] },
    textParams: { chart: "colorchecker-classic", quad: "", patches: "", fit: "" },
    hasIn: true,
    hasOut: true,
  },
  {
    id: "keylight",
    type: "heeler.key_light",
    name: "Depth Lighting",
    cat: "detail",
    x: 1074,
    y: 196,
    // Off in the demo like every paid depth tool: identity params,
    // and the section ships switched off.
    enabled: false,
    params: { strength: 0, azimuth: 45, elevation: 45, ambient: 50, relief: 30, invert: 0 },
    hasIn: true,
    hasOut: true,
  },
  {
    id: "fog",
    type: "heeler.fog",
    name: "Fog",
    cat: "detail",
    x: 1074,
    y: 296,
    // Off in the demo like every paid depth tool: identity params,
    // and the section ships switched off.
    enabled: false,
    params: { density: 0, start: 0, falloff: 50, texture: 0, texture_size: 30, texture_shift: 0, fog_level: 72, fog_hue: 220, fog_sat: 10, desat: 0 },
    hasIn: true,
    hasOut: true,
  },
  {
    id: "dof",
    type: "heeler.dof",
    name: "Depth of Field",
    cat: "detail",
    x: 1074,
    y: 396,
    // Off in the demo like every paid depth tool: identity params,
    // and the section ships switched off.
    enabled: false,
    params: { aperture: 0, focus: 0, blades: 6, blade_curve: 100, fringe: 0, field_curve: 0, glow: 0, bubble: 0, squeeze: 0, swirl: 0 },
    hasIn: true,
    hasOut: true,
  },
  {
    id: "flare",
    type: "heeler.flare",
    name: "Lens Flare",
    cat: "detail",
    x: 1074,
    y: 496,
    // Off in the demo like every paid depth tool, and inert anyway
    // until a light in the rig flares.
    enabled: false,
    params: { intensity: 100, temp: 0, size: 5, softness: 40, rays: 14, ray_length: 25, ray_softness: 25, rotation: 0, ghosts: 2, ghost_spacing: 90, ghost_size: 4, blades: 7, dispersion: 20, ghost_opacity: 35, anamorphic: 0, streak_size: 1.5, streak_length: 60, streak_taper: 30, streak_angle: 0, streak_offset: 0, streak_shift: 0, streak_noise: 0, veil: 10, veil_radius: 35, veil_depth: 0, occlusion: 100, occlusion_soft: 30 },
    textParams: { lights: "[]", streak_color: "#5aa0ff", streak_stops: "", preset: "prime" },
    hasIn: true,
    hasOut: true,
  },
  {
    id: "halation",
    type: "heeler.halation",
    name: "Halation",
    cat: "detail",
    x: 1074,
    y: 596,
    // Off in the demo like every paid depth tool.
    enabled: false,
    params: { threshold: 50, background: 50, by_depth: 0, radius: 4, diffusion: 60, hue: 18, saturation: 70, blue_comp: 0, amount: 100, mix: 100, bloom: 0, bloom_radius: 20 },
    textParams: { format: "35mm" },
    hasIn: true,
    hasOut: true,
  },
  {
    id: "output",
    type: "heeler.output",
    name: "Output",
    cat: "utility",
    x: 1249,
    y: 96,
    enabled: true,
    params: {},
    badge: "JPEG",
    hasIn: true,
    // The export's transparency as a wired field (26.3 Phase 5).
    alphaIn: true,
  },
  {
    id: "lummask",
    type: "heeler.luminance_range_mask",
    name: "Luminance Mask",
    cat: "masking",
    x: 374,
    y: 290,
    enabled: true,
    params: {},
    badge: "sky",
    hasIn: true,
    maskOut: true,
  },
  {
    id: "brushmask",
    type: "heeler.brush_mask",
    name: "Brush Mask",
    cat: "masking",
    x: 549,
    y: 290,
    enabled: true,
    params: {},
    strokes: [],
    badge: "dress",
    hasIn: true,
    maskOut: true,
  },
  {
    // The print: off until the Print section is switched on, like the
    // paid tools.
    id: "paper",
    type: "heeler.paper",
    name: "Print",
    cat: "color",
    x: 1074,
    y: 290,
    enabled: false,
    params: { grade: 2, time: 0, split: 0, soft: 0, hard: 0, dmax: 2.1, base: 0, toning: 0, crossover: 50 },
    textParams: { toner: "" },
    hasIn: true,
    hasOut: true,
    maskIn: true,
  },
  {
    id: "curves",
    type: "heeler.curves",
    name: "Curves",
    cat: "color",
    x: 724,
    y: 290,
    // Off until someone bends it (bending arms it): an untouched curve
    // claiming to be on was the lie the owner caught. Real photos go
    // further and have no curves node at all until the tool is switched
    // on.
    enabled: false,
    params: {},
    curves: {},
    hasIn: true,
    hasOut: true,
    maskIn: true,
  },
  {
    id: "levels",
    type: "heeler.levels",
    name: "Levels",
    cat: "color",
    x: 899,
    y: 290,
    // The Curves section's switch reads this node, so an unedited
    // photograph showed Curves ON with no curve anywhere in the graph. The
    // report: "its misleading showing Curves as 'On' when its not even in
    // the node graph." Identity levels render the same on or off, and
    // touching any of its sliders arms it.
    enabled: false,
    params: { black: 0, white: 1, gamma: 1, black_soft: 0, white_soft: 0 },
    hasIn: true,
    hasOut: true,
    maskIn: true,
  },
  // enabled = bypass (the Color section switch); amount = treatment.
  {
    id: "toneeq",
    type: "heeler.tone_eq",
    name: "Relight",
    cat: "color",
    x: 812,
    y: 194,
    // The demo keeps its card, switched off, which is the bargain
    // every paid-and-dark section makes here: a fresh photograph does
    // not carry the node at all (OFF_BY_DEFAULT_NODES takes it out of
    // NEUTRAL_NODES), and the sample session shows what the tool is
    // without pretending it ships on.
    enabled: false,
    // Every zone at zero: the identity, the same bargain Lens
    // Correction ships under. Exposure by illuminance zone.
    params: {
      ev_m4: 0,
      ev_m3: 0,
      ev_m2: 0,
      ev_m1: 0,
      ev_0: 0,
      ev_p1: 0,
      ev_p2: 0,
      ev_p3: 0,
      ev_p4: 0,
      smoothing: 50,
      range_shift: 0,
    },
    hasIn: true,
    hasOut: true,
    maskIn: true,
  },
  {
    id: "bw",
    type: "heeler.black_white",
    name: "Black & White",
    cat: "color",
    x: 1074,
    y: 290,
    enabled: true,
    params: { red: 30, green: 59, blue: 11, amount: 0 },
    hasIn: true,
    hasOut: true,
    maskIn: true,
  },
  {
    id: "denoise",
    type: "heeler.denoise",
    name: "Denoise",
    cat: "detail",
    x: 1249,
    y: 290,
    enabled: true,
    params: { strength: 0 },
    badge: "0",
    hasIn: true,
    hasOut: true,
    maskIn: true,
  },
  {
    id: "crop",
    type: "heeler.crop_rotate",
    name: "Crop & Rotate",
    cat: "source",
    x: 199,
    y: 290,
    enabled: true,
    params: { angle: 0, aspect: 0, crop_x: 0, crop_y: 0, crop_w: 1, crop_h: 1 },
    hasIn: true,
    hasOut: true,
  },
  {
    id: "lens",
    type: "heeler.lens_correct",
    name: "Lens Correction",
    cat: "source",
    x: 199,
    y: 484,
    enabled: true,
    // Every control at zero, so the node is an identity until somebody
    // moves something. A correction category that shipped doing something
    // would change every photograph in the catalog the day it landed.
    params: { distortion: 0, ca_red: 0, ca_blue: 0, vignette: 0, vignette_mid: 50 },
    hasIn: true,
    hasOut: true,
    maskIn: true,
  },
  {
    id: "bend",
    type: "heeler.color_bend",
    name: "Color Bend",
    cat: "color",
    x: 724,
    y: 484,
    enabled: false,
    params: {
      src_hue: 0,
      src_sat: 0,
      dst_hue: 0,
      dst_sat: 0,
      falloff: BEND_FALLOFF_DEFAULT,
      amount: 100,
    },
    hasIn: true,
    hasOut: true,
    maskIn: true,
  },
  {
    id: "colorconsole",
    type: "heeler.color_console",
    name: "Color Tune",
    cat: "color",
    x: 1074,
    y: 484,
    // Bypassed even in the demo, the same bargain Recolor ships under.
    enabled: false,
    // No bands: the identity, the Lens Correction bargain.
    params: { smoothing: 50 },
    hasIn: true,
    hasOut: true,
    maskIn: true,
  },
  {
    id: "recolor",
    type: "heeler.recolor",
    name: "Recolor",
    cat: "color",
    x: 899,
    y: 484,
    // Bypassed even in the demo: identity with no curves, and the
    // section ships off. It arms itself when a curve says something.
    enabled: false,
    // No curves: the identity, the Lens Correction bargain again. The
    // routing grid writes them.
    params: { neutral_guard: 10, smoothing: 50 },
    hasIn: true,
    hasOut: true,
    maskIn: true,
  },
  // Base rendering: scene-linear develop reads flat without a tone
  // profile, so this ships enabled and visible rather than baked in.
  {
    id: "profile",
    type: "heeler.tone_profile",
    name: "Tone Profile",
    cat: "color",
    x: 1074,
    y: 484,
    enabled: true,
    // The measured defaults: baseline lift, toe, and shoulder, from the
    // reference editor comparisons. See PROFILE_DEFAULTS.
    params: { contrast: 100, ...PROFILE_DEFAULTS, development: 0 },
    textParams: { mode: "standard" },
    badge: "standard",
    hasIn: true,
    hasOut: true,
  },
];

export const SAMPLE_WIRES: Wire[] = [
  { from: "src", to: "merge", toPort: "in", kind: "image" },
  { from: "portra", to: "merge", toPort: "in2", kind: "group" },
  // Geometry after the merge so both branches crop together.
  { from: "merge", to: "crop", toPort: "in", kind: "image" },
  // The lens correction warps the frame, so it goes before anything that
  // reads neighboring pixels: sharpening a warped frame is right,
  // warping a sharpened one is not.
  { from: "crop", to: "lens", toPort: "in", kind: "image" },
  // The Depth Map's fixed seat (26.3 Phase 10): after geometry, before
  // anything tonal. The picture passes through untouched; the plane
  // leaves by the depth port.
  { from: "lens", to: "depthmap", toPort: "in", kind: "image" },
  // The Color Checker's seat (26.3 Phase 11): after the depth map,
  // before Color, so it corrects the camera before anything creative
  // and a calibration never rekeys the depth plane.
  { from: "depthmap", to: "colorchecker", toPort: "in", kind: "image" },
  { from: "colorchecker", to: "stdcolor", toPort: "in", kind: "image" },
  // Masks read the image; without a feed they cannot rasterize.
  { from: "src", to: "lummask", toPort: "in", kind: "image" },
  { from: "src", to: "brushmask", toPort: "in", kind: "image" },
  { from: "stdcolor", to: "detail", toPort: "in", kind: "image" },
  { from: "detail", to: "cbal", toPort: "in", kind: "image" },
  { from: "cbal", to: "exposure", toPort: "in", kind: "image" },
  { from: "exposure", to: "toneeq", toPort: "in", kind: "image" },
  { from: "toneeq", to: "bw", toPort: "in", kind: "image" },
  { from: "bw", to: "denoise", toPort: "in", kind: "image" },
  { from: "denoise", to: "sharpen", toPort: "in", kind: "image" },
  { from: "sharpen", to: "sharpening", toPort: "in", kind: "image" },
  { from: "sharpening", to: "skin", toPort: "in", kind: "image" },
  { from: "skin", to: "vignette", toPort: "in", kind: "image" },
  { from: "vignette", to: "grain", toPort: "in", kind: "image" },
  // The tone profile is the last shaping step before output.
  { from: "grain", to: "keylight", toPort: "in", kind: "image" },
  { from: "keylight", to: "fog", toPort: "in", kind: "image" },
  { from: "fog", to: "dof", toPort: "in", kind: "image" },
  { from: "dof", to: "flare", toPort: "in", kind: "image" },
  { from: "flare", to: "halation", toPort: "in", kind: "image" },
  { from: "halation", to: "bend", toPort: "in", kind: "image" },
  // Bend sits late: it moves color that is already graded, which is
  // where you notice a hue that needs shifting.
  { from: "bend", to: "recolor", toPort: "in", kind: "image" },
  { from: "recolor", to: "colorconsole", toPort: "in", kind: "image" },
  { from: "colorconsole", to: "profile", toPort: "in", kind: "image" },
  // Curves last: the curve bends the photograph the screen shows,
  // profile and all, so the curve's axis IS the screen's tonality and
  // the eyedropper lands where the eye says it should.
  // Levels on the profile as well, ahead of Curves: its handles sit on
  // the histogram of the picture as shown.
  { from: "profile", to: "levels", toPort: "in", kind: "image" },
  { from: "levels", to: "curves", toPort: "in", kind: "image" },
  { from: "curves", to: "paper", toPort: "in", kind: "image" },
  { from: "paper", to: "output", toPort: "in", kind: "image" },
  { from: "lummask", to: "cbal", toPort: "mask", kind: "mask" },
  // No brushmask->exposure wire: an unpainted brush mask is all zeros and
  // would silently gate the node to "no effect" (field-found bug).
];


/** The node each off-by-default category switches.
 *
 * "I am resetting the edits on an image but still see a lot of
 * categories enabled by default that I know I said should be off."
 *
 * He is right: the categories collapsed and their switches read off, but the
 * nodes behind them were still enabled, so a freshly reset photograph was
 * running six nodes nobody had asked for. Building them only on demand is
 * still to come; shipping them bypassed is the half that can land now, and it
 * is the half that decides what a reset photograph actually renders.
 */
export const OFF_BY_DEFAULT_NODES: Record<string, string> = {
  // Relight, on demand and off, like the tools it now sits under (The
  // report: "RELIGHT should be off by default (no nodes in the
  // graph)").
  toneeq: "Relight",
  curves: "Curves",
  levels: "Levels",
  cbal: "Color Wheels",
  bend: "Color Bend",
  lens: "Lens",
  crop: "Geometry",
  detail: "Detail",
  grain: "Grain",
  vignette: "Vignette",
  // These tools ship dark (2026-08-25: "Off and collapsed by
  // default"). All on-demand like their neighbors; Color Tune and
  // Recolor also arm themselves the moment a band or a curve says
  // something.
  colorconsole: "Color Tune",
  recolor: "Recolor",
  depthmap: "Depth Map",
  fog: "Fog",
  keylight: "Depth Lighting",
  dof: "Depth of Field",
  flare: "Lens Flare",
  halation: "Halation",
  paper: "Print",
  sharpening: "Sharpening",
  skin: "Skin Softening",
  // Grid Warp: on demand and collapsed by default. Its node is
  // built by the first drag or the switch; no template carries it.
  gridwarp: "Grid Warp",
  shapewarp: "Shape Warp",
  // Color Checker (26.3 Phase 11): on demand like the warps;
  // the sample session carries its node switched off, like Depth Map.
  colorchecker: "Color Checker",
};

/** Demo furniture: nodes the SAMPLE session shows off that a fresh
 * photograph has no business starting with. On finding the two masks
 * pre-placed in a new image: "nodes should always be on-demand. This
 * can also save on excess node data in the database that isn't being
 * used." Masks arrive when a layer or the palette asks, and mask
 * wires are one drag now, so nothing needs to be pre-seeded.*/
const DEMO_ONLY_IDS = new Set([
  "lummask",
  "brushmask",
  // The wedding sample's "Portra Grade" group and the Merge it feeds: an
  // empty group card with a badge, demo dressing for the sample session
  // that every fresh photograph was carrying too. "It looks
  // like a group node but I can't open it. I turned it off and saw no
  // effect." Nothing to open and nothing to switch off, because there
  // was never anything in it.
  "portra",
  "merge",
]);

/** The sample wiring with the on-demand nodes taken out and the chain closed
 * over the gaps. A wire that fed one of them and has nowhere else to go
 * (the luminosity mask into Color Balance) goes with it; the mask node
 * stays, since it is the mask that is the user's, not the wire. */
export const NEUTRAL_WIRES: Wire[] = (() => {
  let wires = SAMPLE_WIRES;
  for (const id of ON_DEMAND_IDS) wires = spliceOut(wires, id);
  // The demo masks go with their wires: spliceOut heals image chains,
  // and a mask wire simply vanishes with its mask.
  for (const id of DEMO_ONLY_IDS) wires = spliceOut(wires, id);
  return wires;
})();

/** The template nodes, laid out the way Arrange lays them out: one row,
 * one column per step of the chain. They used to keep the SAMPLE
 * session's coordinates, which were drawn for the wedding graph's
 * eleven nodes, so with the on-demand pieces gone the five that remain
 * sat scattered, Tone Profile a screen below the rest
 * ("Cleaner, less nodes, but still not organized"). Arranged by the
 * same function the Arrange command runs, so the default and the
 * tidied graph are one layout rather than two that happen to agree.*/
const placeNeutral = (nodes: NodeCard[]): NodeCard[] => {
  const at = arrange(nodes, NEUTRAL_WIRES, NODE_W, NODE_H);
  return nodes.map((n) => {
    const p = at.get(n.id);
    return p ? { ...n, x: p.x, y: p.y } : n;
  });
};

export const NEUTRAL_NODES: NodeCard[] = placeNeutral(SAMPLE_NODES.filter(
  // A photograph with no edits on it holds the nodes it needs to be a
  // photograph and nothing else. Bypassed was the half-measure; these are
  // not in the graph at all until a category asks for them, and they come
  // back with everything they had when it asks again.
  (n) => !ON_DEMAND_IDS.has(n.id) && !DEMO_ONLY_IDS.has(n.id),
).map((n) => ({
  ...n,
  params: NEUTRAL_PARAMS[n.type]
    ? { ...NEUTRAL_PARAMS[n.type] }
    : { ...n.params },
  badge: NEUTRAL_PARAMS[n.type] ? undefined : n.badge,
  enabled: OFF_BY_DEFAULT_NODES[n.id] ? false : n.enabled,
})).map((n) =>
  // A fresh graph is born wearing today's default look. It used to be
  // born flat and get the look stapled on by the load effect's
  // apply_profile_defaults, which only runs on a load: Reset all edits
  // rebuilt from this template WITHOUT reloading, so the viewer sat dark
  // until a switch away and back re-saved and re-upgraded it (the
  // owner's before/after screenshots, 2026-08-23). Written here rather
  // than in NEUTRAL_PARAMS on purpose: NEUTRAL_PARAMS backfills SAVED
  // graphs via withEveryParam, and injecting the look there would
  // sidestep needsProfileDefaults' owner-hands-off guard.
  n.type === "heeler.tone_profile"
    ? { ...n, params: { ...n.params, ...PROFILE_DEFAULTS } }
    : n,
));



export function initialState(): State {
  return {
    mode: "simple",
    browserOpen: true,
    ribbonOpen: true,
    images: IMAGES,
    activeImage: "4871",
    nodes: SAMPLE_NODES,
    wires: SAMPLE_WIRES,
    backdrops: [],
    renderVersion: 0,
    graphLoading: null,
    selection: [],
    groupDialogOpen: false,
    fileLayersOffer: null,
    catalogLayerPick: false,
    transformLock: false,
    presets: PRESETS.map((p) => ({ ...p })),
    undoStack: [],
    redoStack: [],
    viewerZoom: "fit",
    view: {
      zoomScale: 1,
      pan: { x: 0, y: 0 },
      viewRotation: 0,
      splitPos: 0.5,
      roiPatch: null,
      stagePx: null,
      frameDims: {},
    },
    graphView: { x: 0, y: 0, zoom: 1 },
    graphViewBack: null,
    compare: false,
    compareTake: null,
    splitOn: false,
    split: SPLIT_DEFAULTS,
    openedGroup: null,
    ...TOOL_SESSION_DEFAULTS,
    gridWarp: { selected: [], influence: 1, heat: "luma", link: false, live: null },
    lineColor: { hue: null, luma: null },
    photoLineWidth: {},
    shapeWarp: { selected: null, mode: "position" },
    brushRadius: 0.04,
    brushTip: "circle",
    brushHardness: 0.8,
    brushFlow: 1,
    selectMethod: "freehand",
    apiEnabled: false,
    deleteHeals: true,
    selectFromCenter: false,
    selectAntialias: true,
    selectAutoClear: true,
    selectShowClicks: true,
    rawProfile: "standard",
    rawSharpening: "standard",
    polishMode: "matte",
    polishPreview: "overlay",
    shapeMode: "transform",
    dodgeMode: "dodge",
    repairMode: "heal",
    blurMode: "blur",
    artContentKind: "paint",
    layerExpandOnSelect: false,
    selectTolerance: 0.2,
    // Half is the magnet's old fixed threshold, so the default traces
    // exactly as it always did.
    selectMagnetSense: 0.5,
    selectSmooth: 0.5,
    selectBrushRadius: 0.04,
    polishView: "overlay",
    polishRadius: 0.03,
    polishAdd: true,
    matteApply: null,
    brushTextureScale: 0.5,
    brushTextureAngle: 0,
    brushTextureDepth: 1,
    brushShowDab: uiPref("brushShowDab", true),
    brushCloneAligned: uiPref("brushCloneAligned", true),
    // Where the Overlay strength starts: the preference, which the
    // saved settings restore through set_prefs at launch.
    brushOverlayStrength: DEFAULT_PREFS.maskOverlayOpacity / 100,
    brushBlurStrength: uiPref("brushBlurStrength", 0.08),
    brushBlurBuild: uiPref("brushBlurBuild", false),
    brushSampleLayer: uiPref("brushSampleLayer", false),
    expandedTile: uiPref("expandedTile", 168),
    curvePick: null,
    csetDropper: null,
    csetHoverHue: null,
    csetMaskView: null,
    probeNode: null,
    abCompare: null,
    maskRed: false,
    harmony: { mode: "off", anchor: 30, strength: 60 },
    spectrumSel: false,
    smartAsk: 0,
    resetPending: [],
    restorePending: [],
    gamutView: false,
    toneEqPick: null,
    toneEqHoverX: null,
  wbPick: null,
    recolorPick: null,
    recolorMatch: null,
    recolorHoverX: null,
    bwSeparate: null,
    bwPick: false,
    bwHoverHue: null,
    zonesView: false,
    zoneHover: null,
    zonePlace: null,
    zonesOpen: false,
    consolePick: null,
    consolePickBand: null,
    artActive: null,
    artSelected: [],
    artGradientEdit: null,
    paintColor: "#ffffff",
    dodgeStrength: 15,
    curveHoverX: null,
    // The ribbon starts at its old fixed width, so nothing moves for
    // anyone who never drags it.
    panelSizes: { ...DEFAULT_PANEL_SIZES },
    selectionSplitMin: false,
    selectionSplitClosed: false,
    sectionFilter: "all",
    consoleOpen: false,
    consoleWindowOpen: false,
    graphPoppedOut: false,
    inspectorHome: "main",
    // The browser build has no catalog to wait for, so it never shows a
    // splash; the desktop boot sets this on its first step.
    boot: null,
    splashDismissed: false,
    imageSelection: [],
    filterStacksOnly: false,
    previewNonce: 0,
    canvasNodesHidden: false,
    canvasInspectorOpen: false,
    activeLayer: null,
    maskView: false,
    depthView: false,
    collisionView: false,
    collisionTolerance: COLLISION_TOLERANCE_DEFAULT,
    depthEpoch: 0,
    depthRecompute: null,
    filePasses: null,
    halationView: false,
    keyLightPick: false,
    chartPlace: false,
    keyLightSel: null,
    dofPick: false,
    findControlOpen: false,
    controlFlash: null,
    folders: [],
    folderTree: null,
    activeFolderPath: null,
    collections: [],
    editedFolders: [],
    foldersWithHidden: [],
    foldersWithTrash: [],
    missingTrashed: { count: 0, skipped: 0 },
    thumbProgress: null,
    stitch: null,
    stackMerges: {},
    stackCanceled: {},
    stitchCanceled: {},
    baking: null,
    exportOpen: false,
    layoutRoom: null,
    layoutPinned: [],
    exportQueue: { groups: [freshExportGroup([], DEFAULT_PREFS)], active: 0 },
    serveLive: false,
    tagFilter: null,
    expandedView: "grid",
    catalogCompare: null,
    editClipboard: null,
    curveClipboard: null,
    recolorClipboard: null,
    quadEdit: null,
    linkPinned: [],
    linkDirty: [],
    linkOverrides: [],
    quadGraphs: {},
    keynav: null,
    panelTab: "adjust",
    panelBottom: [],
    panelTabBottom: "history",
    ribbonView: "thumbs",
    ribbonExpanded: false,
    ribbonSort: { column: "name", desc: false },
    spectrumsPoppedOut: false,
    takesPoppedOut: false,
    toolPopouts: { wheels: false, curves: false, toneeq: false, recolor: false, colorconsole: false },
    bendPoppedOut: false,
    prefsOpen: false,
    prefsLanding: null,
    selectDialog: null,
    renameRequest: null,
    graphSearchOpen: false,
    notice: null,
    docsOpen: false,
    docsFile: null,
    catalogsOpen: false,
    confirm: null,
    lookPreview: null,
    bake: null,
    // "JPG, TIFF, DNG (default)".
    bakeFormat: "dng",
    prefs: { ...DEFAULT_PREFS },
    recentNodes: [],
    userRecipes: [],
    recipeOps: [],
    palette: null,
    filterEdited: "all",
    filterTakesMin: 1,
    filterTakesMax: 10,
    activeCollection: null,
    libraryLabel: "Sample session",
    filterStars: 0,
    filterPicksOnly: false,
    filterHideRejected: false,
    filterFlagInverted: false,
    filterName: "",
    filterDateFrom: "",
    filterDateTo: "",
    shotDates: {},
    gesture: null,
    gesturePushed: false,
    graphs: {},
    takes: {},
    activeTakes: {},
    multiTakes: [],
    // Both off, and so not in the graph at all until asked for.
    // "All categories that are off by default should be collapsed." Source
    // ships collapsed too, but ON: it is always in the graph, it just does
    // not need to greet every session with four rows open.
    sectionsClosed: [...DEFAULT_SECTIONS_CLOSED],
    presetFolds: null,
    defaultGraph: {
      nodes: structuredClone(NEUTRAL_NODES),
      wires: structuredClone(NEUTRAL_WIRES),
    },
  };
}
