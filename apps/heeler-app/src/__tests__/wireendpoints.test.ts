import { expect, it } from "vitest";
import { initialState } from "../data";
import { makeNode, specFor } from "../nodes";
import { reduce, type State, type Wire } from "../state";
import { serializeGraph } from "../bridge";
const add = (s: State, type: string, id: string) => reduce(s, { type:"add_node", node:makeNode(specFor(type)!,id,0,0) });
const connect = (s:State, wire:Wire) => reduce(reduce(s,{type:"disconnect",to:wire.to,toPort:wire.toPort}),{type:"connect",wire});
const edge = (s: State, to: string, port: string) => serializeGraph(s).connections.find((w) => w.to[0]===to && w.to[1]===port)?.from;

it.each([
  ["heeler.depth_map", "depth"], ["heeler.file", "mask"], ["heeler.export_layer", "mask"],
] as const)("keeps %s.%s through splice, Outside copy, extraction and undo", (type, fromPort) => {
  let s = add(add(initialState(),type,"field"),"heeler.invert_mask","inv");
  s = connect(s,{from:"field",fromPort,to:"cbal",toPort:"mask",kind:"mask"});
  const original = s;
  s = reduce(s,{type:"splice_node_into_wire",id:"inv",from:"field",to:"cbal",toPort:"mask"});
  expect(edge(s,"inv","mask")).toEqual(["field",fromPort]);
  expect(edge(s,"cbal","mask")).toEqual(["inv","out"]);
  s = reduce(s,{type:"extract_node",id:"inv"});
  expect(edge(s,"cbal","mask")).toBeUndefined();
  s = reduce(s,{type:"undo"});
  expect(edge(s,"inv","mask")).toEqual(["field",fromPort]);
  s = reduce(original,{type:"node_outside",id:"cbal"});
  expect(edge(s,"cbal_outmask","mask")).toEqual(["field",fromPort]);
  s = reduce(original,{type:"duplicate_nodes",ids:["field","cbal"]});
  const copiedField = s.nodes.find(n=>s.selection.includes(n.id)&&n.type===type)!;
  const copiedTarget = s.nodes.find(n=>s.selection.includes(n.id)&&n.type==="heeler.color_balance")!;
  expect(edge(s,copiedTarget.id,"mask")).toEqual([copiedField.id,fromPort]);
});

it("preserves Export Layer image endpoints on splice and extraction, clearing the inserted output port", () => {
  let s = add(add(initialState(),"heeler.export_layer","export"),"heeler.exposure","insert");
  s = connect(s,{from:"export",fromPort:"image",to:"output",toPort:"in",kind:"image"});
  s = reduce(s,{type:"splice_node_into_wire",id:"insert",from:"export",to:"output",toPort:"in"});
  expect(edge(s,"insert","in")).toEqual(["export","image"]);
  expect(edge(s,"output","in")).toEqual(["insert","out"]);
  s = reduce(s,{type:"extract_node",id:"insert"});
  expect(edge(s,"output","in")).toEqual(["export","image"]);
  s = reduce(s,{type:"undo"});
  expect(edge(s,"insert","in")).toEqual(["export","image"]);
});

it("flattens grouped outputs by their complete boundary endpoints", () => {
  let s = add(add(initialState(),"heeler.export_layer","export"),"heeler.invert_mask","inv");
  const wires: Wire[] = [
    {from:"export",fromPort:"image",to:"output",toPort:"in",kind:"image"},
    {from:"export",fromPort:"mask",to:"cbal",toPort:"mask",kind:"mask"},
  ];
  for (const wire of wires) s=connect(s,wire);
  s={...s,selection:["export","inv"]};
  s=reduce(s,{type:"group_selection",name:"Fields"});
  expect(edge(s,"output","in")).toEqual(["export","image"]);
  expect(edge(s,"cbal","mask")).toEqual(["export","mask"]);
});
