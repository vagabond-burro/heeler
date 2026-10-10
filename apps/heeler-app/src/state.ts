import exportResolution from "../../../crates/heeler-io/export-resolution.json";
// App state: a faithful TS mirror of the backend graph semantics
// (heeler-graph / heeler-commands). Every mutation goes through dispatch of
// a Command, giving undo/redo one shared path, same as the Rust side.

import { convertLegacyFit, fitNeedsOrderFix, type FitOrderFields } from "./checkerfit";
import { dayInRange } from "./datefilter";
import { isNameFormat, type NameFormat } from "./consolebands";
import { logMsg } from "./log";
import { cornersOf, mapPoint, solveHomography, type Pt } from "./quadmap";
import { flipQuad, frameAspectFor, reframeQuad } from "./imagelayers";
import { cropGeomOf, flippedCropParams, sourceSizeFor, frameRemap, mirrorRemap, remapNode, remapNodes, sameCrop, sourceAspectFor, type CropGeom, type FrameRemap } from "./framemap";
import type { NavState } from "./keynav";
import {
  grow as growGridSelection,
  isIdentity as isMeshIdentity,
  insertLine as insertGridLine,
  meshFromNode,
  meshTextParams,
  removeLine as removeGridLine,
  resampleMesh,
  restMesh,
  shrink as shrinkGridSelection,
  vertexCount,
  type GridMesh,
} from "./gridwarp";
import { newShape, restShape, serializeShapes, shapeFrom, shapesFromNode, shapesIdentity, type WarpShape } from "./shapewarp";
import {
  applyRecipe,
  CATEGORY_OF,
  CATEGORY_PIECES,
  CHAIN_ORDER,
  isRecipeNode,
  ON_DEMAND_IDS,
  TOOL_PIECES,
  type CategoryPiece,
  type Recipe,
  LEGACY_RECIPE_PREFIX,
  sharpeningGroup,
  skinGroup,
  pushToolGroup,
  pullToolGroup,
  TOOL_GROUP_DEFAULTS,
  sceneSafeToolGroup,
  resetToolGroup,
} from "./recipes";
// Takes the node size as arguments rather than reading it from here, so it
// has no runtime import of this module and there is no cycle to reason about.
import { hasSecondInput, hasThirdInput, MASK_IN_TYPES, DEPTH_IN_TYPES, ALPHA_IN_TYPES, engineKnows, engineTakesMask, fieldSpliceSeats } from "./nodes";
import { parseRecolorCurves, type EqPoint, type RecolorBy } from "./eqcurve";
import { harmonize, type Harmony } from "./harmony";
import { fitLayout, type FoldablePanel, type LayoutFit } from "./layoutfit";
import { logDebug } from "./log";
import { addColorSet, listColorSets, removeColorSet } from "./colorsets";
import { arrange } from "./ui/arrange";
import { experimentalEnabled } from "./features";
import registryDefaultsJson from "./registry-defaults.json";
import { lookById, type SectionLook } from "./sectionlooks";
import { recipeFromGroup, savableAsRecipe, type NodeRecipe, type RecipeOp } from "./noderecipes";
import { activeLayerMask, layerAdjOfNode, layerToolId, layerGroupPrefix, layerLightingTwin, isLayerAdj, isLayerMask, isLayerNode, layerNodeId, layerNumber, layerPart, maskOfLayer } from "./layerids";

/** The engine registry's own default for every numeric param and flag
 * (flags as 0 and 1), per node type: generated from spec.rs by the
 * desktop's the_registry_defaults_mirror_matches_the_engine_registry,
 * which fails when this copy goes stale. What a dial nobody has set
 * shows, and what a node placed from the palette is given (a fresh
 * Luminance Mask read Low 0, High 0, Feather 0 because nothing the
 * frontend consulted knew its registry said 0, 1 and 0.1).*/
export const REGISTRY_DEFAULTS: Record<string, Record<string, number>> = registryDefaultsJson;

/** Everything under Preferences.
 *
 * One object so it saves and loads as one thing, and so a preference
 * added later does not need its own plumbing. Unknown keys from a newer
 * build are kept rather than dropped, which is what makes rolling back a
 * version not lose settings.
 */
export interface Prefs {
  /** how many nodes the palette shortlist holds, 5 to 20 */
  paletteRecents: number;
  /** how many custom bands the Color Tune may hold, 1 to 8 */
  consoleCustomMax: number;
  /** how thick the outlines drawn over the photograph are, Shape Warp's
   * rings and the Radial layer's gizmo, in pixels: 1 to 8, and the
   * shipped 2 is twice what the rings were first drawn at (2026-09-07;
   * then "that thickness value reads odd", so pixels, not a
   * percentage). A photograph may set its own (State.photoLineWidth,
   * kept in its saved file beside the graph, never in it).*/
  shapeLineWidth: number;
  /** what the Color Tune's list calls an unnamed custom band: the
   * color it was picked from, as RGB, CMY or hex */
  consoleNameFormat: NameFormat;
  /** how the Curves editor opens on a photograph: the RGB channels or
   * the same curves seen as ink (CMY). The panel's toggle overrides it
   * for the photograph on screen only (State.curveMode). */
  curveMode: CurveMode;
  /** the Depth Map section's settings for a photograph that has none
   * yet: what the section is born with and what its reset returns to.
   * The shipped values match the registry's (NEUTRAL_PARAMS holds the
   * test) so a graph made without the preference reads the same. */
  depthEdges: number;
  depthFlatten: number;
  /** the model's working size on the long edge: 518, 700 or 1036 */
  depthSize: number;
  /** command id to key binding, overriding that command's default */
  hotkeys: Record<string, string>;
  /** how often to back the catalog up automatically, in days. 0 is off.
   * Off by default: the app does not start writing copies of itself
   * into a folder nobody chose. */
  backupEveryDays: number;
  /** where those backups go. Empty means the schedule cannot run. */
  backupFolder: string;
  /** recovery bundles carry the pictures Layer via Copy and Bake Warp
   * keep (2026-10-01: "I would say alert the user and give the choice to
   * them. I would lean towards it being on by default"). Off, a bundle
   * records them by path and checksum only (recovery.rs
   * keeps_finish_pictures reads this from the saved settings).*/
  keepBakedInBackups: boolean;
  /** degrees ALT+[ and ALT+] turn the grain by */
  brushGrainStep: number;
  /** degrees SHIFT+ALT+[ and SHIFT+ALT+] turn it by, for the fine pass */
  brushGrainFineStep: number;
  /** JPEG quality for the title-bar Quick Export */
  quickQuality: number;
  /** how Quick Export sizes the file: full frame, a long-edge cap, or
   * a percentage of the frame */
  quickResize: "full" | "edge" | "percent";
  /** long-edge cap in px, used when quickResize is "edge" */
  quickEdge: number;
  /** the print resolution a quick export declares (exportDpi) */
  quickDpi: number;
  /** percent of the frame, used when quickResize is "percent" */
  quickPercent: number;
  /** share links as bare ip:port, no access token in the address. The
   * token still exists under the hood; the server redirects into it. */
  serveSimpleLink: boolean;
  /** ask before deleting a take. The dialog's "Don't show this again"
   * turns it off; the Preferences toggle is the way back. */
  confirmDeleteTake: boolean;
  /** unfold a collapsed section the moment its switch turns on. Off by
   * default (2026-09-07: "I personally don't like this but some user
   * might").*/
  expandSectionOnEnable: boolean;
  /** Adjustments sections pinned to the top of the panel, in the order
   * they were pinned, by title. A tester asked to filter for the
   * sections they use most; a preference, so it follows the user
   * across photographs and launches. */
  pinnedSections: string[];
  /** Adjustments sections the user has taken out of the panel, by title:
   * Preferences > Interface > Adjustment sections (2026-09-20: someone
   * may never want to use, for example, Halation or Lens Flare). A hidden
   * section's node is untouched and
   * keeps rendering; only the panel, the Find a Control list and the
   * keyboard walk stop listing it.*/
  hiddenSections: string[];
  /** wheel zoom sensitivity, expressed as the exponent rate per delta */
  viewerZoomRate: number;
  /** degrees applied by one wheel rotation step */
  viewerRotationStep: number;
  /** longest edge of the settled interactive preview */
  previewEdge: number;
  /** what the settled preview is rendered from once the hand is off:
   * "screen", the reduced tier at the settled edge, or "full", the
   * whole photograph at its own pixels, rendered after the reduced
   * frame lands and swapped in (2026-09-23: "people like to see as
   * close as possible to the final render result").*/
  settledPreview: "screen" | "full";
  /** how the settled frame travels from the engine: the JPEG quality
   * of the whole-frame full-resolution settle, in three named steps
   * (SETTLE_JPEG_QUALITY). The reduced frames and the 1:1 slices are
   * not affected; they go at 94 and are judged pixel by pixel. */
  settleQuality: "smaller" | "balanced" | "sharper";
  /** longest edge used while a gesture is live */
  gesturePreviewEdge: number;
  /** minimum and maximum draggable widths of the thumbnail ribbon */
  ribbonMinWidth: number;
  ribbonMaxWidth: number;
  /** longest edge generated for thumbnail images */
  thumbnailEdge: number;
  /** quiet time after an edit before graph and thumbnail persistence */
  autosaveDelayMs: number;
  /** tint used for mask overlays in the viewer and brush tools */
  maskOverlayColor: "red" | "magenta" | "cyan" | "green";
  /** the overlay's opacity where the mask is white, in percent: the
   * strength every mask overlay starts at (2026-09-29: "the default red
   * opacity (50% opacity and 100% white) should be something a user can
   * define in preferences")*/
  maskOverlayOpacity: number;
  /** defaults applied when the Tether tab is opened */
  tetherDestination: string;
  tetherNamingPattern: string;
  tetherAutoAdvance: boolean;
  tetherPollMs: number;
  /** defaults shared by Quick Export and newly created batch groups */
  exportDefaultFormat: "jpeg" | "webp" | "png" | "png16" | "tiff" | "tiff32" | "dng" | "exr";
  exportTemplate: string;
  exportKeepMetadata: boolean;
  /** Never write over a file that is already there, in any export.
   *
   * On, and meant to stay on. A batch has always behaved this way (no
   * dialog ever asked, so a taken name moves to the next free one);
   * this extends it to the save dialog, where the OS asks Replace? and
   * a yes is easy to give to the wrong file. Off, that yes is honored
   * again. What it can never do is authorize writing over a photograph
   * the library knows about: that refusal lives in the backend and has
   * no switch. */
  exportNeverOverwrite: boolean;
  /** model storage location override; empty resolves to the app data
   * dir, and the Rust vision_base honors the same field for the GUI,
   * batch, and headless paths */
  modelStoreDir: string;
  /** flips the wheel and trackpad zoom direction in viewer and graph */
  wheelZoomInverted: boolean;
  /** previews may use the GPU tail; HEELER_GPU=0 still forces CPU
   * regardless, and exports never touch the GPU */
  gpuPreviews: boolean;
  /** opens the doors to preview features still under development
   * (currently the Tether tab). Off by default: a feature that cannot
   * keep its promise yet must not sit in the menu looking finished. */
  experimentalFeatures: boolean;
  /** asks the public release list at launch whether a newer Heeler
   * exists (src/updates.ts). On by default; off, Help > Check for
   * Updates still answers. Nothing is ever downloaded by itself. */
  checkUpdatesOnLaunch: boolean;
  /** the assistant: off by default. The notice accepted on turning
   * it on is recorded in the app data folder, not here, so a
   * second catalog does not ask again.*/
  assistantEnabled: boolean;
  /** the model server the assistant talks to, as typed; the check that
   * it is on this computer happens in Rust at every connection */
  assistantAddress: string;
  /** the model picked from the server's list after Validate */
  assistantModel: string;
  /** the address that last validated with the model above: the Console's
   * Assistant tab appears only while it equals assistantAddress, so an
   * edited address waits for Validate */
  assistantValidated: string;
}

export const DEFAULT_PREFS: Prefs = {
  paletteRecents: 10,
  consoleCustomMax: 4,
  shapeLineWidth: 2,
  consoleNameFormat: "rgb",
  curveMode: "rgb",
  depthEdges: 50,
  depthFlatten: 25,
  depthSize: 518,
  hotkeys: {},
  backupEveryDays: 0,
  backupFolder: "",
  keepBakedInBackups: true,
  brushGrainStep: 15,
  brushGrainFineStep: 5,
  quickQuality: 92,
  quickResize: "full",
  quickEdge: 2048,
  quickDpi: exportResolution.defaultDpi,
  quickPercent: 50,
  // Off by default: the token link is the safer stranger-on-the-wifi
  // default, and simple links are one preference away. "I
  // think it should be optional. A preference in settings."
  serveSimpleLink: false,
  confirmDeleteTake: true,
  expandSectionOnEnable: false,
  pinnedSections: [],
  hiddenSections: [],
  viewerZoomRate: 0.0015,
  viewerRotationStep: 2,
  previewEdge: 2048,
  settledPreview: "screen",
  settleQuality: "balanced",
  gesturePreviewEdge: 1024,
  ribbonMinWidth: 124,
  ribbonMaxWidth: 380,
  thumbnailEdge: 480,
  autosaveDelayMs: 400,
  maskOverlayColor: "red",
  maskOverlayOpacity: 50,
  tetherDestination: "",
  tetherNamingPattern: "",
  tetherAutoAdvance: true,
  tetherPollMs: 2000,
  exportDefaultFormat: "jpeg",
  exportTemplate: "{name}",
  exportKeepMetadata: true,
  exportNeverOverwrite: true,
  modelStoreDir: "",
  wheelZoomInverted: false,
  gpuPreviews: true,
  experimentalFeatures: false,
  checkUpdatesOnLaunch: true,
  assistantEnabled: false,
  // LM Studio's own default, prefilled.
  assistantAddress: "http://localhost:1234",
  assistantModel: "",
  assistantValidated: "",
};

export const MASK_OVERLAY_COLORS: {
  id: Prefs["maskOverlayColor"];
  label: string;
  rgb: string;
}[] = [
  { id: "red", label: "Red", rgb: "220,64,58" },
  { id: "magenta", label: "Magenta", rgb: "218,72,190" },
  { id: "cyan", label: "Cyan", rgb: "48,190,210" },
  { id: "green", label: "Green", rgb: "74,190,105" },
];

/** The overlay opacity preference, in whole percent, 0 to 100. */
export function clampMaskOverlayOpacity(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(100, Math.max(0, Math.round(value)))
    : DEFAULT_PREFS.maskOverlayOpacity;
}

/** The Overlay strength, 0 to 1: the share of the tint where the mask
 * is white. The same bounds for the preference and the brush panel's
 * slider. */
export function clampOverlayStrength(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : DEFAULT_PREFS.maskOverlayOpacity / 100;
}

export function maskOverlayRgb(color: Prefs["maskOverlayColor"] | undefined): string {
  return MASK_OVERLAY_COLORS.find((item) => item.id === color)?.rgb ?? MASK_OVERLAY_COLORS[0].rgb;
}

function finitePreference(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** The depth model's working sizes: its own 518, and two steps up
 * that buy edge detail at attention's quadratic price. */
export const DEPTH_SIZES = [518, 700, 1036] as const;

/** A working size, snapped to the nearest of the three. */
export function snapDepthSize(value: unknown): number {
  const v = finitePreference(value, 518);
  return DEPTH_SIZES.reduce((best, s) => (Math.abs(s - v) < Math.abs(best - v) ? s : best), 518 as number);
}

/** A Depth Map default: a whole percent, 0 to 100. */
/** The outline thickness in pixels, 1 to 8, whole; anything else is
 * the shipped 2. Zero is not a preference but the node's way of
 * saying "the preference", so it is refused here too. */
export const SHAPE_LINE_WIDTH_RANGE: readonly [number, number] = [1, 8];

/** A stored thickness read back under today's meaning.
 *
 * The setting was a PERCENTAGE first, 50 to 800 with 200 shipped, and
 * became pixels, 1 to 8 with 2 shipped, the same day. The two scales
 * cannot overlap: the smallest percentage is 50 and the largest pixel
 * count is 8, so anything above the pixel range is a percentage from
 * before the change and converts by the hundred it was written in.
 * Without this every saved value clamps to 8, the thickest line the
 * app can draw, on every photograph ("way too thick").
 *
 * Only for values coming off disk. A live write of 9999 is somebody
 * asking for the maximum and still clamps to 8.
 */
export function migrateShapeLineWidth(value: unknown): number {
  const v = typeof value === "number" && Number.isFinite(value) ? value : NaN;
  if (Number.isFinite(v) && v > SHAPE_LINE_WIDTH_RANGE[1]) return clampShapeLineWidth(v / 100);
  return clampShapeLineWidth(value);
}

export function clampShapeLineWidth(value: unknown): number {
  const v = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : NaN;
  if (!Number.isFinite(v)) return DEFAULT_PREFS.shapeLineWidth;
  return Math.min(SHAPE_LINE_WIDTH_RANGE[1], Math.max(SHAPE_LINE_WIDTH_RANGE[0], v));
}

export function clampDepthSetting(value: unknown, fallback: number): number {
  return Math.min(100, Math.max(0, Math.round(finitePreference(value, fallback))));
}

export function clampViewerZoomRate(value: number | undefined): number {
  return Math.min(0.004, Math.max(0.0005, finitePreference(value, DEFAULT_PREFS.viewerZoomRate)));
}

export function clampViewerRotationStep(value: number | undefined): number {
  return Math.min(15, Math.max(1, Math.round(finitePreference(value, DEFAULT_PREFS.viewerRotationStep))));
}

export function clampPreviewEdge(value: number | undefined): number {
  return Math.min(4096, Math.max(1024, Math.round(finitePreference(value, DEFAULT_PREFS.previewEdge))));
}

/** The settled preview's long side: the preference as a floor, raised
 * to what the screen shows. The stage's device pixels round up to the
 * next 256 so a window nudged a few pixels asks for no new tier, and
 * the ceiling is the preference's own 4096. */
/** The settle's JPEG quality behind each step of the preference. The
 * settle review (2026-09-23) measured 85 against 94 on a 24 megapixel
 * frame: 42% fewer bytes and 17% less encode time for a mean error of
 * 0.85 levels against 0.49 at a 2048 pixel Fit; 75 is the step for a
 * slow machine, 94 the reduced frames' own quality for a large stage
 * where the settle is shown near its own pixels. */
export const SETTLE_JPEG_QUALITY: Record<Prefs["settleQuality"], number> = { smaller: 75, balanced: 85, sharper: 94 };

export function settleJpegQuality(prefs: { settleQuality?: Prefs["settleQuality"] }): number {
  return SETTLE_JPEG_QUALITY[prefs.settleQuality ?? "balanced"] ?? 85;
}

export function previewEdgeFor(s: { prefs: { previewEdge?: number }; view: { stagePx: { w: number; h: number } | null } }): number {
  const pref = clampPreviewEdge(s.prefs.previewEdge);
  const stage = s.view.stagePx;
  if (!stage) return pref;
  const shown = Math.ceil(Math.max(stage.w, stage.h) / 256) * 256;
  return Math.min(4096, Math.max(pref, shown));
}

export function clampGesturePreviewEdge(value: number | undefined, previewEdge?: number): number {
  return Math.min(
    clampPreviewEdge(previewEdge),
    Math.min(2048, Math.max(512, Math.round(finitePreference(value, DEFAULT_PREFS.gesturePreviewEdge)))),
  );
}

export function ribbonBounds(prefs: Partial<Prefs>): [number, number] {
  const lo = Math.min(260, Math.max(100, Math.round(finitePreference(prefs.ribbonMinWidth, DEFAULT_PREFS.ribbonMinWidth))));
  const hi = Math.min(640, Math.max(lo, Math.round(finitePreference(prefs.ribbonMaxWidth, DEFAULT_PREFS.ribbonMaxWidth))));
  return [lo, hi];
}

export function clampThumbnailEdge(value: number | undefined): number {
  return Math.min(1200, Math.max(240, Math.round(finitePreference(value, DEFAULT_PREFS.thumbnailEdge))));
}

export function clampAutosaveDelay(value: number | undefined): number {
  return Math.min(3000, Math.max(100, Math.round(finitePreference(value, DEFAULT_PREFS.autosaveDelayMs))));
}

export function clampTetherPoll(value: number | undefined): number {
  return Math.min(10000, Math.max(500, Math.round(finitePreference(value, DEFAULT_PREFS.tetherPollMs))));
}

/** How much of the color wheel a new bend reaches across.
 *
 * A third of the radius. It used to be the whole of it, which drew the
 * reach ring exactly on top of the wheel's own edge: two circles in the
 * same place, one of them a control. "having the default
 * size of the ring the size of the color circle is confusing." A third
 * also starts the tool somewhere useful, since a bend that reaches
 * everything is a global hue shift rather than a bend.
 *
 * Declared up here because every table that builds a Bend node has to
 * read it. "when I RESET BLEND the falloff goes to 0.33...
 * but when I first see Blend the falloff is 1.0. That inconsistency is
 * annoying." It was: Reset read this and the three places that CREATE
 * the node still had the old number written into them by hand.
 */
export const BEND_FALLOFF_DEFAULT = 1 / 3;

/** Keeps a grain step usable.
 *
 * Zero would make the key do nothing at all, and a step past a quarter
 * turn is a different pattern rather than an adjustment to this one.
 */
export function clampGrainStep(deg: number): number {
  return Math.min(90, Math.max(1, Math.round(deg)));
}

/** The backup cadences the preferences offer. */
export const BACKUP_CADENCES: { days: number; label: string; hint: string }[] = [
  { days: 0, label: "Never", hint: "Stops automatic catalog backups" },
  { days: 1, label: "Daily", hint: "Backs up the catalog at the first launch at least 24 hours after the last automatic backup" },
  { days: 7, label: "Weekly", hint: "Backs up the catalog once a week, at the first launch after seven days" },
  // (2026-09-09): "Add more options for every two weeks (bi-weekly) and
  // monthly." A month is thirty days here: the schedule counts days since
  // the last backup, and a calendar month would make the gap depend on
  // which month it was.
  { days: 14, label: "Every two weeks", hint: "Backs up the catalog every fourteen days, at the first launch after" },
  { days: 30, label: "Monthly", hint: "Backs up the catalog every thirty days, at the first launch after" },
];

/** How near 1 a freehand zoom has to land before it becomes exactly 1.
 * Two percent: wide enough that a wheel tick cannot step over it,
 * narrow enough that nobody aiming elsewhere is dragged onto it. */
export const ZOOM_SNAP = 0.02;

/** The rungs the keyboard zoom walks. Conventional stops, and 1 is on
 * the ladder so keyboard zoom always passes through pixel-for-pixel
 * rather than near it. */
export const ZOOM_LADDER = [
  0.1, 0.125, 0.25, 0.33, 0.5, 0.67, 1, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32,
];

export type Mode = "simple" | "advanced" | "canvas";

/** Startup, in the order it actually happens. The splash reports real
 * progress rather than a timed animation, so every step here is a thing
 * the app genuinely finished doing. */
export const BOOT_STEPS = [
  "catalog",
  "folders",
  "photos",
  "image",
  "render",
  "ready",
] as const;
export type BootStep = (typeof BOOT_STEPS)[number];

export const BOOT_LABEL: Record<BootStep, string> = {
  catalog: "Reading the catalog",
  folders: "Walking the folder tree",
  photos: "Lining up the photos",
  image: "Opening your last photo",
  render: "Developing the preview",
  ready: "Ready",
};

export interface Boot {
  step: BootStep;
  /** The specific bit: a folder path, a photo count, a filename. Empty
   * when there is nothing concrete to say yet. */
  detail: string;
}
export type Category =
  "source" | "color" | "detail" | "masking" | "utility" | "group";

export const CAT_COLOR: Record<Category, string> = {
  source: "#7a7a7a",
  color: "#d98a3d",
  detail: "#3fa39a",
  masking: "#8b6fc4",
  utility: "#5b7fb0",
  group: "#c9a227",
};

export type CurveChannel = "rgb" | "r" | "g" | "b" | "luma";

/** How the Curves editor shows its channels. "cmy" shows the same
 * curves seen as ink: C is the red curve, M the green, Y the blue and
 * CMY the composite, each flipped on both axes, so a point (x, y) on
 * red shows at (1 - x, 1 - y) on C. One stored curve per channel
 * either way; LUM is shown as it is in both.*/
export type CurveMode = "rgb" | "cmy";

/** A copied Curves curve, in the coordinates it was shown in, with
 * the slopes and handles it wore, and the channel's name as the
 * editor showed it ("R", "C") for the Paste button's hint.*/
export type CurveClip = {
  curve: [number, number][];
  tangents?: number[];
  handles?: (CurveHandle | null)[];
  label: string;
};

/** A copied Recolor curve: the points of one ADJUST curve, the BY
 * axis they are placed on, and the output range they were drawn
 * against, so a paste onto another ADJUST keeps the shape the plot
 * showed. `label` names the cell for the Paste button's hint.*/
export type RecolorClip = {
  by: RecolorBy;
  points: EqPoint[];
  range: [number, number];
  label: string;
};

/** One curve point's manual tangent pair: vectors in curve units per
 * side (l points -x, r points +x), and whether the pair is broken so
 * the two move independently. */
export type CurveHandle = {
  l?: [number, number];
  r?: [number, number];
  broken?: boolean;
};

export interface Take {
  id: string;
  name: string;
  /** optional user note, edited in the Takes window (the dropdown is
   * the quick switcher and shows none of it) */
  note?: string;
  /** 1 to 5 stars, the thumbnails' scale, for reviewing takes against
   * each other; absent is unrated */
  rating?: number;
  nodes: NodeCard[];
  wires: Wire[];
}

/** The blur brush's bounds, in one place, because the control, the
 * reducer and whatever remembers it have to agree. */
export function clampBlurStrength(v: number): number {
  return Math.min(0.2, Math.max(0.01, v));
}

export interface StrokeData {
  /** normalized [x,y] points in 0..1 image space */
  points: [number, number][];
  /** radius as a fraction of the shorter image side */
  radius: number;
  erase?: boolean;
  /** Blends what is already under the brush rather than adding to it or
   * taking from it. */
  blend?: boolean;
  /** Softens the picture beneath this layer and lays the result into it,
   * so a blur needs no duplicated layer to have something to work on. */
  blur?: boolean;
  /** How far out of focus, as a fraction of the stroke's radius. Recorded
   * per stroke like the tip, so changing the control later does not
   * rewrite what is already down. */
  blur_strength?: number;
  /** Whether this pass adds to one already laid down, or stops at
   * whichever was strongest. */
  blur_build?: boolean;
  /** Read the layer's own pixels rather than the composite below it.
   * Clone, heal, blur and blend all sample, and all four default to
   * what is underneath; on a layer inside a group there is nothing
   * underneath, so this is the only way to work on the paint itself. */
  sample_layer?: boolean;
  /** edge falloff, 1 hard and 0 entirely soft. Absent means the engine
   * default, which is what strokes painted before this existed used. */
  hardness?: number;
  /** how much of the mask a dab lays down, 1 being full white. The
   * engine calls this flow, and it has always read it; nothing offered a
   * way to set it until now. */
  flow?: number;
  /** the tip it was laid down with. Recorded per stroke rather than per
   * node, so changing brush now paints differently without reaching back
   * and rewriting what is already on the mask. Absent means round, which
   * is what every stroke was before tips existed. */
  brush?: string;
  texture_scale?: number;
  texture_depth?: number;
  texture_angle?: number;
  /** "#rrggbb" laid down by this stroke, on paint layers. Brush masks
   * ignore it. Per stroke, like the tip: changing color later must not
   * repaint history. */
  color?: string;
  /** Retouch layers: where this stroke reads its pixels from, as an
   * offset from where it lands, normalized to the frame. */
  src_dx?: number;
  src_dy?: number;
  /** Whether this stroke heals (texture from the source, tone from the
   * destination) rather than cloning outright. */
  heal?: boolean;
}

/** The choices a node's text parameters offer, by node type.
 *
 * "Vivid Light - This should be a blending mode node where one
 * of the blending modes is Vivid Light", and "Blur - this is too generic, it
 * should have properties like blur type (Gaussian, Box, Motion, etc)."
 *
 * Both are the same observation: some of a node's character is a choice
 * rather than an amount, and a choice belongs on the node as a property. One
 * Blur with three characters beats three nodes to pick between, and a Blend
 * that says which mode it is beats a node type per mode.
 */
/** What a text parameter falls back to when a node does not carry one.
 *
 * Separate from the option list because the order of that list is for
 * reading, not for defaulting: grain's patterns run fine to coarse, which is
 * the order anybody would want to see them in, and the engine's default sits
 * in the middle of it.
 */
/** The negative's format against the print (Enlargement, idea 8): 35mm
 * the reference, a bigger negative enlarged less for the same print. */
export const GRAIN_FORMATS: { id: string; label: string }[] = [
  { id: "35mm", label: "35mm" },
  { id: "645", label: "645" },
  { id: "6x6", label: "6x6" },
  { id: "6x7", label: "6x7" },
  { id: "4x5", label: "4x5" },
];

export const PARAM_TEXT_DEFAULT: Record<string, Record<string, string>> = {
  "heeler.grain": { pattern: "standard", format: "35mm" },
  // The conversion's hue curve and its Wratten filter: empty is the
  // mixer alone.
  "heeler.black_white": { hue_curve: "", filter: "", ir_curve: "", far_filter: "", depth_curve: "", ir_interp: "", depth_interp: "" },
  "heeler.paper": { toner: "" },
  // The Tone Profile's film stock: empty is its own rendering.
  "heeler.tone_profile": { film: "" },
  "heeler.image_source": { highlights: "clip", demosaic: "standard", sharpening: "standard" },
  "heeler.lens_correct": { dist_model: "none" },
  "heeler.grid_warp": { cols_u: "", rows_v: "", mesh: "[]", edges: "clamp" },
  "heeler.shape_warp": { shapes: "[]", edges: "clamp" },
  "heeler.file": { path: "" },
  "heeler.catalog": { image: "", mode: "developed" },
  // A node saved before the choice existed stretched, and still does:
  // the default here and in the engine is the old behavior, and a NEW
  // card carries "fit" explicitly (makeNode), so nothing on disk
  // renders differently for the choice having arrived.
  "heeler.merge": { fit: "stretch" },
  "heeler.blend": { fit: "stretch" },
  "heeler.view_transform": { mode: "sigmoid" },
  "heeler.chromatic_adapt": { illuminant: "custom" },
  // Recolor's text: the curve map, the surfaces, the hue→hue verb and
  // the Mask row's source. Reset empties all four.
  "heeler.recolor": { curves: "", surfaces: "", hue_hue_mode: "", by_mask: "" },
  // The flare's rig is mirrored from Depth Lighting and is not reset
  // with the look; the streak color and the preset stamp are.
  "heeler.flare": { streak_color: "#5aa0ff", streak_stops: "", preset: "" },
  "heeler.halation": { format: "35mm" },
  "heeler.sharpening": { mode: "vivid" },
  // The Sharpening group's Recipe switch (its mirror of the recipe).
  "heeler.group": { mode: "vivid" },
  "heeler.dof": { character: "", character_prior: "" },
  // The logic family and the channel nodes: every list opens on the
  // answer that changes nothing (or reads the way Blend If opens: gray,
  // which here is luma).
  "heeler.measure": { metric: "luma" },
  "heeler.compare": { op: "gt" },
  "heeler.logic": { op: "and" },
  "heeler.math": { op: "add" },
  "heeler.morphology": { mode: "erode", shape: "round", coverage: "soft" },
  "heeler.edge_field": { operator: "sobel" },
  "heeler.alpha_association": { mode: "replace" },
  // The second batch of advanced nodes (ops_advanced.rs). 2026-09-30:
  // "queue those up next as they don't look too extensive."
  "heeler.soft_clip": { by: "max" },
  "heeler.median": { rank: "luminance" },
  "heeler.depth_normals": { reads: "depth" },
  "heeler.color_transform": { from: "linear_rec709", to: "acescg" },
  // The warps' Edges, under the warps' default: Stretch, the node's
  // behavior before the choice, so a saved graph renders unchanged.
  "heeler.displacement_map": { edges: "clamp" },
  "heeler.channel_extract": { channel: "luma" },
  "heeler.channel_gain": { channel: "luma" },
  "heeler.tone_mask": { range: "midtones" },
  "heeler.noise": { pattern: "standard", format: "35mm" },
  "heeler.smart_mask": { mode: "click" },
  "heeler.matte_mask": { layer: "", names: "[]" },
  "heeler.key_light": { normals: "auto" },
  // The chart the panel fits against; the quad, the per-patch overrides
  // and the fit report are JSON the chart tool and panel write.
  "heeler.color_checker": { chart: "colorchecker-classic", quad: "", patches: "", fit: "" },
};

/** A File or Catalog source's space (Finish image layers, 2026-09-30):
 * scene-linear for a Merge in the graph, display for a Finish layer. */
const SOURCE_SPACES = [
  { id: "scene", label: "Scene-linear" },
  { id: "display", label: "Display (Finish layer)" },
];

/** The Color Transform's declared spaces (ops_advanced.rs color_space),
 * the same list for From and To. */
const COLOR_TRANSFORM_SPACES = [
  { id: "linear_rec709", label: "Linear Rec. 709 (Heeler's working space)" },
  { id: "srgb", label: "sRGB" },
  { id: "linear_rec2020", label: "Linear Rec. 2020" },
  { id: "acescg", label: "ACEScg" },
  { id: "acescct", label: "ACEScct" },
  { id: "aces2065_1", label: "ACES2065-1" },
  { id: "linear_p3", label: "Linear Display P3" },
  { id: "display_p3", label: "Display P3" },
];

/** A choice row's hint, outcome first, where the choice's name alone
 * misleads. (2026-10-01) set the Color Transform's From to sRGB and
 * the picture went darker: correct, since the wires carry
 * scene-linear Rec. 709 and calling that sRGB decodes it a second
 * time.*/
export const PARAM_CHOICE_HINTS: Record<string, Record<string, string>> = {
  "heeler.color_transform": {
    from:
      "Leave at Linear Rec. 709, Heeler's working space, unless a Color Transform earlier in the graph converted the picture. sRGB here decodes the picture again and darkens it.",
    to: "The space the picture leaves in. A second Color Transform back to Linear Rec. 709 returns it to Heeler's working space.",
  },
  "heeler.displacement_map": {
    edges:
      "Where the picture moves away from the frame's edge: Stretch carries the edge pixels across the gap, Transparent leaves nothing there for a crop or a layer below to fill.",
  },
};

export const PARAM_OPTIONS: Record<string, Record<string, { id: string; label: string }[]>> = {
  // The warps' names and order (Grid Warp, Shape Warp: EDGES).
  "heeler.displacement_map": {
    edges: [
      { id: "clamp", label: "Stretch" },
      { id: "transparent", label: "Transparent" },
    ],
  },
  "heeler.key_light": {
    normals: [
      { id: "auto", label: "File" },
      { id: "camera", label: "Camera" },
      { id: "off", label: "Off" },
    ],
  },
  "heeler.export_layer": {
    part: [
      { id: "rgb", label: "Color planes (R, G, B)" },
      { id: "alpha", label: "Gray (alpha)" },
    ],
  },
  "heeler.smart_mask": {
    mode: [
      { id: "click", label: "Click to select" },
      { id: "subject", label: "Subject (one shot)" },
      { id: "sky", label: "Sky (one shot)" },
    ],
  },
  "heeler.chromatic_adapt": {
    illuminant: [
      { id: "custom", label: "Custom" },
      { id: "d65", label: "D65" },
      { id: "d50", label: "D50" },
      { id: "a", label: "Tungsten" },
      { id: "f2", label: "Fluor." },
    ],
  },
  "heeler.view_transform": {
    mode: [
      { id: "sigmoid", label: "Sigmoid" },
      { id: "filmic", label: "Filmic" },
      { id: "agx", label: "AgX" },
      { id: "aces", label: "ACES" },
    ],
  },
  "heeler.lens_correct": {
    dist_model: [
      { id: "none", label: "None" },
      { id: "ptlens", label: "PTLens" },
      { id: "poly3", label: "Poly3" },
      { id: "poly5", label: "Poly5" },
    ],
  },
  "heeler.image_source": {
    highlights: [
      { id: "clip", label: "Clip" },
      { id: "blend", label: "Blend" },
      { id: "rebuild", label: "Rebuild" },
    ],
    demosaic: [
      { id: "fast", label: "Fast" },
      { id: "standard", label: "Standard" },
      { id: "fine", label: "Fine" },
    ],
    sharpening: [
      { id: "off", label: "Off" },
      { id: "low", label: "Low" },
      { id: "standard", label: "Standard" },
      { id: "high", label: "High" },
    ],
  },
  "heeler.nlm_denoise": {
    mode: [
      { id: "knn", label: "KNN (fast)" },
      { id: "nlm", label: "NLM (thorough)" },
    ],
  },
  "heeler.catalog": {
    mode: [
      { id: "developed", label: "As developed" },
      { id: "shot", label: "As shot" },
    ],
    space: SOURCE_SPACES,
  },
  "heeler.file": {
    space: SOURCE_SPACES,
  },
  "heeler.merge": {
    fit: [
      { id: "fit", label: "Fit" },
      { id: "fill", label: "Fill" },
      { id: "stretch", label: "Stretch" },
      { id: "none", label: "None" },
    ],
  },
  "heeler.blend": {
    fit: [
      { id: "fit", label: "Fit" },
      { id: "fill", label: "Fill" },
      { id: "stretch", label: "Stretch" },
      { id: "none", label: "None" },
      // A Finish image layer's picture on its transform's corners.
      { id: "place", label: "Placed" },
    ],
    mode: [
      { id: "normal", label: "Normal" },
      { id: "multiply", label: "Multiply" },
      { id: "screen", label: "Screen" },
      { id: "add", label: "Add" },
      { id: "overlay", label: "Overlay" },
      { id: "soft_light", label: "Soft Light" },
      { id: "hard_light", label: "Hard Light" },
      { id: "vivid_light", label: "Vivid Light" },
      { id: "linear_light", label: "Linear Light" },
    ],
  },
  "heeler.blur": {
    kind: [
      { id: "gaussian", label: "Gaussian" },
      { id: "box", label: "Box" },
      { id: "motion", label: "Motion" },
    ],
  },
  // The section's Recipe toggle wears Vivid and Hi Pass; the node
  // carries the same two names, or the inspector reads like a
  // different tool.
  "heeler.sharpening": {
    mode: [
      { id: "vivid", label: "Vivid" },
      { id: "hipass", label: "Hi Pass" },
    ],
  },
  "heeler.luma_chroma_split": {
    part: [
      { id: "luma", label: "Luminance" },
      { id: "color", label: "Color" },
    ],
  },
  "heeler.grain": {
    pattern: [
      { id: "fine", label: "Fine" },
      { id: "standard", label: "Standard" },
      { id: "coarse", label: "Coarse" },
      { id: "cinema", label: "Cinema" },
    ],
    format: GRAIN_FORMATS,
  },
  "heeler.noise": {
    pattern: [
      { id: "fine", label: "Fine" },
      { id: "standard", label: "Standard" },
      { id: "coarse", label: "Coarse" },
      { id: "cinema", label: "Cinema" },
    ],
    format: GRAIN_FORMATS,
  },
  // The two channel nodes answer the same question in different
  // spellings, because the engine does: extract wants r/g/b, gain wants
  // the words. Offering "red" to extract would silently render luma:
  // the engine falls back on any spelling it does not know.
  "heeler.channel_extract": {
    channel: [
      { id: "luma", label: "Luma" },
      { id: "r", label: "Red" },
      { id: "g", label: "Green" },
      { id: "b", label: "Blue" },
    ],
  },
  "heeler.channel_gain": {
    channel: [
      { id: "luma", label: "Luma" },
      { id: "red", label: "Red" },
      { id: "green", label: "Green" },
      { id: "blue", label: "Blue" },
    ],
  },
  "heeler.tone_mask": {
    range: [
      { id: "shadows", label: "Shadows" },
      { id: "midtones", label: "Midtones" },
      { id: "highlights", label: "Highlights" },
      { id: "bell", label: "Bell" },
    ],
  },
  // The logic family. Measure's metric is Blend If's channel dropdown
  // with the three Blend If never had (hue, chroma, saturation) added.
  "heeler.measure": {
    metric: [
      { id: "luma", label: "Luma" },
      { id: "red", label: "Red" },
      { id: "green", label: "Green" },
      { id: "blue", label: "Blue" },
      { id: "hue", label: "Hue" },
      { id: "chroma", label: "Chroma" },
      { id: "saturation", label: "Saturation" },
      { id: "alpha", label: "Alpha" },
    ],
  },
  "heeler.compare": {
    op: [
      { id: "gt", label: ">" },
      { id: "ge", label: "≥" },
      { id: "lt", label: "<" },
      { id: "le", label: "≤" },
      { id: "eq", label: "=" },
      { id: "neq", label: "≠" },
    ],
  },
  "heeler.logic": {
    op: [
      { id: "and", label: "And" },
      { id: "or", label: "Or" },
      { id: "xor", label: "Xor" },
      { id: "subtract", label: "Subtract" },
    ],
  },
  // The advanced field nodes (ops_field.rs): graph-only, no Develop
  // seat, so the generic inspector rows are their whole face.
  "heeler.morphology": {
    mode: [
      { id: "erode", label: "Erode" },
      { id: "dilate", label: "Dilate" },
      { id: "open", label: "Open" },
      { id: "close", label: "Close" },
    ],
    shape: [
      { id: "round", label: "Round" },
      { id: "square", label: "Square" },
    ],
    coverage: [
      { id: "soft", label: "Soft (grayscale)" },
      { id: "hard", label: "Hard (threshold at half)" },
    ],
  },
  "heeler.alpha_association": {
    mode: [
      { id: "replace", label: "Replace alpha" },
      { id: "extract", label: "Extract alpha" },
      { id: "premultiply", label: "Premultiply" },
      { id: "unpremultiply", label: "Unpremultiply" },
    ],
  },
  // The second batch of advanced nodes (ops_advanced.rs), graph-only.
  "heeler.soft_clip": {
    by: [
      { id: "max", label: "Brightest channel (hue kept)" },
      { id: "channel", label: "Each channel" },
    ],
  },
  "heeler.median": {
    rank: [
      { id: "luminance", label: "By luminance (one pixel's color)" },
      { id: "channel", label: "Each channel" },
    ],
  },
  "heeler.depth_normals": {
    reads: [
      { id: "depth", label: "Depth (near stands up)" },
      { id: "height", label: "Height (white stands up)" },
    ],
  },
  "heeler.color_transform": {
    from: COLOR_TRANSFORM_SPACES,
    to: COLOR_TRANSFORM_SPACES,
  },
  "heeler.edge_field": {
    operator: [
      { id: "sobel", label: "Sobel" },
      { id: "scharr", label: "Scharr" },
      { id: "laplacian", label: "Laplacian" },
    ],
  },
  "heeler.math": {
    op: [
      { id: "add", label: "Add" },
      { id: "subtract", label: "Subtract" },
      { id: "multiply", label: "Multiply" },
      { id: "divide", label: "Divide" },
      { id: "min", label: "Min" },
      { id: "max", label: "Max" },
      { id: "difference", label: "Difference" },
      { id: "power", label: "Power" },
    ],
  },
};

/** Takes a node out of the image chain and closes the gap behind it.
 *
 * The feed is read before anything is removed. Pull the wires first and the
 * node downstream is left with nothing coming into it and no way to find out
 * what used to be there.
 */
function wireSource(wire: Pick<Wire, "from" | "fromPort">): Pick<Wire, "from" | "fromPort"> {
  return { from: wire.from, fromPort: wire.fromPort };
}

/** The picture pipe a node sits on: the one into its "in", or failing
 * that its first other non-field input (a group's boundary entry).
 * Never a second or third picture (in2, in3): a Merge whose second
 * picture is wired and whose first is not sits on no chain. */
export function chainFeed(wires: Wire[], id: string): Wire | undefined {
  return (
    wires.find((w) => w.to === id && w.kind !== "mask" && w.toPort === "in") ??
    wires.find((w) => w.to === id && w.kind !== "mask" && w.toPort !== "in2" && w.toPort !== "in3")
  );
}

export function spliceOut(wires: Wire[], id: string): Wire[] {
  const feed = chainFeed(wires, id);
  return wires
    .filter((w) => w.to !== id && w.from !== id)
    .concat(
      feed
        ? wires
            .filter((w) => w.from === id && w.kind !== "mask")
            .map((w) => ({ ...w, ...wireSource(feed), kind: feed.kind }))
        : [],
    );
}

/** Puts a node back into the image chain, in front of the first node
 * downstream of it that the graph still has.
 *
 * "The first one still there" rather than "the one that used to follow it",
 * because several categories can be off at once and the node that used to
 * follow may be off too. Walking forward until something answers puts each
 * one back in the order the chain runs, however many of its neighbors are
 * missing.
 */
/** Formats that arrive already rendered: a camera or an app has run its own
 * scene-to-display transform and baked it in. ICC finding: running Heeler's
 * default tone profile on top of that is rendering the picture twice, so a
 * fresh graph for one of these starts with the profile bypassed. RAW formats
 * are scene-referred and keep it. TIFF sits with the rendered camp:
 * overwhelmingly it is an export, not a scene-linear master. OpenEXR sits here
 * too, for the other reason: it is scene-linear, but the profile's baseline is
 * a camera's lift and its curve a camera JPEG's, and a render or a comp is
 * already in the units its maker looked at through a plain display transform.
 * With the profile on, every EXR opened over a stop bright (2026-09-20: "why
 * are EXR files over exposed?"); off, it opens the way a compositor's or 3D
 * renderer's Standard view shows it, and the profile is one click away.*/
export const isRenderedSource = (name: string): boolean =>
  /\.(jpe?g|png|heic|heif|webp|tiff?|exr)$/i.test(name);

/** Whether the active photograph is an OpenEXR, the one format whose
 * files can name objects. */
export function activeIsExr(s: State): boolean {
  const image = s.images.find((i) => i.id === s.activeImage);
  return !!image && /\.exr$/i.test(image.name);
}

/** The conversion Develop's treatment block and the viewer's pickers
 * address: the main chain's, never a layer's own (review 2026-09-15,
 * item 1: the pickers took whichever conversion came first). */
/** The conversion's infrared and depth curves with a face of their own:
 * whichever is missing takes the node's shared face as it stands (or
 * smooth, the curves' rest), so a change to the shared face from here
 * on moves only the hue curve. Returns the same object when nothing
 * was missing. */
export function withOwnFaces(n: NodeCard): NodeCard["textParams"] {
  const shared = n.curveInterp ?? "smooth";
  const have = n.textParams ?? {};
  if (have.ir_interp && have.depth_interp) return n.textParams;
  return { ...have, ir_interp: have.ir_interp || shared, depth_interp: have.depth_interp || shared };
}

export function mainConversion(nodes: { id: string; type: string }[]): NodeCard | undefined {
  const all = nodes as NodeCard[];
  return (
    all.find((n) => n.type === "heeler.black_white" && !isLayerNode(n.id)) ??
    all.find((n) => n.type === "heeler.black_white")
  );
}

/** Whether the active photograph is a rendered source, a JPEG or a
 * bake: its Tone Profile ships bypassed on purpose, and a Film chosen
 * under the treatment wakes it in the sent graph. On a RAW a bypassed
 * profile is the user's own doing and stays bypassed (review
 * 2026-09-15, item 2). */
export function renderedSource(s: State): boolean {
  const image = s.images.find((i) => i.id === s.activeImage);
  return !!image && (bornRendered(image) || isRenderedSource(image.name));
}

/** Whether a DNG arrives already rendered, whatever its name says: a
 * bake carries Heeler's own look in its pixels, and a phone's DNG (an
 * iPhone ProRAW) is rendered at decode by the gain table map, baseline
 * exposure and tone curve its file carries, which is the picture its
 * thumbnail shows. Either opens with the Tone Profile bypassed; with
 * the profile's lift on top the phone's picture came out over a stop
 * bright (2026-10-02: "match the thumbnail"). So does a stack or
 * panorama of finished pictures (renderedFrames): a JPEG's merge keeps
 * the camera's contrast and color, and the profile on top doubled them
 * (2026-10-08: a baked JPEG star stack "came in over saturated"). */
export function bornRendered(image: { renderedBake?: boolean; phoneRendered?: boolean; renderedFrames?: boolean } | undefined | null): boolean {
  return !!image && (!!image.renderedBake || !!image.phoneRendered || !!image.renderedFrames);
}

/** Whether a photograph of this name develops from sensor data, the
 * only kind the Source section's Sharpening acts on: not a rendered
 * file, not a bake, not a merge (a linear DNG made by Heeler). An
 * unnamed image is not assumed to be RAW. */
export function sharpensAtBirth(name: string, rendered = false): boolean {
  return !!name && !rendered && !isRenderedSource(name) && !isComposite({ name });
}

/** A fresh graph for an image never edited: the default template, with
 * the tone profile bypassed when the source is already rendered, and
 * born in the user's chosen mode when it is RAW ("Maybe
 * people loading RAW files don't want a profile added" - the
 * rawProfile preference, Linear being that neutral start). A merge is
 * born with its highlight shoulder (MERGED_ROLLOFF), the graph the
 * viewer opens it with: every other reader of the fresh graph (the
 * thumbnail, the export, the before pane, a reset) left it off and
 * rendered the recovered sky flat,. */
function freshNodes(s: State, name: string, rendered = false): NodeCard[] {
  const nodes = structuredClone(s.defaultGraph.nodes);
  for (const n of nodes) {
    // The capture sharpening preference, written on a RAW's source
    // node at birth (see UiSettings.rawSharpening).
    if (n.type === "heeler.image_source" && sharpensAtBirth(name, rendered)) {
      n.textParams = { ...n.textParams, sharpening: s.rawSharpening };
    }
    if (n.type !== "heeler.tone_profile") continue;
    if (rendered || isRenderedSource(name)) {
      n.enabled = false;
    } else if (s.rawProfile !== "standard") {
      n.textParams = { ...n.textParams, mode: s.rawProfile };
      n.badge = s.rawProfile;
    }
    const rolloff = Number(n.params.highlight_rolloff ?? 0);
    if (isComposite({ name }) && (rolloff === 0 || rolloff === PROFILE_DEFAULTS.highlight_rolloff)) {
      n.params = { ...n.params, highlight_rolloff: MERGED_ROLLOFF };
    }
  }
  return nodes;
}

/** The graph a photograph with no embedded preview (a merge) renders
 * its thumbnail through, in the engine's wire shape: the one the viewer
 * opens it with. Null for a file that carries its own preview, and for
 * an edited merge, whose saved graph the desktop reads itself. `name`
 * covers a merge made a moment ago that the image list has not caught
 * up with yet. */
export function thumbnailGraphFor(s: State, imageId: string, name?: string, source?: ImageEntry): { nodes: NodeCard[]; wires: Wire[] } | null {
  const image = s.images.find((i) => i.id === imageId) ?? source;
  const imageName = image?.name ?? name ?? "";
  if (!isComposite({ name: imageName }) || image?.edited) return null;
  return { nodes: freshNodes(s, imageName, bornRendered(image)), wires: structuredClone(s.defaultGraph.wires) };
}

export function freshNodesFor(s: State, imageId: string): NodeCard[] {
  const image = s.images.find((i) => i.id === imageId);
  return freshNodes(s, image?.name ?? "", bornRendered(image));
}

/** The graph a never-opened photo would open with: the neutral default
 * shaped for this image, exactly the snapshot the image-switch reducer
 * builds for a first visit. Export falls back to it when nothing was
 * ever saved for the photo. */
export function freshGraphFor(s: State, imageId: string): { nodes: NodeCard[]; wires: Wire[] } {
  return { nodes: freshNodesFor(s, imageId), wires: structuredClone(s.defaultGraph.wires) };
}

/** Whether a node of this id is in the graph, inside a group included:
 * the engine renders the flattened graph, where a member keeps its id,
 * so a probe on a node inside the opened Finish group (a Morphology on
 * a layer's mask wire) shows that node's output. */
export function graphHasNode(nodes: NodeCard[], id: string): boolean {
  return nodes.some((k) => k.id === id || (!!k.groupNodes && graphHasNode(k.groupNodes, id)));
}

/** The mask node the viewer should show as a black/white overlay, or
 * null for the developed photograph. One derivation for the preview
 * render, the ROI patch, and the viewer's flavor matching, extended
 * for Color Sets: the per-set eye toggle holds a set's selection on.
 * ONLY the eye: the armed dropper forced the overlay on by itself
 * for a while, until the owner overruled it: "It should not default
 * to mask on, only when the mask button is toggled on while using
 * the picker."*/
export function maskPreviewNode(s: State): string | null {
  // A stage probe outranks the mask views: the user asked to see the
  // graph at this exact point, and the render path is the same
  // arbitrary-terminal redirect the mask views ride.
  if (s.probeNode !== null && graphHasNode(s.nodes, s.probeNode)) {
    return s.probeNode;
  }
  const n = s.csetMaskView;
  if (n !== null && s.nodes.some((k) => k.id === `cset${n}_mask`)) {
    return `cset${n}_mask`;
  }
  // The mask brush's own target outranks the layer conventions while
  // the brush is up: the eye sits beside the brush, and it must show
  // the mask THAT brush writes to - the owner pressed it mid-painting
  // and no mask render ever fired, because the resolvers below only
  // know layer contexts.
  if (s.maskView && s.tool === "brush") {
    const target = maskBrushTarget(s);
    if (target) return target.id;
  }
  // A Finish layer's mask previews the same way a develop layer's
  // does. The owner, testing the smart sky: "Also missing a way for
  // me to preview the mask with an overlay or alpha mask" - the
  // develop panel had the eye, the Layers panel had nothing to point
  // it at.
  if (s.maskView && s.panelTab === "layers" && s.artActive) {
    const artMask = `art_m_${s.artActive}`;
    if (artMaskNode(s, artMask)) return artMask;
  }
  return s.maskView ? activeLayerMask(s) : null;
}

/** When the mask view is on but another view is what the frame shows
 * (with Show mask and View depth both on, the depth map took the frame
 * and nothing said so), the name of that view as the panel calls it;
 * null when the mask is what shows, or no mask view is on.*/
export function maskViewOverriddenBy(s: State): string | null {
  const mask = maskPreviewNode(s);
  if (!mask) return null;
  const shown = previewTarget(s);
  if (shown === mask || shown === null) return null;
  if (shown === "__depth__") return "View depth";
  if (shown === "__halation__") return "the halation view";
  if (shown.startsWith("__collision__")) return "the separation view";
  if (shown.startsWith("__zones__")) return "the zone view";
  return null;
}

/** The node the preview renders AS the frame: the depth view outranks every
 * mask target (the farness plane as the frame, the owner from a color
 * grader), then the halation view, then the chosen mask. One selector for
 * the fit render and the 1:1 patch, so the two cannot drift apart again.*/
/** The Collisions view's tolerance at rest, in percent of the tonal
 * range either side: one of the engine's thirty-two bins. */
export const COLLISION_TOLERANCE_DEFAULT = 3;
export const COLLISION_TOLERANCE_MAX = 15;
const COLLISION_BIN_PERCENT = 100 / 32;
/** The dial in the engine's bins. */
export function collisionBins(percent: number): number {
  return Math.max(0, Math.round(percent / COLLISION_BIN_PERCENT));
}
/** The tolerance's ride in the target, "~bins", only when it is not
 * the rest, so a target at rest is the plain view. */
function collisionSuffix(s: State): string {
  const bins = collisionBins(s.collisionTolerance ?? COLLISION_TOLERANCE_DEFAULT);
  return bins === 1 ? "" : `~${bins}`;
}

export function previewTarget(s: State): string | null {
  // Separate armed: the collision view is what shows it what to click
  // (2026-09-14: "it's not clear what I can click on"), and after the
  // first click the view narrows to that color and its partners, the
  // click riding in the target. Ahead of the other views because the
  // arm is the user's most recent ask.
  if (s.bwSeparate && treatmentOn(s)) {
    const src = s.bwSeparate.source;
    return (src ? `__collision__@${src.x.toFixed(4)},${src.y.toFixed(4)}` : "__collision__") + collisionSuffix(s);
  }
  // The ruler's hover lights one zone on the frame, over every other
  // view: it is the most recent ask and it ends when the cursor leaves.
  if (s.zoneHover !== null) return `__zones__@${s.zoneHover}`;
  return s.depthView
    ? "__depth__"
    : s.halationView
      ? "__halation__"
      : s.collisionView && treatmentOn(s)
        ? `__collision__${collisionSuffix(s)}`
        : s.zonesView
          ? "__zones__"
          : maskPreviewNode(s);
}

/** Whether the black and white treatment is on: the conversion exists,
 * is not bypassed, and has a strength. The separation view only means
 * something then; with the treatment off its eye is out of sight with
 * the mixer, and the frame renders plainly rather than through a view
 * nobody can put down. */
export function treatmentOn(s: State): boolean {
  const bw = s.nodes.find((n) => n.type === "heeler.black_white");
  return !!bw && bw.enabled && (bw.params.amount ?? 0) > 0;
}

/** Whether a Depth mask block's own mask is what the frame shows. */
export function depthMaskShown(s: State, mask: string): boolean {
  return !s.depthView && previewTarget(s) === mask;
}

const CSET_MASK = /^cset(\d+)_mask$/;

/** The one precedence between a mask eye (a layer's, a Color Set's, a
 * Finish layer's) and the frame views that can cover it (View depth,
 * the halation, separation and zone views). A frame view turned on
 * shows over a mask eye that stays on, and the eye says so
 * (maskViewOverriddenBy); turning that view off brings the mask
 * back. A mask eye turned on is the latest ask and takes the frame:
 * the covering view goes down. A mask eye itself only goes down when
 * the user presses it (or its mask leaves the graph); no other
 * control, the Depth mask switch, its Levels, its depth eye, puts it
 * down.*/
export const MASK_EYE_TAKES_FRAME = { depthView: false, halationView: false, collisionView: false, zonesView: false } as const;

/** The mask view switched on for one mask: a set's by its eye, a
 * layer's (Develop or Finish) by the layer mask view. */
function showMaskView(s: State, mask: string): State {
  const set = CSET_MASK.exec(mask);
  if (set) return { ...s, csetMaskView: Number(set[1]) };
  return { ...s, maskView: true };
}

/** Whether the render should tint the previewed mask red: the
 * app-wide flavor (the owner's design), honored by EVERY mask
 * preview - the layer view, the Color Sets eye - except the probes,
 * which show a node's own output and are not mask views.*/
export function maskOverlayWanted(s: State): boolean {
  if (!s.maskRed) return false;
  // The depth view honors it too (2026-09-29: "this is for any tool
  // that uses depth map and has the depth map preview"): the plane
  // tints the photograph instead of taking the frame.
  if (previewTarget(s) === "__depth__") return true;
  if (s.probeNode !== null && graphHasNode(s.nodes, s.probeNode)) return false;
  return maskPreviewNode(s) !== null;
}

/** How the frame's pixels are dressed beyond WHICH view it is: the mask
 * flavor (red overlay or black and white), the overlay's color and
 * strength while it shows, and the gamut warning. previewTarget says
 * what the frame shows; this says how. A 1:1 slice carries the look it
 * was rendered with and draws only while the view still has that look,
 * and a change of look asks for a new slice. Keyed on the target
 * alone, an Option-click on the mask eye flipped the soft frame to
 * black and white while the sharp red slice stayed on top of it until
 * the next pan or edit (2026-09-29: "the icon updated but the red
 * overlay stayed", then "it took like 20 seconds").*/
export function frameLook(s: State): string {
  const overlay = maskOverlayWanted(s);
  return JSON.stringify([
    overlay,
    overlay ? s.prefs.maskOverlayColor ?? "red" : null,
    overlay ? s.brushOverlayStrength ?? 0.5 : null,
    s.gamutView,
    // A held section look is a different picture of the same target:
    // the 1:1 slice under it must be the look's, and the photograph's
    // own slice must not stay on top of the look (or the look's on top
    // of the photograph once the press ends).
    s.lookPreview ?? null,
  ]);
}

/** What a graph swap out from under the UI must drop: everything that
 * points INTO the graph, since the incoming graph may not hold the
 * node, layer or color set the pointer names. select_image carries the
 * same list for a photo switch, with comments per field. compareTake
 * is deliberately absent: take ids survive a take switch, so the
 * comparison source still names a real take. */
/** Every picker at rest. The list of arms a click can be waiting on,
 * in one place, so Escape and a graph swap put away the same set. */
const PICKER_RESET = {
  curvePick: null,
  curveHoverX: null,
  csetDropper: null,
  csetHoverHue: null,
  toneEqPick: null,
  toneEqHoverX: null,
  wbPick: null,
  recolorPick: null,
  recolorMatch: null,
  recolorHoverX: null,
  bwSeparate: null,
  bwPick: false,
  bwHoverHue: null,
  zonePlace: null,
  consolePick: null,
  consolePickBand: null,
  dofPick: false,
  keyLightPick: false,
  chartPlace: false,
};

/** Whether any picker is waiting on a click. */
export function anyPickerArmed(s: State): boolean {
  return (
    s.curvePick !== null ||
    s.csetDropper !== null ||
    s.toneEqPick !== null ||
    s.wbPick !== null ||
    s.recolorPick !== null ||
    s.recolorMatch !== null ||
    s.bwSeparate !== null ||
    s.bwPick ||
    s.zonePlace !== null ||
    s.consolePick !== null ||
    s.consolePickBand !== null ||
    s.dofPick ||
    s.keyLightPick ||
    s.chartPlace
  );
}

/** The tools' session settings as a photograph opens: the one place a
 * photo switch puts them back ("When I access tools like
 * Crop and Recolor the parameters and settings are retained from the
 * last time I used them (same session). It's off putting. Especially
 * the crop tool when going between images of different orientations").
 * What belongs here is a choice made for the photograph in front of
 * you: the tool in hand with its Escape snapshot (which named the last
 * photograph's crop, so Escape on the next one put the old crop on
 * it), the crop's ratio, the Recolor row and the Color Tune band being
 * worked, the clone source point, the brush's X polarity, the
 * selection operation, the range eyedropper's mode, and an open polish
 * pass. What does not: Preferences, the remembered UI settings
 * (settings.ts: the selection method, the tool pairs' halves, and the
 * rest), and the brush's feel (size, hardness, flow, tip, texture),
 * which describe the hand rather than the picture. initialState starts
 * from the same object, so the two cannot drift.*/
export const TOOL_SESSION_DEFAULTS: Pick<
  State,
  | "tool"
  | "toolRevert"
  | "cropAspect"
  | "recolorCell"
  | "consoleBand"
  | "cloneSource"
  | "cloneOffset"
  | "brushSwap"
  | "selectOp"
  | "pickMode"
  | "pickTarget"
  | "pickNode"
  | "polishOpen"
  | "polishLayer"
  | "curveMode"
  | "warpTarget"
> = {
  tool: "none",
  // A Finish layer's mask being polished belongs to the photograph it
  // was opened on; a switch cancels it first (polishLayerFollow).
  polishLayer: null,
  // The Grid and Shape Warp tools edit the photograph's own warp until
  // a Finish warp arms them (finishwarp.tsx).
  warpTarget: null,
  toolRevert: null,
  cropAspect: null,
  recolorCell: "hue_sat",
  consoleBand: "r",
  cloneSource: null,
  cloneOffset: null,
  brushSwap: false,
  selectOp: "add",
  pickMode: "replace",
  pickTarget: "luma",
  pickNode: null,
  polishOpen: false,
  // The Curves RGB | CMY toggle's override for one photograph: null
  // follows the preference, so the next photograph opens the way
  // Preferences says, whatever the last one was switched to.
  curveMode: null,
};

/** The Curves channel view in force: the photograph's own toggle when
 * it has one, the Preferences default otherwise. */
export function curveModeOf(s: { curveMode?: CurveMode | null; prefs: { curveMode?: CurveMode } }): CurveMode {
  return s.curveMode ?? (s.prefs.curveMode === "cmy" ? "cmy" : "rgb");
}

const GRAPH_POINTERS_RESET = {
  activeLayer: null,
  ...PICKER_RESET,
  csetMaskView: null,
  probeNode: null,
  keyLightSel: null,
  artActive: null,
  artSelected: [],
  artGradientEdit: null,
};

/** The take standing on the before side of every comparison, or null
 * when the before is the untouched original (the default, and the
 * fallback when the pointed-at take no longer exists). */
export function compareTakeOf(s: State): Take | null {
  if (!s.compareTake) return null;
  return (s.takes[s.activeImage] ?? []).find((t) => t.id === s.compareTake) ?? null;
}

/** What the two sides of a comparison are called. Against the
 * original they are BEFORE and AFTER; against a take they are
 * the take's own name and CURRENT ("Take 2 / Current
 * Take").*/
export function compareLabels(s: State): { before: string; after: string } {
  const take = compareTakeOf(s);
  return take
    ? { before: take.name.toUpperCase(), after: "CURRENT" }
    : { before: "BEFORE", after: "AFTER" };
}

/** The node types that move pixels across the frame (lib.rs
 * is_frame_geometry): what a mask reads after, what a planted raster
 * is bent by, and where the sharp slice is cut. */
export const FRAME_GEOMETRY_TYPES = new Set([
  "heeler.crop_rotate",
  "heeler.lens_correct",
  "heeler.grid_warp",
  "heeler.shape_warp",
]);

/** The geometry on the picture's own chain, in the order the pixels
 * meet it: walked back from the output along the base-image wires, the
 * walk the desktop's upstream_crops makes for the render. */
export function frameGeometry(nodes: NodeCard[], wires: Wire[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let cur = nodes.find((n) => n.type === "heeler.output")?.id;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const at = cur;
    cur = wires.find((w) => w.to === at && w.toPort === "in" && w.kind !== "mask")?.from;
    if (cur && FRAME_GEOMETRY_TYPES.has(nodes.find((n) => n.id === cur)?.type ?? "")) out.unshift(cur);
  }
  return out;
}

/** The node a mask reads the photograph from: the last geometry on the
 * picture's chain (the crop, the lens correction, the Grid Warp, the
 * Shape Warp), which is the frame the viewer shows and every layer
 * edits; a crop off the chain when there is nothing on it; else the
 * image source. */
export function frameFeed(nodes: NodeCard[], wires: Wire[]): string | undefined {
  return (
    frameGeometry(nodes, wires).pop() ??
    nodes.find((n) => n.type === "heeler.crop_rotate")?.id ??
    nodes.find((n) => n.type === "heeler.image_source")?.id
  );
}

/** Mask wires read the frame the mask gates (2026-09-30).
 *
 * A mask is measured on the frame it gates, and behind a crop that frame
 * is the crop's. A mask reading the image source ahead of the crop came
 * out the photograph's size, the gate behind the crop is the crop's
 * size, and the engine dropped it: a Finish layer's mask (fed from the
 * source since Finish masks began) and a Develop layer made before the
 * first crop both covered the whole frame once the photograph was
 * cropped. So a new mask is fed from the crop (frameFeed), and when the
 * first crop is built every mask node reading the image source moves to
 * it in the same step, unless something it gates sits ahead of the
 * crop. The desktop reads every graph by the same rule on the way in
 * (lib.rs masks_read_the_frame), which is what renders graphs saved
 * before this, Paste Edits and presets onto a cropped photograph, and
 * masks wired by hand in the graph editor.
 *
 * The mask's strokes and regions are fractions of the frame, so a mask
 * drawn before a crop is read on the cropped frame after it, the way a
 * Develop mask and a Pixel layer's strokes already are. Masks
 * computed from the picture (smart, object, range, depth) follow the
 * content. Returns the same array when nothing moves.*/
export function masksReadTheFrame(nodes: NodeCard[], wires: Wire[]): Wire[] {
  let chain = frameGeometry(nodes, wires);
  // A crop off the picture's chain (a hand-wired graph) still frames
  // the masks, as it did before the rest of the geometry joined it.
  if (chain.length === 0) {
    const crop = nodes.find((n) => n.type === "heeler.crop_rotate");
    if (!crop) return wires;
    chain = [crop.id];
  }
  const sources = new Set(nodes.filter((n) => n.type === "heeler.image_source").map((n) => n.id));
  const isMask = (id: string) => !!nodes.find((n) => n.id === id)?.type.endsWith("_mask");
  // Where a wire reads on the chain: the source ahead of it all (0), a
  // geometry node at its seat (1 on), anything else nowhere.
  const seat = (id: string) => (sources.has(id) ? 0 : chain.indexOf(id) + 1 || -1);
  const moving = wires.filter(
    (w) => w.toPort === "in" && !chain.includes(w.to) && isMask(w.to) && seat(w.from) >= 0 && seat(w.from) < chain.length,
  );
  if (moving.length === 0) return wires;
  const picture = (w: Wire) => w.kind !== "mask" && w.toPort !== "mask" && w.toPort !== "clip";
  // Everything behind a geometry node along the picture's own wires; a
  // group (the Finish stack) stands as one node, as its boundary wires
  // do.
  const behindOf = (from: string) => {
    const behind = new Set<string>();
    const queue = [from];
    while (queue.length) {
      const at = queue.pop()!;
      for (const w of wires) {
        if (w.from === at && picture(w) && !behind.has(w.to)) {
          behind.add(w.to);
          queue.push(w.to);
        }
      }
    }
    return behind;
  };
  const behinds = chain.map(behindOf);
  // Whether a mask gates nothing ahead of `behind`'s geometry, following
  // masks chained through mask nodes (Invert Mask) to their gates. A
  // node with no picture of its own (an Export Layer tapping the mask)
  // has no frame to disagree with, and a mask gating nothing at all
  // reads the frame the user sees.
  const gatesBehind = (id: string, behind: Set<string>, seen: Set<string>): boolean => {
    if (seen.has(id)) return true;
    seen.add(id);
    return wires
      .filter((w) => w.from === id)
      .every((w) => {
        if (isMask(w.to)) return gatesBehind(w.to, behind, seen);
        if (picture(w)) return false;
        const framed = wires.some((x) => x.to === w.to && picture(x));
        return !framed || behind.has(w.to);
      });
  };
  // Each wire to the LAST geometry every gate sits behind, never back
  // up the chain (lib.rs masks_read_the_frame).
  const move = new Map<Wire, string>();
  for (const w of moving) {
    for (let j = chain.length - 1; j >= seat(w.from); j--) {
      if (gatesBehind(w.to, behinds[j], new Set())) {
        move.set(w, chain[j]);
        break;
      }
    }
  }
  if (move.size === 0) return wires;
  return wires.map((w) => {
    const to = move.get(w);
    if (!to) return w;
    const { fromPort: _port, ...rest } = w;
    return { ...rest, from: to };
  });
}

export function spliceIn(wires: Wire[], id: string, order = CHAIN_ORDER): Wire[] {
  if (wires.some((w) => w.from === id || w.to === id)) return wires;
  const at = order.indexOf(id);
  if (at < 0) return wires;
  const have = new Set(wires.flatMap((w) => [w.from, w.to]));
  // The anchor is the first node downstream of the seat that actually
  // has a picture feed to take over: one wired into the graph but
  // hanging loose (a Depth Map left feedless by a load that dropped its
  // neighbor) is no anchor, and the seat falls through to the next.
  const next = order
    .slice(at + 1)
    .find((c) => have.has(c) && wires.some((w) => w.to === c && w.kind !== "mask"));
  const feed = next && wires.find((w) => w.to === next && w.kind !== "mask");
  if (!next || !feed) return wires;
  return [
    ...wires.filter((w) => w !== feed),
    { ...feed, to: id, toPort: "in" as const },
    { from: id, to: next, toPort: feed.toPort, kind: feed.kind },
  ];
}

/** Expands every group into the nodes inside it.
 *
 * "instead of re-wiring in a bunch of individual nodes when a
 * category is enabled, you introduce a preset of nodes in a group. That way
 * the input and output connect on the chain only had to wire in the group."
 *
 * That is how it looks from the graph. The engine has no idea groups exist,
 * and does not need one: a group is expanded on the way out, so what runs is
 * the nodes and the wires that were always inside it. The alternative,
 * teaching the executor about nesting, buys nothing a flattened graph does
 * not already give.
 *
 * The boundary is the only interesting part. Whatever fed the group now feeds
 * its entry, the child nothing inside feeds; whatever the group fed is now
 * fed by its exit, the child that feeds nothing inside.
 */
export function flattenGroups(
  nodes: NodeCard[],
  wires: Wire[],
): { nodes: NodeCard[]; wires: Wire[] } {
  // A group's members can themselves be groups (an art-stack group
  // inside the Layers group), and one pass leaves the inner ones
  // standing. Flatten until nothing flattenable remains; the depth cap
  // is a guard rail, not a target.
  let out = flattenOnce(nodes, wires);
  for (let depth = 0; depth < 8; depth++) {
    if (!out.nodes.some((n) => n.isGroup && n.groupNodes?.length)) break;
    out = flattenOnce(out.nodes, out.wires);
  }
  return out;
}

/** The wires with exact repeats (same ends, ports and kind) dropped,
 * first kept: two pipes into a group that resolve to one seat inside
 * are one wire to the engine, which refuses a second into a port. */
function dedupeWires(wires: Wire[]): Wire[] {
  const seen = new Set<string>();
  return wires.filter((w) => {
    const key = `${w.from}|${w.fromPort ?? ""}|${w.to}|${w.toPort}|${w.kind}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function flattenOnce(
  nodes: NodeCard[],
  wires: Wire[],
): { nodes: NodeCard[]; wires: Wire[] } {
  const groups = nodes.filter((n) => n.isGroup && n.groupNodes?.length);
  if (!groups.length) return { nodes, wires };

  let outNodes = nodes.filter((n) => !n.isGroup || !n.groupNodes?.length);
  let outWires = [...wires];

  for (const group of groups) {
    // The wires as they stand after the groups before this one: a group
    // wired straight to another group (two recipes in a row) had its
    // neighbor's end rewritten to a member already, and reading the
    // wires as they came in found the neighbor's id, which the
    // flattened graph no longer has. The engine dropped that wire and
    // healed the input from the photograph.
    const current = outWires;
    const members = group.groupNodes!;
    const inner = group.groupWires ?? [];
    const ids = new Set(members.map((m) => m.id));
    const fedInside = new Set(inner.filter((w) => ids.has(w.to)).map((w) => w.to));
    const feedsInside = new Set(inner.filter((w) => ids.has(w.from)).map((w) => w.from));
    const entry = members.find((m) => !fedInside.has(m.id)) ?? members[0];
    const exit = members.find((m) => !feedsInside.has(m.id)) ?? members[members.length - 1];

    // A bypassed group contributes nothing, so the chain runs straight past
    // it rather than through disabled copies of its insides.
    if (!group.enabled) {
      // The picture input, which is whatever is not a mask: a mask feeding a
      // bypassed group has nothing left to attach to and simply goes away.
      // The first picture ("in") when there are two, so a bypassed
      // two-input recipe passes its A rather than whichever was wired
      // first.
      const feed =
        current.find((w) => w.to === group.id && w.kind !== "mask" && w.toPort === "in") ??
        current.find((w) => w.to === group.id && w.kind !== "mask");
      outWires = current
        .filter((w) => w.to !== group.id && w.from !== group.id)
        .concat(
          feed
            ? current
                .filter((w) => w.from === group.id)
                .map((w) => ({ ...w, ...wireSource(feed), kind: feed.kind }))
            : [],
        );
      continue;
    }

    // Which member a boundary wire belongs to. The group's ports summarize
    // the boundary, and a summary loses which member was on the other end:
    // send every incoming wire to the entry and a mask that was feeding the
    // third node in the group starts feeding the first. Matched on port and
    // kind, since that is what the group kept when it took the wire over,
    // and falling back to entry/exit for anything the user has since wired
    // by hand.
    const bound = group.groupBoundary ?? [];
    // The group-side port an entry reads: its own port, unless a
    // recipe named the group's port apart from the member's.
    const seat = (b: Wire) => b.groupPort ?? b.toPort;
    const inTo = (w: Wire): Wire[] => {
      // The wire's own source is the strongest witness: two masks feeding two
      // different layers inside share port and kind, and only the sender
      // tells them apart. Every entry it names gets the pipe: the Finish
      // group's frame arrives once on in2 and feeds every layer mask inside
      // (2026-10-01: masks live in the Finish group).
      const named = bound.filter((b) => ids.has(b.to) && b.from === w.from && b.fromPort === w.fromPort && seat(b) === w.toPort);
      if (named.length) return named;
      // A port whose entries all name one sender is one input fanned
      // out: a pipe that changed its sender since (a crop built under
      // the masks) still feeds them all.
      const seated = bound.filter((b) => ids.has(b.to) && seat(b) === w.toPort);
      if (seated.length > 1 && seated.every((b) => b.from !== "" && b.from === seated[0].from && b.fromPort === seated[0].fromPort)) {
        return seated;
      }
      const one =
        bound.find((b) => ids.has(b.to) && seat(b) === w.toPort && b.kind === w.kind) ??
        bound.find((b) => ids.has(b.to) && seat(b) === w.toPort);
      return one ? [one] : [];
    };
    const outFrom = (w: Wire) => bound.find((b) => ids.has(b.from) && b.to === w.to && b.toPort === w.toPort && b.fromPort === w.fromPort)
      ?? bound.find((b) => ids.has(b.from) && b.fromPort === w.fromPort);

    outNodes = [...outNodes, ...members];
    outWires = [
      ...current.filter((w) => w.to !== group.id && w.from !== group.id),
      ...inner,
      ...dedupeWires(
        current.filter((w) => w.to === group.id).flatMap((w) => {
          const bs = inTo(w);
          if (!bs.length) return [{ ...w, to: entry.id }];
          return bs.map((b) => ({ ...w, to: b.to, toPort: b.toPort, kind: b.kind }));
        }),
      ),
      ...current.filter((w) => w.from === group.id).map((w) => {
        const b = outFrom(w);
        return { ...w, from: b?.from ?? exit.id, fromPort: b?.fromPort, kind: b?.kind ?? w.kind };
      }),
    ];
  }
  return { nodes: outNodes, wires: outWires };
}

/** One control a group offers, and where it writes.
 *
 * The label and range are the group's own, because the point of publishing
 * is that the outside sees a control that makes sense to it rather than the
 * child's own name for the same number. "Radius" on a sharpening group is a
 * blur's radius underneath, and somebody using the group should not have to
 * know that.
 */
export interface Published {
  /** what the control is called on the group */
  label: string;
  /** the child node it writes to */
  node: string;
  /** the parameter on that child */
  param: string;
  /** the group's range for it, which may be narrower than the child's */
  range?: [number, number];
  /** What the group's Reset writes through this control (2026-10-01,
   * the Controls editor); absent, Reset leaves the members as they are. */
  default?: number;
  /** More members the same number lands on (node recipes, 2026-09-30:
   * Frequency Separation's High gain is the scale on all three channels'
   * detail). The control reads (node, param); a move writes all. */
  also?: { node: string; param: string }[];
  /** A menu instead of a slider (node recipes, 2026-09-30): each choice
   * is a set of writes into the members, numbers into params and words
   * into textParams. The menu reads as the first choice whose writes
   * all hold, "Custom" when an edit inside moved one. node and param
   * name the first write, for the readers that only know sliders. */
  options?: PublishedOption[];
}

/** One choice of a published menu, and what choosing it writes. */
export interface PublishedOption {
  label: string;
  writes: { node: string; param: string; value: number | string }[];
}

/** The published menu's current choice: the first option whose writes
 * all hold on the members, or null when an edit inside left none. */
export function publishedChoice(group: NodeCard, label: string): string | null {
  const found = group.published?.find((p) => p.label === label);
  if (!found?.options) return null;
  const holds = (w: PublishedOption["writes"][number]) => {
    const m = group.groupNodes?.find((n) => n.id === w.node);
    if (!m) return false;
    return typeof w.value === "string" ? (m.textParams?.[w.param] ?? PARAM_TEXT_DEFAULT[m.type]?.[w.param]) === w.value : m.params[w.param] === w.value;
  };
  return found.options.find((o) => o.writes.every(holds))?.label ?? null;
}

/** A published list after members went away: a control whose member
 * is gone goes, and its other targets and a menu's writes to a gone
 * member are pruned. */
export function prunePublished(list: Published[] | undefined, alive: (id: string) => boolean): Published[] | undefined {
  return list
    ?.filter((p) => alive(p.node))
    .map((p) => ({
      ...p,
      ...(p.also ? { also: p.also.filter((a) => alive(a.node)) } : {}),
      ...(p.options ? { options: p.options.map((o) => ({ ...o, writes: o.writes.filter((w) => alive(w.node)) })) } : {}),
    }));
}

/** Where a published control actually writes. */
export function publishedTarget(
  group: NodeCard,
  label: string,
): { node: string; param: string } | null {
  const found = group.published?.find((p) => p.label === label);
  return found ? { node: found.node, param: found.param } : null;
}

/** What a published control currently reads. */
export function publishedValue(group: NodeCard, label: string): number | undefined {
  const found = group.published?.find((p) => p.label === label);
  if (!found) return undefined;
  return group.groupNodes?.find((n) => n.id === found.node)?.params[found.param];
}

// --- Publishing a member's param (2026-10-01: "how can user create
// attributes on the group node to control the whole network? this will
// be important for custom recipes"). a 3D package's promote parameter,
// or group inputs: from inside an open group, a member's row is
// published to the group under a name; the same name again joins that
// control, so one slider drives several nodes. The list is the group's
// `published`, the same one the built-in recipes fill.

/** Every (node, param) a control drives, the one it reads first. */
export function publishedTargets(p: Published): { node: string; param: string }[] {
  const out = new Map<string, { node: string; param: string }>();
  const add = (t: { node: string; param: string }) => out.set(`${t.node}\u0000${t.param}`, { node: t.node, param: t.param });
  add(p);
  for (const a of p.also ?? []) add(a);
  for (const o of p.options ?? []) for (const w of o.writes) add(w);
  return [...out.values()];
}

/** How a member's param publishes: a number with its slider's span, or
 * a menu of its choices (a picker's options, a flag's Off and On). */
export function publishShape(
  member: NodeCard,
  param: string,
): { kind: "number"; range: [number, number] } | { kind: "menu"; options: { label: string; value: number | string }[] } {
  const choices = PARAM_OPTIONS[member.type]?.[param];
  if (choices) return { kind: "menu", options: choices.map((o) => ({ label: o.label, value: o.id })) };
  if (FLAG_PARAMS.includes(param)) return { kind: "menu", options: [{ label: "Off", value: 0 }, { label: "On", value: 1 }] };
  return { kind: "number", range: paramRange(param, member.type) };
}

/** A control's span: its own, else the slider span of what it reads. */
export function publishedRange(group: NodeCard, p: Published): [number, number] {
  if (p.range) return p.range;
  const m = group.groupNodes?.find((n) => n.id === p.node);
  return paramRange(p.param, m?.type);
}

const sameTarget = (a: { node: string; param: string }, b: { node: string; param: string }) => a.node === b.node && a.param === b.param;
const fmtNum = (v: number) => String(Math.round(v * 1000) / 1000);

/** The group's list with (node, param) published under `label`, or the
 * sentence that says why not. A new label is a new control; a label
 * the group has is that control, joined: a number joins a number whose
 * span fits inside the new param's, a menu joins a menu whose every
 * choice the new param also offers. */
export function publishParam(
  group: NodeCard,
  node: string,
  param: string,
  label: string,
): { published: Published[] } | { error: string } {
  const name = label.trim();
  if (!name) return { error: "A published control needs a name" };
  const member = group.groupNodes?.find((n) => n.id === node);
  if (!member) return { error: `${node} is not inside ${group.name}` };
  const list = group.published ?? [];
  const shape = publishShape(member, param);
  const existing = list.find((p) => p.label === name);
  const what = `${member.name} ${param.replace(/_/g, " ")}`;
  if (!existing) {
    const control: Published =
      shape.kind === "number"
        ? { label: name, node, param, range: shape.range }
        : { label: name, node, param, options: shape.options.map((o) => ({ label: o.label, writes: [{ node, param, value: o.value }] })) };
    return { published: [...list, control] };
  }
  if (publishedTargets(existing).some((t) => sameTarget(t, { node, param }))) {
    return { error: `${what} already drives ${name}` };
  }
  if (shape.kind === "number") {
    if (existing.options) return { error: `${name} is a menu; ${what} is a number, so publish it under its own name` };
    const [lo, hi] = publishedRange(group, existing);
    const [nlo, nhi] = shape.range;
    if (lo < nlo || hi > nhi) {
      return { error: `${name} runs ${fmtNum(lo)} to ${fmtNum(hi)}, past ${what}'s ${fmtNum(nlo)} to ${fmtNum(nhi)}; publish it under its own name` };
    }
    return { published: list.map((p) => (p === existing ? { ...p, also: [...(p.also ?? []), { node, param }] } : p)) };
  }
  if (!existing.options) return { error: `${name} is a number; ${what} is a menu, so publish it under its own name` };
  const byLabel = new Map(shape.options.map((o) => [o.label.toLowerCase(), o.value]));
  const missing = existing.options.find((o) => !byLabel.has(o.label.toLowerCase()));
  if (missing) return { error: `${what} has no ${missing.label} choice, so it cannot join ${name}` };
  return {
    published: list.map((p) =>
      p === existing
        ? { ...p, options: p.options!.map((o) => ({ ...o, writes: [...o.writes, { node, param, value: byLabel.get(o.label.toLowerCase())! }] })) }
        : p,
    ),
  };
}

/** The list with one target taken off a control (or the whole control
 * when no target is named). A control left driving nothing goes. The
 * members' values are never touched: unpublishing is a change to the
 * group's face, not to the picture. */
export function unpublishParam(list: Published[], label: string, target?: { node: string; param: string }): Published[] {
  return list.flatMap((p): Published[] => {
    if (p.label !== label) return [p];
    if (!target) return [];
    const keep = publishedTargets(p).filter((t) => !sameTarget(t, target));
    if (!keep.length) return [];
    if (p.options) {
      const options = p.options.map((o) => ({ ...o, writes: o.writes.filter((w) => !sameTarget(w, target)) }));
      return [{ ...p, node: keep[0].node, param: keep[0].param, options }];
    }
    const [first, ...rest] = keep;
    const { also: _also, ...base } = p;
    return [{ ...base, node: first.node, param: first.param, ...(rest.length ? { also: rest } : {}) }];
  });
}

/** Writes each control's own default into the members (a group's Reset). */
function publishedDefaults(group: NodeCard): NodeCard[] | undefined {
  const writes = (group.published ?? []).flatMap((p) =>
    p.default === undefined || p.options ? [] : publishedTargets(p).map((t) => ({ ...t, value: p.default! })),
  );
  if (!writes.length || !group.groupNodes) return group.groupNodes;
  return group.groupNodes.map((m) => {
    const mine = writes.filter((w) => w.node === m.id);
    return mine.length ? { ...m, params: { ...m.params, ...Object.fromEntries(mine.map((w) => [w.param, w.value])) } } : m;
  });
}

/** Develop categories that ship off.
 *
 * "To keep the node network simple by default, let's set the
 * following categories to OFF by default. When turned on, build out the
 * nodes... This will help manage the node data and improve performance."
 *
 * One list, read by three things: which categories start collapsed, which
 * ones own nodes that are not created until asked for, and what a switch
 * does when it is thrown. Three copies of it would drift the first time one
 * was added.
 *
 * Source, Exposure and Color are not here on purpose, and the owner left them
 * out for the same reason: they are what makes a RAW file a picture rather
 * than a negative, every one is an identity at its defaults, and a photograph
 * with no develop at all is not finished being opened.
 *
 * Geometry and Detail came out after the owner weighed it up: "I was trying
 * to think what is the absolute minimum that should stay, I thought I would
 * push the boundaries here." Detail stays, since its controls share a node
 * with Color. Geometry stayed for a while because the Crop and Straighten
 * tools write to its node; they write to a stand-in now and the first real
 * write builds the node, so the owner pushed the boundary again (2026-09-01:
 * "Do we need to have Crop & Rotate by default? ... Let's remove that one
 * too."). Sharpen, Denoise and B&W went the same day, as rows that
 * materialize on first write rather than as sections.
 */
export const OFF_BY_DEFAULT = [
  "Geometry",
  "Detail",
  "Relight",
  "Levels",
  "Curves",
  "Color Wheels",
  "Color Bend",
  "Color Tune",
  "Recolor",
  "Lens",
  // "Grid Warp should be collapsed by default."
  "Grid Warp",
  "Shape Warp",
  "Grain",
  "Vignette",
  // "Make sure Depth Map is collapsed by default."
  "Depth Map",
  "Fog",
  "Depth Lighting",
  "Depth of Field",
  "Lens Flare",
  "Halation",
  "Print",
  "Sharpening",
  "Skin Softening",
  "Noise Reduction",
  "Sky Rescue",
] as const;

/** The sections that start folded: the Source strip, every section
 * that ships switched off, Lens Character, and Color Checker (its
 * node is in every graph, switched off, so it is not on the on-demand
 * list above; 2026-09-22: "make sure the section is also collapsed by
 * default"). initialState folds these, and Reset all edits folds them
 * again, so a reset photo reads like a fresh one; sections the user
 * folded stay folded too.*/
export const DEFAULT_SECTIONS_CLOSED: readonly string[] = ["Source", ...OFF_BY_DEFAULT, "Lens Character", "Color Checker"];

/** How many takes the viewport will show at once.
 *
 * "Multi-view in the viewport. To be able to view up to 4
 * versions at once of an image."
 *
 * Four, and four is the right ceiling for a reason beyond his asking: each
 * one is a full graph render of the same photograph, so a fifth costs a
 * fifth of the frame rate to show you a quarter as much of each picture.
 */
export const MULTI_MAX = 4;

/** The grid for a given number of takes.
 *
 * Two side by side rather than stacked, because a comparison of two is
 * almost always left-and-right: the frames are wider than they are tall
 * and stacking them wastes the width. Three goes as a row of three rather
 * than a 2x2 with a hole in it.
 */
export function multiGrid(count: number): { cols: number; rows: number } {
  if (count <= 1) return { cols: 1, rows: 1 };
  if (count === 2) return { cols: 2, rows: 1 };
  if (count === 3) return { cols: 3, rows: 1 };
  return { cols: 2, rows: 2 };
}

/** Identity parameters per node type: what a freshly opened photo starts
 * from. The sample session keeps its demo edit; real images must start
 * untouched, exactly as the camera develop delivers them.
 *
 * Lives here rather than in data.ts because `armed` reads it too: a bypassed
 * node switches itself on the moment a parameter leaves its identity, and a
 * table shared by two modules cannot live above both of them. */
export const NEUTRAL_PARAMS: Record<string, Record<string, number>> = {
  "heeler.image_source": { camera_wb: 1, camera_matrix: 1 },
  "heeler.model_denoise": { luminance: 0, chroma: 0, detail: 50, method: 0 },
  "heeler.merge": { opacity: 100 },
  // Blend Mode had no entry, so a card from the palette carried no
  // opacity key, and the inspector drew its inert placeholder rail in
  // place of the live slider ("Opacity does not work on
  // Blend Mode. Is this a bug?"). It was; the engine has always applied
  // it.
  "heeler.blend": { opacity: 100 },
  // Aspect arrived after graphs were already saved; the identity set
  // backfills them so the new slider reads 0 instead of undefined.
  "heeler.crop_rotate": { angle: 0, aspect: 0, crop_x: 0, crop_y: 0, crop_w: 1, crop_h: 1 },
  // Detail's own node. Standard Color keeps the same detail entries
  // below for graphs saved before the split; the loader moves them.
  "heeler.detail": {
    texture: 0,
    clarity: 0,
    dehaze: 0,
    ...Object.fromEntries(
      ["texture", "clarity", "dehaze"].flatMap((e) =>
        ["shadows", "midtones", "highlights", "red", "green", "blue"].map((w) => [
          `${e}_${w}`,
          100,
        ]),
      ),
    ),
  },
  // The Color Checker at rest is the unit matrix, no exposure, full
  // amount: the op is a bit-exact passthrough there, and armed() sees a
  // fit landing the moment the matrix moves. Sample is the chart tool's
  // circle size, a percent of the cell; it never touches the render.
  "heeler.color_checker": {
    m00: 1,
    m01: 0,
    m02: 0,
    m10: 0,
    m11: 1,
    m12: 0,
    m20: 0,
    m21: 0,
    m22: 1,
    exposure: 0,
    amount: 100,
    sample: 40,
  },
  "heeler.standard_color": {
    temperature: 6500,
    tint: 0,
    saturation: 0,
    vibrance: 0,
    texture: 0,
    clarity: 0,
    dehaze: 0,
    // The Advanced weights, even at 100. Without them here, armed()
    // could not see a weight leaving 100, so a weight dragged first on
    // a bypassed node landed nowhere visible; and a Reset writing them
    // back to 100 must not read as an edit.
    ...Object.fromEntries(
      ["texture", "clarity", "dehaze"].flatMap((e) =>
        ["shadows", "midtones", "highlights", "red", "green", "blue"].map((w) => [
          `${e}_${w}`,
          100,
        ]),
      ),
    ),
  },
  "heeler.color_balance": {
    shadows_lum: 0,
    midtones_lum: 0,
    highlights_lum: 0,
    shadows_hue: 0,
    midtones_hue: 0,
    highlights_hue: 0,
    shadows_sat: 0,
    midtones_sat: 0,
    highlights_sat: 0,
  },
  "heeler.exposure": {
    exposure: 0,
    contrast: 0,
    color_contrast: 0,
    highlights: 0,
    shadows: 0,
    whites: 0,
    blacks: 0,
  },
  "heeler.sharpen": { amount: 0, radius: 1, threshold: 0 },
  "heeler.levels": { black: 0, white: 1, gamma: 1, black_soft: 0, white_soft: 0 },
  "heeler.grain": {
    intensity: 0,
    size: 25,
    shadows_gain: 100,
    midtones_gain: 100,
    highlights_gain: 100,
    red_gain: 100,
    green_gain: 100,
    blue_gain: 100,
    // Enlargement: a fresh graph's grain is a share of the frame; a saved
    // one without the flag keeps the count of pixels it was drawn with.
    by_frame: 1,
  },
  "heeler.group": { grade_strength: 0 },
  // The three depth tools read the map through their own Levels
  // (2026-09-13: "the same levels control that adjustment layers have
  // when Depth mask is turned on"), identity here.
  "heeler.fog": { density: 0, start: 0, falloff: 50, texture: 0, texture_size: 30, texture_shift: 0, fog_level: 72, fog_hue: 220, fog_sat: 10, desat: 0, depth_black: 0, depth_white: 1, depth_gamma: 1, depth_black_soft: 0, depth_white_soft: 0 },
  "heeler.key_light": { strength: 0, azimuth: 45, elevation: 45, ambient: 50, relief: 30, invert: 0, depth_black: 0, depth_white: 1, depth_gamma: 1, depth_black_soft: 0, depth_white_soft: 0 },
  // The Depth Map section's registry defaults; a photograph's own node
  // is born from the preference (depthMapParams), which ships at the
  // same numbers.
  "heeler.depth_map": { edges: 50, flatten: 25, near_clip: 0, far_clip: 0, size: 518, depth_black: 0, depth_white: 1, depth_gamma: 1, depth_black_soft: 0, depth_white_soft: 0 },
  "heeler.dof": { aperture: 0, focus: 0, blades: 6, blade_curve: 100, fringe: 0, field_curve: 0, glow: 0, bubble: 0, squeeze: 0, swirl: 0 },
  "heeler.halation": { threshold: 50, background: 50, by_depth: 0, radius: 4, diffusion: 60, hue: 18, saturation: 70, blue_comp: 0, amount: 100, mix: 100, bloom: 0, bloom_radius: 20 },
  // The recipe tools ship at the recipes' own numbers: the owner's radius
  // 3 at half strength, and his skin softening at 8 with 4 of detail back.
  "heeler.sharpening": { radius: 3, intensity: 50 },
  "heeler.skin_soften": { softening: 8, detail_back: 4, strength: 50 },
  // The flare's "neutral" is its look at default: the node is inert
  // until a light in the rig flares, so these are starting dials, not
  // an identity the engine short-circuits on.
  "heeler.flare": { intensity: 100, temp: 0, size: 6, softness: 50, rays: 0, ray_length: 30, ray_softness: 30, rotation: 0, ghosts: 0, ghost_spacing: 100, ghost_size: 6, blades: 7, dispersion: 30, ghost_opacity: 60, anamorphic: 0, streak_size: 1.5, streak_length: 60, streak_taper: 30, streak_angle: 0, streak_offset: 0, streak_shift: 0, streak_noise: 0, veil: 20, veil_radius: 40, veil_depth: 0, occlusion: 100, occlusion_soft: 30 },
  "heeler.black_white": { red: 30, green: 59, blue: 11, amount: 0, hue_curve_on: 1, ir_foliage: 2.4, ir_sky: -2.5, ir_water: -0.8, ir_skin: 0.6, neutral: 10 },
  // The print at rest: grade 2, no time, a glossy Dmax, a neutral base,
  // no toner. Not an exact identity (the paper's black is its own), so
  // the node ships off and the Print switch turns it on.
  "heeler.paper": { grade: 2, time: 0, split: 0, soft: 0, hard: 0, dmax: 2.1, base: 0, toning: 0, crossover: 50 },
  "heeler.split_tone": {
    shadow_hue: 0,
    shadow_sat: 0,
    highlight_hue: 0,
    highlight_sat: 0,
    balance: 0,
  },
  // Source and destination on the same spot: no bend until it is moved.
  "heeler.color_bend": {
    src_hue: 0,
    src_sat: 0,
    dst_hue: 0,
    dst_sat: 0,
    falloff: BEND_FALLOFF_DEFAULT,
    amount: 100,
  },
  "heeler.tone_profile": { contrast: 100, colorfulness: 0, development: 0 },
  // The Color Set pair: identity is "select the default band, change
  // nothing". Declared here so a hand-placed or half-seeded node still
  // shows every control (withEveryParam backfills instances).
  "heeler.hue_range_mask": { band_center: 30, hue_range: 60, hue_falloff: 30, depth_on: 0, depth_invert: 0, depth_black: 0, depth_white: 1, depth_gamma: 1, depth_black_soft: 0, depth_white_soft: 0 },
  "heeler.color_grade": {
    hue_shift: 0,
    saturation: 0,
    exposure: 0,
    uniformity: 0,
    band_center: 30,
  },
  "heeler.hot_pixel": { sensitivity: 50 },
  "heeler.vignette": { vignette: 0, vignette_mid: 50, softness: 0.5 },
  "heeler.perspective": { vertical: 0, horizontal: 0, zoom: 0 },
  "heeler.grid_warp": { cols: 4, rows: 3 },
  "heeler.shape_warp": {},
  "heeler.transform": { move_x: 0, move_y: 0, size: 100, rotate: 0, pivot_x: 50, pivot_y: 50 },
  "heeler.nlm_denoise": { strength: 0 },
  "heeler.gamut_map": { amount: 100 },
  "heeler.view_transform": { exposure_ev: 0, contrast: 100, white_ev: 6 },
  "heeler.chromatic_adapt": { temperature: 6500, strength: 100 },
  "heeler.channel_mixer": {
    mix_rr: 100,
    mix_rg: 0,
    mix_rb: 0,
    mix_gr: 0,
    mix_gg: 100,
    mix_gb: 0,
    mix_br: 0,
    mix_bg: 0,
    mix_bb: 100,
    preserve_gray: 1,
  },
  "heeler.tone_eq": {
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
  "heeler.lut": { amount: 100 },
  "heeler.recolor": { neutral_guard: 10, smoothing: 50, around_radius: 15 },
  "heeler.color_console": { smoothing: 50 },
};


/** How wide the thumbnail panel may be dragged.
 *
 * "I should be able to resize the panel horizontally which
 * should cause the thumbnails to scale (also means less would be
 * visible but that's the trade off)... Could we make the thumbnails a
 * little larger than they are now so there is some room to scale a
 * little bit? Limit the max width of the panel?"
 *
 * So the thumbnails are rendered once at 2x their old size and the panel
 * scales that one bitmap. Nothing is re-rendered on a drag, and the
 * maximum is where the bitmap runs out of detail rather than an arbitrary
 * number: 2x of a 240 pixel edge is 480, and the cell is a little under
 * the panel's width once its border and padding are taken off.
 *
 * On going further: "anything bigger and it stops being a thumbnail and
 * just turns into a small picture."
 */
export const RIBBON_MIN = 124;
export const RIBBON_MAX = 380;

/** The thumbnail cell for a given panel width.
 *
 * 4:3 rather than square. Most frames are 3:2 and letterbox inside this
 * with a little room either side; a square cell wastes a third of the
 * panel on black for every landscape photograph.
 */
export function thumbCell(panelWidth: number, maxWidth = RIBBON_MAX): { w: number; h: number } {
  const w = Math.max(60, Math.round(Math.min(maxWidth, panelWidth) - 24));
  return { w, h: Math.round((w * 3) / 4) };
}

/** The columns the expanded panel shows, in order.
 *
 * "Some metadata is from the workspace; rating, status,
 * etc. Other columns are common camera data." `own` marks the
 * workspace's half, so the two can be told apart on screen without
 * reading the labels.
 */
export const META_COLUMNS: {
  id: string;
  label: string;
  width: number;
  own?: boolean;
  /** right-aligned, for the numbers */
  num?: boolean;
}[] = [
  { id: "name", label: "File", width: 190, own: true },
  { id: "stars", label: "Rating", width: 74, own: true },
  { id: "flag", label: "Status", width: 66, own: true },
  { id: "edited", label: "Edited", width: 60, own: true },
  { id: "takes", label: "Takes", width: 56, own: true, num: true },
  { id: "shot_at", label: "Taken", width: 132 },
  { id: "camera", label: "Camera", width: 150 },
  { id: "lens", label: "Lens", width: 180 },
  { id: "shutter", label: "Shutter", width: 74, num: true },
  { id: "aperture", label: "Aperture", width: 74, num: true },
  { id: "iso", label: "ISO", width: 60, num: true },
  { id: "focal", label: "Focal", width: 70, num: true },
  { id: "exposure_bias", label: "Exp", width: 66, num: true },
  { id: "pixels", label: "Pixels", width: 100, num: true },
  { id: "size", label: "On disk", width: 82, num: true },
];

/** The right panel's tabs.
 *
 * "we need to change the text labels for Adjustments,
 * history, and presets to icon (the name comes up in a tooltip when
 * mousing over the tab) and add a metadata tab."
 *
 * A list rather than four literals in the panel, because the tabs are
 * about to be movable between a split pair of panes and three different
 * places need to agree on what a tab is.
 */
export type PanelTab = "adjust" | "layers" | "history" | "presets" | "metadata" | "tether";

// Selection is deliberately NOT a tab. It tried being one, and the
// owner called it: "do not make it its own tab. that doesn't make
// sense (now that I've tried it)." A selection is context for whatever
// you are doing, not a place you go, so it appears as an automatic
// split below the panes whenever the select tool is in hand or a
// selection adjustment layer is being worked. Presets tried the
// library panel the same day and came back here.
export const PANEL_TABS: { id: PanelTab; label: string; hint: string }[] = [
  { id: "adjust", label: "Adjustments", hint: "The develop controls for this photograph" },
  {
    id: "layers",
    label: "Finish",
    hint: "Finishing over the developed photograph: paint, retouch, fills and their layers",
  },
  { id: "history", label: "History", hint: "Every edit made, in order, with a way back" },
  { id: "presets", label: "Presets", hint: "Looks you have saved, ready to apply" },
  {
    id: "metadata",
    label: "Metadata",
    hint: "What the camera recorded, and what this workspace knows",
  },
  {
    id: "tether",
    label: "Tether",
    hint: "A shoot straight into Heeler: a watched folder now, the camera's own controls when one is connected",
  },
];

/** The tabs the panel may put on show. Tether sits behind the
 * experimental-features preference: its folder watch is honest work,
 * but until a camera on USB answers back the name promises more than
 * the build keeps. Every consumer of PANEL_TABS that faces the user
 * goes through here, so a stored or incoming reference to the hidden
 * tab simply finds no seat. */
export function visiblePanelTabs(prefs: Pick<Prefs, "experimentalFeatures">): typeof PANEL_TABS {
  return experimentalEnabled(prefs.experimentalFeatures)
    ? PANEL_TABS
    : PANEL_TABS.filter((t) => t.id !== "tether");
}

/** Whether tethering is on show at all: the Tether tab's own gate, so
 * every other door to it (Preferences' tether defaults and their
 * search result) opens and closes with the tab. 2026-09-29: "Tether
 * is hidden right now, so should this."*/
export function tetherShown(prefs: Pick<Prefs, "experimentalFeatures">): boolean {
  return visiblePanelTabs(prefs).some((t) => t.id === "tether");
}

/** The select tool's dials as they ship, for the RESET chip: one press
 * puts the controls back the way a fresh install has them. */
export const SELECT_DEFAULTS = {
  selectTolerance: 0.2,
  selectMagnetSense: 0.5,
  selectSmooth: 0.5,
  selectBrushRadius: 0.04,
} as const;

/** How the polish pass shows the selection.
 *
 * The red overlay is the one people mean when they say "show me the
 * selection": it keeps the photograph visible underneath, which is the
 * only way to judge whether an edge is in the right place. The mattes
 * are for the cases where red is the wrong color to judge against,
 * which is any picture with a lot of red in it.
 */
export const POLISH_VIEWS: { id: string; label: string; hint: string }[] = [
  { id: "overlay", label: "Overlay", hint: "Red over the photograph, so you can see both" },
  { id: "black", label: "On black", hint: "Everything unselected goes black" },
  { id: "white", label: "On white", hint: "Everything unselected goes white" },
  { id: "mask", label: "Mask", hint: "The mask on its own, white for selected" },
];

/** What a selection region does to what is already selected. */
export type SelectOp = "replace" | "add" | "subtract" | "intersect";

/** One piece of a selection.
 *
 * A path covers four of the five ways to make one: freehand, polygon,
 * magnetic lasso and edge-snapping paint all end up as a closed outline,
 * and differ only in how the points were chosen while you dragged. A key
 * is the odd one out and stays what it is, a sample point and a
 * tolerance, because it is a rule about the image rather than a shape
 * drawn on top of it.
 */
export type SelectRegion = SelectRegionState &
  (
  | {
      kind: "path";
      op: SelectOp;
      points: [number, number][];
      /** corner-cutting amount, applied at render so it stays editable */
      smooth?: number;
      /** how it was drawn. Not used by the engine; the panel says it so
       * a list of six outlines is something you can read. */
      via?: string;
    }
  | {
      kind: "key";
      op: SelectOp;
      x: number;
      y: number;
      tolerance: number;
      space?: "color" | "luma";
    }
  | {
      kind: "samples";
      op: SelectOp;
      /** every point the brush passed over */
      points: [number, number][];
      tolerance: number;
      space?: "color" | "luma";
    }
  | {
      kind: "brush";
      op: SelectOp;
      /** the stroke, as drawn */
      points: [number, number][];
      /** half its width, as a fraction of the shorter side */
      radius: number;
    }
  | {
      kind: "bezier";
      op: SelectOp;
      /** anchors as [x, y, hx, hy]: the handle is the OUT vector, and
       * the in-handle is its mirror. A zero handle is a corner. */
      points: [number, number, number, number][];
    }
  | {
      kind: "marquee";
      op: SelectOp;
      /** the two corners it was dragged between, 0..1 of the frame */
      x0: number;
      y0: number;
      x1: number;
      y1: number;
      /** "ellipse" for an oval, absent or anything else for a rectangle */
      shape?: "rect" | "ellipse";
    }
  | {
      kind: "range";
      op: SelectOp;
      /** which plane to read: luma, red/green/blue, saturation, contrast */
      channel: string;
      /** both in display units 0..1, the axis the dialog's histogram is
       * drawn on */
      lo: number;
      hi: number;
      /** how far outside the range coverage takes to fall away */
      soft: number;
    }
  );

/** Every region can sit out without being thrown out.
 *
 * The list of regions IS an editable selection history, which pixel
 * masks in other editors structurally cannot be, and a history you can
 * only delete from is half a history. "we should have a
 * button to enable/disable a selection. I know for a fact NONE of the
 * other apps have that." An off region keeps its geometry and its
 * place in the order; the render, the ants and the engine simply act
 * as if it were not there.*/
export type SelectRegionState = { off?: boolean };

/** A round increment for SHIFT-dragging a slider, sized to its range.
 *
 * "Since not all sliders cover the same value make sure the
 * increment is proportionate and reasonable to range and type of value
 * being controlled." One fixed step cannot serve both a 0..1 opacity
 * and a 2000..12000 kelvin: it is either useless on one or unusable on
 * the other. So: about a twentieth of the range, rounded to the nearest
 * 1, 2 or 5 times a power of ten, which is how a person would pick it.
 *
 * 0..100 gives 5. -1..1 gives 0.1. 2000..12000 gives 500.
 */
export function snapStep(lo: number, hi: number): number {
  const span = Math.abs(hi - lo);
  if (!(span > 0)) return 1;
  const raw = span / 20;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / mag;
  return mag * (n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10);
}

/** The channels a range selection can be taken on. Luma and the three
 * color channels are read straight off the pixel; saturation and
 * contrast are computed, which is what lets "select by contrast" find
 * detail rather than tone. */
export const RANGE_CHANNELS: { id: string; label: string }[] = [
  { id: "luma", label: "Luminance" },
  { id: "red", label: "Red" },
  { id: "green", label: "Green" },
  { id: "blue", label: "Blue" },
  { id: "saturation", label: "Saturation" },
];

/** The selection switches, and the method last in hand.
 *
 * Kept together because they are all "what the selection tool is set
 * to", and all of them outlive the session. "Should
 * remember the last selected selection tool. It seems to keep
 * defaulting to Freehand when the app relaunches."
 */
/** One export configuration: what format, how big, named how. Lives
 * here rather than in export.ts because the queue below is state, and
 * export.ts imports from this file, not the other way around. */
export interface ExportSettings {
  /** jpeg and webp are the 8-bit lossy pair (webp at roughly half the
   * bytes); png is 8-bit lossless; png16 and tiff are the 16-bit
   * archival formats; tiff32 is the float scene-linear one for
   * compositing; dng is the linear scene-referred bake, for files
   * headed into another editor rather than onto a screen. */
  format: "jpeg" | "webp" | "png" | "png16" | "tiff" | "tiff32" | "dng" | "exr";
  quality: number;
  /** longest side, or null for full size */
  maxEdge: number | null;
  /** filename pattern, without extension */
  template: string;
  /** carry the camera's EXIF into the export; on unless switched off */
  keepMetadata: boolean;
  /** the print resolution the file declares, in dots per inch; absent
   * (a preset saved before the setting) reads as 300 (exportDpi) */
  dpi?: number;
  /** matte the photograph onto transparency through the graph's Smart
   * mask; alpha formats only, quietly ignored elsewhere*/
  matte?: boolean;
}

export const DEFAULT_EXPORT_SETTINGS: ExportSettings = {
  format: "jpeg",
  quality: 92,
  maxEdge: null,
  template: "{name}",
  keepMetadata: true,
  dpi: exportResolution.defaultDpi,
};

/** The print resolution an export declares: whole dots per inch inside
 * what every container can store (JFIF's sixteen bits), 300 when
 * unset or nonsense. Pixels are untouched; only the size a print shop
 * or a layout program reads off the file changes (2026-10-06: "I
 * think we are missing DPI settings for exports").*/
export function exportDpi(dpi: number | null | undefined): number {
  if (dpi === null || dpi === undefined || !Number.isFinite(dpi)) return exportResolution.defaultDpi;
  return Math.min(exportResolution.maxDpi, Math.max(1, Math.round(dpi)));
}

export function exportSettingsFromPrefs(prefs: Partial<Prefs>): ExportSettings {
  const resize = prefs.quickResize ?? DEFAULT_PREFS.quickResize;
  return {
    format: prefs.exportDefaultFormat ?? DEFAULT_PREFS.exportDefaultFormat,
    quality: Math.min(100, Math.max(1, Math.round(prefs.quickQuality ?? DEFAULT_PREFS.quickQuality))),
    maxEdge:
      resize === "edge"
        ? Math.min(65536, Math.max(1, Math.round(prefs.quickEdge ?? DEFAULT_PREFS.quickEdge)))
        : null,
    template: prefs.exportTemplate?.trim() || DEFAULT_PREFS.exportTemplate,
    keepMetadata: prefs.exportKeepMetadata ?? DEFAULT_PREFS.exportKeepMetadata,
    dpi: exportDpi(prefs.quickDpi ?? DEFAULT_PREFS.quickDpi),
  };
}

/** A batch group: images queued to export together, sharing one set of
 * settings. "the images don't need to have all the same
 * export settings... what we can have is a tab of batch groups." Tabs
 * in the panel, groups here.*/
/** One queued photo, carrying what the export run and the tile need.
 * Captured at ADD time, so the queue stands on its own: the owner
 * stages photos "from various folders and collections", and a queue
 * that leaned on the current library view forgot everyone the
 * moment the view changed.*/
export interface QueuedPhoto {
  id: string;
  name: string;
  stars: number;
  flag: "" | "pick" | "reject";
}

export interface ExportGroup {
  id: string;
  name: string;
  queued: QueuedPhoto[];
  settings: ExportSettings;
  /** where this batch lands. Per group, not per panel: web JPEGs and
   * archive TIFFs rarely want the same folder. */
  folder: string | null;
}

let nextGroupId = 1;

export function freshExportGroup(
  existing: ExportGroup[],
  prefs: Partial<Prefs> = DEFAULT_PREFS,
): ExportGroup {
  const n =
    Math.max(0, ...existing.map((g) => Number(g.name.match(/^Batch (\d+)$/)?.[1] ?? 0))) + 1;
  return {
    id: `bg_${nextGroupId++}_${existing.length}`,
    name: `Batch ${n}`,
    queued: [],
    settings: exportSettingsFromPrefs(prefs),
    folder: null,
  };
}

/** The panel geometry a fresh launch shows, and what Reset layout puts
 * back. One table, read by initialState and by the reset. */
export const DEFAULT_PANEL_SIZES = {
  library: 252,
  right: 320,
  graphViewer: 440,
  ribbon: RIBBON_MIN,
  // Zero means "even", so a fresh split is half and half. A number
  // here is only ever what a drag left behind.
  rightSplit: 0,
  selectionSplit: 0,
  // About eight rows: roughly what the old 45vh cap gave on a laptop,
  // so nothing jumps for anyone who never drags the seam.
  libraryTree: 180,
} as const;

/** The Adjustments panel's filter. A layout saved with the retired "free"
 * filter is not one of these, so restore_layout keeps the default. */
export type SectionFilter = "all" | "pinned" | "on";
export const SECTION_FILTERS: readonly SectionFilter[] = ["all", "pinned", "on"];

export const TOOL_POPOUT_KEYS = ["wheels", "curves", "toneeq", "recolor", "colorconsole"] as const;
export type ToolPopoutKey = (typeof TOOL_POPOUT_KEYS)[number];

/** The shape of the window the user left: what is remembered between
 * launches so Heeler comes back as it was closed (2026-09-09:
 * "Heeler should remember its last UI state of the elements").
 * Every field is validated on the way back in, since the file is
 * hand editable and older files carry fewer fields.*/
export interface UiLayout {
  inspectorHome: "main" | "graph";
  browserOpen: boolean;
  ribbonOpen: boolean;
  ribbonView: "thumbs" | "list";
  mode: Mode;
  panelSizes: Record<keyof typeof DEFAULT_PANEL_SIZES, number>;
  panelTab: PanelTab;
  panelBottom: PanelTab[];
  panelTabBottom: PanelTab;
  selectionSplitMin: boolean;
  /** Which Adjustments sections the panel lists: every one, the pinned
   * ones, or the ones switched on for this photograph. */
  sectionFilter: SectionFilter;
  popouts: {
    graph: boolean;
    spectrums: boolean;
    takes: boolean;
    bend: boolean;
    console: boolean;
    tools: Record<ToolPopoutKey, boolean>;
  };
}

export function layoutSnapshot(s: State): UiLayout {
  return {
    inspectorHome: s.inspectorHome,
    browserOpen: s.browserOpen,
    ribbonOpen: s.ribbonOpen,
    ribbonView: s.ribbonView,
    mode: s.mode,
    panelSizes: { ...s.panelSizes },
    panelTab: s.panelTab,
    panelBottom: [...s.panelBottom],
    panelTabBottom: s.panelTabBottom,
    selectionSplitMin: s.selectionSplitMin,
    sectionFilter: s.sectionFilter,
    popouts: {
      graph: s.graphPoppedOut,
      spectrums: s.spectrumsPoppedOut,
      takes: s.takesPoppedOut,
      bend: s.bendPoppedOut,
      console: s.consoleWindowOpen,
      tools: { ...s.toolPopouts },
    },
  };
}

export interface UiSettings {
  /** durable preferences shared with the rest of the app settings.
   * Machine-specific display and brush overlay choices stay in
   * uiprefs.ts because they describe the local screen and input setup. */
  prefs?: Prefs;
  /** the window as it was left: panels, sizes, workspace, pop-outs */
  layout?: UiLayout;
  /** the scripting bridge: off by default, like every capability
   * nobody asked for yet*/
  apiEnabled: boolean;
  /** which mode of the Transform slot the button is showing (ShapeMode).
   * Transform is the default: moving and scaling a layer is the
   * everyday reach, and pulling one corner out of square the
   * deliberate one. */
  shapeMode: ShapeMode;
  /** which half of the dodge/burn pair the button is showing */
  dodgeMode: "dodge" | "burn";
  /** which half of the clone/heal pair the button is showing. Heal is
   * the default: fixing a flaw is the everyday reach, copying pixels
   * wholesale the deliberate one. */
  repairMode: "clone" | "heal";
  /** which half of the blur/blend pair the button is showing. Blur is
   * the default: softening what is under the brush is the everyday
   * reach, averaging two colors into each other the deliberate one. */
  blurMode: "blur" | "blend";
  /** which of Pixel, Gradient and Fill the Finish toolbar's split button
   * shows and repeats: the last one made from it (2026-09-30: the left
   * half "shows and repeats whichever of the three was used last").
   * Pixel is the default. Kept with the tool pairs above, the way every
   * other remembered tool choice is.*/
  artContentKind?: ArtContentKind;
  /** the Finish toolbar's Expand settings on select toggle (2026-09-30:
   * "Whatever the last setting the user set will persist, it's a global
   * setting and not per-photo"). On, selecting a layer opens its settings
   * and the one before closes; off, every row stays a Pixel row's height
   * and opens with its own chevron (Show settings). Off is the default:
   * The owner asked for a button "so layers aren't expanding and
   * collapsing all the time", and said the button "can be toggled off".*/
  layerExpandOnSelect?: boolean;
  selectMethod: string;
  /** the export queue's batch groups, kept across launches: a queue
   * built up over a culling session should survive the relaunch that
   * happens before the export run */
  exportQueue?: State["exportQueue"];
  /** rectangle and ellipse grow from the middle rather than a corner.
   * CTRL does it for one drag without changing the setting. */
  selectFromCenter: boolean;
  /** soften the selection edge by a fraction of a pixel. On, because a
   * staircase edge is a worse default than a soft one. */
  selectAntialias: boolean;
  /** a click on the canvas with no drag clears the selection.
   * "Most apps do this by default, I've yet to see one give the user
   * option to not clear a selection" -- so it is an option here, and it
   * is on.*/
  selectAutoClear: boolean;
  /** the smart click tools mark each prompt with a dot (green adds,
   * red carves). On, because invisible prompts make every recompute
   * look arbitrary; off for who finds them noisy now that the ants
   * trace the result. "maybe an option in the Select
   * menu to toggle the dots visibility off?"*/
  selectShowClicks: boolean;
  /** deleting a node reconnects its neighbors around the hole, the way
   * extract does. SHIFT at the moment of deletion inverts whichever
   * way this is set. "Deleting a node it should make an
   * attempt to reconnect nodes on each side automatically."*/
  deleteHeals: boolean;
  /** the tone profile a newly imported RAW is born with. "Maybe
   * people loading RAW files don't want a profile added ([the other editor]
   * works like this)" - Linear is that neutral start (no curve, the baseline
   * lift stays, like another RAW editor's default exposure). Rendered files
   * (JPG, HEIC, TIFF) always start with the profile OFF: the camera already
   * rendered them once. Per image, the Source panel's Profile row overrides
   * either way.*/
  rawProfile: "linear" | "standard" | "film";
  /** the capture sharpening a newly imported RAW is born with, written
   * into its source node's `sharpening`. 2026-09-29: "I think the
   * global default should be defined in Preferences > Import & Files,
   * right below RAW default profile." Only a graph made after the
   * change takes it: a photograph that already has one keeps its own
   * choice, and one saved before the control existed still reads
   * absent as Standard. Rendered files, bakes and merges never get it
   * (the decoder sharpens sensor data only).*/
  rawSharpening: RawSharpening;
}

/** The layers the Finish toolbar's split button makes: content you
 * make, as against an adjustment, a utility or an image. */
export const ART_CONTENT_KINDS = ["paint", "gradient", "fill"] as const;
export type ArtContentKind = (typeof ART_CONTENT_KINDS)[number];
export const isArtContentKind = (v: unknown): v is ArtContentKind =>
  typeof v === "string" && (ART_CONTENT_KINDS as readonly string[]).includes(v);

/** The Source section's Sharpening choices, in the order shown. */
export const RAW_SHARPENING = ["off", "low", "standard", "high"] as const;
export type RawSharpening = (typeof RAW_SHARPENING)[number];
export const isRawSharpening = (v: unknown): v is RawSharpening =>
  typeof v === "string" && (RAW_SHARPENING as readonly string[]).includes(v);

export const DEFAULT_UI_SETTINGS: UiSettings = {
  apiEnabled: false,
  shapeMode: "transform",
  dodgeMode: "dodge",
  repairMode: "heal",
  blurMode: "blur",
  selectMethod: "freehand",
  selectFromCenter: false,
  selectAntialias: true,
  selectAutoClear: true,
  selectShowClicks: true,
  deleteHeals: true,
  rawProfile: "standard",
  rawSharpening: "standard",
};

/** What a polish stroke means.
 *
 * The four the layer editors settled on, because they settled
 * on the right four: re-analyze the edge, add, take away, soften. Matte
 * is the clever one; the other three are what you reach for when the
 * clever one has got most of it.
 */
export const POLISH_MODES: { id: string; label: string; hint: string }[] = [
  {
    id: "matte",
    label: "Matte",
    hint: "Re-read the edge from the photograph: brush along the boundary, covering the fur or hair to be kept. ALT takes away instead",
  },
  { id: "foreground", label: "Add", hint: "Paint more of the subject into the selection. ALT removes" },
  { id: "background", label: "Remove", hint: "Paint the background back out of the selection. ALT adds" },
  { id: "feather", label: "Soften", hint: "Soften the edge just where you paint" },
];

/** The ways to make a selection, in the order the toolbar shows them. */
export const SELECT_METHODS: { id: string; label: string; hint: string }[] = [
  { id: "rect", label: "Rectangle", hint: "Drag a rectangle; SHIFT keeps it square" },
  { id: "ellipse", label: "Ellipse", hint: "Drag an oval; SHIFT keeps it circular" },
  // Pen absorbed Polygon. A pen anchor placed with a click and no drag
  // has no handles, and a cubic with no handles IS a straight line, so
  // clicking pen anchors around a shape was already drawing the polygon
  // the Polygon tool drew. "I don't see any good reason to
  // have Polygon." Nor could I: it was the same tool with the interesting
  // half removed.
  { id: "pen", label: "Pen", hint: "Click for a corner, drag for a curve; double-click, ENTER or click the first point to close" },
  { id: "freehand", label: "Freehand", hint: "Drag an outline; smoothing evens out the shakes" },
  { id: "magnetic", label: "Magnetic", hint: "Trace near an edge and the path snaps onto it" },
  { id: "paint", label: "Color brush", hint: "Drag over the colors you want; everything like them is selected" },
  { id: "wand", label: "Color pick", hint: "Click one color to select everything like it" },
  // Region Select, honestly named: similarity grouping, not object
  // detection. It will hand back the sunlit half of the dog, because
  // that is a coherent region, and it has no idea what a dog is.
  { id: "region", label: "Region Select", hint: "Click a region and the picture's own structure selects it; Tolerance sets how much counts as one region" },
  // The one method that IS object detection: the smart models, making
  // a selection and nothing else. "These don't create
  // layers or anything, they just create selections only."
  { id: "smart", label: "Smart click", hint: "Click what you mean and the model finds its edges; ALT-click carves away" },
];

export const SELECT_OPS: { id: SelectOp; label: string; hint: string }[] = [
  { id: "replace", label: "New", hint: "Start again from this region" },
  { id: "add", label: "Add", hint: "Add to what is already selected" },
  { id: "subtract", label: "Subtract", hint: "Take this out of the selection" },
  { id: "intersect", label: "Intersect", hint: "Keep only where both overlap" },
];

/** The brush tips, in the order the picker shows them. */
export const BRUSH_TIPS: { id: string; label: string; hint: string }[] = [
  { id: "circle", label: "Round", hint: "Soft round tip, the default" },
  { id: "square", label: "Square", hint: "Hard-cornered tip for straight edges" },
  { id: "texture", label: "Texture", hint: "Procedural grain; scale and depth below" },
  { id: "splatter", label: "Splatter", hint: "Sparse blobs, like a loaded brush flicked" },
  { id: "dry", label: "Dry media", hint: "Streaky, like chalk running out on paper" },
  { id: "crosshatch", label: "Crosshatch", hint: "Two rulings at right angles" },
];

/** Tips whose texture controls do anything. Round and square are solid,
 * so offering them a grain slider would be offering nothing. */
export const TEXTURED_TIPS = ["texture", "splatter", "dry", "crosshatch"];

export interface NodeCard {
  id: string;
  type: string;
  name: string;
  cat: Category;
  x: number;
  y: number;
  enabled: boolean;
  params: Record<string, number>;
  /** short value badge shown in the node header */
  badge?: string;
  /** tone curves per channel, points [x,y] in 0..1, on curves nodes */
  curves?: Partial<Record<CurveChannel, [number, number][]>>;
  /** curve interpolation; smooth (monotone cubic) unless set to linear
   * or tangent (hermite through user-set slopes) */
  curveInterp?: "smooth" | "linear" | "tangent";
  /** per-point tangent slopes, parallel to curves[channel]; read only
   * in tangent mode, and a length mismatch falls back to the monotone
   * slopes rather than guessing */
  curveTangents?: Partial<Record<CurveChannel, number[]>>;
  /** per-point tangent HANDLES, parallel to curves[channel]: full
   * vectors per side, so length means something (a longer handle holds
   * the curve to its line further), plus the broken flag when the pair
   * moves independently. Null entries are points still on automatic.
   * When a point has a handle it outranks the slope in curveTangents;
   * the slope is kept alongside as the coarse fallback older readers
   * understand. */
  curveHandles?: Partial<Record<CurveChannel, (CurveHandle | null)[]>>;
  /** text-valued params (e.g. grain pattern), kept apart from numbers */
  textParams?: Record<string, string>;
  /** brush strokes, present on brush mask nodes */
  strokes?: StrokeData[];
  /** selection geometry, present on selection mask nodes */
  regions?: SelectRegion[];
  /** which Finish layer kind built this content node. UI only, never
   * serialized: two kinds can share an engine node (White Balance and
   * Color are both standard_color), so the type cannot say which set of
   * controls the layer was asked for. */
  artKind?: ArtKind;
  isGroup?: boolean;
  groupNodes?: NodeCard[];
  /** the wiring between those members, kept so the group can be expanded
   * again on the way to the engine. Without it a group is a bag of nodes
   * and nobody knows what fed what. */
  groupWires?: Wire[];
  /** the wires that crossed the boundary, in the form they had before the
   * group swallowed their inner end. The group's own ports are a summary of
   * these, and a summary cannot say which member a mask was feeding. */
  groupBoundary?: Wire[];
  /** the controls a group offers without opening it.
   *
   * "A container is like a group, but you instead define a
   * list of attributes... an abstraction layer another user works with
   * without having to dig into the complex node network." And, on
   * whether that should be a second type: "I would be good keeping
   * group only."
   *
   * So a group with nothing published is today's group, and a group that
   * publishes is the abstraction. One concept, and the difference between
   * them is a list rather than a type nobody can tell apart from the other. */
  published?: Published[];
  /** A group that IS a layer tool (Sharpening, Skin Softening:
   * 2026-09-23, "the Sharpening node should be a group... so I could
   * verify they were setup correct and make modifications as I see
   * fit"). The key into LAYER_TOOLS; the group's params mirror the
   * recipe's dials and syncToolGroup keeps the two in step.*/
  tool?: string;
  /** A group dropped from a node recipe (2026-09-30: "a group a user
   * drops into their node graph, doesn't overwrite anything"): the
   * recipe's id, for the record. Its inputs are the boundary's declared
   * ports, so a pipe may land on it (graph.tsx wirableGroup).*/
  recipe?: string;
  maskIn?: boolean;
  maskOut?: boolean;
  /** Depth Map alone: a second, field output below the image out,
   * carrying the farness plane (26.3 Phase 4). Derived from the type
   * by makeNode and by the load migration, never by hand. */
  depthOut?: boolean;
  /** Output alone: the export's transparency as a wired field, a
   * diamond where a mask diamond would sit (26.3 Phase 5). Derived
   * from the type, same as depthOut. */
  alphaIn?: boolean;
  /** File alone: the page's alpha (or the named channel) as a field
   * output below the image out (26.3 Phase 6). Derived from the type,
   * same as depthOut. */
  fileMaskOut?: boolean;
  /** Every depth consumer: the input the Depth Map's plane lands on, a
   * field diamond beside the mask one (26.3 Phase 10.3). Derived from
   * the type, same as depthOut. */
  depthIn?: boolean;
  /** a user-chosen accent on the card, for organization; the category
   * stripe stays, this rides beside it */
  tint?: string;
  /** a note on the node's face, a compositor's label: why this node is here,
   * written where the next person will look */
  note?: string;
  /** On a Bake Warp layer's picture node (the content that took the Warp
   * layer's seat): the Warp layer as it was when it was baked, so
   * Unbake can put it back live (2026-10-01: "go ahead with 1 and 2", 2
   * being "keep the warp's settings on the baked layer so it can be
   * unbaked"). Saved with the graph, carried by takes, copied edits and
   * links like any node; never reaches the engine. No pixels: a pixel
   * mask's bake is a pointer, which recovery and the Storage clear read
   * here as on any mask (recovery.rs required_rasters walks the whole
   * saved graph), and a crop carries the warp and mask geometry here as
   * it does live (framemap.ts remapNode).*/
  bakedFrom?: BakedWarp;
  /** on a Develop layer's exposure node: the layer is switched off,
   * and these are the members that were on when it was, so switching
   * it back on restores exactly them. Absent means on. Persists with
   * the graph; never reaches the engine (the members' own `enabled`
   * carries the effect). */
  layerOff?: string[];
  hasIn?: boolean;
  hasIn2?: boolean;
  /** a third stacked input (Channel Join's b) */
  hasIn3?: boolean;
  hasOut?: boolean;
}

/** A Warp layer's whole definition, kept on the layer Bake Warp made of
 * it (NodeCard.bakedFrom): its carrier (the blend, or a group member's
 * carrier: name, mode, opacity, clipping, placement), its warp (type,
 * grid mesh, shapes, holds, feather, amount, edges, space), its effects
 * in order, and its mask node when it had one (strokes, base, frozen
 * selection, gradient, Depth block), each as the graph held it. */
export interface BakedWarp {
  carrier: NodeCard;
  content: NodeCard;
  fx: NodeCard[];
  mask?: NodeCard;
}

/** The node the preview renders: Output when the graph has one, else
 * the last node that is fed and feeds nothing, else the last node. The
 * same rule as the desktop's terminal_of, mirrored so a sampler can
 * name the frame on screen by a real id (Graph mode can delete
 * Output; the desktop then falls back to this node, and so do we). */
export function chainTerminalId(nodes: { id: string; type: string }[], wires: { from: string; to: string }[]): string | undefined {
  const output = nodes.find((n) => n.type === "heeler.output");
  if (output) return output.id;
  const fed = new Set(wires.map((w) => w.to));
  const feeds = new Set(wires.map((w) => w.from));
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i];
    if (fed.has(n.id) && !feeds.has(n.id)) return n.id;
  }
  return nodes[nodes.length - 1]?.id;
}

export interface Wire {
  from: string;
  /** Absent is the ordinary image/field output ("out" in the engine).
   * "depth" is Depth Map's second output (26.3 Phase 4): the pipe
   * carries the farness plane, so its kind is always "mask". "mask" is
   * a File node's second output (Phase 6): the page's alpha or named
   * channel, a mask pipe too; the Export Layer's mask pair passes its
   * field through the same port name (Phase 8). "image" is the Export
   * Layer's pass-through image output, named in the engine. */
  fromPort?: "depth" | "mask" | "image";
  to: string;
  /** "clip" is the paint stencil: a selection limiting where strokes
   * land, kept apart from "mask" so a layer can have both. "alpha" is
   * Output's transparency input (26.3 Phase 5): a mask pipe by kind,
   * kept apart from "mask" because Output's mask port is the matte's
   * own affair and never drawn. "depth" is a depth consumer's plane
   * input (26.3 Phase 10.3), wired from the Depth Map's depth output. */
  toPort: "in" | "in2" | "in3" | "mask" | "clip" | "alpha" | "depth";
  kind: "image" | "mask" | "group";
  /** On a group's boundary entry only (node recipes, 2026-09-30): which
   * of the GROUP's own inputs this entry reads, when that is not the
   * port it lands on inside. A recipe's second picture arrives on the
   * group's in2 and lands on a member's in; without this the group's
   * port and the member's port had to share a name. Absent means they
   * do, which is every group made before recipes. */
  groupPort?: "in" | "in2" | "in3" | "mask" | "depth";
}

/** Node footprint on the graph canvas; mirrored by the editor's CSS. */
export const NODE_W = 140;
export const NODE_H = 78;

/** Breathing room kept around a new card, so its ports stay clickable
 * beside a neighbor. */
const CARD_MARGIN = 12;
/** One step of the free-spot scan: a card and a gap. */
const STEP_X = NODE_W + 40;
const STEP_Y = NODE_H + 30;
/** How many steps out the scan goes before giving up on nearness. */
const SCAN_RINGS = 12;

function cardsOverlap(a: { x: number; y: number }, b: { x: number; y: number }): boolean {
  return Math.abs(a.x - b.x) < NODE_W + CARD_MARGIN && Math.abs(a.y - b.y) < NODE_H + CARD_MARGIN;
}

/** The offset that moves the new `cards` (as a block, their spacing
 * kept) off every card in `taken`, nearest to (dx, dy) first.
 * 2026-09-28: "fix the new node landing on top of the previous one."
 * The natural spot wins when it is free; otherwise the scan steps a
 * card and a gap at a time, ring by ring, nearest first, right before
 * left and below before above. Bounded: past the last ring the block
 * goes right of everything, which is always free. Existing cards
 * never move.*/
export function freeOffset(
  taken: { x: number; y: number }[],
  cards: { x: number; y: number }[],
  dx = 0,
  dy = 0,
): { dx: number; dy: number } {
  if (!cards.length) return { dx, dy };
  const fits = (ox: number, oy: number) =>
    cards.every((c) => !taken.some((t) => cardsOverlap({ x: c.x + ox, y: c.y + oy }, t)));
  if (fits(dx, dy)) return { dx, dy };
  for (let r = 1; r <= SCAN_RINGS; r++) {
    const ring: { i: number; j: number }[] = [];
    for (let i = -r; i <= r; i++) {
      for (let j = -r; j <= r; j++) {
        if (Math.max(Math.abs(i), Math.abs(j)) === r) ring.push({ i, j });
      }
    }
    ring.sort((a, b) => {
      const da = (a.i * STEP_X) ** 2 + (a.j * STEP_Y) ** 2;
      const db = (b.i * STEP_X) ** 2 + (b.j * STEP_Y) ** 2;
      if (da !== db) return da - db;
      // Downstream reads left to right, then top to bottom.
      if ((a.i < 0) !== (b.i < 0)) return a.i < 0 ? 1 : -1;
      if ((a.j < 0) !== (b.j < 0)) return a.j < 0 ? 1 : -1;
      return b.i - a.i || b.j - a.j;
    });
    for (const { i, j } of ring) {
      const ox = dx + i * STEP_X;
      const oy = dy + j * STEP_Y;
      if (fits(ox, oy)) return { dx: ox, dy: oy };
    }
  }
  const right = Math.max(...taken.map((t) => t.x + NODE_W));
  const left = Math.min(...cards.map((c) => c.x));
  return { dx: right + 40 - left, dy };
}

/** A free top-left corner for one new card, nearest to (x, y). */
export function freeSpot(taken: { x: number; y: number }[], x: number, y: number): { x: number; y: number } {
  const o = freeOffset(taken, [{ x, y }]);
  return { x: x + o.dx, y: y + o.dy };
}

/** Where a new card lands when nothing points at a spot: to the right
 * of the selected card (downstream, the way a chain is built), else the
 * given fallback (the view's own spot); either one stepped free. */
export function placeNewNode(s: Pick<State, "nodes" | "selection">, fallback: { x: number; y: number }, beside: boolean): { x: number; y: number } {
  const anchor = beside
    ? [...s.selection].reverse().map((id) => s.nodes.find((n) => n.id === id)).find((n) => !!n)
    : undefined;
  const natural = anchor ? { x: anchor.x + STEP_X, y: anchor.y } : fallback;
  return freeSpot(s.nodes, natural.x, natural.y);
}

/** The view that centers `subjects` in a w×h viewport, or null when
 * there is nothing to frame. Never past 1x: framing is for finding
 * things, and blowing two nodes up to fill the window is losing them
 * a different way. */
export function framedView(
  subjects: { x: number; y: number }[],
  w: number,
  h: number,
): { x: number; y: number; zoom: number } | null {
  if (!subjects.length || w <= 0 || h <= 0) return null;
  const minX = Math.min(...subjects.map((n) => n.x));
  const maxX = Math.max(...subjects.map((n) => n.x + NODE_W));
  const minY = Math.min(...subjects.map((n) => n.y));
  const maxY = Math.max(...subjects.map((n) => n.y + NODE_H));
  const PAD = 60;
  const zoom = Math.min(
    1,
    Math.max(0.2, Math.min(w / (maxX - minX + PAD * 2), h / (maxY - minY + PAD * 2))),
  );
  return {
    zoom,
    x: w / 2 - ((minX + maxX) / 2) * zoom,
    y: h / 2 - ((minY + maxY) / 2) * zoom,
  };
}

/** Compositor-style backdrop: a labeled, colored region the user lays out.
 * Dragging a backdrop moves the nodes inside it. Organization belongs to
 * the artist; backdrops replaced the fixed pipeline lanes. */
export interface Backdrop {
  id: string;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** index into BACKDROP_COLORS */
  color: number;
}

export const BACKDROP_COLORS = [
  "#2b2620",
  "#20262b",
  "#26202b",
  "#202b22",
  "#2b2020",
];

/** Nodes whose center sits inside the backdrop move with it. */
export function nodesInBackdrop(nodes: NodeCard[], b: Backdrop): string[] {
  return nodes
    .filter((n) => {
      const cx = n.x + NODE_W / 2;
      const cy = n.y + NODE_H / 2;
      return cx >= b.x && cx <= b.x + b.w && cy >= b.y && cy <= b.y + b.h;
    })
    .map((n) => n.id);
}

export interface ImageEntry {
  renderedBake?: boolean;
  /** a phone's DNG, rendered at decode by its own gain table map */
  phoneRendered?: boolean;
  /** a stack or panorama made only of finished pictures (JPEGs and the
   * like): the camera's look is already in its frames */
  renderedFrames?: boolean;
  bakedFrom?: string | null;
  id: string;
  name: string;
  stars: number;
  flag: "" | "pick" | "reject";
  edited: boolean;
  filter: string;
  src: string;
  /** The file is not where the catalog says it is. The row, the rating,
   * the edits and the cached thumbnail are all still here; only the
   * photograph has gone somewhere, and Relink says where. */
  missing?: boolean;
  /** The link group this photograph belongs to (2026-09-09): an edit to
   * any member is mirrored onto the others, as relative deltas, the way
   * quad edit mirrors. Absent or null when unlinked.*/
  linkGroup?: string | null;
}

export interface FolderEntry {
  id: number;
  name: string;
  path: string;
  count: number;
  lastOpened: number;
}

export interface CollectionEntry {
  id: number;
  name: string;
  count: number;
  hasLook: boolean;
}

/** One node of the folder navigation tree. `children: null` means not yet
 * listed (lazy); an empty array means listed and empty. */
export interface TreeNode {
  name: string;
  path: string;
  expanded: boolean;
  children: TreeNode[] | null;
}

/** Applies `f` to the node at `path`, preserving identity elsewhere. */
export function updateTreeNode(
  node: TreeNode,
  path: string,
  f: (n: TreeNode) => TreeNode,
): TreeNode {
  if (node.path === path) return f(node);
  if (!node.children) return node;
  let changed = false;
  const children = node.children.map((c) => {
    const next = updateTreeNode(c, path, f);
    if (next !== c) changed = true;
    return next;
  });
  return changed ? { ...node, children } : node;
}

/** Merges a fresh subfolder listing into existing children: known paths
 * keep their expansion state and grandchildren, new ones appear collapsed,
 * removed ones drop out. This is what the new-folder watcher applies. */
export function mergeTreeChildren(
  existing: TreeNode[] | null,
  incoming: { name: string; path: string }[],
): TreeNode[] {
  return incoming.map(
    (c) =>
      existing?.find((e) => e.path === c.path) ?? {
        name: c.name,
        path: c.path,
        expanded: false,
        children: null,
      },
  );
}

export interface GraphSnapshot {
  nodes: NodeCard[];
  wires: Wire[];
  backdrops: Backdrop[];
  undoStack: Snapshot[];
  redoStack: Snapshot[];
  /** the photo's link overrides, read with its graph (see State.linkOverrides) */
  overrides?: string[];
  /** Set when this stash was taken while the photo's saved graph was
   * still being read: the stashed graph is the default template, not the
   * photo's edits. The owner's click A, B, A during a slow first read
   * flashed the unedited look on returning to A because the hold was
   * lifted for the template stash; a preRead stash does not lift it.*/
  preRead?: boolean;
}

/** How the photograph currently sits on screen. See State.view for the
 * rules; the fields are exactly the ones a wheel tick or a drag changes
 * at pointer rate. */
/** The Split tool's three carvings of the frame. Line is the classic
 * divider, grown a rotation; grid is a checkerboard of cells; radial
 * is a slice around a movable apex. `barShown`/`barColor` dress the
 * divider, the grid lines and the slice edges alike. */
export type SplitConfig = {
  mode: "line" | "twin" | "grid" | "radial";
  /** line: bar rotation in degrees clockwise from vertical; 0 is the
   * classic left/right split */
  angle: number;
  /** line and twin: edited frame on the left, original on the right */
  reverse: boolean;
  /** twin: the two panes side by side (true) or stacked (false). Both
   * panes frame the SAME part of the photograph, before beside after,
   * and the view's own pan reframes them together ("if I
   * am looking at someone's left eye zoomed in 1:1 and I split I see
   * the left eye in both halves but one is before").*/
  twinVertical: boolean;
  /** grid: column and row counts */
  gridX: number;
  gridY: number;
  /** grid: flips which checkerboard parity shows the original */
  gridInvert: boolean;
  /** radial: the slice's apex, 0..1 of the frame */
  radialX: number;
  radialY: number;
  /** radial: the slice's two edges, degrees clockwise from straight up */
  radialFrom: number;
  radialTo: number;
  /** radial: the slice shows the original instead of the edit */
  radialInvert: boolean;
  /** the divider bar, grid lines and slice edges: drawn or hidden */
  barShown: boolean;
  /** CSS color those lines are drawn in */
  barColor: string;
};

/** Degrees folded into (-180, 180], so a full drag around a handle
 * never accumulates thousands of degrees in the readout. */
export function wrapDeg(a: number): number {
  const m = ((a % 360) + 360) % 360;
  return m > 180 ? m - 360 : m;
}

/** A fresh Split: the classic vertical bar, a 3x3 grid waiting behind
 * it, and a 45-degree slice standing straight up from the center. */
export const SPLIT_DEFAULTS: SplitConfig = {
  mode: "line",
  angle: 0,
  reverse: false,
  twinVertical: true,
  gridX: 3,
  gridY: 3,
  gridInvert: false,
  radialX: 0.5,
  radialY: 0.5,
  radialFrom: -22.5,
  radialTo: 22.5,
  radialInvert: false,
  barShown: true,
  barColor: "#eef2f5",
};

export interface ViewState {
  /** zoom multiplier on top of the base (fit or 100%); 1 = base */
  zoomScale: number;
  /** viewer pan offset in screen pixels, applied when zoomed */
  pan: { x: number; y: number };
  /** viewing-only rotation in degrees: a way to look at the photo from
   * another angle while editing. Never touches the graph, never exports. */
  viewRotation: number;
  /** split divider position, 0..1 of viewer width */
  splitPos: number;
  /** the sharp region-of-interest patch overlaying the upscaled fast
   * tier at 1:1: the engine renders only the pixels the viewport shows.
   * rect and frame are normalized/full-res as the engine reported them.
   * mask is the mask node this slice shows, null for the developed
   * photograph; the viewer only draws a patch whose flavor matches the
   * current view, so a photo slice never covers a mask being shown.
   * look is frameLook at the request: the flavor, overlay color and
   * strength, gamut warning. It must match too, so a red slice never
   * covers the black and white frame an Option-click just asked for. */
  roiPatch: {
    url: string;
    rect: [number, number, number, number];
    frame: [number, number];
    imageId: string;
    mask?: string | null;
    look: string;
  } | null;
  /** The viewer's stage in device pixels, as the screen draws it: the
   * settled preview renders at least this many pixels on its long side
   * (previewEdgeFor), so a Fit view on a Retina display is never a 2048
   * buffer blown up (2026-09-23: "people like to see as close as
   * possible to the final render result"). Null until measured.*/
  stagePx: { w: number; h: number } | null;
  /** full-frame dimensions per image, remembered from every patch that
   * reported them. The 1:1 canvas is sized from these, so returning to
   * 1:1 lands at true scale immediately instead of proxy scale with a
   * snap when the first slice arrives; they also make the status bar's
   * percent-of-actual and visible-resolution readouts possible at fit. */
  frameDims: Record<string, [number, number]>;
}


/** The open photograph's stack merge, when one is running. */
export function activeStackMerge(s: Pick<State, "activeImage" | "stackMerges">): StackMerge | null {
  return (s.activeImage && s.stackMerges[s.activeImage]) || null;
}

/** A stack merge in progress, as the viewer shows it. */
export interface StackMerge {
  jobId?: string;
  image: string;
  done: number;
  total: number;
  pass: number;
  passes: number;
  frames: number;
  missing: number;
  mode: string;
  full: boolean;
  elapsedMs: number;
}
export interface State {
  mode: Mode;
  browserOpen: boolean;
  ribbonOpen: boolean;
  images: ImageEntry[];
  activeImage: string;
  nodes: NodeCard[];
  wires: Wire[];
  /** user-laid-out backdrops for the graph canvas */
  backdrops: Backdrop[];
  /** Bumped whenever nodes or wires change in a way the engine can see.
   *
   * The render pump used to key on the nodes array's identity, but a
   * graph-canvas drag, a rename, a tint or a note replaces that array
   * too, so moving a node one pixel cost a full engine re-render of a
   * 24-megapixel frame. The pump keys on this counter instead. The
   * reducer bumps it for anything that touches nodes or wires EXCEPT the
   * list in RENDER_NEUTRAL, so a new render-affecting command gets the
   * safe behavior (a render it did not strictly need) by default. */
  renderVersion: number;
  /** The photograph whose saved graph is still being read from disk,
   * or null. Between a click and the read, the graph on hand is the
   * fresh template, and rendering it put the photograph's unedited
   * look on screen for a beat between the edited thumbnail and the
   * edited render. The render pump holds while this names the active
   * photograph; the load settles it on every path, found or not. */
  graphLoading: string | null;
  selection: string[];
  groupDialogOpen: boolean;
  /** the "Layers from File..." picker's offer (26.3 Phase 7 import):
   * the picked file's path, what it holds, and any note the picker
   * says out loud; null while the dialog is closed */
  fileLayersOffer: { path: string; choices: FileLayerChoice[]; note: string | null } | null;
  /** the "Image from Catalog" picker is open (Finish image layers,
   * 2026-09-30): pick a photograph and it becomes an image layer */
  catalogLayerPick: boolean;
  /** the image layer's size lock: typed sizes and handle drags keep the
   * picture's proportions, as Shift does for one drag */
  transformLock: boolean;
  presets: { name: string; meta: string; filter: string; isNew?: boolean }[];
  undoStack: Snapshot[];
  redoStack: Snapshot[];
  viewerZoom: "fit" | "100";
  /** Navigation-only state: what moves the picture on screen without
   * changing a pixel or anything a panel draws. One sub-object so the
   * memo comparator (viewmemo.ts) skips it wholesale, a read of it is
   * one greppable token (state.view), and a field added here is skipped
   * automatically. Only the Viewer may read it; everything else is
   * memoized against it and would go silently stale. */
  view: ViewState;
  /** node editor viewport: pan in screen px, zoom multiplier */
  graphView: { x: number; y: number; zoom: number };
  /** the view held before entering a group, restored on the way out */
  graphViewBack: { x: number; y: number; zoom: number } | null;
  compare: boolean;
  /** what "before" means in every comparison (Before/After and all the
   * split modes): null is the untouched original; a take id puts that
   * take's rendered graph on the before side instead
   * ("switch up Before/After with take numbers. Take 2 / Current
   * Take"). Cleared on photo switch: takes belong to their photo.*/
  compareTake: string | null;
  splitOn: boolean;
  /** how Split carves the frame (the owner's "Advanced split
   * views"): the classic bar, now rotatable; a checkerboard grid;
   * or a radial slice. All view state, like splitPos: a way of
   * LOOKING at the comparison, never part of the photograph.*/
  split: SplitConfig;
  openedGroup: string | null;
  /** Thumbnails picked out in the ribbon, for actions that act on
   * several photographs at once: stacking, and panorama after it. The
   * active image is always a member, so "the selection" and "the photo
   * you are looking at" never disagree. */
  imageSelection: string[];
  /** active viewer tool */
  tool:
    | "none"
    | "crop"
    | "brush"
    | "pick"
    | "straighten"
    // Grid Warp's handles over the frame: the same modal contract as
    // crop and straighten.
    | "gridwarp"
    // Shape Warp's shapes over the frame: Position places a shape, Warp
    // moves the pixels under it. Same modal contract as Grid Warp.
    | "shapewarp"
    | "select"
    // The smart-mask click tool: click adds, ALT-click subtracts, each
    // click refining the same mask.
    | "smart"
    // The object-mask pick tool: a click names the object under it out
    // of the file's Cryptomatte and adds it to the mask, ALT-click
    // takes it out.
    | "object"
    // The Finish fill brush (P3): strokes describe the hole, the model
    // fills it. The retouch graph's own repair upgrade.
    | "fill"
    // Move, scale and rotate a Finish layer; and its complement, which
    // drags one corner at a time. Two tools over one quad of four
    // corners: see the note in overlays.tsx for why they are not one
    // tool with a modifier and not two separate transforms.
    | "transform"
    | "warp"
    | "polish"
    | "paint"
    | "erase"
    | "clone"
    | "heal"
    | "dodge"
    | "burn"
    | "blur"
    | "blend";
  /** the art layer (its blend node id) paint strokes land on */
  artActive: string | null;
  /** the gradient layer whose stops the Finish panel has drilled into,
   * or null for the layer stack. The owner rejected a popup for this:
   * "what advanced does is a drill down. It uses the right panel
   * space but the layers are hidden."*/
  artGradientEdit: string | null;
  /** every selected stack row (blend ids), for grouping; artActive is
   * always the last of these */
  artSelected: string[];
  /** the paint tool's current color, "#rrggbb" */
  paintColor: string;
  /** where clone and heal read from: the ALT-picked anchor until the
   * first stroke locks an offset, then the offset travels with the
   * brush the way an aligned clone stamp does */
  cloneSource: [number, number] | null;
  cloneOffset: [number, number] | null;
  /** how hard one dodge or burn stroke pushes, 1..100. Its own setting
   * rather than the brush flow paint shares: dodging wants a tenth of
   * what painting wants, and swapping tools should not mean resetting
   * a slider every time. */
  dodgeStrength: number;
  /** range-mask eyedropper: how a sample folds into the current window */
  pickMode: PickMode;
  /** range-mask eyedropper: which property the sample drives */
  pickTarget: PickTarget;
  /** range-mask eyedropper: the mask node a sample folds into, named by
   * the Pick button that armed it (Develop's layer block or the node's
   * own seat in Graph). Null means the active Develop layer's mask, the
   * menu and shortcut's target. See pickMaskNode. */
  pickNode: string | null;
  /** curve eyedropper: armed for one curve node and channel, or off.
   * While armed the viewer samples under the cursor and the editor
   * shows a ghost point riding the curve at the sampled value. */
  curvePick: { nodeId: string; channel: CurveChannel } | null;
  /** how the Curves editors show the channels on this photograph: the
   * panel's RGB | CMY toggle, or null to follow Preferences
   * (prefs.curveMode). A way of looking, not an edit: never in the graph,
   * never an undo step, and back to the preference on the next photograph
   * (TOOL_SESSION_DEFAULTS). Read through curveModeOf.*/
  curveMode: CurveMode | null;
  /** which Color Set's eyedropper is armed (the set's number), or
   * null. While armed the viewer samples the set's INPUT under the
   * cursor: click centers the band, SHIFT-click grows it to include
   * the pick, ALT/CMD-click shrinks it to exclude the pick. */
  csetDropper: number | null;
  /** the OkLab hue under the cursor while the Color Set dropper is
   * armed, which the set's hue strip draws as a ghost, or null. Only
   * the ghost: the band itself moves only while the button is held. */
  csetHoverHue: number | null;
  /** which Color Set's selection is being shown as a black/white
   * overlay (the per-set eye toggle), or null. Only the eye: the
   * armed dropper used to force the overlay on by itself, until the
   * requested behavior changed ("It should not default to mask on, only
   * when the mask button is toggled on while using the picker").*/
  csetMaskView: number | null;
  /** Stage probe: the node whose OUTPUT the viewer is showing instead
   * of the developed photograph, or null. Transient view state,
   * cleared on photo switch; the scopes follow automatically because
   * they read the frame on screen.*/
  probeNode: string | null;
  /** Branch A/B (proposal §5): two graph points compared in the viewer
   * split. `b` null means A is armed and the next pick completes the
   * pair. View state like the probe, so no undo history. */
  abCompare: { a: string; b: string | null } | null;
  /** The color harmony aid (proposal §3.6): the wheels pull softly
   * toward the family while it is on. An aid, not an edit: it shapes
   * where a GESTURE lands, so it carries no undo history of its own;
   * the landed value does, like any wheel move. */
  harmony: Harmony;
  /** Gamut warning view: the frame dimmed to gray with unshowable
   * pixels marked, red for a hue outside the working gamut, white
   * for the encode clip. A viewing mode like compare, so it survives
   * a photo switch.*/
  gamutView: boolean;
  /** Scopes read the selected region only ("selection based
   * spectrums... To display histogram, RGB parade, waveform, etc data
   * based on a selected region only"). A viewing mode, no undo; with
   * no live selection the scopes read the whole frame as ever.*/
  spectrumSel: boolean;
  /** Images whose reset still owes its side effects: the on-disk graph
   * deletion, the catalog badge drop, and the thumbnail re-render. A
   * queue rather than a callback, so every door that dispatches
   * reset_image_edits (Edit menu, hotkey, thumbnail context menu) gets
   * the same aftermath from one place; the ResetAftermath component
   * drains it. "Resetting edits does not update the
   * thumbnails."*/
  resetPending: string[];
  /** Photographs other than the active one whose reset an Undo took
   * back after the archive was already asked for: each is owed its
   * archived edits written back, its catalog badge, and its thumbnail
   *. Drained by ResetAftermath, the reset's own drain.*/
  restorePending: string[];
  /** Counts the Subject/Sky menu picks, so the smart overlay's retry
   * latch can tell a deliberate re-pick from the state a failed
   * compute leaves behind. UI state on purpose, and NOT a node param:
   * an ask is not part of the recipe, must not ride the graph or the
   * session, and above all must not ride the undo stack, where
   * rewinding it would make undo fire a model compute. */
  smartAsk: number;
  /** Relight's in-image zone picker: the tone EQ node it is armed
   * for, or null. Click a brightness on the photo, drag vertically,
   * and that zone re-exposes ON THAT NODE, so arming it from a second
   * instance in the graph edits the right one. */
  toneEqPick: string | null;
  /** the white-balance eyedropper: the Color node it is armed for, or
   * null. While armed the viewer takes one sample and neutralizes it */
  wbPick: string | null;
  /** Recolor's picker, and which routing cell a pick lands in: shared
   * state so the panel, the window, and the viewer agree. */
  recolorPick: string | null;
  /** Recolor's Match picker: the node it is armed for, and the source color once
   * the first click has landed*/
  recolorMatch: {
    id: string;
    source: { hue: number; chroma: number; luma: number; x: number; y: number } | null;
  } | null;
  recolorCell: import("./eqcurve").RecolorCellId;
  /** Recolor's eyedropper: the active cell's axis value under the viewer
   * cursor while it is armed, ridden as a ghost point (the Black & White
   * Hue curve's, brought here at the owner's word 2026-09-14).*/
  recolorHoverX: number | null;
  /** Relight's eyedropper: the tone under the viewer cursor, in the
   * curve's EV (Range shift included), ridden as a ghost point while it
   * is armed, as the other curve eyedroppers do (2026-10-08: "I am
   * not getting the ghost on the relight curve with the eyedropper"). */
  toneEqHoverX: number | null;
  /** The black and white Separate picker: armed, and the first color once its click has landed.
   * The conversion is the one main-chain node, so no id rides along. */
  bwSeparate: {
    source: { hue: number; chroma: number; lightness?: number; gray: number; x: number; y: number } | null;
  } | null;
  /** The hue curve's eyedropper (2026-09-14: "grabbing points and
   * moving them blindly"): armed, and the hue under the viewer cursor
   * while it is, which the editor rides as a ghost point.*/
  bwPick: boolean;
  bwHoverHue: number | null;
  /** The Zone System: the Zones eye (the frame posterized to its
   * eleven zones), the zone under the ruler cursor (that zone lit on
   * the frame), and the placement picker: the zone chosen on the
   * ruler, and the first spot once it has landed, for the second to
   * develop against.*/
  zonesView: boolean;
  zoneHover: number | null;
  zonePlace: { zone: number | null; first: { x: number; y: number; zone: number } | null } | null;
  /** The Zones fold in the Exposure section, closed until opened
   * (2026-09-14: "Zones should also be a collapsible sub section").
   * Session state.*/
  zonesOpen: boolean;
  /** the Color Tune's active band and its picker (the armed node); a
   * pick band means the click moves THAT custom band onto the new
   * color instead of making one */
  consoleBand: string;
  consolePick: string | null;
  consolePickBand: string | null;
  /** where the curve eyedropper's ghost point sits, 0..1 in the curve's
   * input domain, or null when the cursor is off the image */
  curveHoverX: number | null;
  /** brush radius as a fraction of the shorter image side */
  brushRadius: number;
  /** the tip the NEXT stroke is laid down with. A tool setting rather
   * than a node parameter, because it applies to what you are about to
   * paint and not to what is already painted. */
  brushTip: string;
  /** deleting a node reconnects its neighbors; mirrored from
   * UiSettings, SHIFT inverts per use */
  deleteHeals: boolean;
  /** the scripting bridge switch, mirrored from UiSettings */
  apiEnabled: boolean;
  /** how the next selection region gets drawn */
  selectFromCenter: boolean;
  selectAntialias: boolean;
  selectAutoClear: boolean;
  /** the smart click tools' prompt dots, mirrored from UiSettings */
  selectShowClicks: boolean;
  /** the tone profile new RAW graphs are born with (see UiSettings) */
  rawProfile: "linear" | "standard" | "film";
  /** the capture sharpening new RAW graphs are born with (see UiSettings) */
  rawSharpening: RawSharpening;
  /** X swaps the mask brush's polarity: paint-hides becomes
   * paint-reveals until pressed again, the layer-editor X reflex. ALT still
   * inverts momentarily relative to whichever way this points. */
  brushSwap: boolean;
  polishMode: string;
  polishPreview: string;
  /** which mode of the Transform slot the button is showing (ShapeMode).
   * Transform is the default: moving and scaling a layer is the
   * everyday reach, and pulling one corner out of square the
   * deliberate one. */
  shapeMode: ShapeMode;
  /** which half of the dodge/burn pair the button is showing */
  dodgeMode: "dodge" | "burn";
  /** which half of the clone/heal pair the button is showing. Heal is
   * the default: fixing a flaw is the everyday reach, copying pixels
   * wholesale the deliberate one. */
  repairMode: "clone" | "heal";
  /** which half of the blur/blend pair the button is showing. Blur is
   * the default: softening what is under the brush is the everyday
   * reach, averaging two colors into each other the deliberate one. */
  blurMode: "blur" | "blend";
  /** which of Pixel, Gradient and Fill the Finish toolbar's split
   * button makes (UiSettings.artContentKind) */
  artContentKind: ArtContentKind;
  /** selecting a Finish layer opens its settings
   * (UiSettings.layerExpandOnSelect) */
  layerExpandOnSelect: boolean;
  selectMethod: string;
  /** what it does to what is already selected */
  selectOp: SelectOp;
  /** color distance for the wand, and the snap radius for the magnetic
   * and edge-paint methods, both 0..1 */
  selectTolerance: number;
  /** how faint an edge the magnetic trace snaps to, 0 bold-only to 1 wisps */
  selectMagnetSense: number;
  /** smoothing stamped onto the next freehand path */
  selectSmooth: number;
  /** radius of the color brush, as a fraction of the short side */
  selectBrushRadius: number;
  /** the polish pass is open: the right panel is showing its controls
   * and the viewer is showing the selection rather than the photograph
   * alone */
  polishOpen: boolean;
  polishView: string;
  /** radius of the polish brush, as a fraction of the short side */
  polishRadius: number;
  /** whether the polish brush adds to the selection or takes away */
  polishAdd: boolean;
  /** The last Polish pass that ended by Apply (or by picking up another
   * tool, which keeps the refinement too), for the full-resolution matte
   * (PolishFullRunner): which photograph and selection, and a count so
   * two Applies on one selection are two asks. Cancel leaves it alone.
   * Session state, never saved. */
  matteApply: { image: string; node: string; seq: number } | null;
  /** A Finish layer's live mask being polished (2026-10-02: "the polish
   * tool from the menu doesn't recognize the smart selection"). The
   * mask's render is loaded into the document selection, Polish refines
   * it there, and Apply puts the result back on the layer as a pixel
   * mask (polish_layer_mask_land), leaving the document selection as it
   * was; Cancel puts the document selection back and the layer never
   * changed. A Finish layer's mask never becomes a live selection node.
   * Session state, never saved.*/
  polishLayer: PolishLayerPass | null;
  brushTextureScale: number;
  /** which way the grain runs on the next stroke, in degrees */
  brushTextureAngle: number;
  /** edge falloff of the next dab: 1 is a hard edge, 0 is all falloff */
  brushHardness: number;
  /** strength of the next dab, 1 being full white */
  brushFlow: number;
  brushTextureDepth: number;
  /** whether strokes already painted are tinted over the photograph.
   *
   * "the paint overlay is distracting when a brush is
   * applied... as we paint on it should not be the white texture on top
   * of the image because then I can't see the edits." Off by default:
   * the point of a mask is the adjustment it is driving, and a colored
   * film over the whole thing hides exactly what you are trying to
   * judge.*/
  /** the dab under the cursor; the ring always stays. "I
   * may not always want to see it."*/
  brushShowDab: boolean;
  /** Whether a repair keeps its distance from the cursor (aligned, the
   * way a layer editor means it) or keeps reading from the point that was
   * picked. Aligned is set by the first stroke after a source is chosen
   * and holds until the next one. */
  brushCloneAligned: boolean;
  /** How opaque the mask wash gets at full paint, 0.1 to 0.5. The wash is
   * a guide over the photograph, so it has to read without hiding what it
   * is guiding you around. */
  brushOverlayStrength: number;
  /** How far out of focus the blur brush takes what is under it, as a
   * fraction of the brush radius. Separate from opacity on purpose: one
   * says how soft the result is, the other how much of it lands, and a
   * light pass of a heavy blur is not the same picture as a heavy pass of
   * a light one. */
  brushBlurStrength: number;
  /** Whether a second pass of the blur brush softens further, or stops
   * at the strongest pass. Both are wanted: building works a spot up
   * gradually, not building evens a background out without the overlaps
   * showing. */
  brushBlurBuild: boolean;
  /** Clone, heal, blur and blend: sample this layer's own pixels rather
   * than the composite below it (the owner's ask, and the only way to
   * work on a layer inside a group, whose input is the group's empty
   * canvas).*/
  brushSampleLayer: boolean;
  /** crop constraint: target width/height pixel ratio, or null for free */
  cropAspect: number | null;
  /** user-resizable panel sizes in px */
  panelSizes: {
    library: number;
    right: number;
    graphViewer: number;
    ribbon: number;
    /** height of the upper pane once the right panel is split */
    rightSplit: number;
    /** height of the automatic selection split; zero means default */
    selectionSplit: number;
    /** height of the folder TREE box in the library panel.
     *
     * "The position of Collections should not move based on
     * the size of TREE above it." So the tree gets a height of its own
     * and scrolls inside it, rather than growing a row at a time and
     * shoving everything below it down the panel.*/
    libraryTree: number;
  };
  /** the selection split folded to its bar, size remembered for the
   * way back */
  selectionSplitMin: boolean;
  /** the selection split closed by its door: hidden until the select
   * tool is armed or a layer is clicked, the selection itself untouched.
   * Session state, never part of the saved layout. */
  selectionSplitClosed: boolean;
  /** Which Adjustments sections the panel lists: every one, the pinned
   * ones, or the ones switched on for this photograph. */
  sectionFilter: SectionFilter;
  /** thumbnails, or one row per photograph with its details.
   *
   * "We also need to be able to switch between thumbnail
   * and list view."*/
  ribbonView: "thumbs" | "list";
  /** the thumbnail panel has taken the whole window.
   *
   * "I would like to be able to maximize/expand the
   * thumbnail panel. This would hide the viewport, but it would reveal
   * metadata sorted by columns for each image."*/
  ribbonExpanded: boolean;
  /** which metadata column the expanded table is sorted by, and which way */
  ribbonSort: { column: string; desc: boolean };
  /** the expanded catalog grid's tile size in px ("there
   * should be a slider to control thumbnail size"); persisted as a ui
   * pref*/
  expandedTile: number;
  /** active Develop layer: an adjustment-node id, or null for the base */
  activeLayer: string | null;
  /** viewport shows the active layer's mask as black/white when true */
  maskView: boolean;
  /** The farness plane as the frame (session-only, like maskView). */
  depthView: boolean;
  /** The separation view: the black and white conversion's gray
   * collisions painted over the dimmed frame (session-only). */
  collisionView: boolean;
  /** How far apart two grays may be and still collide, in percent of
   * the tonal range either side (session-only; the engine's bins are
   * about three percent, its rest). */
  collisionTolerance: number;
  /** bumped by Recompute in the Depth Map section: the runner's
   * watermark carries it, so the plane is read again from scratch */
  depthEpoch: number;
  /** the photograph a Recompute is pending for: a want of its own,
   * cleared when the runner answers it */
  depthRecompute: string | null;
  /** What the photograph's own file carries beyond pixels (an OpenEXR:
   * a depth pass the Depth Map reads instead of the model, Cryptomatte
   * layers the Object Mask picks from, plain matte channels), or null
   * for a photograph that is a plain image. Asked once per photograph;
   * `image` says which it answers for. */
  filePasses: { image: string; passes: FilePasses | null } | null;
  /** Halation's isolated-regions view: the gated source as the frame */
  halationView: boolean;
  /** The Depth Lighting rig's viewport handles are up. */
  keyLightPick: boolean;
  /** The Color Checker's chart overlay is up, waiting on quad drags
   * and patch clicks in the viewer. */
  chartPlace: boolean;
  /** Which light in the rig the panel's controls steer. */
  keyLightSel: number | null;
  /** One click in the viewer sets the Depth of Field focus. */
  dofPick: boolean;
  /** The Help menu's control search is open. */
  findControlOpen: boolean;
  /** The control the search just landed on, wearing the gold outline. */
  controlFlash: { section: string; param: string | null } | null;
  /** the mask view's flavor: black/white replacement, or the
   * photograph tinted red through the mask (the owner's ask after the
   * first smart-selection test). View state, no undo.*/
  maskRed: boolean;
  /** catalog folders, most recently opened first */
  folders: FolderEntry[];
  /** navigation tree rooted at the last folder opened from recents/OPEN;
   * descending keeps parents and siblings visible */
  folderTree: TreeNode | null;
  /** path of the folder whose images are in the ribbon, for highlighting */
  activeFolderPath: string | null;
  /** catalog collections with member counts */
  collections: CollectionEntry[];
  /** folder paths containing at least one edited image (edited badges) */
  editedFolders: string[];
  /** folders holding at least one hidden image, so the tree offers
   * Recover Hidden only where it would do something */
  foldersWithHidden: string[];
  /** Folders with a `.trash` beside them. The tree badges these and
   * the folder menu offers to open the trash in the system browser;
   * both read one list so they cannot disagree. */
  foldersWithTrash: string[];
  /** Trashed photographs whose file is no longer in `.trash`, and ones
   * on a drive that is not connected (not checked): Edit > Forget
   * Missing Trashed Photos is grayed at zero and says why. */
  missingTrashed: { count: number; skipped: number };
  /** thumbnail generation progress for the ribbon bar, null when idle */
  thumbProgress: { done: number; total: number } | null;
  /** the update prompt lifted the splash early; no boot step may bring it back */
  splashDismissed: boolean;
  /** geometry as it was when the crop or straighten tool was armed, so
   * escape can put it back. Escape means cancel; committing is what
   * leaving the tool any other way does. */
  /** What Escape puts back: crop/straighten snapshot params, polish
   * snapshots the selection's strokes. Leaving a tool any other way is
   * a commit and drops the snapshot. */
  toolRevert: {
    id: string;
    enabled?: boolean;
    params?: Record<string, number>;
    strokes?: StrokeData[];
    /** the node did not exist when the tool was armed: cancel removes
     * what the tool built rather than putting identity params on it */
    fresh?: boolean;
    /** Grid Warp's mesh as armed, beside its counts in params */
    textParams?: Record<string, string>;
    /** a Finish layer's blend, which lives inside the Finish group:
     * Transform and Warp arm on it and Escape puts its corners back */
    art?: boolean;
  } | null;
  /** The Grid Warp tool's own state: which handles are picked, how far
   * a drag reaches past them, and how the reach is shown. View state,
   * not the photograph's: the mesh itself lives on the node. */
  gridWarp: GridWarpUi;
  /** The color of the lines every tool draws over the photograph
   * (Grid Warp's grid, Shape Warp's rings, the Radial layer's gizmo):
   * one choice for all of them, automatic until set. */
  lineColor: LineColorUi;
  /** How thick the lines every overlay draws are, per photograph: image
   * id to pixels, for the photographs whose Thickness row was set
   * (absent follows prefs.shapeLineWidth). A view setting like the
   * preference, so no node carries it and no undo step records it
   * (2026-09-28: "Something like line thickness should not be tied to a
   * specific node"); GraphPersistence keeps it in the photograph's saved
   * file as `lineWidth` and puts it back on the read.*/
  photoLineWidth: Record<string, number>;
  /** The Shape Warp tool's own state: which shape is in hand and
   * whether it is being placed or used. View state; the shapes live on
   * the node. */
  shapeWarp: ShapeWarpUi;
  /** Which warp the Grid and Shape Warp tools edit while armed: null is
   * the photograph's own Develop warp, an id is a Finish warp node (a
   * Warp layer's content, or an image layer's own warp), both edited by
   * the same gizmos (2026-09-30: "build both, A for image layers and B
   * for the photo"). Set by arming the tool, cleared by putting it down.*/
  warpTarget: string | null;
  /** which tab the right panel is showing. In state rather than in the
   * panel, because a key has to be able to move between them. */
  panelTab: PanelTab;
  /** tabs that have been moved to a second pane below the first.
   *
   * "I should be able to right click on a tab and have the
   * option to Split the right panel vertically and move the second tab
   * down to its own view... do not split that panel more than twice."
   *
   * Two panes, so one list is the whole model: a tab is down here or it is
   * up there. Empty means there is no split, which is why there is no
   * separate flag to fall out of step with it.
   */
  panelBottom: PanelTab[];
  /** which tab the lower pane is showing */
  panelTabBottom: PanelTab;
  /** the spectrums are in their own window rather than in the panel */
  spectrumsPoppedOut: boolean;
  /** the Takes review window is open (notes, ratings, compare, at the
   * Preferences dialog's size); the dropdown stays the quick switcher */
  takesPoppedOut: boolean;
  /** Which adjustment tools are out in windows of their own (Color Bend
   * style); the panel folds each to a bar while its window is out. */
  toolPopouts: { wheels: boolean; curves: boolean; toneeq: boolean; recolor: boolean; colorconsole: boolean };
  /** the color wheel is in its own window rather than in the panel */
  bendPoppedOut: boolean;
  /** the preferences dialog is open */
  prefsOpen: boolean;
  /** The setting the dialog opens on when something outside asked for
   * one (the panel's hidden-sections chip); the dialog clears it once
   * it has landed. */
  prefsLanding: string | null;
  /** The node the graph view should open its inline rename on, set by
   * the N key and consumed by the view. */
  renameRequest: string | null;
  /** the graph's find-by-name box, opened with / */
  graphSearchOpen: boolean;
  /** a transient line for the user: why a command refused, mostly. A
   * hotkey that does nothing and does not say why reads as broken. */
  notice: { text: string; at: number } | null;
  /** Help > User Documentation */
  docsOpen: boolean;
  /** A specific page the viewer should open on, e.g. the scripting
   * reference from Help > Scripting; null means the first chapter. */
  docsFile: string | null;
  /** Which Select-menu dialog is up, if any. One field rather than one
   * flag per dialog: they are mutually exclusive by nature, and a
   * single field cannot get into the state where two are open. */
  selectDialog: null | {
    /** "param" drives one of the mask's own polish params; "range"
     * builds a region out of a channel and two limits. Smooth, Feather
     * and Resize are the same dialog with a different param, because
     * they ARE the same thing: one number on the mask, already in the
     * engine, already undoable. */
    kind: "param" | "range";
    /** Depth view before the range dialog opened. */
    depthViewBefore?: boolean;
    /** param dialogs: which one */
    param?: "smooth" | "feather" | "grow";
    /** range dialogs: which histogram to draw and what to offer */
    mode?: "luma" | "color" | "contrast" | "depth";
    /** range dialogs: the channel being read */
    channel?: string;
    /** range dialogs: index of the region the sliders steer, so what is
     * on screen while the dialog is open is the answer rather than a
     * preview of it */
    index?: number;
    /** what to put back if the dialog is canceled: the param's old
     * value, or the whole region list for a range */
    restore?: number;
    restoreRegions?: SelectRegion[];
    /** range dialogs: the mask the range went on when it is not the
     * selection (a live Smart or Object mask, selectShapeTarget) */
    maskId?: string;
  };
  catalogsOpen: boolean;
  /** The Presets tab's collapsed folders, by `b|Category` and `u|Category`
   * key; null until the first listing seeds the built-in shelf closed.
   * Session state, not a preference: it lives here so the tab can be left
   * and come back the way it was (2026-09-07: "keep having to expand the
   * presets"), and it is not saved past the app.*/
  presetFolds: string[] | null;
  /** the destructive-action confirmation currently on screen */
  confirm: Confirm | null;
  /** The section look previewed on the photograph (src/sectionlooks.ts),
   * or null. A render-only override: the viewer's render requests carry
   * the look while the looks menu points at it (lookPreviewState), while
   * the graph, the saved file, undo, the catalog, thumbnails, export and
   * bake never see it. View state, never saved, cleared by any command
   * that moves the graph, the photograph or the layer. */
  lookPreview: string | null;
  /** the merges waiting on a format before they are baked, or null */
  bake: { ids: string[]; running: boolean } | null;
  /** the format they will be baked to.
   *
   * Outside `bake` so it outlives the dialog. Baking a folder of merges
   * one at a time to the same format is the normal way this gets used,
   * and being asked again from scratch every time would be its own small
   * insult. */
  bakeFormat: string;
  /** user preferences, persisted in the catalog */
  prefs: Prefs;
  /** node types added recently, most recent first. Drives the palette's
   * shortlist, which is what makes adding the same three nodes over and
   * over quick. */
  recentNodes: string[];
  /** The node recipes this person saved (Save as Recipe), stored in the
   * catalog beside the lens and export presets; the built-ins are not
   * here, they ride in noderecipes.ts. */
  userRecipes: NodeRecipe[];
  /** Recipe edits waiting for the recipes folder (2026-10-01): Save as
   * Recipe, Rename and Remove change the list here at once, and the
   * app writes, renames or moves the file (recipefiles.ts). Never
   * saved. */
  recipeOps: RecipeOp[];
  /** the node palette is open, with the point it should drop a node at */
  /** the ADD palette, where the node lands, and the category it opens
   * narrowed to when a legend glyph opened it. No spot when nothing
   * pointed at one (the toolbar, its key, the Node menu): the card then
   * goes right of the selected one, stepped free (2026-09-28).*/
  palette: { x?: number; y?: number; cat?: Category } | null;
  /** keyboard navigation of the develop controls, null when off */
  keynav: NavState | null;
  /** the export panel is showing instead of Adjustments */
  exportOpen: boolean;
  /** The room the main window's row has (its width in CSS px and the
   * app zoom in force), for fitting the panels into it (layoutfit.ts).
   * Null until the window reports it, and in every window that does
   * not lay out the panels: then nothing is fitted. Never saved. */
  layoutRoom: { width: number; zoom: number } | null;
  /** Panels the user opened while the fit had them folded: they stay
   * open on a small window and the others give way. Cleared when the
   * window has room for everything again. Never saved. */
  layoutPinned: FoldablePanel[];
  /** the batch groups (tabs in the Export panel) and which is active */
  exportQueue: { groups: ExportGroup[]; active: number };
  /** LIVE shares: re-render into the running share as edits settle.
   * Off by default; re-rendering while editing is a cost to choose. */
  serveLive: boolean;
  /** a panorama being stitched, null when nothing is. Stitching takes
   * long enough that without this the app looks hung. */
  stitch: {
    image: string;
    fraction: number;
    stage: string;
    error: string | null;
    /** how many frames, the full-size stitch or the preview's, and how
     * long it has run, for the card's title and time left */
    frames?: number;
    full?: boolean;
    elapsedMs?: number;
    /** the job Cancel stitch names, and whether it ended canceled */
    jobId?: string;
    canceled?: boolean;
  } | null;
  /** panoramas the user canceled (Cancel stitch), by photograph: not
   * asked for again until Stitch again or a changed recipe, the stacks'
   * rule (stackCanceled) */
  stitchCanceled: Record<string, true>;
  /** the photograph Bake to Image is baking right now, if any: while
   * its stack merges, the bake's dialog shows the merge's card and the
   * viewer's own copy of it steps aside */
  baking: string | null;
  /** stacks merging right now, by photograph: a thousand
   * frames is a minute or more, and the canvas says how far the open
   * photograph's merge has got instead of looking frozen. Keyed, since
   * a library thumbnail can be merging one stack while another is on
   * screen. */
  stackMerges: Record<string, StackMerge>;
  /** Stacks whose merge the user canceled (Cancel merge), by image id:
   * the viewer does not ask for them again and shows Merge again
   * instead (2026-10-07: "canceling a merge does not cancel. it keeps
   * restarting"). A merge starting for one clears it.*/
  stackCanceled: Record<string, true>;
  /** collection currently shown in the ribbon, or null for a folder */
  activeCollection: number | null;
  /** library header label: folder or collection name */
  libraryLabel: string;
  /** ribbon filter: minimum stars (0 = off) */
  filterStars: number;
  /** ribbon filter: show picks only */
  filterPicksOnly: boolean;
  /** ribbon filter: hide rejected images */
  filterHideRejected: boolean;
  /** The flag button's modifier state (2026-09-15): inverts the
   * context it is in, so picks only becomes picks hidden and rejects
   * hidden becomes rejects only. Meaningless, and kept false, when
   * neither context is on.*/
  filterFlagInverted: boolean;
  /** keyword filter: only photos carrying this tag, resolved against
   * the catalog when set (ids fetched once, then filtering is plain
   * set membership like every other filter here) */
  tagFilter: { term: string; ids: string[] } | null;
  /** the expanded thumbnail panel's shape: the owner's grid of
   * thumbnails, or the metadata table it always had*/
  expandedView: "grid" | "table";
  /** Catalog Compare: a picked set reviewed four at a time. `start` is
   * the window's left edge; Arrow moves it by four, SHIFT+Arrow by two.
   * (`compare` above is the viewer's before/after, a different thing.) */
  catalogCompare: { ids: string[]; start: number } | null;
  /** Copy Edits: a whole-graph snapshot of one photo, waiting to be
   * pasted onto others. Survives switching photos, which is the point:
   * copy here, click there, paste. */
  editClipboard: {
    nodes: NodeCard[];
    wires: Wire[];
    backdrops: Backdrop[];
    sourceId: string;
    sourceName: string;
  } | null;
  /** Curves' own clipboard: one curve as it was SHOWN when copied (a C
   * view copies the red curve flipped), pasted through the view it
   * lands on. Kept apart from Recolor's, whose curves have another
   * layout, so neither can paste into the other. Session only: it
   * survives a photo switch (copy here, paste there) and is never saved
   * or undone.*/
  curveClipboard: CurveClip | null;
  /** Recolor's curve clipboard: an ADJUST curve and the BY axis it was
   * drawn over; it pastes only onto a curve over the same BY.*/
  recolorClipboard: RecolorClip | null;
  /** Quad edit: up to four photos edited together. The driver's graph
   * is the live one (state.nodes); every change to it is re-applied to
   * each unpinned member's own graph as a RELATIVE move, so a photo
   * balanced up before the batch keeps its head start. ALT-click pins
   * a pane out of the deltas. Not offered in Graph mode. */
  quadEdit: { ids: string[]; driver: string; pinned: string[] } | null;
  /** Linked photographs pinned out of their link for this session: an
   * edit passes them by, the quad's Alt-click for links. */
  linkPinned: string[];
  /** Linked members whose stashed graphs took a mirrored edit and are
   * owed a write to disk and a fresh thumbnail. */
  linkDirty: string[];
  /** Compact changes waiting for the member's saved graph, in edit order. */
  linkPending?: Record<string, PendingLinkEdit[]>;
  /** The active photograph's overrides inside its link: the nodes
   * ("node:<id>") and params ("param:<id>|<param>") that keep their own
   * values while the rest of the link's edits land. Saved with the
   * photograph's graph, so they travel with its edits.*/
  linkOverrides: string[];
  /** The non-driver members' graphs while quad editing, kept in state
   * so the reducer can apply deltas synchronously. Written back to the
   * graphs stash (and to disk, by the app) when quad ends. */
  quadGraphs: Record<
    string,
    { nodes: NodeCard[]; wires: Wire[]; backdrops: Backdrop[] }
  >;
  /** ribbon filter: name text, empty = off. Substring match, or a
   * wildcard pattern when it contains * or ? (never regex: nobody
   * should need to know what an anchor is to find a photograph). */
  filterName: string;
  /** The shot-date range, each end a canonical YYYY[-MM[-DD]] or empty
   * for no bound, inclusive of the unit typed (datefilter.ts). */
  filterDateFrom: string;
  filterDateTo: string;
  /** The day each photograph was taken, YYYY-MM-DD, or null when its
   * file says nothing, read from the catalog on demand by the shot-date
   * runner while a date filter is set; absent means not read yet. */
  shotDates: Record<string, string | null>;
  /** Show only stacks. Once a folder holds a few merges they are lost
   * among hundreds of frames, and the name is the only thing that
   * distinguishes them. */
  filterStacksOnly: boolean;
  /** "all", or only images that have been edited / never touched */
  filterEdited: "all" | "edited" | "unedited";
  /** take-count window. Min 1 and max at the cap means off; the cap
   * reads as "and up", since there is no ceiling on how many takes
   * someone might keep. */
  filterTakesMin: number;
  filterTakesMax: number;
  /** console window visibility */
  consoleOpen: boolean;
  /** the console's OS window is up: mirrored from the window's own
   * announcements so the layout can be saved and restored */
  consoleWindowOpen: boolean;
  /** The node graph is showing in its own window, so the main window
   * gives its graph pane over to a placeholder. */
  graphPoppedOut: boolean;
  /** Which window is showing the inspector while the graph is popped
   * out. Only ever one of them: the other collapses to a bar, so there
   * are never two sets of the same controls competing for attention. */
  inspectorHome: "main" | "graph";
  /** Where startup has got to, or null once the app is up (and in the
   * browser build, where there is no catalog to wait for). */
  boot: Boot | null;
  /** Bumped when the pixels change without the graph changing, which

   * happens when a stack's recipe is rewritten. The render effect

   * watches the graph, and nothing else would tell it to go again. */
  previewNonce: number;

  /** Canvas only: the graph is hidden so the photo stands alone. With
   * the graph gone, navigation falls back to the image. */
  canvasNodesHidden: boolean;
  /** Canvas only: the inspector is docked open down the right edge. A
   * selected node's settings go there instead of into a floating panel
   * that can run off the screen. */
  canvasInspectorOpen: boolean;
  /** active drag gesture key; edits matching it coalesce into one undo */
  gesture: string | null;
  /** Async picker ownership, not serialized into a saved graph. */
  gestureOwner?: number;
  pickerEpoch?: number;
  /** Per-arm disarm counts: a completed pick ends only the sessions that
   * aimed through ITS dropper, never an unrelated read still in flight. */
  pickerDisarms?: Record<string, number>;
  /** whether the active gesture already pushed its undo snapshot */
  gesturePushed: boolean;
  /** per-image graph store; the active image's graph lives in nodes/wires */
  graphs: Record<string, GraphSnapshot>;
  /** per-image takes: alternate edits the user wants to keep around */
  takes: Record<string, Take[]>;
  /** per-image active take id (implicit "take_1" when absent) */
  activeTakes: Record<string, string>;
  /** Develop categories the user has collapsed, by title.
   *
   * "all the categories have a little arrow next to them
   * indicating they can be collapsed, yet they can not be." They can now.
   * Stored as the closed ones rather than the open ones, so a category added
   * later starts open without anything having to know it exists.*/
  sectionsClosed: string[];
  /** takes the viewport is showing side by side, or empty for just the
   * active one.
   *
   * "Multi-view in the viewport. To be able to view up to 4
   * versions at once of an image." Ids rather than a count, because which
   * four is the question: comparing takes 1 and 4 is as likely as comparing
   * 1 and 2.*/
  multiTakes: string[];
  /** template for images edited for the first time */
  defaultGraph: { nodes: NodeCard[]; wires: Wire[] };
}

/** A Finish layer's mask being polished (State.polishLayer). `docSel` is
 * the document selection before the pass (null when there was none);
 * `depth`, `entry` and `redo` are the history to rebuild, so the whole
 * pass is one undo step after Apply and no step at all after Cancel;
 * `applying` counts the Apply being landed (0 while polishing). */
export interface PolishLayerPass {
  image: string;
  layerId: string;
  maskId: string;
  docSel: NodeCard | null;
  depth: number;
  entry: Snapshot;
  redo: Snapshot[];
  applying: number;
}

interface Snapshot {
  nodes: NodeCard[];
  wires: Wire[];
  backdrops: Backdrop[];
  /** human-readable description of the change this snapshot precedes */
  label: string;
  /** Set on the step a Reset Edits pushed: what the reset took from the
   * active photograph and from every other photograph it touched, so
   * Undo can put all of it back. */
  reset?: ResetUndo;
  /** Set on the redo step an undone reset leaves: the photographs to
   * reset again. */
  redoReset?: string[];
  /** Set on a step that belongs to the photograph it was made on alone
   * (OWN_PHOTO_STEPS): its undo and redo are not mirrored onto linked or
   * quad-edited photographs either. */
  ownPhoto?: true;
}

/** One photograph other than the active one, as a Reset Edits found it. */
interface ResetUndoPhoto {
  id: string;
  /** the thumbnail badge before the reset */
  edited: boolean;
  /** the stashed graph before the reset, or undefined for none */
  stash: GraphSnapshot | undefined;
  /** the stash right after the reset: the photograph is untouched since
   * while its stash is still this object */
  stashAfter: GraphSnapshot | undefined;
  quad: { nodes: NodeCard[]; wires: Wire[]; backdrops: Backdrop[] } | undefined;
  linkPending: PendingLinkEdit[] | undefined;
  linkPendingAfter: PendingLinkEdit[] | undefined;
  dirty: boolean;
  /** true when the reset archived the photograph's saved edits (went
   * through resetPending); false for a link member that only took the
   * factory values around its overrides */
  archived: boolean;
}

/** What Undo needs to take a Reset Edits back. */
interface ResetUndo {
  /** every photograph the command was asked to reset, for Redo */
  ids: string[];
  /** the active photograph's badge, overrides, and whether its saved
   * edits were archived; its graph is the snapshot itself */
  active: { edited: boolean; overrides: string[]; archived: boolean };
  others: ResetUndoPhoto[];
}

/** History label for an undoable command. */
function describe(cmd: Command, s: State): string {
  const name = (id: string) => s.nodes.find((n) => n.id === id)?.name ?? id;
  switch (cmd.type) {
    case "set_param":
      // The mask toggle reads as the menu item that made it.
      if (cmd.param === "mask_off") return cmd.value !== 0 ? "Disable Layer Mask" : "Enable Layer Mask";
      return `${name(cmd.id)}: ${cmd.param.replace(/_/g, " ")}`;
    case "set_params":
      return `${name(cmd.id)}: adjust`;
    case "set_curve":
      return `${name(cmd.id)}: ${cmd.channel.toUpperCase()} curve`;
    case "reset_curves":
      return `Reset curves`;
    case "set_curve_interp":
      return `Curves: ${cmd.interp}`;
    case "set_text_param":
      if (cmd.param === "rgb_mode") return `${name(cmd.id)}: ${cmd.value === "hue" ? "hue stable" : "classic"}`;
      return `${name(cmd.id)}: ${cmd.param.replace(/_/g, " ")}`;
    case "add_gamut_map_after":
      return "Add Gamut Map";
    case "add_stroke":
      return (cmd as any).stroke?.erase ? "Erase stroke" : "Brush stroke";
    case "clear_strokes":
      return "Clear strokes";
    case "move_node":
      return `Move ${name(cmd.id)}`;
    case "move_nodes":
      return `Move ${cmd.moves.length} nodes`;
    case "duplicate_nodes":
      return cmd.ids.length === 1 ? `Duplicate ${name(cmd.ids[0])}` : `Duplicate ${cmd.ids.length} nodes`;
    case "reset_node":
      return `Reset ${name(cmd.id)}`;
    case "publish_param":
      return `Publish ${cmd.label} on ${name(cmd.id)}`;
    case "unpublish_param":
      return `Unpublish ${cmd.label}`;
    case "rename_published":
      return `Rename ${cmd.label} to ${cmd.to}`;
    case "move_published":
      return `Reorder ${cmd.label}`;
    case "set_published_range":
      return `${cmd.label}: range`;
    case "set_enabled":
      return `${cmd.enabled ? "Enable" : "Disable"} ${name(cmd.id)}`;
    case "rename_node":
      return `Rename ${name(cmd.id)}`;
    case "delete_nodes":
      return `Delete ${cmd.ids.length} node${cmd.ids.length === 1 ? "" : "s"}`;
    case "add_node":
      return `Add ${cmd.node.name}`;
    case "connect":
      return "Connect nodes";
    case "disconnect":
      return "Disconnect";
    case "group_selection":
      return `Group: ${cmd.name}`;
    case "add_layer":
      return `Add ${cmd.maskType} layer`;
    case "duplicate_layer":
      return "Duplicate layer";
    case "rename_layer":
      return "Rename layer";
    case "set_layer_mask_export":
      return cmd.on ? "Export layer mask" : "Stop exporting layer mask";
    case "remove_layer":
      return "Remove layer";
    case "set_layer_enabled":
      return cmd.enabled ? "Show layer" : "Hide layer";
    case "apply_lens_character":
      return `Lens character: ${LENS_CHARACTERS.find((c) => c.id === cmd.id)?.name ?? cmd.id}`;
    case "apply_section_look": {
      const look = lookById(cmd.id);
      return look ? `${look.section}: ${look.name}` : cmd.id;
    }
    case "apply_calibration":
      return `Apply calibration "${cmd.name}"`;
    case "add_character_flare_light":
      return "Add a flaring light";
    case "set_color_sets_enabled":
      return cmd.on ? "Color Sets on" : "Color Sets off";
    case "remove_all_color_sets":
      return "Remove every Color Set";
    case "add_backdrop":
      return `Add backdrop`;
    case "delete_backdrop":
      return "Delete backdrop";
    case "move_backdrop":
      return "Move backdrop";
    case "resize_backdrop":
      return "Resize backdrop";
    case "rename_backdrop":
      return "Rename backdrop";
    case "cycle_backdrop_color":
      return "Recolor backdrop";
    case "arrange_nodes":
      return "Arrange nodes by stage";
    case "grid_warp_mesh":
      return "Grid Warp: drag";
    case "grid_warp_density":
      return `Grid Warp: ${cmd.cols} by ${cmd.rows}`;
    case "grid_warp_line":
      return cmd.remove !== undefined ? "Grid Warp: remove line" : "Grid Warp: add line";
    case "grid_warp_reset":
      return "Grid Warp: reset";
    case "shape_warp_add":
      return "Shape Warp: add shape";
    case "shape_warp_remove":
      return "Shape Warp: remove shape";
    case "shape_warp_rename":
      return "Shape Warp: rename shape";
    case "shape_warp_enable":
      return cmd.on ? "Shape Warp: enable shape" : "Shape Warp: disable shape";
    case "shape_warp_set":
      return "Shape Warp: drag";
    case "shape_warp_reset":
      return cmd.id ? "Shape Warp: reset shape" : "Shape Warp: reset";
    case "art_layer_warp":
      return cmd.on ? "Warp the picture" : "Remove the picture's warp";
    case "art_warp_kind":
      return cmd.kind === "grid" ? "Warp type: Grid" : "Warp type: Shapes";
    default:
      return cmd.type;
  }
}

export type Command =
  | { type: "set_mode"; mode: Mode }
  | { type: "toggle_browser" }
  | { type: "toggle_ribbon" }
  | { type: "select_image"; id: string }
  | { type: "load_images"; images: ImageEntry[] }
  /** tethered arrivals joining the open session: appended, never
   * replacing, and already-known ids are left alone*/
  | { type: "append_images"; images: ImageEntry[] }
  | { type: "apply_merged_defaults" }
  | { type: "apply_profile_defaults" }
  | { type: "apply_rendered_bypass" }
  /** A Color Checker fit saved before the order fix (2026-09-20) has its
   * matrix re-expressed for the graph's order, exactly, and its report
   * stamped; nothing to undo, a correction is not an edit. */
  | { type: "convert_legacy_fits" }
  | { type: "move_curves_late" }
  | { type: "move_levels_late" }
  | { type: "split_curve_faces" }
  | { type: "toggle_export" }
  | { type: "export_queue_add"; ids: string[] }
  | { type: "export_queue_remove"; id: string }
  | { type: "export_queue_move"; from: number; to: number }
  | { type: "export_group_new" }
  | { type: "export_group_remove"; index: number }
  | { type: "export_group_rename"; index: number; name: string }
  | { type: "export_group_select"; index: number }
  | { type: "export_group_settings"; settings: Partial<ExportSettings> }
  | { type: "export_group_folder"; folder: string | null }
  | { type: "export_queue_load"; queue: State["exportQueue"] }
  | { type: "toggle_serve_live" }
  | { type: "set_tag_filter"; filter: { term: string; ids: string[] } | null }
  | { type: "set_expanded_view"; view: "grid" | "table" }
  | { type: "open_compare"; ids: string[] }
  | { type: "close_compare" }
  | { type: "compare_step"; by: number }
  | { type: "copy_edits" }
  | {
      type: "set_edit_clipboard";
      clipboard: NonNullable<State["editClipboard"]> | null;
    }
  | { type: "paste_edits" }
  | { type: "mark_edited"; id: string }
  | {
      type: "open_quad_edit";
      ids: string[];
      graphs: Record<
        string,
        { nodes: NodeCard[]; wires: Wire[]; backdrops?: Backdrop[] }
      >;
    }
  | { type: "close_quad_edit" }
  | { type: "quad_toggle_pin"; id: string }
  | { type: "quad_anchor"; id: string }
  | { type: "begin_session_load" }
  | { type: "set_thumb"; id: string; src: string }
  | {
      type: "replace_graph";
      nodes: NodeCard[];
      wires: Wire[];
      backdrops?: Backdrop[];
      /** the photo's link overrides from its file; absent leaves them as they are */
      overrides?: string[];
    }
  | { type: "add_backdrop"; backdrop: Backdrop }
  | { type: "move_backdrop"; id: string; dx: number; dy: number }
  | { type: "resize_backdrop"; id: string; w: number; h: number }
  | { type: "rename_backdrop"; id: string; name: string }
  | { type: "cycle_backdrop_color"; id: string }
  | { type: "delete_backdrop"; id: string }
  | { type: "arrange_nodes" }
  /** Back to factory, as ONE undo step however many photographs: `ids`
   * for a multi-selection, `id` for one. */
  | { type: "reset_image_edits"; id?: string; ids?: string[] }
  | { type: "collapse_tree_below"; path: string }
  | { type: "set_rating"; ids: string[]; stars: number }
  | { type: "set_flag"; ids: string[]; flag: ImageEntry["flag"] }
  | { type: "select_nodes"; ids: string[]; additive?: boolean }
  | { type: "clear_selection" }
  | { type: "move_node"; id: string; x: number; y: number }
  /** one gesture moving a selection: every card by the same hand */
  | { type: "move_nodes"; moves: { id: string; x: number; y: number }[] }
  /** copies of the named cards, offset, with the wires among them */
  | { type: "duplicate_nodes"; ids: string[] }
  /** every dial and choice on one card back to its defaults, in one
   * step; the values arrive from the panel's default tables */
  | { type: "reset_node"; id: string; values: Record<string, number>; textValues: Record<string, string> }
  | { type: "set_param"; id: string; param: string; value: number }
  // `text` rides along so an edit that spans both kinds (a lens profile
  // writes a model name and its coefficients) is one command and one
  // undo step, instead of a history entry per parameter.
  | {
      type: "set_params";
      id: string;
      values: Record<string, number>;
      text?: Record<string, string>;
      /** a wheel hue gesture: the harmony aid may bend the *_hue values
       * on their way in (widgets declare the gesture, the reducer owns
       * the aid, and sliders typing exact numbers stay exact) */
      harmonize?: boolean;
      /** the shapes drawn on the node go too, in the same step: a Smart
       * mask's Clear forgets them with the clicks */
      clearRegions?: boolean;
    }
  | {
      type: "set_curve";
      id: string;
      channel: CurveChannel;
      curve: [number, number][];
      /** per-point handle vectors parallel to curve, for tangent mode;
       * omitted leaves the stored handles alone */
      handles?: (CurveHandle | null)[];
      /** slopes parallel to curve, for tangent mode; omitted leaves the
       * stored tangents alone */
      tangents?: number[];
    }
  | { type: "reset_curves"; id: string }
  | { type: "set_curve_interp"; id: string; interp: "smooth" | "linear" | "tangent" }
  | { type: "set_text_param"; id: string; param: string; value: string }
  | { type: "toggle_mask_view" }
  | { type: "set_folders"; folders: FolderEntry[] }
  | { type: "set_folder_tree"; root: TreeNode | null }
  | {
      type: "set_tree_node";
      path: string;
      children?: { name: string; path: string }[];
      expanded?: boolean;
    }
  | { type: "set_collections"; collections: CollectionEntry[] }
  | { type: "set_edited_folders"; paths: string[] }
  | { type: "set_folders_with_hidden"; paths: string[] }
  | { type: "set_folders_with_trash"; paths: string[] }
  | { type: "set_missing_trashed"; count: number; skipped: number }
  | {
      type: "set_thumb_progress";
      progress: { done: number; total: number } | null;
    }
  | { type: "set_stack_progress"; image: string; progress: StackMerge | null }
  | { type: "set_stack_canceled"; image: string; on: boolean }
  | { type: "resume_stack_merge"; image: string }
  | { type: "set_stitch_canceled"; image: string; on: boolean }
  | { type: "set_baking"; id: string | null }
  | { type: "resume_pano_stitch"; image: string }
  | {
      type: "set_stitch_progress";
      progress: State["stitch"];
    }
  | { type: "tick_thumb_progress" }
  | {
      type: "set_library";
      label: string;
      collection: number | null;
      path?: string | null;
    }
  | { type: "set_filter_stars"; stars: number }
  | { type: "set_filter_name"; text: string }
  | { type: "set_filter_dates"; from?: string; to?: string }
  | { type: "set_shot_dates"; dates: Record<string, string | null> }
  | { type: "set_filter_takes"; min?: number; max?: number }
  | { type: "clear_filters" }
  | { type: "step_image"; delta: number }
  | { type: "set_keynav"; nav: NavState | null }
  | { type: "cancel_tool" }
  | { type: "open_palette"; x?: number; y?: number; cat?: Category }
  | { type: "close_palette" }
  | { type: "note_recent_node"; nodeType: string }
  /** Drop a node recipe: one new group at (x, y) in graph space, fresh
   * ids, nothing else touched (noderecipes.ts). `id` is the group's,
   * chosen by the caller so it can select it; a fresh one when absent. */
  | { type: "add_recipe"; recipe: NodeRecipe; x: number; y: number; id?: string }
  /** Save a group as a user recipe under `name`. */
  | { type: "save_recipe"; id: string; name: string; recipeId?: string }
  /** Save as Recipe's file could not be written: the listed recipe is
   * kept, grayed with the reason (its `error`), instead of vanishing. */
  | { type: "recipe_not_saved"; recipe: NodeRecipe }
  | { type: "rename_recipe"; id: string; name: string }
  /** Take a user recipe off the list. A list edit: nothing on disk is
   * deleted, the stored list is written again without it. */
  | { type: "remove_recipe"; id: string }
  /** The stored list, read at launch. */
  | { type: "set_user_recipes"; recipes: NodeRecipe[] }
  /** The app took the first `count` recipeOps to run on disk. */
  | { type: "take_recipe_ops"; count: number }
  | { type: "set_prefs"; prefs: Partial<Prefs> }
  | { type: "set_panel_tab"; tab: PanelTab }
  | { type: "cycle_mode"; delta: number }
  | { type: "set_spectrums_popped_out"; out: boolean }
  | { type: "set_takes_popped_out"; out: boolean }
  | { type: "set_console_window"; open: boolean }
  /** pin or unpin an Adjustments section by title (a preference) */
  | { type: "toggle_pinned_section"; title: string }
  /** Preferences > Interface: a section leaves or rejoins the panel. */
  | { type: "toggle_hidden_section"; title: string }
  /** The Reset beside that list: every section back in the panel. */
  | { type: "show_all_sections" }
  /** link the photographs into one group, or unlink them (group null) */
  | { type: "set_link_group"; ids: string[]; group: string | null }
  | { type: "toggle_link_pin"; id: string }
  /** flip one or more override keys on the active photograph, all on or all off */
  | { type: "toggle_link_override"; keys: string[] }
  /** Copies one linked photograph's edit onto every other member of its
   * link, whole (the deliberate sync, as against the link's
   * own relative mirroring). Overrides on either side hold, pinned
   * members sit it out.*/
  | { type: "link_match"; id: string }
  | { type: "settle_link_edits"; id: string }
  | { type: "link_saved"; id: string; graph: GraphSnapshot }
  /** linked members' graphs read from disk into the stash, so a mirrored
   * edit has somewhere to land; the active photograph is never touched */
  | { type: "stash_graphs"; graphs: Record<string, { nodes: NodeCard[]; wires: Wire[]; backdrops?: Backdrop[]; linkOverrides?: string[] }> }
  | { type: "set_section_filter"; filter: SectionFilter }
  /** the saved layout coming back at launch; every field optional and checked */
  | { type: "restore_layout"; layout: Partial<UiLayout> }
  /** every pop-out docked, for a window pushed off a display */
  | { type: "dock_all_windows" }
  /** the panels, sizes, workspace and ribbon back to a fresh launch's */
  | { type: "reset_layout" }
  | { type: "set_bend_popped_out"; out: boolean }
  | { type: "set_tool_popped_out"; tool: "wheels" | "curves" | "toneeq" | "recolor" | "colorconsole"; out: boolean }
  | { type: "ask_confirm"; action: ConfirmAction }
  | { type: "advance_confirm" }
  | { type: "close_confirm" }
  | { type: "remove_images"; ids: string[] }
  | { type: "open_catalogs" }
  | { type: "close_catalogs" }
  | { type: "open_bake"; ids: string[] }
  | { type: "set_bake_format"; format: string }
  | { type: "start_bake" }
  | { type: "close_bake" }
  | { type: "open_prefs"; landing?: string }
  | { type: "close_prefs" }
  /** The one flag button's next state: off, picks only, rejects hidden. */
  | { type: "cycle_filter_flag" }
  /** The one edited button's next state: all, edited only, untouched only. */
  | { type: "cycle_filter_edited" }
  /** The flag button's modifier click: inverts the context it is in. */
  | { type: "invert_filter_flag" }
  | {
      type: "restore_takes";
      imageId: string;
      versions: Take[];
      activeVersion: string;
    }
  | { type: "new_take"; name?: string; note?: string }
  | { type: "update_take"; takeId: string; name: string; note?: string }
  | { type: "set_take_rating"; takeId: string; rating: number }
  | { type: "switch_take"; takeId: string }
  | { type: "delete_take"; takeId: string }
  | { type: "jump_history"; index: number }
  | { type: "begin_gesture"; key: string; owner?: number }
  | { type: "end_gesture"; owner?: number }
  | { type: "clear_history" }
  | { type: "toggle_console" }
  | { type: "add_layer"; maskType: LayerMaskType }
  | { type: "duplicate_layer"; id: string }
  | { type: "rename_layer"; id: string; name: string }
  | { type: "remove_layer"; id: string }
  | { type: "set_active_layer"; id: string | null }
  | { type: "add_stroke"; id: string; stroke: StrokeData }
  | { type: "clear_strokes"; id: string }
  | {
      type: "set_tool";
      tool: State["tool"];
      /** for the Grid and Shape Warp tools: the Finish warp node to arm
       * them on, or null for the photograph's own warp (absent reads as
       * null). Arming the tool already in hand on another target moves
       * it there rather than putting it down. */
      target?: string | null;
      /** for the range-mask eyedropper: the mask node it samples into
       * (see State.pickNode). Arming Pick for another mask while it is
       * in hand moves it there rather than putting it down. */
      node?: string;
    }
  | { type: "set_brush_radius"; radius: number }
  | { type: "set_brush_tip"; tip: string }
  | { type: "set_brush_hardness"; hardness: number }
  | { type: "set_brush_flow"; flow: number }
  | { type: "set_brush_show_dab"; show: boolean }
  | { type: "set_brush_clone_aligned"; aligned: boolean }
  | { type: "set_brush_overlay_strength"; strength: number }
  | { type: "set_brush_blur_strength"; strength: number }
  | { type: "set_brush_blur_build"; build: boolean }
  | { type: "set_brush_sample_layer"; on: boolean }
  | { type: "set_brush_texture_angle"; angle: number }
  | { type: "add_region"; id: string; region: SelectRegion }
  | { type: "remove_region"; id: string; index: number }
  | { type: "set_region_op"; id: string; index: number; op: SelectOp }
  | { type: "set_region_smooth"; id: string; index: number; smooth: number }
  | { type: "set_region_off"; id: string; index: number; off: boolean }
  | { type: "move_region"; id: string; from: number; to: number }
  | { type: "move_region_point"; id: string; index: number; point: number; x: number; y: number }
  | { type: "clear_regions"; id: string }
  | { type: "set_regions"; id: string; regions: SelectRegion[] }
  | { type: "update_region"; id: string; index: number; region: SelectRegion }
  | { type: "set_ui_setting"; key: keyof UiSettings; value: boolean | string }
  | { type: "set_polish_mode"; mode: string }
  | { type: "set_dodge_mode"; mode: "dodge" | "burn" }
  | { type: "set_repair_mode"; mode: "clone" | "heal" }
  | { type: "set_blur_mode"; mode: "blur" | "blend" }
  | { type: "set_art_content_kind"; kind: ArtContentKind }
  | { type: "set_shape_mode"; mode: ShapeMode }
  | { type: "set_polish_preview"; mode: string }
  | { type: "add_polish_stroke"; id: string; stroke: { points: [number, number][]; radius: number; mode: string } }
  | { type: "update_polish_stroke"; id: string; points: [number, number][] }
  | { type: "open_select_dialog"; dialog: NonNullable<State["selectDialog"]> }
  | { type: "close_select_dialog" }
  | { type: "reset_mask"; id: string; maskType: LayerMaskType }
  | { type: "set_select_method"; method: string }
  | { type: "set_select_op"; op: SelectOp }
  | { type: "set_select_tolerance"; tolerance: number }
  | { type: "set_select_magnet_sense"; sense: number }
  | { type: "reset_select_settings" }
  | { type: "toggle_selection_split" }
  | { type: "close_selection_split" }
  | { type: "set_select_smooth"; smooth: number }
  | { type: "set_select_brush_radius"; radius: number }
  | { type: "set_polish_open"; open: boolean }
  | { type: "set_polish_view"; view: string }
  | { type: "set_polish_radius"; radius: number }
  | { type: "set_polish_add"; add: boolean }
  | { type: "set_brush_texture"; scale?: number; depth?: number }
  | { type: "set_pick_mode"; mode: PickMode }
  | { type: "set_pick_target"; target: PickTarget }
  | { type: "arm_curve_pick"; nodeId: string; channel: CurveChannel }
  | { type: "arm_cset_dropper"; n: number | null }
  | { type: "toggle_cset_mask_view"; n: number }
  | { type: "probe_node"; id: string | null }
  | { type: "ab_compare"; value: { a: string; b: string | null } | null }
  | { type: "toggle_mask_flavor" }
  | { type: "toggle_brush_swap" }
  | { type: "set_harmony"; value: Partial<Harmony> }
  | { type: "toggle_spectrum_selection" }
  | { type: "smart_select_ask" }
  | { type: "reset_settled"; id: string }
  | { type: "restore_settled"; id: string }
  | { type: "toggle_gamut_view" }
  | { type: "toggle_tone_eq_pick"; id: string }
  | { type: "arm_wb_pick"; id: string | null }
  | { type: "toggle_recolor_pick"; id: string }
  | { type: "toggle_recolor_match"; id: string }
  | { type: "toggle_bw_separate" }
  | { type: "toggle_bw_pick" }
  | { type: "toggle_zones_view" }
  | { type: "set_zone_hover"; zone: number | null }
  | { type: "arm_zone_place"; zone: number | null }
  | { type: "set_zone_place_first"; first: { x: number; y: number; zone: number } | null }
  | { type: "toggle_zones_fold" }
  | { type: "set_recolor_hover"; x: number | null }
  | { type: "set_tone_eq_hover"; x: number | null }
  | { type: "set_bw_hover"; hue: number | null }
  | { type: "set_cset_hover"; hue: number | null }
  | {
      type: "set_bw_separate_source";
      source: { hue: number; chroma: number; lightness?: number; gray: number; x: number; y: number } | null;
    }
  | { type: "toggle_collision_view" }
  | { type: "set_collision_tolerance"; percent: number }
  | {
      type: "set_recolor_match_source";
      source: { hue: number; chroma: number; luma: number; x: number; y: number } | null;
    }
  | { type: "set_recolor_cell"; cell: import("./eqcurve").RecolorCellId }
  | { type: "set_console_band"; id: string }
  | { type: "toggle_console_pick"; id: string; band?: string }
  | { type: "add_gamut_map_after"; id: string }
  | { type: "add_inpaint_for"; maskId: string }
  | { type: "remove_inpaint"; id: string }
  | { type: "art_remove_from_selection"; maskId: string }
  | { type: "convert_mask_to_selection"; maskId: string; version: string }
  /** To Mask: a layer's mask (a Smart mask, an Object mask) made the
   * pixel mask Add layer mask makes, wearing `version`, the desktop's bake
   * of its render (bake_mask_raster) */
  | { type: "convert_mask_to_pixels"; maskId: string; version: string }
  | { type: "load_selection_from_mask"; maskId: string; version: string }
  /** Select > Polish on a Finish layer's live mask with nothing else
   * selected: `version` is the desktop's bake of the mask's render
   * (bake_mask_raster), loaded into the document selection to polish */
  | { type: "polish_layer_mask"; maskId: string; version: string }
  /** Apply's landing for polish_layer_mask: `version` is the desktop's
   * bake of the polished selection as the layer's mask (bake_layer_mask),
   * absent when the bake failed */
  | { type: "polish_layer_mask_land"; seq: number; version?: string }
  | { type: "point_matte_at_bake"; id: string; version: string }
  | { type: "poke_render" }
  /** `flavor`: the modifier click, which flips the app-wide mask
   * flavor (black and white or the red overlay) and shows the view in
   * it. `mask`: the eye sits in a layer's or a set's Depth mask block,
   * and the modifier click shows THAT mask in red, the effective mask
   * its adjustment multiplies by (a second modifier click turns it
   * black and white); a plain click there is View depth and never puts
   * that mask's eye down. */
  | { type: "toggle_depth_view"; flavor?: boolean; mask?: string }
  | { type: "recompute_depth" }
  | { type: "depth_settled" }
  | { type: "file_passes_known"; image: string; passes: FilePasses | null }
  | { type: "toggle_halation_view" }
  /** a lens character: one preset written across the optical sections
   * in one step*/
  | { type: "apply_lens_character"; id: string }
  /** a section look held on the photograph (src/sectionlooks.ts), or
   * null to put the photograph back: a view, allowed on every tier */
  | { type: "preview_section_look"; id: string | null }
  /** a section look written onto its section, built on the way: one
   * undo step */
  | { type: "apply_section_look"; id: string }
  /** the flaring-light door: builds Depth Lighting if the photograph has
   * none, then adds one light to the rig, in one undo step */
  | { type: "add_character_flare_light"; light: Record<string, unknown> }
  /** every Color Set's grade on or off together: the section's switch */
  | { type: "set_color_sets_enabled"; on: boolean }
  /** the section's reset: every set removed, the chain healed */
  | { type: "remove_all_color_sets" }
  | { type: "toggle_keylight_pick" }
  | { type: "select_keylight"; index: number | null }
  /** the Color Checker's viewport overlay: corners drag, patches click.
   * Names the node so the panel's build-on-touch can build an off
   * section on the way through, the bargain every control makes. */
  | { type: "toggle_chart_place"; id: string }
  /** a saved calibration written into this photograph's Color Checker
   * node: matrix, exposure, chart id and the fit report with the
   * calibration's name; the section is created when absent */
  | {
      type: "apply_calibration";
      name: string;
      matrix: number[];
      exposure: number;
      chart: string;
      fit: string;
    }
  | { type: "apply_preset"; preset: PresetFile }
  | { type: "toggle_find_control" }
  | { type: "flash_control"; section: string; param: string | null }
  | { type: "clear_control_flash" }
  | { type: "toggle_dof_pick" }
  | { type: "art_add_fill_layer" }
  | { type: "art_add_smart_layer" }
  | { type: "set_curve_hover"; x: number | null }
  /** the Curves RGB | CMY toggle: this photograph only, no undo step */
  | { type: "set_curve_mode"; mode: CurveMode }
  /** Copy: the shown curve onto its tool's own clipboard. The
   * paste is the tool's ordinary curve write, one undo step.*/
  | { type: "copy_curve"; clip: CurveClip }
  | { type: "copy_recolor_curve"; clip: RecolorClip }
  | { type: "set_crop_aspect"; aspect: number | null }
  | {
      type: "set_panel_size";
      panel: "library" | "right" | "graphViewer" | "ribbon" | "rightSplit" | "selectionSplit" | "libraryTree";
      size: number;
    }
  | { type: "toggle_section"; title: string }
  | { type: "open_sections" | "close_sections"; titles: string[] }
  | { type: "open_section"; title: string }
  | { type: "seed_preset_folds"; keys: string[] }
  | { type: "toggle_preset_fold"; key: string }
  | { type: "disarm_pickers" }
  | { type: "set_published"; id: string; label: string; value: number }
  /** A published menu's choice (node recipes, 2026-09-30). */
  | { type: "set_published_choice"; id: string; label: string; choice: string }
  /** Publishing (2026-10-01): a member's param onto its group under a
   * name, joining the control of that name when the group has one. */
  | { type: "publish_param"; id: string; node: string; param: string; label: string }
  /** One target off a control, or the whole control with no target. */
  | { type: "unpublish_param"; id: string; label: string; node?: string; param?: string }
  | { type: "rename_published"; id: string; label: string; to: string }
  | { type: "move_published"; id: string; label: string; to: number }
  /** A number control's span and Reset value; `default: null` clears it. */
  | { type: "set_published_range"; id: string; label: string; range?: [number, number]; default?: number | null }
  /** `then`: the write that caused the build (a preview control moved
   * before its section existed), applied on the built block as the same
   * undo step. See reduce. */
  | { type: "set_recipe"; recipe: Recipe; on: boolean; then?: Command }
  /** Noise Reduction's Method (2026-09-09): Classic is the luma/chroma
   * pair in the graph, Model is the SCUNet answer blended in by the
   * modeldenoise node right after the source. The choice is remembered
   * on the model node's `method` param across the section switch.*/
  | { type: "set_denoise_method"; model: boolean }
  | { type: "set_category"; title: string; on: boolean; then?: Command }
  | { type: "add_color_set" }
  | { type: "remove_color_set"; n: number }
  | { type: "toggle_multi_take"; takeId: string }
  | { type: "clear_multi_takes" }
  | { type: "move_tab_down"; tab: PanelTab }
  | { type: "move_tab_up"; tab: PanelTab }
  | { type: "set_panel_tab_bottom"; tab: PanelTab }
  | { type: "set_ribbon_view"; view: "thumbs" | "list" }
  | { type: "toggle_ribbon_expanded" }
  | { type: "set_layout_room"; width: number; zoom: number }
  /** `column` alone toggles the direction when it is the column already
   * in force, which is what a table header click means. `desc` on its
   * own sets the direction and leaves the column alone, which is what
   * the thumbnail strip's two arrows mean: they say which way, not
   * which key. */
  | { type: "set_ribbon_sort"; column?: string; desc?: boolean }
  | { type: "set_enabled"; id: string; enabled: boolean }
  /** a Develop layer on or off as one thing: its exposure node and
   * every tool spliced in behind it; the mask stays as it is */
  | { type: "set_layer_enabled"; id: string; enabled: boolean }
  | { type: "splice_node_into_wire"; id: string; from: string; to: string; toPort: Wire["toPort"] }
  | { type: "extract_node"; id: string }
  | { type: "request_rename"; id: string | null }
  | { type: "toggle_graph_search"; open: boolean }
  | { type: "set_notice"; text: string | null }
  | { type: "open_docs"; file?: string }
  | { type: "close_docs" }
  | { type: "node_outside"; id: string }
  | { type: "set_node_tint"; id: string; tint: string | null }
  | { type: "set_node_note"; id: string; note: string }
  | { type: "rename_node"; id: string; name: string }
  | { type: "delete_nodes"; ids: string[]; heal?: boolean }
  /** `place`: the card's x and y are only its natural spot, and the
   * reducer steps it free of every card already there ("at": the spot
   * the user pointed at; "beside": right of the selected card when
   * there is one, else that spot). Without it the card lands exactly
   * where it says (loads, tests, scripted graphs). */
  | { type: "add_node"; node: NodeCard; place?: "at" | "beside"; viewport?: { width: number; height: number } }
  | { type: "connect"; wire: Wire }
  | { type: "disconnect"; to: string; toPort: Wire["toPort"] }
  | { type: "open_group_dialog"; open: boolean }
  /** open the "Layers from File..." picker over a file's passes report
   * (26.3 Phase 7 import); the choices are computed here so the dialog
   * only renders them */
  | { type: "open_file_layers"; path: string; passes: FilePasses | null }
  | { type: "close_file_layers" }
  /** one image layer per chosen entry, top of stack, Normal, 100%, in
   * one undo step; the content File node references path by layer name
   * or page and never copies pixels into the catalog */
  | { type: "art_add_file_layers"; path: string; items: { layer: string; name: string; box?: Box | null }[] }
  /** one image layer at the top of the stack (Finish image layers,
   * 2026-09-30): a file from disk or a photograph of this catalog
   * through its own edits, placed centered and fitted on `box` (the
   * rest box the caller fitted from the picture's size; null fills the
   * frame), Normal, 100%, one undo step */
  | { type: "art_add_image_layer"; source: ImageLayerSource; name: string; box: Box | null; expected?: EditOrigin }
  /** New Layer via Copy (2026-09-30): the pixels inside the selection,
   * kept by the desktop as `path` (bake_layer_copy), as an image layer
   * placed on `box`, the rectangle of the frame they were cut from, on a
   * frame of shape `aspect`; directly above the layer `above` (the top
   * when null), named `name`, one undo step. The selection stays.*/
  | { type: "art_layer_via_copy"; path: string; box: Box; aspect: number; name: string; above: string | null; expected?: EditOrigin }
  /** Bake Warp (2026-09-30): the Warp layer `id` (its carrier) replaced
   * in its own seat by an image layer reading `path`, what the layer
   * showed, kept by the desktop (bake_warp_layer) and placed on `box` of
   * a frame of shape `aspect`; name, mode, opacity, clipping and group
   * kept, the mask and effects baked in. One undo step.*/
  | { type: "art_bake_warp"; id: string; path: string; box: Box; aspect: number; expected?: EditOrigin }
  /** Unbake (2026-10-01): the layer Bake Warp made, carrier `id`,
   * replaced in its own seat by the live Warp layer its picture node
   * kept (bakedFrom), mask and effects back; one undo step.*/
  | { type: "art_unbake_warp"; id: string }
  /** a layer's picture chosen again or relinked; a new `box` (another
   * shape of picture) carries the placement across so the picture keeps
   * where it was and its own proportions */
  | { type: "art_image_source"; id: string; source: ImageLayerSource; box: Box | null; expected?: EditOrigin }
  | { type: "open_catalog_layer_pick" }
  | { type: "close_catalog_layer_pick" }
  | { type: "set_transform_lock"; on: boolean }
  | { type: "group_selection"; name: string; note?: string }
  | {
      type: "open_group";
      id: string | null;
      /** viewport size, when the caller wants the group's contents
       * framed on entry; leaving always restores the stashed view */
      frame?: { w: number; h: number };
    }
  | { type: "set_zoom"; zoom: State["viewerZoom"] }
  | { type: "set_roi_patch"; patch: ViewState["roiPatch"] }
  | { type: "set_stage_px"; w: number; h: number }
  // Grid Warp. The selection and the reach are view state; the mesh
  // writes are edits and go through undo like any other.
  | { type: "grid_warp_select"; ids: number[]; mode?: "set" | "add" | "toggle" }
  | { type: "grid_warp_grow" }
  | { type: "grid_warp_shrink" }
  | {
      type: "set_grid_warp_ui";
      influence?: number;
      heat?: GridWarpUi["heat"];
      link?: boolean;
    }
  /** the color of every tool's lines over the photograph: a hue in
   * degrees and a luma in percent, null for the automatic choice */
  | { type: "set_line_color"; hue?: number | null; luma?: number | null }
  /** the whole mesh after a drag; builds the node on a first drag */
  | { type: "grid_warp_mesh"; mesh: GridMesh; target?: WarpTarget }
  /** the mesh mid-drag from the section's wheel or pad, or null */
  | { type: "grid_warp_live"; mesh: GridMesh | null }
  /** a new cell count, the warp resampled onto it */
  | { type: "grid_warp_density"; cols: number; rows: number; target?: WarpTarget }
  /** one line in at a position, or one interior line out by index */
  | { type: "grid_warp_line"; axis: "col" | "row"; at?: number; remove?: number; target?: WarpTarget }
  | { type: "grid_warp_reset"; target?: WarpTarget }
  // Shape Warp. The pick and the mode are view state; the list and
  // every shape's numbers are edits and go through undo.
  | { type: "shape_warp_select"; id: string | null }
  | { type: "shape_warp_mode"; mode: ShapeWarpUi["mode"] }
  /** a fresh shape in the frame's middle, picked, in Position mode;
   * builds the node on the first add */
  | { type: "shape_warp_add"; target?: WarpTarget }
  | { type: "shape_warp_remove"; id: string; target?: WarpTarget }
  | { type: "shape_warp_rename"; id: string; name: string; target?: WarpTarget }
  | { type: "shape_warp_enable"; id: string; on: boolean; target?: WarpTarget }
  /** any of a shape's numbers, placement or warp */
  | { type: "shape_warp_set"; id: string; patch: Partial<Omit<WarpShape, "id">>; target?: WarpTarget }
  /** one shape's warp back to rest, or every shape's when no id */
  | { type: "shape_warp_reset"; id?: string; target?: WarpTarget }
  /** a photograph's line thickness for every overlay, in pixels like
   * the preference, or 0 to follow the preference: the active
   * photograph's, or `id`'s (the saved file's value on a read) */
  | { type: "set_photo_line_width"; width: number; id?: string }
  | { type: "graph_settled"; id: string }
  | { type: "art_add_layer"; kind: ArtKind }
  /** `version`: the selection's coverage baked by the desktop
   * (bake_layer_mask), which the new layer's pixel mask wears */
  | { type: "art_fill_from_selection"; maskId: string; color: string; version: string }
  | { type: "art_layer_from_selection"; maskId: string; version: string }
  | { type: "art_arm_dodge"; tool: "dodge" | "burn" }
  | { type: "art_clip_layer"; id: string; clip: boolean }
  | { type: "arm_document_selection" }
  | { type: "ensure_document_selection" }
  /** `version`: the coverage the desktop baked (bake_layer_mask), the
   * selection alone for "replace", else the selection added to or taken
   * out of what the layer's mask showed; the layer's pixel mask wears it
   * and the document selection empties */
  | { type: "art_mask_from_selection"; id: string; maskId: string; version: string; op?: MaskFromSelectionOp }
  | { type: "art_remove_layer"; id: string }
  /** a top-level layer copied just above itself: content, mask, effects
   * and placement; the copy is active */
  | { type: "art_duplicate_layer"; id: string }
  | { type: "art_move_layer"; id: string; delta: 1 | -1 }
  | {
      type: "art_layer_set";
      id: string;
      opacity?: number;
      mode?: string;
      enabled?: boolean;
      name?: string;
    }
  // The Finish tab's Export checkbox (26.3 Phase 8): creates or removes
  // the Export Layer node that taps this layer, inside the art group.
  | { type: "art_set_export"; id: string; on: boolean }
  // The same checkbox for the layer's MASK (2026-09-30): an Export Layer
  // node, `source = finishmask:<blend id>`, that writes the weight the
  // layer's blend applies as a gray layer. One node per mask, two seats
  // (the row under Depth mask, the brush panel's button row).
  | { type: "art_set_mask_export"; id: string; on: boolean }
  // The same checkbox on a DEVELOP adjustment layer (2026-10-01, the
  // third time of asking: "The Export Mask as Layer option underneath
  // Depth mask in adjustment layers"): an Export Layer node on the
  // top-level graph, `source = layermask:<layer id>`, that writes the
  // weight the layer's adjustments are applied through (its mask, the
  // Depth mask when on, its Opacity) as a gray layer. `id` is the layer's
  // own node, layer_<n>_adj.
  | { type: "set_layer_mask_export"; id: string; on: boolean }
  // The same checkbox on a Develop section's header (2026-09-30): an
  // Export Layer node on the top-level graph, `source = develop:<section
  // title>`, tapping `tap` (the section's last node on the picture's path;
  // Depth Map's depth output when `depth`). `off`: nodes to switch off as
  // the tick lands, wiring kept. A tick on a section not used yet rides
  // its build (the build's `then`), and the nodes that build made are
  // switched off again so the tick never changes the picture (2026-09-30:
  // "every section should have the option for export layer").
  | { type: "set_section_export"; title: string; tap: string; depth?: boolean; on: boolean; off?: string[]; layer?: string }
  | { type: "art_add_stroke"; id: string; stroke: StrokeData }
  | { type: "art_update_stroke"; id: string; points: [number, number][] }
  /** `edit`: straight into editing the new mask, the tool that edits it
   * armed on it (2026-10-01: "When you make the mask select the mask and
   * go into mask editing"). Tool state, not an undo step.*/
  | { type: "art_add_mask"; id: string; kind?: "brush" | "smart" | "object" | "fill"; edit?: boolean }
  | { type: "art_group_layers"; ids: string[] }
  | { type: "art_ungroup"; id: string }
  /** Move a top-level layer into an existing group
   * ("Add pixel layer to existing group").*/
  | { type: "art_add_to_group"; id: string; groupId: string }
  /** Lift a member back out to the top level, above its group. */
  | { type: "art_remove_from_group"; id: string }
  /** Reorder a layer inside its group; +1 is up the stack. */
  | { type: "art_move_member"; id: string; delta: number }
  | { type: "select_art_layers"; ids: string[] }
  | { type: "art_edit_gradient"; id: string | null }
  | { type: "art_content_set"; id: string; param: string; value: number | string }
  // The layer transform, written as one command rather than through
  // set_params. A blend node is inside the Finish group, and set_params
  // only ever walks the top level: the drag wrote to an id that was not
  // there and the photograph sat still while the handles moved.
  | { type: "art_set_quad"; id: string; box: Box; corners: [number, number][] }
  /** Flip Horizontal ("h") or Flip Vertical ("v") above the canvas: the
   * layer mirrored, per its kind (flipLayer). One undo step. */
  | { type: "art_flip_layer"; id: string; axis: FlipAxis }
  /** Photo > Flip Horizontal ("h") or Flip Vertical ("v"): the whole
   * photograph mirrored with every edit on it. One undo step. */
  | { type: "flip_photo"; axis: FlipAxis }
  | { type: "art_add_fx"; id: string; fx: string }
  /** an image layer's own warp on or off the layer (A, 2026-09-30): a
   * Finish warp in the picture's space, first on the layer's effect
   * chain, so it runs on the picture before the blend places it */
  | { type: "art_layer_warp"; id: string; on: boolean; /** straight into editing it */ edit?: boolean }
  /** A Finish warp's type: which of its grid and its shapes applies
   * (2026-09-30: "The first control is type: Either GRID or
   * SHAPES"). The other is kept, not applied.*/
  | { type: "art_warp_kind"; id: string; kind: WarpKind }
  /** A Finish warp's edit mode set on or off, whatever it was: the tool
   * of its type armed on it, or put down (a commit, as Enter). Opening
   * a Warp layer's settings sends it on, closing them off (2026-09-30:
   * "when the layer is expanded it should just turn on warp editing.
   * Turn warp editing off when collapsed").*/
  | { type: "art_warp_edit"; id: string; on: boolean }
  | { type: "art_remove_fx"; id: string; fxId: string }
  | { type: "art_fx_set"; fxId: string; param: string; value: number | string }
  | { type: "art_fx_enable"; fxId: string; enabled: boolean }
  | { type: "art_fx_move"; id: string; fxId: string; delta: 1 | -1 }
  | { type: "set_clone_source"; at: [number, number] | null }
  | { type: "set_clone_offset"; offset: [number, number] | null }
  | { type: "set_dodge_strength"; strength: number }
  | { type: "art_remove_mask"; id: string }
  | { type: "select_art_layer"; id: string | null }
  | { type: "set_paint_color"; color: string }
  | { type: "zoom_viewer"; factor: number; cx?: number; cy?: number; unit?: number }
  | { type: "zoom_step"; dir: 1 | -1 }
  | { type: "pan_viewer"; dx: number; dy: number }
  | { type: "set_graph_popped_out"; out: boolean }
  | { type: "set_inspector_home"; home: "main" | "graph" }
  | { type: "toggle_canvas_nodes" }
  | { type: "bump_preview" }
  | { type: "toggle_filter_stacks" }
  | { type: "set_canvas_inspector"; open: boolean }
  | {
      type: "select_image_range";
      id: string;
      additive?: boolean;
      range?: boolean;
    }
  | { type: "add_stack_image"; image: ImageEntry }
  | { type: "boot_step"; step: BootStep; detail?: string }
  | { type: "dismiss_splash" }
  | { type: "boot_done" }
  | { type: "rotate_view"; delta: number }
  | { type: "reset_view_rotation" }
  | { type: "zoom_graph"; factor: number; cx: number; cy: number }
  | { type: "pan_graph"; dx: number; dy: number }
  | { type: "frame_graph"; w: number; h: number }
  | { type: "reset_graph_view" }
  | { type: "toggle_compare" }
  | { type: "toggle_split" }
  | { type: "set_split_pos"; pos: number }
  | { type: "set_split"; changes: Partial<SplitConfig> }
  | { type: "set_compare_take"; id: string | null }
  | { type: "set_expanded_tile"; px: number }
  | { type: "select_images"; ids: string[] }
  | { type: "undo" }
  | { type: "redo" };

/** Parameter ranges, mirroring heeler-graph's registry clamps. */
export const PARAM_RANGE: Record<string, [number, number]> = {
  // The Guided Filter's regularization, in display units squared: the
  // variance a window needs before it counts as an edge.
  epsilon: [0, 0.1],
  // Technical Soft Clip: the scene-linear Ceiling, the Knee as a share
  // of it, and the Toe's scene-linear width above zero.
  ceiling: [0, 16],
  knee: [0, 1],
  toe: [0, 0.1],
  // Median / Percentile: 50 is the median, 0 the window's least.
  percentile: [0, 100],
  // Signed Distance Field: photograph pixels either side of the edge.
  max_distance: [0, 200],
  // Chroma Key: the key color as it reads on screen, 0..1 a channel,
  // and its distances in OkLab chroma (0.3 is a pure green's chroma).
  key_r: [0, 1],
  key_g: [0, 1],
  key_b: [0, 1],
  tolerance: [0, 0.5],
  spill: [0, 1],
  // Normals from Depth: the jump between neighbors that counts as a
  // cliff, in field units.
  cliff: [0, 1],
  // Displacement Map: the cap on any move, in photograph pixels.
  max_displacement: [0, 200],
  // The Sharpening group's Keep color blend, the picture's color kept.
  keep_color: [0, 100],
  // The chart tool's sample circle: its diameter as a percent of the
  // cell. Only the Color Checker carries it.
  sample: [10, 90],
  // Film > Development, in N steps.
  development: [-2, 2],
  // The infrared materials, in stops (phase 4b).
  ir_foliage: [-4, 4],
  ir_sky: [-4, 4],
  ir_water: [-4, 4],
  ir_skin: [-4, 4],
  // The conversion's Neutral dial: how gray a color must be before the
  // hue curve and the infrared guess leave it alone.
  neutral: [0, 100],
  // The print (idea 7): grade 0 to 5, times in stops, the paper's Dmax
  // and base, toning and its crossover.
  grade: [0, 5],
  time: [-2, 2],
  soft: [-2, 2],
  hard: [-2, 2],
  dmax: [1.4, 2.4],
  base: [-100, 100],
  toning: [0, 100],
  crossover: [0, 100],
  // Transform: moves as a percentage of the frame, a turn either way,
  // the pivot as a percentage of the frame.
  move_x: [-200, 200],
  move_y: [-200, 200],
  rotate: [-180, 180],
  pivot_x: [0, 100],
  pivot_y: [0, 100],
  highlight_rolloff: [0, 100],
  // The depth tools' dials.
  density: [0, 100],
  start: [0, 100],
  fog_level: [0, 100],
  black_soft: [0, 100],
  white_soft: [0, 100],
  texture_size: [0, 100],
  texture_shift: [0, 100],
  blades: [3, 9],
  blade_curve: [0, 100],
  fringe: [0, 100],
  field_curve: [-100, 100],
  glow: [0, 100],
  fog_hue: [0, 360],
  fog_sat: [0, 100],
  desat: [0, 100],
  azimuth: [-180, 180],
  elevation: [5, 90],
  ambient: [0, 100],
  relief: [1, 100],
  // The Depth Map section's dials.
  edges: [0, 100],
  flatten: [0, 100],
  near_clip: [0, 40],
  far_clip: [0, 40],
  aperture: [0, 100],
  focus: [0, 100],
  baseline_ev: [-3, 3],
  shadow_toe: [0, 100],
  color_contrast: [-100, 100],
  exposure: [-5, 5],
  contrast: [-100, 100],
  highlights: [-100, 100],
  shadows: [-100, 100],
  whites: [-100, 100],
  blacks: [-100, 100],
  temperature: [2000, 50000],
  tint: [-150, 150],
  saturation: [-100, 100],
  // Color Sets: degrees of OkLab hue. Named so they cannot collide
  // with color_range_mask's 0..1 range/falloff or the bend's
  // hue_center (-180..180: a different wheel).
  band_center: [0, 360],
  hue_range: [0, 180],
  hue_falloff: [0, 120],
  hue_shift: [-180, 180],
  uniformity: [0, 100],
  // Hot Pixels' conviction bar.
  sensitivity: [0, 100],
  // Perspective's keystone pair and its border-hiding zoom.
  vertical: [-100, 100],
  horizontal: [-100, 100],
  zoom: [0, 100],
  vibrance: [-100, 100],
  texture: [-100, 100],
  clarity: [-100, 100],
  dehaze: [-100, 100],
  opacity: [0, 100],
  black: [0, 0.99],
  white: [0.01, 1],
  gamma: [0.1, 10],
  red: [-200, 300],
  green: [-200, 300],
  blue: [-200, 300],
  strength: [0, 100],
  // Noise Reduction's Model method (heeler.model_denoise).
  luminance: [0, 100],
  chroma: [0, 100],
  detail: [0, 100],
  // Skin Softening's two radii, in pixels like a blur's.
  softening: [0, 200],
  detail_back: [0, 200],
  grade_strength: [0, 100],
  angle: [-45, 45],
  crop_x: [0, 0.95],
  crop_y: [0, 0.95],
  crop_w: [0.05, 1],
  crop_h: [0.05, 1],
  shadows_lum: [-100, 100],
  midtones_lum: [-100, 100],
  highlights_lum: [-100, 100],
  shadows_hue: [-180, 180],
  midtones_hue: [-180, 180],
  highlights_hue: [-180, 180],
  shadows_sat: [-100, 100],
  midtones_sat: [-100, 100],
  highlights_sat: [-100, 100],
  aspect: [0.1, 10],
  shape_amount: [0, 1],
  grow: [-1, 1],
  smooth: [0, 1],
  luma_low: [0, 1],
  luma_high: [0, 1],
  sat_low: [0, 1],
  sat_high: [0, 1],
  src_hue: [0, 360],
  dst_hue: [0, 360],
  src_sat: [0, 1],
  dst_sat: [0, 1],
  falloff: [0.15, 2],
  intensity: [0, 100],
  size: [1, 100],
  threshold: [0, 255],
  // Lens correction. Bipolar: barrel one way, pincushion the other, and
  // the same for each fringe color pair.
  distortion: [-100, 100],
  ca_red: [-100, 100],
  ca_blue: [-100, 100],
  vignette: [-100, 100],
  vignette_mid: [0, 100],
  // Lens profile coefficients (raw lensfun polynomial terms, written by
  // the Lens panel's profile Apply; hand-editable in the graph like any
  // other parameter).
  dist_a: [-2, 2],
  dist_b: [-2, 2],
  dist_c: [-2, 2],
  dist_scale: [0.1, 4],
  tca_vr: [0.5, 1.5],
  tca_cr: [-0.5, 0.5],
  tca_br: [-0.5, 0.5],
  tca_vb: [0.5, 1.5],
  tca_cb: [-0.5, 0.5],
  tca_bb: [-0.5, 0.5],
  vig_k1: [-3, 3],
  vig_k2: [-3, 3],
  vig_k3: [-3, 3],
  // View Transform: input trim in stops, and the filmic white point as
  // stops above middle gray.
  exposure_ev: [-4, 4],
  white_ev: [1, 10],
  // The default rendering's chroma axis (ICC ), on the tone profile.
  colorfulness: [-100, 100],
  // Channel Mixer: each output channel's take of each input, percent.
  mix_rr: [-200, 200],
  mix_rg: [-200, 200],
  mix_rb: [-200, 200],
  mix_gr: [-200, 200],
  mix_gg: [-200, 200],
  mix_gb: [-200, 200],
  mix_br: [-200, 200],
  mix_bg: [-200, 200],
  mix_bb: [-200, 200],
  preserve_gray: [0, 1],
  range_shift: [-4, 4],
  // Recolor: how much of the near-neutrals the hue curves leave alone,
  // and how far the Around row's surroundings reach (percent of the
  // short side).
  neutral_guard: [0, 100],
  around_radius: [2, 50],
  // Lens Flare; the names it shares with other nodes (intensity, size,
  // softness, blades) take its own ranges from the per-type table.
  temp: [-100, 100],
  rays: [0, 32],
  ray_length: [0, 100],
  ray_softness: [0, 100],
  rotation: [0, 360],
  ghosts: [0, 16],
  ghost_spacing: [10, 200],
  ghost_size: [0, 30],
  dispersion: [0, 100],
  ghost_opacity: [0, 100],
  anamorphic: [0, 100],
  streak_size: [0.2, 8],
  streak_length: [10, 300],
  streak_taper: [0, 100],
  streak_angle: [-90, 90],
  streak_offset: [-50, 50],
  streak_shift: [-50, 50],
  streak_noise: [0, 100],
  veil: [0, 100],
  veil_radius: [5, 100],
  veil_depth: [-100, 100],
  occlusion: [0, 100],
  occlusion_soft: [0, 100],
  // Depth of Field's disc character.
  bubble: [0, 100],
  squeeze: [-100, 100],
  swirl: [0, 100],
  // Halation; amount, mix, hue, radius and saturation take its own
  // ranges from the per-type table.
  background: [0, 100],
  by_depth: [-100, 100],
  diffusion: [0, 100],
  blue_comp: [0, 100],
  bloom: [0, 100],
  bloom_radius: [5, 60],
  hue: [0, 360],
  mix: [0, 100],
  // Relight (heeler.tone_eq): per-zone exposure in stops, and how widely the
  // illuminance estimate averages.
  ev_m4: [-2, 2],
  ev_m3: [-2, 2],
  ev_m2: [-2, 2],
  ev_m1: [-2, 2],
  ev_0: [-2, 2],
  ev_p1: [-2, 2],
  ev_p2: [-2, 2],
  ev_p3: [-2, 2],
  ev_p4: [-2, 2],
  smoothing: [0, 100],
  // Shared by the B&W treatment and the bend's pull; same 0..100 sense.
  amount: [0, 100],
  hue_center: [-180, 180],
  hue_width: [0, 180],
  softness: [0, 1],
  invert: [0, 1],
  depth_on: [0, 1],
  depth_invert: [0, 1],
  depth_black: [0, 0.99],
  depth_black_soft: [0, 100],
  depth_white_soft: [0, 100],
  depth_white: [0.01, 1],
  depth_gamma: [0.1, 10],
  center_x: [0, 1],
  center_y: [0, 1],
  radius: [0.01, 1],
  feather: [0, 1],
  position: [0, 1],
  span: [0.02, 1],
  camera_wb: [0, 1],
  camera_matrix: [0, 1],
  shadow_hue: [-180, 180],
  shadow_sat: [-100, 100],
  highlight_hue: [-180, 180],
  highlight_sat: [-100, 100],
  balance: [-100, 100],
  // Detail weighting: texture/clarity/dehaze by band and by channel.
  ...Object.fromEntries(
    ["texture", "clarity", "dehaze"].flatMap((e) =>
      ["shadows", "midtones", "highlights", "red", "green", "blue"].map((w) => [
        `${e}_${w}`,
        [0, 200] as [number, number],
      ]),
    ),
  ),
  shadows_gain: [0, 200],
  midtones_gain: [0, 200],
  highlights_gain: [0, 200],
  red_gain: [0, 200],
  green_gain: [0, 200],
  blue_gain: [0, 200],
  // --- Parity pass, 2026-08-23: params the engine has always read but
  // the graph inspector could not show, because numeric rows used to
  // render only for names in this table. Each range mirrors the
  // registry's clamp in heeler-graph/spec.rs. ---
  // Channel Gain's amount (the gain sliders above belong to Grain).
  gain: [0, 400],
  // Clarity node's own local-contrast dial.
  local_contrast: [-100, 100],
  // Color Range Mask's hue window width. The Tone Mask's `range` is a
  // text param and lives in PARAM_OPTIONS; the two never meet.
  range: [0, 1],
  // Luminance Mask's window (its feather has its own entry above).
  low: [0, 1],
  high: [0, 1],
  // Grain Field's re-roll.
  seed: [0, 9999],
  // Bevel's light depth.
  depth: [0, 400],
  // Gradient midpoint(s). The overlays and the gradient proper clamp at
  // 5..95 in the registry; the gradient map admits 1..99, so the wider
  // one is the shared row and the tighter two are per-type overrides.
  midpoint: [1, 99],
  // Gradient stop opacities.
  alpha_a: [0, 100],
  alpha_b: [0, 100],
  // Selection Mask's outline width and its inside/outside bias.
  border_width: [0, 100],
  ramp: [-100, 100],
  // The Polish panel's matte dials: how decided the refined edge is,
  // and how far past the stroke the brush follows a strand.
  matte_contrast: [0, 100],
  matte_reach: [0, 100],
  feather_guided: [0, 1],
  // Output's export dials.
  quality: [1, 100],
  long_edge: [0, 30000],
  // The logic family. Compare's threshold is a field value, NOT
  // sharpen's 0..255 threshold, hence the different name; softness and
  // smoothing and gamma already sit in this table from their earlier
  // owners.
  level: [0, 1],
  constant: [-1, 1],
  scale: [-4, 4],
  offset: [-1, 1],
  in_low: [0, 1],
  in_high: [0, 1],
  out_low: [0, 1],
  out_high: [0, 1],
};

/** The passes an OpenEXR carries beside its pixels, as the desktop's
 * `file_passes` command reports them; generalized in 26.3 Phase 6 so a
 * multi-page TIFF reports its alpha as the plain channel "A" and its
 * pages past the first by name. */
export interface FilePasses {
  /** the depth channel read instead of the model, or null */
  depth: string | null;
  /** each Cryptomatte layer with every name its manifest carries */
  mattes: { layer: string; names: string[] }[];
  /** plain single channels readable as a matte by name; a TIFF's alpha is "A" */
  channels: string[];
  /** the normals pass's Z channel when the file carries one, else null */
  normals: string | null;
  /** whether the file says which way its camera faces, which is what
   * makes a world-space normals pass usable without being told */
  camera: boolean;
  /** pages past the first of a multi-page TIFF, named as the File
   * node's layer param names them ("page 2", "page 3") */
  pages: string[];
  /** the RGB(A) layer groups an EXR carries, as the File node's layer
   * param names them: "" is the beauty, the rest by layer name (26.3
   * Phase 7 import); empty for a TIFF, whose pages carry that office */
  layers: string[];
  /** a layer editor's private layer stack rides the TIFF as a PSD blob we cannot
   * read; said out loud rather than silently absent */
  layered: boolean;
}

/** One entry in the "Layers from File..." picker (26.3 Phase 7
 * import): a label to show and the File node layer param it sets. */
export interface FileLayerChoice {
  label: string;
  layer: string;
}

/** What "Layers from File..." offers for a picked file, from the
 * format-neutral passes report: an EXR's RGB layer groups (beauty
 * first), a TIFF's pages, any other file's one picture. Single
 * channels never list: they come in as masks through the Object layer
 * kind, not as image layers. A TIFF with a private layer stack lists as its
 * one composite page, and the note says why. */
export function fileLayerChoices(
  path: string,
  passes: FilePasses | null,
): { choices: FileLayerChoice[]; note: string | null } {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const stem = (path.split(/[\\/]/).pop() ?? path).replace(/\.[^.]+$/, "");
  if (ext === "exr") {
    const choices = (passes?.layers ?? [""]).map((layer) => ({
      layer,
      label: layer === "" ? stem : layer,
    }));
    const hasMasks = (passes?.channels.length ?? 0) + (passes?.mattes.length ?? 0) > 0;
    return {
      choices,
      note: hasMasks
        ? "Single channels and Cryptomattes come in as masks through an Object layer, not as image layers."
        : null,
    };
  }
  if (ext === "tif" || ext === "tiff") {
    if (passes?.layered) {
      return {
        choices: [{ layer: "", label: stem }],
        note: "This TIFF carries a private layer stack, which Heeler cannot read; the composite page is offered.",
      };
    }
    return {
      choices: ["", ...(passes?.pages ?? [])].map((layer, i) => ({
        layer,
        label: layer === "" ? stem : `Page ${i + 1}`,
      })),
      note: null,
    };
  }
  return { choices: [{ layer: "", label: stem }], note: null };
}

export type LayerMaskType = "range" | "radial" | "linear" | "brush" | "selection" | "smart" | "object";

/** Every mask type, in the order the Layers panel offers them.
 *
 * One list, because the panel's row of add buttons used to be its own
 * hardcoded copy and a new mask type could be everywhere else in the app
 * and still have no button to make one. There is a test that fails if
 * this and LayerMaskType ever disagree.
 */
export const LAYER_MASK_TYPES: LayerMaskType[] = [
  "range",
  "radial",
  "linear",
  "brush",
  "selection",
  "smart",
  // The matte a renderer wrote into the photograph's own file, by
  // object name.
  "object",
];

/** Whether the active photograph's file names anything an Object
 * layer could read: a Cryptomatte, a plain matte channel, an alpha. */
export function fileNamesObjects(s: State): boolean {
  const passes = s.filePasses?.image === s.activeImage ? s.filePasses.passes : null;
  return !!passes && (passes.mattes.length > 0 || passes.channels.length > 0);
}

/** The mask kinds a photograph can be given, in the order their
 * buttons and menu items appear. Object is not a normal photograph's
 * concern: it shows for an OpenEXR, whether or not this one names
 * objects (its panel says when it does not), and for any other file
 * that carries a matte (a TIFF's alpha), and then first, since it is
 * the reason the user opened that file (2026-09-19: "Since EXR is not
 * going to be a normal use case I don't want that showing up all the
 * time"; 2026-09-20: "I didn't say remove it, I said I didn't want it
 * visible when non-EXR files were selected"). Every seat that offers
 * the kinds reads this list, so the row and the menu cannot disagree.*/
/** A saved wire that does not say which output of a two-output node it
 * takes: from Depth Map or a File node into a mask input with no port
 * recorded. The engine reads it as the image, which is almost never what
 * was meant, and the port cannot be inferred, so the graph marks it for
 * the user to reconnect (review R11, 2026-09-20). */
export function wireLacksPort(w: Wire, from: { type: string } | undefined): boolean {
  return !!from && (from.type === "heeler.depth_map" || from.type === "heeler.file") && w.kind === "mask" && !w.fromPort;
}

export function availableMaskTypes(s: State): LayerMaskType[] {
  const rest = LAYER_MASK_TYPES.filter((t) => t !== "object");
  return activeIsExr(s) || fileNamesObjects(s) ? ["object", ...rest] : rest;
}

/** Which viewer tool a layer wants when it becomes the active one.
 *
 * Only brush needs one: radial and linear masks are placed by an overlay
 * that appears whenever their layer is active and no tool is engaged,
 * and range is picked from the panel. Leaving brush alone was the bug,
 * because "nothing armed" and "brush armed" look identical until you try
 * to drag on the photograph.
 *
 * Moving off a brush layer disarms it, so the tool never outlives the
 * layer it belonged to.
 */
/** The tool a mask type wants, given whatever is armed now.
 *
 * One place, because there are two ways to arrive at a layer (creating
 * one and switching to one) and they must not disagree.
 */
export function toolForMaskType(
  maskType: LayerMaskType,
  current: State["tool"],
): State["tool"] {
  if (maskType === "brush") return "brush";
  if (maskType === "selection") return "select";
  if (maskType === "smart") return "smart";
  if (maskType === "object") return "object";
  // Only put down a tool this feature picked up. Polish is on the list:
  // it is modal on ONE selection, and surviving a layer change left it
  // armed with no target, painting its red preview over a mask that no
  // longer existed. "When I deleted the layer, without
  // applying the Polish, it left a red overlay on the image."
  return current === "brush" || current === "select" || current === "smart" || current === "object" || current === "polish"
    ? "none"
    : current;
}

export function toolForLayer(
  s: State,
  layerId: string | null,
  current: State["tool"],
): State["tool"] {
  const maskOf = (id: string | null) =>
    id ? s.nodes.find((n) => n.id === maskOfLayer(id)) : undefined;
  const type = maskOf(layerId)?.type;
  const maskType = (Object.entries(LAYER_MASK_NODE).find(([, v]) => v === type)?.[0] ??
    "range") as LayerMaskType;
  return toolForMaskType(maskType, current);
}

const LAYER_MASK_NODE: Record<LayerMaskType, string> = {
  range: "heeler.range_mask",
  radial: "heeler.radial_mask",
  linear: "heeler.linear_mask",
  brush: "heeler.brush_mask",
  selection: "heeler.selection_mask",
  smart: "heeler.smart_mask",
  object: "heeler.matte_mask",
};

/** Shapes a radial mask can take.
 *
 * "ellipse" is what a radial mask has always been, and it stays the
 * default for anything new. A mask saved before shapes existed carries
 * no shape at all, and the engine keeps rendering it the way it was
 * placed rather than moving it under the user.
 */
export const RADIAL_SHAPES: { id: string; label: string }[] = [
  { id: "ellipse", label: "Ellipse" },
  { id: "rectangle", label: "Rectangle" },
  { id: "triangle", label: "Triangle" },
  { id: "crescent", label: "Crescent" },
  { id: "trapeze", label: "Trapeze" },
  { id: "cross", label: "Cross" },
  { id: "semicircle", label: "Semicircle" },
];

/** Shapes whose `shape_amount` does anything, and what it means for
 * each. The round ones ignore it, so the slider is not offered. */
export const SHAPE_AMOUNT_LABEL: Record<string, string> = {
  cross: "Arm width",
  crescent: "Bite",
  trapeze: "Taper",
};

/** The Depth block every mask node carries (2026-09-09): off, the
 * whole range, a soft edge, not inverted. Percent units.*/
export const DEPTH_MASK_DEFAULTS: Record<string, number> = {
  depth_on: 0,
  depth_invert: 0,
  depth_black: 0,
  depth_white: 1,
  depth_gamma: 1,
  depth_black_soft: 0,
  depth_white_soft: 0,
};

export const LAYER_MASK_DEFAULTS: Record<
  LayerMaskType,
  Record<string, number>
> = {
  range: {
    ...DEPTH_MASK_DEFAULTS,
    luma_low: 0,
    luma_high: 1,
    sat_low: 0,
    sat_high: 1,
    hue_center: 0,
    hue_width: 180,
    softness: 0.15,
  },
  radial: {
    ...DEPTH_MASK_DEFAULTS,
    center_x: 0.5,
    center_y: 0.5,
    radius: 0.4,
    feather: 0.3,
    aspect: 1,
    rotation: 0,
    shape_amount: 0.5,
  },
  linear: { ...DEPTH_MASK_DEFAULTS, angle: 90, position: 0.5, span: 0.25 },
  brush: { ...DEPTH_MASK_DEFAULTS },
  // The Polish panel's matte dials ride the selection node from birth
  // so the panel and the engine agree on their defaults.
  selection: { ...DEPTH_MASK_DEFAULTS, feather: 0, matte_contrast: 25, matte_reach: 50, feather_guided: 0 },
  smart: { ...DEPTH_MASK_DEFAULTS, threshold: 50, feather: 0, expand: 0 },
  object: { ...DEPTH_MASK_DEFAULTS, feather: 0 },
};

/** Range-mask starting points. Luma windows are display-referred, the
 * same space the mask keys in and the histogram draws. */
export const RANGE_PRESETS: {
  id: string;
  label: string;
  values: Record<string, number>;
}[] = [
  {
    id: "highlights",
    label: "Highlights",
    values: {
      luma_low: 0.62,
      luma_high: 1,
      sat_low: 0,
      sat_high: 1,
      hue_width: 180,
      softness: 0.28,
    },
  },
  {
    id: "midtones",
    label: "Midtones",
    values: {
      luma_low: 0.3,
      luma_high: 0.72,
      sat_low: 0,
      sat_high: 1,
      hue_width: 180,
      softness: 0.25,
    },
  },
  {
    id: "shadows",
    label: "Shadows",
    values: {
      luma_low: 0,
      luma_high: 0.38,
      sat_low: 0,
      sat_high: 1,
      hue_width: 180,
      softness: 0.28,
    },
  },
  // Color selections: a range mask keys on hue, so these select red /
  // green / blue AREAS rather than extracting a raw channel (that is what
  // the Channel node is for).
  {
    id: "reds",
    label: "Reds",
    values: {
      luma_low: 0,
      luma_high: 1,
      sat_low: 0.12,
      sat_high: 1,
      hue_center: 0,
      hue_width: 32,
      softness: 0.2,
    },
  },
  {
    id: "greens",
    label: "Greens",
    values: {
      luma_low: 0,
      luma_high: 1,
      sat_low: 0.12,
      sat_high: 1,
      hue_center: 120,
      hue_width: 45,
      softness: 0.2,
    },
  },
  {
    id: "blues",
    label: "Blues",
    values: {
      luma_low: 0,
      luma_high: 1,
      sat_low: 0.12,
      sat_high: 1,
      hue_center: 220,
      hue_width: 45,
      softness: 0.2,
    },
  },
];

export type PickMode = "replace" | "add" | "subtract";
export type PickTarget = "luma" | "hue";

/** Smallest signed circular distance from `a` to `b`, in degrees. */
function hueDelta(a: number, b: number): number {
  return ((((b - a) % 360) + 540) % 360) - 180;
}

/** Folds an eyedropper sample into a range mask's params.
 *
 * Replace centers a fresh window on the sample; add grows the window
 * until the sample is inside; subtract pulls the nearer edge past the
 * sample so it falls outside. Everything is pure so the behavior is
 * testable without a GPU, a file, or a click. */
/** The mask node the range-mask eyedropper writes a sample into: the
 * one its Pick button named, else the active Develop layer's mask.
 * The viewer used to write to the active layer's mask alone, so Pick
 * on a range mask's node in Graph sampled into whichever layer
 * Develop had selected, or nowhere (2026-10-06: the range mask node
 * "did not have the same controls as to what the adjustment layer
 * has").*/
export function pickMaskNode(s: Pick<State, "pickNode" | "activeLayer">): string | null {
  return s.pickNode ?? activeLayerMask(s);
}

export function applyPick(
  params: Record<string, number>,
  sample: { luma: number; hue: number; sat: number },
  mode: PickMode,
  target: PickTarget,
): Record<string, number> {
  const PAD = 0.06; // half-width of a fresh luma window
  const HUE_PAD = 18;
  if (target === "luma") {
    const l = Math.min(1, Math.max(0, sample.luma));
    if (mode === "replace") {
      return {
        luma_low: Math.max(0, l - PAD),
        luma_high: Math.min(1, l + PAD),
      };
    }
    const low = params.luma_low ?? 0;
    const high = params.luma_high ?? 1;
    if (mode === "add") {
      return {
        luma_low: Math.min(low, Math.max(0, l - PAD / 2)),
        luma_high: Math.max(high, Math.min(1, l + PAD / 2)),
      };
    }
    // Subtract: retreat whichever edge the sample is nearer to.
    if (l <= low || l >= high) return {};
    return l - low < high - l
      ? { luma_low: Math.min(high - 0.02, l + PAD / 2) }
      : { luma_high: Math.max(low + 0.02, l - PAD / 2) };
  }

  const center = params.hue_center ?? 0;
  const width = params.hue_width ?? 180;
  const delta = hueDelta(center, sample.hue);
  if (mode === "replace") {
    return {
      hue_center: sample.hue,
      hue_width: HUE_PAD,
      sat_low: Math.max(0, Math.min(sample.sat * 0.4, 0.3)),
    };
  }
  if (mode === "add") {
    // Grow just enough to cover the sample, recentering on the midpoint
    // so the window stays symmetric.
    if (Math.abs(delta) <= width) return {};
    const grown = (Math.abs(delta) + width) / 2 + 4;
    return {
      hue_center: (center + delta / 2 + 360) % 360,
      hue_width: Math.min(180, grown),
    };
  }
  if (Math.abs(delta) > width) return {};
  return { hue_width: Math.max(2, Math.abs(delta) - 4) };
}

/** The lens flare's presets: static snapshots of the LOOK, named for
 * glass. Apply writes exactly these params, so a photo can never
 * inherit half of one lens and half of another; the rig, the
 * intensity and the Scene group are about the photograph and stay
 * out.*/
export const FLARE_PRESETS: { id: string; name: string; params: Record<string, number>; text?: Record<string, string> }[] = [
  {
    id: "prime",
    name: "Modern prime, coated",
    params: { size: 5, softness: 40, rays: 14, ray_length: 25, ray_softness: 25, ghosts: 2, ghost_spacing: 90, ghost_size: 4, blades: 7, dispersion: 20, ghost_opacity: 35, anamorphic: 0, streak_size: 1.5, streak_length: 60, streak_taper: 30, streak_noise: 0, veil: 10, veil_radius: 35 },
  },
  {
    id: "zoom",
    name: "Modern zoom",
    params: { size: 6, softness: 50, rays: 12, ray_length: 20, ray_softness: 35, ghosts: 6, ghost_spacing: 130, ghost_size: 6, blades: 9, dispersion: 35, ghost_opacity: 50, anamorphic: 0, streak_size: 1.5, streak_length: 60, streak_taper: 30, streak_noise: 0, veil: 25, veil_radius: 45 },
  },
  {
    id: "vintage",
    name: "Vintage prime, uncoated",
    params: { size: 9, softness: 80, rays: 0, ray_length: 20, ray_softness: 40, ghosts: 4, ghost_spacing: 110, ghost_size: 10, blades: 6, dispersion: 50, ghost_opacity: 70, anamorphic: 0, streak_size: 1.5, streak_length: 60, streak_taper: 30, streak_noise: 0, veil: 60, veil_radius: 60 },
  },
  {
    id: "tele",
    name: "Telephoto",
    params: { size: 3, softness: 30, rays: 16, ray_length: 45, ray_softness: 20, ghosts: 5, ghost_spacing: 40, ghost_size: 4, blades: 9, dispersion: 25, ghost_opacity: 45, anamorphic: 0, streak_size: 1.5, streak_length: 60, streak_taper: 30, streak_noise: 0, veil: 15, veil_radius: 30 },
  },
  {
    id: "wide",
    name: "Wide angle",
    params: { size: 10, softness: 65, rays: 8, ray_length: 30, ray_softness: 45, ghosts: 7, ghost_spacing: 180, ghost_size: 8, blades: 7, dispersion: 40, ghost_opacity: 45, anamorphic: 0, streak_size: 1.5, streak_length: 60, streak_taper: 30, streak_noise: 0, veil: 30, veil_radius: 55 },
  },
  {
    id: "anamorphic",
    name: "Anamorphic 2x",
    params: { size: 5, softness: 45, rays: 4, ray_length: 20, ray_softness: 30, ghosts: 5, ghost_spacing: 120, ghost_size: 7, blades: 8, dispersion: 45, ghost_opacity: 50, anamorphic: 80, streak_size: 1.2, streak_length: 90, streak_taper: 40, streak_noise: 15, veil: 20, veil_radius: 40 },
    // The classic ribbon: white-hot at the source, the blue streak,
    // fading to a cooler cyan at the ends.
    text: { streak_stops: '[{"pos":0,"color":"#e8f2ff","alpha":100,"mid":50},{"pos":25,"color":"#5aa0ff","alpha":100,"mid":50},{"pos":100,"color":"#38c8d8","alpha":0,"mid":50}]' },
  },
  {
    id: "phone",
    name: "Phone",
    params: { size: 7, softness: 70, rays: 0, ray_length: 20, ray_softness: 40, ghosts: 1, ghost_spacing: 100, ghost_size: 9, blades: 6, dispersion: 30, ghost_opacity: 80, anamorphic: 0, streak_size: 1.5, streak_length: 60, streak_taper: 30, streak_noise: 0, veil: 55, veil_radius: 50 },
  },
];

/** The preset a photograph suggests, from its metadata: a lens name
 * with a dash is a zoom, at or under 24 mm is wide, at or over 135 mm
 * is telephoto, else a prime. A suggestion for the menu, never
 * applied by itself. */
export function suggestFlarePreset(focal35: number | null | undefined, lens: string | null | undefined): string {
  if (lens && /\d\s*-\s*\d/.test(lens)) return "zoom";
  if (focal35 != null && focal35 > 0) {
    if (focal35 <= 24) return "wide";
    if (focal35 >= 135) return "tele";
  }
  return "prime";
}

/** The lens characters: a vintage lens as a coordinated setting of
 * the optical sections, written together in one undo step. Keyed by
 * the section's category title, since a section that is off is built
 * on the way (set_category's rule). The rig, the aperture and the
 * focus are the photograph's and stay out; Recolor's `curves` is
 * MERGED so a coating curve joins the user's cells rather than
 * replacing them.
 *
 * A character writes only what a source supports. Applying one after
 * another still lands on the second's look and not a blend: the apply
 * reads the stamp of the character already on the photograph and puts
 * every dial IT wrote back to neutral before writing the new one, so
 * nothing needs padding with neutrals no lens fact backs. The
 * lenscharacter tests pin it.
 *
 * Values follow their optic's documented behavior. Remember the dials' reach: Depth of
 * Field shapes bokeh only once the photograph's aperture is open, and Lens Flare
 * answers only lights in the rig with flare on, so a character's bokeh and flare
 * signature shows the moment the photograph has both.
 *
 * The apply writes NEITHER (2026-09-04: "Aperture is a photograph decision, not a lens
 * fact"): the character cannot know what the photograph was shot at, and a non-zero
 * aperture would defocus a frame shot sharp and silently start the depth model's
 * download. So the two fact each character still owns, how wide its own aperture opens,
 * rides here as `aperture`, and the two doors beside the menu (characterApertureDoor,
 * characterFlareDoor) offer the aperture and a flaring light as one explicit, undoable
 * click each. `aperture` is the lens's documented widest stop mapped onto the dial's
 * 0..100 so relative depth follows relative speed (the f-numbers are the cited facts;
 * the mapping is a calibration: f/0.95 = 100, f/1.4 = 85, f/2 = 75, f/2.2 = 72, T2.3 =
 * 70, f/2.8 = 62, f/3.5 = 50). The added light flares at the rig's own default
 * strength, 100: no source ranks the lenses' flare strength against one another, so no
 * number pretends to.*/
export type LensCharacter = {
  id: string;
  name: string;
  hint: string;
  /** the lens's widest stop on the Depth of Field dial; only the Open
   * aperture door writes it */
  aperture: number;
  writes: Record<string, { values?: Record<string, number>; text?: Record<string, string> }>;
};
export const LENS_CHARACTERS: LensCharacter[] = [
  {
    id: "helios",
    name: "Helios 44-2",
    hint: "The Soviet Biotar: strong swirl, a touch of bubble, warm coating, mild barrel, deep soft corners",
    // The 44-2 is a 58mm f/2 (kamerastore).
    aperture: 75,
    writes: {
      // 8 blades is the 44-2's own count (kamerastore); the blades run
      // round for their number (mflenses); the swirl is the Biotar
      // formula's and the glow its wide-open dreaminess
      // (indiefilmhustle).
      "Depth of Field": { values: { blades: 8, blade_curve: 60, fringe: 20, field_curve: 40, glow: 15, bubble: 30, squeeze: 0, swirl: 80 } },
      // CA is reported well controlled (allphotolenses: "I haven't seen
      // CA"), so the fringe stays modest; the barrel stays mild (boving).
      Lens: { values: { distortion: 8, ca_red: 8, ca_blue: -6 } },
      // Geometrical vignetting 58% on the 44M (allphotolenses).
      Vignette: { values: { vignette: -45, vignette_mid: 55, softness: 0.7 } },
      Halation: { values: { amount: 40, radius: 3, hue: 22, saturation: 60 } },
      Detail: { values: { texture: -15, clarity: -5 } },
      // Single coating, and reports split warm (Valdai copies, boving)
      // against muted and cool (KMZ, ironglass): a mild warm, not a cast.
      Recolor: { text: { curves: '{"lum_temp":[{"x":-6,"y":0},{"x":-1,"y":5},{"x":3,"y":20}]}' } },
      // Single-coated and not flare-resistant (allphotolenses).
      "Lens Flare": { values: { veil: 35, ghosts: 3, dispersion: 40 } },
    },
  },
  {
    id: "trioplan",
    name: "Meyer Trioplan",
    hint: "The soap-bubble lens: hard-edged rims, hard blades, fringe, a white halation",
    // The Trioplan 100 opens at f/2.8 (fstoppers).
    aperture: 62,
    writes: {
      // 15 blades in life; the dial caps at 9, and at full curve the
      // highlights stay round stopped down either way (fstoppers, B&H).
      // The bubbles are uncorrected spherical aberration, the Cooke
      // triplet kept on purpose (fstoppers).
      "Depth of Field": { values: { blades: 9, blade_curve: 100, fringe: 20, field_curve: 0, glow: 10, bubble: 90, squeeze: 0, swirl: 0 } },
      // Fringing is not the Trioplan's vice (petapixel: no chromatic
      // aberration to complain about), so the CA pair stays small.
      Lens: { values: { distortion: 0, ca_red: 4, ca_blue: -3 } },
      Vignette: { values: { vignette: -25, vignette_mid: 50, softness: 0.6 } },
      Halation: { values: { amount: 30, radius: 3, hue: 30, saturation: 0 } },
      // Center sharpness is excellent wide open (B&H owner reviews) but
      // contrast is low (fstoppers): texture stays near home, clarity dips.
      Detail: { values: { texture: -5, clarity: -10 } },
      Recolor: { text: { curves: '{"lum_temp":[{"x":-6,"y":0},{"x":3,"y":15}]}' } },
      // Flare resistance is "lousy", veiling flare specifically
      // (phillipreeve), so the veil runs hot for a coated lens.
      "Lens Flare": { values: { veil: 40, ghosts: 2 } },
    },
  },
  {
    id: "petzval",
    name: "Petzval",
    hint: "Full swirl, a sharp center, a strongly curved field, heavy vignette",
    // The 85mm Petzval's widest stop is f/2.2 (ephotozine).
    aperture: 72,
    writes: {
      // Waterhouse stops are round holes, so the aperture is a circle at
      // every stop (shutterbug, B&H); the extreme field curvature is the
      // design's signature (dpreview, phillipreeve).
      "Depth of Field": { values: { blades: 9, blade_curve: 100, fringe: 0, field_curve: 85, glow: 5, bubble: 20, squeeze: 0, swirl: 100 } },
      // 0.815% pincushion measured (ephotozine); pincushion is the
      // negative side of this dial. Aberrations otherwise minimal
      // (ehabphotography).
      Lens: { values: { distortion: -4, ca_red: 6, ca_blue: -5 } },
      // Corners sit 2.69 stops down at f/2.2 (ephotozine).
      Vignette: { values: { vignette: -60, vignette_mid: 45, softness: 0.8 } },
      Halation: { values: { amount: 20, radius: 3, hue: 22, saturation: 50 } },
      // Sharp in the center, falling apart toward the edges (ephotozine).
      Detail: { values: { texture: -10 } },
      Recolor: { text: { curves: '{"lum_temp":[{"x":-6,"y":0},{"x":3,"y":20}]}' } },
      // Multicoated Russian glass keeps the veil moderate (ephotozine's
      // second sample resisted flare).
      "Lens Flare": { values: { veil: 25, ghosts: 3 } },
    },
  },
  {
    id: "takumar",
    name: "Takumar 50 f/1.4",
    hint: "The amber-coated classic: glow wide open, a gentle vignette, a little fringe",
    // f/1.4 (mflenses).
    aperture: 85,
    writes: {
      // The Super-Takumar runs 6 blades (the later S-M-C and SMC 8)
      // (mflenses); glow wide open is its signature (vaskoobscura); a
      // subtle swirl rides the vignette (isthisit).
      "Depth of Field": { values: { blades: 6, blade_curve: 70, fringe: 15, field_curve: 0, glow: 25, bubble: 0, squeeze: 0, swirl: 15 } },
      Lens: { values: { distortion: 0, ca_red: 5, ca_blue: -4 } },
      // Slight vignetting wide open (vaskoobscura, isthisit).
      Vignette: { values: { vignette: -20, vignette_mid: 50, softness: 0.6 } },
      Halation: { values: { amount: 25, radius: 3, hue: 35, saturation: 50 } },
      Detail: { values: { texture: -8 } },
      // The thoriated element yellows with age: the warmest cast of the
      // six, strongest in the highlights (vaskoobscura, dutchthrift).
      Recolor: { text: { curves: '{"lum_temp":[{"x":-6,"y":0},{"x":0,"y":15},{"x":3,"y":45}]}' } },
      // SMC holds contrast in backlight but still flares (dutchthrift).
      "Lens Flare": { values: { veil: 25, ghosts: 4 } },
    },
  },
  {
    id: "uncoated",
    name: "Uncoated 1930s",
    hint: "No coating at all: a heavy veil on every light, halation, low micro-contrast, soft everywhere",
    // The 5cm Elmar is an f/3.5 (johnnymartyr).
    aperture: 50,
    writes: {
      // The 1930s Elmar's aperture is 10 blades; the dial caps at 9
      // (johnnymartyr). Old Sonnars show a curved field (35mmc), and
      // the "Leica glow" in highlights is the era's signature
      // (johnnymartyr).
      "Depth of Field": { values: { blades: 9, blade_curve: 40, fringe: 25, field_curve: 20, glow: 35, bubble: 0, squeeze: 0, swirl: 0 } },
      // The Elmar is "totally free of distortion" with aberrations well
      // controlled (vogelius): the vices here are contrast and flare,
      // not geometry.
      Lens: { values: { distortion: 0, ca_red: 8, ca_blue: -6 } },
      Vignette: { values: { vignette: -35, vignette_mid: 50, softness: 0.9 } },
      Halation: { values: { amount: 60, radius: 5, hue: 25, saturation: 30, bloom: 30 } },
      // Resolution holds up; it is global contrast that collapses
      // (vogelius), so clarity takes the bigger half.
      Detail: { values: { texture: -15, clarity: -15 } },
      Recolor: { text: { curves: '{"lum_temp":[{"x":-6,"y":0},{"x":3,"y":20}]}' } },
      // Bare glass scatters: a heavy veil on every light
      // (liquidlightwhisperer).
      "Lens Flare": { values: { veil: 60, ghosts: 4, dispersion: 60 } },
    },
  },
  {
    id: "anamorphic",
    name: "Anamorphic 2x",
    hint: "Cinema glass: oval bokeh squeezed tall, the blue streak, cool highlights",
    // The Kowa Prominar class of 2x anamorphics opens near T2.3
    // (cinevisuals).
    aperture: 70,
    writes: {
      // The 2x squeeze is the whole look: oval discs (cinevisuals).
      "Depth of Field": { values: { blades: 8, blade_curve: 100, fringe: 10, field_curve: 0, glow: 5, bubble: 40, squeeze: -60, swirl: 0 } },
      // Vintage anamorphics barrel (the Kowa Prominar's known tendency,
      // cinematography.com); barrel is the positive side of this dial.
      Lens: { values: { distortion: 5, ca_red: 4, ca_blue: -3 } },
      Vignette: { values: { vignette: -20, vignette_mid: 50, softness: 0.6 } },
      // Halation is the film's red layer answering light bounced off the
      // base, red-orange whatever lens is in front (lomography,
      // analog.cafe): the anamorphic blue belongs to the streak, which
      // is flare, and stays in Lens Flare.
      Halation: { values: { amount: 25, radius: 3, hue: 25, saturation: 40 } },
      // Moderate sharpness, noticeable edge softness, low contrast
      // (cinevisuals, handheldfilms).
      Detail: { values: { texture: -5, clarity: -5 } },
      Recolor: { text: { curves: '{"lum_temp":[{"x":-6,"y":0},{"x":3,"y":-15}]}' } },
      "Lens Flare": {
        values: { anamorphic: 80, streak_size: 1.2, streak_length: 90, streak_taper: 40, streak_noise: 15, veil: 20, ghosts: 5, dispersion: 45 },
        text: { streak_stops: '[{"pos":0,"color":"#e8f2ff","alpha":100,"mid":50},{"pos":25,"color":"#5aa0ff","alpha":100,"mid":50},{"pos":100,"color":"#38c8d8","alpha":0,"mid":50}]' },
      },
    },
  },
  {
    id: "jupiter9",
    name: "Jupiter-9 85",
    hint: "The Soviet Sonnar: glow wide open, a soft swirl, round highlights at every stop",
    // The Jupiter-9 is an 85mm f/2 (tomscameras).
    aperture: 75,
    writes: {
      // 15 rounded blades in life; the dial caps at 9, and rounded blades
      // keep the highlights circular stopped down (phillipreeve). The
      // glow and the color errors on contrasty edges are the wide-open
      // look (tomscameras); outlining is nearly absent (phillipreeve).
      "Depth of Field": { values: { blades: 9, blade_curve: 100, fringe: 35, field_curve: 15, glow: 30, bubble: 10, squeeze: 0, swirl: 35 } },
      // Very minor pincushion (phillipreeve); lateral CA rates average.
      Lens: { values: { distortion: -2, ca_red: 8, ca_blue: -6 } },
      // Vignetting is one of its strong points (phillipreeve).
      Vignette: { values: { vignette: -20, vignette_mid: 50, softness: 0.7 } },
      Halation: { values: { amount: 30, radius: 3, hue: 25, saturation: 50 } },
      // Contrast and sharpness wide open are its weak suit
      // (phillipreeve).
      Detail: { values: { texture: -15, clarity: -15 } },
      Recolor: { text: { curves: '{"lum_temp":[{"x":-6,"y":0},{"x":3,"y":15}]}' } },
      // Flare resistance is listed among the not-good (phillipreeve).
      "Lens Flare": { values: { veil: 45, ghosts: 3 } },
    },
  },
  {
    id: "canon095",
    name: "Canon 50 f/0.95",
    hint: "The Dream Lens: a heavy glow, swirly busy bokeh, hard vignette, barrel",
    // f/0.95, the fastest lens here (phillipreeve).
    aperture: 100,
    writes: {
      // 10 blades in life; the dial caps at 9 (stevehuff,
      // rangefinderforum). The glow is spherical aberration thick enough
      // to name the lens (phillipreeve); the bokeh swirls and outlines
      // into cat's eyes (joerivanderkloet, bluemooncameracodex); purple
      // halos ride the highlights (phillipreeve).
      "Depth of Field": { values: { blades: 9, blade_curve: 70, fringe: 45, field_curve: 25, glow: 60, bubble: 45, squeeze: 0, swirl: 55 } },
      // A rather high barrel for a 50mm (phillipreeve); lateral CA runs
      // low to medium (phillipreeve).
      Lens: { values: { distortion: 8, ca_red: 8, ca_blue: -6 } },
      // The vignette is so strong that stopping to f/1.4 visibly
      // brightens the frame (joerivanderkloet).
      Vignette: { values: { vignette: -55, vignette_mid: 45, softness: 0.7 } },
      Halation: { values: { amount: 25, radius: 3, hue: 22, saturation: 50 } },
      // Soft and hazy wide open (cameralegend, sonyalpharumors).
      Detail: { values: { texture: -20, clarity: -10 } },
      // Color stays neutral, no yellow cast (stevehuff, against the
      // Summicron), so no coating curve: a previous character's cast is taken
      // back by the apply itself. Internal reflections and veiling are part
      // of the look (sonyalpharumors); it flares strongly when it goes
      // (joerivanderkloet).
      "Lens Flare": { values: { veil: 40, ghosts: 4 } },
    },
  },
];

/** The Open aperture door (2026-09-04): shown beside the Lens
 * Character menu only while a character is applied and the Depth of
 * Field aperture is still zero, the state where the character's
 * whole bokeh signature is invisible. A graph with no Depth of Field
 * node shows nothing: the apply builds the node, so its absence says
 * the apply never ran here. Returns the character whose `aperture`
 * the chip would write; null keeps the chip hidden.*/
export function characterApertureDoor(
  s: State,
): { character: LensCharacter; face: "aperture" | "focus" } | null {
  const dof = toolNode(s, "dof");
  if (!dof || !s.nodes.some((n) => n.id === dof.id)) return null;
  const character = LENS_CHARACTERS.find((c) => c.id === dof.textParams?.character);
  if (!character) return null;
  if (((dof.params.aperture as number) ?? 0) === 0) return { character, face: "aperture" };
  // The second face (2026-09-04: no automatic retry): the aperture is
  // open but the focus never landed, because the plane was not there when
  // the first click ran. The same chip now offers the focus alone, one
  // explicit click, and goes away the moment focus is set.
  if (((dof.params.focus as number) ?? 0) === 0) return { character, face: "focus" };
  return null;
}

/** The flaring-light door: shown while a character that writes Lens
 * Flare values is applied and no light in the Depth Lighting rig
 * flares, the state where the character's flare signature draws
 * nothing. The legacy single light never flares (it materializes with
 * flare off), so only the rig's JSON can close the door. Returns the
 * character the chip would add a light for; null keeps the chip
 * hidden. */
export function characterFlareDoor(s: State): LensCharacter | null {
  const dof = toolNode(s, "dof");
  const ch = LENS_CHARACTERS.find((c) => c.id === dof?.textParams?.character);
  if (!ch || !ch.writes["Lens Flare"]) return null;
  // A photograph with no Depth Lighting node has no rig at all, which
  // is exactly the case the door is for: the click builds the section.
  const keylight = s.nodes.find((n) => n.id === "keylight");
  if (!keylight) return ch;
  try {
    const lights = JSON.parse(keylight.textParams?.lights ?? "[]") as { flare?: boolean; on?: boolean }[];
    return lights.some((l) => l.flare && l.on !== false) ? null : ch;
  } catch {
    return ch;
  }
}

/** The character a lens name suggests, by the names people know; null
 * when the metadata says nothing a preset matches. A suggestion for
 * the menu, never applied by itself. */
export function suggestLensCharacter(lens: string | null | undefined): string | null {
  const name = (lens ?? "").toLowerCase();
  if (!name) return null;
  if (name.includes("helios")) return "helios";
  if (name.includes("trioplan")) return "trioplan";
  if (name.includes("petzval")) return "petzval";
  if (name.includes("takumar")) return "takumar";
  if (name.includes("anamorphic")) return "anamorphic";
  if (name.includes("jupiter")) return "jupiter9";
  if (name.includes("canon") && name.includes("0.95")) return "canon095";
  return null;
}

/** The adjustment tools a Develop layer can host, keyed by the suffix
 * their node id gets (layer_2_curves and so on).
 *
 * Every one of these engine node types carries a mask input, and the
 * executor blends any masked node back toward its input, so putting the
 * layer's own copy here is exactly what makes the mask apply to that
 * tool. A layer starts as just a mask and an exposure node; the rest are
 * spliced in the first time you touch that section, so tools you never
 * used stay out of the graph.
 *
 * Not listed, because they are structurally global: the image source and
 * the crop, which define the frame every mask is measured against. */
export const LAYER_TOOLS: Record<
  string,
  {
    type: string;
    name: string;
    cat: Category;
    params: Record<string, number>;
    curves?: true;
    /** A tool that is a group of the recipe's nodes rather than one
     * engine node: the builder makes the card, params mirrored inside. */
    build?: (id: string, x: number, y: number) => NodeCard;
    /** The text params a fresh copy carries (the Recipe switch's mode),
     * so a write landing on the default conjures no node. */
    textDefaults?: Record<string, string>;
  }
> = {
  adj: {
    type: "heeler.exposure",
    name: "Exposure",
    cat: "color",
    params: {
      exposure: 0,
      contrast: 0,
      color_contrast: 0,
      highlights: 0,
      shadows: 0,
      whites: 0,
      blacks: 0,
    },
  },
  color: {
    type: "heeler.standard_color",
    name: "Color",
    cat: "color",
    params: {
      temperature: 6500,
      tint: 0,
      saturation: 0,
      vibrance: 0,
    },
  },
  detail: {
    type: "heeler.detail",
    name: "Detail",
    cat: "detail",
    params: { texture: 0, clarity: 0, dehaze: 0 },
  },
  curves: {
    type: "heeler.curves",
    name: "Curves",
    cat: "color",
    params: {},
    curves: true,
  },
  levels: {
    type: "heeler.levels",
    name: "Levels",
    cat: "color",
    params: { black: 0, white: 1, gamma: 1, black_soft: 0, white_soft: 0 },
  },
  wheels: {
    type: "heeler.color_balance",
    name: "Color Wheels",
    cat: "color",
    params: {
      shadows_lum: 0,
      midtones_lum: 0,
      highlights_lum: 0,
      shadows_hue: 0,
      midtones_hue: 0,
      highlights_hue: 0,
      shadows_sat: 0,
      midtones_sat: 0,
      highlights_sat: 0,
    },
  },
  split: {
    type: "heeler.split_tone",
    name: "Split Tone",
    cat: "color",
    params: {
      shadow_hue: 0,
      shadow_sat: 0,
      highlight_hue: 0,
      highlight_sat: 0,
      balance: 0,
    },
  },
  bw: {
    type: "heeler.black_white",
    name: "Black & White",
    cat: "color",
    params: { ...NEUTRAL_PARAMS["heeler.black_white"] },
  },
  bend: {
    type: "heeler.color_bend",
    name: "Color Bend",
    cat: "color",
    params: {
      src_hue: 0,
      src_sat: 0,
      dst_hue: 0,
      dst_sat: 0,
      falloff: BEND_FALLOFF_DEFAULT,
      amount: 100,
    },
  },
  sharpen: {
    type: "heeler.sharpen",
    name: "Sharpen",
    cat: "detail",
    params: { amount: 0, radius: 1, threshold: 0 },
  },
  denoise: {
    type: "heeler.denoise",
    name: "Denoise",
    cat: "detail",
    params: { strength: 0 },
  },
  grain: {
    type: "heeler.grain",
    name: "Grain",
    cat: "detail",
    params: {
      intensity: 0,
      size: 25,
      by_frame: 1,
      shadows_gain: 100,
      midtones_gain: 100,
      highlights_gain: 100,
      red_gain: 100,
      green_gain: 100,
      blue_gain: 100,
    },
  },
  // The depth tools (docs: scene depth from Depth Anything V2 Small).
  // Neutral at zero like Grain: the nodes are identities until their
  // first dial moves, and identities again on a machine that never
  // computed depth.
  fog: {
    type: "heeler.fog",
    name: "Fog",
    cat: "detail",
    params: { density: 0, start: 0, falloff: 50, texture: 0, texture_size: 30, texture_shift: 0, fog_level: 72, fog_hue: 220, fog_sat: 10, desat: 0 },
  },
  // "Depth Lighting" (the owner renamed it from Key Light once the
  // rig grew point lights; heeler.key_light stays as the node type
  // so saved graphs open untouched).
  keylight: {
    type: "heeler.key_light",
    name: "Depth Lighting",
    cat: "detail",
    params: { strength: 0, azimuth: 45, elevation: 45, ambient: 50, relief: 30, invert: 0 },
  },
  dof: {
    type: "heeler.dof",
    name: "Depth of Field",
    cat: "detail",
    params: { aperture: 0, focus: 0, blades: 6, blade_curve: 100, fringe: 0, field_curve: 0, glow: 0, bubble: 0, squeeze: 0, swirl: 0 },
  },
  // The lens flare, the Depth Lighting rig's lens signature: a section
  // tool and a layer tool like its neighbors.
  flare: {
    type: "heeler.flare",
    name: "Lens Flare",
    cat: "detail",
    params: { intensity: 100, temp: 0, size: 6, softness: 50, rays: 0, ray_length: 30, ray_softness: 30, rotation: 0, ghosts: 0, ghost_spacing: 100, ghost_size: 6, blades: 7, dispersion: 30, ghost_opacity: 60, anamorphic: 0, streak_size: 1.5, streak_length: 60, streak_taper: 30, streak_angle: 0, streak_offset: 0, streak_shift: 0, streak_noise: 0, veil: 20, veil_radius: 40, veil_depth: 0, occlusion: 100, occlusion_soft: 30 },
  },
  // Halation: a section tool and a layer tool like the other optics.
  halation: {
    type: "heeler.halation",
    name: "Halation",
    cat: "detail",
    params: { threshold: 50, background: 50, by_depth: 0, radius: 4, diffusion: 60, hue: 18, saturation: 70, blue_comp: 0, amount: 100, mix: 100, bloom: 0, bloom_radius: 20 },
  },
  // The print: the paper, on demand with the rest of the darkroom.
  paper: {
    type: "heeler.paper",
    name: "Print",
    cat: "color",
    params: { grade: 2, time: 0, split: 0, soft: 0, hard: 0, dmax: 2.1, base: 0, toning: 0, crossover: 50 },
  },
  // The two recipes as single nodes (2026-09-03). "You
  // would always smooth or sharpen via layers and masking", and a block
  // of eight nodes has no mask port. On Base they still apply to the
  // whole photograph; on a layer they follow its mask.
  sharpening: {
    type: "heeler.group",
    name: "Sharpening",
    cat: "detail",
    params: { radius: 3, intensity: 50, keep_color: 100 },
    build: (id, x, y) => sharpeningGroup(id, x, y),
    textDefaults: { mode: "vivid" },
  },
  skin: {
    type: "heeler.group",
    name: "Skin Softening",
    cat: "detail",
    params: { softening: 8, detail_back: 4, strength: 50 },
    build: (id, x, y) => skinGroup(id, x, y),
  },
  // The three single-node color sections, layer tools at last (The
  // report: "being able to tune color on a masked object in the scene
  // is important"; Recolor's Depth row already reads the plane the
  // depth tools' layers read). Their curves, strips and surfaces are
  // text params, which a layer copy reads from PARAM_TEXT_DEFAULT until
  // it writes its own.
  toneeq: {
    type: "heeler.tone_eq",
    name: "Relight",
    cat: "color",
    params: { ...NEUTRAL_PARAMS["heeler.tone_eq"] },
  },
  recolor: {
    type: "heeler.recolor",
    name: "Recolor",
    cat: "color",
    params: { ...NEUTRAL_PARAMS["heeler.recolor"] },
  },
  colorconsole: {
    type: "heeler.color_console",
    name: "Color Tune",
    cat: "color",
    params: { ...NEUTRAL_PARAMS["heeler.color_console"] },
  },
};

export type LayerToolKey = keyof typeof LAYER_TOOLS;

/** Builds the node for a layer tool. Used both for the stand-in the panel
 * renders before the tool is touched and for the real spliced node, so
 * the two can never drift apart. */
function layerToolNode(
  id: string,
  key: string,
  x: number,
  y: number,
): NodeCard {
  const spec = LAYER_TOOLS[key];
  if (spec.build) return spec.build(id, x, y);
  return {
    id,
    type: spec.type,
    name: spec.name,
    cat: spec.cat,
    x,
    y,
    enabled: true,
    params: { ...spec.params },
    ...(spec.curves ? { curves: {} } : {}),
    hasIn: true,
    hasOut: true,
    maskIn: true,
  };
}

/** The node a Develop section edits.
 *
 * With a layer selected this is the layer's own copy of the tool, which
 * is what puts the edit behind the layer's mask. With no layer it is the
 * global node. A layer tool nobody has touched yet has no node in the
 * graph, so this hands back a stand-in holding the defaults; the first
 * write to it materializes the real thing. */
export function toolNode(s: State, key: LayerToolKey): NodeCard | undefined {
  const spec = LAYER_TOOLS[key];
  if (!spec) return undefined;
  if (s.activeLayer) {
    const id = layerToolId(s.activeLayer, key);
    // The stand-in reports OFF: it is the panel's picture of a tool
    // nobody has touched, and a switch reading on for a node that is not
    // even in the graph turned every on-demand section "on" the moment a
    // layer was added ("they should not be turned on
    // automatically for an Adjustment layer"). The real node, which only
    // materializes once a write says something, stays born on.
    return (
      s.nodes.find((n) => n.id === id) ?? { ...layerToolNode(id, key, 0, 0), enabled: false }
    );
  }
  // Layer nodes share these types, so match the main chain explicitly.
  // Recipe nodes share them too: the noise reduction block carries two
  // Denoise nodes of its own, and Detail's Smoothing slider must go on
  // driving the one in the chain rather than whichever comes first in
  // the array.
  const real = s.nodes.find(
    (n) =>
      (spec.build ? n.tool === key : n.type === spec.type) && !isLayerNode(n.id) && !isRecipeNode(n.id),
  );
  if (real) return real;
  // The main-chain tools that ship without a node (TOOL_PIECES): a
  // stand-in at identity, so Detail's Unsharp row and Color's B&W
  // treatment have something to read. Born ON, unlike the layer
  // stand-in above, because these rows sit inside sections that are on:
  // the section's switch is the state that shows, and a row reading off
  // inside an on section would be a switch that lies. The first write
  // that says something builds the real node (materializeMainTool).
  const piece = TOOL_PIECES[key];
  return piece ? layerToolNode(piece.id, key, 0, 0) : undefined;
}

/** Back to factory for one photograph: neutral graph, edited badge
 * gone; the on-disk graph is archived by the resetPending drain
 * (ResetAftermath). The active photograph keeps its history: the
 * reset_image_edits case pushes the reset onto it as one step, which
 * Undo takes back (; the reset used to empty the history and could
 * not be undone at all).
 *
 * "Factory" is freshNodesFor, not the bare template: the same door a
 * never-opened image comes through, so the rendered-source bypass and
 * the RAW profile preference apply here too. It used to clone the
 * template raw, which made Reset SHALLOWER than never having opened
 * the file - a reset JPEG kept its profile, and the save debounce then
 * wrote that graph straight back to disk. "I just figure
 * reset would be a full reset but it seems to be shallow."*/
function resetOneImage(s: State, id: string): State {
  const graphs = { ...s.graphs };
  const active = id === s.activeImage;
  const linked = !!s.images.find((i) => i.id === id)?.linkGroup;
  // A stashed member of a link keeps a stash, at factory, with its
  // overrides: the link's mirror needs somewhere to land the next edit
  // without re-reading a file the drain is archiving. Off a link the
  // stash goes, and the next visit reads the disk as it always did.
  if (linked && !active && graphs[id] && !graphs[id].preRead) {
    graphs[id] = { nodes: freshNodesFor(s, id), wires: structuredClone(s.defaultGraph.wires), backdrops: [], undoStack: [], redoStack: [], overrides: graphs[id].overrides };
  } else {
    delete graphs[id];
  }
  // A member of a quad edit lives in quadGraphs, not graphs, and
  // close_quad_edit copies that back over graphs. Resetting only the
  // stash left the member's stale edits to return the moment quad
  // closed ("The thumbnails appeared to update but when I
  // clicked on each of the other images in the canvas their edits were
  // not reset"). The live copy resets too.
  const quadGraphs = s.quadEdit && s.quadGraphs[id] && !active
    ? { ...s.quadGraphs, [id]: { nodes: freshNodesFor(s, id), wires: structuredClone(s.defaultGraph.wires), backdrops: [] } }
    : s.quadGraphs;
  // A mirrored edit still owed to this photograph, written or queued,
  // was for the graph that just went: the write would have put it back
  // over the archive, the queue would have replayed it onto factory.
  const linkPending = { ...s.linkPending };
  delete linkPending[id];
  return {
    ...s,
    graphs,
    quadGraphs,
    linkDirty: s.linkDirty.filter((other) => other !== id),
    linkPending,
    resetPending: s.resetPending.includes(id) ? s.resetPending : [...s.resetPending, id],
    // A write-back an Undo still owed this photograph is for edits that
    // are going away again.
    restorePending: s.restorePending.filter((other) => other !== id),
    images: s.images.map((i) => (i.id === id ? { ...i, edited: false } : i)),
    ...(active
      ? {
          nodes: freshNodesFor(s, id),
          wires: structuredClone(s.defaultGraph.wires),
          backdrops: [],
          selection: [],
          activeLayer: null,
          // The panel folds back to how a fresh photo opens: the
          // sections that start folded fold again, and anything the
          // user folded stays folded.
          sectionsClosed: Array.from(new Set([...s.sectionsClosed, ...DEFAULT_SECTIONS_CLOSED])),
          // A reset photo has no warp, so no warp handles.
          ...droppedGridWarpTool(s),
          // The depth eye goes off with the edits (2026-09-13: it stayed on
          // across the photographs that followed a reset).
          depthView: false,
          // And the separation view with it: a reset has no treatment.
          collisionView: false,
          collisionTolerance: COLLISION_TOLERANCE_DEFAULT,
          zonesView: false,
        }
      : {}),
  };
}

/** Reset Edits on a linked photograph resets the link with it
 * (2026-09-13: "Reset Edits on a linked photo would reset the other
 * photos' edits (as long as there are no overrides)"). Overrides hold
 * on both sides, as Match to This Photo's do: a member with nothing
 * of its own to keep goes back to factory outright, the same door as
 * the photograph that was reset (file archived, badge off); one that
 * keeps a node or a dial is written with the rest at factory around
 * it, and one whose graph is not read yet takes the reset when it is.
 * Pinned members sit it out, and a quad session keeps its own mirror.*/
function resetLinkWith(before: State, s: State, id: string): State {
  const group = before.images.find((i) => i.id === id)?.linkGroup;
  if (!group || before.quadEdit) return s;
  const sourceOverrides = id === before.activeImage ? before.linkOverrides : (before.graphs[id]?.overrides ?? []);
  const members = before.images
    .filter((i) => i.linkGroup === group && i.id !== id && !before.linkPinned.includes(i.id))
    .map((i) => i.id);
  const wireSet = (g: MemberGraph) => g.wires.map(wireKey).sort().join("\n");
  const atFactory = (g: MemberGraph, fresh: MemberGraph) =>
    JSON.stringify(g.nodes) === JSON.stringify(fresh.nodes) && wireSet(g) === wireSet(fresh);
  let next = s;
  for (const m of members) {
    const fresh: MemberGraph = { ...freshGraphFor(before, m), backdrops: [] };
    const active = m === before.activeImage;
    const stashed = before.graphs[m];
    const own: MemberGraph | null = active
      ? before.graphLoading === m ? null : { nodes: before.nodes, wires: before.wires, backdrops: before.backdrops }
      : stashed && !stashed.preRead ? { nodes: stashed.nodes, wires: stashed.wires, backdrops: stashed.backdrops } : null;
    if (!own) {
      next = { ...next, linkPending: { ...next.linkPending, [m]: [...(next.linkPending?.[m] ?? []), { match: fresh, overrides: [...sourceOverrides] }] } };
      continue;
    }
    const kept = [...(active ? before.linkOverrides : (stashed?.overrides ?? [])), ...sourceOverrides];
    const matched = kept.length ? matchGraph(fresh, own, kept) : fresh;
    if (atFactory(matched, fresh)) {
      next = resetOneImage(next, m);
    } else if (active) {
      next = { ...next, nodes: matched.nodes, wires: matched.wires, backdrops: matched.backdrops, selection: [], activeLayer: null };
    } else {
      next = {
        ...next,
        graphs: { ...next.graphs, [m]: { ...next.graphs[m], nodes: matched.nodes, wires: matched.wires, backdrops: matched.backdrops } },
        linkDirty: next.linkDirty.includes(m) ? next.linkDirty : [...next.linkDirty, m],
      };
    }
  }
  // resetOneImage has already cleared each loaded member's old debt.
  // Returning the copy from before the loop put those deltas back.
  return next;
}

const editedOf = (s: State, id: string): boolean => s.images.find((i) => i.id === id)?.edited ?? false;

/** Reset Edits, as one undo step on the active photograph's history (The
 * report: "I reset an image's edits and realized I made a mistake and
 * reset the wrong image. I hit undo and it did not restore the edits").
 * The reset used to empty the active history and record nothing for any
 * other photograph, so Undo had nothing to go back to, or, when the
 * reset came from a thumbnail while another photograph was open,
 * stepped back that photograph's own last edit instead. The step
 * carries the active graph as any step does, and for every other
 * photograph the reset touched (the ones asked for, and their links)
 * what it was before: its stash, badge, queued link edits, quad copy.*/
function resetImages(s: State, requested: string[]): State {
  const ids = [...new Set(requested)].filter((id) => s.images.some((i) => i.id === id));
  if (!ids.length) return s;
  let next = s;
  for (const id of ids) next = resetLinkWith(next, resetOneImage(next, id), id);
  const others: ResetUndoPhoto[] = [];
  for (const { id } of s.images) {
    if (id === s.activeImage) continue;
    const newlyQueued = next.resetPending.includes(id) && !s.resetPending.includes(id);
    const changed =
      newlyQueued ||
      ids.includes(id) ||
      next.graphs[id] !== s.graphs[id] ||
      next.quadGraphs[id] !== s.quadGraphs[id] ||
      next.linkPending?.[id] !== s.linkPending?.[id] ||
      editedOf(next, id) !== editedOf(s, id);
    if (!changed) continue;
    others.push({
      id,
      edited: editedOf(s, id),
      stash: s.graphs[id],
      stashAfter: next.graphs[id],
      quad: s.quadGraphs[id],
      linkPending: s.linkPending?.[id],
      linkPendingAfter: next.linkPending?.[id],
      dirty: s.linkDirty.includes(id),
      archived: next.resetPending.includes(id),
    });
  }
  const activeEdited = editedOf(s, s.activeImage);
  const activeMoved =
    (next.nodes !== s.nodes || next.wires !== s.wires) &&
    (activeEdited || JSON.stringify([next.nodes, next.wires]) !== JSON.stringify([s.nodes, s.wires]));
  // Resetting photographs that had nothing to lose is no step at all.
  const lost = others.some((o) => o.edited || o.stash || o.quad || o.linkPending || o.dirty);
  if (!activeMoved && !lost) return next;
  const label = ids.length > 1 ? `Reset Edits (${ids.length} photos)` : "Reset Edits";
  const step: Snapshot = {
    ...snapshot(s, label),
    reset: {
      ids,
      active: {
        edited: activeEdited,
        overrides: s.linkOverrides,
        archived: next.resetPending.includes(s.activeImage) && !s.resetPending.includes(s.activeImage) || ids.includes(s.activeImage),
      },
      others,
    },
  };
  return { ...next, undoStack: [...s.undoStack, step].slice(-HISTORY_LIMIT), redoStack: [] };
}

/** Takes a Reset Edits step back. `base` is the plain undo already
 * applied (the active graph is the step's snapshot); this puts back the
 * active photograph's badge and every other photograph the reset
 * touched. A photograph edited since the reset keeps its new edits: an
 * old step never overwrites newer work. The disk follows: an archive
 * not yet asked for is simply not asked for; one already made is owed
 * its write-back (restorePending, drained by ResetAftermath); the active
 * photograph's graph goes back through its ordinary autosave. */
function undoReset(base: State, r: ResetUndo): State {
  const active = base.activeImage;
  const badges = new Map<string, boolean>([[active, r.active.edited]]);
  const graphs = { ...base.graphs };
  const quadGraphs = { ...base.quadGraphs };
  const linkPending = { ...(base.linkPending ?? {}) };
  let linkDirty = base.linkDirty;
  let resetPending = base.resetPending;
  let restorePending = base.restorePending;
  if (r.active.archived) resetPending = resetPending.filter((i) => i !== active);
  for (const o of r.others) {
    if (o.id === active || !base.images.some((i) => i.id === o.id)) continue;
    const untouched = o.archived
      ? !editedOf(base, o.id)
      : base.graphs[o.id] === o.stashAfter && base.linkPending?.[o.id] === o.linkPendingAfter;
    if (!untouched) continue;
    if (o.stash) graphs[o.id] = o.stash;
    else delete graphs[o.id];
    if (o.quad && base.quadEdit && quadGraphs[o.id]) quadGraphs[o.id] = o.quad;
    if (o.linkPending) linkPending[o.id] = o.linkPending;
    else delete linkPending[o.id];
    badges.set(o.id, o.edited);
    const markDirty = () => {
      if (!linkDirty.includes(o.id)) linkDirty = [...linkDirty, o.id];
    };
    if (!o.archived) {
      // A link member that only took factory values around its
      // overrides: its old graph is written back the way it went.
      if (o.stash) markDirty();
    } else if (resetPending.includes(o.id)) {
      // The archive was never asked for, so the disk still holds the
      // edits; any write the member was owed is owed again.
      resetPending = resetPending.filter((i) => i !== o.id);
      if (o.dirty && o.stash) markDirty();
    } else if (!restorePending.includes(o.id)) {
      restorePending = [...restorePending, o.id];
    }
  }
  return {
    ...base,
    images: base.images.map((i) => (badges.has(i.id) && badges.get(i.id) !== i.edited ? { ...i, edited: badges.get(i.id)! } : i)),
    graphs,
    quadGraphs,
    linkPending,
    linkDirty,
    resetPending,
    restorePending,
    linkOverrides: r.active.overrides,
  };
}

/** Splices one on-demand category piece into the chain and builds its
 * node. The switch does this when a category turns on, and the curve
 * commands do it when an edit arrives for a node that was never
 * built: the eyedropper committed points to "curves" on a photograph
 * whose graph had no curves node, the reducer's map found nothing to
 * edit, and the click vanished ("I try to click and add
 * one and it doesn't work").*/
/** The Depth Map section's params for a photograph that has none yet:
 * the preference, clamped the way set_prefs clamps it. */
export function depthMapParams(prefs: Prefs): { edges: number; flatten: number; size: number } {
  return {
    edges: clampDepthSetting(prefs.depthEdges, DEFAULT_PREFS.depthEdges),
    flatten: clampDepthSetting(prefs.depthFlatten, DEFAULT_PREFS.depthFlatten),
    size: snapDepthSize(prefs.depthSize),
  };
}

/** Mask nodes whose Depth block drinks the farness plane. */
const DEPTH_MASK_TYPES = new Set([
  "heeler.range_mask",
  "heeler.radial_mask",
  "heeler.linear_mask",
  "heeler.brush_mask",
  "heeler.selection_mask",
  "heeler.smart_mask",
  "heeler.matte_mask",
  // A Color Set's range mask, with the same block at the set's foot.
  "heeler.hue_range_mask",
]);

/** The dial that wakes each picture depth tool. */
const DEPTH_HOT_PARAMS: Record<string, string> = {
  "heeler.fog": "density",
  "heeler.key_light": "strength",
  "heeler.dof": "aperture",
};

/** Whether this one node drinks the farness plane right now: the
 * per-node half of the runner's depthWanted (26.3 Phase 10.3), in
 * state.ts so the runner and the depth wiring agree on what a depth
 * consumer at work is. A switched-off or all-neutral node drinks
 * nothing. */
export function nodeWantsDepth(n: NodeCard): boolean {
  if (!n.enabled) return false;
  const rigHot = () => {
    try {
      return (JSON.parse(n.textParams?.lights ?? "[]") as { strength?: number; power?: number }[]).some(
        (l) => Math.abs(l.power ?? l.strength ?? 0) > 0,
      );
    } catch {
      return false;
    }
  };
  switch (n.type) {
    case "heeler.flare": {
      if (((n.params.intensity as number) ?? 100) <= 0) return false;
      if (((n.params.occlusion as number) ?? 100) <= 0 && ((n.params.veil_depth as number) ?? 0) === 0) return false;
      try {
        return (JSON.parse(n.textParams?.lights ?? "[]") as { flare?: boolean; on?: boolean }[]).some(
          (l) => l.flare && l.on !== false,
        );
      } catch {
        return false;
      }
    }
    case "heeler.halation":
      return ((n.params.by_depth as number) ?? 0) !== 0;
    case "heeler.black_white":
      // The Far filter grades the conversion along the plane once it
      // differs from Near. Not a wired consumer in 10.3: it keeps the
      // planted raster.
      return (
        ((n.params.amount as number) ?? 0) > 0 &&
        (n.textParams?.far_filter ?? "") !== "" &&
        (n.textParams?.far_filter ?? "") !== (n.textParams?.filter ?? "")
      );
    case "heeler.recolor":
      // The depth row drinks the moment a depth cell says something
      //.
      return Object.entries(parseRecolorCurves(n.textParams?.curves)).some(
        ([cell, pts]) => cell.startsWith("depth_") && (pts ?? []).some((p) => p.y !== 0),
      );
    // A Smart or Object mask carries a Depth Range drawn on it the way a
    // selection does (selectShapeTarget).
    case "heeler.selection_mask":
    case "heeler.smart_mask":
    case "heeler.matte_mask":
      return (
        ((n.params.depth_on as number) ?? 0) !== 0 ||
        (n.regions ?? []).some(
          (r) => r.kind === "range" && (r as { channel?: string }).channel === "depth" && !r.off,
        )
      );
    default:
      if (DEPTH_MASK_TYPES.has(n.type)) return ((n.params.depth_on as number) ?? 0) !== 0;
      if (DEPTH_HOT_PARAMS[n.type] !== undefined) {
        return Math.abs((n.params[DEPTH_HOT_PARAMS[n.type]] as number) ?? 0) > 0 || (n.type === "heeler.key_light" && rigHot());
      }
      return false;
  }
}

/** Whether a depth consumer is asking for the plane with no wire
 * carrying one (26.3 Phase 10.3): its section shows NO DEPTH MAP and
 * the node renders flat. */
export function depthMapMissing(s: State, n: NodeCard | undefined | null): boolean {
  if (!n || !DEPTH_IN_TYPES.has(n.type) || !nodeWantsDepth(n)) return false;
  return !s.wires.some((w) => w.to === n.id && w.toPort === "depth");
}

/** The commands after which a consumer may newly want the plane: a dial
 * or rig moved, a section switched on, a depth region added. Loads and
 * deletes are not here on purpose: loading old graphs is 10.4's pass,
 * and deleting the Depth Map must leave consumers unwired. */
const DEPTH_WIRE_COMMANDS = new Set([
  "set_param",
  // Unbake puts a Warp layer's mask back: a Depth block on it wires as
  // it did before the bake.
  "art_unbake_warp",
  // A depth look (Cool Distance, Warm Subject) asks for the plane the
  // way a depth curve drawn by hand does.
  "apply_section_look",
  "set_params",
  "set_text_param",
  "set_enabled",
  "set_category",
  "add_region",
  "set_regions",
  "set_region_off",
]);

/** 26.3 Phase 10.3: a consumer that just started wanting the plane gets
 * the wire that carries it, depth_map.depth to its depth input, and the
 * Depth Map node is born at its fixed seat when the graph has none.
 * Never a second wire, and a consumer that stops asking keeps the one
 * it has. */
function wireDepthTransitions(before: State, after: State): State {
  const beforeById = new Map(before.nodes.map((n) => [n.id, n]));
  const targets = new Set<string>();
  for (const n of after.nodes) {
    if (!DEPTH_IN_TYPES.has(n.type)) continue;
    const b = beforeById.get(n.id);
    // A tool whose whole effect is the plane (Fog, Depth Lighting,
    // Depth of Field) wires when its section switches on; everything
    // else wires once its depth use actually asks
    // (enabling a depth section wires, turning a mask's Depth block on
    // wires), so a neutral Recolor or Halation toggle drags no Depth
    // Map into the graph.
    const enabledNow = DEPTH_HOT_PARAMS[n.type] !== undefined && n.enabled && !(b?.enabled ?? false);
    const wantsNow = nodeWantsDepth(n) && (!b || !nodeWantsDepth(b));
    if (enabledNow || wantsNow) targets.add(n.id);
  }
  // A Depth Map just born wires every consumer already asking.
  const born =
    !before.nodes.some((n) => n.type === "heeler.depth_map") &&
    after.nodes.some((n) => n.type === "heeler.depth_map");
  if (born) {
    for (const n of after.nodes) {
      if (DEPTH_IN_TYPES.has(n.type) && nodeWantsDepth(n)) targets.add(n.id);
    }
  }
  if (targets.size === 0) return after;
  let nodes = after.nodes;
  let wires = after.wires;
  let dm = nodes.find((n) => n.type === "heeler.depth_map");
  if (!dm) {
    const piece = CATEGORY_PIECES["Depth Map"]?.[0];
    if (!piece) return after;
    ({ nodes, wires } = buildCategoryPiece(nodes, wires, piece));
    // Born with the preference's defaults, the same birth the Depth Map
    // section's own switch gives it.
    nodes = nodes.map((n) =>
      n.id === piece.id ? { ...n, enabled: true, params: { ...n.params, ...depthMapParams(after.prefs) } } : n,
    );
    dm = nodes.find((n) => n.id === piece.id);
  }
  if (!dm) return after;
  const add: Wire[] = [];
  for (const id of targets) {
    if (!nodes.some((n) => n.id === id)) continue;
    // One wire per depth input, ever.
    if (wires.some((w) => w.to === id && w.toPort === "depth")) continue;
    add.push({ from: dm.id, fromPort: "depth", to: id, toPort: "depth", kind: "mask" });
  }
  if (add.length === 0 && nodes === after.nodes) return after;
  return { ...after, nodes, wires: [...wires, ...add] };
}

/** A section look (src/sectionlooks.ts) written onto its section: the
 * section built when it has no node yet (set_category's rule, a look
 * that names a section means it on), switched on, and its settings
 * REPLACED by the look's, the curve face back to the default. The one
 * writer both doors use: the apply (apply_section_look) and the held
 * preview (lookPreviewState), so the preview is the picture the apply
 * would make, by construction. */
export function sectionLookGraph(
  nodes: NodeCard[],
  wires: Wire[],
  look: SectionLook,
): { nodes: NodeCard[]; wires: Wire[] } {
  for (const piece of CATEGORY_PIECES[look.section] ?? []) {
    if (!nodes.some((n) => n.id === piece.id)) ({ nodes, wires } = buildCategoryPiece(nodes, wires, piece));
    nodes = nodes.map((n) => {
      if (n.id !== piece.id) return n;
      const { curveInterp: _face, ...rest } = n;
      return {
        ...rest,
        enabled: true,
        params: { ...n.params, ...look.values },
        textParams: { ...n.textParams, ...look.text },
      };
    });
  }
  return { nodes, wires };
}

function buildCategoryPiece(
  nodes: NodeCard[],
  wires: Wire[],
  p: { id: string; type: string; name: string; cat: string; tool?: string },
): { nodes: NodeCard[]; wires: Wire[] } {
  const spliced = spliceIn(wires, p.id);
  // Placed a column ahead of whatever it now feeds, so it arrives
  // somewhere sensible rather than on top of another node. The layout
  // is tidied properly by arrange; this only has to not be a pile.
  const feeds = spliced.find((w) => w.from === p.id);
  const after = nodes.find((n) => n.id === feeds?.to);
  // A column ahead of the fed node is exactly where its feeder already
  // sits when the two were adjacent, and the new card landed on top of
  // it: Grid Warp switched on covered the Image Source card
  // ("there is no Image Source node in the graph"). A slot that is taken
  // moves the card down a row until one is free.
  const x = (after?.x ?? 0) - (NODE_W + 60);
  let y = after?.y ?? 0;
  const taken = (yy: number) => nodes.some((n) => Math.abs(n.x - x) < NODE_W && Math.abs(n.y - yy) < NODE_H);
  for (let tries = 0; tries < 8 && taken(y); tries++) y += NODE_H + 20;
  const built = [...nodes, ...migrateNodes([categoryPieceNode(p, x, y)])];
  return {
    // Geometry built (the first crop, the lens correction, a warp)
    // moves the masks onto its frame in the same step
    // (masksReadTheFrame), so undoing it puts them back.
    wires: FRAME_GEOMETRY_TYPES.has(p.type) ? masksReadTheFrame(built, spliced) : spliced,
    nodes: built,
  };
}

/** The node a category piece is, before migration: a tool group through
 * its tool's own builder (Sharpening, Skin Softening), any other piece
 * at its type's identity. The one builder behind both the switch's
 * build and the panel's preview (previewNodes), so what the panel shows
 * before the section exists is what the section's first build makes (:
 * the preview built the two groups as bare heeler.group cards with no
 * tool and no dials, toolNode could not find them, and the sections
 * showed a switch and no sliders).*/
export function categoryPieceNode(
  p: { id: string; type: string; name: string; cat: string; tool?: string },
  x: number,
  y: number,
): NodeCard {
  return p.tool
    ? layerToolNode(p.id, p.tool, x, y)
    : {
        id: p.id,
        type: p.type,
        name: p.name,
        cat: p.cat as NodeCard["cat"],
        x,
        y,
        enabled: true,
        params: { ...(NEUTRAL_PARAMS[p.type] ?? {}) },
        hasIn: true,
        hasOut: true,
      };
}

/** Switches a bypassed node on the moment it actually says something.
 *
 * Nodes that ship bypassed are effects you opt into rather than corrections
 * every photo wants, and a switch reading "on" for a frame nobody has
 * touched is an edit that is not there. The other half of that bargain is
 * that moving one of its controls must not be silently ignored, which is
 * what this is.
 *
 * On new layers: "make sure they defaults are off. This will help manage
 * the node data and improve performance." A layer's adjustment now
 * arrives bypassed, so it costs nothing until it does something, and this
 * is what makes that safe rather than baffling.
 */
/** Whether the Develop layer a node belongs to is switched off. */
export function layerIsOff(s: State, id: string): boolean {
  const adj = layerAdjOfNode(id);
  return adj !== null && !!s.nodes.find((n) => n.id === adj)?.layerOff;
}

/** armed(), unless the node's layer is switched off: a write to a
 * hidden layer lands (and waits), it does not switch the layer back
 * on one node at a time. set_layer_enabled picks such nodes up. */
function armedIn(s: State, n: NodeCard): NodeCard {
  return layerIsOff(s, n.id) ? n : armed(n);
}

function armed(n: NodeCard): NodeCard {
  if (n.enabled) return n;
  if (n.type === "heeler.color_bend") {
    // A bend says something when its target has moved off its source.
    // Reach and amount do nothing on their own, so they leave it off.
    const moved =
      (n.params.src_hue ?? 0) !== (n.params.dst_hue ?? 0) ||
      (n.params.src_sat ?? 0) !== (n.params.dst_sat ?? 0);
    return moved ? { ...n, enabled: true } : n;
  }
  // A tool group's identity is the recipe's own numbers, its mirror.
  if (n.tool && LAYER_TOOLS[n.tool]) {
    const identity = LAYER_TOOLS[n.tool].params;
    const moved = Object.entries(n.params).some(([k, v]) => k in identity && v !== identity[k]);
    return moved ? { ...n, enabled: true } : n;
  }
  // Everything else: any parameter away from its identity is something.
  const identity = NEUTRAL_PARAMS[n.type];
  if (!identity) return n;
  const moved = Object.entries(n.params).some(
    ([k, v]) => k in identity && v !== identity[k],
  );
  return moved ? { ...n, enabled: true } : n;
}

/** Ids of every node in a layer's group, mask included. */
function layerGroup(s: State, layerId: string): Set<string> {
  const prefix = layerGroupPrefix(layerId);
  const owned = new Set(s.nodes.filter(n => n.id.startsWith(prefix)).map(n => n.id));
  const exports = new Set(s.nodes.filter(n => n.type === "heeler.export_layer").map(n => n.id));
  const taps = tapCards(s);
  // An export dropped BETWEEN two tools belongs to the same layer.
  // Walk through adjacent export cards in either direction; terminal
  // taps and cards outside the layer's tools remain separate.
  const end = (id: string, upstream: boolean): string | undefined => {
    const seen = new Set<string>();
    let at = id;
    while (!seen.has(at)) {
      seen.add(at);
      const w = s.wires.find(w => w.kind === "image" && w.toPort === "in" &&
        (upstream ? w.to === at : w.from === at && !taps.has(w.to)));
      if (!w) return undefined;
      at = upstream ? w.from : w.to;
      if (!exports.has(at)) return at;
    }
    return undefined;
  };
  for (const id of exports) {
    if (owned.has(end(id, true) ?? "") && owned.has(end(id, false) ?? "")) owned.add(id);
  }
  return owned;
}

/** The Export Layer cards that only listen: nothing reads from one, so
 * the wire into it is a tap hanging off the chain and never the chain
 * itself. Every finder of "the wire the picture leaves by" skips them.
 * Without that, a section's Export box ticked on the node a layer
 * hangs from sent the next layer down the tap: Exposure exported on
 * Base, a layer added, removed and added again, and the new layer sat
 * between Exposure and its export card, off the picture (found
 * 2026-10-03 while giving a layer's sections the box). */
function tapCards(s: Pick<State, "nodes" | "wires">): Set<string> {
  const read = new Set(s.wires.map((w) => w.from));
  return new Set(s.nodes.filter((n) => n.type === "heeler.export_layer" && !read.has(n.id)).map((n) => n.id));
}

/** Wires into tap cards sit after every other wire. Much of the
 * reducer finds "the wire the picture leaves this node by" as the
 * first image wire out of it (the walk from Exposure that collects the
 * layers for a paste, a Remove's heal, a node moved outside its
 * mask), and a tapped node has two. A tap is appended when its box is
 * ticked, but a splice that re-makes the chain's wire appends too, and
 * then the tap came first. Kept last, the chain's wire is always the
 * one found. The same array back when it is already so. */
function tapWiresLast(s: State): State {
  const taps = tapCards(s);
  if (taps.size === 0) return s;
  // The picture's taps only: a mask's or a depth plane's wire into a
  // card is no image wire, and no finder of the chain reads it.
  const tap = (w: Wire) => w.kind === "image" && taps.has(w.to);
  let seenTap = false;
  let ordered = true;
  for (const w of s.wires) {
    if (tap(w)) seenTap = true;
    else if (seenTap) {
      ordered = false;
      break;
    }
  }
  if (ordered) return s;
  return { ...s, wires: [...s.wires.filter((w) => !tap(w)), ...s.wires.filter(tap)] };
}

/** The last node in a layer's image chain: whatever hands off to a node
 * outside the layer. That is the exposure node until a tool is spliced in
 * behind it. */
function layerChainTail(s: State, layerId: string): string | undefined {
  const group = layerGroup(s, layerId);
  const taps = tapCards(s);
  return s.wires.find(
    (w) => group.has(w.from) && !group.has(w.to) && !taps.has(w.to) && w.kind === "image",
  )?.from;
}

/** Commands that count as touching a tool, and so bring a layer's copy of
 * it into being. */
const MATERIALIZING = new Set([
  "set_param",
  "set_params",
  "set_published",
  "set_curve",
  "set_curve_interp",
  "reset_curves",
  "set_enabled",
  "set_text_param",
  "add_stroke",
]);

/** Splices a layer tool into its layer's group the first time it is
 * written to: wired into the layer's image chain, and fed by the same
 * mask as the rest of the layer. Its own history entry, so undo takes the
 * node back out. */
function materializeLayerTool(s: State, cmd: Command): State {
  if (!MATERIALIZING.has(cmd.type) || !("id" in cmd)) return s;
  const id = (cmd as { id: string }).id;
  if (s.nodes.some((n) => n.id === id)) return s;
  const part = layerPart(id);
  const num = layerNumber(id);
  const spec = part !== null ? LAYER_TOOLS[part] : undefined;
  if (part === null || num === null || !spec) return s;
  // A write that lands on the tool's own default changes nothing, so it
  // should not conjure a node. This is what keeps a section's Reset (and
  // resetting curves that were never drawn) from littering the graph.
  if (cmd.type === "reset_curves") return s;
  if (cmd.type === "set_param" && spec.params[cmd.param] === cmd.value)
    return s;
  // The same rule for a text param: choosing Vivid on a layer whose
  // sharpening copy does not exist yet lands on the tool's own default
  // (PARAM_TEXT_DEFAULT), so it must not conjure the node either. A
  // param with no default answers "", so an empty first write, which
  // says nothing, stays home too.
  if (
    cmd.type === "set_text_param" &&
    (spec.textDefaults?.[cmd.param] ?? PARAM_TEXT_DEFAULT[spec.type]?.[cmd.param] ?? "") === cmd.value
  )
    return s;
  // A published control on a tool group: the same rule, against the
  // dial the fresh group would carry.
  if (cmd.type === "set_published") {
    const fresh = layerToolNode(id, part, 0, 0);
    if (publishedValue(fresh, cmd.label) === cmd.value) return s;
  }
  if (
    cmd.type === "set_params" &&
    Object.entries(cmd.values).every(([k, v]) => spec.params[k] === v)
  )
    return s;
  const maskId = layerNodeId(num, "mask");
  const adjId = layerNodeId(num, "adj");
  const anchor = s.nodes.find((n) => n.id === adjId);
  if (!anchor || !s.nodes.some((n) => n.id === maskId)) return s;
  // The layer's image chain is every node sharing its prefix bar the
  // mask; the new tool goes on the end of it.
  const group = layerGroup(s, anchor.id);
  group.delete(maskId);
  const taps = tapCards(s);
  const tail = s.wires.find(
    (w) => group.has(w.from) && !group.has(w.to) && !taps.has(w.to) && w.kind === "image",
  );
  if (!tail) return s;
  const node = layerToolNode(
    id,
    part,
    anchor.x ?? 199,
    (anchor.y ?? 484) + 96 * (group.size + 1),
  );
  return {
    ...s,
    nodes: [...s.nodes, node],
    wires: [
      ...s.wires.filter((w) => w !== tail),
      { ...wireSource(tail), to: id, toPort: "in", kind: "image" },
      { from: id, to: tail.to, toPort: tail.toPort, kind: "image" },
      { from: maskId, to: id, toPort: "mask", kind: "mask" },
    ],
    undoStack: [
      ...s.undoStack,
      snapshot(s, `Add ${node.name} to ${anchor.name}`),
    ].slice(-HISTORY_LIMIT),
    redoStack: [],
  };
}

/** An id for a card made in the session: the type's short name and a
 * few random characters, the same shape the palette gives new cards. */
export function freshNodeId(type: string): string {
  return `${type.replace("heeler.", "")}_${Math.random().toString(36).slice(2, 7)}`;
}

/** Copy a whole editable container, including user-added members. Stock
 * recipe ids retain their suffix contract with toolMemberId. */
function copyNodeWithId(node: NodeCard, id: string): NodeCard {
  const ids = new Map([[node.id, id]]);
  for (const member of node.groupNodes ?? []) {
    ids.set(member.id, member.id.endsWith(`_${node.id}`)
      ? member.id.slice(0, -node.id.length) + id : freshNodeId(member.type));
  }
  const remap = (value: string) => ids.get(value) ?? value;
  const copyWire = (w: Wire): Wire => ({ ...w, from: remap(w.from), to: remap(w.to) });
  return {
    ...structuredClone(node), id,
    ...(node.groupNodes ? { groupNodes: node.groupNodes.map(n => copyNodeWithId(n, remap(n.id))) } : {}),
    ...(node.groupWires ? { groupWires: node.groupWires.map(copyWire) } : {}),
    ...(node.groupBoundary ? { groupBoundary: node.groupBoundary.map(copyWire) } : {}),
    ...(node.published ? { published: node.published.map(p => ({
      ...p, node: remap(p.node),
      ...(p.also ? { also: p.also.map(a => ({ ...a, node: remap(a.node) })) } : {}),
      ...(p.options ? { options: p.options.map(o => ({ ...o, writes: o.writes.map(w => ({ ...w, node: remap(w.node) })) })) } : {}),
    })) } : {}),
  };
}

/** Whether a card may be copied. The photograph and the output are one
 * each; a layer's cards and the Finish stack are derived from their
 * ids, so a copy with a new id would be a card the layer machinery
 * cannot see; the document selection is one by definition. */
export function duplicable(id: string): boolean {
  return (
    id !== "src" &&
    id !== "output" &&
    id !== ART_ID &&
    id !== DOC_SEL_ID &&
    !isLayerNode(id) &&
    !id.startsWith("art_") &&
    !id.startsWith("inpaint_")
  );
}

/** Why a card cannot be copied, in words for the notice. Undefined for
 * one that can. */
export function whyNotDuplicable(id: string): string | undefined {
  if (duplicable(id)) return undefined;
  if (id === "src") return "the photograph is one per graph";
  if (id === "output") return "Output is one per graph";
  if (id === ART_ID || id.startsWith("art_")) return "the Finish stack is copied as layers, in Finish";
  if (id === DOC_SEL_ID) return "the selection is one per document";
  if (isLayerNode(id)) return "a layer's cards are copied with Duplicate Layer";
  return "this card belongs to the photograph";
}

/** The notice a duplicate gives when it left something behind: what was
 * skipped and why, so a key that copied nothing never reads as broken. */
export function duplicateSkipNotice(skipped: string[], copied: number): string | null {
  if (!skipped.length) return null;
  const reasons = [...new Set(skipped.map((id) => whyNotDuplicable(id)!))];
  const head = copied
    ? `Duplicated ${copied} node${copied === 1 ? "" : "s"}; ${skipped.length} not copied`
    : "Nothing to duplicate";
  return `${head}: ${reasons.join("; ")}`;
}

/** The geometry piece: the one on-demand section whose node a viewport
 * tool writes to as well as the panel. */
const CROP_PIECE: CategoryPiece = CATEGORY_PIECES.Geometry[0];
/** Noise Reduction's Model method: one node right after the source,
 * where the SCUNet answer the desktop computed from the source is
 * the picture it sees. */
export const MODEL_DENOISE_ID = "modeldenoise";
const MODEL_DENOISE_PIECE: CategoryPiece = { id: MODEL_DENOISE_ID, type: "heeler.model_denoise", name: "Model Denoise", cat: "detail" };

/** Whether Noise Reduction's method is Model: the model node exists
 * and remembers the choice, switched on or off. */
export function denoiseMethodIsModel(nodes: NodeCard[]): boolean {
  const n = nodes.find((k) => k.id === MODEL_DENOISE_ID);
  return !!n && (n.params.method ?? 0) !== 0;
}

/** Whether the Noise Reduction section is on, in either method. */
export function denoiseSectionOn(nodes: NodeCard[]): boolean {
  return nodes.some((n) => (n.id === "dn_luma_nr" || n.id === MODEL_DENOISE_ID) && n.enabled);
}
const GRID_WARP_PIECE: CategoryPiece = CATEGORY_PIECES["Grid Warp"][0];
const SHAPE_WARP_PIECE: CategoryPiece = CATEGORY_PIECES["Shape Warp"][0];

/** The Shape Warp tool's view state. */
export interface ShapeWarpUi {
  /** the shape in hand, by id */
  selected: string | null;
  /** placing the shape, or moving the pixels under it */
  mode: "position" | "warp";
}

/** The photograph's shapes: the node's list, or none. */
export function shapeWarpShapes(s: State): WarpShape[] {
  return shapesFromNode(warpNodeFor(s, "shape"));
}

/** This photograph's own line thickness, in pixels, or 0 when it
 * follows the preference. */
export function photoLineWidth(s: State, id = s.activeImage): number {
  const own = s.photoLineWidth[id] ?? 0;
  return own > 0 ? clampShapeLineWidth(own) : 0;
}

/** How thick this photograph's overlay lines draw, in pixels: its own
 * thickness where set, the preference otherwise. */
export function shapeLineWidth(s: State): number {
  return photoLineWidth(s) || s.prefs.shapeLineWidth;
}

/** The Shape Warp node, or a stand-in with no shapes when the photo has
 * none yet; reads OFF like Grid Warp's stand-in, for the same reason. */
export function shapeWarpNode(s: State): NodeCard {
  const real = s.nodes.find((n) => n.type === "heeler.shape_warp");
  if (real) return real;
  return {
    id: SHAPE_WARP_PIECE.id,
    type: SHAPE_WARP_PIECE.type,
    name: SHAPE_WARP_PIECE.name,
    cat: SHAPE_WARP_PIECE.cat as NodeCard["cat"],
    x: 0,
    y: 0,
    enabled: false,
    params: {},
    textParams: { ...(PARAM_TEXT_DEFAULT[SHAPE_WARP_PIECE.type] ?? {}) },
    hasIn: true,
    hasOut: true,
  };
}

/** The Color Checker node, or a stand-in at identity when the section
 * has never been on; reads OFF like the warp stand-ins, so a node that
 * is not in the graph never reads as an edit. */
export function colorCheckerNode(s: State): NodeCard {
  const real = s.nodes.find((n) => n.type === "heeler.color_checker");
  if (real) return real;
  const piece = CATEGORY_PIECES["Color Checker"][0];
  return {
    id: piece.id,
    type: piece.type,
    name: piece.name,
    cat: piece.cat as NodeCard["cat"],
    x: 0,
    y: 0,
    enabled: false,
    params: { ...(NEUTRAL_PARAMS[piece.type] ?? {}) },
    textParams: { ...(PARAM_TEXT_DEFAULT[piece.type] ?? {}) },
    hasIn: true,
    hasOut: true,
  };
}

/** The overlay lines' color: hue in degrees and luma in percent, or
 * null for the automatic choice, which opposes the photograph's own
 * average. Shared by every tool that draws lines over the picture. */
export interface LineColorUi {
  hue: number | null;
  luma: number | null;
}

/** The Grid Warp tool's view state. */
export interface GridWarpUi {
  /** vertex indices on the mesh, row-major */
  selected: number[];
  /** how many grid steps past the selection a drag reaches */
  influence: number;
  /** how the reach is drawn: white to black, or red to blue */
  heat: "off" | "luma" | "chroma";
  /** columns and rows change together */
  link: boolean;
  /** the mesh mid-drag in the section's wheel or pad: shown over the
   * photograph and through the preview canvas, written to the node on
   * release, null between drags */
  live: GridMesh | null;
}

export const GRID_WARP_MAX_INFLUENCE = 8;

/** The photograph's mesh: the node's, or a rest grid at the node's
 * default counts when the photo has none yet. The overlay picks the
 * default counts from the frame it can see; the reducer only needs a
 * mesh to walk. */
export function gridWarpMesh(s: State): GridMesh {
  const node = warpNodeFor(s, "grid");
  return node ? meshFromNode(node) : restMesh(4, 3);
}

/** The Grid Warp tool put away, with its picks and any drag in hand:
 * what switching the warp off or resetting the photo does to it, so
 * handles never stay up over a warp the render no longer applies.
 * "Turning off enable or reset edits on an image should
 * turn off the warp handles." Nothing when the tool is not up.*/
function droppedGridWarpTool(s: State): Partial<State> {
  if (s.tool === "shapewarp") {
    return { tool: "none", toolRevert: null, warpTarget: null, shapeWarp: { ...s.shapeWarp, selected: null } };
  }
  if (s.tool !== "gridwarp") return {};
  return { tool: "none", toolRevert: null, warpTarget: null, gridWarp: { ...s.gridWarp, selected: [], live: null } };
}

/** The warp node type the tool in hand edits, or null for any other
 * tool: what the drop above and the reduce wrapper watch. */
function warpTypeOfTool(tool: State["tool"]): string | null {
  return tool === "gridwarp" ? "heeler.grid_warp" : tool === "shapewarp" ? "heeler.shape_warp" : null;
}

/** The viewport arms that put handles over a section's node: the light
 * rig over Depth Lighting, the one-click focus over Depth of Field.
 * An arm comes down when its node switches off or leaves the graph,
 * by the section switch, the node's own dot, a delete or an undo, so
 * no handles stay up over an effect the render no longer applies (The
 * report: "When I disable this section I expect Position Lights to
 * turn off as well"). The same rule the warp handles follow above.*/
const DEPTH_ARMS: ReadonlyArray<[key: LayerToolKey, drop: Partial<State>]> = [
  ["keylight", { keyLightPick: false, keyLightSel: null }],
  ["dof", { dofPick: false }],
];
function droppedDepthArms(s: State, next: State): Partial<State> {
  const armed = (st: State, key: LayerToolKey) => (key === "keylight" ? st.keyLightPick : st.dofPick);
  const live = (st: State, key: LayerToolKey) => {
    const n = toolNode(st, key);
    return !!n && n.enabled && st.nodes.some((k) => k.id === n.id);
  };
  let out: Partial<State> = {};
  for (const [key, drop] of DEPTH_ARMS) {
    if (armed(s, key) && armed(next, key) && live(s, key) && !live(next, key)) out = { ...out, ...drop };
  }
  return out;
}

/** The Grid Warp node, or a stand-in at rest when the photo has none
 * yet, which the section reads. Reads OFF,
 * like a layer tool's stand-in, because the switch is the section's
 * state and a switch on for a node not in the graph would lie. The
 * first drag, or the switch, builds the real node. */
export function gridWarpNode(s: State): NodeCard {
  const real = s.nodes.find((n) => n.type === "heeler.grid_warp");
  if (real) return real;
  return {
    id: GRID_WARP_PIECE.id,
    type: GRID_WARP_PIECE.type,
    name: GRID_WARP_PIECE.name,
    cat: GRID_WARP_PIECE.cat as NodeCard["cat"],
    x: 0,
    y: 0,
    enabled: false,
    params: { ...(NEUTRAL_PARAMS[GRID_WARP_PIECE.type] ?? {}) },
    textParams: { ...(PARAM_TEXT_DEFAULT[GRID_WARP_PIECE.type] ?? {}) },
    hasIn: true,
    hasOut: true,
  };
}

/** The main-chain tools a write can conjure: the tool pieces and the
 * crop. Only these, and not every category piece: an on-demand section
 * (Relight, Recolor, Color Tune) is built by set_category, its own
 * switch, never by a write to its seat. */
const MAIN_PIECES: Record<string, CategoryPiece> = {
  ...Object.fromEntries(Object.values(TOOL_PIECES).map((p) => [p.id, p])),
  [CROP_PIECE.id]: CROP_PIECE,
  [MODEL_DENOISE_PIECE.id]: MODEL_DENOISE_PIECE,
};

/** The crop node, or a stand-in at identity when the photo has none
 * yet. The Crop and Straighten overlays draw from it; their first drag
 * builds the real node. Never undefined: a fresh photo can be cropped. */
export function cropNode(s: State): NodeCard {
  const real = s.nodes.find((n) => n.type === "heeler.crop_rotate");
  if (real) return real;
  return {
    id: CROP_PIECE.id,
    type: CROP_PIECE.type,
    name: CROP_PIECE.name,
    cat: CROP_PIECE.cat as NodeCard["cat"],
    x: 0,
    y: 0,
    enabled: true,
    params: { ...(NEUTRAL_PARAMS[CROP_PIECE.type] ?? {}) },
    hasIn: true,
    hasOut: true,
  };
}

/** The crop rectangle held to a pixel ratio: width leads, height
 * follows, the top-left corner stays put, and the height gives way
 * (pulling the width in with it) when the ratio does not fit below.
 * Null when the rectangle already has that shape, so a caller that
 * runs on every render can tell "nothing to do" from a change.
 *
 * `dims` is the photograph's pixel size, since the ratio is a pixel
 * ratio and the params are fractions of the frame. */
export function fitCropToAspect(
  params: Record<string, number>,
  ratio: number,
  dims: { w: number; h: number },
): { crop_w: number; crop_h: number } | null {
  if (!(ratio > 0) || !(dims.w > 0) || !(dims.h > 0)) return null;
  const w = params.crop_w ?? 1;
  const h = params.crop_h ?? 1;
  const y = params.crop_y ?? 0;
  if (Math.abs((w * dims.w) / (h * dims.h) - ratio) < 1e-3) return null;
  let h2 = (w * dims.w) / (ratio * dims.h);
  let w2 = w;
  if (h2 > 1 - y) {
    h2 = 1 - y;
    w2 = (h2 * ratio * dims.h) / dims.w;
  }
  return { crop_w: w2, crop_h: h2 };
}

/** Splices a main-chain tool into the image chain the first time a
 * write says something: Detail's Unsharp row, Color's B&W treatment,
 * the crop tool's first drag. A write that lands on the identity builds
 * nothing (a section's Reset over a stand-in, a crop dragged back to
 * full frame), which is what keeps the graph as clean as the switch
 * rules promise. Same shape as materializeLayerTool, same undo
 * bargain: the build is its own step, the write that caused it the
 * next. */
function materializeMainTool(s: State, cmd: Command): State {
  if (cmd.type !== "set_param" && cmd.type !== "set_params") return s;
  const piece = MAIN_PIECES[cmd.id];
  if (!piece || s.nodes.some((n) => n.id === cmd.id)) return s;
  const identity = NEUTRAL_PARAMS[piece.type] ?? {};
  if (cmd.type === "set_param" && identity[cmd.param] === cmd.value) return s;
  if (
    cmd.type === "set_params" &&
    Object.entries(cmd.values).every(([k, v]) => identity[k] === v)
  )
    return s;
  const built = buildCategoryPiece(s.nodes, s.wires, piece);
  if (built.nodes === s.nodes) return s;
  return {
    ...s,
    nodes: built.nodes,
    wires: built.wires,
    undoStack: [...s.undoStack, snapshot(s, `Add ${piece.name}`)].slice(-HISTORY_LIMIT),
    redoStack: [],
  };
}

export interface LayerInfo {
  /** adjustment node id; doubles as the layer id */
  id: string;
  maskId: string;
  maskType: LayerMaskType;
  name: string;
}

/** Layers are derived from the graph by id convention (layer_<n>_adj /
 * layer_<n>_mask), so Graph mode and persistence see plain nodes. */
export function layersOf(s: State): LayerInfo[] {
  const typeOf = (t: string): LayerMaskType =>
    (Object.entries(LAYER_MASK_NODE).find(
      ([, v]) => v === t,
    )?.[0] as LayerMaskType) ?? "brush";
  return s.nodes
    .filter((n) => isLayerAdj(n.id))
    .map((adj) => {
      const maskId = maskOfLayer(adj.id);
      const mask = s.nodes.find((n) => n.id === maskId);
      const idx = layerNumber(adj.id)!;
      const maskType = mask ? typeOf(mask.type) : "brush";
      return {
        id: adj.id,
        maskId,
        maskType,
        // The node's name IS the layer name, so renaming is graph truth
        // and Graph mode shows the same label Develop does.
        name:
          adj.name || `${maskType[0].toUpperCase()}${maskType.slice(1)} ${idx}`,
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
}

/** Folder paths strictly between `root` and `path` (both exclusive),
 * outermost first. Session restore expands these to rebuild the tree
 * down to where the user was. Handles both separator styles. */
export function ancestorsBetween(root: string, path: string): string[] {
  const norm = (p: string) => p.replace(/[\\/]+$/, "");
  const r = norm(root);
  const p = norm(path);
  const sep = r.includes("\\") || p.includes("\\") ? "\\" : "/";
  if (p === r || !(p.startsWith(r + "\\") || p.startsWith(r + "/"))) return [];
  const rel = p.slice(r.length + 1).split(/[\\/]/);
  const out: string[] = [];
  let cur = r;
  for (let i = 0; i < rel.length - 1; i++) {
    cur = cur + sep + rel[i];
    out.push(cur);
  }
  return out;
}

/** True when `folder` or any folder beneath it holds edited images:
 * badges mark the whole trail down to where the edits actually live.
 * Separator-aware, so "F:\A" never matches "F:\AB". */
export function folderHasEdits(editedPaths: string[], folder: string): boolean {
  return editedPaths.some(
    (p) =>
      p === folder || p.startsWith(folder + "\\") || p.startsWith(folder + "/"),
  );
}

/** Brings graphs saved by older builds up to current semantics.
 *
 * B&W treatment used to live in the node's `enabled` flag; it now lives
 * in `amount` (with `enabled` meaning bypass, like every other node). A
 * graph saved before that change has no `amount`, so the UI read it as
 * "Color" while the engine fell back to its registry default of 100 and
 * rendered full monochrome: the panel and the picture disagreed until
 * something wrote the param. Translating the old flag fixes both. */
/** Fills in any parameter a node type owns but this node does not carry.
 *
 * "Can I ask what happened to the other sliders in the Grain
 * node? They are still visible in Develop but the node suddenly only has
 * two?"
 *
 * The inspector renders what a node holds and Develop renders a list it was
 * given, so the two disagreed the moment a node was missing a parameter.
 * Grain nodes migrated from the old names carried only the two that were
 * renamed; the six tonal and channel gains had never been written to them,
 * because the hand-written panel that used to draw those sliders only wrote
 * a param once you touched it.
 *
 * Adding them to the templates fixed new photographs and did nothing for
 * anybody's existing work, which is the half I missed. Identity values by
 * definition, so nothing a photograph looks like can change.
 *
 * Runs AFTER the renames below, not before: several of those key on a param
 * being absent, and filling it in first told them there was nothing to do.
 */
function withEveryParam(n: NodeCard): NodeCard {
  // A tool group's params are the recipe's mirror, not the generic
  // group's; the members carry their own.
  if (n.tool) {
    const healed = sceneSafeToolGroup(n);
    return { ...healed, params: { ...TOOL_GROUP_DEFAULTS[n.tool], ...healed.params } };
  }
  const identity = NEUTRAL_PARAMS[n.type];
  if (!identity) return n;
  // Missing on a saved grain node means legacy pixel sizing. Fresh
  // graphs opt in explicitly; backfilling this flag changes old edits.
  const missing = Object.entries(identity).filter(([k]) => n.params[k] === undefined && !(n.type === "heeler.grain" && k === "by_frame"));
  if (!missing.length) return n;
  return { ...n, params: { ...Object.fromEntries(missing), ...n.params } };
}

/** A node with every dial its Inspector offers (TYPE_NUM_PARAMS) that it
 * does not carry set to the registry's default. What it already carries,
 * the identity set included, stays. */
export function withRegistryDials(n: NodeCard): NodeCard {
  const registry = REGISTRY_DEFAULTS[n.type];
  const dials = TYPE_NUM_PARAMS[n.type];
  if (!registry || !dials || n.tool) return n;
  const missing = dials.filter((k) => n.params[k] === undefined && registry[k] !== undefined);
  if (!missing.length) return n;
  return { ...n, params: { ...Object.fromEntries(missing.map((k) => [k, registry[k]])), ...n.params } };
}

export function migrateNodes(nodes: NodeCard[]): NodeCard[] {
  return selectionLayerMasksAsPixels(nodes.map(migrateOne)).map(withEveryParam).map(withSecondImagePort).map(withDepthPort).map(withAlphaPort).map(withFileMaskPort).map(withDepthInPort).map(withMaskPort).map(gradientMapLayersByTone);
}

/** Draws the mask diamond on a saved card whose node takes a mask in
 * the engine but was saved without one (docs review 2026-10-01: Color
 * Transform, Channel Gain, Channel Mixer, Invert and Blend Mode). The
 * other way, a diamond the engine has no port for, goes in
 * dropDeadMaskSeats, which also has the wires to take with it. */
function withMaskPort(n: NodeCard): NodeCard {
  if (n.isGroup || n.maskIn || !engineTakesMask(n.type)) return n;
  return { ...n, maskIn: true };
}

/** Whether a card draws a mask diamond its engine node has no port for
 * (a Grain Field, Depth Map or layer effect placed from the palette
 * before 2026-10-01). A group's inputs are its boundary's, the logic
 * family's field is its operand, and a type the registry does not list
 * is not this rule's to judge. */
function deadMaskSeat(n: NodeCard): boolean {
  return !!n.maskIn && !n.isGroup && !MASK_IN_TYPES.has(n.type) && engineKnows(n.type) && !engineTakesMask(n.type);
}

/** Takes away a mask diamond the engine has no port for, and any wire
 * into it, at every depth of groups. build_graph already dropped such a
 * wire (graph.connect refuses an undeclared port), so nothing renders
 * differently and no saved number changes; the card just stops offering
 * a seat that did nothing. Returns the same arrays when nothing changes. */
export function dropDeadMaskSeats(nodes: NodeCard[], wires: Wire[]): { nodes: NodeCard[]; wires: Wire[] } {
  const dead = new Set(nodes.filter(deadMaskSeat).map((n) => n.id));
  let changed = dead.size > 0;
  const outNodes = nodes.map((n) => {
    if (dead.has(n.id)) {
      const { maskIn: _gone, ...rest } = n;
      return rest as NodeCard;
    }
    if (n.isGroup && n.groupNodes) {
      const inner = dropDeadMaskSeats(n.groupNodes, n.groupWires ?? []);
      if (inner.nodes !== n.groupNodes || inner.wires !== (n.groupWires ?? [])) {
        changed = true;
        return { ...n, groupNodes: inner.nodes, ...(n.groupWires ? { groupWires: inner.wires } : {}) };
      }
    }
    return n;
  });
  if (!changed) return { nodes, wires };
  const outWires = dead.size ? wires.filter((w) => !(dead.has(w.to) && w.toPort === "mask")) : wires;
  return { nodes: outNodes, wires: outWires };
}

/** The Gradient layer's shape that runs along the picture's tones
 * rather than across the frame (ops_retouch.rs is_by_tone). */
export const GRADIENT_BY_TONE = "tone";

/** A Gradient Map node's numbers as a By tone Gradient's: three stops,
 * dark, middle and bright, the middle one where the map's midpoint put
 * it, and the map's Amount as every stop's alpha (it mixed the map back
 * toward the picture below, which a layer's alpha over the same picture
 * does). The engine reads the same luma through the same lerp, so the
 * layer renders what it did (lib.rs gradient_map_as_tone is the same
 * rule for graphs the desktop reads unmigrated). Missing values take
 * the Gradient Map node's own defaults. */
export function gradientMapAsTone(
  params: Record<string, number>,
  text: Record<string, string> | undefined,
): { params: Record<string, number>; textParams: Record<string, string> } {
  const lo = text?.color_lo ?? "#000000";
  const mid = text?.color_mid ?? "#808080";
  const hi = text?.color_hi ?? "#ffffff";
  const pivot = Math.min(99, Math.max(1, params.midpoint ?? 50));
  const amount = Math.min(100, Math.max(0, params.amount ?? 100));
  const stops = [
    { pos: 0, color: lo, alpha: amount, mid: 50 },
    { pos: pivot, color: mid, alpha: amount, mid: 50 },
    { pos: 100, color: hi, alpha: amount, mid: 50 },
  ];
  return {
    params: { alpha_a: amount, alpha_b: amount, angle: 0, midpoint: 50 },
    textParams: { color_a: lo, color_b: hi, shape: GRADIENT_BY_TONE, stops: JSON.stringify(stops) },
  };
}

/** Finish Gradient Map layers open as Gradient layers set to By tone
 * (2026-09-30: "do the merge with a By tone shape"), at any depth of
 * the Finish stack's groups. A Gradient Map node is a layer's
 * content when the Layer menu made it (artKind) or when it feeds a
 * blend's second input, the layer shape; one placed by hand in the
 * graph elsewhere stays the Gradient Map node it is. Returns the
 * same card when nothing changes.*/
function gradientMapLayersByTone(n: NodeCard): NodeCard {
  if (n.id !== ART_ID || !n.groupNodes) return n;
  const convert = (group: NodeCard): NodeCard => {
    const members = group.groupNodes ?? [];
    const wires = group.groupWires ?? [];
    const blends = new Set(members.filter((m) => m.type === "heeler.blend").map((m) => m.id));
    let changed = false;
    const next = members.map((m) => {
      if (m.isGroup && m.groupNodes) {
        const inner = convert(m);
        if (inner !== m) changed = true;
        return inner;
      }
      if (m.type !== "heeler.gradient_map") return m;
      const layer =
        (m.artKind as string | undefined) === "gradient_map" ||
        wires.some((w) => w.from === m.id && w.toPort === "in2" && blends.has(w.to));
      if (!layer) return m;
      changed = true;
      return { ...m, type: "heeler.gradient", artKind: "gradient" as ArtKind, ...gradientMapAsTone(m.params, m.textParams) };
    });
    return changed ? { ...group, groupNodes: next } : group;
  };
  return convert(n);
}

/** Draws the depth input on a saved depth consumer that predates it
 * (26.3 Phase 10.3). Same rule as makeNode, derived from the type. */
function withDepthInPort(n: NodeCard): NodeCard {
  // A group's inputs are its boundary's (a recipe's depth input, the
  // Finish group's depth pipe for its masks), never its type's.
  if (n.isGroup) return n;
  const wants = DEPTH_IN_TYPES.has(n.type);
  if (!!n.depthIn === wants) return n;
  return { ...n, depthIn: wants };
}

/** Draws the mask pass-through output on a saved File or Export Layer
 * card that predates it (26.3 Phases 6 and 8). Same rule as makeNode,
 * derived from the type. */
function withFileMaskPort(n: NodeCard): NodeCard {
  const wants = n.type === "heeler.file" || n.type === "heeler.export_layer";
  if (!!n.fileMaskOut === wants) return n;
  return { ...n, fileMaskOut: wants };
}

/** Draws the alpha input on a saved Output or Export Layer that
 * predates it (26.3 Phases 5 and 8). Same rule as makeNode, derived
 * from the type. */
function withAlphaPort(n: NodeCard): NodeCard {
  const wants = ALPHA_IN_TYPES.has(n.type);
  if (!!n.alphaIn === wants) return n;
  return { ...n, alphaIn: wants };
}

/** Draws the depth output on a saved Depth Map that predates it (26.3
 * Phase 4). Same rule as makeNode, derived from the type, so the port
 * cannot go stale. */
function withDepthPort(n: NodeCard): NodeCard {
  const wants = n.type === "heeler.depth_map";
  if (!!n.depthOut === wants) return n;
  return { ...n, depthOut: wants };
}

/** Draws the second input port on a saved card that predates it.
 *
 * makeNode gives new cards their ports, which does nothing for the Merge
 * or Blend somebody placed by hand months ago: those were saved without
 * the flag, so they keep showing one port and keep swallowing whatever is
 * aimed at the lower half. Derived from the type rather than stored, so
 * the answer cannot go stale a second time. */
function withSecondImagePort(n: NodeCard): NodeCard {
  // Derived from the same rule makeNode uses, so the field operands
  // (Logic, Math) and the three planes of a Channel Join keep their
  // ports through a load as well as the two-image nodes.
  // A group's inputs are its boundary's (a recipe's in2, the Finish
  // group's frame for its masks), never its type's.
  if (n.isGroup) return n;
  const wants2 = hasSecondInput(n.type);
  const wants3 = hasThirdInput(n.type);
  if (!!n.hasIn2 === wants2 && !!n.hasIn3 === wants3) return n;
  return { ...n, hasIn2: wants2, hasIn3: wants3 };
}

function migrateOne(n: NodeCard): NodeCard {
  return ((n: NodeCard) => {
    // The one-node Sharpening and Skin Softening of 2026-09-03 to
    // 2026-09-23 open as the groups they should have been, dials
    // carried (the node "should be a group").
    if (n.type === "heeler.sharpening") {
      return sharpeningGroup(n.id, n.x, n.y, {
        radius: n.params.radius,
        intensity: n.params.intensity,
        mode: n.textParams?.mode === "hipass" ? "hipass" : "vivid",
        enabled: n.enabled,
      });
    }
    if (n.type === "heeler.skin_soften") {
      return skinGroup(n.id, n.x, n.y, {
        softening: n.params.softening,
        detail_back: n.params.detail_back,
        strength: n.params.strength,
        enabled: n.enabled,
      });
    }
    if (n.type === "heeler.black_white" && n.params.amount === undefined) {
      return {
        ...n,
        enabled: true,
        params: { ...n.params, amount: n.enabled ? 100 : 0 },
      };
    }
    // "I also noticed intensity is stepped 0 or 1. I would expect
    // this to be 0 to 100 (as in percentage)." The blend node shipped with its
    // opacity as a 0..1 fraction for a day, which made the slider a switch. A
    // recipe saved in that window holds 0.5 where it now means 50, and reading
    // it as half a per cent would look like the effect vanishing. The Develop
    // sharpening slider wrote a param the engine never read, so whatever anybody
    // set is sitting on the node doing nothing. Move it to the name the engine
    // actually reads rather than dropping it. "I see Vivid Light
    // node still has the name even tho it should be called Blend Mode. We should
    // be able to rename nodes tho, so I would care that if it was renamed to
    // represent its function." So only the names this app shipped are corrected.
    // Anything else on a blend node is a name somebody chose, and that is
    // theirs.
    if (n.type === "heeler.grain" && (n.params.grain_amount !== undefined || n.params.grain_size !== undefined)) {
      const { grain_amount, grain_size, ...rest } = n.params;
      return {
        ...n,
        params: {
          ...rest,
          intensity: rest.intensity ?? grain_amount ?? 0,
          size: rest.size ?? grain_size ?? 25,
        },
      };
    }
    if (n.type === "heeler.sharpen" && n.params.sharpening !== undefined) {
      const { sharpening, ...rest } = n.params;
      return { ...n, params: { ...rest, amount: rest.amount ?? sharpening } };
    }
    if (n.type === "heeler.blend") {
      let out = n;
      // "I see Vivid Light node still has the name even tho it should
      // be called Blend Mode. We should be able to rename nodes tho, so I would
      // care that if it was renamed to represent its function." So only the names
      // this app shipped are corrected. Anything else on a blend node is a name
      // somebody chose, and that is theirs to keep.
      if (["Vivid Light", "Overlay", "Softening", "Blend"].includes(out.name)) {
        out = { ...out, name: "Blend Mode" };
      }
      // Both, not either: a node saved under a mode's name also holds the
      // old opacity scale, and returning after the rename left the second
      // half undone.
      if ((out.params.opacity ?? 100) <= 1) {
        out = { ...out, params: { ...out.params, opacity: (out.params.opacity ?? 1) * 100 } };
      }
      return out;
    }
    if (n.type === "heeler.color_bend") {
      let params = n.params;
      // The bend shipped one commit with its pull called `strength`,
      // which collided with denoise's. Nodes saved in that window carry
      // the old name, and the engine ignores it: the tool renders as if
      // untouched.
      if (params.amount === undefined && params.strength !== undefined) {
        const { strength, ...rest } = params;
        params = { ...rest, amount: strength };
      }
      // It first shipped with the source at mid-saturation and a narrow
      // reach, which on most photos sits in empty space: moving the
      // target did nothing at all. Only nudge a node still sitting on
      // exactly those defaults, which means nobody has touched it.
      const untouched =
        params.src_sat === 0.5 &&
        params.dst_sat === 0.5 &&
        params.falloff === 0.35 &&
        params.src_hue === params.dst_hue;
      if (untouched)
        params = { ...params, src_sat: 0, dst_sat: 0, falloff: BEND_FALLOFF_DEFAULT };
      // And the same again for the reach that was written into every graph in
      // the window between the default changing and the tables that create
      // the node catching up. "when I first see Blend the falloff
      // is 1.0. That inconsistency is annoying."
      //
      // Only for a node with no bend on it at all, where the reach
      // reaches around nothing and changing it moves no pixel. A bend
      // somebody actually made keeps whatever reach they gave it.
      const unbent =
        params.falloff === 1 &&
        params.src_hue === params.dst_hue &&
        params.src_sat === params.dst_sat;
      if (unbent) params = { ...params, falloff: BEND_FALLOFF_DEFAULT };
      // A bend at zero amount does nothing at all, and the section's
      // Reset used to write exactly that: PARAM_DEFAULT had no entry for
      // amount, so Reset meant "amount = 0" and silently killed the
      // tool. Nobody chooses zero here; the section has a bypass switch
      // for that. Repair it.
      if (params.amount === 0) params = { ...params, amount: 100 };
      // Same story for a reach reset below the floor.
      if (params.falloff !== undefined && params.falloff < 0.15)
        params = { ...params, falloff: BEND_FALLOFF_DEFAULT };
      // An unbent node ships bypassed: its switch reading on for a photo
      // nobody has bent looks like an edit that is not there. A node
      // that IS bent keeps whatever the user set.
      const bent =
        params.src_hue !== params.dst_hue || params.src_sat !== params.dst_sat;
      const enabled = bent ? n.enabled : false;
      if (params === n.params && enabled === n.enabled) return n;
      return { ...n, params, enabled };
    }
    return n;
  })(n);
}

/** What the load-time backfill USED to splice into every saved graph that
 * lacked one of these five sections: the node at identity, bypassed, so
 * the render did not move. That predates the on-demand rule
 * ("Any category in the Develop that is off by default should not create
 * nodes until its been turned on"), and once the five became category
 * pieces the backfill was working against it: Reset built a clean graph,
 * autosave wrote it, and the next load put all five back.
 * "These are off by default and that also means don't add them to the
 * graph unless enabled."
 *
 * The table stays, inverted: it is now how a load recognizes a card the
 * old backfill left behind, so graphs already on disk come clean rather
 * than carrying the five forever. Only the exact identity the backfill
 * wrote counts; a bypassed node with anything moved on it is a section
 * somebody turned on and then off, and the owner's other rule holds for
 * those: "Once on and turned back off preserve the nodes just disable
 * them."
 */
const BACKFILL_IDENTITY: Record<
  string,
  {
    name: string;
    params: Record<string, number>;
    /** shipped ON in the old template: at identity it says nothing
     * either way, so it comes out whether or not it is bypassed */
    bornOn?: true;
  }
> = {
  // The four that shipped in every graph until 2026-09-01, enabled and
  // at identity: rows in on-by-default sections (Sharpen, Denoise, B&W)
  // and the crop the geometry tools wrote to.
  "heeler.sharpen": { name: "Sharpen", params: { amount: 0, radius: 1, threshold: 0 }, bornOn: true },
  "heeler.denoise": { name: "Denoise", params: { strength: 0 }, bornOn: true },
  "heeler.black_white": {
    name: "Black & White",
    params: { red: 30, green: 59, blue: 11, amount: 0 },
    bornOn: true,
  },
  "heeler.crop_rotate": {
    name: "Crop & Rotate",
    params: { angle: 0, aspect: 0, crop_x: 0, crop_y: 0, crop_w: 1, crop_h: 1 },
    bornOn: true,
  },
  "heeler.lens_correct": {
    name: "Lens Correction",
    params: { distortion: 0, ca_red: 0, ca_blue: 0, vignette: 0, vignette_mid: 50 },
  },
  "heeler.tone_eq": {
    name: "Relight",
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
  },
  "heeler.recolor": { name: "Recolor", params: { neutral_guard: 10, smoothing: 50, around_radius: 15 } },
  "heeler.color_console": { name: "Color Tune", params: { smoothing: 50 } },
  "heeler.color_bend": {
    name: "Color Bend",
    params: {
      src_hue: 0,
      src_sat: 0,
      dst_hue: 0,
      dst_sat: 0,
      falloff: BEND_FALLOFF_DEFAULT,
      amount: 100,
    },
  },
};

/** Whether a loaded card is one the old backfill left: a main-chain
 * category piece, bypassed, at exactly the identity the backfill wrote,
 * with nothing else attached to it. Anything less certain is kept: a
 * mask wired in, a text choice made, a renamed card, a dial moved. The
 * cost of keeping a stray is a bypassed node in the graph; the cost of
 * dropping a real one is somebody's settings. */
function untouchedBackfill(n: NodeCard, wires: Wire[]): boolean {
  const spec = BACKFILL_IDENTITY[n.type];
  if (!spec || !ON_DEMAND_IDS.has(n.id)) return false;
  if (n.enabled && !spec.bornOn) return false;
  if (n.name !== spec.name) return false;
  if (wires.some((w) => w.to === n.id && w.kind === "mask")) return false;
  const neutral = NEUTRAL_PARAMS[n.type] ?? {};
  for (const [k, v] of Object.entries(n.params)) {
    const want = k in spec.params ? spec.params[k] : neutral[k];
    // A param neither table knows is one this build does not read;
    // it says nothing about whether anybody touched the node.
    if (want !== undefined && v !== want) return false;
  }
  const textDefaults = PARAM_TEXT_DEFAULT[n.type] ?? {};
  for (const [k, v] of Object.entries(n.textParams ?? {})) {
    if (v !== textDefaults[k]) return false;
  }
  return true;
}

/** A stack group saved before members carried blends chains merges,
 * and a merge has no mask port, no mode and no clip port: the Finish UI
 * offers all three to any member now, so convert on load. At mode
 * "normal" a blend composites exactly as the merge it replaces (ops.rs:
 * both are fg*a over base*(1-a)), so the picture does not move. The
 * wiring is untouched: the carrier feed stays on "in2", which the
 * serializer maps to the second input either way. */
function migrateGroupCarriers(nodes: NodeCard[]): NodeCard[] {
  return nodes.map((n) => {
    if (n.id !== ART_ID || !n.groupNodes) return n;
    return {
      ...n,
      groupNodes: n.groupNodes.map((g) => {
        if (!g.isGroup || !g.groupNodes) return g;
        const old = new Set(
          artGroupMembers(g)
            .filter((m) => m.merge.type === "heeler.merge")
            .map((m) => m.merge.id),
        );
        if (!old.size) return g;
        return {
          ...g,
          groupNodes: g.groupNodes.map((m) =>
            old.has(m.id)
              ? {
                  ...m,
                  type: "heeler.blend",
                  textParams: { ...m.textParams, mode: m.textParams?.mode ?? "normal" },
                }
              : m,
          ),
        };
      }),
    };
  });
}

/** The detail params, as a Standard Color node carried them before
 * Detail had a node of its own: the three dials and their weights. */
const DETAIL_KEYS = [
  "texture",
  "clarity",
  "dehaze",
  ...["texture", "clarity", "dehaze"].flatMap((e) =>
    ["shadows", "midtones", "highlights", "red", "green", "blue"].map((w) => `${e}_${w}`),
  ),
];

function detailMoved(n: NodeCard): boolean {
  return DETAIL_KEYS.some((k) => {
    const v = n.params[k];
    if (v === undefined) return false;
    return k.includes("_") ? v !== 100 : v !== 0;
  });
}

/** Moves texture, clarity, dehaze and their weights off every Standard
 * Color node that still carries them onto a Detail node of its own,
 * spliced right after it: the main chain's through the Detail category
 * piece, a layer's through its own layer tool, wired the way
 * materializeLayerTool wires one. The values leave the color node, so
 * nothing is applied twice, and the render does not move, since the
 * engine applies the same pass in the same place either way. */
function splitDetail(nodes: NodeCard[], wires: Wire[]): { nodes: NodeCard[]; wires: Wire[] } {
  let outNodes = nodes;
  let outWires = wires;
  for (const n of nodes) {
    if (n.type !== "heeler.standard_color" || !detailMoved(n)) continue;
    const carried = Object.fromEntries(DETAIL_KEYS.filter((k) => n.params[k] !== undefined).map((k) => [k, n.params[k]]));
    const cleared = Object.fromEntries(DETAIL_KEYS.filter((k) => n.params[k] !== undefined).map((k) => [k, k.includes("_") ? 100 : 0]));
    const layer = layerNumber(n.id);
    if (layer === null) {
      if (outNodes.some((k) => k.type === "heeler.detail" && !isLayerNode(k.id))) continue;
      const piece = CATEGORY_PIECES.Detail[0];
      const built = buildCategoryPiece(outNodes, outWires, piece);
      outNodes = built.nodes.map((k) =>
        k.id === piece.id
          ? // The switch comes across with the dials: a bypassed Color
            // rendered no detail, so its Detail arrives bypassed too.
            { ...k, enabled: n.enabled, params: { ...k.params, ...carried } }
          : k.id === n.id
            ? { ...k, params: { ...k.params, ...cleared } }
            : k,
      );
      // Every consumer of the Color node saw the detail pass, so every
      // one now reads the Detail node, not only the chain's next stop.
      outWires = built.wires.map((w) =>
        w.from === n.id && w.kind === "image" && w.to !== piece.id ? { ...w, from: piece.id, fromPort: undefined } : w,
      );
      continue;
    }
    const id = layerNodeId(layer, "detail");
    if (outNodes.some((k) => k.id === id)) continue;
    const tail = outWires.find((w) => w.from === n.id && w.kind === "image");
    if (!tail) continue;
    const maskId = layerNodeId(layer, "mask");
    const node: NodeCard = { ...layerToolNode(id, "detail", n.x + NODE_W + 60, n.y), enabled: n.enabled, params: { ...NEUTRAL_PARAMS["heeler.detail"], ...carried } };
    outNodes = [...outNodes.map((k) => (k.id === n.id ? { ...k, params: { ...k.params, ...cleared } } : k)), node];
    outWires = [
      // Every wire the Color node fed now comes from the Detail node.
      ...outWires.map((w) => (w.from === n.id && w.kind === "image" ? { ...w, from: id, fromPort: undefined } : w)),
      { from: n.id, to: id, toPort: "in", kind: "image" },
      ...(outNodes.some((k) => k.id === maskId) ? [{ from: maskId, to: id, toPort: "mask", kind: "mask" } as Wire] : []),
    ];
  }
  return { nodes: outNodes, wires: outWires };
}

/** 26.3 Phase 10.4: old graphs are moved, not left lying. A Depth Map
 * saved before the fixed seat existed (26.2 spliced it after Grain, so
 * it landed behind whatever tonal nodes the graph had) is re-spliced
 * to its seat on load, and every consumer already asking for the plane
 * gets the `depth` wire the planted slot used to answer. The picture
 * is unchanged: the node is a passthrough, and at the seat its input
 * is the geometry-corrected photograph, which is what preview_source
 * plus conform_rasters_to_geometry computed the map from. Runs on
 * every load, so a graph already at the seat must round-trip
 * untouched. */
function reseatDepthMap(nodes: NodeCard[], wires: Wire[]): Wire[] {
  const dm = nodes.find((n) => n.type === "heeler.depth_map");
  if (!dm) return wires;
  let out = wires;
  if (CHAIN_ORDER.includes(dm.id)) {
    // spliceIn refuses any id a wire already touches, and spliceOut
    // would rewrite the depth wires' kind, so the seat move is done by
    // hand: lift the chain wires off the node, close the gap, splice
    // at the CHAIN_ORDER seat, and put the mask-side wires back.
    const chainIn = out.find((w) => w.to === dm.id && w.kind !== "mask");
    const chainOut = out.filter((w) => w.from === dm.id && w.kind !== "mask");
    const maskSide = out.filter(
      (w) => (w.from === dm.id || w.to === dm.id) && !chainOut.includes(w) && w !== chainIn,
    );
    let rest = out.filter((w) => w.from !== dm.id && w.to !== dm.id);
    if (chainIn) {
      rest = [...rest, ...chainOut.map((w) => ({ ...w, ...wireSource(chainIn), kind: chainIn.kind }))];
    }
    const reseated = [...spliceIn(rest, dm.id), ...maskSide];
    const sig = (ws: Wire[]) =>
      ws.map((w) => `${w.from}:${w.fromPort ?? "out"}>${w.to}:${w.toPort}:${w.kind}`).sort().join("|");
    if (sig(reseated) !== sig(out)) out = reseated;
  }
  // Consumers that were never wired (the slot answered them invisibly)
  // get the wire, once each, when the map is there to compute the
  // plane. A disabled map stays unwired: no plane is coming, and the
  // section's NO DEPTH MAP hint says so.
  if (dm.enabled) {
    const add: Wire[] = [];
    for (const n of nodes) {
      if (!DEPTH_IN_TYPES.has(n.type) || !nodeWantsDepth(n)) continue;
      if (out.some((w) => w.to === n.id && w.toPort === "depth")) continue;
      add.push({ from: dm.id, fromPort: "depth", to: n.id, toPort: "depth", kind: "mask" });
    }
    if (add.length > 0) out = [...out, ...add];
  }
  return out;
}

export function migrateGraph(
  nodes: NodeCard[],
  wires: Wire[],
): { nodes: NodeCard[]; wires: Wire[] } {
  // Read in the outside shape the migrations below were written for
  // (liftArtMasks): a graph saved since 2026-10-01 keeps its Finish
  // masks in the Finish group, and the reducer sinks them again.
  ({ nodes, wires } = liftArtMasks(nodes, wires));
  const split = splitDetail(migrateGroupCarriers(migrateNodes(nodes)), wires);
  let outNodes = split.nodes;
  let outWires = split.wires;
  // The five sections the old backfill spliced in come out again where
  // nobody ever touched them, and the chain closes over the gap. A load
  // never ADDS an on-demand piece: a photo saved before a section
  // existed simply has the section off, and its switch builds the node
  // the first time it goes on (set_category), which is the same door a
  // fresh photograph's sections open through.
  for (const n of [...outNodes]) {
    if (!untouchedBackfill(n, outWires)) continue;
    outWires = spliceOut(outWires, n.id);
    outNodes = outNodes.filter((m) => m.id !== n.id);
  }
  // The sample session's dressing, which the neutral template carried
  // into every graph until 2026-09-01: an empty "Portra Grade" group and
  // the Merge it fed. The group goes when it is still empty; the merge
  // goes when nothing else is aimed at its second input, and the chain
  // closes from the source over the gap. A group somebody filled, or a
  // merge somebody fed, is theirs and stays.
  ({ nodes: outNodes, wires: outWires } = stripSampleDressing(outNodes, outWires));
  // A mask diamond the engine has no port for goes, with its wire. After
  // the dressing: a mask wired to the demo Merge marked it as somebody's.
  ({ nodes: outNodes, wires: outWires } = dropDeadMaskSeats(outNodes, outWires));
  const blocks = migrateRecipeBlocks(outNodes, outWires);
  // Masks saved reading the photograph behind a crop read the crop, by
  // the rule the first crop and the desktop apply (masksReadTheFrame,
  // lib.rs masks_read_the_frame). The first crop's own move never ran
  // for a graph saved before 2026-09-30, and a mask gating nothing (the
  // document selection) had no gate for the desktop to follow either.
  const seated = reseatDepthMap(blocks.nodes, blocks.wires);
  return { nodes: blocks.nodes, wires: masksReadTheFrame(blocks.nodes, seated) };
}

/** The sample session's dressing, which the neutral template carried
 * into every graph until 2026-09-01 and the built-in presets carried
 * until 2026-09-04: an empty "Portra Grade" group and the Merge it
 * fed. The group goes when it is still empty; the merge goes when
 * nothing else is aimed at its second input. Safe on any graph, so a
 * loaded photograph and an applied preset both pass through here. */
export function stripSampleDressing(
  nodes: NodeCard[],
  wires: Wire[],
): { nodes: NodeCard[]; wires: Wire[] } {
  let outNodes = nodes;
  let outWires = wires;
  const portra = outNodes.find(
    (n) => n.id === "portra" && n.type === "heeler.group" && !(n.groupNodes?.length),
  );
  if (portra) {
    outWires = spliceOut(outWires, portra.id);
    outNodes = outNodes.filter((m) => m.id !== portra.id);
  }
  // Only the demo's own: still called Merge, fed on its second input by
  // nothing (the group just left), and carrying no mask or stencil of
  // the user's. Anything else is a merge somebody made theirs. Only
  // beside the empty group, which is what marks the sample: a Merge
  // kept on an earlier load (its mask wire, which the engine never had
  // a port for, goes with dropDeadMaskSeats) stays kept.
  const merge = !portra ? undefined : outNodes.find(
    (n) =>
      n.id === "merge" &&
      n.type === "heeler.merge" &&
      n.name === "Merge" &&
      (n.params.opacity ?? 72) === 72 &&
      (n.textParams?.fit ?? "stretch") === "stretch",
  );
  if (merge && !outWires.some((w) => w.to === merge.id && w.toPort !== "in")) {
    outWires = spliceOut(outWires, merge.id);
    outNodes = outNodes.filter((m) => m.id !== merge.id);
  }
  return { nodes: outNodes, wires: outWires };
}

/** The Sharpening and Skin Softening recipe blocks of graphs saved
 * before 2026-09-03 become the single nodes that replaced them, values
 * carried over, so a photograph edited under the old panel renders
 * exactly what it did (the engine pins the two ops against the chains
 * tap for tap). A block that is not wired into the chain is simply
 * dropped: it was switched off and rendered nothing. */
export function migrateRecipeBlocks(
  nodes: NodeCard[],
  wires: Wire[],
): { nodes: NodeCard[]; wires: Wire[] } {
  let outNodes = nodes;
  let outWires = wires;
  const num = (id: string, param: string, fallback: number) => {
    const v = outNodes.find((n) => n.id === id)?.params?.[param];
    return typeof v === "number" ? v : fallback;
  };
  const blocks: {
    prefix: string;
    head: string;
    tail: string;
    over: string;
    build: () => NodeCard;
  }[] = [
    {
      prefix: LEGACY_RECIPE_PREFIX.sharpen,
      head: "sharp_display",
      tail: "sharp_scene",
      over: "sharp_over",
      build: () => {
        const hipass = outWires.some(
          (w) => w.to === "sharp_over" && w.toPort === "in2" && w.from === "sharp_hp",
        );
        const radius = hipass ? num("sharp_hp", "radius", 3) : num("sharp_blur", "radius", 3);
        // Intensity is the Overlay blend's opacity. The Vivid Light
        // blend's own opacity is not carried: the recipe always wrote
        // it at 100, and a hand-edited value scaled the Vivid Light
        // step, which the one node has no dial for (the 2026-09-23
        // Sharpening review's R4). Such a graph migrates at the
        // recipe's own strength.
        return sharpeningGroup("sharpening", 0, 0, {
          radius,
          intensity: num("sharp_over", "opacity", 50),
          mode: hipass ? "hipass" : "vivid",
        });
      },
    },
    {
      prefix: LEGACY_RECIPE_PREFIX.skin,
      head: "skin_display",
      tail: "skin_scene",
      over: "skin_over",
      build: () =>
        skinGroup("skin", 0, 0, {
          softening: num("skin_hp", "radius", 8),
          detail_back: num("skin_blur", "radius", 4),
          strength: num("skin_over", "opacity", 50),
        }),
    },
  ];
  for (const block of blocks) {
    const members = outNodes.filter((n) => n.id.startsWith(block.prefix));
    if (!members.length) continue;
    const feed = outWires.find((w) => w.to === block.head && w.toPort === "in" && w.kind === "image");
    const exits = outWires.filter((w) => w.from === block.tail);
    const over = outNodes.find((n) => n.id === block.over);
    const anchor = over ?? members[0];
    const node: NodeCard = {
      ...block.build(),
      x: anchor.x,
      y: anchor.y,
      enabled: !!over?.enabled && !!feed,
    };
    outNodes = [...outNodes.filter((n) => !n.id.startsWith(block.prefix)), node];
    outWires = outWires.filter((w) => !w.from.startsWith(block.prefix) && !w.to.startsWith(block.prefix));
    if (feed && exits.length) {
      outWires = [
        ...outWires,
        { ...wireSource(feed), to: node.id, toPort: "in", kind: "image" },
        ...exits.map((w) => ({ from: node.id, to: w.to, toPort: w.toPort, kind: w.kind })),
      ];
    }
  }
  return { nodes: outNodes, wires: outWires };
}

/** A merged photograph, told apart by its manifest extension: that is
 * what it is, so nothing else has to be tracked. `.heelerstack` is the
 * old name, still recognized so stacks made before the rename keep
 * working. */
export function isStack(img: { name: string }): boolean {
  const n = img.name.toLowerCase();
  return n.endsWith(".stack") || n.endsWith(".heelerstack");
}

/** Highlight shoulder a freshly opened merge starts with. Enough to
 * bring a sky two or three stops over white back into view without
 * flattening it. */
export const MERGED_ROLLOFF = 70;

/** What the standard profile ships with, measured against two reference
 * editors rendering the same RAWs (scripts/compare_renders.py). Both
 * quietly lift a RAW about a stop before their curves; without that,
 * Heeler sat a flat -1.0 EV through the mids of every test scene. the
 * owner wants a look between the two, leaning to the second: lift a
 * touch past parity, a toe so blacks keep the second's density rather
 * than the first's lifted wash, and a modest shoulder so highlights
 * compress instead of clipping (the first blew out 31% of the canyon
 * test frame; the second clipped nothing). All three are visible params
 * on the tone profile node, not folklore in a LUT.
 *
 * VERIFIED SHIPPED LOOK (2026-08-23, on the profiled Windows ultrawide):
 * these values measured mids +0.24..+0.37 EV over the second, shadows
 * +0.65, near-zero chroma bias, and the owner signed it off as the
 * default rendering. Do not retune without a new verdict; the wide- gamut
 * migration must land back inside this envelope.*/
export const PROFILE_DEFAULTS = {
  baseline_ev: 1.3,
  shadow_toe: 50,
  highlight_rolloff: 25,
};

/** A destructive action waiting for the user to agree to it.
 *
 * The action is a discriminator rather than a callback, so the whole
 * thing stays serializable and, more to the point, testable: whether
 * deleting from disk really asks twice is then a question the reducer
 * answers, not something you have to click through a dialog to find out.
 */
export type ConfirmAction =
  // Move to Trash renames the file into a `.trash` folder beside it.
  // One prompt, because one prompt is what a reversible action is worth:
  // the photograph is still on the disk afterwards and Put Back brings
  // it home. Deleting it for real is the file manager's job.
  | { kind: "trash_images"; ids: string[]; names: string[] }
  // Deleting a merge or a panorama is the one delete this app does,
  // and it is allowed because the thing deleted is a recipe Heeler
  // wrote, not a photograph anybody shot: the frames it names stay
  // exactly where they are. "Since there is no real file
  // on disk and the stacks/panorama can be recreated from source files
  // we should be able to delete these."
  | { kind: "recover_hidden"; path: string; count: number }
  // Hiding a folder takes it and its subfolders off the library's list
  // and keeps every record; browsing to it again brings it back. One
  // prompt, and only when there are photographs under it, since an
  // empty folder browsed into by mistake is what this is for
  // (2026-09-08).
  | { kind: "hide_folder"; path: string; folders: number; images: number }
  // Flushing a folder forgets the catalog's records for it: ratings,
  // flags, keywords, collection membership. No file is touched and the
  // edits live outside the catalog, but the records have no undo, so
  // this is the one gesture that asks twice.
  | { kind: "flush_folder"; path: string; folders: number; images: number }
  // Deleting a take destroys the edits in it and nothing else. Worth one
  // prompt: history is per-take and switching between them clears it, so
  // there is no undo behind this one.
  | { kind: "delete_take"; takeId: string; name: string }
  // Forget Missing Trashed Photos (2026-10-01: "yes, build the purge"):
  // trashed photographs whose file the user removed from `.trash`
  // outside Heeler leave the catalog. No file is touched. One prompt
  // that lists every path and says there is no undo; the deed asks the
  // disk again, so one put back meanwhile stays.
  | { kind: "forget_missing_trashed"; ids: string[]; paths: string[]; skipped: number; skippedVolumes: string[] }
  // A scheduled catalog backup that failed at launch: not a question,
  // a notice the user has to see, with the native message that says
  // what happened, why, and what to do. OK opens Preferences.
  | { kind: "backup_failed"; message: string };

export interface Confirm {
  action: ConfirmAction;
  /** which prompt is showing, counting from 1 */
  step: number;
}

/** How many times an action asks before it happens.
 *
 * Deleting from disk is the only thing in the app that destroys a file
 * and its metadata together, and it is the only thing that asks twice.
 * Everything else here is reversible, and asking twice for reversible
 * things is how you train people to click through the one that matters.
 */
/** Which actions cannot be taken back, and so ask twice.
 *
 * It held delete-from-disk, the only gesture in the app that destroyed
 * someone's file, and that gesture is gone: Heeler does not remove
 * anyone's photographs, and the code that could is not present to be
 * reached by accident, by a hotkey binding, or by a future caller who
 * did not know better. "I don't want ANY code that deletes
 * files to exist in this app."
 *
 * Flushing a folder is here now (2026-09-08): it touches no file, but
 * the catalog's records for the photographs (ratings, flags,
 * keywords, collection membership) have no undo, and a second ask is
 * what a loss with no way back is worth.
 */
const ASKS_TWICE: ConfirmAction["kind"][] = ["flush_folder"];

export function promptsFor(action: ConfirmAction): number {
  return ASKS_TWICE.includes(action.kind) ? 2 : 1;
}

export function isFinalPrompt(confirm: Confirm): boolean {
  return confirm.step >= promptsFor(confirm.action);
}

/** Whether a merge still needs its highlight shoulder turned on.
 *
 * The shoulder was originally applied only when an image had no saved
 * graph at all, which quietly meant "only merges created after the day
 * the shoulder shipped". Every stack and panorama made before that
 * already had a graph file on disk, so the fix skipped exactly the
 * photographs that needed it, and their skies stayed blown for good.
 *
 * A saved graph is not automatically the user's work: the app writes one
 * for every image it opens, edited or not. So the question is not
 * whether a file exists, it is whether anyone has touched the picture.
 * If they have, this returns false and their edit is left alone, even if
 * what they did was set the shoulder to zero on purpose.
 */
export function needsMergedDefaults(
  img: { name: string; edited: boolean } | undefined | null,
  saved: { nodes: { type: string; params?: Record<string, unknown> }[] } | null,
): boolean {
  if (!img || !isComposite(img)) return false;
  if (!saved) return true;
  if (img.edited) return false;
  const profile = saved.nodes.find((n) => n.type === "heeler.tone_profile");
  // No tone profile at all is a graph from before the node existed, and
  // it will get a fresh one; treat it the same as a zero. The shipped
  // default shoulder also counts as untouched: an unedited image at
  // exactly the default has not been chosen, it has been defaulted.
  const rolloff = Number(profile?.params?.highlight_rolloff ?? 0);
  return rolloff === 0 || rolloff === PROFILE_DEFAULTS.highlight_rolloff;
}

/** Whether a curves node is still an exact identity: no channel bent.
 * The editor's default two-point diagonal counts as untouched, the
 * same way an unedited default is not a choice anyone made. */
export function curvesUntouched(n: {
  curves?: Partial<Record<string, [number, number][]>>;
}): boolean {
  return Object.values(n.curves ?? {}).every(
    (pts) =>
      !pts ||
      pts.length === 0 ||
      (pts.length === 2 &&
        pts[0][0] === 0 &&
        pts[0][1] === 0 &&
        pts[1][0] === 1 &&
        pts[1][1] === 1),
  );
}

/** Whether a chain node fed by this one already sits on the finished
 * profile: the feeder is the profile or anything the chain runs after
 * it. Levels and Curves both ride there, in that order, so the one
 * behind is fed by the other, not by the profile itself. */
function ridesOnProfile(s: State, feeder: string): boolean {
  const seen = new Set<string>();
  while (!seen.has(feeder)) {
    if (s.nodes.some(n => n.id === feeder && n.type === "heeler.tone_profile")) return true;
    seen.add(feeder);
    const wire = s.wires.find(w => w.to === feeder && w.toPort === "in" && w.kind !== "mask");
    if (!wire) return false;
    feeder = wire.from;
  }
  return false;
}

/** A saved curve can still sit BEFORE the profile when someone bent
 * it there. The factory order is no evidence about a saved wire: put
 * its neutral companion on the actual output path after the profile. */
function moveToneAfterProfile(s: State, id: string): State {
  const wires = spliceOut(s.wires, id);
  const path: Wire[] = [];
  const seen = new Set<string>();
  let cur = s.nodes.find(n => n.type === "heeler.output")?.id ?? "output";
  while (!seen.has(cur)) {
    seen.add(cur);
    const feed = wires.find(w => w.to === cur && w.toPort === "in" && w.kind !== "mask");
    if (!feed) return s;
    path.push(feed);
    if (s.nodes.some(n => n.id === feed.from && n.type === "heeler.tone_profile")) {
      const after = id === "curves" ? path.find(w => w.from === "levels") ?? feed : feed;
      return { ...s, wires: [...wires.filter(w => w !== after), { ...after, to: id, toPort: "in" }, { ...after, from: id, fromPort: undefined }] };
    }
    cur = feed.from;
  }
  return s;
}

/** An identity Levels: every dial at its default, so it renders what it
 * is handed from anywhere in the chain. */
export function levelsUntouched(n: { params: Record<string, unknown> }): boolean {
  const at = (k: string, d: number) => (n.params[k] ?? d) === d;
  return at("black", 0) && at("white", 1) && at("gamma", 1) && at("black_soft", 0) && at("white_soft", 0);
}

/** Whether a saved graph's tone profile predates the profile defaults
 * (the baseline lift, the toe, the default shoulder).
 *
 * The gate is the profile NODE, not the photograph. It used to be the image's edited
 * flag, and that quietly pinned every photo anyone had so much as nudged to the
 * pre-calibration look forever: the owner's whole test library was "edited" (an
 * exposure test here, a contrast test there), so his Heeler kept measuring a stop
 * under a reference editor no matter what the defaults said. Setting exposure is not
 * choosing a profile. The profile is untouched while its params are values the app
 * shipped rather than values a hand set, and an untouched default is not a choice
 * anyone made.*/
export function needsProfileDefaults(
  _img: { name?: string; edited: boolean } | undefined | null,
  saved: { nodes: { type: string; params?: Record<string, unknown> }[] } | null,
): boolean {
  if (!saved) return false;
  const profile = saved.nodes.find((n) => n.type === "heeler.tone_profile");
  if (!profile || profile.params?.baseline_ev !== undefined) return false;
  // Values the app itself wrote at some point: the old default contrast,
  // and the shoulder the merge upgrade grants. Anything else on the node
  // is a hand on the controls, and that profile belongs to its owner.
  const shipped: Record<string, (v: number) => boolean> = {
    contrast: (v) => v === 100,
    highlight_rolloff: (v) => v === 0 || v === MERGED_ROLLOFF,
    development: (v) => v === 0,
  };
  return Object.entries(profile.params ?? {}).every(
    ([k, v]) => shipped[k]?.(Number(v)) ?? false,
  );
}

/** Whether a SAVED graph should have its profile bypassed because the
 * source is already rendered.
 *
 * The fresh-graph rule (a JPEG skips the profile: the camera already
 * rendered it once) only ever spoke at graph birth - and the app
 * writes a graph file for every image it so much as opens, so every
 * rendered file opened before the rule existed carries a saved graph
 * with the profile on, forever. "I still have profiles
 * being added to JPG... any 8 bit image probably should not get a
 * profile applied. Clearly one was baked in."
 *
 * Same gate as the other profile migrations: the NODE, not the
 * photograph. A profile whose every value is one the app shipped is a
 * default nobody chose, and the format rule may speak; one number a
 * hand set (or a mode chosen in Source) makes it the owner's, and it
 * stays exactly as they left it.
 *
 * A phone's DNG joined the rendered camp in 26.4.1, when its decode
 * began following the file's own gain table map: every one opened
 * before that has a saved graph with the profile on, and the lift on
 * top of the phone's rendering is over a stop bright. */
export function needsRenderedBypass(
  img: { name?: string; phoneRendered?: boolean; renderedFrames?: boolean } | undefined | null,
  saved: {
    nodes: {
      type: string;
      enabled?: boolean;
      params?: Record<string, unknown>;
      textParams?: Record<string, string>;
    }[];
  } | null,
): boolean {
  if (!img?.name || !(isRenderedSource(img.name) || img.phoneRendered || img.renderedFrames) || !saved) return false;
  const profile = saved.nodes.find((n) => n.type === "heeler.tone_profile");
  if (!profile || profile.enabled === false) return false;
  const mode = profile.textParams?.mode;
  if (mode !== undefined && mode !== "standard") return false;
  const shipped: Record<string, (v: number) => boolean> = {
    contrast: (v) => v === 100,
    highlight_rolloff: (v) =>
      v === 0 || v === MERGED_ROLLOFF || v === PROFILE_DEFAULTS.highlight_rolloff,
    baseline_ev: (v) => v === PROFILE_DEFAULTS.baseline_ev,
    shadow_toe: (v) => v === PROFILE_DEFAULTS.shadow_toe,
    colorfulness: (v) => v === 0,
    // Film's development dial, saved as 0 on every profile since it
    // existed. Unlisted, it made every saved graph read as a hand on the
    // controls, and no rendered source ever caught up to the rule
    // (2026-09-20: the OpenEXR canvas still over-exposed against its
    // thumbnail after the fresh-graph fix).
    development: (v) => v === 0,
  };
  return Object.entries(profile.params ?? {}).every(
    ([k, v]) => shipped[k]?.(Number(v)) ?? false,
  );
}

/** Top of the take filter. The maximum reading as "and up" rather
 * than a real ceiling, because nothing stops someone keeping twenty
 * takes and a filter that quietly excluded them would be a bug. */
export const TAKE_CAP = 10;

/** Whether any filter is narrowing the ribbon. Drives the funnel badge:
 * a filter you have forgotten about looks exactly like a folder that
 * lost its photos. */
export function filtersActive(s: State): boolean {
  return (
    s.filterStars > 0 ||
    s.filterPicksOnly ||
    s.filterHideRejected ||
    s.filterName.trim() !== "" ||
    s.filterDateFrom !== "" ||
    s.filterDateTo !== "" ||
    s.filterStacksOnly ||
    s.filterEdited !== "all" ||
    s.filterTakesMin > 1 ||
    s.filterTakesMax < TAKE_CAP ||
    s.tagFilter !== null
  );
}

/** How many takes an image has. One when it has never been branched:
 * the original edit is a take, it just has no siblings yet. */
export function takeCount(s: State, id: string): number {
  return s.takes[id]?.length ?? 1;
}

/** Crop ratios, offered wherever a ratio is offered. One list, because
 * two lists of ratios is a bug waiting to be reported. */
export const CROP_RATIOS: [string, number][] = [
  ["1:1", 1],
  ["3:2", 1.5],
  ["4:3", 4 / 3],
  ["5:4", 1.25],
  ["16:9", 16 / 9],
  ["2:3", 2 / 3],
  ["3:4", 0.75],
  ["9:16", 9 / 16],
];

/** Parses "3:2", "1.5" or "3x2" into a ratio. Null when it is not a
 * ratio at all, so a typo leaves the crop alone rather than collapsing
 * it to a sliver. */
export function parseAspect(text: string): number | null {
  const pair = text
    .trim()
    .match(/^(\d+(?:\.\d+)?)\s*[:x/]\s*(\d+(?:\.\d+)?)$/i);
  if (pair) {
    const [w, h] = [Number(pair[1]), Number(pair[2])];
    return h > 0 && w > 0 ? w / h : null;
  }
  const single = Number(text.trim());
  return Number.isFinite(single) && single > 0 ? single : null;
}

/** The graph to render while the crop tool is up.
 *
 * The crop rectangle is opened to the full frame so the overlay has the
 * whole picture to sit on rather than an already-cropped one. The angle
 * is deliberately left alone: straightening first and then cropping is
 * the normal order, and un-rotating the preview to crop it means
 * choosing the rectangle against a frame that is not the one you will
 * get. What you need to see while dragging is exactly the thing the
 * rotation created, the empty wedges at the corners, so that the crop
 * can be pulled in past them.
 */
export function cropPreviewGraph(s: State): {
  nodes: NodeCard[];
  wires: Wire[];
} {
  const opened = s.nodes.map((n) =>
    n.type === "heeler.crop_rotate"
      ? {
          ...n,
          params: { ...n.params, crop_x: 0, crop_y: 0, crop_w: 1, crop_h: 1 },
        }
      : n,
  );
  // The painting rides onto the opened frame too, so it sits on the
  // scene while the rectangle is being chosen, where the crop will
  // leave it (framemap.ts).
  const map = frameRemap(cropGeomOf(s.nodes), cropGeomOf(opened), cropSourceAspect(s));
  return {
    nodes: map ? remapNodes(opened, map, (n) => n.type === "heeler.crop_rotate") : opened,
    wires: s.wires,
  };
}

/** Which images a rating or a flag applies to.
 *
 * The selection when there is one, otherwise the image on screen.
 * Selecting a range and pressing 3 has to rate the range, or culling a
 * burst means pressing 3 twenty times. */
export function taggingTargets(s: State): string[] {
  if (s.imageSelection.length > 1) return s.imageSelection;
  return s.activeImage ? [s.activeImage] : [];
}

/** Every available photograph can freeze its current edits. */
export function bakeable(s: State): string[] {
  return taggingTargets(s).filter((id) => s.images.some((i) => i.id === id && !i.missing));
}

/** A stitched photograph, told apart the same way. */
export function isPano(img: { name: string }): boolean {
  return img.name.toLowerCase().endsWith(".pano");
}

/** What the ribbon's "Add to Stack" submenu has to work with: every
 * stack in the open folder that is not itself part of the selection,
 * and the selected frames that could join one (ordinary photographs
 * only; recipes cannot be frames of each other). Either list empty
 * means the submenu has nothing to offer and stays away. */
export function stackAppendTargets(s: State): { stacks: ImageEntry[]; frames: string[] } {
  const frames = s.imageSelection.filter((id) => {
    const img = s.images.find((i) => i.id === id);
    return !!img && !isStack(img) && !isPano(img);
  });
  const stacks = frames.length
    ? s.images.filter((i) => isStack(i) && !s.imageSelection.includes(i.id))
    : [];
  return { stacks, frames };
}

/** Anything Heeler assembled rather than a camera shooting it. Both are
 * recipes in the folder rather than files off a card, and both are the
 * thing you go looking for after making one, so one filter finds both. */
export function isComposite(img: { name: string }): boolean {
  return isStack(img) || isPano(img);
}

/** Whether a photo's name matches the name filter. Plain text means
 * "contains", so a fragment finds its file; * and ? make it a whole-name
 * wildcard pattern the way filenames have always globbed (* = anything,
 * ? = one character). Deliberately not regex: the people typing here
 * should not need to know what an anchor or an escape is. */
export function nameMatches(pattern: string, name: string): boolean {
  const p = pattern.trim().toLowerCase();
  if (p === "") return true;
  const n = name.toLowerCase();
  if (!p.includes("*") && !p.includes("?")) return n.includes(p);
  const rx = p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${rx}$`).test(n);
}

// Art layers ---------------------------------------------------------------
//
// The Finish tab is a view over one group node ("art") spliced after
// curves: inside it, to_display feeds a chain of blend nodes, one per
// layer, each blending a content node (paint, for now) over everything
// below, and to_scene hands the result back to the chain. A layer IS
// its blend node: opacity, mode, enabled and the name live there, and
// the content node hangs off its in2. Same 1:1 rule as Develop; Graph
// mode shows one box that opens up.

export const ART_ID = "art";

/** The tools that live on the Finish toolbar and write to a Finish
 * layer. They are only in hand while that toolbar is on screen (see
 * reduce: leaving Finish puts them down). Select and Polish are not
 * here: the selection works in Adjustments too, and Polish keeps the
 * toolbar up itself. */
export const FINISH_TOOLBAR_TOOLS: ReadonlySet<State["tool"]> = new Set<State["tool"]>([
  "fill",
  "transform",
  "warp",
  "paint",
  "erase",
  "clone",
  "heal",
  "dodge",
  "burn",
  "blur",
  "blend",
]);

/** Whether the Finish toolbar is on screen, which is also where its
 * hotkeys are live ("make sure these hotkeys only work
 * with the toolbar is visible"). Develop shows it with the Finish
 * pane up; Graph and Canvas only while INSIDE the Finish group (The
 * report: "Right now, the toolbar is visible in Graph all the
 * time"). Polish is the one exception in any mode: the bar is
 * polish's only Apply and Cancel, and hiding it would strand the
 * tool.
 *
 * The Selection split deliberately does not count: it carries its own
 * complete controls, and the bar's other tools have no layer to write
 * to from Adjustments. The owner, asked directly: "I don't want to
 * see the toolbar every time selection is armed. I think exposing
 * those extra tools in Adjustments would be confusing."*/
export function artToolbarVisible(s: State): boolean {
  if (s.tool === "polish") return true;
  if (s.mode === "simple") {
    // Just "layers": the old condition also matched a "select" tab
    // that stopped existing when the selection became a split.
    return (
      s.panelTab === "layers" ||
      (s.panelBottom.length > 0 && s.panelTabBottom === "layers")
    );
  }
  return s.openedGroup === ART_ID;
}

export function artGroup(s: State): NodeCard | undefined {
  return s.nodes.find((n) => n.id === ART_ID && n.isGroup);
}

/** An Export Layer card as the checkboxes make it (26.3 Phase 8, and
 * the section and mask checkboxes of 2026-09-30): named after what it
 * exports through its label, which the bridge folds into the written
 * name, so a rename can follow it; `textParams.source` says which
 * checkbox owns it. */
export function exportLayerCard(id: string, name: string, x: number, y: number, textParams: Record<string, string>): NodeCard {
  return {
    id,
    type: "heeler.export_layer",
    name,
    cat: "utility",
    x,
    y,
    enabled: true,
    params: {},
    textParams,
    hasIn: true,
    hasOut: true,
    maskIn: true,
    alphaIn: true,
    fileMaskOut: true,
  };
}

/** A Finish layer's mask, as its export is named in the file. */
export const maskExportName = (layer: string): string => `${layer} mask`;

/** The checkbox-made Export Layer card says what it is (2026-10-01:
 * "be explicit something like "Curves Export Layer" and not just
 * "Curves""): the card reads "<what> Export Layer", while the layer
 * in the file keeps the plain name a compositor wants.*/
export const EXPORT_CARD_SUFFIX = " Export Layer";
export const exportCardName = (what: string): string => `${what}${EXPORT_CARD_SUFFIX}`;
/** A Finish layer's mask card: "Sky Mask Export Layer", written "Sky mask". */
export const maskExportCardName = (layer: string): string => exportCardName(`${layer} Mask`);

/** The name an Export Layer node writes into the file when its Name
 * field is empty: the card's label without the " Export Layer" suffix
 * (and a mask card's " Mask" back to the file's " mask"). A label
 * without the suffix, a graph saved before 2026-10-01 or a card
 * renamed by hand, writes as it reads. A typed Name always wins. */
export function exportWrittenName(n: NodeCard): string {
  const typed = n.textParams?.name;
  if (typed !== undefined && typed.trim() !== "") return typed;
  const label = n.name;
  if (!label.endsWith(EXPORT_CARD_SUFFIX) || label.length === EXPORT_CARD_SUFFIX.length) return label;
  const base = label.slice(0, -EXPORT_CARD_SUFFIX.length);
  const src = n.textParams?.source ?? "";
  if ((src.startsWith("finishmask:") || src.startsWith("layermask:")) && base.endsWith(" Mask")) {
    return maskExportName(base.slice(0, -" Mask".length));
  }
  return base;
}

/** What a depth export says about itself, in every seat: its card in
 * the Graph, its Inspector, and the Depth Map section's Export box.
 * The written plane is near black, far white (EXR's mist.Z), the
 * reverse of Develop's Depth Map view, and both stay as they are
 * (2026-10-01: keep both conventions and say so).*/
export const DEPTH_EXPORT_CONVENTION = "Written near black, far white (the EXR depth convention)";

/** Whether this Export Layer writes a depth plane: fed from a depth
 * output port, as the Depth Map section's Export box wires it or as a
 * hand-wired one. Color and mask exports are not. */
export function exportWritesDepth(n: NodeCard, wires: readonly Wire[]): boolean {
  return n.type === "heeler.export_layer" && wires.some((w) => w.to === n.id && w.fromPort === "depth");
}

/** The Develop section checkbox's node id: one per section on Base,
 * and one per section on each Develop layer (`layer` is the layer's
 * own node id). Not under the layer's `layer_<n>_` prefix, like its
 * mask's card: Duplicate Layer copies that prefix, and a copy starts
 * with its boxes clear. */
export const sectionExportId = (title: string, layer?: string | null): string =>
  `dev_x_${layer ? `${layer}_` : ""}${title.toLowerCase().replace(/[^a-z]+/g, "_")}`;

/** What a section's export is called: the section on Base, the layer
 * and the section on a Develop layer ("Sky Exposure"). */
export const sectionExportWhat = (title: string, layerName?: string): string =>
  layerName ? `${layerName} ${title}` : title;

/** The Develop layer a section's Export node taps, or null on Base. */
export function sectionExportLayerOf(n: NodeCard): string | null {
  return sectionExportOf(n) !== null ? n.textParams?.layer || null : null;
}

/** The Develop section whose Export checkbox made this node, or null. */
export function sectionExportOf(n: NodeCard): string | null {
  if (n.type !== "heeler.export_layer") return null;
  const src = n.textParams?.source ?? "";
  return src.startsWith("develop:") ? src.slice("develop:".length) : null;
}

/** A Develop layer's Export Mask as Layer node id (2026-10-01): one
 * per layer, named for the layer's own node. Not under the layer's
 * `layer_<n>_` prefix on purpose: Duplicate Layer copies that prefix,
 * and a copy starts with its box clear.*/
export const layerMaskExportId = (layerId: string): string => `dev_xm_${layerId}`;

/** The Develop layer whose Export Mask as Layer made this node, or null. */
export function layerMaskExportOf(n: NodeCard): string | null {
  if (n.type !== "heeler.export_layer") return null;
  const src = n.textParams?.source ?? "";
  return src.startsWith("layermask:") ? src.slice("layermask:".length) : null;
}

/** Whether this Develop layer writes its mask into the export. */
export function layerMaskExported(s: State, layerId: string): boolean {
  return s.nodes.some((n) => layerMaskExportOf(n) === layerId);
}

/** A Develop layer's mask card goes with its layer (Remove Layer, the
 * layer's node deleted in the graph) and follows its name wherever it
 * changed (Rename Layer, a rename in the graph): "<layer> Mask Export
 * Layer", written "<layer> mask". */
function syncLayerMaskExports(prev: State, s: State): State {
  const cards = s.nodes.filter((n) => layerMaskExportOf(n) !== null || sectionExportLayerOf(n) !== null);
  if (cards.length === 0) return s;
  const byId = new Map(s.nodes.map((n) => [n.id, n]));
  const stale = new Set<string>();
  const renamed = new Map<string, string>();
  const names = new Map(layersOf(s).map((l) => [l.id, l.name]));
  const before = new Map(layersOf(prev).map((l) => [l.id, l.name]));
  for (const c of cards) {
    // A layer section's card ("Sky Exposure Export Layer") follows the
    // name the same way; it goes with the node it taps
    // (pruneSectionExports), which goes with the layer.
    const section = sectionExportLayerOf(c) !== null ? sectionExportOf(c) : null;
    const layer = section !== null ? sectionExportLayerOf(c)! : layerMaskExportOf(c)!;
    if (!byId.has(layer)) {
      stale.add(c.id);
      continue;
    }
    const now = names.get(layer);
    if (now !== undefined && before.has(layer) && before.get(layer) !== now) {
      renamed.set(c.id, section !== null ? exportCardName(sectionExportWhat(section, now)) : maskExportCardName(now));
    }
  }
  if (stale.size === 0 && renamed.size === 0) return s;
  return {
    ...s,
    nodes: s.nodes
      .filter((n) => !stale.has(n.id))
      .map((n) => (renamed.has(n.id) ? { ...n, name: renamed.get(n.id)! } : n)),
    wires: s.wires.filter((w) => !stale.has(w.from) && !stale.has(w.to)),
  };
}

/** A section's Export node goes with the node it taps: deleting that
 * node in the graph, a section switched off that takes its node out,
 * or a splice that wired the card to something else in its place. Its
 * own wire leaving (the card unwired by hand) takes it too, since the
 * checkbox would otherwise read on for a layer that writes nothing. */
function pruneSectionExports(s: State): State {
  const ids = new Set(s.nodes.map((n) => n.id));
  const stale = new Set(
    s.nodes
      .filter((n) => {
        if (sectionExportOf(n) === null) return false;
        const tap = n.textParams?.tap ?? "";
        return !ids.has(tap) || !s.wires.some((w) => w.to === n.id && (w.toPort === "in" || w.toPort === "mask"));
      })
      .map((n) => n.id),
  );
  if (stale.size === 0) return s;
  return {
    ...s,
    nodes: s.nodes.filter((n) => !stale.has(n.id)),
    wires: s.wires.filter((w) => !stale.has(w.from) && !stale.has(w.to)),
  };
}

/** The stack, bottom-most first (the render order). The UI reverses it:
 * a layers panel draws the top-most layer at the top of the list. */
export function artLayers(s: State): ArtLayer[] {
  const g = artGroup(s);
  if (!g?.groupNodes || !g.groupWires) return [];
  const byId = new Map(g.groupNodes.map((n) => [n.id, n]));
  // The Finish tab's Export checkbox is a view over an Export Layer
  // node (26.3 Phase 8): the node carries `source = finish:<blend id>`,
  // and the layer reads as exported while that node lives in the group.
  const exported = new Set(
    g.groupNodes
      .filter((n) => n.type === "heeler.export_layer" && (n.textParams?.source ?? "").startsWith("finish:"))
      .map((n) => n.textParams!.source!.slice("finish:".length)),
  );
  // The mask's own checkbox, the same view over its own node.
  const maskExported = new Set(
    g.groupNodes
      .filter((n) => n.type === "heeler.export_layer" && (n.textParams?.source ?? "").startsWith("finishmask:"))
      .map((n) => n.textParams!.source!.slice("finishmask:".length)),
  );
  const out: ArtLayer[] = [];
  let cur = "art_in";
  for (;;) {
    const hop = g.groupWires.find(
      (w) => w.from === cur && w.toPort === "in" && byId.get(w.to)?.type === "heeler.blend",
    );
    if (!hop) break;
    const blend = byId.get(hop.to)!;
    const feed = g.groupWires.find((w) => w.to === blend.id && w.toPort === "in2");
    let node = feed && byId.get(feed.from);
    if (!node) break;
    // Effects sit between the content and the blend, so walk back down
    // the chain until something that is not an effect answers.
    const fx: NodeCard[] = [];
    while (node && isChainFx(node)) {
      fx.unshift(node);
      const up = g.groupWires.find((w) => w.to === node!.id && w.toPort === "in");
      node = up && byId.get(up.from);
    }
    if (!node) break;
    out.push({ blend, content: node, fx, exported: exported.has(blend.id), maskExported: maskExported.has(blend.id) });
    cur = blend.id;
  }
  return out;
}

export interface ArtLayer {
  blend: NodeCard;
  content: NodeCard;
  /** layer effects, in the order they run: content, then each of these,
   * then the blend. Unlike a layer editor's fixed style list these are nodes
   * on a chain, so a layer can carry two glows or put an outline before
   * a shadow rather than after. */
  fx: NodeCard[];
  /** the Finish tab's Export checkbox (26.3 Phase 8): an Export Layer
   * node inside the art group taps this layer's content. */
  exported: boolean;
  /** the mask's Export checkbox (2026-09-30): an Export Layer node
   * inside the art group writes the weight this layer's blend applies.
   * Optional so the callers that build a layer by hand (a group's
   * members) need not say.*/
  maskExported?: boolean;
}

// Finish warps -------------------------------------------------------------
//
// 2026-09-30: "build both, A for image layers and B for the photo". One
// engine node, heeler.layer_warp, carries Grid Warp's mesh and Shape
// Warp's shapes under the Develop nodes' own param names, so the same
// gizmos and the same section controls edit it; what differs is what it
// warps (heeler-engine/src/ops_warp.rs layer_warp):
//
// - A Warp layer (B): the node IS the layer's content, in the frame's
//   space. Content reads what is below it (artWires), so it warps the
//   photograph and every layer under it, and the layer's blend shows the
//   result through the layer's mask and opacity.
// - An image layer's own warp (A): the node sits FIRST on the layer's
//   effect chain, in the picture's own space, so it bends the picture
//   before the blend places it on its four corners and moves with it.
//   Riding the effect chain is what carries it through Duplicate,
//   grouping, ungrouping, copy and paste, takes and saving untouched.

export const LAYER_WARP = "heeler.layer_warp";

/** Which warp a Grid or Shape Warp edit is aimed at: null the
 * photograph's own, an id a Finish warp node. */
export type WarpTarget = string | null;

/** An image layer's own warp, in the picture's space. */
export function isPictureWarp(n: Pick<NodeCard, "type" | "textParams">): boolean {
  return n.type === LAYER_WARP && (n.textParams?.space ?? "frame") === "picture";
}

/** What the stack walks treat as part of a layer's effect chain between
 * its content and its carrier: the effects, and an image layer's own
 * warp ahead of them. A Warp layer's node is in the frame's space and is
 * the layer's content, not a link in its chain. */
function isChainFx(n: NodeCard): boolean {
  return isLayerEffect(n) || isPictureWarp(n);
}

/** A layer effect node: one of ART_FX's types. Most are heeler.fx_*,
 * but the Blur effect is the plain blur node (see ART_FX.blur), and a
 * walk that only knew the prefix stopped at it and read the blur as the
 * layer's content: adding Blur to a Pixel layer emptied its effect list
 * and lost its strokes from the panel. No Finish layer's content is a
 * blur node (ART_KINDS has none), so the type is enough. */
export function isLayerEffect(n: Pick<NodeCard, "type">): boolean {
  return n.type.startsWith("heeler.fx_") || Object.values(ART_FX).some((f) => f.type === n.type);
}

/** A Finish warp node anywhere in the stack, groups included. */
export function artWarpNode(s: State, id: string): NodeCard | undefined {
  const find = (list: NodeCard[] | undefined): NodeCard | undefined => {
    for (const n of list ?? []) {
      if (n.id === id && n.type === LAYER_WARP) return n;
      const inner = n.isGroup ? find(n.groupNodes) : undefined;
      if (inner) return inner;
    }
    return undefined;
  };
  return find(artGroup(s)?.groupNodes);
}

/** A warp node by id wherever it sits: the Finish stack's (a Warp layer,
 * an image layer's own warp), or one placed by hand in the graph from
 * the palette, which the same gizmos edit in the frame's space. */
export function warpNodeById(s: State, id: string): NodeCard | undefined {
  return s.nodes.find((n) => n.id === id && n.type === LAYER_WARP) ?? artWarpNode(s, id);
}

/** The layer a Finish warp belongs to: its carrier (the blend at top
 * level, the member's carrier in a group), and whether the warp is the
 * picture's own (A) or the layer's content (B). */
export function artWarpOwner(s: State, id: string): { carrier: string; picture: boolean } | undefined {
  const check = (carrier: NodeCard, content: NodeCard, fx: NodeCard[]) =>
    content.id === id && content.type === LAYER_WARP
      ? { carrier: carrier.id, picture: false }
      : fx.some((f) => f.id === id && isPictureWarp(f))
        ? { carrier: carrier.id, picture: true }
        : undefined;
  for (const l of artLayers(s)) {
    const hit = check(l.blend, l.content, l.fx);
    if (hit) return hit;
    if (l.content.isGroup) {
      for (const m of artGroupMembers(l.content)) {
        const inner = check(m.merge, m.content, m.fx);
        if (inner) return inner;
      }
    }
  }
  return undefined;
}

/** The Warp layer whose carrier is `id`, which Bake Warp can turn into
 * an image layer: a layer whose content is a warp in the frame's space
 * (an image layer's own warp bakes nowhere; its picture is already
 * one). */
export function bakeableWarp(s: State, id: string | null | undefined): { carrier: NodeCard; content: NodeCard; groupId?: string } | undefined {
  const found = id ? artFindLayer(s, id) : undefined;
  return found && found.content.type === LAYER_WARP && !isPictureWarp(found.content) ? found : undefined;
}

/** The layer Bake Warp made, whose carrier is `id`, which Unbake can
 * turn back into the live Warp layer it kept: an image layer of a baked
 * picture carrying that Warp layer's definition. Layer via Copy's layers
 * have no warp to restore, and are never this. */
export function unbakeableWarp(s: State, id: string | null | undefined): { carrier: NodeCard; content: NodeCard; groupId?: string; baked: BakedWarp } | undefined {
  const found = id ? artFindLayer(s, id) : undefined;
  const baked = found?.content.bakedFrom;
  return found && baked && found.content.type === "heeler.file" && found.content.textParams?.origin === "bake" && baked.content.type === LAYER_WARP
    ? { ...found, baked }
    : undefined;
}

/** A Finish layer's effects in order, top level or inside a group, by
 * its carrier id. */
function artLayerFx(s: State, id: string): NodeCard[] {
  for (const l of artLayers(s)) {
    if (l.blend.id === id) return l.fx;
    if (l.content.isGroup) {
      const m = artGroupMembers(l.content).find((x) => x.merge.id === id);
      if (m) return m.fx;
    }
  }
  return [];
}

/** An image layer's own warp, when it has one. */
export function imageLayerWarp(s: State, carrierId: string): NodeCard | undefined {
  for (const l of artLayers(s)) {
    if (l.blend.id === carrierId) return l.fx.find(isPictureWarp);
    if (l.content.isGroup) {
      const m = artGroupMembers(l.content).find((x) => x.merge.id === carrierId);
      if (m) return m.fx.find(isPictureWarp);
    }
  }
  return undefined;
}

/** The node a Grid or Shape Warp edit lands on: the Finish warp the
 * target names, or with none the photograph's own Grid or Shape Warp.
 * Undefined when the photograph has no warp of that kind yet (the first
 * write builds it) or the target is gone. */
export function warpNodeFor(s: State, kind: "grid" | "shape", target: WarpTarget = s.warpTarget): NodeCard | undefined {
  if (target) return warpNodeById(s, target);
  const type = kind === "grid" ? "heeler.grid_warp" : "heeler.shape_warp";
  return s.nodes.find((n) => n.type === type);
}

/** A Finish warp's type (2026-09-30: "This layer should by default look
 * like a pixel layer (in size), with an additional button to go into
 * edit mode which then expands to show the controls. The first control
 * is type: Either GRID or SHAPES"). One type applies at a time; the
 * other stays stored and at rest, so switching back restores it.*/
export type WarpKind = "grid" | "shapes";

/** The type a Finish warp has chosen, or with no choice on it (a warp
 * made before the choice, or a new one) the type with content: the
 * shapes when the list has any, the grid otherwise. The engine's
 * layer_warp_uses_shapes reads the same rule, so what the panel names
 * is what renders. */
export function warpKindOf(n: Pick<NodeCard, "textParams"> | undefined): WarpKind {
  const k = n?.textParams?.kind;
  if (k === "grid" || k === "shapes") return k;
  return shapesFromNode(n).length > 0 ? "shapes" : "grid";
}

/** The type a Finish warp has chosen by hand, or null for none. */
function explicitWarpKind(n: Pick<NodeCard, "textParams"> | undefined): WarpKind | null {
  const k = n?.textParams?.kind;
  return k === "grid" || k === "shapes" ? k : null;
}

/** A Finish warp with no Type chosen takes the type an edit writes, in
 * the same step: what is edited is what applies, so removing a warp's
 * last shape cannot hand the render (and the Type) back to a grid the
 * user is not looking at. Nothing for a warp that has chosen, or for the
 * Develop warps, which have no Type. */
function pinnedWarpKind(n: NodeCard, kind: WarpKind): { kind?: WarpKind } {
  return n.type === LAYER_WARP && !explicitWarpKind(n) ? { kind } : {};
}

/** The tool that edits a warp type on the canvas. */
export function warpToolOf(kind: WarpKind): "gridwarp" | "shapewarp" {
  return kind === "grid" ? "gridwarp" : "shapewarp";
}

/** Whether a Finish warp is in edit mode: its type's tool is in hand
 * and aimed at it. One warp at a time, since one tool is. */
export function warpEditing(s: State, id: string): boolean {
  return (s.tool === "gridwarp" || s.tool === "shapewarp") && s.warpTarget === id;
}

/** Edit mode's button: arms the warp's type's tool on it, or, in edit
 * mode already, puts the tool down (the tool's own toggle, a commit). */
export function editWarpCommand(s: State, id: string): Command {
  const node = warpNodeById(s, id);
  return { type: "set_tool", tool: warpToolOf(warpKindOf(node)), target: id };
}

/** The target a warp command names: its own when it carries one (the
 * section controls always do), the armed tool's otherwise (the canvas
 * gizmos). */
function warpCmdTarget(s: State, cmd: { target?: WarpTarget }): WarpTarget {
  return cmd.target !== undefined ? cmd.target : s.warpTarget;
}

/** A fresh Finish warp node: the Develop warps' params, at rest. */
function newLayerWarpNode(id: string, name: string, space: "frame" | "picture", x: number, y: number): NodeCard {
  return {
    id,
    type: LAYER_WARP,
    name,
    cat: "color",
    x,
    y,
    enabled: true,
    params: { cols: 4, rows: 3, room: 25 },
    textParams: {
      space,
      cols_u: "",
      rows_v: "",
      mesh: "[]",
      lattice: "",
      shapes: "[]",
      // A picture's own warp opens past its edges onto nothing: the
      // room around it is transparent, never its border stretched.
      edges: space === "picture" ? "transparent" : "clamp",
    },
    artKind: space === "picture" ? "picture_warp" : "warp",
    hasIn: true,
    hasOut: true,
  };
}

/** A stack group's members, in render order. Inside a group the
 * carrier is a MERGE (Porter-Duff over, opacity only): the sub-stack
 * composites over a transparent canvas in isolation, and the group's
 * own blend node applies mode/opacity/mask to the finished unit. That
 * is the layer editors' isolation-group shape; the trade is that member blend MODES do not exist inside a group. */
export function artGroupMembers(
  group: NodeCard,
): { merge: NodeCard; content: NodeCard; fx: NodeCard[] }[] {
  if (!group.isGroup || !group.groupNodes || !group.groupWires) return [];
  const byId = new Map(group.groupNodes.map((n) => [n.id, n]));
  const canvas = group.groupNodes.find((n) => n.id.endsWith("_c"));
  if (!canvas) return [];
  const out: { merge: NodeCard; content: NodeCard; fx: NodeCard[] }[] = [];
  let cur = canvas.id;
  for (;;) {
    // Either carrier: a group made before 2026-08-27 chains merges, and
    // one made since chains blends (which is what gives a member a mask
    // port, a mode and a clip port: see MEMBER_CARRIER below).
    const hop = group.groupWires.find(
      (w) =>
        w.from === cur &&
        w.toPort === "in" &&
        (byId.get(w.to)?.type === "heeler.merge" || byId.get(w.to)?.type === "heeler.blend"),
    );
    if (!hop) break;
    const merge = byId.get(hop.to)!;
    const feed = group.groupWires.find((w) => w.to === merge.id && w.toPort === "in2");
    let node = feed && byId.get(feed.from);
    if (!node) break;
    // Effects sit between the content and the carrier, exactly as they
    // do at the top level, so walk back down the chain to the content.
    const fx: NodeCard[] = [];
    while (node && isChainFx(node)) {
      fx.unshift(node);
      const up = group.groupWires.find((w) => w.to === node!.id && w.toPort === "in");
      node = up && byId.get(up.from);
    }
    if (!node) break;
    out.push({ merge, content: node, fx });
    cur = merge.id;
  }
  return out;
}

/** What carries a layer inside a stack group.
 *
 * It was heeler.merge, which composites and nothing else. On living
 * with grouped layers: "I can not expand/open up a group to access any
 * of the controls for layer FX, Masks, and Smart Masks." Merge is why:
 * the node has a base port and a foreground port and no mask port at
 * all (crates/heeler-graph/src/spec.rs), so a mask had nowhere to land
 * and a blend mode had nothing to write to.
 *
 * A blend at mode "normal" composites identically (ops.rs: both are
 * fg*a over base*(1-a)) and brings the mask, mode and clip ports with
 * it. So members carry blends now, and a group made before this reads
 * back exactly as it was: artGroupMembers accepts either, and
 * migrateGroupCarriers below converts them on load. */
export const MEMBER_CARRIER = "heeler.blend";

/** A layer anywhere in the stack, top level or inside a group, found
 * by its carrier id (the blend at top level, the merge inside a
 * group). What the caller usually wants is the content node to write
 * strokes on. */
export function artFindLayer(
  s: State,
  id: string,
): { carrier: NodeCard; content: NodeCard; groupId?: string } | undefined {
  for (const l of artLayers(s)) {
    if (l.blend.id === id) return { carrier: l.blend, content: l.content };
    if (l.content.isGroup) {
      const m = artGroupMembers(l.content).find((x) => x.merge.id === id);
      if (m) return { carrier: m.merge, content: m.content, groupId: l.content.id };
    }
  }
  return undefined;
}

/** Rebuilds a stack group's internal wiring from its member list: the
 * transparent canvas anchors the merge chain, each member's content
 * reads the composite below it inside the group, as a top-level
 * layer's does (an adjustment corrects those pixels, a clone samples
 * them, a paint layer takes their size), and the last merge is the
 * group's exit. Until 26.4.1 every content read the empty canvas, so
 * a grouped adjustment corrected nothing (the Finish review of
 * 2026-10-03). */
function artGroupWires(
  canvasId: string,
  members: { merge: string; content: string; fx?: string[] }[],
): Wire[] {
  const ws: Wire[] = [];
  let prev = canvasId;
  for (const m of members) {
    ws.push({ from: prev, to: m.content, toPort: "in", kind: "image" });
    ws.push({ from: prev, to: m.merge, toPort: "in", kind: "image" });
    // Effects run between the content and the carrier, in order, the
    // same shape artWires builds one level up.
    let tail = m.content;
    for (const f of m.fx ?? []) {
      ws.push({ from: tail, to: f, toPort: "in", kind: "image" });
      tail = f;
    }
    ws.push({ from: tail, to: m.merge, toPort: "in2", kind: "image" });
    prev = m.merge;
  }
  return ws;
}

/** The graph with every stack group's members reading the composite
 * below them (artGroupWires). A group saved before 26.4.1 feeds each
 * member's content from its empty canvas, and its wiring is only
 * rebuilt when the group's members change, so a saved group with an
 * adjustment in it would go on correcting nothing. Derived where the
 * graph is sent to the engine, like the conversions around a Finish
 * adjustment: the saved wiring is not rewritten. The same array back
 * when there is nothing to change. */
export function groupMembersReadBelow(nodes: NodeCard[]): NodeCard[] {
  let changed = false;
  const out = nodes.map((n) => {
    if (!n.isGroup || !n.groupNodes || !n.groupWires) return n;
    const inner = groupMembersReadBelow(n.groupNodes);
    const canvas = n.groupNodes.find((k) => k.id.endsWith("_c"))?.id;
    const below = new Map<string, string>();
    artGroupMembers(n).forEach((m, i, all) => {
      if (i > 0) below.set(m.content.id, all[i - 1].merge.id);
    });
    const stale = (w: Wire) => w.toPort === "in" && w.from === canvas && below.has(w.to);
    const wires = n.groupWires.some(stale)
      ? n.groupWires.map((w) => (stale(w) ? { ...w, from: below.get(w.to)! } : w))
      : n.groupWires;
    if (inner === n.groupNodes && wires === n.groupWires) return n;
    changed = true;
    return { ...n, groupNodes: inner, groupWires: wires };
  });
  return changed ? out : nodes;
}

/** A stack group rebuilt from a member list: the mirror of
 * withArtLayers, one level down. Returns null when the id names no
 * group, so the caller can refuse rather than guess. */
function withGroupMembers(
  s: State,
  groupContentId: string,
  mutate: (
    members: { merge: NodeCard; content: NodeCard; fx: NodeCard[] }[],
  ) => { merge: NodeCard; content: NodeCard; fx: NodeCard[] }[],
): State | null {
  const layer = artLayers(s).find((l) => l.content.id === groupContentId);
  if (!layer?.content.isGroup) return null;
  const canvas = layer.content.groupNodes?.find((n) => n.id.endsWith("_c"));
  if (!canvas) return null;
  const next = mutate(artGroupMembers(layer.content));
  const group: NodeCard = {
    ...layer.content,
    groupNodes: [canvas, ...next.flatMap((m) => [m.content, ...m.fx, m.merge])],
    groupWires: artGroupWires(
      canvas.id,
      next.map((m) => ({
        merge: m.merge.id,
        content: m.content.id,
        fx: m.fx.map((f) => f.id),
      })),
    ),
  };
  return withArtLayers(s, (list) =>
    list.map((l) => (l.content.id === groupContentId ? { ...l, content: group } : l)),
  );
}

/** The next free art id number, across every kind of art node. */
function artNextId(s: State): number {
  let n = 0;
  const scan = (id: string) => {
    const m = id.match(/^art_[bg](\d+)/);
    if (m) n = Math.max(n, Number(m[1]));
  };
  for (const l of artLayers(s)) {
    scan(l.blend.id);
    scan(l.content.id);
    if (l.content.isGroup) {
      for (const mem of artGroupMembers(l.content)) scan(mem.merge.id);
    }
  }
  return n + 1;
}

/** Applies `fn` to one node anywhere inside the art group, nested
 * groups included, leaving all wiring alone. Null when the id is not
 * in the stack: the caller decides whether that is an error. */
function updateArtNodeDeep(
  s: State,
  id: string,
  fn: (n: NodeCard) => NodeCard,
): State | null {
  const g = artGroup(s);
  if (!g?.groupNodes) return null;
  let hit = false;
  const mapList = (list: NodeCard[]): NodeCard[] =>
    list.map((n) => {
      if (n.id === id) {
        hit = true;
        return fn(n);
      }
      if (n.isGroup && n.groupNodes) return { ...n, groupNodes: mapList(n.groupNodes) };
      return n;
    });
  const nodes = s.nodes.map((n) =>
    n.id === ART_ID ? { ...n, groupNodes: mapList(n.groupNodes!) } : n,
  );
  return hit ? { ...s, nodes } : null;
}

/** The document selection: one selection mask belonging to the picture
 * rather than to a layer.
 *
 * Arming the select tool used to grow a mask on the active layer, which
 * meant that reaching for the tool silently changed the layer. The
 * report: "This is not expected... There are a lot of reasons I may be
 * using a selection that have nothing to do with masking." So a
 * selection lives here instead, and what it does next is the user's
 * choice: clip the paint, or become a layer mask on request.
 */
/** Find a Control's landing border: two seconds at full strength, then
 * four fading out (2026-09-11). The fade is the .control-flash
 * animation in theme.css; this is how long the state has to outlive
 * it, and the two are held together by a test.*/
export const CONTROL_FLASH_MS = 6000;

export const DOC_SEL_ID = "sel_doc";

/** How Mask from selection lands in a layer's mask: the selection becomes
 * the mask, or is added to it (Shift), or taken out of it (Option/Alt). */
export type MaskFromSelectionOp = "replace" | "add" | "subtract";

/** Whether a selection mask holds anything: a live region, a polish
 * stroke, or a base under them (a Smart selection's raster, a converted
 * mask's bake, a Refine edge matte). A Smart click or Subject selection
 * has no regions at all: its whole content is the base. */
export function selectionHasContent(n: NodeCard | undefined): boolean {
  if (!n) return false;
  return (
    (n.regions ?? []).some((r) => !r.off) ||
    (n.strokes ?? []).length > 0 ||
    (n.textParams?.matte_id ?? "") !== ""
  );
}

/** Whether a selection shows anything a Subtract or Intersect could act
 * on: a region that adds (a list of only Subtracts selects nothing), a
 * polish stroke, or a base. */
function selectionShows(n: NodeCard): boolean {
  return (
    (n.regions ?? []).some((r) => !r.off && (r.op === "replace" || r.op === "add")) ||
    (n.strokes ?? []).length > 0 ||
    (n.textParams?.matte_id ?? "") !== ""
  );
}

/** A live model-made mask, a Smart mask (its subject, sky or clicks) or
 * an Object mask (the objects the file names), with something in it: a
 * recipe, or shapes drawn on it with the selection tools. */
export function liveMaskHasContent(n: NodeCard | undefined): boolean {
  if (!n) return false;
  const drawn = (n.regions ?? []).some((r) => !r.off);
  if (n.type === "heeler.smart_mask") {
    return (
      drawn ||
      (n.textParams?.mode || "click") !== "click" ||
      (n.textParams?.prompts || "[]") !== "[]" ||
      (n.textParams?.model ?? "") !== ""
    );
  }
  if (n.type === "heeler.matte_mask") return drawn || (n.textParams?.names || "[]") !== "[]";
  return false;
}

/** The live Smart or Object mask in hand, with something in it: the mask
 * of the layer being edited (the Finish layer's in the Finish tab, the
 * Develop layer's elsewhere, either as the fallback), or in the Graph
 * and Canvas the mask node picked there. What a shape drawn with the
 * selection tools combines with when there is no selection to combine
 * with (selectShapeTarget). */
export function liveMaskInHand(s: State): NodeCard | undefined {
  const dev = s.activeLayer ? maskOfLayer(s.activeLayer) : undefined;
  const art = s.artActive ? `art_m_${s.artActive}` : undefined;
  const layers = s.panelTab === "layers" ? [art, dev] : [dev, art];
  const inGraph = s.mode === "advanced" || s.mode === "canvas";
  const candidates = inGraph ? [...s.selection, ...layers] : layers;
  for (const id of candidates) {
    if (!id) continue;
    const node = artMaskNode(s, id);
    if (node && liveMaskHasContent(node)) return node;
    // A Develop Selection layer's mask is a live selection of its own:
    // arming the tool picks the document selection, and a Subtract over
    // the layer's ants belongs to the layer, the way it does on a Smart
    // layer.
    if (node && node.id === dev && node.type === "heeler.selection_mask" && selectionShows(node)) return node;
  }
  return undefined;
}

/** Where a shape drawn with the selection tools lands (2026-10-02:
 * "when using the smart selection layer, if I select an subject (and
 * it selects a bit more than it should) I tried switching to the
 * selection tool and doing a subtract selection to remove the extra
 * selection but it didn't work").
 *
 * Add, Subtract and Intersect combine with the selection on screen. That
 * is `held`, the selection the tool draws (the document selection, or a
 * Develop Selection layer's mask), whenever it shows anything. When it
 * is empty and a live Smart or Object mask is in hand (liveMaskInHand),
 * the mask is what is on screen, its ants marching, and the shape
 * combines with it: stored on the mask as a region, rendered by the
 * engine on top of the model's cut at every size, undone in one step.
 * The Subtract used to land on the empty document selection, where it
 * took nothing out of nothing and the layer never heard of it.
 *
 * New is a new selection and always draws `held`: picking up the
 * selection tool never changes a layer by itself ("There are
 * a lot of reasons I may be using a selection that have nothing to do
 * with masking"), and a New marquee with a Smart layer active is one of
 * them. `held` is also the answer when nothing else is in hand.*/
export function selectShapeTarget(s: State, held: NodeCard, op: SelectOp): NodeCard {
  if (op === "replace" || selectionShows(held)) return held;
  return liveMaskInHand(s) ?? held;
}

/** Whether a shape with this op would act on nothing: a Subtract or an
 * Intersect with an empty selection and no live mask in hand. */
export function shapeActsOnNothing(s: State, held: NodeCard, op: SelectOp): boolean {
  return (op === "subtract" || op === "intersect") && selectShapeTarget(s, held, op) === held && !selectionShows(held);
}

/** The Smart mask the Smart tool and panel drive: the active Develop
 * layer's or the active Finish layer's, or in the Graph and Canvas
 * the node picked there first (a Smart Mask added in the graph
 * belongs to no layer, and the Develop layer still active underneath
 * would otherwise take its clicks; 2026-10-01). ui/smarttool.tsx's
 * activeSmartMask is this.*/
export function smartMaskInHand(s: State): NodeCard | undefined {
  const layers = [s.activeLayer ? maskOfLayer(s.activeLayer) : undefined, s.artActive ? `art_m_${s.artActive}` : undefined];
  const inGraph = s.mode === "advanced" || s.mode === "canvas";
  const candidates = inGraph ? [...s.selection, ...layers] : [...layers, ...s.selection];
  for (const id of candidates) {
    if (!id) continue;
    const node = artMaskNode(s, id);
    if (node?.type === "heeler.smart_mask") return node;
  }
  return undefined;
}

/** Whether a mask traces anything for the marching ants: a selection
 * that shows something (selectionShows), or a live Smart or Object mask
 * with something in it (liveMaskHasContent). */
function antsTrace(n: NodeCard): boolean {
  return n.type === "heeler.selection_mask" ? selectionShows(n) : liveMaskHasContent(n);
}

/** Every mask the marching ants trace on screen, the one Polish refines
 * first (2026-10-02: "there are active marching ants in the scene the
 * polish tool ignored"). One list, read by the viewer's ants and by
 * Select > Polish (polishSource), so the two can never disagree about
 * what is selected: the selection the Select menu works on when it
 * shows anything, then the live mask in hand (liveMaskInHand: a Smart
 * or Object mask, a Develop Selection layer's), then the Smart mask
 * the Smart tool drives, then the active Finish layer's live mask.*/
export function antsSources(s: State): NodeCard[] {
  const out: NodeCard[] = [];
  const consider = (n: NodeCard | undefined) => {
    if (!n || out.some((o) => o.id === n.id) || !antsTrace(n)) return;
    out.push(n);
  };
  consider(activeSelectionMask(s));
  consider(liveMaskInHand(s));
  consider(smartMaskInHand(s));
  if (s.artActive) consider(artMaskNode(s, `art_m_${s.artActive}`));
  return out;
}

/** What Select > Polish refines: the first mask the ants trace
 * (antsSources), and how Polish reaches it.
 *
 * - "selection": a selection mask (the document selection, a Develop
 *   Selection layer's mask) is polished as it is.
 * - "develop": a Develop layer's live mask (or a mask node picked in the
 *   graph) becomes that layer's selection first, as its mask block's
 *   Polish button makes it (convert_mask_to_selection).
 * - "layer": a Finish layer's live mask is polished in the document
 *   selection and put back on the layer by Apply (polish_layer_mask);
 *   a Finish layer's mask is never a live selection itself.
 *
 * Undefined when nothing on screen is selected: Polish does not open on
 * an empty selection. */
export function polishSource(
  s: State,
): { kind: "selection" | "develop" | "layer"; node: NodeCard; layerId?: string } | undefined {
  const node = antsSources(s)[0];
  if (!node) return undefined;
  if (node.type === "heeler.selection_mask") return { kind: "selection", node };
  if (node.id.startsWith("art_m_")) {
    const layerId = node.id.slice("art_m_".length);
    return artFindLayer(s, layerId) ? { kind: "layer", node, layerId } : undefined;
  }
  return { kind: "develop", node };
}

/** The name the status line gives a Finish layer: its own, else "the
 * layer". */
export function artLayerName(s: State, layerId: string): string {
  return artFindLayer(s, layerId)?.carrier.name || "the layer";
}

/** The status line while a Finish layer's mask is being polished,
 * outcome first. */
export function polishLayerLine(s: State): string | null {
  if (!s.polishLayer || s.tool !== "polish") return null;
  return `Polishing ${artLayerName(s, s.polishLayer.layerId)}'s mask: Apply puts the refined edge back on the layer, Escape leaves the mask as it was`;
}

/** What the status line says when Polish finds nothing on screen to
 * refine. */
export const POLISH_NOTHING_LINE =
  "Nothing to polish: select something first, or pick a layer with a Smart or Object mask";

/** The document selection put back the way a Finish layer's mask polish
 * found it (State.polishLayer): the node as it was, or no node and no
 * pipe into it when there was none. */
function restoreDocSelection(s: State, pass: PolishLayerPass): State {
  if (pass.docSel) {
    const had = s.nodes.some((n) => n.id === DOC_SEL_ID);
    return {
      ...s,
      nodes: had ? s.nodes.map((n) => (n.id === DOC_SEL_ID ? pass.docSel! : n)) : [...s.nodes, pass.docSel],
    };
  }
  const touches = (w: Wire) => w.to === DOC_SEL_ID || w.from === DOC_SEL_ID;
  return {
    ...s,
    nodes: s.nodes.filter((n) => n.id !== DOC_SEL_ID),
    wires: s.wires.filter((w) => !touches(w) || pass.entry.wires.includes(w)),
  };
}

/** Cancel for a Finish layer's mask polish: the document selection as it
 * was, the steps the pass made off the history, the tool down. The layer
 * was never touched. */
function cancelPolishLayer(s: State): State {
  const pass = s.polishLayer;
  if (!pass) return s;
  const restored = restoreDocSelection(s, pass);
  return {
    ...restored,
    tool: s.tool === "polish" ? "none" : s.tool,
    toolRevert: s.tool === "polish" ? null : s.toolRevert,
    selection: s.selection.filter((id) => id !== DOC_SEL_ID),
    undoStack: s.undoStack.slice(0, pass.depth),
    redoStack: pass.redo,
    polishLayer: null,
  };
}

/** A Finish layer's mask polish followed through whatever command just
 * ran (reduceWithLifted): leaving Polish any way but Cancel is Apply,
 * which PolishLayerRunner lands (polish_layer_mask_land); a switch to
 * another photograph cancels the pass on the photograph it was opened
 * on first, so the switch never carries a half-made selection away. */
function polishLayerFollow(before: State, next: State, cmd: Command): State {
  const pass = before.polishLayer;
  if (!pass) return next;
  if (next.activeImage !== before.activeImage) {
    return reduceInner(cancelPolishLayer(before), cmd);
  }
  if (next.polishLayer !== pass) return next;
  if (pass.applying === 0 && before.tool === "polish" && next.tool !== "polish") {
    polishLayerSeq += 1;
    return { ...next, polishLayer: { ...pass, applying: polishLayerSeq } };
  }
  return next;
}

/** Counts Applies of a Finish layer's mask polish, so each is one ask
 * (PolishLayerRunner takes each count once). */
let polishLayerSeq = 0;

/** The keys of a layer mask's Depth block, which every mask kind carries
 * itself: a mask made into a pixel mask keeps them. */
const MASK_DEPTH_KEYS = [
  "depth_on",
  "depth_invert",
  "depth_black",
  "depth_white",
  "depth_gamma",
  "depth_black_soft",
  "depth_white_soft",
] as const;

/** A layer mask's brush polarity: 1 where painting HIDES (a Finish layer
 * mask, as Add layer mask makes it), 0 where painting reveals (a Develop
 * layer's brush, a Fill or removal layer's hole). A selection made into
 * the mask is laid in to match (base_invert), so the mask shows the
 * selection either way and the brush keeps the reflex its layer has. */
export function layerMaskPolarity(s: State, maskId: string): 0 | 1 {
  if (!maskId.startsWith("art_m_")) return 0;
  const layer = artFindLayer(s, maskId.slice("art_m_".length));
  return layer?.content.type === "heeler.inpaint" ? 0 : 1;
}

/** A layer's pixel mask wearing a bake of a selection (2026-09-30: "I
 * expect when I clicked To Mask that it made a regular black and white
 * mask and I could clear the selection"; "drop the live mask, make To
 * Mask a pixel mask"): the brush mask Add layer mask makes, its base
 * the coverage the desktop rendered once (bake_layer_mask), nothing
 * painted on it yet. `keep` carries what the mask already had that
 * outlives its pixels: the Depth block. `outline` is the shape the
 * coverage was drawn as, when it was drawn geometry (selectionOutline):
 * kept beside the pixels, never rendered (the engine's brush mask has
 * no regions), so the Transform tool can box the visible pixels and
 * Select Layer Pixels can hand the shape back, as they did when the
 * mask was a live selection; it follows a crop as any region does.*/
export function pixelMaskWearing(
  mask: NodeCard,
  version: string,
  polarity: 0 | 1,
  keep?: NodeCard,
  outline?: SelectRegion[],
): NodeCard {
  const depth = Object.fromEntries(
    MASK_DEPTH_KEYS.filter((k) => keep?.params?.[k] !== undefined).map((k) => [k, keep!.params[k]]),
  );
  return {
    ...mask,
    type: "heeler.brush_mask",
    name: "Layer Mask",
    params: { ...LAYER_MASK_DEFAULTS.brush, ...depth, invert: polarity, base_invert: polarity },
    textParams: { matte_id: `baked:${version}` },
    strokes: [],
    regions: outline && outline.length ? outline : undefined,
    curves: undefined,
  };
}

/** A selection's shape as drawn geometry, when that is all it is: its
 * regions, with no model or bake under them and no polish strokes on
 * them (the coverage is then the shape; dials only soften its edge).
 * Undefined otherwise. */
export function selectionOutline(n: NodeCard): SelectRegion[] | undefined {
  if ((n.textParams?.matte_id ?? "") !== "" || (n.strokes ?? []).length > 0) return undefined;
  const regions = (n.regions ?? []).filter((r) => !r.off);
  return regions.length ? structuredClone(regions) : undefined;
}

/** The outline a pixel mask keeps after a selection lands in it
 * (Mask from selection): the selection's own for a plain click; for Shift
 * and Option, the mask's outline with the selection's shapes added or
 * subtracted, when both are drawn geometry and nothing has been painted
 * on the mask; otherwise none. */
function outlineAfter(op: MaskFromSelectionOp, mask: NodeCard | undefined, sel: NodeCard): SelectRegion[] | undefined {
  const drawn = selectionOutline(sel);
  if (op === "replace" || !drawn) return op === "replace" ? drawn : undefined;
  if (!mask) return op === "add" ? drawn : undefined;
  if (mask.type !== "heeler.brush_mask" || (mask.strokes ?? []).length > 0) return undefined;
  const had = (mask.regions ?? []).filter((r) => !r.off);
  if (!had.length) return undefined;
  return [...structuredClone(had), ...drawn.map((r) => ({ ...r, op: op === "add" ? "add" : "subtract" }) as SelectRegion)];
}

/** The document selection once a layer's mask has been made of it:
 * empty, its Smart recipe with it, as Deselect leaves it. */
function selectionSpent(n: NodeCard): NodeCard {
  return { ...n, regions: [], strokes: [], textParams: { ...n.textParams, matte_id: "", prompts: "", mode: "" } };
}

/** A layer mask saved as a live selection (before 2026-09-30) as the
 * pixel mask it opens as. The selection's recipe is kept frozen, in the
 * form the desktop receives it (regions and polish strokes as JSON), and
 * the engine renders it as the mask's base exactly as it rendered the
 * selection; nothing edits it, the brush paints on top. A removal's hole
 * still waiting for its snapshot keeps the pointer the removal fills in.
 * The desktop's rule for graphs it reads unmigrated is lib.rs
 * selection_as_pixel_mask. */
export function selectionAsPixelMask(n: NodeCard, polarity: 0 | 1): NodeCard {
  const params: Record<string, number> = {};
  const frozen: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(n.params ?? {})) {
    if ((MASK_DEPTH_KEYS as readonly string[]).includes(k)) params[k] = v;
    else frozen[k] = v;
  }
  const { source = "", ...text } = n.textParams ?? {};
  Object.assign(frozen, text);
  frozen.regions = JSON.stringify((n.regions ?? []).filter((r) => !r.off));
  frozen.strokes = JSON.stringify(n.strokes ?? []);
  const matte = text.matte_id ?? "";
  const pending = source !== "" && matte === "";
  return {
    ...n,
    type: "heeler.brush_mask",
    params: { ...params, invert: polarity, base_invert: polarity },
    textParams: {
      ...(source !== "" ? { source, matte_id: matte } : {}),
      ...(pending ? {} : { base_selection: JSON.stringify(frozen) }),
    },
    strokes: [],
    // The drawn outline beside the pixels, as pixelMaskWearing keeps it.
    regions: selectionOutline(n),
  };
}

/** Saved Finish layer masks that were live selections open as pixel
 * masks (selectionAsPixelMask): a layer mask is always the paintable
 * kind. A mask sits in the Finish group since 2026-10-01 and in the
 * top-level list before it, and opens the same way in either; the layer
 * it gates says the brush's polarity. */
function selectionLayerMasksAsPixels(nodes: NodeCard[]): NodeCard[] {
  const isLive = (n: NodeCard) => n.type === "heeler.selection_mask" && n.id.startsWith("art_m_");
  const artNode = nodes.find((n) => n.id === ART_ID);
  if (!nodes.some(isLive) && !artNode?.groupNodes?.some(isLive)) return nodes;
  // The layers whose content is a fill: their wire from an inpaint node.
  const fills = new Set<string>();
  const walk = (g: NodeCard) => {
    const members = g.groupNodes ?? [];
    for (const w of g.groupWires ?? []) {
      if (members.some((m) => m.id === w.from && m.type === "heeler.inpaint")) fills.add(w.to);
    }
    for (const m of members) if (m.isGroup) walk(m);
  };
  if (artNode) walk(artNode);
  const open = (n: NodeCard) => (isLive(n) ? selectionAsPixelMask(n, fills.has(n.id.slice("art_m_".length)) ? 0 : 1) : n);
  return nodes.map((n) =>
    n === artNode && artNode.groupNodes?.some(isLive) ? { ...n, groupNodes: artNode.groupNodes.map(open) } : open(n),
  );
}

/** The brush mask the mask brush would write to right now: the
 * develop layer's, else the picked one, else the only one. ONE
 * resolver, used by the viewer's seat and the settings swatch
 * alike, because the two disagreeing is how the cursor said black
 * while the panel said white (the owner's screenshot).*/
export function maskBrushTarget(state: State): NodeCard | undefined {
  // A Finish layer's mask is in the Finish group: read where it sits.
  const s = artMaskView(state);
  const layerBrush = s.activeLayer
    ? s.nodes.find(
        (n) => n.id === maskOfLayer(s.activeLayer!) && n.type === "heeler.brush_mask",
      )
    : undefined;
  return (
    layerBrush ??
    s.nodes.find((n) => n.type === "heeler.brush_mask" && s.selection.includes(n.id)) ??
    s.nodes.find((n) => n.type === "heeler.brush_mask")
  );
}

/** True while a removal sourced from this mask is still computing
 * (hole unbaked or fill not landed). The ONLY thing that refuses a
 * new Remove: finished removals never block the next one, because the
 * document selection is one node reused for every marquee the user
 * draws. */
export function removalPending(s: State, maskId: string): boolean {
  // The chain-spliced flavor (Adjustments)...
  if (
    s.nodes.some(
      (n) =>
        n.type === "heeler.inpaint" &&
        (n.textParams?.source === maskId || n.id === `inpaint_${maskId}`) &&
        (n.textParams?.fill_id ?? "") === "",
    )
  ) {
    return true;
  }
  // ...and the Finish flavor: a Fill layer whose selection-snapshot
  // mask names this source and whose fill has not landed yet.
  return artLayers(s).some(
    (l) =>
      l.content.type === "heeler.inpaint" &&
      (l.content.textParams?.fill_id ?? "") === "" &&
      (artMaskNode(s, `art_m_${l.blend.id}`)?.textParams?.source ?? null) === maskId,
  );
}

// ---------------------------------------------------------------------------
// Presets: a saved LOOK. The develop chain minus the facts that belong to the
// photograph it was made on - geometry, lens, the source, the layers and
// their masks, the Finish stack, and every per-image cache pointer. the
// owner's contract, agreed 2026-08-25: "Applying a preset essentially means
// replacing the whole node graph", with exactly those carve-outs.

export const PRESET_SCHEMA = 1;

export interface PresetFile {
  schema: number;
  name: string;
  nodes: NodeCard[];
  wires: Wire[];
}

/** The photo's own facts: their params survive an apply untouched. */
const PRESET_PHOTO_TYPES = new Set([
  "heeler.image_source",
  "heeler.crop_rotate",
  "heeler.lens_correct",
  // A mesh, or a list of shapes, is a fact about one photograph's
  // frame and content.
  "heeler.grid_warp",
  "heeler.shape_warp",
]);

/** textParams that point at per-image caches: a preset carrying one
 * would reference rasters on the AUTHOR's machine and arrive corrupt
 * (an exported fill_id names removed content; a matte_id names a
 * raster that never traveled). */
const PRESET_STRIP_TEXT = ["matte_id", "fill_id", "source", "prompts"];

/** Is this node part of the LOOK, or a fact about the photo? */
function presetKeepsNode(n: NodeCard): boolean {
  if (isLayerNode(n.id)) return false; // develop layers, masks, tools
  if (n.id === ART_ID || n.id.startsWith("art_")) return false; // Finish stack
  if (n.id === DOC_SEL_ID) return false; // the document selection
  if (n.id.startsWith("inpaint_")) return false; // removals and their holes
  return true;
}

/** The owner's Grid Warp review: Copy Edits carries the look, while the
 * mesh stays with its photograph. Heal the donor's warp out, then
 * restore the target's own warp and its chain seat. Shared with disk
 * pastes.*/
export function pasteGraphKeepingWarp(
  donor: { nodes: NodeCard[]; wires: Wire[] },
  target: { nodes: NodeCard[]; wires: Wire[] },
  /** the target photograph's shape, when known: its kept warps were
   * drawn on its own crop's frame and arrive under the donor's crop, so
   * they are carried onto it the way a re-crop carries them
   * (framemap.ts); unknown keeps their numbers as they are */
  targetAspect?: number | null,
): { nodes: NodeCard[]; wires: Wire[] } {
  const donorWarps = donor.nodes.filter((n) => n.type === "heeler.grid_warp" || n.type === "heeler.shape_warp");
  const targetWarps = target.nodes.filter((n) => n.type === "heeler.grid_warp" || n.type === "heeler.shape_warp");
  if (!donorWarps.length && !targetWarps.length) return { nodes: structuredClone(donor.nodes), wires: structuredClone(donor.wires) };
  let wires = structuredClone(donor.wires);
  for (const node of donorWarps) wires = spliceOut(wires, node.id);
  const removed = new Set(donorWarps.map((n) => n.id));
  wires = wires.filter((w) => !removed.has(w.from) && !removed.has(w.to));
  const nodes = structuredClone(donor.nodes.filter((n) => !removed.has(n.id)));
  const carry = targetAspect ? frameRemap(cropGeomOf(target.nodes), cropGeomOf(donor.nodes), targetAspect) : null;
  for (const node of targetWarps) {
    if (nodes.some((n) => n.id === node.id)) continue;
    nodes.push(structuredClone(carry ? remapNode(node, carry) : node));
    wires = spliceIn(wires, node.id);
  }
  // Hand-wired warp ids have no CHAIN_ORDER seat. Reuse their target
  // wires wherever both endpoints survived the paste.
  const ids = new Set(nodes.map((n) => n.id));
  const custom = new Set(targetWarps.filter((n) => !CHAIN_ORDER.includes(n.id)).map((n) => n.id));
  for (const wire of target.wires.filter((w) => (custom.has(w.from) || custom.has(w.to)) && ids.has(w.from) && ids.has(w.to))) {
    wires = wires.filter((w) => w.to !== wire.to || w.toPort !== wire.toPort);
    wires.push(structuredClone(wire));
  }
  // The donor's masks read its warps' frame, which spliced shut onto
  // the frame before them; the target's warps put the frame back.
  return { nodes, wires: masksReadTheFrame(nodes, wires) };
}

/** Whether a captured node is a switched-off section riding along. A
 * section turned off keeps its node, bypassed, so the photograph
 * can turn it back on with everything it had; a LOOK has no use for
 * it, and applying the preset without the node means the same thing
 * (the section off). The photo facts stay for the chain shape, and
 * the profile stays because a rendered source carries it bypassed
 * on purpose (2026-09-07: "so many disabled and benign nodes were
 * added to the presets").*/
function presetDropsBypassed(n: NodeCard): boolean {
  return (
    n.enabled === false &&
    !PRESET_PHOTO_TYPES.has(n.type) &&
    n.type !== "heeler.tone_profile" &&
    n.type !== "heeler.output"
  );
}

/** The current look as a preset: sanitized, portable, schema-stamped. */
export function capturePreset(s: State, name: string): PresetFile {
  let chain = s.wires;
  for (const n of s.nodes) if (presetKeepsNode(n) && presetDropsBypassed(n)) chain = spliceOut(chain, n.id);
  const nodes = s.nodes.filter((n) => presetKeepsNode(n) && !presetDropsBypassed(n)).map((n) => {
    const clone = structuredClone(n);
    // The photo's facts ride along as NEUTRAL placeholders: the chain
    // shape needs the nodes, the file must not carry the crop.
    if (PRESET_PHOTO_TYPES.has(n.type)) {
      clone.params = {};
      clone.textParams = undefined;
    }
    // A File node's path names a file on the author's disk; the node
    // travels, the path does not.
    if (n.type === "heeler.file" && clone.textParams) {
      clone.textParams = { ...clone.textParams, path: "" };
    }
    // A Catalog node's photo is one catalog's id; the node travels,
    // the reference does not.
    if (n.type === "heeler.catalog" && clone.textParams) {
      clone.textParams = { ...clone.textParams, image: "" };
    }
    if (clone.textParams) {
      for (const k of PRESET_STRIP_TEXT) delete clone.textParams[k];
    }
    return clone;
  });
  const ids = new Set(nodes.map((n) => n.id));
  const wires = chain.filter((w) => ids.has(w.from) && ids.has(w.to));
  return { schema: PRESET_SCHEMA, name, nodes: structuredClone(nodes), wires: structuredClone(wires) };
}

/** The mask "Selection from Mask" would load: the active develop
 * layer's, else the active Finish layer's. The document selection
 * itself never qualifies (loading it into itself is a no-op). */
export function selectionLoadSource(s: State): NodeCard | undefined {
  const dev = s.activeLayer
    ? s.nodes.find((n) => n.id === maskOfLayer(s.activeLayer!))
    : undefined;
  if (dev?.type.endsWith("_mask")) return dev;
  const art = s.artActive
    ? artMaskNode(s, `art_m_${s.artActive}`)
    : undefined;
  if (art?.type.endsWith("_mask")) return art;
  return undefined;
}

/** The document selection node, made on demand. */
export function ensureDocSelection(s: State): { state: State; id: string } {
  const found = s.nodes.find((n) => n.id === DOC_SEL_ID);
  if (found) return { state: s, id: DOC_SEL_ID };
  const anchor = s.nodes.find((n) => n.id === "output");
  const node: NodeCard = {
    id: DOC_SEL_ID,
    type: "heeler.selection_mask",
    name: "Selection",
    cat: "masking",
    x: (anchor?.x ?? 1200) - NODE_W - 60,
    y: (anchor?.y ?? 96) + 320,
    enabled: true,
    params: { antialias: s.selectAntialias ? 1 : 0 },
    regions: [],
    hasIn: true,
    hasOut: true,
  };
  return {
    // Fed from the frame like every other mask (frameFeed), so it keys
    // and ranges against the same pixels the develop masks do.
    state: {
      ...s,
      nodes: [...s.nodes, node],
      wires: [...s.wires, { from: frameFeed(s.nodes, s.wires) ?? "src", to: DOC_SEL_ID, toPort: "in", kind: "image" } as Wire],
    },
    id: DOC_SEL_ID,
  };
}


/** The selection the app is currently working on: the active develop
 * layer's, else the active Finish layer's, else whichever selection
 * mask is picked in the graph, else the only one there is.
 *
 * One resolver rather than one per caller, because Select All and the
 * marching ants have to agree about which selection they mean; two
 * copies of this that drifted would be a bug nobody could see.
 */
export function activeSelectionMask(s: State): NodeCard | undefined {
  const isSel = (n: NodeCard | undefined) => n?.type === "heeler.selection_mask";
  // A picked mask first, whichever stack it belongs to. Arming the
  // select tool picks the mask it is about to draw on, so this is the
  // one the user is looking at.
  //
  // This used to come last, behind the active develop layer's mask,
  // which meant that selecting on a Finish layer while a develop layer
  // happened to be active sent the Select menu to one mask and the
  // marching ants to another. Nothing looked broken; the commands just
  // quietly worked on a selection that was not on screen.
  const picked = s.nodes.find(
    (n) => n.type === "heeler.selection_mask" && s.selection.includes(n.id),
  );
  if (picked) return picked;
  const layer = s.activeLayer
    ? s.nodes.find((n) => n.id === maskOfLayer(s.activeLayer!))
    : undefined;
  if (isSel(layer)) return layer;
  // No implicit branch for the active Finish layer's mask.
  //
  // There was one, and it is what made deselecting destroy a lifted
  // layer. A Finish layer's mask is the layer's SHAPE, not a selection:
  // treating it as the active selection just because its layer was
  // active pointed the ants at it, pointed the Select menu at it, and
  // so pointed Deselect at it. "I was reporting that when I
  // did deselect the copied pixels disappeared, that is a bug."
  //
  // Since 2026-09-30 a Finish layer's mask is never a selection at all
  // (a selection made into one is pixels, painted with the brush), so
  // the picked branch above can only find the document selection, a
  // Develop Selection layer's mask, or a loose selection node.
  //
  // The last resort is the document selection, or a selection mask that
  // belongs to no layer at all. Never a layer's mask that nothing
  // points at: with Base active and no document selection, "whichever
  // selection there is" was a develop layer's polished Sky, so the ants
  // stayed up after clicking off the layer and Deselect emptied the
  // layer's mask, baked matte and all. "If I do a deselect
  // the adjustments made to the smart layer disappear... the selection
  // is gone and unrecoverable and I have to delete the layer."
  const doc = s.nodes.find((n) => n.id === DOC_SEL_ID);
  if (isSel(doc)) return doc;
  return s.nodes.find((n) => isSel(n) && !isLayerMaskId(n.id));
}

/** Whether a node id names a mask that belongs to a layer: a develop
 * layer's (layer_N_mask) or a Finish layer's (art_m_*). Those are
 * reached through their layer or by an explicit pick, never by being
 * the only mask around. */
export function isLayerMaskId(id: string): boolean {
  return isLayerMask(id) || id.startsWith("art_m_");
}

/** The picks a tool change leaves behind, dropped.
 *
 * select.polish and "Edit layer mask" pick the mask so the whole pass
 * works on one node. Left behind, that pick outranked the active layer
 * in activeSelectionMask for the rest of the session, and everything
 * the user drew or polished afterwards was silently routed to a mask
 * that was no longer on screen. On an Adjustments Selection layer:
 * "Then the selection was no longer recognized... I press the show mask
 * button and everything is black." One function, because the pass can
 * end three ways (Apply, Escape, clicking another layer) and each one
 * has to drop the same pick. `keep` is a mask the caller is about to
 * point the tools at, which stays picked.*/
export function dropToolPicks(
  s: State,
  next: State["tool"],
  keep?: string,
): string[] {
  let sel = s.selection;
  if (s.tool === "polish" && next !== "polish") {
    sel = sel.filter(
      (id) => id === keep || s.nodes.find((n) => n.id === id)?.type !== "heeler.selection_mask",
    );
  }
  // The pick-leak's Finish cousin: "Edit layer mask" picks the ART
  // mask so the tools point at it. Putting every mask tool down ends
  // that flow, and the pick must end with it, or it outranks the
  // active layer in activeSelectionMask for the rest of the session
  // and quietly reroutes Select All, the ants, and Remove Object to a
  // mask that is no longer on screen.
  if (!["select", "brush", "smart", "object", "fill", "polish"].includes(next)) {
    sel = sel.filter((id) => id === keep || !id.startsWith("art_m_"));
  }
  return sel;
}

// Finish masks live in the Finish group ------------------------------------
//
// 2026-10-01: "I noticed the layer mask is NOT in the Finish group. I
// think this is an error. Everything that happens in Finish should be in
// the finish group." A Finish layer's mask (art_m_<carrier>) is a member
// of the Finish group, wired inside it to the blend it gates (or to the
// layer group that holds that blend), so opening the group shows each
// mask on its blend, and a Morphology or Guided Filter (Mask) spliced
// into that wire renders. What a mask reads from outside the group, the
// frame (the image source, or the crop behind one) and a Depth Map's
// plane, arrives on the group's own ports, in2 and depth: one pipe per
// sender into the group, a boundary entry per mask naming that sender,
// and flattenOnce hands the pipe to every mask that reads it. The engine
// sees the graph it saw when the masks hung outside, node for node and
// wire for wire.
//
// The Finish reducers were written against the outside shape, so the
// reducer runs each command on the LIFTED graph (the masks outside, as
// they were) and SINKS the result back (reduceWith). Lift is the old
// shape and sink is the new, one pair of functions, so the two cannot
// drift; a graph saved before 2026-10-01 opens sunk because every load
// goes through the reducer. The selectors the panels call read the
// lifted view (artMaskView) the same way. Graph edits made inside the
// opened Finish group run on the sunk shape, where the masks are
// members, so a splice into a mask's wire lands on the wire the user
// sees.

/** A Finish layer's mask node, by its id. */
export const isArtMaskId = (id: string): boolean => id.startsWith("art_m_");

/** The Finish group's port an outside feed of a mask arrives on, by the
 * mask's own input port. */
const ART_FEED_PORT: Partial<Record<Wire["toPort"], "in2" | "depth">> = { in: "in2", depth: "depth" };
const isArtFeedPort = (p: string | undefined): p is "in2" | "depth" => p === "in2" || p === "depth";

/** The group port a lifted mask's out-wires read on the group's
 * boundary: the pipe from the mask lands on the group's mask port, and
 * the entry keeps the member port it reached inside (a blend's mask, or
 * the in of a Morphology spliced into the wire). */
const LIFTED_PORT = "mask" as const;

/** Where a lifted mask's card stands on the top-level canvas: its spot in
 * the Finish group, this far to the left of everything, so the cards the
 * reducer places at the top level (freeSpot), a backdrop's move and an
 * Arrange never meet it. Sinking takes it off again; a mask whose card
 * is not this far out (a graph saved before 2026-10-01, a mask the
 * reducer just made, a mask kept on a baked layer before then) is laid
 * out below the card it gates instead. */
const LIFT_DX = -1_000_000;
const liftedCard = (n: NodeCard): boolean => n.x < LIFT_DX / 2;

/** The mask a baked layer keeps for Unbake (NodeCard.bakedFrom) moved
 * with the live masks: Bake Warp copies the mask as the lifted graph
 * holds it and Unbake puts that copy back, so inside the reducer it
 * stands where the lifted masks stand and in the saved graph where the
 * sunk ones do. `lift` true moves group-spot masks out, false brings
 * lifted ones back; layer groups inside are walked too. The same array
 * when nothing moves. */
function shiftBakedMasks(nodes: NodeCard[], lift: boolean): NodeCard[] {
  let changed = false;
  const out = nodes.map((n) => {
    let next = n;
    const mask = n.bakedFrom?.mask;
    if (mask && liftedCard(mask) !== lift) {
      next = { ...next, bakedFrom: { ...n.bakedFrom!, mask: { ...mask, x: mask.x + (lift ? LIFT_DX : -LIFT_DX) } } };
    }
    if (n.groupNodes) {
      const inner = shiftBakedMasks(n.groupNodes, lift);
      if (inner !== n.groupNodes) next = { ...next, groupNodes: inner };
    }
    if (next !== n) changed = true;
    return next;
  });
  return changed ? out : nodes;
}

/** The group's pipes in from outside, one per sender and port, from the
 * boundary entries that name them. */
function artFeedWires(bound: Wire[]): Wire[] {
  const out: Wire[] = [];
  const seen = new Set<string>();
  for (const b of bound) {
    if (!isArtFeedPort(b.groupPort)) continue;
    const key = `${b.from}|${b.fromPort ?? ""}|${b.groupPort}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ from: b.from, ...(b.fromPort ? { fromPort: b.fromPort } : {}), to: ART_ID, toPort: b.groupPort, kind: b.kind });
  }
  return out;
}

/** The Finish group with `patch` applied, its in2 and depth pipes made to
 * match its boundary, and its in2 and depth ports shown exactly while a
 * pipe lands on them. The same arrays back when nothing differs. */
function settleArtFeeds(
  nodes: NodeCard[],
  wires: Wire[],
  art: NodeCard,
  patch: Pick<NodeCard, "groupNodes" | "groupWires" | "groupBoundary">,
): { nodes: NodeCard[]; wires: Wire[] } {
  const need = artFeedWires(patch.groupBoundary ?? []);
  const isFeed = (w: Wire) => w.to === ART_ID && isArtFeedPort(w.toPort);
  const have = wires.filter(isFeed);
  const sameFeeds =
    have.length === need.length &&
    need.every((n) => have.some((h) => h.from === n.from && h.fromPort === n.fromPort && h.toPort === n.toPort));
  const in2 = need.some((w) => w.toPort === "in2");
  const depth = need.some((w) => w.toPort === "depth");
  const unpatched =
    patch.groupNodes === art.groupNodes && patch.groupWires === art.groupWires && patch.groupBoundary === art.groupBoundary;
  if (unpatched && sameFeeds && !!art.hasIn2 === in2 && !!art.depthIn === depth) return { nodes, wires };
  const { hasIn2: _in2, depthIn: _depth, ...rest } = art;
  const card: NodeCard = { ...rest, ...patch, ...(in2 ? { hasIn2: true } : {}), ...(depth ? { depthIn: true } : {}) };
  return {
    nodes: nodes.map((n) => (n.id === ART_ID ? card : n)),
    wires: sameFeeds ? wires : [...wires.filter((w) => !isFeed(w)), ...need],
  };
}

const liftMemo = new WeakMap<NodeCard[], { wires: Wire[]; out: { nodes: NodeCard[]; wires: Wire[] } }>();

/** The graph with every Finish mask outside the Finish group, the shape
 * the Finish reducers were written for: the mask at the top level, its
 * frame (and depth) pipes straight into it, and its out-wires inside the
 * group turned into boundary entries behind one pipe into the group's
 * mask port. A mask something inside the group feeds (wired so by hand)
 * has no seat outside and stays. The same arrays back when there is
 * nothing to lift. */
export function liftArtMasks(nodes: NodeCard[], wires: Wire[]): { nodes: NodeCard[]; wires: Wire[] } {
  const art = nodes.find((n) => n.id === ART_ID && n.isGroup);
  const members = art?.groupNodes;
  if (!art || !members) return { nodes, wires };
  const hit = liftMemo.get(nodes);
  if (hit && hit.wires === wires) return hit.out;
  const inner = art.groupWires ?? [];
  const bound = art.groupBoundary ?? [];
  const up = members.filter((n) => isArtMaskId(n.id) && !n.isGroup && !inner.some((w) => w.to === n.id));
  const shifted = shiftBakedMasks(members, true);
  let out = { nodes, wires };
  if (!up.length && shifted !== members) {
    out = { nodes: nodes.map((n) => (n === art ? { ...art, groupNodes: shifted } : n)), wires };
  }
  if (up.length) {
    const ids = new Set(up.map((n) => n.id));
    const feeds: Wire[] = [];
    const outs: Wire[] = [];
    const intoArt: Wire[] = [];
    for (const m of up) {
      for (const b of bound) {
        if (b.to !== m.id) continue;
        feeds.push({ from: b.from, ...(b.fromPort ? { fromPort: b.fromPort } : {}), to: m.id, toPort: b.toPort, kind: b.kind });
      }
      const own = inner.filter((w) => w.from === m.id);
      for (const w of own) {
        outs.push({ from: m.id, ...(w.fromPort ? { fromPort: w.fromPort } : {}), to: w.to, toPort: w.toPort, kind: w.kind, groupPort: LIFTED_PORT });
      }
      if (own.length) intoArt.push({ from: m.id, to: ART_ID, toPort: "mask", kind: "mask" });
    }
    const settled = settleArtFeeds(nodes, wires, art, {
      groupNodes: shifted.filter((n) => !ids.has(n.id)),
      groupWires: inner.filter((w) => !ids.has(w.from)),
      groupBoundary: [...bound.filter((b) => !ids.has(b.to)), ...outs],
    });
    out = { nodes: [...settled.nodes, ...up.map((m) => ({ ...m, x: m.x + LIFT_DX }))], wires: [...settled.wires, ...feeds, ...intoArt] };
  }
  liftMemo.set(nodes, { wires, out });
  return out;
}

/** The graph with every Finish mask inside the Finish group: liftArtMasks
 * undone, and a mask in the outside shape (a graph saved before
 * 2026-10-01, a mask the reducer just made) moved in, its id kept, so
 * every reference to it still resolves. A mask only moves when the
 * outside shape is all it has: pipes from outside into its in or depth
 * port, and its output going into the Finish group alone. Placed below
 * its blend when it comes from the outside shape; a lifted mask keeps
 * the spot it had in the group. Idempotent: the same arrays back when
 * the graph is already sunk and its pipes agree with its boundary. */
export function sinkArtMasks(nodes: NodeCard[], wires: Wire[]): { nodes: NodeCard[]; wires: Wire[] } {
  const art = nodes.find((n) => n.id === ART_ID && n.isGroup);
  if (!art?.groupNodes) return { nodes, wires };
  const bound = art.groupBoundary ?? [];
  const down = nodes.filter((n) => {
    if (n.isGroup || !isArtMaskId(n.id)) return false;
    let feedsArt = false;
    for (const w of wires) {
      if (w.from === n.id) {
        if (w.to !== ART_ID || w.toPort !== "mask") return false;
        feedsArt = true;
      }
      if (w.to === n.id && (w.from === ART_ID || !ART_FEED_PORT[w.toPort])) return false;
    }
    // A mask gating nothing (its wire's spliced node deleted) is still
    // Finish's, and sinks with only its feeds.
    return feedsArt ? bound.some((b) => b.from === n.id) : true;
  });
  // A lifted mask a command rewired so that it no longer sinks (wired by
  // hand to something outside) stays at the top level, its card back
  // on the canvas.
  const stranded = (n: NodeCard) => isArtMaskId(n.id) && liftedCard(n) && !down.includes(n);
  if (nodes.some(stranded)) nodes = nodes.map((n) => (stranded(n) ? { ...n, x: n.x - LIFT_DX } : n));
  if (!down.length) {
    return settleArtFeeds(nodes, wires, art, { groupNodes: shiftBakedMasks(art.groupNodes, false), groupWires: art.groupWires, groupBoundary: art.groupBoundary });
  }
  const ids = new Set(down.map((n) => n.id));
  const members = [...shiftBakedMasks(art.groupNodes, false)];
  const inner = [...(art.groupWires ?? [])];
  const kept: Wire[] = [];
  for (const b of bound) {
    if (!ids.has(b.from)) {
      kept.push(b);
      continue;
    }
    inner.push({ from: b.from, ...(b.fromPort ? { fromPort: b.fromPort } : {}), to: b.to, toPort: b.toPort, kind: b.kind });
  }
  const entries: Wire[] = wires
    .filter((w) => ids.has(w.to))
    .map((w) => ({ from: w.from, ...(w.fromPort ? { fromPort: w.fromPort } : {}), to: w.to, toPort: w.toPort, kind: w.kind, groupPort: ART_FEED_PORT[w.toPort] }));
  for (const m of down) {
    if (liftedCard(m)) {
      members.push({ ...m, x: m.x - LIFT_DX });
      continue;
    }
    // Below the card it gates: the layer's blend, or the layer group
    // that holds it.
    const gate = bound.find((b) => b.from === m.id)?.to;
    const target = members.find((t) => t.id === gate);
    const spot = freeSpot(members, target?.x ?? 24, (target?.y ?? 340) + NODE_H + 40);
    members.push({ ...m, x: spot.x, y: spot.y });
  }
  return settleArtFeeds(
    nodes.filter((n) => !ids.has(n.id)),
    wires.filter((w) => !ids.has(w.from) && !ids.has(w.to)),
    art,
    { groupNodes: members, groupWires: inner, groupBoundary: [...kept, ...entries] },
  );
}

/** The state with its Finish masks lifted out of the group (liftArtMasks),
 * for a selector written against the outside shape. The same object when
 * there is nothing to lift. */
export function artMaskView<T extends { nodes: NodeCard[]; wires: Wire[] }>(s: T): T {
  const v = liftArtMasks(s.nodes, s.wires);
  return v.nodes === s.nodes && v.wires === s.wires ? s : { ...s, nodes: v.nodes, wires: v.wires };
}

/** A node by id at the top level of the lifted view: a Finish layer's
 * mask wherever it sits, or any other top-level node. */
export function artMaskNode(s: { nodes: NodeCard[]; wires: Wire[] }, id: string): NodeCard | undefined {
  return artMaskView(s).nodes.find((n) => n.id === id);
}

/** What feeds a carrier's mask port inside group `g`, walked back through
 * whatever was spliced into the mask's wire (a Morphology, a Guided
 * Filter (Mask)) to the boundary entry that names the mask, or to a
 * Finish mask inside the group. */
function maskSourceIn(g: NodeCard, to: string): string | undefined {
  let at = to;
  let first = true;
  for (let hop = 0; hop < 16; hop++) {
    const b = g.groupBoundary?.find((w) => w.to === at && (first ? w.toPort === "mask" : (w.groupPort ?? w.toPort) === "mask"));
    if (b) return b.from;
    const w = g.groupWires?.find(
      (x) => x.to === at && (first ? x.toPort === "mask" : x.kind === "mask" && (x.toPort === "in" || x.toPort === "mask")),
    );
    if (!w) return undefined;
    if (isArtMaskId(w.from)) return w.from;
    at = w.from;
    first = false;
  }
  return undefined;
}

/** The mask a wire inside group `g` carries, walked back from its sender
 * through the nodes spliced into it to the mask that feeds them (a
 * boundary entry naming it, or a Finish mask inside the group). */
function maskWireSource(g: NodeCard, w: Wire): string | undefined {
  let at = w.from;
  for (let hop = 0; hop < 16; hop++) {
    if (isArtMaskId(at)) return at;
    const b = g.groupBoundary?.find((x) => x.to === at && (x.groupPort ?? x.toPort) === "mask");
    if (b) return b.from;
    const up = g.groupWires?.find((x) => x.to === at && x.kind === "mask" && (x.toPort === "in" || x.toPort === "mask"));
    if (!up) return undefined;
    at = up.from;
  }
  return undefined;
}

/** A Finish layer's mask node, if it has one: in the Finish group since
 * 2026-10-01, wired to its blend (or to the layer group holding it),
 * maybe through a Morphology or another mask node spliced in between.
 * Read on the lifted view, as every reducer reads it. */
export function artMaskOf(s: State, blendId: string): NodeCard | undefined {
  const v = artMaskView(s);
  const g = artGroup(v);
  if (!g) return undefined;
  const find = (id: string | undefined) =>
    id === undefined ? undefined : (v.nodes.find((n) => n.id === id) ?? g.groupNodes?.find((n) => n.id === id));
  const own = maskSourceIn(g, blendId);
  if (own) return find(own);
  // A layer inside a layer group: the mask reaches the group inside the
  // Finish group, and the group's own boundary names the mask for the
  // member it gates.
  for (const l of artLayers(v)) {
    if (!l.content.isGroup) continue;
    const inner = maskSourceIn(l.content, blendId);
    // A node spliced into the mask's wire in the Finish group is what the
    // layer group's boundary names: walk on back to the mask.
    if (inner) return find(isArtMaskId(inner) ? inner : (maskWireSource(g, { from: inner } as Wire) ?? inner));
  }
  return undefined;
}

/** A layer mask turned off (2026-10-01: "do we have an way to disable a
 * mask? I don't see it", then "yes, build disable mask"): the `mask_off`
 * flag on the mask node, a Finish layer's or a Develop layer's. The engine
 * renders such a mask open everywhere, so the layer applies everywhere at
 * its opacity, Depth mask included (the button is the layer's whole mask);
 * the strokes, clicks, regions and Depth settings stay on the node
 * untouched. Painting on it is allowed, as in a layer editor: strokes go
 * into the mask and show once it is on.*/
export const maskIsOff = (n: { params: Record<string, number> } | undefined): boolean => (n?.params.mask_off ?? 0) !== 0;

/** How the toggle is reached from the panel, in the words the Layer
 * menu shows where a key would be. */
export const MASK_OFF_GESTURE = "Shift-click the mask button";

/** The mask Layer > Disable Layer Mask (Enable Layer Mask) acts on: on
 * the FINISH tab the active Finish layer's, on the other tabs the
 * active Develop adjustment layer's. With none, what would give it one,
 * as an instruction. */
export function layerMaskToggleTarget(s: State): { maskId: string; off: boolean } | { maskId: null; why: string } {
  if (s.panelTab === "layers") {
    if (!s.artActive) return { maskId: null, why: "Select a layer in the FINISH panel first." };
    const m = artMaskOf(s, s.artActive);
    return m ? { maskId: m.id, off: maskIsOff(m) } : { maskId: null, why: "This layer has no mask yet. Add one first." };
  }
  const layer = layersOf(s).find((l) => l.id === s.activeLayer);
  const m = layer ? s.nodes.find((n) => n.id === layer.maskId) : undefined;
  return m
    ? { maskId: m.id, off: maskIsOff(m) }
    : { maskId: null, why: "Select an adjustment layer in the Layers list first." };
}

/** The tool that edits a Finish layer's mask, the one its mask button
 * arms: the click tool for a Smart mask, the pick tool for an object
 * mask, Fill's brush on a Fill layer's hole, the brush otherwise.
 * Undefined when the layer has no mask. */
export function artMaskEditTool(s: State, layerId: string): State["tool"] | undefined {
  const mask = artMaskOf(s, layerId);
  if (!mask) return undefined;
  if (mask.type === "heeler.smart_mask") return "smart";
  if (mask.type === "heeler.matte_mask") return "object";
  return artFindLayer(s, layerId)?.content.type === "heeler.inpaint" ? "fill" : "brush";
}

/** The tools that edit the mask the selection names. */
const MASK_EDIT_TOOLS = new Set<State["tool"]>(["brush", "smart", "object", "fill"]);

/** A box in normalized image coordinates. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const WHOLE_FRAME: Box = { x: 0, y: 0, w: 1, h: 1 };

/** The box the visible pixels of a layer sit in.
 *
 * "I see the transform center not being layer center, maybe
 * rather the center of the visible pixels on the layer." He is right,
 * and it is not a nicety: a layer is always the size of the whole
 * photograph, so the layer's own center is the middle of the frame.
 * Rotating a lifted eye about the middle of the frame swings it across
 * the picture instead of turning it in place, which is not what anyone
 * means by rotate.
 *
 * What counts as visible depends on the layer. A lifted layer is opaque
 * everywhere and its selection mask is the shape, so the mask's outlines
 * are the answer. A painted layer has no mask and its strokes are the
 * only pixels there are. Color-keyed selections know their extent only
 * after the engine has run, and the honest answer for those is the whole
 * frame rather than a guess that puts the handles somewhere wrong.
 */
export function contentBox(s: State, blendId: string): Box {
  const mask = artMaskOf(s, blendId);
  const pts: [number, number][] = [];
  for (const r of mask?.regions ?? []) {
    // A shape taken away never widens what shows.
    if (r.off || r.op === "subtract" || r.op === "intersect") continue;
    // Regions that are geometry have a knowable extent. Regions that
    // are a rule about color do not: where a key or a luma range
    // lands is the engine's answer, not one the panel can work out, so
    // the honest fallback is the whole frame rather than handles put
    // somewhere confidently wrong.
    if (r.kind === "path" || r.kind === "samples") {
      pts.push(...r.points);
    } else if (r.kind === "bezier") {
      // Anchors only. The curve can bow outside them, by less than the
      // handle length, and a box that is a shade tight beats one built
      // from control points that are not on the shape at all.
      for (const [x, y] of r.points) pts.push([x, y]);
    } else if (r.kind === "brush") {
      for (const [x, y] of r.points) {
        pts.push([x - r.radius, y - r.radius], [x + r.radius, y + r.radius]);
      }
    } else if (r.kind === "marquee") {
      pts.push([Math.min(r.x0, r.x1), Math.min(r.y0, r.y1)]);
      pts.push([Math.max(r.x0, r.x1), Math.max(r.y0, r.y1)]);
    } else {
      return WHOLE_FRAME;
    }
  }
  // A pixel mask's outline, and what was painted to reveal past it: an
  // erase on a mask that paints to hide, a stroke on one that paints to
  // reveal. Painted to hide only ever shrinks what shows.
  if (pts.length && mask?.type === "heeler.brush_mask") {
    const reveals = (mask.params.invert ?? 0) !== 0;
    for (const st of mask.strokes ?? []) {
      if (!!st.erase !== reveals) continue;
      for (const [x, y] of st.points) pts.push([x - st.radius, y - st.radius], [x + st.radius, y + st.radius]);
    }
  }
  if (!pts.length) {
    // No mask: a paint layer, whose strokes are its visible pixels. The
    // radius counts, or the box clips the edge of every stroke that
    // made it.
    const found = artFindLayer(s, blendId);
    for (const st of found?.content.strokes ?? []) {
      for (const [x, y] of st.points) {
        pts.push([x - st.radius, y - st.radius], [x + st.radius, y + st.radius]);
      }
    }
  }
  if (!pts.length) return WHOLE_FRAME;
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const x = Math.max(0, Math.min(...xs));
  const y = Math.max(0, Math.min(...ys));
  const w = Math.min(1, Math.max(...xs)) - x;
  const h = Math.min(1, Math.max(...ys)) - y;
  // A degenerate box has no interior to transform and no handles worth
  // drawing. One stroke of a tiny brush can produce one.
  if (w < 1e-3 || h < 1e-3) return WHOLE_FRAME;
  return { x, y, w, h };
}

/** Every visible-pixel shape on a layer, as selection regions.
 *
 * "when I deselected and went back to the layer I could
 * not select the copied pixels. It selected the entire layer. I would
 * need some sort of way to select the visible pixels (I think the same
 * would apply to pixel layers I painted on)."
 *
 * A layer is always the size of the whole photograph, so there is no
 * such thing as selecting "the layer" usefully. What a person means is
 * the shape of what they can see on it, and that shape is already in
 * the file: a lifted layer wears its selection as a mask, and a painted
 * one is its strokes. Both are geometry, so this hands back geometry
 * rather than tracing a rendered alpha, and the selection stays as
 * editable as anything else drawn by hand.
 *
 * The layer's transform is applied on the way out. Selecting the pixels
 * of a layer you have just moved has to give you the shape where it is
 * now; the regions themselves are stored in the coordinates the shape
 * was drawn in, which is behind the move.
 */
export function layerPixelRegions(s: State, blendId: string): SelectRegion[] {
  const mask = artMaskOf(s, blendId);
  let regions: SelectRegion[] = (mask?.regions ?? []).filter((r) => !r.off);
  // A pixel mask's outline, then its strokes as the brush regions they
  // are: added where they reveal, taken away where they hide.
  if (regions.length && mask?.type === "heeler.brush_mask") {
    const reveals = (mask.params.invert ?? 0) !== 0;
    for (const st of mask.strokes ?? []) {
      regions.push({ kind: "brush", op: !!st.erase === reveals ? "add" : "subtract", points: st.points, radius: st.radius } as SelectRegion);
    }
  }
  // A pixel mask made from a selection with no drawn outline (a Smart
  // selection) has no geometry to hand back: on a layer that covers the
  // frame (a lift, an adjustment, a fill) the caller loads the mask's
  // render instead (select.layer_pixels). A painted layer's strokes are
  // still its pixels.
  if (
    !regions.length &&
    mask?.type === "heeler.brush_mask" &&
    artFindLayer(s, blendId)?.content.type !== "heeler.paint" &&
    ((mask.textParams?.matte_id ?? "") !== "" || (mask.textParams?.base_selection ?? "") !== "")
  ) {
    return [];
  }
  if (!regions.length) {
    // No mask: a painted layer, whose strokes are the only pixels on
    // it. A stroke is already a shape with a width, so it becomes the
    // selection region of the same name.
    const found = artFindLayer(s, blendId);
    regions = (found?.content.strokes ?? [])
      .filter((st) => !st.erase)
      .map((st) => ({ kind: "brush", op: "add", points: st.points, radius: st.radius }) as SelectRegion);
  }
  if (!regions.length) return [];

  const params = artFindLayer(s, blendId)?.carrier.params ?? {};
  if (params.warp_bw && params.warp_bh) {
    // layerBox, not the raw numbers: a placed picture's box is carried
    // onto the frame's shape with its corners (placedOnFrame).
    const box = layerBox(s, blendId);
    const h = solveHomography(cornersOf(box), layerQuad(s, blendId) as Pt[]);
    if (h) regions = regions.map((r) => mapRegion(r, h));
  }
  // The first region replaces whatever selection was there; the rest
  // add to it (or take away what they took away). Otherwise a layer
  // with three strokes would leave you with only the third.
  return regions.map((r, i) => ({ ...r, op: i === 0 ? "replace" : r.op === "subtract" ? "subtract" : "add" }) as SelectRegion);
}

/** A region through the layer's transform.
 *
 * A moved rectangle is not a rectangle any more, so a marquee comes back
 * as a path: keeping it a marquee would silently square it up again and
 * put the selection somewhere the pixels are not. Color rules pass
 * through untouched, because "everything this red" does not have corners
 * to carry.
 */
function mapRegion(r: SelectRegion, h: number[]): SelectRegion {
  if (r.kind === "marquee") {
    const box = { x: Math.min(r.x0, r.x1), y: Math.min(r.y0, r.y1), w: Math.abs(r.x1 - r.x0), h: Math.abs(r.y1 - r.y0) };
    return { kind: "path", op: r.op, points: cornersOf(box).map((p) => mapPoint(h, p)) };
  }
  if (r.kind === "path" || r.kind === "brush" || r.kind === "samples") {
    return { ...r, points: r.points.map((p) => mapPoint(h, p as Pt)) };
  }
  if (r.kind === "bezier") {
    // Anchors move; the handles are vectors from them, so they move by
    // the difference rather than as points in their own right.
    return {
      ...r,
      points: r.points.map(([x, y, hx, hy]) => {
        const [mx, my] = mapPoint(h, [x, y]);
        const [ox, oy] = mapPoint(h, [x + hx, y + hy]);
        return [mx, my, ox - mx, oy - my] as [number, number, number, number];
      }),
    };
  }
  return r;
}

/** The four corners of a box, in the order the engine reads them:
 * top-left, top-right, bottom-right, bottom-left. */
export function boxCorners(b: Box): [number, number][] {
  return [
    [b.x, b.y],
    [b.x + b.w, b.y],
    [b.x + b.w, b.y + b.h],
    [b.x, b.y + b.h],
  ];
}

/** The source rectangle a layer's corners started from: the box the
 * engine's quad maps away from. Written onto the node by the first
 * transform write; before that the content box is the answer. */
export function layerBox(s: State, blendId: string): Box {
  const onFrame = placedOnFrame(s, blendId);
  if (onFrame) return onFrame.box;
  const p = artFindLayer(s, blendId)?.carrier.params ?? {};
  return p.warp_bw && p.warp_bh
    ? { x: p.warp_bx ?? 0, y: p.warp_by ?? 0, w: p.warp_bw, h: p.warp_bh }
    : isPlacedLayer(s, blendId)
      ? // A placed picture with no box yet fills the frame (the engine's
        // reading), whatever its mask covers.
        { ...WHOLE_FRAME }
      : contentBox(s, blendId);
}

/** Whether a layer's blend places its picture on the transform's
 * corners (the "place" fit of Finish image layers, 2026-09-30) rather
 * than laying a frame-sized picture down and warping that. */
export function isPlacedLayer(s: State, blendId: string): boolean {
  const c = artFindLayer(s, blendId)?.carrier;
  return String(c?.textParams?.fit ?? c?.params.fit ?? "") === "place";
}

/** An asynchronous layer operation (a bake, a copy, a placed picture's
 * probe) may outlive a photograph switch, a take switch or a crop,
 * including the half second before its progress dialog appears. Its
 * result is placed on a box in the frame of the crop it was asked
 * under, so it lands only on that photograph, that take and that crop.
 * Any other edit in between (a slider, a background depth map or a
 * Polish pass poking the render) leaves it welcome: the pixels were
 * asked for as the picture stood, and a baked layer stops following
 * the edits below it by design (the Finish review, stage 2; stage 1
 * keyed it to renderVersion, which every such edit moves). */
export type EditOrigin = { image: string; take: string | undefined; crop: CropGeom };
export function editOrigin(s: State): EditOrigin {
  return { image: s.activeImage, take: s.activeTakes[s.activeImage], crop: cropGeomOf(s.nodes) };
}
function editStillCurrent(s: State, expected?: EditOrigin): boolean {
  return !expected || (expected.image === s.activeImage &&
    expected.take === s.activeTakes[s.activeImage] && sameCrop(expected.crop, cropGeomOf(s.nodes)));
}

/** What New Layer via Copy copies and where the copy goes: the active
 * layer's own picture when it is a Pixel or Image layer (its picture
 * warp's output when it has one, laid on the frame by its carrier),
 * otherwise the picture under the Finish layers (the stack's To
 * Display); the copy lands directly above the active layer, or above
 * the group the active layer sits in, or at the top with none. */
export function layerViaCopySource(s: State): { source: string; carrier: string | null; above: string | null; name: string } {
  const active = s.artActive ? artFindLayer(s, s.artActive) : undefined;
  const above = active ? (active.groupId ? (artLayers(s).find((l) => l.content.id === active.groupId)?.blend.id ?? null) : active.carrier.id) : null;
  const pixels = ["heeler.paint", "heeler.clone", "heeler.file", "heeler.catalog"];
  if (active && pixels.includes(active.content.type)) {
    const warp = imageLayerWarp(s, active.carrier.id);
    return { source: warp?.id ?? active.content.id, carrier: active.carrier.id, above, name: `${active.carrier.name} copy` };
  }
  return { source: "art_in", carrier: null, above, name: "Picture copy" };
}

/** The box the Transform tool measures a layer's corners from: a placed
 * picture's rest box (where the whole picture sits before any move),
 * otherwise the visible pixels, as it always was. */
export function transformBox(s: State, blendId: string): Box {
  return isPlacedLayer(s, blendId) ? layerBox(s, blendId) : contentBox(s, blendId);
}

/** Where a Finish image layer's picture comes from. */
export type ImageLayerSource = { kind: "file"; path: string; layer?: string } | { kind: "catalog"; image: string };

/** The content node's text for a source. */
function imageSourceText(src: ImageLayerSource): Record<string, string> {
  return src.kind === "catalog" ? { image: src.image } : { path: src.path, layer: src.layer ?? "" };
}

/** The blend params for a quad: the rest box and its four corners, and,
 * for a placed picture, the shape of the frame they are fractions of
 * (`warp_aspect`, the frame-shape rule). An unknown frame writes no
 * stamp, and the numbers read as plain fractions until one is known. */
function quadParams(box: Box, corners: [number, number][], aspect?: number | null): Record<string, number> {
  const out: Record<string, number> = { warp_bx: box.x, warp_by: box.y, warp_bw: box.w, warp_bh: box.h };
  corners.forEach(([x, y], i) => {
    out[`warp_x${i}`] = x;
    out[`warp_y${i}`] = y;
  });
  if (aspect && aspect > 0 && Number.isFinite(aspect)) out.warp_aspect = aspect;
  return out;
}

/** A new picture on its rest box, corners on the box: placed, centered
 * and fitted, before anyone moves it. Nothing when the size is unknown,
 * which the engine reads as the whole frame. */
function placedParams(box: Box | null, aspect?: number | null): Record<string, number> {
  return box ? quadParams(box, boxCorners(box), aspect) : {};
}

/** A placed picture's box and corners on the frame the viewer shows now
 * (2026-09-30: "yes, fix the frame shape issue for Finish layers").
 * The numbers on the blend are fractions of the frame they were
 * written on, whose shape `warp_aspect` records; on a frame of another
 * shape (a crop, a quarter turn of the crop, Paste Edits onto a
 * photograph of another shape) they are carried over by imagelayers.ts
 * reframeQuad, the engine's placement_on_frame, so the handles and the
 * typed fields read the layer where the render draws it. Null when
 * there is nothing to carry: not a placed picture, no stamp (read as
 * plain fractions, as the engine does), no box, or the same shape.*/
export function placedOnFrame(s: State, blendId: string): { box: Box; corners: [number, number][] } | null {
  const found = artFindLayer(s, blendId);
  if (!found || !isPlacedLayer(s, blendId)) return null;
  const p = found.carrier.params;
  const from = p.warp_aspect;
  const to = frameAspectFor(s.activeImage);
  if (!p.warp_bw || !p.warp_bh || !from || !to || Math.abs(from / to - 1) < 1e-6) return null;
  const box: Box = { x: p.warp_bx ?? 0, y: p.warp_by ?? 0, w: p.warp_bw, h: p.warp_bh };
  const rest = boxCorners(box);
  let corners = rest.map(([bx, by], i) => [p[`warp_x${i}`] ?? bx, p[`warp_y${i}`] ?? by] as [number, number]);
  // The registry's zeros under a written box: the picture on its box,
  // the engine's reading.
  if (corners.every(([x, y]) => x === 0 && y === 0)) corners = rest;
  const out = reframeQuad(box, corners as Pt[], from, to);
  return { box: out.box, corners: out.corners as [number, number][] };
}

/** The quad a layer is currently transformed to, falling back to its
 * content box when nothing has moved it yet. */
export function layerQuad(s: State, blendId: string): [number, number][] {
  const onFrame = placedOnFrame(s, blendId);
  if (onFrame) return onFrame.corners;
  // Not `s.nodes`. A Finish layer's blend node lives inside the group,
  // and looking for it at the top level finds nothing, silently: the
  // handles would draw on the fallback box and never move off it.
  const p = artFindLayer(s, blendId)?.carrier.params ?? {};
  const base = boxCorners(layerBox(s, blendId));
  return base.map(([bx, by], i) => [p[`warp_x${i}`] ?? bx, p[`warp_y${i}`] ?? by]);
}

/** A carrier's Transform and placement, the part of a blend that says
 * where its layer is (the corners, the rest box, the frame-shape stamp,
 * the picture's room, the place fit and its scene anchor), for a carrier
 * rebuilt by grouping or ungrouping. */
function placementParams(n: NodeCard): { params: Record<string, number>; text: Record<string, string> } {
  const params: Record<string, number> = {};
  for (const [k, v] of Object.entries(n.params)) if (k.startsWith("warp_") || k === "place_pad") params[k] = v;
  const text: Record<string, string> = {};
  for (const k of ["fit", "anchor"]) {
    const v = n.textParams?.[k];
    if (typeof v === "string" && v) text[k] = v;
  }
  return { params, text };
}

/** Which way a flip mirrors: left for right ("h") or top for bottom ("v"). */
export type FlipAxis = "h" | "v";

/** What a flip does to one Finish layer, kind by kind (2026-10-01:
 * "The flip buttons should be on the canvas header for all layers."):
 * - a placed picture (an image layer, a copy, a baked warp) mirrors
 * where it stands, as the panel's Flip Across and Flip Down did;
 * inside a group, about the frame's center with the rest of the group;
 * - a Pixel layer (paint, dodge and burn, clone and heal) mirrors its
 * strokes about the frame's center (strokes are frame fractions, so a
 * stroke at x lands at 1 - x; a clone's source offset mirrors with it,
 * so a repair now copies from the mirrored place);
 * - a linear Gradient turns its angle over; a radial one is symmetric;
 * - a Warp layer mirrors its grid and its shapes (a twist runs the
 * other way);
 * - a Transform on any of these is carried through the same mirror, so
 * the moved layer lands mirrored too;
 * - the layer's mask flips with it when it is painted or drawn (brush
 * strokes, a frozen selection); a mask that reads the picture (Smart,
 * Object) stays on what it reads;
 * - adjustment, Isolate and solid Fill layers have no shape of their
 * own, so only their painted or drawn mask flips;
 * - a Fill brush layer's patch was made for where it sits, so it does
 * not flip;
 * - a group flips as a unit: each member about the frame's center, and
 * the group's own mask and Transform.
 * The new nodes by id (art-group nodes and main-graph masks), or null
 * when nothing would change.*/
function flipLayerNodes(s: State, id: string, axis: FlipAxis): Map<string, NodeCard> | null {
  const found = artFindLayer(s, id);
  if (!found) return null;
  const r = mirrorRemap(axis, frameAspectFor(s.activeImage) ?? 1);
  const out = new Map<string, NodeCard>();
  const put = (before: NodeCard, after: NodeCard) => {
    if (after !== before) out.set(before.id, after);
  };
  const flipMask = (carrierId: string) => {
    const mask = artMaskOf(s, carrierId);
    if (mask) put(mask, remapNode(mask, r));
  };
  const flipOne = (carrier: NodeCard, content: NodeCard, aboutFrame: boolean) => {
    if (content.type === "heeler.inpaint") return;
    if (isPlacedLayer(s, carrier.id)) {
      const box = layerBox(s, carrier.id);
      const quad = layerQuad(s, carrier.id) as Pt[];
      const corners = aboutFrame ? quad.map((p) => applyMirror(r, p)) : flipQuad(quad, axis);
      put(carrier, { ...carrier, params: { ...carrier.params, ...quadParams(box, corners as [number, number][], frameAspectFor(s.activeImage)) } });
      // The mask goes through the picture's corners in the engine, so it
      // turns over with them.
      // A baked Warp layer's kept definition (Unbake) turns over with
      // its picture: about the frame's center with a group, else about
      // the middle of the rectangle the bake covered, where the picture
      // mirrors in place; so Unbake after a flip puts the warp where the
      // mirrored picture is.
      if (content.bakedFrom) {
        const about: FrameRemap = aboutFrame
          ? r
          : {
              ...r,
              m:
                axis === "h"
                  ? [-1, 0, 2 * (box.x + box.w / 2), 0, 1, 0]
                  : [1, 0, 0, 0, -1, 2 * (box.y + box.h / 2)],
            };
        put(content, remapNode(content, about));
      }
      return;
    }
    if (content.isGroup) {
      for (const m of artGroupMembers(content)) flipOne(m.merge, m.content, true);
      flipQuadOf(carrier);
      flipMask(carrier.id);
      return;
    }
    const own = content.type === "heeler.paint" || content.type === "heeler.clone" || (content.type === LAYER_WARP && !isPictureWarp(content));
    if (own) {
      put(content, remapNode(content, r));
      flipQuadOf(carrier);
    } else if (content.type === "heeler.gradient") {
      put(content, flipGradient(content, axis));
      flipQuadOf(carrier);
    } else if (content.type === "heeler.fill") {
      // A solid color is the same mirrored; a moved one is a shape,
      // carried by its Transform.
      flipQuadOf(carrier);
    }
    flipMask(carrier.id);
  };
  // A Transform on a frame layer: its corners carried through the mirror
  // (framemap's remapQuad on the carrier).
  const flipQuadOf = (carrier: NodeCard) => {
    if (!isPlacedLayer(s, carrier.id) && (carrier.params.warp_bw ?? 0) > 0) put(carrier, remapNode(carrier, r));
  };
  flipOne(found.carrier, found.content, false);
  return out.size ? out : null;
}

function applyMirror(r: FrameRemap, [x, y]: readonly number[]): [number, number] {
  return [r.m[0] * x + r.m[1] * y + r.m[2], r.m[3] * x + r.m[4] * y + r.m[5]];
}

/** A Gradient layer's geometry turned over: a linear one's angle (the
 * engine reads the gradient along cos, sin of it about the frame's
 * center), the same node when it is radial or by tone. */
function flipGradient(n: NodeCard, axis: FlipAxis): NodeCard {
  const shape = String(n.textParams?.shape ?? "linear");
  if (shape !== "linear") return n;
  const a = n.params.angle ?? 0;
  let next = axis === "h" ? 180 - a : -a;
  next = ((next + 180) % 360 + 360) % 360 - 180;
  if (next === -180) next = 180;
  if (Math.abs(next - a) < 1e-9 || Math.abs(Math.abs(next - a) - 360) < 1e-9) return n;
  return { ...n, params: { ...n.params, angle: next } };
}

/** Whether Flip Horizontal and Flip Vertical can act on a layer, or the
 * outcome-first reason they cannot (the buttons gray with it). */
export function layerFlipBlocked(s: State, id: string | null | undefined, axis: FlipAxis): string | null {
  if (!id) return "pick a Finish layer to mirror it";
  const found = artFindLayer(s, id);
  if (!found) return "pick a Finish layer to mirror it";
  if (found.content.type === "heeler.inpaint") {
    return "a Fill brush layer's patch is made for the place it fills; paint the Fill brush where you want a new one";
  }
  if (flipLayerNodes(s, id, axis)) return null;
  const c = found.content;
  if (c.type === "heeler.paint" || c.type === "heeler.clone") return "paint on this layer first; an empty layer has nothing to mirror";
  if (c.type === "heeler.gradient" && !found.content.isGroup) return "this gradient looks the same mirrored this way";
  return "this layer has no shape of its own to mirror (it changes the picture under it, and a mask that reads the picture stays on it); paint or draw it a mask and the mask flips";
}

/** The pivot every rotate and scale turns about: the middle of where the
 * content actually is now, not the middle of the frame.
 *
 * For a warped quad that is the crossing of its diagonals, not the mean
 * of its corners: a homography carries the source rectangle's center
 * (the crossing of ITS diagonals) to the crossing of the image's
 * diagonals, while the mean only agrees for a parallelogram. A pivot
 * taken from the mean drifts off the content after a warp, and every
 * rotate then orbits the wrong point. Falls back to the mean when the
 * diagonals do not cross, which is a quad nobody should be rotating
 * anyway. */
export function quadCenter(q: [number, number][]): [number, number] {
  const mean: [number, number] = [
    q.reduce((a, c) => a + c[0], 0) / q.length,
    q.reduce((a, c) => a + c[1], 0) / q.length,
  ];
  if (q.length !== 4) return mean;
  // Corner order is TL, TR, BR, BL, so the diagonals are 0-2 and 1-3.
  const [a, b, c, d] = q;
  const d1x = c[0] - a[0];
  const d1y = c[1] - a[1];
  const d2x = d[0] - b[0];
  const d2y = d[1] - b[1];
  const denom = d1x * d2y - d1y * d2x;
  if (Math.abs(denom) < 1e-12) return mean;
  const t = ((b[0] - a[0]) * d2y - (b[1] - a[1]) * d2x) / denom;
  return [a[0] + t * d1x, a[1] + t * d1y];
}

/** Rebuilds the group's wiring from an ordered layer list. One producer
 * for the wire shape, so add, remove and reorder cannot disagree about
 * what a stack looks like. */
function artWires(
  layers: { blend: string; content: string; fx: string[]; clip?: boolean }[],
): Wire[] {
  const ws: Wire[] = [];
  let prev = "art_in";
  // The base a clipped layer shows through: the nearest layer below it
  // that is not itself clipped, exactly the layer-editor rule. Clipping runs
  // in chains, so two clipped layers over one base both read the base.
  let baseTail: string | null = null;
  for (const l of layers) {
    // Content reads what is BELOW it, not the bare photograph: a paint
    // layer only wants the dimensions, but a clone samples these pixels
    // for real, and "below" is what a retoucher means by the source.
    ws.push({ from: prev, to: l.content, toPort: "in", kind: "image" });
    ws.push({ from: prev, to: l.blend, toPort: "in", kind: "image" });
    // Effects run between the content and the blend, in order.
    let tail = l.content;
    for (const f of l.fx) {
      ws.push({ from: tail, to: f, toPort: "in", kind: "image" });
      tail = f;
    }
    ws.push({ from: tail, to: l.blend, toPort: "in2", kind: "image" });
    // A clipping mask is a wire, like everything else here: the base
    // layer's finished content into this blend's mask port, read by
    // alpha. The graph shows the dependency instead of hiding it in a
    // flag nobody can see.
    if (l.clip && baseTail) {
      // The blend's own clip port, not its mask port: the mask port is
      // Mask-kind and the graph's connect() rejects an image into it,
      // which it did silently the first time around.
      ws.push({ from: baseTail, to: l.blend, toPort: "clip", kind: "mask" });
    }
    if (!l.clip) baseTail = tail;
    prev = l.blend;
  }
  ws.push({ from: prev, to: "art_out", toPort: "in", kind: "image" });
  return ws;
}

/** What each layer kind is made of. The stack shape never changes; only
 * the content node behind the blend does, which is what keeps opacity,
 * modes, masks, groups and reordering identical for all of them. */
export const ART_KINDS: Record<
  string,
  {
    type: string;
    label: string;
    params: Record<string, number>;
    text: Record<string, string>;
    /** the params the Finish inspector shows, in order. Absent means
     * every numeric param the node carries. Present where a node does
     * more than the layer is named for: White Balance and Color are the
     * same engine node wearing two hats. */
    show?: string[];
    /** an adjustment layer changes the picture below it rather than
     * laying something over it, which is worth saying in the panel */
    adjust?: boolean;
    /** the blend mode the layer starts on, when it is not Normal */
    mode?: string;
    /** a picture placed by the layer's transform: the blend's "place"
     * fit puts the picture's whole extent on its four corners */
    place?: boolean;
  }
> = {
  // ONE pixel layer, every tool. "I don't like the two layer
  // types. Dividing pixel from retouch... We should have one layer that
  // works with all the tools." A repair is a stroke with a source
  // offset, so paint, clone and heal all write to the same node's stroke
  // list.
  paint: { type: "heeler.paint", label: "Pixel", params: {}, text: {} },
  // The Fill brush's own layer ("do Fill brushes make
  // their own layer?"): content is the model's fill of the picture
  // below, shown through the layer's stroke mask. hole:"layer"
  // tells the engine the LAYER gates visibility, so the content
  // serves its raster unmasked and the layer machinery owns the
  // lifecycle - hide, reorder, delete, opacity all behave like any
  // layer.
  fix: { type: "heeler.inpaint", label: "Fill", params: {}, text: { fill_id: "", model: "", hole: "layer" } },
  // Selection to layer. The picture below becomes this layer's pixels,
  // and the layer mask decides how much of it, so the selection is
  // carried as geometry that can be edited afterwards rather than baked
  // into an outline at the moment the layer was made. "Isolate", after
  // two other names died. "Lifted" said nothing ("maybe if
  // the name made more sense how I might use it that would help. And at
  // the UI level that starts with the name of a tool"), and "Cutout" lied
  // twice: it implied a hole (Remove's territory) and a piece you could
  // move (there is no transform). What the layer actually does, whether
  // the mask came from a model or a drawn rectangle, is isolate a region
  // of the photograph to treat it separately: brighten just her, blur
  // just the background. The noun holds up too - an isolate is the thing
  // separated out for closer work.
  lift: { type: "heeler.lift", label: "Isolate", params: {}, text: {} },
  // The same layer, set up for dodging and burning. No 50% gray fill: A
  // layer editor needs one because its layer has to be opaque for Soft
  // Light to reach the picture, and here an unpainted canvas is
  // transparent, which the blend already reads as "leave it alone". The
  // alpha IS the neutral, so the file carries the strokes and nothing
  // else. "that has got to take up more data and space".
  dodgeburn: {
    type: "heeler.paint",
    label: "Dodge & Burn",
    params: {},
    text: {},
    mode: "soft_light",
  },
  fill: { type: "heeler.fill", label: "Fill", params: {}, text: { color: "#808080" } },
  gradient: {
    type: "heeler.gradient",
    label: "Gradient",
    params: { alpha_a: 100, alpha_b: 0, angle: 0, midpoint: 50 },
    text: { color_a: "#000000", color_b: "#ffffff", shape: "linear", stops: "" },
  },
  // A picture referenced from a file on disk (26.3 Phase 7 import):
  // the File node holds the path and which TIFF page or EXR layer to
  // read, the blend's fit/fill/stretch/none places it, and the pixels
  // are never copied into the catalog, so a moved file shows the layer
  // as missing, the way a missing photograph does. Made by "Layers
  // from File..." with a real path, not by the toolbar: there is no
  // image layer without a file.
  //
  // Placed since 2026-09-30 ("They will need to have
  // transform controls ... so a user can interactively position on the
  // canvas"): the blend's "place" fit puts the whole picture on the
  // transform's corners, and the File node hands it over
  // display-encoded, the space the Finish stack composites in.
  image: {
    type: "heeler.file",
    label: "Image",
    params: {},
    text: { path: "", layer: "", space: "display" },
    place: true,
  },
  // The same layer over a photograph of this catalog, rendered through
  // its own edits as the Catalog node does (2026-09-30: "We already had
  // file and catalog for nodes. Expose these as layers").
  catalog_image: {
    type: "heeler.catalog",
    label: "Image",
    params: {},
    text: { image: "", mode: "developed", space: "display" },
    place: true,
  },
  // A Warp layer (2026-09-30: "build both, A for image layers and B for
  // the photo"): Grid Warp and Shape Warp over everything below it in
  // the stack, shown through the layer's own mask. The same node as an
  // image layer's own warp, in the frame's space (newLayerWarpNode has
  // the rest of its params).
  warp: {
    type: LAYER_WARP,
    label: "Warp",
    params: { cols: 4, rows: 3, room: 25 },
    text: { space: "frame", cols_u: "", rows_v: "", mesh: "[]", lattice: "", shapes: "[]", edges: "clamp" },
  },

  // Adjustment layers: the same engine ops the Develop panel drives,
  // restacked. Each reads the composite below it, so the stack order is
  // the edit order, and each takes the layer's own mask and opacity.
  exposure: {
    type: "heeler.exposure",
    label: "Exposure",
    params: { ...NEUTRAL_PARAMS["heeler.exposure"] },
    text: {},
    adjust: true,
  },
  curves: { type: "heeler.curves", label: "Curves", params: {}, text: {}, adjust: true },
  levels: {
    type: "heeler.levels",
    label: "Levels",
    params: { black: 0, white: 1, gamma: 1, black_soft: 0, white_soft: 0 },
    text: {},
    adjust: true,
  },
  white_balance: {
    type: "heeler.standard_color",
    label: "White Balance",
    params: { ...NEUTRAL_PARAMS["heeler.standard_color"] },
    text: {},
    show: ["temperature", "tint"],
    adjust: true,
  },
  color: {
    type: "heeler.standard_color",
    label: "Color",
    params: { ...NEUTRAL_PARAMS["heeler.standard_color"] },
    text: {},
    show: ["saturation", "vibrance"],
    adjust: true,
  },
  color_balance: {
    type: "heeler.color_balance",
    label: "Color Balance",
    params: { ...NEUTRAL_PARAMS["heeler.color_balance"] },
    text: {},
    show: ["shadows_lum", "midtones_lum", "highlights_lum", "shadows_sat", "midtones_sat", "highlights_sat"],
    adjust: true,
  },
  black_white: {
    type: "heeler.black_white",
    label: "Black & White",
    // Full strength at birth, like Invert: the layer is named for what
    // it does, and one that did nothing when added would read as
    // broken. (The 2026-10-03 Finish review set it to 0 for the sake
    // of "every adjustment starts neutral"; put back the same day.)
    params: { red: 30, green: 59, blue: 11, amount: 100 },
    text: {},
    adjust: true,
  },
  invert: { type: "heeler.invert", label: "Invert", params: {}, text: {}, adjust: true },
  // No Gradient Map here since 2026-09-30 ("having a Gradient
  // Map adjustment layer is redundant with the Gradient layer (and not as
  // feature rich as the Gradient layer)", then "do the merge with a By
  // tone shape"): a Gradient layer set to By tone is the same look with
  // every stop, falloff and alpha the Gradient layer has. Layers saved as
  // Gradient Map open as that (gradientMapLayersByTone).
};

export type ArtKind = keyof typeof ART_KINDS;

/** The Transform slot on the Finish toolbar (2026-10-01: "We already
 * have transform and warp on the toolbar ... if skew and distort are
 * different than warp, then move those two to the toolbar. If they are
 * redundant to warp then remove them."). Transform sizes, Skew slides
 * edges along themselves, Perspective pinches a corner and its partner
 * symmetrically: three ways of holding the Transform tool's handles.
 * Warp pulls each corner on its own, which is what the layer panel's
 * Distort button did, so Distort is Warp and has no seat of its own.*/
export type ShapeMode = "transform" | "skew" | "perspective" | "warp";
export const SHAPE_MODES: readonly ShapeMode[] = ["transform", "skew", "perspective", "warp"];
export const isShapeMode = (v: unknown): v is ShapeMode => typeof v === "string" && (SHAPE_MODES as readonly string[]).includes(v);

/** The viewer tool a Transform slot mode arms. */
export function shapeToolOf(mode: ShapeMode): "transform" | "warp" {
  return mode === "warp" ? "warp" : "transform";
}

/** What the Transform tool's corners and edges do with no key held, by
 * the slot's mode: size, or the skew or perspective reshape. */
export function transformDragOf(mode: ShapeMode): "scale" | "skew" | "perspective" {
  return mode === "skew" ? "skew" : mode === "perspective" ? "perspective" : "scale";
}

/** Layer effects, each a function of the layer's alpha. A layer editor's
 * are a fixed list behind a modal dialog; these are nodes on a chain,
 * so a layer can carry two glows or run an outline before a shadow. */
export const ART_FX: Record<
  string,
  { type: string; label: string; params: Record<string, number>; text: Record<string, string> }
> = {
  shadow: {
    type: "heeler.fx_shadow",
    label: "Shadow",
    params: { size: 12, distance: 8, angle: 135, opacity: 75 },
    text: { color: "#000000" },
  },
  glow: {
    type: "heeler.fx_glow",
    label: "Glow",
    params: { size: 12, opacity: 75 },
    text: { color: "#ffe9b0" },
  },
  color_overlay: {
    type: "heeler.fx_color_overlay",
    label: "Color Overlay",
    params: { opacity: 100 },
    text: { color: "#808080" },
  },
  gradient_overlay: {
    type: "heeler.fx_gradient_overlay",
    label: "Gradient Overlay",
    params: { opacity: 100, angle: 0, midpoint: 50 },
    text: { color_a: "#000000", color_b: "#ffffff", shape: "linear" },
  },
  bevel: {
    type: "heeler.fx_bevel",
    label: "Bevel / Emboss",
    params: { size: 6, depth: 100, angle: 135, opacity: 75 },
    text: { highlight: "#ffffff", shadow: "#000000" },
  },
  blur: {
    // The blur node already switches between Gaussian, Box and Motion,
    // so the effect is that node rather than a fourth copy of it. The
    // key is `kind`, the name the registry declares and choice() reads;
    // it shipped as `blur_type` for a while, which nothing read.
    type: "heeler.blur",
    label: "Blur",
    params: { radius: 6, angle: 0 },
    text: { kind: "gaussian" },
  },
};

/** Which effects offer an inner/outer switch. */
export const ART_FX_INNER = ["shadow", "glow"];

/** The adjustment kinds, for the panel's "add adjustment" menu. */
export const ART_ADJUSTMENTS: ArtKind[] = Object.entries(ART_KINDS)
  .filter(([, k]) => k.adjust)
  .map(([id]) => id);

/** Whether art_group_layers would accept these ids.
 *
 * ONE rule, because there were three and they disagreed. The reducer
 * wanted a contiguous run of top-level layers with no group among them.
 * The Layer menu additionally demanded two of them, so a single layer
 * could not be grouped at all ("technically I should be
 * able to group just one layer" -- and the reducer always would have).
 * The panel's toolbar asked for neither contiguity, so its button could
 * be live for a selection the reducer then silently refused, and it
 * barred MASKED layers, which stopped being true when grouping learned
 * to carry a mask's boundary wiring across.
 *
 * A predicate a control asks is worth more than a predicate a control
 * copies: this one is the reducer's, so a disabled seat and a refused
 * command can no longer mean different things.
 *
 * One layer is a legitimate group. Layer editors have always made one from a
 * single layer, and the arithmetic here never cared: one index is a
 * contiguous run of one.
 */
export function canGroupLayers(s: State, ids: string[]): boolean {
  const ls = artLayers(s);
  const idx = ids
    .map((id) => ls.findIndex((l) => l.blend.id === id))
    .sort((a, b) => a - b);
  if (!idx.length) return false;
  // A missing id sorts to the front as -1 and fails the first test.
  if (!idx.every((v, i) => (i === 0 ? v >= 0 : v === idx[i - 1] + 1))) return false;
  // One level deep: a group cannot hold another group.
  return !idx.some((i) => ls[i].content.isGroup);
}

/** The art group with `mutate` applied to its layer list, wiring
 * rebuilt. Creating the group on first use is the caller's business. */
function withArtLayers(s: State, mutate: (layers: ArtLayer[]) => ArtLayer[]): State {
  const g = artGroup(s);
  if (!g) return s;
  const prev = artLayers(s);
  const next = mutate(prev);
  // Nodes inside the Finish group that no layer's chain owns (26.3
  // Phase 8): the Export Layer nodes the Finish tab's Export checkbox
  // adds. A rebuild from the layer list alone would drop them, so they
  // ride along as extras - an export node only while the layer it taps
  // survives, which is what makes removing a layer remove its node.
  const owned = new Set(["art_in", "art_out"]);
  for (const l of prev) {
    owned.add(l.blend.id);
    owned.add(l.content.id);
    for (const f of l.fx ?? []) owned.add(f.id);
  }
  const nextBlends = new Set(next.map((l) => l.blend.id));
  const extras = (g.groupNodes ?? []).filter((n) => {
    if (owned.has(n.id)) return false;
    if (n.type === "heeler.export_layer") {
      const src = n.textParams?.source ?? "";
      if (src.startsWith("finishmask:")) return nextBlends.has(src.slice("finishmask:".length));
      return src.startsWith("finish:") && nextBlends.has(src.slice("finish:".length));
    }
    return true;
  });
  const extraIds = new Set(extras.map((n) => n.id));
  const chain = [
    g.groupNodes!.find((n) => n.id === "art_in")!,
    ...next.flatMap((l) => [l.content, ...(l.fx ?? []), l.blend]),
    // Extras after art_out: flattenOnce picks the group's exit as the
    // first member that feeds nothing inside, and an export node feeds
    // nothing, so art_out must answer first.
    g.groupNodes!.find((n) => n.id === "art_out")!,
    ...extras,
  ];
  const chainIds = new Set(chain.map((n) => n.id));
  return {
    ...s,
    nodes: s.nodes.map((n) =>
      n.id === ART_ID
        ? {
            ...n,
            groupNodes: chain,
            groupWires: [
              ...artWires(
                next.map((l) => ({
                  blend: l.blend.id,
                  content: l.content.id,
                  fx: (l.fx ?? []).map((f) => f.id),
                  clip: (l.blend.params.clip ?? 0) !== 0,
                })),
              ),
              // The extras' own wiring survives the rebuild exactly as
              // it was, but only where both ends still exist.
              ...(g.groupWires ?? []).filter(
                (w) =>
                  (extraIds.has(w.from) || extraIds.has(w.to)) &&
                  chainIds.has(w.from) &&
                  chainIds.has(w.to),
              ),
            ],
          }
        : n,
    ),
  };
}

/** Grouping retires a layer's blend, and an Export Layer node whose
 * `source` named it goes with it (withArtLayers keeps an extra only
 * while its layer survives). Keep the drop, but say so (26.3 Phase 8):
 * a status flash and a console line naming the layer, and what to do
 * instead - ticking the group exports its composite. */
function exportTickDropNotice(unticked: ArtLayer[]): { text: string; at: number } | null {
  if (!unticked.length) return null;
  const names = unticked.map((l) => `'${l.blend.name}'`).join(" and ");
  const text =
    unticked.length === 1
      ? `Grouped ${names}: its Export tick was removed; tick the group's Export to export its composite.`
      : `Grouped ${names}: their Export ticks were removed; tick the group's Export to export its composite.`;
  logMsg("info", text);
  return { text, at: Date.now() };
}

/** Ribbon filter: which images survive the current star/flag filters. */
/** File-name order, built once.
 *
 * A fresh localeCompare per pair is roughly ten times the cost of a
 * shared Collator, and this runs over the whole visible folder on every
 * render of the strip; on a wedding's worth of frames that difference
 * is the sort being unnoticeable rather than being felt.
 *
 * `numeric` is not just speed: it puts IMG_2 before IMG_10, which is
 * what the photographer means by "in order" and what a plain string
 * comparison gets wrong on any camera that does not zero-pad. */
const NAME_ORDER = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Whether a photograph passes the shot-date filter. No filter passes
 * everything; a filter hides a photograph whose date is not known yet
 * (the runner is reading it) or whose file has none, and the seat
 * counts those (undatedCount) so a scan never vanishes without a word. */
export function shotDateMatches(s: State, id: string): boolean {
  if (s.filterDateFrom === "" && s.filterDateTo === "") return true;
  const day = s.shotDates[id];
  if (!day) return false;
  return dayInRange(day, s.filterDateFrom, s.filterDateTo);
}

/** How many of the folder's photographs a set date filter hides for
 * want of a date: the file carries none. Photographs still being read
 * are not counted; they are on their way. */
export function undatedCount(s: State): number {
  if (s.filterDateFrom === "" && s.filterDateTo === "") return 0;
  return s.images.filter((img) => id_in(s.shotDates, img.id) && s.shotDates[img.id] === null).length;
}

function id_in(dates: Record<string, string | null>, id: string): boolean {
  return Object.prototype.hasOwnProperty.call(dates, id);
}

export function visibleImages(s: State): ImageEntry[] {
  const tagged = s.tagFilter ? new Set(s.tagFilter.ids) : null;
  const shown = s.images.filter((img) => {
    if (tagged && !tagged.has(img.id)) return false;
    if (!nameMatches(s.filterName, img.name)) return false;
    if (!shotDateMatches(s, img.id)) return false;
    if (s.filterStars > 0 && img.stars < s.filterStars) return false;
    // The flag button's two contexts, each invertible by its modifier:
    // picks only or picks hidden, rejects hidden or rejects only.
    if (s.filterPicksOnly && (img.flag === "pick") === s.filterFlagInverted) return false;
    if (s.filterHideRejected && (img.flag === "reject") !== s.filterFlagInverted) return false;
    if (s.filterStacksOnly && !isComposite(img)) return false;
    if (s.filterEdited === "edited" && !img.edited) return false;
    if (s.filterEdited === "unedited" && img.edited) return false;
    const versions = takeCount(s, img.id);
    if (versions < s.filterTakesMin) return false;
    if (s.filterTakesMax < TAKE_CAP && versions > s.filterTakesMax)
      return false;
    return true;
  });
  // By file name, which is the order the catalog already hands them
  // over in and, on any camera, the order they were taken. So ascending
  // changes nothing for anyone who never touches the arrows, and
  // descending is the same list read from the other end.
  //
  // Here rather than in the strip that draws them, because the order on
  // screen has to be the order the arrow keys walk: a filmstrip running
  // one way and a Next Photo running the other is worse than no sort at
  // all. The list view sorts itself on whichever column its header is
  // set to, from metadata this function has never seen.
  const dir = s.ribbonSort.desc ? -1 : 1;
  return shown.sort((a, b) => dir * NAME_ORDER.compare(a.name, b.name));
}

/** Ranges where a node type disagrees with the global param name: the
 * linear mask's angle is a full rotation, not crop's ±45 straighten.
 * Mirrors the registry's per-node clamps. */
const PARAM_RANGE_BY_TYPE: Record<string, Record<string, [number, number]>> = {
  // Transform's size is a percentage that can go past the frame; the
  // shared `size` is grain's, in a smaller unit.
  "heeler.transform": { size: [1, 400] },
  "heeler.linear_mask": { angle: [-180, 180] },
  // A radial mask spins a full turn; the crop tool's angle is a
  // straightening nudge, which is why the same name has two ranges.
  "heeler.radial_mask": { rotation: [-180, 180] },
  // Profile contrast scales the chosen curve; exposure's contrast is
  // a bipolar adjustment, hence the different range for the same name.
  "heeler.tone_profile": { contrast: [0, 200], development: [-2, 2] },
  // The sigmoid's slope around gray, not a bipolar adjustment.
  "heeler.view_transform": { contrast: [25, 300] },
  "heeler.black_white": { amount: [0, 100] },
  // A blur radius is in pixels, the way the layer editors label it.
  // Every other `radius` in this app is a fraction of the frame, which is
  // exactly the collision PARAM_RANGE_BY_TYPE exists for: a 12 pixel blur
  // was being clamped to 1 because a brush radius of 12 would be absurd.
  "heeler.blur": { radius: [0, 200], angle: [-180, 180] },
  // Unsharp masking goes to 300%, well past anything the other amounts do.
  "heeler.sharpen": { amount: [0, 300], radius: [0.1, 5], threshold: [0, 255] },
  "heeler.grain": { intensity: [0, 100], size: [1, 100] },
  "heeler.high_pass": { radius: [0, 200] },
  // Photograph pixels, like the blur's; the shared radius is a share
  // of the frame.
  "heeler.morphology": { radius: [0, 50] },
  "heeler.guided_filter": { radius: [0, 100], epsilon: [0, 0.1] },
  "heeler.guided_filter_mask": { radius: [0, 100], epsilon: [0, 0.1] },
  // Scale is a gaussian's sigma in photograph pixels (the shared scale
  // is Math's bipolar multiplier); the threshold a share of a full step
  // (the shared threshold is Sharpen's, in levels).
  "heeler.edge_field": { scale: [0, 10], threshold: [0, 1], softness: [0, 1] },
  // The second batch (ops_advanced.rs): radii in photograph pixels.
  "heeler.median": { radius: [0, 50] },
  "heeler.median_mask": { radius: [0, 50] },
  // OkLab chroma, like the tolerance (the shared softness is 0..1).
  "heeler.chroma_key": { softness: [0, 0.5] },
  // How tall a full step of the field stands, in photograph pixels
  // (the shared strength is Depth Lighting's percent).
  "heeler.depth_normals": { strength: [0, 10000] },
  // How far a full field moves the picture, in photograph pixels.
  "heeler.displacement_map": { strength: [0, 200] },
  "heeler.fog": { density: [0, 100], start: [0, 100], falloff: [0, 100], texture: [0, 100], texture_size: [0, 100], texture_shift: [0, 100], fog_level: [0, 100], fog_hue: [0, 360], fog_sat: [0, 100], desat: [0, 100], depth_black: [0, 0.99], depth_white: [0.01, 1], depth_gamma: [0.1, 10], depth_black_soft: [0, 100], depth_white_soft: [0, 100] },
  "heeler.key_light": { strength: [-200, 200], azimuth: [-180, 180], elevation: [5, 90], ambient: [0, 100], relief: [1, 100], invert: [0, 1], depth_black: [0, 0.99], depth_white: [0.01, 1], depth_gamma: [0.1, 10], depth_black_soft: [0, 100], depth_white_soft: [0, 100] },
  "heeler.depth_map": { edges: [0, 100], flatten: [0, 100], near_clip: [0, 40], far_clip: [0, 40], size: [518, 1036], depth_black: [0, 0.99], depth_white: [0.01, 1], depth_gamma: [0.1, 10], depth_black_soft: [0, 100], depth_white_soft: [0, 100] },
  "heeler.dof": { aperture: [0, 100], focus: [0, 100], blades: [3, 9], blade_curve: [0, 100], fringe: [0, 100], field_curve: [-100, 100], glow: [0, 100], bubble: [0, 100], squeeze: [-100, 100], swirl: [0, 100] },
  "heeler.halation": { threshold: [0, 100], background: [0, 100], by_depth: [-100, 100], radius: [0.5, 30], diffusion: [0, 100], hue: [0, 360], saturation: [0, 100], blue_comp: [0, 100], amount: [0, 300], mix: [0, 100], bloom: [0, 100], bloom_radius: [5, 60] },
  "heeler.sharpening": { radius: [0, 200], intensity: [0, 100] },
  "heeler.skin_soften": { softening: [0, 200], detail_back: [0, 200], strength: [0, 100] },
  // The tool groups' mirrors carry the same dials.
  "heeler.group": { radius: [0, 200], intensity: [0, 100], keep_color: [0, 100], softening: [0, 200], detail_back: [0, 200], strength: [0, 100] },
  "heeler.flare": { intensity: [0, 300], temp: [-100, 100], size: [0, 30], softness: [0, 100], rays: [0, 32], ray_length: [0, 100], ray_softness: [0, 100], rotation: [0, 360], ghosts: [0, 16], ghost_spacing: [10, 200], ghost_size: [0, 30], blades: [3, 12], dispersion: [0, 100], ghost_opacity: [0, 100], anamorphic: [0, 100], streak_size: [0.2, 8], streak_length: [10, 300], streak_taper: [0, 100], streak_angle: [-90, 90], streak_offset: [-50, 50], streak_shift: [-50, 50], streak_noise: [0, 100], veil: [0, 100], veil_radius: [5, 100], veil_depth: [-100, 100], occlusion: [0, 100], occlusion_soft: [0, 100] },
  // The crop TOOL's aspect is a target ratio (0.1..10); the Geometry
  // slider's aspect is a bipolar squeeze. Same word, different physics.
  "heeler.crop_rotate": { aspect: [-100, 100] },
  // The gradient overlays pinch their midpoint off the ends; the
  // gradient map lets it run nearly edge to edge (the shared PARAM_RANGE
  // row carries the wider 1..99).
  "heeler.gradient": { midpoint: [5, 95], angle: [-180, 180] },
  "heeler.fx_gradient_overlay": { midpoint: [5, 95], angle: [-180, 180] },
  // Shadows, glows and bevels point anywhere around the compass; the
  // shared `angle` row is the crop tool's +/-45 straightening nudge, and
  // it was capping these sliders so a fresh Shadow's own 135-degree
  // default sat off the end of its own track.
  // Distance had no range anywhere, so the generic face, which drew
  // only params with a range, left a Shadow's offset unreachable (the
  // face coverage test, 2026-10-01). The registry's 0..250 px.
  "heeler.fx_shadow": { size: [0, 250], angle: [-180, 180], distance: [0, 250] },
  "heeler.fx_glow": { size: [0, 250] },
  "heeler.fx_bevel": { size: [0, 100], angle: [-180, 180] },
  // Desaturate and Invert are 0..1 fractions in the registry and the
  // engine, not the 0..100 percent every other amount speaks. On the
  // shared row their inspector slider was a binary switch: anything at
  // or over 1 clamped to full.
  "heeler.desaturate": { amount: [0, 1] },
  "heeler.invert": { amount: [0, 1] },
  // A color range mask's falloff is a 0..1 distance around the picked
  // color; the shared `falloff` row is the bend's reach across the
  // hue/saturation disc (0.15..2), which both hid this param's 0.1
  // default below the slider's floor and promised travel the engine
  // clamps away past 1.
  "heeler.color_range_mask": { falloff: [0, 1] },
  // CAT16 covers 1667..25000 K; the shared `temperature` row is the
  // white balance sliders' 2000..50000, whose top half the engine
  // clamps off here.
  "heeler.chromatic_adapt": { temperature: [1667, 25000] },
  // The smart mask's dials: threshold cuts the model's 0..100
  // confidence (sharpen's 0..255 threshold is a different animal),
  // feather is a percentage like expand, not the 0..1 masks use.
  "heeler.smart_mask": { threshold: [0, 100], feather: [0, 100], expand: [-100, 100] },
};

/** Numeric params a node type offers, by name, so the graph inspector
 * can render the control whether or not the instance has the value yet.
 *
 * The rows used to enumerate the INSTANCE's keys, which made a
 * palette-placed node with empty params (Blur, Denoise, the logic
 * family, anything without a NEUTRAL_PARAMS entry) a panel of nothing
 * until some other code path happened to write a value in. The text
 * rows had already learned the lesson ("what the TYPE offers, not what
 * the instance happens to carry"); this is the same lesson for numbers.
 * Names only, on purpose: defaults stay owned by the registry and the
 * PARAM_DEFAULT tables, so there is still no second copy of a value to
 * drift.
 *
 * Plumbing params (roi_*, warp_*, strokes, regions, lens coefficients
 * before a profile writes them) are deliberately absent: they are
 * written by tools, not edited by hand, and several have no honest
 * slider range. */
export const TYPE_NUM_PARAMS: Record<string, string[]> = {
  "heeler.transform": ["move_x", "move_y", "size", "rotate", "pivot_x", "pivot_y"],
  "heeler.blur": ["radius", "angle"],
  "heeler.high_pass": ["radius"],
  "heeler.denoise": ["strength"],
  "heeler.nlm_denoise": ["strength"],
  "heeler.noise": ["size", "seed", "color_grain"],
  "heeler.grain": ["intensity", "size", "color_grain"],
  "heeler.channel_gain": ["gain"],
  "heeler.clarity": ["texture", "clarity", "local_contrast"],
  "heeler.luminance_range_mask": ["low", "high", "feather"],
  "heeler.color_range_mask": ["range", "falloff"],
  "heeler.selection_mask": ["feather", "grow", "smooth", "border_width", "ramp", "antialias", "matte_contrast", "matte_reach"],
  "heeler.vignette": ["vignette", "vignette_mid", "softness"],
  "heeler.hot_pixel": ["sensitivity"],
  "heeler.fx_shadow": ["size", "distance", "angle", "inner"],
  "heeler.fx_glow": ["size", "inner"],
  "heeler.fx_bevel": ["size", "depth", "angle"],
  "heeler.depth_map": ["edges", "flatten", "near_clip", "far_clip", "size"],
  "heeler.fx_gradient_overlay": ["angle", "midpoint"],
  "heeler.gradient": ["angle", "midpoint", "alpha_a", "alpha_b"],
  "heeler.gradient_map": ["midpoint"],
  "heeler.output": ["quality", "long_edge"],
  "heeler.blend": ["opacity", "clip"],
  "heeler.paint": ["heal"],
  "heeler.clone": ["heal"],
  // The logic family (ops_logic.rs). Conditional has no numeric params
  // at all: its controls are its three wires.
  "heeler.measure": ["smoothing"],
  "heeler.compare": ["level", "softness"],
  "heeler.math": ["constant", "scale", "offset"],
  "heeler.morphology": ["radius"],
  "heeler.guided_filter": ["radius", "epsilon"],
  "heeler.guided_filter_mask": ["radius", "epsilon"],
  "heeler.edge_field": ["scale", "threshold", "softness"],
  "heeler.soft_clip": ["ceiling", "knee", "toe"],
  "heeler.median": ["radius", "percentile"],
  "heeler.median_mask": ["radius", "percentile"],
  "heeler.distance_field": ["max_distance"],
  "heeler.chroma_key": ["key_r", "key_g", "key_b", "tolerance", "softness"],
  "heeler.chroma_key_despill": ["key_r", "key_g", "key_b", "spill"],
  "heeler.depth_normals": ["strength", "cliff"],
  "heeler.displacement_map": ["strength", "max_displacement"],
  "heeler.remap": ["in_low", "in_high", "gamma", "out_low", "out_high", "clamp"],
  "heeler.smart_mask": ["threshold", "expand", "feather"],
};

/** Whether a param has a slider range, shared or this type's own: a
 * param with only a per-type range (a Smart Mask's Expand, a Shadow's
 * Distance) is as much a slider as one in the shared table. */
export function hasParamRange(param: string, nodeType?: string): boolean {
  return !!PARAM_RANGE[param] || !!(nodeType && PARAM_RANGE_BY_TYPE[nodeType]?.[param]);
}

export function paramRange(param: string, nodeType?: string): [number, number] {
  const override = nodeType
    ? PARAM_RANGE_BY_TYPE[nodeType]?.[param]
    : undefined;
  return override ?? PARAM_RANGE[param] ?? [-100, 100];
}

/** What a value may actually BE, as opposed to what the slider spans.
 *
 * The app-wide rule, mirroring hard_limits in heeler-graph/spec.rs so
 * the two ends cannot disagree. "A user may be able to type
 * in larger or smaller values (when possible, like for Radius you
 * should not be able to go below 0 but go as high as you want)... Let's
 * make this a whole pass on its own and set it as a rule in the app."
 *
 * Derived, not declared per param, because there is one honest rule to
 * derive: a slider that starts at zero starts there because below zero
 * is meaningless, and a slider that already goes negative admits both
 * directions. Everything else is editorial, and a typed number may
 * exceed it.
 */
export function hardRange(param: string, nodeType?: string): [number, number] {
  const [lo] = paramRange(param, nodeType);
  return lo >= 0 ? [0, Infinity] : [-Infinity, Infinity];
}

export function clampParam(
  param: string,
  value: number,
  nodeType?: string,
): number {
  const override = nodeType
    ? PARAM_RANGE_BY_TYPE[nodeType]?.[param]
    : undefined;
  const r = override ?? PARAM_RANGE[param];
  if (!r) return value;
  // The hard limit, not the slider's. Dragging cannot leave the control
  // range anyway, so widening this only affects what may be typed.
  const [lo, hi] = r[0] >= 0 ? [0, Infinity] : [-Infinity, Infinity];
  return Math.min(hi, Math.max(lo, value));
}

/** Params that are 0/1 flags wearing number clothes (serializeGraph
 * turns them into real booleans for the engine). Quad edit needs the
 * list too: a toggle mirrors absolutely, only a slider moves by delta. */
export const FLAG_PARAMS = ["invert", "color_grain", "heal", "antialias", "clip", "inner", "clamp", "depth_on", "depth_invert", "hue_curve_on", "split", "by_frame", "feather_guided", "mask_off"];

/** Commands whose nodes-change is loading machinery, not an edit: quad
 * edit must not mirror these onto the other photos. Everything else
 * that changes the driver's nodes propagates, including undo and redo,
 * whose diffs are exactly the compensating deltas. */
/** Steps that belong to the photograph they were made on: Bake Warp's
 * picture is that photograph's pixels, and Unbake puts back the Warp
 * layer that photograph baked. Mirrored, a linked photograph's own live
 * Warp layer lost its mask to the bake's removal while its warp stayed
 * (found 2026-10-01 building Unbake). Neither they nor their undo and
 * redo (Snapshot.ownPhoto) reach the link or the quad edit. */
const OWN_PHOTO_STEPS = new Set(["art_bake_warp", "art_unbake_warp"]);

/** Besides QUAD_NO_MIRROR: the link's own bookkeeping never mirrors. */
const LINK_NO_MIRROR = new Set(["set_link_group", "toggle_link_pin", "stash_graphs", "settle_link_edits", "link_saved", "select_image", "load_images", "begin_session_load", "link_match"]);

const QUAD_NO_MIRROR = new Set([
  "settle_link_edits",
  "link_match",
  "open_quad_edit",
  "close_quad_edit",
  "quad_anchor",
  "replace_graph",
  "reset_graph",
  "reset_image_edits",
  "apply_profile_defaults",
  "apply_merged_defaults",
  "apply_rendered_bypass",
  "move_curves_late",
  "move_levels_late",
  "split_curve_faces",
  "restore_takes",
  "switch_take",
]);

/** One mirrored change: a numeric param moves by the driver's delta, a
 * flag/curve/text/stroke change copies whole. `path` is the node id,
 * with the group's id first when the change happened inside one. */
type QuadOp =
  | {
      op: "param";
      path: string[];
      types: string[];
      key: string;
      kind: "delta" | "abs";
      value: number;
    }
  | { op: "field"; path: string[]; types: string[]; field: string; value: unknown };

/** Field-level diff of two node lists sharing ids, recursing one level
 * into groups (enabled categories are groups; their published controls
 * edit children inside). */
/** What a numeric param that a node does not carry means, where it is
 * not zero: a Develop layer's node carries no `opacity` until its
 * slider moves, and unset is all of it. A relative mirror reads the
 * missing side at this value, or a linked member with an explicit 100
 * would take a driver's first move from an unset 100 as a move from 0. */
const UNSET_PARAM: Record<string, number> = { opacity: 100 };

function quadDiffNodes(
  prev: NodeCard[],
  next: NodeCard[],
  parent: { path: string[]; types: string[] } = { path: [], types: [] },
): QuadOp[] {
  const ops: QuadOp[] = [];
  const prevById = new Map(prev.map((n) => [n.id, n]));
  for (const n of next) {
    const old = prevById.get(n.id);
    if (!old || old === n) continue;
    const path = [...parent.path, n.id];
    const types = [...parent.types, n.type];
    if (old.params !== n.params) {
      for (const [key, value] of Object.entries(n.params)) {
        if (old.params[key] === value) continue;
        if (typeof value !== "number" || FLAG_PARAMS.includes(key) || (n.type === "heeler.model_denoise" && key === "method")) {
          ops.push({ op: "param", path, types, key, kind: "abs", value });
        } else {
          const from = old.params[key] ?? UNSET_PARAM[key] ?? 0;
          ops.push({ op: "param", path, types, key, kind: "delta", value: value - from });
        }
      }
    }
    for (const field of [
      "curves",
      "curveInterp",
      "curveTangents",
      "curveHandles",
      "textParams",
      "strokes",
      "regions",
      "enabled",
    ] as const) {
      if (old[field] !== n[field]) {
        ops.push({ op: "field", path, types, field, value: n[field] });
      }
    }
    if (old.groupNodes !== n.groupNodes && old.groupNodes && n.groupNodes) {
      ops.push(...quadDiffNodes(old.groupNodes, n.groupNodes, { path, types }));
    }
  }
  return ops;
}

/** Finds the member's counterpart for one path step: same id first
 * (photos share default-graph ids, and mirrored adds keep the driver's
 * ids), else the only node of that type, else nothing: a section this
 * photo does not have simply sits the change out. */
function quadMatch(nodes: NodeCard[], id: string, type: string): NodeCard | null {
  const byId = nodes.find((n) => n.id === id);
  if (byId) return byId;
  const byType = nodes.filter((n) => n.type === type);
  return byType.length === 1 ? byType[0] : null;
}

function quadApplyToNode(node: NodeCard, op: QuadOp): NodeCard {
  if (op.op === "param") {
    const current = node.params[op.key];
    const value =
      op.kind === "abs"
        ? op.value
        : clampParam(op.key, (typeof current === "number" ? current : (UNSET_PARAM[op.key] ?? 0)) + op.value, node.type);
    return { ...node, params: { ...node.params, [op.key]: value } };
  }
  return { ...node, [op.field]: structuredClone(op.value) };
}

/** Applies one op inside a node list, following the path (node, or
 * group then child). Returns the same array when nothing matched. */
function quadApplyOp(nodes: NodeCard[], op: QuadOp, depth = 0): NodeCard[] {
  const target = quadMatch(nodes, op.path[depth], op.types[depth]);
  if (!target) return nodes;
  if (depth === op.path.length - 1) {
    const applied = quadApplyToNode(target, op);
    return nodes.map((n) => (n === target ? applied : n));
  }
  if (!target.groupNodes) return nodes;
  const inner = quadApplyOp(target.groupNodes, op, depth + 1);
  if (inner === target.groupNodes) return nodes;
  return nodes.map((n) => (n === target ? { ...n, groupNodes: inner } : n));
}

const wireKey = (w: Wire) => `${w.from}→${w.to}:${w.toPort}:${w.kind}`;

/** Mirrors one driver change onto every unpinned member.
 *
 * Two halves. Structure: nodes added or removed on the driver (enabling
 * a section, adding a layer) are re-played onto the member by id, with
 * the same wire splice, all-or-nothing per member: if the member's
 * wiring does not line up (a section it enabled on its own), the whole
 * structural change sits out rather than half-landing. Values: field
 * diffs, numeric params as RELATIVE deltas onto the member's own value
 * (the owner's underexposed frame keeps its head start), everything
 * else as a copy.*/
function quadMirror(prev: { nodes: NodeCard[]; wires: Wire[] }, s: State): State {
  const q = s.quadEdit!;
  const targets = q.ids.filter(
    (id) => id !== q.driver && !q.pinned.includes(id) && s.quadGraphs[id],
  );
  if (targets.length === 0) return s;
  const quadGraphs = mirrorMembers(prev, s, s.quadGraphs, targets);
  return quadGraphs === s.quadGraphs ? s : { ...s, quadGraphs };
}

/** The same mirror for a link group (2026-09-09): the active
 * photograph drives, and every linked member whose graph is in the
 * stash (read from disk when the link came into view) takes the
 * change as quad's members do. Pinned members sit it out. The
 * members' graphs are then owed a write, which linkDirty records for
 * the persistence effect.*/
function linkMirror(prev: { nodes: NodeCard[]; wires: Wire[] }, s: State): State {
  const me = s.images.find((i) => i.id === s.activeImage);
  const group = me?.linkGroup;
  if (!group) return s;
  const all = s.images
    .filter((i) => i.linkGroup === group && i.id !== s.activeImage && !s.linkPinned.includes(i.id))
    .map((i) => i.id);
  const delta = mirrorDelta(prev, s);
  if (Object.values(delta).every((ops) => ops.length === 0)) return s;
  const targets = all.filter((id) => s.graphs[id] && !s.graphs[id].preRead);
  const pending = { ...s.linkPending };
  for (const id of all.filter((id) => !targets.includes(id))) {
    pending[id] = [...(pending[id] ?? []), { delta, overrides: [...s.linkOverrides] }];
  }
  const mirrored = mirrorMembers(prev, s, s.graphs, targets, (id) => [...(s.graphs[id].overrides ?? []), ...s.linkOverrides], delta);
  const graphs = { ...s.graphs };
  const dirty = new Set(s.linkDirty);
  for (const id of targets) {
    if (mirrored[id] !== s.graphs[id]) {
      graphs[id] = { ...graphs[id], nodes: mirrored[id].nodes, wires: mirrored[id].wires };
      dirty.add(id);
    }
  }
  return { ...s, graphs, linkDirty: [...dirty], linkPending: pending };
}

type MemberGraph = { nodes: NodeCard[]; wires: Wire[]; backdrops: Backdrop[] };

/** The member's graph made a copy of the source's, except what the
 * overrides keep: an overridden node stays exactly as the member has it
 * (with its own wires; one the source has and the member lacks is not
 * added, one the member has and the source lacks stays), an overridden
 * dial keeps the member's value. Grid Warp and Shape Warp are the
 * photograph's own geometry and stay, as a paste keeps them. */
function matchGraph(source: MemberGraph, member: MemberGraph, overrides: string[]): MemberGraph {
  // Both read in the one shape (liftArtMasks), so a Finish mask meets
  // itself whichever photograph's graph was sunk; the result is sunk.
  const own = { ...member, ...liftArtMasks(member.nodes, member.wires) };
  const out = matchGraphLifted({ ...source, ...liftArtMasks(source.nodes, source.wires) }, own, overrides);
  return out === own ? member : { ...out, ...sinkArtMasks(out.nodes, out.wires) };
}

function matchGraphLifted(source: MemberGraph, member: MemberGraph, overrides: string[]): MemberGraph {
  const keptNodes = new Set(overrides.filter((k) => k.startsWith("node:")).map((k) => k.slice("node:".length)));
  const keptParams = overrides
    .filter((k) => k.startsWith("param:"))
    .map((k) => k.slice("param:".length).split("|"))
    .filter((parts): parts is [string, string] => parts.length === 2);
  const walk = (src: NodeCard[], own: NodeCard[]): NodeCard[] => {
    const ownById = new Map(own.map((n) => [n.id, n]));
    const out: NodeCard[] = [];
    for (const n of src) {
      const mine = ownById.get(n.id);
      if (keptNodes.has(n.id)) {
        if (mine) out.push(structuredClone(mine));
        continue;
      }
      let node = structuredClone(n);
      if (mine) {
        for (const [nid, param] of keptParams) {
          if (nid !== n.id) continue;
          const params = { ...node.params };
          if (param in mine.params) params[param] = structuredClone(mine.params[param]);
          else delete params[param];
          node = { ...node, params };
        }
        if (node.groupNodes && mine.groupNodes) node = { ...node, groupNodes: walk(node.groupNodes, mine.groupNodes) };
      }
      out.push(node);
    }
    for (const o of own) if (keptNodes.has(o.id) && !src.some((n) => n.id === o.id)) out.push(structuredClone(o));
    return out;
  };
  const pasted = pasteGraphKeepingWarp(source, member);
  const nodes = walk(pasted.nodes, member.nodes);
  const ids = new Set(nodes.map((n) => n.id));
  const touchesKept = (w: Wire) => keptNodes.has(w.from) || keptNodes.has(w.to);
  const wires: Wire[] = [];
  const seen = new Set<string>();
  for (const w of [...pasted.wires.filter((w) => !touchesKept(w)), ...member.wires.filter(touchesKept)]) {
    if (!ids.has(w.from) || !ids.has(w.to)) continue;
    const k = wireKey(w);
    if (seen.has(k)) continue;
    seen.add(k);
    wires.push(structuredClone(w));
  }
  return reconcileMatch({ nodes, wires, backdrops: structuredClone(source.backdrops) }, member, keptNodes, pasted.wires);
}

/** The candidate match made sound before it lands on the member.
 * Combining the source's wires that avoid the kept nodes with the
 * member's wires that touch them can leave an image port fed twice (the
 * source's new node and the kept node's own wire both answering it) or
 * a source node fed not at all (its feed ran through the kept section
 * and died with it), and the two chains can disagree badly enough to
 * close a loop. The policy: where two wires answer the same image port,
 * the kept section's own wire wins; a kept node whose own wires died
 * with the nodes they named is spliced back where the source had it,
 * fed from the source's predecessor and feeding the source's successor;
 * a source node left unfed beyond that is dropped with its wires rather
 * than planted as an orphan, and the output, which cannot be dropped,
 * is fed from whatever the chain's tail is now. Mask wires sit out of
 * all of it: they are the photographs' stencils, not the chain, and
 * they die only with a node that is dropped. A candidate that still
 * fails (a cycle the kept section carries) leaves the member's graph
 * exactly as it was, and the console names the node. */
function reconcileMatch(candidate: MemberGraph, member: MemberGraph, keptNodes: Set<string>, sourceWires: Wire[]): MemberGraph {
  let { nodes, wires } = candidate;
  const touchesKept = (w: Wire) => keptNodes.has(w.from) || keptNodes.has(w.to);
  const fail = (n: NodeCard): MemberGraph => {
    logMsg("warn", `Match to This Photo left the member's edits untouched: ${n.name} (${n.id}) could not be reconciled between the two photographs' chains.`);
    return member;
  };
  const portFed = (to: string, toPort: string) => wires.some((w) => w.to === to && w.toPort === toPort && w.kind !== "mask");
  const fed = () => new Set(wires.filter((w) => w.toPort === "in" && w.kind !== "mask").map((w) => w.to));
  const feeding = () => new Set(wires.filter((w) => w.kind !== "mask").map((w) => w.from));
  // One feed per image port: the kept section's own wire wins, the
  // source's goes. A valid graph feeds a port once, so two wires on one
  // port are always one of each side's.
  const byPort = new Map<string, Wire[]>();
  for (const w of wires) {
    if (w.kind === "mask") continue;
    const k = `${w.to}:${w.toPort}`;
    byPort.set(k, [...(byPort.get(k) ?? []), w]);
  }
  const droppedWires = new Set<Wire>();
  for (const feeding of byPort.values()) {
    if (feeding.length < 2) continue;
    const winner = feeding.find(touchesKept) ?? feeding[0];
    for (const w of feeding) if (w !== winner) droppedWires.add(w);
  }
  wires = wires.filter((w) => !droppedWires.has(w));
  // A kept node whose own wires died with the nodes they named sits
  // unwired in the middle of the source's chain. Splice it back where
  // the source had it: fed from the source's predecessor while its port
  // is free, feeding the source's successor while it feeds nothing. A
  // kept node the member already wired keeps the member's answer.
  for (;;) {
    let healed = false;
    const ids = new Set(nodes.map((n) => n.id));
    for (const k of keptNodes) {
      const kn = nodes.find((n) => n.id === k);
      if (!kn) continue;
      if (kn.hasIn && !portFed(k, "in")) {
        const up = sourceWires.find((w) => w.to === k && w.toPort === "in" && w.kind !== "mask" && ids.has(w.from));
        if (up) {
          wires = [...wires, { ...up }];
          healed = true;
          continue;
        }
      }
      if (!feeding().has(k)) {
        const down = sourceWires.find((w) => w.from === k && w.kind !== "mask" && ids.has(w.to) && !portFed(w.to, w.toPort));
        if (down) {
          wires = [...wires, { ...down }];
          healed = true;
        }
      }
    }
    if (!healed) break;
  }
  // A source node left unfed is dropped with its wires; dropping one can
  // unfed the next, so sweep to a fixed point. Kept nodes are the
  // member's own and stand however the member wired them.
  for (;;) {
    const have = fed();
    const orphan = nodes.find((n) => n.hasIn && n.type !== "heeler.output" && !keptNodes.has(n.id) && !have.has(n.id));
    if (!orphan) break;
    nodes = nodes.filter((n) => n.id !== orphan.id);
    wires = wires.filter((w) => w.from !== orphan.id && w.to !== orphan.id);
  }
  // The output cannot be dropped: an unfed output takes the chain's
  // tail, the last node nothing else follows.
  const out = nodes.find((n) => n.type === "heeler.output");
  if (out && !fed().has(out.id)) {
    const tail = [...nodes].reverse().find((n) => n.id !== out.id && n.hasOut && !feeding().has(n.id));
    if (!tail) return fail(out);
    wires = [...wires, { from: tail.id, to: out.id, toPort: "in", kind: "image" }];
  }
  // The kept section is the member's own, but a cycle through it renders
  // nothing; a candidate that still fails leaves the member untouched.
  const onward = new Map<string, string[]>();
  for (const w of wires) if (w.kind !== "mask") onward.set(w.from, [...(onward.get(w.from) ?? []), w.to]);
  const mark = new Map<string, number>();
  let cycled: NodeCard | undefined;
  const visit = (id: string): void => {
    if (cycled) return;
    const m = mark.get(id) ?? 0;
    if (m === 2) return;
    if (m === 1) {
      cycled = nodes.find((n) => n.id === id);
      return;
    }
    mark.set(id, 1);
    for (const next of onward.get(id) ?? []) visit(next);
    mark.set(id, 2);
  };
  for (const n of nodes) {
    visit(n.id);
    if (cycled) break;
  }
  if (cycled) return fail(cycled);
  return { nodes, wires, backdrops: candidate.backdrops };
}

type MirrorDelta = {
  addedAll: NodeCard[]; removedAll: string[]; addedWiresAll: Wire[]; removedWiresAll: Wire[]; opsAll: QuadOp[];
};
type PendingLinkEdit = { overrides: string[] } & ({ delta: MirrorDelta } | { match: MemberGraph });

function mirrorDelta(prev: Pick<MemberGraph, "nodes" | "wires">, s: Pick<MemberGraph, "nodes" | "wires">): MirrorDelta {
  const prevIds = new Set(prev.nodes.map((n) => n.id));
  const nextIds = new Set(s.nodes.map((n) => n.id));
  const addedAll = s.nodes.filter((n) => !prevIds.has(n.id));
  const removedAll = [...prevIds].filter((id) => !nextIds.has(id));
  const prevWireKeys = new Set(prev.wires.map(wireKey));
  const nextWireKeys = new Set(s.wires.map(wireKey));
  const addedWiresAll = s.wires.filter((w) => !prevWireKeys.has(wireKey(w)));
  const removedWiresAll = prev.wires.filter((w) => !nextWireKeys.has(wireKey(w)));
  const opsAll = quadDiffNodes(prev.nodes, s.nodes);
  return { addedAll, removedAll, addedWiresAll, removedWiresAll, opsAll };
}

function replayLinkEdits(member: MemberGraph, edits: PendingLinkEdit[], overrides: string[]): MemberGraph {
  return edits.reduce((graph, edit) => {
    const kept = [...overrides, ...edit.overrides];
    return "match" in edit ? matchGraph(edit.match, graph, kept)
      : mirrorMembers(graph, graph, { member: graph }, ["member"], () => kept, edit.delta).member;
  }, member);
}

/** One driver change replayed onto each target's graph; returns the
 * members map, the same object when nothing changed. */
function mirrorMembers(
  prev: { nodes: NodeCard[]; wires: Wire[] },
  s: { nodes: NodeCard[]; wires: Wire[] },
  membersIn: Record<string, MemberGraph>,
  targets: string[],
  /** A member's overrides: "node:<id>" keeps that node as the member
   * has it, "param:<id>|<param>" keeps one dial; the rest of the
   * change lands. Quad edit passes none.*/
  overridesOf: (id: string) => string[] = () => [],
  delta?: MirrorDelta,
): Record<string, MemberGraph> {
  const { addedAll, removedAll, addedWiresAll, removedWiresAll, opsAll } = delta ?? mirrorDelta(prev, s);
  if (
    addedAll.length === 0 &&
    removedAll.length === 0 &&
    addedWiresAll.length === 0 &&
    removedWiresAll.length === 0 &&
    opsAll.length === 0
  ) {
    return membersIn;
  }

  const quadGraphs = { ...membersIn };
  for (const id of targets) {
    const member = quadGraphs[id];
    // The change was read on the lifted graph (reduceWith), so it lands
    // on the member's lifted graph, and the member is sunk again after.
    const lifted = liftArtMasks(member.nodes, member.wires);
    let nodes = lifted.nodes;
    let wires = lifted.wires;
    // What this member keeps as its own: overridden nodes sit out of
    // every change, structural or dial; an overridden dial sits out of
    // its own change only.
    const overrides = new Set(overridesOf(id));
    const kept = (nid: string) => overrides.has(`node:${nid}`);
    // A splice that adds or removes a kept node is that node's own
    // business, bypass wire included. Filtering the kept node out of the
    // adds but not the wire it displaced cut every other member's chain:
    // with Levels overridden on one photograph, switching Levels on there
    // took stdcolor>exposure off the rest, and no later Levels edit could
    // splice into them (2026-09-13: "I expect to see ... the rest of the
    // photos without a LEVELS override be updated, but they are not"). The
    // whole structural half sits out instead.
    const spliceKept = addedAll.some((n) => kept(n.id)) || removedAll.some(kept);
    const added = spliceKept ? [] : addedAll.filter((n) => !kept(n.id));
    const removed = spliceKept ? [] : removedAll.filter((nid) => !kept(nid));
    const addedWires = spliceKept ? [] : addedWiresAll.filter((w) => !kept(w.from) && !kept(w.to));
    const removedWireKeys = spliceKept ? [] : removedWiresAll.filter((w) => !kept(w.from) && !kept(w.to)).map(wireKey);
    const ops = opsAll.filter((op) => !op.path.some(kept) && !(op.op === "param" && overrides.has(`param:${op.path[op.path.length - 1]}|${op.key}`)));

    if (added.length > 0 || removed.length > 0 || addedWires.length > 0 || removedWireKeys.length > 0) {
      const memberIds = new Set(nodes.map((n) => n.id));
      const survivors = new Set(
        [...memberIds].filter((nid) => !removed.includes(nid)),
      );
      for (const n of added) survivors.add(n.id);
      const fits =
        added.every((n) => !memberIds.has(n.id)) &&
        addedWires.every((w) => survivors.has(w.from) && survivors.has(w.to)) &&
        removedWireKeys.every((k) => wires.some((w) => wireKey(w) === k));
      if (fits) {
        nodes = [
          ...nodes.filter((n) => !removed.includes(n.id)),
          ...structuredClone(added),
        ];
        wires = [
          ...wires.filter(
            (w) =>
              !removedWireKeys.includes(wireKey(w)) &&
              !removed.includes(w.from) &&
              !removed.includes(w.to),
          ),
          ...structuredClone(addedWires),
        ];
      }
    }

    for (const op of ops) nodes = quadApplyOp(nodes, op);

    if (nodes !== lifted.nodes || wires !== lifted.wires) {
      quadGraphs[id] = { ...member, ...sinkArtMasks(nodes, wires) };
    }
  }
  return quadGraphs;
}

const UNDOABLE = new Set([
  "link_match",
  "add_gamut_map_after",
  "grid_warp_mesh",
  "grid_warp_density",
  "grid_warp_line",
  "grid_warp_reset",
  "shape_warp_add",
  "shape_warp_remove",
  "shape_warp_rename",
  "shape_warp_enable",
  "shape_warp_set",
  "shape_warp_reset",
  // A picture's own warp added or taken away, and a Finish warp's Type:
  // each one step. The first was missing, so Undo after Warp or Remove
  // Warp popped the step before it instead.
  "art_layer_warp",
  "art_warp_kind",
  "add_inpaint_for",
  "remove_inpaint",
  "art_remove_from_selection",
  // Was missing, and its undo test passed by ACCIDENT: undo popped the
  // previous command's snapshot, which happened to hold the old mask
  // type while silently discarding that command's own work too.
  "convert_mask_to_selection",
  "convert_mask_to_pixels",
  "load_selection_from_mask",
  "apply_preset",
  "point_matte_at_bake",
  "art_add_fill_layer",
  "art_add_smart_layer",
  "paste_edits",
  "art_add_layer",
  "art_add_file_layers",
  "art_add_image_layer",
  "art_layer_via_copy",
  "art_bake_warp",
  "art_unbake_warp",
  "art_image_source",
  "art_duplicate_layer",
  "art_fill_from_selection",
  "art_arm_dodge",
  "art_clip_layer",
  "art_mask_from_selection",
  "art_add_fx",
  "art_remove_fx",
  "art_fx_move",
  "art_fx_set",
  "art_content_set",
  // Without this the transform has no undo at all: withUndo hands back
  // the new state untouched for any command not on this list, so a drag
  // would be permanent and silent about it.
  "art_set_quad",
  "art_flip_layer",
  "flip_photo",
  "art_add_mask",
  "art_remove_mask",
  "art_group_layers",
  "art_ungroup",
  "art_remove_layer",
  "art_move_layer",
  "art_layer_set",
  "art_set_export",
  "art_set_mask_export",
  "set_layer_mask_export",
  "set_section_export",
  "art_add_stroke",
  "art_update_stroke",
  "move_node",
  "move_nodes",
  "duplicate_nodes",
  "reset_node",
  "add_backdrop",
  "move_backdrop",
  "resize_backdrop",
  "rename_backdrop",
  "cycle_backdrop_color",
  "delete_backdrop",
  "arrange_nodes",
  "set_param",
  "set_params",
  "set_curve",
  "reset_curves",
  "set_curve_interp",
  "set_text_param",
  "add_stroke",
  "clear_strokes",
  "add_region",
  "set_published",
  "set_published_choice",
  "publish_param",
  "unpublish_param",
  "rename_published",
  "move_published",
  "set_published_range",
  "add_recipe",
  "set_recipe",
  "set_denoise_method",
  "add_color_set",
  // A section's switch builds or bypasses its nodes: a graph change, so
  // an undo step and an edit ("the node graph changed, would
  // that not qualify as an edit?"). It was missing here, which also left
  // it outside undo.
  "set_category",
  "apply_calibration",
  "apply_lens_character",
  "apply_section_look",
  "add_character_flare_light",
  "set_color_sets_enabled",
  "remove_all_color_sets",
  "remove_color_set",
  "remove_region",
  "clear_regions",
  "set_regions",
  "add_polish_stroke",
  "update_polish_stroke",
  "reset_mask",
  "set_region_op",
  "set_region_smooth",
  "set_region_off",
  "move_region",
  "move_region_point",
  "set_node_tint",
  "set_node_note",
  "node_outside",
  "splice_node_into_wire",
  "extract_node",
  "set_enabled",
  "rename_node",
  "delete_nodes",
  "add_node",
  "add_layer",
  "duplicate_layer",
  "rename_layer",
  "remove_layer",
  // Was missing, and its undo test passed by ACCIDENT: the undo popped
  // the adjacent set_param's snapshot, which happened to hold the layer
  // switched off while silently discarding that command's own work too.
  "set_layer_enabled",
  "connect",
  "disconnect",
  "group_selection",
]);

function snapshot(s: State, label: string): Snapshot {
  return {
    nodes: s.nodes.map((n) => ({ ...n, params: { ...n.params } })),
    wires: [...s.wires],
    backdrops: s.backdrops.map((b) => ({ ...b })),
    label,
  };
}

/** Would adding from->to create a cycle? Mirrors Graph::reaches_downstream. */
export function createsCycle(wires: Wire[], from: string, to: string): boolean {
  if (from === to) return true;
  const queue = [to];
  const seen = new Set<string>();
  while (queue.length) {
    const cur = queue.shift()!;
    if (cur === from) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const w of wires) if (w.from === cur) queue.push(w.to);
  }
  return false;
}

/** Whether input `toPort` of `toNode` takes a pipe of this kind (a
 * field pipe when `maskPipe`). The one type rule for a connection: the
 * connect reducer checks it, and the graph's hand reads it from both
 * ends (a pipe drawn out of an output lights the inputs that pass it, a
 * pipe drawn out of an input lights the outputs), so what lights is
 * what connects.
 *
 * On the logic family (and invert_mask, Channel Join) the field IS the
 * input: field pipes on the operand ports, nothing else. The alpha
 * diamond (Output's transparency, the Export Layer's written alpha,
 * Channel Join's alpha plane, Alpha Association's Replace alpha, the
 * Displacement Map's Y field) and the depth input take field pipes
 * only, on the cards that draw them. Everywhere else a field pipe goes
 * to the mask port and a picture pipe anywhere but. */
export function seatTakes(toNode: Pick<NodeCard, "type" | "hasIn3" | "depthIn">, toPort: Wire["toPort"], maskPipe: boolean): boolean {
  if (MASK_IN_TYPES.has(toNode.type)) {
    const operand =
      toPort === "in" ||
      toPort === "in2" ||
      (toPort === "in3" && !!toNode.hasIn3) ||
      (toPort === "alpha" && ALPHA_IN_TYPES.has(toNode.type)) ||
      (toNode.type === "heeler.invert_mask" && toPort === "mask");
    return maskPipe && operand;
  }
  if (toPort === "alpha") return maskPipe && ALPHA_IN_TYPES.has(toNode.type);
  if (toPort === "depth") return maskPipe && !!toNode.depthIn;
  return toPort === "mask" ? maskPipe : !maskPipe;
}

/** A node's side wires: every pipe into or out of it that is not its
 * main in (`mainIn`) or main out (`mainOut`): the fields on its
 * diamonds, a second picture on in2, its own field outputs. A node
 * moved along a chain (dropped onto another pipe, or Option-dragged
 * loose) is rewired on its main in and out alone, and keeps these.
 * (2026-10-01): "I disconnected the Displacement map node and dragged
 * it between image source and standard color. When I did that both
 * math nodes dropped their connection." The caller adds them back
 * (rejoinSides) once its new main wires are in, so a side wire that
 * would now close a loop is the one let go.*/
export function sideWires(wires: Wire[], id: string, mainIn: (w: Wire) => boolean, mainOut: (w: Wire) => boolean): Wire[] {
  return wires.filter(
    (w) => w.kind !== "group" && ((w.to === id && !mainIn(w)) || (w.from === id && !mainOut(w))),
  );
}

/** Whether wire `w` lands on a field pass-through's operand seat
 * (fieldSpliceSeats). invert_mask's one input goes by "in" (drawn by
 * hand from the port) and "mask" (its registry name) alike. */
export function onFieldSeat(node: Pick<NodeCard, "id" | "type">, w: Wire, inSeat: "in" | "mask"): boolean {
  if (w.to !== node.id) return false;
  if (node.type === "heeler.invert_mask") return w.toPort === "in" || w.toPort === "mask";
  return w.toPort === inSeat;
}

/** `wires` with each of `side` added back, in order, unless its port is
 * taken by then or it would close a loop. */
export function rejoinSides(wires: Wire[], side: Wire[]): Wire[] {
  let out = wires;
  for (const w of side) {
    if (out.some((k) => k.to === w.to && k.toPort === w.toPort)) continue;
    if (createsCycle(out, w.from, w.to)) continue;
    out = [...out, w];
  }
  return out;
}

/** The gesture a hand-drawn pipe re-route runs in: taking the old pipe
 * off, clearing an occupied port and making the new one are one undo
 * step. Outside that gesture each still pushes its own entry, as a lone
 * connect or disconnect always has. */
export const WIRE_GESTURE = "wires.hand";

/** Coalescing key for commands that arrive in streams during a drag. */
function gestureKey(cmd: Command): string | null {
  switch (cmd.type) {
    case "connect":
    case "disconnect":
      return WIRE_GESTURE;
    case "grid_warp_mesh": return "gridwarp.mesh";
    case "grid_warp_density": return "gridwarp.density";
    case "grid_warp_line": return "gridwarp.line";
    // A shape's placement drag or warp drag streams into one step.
    case "shape_warp_set": return "shapewarp.shape";
    // A streamed stroke: added once at mousedown, then grown point by
    // point while the engine renders each growth. One history entry for
    // the whole drag, exactly like a slider.
    case "art_add_stroke":
    case "art_update_stroke":
      return `${cmd.id}.artstroke`;
    // The polish brush streams the same way: begin_gesture marks the
    // mousedown, and without a key here every streamed point pushed its own
    // history entry: one Cmd+Z undid a single pixel of mouse travel, and a
    // hundred moves later the pre-polish state had fallen off the end of
    // the stack. "I can't undo strokes."
    case "add_polish_stroke":
    case "update_polish_stroke":
      return `${cmd.id}.polishstroke`;
    case "set_param":
      return `${cmd.id}.${cmd.param}`;
    // Dragging an EQ point streams text-param writes the same way a
    // slider streams numbers; without a key each frame of the drag
    // pushed its own history entry.
    case "set_text_param":
      return `${cmd.id}.${cmd.param}`;
    case "set_params":
      return `${cmd.id}.batch`;
    // Dragging a vertex fires on every mouse move. Without a key the
    // undo stack fills with one entry per pixel and getting back to
    // where you started takes two hundred presses.
    case "move_region_point":
      return `${cmd.id}.pt${cmd.index}.${cmd.point}`;
    case "set_region_smooth":
      return `${cmd.id}.smooth${cmd.index}`;
    case "set_curve":
      return `${cmd.id}.${cmd.channel}`;
    // The opacity slider drags like any other slider; one history entry
    // per gesture, not one per pixel of mouse travel.
    case "art_layer_set":
      return cmd.opacity !== undefined ? `${cmd.id}.artopacity` : null;
    case "art_content_set":
      // Numbers AND text: a color drag in the picker writes a hex
      // string per mousemove, and unkeyed it filled the history one
      // entry per pixel of travel, the same failure the sliders had.
      return `${cmd.id}.${cmd.param}`;
    // A drag fires on every mouse move. Without a key the undo stack
    // fills with one entry per pixel of travel.
    case "art_set_quad":
      return `${cmd.id}.quad`;
    case "art_fx_set":
      // Same rule as art_content_set: an effect's color drags write
      // strings, its sliders write numbers, and both are one gesture.
      return `${cmd.fxId}.${cmd.param}`;
    case "move_node":
      return `${cmd.id}.move`;
    case "move_nodes":
      return "selection.move";
    case "move_backdrop":
      return `${cmd.id}.bdmove`;
    case "resize_backdrop":
      return `${cmd.id}.bdsize`;
    default:
      return null;
  }
}

/** History depth. One entry per completed gesture, capped and per-image. */
export const HISTORY_LIMIT = 100;

/** The open group closed when the nodes about to be installed no
 * longer hold it (undo past its making, redo past its deletion). */
function closedIfGone(s: State, nodes: NodeCard[]): Partial<State> {
  if (!s.openedGroup || nodes.some((n) => n.id === s.openedGroup)) return {};
  return { openedGroup: null, ...(s.graphViewBack ? { graphView: s.graphViewBack } : {}), graphViewBack: null };
}

/** Applies a command to the contents of the group currently open.
 *
 * A group's children are not in `s.nodes`, so a slider inside one would
 * otherwise write to a node id that is not there and do nothing at all.
 * Rather than teach every case in the switch below about groups, the whole
 * reducer is run again against the group's contents and the result folded
 * back in. Every case works inside a group because every case is the same
 * case; there is no second implementation to keep in step.
 *
 * History is kept at the outer level on purpose. The inner call would
 * otherwise stack up snapshots of the children, and undoing one would
 * replace the whole graph with the inside of a group. It runs with an empty
 * stack, and whether it pushed anything is the signal for whether this was a
 * change worth remembering, which keeps the mid-drag rule working: a slider
 * dragged inside a group is still one undo, same as anywhere else.
 */
function insideGroup(s: State, cmd: Command): State | null {
  if (!s.openedGroup) return null;
  // Finish commands already traverse the art stack from its outer root.
  if (cmd.type.startsWith("art_")) return null;
  const g = s.nodes.find((n) => n.id === s.openedGroup);
  if (!g?.groupNodes) return null;
  const member = (id: string | undefined) => !!id && g.groupNodes!.some((n) => n.id === id);
  // The ids a command aims at: a card's own, a set of cards, a pipe's
  // ends. Any of them inside the open group and the command runs inside.
  // Before 2026-09-23 only the `id` shape was looked at, so a pipe
  // dragged off a member's input, Delete on a member, and a reconnect
  // inside a group all ran against the OUTER graph, where the ids are
  // not, and did nothing or (connect) left a stray pipe between ids the
  // outer graph has no cards for ("when in a group node the
  // what should be common controls are not working like they do on the
  // main graph"). A pipe with one end outside the group is refused here
  // and by the connect case below. A group inside a group: nothing can
  // open one yet (the editor, the Canvas pool and this router all look
  // one level down), so the gesture is refused with a word rather than
  // making a nest that reads as lost nodes.
  if (cmd.type === "group_selection") return { ...s, notice: { text: "Groups inside a group are not supported yet", at: Date.now() } };
  const inside =
    member((cmd as { id?: string }).id) ||
    ((cmd.type === "delete_nodes" || cmd.type === "duplicate_nodes") && cmd.ids.some(member)) ||
    (cmd.type === "move_nodes" && cmd.moves.some((m) => member(m.id))) ||
    (cmd.type === "disconnect" && member(cmd.to)) ||
    (cmd.type === "connect" && member(cmd.wire.to) && member(cmd.wire.from)) ||
    // The graph you are looking at is the one a new card lands in and
    // the one Arrange lays out.
    cmd.type === "add_node" ||
    cmd.type === "arrange_nodes";
  if (!inside) return null;
  const child = reduceInner(
    {
      ...s,
      nodes: g.groupNodes,
      wires: g.groupWires ?? [],
      // Cleared, so the inner call cannot come straight back here.
      openedGroup: null,
      undoStack: [],
      redoStack: [],
    },
    cmd,
  );
  const pushed = child.undoStack.length > 0;
  // A boundary pipe whose member was just deleted has nowhere to land;
  // dropped, so the flattened graph never names a card that is gone.
  // Only the inside end can die here: the outside end of a boundary
  // entry (the frame feeding a Finish mask, a mask outside a group
  // feeding a member) is not a member, and reading it as deleted
  // dropped every such entry on any edit made inside the open group.
  const wasMember = new Set(g.groupNodes.map((n) => n.id));
  const alive = (id: string) => id === "" || !wasMember.has(id) || child.nodes.some((n) => n.id === id);
  const boundary = g.groupBoundary?.filter((w) => alive(w.from) && alive(w.to));
  // Everything else the command set inside comes out whole: the probe
  // (probeNode), a rename request, a notice, the selection a delete
  // clears or a duplicate moves, the gesture. Only the graph itself is
  // folded back into the group, and the history is the outer one.
  return {
    ...child,
    nodes: s.nodes.map((n) =>
      n.id === g.id
        ? { ...n, groupNodes: child.nodes, groupWires: child.wires, ...(boundary ? { groupBoundary: boundary } : {}), published: prunePublished(n.published, (id) => child.nodes.some((k) => k.id === id)) }
        : n,
    ),
    wires: s.wires,
    openedGroup: s.openedGroup,
    undoStack: pushed
      ? [...s.undoStack, snapshot(s, child.undoStack[0].label)].slice(-HISTORY_LIMIT)
      : s.undoStack,
    redoStack: pushed ? [] : s.redoStack,
  };
}

/** Commands that replace the nodes or wires array WITHOUT changing what
 * the engine renders: canvas layout, display names, and the tint and
 * note that only exist on the node's face. Everything else that touches
 * nodes or wires bumps renderVersion, so forgetting to list a new
 * command here costs one spare render, never a stale frame.
 *
 * Checked before listing each one: set_published looks neutral but is
 * not -- it is the group's face driving a param on a child inside, which
 * is exactly as render-affecting as set_param. */
const RENDER_NEUTRAL = new Set([
  // A group's face: which controls it offers, their names, order and
  // spans. No member's value moves (Reset is reset_node's, not these).
  "publish_param",
  "unpublish_param",
  "rename_published",
  "move_published",
  "set_published_range",
  "move_node",
  "move_nodes",
  "rename_node",
  "rename_layer",
  "set_node_tint",
  "set_node_note",
  "arrange_nodes",
]);

/** The reducer, plus the render bookkeeping every command shares.
 * Bumping here, by watching whether the nodes or wires array was
 * replaced, means the render-affecting cases cannot drift away from the
 * pump the way a hand-maintained list of them did. */
/** Commands that fire at pointer rate: the debug spine stays silent on
 * them (the audit's must-not list). Gestures are bounded by their own
 * begin/end lines, so the absence of lines between them is readable. */
const reduceLogged = new WeakSet<object>();

const REDUCE_DEBUG_QUIET = new Set([
  "set_param",
  "set_params",
  "set_curve",
  "set_curve_hover",
  "move_node",
  "move_nodes",
  "add_stroke",
  "set_brush_radius",
  "zoom_viewer",
  "zoom_step",
  "pan_viewer",
  "zoom_graph",
  "pan_graph",
  "set_split_pos",
]);

const PICK_GRAPH_REPLACEMENTS = new Set<string>([
      "select_image", "load_images", "begin_session_load", "replace_graph",
      "switch_take", "new_take", "delete_take", "restore_takes", "apply_preset",
      "reset_image_edits", "undo", "redo", "close_quad_edit",
    ]);

/** The pickers whose disarm cancels a pending answer aimed through them. */
const PICK_ARMS = [
  "curvePick", "wbPick", "toneEqPick", "recolorPick", "recolorMatch", "bwSeparate", "bwPick", "zonePlace",
  "csetDropper", "consolePick", "dofPick", "keyLightPick", "chartPlace",
] as const;
/** A dropper a pick session can name as the arm it answers through. Typed
 * from the list so a misspelt arm is a compile error, not a session that
 * quietly never learns its dropper was put away. */
export type PickArm = (typeof PICK_ARMS)[number];
const pickArmed = (v: unknown): boolean => v !== null && v !== undefined && v !== false;

/** After a command moved a tool group: its own params or mode moved,
 * so the members follow (a Develop slider, a reset, the Recipe
 * switch); or only the members moved (an edit inside the opened group,
 * a published control), so the mirror follows. */
function syncToolGroups(prev: State, next: State, cmd: Command): State {
  let changed = false;
  const nodes = next.nodes.map((n) => {
    if (!n.tool || !n.isGroup) return n;
    const before = prev.nodes.find((m) => m.id === n.id);
    if (before === n) return n;
    // Only an explicit write to the group's controls pushes. Loading,
    // pasting and undo replace objects too, but the saved members are
    // the graph, including changes made inside it.
    const mirrorWrite = (cmd.type === "set_param" || cmd.type === "set_params" ||
      cmd.type === "set_text_param" || cmd.type === "reset_node") && cmd.id === n.id;
    const rewire = cmd.type === "reset_node" || before?.textParams?.mode !== n.textParams?.mode;
    const target = mirrorWrite && cmd.type === "reset_node" ? resetToolGroup(n) : n;
    const synced = mirrorWrite ? pushToolGroup(target, rewire) : pullToolGroup(n);
    if (synced !== n) changed = true;
    return synced;
  });
  return changed ? { ...next, nodes } : next;
}

export function reduce(s: State, cmd: Command): State {
  return reduceWith(s, cmd, true);
}

/** The reducer for a copy that is never dispatched or kept: a guided
 * tour's plan (src/tourplan.ts) and a held section look (lookPreview
 * below). The same rules as reduce, silent in the debug log, since it
 * is not the user's graph. The app's own dispatch always goes through
 * reduce. */
export function reducePlanCopy(s: State, cmd: Command): State {
  return reduceWith(s, cmd, false);
}


/** The state the VIEWER renders while a section look is held: the
 * graph with the look applied through the same reducer the apply runs
 * (on a copy that is never dispatched or kept, reducePlanCopy's
 * contract), so the depth wiring and everything else
 * the apply brings come along. Only the render requests read this
 * (bridge.ts: renderPreview, renderRoi); the state itself, and with it
 * the saved graph, undo, export, bake, thumbnails and the catalog,
 * never holds the look. The same state back when nothing is held. */
const lookPreviewMemo = new WeakMap<NodeCard[], { wires: Wire[]; id: string; prefs: State["prefs"]; nodes: NodeCard[]; out: Wire[] }>();
export function lookPreviewState(s: State): State {
  const look = lookById(s.lookPreview);
  if (!look) return s;
  const hit = lookPreviewMemo.get(s.nodes);
  if (hit && hit.wires === s.wires && hit.id === look.id && hit.prefs === s.prefs) {
    return { ...s, nodes: hit.nodes, wires: hit.out };
  }
  const applied = reducePlanCopy({ ...s, lookPreview: null }, { type: "apply_section_look", id: look.id });
  lookPreviewMemo.set(s.nodes, { wires: s.wires, id: look.id, prefs: s.prefs, nodes: applied.nodes, out: applied.wires });
  return { ...s, nodes: applied.nodes, wires: applied.wires };
}

/** Commands that land a whole graph (a load, a Take, a paste, undo and
 * redo, a reset): whatever they bring was written on the crop it came
 * with, so nothing follows a crop they change. */
const CROP_LANDINGS = new Set<string>([
  ...PICK_GRAPH_REPLACEMENTS,
  "paste_edits",
  "reset_graph",
  "settle_link_edits",
  "link_match",
  "stash_graphs",
  "open_quad_edit",
  "quad_anchor",
  "apply_profile_defaults",
  "apply_merged_defaults",
  "apply_rendered_bypass",
]);

/** The shape of the photograph the crop reads, for turning a crop:
 * the viewer's note of the file's oriented size, else the frame it last
 * showed undone by the crop it showed it under, else 3:2 (logged). */
export function cropSourceAspect(s: State): number {
  const noted = sourceAspectFor(s.activeImage);
  if (noted) return noted;
  const frame = frameAspectFor(s.activeImage);
  if (frame) {
    // The crop tool shows the whole rectangle (cropPreviewGraph).
    if (s.tool === "crop") return frame;
    const g = cropGeomOf(s.nodes);
    return (frame * g.h) / g.w;
  }
  logDebug(() => `followCrop: no size known for ${s.activeImage}; turning on 3:2`);
  return 1.5;
}

/** A crop edit carries every stroke, region and placed mask shape onto
 * the new frame (2026-09-30: "yes, do the stroke remap for 26.4").
 * Only an edit of the photograph on screen: a landing brings its own
 * geometry, written on the crop it came with, and a node the command
 * wrote itself is already on the new frame.*/
function followCrop(s: State, next: State, cmd: Command): State {
  if (next.nodes === s.nodes || next.activeImage !== s.activeImage || CROP_LANDINGS.has(cmd.type)) return next;
  const from = cropGeomOf(s.nodes);
  const to = cropGeomOf(next.nodes);
  if (sameCrop(from, to)) return next;
  // A flip's frame is the old frame mirrored, pixel for pixel
  // (flippedCropParams): the map is that mirror exactly, where the
  // crops' fractions would carry the window's rounding along with it.
  const map =
    cmd.type === "flip_photo" ? mirrorRemap(cmd.axis, frameAspectFor(s.activeImage) ?? cropSourceAspect(s)) : frameRemap(from, to, cropSourceAspect(s));
  if (!map) return next;
  const before = new Map(s.nodes.map((n) => [n.id, n]));
  const written = (n: NodeCard): boolean => {
    const was = before.get(n.id);
    if (!was) return true;
    return (
      was !== n &&
      (was.strokes !== n.strokes ||
        was.regions !== n.regions ||
        was.params !== n.params ||
        was.textParams !== n.textParams ||
        was.groupNodes !== n.groupNodes)
    );
  };
  let nodes = remapNodes(next.nodes, map, written);
  if (cmd.type === "flip_photo") nodes = photoFlipExtras(nodes, cmd.axis);
  return nodes === next.nodes ? next : { ...next, nodes };
}

/** Whether Photo > Flip can act, or the outcome-first reason it cannot. */
export function photoFlipBlocked(s: Pick<State, "activeImage" | "nodes">): string | null {
  if (!s.activeImage) return "open a photograph to flip it";
  const crop = s.nodes.find((n) => n.type === "heeler.crop_rotate");
  if (crop && crop.enabled === false) {
    return "the Crop & Rotate node is bypassed in the graph; switch it on and the photograph flips with its crop";
  }
  return null;
}

/** Which ways the photograph is flipped now (the crop node's switches). */
export function photoFlips(s: Pick<State, "nodes">): { h: boolean; v: boolean } {
  const g = cropGeomOf(s.nodes);
  return { h: !!g.flipH, v: !!g.flipV };
}

/** A direction in degrees mirrored: across ("h") it runs 180 minus
 * itself, down ("v") minus itself; brought back into [lo, lo + 360). */
function mirrorDegrees(a: number, axis: FlipAxis, lo = -180): number {
  const m = axis === "h" ? 180 - a : -a;
  let out = ((m - lo) % 360 + 360) % 360 + lo;
  if (Math.abs(out - lo - 360) < 1e-9) out = lo;
  return out;
}

/** What a frame remap does not know, for Photo > Flip: the whole result
 * mirrors (2026-10-01: "In [the other editor], the edits flip with the
 * photo."), so
 * - a picture placed on the frame (an image layer from a file or the
 * catalog, which a crop leaves where it is in the frame) mirrors
 * about the frame's center, picture and place; a copy anchored to
 * the scene was carried by the remap already;
 * - every direction mirrors: a Gradient layer's and a Gradient
 * Overlay's angle, a Shadow's and a Bevel's light, a motion Blur's
 * path, a Flare's rays and its streak (the streak's offsets read
 * along and across its own axis, so they follow the axis).
 * Procedural texture (grain, the fog's texture) is made fresh where it
 * lands and is not mirrored.*/
function photoFlipExtras(nodes: NodeCard[], axis: FlipAxis): NodeCard[] {
  let changed = false;
  const fix = (n: NodeCard): NodeCard => {
    let out = n;
    const p = n.params;
    const set = (patch: Record<string, number>) => {
      out = { ...out, params: { ...out.params, ...patch } };
      changed = true;
    };
    if (n.type === "heeler.blend" && String(n.textParams?.fit ?? "") === "place" && n.textParams?.anchor !== "scene" && (p.warp_bw ?? 0) > 0) {
      const bx = p.warp_bx ?? 0;
      const by = p.warp_by ?? 0;
      const rest: [number, number][] = [
        [bx, by],
        [bx + p.warp_bw, by],
        [bx + p.warp_bw, by + (p.warp_bh ?? 0)],
        [bx, by + (p.warp_bh ?? 0)],
      ];
      let corners = rest.map(([x, y], i) => [p[`warp_x${i}`] ?? x, p[`warp_y${i}`] ?? y] as [number, number]);
      if (corners.every(([x, y]) => x === 0 && y === 0)) corners = rest;
      const patch: Record<string, number> = {};
      corners.forEach(([x, y], i) => {
        patch[`warp_x${i}`] = axis === "h" ? 1 - x : x;
        patch[`warp_y${i}`] = axis === "v" ? 1 - y : y;
      });
      set(patch);
    }
    if (
      ["heeler.gradient", "heeler.gradient_map", "heeler.fx_gradient_overlay", "heeler.fx_bevel", "heeler.fx_shadow", "heeler.blur"].includes(n.type) &&
      typeof p.angle === "number"
    ) {
      set({ angle: mirrorDegrees(p.angle, axis) });
    }
    if (n.type === "heeler.flare") {
      const patch: Record<string, number> = {};
      const rot = mirrorDegrees(p.rotation ?? 0, axis, 0);
      if (rot !== (p.rotation ?? 0)) patch.rotation = rot;
      // The streak is a line, so its angle lives in -90..90; each half
      // turn that brings the mirrored angle there runs the streak the
      // other way along itself. Its offset reads along the line and its
      // shift across it, and a mirror turns "across" over.
      let t = axis === "h" ? 180 - (p.streak_angle ?? 0) : -(p.streak_angle ?? 0);
      let halves = 0;
      while (t > 90) {
        t -= 180;
        halves++;
      }
      while (t <= -90) {
        t += 180;
        halves++;
      }
      if (t !== (p.streak_angle ?? 0)) patch.streak_angle = t;
      if (halves % 2) {
        if (p.streak_offset) patch.streak_offset = -p.streak_offset;
      } else if (p.streak_shift) {
        patch.streak_shift = -p.streak_shift;
      }
      if (Object.keys(patch).length) set(patch);
    }
    if (n.groupNodes?.length) {
      const inner = n.groupNodes.map(fix);
      if (inner.some((m, i) => m !== n.groupNodes![i])) {
        out = { ...out, groupNodes: inner };
        changed = true;
      }
    }
    // A baked Warp layer's kept definition (Unbake): the remap carried
    // its geometry; its directions mirror here, as the live layer's would.
    if (n.bakedFrom) {
      const b = n.bakedFrom;
      const carrier = fix(b.carrier);
      const content = fix(b.content);
      const fx = b.fx.map(fix);
      const mask = b.mask && fix(b.mask);
      if (carrier !== b.carrier || content !== b.content || fx.some((f, i) => f !== b.fx[i]) || mask !== b.mask) {
        out = { ...out, bakedFrom: { carrier, content, fx, ...(mask ? { mask } : {}) } };
        changed = true;
      }
    }
    return out;
  };
  const next = nodes.map(fix);
  return changed ? next : nodes;
}

/** Refuse malformed numeric input before it can reach undo, takes or
 * linked photographs. This includes nested curves, strokes and groups,
 * not just the generic parameter rows. */
function hasNonFiniteNumber(value: unknown): boolean {
  if (typeof value === "number") return !Number.isFinite(value);
  if (Array.isArray(value)) return value.some(hasNonFiniteNumber);
  if (value && typeof value === "object") return Object.values(value).some(hasNonFiniteNumber);
  return false;
}

/** Graph edits made by hand inside the opened Finish group: they run on
 * the group as the user sees it, masks among its members, so a splice
 * into a mask's wire, a mask card moved or deleted, a node added beside
 * it, all land where they were aimed. Every other command runs on the
 * lifted graph the Finish reducers were written for. */
const ART_INSIDE_EDITS = new Set<Command["type"]>([
  "add_node", "delete_nodes", "connect", "disconnect", "move_node", "move_nodes", "duplicate_nodes", "extract_node",
  "splice_node_into_wire", "arrange_nodes", "rename_node", "request_rename", "set_node_note", "set_node_tint",
  "set_enabled", "node_outside", "group_selection",
]);

/** Layout on the canvas the user sees, at any level: a lifted mask's
 * card would stand among the top-level cards it is not one of, and an
 * Arrange there would move it. */
const ART_LAYOUT_ONLY = new Set<Command["type"]>([
  "move_node", "move_nodes", "arrange_nodes", "rename_node", "request_rename", "set_node_note", "set_node_tint",
]);

/** The reducer around the Finish masks' two shapes (liftArtMasks,
 * sinkArtMasks): the command runs on the lifted graph, the result is
 * sunk, so every Finish mask lives in the Finish group between commands
 * whatever the command was written for, a load of a graph saved before
 * 2026-10-01 included. A command that leaves the graph alone hands the
 * graph back untouched. */
let artShapeDepth = 0;
function reduceWith(s: State, cmd: Command, logged: boolean): State {
  const inside = (s.openedGroup === ART_ID && ART_INSIDE_EDITS.has(cmd.type)) || ART_LAYOUT_ONLY.has(cmd.type);
  const lifted = inside ? s : artMaskView(s);
  // A command a reducer runs inside its own (art_mask_from_selection's
  // art_add_mask, a step's select_image) hands back the lifted shape its
  // caller reads; the outermost call sinks once.
  if (artShapeDepth > 0) return reduceWithLifted(lifted, cmd, logged);
  let next: State;
  artShapeDepth++;
  try {
    next = reduceWithLifted(lifted, cmd, logged);
  } finally {
    artShapeDepth--;
  }
  if (next === lifted) return s;
  next = sinkStores(lifted, next);
  if (next.nodes === lifted.nodes && next.wires === lifted.wires) {
    return lifted === s ? next : { ...next, nodes: s.nodes, wires: s.wires };
  }
  const sunk = sinkArtMasks(next.nodes, next.wires);
  return sunk.nodes === next.nodes && sunk.wires === next.wires ? next : { ...next, nodes: sunk.nodes, wires: sunk.wires };
}

/** The graphs a command kept beside the live one (another photograph's
 * stash, a Take, the Copy Edits clipboard, a quad member's graph), sunk
 * where the command wrote them: what it stored it read lifted, and what
 * is saved holds the masks in the Finish group as the live graph does. */
function sinkStores(before: State, next: State): State {
  const sinkOne = <G extends { nodes: NodeCard[]; wires: Wire[] }>(g: G): G => {
    const out = sinkArtMasks(g.nodes, g.wires);
    return out.nodes === g.nodes && out.wires === g.wires ? g : { ...g, nodes: out.nodes, wires: out.wires };
  };
  const sinkRecord = <G extends { nodes: NodeCard[]; wires: Wire[] }>(was: Record<string, G>, now: Record<string, G>): Record<string, G> => {
    let out = now;
    for (const [k, g] of Object.entries(now)) {
      if (was[k] === g || !g) continue;
      const sunk = sinkOne(g);
      if (sunk !== g) out = out === now ? { ...now, [k]: sunk } : { ...out, [k]: sunk };
    }
    return out;
  };
  let out = next;
  if (next.graphs !== before.graphs) {
    const graphs = sinkRecord(before.graphs, next.graphs);
    if (graphs !== next.graphs) out = { ...out, graphs };
  }
  if (next.quadGraphs !== before.quadGraphs) {
    const quadGraphs = sinkRecord(before.quadGraphs, next.quadGraphs);
    if (quadGraphs !== next.quadGraphs) out = { ...out, quadGraphs };
  }
  if (next.editClipboard && next.editClipboard !== before.editClipboard) {
    const editClipboard = sinkOne(next.editClipboard);
    if (editClipboard !== next.editClipboard) out = { ...out, editClipboard };
  }
  if (next.takes !== before.takes) {
    let takes = next.takes;
    for (const [k, list] of Object.entries(next.takes)) {
      if (before.takes[k] === list) continue;
      const sunk = list.map((t) => (before.takes[k]?.includes(t) ? t : sinkOne(t)));
      if (sunk.some((t, i) => t !== list[i])) takes = { ...takes, [k]: sunk };
    }
    if (takes !== next.takes) out = { ...out, takes };
  }
  return out;
}

function reduceWithLifted(s: State, cmd: Command, logged: boolean): State {
  if (cmd.type === "set_params") {
    const values = Object.fromEntries(Object.entries(cmd.values).filter(([, v]) => Number.isFinite(v)));
    if (!Object.keys(values).length && !Object.keys(cmd.text ?? {}).length) return s;
    if (Object.keys(values).length !== Object.keys(cmd.values).length) cmd = { ...cmd, values };
  }
  // Layout restoration validates each field itself and keeps valid siblings.
  if (cmd.type !== "restore_layout" && hasNonFiniteNumber(cmd)) return s;

  // A section built by a control moving on its preview: the build and the
  // write that caused it are one edit, so one undo step takes both back,
  // the way the switch's own build is one step. Each half goes through the
  // whole reducer (the tool group sync, the link mirror),
  // and only the history is joined: the build's entry, the state before
  // either, stands for the pair. A drag that began the build keeps its
  // gesture, so the rest of it coalesces as usual.
  if ((cmd.type === "set_category" || cmd.type === "set_recipe") && cmd.then) {
    const { then, ...build } = cmd;
    let built = reduceWith(s, build as Command, logged);
    if (built === s) return s;
    // The build is part of the drag, not a command breaking into it.
    if (s.gesture !== null && gestureKey(then) === s.gesture) {
      built = { ...built, gesture: s.gesture, gestureOwner: s.gestureOwner, gesturePushed: s.gesturePushed };
    }
    const after = reduceWith(built, then, logged);
    return after === built ? built : { ...after, undoStack: built.undoStack };
  }
  let next = reduceInner(s, cmd);
  // A Finish layer's mask polish: leaving Polish is Apply, a photograph
  // switch cancels it first.
  next = polishLayerFollow(s, next, cmd);
  // Painting stays on the photograph through a re-crop, in the same
  // step as the crop (framemap.ts).
  next = followCrop(s, next, cmd);
  // A held section look ends the moment anything moves what it was
  // shown over: an edit, an undo, a Take, a paste, another photograph,
  // another layer, another mode. The menu lives in the panel; this is
  // the rule that holds whichever way the menu failed to close.
  if (
    next.lookPreview &&
    cmd.type !== "preview_section_look" &&
    (next.nodes !== s.nodes ||
      next.wires !== s.wires ||
      next.activeImage !== s.activeImage ||
      next.activeLayer !== s.activeLayer ||
      next.mode !== s.mode)
  ) {
    next = { ...next, lookPreview: null };
  }
  // A tool group's mirror and its members stay in step, whichever side
  // the command moved (recipes.ts: pushToolGroup, pullToolGroup).
  if (next.nodes !== s.nodes || next.wires !== s.wires) next = tapWiresLast(syncLayerMaskExports(s, pruneSectionExports(next)));
  if (next.nodes !== s.nodes) {
    next = syncToolGroups(s, next, cmd);
    next = { ...next, ...closedIfGone(next, next.nodes) };
    // Graph deletion and history use the same cleanup as panel deletion.
    // Only identities that existed and disappeared are cleared: an unbuilt
    // Develop control can legitimately name a node it will create later.
    const idsOf = (nodes: NodeCard[]): Set<string> => {
      const ids = new Set<string>();
      const visit = (list: NodeCard[]) => list.forEach(n => { ids.add(n.id); if (n.groupNodes) visit(n.groupNodes); });
      visit(nodes);
      return ids;
    };
    const before = idsOf(s.nodes), after = idsOf(next.nodes);
    const gone = (id: string | null | undefined) => !!id && before.has(id) && !after.has(id);
    const lostLayer = !!s.activeLayer && (gone(s.activeLayer) || gone(maskOfLayer(s.activeLayer)));
    const lostMask = gone(maskPreviewNode(s));
    const lostBrush = s.tool === "brush" && gone(maskBrushTarget(s)?.id);
    // A Finish layer's blend node is its identity, as the adjustment
    // layer's exposure node is.
    const lostArt = gone(s.artActive);
    // The depth view opened from a layer's Depth mask block goes with the
    // layer, like its mask view (2026-09-27: "when I am viewing the depth
    // map on an adjustment layer and delete the adjustment layer the depth
    // map preview remains. this should reset").
    if ((lostLayer || lostArt) && next.depthView) next = { ...next, depthView: false };
    if (lostLayer || lostMask || lostBrush) {
      next = { ...next,
        ...(lostLayer ? { activeLayer: null } : {}),
        ...(lostLayer || lostMask ? { maskView: false } : {}),
        ...(lostBrush || (lostLayer && ["brush", "select", "polish", "smart"].includes(next.tool)) ? { tool: "none", toolRevert: null } : {}),
      };
    }
    if (gone(next.probeNode)) next = { ...next, probeNode: null };
    if (next.csetMaskView !== null && gone(`cset${next.csetMaskView}_mask`)) next = { ...next, csetMaskView: null };
    if (gone(next.curvePick?.nodeId)) next = { ...next, curvePick: null, curveHoverX: null };
    if (gone(next.toneEqPick)) next = { ...next, toneEqPick: null, toneEqHoverX: null };
    if (gone(next.wbPick)) next = { ...next, wbPick: null };
    if (gone(next.recolorPick)) next = { ...next, recolorPick: null, recolorHoverX: null };
    if (gone(next.recolorMatch?.id)) next = { ...next, recolorMatch: null };
    if (gone(next.consolePick)) next = { ...next, consolePick: null, consolePickBand: null };
    if (next.csetDropper !== null && gone(`cset${next.csetDropper}_mask`)) next = { ...next, csetDropper: null, csetHoverHue: null };
    // The range-mask eyedropper's named seat: with the node gone the
    // click would sample into the void and no lit button remains to
    // put the dropper down. pickNode is cleared only by set_tool, and
    // the reducer sets the tool directly in places, so a target can
    // outlive its arming: the tool goes only if it is still the pick.
    if (gone(next.pickNode)) next = { ...next, pickNode: null, ...(next.tool === "pick" ? { tool: "none" as const } : null) };
    if (gone(next.toolRevert?.id)) next = { ...next, tool: "none", toolRevert: null };
  }
  // The selection panel's door closes it until the select tool is in
  // hand again or the active layer changes, whichever command did the
  // arming (set_tool, arm_document_selection, a layer conversion): one
  // rule here rather than a clear in every seat.
  if (
    next.selectionSplitClosed &&
    ((next.tool === "select" && s.tool !== "select") || next.activeLayer !== s.activeLayer)
  ) {
    next = { ...next, selectionSplitClosed: false };
  }
  // Putting the tool down ends the drag in its hand (the 26.4.3 full
  // review's R5): Escape or a toggle mid-crop left the gesture held, and
  // everything that waits out a gesture (the guard strip, Polish, the
  // depth tool, the ROI patch) waited for some later drag to end it.
  if ((cmd.type === "cancel_tool" || cmd.type === "set_tool") && next.tool !== s.tool && next.gesture !== null) {
    next = { ...next, gesture: null, gesturePushed: false, gestureOwner: undefined };
  }
  if (next !== s) {
    // The owner's review asks that handles leave with their node, including
    // graph deletes and undo, and never aim an old drag at a new photo.
    const warpType = warpTypeOfTool(s.tool);
    if (warpType) {
      // The warp the tool is on: the photograph's own, or the Finish
      // warp it was armed on, which goes with its layer.
      const kind = warpType === "heeler.grid_warp" ? "grid" : "shape";
      const oldWarp = warpNodeFor(s, kind, s.warpTarget);
      const newWarp = warpNodeFor(next, kind, s.warpTarget);
      if (
        (oldWarp && (!newWarp || (oldWarp.enabled && !newWarp.enabled))) ||
        ["replace_graph", "switch_take", "new_take", "delete_take", "restore_takes", "paste_edits", "apply_preset"].includes(cmd.type)
      ) {
        next = { ...next, ...droppedGridWarpTool(s), gesture: null, gesturePushed: false };
      } else if (next.tool !== s.tool) {
        // An ordinary tool change: the picks and any drag in hand go,
        // but the tool the user just chose, and its own revert, stay.
        // Dropping the whole tool here landed set_tool crop on "none"
        // with the crop's revert wiped.
        next = {
          ...next,
          gridWarp: s.tool === "gridwarp" ? { ...next.gridWarp, selected: [], live: null } : next.gridWarp,
          shapeWarp: s.tool === "shapewarp" ? { ...next.shapeWarp, selected: null } : next.shapeWarp,
          gesture: null,
          gesturePushed: false,
        };
      }
    }
    // A Finish warp's tool goes down when another layer becomes the
    // one being worked: its handles would sit over a layer the panel no
    // longer shows. Its own layer, or none picked, keeps it.
    if (next.warpTarget !== null && next.artActive !== s.artActive && next.artActive !== null) {
      const owner = artWarpOwner(next, next.warpTarget);
      if (owner && owner.carrier !== next.artActive) next = { ...next, ...droppedGridWarpTool(next), gesture: null, gesturePushed: false };
    }
    // A Warp layer's open settings are its edit mode (2026-09-30: "when the
    // layer is expanded it should just turn on warp editing"). With Expand
    // settings on select on, selecting a top-level Warp layer opens them, so
    // it arms its warp, by any door (a click, the Layer menu, a new layer).
    // With it off the chevron opens them, and the panel arms on it
    // (artlayers.tsx). A member of a group opens with its own chevron, which
    // the panel also arms on.
    if (
      (cmd.type === "select_art_layer" || cmd.type === "art_add_layer") &&
      next.layerExpandOnSelect &&
      next.artActive !== null &&
      next.artActive !== s.artActive
    ) {
      const top = artLayers(next).find((l) => l.blend.id === next.artActive);
      if (top && top.content.type === LAYER_WARP) next = reduceInner(next, { type: "art_warp_edit", id: top.content.id, on: true });
    }
    // A Finish warp's edit mode leaves with Finish: its handles would sit
    // over a photograph the Layers panel no longer shows.
    if (next.warpTarget !== null && artToolbarVisible(s) && !artToolbarVisible(next) && artWarpOwner(next, next.warpTarget)) {
      next = { ...next, ...droppedGridWarpTool(next), gesture: null, gesturePushed: false };
    }
    // An undo or redo that changes a Finish warp's type under its tool
    // puts the tool down: the gizmo would edit the type the render no
    // longer applies.
    if (next.warpTarget !== null && (cmd.type === "undo" || cmd.type === "redo")) {
      const node = warpNodeById(next, next.warpTarget);
      if (node && warpToolOf(warpKindOf(node)) !== next.tool) next = { ...next, ...droppedGridWarpTool(next), gesture: null, gesturePushed: false };
    }
    // The target belongs to the warp tools: any other tool in hand (or
    // none) aims nothing at a Finish warp.
    if (next.warpTarget !== null && next.tool !== "gridwarp" && next.tool !== "shapewarp") {
      next = { ...next, warpTarget: null };
    }
    // A Finish tool leaves with Finish. The owner left Heal armed, went
    // back to Adjustments and could not edit his radial layer: the brush
    // overlay still covered the photograph, took every pointer event and
    // wore its own cursor, so the ellipse's handles never came up. One rule
    // here covers every way out (the panel tabs, moving the Finish tab,
    // Graph and Canvas leaving the Finish group, a mode switch, a hotkey)
    // instead of a put-down in each seat: a Finish tool is only in hand
    // while the Finish toolbar is on screen. Picking an adjustment layer
    // (or Base) is a way out too, for the split panel where Finish stays on
    // screen below: the click says the adjustment is what is being worked
    // on now. Put down through set_tool, so a transform in progress commits
    // the way any other put-down commits it.
    if (
      FINISH_TOOLBAR_TOOLS.has(next.tool) &&
      (!artToolbarVisible(next) || cmd.type === "set_active_layer" || next.activeLayer !== s.activeLayer)
    ) {
      next = reduceInner(next, { type: "set_tool", tool: "none" });
    }
    // The light rig and the focus pick leave with their section.
    const dropped = droppedDepthArms(s, next);
    if (Object.keys(dropped).length) next = { ...next, ...dropped };
    // The chart tool leaves with its node the same way: the overlay's
    // gate draws nothing without it, so the arm cannot outlive it.
    if (
      s.chartPlace &&
      next.chartPlace &&
      s.nodes.some((n) => n.type === "heeler.color_checker") &&
      !next.nodes.some((n) => n.type === "heeler.color_checker")
    ) {
      next = { ...next, chartPlace: false };
    }
    // A consumer that just asked for the plane gets the wire that
    // carries it (26.3 Phase 10.3).
    if (DEPTH_WIRE_COMMANDS.has(cmd.type)) {
      next = wireDepthTransitions(s, next);
    }
    if (treatmentOn(s) && !treatmentOn(next)) {
      next = { ...next, bwPick: false, bwHoverHue: null, bwSeparate: null };
    }
    // Count each graph replacement and node removal, even if React
    // batches a delete and identical re-arm into a single render.
    // Node identity cannot express this: unrelated reducers rebuild
    // node objects.
    //
    // Disarms are counted PER ARM, not in the shared epoch: a completed
    // one-shot pick (its dropper puts itself away) must end only the
    // sessions that aimed through that dropper. Sessions carrying no
    // picker arm in their aim (a Lens Character door's depth read, a
    // light's From-scene depth) were otherwise canceled in silence by
    // any unrelated pick finishing. Sessions watch their own arm's
    // count, so a disarm batched with a same-value re-arm still ends
    // the sessions that were waiting on it. One cursor at a time
    // (2026-09-13: an eyedropper still armed when he went to move a
    // Depth Lighting light left the cursor stuck on the dropper, and it
    // took leaving the light and Escape to clear it). Arming a picker
    // puts every other picker away, and picking up a viewer tool puts
    // all of them away. Putting a tool down does not: a picker armed on
    // purpose is still wanted, and a view (a mask eye, the depth eye)
    // is not a tool.
    const newlyArmed = PICK_ARMS.filter((arm) => pickArmed(next[arm]) && !pickArmed(s[arm]));
    const toolPicked = next.tool !== s.tool && next.tool !== "none";
    if (newlyArmed.length || toolPicked) {
      const stays = new Set<string>(newlyArmed);
      if (stays.has("curvePick")) stays.add("curveHoverX");
      if (stays.has("recolorPick")) stays.add("recolorHoverX");
      if (stays.has("toneEqPick")) stays.add("toneEqHoverX");
      if (stays.has("bwPick")) stays.add("bwHoverHue");
      if (stays.has("csetDropper")) stays.add("csetHoverHue");
      if (stays.has("consolePick")) stays.add("consolePickBand");
      const others = Object.keys(PICKER_RESET).filter((k) => !stays.has(k) && pickArmed(next[k as keyof typeof PICKER_RESET]));
      if (others.length) next = { ...next, ...Object.fromEntries(others.map((k) => [k, PICKER_RESET[k as keyof typeof PICKER_RESET]])) };
    }
    const replaced = PICK_GRAPH_REPLACEMENTS.has(cmd.type);
    const disarmed = PICK_ARMS.filter((arm) => pickArmed(s[arm]) && !pickArmed(next[arm]));
    const ids = next.nodes !== s.nodes ? new Set(next.nodes.map((n) => n.id)) : null;
    const removed = ids !== null && s.nodes.some((n) => !ids.has(n.id));
    if (replaced || removed) {
      next = { ...next, pickerEpoch: (s.pickerEpoch ?? 0) + 1,
        curveHoverX: null, csetHoverHue: null, toneEqHoverX: null, recolorHoverX: null, bwHoverHue: null };
    }
    if (disarmed.length) {
      const counts = { ...s.pickerDisarms };
      for (const arm of disarmed) counts[arm] = (counts[arm] ?? 0) + 1;
      next = { ...next, pickerDisarms: counts };
    }
  }
  // Once per COMMAND OBJECT: React invokes reducers eagerly on
  // dispatch and again during render, so without this every line
  // printed twice. The same object arrives both times. A tour plan's
  // copy is not the user's graph, and says nothing here.
  if (logged && !REDUCE_DEBUG_QUIET.has(cmd.type) && !reduceLogged.has(cmd)) {
    reduceLogged.add(cmd);
    if (next === s) {
      // The literal "nothing happened": accepted, and changed nothing.
      logDebug(() => `reduce: ${cmd.type} was a no-op`);
    } else {
      logDebug(
        () =>
          `reduce: ${cmd.type}${"id" in cmd && typeof (cmd as { id?: unknown }).id === "string" ? ` id=${(cmd as { id: string }).id}` : ""}${next.nodes !== s.nodes || next.wires !== s.wires ? " (graph changed)" : ""}`,
      );
    }
  }
  if (next === s || RENDER_NEUTRAL.has(cmd.type)) return next;
  if (next.nodes !== s.nodes || next.wires !== s.wires) {
    // Quad edit rides here, on the same watch: any real change to the
    // driver's graph is re-applied to the unpinned members, so no new
    // command can forget to mirror.
    //
    // Landing on another photo is never an edit, whichever command did
    // the landing. select_image is excluded by name, but step_image,
    // select_images, select_image_range, remove_images and
    // add_stack_image switch through an inner select_image and came
    // back here under their own names: the difference between the two
    // photos' graphs was then mirrored onto the new photo's link group
    // as if it were a drag. (2026-09-09): stepping from an edited
    // linked photo to a fresh one in a second link handed that pair the
    // exact negatives of the edits, and stepping back doubled them on
    // the first group ("values are multiplying on each other").
    const switched = next.activeImage !== s.activeImage;
    // Undoing or redoing a Reset Edits step puts every photograph it
    // touched back itself (undoReset, resetImages); mirroring the active
    // photograph's difference onto its link on top would count it twice.
    const resetStep =
      (cmd.type === "undo" && !!s.undoStack[s.undoStack.length - 1]?.reset) ||
      (cmd.type === "redo" && !!s.redoStack[s.redoStack.length - 1]?.redoReset);
    const ownPhoto =
      OWN_PHOTO_STEPS.has(cmd.type) ||
      (cmd.type === "undo" && !!s.undoStack[s.undoStack.length - 1]?.ownPhoto) ||
      (cmd.type === "redo" && !!s.redoStack[s.redoStack.length - 1]?.ownPhoto);
    if (switched || resetStep || ownPhoto) {
      // Nothing to mirror; the render bump below still applies.
    } else if (next.quadEdit && !QUAD_NO_MIRROR.has(cmd.type)) {
      next = quadMirror({ nodes: s.nodes, wires: s.wires }, next);
    } else if (!next.quadEdit && !QUAD_NO_MIRROR.has(cmd.type) && !LINK_NO_MIRROR.has(cmd.type)) {
      // Linked photographs ride the same watch, quad or no quad.
      next = linkMirror({ nodes: s.nodes, wires: s.wires }, next);
    }
    // A graph change the user made is an edit, whether or not a dial moved:
    // switching a section on, adding a Color Set, wiring a node. Only the
    // param writers used to set the badge, so a photograph with tools
    // enabled but untouched read as unedited ("the node graph
    // changed, would that not qualify as an edit?"). Undoable commands
    // only, so loads, image switches and takes stay loads.
    if (UNDOABLE.has(cmd.type) && next.activeImage) {
      const active = next.images.find((i) => i.id === next.activeImage);
      if (active && !active.edited) {
        next = {
          ...next,
          images: next.images.map((i) => (i.id === next.activeImage ? { ...i, edited: true } : i)),
        };
      }
    }
    return { ...next, renderVersion: next.renderVersion + 1 };
  }
  return next;
}

/** The room each panel may take, the one table the drag and the
 * restored layout both clamp through. */
function panelSizeBounds(s: State): Record<keyof typeof DEFAULT_PANEL_SIZES, [number, number]> {
  return {
    library: [180, 420],
    right: [260, 540],
    graphViewer: [220, 720],
    ribbon: ribbonBounds(s.prefs),
    rightSplit: [120, 900],
    selectionSplit: [120, 700],
    // Down to three rows and up to most of a tall panel. The floor is a
    // height, not a row count, so a deep tree still scrolls rather than
    // vanishing.
    libraryTree: [66, 900],
  };
}

/** The panels fitted into the window's room (layoutfit.ts), or null
 * when the room is unknown and the saved layout is drawn as it is.
 * `pinned` overrides the state's pins, for asking what the fit would do
 * without them. */
export function layoutFitOf(s: State, pinned: readonly FoldablePanel[] = s.layoutPinned): LayoutFit | null {
  const room = s.layoutRoom;
  if (!room) return null;
  const b = panelSizeBounds(s);
  return fitLayout({
    width: room.width,
    zoom: room.zoom,
    mode: s.mode,
    ribbonExpanded: s.ribbonExpanded,
    browserOpen: s.browserOpen,
    ribbonOpen: s.ribbonOpen,
    exportOpen: s.exportOpen,
    rightDocked:
      s.mode === "canvas"
        ? s.canvasInspectorOpen && s.inspectorHome === "main"
        : s.mode === "advanced"
          ? s.inspectorHome === "main"
          : true,
    sizes: { library: s.panelSizes.library, ribbon: s.panelSizes.ribbon, right: s.panelSizes.right },
    bounds: { library: b.library, ribbon: b.ribbon, right: b.right },
    pinned,
  });
}

/** Whether a fold panel is on screen: open in the saved layout and not
 * folded by the fit. What a tour or a menu check should read. */
export function panelShown(s: State, panel: FoldablePanel): boolean {
  const fit = layoutFitOf(s);
  if (fit) return fit[panel];
  return panel === "library" ? s.browserOpen : panel === "export" ? s.exportOpen : s.ribbonOpen;
}

/** A fold panel's toggle as the user sees it: a panel the fit folded
 * looks closed, so its toggle opens it, by pinning it, rather than
 * shutting a panel that was never visibly open. Opening one on a window
 * too small for it pins it too, so the fit does not fold it straight
 * back. Closing one unpins it. */
function toggleFoldPanel(s: State, panel: FoldablePanel, open: boolean, set: (s: State, open: boolean) => State): State {
  const unpinned = s.layoutPinned.filter((p) => p !== panel);
  const fit = layoutFitOf(s);
  const shown = fit ? fit[panel] : open;
  if (shown) return { ...set(s, false), layoutPinned: unpinned };
  const opened = set(s, true);
  const after = layoutFitOf({ ...opened, layoutPinned: unpinned });
  const pin = after !== null && !after[panel];
  return { ...opened, layoutPinned: pin ? [...unpinned, panel] : unpinned };
}

function clampPanelSize(s: State, panel: keyof typeof DEFAULT_PANEL_SIZES, size: number): number {
  const [lo, hi] = panelSizeBounds(s)[panel];
  return Math.min(hi, Math.max(lo, Math.round(size)));
}

const MODE_IDS: readonly Mode[] = ["simple", "advanced", "canvas"];

function reduceInner(s: State, cmd: Command): State {
  // A layer tool only exists once you use it, so give the write below a
  // real node to land on before anything else runs.
  s = materializeLayerTool(s, cmd);
  s = materializeMainTool(s, cmd);
  const inner = insideGroup(s, cmd);
  if (inner) return inner;
  const withUndo = (next: Partial<State>): State => {
    if (!UNDOABLE.has(cmd.type)) return { ...s, ...next };
    // Every undoable command changes what the picture looks like, so the
    // sharp ROI slice rendered from the old picture is stale the moment one
    // runs. The patch overlay already knew this rule for slider gestures
    // ("old sharp pixels over new soft ones reads as the edit not working")
    // but strokes and every other one-shot edit kept the stale slice on
    // screen until a fresh render happened to land. "the stroke
    // flashes invisible for a split second and reappears... if I am zoomed
    // out, brush a stroke, and zoom in then the stroke disappears for a
    // good second" -- that was the pre-stroke patch covering the
    // post-stroke base. The soft-but-current base carries the view until a
    // fresh slice arrives.
    let key = gestureKey(cmd);
    // The mask and grade halves of a sampled band are one sweep.
    const setPick = s.gesture?.match(/^cset(\d+)\.pick$/);
    if (setPick && ((cmd.type === "set_params" && cmd.id === `cset${setPick[1]}_mask` &&
        Object.keys(cmd.values).every((k) => k === "band_center" || k === "hue_range")) ||
        (cmd.type === "set_param" && cmd.id === `cset${setPick[1]}_grade` && cmd.param === "band_center"))) {
      key = s.gesture;
    }
    // A section's Reset is one undo step however many nodes it writes:
    // Color's resets its rows, the black and white mix and the film on
    // the Tone Profile, and each write carries its own key, so without
    // this every write pushed a step and one undo took back only the last.
    if (s.gesture === "reset-color" && key !== null) key = s.gesture;
    const interruptedPick = s.gestureOwner !== undefined && key !== s.gesture;
    if (key && s.gesture === key && s.gesturePushed) {
      // Mid-gesture: mutate freely, history already holds the pre-gesture
      // snapshot for this control.
      return { ...s, ...next, view: { ...s.view, roiPatch: null }, redoStack: [] };
    }
    const pushed = key !== null && s.gesture === key;
    return {
      ...s,
      ...next,
      view: { ...s.view, roiPatch: null },
      undoStack: [...s.undoStack, { ...snapshot(s, describe(cmd, s)), ...(OWN_PHOTO_STEPS.has(cmd.type) ? { ownPhoto: true as const } : {}) }].slice(
        -HISTORY_LIMIT,
      ),
      redoStack: [],
      gesturePushed: pushed ? true : s.gesturePushed,
      // A typed edit can arrive without begin_gesture. It must break an
      // async sweep rather than inherit its pending answers and undo.
      ...(interruptedPick ? { gesture: null, gestureOwner: undefined, gesturePushed: false } : {}),
    };
  };

  switch (cmd.type) {
    case "set_mode":
      // Quad edit only exists where the adjustment panels are; leaving
      // simple mode folds it up (and its members back into the stash).
      if (cmd.mode !== "simple" && s.quadEdit) {
        s = reduceInner(s, { type: "close_quad_edit" });
      }
      return { ...s, mode: cmd.mode };
    case "toggle_browser":
      return toggleFoldPanel(s, "library", s.browserOpen, (t, open) => ({ ...t, browserOpen: open }));
    case "toggle_ribbon":
      return toggleFoldPanel(s, "ribbon", s.ribbonOpen, (t, open) => ({ ...t, ribbonOpen: open }));
    case "select_image": {
      if (cmd.id === s.activeImage) return s;
      // Walking off to another photo ends the quad session; the members'
      // graphs are folded back into the stash first, nothing lost.
      if (s.quadEdit) s = reduceInner(s, { type: "close_quad_edit" });
      // Stash the outgoing image's graph and history; restore the incoming
      // image's, or start it from the default template.
      const graphs: Record<string, GraphSnapshot> = {
        ...s.graphs,
        [s.activeImage]: {
          nodes: s.nodes,
          wires: s.wires,
          backdrops: s.backdrops,
          undoStack: s.undoStack,
          redoStack: s.redoStack,
          overrides: s.linkOverrides,
          // A first read still in flight means what we stash here is the
          // template, not the photo's saved graph; mark it so a quick
          // return keeps holding the pump instead of flashing the
          // unedited look.
          preRead: s.graphLoading === s.activeImage ? true : undefined,
        },
      };
      const incoming: GraphSnapshot = graphs[cmd.id] ?? {
        nodes: freshNodesFor(s, cmd.id),
        wires: structuredClone(s.defaultGraph.wires),
        backdrops: [],
        undoStack: [],
        redoStack: [],
      };
      const { overrides: incomingOverrides, ...incomingGraph } = incoming;
      return {
        ...s,
        ...incomingGraph,
        linkOverrides: incomingOverrides ?? [],
        graphs,
        activeImage: cmd.id,
        // A photo seen this session renders from its stash at once; a
        // first visit waits for the disk read rather than rendering
        // the template. A stash flagged preRead is the template too,
        // so it holds the same way.
        graphLoading: graphs[cmd.id] && !graphs[cmd.id].preRead ? null : cmd.id,
        selection: [],
        // Picking a single photo collapses any multi-selection: a stale
        // one would silently make Photo actions act on the wrong set.
        imageSelection: [cmd.id],
        activeLayer: null,
        view: { ...s.view, zoomScale: 1, pan: { x: 0, y: 0 }, viewRotation: 0, roiPatch: null },
        // An armed curve eyedropper belongs to the photo it was armed
        // on; sampling a different photo into it would be a surprise,
        // and so would the previous photo's sharp patch.
        ...PICKER_RESET,
        zoneHover: null,
        csetMaskView: null,
        // Another photo's takes are other graphs entirely; a compare
        // source pointing into them would be a lie or a crash.
        compareTake: null,
        // A probe points into one photo's graph; the next photo's graph
        // is a different circuit. The armed zone picker follows the
        // same rule.
        probeNode: null,
        keyLightSel: null,
        gesture: null,
        gesturePushed: false,
        artActive: null,
        artSelected: [],
        artGradientEdit: null,
        // Handles are picked on one photograph's grid.
        gridWarp: { ...s.gridWarp, selected: [], live: null },
        shapeWarp: { ...s.shapeWarp, selected: null },
        // The tools start the new photograph at their defaults, the
        // cursor in hand.
        ...TOOL_SESSION_DEFAULTS,
      };
    }
    case "begin_session_load":
      // Desktop boot and catalog switches: drop the session on screen so
      // the incoming catalog does not flash the outgoing one's images.
      return {
        ...s,
        images: [],
        graphs: {},
        takes: {},
        activeTakes: {},
        activeImage: "",
        imageSelection: [],
        libraryLabel: "Loading…",
        selection: [],
        activeLayer: null,
        undoStack: [],
        redoStack: [],
        // The tree and folder go too, and not only visually: the session
        // saver keys off them, and keeping the old catalog's paths here
        // is how they ended up written into the newly opened catalog.
        folderTree: null,
        activeFolderPath: null,
      };
    // A stack or a panorama carries highlights well past scene white,
    // and the display transform clips there. Without a shoulder the sky
    // comes back blown however well the merge recovered it, which is the
    // complaint that started stacking in the first place. This is a real
    // param on a real node, so it shows in Develop and in Graph, and
    // setting it to zero gets the raw radiance back.
    case "toggle_export":
      return toggleFoldPanel(s, "export", s.exportOpen, (t, open) => ({ ...t, exportOpen: open }));
    // The export queue: batch groups are view-level workflow state, not
    // edits to any photograph, so none of this touches the undo stack.
    case "export_queue_add": {
      const q = s.exportQueue;
      const g = q.groups[q.active];
      // Dedupe against the group, keep the order the ids arrived in:
      // a photo queued twice is one export, not two overwrites. The
      // photo's own record is captured NOW, from the view it was added
      // from, so leaving that view later cannot orphan the queue.
      const have = new Set(g.queued.map((p) => p.id));
      const fresh: QueuedPhoto[] = cmd.ids
        .filter((id) => !have.has(id))
        .map((id) => {
          const entry = s.images.find((i) => i.id === id);
          return {
            id,
            name: entry?.name ?? id,
            stars: entry?.stars ?? 0,
            flag: entry?.flag ?? "",
          };
        });
      if (!fresh.length) return s;
      const groups = q.groups.map((x, i) =>
        i === q.active ? { ...x, queued: [...x.queued, ...fresh] } : x
      );
      return { ...s, exportQueue: { ...q, groups } };
    }
    case "export_queue_remove": {
      const q = s.exportQueue;
      const groups = q.groups.map((x, i) =>
        i === q.active ? { ...x, queued: x.queued.filter((p) => p.id !== cmd.id) } : x
      );
      return { ...s, exportQueue: { ...q, groups } };
    }
    case "export_queue_move": {
      const q = s.exportQueue;
      const g = q.groups[q.active];
      const { from, to } = cmd;
      if (from < 0 || from >= g.queued.length || to < 0 || to >= g.queued.length) return s;
      const queued = [...g.queued];
      const [moved] = queued.splice(from, 1);
      queued.splice(to, 0, moved);
      const groups = q.groups.map((x, i) => (i === q.active ? { ...x, queued } : x));
      return { ...s, exportQueue: { ...q, groups } };
    }
    case "export_group_new": {
      const q = s.exportQueue;
      const groups = [...q.groups, freshExportGroup(q.groups, s.prefs)];
      return { ...s, exportQueue: { groups, active: groups.length - 1 } };
    }
    case "export_group_remove": {
      const q = s.exportQueue;
      // A queue with nowhere to queue is a broken panel, so deleting the
      // only tab is starting over: a brand-new batch takes its place, not
      // the old tab with its photos shaken out. "I should be
      // able to delete the first batch which just creates a new batch tab."
      if (q.groups.length <= 1) {
        return { ...s, exportQueue: { groups: [freshExportGroup([], s.prefs)], active: 0 } };
      }
      const groups = q.groups.filter((_, i) => i !== cmd.index);
      return {
        ...s,
        exportQueue: { groups, active: Math.min(q.active, groups.length - 1) },
      };
    }
    case "export_group_rename": {
      const q = s.exportQueue;
      const name = cmd.name.trim();
      if (!name) return s;
      const groups = q.groups.map((x, i) => (i === cmd.index ? { ...x, name } : x));
      return { ...s, exportQueue: { ...q, groups } };
    }
    case "export_group_select": {
      const q = s.exportQueue;
      const active = Math.min(Math.max(0, cmd.index), q.groups.length - 1);
      return { ...s, exportQueue: { ...q, active } };
    }
    case "export_group_settings": {
      const q = s.exportQueue;
      const groups = q.groups.map((x, i) =>
        i === q.active ? { ...x, settings: { ...x.settings, ...cmd.settings } } : x
      );
      return { ...s, exportQueue: { ...q, groups } };
    }
    case "toggle_serve_live":
      return { ...s, serveLive: !s.serveLive };
    case "set_tag_filter":
      return { ...s, tagFilter: cmd.filter };
    case "set_expanded_view":
      return { ...s, expandedView: cmd.view };
    case "open_compare": {
      // At least two, or there is nothing to compare; order comes from
      // the caller, which passes the selection in view order.
      if (cmd.ids.length < 2) return s;
      return { ...s, catalogCompare: { ids: cmd.ids, start: 0 } };
    }
    case "close_compare":
      return { ...s, catalogCompare: null };
    case "compare_step": {
      if (!s.catalogCompare) return s;
      const max = Math.max(0, s.catalogCompare.ids.length - 4);
      const start = Math.min(max, Math.max(0, s.catalogCompare.start + cmd.by));
      return { ...s, catalogCompare: { ...s.catalogCompare, start } };
    }
    case "copy_edits": {
      // The live graph IS the active photo's edits; snapshot it whole.
      // Deep-cloned, so keeping on editing after copying does not edit
      // the clipboard as well.
      if (!s.activeImage) return s;
      return {
        ...s,
        editClipboard: {
          nodes: structuredClone(s.nodes),
          wires: structuredClone(s.wires),
          backdrops: structuredClone(s.backdrops),
          sourceId: s.activeImage,
          sourceName: s.images.find((i) => i.id === s.activeImage)?.name ?? "",
        },
      };
    }
    case "set_edit_clipboard":
      // The async path: a right-clicked photo that is not the active one
      // has its graph read from disk first, then landed here.
      return { ...s, editClipboard: cmd.clipboard };
    case "paste_edits": {
      // Paste onto the ACTIVE photo: an undoable graph replacement, so a
      // paste that flattened an hour of work is one Ctrl+Z from back.
      // Other targets never pass through here; their graphs are written
      // to disk by pasteEditsTo without touching the live one.
      const clip = s.editClipboard;
      if (!clip) return s;
      return withUndo({
        ...pasteGraphKeepingWarp(clip, s, cropSourceAspect(s)),
        backdrops: structuredClone(clip.backdrops),
        images: s.images.map((i) =>
          i.id === s.activeImage ? { ...i, edited: true } : i,
        ),
      });
    }
    case "mark_edited":
      return {
        ...s,
        images: s.images.map((i) =>
          i.id === cmd.id ? { ...i, edited: true } : i,
        ),
      };
    case "open_quad_edit": {
      // Two to four, first one drives, and only where the adjustment
      // panels are: Graph mode edits one graph honestly and would make
      // a lie of the mirroring.
      if (cmd.ids.length < 2 || cmd.ids.length > 4) return s;
      if (s.mode !== "simple") return s;
      const ids = cmd.ids.slice(0, 4);
      const driver = ids[0];
      const quadGraphs: State["quadGraphs"] = {};
      for (const id of ids) {
        if (id === driver) continue; // the live graph is the driver's
        const g =
          cmd.graphs[id] ??
          s.graphs[id] ?? {
            nodes: freshNodesFor(s, id),
            wires: structuredClone(s.defaultGraph.wires),
            backdrops: [],
          };
        quadGraphs[id] = {
          nodes: structuredClone(g.nodes),
          wires: structuredClone(g.wires),
          backdrops: structuredClone(g.backdrops ?? []),
        };
      }
      return {
        ...s,
        quadEdit: { ids, driver, pinned: [] },
        quadGraphs,
        imageSelection: ids,
        // A tool armed against one photo has no business dragging
        // across four.
        tool: "none",
      };
    }
    case "close_quad_edit": {
      if (!s.quadEdit) return s;
      // The members' edited graphs go back into the per-image stash, so
      // clicking onto one of them right after shows what quad did to it.
      const graphs = { ...s.graphs };
      for (const [id, g] of Object.entries(s.quadGraphs)) {
        graphs[id] = {
          nodes: g.nodes,
          wires: g.wires,
          backdrops: g.backdrops,
          undoStack: [],
          redoStack: [],
        };
      }
      return { ...s, quadEdit: null, quadGraphs: {}, graphs };
    }
    case "quad_toggle_pin": {
      const q = s.quadEdit;
      // The driver cannot be pinned out of its own edits.
      if (!q || cmd.id === q.driver || !q.ids.includes(cmd.id)) return s;
      const pinned = q.pinned.includes(cmd.id)
        ? q.pinned.filter((p) => p !== cmd.id)
        : [...q.pinned, cmd.id];
      return { ...s, quadEdit: { ...q, pinned } };
    }
    case "quad_anchor": {
      const q = s.quadEdit;
      if (!q || cmd.id === q.driver || !q.ids.includes(cmd.id)) return s;
      const incoming = s.quadGraphs[cmd.id];
      if (!incoming) return s;
      // Swap: the old driver's live graph parks in quadGraphs, the new
      // driver's graph becomes live. Undo history belongs to the graph
      // it was recorded against, so it does not cross the swap.
      const quadGraphs = { ...s.quadGraphs };
      delete quadGraphs[cmd.id];
      quadGraphs[q.driver] = {
        nodes: s.nodes,
        wires: s.wires,
        backdrops: s.backdrops,
      };
      return {
        ...s,
        nodes: incoming.nodes,
        wires: incoming.wires,
        backdrops: incoming.backdrops,
        undoStack: [],
        redoStack: [],
        activeImage: cmd.id,
        quadEdit: { ...q, driver: cmd.id },
        quadGraphs,
      };
    }
    case "export_group_folder": {
      const q = s.exportQueue;
      const groups = q.groups.map((x, i) =>
        i === q.active ? { ...x, folder: cmd.folder } : x
      );
      return { ...s, exportQueue: { ...q, groups } };
    }
    case "export_queue_load": {
      // From the settings blob at launch. Validated the same way every
      // persisted blob is: a damaged one yields the default, never a
      // broken panel.
      const q = cmd.queue;
      if (!q?.groups?.length) return s;
      const groups = q.groups.map((g, i) => {
        // Blobs saved before the queue carried records held bare id
        // strings; they load as records with the id standing in for
        // the name, better than losing the queue.
        const legacy = (g as { imageIds?: unknown }).imageIds;
        const raw: unknown[] = Array.isArray(g.queued)
          ? g.queued
          : Array.isArray(legacy)
            ? legacy
            : [];
        const queued: QueuedPhoto[] = raw.map((p) => {
          if (typeof p === "string") return { id: p, name: p, stars: 0, flag: "" };
          const o = p as Partial<QueuedPhoto>;
          return {
            id: String(o.id ?? ""),
            name: String(o.name ?? o.id ?? ""),
            stars: Number(o.stars ?? 0),
            flag: o.flag === "pick" || o.flag === "reject" ? o.flag : "",
          };
        });
        return {
          id: String(g.id ?? `bg_load_${i}`),
          name: String(g.name ?? "Batch"),
          queued,
          settings: { ...DEFAULT_EXPORT_SETTINGS, ...(g.settings ?? {}) },
          folder: typeof g.folder === "string" ? g.folder : null,
        };
      });
      return {
        ...s,
        exportQueue: { groups, active: Math.min(Math.max(0, q.active ?? 0), groups.length - 1) },
      };
    }
    case "apply_merged_defaults": {
      const profile = s.nodes.find((n) => n.type === "heeler.tone_profile");
      // Zero and the shipped default both read as "nobody chose this";
      // anything else is a value someone set, and it stays.
      const rolloff = Number(profile?.params.highlight_rolloff ?? 0);
      if (!profile || (rolloff !== 0 && rolloff !== PROFILE_DEFAULTS.highlight_rolloff)) return s;
      return {
        ...s,
        nodes: s.nodes.map((n) =>
          n.id === profile.id
            ? {
                ...n,
                params: { ...n.params, highlight_rolloff: MERGED_ROLLOFF },
              }
            : n,
        ),
      };
    }
    case "convert_legacy_fits": {
      let touched = false;
      const nodes = s.nodes.map((n) => {
        if (n.type !== "heeler.color_checker" || !n.textParams?.fit) return n;
        let fit: FitOrderFields;
        try {
          fit = JSON.parse(n.textParams.fit) as FitOrderFields;
        } catch {
          return n;
        }
        if (!fitNeedsOrderFix(fit)) return n;
        const keys = ["m00", "m01", "m02", "m10", "m11", "m12", "m20", "m21", "m22"];
        const old = keys.map((k) => Number(n.params[k] ?? (k[1] === k[2] ? 1 : 0)));
        const converted = convertLegacyFit(old, fit);
        touched = true;
        return {
          ...n,
          params: { ...n.params, ...Object.fromEntries(keys.map((k, i) => [k, converted.matrix[i]])) },
          textParams: { ...n.textParams, fit: JSON.stringify(converted.fit) },
        };
      });
      return touched ? { ...s, nodes } : s;
    }
    case "apply_rendered_bypass": {
      // The saved-graph half of the rendered-source rule (see
      // needsRenderedBypass): the loader proved the profile untouched
      // and the source rendered; the switch flips off, silently like
      // its sibling migrations - a default nobody chose is not an
      // edit to protect with an undo entry.
      const profile = s.nodes.find((n) => n.type === "heeler.tone_profile");
      if (!profile) return s;
      return {
        ...s,
        nodes: s.nodes.map((n) =>
          n.id === profile.id ? { ...n, enabled: false } : n,
        ),
      };
    }
    case "apply_profile_defaults": {
      const profile = s.nodes.find((n) => n.type === "heeler.tone_profile");
      // baseline_ev present means this graph already lived through the
      // upgrade (or was made after it); nothing to do either way.
      if (!profile || profile.params.baseline_ev !== undefined) return s;
      return {
        ...s,
        nodes: s.nodes.map((n) =>
          n.id === profile.id
            ? {
                ...n,
                params: {
                  ...n.params,
                  baseline_ev: PROFILE_DEFAULTS.baseline_ev,
                  shadow_toe: PROFILE_DEFAULTS.shadow_toe,
                  // Never lowered: a merge that already carries its big
                  // shoulder keeps it.
                  highlight_rolloff: Math.max(
                    Number(n.params.highlight_rolloff ?? 0),
                    PROFILE_DEFAULTS.highlight_rolloff,
                  ),
                },
              }
            : n,
        ),
      };
    }
    case "art_add_layer": {
      // First layer creates the group: to_display feeding to_scene,
      // spliced after curves. The stack is off-by-default in the truest
      // sense: no group node exists until someone reaches for a layer.
      let nodes = s.nodes;
      let wires = s.wires;
      if (!nodes.some((n) => n.id === ART_ID)) {
        const anchor = nodes.find((n) => n.id === "output");
        nodes = [
          ...nodes,
          {
            id: ART_ID,
            type: "heeler.group",
            name: "Finish",
            cat: "color",
            x: (anchor?.x ?? 1200) - NODE_W - 60,
            y: (anchor?.y ?? 96) + 150,
            enabled: true,
            params: {},
            isGroup: true,
            hasIn: true,
            hasOut: true,
            groupNodes: [
              { id: "art_in", type: "heeler.to_display", name: "To Display", cat: "color", x: 24, y: 96, enabled: true, params: {}, hasIn: true, hasOut: true },
              { id: "art_out", type: "heeler.to_scene", name: "To Scene", cat: "color", x: 324, y: 96, enabled: true, params: {}, hasIn: true, hasOut: true },
            ],
            groupWires: [{ from: "art_in", to: "art_out", toPort: "in", kind: "image" }],
          },
        ];
        wires = spliceIn(wires, ART_ID);
      }
      const base = { ...s, nodes, wires };
      const n =
        1 +
        artLayers(base).reduce(
          (m, l) => Math.max(m, Number(l.blend.id.replace("art_b", "")) || 0),
          0,
        );
      const kind = ART_KINDS[cmd.kind] ?? ART_KINDS.paint;
      const content: NodeCard = {
        id: `art_p${n}`,
        type: kind.type,
        // The paintable half says so: the layer makes TWO nodes, and two
        // cards both called "Pixel 1" left the graph unreadable.
        // "I have two nodes called 'Pixel 1'. That's odd." The blend keeps
        // the layer's clean name (the stack reads it); the strokes' node
        // wears Paint after it.
        name: kind.type === "heeler.paint" ? `${kind.label} ${n} Paint` : `${kind.label} ${n}`,
        cat: "color",
        x: 24 + n * 40,
        y: 220,
        enabled: true,
        params: { ...kind.params },
        textParams: { ...kind.text },
        artKind: cmd.kind,
        hasIn: true,
        hasOut: true,
      };
      const blend: NodeCard = {
        id: `art_b${n}`,
        type: "heeler.blend",
        name: `${kind.label} ${n}`,
        cat: "color",
        x: 24 + n * 40,
        y: 340,
        enabled: true,
        params: { opacity: 100 },
        textParams: { mode: kind.mode ?? "normal", ...(kind.place ? { fit: "place" } : {}) },
        hasIn: true,
        hasOut: true,
      };
      const next = withArtLayers(base, (ls) => [...ls, { blend, content, fx: [], exported: false }]);
      return withUndo({ nodes: next.nodes, wires, artActive: blend.id, maskView: false, depthView: false });
    }
    case "art_add_file_layers": {
      // "Layers from File..." (26.3 Phase 7 import): one image layer per
      // chosen entry, top of stack, Normal, 100%. One undo entry for
      // the whole import, the fill-from-selection pattern: each inner
      // reduce pushes the state from before any of it, so undoing once
      // undoes every layer the picker made.
      let next = s;
      for (const item of cmd.items) {
        const added = reduce(next, { type: "art_add_layer", kind: "image" });
        const id = added.artActive;
        const made = artLayers(added).find((l) => l.blend.id === id);
        if (!id || !made) continue;
        // The kind's empty placeholders become the real reference, and
        // both nodes wear the entry's name, the way a paint layer's
        // pair is named.
        const withPath =
          updateArtNodeDeep(added, made.content.id, (n) => ({
            ...n,
            name: item.name,
            textParams: { ...n.textParams, path: cmd.path, layer: item.layer },
          })) ?? added;
        next =
          updateArtNodeDeep(withPath, made.blend.id, (n) => ({
            ...n,
            name: item.name,
            params: { ...n.params, ...placedParams(item.box ?? null, frameAspectFor(s.activeImage)) },
          })) ?? withPath;
      }
      return withUndo({ nodes: next.nodes, wires: next.wires, artActive: next.artActive });
    }
    case "art_add_image_layer": {
      if (!editStillCurrent(s, cmd.expected)) return s;
      // One layer, the fill-from-selection undo pattern as above.
      const kind = cmd.source.kind === "catalog" ? "catalog_image" : "image";
      const added = reduce(s, { type: "art_add_layer", kind });
      const id = added.artActive;
      const made = artLayers(added).find((l) => l.blend.id === id);
      if (!id || !made) return s;
      let next =
        updateArtNodeDeep(added, made.content.id, (n) => ({
          ...n,
          name: cmd.name,
          textParams: { ...n.textParams, ...imageSourceText(cmd.source) },
        })) ?? added;
      next =
        updateArtNodeDeep(next, made.blend.id, (n) => ({
          ...n,
          name: cmd.name,
          params: { ...n.params, ...placedParams(cmd.box, frameAspectFor(s.activeImage)) },
        })) ?? next;
      return withUndo({ nodes: next.nodes, wires: next.wires, artActive: next.artActive });
    }
    case "art_layer_via_copy": {
      if (!editStillCurrent(s, cmd.expected)) return s;
      // New Layer via Copy (2026-09-30: "to be able to marquee select part of the
      // background picture and copy that to a new pixel layer", then "the layer via
      // copy means that layer would have to be like an image layer and have its own
      // warp effect on the layer"). An image layer, so it moves, turns, skews and
      // bends with Transform and its own Warp the way an image layer does: the
      // desktop cut the pixels (bake_layer_copy) and the layer reads them placed on
      // the rectangle they came from, so the picture looks the same until the copy
      // is moved. `anchor: scene` keeps the copy on the scene through a later crop
      // (framemap.ts), where a picture brought in from a file keeps its place on the
      // frame. The selection stays, as a layer editor leaves it: the hole the copy
      // leaves is still selected for the clone and heal strokes that fill it.
      if (!cmd.path || !(cmd.box.w > 0) || !(cmd.box.h > 0)) return s;
      const added = reduce(s, { type: "art_add_layer", kind: "image" });
      const made = artLayers(added).find((l) => l.blend.id === added.artActive);
      if (!made) return s;
      let next =
        updateArtNodeDeep(added, made.content.id, (n) => ({
          ...n,
          name: cmd.name,
          textParams: { ...n.textParams, path: cmd.path, layer: "", origin: "copy" },
        })) ?? added;
      next =
        updateArtNodeDeep(next, made.blend.id, (n) => ({
          ...n,
          name: cmd.name,
          params: { ...n.params, ...placedParams(cmd.box, cmd.aspect) },
          textParams: { ...n.textParams, anchor: "scene" },
        })) ?? next;
      // Directly above the layer it was copied over: art_add_layer put it
      // on top, and the stack's order is the layer list's.
      if (cmd.above) {
        const above = cmd.above;
        next =
          withArtLayers(next, (ls) => {
            const mine = ls.find((l) => l.blend.id === made.blend.id);
            const rest = ls.filter((l) => l.blend.id !== made.blend.id);
            const at = rest.findIndex((l) => l.blend.id === above);
            return mine && at >= 0 ? [...rest.slice(0, at + 1), mine, ...rest.slice(at + 1)] : ls;
          }) ?? next;
      }
      return withUndo({
        nodes: next.nodes,
        wires: next.wires,
        artActive: made.blend.id,
        artSelected: [made.blend.id],
      });
    }
    case "art_bake_warp": {
      if (!editStillCurrent(s, cmd.expected)) return s;
      // Bake Warp (2026-09-30: "a bake option on the warp layer that bakes warping
      // effect down to a pixel layer. I think both the [layer editor] way and a way
      // to commit/bake a warp could be useful"). The desktop rendered what the Warp
      // layer shows (bake_warp_layer): the warped pixels through its effects, the
      // warped mask as alpha. The layer keeps its carrier, so its seat in the stack
      // or group, name, mode, opacity and clipping stay; its content becomes an
      // image layer reading the file, placed on the rectangle it covers and kept on
      // the scene through a later crop (anchor, as Layer via Copy's), so the
      // picture is unchanged until something below it is. The mask and effects are
      // in the pixels now and go. An image layer, so Transform and its own Warp
      // move and bend it again.
      const found = bakeableWarp(s, cmd.id);
      if (!found || !cmd.path || !(cmd.box.w > 0) || !(cmd.box.h > 0)) return s;
      const kind = ART_KINDS.image;
      const old = found.content;
      // The Warp layer as it is, kept on the picture node for Unbake:
      // copies, so nothing the bake drops is shared with what it keeps.
      const wasMask = artMaskOf(s, cmd.id);
      const bakedFrom: BakedWarp = structuredClone({
        carrier: found.carrier,
        content: old,
        fx: artLayerFx(s, cmd.id),
        ...(wasMask ? { mask: wasMask } : {}),
      });
      const content: NodeCard = {
        id: old.id,
        type: kind.type,
        name: found.carrier.name,
        cat: old.cat,
        x: old.x,
        y: old.y,
        enabled: true,
        params: { ...kind.params },
        textParams: { ...kind.text, path: cmd.path, layer: "", origin: "bake" },
        artKind: "image",
        hasIn: true,
        hasOut: true,
        bakedFrom,
      };
      // A Transform the Warp layer carried is in the pixels too: the
      // placement starts over on the rectangle the bake covers.
      const kept = Object.fromEntries(Object.entries(found.carrier.params).filter(([k]) => !k.startsWith("warp_") && k !== "place_pad"));
      const carrier: NodeCard = {
        ...found.carrier,
        params: { ...kept, ...placedParams(cmd.box, cmd.aspect) },
        textParams: { ...found.carrier.textParams, fit: "place", anchor: "scene" },
      };
      let next: State | null = found.groupId
        ? withGroupMembers(s, found.groupId, (ms) => ms.map((m) => (m.merge.id === cmd.id ? { merge: carrier, content, fx: [] } : m)))
        : withArtLayers(s, (ls) => ls.map((l) => (l.blend.id === cmd.id ? { ...l, blend: carrier, content, fx: [] } : l)));
      if (!next) return s;
      if (artMaskOf(next, cmd.id)) next = reduce(next, { type: "art_remove_mask", id: cmd.id });
      // Its warp's tool goes down with the warp.
      const editing = warpEditing(s, old.id);
      return withUndo({
        nodes: next.nodes,
        wires: next.wires,
        selection: next.selection,
        tool: editing ? "none" : next.tool,
        warpTarget: editing ? null : s.warpTarget,
        artActive: cmd.id,
        artSelected: [cmd.id],
      });
    }
    case "art_unbake_warp": {
      // Unbake (2026-10-01: "go ahead with 1 and 2", 2 being "keep the warp's
      // settings on the baked layer so it can be unbaked"). The layer Bake
      // Warp made goes back to the live Warp layer its picture node kept, in
      // its own seat in the stack or its group: the warp, its effects and its
      // mask as they were baked. What the baked layer still offered and may
      // have changed since (its name, mode, opacity, clipping, visibility)
      // stays as it is now, the newer word; its placement and own warp go
      // with the picture. The live warp bends whatever is below it now. One
      // undo step.
      const found = unbakeableWarp(s, cmd.id);
      if (!found) return s;
      const b = found.baked;
      const now = found.carrier;
      const params: Record<string, number> = { ...b.carrier.params };
      for (const k of ["opacity", "clip"]) {
        if (k in now.params) params[k] = now.params[k];
        else delete params[k];
      }
      const textParams: Record<string, string> = { ...(b.carrier.textParams ?? {}) };
      if (now.textParams && "mode" in now.textParams) textParams.mode = now.textParams.mode;
      else delete textParams.mode;
      const carrier: NodeCard = {
        ...structuredClone(b.carrier),
        id: now.id,
        name: now.name,
        enabled: now.enabled,
        params,
        ...(b.carrier.textParams || now.textParams?.mode !== undefined ? { textParams } : {}),
      };
      const content = structuredClone(b.content);
      const fx = structuredClone(b.fx);
      const swap = (m: { merge: NodeCard; content: NodeCard; fx: NodeCard[] }) => (m.merge.id === cmd.id ? { merge: carrier, content, fx } : m);
      let next: State | null = found.groupId
        ? withGroupMembers(s, found.groupId, (ms) => ms.map(swap))
        : withArtLayers(s, (ls) => ls.map((l) => (l.blend.id === cmd.id ? { ...l, blend: carrier, content, fx } : l)));
      if (!next) return s;
      // The Warp layer's own mask comes back. A mask the baked layer was
      // given after the bake gives way to it; with none kept, a mask the
      // baked layer has stays, gating the warp as it gated the picture.
      if (b.mask) {
        // The reducer's own steps, unmirrored: the linked photographs
        // hear the whole unbake once, from the outer reduce.
        if (artMaskOf(next, cmd.id)) next = reduceInner(next, { type: "art_remove_mask", id: cmd.id });
        next = reduceInner(next, { type: "art_add_mask", id: cmd.id });
        const placed = artMaskOf(next, cmd.id);
        if (placed) {
          // Under the id it had (a layer grouped after its mask was made
          // keeps its first carrier's mask id), when nothing else took it.
          const was = b.mask.id;
          const free = was === placed.id || !next.nodes.some((n) => n.id === was);
          const mid = free ? was : placed.id;
          const mask = { ...structuredClone(b.mask), id: mid };
          const hop = (w: Wire): Wire => (w.from === placed.id ? { ...w, from: mid } : w.to === placed.id ? { ...w, to: mid } : w);
          next = {
            ...next,
            nodes: next.nodes.map((n) =>
              n.id === placed.id
                ? mask
                : n.id === ART_ID
                  ? {
                      ...n,
                      groupBoundary: n.groupBoundary?.map(hop),
                      groupNodes: n.groupNodes?.map((g) => (g.id === found.groupId ? { ...g, groupBoundary: g.groupBoundary?.map(hop) } : g)),
                    }
                  : n,
            ),
            wires: next.wires.map(hop),
          };
        }
      }
      // A tool armed at the picture's own warp goes down with it.
      const editing = artLayerFx(s, cmd.id).some((f) => warpEditing(s, f.id));
      return withUndo({
        nodes: next.nodes,
        wires: next.wires,
        selection: next.selection,
        tool: editing ? "none" : s.tool,
        warpTarget: editing ? null : s.warpTarget,
        artActive: cmd.id,
        artSelected: [cmd.id],
      });
    }
    case "art_duplicate_layer": {
      // A top-level layer copied just above itself (2026-09-30: image
      // layers are "a normal Finish layer ... duplicate", and no Finish
      // layer could be duplicated yet). The blend, the content and the
      // effects are cloned under fresh ids, so the copy carries the
      // mode, opacity, clip, placement and the content's own strokes,
      // color or picture reference; its mask is cloned onto the copy's
      // own boundary hop. No file is copied: an image layer's copy reads
      // the same picture. Not the Export tick: that is a choice about
      // the original.
      const layers = artLayers(s);
      const at = layers.findIndex((l) => l.blend.id === cmd.id);
      const src = layers[at];
      if (!src || src.content.isGroup) return s;
      const taken = new Set<string>();
      const visit = (list: NodeCard[]) =>
        list.forEach((n) => {
          taken.add(n.id);
          if (n.groupNodes) visit(n.groupNodes);
        });
      visit(s.nodes);
      let k = 1 + layers.reduce((m, l) => Math.max(m, Number(l.blend.id.replace("art_b", "")) || 0), 0);
      while (taken.has(`art_b${k}`) || taken.has(`art_p${k}`)) k++;
      const blendId = `art_b${k}`;
      const contentId = `art_p${k}`;
      const blend: NodeCard = { ...structuredClone(src.blend), id: blendId, name: `${src.blend.name} copy`, x: src.blend.x + 40 };
      const content: NodeCard = {
        ...structuredClone(src.content),
        id: contentId,
        name: `${src.content.name} copy`,
        x: src.content.x + 40,
      };
      const fx = src.fx.map((f, i) => ({ ...structuredClone(f), id: `${contentId}_fx${i + 1}`, x: f.x + 40 }));
      let next = withArtLayers(s, (ls) => [
        ...ls.slice(0, at + 1),
        { blend, content, fx, exported: false },
        ...ls.slice(at + 1),
      ]);
      let wires = s.wires;
      const mask = artMaskOf(s, cmd.id);
      if (mask) {
        const mid = `art_m_${blendId}`;
        const copy: NodeCard = { ...structuredClone(mask), id: mid, y: mask.y + 40 };
        next = {
          ...next,
          nodes: [
            ...next.nodes.map((n) =>
              n.id === ART_ID
                ? { ...n, groupBoundary: [...(n.groupBoundary ?? []), { from: mid, to: blendId, toPort: "mask" as const, kind: "mask" as const }] }
                : n,
            ),
            copy,
          ],
        };
        // Whatever fed the original mask feeds the copy; the copy feeds
        // the art group's mask port as the original does.
        wires = [
          ...wires,
          ...wires.filter((w) => w.to === mask.id).map((w) => ({ ...w, to: mid })),
          ...wires.filter((w) => w.from === mask.id && w.to === ART_ID).map((w) => ({ ...w, from: mid })),
        ];
      }
      return withUndo({ nodes: next.nodes, wires, artActive: blendId, artSelected: [blendId] });
    }
    case "art_image_source": {
      if (!editStillCurrent(s, cmd.expected)) return s;
      const found = artFindLayer(s, cmd.id);
      if (!found) return s;
      // Another picture is no longer New Layer via Copy's pixels.
      let next = updateArtNodeDeep(s, found.content.id, (n) => ({
        ...n,
        textParams: { ...n.textParams, ...imageSourceText(cmd.source), ...(n.textParams?.origin ? { origin: "" } : {}) },
      }));
      if (!next) return s;
      const box = cmd.box;
      if (box) {
        // The placement carried across: the new rest box through the map
        // that took the old one to the corners, so another shape of
        // picture sits where this one was, turned and sized alike, and
        // keeps its own proportions.
        const h = solveHomography(cornersOf(layerBox(s, cmd.id)), layerQuad(s, cmd.id) as Pt[]);
        const corners = h ? cornersOf(box).map((p) => mapPoint(h, p)) : cornersOf(box);
        next =
          updateArtNodeDeep(next, cmd.id, (n) => ({ ...n, params: { ...n.params, ...quadParams(box, corners, frameAspectFor(s.activeImage)) } })) ?? next;
      }
      return withUndo({
        nodes: next.nodes,
        images: s.images.map((i) => (i.id === s.activeImage ? { ...i, edited: true } : i)),
      });
    }
    case "art_remove_layer": {
      const found = artFindLayer(s, cmd.id);
      if (!found) return s;
      let next: State;
      let wires = s.wires;
      if (found.groupId) {
        // A member leaves its group: drop it from the merge chain and
        // rebuild the group's innards.
        const gid = found.groupId;
        next =
          updateArtNodeDeep(s, gid, (g) => {
            const members = artGroupMembers(g).filter((m) => m.merge.id !== cmd.id);
            const canvas = g.groupNodes!.find((n) => n.id.endsWith("_c"))!;
            return {
              ...g,
              // The member's effects go with it; the survivors keep
              // theirs, which is what the fx list in the wiring is for.
              groupNodes: [canvas, ...members.flatMap((m) => [m.content, ...m.fx, m.merge])],
              groupWires: artGroupWires(
                canvas.id,
                members.map((m) => ({
                  merge: m.merge.id,
                  content: m.content.id,
                  fx: m.fx.map((f) => f.id),
                })),
              ),
              // The member's mask goes with it too: hop 2 leaves this
              // group's boundary.
              groupBoundary: (g.groupBoundary ?? []).filter(
                (w) => w.from !== artMaskOf(s, cmd.id)?.id,
              ),
            };
          }) ?? s;
        // And hop 1 leaves the art group's boundary, the node leaves the
        // graph and its wires go, exactly the cleanup a top-level masked
        // layer gets below.
        const mask = artMaskOf(s, cmd.id);
        if (mask) {
          next = {
            ...next,
            nodes: next.nodes
              .filter((n) => n.id !== mask.id)
              .map((n) =>
                n.id === ART_ID
                  ? {
                      ...n,
                      groupBoundary: (n.groupBoundary ?? []).filter(
                        (w) => w.from !== mask.id,
                      ),
                    }
                  : n,
              ),
          };
          wires = s.wires.filter((w) => w.from !== mask.id && w.to !== mask.id);
        }
      } else {
        next = withArtLayers(s, (ls) => ls.filter((l) => l.blend.id !== cmd.id));
        // A masked layer takes its mask with it, or the mask node would
        // sit orphaned in the graph feeding nothing.
        const mask = artMaskOf(s, cmd.id);
        if (mask) {
          next = {
            ...next,
            nodes: next.nodes
              .filter((n) => n.id !== mask.id)
              .map((n) =>
                n.id === ART_ID
                  ? {
                      ...n,
                      groupBoundary: (n.groupBoundary ?? []).filter(
                        (w) => !(w.from === mask.id && w.to === cmd.id),
                      ),
                    }
                  : n,
              ),
          };
          wires = s.wires.filter((w) => w.from !== mask.id && w.to !== mask.id);
        }
      }
      // A chain-spliced removal SOURCED from this layer's mask goes with
      // the layer, the same rule develop layers already follow. The owner
      // made exactly this shape tonight (removeObjectSource can pick an art
      // mask); without the cascade the removal outlived the mask that
      // defined it, ownerless. Top level or member, the mask is already
      // gone from `next` by here.
      const deadMask = artMaskOf(s, cmd.id);
      if (deadMask) {
        const dependents = next.nodes.filter(
          (nd) =>
            nd.type === "heeler.inpaint" &&
            nd.id.startsWith("inpaint_") &&
            (nd.textParams?.source === deadMask.id || nd.id === `inpaint_${deadMask.id}`),
        );
        if (dependents.length) {
          const dead = new Set(dependents.map((d) => d.id));
          for (const d of dependents) {
            const hole = d.id.replace(/^inpaint_/, "inpaint_m_");
            if (next.nodes.some((nd) => nd.id === hole)) dead.add(hole);
          }
          // Two removals from one mask sit ADJACENT in the chain, so a
          // heal must walk upstream through dead nodes to the first
          // live feed, not just look one hop back.
          const liveFrom = (wire: Wire | undefined): Wire | undefined => {
            let cur = wire;
            const seen = new Set<string>();
            while (cur && dead.has(cur.from) && !seen.has(cur.from)) {
              seen.add(cur.from);
              cur = wires.find((w) => w.to === cur!.from && w.toPort === "in");
            }
            return cur;
          };
          const heals: Wire[] = [];
          for (const d of dependents) {
            const dout = wires.find((w) => w.from === d.id && w.kind === "image" && !dead.has(w.to));
            const feed = liveFrom(wires.find((w) => w.to === d.id && w.toPort === "in"));
            if (dout && feed) {
              heals.push({ ...wireSource(feed), to: dout.to, toPort: dout.toPort, kind: "image" });
            }
          }
          next = { ...next, nodes: next.nodes.filter((nd) => !dead.has(nd.id)) };
          wires = [...wires.filter((w) => !dead.has(w.from) && !dead.has(w.to)), ...heals];
        }
      }
      return withUndo({
        nodes: next.nodes,
        wires,
        artActive: s.artActive === cmd.id ? null : s.artActive,
        artSelected: s.artSelected.filter((id) => id !== cmd.id),
        artGradientEdit: s.artGradientEdit === cmd.id ? null : s.artGradientEdit,
        // The mask view goes with the layer it was showing.
        maskView: s.artActive === cmd.id ? false : s.maskView,
      });
    }
    case "art_move_layer": {
      const ls = artLayers(s);
      const i = ls.findIndex((l) => l.blend.id === cmd.id);
      const j = i + cmd.delta;
      if (i < 0 || j < 0 || j >= ls.length) return s;
      const next = withArtLayers(s, (list) => {
        const copy = [...list];
        [copy[i], copy[j]] = [copy[j], copy[i]];
        return copy;
      });
      return withUndo({ nodes: next.nodes });
    }
    case "art_layer_set": {
      const found = artFindLayer(s, cmd.id);
      if (!found) return s;
      // Mode lands on whatever carries the layer, which since
      // 2026-08-27 is a blend inside a group as well as at the top
      // level. A group made before that still chains merges, and a
      // merge has no mode to write, so the guard stays.
      let next = updateArtNodeDeep(s, cmd.id, (n) => ({
        ...n,
        ...(cmd.name !== undefined ? { name: cmd.name } : {}),
        ...(cmd.enabled !== undefined ? { enabled: cmd.enabled } : {}),
        params:
          cmd.opacity !== undefined
            ? { ...n.params, opacity: Math.min(100, Math.max(0, cmd.opacity)) }
            : n.params,
        textParams:
          cmd.mode !== undefined && n.type === "heeler.blend"
            ? { ...n.textParams, mode: cmd.mode }
            : n.textParams,
      }));
      if (!next) return s;
      // A rename carries to the paintable half, suffix and all, so the
      // graph's two cards keep telling each other apart after the
      // layer stops being called "Pixel 1".
      if (cmd.name !== undefined && found.content.type === "heeler.paint") {
        next =
          updateArtNodeDeep(next, found.content.id, (n) => ({
            ...n,
            name: `${cmd.name} Paint`,
          })) ?? next;
      }
      // A rename follows to the layer's Export Layer node while one
      // exists (26.3 Phase 8): the checkbox names the node after the
      // layer, and the layer changing its name must not strand it.
      if (cmd.name !== undefined) {
        next =
          updateArtNodeDeep(next, `art_x_${cmd.id}`, (n) => ({
            ...n,
            name: exportCardName(cmd.name!),
          })) ?? next;
        next =
          updateArtNodeDeep(next, `art_xm_${cmd.id}`, (n) => ({
            ...n,
            name: maskExportCardName(cmd.name!),
          })) ?? next;
      }
      return withUndo({
        nodes: next.nodes,
        images: s.images.map((i2) =>
          i2.id === s.activeImage ? { ...i2, edited: true } : i2,
        ),
      });
    }
    case "art_set_export": {
      // The Finish tab's Export checkbox (26.3 Phase 8). The node taps
      // the layer's CONTENT, before its blend: what the file gets is the
      // layer's own picture, and the desktop folds the blend's opacity
      // and mask into the written alpha at export time.
      const layer = artLayers(s).find((l) => l.blend.id === cmd.id);
      if (!layer) return s;
      // An adjustment layer changes what is below it and has no picture
      // of its own, so there is nothing to tap.
      if (ART_KINDS[layer.content.artKind ?? ""]?.adjust) return s;
      const g = artGroup(s);
      if (!g) return s;
      const exId = `art_x_${cmd.id}`;
      const has = (g.groupNodes ?? []).some((n) => n.id === exId);
      if (cmd.on === has) return s;
      const edited = s.images.map((i2) =>
        i2.id === s.activeImage ? { ...i2, edited: true } : i2,
      );
      if (cmd.on) {
        // `source` says which Finish layer owns this node; `name`
        // stays unset so the bridge fold keeps the written layer
        // named after the card, which the rename hook keeps in step.
        const node = exportLayerCard(exId, exportCardName(layer.blend.name), 624, 96, { source: `finish:${cmd.id}` });
        return withUndo({
          nodes: s.nodes.map((n) =>
            n.id === ART_ID
              ? {
                  ...n,
                  groupNodes: [...(n.groupNodes ?? []), node],
                  groupWires: [
                    ...(n.groupWires ?? []),
                    { from: layer.content.id, to: exId, toPort: "in", kind: "image" as const },
                  ],
                }
              : n,
          ),
          images: edited,
        });
      }
      // Untick: the node and every wire that touches it go away.
      return withUndo({
        nodes: s.nodes.map((n) =>
          n.id === ART_ID
            ? {
                ...n,
                groupNodes: (n.groupNodes ?? []).filter((x) => x.id !== exId),
                groupWires: (n.groupWires ?? []).filter((w) => w.from !== exId && w.to !== exId),
              }
            : n,
        ),
        images: edited,
      });
    }
    case "art_set_mask_export": {
      // The mask's Export checkbox (2026-09-30). Any top-level layer: what
      // is written is the weight its blend applies (the desktop's
      // finishmask fold), which a layer with no mask still has, its opacity
      // everywhere. The wire from the content is the Graph's picture of
      // where the node hangs, as the layer checkbox's is; part "alpha" so
      // the card reads as a gray.
      const layer = artLayers(s).find((l) => l.blend.id === cmd.id);
      if (!layer) return s;
      const g = artGroup(s);
      if (!g) return s;
      const exId = `art_xm_${cmd.id}`;
      const has = (g.groupNodes ?? []).some((n) => n.id === exId);
      if (cmd.on === has) return s;
      const edited = s.images.map((i2) =>
        i2.id === s.activeImage ? { ...i2, edited: true } : i2,
      );
      return withUndo({
        nodes: s.nodes.map((n) =>
          n.id !== ART_ID
            ? n
            : cmd.on
              ? {
                  ...n,
                  groupNodes: [
                    ...(n.groupNodes ?? []),
                    exportLayerCard(exId, maskExportCardName(layer.blend.name), 624, 156, {
                      source: `finishmask:${cmd.id}`,
                      part: "alpha",
                    }),
                  ],
                  groupWires: [
                    ...(n.groupWires ?? []),
                    { from: layer.content.id, to: exId, toPort: "in", kind: "image" as const },
                  ],
                }
              : {
                  ...n,
                  groupNodes: (n.groupNodes ?? []).filter((x) => x.id !== exId),
                  groupWires: (n.groupWires ?? []).filter((w) => w.from !== exId && w.to !== exId),
                },
        ),
        images: edited,
      });
    }
    case "set_layer_mask_export": {
      // A Develop adjustment layer's Export Mask as Layer (2026-10-01). What
      // is written is the weight the layer's adjustments are applied through,
      // read by the desktop off the layer's own node (the layermask fold):
      // the mask, Depth mask and all, times the Opacity. The wire from the
      // mask is the Graph's picture of where the node hangs, as the Finish
      // mask card's wire from the content is; part "alpha" so the card reads
      // as a gray.
      const layer = layersOf(s).find((l) => l.id === cmd.id);
      if (!layer) return s;
      const exId = layerMaskExportId(cmd.id);
      const has = s.nodes.some((n) => n.id === exId);
      if (cmd.on === has) return s;
      const edited = s.images.map((i2) =>
        i2.id === s.activeImage ? { ...i2, edited: true } : i2,
      );
      if (!cmd.on) {
        return withUndo({
          nodes: s.nodes.filter((n) => n.id !== exId),
          wires: s.wires.filter((w) => w.from !== exId && w.to !== exId),
          images: edited,
        });
      }
      const mask = s.nodes.find((n) => n.id === layer.maskId);
      const adj = s.nodes.find((n) => n.id === cmd.id)!;
      // Under the mask's card, stepping down past any card already
      // there, so the new one never lands on top of another.
      const x = (mask ?? adj).x + 40;
      let y = (mask ?? adj).y + NODE_H + 48;
      while (s.nodes.some((n) => Math.abs(n.x - x) < NODE_W + 12 && Math.abs(n.y - y) < NODE_H + 12)) y += NODE_H + 24;
      const node = exportLayerCard(exId, maskExportCardName(layer.name), x, y, {
        source: `layermask:${cmd.id}`,
        part: "alpha",
      });
      return withUndo({
        nodes: [...s.nodes, node],
        wires: mask
          ? [...s.wires, { from: mask.id, to: exId, toPort: "mask", kind: "mask" as const }]
          : s.wires,
        images: edited,
      });
    }
    case "set_section_export": {
      // A Develop section's Export checkbox (2026-09-30: "I would like to
      // add the same toggle to Adjustment sections. Even Depth Map"). The
      // panel names the tap (sectionExportTap); the reducer only checks it
      // is a node on the top-level graph.
      //
      // On a Develop layer (`layer`, 2026-10-03: the owner,
      // "adjustment layer sections do not have the option to enable
      // the export layer") the tap is the layer's own copy of the
      // section, so the layer writes the picture as that section
      // leaves it on that layer. A copy the layer has not made yet is
      // brought in first, switched off, the way a Base section's tick
      // builds its nodes: one undo step for both, and the picture does
      // not change.
      const exId = sectionExportId(cmd.title, cmd.layer);
      const has = s.nodes.some((n) => n.id === exId);
      if (cmd.on === has) return s;
      const edited = s.images.map((i2) =>
        i2.id === s.activeImage ? { ...i2, edited: true } : i2,
      );
      if (!cmd.on) {
        return withUndo({
          nodes: s.nodes.filter((n) => n.id !== exId),
          wires: s.wires.filter((w) => w.from !== exId && w.to !== exId),
          images: edited,
        });
      }
      const layer = cmd.layer ? layersOf(s).find((l) => l.id === cmd.layer) : undefined;
      if (cmd.layer && (!layer || !cmd.tap.startsWith(layerGroupPrefix(cmd.layer)))) return s;
      let graph: Pick<State, "nodes" | "wires"> = s;
      if (layer && !s.nodes.some((n) => n.id === cmd.tap)) {
        const made = materializeLayerTool(s, { type: "set_enabled", id: cmd.tap, enabled: false });
        if (made === s) return s;
        graph = { nodes: made.nodes.map((n) => (n.id === cmd.tap ? { ...n, enabled: false } : n)), wires: made.wires };
      }
      const tap = graph.nodes.find((n) => n.id === cmd.tap);
      if (!tap) return s;
      if (cmd.depth && tap.type !== "heeler.depth_map") return s;
      const off = new Set(cmd.off ?? []);
      const nodes = off.size ? graph.nodes.map((n) => (off.has(n.id) ? { ...n, enabled: false } : n)) : graph.nodes;
      // Under the tapped card, stepping down past any card already
      // there, so the new one never lands on top of another.
      let y = tap.y + NODE_H + 48;
      const x = tap.x + 40;
      while (graph.nodes.some((n) => Math.abs(n.x - x) < NODE_W + 12 && Math.abs(n.y - y) < NODE_H + 12)) y += NODE_H + 24;
      const node = exportLayerCard(exId, exportCardName(sectionExportWhat(cmd.title, layer?.name)), x, y, {
        source: `develop:${cmd.title}`,
        tap: tap.id,
        ...(layer ? { layer: layer.id } : {}),
      });
      // The depth plane rides the field pair (a depth-fed layer, EXR's
      // mist.Z), the picture the image pair.
      const wire: Wire = cmd.depth
        ? { from: tap.id, fromPort: "depth", to: exId, toPort: "mask", kind: "mask" }
        : { from: tap.id, to: exId, toPort: "in", kind: "image" };
      return withUndo({
        nodes: [...nodes, node],
        wires: [...graph.wires, wire],
        images: edited,
      });
    }
    case "art_add_stroke": {
      const found = artFindLayer(s, cmd.id);
      if (!found) return s;
      const next = updateArtNodeDeep(s, found.content.id, (n) => ({
        ...n,
        strokes: [...(n.strokes ?? []), cmd.stroke],
      }));
      if (!next) return s;
      // The selection the stroke was made under, carried ON the stroke.
      //
      // This used to wire the live selection into the layer as a
      // stencil, which was wrong in both directions: clearing the
      // selection erased every stroke ever painted inside one, and a
      // layer that had once been painted inside a selection could never
      // be painted freely again. "I should always be able
      // to paint on a layer without a selection... When I deselect all
      // the paint strokes that were restricted within the selection are
      // still visible."
      //
      // Baked, but baked as GEOMETRY, so it still re-renders at any
      // size and follows a re-develop. What is frozen is which shape
      // the stroke was made under, which is a fact about the past and
      // ought to be frozen.
      const doc = s.nodes.find((n) => n.id === DOC_SEL_ID);
      const live = doc && (doc.regions ?? []).length > 0 ? JSON.stringify(doc.regions) : undefined;
      const clipped = live
        ? {
            nodes: (updateArtNodeDeep(next, found.content.id, (n) => ({
              ...n,
              strokes: (n.strokes ?? []).map((k, i) =>
                i === (n.strokes ?? []).length - 1 ? ({ ...k, clip: live } as never) : k,
              ),
            })) ?? next).nodes,
            wires: next.wires,
          }
        : { nodes: next.nodes, wires: next.wires };
      return withUndo({
        nodes: clipped.nodes,
        wires: clipped.wires,
        images: s.images.map((i2) =>
          i2.id === s.activeImage ? { ...i2, edited: true } : i2,
        ),
      });
    }
    // Mid-drag growth of the stroke art_add_stroke opened. Points only:
    // the clip, the tip and the color were settled at mousedown and a
    // drag must not renegotiate them.
    case "art_update_stroke": {
      const found = artFindLayer(s, cmd.id);
      if (!found) return s;
      const next = updateArtNodeDeep(s, found.content.id, (n) => {
        const strokes = n.strokes ?? [];
        if (!strokes.length) return n;
        const last = strokes[strokes.length - 1];
        return { ...n, strokes: [...strokes.slice(0, -1), { ...last, points: cmd.points }] };
      });
      if (!next) return s;
      return withUndo({ nodes: next.nodes });
    }
    case "art_group_layers": {
      if (!canGroupLayers(s, cmd.ids)) return s;
      const ls = artLayers(s);
      const idx = cmd.ids
        .map((id) => ls.findIndex((l) => l.blend.id === id))
        .sort((a, b) => a - b);
      const n = artNextId(s);
      const gid = `art_g${n}`;
      // A masked layer's mask was boundary-wired to its top-level
      // blend, which this command replaces with the member carrier. The
      // first hop retargets at the group, and the group's own boundary
      // picks up the second hop to the carrier, exactly the shape
      // art_add_mask records for a member.
      const masked = idx
        .map((i, k) => ({ k, mask: artMaskOf(s, ls[i].blend.id) }))
        .filter((m): m is { k: number; mask: NodeCard } => !!m.mask);
      const canvas: NodeCard = {
        id: `${gid}_c`,
        type: "heeler.paint",
        name: "Canvas",
        cat: "color",
        x: 24,
        y: 96,
        enabled: true,
        params: {},
        strokes: [],
        hasIn: true,
        hasOut: true,
      };
      const members = idx.map((i, k) => ({
        merge: {
          id: `${gid}_m${k + 1}`,
          // A blend, not a merge: the carrier is what gives a member a
          // mask port, a blend mode and a clip port, and at mode
          // "normal" it composites exactly as the merge did.
          type: MEMBER_CARRIER,
          name: ls[i].blend.name,
          cat: "color",
          x: 24 + (k + 1) * 40,
          y: 220,
          enabled: ls[i].blend.enabled,
          // The layer's Transform comes along (found by the flips,
          // 2026-10-01): a grouped image layer lost its placement and
          // filled the frame, and a moved layer snapped back.
          params: { opacity: ls[i].blend.params.opacity ?? 100, clip: ls[i].blend.params.clip ?? 0, ...placementParams(ls[i].blend).params },
          textParams: { mode: ls[i].blend.textParams?.mode ?? "normal", ...placementParams(ls[i].blend).text },
          hasIn: true,
          hasOut: true,
        } as NodeCard,
        content: ls[i].content,
        // The layer's effects come along. They used to be dropped on
        // the floor: groupNodes took the content and the merge and
        // nothing else, so grouping a layer with an effect on it threw
        // the effect away without saying so.
        fx: ls[i].fx ?? [],
      }));
      const groupNode: NodeCard = {
        id: gid,
        type: "heeler.group",
        name: `Group ${n}`,
        cat: "color",
        x: 24,
        y: 340,
        enabled: true,
        params: {},
        isGroup: true,
        hasIn: true,
        hasOut: true,
        groupNodes: [canvas, ...members.flatMap((m) => [m.content, ...m.fx, m.merge])],
        groupWires: artGroupWires(
          canvas.id,
          members.map((m) => ({
            merge: m.merge.id,
            content: m.content.id,
            fx: m.fx.map((f) => f.id),
          })),
        ),
        // Second hops of the masked members' masks: into this group as
        // far as each member's new carrier.
        ...(masked.length
          ? {
              groupBoundary: masked.map((m) => ({
                from: m.mask.id,
                to: `${gid}_m${m.k + 1}`,
                toPort: "mask" as const,
                kind: "mask" as const,
              })),
            }
          : {}),
      };
      const blend: NodeCard = {
        id: `art_b${n}`,
        type: "heeler.blend",
        name: `Group ${n}`,
        cat: "color",
        x: 24,
        y: 460,
        enabled: true,
        params: { opacity: 100 },
        textParams: { mode: "normal" },
        hasIn: true,
        hasOut: true,
      };
      const next = withArtLayers(s, (list) => {
        const out = [...list];
        out.splice(idx[0], idx.length, { blend, content: groupNode, fx: [], exported: false });
        return out;
      });
      // A ticked layer's Export Layer node went with its blend in that
      // rebuild; the user hears about it rather than finding out from
      // the exported file.
      const notice = exportTickDropNotice(idx.map((i) => ls[i]).filter((l) => l.exported || l.maskExported));
      // Retarget each masked layer's first boundary hop at the group:
      // the blend it pointed at no longer exists.
      const rewired = masked.length
        ? {
            ...next,
            nodes: next.nodes.map((nd) =>
              nd.id === ART_ID
                ? {
                    ...nd,
                    groupBoundary: (nd.groupBoundary ?? []).map((w) =>
                      masked.some((m) => m.mask.id === w.from) && w.toPort === "mask"
                        ? { ...w, to: gid }
                        : w,
                    ),
                  }
                : nd,
            ),
          }
        : next;
      return withUndo({ nodes: rewired.nodes, artActive: blend.id, artSelected: [blend.id], ...(notice ? { notice } : {}) });
    }
    case "art_add_to_group": {
      // "I also don't see a way to add pixel layer to existing
      // group." One layer joins one group, and it joins at the top of it,
      // which is where a layer dropped onto a group lands everywhere else.
      const ls = artLayers(s);
      const layer = ls.find((l) => l.blend.id === cmd.id);
      const group = ls.find((l) => l.blend.id === cmd.groupId);
      if (!layer || !group?.content.isGroup || layer.content.isGroup) return s;
      // A masked layer joins too: its mask crosses a second boundary
      // from here on, retargeted below.
      const mask = artMaskOf(s, cmd.id);
      const carrier: NodeCard = {
        ...layer.blend,
        type: MEMBER_CARRIER,
        params: { ...layer.blend.params, clip: 0 },
      };
      const withMember = withGroupMembers(s, group.content.id, (members) => [
        ...members,
        { merge: carrier, content: layer.content, fx: layer.fx ?? [] },
      ]);
      if (!withMember) return s;
      let next = withArtLayers(withMember, (list) =>
        list.filter((l) => l.blend.id !== cmd.id),
      );
      if (mask) {
        // Hop 1 now lands on the stack group; hop 2 is recorded on the
        // group's own boundary and reaches the carrier, which kept the
        // layer's blend id on the way in.
        next = {
          ...next,
          nodes: next.nodes.map((nd) =>
            nd.id === ART_ID
              ? {
                  ...nd,
                  groupBoundary: (nd.groupBoundary ?? []).map((w) =>
                    w.from === mask.id && w.toPort === "mask"
                      ? { ...w, to: group.content.id }
                      : w,
                  ),
                  groupNodes: (nd.groupNodes ?? []).map((g) =>
                    g.id === group.content.id
                      ? {
                          ...g,
                          groupBoundary: [
                            ...(g.groupBoundary ?? []),
                            { from: mask.id, to: cmd.id, toPort: "mask", kind: "mask" } as Wire,
                          ],
                        }
                      : g,
                  ),
                }
              : nd,
          ),
        };
      }
      // The same drop as art_group_layers: the layer's blend stops
      // being a top-level carrier, so its Export Layer node went away
      // in the rebuild above.
      const notice = exportTickDropNotice(layer.exported || layer.maskExported ? [layer] : []);
      return withUndo({ nodes: next.nodes, artActive: carrier.id, artSelected: [carrier.id], ...(notice ? { notice } : {}) });
    }
    case "art_remove_from_group": {
      // The other direction: a member returns to the stack, directly
      // above the group it came out of.
      const found = artFindLayer(s, cmd.id);
      if (!found?.groupId) return s;
      const ls = artLayers(s);
      const groupAt = ls.findIndex((l) => l.content.id === found.groupId);
      if (groupAt < 0) return s;
      const member = artGroupMembers(ls[groupAt].content).find((m) => m.merge.id === cmd.id);
      if (!member) return s;
      const emptied = artGroupMembers(ls[groupAt].content).length === 1;
      const blend: NodeCard = {
        ...member.merge,
        type: "heeler.blend",
        params: { ...member.merge.params },
        textParams: { ...(member.merge.textParams ?? {}), mode: member.merge.textParams?.mode ?? "normal" },
      };
      const without = withGroupMembers(s, found.groupId, (members) =>
        members.filter((m) => m.merge.id !== cmd.id),
      );
      if (!without) return s;
      let next = withArtLayers(without, (list) => {
        const out = [...list];
        const at = out.findIndex((l) => l.content.id === found.groupId);
        if (at < 0) return out;
        // A group with nothing left in it is not a group; it goes with
        // its last member rather than sitting there empty.
        out.splice(at + 1, 0, { blend, content: member.content, fx: member.fx, exported: false });
        return emptied ? out.filter((l) => l.content.id !== found.groupId) : out;
      });
      // A masked member takes its mask with it: hop 1 points at the
      // carrier again (it keeps its id as the new top-level blend) and
      // hop 2 leaves the group's boundary. If the group went with its
      // last member the boundary went with it.
      const mask = artMaskOf(s, cmd.id);
      if (mask) {
        next = {
          ...next,
          nodes: next.nodes.map((nd) =>
            nd.id === ART_ID
              ? {
                  ...nd,
                  groupBoundary: (nd.groupBoundary ?? []).map((w) =>
                    w.from === mask.id && w.toPort === "mask" ? { ...w, to: cmd.id } : w,
                  ),
                  groupNodes: (nd.groupNodes ?? []).map((g) =>
                    g.id === found.groupId
                      ? {
                          ...g,
                          groupBoundary: (g.groupBoundary ?? []).filter(
                            (w) => w.from !== mask.id,
                          ),
                        }
                      : g,
                  ),
                }
              : nd,
          ),
        };
      }
      return withUndo({ nodes: next.nodes, artActive: blend.id, artSelected: [blend.id] });
    }
    case "art_move_member": {
      const found = artFindLayer(s, cmd.id);
      if (!found?.groupId) return s;
      const next = withGroupMembers(s, found.groupId, (members) => {
        const at = members.findIndex((m) => m.merge.id === cmd.id);
        // Up the stack is later in the render order, the same reading
        // the top-level arrows use.
        const to = at + (cmd.delta > 0 ? 1 : -1);
        if (at < 0 || to < 0 || to >= members.length) return members;
        const out = [...members];
        const [moved] = out.splice(at, 1);
        out.splice(to, 0, moved);
        return out;
      });
      if (!next) return s;
      return withUndo({ nodes: next.nodes });
    }
    case "art_ungroup": {
      const ls = artLayers(s);
      const at = ls.findIndex((l) => l.blend.id === cmd.id && l.content.isGroup);
      if (at < 0) return s;
      const members = artGroupMembers(ls[at].content);
      const base = artNextId(s);
      const replacements = members.map((m, k) => ({
        blend: {
          id: `art_b${base + k}`,
          type: "heeler.blend",
          name: m.merge.name,
          cat: "color",
          x: 24,
          y: 340,
          enabled: m.merge.enabled,
          params: { opacity: m.merge.params.opacity ?? 100, clip: m.merge.params.clip ?? 0, ...placementParams(m.merge).params },
          textParams: { mode: m.merge.textParams?.mode ?? "normal", ...placementParams(m.merge).text },
          hasIn: true,
          hasOut: true,
        } as NodeCard,
        content: m.content,
        fx: m.fx,
        exported: false,
      }));
      let next = withArtLayers(s, (list) => {
        const out = [...list];
        out.splice(at, 1, ...replacements);
        return out;
      });
      // A masked member keeps its mask: hop 1 pointed at the group,
      // which is gone, so retarget it at the member's new top-level
      // blend. Hop 2 lived on the group's own boundary and went with it.
      const memberMasks = members
        .map((m, k) => ({ mask: artMaskOf(s, m.merge.id), newId: `art_b${base + k}` }))
        .filter((x): x is { mask: NodeCard; newId: string } => !!x.mask);
      if (memberMasks.length) {
        const byMask = new Map(memberMasks.map((x) => [x.mask.id, x.newId]));
        // A node spliced into a member mask's wire inside the Finish
        // group (a Morphology) fed the layer group; it feeds the member's
        // new blend now, as the mask's own hop does.
        const art = artGroup(s);
        const groupId = ls[at].content.id;
        const spliced = (art?.groupWires ?? []).flatMap((w): Wire[] => {
          if (w.to !== groupId || w.toPort !== "mask" || !art) return [];
          const to = byMask.get(maskWireSource(art, w) ?? "");
          return to ? [{ ...w, to }] : [];
        });
        next = {
          ...next,
          nodes: next.nodes.map((nd) =>
            nd.id === ART_ID
              ? {
                  ...nd,
                  groupBoundary: (nd.groupBoundary ?? []).map((w) =>
                    byMask.has(w.from) && w.toPort === "mask"
                      ? { ...w, to: byMask.get(w.from)! }
                      : w,
                  ),
                  groupWires: [...(nd.groupWires ?? []), ...spliced],
                }
              : nd,
          ),
        };
      }
      // The group's own mask has no blend left to gate; it goes too.
      const mask = artMaskOf(s, cmd.id);
      let wires = s.wires;
      if (mask) {
        next = {
          ...next,
          nodes: next.nodes
            .filter((nd) => nd.id !== mask.id)
            .map((nd) =>
              nd.id === ART_ID
                ? {
                    ...nd,
                    groupBoundary: (nd.groupBoundary ?? []).filter(
                      (w) => !(w.from === mask.id && w.to === cmd.id),
                    ),
                  }
                : nd,
            ),
        };
        wires = s.wires.filter((w) => w.from !== mask.id && w.to !== mask.id);
      }
      return withUndo({
        nodes: next.nodes,
        wires,
        artActive: replacements[0]?.blend.id ?? null,
        artSelected: replacements.map((r) => r.blend.id),
      });
    }
    case "select_art_layers":
      return {
        ...s,
        artSelected: cmd.ids,
        artActive: cmd.ids[cmd.ids.length - 1] ?? null,
      };
    case "art_content_set": {
      const found = artFindLayer(s, cmd.id);
      if (!found) return s;
      const next = updateArtNodeDeep(s, found.content.id, (n) =>
        typeof cmd.value === "number"
          ? { ...n, params: { ...n.params, [cmd.param]: cmd.value } }
          : { ...n, textParams: { ...n.textParams, [cmd.param]: cmd.value } },
      );
      if (!next) return s;
      return withUndo({
        nodes: next.nodes,
        images: s.images.map((i2) =>
          i2.id === s.activeImage ? { ...i2, edited: true } : i2,
        ),
      });
    }
    case "art_set_quad": {
      // A placed picture's numbers are stamped with the frame shape they
      // were read and written on (the frame-shape rule, placedOnFrame):
      // the handles and fields worked on the quad carried onto this
      // frame, so this frame is what the corners are fractions of now.
      // Any other layer's quad follows its content, which is fractions
      // of whatever frame it lands on, so it carries no stamp.
      const placed = isPlacedLayer(s, cmd.id);
      const aspect = placed ? frameAspectFor(s.activeImage) : null;
      const next = updateArtNodeDeep(s, cmd.id, (n) => {
        const params = { ...n.params };
        params.warp_bx = cmd.box.x;
        params.warp_by = cmd.box.y;
        params.warp_bw = cmd.box.w;
        params.warp_bh = cmd.box.h;
        cmd.corners.forEach(([x, y], i) => {
          params[`warp_x${i}`] = x;
          params[`warp_y${i}`] = y;
        });
        if (aspect && aspect > 0) params.warp_aspect = aspect;
        return { ...n, params };
      });
      if (!next) return s;
      return withUndo({
        nodes: next.nodes,
        images: s.images.map((i) =>
          i.id === s.activeImage ? { ...i, edited: true } : i,
        ),
      });
    }
    case "flip_photo": {
      // Photo > Flip Horizontal and Flip Vertical (2026-10-01: "how hard is it to
      // have a "Flip Image" in the Photo menu?" and "In [the other editor], the
      // edits flip with the photo."). The flip is the crop node's, ahead of its
      // turn and its rectangle, so what sits on the photograph (a Smart click, the
      // depth model's input) stays where it is and the frame after the crop is the
      // old frame mirrored; followCrop then carries everything drawn on the frame
      // through that mirror in this same step (photoFlipExtras). A photograph with
      // no crop node yet gets one, as the crop tool's first drag builds it, in the
      // same undo step.
      if (photoFlipBlocked(s)) return s;
      let nodes = s.nodes;
      let wires = s.wires;
      if (!nodes.some((n) => n.type === "heeler.crop_rotate")) {
        const built = buildCategoryPiece(nodes, wires, CROP_PIECE);
        nodes = built.nodes;
        wires = built.wires;
      }
      const size = sourceSizeFor(s.activeImage);
      nodes = nodes.map((n) =>
        n.type === "heeler.crop_rotate" ? { ...n, params: flippedCropParams(n.params, cmd.axis, size) } : n,
      );
      return withUndo({
        nodes,
        wires,
        images: s.images.map((i) => (i.id === s.activeImage ? { ...i, edited: true } : i)),
      });
    }
    case "art_flip_layer": {
      const changed = flipLayerNodes(s, cmd.id, cmd.axis);
      if (!changed) return s;
      const swap = (list: NodeCard[]): NodeCard[] =>
        list.map((n) => {
          const hit = changed.get(n.id);
          if (hit) return hit;
          return n.isGroup && n.groupNodes ? { ...n, groupNodes: swap(n.groupNodes) } : n;
        });
      return withUndo({
        nodes: swap(s.nodes),
        images: s.images.map((i) => (i.id === s.activeImage ? { ...i, edited: true } : i)),
      });
    }
    case "art_add_fx": {
      const found = artFindLayer(s, cmd.id);
      const spec = ART_FX[cmd.fx];
      if (!found || !spec) return s;
      // Inside a group now as well as at the top level: the wiring is
      // the same shape either way (content, then each effect, then the
      // carrier's second input), and artGroupWires builds it.
      const member = found.groupId
        ? artGroupMembers(
            artLayers(s).find((l) => l.content.id === found.groupId)!.content,
          ).find((m) => m.merge.id === cmd.id)
        : undefined;
      const layer = found.groupId
        ? member && { blend: member.merge, content: member.content, fx: member.fx }
        : artLayers(s).find((l) => l.blend.id === cmd.id);
      if (!layer) return s;
      const n = 1 + layer.fx.length + artNextId(s);
      const node: NodeCard = {
        id: `${found.content.id}_fx${n}`,
        type: spec.type,
        name: spec.label,
        cat: "detail",
        x: found.content.x,
        y: found.content.y + 90 + layer.fx.length * 40,
        enabled: true,
        params: { ...spec.params },
        textParams: { ...spec.text },
        artKind: cmd.fx,
        hasIn: true,
        hasOut: true,
      };
      const next = found.groupId
        ? withGroupMembers(s, found.groupId, (ms) =>
            ms.map((m) => (m.merge.id === cmd.id ? { ...m, fx: [...m.fx, node] } : m)),
          )
        : withArtLayers(s, (ls) =>
            ls.map((l) => (l.blend.id === cmd.id ? { ...l, fx: [...l.fx, node] } : l)),
          );
      if (!next) return s;
      return withUndo({ nodes: next.nodes });
    }
    case "art_layer_warp": {
      // An image layer's own warp (A, the owner 2026-09-30): a Finish warp
      // in the picture's space, FIRST on the layer's effect chain, so it
      // bends the picture before any effect reads its outline and before the
      // blend places it. Placed pictures only: a layer that is not placed
      // has no picture space of its own.
      const found = artFindLayer(s, cmd.id);
      if (!found || !isPlacedLayer(s, cmd.id)) return s;
      const had = imageLayerWarp(s, cmd.id);
      if (cmd.on === !!had) return s;
      const node = newLayerWarpNode(`${found.content.id}_warp`, "Warp", "picture", found.content.x, found.content.y + 60);
      const change = (fx: NodeCard[]) => (cmd.on ? [node, ...fx] : fx.filter((f) => !isPictureWarp(f)));
      const next = found.groupId
        ? withGroupMembers(s, found.groupId, (ms) => ms.map((m) => (m.merge.id === cmd.id ? { ...m, fx: change(m.fx) } : m)))
        : withArtLayers(s, (ls) => ls.map((l) => (l.blend.id === cmd.id ? { ...l, fx: change(l.fx) } : l)));
      if (!next) return s;
      // The tool put down when the warp it edits goes.
      const dropped = !cmd.on && had && s.warpTarget === had.id ? droppedGridWarpTool(s) : {};
      const done = withUndo({
        nodes: next.nodes,
        images: s.images.map((i) => (i.id === s.activeImage ? { ...i, edited: true } : i)),
        ...dropped,
      });
      // Added from the layer's Warp button: straight into edit mode, the
      // Type and the grid's tool up (tool state, not an undo step).
      return cmd.on && cmd.edit ? reduce(done, editWarpCommand(done, node.id)) : done;
    }
    case "art_warp_kind": {
      // One undo step; the other type's grid or shapes stay on the node,
      // not applied. In edit mode the tool follows the type, so the
      // gizmo on the canvas is always the one the render applies.
      const node = warpNodeById(s, cmd.id);
      if (!node || warpKindOf(node) === cmd.kind) return s;
      const set = (n: NodeCard): NodeCard => ({ ...n, textParams: { ...n.textParams, kind: cmd.kind } });
      const next = updateArtNodeDeep(s, cmd.id, set) ?? { ...s, nodes: s.nodes.map((n) => (n.id === cmd.id ? set(n) : n)) };
      const editing = warpEditing(s, cmd.id);
      const done = withUndo({
        nodes: next.nodes,
        images: s.images.map((i) => (i.id === s.activeImage ? { ...i, edited: true } : i)),
        // The type being left is committed: its tool goes down with its
        // snapshot, and the new type's tool comes up below.
        ...(editing ? droppedGridWarpTool(s) : {}),
      });
      return editing ? reduce(done, { type: "set_tool", tool: warpToolOf(cmd.kind), target: cmd.id }) : done;
    }
    case "art_warp_edit": {
      // Idempotent, unlike the tool's own toggle: an open that finds the
      // warp already in edit mode leaves it there, a close that finds it
      // put down does nothing (never arms it).
      if (warpEditing(s, cmd.id) === cmd.on) return s;
      if (!cmd.on) return reduceInner(s, editWarpCommand(s, cmd.id));
      if (!warpNodeById(s, cmd.id)) return s;
      return reduceInner(s, editWarpCommand(s, cmd.id));
    }
    case "art_remove_fx": {
      const inGroup = artFindLayer(s, cmd.id)?.groupId;
      const next = inGroup
        ? withGroupMembers(s, inGroup, (ms) =>
            ms.map((m) =>
              m.merge.id === cmd.id ? { ...m, fx: m.fx.filter((f) => f.id !== cmd.fxId) } : m,
            ),
          )
        : withArtLayers(s, (ls) =>
            ls.map((l) =>
              l.blend.id === cmd.id ? { ...l, fx: l.fx.filter((f) => f.id !== cmd.fxId) } : l,
            ),
          );
      if (!next) return s;
      return withUndo({ nodes: next.nodes });
    }
    case "art_fx_move": {
      const swap = (fx: NodeCard[]) => {
        const i = fx.findIndex((f) => f.id === cmd.fxId);
        const j = i + cmd.delta;
        if (i < 0 || j < 0 || j >= fx.length) return fx;
        if (isPictureWarp(fx[i]) || isPictureWarp(fx[j])) return fx;
        const out = [...fx];
        [out[i], out[j]] = [out[j], out[i]];
        return out;
      };
      const inGroup = artFindLayer(s, cmd.id)?.groupId;
      const next = inGroup
        ? withGroupMembers(s, inGroup, (ms) =>
            ms.map((m) => (m.merge.id === cmd.id ? { ...m, fx: swap(m.fx) } : m)),
          )
        : withArtLayers(s, (ls) =>
            ls.map((l) => (l.blend.id === cmd.id ? { ...l, fx: swap(l.fx) } : l)),
          );
      if (!next) return s;
      return withUndo({ nodes: next.nodes });
    }
    case "art_fx_enable": {
      // The effect's own visibility dot. It used to dispatch art_layer_set,
      // whose layer lookup rejected an fx node id and returned the state
      // unchanged - one more silently dead control. "I can't
      // turn off Layer FX by clicking the visibility (yellow dot)."
      const next = updateArtNodeDeep(s, cmd.fxId, (n) => ({ ...n, enabled: cmd.enabled }));
      if (!next) return s;
      return withUndo({
        nodes: next.nodes,
        images: s.images.map((i2) =>
          i2.id === s.activeImage ? { ...i2, edited: true } : i2,
        ),
      });
    }
    case "art_fx_set": {
      const next = updateArtNodeDeep(s, cmd.fxId, (n) =>
        typeof cmd.value === "number"
          ? { ...n, params: { ...n.params, [cmd.param]: cmd.value } }
          : { ...n, textParams: { ...n.textParams, [cmd.param]: cmd.value } },
      );
      if (!next) return s;
      return withUndo({
        nodes: next.nodes,
        images: s.images.map((i2) =>
          i2.id === s.activeImage ? { ...i2, edited: true } : i2,
        ),
      });
    }
    case "set_clone_source":
      // A fresh source un-locks the offset: the next stroke re-measures
      // from the new anchor, which is what ALT-clicking means.
      return { ...s, cloneSource: cmd.at, cloneOffset: null };
    case "set_clone_offset":
      return { ...s, cloneOffset: cmd.offset };
    case "set_dodge_strength":
      return { ...s, dodgeStrength: Math.min(100, Math.max(1, cmd.strength)) };
    // Fill the selection: a Fill layer wearing a copy of the selection
    // as its mask.
    //
    // Not pixels burned into the active layer. The color stays a
    // parameter and the selection stays geometry, so the fill can be
    // recolored, re-shaped or switched off tomorrow, which is the
    // bargain every other tool here makes. A copy rather than a
    // reference because the two part company the moment you edit
    // either: growing the selection to make another fill should not
    // silently reshape the fill you already made.
    case "art_fill_from_selection": {
      const src = s.nodes.find((n) => n.id === cmd.maskId);
      if (!src || src.type !== "heeler.selection_mask") return s;
      // One undo entry for the whole gesture: the inner reduces push
      // the state from before any of it, and the patch rides along.
      const added = reduce(s, { type: "art_add_layer", kind: "fill" });
      const id = added.artActive;
      if (!id) return s;
      const masked = reduce(added, { type: "art_add_mask", id, kind: "brush" });
      // The layer's content lives INSIDE the Finish group, so it is
      // reached through the group rather than found in the flat node
      // list. The mask does not: masks hang off the group's boundary.
      const content = artLayers(masked).find((l) => l.blend.id === id)?.content.id;
      const painted =
        (content
          ? updateArtNodeDeep(masked, content, (n) => ({
              ...n,
              textParams: { ...n.textParams, color: cmd.color },
            }))
          : null) ?? masked;
      // One undo entry for the whole gesture. The two inner reduces
      // each pushed their own, and undoing a fill twice to get rid of
      // it would be a bug people would report as "undo is broken".
      // The mask is the selection's coverage as pixels (2026-09-30: a
      // layer mask is always the paintable kind), and the selection is
      // spent on it.
      return withUndo({
        nodes: painted.nodes.map((n) =>
          n.id === `art_m_${id}`
            ? pixelMaskWearing(n, cmd.version, 1, undefined, selectionOutline(src))
            : n.id === src.id && src.id === DOC_SEL_ID
              ? selectionSpent(n)
              : n,
        ),
        wires: painted.wires,
        artActive: painted.artActive,
      });
    }
    case "art_remove_from_selection": {
      // Remove Object, Finish flavor. "I could see this as a
      // valid workflow if I was working in adjustments. 100%. But if I am
      // working in Finish tab, the results should end up in a Fill layer."
      // Same bones as the fill brush's layer (content is the model's fill of
      // the picture below, hole:"layer"), but the mask is a SNAPSHOT of the
      // selection rather than strokes: the runner bakes the source and
      // points matte_id at it, exactly like the chain-spliced removal's
      // hole. Delete the layer, the object comes back; the live selection
      // stays free. The hole is a pixel mask (2026-09-30), painted the fill
      // brush's way round: strokes add to the hole.
      const src = s.nodes.find((n) => n.id === cmd.maskId);
      if (!src || !src.type.endsWith("_mask")) return s;
      const added = reduce(s, { type: "art_add_layer", kind: "fix" });
      const id = added.artActive;
      if (!id) return s;
      const masked = reduce(added, { type: "art_add_mask", id, kind: "fill" });
      const content = artLayers(masked).find((l) => l.blend.id === id)?.content.id;
      let named = masked;
      for (const nid of [content, id]) {
        if (!nid) continue;
        named = updateArtNodeDeep(named, nid, (n) => ({ ...n, name: "Removed object" })) ?? named;
      }
      // One undo entry for the whole gesture, like its two cousins.
      return withUndo({
        nodes: named.nodes.map((n) =>
          n.id === `art_m_${id}`
            ? {
                ...n,
                params: { ...n.params, invert: 0, base_invert: 0 },
                textParams: { ...n.textParams, matte_id: "", source: cmd.maskId },
                strokes: [],
              }
            : n,
        ),
        wires: named.wires,
        artActive: named.artActive,
      });
    }
    case "art_layer_from_selection": {
      // Selection to layer, the way a graph does it.
      //
      // A layer editor copies the pixels into the new layer, so the file
      // carries a second set of them and they stop agreeing with the
      // original the moment anything upstream changes. Here the layer
      // holds a Lift node, which is an instruction to take what is
      // underneath, and the selection becomes the layer's mask rather
      // than pixels copied at the moment the layer was made. So the file
      // grows by a node and the lifted pixels follow a re-develop; the
      // mask is the selection's coverage as pixels, painted by hand from
      // there (2026-09-30).
      const src = s.nodes.find((n) => n.id === cmd.maskId);
      if (!src || src.type !== "heeler.selection_mask") return s;
      const added = reduce(s, { type: "art_add_layer", kind: "lift" });
      const id = added.artActive;
      if (!id) return s;
      const masked = reduce(added, { type: "art_add_mask", id, kind: "brush" });
      // One undo entry for the whole gesture: the inner reduces each
      // pushed their own, and undoing this twice to be rid of it is the
      // kind of thing people report as undo being broken.
      return withUndo({
        nodes: masked.nodes.map((n) =>
          n.id === `art_m_${id}`
            ? pixelMaskWearing(n, cmd.version, 1, undefined, selectionOutline(src))
            : n.id === src.id && src.id === DOC_SEL_ID
              ? selectionSpent(n)
              : n,
        ),
        wires: masked.wires,
        artActive: masked.artActive,
      });
    }
    // Reaching for the select tool makes a place to select, and
    // nothing else. It does NOT touch the active layer.
    case "arm_document_selection": {
      const { state: withSel, id } = ensureDocSelection(s);
      // No panel gymnastics: the selection split derives from the tool
      // being in hand, so arming is all this needs to do. In the Graph
      // and Canvas a Smart or Object Mask node picked there stays picked
      // beside it: it is the mask in hand there (liveMaskInHand), the
      // one a Subtract over its ants takes the shape out of.
      const inGraph = s.mode === "advanced" || s.mode === "canvas";
      const keep = inGraph
        ? s.selection.filter((k) => k !== id && liveMaskHasContent(artMaskNode(s, k)))
        : [];
      return { ...withSel, selection: [id, ...keep], tool: "select" };
    }
    // Select by needs the document selection to exist and be picked,
    // but it is not the select tool: no arming, no cursor change. The
    // marching ants render for selection nodes regardless of the tool.
    case "ensure_document_selection": {
      const { state: withSel, id } = ensureDocSelection(s);
      return { ...withSel, selection: [id] };
    }
    // And the explicit version of what arming the select tool used to do
    // behind your back: take the selection you have and make it this
    // layer's mask. A pixel mask (2026-09-30: "I expect when I clicked To
    // Mask that it made a regular black and white mask and I could clear
    // the selection"; "drop the live mask, make To Mask a pixel mask"): the
    // desktop rendered the selection once (bake_layer_mask), on its own for
    // a plain click, or added to or taken out of what the mask showed for
    // Shift and Option; the mask wears that coverage with nothing painted
    // on it, the brush in hand to paint on, the document selection empty.
    // One undo puts both back.
    case "art_mask_from_selection": {
      const src = s.nodes.find((n) => n.id === cmd.maskId);
      if (!src || src.type !== "heeler.selection_mask" || !cmd.version) return s;
      const existing = artMaskOf(s, cmd.id);
      const based = existing ? s : reduce(s, { type: "art_add_mask", id: cmd.id, kind: "brush" });
      const mid = existing?.id ?? `art_m_${cmd.id}`;
      if (!based.nodes.some((n) => n.id === mid)) return s;
      const polarity = layerMaskPolarity(based, mid);
      return withUndo({
        nodes: based.nodes.map((n) =>
          n.id === mid
            ? pixelMaskWearing(n, cmd.version, polarity, existing, outlineAfter(cmd.op ?? "replace", existing, src))
            : n.id === src.id && src.id === DOC_SEL_ID
              ? selectionSpent(n)
              : n,
        ),
        selection: [mid],
        tool: "brush",
        wires: based.wires,
      });
    }
    // Dodging needs somewhere neutral-blending to put the gray, so
    // arming the tool makes one if there is not one already.
    //
    // This is not the select tool growing a mask behind your back. the
    // owner was right about that one: a selection has nothing to do
    // with masking and changing the layer was a side effect nobody
    // asked for. Here the layer IS the gesture. White paint on a Normal
    // layer is white paint; it only becomes dodging when something
    // blends it as Soft Light, so creating that is the only way the
    // tool can mean anything. And it arrives named in the stack rather
    // than silently. Clip a layer to the one below it: the layer shows
    // only where the base has visible pixels. The flag lives on the
    // blend node and the wiring is regenerated from the layer list, so
    // reordering keeps the rule ("clip to whatever is below me now")
    // rather than a stale reference to a layer that moved away.
    case "art_clip_layer": {
      const layer = artFindLayer(s, cmd.id);
      if (!layer || layer.groupId) return s;
      const layers = artLayers(s);
      const at = layers.findIndex((l) => l.blend.id === cmd.id);
      // The bottom layer has nothing below it to clip to.
      if (cmd.clip && at <= 0) return s;
      const flagged = updateArtNodeDeep(s, cmd.id, (n) => ({
        ...n,
        params: { ...n.params, clip: cmd.clip ? 1 : 0 },
      }));
      if (!flagged) return s;
      const next = withArtLayers({ ...s, nodes: flagged.nodes }, (ls) => ls);
      return withUndo({ nodes: next.nodes, wires: next.wires });
    }
    case "art_arm_dodge": {
      const layer = s.artActive ? artFindLayer(s, s.artActive) : undefined;
      const usable =
        layer?.content.type === "heeler.paint" &&
        layer.carrier.textParams?.mode === "soft_light";
      const next = usable ? s : reduce(s, { type: "art_add_layer", kind: "dodgeburn" });
      return { ...next, tool: cmd.tool, dodgeMode: cmd.tool };
    }
    case "art_add_mask": {
      // Made from a button that adds a mask: the mask is made (the undo
      // step), then selected with its tool in hand, the state the mask
      // button's own click sets. Arming never toggles: a brush already in
      // hand stays up, now on the new mask.
      if (cmd.edit) {
        const made = reduceInner(s, { ...cmd, edit: false });
        const mask = made === s ? undefined : artMaskOf(made, cmd.id);
        const tool = mask ? artMaskEditTool(made, cmd.id) : undefined;
        if (!mask || !tool) return made;
        const armed = made.tool === tool ? made : reduceInner(made, { type: "set_tool", tool });
        return { ...armed, selection: [mask.id] };
      }
      // A layer anywhere in the stack, top level or inside a group. A
      // member's mask crosses two boundaries rather than one, which is
      // the only difference and it is all in the wiring below.
      const maskOwner = artFindLayer(s, cmd.id);
      if (!maskOwner || artMaskOf(s, cmd.id)) return s;
      // A group made before members carried blends chains merges, and a
      // merge has no mask port to wire to.
      if (maskOwner.carrier.type === "heeler.merge") return s;
      const mid = `art_m_${cmd.id}`;
      // Two brush characters. A layer mask: inverted and empty = one everywhere =
      // reveal all, and painting HIDES, the layer-editor reflex; erasing un-hides.
      // "fill": not inverted and empty = nowhere, strokes reveal, for the Fill
      // layer's hole. Both fed from the whole frame (the crop when there is one,
      // frameFeed) like every develop mask, so they are the size of the layer they
      // gate and the ROI mask_crop path already covers them. No live selection kind
      // since 2026-09-30: a selection made into a layer's mask is pixels
      // (pixelMaskWearing), so a layer mask is always the paintable kind. Smart:
      // the model's selection as a Finish layer mask ("smart selection
      // ... in the Finish (Pixel Layers) as well"). The layer shows only inside it,
      // and the smart panel and click tool drive it exactly as they drive a Develop
      // smart layer.
      const smart = cmd.kind === "smart";
      // Object: the photograph's own file supplies the mask (2026-09-20: "a
      // button that appears next to the depth mask for object masks"). Born
      // with the recipe an Object adjustment mask is born with in add_layer,
      // so the matte panel and the pick tool drive it exactly as they drive
      // a Develop object layer.
      const object = cmd.kind === "object";
      const fillStrokes = cmd.kind === "fill";
      const mask: NodeCard = {
        id: mid,
        type: smart ? "heeler.smart_mask" : object ? "heeler.matte_mask" : "heeler.brush_mask",
        name: "Layer Mask",
        cat: "masking",
        x: (s.nodes.find((n) => n.id === ART_ID)?.x ?? 900) - NODE_W - 60,
        y: (s.nodes.find((n) => n.id === ART_ID)?.y ?? 240) + 90,
        enabled: true,
        params: fillStrokes ? {} : smart ? {} : object ? { ...LAYER_MASK_DEFAULTS.object } : { invert: 1 },
        ...(smart || object ? {} : { strokes: [] }),
        ...(smart ? { textParams: { mode: "click", prompts: "[]", model: "" } } : {}),
        ...(object ? { textParams: { layer: "", names: "[]" } } : {}),
        hasIn: true,
        hasOut: true,
      };
      // The boundary hops the mask takes to reach its layer. One for a
      // top-level layer: into the art group, straight to the blend.
      // Two for a member: into the art group as far as the stack group,
      // then into the stack group as far as the member's own carrier.
      // The flattener runs until no groups are left, so it walks them
      // in that order without being told anything else.
      const intoArt: Wire = {
        from: mid,
        to: maskOwner.groupId ?? cmd.id,
        toPort: "mask",
        kind: "mask",
      };
      const intoGroup: Wire = { from: mid, to: cmd.id, toPort: "mask", kind: "mask" };
      // A mask of this layer left gating nothing (a node spliced into its
      // wire in the Finish group, then deleted, takes the wire with it):
      // the same kind comes back wired, strokes and all, and another
      // kind takes its place. Never two nodes of one id.
      let base = s;
      const left = s.nodes.find((n) => n.id === mid);
      if (left || graphHasNode(artGroup(s)?.groupNodes ?? [], mid)) {
        const gates =
          s.wires.some((w) => w.from === mid) ||
          (artGroup(s)?.groupWires ?? []).some((w) => w.from === mid) ||
          (artGroup(s)?.groupBoundary ?? []).some((w) => w.from === mid);
        if (gates || !left) return s;
        if (left.type === mask.type) {
          return withUndo({
            nodes: s.nodes.map((n) =>
              n.id !== ART_ID
                ? n
                : {
                    ...n,
                    groupBoundary: [...(n.groupBoundary ?? []), intoArt],
                    groupNodes: maskOwner.groupId
                      ? (n.groupNodes ?? []).map((g) => (g.id === maskOwner.groupId ? { ...g, groupBoundary: [...(g.groupBoundary ?? []), intoGroup] } : g))
                      : n.groupNodes,
                  },
            ),
            wires: [
              ...s.wires,
              ...(s.wires.some((w) => w.to === mid && w.toPort === "in") ? [] : [{ from: frameFeed(s.nodes, s.wires) ?? "src", to: mid, toPort: "in", kind: "image" } as Wire]),
              { from: mid, to: ART_ID, toPort: "mask", kind: "mask" },
            ],
          });
        }
        base = { ...s, nodes: s.nodes.filter((n) => n.id !== mid), wires: s.wires.filter((w) => w.to !== mid) };
      }
      return withUndo({
        nodes: base.nodes.map((n) => {
          if (n.id === ART_ID) {
            return { ...n, groupBoundary: [...(n.groupBoundary ?? []), intoArt] };
          }
          return n;
        }).map((n) =>
          // The second hop is recorded on the group that holds the
          // member, which lives inside the art group's own node list.
          maskOwner.groupId && n.id === ART_ID
            ? {
                ...n,
                groupNodes: (n.groupNodes ?? []).map((g) =>
                  g.id === maskOwner.groupId
                    ? { ...g, groupBoundary: [...(g.groupBoundary ?? []), intoGroup] }
                    : g,
                ),
              }
            : n,
        ).concat(mask),
        wires: [
          ...base.wires,
          { from: frameFeed(s.nodes, s.wires) ?? "src", to: mid, toPort: "in", kind: "image" },
          { from: mid, to: ART_ID, toPort: "mask", kind: "mask" },
        ],
      });
    }
    case "art_remove_mask": {
      const mask = artMaskOf(s, cmd.id);
      if (!mask) return s;
      const owner = artFindLayer(s, cmd.id);
      // A node spliced into the mask's wire inside the Finish group (a
      // Morphology, a Guided Filter (Mask)) stays where the user put it,
      // but its wire into the layer's mask port goes with the mask, so
      // the layer is unmasked rather than gated by a chain that reads
      // nothing.
      const art = artGroup(s);
      const gate = owner?.groupId ?? cmd.id;
      const fromMask = (w: Wire): boolean => art !== undefined && w.to === gate && w.toPort === "mask" && maskWireSource(art, w) === mask.id;
      return withUndo({
        nodes: s.nodes
          .filter((n) => n.id !== mask.id)
          .map((n) =>
            n.id === ART_ID
              ? {
                  ...n,
                  // Both hops go, wherever they were recorded: the art
                  // group's boundary, and the stack group's if the
                  // layer lives inside one.
                  groupBoundary: (n.groupBoundary ?? []).filter((w) => w.from !== mask.id && w.to !== mask.id),
                  groupWires: (n.groupWires ?? []).filter((w) => w.from !== mask.id && w.to !== mask.id && !fromMask(w)),
                  groupNodes: (n.groupNodes ?? []).filter((g) => g.id !== mask.id).map((g) =>
                    g.id === owner?.groupId
                      ? {
                          ...g,
                          groupBoundary: (g.groupBoundary ?? []).filter(
                            (w) => w.from !== mask.id,
                          ),
                        }
                      : g,
                  ),
                }
              : n,
          ),
        wires: s.wires.filter((w) => w.from !== mask.id && w.to !== mask.id),
        selection: s.selection.filter((id) => id !== mask.id),
        // A mask-editing tool armed at the deleted mask goes down with it -
        // and the brush settings panel it kept open goes too. The paint tool
        // stays: it writes the LAYER, which is still there.
        // "deleting a mask should hide the brush settings if the paint brush
        // is not the actively selected tool."
        tool:
          ["brush", "select", "smart", "fill"].includes(s.tool) &&
          (s.selection.includes(mask.id) || s.artActive === cmd.id)
            ? "none"
            : s.tool,
      });
    }
    case "select_art_layer":
      return { ...s, artActive: cmd.id, artSelected: cmd.id ? [cmd.id] : [] };
    case "art_edit_gradient":
      return { ...s, artGradientEdit: cmd.id };
    case "set_paint_color":
      return { ...s, paintColor: cmd.color };
    case "move_curves_late": {
      // Curves used to sit before exposure and the profile, which is why
      // the curve's axis could never read like the screen. A saved graph
      // is rewired only while its curve is still an identity: an identity
      // renders the same from anywhere in the chain, so the move cannot
      // change a photograph. A curve someone has bent stays where they
      // bent it, because moving it across the profile would.
      const cv = s.nodes.find((n) => n.type === "heeler.curves");
      if (!cv || !CHAIN_ORDER.includes(cv.id) || !curvesUntouched(cv)) return s;
      const profile = s.nodes.find((n) => n.type === "heeler.tone_profile");
      const feeder = s.wires.find((w) => w.to === cv.id && w.toPort === "in");
      if (!profile || !feeder || ridesOnProfile(s, feeder.from)) return s;
      return moveToneAfterProfile(s, cv.id);
    }
    // A graph saved with one interpolation face for the conversion's
    // three curves: the infrared guess and the depth curve take a copy
    // of it as their own (review 2026-09-15, item 7), so from here on
    // the hue curve's face moves neither of the other two
    // curves. Idempotent: a face already set stays.
    case "split_curve_faces": {
      let moved = false;
      const nodes = s.nodes.map((n) => {
        if (n.type !== "heeler.black_white" || !n.curveInterp) return n;
        const faces = withOwnFaces(n);
        if (faces === n.textParams) return n;
        moved = true;
        return { ...n, textParams: faces };
      });
      return moved ? { ...s, nodes } : s;
    }
    case "move_levels_late": {
      // Levels followed Curves onto the finished profile (2026-09-13): its
      // handles sit on the histogram of the picture as shown, and before
      // Exposure in scene-linear a black point of 0.01 cut the darkest
      // tenth of the screen ("the smallest nudge of a slider
      // has huge changes"). The curve's rule: only an identity Levels is
      // rewired, since it renders the same from anywhere in the chain; one
      // someone has set stays where they set it.
      const lv = s.nodes.find((n) => n.type === "heeler.levels" && CHAIN_ORDER.includes(n.id));
      if (!lv || !levelsUntouched(lv)) return s;
      const profile = s.nodes.find((n) => n.type === "heeler.tone_profile");
      const feeder = s.wires.find((w) => w.to === lv.id && w.toPort === "in");
      if (!profile || !feeder || ridesOnProfile(s, feeder.from)) return s;
      return moveToneAfterProfile(s, lv.id);
    }
    case "load_images":
      // An empty list still replaces the session: a folder with no images
      // of its own must not keep showing the previous folder's ribbon.
      return {
        ...s,
        images: cmd.images,
        activeImage: cmd.images[0]?.id ?? "",
        graphLoading: cmd.images[0]?.id ?? null,
        imageSelection: cmd.images.length ? s.imageSelection : [],
        // A new folder replaces the graph, including every armed tool.
        ...GRAPH_POINTERS_RESET,
        gesture: null,
        gesturePushed: false,
        view: { ...s.view, roiPatch: null },
        selection: [],
        // The shot dates are the folder's: a file replaced at the same
        // path (the same id) must not keep the old file's day, and a
        // set date filter reads the new folder afresh, which it pays
        // only while the filter is set.
        shotDates: {},
        graphs: {},
        activeLayer: null,
        nodes: freshNodes(s, cmd.images[0]?.name ?? "", bornRendered(cmd.images[0])),
        wires: structuredClone(s.defaultGraph.wires),
        backdrops: [],
        undoStack: [],
        redoStack: [],
      };
    case "append_images": {
      // Tether arrivals: loading machinery, not an edit: no undo, no
      // session reset, and a photograph the ribbon already shows keeps
      // its row (thumbnail included).
      const have = new Set(s.images.map((i) => i.id));
      const fresh = cmd.images.filter((i) => !have.has(i.id));
      if (fresh.length === 0) return s;
      return { ...s, images: [...s.images, ...fresh] };
    }
    case "replace_graph": {
      const overridesPatch = cmd.overrides !== undefined ? { linkOverrides: cmd.overrides.filter((k) => typeof k === "string") } : {};
      const migrated = migrateGraph(cmd.nodes, cmd.wires);
      // A photo nobody has edited, whose graph is exactly the template's
      // nodes, takes the template's layout. Saved graphs carry the
      // coordinates they were born with, and until 2026-09-01 those were
      // the sample session's, drawn for eleven nodes: the five that
      // remain after the load's cleanup sat scattered on every photo
      // already on disk. Edited photos keep whatever layout they have,
      // since a person may have arranged it.
      const edited = s.images.find((i) => i.id === s.activeImage)?.edited ?? true;
      const template = new Map(s.defaultGraph.nodes.map((n) => [n.id, n]));
      const templateShaped =
        !edited &&
        migrated.nodes.length === template.size &&
        migrated.nodes.every((n) => template.has(n.id));
      const nodes = templateShaped
        ? migrated.nodes.map((n) => {
            const t = template.get(n.id)!;
            return n.x === t.x && n.y === t.y ? n : { ...n, x: t.x, y: t.y };
          })
        : migrated.nodes;
      return {
        ...s,
        nodes,
        wires: migrated.wires,
        backdrops: cmd.backdrops ?? [],
        ...overridesPatch,
        graphLoading: null,
        selection: [],
        undoStack: [],
        redoStack: [],
        activeLayer: null,
      };
    }
    case "grid_warp_select": {
      const cur = s.gridWarp.selected;
      const set = new Set(cmd.mode === "set" || !cmd.mode ? [] : cur);
      for (const k of cmd.ids) {
        if (cmd.mode === "toggle" && set.has(k)) set.delete(k);
        else set.add(k);
      }
      return { ...s, gridWarp: { ...s.gridWarp, selected: [...set].sort((a, b) => a - b) } };
    }
    case "grid_warp_live":
      return { ...s, gridWarp: { ...s.gridWarp, live: cmd.mesh } };
    case "grid_warp_grow":
    case "grid_warp_shrink": {
      const mesh = gridWarpMesh(s);
      const selected =
        cmd.type === "grid_warp_grow"
          ? growGridSelection(mesh, s.gridWarp.selected)
          : shrinkGridSelection(mesh, s.gridWarp.selected);
      return { ...s, gridWarp: { ...s.gridWarp, selected } };
    }
    case "set_grid_warp_ui":
      return {
        ...s,
        gridWarp: {
          ...s.gridWarp,
          ...(cmd.influence !== undefined
            ? { influence: Math.min(GRID_WARP_MAX_INFLUENCE, Math.max(0, Math.round(cmd.influence))) }
            : {}),
          ...(cmd.heat ? { heat: cmd.heat } : {}),
          ...(cmd.link !== undefined ? { link: cmd.link } : {}),
        },
      };
    case "set_line_color":
      return {
        ...s,
        lineColor: {
          ...s.lineColor,
          ...(cmd.hue !== undefined ? { hue: cmd.hue === null ? null : ((Math.round(cmd.hue) % 360) + 360) % 360 } : {}),
          ...(cmd.luma !== undefined ? { luma: cmd.luma === null ? null : Math.min(100, Math.max(0, Math.round(cmd.luma))) } : {}),
        },
      };
    case "grid_warp_mesh":
    case "grid_warp_density":
    case "grid_warp_line":
    case "grid_warp_reset": {
      // The node is built on the first write, like every on-demand
      // section's; a reset of a photo that has no mesh is nothing.
      let nodes = s.nodes;
      let wires = s.wires;
      // A Finish warp (a Warp layer, an image layer's own warp) is
      // edited where it lives, inside the Finish group, and is never
      // built by a write: it exists because its layer does.
      const target = warpCmdTarget(s, cmd);
      let node = warpNodeFor(s, "grid", target);
      if (!node && target) return s;
      if (!node) {
        if (cmd.type === "grid_warp_reset") return s;
        // Born on, like the crop the first crop drag builds: the drag
        // that built it is the user asking for it.
        ({ nodes, wires } = buildCategoryPiece(nodes, wires, GRID_WARP_PIECE));
        node = nodes.find((n) => n.id === GRID_WARP_PIECE.id)!;
      }
      const current = meshFromNode(node);
      const next: GridMesh =
        cmd.type === "grid_warp_mesh"
          ? cmd.mesh
          : cmd.type === "grid_warp_density"
            ? resampleMesh(current, cmd.cols, cmd.rows)
            : cmd.type === "grid_warp_line"
              ? cmd.remove !== undefined
                ? removeGridLine(current, cmd.axis, cmd.remove)
                : insertGridLine(current, cmd.axis, cmd.at ?? 0.5)
              : restMesh(current.cols, current.rows);
      if (cmd.type === "grid_warp_line" && next === current) return s;
      const id = node.id;
      // A changed grid means the picks name different handles: keep
      // only those still on the grid after a drag, drop them otherwise.
      const selected =
        cmd.type === "grid_warp_mesh"
          ? s.gridWarp.selected.filter((k) => k < vertexCount(next))
          : [];
      const written = (n: NodeCard): NodeCard => ({
        ...n,
        params: { ...n.params, cols: next.cols, rows: next.rows },
        textParams: { ...n.textParams, ...meshTextParams(next), ...pinnedWarpKind(n, "grid") },
        // A switched-off warp comes on the moment a handle says something,
        // the way every bypassed node's controls arm it (armed): moving a
        // handle and being ignored is the "pixels snap back" the owner met. A
        // rest mesh says nothing and leaves the switch alone.
        enabled: n.enabled || !isMeshIdentity(next),
      });
      return withUndo({
        nodes: (target && updateArtNodeDeep(s, id, written)?.nodes) || nodes.map((n) => (n.id === id ? written(n) : n)),
        wires,
        images: s.images.map((i) => (i.id === s.activeImage ? { ...i, edited: true } : i)),
        gridWarp: { ...s.gridWarp, selected, live: null },
      });
    }
    case "shape_warp_select":
      return { ...s, shapeWarp: { ...s.shapeWarp, selected: cmd.id } };
    case "shape_warp_mode":
      return { ...s, shapeWarp: { ...s.shapeWarp, mode: cmd.mode } };
    case "shape_warp_add":
    case "shape_warp_remove":
    case "shape_warp_rename":
    case "shape_warp_enable":
    case "shape_warp_set":
    case "shape_warp_reset": {
      // The node is built on the first add, born on like the crop the
      // first crop drag builds; everything else needs a node.
      let nodes = s.nodes;
      let wires = s.wires;
      // A Finish warp is edited where it lives and never built by a
      // write, the Grid Warp rule above.
      const target = warpCmdTarget(s, cmd);
      let node = warpNodeFor(s, "shape", target);
      if (!node && target) return s;
      if (!node) {
        if (cmd.type !== "shape_warp_add") return s;
        ({ nodes, wires } = buildCategoryPiece(nodes, wires, SHAPE_WARP_PIECE));
        node = nodes.find((n) => n.id === SHAPE_WARP_PIECE.id)!;
      }
      const current = shapesFromNode(node);
      let next: WarpShape[];
      let selected = s.shapeWarp.selected;
      let mode = s.shapeWarp.mode;
      switch (cmd.type) {
        case "shape_warp_add": {
          const fresh = newShape(current);
          next = [...current, fresh];
          selected = fresh.id;
          mode = "position";
          break;
        }
        case "shape_warp_remove":
          next = current.filter((sh) => sh.id !== cmd.id);
          if (next.length === current.length) return s;
          if (selected === cmd.id) selected = next.length ? next[next.length - 1].id : null;
          break;
        case "shape_warp_rename":
          // An empty name is a real answer: it hands the shape back to
          // the automatic one, its outline and its place in the list.
          next = current.map((sh) => (sh.id === cmd.id ? { ...sh, name: cmd.name.trim() } : sh));
          break;
        case "shape_warp_enable":
          next = current.map((sh) => (sh.id === cmd.id ? { ...sh, enabled: cmd.on } : sh));
          break;
        case "shape_warp_set": {
          // A number that is not finite is no write: the shape keeps
          // what it had rather than falling back to the default.
          const patch = Object.fromEntries(Object.entries(cmd.patch).filter(([, v]) => typeof v !== "number" || Number.isFinite(v)));
          // shapeFrom reads the node's keys, so the two camel-cased
          // fields are handed over under their stored names.
          next = current.map((sh) =>
            sh.id === cmd.id
              ? shapeFrom({ ...sh, ...patch, scale_y: patch.scaleY ?? sh.scaleY, shape_amount: patch.shapeAmount ?? sh.shapeAmount }, sh.id)
              : sh,
          );
          break;
        }
        default:
          next = current.map((sh) => (cmd.id === undefined || sh.id === cmd.id ? restShape(sh) : sh));
      }
      if (cmd.type !== "shape_warp_add" && serializeShapes(next) === serializeShapes(current)) return s;
      const id = node.id;
      const written = (n: NodeCard): NodeCard => ({
        ...n,
        textParams: { ...n.textParams, shapes: serializeShapes(next), ...pinnedWarpKind(n, "shapes") },
        // A switched-off warp comes on the moment a shape moves
        // something, the way every bypassed node's controls arm it;
        // placing shapes that move nothing leaves it alone.
        enabled: n.enabled || cmd.type === "shape_warp_add" || !shapesIdentity(next),
      });
      return withUndo({
        nodes: (target && updateArtNodeDeep(s, id, written)?.nodes) || nodes.map((n) => (n.id === id ? written(n) : n)),
        wires,
        images: s.images.map((i) => (i.id === s.activeImage ? { ...i, edited: true } : i)),
        shapeWarp: { ...s.shapeWarp, selected, mode },
      });
    }
    case "set_photo_line_width": {
      // A view setting, like the preference it overrides: no node, no
      // undo step, no edited badge. The autosave keeps it in the file.
      const id = cmd.id ?? s.activeImage;
      if (!id) return s;
      const width = cmd.width > 0 ? clampShapeLineWidth(cmd.width) : 0;
      if ((s.photoLineWidth[id] ?? 0) === width) return s;
      const photoLineWidth = { ...s.photoLineWidth };
      if (width > 0) photoLineWidth[id] = width;
      else delete photoLineWidth[id];
      return { ...s, photoLineWidth };
    }
    case "graph_settled":
      // The read ended, with a graph (replace_graph already cleared
      // this) or without one; either way the pump may render what is
      // on hand. Another photo's settle is not this one's.
      return s.graphLoading === cmd.id ? { ...s, graphLoading: null } : s;
    case "add_backdrop":
      return withUndo({ backdrops: [...s.backdrops, cmd.backdrop] });
    case "move_backdrop": {
      const b = s.backdrops.find((x) => x.id === cmd.id);
      if (!b) return s;
      // Nodes inside ride along, compositor-style.
      const riders = new Set(nodesInBackdrop(s.nodes, b));
      return withUndo({
        backdrops: s.backdrops.map((x) =>
          x.id === cmd.id ? { ...x, x: x.x + cmd.dx, y: x.y + cmd.dy } : x,
        ),
        nodes: s.nodes.map((n) =>
          riders.has(n.id) ? { ...n, x: n.x + cmd.dx, y: n.y + cmd.dy } : n,
        ),
      });
    }
    case "resize_backdrop":
      return withUndo({
        backdrops: s.backdrops.map((x) =>
          x.id === cmd.id
            ? { ...x, w: Math.max(120, cmd.w), h: Math.max(80, cmd.h) }
            : x,
        ),
      });
    case "rename_backdrop":
      return withUndo({
        backdrops: s.backdrops.map((x) =>
          x.id === cmd.id ? { ...x, name: cmd.name.trim() || x.name } : x,
        ),
      });
    case "cycle_backdrop_color":
      return withUndo({
        backdrops: s.backdrops.map((x) =>
          x.id === cmd.id
            ? { ...x, color: (x.color + 1) % BACKDROP_COLORS.length }
            : x,
        ),
      });
    case "delete_backdrop":
      return withUndo({
        backdrops: s.backdrops.filter((x) => x.id !== cmd.id),
      });
    case "reset_image_edits":
      return resetImages(s, cmd.ids ?? (cmd.id !== undefined ? [cmd.id] : []));
    case "collapse_tree_below": {
      if (!s.folderTree) return s;
      const collapseBelow = (n: TreeNode): TreeNode => ({
        ...n,
        children:
          n.children?.map((c) => ({ ...collapseBelow(c), expanded: false })) ??
          null,
      });
      return {
        ...s,
        folderTree: updateTreeNode(s.folderTree, cmd.path, (n) =>
          collapseBelow(n),
        ),
      };
    }
    case "arrange_nodes": {
      // "the node graph is a mess. We need nodes to
      // automatically organize and layout."
      //
      // This used to put a column per node CATEGORY, which reads well until
      // you look at the wires: every color node landed in one column
      // whatever its place in the chain, so the wires zigzagged back and
      // forth across the canvas. Column now means how far down the chain a
      // node actually is, worked out from the wires, which is what makes
      // every wire point forwards.
      const positions = arrange(s.nodes, s.wires, NODE_W, NODE_H);
      return withUndo({
        nodes: s.nodes.map((n) => {
          const at = positions.get(n.id);
          return at ? { ...n, x: at.x, y: at.y } : n;
        }),
      });
    }
    case "set_thumb":
      return {
        ...s,
        images: s.images.map((i) =>
          i.id === cmd.id ? { ...i, src: cmd.src } : i,
        ),
      };
    // Rating and flagging take a list, because culling is a bulk
    // activity: you sweep a burst, mark the whole run as rejects, and
    // move on. Applying only to the one image under the cursor while a
    // dozen are selected is the kind of thing that quietly loses work.
    case "set_rating": {
      const ids = new Set(cmd.ids);
      const stars = Math.min(5, Math.max(0, cmd.stars));
      return {
        ...s,
        images: s.images.map((i) => (ids.has(i.id) ? { ...i, stars } : i)),
      };
    }
    case "set_flag": {
      const ids = new Set(cmd.ids);
      return {
        ...s,
        images: s.images.map((i) =>
          ids.has(i.id) ? { ...i, flag: cmd.flag } : i,
        ),
      };
    }
    case "select_nodes": {
      // Picking an art layer's node makes that layer the active one,
      // whichever half was clicked: blend and content are one layer, and
      // the paint tools follow the graph. "if I want to paint
      // while in node view I don't know which one I am supposed to have
      // selected" - either works now.
      let artActive = s.artActive;
      for (const id of cmd.ids) {
        const hit = artLayers(s).find((l) => l.blend.id === id || l.content.id === id);
        if (hit) artActive = hit.blend.id;
      }
      return {
        ...s,
        artActive,
        selection: cmd.additive
          ? Array.from(new Set([...s.selection, ...cmd.ids]))
          : cmd.ids,
      };
    }
    case "clear_selection":
      return { ...s, selection: [] };
    case "move_node":
      return withUndo({
        nodes: s.nodes.map((n) =>
          n.id === cmd.id ? { ...n, x: cmd.x, y: cmd.y } : n,
        ),
      });
    case "reset_node": {
      // "nodes don't have a reset on them." Develop's sections
      // had one; a card in the graph did not. Dials, choices and curves go
      // back to the defaults the section reset writes, in one undo step.
      // Strokes, regions and the switch stay: those are content and state,
      // not settings.
      if (!s.nodes.some((n) => n.id === cmd.id)) return s;
      return withUndo({
        nodes: s.nodes.map((n) => {
          if (n.id !== cmd.id) return n;
          // The tone profile's mode is not in any default table: a
          // fresh graph takes it from the RAW profile preference, so
          // a reset does too, badge included.
          // The Source card's Sharpening is the same kind of choice: a
          // RAW's fresh graph takes it from the preference, so its
          // reset does too.
          const activeImage = s.images.find((i) => i.id === s.activeImage);
          const textValues =
            n.type === "heeler.tone_profile" && cmd.textValues.mode === undefined
              ? { ...cmd.textValues, mode: s.rawProfile }
              : n.type === "heeler.image_source" && activeImage && sharpensAtBirth(activeImage.name, bornRendered(activeImage))
                ? { ...cmd.textValues, sharpening: s.rawSharpening }
                : cmd.textValues;
          // The Depth Map resets to the preference, the same numbers it
          // was born with, rather than to the registry's.
          const values =
            n.type === "heeler.depth_map" ? { ...cmd.values, ...depthMapParams(s.prefs) } : cmd.values;
          return {
            ...n,
            params: { ...n.params, ...values },
            textParams: Object.keys(textValues).length ? { ...n.textParams, ...textValues } : n.textParams,
            ...(n.type === "heeler.tone_profile"
              ? { badge: s.rawProfile === "standard" ? undefined : s.rawProfile }
              : {}),
            curves: {},
            curveTangents: {},
            curveHandles: {},
            // A group's Reset writes each published control's own
            // default through to the members (the Controls editor).
            ...(n.isGroup && n.groupNodes ? { groupNodes: publishedDefaults(n) } : {}),
          };
        }),
        images: s.images.map((i) => (i.id === s.activeImage ? { ...i, edited: true } : i)),
      });
    }
    case "duplicate_nodes": {
      // "we need a context menu item (and hotkey) to duplicate
      // the selected node(s)." Copies land a step down and right of their
      // originals, keep the wires among themselves, and take nothing from
      // outside the set: a duplicate is a new thing to wire in, not a
      // second consumer of the original's feed. The copies become the
      // selection, so a drag right after moves them.
      const present = cmd.ids.filter((id) => s.nodes.some((n) => n.id === id));
      const wanted = present.filter(duplicable);
      // What was left behind says so: Output alone under the key used
      // to do nothing at all, which reads as the key being broken.
      const skipped = duplicateSkipNotice(present.filter((id) => !duplicable(id)), wanted.length);
      const notice = skipped ? { text: skipped, at: Date.now() } : s.notice;
      if (!wanted.length) return skipped ? { ...s, notice } : s;
      const fresh = new Map<string, string>();
      const copies = wanted.map((id) => {
        const n = s.nodes.find((k) => k.id === id)!;
        const copy: NodeCard = {
          ...copyNodeWithId(n, freshNodeId(n.type)),
          x: n.x + 30,
          y: n.y + 30,
        };
        fresh.set(id, copy.id);
        return copy;
      });
      // A step down and right always lands on the original; the copies move
      // on as one block, their spacing kept, to the nearest spot clear of
      // every card (2026-09-28: nothing new lands on top).
      const off = freeOffset(s.nodes, copies);
      for (const c of copies) {
        c.x += off.dx;
        c.y += off.dy;
      }
      const inner = s.wires
        .filter((w) => fresh.has(w.from) && fresh.has(w.to))
        .map((w) => ({ ...w, from: fresh.get(w.from)!, to: fresh.get(w.to)! }));
      return withUndo({
        nodes: [...s.nodes, ...copies],
        wires: [...s.wires, ...inner],
        selection: copies.map((c) => c.id),
        notice,
      });
    }
    case "move_nodes": {
      // A marquee selection dragged as one. "If I marquee select
      // a bunch of nodes I can't drag as a group. Only the node I drag on
      // moves."
      const at = new Map(cmd.moves.map((m) => [m.id, m]));
      return withUndo({
        nodes: s.nodes.map((n) => {
          const m = at.get(n.id);
          return m ? { ...n, x: m.x, y: m.y } : n;
        }),
      });
    }
    case "set_param": {
      if (!s.nodes.some((n) => n.id === cmd.id)) {
        const deep = updateArtNodeDeep(s, cmd.id, (n) => ({ ...n, params: { ...n.params, [cmd.param]: clampParam(cmd.param, cmd.value, n.type) } }));
        if (deep) return withUndo({ nodes: deep.nodes, images: s.images.map((i) => i.id === s.activeImage ? { ...i, edited: true } : i) });
      }
      const value = clampParam(
        cmd.param,
        cmd.value,
        s.nodes.find((n) => n.id === cmd.id)?.type,
      );
      return withUndo({
        nodes: s.nodes.map((n) =>
          n.id === cmd.id
            ? armedIn(s, { ...n, params: { ...n.params, [cmd.param]: value } })
            : n,
        ),
        images: s.images.map((i) =>
          i.id === s.activeImage ? { ...i, edited: true } : i,
        ),
      });
    }
    case "set_params": {
      if (!s.nodes.some((n) => n.id === cmd.id)) {
        const deep = updateArtNodeDeep(s, cmd.id, (n) => ({
          ...n, params: { ...n.params, ...Object.fromEntries(Object.entries(cmd.values).map(([k, v]) => [k, clampParam(k, cmd.harmonize && s.harmony.mode !== "off" && k.endsWith("_hue") ? harmonize(v, s.harmony) : v, n.type)])) },
          textParams: cmd.text ? { ...n.textParams, ...cmd.text } : n.textParams,
        }));
        if (deep) return withUndo({ nodes: deep.nodes, images: s.images.map((i) => i.id === s.activeImage ? { ...i, edited: true } : i) });
      }
      const nodeType = s.nodes.find((n) => n.id === cmd.id)?.type;
      const clamped: Record<string, number> = {};
      for (const [k, v] of Object.entries(cmd.values)) {
        // The harmony aid bends declared wheel gestures toward the
        // family; typed values and everything else pass untouched.
        const bent =
          cmd.harmonize && s.harmony.mode !== "off" && k.endsWith("_hue")
            ? harmonize(v, s.harmony)
            : v;
        // NaN is no value: a gesture that computed one (a pointer event
        // without coordinates) leaves the param as it was rather than
        // saving NaN, which renders as "NaN" and reaches the engine.
        if (Number.isNaN(bent)) continue;
        clamped[k] = clampParam(k, bent, nodeType);
      }
      return withUndo({
        nodes: s.nodes.map((n) =>
          n.id === cmd.id
            ? armedIn(s, {
                ...n,
                params: { ...n.params, ...clamped },
                textParams: cmd.text ? { ...n.textParams, ...cmd.text } : n.textParams,
                ...(cmd.clearRegions && n.regions ? { regions: [] } : {}),
              })
            : n,
        ),
        images: s.images.map((i) =>
          i.id === s.activeImage ? { ...i, edited: true } : i,
        ),
      });
    }
    case "add_stroke":
      return withUndo({
        nodes: s.nodes.map((n) =>
          n.id === cmd.id
            ? { ...n, strokes: [...(n.strokes ?? []), cmd.stroke] }
            : n,
        ),
        images: s.images.map((i) =>
          i.id === s.activeImage ? { ...i, edited: true } : i,
        ),
      });
    case "clear_strokes":
      return withUndo({
        nodes: s.nodes.map((n) =>
          n.id === cmd.id ? { ...n, strokes: [] } : n,
        ),
      });
    case "set_tool": {
      // The Grid and Shape Warp tools arm on a target: the photograph's
      // own warp (null), or a Finish warp node. The tool already in hand
      // on another target moves there instead of going down, so a
      // layer's "edit" chip is never a put-down of another warp.
      const warpKind = cmd.tool === "gridwarp" ? "grid" : cmd.tool === "shapewarp" ? "shape" : null;
      const wantTarget: WarpTarget = warpKind ? (cmd.target ?? null) : null;
      const retarget = warpKind !== null && s.tool === cmd.tool && wantTarget !== s.warpTarget;
      // The eyedropper the same way: Pick pressed on another range mask
      // moves the dropper to it.
      const pickRetarget = cmd.tool === "pick" && s.tool === "pick" && cmd.node !== undefined && cmd.node !== pickMaskNode(s);
      const next = retarget || pickRetarget ? cmd.tool : s.tool === cmd.tool ? "none" : cmd.tool;
      // Arming a geometry tool records what it is about to change, so
      // escape has something to put back. Leaving it any other way is a
      // commit, and simply drops the snapshot.
      // Against the stand-in when the photo has no crop node yet: the
      // revert then records that there was nothing, so Escape after a
      // first drag takes the built node out rather than leaving an
      // identity crop in the graph.
      const geom = next === "crop" || next === "straighten" ? cropNode(s) : undefined;
      const arming = !!geom;
      // Grid Warp arms the same way: the mesh as it stands is what
      // Escape puts back, and a photo with no warp node yet records
      // that there was nothing, so cancel after a first drag takes the
      // built node out again.
      const warpPiece = next === "gridwarp" ? GRID_WARP_PIECE : next === "shapewarp" ? SHAPE_WARP_PIECE : null;
      const warpNode = warpPiece ? warpNodeFor(s, next === "gridwarp" ? "grid" : "shape", wantTarget) : undefined;
      const warping = warpPiece !== null;
      // A Finish warp that is not there has nothing to arm on.
      if (warping && wantTarget && !warpNode) return s;
      // Nor does a tool for the type a Finish warp has not chosen: it
      // would edit what the render does not apply.
      if (warping && wantTarget && warpNode) {
        const chosen = explicitWarpKind(warpNode);
        if (chosen && warpToolOf(chosen) !== next) return s;
      }
      // A move to another warp starts with nothing picked: the picks
      // named handles and shapes of the warp being left.
      const picksFrom = retarget
        ? { ...s, gridWarp: { ...s.gridWarp, selected: [], live: null }, shapeWarp: { ...s.shapeWarp, selected: null } }
        : s;
      // Polish is the same modal contract as the geometry tools, per
      // the layer editors: refine, then Apply or Cancel. What it
      // is about to change is the selection's strokes.
      const polishing = next === "polish" ? activeSelectionMask(s) : undefined;
      // Arming Shape Warp on a photo with shapes and nothing picked
      // picks the last one, so the mode chips, the wheel and the pad
      // have something to work on straight away.
      const shapeWarp =
        next === "shapewarp" && picksFrom.shapeWarp.selected === null && warpNode
          ? (() => {
              const list = shapesFromNode(warpNode);
              return list.length ? { ...picksFrom.shapeWarp, selected: list[list.length - 1].id } : picksFrom.shapeWarp;
            })()
          : picksFrom.shapeWarp;
      // Leaving polish any way but Cancel keeps the refinement: that is
      // Apply, and Apply solves the matte again at full resolution.
      const applied = s.tool === "polish" && next !== "polish" ? (s.toolRevert?.id ?? activeSelectionMask(s)?.id) : undefined;
      // Transform and Warp arm on the active Finish layer the same way
      // (2026-09-30, "Enter/Escape commit/cancel as the app's other
      // gizmos do"): its blend's params as they stand are what Escape
      // puts back. Switching between the two halves on the same layer
      // keeps the first snapshot, so Escape backs out of both.
      const artArm =
        (next === "transform" || next === "warp") && s.artActive ? artFindLayer(s, s.artActive) : undefined;
      const artRevert = artArm
        ? s.toolRevert?.art && s.toolRevert.id === artArm.carrier.id && (s.tool === "transform" || s.tool === "warp")
          ? s.toolRevert
          : { id: artArm.carrier.id, params: { ...artArm.carrier.params }, art: true }
        : null;
      return {
        ...s,
        tool: next,
        shapeWarp,
        gridWarp: picksFrom.gridWarp,
        warpTarget: warping ? wantTarget : null,
        pickNode: next === "pick" ? (cmd.node ?? null) : null,
        matteApply: applied
          ? { image: s.activeImage, node: applied, seq: (s.matteApply?.seq ?? 0) + 1 }
          : s.matteApply,
        // Leaving polish takes its PICK with it (see dropToolPicks).
        selection: dropToolPicks(s, next),
        toolRevert: arming
          ? {
              id: geom!.id,
              params: { ...geom!.params },
              fresh: !s.nodes.some((n) => n.id === geom!.id),
            }
          : polishing
            ? { id: polishing.id, strokes: [...(polishing.strokes ?? [])] }
            : warping
              ? {
                  id: warpNode?.id ?? warpPiece!.id,
                  enabled: warpNode?.enabled,
                  params: { ...(warpNode?.params ?? {}) },
                  textParams: { ...(warpNode?.textParams ?? {}) },
                  fresh: !warpNode,
                  // A Finish warp lives inside the Finish group, where
                  // Escape puts it back; one placed by hand in the graph
                  // is put back where it is, as the Develop warp is.
                  ...(wantTarget && artWarpNode(s, wantTarget) ? { art: true } : {}),
                }
              : artRevert,
      };
    }
    /// Escape means cancel, not "stop editing and keep what I dragged".
    /// The owner pressed it to back out of a crop and the crop was
    /// applied, which is the opposite of what every other tool in every
    /// other application does with that key.
    case "cancel_tool": {
      // Cancel on a Finish layer's mask polish: the document selection
      // back as it was and the layer never touched (polish_layer_mask).
      if (s.polishLayer && s.polishLayer.applying === 0 && s.tool === "polish") {
        return { ...cancelPolishLayer(s), selection: dropToolPicks(s, "none").filter((id) => id !== DOC_SEL_ID) };
      }
      // Cancel drops a polish pick the same way Apply does (see
      // dropToolPicks): a pick that outlives the pass hijacks the
      // resolver.
      const selection = dropToolPicks(s, "none");
      if (!s.toolRevert) return { ...s, tool: "none", selection };
      if (s.toolRevert.art) {
        const snap = s.toolRevert;
        const restored = updateArtNodeDeep(s, snap.id, (n) => ({
          ...n,
          params: { ...(snap.params ?? n.params) },
          // A Finish warp's mesh and shapes, and its switch.
          ...(snap.textParams ? { textParams: { ...snap.textParams } } : {}),
          ...(snap.enabled !== undefined ? { enabled: snap.enabled } : {}),
        }));
        return { ...(restored ?? s), tool: "none", selection, toolRevert: null };
      }
      const { id, params, strokes, fresh, textParams, enabled } = s.toolRevert;
      if (fresh) {
        return {
          ...s,
          tool: "none",
          selection,
          toolRevert: null,
          nodes: s.nodes.filter((n) => n.id !== id),
          wires: spliceOut(s.wires, id),
        };
      }
      return {
        ...s,
        tool: "none",
        selection,
        toolRevert: null,
        nodes: s.nodes.map((n) =>
          n.id === id
            ? params
              ? {
                  ...n,
                  params: { ...params },
                  ...(enabled !== undefined ? { enabled } : {}),
                  ...(textParams ? { textParams: { ...textParams } } : {}),
                }
              : { ...n, strokes: [...(strokes ?? [])] }
            : n,
        ),
        // A canceled warp drops its picks with the mesh they were on.
        gridWarp: textParams ? { ...s.gridWarp, selected: [] } : s.gridWarp,
      };
    }
    case "set_brush_radius":
      return { ...s, brushRadius: Math.min(0.3, Math.max(0.005, cmd.radius)) };
    case "set_brush_tip":
      return { ...s, brushTip: cmd.tip };
    case "set_brush_hardness":
      return { ...s, brushHardness: Math.min(1, Math.max(0, cmd.hardness)) };
    case "set_brush_texture_angle": {
      // Wrapped rather than clamped: turning a pattern past 180 should
      // come round the other side, not stop dead at the end.
      const wrapped = ((cmd.angle % 360) + 360) % 360;
      return { ...s, brushTextureAngle: wrapped > 180 ? wrapped - 360 : wrapped };
    }
    case "set_brush_show_dab":
      return { ...s, brushShowDab: cmd.show };
    case "set_brush_blur_build":
      return { ...s, brushBlurBuild: cmd.build };
    case "set_brush_sample_layer":
      return { ...s, brushSampleLayer: cmd.on };
    case "set_brush_blur_strength":
      // The same bounds the slider offers. They disagreed before: the control
      // ran to zero, the reducer floored at 0.05, and what got remembered was
      // the raw value rather than the clamped one. So a drag to the bottom
      // showed 5 all session and came back as 0, and the first nudge jumped
      // to 5 again as the clamp reapplied. "Blur slider is still
      // setting to 0 on restart."
      return { ...s, brushBlurStrength: clampBlurStrength(cmd.strength) };
    case "set_brush_overlay_strength":
      return { ...s, brushOverlayStrength: clampOverlayStrength(cmd.strength) };
    case "set_brush_clone_aligned":
      // Switching modes drops the remembered distance: the next stroke
      // establishes it again, or does not need it.
      return { ...s, brushCloneAligned: cmd.aligned, cloneOffset: null };
    case "set_brush_flow":
      // Never all the way to zero: a brush that paints nothing is
      // indistinguishable from a broken one.
      return { ...s, brushFlow: Math.min(1, Math.max(0.01, cmd.flow)) };

    // Selection geometry. Every one of these edits the stored shape
    // rather than any pixels, which is the whole point: a region drawn
    // last week is still a list of coordinates that can be moved.
    case "add_region":
      return withUndo({
        nodes: s.nodes.map((n) =>
          n.id === cmd.id
            ? {
                ...n,
                // "New" starts again, so the regions it supersedes go. The render was
                // already right, since replace discards whatever came before it, but the
                // outlines stayed on screen and in the list, so a new selection looked
                // like it had been added to the old one. "I noticed the New
                // mode is adding to current selection."
                //
                // Dropping them rather than hiding them, because a
                // region behind a replace can never affect the output
                // again and keeping it is just weight in the file.
                regions:
                  cmd.region.op === "replace"
                    ? [cmd.region]
                    : [...(n.regions ?? []), cmd.region],
                // The polish strokes go with them: they were painted to refine the OLD
                // edge, and against a new shape they are not refinement but sabotage: a
                // fresh freehand came out snapping to last week's photograph like a
                // magnetic lasso. "I just did a freehand selection and its
                // trying to act like a magnetic selection."
                ...(cmd.region.op === "replace" && n.strokes ? { strokes: [] } : {}),
              }
            : n,
        ),
        images: s.images.map((i) =>
          i.id === s.activeImage ? { ...i, edited: true } : i,
        ),
      });
    // Steering a region that already exists rather than adding another.
    // The range dialogs work this way: the sliders drive the real
    // region through the real engine, so what is on screen while the
    // dialog is open is the answer rather than a preview of it.
    case "update_region":
      return withUndo({
        nodes: s.nodes.map((n) =>
          n.id === cmd.id
            ? {
                ...n,
                regions: (n.regions ?? []).map((r, k) => (k === cmd.index ? cmd.region : r)),
              }
            : n,
        ),
      });
    case "remove_region":
      return withUndo({
        nodes: s.nodes.map((n) =>
          n.id === cmd.id
            ? { ...n, regions: (n.regions ?? []).filter((_, k) => k !== cmd.index) }
            : n,
        ),
      });
    // Reset means reset. The old version dispatched the numeric defaults and
    // nothing else, so on a brush mask (whose defaults are an empty object)
    // it did literally nothing, and on a selection mask it reset the feather
    // and left every region exactly where it was. "reset button
    // didn't work."
    case "reset_mask":
      return withUndo({
        nodes: s.nodes.map((n) =>
          n.id === cmd.id
            ? {
                ...n,
                params: { ...n.params, ...LAYER_MASK_DEFAULTS[cmd.maskType], invert: 0 },
                // The geometry too, which is the part that was being
                // left behind.
                ...(n.strokes ? { strokes: [] } : {}),
                ...(n.regions ? { regions: [] } : {}),
                // And the shape, or a reset radial stays a cross.
                ...(cmd.maskType === "radial"
                  ? { textParams: { ...n.textParams, shape: "ellipse" } }
                  : {}),
                // And a pixel mask's base: a reset brush is unpainted.
                ...(cmd.maskType === "brush" && n.type === "heeler.brush_mask"
                  ? { params: { ...n.params, ...LAYER_MASK_DEFAULTS.brush, invert: 0, base_invert: 0 }, textParams: { ...n.textParams, matte_id: "", base_selection: "" } }
                  : {}),
              }
            : n,
        ),
      });
    // The whole list at once. Canceling a range dialog needs this:
    // the range went in on "New", which drops whatever it superseded,
    // so removing just the range would leave the selection it replaced
    // gone for good and Cancel would be destructive.
    case "set_regions":
      return withUndo({
        nodes: s.nodes.map((n) => (n.id === cmd.id ? { ...n, regions: [...cmd.regions] } : n)),
      });
    case "clear_regions":
      // No guard here. There was one, refusing to empty a Finish layer's
      // mask, and it was the wrong fix for the right bug: it stopped the
      // pixels vanishing by stopping the deselect. "You changed
      // something that does not allow me to deselect when I've clicked on a
      // Lifted layer."
      //
      // Deselect works again because activeSelectionMask no longer
      // hands a layer's mask to anything that did not ask for it by
      // name. What reaches this case is a selection.
      return withUndo({
        nodes: s.nodes.map((n) =>
          // Deselect drops the polish strokes too: painted against a
          // selection that no longer exists, a surviving Add stroke
          // would paint a selection out of nothing. A BAKED base goes
          // the same way, and the smart recipe with it: a baked matte
          // does not derive from the geometry, so left behind it kept
          // the selection alive through its own Deselect. (A polish
          // matte_id stays: keyed by the geometry, it renders empty
          // once the regions are gone.)
          n.id === cmd.id
            ? {
                ...n,
                regions: [],
                ...(n.strokes ? { strokes: [] } : {}),
                ...((n.textParams?.matte_id ?? "").startsWith("baked:") ||
                (n.textParams?.prompts ?? "") !== "" ||
                (n.textParams?.mode ?? "") !== ""
                  ? {
                      textParams: {
                        ...n.textParams,
                        ...((n.textParams?.matte_id ?? "").startsWith("baked:")
                          ? { matte_id: "" }
                          : {}),
                        prompts: "",
                        mode: "",
                      },
                    }
                  : {}),
              }
            : n,
        ),
      });
    case "set_region_op":
      return withUndo({
        nodes: s.nodes.map((n) =>
          n.id === cmd.id
            ? {
                ...n,
                regions: (n.regions ?? []).map((r, k) =>
                  k === cmd.index ? { ...r, op: cmd.op } : r,
                ),
              }
            : n,
        ),
      });
    case "set_region_smooth":
      return withUndo({
        nodes: s.nodes.map((n) =>
          n.id === cmd.id
            ? {
                ...n,
                regions: (n.regions ?? []).map((r, k) =>
                  k === cmd.index && r.kind === "path"
                    ? { ...r, smooth: Math.min(1, Math.max(0, cmd.smooth)) }
                    : r,
                ),
              }
            : n,
        ),
      });
    // An off region keeps its geometry and its place in line; only its
    // vote is withheld. Undoable like any other edit to the list.
    case "set_region_off":
      return withUndo({
        nodes: s.nodes.map((n) =>
          n.id === cmd.id
            ? {
                ...n,
                regions: (n.regions ?? []).map((r, k) =>
                  k === cmd.index ? { ...r, off: cmd.off || undefined } : r,
                ),
              }
            : n,
        ),
      });
    // Order is meaning here: ops apply in sequence, so moving a
    // subtract above an add changes what survives.
    case "move_region":
      return withUndo({
        nodes: s.nodes.map((n) => {
          if (n.id !== cmd.id) return n;
          const regions = [...(n.regions ?? [])];
          if (
            cmd.from < 0 ||
            cmd.from >= regions.length ||
            cmd.to < 0 ||
            cmd.to >= regions.length ||
            cmd.from === cmd.to
          ) {
            return n;
          }
          const [moved] = regions.splice(cmd.from, 1);
          regions.splice(cmd.to, 0, moved);
          return { ...n, regions };
        }),
      });
    case "move_region_point":
      return withUndo({
        nodes: s.nodes.map((n) =>
          n.id === cmd.id
            ? {
                ...n,
                regions: (n.regions ?? []).map((r, k) =>
                  k === cmd.index && r.kind === "path"
                    ? {
                        ...r,
                        points: r.points.map((pt, j) =>
                          j === cmd.point
                            ? ([
                                Math.min(1, Math.max(0, cmd.x)),
                                Math.min(1, Math.max(0, cmd.y)),
                              ] as [number, number])
                            : pt,
                        ),
                      }
                    : r,
                ),
              }
            : n,
        ),
      });
    case "set_select_method":
      return { ...s, selectMethod: cmd.method };
    case "set_select_op":
      return { ...s, selectOp: cmd.op };
    case "set_select_tolerance":
      return { ...s, selectTolerance: Math.min(1, Math.max(0.01, cmd.tolerance)) };
    case "set_select_magnet_sense":
      return { ...s, selectMagnetSense: Math.min(1, Math.max(0, cmd.sense)) };
    // One press, factory dials. "a reset button to
    // restore a selection's control(s) back to original
    // setting."
    case "reset_select_settings":
      return { ...s, ...SELECT_DEFAULTS };
    // Folds to its bar and back; the dragged height survives the trip.
    // "if the split is resized it should remember that
    // when restoring from minimized."
    case "toggle_selection_split":
      return { ...s, selectionSplitMin: !s.selectionSplitMin };
    // The panel's door (2026-09-22): the select tool goes away and the
    // panel with it, and NOTHING else moves. It used to step off the
    // selection layer as well, and set_active_layer drops the layer's
    // pick with it, so the ants vanished and the layer went inactive:
    // "everything deselects", against the door's own hint. The layer
    // stays active and its selection stays; arming the select tool or
    // clicking a layer brings the panel back.
    case "close_selection_split": {
      const put = s.tool === "select" ? reduceInner(s, { type: "set_tool", tool: "none" }) : s;
      return { ...put, selectionSplitClosed: true };
    }
    case "set_select_smooth":
      return { ...s, selectSmooth: Math.min(1, Math.max(0, cmd.smooth)) };
    case "set_select_brush_radius":
      return { ...s, selectBrushRadius: Math.min(0.3, Math.max(0.005, cmd.radius)) };
    case "set_polish_open":
      // Polishing takes the viewer over, so it puts down whatever tool
      // was in hand: a crop rectangle over a matte would be nonsense.
      return { ...s, polishOpen: cmd.open, tool: cmd.open ? "none" : s.tool };
    case "set_polish_view":
      return { ...s, polishView: cmd.view };
    case "set_polish_radius":
      return { ...s, polishRadius: Math.min(0.3, Math.max(0.002, cmd.radius)) };
    case "set_polish_add":
      return { ...s, polishAdd: cmd.add };
    case "set_brush_texture":
      return {
        ...s,
        brushTextureScale:
          cmd.scale !== undefined
            ? Math.min(2, Math.max(0.02, cmd.scale))
            : s.brushTextureScale,
        brushTextureDepth:
          cmd.depth !== undefined
            ? Math.min(1, Math.max(0, cmd.depth))
            : s.brushTextureDepth,
      };
    case "arm_curve_pick": {
      // Re-arming the same target disarms: the button is a toggle, the
      // way the range picker's is.
      const same =
        s.curvePick?.nodeId === cmd.nodeId && s.curvePick?.channel === cmd.channel;
      return {
        ...s,
        curvePick: same ? null : { nodeId: cmd.nodeId, channel: cmd.channel },
        curveHoverX: null,
      };
    }
    case "arm_cset_dropper":
      // Same toggle contract as the curve pick's button.
      return { ...s, csetDropper: s.csetDropper === cmd.n ? null : cmd.n, csetHoverHue: null };
    case "toggle_cset_mask_view":
      // Turned on, the eye takes the frame (MASK_EYE_TAKES_FRAME).
      return s.csetMaskView === cmd.n
        ? { ...s, csetMaskView: null }
        : { ...s, csetMaskView: cmd.n, ...MASK_EYE_TAKES_FRAME };
    case "probe_node":
      // Same toggle contract as the mask eye: probing the probed node
      // stops the probe. Not undoable; it changes what you look at,
      // never what the photograph is.
      return { ...s, probeNode: s.probeNode === cmd.id ? null : cmd.id };
    case "ab_compare":
      // Branch A/B rides the probe's contract: view state, no undo.
      // Arming twice on the same node disarms; a completed pair with
      // either end gone (delete) is cleared by the viewer's own guard.
      if (cmd.value && s.abCompare?.a === cmd.value.a && s.abCompare?.b === cmd.value.b) {
        return { ...s, abCompare: null };
      }
      return { ...s, abCompare: cmd.value };
    case "set_harmony":
      // An aid's dial, not an edit: no undo, like the probe and A/B.
      return { ...s, harmony: { ...s.harmony, ...cmd.value } };
    case "toggle_spectrum_selection":
      return { ...s, spectrumSel: !s.spectrumSel };
    case "smart_select_ask":
      return { ...s, smartAsk: s.smartAsk + 1 };
    case "reset_settled":
      return { ...s, resetPending: s.resetPending.filter((i) => i !== cmd.id) };
    case "restore_settled":
      return { ...s, restorePending: s.restorePending.filter((i) => i !== cmd.id) };
    case "toggle_gamut_view":
      return { ...s, gamutView: !s.gamutView };
    case "toggle_tone_eq_pick":
      // Same node again disarms; a different node re-aims the picker.
      return { ...s, toneEqPick: s.toneEqPick === cmd.id ? null : cmd.id, toneEqHoverX: null };
    case "set_tone_eq_hover":
      return s.toneEqHoverX === cmd.x ? s : { ...s, toneEqHoverX: cmd.x };
    case "arm_wb_pick":
      // Arming one dropper disarms this one, and vice versa: two live
      // samplers would both answer the same click.
      return { ...s, wbPick: cmd.id, toneEqPick: null, curvePick: null };
    case "toggle_recolor_pick":
      // Pick and Match are one seat: arming either puts the other down.
      return { ...s, recolorPick: s.recolorPick === cmd.id ? null : cmd.id, recolorMatch: null, recolorHoverX: null };
    case "set_recolor_hover":
      return s.recolorHoverX === cmd.x ? s : { ...s, recolorHoverX: cmd.x };
    case "toggle_recolor_match":
      return {
        ...s,
        recolorMatch: s.recolorMatch?.id === cmd.id ? null : { id: cmd.id, source: null },
        recolorPick: null,
      };
    case "set_recolor_match_source":
      return s.recolorMatch ? { ...s, recolorMatch: { ...s.recolorMatch, source: cmd.source } } : s;
    case "toggle_bw_separate":
      // Pick and Separate are one seat, as Recolor's pair are.
      return { ...s, bwSeparate: s.bwSeparate ? null : { source: null }, bwPick: false, bwHoverHue: null };
    case "toggle_bw_pick":
      return { ...s, bwPick: !s.bwPick, bwHoverHue: null, bwSeparate: null };
    // The zone views are frame views like the depth eye, one at a time
    // with it; the hover is session state the ruler writes.
    case "toggle_zones_view":
      return { ...s, zonesView: !s.zonesView, depthView: false, halationView: false, collisionView: false };
    case "set_zone_hover":
      return s.zoneHover === cmd.zone ? s : { ...s, zoneHover: cmd.zone };
    // Choosing a zone on the ruler arms the placement with it; choosing
    // the armed zone again, or null, puts the picker down. A first spot
    // already landed stays through a change of zone: that is how the
    // second spot names its own zone.
    case "arm_zone_place":
      if (cmd.zone === null || (s.zonePlace?.zone === cmd.zone && !s.zonePlace.first)) return { ...s, zonePlace: null };
      return { ...s, zonePlace: { zone: cmd.zone, first: s.zonePlace?.first ?? null } };
    // A first spot landed: the zone is spent, and the next move is the
    // ruler's (2026-09-14: "That's not obvious in the UI"), so the
    // photograph takes no click until a zone is chosen again.
    case "set_zone_place_first":
      return s.zonePlace ? { ...s, zonePlace: { zone: cmd.first ? null : s.zonePlace.zone, first: cmd.first } } : s;
    case "toggle_zones_fold":
      return { ...s, zonesOpen: !s.zonesOpen };
    case "set_bw_hover":
      return s.bwHoverHue === cmd.hue ? s : { ...s, bwHoverHue: cmd.hue };
    case "set_cset_hover":
      if (s.csetDropper === null && cmd.hue !== null) return s;
      return s.csetHoverHue === cmd.hue ? s : { ...s, csetHoverHue: cmd.hue };
    case "set_bw_separate_source":
      return s.bwSeparate ? { ...s, bwSeparate: { source: cmd.source } } : s;
    case "set_recolor_cell":
      // The hover ghost belongs to the old cell's axis; keeping it
      // would draw a point on a curve it was never read for (the same
      // rule toggle_recolor_pick already follows).
      return { ...s, recolorCell: cmd.cell, recolorHoverX: null };
    case "set_console_band":
      return { ...s, consoleBand: cmd.id };
    case "toggle_console_pick": {
      const band = cmd.band ?? null;
      const same = s.consolePick === cmd.id && s.consolePickBand === band;
      return { ...s, consolePick: same ? null : cmd.id, consolePickBand: same ? null : band };
    }
    case "add_gamut_map_after": {
      // The gamut warning's one-click fix: a Gamut Map spliced onto the
      // named node's image output, so every consumer sees the eased
      // colors. Ordinary undoable graph surgery.
      const host = s.nodes.find((n) => n.id === cmd.id);
      if (!host) return s;
      const n =
        Math.max(
          0,
          ...s.nodes
            .filter((k) => k.id.startsWith("gamutmap_"))
            .map((k) => Number(k.id.replace("gamutmap_", "")) || 0),
        ) + 1;
      const id = `gamutmap_${n}`;
      const node: NodeCard = {
        id,
        type: "heeler.gamut_map",
        name: "Gamut Map",
        cat: "color",
        ...freeSpot(s.nodes, host.x + 180, host.y + 64),
        enabled: true,
        params: { amount: 100 },
        hasIn: true,
        hasOut: true,
        maskIn: true,
      };
      const wires: Wire[] = [
        ...s.wires.map((w) =>
          w.from === cmd.id && w.kind === "image" ? { ...w, from: id, fromPort: undefined } : w,
        ),
        { from: cmd.id, to: id, toPort: "in" as const, kind: "image" as const },
      ];
      return withUndo({
        nodes: [...s.nodes, node],
        wires,
        images: s.images.map((i) =>
          i.id === s.activeImage ? { ...i, edited: true } : i,
        ),
      });
    }
    case "art_add_fill_layer": {
      // The Fill brush's layer, whole: an inpaint content plus its
      // stroke mask, one undo entry for the arrangement (the
      // art_fill_from_selection bargain).
      const added = reduce(s, { type: "art_add_layer", kind: "fix" });
      const id = added.artActive;
      if (!id || added === s) return s;
      const masked = reduce(added, { type: "art_add_mask", id, kind: "fill" });
      return withUndo({
        nodes: masked.nodes,
        wires: masked.wires,
        artActive: masked.artActive,
        tool: "fill",
      });
    }
    case "art_add_smart_layer": {
      // The Smart selection's layer, whole ("make this its own
      // special layer, like Fill... It keeps these smart tools working alike
      // in Finish"): a Lift content - the picture below becomes this layer's
      // pixels - shown through a Smart mask, so the subject (or sky, or your
      // clicks) is its own live layer, with the same controls the Develop
      // smart layers wear.
      const added = reduce(s, { type: "art_add_layer", kind: "lift" });
      const id = added.artActive;
      if (!id || added === s) return s;
      const masked = reduce(added, { type: "art_add_mask", id, kind: "smart" });
      return withUndo({
        nodes: masked.nodes,
        wires: masked.wires,
        artActive: masked.artActive,
        tool: "smart",
      });
    }
    case "point_matte_at_bake": {
      // The matte brush's landing on a BAKED selection: the model
      // refined the baked base plus the regions and matte strokes, and
      // the result is a NEW baked base. The consumed geometry comes
      // off the node (it is IN the base now; left on, the engine would
      // apply the regions twice) while the strokes the engine still
      // applies itself - foreground, background, feather - stay. One
      // undoable step, so undo restores base and geometry together.
      const node = s.nodes.find((n) => n.id === cmd.id);
      if (!node || node.type !== "heeler.selection_mask") return s;
      return withUndo({
        nodes: s.nodes.map((n) =>
          n.id === cmd.id
            ? {
                ...n,
                textParams: { ...n.textParams, matte_id: `baked:${cmd.version}` },
                regions: [],
                strokes: (n.strokes ?? []).filter((k) =>
                  ["foreground", "background", "feather"].includes(
                    (k as { mode?: string }).mode ?? "",
                  ),
                ),
              }
            : n,
        ),
        images: s.images.map((i) =>
          i.id === s.activeImage ? { ...i, edited: true } : i,
        ),
      });
    }
    case "apply_preset": {
      // Replace the LOOK, keep the photograph's facts: the source,
      // crop, and lens keep the target's own params; the develop
      // layers and the Finish stack are lifted out whole and
      // re-spliced into the new chain; one undo restores everything.
      const preset = cmd.preset;
      if (!preset || preset.schema > PRESET_SCHEMA || !Array.isArray(preset.nodes)) return s;
      // A preset is a saved graph and takes the per-node repairs a
      // loaded one gets (blend names and the one-day fraction opacity,
      // the bend's renamed pull) and then the recipe blocks becoming
      // their nodes, so an old preset renders what it rendered when it
      // was saved. Not migrateGraph whole: its backfill stripping and
      // sample-dressing rules are about a photograph's own graph.
      const migrated = migrateRecipeBlocks(migrateNodes(structuredClone(preset.nodes)), structuredClone(preset.wires));
      // And the sample dressing, which every built-in carried until
      // 2026-09-04 and a user's preset saved in that window may still:
      // an empty group and a dead Merge are not a look.
      const legacy = stripSampleDressing(migrated.nodes, migrated.wires);
      let nodes: NodeCard[] = legacy.nodes;
      let wires: Wire[] = legacy.wires;
      // A preset must actually be a chain: no output node, no apply.
      if (!nodes.some((n) => n.type === "heeler.output")) return s;
      // A file that never went through capturePreset (hand-written,
      // shared, older than the strip list) can still point at the
      // author's per-image caches. Strip the same keys capture strips,
      // here at the door every apply walks through, so no apply ever
      // names a raster that never traveled.
      nodes = nodes.map((n) => {
        if (!n.textParams || !PRESET_STRIP_TEXT.some((k) => k in n.textParams!)) return n;
        const textParams = { ...n.textParams };
        for (const k of PRESET_STRIP_TEXT) delete textParams[k];
        return { ...n, textParams };
      });
      // The same door for the photograph's namespaces: a preset holds
      // no develop layers, no Finish stack, no document selection and
      // no removals, because capturePreset leaves them out; a file
      // carrying them anyway would collide with the transplants below
      // by id, and the photograph's own work is the one that stays.
      nodes = nodes.filter(presetKeepsNode);
      const kept = new Set(nodes.map((n) => n.id));
      wires = wires.filter((w) => kept.has(w.from) && kept.has(w.to));
      // The photo's facts: by stable chain id first, by type as the
      // fallback for hand-wired graphs.
      for (const t of PRESET_PHOTO_TYPES) {
        const target = s.nodes.find((n) => n.type === t);
        if (!target) {
          if ((t === "heeler.grid_warp" || t === "heeler.shape_warp")) nodes = nodes.map((n) => n.type === t ? { ...n, params: {}, textParams: undefined, enabled: false } : n);
          continue;
        }
        nodes = nodes.map((n) =>
          n.type === t
            ? { ...n, params: structuredClone(target.params), textParams: structuredClone(target.textParams), ...((t === "heeler.grid_warp" || t === "heeler.shape_warp") ? { enabled: target.enabled } : {}) }
            : n,
        );
        // A preset only carries the photo facts its AUTHOR'S graph had:
        // one saved before Geometry was ever opened holds no crop node
        // at all, and splicing it in whole would throw the target's
        // crop away. The contract is the opposite (the crop is the
        // photograph's), so a photo-fact node the target has and the
        // preset lacks goes back in, wired where the chain order seats
        // it. No seat (a hand-wired graph whose id the chain order
        // does not know) leaves it out rather than floating it.
        if (!nodes.some((n) => n.type === t)) {
          const wired = spliceIn(wires, target.id);
          if (wired !== wires) {
            nodes = [...nodes, structuredClone(target)];
            wires = wired;
          }
        }
      }
      // The develop layers, in their original chain order: walk the
      // TARGET's image chain from the splice anchor and collect each
      // layer group (all nodes sharing its prefix) with its wiring.
      const layerIds: string[] = [];
      {
        let cursor = "exposure";
        for (let guard = 0; guard < 200; guard++) {
          const next = s.wires.find((w) => w.from === cursor && w.kind === "image" && w.toPort !== "mask");
          if (!next) break;
          const num = layerNumber(next.to);
          if (num === null) break;
          const adjId = layerNodeId(num, "adj");
          if (!layerIds.includes(adjId)) layerIds.push(adjId);
          // Jump to the group's exit: the wire from a group member to a
          // non-member.
          const members = layerGroup(s, adjId);
          const exit = s.wires.find((w) => members.has(w.from) && !members.has(w.to) && w.kind === "image");
          if (!exit) break;
          cursor = exit.from;
        }
      }
      let anchor = "exposure";
      for (const adjId of layerIds) {
        const members = layerGroup(s, adjId);
        const group = s.nodes.filter(n => members.has(n.id));
        const inner = s.wires.filter((w) => members.has(w.from) && members.has(w.to));
        const entry = s.wires.find((w) => !members.has(w.from) && members.has(w.to) && w.kind === "image" && w.toPort !== "mask");
        const exit = s.wires.find((w) => members.has(w.from) && !members.has(w.to) && w.kind === "image");
        if (!entry || !exit) continue;
        const at = wires.find((w) => w.from === anchor && w.kind === "image" && w.toPort !== "mask");
        if (!at) continue;
        nodes = [...nodes, ...structuredClone(group)];
        wires = [
          ...wires.filter((w) => w !== at),
          ...structuredClone(inner),
          { ...wireSource(at), to: entry.to, toPort: entry.toPort, kind: "image" },
          { ...wireSource(exit), to: at.to, toPort: at.toPort, kind: "image" },
        ];
        anchor = exit.from;
      }
      // The Finish stack: the art group node, its masks, and their
      // wires, re-spliced before the output.
      const art = s.nodes.find((n) => n.id === ART_ID);
      if (art) {
        const artMasks = s.nodes.filter((n) => n.id.startsWith("art_m_"));
        const artIds = new Set([ART_ID, ...artMasks.map((n) => n.id)]);
        nodes = [...nodes, structuredClone(art), ...structuredClone(artMasks)];
        const output = nodes.find((n) => n.type === "heeler.output");
        const feed = output && wires.find((w) => w.to === output.id && w.kind !== "mask");
        if (output && feed) {
          // The stack's own wiring travels: every target wire touching
          // the stack whose both ends exist in the new graph, EXCEPT
          // the old chain splice (the image feed into the group and
          // its wire onward), which is rebuilt against the new chain.
          const exists = (id: string) => nodes.some((n) => n.id === id);
          const carried = s.wires.filter(
            (w) =>
              (artIds.has(w.from) || artIds.has(w.to)) &&
              exists(w.from) &&
              exists(w.to) &&
              !(w.to === ART_ID && w.kind === "image") &&
              !(w.from === ART_ID && w.kind === "image"),
          );
          wires = [
            ...wires.filter((w) => w !== feed),
            { ...wireSource(feed), to: ART_ID, toPort: "in", kind: "image" },
            { from: ART_ID, to: output.id, toPort: feed.toPort, kind: "image" },
            ...structuredClone(carried),
          ];
        }
      }
      // The photograph's own retouching crosses too. A removal (an
      // inpaint node and its hole) is dust taken off the photograph,
      // not a look, and the document selection is where Polish work
      // lives: neither is captured into a preset, and neither may be
      // lost by applying one. Each removal is re-spliced where it stood
      // against the Finish stack: a removal made before the stack sits
      // upstream of it and one made after sits between it and the
      // output, and that order is the photograph's. The hole comes with
      // its feed from the source and the mask wire into the removal;
      // the selection comes with its feed and whatever it was wired
      // into that crossed as well.
      {
        const exists = (id: string) => nodes.some((n) => n.id === id);
        const outputNode = nodes.find((n) => n.type === "heeler.output");
        const sourceId = nodes.find((n) => n.type === "heeler.image_source")?.id;
        const removals = s.nodes.filter(
          (n) => n.id.startsWith("inpaint_") && !n.id.startsWith("inpaint_m_"),
        );
        // Whether the photograph's image chain reaches the Finish stack
        // downstream of a node, which is what "before the stack" means.
        const reachesArt = (from: string): boolean => {
          const seen = new Set<string>();
          let cursor: string | undefined = from;
          while (cursor && !seen.has(cursor)) {
            seen.add(cursor);
            if (cursor === ART_ID) return true;
            cursor = s.wires.find((w) => w.from === cursor && w.kind === "image" && w.toPort !== "mask")?.to;
          }
          return false;
        };
        for (const removal of removals) {
          if (!outputNode || exists(removal.id)) continue;
          const beforeArt = exists(ART_ID) && reachesArt(removal.id);
          const feed = beforeArt
            ? wires.find((w) => w.to === ART_ID && w.kind === "image" && w.toPort === "in")
            : wires.find((w) => w.to === outputNode.id && w.kind !== "mask");
          if (!feed) continue;
          const seat = beforeArt ? ART_ID : outputNode.id;
          const holeId = removal.id.replace(/^inpaint_/, "inpaint_m_");
          const hole = s.nodes.find((n) => n.id === holeId);
          nodes = [...nodes, structuredClone(removal), ...(hole ? [structuredClone(hole)] : [])];
          const carried = s.wires.filter(
            (w) =>
              ((w.to === removal.id && w.toPort !== "in") || w.to === holeId) &&
              exists(w.from) &&
              exists(w.to),
          );
          const holeFed = carried.some((w) => w.to === holeId && w.toPort === "in");
          wires = [
            ...wires.filter((w) => w !== feed),
            { ...wireSource(feed), to: removal.id, toPort: "in", kind: "image" },
            { from: removal.id, to: seat, toPort: feed.toPort, kind: "image" },
            ...structuredClone(carried),
            ...(hole && !holeFed && sourceId
              ? [{ from: sourceId, to: holeId, toPort: "in", kind: "image" } as Wire]
              : []),
          ];
        }
        const doc = s.nodes.find((n) => n.id === DOC_SEL_ID);
        if (doc && !exists(DOC_SEL_ID)) {
          nodes = [...nodes, structuredClone(doc)];
          const carried = s.wires.filter(
            (w) => (w.from === DOC_SEL_ID || w.to === DOC_SEL_ID) && exists(w.from) && exists(w.to),
          );
          wires = [...wires, ...structuredClone(carried)];
        }
      }
      return withUndo({
        nodes,
        // The photograph's masks crossed over reading its frame; the
        // preset's chain may seat its geometry differently (lib.rs
        // masks_read_the_frame reads it the same way on arrival).
        wires: masksReadTheFrame(nodes, wires),
        // Nothing may keep pointing into the old graph.
        selection: [],
        toolRevert: null,
        ...PICKER_RESET,
        csetMaskView: null,
        probeNode: null,
        keyLightSel: null,
        images: s.images.map((i) => (i.id === s.activeImage ? { ...i, edited: true } : i)),
      });
    }
    case "load_selection_from_mask": {
      // Selection from Mask, the other direction from To Mask and the
      // last missing leg of the round trip: any mask's RENDER becomes
      // the document selection's baked base, editable on top with
      // marquees and dials, while the source mask stays exactly what
      // it was. The layer editors' Cmd-click-the-thumbnail, as a door here.
      const src = s.nodes.find((n) => n.id === cmd.maskId);
      if (!src || !src.type.endsWith("_mask") || cmd.maskId === DOC_SEL_ID) return s;
      const { state: withSel, id } = ensureDocSelection(s);
      return withUndo({
        ...withSel,
        nodes: withSel.nodes.map((n) =>
          n.id === id
            ? {
                ...n,
                params: { antialias: s.selectAntialias ? 1 : 0, invert: 0 },
                textParams: { matte_id: `baked:${cmd.version}` },
                regions: [],
              }
            : n,
        ),
        // The selection in hand, ants on screen, panel open.
        selection: [id],
        tool: "select",
        images: s.images.map((i) =>
          i.id === s.activeImage ? { ...i, edited: true } : i,
        ),
      });
    }
    case "polish_layer_mask": {
      // Select > Polish on a Finish layer's live mask (2026-10-02: "I went to
      // Select > Polish and the entire image has a red overlay. It's like
      // getting the polish tool from the menu doesn't recognize the smart
      // selection"). The documented route made one flow: Selection from Mask,
      // Polish, then Apply lands it back as Mask from selection would
      // (polish_layer_mask_land). A document selection that shows anything is
      // what Polish refines instead, so this refuses one; the menu's door
      // (polishSource) never sends it.
      if (s.polishLayer) return s;
      const mask = s.nodes.find((n) => n.id === cmd.maskId);
      if (!mask || !cmd.maskId.startsWith("art_m_") || !liveMaskHasContent(mask)) return s;
      const layerId = cmd.maskId.slice("art_m_".length);
      if (!artFindLayer(s, layerId)) return s;
      const before = s.nodes.find((n) => n.id === DOC_SEL_ID) ?? null;
      if (before && selectionShows(before)) return s;
      const loaded = reduceInner(s, { type: "load_selection_from_mask", maskId: cmd.maskId, version: cmd.version });
      if (loaded === s) return s;
      // load_selection_from_mask leaves the select tool in hand, so this
      // arms Polish rather than toggling it off.
      const armed = reduceInner({ ...loaded, tool: "select" }, { type: "set_tool", tool: "polish" });
      return {
        ...armed,
        // Picked, so the pass works on it whatever Develop layer is
        // active underneath (activeSelectionMask takes a pick first).
        selection: [...armed.selection.filter((id) => id !== DOC_SEL_ID), DOC_SEL_ID],
        // The pass is no step of its own: Apply makes it one, Cancel none
        // (and puts the redo steps back).
        undoStack: s.undoStack,
        redoStack: [],
        polishLayer: {
          image: s.activeImage,
          layerId,
          maskId: cmd.maskId,
          docSel: before,
          depth: s.undoStack.length,
          entry: snapshot(s, `Polish ${artLayerName(s, layerId)}'s mask`),
          redo: s.redoStack,
          applying: 0,
        },
      };
    }
    case "polish_layer_mask_land": {
      // Apply's landing: the polished selection becomes the layer's mask,
      // exactly what Mask from selection makes (a pixel mask at the
      // photograph's resolution, replacing the live mask), the document
      // selection goes back to what it was, and the whole pass is one
      // undo step that restores the live mask.
      const pass = s.polishLayer;
      if (!pass || pass.applying === 0 || pass.applying !== cmd.seq) return s;
      if (!cmd.version) {
        // The bake failed: the polished selection stays on screen as the
        // document selection, where Mask from selection can still take
        // it, and the steps the pass made stay on the history.
        return { ...s, polishLayer: null };
      }
      const made = reduceInner(s, {
        type: "art_mask_from_selection",
        id: pass.layerId,
        maskId: DOC_SEL_ID,
        version: cmd.version,
        op: "replace",
      });
      if (made === s) return { ...s, polishLayer: null };
      const restored = restoreDocSelection(made, pass);
      return {
        ...restored,
        // Apply puts the tool down; the brush Mask from selection arms
        // is not part of polishing.
        tool: s.tool,
        selection: s.selection.filter((id) => id !== DOC_SEL_ID),
        undoStack: [...s.undoStack.slice(0, pass.depth), pass.entry].slice(-HISTORY_LIMIT),
        redoStack: [],
        polishLayer: null,
        images: s.images.map((i) => (i.id === s.activeImage ? { ...i, edited: true } : i)),
      };
    }
    case "convert_mask_to_selection": {
      // Any mask becomes an editable selection mask wearing its own render
      // as a BAKED base (the owner, twice: "turn the smart selection into a
      // mask", then "polish a mask by converting it to a selection... when
      // you apply the selection it bakes back down into a mask"). The
      // desktop baked the render first and handed back the version this
      // points at; the conversion is in place, so there is no separate
      // bake-back - the selection IS the layer's mask, and undo restores the
      // old type whole. Invert resets: the render already carries it, and
      // keeping the flag would apply it twice. Judged by TYPE, not by port
      // flags: develop masks carry maskOut and Finish art masks carry
      // hasOut, and gating on one of them silently refused the other. the
      // owner, from the Finish tab: "To Mask still doesn't work... it
      // doesn't turn the smart selection into a traditional mask." A Develop
      // layer's door only since 2026-09-30 (its mask block's Polish, which
      // makes the layer a Selection layer, a kind of its own): a Finish
      // layer's mask is never a live selection, and To Mask makes pixels
      // (convert_mask_to_pixels).
      const mask = s.nodes.find((n) => n.id === cmd.maskId);
      if (!mask || mask.type === "heeler.selection_mask" || !mask.type.endsWith("_mask") || mask.id.startsWith("art_m_")) {
        return s;
      }
      return withUndo({
        nodes: s.nodes.map((n) =>
          n.id === cmd.maskId
            ? {
                ...n,
                type: "heeler.selection_mask",
                name: "Selection Mask",
                params: { antialias: s.selectAntialias ? 1 : 0, invert: 0 },
                textParams: { matte_id: `baked:${cmd.version}` },
                regions: [],
                strokes: [],
                curves: undefined,
              }
            : n,
        ),
        // The select tool in hand, pointed at the mask it now edits.
        selection: [cmd.maskId],
        tool: "select",
        images: s.images.map((i) =>
          i.id === s.activeImage ? { ...i, edited: true } : i,
        ),
      });
    }
    case "convert_mask_to_pixels": {
      // To Mask (2026-09-30: "I expect when I clicked To Mask that it made a
      // regular black and white mask ... I honestly thought that converted it
      // to a paintable mask"; "drop the live mask, make To Mask a pixel
      // mask"): a layer's Smart or Object mask becomes the pixel mask Add
      // layer mask makes, wearing its own render, which the desktop baked
      // first (bake_mask_raster), in place, so undo restores the old mask
      // whole. The brush in hand, pointed at it. A Develop layer becomes a
      // Brush layer the same way. Invert and the dials are in the render; the
      // Depth block multiplies after, so it stays.
      const mask = s.nodes.find((n) => n.id === cmd.maskId);
      if (
        !mask ||
        mask.id === DOC_SEL_ID ||
        mask.type === "heeler.brush_mask" ||
        !mask.type.endsWith("_mask")
      ) {
        return s;
      }
      const polarity = layerMaskPolarity(s, mask.id);
      return withUndo({
        nodes: s.nodes.map((n) =>
          n.id === cmd.maskId
            ? {
                ...pixelMaskWearing(n, cmd.version, polarity, n),
                name: n.id.startsWith("art_m_") ? "Layer Mask" : "Brush Mask",
              }
            : n,
        ),
        selection: [cmd.maskId],
        tool: "brush",
        images: s.images.map((i) =>
          i.id === s.activeImage ? { ...i, edited: true } : i,
        ),
      });
    }
    case "add_inpaint_for": {
      // Subject removal: an Inpaint node spliced into the END of the image
      // chain - the retouch region's place. The fill itself lands later
      // via the desktop; the splice is ordinary undoable graph surgery,
      // and undo removes it whole.
      //
      // The hole is a SNAPSHOT of the selection, not the live mask.
      // The live node used to be wired in, which made the user's own
      // selection a structural part of the removal: the panel froze
      // it to keep the hole stable, and the owner hit the wall hours
      // later with no visible cause - the selection should remain
      // clearable and refinable after object removal. He is right:
      // the Remove owns a copy of the selection AS IT WAS, and the
      // selection stays the user's to edit, clear, refine, forever.
      // Any mask can be the source now, not only a Smart one (The
      // report: "What is missing is doing an inpaint from a
      // selection"). The hole is a BAKED selection snapshot:
      // RemoveRunner renders the source mask, persists the raster,
      // and points matte_id at it - the same machinery To Mask uses,
      // so a drawn selection, a smart mask, or a brush mask all
      // freeze identically.
      const maskNode = s.nodes.find((n) => n.id === cmd.maskId);
      const output = s.nodes.find((n) => n.type === "heeler.output");
      if (!maskNode || !output) return s;
      const feed = s.wires.find((w) => w.to === output.id && w.kind !== "mask");
      if (!feed) return s;
      // One mask, many removals. The document selection is a single
      // node reused for every marquee, so removal ids take a suffix
      // when the plain one is spent; the true source rides in
      // textParams.source since the id no longer spells it. Only a
      // removal still computing refuses (that is a double click).
      if (removalPending(s, cmd.maskId)) return s;
      const base = `inpaint_${cmd.maskId}`;
      let id = base;
      for (let k = 2; s.nodes.some((n) => n.id === id); k++) id = `${base}_${k}`;
      const holeId = id.replace(/^inpaint_/, "inpaint_m_");
      const hole: NodeCard = {
        id: holeId,
        type: "heeler.selection_mask",
        name: "Removed Region",
        cat: "masking",
        x: output.x - 90,
        y: output.y + 220,
        enabled: true,
        params: { antialias: 1 },
        // Empty until the runner bakes the source mask's render and
        // points this at it.
        textParams: { matte_id: "" },
        regions: [],
        hasIn: true,
        maskOut: true,
      };
      const node: NodeCard = {
        id,
        type: "heeler.inpaint",
        name: "Inpaint",
        cat: "detail",
        x: output.x - 90,
        y: output.y + 120,
        enabled: true,
        params: {},
        textParams: { fill_id: "", model: "", source: cmd.maskId },
        hasIn: true,
        hasOut: true,
        maskIn: true,
      };
      // The snapshot reads the same image feed the live mask does, so
      // it rasterizes against the same pixels.
      const holeFeed =
        s.wires.find((w) => w.to === cmd.maskId && w.toPort === "in")?.from ??
        s.nodes.find((nd) => nd.type === "heeler.image_source")?.id;
      const wires: Wire[] = [
        ...s.wires.filter((w) => w !== feed),
        { ...wireSource(feed), to: id, toPort: "in", kind: "image" },
        { from: id, to: output.id, toPort: feed.toPort, kind: "image" },
        ...(holeFeed
          ? [{ from: holeFeed, to: holeId, toPort: "in", kind: "image" } as Wire]
          : []),
        { from: holeId, to: id, toPort: "mask", kind: "mask" },
      ];
      return withUndo({
        nodes: [...s.nodes, node, hole],
        wires,
        images: s.images.map((i) =>
          i.id === s.activeImage ? { ...i, edited: true } : i,
        ),
      });
    }
    case "remove_inpaint": {
      // A removal made from the DOCUMENT selection has no layer whose
      // deletion could take it along, so it needs its own door. The
      // report: "The effect of the remove persisted after I deleted the
      // layer. Even after I created and deleted a new Cutout layer."
      // Unsplice the inpaint, take its snapshot hole with it, heal the
      // chain around the gap. Undoable like the splice was.
      const node = s.nodes.find((n) => n.id === cmd.id && n.type === "heeler.inpaint");
      if (!node) return s;
      const dead = new Set([cmd.id]);
      const holeId = cmd.id.replace(/^inpaint_/, "inpaint_m_");
      if (s.nodes.some((n) => n.id === holeId)) dead.add(holeId);
      const din = s.wires.find((w) => w.to === cmd.id && w.toPort === "in");
      const dout = s.wires.find((w) => w.from === cmd.id && w.kind === "image");
      if (!din || !dout) return s;
      return withUndo({
        nodes: s.nodes.filter((n) => !dead.has(n.id)),
        wires: [
          ...s.wires.filter((w) => !dead.has(w.from) && !dead.has(w.to)),
          { ...wireSource(din), to: dout.to, toPort: dout.toPort, kind: "image" },
        ],
        selection: s.selection.filter((id) => !dead.has(id)),
        images: s.images.map((i) =>
          i.id === s.activeImage ? { ...i, edited: true } : i,
        ),
      });
    }
    // A render for free: nothing in the STATE changed, but something
    // the render READS did - a depth raster landing on disk is the
    // canonical case. The executor's content keys see the new plant
    // and recompute only what it feeds.
    case "poke_render":
      return { ...s, renderVersion: s.renderVersion + 1, previewNonce: s.previewNonce + 1 };
    // The depth view: the farness plane AS the frame (the owner, from a
    // color grader: "you can view the scene as a depth map"). Session state
    // like maskView, never saved.
    case "toggle_depth_view": {
      const views = { halationView: false, collisionView: false, zonesView: false };
      if (cmd.mask && cmd.flavor) {
        // 2026-09-29: "when holding a modifier and you click it shows the red
        // overlay like what masks on the Finish layers can do to review the
        // mask over the image ... handy when adjusting a depth mask levels".
        // The layer's (or set's) own mask node carries its selection times the
        // depth window, Levels and Invert: the one effective mask its
        // adjustment multiplies by, and the very view its mask eye shows. So
        // the modifier click is that eye in red, one path, never a second
        // picture. Already up in red, it turns black and white; the mask stays
        // up either way ("turning on the depth mask ... sometimes
        // caused the regular mask preview to turn off").
        if (depthMaskShown(s, cmd.mask) && s.maskRed) return { ...s, maskRed: false };
        const shown = showMaskView({ ...s, ...views, maskRed: true, depthView: false }, cmd.mask);
        if (previewTarget(shown) === cmd.mask) return shown;
      }
      if (cmd.flavor) {
        // The layer eye's contract: the modifier flips the one flavor
        // and makes sure the view is up to be seen in it.
        return { ...s, ...views, maskRed: !s.maskRed, depthView: true };
      }
      return { ...s, ...views, depthView: !s.depthView };
    }
    // The separation view: one frame view at a time, like the two
    // beside it.
    case "toggle_collision_view":
      return { ...s, collisionView: !s.collisionView, depthView: false, halationView: false, zonesView: false };
    case "set_collision_tolerance":
      return { ...s, collisionTolerance: Math.max(0, Math.min(COLLISION_TOLERANCE_MAX, Math.round(cmd.percent))) };
    case "recompute_depth":
      // The desktop has already forgotten the cached plane (the button
      // asks it to first); a new epoch is what makes the runner go
      // again for a photograph it has already marked done, and the
      // pending mark is what makes it go at all when no depth tool is
      // on to want the plane.
      return { ...s, depthEpoch: s.depthEpoch + 1, depthRecompute: s.activeImage };
    case "depth_settled":
      return s.depthRecompute === null ? s : { ...s, depthRecompute: null };
    case "file_passes_known":
      return s.filePasses?.image === cmd.image && JSON.stringify(s.filePasses.passes) === JSON.stringify(cmd.passes)
        ? s
        : { ...s, filePasses: { image: cmd.image, passes: cmd.passes } };
    case "toggle_halation_view":
      return { ...s, halationView: !s.halationView, depthView: false, collisionView: false, zonesView: false };
    // Find a Control: the Help-menu search. flash_control marks the
    // landing so the row wears the keyboard navigator's gold outline
    // for a beat; the panel clears it after the glance.
    case "toggle_find_control":
      return { ...s, findControlOpen: !s.findControlOpen };
    case "flash_control":
      return { ...s, controlFlash: { section: cmd.section, param: cmd.param } };
    case "clear_control_flash":
      return { ...s, controlFlash: null };
    // The two viewport pickers, mutually exclusive: the light rig's
    // handles and the one-click focus.
    case "toggle_keylight_pick":
      return { ...s, keyLightPick: !s.keyLightPick, dofPick: false };
    case "select_keylight":
      return { ...s, keyLightSel: cmd.index };
    case "toggle_dof_pick":
      return { ...s, dofPick: !s.dofPick, keyLightPick: false };
    // The chart overlay is a picker too: arming it puts every other
    // picker away through the epilogue, and Escape disarms it through
    // disarm_pickers with the rest.
    case "toggle_chart_place": {
      // Arming needs the node in the graph: the overlay's gate draws
      // nothing without it. The panel builds an off section on the way
      // through, so this refuses only a bare arm; putting the tool away
      // always works.
      if (!s.chartPlace && !s.nodes.some((n) => n.id === cmd.id)) return s;
      return { ...s, chartPlace: !s.chartPlace };
    }
    case "apply_calibration": {
      if (!Array.isArray(cmd.matrix) || cmd.matrix.length !== 9) return s;
      // One undo entry whether the section already exists or is created
      // here: the create pushes its own snapshot, so in that path the
      // write rides on top without a second push.
      const writeCalibration = (st: State): State => ({
        ...st,
        nodes: st.nodes.map((n) =>
          n.id === "colorchecker"
            ? {
                ...n,
                enabled: true,
                params: {
                  ...n.params,
                  m00: cmd.matrix[0],
                  m01: cmd.matrix[1],
                  m02: cmd.matrix[2],
                  m10: cmd.matrix[3],
                  m11: cmd.matrix[4],
                  m12: cmd.matrix[5],
                  m20: cmd.matrix[6],
                  m21: cmd.matrix[7],
                  m22: cmd.matrix[8],
                  exposure: cmd.exposure,
                },
                textParams: { ...n.textParams, chart: cmd.chart, fit: cmd.fit },
              }
            : n,
        ),
        images: st.images.map((i) => (i.id === st.activeImage ? { ...i, edited: true } : i)),
      });
      if (s.nodes.some((n) => n.id === "colorchecker")) {
        return withUndo(writeCalibration(s));
      }
      const created = reduceInner(s, { type: "set_category", title: "Color Checker", on: true });
      return writeCalibration(created);
    }
    case "set_curve_hover":
      return s.curvePick ? { ...s, curveHoverX: cmd.x } : s;
    case "set_curve_mode":
      // A way of looking at the curves: the photograph keeps its graph,
      // the preference keeps its value, and nothing is edited.
      return { ...s, curveMode: cmd.mode === "cmy" ? "cmy" : "rgb" };
    case "copy_curve":
      return { ...s, curveClipboard: structuredClone(cmd.clip) };
    case "copy_recolor_curve":
      return { ...s, recolorClipboard: structuredClone(cmd.clip) };
    case "set_pick_mode":
      return { ...s, pickMode: cmd.mode };
    case "set_pick_target":
      return { ...s, pickTarget: cmd.target };
    case "set_crop_aspect":
      return { ...s, cropAspect: cmd.aspect };
    case "set_panel_size": {
      return {
        ...s,
        panelSizes: {
          ...s.panelSizes,
          [cmd.panel]: clampPanelSize(s, cmd.panel, cmd.size),
        },
      };
    }
    // The layer-stack recipes. "Any category in the Develop that
    // is off by default should not create nodes until its been turned on.
    // Once on and turned back off preserve the nodes just disable them."
    //
    // Folding is layout only. Activating a category below remains an
    // undoable edit because it changes the graph.
    case "open_sections":
      return { ...s, sectionsClosed: s.sectionsClosed.filter((title) => !cmd.titles.includes(title)) };
    case "close_sections":
      return { ...s, sectionsClosed: [...new Set([...s.sectionsClosed, ...cmd.titles])] };
    case "toggle_section":
      return {
        ...s,
        sectionsClosed: s.sectionsClosed.includes(cmd.title)
          ? s.sectionsClosed.filter((t) => t !== cmd.title)
          : [...s.sectionsClosed, cmd.title],
      };
    // "when a user turns on a category it should auto open."
    // Separate from toggle_section and idempotent, because switching a
    // category on twice must not close it: a toggle here would be a coin
    // flip.
    case "open_section":
      return { ...s, sectionsClosed: s.sectionsClosed.filter((t) => t !== cmd.title) };
    // The Presets tab's shelf: seeded once per session from the first
    // listing, then folded and unfolded by hand. Seeding again is a
    // no-op, so a refresh cannot fold what the user opened.
    case "seed_preset_folds":
      return s.presetFolds === null ? { ...s, presetFolds: [...cmd.keys] } : s;
    case "toggle_preset_fold": {
      const folds = s.presetFolds ?? [];
      return {
        ...s,
        presetFolds: folds.includes(cmd.key) ? folds.filter((k) => k !== cmd.key) : [...folds, cmd.key],
      };
    }
    // Escape's first job: every armed picker, put away at once. One
    // command rather than one per dropper, so the key cannot miss the
    // picker that was added after it was written (2026-09-07: "not all
    // cancel with the ESC key"). The async sessions aimed through these
    // arms end on their own: the reducer's epilogue counts every arm that
    // goes from armed to not.
    case "disarm_pickers":
      return anyPickerArmed(s) ? { ...s, ...PICKER_RESET } : s;
    // "create custom properties on the container that output
    // to the properties of child nodes." The group holds its children, so
    // a published control writes inside the group rather than to a node
    // sitting in the main graph.
    case "set_published": {
      return withUndo({
        nodes: s.nodes.map((n) => {
          if (n.id !== cmd.id || !n.groupNodes) return n;
          const target = publishedTarget(n, cmd.label);
          if (!target) return n;
          // Every member the control lands on (Published.also).
          const writes = [target, ...(n.published?.find((p) => p.label === cmd.label)?.also ?? [])];
          return {
            ...n,
            groupNodes: n.groupNodes.map((child) => {
              const mine = writes.filter((t) => t.node === child.id);
              if (!mine.length) return child;
              return { ...child, params: { ...child.params, ...Object.fromEntries(mine.map((t) => [t.param, cmd.value])) } };
            }),
          };
        }),
      });
    }
    // Publishing (2026-10-01: "how can user create attributes on the group
    // node to control the whole network?"). Each is one undo step on the
    // group's face; a refusal says why in a notice and changes nothing.
    case "publish_param":
    case "unpublish_param":
    case "rename_published":
    case "move_published":
    case "set_published_range": {
      const g = s.nodes.find((n) => n.id === cmd.id);
      if (!g?.isGroup || !g.groupNodes) return s;
      const list = g.published ?? [];
      const refuse = (text: string): State => ({ ...s, notice: { text, at: Date.now() } });
      let next: Published[];
      if (cmd.type === "publish_param") {
        const r = publishParam(g, cmd.node, cmd.param, cmd.label);
        if ("error" in r) return refuse(r.error);
        next = r.published;
      } else {
        const control = list.find((p) => p.label === cmd.label);
        if (!control) return s;
        if (cmd.type === "unpublish_param") {
          next = unpublishParam(list, cmd.label, cmd.node !== undefined && cmd.param !== undefined ? { node: cmd.node, param: cmd.param } : undefined);
        } else if (cmd.type === "rename_published") {
          const to = cmd.to.trim();
          if (!to || to === cmd.label) return s;
          if (list.some((p) => p.label === to)) return refuse(`${g.name} already has a control called ${to}`);
          next = list.map((p) => (p === control ? { ...p, label: to } : p));
        } else if (cmd.type === "move_published") {
          const to = Math.max(0, Math.min(list.length - 1, Math.round(cmd.to)));
          const from = list.indexOf(control);
          if (to === from || !Number.isFinite(cmd.to)) return s;
          next = [...list];
          next.splice(from, 1);
          next.splice(to, 0, control);
        } else {
          if (control.options) return s;
          const range = cmd.range ?? publishedRange(g, control);
          if (!range.every(Number.isFinite) || range[0] >= range[1]) return refuse(`${cmd.label}'s low end must sit below its high end`);
          if (cmd.default !== undefined && cmd.default !== null && !Number.isFinite(cmd.default)) return s;
          const { default: _old, ...rest } = control;
          const dflt = cmd.default === undefined ? control.default : cmd.default ?? undefined;
          next = list.map((p) => (p === control ? { ...rest, range, ...(dflt !== undefined ? { default: dflt } : {}) } : p));
        }
      }
      return withUndo({ nodes: s.nodes.map((n) => (n.id === g.id ? { ...n, published: next } : n)) });
    }
    case "set_published_choice": {
      // A published menu (node recipes, 2026-09-30): the choice's
      // writes land on the members, numbers and words, as one step.
      const g = s.nodes.find((n) => n.id === cmd.id);
      const option = g?.published?.find((p) => p.label === cmd.label)?.options?.find((o) => o.label === cmd.choice);
      if (!g?.groupNodes || !option) return s;
      return withUndo({
        nodes: s.nodes.map((n) =>
          n.id !== cmd.id
            ? n
            : {
                ...n,
                groupNodes: n.groupNodes!.map((child) => {
                  const mine = option.writes.filter((w) => w.node === child.id);
                  if (!mine.length) return child;
                  const params = { ...child.params };
                  const textParams = { ...child.textParams };
                  for (const w of mine) {
                    if (typeof w.value === "string") textParams[w.param] = w.value;
                    else params[w.param] = w.value;
                  }
                  return { ...child, params, textParams };
                }),
              },
        ),
      });
    }
    case "set_recipe": {
      if (cmd.recipe === "denoise" && denoiseMethodIsModel(s.nodes)) {
        // Model is the method: the section's switch is the model
        // node's; the classic pair stays bypassed either way.
        const next = applyRecipe(s.nodes, s.wires, "denoise", false);
        return withUndo({
          nodes: next.nodes.map((n) => (n.id === MODEL_DENOISE_ID ? { ...n, enabled: cmd.on } : n)),
          wires: next.wires,
        });
      }
      const next = applyRecipe(s.nodes, s.wires, cmd.recipe, cmd.on);
      return withUndo({
        ...next,
      });
    }
    case "set_denoise_method": {
      const on = denoiseSectionOn(s.nodes);
      let nodes = s.nodes;
      let wires = s.wires;
      if (!nodes.some((n) => n.id === MODEL_DENOISE_ID)) {
        const built = buildCategoryPiece(nodes, wires, MODEL_DENOISE_PIECE);
        nodes = built.nodes.map((n) =>
          n.id === MODEL_DENOISE_ID ? { ...n, params: { ...n.params, luminance: 50, chroma: 50, detail: 50 } } : n,
        );
        wires = built.wires;
      }
      if (cmd.model) {
        nodes = nodes.map((n) =>
          n.id === MODEL_DENOISE_ID
            ? { ...n, enabled: on, params: { ...n.params, method: 1 } }
            : isRecipeNode(n.id) && n.id.startsWith("dn_")
              ? { ...n, enabled: false }
              : n,
        );
        return withUndo({ nodes, wires });
      }
      nodes = nodes.map((n) => (n.id === MODEL_DENOISE_ID ? { ...n, enabled: false, params: { ...n.params, method: 0 } } : n));
      if (on) {
        const next = applyRecipe(nodes, wires, "denoise", true);
        nodes = next.nodes;
        wires = next.wires;
      }
      return withUndo({ nodes, wires });
    }
    case "add_color_set": {
      const next = addColorSet(s.nodes, s.wires);
      if (!next) return s;
      // Migrated for the same reason add_node migrates: the pair is
      // seeded with the strip's params, and the Inspector needs the
      // grade's full identity set to draw every control.
      return withUndo({ nodes: migrateNodes(next.nodes), wires: next.wires });
    }
    case "remove_color_set":
      // Deleting the set unplugs anything aimed at it: the armed dropper
      // ("the picker tool stays active. My cursor does not
      // reset until I add a new color set") and the mask eye, whose node
      // just left the graph.
      return withUndo({
        ...removeColorSet(s.nodes, s.wires, cmd.n),
        ...(s.csetDropper === cmd.n ? { csetDropper: null, csetHoverHue: null } : null),
        ...(s.csetMaskView === cmd.n ? { csetMaskView: null } : null),
      });
    case "set_category": {
      const pieces = CATEGORY_PIECES[cmd.title] ?? [];
      if (!pieces.length) return s;
      let nodes = s.nodes;
      let wires = s.wires;
      for (const p of pieces) {
        const have = nodes.find((n) => n.id === p.id);
        if (have) {
          // Off does not mean gone. "Once on and turned back off
          // preserve the nodes just disable them." The settings on a node are work
          // somebody did, and a switch is not a request to throw that away.
          nodes = nodes.map((n) => (n.id === p.id ? { ...n, enabled: cmd.on } : n));
          continue;
        }
        if (!cmd.on) continue;
        ({ nodes, wires } = buildCategoryPiece(nodes, wires, p));
        // The Depth Map is born with the preference's defaults, not the
        // registry's: the preference IS "what a new photograph starts with"
        // (2026-09-05).
        if (p.type === "heeler.depth_map") {
          nodes = nodes.map((n) =>
            n.id === p.id ? { ...n, params: { ...n.params, ...depthMapParams(s.prefs) } } : n,
          );
        }
        // The flare is born with the rig Depth Lighting already holds,
        // so a light switched to flare before the section existed is
        // there when it does.
        if (p.id === "flare") {
          const rig = nodes.find((n) => n.id === "keylight")?.textParams?.lights;
          // ...and wearing the Modern prime look: a flare with no rays and
          // no ghosts is a faint veil, which read as nothing at all.
          const prime = FLARE_PRESETS.find((f) => f.id === "prime");
          nodes = nodes.map((n) =>
            n.id === "flare"
              ? {
                  ...n,
                  params: { ...n.params, ...(prime?.params ?? {}) },
                  textParams: {
                    ...n.textParams,
                    ...(rig ? { lights: rig } : {}),
                    ...(prime ? { preset: prime.id } : {}),
                  },
                }
              : n,
          );
        }
      }
      return withUndo({
        nodes,
        wires,
        // "when a user turns on a category it should auto open." Turning
        // something on and being shown nothing is the switch not answering. A
        // preference now, off by default: the owner came to prefer a section that
        // stays as it was, and left the unfolding for those who want it.
        sectionsClosed: cmd.on && s.prefs.expandSectionOnEnable
          ? s.sectionsClosed.filter((t) => t !== cmd.title)
          : s.sectionsClosed,
        // The warp switched off takes its handles down with it.
        ...(!cmd.on && ((cmd.title === "Grid Warp" && s.tool === "gridwarp") || (cmd.title === "Shape Warp" && s.tool === "shapewarp"))
          ? droppedGridWarpTool(s)
          : {}),
      });
    }
    case "toggle_multi_take": {
      const on = s.multiTakes.includes(cmd.takeId);
      if (on) {
        const next = s.multiTakes.filter((id) => id !== cmd.takeId);
        // One take left is not a comparison, so it goes back to the plain
        // viewer rather than leaving a single cell in a grid of one.
        return { ...s, multiTakes: next.length > 1 ? next : [] };
      }
      if (s.multiTakes.length >= MULTI_MAX) return s;
      // Turning the first one on brings the active take with it: nobody
      // means "show me take 3 on its own" by asking to compare.
      const base = s.multiTakes.length
        ? s.multiTakes
        : [s.activeTakes[s.activeImage] ?? "take_1"];
      if (base.includes(cmd.takeId)) return s;
      return { ...s, multiTakes: [...base, cmd.takeId] };
    }
    case "clear_multi_takes":
      return { ...s, multiTakes: [] };

    // Splitting the right panel, and unsplitting it when the split stops
    // meaning anything.
    //
    // "Make sure the UI is smart so if someone splits the
    // panel to move down history. Then they move the other 3 tabs to
    // the bottom split it is smart enough to collapse the top split
    // and basically restore the right panel to what it should be."
    //
    // Which falls out of one rule: a pane with no tabs in it is not a
    // pane. Moving the last tab out of the top collapses the split rather
    // than leaving an empty box above a full one, and the same rule
    // handles the other direction without a second branch.
    case "move_tab_down": {
      if (s.panelBottom.includes(cmd.tab)) return s;
      // A gated tab (Tether with experimental features off) has no pane
      // to move into.
      if (!visiblePanelTabs(s.prefs).some((t) => t.id === cmd.tab)) return s;
      const bottom = PANEL_TABS.map((t) => t.id).filter(
        (id) => id === cmd.tab || s.panelBottom.includes(id),
      );
      // Everything is downstairs, so upstairs is gone: one pane again,
      // showing whatever was moved last.
      if (bottom.length >= PANEL_TABS.length) {
        return { ...s, panelBottom: [], panelTab: cmd.tab };
      }
      const top = PANEL_TABS.map((t) => t.id).filter((id) => !bottom.includes(id));
      return {
        ...s,
        panelBottom: bottom,
        panelTabBottom: cmd.tab,
        // The tab that left cannot still be the one on show above it.
        panelTab: top.includes(s.panelTab) ? s.panelTab : top[0],
      };
    }
    case "move_tab_up": {
      const bottom = s.panelBottom.filter((id) => id !== cmd.tab);
      if (bottom.length === s.panelBottom.length) return s;
      if (!visiblePanelTabs(s.prefs).some((t) => t.id === cmd.tab)) return s;
      if (bottom.length === 0) {
        // Nothing left below: back to a single pane, showing the tab that
        // just came up rather than whatever the top happened to be on.
        return { ...s, panelBottom: [], panelTab: cmd.tab };
      }
      return {
        ...s,
        panelBottom: bottom,
        panelTab: cmd.tab,
        panelTabBottom: bottom.includes(s.panelTabBottom) ? s.panelTabBottom : bottom[0],
      };
    }
    case "set_panel_tab_bottom":
      if (!visiblePanelTabs(s.prefs).some((t) => t.id === cmd.tab)) return s;
      return { ...s, panelTabBottom: cmd.tab };
    case "set_ribbon_view":
      return { ...s, ribbonView: cmd.view };
    // The window's room, from its resize and the app zoom. Pins last
    // only while they are needed: once the window holds every panel the
    // saved layout has open, they clear, and the next squeeze folds in
    // the usual order again.
    case "set_layout_room": {
      if (!Number.isFinite(cmd.width) || !Number.isFinite(cmd.zoom) || cmd.width <= 0 || cmd.zoom <= 0) return s;
      const width = Math.round(cmd.width);
      const room = s.layoutRoom;
      let next: State = room && room.width === width && room.zoom === cmd.zoom ? s : { ...s, layoutRoom: { width, zoom: cmd.zoom } };
      if (next.layoutPinned.length > 0 && layoutFitOf(next, [])!.folded.length === 0) {
        next = { ...next, layoutPinned: [] };
      }
      return next;
    }
    case "toggle_ribbon_expanded":
      // Expanding hides the viewport, so a tool that draws on the
      // photograph has nothing to draw on. Put it down rather than
      // leaving it armed against a viewer that is not there.
      return {
        ...s,
        ribbonExpanded: !s.ribbonExpanded,
        tool: s.ribbonExpanded ? s.tool : "none",
        // Collapsing the panel ends any catalog compare session with it.
        catalogCompare: s.ribbonExpanded ? null : s.catalogCompare,
      };
    case "set_ribbon_sort": {
      // A direction on its own is the thumbnail strip's arrows: they
      // set which way, never which key, so the table's column survives
      // a trip through the thumbnails and back.
      if (cmd.desc !== undefined) {
        return { ...s, ribbonSort: { column: cmd.column ?? s.ribbonSort.column, desc: cmd.desc } };
      }
      // Clicking the column you are already sorted by turns it around,
      // which is what every table in the world does.
      return {
        ...s,
        ribbonSort:
          s.ribbonSort.column === cmd.column
            ? { column: cmd.column, desc: !s.ribbonSort.desc }
            : { column: cmd.column!, desc: false },
      };
    }
    // The three curve commands reach inside the Finish group as well as
    // across the top-level graph.
    //
    // A Curves ADJUSTMENT LAYER is a node living inside that group, and
    // these only ever walked s.nodes, so every drag on the curve landed
    // on nothing. The editor drew, the points moved under the cursor,
    // and the photograph never changed. The curve editor looked good
    // but could not edit the layer as it could in the Adjustments tab.
    // Because it was dispatching into the void.
    case "set_curve":
    case "reset_curves":
    case "set_curve_interp": {
      // A curve pulled off the diagonal is an edit the user expects to SEE,
      // so it arms a bypassed node the same way a slider leaving zero does.
      // Without this, dragging a curve on a disabled Curves node changed the
      // state and nothing else, which read as the editor being broken. The
      // report: "Curves still doesn't work."
      const bent = (curve: [number, number][]) =>
        curve.length !== 2 || curve.some(([x, y]) => Math.abs(x - y) > 0.001);
      const edit = (n: NodeCard): NodeCard =>
        cmd.type === "set_curve"
          ? {
              ...n,
              enabled: n.enabled || bent(cmd.curve),
              curves: { ...n.curves, [cmd.channel]: cmd.curve },
              ...(cmd.tangents
                ? { curveTangents: { ...n.curveTangents, [cmd.channel]: cmd.tangents } }
                : {}),
              ...(cmd.handles
                ? { curveHandles: { ...n.curveHandles, [cmd.channel]: cmd.handles } }
                : {}),
            }
          : cmd.type === "reset_curves"
            ? { ...n, curves: {}, curveTangents: {}, curveHandles: {} }
            : { ...n, curveInterp: cmd.interp, ...(n.type === "heeler.black_white" ? { textParams: withOwnFaces(n) } : {}) };
      const touched = s.nodes.some((n) => n.id === cmd.id);
      if (!touched) {
        const deep = updateArtNodeDeep(s, cmd.id, edit);
        if (deep) {
          return withUndo({
            nodes: deep.nodes,
            images: s.images.map((i) => (i.id === s.activeImage ? { ...i, edited: true } : i)),
          });
        }
        // A curve edit for an on-demand node nobody has built yet:
        // build it first, exactly as its category switch would, then
        // apply. The eyedropper stays armed across an undo or a take
        // switch, and its commit must land somewhere real either way.
        const cat = CATEGORY_OF[cmd.id];
        const piece = cat
          ? CATEGORY_PIECES[cat]?.find((p) => p.id === cmd.id)
          : undefined;
        if (piece) {
          const built = buildCategoryPiece(s.nodes, s.wires, piece);
          return withUndo({
            nodes: built.nodes.map((n) => (n.id === cmd.id ? edit(n) : n)),
            wires: built.wires,
            images: s.images.map((i) => (i.id === s.activeImage ? { ...i, edited: true } : i)),
          });
        }
      }
      return withUndo({
        nodes: s.nodes.map((n) => (n.id === cmd.id ? edit(n) : n)),
        images: s.images.map((i) => (i.id === s.activeImage ? { ...i, edited: true } : i)),
      });
    }
    case "set_text_param": {
      if (!s.nodes.some((n) => n.id === cmd.id)) {
        const deep = updateArtNodeDeep(s, cmd.id, (n) => ({ ...n, textParams: { ...n.textParams, [cmd.param]: cmd.value } }));
        if (deep) return withUndo({ nodes: deep.nodes, images: s.images.map((i) => i.id === s.activeImage ? { ...i, edited: true } : i) });
      }
      // The Depth Lighting rig lives on two nodes: the key light that shades
      // by it and the flare that draws it. A write to either's `lights`
      // lands on both, in the same scope (the main chain's pair, or a
      // layer's pair), the Color Sets pair's rule for a number two nodes
      // must agree on.
      const rigTwin = (() => {
        if (cmd.param !== "lights") return undefined;
        const me = s.nodes.find((n) => n.id === cmd.id);
        if (!me) return undefined;
        const other =
          me.type === "heeler.key_light" ? "flare" : me.type === "heeler.flare" ? "keylight" : undefined;
        if (!other) return undefined;
        const twinId = isLayerNode(cmd.id)
          ? layerLightingTwin(cmd.id, other)
          : other;
        return s.nodes.some((n) => n.id === twinId) ? twinId : undefined;
      })();
      return withUndo({
        nodes: s.nodes.map((n) => {
          if (n.id === rigTwin) {
            return { ...n, textParams: { ...n.textParams, lights: cmd.value } };
          }
          if (n.id !== cmd.id) return n;
          const next = {
            ...n,
            textParams: { ...n.textParams, [cmd.param]: cmd.value },
          };
          // The Color Tune's bands and Recolor's curves are the whole
          // statement those nodes make, and both arrive as text, which
          // armed() never sees. Writing one into a bypassed node flips
          // it on, the same bargain the numeric params get; emptying
          // one never flips it back off.
          const arming =
            (n.type === "heeler.color_console" && cmd.param === "bands") ||
            (n.type === "heeler.recolor" && (cmd.param === "curves" || cmd.param === "surfaces")) ||
            (n.type === "heeler.black_white" && cmd.param === "hue_curve");
          return arming && !next.enabled && cmd.value.trim() !== "" && !layerIsOff(s, n.id)
            ? { ...next, enabled: true }
            : next;
        }),
        images: s.images.map((i) =>
          i.id === s.activeImage ? { ...i, edited: true } : i,
        ),
      });
    }
    case "toggle_brush_swap":
      return { ...s, brushSwap: !s.brushSwap };
    case "toggle_mask_view":
      // Turned on, the eye takes the frame (MASK_EYE_TAKES_FRAME).
      return s.maskView ? { ...s, maskView: false } : { ...s, maskView: true, ...MASK_EYE_TAKES_FRAME };
    case "toggle_mask_flavor":
      // The owner's compromise, replacing the two-chip design: ONE app-wide
      // flavor (alpha black/white, or the red overlay) that every mask
      // preview honors - the layer view, the Color Sets eye, the armed
      // eyedropper. ALT/CMD-click on any Show mask button flips it; this
      // command is only that flip, so the Color Sets eye can switch flavor
      // without dragging the LAYER mask view on.
      return { ...s, maskRed: !s.maskRed };
    case "set_folders":
      return { ...s, folders: cmd.folders };
    case "set_folder_tree":
      return { ...s, folderTree: cmd.root };
    case "set_tree_node": {
      if (!s.folderTree) return s;
      return {
        ...s,
        folderTree: updateTreeNode(s.folderTree, cmd.path, (n) => ({
          ...n,
          expanded: cmd.expanded ?? n.expanded,
          children: cmd.children
            ? mergeTreeChildren(n.children, cmd.children)
            : n.children,
        })),
      };
    }
    case "set_collections":
      return { ...s, collections: cmd.collections };
    case "set_edited_folders":
      return { ...s, editedFolders: cmd.paths };
    case "set_folders_with_hidden":
      return { ...s, foldersWithHidden: cmd.paths };
    case "set_folders_with_trash":
      return { ...s, foldersWithTrash: cmd.paths };
    case "set_missing_trashed":
      return { ...s, missingTrashed: { count: cmd.count, skipped: cmd.skipped } };
    case "set_thumb_progress":
      return { ...s, thumbProgress: cmd.progress };
    case "set_stitch_progress": {
      // A stitch running for a canceled panorama (its recipe changed, or
      // Stitch again) means it is not canceled any more.
      const running = cmd.progress && cmd.progress.error === null && !cmd.progress.canceled;
      if (running && s.stitchCanceled[cmd.progress!.image]) {
        const stitchCanceled = { ...s.stitchCanceled };
        delete stitchCanceled[cmd.progress!.image];
        return { ...s, stitch: cmd.progress, stitchCanceled };
      }
      return { ...s, stitch: cmd.progress };
    }
    case "set_baking":
      return s.baking === cmd.id ? s : { ...s, baking: cmd.id };
    case "set_stitch_canceled": {
      const stitchCanceled = { ...s.stitchCanceled };
      if (cmd.on) stitchCanceled[cmd.image] = true;
      else delete stitchCanceled[cmd.image];
      return { ...s, stitchCanceled };
    }
    case "resume_pano_stitch": {
      const stitchCanceled = { ...s.stitchCanceled };
      delete stitchCanceled[cmd.image];
      return { ...s, stitchCanceled, stitch: s.stitch?.image === cmd.image ? null : s.stitch, previewNonce: s.previewNonce + 1 };
    }
    case "set_stack_progress": {
      const stackMerges = { ...s.stackMerges };
      if (cmd.progress) stackMerges[cmd.image] = cmd.progress;
      else delete stackMerges[cmd.image];
      // A merge running for a canceled stack (its recipe changed, or
      // Merge again) means it is not canceled any more.
      if (cmd.progress && s.stackCanceled[cmd.image]) {
        const stackCanceled = { ...s.stackCanceled };
        delete stackCanceled[cmd.image];
        return { ...s, stackMerges, stackCanceled };
      }
      return { ...s, stackMerges };
    }
    case "set_stack_canceled": {
      const stackCanceled = { ...s.stackCanceled };
      if (cmd.on) stackCanceled[cmd.image] = true;
      else delete stackCanceled[cmd.image];
      return { ...s, stackCanceled };
    }
    case "resume_stack_merge": {
      const stackCanceled = { ...s.stackCanceled };
      delete stackCanceled[cmd.image];
      return { ...s, stackCanceled, previewNonce: s.previewNonce + 1 };
    }
    case "tick_thumb_progress": {
      if (!s.thumbProgress) return s;
      const done = s.thumbProgress.done + 1;
      // Auto-clears when the queue drains.
      return {
        ...s,
        thumbProgress:
          done >= s.thumbProgress.total ? null : { ...s.thumbProgress, done },
      };
    }
    case "set_library":
      return {
        ...s,
        libraryLabel: cmd.label,
        activeCollection: cmd.collection,
        activeFolderPath:
          cmd.path === undefined ? s.activeFolderPath : cmd.path,
      };
    case "set_filter_takes": {
      // Dragging one end past the other would silently show nothing, so
      // the ends push rather than cross.
      let min = Math.max(
        1,
        Math.min(TAKE_CAP, cmd.min ?? s.filterTakesMin),
      );
      let max = Math.max(
        1,
        Math.min(TAKE_CAP, cmd.max ?? s.filterTakesMax),
      );
      if (cmd.min !== undefined) max = Math.max(max, min);
      else min = Math.min(min, max);
      return { ...s, filterTakesMin: min, filterTakesMax: max };
    }
    // Arrow-key culling: the ribbon is the list, so up and down walk it.
    // It steps through what is VISIBLE, not through every image, or a
    // filtered ribbon would jump to photos that are not on screen.
    case "step_image": {
      const visible = visibleImages(s);
      if (visible.length === 0) return s;
      const at = visible.findIndex((i) => i.id === s.activeImage);
      // Nothing active yet: the first arrow lands on an end rather than
      // doing nothing.
      const next =
        at < 0 ? (cmd.delta > 0 ? 0 : visible.length - 1) : at + cmd.delta;
      // Stops at the ends rather than wrapping: wrapping past the last
      // frame of a shoot to the first is disorienting when you are
      // stepping through looking for one photograph.
      const clamped = Math.min(visible.length - 1, Math.max(0, next));
      return reduce(s, { type: "select_image", id: visible[clamped].id });
    }
    case "set_panel_tab":
      // A gated tab cannot take the seat: the strip has no button for
      // it, and a command naming it anyway lands nowhere.
      if (!visiblePanelTabs(s.prefs).some((t) => t.id === cmd.tab)) return s;
      return { ...s, panelTab: cmd.tab };
    // Develop, Graph, Canvas, and round again. Wrapping is right here,
    // unlike stepping through photographs: there are three of them and
    // you can see which one you are in.
    case "cycle_mode": {
      const order: Mode[] = ["simple", "advanced", "canvas"];
      const at = order.indexOf(s.mode);
      const next = order[(at + cmd.delta + order.length) % order.length];
      return reduce(s, { type: "set_mode", mode: next });
    }
    case "set_spectrums_popped_out":
      return { ...s, spectrumsPoppedOut: cmd.out };
    case "set_takes_popped_out":
      return { ...s, takesPoppedOut: cmd.out };
    case "set_console_window":
      return s.consoleWindowOpen === cmd.open ? s : { ...s, consoleWindowOpen: cmd.open };
    // A pinned section rides the preferences, in the order pinned; the
    // membership flip quadEdit's pins use.
    case "toggle_pinned_section": {
      const pinned = s.prefs.pinnedSections.includes(cmd.title)
        ? s.prefs.pinnedSections.filter((t) => t !== cmd.title)
        : [...s.prefs.pinnedSections, cmd.title];
      return { ...s, prefs: { ...s.prefs, pinnedSections: pinned } };
    }
    case "toggle_hidden_section": {
      const hidden = s.prefs.hiddenSections.includes(cmd.title)
        ? s.prefs.hiddenSections.filter((t) => t !== cmd.title)
        : [...s.prefs.hiddenSections, cmd.title];
      return { ...s, prefs: { ...s.prefs, hiddenSections: hidden } };
    }
    case "show_all_sections":
      return s.prefs.hiddenSections.length === 0 ? s : { ...s, prefs: { ...s.prefs, hiddenSections: [] } };
    case "set_link_group": {
      const ids = new Set(cmd.ids);
      // An edit queued for a member while its graph was still on its
      // way belongs to the link it was made in: unlinked, or moved to
      // another link, the member must not receive it when it loads.
      const pending = { ...s.linkPending };
      for (const id of ids) delete pending[id];
      // Overrides belong to a link. Unlinked, a photograph has no link to
      // keep its sections from; and one joining from outside a link brings
      // none in (2026-09-13: "ensure that any overridden sections and
      // attributes/properties have the overrides removed"). links.ts clears
      // the same photographs' files.
      const clearing = [...ids].filter((id) => cmd.group === null || !s.images.find((i) => i.id === id)?.linkGroup);
      const graphs = { ...s.graphs };
      for (const id of clearing) if (graphs[id]?.overrides?.length) graphs[id] = { ...graphs[id], overrides: [] };
      const linkOverrides = clearing.includes(s.activeImage) && s.linkOverrides.length ? [] : s.linkOverrides;
      return {
        ...s,
        images: s.images.map((i) => (ids.has(i.id) ? { ...i, linkGroup: cmd.group } : i)),
        graphs,
        linkOverrides,
        linkPinned: cmd.group === null ? s.linkPinned.filter((id) => !ids.has(id)) : s.linkPinned,
        linkDirty: cmd.group === null ? s.linkDirty.filter((id) => !ids.has(id)) : s.linkDirty,
        linkPending: pending,
      };
    }
    case "toggle_link_pin":
      return {
        ...s,
        linkPinned: s.linkPinned.includes(cmd.id) ? s.linkPinned.filter((id) => id !== cmd.id) : [...s.linkPinned, cmd.id],
      };
    case "link_saved":
      return s.graphs[cmd.id] === cmd.graph ? { ...s, linkDirty: s.linkDirty.filter((id) => id !== cmd.id) } : s;
    case "settle_link_edits": {
      const edits = s.linkPending?.[cmd.id];
      if (cmd.id !== s.activeImage || !edits?.length) return s;
      const graph = replayLinkEdits(s, edits, s.linkOverrides);
      const pending = { ...s.linkPending };
      delete pending[cmd.id];
      return { ...s, ...graph, linkPending: pending,
        images: s.images.map((i) => i.id === cmd.id ? { ...i, edited: true } : i) };
    }
    case "stash_graphs": {
      const graphs = { ...s.graphs };
      const pending = { ...s.linkPending };
      const dirty = new Set(s.linkDirty);
      for (const [id, g] of Object.entries(cmd.graphs)) {
        if (id === s.activeImage) continue;
        // A real stash wins over a late disk read; deferred edits are
        // consumed exactly once when the first valid read lands.
        if (graphs[id] && !graphs[id].preRead) continue;
        const overrides = Array.isArray(g.linkOverrides) ? g.linkOverrides.filter((k): k is string => typeof k === "string") : [];
        let graph: MemberGraph = { nodes: structuredClone(g.nodes), wires: structuredClone(g.wires), backdrops: structuredClone(g.backdrops ?? []) };
        if (pending[id]?.length) {
          const replayed = replayLinkEdits(graph, pending[id], overrides);
          if (replayed !== graph) dirty.add(id);
          graph = replayed;
          delete pending[id];
        }
        graphs[id] = { ...graph, undoStack: [], redoStack: [], overrides };
      }
      return { ...s, graphs, linkPending: pending, linkDirty: [...dirty] };
    }
    case "toggle_link_override": {
      const keys = [...new Set(cmd.keys)];
      if (keys.length === 0) return s;
      // All on or all off, as one gesture: a section's override is every
      // node it owns, and half an override is no override.
      const anyOn = keys.some((k) => s.linkOverrides.includes(k));
      const next = anyOn ? s.linkOverrides.filter((k) => !keys.includes(k)) : [...s.linkOverrides, ...keys];
      return { ...s, linkOverrides: next };
    }
    case "link_match": {
      const group = s.images.find((i) => i.id === cmd.id)?.linkGroup;
      if (!group) return s;
      const fromActive = cmd.id === s.activeImage;
      const stashed = s.graphs[cmd.id];
      const source: MemberGraph & { overrides: string[] } | null = fromActive
        ? { nodes: s.nodes, wires: s.wires, backdrops: s.backdrops, overrides: s.linkOverrides }
        : stashed && !stashed.preRead
          ? { nodes: stashed.nodes, wires: stashed.wires, backdrops: stashed.backdrops, overrides: stashed.overrides ?? [] }
          : null;
      if (!source) return s;
      const targets = s.images
        .filter((i) => i.linkGroup === group && i.id !== cmd.id && !s.linkPinned.includes(i.id))
        .map((i) => i.id);
      let next = s;
      let changed = false;
      const graphs = { ...s.graphs };
      const dirty = new Set(s.linkDirty);
      const pending = { ...s.linkPending };
      for (const id of targets) {
        if (id === s.activeImage && s.graphLoading === id) {
          pending[id] = [...(pending[id] ?? []), { match: source, overrides: [...source.overrides] }];
          changed = true;
          continue;
        }
        if (id === s.activeImage) {
          const m = matchGraph(source, { nodes: s.nodes, wires: s.wires, backdrops: s.backdrops }, [...s.linkOverrides, ...source.overrides]);
          // A candidate that cannot be reconciled comes back as the
          // member's own graph, reference and all: nothing changes, no
          // undo entry, no write owed.
          if (m.nodes !== s.nodes || m.wires !== s.wires) {
            next = withUndo({ nodes: m.nodes, wires: m.wires, backdrops: m.backdrops });
            changed = true;
          }
          continue;
        }
        const g = s.graphs[id];
        if (!g || g.preRead) {
          pending[id] = [...(pending[id] ?? []), { match: source, overrides: [...source.overrides] }];
          changed = true;
          continue;
        }
        const m = matchGraph(source, { nodes: g.nodes, wires: g.wires, backdrops: g.backdrops }, [...(g.overrides ?? []), ...source.overrides]);
        if (m.nodes !== g.nodes || m.wires !== g.wires || m.backdrops !== g.backdrops) {
          graphs[id] = { ...g, nodes: m.nodes, wires: m.wires, backdrops: m.backdrops };
          dirty.add(id);
          changed = true;
        }
      }
      if (!changed) return s;
      return { ...next, graphs, linkDirty: [...dirty], linkPending: pending };
    }
    case "set_section_filter":
      return SECTION_FILTERS.includes(cmd.filter) && cmd.filter !== s.sectionFilter ? { ...s, sectionFilter: cmd.filter } : s;
    // The saved layout, field by field, each one checked: the settings
    // file is hand editable and an older file carries fewer fields, so
    // anything missing or malformed keeps what the fresh state has.
    case "restore_layout": {
      const l = cmd.layout;
      if (!l || typeof l !== "object") return s;
      let next: State = s;
      const bool = (v: unknown): v is boolean => typeof v === "boolean";
      if (bool(l.browserOpen)) next = { ...next, browserOpen: l.browserOpen };
      if (bool(l.ribbonOpen)) next = { ...next, ribbonOpen: l.ribbonOpen };
      if (l.ribbonView === "thumbs" || l.ribbonView === "list") next = { ...next, ribbonView: l.ribbonView };
      if (typeof l.mode === "string" && MODE_IDS.includes(l.mode)) next = reduceInner(next, { type: "set_mode", mode: l.mode });
      if (l.panelSizes && typeof l.panelSizes === "object") {
        const sizes = { ...next.panelSizes };
        for (const key of Object.keys(DEFAULT_PANEL_SIZES) as (keyof typeof DEFAULT_PANEL_SIZES)[]) {
          const v = (l.panelSizes as Record<string, unknown>)[key];
          if (typeof v === "number" && Number.isFinite(v)) {
            // Zero is "even" for the two splits and stays zero.
            sizes[key] = v === 0 && (key === "rightSplit" || key === "selectionSplit") ? 0 : clampPanelSize(next, key, v);
          }
        }
        next = { ...next, panelSizes: sizes };
      }
      const tabs = visiblePanelTabs(next.prefs).map((t) => t.id);
      if (typeof l.panelTab === "string" && tabs.includes(l.panelTab)) next = { ...next, panelTab: l.panelTab };
      if (Array.isArray(l.panelBottom)) {
        const bottom = l.panelBottom.filter((t): t is PanelTab => typeof t === "string" && tabs.includes(t as PanelTab));
        next = { ...next, panelBottom: bottom };
      }
      if (typeof l.panelTabBottom === "string" && tabs.includes(l.panelTabBottom)) next = { ...next, panelTabBottom: l.panelTabBottom };
      if (bool(l.selectionSplitMin)) next = { ...next, selectionSplitMin: l.selectionSplitMin };
      if (typeof l.sectionFilter === "string" && SECTION_FILTERS.includes(l.sectionFilter)) next = { ...next, sectionFilter: l.sectionFilter };
      const p = l.popouts;
      if (p && typeof p === "object") {
        if (bool(p.graph)) next = reduceInner(next, { type: "set_graph_popped_out", out: p.graph });
        if (bool(p.spectrums)) next = { ...next, spectrumsPoppedOut: p.spectrums };
        if (bool(p.takes)) next = { ...next, takesPoppedOut: p.takes };
        if (bool(p.bend)) next = { ...next, bendPoppedOut: p.bend };
        if (bool(p.console)) next = { ...next, consoleWindowOpen: p.console };
        if (p.tools && typeof p.tools === "object") {
          const tools = { ...next.toolPopouts };
          for (const key of TOOL_POPOUT_KEYS) {
            const v = (p.tools as Record<string, unknown>)[key];
            if (bool(v)) tools[key] = v;
          }
          next = { ...next, toolPopouts: tools };
        }
      }
      if (next.graphPoppedOut && (l.inspectorHome === "main" || l.inspectorHome === "graph")) {
        next = { ...next, inspectorHome: l.inspectorHome };
      }
      return next;
    }
    // Every pop-out back in the main window: the way home for a window
    // pushed off a display. The main window's effects close the OS windows
    // as the flags fall.
    case "dock_all_windows": {
      const tools = { ...s.toolPopouts };
      for (const key of TOOL_POPOUT_KEYS) tools[key] = false;
      return {
        ...s,
        graphPoppedOut: false,
        inspectorHome: "main",
        spectrumsPoppedOut: false,
        takesPoppedOut: false,
        bendPoppedOut: false,
        consoleWindowOpen: false,
        toolPopouts: tools,
      };
    }
    // The frame around the photograph as a fresh launch shows it. The
    // pop-outs are not touched: Bring All Windows Back is beside it.
    case "reset_layout":
      return {
        ...s,
        browserOpen: true,
        ribbonOpen: true,
        ribbonExpanded: false,
        ribbonView: "thumbs",
        panelSizes: { ...DEFAULT_PANEL_SIZES },
        panelTab: "adjust",
        panelBottom: [],
        panelTabBottom: "history",
        selectionSplitMin: false,
        selectionSplitClosed: false,
        sectionFilter: "all",
        canvasNodesHidden: false,
        layoutPinned: [],
      };
    case "set_bend_popped_out":
      return { ...s, bendPoppedOut: cmd.out };
    case "set_tool_popped_out":
      // Popping out does NOT switch a tool
      // on: the window shows the "has not been used" screen with the
      // switch instead. "Right now, if I click the pop out it
      // enables the tool automatically. I don't want that."
      return { ...s, toolPopouts: { ...s.toolPopouts, [cmd.tool]: cmd.out },
        ...(!cmd.out && cmd.tool === "toneeq" ? { toneEqHoverX: null } : {}),
        ...(!cmd.out && cmd.tool === "recolor" ? { recolorHoverX: null } : {}),
        ...(!cmd.out && cmd.tool === "curves" ? { curveHoverX: null } : {}) };
    case "ask_confirm":
      // A confirmation the user silenced skips straight to the deed:
      // the delete-take dialog's "Don't show this again". Through the
      // OUTER reduce, so the real command takes the whole reducer's
      // path; Preferences holds the way back ("Confirm take deletion").
      if (cmd.action.kind === "delete_take" && !s.prefs.confirmDeleteTake) {
        return reduce(s, { type: "delete_take", takeId: cmd.action.takeId });
      }
      return { ...s, confirm: { action: cmd.action, step: 1 } };
    case "advance_confirm":
      // Only ever moves forward. Whether this was the last prompt is the
      // caller's question, answered by isFinalPrompt before it dispatches.
      return s.confirm ? { ...s, confirm: { ...s.confirm, step: s.confirm.step + 1 } } : s;
    case "close_confirm":
      return { ...s, confirm: null };
    case "remove_images": {
      // Hidden and deleted images leave the ribbon without a folder
      // reload, so the view matches the catalog immediately.
      const gone = new Set(cmd.ids);
      const images = s.images.filter((i) => !gone.has(i.id));
      if (images.length === s.images.length) return s;
      const selection = s.imageSelection.filter((id) => !gone.has(id));
      // Their shot dates go with them: a photograph put back later at
      // the same path is read again.
      if (cmd.ids.some((id) => Object.prototype.hasOwnProperty.call(s.shotDates, id))) {
        const shotDates = { ...s.shotDates };
        for (const id of cmd.ids) delete shotDates[id];
        s = { ...s, shotDates };
      }
      if (!gone.has(s.activeImage)) {
        return { ...s, images, imageSelection: selection };
      }
      // The active photo went with them, so land on the one that took
      // its place rather than on nothing.
      const at = s.images.findIndex((i) => i.id === s.activeImage);
      const next = images[Math.min(at, images.length - 1)];
      if (!next) {
        return { ...s, images, imageSelection: [], confirm: s.confirm };
      }
      return {
        ...reduce({ ...s, images }, { type: "select_image", id: next.id }),
        imageSelection: [next.id],
      };
    }
    case "open_catalogs":
      return { ...s, catalogsOpen: true };
    case "close_catalogs":
      return { ...s, catalogsOpen: false };
    case "open_bake": {
      const ids = cmd.ids.filter((id) => s.images.some((i) => i.id === id && !i.missing));
      if (!ids.length) return s;
      return { ...s, bake: { ids, running: false } };
    }
    case "set_bake_format":
      return { ...s, bakeFormat: cmd.format };
    case "start_bake":
      return s.bake ? { ...s, bake: { ...s.bake, running: true } } : s;
    case "close_bake":
      return { ...s, bake: null };
    // Tool settings, not edits: no undo entry, and written straight
    // back to the catalog so they survive a relaunch.
    case "set_ui_setting": {
      const next = { ...s, [cmd.key]: cmd.value } as State;
      // Antialias is a property of the mask, not of the app: the graph
      // has to carry it or the setting would be a switch that changed
      // nothing on reload. The app-level value is the default new masks
      // are born with; toggling it also retunes the live one, which is
      // the mask the user was looking at when they reached for the menu.
      if (cmd.key !== "selectAntialias") return next;
      const mask = activeSelectionMask(s);
      if (!mask) return next;
      return {
        ...next,
        nodes: next.nodes.map((n) =>
          n.id === mask.id
            ? { ...n, params: { ...n.params, antialias: cmd.value ? 1 : 0 } }
            : n,
        ),
      };
    }
    case "set_dodge_mode":
      return { ...s, dodgeMode: cmd.mode };
    case "set_shape_mode":
      return { ...s, shapeMode: cmd.mode };
    case "set_repair_mode":
      return { ...s, repairMode: cmd.mode };
    case "set_blur_mode":
      return { ...s, blurMode: cmd.mode };
    case "set_art_content_kind":
      return isArtContentKind(cmd.kind) ? { ...s, artContentKind: cmd.kind } : s;
    case "set_polish_mode":
      return { ...s, polishMode: cmd.mode };
    case "set_polish_preview":
      return { ...s, polishPreview: cmd.mode };
    // Stored on the selection mask beside its regions, as geometry.
    // The layer editors both bake the refinement on Apply; keeping
    // the strokes means picking the tool up next week and erasing one
    // of them is an ordinary thing to do.
    case "add_polish_stroke":
      return withUndo({
        nodes: s.nodes.map((n) =>
          n.id === cmd.id ? { ...n, strokes: [...(n.strokes ?? []), cmd.stroke as never] } : n,
        ),
      });
    // The streamed half of a polish stroke: the gesture grows the last
    // stroke point by point so the matte refines under the brush, the
    // way a layer editor's refine paints. Gesture coalescing keeps it one
    // undo entry.
    case "update_polish_stroke":
      return withUndo({
        nodes: s.nodes.map((n) => {
          if (n.id !== cmd.id) return n;
          const strokes = n.strokes ?? [];
          if (!strokes.length) return n;
          const last = strokes[strokes.length - 1];
          return { ...n, strokes: [...strokes.slice(0, -1), { ...last, points: cmd.points }] };
        }),
      });
    case "open_select_dialog":
      return { ...s, selectDialog: cmd.dialog.kind === "range" ? { ...cmd.dialog,
        depthViewBefore: s.selectDialog?.depthViewBefore ?? s.depthView,
      } : cmd.dialog };
    case "close_select_dialog":
      return { ...s, selectDialog: null,
        depthView: s.selectDialog?.kind === "range" ? s.selectDialog.depthViewBefore ?? s.depthView : s.depthView,
      };
    case "open_prefs":
      return { ...s, prefsOpen: true, prefsLanding: cmd.landing ?? null };
    case "close_prefs":
      return { ...s, prefsOpen: false };
    case "set_prefs": {
      const merged = { ...s.prefs, ...cmd.prefs };
      const [lo, hi] = ribbonBounds(merged);
      const previewEdge = clampPreviewEdge(merged.previewEdge);
      const prefs: Prefs = {
        ...merged,
        viewerZoomRate: clampViewerZoomRate(merged.viewerZoomRate),
        viewerRotationStep: clampViewerRotationStep(merged.viewerRotationStep),
        previewEdge,
        settledPreview: merged.settledPreview === "full" ? "full" : "screen",
        settleQuality: merged.settleQuality === "smaller" || merged.settleQuality === "sharper" ? merged.settleQuality : "balanced",
        gesturePreviewEdge: clampGesturePreviewEdge(merged.gesturePreviewEdge, previewEdge),
        ribbonMinWidth: lo,
        ribbonMaxWidth: hi,
        thumbnailEdge: clampThumbnailEdge(merged.thumbnailEdge),
        autosaveDelayMs: clampAutosaveDelay(merged.autosaveDelayMs),
        backupEveryDays: BACKUP_CADENCES.some(cadence => cadence.days === merged.backupEveryDays)
          ? merged.backupEveryDays
          : DEFAULT_PREFS.backupEveryDays,
        backupFolder: typeof merged.backupFolder === "string" ? merged.backupFolder : DEFAULT_PREFS.backupFolder,
        keepBakedInBackups: typeof merged.keepBakedInBackups === "boolean" ? merged.keepBakedInBackups : DEFAULT_PREFS.keepBakedInBackups,
        // Titles only, once each: the settings file is hand editable.
        pinnedSections: Array.isArray(merged.pinnedSections)
          ? merged.pinnedSections.filter((t, i, a): t is string => typeof t === "string" && a.indexOf(t) === i)
          : DEFAULT_PREFS.pinnedSections,
        hiddenSections: Array.isArray(merged.hiddenSections)
          ? merged.hiddenSections.filter((t, i, a): t is string => typeof t === "string" && a.indexOf(t) === i)
          : DEFAULT_PREFS.hiddenSections,
        maskOverlayColor: MASK_OVERLAY_COLORS.some((color) => color.id === merged.maskOverlayColor)
          ? merged.maskOverlayColor
          : DEFAULT_PREFS.maskOverlayColor,
        maskOverlayOpacity: clampMaskOverlayOpacity(merged.maskOverlayOpacity),
        tetherDestination: typeof merged.tetherDestination === "string" ? merged.tetherDestination : "",
        tetherNamingPattern: typeof merged.tetherNamingPattern === "string" ? merged.tetherNamingPattern : "",
        tetherAutoAdvance: typeof merged.tetherAutoAdvance === "boolean" ? merged.tetherAutoAdvance : true,
        tetherPollMs: clampTetherPoll(merged.tetherPollMs),
        exportDefaultFormat: (["jpeg", "webp", "png", "png16", "tiff", "tiff32", "dng", "exr"] as const).includes(merged.exportDefaultFormat)
          ? merged.exportDefaultFormat
          : DEFAULT_PREFS.exportDefaultFormat,
        exportTemplate: typeof merged.exportTemplate === "string" ? merged.exportTemplate : DEFAULT_PREFS.exportTemplate,
        exportKeepMetadata: typeof merged.exportKeepMetadata === "boolean" ? merged.exportKeepMetadata : true,
        modelStoreDir: typeof merged.modelStoreDir === "string" ? merged.modelStoreDir : DEFAULT_PREFS.modelStoreDir,
        wheelZoomInverted: typeof merged.wheelZoomInverted === "boolean" ? merged.wheelZoomInverted : false,
        gpuPreviews: typeof merged.gpuPreviews === "boolean" ? merged.gpuPreviews : true,
        experimentalFeatures: typeof merged.experimentalFeatures === "boolean" ? merged.experimentalFeatures : false,
        checkUpdatesOnLaunch: typeof merged.checkUpdatesOnLaunch === "boolean" ? merged.checkUpdatesOnLaunch : true,
        assistantEnabled: typeof merged.assistantEnabled === "boolean" ? merged.assistantEnabled : false,
        assistantAddress: typeof merged.assistantAddress === "string" ? merged.assistantAddress : DEFAULT_PREFS.assistantAddress,
        assistantModel: typeof merged.assistantModel === "string" ? merged.assistantModel : "",
        assistantValidated: typeof merged.assistantValidated === "string" ? merged.assistantValidated : "",
        consoleNameFormat: isNameFormat(merged.consoleNameFormat) ? merged.consoleNameFormat : "rgb",
        // The settings file is hand editable: anything but "cmy" is RGB.
        curveMode: merged.curveMode === "cmy" ? "cmy" : "rgb",
        shapeLineWidth: migrateShapeLineWidth(merged.shapeLineWidth),
        depthEdges: clampDepthSetting(merged.depthEdges, DEFAULT_PREFS.depthEdges),
        depthFlatten: clampDepthSetting(merged.depthFlatten, DEFAULT_PREFS.depthFlatten),
        depthSize: snapDepthSize(merged.depthSize),
      };
      return {
        ...s,
        prefs,
        // The overlay opacity preference is where the Overlay strength
        // starts: set (or restored at launch), it becomes the strength;
        // the brush panel's slider moves it for the session only.
        ...(cmd.prefs.maskOverlayOpacity !== undefined
          ? { brushOverlayStrength: prefs.maskOverlayOpacity / 100 }
          : {}),
        // A preference can hide a tab (Tether behind experimental
        // features): whatever named it clears on the spot, so neither the
        // active seats nor the split can resurrect a tab the strip no
        // longer shows.
        ...(visiblePanelTabs(prefs).length < PANEL_TABS.length
          ? {
              panelBottom: s.panelBottom.filter((id) => visiblePanelTabs(prefs).some((t) => t.id === id)),
              panelTab: visiblePanelTabs(prefs).some((t) => t.id === s.panelTab) ? s.panelTab : "adjust",
              panelTabBottom: visiblePanelTabs(prefs).some((t) => t.id === s.panelTabBottom) ? s.panelTabBottom : "history",
            }
          : {}),
        panelSizes: {
          ...s.panelSizes,
          ribbon: Math.min(hi, Math.max(lo, s.panelSizes.ribbon)),
        },
      };
    }
    case "open_palette":
      return { ...s, palette: { ...(cmd.x !== undefined && cmd.y !== undefined ? { x: cmd.x, y: cmd.y } : {}), ...(cmd.cat ? { cat: cmd.cat } : {}) } };
    case "close_palette":
      return { ...s, palette: null };
    // Most recent first, no duplicates, and longer than any sane
    // shortlist so shrinking the preference does not throw history away.
    case "add_recipe": {
      // One level of groups is what the editor can open, so a recipe
      // goes into the main graph, said rather than refused silently.
      if (s.openedGroup) return { ...s, notice: { text: "Recipes drop into the main graph: leave this group first", at: Date.now() } };
      const id = cmd.id ?? freshNodeId("heeler.group");
      if (s.nodes.some((n) => n.id === id)) return s;
      const copy = copyNodeWithId(cmd.recipe.group, id);
      const spot = freeSpot(s.nodes, Math.round(cmd.x), Math.round(cmd.y));
      // The members through the same migration and registry dials a
      // placed node gets, so a stored recipe from an older day opens
      // with the ports and numbers this day's cards have.
      const group: NodeCard = {
        ...copy,
        x: spot.x,
        y: spot.y,
        enabled: true,
        groupNodes: migrateNodes(copy.groupNodes ?? []).map(withRegistryDials),
      };
      return withUndo({ nodes: [...s.nodes, group], selection: [id] });
    }
    case "save_recipe": {
      const g = s.nodes.find((n) => n.id === cmd.id);
      const name = cmd.name.trim();
      if (!savableAsRecipe(g) || !name) return s;
      const recipe = recipeFromGroup(g!, name, cmd.recipeId ?? `user_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`);
      // The list on screen changes now; the file follows (recipeOps,
      // run by the app against the recipes folder, recipefiles.ts).
      // "Saved" is said there, once the file is written: the write can
      // fail (docs review 2026-10-01), and a failed one stays listed,
      // grayed with the reason, rather than vanishing.
      return {
        ...s,
        userRecipes: [...s.userRecipes, recipe],
        recipeOps: [...s.recipeOps, { kind: "save", recipe }],
      };
    }
    case "recipe_not_saved": {
      const r = cmd.recipe;
      const listed = s.userRecipes.some((x) => x.id === r.id);
      return { ...s, userRecipes: listed ? s.userRecipes.map((x) => (x.id === r.id ? r : x)) : [...s.userRecipes, r] };
    }
    case "rename_recipe": {
      const name = cmd.name.trim();
      const recipe = s.userRecipes.find((r) => r.id === cmd.id);
      if (!name || !recipe) return s;
      return {
        ...s,
        userRecipes: s.userRecipes.map((r) => (r.id === cmd.id ? { ...r, name, group: { ...r.group, name } } : r)),
        recipeOps: [...s.recipeOps, { kind: "rename", recipe, name }],
      };
    }
    case "remove_recipe": {
      const recipe = s.userRecipes.find((r) => r.id === cmd.id);
      if (!recipe) return s;
      return { ...s, userRecipes: s.userRecipes.filter((r) => r.id !== cmd.id), recipeOps: [...s.recipeOps, { kind: "remove", recipe }] };
    }
    case "take_recipe_ops":
      return s.recipeOps.length ? { ...s, recipeOps: s.recipeOps.slice(cmd.count) } : s;
    case "set_user_recipes":
      return { ...s, userRecipes: cmd.recipes };
    case "note_recent_node":
      return {
        ...s,
        recentNodes: [
          cmd.nodeType,
          ...s.recentNodes.filter((t) => t !== cmd.nodeType),
        ].slice(0, 40),
      };
    case "set_keynav": {
      // Collapsed sections "don't auto-expand/open to show the
      // next hotkey to navigate to a setting." Navigating INTO a section is
      // asking to see it, so the fold opens on the way: picking its letter,
      // picking a control, or j/k-ing into one all land here.
      const title = cmd.nav?.target?.section ?? cmd.nav?.section;
      const sectionsClosed =
        title && s.sectionsClosed.includes(title)
          ? s.sectionsClosed.filter((t) => t !== title)
          : s.sectionsClosed;
      return { ...s, keynav: cmd.nav, sectionsClosed };
    }
    case "clear_filters":
      return {
        ...s,
        filterStars: 0,
        filterPicksOnly: false,
        filterHideRejected: false,
        filterFlagInverted: false,
        filterStacksOnly: false,
        filterEdited: "all",
        filterTakesMin: 1,
        filterTakesMax: TAKE_CAP,
        filterName: "",
        filterDateFrom: "",
        filterDateTo: "",
        tagFilter: null,
      };
    case "set_filter_name":
      return { ...s, filterName: cmd.text };
    // The two ends arrive canonical (the field parses before it
    // commits), so what the state holds is what the filter means.
    case "set_filter_dates":
      return {
        ...s,
        filterDateFrom: cmd.from ?? s.filterDateFrom,
        filterDateTo: cmd.to ?? s.filterDateTo,
      };
    case "set_shot_dates":
      return { ...s, shotDates: { ...s.shotDates, ...cmd.dates } };
    case "set_filter_stars":
      // Clicking the current threshold again clears the filter.
      return {
        ...s,
        filterStars:
          cmd.stars === s.filterStars ? 0 : Math.min(5, Math.max(0, cmd.stars)),
      };
    // One button over the two flag filters (2026-09-15: "[√ X] when the
    // user clicks on the button it cycles"): off, then only the picks,
    // then the rejects hidden, then off. Both on at once (the old two
    // chips could) counts as off, so the next click starts the cycle
    // cleanly.
    case "cycle_filter_flag": {
      const picks = s.filterPicksOnly && !s.filterHideRejected;
      const rejects = s.filterHideRejected && !s.filterPicksOnly;
      // A plain click moves on from the base context; the inversion
      // belongs to the state it was made in and does not carry.
      return picks
        ? { ...s, filterPicksOnly: false, filterHideRejected: true, filterFlagInverted: false }
        : rejects
          ? { ...s, filterPicksOnly: false, filterHideRejected: false, filterFlagInverted: false }
          : { ...s, filterPicksOnly: true, filterHideRejected: false, filterFlagInverted: false };
    }
    // The modifier click (2026-09-15: "The modifier key only works in
    // context... The modifier inverts those contexts"): in picks only it
    // hides the picks instead, in rejects hidden it shows only the rejects;
    // off, there is nothing to invert and it is a plain click.
    case "invert_filter_flag": {
      const inContext = s.filterPicksOnly !== s.filterHideRejected;
      return inContext
        ? { ...s, filterFlagInverted: !s.filterFlagInverted }
        : reduceInner(s, { type: "cycle_filter_flag" });
    }
    case "cycle_filter_edited":
      return {
        ...s,
        filterEdited: s.filterEdited === "all" ? "edited" : s.filterEdited === "edited" ? "unedited" : "all",
      };
    case "toggle_filter_stacks":
      return { ...s, filterStacksOnly: !s.filterStacksOnly };
    case "restore_takes": {
      // Reloading an image's saved versions. The active version's graph
      // is already in nodes/wires (replace_graph ran first), so only the
      // sibling list and the active pointer need restoring.
      if (cmd.versions.length === 0) return s;
      // The siblings are saved graphs too, so they owe the migrations
      // replace_graph runs on the active one: without them a take saved
      // before a node replaced its recipe block comes back made of
      // pieces this build no longer renders the same.
      const versions = cmd.versions.map((v) => ({
        ...v,
        ...migrateGraph(v.nodes, v.wires),
      }));
      return {
        ...s,
        takes: { ...s.takes, [cmd.imageId]: versions },
        // A pointer naming no restored take (a hand-edited file, an
        // older build) would have new_take and switch_take snapshot the
        // live graph into nothing, their map matching no id, and the
        // next switch would throw the edits away. The loader's own
        // fallback when the key is absent is the first take; the same
        // answer fits a key that names nothing.
        activeTakes: {
          ...s.activeTakes,
          [cmd.imageId]: versions.some((v) => v.id === cmd.activeVersion)
            ? cmd.activeVersion
            : versions[0].id,
        },
      };
    }
    case "new_take": {
      const img = s.activeImage;
      const existing =
        s.takes[img] ??
        ([
          { id: "take_1", name: "Take 1", nodes: s.nodes, wires: s.wires },
        ] as Take[]);
      const activeId = s.activeTakes[img] ?? "take_1";
      // Snapshot the current graph into the active take, then branch.
      const updated = existing.map((t) =>
        t.id === activeId ? { ...t, nodes: s.nodes, wires: s.wires } : t,
      );
      // Count + 1 collides after a delete: remove take_1 of two and the
      // next branch mints a SECOND take_2, and every by-id lookup from
      // then on (switch, update, delete) hits both at once. Mint the
      // first number no living take holds.
      let n = 1;
      while (updated.some((t) => t.id === `take_${n}`)) n++;
      const newId = `take_${n}`;
      const branched: Take = {
        id: newId,
        // "I created new takes but they are coming in as Version#."
        // The rename caught every label on screen and missed the one place that
        // MAKES a name, which is the only one that ends up on disk.
        name: cmd.name?.trim() || `Take ${n}`,
        note: cmd.note?.trim() || undefined,
        nodes: structuredClone(s.nodes),
        wires: structuredClone(s.wires),
      };
      return {
        ...s,
        takes: { ...s.takes, [img]: [...updated, branched] },
        activeTakes: { ...s.activeTakes, [img]: newId },
      };
    }
    case "update_take": {
      const img = s.activeImage;
      const list = s.takes[img] ?? [
        { id: "take_1", name: "Take 1", nodes: s.nodes, wires: s.wires },
      ];
      if (!list.some((t) => t.id === cmd.takeId)) return s;
      return {
        ...s,
        takes: {
          ...s.takes,
          [img]: list.map((t) =>
            t.id === cmd.takeId
              ? {
                  ...t,
                  name: cmd.name.trim() || t.name,
                  note: cmd.note?.trim() || undefined,
                }
              : t,
          ),
        },
      };
    }
    // A take's stars, the thumbnails' scale: a review mark, not an edit,
    // so no undo entry, like update_take. 0 clears.
    case "set_take_rating": {
      const img = s.activeImage;
      const list = s.takes[img] ?? [
        { id: "take_1", name: "Take 1", nodes: s.nodes, wires: s.wires },
      ];
      if (!list.some((t) => t.id === cmd.takeId)) return s;
      const rating = Math.min(5, Math.max(0, Math.round(cmd.rating)));
      return {
        ...s,
        takes: {
          ...s.takes,
          [img]: list.map((t) =>
            t.id === cmd.takeId ? { ...t, rating: rating > 0 ? rating : undefined } : t,
          ),
        },
      };
    }
    // "Also missing a way to delete a take."
    case "delete_take": {
      const img = s.activeImage;
      const list = s.takes[img];
      if (!list || list.length <= 1) {
        // A photograph always has at least one take: the edit you are
        // looking at is one, it just may have no siblings. Deleting the
        // last would leave the viewer showing a graph nothing owns.
        return s;
      }
      const remaining = list.filter((t) => t.id !== cmd.takeId);
      if (remaining.length === list.length) return s;
      const activeId = s.activeTakes[img] ?? "take_1";
      // Comparing it made no sense a moment ago and makes less now.
      const multi = s.multiTakes.filter((id) => id !== cmd.takeId);
      // The Split compare source follows the same rule: a before side
      // pointing at a deleted take would silently fall back to the
      // original (compareTakeOf) while the selector still named the
      // ghost.
      const compareTake = s.compareTake === cmd.takeId ? null : s.compareTake;
      if (activeId !== cmd.takeId) {
        // Not the one on screen: the graph is untouched, and the take that
        // holds it keeps whatever has been done to it since.
        return {
          ...s,
          compareTake,
          takes: {
            ...s.takes,
            [img]: remaining.map((t) =>
              t.id === activeId ? { ...t, nodes: s.nodes, wires: s.wires } : t,
            ),
          },
          multiTakes: multi.length > 1 ? multi : [],
        };
      }
      // Deleting the one on screen, so something else has to come up.
      // The one before it, which is where a person's attention already is.
      const at = list.findIndex((t) => t.id === cmd.takeId);
      const next = remaining[Math.max(0, at - 1)];
      return {
        ...s,
        ...GRAPH_POINTERS_RESET,
        nodes: next.nodes,
        wires: next.wires,
        selection: [],
        compareTake,
        // History belongs to the take that was on screen, and that take is
        // gone. Keeping it would offer to undo edits into a graph that no
        // longer exists.
        undoStack: [],
        redoStack: [],
        takes: { ...s.takes, [img]: remaining },
        activeTakes: { ...s.activeTakes, [img]: next.id },
        multiTakes: multi.length > 1 ? multi : [],
      };
    }
    case "switch_take": {
      const img = s.activeImage;
      const list = s.takes[img];
      if (!list) return s;
      const target = list.find((t) => t.id === cmd.takeId);
      if (!target) return s;
      const activeId = s.activeTakes[img] ?? "take_1";
      if (activeId === cmd.takeId) return s;
      const updated = list.map((t) =>
        t.id === activeId ? { ...t, nodes: s.nodes, wires: s.wires } : t,
      );
      return {
        ...s,
        // The swap puts a different graph under the UI, so everything
        // pointing into the old one goes the way select_image sends it.
        ...GRAPH_POINTERS_RESET,
        nodes: target.nodes,
        wires: target.wires,
        selection: [],
        undoStack: [],
        redoStack: [],
        takes: { ...s.takes, [img]: updated },
        activeTakes: { ...s.activeTakes, [img]: cmd.takeId },
      };
    }
    case "begin_gesture":
      return { ...s, gesture: cmd.key, gesturePushed: false, gestureOwner: cmd.owner };
    case "end_gesture":
      if (cmd.owner !== undefined && s.gestureOwner !== cmd.owner) return s;
      return { ...s, gesture: null, gesturePushed: false, gestureOwner: undefined };
    case "clear_history":
      return { ...s, undoStack: [], redoStack: [] };
    case "toggle_console":
      return { ...s, consoleOpen: !s.consoleOpen };
    case "set_graph_popped_out":
      // Popping out hands the inspector to the graph window, since that
      // is where you are about to be working. Docking takes it back,
      // because the collapsed bar has nowhere to live once the graph
      // window is gone.
      return {
        ...s,
        graphPoppedOut: cmd.out,
        inspectorHome: cmd.out ? "graph" : "main",
      };
    case "set_inspector_home":
      return { ...s, inspectorHome: cmd.home };
    case "bump_preview":
      return { ...s, previewNonce: s.previewNonce + 1 };
    case "toggle_canvas_nodes":
      return { ...s, canvasNodesHidden: !s.canvasNodesHidden };
    case "set_canvas_inspector":
      return { ...s, canvasInspectorOpen: cmd.open };
    case "select_image_range": {
      // Ribbon selection, the way every file browser does it: plain
      // click replaces, ctrl adds or removes, shift takes the span from
      // the active image. Whatever happens, the clicked image becomes
      // active, so the viewer never shows something outside the
      // selection.
      const visible = visibleImages(s).map((i) => i.id);
      let next: string[];
      if (cmd.range && s.activeImage) {
        const a = visible.indexOf(s.activeImage);
        const b = visible.indexOf(cmd.id);
        if (a < 0 || b < 0) next = [cmd.id];
        else next = visible.slice(Math.min(a, b), Math.max(a, b) + 1);
      } else if (cmd.additive) {
        next = s.imageSelection.includes(cmd.id)
          ? s.imageSelection.filter((i) => i !== cmd.id)
          : [...s.imageSelection, cmd.id];
        // Never empty: deselecting the last one would leave the viewer
        // showing a photo that is not selected.
        if (next.length === 0) next = [cmd.id];
      } else {
        next = [cmd.id];
      }
      // Which photo to show. Normally the one clicked, but a ctrl-click
      // that REMOVES a frame must not then display it: fall back to the
      // current one if it survived, else the last still selected. The
      // viewer is never showing something outside the selection.
      const active = next.includes(cmd.id)
        ? cmd.id
        : next.includes(s.activeImage)
          ? s.activeImage
          : next[next.length - 1];
      return {
        ...reduce(s, { type: "select_image", id: active }),
        imageSelection: next,
      };
    }
    case "add_stack_image": {
      // A finished stack lands in the ribbon beside the frames it came
      // from and becomes the active photo, since looking at the result
      // is the next thing anyone wants.
      const images = s.images.some((i) => i.id === cmd.image.id)
        ? s.images.map((i) => (i.id === cmd.image.id ? cmd.image : i))
        : [...s.images, cmd.image].sort((a, b) => a.name.localeCompare(b.name));
      return {
        ...reduce({ ...s, images }, { type: "select_image", id: cmd.image.id }),
        imageSelection: [cmd.image.id],
      };
    }
    case "boot_step":
      // A splash the update prompt dismissed stays dismissed: the boot's
      // later steps must not bring it back over the window and the
      // card (2026-09-19).
      if (s.splashDismissed) return s;
      // Never walks backwards: a slow step finishing after a later one
      // started must not drag the splash back a stage.
      if (
        s.boot &&
        BOOT_STEPS.indexOf(cmd.step) < BOOT_STEPS.indexOf(s.boot.step)
      )
        return s;
      return { ...s, boot: { step: cmd.step, detail: cmd.detail ?? "" } };
    case "dismiss_splash":
      // A question cannot wait behind the splash: the update prompt
      // lifts it at once and for good, over an empty window.
      return { ...s, boot: null, splashDismissed: true };
    case "boot_done":
      return { ...s, boot: null };
    case "add_layer": {
      // A Develop layer is graph truth: mask node -> exposure node spliced
      // into the main chain, so Graph mode shows exactly what Develop does.
      const existing = layersOf(s);
      const n =
        existing.reduce(
          (max, l) => Math.max(max, Number(layerNumber(l.id)!)),
          0,
        ) + 1;
      const adjId = layerNodeId(n, "adj");
      const maskId = layerNodeId(n, "mask");
      // Stack onto the END of the previous layer's chain, which may be a
      // tool spliced in behind its exposure node rather than the node
      // itself.
      const insertAfter = existing.length
        ? (layerChainTail(s, existing[existing.length - 1].id) ??
          existing[existing.length - 1].id)
        : "exposure";
      const taps = tapCards(s);
      const outWire = s.wires.find(
        (w) => w.from === insertAfter && w.toPort !== "mask" && !taps.has(w.to),
      );
      if (!outWire || !s.nodes.some((nd) => nd.id === insertAfter)) return s;
      const feed = frameFeed(s.nodes, s.wires);
      if (!feed) return s;
      const x = 199 + ((n - 1) % 7) * 175;
      // A Selection layer ADOPTS the document selection when one is drawn:
      // the regions, the polish strokes and the dials move onto the layer's
      // own mask, and the document selection is cleared in the same undoable
      // step - it "became a layer mask on request", which is half of why it
      // exists (see DOC_SEL_ID). Without this, the owner drew a selection,
      // added a Selection layer, and the layer's mask was born empty:
      // "Heeler is not recognizing it as a mask. I press the show mask
      // button and everything is black." matte_id stays behind on purpose:
      // the matte raster is keyed by node id, so it cannot follow; adopted
      // matte strokes make the runner recompute it for the new node by
      // itself, and a one-shot matte is one press away in the polish bar.
      const doc = cmd.maskType === "selection" ? s.nodes.find((nd) => nd.id === DOC_SEL_ID) : undefined;
      // A Smart selection has no regions, only its baked base, and was
      // not adopted at all; one with a rectangle added lost the base
      // (2026-09-30). The base travels with the rest now: its raster is
      // keyed by version, not by node. A Refine edge matte still stays.
      const adopting = selectionHasContent(doc);
      const maskNode: NodeCard = {
        id: maskId,
        type: LAYER_MASK_NODE[cmd.maskType],
        name: `${cmd.maskType[0].toUpperCase()}${cmd.maskType.slice(1)} Mask`,
        cat: "masking",
        x,
        y: 580,
        enabled: true,
        params: adopting
          ? { ...LAYER_MASK_DEFAULTS[cmd.maskType], ...doc!.params }
          : { ...LAYER_MASK_DEFAULTS[cmd.maskType] },
        // A new radial mask names its shape. The engine reads that name
        // to know it may use the corrected, frame-independent geometry;
        // masks placed before shapes existed carry no name and keep the
        // geometry they were placed under.
        ...(cmd.maskType === "radial" ? { textParams: { shape: "ellipse" } } : {}),
        ...(cmd.maskType === "brush" ? { strokes: [] } : {}),
        ...(cmd.maskType === "selection"
          ? adopting
            ? {
                regions: JSON.parse(JSON.stringify(doc!.regions ?? [])) as NodeCard["regions"],
                ...(doc!.strokes?.length
                  ? { strokes: JSON.parse(JSON.stringify(doc!.strokes)) as NodeCard["strokes"] }
                  : {}),
                ...((doc!.textParams?.matte_id ?? "").startsWith("baked:")
                  ? { textParams: { matte_id: doc!.textParams!.matte_id } }
                  : {}),
              }
            : { regions: [] }
          : {}),
        // A smart mask starts with no clicks: the recipe params exist
        // from birth so the click tool has somewhere to write.
        ...(cmd.maskType === "smart"
          ? { textParams: { mode: "click", prompts: "[]", model: "" } }
          : {}),
        // An object mask starts with no names chosen: the recipe params
        // exist from birth so the picker has somewhere to write.
        ...(cmd.maskType === "object" ? { textParams: { layer: "", names: "[]" } } : {}),
        hasIn: true,
        maskOut: true,
      };
      const adjNode: NodeCard = {
        id: adjId,
        type: "heeler.exposure",
        name: `${cmd.maskType[0].toUpperCase()}${cmd.maskType.slice(1)} ${n}`,
        cat: "color",
        x,
        y: 484,
        // "When creating a new layer, make sure they defaults are
        // off. This will help manage the node data and improve performance."
        //
        // Safe because `armed` switches it on the moment any slider leaves
        // zero, so the first thing you do to a new layer turns it on and
        // nothing is silently ignored. A layer you added and then thought
        // better of costs nothing.
        enabled: false,
        params: {
          exposure: 0,
          contrast: 0,
          color_contrast: 0,
          highlights: 0,
          shadows: 0,
          whites: 0,
          blacks: 0,
        },
        hasIn: true,
        hasOut: true,
        maskIn: true,
      };
      return withUndo({
        nodes: [
          // Adopted means MOVED: the document selection empties in the
          // same step, so there are never two live copies of one
          // selection drifting apart. Undo restores both at once.
          ...s.nodes.map((nd) =>
            adopting && nd.id === DOC_SEL_ID
              ? // The Smart recipe goes with its base, as Deselect takes it
                // (clear_regions): an unbaked Subject left behind would
                // be computed again.
                { ...nd, regions: [], strokes: [], textParams: { ...nd.textParams, matte_id: "", prompts: "", mode: "" } }
              : nd,
          ),
          adjNode,
          maskNode,
        ],
        wires: [
          ...s.wires.filter((w) => w !== outWire),
          { ...wireSource(outWire), to: adjId, toPort: "in", kind: "image" },
          {
            from: adjId,
            to: outWire.to,
            toPort: outWire.toPort,
            kind: "image",
          },
          { from: feed, to: maskId, toPort: "in", kind: "image" },
          { from: maskId, to: adjId, toPort: "mask", kind: "mask" },
        ],
        activeLayer: adjId,
        // A new layer starts on the photograph, not on a mask or depth
        // view left up by another layer.
        maskView: false,
        depthView: false,
        // Any picked selection mask lets go: a pick outranks the
        // active layer in the resolver, and a stale one (a polish pass
        // from an hour ago) would silently route this new layer's
        // drawing to a mask that is not on screen.
        selection: s.selection.filter(
          (id) => s.nodes.find((nd) => nd.id === id)?.type !== "heeler.selection_mask",
        ),
        // A brush layer with no tool armed is a layer you cannot paint
        // on: radial and linear masks place themselves the moment their
        // layer is active, and brush was the one that sat there waiting
        // for the user to find the toolbar. Adding one now hands you the
        // brush, which is the only reason to add one.
        // Same rule as switching between existing layers: the mask
        // types that need a tool get one, and the ones that place
        // themselves get the tool put away. Leaving "select" armed here
        // meant a radial layer added after a selection layer never
        // showed its overlay, because that overlay only appears when no
        // tool is engaged.
        tool: toolForMaskType(cmd.maskType, s.tool),
        images: s.images.map((i) =>
          i.id === s.activeImage ? { ...i, edited: true } : i,
        ),
      });
    }
    case "duplicate_layer": {
      const layers = layersOf(s);
      const src = layers.find((l) => l.id === cmd.id);
      if (!src) return s;
      const srcPrefix = layerGroupPrefix(src.id);
      const owned = layerGroup(s, src.id);
      const members = s.nodes.filter(nd => owned.has(nd.id));
      if (
        !members.some((nd) => nd.id === src.id) ||
        !members.some((nd) => nd.id === src.maskId)
      )
        return s;
      const n =
        layers.reduce(
          (max, l) => Math.max(max, Number(layerNumber(l.id)!)),
          0,
        ) + 1;
      const copyId = (id: string) =>
        id.startsWith(srcPrefix) ? layerNodeId(n, id.slice(srcPrefix.length))
          : owned.has(id) ? layerNodeId(n, `inline_${id}`) : id;
      // Splice the copy directly after its source so stacking order is
      // predictable, and rewire what the source's chain fed into.
      const taps = tapCards(s);
      const outWire = s.wires.find(
        (w) =>
          owned.has(w.from) &&
          !owned.has(w.to) &&
          !taps.has(w.to) &&
          w.kind === "image",
      );
      const feed = s.wires.find(
        (w) => w.to === src.maskId && w.toPort === "in",
      );
      if (!outWire || !feed) return s;
      // The copy takes the whole group: every tool the layer had, wired
      // to each other exactly as before.
      // Members of a tool group contain the layer namespace at the
      // END of their ids. Remap every internal reference as well as
      // the outer cards, preserving edits inside the copied recipe.
      const copies: NodeCard[] = members.map((nd) => ({
        ...copyNodeWithId(nd, copyId(nd.id)),
        name: nd.id === src.id ? `${nd.name} copy` : nd.name,
        x: (nd.x ?? 199) + 24,
        y: (nd.y ?? 484) + 24,
      }));
      const inner = s.wires
        .filter(
          (w) => owned.has(w.from) && owned.has(w.to),
        )
        .map((w) => ({ ...w, from: copyId(w.from), to: copyId(w.to) }));
      return withUndo({
        nodes: [...s.nodes, ...copies],
        wires: [
          ...s.wires.filter((w) => w !== outWire),
          ...inner,
          {
            ...wireSource(outWire),
            to: copyId(src.id),
            toPort: "in",
            kind: "image",
          },
          {
            from: copyId(outWire.from), fromPort: outWire.fromPort,
            to: outWire.to,
            toPort: outWire.toPort,
            kind: "image",
          },
          { ...wireSource(feed), to: copyId(src.maskId), toPort: "in", kind: "image" },
        ],
        activeLayer: copyId(src.id),
        images: s.images.map((i) =>
          i.id === s.activeImage ? { ...i, edited: true } : i,
        ),
      });
    }
    case "rename_layer":
      return withUndo({
        nodes: s.nodes.map((nd) =>
          nd.id === cmd.id ? { ...nd, name: cmd.name.trim() || nd.name } : nd,
        ),
      });
    case "remove_layer": {
      // A layer is its whole group: the mask, the exposure node, and any
      // tools spliced in behind it.
      const dead = layerGroup(s, cmd.id);
      const inWire = s.wires.find((w) => w.to === cmd.id && w.toPort === "in");
      const taps = tapCards(s);
      const outWire = s.wires.find(
        (w) => dead.has(w.from) && !dead.has(w.to) && !taps.has(w.to) && w.kind === "image",
      );
      if (!inWire || !outWire) return s;
      // A Remove that came from this layer's mask goes with it, and the
      // chain heals around its splice. Deleting the layer
      // "did not go away... I would have expected the image to go back
      // to normal." Two ways a Remove hangs off the layer: a legacy
      // graph wired the LIVE mask in as the hole, and a current one
      // owns a snapshot named for the mask it copied (inpaint_<maskId>
      // / inpaint_m_<maskId>).
      const deadMasks = [...dead];
      const dependents = s.nodes.filter(
        (nd) =>
          nd.type === "heeler.inpaint" &&
          (s.wires.some((w) => w.to === nd.id && w.toPort === "mask" && dead.has(w.from)) ||
            deadMasks.some((m) => nd.id === `inpaint_${m}`) ||
            (nd.textParams?.source !== undefined && dead.has(nd.textParams.source))),
      );
      for (const d of dependents) {
        dead.add(d.id);
        // The snapshot hole rides along.
        const hole = d.id.replace(/^inpaint_/, "inpaint_m_");
        if (s.nodes.some((nd) => nd.id === hole)) dead.add(hole);
      }
      const heals: Wire[] = [];
      for (const d of dependents) {
        const din = s.wires.find((w) => w.to === d.id && w.toPort === "in");
        const dout = s.wires.find(
          (w) => w.from === d.id && w.kind === "image" && !dead.has(w.to),
        );
        if (din && dout && !dead.has(din.from)) {
          heals.push({ ...wireSource(din), to: dout.to, toPort: dout.toPort, kind: "image" });
        }
      }
      return withUndo({
        nodes: s.nodes.filter((nd) => !dead.has(nd.id)),
        wires: [
          ...s.wires.filter((w) => !dead.has(w.from) && !dead.has(w.to)),
          {
            ...wireSource(inWire),
            to: outWire.to,
            toPort: outWire.toPort,
            kind: "image",
          },
          ...heals,
        ],
        activeLayer: s.activeLayer === cmd.id ? null : s.activeLayer,
        // The mask view belonged to the layer that is gone (left on,
        // it came back lit on the next layer made).
        maskView: s.activeLayer === cmd.id ? false : s.maskView,
        // "my cursor is not resetting when I delete a paint layer.
        // It still has the brush preview." The layer was gone and the brush was
        // still armed, pointed at nothing. Deleting the layer a tool belongs to
        // puts the tool down, the same way stepping off it does.
        tool:
          s.activeLayer === cmd.id ? toolForLayer(s, null, s.tool) : s.tool,
        // Nothing may keep pointing at the dead nodes: a lingering pick
        // hijacks the resolver, and a revert snapshot for a node that
        // is gone would "restore" onto nothing.
        selection: s.selection.filter((id) => !dead.has(id)),
        toolRevert:
          s.toolRevert && dead.has(s.toolRevert.id) ? null : s.toolRevert,
      });
    }
    case "set_layer_enabled": {
      // A layer is its whole group (see remove_layer), so one switch
      // bypasses every node in it except the mask: a bypassed mask is no
      // mask at all, which would apply the layer everywhere rather than
      // nowhere. "We need an enable toggle on Adjustment layers
      // to be able to toggle them on and off."
      //
      // The switch is its own flag, not the exposure node's `enabled`:
      // a layer's nodes ship bypassed until a slider moves (see
      // armed), so a fresh layer with every node off is ON, just
      // silent. Off remembers which members were on, and on restores
      // those, plus any member that was written to while the layer
      // was off and so has something to say now.
      const group = layerGroup(s, cmd.id);
      const maskId = maskOfLayer(cmd.id);
      const adj = s.nodes.find((n) => n.id === cmd.id);
      if (!adj || !group.has(maskId)) return s;
      const off = !!adj.layerOff;
      if (off === !cmd.enabled) return s;
      if (!cmd.enabled) {
        const wereOn = s.nodes
          .filter((n) => group.has(n.id) && n.id !== maskId && n.enabled)
          .map((n) => n.id);
        return withUndo({
          nodes: s.nodes.map((n) =>
            !group.has(n.id) || n.id === maskId
              ? n
              : n.id === cmd.id
                ? { ...n, enabled: false, layerOff: wereOn }
                : { ...n, enabled: false },
          ),
        });
      }
      const restore = new Set(adj.layerOff);
      return withUndo({
        nodes: s.nodes.map((n) => {
          if (!group.has(n.id) || n.id === maskId) return n;
          const back = restore.has(n.id) ? { ...n, enabled: true } : armed(n);
          return n.id === cmd.id ? { ...back, layerOff: undefined } : back;
        }),
      });
    }
    case "remove_all_color_sets": {
      // The section's reset: every set gone, one undo step, the chain
      // healed set by set the way a single removal heals it, and nothing
      // left aimed at a node that is no longer there.
      let nodes = s.nodes;
      let wires = s.wires;
      for (const set of listColorSets(nodes)) {
        ({ nodes, wires } = removeColorSet(nodes, wires, set.n));
      }
      if (nodes === s.nodes) return s;
      return withUndo({ nodes, wires, csetDropper: null, csetHoverHue: null, csetMaskView: null });
    }
    case "set_color_sets_enabled":
      // The section's switch: every set's grade at once, so the whole
      // family can be compared against nothing. Each set keeps its own eye
      // for one at a time.
      return withUndo({
        nodes: s.nodes.map((n) =>
          /^cset\d+_grade$/.test(n.id) ? { ...n, enabled: cmd.on } : n,
        ),
      });
    case "apply_lens_character": {
      const character = LENS_CHARACTERS.find((c) => c.id === cmd.id);
      if (!character) return s;
      let nodes = s.nodes;
      let wires = s.wires;
      // The character already on the photograph comes off first: every
      // dial it wrote goes back to what it overwrote, which the apply
      // recorded on the stamp (character_prior). Not to a neutral: the
      // flare's primed preset, the user's own vignette, a curve they
      // drew, are what was there, and what was there is what comes
      // back. Only what the OLD character wrote moves; a dial in a
      // section no character touched, and the aperture the door opened,
      // stay.
      const stamped = nodes.find((n) => n.id === "dof");
      if (stamped?.textParams?.character && stamped.textParams.character !== character.id) {
        let prior: Record<string, { params?: Record<string, number | null>; text?: Record<string, string | null>; built?: boolean }> = {};
        try {
          prior = JSON.parse(stamped.textParams.character_prior ?? "{}");
        } catch {
          prior = {};
        }
        // A section the old character built, and the new one does not
        // write, goes back off: its dials are restored below, so it
        // keeps what it had, and off is what it was before the apply.
        const incoming = new Set(
          Object.keys(character.writes).flatMap((t) => (CATEGORY_PIECES[t] ?? []).map((p) => p.id)),
        );
        nodes = nodes.map((n) => {
          const was = prior[n.id];
          if (!was) return n;
          if (was.built && !incoming.has(n.id)) n = { ...n, enabled: false };
          const params = { ...n.params };
          for (const [k, v] of Object.entries(was.params ?? {})) {
            if (typeof v === "number" && Number.isFinite(v)) params[k] = v;
            else delete params[k];
          }
          if (!was.text) return { ...n, params };
          const text = { ...n.textParams };
          for (const [k, v] of Object.entries(was.text)) {
            if (v === null) delete text[k];
            else text[k] = v;
          }
          return { ...n, params, textParams: text };
        });
      }
      // What this apply is about to overwrite, recorded before it does:
      // null marks a param or text the node did not carry at all.
      const priorNow: Record<string, { params?: Record<string, number | null>; text?: Record<string, string | null>; built?: boolean }> = {};
      for (const [title, write] of Object.entries(character.writes)) {
        for (const piece of CATEGORY_PIECES[title] ?? []) {
          // A section that is off is built on the way, set_category's
          // rule: a preset that names a section means it on.
          const built = !nodes.some((n) => n.id === piece.id);
          if (built) {
            ({ nodes, wires } = buildCategoryPiece(nodes, wires, piece));
          }
          nodes = nodes.map((n) => {
            if (n.id !== piece.id) return n;
            const entry: { params?: Record<string, number | null>; text?: Record<string, string | null>; built?: boolean } = {};
            if (built || !n.enabled) entry.built = true;
            for (const k of Object.keys(write.values ?? {})) {
              (entry.params ??= {})[k] = typeof n.params[k] === "number" ? (n.params[k] as number) : null;
            }
            for (const k of Object.keys(write.text ?? {})) {
              (entry.text ??= {})[k] = n.textParams?.[k] ?? null;
            }
            priorNow[n.id] = entry;
            const text = { ...n.textParams };
            for (const [k, v] of Object.entries(write.text ?? {})) {
              // Recolor's curves merge: the coating curve joins the
              // user's cells instead of replacing them.
              if (k === "curves" && (text.curves ?? "").trim()) {
                try {
                  text.curves = JSON.stringify({ ...JSON.parse(text.curves!), ...JSON.parse(v) });
                  continue;
                } catch {
                  // Unreadable curves: the preset's own take over.
                }
              }
              text[k] = v;
            }
            return { ...n, enabled: true, params: { ...n.params, ...(write.values ?? {}) }, textParams: text };
          });
        }
      }
      // The stamp, on Depth of Field, which every character writes, and
      // beside it what the apply overwrote, for the next apply to put
      // back.
      const priorJson = JSON.stringify(priorNow);
      nodes = nodes.map((n) =>
        n.id === "dof"
          ? { ...n, textParams: { ...n.textParams, character: cmd.id, character_prior: priorJson } }
          : n,
      );
      // The sections it wrote stay as they were, open or closed. Every one
      // of them springing open at once was "a bit much to take in" ; the
      // summary line under the menu says what was set, and each section's
      // own switch shows it is on.
      return withUndo({ nodes, wires });
    }
    case "preview_section_look": {
      const id = cmd.id !== null && lookById(cmd.id) ? cmd.id : null;
      return s.lookPreview === id ? s : { ...s, lookPreview: id };
    }
    case "apply_section_look": {
      const look = lookById(cmd.id);
      if (!look) return s;
      return withUndo({ ...sectionLookGraph(s.nodes, s.wires, look), lookPreview: null });
    }
    case "add_character_flare_light": {
      // Depth Lighting first, if the photograph has none: the door is
      // for a photograph whose character cannot show, and one with no
      // rig is the commonest such photograph. Then the light onto the
      // key light node and its flare twin alike, the way set_text_param
      // mirrors a rig write. One undo step for the lot.
      let nodes = s.nodes;
      let wires = s.wires;
      for (const title of ["Depth Lighting", "Lens Flare"]) {
        for (const piece of CATEGORY_PIECES[title] ?? []) {
          if (!nodes.some((n) => n.id === piece.id)) {
            ({ nodes, wires } = buildCategoryPiece(nodes, wires, piece));
          }
        }
      }
      const keylight = nodes.find((n) => n.id === "keylight");
      if (!keylight) return s;
      let existing: unknown[] = [];
      try {
        existing = JSON.parse(keylight.textParams?.lights ?? "[]") as unknown[];
      } catch {
        existing = [];
      }
      if (existing.length === 0 && (keylight.params.strength ?? 0) !== 0) {
        // A legacy single light still lives in the node's parameters.
        // Seed the rig with it before adding the flare so it stays lit.
        existing.push({ kind: "directional", azimuth: keylight.params.azimuth ?? 45,
          elevation: keylight.params.elevation ?? 45, strength: keylight.params.strength });
      }
      const { strength, ...light } = cmd.light;
      const lights = JSON.stringify([...existing, { ...light, power: light.power ?? strength ?? 0 }]);
      nodes = nodes.map((n) =>
        n.id === "keylight" || n.id === "flare"
          ? { ...n, enabled: true, textParams: { ...n.textParams, lights } }
          : n,
      );
      return withUndo({ nodes, wires });
    }
    case "set_active_layer": {
      // Clicking another layer (or Base) ends whatever mask pass was running
      // on the old one, and the pass's pick has to go with it. It did not:
      // Polish on a develop layer's Sky picked the mask, the click on Base
      // put the tool down through toolForLayer, and the pick stayed. The
      // resolver kept handing back the polished mask, so the ants stayed up
      // with Base active and Deselect emptied the layer. "when I
      // click off the adjustment back to the Base layer the selection
      // (marching ants) persist. If I do a deselect the adjustments made to
      // the smart layer disappear."
      //
      // A pick of another layer's mask goes too, whatever the tool:
      // the new layer's own mask is the one the tools point at now,
      // and a stale pick would outrank it.
      const tool = toolForLayer(s, cmd.id, s.tool);
      const own = cmd.id ? maskOfLayer(cmd.id) : undefined;
      const selection = dropToolPicks(s, tool, own).filter(
        (id) => id === own || !isLayerMask(id),
      );
      // A layer click reopens a closed selection panel, the same layer
      // or another (reduce clears it for a changed one; this covers the
      // re-click).
      return { ...s, activeLayer: cmd.id, tool, selection, selectionSplitClosed: false };
    }
    case "jump_history": {
      let cur: State = s;
      let guard = 0;
      while (cur.undoStack.length > Math.max(0, cmd.index) && guard < 200) {
        cur = reduce(cur, { type: "undo" });
        guard += 1;
      }
      return cur;
    }
    // The two gestures that make a node editor feel like one, from the
    // compositor study: drop a node onto a pipe and it splices in; pull it out
    // and the neighbors heal. Both preserve graph validity by construction,
    // which is the policy that let them ship ahead of free-form wiring. The
    // Outside gesture, adapted from a color grader: a masked node gains its
    // complement. One mask feeds both sides through an Invert Mask node, so
    // refining the selection refines the pair; the copy starts from the
    // original's settings and splices in directly after it. The grader hides the
    // inverted key inside the node; here it is a node on the canvas, because the
    // graph does not keep secrets. Organization, not rendering: neither reaches
    // the engine, both persist with the graph, and both are undoable because
    // losing a note to a stray click should be recoverable.
    case "set_node_tint":
      return withUndo({
        nodes: s.nodes.map((n) =>
          n.id === cmd.id ? { ...n, tint: cmd.tint ?? undefined } : n,
        ),
      });
    case "set_node_note":
      return withUndo({
        nodes: s.nodes.map((n) =>
          n.id === cmd.id ? { ...n, note: cmd.note.trim() || undefined } : n,
        ),
      });
    case "node_outside": {
      const node = s.nodes.find((n) => n.id === cmd.id);
      const maskWire = s.wires.find((w) => w.to === cmd.id && w.toPort === "mask");
      const outWire = s.wires.find((w) => w.from === cmd.id && w.kind === "image");
      if (!node || !maskWire || !outWire || node.isGroup || !node.hasIn || !node.hasOut) return s;
      const unique = (base: string) => {
        let id = base;
        let n = 2;
        while (s.nodes.some((k) => k.id === id)) id = `${base}${n++}`;
        return id;
      };
      const copyId = unique(`${cmd.id}_outside`);
      const invId = unique(`${cmd.id}_outmask`);
      const copy: NodeCard = {
        ...node,
        id: copyId,
        name: `${node.name} Outside`,
        x: node.x + NODE_W + 60,
        y: node.y + 26,
        params: { ...node.params },
        ...(node.curves ? { curves: { ...node.curves } } : {}),
        ...(node.textParams ? { textParams: { ...node.textParams } } : {}),
      };
      const inv: NodeCard = {
        id: invId,
        type: "heeler.invert_mask",
        name: "Invert Mask",
        cat: "masking",
        x: node.x + NODE_W + 60,
        y: node.y + 26 + NODE_H + 60,
        enabled: true,
        params: {},
        hasIn: true,
        hasOut: true,
        maskOut: true,
      };
      // The pair keeps its shape and steps clear of any card already
      // downstream of the original.
      const off = freeOffset(s.nodes, [copy, inv]);
      copy.x += off.dx;
      copy.y += off.dy;
      inv.x += off.dx;
      inv.y += off.dy;
      return withUndo({
        nodes: [...s.nodes, copy, inv],
        wires: s.wires
          // The copy takes over the original's downstream...
          .map((w) => (w === outWire ? { ...w, from: copyId } : w))
          .concat([
            // ...and the original feeds the copy.
            { ...wireSource(outWire), to: copyId, toPort: "in", kind: "image" },
            // The same mask, through the inverter, onto the copy: the
            // pair shares one selection by construction.
            { ...wireSource(maskWire), to: invId, toPort: "mask", kind: "mask" },
            { from: invId, to: copyId, toPort: "mask", kind: "mask" },
          ]),
        selection: [copyId],
      });
    }
    case "splice_node_into_wire": {
      const node = s.nodes.find((n) => n.id === cmd.id);
      if (!node) return s;
      // Heal the node's current position first, so this one gesture is
      // also "move a node elsewhere in the chain".
      const healed = spliceOut(s.wires, cmd.id);
      const target = healed.find(
        (w) => w.from === cmd.from && w.to === cmd.to && w.toPort === cmd.toPort,
      );
      // Dropping a node onto its own pipe healed that pipe away: the
      // node is already there, and the honest answer is nothing.
      if (!target) return s;
      // Where the spliced card sits: halfway between the pipe's two ends when
      // that spot is clear of every other card, else where it was dropped
      // when that is clear, else stepped free from there (2026-09-28: nothing
      // lands on top of another card). Only the spliced card ever moves.
      const others = s.nodes.filter((n) => n.id !== cmd.id);
      const fromN = s.nodes.find((n) => n.id === target.from);
      const toN = s.nodes.find((n) => n.id === target.to);
      const seated = (() => {
        if (fromN && toN) {
          const mid = { x: Math.round((fromN.x + toN.x) / 2), y: Math.round((fromN.y + toN.y) / 2) };
          const free = freeSpot(others, mid.x, mid.y);
          if (free.x === mid.x && free.y === mid.y) return mid;
        }
        return freeSpot(others, node.x, node.y);
      })();
      const placed =
        seated.x === node.x && seated.y === node.y
          ? s.nodes
          : s.nodes.map((n) => (n.id === cmd.id ? { ...n, x: seated.x, y: seated.y } : n));
      if (target.kind === "image") {
        if (!node.hasIn || !node.hasOut || node.maskOut) return s;
        // Only the main in and out move; the node's fields, a second
        // picture and its own field outputs come along (sideWires).
        const feedIn = chainFeed(s.wires, cmd.id);
        const sides = sideWires(s.wires, cmd.id, (w) => w === feedIn, (w) => w.kind !== "mask");
        return withUndo({
          nodes: placed,
          wires: rejoinSides(
            healed
              .filter((w) => w !== target)
              .concat([
                { ...wireSource(target), to: cmd.id, toPort: "in", kind: "image" },
                { from: cmd.id, fromPort: node.type === "heeler.export_layer" ? "image" : undefined, to: cmd.to, toPort: target.toPort, kind: target.kind },
              ]),
            sides,
          ),
        });
      }
      if (target.kind !== "mask") return s;
      // A mask or alpha pipe takes a field pass-through (26.3): field in,
      // field out, the pipe's landing kept downstream. "If a
      // node has Alpha in and out and is dragged over a Alpha connection
      // it should be able to connect."
      const seats = fieldSpliceSeats(node);
      if (!seats) return s;
      // Lift the node out of wherever it sat: the image chain behind it
      // heals, and its old field pass-through wires let go (a mask
      // source's consumers are not healed, the extract rule). spliceOut
      // is not asked to do this: it would rewrite a field OUT wire onto
      // the image feed. Its other inputs (a second operand, the Export
      // Layer's alpha) stay, as on a picture pipe (sideWires), each
      // only if it closes no loop (rejoinSides).
      // A field node whose field arrives on its diamond and that has no
      // picture out (Guided Filter (Mask)) is on no picture chain: the
      // picture on its in is a side input (its guide) and stays.
      const feed = node.maskOut && seats.inSeat === "mask" ? undefined : chainFeed(s.wires, cmd.id);
      const fieldSides = sideWires(
        s.wires,
        cmd.id,
        (w) => w === feed || onFieldSeat(node, w, seats.inSeat),
        (w) => w.kind !== "mask" || (w.fromPort ?? undefined) === seats.outPort,
      );
      const stripped = s.wires
        .filter((w) => w.to !== cmd.id && w.from !== cmd.id)
        .concat(
          feed ? s.wires.filter((w) => w.from === cmd.id && w.kind !== "mask").map((w) => ({ ...w, ...wireSource(feed) })) : [],
        );
      // A mask pipe into a group (a Finish mask into the layer group that
      // holds its layer) is routed inside by its sender: the group's
      // boundary entries that named the old sender name the spliced node
      // now, so the pipe still reaches the member it gated.
      const rerouted = placed.map((n) =>
        n.id === cmd.to && n.isGroup && n.groupBoundary?.some((b) => b.from === target.from && (b.groupPort ?? b.toPort) === target.toPort)
          ? {
              ...n,
              groupBoundary: n.groupBoundary.map((b) => {
                if (b.from !== target.from || (b.groupPort ?? b.toPort) !== target.toPort) return b;
                const { fromPort: _was, ...rest } = b;
                return { ...rest, from: cmd.id, ...(seats.outPort ? { fromPort: seats.outPort } : {}) };
              }),
            }
          : n,
      );
      return withUndo({
        nodes: rerouted,
        wires: rejoinSides(
          stripped
            .filter((w) => w !== target)
            .concat([
              { ...wireSource(target), to: cmd.id, toPort: seats.inSeat, kind: "mask" },
              {
                from: cmd.id,
                to: cmd.to,
                toPort: target.toPort,
                kind: "mask",
                ...(seats.outPort ? { fromPort: seats.outPort } : {}),
              },
            ]),
          fieldSides,
        ),
      });
    }
    case "extract_node": {
      // Pulled loose from the chain: the picture pipe heals around the
      // hole, and the node keeps its fields and other side wires
      // (sideWires), so it can be dropped somewhere else whole.
      // A field pass-through (invert_mask, the logic family) sits on a
      // field pipe instead: its operand in and field out are its main
      // wires, and let go as they always have.
      const node = s.nodes.find((n) => n.id === cmd.id);
      const seats = node ? fieldSpliceSeats(node) : null;
      const feed = chainFeed(s.wires, cmd.id);
      const mainIn = (w: Wire) => w === feed || (!!seats && !!node && onFieldSeat(node, w, seats.inSeat));
      const mainOut = (w: Wire) => w.kind !== "mask" || (!!seats && (w.fromPort ?? undefined) === seats.outPort);
      const sides = sideWires(s.wires, cmd.id, mainIn, mainOut);
      if (!s.wires.some((w) => (w.to === cmd.id || w.from === cmd.id) && !sides.includes(w))) return s;
      return withUndo({ wires: rejoinSides(spliceOut(s.wires, cmd.id), sides) });
    }
    // Not an edit: a request for the graph view to open its inline
    // rename on this node, so the N key can reach component state.
    case "request_rename":
      return { ...s, renameRequest: cmd.id };
    case "toggle_graph_search":
      return { ...s, graphSearchOpen: cmd.open };
    case "set_notice":
      return { ...s, notice: cmd.text ? { text: cmd.text, at: Date.now() } : null };
    case "open_docs":
      return { ...s, docsOpen: true, docsFile: cmd.file ?? null };
    case "close_docs":
      return { ...s, docsOpen: false, docsFile: null };
    case "set_enabled":
      return withUndo({
        nodes: s.nodes.map((n) =>
          n.id === cmd.id ? { ...n, enabled: cmd.enabled } : n,
        ),
        // The warp switched off takes its handles down with it.
        ...(!cmd.enabled && s.nodes.some((n) => n.id === cmd.id && n.type === warpTypeOfTool(s.tool))
          ? droppedGridWarpTool(s)
          : {}),
      });
    case "rename_node":
      return withUndo({
        nodes: s.nodes.map((n) =>
          n.id === cmd.id ? { ...n, name: cmd.name } : n,
        ),
      });
    case "delete_nodes": {
      const dead = new Set(cmd.ids);
      // Healed deletes splice each hole shut first (the extract move),
      // so X -> dead -> Y becomes X -> Y; deleting a whole run heals
      // through it one node at a time. The leftover wires of the dead
      // are filtered after, covering the unhealed mode and any ends the
      // splice could not save (a mask source's consumers, say).
      let wires = s.wires;
      if (cmd.heal) {
        for (const id of cmd.ids) {
          wires = spliceOut(wires, id);
        }
      }
      return withUndo({
        nodes: s.nodes.filter((n) => !dead.has(n.id)),
        wires: wires.filter((w) => !dead.has(w.from) && !dead.has(w.to)),
        selection: s.selection.filter((id) => !dead.has(id)),
      });
    }
    case "add_node": {
      if (s.nodes.some((n) => n.id === cmd.node.id)) return s;
      const spot = cmd.place ? placeNewNode(s, cmd.node, cmd.place === "beside") : cmd.node;
      const node = spot === cmd.node ? cmd.node : { ...cmd.node, x: spot.x, y: spot.y };
      const graphView = { ...s.graphView };
      if (cmd.place && cmd.viewport) {
        // A free spot can be beyond the view, especially beside a selected
        // card left behind by a pan. Reveal the new card without moving
        // existing cards or changing the user's zoom.
        const reveal = (position: number, size: number, extent: number, pan: number) => {
          const start = position * graphView.zoom + pan;
          const length = size * graphView.zoom;
          if (extent <= 0 || (start >= 12 && start + length <= extent - 12)) return pan;
          return (extent - length) / 2 - position * graphView.zoom;
        };
        graphView.x = reveal(node.x, NODE_W, cmd.viewport.width, graphView.x);
        graphView.y = reveal(node.y, NODE_H, cmd.viewport.height, graphView.y);
      }
      // Through the same migration a loaded card gets: a palette node arrives
      // with empty params by design (the engine has its own defaults), but the
      // Inspector renders from the instance, so the identity set is filled in
      // here or the panel shows nothing. The dials the Inspector offers for
      // this type are then given the registry's defaults where nothing set
      // them, so a placed node carries the numbers it shows and renders. Only
      // the dials: plumbing params (roi_*, lens coefficients) mean something
      // by being absent, and the engine's own defaults cover them.
      return withUndo({
        nodes: [...s.nodes, ...migrateNodes([node]).map(withRegistryDials)],
        graphView,
        selection: [node.id],
      });
    }
    case "connect": {
      const { wire } = cmd;
      const occupied = s.wires.some(
        (w) => w.to === wire.to && w.toPort === wire.toPort,
      );
      if (occupied || createsCycle(s.wires, wire.from, wire.to)) return s;
      const fromNode = s.nodes.find((n) => n.id === wire.from);
      const toNode = s.nodes.find((n) => n.id === wire.to);
      // Both ends must be cards of THIS graph: a pipe between a group's
      // member and a card outside it (or between ids that are nowhere)
      // would be a stray the flattened graph cannot resolve.
      if (!fromNode || !toNode) return s;
      // A File node's mask diamond names its port ("mask", 26.3 Phase
      // 6); without it the pipe is the card's ordinary image output,
      // which is why the node flag alone cannot qualify it.
      const isMaskSource = !!fromNode?.maskOut || wire.fromPort === "depth" || wire.fromPort === "mask";
      // The one type rule, the same one the graph's hand lights by from
      // either end (seatTakes). It used to name Output and the Export Layer
      // alone for the alpha diamond, so the Displacement Map's Y field and
      // Alpha Association's Replace alpha lit as targets and then refused
      // every drop (2026-10-01: "the second won't reconnect").
      if (!seatTakes(toNode, wire.toPort, isMaskSource)) return s;
      // Export Layer takes one image OR one field, never both: the
      // new pipe wins and the other input lets go. The alpha input is
      // its own affair and never evicts.
      let wires = s.wires;
      if (toNode?.type === "heeler.export_layer" && (wire.toPort === "in" || wire.toPort === "mask")) {
        const other = wire.toPort === "in" ? "mask" : "in";
        wires = wires.filter((w) => !(w.to === wire.to && w.toPort === other));
      }
      return withUndo({ wires: [...wires, wire] });
    }
    case "disconnect":
      return withUndo({
        wires: s.wires.filter(
          (w) => !(w.to === cmd.to && w.toPort === cmd.toPort),
        ),
      });
    case "open_group_dialog":
      return { ...s, groupDialogOpen: cmd.open };
    case "open_file_layers":
      // View state, not an edit: the choices are computed here from the
      // passes report so the dialog only renders them.
      return { ...s, fileLayersOffer: { path: cmd.path, ...fileLayerChoices(cmd.path, cmd.passes) } };
    case "close_file_layers":
      return { ...s, fileLayersOffer: null };
    case "open_catalog_layer_pick":
      return { ...s, catalogLayerPick: true };
    case "close_catalog_layer_pick":
      return { ...s, catalogLayerPick: false };
    case "set_transform_lock":
      return { ...s, transformLock: cmd.on };
    case "group_selection": {
      if (s.selection.length < 2) return s;
      const members = s.nodes.filter((n) => s.selection.includes(n.id));
      const rest = s.nodes.filter((n) => !s.selection.includes(n.id));
      const minX = Math.min(...members.map((n) => n.x));
      const minY = Math.min(...members.map((n) => n.y));
      const gid = `grp_${Date.now().toString(36)}`;
      const memberIds = new Set(members.map((n) => n.id));
      const groupNode: NodeCard = {
        id: gid,
        type: "heeler.group",
        name: cmd.name,
        // The dialog's description lands here, the same note field every
        // other node shows on its face. It used to be typed into the
        // dialog and thrown away: the textarea was never read.
        note: cmd.note?.trim() || undefined,
        cat: "group",
        x: minX,
        y: minY,
        enabled: true,
        params: {},
        isGroup: true,
        groupNodes: members,
        // The wires with both ends inside. The boundary ones are rewired to
        // the group itself; these are what makes the inside a graph rather
        // than a list.
        groupWires: s.wires.filter(
          (w) => s.selection.includes(w.from) && s.selection.includes(w.to),
        ),
        groupBoundary: s.wires.filter(
          (w) => s.selection.includes(w.from) !== s.selection.includes(w.to),
        ),
        hasIn: true,
        hasOut: true,
      };
      // Rewire boundary: outside->member becomes outside->group,
      // member->outside becomes group->outside; internal wires move inside.
      const outWires: Wire[] = [];
      for (const w of s.wires) {
        const fromIn = memberIds.has(w.from);
        const toIn = memberIds.has(w.to);
        if (fromIn && toIn) continue;
        if (!fromIn && !toIn) outWires.push(w);
        else if (!fromIn && toIn) {
          // One wire per (source, port), not per port: two members can be
          // fed by two different outside nodes on the same port (two
          // masks feeding two layers is the ordinary case), and keying
          // the dedupe on the port alone kept the first and silently
          // deleted the second. groupBoundary records both, and
          // flattenGroups matches on the sender to route each one home.
          if (
            !outWires.some(
              (o) => o.to === gid && o.from === w.from && o.fromPort === w.fromPort && o.toPort === w.toPort,
            )
          )
            outWires.push({ ...w, to: gid });
        } else if (
          !outWires.some(
            (o) => o.from === gid && o.to === w.to && o.fromPort === w.fromPort && o.toPort === w.toPort,
          )
        )
          outWires.push({ ...w, from: gid, kind: "group" });
      }
      return {
        ...s,
        nodes: [...rest, groupNode],
        wires: outWires,
        selection: [gid],
        groupDialogOpen: false,
        presets: [
          {
            name: cmd.name,
            meta: `${members.length} nodes`,
            filter: "contrast(1.1) sepia(.18)",
            isNew: true,
          },
          ...s.presets.map((p) => ({ ...p, isNew: false })),
        ],
        undoStack: [...s.undoStack, snapshot(s, `Group: ${cmd.name}`)].slice(
          -100,
        ),
        redoStack: [],
      };
    }
    case "open_group": {
      // Entering a group frames its contents ("when entering a
      // group, the nodes should center in the view by default"): the pan and
      // zoom belong to the graph you were just looking at, and carrying them
      // inside is how the nodes get lost. The old view is stashed, and
      // leaving puts it back exactly, so the trip inside costs nothing.
      if (cmd.id) {
        const g = s.nodes.find((n) => n.id === cmd.id);
        const view = cmd.frame ? framedView(g?.groupNodes ?? [], cmd.frame.w, cmd.frame.h) : null;
        return {
          ...s,
          openedGroup: cmd.id,
          graphViewBack: s.graphViewBack ?? s.graphView,
          ...(view ? { graphView: view } : {}),
        };
      }
      return {
        ...s,
        openedGroup: null,
        ...(s.graphViewBack ? { graphView: s.graphViewBack } : {}),
        graphViewBack: null,
      };
    }
    case "set_zoom":
      // Choosing a base view resets any freehand zoom and pan. Rotation
      // is deliberately left alone: it has its own reset. Leaving 1:1
      // drops the sharp patch along with the tier.
      return {
        ...s,
        viewerZoom: cmd.zoom,
        view: {
          ...s.view,
          zoomScale: 1,
          pan: { x: 0, y: 0 },
          roiPatch: cmd.zoom === "fit" ? null : s.view.roiPatch,
        },
      };
    case "set_stage_px": {
      // Rounded to the preview's own steps, so a window nudged a few
      // pixels asks for no new decode tier.
      const w = Math.round(cmd.w);
      const h = Math.round(cmd.h);
      if (s.view.stagePx?.w === w && s.view.stagePx?.h === h) return s;
      return { ...s, view: { ...s.view, stagePx: { w, h } } };
    }
    case "set_roi_patch": {
      // A patch for a photograph no longer on screen is stale by
      // definition: renders finish after image switches all the time.
      if (cmd.patch && cmd.patch.imageId !== s.activeImage) return s;
      // The frame dims outlive the patch: edits and fit-toggles drop the
      // slice, but the photograph's true size has not changed.
      const frameDims = cmd.patch
        ? { ...s.view.frameDims, [cmd.patch.imageId]: cmd.patch.frame }
        : s.view.frameDims;
      return { ...s, view: { ...s.view, roiPatch: cmd.patch, frameDims } };
    }
    case "zoom_viewer": {
      const raw = Math.min(32, Math.max(0.1, s.view.zoomScale * cmd.factor));
      // Land exactly on 1 when passing near it.
      //
      // At 1 the photograph maps one image pixel to one screen pixel and
      // nothing is resampled at all. At 0.99 every pixel is resampled by
      // a ratio close enough to 1 to carry almost no filtering, which on
      // fur or feathers is the worst case there is: the detail turns to
      // mush and the edges pick up color fringes. Comparing the two:
      // clicking 100% "looks fine", arriving at 99% by wheel looks poor.
      // Both are true and this is the difference.
      //
      // Sticky, not a trap: once the scale IS 1 the next wheel event
      // leaves freely, so the snap can be escaped in the same gesture
      // that found it.
      //
      // True 1:1 is a stop of its own (`unit`, the zoomScale the viewer
      // measured as one photograph pixel per device pixel): from Fit it
      // is the frame over the fit box, and a wheel passing it lands on
      // it, the same sticky way.
      const unit = cmd.unit && Number.isFinite(cmd.unit) && cmd.unit > 0 ? cmd.unit : null;
      const next =
        s.view.zoomScale !== 1 && Math.abs(raw - 1) < ZOOM_SNAP
          ? 1
          : unit !== null && s.view.zoomScale !== unit && Math.abs(raw / unit - 1) < ZOOM_SNAP
            ? unit
            : raw;
      // Zoom about the cursor: the point under it must stay put, which
      // means the pan slides by the same factor the scale changed by.
      const f = next / s.view.zoomScale;
      const cx = cmd.cx ?? 0;
      const cy = cmd.cy ?? 0;
      return {
        ...s,
        view: {
          ...s.view,
          zoomScale: next,
          pan: { x: f * s.view.pan.x + cx * (1 - f), y: f * s.view.pan.y + cy * (1 - f) },
        },
      };
    }
    case "zoom_step": {
      // The keyboard walks fixed rungs rather than multiplying by 1.25,
      // which after three presses leaves you on 1.953 and resampling
      // everything. Every rung is a ratio worth being on, and 1 is one of
      // them, so zooming in and back out returns to pixel-for-pixel
      // instead of near it.
      const cur = s.view.zoomScale;
      const next =
        cmd.dir > 0
          ? (ZOOM_LADDER.find((z) => z > cur * 1.001) ?? ZOOM_LADDER[ZOOM_LADDER.length - 1])
          : ([...ZOOM_LADDER].reverse().find((z) => z < cur * 0.999) ?? ZOOM_LADDER[0]);
      // Center stays put: the same compensation the cursor gets, with the
      // cursor at the middle.
      const f = next / cur;
      return {
        ...s,
        view: { ...s.view, zoomScale: next, pan: { x: f * s.view.pan.x, y: f * s.view.pan.y } },
      };
    }
    case "pan_viewer":
      return {
        ...s,
        view: { ...s.view, pan: { x: s.view.pan.x + cmd.dx, y: s.view.pan.y + cmd.dy } },
      };
    case "rotate_view":
      // Wraps, so spinning one way forever behaves.
      return { ...s, view: { ...s.view, viewRotation: (s.view.viewRotation + cmd.delta) % 360 } };
    case "reset_view_rotation":
      return { ...s, view: { ...s.view, viewRotation: 0 } };
    case "zoom_graph": {
      const next = Math.min(4, Math.max(0.2, s.graphView.zoom * cmd.factor));
      const f = next / s.graphView.zoom;
      return {
        ...s,
        graphView: {
          zoom: next,
          x: cmd.cx - (cmd.cx - s.graphView.x) * f,
          y: cmd.cy - (cmd.cy - s.graphView.y) * f,
        },
      };
    }
    case "pan_graph":
      return {
        ...s,
        graphView: {
          ...s.graphView,
          x: s.graphView.x + cmd.dx,
          y: s.graphView.y + cmd.dy,
        },
      };
    case "reset_graph_view":
      return { ...s, graphView: { x: 0, y: 0, zoom: 1 } };
    case "frame_graph": {
      // Frame the selected nodes, or everything in view when nothing is
      // selected. "When I enter a Finish group I had a hard
      // time finding the nodes in the view." Inside a group it frames the
      // group's contents, which is exactly that case.
      const opened = s.openedGroup ? s.nodes.find((n) => n.id === s.openedGroup) : undefined;
      const pool = opened?.groupNodes ?? s.nodes;
      const chosen = pool.filter((n) => s.selection.includes(n.id));
      const view = framedView(chosen.length ? chosen : pool, cmd.w, cmd.h);
      return view ? { ...s, graphView: view } : s;
    }
    case "toggle_compare":
      return { ...s, compare: !s.compare };
    case "toggle_split":
      return { ...s, splitOn: !s.splitOn };
    case "set_split_pos":
      return { ...s, view: { ...s.view, splitPos: Math.min(0.95, Math.max(0.05, cmd.pos)) } };
    case "set_compare_take":
      return { ...s, compareTake: cmd.id };
    case "set_expanded_tile":
      // The catalog grid's tile size: clamped to the slider's own
      // rails, so no stored pref can draw unusable tiles.
      return { ...s, expandedTile: Math.min(300, Math.max(96, cmd.px)) };
    case "select_images": {
      // A whole selection by id (the Stack panel's "select frames in
      // the ribbon"). Through select_image for the first, so every
      // cleanup that photo-switching owes (pickers down, view reset,
      // graph swap) happens exactly as if it had been clicked; then
      // the selection widens to the rest. Ids the folder does not hold
      // are dropped, and none at all is a no-op.
      const ids = cmd.ids.filter((id) => s.images.some((i) => i.id === id));
      if (!ids.length) return s;
      const first = reduce(s, { type: "select_image", id: ids[0] });
      return { ...first, imageSelection: ids };
    }
    case "set_split": {
      // One command, clamped per field, so no drag or typed value can
      // leave the split unrenderable: counts stay whole and small,
      // angles wrap, the radial apex stays on the frame.
      const next = { ...s.split, ...cmd.changes };
      const cells = (n: number) => Math.min(12, Math.max(1, Math.round(n) || 1));
      const unit = (v: number) => Math.min(1, Math.max(0, v));
      return {
        ...s,
        split: {
          ...next,
          angle: wrapDeg(next.angle),
          gridX: cells(next.gridX),
          gridY: cells(next.gridY),
          radialX: unit(next.radialX),
          radialY: unit(next.radialY),
          radialFrom: wrapDeg(next.radialFrom),
          radialTo: wrapDeg(next.radialTo),
        },
      };
    }
    case "undo": {
      const prev = s.undoStack[s.undoStack.length - 1];
      if (!prev) return s;
      // A Finish layer's mask polish undoes its own strokes; what came
      // before it waits for Apply or Cancel, and an Apply on its way in
      // waits for nothing.
      if (s.polishLayer && (s.polishLayer.applying !== 0 || s.undoStack.length <= s.polishLayer.depth)) return s;
      // A selected node the step back takes away lets go of the
      // selection, and a mask tool aimed at it goes down: undoing an Add
      // layer mask that armed the brush leaves no brush painting on
      // whatever mask happens to be next.
      const gone = s.selection.filter((id) => graphHasNode(s.nodes, id) && !graphHasNode(prev.nodes, id));
      const released: Partial<State> = gone.length
        ? {
            selection: s.selection.filter((id) => !gone.includes(id)),
            ...(MASK_EDIT_TOOLS.has(s.tool) ? { tool: "none" as const } : {}),
          }
        : {};
      const undone: State = {
        ...s,
        ...released,
        nodes: prev.nodes,
        wires: prev.wires,
        backdrops: prev.backdrops ?? [],
        // The picture just changed under the sharp slice.
        view: { ...s.view, roiPatch: null },
        undoStack: s.undoStack.slice(0, -1),
        redoStack: [...s.redoStack, { ...snapshot(s, prev.label), ...(prev.reset ? { redoReset: prev.reset.ids } : {}), ...(prev.ownPhoto ? { ownPhoto: true as const } : {}) }],
        // A step back past the open group's making leaves the editor
        // looking into a card that is gone; it comes back out.
        ...closedIfGone(s, prev.nodes),
      };
      return prev.reset ? undoReset(undone, prev.reset) : undone;
    }
    case "redo": {
      const next = s.redoStack[s.redoStack.length - 1];
      if (!next) return s;
      if (s.polishLayer && s.polishLayer.applying !== 0) return s;
      if (next.redoReset) {
        // Redoing a reset resets again, recording a fresh step, and
        // keeps whatever else is still waiting to be redone.
        const rest = s.redoStack.slice(0, -1);
        return { ...resetImages(s, next.redoReset), redoStack: rest };
      }
      return {
        ...s,
        nodes: next.nodes,
        wires: next.wires,
        backdrops: next.backdrops ?? [],
        view: { ...s.view, roiPatch: null },
        redoStack: s.redoStack.slice(0, -1),
        undoStack: [...s.undoStack, { ...snapshot(s, next.label), ...(next.ownPhoto ? { ownPhoto: true as const } : {}) }],
        ...closedIfGone(s, next.nodes),
      };
    }
  }
}

/** Find or create the node Simple-mode sliders write to. */
export function simpleTarget(
  s: State,
  section: "exposure" | "color" | "detail" | "effects",
): NodeCard | undefined {
  const byType: Record<string, string> = {
    exposure: "heeler.exposure",
    color: "heeler.standard_color",
    detail: "heeler.standard_color",
    effects: "heeler.grain",
  };
  return s.nodes.find((n) => n.type === byType[section]);
}
