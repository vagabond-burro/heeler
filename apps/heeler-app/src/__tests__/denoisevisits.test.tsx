import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { initialState } from "../data";
import { MODEL_DENOISE_ID } from "../state";
import { denoiseMark, denoiseStatusNow, requestFullDenoise, DenoiseRunner } from "../ui/denoisetool";
import * as bridge from "../bridge";
import { DenoiseMethodRow } from "../ui/simple";
import * as statusbar from "../ui/statusbar";

afterEach(() => vi.restoreAllMocks());
it("a remounted viewer checks its cached preview without announcing inference", async () => {
  const s = initialState();
  const state = { ...s, activeImage: "diagnostic", nodes: [...s.nodes, { ...s.nodes[0], id: MODEL_DENOISE_ID,
    type: "heeler.model_denoise", enabled: true, params: { method: 1 } }] };
  const map = vi.spyOn(bridge, "denoiseMap").mockResolvedValue({ version: "same-version", work: "cached", tiles: 0, width: 64, height: 32 });
  const busy = vi.spyOn(statusbar, "publishBusy");
  const first = render(<DenoiseRunner state={state} dispatch={vi.fn()} />);
  await waitFor(() => expect(map).toHaveBeenCalledTimes(1));
  await act(async () => {});
  first.unmount();
  render(<DenoiseRunner state={state} dispatch={vi.fn()} />);
  await waitFor(() => expect(map).toHaveBeenCalledTimes(2));
  await act(async () => {});
  console.info("RESTORED requested edges", map.mock.calls.map((c) => c[1]), "status", busy.mock.calls.map((c) => c[0]));
  expect(map.mock.calls.map((c) => c[1])).toEqual([state.prefs.previewEdge, state.prefs.previewEdge]);
  expect(busy.mock.calls.filter((c) => c[0]?.includes("running the model"))).toHaveLength(0);
});


function modelState(id: string) {
  const s = initialState();
  return { ...s, activeImage: id, nodes: [...s.nodes, { ...s.nodes[0], id: MODEL_DENOISE_ID,
    type: "heeler.model_denoise", enabled: true, params: { method: 1 } }] };
}

it("the section trusts the desktop after remount rather than either value in session memory", async () => {
  const state = modelState("disk-status");
  const query = vi.spyOn(bridge, "denoiseFullStatus").mockResolvedValue({ full: true, version: "stored", width: 6000, height: 4000 });
  const mark = denoiseMark(state);
  denoiseStatusNow().ready[mark] = { preview: true, full: false };
  const view = render(<DenoiseMethodRow state={state} dispatch={vi.fn()} />);
  expect(await screen.findByText(/full size ready on disk/)).toBeInTheDocument();
  expect(screen.queryByTestId("nr-model-full")).toBeNull();
  view.unmount();
  denoiseStatusNow().ready[mark] = { preview: true, full: true, work: "cached" };
  query.mockResolvedValue({ full: false, width: 0, height: 0 });
  render(<DenoiseMethodRow state={state} dispatch={vi.fn()} />);
  expect(await screen.findByTestId("nr-model-full")).toBeInTheDocument();
  expect(screen.getByTestId("nr-model-status")).toHaveTextContent("preview loaded from disk");
  expect(query).toHaveBeenCalledTimes(2);
});

it("a full answer on disk skips preview inference after a remount and a stale full-size click", async () => {
  const state = modelState("durable-full");
  vi.spyOn(bridge, "denoiseFullStatus").mockResolvedValue({ full: true, version: "stored", width: 6000, height: 4000 });
  const map = vi.spyOn(bridge, "denoiseMap");
  const dispatch = vi.fn();
  let view = render(<DenoiseRunner state={state} dispatch={dispatch} />);
  await waitFor(() => expect(dispatch).toHaveBeenCalledWith({ type: "poke_render" }));
  view.unmount();
  dispatch.mockClear();
  view = render(<DenoiseRunner state={state} dispatch={dispatch} />);
  await waitFor(() => expect(dispatch).toHaveBeenCalledWith({ type: "poke_render" }));
  await act(async () => { await requestFullDenoise(state, dispatch); });
  expect(map).not.toHaveBeenCalled();
  view.unmount();
});


it("the mounted section rechecks disk when Storage clears the rasters", async () => {
  const listeners: ((cleared: boolean) => void)[] = [];
  vi.spyOn(bridge, "onDenoiseCacheChanged").mockImplementation((fn) => { listeners.push(fn); return () => {}; });
  const query = vi.spyOn(bridge, "denoiseFullStatus").mockResolvedValue({ full: true, width: 6000, height: 4000 });
  const state = modelState("clear-status");
  denoiseStatusNow().ready[denoiseMark(state)] = { preview: true, full: true };
  render(<DenoiseMethodRow state={state} dispatch={vi.fn()} />);
  expect(await screen.findByText(/full size ready on disk/)).toBeInTheDocument();
  query.mockResolvedValue({ full: false, width: 6000, height: 4000 });
  await act(async () => { listeners.forEach((fn) => fn(true)); });
  expect(await screen.findByTestId("nr-model-full")).toBeInTheDocument();
  expect(query).toHaveBeenCalledTimes(2);
});

it("a failed cache check still runs the model rather than doing nothing", async () => {
  // The check is a shortcut, not a gate: when it errors the runner must
  // fall through to the real request, which is what reports the problem
  // or asks for the model. Gating on its answer made a failed check a
  // silent refusal to compute anything at all.
  const s = initialState();
  const state = { ...s, activeImage: "diagnostic", nodes: [...s.nodes, { ...s.nodes[0], id: MODEL_DENOISE_ID,
    type: "heeler.model_denoise", enabled: true, params: { method: 1 } }] };
  vi.spyOn(bridge, "denoiseFullStatus").mockRejectedValue(new Error("no model store"));
  const map = vi.spyOn(bridge, "denoiseMap").mockResolvedValue({ version: "v", work: "model", tiles: 4, width: 64, height: 32 });
  render(<DenoiseRunner state={state} dispatch={vi.fn()} />);
  await waitFor(() => expect(map).toHaveBeenCalledTimes(1));
});
