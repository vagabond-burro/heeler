// What each command actually does.
//
// Kept apart from the key handling so the two can be reasoned about
// separately: hotkeys.ts says what is bound to what, this says what
// happens, and neither needs to know how the other works. A menu entry
// and a keystroke run the same function here, which is the only way they
// stay in step.

import type { Command, SelectRegion, State } from "./state";
import { ART_ID, DEFAULT_PREFS, artMaskNode, DOC_SEL_ID, SELECT_METHODS, TEXTURED_TIPS, activeSelectionMask, selectShapeTarget, shapeActsOnNothing, shapeToolOf, photoFlipBlocked, artFindLayer, artToolbarVisible, bakeable, editOrigin, layerPixelRegions, layerViaCopySource, reduce, clampGrainStep, removalPending, selectionHasContent, taggingTargets, anyPickerArmed } from "./state";
import { activeFillLayer } from "./ui/filltool";
import { activeSmartMask } from "./ui/smarttool";
import { openPolish } from "./polishdoor";
import { COMMANDS, type Scope } from "./hotkeys";
import { SECTIONS } from "./ui/simple";
import { NAV_START } from "./keynav";
import { BAKE_DIALOG_BACKUP_LINE, bakeBackupNotice } from "./bakedbackups";

type D = React.Dispatch<Command>;

/** A selection made into a new layer's mask (Isolate Selection, Fill
 * Selection): the desktop renders its coverage once (bake_layer_mask),
 * and the layer's pixel mask wears it. Through a dynamic import, as the
 * other desktop calls here, so this file keeps no bridge import. */
function bakeSelectionThen(state: State, maskId: string, what: string, then: (version: string) => void): void {
  void import("./ui/statusbar").then(({ publishBusy }) => publishBusy(`${what.toUpperCase()} \u00b7 baking the selection`));
  void import("./bridge")
    .then(({ bakeLayerMask }) => bakeLayerMask(state, maskId, ""))
    .then(then)
    .catch((err) => void import("./ui/hints").then(({ reportToolError }) => reportToolError(what, err)))
    .finally(() => void import("./ui/statusbar").then(({ publishBusy }) => publishBusy(null)));
}

/** New Layer via Copy, after its gates: the desktop cuts the pixels
 * (bake_layer_copy) and the reducer lays the image layer down on the
 * rectangle they came from (art_layer_via_copy). With no Finish stack
 * yet there is no To Display to copy the picture from, so the graph the
 * desktop renders is the one with the stack made; the stack itself is
 * made by the layer, in the same undo step. One seat for the menu, the
 * key and the panel's Image seat. */
export function runLayerViaCopy(state: State, dispatch: D, selectionId: string): void {
  const what = "New Layer via Copy";
  const { source, carrier, above, name } = layerViaCopySource(state);
  const graphState = state.nodes.some((n) => n.id === ART_ID) ? state : reduce(state, { type: "art_add_layer", kind: "image" });
  void import("./ui/statusbar").then(({ publishBusy }) => publishBusy(`${what.toUpperCase()} · copying the selection`));
  // Under the bakes' progress dialog, Bake Warp's path (layeractions.ts
  // runBakeWarp): a canceled copy dispatches nothing.
  // Kept in each recovery bundle while Keep baked pictures in backups
  // is on: the dialog says so, the status line gives the size once the
  // file is written (bakedbackups.ts).
  const kept = state.prefs.keepBakedInBackups;
  void import("./ui/opprogress")
    .then(({ watchBake }) =>
      watchBake(
        "Copying the selection at full size",
        () => import("./bridge").then(({ bakeLayerCopy }) => bakeLayerCopy(graphState, selectionId, source, carrier)),
        kept ? BAKE_DIALOG_BACKUP_LINE : undefined,
      ),
    )
    .then((copy) => {
      if (!copy) {
        dispatch({ type: "bump_preview" });
        return;
      }
      dispatch({
        type: "art_layer_via_copy",
        expected: editOrigin(state),
        path: copy.path,
        box: { x: copy.box[0], y: copy.box[1], w: copy.box[2], h: copy.box[3] },
        aspect: copy.aspect,
        name,
        above,
      });
      const notice = bakeBackupNotice(what, copy.bytes, kept);
      if (notice) void import("./ui/hints").then(({ flashStatus }) => flashStatus(notice, 8000));
    })
    .catch((err) => {
      dispatch({ type: "bump_preview" });
      void import("./ui/hints").then(({ reportToolError }) => reportToolError(what, err));
    })
    .finally(() => void import("./ui/statusbar").then(({ publishBusy }) => publishBusy(null)));
}

/** What a command needs beyond state and dispatch: the things that live
 * outside the reducer, like opening a folder dialog. Passed in so this
 * file has no imports from the bridge and stays testable. */
