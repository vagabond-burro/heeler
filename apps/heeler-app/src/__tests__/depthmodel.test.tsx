// The Depth Map's Model (2026-10-28): Depth Anything V2 Small or 3 Mono
// Large, chosen per photograph. A photograph is born with the
// Preferences default and keeps its model until it is switched by hand;
// one from before the choice reads V2 with the keys it always had. DA3
// reads at its own Detail sizes, is asked for before it downloads, and
// the card shows the download's progress.

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { initialState } from "../data";
import { DEFAULT_PREFS, depthMapParams, depthModelOf, depthTuned, freshNodesFor, reduce, snapDepthSize, spliceOut, type Command, type State } from "../state";
import { nodeResetValues } from "../ui/simpledata";
import { DepthModelChoice, DepthRunner } from "../ui/depthtool";
import { depthRecipeKey } from "../ui/depthtoolparts";
import { Preferences } from "../ui/preferences";
import type { ModelDownloadProgress } from "../bridge";

let da3Installed = false;
let v2Installed = true;
let progressHandler: ((p: ModelDownloadProgress) => void) | null = null;
const status = (id: string, installed: boolean, label: string, bytes: number) => ({
  id, installed, label, bytes, license: "Apache-2.0", url: `https://example.test/${id}.onnx`, version: "1",
});
vi.mock("../bridge", async (importOriginal) => {
  const real = await importOriginal<typeof import("../bridge")>();
  return {
    ...real,
    filePasses: vi.fn(async () => null),
    depthMap: vi.fn(async (s: State) => {
      const dm = s.nodes.find((n) => n.type === "heeler.depth_map" && n.enabled);
      if (dm?.textParams?.model === "da3_mono_large" && !da3Installed) throw new Error("model not installed");
      return { version: "feedfacefeedface", work: "model" as const };
    }),
    smartModelDownload: vi.fn(async () => {}),
    smartModelStatus: vi.fn(async () => ({
      depth: status("depth_anything_v2_small", v2Installed, "Depth Anything V2 Small (scene depth)", 99_060_839),
      depthDa3: status("depth_anything_3_mono_large", da3Installed, "Depth Anything 3 Mono Large (scene depth, detail)", 433_346_946),
    })),
    onModelDownloadProgress: vi.fn((fn: (p: ModelDownloadProgress) => void) => {
      progressHandler = fn;
      return () => {
        progressHandler = null;
      };
    }),
  };
});

const run = (s: State, ...cmds: Command[]) => cmds.reduce(reduce, s);
const dm = (s: State) => s.nodes.find((n) => n.id === "depthmap")!;
/** A photograph with no Depth Map yet: the section is born when asked. */
const bare = (): State => {
  const s = initialState();
  return { ...s, nodes: s.nodes.filter((n) => n.id !== "depthmap"), wires: spliceOut(s.wires, "depthmap") };
};
const withDa3Default = () => run(bare(), { type: "set_prefs", prefs: { depthModel: "da3_mono_large" } });

beforeEach(() => {
  vi.clearAllMocks();
  da3Installed = false;
  v2Installed = true;
  progressHandler = null;
});

