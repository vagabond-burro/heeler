import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { App } from "../app";
import { initialState } from "../data";
import { freshGraphFor, reduce, type Command, type NodeCard, type State, type Wire } from "../state";
import { getEntries } from "../log";
import { linkPlan, linkedWith, linkPhotos, unlinkPhotos } from "../links";
import { within } from "@testing-library/react";

const run = (s: State, ...cmds: Command[]) => cmds.reduce(reduce, s);
const grade = (nodes: NodeCard[]) => nodes.find((n) => n.id === "portra")!.params.grade_strength;

/** The active photo linked with 4866 and 4867; 4866's graph is in the
 * stash with its grade balanced down to 40 against the driver's 78,
 * 4867's is not loaded yet. */
function linked(): State {
  const s0 = initialState();
  const balanced = structuredClone(s0.nodes);
  balanced.find((n) => n.id === "portra")!.params.grade_strength = 40;
  return run(
    s0,
    { type: "set_link_group", ids: [s0.activeImage, "4866", "4867"], group: "link_t" },
    { type: "stash_graphs", graphs: { "4866": { nodes: balanced, wires: structuredClone(s0.wires) } } },
  );
}

/* (2026-09-09): "Select a bunch and select to link them. Then any
 * edits applied to one of the linked applies to the others."*/