export interface CommandContext {
  openFolder?: () => void;
  rate?: (stars: number) => void;
  flag?: (flag: "" | "pick" | "reject") => void;
  merge?: (mode: string) => void;
  stitch?: () => void;
}

/** Whether a command is live in the current mode.
 *
 * A graph command firing in Develop would act on a selection the user
 * cannot see. "global" is live everywhere, which most commands are.
 */
/** Every tool that puts a brush under the cursor. The size, softness
 * and grain keys belong to whichever one is up: mask painting in
 * Develop, and painting, cloning and healing in Finish. Checking
 * for the literal "brush" tool left the Finish tools without their
 * keys, and the brackets fell through to the rating command instead
 * ("the [] hotkeys aren't working for brush size").*/
export const BRUSH_TOOLS: State["tool"][] = [
  "brush",
  "paint",
  "clone",
  "heal",
  "dodge",
  "burn",
  // Polish paints with the same brush engine; leaving it out sent the
  // bracket keys through to the rating commands instead.
  "polish",
];

export function brushIsUp(state: State): boolean {
  return BRUSH_TOOLS.includes(state.tool);
}

/** The mask Remove Object would consume, when one has content and has
 * not already been removed: the active Smart selection first, else the
 * active drawn selection. One resolver, shared with the menu's gate. */
export function removeObjectSource(state: State) {
  // A finished removal never blocks the next one: the document selection
  // is ONE node reused for every marquee, so keying "already removed"
  // off the mask locked Remove after its first use. "I have
  // a selection made... Nothing happens." Only a removal still computing
  // refuses, to keep a double click from splicing twice.
  const already = (id: string) => removalPending(state, id);
  const smart = activeSmartMask(state);
  if (
    smart &&
    !already(smart.id) &&
    ((smart.textParams?.prompts ?? "[]") !== "[]" || (smart.textParams?.model ?? "") !== "")
  ) {
    return smart;
  }
  const sel = activeSelectionMask(state);
  if (
    sel &&
    !already(sel.id) &&
    ((sel.regions ?? []).some((r) => !r.off) || (sel.textParams?.matte_id ?? "") !== "")
  ) {
    return sel;
  }
  return undefined;
}

export function inScope(scope: Scope, mode: State["mode"]): boolean {
  switch (scope) {
    case "global":
    case "library":
      return true;
    case "develop":
    // The brush tool only exists in Develop; whether it is actually up
    // is checked by the command itself, since that is tool state rather
    // than mode state.
    case "brush":
      return mode === "simple";
    case "graph":
      return mode === "advanced" || mode === "canvas";
    case "canvas":
      return mode === "canvas";
  }
}

/** Runs a command. Returns false when it did nothing, so the caller can
 * let the key through to whatever else might want it. */
/** Filenames for a confirmation, so it can name what it is about to do
 * rather than showing ids. */
function namesOf(state: State, ids: string[]): string[] {
  return ids.map((id) => state.images.find((i) => i.id === id)?.name ?? id);
}

