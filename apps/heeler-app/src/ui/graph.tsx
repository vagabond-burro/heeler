import { isLayerAdj, layerAdjOfNode } from "../layerids";
import { FxSettings } from "./artlayers";
import { FinishAdjustmentControls } from "./finishadjustments";
import { isPrimaryPress } from "./pointerguard";
import { modLabel } from "../platform";
import { SharpeningRecipeControl } from "./simple";
import { SmartMaskFace, smartCardNote, useSmartModels } from "./smartnode";
import { PROFILE_CHOICES, SOURCE_MENU_ROWS, SourceMenuRow } from "./sourcemenus";
import { GuardStrip } from "./guardstrip";
import { FEATHER_FOLLOWS_LABEL, FeatherFollowsToggle } from "./featherfollows";
import { KeyLightControls } from "./keylightgizmo";
import { ObjectMattePanel } from "./mattetool";
import { NormalsChoice } from "./depthtool";
import { useDialogFocus } from "./dialogfocus";
// Node editor (Advanced mode), Inspector, and the Save-as-group dialog.
// Node anatomy, wire styling, and the group flow follow frames 5a / 7a /
// 7b / 7c of the design. The fixed pipeline lanes were replaced by
// user-created backdrops (the product decision: layout belongs to the
// artist).

import React, { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { panePropsEqual } from "./viewmemo";
import { SpectrumBar, Spectrums } from "./spectrum";
import type { Backdrop, Category, Command, NodeCard, State, Wire } from "../state";
import { FlipPhotoRow } from "./flipphoto";
import { artMaskView, BACKDROP_COLORS, CAT_COLOR, NODE_H, NODE_W, createsCycle, duplicable, nameMatches, PARAM_OPTIONS, REGISTRY_DEFAULTS, hasParamRange, TYPE_NUM_PARAMS, PARAM_TEXT_DEFAULT, paramRange, publishedValue, publishedChoice, FLAG_PARAMS, ART_KINDS, isLayerEffect, artLayers, warpNodeById, isPlacedLayer, wireLacksPort, curveModeOf, LAYER_WARP, WIRE_GESTURE, exportWrittenName, exportWritesDepth, DEPTH_EXPORT_CONVENTION, seatTakes, PARAM_CHOICE_HINTS, maskIsOff, MASK_OFF_GESTURE } from "../state";
import { GridWarpControls } from "./gridwarp";
import { ShapeWarpControls } from "./shapewarp";
import { FinishWarpControls } from "./finishwarp";
import { ColorCheckerControls } from "./colorchecker";
import { LinesRow, LineWidthRow } from "./linecolor";
import { MASK_IN_TYPES, PORT_ROLES, THREE_FIELD_INPUTS, fieldSpliceSeats, portHint, portName } from "../nodes";
import { ViewShapeIcon } from "./ribbontable";
import { nodeKindLabel, nodeKindLocation } from "../nodekind";
import { ResetIcon } from "./panelicons";
import { bakeLut, catalogFolderImages, catalogImages, fileThumb, listSubfolders, loadThumbnail, lutInfo, nodeThumbFilter, nodeThumbs, pickImageFile, pickLutFile, type CatalogPhoto } from "../bridge";
import { logMsg } from "../log";
import { EqEditor } from "./eqeditor";
import { SectionLooks } from "./sectionlooks";
import { FilmBlock } from "./film";
import { BwControls } from "./bwcontrols";
import { PrintControls } from "./print";
import { GrainFilmRow, GrainFrameRow } from "./grainfilm";
import { RecolorBlock } from "./recolor";
import { ViewTransformFace } from "./viewface";
import { ColorConsoleBlock } from "./colorconsole";
import { ExportTick, LayerMaskExportRow, MASK_EXPORT_LABEL, MaskExportTick } from "./exporttick";
import { TransformFields, UnbakeButton, unbakeCarrierOf } from "./imagelayers";
import type { RecolorCellId } from "../eqcurve";


/** The inspector's Console face: band selection local to the panel. */
function ConsoleInspector({ node, dispatch, width, appState }: { node: NodeCard; dispatch: D; width: number; appState?: State }) {
  // With app state, the band is the SHARED one so the viewer's picker
  // and every other face of this tool agree; the local fallback keeps
  // stateless renders (the popped-out graph window, tests) working.
  const [localBand, setLocalBand] = useState("r");
  const band = appState ? appState.consoleBand : localBand;
  return (
    <>
      {/* compact, same as the Adjustments panel: single-letter slider labels
at panel width; only the pop-out gets full names. Smoothing above
the widget, Develop's order.*/}
      <Slider label="Smoothing" param="smoothing" node={node} dispatch={dispatch} centered={false} />
      <ColorConsoleBlock
        node={node}
        dispatch={dispatch}
        width={width}
        band={band}
        onBand={appState ? (id) => dispatch({ type: "set_console_band", id }) : setLocalBand}
        pickArmed={appState?.consolePick === node.id}
        pickBand={appState?.consolePickBand}
        onTogglePick={
          appState ? (band) => dispatch({ type: "toggle_console_pick", id: node.id, band }) : undefined
        }
        customMax={appState?.prefs.consoleCustomMax}
        nameFormat={appState?.prefs.consoleNameFormat}
        onNameFormat={
          appState
            ? (fmt) => dispatch({ type: "set_prefs", prefs: { consoleNameFormat: fmt } })
            : undefined
        }
        compact
      />
    </>
  );
}

/** The inspector's Recolor face: same grid and widget, cell selection
 * local to this panel (the viewer's picker follows the Develop
 * panel's cell, which is the shared one). */
function RecolorInspector({
  node,
  dispatch,
  width,
  appState,
  histogramSrc,
}: {
  node: NodeCard;
  dispatch: D;
  width: number;
  appState?: State;
  histogramSrc?: string;
}) {
  // The shared cell when app state is here (so the viewer picker's
  // choice of cell shows in this widget); local otherwise.
  const [localCell, setLocalCell] = useState<RecolorCellId>("hue_sat");
  const cell = appState ? appState.recolorCell : localCell;
  return (
    <>
      {/* Sliders above the widget, Develop's order. */}
      <Slider label="Neutral guard" param="neutral_guard" node={node} dispatch={dispatch} centered={false} />
      {appState && <GuardStrip state={appState} node={node} cell={cell} dispatch={dispatch} />}
      <Slider label="Smoothing" param="smoothing" node={node} dispatch={dispatch} centered={false} />
      <RecolorBlock
        node={node}
        allNodes={appState?.nodes ?? []}
        clipboard={appState?.recolorClipboard ?? null}
        dispatch={dispatch}
        width={width}
        height={160}
        cell={cell}
        onCell={appState ? (c) => dispatch({ type: "set_recolor_cell", cell: c }) : setLocalCell}
        histogramSrc={histogramSrc}
        pickArmed={appState?.recolorPick === node.id}
        hoverX={appState?.recolorPick === node.id ? appState.recolorHoverX : null}
        onTogglePick={
          appState ? () => dispatch({ type: "toggle_recolor_pick", id: node.id }) : undefined
        }
        matchArmed={appState?.recolorMatch?.id === node.id}
        onToggleMatch={
          appState ? () => dispatch({ type: "toggle_recolor_match", id: node.id }) : undefined
        }
        depthView={appState?.depthView}
        depthRed={appState?.maskRed}
        onToggleDepthView={appState ? (flavor) => dispatch({ type: "toggle_depth_view", flavor }) : undefined}
      />
      {cell.startsWith("around_") && (
        <Slider label="Around reach" param="around_radius" node={node} dispatch={dispatch} centered={false} />
      )}
    </>
  );
}
import { GroupGlyph } from "./chrome";
import { addNodeAt, addRecipeAt } from "./addnode";
import { savableAsRecipe } from "../noderecipes";
import { refreshRecipeFiles } from "../recipefiles";
import { paletteRecipes } from "./nodepalette";
import { menuTree } from "../nodes";
import { colorSetOf } from "../colorsets";
import { DETAIL_WEIGHT_PARAMS, DepthMaskBlock, DetailAdvanced, LayerOpacitySlider, MASK_ROWS, MaskInvertRow, RadialShapePicker, RangeHistogram, RangeMaskTools, SECTIONS, SectionExportTick, Slider, nodeResetValues, sectionExportTap } from "./simple";
import { LevelsEditor } from "./levels";
import { LuminanceMaskControls } from "./lummask";
import { BendWheel } from "./bend";
import { CurveEditor, Wheel } from "./editors";
import { GradientNodeControls } from "./gradientstops";
import { pxBox, useDismiss, useSpacePan, useViewportNav } from "./hooks";
import { useClearsSibling } from "./layoutroom";
import { clampMenu, viewportSize } from "./menupos";
import { MenuSurface } from "./menusurface";
import { ColorSetControls, HueBandStrip, ColorSetTools } from "./colorsets";
import { ControlsEditor, PUBLISH_HINT, PublishMenu, publishRowAt } from "./publishcontrols";
import { MenuField } from "./menufield";

type D = React.Dispatch<Command>;

/** A pipe in hand: one end hangs off a port, the other follows the
 * pointer at (x, y). `from` set: it hangs off that output and looks for
 * an input. `to` set: it hangs off that input and looks for an output.
 * `hover` is the card the drop would land on now. */
type WireDrag = {
  kind: "mask" | "image";
  x: number;
  y: number;
  hover: string | null;
  from?: string;
  fromPort?: Wire["fromPort"];
  to?: string;
  toPort?: Wire["toPort"];
  lifted?: Wire;
  /** With `from` set: the input of `hover` the drop would land on. */
  hoverSeat?: InSeat | null;
};

/** The pipe in hand's pointer end, kept outside React state: a pointer
 * move writes it here and only the ghost redraws. With the position in
 * the editor's state every move re-rendered every card (253 cards
 * measured 12 ms a move in jsdom after the cycle rule was memoized, all
 * of it reconciliation), when nothing on a card changes until the
 * hover does (the perf review's second stage, 2026-10-01). */
const ghost = { x: 0, y: 0, subs: new Set<() => void>() };
function setGhost(x: number, y: number): void {
  ghost.x = x;
  ghost.y = y;
  ghost.subs.forEach((f) => f());
}
const subscribeGhost = (f: () => void) => {
  ghost.subs.add(f);
  return () => {
    ghost.subs.delete(f);
  };
};

/** The pipe in hand, drawn from the port it hangs off (the one the hand
 * grabbed or the lifted pipe's source) to the pointer. A pipe hanging
 * off an input leaves it the way a wire arrives there: leftward from a
 * stacked input, downward from a bottom-edge diamond. */
function WireGhost({ drag, nodes }: { drag: WireDrag; nodes: NodeCard[] }) {
  const x = React.useSyncExternalStore(subscribeGhost, () => ghost.x);
  const y = React.useSyncExternalStore(subscribeGhost, () => ghost.y);
  let d: string;
  if (drag.to !== undefined) {
    const to = nodes.find((k) => k.id === drag.to);
    if (!to || !drag.toPort) return null;
    const { x: x1, y: y1 } = portCenter(to, drag.toPort);
    const bottom = BOTTOM_SEATS.has(drag.toPort);
    d = `M ${x1} ${y1} C ${bottom ? x1 - 6 : x1 - 24} ${bottom ? y1 + 24 : y1}, ${x + 24} ${y}, ${x} ${y}`;
  } else {
    const from = nodes.find((k) => k.id === drag.from);
    if (!from) return null;
    const { x: x1, y: y1 } = drag.fromPort === "depth"
      ? portCenter(from, "depthOut")
      : drag.fromPort === "mask"
        ? portCenter(from, "fileMask")
        : drag.kind === "mask" && from.maskOut
          ? portCenter(from, "maskOut")
          : portCenter(from, "out");
    d = `M ${x1} ${y1} C ${x1 + 24} ${y1}, ${x - 24} ${y}, ${x} ${y}`;
  }
  return (
    <path
      data-testid="wire-drag-ghost"
      data-hangs-off={drag.to !== undefined ? `${drag.to}.${drag.toPort}` : `${drag.from}.${drag.fromPort ?? "out"}`}
      d={d}
      stroke={drag.kind === "mask" ? "#8b6fc4" : "var(--accent)"}
      strokeWidth={1.6}
      strokeDasharray="5 4"
      fill="none"
    />
  );
}

/** The output a pipe of `kind` leaves `n` from when the hand chooses the
 * source (a drag that starts on an input), or null when the card has no
 * output of that kind. Image pipes leave the image out (the Export
 * Layer's names its pass-through, 26.3 Phase 8); mask pipes leave the
 * card's field output: a masking node's diamond, Depth Map's depth
 * diamond (Phase 4), a File card's or Export Layer's page alpha (Phases
 * 6 and 8). The same table an output-first drag reads off the port it
 * starts on, so both ends of the gesture write the same wire. */
export function sourceSeat(
  kind: "mask" | "image",
  n: NodeCard,
): { seat: "out" | "maskOut" | "depthOut" | "fileMask"; fromPort?: Wire["fromPort"] } | null {
  if (!n.hasOut || (n.isGroup && !wirableGroup(n))) return null;
  if (kind === "mask") {
    if (n.maskOut) return { seat: "maskOut" };
    if (n.depthOut) return { seat: "depthOut", fromPort: "depth" };
    if (n.fileMaskOut) return { seat: "fileMask", fromPort: "mask" };
    return null;
  }
  if (n.maskOut) return null;
  return n.type === "heeler.export_layer" ? { seat: "out", fromPort: "image" } : { seat: "out" };
}

/** A group a pipe may land on and leave from by hand: a node recipe's
 * (2026-09-30: "a group a user drops into their node graph"), whose
 * inputs and output are declared on its boundary, so a pipe on its in,
 * in2 or depth port has one member to go to. A group made from a
 * selection keeps the wiring it was made with, as before.*/
export function wirableGroup(n: NodeCard): boolean {
  return !!n.isGroup && !!n.recipe;
}

/** An input a card draws, by the name the wire carries. */
export type InSeat = "in" | "in2" | "in3" | "mask" | "alpha" | "depth";

/** The inputs card `n` draws, top to bottom then left to right. */
export function drawnSeats(n: NodeCard): InSeat[] {
  return [
    ...(n.hasIn ? (["in"] as const) : []),
    ...(n.hasIn2 ? (["in2"] as const) : []),
    ...(n.hasIn3 ? (["in3"] as const) : []),
    ...(n.maskIn ? (["mask"] as const) : []),
    ...(n.alphaIn ? (["alpha"] as const) : []),
    ...(n.depthIn ? (["depth"] as const) : []),
  ];
}

/** Whether a pipe of `kind` may run from card `src` into input `seat`
 * of card `dst`. The ONE rule the hand reads from both ends: a pipe
 * drawn out of an output lights every input this passes, a pipe drawn
 * out of an input lights every output it passes, and either drop makes
 * the connect the reducer then accepts (seatTakes is its type rule).
 * (2026-10-01): "when dragging a wire from the IN attribute the OUT
 * attributes that are compatible highlight, but not when I drag from
 * an OUT the IN attributes/connections do not".
 *
 * The source needs an output of the pipe's kind (sourceSeat); the
 * Image Source takes nothing; a selection's group is not the hand's to
 * rewire, and a recipe's group takes pictures on its inputs and a field
 * on its depth diamond alone; no self, no loop (`lifted`, the pipe in
 * hand, is left out of the loop check since it is going). */
export function pipeFits(
  wires: Wire[],
  src: NodeCard,
  kind: "mask" | "image",
  dst: NodeCard,
  seat: Wire["toPort"],
  lifted?: Wire,
  cycle?: (from: string, to: string) => boolean,
): boolean {
  if (src.id === dst.id || dst.id === "src" || !sourceSeat(kind, src)) return false;
  if (dst.isGroup) {
    if (!wirableGroup(dst)) return false;
    if (kind === "mask" ? seat !== "depth" : seat !== "in" && seat !== "in2" && seat !== "in3") return false;
  }
  if (!seatTakes(dst, seat, kind === "mask")) return false;
  // `cycle` is a drag's precomputed answer (dragCycleCheck): the fixed
  // end's reachability solved once, instead of one walk of the graph per
  // port per card per pointer move.
  if (cycle) return !cycle(src.id, dst.id);
  return !createsCycle(lifted ? wires.filter((w) => w !== lifted) : wires, src.id, dst.id);
}

/** The cycle half of pipeFits for the pipe in hand, solved once per
 * gesture. Adding src -> dst closes a loop exactly when dst already
 * reaches src, and one end of the pipe is fixed for the gesture's
 * length: drawn out of output `from`, the walk is who reaches `from`
 * (once), and a card fits when it is not in that set; drawn out of
 * input `to`, the walk is whom `to` reaches, and a source fits when it
 * is not in that set. A pointer move then answers in O(1) a question
 * that cost one graph walk per port of every card. */
export function dragCycleCheck(
  wires: Wire[],
  drag: { from?: string; to?: string; lifted?: Wire },
): ((from: string, to: string) => boolean) | undefined {
  const ws = drag.lifted ? wires.filter((w) => w !== drag.lifted) : wires;
  if (drag.from !== undefined) {
    const fixed = drag.from;
    // Every node that can reach the fixed source, itself included (a
    // self loop is a cycle), walking the pipes backward.
    const reaches = new Set<string>([fixed]);
    const stack = [fixed];
    while (stack.length) {
      const cur = stack.pop()!;
      for (const w of ws) {
        if (w.to === cur && !reaches.has(w.from)) {
          reaches.add(w.from);
          stack.push(w.from);
        }
      }
    }
    return (_from, to) => reaches.has(to);
  }
  if (drag.to !== undefined) {
    const fixed = drag.to;
    // Every node the fixed input's card can reach, itself included,
    // walking the pipes forward.
    const reached = new Set<string>([fixed]);
    const stack = [fixed];
    while (stack.length) {
      const cur = stack.pop()!;
      for (const w of ws) {
        if (w.from === cur && !reached.has(w.to)) {
          reached.add(w.to);
          stack.push(w.to);
        }
      }
    }
    return (from, _to) => reached.has(from);
  }
  return undefined;
}

/** Which of `seats` (the fitting inputs of `target`) a drop at `q`
 * lands on, or null when there are none. A drop on or beside an input
 * (within 14 graph px of its center) takes that input. Elsewhere on the
 * card: a picture pipe the nearest stacked input by height (inputAt); a
 * field pipe the operand by height on the logic family, the alpha
 * diamond on Output and Alpha Association, the nearer diamond on the
 * Export Layer and the Displacement Map, the mask diamond elsewhere;
 * and when that input does not fit, the nearest one that does. */
export function dropSeat(target: NodeCard, kind: "mask" | "image", q: { x: number; y: number }, seats: InSeat[]): InSeat | null {
  if (seats.length === 0) return null;
  const dist = (seat: InSeat) => {
    const p = portCenter(target, seat);
    return Math.hypot(q.x - p.x, q.y - p.y);
  };
  const nearest = [...seats].sort((a, b) => dist(a) - dist(b))[0];
  if (dist(nearest) <= 14) return nearest;
  const stacked = seats.filter((s): s is "in" | "in2" | "in3" => s === "in" || s === "in2" || s === "in3");
  const byHeight = (): InSeat | null => {
    if (stacked.length === 0) return null;
    const at = inputAt(target, q.y);
    return stacked.includes(at) ? at : null;
  };
  const preferred: InSeat | null =
    kind === "image" || MASK_IN_TYPES.has(target.type)
      ? byHeight()
      : target.type === "heeler.output" || target.type === "heeler.alpha_association"
        ? "alpha"
        : target.type === "heeler.export_layer" || target.type === "heeler.displacement_map"
          ? Math.abs(q.x - portCenter(target, "alpha").x) < Math.abs(q.x - portCenter(target, "mask").x)
            ? "alpha"
            : "mask"
          : "mask";
  return preferred && seats.includes(preferred) ? preferred : nearest;
}

/** The engine-side name a hand-drawn pipe writes for input `seat`.
 * invert_mask draws its one input as "in" but has always been wired on
 * "mask" by a drop on the card (its registry port's name; recipes write
 * it too), so a drop keeps writing that. */
export function landingPort(target: NodeCard, seat: InSeat): Wire["toPort"] {
  return target.type === "heeler.invert_mask" && seat === "in" ? "mask" : seat;
}

/** Whether two port names are the same input of `target` (invert_mask's
 * one input goes by both "in" and "mask"). */
export function sameInput(target: Pick<NodeCard, "type">, a: Wire["toPort"], b: Wire["toPort"]): boolean {
  if (a === b) return true;
  return target.type === "heeler.invert_mask" && (a === "in" || a === "mask") && (b === "in" || b === "mask");
}

/** The inputs of `dst` a pipe of `kind` out of `src` may land on. */
export function seatsFor(wires: Wire[], src: NodeCard, kind: "mask" | "image", dst: NodeCard, lifted?: Wire, cycle?: (from: string, to: string) => boolean): InSeat[] {
  return drawnSeats(dst).filter((seat) => pipeFits(wires, src, kind, dst, seat, lifted, cycle));
}

/** The input seats that sit on a card's bottom edge: a pipe arrives at
 * them from underneath. */
const BOTTOM_SEATS = new Set<Wire["toPort"]>(["mask", "clip", "alpha", "depth"]);

/** An output port lit as a source for the pipe in hand. */
const LIT_PORT: React.CSSProperties = { boxShadow: "0 0 0 2px var(--accent)" };
/** The lit input the drop would land on now. */
const AIMED_PORT: React.CSSProperties = { boxShadow: "0 0 0 3px var(--accent)", background: "var(--accent)" };

/** Node accents: saturated enough to read at card size, few enough to
 * stay a vocabulary. */
const TINTS = ["#c6a04a", "#4a8ac6", "#5aa564", "#b0596d", "#8b6fc4", "#c07a3f"];

/** A backdrop region: header drags it (nodes inside ride along), the
 * corner handle resizes, the label renames on double-click, the dot
 * cycles colors. The body is click-through so marquee and node
 * interaction beneath keep working. */
function BackdropBox({
  backdrop: b,
  dispatch,
  surface,
  zoom,
}: {
  backdrop: Backdrop;
  dispatch: D;
  surface: React.RefObject<HTMLDivElement | null>;
  /** viewport zoom, so screen-pixel drags map to graph units */
  zoom: number;
}) {
  const [editing, setEditing] = useState<string | null>(null);

  const dragFrom = (e: React.MouseEvent, apply: (dx: number, dy: number) => void, key: string) => {
    if (!isPrimaryPress(e)) return;
    e.stopPropagation();
    e.preventDefault();
    dispatch({ type: "begin_gesture", key });
    let last = { x: e.clientX, y: e.clientY };
    const move = (ev: MouseEvent) => {
      if (!surface.current) return;
      apply((ev.clientX - last.x) / zoom, (ev.clientY - last.y) / zoom);
      last = { x: ev.clientX, y: ev.clientY };
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      dispatch({ type: "end_gesture" });
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  return (
    <div
      data-testid={`backdrop-${b.id}`}
      style={{
        position: "absolute", left: b.x, top: b.y, width: b.w, height: b.h,
        background: BACKDROP_COLORS[b.color % BACKDROP_COLORS.length],
        border: "1px solid #2e3235", pointerEvents: "none",
      }}
    >
      <div
        data-testid={`backdrop-head-${b.id}`}
        onMouseDown={(e) => dragFrom(e, (dx, dy) => dispatch({ type: "move_backdrop", id: b.id, dx, dy }), `${b.id}.bdmove`)}
        style={{
          pointerEvents: "auto", cursor: "move", display: "flex", alignItems: "center", gap: 6,
          padding: "3px 7px", background: "rgba(0,0,0,.25)", borderBottom: "1px solid #2e3235",
        }}
      >
        {editing !== null ? (
          <input
            autoFocus
            value={editing}
            data-testid={`backdrop-rename-${b.id}`}
            onChange={(e) => setEditing(e.target.value)}
            onMouseDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                dispatch({ type: "rename_backdrop", id: b.id, name: editing });
                setEditing(null);
              }
              if (e.key === "Escape") setEditing(null);
            }}
            style={{ background: "var(--bg-app)", border: "1px solid var(--line-4)", color: "var(--text-body)", fontSize: 10, padding: "1px 4px", outline: "none", width: 120 }}
          />
        ) : (
          <span
            onDoubleClick={() => setEditing(b.name)}
            style={{ fontSize: 9, letterSpacing: ".18em", color: "var(--text-dim)", textTransform: "uppercase", flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
          >
            {b.name}
          </span>
        )}
        <button
          style={{ all: "unset", cursor: "pointer", width: 10, height: 10, borderRadius: "50%", border: "1px solid #575c62", background: BACKDROP_COLORS[(b.color + 1) % BACKDROP_COLORS.length] }}
          data-testid={`backdrop-color-${b.id}`}
          aria-label="Cycle backdrop color"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => dispatch({ type: "cycle_backdrop_color", id: b.id })}
        />
        <button
          style={{ all: "unset", cursor: "pointer", color: "var(--text-ghost)", fontSize: 10, lineHeight: 1 }}
          data-testid={`backdrop-delete-${b.id}`}
          aria-label="Delete backdrop"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => dispatch({ type: "delete_backdrop", id: b.id })}
        >
          ✕
        </button>
      </div>
      <div
        data-testid={`backdrop-resize-${b.id}`}
        onMouseDown={(e) => {
          // Accumulate in the closure: `b` is frozen at drag start.
          let tw = b.w;
          let th = b.h;
          dragFrom(
            e,
            (dx, dy) => {
              tw += dx;
              th += dy;
              dispatch({ type: "resize_backdrop", id: b.id, w: tw, h: th });
            },
            `${b.id}.bdsize`
          );
        }}
        style={{
          pointerEvents: "auto", position: "absolute", right: -2, bottom: -2, width: 12, height: 12,
          cursor: "nwse-resize", borderRight: "2px solid #575c62", borderBottom: "2px solid #575c62",
        }}
      />
    </div>
  );
}