describe("linked photographs", () => {
  it("mirrors the driver's edit onto a linked member's stashed graph as a relative delta, and owes it a write", () => {
    const s = linked();
    expect(linkedWith(s, s.activeImage).sort()).toEqual(["4866", "4867"]);
    const before = grade(s.nodes);
    const edited = reduce(s, { type: "set_param", id: "portra", param: "grade_strength", value: before + 10 });
    expect(grade(edited.nodes)).toBe(before + 10);
    expect(grade(edited.graphs["4866"].nodes)).toBe(50);
    expect(edited.linkDirty).toEqual(["4866"]);
    // The member not yet in the stash is not invented.
    expect(edited.graphs["4867"]).toBeUndefined();
    // Undo on the driver mirrors the compensating delta.
    const undone = reduce(edited, { type: "undo" });
    expect(grade(undone.graphs["4866"].nodes)).toBe(40);
  });

  /* (2026-09-09): "I had selected 5 images and linked them. Then selected
   * two others and linked them. I did not apply any changes to the second
   * set of 2 I linked but for some reason their settings were changed"
   * (the exact negatives), and on the first group "values are multiplying
   * on each other". Stepping between photos with the arrow keys (and
   * every other command that switches through an inner select_image) was
   * mirroring the difference between the two photos' graphs as if it were
   * a drag.*/
  it("stepping to another photo is not an edit: neither link group takes the difference between two photos' graphs", () => {
    const s0 = initialState();
    // The sample opens on 4871. First group: 4871 with 4866..4869;
    // second group: 4872 with 4873. The members start from the
    // template, as a photo never opened does, so the dial is one the
    // template has: Exposure.
    const fresh = () => ({ nodes: structuredClone(s0.defaultGraph.nodes), wires: structuredClone(s0.defaultGraph.wires) });
    const exposure = (nodes: NodeCard[]) => nodes.find((n) => n.id === "exposure")!.params.exposure as number;
    const before = exposure(s0.nodes);
    let s = run(
      s0,
      { type: "set_link_group", ids: [s0.activeImage, "4866", "4867", "4868", "4869"], group: "link_1" },
      { type: "stash_graphs", graphs: { "4866": fresh(), "4867": fresh(), "4868": fresh(), "4869": fresh() } },
      { type: "set_param", id: "exposure", param: "exposure", value: before + 0.5 },
    );
    expect(exposure(s.graphs["4866"].nodes)).toBeCloseTo(0.5, 9);
    // Step onto 4872 (unlinked), link it with 4873, step onward and back.
    s = run(s, { type: "step_image", delta: 1 });
    expect(s.activeImage).toBe("4872");
    expect(exposure(s.nodes)).toBe(0);
    s = run(
      s,
      { type: "set_link_group", ids: ["4872", "4873"], group: "link_2" },
      { type: "stash_graphs", graphs: { "4873": fresh() } },
      { type: "step_image", delta: 1 },
      { type: "step_image", delta: -1 },
      { type: "select_images", ids: ["4871", "4866"] },
    );
    expect(s.activeImage).toBe("4871");
    // The untouched pair is still untouched, and nothing owes a write.
    expect(exposure(s.graphs["4872"].nodes)).toBe(0);
    expect(exposure(s.graphs["4873"].nodes)).toBe(0);
    expect([...s.linkDirty].sort()).toEqual(["4866", "4867", "4868", "4869"]);
    // The first group holds the single edit, not a doubled one.
    expect(exposure(s.nodes)).toBeCloseTo(before + 0.5, 9);
    for (const id of ["4866", "4867", "4868", "4869"]) expect(exposure(s.graphs[id].nodes)).toBeCloseTo(0.5, 9);
  });

  /* Review 2026-09-10: an edit queued for a member whose graph had not
   * loaded belongs to the link it was made in. Unlinking that member,
   * or moving it to another link, drops the queue, or the member would
   * take the old link's edit the moment its graph arrived. */
  it("unlinking or regrouping a member drops the edits queued for it", () => {
    const s0 = initialState();
    const exposure = (nodes: NodeCard[]) => nodes.find((n) => n.id === "exposure")!.params.exposure as number;
    const fresh = () => ({ nodes: structuredClone(s0.defaultGraph.nodes), wires: structuredClone(s0.defaultGraph.wires) });
    const before = exposure(s0.nodes);
    // 4866 is linked but its graph is not loaded: the edit queues.
    const queued = run(
      s0,
      { type: "set_link_group", ids: [s0.activeImage, "4866"], group: "link_q" },
      { type: "set_param", id: "exposure", param: "exposure", value: before + 0.5 },
    );
    expect(queued.linkPending?.["4866"]?.length).toBe(1);
    // Unlinked: the queue is gone, and a late load lands the saved graph as it was.
    const unlinked = run(queued, { type: "set_link_group", ids: ["4866"], group: null }, { type: "stash_graphs", graphs: { "4866": fresh() } });
    expect(unlinked.linkPending?.["4866"]).toBeUndefined();
    expect(exposure(unlinked.graphs["4866"].nodes)).toBe(0);
    // Moved to another link: the same.
    const moved = run(queued, { type: "set_link_group", ids: ["4866"], group: "link_other" });
    expect(moved.linkPending?.["4866"]).toBeUndefined();
  });

  it("a pinned member sits the edit out, an unlinked one never sees it, and a quad edit takes over", () => {
    const s = linked();
    const before = grade(s.nodes);
    const pinned = reduce(s, { type: "toggle_link_pin", id: "4866" });
    const edited = reduce(pinned, { type: "set_param", id: "portra", param: "grade_strength", value: before + 10 });
    expect(grade(edited.graphs["4866"].nodes)).toBe(40);
    expect(edited.linkDirty).toEqual([]);
    const unlinked = run(s, { type: "set_link_group", ids: ["4866"], group: null });
    expect(linkedWith(unlinked, unlinked.activeImage)).toEqual(["4867"]);
    const edited2 = reduce(unlinked, { type: "set_param", id: "portra", param: "grade_strength", value: before + 10 });
    expect(grade(edited2.graphs["4866"].nodes)).toBe(40);
  });

  it("unlinking clears the pin and the owed write for those photographs", () => {
    const s = linked();
    const before = grade(s.nodes);
    const dirty = run(s, { type: "toggle_link_pin", id: "4867" }, { type: "set_param", id: "portra", param: "grade_strength", value: before + 5 });
    expect(dirty.linkDirty).toEqual(["4866"]);
    const off = reduce(dirty, { type: "set_link_group", ids: [s.activeImage, "4866", "4867"], group: null });
    expect(off.linkDirty).toEqual([]);
    expect(off.linkPinned).toEqual([]);
    expect(off.images.every((i) => !i.linkGroup)).toBe(true);
  });

  it("a member's overrides keep a node or a dial as its own while the rest of the link lands", () => {
    const s0 = initialState();
    const balanced = structuredClone(s0.nodes);
    balanced.find((n) => n.id === "portra")!.params.grade_strength = 40;
    // 4866 overrides the whole portra node; 4867 overrides one dial of it.
    const s = run(
      s0,
      { type: "set_link_group", ids: [s0.activeImage, "4866", "4867"], group: "link_t" },
      { type: "stash_graphs", graphs: {
        "4866": { nodes: balanced, wires: structuredClone(s0.wires), linkOverrides: ["node:portra"] },
        "4867": { nodes: structuredClone(balanced), wires: structuredClone(s0.wires), linkOverrides: ["param:portra|grade_strength"] },
      } },
    );
    const before = grade(s.nodes);
    const edited = reduce(s, { type: "set_param", id: "portra", param: "grade_strength", value: before + 10 });
    expect(grade(edited.graphs["4866"].nodes)).toBe(40);
    expect(grade(edited.graphs["4867"].nodes)).toBe(40);
    expect(edited.linkDirty).toEqual([]);
    // A dial the overrides do not name still lands on both.
    const other = Object.keys(s.nodes.find((n) => n.id === "portra")!.params).find((k) => k !== "grade_strength" && typeof s.nodes.find((n) => n.id === "portra")!.params[k] === "number");
    if (other) {
      const was = (id: string) => (edited.graphs[id].nodes.find((n) => n.id === "portra")!.params[other] as number);
      const moved = reduce(edited, { type: "set_param", id: "portra", param: other, value: (edited.nodes.find((n) => n.id === "portra")!.params[other] as number) + 1 });
      expect(moved.graphs["4866"].nodes.find((n) => n.id === "portra")!.params[other]).toBe(was("4866"));
      expect(moved.graphs["4867"].nodes.find((n) => n.id === "portra")!.params[other]).not.toBe(was("4867"));
    }
  });

  it("an override cuts both ways: the driver's overridden node sends nothing to the link either", () => {
    // With Color overridden on one photo, raising its
    // saturation still moved the others. The overridden section is this
    // photo's own in both directions.
    const s0 = initialState();
    const balanced = structuredClone(s0.nodes);
    balanced.find((n) => n.id === "portra")!.params.grade_strength = 40;
    const s = run(
      s0,
      { type: "set_link_group", ids: [s0.activeImage, "4866"], group: "link_t" },
      { type: "stash_graphs", graphs: { "4866": { nodes: balanced, wires: structuredClone(s0.wires) } } },
      { type: "toggle_link_override", keys: ["node:portra"] },
    );
    const before = grade(s.nodes);
    const edited = reduce(s, { type: "set_param", id: "portra", param: "grade_strength", value: before + 10 });
    expect(grade(edited.nodes)).toBe(before + 10);
    expect(grade(edited.graphs["4866"].nodes)).toBe(40);
    expect(edited.linkDirty).toEqual([]);
  });

  it("the active photograph's overrides ride its stash and its file, and toggle all on or all off", () => {
    const s0 = initialState();
    const s = run(s0, { type: "toggle_link_override", keys: ["node:exposure", "node:levels"] });
    expect(s.linkOverrides).toEqual(["node:exposure", "node:levels"]);
    const half = reduce(s, { type: "toggle_link_override", keys: ["node:levels", "node:curves"] });
    expect(half.linkOverrides).toEqual(["node:exposure"]);
    const away = reduce(s, { type: "select_image", id: "4866" });
    expect(away.linkOverrides).toEqual([]);
    expect(away.graphs[s0.activeImage].overrides).toEqual(["node:exposure", "node:levels"]);
    const back = reduce(away, { type: "select_image", id: s0.activeImage });
    expect(back.linkOverrides).toEqual(["node:exposure", "node:levels"]);
    const fromFile = reduce(s0, { type: "replace_graph", nodes: s0.nodes, wires: s0.wires, overrides: ["param:exposure|exposure"] });
    expect(fromFile.linkOverrides).toEqual(["param:exposure|exposure"]);
  });

  it("inside a link, a section header and a dial offer the override on right-click and wear the dotted mark", async () => {
    const user = userEvent.setup();
    render(<App />);
    const thumbs = screen.getAllByTestId(/^thumb-\d+$/);
    await user.click(thumbs[0]);
    fireEvent.click(thumbs[1], { shiftKey: true });
    await user.click(screen.getByTestId("menu-photo"));
    await user.click(screen.getByTestId("menu-photo-link"));
    await waitFor(() => expect(screen.getByTestId("link-note")).toBeInTheDocument());
    // The section.
    fireEvent.contextMenu(screen.getByTestId("section-header-exposure"));
    await user.click(screen.getByTestId("section-menu-override"));
    expect(screen.getByTestId("section-header-exposure").parentElement).toHaveAttribute("data-override", "true");
    fireEvent.contextMenu(screen.getByTestId("section-header-exposure"));
    expect(screen.getByTestId("section-menu-override")).toHaveTextContent("Remove override");
    await user.keyboard("{Escape}");
    // A dial.
    const row = within(screen.getByTestId("section-header-exposure").parentElement!).getByTestId("slider-exposure");
    fireEvent.contextMenu(row);
    await user.click(screen.getByTestId("param-menu-override"));
    expect(row).toHaveAttribute("data-override", "true");
    // Select Linked gathers the link.
    await user.click(screen.getByTestId("menu-photo"));
    await user.click(screen.getByTestId("menu-photo-select-linked"));
    expect(screen.getAllByTestId(/^thumb-link-/).every((el) => el.getAttribute("data-mine") === "true")).toBe(true);
  });

  /* (2026-09-09): "if I select one photo that is linked, select
   * another that has not been linked, that new photo gets added into
   * the already linked photos?" Linking never shrinks a link: the
   * newcomers join, or two links merge whole.*/
  it("Link Selected joins newcomers to the one link among them and merges two links whole, never shrinking one", () => {
    const s0 = initialState();
    const a = s0.activeImage;
    const s = run(
      s0,
      { type: "set_link_group", ids: [a, "4866", "4867"], group: "link_1" },
      { type: "set_link_group", ids: ["4868", "4869"], group: "link_2" },
    );
    expect(linkPlan(s, ["4870", "4872"]).kind).toBe("new");
    expect(linkPlan(s, ["4866", "4870"])).toMatchObject({ kind: "join", groups: ["link_1"], newcomers: ["4870"] });
    expect(linkPlan(s, ["4866", "4868"])).toMatchObject({ kind: "merge", groups: ["link_1", "link_2"], newcomers: [] });
    expect(linkPlan(s, ["4866", "4868", "4870"])).toMatchObject({ kind: "merge", newcomers: ["4870"] });
    expect(linkPlan(s, [a, "4866"]).kind).toBe("none");
    expect(linkPlan(s, ["4870"]).kind).toBe("none");
  });

  /* The deliberate sync: the link moves every member by the same delta
   * from where it is, Match to This Photo copies one member's edit
   * whole. Overrides on either side hold, pinned members sit it out. */
  it("Match to This Photo copies the source's edit onto the link, honoring overrides on both sides and the pin", () => {
    const s0 = initialState();
    const a = s0.activeImage;
    const exposure = (nodes: NodeCard[]) => nodes.find((n) => n.id === "exposure")!.params.exposure as number;
    const temp = (nodes: NodeCard[]) => nodes.find((n) => n.id === "stdcolor")!.params.temperature as number;
    const fresh = () => ({ nodes: structuredClone(s0.defaultGraph.nodes), wires: structuredClone(s0.defaultGraph.wires) });
    const own = fresh();
    own.nodes.find((n) => n.id === "exposure")!.params.exposure = -1;
    own.nodes.find((n) => n.id === "stdcolor")!.params.temperature = 4000;
    let s = run(
      s0,
      { type: "set_link_group", ids: [a, "4866", "4867", "4868", "4869"], group: "link_1" },
      { type: "stash_graphs", graphs: { "4866": fresh(), "4867": { ...own, linkOverrides: ["param:stdcolor|temperature"] }, "4868": { ...own, linkOverrides: ["node:exposure"] }, "4869": fresh() } },
      { type: "toggle_link_pin", id: "4869" },
      { type: "set_param", id: "exposure", param: "exposure", value: 0.7 },
      { type: "set_param", id: "stdcolor", param: "temperature", value: 5000 },
    );
    // The mirror moved the members by the deltas from the sample's own
    // exposure, so 4866 is not at 0.7 yet; the match sets it there.
    expect(exposure(s.graphs["4866"].nodes)).not.toBeCloseTo(0.7, 9);
    s = reduce(s, { type: "link_match", id: a });
    expect(exposure(s.graphs["4866"].nodes)).toBeCloseTo(0.7, 9);
    expect(temp(s.graphs["4866"].nodes)).toBe(5000);
    // 4867: exposure copied whole, its overridden temperature kept.
    expect(exposure(s.graphs["4867"].nodes)).toBeCloseTo(0.7, 9);
    expect(temp(s.graphs["4867"].nodes)).toBe(4000);
    // 4868: its overridden Exposure node kept whole, temperature copied.
    expect(exposure(s.graphs["4868"].nodes)).toBe(-1);
    expect(temp(s.graphs["4868"].nodes)).toBe(5000);
    // Pinned: untouched, not owed a write.
    expect(exposure(s.graphs["4869"].nodes)).toBe(0);
    expect(temp(s.graphs["4869"].nodes)).toBe(6500);
    expect([...s.linkDirty].sort()).toEqual(["4866", "4867", "4868"]);
    // A source's own override cuts the other way too: 4868 never sends
    // its overridden Exposure node, so matching to it leaves every
    // member's exposure alone.
    const from4868 = reduce(s, { type: "link_match", id: "4868" });
    expect(exposure(from4868.nodes)).toBeCloseTo(0.7, 9);
    expect(exposure(from4868.graphs["4866"].nodes)).toBeCloseTo(0.7, 9);
    // Matching to a stashed member rewrites the open photo, undoably,
    // and the open photo's own override blocks the copy inbound: the
    // unpinned 4869 is still the template, so exposure goes to 0 while
    // the overridden Standard Color keeps 5000.
    const overridden = run(s, { type: "toggle_link_pin", id: "4869" }, { type: "toggle_link_override", keys: ["node:stdcolor"] });
    const matched = reduce(overridden, { type: "link_match", id: "4869" });
    expect(exposure(matched.nodes)).toBe(0);
    expect(temp(matched.nodes)).toBe(5000);
    expect(exposure(matched.graphs["4866"].nodes)).toBe(0);
    expect(temp(matched.graphs["4866"].nodes)).toBe(6500);
    const undone = reduce(matched, { type: "undo" });
    expect(exposure(undone.nodes)).toBeCloseTo(0.7, 9);
    // Unlinked, or pinned source: nothing happens.
    expect(reduce(s0, { type: "link_match", id: a })).toBe(s0);
  });

  it("the Photo menu and a thumbnail's menu offer Match to This Photo on a linked photograph, grayed or absent otherwise", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByTestId("menu-photo"));
    expect(screen.getByTestId("menu-photo-link-match")).toBeDisabled();
    await user.keyboard("{Escape}");
    const thumbs = screen.getAllByTestId(/^thumb-\d+$/);
    fireEvent.contextMenu(thumbs[1]);
    expect(screen.queryByTestId("thumb-menu-link-match")).toBeNull();
    await user.keyboard("{Escape}");
    await user.click(thumbs[0]);
    fireEvent.click(thumbs[1], { shiftKey: true });
    await user.click(screen.getByTestId("menu-photo"));
    await user.click(screen.getByTestId("menu-photo-link"));
    await waitFor(() => expect(screen.getAllByTestId(/^thumb-link-/).length).toBeGreaterThanOrEqual(2));
    await user.click(screen.getByTestId("menu-photo"));
    expect(screen.getByTestId("menu-photo-link-match")).toBeEnabled();
    // Adding a third: the hint says it joins rather than starting over.
    await user.keyboard("{Escape}");
    fireEvent.click(thumbs[2], { shiftKey: true });
    await user.click(screen.getByTestId("menu-photo"));
    expect(screen.getByTestId("menu-photo-link").closest("[data-hint]")?.getAttribute("data-hint") ?? screen.getByTestId("menu-photo-link").getAttribute("data-hint")).toMatch(/Adds 1 photograph to the link/);
    await user.click(screen.getByTestId("menu-photo-link"));
    await waitFor(() => expect(screen.getAllByTestId(/^thumb-link-/).length).toBeGreaterThanOrEqual(3));
    fireEvent.contextMenu(thumbs[2]);
    expect(screen.getByTestId("thumb-menu-link-match")).toBeInTheDocument();
  });

  it("the Photo menu links a selection and unlinks it; the thumbnails wear the mark and the header says so", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByTestId("menu-photo"));
    expect(screen.getByTestId("menu-photo-link")).toBeDisabled();
    await user.keyboard("{Escape}");
    // Select two photographs: click one, shift-click another.
    const thumbs = screen.getAllByTestId(/^thumb-\d+$/);
    await user.click(thumbs[0]);
    fireEvent.click(thumbs[1], { shiftKey: true });
    await user.click(screen.getByTestId("menu-photo"));
    await user.click(screen.getByTestId("menu-photo-link"));
    await waitFor(() => expect(screen.getAllByTestId(/^thumb-link-/).length).toBeGreaterThanOrEqual(2));
    expect(screen.getByTestId("link-note")).toHaveTextContent(/LINKED · \d/);
    await user.click(screen.getByTestId("menu-photo"));
    await user.click(screen.getByTestId("menu-photo-unlink"));
    await waitFor(() => expect(screen.queryByTestId("link-note")).toBeNull());
  });
});


