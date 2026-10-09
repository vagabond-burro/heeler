// The curve eyedropper's COMMIT path with a real sample coming back.
// Every other test runs the browser mock, where sampleImage returns
// null and the click correctly does nothing, which is exactly how a
// broken commit path stayed green while the desktop app dropped every
// click on the floor ("when I left-click on the image
// it's not adding a point on the curve").

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("../bridge", async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return {
    ...real,
    // A bright sky under the cursor: scene-linear just under clipping.
    sampleImage: vi.fn(async () => ({
      luma: 0.97,
      hue: 210,
      sat: 0.05,
      r: 0.9,
      g: 0.9,
      b: 0.92,
      luma_linear: 0.9,
      source: "profile",
    })),
  };
});

import { App } from "../app";
import { Viewer } from "../ui/viewer";
import { initialState } from "../data";
import { frameLook } from "../state";

describe("curve eyedropper commit with a live sample", () => {
  it("a left-click on the image adds a point where the sample lands", async () => {
    const user = userEvent.setup();
    render(<App />);
    const before = screen.getAllByTestId(/^curve-point-/).length;
    await user.click(screen.getByTestId("curve-pick"));
    fireEvent.mouseDown(screen.getByTestId("curve-pick-overlay"), { button: 0 });
    // The handler awaits the sample before dispatching.
    await waitFor(() =>
      expect(screen.getAllByTestId(/^curve-point-/).length).toBe(before + 1),
    );
    const point = screen.getAllByTestId(/^curve-point-/);
    // Display-encoded 0.9 linear is ~0.954: the new point sits up in
    // the bright end where the sample said, not in the middle.
    const xs = point.map((p) => Number(p.getAttribute("data-x") ?? p.getAttribute("cx")));
    expect(Math.max(...xs.filter((v) => Number.isFinite(v)))).toBeGreaterThan(200);
    // And on release the pick disarms: the click-and-let-go was the
    // whole answer. (Disarm moved from the press to the release when
    // the hold grew its value drag.)
    fireEvent(window, new MouseEvent("pointerup", {}));
    expect(screen.queryByTestId("curve-pick-overlay")).not.toBeInTheDocument();
  });

  it("a pick on a layer's synthesized curve tool still lands a point", async () => {
    // With a layer active, the Curves section edits the LAYER's curve
    // node, which does not exist in the graph until its first write.
    // The commit used to require it to pre-exist and returned without
    // dispatching, so the click added nothing anywhere.
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByTestId("add-layer-range"));
    const before = screen.getAllByTestId(/^curve-point-/).length;
    await user.click(screen.getByTestId("curve-pick"));
    fireEvent.mouseDown(screen.getByTestId("curve-pick-overlay"), { button: 0 });
    await waitFor(() =>
      expect(screen.getAllByTestId(/^curve-point-/).length).toBe(before + 1),
    );
  });

  it("holding the click drags the new point's value up and down", async () => {
    // "after I click to add a point, if the mouse button is
    // still held down I can drag the mouse up and down and it moves the
    // point." Up brightens; release ends the one undo step and disarms.
    const user = userEvent.setup();
    render(<App />);
    const before = screen.getAllByTestId(/^curve-point-/).length;
    await user.click(screen.getByTestId("curve-pick"));
    const overlay = screen.getByTestId("curve-pick-overlay");
    overlay.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 400, height: 400, right: 400, bottom: 400, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    fireEvent.mouseDown(overlay, { button: 0, clientY: 200 });
    await waitFor(() =>
      expect(screen.getAllByTestId(/^curve-point-/).length).toBe(before + 1),
    );
    const cyAfterAdd = screen.getByTestId("curve-point-1").getAttribute("cy");
    // Drag a quarter of the frame upward: the point's value rises.
    fireEvent(window, new MouseEvent("pointermove", { clientY: 100 }));
    const cyDragged = screen.getByTestId("curve-point-1").getAttribute("cy");
    expect(Number(cyDragged)).toBeLessThan(Number(cyAfterAdd));
    // While the hold steers the point, the hover ghost stands down:
    // the armed pick must not keep previewing the NEXT point mid-drag.
    fireEvent.mouseMove(overlay, { clientX: 120, clientY: 120 });
    await new Promise((r) => setTimeout(r, 10));
    expect(screen.queryByTestId("curve-ghost")).toBeNull();
    fireEvent(window, new MouseEvent("pointerup", {}));
    // Released: the pick disarmed.
    expect(screen.queryByTestId("curve-pick-overlay")).not.toBeInTheDocument();
  });
});

