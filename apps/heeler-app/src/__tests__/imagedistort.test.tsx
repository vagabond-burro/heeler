// Skew and distort on the Transform tool, and the image layer row's
// buttons as pictures (2026-09-30: "Replace button labels with icons.
// Next to transform need a skew and distort tool, or support modifier
// keys on the transform to grab the corner points and drag them
// independently."), then one seat for each (2026-10-01: "We already have
// transform and warp on the toolbar. So there is redundancy with having
// these buttons on the layers"): Skew and Perspective are modes of the
// toolbar's Transform slot, Distort is the slot's Warp, and the panel
// keeps only what has no other seat.
//
// What is held here: each modifier (Command on a Mac, Ctrl on Windows)
// and each slot mode lands the corners it names; the body's Command
// move is untouched; a fold is refused and said; one undo step per drag;
// Escape restores; the frame-shape stamp; the typed fields after a skew
// and a distort; Reset squares it; the panel's buttons carry names, tips
// and outcome-first hints and the moved ones are gone; the status line
// names the keys per platform.
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { initialState } from "../data";
import { layerQuad, reduce, transformBox, transformDragOf, type Command, type State } from "../state";
import { serializeGraph } from "../bridge";
import { runCommand } from "../commands";
import { setMacForTests } from "../platform";
import { cornersOf } from "../quadmap";
import { crossing, flipQuad, isAffine, noteFrameAspect, quadFolds, reshapeByHandle, type Pt } from "../imagelayers";
import { TransformFields } from "../ui/imagelayers";
import { TransformOverlay, reshapeFor, transformKeysLine, type TransformDrag } from "../ui/overlays";
import { StatusBar } from "../ui/statusbar";
import { ShapeToolButton } from "../ui/shapetool";
import { uiSettingsCommands, uiSettingsSnapshot } from "../settings";
import { _clearFlashForTests, currentFlash } from "../ui/hints";

afterEach(() => {
  setMacForTests(null);
  _clearFlashForTests();
});

function run(s: State, ...cmds: Command[]): State {
  return cmds.reduce(reduce, s);
}

/** A 3:2 frame with the Finish tab up, and a 2:1 picture fitted into
 * it: full width, 0.75 high. */
const REST = { x: 0, y: 0.125, w: 1, h: 0.75 };
function withLayer(): { s: State; id: string } {
  const base = initialState();
  noteFrameAspect(base.activeImage, 1.5);
  const s = run({ ...base, mode: "simple", panelTab: "layers" }, {
    type: "art_add_image_layer",
    source: { kind: "file", path: "/pictures/logo.png" },
    name: "logo",
    box: REST,
  });
  return { s, id: s.artActive! };
}
const RECT: Pt[] = [[0, 0.125], [1, 0.125], [1, 0.875], [0, 0.875]];

const close = (a: Pt[], b: Pt[]) =>
  a.forEach((p, i) => {
    expect(p[0]).toBeCloseTo(b[i][0], 6);
    expect(p[1]).toBeCloseTo(b[i][1], 6);
  });

function mount(s: State, id: string, seen: Command[], reshape: TransformDrag = "scale", mode: "transform" | "warp" = "transform") {
  const r = render(
    <TransformOverlay
      blendId={id}
      box={transformBox(s, id)}
      quad={layerQuad(s, id) as Pt[]}
      mode={mode}
      dispatch={(c) => seen.push(c)}
      aspect={1.5}
      reshape={reshape}
    />,
  );
  const root = screen.getByTestId(`transform-overlay-${mode}`);
  Object.defineProperty(root, "offsetWidth", { value: 300, configurable: true });
  Object.defineProperty(root, "offsetHeight", { value: 200, configurable: true });
  root.getBoundingClientRect = () => ({ left: 10, top: 20, width: 300, height: 200, right: 310, bottom: 220 }) as DOMRect;
  const at = (fx: number, fy: number) => ({ clientX: 10 + fx * 300, clientY: 20 + fy * 200 });
  return { r, root, at };
}

function lastQuad(seen: Command[]): Pt[] {
  const w = [...seen].reverse().find((c) => c.type === "art_set_quad") as { corners: Pt[] } | undefined;
  if (!w) throw new Error("no quad written");
  return w.corners;
}

