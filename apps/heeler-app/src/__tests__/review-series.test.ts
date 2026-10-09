import { afterEach, expect, it } from "vitest";
import { initialState } from "../data";
import { reduce, spliceIn, spliceOut, type State, type Command } from "../state";
import { armAutosave, flushAutosave } from "../autosave";
import { loadGraph, saveGraph } from "../bridge";
import { unlinkPhotos } from "../links";

const run = (s: State, ...commands: Command[]) => commands.reduce(reduce, s);
afterEach(async () => { await flushAutosave(); });
const exposure = (g: { nodes: any[] } | null) => g?.nodes.find(n => n.id === "exposure")?.params.exposure;

it("unlink keeps an owed mirrored write even when the file has no overrides", async () => {
  const base = initialState();
  const id = "4866";
  const nodes = structuredClone(base.nodes);
  nodes.find(n => n.id === "exposure")!.params.exposure = 1.25;
  await saveGraph(id, { nodes: base.nodes, wires: base.wires });
  const s = run(base, { type: "set_link_group", ids: [base.activeImage, id], group: "review" },
    { type: "stash_graphs", graphs: { [id]: { nodes, wires: base.wires } } });
  armAutosave(id, 60000, revision => saveGraph(id, { nodes, wires: base.wires }, true, revision));
  await unlinkPhotos(s, () => {}, [id]);
  expect(exposure(await loadGraph(id))).toBe(1.25);
});

it("unlink clears the active file even before React rearms its autosave", async () => {
  const base = initialState();
  const s = run(base, { type: "set_link_group", ids: [base.activeImage, "4866"], group: "review" },
    { type: "toggle_link_override", keys: ["node:exposure"] });
  const payload = { nodes: s.nodes, wires: s.wires, linkOverrides: s.linkOverrides };
  armAutosave(s.activeImage, 60000, revision => saveGraph(s.activeImage, payload, true, revision));
  await unlinkPhotos(s, () => {}, [s.activeImage]);
  expect((await loadGraph(s.activeImage))?.linkOverrides).toEqual([]);
});

it("a linked factory reset cannot restore the member's pending deltas", () => {
  let s = initialState();
  s = run(s, { type: "set_link_group", ids: [s.activeImage, "4866"], group: "review" },
    { type: "set_param", id: "exposure", param: "exposure", value: 1 });
  const pending = s.linkPending;
  s = reduce(s, { type: "stash_graphs", graphs: { "4866": { nodes: s.nodes, wires: s.wires } } });
  // A reset must clear the debt even if the read and the reset meet.
  s = { ...s, linkPending: pending };
  const reset = reduce(s, { type: "reset_image_edits", id: s.activeImage });
  expect(reset.linkPending?.["4866"]).toBeUndefined();
});

it("resetting an unread thumbnail drops that photograph's old debt", () => {
  let s = initialState();
  s = run(s, { type: "set_link_group", ids: [s.activeImage, "4866"], group: "review" },
    { type: "set_param", id: "exposure", param: "exposure", value: 1 });
  expect(s.linkPending?.["4866"]?.length).toBeGreaterThan(0);
  const reset = reduce(s, { type: "reset_image_edits", id: "4866" });
  expect(reset.linkPending?.["4866"]).toBeUndefined();
});

const oldOrder = ["src", "merge", "crop", "lens", "stdcolor", "cbal", "curves", "levels", "exposure", "bw", "denoise", "sharpen", "grain", "bend", "profile", "output"];
function earlyTone(order = oldOrder): State {
  const s = initialState();
  return { ...s, wires: spliceIn(spliceIn(spliceOut(spliceOut(s.wires, "curves"), "levels"), "levels", order), "curves", order) };
}
function afterProfile(s: State, id: string): boolean {
  const seen = new Set<string>();
  while (!seen.has(id)) {
    if (id === "profile") return true;
    seen.add(id);
    const feed = s.wires.find(w => w.to === id && w.toPort === "in");
    if (!feed) return false;
    id = feed.from;
  }
  return false;
}
it.each([["curves", false], ["curves", true], ["levels", false], ["levels", true]] as const)("the neutral companion migrates when early %s is edited, reverse order=%s", (edited, reverse) => {
  const order = reverse ? oldOrder.map(id => id === "curves" ? "levels" : id === "levels" ? "curves" : id) : oldOrder;
  let s = earlyTone(order);
  s = edited === "curves" ? reduce(s, { type: "set_curve", id: "curves", channel: "rgb", curve: [[0, 0], [0.5, 0.8], [1, 1]] })
    : reduce(s, { type: "set_param", id: "levels", param: "black", value: 0.1 });
  const next = run(s, { type: "move_curves_late" }, { type: "move_levels_late" });
  expect(afterProfile(next, edited)).toBe(false);
  expect(afterProfile(next, edited === "curves" ? "levels" : "curves")).toBe(true);
});

it("a group between the profile and neutral Levels is already downstream", () => {
  const s = initialState();
  const group = { ...s.nodes[0], id: "custom_group", type: "heeler.group", isGroup: true };
  const wires = s.wires.flatMap(w => w.from === "profile" && w.to === "levels"
    ? [{ ...w, to: group.id }, { ...w, from: group.id }] : [w]);
  const before = { ...s, nodes: [...s.nodes, group], wires };
  expect(reduce(before, { type: "move_levels_late" }).wires).toEqual(wires);
});
