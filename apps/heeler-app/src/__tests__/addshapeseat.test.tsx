// Add shape's seat (2026-10-01: "Warp Shapes controls could use
// cleanup. The "Add shape" button takes up a whole role. I think move
// this button up to the right of the TYPE option menu").
//
// What is held here: on every Finish warp (a Warp layer, an image
// layer's own warp, the graph inspector's face of either) Add shape sits
// on the Type row after the menu while the type is Shapes, and nowhere
// while it is Grid; no row of its own is left, so the "No shapes yet"
// line comes first in the Shapes controls; it still adds a shape aimed
// at its warp and arms the tool there; Develop's Shape Warp keeps it
// beside Place shapes (no Type row there); and where the Type row has no
// room for its label it shrinks to its plus, the label in its tip,
// measured in offsets so 150% app zoom (a panel 1.5 times narrower in
// CSS pixels) is the same rule.
import { fireEvent, render, screen } from "@testing-library/react";
import { useCallback, useState } from "react";
import { describe, expect, it } from "vitest";
import { initialState, NEUTRAL_NODES, NEUTRAL_WIRES } from "../data";
import { artLayers, artWarpNode, imageLayerWarp, reduce, type Command, type State } from "../state";
import { noteFrameAspect } from "../imagelayers";
import { shapesFromNode } from "../shapewarp";
import { ArtLayersTab } from "../ui/artlayers";
import { NodeParams } from "../ui/graph";
import { addShapeCompact, ShapeWarpControls } from "../ui/shapewarp";

const run = (s: State, ...cmds: Command[]): State => cmds.reduce(reduce, s);

function fresh(id = "add_shape_seat"): State {
  noteFrameAspect(id, 1.5);
  return {
    ...initialState(),
    activeImage: id,
    mode: "simple",
    panelTab: "layers",
    nodes: structuredClone(NEUTRAL_NODES),
    wires: structuredClone(NEUTRAL_WIRES),
  };
}

/** A Warp layer over a Pixel layer, the Warp layer active, collapsed. */
function warpStack(): { s: State; blend: string; warp: string } {
  const s = run(fresh(), { type: "art_add_layer", kind: "paint" }, { type: "art_add_layer", kind: "warp" });
  const blend = artLayers(s)[1].blend.id;
  const warp = artLayers(s)[1].content.id;
  return { s: run(s, { type: "set_tool", tool: "none" }), blend, warp };
}

/** An image layer with its own warp, collapsed. */
function imageStack(): { s: State; blend: string; warp: string } {
  const added = run(fresh("add_shape_seat_image"), {
    type: "art_add_image_layer",
    source: { kind: "file", path: "__IMAGE__" },
    name: "logo",
    box: { x: 0.3, y: 0.35, w: 0.4, h: 0.3 },
  });
  const blend = added.artActive!;
  const s = run(added, { type: "art_layer_warp", id: blend, on: true }, { type: "set_tool", tool: "none" });
  return { s, blend, warp: imageLayerWarp(s, blend)!.id };
}

/** A component over a live reducer; `latest()` is its state. */
function mount(initial: State, face: (s: State, d: (c: Command) => void) => React.ReactElement) {
  let current = initial;
  function Host() {
    const [s, setS] = useState(initial);
    const dispatch = useCallback((c: Command) => {
      setS((prev) => {
        const next = reduce(prev, c);
        current = next;
        return next;
      });
    }, []);
    return face(s, dispatch);
  }
  const view = render(<Host />);
  return { view, latest: () => current };
}

const chooseShapes = (warp: string) => {
  fireEvent.click(screen.getByTestId(`finish-warp-kind-${warp}`));
  fireEvent.click(screen.getByTestId(`finish-warp-kind-${warp}-option-shapes`));
};

/** Add shape is on the Type row, after the menu, once, and the Shapes
 * controls start with the list (its "No shapes yet" line). */
