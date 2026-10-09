// Recolor's routing grid (design settled with the owner 2026-08-23): rows
// are what a curve selects BY, columns are what it ADJUSTS. Color grader
// users find their six curves; everyone else finally gets told what these
// curves are. The one reserved cell (lum→lum) is hidden: Relight and
// Curves own that job.

import React from "react";
import { useHueSourceThumb } from "./huesource";
import type { State } from "../state";
import type { Command, NodeCard, RecolorClip } from "../state";
import { CurveClipButtons, scaleRecolorPoints } from "./curveclipboard";
import {
  RECOLOR_AXIS,
  RECOLOR_CELLS,
  RECOLOR_OUT,
  parseRecolorCurves,
  parseRecolorSurfaces,
  recolorDefaultPoints,
  recolorLayouts,
  serializeRecolorCurves,
  RECOLOR_BY,
  type EqPoint,
  type RecolorAdjust,
  type RecolorBy,
  type RecolorCellId,
  type RecolorChannel,
} from "../eqcurve";
import { EqEditor, EQ_PLOT_INSET } from "./eqeditor";
import { DepthViewButton } from "./smarttool";
import { SurfaceEditor } from "./surface";
import { MenuField } from "./menufield";

type D = React.Dispatch<Command>;

const CH_LABEL: Record<RecolorChannel, string> = {
  hue: "Hue",
  sat: "Sat",
  lum: "Lum",
  depth: "Depth",
  around: "Around",
  mask: "Mask",
  huelum: "Hue × Lum",
  pastel: "Pastel",
  temp: "Temp",
  tint: "Tint",
  vib: "Vibrance",
};
/** What each ADJUST column does, for the menu's hint. */
const ADJUST_HINT: Record<RecolorAdjust, string> = {
  hue: "Turn the hue",
  sat: "Scale the saturation",
  lum: "Expose up or down, in stops",
  pastel: "Mix toward white, the painter's tint: a red becomes pink. Negative walks the other way",
  temp: "Warm or cool, like the Color section's Temp: positive warms",
  tint: "Magenta or green, like the Color section's Tint: positive is magenta",
  vib: "Vibrance: saturation that lifts the muted colors first and leaves the vivid alone",
};

/** RecolorBlock with its histogram fed from the color the node's hue
 * rows key on (the same source the Black & White Hue curve draws),
 * falling back to the frame; a host with the app state mounts this. */
export function RecolorHost({
  state,
  frame,
  ...rest
}: Omit<Parameters<typeof RecolorBlock>[0], "histogramSrc"> & { state: State; frame?: string }) {
  const thumb = useHueSourceThumb(state, rest.node.id);
  return <RecolorBlock {...rest} histogramSrc={thumb ?? frame} />;
}