type Keys = { metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean };
/** Presses a handle at `from`, moves to `to` with the keys held, lets go. */
function drag(root: HTMLElement, at: (x: number, y: number) => object, handle: string, from: Pt, to: Pt, keys: Keys = {}) {
  fireEvent.mouseDown(screen.getByTestId(handle), { ...at(from[0], from[1]), ...keys });
  fireEvent.mouseMove(root, { ...at(to[0], to[1]), buttons: 1, ...keys });
  fireEvent.mouseUp(root);
}

describe("the keys on Transform's handles", () => {
  it("Ctrl on Windows moves a corner alone (distort)", () => {
    const { s, id } = withLayer();
    const seen: Command[] = [];
    const { root, at } = mount(s, id, seen);
    drag(root, at, "transform-handle-2", [1, 0.875], [0.8, 0.7], { ctrlKey: true });
    close(lastQuad(seen), [[0, 0.125], [1, 0.125], [0.8, 0.7], [0, 0.875]]);
  });

  it("Command on a Mac moves a corner alone; Control there is not the key and the corner sizes", () => {
    setMacForTests(true);
    const { s, id } = withLayer();
    const seen: Command[] = [];
    const { root, at } = mount(s, id, seen);
    drag(root, at, "transform-handle-2", [1, 0.875], [0.8, 0.7], { metaKey: true });
    close(lastQuad(seen), [[0, 0.125], [1, 0.125], [0.8, 0.7], [0, 0.875]]);
    seen.length = 0;
    drag(root, at, "transform-handle-2", [1, 0.875], [0.8, 0.7], { ctrlKey: true });
    close(lastQuad(seen), [[0, 0.125], [0.8, 0.125], [0.8, 0.7], [0, 0.7]]);
  });

  it("the modifier map, per platform", () => {
    const k = (o: Keys) => ({ metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...o });
    expect(reshapeFor(k({ ctrlKey: true }), true, "scale")).toBe("distort");
    expect(reshapeFor(k({ metaKey: true }), true, "scale")).toBeNull();
    expect(reshapeFor(k({ ctrlKey: true, shiftKey: true }), false, "scale")).toBe("skew");
    expect(reshapeFor(k({ ctrlKey: true, shiftKey: true, altKey: true }), true, "scale")).toBe("perspective");
    expect(reshapeFor(k({ ctrlKey: true, shiftKey: true, altKey: true }), false, "scale")).toBe("skew");
    expect(reshapeFor(k({ shiftKey: true }), true, "scale")).toBeNull();
    setMacForTests(true);
    expect(reshapeFor(k({ metaKey: true }), true, "scale")).toBe("distort");
    expect(reshapeFor(k({ ctrlKey: true }), true, "scale")).toBeNull();
    expect(reshapeFor(k({ metaKey: true, shiftKey: true, altKey: true }), true, "scale")).toBe("perspective");
    // The slot's modes: no key needed, and the keys still win.
    expect(reshapeFor(k({}), false, "skew")).toBe("skew");
    expect(reshapeFor(k({}), true, "skew")).toBe("skew");
    expect(reshapeFor(k({ altKey: true, shiftKey: true }), true, "skew")).toBe("perspective");
    expect(reshapeFor(k({}), true, "perspective")).toBe("perspective");
    expect(reshapeFor(k({}), false, "perspective")).toBe("skew");
    expect(reshapeFor(k({ metaKey: true }), true, "perspective")).toBe("distort");
    expect(reshapeFor(k({ metaKey: true }), true, "skew")).toBe("distort");
  });

  it("Ctrl+Shift on an edge slides it along itself (skew)", () => {
    const { s, id } = withLayer();
    const seen: Command[] = [];
    const { root, at } = mount(s, id, seen);
    drag(root, at, "transform-edge-0", [0.5, 0.125], [0.6, 0.2], { ctrlKey: true, shiftKey: true });
    close(lastQuad(seen), [[0.1, 0.125], [1.1, 0.125], [1, 0.875], [0, 0.875]]);
  });

  it("Ctrl+Shift on a corner slides its edge along itself, the edge the pointer follows (a shear)", () => {
    const { s, id } = withLayer();
    const seen: Command[] = [];
    const { root, at } = mount(s, id, seen);
    drag(root, at, "transform-handle-0", [0, 0.125], [0.02, 0.325], { ctrlKey: true, shiftKey: true });
    close(lastQuad(seen), [[0, 0.325], [1, 0.125], [1, 0.875], [0, 1.075]]);
  });

  it("Ctrl+Alt+Shift on a corner pinches in perspective, the far corner of that edge coming the other way", () => {
    const { s, id } = withLayer();
    const seen: Command[] = [];
    const { root, at } = mount(s, id, seen);
    drag(root, at, "transform-handle-1", [1, 0.125], [0.9, 0.13], { ctrlKey: true, shiftKey: true, altKey: true });
    const q = lastQuad(seen);
    close(q, [[0.1, 0.125], [0.9, 0.125], [1, 0.875], [0, 0.875]]);
    expect(isAffine(q, 1.5)).toBe(false);
  });

  it("Ctrl on the body still moves without snapping: the body and the corners are different targets", () => {
    const { s, id } = withLayer();
    const seen: Command[] = [];
    const { root, at } = mount(s, id, seen);
    drag(root, at, "transform-body", [0.5, 0.5], [0.51, 0.5], { ctrlKey: true });
    close(lastQuad(seen), RECT.map(([x, y]) => [x + 0.01, y] as Pt));
  });

  it("the plain corner still sizes, and Shift still keeps proportions", () => {
    const { s, id } = withLayer();
    const seen: Command[] = [];
    const { root, at } = mount(s, id, seen);
    drag(root, at, "transform-handle-2", [1, 0.875], [0.8, 0.7]);
    close(lastQuad(seen), [[0, 0.125], [0.8, 0.125], [0.8, 0.7], [0, 0.7]]);
  });
});

