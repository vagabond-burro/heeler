// (2026-09-29), zoomed in on the lemur with a Polished and Applied
// Smart 1 selection, Option-clicking the SELECTION MASK eye: "the icon
// updated but the red overlay stayed (did not go to mask)", then "oh
// wait it did, but it took like 20 seconds". Zoomed in, a sharp slice
// lies over the soft frame. The flavor flip re-rendered the soft frame
// in black and white (the histogram followed it at once), but the slice
// was chosen and asked for by the view's TARGET alone, and the flip
// keeps the target: the red slice stayed on top, and no new slice was
// asked for until the next pan or edit, about 20 seconds later in the
// log. The slice now carries its look (frameLook), draws only while the
// view has that look, and a change of look asks for a new one.
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initialState } from "../data";
import { frameLook, maskOverlayWanted, previewTarget, reduce, type Command, type State } from "../state";
import { Viewer } from "../ui/viewer";

const roi = vi.hoisted(() => ({ renderRoi: vi.fn(), cancelRender: vi.fn() }));
vi.mock("../bridge", async (original) => ({
  ...(await original<typeof import("../bridge")>()),
  isTauri: () => true,
  renderRoi: roi.renderRoi,
  cancelRender: roi.cancelRender,
  imageMetadata: async () => null,
  filePasses: async () => null,
  depthMap: () => new Promise(() => {}),
}));

type Patch = NonNullable<State["view"]["roiPatch"]>;

const run = (s: State, ...cmds: Command[]) => cmds.reduce(reduce, s);

const zoomedIn = (s: State): State => ({
  ...s,
  viewerZoom: "100",
  view: { ...s.view, frameDims: { [s.activeImage]: [6000, 4000] }, roiPatch: null },
});

/** The slice the engine would answer for this view. */
const sliceOf = (s: State, url: string): Patch => ({
  url,
  rect: [0, 0, 1, 1],
  frame: [6000, 4000],
  imageId: s.activeImage,
  mask: previewTarget(s),
  look: frameLook(s),
});

const withPatch = (s: State, p: Patch): State => ({ ...s, view: { ...s.view, roiPatch: p } });

const viewer = (s: State, dispatch: (c: unknown) => void) => (
  <Viewer state={s} dispatch={dispatch as never} previewUrl="data:image/png;base64,y" previewError={null} previewMs={null} previewBackend={null} originalUrl={null} maskUrl={null} multiFrames={{}} />
);

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

/** Every eye whose view can wear either flavor, in the red flavor. */
const layerEye = () => run(zoomedIn({ ...initialState(), maskRed: true, activeLayer: "layer_1_adj" }), { type: "toggle_mask_view" });
const colorSetEye = () => {
  const s = run(zoomedIn(initialState()), { type: "add_color_set" });
  const set = s.nodes.find((n) => /^cset\d+_mask$/.test(n.id))!.id;
  return run(s, { type: "toggle_depth_view", flavor: true, mask: set });
};
const depthEye = () => run(zoomedIn(initialState()), { type: "toggle_depth_view", flavor: true });
const finishEye = () => {
  let s = run(zoomedIn(initialState()), { type: "set_panel_tab", tab: "layers" }, { type: "art_add_layer", kind: "paint" });
  s = run(s, { type: "art_add_mask", id: s.artActive!, kind: "brush" });
  return run(s, { type: "toggle_depth_view", flavor: true, mask: `art_m_${s.artActive}` });
};

const eyes: [string, () => State][] = [
  ["the layer's selection mask eye", layerEye],
  ["a Color Set's eye", colorSetEye],
  ["the depth eye", depthEye],
  ["a Finish layer's mask eye", finishEye],
];

describe("a flavor flip zoomed in ('the icon updated but the red overlay stayed')", () => {
  for (const [name, red] of eyes) {
    for (const [from, to] of [["red", "black and white"], ["black and white", "red"]] as const) {
      it(`${name}: ${from} to ${to} hides the old slice at once and asks for a slice in the new flavor`, async () => {
        const start = from === "red" ? red() : run(red(), { type: "toggle_mask_flavor" });
        expect(previewTarget(start)).not.toBeNull();
        expect(maskOverlayWanted(start)).toBe(from === "red");
        // The slice of the starting flavor is up.
        roi.renderRoi.mockReturnValue(new Promise(() => {}));
        const dispatch = vi.fn();
        const shown = withPatch(start, sliceOf(start, "data:image/png;base64,old"));
        const view = render(viewer(shown, dispatch));
        expect(screen.getByTestId("roi-patch")).toBeInTheDocument();
        await new Promise((r) => setTimeout(r, 200));
        const asked = roi.renderRoi.mock.calls.length;
        // The Option-click: same target, the other flavor.
        const flipped = run(shown, { type: "toggle_mask_flavor" });
        expect(previewTarget(flipped)).toBe(previewTarget(start));
        expect(maskOverlayWanted(flipped)).toBe(to === "red");
        let answer: (p: Patch) => void = () => {};
        roi.renderRoi.mockImplementation(() => new Promise<Patch>((r) => { answer = r; }));
        view.rerender(viewer(flipped, dispatch));
        // The old flavor's slice steps aside in the same commit, so the
        // soft frame of the new flavor shows while the sharp one renders.
        expect(screen.queryByTestId("roi-patch")).toBeNull();
        await waitFor(() => expect(roi.renderRoi.mock.calls.length).toBeGreaterThan(asked));
        const sent = roi.renderRoi.mock.calls[roi.renderRoi.mock.calls.length - 1][0] as State;
        expect(maskOverlayWanted(sent)).toBe(to === "red");
        expect(previewTarget(sent)).toBe(previewTarget(start));
        answer(sliceOf(sent, "data:image/png;base64,new"));
        await waitFor(() => expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "set_roi_patch" })));
        const landed = dispatch.mock.calls.map((c) => c[0]).filter((c) => c.type === "set_roi_patch").pop()!.patch as Patch;
        expect(landed.look).toBe(frameLook(flipped));
        // And the new slice draws over the new flavor's frame.
        view.rerender(viewer(withPatch(flipped, landed), dispatch));
        expect(screen.getByTestId("roi-patch")).toBeInTheDocument();
      });
    }
  }

  it("the overlay's color and strength are part of the look; they matter only while the overlay shows", () => {
    const red = layerEye();
    expect(frameLook({ ...red, prefs: { ...red.prefs, maskOverlayColor: "green" } })).not.toBe(frameLook(red));
    expect(frameLook({ ...red, brushOverlayStrength: 0.8 })).not.toBe(frameLook(red));
    const bw = run(red, { type: "toggle_mask_flavor" });
    expect(frameLook({ ...bw, brushOverlayStrength: 0.8 })).toBe(frameLook(bw));
    expect(frameLook({ ...bw, gamutView: !bw.gamutView })).not.toBe(frameLook(bw));
  });
});
