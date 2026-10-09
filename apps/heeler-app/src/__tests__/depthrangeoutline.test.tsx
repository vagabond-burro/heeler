import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { initialState } from "../data";
import { runCommand } from "../commands";
import { activeSelectionMask, maskPreviewNode, previewTarget, reduce, type State } from "../state";
import { renderMaskOf, serializeGraph } from "../bridge";
import { clearLog, logAsText, setLogLevel } from "../log";
import { depthWanted } from "../ui/depthtool";
import { useEngineMask, useSelectionOutline } from "../ui/selection";
import { selectionField, type FramePixels } from "../ui/selectionfield";

vi.mock("../bridge", async (original) => ({
  ...await original<typeof import("../bridge")>(),
  renderMaskOf: vi.fn(async () => "mask"),
}));

function frame(values: number[]): FramePixels {
  return { w: 2, h: 2, data: new Uint8ClampedArray(values.flatMap(v => [v, v, v, 255])) };
}
const photograph = frame([255, 255, 0, 0]);
const depthView = frame([255, 0, 255, 0]);
const mask = frame([0, 255, 0, 255]);
function selection() {
  let s = initialState();
  runCommand("select.range.depth", s, c => { s = reduce(s, c); }, {});
  return s;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(renderMaskOf).mockResolvedValue("mask");
  vi.stubGlobal("Image", class {
    naturalWidth = 2;
    naturalHeight = 2;
    onload: (() => void) | null = null;
    set src(_: string) { queueMicrotask(() => this.onload?.()); }
  });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => ({
    drawImage: vi.fn(), getImageData: () => ({ data: mask.data }),
  }) as unknown as CanvasRenderingContext2D);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  setLogLevel("info", true);
});

it("the view changes neither the selection node nor its regions or serialized graph", () => {
  setLogLevel("debug", true);
  clearLog();
  const off = selection();
  const on = reduce(off, { type: "toggle_depth_view" });
  expect(depthWanted(off)).toBe(true);
  expect(activeSelectionMask(on)).toBe(activeSelectionMask(off));
  expect(activeSelectionMask(on)!.regions).toEqual(activeSelectionMask(off)!.regions);
  expect(serializeGraph(on)).toEqual(serializeGraph(off));
  expect(maskPreviewNode(on)).toBe(maskPreviewNode(off));
  expect(previewTarget(on)).toBe("__depth__");
  console.log(logAsText());
});

it("depth ants use the same rendered mask with the photograph or depth view displayed", async () => {
  const off = selection();
  const node = activeSelectionMask(off)!;
  const hook = renderHook(({ state, pixels }) => useSelectionOutline(node, pixels, state), {
    initialProps: { state: off, pixels: photograph },
  });
  await waitFor(() => expect(renderMaskOf).toHaveBeenCalledWith(off, node.id));
  await waitFor(() => expect(hook.result.current.ants.length).toBeGreaterThan(0));
  const ants = hook.result.current;
  hook.rerender({ state: reduce(off, { type: "toggle_depth_view" }), pixels: depthView });
  expect(hook.result.current).toEqual(ants);
});

it("a depth range never falls back to the displayed brightness while its mask is pending", async () => {
  vi.mocked(renderMaskOf).mockResolvedValue(null);
  const state = selection();
  const node = activeSelectionMask(state)!;
  const hook = renderHook(() => useSelectionOutline(node, photograph, state));
  await waitFor(() => expect(renderMaskOf).toHaveBeenCalled());
  expect(hook.result.current.ants).toEqual([]);
});

it("the geometry-only field cannot guess depth from displayed pixels", () => {
  const regions = activeSelectionMask(selection())!.regions!;
  const photo = selectionField(regions, photograph, {});
  const depth = selectionField(regions, depthView, {});
  console.log(`depth fallback: photo=${Array.from(photo).filter(v => v > 0.5).length} view=${Array.from(depth).filter(v => v > 0.5).length} equal=${photo.every((v, i) => v === depth[i])}`);
  expect(photo.every(v => v === 0)).toBe(true);
  expect(depth).toEqual(photo);
});

it("a landed plane and a different photograph refresh the engine mask", async () => {
  const off = selection();
  const node = activeSelectionMask(off)!;
  const hook = renderHook(({ state }: { state: State }) => useEngineMask(state, node.id), {
    initialProps: { state: off },
  });
  await waitFor(() => expect(hook.result.current).not.toBeNull());
  expect(renderMaskOf).toHaveBeenCalledTimes(1);
  const landed = reduce(off, { type: "poke_render" });
  hook.rerender({ state: landed });
  await waitFor(() => expect(renderMaskOf).toHaveBeenCalledTimes(2));
  let finish!: (value: string | null) => void;
  vi.mocked(renderMaskOf).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  hook.rerender({ state: { ...landed, activeImage: "another-image" } });
  expect(hook.result.current).toBeNull();
  await waitFor(() => expect(renderMaskOf).toHaveBeenCalledTimes(3));
  await act(async () => finish("mask"));
  await waitFor(() => expect(hook.result.current).not.toBeNull());
});
