// 2026-10-02: "when using the smart selection layer, if I select an
// subject (and it selects a bit more than it should) I tried switching to
// the selection tool and doing a subtract selection to remove the extra
// selection but it didn't work". The selection tool drew on the empty
// document selection, where a Subtract took nothing out of nothing, and
// the Smart layer's mask never heard of it.
//
// Every surface where a model-made or live mask is the thing on screen,
// built through the reducer the way a person builds it, then the
// selection tool armed and a shape drawn through the real overlay with
// each method and each way of saying the op (the mode menu, Option and
// Shift held). The shape must land on the mask being looked at, as one
// undo step, and nowhere else; New stays a new document selection; with
// nothing at all to act on, the status line says so and why.

import { cleanup, fireEvent, render } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { initialState, NEUTRAL_NODES, NEUTRAL_WIRES } from "../data";
import { makeNode, specFor } from "../nodes";
import {
  DOC_SEL_ID,
  activeSelectionMask,
  artMaskNode,
  liveMaskInHand,
  reduce,
  selectShapeTarget,
  type Command,
  type SelectOp,
  type State,
} from "../state";
import { SelectionOverlay } from "../ui/selection";
import { modLabel } from "../platform";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

afterEach(cleanup);

const run = (s: State, ...cmds: Command[]): State => cmds.reduce(reduce, s);

/** The Subject recipe on a Smart mask, as the Smart tool's Subject
 * button leaves it once the model answered. */
const subject = (id: string): Command[] => [
  { type: "set_text_param", id, param: "mode", value: "subject" },
  { type: "set_text_param", id, param: "model", value: "birefnet_lite" },
];

type Surface = {
  name: string;
  /** the state with the surface on screen, and the id of its mask */
  build: () => { s: State; mask: string };
};

/** Every surface whose mask a shape combines with. */
const SURFACES: Surface[] = [
  {
    // What the owner used: Finish toolbar > Adjustment > Utility >
// Smart.
    name: "the Finish Smart layer",
    build: () => {
      let s = run({ ...initialState(), panelTab: "layers" }, { type: "art_add_smart_layer" });
      const mask = `art_m_${s.artActive}`;
      s = run(s, ...subject(mask));
      return { s, mask };
    },
  },
  {
    name: "a Finish layer with Add Smart Mask",
    build: () => {
      let s = run({ ...initialState(), panelTab: "layers" }, { type: "art_add_layer", kind: "exposure" } as Command);
      const id = s.artActive!;
      s = run(s, { type: "art_add_mask", id, kind: "smart" });
      const mask = `art_m_${id}`;
      s = run(s, ...subject(mask));
      return { s, mask };
    },
  },
  {
    name: "a Finish layer's Object mask",
    build: () => {
      let s = run({ ...initialState(), panelTab: "layers" }, { type: "art_add_layer", kind: "exposure" } as Command);
      const id = s.artActive!;
      s = run(s, { type: "art_add_mask", id, kind: "object" });
      const mask = `art_m_${id}`;
      s = run(s, { type: "set_text_param", id: mask, param: "names", value: '["Suzanne"]' });
      return { s, mask };
    },
  },
  {
    name: "a Develop Smart layer",
    build: () => {
      let s = run(initialState(), { type: "add_layer", maskType: "smart" });
      const mask = s.activeLayer!.replace("_adj", "_mask");
      s = run(s, ...subject(mask));
      return { s, mask };
    },
  },
  {
    name: "a Develop Object layer",
    build: () => {
      let s = run(initialState(), { type: "add_layer", maskType: "object" });
      const mask = s.activeLayer!.replace("_adj", "_mask");
      s = run(s, { type: "set_text_param", id: mask, param: "names", value: '["Suzanne"]' });
      return { s, mask };
    },
  },
  {
    name: "a Develop Selection layer",
    build: () => {
      let s = run(initialState(), { type: "add_layer", maskType: "selection" });
      const mask = s.activeLayer!.replace("_adj", "_mask");
      s = run(s, { type: "add_region", id: mask, region: { kind: "marquee", op: "add", x0: 0.2, y0: 0.2, x1: 0.8, y1: 0.8 } });
      return { s, mask };
    },
  },
  {
    // The graph's Smart Mask node, picked in the Graph.
    name: "a Smart Mask node in the Graph",
    build: () => {
      const card = makeNode(specFor("heeler.smart_mask")!, "smart_mask_g1", 0, 0);
      let s = run({ ...initialState(), mode: "advanced" }, { type: "add_node", node: card });
      const mask = s.nodes.find((n) => n.type === "heeler.smart_mask")!.id;
      s = run({ ...s, selection: [mask] }, ...subject(mask));
      return { s, mask };
    },
  },
];

