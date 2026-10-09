// Export: filename templates, presets, and running a batch.
//
// The loop lives here rather than in Rust on purpose. A batch is a loop
// over one render, and keeping it in the frontend means the progress bar
// reflects real files landing one by one, the run can be stopped between
// images, and the naming rules are ordinary functions that can be tested
// without a running app.

import type { ExportSettings, ImageEntry, State } from "./state";
import { exportTo, loadGraph, pickExportFolder, serializeFreshGraph, serializeGraph, serializeLoadedGraph } from "./bridge";
import { logDebug, logMsg } from "./log";

// The settings shape lives in state.ts now, beside the batch-group
// queue that stores one per tab; re-exported so nothing downstream
// has to know it moved.
export type { ExportSettings } from "./state";

export interface ExportPreset extends ExportSettings {
  id: string;
  name: string;
}

// The original's own name, nothing appended. On the branded suffix
// this shipped with: "I sincerely doubt that anyone wants that."
export const DEFAULT_TEMPLATE = "{name}";

/** The extension each format writes. png16 shares .png with its 8-bit
 * sibling: it IS a PNG, just one with sixteen bits per channel, and the
 * format string breaks the tie where the extension cannot. */
const FORMAT_EXT: Record<ExportSettings["format"], string> = {
  jpeg: "jpg",
  webp: "webp",
  png: "png",
  png16: "png",
  tiff: "tif",
  tiff32: "tif",
  dng: "dng",
  exr: "exr",
};

/** Presets everyone ends up making anyway. Offered rather than imposed:
 * they are ordinary presets and can be renamed or deleted. */
export const STARTER_PRESETS: ExportPreset[] = [
  { id: "web", name: "Web JPEG 2048", format: "jpeg", quality: 85, maxEdge: 2048, template: DEFAULT_TEMPLATE, keepMetadata: true },
  { id: "full", name: "Full quality JPEG", format: "jpeg", quality: 100, maxEdge: null, template: DEFAULT_TEMPLATE, keepMetadata: true },
  { id: "print", name: "PNG, full size", format: "png", quality: 100, maxEdge: null, template: DEFAULT_TEMPLATE, keepMetadata: true },
  { id: "archive", name: "Archive TIFF 16-bit", format: "tiff", quality: 100, maxEdge: null, template: DEFAULT_TEMPLATE, keepMetadata: true },
];

/** Characters no filesystem worth supporting will accept. Spaces and
 * hyphens are not among them, however much they look like they should
 * be: "beach walk-2.jpg" is a perfectly good filename, and mangling it
 * would be the tool being precious. */
const ILLEGAL = new Set([
  "<", ">", ":", '"', "/", "|", "?", "*",
  // The backslash is spelled out rather than escaped: it has been
  // eaten by an escaping layer once already, and a sanitizer that
  // quietly stops stripping the path separator is worse than none.
  String.fromCharCode(92),
]);

/** Strips a filename down to something every platform will take.
 *
 * Windows is the strict one: it refuses the reserved device names
 * whatever the extension, and it silently drops trailing dots and
 * spaces, which turns two distinct exports into one file that
 * overwrites itself. */
export function sanitizeFilename(name: string): string {
  let out = [...name]
    .map((ch) => (ILLEGAL.has(ch) || ch.charCodeAt(0) < 0x20 ? "_" : ch))
    .join("")
    .replace(/[. ]+$/, "");
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(out)) out = `_${out}`;
  return out.slice(0, 120) || "untitled";
}

/** Fills a filename template for one image.
 *
 * `{name}` is the original filename without its extension, which is what
 * people actually want to keep. `{n}` is the position in the batch,
 * padded so a folder of exports sorts the way it was shot. Unknown
 * tokens are left alone rather than silently deleted, so a typo shows up
 * in the preview instead of producing a wrong name quietly. */