describe("the Transform slot's modes, no key held", () => {
  it("Warp (the old Distort) moves a corner alone", () => {
    const { s, id } = withLayer();
    const seen: Command[] = [];
    const { root, at } = mount(s, id, seen, "scale", "warp");
    drag(root, at, "transform-handle-3", [0, 0.875], [0.1, 0.95]);
    close(lastQuad(seen), [[0, 0.125], [1, 0.125], [1, 0.875], [0.1, 0.95]]);
  });

  it("Skew slides an edge along itself", () => {
    const { s, id } = withLayer();
    const seen: Command[] = [];
    const { root, at } = mount(s, id, seen, "skew");
    expect(root.getAttribute("data-reshape")).toBe("skew");
    drag(root, at, "transform-edge-1", [1, 0.5], [1.05, 0.6]);
    close(lastQuad(seen), [[0, 0.125], [1, 0.225], [1, 0.975], [0, 0.875]]);
  });

  it("Skew on a corner keeps a parallelogram: the corner slides along an edge and the opposite sides stay parallel", () => {
    const { s, id } = withLayer();
    const seen: Command[] = [];
    const { root, at } = mount(s, id, seen, "skew");
    drag(root, at, "transform-handle-0", [0, 0.125], [0.15, 0.13]);
    const q = lastQuad(seen);
    expect(isAffine(q, 1.5)).toBe(true);
    // A parallelogram: the two diagonals cross at both their middles.
    expect((q[0][0] + q[2][0]) / 2).toBeCloseTo((q[1][0] + q[3][0]) / 2, 9);
    expect((q[0][1] + q[2][1]) / 2).toBeCloseTo((q[1][1] + q[3][1]) / 2, 9);
    expect(q[0][0]).toBeCloseTo(0.15, 6);
  });

  it("Perspective on a corner pinches it and its partner on that edge, the far corner coming the other way", () => {
    const { s, id } = withLayer();
    const seen: Command[] = [];
    const { root, at } = mount(s, id, seen, "perspective");
    expect(root.getAttribute("data-reshape")).toBe("perspective");
    drag(root, at, "transform-handle-1", [1, 0.125], [0.9, 0.13]);
    const q = lastQuad(seen);
    close(q, [[0.1, 0.125], [0.9, 0.125], [1, 0.875], [0, 0.875]]);
    expect(isAffine(q, 1.5)).toBe(false);
  });

  it("the keys still work in a mode: Command (Ctrl) on a corner distorts in Perspective", () => {
    const { s, id } = withLayer();
    const seen: Command[] = [];
    const { root, at } = mount(s, id, seen, "perspective");
    drag(root, at, "transform-handle-2", [1, 0.875], [0.8, 0.7], { ctrlKey: true });
    close(lastQuad(seen), [[0, 0.125], [1, 0.125], [0.8, 0.7], [0, 0.875]]);
  });

  it("Option (Alt) mirrors a distort about the center", () => {
    const q = reshapeByHandle(RECT, 0, [0.1, 0], 1.5, "distort", true);
    close(q, [[0.1, 0.125], [1, 0.125], [0.9, 0.875], [0, 0.875]]);
  });
});

