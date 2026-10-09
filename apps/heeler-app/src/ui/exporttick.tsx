import { artLayers, layerMaskExported, layersOf, type Command, type State } from "../state";

type D = (c: Command) => void;

/** The Finish layer's Export checkbox (26.3 Phase 8): a view over the
 * Export Layer node that taps the layer's content. The same component
 * draws in the layer row and in the blend node's graph inspector, so
 * the two can never disagree. An adjustment layer changes what is
 * below it and has no picture of its own: no checkbox, a dimmed
 * placeholder that says why.
 *
 * The same box serves every checkbox that makes an Export Layer node
 * (2026-09-30): a Develop section's output, the Depth Map's plane and
 * a Finish layer's mask. Those pass `toggle`, the command a click
 * sends for the new state, and `what`, the thing it writes, for the
 * words.*/
export function ExportTick({
  id,
  exported,
  adjust,
  dispatch,
  toggle,
  what,
  label,
  hint,
  testid,
}: {
  id: string;
  exported: boolean;
  adjust: boolean;
  dispatch: D;
  /** the command for turning it on or off; the Finish layer's own by default */
  toggle?: (on: boolean) => Command | null;
  /** what gets written, in the hint's words ("this layer" by default) */
  what?: string;
  /** the box's name, for a seat whose words say it plainly (the mask's
   * "Export Mask as Layer"); built from `what` by default */
  label?: string;
  /** the hint, off and on, when `what` alone cannot say it */
  hint?: { off: string; on: string };
  /** the test id; `art-export-<id>` by default */
  testid?: string;
}) {
  const tid = testid ?? `art-export-${id}`;
  if (adjust) {
    return (
      <span
        data-testid={tid}
        data-offered="no"
        aria-label="No export for an adjustment layer"
        data-hint="An adjustment layer has no picture to export; Export Mask as Layer, under its Depth mask, writes its mask"
        style={{
          display: "inline-block",
          width: 9,
          height: 9,
          borderRadius: 2,
          border: "1px solid var(--line-4)",
          opacity: 0.35,
        }}
      />
    );
  }
  const thing = what ?? "this layer";
  return (
    <button
      style={{ all: "unset", cursor: "pointer", width: 12, textAlign: "center", flex: "none" }}
      data-testid={tid}
      data-on={exported}
      role="checkbox"
      aria-checked={exported}
      aria-label={label ?? (exported ? `Stop exporting ${thing}` : `Export ${thing}`)}
      data-hint={
        hint
          ? exported
            ? hint.on
            : hint.off
          : exported
            ? `${cap(thing)} writes into the export as its own layer; click to stop`
            : `Write ${thing} into the export as its own layer, in the EXR or as a sibling TIFF`
      }
      onClick={(e) => {
        e.stopPropagation();
        const cmd = toggle ? toggle(!exported) : ({ type: "art_set_export", id, on: !exported } as Command);
        if (cmd) dispatch(cmd);
      }}
    >
      <span
        style={{
          display: "inline-block",
          width: 9,
          height: 9,
          borderRadius: 2,
          background: exported ? "var(--accent)" : "transparent",
          border: `1px solid ${exported ? "var(--accent)" : "var(--line-4)"}`,
        }}
      />
    </button>
  );
}

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** The mask checkbox's name in every seat (2026-09-30: "make sure
 * that is labeled something like "Export Mask as Layer" since its
 * not exporting RGB I want to be clear what its exporting").*/
export const MASK_EXPORT_LABEL = "Export Mask as Layer";

/** What the mask checkbox writes, in its hint: outcome first. */
export const MASK_EXPORT_HINT = {
  off: "Writes this layer's mask into the export as a gray layer (not the picture): the painted mask, times the Depth mask when it is on, times the layer's opacity and clipping, in the EXR or as a sibling TIFF",
  on: "This layer's mask writes into the export as a gray layer: the painted mask, times the Depth mask when it is on, times the layer's opacity and clipping; click to stop",
};

/** A Finish layer's MASK checkbox (2026-09-30): one Export Layer node
 * per mask, writing the weight the layer's blend applies (mask, depth
 * mask, clipping and opacity) as a gray layer. Three seats show the
 * one node: the row under the layer's Depth mask, the brush panel's
 * button row while the mask is being painted, and the blend node's
 * inspector. A layer inside a Finish group has none (its export is the
 * group's).*/
export function MaskExportTick({
  state,
  blendId,
  dispatch,
  testid,
}: {
  state: State;
  blendId: string;
  dispatch: D;
  testid: string;
}) {
  const layer = artLayers(state).find((l) => l.blend.id === blendId);
  if (!layer) return null;
  return (
    <ExportTick
      id={blendId}
      testid={testid}
      exported={!!layer.maskExported}
      adjust={false}
      what={`the mask of ${layer.blend.name}, as its blend applies it`}
      label={MASK_EXPORT_LABEL}
      hint={MASK_EXPORT_HINT}
      toggle={(on) => ({ type: "art_set_mask_export", id: blendId, on })}
      dispatch={dispatch}
    />
  );
}

/** What a Develop layer's mask checkbox writes: the same gray as the
 * Finish layers' (2026-09-30), read off the weight the layer's
 * adjustments are applied through. A Develop layer has no clipping.*/
export const LAYER_MASK_EXPORT_HINT = {
  off: "Writes this layer's mask into the export as a gray layer (not the picture): its mask, times the Depth mask when it is on, times the layer's Opacity, in the EXR or as a sibling TIFF",
  on: "This layer's mask writes into the export as a gray layer: its mask, times the Depth mask when it is on, times the layer's Opacity; click to stop",
};

/** A DEVELOP adjustment layer's mask checkbox (2026-10-01, asked a
 * third time: "The Export Mask as Layer option underneath Depth mask
 * in adjustment layers"): one Export Layer node per layer, writing the
 * weight its adjustments are applied through as a gray layer. Two
 * seats show the one node: the row under the layer's Depth mask block
 * in Develop, and the layer's node in the graph inspector.*/
export function LayerMaskExportTick({
  state,
  layerId,
  dispatch,
  testid,
}: {
  state: State;
  layerId: string;
  dispatch: D;
  testid: string;
}) {
  const layer = layersOf(state).find((l) => l.id === layerId);
  if (!layer) return null;
  return (
    <ExportTick
      id={layerId}
      testid={testid}
      exported={layerMaskExported(state, layerId)}
      adjust={false}
      what={`the mask of ${layer.name}, as its adjustments apply it`}
      label={MASK_EXPORT_LABEL}
      hint={LAYER_MASK_EXPORT_HINT}
      toggle={(on) => ({ type: "set_layer_mask_export", id: layerId, on })}
      dispatch={dispatch}
    />
  );
}

/** The row that seats it: the box and its words, "Export Mask as Layer". */
export function LayerMaskExportRow({
  state,
  layerId,
  dispatch,
  testid,
}: {
  state: State;
  layerId: string;
  dispatch: D;
  testid: string;
}) {
  if (!layersOf(state).some((l) => l.id === layerId)) return null;
  return (
    <div data-testid={`${testid}-row`} style={{ display: "flex", alignItems: "center", gap: 6, margin: "2px 0 6px" }}>
      <LayerMaskExportTick state={state} layerId={layerId} dispatch={dispatch} testid={testid} />
      <span style={{ fontSize: 11, color: "var(--text-faint)" }}>{MASK_EXPORT_LABEL}</span>
    </div>
  );
}