export function fillTemplate(
  template: string,
  img: ImageEntry,
  index: number,
  total: number
): string {
  const stem = img.name.replace(/\.[^.]+$/, "");
  const width = String(total).length;
  const values: Record<string, string> = {
    name: stem,
    n: String(index + 1).padStart(width, "0"),
    stars: String(img.stars),
    flag: img.flag || "none",
  };
  const filled = template.replace(/\{(\w+)\}/g, (whole, key: string) =>
    key in values ? values[key] : whole
  );
  return sanitizeFilename(filled);
}

/** The full destination for one image, extension included.
 *
 * With `taken`, a name the run already used grows a -2, -3 suffix
 * instead of overwriting. The {name} template uses the filename stem,
 * and a RAW+JPEG pair shares one stem: six files filled to four names
 * and the batch quietly wrote four files. "two batches
 * that have the same 6 files but only 4 files are exporting." A
 * warning existed; a warning is not a fix.*/
export function destinationFor(
  dir: string,
  settings: ExportSettings,
  img: ImageEntry,
  index: number,
  total: number,
  taken?: Set<string>
): string {
  const ext = FORMAT_EXT[settings.format];
  const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  const trimmed = dir.replace(/[\\/]+$/, "");
  let name = fillTemplate(settings.template, img, index, total);
  if (taken) {
    const base = name;
    let k = 2;
    while (taken.has(name.toLowerCase())) name = `${base}-${k++}`;
    taken.add(name.toLowerCase());
  }
  return `${trimmed}${sep}${name}.${ext}`;
}

/** Names that would collide once the template is filled.
 *
 * A template without {n} over a folder shot on two cameras will produce
 * duplicates. Nothing is lost when it happens -- destinationFor's taken
 * set suffixes the extras -2, -3, and the engine bumps again for a name
 * already on disk -- but the run then writes files under names nobody
 * chose, which is worth saying before it starts rather than after.
 *
 * It used to say the second export overwrote the first. That was true
 * when it was written and stopped being true when the suffixes arrived,
 * which is the same staleness the panel's own warning carried. */
export function collisions(
  settings: ExportSettings,
  images: ImageEntry[]
): string[] {
  const seen = new Map<string, number>();
  for (let i = 0; i < images.length; i++) {
    const name = fillTemplate(settings.template, images[i], i, images.length);
    seen.set(name, (seen.get(name) ?? 0) + 1);
  }
  return [...seen.entries()].filter(([, n]) => n > 1).map(([name]) => name);
}

/** Which images an export run covers. */
export function exportTargets(state: State): ImageEntry[] {
  const byId = new Map(state.images.map((i) => [i.id, i]));
  if (state.imageSelection.length > 1) {
    return state.imageSelection.map((id) => byId.get(id)).filter((i): i is ImageEntry => !!i);
  }
  const active = byId.get(state.activeImage);
  return active ? [active] : [];
}

export interface BatchProgress {
  done: number;
  total: number;
  /** the file being written, by the name it lands under */
  current: string;
}

/** The file name at the end of a destination, whichever separator the
 * folder came with. */
export function destinationName(dest: string): string {
  return dest.slice(Math.max(dest.lastIndexOf("/"), dest.lastIndexOf("\\")) + 1);
}

export interface BatchResult {
  written: string[];
  failed: { name: string; error: string }[];
}

/** Runs the batch, one image at a time.
 *
 * Each image is exported through its own saved graph, not the one on
 * screen: exporting twenty photographs with the twenty-first photograph's
 * edits would be worse than useless. The active image uses the live
 * graph, which may be newer than what has been written to disk.
 *
 * One failure does not stop the run. A folder of two hundred exports
 * that gives up on the ninety-first because one file is unreadable is
 * more annoying than one that finishes and tells you which ones missed.
 */
/** Quick Export: the selection (or the active photo) straight to a
 * folder, no queue involved. "how do I quick export a
 * selecting image without having to add it to a queue?" Settings come
 * from the active batch tab, so the panel's format/size/template
 * choices apply; the destination is asked every time, because quick
 * is an errand, not a pipeline. Reports through the log either way.*/
