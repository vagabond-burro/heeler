/** What you can do to one Finish layer, in one list.
 *
 * The owner asked for two doors onto the same set of actions: "I
 * think a lot of this could be handled with context menus for the
 * layers and groups... Make sure all this functionality is also
 * mirrored in the Layer menu." Two doors and one list, then, because
 * two hand-written menus drift the moment either grows an item.
 *
 * Every item keeps its seat, always, and grays out when it does not
 * apply.
 *
 * "Hiding unavailable menu items. This causes the menu to
 * change height and it's not clear what are all the possible tools
 * that could be available. The preferred way to work, in a vast
 * majority of apps, is to disable a menu item when it's out of
 * context." Group Layer had already been through this once, for the
 * same reason in his words ("the Delete Layer function is there but
 * not the Group Layers function"); the rest of the list has now
 * followed it.
 *
 * So the list is a fixed shape and only its `disabled` flags move. Two
 * things fall out of that. The menu is the same height wherever it is
 * opened, which means the item you want is in the place you last saw
 * it. And the menu doubles as the answer to "what can I do to a
 * layer?", which a list that shows only what applies right now can
 * never be.
 *
 * Where the layer LIVES still decides the flags, so the caller does not
 * have to know: a member cannot Add to Group, a top-level layer cannot
 * Remove from Group, only a group can Ungroup. Nothing here dispatches;
 * each item carries a `run` the caller invokes with its own dispatch,
 * which is what lets the panel and the menu bar share it.
 */

import {
  artFindLayer,
  bakeableWarp,
  unbakeableWarp,
  editOrigin,
  canGroupLayers,
  artGroupMembers,
  artLayers,
  artMaskOf,
  maskIsOff,
  MASK_OFF_GESTURE,
  type Command,
  type State,
} from "./state";
import { BAKE_DIALOG_BACKUP_LINE, bakeBackupNotice } from "./bakedbackups";

type Dispatch = (cmd: Command) => void;

/** Bake Warp's words, one wording for its two seats (the Warp layer's
 * row and this list, which the right-click menu and the Layer menu
 * share): the outcome, then the cost. */
export const BAKE_WARP_HINT =
  "Turn the warp into a picture layer to move and warp again. It stops following Develop edits and layers below.";

/** Unbake's words, one wording for its seats (the baked layer's panel,
 * this list for the right-click menu and the Layer menu): the outcome,
 * then what the live warp does that the picture did not. */
export const UNBAKE_WARP_HINT =
  "Turn this baked layer back into its live Warp layer. The warp then bends whatever is below it now.";

/** Bake Warp (2026-09-30: "a bake option on the warp layer that bakes
 * warping effect down to a pixel layer. I think both the [layer editor]
 * way and a way to commit/bake a warp could be useful"): the desktop
 * renders what the Warp layer `id` shows at the photograph's size
 * (bake_warp_layer) and the reducer puts an image layer reading it in the
 * Warp layer's seat (art_bake_warp), one undo step. Through dynamic
 * imports, the commands.ts way, so this list keeps no bridge import.*/
export function runBakeWarp(state: State, dispatch: Dispatch, id: string): void {
  const what = "Bake Warp";
  if (!bakeableWarp(state, id)) return;
  void import("./ui/statusbar").then(({ publishBusy }) => publishBusy(`${what.toUpperCase()} · baking the warp`));
  // Under the bake's progress dialog (2026-09-30: "Bake Warp was really
  // slow. I think a dialog should pop up with a progress bar"): shown
  // once the bake has run half a second, with Cancel. A canceled bake
  // dispatches nothing, so the Warp layer and the undo history are as
  // they were; the preview settles again, since the bake took the engine
  // from the settle in flight. With Keep baked pictures in backups on,
  // the dialog says the picture travels with each recovery bundle and the
  // status line gives its size once written (bakedbackups.ts).
  const kept = state.prefs.keepBakedInBackups;
  void import("./ui/opprogress")
    .then(({ watchBake }) =>
      watchBake("Baking the warp at full size", () => import("./bridge").then(({ bakeWarpLayer }) => bakeWarpLayer(state, id)), kept ? BAKE_DIALOG_BACKUP_LINE : undefined),
    )
    .then((pic) => {
      if (!pic) {
        dispatch({ type: "bump_preview" });
        return;
      }
      dispatch({
        type: "art_bake_warp",
        expected: editOrigin(state),
        id,
        path: pic.path,
        box: { x: pic.box[0], y: pic.box[1], w: pic.box[2], h: pic.box[3] },
        aspect: pic.aspect,
      });
      const notice = bakeBackupNotice(what, pic.bytes, kept);
      if (notice) void import("./ui/hints").then(({ flashStatus }) => flashStatus(notice, 8000));
    })
    .catch((err) => {
      dispatch({ type: "bump_preview" });
      void import("./ui/hints").then(({ reportToolError }) => reportToolError(what, err));
    })
    .finally(() => void import("./ui/statusbar").then(({ publishBusy }) => publishBusy(null)));
}

