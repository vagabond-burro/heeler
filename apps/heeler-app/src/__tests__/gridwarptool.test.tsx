// The Grid Warp tool in the viewport and its section furniture: the
// handles draw, a click picks, a drag writes the mesh, a marquee picks
// several, and the chips do what they say.
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import React, { useCallback, useState } from "react";
import { initialState } from "../data";
import { reduce, type Command, type State } from "../state";
import { Viewer } from "../ui/viewer";
import { GridWarpControls, GridWarpOverlay, TurnWheel, heatColor, resolveLineColor, useSectionMeshDrag, type WarpPair } from "../ui/gridwarp";
import { NodeParams } from "../ui/graph";
import { autoLineColor, vertexIndex, vertexPos, restMesh } from "../gridwarp";
import { _clearFlashForTests, currentFlash } from "../ui/hints";

let commands: Command[] = [];
import { publishGridWarpLive, readGridWarpLive } from "../gridwarplive";
let latest: State;
let latestDispatch: (c: Command) => void;
function Harness({
  start,
  controls = false,
  render: custom,
}: {
  start: State;
  controls?: boolean;
  /** a component of its own to drive, given the live state and dispatch */
  render?: (state: State, dispatch: (c: Command) => void) => React.ReactElement;
}) {
  const [state, setState] = useState(start);
  latest = state;
  const send = useCallback((c: Command) => {
    commands.push(c);
    setState((s) => {
      const next = reduce(s, c);
      latest = next;
      return next;
    });
  }, []);
  latestDispatch = send;
  if (custom) return custom(state, send);
  return controls ? <GridWarpControls state={state} dispatch={send} /> : <Viewer state={state} dispatch={send} />;
}

/** A 400 by 300 stage, so a handle at (u, v) sits at (400u, 300v). */
function stubBox(el: HTMLElement, w = 400, h = 300) {
  el.getBoundingClientRect = () =>
    ({ left: 0, top: 0, right: w, bottom: h, width: w, height: h, x: 0, y: 0, toJSON() {} }) as DOMRect;
  Object.defineProperty(el, "offsetWidth", { configurable: true, value: w });
  Object.defineProperty(el, "offsetHeight", { configurable: true, value: h });
}

const armed = (): State => ({ ...reduce(initialState(), { type: "select_image", id: "4869" }), tool: "gridwarp" });

beforeEach(() => {
  commands = [];
});

