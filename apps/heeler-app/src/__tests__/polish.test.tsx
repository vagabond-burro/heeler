// Polishing a selection.
//
// "I think selection needs polish tool. In other apps this
// was a window that opened up and showed the selected areas as red
// overlay... I wonder tho, instead of having a pop up if we can use the
// current viewport, temp hide Adjustments panel, bring up a Polish
// selection panel so its not like you have to leave the main window."
//
// So the two things worth pinning down are that it happens in place (the
// viewport keeps its zoom and pan, the panel comes back afterwards) and
// that painting on it is still geometry, not pixels.

import { describe, expect, it } from "vitest";
import { initialState } from "../data";
import { POLISH_VIEWS, reduce, type Command, type State } from "../state";
import { serializeGraph } from "../bridge";
import { polishPaint } from "../ui/polish";
import { runCommand } from "../commands";
import { selectionField, traceContours, FIELD } from "../ui/selectionfield";

const run = (s: State, ...cmds: Command[]) => cmds.reduce(reduce, s);

function polishing() {
  let s = run(initialState(), { type: "add_layer", maskType: "selection" });
  const id = s.activeLayer!.replace("_adj", "_mask");
  s = run(
    s,
    {
      type: "add_region",
      id,
      region: {
        kind: "path",
        op: "replace",
        points: [
          [0.2, 0.2],
          [0.8, 0.2],
          [0.8, 0.8],
          [0.2, 0.8],
        ],
      },
    },
    { type: "set_polish_open", open: true },
  );
  return { s, id };
}

describe("polish opens over the work, not beside it", () => {
  it("puts down whatever tool was up, so the viewport is its own", () => {
    const { s } = polishing();
    expect(s.polishOpen).toBe(true);
    // The selection tool was armed by adding the layer; polish takes the
    // pointer, so it cannot still be drawing new outlines underneath.
    expect(s.tool).toBe("none");
  });

  it("comes back out without having disturbed anything", () => {
    const { s, id } = polishing();
    const closed = run(s, { type: "set_polish_open", open: false });
    expect(closed.polishOpen).toBe(false);
    // "if we are pushing out changes to customers later it'd be
    // advisable that we don't mess with their edit." Opening and closing the
    // panel is not an edit.
    expect(closed.nodes.find((n) => n.id === id)!.regions).toEqual(
      s.nodes.find((n) => n.id === id)!.regions,
    );
  });

  it("offers the red overlay first, and mattes for when red is wrong", () => {
    expect(POLISH_VIEWS.map((v) => v.id)).toEqual(["overlay", "black", "white", "mask"]);
    expect(initialState().polishView).toBe("overlay");
  });

  it("keeps the photograph visible under the red, and hides it under the mattes", () => {
    // The whole point of the overlay: you are judging an edge against
    // the thing it is meant to follow.
    const overlay = polishPaint("overlay");
    expect(overlay.strength).toBeLessThan(1);
    expect(overlay.onSelected).toBe(true);
    // The mattes paint what is NOT selected, so the selection is shown
    // as a hole in a flat field.
    expect(polishPaint("black").onSelected).toBe(false);
    expect(polishPaint("black").tint).toEqual([0, 0, 0]);
    expect(polishPaint("white").tint).toEqual([255, 255, 255]);
    // And the mask on its own replaces the picture entirely.
    expect(polishPaint("mask").base).toEqual([0, 0, 0]);
    expect(polishPaint("mask").onSelected).toBe(true);
  });

  it("falls back to the overlay rather than drawing nothing", () => {
    expect(polishPaint("nonsense")).toEqual(polishPaint("overlay"));
  });
});

