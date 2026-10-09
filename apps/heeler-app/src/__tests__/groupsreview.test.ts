import { describe, expect, it } from "vitest";
import { initialState } from "../data";
import { serializeGraph } from "../bridge";
import { migrateGraph, reduce, toolNode, type Command, type NodeCard, type State } from "../state";
import { sharpeningGroup, skinGroup, toolMemberId } from "../recipes";
import { nodeResetValues } from "../ui/simple";

const run = (s: State, ...cmds: Command[]) => cmds.reduce(reduce, s);
const on = () => reduce(initialState(), { type: "set_category", title: "Sharpening", on: true });
const group = (s: State, id = "sharpening") => s.nodes.find(n => n.id === id)!;
const member = (g: NodeCard, part: string) => g.groupNodes!.find(n => n.id === toolMemberId(g.id, "sharp", part))!;

it("duplicating a tool group remaps stock and custom member IDs", () => {
  let s = on();
  const g = structuredClone(group(s));
  const custom = { ...structuredClone(member(g, "blur")), id: "review_custom_blur" };
  g.groupNodes!.push(custom);
  g.groupWires!.push({ from: member(g, "display").id, to: custom.id, toPort: "in", kind: "image" });
  s = { ...s, nodes: s.nodes.map(n => n.id === g.id ? g : n) };
  s = reduce(s, { type: "duplicate_nodes", ids: [g.id] });
  const copy = group(s, s.selection[0]);
  expect(copy.groupNodes!.some(n => n.id === custom.id)).toBe(false);
  expect(member(copy, "blur").params.radius).toBe(copy.params.radius);
  const ids = serializeGraph(s).nodes.map(n => n.id);
  expect(new Set(ids).size).toBe(ids.length);
});

describe("review: editable recipe groups", () => {
  it("loading a complete group trusts members and preserves custom wiring", () => {
    const s = on();
    const saved = structuredClone(group(s));
    member(saved, "blur").params.radius = 17;
    member(saved, "inv").enabled = false;
    saved.groupWires = saved.groupWires!.filter(w => w.to !== member(saved, "vivid").id || w.toPort !== "in2");
    const next = reduce(s, { type: "replace_graph", nodes: s.nodes.map(n => n.id === saved.id ? saved : n), wires: s.wires });
    expect(group(next).params.radius).toBe(17);
    expect(member(group(next), "inv").enabled).toBe(false);
    expect(group(next).groupWires).toEqual(saved.groupWires);
  });

  it("a mirror dial preserves unrelated members and wiring", () => {
    let s = on();
    const g = structuredClone(group(s));
    member(g, "inv").enabled = false;
    g.groupWires = g.groupWires!.filter(w => w.to !== member(g, "vivid").id || w.toPort !== "in2");
    s = { ...s, nodes: s.nodes.map(n => n.id === g.id ? g : n) };
    const next = reduce(s, { type: "set_params", id: g.id, values: { radius: 11, intensity: 75 } });
    expect(group(next).params.radius).toBe(11);
    expect(member(group(next), "blur").params.radius).toBe(11);
    expect(member(group(next), "inv").enabled).toBe(false);
    expect(group(next).groupWires).toEqual(g.groupWires);
  });

  it("a Develop drag is one undo and preserves member edits on undo", () => {
    let s = run(on(), { type: "open_group", id: "sharpening" }, { type: "set_enabled", id: "sharp_inv_sharpening", enabled: false });
    const before = structuredClone(group(s));
    const steps = s.undoStack.length;
    s = run(s, { type: "open_group", id: null }, { type: "begin_gesture", key: "sharpening.radius" },
      { type: "set_param", id: "sharpening", param: "radius", value: 8 },
      { type: "set_param", id: "sharpening", param: "radius", value: 12 }, { type: "end_gesture" });
    expect(s.undoStack).toHaveLength(steps + 1);
    expect(member(group(s), "blur").params.radius).toBe(group(s).params.radius);
    s = reduce(s, { type: "undo" });
    expect(group(s)).toEqual(before);
  });

  it("member edits pull through a stale mirror and undo agrees on both sides", () => {
    let s = on();
    const g = group(s);
    s = { ...s, nodes: s.nodes.map(n => n === g ? { ...n, params: { ...n.params, radius: 99 } } : n) };
    s = reduce(s, { type: "open_group", id: g.id });
    const count = s.undoStack.length;
    s = reduce(s, { type: "set_param", id: member(g, "blur").id, param: "radius", value: 7 });
    expect(group(s).params.radius).toBe(7);
    expect(s.undoStack).toHaveLength(count + 1);
    s = reduce(s, { type: "undo" });
    expect(group(s).params.radius).toBe(member(group(s), "blur").params.radius);
    expect(group(s).params.radius).toBe(3);
  });

  it("duplicated layers have disjoint members and independent masks", () => {
    let s = run(on(), { type: "add_layer", maskType: "linear" });
    const first = s.activeLayer!;
    const firstGroup = first.replace(/adj$/, "sharpening");
    s = reduce(s, { type: "set_param", id: firstGroup, param: "radius", value: 9 });
    s = reduce(s, { type: "duplicate_layer", id: first });
    const secondGroup = s.activeLayer!.replace(/adj$/, "sharpening");
    const graph = serializeGraph(s);
    const ids = graph.nodes.map(n => n.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of [firstGroup, secondGroup]) {
      expect(member(group(s, id), "blur").params.radius).toBe(9);
      const mask = id.replace(/sharpening$/, "mask");
      expect(graph.connections.filter(w => w.to[0] === member(group(s, id), "mask").id && w.to[1] === "mask").map(w => w.from[0])).toEqual([mask]);
    }
    expect(toolNode({ ...s, activeLayer: null }, "sharpening")!.id).toBe("sharpening");
  });

  it("reset uses only this tool's defaults and restores its recipe", () => {
    const skin = skinGroup("own_skin", 0, 0, { softening: 30 });
    expect(nodeResetValues(skin)).toEqual({ values: { softening: 8, detail_back: 4, strength: 50 }, textValues: {} });
    const sharp = sharpeningGroup("own_sharp", 0, 0, { mode: "hipass", radius: 30 });
    expect(nodeResetValues(sharp)).toEqual({ values: { radius: 3, intensity: 50, keep_color: 100 }, textValues: { mode: "vivid" } });
  });

  it("migration fills a missing mirror dial without discarding member edits", () => {
    const s = on();
    const saved = structuredClone(group(s));
    delete saved.params.keep_color;
    member(saved, "inv").params.amount = 0.4;
    const healed = migrateGraph(s.nodes.map(n => n.id === saved.id ? saved : n), s.wires).nodes.find(n => n.id === saved.id)!;
    expect(healed.params.keep_color).toBe(100);
    expect(member(healed, "inv").params.amount).toBe(0.4);
    const old = structuredClone(saved);
    old.groupNodes = old.groupNodes!.filter(n => n.id !== member(saved, "color").id);
    const migrated = migrateGraph(s.nodes.map(n => n.id === old.id ? old : n), s.wires).nodes.find(n => n.id === old.id)!;
    expect(member(migrated, "inv").params.amount).toBe(0.4);
    expect(migrated.params.keep_color).toBe(100);
  });
});