it("replays delayed linked edits once, with the saved member's overrides", () => {
  const s = linked();
  const before = grade(s.nodes);
  const edited = run(s,
    { type: "set_param", id: "portra", param: "grade_strength", value: before + 10 },
    { type: "set_param", id: "portra", param: "grade_strength", value: before + 5 });
  expect(edited.linkPending?.["4867"]).toHaveLength(2);
  const disk = { nodes: structuredClone(s.graphs["4866"].nodes), wires: s.wires };
  const loaded = reduce(edited, { type: "stash_graphs", graphs: { "4867": disk } });
  expect(grade(loaded.graphs["4867"].nodes)).toBe(45);
  expect(loaded.linkPending?.["4867"]).toBeUndefined();
  expect(loaded.linkDirty).toContain("4867");
  const duplicate = reduce(loaded, { type: "stash_graphs", graphs: { "4867": disk } });
  expect(grade(duplicate.graphs["4867"].nodes)).toBe(45);
  const kept = reduce(edited, { type: "stash_graphs", graphs: { "4867": { ...disk, linkOverrides: ["node:portra"] } } });
  expect(grade(kept.graphs["4867"].nodes)).toBe(40);
});

it("keeps deferred match and relative edits ordered when the member becomes active", () => {
  let s = linked();
  const before = grade(s.nodes);
  s = run(s, { type: "link_match", id: s.activeImage },
    { type: "set_param", id: "portra", param: "grade_strength", value: before + 5 },
    { type: "select_image", id: "4867" },
    { type: "replace_graph", nodes: initialState().nodes, wires: initialState().wires, overrides: [] },
    { type: "settle_link_edits", id: "4867" });
  expect(grade(s.nodes)).toBe(before + 5);
  expect(s.linkPending?.["4867"]).toBeUndefined();
  expect(grade(reduce(s, { type: "settle_link_edits", id: "4867" }).nodes)).toBe(before + 5);
});