describe("the polish brush paints geometry", () => {
  it("stores the stroke as a path and a width, never as pixels", () => {
    const { s, id } = polishing();
    const after = run(s, {
      type: "add_region",
      id,
      region: {
        kind: "brush",
        op: "add",
        points: [
          [0.1, 0.1],
          [0.15, 0.12],
        ],
        radius: 0.03,
      },
    });
    const r = after.nodes.find((n) => n.id === id)!.regions![1];
    expect(r.kind).toBe("brush");
    expect(r.kind === "brush" && r.points).toHaveLength(2);
    expect(r.kind === "brush" && r.radius).toBe(0.03);
    // And it survives the trip to the engine as coordinates.
    const graph = serializeGraph(after);
    const node = graph.nodes.find((n: { id: string }) => n.id === id)!;
    const sent = JSON.parse(node.params.regions as string);
    expect(sent[1]).toEqual({
      kind: "brush",
      op: "add",
      points: [
        [0.1, 0.1],
        [0.15, 0.12],
      ],
      radius: 0.03,
    });
  });

  it("thickens the stroke rather than filling what it loops around", () => {
    // A stroke is not a closed outline. Drawn as a big loose circle, a
    // path would fill the middle; a brush must leave it alone.
    const ring: [number, number][] = [];
    for (let i = 0; i <= 32; i++) {
      const t = (i / 32) * Math.PI * 2;
      ring.push([0.5 + 0.3 * Math.cos(t), 0.5 + 0.3 * Math.sin(t)]);
    }
    const field = selectionField(
      [{ kind: "brush", op: "add", points: ring, radius: 0.02 }],
      null,
    );
    const at = (x: number, y: number) =>
      field[Math.round(y * FIELD) * FIELD + Math.round(x * FIELD)];
    expect(at(0.8, 0.5)).toBe(1); // on the stroke
    expect(at(0.5, 0.5)).toBe(0); // the hole it went around
  });

  it("subtracting paints a bite out of the selection", () => {
    const square: [number, number][] = [
      [0.2, 0.2],
      [0.8, 0.2],
      [0.8, 0.8],
      [0.2, 0.8],
    ];
    const before = selectionField([{ kind: "path", op: "replace", points: square }], null);
    const after = selectionField(
      [
        { kind: "path", op: "replace", points: square },
        { kind: "brush", op: "subtract", points: [[0.5, 0.5]], radius: 0.05 },
      ],
      null,
    );
    const mid = Math.round(0.5 * FIELD) * FIELD + Math.round(0.5 * FIELD);
    expect(before[mid]).toBe(1);
    expect(after[mid]).toBe(0);
    // A hole inside a shape means two loops, which is exactly why the
    // ants are traced from the result rather than drawn per region.
    expect(traceContours(after).length).toBe(2);
  });
});

describe("the polish controls", () => {
  it("hands the selection mask grow, smooth and feather", () => {
    const { s, id } = polishing();
    const node = s.nodes.find((n) => n.id === id)!;
    // The engine declares all three on heeler.selection_mask; a control
    // that writes a param the node does not have renders nothing.
    for (const p of ["grow", "smooth", "feather"]) {
      const next = run(s, { type: "set_param", id, param: p, value: 0.4 });
      expect(next.nodes.find((n) => n.id === id)!.params[p]).toBe(0.4);
    }
    expect(node.type).toBe("heeler.selection_mask");
  });

  it("shrinks as well as grows", () => {
    const { s, id } = polishing();
    const next = run(s, { type: "set_param", id, param: "grow", value: -0.5 });
    expect(next.nodes.find((n) => n.id === id)!.params.grow).toBe(-0.5);
  });

  it("keeps the brush inside a size that can be seen and used", () => {
    const s = run(initialState(), { type: "set_polish_radius", radius: 99 });
    expect(s.polishRadius).toBeLessThanOrEqual(0.3);
    expect(run(s, { type: "set_polish_radius", radius: -1 }).polishRadius).toBeGreaterThan(0);
  });

  it("gives the bracket keys to the polish brush while it is open", () => {
    // One brush on screen at a time, so one pair of keys.
    const { s } = polishing();
    let next = s;
    const handled = runCommand("brush.size.up", s, ((c: Command) => {
      next = reduce(next, c);
    }) as never, {});
    expect(handled).toBe(true);
    expect(next.polishRadius).toBeGreaterThan(s.polishRadius);
  });
});

