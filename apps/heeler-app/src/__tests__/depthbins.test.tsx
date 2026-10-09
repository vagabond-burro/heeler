import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { initialState } from "../data";
import { useDepthBins } from "../ui/depthbins";
import * as bridge from "../bridge";
import { reduce } from "../state";

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
it.each([false, true])("map Levels refresh the reader bins, keeping raw bins stable: raw=%s", async raw => {
  const read = vi.spyOn(bridge, "depthHistogram").mockResolvedValue([0, 1]);
  const s = reduce(initialState(), { type: "set_category", title: "Depth Map", on: true });
  const view = renderHook(({ state }) => useDepthBins(state, true, raw), { initialProps: { state: s } });
  await act(async () => {});
  const id = s.nodes.find(n => n.type === "heeler.depth_map")!.id;
  const changed = reduce(s, { type: "set_param", id, param: "depth_black", value: 0.2 });
  view.rerender({ state: changed });
  await act(async () => {});
  expect(read).toHaveBeenCalledTimes(raw ? 1 : 2);
  view.unmount();
});
it("clears the previous photo's bins and cancels polling on unmount", async () => {
  vi.useFakeTimers();
  const read = vi.spyOn(bridge, "depthHistogram").mockResolvedValueOnce([0, 1]).mockResolvedValue(null);
  const s = initialState();
  const view = renderHook(({ state }) => useDepthBins(state, true), { initialProps: { state: s } });
  await act(async () => {});
  expect(view.result.current).toEqual([0, 1]);
  view.rerender({ state: { ...s, activeImage: "other" } });
  await act(async () => {});
  expect(view.result.current).toBeNull();
  await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
  expect(read).toHaveBeenCalledTimes(3);
  view.unmount();
  await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
  expect(read).toHaveBeenCalledTimes(3);
});
