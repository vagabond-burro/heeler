// A Develop section's face drawn from its one definition (SECTIONS in
// simpledata.ts): its rows in order, each with the widgets the row names,
// and the section's own widgets before and after the rows. Develop's
// panel draws the rows with its own affordances (key hints, the override
// and publish menus, the landing flash) and places the widgets through
// SectionWidgets; Graph's inspector and the tool windows draw the whole
// face through SectionFace. All of them read the same definition, so a
// widget moved there moves everywhere (2026-10-19, the Recolor node in
// Graph still showing the Neutral guard above the graph and no pairs:
// "Whether in develop or graph, it should be using the same template
// layout").
import React, { useState } from "react";
import type { Command, NodeCard, State } from "../state";
import { curveModeOf } from "../state";
import type { RecolorCellId } from "../eqcurve";
import { assignHints } from "../keynav";
import { isLayerNode } from "../layerids";
import { RecolorBlock, RecolorHost } from "./recolor";
import { GuardStrip } from "./guardstrip";
import { RecolorPairs } from "./recolorpairs";
import { DetailAdvanced, RowHeading, Slider, ToolPopBar, WheelsHelp } from "./simple";
import { EqEditor } from "./eqeditor";
import { ColorConsoleBlock } from "./colorconsole";
import { CurveEditor, Wheel } from "./editors";
import { BendBar, BendWheel } from "./bend";
import { LevelsEditor } from "./levels";
import { ZonesBlock } from "./zones";
import { CropToPictureRow, FlipPhotoRow } from "./flipphoto";
import { PrintControls } from "./print";
import { DETAIL_WEIGHT_PARAMS, sectionWidgetKinds, type SectionSpec, type SectionWidgetKind, type SectionWidgetSeats } from "./simpledata";
import { WINDOWED_ROWS } from "./sectionfaceparts";
import { WhiteBalanceRow } from "./whitebalancerow";

type D = (c: Command) => void;

/** How a face is drawn where it is drawn: the panel's own affordances,
 * and the sizes a tool window redraws its widgets at. */
interface FaceFrame {
  /** the app's state, when this window has it: the pickers arm, the
   * strips and the pairs read it, and the routing cell and Color Tune's
   * band are the shared ones; without it they are the face's own */
  state?: State;
  /** a state to read from where there is no app state to act on (the
   * popped-out graph window): the Levels histogram's bins */
  viewState?: State;
  /** the widgets' drawn width */
  width: number;
  /** the plots' drawn height (Recolor's curve, the EQ, the curve
   * editor, Color Tune's window layout); each widget's own default when
   * absent */
  graphHeight?: number;
  /** each Color Wheel's drawn size, for a window that fits them to its
   * room; the wheel's own default when absent */
  discSize?: number;
  /** the frame on screen; the photograph's thumbnail stands in for the
   * histograms until one lands */
  frame?: string | null;
  /** the viewer shows a real engine render (Color Bend says so when an
   * edit cannot be previewed) */
  engine?: boolean;
  /** Develop's panel: a tool popped out to its own window folds to its
   * bar, and the keyboard's letters show on the wheels */
  panel?: boolean;
  /** a tool window's layout, for the widgets that have one (Color Tune
   * puts its wheel on the left and its controls on the right) */
  windowed?: boolean;
}

