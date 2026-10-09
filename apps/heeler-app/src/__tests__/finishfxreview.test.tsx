import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { initialState } from "../data";
import { ART_ADJUSTMENTS, ART_FX, artGroupMembers, artLayers, hardRange, paramRange, reduce, type Command } from "../state";
import { serializeGraph, serializeLoadedGraph } from "../bridge";
import { NodeParams } from "../ui/graph";
import { ArtLayersTab } from "../ui/artlayers";

afterEach(cleanup);
const add = (kind: string, s = initialState()) => reduce(s, { type: "art_add_layer", kind });

describe("Finish review regressions", () => {
  it.each(ART_ADJUSTMENTS)("%s survives stack changes and edit transfers", kind => {
    const run = (s: ReturnType<typeof initialState>, ...cmds: Command[]) => cmds.reduce(reduce, s);
    let s = add(kind), id = s.artActive!;
    s = run(s, { type: "art_layer_set", id, opacity: 37, mode: "multiply" });
    const content = artLayers(s)[0].content;
    const serial = serializeGraph(s);
    s = run(s, { type: "art_duplicate_layer", id });
    expect(artLayers(s)).toHaveLength(2);
    expect(artLayers(s)[1].content.params).toEqual(content.params);
    const copy=artLayers(s)[1].blend.id;
    s = run(s, { type: "art_move_layer", id: copy, delta: -1 });
    expect(artLayers(s)[0].blend.id).toBe(copy);
    s = run(s, { type: "art_layer_set", id: copy, enabled: false });
    expect(artLayers(s)[0].blend.enabled).toBe(false);
    s = run(s, { type: "art_remove_layer", id: copy });
    expect(artLayers(s)).toHaveLength(1);
    s = run(s, { type: "undo" }, { type: "redo" });
    expect(artLayers(s)).toHaveLength(1);
    expect(serializeGraph(s)).toEqual(serial);
    const taken=run(s, { type: "new_take" }, { type: "art_remove_layer", id }, { type: "switch_take", takeId: "take_1" });
    expect(artLayers(taken)[0].content.params).toEqual(content.params);
    const pasted=run(s, { type: "copy_edits" }, { type: "select_image", id: "4866" }, { type: "paste_edits" });
    expect(artLayers(pasted)[0].content.params).toEqual(content.params);
    expect(artLayers(pasted)[0].blend.params.opacity).toBe(37);
    const linked=run(s, { type: "set_link_group", ids: [s.activeImage, "4866"], group: "review_fx" }, { type: "stash_graphs", graphs: { "4866": { nodes: structuredClone(s.nodes), wires: structuredClone(s.wires) } } }, { type: "art_layer_set", id, opacity: 23 }, { type: "select_image", id: "4866" });
    expect(artLayers(linked)[0].blend.params.opacity).toBe(23);
    const loaded=serializeLoadedGraph(s.activeImage, JSON.parse(JSON.stringify({nodes:s.nodes,wires:s.wires})));
    expect(loaded).toEqual(serial);
  });
  it("grouping and ungrouping keep blend mode and clipping", () => {
    let s=add("fill");s=add("invert",s);
    const id=s.artActive!;
    s=reduce(s,{type:"art_clip_layer",id,clip:true});
    s=reduce(s,{type:"art_layer_set",id,mode:"multiply"});
    s=reduce(s,{type:"art_group_layers",ids:artLayers(s).map(l=>l.blend.id)});
    const g=artLayers(s)[0];
    const m=artGroupMembers(g.content)[1];
    expect(m.merge.params.clip).toBe(1);
    expect(m.merge.textParams?.mode).toBe("multiply");
    s=reduce(s,{type:"art_ungroup",id:g.blend.id});
    expect(artLayers(s)[1].blend.params.clip).toBe(1);
    expect(artLayers(s)[1].blend.textParams?.mode).toBe("multiply");
  });

  it("clipping to an effected placed image does not place its silhouette twice", () => {
    let s=add("image"), id=s.artActive!;
    s=reduce(s,{type:"art_set_quad",id,box:{x:0.25,y:0.25,w:0.5,h:0.5},corners:[[0.25,0.25],[0.75,0.25],[0.75,0.75],[0.25,0.75]]});
    s=reduce(s,{type:"art_add_fx",id,fx:"glow"});
    s=add("fill",s);s=reduce(s,{type:"art_clip_layer",id:s.artActive!,clip:true});
    const g=serializeGraph(s), clip=g.nodes.find(n=>n.id===s.artActive)!;
    expect(clip.params.clip_place).toBeUndefined();
  });
  it("a fresh Black & White layer converts when it is added, as Invert inverts", () => {
    // The two adjustments named for what they do act at birth; the
    // other six start neutral.
    expect(artLayers(add("black_white"))[0].content.params.amount).toBe(100);
  });
  it.each(ART_ADJUSTMENTS.filter(k => k !== "invert"))("%s is converted to scene light around its operation", kind => {
    const s = add(kind), id = artLayers(s)[0].content.id;
    const g = serializeGraph(s);
    const input = g.connections.find(w => w.to[0] === id && w.to[1] === "in")!;
    expect(g.nodes.find(n => n.id === input.from[0])?.type).toBe("heeler.to_scene");
    const output = g.connections.find(w => w.from[0] === id && w.to[0] !== id)!;
    expect(g.nodes.find(n => n.id === output.to[0])?.type).toBe("heeler.to_display");
    expect(serializeLoadedGraph(s.activeImage, { nodes: s.nodes, wires: s.wires })).toEqual(g);
  });
  it("grouped adjustments read the members below and preserve the composite alpha", () => {
    let s = add("fill");
    s = add("levels", s);
    const ids = artLayers(s).map(l => l.blend.id);
    s = reduce(s, { type: "art_group_layers", ids });
    const g = artLayers(s)[0].content, ms = artGroupMembers(g);
    expect(g.groupWires?.find(w => w.to === ms[1].content.id && w.toPort === "in")?.from).toBe(ms[0].merge.id);
    const built = serializeGraph(s);
    expect(built.nodes.find(n => n.id === ms[1].merge.id)?.params).toHaveProperty("adjustment", 1);
  });
  it("a group saved before 26.4.1 is sent with its members reading the composite below", () => {
    // Its wiring fed every member from the empty canvas and is only
    // rebuilt when the group's members change, so the saved shape is
    // put right where the graph is sent, not rewritten on disk.
    let s = add("fill");
    s = add("levels", s);
    s = reduce(s, { type: "art_group_layers", ids: artLayers(s).map(l => l.blend.id) });
    const sentNow = serializeGraph(s);
    const group = artLayers(s)[0].content, ms = artGroupMembers(group);
    const canvas = group.groupNodes!.find(n => n.id.endsWith("_c"))!.id;
    const old = (nodes: typeof s.nodes): typeof s.nodes => nodes.map(n => n.id === group.id
      ? { ...n, groupWires: n.groupWires!.map(w => w.to === ms[1].content.id && w.toPort === "in" ? { ...w, from: canvas } : w) }
      : n.groupNodes ? { ...n, groupNodes: old(n.groupNodes) } : n);
    const saved = { ...s, nodes: old(s.nodes) };
    const savedGroup = artLayers(saved)[0].content;
    expect(savedGroup.groupWires!.find(w => w.to === ms[1].content.id && w.toPort === "in")!.from).toBe(canvas);
    expect(serializeGraph(saved)).toEqual(sentNow);
    // The saved wiring itself is left as it was.
    expect(artLayers(saved)[0].content.groupWires).toEqual(savedGroup.groupWires);
  });
  it.each(["shadow", "glow", "bevel"])("%s exposes its registry size and depth ranges", key => {
    expect(paramRange("size", ART_FX[key].type)).toEqual(key === "bevel" ? [0, 100] : [0, 250]);
    expect(hardRange("size", ART_FX[key].type)).toEqual([0, Infinity]);
    if (key === "bevel") expect(paramRange("depth", ART_FX[key].type)).toEqual([0, 400]);
  });
  it("Finish Color Balance exposes hue as well as strength", () => {
    const s = add("color_balance");
    render(<ArtLayersTab state={{ ...s, layerExpandOnSelect: true }} dispatch={() => {}} />);
    expect(screen.getByTestId("wheel-shadows")).toBeTruthy();
  });
  it("Finish Levels has the same handle plot as its node", () => {
    const s = add("levels");
    render(<ArtLayersTab state={{ ...s, layerExpandOnSelect: true }} dispatch={() => {}} />);
    expect(screen.getByTestId("levels-editor")).toBeTruthy();
  });
  it.each(Object.keys(ART_FX))("%s uses the shared settings in the Graph inspector", key => {
    let s = add("fill");
    s = reduce(s, { type: "art_add_fx", id: s.artActive!, fx: key });
    const fx = artLayers(s)[0].fx[0];
    render(<NodeParams node={fx} dispatch={() => {}} appState={s} />);
    expect(screen.getByTestId(`art-fx-settings-${fx.id}`)).toBeTruthy();
    expect(screen.getByRole("slider", { name: `${fx.name} ${key === "blur" ? "radius" : "opacity"}` })).toBeTruthy();
  });
  it("shared controls update nested Finish numbers and text without opening the Graph", () => {
    let s = add("color_balance"), n = artLayers(s)[0].content;
    s = reduce(s, { type: "set_params", id: n.id, values: { shadows_hue: 200, shadows_sat: 35 } });
    expect(artLayers(s)[0].content.params).toMatchObject({ shadows_hue: 200, shadows_sat: 35 });
    s = reduce(s, { type: "undo" });
    expect(artLayers(s)[0].content.params.shadows_hue).toBe(0);
    s = reduce(s, { type: "art_add_fx", id: s.artActive!, fx: "blur" });
    const fx = artLayers(s)[0].fx[0];
    s = reduce(s, { type: "set_text_param", id: fx.id, param: "kind", value: "motion" });
    expect(artLayers(s)[0].fx[0].textParams?.kind).toBe("motion");
    s = reduce(s, { type: "set_param", id: fx.id, param: "radius", value: 25 });
    expect(artLayers(s)[0].fx[0].params.radius).toBe(25);
  });
});