export function RecolorBlock({
  node,
  allNodes = [],
  dispatch,
  width = 272,
  height = 160,
  histogramSrc,
  cell,
  onCell,
  pickArmed = false,
  hoverX = null,
  onTogglePick,
  matchArmed = false,
  onToggleMatch,
  depthView = false,
  onToggleDepthView,
  depthRed = false,
  clipboard = null,
}: {
  node: NodeCard;
  /** Recolor's own curve clipboard (state.recolorClipboard) */
  clipboard?: RecolorClip | null;
  /** every node in the graph, for the Mask row's source menu */
  allNodes?: NodeCard[];
  dispatch: D;
  width?: number;
  height?: number;
  histogramSrc?: string;
  /** the active cell; owned by the caller so the viewer's picker and
   * every window agree on which curve a pick lands in */
  cell: RecolorCellId;
  onCell: (c: RecolorCellId) => void;
  pickArmed?: boolean;
  /** the axis value under the viewer cursor while the picker is armed */
  hoverX?: number | null;
  onTogglePick?: () => void;
  matchArmed?: boolean;
  onToggleMatch?: () => void;
  /** the depth tools' View depth eye, shown over the plot while the Depth
   * row is up ("it should reveal the view depth map button
   * used on the depth tools... on top of the graph and right aligned")*/
  depthView?: boolean;
  /** `flavor`: the modifier click, flipping the mask flavor */
  onToggleDepthView?: (flavor: boolean) => void;
  /** the app-wide mask flavor is the red overlay */
  depthRed?: boolean;
}) {
  const curves = parseRecolorCurves(node.textParams?.curves);
  const spec = RECOLOR_CELLS.find((c) => c.id === cell)!;
  const pts = curves[cell] ?? recolorDefaultPoints(cell);

  const writeCell = (next: EqPoint[]) => {
    dispatch({
      type: "set_text_param",
      id: node.id,
      param: "curves",
      value: serializeRecolorCurves({ ...curves, [cell]: next }),
    });
  };

  // The owner's redesign: not seven buttons but the sentence itself,
  // as two menus: [select by] ▸ [adjust], the second filtered by the
  // first.
  const outputsFor = (input: RecolorBy): RecolorAdjust[] =>
    RECOLOR_CELLS.filter((c) => c.input === input).map((c) => c.output);
  const surfaces = parseRecolorSurfaces(node.textParams?.surfaces);
  const cellActive = (id: RecolorCellId) =>
    id.startsWith("huelum_")
      ? (surfaces[id as keyof typeof surfaces]?.some((row) => row.some((v) => v !== 0)) ?? false)
      : (curves[id]?.some((p) => p.y !== 0) ?? false);
  const inputActive = (input: RecolorBy) =>
    RECOLOR_CELLS.some((c) => c.input === input && cellActive(c.id));
  const cellFor = (input: RecolorBy, output: RecolorAdjust): RecolorCellId =>
    RECOLOR_CELLS.find((c) => c.input === input && c.output === output)!.id;
  // The depth row has no histogram: the plane is not a channel of the
  // photograph's light, and the axis backdrop says NEAR to FAR instead.
  const byDepth = spec.input === "depth";
  // Around wears the hue axis's dress: its x IS a hue, the neighbors'.
  const hist: "hue" | "sat" | "lum" =
    spec.input === "depth" || spec.input === "mask" ? "lum" : spec.input === "around" || spec.input === "huelum" ? "hue" : spec.input;
  const noHist = spec.input === "depth" || spec.input === "mask";
  // The hue→hue cell's verb: Shift (degrees) or Spread (local hue
  // contrast). Same points, different reading; the y axis says which.
  const isHueHue = cell === "hue_hue";
  const spread = isHueHue && (node.textParams?.hue_hue_mode ?? "") === "spread";
  // The picker's words follow the BY axis, naming what the chip reads;
  // before this it wore Relight's, "click a brightness... to re-expose
  // it", on every row. The Depth row's say the click drops a point to
  // hold a subject while the curve is worked around it (2026-09-16: "pick
  // a subject to lock in their adjustments then edit the curve around
  // rest of the scene's depth"). The picture stays the eyedropper on
  // every row, since the cursor over the photograph is one (2026-09-16:
  // "if the cursor is going to be an eye dropper so should the icon").
  const pickWhat = byDepth ? "depth" : spec.input === "sat" ? "saturation" : spec.input === "lum" ? "brightness" : spec.input === "mask" ? "mask coverage" : "color";
  const pickLabel = `Pick a ${pickWhat} from the photo`;
  const pickHint = byDepth
    ? "Pick a depth on the photo: hover to see where it sits on the curve, click to drop a point there and hold it, drag up or down to adjust it"
    : `Pick a ${pickWhat} on the photo: hover to see where it sits on the curve, click to drop a point there, drag up or down to adjust it`;
  // The Mask row's source: any mask node in the graph, by name.
  const byMask = spec.input === "mask";
  const maskNodes = byMask ? allNodes.filter((m) => m.type.endsWith("_mask")) : [];
  // Copy and paste between ADJUST curves (, "curve copying
  // can only be done between ADJUST curves, as the BY curve changes and
  // copying a curve between something like Hue and Depth makes no
  // sense"): a copy carries its BY axis and pastes only over the same
  // one, scaled from the range it was drawn in to the one shown here.
  const yRange: [number, number] = spread ? [-100, 100] : RECOLOR_OUT[spec.output].range;
  const cellLabel = `${CH_LABEL[spec.input]} to ${spread ? "Spread" : CH_LABEL[spec.output]}`;
  const clip = (
    <CurveClipButtons
      testid="recolor-clip"
      what={`the ${cellLabel} curve`}
      clipLabel={clipboard?.label ?? null}
      pasteBlocked={
        clipboard && clipboard.by !== spec.input
          ? `The copied ${clipboard.label} curve selects by ${CH_LABEL[clipboard.by]}; it pastes onto another ${CH_LABEL[clipboard.by]} row, not onto ${CH_LABEL[spec.input]}`
          : null
      }
      onCopy={() =>
        dispatch({
          type: "copy_recolor_curve",
          clip: { by: spec.input, points: pts.map((p) => ({ ...p })), range: yRange, label: cellLabel },
        })
      }
      onPaste={() => {
        if (!clipboard || clipboard.by !== spec.input) return;
        writeCell(scaleRecolorPoints(clipboard.points, clipboard.range, yRange));
      }}
    />
  );

  return (
    <div data-testid="recolor-block">
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 5, fontSize: 9, paddingLeft: EQ_PLOT_INSET }}>
        <span style={{ color: "var(--text-dim)", letterSpacing: ".08em" }}>BY</span>
        <MenuField
          testid="recolor-by"
          label="Select pixels by"
          hint="Which channel decides WHICH pixels the curve touches"
          size="regular"
          value={spec.input}
          options={RECOLOR_BY.map((input) => ({ id: input, label: `${CH_LABEL[input]}${inputActive(input) ? " ●" : ""}` }))}
          fitLabels={RECOLOR_BY.map((input) => `${CH_LABEL[input]} ●`)}
          onChange={(id) => {
            const input = id as RecolorBy;
            const outs = outputsFor(input);
            const output = outs.includes(spec.output) ? spec.output : outs[0];
            onCell(cellFor(input, output));
          }}
        />
        <span style={{ color: "var(--text-ghost)" }}>▸</span>
        <span style={{ color: "var(--text-dim)", letterSpacing: ".08em" }}>ADJUST</span>
        <MenuField
          testid="recolor-adjust"
          label="Adjust"
          hint={`What CHANGES for those pixels. ${ADJUST_HINT[spec.output]}`}
          size="regular"
          value={spec.output}
          options={outputsFor(spec.input).map((output) => ({ id: output, label: `${CH_LABEL[output]}${cellActive(cellFor(spec.input, output)) ? " ●" : ""}` }))}
          fitLabels={outputsFor(spec.input).map((output) => `${CH_LABEL[output]} ●`)}
          onChange={(id) => onCell(cellFor(spec.input, id as RecolorAdjust))}
        />
        {isHueHue && (
          <div
            className="zoom-seg"
            role="group"
            aria-label="Hue curve verb"
            data-hint="Shift turns hues by the curve's degrees. Spread reads it as hue contrast: +100 pulls hues twice as far apart, -100 merges them, with no overall turn"
            style={{ border: "1px solid var(--line-4)", marginLeft: "auto" }}
          >
            {(["shift", "spread"] as const).map((m) => (
              <button
                key={m}
                data-active={(m === "spread") === spread} aria-pressed={!!((m === "spread") === spread)}
                data-testid={`recolor-hue-mode-${m}`}
                style={{ fontSize: 9, padding: "1px 6px", textTransform: "capitalize" }}
                onClick={() =>
                  dispatch({ type: "set_text_param", id: node.id, param: "hue_hue_mode", value: m === "spread" ? "spread" : "" })
                }
              >
                {m}
              </button>
            ))}
          </div>
        )}
      </div>
      {spec.input === "huelum" ? (
        <SurfaceEditor
          node={node}
          dispatch={dispatch}
          width={width}
          height={height}
          id={`huelum_${spec.output}`}
          range={RECOLOR_OUT[spec.output].range}
          unit={RECOLOR_OUT[spec.output].unit}
          snap={RECOLOR_OUT[spec.output].snap}
        />
      ) : (
      <EqEditor
        node={node}
        dispatch={dispatch}
        width={width}
        height={height}
        histogramSrc={noHist ? undefined : histogramSrc}
        domain={RECOLOR_AXIS[spec.input].domain}
        xTicks={RECOLOR_AXIS[spec.input].ticks}
        yRange={yRange}
        yUnit={spread ? "%" : RECOLOR_OUT[spec.output].unit}
        periodic={RECOLOR_AXIS[spec.input].periodic}
        histChannel={hist}
        // The hue rows draw the histogram as bars in their own hue, the Black
        // & White Hue curve's way (2026-09-14: "Add the same color bar
        // histogram").
        spectrumBars={hist === "hue"}
        axisBackground={spec.input === "around" ? "hue" : spec.input}
        xEndLabels={byDepth ? ["NEAR", "FAR"] : undefined}
        points={pts}
        onPoints={writeCell}
        // SHIFT-drag steps, from the tables beside the domains they
        // belong to: the BY axis brings the x step, the ADJUST axis the
        // y step, so a cell's snapping follows its two menus.
        snapX={RECOLOR_AXIS[spec.input].snap}
        snapY={spread ? 10 : RECOLOR_OUT[spec.output].snap}
        // Below two points the serializer drops the cell and it snaps
        // back to its default layout, so removal stops at two here.
        minPoints={2}
        presets={recolorLayouts(spec.input)}
        pickArmed={pickArmed}
        onTogglePick={onTogglePick}
        pickLabel={pickLabel}
        pickHint={pickHint}
        hoverX={hoverX}
        matchArmed={matchArmed}
        onToggleMatch={onToggleMatch}
        // The Layout row's right end carries the row's one extra seat: the depth
        // tools' View depth eye while the Depth row is up
        // ("vertically aligned with the layout dropdown, there is plenty of
        // horizontal space"), or the Mask row's source menu ("below
        // ADJUST, vertically aligned with layout, and right aligned to the
        // graph"). The clipboard pair takes the far right corner, opposite the
        // Layout menu (, "on top of the graph and right aligned with
        // the top right corner, so they are horizontally opposite to the layout
        // control").
        trailing={
          <>
          {byMask ? (
            <MenuField
              testid="recolor-by-mask"
              label="Mask to select by"
              hint="Which mask's coverage is the axis: 0 outside it, 100 inside, the fringe in between"
              node={node.id}
              param="by_mask"
              size="regular"
              value={node.textParams?.by_mask ?? ""}
              placeholder="Choose a mask…"
              // A chosen mask clears through None, the row the native
              // select's "Choose a mask…" option used to be; while
              // nothing is chosen the prompt is the placeholder and no
              // dead None row sits in the list.
              options={[
                ...(node.textParams?.by_mask ? [{ id: "", label: "None" }] : []),
                ...maskNodes.map((m) => ({ id: m.id, label: m.name })),
              ]}
              onChange={(value) => dispatch({ type: "set_text_param", id: node.id, param: "by_mask", value })}
            />
          ) : byDepth && onToggleDepthView ? (
            <DepthViewButton depthView={!!depthView} red={depthRed} onToggle={onToggleDepthView}
              testid="recolor-depth-view" />
          ) : null}
          <div style={{ display: "flex", alignItems: "center", marginLeft: 6 }}>{clip}</div>
          </>
        }
      />
      )}
    </div>
  );
}
