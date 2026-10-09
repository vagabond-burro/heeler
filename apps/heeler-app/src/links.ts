// Linked photographs (2026-09-09): "Select a bunch and select to link
// them. Then any edits applied to one of the linked applies to the
// others." A link is a group id on each photograph in the catalog; the
// reducer mirrors the active photograph's edits onto the other members
// as relative deltas (state.ts linkMirror, the quad's own mirror), and
// GraphPersistence writes the members' graphs to disk and refreshes
// their thumbnails. This file is the two actions the menus call.

import { armAutosave, flushAutosave } from "./autosave";
import { loadGraph, setImageLinkGroup } from "./bridge";
import { writeGraphKeepingTakes } from "./copyedits";
import { logMsg } from "./log";
import type { Command, State } from "./state";

type D = (cmd: Command) => void;

/** What Link Selected would do with this selection: start a new link,
 * add the unlinked ones to the one link among them, or merge the links
 * among them into one (2026-09-09: "if I select one photo that is
 * linked, select another that has not been linked, that new photo gets
 * added into the already linked photos"). Values are not synced on
 * joining: a link is a live relationship, each member moves by the
 * same delta from wherever it is; Match to This Photo is the
 * deliberate sync.*/
export function linkPlan(state: State, ids: string[]): { kind: "new" | "join" | "merge" | "none"; sel: string[]; groups: string[]; newcomers: string[] } {
  const sel = [...new Set(ids)].filter((id) => state.images.some((i) => i.id === id));
  const groups = [...new Set(sel.map((id) => state.images.find((i) => i.id === id)?.linkGroup).filter((g): g is string => !!g))];
  const newcomers = sel.filter((id) => !state.images.find((i) => i.id === id)?.linkGroup);
  if (sel.length < 2) return { kind: "none", sel, groups, newcomers };
  if (groups.length === 0) return { kind: "new", sel, groups, newcomers };
  if (groups.length === 1) return { kind: newcomers.length ? "join" : "none", sel, groups, newcomers };
  return { kind: "merge", sel, groups, newcomers };
}

/** The Link Selected hint for this selection, grayed or not. */
export function linkHint(state: State, ids: string[]): { disabled: boolean; hint: string } {
  const plan = linkPlan(state, ids);
  const n = (count: number) => (count === 1 ? "1 photograph" : `${count} photographs`);
  switch (plan.kind) {
    case "new":
      return { disabled: false, hint: "Links the selected photographs: an edit to any one lands on the others as relative changes, whichever is open." };
    case "join":
      return { disabled: false, hint: `Adds ${n(plan.newcomers.length)} to the link the others are in; each keeps its own edit and moves with the link from here.` };
    case "merge":
      return { disabled: false, hint: `Merges the ${plan.groups.length} links among the selected into one${plan.newcomers.length ? `, with ${n(plan.newcomers.length)} joining` : ""}; every member of each comes along.` };
    default:
      return {
        disabled: true,
        hint: plan.sel.length < 2 ? "Select two or more photographs in the thumbnails." : "These are already linked together. Select a photograph outside the link to add it.",
      };
  }
}

/** Strips the link overrides from these photographs' graph files, the
 * reducer having dropped them from the state (2026-09-13: unlinking
 * must leave no override behind). Overrides mean something only inside
 * a link, and a file that kept them would hand them back the next time
 * the photograph was read into one. Finish the owed writes FIRST:
 * arming cleanup replaces a queued edit, even when cleanup then finds
 * no overrides and writes nothing. Read the saved result, including
 * the active photo's, so a stale stash or an old active autosave
 * cannot put the old edit or overrides back.*/
async function dropOverrideFiles(state: State, ids: string[]): Promise<void> {
  if (!ids.length) return;
  await flushAutosave();
  for (const id of ids) {
    const edited = (state.images.find((i) => i.id === id)?.edited ?? false) || state.linkDirty.includes(id);
    armAutosave(id, 0, async (revision) => {
      const file = await loadGraph(id);
      if (!file?.linkOverrides?.length) return;
      const graph = { nodes: file.nodes, wires: file.wires, backdrops: file.backdrops ?? [] };
      await writeGraphKeepingTakes(id, { ...graph, linkOverrides: [] }, revision, edited, state.images.find(i => i.id === id));
    });
  }
  await flushAutosave();
}

/** Links the photographs: a new link when none of them is linked, the
 * newcomers into the one link among them, or the links among them
 * merged into one (every member of each, selected or not). Linking
 * never shrinks a link. Two or more; already all in one link is a
 * no-op. */
export async function linkPhotos(state: State, dispatch: D, ids: string[]): Promise<string | null> {
  const plan = linkPlan(state, ids);
  if (plan.kind === "none") return null;
  const group = plan.kind === "new" ? `link_${Date.now().toString(36)}` : plan.groups[0];
  const members =
    plan.kind === "merge"
      ? [...new Set([...plan.sel, ...state.images.filter((i) => i.linkGroup && plan.groups.includes(i.linkGroup)).map((i) => i.id)])]
      : plan.sel;
  const moving = members.filter((id) => state.images.find((i) => i.id === id)?.linkGroup !== group);
  // A newcomer brings no overrides in: its file is cleaned before the
  // link reads it (a file unlinked before overrides were cleared on
  // unlink still carries them).
  try {
    await dropOverrideFiles(state, moving.filter((id) => !state.images.find((i) => i.id === id)?.linkGroup));
    await setImageLinkGroup(moving, group);
    dispatch({ type: "set_link_group", ids: moving, group });
  } catch (e) {
    logMsg("error", `Could not save the link: ${String(e)}`);
    return null;
  }
  const total = state.images.filter((i) => i.linkGroup === group).length + moving.length;
  if (plan.kind === "new") logMsg("info", `Linked ${members.length} photographs: edits to one land on the others`);
  else if (plan.kind === "join") logMsg("info", `Added ${moving.length} to the link, now ${total} photographs`);
  else logMsg("info", `Merged ${plan.groups.length} links into one of ${total} photographs`);
  return group;
}

/** Takes the photographs out of their links. The rest of each group
 * stays linked. */
export async function unlinkPhotos(state: State, dispatch: D, ids: string[]): Promise<number> {
  const sel = [...new Set(ids)].filter((id) => state.images.find((i) => i.id === id)?.linkGroup);
  if (sel.length === 0) return 0;
  try {
    await dropOverrideFiles(state, sel);
    await setImageLinkGroup(sel, null);
    dispatch({ type: "set_link_group", ids: sel, group: null });
  } catch (e) {
    logMsg("error", `Could not save the unlink: ${String(e)}`);
    return 0;
  }
  return sel.length;
}

/** The other members of the active photograph's link, if any. */
export function linkedWith(state: State, id: string): string[] {
  const group = state.images.find((i) => i.id === id)?.linkGroup;
  if (!group) return [];
  return state.images.filter((i) => i.linkGroup === group && i.id !== id).map((i) => i.id);
}
