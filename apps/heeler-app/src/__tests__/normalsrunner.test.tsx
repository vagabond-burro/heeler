// Depth Lighting's Model normals: read once per photograph when an
// enabled Depth Lighting asks for them, a render poke after, and the
// consent card when the model is not installed.

import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { initialState } from "../data";
import { reduce, type Command, type State } from "../state";
import { NormalsRunner } from "../ui/depthtool";
import * as bridge from "../bridge";

vi.mock("../bridge", async (importOriginal) => {
  const real = await importOriginal<typeof import("../bridge")>();
  return { ...real, surfaceNormals: vi.fn(), smartModelStatus: vi.fn(real.smartModelStatus) };
});

const withModel = (normals: string): State => {
  let s = reduce(initialState(), { type: "set_param", id: "keylight", param: "strength", value: 50 });
  s = reduce(s, { type: "set_text_param", id: "keylight", param: "normals", value: normals });
  return { ...s, nodes: s.nodes.map((n) => (n.id === "keylight" ? { ...n, enabled: true } : n)) };
};

beforeEach(() => vi.clearAllMocks());

it("reads the normals once per source and develop and pokes a render", async () => {
  vi.mocked(bridge.surfaceNormals).mockResolvedValue({ version: "v", work: "model" });
  const got: Command[] = [];
  const s = withModel("model");
  const view = render(<NormalsRunner state={s} dispatch={(c) => got.push(c)} />);
  await waitFor(() => expect(got).toContainEqual({ type: "poke_render" }));
  const settled = reduce(s, { type: "poke_render" });
  view.rerender(<NormalsRunner state={settled} dispatch={(c) => got.push(c)} />);
  expect(bridge.surfaceNormals).toHaveBeenCalledTimes(1);
  view.rerender(<NormalsRunner state={{ ...settled }} dispatch={(c) => got.push(c)} />);
  expect(bridge.surfaceNormals).toHaveBeenCalledTimes(1);
  const changed = reduce(settled, { type: "set_param", id: "src", param: "camera_wb", value: 0 });
  view.rerender(<NormalsRunner state={changed} dispatch={(c) => got.push(c)} />);
  await waitFor(() => expect(bridge.surfaceNormals).toHaveBeenCalledTimes(2));
  expect(bridge.surfaceNormals).toHaveBeenLastCalledWith(changed);
  const changedSettled = reduce(changed, { type: "poke_render" });
  view.rerender(<NormalsRunner state={changedSettled} dispatch={(c) => got.push(c)} />);
  expect(bridge.surfaceNormals).toHaveBeenCalledTimes(2);
  const rewritten = reduce(changedSettled, { type: "resume_stack_merge", image: changedSettled.activeImage });
  view.rerender(<NormalsRunner state={rewritten} dispatch={(c) => got.push(c)} />);
  await waitFor(() => expect(bridge.surfaceNormals).toHaveBeenCalledTimes(3));
  expect(bridge.surfaceNormals).toHaveBeenLastCalledWith(rewritten);
});

it("asks nothing when no Depth Lighting wants the model", () => {
  render(<NormalsRunner state={withModel("auto")} dispatch={() => {}} />);
  expect(bridge.surfaceNormals).not.toHaveBeenCalled();
});

it("asks for consent when the model is not installed", async () => {
  vi.mocked(bridge.surfaceNormals).mockRejectedValue("model not installed");
  render(<NormalsRunner state={withModel("model")} dispatch={() => {}} />);
  await waitFor(() => expect(screen.getByTestId("normals-consent")).toBeInTheDocument());
  expect(screen.getByTestId("normals-consent").textContent).toContain("MoGe-2");
});

it("a cached answer pokes no render: the raster is already what the render plants", async () => {
  // A preview refresh from elsewhere asks again (the nonce is in the
  // mark); its cached answer must not draw the frame a second time.
  vi.mocked(bridge.surfaceNormals).mockResolvedValue({ version: "v", work: "cached" });
  const got: Command[] = [];
  const s = withModel("model");
  const view = render(<NormalsRunner state={s} dispatch={(c) => got.push(c)} />);
  await waitFor(() => expect(bridge.surfaceNormals).toHaveBeenCalledTimes(1));
  const refreshed = reduce(s, { type: "poke_render" });
  view.rerender(<NormalsRunner state={refreshed} dispatch={(c) => got.push(c)} />);
  await waitFor(() => expect(bridge.surfaceNormals).toHaveBeenCalledTimes(2));
  expect(got.filter((c) => c.type === "poke_render")).toHaveLength(0);
});