describe("the Depth Map's model, per photograph", () => {
  it("a new photograph is born with the Preferences default, at that model's own Detail", () => {
    // V2 by default, as before the choice existed.
    expect(DEFAULT_PREFS.depthModel).toBe("v2_small");
    let s = run(bare(), { type: "set_category", title: "Depth Map", on: true });
    expect(dm(s).textParams?.model).toBe("v2_small");
    expect(dm(s).params.size).toBe(518);
    // DA3 by preference: born with it, at 504 (the nearest of DA3's to
    // the preference's 518), and at 1008 from a preference of 1036.
    s = run(withDa3Default(), { type: "set_category", title: "Depth Map", on: true });
    expect(dm(s).textParams?.model).toBe("da3_mono_large");
    expect(dm(s).params.size).toBe(504);
    s = run(bare(), { type: "set_prefs", prefs: { depthModel: "da3_mono_large", depthSize: 1036 } }, { type: "set_category", title: "Depth Map", on: true });
    expect(dm(s).params.size).toBe(1008);
    // The auto-born map (a depth tool woke with no section) follows it too.
    s = run(withDa3Default(), { type: "set_param", id: "fog", param: "density", value: 40 });
    expect(dm(s).textParams?.model).toBe("da3_mono_large");
  });

  it("a default graph carrying a Depth Map gives a new photograph the preference's model", () => {
    const s = withDa3Default();
    const withMap = { ...s, defaultGraph: { ...s.defaultGraph, nodes: initialState().nodes } };
    const node = freshNodesFor(withMap, "new-photo").find((n) => n.type === "heeler.depth_map")!;
    expect(node.textParams?.model).toBe("da3_mono_large");
    expect(node.params.size).toBe(504);
    // A default graph that names its model keeps it.
    const named = { ...withMap, defaultGraph: { ...withMap.defaultGraph, nodes: withMap.defaultGraph.nodes.map((n) => (n.type === "heeler.depth_map" ? { ...n, textParams: { model: "v2_small" } } : n)) } };
    expect(freshNodesFor(named, "new-photo").find((n) => n.type === "heeler.depth_map")!.textParams?.model).toBe("v2_small");
  });

  it("changing the default later touches no photograph that already has its section", () => {
    let s = run(bare(), { type: "set_category", title: "Depth Map", on: true });
    s = run(s, { type: "set_prefs", prefs: { depthModel: "da3_mono_large" } });
    expect(depthModelOf(dm(s))).toBe("v2_small");
    // Off and on again keeps the photograph's own model.
    s = run(s, { type: "set_category", title: "Depth Map", on: false }, { type: "set_category", title: "Depth Map", on: true });
    expect(depthModelOf(dm(s))).toBe("v2_small");
  });

  it("a photograph from before the choice reads V2 with the keys it always had", () => {
    let s = run(bare(), { type: "set_category", title: "Depth Map", on: true });
    const before = depthRecipeKey(s);
    // Strip the parameter, as a graph saved before the choice has it.
    s = { ...s, nodes: s.nodes.map((n) => (n.id === "depthmap" ? { ...n, textParams: {} } : n)) };
    expect(depthModelOf(dm(s))).toBe("v2_small");
    expect(depthRecipeKey(s)).toBe(before);
    expect(before).toBe("e50f25n0x0s518");
    // An unknown word (a later version's model) is V2 too.
    expect(depthModelOf({ textParams: { model: "someday" } })).toBe("v2_small");
  });

  it("switching snaps Detail to the model's own sizes in one undo step, and keys a plane of its own", () => {
    let s = run(bare(), { type: "set_category", title: "Depth Map", on: true }, { type: "set_param", id: "depthmap", param: "size", value: 1036 });
    const v2Key = depthRecipeKey(s);
    s = run(s, { type: "set_text_param", id: "depthmap", param: "model", value: "da3_mono_large" });
    expect(dm(s).params.size).toBe(1008);
    expect(depthRecipeKey(s)).toBe("da3_mono_large|e50f25n0x0s1008");
    expect(depthRecipeKey(s)).not.toBe(v2Key);
    s = run(s, { type: "undo" });
    expect(depthModelOf(dm(s))).toBe("v2_small");
    expect(dm(s).params.size).toBe(1036);
    // DA3 at its own 504 with nothing refined is still its own plane.
    s = run(s, { type: "set_text_param", id: "depthmap", param: "model", value: "da3_mono_large" }, { type: "set_param", id: "depthmap", param: "size", value: 504 }, { type: "set_param", id: "depthmap", param: "edges", value: 0 }, { type: "set_param", id: "depthmap", param: "flatten", value: 0 });
    expect(depthRecipeKey(s)).toBe("da3_mono_large|e0f0n0x0s504");
  });

  it("a reset returns the dials to the preference and keeps the photograph's model", () => {
    let s = run(withDa3Default(), { type: "set_category", title: "Depth Map", on: true }, { type: "set_prefs", prefs: { depthModel: "v2_small" } });
    s = run(s, { type: "set_param", id: "depthmap", param: "edges", value: 10 });
    s = run(s, { type: "reset_node", id: "depthmap", ...nodeResetValues(dm(s)) });
    expect(depthModelOf(dm(s))).toBe("da3_mono_large");
    expect(dm(s).params).toMatchObject({ edges: 50, flatten: 25, size: 504 });
  });

  it("the preference is one of the two models and its Detail follows", () => {
    expect(run(initialState(), { type: "set_prefs", prefs: { depthModel: "x" as never } }).prefs.depthModel).toBe("v2_small");
    expect(run(initialState(), { type: "set_prefs", prefs: { depthModel: "da3_mono_large", depthSize: 700 } }).prefs.depthSize).toBe(504);
    expect(snapDepthSize(1036, "da3_mono_large")).toBe(1008);
    expect(snapDepthSize(504)).toBe(518);
    // Edges and Flatten are the same for both models.
    expect(depthMapParams(DEFAULT_PREFS, "da3_mono_large")).toEqual({ edges: 50, flatten: 25, size: 504 });
  });

  it("a photograph is tuned against its map when Levels moved or a mask is limited by depth", () => {
    const s = run(bare(), { type: "set_category", title: "Depth Map", on: true });
    expect(depthTuned(s)).toBe(false);
    expect(depthTuned(run(s, { type: "set_param", id: "depthmap", param: "depth_black", value: 0.2 }))).toBe(true);
    expect(depthTuned(run(s, { type: "set_param", id: "fog", param: "depth_gamma", value: 1.4 }))).toBe(true);
  });
});

