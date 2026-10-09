// The frontend half of the scripting bridge.
//
// The Rust server forwards stateful methods here, because the command
// bus lives here: dispatching through the same reducers the UI uses is
// what makes the API a remote hand rather than a second writer. The
// popped-out graph window pioneered this shape (commands over a channel
// into the main reducer); scripts are the same kind of guest.
//
// Two entry points: handleApi answers synchronously from the live
// state, handleApiAsync adds the methods whose honest answer takes
// awaits (an export run, a merge, opening a folder). The app door's
// listener awaits handleApiAsync; tests call both without a transport.

import type { Command, ExportSettings, ImageEntry, State } from "./state";
import { DEFAULT_EXPORT_SETTINGS, exportDpi, freshGraphFor } from "./state";
import {
  bakeComposite,
  loadGraph,
  createPano,
  createStack,
  openFolder,
  panoInfo,
  serializeGraph,
  stackInfo,
  updatePano,
  updateStack,
} from "./bridge";
import { exportTargets, runExport } from "./export";
import { exportHotkeys, importHotkeys } from "./hotkeys";
import { applyFolderListing, refreshLibrary, thumbnailForNew } from "./ui/chrome";
import manifest from "./api-methods.json";

/** The bridge's method list, shared with the batch door through
 * api-methods.json so the two cannot silently diverge: each side's
 * parity test walks the same file. */
export const API_METHODS: string[] = manifest.methods;
/** Methods the Rust server answers natively; the app door never sees them. */
export const API_NATIVE = new Set<string>(manifest.native);
/** Methods only the batch door answers. */
export const API_BATCH_ONLY = new Set<string>(manifest.batch_only);

/** The commands a script may dispatch.
 *
 * A whitelist rather than the whole union, because the union includes
 * view state (pan, zoom, dialogs) that a script has no business
 * driving, and every entry here is a contract we keep. Growing the list
 * is one line; shrinking it later is a break.
 */
export const API_COMMANDS = new Set<Command["type"]>([
  // Graph
  "set_param",
  "set_params",
  "set_curve",
  "set_text_param",
  "connect",
  "disconnect",
  "splice_node_into_wire",
  "extract_node",
  "delete_nodes",
  "set_enabled",
  "rename_node",
  "node_outside",
  "set_node_tint",
  "set_node_note",
  "select_nodes",
  "group_selection",
  // Selections
  "add_region",
  "clear_regions",
  "set_regions",
  // Catalog
  "set_rating",
  "set_flag",
  // Session
  "select_image",
  // Takes: branch, rename, switch, delete. Not undoable by design:
  // history is per-take, so these manage the takes themselves.
  "new_take",
  "update_take",
  "set_take_rating",
  "switch_take",
  "delete_take",
  // Settings: preferences ride the same reducer the panel uses.
  "set_prefs",
  // Session mode (simple / advanced / canvas). View state like pan and
  // zoom stays out; the mode is session state the reducers own.
  "set_mode",
  // Undo batching: a script wraps a loop in one gesture so the whole
  // run is one undo step, the same coalescing a slider drag gets.
  "begin_gesture",
  "end_gesture",
]);

/** The formats export.run accepts, spelled out so a refusal can name them. */
const EXPORT_FORMATS: ExportSettings["format"][] = ["jpeg", "webp", "png", "png16", "tiff", "tiff32", "dng", "exr"];

export interface ApiReply {
  data?: unknown;
  error?: string;
}

/** One request, answered against the live state.
 *
 * Pure-ish on purpose: state in, commands out through dispatch, JSON
 * back. Tested directly, without the transport.
 */
