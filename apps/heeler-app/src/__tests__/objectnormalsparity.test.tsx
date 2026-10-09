import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { initialState } from "../data";
import { makeNode, specFor } from "../nodes";
import { reduce, PARAM_OPTIONS, type Command, type State } from "../state";
import { serializeGraph } from "../bridge";
import { NodeParams } from "../ui/graph";
import { LayersSection, SimplePanel } from "../ui/simple";

function withPasses(s: State) {
  return reduce(s,{type:"file_passes_known",image:s.activeImage,passes:{depth:"Z",normals:"Normal.Z",camera:false,
    mattes:[{layer:"CryptoObject",names:["Suzanne","Ground"]}],channels:[],pages:[],layers:[],layered:false}});
}
it.each(["develop","inspector"])("Object names from %s serialize onto their own node", seat => {
  let s=withPasses(reduce(initialState(),{type:"add_layer",maskType:"object"}));
  const active=s.activeLayer!.replace("_adj","_mask");
  s=reduce(s,{type:"add_node",node:makeNode(specFor("heeler.matte_mask")!,"inspected",0,0)});
  const target=seat==="develop"?active:"inspected";
  const dispatch=(c:Command)=>{s=reduce(s,c);};
  render(seat==="develop"?<LayersSection state={s} dispatch={dispatch}/>:
    <NodeParams node={s.nodes.find(n=>n.id===target)!} appState={s} dispatch={dispatch}/>);
  fireEvent.click(screen.getByTestId("object-name-Suzanne"));
  const graph=serializeGraph(s);
  expect(graph.nodes.find(n=>n.id===target)?.params).toMatchObject({layer:"CryptoObject",names:'["Suzanne"]'});
  if(seat==="inspector") expect(graph.nodes.find(n=>n.id===active)?.params).toMatchObject({names:"[]"});
});

it.each(["develop","inspector"])("Depth Lighting normals from %s serialize each choice", seat => {
  let s=withPasses(reduce(initialState(),{type:"set_param",id:"keylight",param:"strength",value:50}));
  s={...s,sectionsClosed:[],panelTab:"adjust"} as State;
  if(seat==="inspector") s=reduce(s,{type:"add_node",node:makeNode(specFor("heeler.key_light")!,"inspected_light",0,0)});
  const id=seat==="develop"?"keylight":"inspected_light";
  const dispatch=(c:Command)=>{s=reduce(s,c);};
  render(seat==="develop"?<SimplePanel state={s} dispatch={dispatch}/>:
    <NodeParams node={s.nodes.find(n=>n.id===id)!} appState={s} dispatch={dispatch}/>);
  expect(PARAM_OPTIONS["heeler.key_light"].normals.map(o=>o.id)).toEqual(["auto","camera","off"]);
  for(const mode of ["camera","off","auto"]){
    fireEvent.click(screen.getByTestId(`keylight-normals-${mode}`));
    expect(serializeGraph(s).nodes.find(n=>n.id===id)?.params).toMatchObject({normals:mode});
  }
});

it.each(["appState", "depthState"] as const)("the inspector shares light-kind controls with %s", seat => {
  let s = reduce(initialState(), { type: "add_node", node: makeNode(specFor("heeler.key_light")!, "inspected_light", 0, 0) });
  s = reduce(s, { type: "select_keylight", index: 0 });
  const original = s.nodes.find(n => n.id === "keylight");
  const dispatch = (c: Command) => { s = reduce(s, c); };
  const view = render(<NodeParams node={s.nodes.find(n => n.id === "inspected_light")!} {...{ [seat]: s }} dispatch={dispatch} />);
  const point = screen.getByRole("button", { name: "Point light" });
  expect(point.querySelector("svg")).not.toBeNull();
  expect(point).toHaveAttribute("data-hint");
  fireEvent.click(point);
  view.rerender(<NodeParams node={s.nodes.find(n => n.id === "inspected_light")!} {...{ [seat]: s }} dispatch={dispatch} />);
  expect(screen.getByRole("button", { name: "Point light" })).toHaveAttribute("aria-pressed", "true");
  expect(JSON.parse(s.nodes.find(n => n.id === "inspected_light")!.textParams!.lights)[0].kind).toBe("point");
  expect(s.nodes.find(n => n.id === "keylight")).toEqual(original);
});