/** Where an input sits down the card's left edge. Two inputs stack
 * around the middle; three (Channel Join's r, g, b) spread the height. */
export function inputY(card: { hasIn2?: boolean; hasIn3?: boolean }, port: "in" | "in2" | "in3"): number {
  if (card.hasIn3) return port === "in" ? 20 : port === "in2" ? 36 : 52;
  if (card.hasIn2) return port === "in2" ? 48 : 26;
  return 35;
}

/** The center of a port, in canvas space: where a wire's end belongs.
 *
 * A port is a 7px square (8px for the diamonds) placed by its top-left
 * inside a card that has a 1px border, so its center sits 4.5px in
 * from the coordinate its style names. The wires used to end on that
 * coordinate and so sat a hair above and outside every dot (The
 * report: "the lines between the inputs and outputs aren't exactly
 * aligned with the points, they are slightly offset in +Y"). One
 * function for the wire, the hit-test, the drag ghost and the head
 * handle, so they cannot disagree again.*/
export function portCenter(
  card: NodeCard,
  seat: "in" | "in2" | "in3" | "out" | "maskOut" | "mask" | "clip" | "depthOut" | "depth" | "fileMask" | "alpha",
): { x: number; y: number } {
  switch (seat) {
    case "in":
    case "in2":
    case "in3":
      // left: -4 inside the border, 7px wide.
      return { x: card.x + 0.5, y: card.y + inputY(card, seat) + 4.5 };
    case "out":
      // right: -4, top: 35 - or top: 24 when a depth diamond sits
      // below it (Depth Map, 26.3 Phase 4).
      return { x: card.x + NODE_W - 0.5, y: card.y + (card.depthOut ? 24 : 35) + 4.5 };
    case "maskOut":
      // right: -5, top: 34, 8px diamond.
      return { x: card.x + NODE_W, y: card.y + 34 + 5 };
    case "depthOut":
      // right: -5, top: 47, 8px diamond, under the image out.
      return { x: card.x + NODE_W, y: card.y + 47 + 5 };
    case "fileMask":
      // The File card's second output (26.3 Phase 6): where Depth
      // Map's second diamond sits, a seat one card family each.
      return { x: card.x + NODE_W, y: card.y + 47 + 5 };
    case "alpha":
      // Output's transparency input (26.3 Phase 5): where a mask
      // diamond would sit, on the one card without a mask input. The
      // Export Layer has both (Phase 8), so its alpha diamond sits one
      // seat over, where a clip diamond would sit.
      return { x: card.x + (card.maskIn ? 30 : 9), y: card.y + NODE_H - 1 };
    case "depth":
      // A depth consumer's plane input (26.3 Phase 10.3): beside the
      // mask diamond on the picture tools, in the mask diamond's place
      // on the masks, which have none. No card carries both a depth and
      // an alpha input, so the seat cannot collide.
      return { x: card.x + (card.maskIn ? 30 : 9), y: card.y + NODE_H - 1 };
    case "mask":
      // left: 4, bottom: -4, 8px diamond.
      return { x: card.x + 9, y: card.y + NODE_H - 1 };
    case "clip":
      return { x: card.x + 30, y: card.y + NODE_H - 1 };
  }
}

/** What color an input port wears. Channel Join's three say which
 * plane they are ("The inputs of Channel Join should
 * match the color channel they represent"); everywhere else the
 * primary is the neutral gray and a second input the accent.*/
export function inputColor(card: { type: string }, seat: "in" | "in2" | "in3"): string {
  if (THREE_FIELD_INPUTS.has(card.type)) {
    return seat === "in" ? CHANNEL_PORT.r : seat === "in2" ? CHANNEL_PORT.g : CHANNEL_PORT.b;
  }
  return seat === "in" ? "#6b7178" : "var(--accent)";
}
export const CHANNEL_PORT = { r: "#d9534f", g: "#5cb85c", b: "#4a90e2" } as const;

/** Where a wire leaves a card: its field output when it has one - and
 * the second diamond when the wire names a planted port (Depth Map's
 * farness plane, a File card's page alpha; 26.3 Phases 4 and 6). */
function outCenter(card: NodeCard, fromPort?: Wire["fromPort"]): { x: number; y: number } {
  if (fromPort === "depth") return portCenter(card, "depthOut");
  if (fromPort === "mask") return portCenter(card, "fileMask");
  return portCenter(card, card.maskOut ? "maskOut" : "out");
}

/** Which stacked input a drop at height `y` on `card` means: the card's
 * height split evenly between however many inputs it has. */
export function inputAt(card: NodeCard, y: number): "in" | "in2" | "in3" {
  // The nearest port's center, so a drop on any pixel of a port lands on
  // that port (thirds of the card height cut into the outer ports).
  const seats: ("in" | "in2" | "in3")[] = card.hasIn3 ? ["in", "in2", "in3"] : card.hasIn2 ? ["in", "in2"] : ["in"];
  let best: "in" | "in2" | "in3" = "in";
  let bestD = Infinity;
  for (const seat of seats) {
    const d = Math.abs(y - (card.y + inputY(card, seat) + 4.5));
    if (d < bestD) {
      bestD = d;
      best = seat;
    }
  }
  return best;
}

function wirePath(from: NodeCard, to: NodeCard, toPort: Wire["toPort"], fromPort?: Wire["fromPort"]): string {
  const { x: x1, y: y1 } = outCenter(from, fromPort);
  // A stencil arrives from underneath like a mask does, just further
  // along the bottom edge so the two are told apart when a layer has
  // both. Output's alpha arrives the same way: it IS a mask pipe. A
  // depth pipe too: it lands on the bottom edge beside the mask.
  if (toPort === "mask" || toPort === "clip" || toPort === "alpha" || toPort === "depth") {
    const { x: x2, y: y2 } = portCenter(to, toPort);
    return `M ${x1} ${y1} C ${x1 + 18} ${y1}, ${x2 - 6} ${y2 + 10}, ${x2} ${y2}`;
  }
  const { x: x2, y: y2 } = portCenter(to, toPort);
  return `M ${x1} ${y1} C ${x1 + 13} ${y1}, ${x2 - 13} ${y2}, ${x2} ${y2}`;
}

/** Node ids whose OUTPUT is display-shaped: everything at or below an
 * enabled Tone Profile or View Transform on the image path (proposal
 * §5's edge badges). The engine's contract keeps every wire
 * scene-linear in ENCODING, but past the display transform the values
 * are shaped for the screen, and an edit that assumes photographic
 * light (white balance, exposure math) is quietly wrong there. The
 * badge is that warning, on the wire where it belongs. Disabled
 * shapers shape nothing; disabled nodes downstream still pass a
 * shaped signal through. */
export function displayShapedIds(
  nodes: { id: string; type: string; enabled: boolean }[],
  wires: Wire[],
): Set<string> {
  const shaped = new Set<string>(
    nodes
      .filter(
        (n) =>
          n.enabled &&
          (n.type === "heeler.tone_profile" || n.type === "heeler.view_transform"),
      )
      .map((n) => n.id),
  );
  // Fixpoint over the image pipes: cheap at graph scale, and immune to
  // the wire array's order.
  let grew = true;
  while (grew) {
    grew = false;
    for (const w of wires) {
      if (w.kind === "mask") continue;
      if (shaped.has(w.from) && !shaped.has(w.to)) {
        shaped.add(w.to);
        grew = true;
      }
    }
  }
  return shaped;
}

function wireColor(w: Wire, selected: Set<string>): { stroke: string; dash?: string; width: number } {
  if (w.kind === "mask") {
    return { stroke: "#8b6fc4", dash: "5 4", width: 1.3 };
  }
  if (w.kind === "group") return { stroke: "var(--cat-group)", width: 1.6 };
  if (selected.has(w.from) || selected.has(w.to)) return { stroke: "var(--accent)", width: 1.8 };
  return { stroke: "#44474a", width: 1.6 };
}

const PALETTE: { cat: keyof typeof CAT_COLOR; label: string }[] = [
  { cat: "color", label: "Color" },
  { cat: "detail", label: "Detail" },
  { cat: "masking", label: "Masking" },
  { cat: "utility", label: "Utility" },
  { cat: "group", label: "Groups" },
];

/** A nested list beside a context-menu entry. The graph's own, because
 * this one nests three deep (Add, a category, a section) and opens
 * leftward when there is no room to the right, which a menu bar never
 * has to do. Pinned to the window (MenuSurface's `fixed`), like the
 * context menu it hangs from, so the graph's small pane never clips
 * it and every list, flyouts included, can scroll when the window is
 * too short for it (2026-10-01).*/
function GraphSubMenu({
  label,
  testid,
  children,
}: {
  label: string;
  testid: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div
      style={{ position: "relative" }}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onKeyDown={e => {
        if (e.key === "ArrowRight" && e.target === e.currentTarget.firstElementChild) {
          e.preventDefault(); e.stopPropagation(); setOpen(true);
        } else if (open && (e.key === "ArrowLeft" || e.key === "Escape")) {
          e.preventDefault(); e.stopPropagation(); setOpen(false);
        }
      }}
    >
      <button
        data-testid={testid}
        aria-haspopup="menu" aria-expanded={open}
        data-active={open}
        onClick={() => setOpen(!open)}
        style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%" }}
      >
        {label}
        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
          <path d="M9 6l6 6-6 6" />
        </svg>
      </button>
      {open && (
        <MenuSurface submenu aria-label={label}
          className="ctx-menu chrome-scale"
          data-testid={`${testid}-list`}
          // A list of flyouts may scroll too: the flyouts are pinned to the
          // window, so the list's overflow cannot cut them away (the owner,
          // once: "select one of the sub menus nothing shows").
          fixed
          style={{ position: "fixed", left: 0, top: 0 }}
        >
          {children}
        </MenuSurface>
      )}
    </div>
  );
}

/** Whether two versions of a card differ at most in where they sit. */
function samePlaceless(a: NodeCard, b: NodeCard): boolean {
  const ka = Object.keys(a) as (keyof NodeCard)[];
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) {
    if (k === "x" || k === "y") continue;
    if (a[k] !== b[k]) return false;
  }
  return true;
}

/** How many times a graph card has rendered: the test seam for the card
 * drag (a move renders the card in hand, not the other cards). */
export const cardRenders = { n: 0 };

/** What a card or a wire can ask of the editor. One object for the
 * editor's whole life (each call goes through a ref to the latest
 * render's handler), so a card's props stay equal while another card is
 * dragged. */
type CardActs = {
  nodeDown: (e: React.MouseEvent, n: NodeCard) => void;
  inputDown: (e: React.MouseEvent, n: NodeCard, toPort: Wire["toPort"], kind: "mask" | "image") => void;
  wireDown: (e: React.MouseEvent, from: string, kind: "mask" | "image", pickedUp: Wire | null, fromPort?: Wire["fromPort"]) => void;
  openGroup: (id: string) => void;
  wireEnter: (w: Wire) => void;
  wireLeave: () => void;
  wireHitDown: (e: React.MouseEvent, w: Wire, from: NodeCard, to: NodeCard) => void;
};

/** One card on the canvas. Memoized, and every prop is the card itself
 * or a plain value the editor works out for it, so a card drag renders
 * the card in hand and leaves the rest alone: a move used to render all
 * of them (253 cards measured 25 ms a move in jsdom, the perf review's
 * second stage, 2026-10-01). Something a card shows that is not in its
 * props would go stale here: add it as a prop. */
const NodeCardView = memo(function NodeCardView({
  n,
  selected,
  wireTarget,
  wireCandidate,
  litIn,
  aimedIn,
  litOut,
  file,
  thumbsOff,
  engineThumb,
  photoSrc,
  thumbFilter,
  writesDepth,
  smartNote,
  acts,
}: {
  n: NodeCard;
  selected: boolean;
  /** The card the pipe in hand would land on now. */
  wireTarget: boolean;
  /** A card the pipe in hand may land on. */
  wireCandidate: boolean;
  /** The inputs the pipe in hand may take, space-separated. */
  litIn: string;
  /** The input the drop would take now, or "". */
  aimedIn: string;
  /** The output the pipe in hand (hanging off an input) would take its
   * source from, or "". */
  litOut: string;
  /** The photograph or file a source card names. */
  file: string | undefined;
  thumbsOff: boolean;
  /** The engine's own picture at this card, when it has one. */
  engineThumb: string | undefined;
  /** The catalog card's photo, or the active photograph. */
  photoSrc: string | undefined;
  thumbFilter: string;
  writesDepth: boolean;
  /** A Smart Mask's reason for an empty mask (smartnode.tsx), or "". */
  smartNote: string;
  acts: CardActs;
}) {
  cardRenders.n++;
  /** The ring and markers on input `seat` while a pipe hangs off an
   * output: every input it may land on, on every card, is ringed like a
   * lit output, and the one the drop would take now is marked as the
   * target. */
  const inLight = (seat: InSeat) => {
    const lit = litIn !== "" && litIn.split(" ").includes(seat);
    const aimed = lit && aimedIn === seat;
    return {
      attrs: { "data-wire-in": lit || undefined, "data-wire-in-target": aimed || undefined },
      style: aimed ? AIMED_PORT : lit ? LIT_PORT : {},
    };
  };
  return (
    <div
      className={`node${n.isGroup ? " group" : ""}`}
      style={{
        left: n.x,
        top: n.y,
        ...(wireTarget
          ? { outline: "2px solid var(--accent)", outlineOffset: 1 }
          : wireCandidate
            ? { outline: "1px dashed rgba(53,184,224,.45)", outlineOffset: 1 }
            : {}),
      }}
      data-wire-target={wireTarget || undefined}
      data-wire-candidate={wireCandidate || undefined}
      data-selected={selected}
      data-disabled={!n.enabled}
      data-mask-off={maskIsOff(n) || undefined}
      data-testid={`node-${n.id}`}
      onMouseDown={(e) => { if (isPrimaryPress(e)) acts.nodeDown(e, n); }}
      onDoubleClick={() => {
        if (n.isGroup) acts.openGroup(n.id);
      }}
    >
      <div className="cat" style={{ background: CAT_COLOR[n.cat] }} />
      {n.tint && (
        <div
          data-testid={`tint-${n.id}`}
          style={{ position: "absolute", left: 0, right: 0, top: 0, height: 2, background: n.tint }}
        />
      )}
      <div className="head">
        {n.isGroup && <GroupGlyph size={10} />}
        <div className="nm">{n.name}</div>
        {file ? (
          <div
            className="vv"
            data-testid={`source-file-${n.id}`}
            title={file}
            style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
          >
            {file}
          </div>
        ) : n.badge ? (
          <div className="vv">{n.badge}</div>
        ) : null}
      </div>
      {n.note && (
        <div data-testid={`note-${n.id}`} title={n.note} style={CARD_CAPTION_STYLE}>
          {n.note}
        </div>
      )}
      <div className="thumb">
        {thumbsOff ? null : engineThumb ? (
          // The engine's own picture at this node.
          <img src={engineThumb} alt="" data-testid={`node-thumb-${n.id}`} />
        ) : n.type === "heeler.file" ? (
          <FileThumb path={n.textParams?.path ?? ""} />
        ) : n.type === "heeler.catalog" ? (
          // The catalog's own thumbnail: rendered with that photo's
          // edits, which is what "as developed" shows.
          photoSrc ? (
            <img src={photoSrc} alt="" data-testid={`catalog-thumb-${n.id}`} />
          ) : (
            <div
              data-testid="catalog-thumb-empty"
              style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, letterSpacing: ".08em", textTransform: "uppercase", color: "var(--text-ghost)" }}
            >
              No photo
            </div>
          )
        ) : (
          <img src={photoSrc || "/sample/photo.jpg"} alt="" style={{ filter: thumbFilter }} />
        )}
      </div>
      {/* A depth export says which way its plane runs, since the card
shows it the reverse of Develop's Depth Map view
(2026-10-01: keep both and say so).*/}
      {writesDepth && (
        <div
          data-testid={`depth-convention-${n.id}`}
          title={DEPTH_EXPORT_CONVENTION}
          // Up off the bottom edge, so the mask and alpha diamonds
          // sitting on it never cover the words.
          style={{ ...CARD_CAPTION_STYLE, marginTop: -3, paddingBottom: 6 }}
        >
          {DEPTH_EXPORT_CONVENTION}
        </div>
      )}
      {/* A Smart Mask says why its picture is black: the model is missing, or
nothing has been asked of it yet (2026-10-01: "I don't see it
generating a mask").*/}
      {smartNote && (
        <div data-testid={`smart-note-${n.id}`} style={{ ...CARD_CAPTION_STYLE, marginTop: -3, paddingBottom: 6 }}>
          {smartNote}
        </div>
      )}
      {n.hasIn && (
        <div
          className="port"
          data-testid={`in-port-${n.id}`}
          data-tip={portHint(n, "in").tip}
          data-tip-below=""
          data-hint={portHint(n, "in").hint}
          onMouseDown={(ev) => { if (isPrimaryPress(ev)) acts.inputDown(ev, n, "in", MASK_IN_TYPES.has(n.type) ? "mask" : "image"); }}
          onPointerDown={(ev) => { if (ev.pointerType !== "mouse" && isPrimaryPress(ev)) acts.inputDown(ev, n, "in", MASK_IN_TYPES.has(n.type) ? "mask" : "image"); }}
          style={{ touchAction: "none", left: -4, top: inputY(n, "in"), background: inputColor(n, "in"), cursor: "crosshair", ...inLight("in").style }}
          {...inLight("in").attrs}
        />
      )}
      {n.hasIn2 && (
        <div
          className="port"
          data-testid={`in2-port-${n.id}`}
          data-tip={portHint(n, "in2").tip}
          data-tip-below=""
          data-hint={portHint(n, "in2").hint}
          onMouseDown={(ev) => { if (isPrimaryPress(ev)) acts.inputDown(ev, n, "in2", MASK_IN_TYPES.has(n.type) ? "mask" : "image"); }}
          onPointerDown={(ev) => { if (ev.pointerType !== "mouse" && isPrimaryPress(ev)) acts.inputDown(ev, n, "in2", MASK_IN_TYPES.has(n.type) ? "mask" : "image"); }}
          style={{ touchAction: "none", left: -4, top: inputY(n, "in2"), background: inputColor(n, "in2"), cursor: "crosshair", ...inLight("in2").style }}
          {...inLight("in2").attrs}
        />
      )}
      {n.hasIn3 && (
        <div
          className="port"
          data-testid={`in3-port-${n.id}`}
          data-tip={portHint(n, "in3").tip}
          data-tip-below=""
          data-hint={portHint(n, "in3").hint}
          onMouseDown={(ev) => { if (isPrimaryPress(ev)) acts.inputDown(ev, n, "in3", MASK_IN_TYPES.has(n.type) ? "mask" : "image"); }}
          onPointerDown={(ev) => { if (ev.pointerType !== "mouse" && isPrimaryPress(ev)) acts.inputDown(ev, n, "in3", MASK_IN_TYPES.has(n.type) ? "mask" : "image"); }}
          style={{ touchAction: "none", left: -4, top: inputY(n, "in3"), background: inputColor(n, "in3"), cursor: "crosshair", ...inLight("in3").style }}
          {...inLight("in3").attrs}
        />
      )}
      {n.hasOut && (
        <div
          className="port"
          data-testid={`out-port-${n.id}`}
          data-tip={portHint(n, "out").tip}
          data-tip-below=""
          data-hint={portHint(n, "out").hint}
          data-wire-source={(litOut === "out") || undefined}
          onMouseDown={(ev) => { if (isPrimaryPress(ev)) acts.wireDown(ev, n.id, "image", null, n.type === "heeler.export_layer" ? "image" : undefined); }}
          onPointerDown={(ev) => { if (ev.pointerType !== "mouse" && isPrimaryPress(ev)) acts.wireDown(ev, n.id, "image", null, n.type === "heeler.export_layer" ? "image" : undefined); }}
          style={{ touchAction: "none", right: -4, top: n.depthOut ? 24 : 35, background: n.isGroup ? "var(--cat-group)" : selected ? "var(--accent)" : "#6b7178", cursor: "crosshair", ...((litOut === "out") ? LIT_PORT : {}) }}
        />
      )}
      {n.maskOut && (
        <div
          className="port mask"
          data-testid={`mask-port-${n.id}`}
          data-tip={portHint(n, "maskOut").tip}
          data-tip-below=""
          data-hint={portHint(n, "maskOut").hint}
          data-wire-source={(litOut === "maskOut") || undefined}
          onMouseDown={(ev) => { if (isPrimaryPress(ev)) acts.wireDown(ev, n.id, "mask", null); }}
          onPointerDown={(ev) => { if (ev.pointerType !== "mouse" && isPrimaryPress(ev)) acts.wireDown(ev, n.id, "mask", null); }}
          style={{ touchAction: "none", right: -5, top: 34, background: CAT_COLOR.masking, cursor: "crosshair", ...((litOut === "maskOut") ? LIT_PORT : {}) }}
        />
      )}
      {/* Depth Map's second output (26.3 Phase 4): the farness
          plane as a field, a diamond below the image out. A pipe
          from it is a mask pipe named by its port. */}
      {n.depthOut && (
        <div
          className="port mask"
          data-testid={`depth-port-${n.id}`}
          data-tip={portHint(n, "depthOut").tip}
          data-tip-below=""
          data-hint={portHint(n, "depthOut").hint}
          data-wire-source={(litOut === "depthOut") || undefined}
          onMouseDown={(ev) => { if (isPrimaryPress(ev)) acts.wireDown(ev, n.id, "mask", null, "depth"); }}
          onPointerDown={(ev) => { if (ev.pointerType !== "mouse" && isPrimaryPress(ev)) acts.wireDown(ev, n.id, "mask", null, "depth"); }}
          style={{ touchAction: "none", right: -5, top: 47, background: CAT_COLOR.masking, cursor: "crosshair", ...((litOut === "depthOut") ? LIT_PORT : {}) }}
        />
      )}
      {/* The File card's second output (26.3 Phase 6): the read
          page's alpha, or the channel the Layer field names, as a
          field. A pipe from it is a mask pipe named by its port. */}
      {n.fileMaskOut && (
        <div
          className="port mask"
          data-testid={`file-mask-port-${n.id}`}
          data-tip={portHint(n, "fileMask").tip}
          data-tip-below=""
          data-hint={portHint(n, "fileMask").hint}
          data-wire-source={(litOut === "fileMask") || undefined}
          onMouseDown={(ev) => { if (isPrimaryPress(ev)) acts.wireDown(ev, n.id, "mask", null, "mask"); }}
          onPointerDown={(ev) => { if (ev.pointerType !== "mouse" && isPrimaryPress(ev)) acts.wireDown(ev, n.id, "mask", null, "mask"); }}
          style={{ touchAction: "none", right: -5, top: 47, background: CAT_COLOR.masking, cursor: "crosshair", ...((litOut === "fileMask") ? LIT_PORT : {}) }}
        />
      )}
      {/* The mask input. A mask pipe dropped anywhere on the card
          lands here, and the diamond drags like every input: empty,
          it draws a pipe out looking for a mask source; wired, it
          lifts the pipe (the head handle above it does the same). */}
      {n.maskIn && (
        <div
          className="port mask"
          data-testid={`mask-in-port-${n.id}`}
          data-tip={portHint(n, "mask").tip}
          data-tip-below=""
          data-hint={portHint(n, "mask").hint}
          onMouseDown={(ev) => { if (isPrimaryPress(ev)) acts.inputDown(ev, n, "mask", "mask"); }}
          onPointerDown={(ev) => { if (ev.pointerType !== "mouse" && isPrimaryPress(ev)) acts.inputDown(ev, n, "mask", "mask"); }}
          style={{ touchAction: "none", left: 4, bottom: -4, background: "var(--cat-masking-lt)", cursor: "crosshair", ...inLight("mask").style }}
          {...inLight("mask").attrs}
        />
      )}
      {/* Output's transparency input (26.3 Phase 5), and the
          Export Layer's written-alpha input (Phase 8): a mask pipe
          dropped on the card lands here, and it drags like the mask
          input. On the Export Layer, which has a mask diamond too,
          it sits one seat over. */}
      {n.alphaIn && (
        <div
          className="port mask"
          data-testid={`alpha-in-port-${n.id}`}
          data-tip={portHint(n, "alpha").tip}
          data-tip-below=""
          data-hint={portHint(n, "alpha").hint}
          onMouseDown={(ev) => { if (isPrimaryPress(ev)) acts.inputDown(ev, n, "alpha", "mask"); }}
          onPointerDown={(ev) => { if (ev.pointerType !== "mouse" && isPrimaryPress(ev)) acts.inputDown(ev, n, "alpha", "mask"); }}
          style={{ touchAction: "none", left: n.maskIn ? 26 : 4, bottom: -4, background: "var(--cat-masking-lt)", cursor: "crosshair", ...inLight("alpha").style }}
          {...inLight("alpha").attrs}
        />
      )}
      {/* The depth input (26.3 Phase 10.3): where the Depth Map's
          plane lands. A mask pipe dropped on the diamond wires it,
          and it drags like the mask input. Beside the mask diamond
          on the picture tools, in its place on the masks, which
          have none. */}
      {n.depthIn && (
        <div
          className="port mask"
          data-testid={`depth-in-port-${n.id}`}
          data-tip={portHint(n, "depthIn").tip}
          data-tip-below=""
          data-hint={portHint(n, "depthIn").hint}
          onMouseDown={(ev) => { if (isPrimaryPress(ev)) acts.inputDown(ev, n, "depth", "mask"); }}
          onPointerDown={(ev) => { if (ev.pointerType !== "mouse" && isPrimaryPress(ev)) acts.inputDown(ev, n, "depth", "mask"); }}
          style={{ touchAction: "none", left: n.maskIn ? 26 : 4, bottom: -4, background: "var(--cat-masking-lt)", cursor: "crosshair", ...inLight("depth").style }}
          {...inLight("depth").attrs}
        />
      )}
    </div>
  );
});

