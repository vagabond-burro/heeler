// A menu item keeps its seat and grays out, rather than disappearing.
//
// On what the Layer menu was doing:
//
//   "Hiding unavailable menu items. This causes the menu to change
//   height and it's not clear what are all the possible tools that
//   could be available. The preferred way to work, in a vast majority
//   of apps, is to disable a menu item when it's out of context."
//
// and on what a grayed item owes the reader:
//
//   "When a menu item is disabled, we could update the tool tip to
//   inform the user on the context it is enabled so there is direction,
//   guidance. Not just a 'sorry, bro. can't use this' with no clear
//   explanation. Summarize what it is... then add why and where it is
//   used."
//
// Both are properties of one list (src/layeractions.ts), which the
// panel's right-click menu and the menu bar both read, so both are
// checked here against that list rather than against either menu.

import { describe, expect, it } from "vitest";
import { initialState } from "../data";
import { layerActionHint, layerActions, type LayerAction } from "../layeractions";
import { artGroupMembers, artLayers, reduce, type Command, type State } from "../state";

const run = (s: State, ...cmds: Command[]) => cmds.reduce(reduce, s);
const items = (a: LayerAction[]) => a.filter((x) => x.kind !== "sep");
const seats = (a: LayerAction[]) => items(a).map((x) => (x as { testid: string }).testid);
type Named = Extract<LayerAction, { testid: string }>;
const find = (a: LayerAction[], testid: string): Named | undefined =>
  items(a).find((x) => (x as Named).testid === testid) as Named | undefined;

/** A stack of two paint layers, and the group made from them.
 *
 * Grouping re-carries the members, so the ids to act on afterwards are
 * read back out of the state rather than remembered from before it. */
function withGroup(): { s: State; groupId: string; memberId: string } {
  let s = run(initialState(), { type: "art_add_layer", kind: "paint" }, { type: "art_add_layer", kind: "paint" });
  const before = artLayers(s).map((l) => l.blend.id);
  s = run(s, { type: "select_art_layers", ids: before }, { type: "art_group_layers", ids: before });
  const group = artLayers(s).find((l) => l.content.isGroup)!;
  return {
    s,
    groupId: group.blend.id,
    memberId: artGroupMembers(group.content)[0].merge.id,
  };
}

describe("the list is one shape, whatever is selected", () => {
  it("hands back the same seats for a layer, a group, a member and nothing at all", () => {
    const { s, groupId, memberId } = withGroup();
    const plain = run(s, { type: "art_add_layer", kind: "paint" });
    const loose = plain.artActive!;

    const shapes = [
      seats(layerActions(plain, loose)),
      seats(layerActions(s, groupId)),
      seats(layerActions(s, memberId)),
      seats(layerActions(s, null)),
    ];
    // Every one of them, the same list in the same order. That is the
    // menu not changing height, stated as a fact about the data.
    for (const shape of shapes) expect(shape).toEqual(shapes[0]);
    // And it is the whole list, not a stub: the "No Layer Selected"
    // placeholder is gone.
    expect(shapes[0]).toContain("art-menu-ungroup");
    expect(shapes[0]).toContain("art-menu-add-to-group");
    expect(shapes[0]).toContain("art-menu-mask-remove");
    expect(shapes[0]).not.toContain("menu-layer-none");
  });

  it("keeps all three mask seats whether or not the layer has a mask", () => {
    // This block used to swap two items for one the moment a mask
    // existed, so a layer WITH a mask never showed that Smart Mask was
    // a thing the app could do.
    let s = run(initialState(), { type: "art_add_layer", kind: "paint" });
    const id = s.artActive!;
    const before = layerActions(s, id);
    expect(find(before, "art-menu-mask-add")!.disabled).toBeFalsy();
    expect(find(before, "art-menu-mask-remove")!.disabled).toBe(true);

    s = run(s, { type: "art_add_mask", id });
    const after = layerActions(s, id);
    expect(seats(after)).toEqual(seats(before));
    expect(find(after, "art-menu-mask-add")!.disabled).toBe(true);
    expect(find(after, "art-menu-mask-smart")!.disabled).toBe(true);
    expect(find(after, "art-menu-mask-remove")!.disabled).toBeFalsy();
  });

  it("still turns Create Clipping Mask over into Release, which is not the same thing as hiding", () => {
    // One command with two directions gets one seat and a label that
    // says which way it goes. Offering both at once would be asking
    // which the user meant.
    let s = run(initialState(), { type: "art_add_layer", kind: "paint" }, { type: "art_add_layer", kind: "paint" });
    const id = s.artActive!;
    expect(find(layerActions(s, id), "art-menu-clip")).toBeDefined();
    s = run(s, { type: "art_clip_layer", id, clip: true });
    expect(find(layerActions(s, id), "art-menu-unclip")).toBeDefined();
    expect(find(layerActions(s, id), "art-menu-clip")).toBeUndefined();
  });

  it("lights exactly the group errand that belongs to where the layer sits", () => {
    const { s, groupId, memberId } = withGroup();
    const off = (a: LayerAction[], t: string) => find(a, t)!.disabled;
    // A group ungroups and does nothing else.
    expect(off(layerActions(s, groupId), "art-menu-ungroup")).toBeFalsy();
    expect(off(layerActions(s, groupId), "art-menu-remove-from-group")).toBe(true);
    expect(off(layerActions(s, groupId), "art-menu-add-to-group")).toBe(true);
    // A member leaves its group and does nothing else.
    expect(off(layerActions(s, memberId), "art-menu-remove-from-group")).toBeFalsy();
    expect(off(layerActions(s, memberId), "art-menu-ungroup")).toBe(true);
  });
});