it("acknowledges a saved member only if no newer edit arrived", () => {
  const s = linked();
  const first = reduce(s, { type: "set_param", id: "portra", param: "grade_strength", value: grade(s.nodes) + 5 });
  const old = first.graphs["4866"];
  const next = reduce(first, { type: "set_param", id: "portra", param: "grade_strength", value: grade(s.nodes) + 10 });
  expect(reduce(next, { type: "link_saved", id: "4866", graph: old }).linkDirty).toContain("4866");
  expect(reduce(next, { type: "link_saved", id: "4866", graph: next.graphs["4866"] }).linkDirty).not.toContain("4866");
});

it("leaves the link unchanged if its catalog write fails", async () => {
  const bridge = await import("../bridge");
  const save = vi.spyOn(bridge, "setImageLinkGroup").mockRejectedValue(new Error("disk full"));
  const dispatch = vi.fn();
  try {
    const s = initialState();
    expect(await linkPhotos(s, dispatch, [s.activeImage, "4866"])).toBeNull();
    expect(dispatch).not.toHaveBeenCalled();
    expect(await unlinkPhotos(linked(), dispatch, ["4866"])).toBe(0);
    expect(dispatch).not.toHaveBeenCalled();
  } finally { save.mockRestore(); }
});


it("mirrors depth toggles as absolute flags even when a member was already on", () => {
  let s = linked();
  s = { ...s, nodes: s.nodes.map(n => n.id === "portra" ? { ...n, params: { ...n.params, depth_on: 0 } } : n),
    graphs: { ...s.graphs, "4866": { ...s.graphs["4866"], nodes: s.graphs["4866"].nodes.map(n => n.id === "portra" ? { ...n, params: { ...n.params, depth_on: 1 } } : n) } } };
  const on = reduce(s, { type: "set_param", id: "portra", param: "depth_on", value: 1 });
  expect(on.graphs["4866"].nodes.find(n => n.id === "portra")!.params.depth_on).toBe(1);
  const off = reduce(on, { type: "set_param", id: "portra", param: "depth_on", value: 0 });
  expect(off.graphs["4866"].nodes.find(n => n.id === "portra")!.params.depth_on).toBe(0);
});

