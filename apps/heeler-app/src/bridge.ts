import { onTauriEvent } from "./taurievents";
import { chromaHistogramOfPixels } from "./eqcurve";
import { sourcePoint } from "./pickgeometry";
import { CHAIN_ORDER } from "./recipes";
import { flushRecoverySaves, trackedSave } from "./savebarrier";
import { autosaves } from "./autosave";
import { nextSaveRevision, observeSaveRevision } from "./saverevision";
// Backend bridge. Inside Tauri, previews come from the Rust engine as data
// URLs. In a plain browser (dev/preview/tests) the mock bridge approximates
// the graph with CSS filters so the UI is fully exercisable headless.

import type { ImageEntry, NodeCard, State, ViewState, PresetFile } from "./state";
import { frameLook, lookPreviewState, mainConversion, maskOverlayWanted, previewEdgeFor,
  settleJpegQuality, previewTarget, renderedSource, bornRendered, isRenderedSource, needsRenderedBypass, type FilePasses } from "./state";
import { ART_ID, ART_KINDS, ART_FX, BEND_FALLOFF_DEFAULT, artGroupMembers, exportDpi, exportWrittenName, flattenGroups, freshGraphFor, groupMembersReadBelow, isLayerEffect, isPictureWarp, spliceIn, thumbnailGraphFor } from "./state";

import { addLogCatalogRoot, logDebug } from "./log";
import { awaitFullPass } from "./fullpass";

export function isTauri(): boolean {
  // No window is no Tauri, not a crash: a settle timer (huesource.ts)
  // can outlive the test environment that started it, and a ReferenceError
  // here surfaced as an unhandled rejection that failed a green run.
  return typeof window !== "undefined" && typeof (window as any).__TAURI_INTERNALS__ !== "undefined";
}

/** Calls a Tauri unlisten defensively. Unlistening an event id the
 * table no longer knows (a window shutting down, a teardown that
 * raced a re-registration) throws from inside Tauri's own event
 * plumbing, and since the unlisten is async under the hood the throw
 * surfaced as "Unhandled rejection: TypeError: undefined is not an
 * object (evaluating 'listeners[eventId].handlerId')" in the owner's
 * console. A listener that is already gone is exactly what the caller
 * wanted.*/
export function safeUnlisten(un: (() => unknown) | null | undefined): void {
  if (!un) return;
  try {
    const r = un();
    if (r && typeof (r as Promise<unknown>).catch === "function") {
      void (r as Promise<unknown>).catch((e) => {
        void import("./log").then(({ logDebug }) =>
          logDebug(() => `safeUnlisten: swallowed an async teardown failure: ${String(e)}`),
        );
      });
    }
  } catch (e) {
    // Already unlistened, or the table is mid-teardown: either way
    // done. Said at DEBUG, so a teardown that misbehaves
    // SYSTEMATICALLY does not fail in total silence (the audit's ask).
    void import("./log").then(({ logDebug }) =>
      logDebug(() => `safeUnlisten: swallowed a teardown failure: ${String(e)}`),
    );
  }
}

/** The longest a render call may go unanswered before the caller treats
 * it as failed. Generous on purpose: the first render after the machine
 * wakes can be re-decoding a RAW behind the request, and that is seconds,
 * not the sub-second a warm cache answers in. */
export const RENDER_TIMEOUT_MS = 30_000;

/** What a render call that outlived RENDER_TIMEOUT_MS fails with. Written
 * here once and recognized by renderTimedOut, so a caller that treats a
 * deadline differently from a failure (the render pump, while a stack
 * merges) is not matching words it has to keep in step by hand. */
export function renderTimeoutMessage(channel: string): string {
  return `${channel} did not answer within ${RENDER_TIMEOUT_MS / 1000}s`;
}

/** Whether `error` is `channel`'s deadline running out rather than the
 * render failing. */
export function renderTimedOut(channel: string, error: string | null | undefined): boolean {
  return error === renderTimeoutMessage(channel);
}

/** The one road to the backend. Every command crosses here, so one
 * debug line covers all of them: name, argument SHAPE (keys and
 * scalars, never a graph blob or an image), duration, and the error
 * verbatim on failure. This is the audit's highest-leverage seam: 147
 * commands instrumented by a single function. */
const CALL_NEVER_LOG = new Set([
  // ~25/s while live view runs: logging it would defeat the tier.
  "usb_camera_liveview_frame",
  // A server or inference error can echo a question. Rust records only
  // chat sizes and timings; never send these errors to the disk ledger.
  "assistant_chat",
  "florence_describe",
]);
const CALL_QUIET = new Set([
  // Every-2s pollers: an empty poll says nothing; failures still log.
  "tether_poll",
  "usb_camera_poll",
  // Once per window resize while the window is being dragged.
  "set_maximize_button_rect",
]);

/** How a command's arguments read in the debug ledger. */
function argShape(args?: Record<string, unknown>): string {
  if (!args) return "";
  const parts = Object.entries(args).map(([k, v]) => {
    if (v === null || v === undefined) return k;
    if (typeof v === "number" || typeof v === "boolean") return `${k}=${v}`;
    if (typeof v === "string") return v.length <= 64 ? `${k}=${v}` : `${k}=str(${v.length})`;
    if (Array.isArray(v)) return `${k}=[${v.length}]`;
    return `${k}={..}`;
  });
  return ` {${parts.join(" ")}}`;
}

function call<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  // Enter before the dynamic import, so a just-started preset write is awaited.
  const saves = name.startsWith("save_") || ["preset_save", "preset_import", "preset_trash", "reset_image_edits", "set_image_keywords", "set_image_rating", "set_image_flag", "set_image_link_group"].includes(name);
  return saves ? trackedSave(`${name}:${String(args?.imageId ?? args?.path ?? `${args?.category ?? ""}/${args?.name ?? ""}`)}`, () => nativeCall<T>(name, args)) : nativeCall<T>(name, args);
}
/** The catalog update prompt, installed by catalogupgrade.ts (which
 * imports this module, so the dependency runs this way). A call refused
 * at the schema gate asks through it and retries once on yes; a quit
 * answers no and the refusal stands. Without this, every command that
 * happened to run before the prompt was answered (six at boot) failed
 * for good and its part of the window stayed empty until relaunch. */
let upgradeAsk: ((pending: UpgradePending) => Promise<boolean>) | null = null;
export function installUpgradeAsk(ask: ((pending: UpgradePending) => Promise<boolean>) | null): void {
  upgradeAsk = ask;
}

async function nativeCall<T>(name: string, args?: Record<string, unknown>, retried = false): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  if (CALL_NEVER_LOG.has(name)) return invoke<T>(name, args);
  const t0 = performance.now();
  try {
    const out = await invoke<T>(name, args);
    if (!CALL_QUIET.has(name)) {
      logDebug(() => `${name}${argShape(args)} ok in ${Math.round(performance.now() - t0)}ms`);
    }
    return out;
  } catch (e) {
    const pending = retried ? null : parseUpgradePending(e);
    if (pending && upgradeAsk) {
      logDebug(() => `${name} waits at the catalog update gate`);
      if (await upgradeAsk(pending)) return nativeCall<T>(name, args, true);
    }
    logDebug(() => `${name}${argShape(args)} FAILED in ${Math.round(performance.now() - t0)}ms: ${String(e)}`);
    throw e;
  }
}

/** call with a deadline, for the render commands.
 *
 * Without one, a single render that never answers wedges the whole
 * preview pipeline: the Rust side serializes renders behind one lock, so
 * the wedged call queues every later render behind it, and the JS side
 * awaits the promise forever. The owner hit this after leaving the app
 * idle for hours: a layer toggle never repainted (the old frame stayed
 * up), and after switching images the badge read APPROX over the raw
 * photo until the wedged call happened to return. With a deadline the
 * caller can log, keep its last good frame, and try again.*/