describe("the quad guard", () => {
  it("refuses a corner pushed in past its neighbors: the last good shape stays and the status line says so", () => {
    const { s, id } = withLayer();
    const seen: Command[] = [];
    const { root, at } = mount(s, id, seen);
    fireEvent.mouseDown(screen.getByTestId("transform-handle-2"), { ...at(1, 0.875), ctrlKey: true });
    fireEvent.mouseMove(root, { ...at(0.9, 0.8), buttons: 1, ctrlKey: true });
    // Inside the triangle of the other three: the quad would fold.
    fireEvent.mouseMove(root, { ...at(0.2, 0.3), buttons: 1, ctrlKey: true });
    fireEvent.mouseUp(root);
    close(lastQuad(seen), [[0, 0.125], [1, 0.125], [0.9, 0.8], [0, 0.875]]);
    expect(currentFlash()).toMatch(/fold the picture/);
  });

  it("names a fold and an inside-out quad, and passes a good one", () => {
    expect(quadFolds(RECT, RECT, 1.5)).toBeNull();
    expect(quadFolds([[0, 0.125], [1, 0.125], [0.2, 0.3], [0, 0.875]], RECT, 1.5)).toBe("folds");
    // Two corners traded: a bow tie.
    expect(quadFolds([[0, 0.125], [1, 0.125], [0, 0.875], [1, 0.875]], RECT, 1.5)).toBe("folds");
    expect(quadFolds(flipQuad(RECT, "h"), RECT, 1.5)).toBe("inverts");
    // A flipped layer is judged against itself: it is not inside out.
    expect(quadFolds(flipQuad(RECT, "h"), flipQuad(RECT, "h"), 1.5)).toBeNull();
  });
});

describe("one transform, one undo, Escape", () => {
  it("a whole distort drag is one undo step", () => {
    const { s, id } = withLayer();
    const seen: Command[] = [];
    const { root, at } = mount(s, id, seen);
    fireEvent.mouseDown(screen.getByTestId("transform-handle-2"), { ...at(1, 0.875), ctrlKey: true });
    for (const f of [0.95, 0.9, 0.85, 0.8]) fireEvent.mouseMove(root, { ...at(f, f), buttons: 1, ctrlKey: true });
    fireEvent.mouseUp(root);
    const after = run(s, ...seen);
    close(layerQuad(after, id) as Pt[], [[0, 0.125], [1, 0.125], [0.8, 0.8], [0, 0.875]]);
    close(layerQuad(run(after, { type: "undo" }), id) as Pt[], RECT);
  });

  it("writes the corners Warp writes, stamped with the frame's shape", () => {
    const { s, id } = withLayer();
    const seen: Command[] = [];
    const { root, at } = mount(s, id, seen);
    drag(root, at, "transform-handle-1", [1, 0.125], [0.9, 0.2], { ctrlKey: true });
    const params = (serializeGraph(run(s, ...seen)) as unknown as { nodes: { id: string; params: Record<string, number> }[] }).nodes.find(
      (n) => n.id === id,
    )!.params;
    expect(params.warp_x1).toBeCloseTo(0.9, 9);
    expect(params.warp_y1).toBeCloseTo(0.2, 9);
    expect(params.warp_aspect).toBe(1.5);
  });

  it("Escape puts the square back after a reshape and the tool down; Enter keeps the corners; the slot keeps its mode", () => {
    const { s: base, id } = withLayer();
    const armed = run(base, { type: "set_shape_mode", mode: "perspective" }, { type: "set_tool", tool: "transform" });
    expect(transformDragOf(armed.shapeMode)).toBe("perspective");
    const distorted: Pt[] = [[0.1, 0.1], [0.9, 0.2], [1, 0.9], [0, 0.8]];
    const moved = run(armed, { type: "art_set_quad", id, box: REST, corners: distorted });
    const out: Command[] = [];
    runCommand("tool.cancel", moved, (c) => out.push(c));
    const canceled = run(moved, ...out);
    expect(canceled.tool).toBe("none");
    expect(canceled.shapeMode).toBe("perspective");
    close(layerQuad(canceled, id) as Pt[], RECT);
    const kept: Command[] = [];
    runCommand("tool.apply", moved, (c) => kept.push(c));
    const applied = run(moved, ...kept);
    expect(applied.tool).toBe("none");
    close(layerQuad(applied, id) as Pt[], distorted);
  });
});