/** The widgets a section or one of its rows carries, in order. */
export function SectionWidgets({
  kinds,
  node,
  dispatch,
  state,
  viewState,
  width,
  graphHeight,
  discSize,
  frame,
  engine,
  panel = false,
  windowed = false,
  cell: cellGiven,
  onCell: onCellGiven,
}: FaceFrame & {
  kinds: SectionWidgetKind[];
  node: NodeCard;
  dispatch: D;
  /** Recolor's routing cell, when the caller keeps it */
  cell?: RecolorCellId;
  onCell?: (c: RecolorCellId) => void;
}) {
  const [localCell, setLocalCell] = useState<RecolorCellId>("hue_sat");
  const [localBand, setLocalBand] = useState("r");
  const cell = cellGiven ?? (state ? state.recolorCell : localCell);
  const onCell = onCellGiven ?? (state ? (c: RecolorCellId) => dispatch({ type: "set_recolor_cell", cell: c }) : setLocalCell);
  const thumb = state?.images.find((i) => i.id === state.activeImage)?.src;
  // The live frame where there is one, so a histogram moves as the
  // points move; the thumbnail until the first frame lands.
  const shown = frame ?? thumb;
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
            height: graphHeight ?? 160,
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
              {state ? <RecolorHost {...shared} state={state} frame={shown} /> : <RecolorBlock {...shared} histogramSrc={shown ?? undefined} />}
              {/* The Around row's one dial, seated with the row it serves
                  rather than among the node's globals. */}
              {cell.startsWith("around_") && (
                <Slider label="Around reach" param="around_radius" node={node} dispatch={dispatch} centered={false} />
              )}
            </div>
          );
        }
        // Each widget is marked by its kind (section-widget-<kind>), so a
        // face's order can be read off the page and checked.
        const mark = (el: React.ReactNode) => (
          <div key={kind} data-testid={`section-widget-${kind}`}>
            {el}
          </div>
        );
        if (kind === "guardStrip") return state ? mark(<GuardStrip state={state} node={node} cell={cell} dispatch={dispatch} />) : null;
        if (kind === "recolorPairs") return state ? mark(<RecolorPairs state={state} node={node} dispatch={dispatch} width={width} />) : null;
        if (kind === "toneEq") {
          return (
            <div key={kind} data-testid="section-widget-toneEq" style={{ margin: "2px 0 6px" }}>
              <EqEditor
                node={node}
                dispatch={dispatch}
                width={width}
                height={graphHeight}
                histogramSrc={shown ?? undefined}
                pickArmed={state?.toneEqPick === node.id}
                hoverX={state?.toneEqPick === node.id ? state.toneEqHoverX : null}
                onTogglePick={state ? () => dispatch({ type: "toggle_tone_eq_pick", id: node.id }) : undefined}
              />
            </div>
          );
        }
        if (kind === "colorConsole") {
          return (
            <div key={kind} data-testid="section-widget-colorConsole" style={windowed ? undefined : { margin: "2px 0 6px" }}>
              <ColorConsoleBlock
                node={node}
                dispatch={dispatch}
                width={width}
                height={graphHeight}
                band={state ? state.consoleBand : localBand}
                onBand={state ? (id) => dispatch({ type: "set_console_band", id }) : setLocalBand}
                pickArmed={state?.consolePick === node.id}
                pickBand={state?.consolePickBand}
                onTogglePick={state ? (band) => dispatch({ type: "toggle_console_pick", id: node.id, band }) : undefined}
                customMax={state?.prefs.consoleCustomMax}
                nameFormat={state?.prefs.consoleNameFormat}
                onNameFormat={state ? (fmt) => dispatch({ type: "set_prefs", prefs: { consoleNameFormat: fmt } }) : undefined}
                // Single-letter slider labels at panel width; the window
                // has room for the full names.
                compact={!windowed}
                windowed={windowed}
              />
            </div>
          );
        }
        if (kind === "curveEditor") {
          if (panel && state?.toolPopouts.curves) return mark(<ToolPopBar tool="curves" label="Curves" dispatch={dispatch} />);
          return (
            <div key={kind} data-testid="section-widget-curveEditor" style={{ marginBottom: 8 }}>
              <CurveEditor
                node={node}
                dispatch={dispatch}
                width={width}
                height={graphHeight}
                channelMode={state ? curveModeOf(state) : "rgb"}
                clipboard={state?.curveClipboard ?? null}
                // The photograph's own histogram, as Develop has always
                // drawn it under the curve.
                histogramSrc={thumb ?? frame ?? undefined}
                // The eyedropper samples the photograph in the main
                // window's viewer; from a tool window arming it is a
                // command like any other.
                pickArmed={state?.curvePick?.nodeId === node.id}
                hoverX={state?.curvePick?.nodeId === node.id ? state.curveHoverX : null}
                onTogglePick={state ? (ch) => dispatch({ type: "arm_curve_pick", nodeId: node.id, channel: ch }) : undefined}
              />
            </div>
          );
        }
        if (kind === "colorWheels") {
          if (panel && state?.toolPopouts.wheels) return mark(<ToolPopBar tool="wheels" label="Color Wheels" dispatch={dispatch} />);
          // Same order and labels navSections uses, so the letter shown
          // is the letter that works.
          const wheels: [string, string][] = [
            ["Shadows", "shadows"],
            ["Mids", "midtones"],
            ["Highs", "highlights"],
          ];
          const hinting = panel && state?.keynav?.mode === "controls" && state.keynav.section === "Color Wheels";
          const hints = hinting ? assignHints(wheels.map(([n]) => n)) : [];
          return (
            <div
              key={kind}
              data-testid="section-widget-colorWheels"
              data-node={node.id}
              data-params={wheels.flatMap(([, r]) => ["hue", "sat", "lum"].map((c) => `${r}_${c}`)).join(" ")}
            >
              <div
                data-testid={panel ? "develop-wheels" : undefined}
                style={{ display: "flex", gap: discSize ? 24 : 8, paddingTop: 4, justifyContent: discSize ? "center" : undefined }}
              >
                {wheels.map(([label, range], i) => {
                  const wheel = (
                    <Wheel
                      key={range}
                      name={label}
                      range={range}
                      node={node}
                      dispatch={dispatch}
                      size={discSize}
                      hint={hinting ? hints[i] : undefined}
                      live={
                        panel &&
                        state?.keynav?.mode === "adjust" &&
                        state.keynav.target?.section === "Color Wheels" &&
                        state.keynav.target?.param === `${range}_hue`
                      }
                    />
                  );
                  // A window's wheel keeps the column it is sized to.
                  return discSize ? (
                    <div key={range} style={{ width: discSize, display: "flex" }}>
                      {wheel}
                    </div>
                  ) : (
                    wheel
                  );
                })}
              </div>
              <WheelsHelp />
            </div>
          );
        }
        if (kind === "bendWheel") {
          // Handed to its own window, the wheel folds to a bar in the
          // panel rather than vanishing; the bar is the way back.
          if (panel && state?.bendPoppedOut) return mark(<BendBar dispatch={dispatch} />);
          return (
            <div key={kind} data-testid="section-widget-bendWheel" data-node={node.id} data-params="src_hue src_sat dst_hue dst_sat">
              <BendWheel node={node} dispatch={dispatch} frame={frame} engine={engine} masked={isLayerNode(node.id)} />
            </div>
          );
        }
        if (kind === "levels") {
          return (
            <div key={kind} data-testid="section-widget-levels" style={{ margin: "2px 0 6px" }}>
              <LevelsEditor state={state ?? viewState} node={node} dispatch={dispatch} width={width} histogramSrc={shown ?? undefined} />
            </div>
          );
        }
        if (kind === "zones") return state ? mark(<ZonesBlock state={state} dispatch={dispatch} frame={frame} />) : null;
        if (kind === "detailAdvanced") {
          return (
            <div key={kind} data-testid="section-widget-detailAdvanced" data-node={node.id} data-params={DETAIL_WEIGHT_PARAMS}>
              <DetailAdvanced node={node} dispatch={dispatch} />
            </div>
          );
        }
        if (kind === "flipPhoto") {
          return state ? (
            <div key={kind} data-testid="section-widget-flipPhoto" data-node={node.id} data-params="flip_h flip_v turn">
              <FlipPhotoRow nodes={state.nodes} activeImage={state.activeImage} dispatch={dispatch} />
              <CropToPictureRow state={state} dispatch={dispatch} />
            </div>
          ) : null;
        }
        if (kind === "whiteBalance") return mark(<WhiteBalanceRow node={node} dispatch={dispatch} state={state} frame={frame} />);
        return mark(<PrintControls node={node} dispatch={dispatch} />);
      })}
    </>
  );
}

