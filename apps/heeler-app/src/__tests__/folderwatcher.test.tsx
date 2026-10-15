import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { initialState } from "../data";
import { listSubfolders } from "../bridge";
import { useFolderWatcher } from "../ui/folderwatcher";
vi.mock("../bridge", () => ({ listSubfolders: vi.fn() }));
afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); });
it("a stalled directory poll stays off the next ticks and cannot update after unmount", async () => {
  vi.useFakeTimers();
  let finish!: (rows: []) => void;
  vi.mocked(listSubfolders).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const ref = { current: { ...initialState(), activeFolderPath: "/Volumes/Photos", activeCollection: null } };
  const dispatch = vi.fn();
  const hook = renderHook(() => useFolderWatcher(ref, dispatch));
  await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
  expect(listSubfolders).toHaveBeenCalledTimes(1);
  await act(async () => finish([]));
  expect(dispatch).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
  expect(listSubfolders).toHaveBeenCalledTimes(2);
  hook.unmount();
  await act(async () => finish([]));
  expect(dispatch).toHaveBeenCalledTimes(1);
});
// An ejected card's folder answers with an error now, not an empty
// listing, and the watcher must leave the branch as it was: the empty
// answer collapsed it to a leaf, expanded state and all.
it("a folder that is not there leaves the tree alone", async () => {
  vi.useFakeTimers();
  vi.mocked(listSubfolders).mockRejectedValue(new Error("/Volumes/Card/DCIM is not there"));
  const ref = { current: { ...initialState(), activeFolderPath: "/Volumes/Card/DCIM", activeCollection: null } };
  const dispatch = vi.fn();
  renderHook(() => useFolderWatcher(ref, dispatch));
  await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
  expect(listSubfolders).toHaveBeenCalledTimes(1);
  expect(dispatch).not.toHaveBeenCalled();
});
