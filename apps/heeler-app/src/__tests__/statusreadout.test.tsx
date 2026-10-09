// The status bar's preview-source readout: which pixels are on screen
// and who made them. The owner caught it lying two ways at once:
// Split held it on APPROX for whole sessions (the split's after half
// IS the engine frame), and identical render times froze the number
// solid ("feels like it gets stuck and stops reporting").
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { initialState } from "../data";
import { publishViewerReadout, StatusBar } from "../ui/statusbar";
import type { State } from "../state";

const bar = (state: State, over: Partial<Parameters<typeof StatusBar>[0]> = {}) =>
  render(
    <StatusBar
      state={state}
      dispatch={() => {}}
      previewUrl="blob:frame"
      previewError={null}
      previewMs={12}
      previewBackend="cpu"
      renderSeq={1}
      {...over}
    />,
  );

describe("the preview-source readout", () => {
  // The readout only renders once the viewer has published its zoom
  // and resolution labels; give it some.
  publishViewerReadout({ zoom: "FIT", res: "6000 x 4000" });
  afterEach(() => publishViewerReadout({ zoom: "FIT", res: "6000 x 4000" }));

  it("split view still counts as engine pixels", () => {
    bar({ ...initialState(), splitOn: true });
    expect(screen.getByTestId("preview-source")).toHaveTextContent("ENGINE · 12ms");
  });

  it("compare shows the source, which is neither engine nor approx", () => {
    bar({ ...initialState(), compare: true });
    expect(screen.getByTestId("preview-source")).toHaveTextContent("ORIGINAL");
  });

  it("no engine frame is the honest APPROX", () => {
    bar(initialState(), { previewUrl: null, previewMs: null, previewBackend: null });
    expect(screen.getByTestId("preview-source")).toHaveTextContent("APPROX");
  });

  it("a kept frame after a failed refresh says STALE, and does not tick", () => {
    bar(initialState(), { previewError: "boom" });
    const el = screen.getByTestId("preview-source");
    expect(el).toHaveTextContent("ENGINE · STALE");
    expect(el.className).not.toContain("engine-tick");
  });

  it("a fresh engine render wears the tick animation", () => {
    bar(initialState());
    expect(screen.getByTestId("preview-source").className).toContain("engine-tick");
  });
});
