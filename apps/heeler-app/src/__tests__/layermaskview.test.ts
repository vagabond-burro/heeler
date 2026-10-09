// "if I was viewing a mask on an adjustment layer, then I delete the
// adjustment layer, and later create a new adjustment layer the option
// to show the mask persists."
import { describe, expect, it } from "vitest";
import { initialState } from "../data";
import { maskPreviewNode, reduce, type Command, type State } from "../state";

const run = (s: State, ...cmds: Command[]) => cmds.reduce(reduce, s);

describe("the mask view belongs to the layer it shows", () => {
  it("goes when that layer is deleted, and a new layer starts on the photograph", () => {
    let s = run(initialState(), { type: "add_layer", maskType: "radial" }, { type: "toggle_mask_view" });
    const first = s.activeLayer!;
    expect(maskPreviewNode(s)).toBe(first.replace("_adj", "_mask"));
    s = run(s, { type: "remove_layer", id: first });
    expect(s.maskView).toBe(false);
    s = run(s, { type: "add_layer", maskType: "radial" });
    expect(s.maskView).toBe(false);
    expect(maskPreviewNode(s)).toBeNull();
  });

  it("a new layer made while another's mask is up starts on the photograph", () => {
    const s = run(initialState(), { type: "add_layer", maskType: "radial" }, { type: "toggle_mask_view" }, { type: "add_layer", maskType: "linear" });
    expect(s.maskView).toBe(false);
  });

  it("deleting a layer that is not the one shown leaves the view up", () => {
    let s = run(initialState(), { type: "add_layer", maskType: "radial" });
    const other = s.activeLayer!;
    s = run(s, { type: "add_layer", maskType: "linear" }, { type: "toggle_mask_view" }, { type: "remove_layer", id: other });
    expect(s.maskView).toBe(true);
  });

  // 2026-09-27: viewing the depth map on an adjustment layer and
  // deleting the layer left the depth map up.
  it("the depth view goes with the layer too, from the panel and from the graph", () => {
    const withDepth = () =>
      run(
        initialState(),
        { type: "add_layer", maskType: "radial" },
        { type: "set_param", id: "layer_1_mask", param: "depth_on", value: 1 },
        { type: "toggle_depth_view" },
      );
    let s = withDepth();
    expect(s.depthView).toBe(true);
    s = run(s, { type: "remove_layer", id: "layer_1_adj" });
    expect(s.depthView).toBe(false);
    // Undo brings the layer back with the view off; redo stays off.
    s = run(s, { type: "undo" }, { type: "redo" });
    expect(s.depthView).toBe(false);
    // From the graph editor: delete the layer's nodes directly.
    s = withDepth();
    s = run(s, { type: "delete_nodes", ids: ["layer_1_adj", "layer_1_mask"], heal: true });
    expect(s.nodes.some((n) => n.id === "layer_1_adj")).toBe(false);
    expect(s.depthView).toBe(false);
  });

  it("a new layer starts off the depth view, and deleting another layer leaves it up", () => {
    let s = run(initialState(), { type: "add_layer", maskType: "radial" }, { type: "toggle_depth_view" }, { type: "add_layer", maskType: "linear" });
    expect(s.depthView).toBe(false);
    const first = "layer_1_adj";
    s = run(s, { type: "toggle_depth_view" }, { type: "remove_layer", id: first });
    expect(s.activeLayer).toBe("layer_2_adj");
    expect(s.depthView).toBe(true);
  });

  it("a Finish layer's mask view goes with it too", () => {
    let s = run(initialState(), { type: "art_add_layer", kind: "paint" }, { type: "toggle_mask_view" });
    expect(s.maskView).toBe(true);
    s = run(s, { type: "art_remove_layer", id: s.artActive! });
    expect(s.maskView).toBe(false);
    // And its depth view (the Finish layer's Depth block has the eye too).
    let d = run(initialState(), { type: "art_add_layer", kind: "paint" }, { type: "toggle_depth_view" });
    expect(d.depthView).toBe(true);
    d = run(d, { type: "art_remove_layer", id: d.artActive! });
    expect(d.depthView).toBe(false);
  });
});