/** How many times a pipe has rendered: the card drag's seam for the
 * pipes (a move redraws the pipes on the cards in hand). */
export const wireRenders = { n: 0 };

/** One pipe on the canvas, memoized like the cards: a card drag redraws
 * the pipes on the cards in hand and leaves the rest alone. */
const WireView = memo(function WireView({
  w,
  from,
  to,
  stroke,
  width,
  dash,
  isShaped,
  isDrop,
  isPicked,
  isHover,
  acts,
}: {
  w: Wire;
  from: NodeCard;
  to: NodeCard;
  stroke: string;
  width: number;
  dash: string | undefined;
  isShaped: boolean;
  isDrop: boolean;
  isPicked: boolean;
  isHover: boolean;
  acts: CardActs;
}) {
  wireRenders.n++;
  const d = wirePath(from, to, w.toPort, w.fromPort);
  const unnamed = wireLacksPort(w, from);
  return (
    <g>
      <path
        data-testid={isDrop ? "wire-drop-target" : undefined}
        d={d}
        stroke={isDrop || isPicked ? "var(--accent)" : isHover ? "#c2c7cd" : unnamed ? "var(--warn, #d9a441)" : stroke}
        strokeWidth={isDrop || isPicked ? width + 1.5 : isHover ? width + 0.8 : width}
        strokeDasharray={unnamed ? "5 4" : dash}
      />
      {/* A wire that does not say which output it takes: the
          engine reads it as the image, so it is marked for the
          user to reconnect from the depth or mask port. */}
      {unnamed && (
        <circle
          data-testid={`wire-unnamed-${w.from}-${w.to}`}
          cx={(outCenter(from).x + portCenter(to, w.toPort).x) / 2}
          cy={(outCenter(from).y + portCenter(to, w.toPort).y) / 2}
          r={3.2}
          fill="var(--warn, #d9a441)"
          stroke="#1c1a17"
          strokeWidth={0.8}
        />
      )}
      {/* The edge badge (proposal §5): a gold tick at the
          midpoint of every pipe carrying display-shaped
          data, so where the picture stops being photographic
          light is visible on the canvas itself. The wire's
          tooltip carries the words. */}
      {isShaped && w.toPort !== "mask" && w.toPort !== "clip" && w.toPort !== "alpha" && w.toPort !== "depth" && (
        <circle
          data-testid={`wire-shaped-${w.from}-${w.to}`}
          cx={(outCenter(from).x + portCenter(to, w.toPort).x) / 2}
          cy={(outCenter(from).y + portCenter(to, w.toPort).y) / 2}
          r={2.6}
          fill="var(--accent)"
          stroke="#1c1a17"
          strokeWidth={0.8}
        />
      )}
      {/* The pipe's whole interaction rides an invisible wide twin:
hover to see it is grabbable, click to pick it (Delete
removes), drag near either end to re-route that end, drop
on nothing to remove. "what about selecting a
connection and deleting it? Or grabbing an input and
removing it from a node?"*/}
      <path
        d={d}
        data-testid={`wire-hit-${w.from}-${w.to}-${w.toPort}`}
        // The tooltip says what the pipe carries and between whom.
        // "Standard Color.rgb > Levels.rgb". Image pipes
        // carry rgb; mask and clip pipes carry alpha.
        data-hint={`${from.name}.${w.fromPort ?? (from.maskOut ? "alpha" : "rgb")} > ${to.name}.${
          w.toPort === "mask" || w.toPort === "clip" || w.toPort === "alpha" || w.toPort === "depth" ? "alpha" : "rgb"
        }${
          isShaped ? " · display-shaped: the Tone Profile has already rendered this for the screen" : ""
        }${
          unnamed ? ` · this wire does not say which output of ${from.name} it takes and is read as the image; drag its tail from the depth or mask port to say` : ""
        } · click selects (DELETE removes), drag an end to re-route`}
        stroke="transparent"
        strokeWidth={13}
        style={{ pointerEvents: "stroke", cursor: "pointer" }}
        onMouseEnter={() => acts.wireEnter(w)}
        onMouseLeave={acts.wireLeave}
        onMouseUp={(ev) => ev.stopPropagation()}
        onMouseDown={(ev) => { if (isPrimaryPress(ev)) acts.wireHitDown(ev, w, from, to); }}
      />
    </g>
  );
});

/** How many times the editor has rendered: a test seam for the drag
 * probes (a pointer move during a wire drag must not render the cards). */
export const editorRenders = { n: 0 };

