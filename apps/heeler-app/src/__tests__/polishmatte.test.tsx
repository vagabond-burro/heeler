// P4's frontend half: the Smart matte button in the polish toolbar.
// The model's quality is pinned by the vision crate's gated
// hair-strand test; what this file pins is the contract around it:
// the recipe write, the toggle, the staleness honesty, and the
// consent card.

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { initialState } from "../data";
import { reduce, type Command, type State } from "../state";
import { PolishMatteButton, PolishMatteRunner } from "../ui/polish";

vi.mock("../bridge", async (importOriginal) => {
  const real = await importOriginal<typeof import("../bridge")>();
  return {
    ...real,
    polishMatte: vi.fn(async () => {
      if (!mockInstalled) throw new Error("model not installed");
      return "cafebabe00000000";
    }),
    smartRasterStatus: vi.fn(async () => mockCached),
    smartModelDownload: vi.fn(async () => {}),
    smartModelStatus: vi.fn(async () => ({
      sam: { id: "mobile_sam", installed: true, label: "SAM", license: "Apache-2.0", url: "u", bytes: 1 },
      matte: { id: "birefnet_lite", installed: true, label: "BiRefNet", license: "MIT", url: "u", bytes: 1 },
      fill: { id: "lama", installed: true, label: "LaMa", license: "Apache-2.0", url: "u", bytes: 1 },
      refine: {
        id: "vitmatte",
        installed: mockInstalled,
        label: "ViTMatte (edge refinement)",
        license: "Apache-2.0 weights, MIT code",
        url: "https://example.test/vitmatte.onnx",
        bytes: 103_885_865,
      },
    })),
  };
});
let mockInstalled = true;
let mockCached = true;

const run = (s: State, ...cmds: Command[]) => cmds.reduce(reduce, s);

beforeEach(() => {
  mockInstalled = true;
  mockCached = true;
  vi.clearAllMocks();
});

function withSelection() {
  let s = run(initialState(), { type: "add_layer", maskType: "selection" });
  const maskId = s.activeLayer!.replace("_adj", "_mask");
  s = run(s, {
    type: "add_region",
    id: maskId,
    region: {
      kind: "path",
      op: "replace",
      points: [
        [0.2, 0.2],
        [0.8, 0.2],
        [0.8, 0.8],
        [0.2, 0.8],
      ],
    },
  });
  return { s, maskId };
}