describe("the panel takes the Adjustments column", () => {
  const mountPanel = async (s: State, dispatch = () => {}) => {
    const { render, screen } = await import("@testing-library/react");
    const { PolishPanel } = await import("../ui/polish");
    const view = render(<PolishPanel state={s} dispatch={dispatch as never} />);
    return { screen, view };
  };

  it("shows a view for each mode and the three edge controls", async () => {
    const { s } = polishing();
    const { screen, view } = await mountPanel(s);
    for (const v of POLISH_VIEWS) {
      expect(screen.getByTestId("polish-view-" + v.id)).toBeInTheDocument();
    }
    for (const p of ["grow", "smooth", "feather", "ramp", "matte_contrast", "matte_reach"]) {
      expect(screen.getByTestId("polish-" + p)).toBeInTheDocument();
    }
    expect(screen.getByTestId("polish-radius")).toBeInTheDocument();
    // The matte dials show the registry's defaults on a node from
    // before they existed, as the engine renders it.
    expect(screen.getByTestId("polish-matte_contrast-value")).toHaveValue("25");
    expect(screen.getByTestId("polish-matte_reach-value")).toHaveValue("50");
    // The recipe's rules, the desktop's matte_prompt rule for rule
    // (review R2 and R3, 2026-09-23): Reach counts only with a matte
    // stroke on the node, Contrast only on a baked base.
    const { matteRecipeOf } = await import("../bridge");
    const base = { regions: [], strokes: [] as unknown[], params: {} as Record<string, number>, textParams: {} as Record<string, string> };
    expect(matteRecipeOf(base)).toBe(matteRecipeOf({ ...base, params: { matte_reach: 60 } }));
    expect(matteRecipeOf(base)).toBe(matteRecipeOf({ ...base, params: { matte_contrast: 90 } }));
    const stroked = { ...base, strokes: [{ mode: "matte", points: [[0.1, 0.1]], radius: 0.02 }] };
    expect(matteRecipeOf(stroked)).toBe(matteRecipeOf({ ...stroked, params: { matte_reach: 50 } }));
    expect(matteRecipeOf(stroked)).not.toBe(matteRecipeOf({ ...stroked, params: { matte_reach: 60 } }));
    expect(matteRecipeOf(stroked)).toBe(matteRecipeOf({ ...stroked, params: { matte_contrast: 90 } }));
    const feathered = { ...base, strokes: [{ mode: "feather", points: [[0.1, 0.1]], radius: 0.02 }] };
    expect(matteRecipeOf(feathered)).toBe(matteRecipeOf({ ...feathered, params: { matte_reach: 60 } }));
    const baked = { ...stroked, textParams: { matte_id: "baked:abc" } };
    expect(matteRecipeOf(baked)).toBe(matteRecipeOf({ ...baked, params: { matte_contrast: 25 } }));
    expect(matteRecipeOf(baked)).not.toBe(matteRecipeOf({ ...baked, params: { matte_contrast: 90 } }));
    // The dials say when they are off: no matte stroke, Reach is off
    // and Contrast is live; a baked base with no stroke, both off.
    expect(screen.getByTestId("polish-matte_reach")).toHaveAttribute("data-disabled", "true");
    expect(screen.getByTestId("polish-matte_contrast")).not.toHaveAttribute("data-disabled");
    view.unmount();
  });

  it("Ramp, the fourth refine setting, has a seat in the panel and on the layer (2026-09-29)", async () => {
    const { fireEvent } = await import("@testing-library/react");
    const { s, id } = polishing();
    let current = s;
    const { screen, view } = await mountPanel(s, ((c: Command) => { current = reduce(current, c); }) as never);
    // Centered at zero on a fresh selection: the engine's default.
    expect(screen.getByTestId("polish-ramp-value")).toHaveValue("0");
    const slider = screen.getByTestId("polish-ramp");
    slider.getBoundingClientRect = () => ({ left: 0, width: 100 } as DOMRect);
    fireEvent(slider, new MouseEvent("pointerdown", { clientX: 10, bubbles: true }));
    fireEvent(slider, new MouseEvent("pointermove", { clientX: 80, buttons: 1, bubbles: true }));
    fireEvent.pointerUp(slider);
    // -100 to 100 across the track: 80 percent of the way is +60.
    expect(current.nodes.find((n) => n.id === id)!.params.ramp).toBe(60);
    view.unmount();
    // The same dial on the layer's own seat and the node inspector,
    // which share one list.
    const { MASK_ROWS } = await import("../ui/simple");
    expect(MASK_ROWS.selection.map((r) => r.param)).toContain("ramp");
  });

  it("each matte dial drag is one undo step and holds refinement until release", async () => {
    const { fireEvent } = await import("@testing-library/react");
    for (const param of ["matte_contrast", "matte_reach"]) {
      const { s: fresh, id } = polishing();
      // Reach is the brush's: it is live only with a matte stroke on
      // the node (review R3), so the drag test paints one first.
      const s = run(fresh, {
        type: "add_polish_stroke",
        id,
        stroke: { points: [[0.5, 0.2], [0.6, 0.2]], radius: 0.02, mode: "matte" },
      });
      let current = s;
      const before = serializeGraph(current);
      const { screen, view } = await mountPanel(s, ((c: Command) => { current = reduce(current, c); }) as never);
      const slider = screen.getByTestId(`polish-${param}`);
      slider.getBoundingClientRect = () => ({ left: 0, width: 100 } as DOMRect);
      fireEvent(slider, new MouseEvent("pointerdown", { clientX: 10, bubbles: true }));
      expect(current.gesture).not.toBeNull();
      fireEvent(slider, new MouseEvent("pointermove", { clientX: 30, buttons: 1, bubbles: true }));
      fireEvent(slider, new MouseEvent("pointermove", { clientX: 80, buttons: 1, bubbles: true }));
      fireEvent.pointerUp(slider);
      expect(current.gesture).toBeNull();
      expect(current.nodes.find((n) => n.id === id)!.params[param]).toBe(80);
      expect(serializeGraph(reduce(current, { type: "undo" }))).toEqual(before);
      view.unmount();
    }
  });

  it("Feather follows the picture is a switch beside Feather, off by default, writing the flag", async () => {
    // Halo item 3 (2026-09-23): the same component sits under
    // Layers, here, and on the node in the inspector.
    const { s, id } = polishing();
    const sent: Command[] = [];
    const { screen, view } = await mountPanel(s, ((c: Command) => sent.push(c)) as never);
    const { fireEvent } = await import("@testing-library/react");
    expect(screen.getByTestId("polish-feather-guided")).toHaveAttribute("aria-checked", "false");
    fireEvent.click(screen.getByTestId("polish-feather-guided"));
    expect(sent).toContainEqual({ type: "set_param", id, param: "feather_guided", value: 1 });
    sent.length = 0;
    fireEvent.keyDown(screen.getByTestId("polish-feather-guided"), { key: " " });
    expect(sent).toEqual([{ type: "set_param", id, param: "feather_guided", value: 1 }]);
    sent.length = 0;
    fireEvent.keyDown(screen.getByTestId("polish-feather-guided"), { key: "Enter" });
    expect(sent).toEqual([{ type: "set_param", id, param: "feather_guided", value: 1 }]);
    view.unmount();
  });

  it("has a way back that is where you would look for it", async () => {
    const { s } = polishing();
    const sent: Command[] = [];
    const { screen, view } = await mountPanel(s, ((c: Command) => sent.push(c)) as never);
    const { fireEvent } = await import("@testing-library/react");
    fireEvent.click(screen.getByTestId("polish-done"));
    expect(sent).toEqual([{ type: "set_polish_open", open: false }]);
    view.unmount();
  });

  it("switches between adding and erasing", async () => {
    const { s } = polishing();
    const sent: Command[] = [];
    const { screen, view } = await mountPanel(s, ((c: Command) => sent.push(c)) as never);
    const { fireEvent } = await import("@testing-library/react");
    expect(screen.getByTestId("polish-add").dataset.active).toBe("true");
    fireEvent.click(screen.getByTestId("polish-erase"));
    expect(sent).toEqual([{ type: "set_polish_add", add: false }]);
    view.unmount();
  });
});