function NodeEditorImpl({
  state: outerState,
  dispatch: outerDispatch,
  overlay = false,
  onPopOut,
}: {
  state: State;
  dispatch: D;
  overlay?: boolean;
  /** Present only in the main window: the popped-out graph has no use
   * for a button that pops it out again. */
  /** Handed the button itself, so the opener can remember it for the
   * focus to come back to: on macOS a mouse click need not focus a
   * button, so document.activeElement is not a reliable witness. */
  onPopOut?: (opener: HTMLElement) => void;
}) {
  editorRenders.n++;
  const dispatch = outerDispatch;
  // Per-node pictures. Asked for a beat after the graph settles, for
  // every card the engine can answer for, and only while this editor is
  // on screen. renderVersion is the edit clock; the image id keys the
  // store so a switch never shows one photograph's frames on another's
  // cards.
  const [, setThumbTick] = useState(0);
  // The cards on the canvas: the top level, or the opened group's
  // members (2026-09-23: inside the Sharpening group the Invert card
  // showed the picture uninverted). The engine sees the flattened graph,
  // where a member keeps its id, so it answers for them too.
  const openedForThumbs = outerState.openedGroup
    ? outerState.nodes.find((n) => n.id === outerState.openedGroup)
    : undefined;
  const thumbIds = (openedForThumbs?.groupNodes ?? outerState.nodes)
    .filter((n) => !n.isGroup && n.enabled && openedForThumbs?.enabled !== false)
    .map((n) => n.id)
    .join("\u0000");
  useEffect(() => {
    let live = true;
    const t = window.setTimeout(() => {
      const ids = thumbIds ? thumbIds.split("\u0000") : [];
      void nodeThumbs(outerState, ids).then((got) => {
        if (!live || !got) return;
        for (const id of ids) {
          const key = `${outerState.activeImage}:${id}`;
          if (got[id]) nodeThumbStore.set(key, got[id]);
          else nodeThumbStore.delete(key);
        }
        setThumbTick((t) => t + 1);
      });
    }, NODE_THUMB_DELAY_MS);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outerState.renderVersion, outerState.activeImage, thumbIds]);

  // On why a group exists at all: "the container itself would act as a node.
  // We would reveal parameters of some of the child nodes as controls on the
  // container node." A group does both of those. This is the third thing it
  // has to do: open up.
  //
  // The owner again: "The Grain node is the dashboard of a car when in
  // Develop, Graph mode is actually going under the hood to see how the
  // engine is setup." Under the hood means the nodes that are actually in
  // there, not a card with a picture on it, so the canvas draws the group's
  // contents in place of the graph while it is open. The reducer folds edits
  // back into the group, so what is drawn here is editable here.
  const opened = outerState.openedGroup
    ? outerState.nodes.find((n) => n.id === outerState.openedGroup)
    : undefined;
  const state: State = opened?.groupNodes
    ? { ...outerState, nodes: opened.groupNodes, wires: opened.groupWires ?? [] }
    : outerState;
  const selected = new Set(state.selection);
  // Where the picture stops being photographic light: recomputed only
  // when the graph's shape or switches change, not per pointer move.
  const shaped = React.useMemo(
    () => displayShapedIds(state.nodes, state.wires),
    [state.nodes, state.wires],
  );
  const surface = useRef<HTMLDivElement | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  // The node being renamed, and where its field sits: the spot the menu was
  // at, so the field appears where the click did.
  // `recipe`: the field names a new recipe saved from this group (Save
  // as Recipe), not the card.
  const [renaming, setRenaming] = useState<{ id: string; name: string; recipe?: boolean } | null>(null);
  // The N key asks through state; the view owns the input. Placed by
  // the node's own position, like the context-menu rename.
  useEffect(() => {
    if (!state.renameRequest) return;
    const n = state.nodes.find((k) => k.id === state.renameRequest);
    dispatch({ type: "request_rename", id: null });
    if (!n) return;
    setRenameAt({ x: n.x, y: n.y + NODE_H + 6 });
    setRenaming({ id: n.id, name: n.name });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.renameRequest]);
  const [renameAt, setRenameAt] = useState({ x: 0, y: 0 });
  const menuRef = useDismiss<HTMLDivElement>(menu !== null, () => setMenu(null));
  // The context menu measured and clamped inside the surface before
  // paint, so a right-click near the bottom edge opens the menu ABOVE
  // the pointer instead of running off into the clip. "when
  // I right click in the node graph too low the context menu gets
  // clipped." Same measure-then-clamp move the thumbnail menu makes.
  //
  // In the window, not the surface (2026-10-01: "I can see someone with
  // a small window layout not seeing all the nodes"): in a small window
  // the graph pane is a strip a few rows tall, and a menu kept inside
  // it, its flyouts cut by the pane's overflow, could not show an Add
  // list at all. So the menu is portaled to the body and pinned to the
  // window (the graph sits outside every CSS zoom, so window pixels are
  // its CSS pixels), its flyouts pinned too, and a menu taller than the
  // window scrolls.
  const [menuBox, setMenuBox] = useState<{ x: number; y: number; cap?: number } | null>(null);
  useLayoutEffect(() => {
    if (!menu || !menuRef.current || !surface.current) {
      setMenuBox(null);
      return;
    }
    const el = menuRef.current;
    const host = pxBox(surface.current);
    const view = viewportSize();
    const room = view.h - 12;
    const h = el.offsetHeight || 320;
    const at = clampMenu(
      { x: host.left + menu.x, y: host.top + menu.y },
      { w: el.offsetWidth || 220, h: Math.min(h, room) },
      view,
    );
    setMenuBox(h > room ? { ...at, cap: room } : at);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menu?.x, menu?.y]);
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  // The pipe a dragged node would splice into if dropped now. A compositor's
  // insert gesture: the pipe lights up under the node, release commits.
  const [dropWire, setDropWire] = useState<Wire | null>(null);
  // A mask pipe being dragged by hand: from a mask node's out-port (new
  // pipe) or picked up by its head (reassign or disconnect). The
  // connect/disconnect reducers with their cycle and occupancy checks
  // existed for a while with no gesture attached; this is the hand.
  //
  // A pipe hangs off one end while the other follows the pointer. With
  // `from` set it hangs off that output (dragged out of an out-port, or
  // picked up by its input end); with `to` set it hangs off that INPUT
  // and fishes for a source (dragged out of an input port, or re-sourced
  // by its tail). (2026-09-29): "When working in Nodes in other apps you
  // can usually drag from either end." `lifted` is the existing wire in
  // hand, hidden while it is carried.
  const [wireDrag, setWireDrag] = useState<WireDrag | null>(null);
  // The pipe in hand's cycle test (dragCycleCheck), computed once per
  // gesture end, kind and lifted pipe: NOT on the pointer's position,
  // which changes every move. Without it, lighting the ports a pipe may
  // land on walked the whole graph once per port of every card on every
  // pointer move (a 253-card graph measured 10 ms of rule work a move).
  const dragCycle = React.useMemo(
    () => (wireDrag ? dragCycleCheck(state.wires, wireDrag) : undefined),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.wires, wireDrag?.from, wireDrag?.to, wireDrag?.lifted],
  );
  // The selected pipe, if any: click a wire to pick it, Delete removes
  // it, and either end drags. Wires are objects here, the compositor premise.
  const [pickedWire, setPickedWire] = useState<Wire | null>(null);
  const wireCleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => wireCleanup.current?.(), []);

  /** A wire is tentative until release. Escape, a lost touch, or
   * leaving the window cancels it without changing the graph. */
  const followWire = (e: React.MouseEvent, move: (ev: MouseEvent) => void, up: (ev: MouseEvent) => void) => {
    wireCleanup.current?.();
    const pointer = e.type === "pointerdown";
    const pointerId = (e.nativeEvent as PointerEvent).pointerId;
    const belongs = (ev: MouseEvent) => !pointer || (ev as PointerEvent).pointerId === pointerId;
    const moving = (ev: MouseEvent) => { if (belongs(ev)) move(ev); };
    const finish = (ev: MouseEvent) => { if (belongs(ev)) { cleanup(); up(ev); } };
    const cancel = () => { cleanup(); setWireDrag(null); };
    const lost = (ev: PointerEvent) => { if (belongs(ev)) cancel(); };
    const key = (ev: KeyboardEvent) => { if (ev.key === "Escape") { ev.preventDefault(); cancel(); } };
    const cleanup = () => {
      window.removeEventListener(pointer ? "pointermove" : "mousemove", moving);
      window.removeEventListener(pointer ? "pointerup" : "mouseup", finish);
      window.removeEventListener("pointercancel", lost);
      window.removeEventListener("keydown", key);
      window.removeEventListener("blur", cancel);
      wireCleanup.current = null;
    };
    wireCleanup.current = cleanup;
    window.addEventListener(pointer ? "pointermove" : "mousemove", moving);
    window.addEventListener(pointer ? "pointerup" : "mouseup", finish);
    window.addEventListener("pointercancel", lost);
    window.addEventListener("keydown", key);
    window.addEventListener("blur", cancel);
  };

  const [hoverWire, setHoverWire] = useState<Wire | null>(null);
  useEffect(() => {
    if (!pickedWire) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === "Delete" || e.key === "Backspace") {
        dispatch({ type: "disconnect", to: pickedWire.to, toPort: pickedWire.toPort });
        setPickedWire(null);
      }
      if (e.key === "Escape") setPickedWire(null);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [pickedWire, dispatch]);
  const [search, setSearch] = useState("");
  // Notices clear themselves: they are a sentence, not a state.
  useEffect(() => {
    if (!state.notice) return;
    const t = window.setTimeout(() => dispatch({ type: "set_notice", text: null }), 4000);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.notice?.at]);

  /** Screen point relative to the surface (for menus, which live outside
   * the panned layer). */
  const screenPoint = (e: { clientX: number; clientY: number }) => {
    const rect = surface.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  // Window drag listeners outlive the render in which the drag began.
  // Read the current view when a trackpad pans or zooms mid-drag.
  const graphViewRef = useRef(state.graphView);
  graphViewRef.current = state.graphView;

  /** Graph coordinates: undo the viewport pan and zoom, so node drags and
   * marquee hit-tests stay correct at any zoom level. */
  const localPoint = (e: { clientX: number; clientY: number }) => {
    const p = screenPoint(e);
    const v = graphViewRef.current;
    return { x: (p.x - v.x) / v.zoom, y: (p.y - v.y) / v.zoom };
  };

  // Hybrid zoom. WKWebView rasterizes a transform-scaled layer at 1x and
  // lets the compositor stretch the bitmap, so a transform-only zoom goes
  // soft the moment it passes 100%. The CSS `zoom` property re-lays-out
  // and re-rasterizes crisply, but it reflows the whole graph, too heavy
  // for every wheel tick. So: during the gesture the cheap compositor
  // scale carries the difference, and once the wheel goes quiet the
  // settled value moves onto `zoom`. restZoom is the settled, crisp part.
  const [restZoom, setRestZoom] = useState(state.graphView.zoom);
  useEffect(() => {
    if (state.graphView.zoom === restZoom) return;
    const t = window.setTimeout(() => setRestZoom(state.graphView.zoom), 160);
    return () => window.clearTimeout(t);
  }, [state.graphView.zoom, restZoom]);

  // Space-drag pans the graph, the pan a touchpad can reach. The
  // report: "Since there is no middle-mouse it is pretty much
  // impossible to pan around the graph view."
  const spacePan = useSpacePan((dx, dy) => dispatch({ type: "pan_graph", dx, dy }));
  const navRef = useViewportNav<HTMLDivElement>({
    onZoom: (factor, cx, cy) => {
      // The hook reports offsets from the center; the graph transform is
      // anchored top-left, so shift them back.
      const rect = surface.current?.getBoundingClientRect();
      dispatch({
        type: "zoom_graph",
        factor,
        cx: cx + (rect ? rect.width / 2 : 0),
        cy: cy + (rect ? rect.height / 2 : 0),
      });
    },
    onPan: (dx, dy) => dispatch({ type: "pan_graph", dx, dy }),
    zoomRate: state.prefs.viewerZoomRate,
    rotationStep: state.prefs.viewerRotationStep,
    invertZoom: state.prefs.wheelZoomInverted,
  });

  // Node dragging listens on the WINDOW for the duration of the drag: the
  // pointer can outrun the node or leave the surface entirely without the
  // drag sticking or dropping. One undo entry per drag via the gesture.
  /** The pipe nearest the dragged node, within reach.
   *
   * Wires are hit-tested as straight runs between their endpoints; the
   * drawn curve deviates by a few pixels at most, and a 26px reach
   * swallows the difference. Image-chain pipes take an image insert;
   * with `allowMask` (the dragged node is a field pass-through) mask
   * and alpha pipes are candidates too, and the nearest pipe of either
   * kind wins. Never the node's own.
   */
  const wireNear = (id: string, cx: number, cy: number, allowMask = false): Wire | null => {
    let best: Wire | null = null;
    let bestD = 26;
    for (const w of state.wires) {
      if ((w.kind !== "image" && !(allowMask && w.kind === "mask")) || w.from === id || w.to === id) continue;
      const from = state.nodes.find((k) => k.id === w.from);
      const to = state.nodes.find((k) => k.id === w.to);
      if (!from || !to) continue;
      const { x: x1, y: y1 } = outCenter(from);
      const { x: x2, y: y2 } = portCenter(to, w.toPort);
      const len2 = (x2 - x1) ** 2 + (y2 - y1) ** 2;
      const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((cx - x1) * (x2 - x1) + (cy - y1) * (y2 - y1)) / len2));
      const d = Math.hypot(cx - (x1 + t * (x2 - x1)), cy - (y1 + t * (y2 - y1)));
      if (d < bestD) {
        bestD = d;
        best = w;
      }
    }
    return best;
  };

  /** The card a pipe drop lands on. Cards render in array order, so the
   * LAST card under the point is the one on screen, and the one the hand
   * was aiming at. The bottom-edge input diamonds (mask, alpha) overhang
   * the card's rectangle by a few px, and landing on the diamond is
   * landing on the card. (2026-09-17): "Range Mask.alpha to Color.MASK...
   * I broke the connection and am trying to reconnect" -- the drop died
   * silently when the cursor was low on the diamond.*/
  const cardAt = (q: { x: number; y: number }, outs = false): NodeCard | undefined => {
    for (let i = state.nodes.length - 1; i >= 0; i--) {
      const k = state.nodes[i];
      if (q.x >= k.x && q.x <= k.x + NODE_W && q.y >= k.y && q.y <= k.y + NODE_H) return k;
      // With `outs` (a pipe fishing for its source), the output ports
      // hanging off the right edge count as the card too.
      const seats: ("mask" | "alpha" | "depth" | "out" | "maskOut" | "depthOut" | "fileMask")[] = [
        ...(k.maskIn ? (["mask"] as const) : []),
        ...(k.alphaIn ? (["alpha"] as const) : []),
        ...(k.depthIn ? (["depth"] as const) : []),
        ...(outs && k.hasOut ? (["out"] as const) : []),
        ...(outs && k.maskOut ? (["maskOut"] as const) : []),
        ...(outs && k.depthOut ? (["depthOut"] as const) : []),
        ...(outs && k.fileMaskOut ? (["fileMask"] as const) : []),
      ];
      for (const seat of seats) {
        const p = portCenter(k, seat);
        if (Math.hypot(q.x - p.x, q.y - p.y) <= 7) return k;
      }
    }
    return undefined;
  };

  /** The inputs of card `n` the pipe in hand (drawn out of output
   * `from`) may land on: pipeFits, the rule a pipe drawn out of an input
   * reads too. The cycle half comes from the gesture's one walk
   * (dragCycle below), not a walk per port per card per move. */
  const seatsFrom = (kind: "mask" | "image", from: string, n: NodeCard, lifted?: Wire): InSeat[] => {
    const src = state.nodes.find((k) => k.id === from);
    return src ? seatsFor(state.wires, src, kind, n, lifted, dragCycle) : [];
  };

  /** Whether card `n` may be the source of a pipe of `kind` into input
   * `toPort` of card `to`: the same pipeFits, read from the input end. */
  const sourceFits = (kind: "mask" | "image", to: string, toPort: Wire["toPort"] | undefined, n: NodeCard, lifted?: Wire): boolean => {
    const dst = state.nodes.find((k) => k.id === to);
    return !!dst && !!toPort && pipeFits(state.wires, n, kind, dst, toPort, lifted, dragCycle);
  };

  /** Whether card `n` lights up as a place the pipe in hand can land. */
  const dropFits = (d: WireDrag, n: NodeCard): boolean =>
    d.to !== undefined
      ? sourceFits(d.kind, d.to, d.toPort, n, d.lifted)
      : d.from !== undefined && seatsFrom(d.kind, d.from, n, d.lifted).length > 0;

  /** A re-route is several reducer steps (take the old pipe off, clear
   * an occupied port, make the new one); run inside one gesture they are
   * one undo step. Nothing dispatched, nothing recorded. */
  const asOneStep = (cmds: Command[]) => {
    if (cmds.length === 0) return;
    if (cmds.length === 1) {
      dispatch(cmds[0]);
      return;
    }
    dispatch({ type: "begin_gesture", key: WIRE_GESTURE });
    for (const c of cmds) dispatch(c);
    dispatch({ type: "end_gesture" });
  };

  /** Drags a pipe by its INPUT end, hanging off output `from`: fresh out
   * of an output port, or `pickedUp`, an existing pipe lifted off its
   * input (by the input port itself, its head handle, or the wire near
   * its head). Dropping on a card connects to the input under the
   * pointer; dropping a lifted pipe on nothing takes it off (a compositor's
   * disconnect), and dropping it back where it was changes nothing. */
  const beginWireDrag = (
    e: React.MouseEvent,
    from: string,
    kind: "mask" | "image",
    pickedUp: Wire | null,
    fromPort?: Wire["fromPort"],
  ) => {
    if (!isPrimaryPress(e)) return;
    e.stopPropagation();
    e.preventDefault();
    const start = localPoint(e);
    let hover: string | null = null;
    let hoverSeat: InSeat | null = null;
    const lifted = pickedUp ?? undefined;
    setGhost(start.x, start.y);
    setWireDrag({ from, fromPort, kind, x: start.x, y: start.y, hover: null, hoverSeat: null, lifted });
    // What the cards were last told: a move that changes neither the
    // hovered card nor its seat moves the ghost alone (setGhost).
    let told: { hover: string | null; seat: string } = { hover: null, seat: "" };
    const move = (ev: MouseEvent) => {
      if (!surface.current) return;
      const q = localPoint(ev);
      setGhost(q.x, q.y);
      const under = cardAt(q);
      // The inputs that light are the inputs a drop may take (pipeFits,
      // the rule an input-first drag reads); the drop takes the one
      // aimed at, or the card's natural seat for the pipe (dropSeat).
      hoverSeat = under ? dropSeat(under, kind, q, seatsFrom(kind, from, under, lifted)) : null;
      hover = under && hoverSeat ? under.id : null;
      const seat = hoverSeat ? JSON.stringify(hoverSeat) : "";
      if (hover === told.hover && seat === told.seat) return;
      told = { hover, seat };
      setWireDrag({ from, fromPort, kind, x: q.x, y: q.y, hover, hoverSeat, lifted });
    };
    const up = (ev: MouseEvent) => {
      // A release can arrive without a move (a click in place), or
      // after the viewport moved under the hand. Hit-test the release.
      move(ev);
      setWireDrag(null);
      const target = hover ? state.nodes.find((k) => k.id === hover) : undefined;
      if (hover && target && hoverSeat) {
        const toPort = landingPort(target, hoverSeat);
        // Put back where it came from: nothing happened.
        if (pickedUp && pickedUp.to === hover && sameInput(target, pickedUp.toPort, toPort)) return;
        const cmds: Command[] = [];
        if (pickedUp) cmds.push({ type: "disconnect", to: pickedUp.to, toPort: pickedUp.toPort });
        // Dropping onto an occupied port means replace: the reducer's
        // occupancy check would refuse, and refusal is not what the
        // hand meant. The same pipe again is no change at all.
        const already = state.wires.find((w) => w.to === hover && sameInput(target, w.toPort, toPort));
        if (already && already !== pickedUp) {
          if (!pickedUp && already.from === from && (already.fromPort ?? undefined) === (fromPort ?? undefined)) return;
          cmds.push({ type: "disconnect", to: hover, toPort: already.toPort });
        }
        cmds.push({ type: "connect", wire: { from, to: hover, toPort, kind, ...(fromPort ? { fromPort } : {}) } });
        asOneStep(cmds);
      } else if (pickedUp && !cardAt(localPoint(ev))) {
        // An incompatible card cancels the move. Only empty canvas
        // disconnects; a rejected connection must not lose the old one.
        // Dropped on nothing: the pipe comes off. A compositor's gesture,
        // letter for letter.
        dispatch({ type: "disconnect", to: pickedUp.to, toPort: pickedUp.toPort });
      }
    };
    followWire(e, move, up);
  };

  /** Drags a pipe by its OUTPUT end, hanging off input `wire.toPort` of
   * `wire.to`: the input stays put and the SOURCE is chosen. It starts
   * on an empty input port (a pipe that does not exist yet, `wire.from`
   * empty) or on an existing pipe's tail. The ghost runs from that input
   * to the pointer, and the cards with an output of the pipe's kind
   * light up; dropping on one makes the same connect an output-first
   * drag makes. An existing pipe dropped on nothing comes off, and
   * dropped back on its own source changes nothing. */
  const beginTailDrag = (e: React.MouseEvent, wire: Wire) => {
    e.stopPropagation();
    e.preventDefault();
    const kind: "mask" | "image" = wire.kind === "mask" ? "mask" : "image";
    const lifted = wire.from ? wire : undefined;
    let hover: string | null = null;
    const start = localPoint(e);
    const hand = (x: number, y: number): WireDrag => ({ kind, x, y, hover, to: wire.to, toPort: wire.toPort, lifted });
    setGhost(start.x, start.y);
    setWireDrag(hand(start.x, start.y));
    let told: string | null = null;
    const move = (ev: MouseEvent) => {
      if (!surface.current) return;
      const q = localPoint(ev);
      setGhost(q.x, q.y);
      const under = cardAt(q, true);
      hover = under && sourceFits(kind, wire.to, wire.toPort, under, lifted) ? under.id : null;
      // The ghost moved already; the cards hear only a change of hover.
      if (hover === told) return;
      told = hover;
      setWireDrag(hand(q.x, q.y));
    };
    const up = (ev: MouseEvent) => {
      move(ev);
      setWireDrag(null);
      const src = hover ? state.nodes.find((k) => k.id === hover) : undefined;
      const seat = src ? sourceSeat(kind, src) : null;
      if (src && seat) {
        const fromPort = seat.fromPort;
        // Dropped back on the source it already had: nothing happened.
        if (lifted && lifted.from === src.id && (lifted.fromPort ?? undefined) === (fromPort ?? undefined)) return;
        const cmds: Command[] = [];
        if (lifted) cmds.push({ type: "disconnect", to: wire.to, toPort: wire.toPort });
        cmds.push({
          type: "connect",
          wire: { from: src.id, to: wire.to, toPort: wire.toPort, kind, ...(fromPort ? { fromPort } : {}) },
        });
        asOneStep(cmds);
      } else if (lifted && !cardAt(localPoint(ev), true)) {
        dispatch({ type: "disconnect", to: wire.to, toPort: wire.toPort });
      }
    };
    followWire(e, move, up);
  };

  /** A mousedown on input port `toPort` of `n`. A connected input picks
   * its pipe up by the input end: it stays on its source output and
   * follows the pointer. An empty one draws a new pipe out of the port,
   * looking for a source. (2026-09-29): "When working in Nodes in other
   * apps you can usually drag from either end. Right now, Heeler is
   * forcing you to drag from the OUT to the IN and MASK."*/
  const onInputDown = (ev: React.MouseEvent, n: NodeCard, toPort: Wire["toPort"], kind: "mask" | "image") => {
    if (!isPrimaryPress(ev)) return;
    const fed = state.wires.find((w) => w.to === n.id && sameInput(n, w.toPort, toPort));
    if (fed) {
      // A group's boundary pipe is not the hand's to move; the card
      // under it drags as usual.
      if (fed.kind === "group") return;
      beginWireDrag(ev, fed.from, fed.kind === "mask" ? "mask" : "image", fed, fed.fromPort);
      return;
    }
    beginTailDrag(ev, { from: "", to: n.id, toPort, kind });
  };

  const onNodeDown = (e: React.MouseEvent, n: NodeCard) => {
    if (!isPrimaryPress(e)) return;
    e.stopPropagation();
    e.preventDefault();
    setMenu(null);
    if (!selected.has(n.id)) {
      dispatch({ type: "select_nodes", ids: [n.id], additive: e.shiftKey });
    }
    const p = localPoint(e);
    // A card picked up out of a selection carries the selection with it
    // ("If I marquee select a bunch of nodes I can't drag as a
    // group"). A card outside the selection was just made the selection
    // above, so it travels alone.
    const party = selected.has(n.id) && selected.size > 1 ? state.nodes.filter((k) => selected.has(k.id)) : [n];
    const group = party.length > 1;
    dispatch({ type: "begin_gesture", key: group ? "selection.move" : `${n.id}.move` });
    const grip = { dx: p.x - n.x, dy: p.y - n.y };
    const starts = party.map((k) => ({ id: k.id, x: k.x, y: k.y }));
    // ALT at pickup means extract: pull the node loose and let its
    // neighbors heal around the hole.
    const extracting = e.altKey;
    // Insertion needs an image in and out on the node itself; a mask
    // node dragged across a pipe is just a node being moved, and so is
    // a node whose inputs are fields (Channel Join), and so is a party.
    const insertable =
      !group && !!n.hasIn && !!n.hasOut && !n.maskOut && !MASK_IN_TYPES.has(n.type) && n.id !== "src" && n.id !== "output";
    // A field pass-through (invert_mask, the logic family, the Export
    // Layer's gray pair) instead drops onto a mask or alpha pipe and
    // splices into that (26.3). "If a node has Alpha in and out
    // and is dragged over a Alpha connection it should be able to connect."
    const fieldable = !group && !!fieldSpliceSeats(n);
    let target: Wire | null = null;
    const move = (ev: MouseEvent) => {
      // The editor may unmount mid-drag (mode switch); go inert.
      if (!surface.current) return;
      const q = localPoint(ev);
      // No floor and no left wall: the canvas pans without limit, so a card
      // may sit anywhere on it ("it seems there is a 'top' to
      // the graph... it went a small distance then it a hard stop").
      const x = Math.round(q.x - grip.dx);
      const y = Math.round(q.y - grip.dy);
      if (group) {
        const dx = x - n.x;
        const dy = y - n.y;
        dispatch({ type: "move_nodes", moves: starts.map((k) => ({ id: k.id, x: k.x + dx, y: k.y + dy })) });
      } else {
        dispatch({ type: "move_node", id: n.id, x, y });
      }
      if ((insertable || fieldable) && !extracting) {
        const hit = wireNear(n.id, x + NODE_W / 2, y + 35, fieldable);
        if (hit !== target) {
          target = hit;
          setDropWire(hit);
        }
      }
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      dispatch({ type: "end_gesture" });
      if (target) {
        dispatch({
          type: "splice_node_into_wire",
          id: n.id,
          from: target.from,
          to: target.to,
          toPort: target.toPort,
        });
      } else if (extracting) {
        dispatch({ type: "extract_node", id: n.id });
      }
      setDropWire(null);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const onMove = (e: React.MouseEvent) => {
    if (marquee) {
      const p = localPoint(e);
      setMarquee({ ...marquee, x1: p.x, y1: p.y });
    }
  };

  const onUp = () => {
    if (marquee) {
      const [mx0, mx1] = [Math.min(marquee.x0, marquee.x1), Math.max(marquee.x0, marquee.x1)];
      const [my0, my1] = [Math.min(marquee.y0, marquee.y1), Math.max(marquee.y0, marquee.y1)];
      const hit = state.nodes
        .filter((n) => n.x < mx1 && n.x + NODE_W > mx0 && n.y < my1 && n.y + NODE_H > my0)
        .map((n) => n.id);
      if (hit.length) dispatch({ type: "select_nodes", ids: hit });
      else dispatch({ type: "clear_selection" });
      setMarquee(null);
    }
  };

  const onSurfaceDown = (e: React.MouseEvent) => {
    if (!isPrimaryPress(e)) return;
    setMenu(null);
    // A press on empty canvas lets a picked wire go. This used to
    // happen on mouseUP, which meant the pick's own bubbled mouseup
    // cleared it instantly: select and deselect in one click. The
    // report: "Having trouble click and selecting a connector line."
    setPickedWire(null);
    const p = localPoint(e);
    setMarquee({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
  };

  const byId = new Map(state.nodes.map((n) => [n.id, n]));
  const nodeById = (id: string) => byId.get(id);

  // The cards and the pipes are memoized (NodeCardView, WireView); what
  // they may ask of the editor goes through one object for the editor's
  // life, each call reaching the latest render's handler, so their
  // props stay equal while another card is dragged.
  const latest = useRef<CardActs | null>(null);
  latest.current = {
    nodeDown: onNodeDown,
    inputDown: onInputDown,
    wireDown: beginWireDrag,
    openGroup: (id) => {
      // The viewport rides along so entering auto-frames the group's
      // contents; the reducer stashes the view and leaving restores it.
      const r = surface.current?.getBoundingClientRect();
      dispatch({ type: "open_group", id, ...(r && r.width > 0 ? { frame: { w: r.width, h: r.height } } : {}) });
    },
    wireEnter: (w) => setHoverWire(w),
    wireLeave: () => setHoverWire(null),
    wireHitDown: (ev, w, from, to) => {
      if (!isPrimaryPress(ev)) return;
      ev.stopPropagation();
      const q = localPoint(ev);
      const head = portCenter(to, w.toPort);
      const tail = outCenter(from, w.fromPort);
      const dHead = Math.hypot(q.x - head.x, q.y - head.y);
      const dTail = Math.hypot(q.x - tail.x, q.y - tail.y);
      if (dHead < 26 && w.kind !== "group") {
        beginWireDrag(ev, w.from, w.kind === "mask" ? "mask" : "image", w, w.fromPort);
      } else if (dTail < 26 && w.kind !== "group") {
        beginTailDrag(ev, w);
      } else {
        setPickedWire(w);
        // Delete now means this wire, unambiguously: a lingering node
        // selection would make the same key delete nodes too.
        dispatch({ type: "select_nodes", ids: [] });
      }
    },
  };
  const acts = React.useMemo<CardActs>(
    () => ({
      nodeDown: (e, n) => latest.current!.nodeDown(e, n),
      inputDown: (e, n, toPort, kind) => latest.current!.inputDown(e, n, toPort, kind),
      wireDown: (e, from, kind, pickedUp, fromPort) => latest.current!.wireDown(e, from, kind, pickedUp, fromPort),
      openGroup: (id) => latest.current!.openGroup(id),
      wireEnter: (w) => latest.current!.wireEnter(w),
      wireLeave: () => latest.current!.wireLeave(),
      wireHitDown: (e, w, from, to) => latest.current!.wireHitDown(e, w, from, to),
    }),
    [],
  );

  // The source card's file name, read off the session rather than
  // stored on the card, since the card is the same template on every
  // photo and the file is not ("Shouldn't Image Source
  // show the source file?").
  const activeSrc = state.images.find((i) => i.id === state.activeImage)?.src;
  // The smart models' standing, for a Smart Mask card's note; asked
  // only when the graph holds one, and again on the way back from
  // Preferences, where the model installs.
  const smartModels = useSmartModels(
    state.nodes.some((n) => n.type === "heeler.smart_mask"),
    state.prefsOpen,
  );
  const cardFile =(n: NodeCard): string | undefined =>
    n.type === "heeler.image_source"
      ? state.images.find((i) => i.id === state.activeImage)?.name
      : n.type === "heeler.file"
        ? (n.textParams?.path ?? "").split(/[\\/]/).pop() || "No file"
        : n.type === "heeler.catalog"
          ? state.images.find((i) => i.id === n.textParams?.image)?.name ??
            (n.textParams?.image ? catalogNames.get(n.textParams.image) ?? "Another folder" : "No photo")
          : undefined;

  // The rough picture filter on a card without an engine thumbnail walks
  // the card's upstream chain (nodeThumbFilter), which reads the pipes
  // and the cards' settings and never their places. Kept across renders
  // while those hold, so a card drag, a pan or a marquee does not walk
  // every chain again (a 253-card chain is ~2.7 million steps).
  const filterMemo = useRef<{ wires: Wire[] | null; nodes: Map<string, NodeCard>; out: Map<string, string> }>({
    wires: null,
    nodes: new Map(),
    out: new Map(),
  });
  {
    const f = filterMemo.current;
    let keep = f.wires === state.wires && f.nodes.size === byId.size;
    if (keep) {
      for (const n of state.nodes) {
        const was = f.nodes.get(n.id);
        if (was !== n && (!was || !samePlaceless(was, n))) {
          keep = false;
          break;
        }
      }
    }
    if (!keep) f.out.clear();
    f.wires = state.wires;
    f.nodes = byId;
  }
  const thumbFilter = (n: NodeCard): string => {
    const f = filterMemo.current;
    let v = f.out.get(n.id);
    if (v === undefined) {
      v = nodeThumbFilter(state, n);
      f.out.set(n.id, v);
    }
    return v;
  };

  return (
    <div
      style={{ flex: 1, minHeight: overlay ? 0 : GRAPH_MIN_HEIGHT, background: overlay ? "transparent" : "var(--bg-graph)", borderTop: overlay ? "none" : "1px solid var(--line-hard)", display: "flex", position: "relative" }}
      data-testid="node-editor"
    >
      {!overlay && (
        <div style={{ width: 34, flex: "none", background: "#181716", borderRight: "1px solid var(--line-hard)", display: "flex", flexDirection: "column", alignItems: "center", paddingTop: 8, gap: 9 }}>
          {/* This button used to have no onClick at all: an add button
              that added nothing. It opens the ADD palette (the same one
              Shift+Space and Node > Find a Node open), not the / search:
              / finds and selects nodes that already exist, and an "Add
              node" button that only selects would be a second lie. */}
          <button
            style={{ all: "unset", cursor: "pointer", width: 22, height: 22, display: "flex", alignItems: "center", justifyContent: "center", border: "1px solid var(--line-3)" }}
            aria-label="Add node"
            data-testid="palette-add"
            data-hint="Add a node (Shift+Space)"
            onClick={() => dispatch({ type: "open_palette" })}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#9ea2a5" strokeWidth="2.2">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
          {/* The color key, and a door: each glyph says which stripe its color is
in the status bar, and opens the ADD palette narrowed to that
category (the owner asked what they were for; a key nobody could
read was not for much). Groups have no palette entry, since a group
is made from a selection.*/}
          {PALETTE.map((p) => {
            const addable = p.cat !== "group";
            const hint =
              p.cat === "group"
                ? "Groups wear this stripe. Make one from a selection (Ctrl+G)"
                : `${p.label} nodes wear this stripe. Click to add one`;
            return (
              <span key={p.cat} data-hint={hint} style={{ display: "inline-flex" }}><button
                key={p.cat}
                aria-label={p.label}
                data-testid={`legend-${p.cat}`}
                data-hint={hint}
                disabled={!addable}
                onClick={() => dispatch({ type: "open_palette", cat: p.cat as Category })}
                style={{ all: "unset", cursor: addable ? "pointer" : "default", width: 22, height: 22, display: "flex", alignItems: "center", justifyContent: "center" }}
              >
                <div style={{ width: 12, height: 12, border: `1.5px solid ${CAT_COLOR[p.cat]}`, borderRadius: p.cat === "masking" ? "50%" : 0 }} />
              </button></span>
            );
          })}
          {onPopOut && (
            <button
              style={{ all: "unset", cursor: "pointer", width: 22, height: 22, marginTop: "auto", marginBottom: 8, display: "flex", alignItems: "center", justifyContent: "center", border: "1px solid var(--line-3)" }}
              aria-label="Pop the graph out to its own window"
              data-hint="Pop the graph out to its own window"
              data-testid="graph-popout"
              onClick={(e) => onPopOut(e.currentTarget)}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#9ea2a5" strokeWidth="2.2">
                <path d="M14 4h6v6M20 4l-8 8" />
                <path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
              </svg>
            </button>
          )}
        </div>
      )}

      <div
        ref={(el) => {
          surface.current = el;
          navRef.current = el;
        }}
        style={{
          flex: 1, position: "relative", overflow: "hidden",
          backgroundColor: overlay ? "transparent" : "var(--bg-graph)",
          backgroundImage: overlay ? "none" : "radial-gradient(#232120 1px, transparent 1px)",
          // The dot grid rides along with the pan so motion reads clearly.
          backgroundSize: `${22 * state.graphView.zoom}px ${22 * state.graphView.zoom}px`,
          backgroundPosition: `${state.graphView.x}px ${state.graphView.y}px`,
          ...(spacePan.held ? { cursor: "grab" } : {}),
        }}
        // Capture-phase, so a held space pans instead of dragging a
        // node or starting a marquee. In Canvas the photo layer's own
        // capture handler sits outside this one and wins, which keeps
        // "SPACE DRAG, pan photo" true there.
        onMouseDownCapture={spacePan.onMouseDown}
        onPointerDownCapture={spacePan.onPointerDown}
        onMouseDown={onSurfaceDown}
        onMouseMove={onMove}
        onMouseUp={onUp}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu(screenPoint(e));
          // Add > Recipes lists the recipes folder as it is now, the
          // same read the palette makes when it opens.
          void refreshRecipeFiles(dispatch).catch(() => {});
        }}
        data-testid="graph-surface"
      >
      <div
        data-testid="graph-viewport"
        style={{
          position: "absolute",
          inset: 0,
          transform: `translate(${state.graphView.x}px, ${state.graphView.y}px) scale(${state.graphView.zoom / restZoom})`,
          transformOrigin: "0 0",
        }}
      >
      <div data-testid="graph-zoom-layer" style={{ position: "absolute", inset: 0, zoom: restZoom }}>
        {!overlay &&
          state.backdrops.map((b) => (
            <BackdropBox key={b.id} backdrop={b} dispatch={dispatch} surface={surface} zoom={state.graphView.zoom} />
          ))}

        <svg style={{ position: "absolute", inset: 0, width: "100%", height: "100%", overflow: "visible", pointerEvents: "none" }} fill="none">
          {state.wires.map((w, i) => {
            const from = nodeById(w.from);
            const to = nodeById(w.to);
            if (!from || !to) return null;
            const same = (a: Wire | null) =>
              !!a && a.from === w.from && a.to === w.to && a.toPort === w.toPort;
            // The pipe in hand is drawn by the ghost below, not here.
            if (wireDrag?.lifted && same(wireDrag.lifted)) return null;
            const c = wireColor(w, selected);
            return (
              <WireView
                key={i}
                w={w}
                from={from}
                to={to}
                stroke={c.stroke}
                width={c.width}
                dash={c.dash}
                isShaped={shaped.has(w.from) && w.kind !== "mask"}
                isDrop={same(dropWire)}
                isPicked={same(pickedWire)}
                isHover={same(hoverWire)}
                acts={acts}
              />
            );
          })}
          {/* The pipe in hand, and where it would land. */}
          {wireDrag && <WireGhost drag={wireDrag} nodes={state.nodes} />}
        </svg>

        {/* The head of every mask pipe is a handle: drag it to another node to
reassign the mask, or to nothing to take it off. It sits exactly on
the card's mask input (portCenter's seat), over it: placed a few
pixels lower it showed as a second diamond half off the first. The
report: "there is a second diamond that overlaps the mask input and
just looks odd."*/}
        {state.wires
          .filter((w) => w.kind === "mask" && (w.toPort === "mask" || w.toPort === "alpha" || w.toPort === "depth") && w !== wireDrag?.lifted)
          .map((w) => {
            const to = state.nodes.find((k) => k.id === w.to);
            if (!to) return null;
            // On the port it heads for (26.3 Phase 10.3 added the depth
            // input beside the mask one): portCenter's seat, minus half
            // the handle.
            const head = portCenter(to, w.toPort as "mask" | "alpha" | "depth");
            return (
              <div
                key={`head-${w.from}-${w.to}-${w.toPort}`}
                className="port mask"
                data-testid={`mask-head-${w.to}`}
                data-hint="Drag to move this mask to another node, or to empty space to remove it"
                onMouseDown={(ev) => beginWireDrag(ev, w.from, "mask", w, w.fromPort)}
                onPointerDown={(ev) => { if (ev.pointerType !== "mouse") beginWireDrag(ev, w.from, "mask", w, w.fromPort); }}
                style={{ touchAction: "none",
                  position: "absolute",
                  left: to.x + (head.x - to.x) - 4,
                  top: to.y + (head.y - to.y) - 4,
                  background: "#8b6fc4",
                  cursor: "grab",
                  zIndex: 1,
                }}
              />
            );
          })}
        {state.nodes.map((n) => {
          // Everything a card shows that is not on the card itself,
          // worked out here as plain values so the memo holds.
          const candidate = !!wireDrag && dropFits(wireDrag, n);
          const ins = wireDrag?.from !== undefined ? seatsFrom(wireDrag.kind, wireDrag.from, n, wireDrag.lifted) : [];
          const aimed = wireDrag?.hover === n.id && wireDrag.hoverSeat && ins.includes(wireDrag.hoverSeat) ? wireDrag.hoverSeat : "";
          const thumbsOff = !n.enabled || openedForThumbs?.enabled === false;
          const engineThumb = thumbsOff ? undefined : nodeThumbStore.get(`${state.activeImage}:${n.id}`);
          const plain = !thumbsOff && !engineThumb && n.type !== "heeler.file" && n.type !== "heeler.catalog";
          return (
            <NodeCardView
              key={n.id}
              n={n}
              selected={selected.has(n.id)}
              wireTarget={wireDrag?.hover === n.id}
              wireCandidate={candidate}
              litIn={ins.join(" ")}
              aimedIn={aimed}
              litOut={wireDrag?.to !== undefined && candidate ? sourceSeat(wireDrag.kind, n)?.seat ?? "" : ""}
              file={cardFile(n)}
              thumbsOff={thumbsOff}
              engineThumb={engineThumb}
              photoSrc={
                n.type === "heeler.catalog"
                  ? state.images.find((i) => i.id === n.textParams?.image)?.src
                  : activeSrc
              }
              thumbFilter={plain ? thumbFilter(n) : ""}
              writesDepth={exportWritesDepth(n, state.wires)}
              smartNote={smartCardNote(n, smartModels)}
              acts={acts}
            />
          );
        })}

        {marquee && (
          <div
            style={{
              position: "absolute",
              left: Math.min(marquee.x0, marquee.x1),
              top: Math.min(marquee.y0, marquee.y1),
              width: Math.abs(marquee.x1 - marquee.x0),
              height: Math.abs(marquee.y1 - marquee.y0),
              border: "1px dashed var(--accent)",
              background: "rgba(53,184,224,.06)",
              pointerEvents: "none",
            }}
          />
        )}
      </div>
      </div>

        {/* Screen-space overlays: these sit on the surface, not on the
            graph plane, so they hold still while the graph pans and
            zooms under them. */}
        {state.notice && (
          <div
            className="ctx-menu chrome-scale"
            data-testid="graph-notice"
            style={{
              position: "absolute",
              left: "50%",
              transform: "translateX(-50%)",
              bottom: 16,
              // 1.25x (2026-10-02: scale up the warning text and the graph status
              // line): 11 to 13.75, its padding with it.
              padding: "7.5px 16.25px",
              fontSize: 13.75,
              color: "var(--accent)",
              zIndex: 55,
              pointerEvents: "none",
            }}
          >
            {state.notice.text}
          </div>
        )}
        {state.graphSearchOpen && (
          <div
            className="ctx-menu chrome-scale"
            data-testid="graph-search"
            style={{ position: "absolute", left: 14, top: 14, width: 230, padding: 7, zIndex: 50 }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <input
              autoFocus
              data-testid="graph-search-input"
              aria-label="Find nodes by name"
              placeholder="Find nodes… (* and ? work)"
              value={search}
              onChange={(e) => {
                const q = e.target.value;
                setSearch(q);
                // Selection follows the query as it is typed, the same
                // matcher the thumbnail filter uses, so the two
                // searches cannot disagree about what "gra*" means.
                if (q.trim()) {
                  const hits = state.nodes
                    .filter((n) => nameMatches(q, n.name) || nameMatches(q, n.id))
                    .map((n) => n.id);
                  dispatch({ type: "select_nodes", ids: hits });
                }
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === "Escape") {
                  if (e.key === "Escape") dispatch({ type: "select_nodes", ids: [] });
                  dispatch({ type: "toggle_graph_search", open: false });
                  setSearch("");
                }
                e.stopPropagation();
              }}
              style={{
                width: "100%",
                boxSizing: "border-box",
                background: "var(--bg-app)",
                border: "1px solid var(--line-4)",
                color: "var(--text-body)",
                fontSize: 11,
                padding: "4px 7px",
              }}
            />
          </div>
        )}

        {renaming && (
          <div
            className="ctx-menu chrome-scale"
            data-testid="rename-node"
            style={{ left: renameAt.x, top: renameAt.y, width: 216, padding: 8 }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <input
              autoFocus
              data-testid="rename-node-input"
              aria-label={renaming.recipe ? "Recipe name" : "Node name"}
              placeholder={renaming.recipe ? "Recipe name" : undefined}
              value={renaming.name}
              onChange={(e) => setRenaming({ ...renaming, name: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  // An empty name would leave a card with nothing on it, so
                  // it closes without renaming rather than doing that.
                  if (renaming.name.trim()) {
                    dispatch(renaming.recipe
                      ? { type: "save_recipe", id: renaming.id, name: renaming.name.trim() }
                      : { type: "rename_node", id: renaming.id, name: renaming.name.trim() });
                  }
                  setRenaming(null);
                }
                if (e.key === "Escape") setRenaming(null);
                e.stopPropagation();
              }}
              onBlur={() => setRenaming(null)}
              style={{
                width: "100%",
                boxSizing: "border-box",
                background: "var(--bg-app)",
                border: "1px solid var(--line-4)",
                color: "var(--text-body)",
                fontSize: 11,
                padding: "3px 6px",
                outline: "none",
              }}
            />
          </div>
        )}
        {menu && createPortal(
          <MenuSurface aria-label="Graph commands"
            ref={menuRef}
            className="ctx-menu chrome-scale"
            style={{
              position: "fixed",
              left: menuBox?.x ?? -9999,
              top: menuBox?.y ?? 0,
              ...(menuBox?.cap ? { maxHeight: menuBox.cap, overflowY: "auto" as const } : {}),
            }}
            data-testid="context-menu"
            // Without this, mousedown bubbles to the surface, which closes
            // the menu before the button's click can fire.
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="hd">{state.selection.length || "NO"} NODE{state.selection.length === 1 ? "" : "S"} SELECTED</div>
            <div className="sep" />
            {/* Adding a node is the commonest thing anyone wants from a
                right click on empty canvas, and it drops where the click
                was rather than in the middle of the view. */}
            <button
              data-testid="menu-add-search"
              onClick={() => {
                dispatch({ type: "open_palette", x: menu.x, y: menu.y });
                setMenu(null);
              }}
            >
              Find a Node…
            </button>
            <GraphSubMenu label="Add" testid="menu-add">
              {/* Category, then section, then node (2026-10-01: the long
categories split into sections). Every list scrolls when the
window cannot hold it.*/}
              {menuTree().map((family) => (
                <GraphSubMenu key={family.cat} label={family.label} testid={`menu-add-${family.cat}`}>
                  {family.sections.map((section) => (
                    <GraphSubMenu key={section.id} label={section.label} testid={`menu-add-section-${section.id}`}>
                      {section.nodes.map((spec) => (
                        <button
                          key={spec.type}
                          data-testid={`menu-add-${spec.type.replace("heeler.", "")}`}
                          onClick={() => {
                            addNodeAt(state, dispatch, spec, menu.x, menu.y);
                            setMenu(null);
                          }}
                        >
                          {spec.name}
                        </button>
                      ))}
                    </GraphSubMenu>
                  ))}
                </GraphSubMenu>
              ))}
              {/* Node recipes (2026-09-30): the palette's Recipes
                  section, mirrored (the same list, paletteRecipes), each
                  one a group dropped where the click was. A recipe file
                  that cannot be read is listed grayed, as in the palette,
                  its reason on the status line. */}
              <GraphSubMenu label="Recipes" testid="menu-add-recipes">
                {paletteRecipes("", state.userRecipes).map((r) => (
                  <button
                    key={r.id}
                    data-testid={`menu-add-recipe-${r.id}`}
                    data-hint={r.error ?? r.blurb}
                    disabled={!!r.error}
                    style={r.error ? { opacity: 0.4 } : undefined}
                    onClick={() => {
                      if (r.error) return;
                      addRecipeAt(state, dispatch, r, menu.x, menu.y);
                      setMenu(null);
                    }}
                  >
                    {r.name}
                  </button>
                ))}
              </GraphSubMenu>
            </GraphSubMenu>
            <div className="sep" />
            {/* "We should be able to rename nodes tho." The command
existed and this button only closed the menu, so the one thing it
named was the one thing it did not do.*/}
            <button
              data-testid="menu-rename"
              onClick={() => {
                const target = state.nodes.find((n) => state.selection.includes(n.id));
                if (target) {
                  setRenameAt({ x: menu.x, y: menu.y });
                  setRenaming({ id: target.id, name: target.name });
                }
                setMenu(null);
              }}
              disabled={state.selection.length !== 1}
              style={state.selection.length !== 1 ? { opacity: 0.4 } : undefined}
            >
              Rename…
            </button>
            {/* Color, compositor-style organization: a small fixed palette
                rather than a picker, because the job is telling groups
                of nodes apart at a glance, not matching a brand. */}
            <div
              style={{ display: "flex", alignItems: "center", gap: 5, padding: "4px 10px" }}
              data-testid="menu-tint-row"
            >
              {TINTS.map((t) => (
                <button
                  key={t}
                  data-testid={`menu-tint-${t.slice(1)}`}
                  aria-label={`Color nodes ${t}`}
                  onClick={() => {
                    state.selection.forEach((id) => dispatch({ type: "set_node_tint", id, tint: t }));
                    setMenu(null);
                  }}
                  style={{
                    all: "unset",
                    cursor: "pointer",
                    width: 14,
                    height: 14,
                    background: t,
                    border: "1px solid var(--line-4)",
                  }}
                />
              ))}
              <button
                data-testid="menu-tint-clear"
                aria-label="Clear node color"
                onClick={() => {
                  state.selection.forEach((id) => dispatch({ type: "set_node_tint", id, tint: null }));
                  setMenu(null);
                }}
                style={{
                  all: "unset",
                  cursor: "pointer",
                  width: 14,
                  height: 14,
                  border: "1px solid var(--line-4)",
                  position: "relative",
                  overflow: "hidden",
                }}
              >
                <span style={{ position: "absolute", left: -2, top: 5, width: 18, height: 1, background: "var(--reject)", transform: "rotate(-45deg)" }} />
              </button>
            </div>
            <button
              onClick={() => {
                state.selection.forEach((id) => {
                  const n = nodeById(id);
                  if (n) dispatch({ type: "set_enabled", id, enabled: !n.enabled });
                });
                setMenu(null);
              }}
            >
              Disable
            </button>
            {/* The old dead "View this node's output" promise, finally paid: a
stage probe. The viewer shows this node's output and the scopes
read it, because they read whatever is on screen.*/}
            <button
              data-testid="menu-probe-node"
              disabled={state.selection.length !== 1}
              data-hint="Show this node's output in the viewer; the scopes read it too"
              onClick={() => {
                dispatch({ type: "probe_node", id: state.selection[0] });
                setMenu(null);
              }}
            >
              {state.selection.length === 1 && state.probeNode === state.selection[0]
                ? "Stop probing"
                : "Probe output"}
            </button>
            {/* Branch A/B (proposal §5): two graph points side by side
                in the viewer split. Two nodes selected compares them
                outright; one node arms A, and the next node's menu
                completes the pair. */}
            <button
              data-testid="menu-ab-compare"
              disabled={state.selection.length === 0 || state.selection.length > 2}
              data-hint="Show two branches side by side in the viewer; drag the divider to compare"
              onClick={() => {
                if (state.abCompare?.b) {
                  dispatch({ type: "ab_compare", value: null });
                } else if (state.selection.length === 2) {
                  dispatch({
                    type: "ab_compare",
                    value: { a: state.selection[0], b: state.selection[1] },
                  });
                } else if (state.abCompare && state.abCompare.b === null) {
                  dispatch({
                    type: "ab_compare",
                    value:
                      state.abCompare.a === state.selection[0]
                        ? null
                        : { a: state.abCompare.a, b: state.selection[0] },
                  });
                } else {
                  dispatch({ type: "ab_compare", value: { a: state.selection[0], b: null } });
                }
                setMenu(null);
              }}
            >
              {state.abCompare?.b
                ? "Stop comparing"
                : state.selection.length === 2
                  ? "Compare these two (A/B)"
                  : state.abCompare && state.abCompare.b === null
                    ? state.abCompare.a === state.selection[0]
                      ? "Disarm compare"
                      : `Compare against ${nodeById(state.abCompare.a)?.name ?? "A"} (B)`
                    : "Compare from here (A)"}
            </button>
            {/* The bake (proposal §5): everything from the source to
                this node, written as a .cube any grading tool can load.
                Spatial branches and masks are refused with words. */}
            <button
              data-testid="menu-bake-lut"
              disabled={state.selection.length !== 1}
              data-hint="Write the branch ending here as a .cube LUT; color work only: spatial effects and masks cannot ride a LUT"
              onClick={() => {
                const id = state.selection[0];
                setMenu(null);
                void bakeLut(state, id)
                  .then((path) => {
                    if (path) logMsg("info", `Baked LUT: ${path}`);
                  })
                  .catch((err) => logMsg("error", String(err)));
              }}
            >
              Bake branch to LUT…
            </button>
            <button
              data-testid="menu-reset"
              disabled={state.selection.length === 0}
              data-hint="Every dial and choice on the selected nodes back to its defaults; strokes and switches stay"
              onClick={() => {
                for (const id of state.selection) {
                  const n = state.nodes.find((k) => k.id === id);
                  if (n && !n.isGroup) dispatch({ type: "reset_node", id, ...nodeResetValues(n) });
                }
                setMenu(null);
              }}
            >
              Reset
            </button>
            <button
              data-testid="menu-duplicate"
              disabled={!state.selection.some(duplicable)}
              data-hint="Copy the selected nodes, offset, with the wires among them"
              data-hint-cmd="edit.duplicate"
              onClick={() => {
                dispatch({ type: "duplicate_nodes", ids: state.selection });
                setMenu(null);
              }}
            >
              Duplicate
            </button>
            <button
              data-hint="Delete; neighbors reconnect per Preferences, SHIFT inverts"
              onClick={(e) => {
                dispatch({
                  type: "delete_nodes",
                  ids: state.selection,
                  // SHIFT inverts whichever way the preference points.
                  heal: state.deleteHeals !== e.shiftKey,
                });
                setMenu(null);
              }}
            >
              Delete
            </button>
            <div className="sep" />
            <button
              disabled={state.selection.length < 2}
              onClick={() => {
                dispatch({ type: "open_group_dialog", open: true });
                setMenu(null);
              }}
              data-testid="menu-save-group"
            >
              <GroupGlyph size={11} />
              Save selection as group…
            </button>
            {(() => {
              const group = state.selection.length === 1 ? nodeById(state.selection[0]) : undefined;
              const ok = savableAsRecipe(group);
              return (
                <button
                  data-testid="menu-save-recipe"
                  disabled={!ok}
                  style={!ok ? { opacity: 0.4 } : undefined}
                  data-hint="Keep this group as a recipe: it lists in the node palette, ready to drop into any graph"
                  onClick={() => {
                    if (group && ok) {
                      setRenameAt({ x: menu.x, y: menu.y });
                      setRenaming({ id: group.id, name: group.name, recipe: true });
                    }
                    setMenu(null);
                  }}
                >
                  Save as Recipe…
                </button>
              );
            })()}
            <div className="sep" />
            <button
              data-testid="menu-add-backdrop"
              onClick={() => {
                // Around the selection when there is one, else at the click.
                const sel = state.nodes.filter((n) => state.selection.includes(n.id));
                const next =
                  Math.max(0, ...state.backdrops.map((b) => Number(b.id.replace("bd_", "")) || 0)) + 1;
                const backdrop =
                  sel.length > 0
                    ? {
                        id: `bd_${next}`,
                        name: `Backdrop ${next}`,
                        x: Math.min(...sel.map((n) => n.x)) - 24,
                        y: Math.min(...sel.map((n) => n.y)) - 40,
                        w: Math.max(...sel.map((n) => n.x + NODE_W)) - Math.min(...sel.map((n) => n.x)) + 48,
                        h: Math.max(...sel.map((n) => n.y + NODE_H)) - Math.min(...sel.map((n) => n.y)) + 64,
                        color: state.backdrops.length % BACKDROP_COLORS.length,
                      }
                    : {
                        id: `bd_${next}`,
                        name: `Backdrop ${next}`,
                        x: menu.x,
                        y: menu.y,
                        w: 340,
                        h: 220,
                        color: state.backdrops.length % BACKDROP_COLORS.length,
                      };
                dispatch({ type: "add_backdrop", backdrop });
                setMenu(null);
              }}
            >
              Add backdrop
            </button>
            {/* "Could probably use some sort of auto arrange tools in the
graph view context menu." It was already here, under a name that
described the old algorithm rather than what it does for you.*/}
            <button
              data-testid="menu-arrange"
              data-hint="Lay every node out left to right, so no wire doubles back"
              onClick={() => {
                dispatch({ type: "arrange_nodes" });
                setMenu(null);
              }}
            >
              Auto-arrange
            </button>
            <button
              data-testid="menu-reset-view"
              onClick={() => {
                dispatch({ type: "reset_graph_view" });
                setMenu(null);
              }}
            >
              Reset view
            </button>
            {/* "View this node's output" used to close this menu doing
                nothing: a button whose whole action was setMenu(null).
                Viewing an intermediate is a real feature (it needs the
                engine to render up to an arbitrary node, not just the
                terminal), and a dead promise of it is worse than its
                absence. */}
          </MenuSurface>,
          document.body,
        )}

        {/* Bottom-left in Graph mode, centered when floating over a photo:
            the viewer prints its own readout in that corner, and the two
            landed on top of each other. */}
        <div
          data-testid="graph-footer"
          style={{
            // 1.25x (2026-10-02), like the hints on the right.
            position: "absolute", bottom: 10, display: "flex", alignItems: "center", gap: 15,
            fontSize: 11.25, letterSpacing: ".16em", color: "var(--text-ghost)",
            ...(overlay ? { left: 0, right: 0, justifyContent: "center" } : { left: 12 }),
          }}
        >
          {opened ? (
            <button
              data-testid="leave-group"
              onClick={() => dispatch({ type: "open_group", id: null })}
              style={{
                all: "unset", cursor: "pointer", color: "var(--accent)",
                letterSpacing: ".16em", fontSize: 11.25,
              }}
            >
              {"‹ MAIN GRAPH · "}{opened.name.toUpperCase()}
            </button>
          ) : (
            <span style={{ color: "var(--text-dim)" }}>MAIN GRAPH</span>
          )}
          <span className="tnum">{state.nodes.length} NODES</span>
          {state.selection.length > 0 && <span style={{ color: "var(--accent)" }}>{state.selection.length} SELECTED</span>}
        </div>
        {!overlay && (
          <GraphHints>
            {/* Inherits the row, like the two hints beside it. It was
                carrying a leftover gray at 1.5:1, which is a line of
                help nobody could read. */}
            <span>{modLabel("alt")} + scroll, zoom graph</span>
            {/* Shift+Space is the add-node key (node.palette); Tab was
                never bound, and a tour step naming Shift+Space sat
                over a hint naming Tab (2026-09-29). */}
            <span>SHIFT + Space, add node</span>
            <span className="tnum">100%</span>
          </GraphHints>
        )}
      </div>
    </div>
  );
}


/** Node types with a hand-built editor below. Anything not listed falls
 * back to plain sliders for whatever numeric params it has, so a node
 * can never open an empty panel just because nobody wrote a case for
 * it. Split Tone and Tone Profile did exactly that for months. */
const CUSTOM_PARAM_TYPES = new Set([
  "heeler.hue_range_mask", "heeler.color_grade",
  "heeler.color_balance", "heeler.curves", "heeler.levels", "heeler.black_white",
  "heeler.crop_rotate", "heeler.brush_mask", "heeler.range_mask", "heeler.radial_mask",
  // "Size -50? What is that?" Grain, Sharpen and Denoise used to
  // be in here with hand-written panels that named grain_amount, grain_size
  // and sharpening: params the engine has never read, and which no longer
  // even have a range, so they fell back to -100..100 and offered a negative
  // grain size. They render from their own declared params now, like any
  // node without a gizmo, which is also the only way they cannot drift away
  // from the engine a third time.
  "heeler.linear_mask", "heeler.image_source", "heeler.file",
  // The Levels widget on its window, LuminanceMaskControls.
  "heeler.luminance_range_mask",
  "heeler.exposure", "heeler.standard_color", "heeler.detail", "heeler.split_tone",
  "heeler.tone_profile", "heeler.color_bend", "heeler.tone_eq", "heeler.recolor", "heeler.color_console",
  // Develop's Smart layer controls aimed at the node (smartnode.tsx):
  // the generic Mode menu wrote a mode and never ran the model.
  "heeler.smart_mask",
]);

/** Params that are plumbing rather than controls: shown elsewhere, or
 * driven by a gizmo instead of a number. */
const HIDDEN_PARAMS = new Set(["opacity", "invert", "points", "strokes", "mask_off"]);

/** The Depth mask block's params: one widget (DepthMaskBlock) writes
 * them all, so the generic rows leave them to it. */
const DEPTH_BLOCK_PARAMS = new Set(["depth_on", "depth_invert", "depth_black", "depth_white", "depth_gamma", "depth_black_soft", "depth_white_soft"]);

/** Which of Develop's mask block rows a mask node's face adds at its
 * foot: Invert where the type declares one (the Luminance Mask and the
 * Smart Mask seat theirs in their own faces), and the Depth mask block
 * where it declares depth_on. */
export function maskFoot(type: string): { invert: boolean; depth: boolean } {
  const declared = REGISTRY_DEFAULTS[type] ?? {};
  const own = type === "heeler.smart_mask" || type === "heeler.luminance_range_mask";
  const isMask = type.endsWith("_mask");
  return {
    invert: isMask && !own && "invert" in declared,
    depth: isMask && type !== "heeler.smart_mask" && "depth_on" in declared,
  };
}

/** Depth Lighting's Invert depth on its node: Develop seats it among the
 * section's tools (keylight-invert), and the node's face had none. */
function KeyLightInvertRow({ node, dispatch }: { node: NodeCard; dispatch: D }) {
  const on = (node.params.invert ?? 0) !== 0;
  const flip = () => dispatch({ type: "set_param", id: node.id, param: "invert", value: on ? 0 : 1 });
  return (
    <div data-node={node.id} data-param="invert" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", margin: "4px 0" }}>
      <div className="lbl" style={{ fontSize: 11, color: "var(--text-body)" }}>Invert depth</div>
      <div
        className="toggle"
        data-on={on}
        data-testid={`node-keylight-invert-${node.id}`}
        role="switch"
        aria-checked={on}
        aria-label="Invert depth"
        data-hint="Flip the depth: the BACKGROUND becomes the lit relief instead of the subject"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === " " || e.key === "Enter") {
            e.preventDefault();
            flip();
          }
        }}
        onClick={flip}
      >
        <div className="dot" />
      </div>
    </div>
  );
}

