// A Develop section's face drawn from its one definition (SECTIONS in
// simpledata.ts): its rows in order, each with the widgets the row names.
// Develop's panel draws the rows with its own affordances (key hints, the
// override and publish menus, the landing flash) and places the widgets
// through SectionWidgets; Graph's inspector and the tool window draw the
// whole face through SectionFace. Both read the same rows, so a widget
// moved in the definition moves everywhere (2026-10-19, the Recolor node
// in Graph still showing the Neutral guard above the graph and no pairs:
// "Whether in develop or graph, it should be using the same template
// layout").
import React, { useState } from "react";
import type { Command, NodeCard, State } from "../state";
import type { RecolorCellId } from "../eqcurve";
import { RecolorBlock, RecolorHost } from "./recolor";
import { GuardStrip } from "./guardstrip";
import { RecolorPairs } from "./recolorpairs";
import { Slider } from "./simple";
import type { SectionSpec, SectionWidgetKind } from "./simpledata";

type D = (c: Command) => void;

/** The widgets a row carries, in order. `state` is the app's when this
 * window has it: the picker arms, the strip and the pairs read it, and the
 * routing cell is the shared one; without it the cell is the caller's. */
export function SectionWidgets({
  kinds,
  node,
  dispatch,
  state,
  width,
  graphHeight = 160,
  frame,
  cell,
  onCell,
}: {
  kinds: SectionWidgetKind[];
  node: NodeCard;
  dispatch: D;
  state?: State;
  width: number;
  graphHeight?: number;
  frame?: string | null;
  cell: RecolorCellId;
  onCell: (c: RecolorCellId) => void;
}) {
  return (
    <>
      {kinds.map((kind) => {
        if (kind === "recolorGraph") {
          const shared = {
            node,
            allNodes: state?.nodes ?? [],
            clipboard: state?.recolorClipboard ?? null,
            dispatch,
            width,
            height: graphHeight,
            cell,
            onCell,
            pickArmed: state?.recolorPick === node.id,
            hoverX: state?.recolorPick === node.id ? state.recolorHoverX : null,
            onTogglePick: state ? () => dispatch({ type: "toggle_recolor_pick", id: node.id }) : undefined,
            matchArmed: state?.recolorMatch?.id === node.id,
            onToggleMatch: state ? () => dispatch({ type: "toggle_recolor_match", id: node.id }) : undefined,
            depthView: state?.depthView,
            depthRed: state?.maskRed,
            onToggleDepthView: state ? (flavor: boolean) => dispatch({ type: "toggle_depth_view", flavor }) : undefined,
          };
          return (
            <div key={kind} data-testid="section-widget-recolorGraph" style={{ margin: "2px 0 6px" }}>
              {state ? <RecolorHost {...shared} state={state} frame={frame ?? undefined} /> : <RecolorBlock {...shared} histogramSrc={frame ?? undefined} />}
              {/* The Around row's one dial, seated with the row it serves
                  rather than among the node's globals. */}
              {cell.startsWith("around_") && (
                <Slider label="Around reach" param="around_radius" node={node} dispatch={dispatch} centered={false} />
              )}
            </div>
          );
        }
        if (!state) return null;
        if (kind === "guardStrip") return <GuardStrip key={kind} state={state} node={node} cell={cell} dispatch={dispatch} />;
        return <RecolorPairs key={kind} state={state} node={node} dispatch={dispatch} width={width} />;
      })}
    </>
  );
}

/** A section's whole face for one node: its rows in order, each slider
 * with the widgets its row names, as Develop lays it out. Graph's
 * inspector and the tool window draw a section's node through this. */
export function SectionFace({
  sec,
  node,
  dispatch,
  state,
  width,
  graphHeight,
  frame,
}: {
  sec: SectionSpec;
  node: NodeCard;
  dispatch: D;
  state?: State;
  width: number;
  graphHeight?: number;
  frame?: string | null;
}) {
  // The shared routing cell when the app's state is here (the viewer's
  // picker follows it); this face's own otherwise.
  const [localCell, setLocalCell] = useState<RecolorCellId>("hue_sat");
  const cell = state ? state.recolorCell : localCell;
  const onCell = state ? (c: RecolorCellId) => dispatch({ type: "set_recolor_cell", cell: c }) : setLocalCell;
  const rows = sec.rows.filter((r) => !r.when || !state || r.when(state));
  const widgets = (kinds: SectionWidgetKind[] | undefined) =>
    kinds && kinds.length ? (
      <SectionWidgets kinds={kinds} node={node} dispatch={dispatch} state={state} width={width} graphHeight={graphHeight} frame={frame} cell={cell} onCell={onCell} />
    ) : null;
  return (
    <div data-testid={`section-face-${sec.title.toLowerCase().replace(/[^a-z]+/g, "-")}`}>
      {rows.map((r) => (
        <React.Fragment key={r.label}>
          {widgets(r.widgets?.before)}
          <Slider label={r.label} param={r.param} node={(state && r.node?.(state)) || node} dispatch={dispatch} centered={r.centered ?? true} range={r.range} />
          {widgets(r.widgets?.after)}
        </React.Fragment>
      ))}
    </div>
  );
}