/** The selection tool picked up, as the toolbar, the menu and M do. */
const armed = (s: State): State => run(s, { type: "arm_document_selection" });

/** The overlay the viewer mounts for the select tool, on the selection
 * the tool holds, at 200 by 200 screen pixels. */
function overlay(s: State, method: string, op: SelectOp) {
  const sent: Command[] = [];
  const held = activeSelectionMask(s)!;
  const view = render(
    React.createElement(SelectionOverlay, {
      node: held,
      dispatch: (c: Command) => sent.push(c),
      method,
      op,
      tolerance: 0.4,
      smooth: 0,
      imageId: s.activeImage,
      state: s,
    }),
  );
  const el = view.getByTestId("selection-overlay");
  Object.defineProperty(el, "clientWidth", { value: 200, configurable: true });
  Object.defineProperty(el, "clientHeight", { value: 200, configurable: true });
  el.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 200, right: 200, bottom: 200 }) as DOMRect;
  return { el, sent, held };
}

type Mods = { altKey?: boolean; shiftKey?: boolean };

/** One shape with `method`, over the right part of the frame. */
function draw(el: HTMLElement, method: string, mods: Mods = {}) {
  const box: [number, number][] =
    method === "freehand"
      ? [[120, 40], [190, 40], [190, 160], [120, 160], [121, 41]]
      : method === "paint"
        ? [[130, 100], [150, 100], [170, 100]]
        : [[120, 40], [190, 160]];
  if (method === "wand") {
    fireEvent.mouseDown(el, { button: 0, clientX: 150, clientY: 100, ...mods });
    fireEvent.mouseUp(el, { clientX: 150, clientY: 100, ...mods });
    return;
  }
  const [first, ...rest] = box;
  fireEvent.mouseDown(el, { button: 0, clientX: first[0], clientY: first[1], ...mods });
  for (const [x, y] of rest) fireEvent.mouseMove(el, { buttons: 1, clientX: x, clientY: y, ...mods });
  const last = box[box.length - 1];
  fireEvent.mouseUp(el, { clientX: last[0], clientY: last[1], ...mods });
}

const regionsOf = (s: State, id: string) => (artMaskNode(s, id)?.regions ?? []).filter((r) => !r.off);

/** The gesture's commands applied, in order, to the state they were
 * drawn on. */
const applied = (s: State, sent: Command[]) => run(s, ...sent);

// Each way the op is said: the mode menu, and the modifiers held over New.
const OPS: { op: SelectOp; menu: SelectOp; mods: Mods; label: string }[] = [
  { op: "subtract", menu: "subtract", mods: {}, label: "Subtract from the mode menu" },
  { op: "subtract", menu: "replace", mods: { altKey: true }, label: `${modLabel("alt")}-drag` },
  { op: "add", menu: "add", mods: {}, label: "Add from the mode menu" },
  { op: "add", menu: "replace", mods: { shiftKey: true }, label: `${modLabel("shift")}-drag` },
  { op: "intersect", menu: "intersect", mods: {}, label: "Intersect from the mode menu" },
  { op: "intersect", menu: "replace", mods: { shiftKey: true, altKey: true }, label: "Shift and Option held" },
];

const METHODS = ["rect", "ellipse", "freehand", "paint", "wand"];