/** A choice param as a menu row: what the generic face draws for every
 * PARAM_OPTIONS entry, and what a custom face mounts for the choices
 * its own controls do not cover. */
function ParamChoiceRow({ node, param: p, value, dispatch }: { node: NodeCard; param: string; value: string; dispatch: D }) {
  const options = PARAM_OPTIONS[node.type]?.[p] ?? [];
  const label = p.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
  const hint = PARAM_CHOICE_HINTS[node.type]?.[p];
  return (
    <div className="srow" data-node={node.id} data-param={p} style={{ gridTemplateColumns: "78px 1fr" }}>
      <div className="lbl fit" title={hint ? undefined : label} data-tip={hint} data-hint={hint}>{label}</div>
      <MenuField
        testid={`node-option-${p}`}
        label={label}
        hint={hint}
        tip={hint}
        size="regular"
        value={value}
        options={options}
        fitLabels={options.map((o) => o.label)}
        onChange={(next) => dispatch({ type: "set_text_param", id: node.id, param: p, value: next })}
      />
    </div>
  );
}

/** Develop's names and order for the params of nodes that render
 * generically here, so both surfaces call the same dial the same
 * thing and list them the same way ("I should expect to
 * see the same size of controls, labels, and fonts in Graph and
 * Canvas"). Mirrors the labels in simple.tsx's SECTIONS; keep the two
 * in step. A param not listed for its type keeps the prettified name.*/
/** Flags whose name does not read as their label; the rest are the
 * name with its underscores as spaces. */
const FLAG_LABELS: Record<string, string> = {
  feather_guided: FEATHER_FOLLOWS_LABEL,
};

const DEVELOP_PARAM_LABELS: Record<string, Record<string, string>> = {
  "heeler.vignette": { vignette: "Amount", vignette_mid: "Midpoint", softness: "Softness" },
  "heeler.sharpen": { amount: "Unsharp", radius: "Radius", threshold: "Threshold" },
  "heeler.grain": {
    intensity: "Grain amount", size: "Grain size",
    shadows_gain: "Shadow grain", midtones_gain: "Midtone grain", highlights_gain: "Highlight grain",
    red_gain: "Red grain", green_gain: "Green grain", blue_gain: "Blue grain",
  },
  "heeler.fog": {
    density: "Density", start: "Start distance", falloff: "Falloff", fog_level: "Fog brightness",
    texture: "Texture", texture_size: "Texture size", texture_shift: "Texture shift",
    fog_hue: "Fog hue", fog_sat: "Fog color", desat: "Far desaturate",
  },
  "heeler.dof": {
    aperture: "Aperture", focus: "Focus distance", blades: "Blades", blade_curve: "Blade curve",
    fringe: "Fringing", field_curve: "Field curvature", glow: "Glow",
  },
  "heeler.lens_correct": {
    distortion: "Distortion", ca_red: "Fringe R/C", ca_blue: "Fringe B/Y",
    vignette: "Lens vignetting", vignette_mid: "Lens vig. range",
  },
};

/** Every control for one node, exactly as the Inspector shows them. The
 * Canvas settings popover renders these too, so a node offers the same
 * knobs wherever you open it and there is only one place to add a new
 * one. */
/** The LUT node's file line: which .cube is loaded, what it says it
 * is, and the chooser. The amount slider below stays the generic
 * editor's.*/
/** The engine's picture at each node, by "<image>:<node>". Filled by
 * the editor a beat after every render-affecting change; read by the
 * cards. Module-level so the popped-out graph window keeps its own. */
const nodeThumbStore = new Map<string, string>();
const NODE_THUMB_DELAY_MS = 300;

/** A File card's picture: the file itself, small, not the photograph
 * every other card shows ("File nodes should have their
 * own thumbnails"). Nothing chosen, or nothing decodable, shows an
 * empty frame with the words.*/
/** The least height the graph keeps under the viewer in Graph mode: on
 * a short window the viewer above gives way (it shrinks from its
 * dragged height) rather than leaving the graph a strip too thin for
 * its own tool column and footer. */
const GRAPH_MIN_HEIGHT = 200;

/** The graph's key hints, bottom right. On a graph too narrow for them
 * beside the node count they step aside rather than print over it. */
function GraphHints({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const clear = useClearsSibling(ref, "graph-footer");
  return (
    <div
      ref={ref}
      data-testid="graph-hints"
      style={{ position: "absolute", right: 12, bottom: 10, display: "flex", gap: 15, fontSize: 13.75, color: "var(--text-ghost)", letterSpacing: ".05em", whiteSpace: "nowrap", visibility: clear ? undefined : "hidden" }}
    >
      {children}
    </div>
  );
}

function FileThumb({ path }: { path: string }) {
  // Asked for on every mount and path change rather than remembered: the
  // desktop's answer is a cached downscale, and a file overwritten on
  // disk must show its new self the next time the card appears (the
  // render already keys on the file's modification time).
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setSrc(null);
    if (!path) return;
    void fileThumb(path).then((url) => {
      if (live && url) setSrc(url);
    });
    return () => {
      live = false;
    };
  }, [path]);
  if (src) return <img src={src} alt="" data-testid="file-thumb" />;
  return (
    <div
      data-testid="file-thumb-empty"
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: 9,
        letterSpacing: ".08em",
        textTransform: "uppercase",
        color: "var(--text-ghost)",
      }}
    >
      {path ? "Loading" : "No file"}
    </div>
  );
}

/** The Catalog node's control: which photograph. A picker over the
 * session's photos with a name filter ("having a search /
 * filter in Catalog picker might help"), the photo this graph belongs
 * to left out, since a picture cannot contain its own developed self.*/
/** The photos a Catalog node may name: the session's list, which one
 * is open, and the catalog's folders, which is all the picker needs of
 * the app state. */
export type PhotoSession = {
  images: State["images"];
  activeImage: string;
  folders?: State["folders"];
  activeFolderPath?: string | null;
  /** the Library tree's root, which is as far as Up goes */
  treeRoot?: string | null;
};

/** Names of catalog photographs the picker has met that are not in
 * the open folder, by id, so a Catalog card can name its photo. */
const catalogNames = new Map<string, string>();

/** Thumbnails the picker has fetched for photos outside the open
 * folder, by id. Session-long, like the File thumbs. */
const pickerThumbs = new Map<string, string>();

/** A thumbnail that asks for itself only once it is on screen: a folder
 * of a thousand photographs must not fire a thousand fetches on open. */
export function LazyThumb({ id, known }: { id: string; known?: string }) {
  const [src, setSrc] = useState<string | null>(known ?? pickerThumbs.get(id) ?? null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (src) return;
    let live = true;
    const fetch = () => {
      // A failed ask (an unreadable merge's graph, a catalog hiccup)
      // leaves the cell empty; an unhandled rejection would surface in
      // the console for every such cell, every mount.
      void loadThumbnail(id, 240)
        .catch(() => null)
        .then((url) => {
          if (!live || !url) return;
          pickerThumbs.set(id, url);
          setSrc(url);
        });
    };
    const el = box.current;
    if (!el || typeof IntersectionObserver === "undefined") {
      fetch();
      return () => {
        live = false;
      };
    }
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        io.disconnect();
        fetch();
      }
    });
    io.observe(el);
    return () => {
      live = false;
      io.disconnect();
    };
  }, [id, src]);
  return (
    <div ref={box} style={{ width: "100%", height: "100%", background: "#000" }}>
      {src && <img src={src} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />}
    </div>
  );
}

/** Which way the picker shows its photographs; remembered for the session. */
let pickerView: "grid" | "list" = "grid";

/** The folder above `path`, or null at the tree's root or outside it. */
export function parentFolder(path: string, root: string | null): string | null {
  const trim = (p: string) => (p.length > 1 ? p.replace(/[\\/]+$/, "") : p);
  const here = trim(path);
  const top = root ? trim(root) : null;
  const cut = Math.max(here.lastIndexOf("/"), here.lastIndexOf("\\"));
  if (cut <= 0) return null;
  const up = here.slice(0, cut);
  if (top !== null) {
    if (here === top) return null;
    // Inside the root means below it as a folder, not merely sharing its
    // first letters: /photos2 is not under /photos.
    const inside = up === top || up.startsWith(top + "/") || up.startsWith(top + "\\");
    if (!inside) return null;
  }
  return up;
}

function folderName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/** The Catalog node's control: which photograph. A browser that walks
 * the folders the way the Library tree does: it opens in the folder
 * on screen, Up goes to the parent, a subfolder row goes down, and
 * the photographs of the folder in view sit under its subfolders, as
 * a grid or a list, with a name filter ("Why can't I
 * press a button to go up a folder and see roughly the same thing I
 * see in TREE view?"). It reads the catalog and never opens a folder,
 * so the session stays where it is; a folder the catalog has not
 * scanned says so, and the Library is where it gets scanned, which is
 * also what builds its thumbnails. The photo this graph belongs to is
 * left out, since a picture cannot contain its own developed self.*/
