// Develop layer identity at the App, pinned before the 26.4.2 refactor:
// with Polish open on a selection layer, the App renders that layer's
// own mask for the polish matte. A mutation pass found no test noticed
// this site breaking.

import { act, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Command, State } from "../state";

const test = vi.hoisted(() => ({
  renderMask: vi.fn(),
  state: null as State | null,
  dispatch: null as ((c: Command) => void) | null,
}));
vi.mock("../bridge", async (original) => ({
  ...await original<typeof import("../bridge")>(),
  renderMaskOf: (...args: unknown[]) => {
    test.renderMask(...args);
    return Promise.resolve(null);
  },
}));
vi.mock("../ui/viewer", () => ({ Viewer: (p: { state: State; dispatch: (c: Command) => void }) => {
  test.state = p.state;
  test.dispatch = p.dispatch;
  return null;
} }));
import { App } from "../app";

afterEach(() => test.renderMask.mockClear());

const send = async (c: Command) => { await act(async () => { test.dispatch!(c); }); };

it("renders the active selection layer's own mask for the polish matte", async () => {
  render(<App />);
  await send({ type: "add_layer", maskType: "range" });
  await send({ type: "add_layer", maskType: "selection" });
  expect(test.state!.activeLayer).toBe("layer_2_adj");
  test.renderMask.mockClear();
  await send({ type: "set_polish_open", open: true });
  expect(test.renderMask).toHaveBeenCalled();
  expect(test.renderMask.mock.calls.every((c) => c[1] === "layer_2_mask")).toBe(true);
});

it("renders no polish matte for a layer whose mask is not a selection", async () => {
  render(<App />);
  await send({ type: "add_layer", maskType: "range" });
  test.renderMask.mockClear();
  await send({ type: "set_polish_open", open: true });
  expect(test.renderMask).not.toHaveBeenCalled();
});
