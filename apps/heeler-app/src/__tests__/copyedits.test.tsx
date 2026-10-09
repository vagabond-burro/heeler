// Copy Edits / Paste Edits: one photo's whole graph onto others.
//
// "Copy edits from one photo to one or more
// photos."

import { describe, expect, it, beforeEach } from "vitest";
import { initialState } from "../data";
import { capturePreset, gridWarpMesh, reduce, type Command, type State } from "../state";
import { loadGraph, mockResetGraphs, saveGraph } from "../bridge";
import { copyEditsFrom, pasteEditsTo } from "../copyedits";

const run = (s: State, ...cmds: Command[]) => cmds.reduce(reduce, s);

beforeEach(() => mockResetGraphs());

describe("the clipboard", () => {
  it("copy snapshots the active photo's graph, deep", () => {
    const s = run(initialState(), { type: "copy_edits" });
    expect(s.editClipboard).not.toBeNull();
    expect(s.editClipboard!.sourceId).toBe(s.activeImage);
    expect(s.editClipboard!.sourceName).toContain("4871");
    expect(s.editClipboard!.nodes.length).toBe(s.nodes.length);
    // Deep: keeping on editing does not edit the clipboard.
    expect(s.editClipboard!.nodes[0]).not.toBe(s.nodes[0]);
  });

  it("paste onto the active photo replaces the graph, undoably", () => {
    const s0 = initialState();
    const copied = run(s0, { type: "copy_edits" });
    // Wreck the live graph, then paste the snapshot back over it.
    const wrecked = { ...copied, nodes: [], wires: [] };
    const pasted = reduce(wrecked as State, { type: "paste_edits" });
    expect(pasted.nodes.length).toBe(s0.nodes.length);
    expect(pasted.images.find((i) => i.id === pasted.activeImage)!.edited).toBe(true);
    // One Ctrl+Z from back.
    const undone = reduce(pasted, { type: "undo" });
    expect(undone.nodes.length).toBe(0);
  });

  it("paste without a clipboard is a quiet no-op", () => {
    const s = initialState();
    expect(reduce(s, { type: "paste_edits" })).toBe(s);
  });

  it("mark_edited flips exactly one badge", () => {
    const s = run(initialState(), { type: "mark_edited", id: "4869" });
    expect(s.images.find((i) => i.id === "4869")!.edited).toBe(true);
    expect(s.images.find((i) => i.id === "4874")!.edited).toBe(false);
  });
});

describe("pasting onto other photos", () => {
  it("writes each target's graph file and marks it edited", async () => {
    const s = run(initialState(), { type: "copy_edits" });
    const sent: Command[] = [];
    const n = await pasteEditsTo(s, (c) => sent.push(c), ["4866", "4867"]);
    expect(n).toBe(2);
    for (const id of ["4866", "4867"]) {
      const g = await loadGraph(id);
      expect(g).not.toBeNull();
      expect(g!.nodes.length).toBe(s.nodes.length);
      expect(sent).toContainEqual({ type: "mark_edited", id });
    }
  });

  it("skips the source and routes the active photo through the reducer", async () => {
    const s = run(initialState(), { type: "copy_edits" }); // active: 4871
    const sent: Command[] = [];
    const n = await pasteEditsTo(s, (c) => sent.push(c), ["4871", "4871"]);
    // The source pasted onto itself is nothing at all.
    expect(n).toBe(0);
    expect(sent).toEqual([]);

    // A different active photo goes through paste_edits for undo.
    const moved = { ...s, activeImage: "4866" };
    const n2 = await pasteEditsTo(moved as State, (c) => sent.push(c), ["4866"]);
    expect(n2).toBe(1);
    expect(sent).toEqual([{ type: "paste_edits" }]);
    expect(await loadGraph("4866")).toBeNull(); // reducer path, no file write
  });

  it("keeps the target's takes, repointing only the current one", async () => {
    // A target with two takes on disk; the paste lands on the active
    // take and leaves the alternate exactly as saved.
    await saveGraph("4866", {
      nodes: [{ id: "old" }],
      wires: [],
      versions: [
        { id: "take_1", name: "as shot", nodes: [{ id: "old" }], wires: [] },
        { id: "take_2", name: "moody", nodes: [{ id: "moody" }], wires: [] },
      ],
      activeVersion: "take_1",
    });
    const s = run(initialState(), { type: "copy_edits" });
    await pasteEditsTo(s, () => {}, ["4866"]);
    const g = (await loadGraph("4866")) as any;
    expect(g.nodes.length).toBe(s.nodes.length);
    expect(g.activeVersion).toBe("take_1");
    const takeOne = g.versions.find((v: any) => v.id === "take_1");
    expect(takeOne.nodes.length).toBe(s.nodes.length);
    const moody = g.versions.find((v: any) => v.id === "take_2");
    expect(moody.nodes).toEqual([{ id: "moody" }]);
  });

  it("copying from an unedited photo says no instead of pasting a blank", async () => {
    const s = initialState();
    const sent: Command[] = [];
    const ok = await copyEditsFrom(s, (c) => sent.push(c), "4874");
    expect(ok).toBe(false);
    expect(sent).toEqual([]);
  });

  it("copying from an edited-on-disk photo loads its graph", async () => {
    await saveGraph("4869", { nodes: [{ id: "n1" }], wires: [] });
    const s = initialState();
    const sent: Command[] = [];
    const ok = await copyEditsFrom(s, (c) => sent.push(c), "4869");
    expect(ok).toBe(true);
    expect(sent).toHaveLength(1);
    const cmd = sent[0] as Extract<Command, { type: "set_edit_clipboard" }>;
    expect(cmd.type).toBe("set_edit_clipboard");
    expect(cmd.clipboard!.sourceId).toBe("4869");
    expect(cmd.clipboard!.sourceName).toContain("4869");
    expect(cmd.clipboard!.nodes).toEqual([{ id: "n1" }]);
  });
});

