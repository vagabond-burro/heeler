import { artMaskView, migrateNodes, reduce, sinkArtMasks, type NodeCard, type SelectRegion, type State, type StrokeData } from "../state";

/** A Finish layer's mask as a live selection, the way the Layers panel
 * kept one before 2026-09-30 (art_add_mask's "selection" kind, Mask from
 * selection's copy of a selection: regions, polish strokes, dials and a
 * baked base), NOT yet opened: the graph as it was saved. In the Finish
 * group, where the reducer keeps every Finish mask since 2026-10-01
 * (a graph saved before that opens with it there too). */
export function rawLegacySelectionMask(
  s: State,
  layerId: string,
  content: Pick<NodeCard, "regions" | "strokes" | "params" | "textParams">,
): State {
  // Written on the outside shape (artMaskView), then sunk back.
  const out = artMaskView(reduce(s, { type: "art_add_mask", id: layerId, kind: "brush" }));
  const mid = `art_m_${layerId}`;
  const nodes = out.nodes.map((n) =>
    n.id === mid
      ? {
          ...n,
          type: "heeler.selection_mask",
          params: structuredClone(content.params ?? { antialias: 1 }),
          textParams: content.textParams ? structuredClone(content.textParams) : undefined,
          regions: structuredClone(content.regions ?? []),
          strokes: content.strokes ? structuredClone(content.strokes) : undefined,
        }
      : n,
  );
  return { ...out, ...sinkArtMasks(nodes, out.wires) };
}

/** The same mask opened the way a saved graph opens since (migrateNodes):
 * the pixel mask whose frozen base renders that selection as it
 * rendered. For tests that pin how such a saved layer looks. */
export function legacySelectionMask(s: State, layerId: string, regions: SelectRegion[], strokes?: StrokeData[]): State {
  const raw = rawLegacySelectionMask(s, layerId, { regions, strokes, params: { antialias: 1 } });
  return { ...raw, nodes: migrateNodes(raw.nodes) };
}
