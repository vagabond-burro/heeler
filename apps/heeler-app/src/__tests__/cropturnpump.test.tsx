// A turn of the crop's ring asks the engine for nothing until it ends
// ("In the crop tool, the canvas is very laggy when rotating"): each new
// angle missed every cache downstream of the crop, so each frame was a
// whole render behind the pointer. The viewer turns the frame on screen
// meanwhile (cropTurnFrom); the release renders once. A drag of the
// crop's box still renders as it goes.
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cropNode, type Command, type State } from "../state";

const test = vi.hoisted(() => ({
  desktop: false,
  preview: vi.fn(),
  state: null as State | null,
  dispatch: null as ((c: Command) => void) | null,
}));
vi.mock("../bridge", async (original) => ({
  ...await original<typeof import("../bridge")>(),
  isTauri: () => test.desktop,
  renderPreview: (s: State, opts: unknown) => test.preview(s, opts),
}));
vi.mock("../ui/viewer", () => ({ Viewer: (p: any) => {
  test.state = p.state; test.dispatch = p.dispatch;
  return null;
} }));
import { App } from "../app";

const send = async (c: Command) => { await act(async () => { test.dispatch!(c); }); };
const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

beforeEach(() => {
  vi.useFakeTimers();
  test.preview.mockReset().mockResolvedValue({ url: "frame", ms: 1 });
  vi.stubGlobal("Image", class { src = ""; decode() { return Promise.resolve(); } });
});
afterEach(() => { test.desktop = false; cleanup(); vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it("renders nothing while the ring turns, then once on release", async () => {
  render(<App />);
  test.desktop = true;
  await send({ type: "set_prefs", prefs: { settledPreview: "screen" } });
  await send({ type: "set_tool", tool: "crop" });
  await advance(1000);
  const id = cropNode(test.state!).id;
  test.preview.mockClear();
  await send({ type: "begin_gesture", key: `${id}.batch`, cropTurnFrom: 0 });
  for (let i = 1; i <= 8; i++) {
    await send({ type: "set_params", id, values: { angle: i } });
    await advance(50);
  }
  await advance(1000);
  expect(test.preview).not.toHaveBeenCalled();
  await send({ type: "end_gesture" });
  await advance(1000);
  expect(test.preview).toHaveBeenCalled();
  const sent = test.preview.mock.calls[test.preview.mock.calls.length - 1][0] as State;
  expect(cropNode(sent).params.angle).toBe(8);
});

it("still renders a drag of the crop's box as it goes", async () => {
  render(<App />);
  test.desktop = true;
  await send({ type: "set_prefs", prefs: { settledPreview: "screen" } });
  await send({ type: "set_tool", tool: "crop" });
  await advance(1000);
  const id = cropNode(test.state!).id;
  test.preview.mockClear();
  await send({ type: "begin_gesture", key: `${id}.batch` });
  await send({ type: "set_params", id, values: { crop_w: 0.8 } });
  await advance(1000);
  expect(test.preview).toHaveBeenCalled();
  await send({ type: "end_gesture" });
});
