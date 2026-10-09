// A Smart Mask added in the Graph. 2026-10-01: "Is smart mask working
// correctly? I don't see it generating a mask. Also, I don't see an
// invert option." His node wore the generic face: Mode "Sky (one shot)",
// Threshold, Feather. Choosing Sky there wrote the mode and ran nothing,
// so no raster existed for the recipe and the mask rendered black;
// Invert, Expand and the Depth block had no seat. The face is now
// Develop's Smart controls aimed at the node, with Detect, the viewer
// pick and the missing-model words.

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { initialState } from "../data";
import { makeNode, specFor } from "../nodes";
import { reduce, type Command, type NodeCard, type State } from "../state";
import { Inspector, NodeEditor } from "../ui/graph";
import { activeSmartMask } from "../ui/smarttool";
import { smartCardNote, smartModelMissing } from "../ui/smartnode";
import * as bridge from "../bridge";

let samInstalled = true;
let matteInstalled = false;
let cached = false;
const model = (id: string, installed: boolean) => ({ id, installed, label: id, license: "MIT", url: "https://example.test/m", bytes: 1, version: "1" });

vi.mock("../bridge", async (importOriginal) => {
  const real = await importOriginal<typeof import("../bridge")>();
  return {
    ...real,
    smartModelStatus: vi.fn(async () => ({
      sam: model("mobile_sam", samInstalled),
      matte: model("birefnet_lite", matteInstalled),
      fill: model("lama", true),
      refine: model("vitmatte", true),
      depth: model("depth_anything_v2_small", true),
      denoise: model("scunet_color_real_psnr", true),
      florence: model("florence_2_base", true),
    })),
    smartRasterStatus: vi.fn(async () => cached),
    smartClick: vi.fn(async () => "mobile_sam"),
  };
});

beforeEach(() => {
  samInstalled = true;
  matteInstalled = false;
  cached = false;
  vi.clearAllMocks();
});

/** The Graph with a Smart Mask added from the palette, selected, its
 * mode set as the old Mode menu set it: what the owner had.*/
function graphWithSmart(text: Record<string, string> = {}): { s: State; node: NodeCard } {
  const card = makeNode(specFor("heeler.smart_mask")!, "smart_mask_t1", 0, 0);
  const node: NodeCard = { ...card, textParams: { ...(card.textParams ?? {}), ...text } };
  const base = { ...initialState(), mode: "advanced" as const };
  const s = reduce(base, { type: "add_node", node });
  const added = s.nodes.find((n) => n.type === "heeler.smart_mask")!;
  return { s: { ...s, selection: [added.id] }, node: added };
}

function inspect(s: State) {
  const got: Command[] = [];
  const utils = render(<Inspector state={s} dispatch={(c) => got.push(c)} frame={null} />);
  return { got, ...utils };
}