it("keeps override hints within the house limit without printing undefined", async () => {
  const { sliderHint } = await import("../ui/simple");
  expect(sliderHint("a".repeat(165), true)!.length).toBeLessThanOrEqual(165);
  expect(sliderHint("a".repeat(165), true)).toContain("Overridden");
  expect(sliderHint(undefined, true)).not.toContain("undefined");
});

it("prints the capped hint on the slider itself, not only from the helper", async () => {
  const { Slider } = await import("../ui/simple");
  const node = initialState().nodes.find((n) => n.id === "exposure")!;
  const tip = "a".repeat(165);
  const view = render(
    <Slider label="Exposure" param="exposure" node={{ ...node, params: { exposure: 0 } }} range={[0, 100]} tip={tip} overridden dispatch={() => {}} />,
  );
  const el = view.container.querySelector("[data-hint]")!;
  expect(el.getAttribute("data-hint")!.length).toBeLessThanOrEqual(165);
  expect(el.getAttribute("data-hint")).toContain("Overridden");
});


/* Plan C (review 2026-09-10): Match combines the source's wires around
 * the member's kept section, which can feed one image port twice or a
 * planted node not at all. The reconcile keeps one feed per port with
 * the kept section's own wire winning, drops an unfed source node with
 * its wires, re-feeds the output from the chain's tail, and refuses a
 * candidate that still loops. */
