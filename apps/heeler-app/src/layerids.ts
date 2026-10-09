// A Develop layer's node ids, in one place.
//
// A layer is two nodes, `layer_<n>_adj` and `layer_<n>_mask`, and its
// tools are `layer_<n>_<tool>` beside them. Nothing owned that
// convention: the frontend took the ids apart or built them by hand at
// 64 places in eleven files, in a handful of spellings, and the range
// mask's eyedropper wrote to `activeLayer.replace("_adj", "_mask")`,
// which tied where a sample lands to whichever layer Develop had
// selected. These answer every one of those questions the way the sites
// did, so moving a site here changed nothing it does. Ids are saved
// strings, so the helpers keep each site's own spelling (first `_adj` or
// anchored, as the call site had it) rather than migrating saved graphs.

/** Whether `id` is one of a Develop layer's nodes: its adjustment, its
 * mask, or one of its tools. */
export function isLayerNode(id: string): boolean {
  return /^layer_\d+_/.test(id);
}

/** Whether `id` is a Develop layer's adjustment node, the id a layer is
 * known by (State.activeLayer). */
export function isLayerAdj(id: string): boolean {
  return /^layer_\d+_adj$/.test(id);
}

/** Whether `id` is a Develop layer's mask node. */
export function isLayerMask(id: string): boolean {
  return /^layer_\d+_mask$/.test(id);
}

/** The layer number in a layer node's id, as written ("3" for
 * `layer_3_mask`), or null for an id that is not a layer's. */
export function layerNumber(id: string): string | null {
  return /^layer_(\d+)_/.exec(id)?.[1] ?? null;
}

/** What follows the layer number (`mask`, `adj`, `curves`), or null. */
export function layerPart(id: string): string | null {
  return /^layer_\d+_(\w+)$/.exec(id)?.[1] ?? null;
}

/** The prefix every node of layer `n` carries. */
export function layerPrefix(n: string | number): string {
  return `layer_${n}_`;
}

/** Layer `n`'s node for `part` (`adj`, `mask`, a tool's key). */
export function layerNodeId(n: string | number, part: string): string {
  return `${layerPrefix(n)}${part}`;
}

/** A layer's mask node, from its adjustment node's id. */
export function maskOfLayer(adjId: string): string {
  return adjId.replace("_adj", "_mask");
}

/** The active Develop layer's mask node, or null with Base active. */
export function activeLayerMask(s: { activeLayer: string | null }): string | null {
  return s.activeLayer ? maskOfLayer(s.activeLayer) : null;
}

/** The adjustment node owning any layer node or its prefix, or null. */
export function layerAdjOfNode(id: string): string | null {
  const n = layerNumber(id);
  return n === null ? null : layerNodeId(n, "adj");
}

/** A tool's id from the layer's adjustment id. Keep the old anchored
 * suffix rule for stored active ids that do not follow the convention. */
export function layerToolId(adjId: string, part: string): string {
  return adjId.replace(/_adj$/, `_${part}`);
}

/** The prefix owned by an adjustment id, using the saved suffix rule. */
export function layerGroupPrefix(adjId: string): string {
  return adjId.replace(/adj$/, "");
}

/** The lighting rig's other node. An unmatched suffix stays unchanged,
 * as it did when the rig resolved the twin at its call site. */
export function layerLightingTwin(id: string, part: string): string {
  return id.replace(/_(keylight|flare)$/, `_${part}`);
}
