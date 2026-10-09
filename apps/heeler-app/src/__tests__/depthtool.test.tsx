// The depth tools' frontend half: the runner that computes the
// farness plane the first time Fog, Key Light, or Depth of Field says
// something, and the consent card when the model is not installed.
// The model's own behavior is pinned by heeler-vision's gated test.

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { initialState } from "../data";
import { reduce, type Command, type State } from "../state";
import { DepthRunner, depthWanted } from "../ui/depthtool";

vi.mock("../bridge", async (importOriginal) => {
  const real = await importOriginal<typeof import("../bridge")>();
  return {
    ...real,
    depthMap: vi.fn(async () => {
      if (!mockInstalled) throw new Error("model not installed");
      return { version: "feedfacefeedface", work: "model" as const };
    }),
    smartModelDownload: vi.fn(async () => {}),
    smartModelStatus: vi.fn(async () => ({
      sam: { id: "mobile_sam", installed: true, label: "SAM", license: "Apache-2.0", url: "u", bytes: 1 },
      matte: { id: "birefnet_lite", installed: true, label: "BiRefNet", license: "MIT", url: "u", bytes: 1 },
      fill: { id: "lama", installed: true, label: "LaMa", license: "Apache-2.0", url: "u", bytes: 1 },
      refine: { id: "vitmatte", installed: true, label: "ViTMatte", license: "Apache-2.0", url: "u", bytes: 1 },
      depth: {
        id: "depth_anything_v2_small",
        installed: mockInstalled,
        label: "Depth Anything V2 Small (scene depth)",
        license: "Apache-2.0 (code and weights)",
        url: "https://example.test/depth.onnx",
        bytes: 99_060_839,
      },
    })),
  };
});
let mockInstalled = true;

const run = (s: State, ...cmds: Command[]) => cmds.reduce(reduce, s);

beforeEach(() => {
  mockInstalled = true;
  vi.clearAllMocks();
});

describe("the depth runner", () => {
  const withFog = () =>
    run(initialState(), { type: "set_param", id: "fog", param: "density", value: 40 });

  it("neutral tools want no depth; a moved dial wants it", () => {
    expect(depthWanted(initialState())).toBe(false);
    expect(depthWanted(withFog())).toBe(true);
    expect(
      depthWanted(run(initialState(), { type: "set_param", id: "keylight", param: "strength", value: 30 })),
    ).toBe(true);
    expect(
      depthWanted(run(initialState(), { type: "set_param", id: "dof", param: "aperture", value: 30 })),
    ).toBe(true);
  });

  it("computes once and pokes a render so the planted raster shows", async () => {
    const s = withFog();
    const got: Command[] = [];
    render(<DepthRunner state={s} dispatch={(c) => got.push(c)} />);
    const { depthMap } = await import("../bridge");
    await waitFor(() => expect(vi.mocked(depthMap)).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(got).toContainEqual({ type: "poke_render" }));
  });

  it("asks consent before any download, naming the model and its terms", async () => {
    mockInstalled = false;
    const s = withFog();
    render(<DepthRunner state={s} dispatch={() => {}} />);
    const card = await screen.findByTestId("depth-consent");
    expect(card.textContent).toContain("Depth Anything V2 Small");
    expect(card.textContent).toContain("Apache-2.0");
    expect(card.textContent).toContain("99 MB");
    const { smartModelDownload } = await import("../bridge");
    fireEvent.click(screen.getByTestId("depth-download"));
    await waitFor(() =>
      expect(vi.mocked(smartModelDownload)).toHaveBeenCalledWith("depth_anything_v2_small"),
    );
  });

  it("the View depth eye is itself a request for depth", () => {
    // The owner reset the photograph (dials neutral), clicked the eye,
    // and the render retried five times against a plane nobody had asked
    // to compute. The eye asks now.
    expect(depthWanted(initialState())).toBe(false);
    expect(depthWanted(run(initialState(), { type: "toggle_depth_view" }))).toBe(true);
  });

  it("arming Set focus is a request for depth too", () => {
    // The fix, pinned: the focus picker reads the plane, so arming it
    // must compute one - without this, every click on a fresh photo
    // failed with "move a depth dial first".
    expect(depthWanted(run(initialState(), { type: "toggle_dof_pick" }))).toBe(true);
  });

  it("a depth-range selection region wants depth too", () => {
    let s = run(initialState(), { type: "add_layer", maskType: "selection" });
    const maskId = s.activeLayer!.replace("_adj", "_mask");
    expect(depthWanted(s)).toBe(false);
    s = run(s, {
      type: "add_region",
      id: maskId,
      region: { kind: "range", op: "replace", channel: "depth", lo: 0.5, hi: 1, soft: 0.08 },
    });
    expect(depthWanted(s)).toBe(true);
  });

  it("Select > Depth Range opens as a real region on the selection", async () => {
    const { runCommand } = await import("../commands");
    let s = run(initialState(), { type: "add_layer", maskType: "selection" });
    const maskId = s.activeLayer!.replace("_adj", "_mask");
    const got: Command[] = [];
    expect(runCommand("select.range.depth", s, (c) => got.push(c))).toBe(true);
    const add = got.find((c) => c.type === "add_region") as Extract<Command, { type: "add_region" }>;
    expect(add.id).toBe(maskId);
    expect((add.region as { channel?: string }).channel).toBe("depth");
    const dlg = got.find((c) => c.type === "open_select_dialog") as Extract<
      Command,
      { type: "open_select_dialog" }
    >;
    expect(dlg.dialog.mode).toBe("depth");
  });

  it("a disabled or neutral tool never wakes the model", async () => {
    const s = run(withFog(), { type: "set_enabled", id: "fog", enabled: false });
    render(<DepthRunner state={s} dispatch={() => {}} />);
    const { depthMap } = await import("../bridge");
    await new Promise((r) => setTimeout(r, 30));
    expect(vi.mocked(depthMap)).not.toHaveBeenCalled();
  });
});
