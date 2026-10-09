// (2026-09-26): the depth view in a radial layer "does not always
// render unless I zoom in or out. And sometimes it renders then
// disappears again." Zoomed in, the viewer lays a sharp 1:1 slice over
// the soft frame, and it chose which slice may draw by the MASK view
// alone, so a photograph slice (or the layer's mask slice) kept drawing
// over the depth frame, a toggle never asked for a depth slice, and a
// photograph slice asked for before the toggle landed after it and
// covered the depth frame the pump had just shown.
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initialState } from "../data";
import { frameLook, previewTarget, reduce, type State } from "../state";
import { Viewer } from "../ui/viewer";

const roi = vi.hoisted(() => ({ renderRoi: vi.fn(), cancelRender: vi.fn() }));
vi.mock("../bridge", async (original) => ({
  ...(await original<typeof import("../bridge")>()),
  isTauri: () => true,
  renderRoi: roi.renderRoi,
  cancelRender: roi.cancelRender,
  imageMetadata: async () => null,
  filePasses: async () => null,
  // The depth runner asks for the plane while the eye is on; the answer
  // is not what these tests are about.
  depthMap: () => new Promise(() => {}),
}));

type Patch = NonNullable<State["view"]["roiPatch"]>;

const at100 = (patch: Partial<Patch> | null): State => {
  const s = initialState();
  return {
    ...s,
    viewerZoom: "100",
    view: {
      ...s.view,
      frameDims: { [s.activeImage]: [6000, 4000] },
      roiPatch: patch
        ? { url: "data:image/png;base64,x", rect: [0.25, 0.25, 0.5, 0.5], frame: [6000, 4000], imageId: s.activeImage, look: frameLook(s), ...patch }
        : null,
    },
  };
};

const show = (s: State, dispatch: (c: unknown) => void = () => {}) =>
  render(<Viewer state={s} dispatch={dispatch as never} previewUrl="data:image/png;base64,y" previewError={null} previewMs={null} previewBackend={null} originalUrl={null} maskUrl={null} multiFrames={{}} />);

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class {
    constructor(private callback: ResizeObserverCallback) {}
    observe(target: Element) {
      if (target.getAttribute("data-testid") === "viewer-stage")
        this.callback([{ contentRect: { width: 1200, height: 800 } } as ResizeObserverEntry], this as unknown as ResizeObserver);
    }
    disconnect() {}
    unobserve() {}
  });
  roi.renderRoi.mockReset();
  roi.cancelRender.mockClear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the 1:1 slice under the depth view", () => {
  it("a photograph slice does not draw over the depth frame", () => {
    roi.renderRoi.mockReturnValue(new Promise(() => {}));
    const s = reduce(at100({ mask: null }), { type: "toggle_depth_view" });
    show(s);
    expect(screen.queryByTestId("roi-patch")).toBeNull();
  });

  it("the layer's mask slice does not draw over the depth frame either", () => {
    roi.renderRoi.mockReturnValue(new Promise(() => {}));
    let s: State = { ...at100({ mask: "layer_1_mask" }), maskView: true, activeLayer: "layer_1_adj" };
    s = reduce(s, { type: "toggle_depth_view" });
    expect(previewTarget(s)).toBe("__depth__");
    show(s);
    expect(screen.queryByTestId("roi-patch")).toBeNull();
  });

  it("a depth slice draws while the depth view is up", () => {
    roi.renderRoi.mockReturnValue(new Promise(() => {}));
    const s = reduce(at100({ mask: "__depth__" }), { type: "toggle_depth_view" });
    show(s);
    expect(screen.getByTestId("roi-patch")).toBeInTheDocument();
  });

  it("a depth slice left over after the view goes off does not draw over the photograph", () => {
    roi.renderRoi.mockReturnValue(new Promise(() => {}));
    show(at100({ mask: "__depth__" }));
    expect(screen.queryByTestId("roi-patch")).toBeNull();
  });

  it("the toggle asks for a depth slice, and a photograph slice asked for before it never lands", async () => {
    let answerPhoto: (p: Patch) => void = () => {};
    let answerDepth: (p: Patch) => void = () => {};
    roi.renderRoi
      .mockImplementationOnce(() => new Promise<Patch>((r) => { answerPhoto = r; }))
      .mockImplementationOnce(() => new Promise<Patch>((r) => { answerDepth = r; }));
    const dispatch = vi.fn();
    const off = at100(null);
    const view = show(off, dispatch);
    await waitFor(() => expect(roi.renderRoi).toHaveBeenCalledTimes(1));
    expect(previewTarget(roi.renderRoi.mock.calls[0][0])).toBeNull();
    // The eye goes on while the photograph slice is still rendering.
    const on = reduce(off, { type: "toggle_depth_view" });
    view.rerender(<Viewer state={on} dispatch={dispatch} previewUrl="data:image/png;base64,y" previewError={null} previewMs={null} previewBackend={null} originalUrl={null} maskUrl={null} multiFrames={{}} />);
    await waitFor(() => expect(roi.renderRoi).toHaveBeenCalledTimes(2));
    expect(previewTarget(roi.renderRoi.mock.calls[1][0])).toBe("__depth__");
    const base = { url: "data:image/png;base64,z", rect: [0, 0, 1, 1] as Patch["rect"], frame: [6000, 4000] as Patch["frame"], imageId: off.activeImage, look: frameLook(off) };
    answerPhoto({ ...base, mask: null });
    answerDepth({ ...base, mask: "__depth__" });
    await waitFor(() => expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "set_roi_patch" })));
    const patches = dispatch.mock.calls.map((c) => c[0]).filter((c) => c.type === "set_roi_patch");
    expect(patches.map((c) => c.patch.mask)).toEqual(["__depth__"]);
  });
});


it("leaving a sharp zone view cancels its obsolete engine work", async () => {
  roi.renderRoi.mockReturnValue(new Promise(() => {}));
  const view = show({ ...at100(null), zoneHover: 4 });
  await waitFor(() => expect(roi.renderRoi).toHaveBeenCalledTimes(1));
  const token = roi.renderRoi.mock.calls[0][2];
  expect(token).toMatch(/^roi:/);
  view.unmount();
  expect(roi.cancelRender).toHaveBeenCalledWith(token);
});
