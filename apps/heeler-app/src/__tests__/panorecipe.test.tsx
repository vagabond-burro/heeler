import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { initialState } from "../data";
import { reduce, type State } from "../state";

const info = { surface: "cylindrical", gain_compensation: true, straighten: true, bands: 4, members: ["a.jpg", "b.jpg"], missing: [] };
const backend = vi.hoisted(() => ({ update: vi.fn() }));
vi.mock("../bridge", async (original) => ({
  ...await original<typeof import("../bridge")>(),
  panoInfo: vi.fn(async () => info),
  updatePano: backend.update,
}));
import { PanoPanel } from "../ui/simple";
import { handleApiAsync } from "../api";

function canceled(): State {
  let s = { ...initialState(), activeImage: "pan" };
  s = reduce(s, { type: "set_stitch_canceled", image: "pan", on: true });
  s = reduce(s, { type: "set_stitch_canceled", image: "other", on: true });
  return reduce(s, { type: "set_stitch_progress", progress: { image: "pan", fraction: 1, stage: "Canceled", error: null, canceled: true } });
}
beforeEach(() => { backend.update.mockReset().mockResolvedValue(info); });

it.each(["pano-surface-spherical", "pano-gain", "pano-straighten"])("a successful %s change resumes the new recipe", async (control) => {
  let s = canceled();
  const nonce = s.previewNonce;
  render(<PanoPanel state={s} dispatch={(c) => { s = reduce(s, c); }} />);
  fireEvent.click(await screen.findByTestId(control));
  await waitFor(() => expect(backend.update).toHaveBeenCalled());
  await waitFor(() => expect(s.stitchCanceled).toEqual({ other: true }));
  expect(s.stitch).toBeNull();
  expect(s.previewNonce).toBe(nonce + 1);
});

it.each([{ members: ["a.jpg", "c.jpg"] }, { bands: 2 }, { surface: "planar" }])("scripting resumes a changed panorama recipe %j", async (change) => {
  let s = canceled();
  const nonce = s.previewNonce;
  const answer = await handleApiAsync(s, (c) => { s = reduce(s, c); }, "pano.configure", { id: "pan", ...change });
  expect(answer).toEqual({ data: info });
  expect(s.stitchCanceled).toEqual({ other: true });
  expect(s.previewNonce).toBe(nonce + 1);
});

it("a refused recipe change leaves the panorama canceled", async () => {
  backend.update.mockRejectedValue(new Error("recipe was not written"));
  let s = canceled();
  const old = s;
  render(<PanoPanel state={s} dispatch={(c) => { s = reduce(s, c); }} />);
  fireEvent.click(await screen.findByTestId("pano-straighten"));
  await waitFor(() => expect(backend.update).toHaveBeenCalled());
  expect(s).toBe(old);
});