describe("the typed fields after a reshape", () => {
  it("a distorted layer's W, H and Angle say so; X and Y are its center; a typed W sizes the shape as it stands", () => {
    const { s: base, id } = withLayer();
    const distorted: Pt[] = [[0.1, 0.125], [0.9, 0.125], [1, 0.875], [0, 0.875]];
    const s = run(base, { type: "art_set_quad", id, box: REST, corners: distorted });
    const seen: Command[] = [];
    render(<TransformFields state={s} blendId={id} dispatch={(c) => seen.push(c)} />);
    expect(screen.getByTestId(`art-xform-${id}`).getAttribute("data-shape")).toBe("distorted");
    for (const k of ["sx", "sy", "rotate"]) expect((screen.getByTestId(`art-xform-${k}-${id}`) as HTMLInputElement).value).toBe("distorted");
    expect((screen.getByTestId(`art-xform-x-${id}`) as HTMLInputElement).value).toBe("50.0");
    expect(screen.getByTestId(`art-xform-warped-${id}`).textContent).toMatch(/^Distorted/);
    const w = screen.getByTestId(`art-xform-sx-${id}`);
    fireEvent.focus(w);
    fireEvent.change(w, { target: { value: "40" } });
    fireEvent.keyDown(w, { key: "Enter" });
    const q = lastQuad(seen);
    expect(isAffine(q, 1.5)).toBe(false);
    // Half as wide on its own axis about the center: the top edge from
    // 0.8 of the frame across to 0.4, the center where it was.
    expect(q[1][0] - q[0][0]).toBeCloseTo(0.4, 6);
    expect(q[1][1] - q[0][1]).toBeCloseTo(0, 6);
    expect(crossing(q)[0]).toBeCloseTo(0.5, 6);
  });

  it("a skewed layer reads numbers off its edges and says it is skewed", () => {
    const { s: base, id } = withLayer();
    const s = run(base, { type: "art_set_quad", id, box: REST, corners: [[0.1, 0.125], [1.1, 0.125], [1, 0.875], [0, 0.875]] });
    render(<TransformFields state={s} blendId={id} dispatch={() => {}} />);
    expect(screen.getByTestId(`art-xform-${id}`).getAttribute("data-shape")).toBe("skewed");
    expect((screen.getByTestId(`art-xform-sx-${id}`) as HTMLInputElement).value).toBe("100.0");
    expect(screen.getByTestId(`art-xform-warped-${id}`).textContent).toMatch(/^Skewed/);
  });

  it("Reset returns a distorted layer to the plain fitted rectangle", () => {
    const { s: base, id } = withLayer();
    const s = run(base, { type: "art_set_quad", id, box: REST, corners: [[0.1, 0.1], [0.9, 0.2], [1, 0.9], [0, 0.8]] });
    const seen: Command[] = [];
    render(<TransformFields state={s} blendId={id} dispatch={(c) => seen.push(c)} />);
    fireEvent.click(screen.getByTestId(`art-xform-reset-${id}`));
    close(lastQuad(seen), cornersOf(REST) as Pt[]);
  });
});

