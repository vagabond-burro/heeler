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

it("reads the normals once and pokes a render", async () => {
  vi.mocked(bridge.surfaceNormals).mockResolvedValue({ version: "v", work: "model" });
  const got: Command[] = [];
  const s = withModel("model");
  const view = render(<NormalsRunner state={s} dispatch={(c) => got.push(c)} />);
  await waitFor(() => expect(got).toContainEqual({ type: "poke_render" }));
  view.rerender(<NormalsRunner state={{ ...s }} dispatch={(c) => got.push(c)} />);
  expect(bridge.surfaceNormals).toHaveBeenCalledTimes(1);
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
