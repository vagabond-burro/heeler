// The gray around the picture wears the selection cursor while a drawn
// selection method is armed (2026-10-08: "The selection does start
// outside the photo, but the one issue is the cursor doesn't change until
// it's within the picture border so it doesn't look like selections are
// working"). A click method has nothing to start there and leaves it be.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { initialState } from "../data";
import type { State } from "../state";
import { Viewer } from "../ui/viewer";
import { selectCursor } from "../ui/selection";

afterEach(() => cleanup());

const pane = (state: State) => (
  <Viewer state={state} dispatch={() => {}} previewUrl="data:image/png;base64,x"
    previewError={null} previewMs={null} previewBackend={null} originalUrl={null} maskUrl={null} multiFrames={{}} />
);

describe("the stage's cursor under the selection tool", () => {
  it.each(["rect", "ellipse", "freehand", "magnetic"] as const)("%s: the gray says a selection can start on it", (method) => {
    const state: State = { ...initialState(), tool: "select", selectMethod: method, selectOp: "add" };
    render(pane(state));
    expect(screen.getByTestId("viewer-stage").style.cursor).toBe(selectCursor(method, "add"));
  });
  it.each(["wand", "pen", "region"] as const)("%s: the gray keeps its own cursor", (method) => {
    render(pane({ ...initialState(), tool: "select", selectMethod: method }));
    expect(screen.getByTestId("viewer-stage").style.cursor).toBe("");
  });
  it("without the selection tool the gray keeps its own cursor", () => {
    render(pane({ ...initialState(), tool: "none", selectMethod: "rect" }));
    expect(screen.getByTestId("viewer-stage").style.cursor).toBe("");
  });
});
