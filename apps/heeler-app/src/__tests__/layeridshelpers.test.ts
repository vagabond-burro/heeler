// layerids.ts answers exactly what the hand-written sites it replaced
// answered: each helper against the expression it stands for, over ids
// of every shape the graph holds and a few it never should.

import { describe, expect, it } from "vitest";
import {
  activeLayerMask,
  isLayerAdj,
  isLayerMask,
  isLayerNode,
  layerNodeId,
  layerNumber,
  layerPart,
  layerPrefix,
  maskOfLayer,
} from "../layerids";

const IDS = [
  "layer_1_adj", "layer_1_mask", "layer_12_adj", "layer_12_mask", "layer_3_curves", "layer_3_keylight",
  "layer_3_flare", "layer_7_detail", "layer_2_colorconsole", "layer__adj", "layer_x_adj", "layer_1",
  "layer_1_", "player_1_adj", "layer_1_adj_copy", "adj", "src", "output", "art_m_4", "cset2_mask",
  "exposure", "", "layer_1_adjust", "layer_1_masked",
];

describe("layer ids, against the expressions the sites used", () => {
  it("isLayerNode is /^layer_\\d+_/", () => {
    for (const id of IDS) expect(isLayerNode(id), id).toBe(/^layer_\d+_/.test(id));
  });
  it("isLayerAdj and isLayerMask are the exact-suffix patterns", () => {
    for (const id of IDS) {
      expect(isLayerAdj(id), id).toBe(/^layer_\d+_adj$/.test(id));
      expect(isLayerMask(id), id).toBe(/^layer_\d+_mask$/.test(id));
    }
  });
  it("layerNumber and layerPart are the capture groups, null where nothing matched", () => {
    for (const id of IDS) {
      expect(layerNumber(id), id).toBe(/^layer_(\d+)_/.exec(id)?.[1] ?? null);
      expect(layerPart(id), id).toBe(/^layer_\d+_(\w+)$/.exec(id)?.[1] ?? null);
    }
    expect(layerNumber("layer_12_mask")).toBe("12");
    expect(layerPart("layer_3_curves")).toBe("curves");
  });
  it("the builders are the template strings", () => {
    for (const n of ["1", "12", 3, 40]) {
      expect(layerPrefix(n)).toBe(`layer_${n}_`);
      for (const part of ["adj", "mask", "detail"]) expect(layerNodeId(n, part)).toBe(`layer_${n}_${part}`);
    }
  });
  it("maskOfLayer is the replace both spellings agree on for a layer's id", () => {
    for (const id of IDS) expect(maskOfLayer(id), id).toBe(id.replace("_adj", "_mask"));
    // The two sites that spelled it /_adj$/ only ever held a layer's
    // adjustment id, where the spellings agree.
    for (const id of IDS.filter(isLayerAdj)) expect(maskOfLayer(id), id).toBe(id.replace(/_adj$/, "_mask"));
  });
  it("activeLayerMask is the active layer's mask, null on Base", () => {
    expect(activeLayerMask({ activeLayer: "layer_4_adj" })).toBe("layer_4_mask");
    expect(activeLayerMask({ activeLayer: null })).toBeNull();
  });
});
