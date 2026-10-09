// The default graph arrives arranged, and the source card names its file.
//
// (2026-09-01), on the five-node fresh graph with Tone Profile a screen
// below the rest: "Cleaner, less nodes, but still not organized. The
// second [screenshot, after Arrange] should be the default."
import { describe, expect, it } from "vitest";
import React from "react";
import { render, screen } from "@testing-library/react";
import { NEUTRAL_NODES, NEUTRAL_WIRES, initialState } from "../data";
import { NODE_H, NODE_W, reduce, type Command, type State } from "../state";
import { arrange } from "../ui/arrange";
import { NodeEditor } from "../ui/graph";

function run(s: State, ...cmds: Command[]): State {
  return cmds.reduce(reduce, s);
}

describe("the default graph's layout", () => {
  it("is exactly what Arrange would produce, so the two never disagree", () => {
    const at = arrange(NEUTRAL_NODES, NEUTRAL_WIRES, NODE_W, NODE_H);
    for (const n of NEUTRAL_NODES) {
      expect(at.get(n.id), `${n.id} is placed`).toEqual({ x: n.x, y: n.y });
    }
  });

  it("reads as one row, left to right along the chain", () => {
    const ys = new Set(NEUTRAL_NODES.map((n) => n.y));
    expect(ys.size).toBe(1);
    // Walk the image chain from the source; every step goes right.
    let at: string | undefined = "src";
    const seen: string[] = [];
    while (at && !seen.includes(at)) {
      seen.push(at);
      at = NEUTRAL_WIRES.find((w) => w.from === at && w.kind === "image")?.to;
    }
    expect(seen[seen.length - 1]).toBe("output");
    const xs = seen.map((id) => NEUTRAL_NODES.find((n) => n.id === id)!.x);
    for (let i = 1; i < xs.length; i++) expect(xs[i]).toBeGreaterThan(xs[i - 1]);
  });

  it("Arrange on a fresh graph moves nothing", () => {
    let s = initialState();
    s = { ...s, nodes: structuredClone(NEUTRAL_NODES), wires: structuredClone(NEUTRAL_WIRES) };
    const before = s.nodes.map((n) => [n.id, n.x, n.y]);
    s = run(s, { type: "arrange_nodes" });
    expect(s.nodes.map((n) => [n.id, n.x, n.y])).toEqual(before);
  });
});

describe("loading a saved graph", () => {
  // Graphs saved before the template was arranged carry the sample
  // session's scatter. An unedited photo whose graph is just the
  // template takes the template's layout on load; anything a person
  // may have arranged is left alone.
  const scattered = () =>
    NEUTRAL_NODES.map((n, i) => ({ ...n, x: 24 + i * 300, y: 96 + (i % 2) * 400 }));

  it("snaps an unedited, template-shaped graph to the template's layout", () => {
    let s = run(initialState(), { type: "select_image", id: "4869" });
    expect(s.images.find((i) => i.id === "4869")!.edited).toBe(false);
    s = run(s, { type: "replace_graph", nodes: scattered(), wires: structuredClone(NEUTRAL_WIRES) });
    for (const n of NEUTRAL_NODES) {
      const got = s.nodes.find((x) => x.id === n.id)!;
      expect([got.x, got.y], n.id).toEqual([n.x, n.y]);
    }
  });

  it("leaves an edited photo's layout alone", () => {
    let s = run(initialState(), { type: "select_image", id: "4869" });
    s = run(s, { type: "set_param", id: "exposure", param: "exposure", value: 1 });
    expect(s.images.find((i) => i.id === "4869")!.edited).toBe(true);
    const nodes = scattered();
    s = run(s, { type: "replace_graph", nodes, wires: structuredClone(NEUTRAL_WIRES) });
    expect(s.nodes.map((n) => [n.x, n.y])).toEqual(nodes.map((n) => [n.x, n.y]));
  });

  it("leaves a graph with anything beyond the template alone", () => {
    let s = run(initialState(), { type: "select_image", id: "4869" });
    const nodes = [
      ...scattered(),
      { ...NEUTRAL_NODES[0], id: "src2", type: "heeler.image_source", x: 999, y: 999 },
    ];
    s = run(s, { type: "replace_graph", nodes, wires: structuredClone(NEUTRAL_WIRES) });
    expect(s.nodes.map((n) => [n.x, n.y])).toEqual(nodes.map((n) => [n.x, n.y]));
  });
});

describe("the source card", () => {
  it("names the photograph it decodes", () => {
    // "Shouldn't Image Source show the source file?" The
    // way a Read or Loader node in a compositor shows its file.
    let s = run(initialState(), { type: "select_image", id: "4869" });
    const name = s.images.find((i) => i.id === "4869")!.name;
    const Harness = () => {
      const [st, d] = React.useReducer(reduce, s);
      return <NodeEditor state={st} dispatch={d} />;
    };
    render(<Harness />);
    const badge = screen.getByTestId("source-file-src");
    expect(badge.textContent).toBe(name);
    expect(badge.getAttribute("title")).toBe(name);
  });
});