describe("a Smart Mask node's face", () => {
  it("seats every control Develop's Smart layer has: the modes, the dials, Invert and the Depth mask", async () => {
    const { s, node } = graphWithSmart();
    inspect(s);
    await screen.findByTestId("smart-node-status");
    expect(screen.getByTestId("smart-node-face")).toBeTruthy();
    for (const id of ["click", "subject", "sky"]) expect(screen.getByTestId(`smart-mode-${id}`)).toBeTruthy();
    for (const p of ["threshold", "expand", "feather"]) {
      expect(document.querySelector(`[data-node="${node.id}"][data-param="${p}"]`), p).toBeTruthy();
    }
    expect(screen.getByTestId("smart-node-invert")).toBeTruthy();
    expect(screen.getByTestId("smart-node-depth-toggle")).toBeTruthy();
    // The old Mode menu, which wrote a mode and ran nothing, is gone.
    expect(screen.queryByTestId("node-option-mode")).toBeNull();
  });

  it("Invert writes the node's invert flag", async () => {
    const { s, node } = graphWithSmart();
    const { got } = inspect(s);
    fireEvent.click(screen.getByTestId("smart-node-invert"));
    expect(got).toContainEqual({ type: "set_param", id: node.id, param: "invert", value: 1 });
    await screen.findByTestId("smart-node-status");
  });

  it("Sky with no raster says so and Detect runs the model on this node and signs the model", async () => {
    const { s, node } = graphWithSmart({ mode: "sky" });
    const { got } = inspect(s);
    const status = await screen.findByTestId("smart-node-status");
    await waitFor(() => expect(status).toHaveAttribute("data-state", "not-detected"));
    fireEvent.click(screen.getByTestId("smart-node-detect"));
    await waitFor(() => expect(got).toContainEqual({ type: "set_text_param", id: node.id, param: "model", value: "mobile_sam" }));
    expect(bridge.smartClick).toHaveBeenCalledWith(s.activeImage, node.id, "[]", "sky");
  });

  it("a computed Sky reads as detected", async () => {
    cached = true;
    const { s } = graphWithSmart({ mode: "sky", model: "mobile_sam" });
    inspect(s);
    const status = await screen.findByTestId("smart-node-status");
    await waitFor(() => expect(status).toHaveAttribute("data-state", "detected"));
  });

  it("the face's Sky button computes for this node, not for a Develop layer underneath", async () => {
    // A Develop Smart layer active underneath: the face still aims here.
    const dev = reduce(initialState(), { type: "add_layer", maskType: "smart" });
    const card = makeNode(specFor("heeler.smart_mask")!, "smart_mask_t2", 0, 0);
    const withNode = reduce({ ...dev, mode: "advanced" }, { type: "add_node", node: card });
    const node = withNode.nodes.find((n) => n.id !== dev.activeLayer!.replace("_adj", "_mask") && n.type === "heeler.smart_mask")!;
    const s = { ...withNode, selection: [node.id] };
    const { got } = inspect(s);
    await screen.findByTestId("smart-node-status");
    await act(async () => {
      fireEvent.click(screen.getByTestId("smart-mode-sky"));
    });
    expect(got).toContainEqual({ type: "set_text_param", id: node.id, param: "mode", value: "sky" });
    await waitFor(() => expect(bridge.smartClick).toHaveBeenCalledWith(s.activeImage, node.id, "[]", "sky"));
  });

  it("Click mode offers the viewer pick, aimed at this node", async () => {
    const { s, node } = graphWithSmart();
    const { got } = inspect(s);
    const status = await screen.findByTestId("smart-node-status");
    expect(status).toHaveAttribute("data-state", "no-clicks");
    fireEvent.click(screen.getByTestId("smart-node-pick"));
    expect(got).toEqual([
      { type: "select_nodes", ids: [node.id] },
      { type: "set_tool", tool: "smart" },
    ]);
    // In the Graph the selected Smart Mask is the one in hand, even with
    // a Develop Smart layer active underneath.
    const dev = reduce(initialState(), { type: "add_layer", maskType: "smart" });
    const both = { ...dev, mode: "advanced" as const, nodes: [...dev.nodes, node], selection: [node.id] };
    expect(activeSmartMask(both)?.id).toBe(node.id);
    // In Develop the active layer's still wins.
    expect(activeSmartMask({ ...both, mode: "simple" })?.id).toBe(dev.activeLayer!.replace("_adj", "_mask"));
  });

  it("without the model the face says so plainly and points at Preferences > Models", async () => {
    samInstalled = false;
    const { s } = graphWithSmart({ mode: "sky" });
    const { got } = inspect(s);
    const missing = await screen.findByTestId("smart-node-missing");
    expect(missing.textContent).toContain("Preferences > Models");
    expect(screen.queryByTestId("smart-node-detect")).toBeNull();
    fireEvent.click(screen.getByTestId("smart-node-get-model"));
    expect(got).toContainEqual({ type: "open_prefs", landing: "model-inventory" });
  });
});

describe("a Smart Mask card", () => {
  const card = (text: Record<string, string>): NodeCard => {
    const c = makeNode(specFor("heeler.smart_mask")!, "sm", 0, 0);
    return { ...c, textParams: { ...(c.textParams ?? {}), ...text } };
  };
  const models = (sam: boolean, matte: boolean) =>
    ({ sam: model("mobile_sam", sam), matte: model("birefnet_lite", matte) }) as unknown as Parameters<typeof smartCardNote>[1];

  it("says why its mask is empty", () => {
    expect(smartCardNote(card({ mode: "sky" }), models(true, false))).toBe("Not detected yet: Detect in the Inspector");
    expect(smartCardNote(card({ mode: "sky", model: "mobile_sam" }), models(true, false))).toBe("");
    expect(smartCardNote(card({ mode: "click" }), models(true, false))).toBe("No clicks yet: mask empty");
    expect(smartCardNote(card({ mode: "sky" }), models(false, false))).toBe("Model not installed: mask empty");
    // Subject runs on the matte model alone when SAM is missing.
    expect(smartModelMissing(models(false, true), "subject")).toBe(false);
    expect(smartModelMissing(models(false, true), "sky")).toBe(true);
    // Not known yet is not missing.
    expect(smartModelMissing(null, "sky")).toBe(false);
  });

  it("wears the note on the canvas", async () => {
    const { s, node } = graphWithSmart({ mode: "sky" });
    render(<NodeEditor state={s} dispatch={() => {}} />);
    await waitFor(() => expect(screen.getByTestId(`smart-note-${node.id}`).textContent).toBe("Not detected yet: Detect in the Inspector"));
  });
});

it("does not sign a different photograph when Detect finishes late", async () => {
  let finish!: (model: string) => void;
  vi.mocked(bridge.smartClick).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const { s } = graphWithSmart({ mode: "sky" });
  const got: Command[] = [];
  const r = render(<Inspector state={s} dispatch={(c) => got.push(c)} frame={null} />);
  await screen.findByTestId("smart-node-status");
  fireEvent.click(screen.getByTestId("smart-node-detect"));
  r.rerender(<Inspector state={{ ...s, activeImage: "review-other-photo" }} dispatch={(c) => got.push(c)} frame={null} />);
  await act(async () => finish("mobile_sam"));
  expect(got.filter((c) => c.type === "set_text_param" && c.param === "model")).toEqual([]);
});