describe("the section's Model control", () => {
  const section = () => run(bare(), { type: "set_category", title: "Depth Map", on: true });

  it("offers both models and each model's own Detail sizes", async () => {
    let s = section();
    const { rerender } = render(<DepthModelChoice node={dm(s)} state={s} dispatch={() => {}} />);
    expect(screen.getByTestId("depth-size-518")).toBeTruthy();
    expect(screen.getByTestId("depth-size-1036")).toBeTruthy();
    expect(screen.queryByTestId("depth-size-504")).toBeNull();
    s = run(s, { type: "set_text_param", id: "depthmap", param: "model", value: "da3_mono_large" });
    rerender(<DepthModelChoice node={dm(s)} state={s} dispatch={() => {}} />);
    expect(screen.getByTestId("depth-size-504")).toBeTruthy();
    expect(screen.getByTestId("depth-size-1008").getAttribute("aria-pressed")).toBe("false");
    expect(screen.queryByTestId("depth-size-700")).toBeNull();
  });

  it("switching a tuned photograph says in one line that Levels and masks may land differently", async () => {
    let s = run(section(), { type: "set_param", id: "depthmap", param: "depth_black", value: 0.2 });
    const got: Command[] = [];
    const view = render(<DepthModelChoice node={dm(s)} state={s} dispatch={(c) => got.push(c)} />);
    fireEvent.click(screen.getByTestId("depth-model"));
    fireEvent.click(await screen.findByTestId("depth-model-option-da3_mono_large"));
    expect(got).toContainEqual({ type: "set_text_param", id: "depthmap", param: "model", value: "da3_mono_large" });
    s = run(s, ...got);
    view.rerender(<DepthModelChoice node={dm(s)} state={s} dispatch={() => {}} />);
    const note = screen.getByTestId("depth-model-note");
    expect(note.textContent).toContain("V2 SMALL");
    expect(note.textContent).toContain("DA3 LARGE");
  });

  it("an untuned photograph switches without the note", async () => {
    let s = section();
    const got: Command[] = [];
    const view = render(<DepthModelChoice node={dm(s)} state={s} dispatch={(c) => got.push(c)} />);
    fireEvent.click(screen.getByTestId("depth-model"));
    fireEvent.click(await screen.findByTestId("depth-model-option-da3_mono_large"));
    s = run(s, ...got);
    view.rerender(<DepthModelChoice node={dm(s)} state={s} dispatch={() => {}} />);
    expect(screen.queryByTestId("depth-model-note")).toBeNull();
  });

  it("asks for DA3 only: a missing V2 is the runner's to ask for, as before, and DA3 can be declined", async () => {
    const { smartModelStatus } = await import("../bridge");
    v2Installed = false;
    let s = section();
    const got: Command[] = [];
    const view = render(<DepthModelChoice node={dm(s)} state={s} dispatch={(c) => got.push(c)} />);
    await waitFor(() => expect(vi.mocked(smartModelStatus)).toHaveBeenCalled());
    expect(screen.queryByTestId("depth-model-consent")).toBeNull();
    s = run(s, { type: "set_text_param", id: "depthmap", param: "model", value: "da3_mono_large" });
    view.rerender(<DepthModelChoice node={dm(s)} state={s} dispatch={(c) => got.push(c)} />);
    await screen.findByTestId("depth-model-consent");
    expect(screen.getByTestId("depth-model-missing")).toBeTruthy();
    fireEvent.click(screen.getByTestId("depth-model-keep-v2"));
    expect(got).toContainEqual({ type: "set_text_param", id: "depthmap", param: "model", value: "v2_small" });
  });

  it("a model not installed is asked for with its size, and the card shows the download's progress", async () => {
    const s = run(section(), { type: "set_text_param", id: "depthmap", param: "model", value: "da3_mono_large" });
    render(<DepthModelChoice node={dm(s)} state={s} dispatch={() => {}} />);
    const card = await screen.findByTestId("depth-model-consent");
    expect(card.textContent).toContain("Depth Anything 3 Mono Large");
    expect(card.textContent).toContain("433 MB");
    const { smartModelDownload } = await import("../bridge");
    let finish: () => void = () => {};
    vi.mocked(smartModelDownload).mockImplementationOnce(() => new Promise<void>((r) => (finish = r)));
    fireEvent.click(screen.getByTestId("depth-model-download"));
    expect(vi.mocked(smartModelDownload)).toHaveBeenCalledWith("depth_anything_3_mono_large");
    await waitFor(() => expect(progressHandler).not.toBeNull());
    act(() => progressHandler!({ model: "depth_anything_3_mono_large", done: 216_673_473, total: 433_346_946 }));
    expect(screen.getByTestId("depth-model-download").textContent).toBe("DOWNLOADING 50%");
    expect(screen.getByTestId("depth-model-progress").getAttribute("aria-valuenow")).toBe("50");
    // Another model's progress is not this card's.
    act(() => progressHandler!({ model: "lama", done: 9, total: 10 }));
    expect(screen.getByTestId("depth-model-download").textContent).toBe("DOWNLOADING 50%");
    da3Installed = true;
    await act(async () => finish());
    await waitFor(() => expect(screen.queryByTestId("depth-model-consent")).toBeNull());
  });
});

