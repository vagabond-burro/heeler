import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { initialState, NEUTRAL_NODES, NEUTRAL_WIRES } from "../data";
import { artLayers, reduce, type Command, type State } from "../state";
import { makeNode, specFor } from "../nodes";
import { runBakeWarp } from "../layeractions";
import { runLayerViaCopy } from "../commands";
import { SectionLooks } from "../ui/sectionlooks";
import { placeImageFile, placeCatalogImage } from "../ui/imagelayers";
import { clearAllOps } from "../ui/opprogress";

const bridge = vi.hoisted(() => ({ bake: vi.fn(), copy: vi.fn(), histogram: vi.fn(), depth: vi.fn(), probe: vi.fn() }));
vi.mock("../bridge", async (original) => ({
  ...await original<typeof import("../bridge")>(),
  bakeWarpLayer: bridge.bake, bakeLayerCopy: bridge.copy,
  depthHistogram: bridge.histogram, depthMap: bridge.depth, imageLayerProbe: bridge.probe,
}));
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
function fresh(): State {
  return { ...initialState(), activeImage: "review-photo", mode: "simple", panelTab: "layers",
    nodes: structuredClone(NEUTRAL_NODES), wires: structuredClone(NEUTRAL_WIRES) };
}
beforeEach(() => { bridge.histogram.mockResolvedValue(null); });
afterEach(() => { cleanup(); clearAllOps(); vi.clearAllMocks(); });

for (const operation of ["warp", "copy"] as const) {
  // The landing is keyed to the photograph, the take and the crop its
  // box is measured in; any other edit in between keeps it (the Finish
  // review, stage 2: stage 1 dropped it on every edit and every
  // background poke of the render).
  for (const change of ["photo", "edit", "crop", "take", "none"] as const) {
    it(`${operation} result belongs only to its starting photograph, take and crop: ${change}`, async () => {
      let state = reduce(fresh(), { type: "art_add_layer", kind: "warp" });
      const pending = deferred<any>();
      const native = operation === "warp" ? bridge.bake : bridge.copy;
      native.mockReturnValueOnce(pending.promise);
      const sent: Command[] = [];
      const dispatch = (cmd: Command) => { sent.push(cmd); state = reduce(state, cmd); };
      if (operation === "warp") runBakeWarp(state, dispatch, state.artActive!);
      else runLayerViaCopy(state, dispatch, "review-selection");
      await waitFor(() => expect(native).toHaveBeenCalledTimes(1));
      if (change === "photo") state = { ...state, activeImage: "other-photo" };
      if (change === "edit") state = reduce(state, { type: "set_param", id: "exposure", param: "exposure", value: 1 });
      if (change === "crop") {
        // A real crop: the neutral graph has no crop node, so one is added on.
        const crop = { ...makeNode(specFor("heeler.crop_rotate")!, "crop", 0, 0), enabled: true };
        crop.params = { ...crop.params, crop_w: 0.5 };
        state = { ...state, nodes: [...state.nodes, crop] };
      }
      if (change === "take") state = { ...state, activeTakes: { [state.activeImage]: "other-take" } };
      const atLanding = state;
      pending.resolve({ path: "/review/bake.tif", box: [0, 0, 1, 1], aspect: 1.5, width: 600, height: 400 });
      await waitFor(() => expect(sent.some((c) => c.type === (operation === "warp" ? "art_bake_warp" : "art_layer_via_copy"))).toBe(true));
      if (change === "none" || change === "edit") {
        expect(state.undoStack.length).toBe(atLanding.undoStack.length + 1);
        expect(artLayers(state).some((l) => l.content.textParams?.path === "/review/bake.tif")).toBe(true);
      } else {
        expect(state.nodes).toBe(atLanding.nodes);
        expect(state.wires).toBe(atLanding.wires);
        expect(state.undoStack).toBe(atLanding.undoStack);
      }
    });
  }
}

it("an old photograph's depth completion cannot enable the new photograph's depth looks", async () => {
  const pending = deferred<any>();
  bridge.depth.mockReturnValueOnce(pending.promise);
  const state = fresh();
  const mounted = render(<SectionLooks section="Recolor" state={state} dispatch={vi.fn()} />);
  fireEvent.click(await screen.findByTestId("looks-recolor-read-depth"));
  await waitFor(() => expect(bridge.depth).toHaveBeenCalledTimes(1));
  mounted.rerender(<SectionLooks section="Recolor" state={{ ...state, activeImage: "new-photo" }} dispatch={vi.fn()} />);
  await screen.findByTestId("looks-recolor-read-depth");
  await act(async () => pending.resolve({ version: "old-photo-depth" }));
  fireEvent.click(screen.getByTestId("looks-recolor-menu"));
  expect(screen.getByTestId("looks-recolor-menu-option-recolor-cool-distance")).toHaveAttribute("aria-disabled", "true");
});

it("a pending hover ends when the photograph changes before its delay", async () => {
  const sent: Command[] = [];
  const dispatch = (c: Command) => { sent.push(c); };
  const state = fresh();
  const mounted = render(<SectionLooks section="Recolor" state={state} dispatch={dispatch} />);
  fireEvent.click(screen.getByTestId("looks-recolor-menu"));
  fireEvent.mouseEnter(screen.getByTestId("looks-recolor-menu-option-recolor-autumn"));
  mounted.rerender(<SectionLooks section="Recolor" state={{ ...state, activeImage: "next-photo" }} dispatch={dispatch} />);
  await act(() => new Promise((r) => setTimeout(r, 120)));
  expect(sent.filter((c) => c.type === "preview_section_look" && c.id !== null)).toEqual([]);
});

for (const source of ["file", "catalog"] as const) {
  it(`a delayed ${source} image probe cannot add a layer to another photograph`, async () => {
    let state = fresh();
    const pending = deferred<any>();
    bridge.probe.mockReturnValueOnce(pending.promise);
    const dispatch = (c: Command) => { state = reduce(state, c); };
    const done = source === "file" ? placeImageFile(state, dispatch, "/review/image.png") : placeCatalogImage(state, dispatch, "catalog-photo", "Image");
    state = { ...state, activeImage: "other-photo" };
    const before = state;
    pending.resolve({ missing: false, width: 400, height: 300 });
    await done;
    expect(state.nodes).toBe(before.nodes);
    expect(state.undoStack).toBe(before.undoStack);
  });
}

it("depth-look availability is checked again when the Depth Map recipe changes", async () => {
  bridge.histogram.mockResolvedValueOnce([1, 0.5]).mockResolvedValue(null);
  const state = fresh();
  const depthNode = { ...state.nodes[0], id: "depthmap", type: "heeler.depth_map", enabled: true, params: { edges: 0, size: 518 } };
  state.nodes = [...state.nodes, depthNode];
  const mounted = render(<SectionLooks section="Recolor" state={state} dispatch={vi.fn()} />);
  await waitFor(() => expect(bridge.histogram).toHaveBeenCalledTimes(1));
  await act(() => Promise.resolve());
  mounted.rerender(<SectionLooks section="Recolor" state={{ ...state, nodes: state.nodes.map((n) => n.id === "depthmap" ? { ...n, params: { ...n.params, edges: 20 } } : n) }} dispatch={vi.fn()} />);
  await waitFor(() => expect(bridge.histogram).toHaveBeenCalledTimes(2));
  fireEvent.click(screen.getByTestId("looks-recolor-menu"));
  expect(screen.getByTestId("looks-recolor-menu-option-recolor-cool-distance")).toHaveAttribute("aria-disabled", "true");
});