export interface LayerActionItem {
  kind: "item";
  label: string;
  testid: string;
  disabled?: boolean;
  run: (dispatch: Dispatch) => void;
  /** What this does, in outcome words, the way every other hint in the
   * app is written (UI rule 3: lead with what the user gets). */
  hint?: string;
  /** Where it DOES apply, for when it is grayed.
   *
   * "When a menu item is disabled, we could update the tool
   * tip to inform the user on the context it is enabled so there is
   * direction, guidance. Not just a 'sorry, bro. can't use this' with
   * no clear explanation." So a grayed item still says what it is for,
   * and then says what would make it live. Written as an instruction
   * rather than a diagnosis: "Select the group's own row", not "not a
   * group".
   */
  why?: string;
  /** the group this action drops the layer into, so the panel can
   * open it and show where the layer went */
  opensGroup?: string;
  /** The gesture that does the same from the panel, shown where a menu
   * shows a key (Disable Layer Mask: "Shift-click the mask button"). */
  keys?: string;
}

/** Turns a layer's mask off, or back on (2026-10-01: "yes, build
 * disable mask"): one undo step, the mask's data untouched, and the
 * status line says what the picture now does. The one dispatch
 * behind every seat: the Finish mask button's Shift-click, the
 * Develop mask button, the Layer menu and the layer's right-click
 * menu.*/
export function toggleLayerMask(dispatch: Dispatch, maskId: string, off: boolean): void {
  dispatch({ type: "set_param", id: maskId, param: "mask_off", value: off ? 0 : 1 });
  const line = off
    ? "Mask on: the layer applies through its mask again."
    : `Mask off: the layer applies everywhere. The mask is kept, and strokes still go into it; ${MASK_OFF_GESTURE.toLowerCase()} again to turn it back on.`;
  void import("./ui/hints").then(({ flashStatus }) => flashStatus(line, 6000));
}

/** Disable Layer Mask, or Enable Layer Mask while it is off: one item
 * whose label flips, grayed with a reason when there is no mask. */
export function maskToggleItem(target: { maskId: string; off: boolean } | { maskId: null; why: string }): LayerActionItem {
  const off = target.maskId !== null && target.off;
  return {
    kind: "item",
    label: off ? "Enable Layer Mask" : "Disable Layer Mask",
    testid: "art-menu-mask-disable",
    disabled: target.maskId === null,
    hint: off
      ? "Turn the mask back on, so the layer applies through it again."
      : "Turn the mask off but keep it: the layer applies everywhere, Depth mask included.",
    why: target.maskId === null ? target.why : undefined,
    keys: MASK_OFF_GESTURE,
    run: (d) => target.maskId !== null && toggleLayerMask(d, target.maskId, target.off),
  };
}

export type LayerAction =
  | { kind: "sep" }
  | LayerActionItem
  /** A fold-out, for a list that grows with the document.
   * "the context menu for adding to groups should expand a submenu that
   * shows available groups. It keeps the context menu from scaling out
   * of control if there many groups added."*/
  | {
      kind: "submenu";
      label: string;
      testid: string;
      disabled?: boolean;
      hint?: string;
      why?: string;
      items: LayerActionItem[];
    };

/** The line the status row shows for one of these: what it does, and
 * when it is grayed, what would make it live.
 *
 * Composed here rather than in each renderer, so the panel's right-click
 * menu and the menu bar cannot say two different things about the same
 * item. */