export function handleApi(
  state: State,
  dispatch: (c: Command) => void,
  method: string,
  params: unknown,
): ApiReply {
  const p = (params ?? {}) as Record<string, unknown>;
  switch (method) {
    case "app.state": {
      const image = state.images.find((i) => i.id === state.activeImage);
      return {
        data: {
          imageId: state.activeImage,
          imageName: image?.name ?? null,
          mode: state.mode,
          tool: state.tool,
        },
      };
    }
    case "graph.get":
      return {
        data: {
          nodes: state.nodes.map((n) => ({
            id: n.id,
            type: n.type,
            name: n.name,
            cat: n.cat,
            enabled: n.enabled,
            params: n.params,
            textParams: n.textParams ?? {},
            tint: n.tint ?? null,
            note: n.note ?? null,
            x: n.x,
            y: n.y,
            isGroup: !!n.isGroup,
          })),
          wires: state.wires,
          selection: state.selection,
        },
      };
    case "graph.serialize":
      return { data: { graph: serializeGraph(state), imageId: state.activeImage } };
    case "graph.command": {
      const cmd = p.command as Command | undefined;
      if (!cmd || typeof cmd !== "object" || typeof cmd.type !== "string") {
        return { error: "graph.command needs { command: { type, ... } }" };
      }
      if (!API_COMMANDS.has(cmd.type)) {
        return { error: `command "${cmd.type}" is not scriptable` };
      }
      dispatch(cmd);
      return { data: { dispatched: cmd.type } };
    }
    case "graph.save":
      // The app persists continuously, so there is nothing to do; the
      // method answers so a script written for batch mode runs
      // unchanged against the app door.
      return { data: { saved: state.activeImage, automatic: true } };
    case "catalog.images":
      return {
        data: state.images.map((i) => ({
          id: i.id,
          name: i.name,
          stars: i.stars,
          flag: i.flag,
          edited: i.edited,
        })),
      };
    case "catalog.collections":
      return {
        data: state.collections.map((c) => ({
          id: c.id,
          name: c.name,
          count: c.count,
          hasLook: c.hasLook,
        })),
      };
    case "takes.list": {
      const img = state.activeImage;
      // An image never branched has one implicit take: the edit itself.
      const list = state.takes[img] ?? [
        { id: "take_1", name: "Take 1", nodes: state.nodes, wires: state.wires },
      ];
      return {
        data: {
          imageId: img,
          active: state.activeTakes[img] ?? "take_1",
          takes: list.map((t) => ({ id: t.id, name: t.name, note: t.note ?? null, rating: t.rating ?? 0 })),
        },
      };
    }
    case "prefs.get":
      return { data: state.prefs };
    case "hotkeys.export":
      return { data: { json: exportHotkeys(state.prefs.hotkeys) } };
    case "hotkeys.import": {
      if (typeof p.json !== "string") {
        return { error: "hotkeys.import needs { json: string }" };
      }
      try {
        const { hotkeys, dropped } = importHotkeys(p.json);
        dispatch({ type: "set_prefs", prefs: { hotkeys } });
        return { data: { imported: Object.keys(hotkeys).length, dropped } };
      } catch {
        return { error: "hotkeys.import: the text is not a hotkey map (invalid JSON)" };
      }
    }
    default:
      return { error: `unknown method "${method}"` };
  }
}

/** The async half: methods whose honest answer takes awaits.
 *
 * Everything here still rides the same bus and the same bridge calls
 * the UI uses; the awaits are renders, merges and folder reads, not a
 * second path. Anything not listed falls through to handleApi.
 */