function CatalogLine({ node, session, dispatch }: { node: NodeCard; session?: PhotoSession; dispatch: D }) {
  return (
    <CatalogChooser
      chosen={node.textParams?.image ?? ""}
      session={session}
      onPick={(id) => dispatch({ type: "set_text_param", id: node.id, param: "image", value: id })}
    />
  );
}

/** The Catalog node's chooser, and the "Image from Catalog" layer's
 * (Finish image layers, 2026-09-30): the same folder browser in both
 * seats. `embedded` shows the browser open, without the name line and
 * its Choose button, for a dialog that is itself the choosing. */
export function CatalogChooser({
  chosen,
  session,
  onPick,
  embedded = false,
}: {
  chosen: string;
  session?: PhotoSession;
  onPick: (id: string, name: string) => void;
  embedded?: boolean;
}) {
  const images = session?.images ?? [];
  const root = session?.treeRoot ?? null;
  const home = session?.activeFolderPath ?? root ?? "";
  const photo = images.find((i) => i.id === chosen);
  const [open, setOpen] = useState(embedded);
  const [query, setQuery] = useState("");
  const [folder, setFolder] = useState(home);
  const [view, setView] = useState<"grid" | "list">(pickerView);
  const [subfolders, setSubfolders] = useState<{ name: string; path: string }[] | null>(null);
  // null: still reading; "unscanned": the catalog has never seen it.
  const [listing, setListing] = useState<CatalogPhoto[] | "unscanned" | null>(null);
  const [chosenName, setChosenName] = useState<string | null>(null);
  const atHome = folder === home;
  // Opening lands in the folder on screen every time, and forgets the
  // thumbnails it fetched last time: a catalog thumbnail is the photo
  // with its edits, and those may have changed since.
  useEffect(() => {
    if (open) {
      setFolder(home);
      setQuery("");
      pickerThumbs.clear();
    }
  }, [open, home]);
  // The folder's subfolders, from the same listing the tree reads.
  useEffect(() => {
    if (!open || !folder) {
      setSubfolders(null);
      return;
    }
    let live = true;
    setSubfolders(null);
    void listSubfolders(folder).then((rows) => {
      if (live) setSubfolders(rows.map((r) => ({ name: r.name, path: r.path })));
    }).catch(() => {
      if (live) setSubfolders([]);
    });
    return () => {
      live = false;
    };
  }, [open, folder]);
  // The folder's photographs: the session's own when it is the folder
  // on screen, the catalog's record otherwise.
  useEffect(() => {
    if (!open || atHome || !folder) {
      setListing(null);
      return;
    }
    let live = true;
    setListing(null);
    void catalogFolderImages(folder).then((rows) => {
      if (live) setListing(rows ?? "unscanned");
    });
    return () => {
      live = false;
    };
  }, [open, atHome, folder]);
  // A chosen photo from another folder is not in the session's list;
  // its name is looked up once so the line can say it.
  useEffect(() => {
    if (!chosen || photo) {
      setChosenName(null);
      return;
    }
    let live = true;
    void catalogImages(null).then((rows) => {
      const name = rows.find((r) => r.id === chosen)?.name ?? null;
      if (name) catalogNames.set(chosen, name);
      if (live) setChosenName(name);
    });
    return () => {
      live = false;
    };
  }, [chosen, photo]);
  const candidates: { id: string; name: string; known?: string }[] = atHome
    ? images.filter((i) => !i.missing).map((i) => ({ id: i.id, name: i.name, known: i.src || undefined }))
    : (Array.isArray(listing) ? listing : []).map((r) => ({ id: r.id, name: r.name, known: images.find((i) => i.id === r.id)?.src || undefined }));
  const shown = candidates.filter((c) => c.id !== session?.activeImage && nameMatches(query, c.name));
  const label = photo?.name ?? chosenName ?? (chosen ? "Not in this catalog" : "No photograph chosen");
  const up = folder ? parentFolder(folder, root) : null;
  const pick = (id: string, name: string) => {
    catalogNames.set(id, name);
    onPick(id, name);
    if (!embedded) setOpen(false);
  };
  const field: React.CSSProperties = {
    fontSize: 10, padding: "3px 6px", background: "var(--bg-panel)", border: "1px solid var(--line-4)",
    color: "var(--text-body)", outline: "none",
  };
  const chip: React.CSSProperties = { fontSize: 9, padding: "1px 8px", flex: "none" };
  return (
    <div style={{ padding: embedded ? 0 : "6px 0 8px" }}>
      <div style={{ display: embedded ? "none" : "flex", alignItems: "center", gap: 6 }}>
        <div
          data-testid="catalog-node-name"
          style={{
            flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis",
            whiteSpace: "nowrap", fontSize: 10,
            color: photo || chosenName ? "var(--text-body)" : "var(--text-ghost)",
          }}
          data-hint={photo || chosenName ? label : chosen ? "That photograph is not in this catalog" : "No photograph chosen yet; the node outputs a transparent pixel"}
        >
          {label}
        </div>
        <button
          className="chip"
          data-testid="catalog-node-choose"
          style={chip}
          data-hint="Browse the folders for another photograph"
          onClick={() => setOpen((o) => !o)}
        >
          {open ? "CLOSE" : "CHOOSE…"}
        </button>
      </div>
      {open && (
        <div
          data-testid="catalog-picker"
          style={{ marginTop: 6, border: "1px solid var(--line-4)", background: "var(--bg-app)", padding: 6, display: "flex", flexDirection: "column", gap: 6 }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <button
              className="chip"
              data-testid="catalog-picker-up"
              aria-label="Up a folder"
              data-hint={up ? `Up to ${folderName(up)}` : "This is the top of the Library tree"}
              disabled={!up}
              style={{ ...chip, opacity: up ? 1 : 0.4 }}
              onClick={() => {
                if (up) setFolder(up);
              }}
            >
              ↑ UP
            </button>
            <div
              data-testid="catalog-picker-folder"
              title={folder}
              style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 10, color: "var(--text-body)" }}
            >
              {folder ? folderName(folder) : "This folder"}
            </div>
            {/* The same two glyphs the thumbnail ribbon switches with. */}
            <div className="zoom-seg" role="group" aria-label="Picker view" style={{ border: "1px solid var(--line-4)", flex: "none" }}>
              {(
                [
                  ["grid", "thumbs", "Thumbnails"],
                  ["list", "list", "List"],
                ] as const
              ).map(([id, shape, label]) => (
                <button
                  key={id}
                  data-active={view === id}
                  data-testid={`catalog-picker-view-${id}`}
                  aria-label={label}
                  data-hint={id === "grid" ? "Show each photograph as a picture" : "One row per photograph, with its name"}
                  style={{ fontSize: 9, padding: "1px 6px" }}
                  onClick={() => {
                    pickerView = id;
                    setView(id);
                  }}
                >
                  <ViewShapeIcon shape={shape} />
                </button>
              ))}
            </div>
          </div>
          <input
            data-testid="catalog-picker-search"
            aria-label="Find a photograph in this folder"
            placeholder="Find by name (* and ? match)"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
            style={{ ...field, width: "100%", boxSizing: "border-box" }}
          />
          <div data-testid="catalog-picker-list" style={{ maxHeight: 260, overflowY: "auto", display: "flex", flexDirection: "column", gap: 2 }}>
            {/* Subfolders first, the way the tree reads. */}
            {(subfolders ?? []).map((f) => (
              <button
                key={f.path}
                data-testid={`catalog-folder-${f.name}`}
                title={f.path}
                onClick={() => {
                  setFolder(f.path);
                  setQuery("");
                }}
                style={{ all: "unset", cursor: "pointer", display: "flex", alignItems: "center", gap: 6, padding: "3px 4px", fontSize: 10, color: "var(--text-hi)", background: "var(--bg-panel)" }}
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--text-dim)" strokeWidth="2">
                  <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                </svg>
                <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.name}</span>
              </button>
            ))}
            {!atHome && listing === "unscanned" ? (
              <div data-testid="catalog-picker-unscanned" style={{ fontSize: 13, color: "var(--text-dim)", padding: 6, lineHeight: 1.4 }}>
                Not scanned yet. Open this folder in the Library to scan it and build its thumbnails.
              </div>
            ) : !atHome && listing === null ? (
              <div style={{ fontSize: 13, color: "var(--text-dim)", padding: 6 }}>Reading the catalog…</div>
            ) : (
              <div
                data-testid="catalog-picker-photos"
                style={
                  view === "grid"
                    ? { display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 4 }
                    : { display: "flex", flexDirection: "column", gap: 2 }
                }
              >
                {shown.map((i) =>
                  view === "grid" ? (
                    <button
                      key={i.id}
                      data-testid={`catalog-pick-${i.id}`}
                      data-active={i.id === chosen}
                      title={i.name}
                      onClick={() => pick(i.id, i.name)}
                      style={{
                        all: "unset", cursor: "pointer", display: "block", aspectRatio: "3 / 2", overflow: "hidden",
                        outline: i.id === chosen ? "1px solid var(--accent)" : "1px solid var(--line-1)",
                        background: "#000",
                      }}
                    >
                      <LazyThumb id={i.id} known={i.known} />
                    </button>
                  ) : (
                    <button
                      key={i.id}
                      data-testid={`catalog-pick-${i.id}`}
                      data-active={i.id === chosen}
                      onClick={() => pick(i.id, i.name)}
                      style={{
                        all: "unset", cursor: "pointer", display: "flex", alignItems: "center", gap: 6, padding: "2px 4px",
                        background: "var(--bg-panel)",
                        borderLeft: `2px solid ${i.id === chosen ? "var(--accent)" : "transparent"}`,
                      }}
                    >
                      <div style={{ width: 36, height: 24, flex: "none", overflow: "hidden", background: "#111010" }}>
                        <LazyThumb id={i.id} known={i.known} />
                      </div>
                      <div style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 10, color: "var(--text-hi)" }}>
                        {i.name}
                      </div>
                    </button>
                  ),
                )}
                {shown.length === 0 && (
                  <div data-testid="catalog-picker-empty" style={{ gridColumn: "1 / -1", fontSize: 13, color: "var(--text-dim)", padding: 6 }}>
                    {query ? "Nothing by that name" : "No other photographs in this folder"}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** What a node with no dials is made of: its ports, what each is for,
 * and what feeds it. Conditional, Merge, Channel Join and the like
 * are all wiring, and an inspector that said "nothing to configure"
 * left them looking broken ("I am trying to use a
 * Conditional node but its empty").*/
function PortGuide({ node, wires, allNodes }: { node: NodeCard; wires: Wire[]; allNodes: NodeCard[] }) {
  const roles = PORT_ROLES[node.type] ?? {};
  const seats: { seat: "in" | "in2" | "in3" | "mask" | "alpha"; port: Wire["toPort"] }[] = [];
  if (node.hasIn) seats.push({ seat: "in", port: "in" });
  if (node.hasIn2) seats.push({ seat: "in2", port: "in2" });
  if (node.hasIn3) seats.push({ seat: "in3", port: "in3" });
  if (node.maskIn) seats.push({ seat: "mask", port: "mask" });
  if (node.alphaIn) seats.push({ seat: "alpha", port: "alpha" });
  const feedOf = (port: Wire["toPort"]) => {
    const w = wires.find((x) => x.to === node.id && x.toPort === port);
    return w ? allNodes.find((k) => k.id === w.from)?.name ?? w.from : null;
  };
  return (
    <div data-testid="port-guide" style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      <div style={{ fontSize: 10, color: "var(--text-faint)", lineHeight: 1.5 }}>
        This node has no dials: it is made of its wiring.
      </div>
      {seats.map(({ seat, port }) => {
        const feed = feedOf(port);
        const role = roles[seat];
        return (
          <div
            key={seat}
            data-testid={`port-guide-${seat}`}
            data-hint={portHint(node, seat).hint}
            style={{ display: "grid", gridTemplateColumns: "78px 1fr", gap: 6, alignItems: "baseline", fontSize: 10 }}
          >
            <div className="lbl" style={{ fontVariantNumeric: "tabular-nums" }}>
              {portName(node.type, seat)}
              {role && <span style={{ color: "var(--text-faint)" }}> · {role}</span>}
            </div>
            <div style={{ color: feed ? "var(--text-hi)" : "var(--text-ghost)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {feed ?? "nothing wired"}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** The card's small italic line under its head (a note) or under its
 * thumbnail (a depth export's convention): one look for both. */
const CARD_CAPTION_STYLE: React.CSSProperties = {
  fontSize: 8.5,
  fontStyle: "italic",
  color: "var(--text-faint)",
  padding: "0 7px 2px",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
  flex: "none",
};

/** Export Layer's one control: the layer's name in the file. Empty
 * means the card's own label less its " Export Layer" suffix, folded
 * in at serialization (bridge.ts), so renaming the card renames the
 * layer. */
function ExportLayerNameLine({ node, dispatch, wires }: { node: NodeCard; dispatch: D; wires?: Wire[] }) {
  return (
    <>
    <div className="srow" style={{ gridTemplateColumns: "78px 1fr" }}>
      <div className="lbl">Name</div>
      <input
        data-testid="export-layer-name"
        aria-label="Layer name"
        value={node.textParams?.name ?? ""}
        placeholder={exportWrittenName(node)}
        data-hint="The layer's name in the EXR or sibling TIFF filename. Empty uses the card's label without Export Layer."
        onChange={(e) => dispatch({ type: "set_text_param", id: node.id, param: "name", value: e.target.value })}
        style={{
          background: "var(--bg-app)",
          border: "1px solid var(--line-4)",
          color: "var(--text-body)",
          fontSize: 12,
          padding: "2px 4px",
          outline: "none",
        }}
      />
    </div>
    {exportWritesDepth(node, wires ?? []) && (
      <div className="help" data-testid="export-layer-depth-convention" style={{ margin: "0 0 8px" }}>
        {DEPTH_EXPORT_CONVENTION}
      </div>
    )}
    </>
  );
}

/** The File node's one control: which file. The name shows, the full
 * path is the hint, and CHOOSE… raises the native picker. */
function ImageFileLine({ node, dispatch }: { node: NodeCard; dispatch: D }) {
  const path = node.textParams?.path ?? "";
  const base = path.split(/[\\/]/).pop() ?? "";
  return (
    <div style={{ padding: "0 0 8px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <div
          data-testid="file-node-name"
          style={{
            flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis",
            whiteSpace: "nowrap", fontSize: 10,
            color: path ? "var(--text-body)" : "var(--text-ghost)",
          }}
          data-hint={path || "No file chosen yet; the node outputs a transparent pixel"}
        >
          {base || "No file chosen"}
        </div>
        <button
          className="chip"
          data-testid="file-node-choose"
          style={{ fontSize: 9, padding: "1px 8px", flex: "none" }}
          data-hint="Choose an image from disk: a second photograph, a texture, a logo"
          onClick={() => {
            void pickImageFile().then((p) => {
              if (p) dispatch({ type: "set_text_param", id: node.id, param: "path", value: p });
            });
          }}
        >
          CHOOSE…
        </button>
      </div>
      {/* 26.3 Phase 6: which page of a multi-page TIFF the node reads,
          and "A" for the page's alpha on the mask diamond. Phase 7: an
          OpenEXR's named layer groups read here too. Empty is the
          first picture, which is all any other format has. */}
      <div className="srow" style={{ gridTemplateColumns: "78px 1fr", marginTop: 4 }}>
        <div className="lbl">Layer</div>
        <input
          data-testid="file-node-layer"
          aria-label="Layer"
          value={node.textParams?.layer ?? ""}
          placeholder="first page"
          data-hint="A multi-page TIFF: page 2, page 3 ... read that page; A reads the first page with its alpha on the mask diamond. An OpenEXR: a layer group's name reads that group. Empty is the first picture."
          onChange={(e) => dispatch({ type: "set_text_param", id: node.id, param: "layer", value: e.target.value })}
          style={{
            background: "var(--bg-app)",
            border: "1px solid var(--line-4)",
            color: "var(--text-body)",
            fontSize: 12,
            padding: "2px 4px",
            outline: "none",
          }}
        />
      </div>
    </div>
  );
}

function LutFileLine({ node, dispatch }: { node: NodeCard; dispatch: D }) {
  const path = node.textParams?.path ?? "";
  const [info, setInfo] = useState<{ title: string; size: number } | null>(null);
  useEffect(() => {
    let live = true;
    setInfo(null);
    if (path) {
      void lutInfo(path).then((r) => {
        if (live) setInfo(r);
      });
    }
    return () => {
      live = false;
    };
  }, [path]);
  const base = path.split(/[\\/]/).pop() ?? "";
  return (
    <div style={{ padding: "0 0 8px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <div
          data-testid="lut-file-name"
          style={{
            flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis",
            whiteSpace: "nowrap", fontSize: 10,
            color: path ? "var(--text-body)" : "var(--text-ghost)",
          }}
          data-hint={path || "No LUT chosen yet; the node passes the image through untouched"}
        >
          {base || "No LUT chosen"}
        </div>
        <button
          className="chip"
          data-testid="lut-choose"
          style={{ fontSize: 9, padding: "1px 8px", flex: "none" }}
          data-hint="Choose a .cube 3D LUT; it is applied to the display-encoded image"
          onClick={() => {
            void pickLutFile().then((p) => {
              if (p) dispatch({ type: "set_text_param", id: node.id, param: "path", value: p });
            });
          }}
        >
          CHOOSE…
        </button>
      </div>
      {info && (
        <div data-testid="lut-info" style={{ fontSize: 9, color: "var(--text-faint)", marginTop: 3 }}>
          {info.title ? `${info.title} · ` : ""}{info.size}³ ({info.size * info.size * info.size} entries)
        </div>
      )}
    </div>
  );
}

export function NodeParams({
  node,
  dispatch,
  allNodes,
  gestureActive = false,
  panelWidth,
  appState,
  depthState,
  frame,
  session,
  wires,
}: {
  node: NodeCard;
  dispatch: D;
  /** the graph's wires, for the port guide a wiring-only node shows */
  wires?: Wire[];
  /** the session's photos, for the Catalog node's picker; present
   * wherever the inspector is, popped out included */
  session?: PhotoSession;
  /** the graph's node list, so half of a Color Set pair can offer the
   * WHOLE set's controls, same as the Develop panel */
  allNodes?: NodeCard[];
  /** a slider or strip drag is live: hold the strip's glide so it
   * stays glued to the hand */
  gestureActive?: boolean;
  /** width of the panel these controls sit in, so the drawn widgets
   * (curves, tone EQ, recolor, console) fill it the way Develop's do.
   * The owner, shown the fixed-width plots adrift in the Inspector:
   * "This looks really bad in Graph." Same arithmetic as Develop's.*/
  panelWidth?: number;
  /** The app state, when this panel lives in a window that HAS a viewer
   * to click: it arms the eyedroppers, the same shared pick state
   * Develop uses ("it should be implemented to maintain
   * parity between the 3 modes"). Absent (the popped-out graph window,
   * tests), the pickers hide.*/
  appState?: State;
  /** Depth controls also work in the graph window, without a picker or viewer. */
  depthState?: State;
  /** the frame on screen, preferred over the thumbnail for histograms
   * so the plot moves as the points move, like Develop's. A window with
   * a frame but no viewer (the popped-out graph) still plots it. */
  frame?: string | null;
}) {
  const widgetW = Math.max(220, (panelWidth ?? 320) - 24);
  const histSrc = frame ?? (appState ? appState.images.find((i) => i.id === appState.activeImage)?.src : undefined);
  if (ART_KINDS[node.artKind ?? ""]?.adjust) return <FinishAdjustmentControls node={node} state={appState ?? depthState} dispatch={dispatch} width={widgetW} />;
  if (isLayerEffect(node) && (node.type !== "heeler.blur" || node.artKind === "blur")) return <FxSettings fx={node} dispatch={dispatch} />;
  // Either half of a cset pair answers with the full set: mask or
  // grade, you get the strip and all six sliders, exactly what the
  // Adjustments panel shows. A lone hue mask or grade wired by hand
  // still gets its per-node editor below.
  const set = allNodes ? colorSetOf(allNodes, node.id) : null;
  if (set) {
    // The set's tools ride above its controls here as they do in
    // Develop. The flags come from the app state when a viewer is
    // present; the popped-out graph draws them unlit and the commands
    // still reach the main window.
    return (
      <>
        <div data-testid="color-set-tools" style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
          <ColorSetTools
            state={appState}
            set={set}
            dispatch={dispatch}
            dropperArmed={appState?.csetDropper === set.n}
            maskShown={appState?.csetMaskView === set.n}
            red={!!appState?.maskRed}
          />
        </div>
        <ColorSetControls set={set} dispatch={dispatch} animate={!gestureActive} histogramSrc={histSrc} state={depthState ?? appState} showDepthView={!!appState} />
      </>
    );
  }
  // Grid Warp's controls are the section's, here as in Develop (The
  // report: "make the controls available in Graph and Canvas as what is
  // available in Adjustments"). They need the app state for the picks
  // and the tool; without it (the popped-out graph window) the node
  // falls back to the wiring guide.
  const warpFace = node.type === "heeler.grid_warp" && !!appState &&
    appState.nodes.find((n) => n.type === "heeler.grid_warp")?.id === node.id;
  // Shape Warp's node wears the section's controls the same way.
  const shapeFace = node.type === "heeler.shape_warp" && !!appState &&
    appState.nodes.find((n) => n.type === "heeler.shape_warp")?.id === node.id;
  // And the Color Checker's: chart choice, Place chart, and Amount (the
  // panel's one dial) rather than the raw matrix sliders, which are the
  // fit's output, not hand controls.
  const checkerFace = node.type === "heeler.color_checker" && !!appState &&
    appState.nodes.find((n) => n.type === "heeler.color_checker")?.id === node.id;
  // A Finish warp (a Warp layer, an image layer's own warp) wears the
  // same grid and shapes, aimed at itself (finishwarp.tsx).
  const layerWarpFace = node.type === LAYER_WARP && !!appState && !!warpNodeById(appState, node.id);
  const generic = !CUSTOM_PARAM_TYPES.has(node.type) && !node.isGroup && !warpFace && !shapeFace && !checkerFace && !layerWarpFace;
  // A mask's Invert and Depth mask, Develop's layer block components on
  // the node (features reach their nodes). Every mask carried both and the
  // Inspector showed neither: invert was hidden as the "mask pair's"
  // business and the Depth block had no seat (2026-10-01: "I don't see an
  // invert option").
  const foot = maskFoot(node.type);
  const footState = depthState ?? appState;
  const footDepth = foot.depth && !!footState;
  return (
    <>
            {node.type === "heeler.grid_warp" && !warpFace && (
              <div data-testid="gridwarp-counts" style={{ fontSize: 11 }}>
                {node.params.cols ?? 4} columns x {node.params.rows ?? 3} rows
              </div>
            )}
            {warpFace && (
              <div data-node={node.id} data-params="cols rows">
                <GridWarpControls state={appState!} dispatch={dispatch} frame={frame ?? null} />
              </div>
            )}
            {shapeFace && <ShapeWarpControls state={appState!} dispatch={dispatch} frame={frame ?? null} />}
            {layerWarpFace && (
              <div data-node={node.id} data-params="cols rows room">
                <FinishWarpControls state={appState!} dispatch={dispatch} target={node.id} frame={frame ?? null} editButton />
              </div>
            )}
            {checkerFace && <ColorCheckerControls state={appState!} dispatch={dispatch} amount frame={frame ?? null} />}
            {(depthState ?? appState) && node.type === "heeler.matte_mask" && (
              <ObjectMattePanel key={node.id} state={(depthState ?? appState)!} node={node} dispatch={dispatch} />
            )}
            {(depthState ?? appState) && node.type === "heeler.key_light" && (
              <KeyLightControls node={node} state={(depthState ?? appState)!} dispatch={dispatch} />
            )}
            {node.type === "heeler.key_light" && (
              <div data-node={node.id} data-param="normals">
                <NormalsChoice node={node} state={depthState ?? appState} dispatch={dispatch} />
              </div>
            )}
            {node.type === "heeler.key_light" && <KeyLightInvertRow node={node} dispatch={dispatch} />}
            {node.type === "heeler.smart_mask" && (
              <SmartMaskFace node={node} state={appState ?? depthState} dispatch={dispatch} canPick={!!appState} width={widgetW} />
            )}
            {node.type === "heeler.lut" && <LutFileLine node={node} dispatch={dispatch} />}
            {node.type === "heeler.file" && <ImageFileLine node={node} dispatch={dispatch} />}
            {/* The File's Space, declared as a choice and drawn by the
                generic face only, which a custom face never reaches. */}
            {node.type === "heeler.file" && (
              <ParamChoiceRow
                node={node}
                param="space"
                value={node.textParams?.space ?? PARAM_TEXT_DEFAULT[node.type]?.space ?? "scene"}
                dispatch={dispatch}
              />
            )}
            {node.type === "heeler.export_layer" && <ExportLayerNameLine node={node} dispatch={dispatch} wires={wires} />}
            {/* The Finish layer's Export checkbox, on the layer's blend
                node here exactly as in the Finish tab's row (26.3 Phase
                8, palette parity). appState is absent in the popped-out
                graph window, which then shows no tick, the same bargain
                the pickers take. */}
            {appState && node.type === "heeler.blend" && (() => {
              const layer = artLayers(appState).find((l) => l.blend.id === node.id);
              if (!layer) return null;
              return (
                <div data-testid={`inspector-export-${node.id}`} style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
                  <ExportTick
                    id={node.id}
                    exported={layer.exported}
                    adjust={!!ART_KINDS[layer.content.artKind ?? ""]?.adjust}
                    dispatch={dispatch}
                  />
                  <span style={{ fontSize: 11, color: "var(--text-faint)" }}>Export layer</span>
                  {/* The mask's checkbox beside it (2026-09-30), the same node the
Layers panel's two seats show.*/}
                  <MaskExportTick state={appState} blendId={node.id} dispatch={dispatch} testid={`inspector-export-mask-${node.id}`} />
                  <span style={{ fontSize: 11, color: "var(--text-faint)" }}>{MASK_EXPORT_LABEL}</span>
                </div>
              );
            })()}
            {/* A Develop section's Export checkbox on the node it taps
(2026-09-30), the panel's own component: features reach their
nodes.*/}
            {appState && (() => {
              // The box answers for the node in hand, whichever layer
              // the Develop panel has selected: a layer's node reads
              // and writes that layer's box, a main-chain node Base's.
              const scoped = { ...appState, activeLayer: layerAdjOfNode(node.id) };
              const sec = SECTIONS.find((sc) => sectionExportTap(scoped, sc)?.tap === node.id);
              if (!sec) return null;
              return (
                <div data-testid={`inspector-section-export-${node.id}`} style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
                  <SectionExportTick state={scoped} sec={sec} dispatch={dispatch} seat="inspector" />
                  <span style={{ fontSize: 11, color: "var(--text-faint)" }}>Export {sec.title} as a layer</span>
                </div>
              );
            })()}
            {/* A placed picture's transform (Finish image layers,
                2026-09-30), the Layers panel's fields on the blend that
                carries the corners: features reach their nodes. */}
            {appState && node.type === "heeler.blend" && isPlacedLayer(appState, node.id) && (
              <div data-testid={`inspector-xform-${node.id}`} style={{ marginBottom: 8 }}>
                <TransformFields state={appState} blendId={node.id} dispatch={dispatch} />
              </div>
            )}
            {/* Unbake on a baked layer's picture node, where Bake Warp sat
                on its warp node (layerWarpFace above). */}
            {appState && node.type === "heeler.file" && (() => {
              const carrier = unbakeCarrierOf(appState, node.id);
              return carrier ? (
                <div style={{ marginBottom: 8 }}>
                  <UnbakeButton state={appState} dispatch={dispatch} carrier={carrier} testid={`inspector-unbake-${node.id}`} />
                </div>
              ) : null;
            })()}
            {/* The curve face rides above the generic rows: the drawn,
                grabbable transform, with the sliders kept for typed
                precision. Same params, so neither can lie. */}
            {node.type === "heeler.view_transform" && (
              <ViewTransformFace node={node} dispatch={dispatch} />
            )}
            {/* The Gradient's shape (By tone included), colors, angle,
                center and ADV stops: the Finish layer's own controls,
                one seat each, so the generic rows below leave out the
                angle and center they already hold. */}
            {node.type === "heeler.gradient" && (
              <div data-node={node.id} data-params="angle midpoint">
                <GradientNodeControls node={node} dispatch={dispatch} />
              </div>
            )}
            {generic &&
              (() => {
                // What the TYPE offers, not only what the instance
                // happens to carry: a palette-placed node arrives with
                // empty params (the engine owns the defaults), and rows
                // drawn from the instance alone left such a node a
                // panel of nothing. Union with the instance so a saved
                // param the type list has not heard of still renders.
                const offered = [
                  ...new Set([
                    ...(TYPE_NUM_PARAMS[node.type] ?? []),
                    ...Object.keys(node.params),
                  ]),
                ];
                // Flags are toggles, not 0..1 sliders; invert stays
                // hidden because the mask-pair UX owns it.
                const rows = offered.filter(
                  (p) =>
                    !HIDDEN_PARAMS.has(p) &&
                    hasParamRange(p, node.type) &&
                    !FLAG_PARAMS.includes(p) &&
                    !(footDepth && DEPTH_BLOCK_PARAMS.has(p)) &&
                    !(node.type === "heeler.gradient" && (p === "angle" || p === "midpoint")),
                );
                // Where Develop names this type's dials, use its names
                // and its order; params it does not know keep their
                // place at the end.
                const devLabels = DEVELOP_PARAM_LABELS[node.type];
                if (devLabels) {
                  const order = Object.keys(devLabels);
                  rows.sort((a, b) => {
                    const ia = order.indexOf(a);
                    const ib = order.indexOf(b);
                    return (ia === -1 ? order.length : ia) - (ib === -1 ? order.length : ib);
                  });
                }
                const flagRows = offered.filter(
                  (p) =>
                    !HIDDEN_PARAMS.has(p) &&
                    FLAG_PARAMS.includes(p) &&
                    !(footDepth && DEPTH_BLOCK_PARAMS.has(p)) &&
                    !(p === "by_frame" && ["heeler.grain", "heeler.noise"].includes(node.type)),
                );
                // What the TYPE offers, not what the instance happens to
                // carry: a node saved before a choice existed still gets its
                // picker, showing the value the engine would default to.
                const textRows = Object.entries(PARAM_OPTIONS[node.type] ?? {})
                  .filter(([p]) => !(node.type === "heeler.key_light" && p === "normals"))
                  // Grain's format has its own row (GrainFrameRow, with
                  // the frame-sizing chip), the same one Develop mounts.
                  .filter(([p]) => !(["heeler.grain", "heeler.noise"].includes(node.type) && p === "format"))
                  .map(
                    ([p, options]) =>
                      [
                        p,
                        node.textParams?.[p] ??
                          PARAM_TEXT_DEFAULT[node.type]?.[p] ??
                          options[0].id,
                      ] as const,
                  );
                if (rows.length === 0 && textRows.length === 0 && flagRows.length === 0) {
                  return <PortGuide node={node} wires={wires ?? []} allNodes={allNodes ?? []} />;
                }
                return (
                  <>
                    {/* "Vivid Light - this should be a blending mode node where
one of the blending modes is Vivid Light", and "Blur - this is too
generic, it should have properties like blur type." Both are choices
rather than amounts, so they get a picker: a menu, short list or long,
since a row of buttons reads as tabs (2026-09-15).*/}
                    {textRows.map(([p, value]) => (
                      <ParamChoiceRow key={p} node={node} param={p} value={value} dispatch={dispatch} />
                    ))}
                    {/* On/off params, as toggles rather than 0..1 sliders.
                        They were invisible until now: no generic renderer
                        existed for them, so switches like Grain Field's
                        color grain or Bevel's light could only be thrown
                        by whatever tool wrote them. */}
                    {flagRows.map((p) => {
                      if (p === "feather_guided") return <FeatherFollowsToggle key={p} node={node} dispatch={dispatch} testid="node-flag-feather_guided" />;
                      const label = FLAG_LABELS[p] ?? p.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
                      const on = (node.params[p] ?? 0) !== 0;
                      return (
                        <div key={p} className="srow" data-node={node.id} data-param={p} style={{ gridTemplateColumns: "78px 1fr" }}>
                          <div className="lbl fit" title={label}>{label}</div>
                          <button
                            className="chip"
                            data-testid={`node-flag-${p}`}
                            data-active={on}
                            aria-pressed={on}
                            style={{ fontSize: 9, padding: "1px 8px", justifySelf: "start" }}
                            onClick={() =>
                              dispatch({ type: "set_param", id: node.id, param: p, value: on ? 0 : 1 })
                            }
                          >
                            {on ? "On" : "Off"}
                          </button>
                        </div>
                      );
                    })}
                    {rows.map((p) => {
                      // The range this node gives the param, not the shared
                      // one. A sharpen radius runs 0.1 to 5 pixels while a
                      // blur radius runs to 200, and the same name asking
                      // one table for one answer gets one of them wrong.
                      const [lo] = paramRange(p, node.type);
                      return (
                        <Slider
                          key={p}
                          label={devLabels?.[p] ?? p.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase())}
                          param={p}
                          node={node}
                          dispatch={dispatch}
                          centered={lo < 0}
                          fit
                        />
                      );
                    })}
                  </>
                );
              })()}
            {/* Below Mode, so the browser's list cannot push the mode picker out
of reach ("the Mode should be below the Note and the
browser opens below mode").*/}
            {node.type === "heeler.catalog" && <CatalogLine node={node} session={session} dispatch={dispatch} />}
            {node.type === "heeler.color_bend" && (
              <>
                <div data-node={node.id} data-params="src_hue src_sat dst_hue dst_sat">
                  <BendWheel node={node} dispatch={dispatch} />
                </div>
                <Slider label="Falloff" param="falloff" node={node} dispatch={dispatch} centered={false} />
                <Slider label="Amount" param="amount" node={node} dispatch={dispatch} centered={false} />
              </>
            )}
            {node.type === "heeler.split_tone" && (
              <>
                <div style={{ display: "flex", gap: 8 }} data-testid="inspector-splittone">
                  <Wheel name="Shadows" range="shadow" node={node} dispatch={dispatch} showLum={false} />
                  <Wheel name="Highlights" range="highlight" node={node} dispatch={dispatch} showLum={false} />
                </div>
                <div style={{ marginTop: 10 }}>
                  <Slider label="Balance" param="balance" node={node} dispatch={dispatch} />
                </div>
              </>
            )}
            {node.type === "heeler.tone_profile" && (
              <>
                {/* Film: the stock the negative is developed as and its development, the same
two controls Develop's treatment block has, on the node.*/}
                <FilmBlock node={node} dispatch={dispatch} />
                <Slider
                  label="Development"
                  param="development"
                  node={node}
                  dispatch={dispatch}
                  tip="Development time in N steps: N+1 is a push, steeper and a touch faster; N-1 a pull, flatter"
                />
                {/* Develop's Profile dropdown, the same component. */}
                <div style={{ marginBottom: 8 }}>
                  <SourceMenuRow
                    label="Profile"
                    name="Tone profile"
                    value={node.textParams?.mode ?? "standard"}
                    choices={PROFILE_CHOICES}
                    testid="inspector-profile"
                    onChange={(value) => dispatch({ type: "set_text_param", id: node.id, param: "mode", value })}
                  />
                </div>
                {/* Same rows, same names, same order as Develop's
                    Source block, gate included: a linear profile has no
                    amount to turn. */}
                <Slider label="Baseline" param="baseline_ev" node={node} dispatch={dispatch} />
                {(node.textParams?.mode ?? "standard") !== "linear" && (
                  <Slider label="Profile amt" param="contrast" node={node} dispatch={dispatch} centered={false} />
                )}
                <Slider label="Toe" param="shadow_toe" node={node} dispatch={dispatch} centered={false} />
                <Slider label="Highlight roll" param="highlight_rolloff" node={node} dispatch={dispatch} centered={false} />
                <Slider label="Colorfulness" param="colorfulness" node={node} dispatch={dispatch} />
              </>
            )}
            {/* The Color Set pair, opened from the graph side: the same
                strip the Develop block draws, writing this node alone.
                (In Develop the strip writes both halves of the pair;
                here each node answers for itself, which is what opening
                the hood means.) */}
            {node.type === "heeler.hue_range_mask" && (
              <>
                <div data-node={node.id} data-params="band_center">
                <HueBandStrip
                  center={node.params.band_center ?? 30}
                  range={node.params.hue_range ?? 60}
                  falloff={node.params.hue_falloff ?? 30}
                  gestureKey={`${node.id}.strip`}
                  testSuffix={node.id}
                  dispatch={dispatch}
                  animate={!gestureActive}
                  ghost={appState?.csetDropper !== null && appState?.csetDropper !== undefined && node.id.startsWith(`cset${appState.csetDropper}_`) ? appState.csetHoverHue : null}
                  onCenter={(v) => dispatch({ type: "set_param", id: node.id, param: "band_center", value: v })}
                  onWidth={(w) => dispatch({ type: "set_param", id: node.id, param: "hue_range", value: w })}
                />
                </div>
                <Slider label="Range" param="hue_range" node={node} dispatch={dispatch} centered={false} />
                <Slider label="Falloff" param="hue_falloff" node={node} dispatch={dispatch} centered={false} />
              </>
            )}
            {node.type === "heeler.color_grade" && (
              <>
                <div data-node={node.id} data-params="band_center">
                <HueBandStrip
                  center={node.params.band_center ?? 30}
                  gestureKey={`${node.id}.strip`}
                  testSuffix={node.id}
                  dispatch={dispatch}
                  animate={!gestureActive}
                  ghost={appState?.csetDropper !== null && appState?.csetDropper !== undefined && node.id.startsWith(`cset${appState.csetDropper}_`) ? appState.csetHoverHue : null}
                  onCenter={(v) => dispatch({ type: "set_param", id: node.id, param: "band_center", value: v })}
                />
                </div>
                <Slider label="Hue Shift" param="hue_shift" node={node} dispatch={dispatch} />
                <Slider label="Saturation" param="saturation" node={node} dispatch={dispatch} />
                {/* The full set ColorSetControls offers a paired grade;
                    a lone grade was missing Vibrance for no reason. */}
                <Slider label="Vibrance" param="vibrance" node={node} dispatch={dispatch} />
                <Slider label="Exposure" param="exposure" node={node} dispatch={dispatch} range={[-3, 3]} />
                <Slider label="Uniformity" param="uniformity" node={node} dispatch={dispatch} centered={false} />
              </>
            )}
            {node.type === "heeler.color_balance" && (
              <>
                <div
                  style={{ display: "flex", gap: 8 }}
                  data-node={node.id}
                  data-params={["shadows", "midtones", "highlights"].flatMap((r) => ["hue", "sat", "lum"].map((c) => `${r}_${c}`)).join(" ")}
                >
                  <Wheel name="Shadows" range="shadows" node={node} dispatch={dispatch} />
                  <Wheel name="Mids" range="midtones" node={node} dispatch={dispatch} />
                  <Wheel name="Highs" range="highlights" node={node} dispatch={dispatch} />
                </div>
                <div style={{ display: "flex", gap: 6, marginTop: 11 }}>
                  <button
                    className="chip"
                    data-testid="wheels-reset"
                    onClick={() =>
                      dispatch({
                        type: "set_params",
                        id: node.id,
                        values: Object.fromEntries(
                          ["shadows", "midtones", "highlights"].flatMap((r) =>
                            ["hue", "sat", "lum"].map((p) => [`${r}_${p}`, 0])
                          )
                        ),
                      })
                    }
                  >
                    Reset all
                  </button>
                  {/* A "Copy" chip with no onClick used to sit here. There
                      is no paste for it to feed anywhere in the app, so
                      out it went rather than promising a clipboard that
                      does not exist. */}
                </div>
              </>
            )}
            {node.type === "heeler.curves" && (
              <CurveEditor
                node={node}
                dispatch={dispatch}
                width={widgetW}
                histogramSrc={histSrc}
                channelMode={appState ? curveModeOf(appState) : "rgb"}
                clipboard={appState?.curveClipboard ?? null}
                pickArmed={appState?.curvePick?.nodeId === node.id}
                hoverX={appState?.curvePick?.nodeId === node.id ? appState.curveHoverX : null}
                onTogglePick={
                  appState
                    ? (ch) => dispatch({ type: "arm_curve_pick", nodeId: node.id, channel: ch })
                    : undefined
                }
              />
            )}
            {node.type === "heeler.color_console" && (
              <ConsoleInspector node={node} dispatch={dispatch} width={widgetW} appState={appState} />
            )}
            {/* The section looks, the same row the Develop section draws
                (features reach their nodes): on the chain's own Relight
                and Recolor, not a layer's copy. */}
            {appState && node.id === "recolor" && node.type === "heeler.recolor" && (
              <SectionLooks section="Recolor" state={appState} dispatch={dispatch} seat="inspector" />
            )}
            {appState && node.id === "toneeq" && node.type === "heeler.tone_eq" && (
              <SectionLooks section="Relight" state={appState} dispatch={dispatch} seat="inspector" />
            )}
            {node.type === "heeler.recolor" && (
              <RecolorInspector node={node} dispatch={dispatch} width={widgetW} appState={appState} histogramSrc={histSrc} />
            )}
            {node.type === "heeler.tone_eq" && (
              <>
                {/* Sliders above the widget, Develop's order. */}
                <Slider label="Range shift" param="range_shift" node={node} dispatch={dispatch} />
                <Slider label="Smoothing" param="smoothing" node={node} dispatch={dispatch} centered={false} />
                <EqEditor
                  node={node}
                  dispatch={dispatch}
                  width={widgetW}
                  height={170}
                  histogramSrc={histSrc}
                  pickArmed={appState?.toneEqPick === node.id}
                  hoverX={appState?.toneEqPick === node.id ? appState.toneEqHoverX : null}
                  onTogglePick={
                    appState
                      ? () => dispatch({ type: "toggle_tone_eq_pick", id: node.id })
                      : undefined
                  }
                />
              </>
            )}
            {node.type === "heeler.luminance_range_mask" && (
              <div data-node={node.id} data-params="invert">
                <LuminanceMaskControls node={node} dispatch={dispatch} state={depthState ?? appState} width={widgetW} />
              </div>
            )}
            {/* The histogram with its handles, the one Adjustments >
                Levels draws, above the rows for typed values. */}
            {node.type === "heeler.levels" && (
              <div style={{ margin: "2px 0 6px" }}>
                <LevelsEditor state={depthState ?? appState} node={node} dispatch={dispatch} width={widgetW} histogramSrc={histSrc} />
              </div>
            )}
            {node.type === "heeler.levels" &&
              // All five of Develop's Levels rows: the falloffs were
              // real engine params with no reachable control here.
              [
                ["Black point", "black"],
                ["White point", "white"],
                ["Gamma", "gamma"],
                ["Black falloff", "black_soft"],
                ["White falloff", "white_soft"],
              ].map(([label, p]) => (
                <Slider key={p} label={label} param={p} node={node} dispatch={dispatch} centered={false} />
              ))}
            {/* The treatment's controls, the same component Develop mounts (The
report: no copies between Adjustments and the graph).*/}
            {node.type === "heeler.black_white" && (
              <BwControls bw={node} nodes={allNodes ?? appState?.nodes ?? []} dispatch={dispatch} state={appState} width={widgetW} />
            )}
            {/* The print's controls, the same component Develop's Print section
mounts. */}
            {node.type === "heeler.paper" && <PrintControls node={node} dispatch={dispatch} />}
            {/* The Grain node's Film row, the same component Develop's Grain section
mounts. */}
            {["heeler.grain", "heeler.noise"].includes(node.type) && (
              <div data-node={node.id} data-params="by_frame format">
                <GrainFrameRow grain={node} dispatch={dispatch} />
              </div>
            )}
            {node.type === "heeler.grain" && <GrainFilmRow grain={node} nodes={allNodes ?? appState?.nodes ?? []} dispatch={dispatch} />}
            {node.type === "heeler.crop_rotate" &&
              [
                ["Straighten", "angle", true],
                // Develop's Geometry row, the RAW editors' Transform vocabulary:
                // negative widens, positive heightens.
                ["Aspect", "aspect", true],
                ["Crop width", "crop_w", false],
                ["Crop height", "crop_h", false],
                ["Crop left", "crop_x", false],
                ["Crop top", "crop_y", false],
              ].map(([label, p, centered]) => (
                <Slider key={p as string} label={label as string} param={p as string} node={node} dispatch={dispatch} centered={centered as boolean} />
              ))}
            {node.type === "heeler.crop_rotate" && appState && (
              <div data-node={node.id} data-params="flip_h flip_v">
                <FlipPhotoRow nodes={appState.nodes} activeImage={appState.activeImage} dispatch={dispatch} />
              </div>
            )}
            {node.type === "heeler.brush_mask" && (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <div className="tnum" style={{ fontSize: 11, color: "var(--text-body)" }} data-testid="stroke-count">
                  {(node.strokes ?? []).length} stroke{(node.strokes ?? []).length === 1 ? "" : "s"}
                </div>
                <div style={{ fontSize: 10, color: "var(--text-faint)", lineHeight: 1.5 }}>
                  Paint with the Brush tool in the viewer. Hold {modLabel("alt")} to erase.
                </div>
                <button
                  className="chip"
                  data-testid="clear-strokes"
                  onClick={() => dispatch({ type: "clear_strokes", id: node.id })}
                >
                  Clear strokes
                </button>
              </div>
            )}
            {/* Shape first, as in Develop: it decides what the sliders
                below mean. The graph face had no Shape at all. */}
            {node.type === "heeler.radial_mask" && <RadialShapePicker node={node} dispatch={dispatch} />}
            {/* A range mask's tools and histogram, the same components and order as
its layer block in Develop: the node showed the sliders alone
(2026-10-06: the range mask node "did not have the same controls as
to what the adjustment layer has"). Pick samples into this node,
whichever layer Develop has selected.*/}
            {node.type === "heeler.range_mask" && appState && (
              <div data-testid={`inspector-range-tools-${node.id}`}>
                <RangeMaskTools state={appState} dispatch={dispatch} maskNode={node} />
                <RangeHistogram
                  src={appState.images.find((i) => i.id === appState.activeImage)?.src ?? ""}
                  target={appState.pickTarget}
                  low={node.params.luma_low ?? 0}
                  high={node.params.luma_high ?? 1}
                  softness={node.params.softness ?? 0.1}
                  hueCenter={node.params.hue_center ?? 0}
                  hueWidth={node.params.hue_width ?? 180}
                />
              </div>
            )}
            {(["heeler.range_mask", "heeler.radial_mask", "heeler.linear_mask"] as const).includes(node.type as any) &&
              MASK_ROWS[
                node.type === "heeler.range_mask" ? "range" : node.type === "heeler.radial_mask" ? "radial" : "linear"
              ].map((r) => (
                <Slider key={r.param} label={r.label} param={r.param} node={node} dispatch={dispatch} centered={r.centered !== false} />
              ))}
            {/* The Radial and Linear gizmos' line color and thickness, as under
Layers; they are view state, so only where the app state is at
hand.*/}
            {(node.type === "heeler.radial_mask" || node.type === "heeler.linear_mask") && appState && (
              <>
                <LinesRow
                  lineColor={appState.lineColor}
                  dispatch={dispatch}
                  previewUrl={appState.images.find((i) => i.id === appState.activeImage)?.src ?? null}
                  prefix={node.type === "heeler.radial_mask" ? "radial" : "linear"}
                  subject={node.type === "heeler.radial_mask" ? "mask's outline" : "gradient's lines"}
                />
                <LineWidthRow
                  state={appState}
                  dispatch={dispatch}
                  prefix={node.type === "heeler.radial_mask" ? "radial" : "linear"}
                  subject={node.type === "heeler.radial_mask" ? "mask's outline" : "gradient's lines"}
                />
              </>
            )}
            {node.type === "heeler.image_source" &&
              (() => {
                const on = (node.params.camera_wb ?? 1) !== 0;
                return (
                  <>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                      <div style={{ fontSize: 11, color: "var(--text-body)" }}>As-shot white balance</div>
                      <div
                        className="toggle"
                        data-on={on}
                        data-testid="inspector-source-camera_wb"
                        role="switch"
                        aria-checked={on}
                        aria-label="As-shot white balance"
                        tabIndex={0}
                        onClick={() => dispatch({ type: "set_param", id: node.id, param: "camera_wb", value: on ? 0 : 1 })}
                      >
                        <div className="dot" />
                      </div>
                    </div>
                    {/* Develop's Highlights, Demosaic and Sharpening
                        seats: declared for this type yet unreachable
                        here, because a custom branch skips the generic
                        picker rows that would have drawn them. The
                        same dropdown rows as Develop's Source section. */}
                    {SOURCE_MENU_ROWS.map(([label, param, dflt, choices, name]) => (
                      <div key={param} data-node={node.id} data-param={param}>
                        <SourceMenuRow
                          label={label}
                          name={name}
                          value={node.textParams?.[param] ?? dflt}
                          choices={choices}
                          testid={`inspector-source-${param}`}
                          onChange={(value) => dispatch({ type: "set_text_param", id: node.id, param, value })}
                        />
                      </div>
                    ))}
                  </>
                );
              })()}
            {node.type === "heeler.exposure" &&
              // The full tonal set the Develop panel edits, chroma
              // included: color_contrast was the one param the engine
              // read that no graph control could reach (Develop has it
              // as "Chroma"), which made masked chroma-contrast edits
              // unbuildable from the canvas. Labels and the Contrast
              // and Range headings match Develop's Exposure section,
              // where contrast is "Luminance": the decomposed half of
              // contrast that leaves chroma untouched.
              (
                [
                  ["Exposure", "exposure"],
                  ["Luminance", "contrast", "Contrast"],
                  ["Chroma", "color_contrast"],
                  ["Highlights", "highlights", "Range"],
                  ["Shadows", "shadows"],
                  ["Whites", "whites"],
                  ["Blacks", "blacks"],
                ] as [string, string, string?][]
              ).map(([label, p, heading]) => (
                <React.Fragment key={p}>
                  {heading && (
                    <div
                      className="kicker"
                      data-testid={`subsection-${heading.toLowerCase()}`}
                      style={{ fontSize: 8, marginTop: 7, marginBottom: 1, opacity: 0.75 }}
                    >
                      {heading}
                    </div>
                  )}
                  <Slider label={label} param={p} node={node} dispatch={dispatch} />
                </React.Fragment>
              ))}
            {node.type === "heeler.standard_color" && (
              <>
                {/* Develop's Color rows, names included: "Temp", not
                    Temperature, so the two surfaces read as one tool. */}
                {[
                  ["Temp", "temperature"],
                  ["Tint", "tint"],
                  ["Saturation", "saturation"],
                  ["Vibrance", "vibrance"],
                ].map(([label, p]) => (
                  <Slider key={p} label={label} param={p} node={node} dispatch={dispatch} />
                ))}
              </>
            )}
            {node.type === "heeler.detail" && (
              <>
                {/* Develop's Detail, weights included, in Develop's order
                    (the advanced weights sit above the three sliders
                    there). Its own card since 2026-09-02. */}
                <div data-node={node.id} data-params={DETAIL_WEIGHT_PARAMS}>
                  <DetailAdvanced node={node} dispatch={dispatch} />
                </div>
                {["texture", "clarity", "dehaze"].map((p) => (
                  <Slider key={p} label={p[0].toUpperCase() + p.slice(1)} param={p} node={node} dispatch={dispatch} />
                ))}
              </>
            )}
            {foot.invert && <MaskInvertRow node={node} dispatch={dispatch} testid={`node-invert-${node.id}`} />}
            {footDepth && (
              <DepthMaskBlock
                maskNode={node}
                state={footState!}
                dispatch={dispatch}
                testid={`node-depth-${node.id}`}
                width={widgetW}
                showView={!!appState}
              />
            )}
            {node.isGroup && (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <div className="kicker">Published controls</div>
                {/* "if we select the Grain container we see the controls we do
now, but if we expand we see how those controls are connected to specific
nodes... an abstraction layer another user works with without having to
dig into the complex node network." This is the outside of that: the
controls the group chose to offer, under the group's own names, writing
into the children.*/}
                {/* The Sharpening group's Recipe switch, the mirror's
                    mode: the inside rewires to the branch it names. */}
                {node.tool === "sharpening" && (
                  <SharpeningRecipeControl node={node} dispatch={dispatch} select />
                )}
                {node.published?.length ? (
                  node.published.map((p) => {
                    const [lo, hi] = p.range ?? [0, 100];
                    const value = publishedValue(node, p.label) ?? lo;
                    const testid = `published-${p.label.toLowerCase().replace(/[^a-z]+/g, "-")}`;
                    // A recipe's menu (node recipes, 2026-09-30): each
                    // choice writes its set of members at once. Custom
                    // when an edit inside moved one of them.
                    if (p.options) {
                      const current = publishedChoice(node, p.label) ?? "";
                      return (
                        <div key={p.label} className="srow" style={{ gridTemplateColumns: "78px 1fr" }} data-testid={testid}>
                          <div className="lbl">{p.label}</div>
                          <MenuField
                            testid={`${testid}-menu`}
                            label={p.label}
                            size="regular"
                            value={current}
                            placeholder="Custom"
                            options={p.options.map((o) => ({ id: o.label, label: o.label }))}
                            fitLabels={["Custom", ...p.options.map((o) => o.label)]}
                            onChange={(choice) => dispatch({ type: "set_published_choice", id: node.id, label: p.label, choice })}
                          />
                        </div>
                      );
                    }
                    // A tool group's dials and a recipe's are the
                    // member's own slider, its units and steps, writing
                    // through the group.
                    if (node.tool || node.recipe) {
                      const member = node.groupNodes?.find(n => n.id === p.node);
                      if (member) return <div key={p.label} data-testid={`published-${p.label.toLowerCase().replace(/[^a-z]+/g, "-")}`}>
                        <Slider label={p.label} param={p.param} node={{ ...member, params: { ...member.params, [p.param]: value } }}
                          range={[lo,hi]} centered={lo < 0} dispatch={cmd => dispatch(cmd.type === "set_param"
                            ? { type: "set_published", id: node.id, label: p.label, value: cmd.value } : cmd)} />
                      </div>;
                    }
                    const pct = ((value - lo) / (hi - lo)) * 100;
                    return (
                      <div
                        key={p.label}
                        className="srow"
                        data-testid={`published-${p.label.toLowerCase().replace(/[^a-z]+/g, "-")}`}
                        style={{ gridTemplateColumns: "78px 1fr 42px" }}
                      >
                        <div className="lbl">{p.label}</div>
                        <div
                          className="strack"
                          role="slider"
                          aria-label={p.label}
                          aria-valuenow={value}
                          aria-valuemin={lo}
                          aria-valuemax={hi}
                          tabIndex={0}
                          onPointerDown={(e) => {
                            if (!isPrimaryPress(e)) return;
                            const rect = e.currentTarget.getBoundingClientRect();
                            if (!rect.width) return;
                            const t = Math.min(
                              1,
                              Math.max(0, (e.clientX - rect.left) / rect.width),
                            );
                            // A pointer event without coordinates is not a
                            // drag; writing NaN into a parameter would take
                            // the render down.
                            if (!Number.isFinite(t)) return;
                            dispatch({
                              type: "set_published",
                              id: node.id,
                              label: p.label,
                              value: lo + t * (hi - lo),
                            });
                          }}
                          // The arrows, like every other slider in the app.
                          // A control that can only be dragged cannot be
                          // reached without a mouse.
                          onKeyDown={(e) => {
                            const step = (hi - lo) / (e.shiftKey ? 200 : 20);
                            const delta =
                              e.key === "ArrowRight" || e.key === "ArrowUp"
                                ? step
                                : e.key === "ArrowLeft" || e.key === "ArrowDown"
                                  ? -step
                                  : 0;
                            if (!delta) return;
                            e.preventDefault();
                            dispatch({
                              type: "set_published",
                              id: node.id,
                              label: p.label,
                              value: Math.min(hi, Math.max(lo, value + delta)),
                            });
                          }}
                        >
                          <div className="rail" />
                          <div className="fill" style={{ left: 0, width: `${pct}%` }} />
                          <div className="handle" style={{ left: `${pct}%` }} />
                        </div>
                        {/* Places by span: a 0 to 1 control read as 0 or 1
                            when every number was rounded whole. */}
                        <div className="val tnum">{hi - lo <= 2 ? value.toFixed(2) : hi - lo <= 20 ? value.toFixed(1) : Math.round(value)}</div>
                      </div>
                    );
                  })
                ) : "grade_strength" in node.params ? (
                  <Slider label="Grade strength" param="grade_strength" node={node} dispatch={dispatch} centered={false} />
                ) : (
                  <div style={{ fontSize: 10, color: "var(--text-faint)" }}>
                    This group publishes no controls. Open it to work on the nodes inside.
                  </div>
                )}
                {/* What the group offers and how (2026-10-01): rename,
                    reorder, spans, and what each control drives. Not on a
                    Develop tool group, whose controls are its section's. */}
                {!node.tool && <ControlsEditor group={node} dispatch={dispatch} />}
                <button
                  className="chip"
                  onClick={() => {
                    // Every door into a group frames its contents, not
                    // just the double-click: entering unframed is the
                    // same "I had a hard time finding the nodes"
                    // moment whichever door you take. Measured the
                    // same way graph.frame measures.
                    const r = document
                      .querySelector('[data-testid="node-editor"]')
                      ?.getBoundingClientRect();
                    dispatch({
                      type: "open_group",
                      id: node.id,
                      ...(r && r.width > 0 ? { frame: { w: r.width, h: r.height } } : {}),
                    });
                  }}
                  data-testid="open-group"
                >
                  Open group
                </button>
              </div>
            )}
    </>
  );
}

export function InspectorBar({ onClick }: { onClick: () => void }) {
  return (
    <button
      data-testid="inspector-bar"
      data-hint="Bring the inspector into this window"
      onClick={onClick}
      style={{
        all: "unset", boxSizing: "border-box", cursor: "pointer",
        flex: "none", width: 26, height: "100%",
        display: "flex", flexDirection: "column", alignItems: "center", gap: 10, paddingTop: 10,
        background: "var(--bg-panel)", borderLeft: "1px solid var(--line-hard)",
      }}
    >
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2.4">
        <path d="M15 6l-6 6 6 6" />
      </svg>
      <span
        style={{
          writingMode: "vertical-rl", fontSize: 9, letterSpacing: ".14em",
          color: "var(--text-ghost)", textTransform: "uppercase",
        }}
      >
        Inspector
      </span>
    </button>
  );
}

function InspectorImpl({
  state,
  dispatch,
  width,
  /** the frame on screen, for the spectrums under the header and the
   * widgets' histograms. Undefined means this window has no frame to
   * read, and the section is left out rather than sitting there
   * permanently saying it is waiting. The popped-out graph window reads
   * the main window's frame over the pop-out channel, so it has one. */
  frame,
  /** whether a viewer exists in this window for the eyedroppers to
   * click. Defaults to "there is a frame", which is the main window;
   * the popped-out graph window has a frame to plot and nothing to
   * click, so it passes false. */
  pickers,
}: {
  state: State;
  dispatch: D;
  width?: number;
  frame?: string | null;
  pickers?: boolean;
}) {
  const hasViewer = pickers ?? frame !== undefined;
  // While a group is open in the canvas, its members are what selection
  // can mean: the canvas drew them and the click named one. Reading
  // only the top level here answered "no selection" over a plainly
  // selected card, and a Finish layer's blend node could never be
  // inspected (26.3 Phase 8 needs it: the layer's Export checkbox lives
  // on that node, palette parity with the Finish tab's row).
  const opened = state.openedGroup ? state.nodes.find((n) => n.id === state.openedGroup) : undefined;
  // Outside any group, a picked Finish layer mask (Edit layer mask)
  // still inspects: it lives in the Finish group, read where it sits.
  const pool = opened?.groupNodes ?? artMaskView(state).nodes;
  const sel = pool.filter((n) => state.selection.includes(n.id));
  const single = sel.length === 1 ? sel[0] : null;
  // A member of the open group publishes its rows to the group from a
  // right-click (publishcontrols.tsx). Not inside a Develop tool group,
  // whose face is its section's and is rebuilt by the mirror.
  const publishable = !!opened && !opened.tool && !!single && opened.groupNodes!.some((n) => n.id === single.id);
  const [publishAt, setPublishAt] = useState<{ x: number; y: number; node: string; param: string; label: string } | null>(null);
  const onPublishMenu = publishable ? (e: React.MouseEvent) => {
    const row = publishRowAt(e.target, single!.id);
    if (!row || !opened!.groupNodes!.some((n) => n.id === row.node)) return;
    e.preventDefault();
    e.stopPropagation();
    setPublishAt({ x: e.clientX, y: e.clientY, ...row });
  } : undefined;

  return (
    // ui-zoom: the Inspector is the same right panel Develop has, and it
    // must render at the same chrome scale ("The controls,
    // button sizes, font sizes, etc should all match what is in Develop.
    // It should look no different").
    <div className="panel-right ui-zoom" data-testid="inspector" style={{ flex: "none", ...(width ? { width } : {}) }}>
      <div className="panel-head">
        <div className="title">Inspector</div>
        <div className="tnum" style={{ fontSize: 10, color: "var(--text-ghost)", letterSpacing: ".06em" }}>
          {sel.length > 1 ? "multi-select" : single ? `node ${pool.indexOf(single) + 1} of ${pool.length}` : "no selection"}
        </div>
      </div>

      {/* The spectrums, directly under the header. "The Spectrums
should be at the top, attributes from the selected node will appear
below the Spectrum." They are a reference you read while working
rather than a property of whatever happens to be selected, so they
hold still at the top and the node's own controls scroll underneath
them.

          They read the same frame the viewer is showing, so the plot
          means the same thing here as it does in Develop. Undefined
          means this window has no frame to read (the popped-out graph
          window renders no photograph), and the section is left out
          rather than sitting there saying it is waiting forever. */}
      {frame !== undefined && (
        <div style={{ flex: "none", borderBottom: "1px solid var(--line-hard)" }}>
          {state.spectrumsPoppedOut ? (
            <SpectrumBar dispatch={dispatch} />
          ) : (
            <Spectrums
              state={state}
              dispatch={dispatch}
              frame={frame}
              height={122}
              onPopOut={() => dispatch({ type: "set_spectrums_popped_out", out: true })}
            />
          )}
        </div>
      )}

      {sel.length > 1 && (
        <>
          <div style={{ padding: "14px 12px", borderBottom: "1px solid var(--line-1)", background: "var(--bg-row)", borderLeft: "3px solid var(--accent)" }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 9 }}>
              <div className="tnum" style={{ fontSize: 26, fontWeight: 600, color: "var(--text-hi)", letterSpacing: "-.03em" }}>{sel.length}</div>
              <div style={{ fontSize: 13, color: "var(--text-mid)" }}>nodes selected</div>
            </div>
          </div>
          <div style={{ padding: "10px 12px 12px", borderBottom: "1px solid var(--line-1)", display: "flex", flexDirection: "column", gap: 1 }}>
            {sel.map((n) => (
              <div key={n.id} data-testid={`inspector-sel-${n.id}`} style={{ display: "flex", alignItems: "center", gap: 9, height: 28, paddingRight: 4, background: "var(--bg-row)" }}>
                <div style={{ width: 3, height: 28, flex: "none", background: CAT_COLOR[n.cat] }} />
                <div title={n.name} style={{ flex: "1 1 auto", minWidth: 0, fontSize: 11, color: "var(--text-body)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{n.name}</div>
                {(() => {
                  // The type, with where the palette lists it in the
                  // status line on hover, the same as the single-selection
                  // header.
                  const kind = nodeKindLabel(n, state.userRecipes);
                  return (
                    <div className="kicker" data-testid={`inspector-sel-kind-${n.id}`} data-hint={nodeKindLocation(n, state.userRecipes)} style={{ fontSize: 11, flex: "0 1 auto", minWidth: 0, maxWidth: "60%", color: "var(--text-ghost)", letterSpacing: ".10em", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {kind}
                    </div>
                  );
                })()}
              </div>
            ))}
          </div>
          <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 7 }}>
            <div className="kicker">Actions</div>
            <button
              style={{ all: "unset", cursor: "pointer", display: "flex", alignItems: "center", gap: 9, padding: "8px 11px", background: "var(--accent)", color: "var(--accent-ink)", fontSize: 11, fontWeight: 700, letterSpacing: ".06em" }}
              onClick={() => dispatch({ type: "open_group_dialog", open: true })}
              data-testid="inspector-save-group"
            >
              <GroupGlyph size={12} color="#191715" />
              SAVE AS GROUP
            </button>
            <div style={{ display: "flex", gap: 6 }}>
              {/* A "Group" chip with no onClick used to lead this row,
                  dead on arrival and redundant next to SAVE AS GROUP
                  above, which does the real thing. */}
              <button className="chip" style={{ flex: 1 }} onClick={() => sel.forEach((n) => dispatch({ type: "set_enabled", id: n.id, enabled: !n.enabled }))}>Disable</button>
              <button className="chip" style={{ flex: 1 }} onClick={() => dispatch({ type: "delete_nodes", ids: sel.map((n) => n.id) })}>Delete</button>
            </div>
          </div>
        </>
      )}

      {single && (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "11px 12px", borderBottom: "1px solid var(--line-1)", background: "var(--bg-row)", borderLeft: `3px solid ${CAT_COLOR[single.cat]}` }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div title={single.name} style={{ fontSize: 13, fontWeight: 600, color: "var(--text-hi)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{single.name}</div>
              {(() => {
                // The TYPE under whatever the node is called, so a renamed node still says
                // what it is (2026-09-30: "no matter what a node gets renamed to, we can
                // always tell what type it is"), and where the palette lists it on hover
                // (2026-10-01: "or, just show the node type and on mouse hover the tooltip
                // shows the location", after CATEGORY / SECTION / TYPE ran off a narrow
                // Inspector at 115%). The location goes to the status line, where every
                // other control's hover text shows, not a browser tooltip (2026-10-01:
                // "when mousing over the type label on a node (Example: Hue Range Mask) to
                // display the menu category and sub category path in the status line").
                // nodekind.ts is the one place it is worded.
                const kind = nodeKindLabel(single, state.userRecipes);
                const location = nodeKindLocation(single, state.userRecipes);
                const extra = single.isGroup
                  ? ` · ${single.groupNodes?.length ?? 0} nodes`
                  : state.wires.some((w) => w.to === single.id && w.toPort === "mask")
                    ? " · masked"
                    : "";
                return (
                  <div
                    className="kicker"
                    data-testid="inspector-kind"
                    data-hint={`${location}${extra}`}
                    style={{ fontSize: 11, letterSpacing: ".12em", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
                  >
                    {kind}
                    {extra}
                  </div>
                );
              })()}
            </div>
            {(() => {
              // A tool that pops out of Adjustments pops out from here too
              // ("If a section has a popout view in Adjustments,
              // it should have the same in Graph").
              const NODE_POPOUTS: Record<string, "wheels" | "curves" | "toneeq" | "recolor" | "colorconsole" | undefined> = {
                "heeler.curves": "curves",
                "heeler.color_balance": "wheels",
                "heeler.tone_eq": "toneeq",
                "heeler.recolor": "recolor",
                "heeler.color_console": "colorconsole",
              };
              const tool = NODE_POPOUTS[single.type];
              const isBend = single.type === "heeler.color_bend";
              if (!tool && !isBend) return null;
              const popped = isBend ? state.bendPoppedOut : state.toolPopouts[tool!];
              return (
                <button
                  className="chip popout"
                  data-testid="inspector-popout"
                  data-active={popped || undefined}
                  data-hint={
                    popped
                      ? "Close the floating window and bring this tool back"
                      : "Open this tool in a larger window of its own"
                  }
                  style={{ flex: "none" }}
                  onClick={() =>
                    dispatch(
                      isBend
                        ? { type: "set_bend_popped_out", out: !popped }
                        : { type: "set_tool_popped_out", tool: tool!, out: !popped },
                    )
                  }
                >
                  ⧉
                </button>
              );
            })()}
            {/* Reset, beside the switch, the way a Develop section has one beside
its switch ("nodes don't have a reset on them").*/}
            <button
              className="chip bare"
              data-testid="inspector-reset"
              aria-label={`Reset ${single.name}`}
              data-hint={`Reset ${single.name} to its defaults; strokes and the switch stay`}
              style={{ padding: "2px 6px", color: "var(--text-ghost)", display: "flex", alignItems: "center" }}
              onClick={() => dispatch({ type: "reset_node", id: single.id, ...nodeResetValues(single) })}
            >
              <ResetIcon />
            </button>
            <div
              className="toggle"
              data-on={single.enabled}
              role="switch"
              aria-checked={single.enabled}
              data-testid="inspector-enable"
              onClick={() => dispatch({ type: "set_enabled", id: single.id, enabled: !single.enabled })}
            >
              <div className="dot" />
            </div>
          </div>
          {/* A layer mask turned off says so where the node is read; the
              switch itself is the layer's mask button and the Layer
              menu, one seat. */}
          {maskIsOff(single) && (
            <div className="help" data-testid="inspector-mask-off" style={{ padding: "7px 12px 0" }}>
              Mask off: the layer applies everywhere. {MASK_OFF_GESTURE} on the layer, or use Layer &gt; Enable Layer Mask, to turn it back on.
            </div>
          )}
          {/* The note, right where the node is being inspected. Written
              on blur rather than per keystroke: a note is prose, and
              prose does not want an undo entry per letter. */}
          <div style={{ padding: "7px 12px 0" }}>
            <input
              data-testid="inspector-note"
              aria-label="Note on this node"
              placeholder="Note… (shows on the card)"
              defaultValue={single.note ?? ""}
              key={`${single.id}-note`}
              onBlur={(e) => {
                if ((e.target.value.trim() || undefined) !== single.note) {
                  dispatch({ type: "set_node_note", id: single.id, note: e.target.value });
                }
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                e.stopPropagation();
              }}
              style={{
                width: "100%",
                boxSizing: "border-box",
                background: "var(--bg-app)",
                border: "1px solid var(--line-2)",
                color: "var(--text-body)",
                fontSize: 10.5,
                fontStyle: "italic",
                padding: "4px 7px",
              }}
            />
          </div>

          <div style={{ padding: "12px 12px 10px", borderBottom: "1px solid var(--line-1)", overflowY: "auto" }}>
            {/* contents, not a box: the rows flow in the padded block
                above them, one under the next. An inline-flex here laid
                every row of a node side by side on one line and clipped
                them (seen in the browser, 2026-09-05). */}
            {publishable && (
              <div data-testid="publish-hint" style={{ fontSize: 12, color: "var(--text-faint)", lineHeight: 1.5, marginBottom: 8 }}>
                {PUBLISH_HINT}
              </div>
            )}
            <div
              data-testid="node-params"
              style={{ display: "contents" }}
              onContextMenu={onPublishMenu}
            >
              {/* appState only where a viewer exists to click: the
                  popped-out graph window draws the widgets with the
                  live frame's histograms but without pickers. */}
              <NodeParams
                node={single}
                dispatch={dispatch}
                allNodes={state.nodes}
                gestureActive={state.gesture !== null}
                panelWidth={width}
                appState={hasViewer ? state : undefined}
                depthState={state}
                frame={frame}
                session={{ ...state, treeRoot: state.folderTree?.path ?? null }}
                wires={state.wires}
              />
            </div>
          </div>

          {publishable && publishAt && (() => {
            const member = opened!.groupNodes!.find((n) => n.id === publishAt.node);
            return member ? (
              <PublishMenu
                key={`${publishAt.node}.${publishAt.param}.${publishAt.x}.${publishAt.y}`}
                at={publishAt}
                group={opened!}
                member={member}
                param={publishAt.param}
                label={publishAt.label}
                dispatch={dispatch}
                onClose={() => setPublishAt(null)}
              />
            ) : null;
          })()}
          <div style={{ flex: 1 }} />
          <div onContextMenu={onPublishMenu} style={{ borderTop: "1px solid var(--line-1)", padding: "11px 12px 13px", display: "flex", flexDirection: "column", gap: 9, background: "#1d1c1a" }}>
            <div className="kicker">Node</div>
            {/* Color Balance carried an opacity no engine ever read, so
                its slider moved and the picture did not; graphs saved
                with that param still show the honest "no opacity" row. */}
            {/* A Develop layer's node carries the layer's Opacity, the
                same control its block in Develop shows; old layers
                carry none and read as 100. */}
            {isLayerAdj(single.id) ? (
              <>
                <LayerOpacitySlider node={single} dispatch={dispatch} />
                {/* The layer's Export Mask as Layer (2026-10-01), the box its block in
Develop shows under the Depth mask: one node, two seats.*/}
                <LayerMaskExportRow state={state} layerId={single.id} dispatch={dispatch} testid={`inspector-layer-mask-export-${single.id}`} />
              </>
            ) : ("opacity" in single.params || "opacity" in (REGISTRY_DEFAULTS[single.type] ?? {})) && single.type !== "heeler.color_balance" ? (
              <Slider label="Opacity" param="opacity" node={single} dispatch={dispatch} centered={false} />
            ) : (
              // A node with no opacity of its own. Drawn faint and said
              // in words, so it cannot be mistaken for a slider that
              // refuses to move.
              <div
                className="srow"
                data-testid="opacity-none"
                data-hint="This node has no opacity control; put a Blend Mode or Merge after it to fade it"
                style={{ gridTemplateColumns: "78px 1fr 42px", opacity: 0.4 }}
              >
                <div className="lbl">Opacity</div>
                <div className="strack">
                  <div className="rail" />
                </div>
                <div className="val">n/a</div>
              </div>
            )}
            {state.wires.filter((w) => w.to === single.id && w.toPort === "mask").map((w) => (
              <div key={w.from} style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 9px", background: "#1f1c22", borderLeft: "2px solid var(--cat-masking)" }}>
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--cat-masking-lt)" strokeWidth="1.7"><circle cx="12" cy="12" r="8" /></svg>
                <div style={{ flex: 1, fontSize: 10, color: "#c3bcc9" }}>Mask: {state.nodes.find((n) => n.id === w.from)?.name}</div>
                <div style={{ fontSize: 9, letterSpacing: ".08em", color: "#8f7ab8" }}>SHOW</div>
              </div>
            ))}
          </div>
        </>
      )}

      {sel.length === 0 && (
        <div style={{ padding: "14px 12px", fontSize: 11, color: "var(--text-faint)", lineHeight: 1.6 }}>
          Select a node to edit its parameters. Marquee-drag to select several, then save them as a group.
        </div>
      )}

    </div>
  );
}

export function GroupDialog({ state, dispatch }: { state: State; dispatch: D }) {
  const [name, setName] = useState("Cinematic Portrait Grade");
  const [note, setNote] = useState("");
  const focus = useDialogFocus(state.groupDialogOpen);
  if (!state.groupDialogOpen) return null;
  const count = state.selection.length;
  return (
    <div className="dialog-backdrop" data-testid="group-dialog">
      <div ref={focus} role="dialog" aria-modal="true" aria-label="Save selection as group" tabIndex={-1} className="dialog">
        <div className="dhead">
          <GroupGlyph size={14} />
          <div className="t">Save selection as group</div>
          <div style={{ fontSize: 10, color: "var(--text-ghost)", letterSpacing: ".10em" }} className="tnum">{count} NODES</div>
        </div>
        <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 14 }}>
          <div>
            <div className="kicker" style={{ marginBottom: 6 }}>Name</div>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} aria-label="Group name" />
          </div>
          <div>
            <div className="kicker" style={{ marginBottom: 6 }}>Description</div>
            {/* Controlled, and actually read: this used to be an
                uncontrolled defaultValue nobody collected, so every
                description typed here was discarded with the dialog.
                It lands as the group node's note, the same place the
                inspector's note field writes. */}
            <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} aria-label="Group description" />
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, paddingTop: 2 }}>
            <button className="chip" style={{ padding: "8px 16px" }} onClick={() => dispatch({ type: "open_group_dialog", open: false })}>
              CANCEL
            </button>
            <button
              style={{ all: "unset", cursor: "pointer", padding: "8px 20px", background: "var(--accent)", color: "var(--accent-ink)", fontSize: 11, fontWeight: 700, letterSpacing: ".06em" }}
              onClick={() => dispatch({ type: "group_selection", name, note })}
              data-testid="dialog-save-group"
            >
              SAVE GROUP
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// Memoized against everything but the view-only fields (see viewmemo.ts):
// panning and zooming re-dispatch at wheel rate and change nothing the
// graph or the inspector draws.
export const NodeEditor = memo(NodeEditorImpl, panePropsEqual);
export const Inspector = memo(InspectorImpl, panePropsEqual);
