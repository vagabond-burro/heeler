// Branch A/B (proposal §5): two graph points side by side.
//
// The reducer half is the arm/complete/disarm dance; the viewer half
// swaps the stage for the comparison while the pair is whole and falls
// back the moment an end is deleted, same as a vanished probe target.

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { initialState } from "../data";
import { reduce, type Command, type State } from "../state";
import { Viewer } from "../ui/viewer";

const run = (s: State, ...cmds: Command[]) => cmds.reduce(reduce, s);
const ab = (value: { a: string; b: string | null } | null): Command => ({
  type: "ab_compare",
  value,
});

describe("the A/B reducer", () => {
  it("arms, completes, and toggles off on the same pair", () => {
    let s = run(initialState(), ab({ a: "exposure", b: null }));
    expect(s.abCompare).toEqual({ a: "exposure", b: null });
    s = run(s, ab({ a: "exposure", b: "output" }));
    expect(s.abCompare).toEqual({ a: "exposure", b: "output" });
    // The same pair again is the off switch, the probe's contract.
    s = run(s, ab({ a: "exposure", b: "output" }));
    expect(s.abCompare).toBeNull();
  });

  it("is view state: no undo entry rides it", () => {
    const before = run(initialState());
    const after = run(before, ab({ a: "exposure", b: "output" }));
    expect(after.undoStack.length).toBe(before.undoStack.length);
  });
});

describe("the A/B stage", () => {
  const withAb = (): State => ({
    ...initialState(),
    abCompare: { a: "exposure", b: "output" },
  });

  it("replaces the single-photograph stage while the pair is whole", () => {
    render(<Viewer state={withAb()} dispatch={() => {}} />);
    // In the browser mock no frames come back, so the loading line is
    // the proof the stage swapped.
    expect(screen.getByTestId("ab-loading")).toBeInTheDocument();
    expect(screen.queryByTestId("viewer-image")).not.toBeInTheDocument();
  });

  it("falls back to the normal view when an end of the pair is gone", () => {
    const s = withAb();
    const gone = { ...s, nodes: s.nodes.filter((n) => n.id !== "exposure") };
    render(<Viewer state={gone} dispatch={() => {}} />);
    expect(screen.queryByTestId("ab-loading")).not.toBeInTheDocument();
    expect(screen.getByTestId("viewer-image")).toBeInTheDocument();
  });

  it("an armed but incomplete pair changes nothing on the stage", () => {
    const s: State = { ...initialState(), abCompare: { a: "exposure", b: null } };
    render(<Viewer state={s} dispatch={() => {}} />);
    expect(screen.queryByTestId("ab-loading")).not.toBeInTheDocument();
    expect(screen.getByTestId("viewer-image")).toBeInTheDocument();
  });
});

describe("the viewer toolbar's buttons", () => {
  it("wear icons with their names as labels", async () => {
    const { render, screen } = await import("@testing-library/react");
    const { initialState } = await import("../data");
    const { Viewer } = await import("../ui/viewer");
    render(<Viewer state={initialState()} dispatch={() => {}} previewUrl={null} previewError={null} />);
    for (const [id, name] of [
      ["btn-gamut", "Gamut"],
      ["btn-tool-crop", "Crop"],
      ["btn-tool-straighten", "Straighten"],
      ["btn-before-after", "Before / After"],
      ["btn-split", "Split"],
    ] as const) {
      const b = screen.getByTestId(id);
      expect(b.textContent, id).toBe("");
      expect(b.querySelector("svg"), id).not.toBeNull();
      expect(b.getAttribute("aria-label")).toBe(name);
    }
    // The divided frame belongs to Split now.
    expect(screen.getByTestId("btn-split").querySelector("rect")).not.toBeNull();
  });
});