function expectOnTypeRow(warp: string) {
  const adds = screen.getAllByTestId("shapewarp-add");
  expect(adds).toHaveLength(1);
  const add = adds[0];
  const menu = screen.getByTestId(`finish-warp-kind-${warp}`);
  const row = add.parentElement!;
  expect(row.contains(menu)).toBe(true);
  expect(row.firstElementChild!.textContent).toBe("Type");
  expect(menu.compareDocumentPosition(add) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(row.lastElementChild).toBe(add);
  const controls = screen.getByTestId("shapewarp-controls");
  expect(controls.contains(add)).toBe(false);
  expect(controls.firstElementChild).toBe(screen.getByTestId("shapewarp-list"));
  expect(screen.getByTestId("shapewarp-list").textContent).toMatch(/^No shapes yet\. Add one, place it/);
  // Same face and hint as before: a chip that says Add shape.
  expect(add).toHaveClass("chip");
  expect(add.textContent).toBe("Add shape");
  expect(add.getAttribute("data-hint")).toMatch(/^A new shape in the middle of the frame/);
}

describe("Add shape on a Finish warp", () => {
  it("a Warp layer: on the Type row after the menu, adds a shape on this warp and keeps the tool armed there", () => {
    const { s, blend, warp } = warpStack();
    const { latest } = mount(s, (st, d) => <ArtLayersTab state={st} dispatch={d} />);
    fireEvent.click(screen.getByTestId(`art-settings-${blend}`));
    // Grid: no Add shape anywhere.
    expect(screen.queryByTestId("shapewarp-add")).toBeNull();
    chooseShapes(warp);
    expectOnTypeRow(warp);
    expect(shapesFromNode(artWarpNode(latest(), warp))).toHaveLength(0);
    fireEvent.click(screen.getByTestId("shapewarp-add"));
    expect(shapesFromNode(artWarpNode(latest(), warp))).toHaveLength(1);
    expect(latest().tool).toBe("shapewarp");
    expect(latest().warpTarget).toBe(warp);
    expect(screen.getAllByTestId("shapewarp-row")).toHaveLength(1);
    // Back to Grid: it goes with the Shapes controls.
    fireEvent.click(screen.getByTestId(`finish-warp-kind-${warp}`));
    fireEvent.click(screen.getByTestId(`finish-warp-kind-${warp}-option-grid`));
    expect(screen.queryByTestId("shapewarp-add")).toBeNull();
  });

  it("an image layer's own warp: on the Type row, the Room under it, and adding arms the tool on the warp", () => {
    const { s, blend, warp } = imageStack();
    const { latest } = mount(s, (st, d) => <ArtLayersTab state={st} dispatch={d} />);
    fireEvent.click(screen.getByTestId(`art-settings-${blend}`));
    expect(screen.queryByTestId("shapewarp-add")).toBeNull();
    chooseShapes(warp);
    expectOnTypeRow(warp);
    // Opening an image layer arms nothing; Add shape brings the tool up
    // on this warp.
    expect(latest().tool).toBe("none");
    fireEvent.click(screen.getByTestId("shapewarp-add"));
    expect(latest().tool).toBe("shapewarp");
    expect(latest().warpTarget).toBe(warp);
    expect(shapesFromNode(artWarpNode(latest(), warp))).toHaveLength(1);
  });

  it("the graph inspector's warp face: on the Type row, adding aims at the node", () => {
    const { s, warp } = warpStack();
    const armed = run(s, { type: "art_warp_kind", id: warp, kind: "shapes" }, { type: "set_tool", tool: "shapewarp", target: warp });
    const { latest } = mount(armed, (st, d) => (
      <NodeParams node={artWarpNode(st, warp)!} dispatch={d} appState={st} allNodes={st.nodes} wires={st.wires} />
    ));
    expectOnTypeRow(warp);
    fireEvent.click(screen.getByTestId("shapewarp-add"));
    expect(shapesFromNode(artWarpNode(latest(), warp))).toHaveLength(1);
    expect(latest().warpTarget).toBe(warp);
  });
});

describe("Add shape in Develop's Shape Warp", () => {
  it("has no Type row, so it stays beside Place shapes and still adds and arms", () => {
    const start = reduce(initialState(), { type: "select_image", id: "4869" });
    const { latest } = mount(start, (st, d) => <ShapeWarpControls state={st} dispatch={d} />);
    const add = screen.getByTestId("shapewarp-add");
    expect(add.parentElement).toBe(screen.getByTestId("shapewarp-tool").parentElement);
    expect(add.textContent).toBe("Add shape");
    fireEvent.click(add);
    expect(latest().tool).toBe("shapewarp");
    expect(screen.getAllByTestId("shapewarp-row")).toHaveLength(1);
  });

  it("the Feather and Amount tracks sit in the .strack-flex wrapper, so they have a width to size from", () => {
    // A bare track in a flex row collapsed to its handle (seen in the
    // Finish warp figure while this seat moved).
    const start = reduce(reduce(initialState(), { type: "select_image", id: "4869" }), { type: "shape_warp_add" });
    mount(start, (st, d) => <ShapeWarpControls state={st} dispatch={d} />);
    for (const id of ["shapewarp-feather-track", "shapewarp-amount-track"]) {
      expect(screen.getByTestId(id).parentElement).toHaveClass("strack-flex");
    }
  });
});

describe("Add shape fits its row", () => {
  // Offsets measured in the browser build (CSS pixels inside the app
  // zoom, so the same at 100% and 150%): the kicker's column 78, the
  // Type menu fitted to "Shapes" 69, the chip with its 11px label 74,
  // gaps 8. The row is 275 on the default panel at 100%, 234 at 150%,
  // 215 on the narrowest panel (260) at either.
  const KICKER = 78;
  const MENU = 69;
  const FULL = 74;
  const GAP = 8;
  const others = KICKER + GAP + MENU + GAP;

  it("keeps the label while it fits, the plus alone when it does not; 150% zoom is the same rule on fewer CSS pixels", () => {
    expect(addShapeCompact(0, others, FULL)).toBe(false);
    expect(addShapeCompact(260, others, FULL)).toBe(false);
    expect(addShapeCompact(others + FULL, others, FULL)).toBe(false);
    expect(addShapeCompact(others + FULL - 1, others, FULL)).toBe(true);
    // The rows measured in the browser build.
    expect(addShapeCompact(275, others, FULL)).toBe(false);
    expect(addShapeCompact(234, others, FULL)).toBe(true);
    expect(addShapeCompact(215, others, FULL)).toBe(true);
  });

  /** Stand-in layout: the Type row `row` wide, its kicker, menu and the
   * Add shape chip their measured widths. */
  function layout(row: number): () => void {
    const proto = HTMLElement.prototype;
    const prior = Object.getOwnPropertyDescriptor(proto, "offsetWidth");
    Object.defineProperty(proto, "offsetWidth", {
      configurable: true,
      get(this: HTMLElement) {
        if (this.dataset.testid === "shapewarp-add") return this.dataset.compact ? 26 : FULL;
        if (this.classList.contains("kicker") && this.textContent === "Type") return KICKER;
        if (this.querySelector(":scope > [data-testid^='finish-warp-kind-']")) return MENU;
        if (this.querySelector(":scope > * > [data-testid^='finish-warp-kind-']")) return row;
        return 0;
      },
    });
    return () => {
      if (prior) Object.defineProperty(proto, "offsetWidth", prior);
      else delete (proto as unknown as Record<string, unknown>).offsetWidth;
    };
  }

  for (const [label, row, compact] of [
    ["the default panel at 100%", 275, false],
    ["the default panel at 150% zoom", 234, true],
    ["the narrowest panel at 150% zoom", 215, true],
  ] as const) {
    it(`${label}: ${compact ? "the plus with the label in its tip" : "the labeled chip"}, never past the row`, () => {
      const restore = layout(row);
      try {
        const { s: made, warp } = warpStack();
        const s = run(made, { type: "art_warp_kind", id: warp, kind: "shapes" }, { type: "set_tool", tool: "shapewarp", target: warp });
        const { latest } = mount(s, (st, d) => (
          <NodeParams node={artWarpNode(st, warp)!} dispatch={d} appState={st} allNodes={st.nodes} wires={st.wires} />
        ));
        const add = screen.getByTestId("shapewarp-add");
        expect(add.hasAttribute("data-compact")).toBe(compact);
        expect(add.getAttribute("aria-label")).toBe("Add shape");
        if (compact) {
          expect(add.textContent).toBe("");
          expect(add.querySelector("svg")).toBeTruthy();
          expect(add.getAttribute("data-tip")).toBe("Add shape");
        } else {
          expect(add.textContent).toBe("Add shape");
        }
        expect(others + add.offsetWidth).toBeLessThanOrEqual(row);
        // Shrunk or not, it adds and arms.
        fireEvent.click(add);
        expect(shapesFromNode(artWarpNode(latest(), warp))).toHaveLength(1);
        expect(latest().tool).toBe("shapewarp");
      } finally {
        restore();
      }
    });
  }
});