describe("the runner with DA3", () => {
  const fogOnDa3 = () =>
    run(withDa3Default(), { type: "set_category", title: "Depth Map", on: true }, { type: "set_param", id: "fog", param: "density", value: 40 });

  it("a photograph set to DA3 without the model asks for DA3, not V2", async () => {
    render(<DepthRunner state={fogOnDa3()} dispatch={() => {}} />);
    const card = await screen.findByTestId("depth-consent");
    expect(card.textContent).toContain("Depth Anything 3 Mono Large");
    const { smartModelDownload } = await import("../bridge");
    fireEvent.click(screen.getByTestId("depth-download"));
    await waitFor(() => expect(vi.mocked(smartModelDownload)).toHaveBeenCalledWith("depth_anything_3_mono_large"));
  });

  it("switched back to V2 while DA3 waits, the runner reads with V2", async () => {
    const s = fogOnDa3();
    const got: Command[] = [];
    const view = render(<DepthRunner state={s} dispatch={(c) => got.push(c)} />);
    await screen.findByTestId("depth-consent");
    const back = run(s, { type: "set_text_param", id: "depthmap", param: "model", value: "v2_small" });
    view.rerender(<DepthRunner state={back} dispatch={(c) => got.push(c)} />);
    await waitFor(() => expect(got).toContainEqual({ type: "poke_render" }));
    expect(screen.queryByTestId("depth-consent")).toBeNull();
  });

  it("stands down while the section shows its own card, so a download is asked for once", async () => {
    const s = fogOnDa3();
    render(
      <>
        <DepthRunner state={s} dispatch={() => {}} />
        <DepthModelChoice node={dm(s)} state={s} dispatch={() => {}} />
      </>,
    );
    await screen.findByTestId("depth-model-consent");
    const { depthMap } = await import("../bridge");
    await waitFor(() => expect(vi.mocked(depthMap)).toHaveBeenCalled());
    expect(screen.queryByTestId("depth-consent")).toBeNull();
  });
});

describe("the default depth model in Preferences", () => {
  it("lives under Models, writes the preference, and offers the chosen model's own Detail sizes", () => {
    const sent: Command[] = [];
    const s = { ...initialState(), prefsOpen: true };
    const view = render(<Preferences state={s} dispatch={((c: Command) => sent.push(c)) as never} />);
    fireEvent.click(screen.getByTestId("prefs-tab-models"));
    fireEvent.click(screen.getByTestId("prefs-depth-model"));
    fireEvent.click(screen.getByTestId("prefs-depth-model-option-da3_mono_large"));
    expect(sent).toContainEqual({ type: "set_prefs", prefs: { depthModel: "da3_mono_large", depthSize: 504 } });
    const da3 = run(s, ...sent);
    view.rerender(<Preferences state={da3} dispatch={((c: Command) => sent.push(c)) as never} />);
    fireEvent.click(screen.getByTestId("prefs-depth-size"));
    expect(screen.getByTestId("prefs-depth-size-option-1008")).toBeTruthy();
    expect(screen.queryByTestId("prefs-depth-size-option-700")).toBeNull();
  });
});