describe("a grayed item says what it is for and how to reach it", () => {
  it("gives every item a hint, grayed or not", () => {
    const { s, groupId } = withGroup();
    for (const a of items(layerActions(s, groupId))) {
      expect(layerActionHint(a), (a as { testid: string }).testid).toBeTruthy();
    }
  });

  it("adds the way in only when the item is off", () => {
    let s = run(initialState(), { type: "art_add_layer", kind: "paint" });
    const id = s.artActive!;
    const live = find(layerActions(s, id), "art-menu-mask-add")!;
    // Live: what it does, and nothing about conditions.
    expect(layerActionHint(live)).toBe(live.hint);

    s = run(s, { type: "art_add_mask", id });
    const off = find(layerActions(s, id), "art-menu-mask-add")!;
    // Off: still what it does, then what would make it live.
    expect(layerActionHint(off)).toBe(`${off.hint} ${off.why}`);
    expect(layerActionHint(off)).toContain("Remove it first");
  });

  it("points at the panel when nothing is selected, rather than shrugging", () => {
    // The state a person is in when they open the Layer menu to find
    // out what layers even are.
    for (const a of items(layerActions(initialState(), null))) {
      const hint = layerActionHint(a)!;
      expect(hint, (a as { testid: string }).testid).toContain("FINISH panel");
    }
  });

  it("tells a member why clipping is off, in words that name the way out", () => {
    const { s, memberId } = withGroup();
    const hint = layerActionHint(find(layerActions(s, memberId), "art-menu-clip")!)!;
    expect(hint).toContain("no layer below");
    // An instruction, not a diagnosis: "not a top-level layer" tells
    // you what you are, this tells you what to do.
    expect(layerActionHint(find(layerActions(s, memberId), "art-menu-ungroup")!)).toContain(
      "Select the group's own row",
    );
  });

  it("keeps hints concise in every disabled state", () => {
    // A character cap is an editorial guard, not a width measurement.
    // The test browser on macOS, 1100px window, 11px Archivo with .02em spacing:
    // all fixture hints fit 848.7px; the widest was 750.8px (2026-09-12).
    // Retain the conservative cap. New wording still needs a rendered
    // check: glyph widths vary, and smaller windows can truncate hints.
    const ROOM = 151;
    const { s, groupId, memberId } = withGroup();
    let masked = run(initialState(), { type: "art_add_layer", kind: "paint" });
    masked = run(masked, { type: "art_add_mask", id: masked.artActive! });
    const over: string[] = [];
    // Every state the list has an answer for, so a hint that only shows
    // up in one of them cannot slip past.
    for (const [label, st, id] of [
      ["nothing", initialState(), null],
      ["group", s, groupId],
      ["member", s, memberId],
      ["masked", masked, masked.artActive!],
    ] as [string, State, string | null][]) {
      for (const a of items(layerActions(st, id))) {
        const hint = layerActionHint(a) ?? "";
        if (hint.length > ROOM) over.push(`${label}/${(a as Named).testid} (${hint.length})`);
      }
    }
    expect(over).toEqual([]);
  });

  it("says something different about an empty document than about a full one", () => {
    // Add to Group is off for two quite different reasons and must not
    // give the same answer to both.
    const fresh = run(initialState(), { type: "art_add_layer", kind: "paint" });
    const lonely = layerActionHint(find(layerActions(fresh, fresh.artActive!), "art-menu-add-to-group")!)!;
    expect(lonely).toContain("no groups yet");

    const { s, memberId } = withGroup();
    const already = layerActionHint(find(layerActions(s, memberId), "art-menu-add-to-group")!)!;
    expect(already).toContain("already in a group");
  });
});
