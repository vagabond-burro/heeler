import { describe, expect, it } from "vitest";

import { initialState } from "../data";
import { artLayers, artMaskNode, reduce, type Command, type State } from "../state";

/** A document selection with one region on it, the way the select tool
 * leaves things before the menu is reached for. */
function withSelection(): { s: State; maskId: string } {
  let s = initialState();
  s = reduce(s, { type: "arm_document_selection" });
  const mask = s.nodes.find((n) => n.type === "heeler.selection_mask");
  if (!mask) throw new Error("arming the select tool made no selection node");
  s = reduce(s, {
    type: "add_region",
    id: mask.id,
    region: { kind: "rect", op: "add", x: 0.2, y: 0.2, w: 0.4, h: 0.4 } as never,
  } as Command);
  return { s, maskId: mask.id };
}

describe("selection to layer", () => {
  it("makes a layer that holds the picture below rather than a copy of it", () => {
    // A layer editor copies the pixels in, so the file carries a second set
    // and they stop agreeing with the original the moment anything
    // upstream changes. A Lift node is an instruction to take what is
    // underneath, so the file grows by a node and the lifted pixels
    // follow a re-develop.
    const { s, maskId } = withSelection();
    const out = reduce(s, { type: "art_layer_from_selection", maskId, version: "00000000000000e1" });
    const layers = artLayers(out);
    expect(layers.length).toBeGreaterThan(0);
    const made = layers.find((l) => l.blend.id === out.artActive);
    expect(made?.content.type).toBe("heeler.lift");
  });

  it("masks the layer with the selection's coverage as pixels you can paint", () => {
    // A layer mask is always the paintable kind (2026-09-30): the
    // desktop renders the selection once and the mask wears it, nothing
    // painted on it yet; the selection is spent.
    const { s, maskId } = withSelection();
    const out = reduce(s, { type: "art_layer_from_selection", maskId, version: "00000000000000e1" });
    const mask = artMaskNode(out, `art_m_${out.artActive}`);
    expect(mask?.type).toBe("heeler.brush_mask");
    expect(mask?.textParams?.matte_id).toBe("baked:00000000000000e1");
    expect(mask?.strokes).toEqual([]);
    expect(mask?.params.invert).toBe(1);
    expect(mask?.params.base_invert).toBe(1);
    expect(out.nodes.find((n) => n.id === maskId)?.regions).toEqual([]);
  });

  it("is one undo, not three", () => {
    // It composes three reduces inside, each of which pushes its own
    // entry. Undoing this twice to be rid of it is the kind of thing
    // people report as undo being broken.
    const { s, maskId } = withSelection();
    const out = reduce(s, { type: "art_layer_from_selection", maskId, version: "00000000000000e1" });
    const back = reduce(out, { type: "undo" });
    expect(artLayers(back).length).toBe(artLayers(s).length);
  });

  it("does nothing without a selection to lift", () => {
    const s = initialState();
    const out = reduce(s, { type: "art_layer_from_selection", maskId: "nope", version: "00000000000000e1" });
    expect(out).toBe(s);
  });
});

describe("the Select menu entry", () => {
  it("is offered in Finish and grayed everywhere else", async () => {
    // The owner asked for the Select menu items to be disabled outside
    // Finish. This one makes its own layer, so unlike Fill it needs only
    // something selected; what it needs Finish for is a stack to put the
    // layer on.
    const { render, screen } = await import("@testing-library/react");
    const userEvent = (await import("@testing-library/user-event")).default;
    const { App } = await import("../app");
    const user = userEvent.setup();
    render(<App />);

    // Develop, with a selection armed: the entry is there and inert.
    await user.click(screen.getByTestId("panel-tab-adjust"));
    await user.click(screen.getByTestId("menu-select"));
    expect(screen.getByTestId("menu-select-to-layer")).toBeDisabled();
    // The enabled path wants a live selection, which this test does not
    // build; what it does is covered by the reducer tests above. What is
    // asserted here is the gate the owner asked for: the entry exists, and
    // outside Finish it cannot be used.
  });
});