describe("the overlay in the viewport", () => {
  const mountOverlay = async (s: State, dispatch: (c: Command) => void = () => {}) => {
    const { render, screen } = await import("@testing-library/react");
    const { PolishOverlay } = await import("../ui/polish");
    const view = render(
      <PolishOverlay
        state={s}
        dispatch={dispatch as never}
        maskUrl={null}
        nodeId="sel_mask"
      />,
    );
    const el = screen.getByTestId("polish-overlay");
    // jsdom gives every element no size, and the overlay correctly
    // declines to draw a cursor into a box with none.
    Object.defineProperty(el, "clientWidth", { value: 400, configurable: true });
    Object.defineProperty(el, "clientHeight", { value: 300, configurable: true });
    Object.defineProperty(el, "getBoundingClientRect", {
      value: () => ({ left: 0, top: 0, width: 400, height: 300 }),
      configurable: true,
    });
    return { screen, view, el };
  };

  it("shows a ring where the pointer is, so you know what you are about to paint", async () => {
    const { s } = polishing();
    const { screen, view, el } = await mountOverlay(s);
    const { fireEvent } = await import("@testing-library/react");
    expect(screen.queryByTestId("polish-cursor")).not.toBeInTheDocument();
    fireEvent.mouseMove(el, { clientX: 200, clientY: 150 });
    expect(screen.getByTestId("polish-cursor")).toBeInTheDocument();
    view.unmount();
  });

  it("turns a drag into one region, with the mode it was drawn in", async () => {
    const { s } = polishing();
    const sent: Command[] = [];
    const { view, el } = await mountOverlay(
      { ...s, polishAdd: false },
      (c) => sent.push(c),
    );
    const { fireEvent } = await import("@testing-library/react");
    fireEvent.mouseDown(el, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.mouseMove(el, { buttons: 1, clientX: 140, clientY: 120 });
    fireEvent.mouseMove(el, { buttons: 1, clientX: 180, clientY: 150 });
    fireEvent.mouseUp(el);
    expect(sent).toHaveLength(1);
    const cmd = sent[0] as Extract<Command, { type: "add_region" }>;
    expect(cmd.region.kind).toBe("brush");
    expect(cmd.region.op).toBe("subtract");
    expect(cmd.region.kind === "brush" && cmd.region.points).toHaveLength(3);
    view.unmount();
  });

  // Leaving the canvas no longer ends the stroke (2026-10-08: "They
  // allow you to drag outside the canvas, its good for making sure you're
  // capturing all the extents"): it carries on outside and lands, whole,
  // where the button comes up; nothing half-made is left behind.
  it("carries a stroke off the canvas and lands it whole at the release", async () => {
    const { s } = polishing();
    const sent: Command[] = [];
    const { view, el } = await mountOverlay(s, (c) => sent.push(c));
    const { fireEvent } = await import("@testing-library/react");
    fireEvent.mouseDown(el, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.mouseMove(el, { buttons: 1, clientX: 140, clientY: 120 });
    fireEvent.mouseLeave(el);
    expect(sent, "leaving ends nothing").toHaveLength(0);
    fireEvent.mouseMove(window, { buttons: 1, clientX: 5000, clientY: 120 });
    fireEvent.mouseUp(window);
    expect(sent).toHaveLength(1);
    const first = sent[0] as Extract<Command, { type: "add_region" }>;
    const pts = first.region.kind === "brush" ? first.region.points : [];
    expect(pts).toHaveLength(3);
    // The brush is where it really was, past the edge, held within half
    // a picture of it.
    expect(pts[2][0]).toBe(1.5);
    // And the next press starts a fresh stroke rather than continuing it.
    fireEvent.mouseDown(el, { button: 0, clientX: 200, clientY: 200 });
    fireEvent.mouseUp(el);
    const second = sent[1] as Extract<Command, { type: "add_region" }>;
    expect(second.region.kind === "brush" && second.region.points).toHaveLength(1);
    view.unmount();
  });
});

describe("polish strokes belong to the shape they refined", () => {
  const stroke = {
    points: [
      [0.5, 0.1],
      [0.5, 0.9],
    ] as [number, number][],
    radius: 0.1,
    mode: "matte",
  };
  const strokesOf = (s: State, id: string) => s.nodes.find((n) => n.id === id)!.strokes ?? [];

  it("survive adding to the selection, but not starting it again", () => {
    // Strokes persist as geometry on purpose: picking the tool up next week
    // and erasing one is an ordinary thing to do. But they were painted to
    // refine THIS edge. A fresh freehand ("New") inherited them and came
    // out snapping to the old photograph like a magnetic lasso.
    // "I just did a freehand selection and its trying to act like a
    // magnetic selection. This is all wrong."
    const { s, id } = polishing();
    let next = run(s, { type: "add_polish_stroke", id, stroke });
    expect(strokesOf(next, id)).toHaveLength(1);

    // Growing the same selection keeps its refinement.
    next = run(next, {
      type: "add_region",
      id,
      region: { kind: "marquee", op: "add", x0: 0.6, y0: 0.6, x1: 0.9, y1: 0.9, shape: "rect" },
    });
    expect(strokesOf(next, id)).toHaveLength(1);

    // Starting again does not: the strokes were painted against an edge
    // that no longer exists.
    next = run(next, {
      type: "add_region",
      id,
      region: { kind: "marquee", op: "replace", x0: 0.1, y0: 0.1, x1: 0.4, y1: 0.4, shape: "rect" },
    });
    expect(strokesOf(next, id)).toHaveLength(0);
  });

  it("go with the selection when it is deselected", () => {
    // A surviving Add stroke against no regions would paint a selection
    // out of nothing on the next render.
    const { s, id } = polishing();
    let next = run(s, { type: "add_polish_stroke", id, stroke });
    next = run(next, { type: "clear_regions", id });
    expect(strokesOf(next, id)).toHaveLength(0);
  });
});


it("the shared Develop and inspector defaults agree with legacy selection nodes", async () => {
  const { paramDefault } = await import("../ui/simple");
  expect(paramDefault("matte_contrast", "heeler.selection_mask")).toBe(25);
  expect(paramDefault("matte_reach", "heeler.selection_mask")).toBe(50);
});