describe("a shape drawn with the selection tool on a live mask", () => {
  for (const surface of SURFACES) {
    describe(surface.name, () => {
      it("is the live mask in hand once the selection tool is armed", () => {
        const { s, mask } = surface.build();
        const a = armed(s);
        expect(liveMaskInHand(a)?.id).toBe(mask);
        // Arming changed nothing on the layer ("There are a lot of
        // reasons I may be using a selection that have nothing to do with
        // masking").
        expect(artMaskNode(a, mask)).toEqual(artMaskNode(s, mask));
      });

      for (const { op, menu, mods, label } of OPS) {
        for (const method of METHODS) {
          it(`${label} with ${method} lands on the mask, one undo step, and nowhere else`, () => {
            const { s: built, mask } = surface.build();
            const s = armed(built);
            const before = regionsOf(s, mask).length;
            const { el, sent } = overlay(s, method, menu);
            draw(el, method, mods);
            const adds = sent.filter((c) => c.type === "add_region");
            expect(adds).toHaveLength(1);
            const after = applied(s, sent);
            const got = regionsOf(after, mask);
            expect(got).toHaveLength(before + 1);
            expect(got[got.length - 1].op).toBe(op);
            // The document selection did not take it.
            expect(regionsOf(after, DOC_SEL_ID)).toHaveLength(0);
            // The status line says where it went.
            expect(sent.some((c) => c.type === "set_notice")).toBe(true);
            // One undo takes exactly the shape back.
            const undone = run(after, { type: "undo" });
            expect(regionsOf(undone, mask)).toEqual(regionsOf(s, mask));
          });
        }
      }

      it("New is a new document selection and leaves the mask alone", () => {
        const { s: built, mask } = surface.build();
        const s = armed(built);
        const { el, sent } = overlay(s, "rect", "replace");
        draw(el, "rect");
        const after = applied(s, sent);
        expect(regionsOf(after, mask)).toEqual(regionsOf(s, mask));
        expect(regionsOf(after, DOC_SEL_ID)).toHaveLength(1);
        // And once there is a selection on screen, Subtract works on it.
        cleanup();
        const second = overlay(after, "rect", "subtract");
        draw(second.el, "rect");
        const later = applied(after, second.sent);
        expect(regionsOf(later, DOC_SEL_ID).map((r) => r.op)).toEqual(["replace", "subtract"]);
        expect(regionsOf(later, mask)).toEqual(regionsOf(s, mask));
      });

      it("Select By with Subtract takes the range out of the mask too", async () => {
        const { s: built, mask } = surface.build();
        const s = run(armed(built), { type: "set_select_op", op: "subtract" } as Command);
        const { runCommand } = await import("../commands");
        const sent: Command[] = [];
        runCommand("select.range.luma", s, (c: Command) => sent.push(c));
        const after = applied(s, sent);
        const got = regionsOf(after, mask);
        expect(got[got.length - 1]).toMatchObject({ kind: "range", op: "subtract" });
        expect(after.selectDialog?.maskId).toBe(mask);
      });
    });
  }
});

describe("the Smart mask's Clear", () => {
  it("forgets the shapes drawn on it with the clicks, in one step", () => {
    let s = run({ ...initialState(), panelTab: "layers" }, { type: "art_add_smart_layer" });
    const mask = `art_m_${s.artActive}`;
    s = run(s, ...subject(mask), { type: "add_region", id: mask, region: { kind: "marquee", op: "subtract", x0: 0.6, y0: 0, x1: 1, y1: 1 } });
    const cleared = run(s, { type: "set_params", id: mask, values: {}, text: { mode: "click", prompts: "[]", model: "" }, clearRegions: true });
    expect(regionsOf(cleared, mask)).toHaveLength(0);
    expect(regionsOf(run(cleared, { type: "undo" }), mask)).toHaveLength(1);
  });
});

describe("with nothing to act on", () => {
  it("a Subtract over nothing selected is not stored, and the status line says why", () => {
    const s = armed(initialState());
    const { el, sent } = overlay(s, "rect", "subtract");
    draw(el, "rect");
    expect(sent.some((c) => c.type === "add_region")).toBe(false);
    const notice = sent.find((c) => c.type === "set_notice") as { text: string } | undefined;
    expect(notice?.text).toMatch(/nothing is selected/);
  });

  it("on a Finish layer's pixel mask it points at Mask from selection", () => {
    let s = run({ ...initialState(), panelTab: "layers" }, { type: "art_add_layer", kind: "exposure" } as Command);
    s = armed(run(s, { type: "art_add_mask", id: s.artActive!, kind: "brush" }));
    const { el, sent } = overlay(s, "rect", "replace");
    draw(el, "rect", { altKey: true });
    expect(sent.some((c) => c.type === "add_region")).toBe(false);
    const notice = sent.find((c) => c.type === "set_notice") as { text: string } | undefined;
    expect(notice?.text).toMatch(/Mask from selection/);
  });

  it("a Smart layer with no subject yet keeps Subtract on the selection's terms", () => {
    const s = armed(run({ ...initialState(), panelTab: "layers" }, { type: "art_add_smart_layer" }));
    expect(liveMaskInHand(s)).toBeUndefined();
    const held = activeSelectionMask(s)!;
    expect(selectShapeTarget(s, held, "subtract").id).toBe(held.id);
  });
});