describe("the row's buttons are pictures", () => {
  const BUTTONS: [string, string][] = [
    ["lock", "Keep Proportions"],
    ["warp", "Warp"],
    ["reset", "Reset"],
  ];

  it("Transform, Skew, Distort and the flips are gone from the panel: the toolbar and the canvas header hold them", () => {
    const { s, id } = withLayer();
    render(<TransformFields state={s} blendId={id} dispatch={() => {}} />);
    for (const key of ["fliph", "flipv", "tool", "skew", "distort"]) {
      expect(screen.queryByTestId(`art-xform-${key}-${id}`)).toBeNull();
    }
    for (const name of ["Flip Across", "Flip Down", "Transform", "Skew", "Distort"]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
  });

  it("each carries its name as label and tip, an outcome-first hint starting with it, and a picture, no words", () => {
    const { s, id } = withLayer();
    render(<TransformFields state={s} blendId={id} dispatch={() => {}} />);
    for (const [key, name] of BUTTONS) {
      const b = screen.getByTestId(`art-xform-${key}-${id}`);
      expect(b.getAttribute("aria-label")).toBe(name);
      expect(b.getAttribute("data-tip")).toBe(name);
      expect(b.getAttribute("data-hint")!.startsWith(`${name}: `)).toBe(true);
      expect(b.querySelector("svg")).not.toBeNull();
      expect(b.textContent).toBe("");
    }
  });

});

describe("the toolbar's Transform slot", () => {
  const slot = (s: State, dispatch: (c: Command) => void) => <ShapeToolButton state={s} dispatch={dispatch} />;

  it("offers Transform, Skew, Perspective and Warp, and no Distort: Warp is the corner on its own", () => {
    const { s } = withLayer();
    render(slot(s, () => {}));
    fireEvent.contextMenu(screen.getByTestId("art-tool-shape"));
    const menu = screen.getByTestId("art-shape-menu");
    expect(Array.from(menu.querySelectorAll("[role=menuitem]")).map((b) => b.textContent)).toEqual(["Transform", "Skew", "Perspective", "Warp"]);
    expect(screen.queryByTestId("art-shape-option-distort")).toBeNull();
    for (const b of Array.from(menu.querySelectorAll("[role=menuitem]"))) {
      expect(b.getAttribute("data-hint")!.startsWith(`${b.textContent}: `)).toBe(true);
    }
  });

  it("a pick sets the mode and arms the tool; another pick keeps the tool up and changes only what the handles do", () => {
    const { s: base } = withLayer();
    let s = base;
    const dispatch = (c: Command) => {
      s = reduce(s, c);
    };
    const r = render(slot(s, dispatch));
    const pick = (mode: string) => {
      fireEvent.contextMenu(screen.getByTestId("art-tool-shape"));
      fireEvent.click(screen.getByTestId(`art-shape-option-${mode}`));
      r.rerender(slot(s, dispatch));
    };
    pick("skew");
    expect([s.tool, s.shapeMode, transformDragOf(s.shapeMode)]).toEqual(["transform", "skew", "skew"]);
    expect(screen.getByTestId("art-tool-shape").getAttribute("data-mode")).toBe("skew");
    pick("perspective");
    expect([s.tool, transformDragOf(s.shapeMode)]).toEqual(["transform", "perspective"]);
    pick("transform");
    expect([s.tool, transformDragOf(s.shapeMode)]).toEqual(["transform", "scale"]);
    pick("warp");
    expect(s.tool).toBe("warp");
    pick("skew");
    expect([s.tool, s.shapeMode]).toEqual(["transform", "skew"]);
    // A tap puts it down; the next tap arms the mode showing.
    fireEvent.mouseDown(screen.getByTestId("art-tool-shape"), { button: 0 });
    fireEvent.mouseUp(screen.getByTestId("art-tool-shape"));
    r.rerender(slot(s, dispatch));
    expect(s.tool).toBe("none");
    fireEvent.mouseDown(screen.getByTestId("art-tool-shape"), { button: 0 });
    fireEvent.mouseUp(screen.getByTestId("art-tool-shape"));
    expect([s.tool, transformDragOf(s.shapeMode)]).toEqual(["transform", "skew"]);
  });

  it("the Transform mode's hint names the keys with this platform's names", () => {
    const { s } = withLayer();
    const r = render(slot(s, () => {}));
    expect(screen.getByTestId("art-tool-shape").getAttribute("data-hint")).toContain("CTRL+ALT+SHIFT pinches in perspective");
    r.unmount();
    setMacForTests(true);
    render(slot(s, () => {}));
    expect(screen.getByTestId("art-tool-shape").getAttribute("data-hint")).toContain("⌘ on a corner distorts");
  });

  it("grays with nothing to act on, and says what picking a layer does", () => {
    const { s } = withLayer();
    render(slot({ ...s, artActive: null }, () => {}));
    const b = screen.getByTestId("art-tool-shape");
    expect(b).toBeDisabled();
    expect(b.getAttribute("data-hint")).toMatch(/^Transform: pick a layer in the Finish tab to move, size, skew or warp it/);
  });

  it("acts on a copied picture (New Layer via Copy, Bake Warp's kind) as on any image layer", () => {
    const base = initialState();
    noteFrameAspect(base.activeImage, 1.5);
    const s = run({ ...base, mode: "simple", panelTab: "layers" }, {
      type: "art_layer_via_copy",
      path: "/kept/copy.png",
      box: REST,
      aspect: 1.5,
      name: "copy",
      above: null,
    } as Command);
    const id = s.artActive!;
    expect(id).toBeTruthy();
    render(slot(s, () => {}));
    expect(screen.getByTestId("art-tool-shape")).toBeEnabled();
    const armed = run(s, { type: "set_shape_mode", mode: "skew" }, { type: "set_tool", tool: "transform" });
    const seen: Command[] = [];
    const { root, at } = mount(armed, id, seen, transformDragOf(armed.shapeMode));
    const before = layerQuad(armed, id) as Pt[];
    drag(root, at, "transform-edge-1", [before[1][0], 0.5], [before[1][0] + 0.05, 0.6]);
    const after = run(armed, ...seen);
    const q = layerQuad(after, id) as Pt[];
    // The right edge slid down along itself; the left edge stayed.
    expect(q[1][1] - before[1][1]).toBeCloseTo(0.1, 6);
    expect(q[2][1] - before[2][1]).toBeCloseTo(0.1, 6);
    close([q[0], q[3]], [before[0], before[3]]);
    // One undo step for the whole drag.
    close(layerQuad(run(after, { type: "undo" }), id) as Pt[], before);
  });

  it("the saved slot mode comes back with the settings, and an unknown one is ignored", () => {
    const { s } = withLayer();
    const snap = uiSettingsSnapshot({ ...s, shapeMode: "perspective" });
    expect(uiSettingsCommands(JSON.stringify(snap))).toContainEqual({ type: "set_shape_mode", mode: "perspective" });
    expect(uiSettingsCommands(JSON.stringify({ shapeMode: "distort" })).some((c) => c.type === "set_shape_mode")).toBe(false);
  });
});

describe("the status line while Transform is up", () => {
  it("names the keys, CTRL on Windows and the Mac symbols on a Mac", () => {
    expect(transformKeysLine("scale")).toContain("CTRL distorts a corner · CTRL+SHIFT skews · CTRL+ALT+SHIFT pinches in perspective");
    setMacForTests(true);
    expect(transformKeysLine("scale")).toContain("⌘ distorts a corner · ⌘+⇧ skews · ⌘+⌥+⇧ pinches in perspective");
    expect(transformKeysLine("perspective")).toMatch(/^Perspective/);
    expect(transformKeysLine("skew")).toMatch(/^Skew/);
  });

  it("shows on the bar while the tool is up and nothing is pointed at", () => {
    const { s: base } = withLayer();
    const s = run(base, { type: "set_shape_mode", mode: "skew" }, { type: "set_tool", tool: "transform" });
    const bar = (st: State) => (
      <StatusBar state={st} dispatch={() => {}} previewUrl={null} previewError={null} previewMs={null} previewBackend={null} renderSeq={0} />
    );
    const r = render(bar(s));
    expect(screen.getByRole("status").textContent).toMatch(/^Skew · /);
    r.rerender(bar(run(s, { type: "set_tool", tool: "transform" })));
    act(() => {});
    expect(screen.getByRole("status").textContent).toBe("");
  });
});