/** A section's whole face for one node: the section's widgets, its rows
 * that write to this node in order, each slider with the widgets its row
 * names, as Develop lays it out. Graph's inspector and the tool windows
 * draw a section's node through this. */
export function SectionFace({
  sec,
  node,
  dispatch,
  ...frame
}: FaceFrame & {
  sec: SectionSpec;
  node: NodeCard;
  dispatch: D;
}) {
  const { state, windowed } = frame;
  // The shared routing cell when the app's state is here (the viewer's
  // picker follows it); this face's own otherwise.
  const [localCell, setLocalCell] = useState<RecolorCellId>("hue_sat");
  const cell = state ? state.recolorCell : localCell;
  const onCell = state ? (c: RecolorCellId) => dispatch({ type: "set_recolor_cell", cell: c }) : setLocalCell;
  // Rows a widget seats in its own window layout.
  const seated = windowed ? sectionWidgetKinds(sec).flatMap((k) => WINDOWED_ROWS[k] ?? []) : [];
  // This node's rows: a row that writes to another node (Detail's Unsharp
  // on the sharpen node) is that node's to show.
  const rows = sec.rows.filter(
    (r) =>
      (!r.when || !state || r.when(state)) &&
      (!r.node || (!!state && r.node(state)?.id === node.id)) &&
      !seated.includes(r.param),
  );
  const widgets = (seats: SectionWidgetSeats | undefined, at: "before" | "after") => {
    const kinds = seats?.[at];
    return kinds && kinds.length ? <SectionWidgets kinds={kinds} node={node} dispatch={dispatch} {...frame} cell={cell} onCell={onCell} /> : null;
  };
  return (
    <div data-testid={`section-face-${sec.title.toLowerCase().replace(/[^a-z]+/g, "-")}`}>
      {widgets(sec.widgets, "before")}
      {rows.map((r) => (
        <React.Fragment key={r.label}>
          {widgets(r.widgets, "before")}
          {r.heading && <RowHeading heading={r.heading} />}
          <Slider label={r.label} param={r.param} node={node} dispatch={dispatch} centered={r.centered ?? true} range={r.range} />
          {widgets(r.widgets, "after")}
        </React.Fragment>
      ))}
      {widgets(sec.widgets, "after")}
    </div>
  );
}