describe("the sharp ROI patch over the soft base", () => {
  const patched = () => {
    const s = initialState();
    return {
      ...s,
      viewerZoom: "100" as const,
      view: {
        ...s.view,
        roiPatch: {
          url: "data:image/png;base64,x",
          rect: [0.25, 0.25, 0.5, 0.5] as [number, number, number, number],
          frame: [6000, 4000] as [number, number],
          imageId: s.activeImage,
          look: frameLook(s),
        },
      },
    };
  };

  it("renders at its rect and hides while a gesture is live", () => {
    const s = patched();
    const { rerender } = render(
      <Viewer state={s} dispatch={() => {}} previewUrl="data:image/png;base64,y" previewError={null} previewMs={null} previewBackend={null} originalUrl={null} maskUrl={null} multiFrames={{}} />,
    );
    const patch = screen.getByTestId("roi-patch");
    expect(patch.style.left).toBe("25%");
    expect(patch.style.width).toBe("50%");
    // Mid-gesture the patch shows the pre-drag look, so it steps aside
    // and the soft-but-current base carries the drag.
    rerender(
      <Viewer state={{ ...s, gesture: "exposure.exposure" }} dispatch={() => {}} previewUrl="data:image/png;base64,y" previewError={null} previewMs={null} previewBackend={null} originalUrl={null} maskUrl={null} multiFrames={{}} />,
    );
    expect(screen.queryByTestId("roi-patch")).not.toBeInTheDocument();
  });

  it("hides a patch whose flavor does not match the view", () => {
    // "Show mask" at 1:1 with a PHOTO slice still up: the base img
    // becomes the black/white mask, and the leftover photo patch
    // covered it, so the toggle appeared to do nothing.
    const s = patched();
    render(
      <Viewer state={{ ...s, maskView: true, activeLayer: "layer_1_adj" }} dispatch={() => {}} previewUrl="data:image/png;base64,y" previewError={null} previewMs={null} previewBackend={null} originalUrl={null} maskUrl={null} multiFrames={{}} />,
    );
    expect(screen.queryByTestId("roi-patch")).not.toBeInTheDocument();
  });

  it("draws a mask-flavored patch while that mask is shown", () => {
    const s = patched();
    const masked = {
      ...s,
      maskView: true,
      activeLayer: "layer_1_adj" as const,
      view: { ...s.view, roiPatch: { ...s.view.roiPatch!, mask: "layer_1_mask" } },
    };
    render(
      <Viewer state={masked} dispatch={() => {}} previewUrl="data:image/png;base64,y" previewError={null} previewMs={null} previewBackend={null} originalUrl={null} maskUrl={null} multiFrames={{}} />,
    );
    expect(screen.getByTestId("roi-patch")).toBeInTheDocument();
  });

  it("a patch from another photograph never draws", () => {
    const s = patched();
    render(
      <Viewer state={{ ...s, view: { ...s.view, roiPatch: { ...s.view.roiPatch!, imageId: "elsewhere" } } }} dispatch={() => {}} previewUrl="data:x" previewError={null} previewMs={null} previewBackend={null} originalUrl={null} maskUrl={null} multiFrames={{}} />,
    );
    expect(screen.queryByTestId("roi-patch")).not.toBeInTheDocument();
  });
});