describe("match topology", () => {
  const node = (id: string, extra: Partial<NodeCard> = {}): NodeCard => ({
    id, type: "heeler.levels", name: id.toUpperCase(), cat: "color", x: 0, y: 0, enabled: true, params: {}, hasIn: true, hasOut: true, ...extra,
  });
  const wire = (from: string, to: string, toPort: Wire["toPort"] = "in", kind: Wire["kind"] = "image"): Wire => ({ from, to, toPort, kind });
  const chain = (ids: string[]) => ({
    nodes: ids.map((id) =>
      id === "s" ? node(id, { type: "heeler.image_source", name: "Source", cat: "source", hasIn: false })
        : id === "o" ? node(id, { type: "heeler.output", name: "Output", cat: "utility", hasOut: false })
          : node(id)),
    wires: ids.slice(1).map((to, i) => wire(ids[i], to)),
  });
  const inbound = (g: { wires: Wire[] }, id: string) => g.wires.filter((w) => w.to === id && w.kind !== "mask");
  /** The active photo's graph matched onto the linked member 4866. */
  const matched = (source: { nodes: NodeCard[]; wires: Wire[] }, member: { nodes: NodeCard[]; wires: Wire[] }, overrides: string[]): State => {
    const s0 = initialState();
    return run(
      { ...s0, nodes: source.nodes, wires: source.wires },
      { type: "set_link_group", ids: [s0.activeImage, "4866"], group: "link_t" },
      { type: "stash_graphs", graphs: { "4866": { ...member, linkOverrides: overrides } } },
      { type: "link_match", id: s0.activeImage },
    );
  };

  it("a node the driver added around a kept override never double-feeds the next node", () => {
    // The driver inserted D between B and C; the member keeps its own B,
    // whose wire already answers C.
    const g = matched(chain(["s", "b", "d", "c", "o"]), chain(["s", "b", "c", "o"]), ["node:b"]).graphs["4866"];
    expect(inbound(g, "c").map((w) => w.from)).toEqual(["b"]);
    // D's feed died with the kept section, so D went with its wires
    // rather than standing as an orphan.
    expect(g.nodes.some((n) => n.id === "d")).toBe(false);
    expect(g.wires.some((w) => w.from === "d" || w.to === "d")).toBe(false);
    expect(inbound(g, "o")).toHaveLength(1);
  });

  it("a reordered chain around a kept node still feeds every port once and reaches the output", () => {
    const g = matched(chain(["s", "a", "b", "c", "o"]), chain(["s", "b", "a", "c", "o"]), ["node:b"]).graphs["4866"];
    const perPort = new Map<string, number>();
    for (const w of g.wires.filter((w) => w.kind !== "mask")) {
      perPort.set(`${w.to}:${w.toPort}`, (perPort.get(`${w.to}:${w.toPort}`) ?? 0) + 1);
    }
    for (const [port, n] of perPort) expect(n, port).toBe(1);
    // The kept node's own wire answers A, not the source's.
    expect(inbound(g, "a").map((w) => w.from)).toEqual(["b"]);
    // C lost its feed on both sides and was dropped; the output is wired.
    expect(g.nodes.some((n) => n.id === "c")).toBe(false);
    const onward = new Map<string, string[]>();
    for (const w of g.wires.filter((w) => w.kind !== "mask")) onward.set(w.from, [...(onward.get(w.from) ?? []), w.to]);
    const seen = new Set(["s"]);
    for (let grew = true; grew;) {
      grew = false;
      for (const [f, ts] of onward) for (const t of ts) if (seen.has(f) && !seen.has(t)) { seen.add(t); grew = true; }
    }
    expect(seen.has("o")).toBe(true);
  });

  it("a kept group's children stay the member's own", () => {
    const member = chain(["s", "b", "o"]);
    const b = member.nodes.find((n) => n.id === "b")!;
    b.type = "heeler.group";
    b.isGroup = true;
    b.groupNodes = [node("g1"), node("g2")];
    const g = matched(chain(["s", "b", "o"]), member, ["node:b"]).graphs["4866"];
    expect(g.nodes.find((n) => n.id === "b")?.groupNodes?.map((n) => n.id)).toEqual(["g1", "g2"]);
  });

  it("mask wires ride through the reconcile untouched", () => {
    const member = chain(["s", "b", "c", "o"]);
    member.nodes.push(node("m", { type: "heeler.brush_mask", name: "Mask", cat: "masking", maskOut: true }));
    member.wires.push(wire("s", "m"), wire("m", "b", "mask", "mask"));
    const source = chain(["s", "b", "c", "o"]);
    source.nodes.push(node("m2", { type: "heeler.brush_mask", name: "Mask2", cat: "masking", maskOut: true }));
    source.wires.push(wire("s", "m2"), wire("m2", "c", "mask", "mask"));
    const g = matched(source, member, ["node:b", "node:m"]).graphs["4866"];
    const masks = g.wires.filter((w) => w.kind === "mask").map((w) => `${w.from}>${w.to}`).sort();
    expect(masks).toEqual(["m2>c", "m>b"]);
    expect(g.nodes.some((n) => n.id === "m")).toBe(true);
    expect(g.nodes.some((n) => n.id === "m2")).toBe(true);
    // The image chain is still fed once per port alongside the masks.
    expect(inbound(g, "b").map((w) => w.from)).toEqual(["s"]);
    expect(inbound(g, "c").map((w) => w.from)).toEqual(["b"]);
  });

  it("a kept section that loops leaves the member's graph identical and the console names the node", () => {
    const member = chain(["s", "b1", "b2", "o"]);
    member.wires = [wire("b1", "b2"), wire("b2", "b1")];
    const s = matched(chain(["s", "b1", "b2", "o"]), member, ["node:b1", "node:b2"]);
    expect(s.graphs["4866"].nodes).toEqual(member.nodes);
    expect(s.graphs["4866"].wires).toEqual(member.wires);
    expect(s.linkDirty).not.toContain("4866");
    expect(getEntries().some((e) => e.level === "warn" && e.message.includes("b1"))).toBe(true);
  });
});