export function layerActionHint(
  a: LayerAction,
): string | undefined {
  if (a.kind === "sep") return undefined;
  if (!a.hint) return undefined;
  return a.disabled && a.why ? `${a.hint} ${a.why}` : a.hint;
}

const sep: LayerAction = { kind: "sep" };

/** Trims separators that ended up at an edge or next to each other,
 * which is what happens when the items around them do not apply. */
function tidy(actions: LayerAction[]): LayerAction[] {
  const out: LayerAction[] = [];
  for (const a of actions) {
    if (a.kind === "sep" && (!out.length || out[out.length - 1].kind === "sep")) continue;
    out.push(a);
  }
  while (out.length && out[out.length - 1].kind === "sep") out.pop();
  return out;
}

/** Every action for the layer `id`, top level or inside a group.
 *
 * `id` is the carrier's id: the blend at the top level, and the blend
 * that carries a member inside a group (it was a merge before
 * 2026-08-27, which is why a mask had nowhere to land).
 *
 * `null`, or an id nothing answers to, is the no-selection case and
 * gets the same list with every item grayed. That is the whole point of
 * the list being a fixed shape: the Layer menu used to collapse to a
 * single "No Layer Selected" line, which answered the question nobody
 * asked and hid the answer to the one they did.
 */
export function layerActions(s: State, id: string | null): LayerAction[] {
  const found = id ? artFindLayer(s, id) : undefined;
  // Nothing to act ON, so nothing acts; the shape below is unchanged
  // and every `disabled` picks this up.
  const none = !found;
  const top = artLayers(s);
  const isGroup = !!found?.content.isGroup;
  const inGroup = found?.groupId;
  const at = top.findIndex((l) => l.blend.id === id);
  const mask = id && found ? artMaskOf(s, id) : undefined;
  // Members are ordered bottom-up like the stack itself.
  const siblings = inGroup
    ? artGroupMembers(top.find((l) => l.content.id === inGroup)!.content)
    : [];
  const memberAt = siblings.findIndex((m) => m.merge.id === id);
  // A group made before members carried blends chains merges, and a
  // merge has no mask port: offering a mask there would be a button
  // that dispatches into a reducer that refuses it.
  const canMask = !none && found.carrier.type !== "heeler.merge";
  const groups = top.filter((l) => l.content.isGroup);
  const selected = s.artSelected.length > 1 ? s.artSelected : [];
  // What Group would act on: the multi-selection when there is one,
  // otherwise the layer this menu was opened on. A menu that acts on
  // something other than what you aimed at is a trap, and with no
  // fallback at all the item could never apply to a single layer.
  const groupIds = selected.length ? selected : id ? [id] : [];
  // Offered exactly when art_group_layers would accept it, by asking
  // the reducer's own predicate rather than restating it.
  const canGroup = !none && canGroupLayers(s, groupIds);
  const clipped = (found?.carrier.params.clip ?? 0) !== 0;
  // Every item's first answer when the stack has no active layer, so
  // the grayed menu still points somewhere rather than just sitting
  // there. The panel is where a layer becomes active, so that is what
  // it names.
  const PICK = "Select a layer in the FINISH panel first.";

  return tidy([
    {
      kind: "item",
      label: "Rename…",
      testid: "art-menu-rename",
      disabled: none,
      hint: "Give this layer your own name, so the stack reads as the picture rather than as a list of kinds.",
      why: PICK,
      // The caller starts the inline edit; there is nothing to dispatch
      // until a new name exists.
      run: () => {},
    },
    // A copy above the original (Finish image layers, 2026-09-30: "a
    // normal Finish layer ... duplicate"). Top-level layers; a group or
    // a group's member says why not.
    {
      kind: "item",
      label: "Duplicate Layer",
      testid: "art-menu-duplicate",
      disabled: none || isGroup || !!inGroup,
      hint: "A copy of this layer just above it, with its mask, effects and placement.",
      why: none ? PICK : "Groups and layers inside groups cannot be duplicated.",
      run: (d: Dispatch) => id && d({ type: "art_duplicate_layer", id }),
    },
    // Bake Warp (2026-09-30: "both the [layer editor] way and a way to
    // commit/bake a warp could be useful"): a Warp layer's errand, grayed on
    // every other layer, where it says which layer it is for.
    {
      kind: "item",
      label: "Bake Warp",
      testid: "art-menu-bake-warp",
      disabled: !bakeableWarp(s, id),
      hint: BAKE_WARP_HINT,
      why: none ? PICK : "Works on a Warp layer. Select one first.",
      run: (d: Dispatch) => id && runBakeWarp(s, d, id),
    },
    // Unbake (2026-10-01: "go ahead with 1 and 2", 2 being "keep the warp's
    // settings on the baked layer so it can be unbaked"): beside Bake Warp,
    // live on a layer Bake Warp made, grayed elsewhere saying which layer it
    // is for. Layer via Copy's layers have no warp.
    {
      kind: "item",
      label: "Unbake",
      testid: "art-menu-unbake-warp",
      disabled: !unbakeableWarp(s, id),
      hint: UNBAKE_WARP_HINT,
      why: none ? PICK : "Works on a layer Bake Warp made. Select one first.",
      run: (d: Dispatch) => id && d({ type: "art_unbake_warp", id }),
    },
    sep,
    // Always offered, disabled until a run of layers can take it.
    //
    // It used to appear only once two layers were selected, so a menu
    // showing Delete Layer had no Group Layers beside it and the command
    // read as missing rather than as unavailable. "the
    // Delete Layer function is there but not the Group Layers function."
    // A grayed item says "not yet"; an absent one says "not here".
    //
    // canGroup is art_group_layers' own acceptance rule, so what the
    // item says about itself is what would actually happen.
    {
      kind: "item" as const,
      label: selected.length ? `Group ${selected.length} Layers` : "Group Layer",
      testid: "art-menu-group",
      disabled: !canGroup,
      hint: "Put layers into one group you can move, hide, mask and blend as a single thing.",
      why: none
        ? PICK
        : selected.length
          ? "Those layers are not next to each other, or one is already a group."
          : "Select two or more layers that sit next to each other in the stack.",
      run: (d: Dispatch) => d({ type: "art_group_layers", ids: groupIds }),
    },
    // The three group errands, each in its own seat whether or not this
    // layer is in a position to run it. Which one is live says where
    // the layer sits: only a group ungroups, only a member leaves one,
    // only a loose top-level layer joins one.
    {
      kind: "item",
      label: "Ungroup",
      testid: "art-menu-ungroup",
      disabled: !isGroup,
      hint: "Break a group open and hand its layers back to the stack, keeping each one.",
      why: none ? PICK : "Works on a group. Select the group's own row rather than a layer inside it.",
      run: (d) => id && d({ type: "art_ungroup", id }),
    },
    {
      kind: "item",
      label: "Remove from Group",
      testid: "art-menu-remove-from-group",
      disabled: !inGroup,
      hint: "Lift this layer out of its group, back into the main stack.",
      why: none ? PICK : "Works on a layer inside a group. Open a group and select one of its rows.",
      run: (d) => id && d({ type: "art_remove_from_group", id }),
    },
    // Add to Group: a fold-out, because the list is as long as the
    // document has groups and a menu that grows with the document is a
    // menu that eventually does not fit. Grayed rather than gone when
    // there is nowhere to add to, which also answers "can layers be
    // grouped at all?" the first time somebody looks.
    {
      kind: "submenu",
      label: "Add to Group…",
      testid: "art-menu-add-to-group",
      disabled: none || !!inGroup || isGroup || !groups.length,
      hint: "Move this layer into a group already in this document.",
      why: none
        ? PICK
        : inGroup
          ? "This layer is already in a group. Remove it from that one first."
          : isGroup
            ? "A group cannot go inside another group: groups are one level deep."
            : "There are no groups yet. Select two layers that sit next to each other and choose Group Layers.",
      items: groups.map((g) => ({
        kind: "item" as const,
        label: g.blend.name,
        testid: `art-menu-add-to-${g.blend.id}`,
        opensGroup: g.content.id,
        run: (d: Dispatch) => id && d({ type: "art_add_to_group", id, groupId: g.blend.id }),
      })),
    },
    sep,
    {
      kind: "item",
      label: "Move Up",
      testid: "art-menu-up",
      disabled: none || (inGroup ? memberAt >= siblings.length - 1 : at >= top.length - 1),
      hint: "Move this layer one place up, in front of the one above it.",
      why: none ? PICK : "This layer is already at the top of the stack.",
      run: (d) =>
        id &&
        (inGroup
          ? d({ type: "art_move_member", id, delta: 1 })
          : d({ type: "art_move_layer", id, delta: 1 })),
    },
    {
      kind: "item",
      label: "Move Down",
      testid: "art-menu-down",
      disabled: none || (inGroup ? memberAt <= 0 : at <= 0),
      hint: "Move this layer one place down, behind the one below it.",
      why: none ? PICK : "This layer is already at the bottom of the stack.",
      run: (d) =>
        id &&
        (inGroup
          ? d({ type: "art_move_member", id, delta: -1 })
          : d({ type: "art_move_layer", id, delta: -1 })),
    },
    sep,
    // Clipping is a top-level relationship: a member composites inside
    // its group, where there is no layer below in the stack's sense. So
    // the item is grayed inside a group rather than absent from it.
    //
    // One seat and a label that turns over, which is not the hiding this
    // list has stopped doing: Create and Release are two directions of
    // one command, and a menu offering both at once would be asking
    // which way you meant.
    clipped
      ? {
          kind: "item",
          label: "Release Clipping Mask",
          testid: "art-menu-unclip",
          disabled: none || !!inGroup,
          hint: "Stop clipping this layer to the one below it, so it paints over the whole frame again.",
          why: none ? PICK : "Take the layer out of its group to release it.",
          run: (d: Dispatch) => id && d({ type: "art_clip_layer", id, clip: false }),
        }
      : {
          kind: "item",
          label: "Create Clipping Mask",
          testid: "art-menu-clip",
          disabled: none || !!inGroup || at <= 0,
          hint: "Show this layer only where the one below it shows, so a layer shapes the next.",
          why: none
            ? PICK
            : inGroup
              ? "Inside a group there is no layer below to clip to."
              : "There is no layer under this one. Move it up, or put a layer beneath it.",
          run: (d: Dispatch) => id && d({ type: "art_clip_layer", id, clip: true }),
        },
    sep,
    // Three mask seats, always all three. This block used to swap two items
    // for one the moment a mask existed, which is the change in height the
    // owner was reading as the menu rearranging itself under him, and it
    // meant a layer WITH a mask never showed that Smart Mask was a thing
    // the app could do.
    {
      kind: "item",
      label: "Add Layer Mask",
      testid: "art-menu-mask-add",
      disabled: !canMask || !!mask,
      hint: "Add a mask you paint by hand, to show this layer in some places and hide it in others.",
      why: none
        ? PICK
        : mask
          ? "This layer already has a mask. Remove it first, or paint on it."
          : "An older group that cannot carry masks. Ungroup it and group it again.",
      run: (d) => id && d({ type: "art_add_mask", id, edit: true }),
    },
    {
      kind: "item",
      label: "Add Smart Mask",
      testid: "art-menu-mask-smart",
      disabled: !canMask || !!mask,
      hint: "Add a mask the model works out from whatever you point at, then paint to correct it.",
      why: none
        ? PICK
        : mask
          ? "This layer already has a mask. Remove that one first."
          : "An older group that cannot carry masks. Ungroup it and group it again.",
      run: (d) => {
        if (!id) return;
        d({ type: "art_add_mask", id, kind: "smart", edit: true });
      },
    },
    {
      kind: "item",
      label: "Remove Layer Mask",
      testid: "art-menu-mask-remove",
      disabled: !mask,
      hint: "Throw this layer's mask away, so the layer shows everywhere again.",
      why: none ? PICK : "This layer has no mask yet. Add one first.",
      run: (d) => id && d({ type: "art_remove_mask", id }),
    },
    maskToggleItem(mask ? { maskId: mask.id, off: maskIsOff(mask) } : { maskId: null, why: none ? PICK : "This layer has no mask yet. Add one first." }),
    sep,
    {
      kind: "item",
      label: "Delete Layer",
      testid: "art-menu-delete",
      disabled: none,
      hint: "Take this layer out of the stack for good. Undo brings it back.",
      why: PICK,
      run: (d) => id && d({ type: "art_remove_layer", id }),
    },
  ]);
}