describe("the document selection with a Subject on it", () => {
  it("takes the shape itself, over a Smart layer's mask", () => {
    let s = run({ ...initialState(), panelTab: "layers" }, { type: "art_add_smart_layer" });
    const mask = `art_m_${s.artActive}`;
    s = armed(run(s, ...subject(mask)));
    // Select > Subject lands as the selection's baked base.
    s = run(s, { type: "set_text_param", id: DOC_SEL_ID, param: "matte_id", value: "baked:00ff" });
    const { el, sent } = overlay(s, "rect", "subtract");
    draw(el, "rect");
    const after = applied(s, sent);
    expect(regionsOf(after, DOC_SEL_ID).map((r) => r.op)).toEqual(["subtract"]);
    expect(regionsOf(after, mask)).toHaveLength(0);
    expect(sent.some((c) => c.type === "set_notice")).toBe(false);
  });
});

// The desktop's pixel test (src-tauri/src/smart_subtract.rs) renders
// these graphs at Fit, 1:1 and export, with a stand-in Subject matte
// planted for the Smart mask: the subject less the drawn rectangle must
// be what the layer changes, and the rectangle must be left alone. Built
// through the reducer and the overlay's own routing (selectShapeTarget).
// After a deliberate change to what the reducer builds, regenerate:
//   GEN_FIXTURE=1 npx vitest run smartsubtract
/** The Subtract, over the right part of the stand-in subject (which is
 * x 0.44..0.60, y 0.38..0.62 of the frame, smart_subtract.rs SUBJECT). */
const TAKE_OUT = { kind: "marquee", op: "subtract", x0: 0.52, y0: 0, x1: 1, y1: 1 } as const;

function subtracted(s: State): State {
  const a = armed(s);
  const target = selectShapeTarget(a, activeSelectionMask(a)!, "subtract");
  return run(a, { type: "add_region", id: target.id, region: TAKE_OUT }, { type: "set_tool", tool: "none" });
}

/** A photograph with the neutral graph, as the desktop pixel tests use. */
const neutral = (): State => ({
  ...initialState(),
  activeImage: "smart_subtract",
  nodes: structuredClone(NEUTRAL_NODES),
  wires: structuredClone(NEUTRAL_WIRES),
});

function fixtureGraphs(): Record<string, State> {
  const smartLayer = (() => {
    let s = run({ ...neutral(), panelTab: "layers" }, { type: "art_add_smart_layer" });
    s = run(s, ...subject(`art_m_${s.artActive}`));
    return subtracted(s);
  })();
  const exposureSmart = (() => {
    let s = run({ ...neutral(), panelTab: "layers" }, { type: "art_add_layer", kind: "exposure" } as Command);
    const id = s.artActive!;
    s = run(s, { type: "art_content_set", id, param: "exposure", value: 2 } as Command, { type: "art_add_mask", id, kind: "smart" });
    s = run(s, ...subject(`art_m_${id}`));
    return subtracted(s);
  })();
  const developSmart = (() => {
    let s = run(neutral(), { type: "add_layer", maskType: "smart" });
    const adj = s.activeLayer!;
    s = run(s, { type: "set_param", id: adj, param: "exposure", value: 2 }, ...subject(adj.replace("_adj", "_mask")));
    return subtracted(s);
  })();
  return { finish_smart_layer: smartLayer, finish_exposure_smart: exposureSmart, develop_smart: developSmart };
}

describe("the graphs the desktop renders", () => {
  it("carry the shape on the layer's Smart mask, and match the desktop pixel fixture", async () => {
    const { serializeGraph } = await import("../bridge");
    const graphs = fixtureGraphs();
    const fixtures = Object.fromEntries(Object.entries(graphs).map(([name, s]) => [name, serializeGraph(s)]));
    for (const [name, g] of Object.entries(fixtures)) {
      const smart = (g as { nodes: { type: string; params: Record<string, unknown> }[] }).nodes.filter((n) => n.type === "heeler.smart_mask");
      expect(smart, name).toHaveLength(1);
      expect(JSON.parse(smart[0].params.regions as string), name).toEqual([TAKE_OUT]);
    }
    const path = resolve(process.cwd(), "src/__tests__/fixtures/smart-subtract.json");
    if (process.env.GEN_FIXTURE) writeFileSync(path, JSON.stringify(fixtures, null, 1) + "\n");
    expect(fixtures).toEqual(JSON.parse(readFileSync(path, "utf8")));
  });
});