export function runCommand(
  id: string,
  state: State,
  dispatch: D,
  ctx: CommandContext = {}
): boolean {
  const rate = (stars: number) => {
    const ids = taggingTargets(state);
    dispatch({ type: "set_rating", ids, stars });
    ctx.rate?.(stars);
  };
  const flag = (f: "" | "pick" | "reject") => {
    const ids = taggingTargets(state);
    dispatch({ type: "set_flag", ids, flag: f });
    ctx.flag?.(f);
  };

  switch (id) {
    case "file.open":
      ctx.openFolder?.();
      return !!ctx.openFolder;
    case "file.export":
      dispatch({ type: "toggle_export" });
      return true;
    case "app.preferences":
      dispatch({ type: "open_prefs" });
      return true;
    case "catalog.manage":
      dispatch({ type: "open_catalogs" });
      return true;

    // Only ever raises the confirmation; nothing happens on the
    // keystroke itself. Hiding is reversible, which is now the strongest
    // thing any command here does to a file: see the note on
    // Same shape as hiding, and the same promise: the keystroke raises
    // a question and nothing else. What it does when answered is a
    // rename into `.trash`, so this is reversible too, just further
    // than hiding is.
    case "image.trash":
      if (!taggingTargets(state).length) return false;
      dispatch({
        type: "ask_confirm",
        action: {
          kind: "trash_images",
          ids: taggingTargets(state),
          names: namesOf(state, taggingTargets(state)),
        },
      });
      return true;
    case "edit.reset":
      // The disk-side aftermath (graph file, catalog badge, thumbnail)
      // drains from the resetPending queue (ResetAftermath). Every photo in
      // a multi-selection, the rule every tag follows, as one step that one
      // Undo takes back. "When I have more than one Thumbnail
      // selected, Reset all edits should be applied to all that are
      // selected."
      dispatch({ type: "reset_image_edits", ids: taggingTargets(state) });
      return true;

    case "edit.undo":
      dispatch({ type: "undo" });
      return true;
    case "edit.redo":
      dispatch({ type: "redo" });
      return true;
    case "edit.delete":
      if (state.selection.length === 0) return false;
      dispatch({ type: "delete_nodes", ids: state.selection, heal: state.deleteHeals });
      return true;
    case "edit.deleteKeep":
      // The other meaning of delete, whichever that is: SHIFT inverts
      // the preference rather than naming a fixed behavior.
      if (state.selection.length === 0) return false;
      dispatch({ type: "delete_nodes", ids: state.selection, heal: !state.deleteHeals });
      return true;

    case "edit.duplicate":
      if (state.selection.length === 0) return false;
      dispatch({ type: "duplicate_nodes", ids: state.selection });
      return true;

    case "graph.group":
      // Two or more, because a group of one is the node it came from.
      if (state.selection.length < 2) return false;
      dispatch({ type: "open_group_dialog", open: true });
      return true;

    case "layer.range":
      dispatch({ type: "add_layer", maskType: "range" });
      return true;
    case "layer.radial":
      dispatch({ type: "add_layer", maskType: "radial" });
      return true;
    case "layer.linear":
      dispatch({ type: "add_layer", maskType: "linear" });
      return true;
    case "layer.selection":
      dispatch({ type: "add_layer", maskType: "selection" });
      return true;
    case "layer.brush":
      dispatch({ type: "add_layer", maskType: "brush" });
      return true;
    case "layer.smart":
      dispatch({ type: "add_layer", maskType: "smart" });
      return true;

    case "view.mode.next":
      dispatch({ type: "cycle_mode", delta: 1 });
      return true;
    case "view.mode.prev":
      dispatch({ type: "cycle_mode", delta: -1 });
      return true;
    case "view.mode.toggle":
      dispatch({ type: "set_mode", mode: state.mode === "simple" ? "advanced" : "simple" });
      return true;
    case "view.mode.develop":
      dispatch({ type: "set_mode", mode: "simple" });
      return true;
    case "view.mode.graph":
      dispatch({ type: "set_mode", mode: "advanced" });
      return true;
    case "view.mode.canvas":
      dispatch({ type: "set_mode", mode: "canvas" });
      return true;
    case "view.sections.expand":
    case "view.sections.collapse":
      dispatch({ type: id === "view.sections.expand" ? "open_sections" : "close_sections", titles: SECTIONS.map((sec) => sec.title) });
      return true;
    case "view.browser":
      dispatch({ type: "toggle_browser" });
      return true;
    case "view.ribbon":
      dispatch({ type: "toggle_ribbon" });
      return true;
    case "view.console":
      // The console is an OS window, never a float; the key summons or
      // dismisses the window itself.
      void import("./ui/console").then(({ toggleConsoleWindow }) => toggleConsoleWindow());
      return true;
    case "window.graph":
      dispatch({ type: "set_graph_popped_out", out: !state.graphPoppedOut });
      return true;
    case "window.spectrums":
      dispatch({ type: "set_spectrums_popped_out", out: !state.spectrumsPoppedOut });
      return true;
    case "window.takes":
      dispatch({ type: "set_takes_popped_out", out: !state.takesPoppedOut });
      return true;
    case "window.bend":
      dispatch({ type: "set_bend_popped_out", out: !state.bendPoppedOut });
      return true;
    case "window.dock_all":
      dispatch({ type: "dock_all_windows" });
      return true;
    case "view.layout_reset":
      dispatch({ type: "reset_layout" });
      return true;
    case "view.fullscreen":
      void import("./windowops").then(({ toggleFullscreen }) => toggleFullscreen()).catch(() => {});
      return true;
    case "view.center_window":
      void import("./windowops").then(({ centerMainWindow }) => centerMainWindow()).catch(() => {});
      return true;
    case "view.canvas_nodes":
      dispatch({ type: "toggle_canvas_nodes" });
      return true;

    case "panel.adjustments":
      dispatch({ type: "set_panel_tab", tab: "adjust" });
      return true;
    case "panel.history":
      dispatch({ type: "set_panel_tab", tab: "history" });
      return true;
    case "panel.presets":
      dispatch({ type: "set_panel_tab", tab: "presets" });
      return true;

    case "view.zoom.in":
      dispatch({ type: "zoom_step", dir: 1 });
      return true;
    case "view.zoom.out":
      dispatch({ type: "zoom_step", dir: -1 });
      return true;
    case "view.zoom.fit":
    // The develop-scoped one-letter flavor: same Fit, reached by F,
    // where Graph and Canvas give F to Frame Nodes instead.
    case "view.fit":
      dispatch({ type: "set_zoom", zoom: "fit" });
      return true;
    case "view.zoom.100":
      dispatch({ type: "set_zoom", zoom: "100" });
      return true;
    case "view.before_after":
      dispatch({ type: "toggle_compare" });
      return true;
    case "view.split":
      dispatch({ type: "toggle_split" });
      return true;

    case "nav.next_image":
      dispatch({ type: "step_image", delta: 1 });
      return true;
    case "nav.prev_image":
      dispatch({ type: "step_image", delta: -1 });
      return true;

    case "flag.pick":
      flag("pick");
      return true;
    case "flag.reject":
      flag("reject");
      return true;
    case "flag.none":
      flag("");
      return true;
    // Only while the brush is actually up. Returning false hands the
    // key back so the rating command sharing it runs instead.
    case "brush.size.down":
    case "brush.size.up": {
      const step = id === "brush.size.up" ? 0.005 : -0.005;
      // Polishing has a brush of its own and takes the viewport over, so
      // the size keys mean that one while it is open. Same keys, because
      // there is only ever one brush on screen at a time.
      if (state.polishOpen) {
        dispatch({ type: "set_polish_radius", radius: state.polishRadius + step });
        return true;
      }
      if (!brushIsUp(state)) return false;
      dispatch({ type: "set_brush_radius", radius: state.brushRadius + step });
      return true;
    }
    // Only for the tips that have a grain to turn; the round and square
    // ones hand the key back rather than pretending to do something.
    // X, the layer-editor reflex: swap which way the mask brush paints
    // (hide vs reveal) until pressed again. ALT still inverts
    // momentarily relative to whichever way it points.
    case "brush.swap": {
      if (!brushIsUp(state)) return false;
      dispatch({ type: "toggle_brush_swap" });
      return true;
    }
    case "brush.grain.ccw":
    case "brush.grain.cw":
    case "brush.grain.ccw.fine":
    case "brush.grain.cw.fine": {
      if (!brushIsUp(state) || !TEXTURED_TIPS.includes(state.brushTip ?? "circle")) {
        return false;
      }
      // Both sizes are settings rather than constants, because how far
      // "a nudge" is depends on the texture: a crosshatch reads a five
      // degree change and a splatter does not.
      const fine = id.endsWith(".fine");
      const size = clampGrainStep(
        (fine ? state.prefs.brushGrainFineStep : state.prefs.brushGrainStep) ??
          (fine ? DEFAULT_PREFS.brushGrainFineStep : DEFAULT_PREFS.brushGrainStep),
      );
      const step = id.startsWith("brush.grain.cw") ? size : -size;
      dispatch({
        type: "set_brush_texture_angle",
        angle: (state.brushTextureAngle ?? 0) + step,
      });
      return true;
    }
    // Select All, Deselect, Invert: the three every editor has, acting
    // on whichever selection is live.
    case "select.all":
    case "select.none":
    case "select.invert": {
      const mask = activeSelectionMask(state);
      if (!mask) return false;
      if (id === "select.none") {
        dispatch({ type: "clear_regions", id: mask.id });
        // A cleared selection that stayed inverted would select the
        // whole frame, which is the opposite of what Deselect means.
        if ((mask.params.invert ?? 0) !== 0) {
          dispatch({ type: "set_param", id: mask.id, param: "invert", value: 0 });
        }
        return true;
      }
      if (id === "select.invert") {
        // The mask's own flag rather than rewriting its regions: an
        // inverted selection is still the shape you drew, and turning
        // it back is one click rather than an undo.
        dispatch({
          type: "set_param",
          id: mask.id,
          param: "invert",
          value: (mask.params.invert ?? 0) !== 0 ? 0 : 1,
        });
        return true;
      }
      // Select All is one region covering the frame, replacing
      // whatever was there.
      dispatch({
        type: "add_region",
        id: mask.id,
        region: { kind: "marquee", op: "replace", x0: 0, y0: 0, x1: 1, y1: 1, shape: "rect" },
      });
      if ((mask.params.invert ?? 0) !== 0) {
        dispatch({ type: "set_param", id: mask.id, param: "invert", value: 0 });
      }
      return true;
    }
    // Smooth, Feather and Resize: one number on the mask, already in the
    // engine. The dialog steers the real param through the real graph, so
    // the photograph under it IS the preview. Polish is three numbers on
    // the mask like the others, so it opens the same dialog pointed at its
    // own params. Polish is a TOOL, not a dialog. "In both
    // [the layer editors] this is an interactive tool. The user brushes
    // over the image where the selection needs to be refined." Both are
    // right, and the first pass here was the settings half of the tool
    // with the tool missing.
    //
    // It opens on what the marching ants trace (polishdoor.ts): the
    // selection when it shows anything, else the live mask in hand, a
    // Finish layer's polished in the document selection and put back by
    // Apply. 2026-10-02, on a Smart layer with nothing else selected:
    // "the entire image has a red overlay. It's like getting the polish
    // tool from the menu doesn't recognize the smart selection."
    case "select.polish": {
      if (!state.activeImage) return false;
      return openPolish(state, dispatch);
    }
    // Remove Object: erase what the Smart selection covers and let the
    // model fill the hole. An ACTION on the photograph, seated with the
    // other selection-consuming commands rather than in the selection
    // panel ("If Remove is for generative fill content then
    // why have it here?"). The splice is undoable graph surgery;
    // RemoveRunner carries the fill and the consent.
    case "select.remove_object": {
      // ANY selection can feed the removal, and the TAB decides where the
      // result lives. "I could see this as a valid workflow if I
      // was working in adjustments. 100%. But if I am working in Finish tab,
      // the results should end up in a Fill layer." So: Adjustments splices
      // the develop chain (a Removed object row beside the develop layers);
      // Finish makes a Fill layer whose mask is the baked selection.
      const mask = removeObjectSource(state);
      if (!mask) return false;
      if (state.panelTab === "layers") {
        dispatch({ type: "art_remove_from_selection", maskId: mask.id });
      } else {
        dispatch({ type: "add_inpaint_for", maskId: mask.id });
      }
      return true;
    }
    // Grade the face, press Alt+O, grade everything that is not the
    // face. Needs a masked node: with no mask there is no outside.
    case "node.outside": {
      // Refusals SPEAK. The owner pressed this on an unmasked node and
      // nothing happened at all, which reads as the key being broken
      // rather than the node being ineligible.
      if (state.selection.length !== 1) {
        dispatch({ type: "set_notice", text: "Outside works on one selected node" });
        return true;
      }
      const id = state.selection[0];
      if (!state.wires.some((w) => w.to === id && w.toPort === "mask")) {
        dispatch({
          type: "set_notice",
          text: "Outside needs a mask: drag a mask node's port onto this node first",
        });
        return true;
      }
      dispatch({ type: "node_outside", id });
      return true;
    }
    // A compositor's / search: find nodes by name, wildcards included.
    case "graph.search":
      dispatch({ type: "toggle_graph_search", open: !state.graphSearchOpen });
      return true;
    // Everything that feeds the selection, selected with it: the
    // gesture for "pick this up and everything it depends on".
    case "node.upstream": {
      if (!state.selection.length) return false;
      const take = new Set(state.selection);
      // Fixed-point walk: a wire into anything taken takes its source,
      // masks included, until nothing new appears.
      let grew = true;
      while (grew) {
        grew = false;
        for (const w of state.wires) {
          if (take.has(w.to) && !take.has(w.from)) {
            take.add(w.from);
            grew = true;
          }
        }
      }
      dispatch({ type: "select_nodes", ids: [...take] });
      return true;
    }
    // D: the fastest A/B a grader has. Toggles every selected node,
    // and the mixed case turns everything OFF, because "make these
    // stop" is what a hand reaching for D during a comparison means.
    case "node.disable": {
      const sel = state.nodes.filter((n) => state.selection.includes(n.id));
      if (!sel.length) return false;
      const enable = sel.every((n) => !n.enabled);
      for (const n of sel) dispatch({ type: "set_enabled", id: n.id, enabled: enable });
      return true;
    }
    // N: inline rename on the one selected node, in place on the card.
    case "node.rename": {
      if (state.selection.length !== 1) return false;
      dispatch({ type: "request_rename", id: state.selection[0] });
      return true;
    }
    case "select.smooth":
    case "select.feather":
    case "select.resize": {
      const mask = activeSelectionMask(state);
      if (!mask) return false;
      const param =
        id === "select.smooth" ? "smooth" : id === "select.feather" ? "feather" : "grow";
      dispatch({
        type: "open_select_dialog",
        dialog: { kind: "param", param, restore: Number(mask.params[param] ?? 0) },
      });
      return true;
    }
    // The three range selections differ only in which plane they read,
    // so they are one dialog told which histogram to draw.
    case "select.range.luma":
    case "select.range.color":
    case "select.range.contrast":
    case "select.range.depth": {
      // No selection yet is not a reason to gray the door (2026-09-09:
      // "The Select By... tools ... should always be usable"): the
      // document selection is made and picked, and the range goes into it.
      // It is NOT the select tool: no arming, no cursor change
      // (2026-09-10). Until the ensure these only worked after a visit to
      // the Finish toolbar.
      let mask = activeSelectionMask(state);
      if (!mask) {
        if (!state.activeImage) return false;
        dispatch({ type: "ensure_document_selection" });
        mask = { id: DOC_SEL_ID, regions: [] } as unknown as NonNullable<typeof mask>;
      }
      const mode =
        id === "select.range.luma"
          ? "luma"
          : id === "select.range.color"
            ? "color"
            : id === "select.range.depth"
              ? "depth"
              : "contrast";
      const channel =
        mode === "color" ? "red" : mode === "luma" ? "luma" : mode;
      // Opened as a real region straight away, on a range that selects
      // the upper half: a dialog that showed nothing until you moved a
      // slider would make you guess what it was going to do.
      const region: SelectRegion = {
        kind: "range",
        // Whatever New/Add/Subtract/Intersect is set to, the same as
        // every other way of making a region.
        op: state.selectOp,
        channel,
        lo: 0.5,
        hi: 1,
        soft: 0.08,
      };
      // Add, Subtract and Intersect with nothing selected combine with
      // the live Smart or Object mask in hand, as a drawn shape does
      // (selectShapeTarget); with nothing at all to act on, the status
      // line says so instead of a dialog that changes nothing.
      if (shapeActsOnNothing(state, mask, region.op)) {
        dispatch({ type: "set_notice", text: `${region.op === "subtract" ? "Subtract has nothing to take the range out of" : "Intersect has nothing to keep"}: nothing is selected.` });
        return true;
      }
      const target = selectShapeTarget(state, mask, region.op);
      dispatch({ type: "add_region", id: target.id, region });
      // Replace clears the list, so the new region is the only one;
      // otherwise it went on the end.
      const index = region.op === "replace" ? 0 : (target.regions ?? []).length;
      dispatch({
        type: "open_select_dialog",
        // The list as it was, so Cancel can put back what "New" threw
        // away rather than only removing the range itself.
        dialog: {
          kind: "range",
          mode,
          channel,
          index,
          restoreRegions: [...(target.regions ?? [])],
          ...(target.id !== mask.id ? { maskId: target.id } : {}),
        },
      });
      return true;
    }
    // Fill lands as its own layer rather than as pixels burned into the
    // active one: the color stays a parameter, the selection stays the
    // mask that shapes it, and both are still editable tomorrow. That
    // is the same bargain every other tool here makes.
    // Both arm a gizmo over the active layer and nothing else. They
    // need a layer to act on: transforming "no layer" is not a thing
    // with a meaning, and a gizmo over the frame with nothing under it
    // is worse than a disabled button.
    case "layer.transform":
    case "layer.warp": {
      if (!state.artActive) return false;
      const tool = id === "layer.transform" ? "transform" : "warp";
      dispatch({ type: "set_tool", tool: state.tool === tool ? "none" : tool });
      return true;
    }
    // "I would need some sort of way to select the visible
    // pixels." The shape of what is on the layer, not the layer, which is
    // always the whole frame. It needs a layer to read and somewhere to put
    // the answer; with no selection mask armed there is no document
    // selection to write into yet, so arming one is part of the gesture
    // rather than something to ask the user for first.
    case "select.layer_pixels": {
      if (!state.artActive) return false;
      const regions = layerPixelRegions(state, state.artActive);
      if (!regions.length) {
        // A pixel mask with no drawn outline (a Smart selection made
        // into it, a mask painted by hand): its render becomes the
        // selection, as Selection from Mask makes it.
        const layerMask = artMaskNode(state, `art_m_${state.artActive}`);
        const based = (layerMask?.textParams?.matte_id ?? "") !== "" || (layerMask?.textParams?.base_selection ?? "") !== "";
        if (!layerMask || layerMask.type !== "heeler.brush_mask" || !based) return false;
        void import("./bridge")
          .then(({ bakeMaskRaster }) => bakeMaskRaster(state, layerMask.id))
          .then((version) => dispatch({ type: "load_selection_from_mask", maskId: layerMask.id, version }))
          .catch((err) => void import("./ui/hints").then(({ reportToolError }) => reportToolError("Select Layer Pixels", err)));
        return true;
      }
      let mask = activeSelectionMask(state);
      if (!mask) {
        dispatch({ type: "arm_document_selection" });
        // The mask the arm just made, read off a state the dispatch has
        // not handed back yet: this runs before the next render, so the
        // id has to be derived rather than looked up.
        const armed = reduce(state, { type: "arm_document_selection" });
        mask = activeSelectionMask(armed);
        if (!mask) return false;
      }
      for (const region of regions) {
        dispatch({ type: "add_region", id: mask.id, region });
      }
      // An inverted mask would hand back everything except the layer,
      // which is the opposite of what was asked for.
      if ((mask.params.invert ?? 0) !== 0) {
        dispatch({ type: "set_param", id: mask.id, param: "invert", value: 0 });
      }
      return true;
    }
    case "select.to_layer": {
      // No active layer needed: this one makes its own, which is the
      // whole gesture. It does need something selected to lift, and
      // it needs the Finish tab: the stack it lands on lives there.
      if (state.panelTab !== "layers") {
        dispatch({ type: "set_notice", text: "Isolate Selection works in the Finish tab" });
        return true;
      }
      const mask = activeSelectionMask(state);
      if (!mask) return false;
      bakeSelectionThen(state, mask.id, "Isolate Selection", (version) =>
        dispatch({ type: "art_layer_from_selection", maskId: mask.id, version }),
      );
      return true;
    }
    case "layer.via_copy": {
      // The layer editors' Layer via Copy (2026-09-30): the pixels inside the
      // selection on a new layer, an image layer so it moves and warps as
      // one. The stack it lands on is the Finish tab's.
      if (state.panelTab !== "layers") {
        dispatch({ type: "set_notice", text: "New Layer via Copy works in the Finish tab" });
        return true;
      }
      const mask = activeSelectionMask(state);
      if (!mask || !selectionHasContent(mask)) return false;
      runLayerViaCopy(state, dispatch, mask.id);
      return true;
    }
    case "select.fill": {
      if (state.panelTab !== "layers") {
        dispatch({ type: "set_notice", text: "Fill Selection works in the Finish tab" });
        return true;
      }
      const mask = activeSelectionMask(state);
      if (!mask || !state.artActive) return false;
      const color = state.paintColor;
      bakeSelectionThen(state, mask.id, "Fill Selection", (version) =>
        dispatch({ type: "art_fill_from_selection", maskId: mask.id, color, version }),
      );
      return true;
    }
    case "brush.soft.down":
    case "brush.soft.up": {
      if (!brushIsUp(state)) return false;
      // Softer means less hardness, so the sign is inverted here rather
      // than in the reducer, where hardness is what the engine reads.
      const step = id === "brush.soft.up" ? -0.05 : 0.05;
      dispatch({ type: "set_brush_hardness", hardness: (state.brushHardness ?? 0.8) + step });
      return true;
    }

    case "rate.up":
    case "rate.down": {
      const from = state.images.find((i) => i.id === state.activeImage)?.stars ?? 0;
      rate(Math.min(5, Math.max(0, from + (id === "rate.up" ? 1 : -1))));
      return true;
    }

    // The Finish toolbar, by key. Each one behaves exactly like its
    // button - same toggle, same mode memory, same disabled cases - and
    // none of them fires unless the toolbar itself is on screen (The
    // report: "make sure these hotkeys only work with the toolbar is
    // visible"). Polish slims the bar to its own controls, so the tool
    // keys stand down with the buttons they mirror.
    case "art.cursor":
    case "art.shape":
    case "art.paint":
    case "art.dodgeburn":
    case "art.repair":
    case "art.blur":
    case "art.fill":
    case "art.erase": {
      // Cursor is an exit from every viewer tool, including tools and
      // pickers armed outside the Finish toolbar. Commit modal edits.
      if (id === "art.cursor") {
        if (state.tool === "none" && !anyPickerArmed(state) && !artToolbarVisible(state)) return false;
        if (anyPickerArmed(state)) dispatch({ type: "disarm_pickers" });
        dispatch({ type: "set_tool", tool: "none" });
        return true;
      }
      if (!artToolbarVisible(state) || state.tool === "polish") return false;
      const toggle = (tool: State["tool"], armed: boolean) =>
        dispatch({ type: "set_tool", tool: armed ? "none" : tool });
      if (id === "art.shape") {
        toggle(shapeToolOf(state.shapeMode), state.tool === "transform" || state.tool === "warp");
        return true;
      }
      if (id === "art.paint") {
        toggle("paint", state.tool === "paint");
        return true;
      }
      if (id === "art.dodgeburn") {
        toggle(state.dodgeMode, state.tool === "dodge" || state.tool === "burn");
        return true;
      }
      if (id === "art.fill") {
        if (state.tool === "fill") {
          dispatch({ type: "set_tool", tool: "none" });
        } else if (activeFillLayer(state)) {
          dispatch({ type: "set_tool", tool: "fill" });
        } else {
          // No fill layer in hand: the brush makes its own (and arms),
          // same as the button.
          dispatch({ type: "art_add_fill_layer" });
        }
        return true;
      }
      // The rest write onto a pixel layer and gray out without one.
      const layer = state.artActive ? artFindLayer(state, state.artActive) : undefined;
      const retouch =
        layer?.content.type === "heeler.paint" || layer?.content.type === "heeler.clone";
      if (!retouch) return false;
      if (id === "art.repair") {
        toggle(state.repairMode, state.tool === "clone" || state.tool === "heal");
      } else if (id === "art.blur") {
        toggle(state.blurMode, state.tool === "blur" || state.tool === "blend");
      } else {
        toggle("erase", state.tool === "erase");
      }
      return true;
    }
    // The selection tool works wherever selections do, panel or not
    // ("can work any time since they can also be used
    // in Develop > Adjustments").
    case "art.select":
      if (state.tool === "select") {
        dispatch({ type: "set_tool", tool: "none" });
      } else {
        dispatch({ type: "arm_document_selection" });
      }
      return true;
    // SHIFT+M walks the Draw-with list and wraps, arming the tool if
    // it was down: the layer-editor Shift+tool reflex, on every method.
    case "art.select.cycle": {
      const at = SELECT_METHODS.findIndex((m) => m.id === state.selectMethod);
      dispatch({
        type: "set_select_method",
        method: SELECT_METHODS[(at + 1) % SELECT_METHODS.length].id,
      });
      if (state.tool !== "select") dispatch({ type: "arm_document_selection" });
      return true;
    }

    // Frame the graph on what matters: the selection, or everything. The
    // report: "When I enter a Finish group I had a hard time finding the
    // nodes in the view." The viewport is measured here because the
    // reducer has no window to ask.
    case "graph.frame": {
      const el =
        document.querySelector('[data-testid="node-editor"]') ??
        document.querySelector('[data-testid="canvas-mode"]');
      if (!el) return false;
      const r = el.getBoundingClientRect();
      dispatch({ type: "frame_graph", w: r.width, h: r.height });
      return true;
    }

    case "tool.crop":
      dispatch({ type: "set_tool", tool: "crop" });
      return true;
    case "tool.straighten":
      dispatch({ type: "set_tool", tool: "straighten" });
      return true;
    case "tool.gridwarp":
      dispatch({ type: "set_tool", tool: "gridwarp" });
      return true;
    case "tool.shapewarp":
      dispatch({ type: "set_tool", tool: "shapewarp" });
      return true;
    case "tool.brush":
      dispatch({ type: "set_tool", tool: "brush" });
      return true;
    case "tool.pick":
      dispatch({ type: "set_tool", tool: "pick" });
      return true;
    case "tool.cancel":
      // An armed picker is the topmost modal thing while it is up, so Escape
      // peels every picker first; the next Escape reaches the tool. The
      // report: "The picker should turn off with the ESC key", and later,
      // "not all cancel with the ESC key": one list, every arm.
      if (anyPickerArmed(state)) {
        dispatch({ type: "disarm_pickers" });
        return true;
      }
      if (state.tool === "none") return false;
      dispatch({ type: "cancel_tool" });
      return true;
    case "tool.apply":
      // ENTER commits the modal tools, the keyboard twin of their Apply and
      // DONE buttons: toggling the tool off keeps what was dragged (set_tool
      // drops the revert snapshot). "Pressing ENTER while in the
      // Crop tool should apply the crop." Unclaimed otherwise, so Enter keeps
      // meaning whatever a dialog or field wants.
      if (state.tool !== "crop" && state.tool !== "straighten" && state.tool !== "polish" && state.tool !== "gridwarp" && state.tool !== "shapewarp" && state.tool !== "transform" && state.tool !== "warp") {
        return false;
      }
      // A warp tool names the warp it is on: without it, set_tool read
      // Enter on a Finish warp as a move to the photograph's own warp
      // and left the tool up there instead of putting it down.
      dispatch(
        state.tool === "gridwarp" || state.tool === "shapewarp"
          ? { type: "set_tool", tool: state.tool, target: state.warpTarget }
          : { type: "set_tool", tool: state.tool },
      );
      return true;

    case "develop.keynav":
      dispatch({ type: "set_keynav", nav: NAV_START });
      return true;

    case "node.palette":
      dispatch({ type: "open_palette" });
      return true;

    case "photo.panorama":
      ctx.stitch?.();
      return !!ctx.stitch;
    case "photo.flip_h":
    case "photo.flip_v":
      if (photoFlipBlocked(state)) return false;
      dispatch({ type: "flip_photo", axis: id === "photo.flip_h" ? "h" : "v" });
      return true;
    case "photo.bake": {
      // Declines when nothing selected is a merge, so the key falls
      // through rather than opening a dialog with nothing in it.
      const ids = bakeable(state);
      if (!ids.length) return false;
      dispatch({ type: "open_bake", ids });
      return true;
    }
    case "photo.reset_edits":
      dispatch({ type: "reset_image_edits", ids: taggingTargets(state) });
      return true;

    default:
      // The ratings, and the stack merges, which are named by suffix.
      if (id.startsWith("rate.")) {
        const n = Number(id.slice(5));
        if (Number.isInteger(n)) {
          rate(n);
          return true;
        }
      }
      if (id.startsWith("photo.stack.")) {
        ctx.merge?.(id.slice("photo.stack.".length));
        return !!ctx.merge;
      }
      // The develop nudge keys belong to the control navigator, which
      // reads them before this ever sees them. Reaching here means it is
      // not running, and moving a control nobody has focused is nothing.
      return false;
  }
}

/** Every command id that runCommand knows how to do something with.
 * Used by a test to catch a command added to the registry and never
 * wired up, which would show in the editor and do nothing. */
export const HANDLED: string[] = COMMANDS.map((c) => c.id);