// The owner's review: the warp belongs to the destination even when
// the look arrives through an offscreen paste or an imported preset.
describe("photo-local warps", () => {
  const warped = (id: string, dx: number) => {
    let s = run(initialState(),{type:"select_image",id});
    const mesh = gridWarpMesh(s); mesh.d[7] = [dx,0];
    return run(s,{type:"grid_warp_mesh",mesh});
  };
  const node = (s: {nodes: any[]}) => s.nodes.find((n) => n.type === "heeler.grid_warp");
  it("active paste keeps the target mesh and introduces no donor warp on a clean photo", () => {
    const donor = run(warped("4869",0.2),{type:"copy_edits"});
    const target = {...warped("4866",0.1),editClipboard:donor.editClipboard};
    const pasted = reduce(target,{type:"paste_edits"});
    expect(node(pasted).textParams).toEqual(node(target).textParams);
    // The target's own switch survives the paste: on, since its drag
    // built it on.
    expect(node(pasted).enabled).toBe(true);
    const clean = {...run(initialState(),{type:"select_image",id:"4867"}),editClipboard:donor.editClipboard};
    expect(node(reduce(clean,{type:"paste_edits"}))).toBeUndefined();
  });
  it("background paste keeps the disk target's mesh", async () => {
    const donor = run(warped("4869",0.2),{type:"copy_edits"});
    const target = warped("4866",0.1);
    await saveGraph("4866",{nodes:target.nodes,wires:target.wires});
    await pasteEditsTo(donor,()=>{},["4866","4867"]);
    expect(node((await loadGraph("4866"))!).textParams).toEqual(node(target).textParams);
    expect(node((await loadGraph("4867"))!)).toBeUndefined();
  });
  it("presets strip the mesh, imported presets preserve the target switch, and takes keep the mesh", () => {
    const donor = warped("4869",0.2);
    const captured = capturePreset(donor,"look");
    expect(node(captured).textParams).toBeUndefined();
    const imported = {...captured,nodes:donor.nodes.map((n)=>({...n,enabled:true}))};
    const clean = run(initialState(),{type:"select_image",id:"4867"});
    const applied = reduce(clean,{type:"apply_preset",preset:imported});
    expect(gridWarpMesh(applied).d.every(([x,y])=>x===0&&y===0)).toBe(true);
    expect(node(applied).enabled).toBe(false);
    const target = warped("4866",0.1);
    const kept = reduce(target,{type:"apply_preset",preset:imported});
    expect(node(kept).textParams).toEqual(node(target).textParams);
    expect(node(kept).enabled).toBe(true);
    const take = reduce(target,{type:"new_take"});
    expect(node({nodes:take.takes["4866"][1].nodes}).textParams).toEqual(node(target).textParams);
  });
});

describe("a photograph's own line thickness", () => {
  // Kept in the photograph's file beside the graph (2026-09-28: not on
  // a node), so a paste written from elsewhere must not drop it.
  it("survives a paste onto the photograph", async () => {
    const s = run(initialState(), { type: "copy_edits" });
    await saveGraph("4866", { nodes: s.nodes, wires: s.wires, lineWidth: 5 });
    await pasteEditsTo(s, () => {}, ["4866"]);
    expect((await loadGraph("4866"))!.lineWidth).toBe(5);
  });
});
