// Both scripting and rendering recognize the same saved layer namespace.
import { expect, it } from "vitest";
import contract from "../layer-id-contract.json";
import { isLayerNode, isLayerAdj, isLayerMask } from "../layerids";

it("recognizes the layer ids shared with the desktop reader", () => {
  for (const row of contract) {
    expect(isLayerNode(row.id), row.id).toBe(row.node);
    expect(isLayerAdj(row.id), row.id).toBe(row.adj);
    expect(isLayerMask(row.id), row.id).toBe(row.mask);
  }
});
