// While Bake to Image waits on a stack's merge, the merge's card shows in
// the bake's dialog (bakeprogress.test.tsx), so the viewer's own copy of
// it steps aside: two cards, one behind the other's scrim, was what the owner
// saw (2026-10-08: "I saw part of a dialog appear").
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { initialState } from "../data";
import type { State } from "../state";
import { Viewer } from "../ui/viewer";

function pane(state: State) {
  return <Viewer state={state} dispatch={() => {}} previewUrl="data:image/png;base64,x"
    previewError={null} previewMs={null} previewBackend={null} originalUrl={null} maskUrl={null} multiFrames={{}} />;
}

describe("the viewer's merge card during a bake", () => {
  it("shows for a merging stack, and steps aside while that stack is being baked", () => {
    const base = initialState();
    const image = base.activeImage;
    const merge = { jobId: "stack-9", image, done: 10, total: 100, pass: 0, passes: 1, frames: 100, missing: 0, mode: "min", full: true, elapsedMs: 2000 };
    const merging: State = { ...base, stackMerges: { [image]: merge } };
    const view = render(pane(merging));
    expect(screen.getByTestId("stack-merge")).toBeTruthy();
    view.rerender(pane({ ...merging, baking: image }));
    expect(screen.queryByTestId("stack-merge")).toBeNull();
    // Another photograph's bake leaves this one's card alone.
    view.rerender(pane({ ...merging, baking: "someone-else" }));
    expect(screen.getByTestId("stack-merge")).toBeTruthy();
  });
});