export async function invokeRender<T>(
  channel: string,
  args: Record<string, unknown>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      call<T>(channel, args),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => {
            logDebug(() => `${channel} TIMED OUT after ${RENDER_TIMEOUT_MS / 1000}s`);
            reject(
              new Error(renderTimeoutMessage(channel)),
            );
          },
          RENDER_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** CSS-filter approximation of the active graph, for mock previews. */
export function previewFilter(state: State): string {
  const parts: string[] = [];
  for (const n of state.nodes) {
    if (!n.enabled) continue;
    if (n.type === "heeler.exposure") {
      const ev = n.params.exposure ?? 0;
      const c = n.params.contrast ?? 0;
      parts.push(`brightness(${Math.pow(2, ev).toFixed(3)})`);
      if (c !== 0) parts.push(`contrast(${(1 + c / 200).toFixed(3)})`);
    }
    if (n.type === "heeler.standard_color") {
      const sat = n.params.saturation ?? 0;
      const vib = n.params.vibrance ?? 0;
      const temp = n.params.temperature ?? 6500;
      const s = 1 + (sat + vib * 0.5) / 150;
      if (s !== 1) parts.push(`saturate(${s.toFixed(3)})`);
      const dt = (temp - 6500) / 6500;
      if (Math.abs(dt) > 0.01) parts.push(`sepia(${Math.min(0.6, Math.abs(dt) * 0.5).toFixed(3)})`);
    }
    if (n.type === "heeler.grain" && (n.params.grain_amount ?? 0) > 40) {
      parts.push("contrast(1.02)");
    }
    if (n.type === "heeler.color_grade") {
      // Honest ceiling of a CSS approximation: filters are global, a
      // Color Set is hue-scoped, so the mock preview applies the grade
      // to everything. The engine path is the truth; this keeps the
      // browser build's thumbnails moving instead of frozen.
      const hue = n.params.hue_shift ?? 0;
      const sat = n.params.saturation ?? 0;
      const ev = n.params.exposure ?? 0;
      if (hue !== 0) parts.push(`hue-rotate(${hue.toFixed(1)}deg)`);
      if (sat !== 0) parts.push(`saturate(${(1 + sat / 100).toFixed(3)})`);
      if (ev !== 0) parts.push(`brightness(${Math.pow(2, ev).toFixed(3)})`);
    }
    if (n.type === "heeler.black_white") {
      // Treatment strength, not the enabled flag (which is the bypass).
      const amount = (n.params.amount ?? 0) / 100;
      if (amount > 0) {
        parts.push(`grayscale(${+amount.toFixed(3)})`);
        const red = n.params.red ?? 30;
        if (red > 60) parts.push("brightness(1.05)");
      }
    }
    if (n.type === "heeler.denoise" && (n.params.strength ?? 0) > 0) {
      parts.push(`blur(${((n.params.strength ?? 0) / 100).toFixed(2)}px)`);
    }
    if (n.type === "heeler.levels") {
      const black = n.params.black ?? 0;
      const white = n.params.white ?? 1;
      const gamma = n.params.gamma ?? 1;
      if (white - black < 0.999) parts.push(`contrast(${(1 / Math.max(0.05, white - black)).toFixed(3)})`);
      if (gamma !== 1) parts.push(`brightness(${(1 + (gamma - 1) * 0.35).toFixed(3)})`);
    }
    if (n.type === "heeler.curves" && n.curves?.rgb) {
      // Approximate: mid-point lift/drop maps to brightness.
      const rgb = n.curves.rgb;
      const mid = rgb.reduce((best, p) => (Math.abs(p[0] - 0.5) < Math.abs(best[0] - 0.5) ? p : best), rgb[0]);
      const delta = mid[1] - mid[0];
      if (Math.abs(delta) > 0.005) parts.push(`brightness(${(1 + delta * 0.9).toFixed(3)})`);
    }
    if (n.type === "heeler.color_balance") {
      const lum = ((n.params.shadows_lum ?? 0) + (n.params.midtones_lum ?? 0) + (n.params.highlights_lum ?? 0)) / 3;
      if (Math.abs(lum) > 3) parts.push(`brightness(${(1 + lum / 250).toFixed(3)})`);
    }
    if (n.type === "heeler.color_bend") {
      // Crude on purpose: CSS can rotate every hue by the same amount,
      // which is not what a bend does (it moves one neighborhood, and
      // saturation with it). Without something here the control looks
      // dead in the browser build, which is worse than approximate. The
      // hue swing is scaled by how much of the wheel the reach covers,
      // so a tight bend nudges and a wide one swings.
      const shift = ((n.params.dst_hue ?? 0) - (n.params.src_hue ?? 0) + 540) % 360 - 180;
      const reach = Math.min(1, (n.params.falloff ?? BEND_FALLOFF_DEFAULT) / 1.4);
      const amount = (n.params.amount ?? 100) / 100;
      const deg = shift * reach * amount;
      if (Math.abs(deg) > 0.5) parts.push(`hue-rotate(${deg.toFixed(1)}deg)`);
      const dsat = (n.params.dst_sat ?? 0.5) - (n.params.src_sat ?? 0.5);
      if (Math.abs(dsat) > 0.02) parts.push(`saturate(${(1 + dsat * reach * amount).toFixed(3)})`);
    }
  }
  return parts.join(" ") || "none";
}

/** Per-node thumbnail approximation: cumulative filter up to that node. */
export function nodeThumbFilter(state: State, node: NodeCard): string {
  if (node.cat === "masking") return "grayscale(1) contrast(3.4) brightness(1.1)";
  if (node.isGroup) return "sepia(.25) contrast(1.05)";
  // Walk upstream chain accumulating a rough filter.
  const upstream: NodeCard[] = [];
  let cur: NodeCard | undefined = node;
  const guard = new Set<string>();
  while (cur && !guard.has(cur.id)) {
    guard.add(cur.id);
    upstream.unshift(cur);
    const wire = state.wires.find((w) => w.to === cur!.id && w.toPort === "in");
    cur = wire ? state.nodes.find((n) => n.id === wire.from) : undefined;
  }
  const sub: State = { ...state, nodes: upstream };
  return previewFilter(sub);
}

export interface RenderResult {
  /** Present only when native inputs are safe to reuse across tiers. */
  sourceIdentity?: string;
  memoryNotice?: string;
  url: string | null;
  cssFilter: string;
  /** engine-side render milliseconds, when the engine produced the frame */
  ms?: number;
  /** the image this frame was rendered for (stale-frame rejection) */
  imageId?: string;
  /** which backend rendered the frame: "cpu" or "gpu:N" */
  backend?: string;
  /** engine render failure, surfaced so the UI never degrades silently */
  error?: string;
}

export interface FolderImage {
  renderedBake?: boolean;
  phoneRendered?: boolean;
  renderedFrames?: boolean;
  bakedFrom?: string | null;
  link_group?: string | null;
  id: string;
  name: string;
  stars: number;
  flag: "" | "pick" | "reject";
  /** catalog's persisted edited mark; drives the thumbnail badge */
  edited?: boolean;
  /** the catalog knows this photograph and the file is not where it
   * says. The thumbnail still comes back, from the cache, which is the
   * point: a moved photograph stays visible and findable instead of
   * quietly falling out of the library. */
  missing?: boolean;
  /** the link group the photograph belongs to, if any */
  linkGroup?: string | null;
}

/** What a graph's serializer needs to know of the photograph it is
 * for: its name and whether it arrives rendered (a bake, a phone DNG, a
 * composite of finished pictures), which decides its fresh Tone Profile. */
export type RenderedSource = Pick<ImageEntry, "name" | "phoneRendered" | "renderedBake" | "renderedFrames">;

/** The desktop's image row as the app's ImageEntry: the one mapping
 * every path shares (opening a folder, a new stack or panorama, a bake,
 * a tethered arrival). Each used to copy the row by hand, and the copies
 * drifted: a just-made panorama of phone DNGs dropped phoneRendered
 * (the 26.4.3 second refactor, the refactoring ledger). An absent flag is
 * unflagged, an absent mark false, and the link group arrives under
 * either spelling. `src` is the picture to show until the thumbnail
 * lands: none on the desktop. */
export function entryFromRow(row: FolderImage, src = ""): ImageEntry {
  return {
    id: row.id,
    name: row.name,
    stars: row.stars,
    flag: row.flag ?? "",
    edited: row.edited ?? false,
    missing: row.missing ?? false,
    linkGroup: row.linkGroup ?? row.link_group ?? null,
    renderedBake: row.renderedBake,
    phoneRendered: row.phoneRendered,
    renderedFrames: row.renderedFrames,
    bakedFrom: row.bakedFrom,
    filter: "none",
    src,
  };
}

export interface BridgeFolder {
  id: number;
  name: string;
  path: string;
  count: number;
  lastOpened: number;
}

export interface BridgeCollection {
  id: number;
  name: string;
  count: number;
  hasLook: boolean;
}

export interface SubfolderEntry {
  name: string;
  path: string;
}

/** What opening a folder returns: which folder it was, its own images,
 * and navigable subfolders (never scanned until visited). An empty `path`
 * means the dialog was canceled. */
export interface FolderListing {
  name: string;
  path: string;
  images: FolderImage[];
  subfolders: SubfolderEntry[];
}

/** In-browser stand-in for the catalog, so the library panel is fully
 * exercisable (and testable) without Tauri. "Trip" mirrors the real-world
 * case that froze the app: a root with only subfolders. */
const mockLibrary = {
  folders: [
    { id: 1, name: "Wedding", path: "mock://wedding", count: 3, lastOpened: 0 },
    { id: 2, name: "Landscapes", path: "mock://landscapes", count: 3, lastOpened: 0 },
    { id: 3, name: "Trip", path: "mock://trip", count: 0, lastOpened: 0 },
  ] as BridgeFolder[],
  collections: [] as BridgeCollection[],
  members: new Map<number, Map<string, string>>(),
  nextCollectionId: 1,
  session: null as { treeRoot: string; activeFolder: string; activeImage: string } | null,
  uiSettings: null as string | null,
  // Per-root sessions, written by saveSession exactly the way the Rust
  // side writes them. The first version of this mock kept them separate
  // "for test isolation", which is precisely how the mock failed to
  // reproduce a save overwriting the session being restored from. Tests
  // isolate through mockResetSessions instead.
  folderSessions: new Map<string, { activeFolder: string; activeImage: string }>(),
};

const MOCK_FILES: FolderImage[] = [
  { id: "mock_1", name: "IMG_0001.dng", stars: 0, flag: "" },
  { id: "mock_2", name: "IMG_0002.dng", stars: 3, flag: "pick", edited: true },
  { id: "mock_3", name: "IMG_0003.jpg", stars: 0, flag: "" },
];

const MOCK_LISTINGS: Record<string, FolderListing> = {
  "mock://wedding": { name: "Wedding", path: "mock://wedding", images: MOCK_FILES, subfolders: [] },
  "mock://landscapes": { name: "Landscapes", path: "mock://landscapes", images: MOCK_FILES, subfolders: [] },
  "mock://trip": {
    name: "Trip",
    path: "mock://trip",
    images: [],
    subfolders: [
      { name: "Day 1", path: "mock://trip/day1" },
      { name: "Day 2", path: "mock://trip/day2" },
    ],
  },
  "mock://trip/day1": { name: "Day 1", path: "mock://trip/day1", images: MOCK_FILES, subfolders: [] },
  "mock://trip/day2": { name: "Day 2", path: "mock://trip/day2", images: MOCK_FILES, subfolders: [] },
};

/** Opens a folder (native dialog inside Tauri when no path is given; small
 * fixture in the mock bridge so browser dev and tests can exercise it). */
export async function openFolder(path?: string): Promise<FolderListing | null> {
  if (isTauri()) {
      const listing = await call<FolderListing>("open_folder", { path: path ?? null });
    // The opened root feeds the log scrubber: DEBUG lines shorten
    // paths under it to [catalog]/..., which also covers Windows
    // catalogs on secondary drives where nothing sits under home.
    if (listing?.path) addLogCatalogRoot(listing.path);
    return listing;
  }
  const folder = mockLibrary.folders.find((f) => f.path === path);
  if (folder) folder.lastOpened = Date.now();
  const key = path ?? "mock://wedding";
  return (
    MOCK_LISTINGS[key] ?? {
      name: key.split("/").pop() ?? key,
      path: key,
      images: MOCK_FILES,
      subfolders: [],
    }
  );
}

/** Folder paths containing at least one edited image (edited badges). */
export async function editedFolders(): Promise<string[]> {
  if (isTauri()) {
      return call<string[]>("edited_folders");
  }
  // A shallow and a deep path, so ancestor propagation is exercisable.
  return ["mock://wedding", "mock://trip/day1"];
}

// Hiding, deleting, and catalog management --------------------------------

export interface CatalogInfo {
  path: string;
  images: number;
  folders: number;
  collections: number;
  hidden: number;
  thumbnails: number;
  total_bytes: number;
  /** what a backup costs once the regenerable thumbnails are left out */
  irreplaceable_bytes: number;
}

export interface BackupResult {
  path: string;
  bytes: number;
  images: number;
  folders: number;
  thumbnails_dropped: number;
}

/** What a restore did: the copy put in place, its counts, the file set
 * aside beside it, and the copy's schema against this build's. */
export interface RestoreReport {
  path: string;
  images: number;
  folders: number;
  replaced: string;
  schema: number;
  current_schema: number;
}

/** Puts a copy of the catalog in place of the active one, journal and
 * all handled, the old file set aside with the date. The catalog is not
 * opened here: open it afterwards (switchCatalog), so an older copy
 * meets the update prompt like any other door. */
export async function restoreCatalog(source: string): Promise<RestoreReport | null> {
  if (!isTauri()) return null;
  return call<RestoreReport>("restore_catalog", { source });
}

export interface ImportResult {
  folders_added: number;
  images_added: number;
  collections_added: number;
  images_skipped: number;
}

export interface DeleteResult {
  deleted: number;
  failed: string[];
}


export async function hiddenInFolder(path: string): Promise<number> {
  if (!isTauri()) return 0;
  return (await call("hidden_in_folder", { path })) as number;
}

export async function recoverHidden(path: string): Promise<number> {
  if (!isTauri()) return 0;
  return (await call("recover_hidden", { path })) as number;
}

/** Moves photographs into the `.trash` beside them. A rename, not a
 * deletion: the file is still on the disk, under a folder the user can
 * open, and Put Back returns it. */
export async function moveImagesToTrash(imageIds: string[]): Promise<TrashReport> {
  if (!isTauri()) return { moved: imageIds.length, moved_ids: imageIds, failed: [] };
  return (await call("move_images_to_trash", { imageIds })) as TrashReport;
}


export async function restoreImagesFromTrash(imageIds: string[]): Promise<TrashReport> {
  if (!isTauri()) return { moved: imageIds.length, moved_ids: imageIds, failed: [] };
  return (await call("restore_images_from_trash", { imageIds })) as TrashReport;
}

/** Trashed photographs whose file is no longer in `.trash` (removed
 * outside Heeler), with where each was last; ones on a drive that is
 * not connected are skipped and counted, never offered. Reads only. */
export interface MissingTrashed {
  ids: string[];
  paths: string[];
  skipped: number;
  skipped_volumes: string[];
}

export async function missingTrashedPhotos(): Promise<MissingTrashed> {
  if (!isTauri()) return { ids: [], paths: [], skipped: 0, skipped_volumes: [] };
  return (await call("missing_trashed_photos")) as MissingTrashed;
}

/** Forgets those of `imageIds` whose file is still gone from `.trash`:
 * the catalog's records go, the same removal as Flush folder; no file
 * is touched. Returns how many were forgotten. */
export async function forgetMissingTrashedPhotos(imageIds: string[]): Promise<number> {
  if (!isTauri()) return imageIds.length;
  return (await call("forget_missing_trashed_photos", { imageIds })) as number;
}

/** What a folder's trash is holding. The number behind the badge, and
 * the only way somebody learns they have one without going looking. */
export async function trashInFolder(path: string): Promise<TrashSummary> {
  if (!isTauri()) return { count: 0, bytes: 0 };
  return (await call("trash_in_folder", { path })) as TrashSummary;
}

/** Folders holding trashed photographs. */
export async function foldersWithTrash(): Promise<string[]> {
  if (!isTauri()) return [];
  return (await call("folders_with_trash")) as string[];
}

/** Opens a folder's `.trash` in the file browser. Nothing in the app
 * empties it, so this is where the trail ends: the deleting, if any, is
 * the user's own act in their own file manager. */
export async function revealTrash(path: string): Promise<void> {
  if (!isTauri()) return;
  await call("reveal_trash", { path });
}

export async function foldersWithHidden(): Promise<string[]> {
  if (!isTauri()) return [];
  return (await call("folders_with_hidden")) as string[];
}

/** What a folder command would reach, subfolders included. */
export interface FolderSubtreeCounts {
  folders: number;
  images: number;
}

export let mockSubtreeCounts: FolderSubtreeCounts = { folders: 1, images: 0 };
export let mockFolderCommands: { command: "hide" | "flush"; path: string }[] = [];

export function mockSetSubtreeCounts(next: FolderSubtreeCounts): void {
  mockSubtreeCounts = next;
  mockFolderCommands = [];
}

/** Test hook for the stall plan's probes: while set, the browser
 * mock's count waits on it, the slow-volume stand-in. */
export let mockSubtreeCountsHold: Promise<void> | null = null;
export function mockSetSubtreeCountsHold(next: Promise<void> | null): void {
  mockSubtreeCountsHold = next;
}

export async function folderSubtreeCounts(path: string): Promise<FolderSubtreeCounts> {
  if (!isTauri()) {
    if (mockSubtreeCountsHold) await mockSubtreeCountsHold;
    return mockSubtreeCounts;
  }
  return (await call("folder_subtree_counts", { path })) as FolderSubtreeCounts;
}

/** Hides a folder and its subfolders from the library; every record
 * stays, and browsing to the folder again brings it back. */
export async function hideFolder(path: string): Promise<number> {
  if (!isTauri()) {
    mockFolderCommands.push({ command: "hide", path });
    return mockSubtreeCounts.folders;
  }
  return (await call("hide_folder", { path })) as number;
}

/** Forgets a folder and its subfolders: the catalog's records go. No
 * file is touched, and the edits live outside the catalog. */
export async function flushFolder(path: string): Promise<FolderSubtreeCounts> {
  if (!isTauri()) {
    mockFolderCommands.push({ command: "flush", path });
    return mockSubtreeCounts;
  }
  return (await call("flush_folder", { path })) as FolderSubtreeCounts;
}

export interface RecentCatalog {
  path: string;
  name: string;
  exists: boolean | null;
  active: boolean | null;
}

export let mockRecentCatalogs: RecentCatalog[] = [];

export function mockSetRecentCatalogs(next: RecentCatalog[]): void {
  mockRecentCatalogs = next;
}

/** The catalogs this machine has had open, most recent first. The menu
 * takes the first ten; `all` asks for the whole remembered history,
 * which is what Catalogs and recovery lists. */
export async function recentCatalogs(checkAvailability = false, all = false): Promise<RecentCatalog[]> {
  if (!isTauri()) return (mockRecentCatalogs ?? []).slice(0, all ? 40 : 10);
  return ((await call("recent_catalogs", { checkAvailability, all })) as RecentCatalog[] | null | undefined) ?? [];
}

/** Takes one catalog off the list. The database is not touched: this
 * forgets a path, and opening it again puts it back at the front. */
export async function forgetRecentCatalog(path: string): Promise<RecentCatalog[]> {
  if (!isTauri()) {
    mockRecentCatalogs = mockRecentCatalogs.filter((r) => r.path !== path);
    return mockRecentCatalogs;
  }
  return ((await call("forget_recent_catalog", { path })) as RecentCatalog[] | null | undefined) ?? [];
}

/** Empties the list. Paths only; no catalog file is removed. */
export async function clearRecentCatalogs(): Promise<RecentCatalog[]> {
  if (!isTauri()) {
    mockRecentCatalogs = [];
    return mockRecentCatalogs;
  }
  return ((await call("clear_recent_catalogs", {})) as RecentCatalog[] | null | undefined) ?? [];
}


/** Runs the scheduled catalog backup if one is due. Returns what it
 * wrote, or null when the schedule is off or the last one is recent. */
export async function runScheduledBackup(
  folder: string,
  everyDays: number,
): Promise<BackupResult | null> {
  if (!isTauri() || !folder || everyDays <= 0) return null;
  return (await call("run_scheduled_backup", { folder, everyDays })) as BackupResult | null;
}

export async function pickCatalogFile(): Promise<string | null> {
  if (!isTauri()) return null;
  return call<string | null>("pick_catalog_file");
}

export async function pickCatalogDestination(suggested: string): Promise<string | null> {
  if (!isTauri()) return null;
  return call<string | null>("pick_catalog_destination", { suggested });
}

export async function catalogInfo(): Promise<CatalogInfo | null> {
  if (!isTauri()) return null;
  return (await call("catalog_info")) as CatalogInfo;
}

export async function revealCatalog(): Promise<void> {
  if (!isTauri()) return;
  await call("reveal_catalog");
}

export async function backupCatalog(
  dest: string,
  includeThumbnails = false,
): Promise<BackupResult | null> {
  if (!isTauri()) return null;
  return (await call("backup_catalog", { dest, includeThumbnails })) as BackupResult;
}

export type RecoveryReport = {
  path: string; complete: boolean; images: number; graphs: number; takes: number;
  presets: number; assets: number; required_inputs: number; app_version: string; problems: string[];
  /** what does not make the bundle incomplete but is worth saying:
   * Finish pictures left out by Keep baked pictures in backups, and any
   * of those that are missing (absent from an older desktop) */
  notes?: string[];
  /** every original the edits refer to that is not at its recorded
   * path; problems carries one line counting them (absent from an
   * older desktop) */
  missing_originals?: string[];
};
export async function pickRecoveryDestination(): Promise<string | null> {
  return isTauri() ? call("pick_recovery_destination") : null;
}
export async function createRecoveryBundle(dest: string): Promise<RecoveryReport | null> {
  await flushRecoverySaves();
  return isTauri() ? call("create_recovery_bundle", { dest }) : null;
}
export async function verifyRecoveryBundle(path: string): Promise<RecoveryReport | null> {
  return isTauri() ? call("verify_recovery_bundle", { path }) : null;
}

export async function createCatalog(path: string): Promise<CatalogInfo | null> {
  if (!isTauri()) return null;
  return (await call("create_catalog", { path })) as CatalogInfo;
}

export async function openCatalog(path: string): Promise<CatalogInfo | null> {
  if (!isTauri()) return null;
  return (await call("open_catalog", { path })) as CatalogInfo;
}

// The schema upgrade gate (26.3) ---------------------------------------

/** A catalog that predates this build's schema, held at the gate until
 * the user has had the backup choice. Nothing opens or migrates it
 * before then. */
export interface UpgradePending {
  path: string;
  from: number;
  to: number;
  appVersion: string;
}

const UPGRADE_PENDING_PREFIX = "upgrade-pending:";

/** Reads the typed refusal every catalog door shares (src-tauri's
 * upgrade_pending_error): the prefix is the cue to answer with the
 * update prompt rather than an error dialog. */
export function parseUpgradePending(error: unknown): UpgradePending | null {
  const text = error instanceof Error ? error.message : String(error);
  if (!text.startsWith(UPGRADE_PENDING_PREFIX)) return null;
  try {
    const raw = JSON.parse(text.slice(UPGRADE_PENDING_PREFIX.length)) as {
      path?: unknown; from?: unknown; to?: unknown; app_version?: unknown;
    };
    if (typeof raw.path !== "string" || typeof raw.from !== "number" || typeof raw.to !== "number") return null;
    return {
      path: raw.path,
      from: raw.from,
      to: raw.to,
      appVersion: typeof raw.app_version === "string" ? raw.app_version : "",
    };
  } catch {
    return null;
  }
}

/** The boot probe: the active catalog's pending update, if one is
 * waiting. Nothing opens and nothing migrates here. */
export async function catalogUpgradeCheck(): Promise<UpgradePending | null> {
  if (!isTauri()) return null;
  const raw = await call<{ path: string; from: number; to: number; app_version: string } | null>("catalog_upgrade_check");
  return raw ? { path: raw.path, from: raw.from, to: raw.to, appVersion: raw.app_version } : null;
}

/** Approves the update for this session. With backup, the backend first
 * snapshots the catalog UNOPENED beside itself and returns the
 * snapshot's path; a failed backup approves nothing and throws, so the
 * prompt can offer the choices again. */
export async function catalogUpgradeApprove(path: string, backup: boolean): Promise<BackupResult | null> {
  if (!isTauri()) return null;
  return call<BackupResult | null>("catalog_upgrade_approve", { path, backup });
}

/** The "always back up before an update" policy lives outside the
 * catalog (a small JSON file in app data), so it is readable before any
 * catalog can open. */
export async function catalogUpgradeAlwaysBackup(): Promise<boolean> {
  if (!isTauri()) return false;
  return call<boolean>("catalog_upgrade_policy");
}

export async function setCatalogUpgradeAlwaysBackup(on: boolean): Promise<void> {
  if (!isTauri()) return;
  await call("set_catalog_upgrade_policy", { alwaysBackup: on });
}

/** The update prompt's third button: nothing was opened, nothing
 * migrated; the app simply closes. */
export async function quitApp(): Promise<void> {
  if (!isTauri()) return;
  await call("quit_app");
}

/** Copies the active catalog to `dest`, verifies the copy, switches to
 * it, and sets the old file aside under a dated name. */
export async function moveCatalog(dest: string): Promise<CatalogInfo | null> {
  if (!isTauri()) return null;
  return (await call("move_catalog", { dest })) as CatalogInfo;
}

export async function importCatalog(path: string): Promise<ImportResult | null> {
  if (!isTauri()) return null;
  return (await call("import_catalog", { path })) as ImportResult;
}

// Served views -------------------------------

export interface ServeStatus {
  name: string;
  url: string;
  count: number;
}

export interface ServeItem {
  id: string;
  name: string;
}

/** The mock's share, so the browser build and the tests exercise the
 * real flow: banner, stop, one-share-at-a-time. Renders are skipped
 * (exportTo is a no-op without the engine), which mirrors nothing the
 * server itself does differently. */
let mockServe: ServeStatus | null = null;

/** A fresh, emptied directory for the next share's renders. */
export async function serveCacheDir(): Promise<string | null> {
  if (!isTauri()) return "mock://serve";
  return call<string>("serve_cache_dir");
}

/** The binary's build identity (version, build number, commit), for
 * About and anywhere a bug report needs to say which build this is. */
/** Whether HEELER_DEBUG turned the debug tier on at launch, so the
 * frontend's own debug lines (every command's timing) flow from the
 * first call rather than from the console's switch. */
export async function debugAtLaunch(): Promise<boolean> {
  if (!isTauri()) return false;
  return call<boolean>("debug_at_launch").catch(() => false);
}

export async function buildInfo(): Promise<string> {
  if (!isTauri()) return "dev build";
  return call<string>("build_info");
}

/** Where the maximize button is, for the Windows Snap Layouts overlay
 * (snaplayouts.ts): physical pixels of the window's client area. All
 * zeros hides the overlay. A no-op everywhere but Windows. */
export async function setMaximizeButtonRect(rect: { x: number; y: number; w: number; h: number }): Promise<void> {
  if (!isTauri()) return;
  await call<void>("set_maximize_button_rect", rect);
}

export async function serveStart(
  name: string,
  items: ServeItem[],
  dir: string,
  /** simple sharing: the advertised link is bare ip:port, no token */
  simple = false,
): Promise<ServeStatus | null> {
  if (!isTauri()) {
    mockServe = {
      name,
      url: simple ? "http://192.168.0.10:8080/" : "http://192.168.0.10:8080/t/mocktoken/",
      count: items.length,
    };
    return mockServe;
  }
  return call<ServeStatus>("serve_start", { name, items, dir, simple });
}

export async function serveStop(): Promise<void> {
  if (!isTauri()) {
    mockServe = null;
    return;
  }
  await call("serve_stop");
}

export async function serveStatus(): Promise<ServeStatus | null> {
  if (!isTauri()) return mockServe;
  return call<ServeStatus | null>("serve_status");
}

/** Mirrors the Rust side's file naming for the serve directory. WebP
 * since the live-share work: half the bytes over the wifi an iPad is
 * actually on. */
export function serveFileName(id: string): string {
  return `${id.replace(/[^A-Za-z0-9_-]/g, "_")}.webp`;
}

/** One dab of the current brush, rendered by the engine.
 *
 * Coverage bytes rather than an encoded image: the webview drops them
 * straight into an ImageData. Rendered engine-side on purpose, so the
 * preview and the paint cannot disagree.
 *
 * Null outside Tauri; the caller falls back to an outline, which is what
 * the browser build had before.
 */
export async function brushTipPreview(
  tip: string,
  size: number,
  hardness: number,
  textureScale: number,
  textureDepth: number,
  textureAngle = 0,
): Promise<Uint8Array | null> {
  if (!isTauri()) return null;
  const bytes = (await call("brush_tip_preview", {
    tip,
    size,
    hardness,
    textureScale,
    textureDepth,
    textureAngle,
  })) as ArrayBuffer | number[];
  // Raw bytes from the desktop (an ArrayBuffer); a plain array from the
  // test mocks.
  return bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : new Uint8Array(bytes);
}

/** Archives an image's saved graph and clears its edited mark. Resolves
 * to the archived document (null when there were no saved edits),
 * which Undo writes back. */
export async function resetImageEdits(imageId: string): Promise<string | null> {
  if (!isTauri()) return null;
  const revision = nextSaveRevision(imageId);
  const archived = (await call("reset_image_edits", { imageId, revision })) as string | null | undefined;
  autosaves.acknowledge(imageId, revision);
  return typeof archived === "string" ? archived : null;
}

/** Shows a folder in the system file browser. */
/** The merge kinds offered in the Photo menu. The mode strings match the
 * engine's StackMode, so the menu and the merge cannot drift. */
export const STACK_KINDS: { mode: string; label: string; hint: string; progressLabel: string }[] = [
  { mode: "hdr", progressLabel: "HDR", label: "Merge to HDR…", hint: "Combine bracketed frames into one high range image" },
  { mode: "mean", progressLabel: "mean", label: "Merge to Long Exposure…", hint: "Average the frames: smooth motion, less noise" },
  { mode: "median", progressLabel: "median", label: "Merge to Median…", hint: "Delete anything that moved between frames" },
  { mode: "max", progressLabel: "maximum", label: "Merge to Light Trails…", hint: "Keep the brightest sample: trails, fireworks, stars" },
  // "I use that for bird murmurations and I imagine there
  // could be other uses" - the dark twin of max.
  { mode: "min", progressLabel: "minimum", label: "Merge to Dark Trails…", hint: "Keep the darkest sample: birds against sky, shadows in motion" },
];

/** Builds a stack from the given images. Returns the new library entry,
 * or null in the browser build where there are no real files to merge. */
export async function createStack(imageIds: string[], mode: string): Promise<ImageEntry | null> {
  if (!isTauri()) return null;
  const made = await call<FolderImage>(
    "create_stack",
    { imageIds, mode }
  );
  return entryFromRow(made);
}

export interface StackInfo {
  mode: string;
  align: boolean;
  /** HDR only: how hard the merged range is pulled back into view */
  members: string[];
  /** members the folder no longer has: the merge silently runs without
   * them, so the panel has to say so */
  missing: string[];
  /** members that are finished pictures (JPEG, TIFF, PNG and the like),
   * not RAW or EXR: an HDR merge of them is approximate, since the
   * camera's tone curve is still in them. Absent from an older backend. */
  rendered?: string[];
}

/** What a stack is made of, or null for an ordinary photograph. */
export async function stackInfo(imageId: string): Promise<StackInfo | null> {
  if (!isTauri()) return null;
  return call<StackInfo | null>("stack_info", { imageId });
}

/** Appends frames to a stack through the native picker, which opens in
 * the stack's own folder. Null means the dialog was canceled (or the
 * browser build, where there is no picker); rejected picks are named
 * in the console by the backend. */
export async function stackAddFrames(imageId: string): Promise<StackInfo | null> {
  if (!isTauri()) return null;
  return call<StackInfo | null>("stack_add_frames", { imageId });
}

/** Appends already-open frames to a stack by id: the ribbon's "Add to
 * Stack" door. Rejects (wrong folder, recipes, doubles) are named in
 * the console by the backend; survivors join. */
export async function stackAppend(stackId: string, frameIds: string[]): Promise<StackInfo | null> {
  if (!isTauri()) return null;
  const result = await call<StackInfo>("stack_append", { stackId, frameIds });
  changedDenoiseCache(true);
  return result;
}

/** Rewrites the recipe: the merge is not baked, so this is a file write
 * and a re-render rather than redoing the job. */
export async function updateStack(
  imageId: string,
  change: { mode?: string; align?: boolean; members?: string[] }
): Promise<StackInfo | null> {
  if (!isTauri()) return null;
  const result = await call<StackInfo>("update_stack", { imageId, ...change });
  changedDenoiseCache(true);
  return result;
}

/** Builds a panorama from the given images. Returns the new library
 * entry, or null in the browser build where there are no real files. */
export async function createPano(imageIds: string[]): Promise<ImageEntry | null> {
  if (!isTauri()) return null;
  const made = await call<FolderImage>(
    "create_pano",
    { imageIds }
  );
  return entryFromRow(made);
}

/** DNG keeps scene-linear headroom; TIFF and JPEG encode for display. */
export const BAKE_FORMATS: { id: string; label: string; hint: string }[] = [
  {
    id: "dng",
    label: "DNG",
    hint: "Keeps highlights past white and opens with fresh controls",
  },
  { id: "tiff", label: "TIFF", hint: "16-bit, no compression loss, but clipped at white" },
  { id: "jpg", label: "JPEG", hint: "Small, 8-bit, clipped at white: for sending on" },
];

/** Freezes current edits into a new file beside the source.
 * Returns null in the browser build, where no source file is available. */
export async function bakeComposite(
  imageId: string,
  format: string,
  graph: { nodes: unknown[]; wires: unknown[] },
  quality = 92,
  source?: RenderedSource,
  catchup = false,
): Promise<ImageEntry | null> {
  if (!isTauri()) return null;
  const made = await call<FolderImage>("bake_composite", { imageId, format, quality, graph: serializeLoadedGraph(imageId, graph, source, catchup) });
  return entryFromRow(made);
}

/** Everything known about one photograph.
 *
 * "Some metadata is from the workspace; rating, status,
 * etc. Other columns are common camera data." Both halves in one
 * record, because a row of the column view needs both and asking twice
 * per photograph would double the round trips for nothing.
 */
export interface ImageMeta {
  baked_from?: string | null;
  id: string;
  name: string;
  path: string;
  size: number;
  /** seconds since the epoch, 0 when the file is gone */
  modified: number;
  width?: number | null;
  height?: number | null;
  stars: number;
  flag: string;
  edited: boolean;
  camera?: string | null;
  lens?: string | null;
  shot_at?: string | null;
  iso?: number | null;
  aperture?: string | null;
  shutter?: string | null;
  focal?: string | null;
  exposure_bias?: string | null;
  artist?: string | null;
  copyright?: string | null;
  sidecar: boolean;
}

/** In the browser build there is no file to read, so the panel shows the
 * workspace's half and says the rest is unavailable rather than
 * inventing an ISO. */
/** Mock shot dates for the browser build's metadata, by image id, as
 * EXIF writes them ("2025:08:23 13:39:13"); an id set to null is a file
 * that carries no date, an id not set at all is the same. */
const mockShotAt = new Map<string, string | null>();

export function mockSetShotAt(imageId: string, shotAt: string | null): void {
  mockShotAt.set(imageId, shotAt);
}

/** Test hook: the dates forgotten between tests. */
export function mockResetShotAt(): void {
  mockShotAt.clear();
}

function mockMeta(state: State, id: string): ImageMeta | null {
  const img = state.images.find((i) => i.id === id);
  if (!img) return null;
  return {
    id: img.id,
    name: img.name,
    path: img.name,
    size: 0,
    modified: 0,
    stars: img.stars,
    flag: img.flag,
    edited: img.edited,
    sidecar: false,
    shot_at: mockShotAt.get(id) ?? null,
  };
}

export async function imageMetadata(state: State, id: string): Promise<ImageMeta | null> {
  if (!isTauri()) return mockMeta(state, id);
  return call<ImageMeta | null>("image_metadata", { imageId: id });
}

/** One line of the full listing: its group, its name, its value. */
export interface MetaLine {
  group: string;
  name: string;
  value: string;
}

/** Everything the file says about itself, named and grouped
 * (2026-09-23: "it should show the user whatever it finds"). Empty
 * in the browser build, where there is no file to read.*/
export async function imageMetadataAll(id: string): Promise<MetaLine[]> {
  if (!isTauri()) return [];
  return call<MetaLine[]>("image_metadata_all", { imageId: id });
}

/** The same for a list, for the column view. */
export async function folderMetadata(state: State, ids: string[]): Promise<ImageMeta[]> {
  if (!isTauri()) {
    return ids.map((id) => mockMeta(state, id)).filter((m): m is ImageMeta => !!m);
  }
  return call<ImageMeta[]>("folder_metadata", { imageIds: ids });
}

/** Writes the takes, their notes and their stars out beside the photograph.
 *
 * Returns the sidecar's path, or null in the browser build. Throws when
 * the sidecar belongs to another application, which the caller surfaces
 * rather than swallowing: silently not writing is worse than saying no.
 */
export async function writeImageMetadata(
  id: string,
  activeTake: string,
  takes: [string, string, string, number][],
): Promise<string | null> {
  if (!isTauri()) return null;
  return call<string>("write_image_metadata", { imageId: id, activeTake, takes });
}

export interface PanoInfo {
  /** auto | cylindrical | spherical | planar */
  surface: string;
  gain_compensation: boolean;
  straighten: boolean;
  bands: number;
  members: string[];
  /** members the folder no longer has */
  missing: string[];
}

/** What a panorama is made of, or null for an ordinary photograph. */
export async function panoInfo(imageId: string): Promise<PanoInfo | null> {
  if (!isTauri()) return null;
  return call<PanoInfo | null>("pano_info", { imageId });
}

/** Rewrites the recipe. Like a stack, the stitch is not baked, so
 * changing the surface is a file write and a re-render. */
export async function updatePano(
  imageId: string,
  change: {
    surface?: string;
    gain_compensation?: boolean;
    straighten?: boolean;
    bands?: number;
    members?: string[];
  }
): Promise<PanoInfo | null> {
  if (!isTauri()) return null;
  const result = await call<PanoInfo>("update_pano", { imageId, ...change });
  changedDenoiseCache(true);
  return result;
}

export interface StitchProgress {
  image_id: string;
  /** 0 to 1 */
  fraction: number;
  stage: string;
  /** set once the job is over either way, so the dialog always closes */
  done: boolean;
  error: string | null;
  /** the panorama's frames, whether this is the full-size stitch, and
   * how long it has run; absent from an older backend */
  frames?: number;
  full?: boolean;
  elapsed_ms?: number;
  /** the job Cancel stitch names, and on the final report whether it
   * ended canceled rather than failed */
  job_id?: string;
  canceled?: boolean;
}

/** The channel the backend reports stitch progress on. Spelled out on
 * both sides; the Rust test checks they still agree. */
export const STITCH_CHANNEL = "heeler:progress";

/** Subscribes to stitch progress. Returns an unsubscribe function, and a
 * no-op one in the browser build where nothing stitches. */
export function onStitchProgress(fn: (p: StitchProgress) => void): () => void {
  if (!isTauri()) return () => {};
  // Through the event hub (taurievents.ts): leaving while the operation
  // still reports cannot strand a Rust callback.
  return onOpProgress(p => { if (p.op === "stitch" && p.detail) fn(p.detail as StitchProgress); });
}

/** How far a stack merge the viewer is waiting on has got. Mirrors
 * StackProgress in lib.rs.*/
export interface StackProgress {
  set_aside?: boolean;
  /** set on the finished event of a merge the user canceled: the
   * backend will not start that stack again until resumeStackMerge */
  canceled?: boolean;
  job_id?: string;
  image_id: string;
  /** frames folded in so far, across every pass */
  done: number;
  /** frames times passes */
  total: number;
  pass: number;
  passes: number;
  /** the stack's member count */
  frames: number;
  /** members that would not decode, so far */
  missing: number;
  mode: string;
  /** full resolution (the 1:1 view) rather than the preview */
  full: boolean;
  elapsed_ms: number;
  /** set once the merge is over, whichever way */
  finished: boolean;
  error: string | null;
}

/** STACK_EVENT in lib.rs. */
export const STACK_CHANNEL = "heeler:progress";

/** How a merge the backend stopped on purpose (the viewer moved on, or
 * the frames changed) begins its error: STACK_SET_ASIDE in lib.rs. */
export const STACK_SET_ASIDE = "Stack merge set aside";

/** Subscribes to stack merge progress; a no-op in the browser build,
 * which merges nothing. */
export function onStackProgress(fn: (p: StackProgress) => void): () => void {
  if (!isTauri()) return () => {};
  return onOpProgress(p => { if (p.op === "stack" && p.detail) fn(p.detail as StackProgress); });
}

/** The one progress channel for the long operations (Phase 6 of the
 * main-thread stalls plan): every operation reports {op, id, done,
 * total, message} here, and the cancel registry on the Rust side is
 * keyed by the same id. One progress row in the UI renders these;
 * image jobs carry detail through the adapters above so their canvas
 * and dialog keep the same presentation. */
export interface OpProgress {
  detail?: unknown;
  op: string;
  id: string;
  done: number;
  total: number;
  message: string;
}

export const PROGRESS_EVENT = "heeler:progress";

const opListeners: ((p: OpProgress) => void)[] = [];
/** Ids the Cancel button sent, in the browser build; a test reads them. */
export const mockCancels: string[] = [];
/** The browser build's ledger of resumeStackMerge calls, for tests. */
export const mockResumes: string[] = [];

/** Subscribes to operation progress. Returns an unsubscribe function. */
export function onOpProgress(fn: (p: OpProgress) => void): () => void {
  if (!isTauri()) {
    opListeners.push(fn);
    return () => {
      const i = opListeners.indexOf(fn);
      if (i >= 0) opListeners.splice(i, 1);
    };
  }
  // Through the event hub (taurievents.ts): leaving while the operation
  // still reports cannot strand a Rust callback.
  return onTauriEvent<OpProgress>(PROGRESS_EVENT, fn);
}

/** Feeds a progress event to browser-build listeners, for tests. */
export function mockEmitProgress(p: OpProgress): void {
  for (const fn of [...opListeners]) fn(p);
}

/** The Cancel button: marks the operation's id canceled; the worker
 * notices between units. */
export async function cancelOperation(id: string): Promise<void> {
  if (!isTauri()) {
    mockCancels.push(id);
    return;
  }
  await call("cancel_operation", { id });
}

/** Merge again after Cancel merge: the backend refuses to start a
 * canceled stack (so a retry, a thumbnail or an edit cannot quietly
 * start it over) until this is called, or its recipe changes. */
export async function resumeStackMerge(imageId: string): Promise<void> {
  if (!isTauri()) {
    mockResumes.push(imageId);
    return;
  }
  await call("resume_stack_merge", { imageId });
}

/** What a canceled stitch answers (lib.rs PANO_CANCELED). */
export const PANO_CANCELED = "Stitch canceled";

/** Stitch again after Cancel stitch: the backend refuses to stitch a
 * canceled panorama (so a retry, a thumbnail or an edit cannot quietly
 * start it over) until this is called, or its recipe changes. */
export async function resumePanoStitch(imageId: string): Promise<void> {
  if (!isTauri()) {
    mockResumes.push(imageId);
    return;
  }
  await call("resume_pano_stitch", { imageId });
}

/** Clears the browser-build progress listeners and cancel ledger. */
export function mockResetOps(): void {
  opListeners.length = 0;
  mockCancels.length = 0;
  mockResumes.length = 0;
}

/** Renders one image to an explicit path. Null in the browser build,
 * where there is nothing to write. */
/** Mock export ledger: what would have been written, and the folder the
 * mock picker answers with, so export flows are testable headless. */
const mockExports: { imageId: string; dest: string; format: string; dpi: number }[] = [];
let mockExportFolder: string | null = null;

export function mockSetExportFolder(path: string | null): void {
  mockExportFolder = path;
}

export function mockExportedLog(): { imageId: string; dest: string; format: string; dpi: number }[] {
  return mockExports;
}

/** Test hook: the ledger emptied, the picker answering nothing. */
export function mockResetExports(): void {
  mockExports.length = 0;
  mockExportFolder = null;
}

export async function exportTo(
  graph: unknown,
  imageId: string,
  dest: string,
  settings: {
    format: string;
    quality: number;
    maxEdge: number | null;
    keepMetadata?: boolean;
    matte?: boolean;
    dpi?: number;
  }
): Promise<string | null> {
  if (!isTauri()) {
    mockExports.push({ imageId, dest, format: settings.format, dpi: exportDpi(settings.dpi) });
    return dest;
  }
  return call<string>("export_to", {
    graph,
    imageId,
    dest,
    format: settings.format,
    quality: settings.quality,
    maxEdge: settings.maxEdge,
    keepMetadata: settings.keepMetadata ?? true,
    matte: settings.matte ?? false,
    dpi: exportDpi(settings.dpi),
  });
}

/** Re-renders an image's thumbnail through its own graph, so the ribbon
 * shows what the photo looks like now rather than what came off the
 * card. Null in the browser build. */
export async function renderThumbnail(state: State, imageId: string): Promise<string | null> {
  if (!isTauri()) return null;
  return call<string>("render_thumbnail", {
    graph: serializeGraph(state),
    imageId,
    edge: state.prefs.thumbnailEdge ?? 480,
  });
}

/** A quad-edit pane: one photo rendered through a given graph at pane
 * size. Pass a state whose nodes/wires are the MEMBER's graph; the mock
 * returns null and the pane falls back to the demo photo. */
export async function renderPane(
  state: State,
  imageId: string,
  maxEdge: number
): Promise<string | null> {
  if (!isTauri()) return null;
  return call<string>("render_pane", { graph: serializeGraph(state), imageId, maxEdge });
}

/** Asks for a destination folder, once per batch. */
/** Live shares: mock records the calls so the debounce and gating are
 * testable without a server. */
export const mockServeUpdates: { imageId: string; makeLive: boolean }[] = [];

export async function serveUpdate(
  graph: unknown,
  imageId: string,
  makeLive: boolean
): Promise<boolean> {
  if (!isTauri()) {
    mockServeUpdates.push({ imageId, makeLive });
    return true;
  }
  return call<boolean>("serve_update", { graph, imageId, makeLive });
}

export async function writeGallery(
  dir: string,
  name: string,
  items: { id: string; name: string }[]
): Promise<void> {
  if (!isTauri()) return;
  await call("write_gallery", { dir, name, items });
}

// --- Smart selection ---

export type SmartModelStatus = {
  id: string;
  installed: boolean;
  label: string;
  license: string;
  url: string;
  bytes: number;
  /** the registry's version of the pinned weights, as people read it */
  version: string;
};

/** Both models: SAM is the backbone, BiRefNet the optional matte
 * upgrade for the subject one-shot. */
export type SmartModels = {
  sam: SmartModelStatus;
  matte: SmartModelStatus;
  /** the inpainting model behind Remove and the Finish fill */
  fill: SmartModelStatus;
  /** ViTMatte, the P4 Selection Polish refinement */
  refine: SmartModelStatus;
  depth: SmartModelStatus;
  /** SCUNet, Noise Reduction's Model method */
  denoise: SmartModelStatus;
  /** Florence-2, what is in the picture, for the assistant */
  florence: SmartModelStatus;
};

/** The browser build's models: the registry as the desktop reports
 * it, none installed, so Preferences shows the same table. */
function mockSmartModels(): SmartModels {
  const m = (id: string, label: string, bytes: number, license: string, url: string, version: string): SmartModelStatus => ({
    id, installed: false, label, bytes, license, url, version,
  });
  return {
    sam: m("mobile_sam", "Segment Anything (MobileSAM)", 36_655_105, "Apache-2.0", "https://huggingface.co/vietanhdev/segment-anything-onnx-models", "2023.06"),
    matte: m("birefnet_lite", "BiRefNet Lite (subject matte)", 224_005_088, "MIT", "https://huggingface.co/onnx-community/BiRefNet_lite-ONNX", "2024.09"),
    fill: m("lama", "LaMa (inpainting)", 208_044_816, "Apache-2.0", "https://huggingface.co/Carve/LaMa-ONNX", "2024.03"),
    refine: m("vitmatte", "ViTMatte (edge refinement)", 103_885_865, "Apache-2.0 weights, MIT code", "https://huggingface.co/Xenova/vitmatte-small-composition-1k", "2024.06"),
    depth: m("depth_anything_v2_small", "Depth Anything V2 Small (scene depth)", 99_060_839, "Apache-2.0", "https://huggingface.co/onnx-community/depth-anything-v2-small", "2024.06"),
    denoise: m("scunet_color_real_psnr", "SCUNet (noise reduction)", 76_936_854, "Apache-2.0", "https://huggingface.co/Heliosoph/scunet-onnx", "2026.06"),
    florence: m("florence_2_base", "Florence-2 base (what is in the picture)", 970_082_648, "MIT", "https://huggingface.co/onnx-community/Florence-2-base", "2025.05"),
  };
}

export async function smartModelStatus(): Promise<SmartModels | null> {
  if (!isTauri()) return mockSmartModels();
  return await call("smart_model_status");
}

/** Opens the downloaded-models folder in the system file browser: the
 * backup door, and the honest answer to "where is my disk going". */
export async function revealModels(): Promise<void> {
  if (!isTauri()) return;
  await call("reveal_models");
}

/** The caches on disk, for the Storage preferences: thumbnails inside
 * the catalog, proxies and smart rasters as files. Null in the browser
 * mock. */
export interface StorageInfo {
  thumbnails: number;
  thumbnail_bytes: number;
  catalog_path: string;
  proxies: number;
  proxy_bytes: number;
  proxies_path: string;
  rasters: number;
  raster_bytes: number;
  rasters_path: string;
}

export async function storageInfo(): Promise<StorageInfo | null> {
  if (!isTauri()) return null;
  return (await call("storage_info")) as StorageInfo;
}

/** Each clear answers with how many entries it dropped; the caches
 * rebuild as the user works. */
export async function clearThumbnails(): Promise<number> {
  if (!isTauri()) return 0;
  return (await call("clear_thumbnails")) as number;
}

export async function clearProxies(): Promise<number> {
  if (!isTauri()) return 0;
  return (await call("clear_proxies")) as number;
}

export async function clearSmartRasters(): Promise<number> {
  if (!isTauri()) return 0;
  const count = await call<number>("clear_smart_rasters");
  changedDenoiseCache(true);
  return count;
}

export async function revealProxies(): Promise<void> {
  if (!isTauri()) return;
  await call("reveal_proxies");
}

export async function revealSmartRasters(): Promise<void> {
  if (!isTauri()) return;
  await call("reveal_smart_rasters");
}

let modelChangeEpoch = 0;
const modelChangeListeners = new Set<() => void>();
export const modelsEpoch = () => modelChangeEpoch;
export function onModelsChanged(fn: () => void): () => void {
  modelChangeListeners.add(fn);
  return () => { modelChangeListeners.delete(fn); };
}
function modelsChanged() {
  modelChangeEpoch++;
  for (const fn of modelChangeListeners) fn();
}

/** The consented download: call ONLY from a dialog that has already
 * named the model, its license, its size, and its source. */
export async function smartModelDownload(model = "mobile_sam"): Promise<void> {
  if (isTauri()) await call("smart_model_download", { model });
  modelsChanged();
}

/** Remove a downloaded model from disk (or both when unnamed); the
 * loaded sessions drop with it. */
export async function smartModelRemove(model?: string): Promise<void> {
  if (isTauri()) await call("smart_model_remove", { model: model ?? null });
  modelsChanged();
}

/** What Florence-2 is asked: a one-sentence caption, a few
 * sentences, the objects it knows with boxes, or where a phrase is.*/
export type FlorenceTask =
  | { task: "caption" }
  | { task: "detailed_caption" }
  | { task: "objects" }
  | { task: "grounding"; phrase: string };

/** A labeled box, fractions of the photograph's width and height: x0,
 * y0 top left, x1, y1 bottom right. */
export interface FlorenceRegion {
  label: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface FlorenceAnswer {
  /** the caption, or for boxes the labels in order, comma separated */
  text: string;
  /** boxes for objects and grounding; empty for the captions */
  regions: FlorenceRegion[];
  /** generation stopped at the task's bound, not the model's own end */
  truncated: boolean;
}

/** The desktop's refusal when Florence-2 is not installed (lib.rs,
 * FLORENCE_NOT_INSTALLED), word for word: the assistant tells "not
 * installed" from any other failure by it. */
export const FLORENCE_NOT_INSTALLED =
  "Florence-2 is not installed. Download it in Preferences, Assistant (or Preferences, Models); it runs on this computer and nothing is sent anywhere.";

/** Reads a frame URL (the viewer's Blob URL, the one the Spectrums
 * sample) as base64 of its encoded bytes. */
async function frameBase64(frameUrl: string): Promise<string> {
  const bytes = new Uint8Array(await (await fetch(frameUrl)).arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/** Florence-2 on the frame the viewer shows: pass the same frame URL
 * the Spectrums read (the app's previewUrl), never a new render. One
 * answer per task, in order. Free; runs on this computer. Rejects with
 * the desktop's words when the model is not installed ("Florence-2 is
 * not installed. Download it in Preferences, Assistant ...") and with
 * "Canceled." after florenceCancel. The browser build has no model and
 * rejects with the same refusal. */
export async function florenceDescribe(frameUrl: string, tasks: FlorenceTask[]): Promise<FlorenceAnswer[]> {
  if (!isTauri()) throw new Error(FLORENCE_NOT_INSTALLED);
  const frame = await frameBase64(frameUrl);
  return await call<FlorenceAnswer[]>("florence_describe", { frame, tasks });
}

/** Stops a Florence-2 run between its steps. */
export async function florenceCancel(): Promise<void> {
  if (isTauri()) await call("florence_cancel");
}

export interface ModelsLocation {
  /** the folder the model files live in right now */
  current: string;
  /** the built-in home under the app data dir */
  default: string;
  /** the vision bases those folders hang off, for comparing picks */
  currentBase: string;
  defaultBase: string;
  custom: boolean;
}

export async function modelsLocation(): Promise<ModelsLocation | null> {
  if (!isTauri()) return null;
  return call("models_location");
}

export interface ModelsMoveResult {
  moved: string[];
  bytes: number;
  from: string;
  to: string;
}

/** Copies the downloaded models to the target and only then removes the
 * old copies; a partway failure leaves both copies and says so. */
export async function modelsMove(target: string): Promise<ModelsMoveResult | null> {
  if (!isTauri()) return null;
  const result = await call<ModelsMoveResult>("models_move", { target });
  modelsChanged();
  return result;
}

/** Whether the raster for exactly this recipe exists on this machine
 * (session or disk): the badge's question. True in the browser mock so
 * no badge nags where nothing can compute anyway. */
export async function smartRasterStatus(
  imageId: string,
  nodeId: string,
  mode: string,
  prompts: string,
  model = "",
  aim = "",
): Promise<boolean> {
  if (!isTauri()) return true;
  return await call("smart_raster_status", { imageId, nodeId, mode, prompts, model, aim });
}

/** Compute (or refine) a smart mask's raster for a node from its
 * prompts JSON. Resolves with the id of the model that produced the
 * raster; writing that id into the node's `model` param is both
 * provenance and the render trigger. `aim` is Subject's ask for the
 * SAM fallback (smartpoints.ts subjectAim), on the photograph like the
 * clicks. */
export async function smartClick(
  imageId: string,
  nodeId: string,
  prompts: string,
  mode = "click",
  aim = "",
): Promise<string> {
  if (!isTauri()) return "mobile_sam";
  return await call("smart_click", { imageId, nodeId, mode, prompts, aim });
}

/** Smart selection straight onto the document selection (Select >
 * Selection Tools > Click / Subject / Sky): same compute as
 * smartClick, but resolves with the raster's version hex, which the
 * caller writes as the selection's baked base (matte_id
 * "baked:<hex>") so drawn regions keep composing on top. */
export async function smartSelect(
  imageId: string,
  nodeId: string,
  mode: string,
  prompts: string,
  aim = "",
): Promise<string> {
  if (!isTauri()) return "beefbeefbeefbeef";
  return await call("smart_select", { imageId, nodeId, mode, prompts, aim });
}

/** One matte refinement of a Smart mask's raster: ViTMatte re-reads
 * the segmentation edge against the photograph (the owner's
 * sky-on-the- mountains case). Resolves with the model id to write
 * into the node ("<base>+vitmatte"): provenance, cache key, and
 * render trigger.*/
export async function smartMatte(
  imageId: string,
  nodeId: string,
  mode: string,
  prompts: string,
  model: string,
  aim = "",
): Promise<string> {
  if (!isTauri()) return "mock+vitmatte";
  return await call("smart_matte", { imageId, nodeId, mode, prompts, model, aim });
}

/** Renders a mask node and persists the result as a baked raster;
 * resolves with the version hex a converted selection mask points at.
 * The first half of "polish any mask": bake, convert, edit. */
export async function bakeMaskRaster(state: State, nodeId: string): Promise<string> {
  // A full-resolution pass still due on this selection: the bake waits
  // for it and is made from what it lands, at the photograph's size
  // (fullpass.ts; 2026-09-29: "go with option B for To Mask").
  await awaitFullPass(state.activeImage, nodeId);
  if (!isTauri()) return "beefbeefbeefbeef";
  return await call("bake_mask_raster", {
    graph: serializeGraph(state),
    imageId: state.activeImage,
    nodeId,
  });
}

/** A selection made into a layer's pixel mask (bake_layer_mask): the
 * selection's coverage rendered once and kept, on its own ("replace"),
 * or added to or taken out of what `maskId` shows now. Resolves with the
 * version hex the mask `wearer` will point at. Made at the photograph's
 * size when the selection or the mask has drawn geometry or a
 * full-resolution twin. */
export async function bakeLayerMask(
  state: State,
  selectionId: string,
  wearer: string,
  maskId?: string,
  op: "replace" | "add" | "subtract" = "replace",
): Promise<string> {
  await awaitFullPass(state.activeImage, selectionId);
  if (!isTauri()) return "beefbeefbeefbeef";
  return await call("bake_layer_mask", {
    graph: serializeGraph(state),
    imageId: state.activeImage,
    selectionId,
    maskId: maskId ?? null,
    op,
    wearer,
  });
}

/** What the desktop answers for New Layer via Copy (bake_layer_copy):
 * the kept picture, the rectangle of the frame it was cut from in
 * fractions, and that frame's shape. */
export interface LayerCopy {
  path: string;
  box: [number, number, number, number];
  aspect: number;
  width: number;
  height: number;
  /** the kept file's size on disk, after the write: what each recovery
   * bundle carries while Keep baked pictures in backups is on */
  bytes: number;
}

/** New Layer via Copy's pixels (2026-09-30): `source` inside the
 * selection, at the photograph's size, kept as a picture the new image
 * layer reads. `graphState` is the state whose graph is rendered (the
 * caller's, or with a Finish stack made for a To Display to copy
 * from); `carrier` is the copied layer's blend, which lays its picture
 * on the frame.*/
export async function bakeLayerCopy(
  graphState: State,
  selectionId: string,
  source: string,
  carrier: string | null,
): Promise<LayerCopy> {
  await awaitFullPass(graphState.activeImage, selectionId);
  if (!isTauri()) return { path: "/mock/layercopies/beefbeefbeefbeef.tif", box: [0.25, 0.25, 0.5, 0.5], aspect: 1.5, width: 2, height: 2, bytes: 4096 };
  return await call("bake_layer_copy", {
    graph: serializeGraph(graphState),
    imageId: graphState.activeImage,
    selectionId,
    sourceId: source,
    carrierId: carrier,
  });
}

/** Bake Warp's pixels (2026-09-30): what the Warp layer `carrier`
 * shows now, at the photograph's size, kept as a picture the image
 * layer that replaces it reads; answered as Layer via Copy's are.*/
export async function bakeWarpLayer(graphState: State, carrier: string): Promise<LayerCopy> {
  if (!isTauri()) return { path: "/mock/layercopies/feedfeedfeedfeed.tif", box: [0, 0, 1, 1], aspect: 1.5, width: 2, height: 2, bytes: 4096 };
  return await call("bake_warp_layer", {
    graph: serializeGraph(graphState),
    imageId: graphState.activeImage,
    carrierId: carrier,
  });
}

/** One fill of an Inpaint node's hole: resolves with the fill_id to
 * write into the node, which is the recipe pointer and the render
 * trigger.*/
export async function inpaintFill(
  state: State,
  nodeId: string,
  maskNode?: string,
): Promise<string> {
  if (!isTauri()) return "mock-fill";
  return await call("inpaint_fill", {
    graph: serializeGraph(state),
    imageId: state.activeImage,
    nodeId,
    maskNode: maskNode ?? null,
  });
}

/** The matte recipe's prompt half: regions and strokes exactly as
 * the engine graph will carry them, so status checks hash the same
 * string the desktop does (off regions stay home; ALL strokes ride,
 * because the desktop keys the raster on the raw strokes param). */
export function matteRecipeOf(node: {
  regions?: { off?: boolean }[];
  strokes?: unknown[];
  params?: Record<string, number>;
  textParams?: Record<string, string>;
}): string {
  const regions = JSON.stringify((node.regions ?? []).filter((r) => !r.off));
  // The desktop's matte_prompt, rule for rule, so a dial move re-reads
  // the edge exactly when the desktop would plant a different raster.
  // Reach is the brush's: in the recipe only with a matte stroke on
  // the node, since the one-shot never chases (review R3). Contrast is
  // the engine's, live, except on a baked base, where it is applied at
  // the bake and so is part of that recipe (review R2).
  let recipe = `${regions}|${JSON.stringify(node.strokes ?? [])}`;
  if (hasMatteStrokes(node.strokes)) {
    recipe += `|reach${Math.round(Math.min(100, Math.max(0, node.params?.matte_reach ?? 50)))}`;
  }
  if ((node.textParams?.matte_id ?? "").startsWith("baked:")) {
    recipe += `|contrast${Math.round(Math.min(100, Math.max(0, node.params?.matte_contrast ?? 25)))}`;
  }
  return recipe;
}

/** Whether a stroke list holds a matte stroke: any mode the engine does
 * not apply itself (foreground, background and feather are its own). */
export function hasMatteStrokes(strokes: unknown[] | undefined): boolean {
  return (strokes ?? []).some((s) => {
    const k = s as { mode?: string; points?: unknown[] };
    return !["foreground", "background", "feather"].includes(k.mode ?? "") && (k.points?.length ?? 0) > 0;
  });
}

/** The farness under one normalized point of the frame, 0 near 1
 * far: the Depth of Field focus picker's one question. */
export async function depthAt(state: State, x: number, y: number): Promise<number> {
  if (!isTauri()) return 0.5;
  // The graph rides along because the plane is keyed by the Depth Map
  // section's recipe as well as the photograph.
  return await call("depth_at", { graph: serializeGraph(state), imageId: state.activeImage, x, y });
}

/** The preset library's listing: built-ins from inside the binary,
 * user presets from the presets folder's real directory tree. */
export interface PresetEntry {
  category: string;
  name: string;
  path: string;
  builtin: boolean;
}

export async function presetList(): Promise<PresetEntry[]> {
  if (!isTauri()) return [];
  return await call("preset_list");
}

/** One patch of a chart as the desktop reports it: the published color
 * sRGB-encoded for display, so the overlay can tint a swatch without
 * carrying the color science. `target` is false for a control with no
 * published value (a custom chart's untargeted cell): the overlay draws
 * it hollow and the fit ignores it. */
export interface PatchDef {
  name: string;
  rgb: [number, number, number];
  target: boolean;
}

/** A Color Checker chart as the desktop's chart_defs answers it:
 * grid dimensions, patch list in row-major order, and the indices the
 * fit leans on. Built-ins plus the user's custom charts, one list. */
export interface ChartDef {
  id: string;
  name: string;
  rows: number;
  cols: number;
  neutrals: number[];
  skin: number[];
  patches: PatchDef[];
}

export async function chartDefs(): Promise<ChartDef[]> {
  if (!isTauri()) return [];
  return await call("chart_defs");
}

/** One entry of the custom-chart editor's target palette: a named
 * color with its Lab D50 value (the chart file's space) and an
 * sRGB-encoded display color, both computed by the engine. `neutral`
 * marks the grays the white balance fit leans on. */
export interface PaletteTarget {
  key: string;
  name: string;
  lab: [number, number, number];
  rgb: [number, number, number];
  neutral: boolean;
  /** the chart the entry came from, for the editor's grouping */
  chart: string;
}

export async function chartPalette(): Promise<PaletteTarget[]> {
  if (!isTauri()) return [];
  return await call("chart_palette");
}

/** Save a custom chart: the desktop validates the JSON with the engine's
 * own parser and writes it into the charts folder of the presets base.
 * Answers the saved chart's def so the cache can take it directly. */
export async function chartSave(json: string): Promise<ChartDef> {
  if (!isTauri()) throw new Error("no chart store in the browser");
  return await call("chart_save", { json });
}

export async function chartImport(): Promise<{ imported: string[]; failed: [string, string][] }> {
  if (!isTauri()) return { imported: [], failed: [] };
  return await call("chart_import");
}

export async function chartExport(id: string, name: string): Promise<string | null> {
  if (!isTauri()) return null;
  return await call("chart_export", { id, name });
}

/** What the fit found, as the desktop's chart_calibrate answers it. The
 * node keeps this whole object as its fit report (plus chart, photo,
 * camera and when, stamped by the frontend). */
export interface FitReport {
  temperature: number;
  tint: number;
  exposure: number;
  matrix: number[];
  matrix_is_identity: boolean;
  wb_in_matrix: boolean;
  residuals: [number, number][];
  mean_de: number;
  illuminant: string;
  flagged: number[];
  fitted: number;
  note: string;
}

/** One row of the panel report: measured and corrected colors
 * sRGB-encoded for display, the residual when fitted, the reason when
 * flagged. */
export interface PatchReport {
  index: number;
  name: string;
  before: [number, number, number];
  after: [number, number, number];
  de: number | null;
  flag: string | null;
}

export interface CalibrationAnswer {
  fit: FitReport;
  patches: PatchReport[];
  camera: string | null;
}

/** Calibrate: the desktop renders the Color Checker node's input at
 * preview size through the executor, samples the chart through the quad,
 * and fits. The node's text params carry the placement. */
export async function chartCalibrate(
  state: State,
  chartId: string,
  quad: [number, number][],
  nudged: Record<number, [number, number]>,
  excluded: number[],
  setWb: boolean,
): Promise<CalibrationAnswer> {
  if (!isTauri()) throw new Error("no chart sampler in the browser");
  return await call("chart_calibrate", {
    graph: serializeGraph(state),
    imageId: state.activeImage,
    chartId,
    quad,
    nudged,
    excluded,
    setWb,
  });
}

/** One preset's vetted, migrated JSON, parsed. */
export async function presetRead(builtin: boolean, path: string): Promise<PresetFile> {
  if (!isTauri()) throw new Error("no preset store in the browser");
  return JSON.parse(await call("preset_read", { builtin, path })) as PresetFile;
}

export async function presetSave(category: string, name: string, preset: PresetFile): Promise<string> {
  if (!isTauri()) return "mock-preset-path";
  return await call("preset_save", { category, name, json: JSON.stringify(preset) });
}

export async function presetTrash(path: string): Promise<void> {
  if (!isTauri()) return;
  await call("preset_trash", { path });
}

export async function presetImport(): Promise<{ imported: string[]; failed: [string, string][] }> {
  if (!isTauri()) return { imported: [], failed: [] };
  return await call("preset_import");
}

export async function presetExport(builtin: boolean, path: string, name: string): Promise<string | null> {
  if (!isTauri()) return null;
  return await call("preset_export", { builtin, path, name });
}

/** Forgets the photograph's cached depth plane at the current recipe,
 * on disk and in the session, so the next ask runs the model again.
 * The Depth Map section's Recompute. */
export async function depthForget(state: State): Promise<void> {
  if (!isTauri()) return;
  await call("depth_forget", { graph: serializeGraph(state), imageId: state.activeImage });
}

/** What a depth read bought: the shared depth version, and whether
 * the wait was the model running, a filter pass over a cached raw
 * answer, or an instant confirm of a plane already on disk. */
export interface DepthMapAnswer {
  version: string;
  /** "file" when the photograph's own depth pass was read instead of
   * the model (an OpenEXR with Z or mist). */
  work: "model" | "refine" | "cached" | "file";
}

/** What the active photograph's file carries beside its pixels (an
 * OpenEXR's depth pass, Cryptomatte layers and matte channels), or
 * null for a plain image. The Depth Map section and the Object Mask
 * picker read the answer. */
export async function filePasses(state: State): Promise<FilePasses | null> {
  if (!isTauri()) return null;
  return await call("file_passes", { imageId: state.activeImage });
}

/** The same report for a file picked from disk that is nobody's
 * photograph yet: "Layers from File..." (26.3 Phase 7 import) lists
 * the file's EXR layer groups and TIFF pages from this before a single
 * layer is made. */
export async function filePassesAt(path: string): Promise<FilePasses | null> {
  if (!isTauri()) return null;
  return await call("file_passes_at", { path });
}

/** A Finish image layer's picture, before it is placed and while it is
 * shown (2026-09-30): its upright size, or why there is none, in words
 * the layer shows ("The file is missing. It was at ..."). */
export interface ImageLayerProbe {
  width: number;
  height: number;
  missing: string | null;
}

/** What the browser build answers: a 3:2 picture, or a missing one for
 * a path that says so. Tests replace it to stand in any answer. */
export let mockImageLayerProbe = (src: { kind: string; path?: string; image?: string }): ImageLayerProbe =>
  src.kind === "file" && !src.path
    ? { width: 0, height: 0, missing: "No file chosen yet." }
    : src.kind === "file" && /missing/i.test(src.path ?? "")
      ? { width: 0, height: 0, missing: `The file is missing. It was at ${src.path}` }
      : { width: 1500, height: 1000, missing: null };

export function mockSetImageLayerProbe(fn: typeof mockImageLayerProbe): void {
  mockImageLayerProbe = fn;
}

export async function imageLayerProbe(
  src: { kind: "file"; path: string; layer?: string } | { kind: "catalog"; image: string },
): Promise<ImageLayerProbe> {
  if (!isTauri()) return mockImageLayerProbe(src);
  return await call<ImageLayerProbe>("image_layer_probe", {
    kind: src.kind,
    path: src.kind === "file" ? src.path : "",
    layer: src.kind === "file" ? (src.layer ?? "") : "",
    image: src.kind === "catalog" ? src.image : "",
  });
}

/** The object under a click on the photograph, by name, from one of
 * the file's Cryptomatte layers; null over the background. x and y
 * in 0..1 of the photograph. */
export async function mattePick(state: State, layer: string, x: number, y: number): Promise<string | null> {
  if (!isTauri()) return null;
  const graph = serializeGraph(state);
  const meta = await imageMetadata(state, state.activeImage);
  if (!meta?.width || !meta.height) throw new Error("The photograph's dimensions are not available for Object picking yet.");
  const point = sourcePoint(graph, [meta.width, meta.height], [x, y]);
  if (!point || point.some((v) => v < 0 || v >= 1)) return null;
  return await call("matte_pick", { imageId: state.activeImage, layer, x: point[0], y: point[1] });
}

/** The depth map's histogram for a layer's Depth levels widget: 64
 * bins of nearness scaled to the tallest, null until the plane at the
 * current recipe exists (the widget asks again). */
export async function depthHistogram(state: State, raw = false): Promise<number[] | null> {
  if (!isTauri()) return null;
  return await call("depth_histogram", { graph: serializeGraph(state), imageId: state.activeImage, raw });
}

// --- Noise Reduction's Model method (SCUNet) ---

export interface DenoiseMapAnswer {
  version: string;
  work: "model" | "cached";
  tiles: number;
  width: number;
  height: number;
}

export interface DenoiseProgress {
  image_id: string;
  done: number;
  total: number;
  full: boolean;
}

export const DENOISE_CHANNEL = "denoise-progress";

/** Computes (or confirms) the model's answer for one tier: the
 * preview tier at `edge`, or the full frame when `edge` is null (the
 * export's size; minutes on the CPU, so asked for on purpose). */
export interface DenoiseFullStatus { full: boolean; version?: string | null; width: number; height: number }
const denoiseCacheSubs = new Set<(cleared: boolean) => void>();
export function onDenoiseCacheChanged(fn: (cleared: boolean) => void): () => void {
  denoiseCacheSubs.add(fn);
  return () => { denoiseCacheSubs.delete(fn); };
}
function changedDenoiseCache(cleared = false) { for (const fn of denoiseCacheSubs) fn(cleared); }

export async function denoiseFullStatus(state: State): Promise<DenoiseFullStatus> {
  if (!isTauri()) return { full: false, width: 0, height: 0 };
  return call("denoise_full_status", { graph: serializeGraph(state), imageId: state.activeImage });
}

export async function denoiseMap(state: State, edge: number | null): Promise<DenoiseMapAnswer> {
  if (!isTauri()) return { version: "mock-denoise", work: "cached", tiles: 0, width: 0, height: 0 };
  const answer = await call<DenoiseMapAnswer>("denoise_map", { graph: serializeGraph(state), imageId: state.activeImage, edge });
  changedDenoiseCache();
  return answer;
}

/** How many 256 tiles the model runs over a (w, h) frame; the same
 * plan the desktop uses, so the browser build can say it too. */
export function denoiseTileCount(w: number, h: number): number {
  // Mirrors Rust DENOISE_TILE = 256 and DENOISE_OVERLAP = 32:
  // step = DENOISE_TILE - 2 * DENOISE_OVERLAP = 192.
  const axis = (n: number) => (n <= 256 ? 1 : Math.ceil((n - 256) / 192) + 1);
  return axis(w) * axis(h);
}

/** Subscribes to the model's tile progress. Returns an unsubscribe. */
export function onDenoiseProgress(fn: (p: DenoiseProgress) => void): () => void {
  if (!isTauri()) return () => {};
  // Through the event hub (taurievents.ts): leaving while the operation
  // still reports cannot strand a Rust callback.
  return onTauriEvent<DenoiseProgress>(DENOISE_CHANNEL, fn);
}

/** Computes (or confirms) the photograph's farness plane for the
 * depth tools. Cheap when the raster already exists; one model pass
 * when it does not. The answer says which, so the Depth Map section's
 * progress estimate learns from model reads alone. */
export async function depthMap(state: State): Promise<DepthMapAnswer> {
  if (!isTauri()) return { version: "mock-depth", work: "cached" };
  return await call("depth_map", {
    graph: serializeGraph(state),
    imageId: state.activeImage,
  });
}

/** One matte refinement of a selection: ViTMatte resolves the
 * selection's edge against the photograph: hair, fur, the fine
 * boundary the classical polish cannot read. Resolves with the
 * matte_id to write onto the node: the recipe pointer and the render
 * trigger.*/
export async function polishMatte(state: State, nodeId: string): Promise<string> {
  if (!isTauri()) return "mock-matte";
  return await call("polish_matte", {
    graph: serializeGraph(state),
    imageId: state.activeImage,
    nodeId,
  });
}

/** What Apply's full-resolution matte says back (fullmatte.rs):
 * "done" (the full-resolution answer is kept and every render uses it),
 * "kept" (the preview-resolution matte stays, `message` says why),
 * "canceled", "wait" (a brush landing is still on its way), or "none"
 * (nothing on the selection was refined by the model). */
export type MatteFullAnswer = {
  status: "done" | "kept" | "canceled" | "wait" | "none";
  message: string;
  tiles: number;
  ms: number;
  width: number;
  height: number;
};

/** Polish's Apply at the photograph's own resolution (2026-09-29:
 * "yes, do the full resolution fix"): the matte is solved again over
 * the full-resolution photograph, in tiles along the stroke, on the
 * progress row under the operation "matte".*/
export async function polishMatteFull(state: State, nodeId: string): Promise<MatteFullAnswer> {
  if (!isTauri()) return { status: "none", message: "", tiles: 0, ms: 0, width: 0, height: 0 };
  return await call("polish_matte_full", {
    graph: serializeGraph(state),
    imageId: state.activeImage,
    nodeId,
  });
}

/** Stops a selection's running full-resolution pass (an undo or a new
 * edit to the selection while it runs). Nothing is stored. */
export async function cancelPolishMatteFull(imageId: string, nodeId: string): Promise<boolean> {
  if (!isTauri()) return false;
  return await call("polish_matte_full_cancel", { imageId, nodeId });
}

// --- Tethering ---

export async function tetherStart(folder: string): Promise<void> {
  if (!isTauri()) return;
  await call("tether_start", { folder });
}

export async function tetherStop(): Promise<void> {
  if (!isTauri()) return;
  await call("tether_stop");
}

/** One poll of the hot folder: settles and registers whatever arrived
 * (move + naming pattern + collection per the session's dials) and
 * returns the new session records plus the running count. */
/** One tethered arrival: the catalog record plus the folder the file
 * landed in, so the panel can tell "append to the ribbon on screen" from
 * "count it, it landed in another folder". */
export type TetherImage = FolderImage & { folder: string };

export async function tetherPoll(opts: {
  dest?: string | null;
  pattern?: string;
  collection?: number | null;
}): Promise<{ images: TetherImage[]; session_count: number }> {
  if (!isTauri()) return { images: [], session_count: 0 };
  return await call("tether_poll", {
    dest: opts.dest ?? null,
    pattern: opts.pattern ?? "",
    collection: opts.collection ?? null,
  });
}

// --- Direct USB capture ---

export interface CameraProbe {
  key: string;
  vendor_id: number;
  product_id: number;
  name: string;
  manufacturer: string | null;
  serial: string | null;
  verdict: "PtpCapable" | "MassStorageOnly" | "KnownCameraNoImaging";
  note: string;
  /** every interface class the device presents; the verdict names the
   * first match, so this list settles whether a tether body also shows
   * its card (8 = mass storage, 6 = still image / PTP) */
  interfaces: number[];
}

export interface CameraScan {
  devices: CameraProbe[];
  /** the plain-language scan report behind the copy-diagnostics button */
  report: string;
}

export interface CameraState {
  connected: boolean;
  name: string;
  model: string;
  serial: string;
  can_capture: boolean;
  report_lines: string[];
}

export async function usbCameraScan(): Promise<CameraScan> {
  if (!isTauri()) return { devices: [], report: "Camera scan runs in the desktop app." };
  return await call("usb_camera_scan");
}

export async function usbCameraConnect(key: string): Promise<CameraState> {
  return await call("usb_camera_connect", { key });
}

export async function usbCameraDisconnect(): Promise<void> {
  if (!isTauri()) return;
  await call("usb_camera_disconnect");
}

export async function usbCameraStatus(): Promise<CameraState> {
  if (!isTauri()) {
    return { connected: false, name: "", model: "", serial: "", can_capture: false, report_lines: [] };
  }
  return await call("usb_camera_status");
}

/** The card watch: shots fired on the camera itself arrive as new
 * object handles and land through the same import path. For bodies
 * that announce no ObjectAdded event, this is the whole arrival story. */
export async function usbCameraPoll(opts: {
  dest?: string | null;
  pattern?: string;
  collection?: number | null;
}): Promise<{ images: TetherImage[]; session_count: number }> {
  if (!isTauri()) return { images: [], session_count: 0 };
  return await call("usb_camera_poll", {
    dest: opts.dest ?? null,
    pattern: opts.pattern ?? "",
    collection: opts.collection ?? null,
  });
}

/** One exposure setting as the body reported it: current value and
 * the list it accepts right now, which is all the control may offer. */
export interface ExposureControl {
  key: string;
  label: string;
  code: number;
  value_size: number;
  current: number;
  allowed: number[];
}

export interface ExposureState {
  controls: ExposureControl[];
  /** names of settings that did not answer, for the panel to say so */
  failed: string[];
  battery: number | null;
}

/** Read the exposure group: every descriptor the body answers for. */
export async function usbCameraExposure(): Promise<ExposureState> {
  if (!isTauri()) return { controls: [], failed: [], battery: null };
  return await call("usb_camera_exposure");
}

/** Set one exposure setting; the answer is the re-read state, so the
 * control follows the body rather than its own optimism. */
export async function usbCameraSetExposure(code: number, value: number): Promise<ExposureState> {
  if (!isTauri()) return { controls: [], failed: [], battery: null };
  return await call("usb_camera_set_exposure", { code, value });
}

/** Fire the shutter on the connected body; the frame lands through the
 * tether import path (destination, naming pattern, collection), so the
 * result has the same shape as a folder poll. `af` runs one autofocus
 * sweep before firing; a refusal (a body in MF) is logged and the shot
 * still fires. */
export async function usbCameraCapture(opts: {
  dest?: string | null;
  pattern?: string;
  collection?: number | null;
  af?: boolean;
}): Promise<{ images: TetherImage[]; session_count: number }> {
  if (!isTauri()) return { images: [], session_count: 0 };
  return await call("usb_camera_capture", {
    dest: opts.dest ?? null,
    pattern: opts.pattern ?? "",
    collection: opts.collection ?? null,
    af: opts.af ?? false,
  });
}

/** Live view (phase 3): start the stream; the panel then pumps
 * usbCameraLiveviewFrame and must call usbCameraLiveviewStop when the
 * stream is done. */
export async function usbCameraLiveviewStart(): Promise<void> {
  if (!isTauri()) return;
  await call("usb_camera_liveview_start");
}

/** One live view frame as a JPEG data URL, or null while the body is
 * mid-work (wait a beat and ask again). */
export async function usbCameraLiveviewFrame(): Promise<string | null> {
  if (!isTauri()) return null;
  return await call("usb_camera_liveview_frame");
}

/** Stop the stream; also safe after a disconnect. */
export async function usbCameraLiveviewStop(): Promise<void> {
  if (!isTauri()) return;
  await call("usb_camera_liveview_stop");
}

/** One focus step (phase 4). Modes are the body's own table, proven on
 * the DC-S5 over a running live view stream: 1 = farther, big step;
 * 2 = farther, small step; 3 = closer, small step; 4 = closer, big
 * step. */
export async function usbCameraFocusDrive(mode: number): Promise<void> {
  if (!isTauri()) return;
  await call("usb_camera_focus_drive", { mode });
}

/** One autofocus sweep (phase 4), verified on the DC-S5 over a running
 * live view stream with the body in AF: the lens sweeps and the body
 * answers with event 0xC104. A refusal means the body is in MF. */
export async function usbCameraAutofocus(): Promise<void> {
  if (!isTauri()) return;
  await call("usb_camera_autofocus");
}

export async function pickExportFolder(): Promise<string | null> {
  if (!isTauri()) return mockExportFolder;
  return call<string | null>("pick_export_folder");
}

/** Export presets live in the catalog, so they survive a reinstall the
 * same way ratings do. */
export async function loadExportPresets(): Promise<string | null> {
  if (!isTauri()) return null;
  return call<string>("load_export_presets");
}

/** The tool settings that outlive a session: which selection method was
 * last in hand, and the three selection switches. */
export async function loadUiSettings(): Promise<string | null> {
  if (!isTauri()) return mockLibrary.uiSettings;
  return call<string>("load_ui_settings");
}

export async function saveUiSettings(json: string): Promise<void> {
  if (!isTauri()) {
    mockUiSettingsCalls += 1;
    if (mockUiSettingsHold) await mockUiSettingsHold;
    mockLibrary.uiSettings = json;
    return;
  }
  await call("save_ui_settings", { json });
}

/** Test hooks for the stall plan's probes: the counter proves a save
 * started, and while the hold is set the browser mock's save waits on
 * it, the slow-catalog stand-in. */
export let mockUiSettingsCalls = 0;
export let mockUiSettingsHold: Promise<void> | null = null;
export function mockSetUiSettingsHold(next: Promise<void> | null): void {
  mockUiSettingsHold = next;
}

/** Region Select: the component under a click, as a FIELD-sized
 * coverage grid (0..255) the caller traces into an ordinary path
 * region. The tracer's own grid is the contract, so raising its
 * resolution raises this end to end.
 *
 * The mock mirrors the semantics rather than the algorithm: a
 * deterministic block around the click whose size follows the
 * tolerance, so the trace-and-commit flow tests end to end without an
 * engine. */
export async function regionSelect(
  imageId: string,
  x: number,
  y: number,
  tolerance: number,
): Promise<Uint8Array | null> {
  const { FIELD } = await import("./ui/selectionfield");
  if (!isTauri()) {
    const out = new Uint8Array(FIELD * FIELD);
    const r = Math.max(6, Math.round(tolerance * FIELD * 0.25));
    const cx = Math.round(x * FIELD);
    const cy = Math.round(y * FIELD);
    for (let gy = Math.max(0, cy - r); gy < Math.min(FIELD, cy + r); gy++) {
      for (let gx = Math.max(0, cx - r); gx < Math.min(FIELD, cx + r); gx++) {
        out[gy * FIELD + gx] = 255;
      }
    }
    return out;
  }
  try {
      const grid = await call<number[]>("region_select", {
      imageId,
      x,
      y,
      tolerance,
      grid: FIELD,
    });
    return Uint8Array.from(grid);
  } catch {
    // A failed segmentation selects nothing rather than throwing the
    // viewer down; the click simply does not land.
    return null;
  }
}

/** The shipped documentation: names from list_docs, text from read_doc.
 * The mock carries one small doc so the viewer works and tests run
 * without an install path to read. */
export interface DocEntry {
  file: string;
  title: string;
}

/** A stand-in guide for the browser build: the same shape as the real
 * one (a root README linking chapters, folders whose README links
 * their pages), small enough to read at a glance and enough for the
 * viewer's tree, search and cross-links to be exercised without a
 * desktop install. The real guide is read live from the install path,
 * and no copy of its words lives in the code.*/
const MOCK_DOCS: Record<string, string> = {
  "README.md": [
    "# Heeler user guide",
    "",
    "The real guide ships with the installed app and renders here from its `docs/user-guide` folder.",
    "",
    "## Start here",
    "",
    "1. [Library](library.md) - folders, collections and catalog navigation.",
    "2. [Export](export.md) - quick export, batches and the queue.",
    "3. [Adjustments](adjustments/README.md) - the Develop stage.",
    "",
    "## Legal",
    "",
    "- [Legal](legal/README.md) - the agreements, as the shipped guide links them.",
  ].join("\n"),
  "library.md": "# Library\n\nFolders, collections, and the catalog. See [Export](export.md).\n",
  "export.md": "# Export\n\nQuick export writes one file; a batch writes many.\n",
  "adjustments/README.md": [
    "# Adjustments tab",
    "",
    "Adjustments is the Develop stage.",
    "",
    "## Section order",
    "",
    "1. [Exposure](exposure.md)",
    "2. [Curves](curves.md)",
  ].join("\n"),
  "adjustments/exposure.md": "# Exposure\n\nOverall brightness, and the room the highlights keep.\n",
  "adjustments/curves.md": "# Curves\n\nA curve per channel, and one for luminosity.\n",
  // Deliberately linked by nobody: the viewer must still list it, or a
  // page that shipped would be a page nobody could reach.
  "adjustments/unlisted.md": "# Unlisted\n\nReachable even though no README links it.\n",
  // The legal folder, in miniature, so the Help menu's Legal Documents
  // and the About box's route land somewhere in the browser build.
  "legal/README.md": [
    "# Legal",
    "",
    "- [License](license.md)",
    "- [Heeler name and logo](trademark.md)",
    "- [Privacy Policy](privacy-policy.md)",
    "- [Open source notices](open-source.md)",
    "- [CDDL 1.0](cddl.md)",
  ].join("\n"),
  "legal/license.md": "Mozilla Public License Version 2.0\n==================================\n",
  "legal/trademark.md": "# Heeler name and logo\n\nThe license grants no rights to the Heeler name or logo.\n",
  "legal/privacy-policy.md": "# Heeler Privacy Policy\n\nWhat stays on your computer.\n",
  // Named by the About box in prose, so the mock guide carries them
  // too: a UI test that walks that path needs somewhere for it to land.
  "legal/open-source.md": "# Open source notices\n\nLibRaw under CDDL-1.0, and where its source is published.\n",
  "legal/cddl.md": "# CDDL 1.0\n\nThe license text, carried rather than linked.\n",
};

export async function listDocs(): Promise<DocEntry[]> {
  if (!isTauri())
    return Object.entries(MOCK_DOCS)
      .map(([file, text]) => ({
        file,
        title: text.split("\n").find((l) => l.startsWith("# "))?.slice(2).trim() ?? file,
      }))
      .sort((a, b) => a.file.localeCompare(b.file));
  try {
      return await call<DocEntry[]>("list_docs");
  } catch {
    return [];
  }
}

/** A guide image as base64, or null where images cannot load (the
 * browser build, a missing file): the viewer falls back to alt text. */
export async function readDocAsset(file: string): Promise<string | null> {
  if (!isTauri()) return null;
  try {
      return await call<string>("read_doc_asset", { file });
  } catch {
    return null;
  }
}

export async function readDoc(file: string): Promise<string | null> {
  if (!isTauri()) return MOCK_DOCS[file] ?? null;
  try {
      return await call<string>("read_doc", { file });
  } catch {
    return null;
  }
}

/** One Python console request: what it printed, what it errored, and
 * the value if the code was an expression. Mirrors driver.py. */
export interface PyResult {
  out: string;
  err: string;
  value: string | null;
}

/** The mock interpreter: not Python, but honest about the CONTRACT the
 * real one keeps. A persistent namespace, expression values, print to
 * out, NameError to err, so the console UI tests the same behaviors
 * users see. Numbers and simple arithmetic only. */
const mockPySpace: Record<string, number> = {};

/** A block runs line by line; the last line's expression value answers,
 * mirroring the driver's Jupyter-style contract. */
function mockPyExec(code: string): PyResult {
  let out = "";
  let value: string | null = null;
  for (const line of code.split("\n")) {
    if (!line.trim()) continue;
    const r = mockPyLine(line);
    if (r.err) return { out, err: r.err, value: null };
    out += r.out;
    value = r.value;
  }
  return { out, err: "", value };
}

function mockPyLine(code: string): PyResult {
  const src = code.trim();
  const assign = src.match(/^([A-Za-z_]\w*)\s*=\s*([-\d+*/(). \t]+)$/);
  const print = src.match(/^print\((['"])(.*)\1\)$/);
  if (print) return { out: `${print[2]}\n`, err: "", value: null };
  const evalNum = (expr: string): number | null => {
    const filled = expr.replace(/[A-Za-z_]\w*/g, (name) =>
      name in mockPySpace ? String(mockPySpace[name]) : "\u0000"
    );
    if (filled.includes("\u0000") || !/^[-\d+*/(). \t]+$/.test(filled)) return null;
    try {
      return new Function(`return (${filled});`)() as number;
    } catch {
      return null;
    }
  };
  if (assign) {
    const v = evalNum(assign[2]);
    if (v !== null) {
      mockPySpace[assign[1]] = v;
      return { out: "", err: "", value: null };
    }
  }
  const v = evalNum(src);
  if (v !== null) return { out: "", err: "", value: String(v) };
  const name = src.match(/^[A-Za-z_]\w*$/);
  if (name) return { out: "", err: `NameError: name '${src}' is not defined\n`, value: null };
  return { out: "", err: "mock console: only numbers here; the real one is Python\n", value: null };
}

export async function pyExec(code: string): Promise<PyResult> {
  if (!isTauri()) return mockPyExec(code);
  return await call<PyResult>("py_exec", { code });
}

export async function pyRunFile(path: string): Promise<PyResult> {
  if (!isTauri()) return { out: `ran ${path}\n`, err: "", value: null };
  return await call<PyResult>("py_run_file", { path });
}

export async function pyReset(): Promise<void> {
  if (!isTauri()) {
    for (const k of Object.keys(mockPySpace)) delete mockPySpace[k];
    return;
  }
  await call("py_reset");
}

export async function pickScript(): Promise<string | null> {
  if (!isTauri()) return "mock.heeler";
  return await call<string | null>("pick_script");
}

/** The mock disk for script tabs: what Save writes, Open reads back. */
export const mockScripts: Record<string, string> = { "mock.heeler": "print('from disk')" };

export async function pickScriptSave(): Promise<string | null> {
  if (!isTauri()) return "saved.heeler";
  return await call<string | null>("pick_script_save");
}

export async function readScript(path: string): Promise<string> {
  if (!isTauri()) {
    if (path in mockScripts) return mockScripts[path];
    throw new Error(`could not read ${path}`);
  }
  return await call<string>("read_script", { path });
}

export async function writeScript(path: string, text: string): Promise<void> {
  if (!isTauri()) {
    mockScripts[path] = text;
    return;
  }
  await call("write_script", { path, text });
}

/** Keywords: free-text tags on photographs, stored in the catalog and
 * mirrored into the XMP sidecar's dc:subject so they travel. The mock
 * keeps set semantics so the tag field is testable headless. */
const mockKeywords = new Map<string, string[]>();

export async function imageKeywords(imageId: string): Promise<string[]> {
  if (!isTauri()) return mockKeywords.get(imageId) ?? [];
  return call<string[]>("image_keywords", { imageId });
}

export async function allKeywords(): Promise<string[]> {
  if (!isTauri()) {
    const all = new Set<string>();
    for (const kws of mockKeywords.values()) for (const k of kws) all.add(k);
    return [...all].sort((a, b) => a.localeCompare(b));
  }
  return call<string[]>("all_keywords");
}

/** Ids of every catalog photo carrying this keyword, for tag: filters. */
export async function imagesWithKeyword(keyword: string): Promise<string[]> {
  if (!isTauri()) {
    if (mockKeywordHold) await mockKeywordHold;
    const ids: string[] = [];
    for (const [id, kws] of mockKeywords) {
      if (kws.some((k) => k.toLowerCase() === keyword.trim().toLowerCase())) ids.push(id);
    }
    return ids;
  }
  return call<string[]>("keyword_images", { keyword });
}

export async function setImageKeywords(imageId: string, keywords: string[]): Promise<void> {
  if (!isTauri()) {
    mockKeywords.set(
      imageId,
      keywords.map((k) => k.trim()).filter(Boolean)
    );
    return;
  }
  await call("set_image_keywords", { imageId, keywords });
}

/** An acceptance receipt, as the Assistant's disclaimer records it. */
export interface Acceptance {
  document: string;
  version: string;
  /** seconds, not milliseconds: the receipt is a file a person may open */
  unixTime: number;
  fingerprint: string;
}

// --- The assistant ---

/** One model a server lists, marked when it is on Heeler's tested list. */
export interface AssistantModel {
  id: string;
  tested: boolean;
}

/** What Validate found. The words are the panel's (src/assistant.ts). */
export type AssistantValidation =
  | { kind: "badAddress"; reason: string }
  | { kind: "notFound"; host: string; reason: string }
  | { kind: "notLocal"; host: string; address: string }
  | { kind: "nothingAnswering"; address: string }
  | { kind: "notAModelServer"; address: string; status: number }
  | { kind: "noModels"; address: string }
  | { kind: "connected"; address: string; models: AssistantModel[] };

export interface AssistantAcknowledged {
  model: string;
  unixTime: number;
}

/** The records kept in the app data folder: the notice, once, and each
 * untested model acknowledged, with their dates. */
export interface AssistantRecords {
  disclaimer: Acceptance | null;
  acknowledged: AssistantAcknowledged[];
  disclaimerVersion: string;
}

export interface AssistantMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** The browser build's stand-in server, so the panel and the tab can be
 * walked through without a model. Nothing leaves the page. */
export let mockAssistant: {
  records: AssistantRecords;
  validation: (address: string) => AssistantValidation;
  reply: (messages: AssistantMessage[]) => string;
  contextLength: number | null;
} = freshMockAssistant();

function freshMockAssistant(): typeof mockAssistant {
  return {
    records: { disclaimer: null, acknowledged: [], disclaimerVersion: "2026-09-28" },
    validation: (address) =>
      address.includes("localhost") || address.includes("127.0.0.1")
        ? { kind: "connected", address: "127.0.0.1:1234", models: [{ id: "mock-model", tested: false }] }
        : { kind: "nothingAnswering", address },
    // The first call of a question asks for chapters as JSON; the
    // second asks for the answer.
    // A how-to answer's third call asks for a guided tour (src/tour.ts):
    // the browser build answers black and white and the red channel as
    // a mask with tours, anything else with none.
    reply: (messages) => {
      const system = messages[0]?.content ?? "";
      const asked = messages[messages.length - 1]?.content ?? "";
      const mono = /black and white/i.test(asked);
      if (/TABLE OF CONTENTS/.test(system)) return '{"chapters": ["export.md"]}';
      if (/into a guided tour/.test(system)) {
        if (mono) {
          return JSON.stringify({ steps: [
            { stop: "section.color", say: "Unfold the Color section." },
            { stop: "bw.treatment", say: "Set Treatment to black and white: the conversion is built and its mix opens." },
            { stop: "bw.mix.blue", say: "Lower Blue to darken a blue sky." },
          ] });
        }
        if (/red channel/i.test(asked)) {
          return JSON.stringify({ steps: [
            { stop: "graph.add.channel_extract", say: "Add a Channel node." },
            { stop: "graph.connect", from: "port.image_source.out", to: "port.channel_extract.in", say: "Drag from Image Source's output to Channel's input." },
            { stop: "graph.add.exposure", say: "Add an Exposure node for the mask to limit." },
            { stop: "graph.connect", from: "port.channel_extract.mask-out", to: "port.exposure.mask", say: "Drag Channel's output to Exposure's mask diamond." },
          ] });
        }
        return '{"steps": []}';
      }
      if (mono) return "Open the **Color** section and set **Treatment** to black and white, then lower **Blue** to darken a sky.\nSources: export.md";
      if (/red channel/i.test(asked)) return "In the graph, add a **Channel** node set to red, wire **Image Source** into it, and drag its output to the mask of an **Exposure** node.\nSources: export.md";
      return "Use **Quick Export** in the title bar: it writes one file from the photograph on screen.\nSources: export.md";
    },
    contextLength: null,
  };
}

export function mockResetAssistant(): void {
  mockAssistant = freshMockAssistant();
}

export async function assistantRecords(): Promise<AssistantRecords> {
  if (!isTauri()) return mockAssistant.records;
  return await call<AssistantRecords>("assistant_records");
}

export async function assistantAcceptDisclaimer(): Promise<Acceptance> {
  if (!isTauri()) {
    const a = { document: "Heeler assistant notice", version: mockAssistant.records.disclaimerVersion, unixTime: Math.floor(Date.now() / 1000), fingerprint: "mock" };
    mockAssistant.records = { ...mockAssistant.records, disclaimer: a };
    return a;
  }
  return await call<Acceptance>("assistant_accept_disclaimer");
}

export async function assistantAcknowledgeModel(model: string): Promise<AssistantAcknowledged[]> {
  if (!isTauri()) {
    const list = [...mockAssistant.records.acknowledged, { model, unixTime: Math.floor(Date.now() / 1000) }];
    mockAssistant.records = { ...mockAssistant.records, acknowledged: list };
    return list;
  }
  return await call<AssistantAcknowledged[]>("assistant_acknowledge_model", { model });
}

export async function assistantValidate(address: string): Promise<AssistantValidation> {
  if (!isTauri()) return mockAssistant.validation(address);
  return await call<AssistantValidation>("assistant_validate", { address });
}

/** The reply, or a rejection carrying why there is none, in words. The
 * messages cross as an array, so the debug ledger records their count,
 * never their words (argShape). */
export async function assistantChat(address: string, model: string, messages: AssistantMessage[], temperature?: number): Promise<string> {
  if (!isTauri()) return mockAssistant.reply(messages);
  return await call<string>("assistant_chat", temperature === undefined ? { address, model, messages } : { address, model, messages, temperature });
}

/** The model's loaded context length in tokens, when the server
 * reports it (LM Studio does), else null. */
export async function assistantContextLength(address: string, model: string): Promise<number | null> {
  if (!isTauri()) return mockAssistant.contextLength;
  return await call<number | null>("assistant_context_length", { address, model });
}

// --- Opening pages in the browser ---

export let mockOpenedUrls: string[] = [];

export function mockResetOpenedUrls(): void {
  mockOpenedUrls = [];
}

/** Opens a page (a release, a model's home page) in the default browser. */
export async function openWebUrl(url: string): Promise<boolean> {
  if (!isTauri()) {
    mockOpenedUrls.push(url);
    return true;
  }
  return await call<boolean>("open_web_url", { url });
}

/** What Help > Check for Updates learns (src-tauri/src/update.rs). */
export interface UpdateCheck {
  available: boolean;
  /** this build, as people read it: "2026.1" */
  current: string;
  /** the newest release, the same way */
  latest: string;
  /** the installer for this machine, or the release page */
  url: string;
  notes: string;
}

/** The mock's answer: a reply, or null to play "cannot reach the
 * release list", which is also what a browser dev build gets. */
export let mockUpdateReply: UpdateCheck | null = null;

export function mockSetUpdateReply(next: UpdateCheck | null): void {
  mockUpdateReply = next;
}

// --- Model updates ---

export interface ModelUpdate {
  id: string;
  label: string;
  /** the version in place, as people read it */
  installed: string;
  /** the model list's */
  latest: string;
  bytes: number;
  notes: string;
}

export interface ModelUpdatesCheck {
  updates: ModelUpdate[];
  /** how many installed models were compared */
  checked: number;
}

/** The mock's answer: a reply, or null to play "cannot reach the
 * model list", which is also what a browser dev build gets. */
export let mockModelUpdatesReply: ModelUpdatesCheck | null = null;

export function mockSetModelUpdatesReply(next: ModelUpdatesCheck | null): void {
  mockModelUpdatesReply = next;
}

/** Asks the model list which installed models it carries a newer
 * version of. Rejects, in words the pane can show, when the list
 * cannot be reached or read. */
export async function modelUpdatesCheck(): Promise<ModelUpdatesCheck> {
  if (!isTauri()) {
    if (!mockModelUpdatesReply) throw new Error("could not reach the model list: no network");
    return mockModelUpdatesReply;
  }
  return await call<ModelUpdatesCheck>("model_updates_check");
}

/** Downloads the model list's version of one model over the one in
 * place; call only after the pane has named the version and size. */
export async function modelUpdateApply(model: string): Promise<void> {
  if (!isTauri()) {
    mockModelUpdatesReply = mockModelUpdatesReply
      ? { ...mockModelUpdatesReply, updates: mockModelUpdatesReply.updates.filter((u) => u.id !== model) }
      : null;
    modelsChanged();
    return;
  }
  await call("model_update_apply", { model });
  modelsChanged();
}

/** Asks the release list whether a newer Heeler exists. Rejects, in
 * words the dialog can show, when the list cannot be reached or read. */
export async function updateCheck(): Promise<UpdateCheck> {
  if (!isTauri()) {
    if (!mockUpdateReply) throw new Error("could not reach the release list: no network");
    return mockUpdateReply;
  }
  return await call<UpdateCheck>("update_check");
}

/** Opens a release's download in the default browser, through the same
 * https-only door every web link uses. */
export async function openReleaseUrl(url: string): Promise<boolean> {
  return openWebUrl(url);
}

export async function saveExportPresets(json: string): Promise<void> {
  if (!isTauri()) return;
  await call("save_export_presets", { json });
}

/** The LUT node's file picker and inspection. */
/** What the graph looks like at each named node, as small pictures by
 * node id. Nodes the engine does not know are left out; the mock has no
 * engine and answers nothing, so cards fall back to the ribbon's frame. */
export async function nodeThumbs(state: State, nodeIds: string[], edge = 160): Promise<Record<string, string> | null> {
  if (!isTauri() || nodeIds.length === 0) return null;
  try {
    return await call<Record<string, string>>("node_thumbs", {
      graph: serializeGraph(state),
      imageId: state.activeImage,
      nodeIds,
      edge,
      // The preview's own decode tier, so the frames land under the keys
      // the preview already trusts.
      previewEdge: previewEdgeFor(state),
    });
  } catch (err) {
    const { logMsg } = await import("./log");
    logMsg("warn", `node thumbnails failed: ${String(err)}`);
    return null;
  }
}

/** One photograph as the Catalog node's picker lists it. */
export interface CatalogPhoto {
  id: string;
  name: string;
  folderId: number | null;
  edited: boolean;
}

/** The catalog's photographs, read-only: one folder's by id, or every
 * folder's with null. Nothing about the session changes. */
export async function catalogImages(folderId: number | null): Promise<CatalogPhoto[]> {
  if (!isTauri()) return [];
  const raw = await call<{ id: string; name: string; folder_id: number | null; edited: boolean }[]>(
    "catalog_images",
    { folderId },
  );
  return raw.map((r) => ({ id: r.id, name: r.name, folderId: r.folder_id, edited: r.edited }));
}

/** A folder's photographs by path, or null when the catalog has never
 * scanned that folder. The mock answers for its own folders. */
export async function catalogFolderImages(path: string): Promise<CatalogPhoto[] | null> {
  if (!isTauri()) {
    const listing = MOCK_LISTINGS[path];
    return listing ? listing.images.map((f) => ({ id: f.id, name: f.name, folderId: null, edited: false })) : null;
  }
  const raw = await call<{ id: string; name: string; folder_id: number | null; edited: boolean }[] | null>(
    "catalog_folder_images",
    { path },
  );
  return raw ? raw.map((r) => ({ id: r.id, name: r.name, folderId: r.folder_id, edited: r.edited })) : null;
}

/** Saves the console's buffer through a save dialog; the path it went
 * to, or null when the dialog was dismissed. The mock has no disk. */
export async function saveConsoleLog(text: string): Promise<string | null> {
  if (!isTauri()) return null;
  return (await call<string | null>("save_console_log", { text })) ?? null;
}

/** A File node's own thumbnail: the file as it is on disk, card-sized. */
export async function fileThumb(path: string): Promise<string | null> {
  if (!isTauri() || !path) return null;
  try {
    return await call<string>("file_thumb", { path });
  } catch (err) {
    const { logMsg } = await import("./log");
    logMsg("warn", `File thumbnail failed: ${path}: ${String(err)}`);
    return null;
  }
}

/** The File node's picker: any image the decoders read. */
export async function pickImageFile(): Promise<string | null> {
  if (!isTauri()) return null;
  return (await call<string | null>("pick_image_file")) ?? null;
}

export async function pickLutFile(): Promise<string | null> {
  if (!isTauri()) return null;
  return (await call<string | null>("pick_lut_file")) ?? null;
}

/** Bake the branch ending at a node into a .cube on disk (proposal
 * §5's LUT baking). The backend asks where to save; null means the
 * user canceled, a string is the written path, and a refusal (spatial
 * branch, masks, geometry) arrives as a thrown error in words. */
export async function bakeLut(state: State, nodeId: string): Promise<string | null> {
  if (!isTauri()) return null;
  return (
    (await call<string | null>("bake_lut", {
      graph: serializeGraph(state),
      nodeId,
    })) ?? null
  );
}

export async function lutInfo(path: string): Promise<{ title: string; size: number } | null> {
  if (!isTauri() || !path) return null;
  try {
      return await call("lut_info", { path });
  } catch {
    return null;
  }
}

export type GamutReport = {
  fraction: number;
  clip_fraction: number;
  source_fraction: number;
  first_node: string | null;
  /** what the RAW itself blew (source pixels at sensor white) */
  source_clip_fraction: number;
  /** the first node whose clip outgrew both its input and the RAW */
  first_clip_node: string | null;
};

/** The gamut warning's numbers and attribution: a
 * session-executor cache read against the frame already on
 * screen.*/
export async function gamutReport(state: State): Promise<GamutReport | null> {
  if (!isTauri()) return null;
  try {
      return await call("gamut_report", {
      graph: serializeGraph(state),
      imageId: state.activeImage,
    });
  } catch {
    return null;
  }
}

/** Lens presets ride the same catalog storage as the export
 * presets.*/
export async function loadLensPresets(): Promise<string | null> {
  if (!isTauri()) return null;
  return call<string>("load_lens_presets");
}

export async function saveLensPresets(json: string): Promise<void> {
  if (!isTauri()) return;
  await call("save_lens_presets", { json });
}

/** The node recipes a person saved (noderecipes.ts), the same catalog
 * storage as the lens and export presets. */
export async function loadNodeRecipes(): Promise<string | null> {
  if (!isTauri()) return null;
  return call<string>("load_node_recipes");
}

export async function saveNodeRecipes(json: string): Promise<void> {
  if (!isTauri()) return;
  await call("save_node_recipes", { json });
}

/** One file of the recipes folder as the desktop reads it
 * (src-tauri/src/recipe_files.rs): the document in the file's own
 * shape with the line of each field, or the reason it could not be
 * read (recipefiles.ts turns either into a palette entry). */
export interface RecipeFileEntry {
  path: string;
  category: string;
  file: string;
  parsed: { doc: unknown; lines: Record<string, number> } | null;
  error: string | null;
}

/** Null outside the desktop: the browser build has no recipes folder. */
export async function recipeList(): Promise<RecipeFileEntry[] | null> {
  if (!isTauri()) return null;
  return await call("recipe_list");
}

/** Writes a recipe document as YAML into recipes/<category>/; the path. */
export async function recipeSave(category: string, doc: unknown): Promise<string> {
  if (!isTauri()) return "mock-recipe-path";
  return await call("recipe_save", { category, doc });
}

export async function recipeRename(path: string, name: string): Promise<string> {
  if (!isTauri()) return path;
  return await call("recipe_rename", { path, name });
}

/** Remove: the file moves into recipes/.trash. */
export async function recipeTrash(path: string): Promise<void> {
  if (!isTauri()) return;
  await call("recipe_trash", { path });
}

export async function recipeImport(): Promise<{ imported: string[]; failed: [string, string][] } | null> {
  if (!isTauri()) return null;
  return await call("recipe_import");
}

export async function recipeExport(doc: unknown, name: string): Promise<string | null> {
  if (!isTauri()) return null;
  return await call("recipe_export", { doc, name });
}

/** Shows a file selected in the file browser (revealFolder opens a
 * directory; this one points at one file inside it). */
export async function revealFile(path: string): Promise<void> {
  if (!isTauri()) return;
  await call("reveal_file", { path });
}

export async function revealFolder(path: string): Promise<void> {
  if (!isTauri()) return;
  await call("reveal_folder", { path });
}

/** Lists a folder's subfolders without scanning anything: the tree's lazy
 * expand and the new-folder watcher both use this. */
export async function listSubfolders(path: string): Promise<SubfolderEntry[]> {
  if (isTauri()) {
      return call<SubfolderEntry[]>("list_subfolders", { path });
  }
  return MOCK_LISTINGS[path]?.subfolders ?? [];
}

/** Test hook: grows the mock filesystem so watcher behavior is testable. */
export function mockAddSubfolder(parent: string, name: string): void {
  const listing = MOCK_LISTINGS[parent];
  if (!listing) return;
  const path = `${parent}/${name.toLowerCase().replace(/\s+/g, "")}`;
  listing.subfolders = [...listing.subfolders, { name, path }];
  MOCK_LISTINGS[path] = { name, path, images: MOCK_FILES, subfolders: [] };
}

export async function listFolders(): Promise<BridgeFolder[]> {
  if (isTauri()) {
      const raw = await call<any[]>("list_folders");
    return raw.map((f) => ({ id: f.id, name: f.name, path: f.path, count: f.count, lastOpened: f.last_opened }));
  }
  return [...mockLibrary.folders].sort((a, b) => b.lastOpened - a.lastOpened);
}

export async function listCollections(): Promise<BridgeCollection[]> {
  if (isTauri()) {
      const raw = await call<any[]>("list_collections");
    return raw.map((c) => ({ id: c.id, name: c.name, count: c.count, hasLook: c.has_look }));
  }
  if (mockLibraryHold) await mockLibraryHold;
  return mockLibrary.collections.map((c) => ({
    ...c,
    count: mockLibrary.members.get(c.id)?.size ?? 0,
  }));
}

export async function createCollection(name: string): Promise<number> {
  if (isTauri()) {
      return call<number>("create_collection", { name });
  }
  const id = mockLibrary.nextCollectionId++;
  mockLibrary.collections.push({ id, name, count: 0, hasLook: false });
  mockLibrary.members.set(id, new Map());
  return id;
}

export async function renameCollection(collectionId: number, name: string): Promise<void> {
  if (isTauri()) {
      return call("rename_collection", { collectionId, name });
  }
  const c = mockLibrary.collections.find((c) => c.id === collectionId);
  if (c) c.name = name;
}

export async function deleteCollection(collectionId: number): Promise<void> {
  if (isTauri()) {
      return call("delete_collection", { collectionId });
  }
  mockLibrary.collections = mockLibrary.collections.filter((c) => c.id !== collectionId);
  mockLibrary.members.delete(collectionId);
}

/** `name` rides along for the mock bridge's display; Tauri reads it from
 * the catalog instead. */
export async function addToCollection(collectionId: number, imageId: string, name?: string): Promise<void> {
  if (isTauri()) {
      return call("add_to_collection", { collectionId, imageId });
  }
  mockLibrary.members.get(collectionId)?.set(imageId, name ?? imageId);
}

export async function removeFromCollection(collectionId: number, imageId: string): Promise<void> {
  if (isTauri()) {
      return call("remove_from_collection", { collectionId, imageId });
  }
  mockLibrary.members.get(collectionId)?.delete(imageId);
}

export async function loadCollection(collectionId: number): Promise<FolderImage[]> {
  if (isTauri()) {
      return call<FolderImage[]>("load_collection", { collectionId });
  }
  const members = mockLibrary.members.get(collectionId) ?? new Map();
  return [...members.entries()].map(([id, name]) => ({ id, name, stars: 0, flag: "" as const }));
}

/** Mock thumbnail store, mirroring the catalog's: a rendered thumbnail
 * is remembered under its image id and handed back on the next ask. */
const mockThumbs = new Map<string, string>();

export function mockSetThumbnail(imageId: string, src: string): void {
  mockThumbs.set(imageId, src);
}

/** Test hook: the store emptied between tests. */
export function mockResetThumbnails(): void {
  mockThumbs.clear();
  mockThumbHold = null;
}

/** Test hook for the stall plan's probes: while set, the browser
 * mock's thumbnail load waits on it, the slow-volume stand-in. */
export let mockThumbHold: Promise<void> | null = null;
export function mockSetThumbnailHold(next: Promise<void> | null): void {
  mockThumbHold = next;
}

/** Drops the catalog's cached thumbnail for one photograph, so the next
 * load rebuilds it from the file's own preview. */
export async function clearThumbnail(imageId: string): Promise<void> {
  if (!isTauri()) return;
  await call("clear_thumbnail", { imageId });
}

/** A photograph's ribbon thumbnail. `graph` is what a photograph with
 * no embedded preview (a merge) renders through when the catalog
 * holds none: the graph the viewer opens it with
 * (serializeThumbnailGraph). Without it a merge's thumbnail was the
 * undeveloped merge, well under the viewer. */
export async function loadThumbnail(imageId: string, edge = 480, graph?: unknown): Promise<string | null> {
  if (!isTauri()) {
    if (mockThumbHold) await mockThumbHold;
    return mockThumbs.get(imageId) ?? null;
  }
  try {
    return await call<string>("load_thumbnail", graph ? { imageId, edge, graph } : { imageId, edge });
  } catch (error) {
    if (graph || !String(error).includes("thumbnail requires editor graph")) throw error;
    // Old edited merges have editor nodes but no embedded render graph.
    // Convert only on a cache miss that needs it, using the same path
    // as export. Do not rewrite the saved edit just to make a thumbnail.
    const saved = await loadGraph(imageId);
    if (!saved) throw error;
    return call<string>("load_thumbnail", { imageId, edge, graph: serializeLoadedGraph(imageId, saved) });
  }
}

/** Links the photographs into one group, or unlinks them (group null).
 * The browser build keeps the groups in memory for the session. */
const mockLinkGroups = new Map<string, string>();
export async function setImageLinkGroup(imageIds: string[], group: string | null): Promise<void> {
  if (!isTauri()) {
    for (const id of imageIds) {
      if (group === null) mockLinkGroups.delete(id);
      else mockLinkGroups.set(id, group);
    }
    return;
  }
  await call("set_image_link_group", { imageIds, group });
}
export function mockLinkGroupOf(imageId: string): string | null {
  return mockLinkGroups.get(imageId) ?? null;
}

export async function persistRating(imageId: string, stars: number): Promise<void> {
  if (!isTauri()) return;
  await call("set_image_rating", { imageId, stars });
}

/** Mock per-image graph files, mirroring save_ui_graph/load_ui_graph:
 * JSON round-trip like the Rust side, so what tests read back is what a
 * file would have held, not the object they wrote. */
const mockGraphs = new Map<string, string>();

export async function saveGraph(
  imageId: string,
  payload: {
    nodes: unknown[];
    wires: unknown[];
    backdrops?: unknown[];
    /** alternate edits of this image, persisted alongside the graph */
    versions?: unknown[];
    activeVersion?: string;
    /** the photograph's own overlay line thickness in pixels, a view
     * setting kept beside the graph; absent follows the preference */
    lineWidth?: number;
  },
  edited = false,
  revision = nextSaveRevision(imageId),
  resolve = false,
  source?: RenderedSource,
): Promise<void> {
  // The engine's shape rides inside the file under `render`, produced
  // by the same serializer every render uses. Headless serve and batch
  // mode render from it directly; without it they can only treat the
  // photo as unedited, because the editor-to-engine conversion (group
  // flattening, curve and stroke encoding) lives here in the frontend
  // and nowhere else.
  const data = JSON.stringify({
    ...payload,
    revision,
    render: serializeLoadedGraph(imageId, {
      nodes: payload.nodes,
      wires: payload.wires,
    }, source),
  });
  if (!isTauri()) {
    mockGraphs.set(imageId, data);
    autosaves.acknowledge(imageId, revision);
    return;
  }
  await call("save_ui_graph", { imageId, data, edited, revision, resolve });
  autosaves.acknowledge(imageId, revision);
}

/** Persists where the user is: the tree's root folder and the folder
 * whose images are showing. Restore rebuilds the tree from these.
 *
 * An absent OR empty image means "nothing settled on screen yet" (folder
 * navigation saves before the selection does) and leaves the remembered
 * image alone; only a real id replaces it. */
export async function saveSession(
  treeRoot: string,
  activeFolder: string,
  activeImage?: string
): Promise<void> {
  const image = activeImage ? activeImage : null;
  if (isTauri()) {
      return call("save_ui_session", { treeRoot, activeFolder, activeImage: image });
  }
  const perRoot = mockLibrary.folderSessions.get(treeRoot);
  mockLibrary.folderSessions.set(treeRoot, {
    activeFolder,
    activeImage: image ?? perRoot?.activeImage ?? "",
  });
  mockLibrary.session = {
    treeRoot,
    activeFolder,
    activeImage: image ?? mockLibrary.session?.activeImage ?? "",
  };
}

export async function loadSession(): Promise<
  { treeRoot: string; activeFolder: string; activeImage: string } | null
> {
  if (isTauri()) {
      const s = await call<any | null>("load_ui_session");
    return s
      ? { treeRoot: s.tree_root, activeFolder: s.active_folder, activeImage: s.active_image ?? "" }
      : null;
  }
  return mockLibrary.session ?? null;
}

/** Where work in this root last stood, or null if it was never worked in.
 * Reopening the folder descends back to this subfolder and image. */
export async function loadFolderSession(
  root: string
): Promise<{ treeRoot: string; activeFolder: string; activeImage: string } | null> {
  if (isTauri()) {
      const s = await call<any | null>("folder_session", { root });
    return s
      ? { treeRoot: s.tree_root, activeFolder: s.active_folder, activeImage: s.active_image ?? "" }
      : null;
  }
  const s = mockLibrary.folderSessions.get(root);
  return s ? { treeRoot: root, ...s } : null;
}

/** Test hook: wipes all remembered sessions, so one test's navigation
 * cannot become the next test's surprise restore. */
export function mockResetSessions(): void {
  mockLibrary.session = null;
  mockLibrary.folderSessions.clear();
  mockLibrary.uiSettings = null;
  mockServe = null;
}

/** Test hook: the remembered tool settings, back to none.
 *
 * They persist by design, which across tests means one test's choice of
 * lasso silently becomes the next one's default. Called from the global
 * test setup rather than per file, because every test that renders the
 * app reads them. */
export function mockResetUiSettings(): void {
  mockLibrary.uiSettings = null;
  mockUiSettingsCalls = 0;
  mockUiSettingsHold = null;
}

/** Test hook: keywords back to none, so one test's "bride" is not the
 * next test's ghost suggestion. */
export function mockResetKeywords(): void {
  mockKeywords.clear();
  mockKeywordHold = null;
}

/** Test hook for the stall plan's probes: while set, the browser
 * mock's keyword query waits on it, the slow-volume stand-in. */
export let mockKeywordHold: Promise<void> | null = null;
export function mockSetKeywordHold(next: Promise<void> | null): void {
  mockKeywordHold = next;
}

/** Test hook: per-image graph files back to none. */
export function mockResetGraphs(): void {
  mockGraphs.clear();
}

/** Test hook: collections back to none, ids back to 1, so a test that
 * creates one cannot renumber every collection the next test makes. */
export function mockResetCollections(): void {
  mockLibrary.collections = [];
  mockLibrary.members.clear();
  mockLibrary.nextCollectionId = 1;
  mockLibraryHold = null;
}

/** Test hook for the stall plan's probes: while set, the browser
 * mock's collection list waits on it, the slow-volume stand-in. */
export let mockLibraryHold: Promise<void> | null = null;
export function mockSetLibraryHold(next: Promise<void> | null): void {
  mockLibraryHold = next;
}

/** Test hook: plants (or clears) a remembered session for one root. */
export function mockSetFolderSession(
  root: string,
  session: { activeFolder: string; activeImage?: string } | null
): void {
  if (session === null) mockLibrary.folderSessions.delete(root);
  else
    mockLibrary.folderSessions.set(root, {
      activeFolder: session.activeFolder,
      activeImage: session.activeImage ?? "",
    });
}

/** Most recently opened folder regardless of edits, for session restore. */
export async function lastSessionFolder(): Promise<BridgeFolder | null> {
  if (isTauri()) {
      const f = await call<any | null>("last_session_folder");
    return f ? { id: f.id, name: f.name, path: f.path, count: f.count, lastOpened: f.last_opened } : null;
  }
  const sorted = [...mockLibrary.folders].sort((a, b) => b.lastOpened - a.lastOpened);
  return sorted.length > 0 && sorted[0].lastOpened > 0 ? sorted[0] : null;
}

export type SavedGraph = { nodes: any[]; wires: any[]; backdrops?: any[]; versions?: any[]; activeVersion?: string; revision?: number; linkOverrides?: string[]; lineWidth?: number };
export type GraphLoadResult =
  | { status: "absent"; revision?: number; lineWidth?: number }
  | { status: "ready"; graph: SavedGraph }
  | { status: "blocked"; path: string; error: string; broken: string | null; last_good: boolean };

export function parseSavedGraph(data: string): SavedGraph {
  const graph = JSON.parse(data);
  const valid = (g: any) => g && Array.isArray(g.nodes) && Array.isArray(g.wires)
    && g.nodes.every((n: any) => n && typeof n.id === "string" && (n.type === undefined || typeof n.type === "string") && (n.params === undefined || (n.params && typeof n.params === "object" && !Array.isArray(n.params))))
    && g.wires.every((w: any) => w && typeof w.from === "string" && typeof w.to === "string");
  if (!valid(graph) || (graph.versions !== undefined && (!Array.isArray(graph.versions) || !graph.versions.every((v: any) => valid(v) && typeof v.id === "string")))) {
    throw new Error("The saved edits are not a valid graph.");
  }
  return graph;
}

export async function loadGraphResult(imageId: string): Promise<GraphLoadResult> {
  try {
    const result = isTauri()
      ? await call<{ status: "absent"; revision?: number; lineWidth?: number } | { status: "ready"; data: string } | Extract<GraphLoadResult, { status: "blocked" }>>("load_ui_graph", { imageId })
      : mockGraphs.has(imageId) ? { status: "ready" as const, data: mockGraphs.get(imageId)! } : { status: "absent" as const };
    if (result.status !== "ready") {
      // A reset marker (or the legacy demo edit) reads as absent but the
      // gate still holds its revision: the next edit must start above it
      // even on a machine whose clock is behind the one that reset it.
      if (result.status === "absent") observeSaveRevision(imageId, result.revision ?? 0);
      return result;
    }
    const graph = parseSavedGraph(result.data);
    observeSaveRevision(imageId, graph.revision ?? 0);
    return { status: "ready", graph };
  } catch (error) {
    return { status: "blocked", path: imageId, error: String(error), broken: null, last_good: false };
  }
}

/** Existing consumers may treat only a missing graph as fresh. Damage and IPC
 * failures propagate, so paste, quad edit and export cannot overwrite defaults. */
export async function loadGraph(imageId: string): Promise<SavedGraph | null> {
  const result = await loadGraphResult(imageId);
  if (result.status === "blocked") throw new Error(`${result.path}: ${result.error}`);
  return result.status === "ready" ? result.graph : null;
}

export async function loadLastGoodGraph(imageId: string): Promise<SavedGraph> {
  return parseSavedGraph(await call<string>("load_last_good_graph", { imageId }));
}

export async function persistFlag(imageId: string, flag: string): Promise<void> {
  if (!isTauri()) return;
  await call("set_image_flag", { imageId, flag });
}

export interface ExportOptions {
  format: "jpeg" | "png";
  quality: number;
  /** long-edge cap in px, or null for full size */
  maxEdge: number | null;
  /** scale to this percent of the frame; the backend applies it, since
   * only the backend knows the source's full resolution */
  scalePercent?: number | null;
  /** carry the camera's EXIF into the export (rebuilt clean: orientation
   * reset, export dimensions, real resolution fields) */
  keepMetadata: boolean;
  /** the print resolution the file declares; absent is 300 */
  dpi?: number;
}

/** Exports the active image through the full graph at full resolution.
 * Returns the saved path, null if canceled, and throws on failure.
 * Browser mock: the ledger records what would have been written, the
 * same as exportTo, so the quick export is testable headless. */
export async function exportImage(state: State, opts: ExportOptions): Promise<string | null> {
  if (!isTauri()) {
    const dest = `${state.activeImage}.${opts.format === "png" ? "png" : "jpg"}`;
    mockExports.push({ imageId: state.activeImage, dest, format: opts.format, dpi: exportDpi(opts.dpi) });
    return dest;
  }
  return call<string | null>("export_image", {
    graph: serializeGraph(state),
    imageId: state.activeImage,
    format: opts.format,
    quality: opts.quality,
    maxEdge: opts.maxEdge,
    scalePercent: opts.scalePercent ?? null,
    keepMetadata: opts.keepMetadata,
    dpi: exportDpi(opts.dpi),
    // The save dialog has already asked Replace?, so a yes CAN be
    // honored here. Whether it is, is the user's standing preference:
    // it ships on, because an accepted Replace? is still a file gone
    // and the guard costs a suffix. No preference reaches the refusal
    // to write over a photograph in the library; that one has no
    // switch and lives in the backend.
    allowOverwrite: !state.prefs.exportNeverOverwrite,
  });
}

/** The "before" frame for comparisons: untouched develop with the
 * graph's geometry applied, so both sides share framing. Null in the
 * mock bridge: the static asset already is the original. */
/** Samples the developed source under the eyedropper. Returns
 * display-referred luma plus hue/saturation, matching the space the
 * range mask keys in, and scene-linear channel means. With `curveNode`,
 * the engine renders the graph up to whatever feeds that node and
 * samples there, so the pick reads the value the curve actually
 * receives; the engine resolves the feeder itself because the
 * frontend's idea of the wiring has been wrong before. `source` names
 * the node the sample came from. Null in the browser mock (no engine
 * to sample). */
/** The lensfun profile matched to the active photograph's lens, or
 * null: no lens in the EXIF, no database match, or outside the app. */
export type LensProfileHit = {
  name: string;
  maker: string;
  matched: boolean;
  calibrated: boolean;
  /** Distortion model interpolated to the shot's focal length, with its
   * coefficients and the camera-to-calibration radius scale; model is
   * null when there is nothing applicable to write onto the node. */
  model: string | null;
  a: number;
  b: number;
  c: number;
  scale: number;
  focal: number | null;
  /** TCA [vr, cr, br, vb, cb, bb] at the shot's focal length. */
  tca: [number, number, number, number, number, number] | null;
  /** Vignetting [k1, k2, k3] at the shot's focal length and aperture. */
  vig: [number, number, number] | null;
};

export async function lensProfileFor(imageId: string): Promise<LensProfileHit | null> {
  if (!isTauri()) return null;
  try {
      return await call("lens_profile_for", { imageId });
  } catch {
    return null;
  }
}

/** The measured noise floor of the active photograph's source, or
 * null outside the app. See estimate_noise in lib.rs. */
export async function estimateNoise(
  state: State,
): Promise<{ luma_sigma: number; chroma_sigma: number } | null> {
  if (!isTauri()) return null;
  try {
      return await call("estimate_noise", {
      graph: serializeGraph(state),
      imageId: state.activeImage,
    });
  } catch {
    return null;
  }
}

/** Maps a measured noise floor to the two Noise Reduction sliders.
 * First-pass calibration, same status as the NLM strength curve: the
 * shape (monotone, chroma pushed harder than luma, both capped short
 * of the destructive top end) is the design; the constants await the
 * owner's eye on real frames. Sigmas are display-space standard
 * deviations.
 */
export function autoNoiseStrengths(est: { luma_sigma: number; chroma_sigma: number }): {
  luma: number;
  chroma: number;
} {
  // Calibrated 2026-08-23 against the owner's hand-set values on two of
  // his own frames, sigmas measured by the engine on the same files:
  // DSCF2858.RAF (ISO 3200): sigma L .00464 C .01862 -> L 16, C 31
  // P1551315.RW2 (ISO 800): sigma L .00379 C .01398 -> L 7, C 23
  // Luminance is a thresholded line: below a noise floor of ~0.003
  // display-sigma nothing is worth smoothing, then it climbs steeply.
  // Chroma runs nearly through the origin: color speckle always wants
  // some smoothing once it is measurable. Both cap short of the
  // destructive top end.
  const luma = Math.min(60, Math.max(0, Math.round(est.luma_sigma * 10600 - 33)));
  const chroma = Math.min(80, Math.max(0, Math.round(est.chroma_sigma * 1724 - 1)));
  return { luma, chroma };
}

export async function sampleImage(
  state: State,
  x: number,
  y: number,
  radius = 0.01,
  curveNode?: string,
  /** "by" is Recolor's mask port: the sample is the chosen mask's
   * coverage in every channel, or an error when no mask is chosen */
  inputPort: "in" | "ref" | "out" | "by" = "in",
): Promise<{
  luma: number;
  hue: number;
  sat: number;
  /** scene-linear channel means; display-encode for the curve axis */
  r?: number;
  g?: number;
  b?: number;
  luma_linear?: number;
  /** node id the sample was read from; "original" is the fallback */
  source?: string;
} | null> {
  if (!isTauri()) return null;
  try {
      return await call<{ luma: number; hue: number; sat: number }>("sample_image", {
      graph: serializeGraph(state),
      imageId: state.activeImage,
      x,
      y,
      radius,
      curveNode: curveNode ?? null,
      inputPort,
    });
  } catch {
    return null;
  }
}

/** What a curve eyedropper reads where the engine indexes the curve:
 * "tone" is Relight's illuminance in EV from middle gray (value); "around"
 * is the Recolor Around rows' surroundings, a hue in degrees (value) and
 * its OkLab chroma. Null in the browser build or on failure. */
export async function curveLookup(
  state: State,
  node: string,
  x: number,
  y: number,
  kind: "tone" | "around",
): Promise<{ value: number; chroma: number } | null> {
  if (!isTauri()) return null;
  try {
    return await call<{ value: number; chroma: number }>("curve_lookup", { graph: serializeGraph(state), imageId: state.activeImage, node, x, y, kind });
  } catch {
    return null;
  }
}

/** The browser build's stand-in for the engine: the histogram of the
 * photograph as it came, read from a small canvas. Null where there is
 * no canvas (tests). */
async function photoChromaHistogram(state: State, node: string): Promise<number[] | null> {
  const url = state.images.find((i) => i.id === state.activeImage)?.src;
  if (!url || typeof document === "undefined") return null;
  const img = await new Promise<HTMLImageElement | null>((done) => {
    const el = new Image();
    el.onload = () => done(el);
    el.onerror = () => done(null);
    el.src = url;
  });
  if (!img || !img.naturalWidth || !img.naturalHeight) return null;
  try {
    const scale = Math.min(1, 256 / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const ctx = Object.assign(document.createElement("canvas"), { width: w, height: h }).getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, w, h);
    const smoothing = state.nodes.find((n) => n.id === node)?.params.smoothing ?? 50;
    return chromaHistogramOfPixels(ctx.getImageData(0, 0, w, h).data, w, h, smoothing);
  } catch {
    return null;
  }
}

/** The share of the picture feeding a Recolor node's hue rows at each
 * chroma, for the Neutral guard strip (eqcurve.ts GUARD_HIST_BINS). The
 * browser build reads the photograph instead. Null on failure; empty when nothing feeds the node. */
export async function chromaHistogram(state: State, node: string): Promise<number[] | null> {
  if (!isTauri()) return await photoChromaHistogram(state, node);
  try {
    return await call<number[]>("chroma_histogram", { graph: serializeGraph(state), imageId: state.activeImage, node });
  } catch {
    return null;
  }
}

/** The Zone System's placement: the
 * spots to land, first then second, each with the encoded gray of its
 * zone; the answer is the Exposure and, with a second spot, the Tone
 * Profile contrast to write. Null without an engine or on failure. */
export async function placeZone(
  state: State,
  spots: { x: number; y: number; target: number }[],
): Promise<{ exposure: number; contrast: number | null; development?: number | null; landed?: number[] } | null> {
  if (!isTauri()) return null;
  try {
    return await call<{ exposure: number; contrast: number | null; development: number | null; landed: number[] }>("place_zone", {
      graph: serializeGraph(state),
      imageId: state.activeImage,
      spots,
    });
  } catch (err) {
    const { logMsg } = await import("./log");
    logMsg("warn", `Zone placement: ${String(err)}`);
    return null;
  }
}

/** Metadata half of a preview envelope; mirrors PreviewResult in lib.rs. */
type PreviewMeta = {
  source_identity?: string;
  memory_notice?: string;
  mime: string;
  ms: number;
  image_id: string;
  backend: string;
  roi: [number, number, number, number] | null;
  frame: [number, number] | null;
};

/** Splits a preview envelope (preview_envelope in lib.rs): "HPRV", u32 LE
 * metadata length, metadata JSON, image bytes. Frames arrive as raw bytes
 * over the binary IPC channel instead of base64 data URLs in JSON: a
 * third fewer bytes and no string decode ahead of the image decode.
 * Throws on anything that is not an envelope; feeding a desynced buffer
 * to an image decoder should fail loudly, not draw garbage. */
export function parsePreviewEnvelope(raw: ArrayBuffer | Uint8Array): {
  meta: PreviewMeta;
  bytes: Uint8Array<ArrayBuffer>;
} {
  const buf = raw instanceof Uint8Array ? raw.slice().buffer : raw;
  const view = new DataView(buf);
  // "HPRV" read big-endian, so the constant spells the bytes in order.
  if (buf.byteLength < 8 || view.getUint32(0, false) !== 0x48505256) {
    throw new Error("not a preview envelope");
  }
  const len = view.getUint32(4, true);
  if (8 + len > buf.byteLength) throw new Error("preview envelope truncated");
  const meta = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, len))) as PreviewMeta;
  return { meta, bytes: new Uint8Array(buf, 8 + len) };
}

/** A Blob URL per frame slot (preview, settle, roi, mask, original), with the
 * previous generation kept alive: the outgoing frame can still be on
 * screen while its replacement is decoding, so only the one before that
 * is safe to revoke. Without revocation every rendered frame would stay
 * pinned in webview memory for the session. */
const frameSlots = new Map<string, { current: string | null; outgoing: string | null }>();
function frameUrl(slot: string, meta: PreviewMeta, bytes: Uint8Array<ArrayBuffer>): string {
  const url = URL.createObjectURL(new Blob([bytes], { type: meta.mime }));
  const s = frameSlots.get(slot) ?? { current: null, outgoing: null };
  if (s.outgoing) URL.revokeObjectURL(s.outgoing);
  s.outgoing = s.current;
  s.current = url;
  frameSlots.set(slot, s);
  return url;
}

/** A cached settle may outlive two rejected replacement renders. */
export function settleFrameIsLive(url: string): boolean {
  const slot = frameSlots.get("settle");
  return slot?.current === url || slot?.outgoing === url;
}

/** A settle the pump never showed (it landed after a photograph switch,
 * an edit overtook it, or it would not decode) gives its blob back now
 * rather than riding the slot until two more settles push it out. The
 * frame before it keeps its place. */
export function discardSettleFrame(url: string): void {
  const slot = frameSlots.get("settle");
  if (slot?.current !== url) return;
  URL.revokeObjectURL(url);
  slot.current = slot.outgoing;
  slot.outgoing = null;
}

/** An image switch releases both encoded generations of its settle. */
export function releaseSettleFrames(): void {
  const slot = frameSlots.get("settle");
  if (slot?.current) URL.revokeObjectURL(slot.current);
  if (slot?.outgoing) URL.revokeObjectURL(slot.outgoing);
  frameSlots.delete("settle");
}

/** One branch's frame for the A/B comparison (proposal §5's branch
 * A/B): the same arbitrary-terminal redirect the probes ride, one shot
 * per render tick per side, fast tier only. The slot keeps the two
 * sides' object URLs from leaking. */
export async function renderBranchFrame(
  state: State,
  nodeId: string,
  slot: "ab_a" | "ab_b",
): Promise<string | null> {
  if (!isTauri()) return null;
  try {
    const raw = await invokeRender<ArrayBuffer>("render_preview", {
      graph: serializeGraph(state),
      imageId: state.activeImage,
      maskNode: nodeId,
      fullRes: false,
      gamutView: false,
    });
    const { meta, bytes } = parsePreviewEnvelope(raw);
    logDebug(() => `envelope: ${meta.image_id} ${meta.mime} ${bytes.length}b ${meta.ms}ms ${meta.backend}${meta.roi ? ` roi=[${meta.roi.join(",")}]` : ""}`);
    return frameUrl(slot, meta, bytes);
  } catch {
    return null;
  }
}

/** The graph "before" means: the photo AS IT OPENS FRESH, with the
 * live crop spliced in so the two panes stay aligned. It used to be
 * the raw decode plus crop, which skipped the default base
 * rendering every fresh photo gets, so a zero-edit photo compared
 * against a darker stranger ("I have a photo with zero
 * edits but when I turn on split the before gets darker").
 * freshGraphFor already encodes all the fresh-open rules, the
 * rendered-source profile bypass for JPEGs included, so before and
 * after are pixel-identical at zero edits by construction.*/
export function serializeBeforeGraph(state: State, imageId: string) {
  const fresh = freshGraphFor(state, imageId);
  // The chain's own crop first: a duplicated crop card has a fresh id
  // the chain order does not know, and splicing by that id would leave
  // the card unwired and the before pane uncropped.
  const liveCrop =
    state.nodes.find((n) => n.id === "crop" && n.type === "heeler.crop_rotate") ??
    state.nodes.find((n) => n.type === "heeler.crop_rotate");
  // A fresh graph has no crop node (Geometry is on-demand), so the live
  // one is spliced in at its chain slot rather than copied over: the
  // before pane must show the same frame as the after.
  const nodes = liveCrop
    ? [...fresh.nodes, { ...liveCrop, id: "crop", params: { ...liveCrop.params } }]
    : fresh.nodes;
  const wires = liveCrop ? spliceIn(fresh.wires, "crop") : fresh.wires;
  return serializeEditorGraph(nodes, wires, `${imageId}_ui`);
}

export async function renderOriginal(state: State): Promise<{ url: string; imageId: string } | null> {
  if (!isTauri()) return null;
  try {
      const raw = await call<ArrayBuffer>("render_original", {
      graph: serializeBeforeGraph(state, state.activeImage),
      imageId: state.activeImage,
    });
    const { meta, bytes } = parsePreviewEnvelope(raw);
    logDebug(() => `envelope: ${meta.image_id} ${meta.mime} ${bytes.length}b ${meta.ms}ms ${meta.backend}${meta.roi ? ` roi=[${meta.roi.join(",")}]` : ""}`);
    return { url: frameUrl("original", meta, bytes), imageId: meta.image_id };
  } catch {
    return null;
  }
}

/** Whether the viewer needs the full-resolution tier: 1:1 or beyond
 * means sensor pixels rather than the 2048px preview.
 *
 * This is the ONLY thing about zoom that changes what gets rendered.
 * Inside a tier the engine produces exactly the same image at every zoom
 * level, and the viewer scales that bitmap with a CSS transform, so a
 * render triggered by the zoom changing from 0.4 to 0.5 does a lot of
 * work to produce the frame already on screen. Renders therefore depend
 * on this boolean and not on the scale, which is why spinning the wheel
 * is free until it crosses 1:1. */
export function needsFullRes(state: State): boolean {
  return state.viewerZoom === "100" || state.view.zoomScale > 1.001;
}

/** Whether the settled preview wants a full-resolution pass after the
 * reduced frame lands: the preference says so, the hand is off, the
 * view is the plain one (at 1:1 the sharp slices already show the
 * photograph's pixels; compare and split draw two frames), and there
 * is an engine to ask. */
export function settleWanted(state: State): boolean {
  return (
    isTauri() &&
    state.prefs.settledPreview === "full" &&
    state.gesture === null &&
    // A held section look is a glance, not the photograph: no
    // whole-frame settle is spent on it, and none is kept for later.
    state.lookPreview === null &&
    !needsFullRes(state) &&
    !state.compare &&
    !state.splitOn
  );
}

/** Cancels a render the frontend named with a token (renderPreview's
 * cancelToken): the engine's stop flag trips between nodes and the
 * render returns "render canceled". A finished render ignores it. */
export async function cancelRender(token: string): Promise<void> {
  if (!isTauri()) return;
  try {
    await call("cancel_render", { token });
  } catch {
    // A cancel that cannot be delivered changes nothing: the render
    // finishes and its frame is judged stale by the pump as usual.
  }
}

export async function renderPreview(
  state: State,
  opts: { settle?: boolean; cancelToken?: string; lookSharp?: boolean } = {},
): Promise<RenderResult> {
  // Mask view: render the chosen mask node as black/white instead of
  // the developed image (active layer's, or a Color Set's); the depth
  // and halation views outrank it. previewTarget is the one selector.
  const maskNode = previewTarget(state);
  // A held section look rides in this request and in no other kind:
  // the graph the engine is sent carries the look, the state does not.
  const held = state.lookPreview !== null;
  if (isTauri()) {
    try {
      // The reduced tier on the interactive path: at 1:1 this frame is
      // the soft base under the sharp ROI patch. The settle pass (opts)
      // is the one whole-frame full-resolution render, asked for after
      // the reduced frame has landed and the hand is off.
      const raw = await invokeRender<ArrayBuffer>("render_preview", {
        graph: serializeGraph(lookPreviewState(state)),
        imageId: state.activeImage,
        maskNode,
        fullRes: opts.settle === true,
        gamutView: state.gamutView,
        // The one mask flavor: every mask view and the depth view
        // honor it; probes keep their own contract.
        maskOverlay: maskOverlayWanted(state),
        // The Overlay slider drives the red composite too, so the
        // wash on the brush and the tint on the frame read as one.
        maskOverlayOpacity: state.brushOverlayStrength ?? 0.5,
        maskOverlayColor: state.prefs.maskOverlayColor ?? "red",
        previewEdge: previewEdgeFor(state),
        gesturePreviewEdge: state.prefs.gesturePreviewEdge ?? 1024,
        // The settle's JPEG quality, the preference's step as a number;
        // the desktop reads it for the whole-frame settle alone.
        settleQuality: settleJpegQuality(state.prefs),
        // Mid-gesture (a stroke streaming, a slider dragging) the
        // frame renders from the half-size tier, so the engine's echo
        // keeps up with the hand; the release renders it properly.
        // A held look opens at the same tier, so it answers the press
        // at once; the pump follows with one ordinary frame of the
        // look while the press lasts (lookSharp).
        fast: opts.settle !== true && (state.gesture !== null || (held && opts.lookSharp !== true)),
        cancelToken: opts.cancelToken,
      });
      const { meta, bytes } = parsePreviewEnvelope(raw);
      logDebug(() => `envelope: ${meta.image_id} ${meta.mime} ${bytes.length}b ${meta.ms}ms ${meta.backend}${meta.roi ? ` roi=[${meta.roi.join(",")}]` : ""}`);
      return {
        // The settle keeps a slot of its own: the pump holds the last
        // settled frame to swap back in when the next settle would be
        // the same picture, and a reduced frame landing in the shared
        // slot would revoke it two frames later.
        url: frameUrl(opts.settle ? "settle" : "preview", meta, bytes),
        sourceIdentity: meta.memory_notice ? undefined : meta.source_identity,
        cssFilter: "none",
        ms: meta.ms,
        imageId: meta.image_id,
        backend: meta.backend,
        memoryNotice: meta.memory_notice,
      };
    } catch (e) {
      return { url: null, cssFilter: previewFilter(state), error: String(e) };
    }
  }
  return { url: null, cssFilter: previewFilter(state) };
}

/** Renders just the viewport's slice of the frame at full resolution:
 * the sharp patch the viewer lays over the upscaled fast tier at 1:1.
 * The rect is normalized to the final frame; the engine echoes the rect
 * it actually used plus the full frame dims it implies. In mask view the
 * slice is the active layer's MASK, sharp, so judging a feathered edge
 * at 1:1 shows mask pixels rather than a photo patch covering them.
 * Null in the browser mock and on any failure (the view stays soft,
 * nothing breaks). */
export async function renderRoi(
  state: State,
  rect: [number, number, number, number],
  cancelToken?: string,
): Promise<ViewState["roiPatch"] | null> {
  if (!isTauri()) return null;
  // The same view selector renderPreview uses: at 1:1 the sharp patch
  // must show the isolated view too, not the developed frame over it.
  const maskNode = previewTarget(state);
  try {
    const raw = await invokeRender<ArrayBuffer>("render_preview", {
      // A held look's slice is the look's (frameLook keys the patch).
      graph: serializeGraph(lookPreviewState(state)),
      imageId: state.activeImage,
      maskNode,
      fullRes: true,
      roi: rect,
      cancelToken,
      gamutView: state.gamutView,
      maskOverlay: maskOverlayWanted(state),
      // The same strength and color as the frame under it: the patch
      // went without them and the desktop's own defaults painted a
      // different tint at 1:1.
      maskOverlayOpacity: state.brushOverlayStrength ?? 0.5,
      maskOverlayColor: state.prefs.maskOverlayColor ?? "red",
    });
    const { meta, bytes } = parsePreviewEnvelope(raw);
    logDebug(() => `envelope: ${meta.image_id} ${meta.mime} ${bytes.length}b ${meta.ms}ms ${meta.backend}${meta.roi ? ` roi=[${meta.roi.join(",")}]` : ""}`);
    if (!meta.roi || !meta.frame) return null;
    return {
      url: frameUrl("roi", meta, bytes),
      rect: meta.roi,
      frame: meta.frame,
      imageId: meta.image_id,
      mask: maskNode,
      look: frameLook(state),
    };
  } catch {
    return null;
  }
}

/** A node's mask for the viewport's slice at full resolution, for the
 * marching ants at 1:1: the whole-frame mask the ants trace otherwise is
 * the preview's, and after Apply the selection has detail finer than
 * that (the full-resolution matte). Null in the browser mock and on any
 * failure (the ants keep the whole-frame trace). */
export async function renderMaskPatchOf(
  state: State,
  maskNode: string,
  rect: [number, number, number, number],
): Promise<{ url: string; rect: [number, number, number, number] } | null> {
  if (!isTauri()) return null;
  try {
    const raw = await invokeRender<ArrayBuffer>("render_preview", {
      graph: serializeGraph(state),
      imageId: state.activeImage,
      maskNode,
      fullRes: true,
      roi: rect,
    });
    const { meta, bytes } = parsePreviewEnvelope(raw);
    if (!meta.roi) return null;
    return { url: frameUrl("maskpatch", meta, bytes), rect: meta.roi };
  } catch {
    return null;
  }
}

/** Renders just the mask of a node, for the polish pass to show.
 *
 * The same call the "show mask" toggle makes, asked for a specific node
 * rather than the active layer's, because polish needs the mask AND the
 * photograph on screen together and the toggle replaces one with the
 * other.
 */
export async function renderMaskOf(state: State, maskNode: string): Promise<string | null> {
  if (!isTauri()) return null;
  try {
    const raw = await invokeRender<ArrayBuffer>("render_preview", {
      graph: serializeGraph(state),
      imageId: state.activeImage,
      maskNode,
      // Always the fast tier: full resolution without an ROI would be a
      // whole-sensor mask render, and this overlay never needs it.
      fullRes: false,
    });
    const { meta, bytes } = parsePreviewEnvelope(raw);
    logDebug(() => `envelope: ${meta.image_id} ${meta.mime} ${bytes.length}b ${meta.ms}ms ${meta.backend}${meta.roi ? ` roi=[${meta.roi.join(",")}]` : ""}`);
    return frameUrl("mask", meta, bytes);
  } catch (e) {
    // The overlay falls back to its geometry fill rather than taking
    // the viewer down, but the failure is named, not swallowed: silence
    // here once let the backend render the photograph as the "mask",
    // and nobody could see why the overlay looked wrong.
    const { logMsg } = await import("./log");
    logMsg("warn", `Selection overlay fell back to geometry: ${String(e)}`);
    return null;
  }
}

/** Params the engine declares as flags (the `flag(...)` entries in
 * heeler-graph's spec.rs). Every UI param is a number, so these have to
 * become real booleans on the way out or the registry rejects the whole
 * graph with a type mismatch and no preview renders at all.
 *
 * Lives in state.ts now (quad edit needs it to know a toggle from a
 * slider); re-exported here so every existing import keeps working. */
import { FLAG_PARAMS } from "./state";
export { FLAG_PARAMS };

/** The two halves a transform drag previews from: the photograph with
 * the layer taken out (the blend node disabled), and the layer's
 * unwarped content with its alpha. Neither depends on the quad (the
 * warp lives inside the blend, downstream of the content), so one pair
 * of renders at gesture start carries the whole drag, and the session
 * executor's cache makes each of them the cheap tail of a render.
 *
 * The layer rides the mask-node channel: it is the only path that
 * returns a single node's output, and it encodes PNG, which is the only
 * preview encoding that keeps the alpha a paint layer lives in. The
 * mask, when the layer has one, comes back the same way.
 *
 * Null when anything fails: the caller then leaves the drag on the old
 * per-mousemove engine path, and the failure is said out loud. */
export async function renderTransformSources(
  state: State,
  blendId: string,
  plan: { feed: string; maskNode: string | null },
): Promise<{ backdrop: string; layer: string; mask: string | null } | null> {
  if (!isTauri()) return null;
  try {
    const ask = async (graph: unknown, maskNode: string | null, slot: string, raw = false) => {
      const raw_ = await invokeRender<ArrayBuffer>("render_preview", {
        graph,
        imageId: state.activeImage,
        maskNode,
        fullRes: false,
        // The tier the pump's own frames render at, so the photograph's preview
        // and every File layer are the ones its cache already holds. Left out,
        // the desktop took 2048 whatever the stage was, and on a larger stage
        // the drag's first beat waited on a fresh decode of the photograph and
        // of a placed picture (2026-10-01: "transforming a picture copy layer is
        // fairly laggy").
        previewEdge: previewEdgeFor(state),
        gesturePreviewEdge: state.prefs.gesturePreviewEdge ?? 1024,
        // The layer and its mask are node outputs: display-referred
        // already, so a second sRGB encode would preview them brighter
        // than the engine's composite. The backdrop is the final frame
        // and keeps the normal encoding.
        rawEncode: raw,
      });
      const { meta, bytes } = parsePreviewEnvelope(raw_);
      return frameUrl(slot, meta, bytes);
    };
    // The blend sits inside the art group, so the disable walks down: a
    // top-level map would miss it and the "backdrop" would come back
    // with the layer still in it. A disabled blend passes its base
    // through, which is exactly the photograph-without-the-layer.
    const disable = (ns: State["nodes"]): State["nodes"] =>
      ns.map((n) =>
        n.id === blendId
          ? { ...n, enabled: false }
          : n.groupNodes
            ? { ...n, groupNodes: disable(n.groupNodes) }
            : n,
      );
    const backdropGraph = serializeEditorGraph(
      disable(state.nodes),
      state.wires,
      `${state.activeImage}_ui`,
    );
    const normal = serializeGraph(state);
    const [backdrop, layer, mask] = await Promise.all([
      ask(backdropGraph, null, "xform_back"),
      ask(normal, plan.feed, "xform_layer", true),
      plan.maskNode ? ask(normal, plan.maskNode, "xform_mask", true) : Promise.resolve(null),
    ]);
    return { backdrop, layer, mask };
  } catch (e) {
    const { logMsg } = await import("./log");
    logMsg("warn", `Transform preview fell back to engine renders: ${String(e)}`);
    return null;
  }
}

/** Serialize UI state to the backend graph JSON shape (heeler-graph). */
export function serializeGraph(state: State) {
  return serializeEditorGraph(state.nodes, state.wires, `${state.activeImage}_ui`, { renderedSource: renderedSource(state) });
}

/** The same conversion for a graph loaded back from its file.
 *
 * Saved graph files hold the EDITOR's shape (nodes with layout, wires), and
 * the engine's commands want the wire format this module produces. Handing
 * a loaded file to the engine raw fails deserialization before the command
 * even runs; that was every batch export of an edited, non-active photo.
 * The owner's console: `Export failed: P1551315.RW2: invalid args \`graph\`
 * for command \`export_to\`: missing field \`graph_id\`.`*/
export function serializeLoadedGraph(
  imageId: string,
  saved: { nodes: unknown[]; wires: unknown[] },
  source?: RenderedSource,
  catchup = false,
) {
  const nodes = saved.nodes as State["nodes"];
  const ready = catchup && needsRenderedBypass(source, { nodes })
    ? nodes.map(n => n.type === "heeler.tone_profile" ? { ...n, enabled: false } : n)
    : nodes;
  return serializeEditorGraph(
    ready,
    saved.wires as State["wires"],
    `${imageId}_ui`,
    { renderedSource: bornRendered(source) || isRenderedSource(source?.name ?? "") },
  );
}

/** The never-opened photo's graph in the wire shape: the neutral
 * default it would open with, under ITS OWN id. Falling back to the
 * live graph instead baked the open photo's edits (and its graph_id)
 * into a file that was never touched. */
export function serializeFreshGraph(state: State, imageId: string) {
  const g = freshGraphFor(state, imageId);
  return serializeEditorGraph(g.nodes, g.wires, `${imageId}_ui`, { renderedSource: renderedSource({ ...state, activeImage: imageId }) });
}

/** thumbnailGraphFor in the wire shape load_thumbnail takes, or null
 * when the photograph's thumbnail needs no graph from here. */
export function serializeThumbnailGraph(state: State, imageId: string, name?: string, source?: ImageEntry) {
  const g = thumbnailGraphFor(state, imageId, name, source);
  return g ? serializeEditorGraph(g.nodes, g.wires, `${imageId}_ui`, {
    renderedSource: renderedSource({ ...state, activeImage: imageId }) || bornRendered(source) || isRenderedSource(name ?? ""),
  }) : null;
}

function serializeEditorGraph(
  editorNodes: State["nodes"],
  editorWires: State["wires"],
  graphId: string,
  opts: { renderedSource?: boolean } = {},
) {
  // Groups are expanded here, not in the engine. "instead of
  // re-wiring in a bunch of individual nodes when a category is enabled, you
  // introduce a preset of nodes in a group. That way the input and output
  // connect on the chain only had to wire in the group."
  //
  // That is how it looks in the graph. What runs is the nodes that were
  // always inside it, wired the way they were always wired, because teaching
  // the executor about nesting buys nothing a flattened graph does not
  // already give. It also means a group cannot render differently from the
  // nodes it contains, which is the promise the abstraction makes.
  const flat = flattenGroups(groupMembersReadBelow(editorNodes), editorWires);
  const { nodes, wires } = finishAdjustmentGraph(flat.nodes, flat.wires);
  // The Finish group a ticked layer belongs to rides on its Export
  // Layer node as the `group` param (26.3 Phase 8), folded HERE, before
  // flattening erases the membership. The Finish tab only offers the
  // checkbox on top-level layers, so today this always folds ""; the
  // mechanism is what the desktop reads, and a group member gaining the
  // checkbox later changes nothing below this line.
  const finishGroupOf = new Map<string, string>();
  {
    const art = editorNodes.find((n) => n.id === ART_ID && n.isGroup);
    for (const content of art?.groupNodes ?? []) {
      if (!content.isGroup) continue;
      for (const m of artGroupMembers(content)) finishGroupOf.set(m.merge.id, content.name);
    }
  }
  // Keep the color alive: once the conversion has run there is no hue
  // left for a hue mask below it to select by. With the treatment on,
  // every hue-keyed mask downstream of the conversion takes its image
  // from the conversion's INPUT, by fan-out, in the serialized graph
  // only; the mask still applies at its own place in the chain. The
  // editor never shows the wire, the way it never shows Recolor's
  // by-mask wire: it is the treatment's meaning, not a thing the user
  // routes. Replaced, not added: the engine refuses a second wire into
  // an occupied port.
  const hueMaskFeed = hueMaskFeedBelowConversion(nodes, wires);
  // A film is one choice: the stock the Film section names on the Tone
  // Profile is the spectral sensitivity the conversion looks through,
  // copied onto the conversion here, in the serialized graph only.
  // Film is black and white (2026-09-14: "aren't all these film stocks
  // black and white only?"): a black and white film has no color
  // rendering to model, so its curve and its sensitivity apply only
  // under the treatment. With the treatment off the profile is sent
  // without them and renders its own way. Ownership by chain position
  // (review 2026-09-15, item 1): each active conversion's profile is
  // the nearest Tone Profile below it on the image chain, so two
  // conversions with two profiles each take their own stock; a
  // conversion with no profile below keeps the film it carries itself;
  // a profile that serves no active conversion is sent without its
  // stock.
  const conversions = nodes.filter(activeConversion);
  const profileOf = new Map(conversions.map((bw) => [bw.id, profileBelow(nodes, wires, bw.id)?.id ?? null]));
  const stockOf = (bw: NodeCard): string => {
    const profileId = profileOf.get(bw.id);
    const profile = profileId ? nodes.find((n) => n.id === profileId) : undefined;
    return profile ? (profile.textParams?.film ?? "") : (bw.textParams?.film ?? "");
  };
  const servedProfiles = new Set([...profileOf.values()].filter((id): id is string => id !== null));
  const profileDevelops = (profile: NodeCard): boolean =>
    servedProfiles.has(profile.id) && (profile.textParams?.film ?? "") !== "";
  // A rendered source (a JPEG, a bake) carries its profile bypassed,
  // and the film's characteristic curve lives on the profile, so a
  // stock chosen under the treatment did nothing to a JPEG (2026-09-15:
  // "no change when I switch Film between None and Rollei"). With a
  // stock on, the profile goes to the engine enabled and develops the
  // photograph through the stock's curve alone: no baseline lift and no
  // colorfulness, which are the RAW rendering's, and the film path
  // returns before the modes' toe and rolloff. Only on a rendered
  // source: a profile bypassed on a RAW is the user's own doing and
  // stays bypassed, the Film row saying so (review 2026-09-15, item 2).
  const developsRendered = (n: NodeCard): boolean => !!opts.renderedSource && profileDevelops(n);
  const placePad = placePads(nodes, wires);
  const clipPlace = clipPlacements(nodes, wires, placePad);
  return {
    schema_version: 1,
    graph_id: graphId,
    nodes: nodes.map((n) => ({
      id: n.id,
      type: n.type,
      label: n.name,
      enabled: n.enabled || (n.type === "heeler.tone_profile" && developsRendered(n)),
      params: {
        ...n.params,
        ...n.textParams,
        ...(n.type === "heeler.black_white" ? { film: activeConversion(n) ? stockOf(n) : "" } : {}),
        // Export Layer's name defaults to the card's label without its
        // " Export Layer" suffix, so renaming the card renames the
        // layer; a typed Name in the inspector wins (exportWrittenName).
        ...(n.type === "heeler.export_layer" ? { name: exportWrittenName(n) } : {}),
        // A Finish-sourced Export Layer records its layer's Finish
        // group, folded at serialization so the record can never go
        // stale. Top-level layers are in no group, so this is "" for
        // every node the checkbox can make today.
        ...(n.type === "heeler.export_layer" && (n.textParams?.source ?? "").startsWith("finish:")
          ? { group: finishGroupOf.get(n.textParams!.source!.slice("finish:".length)) ?? "" }
          : {}),
        ...(clipPlace.has(n.id) ? { clip_place: clipPlace.get(n.id)! } : {}),
        // The room an image layer's own warp gave its picture, so the
        // placement puts the margin outside the corners (placePads).
        ...(placePad.has(n.id) ? { place_pad: placePad.get(n.id)! } : {}),
        ...(n.type === "heeler.tone_profile" && !servedProfiles.has(n.id) ? { film: "", development: 0 } : {}),
        ...(n.type === "heeler.tone_profile" && developsRendered(n) && !n.enabled ? { baseline_ev: 0, colorfulness: 0 } : {}),
        // The parametric editors' interpolation face (Relight and
        // Recolor) rides to the engine as a plain param. Curves keeps
        // its own copy INSIDE the curve JSON below; sending this too
        // would be a second voice.
        ...(n.curveInterp && !n.curves ? { eq_interp: n.curveInterp } : {}),
        // Curves default to smooth; the engine treats a missing interp as
        // linear so older saved graphs render unchanged. Tangent mode
        // sends each channel's slopes as <ch>_m, and only when the
        // lengths agree: the engine falls back to monotone on a
        // mismatch, so a half-synced pair must never be sent as truth.
        ...(n.curves
          ? {
              points: JSON.stringify({
                ...n.curves,
                interp: n.curveInterp ?? "smooth",
                ...((n.curveInterp === "tangent" &&
                  Object.fromEntries(
                    Object.entries(n.curveTangents ?? {}).filter(
                      ([ch, m]) => m && n.curves?.[ch as keyof typeof n.curves]?.length === m.length,
                    ).map(([ch, m]) => [`${ch}_m`, m]),
                  )) ||
                  {}),
                // Tangent mode's HANDLE VECTORS ride beside the slopes
                // as <ch>_h, length-matched or not sent, same contract:
                // the engine prefers them (length matters there), falls
                // back to the slopes, then to monotone. `broken` is the
                // editor's own affair and stays home.
                ...((n.curveInterp === "tangent" &&
                  Object.fromEntries(
                    Object.entries(n.curveHandles ?? {}).filter(
                      ([ch, h]) => h && n.curves?.[ch as keyof typeof n.curves]?.length === h.length,
                    ).map(([ch, h]) => [
                      `${ch}_h`,
                      h!.map((v) => (v && (v.l || v.r) ? { ...(v.l ? { l: v.l } : {}), ...(v.r ? { r: v.r } : {}) } : null)),
                    ]),
                  )) ||
                  {}),
              }),
            }
          : {}),
        ...(n.strokes ? { strokes: JSON.stringify(n.strokes) } : {}),
        // Selection geometry travels as JSON, the same way strokes do.
        // Coordinates and numbers, never pixels: the engine rasterizes
        // it fresh at whatever size it is rendering. Off regions stay
        // home: the engine never learns a disabled region exists, which
        // is the whole meaning of disabling one.
        ...(n.regions ? { regions: JSON.stringify(n.regions.filter((r) => !r.off)) } : {}),
        ...Object.fromEntries(
          FLAG_PARAMS.filter((k) => n.params?.[k] !== undefined).map((k) => [k, n.params[k] !== 0])
        ),
      },
      x: n.x,
      y: n.y,
    })),
    connections: [
      ...wires.map((w) => ({
        // A pipe off Depth Map's depth diamond names its port (26.3
        // Phase 4); every other pipe leaves the node's "out".
        from: [hueMaskFeed.rewired.has(w.to) && w.toPort === "in" ? hueMaskFeed.feeds.get(w.to)! : w.from, w.fromPort ?? "out"],
        to: [w.to, w.toPort === "in2" ? "fg" : w.toPort],
      })),
      // Recolor's Mask row: the mask the node names in by_mask is wired to
      // its "by" port here, in the serialized graph only. The editor never
      // shows the wire, the way it never shows the ROI splice: it is the
      // param's meaning, not a thing the user routes.
      ...nodes
        .filter(
          (n) =>
            n.type === "heeler.recolor" &&
            (n.textParams?.by_mask ?? "") !== "" &&
            nodes.some((m) => m.id === n.textParams!.by_mask && m.type.endsWith("_mask")),
        )
        .map((n) => ({ from: [n.textParams!.by_mask, "out"], to: [n.id, "by"] })),
      // Recolor below an active conversion indexes hue by the color the
      // photograph had: the conversion's input on its "ref" port, in the
      // serialized graph only, the same rule the hue masks get.
      ...[...hueMaskFeed.refs].map((id) => ({ from: [hueMaskFeed.feeds.get(id)!, "out"], to: [id, "ref"] })),
    ],
  };
}

/** Finish blends in display space, while Develop adjustment operations
 * read scene light. Conversion pairs keep their controls and math the same.
 * They are derived for both live and saved graphs, without rewriting edits. */
export function finishAdjustmentGraph(input: NodeCard[], inputWires: State["wires"]) {
  let nodes = [...input], wires = [...inputWires];
  const taken = new Set(nodes.map(n => n.id));
  const fresh = (base: string) => {
    let id = base;
    for (let k = 1; taken.has(id); k++) id = `${base}_${k}`;
    taken.add(id);
    return id;
  };
  for (const n of input.filter(n => ART_KINDS[n.artKind ?? ""]?.adjust)) {
    // The carrier applies a correction without adding coverage. Effects
    // on the correction's chain still end at that same carrier.
    let tail = n.id;
    const seen = new Set<string>();
    while (!seen.has(tail)) {
      seen.add(tail);
      const hop = inputWires.find(w => w.from === tail && (w.toPort === "in2" || (w.toPort === "in" && !!input.find(m => m.id === w.to && isLayerEffect(m)))));
      if (!hop) break;
      const dest = nodes.find(m => m.id === hop.to);
      if (dest?.type === "heeler.blend") {
        nodes = nodes.map(m => m.id === dest.id ? { ...m, params: { ...m.params, adjustment: 1 } } : m);
        break;
      }
      tail = hop.to;
    }
    if (n.type === "heeler.invert") continue;
    const before = fresh(`__finish_scene_${n.id}`), after = fresh(`__finish_display_${n.id}`);
    const conversion = (id: string, type: string): NodeCard => ({ id, type, name: type === "heeler.to_scene" ? "To Scene" : "To Display", cat: "color", enabled: true, params: {}, x: n.x, y: n.y });
    nodes.push(conversion(before, "heeler.to_scene"), conversion(after, "heeler.to_display"));
    wires = wires.map(w => w.to === n.id && w.toPort === "in" ? { ...w, to: before } : w.from === n.id ? { ...w, from: after } : w);
    wires.push({ from: before, to: n.id, toPort: "in", kind: "image" }, { from: n.id, to: after, toPort: "in", kind: "image" });
  }
  // Grouping keeps clipping as a setting. Reconstruct a missing clip
  // wire within the group's isolated composite after flattening.
  for (const carrier of nodes.filter(n => n.type === "heeler.blend" && n.params.clip)) {
    if (wires.some(w => w.to === carrier.id && w.toPort === "clip")) continue;
    let below = wires.find(w => w.to === carrier.id && w.toPort === "in")?.from;
    const seen = new Set<string>();
    while (below && !seen.has(below)) {
      seen.add(below);
      const base = nodes.find(n => n.id === below && n.type === "heeler.blend");
      if (!base) break;
      if (!base.params.clip) {
        const top = wires.find(w => w.to === base.id && w.toPort === "in2")?.from;
        if (top) wires.push({ from: top, to: carrier.id, toPort: "clip", kind: "mask" });
        break;
      }
      below = wires.find(w => w.to === base.id && w.toPort === "in")?.from;
    }
  }
  // Place layer content on the photograph before an effect reads it.
  // A picture-sized effect otherwise ends at the imported file's edge,
  // and its pixel scale changes when the picture is resized.
  const pads = placePads(nodes, wires);
  for (const carrier of [...nodes].filter(n => n.type === "heeler.blend")) {
    let tail = wires.find(w => w.to === carrier.id && w.toPort === "in2")?.from;
    let first: string | undefined;
    while (tail && nodes.some(n => n.id === tail && isLayerEffect(n))) {
      first = tail;
      tail = wires.find(w => w.to === tail && w.toPort === "in")?.from;
    }
    if (!first || !tail || !nodes.some(n => n.id === first && !!ART_FX[n.artKind ?? ""])) continue;
    const below = wires.find(w => w.to === carrier.id && w.toPort === "in")?.from;
    if (!below) continue;
    const canvas = fresh(`__fx_canvas_${carrier.id}`), shape = fresh(`__fx_shape_${carrier.id}`);
    nodes.push({ ...carrier, id: canvas, type: "heeler.paint", name: "Effect canvas", artKind: undefined, params: {}, textParams: {}, enabled: true, strokes: [] });
    nodes.push({ ...carrier, id: shape, name: "Effect shape", artKind: undefined, enabled: true,
      params: { ...carrier.params, opacity: 100, adjustment: 0, ...(pads.has(carrier.id) ? { place_pad: pads.get(carrier.id)! } : {}) }, textParams: { ...carrier.textParams, mode: "normal" } });
    wires = wires.map(w => w.to === first && w.toPort === "in" ? { ...w, from: shape } : w);
    wires.push({ from: below, to: canvas, toPort: "in", kind: "image" }, { from: canvas, to: shape, toPort: "in", kind: "image" }, { from: tail, to: shape, toPort: "in2", kind: "image" });
    if (!carrier.params.adjustment) {
      for (const mask of wires.filter(w => w.to === carrier.id && w.toPort === "mask")) wires.push({ ...mask, to: shape });
    }
    nodes = nodes.map(n => n.id === carrier.id ? { ...n, params: { ...n.params, content_placed: 1, mask_baked: carrier.params.adjustment ? 0 : 1 } } : n);
    // Export the same effected pixels the composite uses.
    const effected = wires.find(w => w.to === carrier.id && w.toPort === "in2")!.from;
    wires = wires.map(w => nodes.some(n => n.id === w.to && n.type === "heeler.export_layer" && n.textParams?.source === `finish:${carrier.id}`) ? { ...w, from: effected } : w);
  }
  // A clipped correction must change the base layer's own pixels, not
  // the photograph visible through them. Keep that layer's contribution
  // in a separate branch, then add only its color change to the stack.
  const contributions = new Map<string, string>();
  const resolving = new Set<string>();
  const contribution = (id: string): string | undefined => {
    if (contributions.has(id)) return contributions.get(id);
    if (resolving.has(id)) return;
    resolving.add(id);
    const carrier = nodes.find(n => n.id === id && n.type === "heeler.blend");
    const below = wires.find(w => w.to === id && w.toPort === "in")?.from;
    const top = wires.find(w => w.to === id && w.toPort === "in2")?.from;
    if (!carrier || !below || !top) return;
    if (carrier.params.adjustment && carrier.params.clip) {
      const reference = contribution(below);
      if (!reference) return;
      // Follow the corrected top through its effects and conversion.
      let input = top;
      const seen = new Set<string>();
      while (!seen.has(input)) {
        seen.add(input);
        const n = nodes.find(n => n.id === input);
        if (ART_KINDS[n?.artKind ?? ""]?.adjust) break;
        const w = wires.find(w => w.to === input && w.toPort === "in");
        if (!w) break;
        input = w.from;
      }
      const decode = wires.find(w => w.to === input && w.toPort === "in")?.from;
      const target = nodes.some(n => n.id === decode && n.type === "heeler.to_scene") ? decode! : input;
      wires = wires.map(w => w.to === target && w.toPort === "in" ? { ...w, from: reference } : w);
      wires = wires.filter(w => !(w.to === id && w.toPort === "clip"));
      wires.push({ from: reference, to: id, toPort: "clip", kind: "mask" });
      nodes = nodes.map(n => n.id === id ? { ...n, params: { ...n.params, adjustment_delta: 1 } } : n);
      const result = fresh(`__clip_result_${id}`);
      nodes.push({ ...carrier, id: result, artKind: undefined, params: { ...carrier.params, clip: 0, adjustment_delta: 0 } });
      wires.push({ from: reference, to: result, toPort: "in", kind: "image" }, { from: top, to: result, toPort: "in2", kind: "image" });
      for (const w of wires.filter(w => w.to === id && w.toPort === "mask")) wires.push({ ...w, to: result });
      contributions.set(id, result);
      return result;
    }
    const canvas = fresh(`__clip_canvas_${id}`), result = fresh(`__clip_source_${id}`);
    nodes.push({ ...carrier, id: canvas, type: "heeler.paint", name: "Clip canvas", artKind: undefined, enabled: true, params: {}, textParams: {}, strokes: [] });
    nodes.push({ ...carrier, id: result, name: "Clip source", artKind: undefined, textParams: { ...carrier.textParams, mode: "normal" }, params: { ...carrier.params, ...(pads.has(id) ? { place_pad: pads.get(id)! } : {}) } });
    wires.push({ from: below, to: canvas, toPort: "in", kind: "image" }, { from: canvas, to: result, toPort: "in", kind: "image" }, { from: top, to: result, toPort: "in2", kind: "image" });
    for (const w of wires.filter(w => w.to === id && ["mask", "clip"].includes(w.toPort))) wires.push({ ...w, to: result });
    contributions.set(id, result);
    return result;
  };
  for (const n of [...nodes].filter(n => n.type === "heeler.blend" && n.params.adjustment && n.params.clip)) contribution(n.id);
  return { nodes, wires };
}

/** Where each clipped Finish layer's base puts its picture (Finish image
 * layers, 2026-09-30). A clipping mask is a wire from the base layer's
 * content (or its last effect) to the clipped blend's clip port, so it
 * carries the base's picture before the base's own blend placed or
 * moved it. The base's fit and transform ride to the clipped blend as
 * `clip_place`, in the serialized graph only, so the clip is the base
 * where the composite shows it. Nothing for a base that is neither
 * placed nor transformed. */
function clipPlacements(nodes: NodeCard[], wires: State["wires"], pads: Map<string, number> = new Map()): Map<string, string> {
  const out = new Map<string, string>();
  for (const w of wires) {
    if (w.toPort !== "clip") continue;
    const feed = wires.find(
      (x) => x.from === w.from && x.toPort === "in2" && nodes.some((n) => n.id === x.to && n.type === "heeler.blend"),
    );
    const base = feed ? nodes.find((n) => n.id === feed.to) : undefined;
    if (!base || base.params.content_placed) continue;
    const p = base.params;
    const fit = String(base.textParams?.fit ?? p.fit ?? "stretch");
    const boxed = (p.warp_bw ?? 0) > 0 && (p.warp_bh ?? 0) > 0;
    if (!boxed && fit !== "place") continue;
    const bx = p.warp_bx ?? 0;
    const by = p.warp_by ?? 0;
    const bw = boxed ? p.warp_bw : 1;
    const bh = boxed ? p.warp_bh : 1;
    const rest: [number, number][] = [[bx, by], [bx + bw, by], [bx + bw, by + bh], [bx, by + bh]];
    const corners = rest.flatMap(([cx, cy], i) => [p[`warp_x${i}`] ?? cx, p[`warp_y${i}`] ?? cy]);
    // The frame shape a placed base was written on rides along as a
    // thirteenth number, so the clip follows the frame-shape rule the
    // base's own blend follows (ops::placement_on_frame).
    const stamp = (p.warp_aspect ?? 0) > 0 ? [p.warp_aspect] : [];
    // And a base whose own warp padded its picture carries that room as
    // a fourteenth, after the stamp or a zero standing for none, so the
    // clip is the warped picture where the base shows it.
    const pad = pads.get(base.id) ?? 0;
    const tail = pad > 0 ? [p.warp_aspect ?? 0, pad] : stamp;
    out.set(w.to, `${fit};${[bx, by, bw, bh, ...corners, ...tail].join(",")}`);
  }
  return out;
}

/** The room each placed Finish image layer's own warp gives its picture
 * (2026-09-30: "build both, A for image layers and B for the photo").
 * The warp (heeler.layer_warp in the picture's space) runs first on
 * the layer's effect chain and hands the picture over with `room`
 * percent of transparent margin on every side; the blend must know, or
 * it squeezes the margin onto its corners. Folded onto the blend as
 * `place_pad` in the serialized graph only, and only while the warp is
 * switched on: a switched-off node passes the bare picture through,
 * which must meet no room.*/
export function placePads(nodes: NodeCard[], wires: State["wires"]): Map<string, number> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out = new Map<string, number>();
  for (const blend of nodes) {
    if (blend.type !== "heeler.blend") continue;
    if (String(blend.textParams?.fit ?? blend.params.fit ?? "") !== "place") continue;
    const seen = new Set<string>();
    let cur = wires.find((w) => w.to === blend.id && w.toPort === "in2")?.from;
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      const n = byId.get(cur);
      if (!n) break;
      if (isPictureWarp(n)) {
        const room = n.params.room ?? 25;
        if (n.enabled && room > 0) out.set(blend.id, room);
        break;
      }
      if (!isLayerEffect(n)) break;
      const at = cur;
      cur = wires.find((w) => w.to === at && w.toPort === "in")?.from;
    }
  }
  return out;
}

/** A conversion the treatment is on for: present, not bypassed, with
 * a strength. */
function activeConversion(n: NodeCard): boolean {
  return n.type === "heeler.black_white" && n.enabled && (n.params.amount ?? 0) > 0;
}

/** The main chain's active conversion, for Develop's stand-ins: the
 * one the treatment block addresses (mainConversion), if it is on. */
function nodes_active_conversion(state: State): State["nodes"][number] | null {
  const main = mainConversion(state.nodes);
  return main && activeConversion(main) ? main : null;
}

/** The image feed into a node's "in" port. */
function feedInto(wires: State["wires"], id: string): string | null {
  return wires.find((w) => w.to === id && w.toPort === "in" && w.kind !== "mask")?.from ?? null;
}

/** The nearest node above `id` on the image chain (following "in"
 * feeds) that `pred` accepts, or null. */
function nearestAbove(nodes: State["nodes"], wires: State["wires"], id: string, pred: (n: NodeCard) => boolean): NodeCard | null {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const seen = new Set<string>();
  let cur = feedInto(wires, id);
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const n = byId.get(cur);
    if (n && pred(n)) return n;
    cur = feedInto(wires, cur);
  }
  return null;
}

/** The nearest node below `id` on the image chain (following the wire
 * out of it into the next node's "in" port) that `pred` accepts. */
function nearestBelow(nodes: State["nodes"], wires: State["wires"], id: string, pred: (n: NodeCard) => boolean): NodeCard | null {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const seen = new Set<string>();
  let cur: string | null = wires.find((w) => w.from === id && w.toPort === "in" && w.kind !== "mask")?.to ?? null;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const n = byId.get(cur);
    if (n && pred(n)) return n;
    const next: string | null = wires.find((w) => w.from === cur && w.toPort === "in" && w.kind !== "mask")?.to ?? null;
    cur = next;
  }
  return null;
}

/** The active conversion nearest above a node on its image chain. */
export function conversionAbove(nodes: State["nodes"], wires: State["wires"], id: string): NodeCard | null {
  return nearestAbove(nodes, wires, id, activeConversion);
}

/** The Tone Profile nearest below a conversion on its image chain: the
 * one its film's curve develops on. */
export function profileBelow(nodes: State["nodes"], wires: State["wires"], id: string): NodeCard | null {
  return nearestBelow(nodes, wires, id, (n) => n.type === "heeler.tone_profile");
}

/** The masks that key on hue. A range mask keys on luma too and reads
 * the mono picture for that, so it stays where it is. */
const HUE_MASK_TYPES = new Set(["heeler.hue_range_mask", "heeler.color_range_mask"]);

/** The hue-keyed masks downstream of an active black and white
 * conversion, and the node feeding the conversion that they should
 * read instead. Empty when the treatment is off, the conversion
 * has no feed, or nothing hue-keyed sits below it. Exported for the
 * serializer's tests.*/
export function hueMaskFeedBelowConversion(
  nodes: State["nodes"],
  wires: State["wires"],
): { feeds: Map<string, string>; rewired: Set<string>; refs: Set<string> } {
  // Per node, the input of the nearest active conversion above it on
  // its image chain (review 2026-09-15, item 1): two conversions in
  // two branches each feed their own masks, and a node below two
  // conversions in a row reads the nearer one's input.
  const feeds = new Map<string, string>();
  const rewired = new Set<string>();
  const refs = new Set<string>();
  for (const n of nodes) {
    const keyed = HUE_MASK_TYPES.has(n.type) || n.type === "heeler.recolor";
    if (!keyed) continue;
    const bw = conversionAbove(nodes, wires, n.id);
    const feed = bw ? feedInto(wires, bw.id) : null;
    if (!feed) continue;
    feeds.set(n.id, feed);
    if (HUE_MASK_TYPES.has(n.type)) rewired.add(n.id);
    else refs.add(n.id);
  }
  return { feeds, rewired, refs };
}

/** The node whose color a hue-keyed editor should read for its
 * histogram and its picker: below an active black and white conversion
 * that is the conversion's input, the color the photograph had; else
 * the node's own feed. Null when the node is unfed. */
export function hueSourceNodeFor(state: State, nodeId: string): string | null {
  const own = state.wires.find((w) => w.to === nodeId && w.toPort === "in" && w.kind !== "mask")?.from ?? null;
  const rule = hueMaskFeedBelowConversion(state.nodes, state.wires);
  const ruled = rule.feeds.get(nodeId);
  if (ruled) return ruled;
  if (own) return own;
  // A section whose node is not in the graph yet (the panel draws a
  // stand-in until the first write) still shows its histogram: under an
  // active treatment it reads what the conversion reads, the same as it
  // will once built (2026-09-14: the two histograms read two pictures);
  // otherwise the node that would feed it, which is spliceIn's own
  // choice, the wire into the next present chain node.
  const bw = nodes_active_conversion(state);
  const conversionFeed = bw && (state.wires.find((w) => w.to === bw.id && w.toPort === "in" && w.kind !== "mask")?.from ?? null);
  if (conversionFeed && CHAIN_ORDER.indexOf(nodeId) > CHAIN_ORDER.indexOf("bw")) return conversionFeed;
  const at = CHAIN_ORDER.indexOf(nodeId);
  if (at < 0) return null;
  const have = new Set(state.wires.flatMap((w) => [w.from, w.to]));
  const next = CHAIN_ORDER.slice(at + 1).find((c) => have.has(c));
  return (next && state.wires.find((w) => w.to === next && w.kind !== "mask")?.from) ?? null;
}

/** Outcome of a trash move or a Put Back. Partial results are reported
 * rather than rolled back: whatever moved is in a folder the user can
 * see, and `failed` says which ones stayed and why. */
export interface TrashReport {
  moved: number;
  /** The ids that actually moved: a count cannot say WHICH rename
   * failed, and the UI must not drop rows for photographs that are
   * still sitting in their folder. */
  moved_ids: string[];
  failed: string[];
}

export interface TrashSummary {
  count: number;
  bytes: number;
}

/** Points a photograph at the file it moved to, sweeping up the others
 * that moved with it. Nobody moves one photograph. */
export async function relinkImage(imageId: string, newPath: string): Promise<RelinkReport> {
  if (!isTauri()) return { relinked: 1, stillMissing: 0 };
  const r = await call<{ relinked: number; still_missing: number }>("relink_image", {
    imageId,
    newPath,
  });
  return { relinked: r.relinked, stillMissing: r.still_missing };
}

export interface RelinkReport {
  relinked: number;
  stillMissing: number;
}

/** Asks the user where a missing photograph went. */
export async function pickRelinkTarget(imageId: string): Promise<string | null> {
  if (!isTauri()) return null;
  return call<string | null>("pick_relink_target", { imageId });
}

/** Folder-level relink for a multi-selection: each missing photograph
 * among the ids is found by name under the root, subfolders included. */
export async function relinkFolder(imageIds: string[], root: string): Promise<RelinkReport> {
  if (!isTauri()) return { relinked: imageIds.length, stillMissing: 0 };
  const r = await call<{ relinked: number; still_missing: number }>("relink_folder", {
    imageIds,
    root,
  });
  return { relinked: r.relinked, stillMissing: r.still_missing };
}

/** Asks the user for the folder a moved batch now lives under. */
export async function pickRelinkFolder(): Promise<string | null> {
  if (!isTauri()) return null;
  return call<string | null>("pick_relink_folder");
}

/** Every photograph in the library whose file is not there. */
export async function missingImages(): Promise<FolderImage[]> {
  if (!isTauri()) return [];
  return (await call("missing_images")) as FolderImage[];
}