describe("saved Keep color shapes", () => {
  for (const shape of ["pre-color", "luminosity", "two-node"] as const) {
    it(`loads ${shape} without losing saved member dials or custom edits`, () => {
      const s=on(), saved=structuredClone(group(s));
      const color=member(saved,"color"), scene=member(saved,"scene"), over=member(saved,"over"), display=member(saved,"display");
      delete saved.params.keep_color;
      member(saved,"inv").enabled=false;
      saved.groupNodes!.push({...structuredClone(member(saved,"blur")),id:"custom_review_node",name:"Custom"});
      if(shape === "pre-color") {
        saved.groupNodes=saved.groupNodes!.filter(n=>n.id!==color.id);
        saved.groupWires=saved.groupWires!.filter(w=>w.to!==color.id&&w.from!==color.id);
        saved.groupWires.push({from:over.id,to:scene.id,toPort:"in",kind:"image"});
        saved.published=saved.published!.filter(p=>p.node!==color.id);
      } else {
        color.params.opacity=37;
        color.textParams={mode:shape === "luminosity" ? "luminosity" : "normal"};
        if(shape === "two-node") {
          const lum={...structuredClone(color),id:toolMemberId(saved.id,"sharp","lum"),params:{opacity:100},textParams:{mode:"luminosity"}};
          saved.groupNodes!.splice(0,0,lum);
          saved.groupWires=saved.groupWires!.filter(w=>w.to!==color.id);
          saved.groupWires.push({from:display.id,to:lum.id,toPort:"in",kind:"image"},{from:over.id,to:lum.id,toPort:"in2",kind:"image"},{from:over.id,to:color.id,toPort:"in",kind:"image"},{from:lum.id,to:color.id,toPort:"in2",kind:"image"});
        }
      }
      const load=(g:NodeCard)=>reduce(s,{type:"replace_graph",nodes:s.nodes.map(n=>n.id===g.id?g:n),wires:s.wires});
      const after=group(load(saved));
      expect(after.params.keep_color).toBe(shape === "pre-color" ? 100 : 37);
      expect(member(after,"color").params.opacity).toBe(after.params.keep_color);
      expect(member(after,"inv").enabled).toBe(false);
      expect(after.groupNodes!.some(n=>n.id==="custom_review_node")).toBe(true);
      expect(after.groupBoundary).toEqual(saved.groupBoundary);
      expect(after.published!.find(p=>p.label==="Keep color")?.node).toBe(member(after,"color").id);
      expect(group(load(after))).toEqual(after);
    });
  }
});