/* (2026-09-13): "Found a lot of bugs with linked photos."*/
describe("links, 2026-09-13", () => {
  const fresh = (s0: State) => ({ nodes: structuredClone(s0.defaultGraph.nodes), wires: structuredClone(s0.defaultGraph.wires) });
  const wiring = (g: { wires: Wire[] }) => g.wires.map((w) => `${w.from}>${w.to}`).sort().join(",");
  const levels = (nodes: NodeCard[]) => nodes.find((n) => n.id === "levels");
  const exposure = (nodes: NodeCard[]) => nodes.find((n) => n.id === "exposure")!.params.exposure as number;
  const ids = (nodes: NodeCard[]) => nodes.map((n) => n.id).sort();

  /* "I select one photo and override the LEVELS. Changes are applied to
   * the one photo as expected, I go to one of the other linked photos
   * and edit the levels. I expect to see ... the rest of the photos
   * without a LEVELS override be updated, but they are not." Levels is
   * spliced into the chain when its switch goes on; the kept node was
   * filtered out of the members' adds, but the bypass wire it displaced
   * was still removed from them, and a chain with no stdcolor>exposure
   * could never take the later splice. */
  it("a splice around a kept node sits out whole, so a later edit from another member still lands", () => {
    const s0 = initialState();
    const A = s0.activeImage;
    let s = run(
      s0,
      { type: "replace_graph", ...fresh(s0), overrides: [] },
      { type: "set_link_group", ids: [A, "4866", "4867"], group: "link_t" },
      { type: "stash_graphs", graphs: { "4866": fresh(s0), "4867": fresh(s0) } },
      { type: "toggle_link_override", keys: ["node:levels"] },
      { type: "set_category", title: "Levels", on: true },
      { type: "set_param", id: "levels", param: "black", value: 0.1 },
    );
    expect(levels(s.nodes)?.params.black).toBeCloseTo(0.1);
    expect(wiring(s.graphs["4866"])).toBe(wiring(fresh(s0)));
    expect(wiring(s.graphs["4867"])).toBe(wiring(fresh(s0)));
    expect(s.linkDirty).toEqual([]);
    s = run(
      s,
      { type: "select_image", id: "4866" },
      { type: "set_category", title: "Levels", on: true },
      { type: "set_param", id: "levels", param: "black", value: 0.2 },
    );
    expect(levels(s.nodes)?.params.black).toBeCloseTo(0.2);
    expect(levels(s.graphs["4867"].nodes)?.params.black).toBeCloseTo(0.2);
    expect(levels(s.graphs[A].nodes)?.params.black).toBeCloseTo(0.1);
    expect(s.linkDirty).toEqual(["4867"]);
  });

  /* "When unlinking photos, Heeler should ensure that any overridden
   * sections and attributes/properties have the overrides removed." */
  it("unlinking drops the overrides; a photograph joining from outside a link brings none in; a merge keeps them", () => {
    const s0 = initialState();
    const A = s0.activeImage;
    const s = run(
      s0,
      { type: "set_link_group", ids: [A, "4866", "4867"], group: "link_t" },
      { type: "stash_graphs", graphs: {
        "4866": { ...fresh(s0), linkOverrides: ["node:exposure"] },
        "4867": { ...fresh(s0), linkOverrides: ["param:exposure|exposure"] },
      } },
      { type: "toggle_link_override", keys: ["node:levels"] },
    );
    const off = reduce(s, { type: "set_link_group", ids: [A, "4866"], group: null });
    expect(off.linkOverrides).toEqual([]);
    expect(off.graphs["4866"].overrides).toEqual([]);
    expect(off.graphs["4867"].overrides).toEqual(["param:exposure|exposure"]);
    const snap = (overrides: string[]) => ({ ...fresh(s0), backdrops: [], undoStack: [], redoStack: [], overrides });
    const stale = { ...off, graphs: { ...off.graphs, "4868": snap(["node:exposure"]), "4869": snap(["node:exposure"]) } };
    const joined = reduce(stale, { type: "set_link_group", ids: ["4868"], group: "link_t" });
    expect(joined.graphs["4868"].overrides).toEqual([]);
    const other = reduce(joined, { type: "set_link_group", ids: ["4869", "4870"], group: "link_u" });
    expect(other.graphs["4869"].overrides).toEqual([]);
    const inside = { ...other, graphs: { ...other.graphs, "4869": snap(["node:exposure"]) } };
    const merged = reduce(inside, { type: "set_link_group", ids: ["4869", "4870"], group: "link_t" });
    expect(merged.graphs["4869"].overrides).toEqual(["node:exposure"]);
  });

  it("unlinking clears the overrides from the photographs' files too, leaving the edit and the badge as they were", async () => {
    const bridge = await import("../bridge");
    const s0 = initialState();
    const A = s0.activeImage;
    await bridge.saveGraph("4866", { ...fresh(s0), linkOverrides: ["node:exposure"] } as never);
    const s = run(s0, { type: "set_link_group", ids: [A, "4866"], group: "link_t" });
    const dispatch = vi.fn();
    expect(await unlinkPhotos(s, dispatch, ["4866"])).toBe(1);
    expect(dispatch).toHaveBeenCalledWith({ type: "set_link_group", ids: ["4866"], group: null });
    const file = await bridge.loadGraph("4866");
    expect(file?.linkOverrides).toEqual([]);
    expect(file?.nodes.length).toBe(fresh(s0).nodes.length);
  });

  /* "Reset Edits on a linked photo would reset the other photos' edits
   * (as long as there are no overrides)." */
  it("Reset Edits on a linked photograph resets the link with it, overrides honored, pinned out, unread members when they load", () => {
    const s0 = initialState();
    const A = s0.activeImage;
    const lifted = () => {
      const g = fresh(s0);
      g.nodes.find((n) => n.id === "exposure")!.params.exposure = 0.5;
      return g;
    };
    const s = run(
      s0,
      { type: "set_link_group", ids: [A, "4866", "4867", "4868", "4869"], group: "link_t" },
      { type: "stash_graphs", graphs: {
        "4866": { ...lifted(), linkOverrides: ["node:exposure"] },
        "4867": lifted(),
        "4869": lifted(),
      } },
      { type: "toggle_link_pin", id: "4869" },
      { type: "set_param", id: "exposure", param: "exposure", value: 0.25 },
    );
    const reset = reduce(s, { type: "reset_image_edits", id: A });
    const factory = freshGraphFor(s, "4867");
    expect(exposure(reset.nodes)).toBe(exposure(freshGraphFor(s, A).nodes));
    // A member with nothing of its own goes back through the same
    // door: stash at factory, badge off, file archived by the drain.
    expect(reset.resetPending).toEqual([A, "4867"]);
    expect(ids(reset.graphs["4867"].nodes)).toEqual(ids(factory.nodes));
    expect(exposure(reset.graphs["4867"].nodes)).toBe(exposure(factory.nodes));
    expect(reset.images.find((i) => i.id === "4867")?.edited).toBe(false);
    // The member keeping Exposure keeps it, takes factory around it,
    // and is owed a write rather than an archive.
    expect(exposure(reset.graphs["4866"].nodes)).toBe(0.5);
    expect(ids(reset.graphs["4866"].nodes)).toEqual(ids(factory.nodes));
    expect(reset.graphs["4866"].overrides).toEqual(["node:exposure"]);
    expect(reset.linkDirty).toEqual(["4866"]);
    // Pinned keeps everything; unread takes the reset when it loads.
    expect(exposure(reset.graphs["4869"].nodes)).toBe(0.5);
    // Behind the edit it was already owed, so the two replay in order.
    expect(reset.linkPending?.["4868"]).toHaveLength(2);
    expect(reset.linkPending?.["4868"]?.[1]).toHaveProperty("match");
    const loaded = reduce(reset, { type: "stash_graphs", graphs: { "4868": lifted() } });
    expect(exposure(loaded.graphs["4868"].nodes)).toBe(exposure(factory.nodes));
    expect(loaded.linkDirty).toContain("4868");
    // From a thumbnail, with the open photograph a member: it resets too.
    const fromThumb = reduce(s, { type: "reset_image_edits", id: "4867" });
    expect(exposure(fromThumb.nodes)).toBe(exposure(freshGraphFor(s, A).nodes));
    expect(fromThumb.resetPending).toEqual(["4867", A]);
    expect(fromThumb.graphs["4867"]?.nodes && ids(fromThumb.graphs["4867"].nodes)).toEqual(ids(factory.nodes));
    // A quad session keeps its own mirror.
    const quad = run(s, { type: "open_quad_edit", ids: [A, "4866"], graphs: {} }, { type: "reset_image_edits", id: A });
    expect(quad.resetPending).toEqual([A]);
  });

  /* "I hit undo and it did not restore the edits." The linked reset
   * changed every member, so Undo puts every member back, once: the open
   * photograph's difference is not mirrored on top.*/
  it("Undo after a linked Reset Edits puts every member back as it was", () => {
    const s0 = initialState();
    const A = s0.activeImage;
    const lifted = () => {
      const g = fresh(s0);
      g.nodes.find((n) => n.id === "exposure")!.params.exposure = 0.5;
      return g;
    };
    const s = run(
      s0,
      { type: "set_link_group", ids: [A, "4866", "4867", "4868"], group: "link_t" },
      { type: "stash_graphs", graphs: { "4866": { ...lifted(), linkOverrides: ["node:exposure"] }, "4867": lifted() } },
      { type: "set_param", id: "exposure", param: "exposure", value: 0.25 },
    );
    let t = reduce(s, { type: "reset_image_edits", id: A });
    // The drain has asked for the archives by now.
    t = run(t, ...t.resetPending.map((id): Command => ({ type: "reset_settled", id })));
    t = reduce(t, { type: "undo" });
    expect(exposure(t.nodes)).toBe(0.25);
    expect(t.graphs["4866"]).toBe(s.graphs["4866"]);
    expect(t.graphs["4867"]).toBe(s.graphs["4867"]);
    expect(t.linkPending?.["4868"]).toBe(s.linkPending?.["4868"]);
    // The archived member is owed its write-back; the one that only
    // took factory around its override writes its old graph again.
    expect(t.restorePending).toEqual(["4867"]);
    expect(t.linkDirty).toContain("4866");
    expect(t.images.filter((i) => [A, "4866", "4867"].includes(i.id)).map((i) => i.edited)).toEqual(
      s.images.filter((i) => [A, "4866", "4867"].includes(i.id)).map((i) => i.edited),
    );
  });
});