describe("the grid warp tool", () => {
  it("draws the default grid's handles and lines over a photo with no warp yet", () => {
    render(<Harness start={armed()} />);
    expect(screen.getAllByTestId("gridwarp-vertex")).toHaveLength(20);
    expect(screen.getAllByTestId("gridwarp-line")).toHaveLength(9);
    // The tool is armed from its section, not the canvas header.
    expect(screen.queryByTestId("btn-tool-gridwarp")).toBeNull();
  });

  it("a click picks the nearest handle, a drag moves it and writes the mesh, a marquee picks several", () => {
    render(<Harness start={armed()} />);
    const overlay = screen.getByTestId("gridwarp-overlay");
    stubBox(screen.getByTestId("gridwarp-frame"));
    const m = restMesh(4, 3);
    const k = vertexIndex(m, 1, 1); // at (0.25, 1/3): pixel (100, 100)
    fireEvent.mouseDown(overlay, { button: 0, clientX: 100, clientY: 100 });
    expect(commands.find((c) => c.type === "grid_warp_select")).toEqual({ type: "grid_warp_select", ids: [k] });
    fireEvent.mouseUp(overlay, { clientX: 100, clientY: 100 });
    expect(commands.some((c) => c.type === "grid_warp_mesh")).toBe(false);
    expect(latest.gridWarp.selected).toEqual([k]);
    // Drag it forty pixels right: a tenth of the frame.
    fireEvent.mouseDown(overlay, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.mouseMove(overlay, { buttons: 1, clientX: 140, clientY: 100 });
    // Mid-drag the handle has moved on screen: a tenth of the frame,
    // from 25% to 35%.
    const handles = screen.getAllByTestId("gridwarp-vertex");
    expect(handles[k].style.left).toBe("35%");
    fireEvent.mouseUp(overlay, { clientX: 140, clientY: 100 });
    const mesh = commands.find((c) => c.type === "grid_warp_mesh") as Extract<Command, { type: "grid_warp_mesh" }>;
    expect(mesh).toBeTruthy();
    expect(mesh.mesh.d[k][0]).toBeCloseTo(0.1, 6);
    expect(mesh.mesh.d[k][1]).toBeCloseTo(0, 6);
    // The neighbor came along at half (reach one, the default).
    expect(mesh.mesh.d[vertexIndex(m, 2, 1)][0]).toBeCloseTo(0.05, 6);
    expect(latest.nodes.some((n) => n.type === "heeler.grid_warp")).toBe(true);
    // A marquee over the moved handle's new place picks it.
    commands = [];
    fireEvent.mouseDown(overlay, { button: 0, clientX: 130, clientY: 80 });
    fireEvent.mouseMove(overlay, { buttons: 1, clientX: 150, clientY: 120 });
    expect(screen.getByTestId("gridwarp-marquee")).toBeTruthy();
    fireEvent.mouseUp(overlay, { clientX: 150, clientY: 120 });
    expect(commands.find((c) => c.type === "grid_warp_select")).toEqual({ type: "grid_warp_select", ids: [k], mode: "set" });
  });

  it("a viewport drag's gesture ends on window blur and on unmount, never dangling", () => {
    const view = render(<Harness start={armed()} />);
    const overlay = screen.getByTestId("gridwarp-overlay");
    stubBox(screen.getByTestId("gridwarp-frame"));
    fireEvent.mouseDown(overlay, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.mouseMove(document, { buttons: 1, clientX: 140, clientY: 100 });
    // The mouseup is lost to the window going away: the blur ends the
    // drag and writes what was dragged, one end for one begin.
    fireEvent.blur(window);
    expect(commands.filter((c) => c.type === "begin_gesture")).toHaveLength(1);
    expect(commands.filter((c) => c.type === "end_gesture")).toHaveLength(1);
    expect(commands.some((c) => c.type === "grid_warp_mesh")).toBe(true);
    expect(latest.gesture).toBeNull();
    fireEvent.mouseUp(document);
    expect(commands.filter((c) => c.type === "end_gesture")).toHaveLength(1);
    // Unmounted mid-drag (compare view, a remount on a photo switch):
    // the open gesture is ended, not left to swallow later writes.
    // The handle now sits at (140, 100) from the first drag.
    commands = [];
    fireEvent.mouseDown(overlay, { button: 0, clientX: 140, clientY: 100 });
    fireEvent.mouseMove(document, { buttons: 1, clientX: 140, clientY: 100 });
    view.unmount();
    expect(commands.filter((c) => c.type === "end_gesture")).toHaveLength(1);
    expect(commands.some((c) => c.type === "grid_warp_mesh")).toBe(false);
    expect(latest.gesture).toBeNull();
  });

  it("a handle on the frame's edge can be taken by its outer half and dragged out past the frame", () => {
    // "I can't seem to select the handles on the edge", then "I
    // still can't drag the edge points outside the frame." The click lands
    // past the frame, on the overlay's padding, the edge handle is the
    // nearest, and the drag follows the pointer off the frame and off the
    // overlay alike.
    render(<Harness start={armed()} />);
    const overlay = screen.getByTestId("gridwarp-overlay");
    stubBox(screen.getByTestId("gridwarp-frame"));
    const m = restMesh(4, 3);
    const k = vertexIndex(m, 0, 1); // at (0, 1/3): pixel (0, 100)
    fireEvent.mouseDown(overlay, { button: 0, clientX: -4, clientY: 100 });
    expect(commands.find((c) => c.type === "grid_warp_select")).toEqual({ type: "grid_warp_select", ids: [k] });
    fireEvent.mouseMove(document, { buttons: 1, clientX: -44, clientY: 100 });
    fireEvent.mouseUp(document, { clientX: -44, clientY: 100 });
    const mesh = commands.find((c) => c.type === "grid_warp_mesh") as Extract<Command, { type: "grid_warp_mesh" }>;
    // Forty pixels outward on a 400 pixel frame: a tenth past the edge.
    expect(mesh.mesh.d[k][0]).toBeCloseTo(-0.1, 6);
    expect(latest.nodes.find((n) => n.type === "heeler.grid_warp")).toBeTruthy();
  });

  it("the wheel turns the pick and the pad pulls it, live from the section, one undo step each", () => {
    // Two handles a half frame apart on the middle row, on a square
    // frame (jsdom decodes nothing, so the aspect stays one).
    const m = restMesh(4, 3);
    const pair = [vertexIndex(m, 1, 1), vertexIndex(m, 3, 1)];
    let s = reduce(armed(), { type: "grid_warp_select", ids: pair });
    s = reduce(s, { type: "set_grid_warp_ui", influence: 0 });
    render(<Harness start={s} controls />);
    const wheel = screen.getByTestId("gridwarp-turn");
    stubBox(wheel, 44, 44);
    // A quarter turn round the wheel: from three o'clock to six.
    fireEvent.mouseDown(wheel, { button: 0, clientX: 44, clientY: 22 });
    fireEvent.mouseMove(document, { buttons: 1, clientX: 22, clientY: 44 });
    expect(screen.getByTestId("gridwarp-turn-readout").textContent).toBe("90°");
    // Mid-drag the mesh is live, not written.
    expect(readGridWarpLive(latestDispatch)).not.toBeNull();
    expect(latest.gridWarp.live).toBeNull();
    expect(commands.some((c) => c.type === "grid_warp_live")).toBe(false);
    expect(latest.gesture).toBe("gridwarp.mesh");
    expect(latest.nodes.some((n) => n.type === "heeler.grid_warp")).toBe(false);
    fireEvent.mouseUp(document, { clientX: 22, clientY: 44 });
    expect(latest.gridWarp.live).toBeNull();
    expect(latest.gesture).toBeNull();
    expect(screen.getByTestId("gridwarp-turn-readout").textContent).toBe("0°");
    const turned = commands.filter((c) => c.type === "grid_warp_mesh") as Extract<Command, { type: "grid_warp_mesh" }>[];
    expect(turned).toHaveLength(1);
    const a = vertexPos(turned[0].mesh, pair[0]);
    const b = vertexPos(turned[0].mesh, pair[1]);
    expect(a[0]).toBeCloseTo(0.5, 6);
    expect(b[0]).toBeCloseTo(0.5, 6);
    expect(Math.abs(a[1] - b[1])).toBeCloseTo(0.5, 6);
    expect(latest.undoStack[latest.undoStack.length - 1].label).toBe("Grid Warp: drag");
    // The pad, from the turned mesh: fifty pixels right doubles the
    // pick's width about its center, and the readout says so.
    commands = [];
    const pad = screen.getByTestId("gridwarp-pull");
    fireEvent.mouseDown(pad, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.mouseMove(document, { buttons: 1, clientX: 150, clientY: 100 });
    expect(screen.getByTestId("gridwarp-pull-readout").textContent).toBe("200% x 100%");
    fireEvent.mouseUp(document, { clientX: 150, clientY: 100 });
    const pulled = commands.filter((c) => c.type === "grid_warp_mesh") as Extract<Command, { type: "grid_warp_mesh" }>[];
    expect(pulled).toHaveLength(1);
    // The pair was vertical, a half apart; width doubled leaves x alone,
    // and the height, untouched, stays a half.
    const pa = vertexPos(pulled[0].mesh, pair[0]);
    const pb = vertexPos(pulled[0].mesh, pair[1]);
    expect(Math.abs(pa[1] - pb[1])).toBeCloseTo(0.5, 6);
    // Shift: uniform, the larger pull on both axes.
    commands = [];
    fireEvent.mouseDown(pad, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.mouseMove(document, { buttons: 1, clientX: 100, clientY: 150, shiftKey: true });
    expect(screen.getByTestId("gridwarp-pull-readout").textContent).toBe("200% x 200%");
    fireEvent.mouseUp(document, { clientX: 100, clientY: 150 });
    const uni = (commands.find((c) => c.type === "grid_warp_mesh") as Extract<Command, { type: "grid_warp_mesh" }>).mesh;
    expect(Math.abs(vertexPos(uni, pair[0])[1] - vertexPos(uni, pair[1])[1])).toBeCloseTo(1, 6);
    // With nothing picked both are dimmed and do nothing.
    fireEvent.click(screen.getByTestId("gridwarp-pick-none"));
    commands = [];
    fireEvent.mouseDown(wheel, { button: 0, clientX: 44, clientY: 22 });
    fireEvent.mouseMove(document, { buttons: 1, clientX: 22, clientY: 44 });
    fireEvent.mouseUp(document, { clientX: 22, clientY: 44 });
    expect(commands.some((c) => c.type === "grid_warp_mesh" || c.type === "grid_warp_live")).toBe(false);
  });

  it("armed on a section that is switched off, the status line says the picture will not follow", () => {
    _clearFlashForTests();
    let s = armed();
    const rest = restMesh(4, 3);
    s = reduce(s, { type: "grid_warp_mesh", mesh: rest });
    // Switching off puts the tool away; arming it again on the off
    // section is the case the cue is for.
    s = reduce(s, { type: "set_category", title: "Grid Warp", on: false });
    expect(s.tool).toBe("none");
    s = reduce(s, { type: "set_tool", tool: "gridwarp" });
    expect(s.nodes.find((n) => n.type === "heeler.grid_warp")!.enabled).toBe(false);
    render(<Harness start={s} />);
    expect(currentFlash()).toMatch(/switched off/);
    // Nothing switched itself on.
    expect(latest.nodes.find((n) => n.type === "heeler.grid_warp")!.enabled).toBe(false);
    _clearFlashForTests();
  });

  it("the Graph and Canvas inspector shows the section's controls for the node", () => {
    let s = armed();
    s = reduce(s, { type: "grid_warp_mesh", mesh: restMesh(4, 3) });
    const node = s.nodes.find((n) => n.type === "heeler.grid_warp")!;
    render(<NodeParams node={node} dispatch={() => {}} appState={s} allNodes={s.nodes} wires={s.wires} />);
    expect(screen.getByTestId("gridwarp-controls")).toBeTruthy();
    expect(screen.queryByTestId("port-guide")).toBeNull();
  });

  it("the live channel meets a guarded dispatch: the viewer's wrapper reads what the section published", async () => {
    // A view may hand the viewer a wrapper made fresh every render (the
    // panel's build-on-touch wrapper), and the panel the plain dispatch.
    // Keyed on the wrapper, the channel never connected ("I don't see
    // any pixels update until I release the mouse").
    const { withRootDispatch } = await import("../rootdispatch");
    const wrap = (inner: (c: Command) => void) => withRootDispatch((c: Command) => inner(c), inner);
    const raw = (c: Command) => { commands.push(c); };
    const mesh = restMesh(4, 3);
    publishGridWarpLive(raw, mesh);
    expect(readGridWarpLive(wrap(raw))).toBe(mesh);
    expect(readGridWarpLive(wrap(wrap(raw)))).toBe(mesh);
    publishGridWarpLive(wrap(raw), null);
    expect(readGridWarpLive(raw)).toBeNull();
  });

  it("a section drag cannot write back after the photograph changes", () => {
    const start = { ...armed(), gridWarp: { ...armed().gridWarp, selected: [6,8] } };
    const dispatch = (c: Command) => { commands.push(c); };
    const view = render(<GridWarpControls state={start} dispatch={dispatch} />);
    const wheel = screen.getByTestId("gridwarp-turn");
    stubBox(wheel,44,44);
    fireEvent.mouseDown(wheel,{button:0,clientX:44,clientY:22});
    fireEvent.mouseMove(document,{buttons:1,clientX:22,clientY:44});
    expect(readGridWarpLive(dispatch)).not.toBeNull();
    view.rerender(<GridWarpControls state={{...start,activeImage:"4875",tool:"none"}} dispatch={dispatch} />);
    fireEvent.mouseUp(document);
    expect(readGridWarpLive(dispatch)).toBeNull();
    expect(commands.some((c) => c.type === "grid_warp_mesh")).toBe(false);
  });

  it("the section's first portrait drag uses the overlay's portrait grid", () => {
    const state = { ...armed(), gridWarp: { ...armed().gridWarp, selected: [5,6] } };
    const dispatch = (c: Command) => { commands.push(c); };
    // The wheel drives whatever drag it is handed; here the section's
    // mesh drag on a portrait frame.
    function Wheel() {
      const drag = useSectionMeshDrag(state, dispatch, 2 / 3, true);
      return <TurnWheel drag={drag} disabled={false} />;
    }
    render(<Wheel />);
    const wheel = screen.getByTestId("gridwarp-turn");
    stubBox(wheel,44,44);
    fireEvent.mouseDown(wheel,{button:0,clientX:44,clientY:22});
    fireEvent.mouseMove(document,{buttons:1,clientX:22,clientY:44});
    fireEvent.mouseUp(document);
    const write = commands.find((c) => c.type === "grid_warp_mesh") as Extract<Command,{type:"grid_warp_mesh"}>;
    expect(write.mesh).toMatchObject({cols:3,rows:4});
  });

  it("a second warp inspector does not edit the first warp and popouts show counts", () => {
    const state = reduce(armed(),{type:"grid_warp_mesh",mesh:restMesh(4,3)});
    const node = {...state.nodes.find((n) => n.type === "heeler.grid_warp")!,id:"second",params:{cols:8,rows:6}};
    const view = render(<NodeParams node={node} dispatch={() => {}} appState={{...state,nodes:[...state.nodes,node]}} />);
    expect(screen.queryByTestId("gridwarp-controls")).toBeNull();
    expect(screen.getByTestId("gridwarp-counts").textContent).toBe("8 columns x 6 rows");
    view.rerender(<NodeParams node={node} dispatch={() => {}} />);
    expect(screen.getByTestId("gridwarp-counts").textContent).toBe("8 columns x 6 rows");
  });

  it("alt-click on a bent line removes it, answered from the drawn position", () => {
    // Column two of five pulled 0.2 frame widths right: the line on
    // screen runs straight at x = 0.7 while its rest position is 0.5.
    // A click on the visible line meant "remove"; testing the rest
    // lines there answered "insert".
    let s = armed();
    const mesh = restMesh(4, 3);
    for (let j = 0; j <= 3; j++) mesh.d[j * 5 + 2] = [0.2, 0];
    s = reduce(s, { type: "grid_warp_mesh", mesh });
    render(<Harness start={s} />);
    const overlay = screen.getByTestId("gridwarp-overlay");
    stubBox(screen.getByTestId("gridwarp-frame"));
    // (0.7, 0.5) over the stubbed 400 x 300 frame box.
    fireEvent.mouseDown(overlay, { button: 0, altKey: true, clientX: 280, clientY: 150 });
    const lines = commands.filter((c) => c.type === "grid_warp_line");
    expect(lines).toEqual([{ type: "grid_warp_line", axis: "col", remove: 2 }]);
    expect(latest.nodes.find((n) => n.type === "heeler.grid_warp")!.params).toMatchObject({ cols: 3, rows: 3 });
  });

  it("the drag preview stays up after release until the engine's frame lands, and the next drag bends from that frame", () => {
    // "when I release the pixels briefly snap to where
    // they were before the transform then go back to where they
    // should be."
    const live = { current: null as WarpPair | null };
    let s = armed();
    const frame = { w: 400, h: 300 };
    // The vertex (1,1) sits at (0.25, 1/3); where each map puts it.
    const at = (f: (u: number, v: number) => [number, number]) => f(0.25, 1 / 3)[0];
    const view = render(
      <Harness start={s} render={(st, send) => <GridWarpOverlay state={st} dispatch={send} frame={frame} previewUrl="blob:one" live={live} />} />,
    );
    const overlay = screen.getByTestId("gridwarp-overlay");
    stubBox(screen.getByTestId("gridwarp-frame"));
    fireEvent.mouseDown(overlay, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.mouseMove(document, { buttons: 1, clientX: 140, clientY: 100 });
    expect(live.current).not.toBeNull();
    fireEvent.mouseUp(document, { clientX: 140, clientY: 100 });
    // Released: the node has the new mesh, and the preview is still up,
    // bending the old frame by the drag.
    expect(latest.nodes.some((n) => n.type === "heeler.grid_warp")).toBe(true);
    expect(live.current).not.toBeNull();
    expect(at(live.current!.live)).toBeCloseTo(0.35, 6);
    expect(at(live.current!.base)).toBeCloseTo(0.25, 6);
    // A second drag before any frame lands bends from the frame's
    // mesh (at rest), not from the node's, so the warp is not doubled.
    fireEvent.mouseDown(overlay, { button: 0, clientX: 140, clientY: 100 });
    fireEvent.mouseMove(document, { buttons: 1, clientX: 160, clientY: 100 });
    expect(at(live.current!.base)).toBeCloseTo(0.25, 6);
    expect(at(live.current!.live)).toBeCloseTo(0.4, 6);
    fireEvent.mouseUp(document, { clientX: 160, clientY: 100 });
    expect(live.current).not.toBeNull();
    // The engine's frame lands: the preview steps aside, and the frame
    // now carries the node's mesh.
    s = latest;
    view.rerender(<Harness start={s} render={(st, send) => <GridWarpOverlay state={st} dispatch={send} frame={frame} previewUrl="blob:two" live={live} />} />);
    expect(live.current).toBeNull();
  });

  it("alt-click adds lines through the point", () => {
    let s = armed();
    s = reduce(s, { type: "grid_warp_select", ids: [6, 8] });
    render(<Harness start={s} />);
    expect(screen.queryByTestId("gridwarp-ring")).toBeNull();
    const overlay = screen.getByTestId("gridwarp-overlay");
    stubBox(screen.getByTestId("gridwarp-frame"));
    fireEvent.mouseDown(overlay, { button: 0, altKey: true, clientX: 60, clientY: 60 });
    const lines = commands.filter((c) => c.type === "grid_warp_line");
    expect(lines).toHaveLength(2);
    expect(latest.nodes.find((n) => n.type === "heeler.grid_warp")!.params).toMatchObject({ cols: 5, rows: 4 });
  });

  it("the section: dragged counts, the link, influence, heat icons, picks, edges, reset", () => {
    render(<Harness start={armed()} controls />);
    const node = () => latest.nodes.find((n) => n.type === "heeler.grid_warp")!;
    // Columns is a number you drag: six pixels a step.
    fireEvent.mouseDown(screen.getByTestId("gridwarp-cols"), { button: 0, clientX: 100 });
    fireEvent.mouseMove(document, { buttons: 1, clientX: 112 });
    fireEvent.mouseUp(document, { clientX: 112 });
    expect(node().params).toMatchObject({ cols: 6, rows: 3 });
    expect(screen.getByTestId("gridwarp-cols").textContent).toBe("6");
    // Linked, rows follow by the same step.
    fireEvent.click(screen.getByTestId("gridwarp-link"));
    expect(latest.gridWarp.link).toBe(true);
    fireEvent.mouseDown(screen.getByTestId("gridwarp-rows"), { button: 0, clientX: 100 });
    fireEvent.mouseMove(document, { buttons: 1, clientX: 106 });
    fireEvent.mouseUp(document, { clientX: 106 });
    expect(node().params).toMatchObject({ cols: 7, rows: 4 });
    // A click without a drag opens the number for typing.
    fireEvent.mouseDown(screen.getByTestId("gridwarp-cols"), { button: 0, clientX: 100 });
    fireEvent.mouseUp(document, { clientX: 100 });
    const input = screen.getByTestId("gridwarp-cols-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "5" } });
    fireEvent.keyDown(input, { key: "Enter" });
    // Linked: two fewer columns, two fewer rows.
    expect(node().params).toMatchObject({ cols: 5, rows: 2 });
    fireEvent.click(screen.getByTestId("gridwarp-link"));
    // Influence is dragged the same way.
    fireEvent.mouseDown(screen.getByTestId("gridwarp-influence"), { button: 0, clientX: 0 });
    fireEvent.mouseMove(document, { buttons: 1, clientX: 12 });
    fireEvent.mouseUp(document, { clientX: 12 });
    expect(latest.gridWarp.influence).toBe(3);
    fireEvent.click(screen.getByTestId("gridwarp-heat-chroma"));
    expect(latest.gridWarp.heat).toBe("chroma");
    expect(screen.getByTestId("gridwarp-heat-chroma")).toHaveAttribute("data-active", "true");
    fireEvent.click(screen.getByTestId("gridwarp-pick-all"));
    expect(latest.gridWarp.selected).toHaveLength(6 * 3);
    fireEvent.click(screen.getByTestId("gridwarp-pick-shrink"));
    expect(latest.gridWarp.selected).toHaveLength(4 * 1);
    fireEvent.click(screen.getByTestId("gridwarp-edges-transparent"));
    expect(latest.nodes.find((n) => n.type === "heeler.grid_warp")!.textParams!.edges).toBe("transparent");
    // No Reset chip beside the tool: the section header's Reset does it.
    expect(screen.queryByTestId("gridwarp-reset")).toBeNull();
    fireEvent.click(screen.getByTestId("gridwarp-tool"));
    expect(latest.tool).toBe("none");
  });

  it("the lines take the opposite of the photograph, and the sliders take over from that", () => {
    // A warm, bright photograph gets dark, cool lines; a dark gray one
    // gets light gray lines, no color cast.
    expect(autoLineColor({ r: 0.9, g: 0.6, b: 0.3 })).toEqual({ hue: 210, luma: 12, sat: 0.75 });
    expect(autoLineColor({ r: 0.2, g: 0.2, b: 0.22 })).toMatchObject({ luma: 92, sat: 0 });
    expect(autoLineColor(null)).toEqual({ hue: 0, luma: 92, sat: 0 });
    const auto = { hue: 210, luma: 12, sat: 0 };
    expect(resolveLineColor({ hue: 120, luma: null }, auto)).toEqual({ hue: 120, luma: 12, sat: 0.75 });
    expect(resolveLineColor({ hue: null, luma: 50 }, auto)).toEqual({ hue: 210, luma: 50, sat: 0 });
    // The panel: a slider write lands in the shared line color, Auto
    // clears it, and the grid takes it.
    render(<Harness start={armed()} controls />);
    expect(screen.getByTestId("gridwarp-line-auto")).toHaveAttribute("data-active", "true");
    let s = reduce(armed(), { type: "set_line_color", hue: 400, luma: 130 });
    expect(s.lineColor).toEqual({ hue: 40, luma: 100 });
    s = reduce(s, { type: "set_line_color", hue: null });
    expect(s.lineColor).toEqual({ hue: null, luma: 100 });
    fireEvent.click(screen.getByTestId("gridwarp-line-auto"));
    expect(latest.lineColor).toEqual({ hue: null, luma: null });
  });

  it("the heat map's colors: luma from white to black, chroma from red to blue", () => {
    expect(heatColor(1, true, "luma")).toBe("rgb(255,255,255)");
    expect(heatColor(0, false, "luma")).toBe("rgb(40,40,40)");
    expect(heatColor(1, true, "chroma")).toBe("rgb(240,60,40)");
    expect(heatColor(0, false, "chroma")).toBe("rgb(40,60,220)");
    expect(heatColor(0.5, false, "off")).toBe("#8a8f93");
  });
});

describe("what an untouched photograph pays for the warp previews", () => {
  /// The preview canvas decodes whatever frame it is handed, and the
  /// frame changes on every engine render. Mounting it for both warps
  /// on every photograph would charge two decodes per render to
  /// photographs with no warp on them at all, which is why it is
  /// mounted only where there is something to preview: the tool in
  /// hand, or the node on the photograph.
  it("mounts no preview canvas until a warp tool or a warp node is there", async () => {
    const { render, screen } = await import("@testing-library/react");
    const { App } = await import("../app");
    render(<App />);
    // A fresh photograph: no warp tool armed, no warp nodes.
    expect(screen.queryAllByTestId("gridwarp-preview")).toHaveLength(0);
  });
});
