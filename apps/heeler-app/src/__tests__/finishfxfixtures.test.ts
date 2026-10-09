import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { initialState } from "../data";
import { ART_ADJUSTMENTS, ART_FX, artMaskOf, artLayers, reduce, type Command, type NodeCard, type State } from "../state";
import { serializeGraph } from "../bridge";
import fixtures from "./fixtures/finish-fx-review.json";
const run = (s: State, ...cs: Command[]) => cs.reduce(reduce, s);
function base(): State {
  const n = (id: string, type: string): NodeCard => ({ id, type, name: id, cat: "color", enabled: true, params: {}, x: 0, y: 0 });
  return { ...initialState(), nodes: [n("review_source", "heeler.image_source"), n("output", "heeler.output")], wires: [{ from: "review_source", to: "output", toPort: "in", kind: "image" }] };
}
export function reviewFixtures() {
  const out: Record<string, ReturnType<typeof serializeGraph>> = {};
  for (const kind of ART_ADJUSTMENTS) {
    const s = run(base(), { type: "art_add_layer", kind });
    out[`neutral_${kind}`] = serializeGraph(run(s, { type: "art_set_export", id: s.artActive!, on: true }, { type: "art_set_mask_export", id: s.artActive!, on: true }));
  }
  let s = run(base(), { type: "art_add_layer", kind: "fill" }, { type: "art_content_set", id: "art_b1", param: "color", value: "#804020" }, { type: "art_layer_set", id: "art_b1", opacity: 50 }, { type: "art_add_layer", kind: "exposure" }, { type: "art_content_set", id: "art_b2", param: "exposure", value: 1 });
  out.exposure = serializeGraph(run(base(), { type: "art_add_layer", kind: "exposure" }, { type: "art_content_set", id: "art_b1", param: "exposure", value: 1 }));
  out.group_adjustment = serializeGraph(run(s, { type: "art_group_layers", ids: artLayers(s).map(l => l.blend.id) }));
  let clipped = run(base(), { type: "art_add_layer", kind: "fill" }, { type: "art_content_set", id: "art_b1", param: "color", value: "#804020" }, { type: "art_layer_set", id: "art_b1", opacity: 50 }, { type: "art_add_layer", kind: "invert" }, { type: "art_clip_layer", id: "art_b2", clip: true });
  out.clipped_invert = serializeGraph(clipped);
  clipped = run(clipped, { type: "art_add_layer", kind: "invert" }, { type: "art_clip_layer", id: "art_b3", clip: true });
  out.clipped_double_invert = serializeGraph(clipped);
  for (const key of Object.keys(ART_FX)) {
    let s = run(base(), { type: "art_add_layer", kind: "paint" }, { type: "art_add_stroke", id: "art_b1", stroke: { points: [[0.5,0.5]], radius: 0.1, color: "#ff0000" } }, { type: "art_add_fx", id: "art_b1", fx: key }, { type: "art_set_export", id: "art_b1", on: true });
    out[`effect_${key}`] = serializeGraph(s);
    s = run(s, { type: "art_add_mask", id: "art_b1", kind: "brush" });
    s = run(s, { type: "set_param", id: artMaskOf(s, "art_b1")!.id, param: "invert", value: 0 });
    out[`masked_${key}`] = serializeGraph(s);
  }
  out.warp_blur = serializeGraph(run(base(), { type: "art_add_layer", kind: "warp" }, { type: "art_add_mask", id: "art_b1", kind: "brush" }, { type: "art_add_fx", id: "art_b1", fx: "blur" }));
  const image = run(base(), { type: "art_add_layer", kind: "image" },
    { type: "art_set_quad", id: "art_b1", box: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, corners: [[0.25,0.25],[0.75,0.25],[0.75,0.75],[0.25,0.75]] },
    { type: "art_add_fx", id: "art_b1", fx: "glow" }, { type: "art_set_export", id: "art_b1", on: true });
  out.image_glow = serializeGraph(image);
  return out;
}
it("actual frontend Finish graphs match the native pixel fixtures", () => {
  const actual = reviewFixtures();
  if (process.env.HEELER_UPDATE_FINISH_FX_FIXTURES === "1") writeFileSync(resolve(process.cwd(), "src/__tests__/fixtures/finish-fx-review.json"), JSON.stringify(actual, null, 1)+"\n");
  expect(actual).toEqual(fixtures);
});