/** Every failure into the console with its reason. The summary line
 * names the files; a name alone cannot be acted on. The owner,
 * staring at "Exported 3, 3 failed": the WHY has to be on screen.*/
export function logExportFailures(failed: BatchResult["failed"]): void {
  for (const f of failed) logMsg("warn", `Export failed: ${f.name}: ${f.error}`);
}

export async function quickExport(state: State): Promise<void> {
  const selected = exportTargets(state);
  if (selected.length === 0) {
    logMsg("warn", "Quick Export: nothing selected");
    return;
  }
  const targets = selected;
  const dir = await pickExportFolder();
  if (!dir) return; // canceled
  const settings = state.exportQueue.groups[state.exportQueue.active].settings;
  const result = await runExport(state, targets, dir, settings, () => {});
  const failed = result.failed.length;
  logExportFailures(result.failed);
  logMsg(
    failed === 0 ? "info" : "warn",
    failed === 0
      ? `Exported ${result.written.length} image${result.written.length === 1 ? "" : "s"} to ${dir}`
      : `Exported ${result.written.length}, ${failed} failed: ${result.failed.map((f) => f.name).join(", ")}`,
  );
}

export async function runExport(
  state: State,
  images: ImageEntry[],
  dir: string,
  settings: ExportSettings,
  onProgress: (p: BatchProgress) => void,
  shouldStop: () => boolean = () => false
): Promise<BatchResult> {
  const result: BatchResult = { written: [], failed: [] };
  const liveGraph = serializeGraph(state);
  // One run, one namespace: colliding names disambiguate instead of
  // overwriting each other.
  const taken = new Set<string>();
  const batchT0 = performance.now();
  logDebug(() => `export batch: ${images.length} images to ${dir}`);
  let attempted = 0;
  for (let i = 0; i < images.length; i++) {
    if (shouldStop()) {
      logDebug(() => `export batch: stopped early at ${i}/${images.length}`);
      break;
    }
    const img = images[i];
    attempted = i + 1;
    // The progress line names the file being WRITTEN. It named the
    // original, so a JPEG going out as an EXR read "photo.jpg" the
    // whole render (the owner,: "reads the file I am export with a JPG
    // extension (tho it still exports as an EXR)").
    const dest = destinationFor(dir, settings, img, i, images.length, taken);
    onProgress({ done: i, total: images.length, current: destinationName(dest) });
    try {
      // A saved graph is the editor's shape and must be serialized the
      // same way the live one is; raw, the engine rejects it unread.
      // A photo that was never opened has no saved graph, and the live
      // one is no stand-in: it is the OPEN photo's edits, under the open
      // photo's graph_id. The never-opened photo exports through the
      // neutral default it would open with.
      const isActive = img.id === state.activeImage;
      const saved = isActive ? null : await loadGraph(img.id);
      const graph = saved
        ? serializeLoadedGraph(img.id, saved, img, true)
        : isActive
          ? liveGraph
          : serializeFreshGraph(state, img.id);
      // Which edits this file carries: the "exported with the wrong
      // edits" class is decided by this branch, and the suffix line below
      // is the owner's "6 files, only 4 exported" bug made visible.
      logDebug(
        () =>
          `export: ${img.name} using ${saved ? "saved" : isActive ? "live" : "fresh"} graph -> ${dest}`,
      );
      const written = await exportTo(graph, img.id, dest, settings);
      if (written) result.written.push(written);
    } catch (e) {
      result.failed.push({ name: img.name, error: String(e) });
    }
  }
  onProgress({ done: attempted, total: images.length, current: "" });
  logDebug(
    () =>
      `export batch: ${result.written.length} written, ${result.failed.length} failed in ${Math.round(performance.now() - batchT0)}ms`,
  );
  return result;
}