describe("the Smart matte button", () => {
  it("runs the matte and writes the recipe pointer onto the node", async () => {
    const { s, maskId } = withSelection();
    const got: Command[] = [];
    render(<PolishMatteButton state={s} dispatch={(c) => got.push(c)} />);
    fireEvent.click(screen.getByTestId("art-polish-matte"));
    await waitFor(() => {
      const write = got.find((c) => c.type === "set_text_param");
      expect(write).toBeTruthy();
    });
    const write = got.find((c) => c.type === "set_text_param") as Extract<
      Command,
      { type: "set_text_param" }
    >;
    expect(write.id).toBe(maskId);
    expect(write.param).toBe("matte_id");
    expect(write.value).toBe("cafebabe00000000");
    const { polishMatte } = await import("../bridge");
    expect(vi.mocked(polishMatte).mock.calls[0][1]).toBe(maskId);
  });

  it("is an action, not a toggle: a matte on the node just re-runs", async () => {
    // "since Smart Matte will always turn on why not turn it
    // on transparently and why have it as a button?" The button's one job
    // is the whole-edge refine a stroke cannot trigger; pressing it with a
    // matte already on recomputes rather than turning anything off (undo
    // is how a matte comes off).
    const { s, maskId } = withSelection();
    const on = run(s, {
      type: "set_text_param",
      id: maskId,
      param: "matte_id",
      value: "cafebabe00000000",
    });
    const got: Command[] = [];
    render(<PolishMatteButton state={on} dispatch={(c) => got.push(c)} />);
    const chip = screen.getByTestId("art-polish-matte");
    expect(chip.getAttribute("data-active")).toBeNull();
    expect(chip.getAttribute("data-stale")).toBeNull();
    fireEvent.click(chip);
    const { polishMatte } = await import("../bridge");
    await waitFor(() => expect(vi.mocked(polishMatte)).toHaveBeenCalled());
    // And nothing was cleared: the press only ever computes.
    expect(got.every((c) => c.type !== "set_text_param" || (c as { value: string }).value !== "")).toBe(true);
  });

  it("a matte stroke re-mattes by itself, a beat after the hand stops", async () => {
    // The matte brush's contract: the stroke marks the band, the model
    // resolves it. The engine treats matte strokes as free, so if the
    // runner did not fire, the stroke would do nothing at all.
    const { s, maskId } = withSelection();
    const stroked = run(s, {
      type: "add_polish_stroke",
      id: maskId,
      stroke: { points: [[0.4, 0.4], [0.6, 0.6]], radius: 0.05, mode: "matte" },
    });
    const got: Command[] = [];
    render(<PolishMatteRunner state={stroked} dispatch={(c) => got.push(c)} />);
    const { polishMatte } = await import("../bridge");
    await waitFor(() => expect(vi.mocked(polishMatte)).toHaveBeenCalled(), { timeout: 2000 });
    expect(vi.mocked(polishMatte).mock.calls[0][1]).toBe(maskId);
    await waitFor(() => {
      const write = got.find((c) => c.type === "set_text_param");
      expect(write && (write as { param: string }).param).toBe("matte_id");
    });
  });

  it("a matte stroke on a BAKED selection refines the base instead of standing down", async () => {
    // Item 6, the silent lie retired: painting matte on a converted
    // mask used to land as the Add brush. Now the model refines the
    // baked base and the landing consumes the geometry into a NEW
    // base: pointer moves, matte strokes come off, engine strokes
    // stay, regions clear - one undoable step.
    let { s, maskId } = withSelection();
    s = run(
      s,
      { type: "set_text_param", id: maskId, param: "matte_id", value: "baked:00000000000000aa" },
      {
        type: "add_polish_stroke",
        id: maskId,
        stroke: { points: [[0.5, 0.5], [0.6, 0.5]], radius: 0.05, mode: "matte" },
      },
      {
        type: "add_polish_stroke",
        id: maskId,
        stroke: { points: [[0.2, 0.2]], radius: 0.05, mode: "foreground" },
      },
    );
    const got: Command[] = [];
    render(<PolishMatteRunner state={s} dispatch={(c) => got.push(c)} />);
    await waitFor(() =>
      expect(got).toContainEqual({
        type: "point_matte_at_bake",
        id: maskId,
        version: "cafebabe00000000",
      }),
    );
    // The reducer's landing: new base, matte stroke consumed, the
    // engine's foreground stroke kept, regions cleared, one undo back.
    const before = s;
    s = run(s, { type: "point_matte_at_bake", id: maskId, version: "cafebabe00000000" });
    const node = s.nodes.find((n) => n.id === maskId)!;
    expect(node.textParams?.matte_id).toBe("baked:cafebabe00000000");
    expect(node.regions).toEqual([]);
    const modes = (node.strokes ?? []).map((k) => (k as { mode?: string }).mode);
    expect(modes).toEqual(["foreground"]);
    const undone = run(s, { type: "undo" });
    const back = undone.nodes.find((n) => n.id === maskId)!;
    expect(back.textParams?.matte_id).toBe("baked:00000000000000aa");
    expect((back.regions ?? []).length).toBe(1);
    expect((back.strokes ?? []).length).toBe(2);
    void before;
  });

  it("Add and Remove strokes are the engine's, and wake no model", async () => {
    const { s, maskId } = withSelection();
    const stroked = run(s, {
      type: "add_polish_stroke",
      id: maskId,
      stroke: { points: [[0.4, 0.4], [0.6, 0.6]], radius: 0.05, mode: "foreground" },
    });
    const { container } = render(<PolishMatteRunner state={stroked} dispatch={() => {}} />);
    // No matte strokes: the runner renders nothing and calls nothing.
    expect(container.firstChild).toBeNull();
    await new Promise((r) => setTimeout(r, 600));
    const { polishMatte } = await import("../bridge");
    expect(vi.mocked(polishMatte)).not.toHaveBeenCalled();
  });

  it("asks consent before any download, naming the model and its terms", async () => {
    mockInstalled = false;
    const { s } = withSelection();
    render(<PolishMatteButton state={s} dispatch={() => {}} />);
    fireEvent.click(screen.getByTestId("art-polish-matte"));
    await screen.findByTestId("matte-consent");
    expect(screen.getByTestId("matte-consent").textContent).toContain("ViTMatte");
    expect(screen.getByTestId("matte-consent").textContent).toContain("104 MB");
    const { smartModelDownload } = await import("../bridge");
    fireEvent.click(screen.getByTestId("matte-download"));
    await waitFor(() =>
      expect(vi.mocked(smartModelDownload)).toHaveBeenCalledWith("vitmatte"),
    );
  });
});


describe("late Polish answers", () => {
  for (const runner of [false, true]) {
    for (const change of ["photo", "take", "reach"] as const) {
      it(`${runner ? "brush" : "button"} refuses a late answer after ${change} changes`, async () => {
        const { polishMatte, serializeGraph } = await import("../bridge");
        let { s, maskId } = withSelection();
        s = run(s, { type: "set_text_param", id: maskId, param: "matte_id", value: "baked:original" },
          { type: "add_polish_stroke", id: maskId, stroke: { points: [[0.5, 0.5]], radius: 0.05, mode: "matte" } });
        let resolve!: (id: string) => void;
        vi.mocked(polishMatte).mockImplementationOnce(() => new Promise<string>((r) => { resolve = r; }));
        let current = s;
        const dispatch = (c: Command) => { current = reduce(current, c); };
        const Component = runner ? PolishMatteRunner : PolishMatteButton;
        const view = render(<Component state={current} dispatch={dispatch} />);
        if (!runner) fireEvent.click(screen.getByTestId("art-polish-matte"));
        await waitFor(() => expect(resolve).toBeDefined());
        current = change === "photo" ? { ...current, activeImage: "review-other-photo" }
          : change === "take" ? { ...current, activeTakes: { ...current.activeTakes, [current.activeImage]: "review-other-take" } }
          : reduce(current, { type: "set_param", id: maskId, param: "matte_reach", value: 80 });
        view.rerender(<Component state={current} dispatch={dispatch} />);
        const before = serializeGraph(current);
        await act(async () => { resolve("late-answer"); });
        expect(serializeGraph(current)).toEqual(before);
        view.unmount();
      });
    }
  }
});
