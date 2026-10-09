// The polish overlay renders the mask the resolver names, through the
// serialized graph. If the resolver's node id does not survive the trip
// into that graph, the backend silently renders the developed PHOTO as
// the "mask", and the overlay paints the photograph's own tones as
// selection coverage. The owner saw exactly that: a huge "falloff" that
// was really the out-of-focus background of the picture itself.

import { describe, expect, it } from "vitest";
import { initialState } from "../data";
import { runCommand } from "../commands";
import { activeSelectionMask, reduce, type Command, type State } from "../state";
import { serializeGraph } from "../bridge";

const run = (s: State, ...cmds: Command[]) => cmds.reduce(reduce, s);

const square = {
  kind: "path" as const,
  op: "replace" as const,
  points: [
    [0.2, 0.2],
    [0.8, 0.2],
    [0.8, 0.8],
    [0.2, 0.8],
  ] as [number, number][],
};

function maskReachesTheGraph(s: State) {
  const sel = activeSelectionMask(s);
  expect(sel, "a selection mask resolves").toBeDefined();
  const g = serializeGraph(s);
  const node = g.nodes.find((n) => n.id === sel!.id);
  expect(
    node,
    `mask ${sel!.id} is missing from the serialized graph; the backend will render the photo instead`,
  ).toBeDefined();
  expect((node!.params as Record<string, unknown>).regions).toContain("path");
}

describe("the polish overlay's mask node survives serialization", () => {
  it("for a develop selection layer", () => {
    let s = run(initialState(), { type: "add_layer", maskType: "selection" });
    const id = activeSelectionMask(s)!.id;
    s = run(s, { type: "add_region", id, region: square });
    maskReachesTheGraph(s);
  });

  it("for a document selection beside a fresh pixel layer", () => {
    // The Finish tab: a fresh pixel layer, the select tool, a lasso,
    // then Polish, which is the owner's cheetah flow.
    let s = run(
      initialState(),
      { type: "art_add_layer", kind: "paint" },
      { type: "arm_document_selection" },
    );
    const sel = activeSelectionMask(s);
    expect(sel, "the document selection resolves").toBeDefined();
    s = run(s, { type: "add_region", id: sel!.id, region: square });
    runCommand("select.polish", s, (c) => {
      s = reduce(s, c);
    });
    maskReachesTheGraph(s);
  });
});
