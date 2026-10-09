// A section shows its controls before its node exists, and the first
// move builds it. "I do not see any sliders until I turn
// on Sharpening. Like with other Adjustment tools, Heeler can show
// the sliders even if the node(s) are not yet created."
//
// Sharpening and Skin Softening became groups of real nodes on
// 2026-09-23. The panel's preview built every category piece as a bare
// node of the piece's type, which for the two groups was a heeler.group
// with no tool and no dials; toolNode looks a group up by its tool, so
// it found nothing and the sections drew a title and a switch.

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { initialState } from "../data";
import { CATEGORY_PIECES } from "../recipes";
import { freshGraphFor, reduce, type Command, type NodeCard, type State } from "../state";
import { SECTIONS, SimplePanel, previewNodes } from "../ui/simple";

afterEach(cleanup);

/** A photograph opened for the first time: the fresh graph, which
 * carries none of the on-demand sections. */
function freshPhoto(): State {
  const s = initialState();
  const g = freshGraphFor(s, s.activeImage ?? "");
  return { ...s, nodes: g.nodes, wires: g.wires, undoStack: [], redoStack: [] };
}

const node = (s: State, id: string): NodeCard | undefined => s.nodes.find((n) => n.id === id);

const GROUPS = [
  { title: "Sharpening", id: "sharpening", param: "intensity", start: 50 },
  { title: "Skin Softening", id: "skin", param: "strength", start: 50 },
] as const;

describe("a tool group section before its group exists", () => {
  it("every on-demand section has a node to draw its controls from", () => {
    const real = freshPhoto();
    const s: State = { ...real, nodes: [...real.nodes, ...previewNodes(real.nodes)] };
    const missing: string[] = [];
    for (const sec of SECTIONS.filter((x) => CATEGORY_PIECES[x.title])) {
      if (!sec.node(s)) missing.push(sec.title);
    }
    expect(missing).toEqual([]);
  });

  for (const g of GROUPS) {
    it(`${g.title} shows its sliders at a fresh group's values with nothing built`, () => {
      const s = reduce(freshPhoto(), { type: "open_section", title: g.title });
      expect(node(s, g.id)).toBeUndefined();
      render(<SimplePanel state={s} dispatch={(() => {}) as never} />);
      const section = document.querySelector(`[data-section="${g.title}"]`) as HTMLElement;
      const sec = SECTIONS.find((x) => x.title === g.title)!;
      for (const row of sec.rows) {
        expect(within(section).getByTestId(`slider-${row.param}`)).toBeInTheDocument();
      }
      const track = within(within(section).getByTestId(`slider-${g.param}`)).getByRole("slider");
      expect(Number(track.getAttribute("aria-valuenow"))).toBe(g.start);
      // Off until something is said, like every other on-demand section.
      expect(within(section).getByRole("switch").getAttribute("aria-checked")).toBe("false");
    });

    it(`${g.title}: the first move builds the group with that value, switched on, as one undo step`, () => {
      let s = reduce(freshPhoto(), { type: "open_section", title: g.title });
      const before = s;
      const dispatch = (c: Command) => (s = reduce(s, c));
      render(<SimplePanel state={s} dispatch={dispatch as never} />);
      const section = document.querySelector(`[data-section="${g.title}"]`) as HTMLElement;
      fireEvent.keyDown(within(within(section).getByTestId(`slider-${g.param}`)).getByRole("slider"), { key: "ArrowRight" });
      const built = node(s, g.id)!;
      expect(built).toBeDefined();
      expect(built.isGroup).toBe(true);
      expect(built.tool).toBe(g.id);
      expect(built.enabled).toBe(true);
      expect(built.params[g.param]).toBe(g.start + 1);
      expect(s.undoStack.length).toBe(before.undoStack.length + 1);
      // The group built by the move is the group the switch builds, with
      // the same move made on it: dials, members and wiring.
      const bySwitch = [
        { type: "set_category", title: g.title, on: true },
        { type: "set_param", id: g.id, param: g.param, value: g.start + 1 },
      ].reduce((acc, c) => reduce(acc, c as Command), before);
      expect(built).toEqual(node(bySwitch, g.id));
      expect(s.wires).toEqual(bySwitch.wires);
      // One undo takes both the build and the move back.
      s = reduce(s, { type: "undo" });
      expect(node(s, g.id)).toBeUndefined();
      expect(s.nodes).toEqual(before.nodes);
      expect(s.wires).toEqual(before.wires);
    });
  }

  it("a drag that builds the group stays one undo step to its end", () => {
    let s = freshPhoto();
    const before = s;
    const cmds: Command[] = [
      { type: "begin_gesture", key: "sharpening.radius" },
      {
        type: "set_category",
        title: "Sharpening",
        on: true,
        then: { type: "set_param", id: "sharpening", param: "radius", value: 5 },
      },
      { type: "set_param", id: "sharpening", param: "radius", value: 7 },
      { type: "set_param", id: "sharpening", param: "radius", value: 9 },
      { type: "end_gesture" },
    ];
    for (const c of cmds) s = reduce(s, c);
    expect(node(s, "sharpening")!.params.radius).toBe(9);
    expect(s.undoStack.length).toBe(before.undoStack.length + 1);
    s = reduce(s, { type: "undo" });
    expect(node(s, "sharpening")).toBeUndefined();
  });

  it("choosing the recipe before the group exists builds it in that mode, switched on, as one undo step", () => {
    let s = reduce(freshPhoto(), { type: "open_section", title: "Sharpening" });
    const before = s;
    render(<SimplePanel state={s} dispatch={((c: Command) => (s = reduce(s, c))) as never} />);
    fireEvent.click(screen.getByTestId("sharpen-mode-hipass"));
    expect(node(s, "sharpening")!.textParams?.mode).toBe("hipass");
    expect(node(s, "sharpening")!.enabled).toBe(true);
    expect(s.undoStack.length).toBe(before.undoStack.length + 1);
  });
});