export async function handleApiAsync(
  state: State,
  dispatch: (c: Command) => void,
  method: string,
  params: unknown,
): Promise<ApiReply> {
  const p = (params ?? {}) as Record<string, unknown>;
  switch (method) {
    case "app.open_folder": {
      const path = typeof p.path === "string" && p.path ? p.path : null;
      if (!path) return { error: "app.open_folder needs { path }" };
      const listing = await openFolder(path);
      if (!listing || !listing.path) return { error: `no folder at ${path}` };
      // The same landing the tree's plain open performs: ribbon, tree,
      // library badges.
      applyFolderListing(listing, state.folderTree, dispatch);
      void refreshLibrary(dispatch);
      return {
        data: { opened: listing.path, name: listing.name, images: listing.images.length },
      };
    }
    case "export.run": {
      const dir = typeof p.dir === "string" && p.dir ? p.dir : null;
      if (!dir) return { error: "export.run needs { dir }" };
      const format = typeof p.format === "string" ? p.format : DEFAULT_EXPORT_SETTINGS.format;
      if (!EXPORT_FORMATS.includes(format as ExportSettings["format"])) {
        return { error: `export.run: format must be one of ${EXPORT_FORMATS.join(", ")}` };
      }
      const byId = new Map(state.images.map((i) => [i.id, i]));
      const failed: { name: string; error: string }[] = [];
      let targets: ImageEntry[];
      if (Array.isArray(p.ids)) {
        targets = [];
        for (const raw of p.ids) {
          const img = byId.get(String(raw));
          // One bad id is a per-image failure, never a reason to stop
          // the run: the batch reports it beside the render failures.
          if (img) targets.push(img);
          else failed.push({ name: String(raw), error: "not in the open folder" });
        }
      } else {
        targets = exportTargets(state);
      }
      const settings: ExportSettings = {
        format: format as ExportSettings["format"],
        quality: typeof p.quality === "number" ? p.quality : DEFAULT_EXPORT_SETTINGS.quality,
        maxEdge:
          p.maxEdge === null || typeof p.maxEdge === "number"
            ? p.maxEdge
            : DEFAULT_EXPORT_SETTINGS.maxEdge,
        template:
          typeof p.template === "string" ? p.template : DEFAULT_EXPORT_SETTINGS.template,
        keepMetadata:
          typeof p.keepMetadata === "boolean"
            ? p.keepMetadata
            : DEFAULT_EXPORT_SETTINGS.keepMetadata,
        ...(typeof p.matte === "boolean" ? { matte: p.matte } : {}),
        dpi: exportDpi(typeof p.dpi === "number" ? p.dpi : undefined),
      };
      // The panel's own pipeline: per-image graphs, template naming,
      // collision suffixes, ICC and EXIF treatment, and failures
      // collected rather than fatal.
      const result = await runExport(state, targets, dir, settings, () => {});
      return { data: { written: result.written, failed: [...failed, ...result.failed] } };
    }
    case "stack.create": {
      const ids = Array.isArray(p.ids) ? p.ids.map(String) : null;
      const mode = typeof p.mode === "string" ? p.mode : null;
      if (!ids || !mode) return { error: "stack.create needs { ids: [...], mode }" };
      const made = await createStack(ids, mode);
      if (!made) {
        return { error: "stacking needs the desktop app: there are no source files to merge here" };
      }
      dispatch({ type: "add_stack_image", image: made });
      void thumbnailForNew(made.id, dispatch, state.prefs.thumbnailEdge, made.name, made);
      return { data: made };
    }
    case "stack.info": {
      const id = typeof p.id === "string" ? p.id : null;
      if (!id) return { error: "stack.info needs { id }" };
      const info = await stackInfo(id);
      if (!info) return { error: `"${id}" is not a stack` };
      return { data: info };
    }
    case "stack.configure": {
      const id = typeof p.id === "string" ? p.id : null;
      if (!id) return { error: "stack.configure needs { id }" };
      const change: { mode?: string; align?: boolean; members?: string[] } = {};
      if (typeof p.mode === "string") change.mode = p.mode;
      if (typeof p.align === "boolean") change.align = p.align;
      if (Array.isArray(p.members)) change.members = p.members.map(String);
      const info = await updateStack(id, change);
      if (!info) return { error: `"${id}" is not a stack` };
      dispatch({ type: "resume_stack_merge", image: id });
      return { data: info };
    }
    case "stack.bake": {
      const id = typeof p.id === "string" ? p.id : null;
      if (!id) return { error: "stack.bake needs { id }" };
      const format = typeof p.format === "string" ? p.format : "dng";
      const quality = typeof p.quality === "number" ? p.quality : 92;
      const graph = id === state.activeImage ? { nodes: state.nodes, wires: state.wires }
        : state.graphs[id] ?? await loadGraph(id) ?? freshGraphFor(state, id);
      const made = await bakeComposite(id, format, graph, quality, state.images.find(i => i.id === id), id !== state.activeImage);
      if (!made) {
        return { error: "baking needs the desktop app: there is no photograph on disk here" };
      }
      dispatch({ type: "add_stack_image", image: made });
      void thumbnailForNew(made.id, dispatch, state.prefs.thumbnailEdge, made.name, made);
      return { data: made };
    }
    case "pano.create": {
      const ids = Array.isArray(p.ids) ? p.ids.map(String) : null;
      if (!ids) return { error: "pano.create needs { ids: [...] }" };
      const made = await createPano(ids);
      if (!made) {
        return { error: "stitching needs the desktop app: there are no source files here" };
      }
      dispatch({ type: "add_stack_image", image: made });
      void thumbnailForNew(made.id, dispatch, state.prefs.thumbnailEdge, made.name, made);
      return { data: made };
    }
    case "pano.info": {
      const id = typeof p.id === "string" ? p.id : null;
      if (!id) return { error: "pano.info needs { id }" };
      const info = await panoInfo(id);
      if (!info) return { error: `"${id}" is not a panorama` };
      return { data: info };
    }
    case "pano.configure": {
      const id = typeof p.id === "string" ? p.id : null;
      if (!id) return { error: "pano.configure needs { id }" };
      const change: {
        surface?: string;
        gain_compensation?: boolean;
        straighten?: boolean;
        bands?: number;
        members?: string[];
      } = {};
      if (typeof p.surface === "string") change.surface = p.surface;
      if (typeof p.gainCompensation === "boolean") change.gain_compensation = p.gainCompensation;
      if (typeof p.straighten === "boolean") change.straighten = p.straighten;
      if (typeof p.bands === "number") change.bands = p.bands;
      if (Array.isArray(p.members)) change.members = p.members.map(String);
      const info = await updatePano(id, change);
      if (!info) return { error: `"${id}" is not a panorama` };
      dispatch({ type: "resume_pano_stitch", image: id });
      return { data: info };
    }
    default:
      return handleApi(state, dispatch, method, params);
  }
}
