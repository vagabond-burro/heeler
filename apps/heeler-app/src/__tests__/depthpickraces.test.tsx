import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { initialState } from "../data";
import { capturePreset, reduce, toolNode, type State, type Command } from "../state";
import { DofFocusOverlay, KeyLightControls, lightsOf } from "../ui/keylightgizmo";
import { LensCharacterBlock } from "../ui/lenscharacter";

type Deferred<T> = { resolve: (value: T) => void; reject: (error: Error) => void };
const maps: Deferred<string>[] = [];
const depths: Deferred<number>[] = [];
type Sample = { r: number; g: number; b: number; luma: number; hue: number; sat: number };
const samples: Deferred<Sample>[] = [];
const sample: Sample = { r: 0.3, g: 0.2, b: 0.1, luma: 0.3, hue: 30, sat: 0.3 };
vi.mock("../bridge", async (original) => ({
  ...await original<Record<string, unknown>>(),
  depthMap: vi.fn(() => new Promise<string>((resolve, reject) => maps.push({ resolve, reject }))),
  depthAt: vi.fn(() => new Promise<number>((resolve, reject) => depths.push({ resolve, reject }))),
  sampleImage: vi.fn(() => new Promise<Sample>((resolve, reject) => samples.push({ resolve, reject }))),
}));
beforeEach(() => { maps.length = 0; depths.length = 0; samples.length = 0; });
const run = (s: State, ...commands: Command[]) => commands.reduce(reduce, s);
type Kind = "focus" | "light" | "aperture" | "flare";
const target = (kind: Kind) => kind === "light" ? "keylight" : "dof";
function fixture(kind: Kind): State {
  if (kind === "focus") return run(initialState(), { type: "toggle_dof_pick" });
  if (kind === "light") return run(initialState(),
    { type: "set_text_param", id: "keylight", param: "lights", value: '[{"kind":"point","px":0.5,"py":0.5,"depth":20},{"kind":"point","px":0.3,"py":0.3,"depth":40}]' },
    { type: "select_keylight", index: 0 });
  const s = run(initialState(), { type: "apply_lens_character", id: "helios" });
  return { ...s, sectionsClosed: s.sectionsClosed.filter((x) => x !== "Lens Character") };
}
function pane(kind: Kind, state: State, commands: Command[]) {
  const dispatch = (command: Command) => { commands.push(command); };
  // Keep the same component mounted even when its old target is gone.
  const node = state.nodes.find((n) => n.id === target(kind)) ?? toolNode(fixture(kind), target(kind))!;
  if (kind === "focus") return <DofFocusOverlay state={state} node={node} dispatch={dispatch} norm={() => [0.5, 0.5]} />;
  if (kind === "light") return <KeyLightControls state={state} node={node} dispatch={dispatch} />;
  return <LensCharacterBlock state={state} dispatch={dispatch} />;
}
function click(kind: Kind) {
  if (kind === "focus") fireEvent.mouseDown(screen.getByTestId("dof-focus-overlay"), { button: 0 });
  else fireEvent.click(screen.getByTestId(kind === "light" ? "keylight-sel-depth-from-scene" : kind === "aperture" ? "lens-character-open-aperture" : "lens-character-add-flare"));
}
async function answer(kind: Kind, index = 0, value = 0.73) {
  await act(async () => {
    if (kind === "aperture") maps[index].resolve("plane");
    else if (kind === "flare") samples.slice(index * 25, (index + 1) * 25).forEach((s) => s.resolve(sample));
    else depths[index].resolve(value);
  });
  if (kind === "aperture") await act(async () => { depths.forEach((d) => d.resolve(value)); });
}
const writes = (commands: Command[]) => commands.filter((c) => ["set_param", "set_params", "set_text_param", "add_character_flare_light"].includes(c.type));

for (const kind of ["focus", "light", "aperture", "flare"] as Kind[]) {
  describe(`${kind} asynchronous ownership`, () => {
    it("a quiet answer writes once", async () => {
      const commands: Command[] = [];
      render(pane(kind, fixture(kind), commands)); click(kind);
      fireEvent.mouseUp(window);
      await answer(kind);
      expect(writes(commands)).toHaveLength(1);
    });
    it.each(["image", "take", "preset", "delete-rearm", "unmount"])("ignores the answer after %s", async (change) => {
      const before = fixture(kind);
      const commands: Command[] = [];
      const view = render(pane(kind, before, commands)); click(kind);
      let next = before;
      if (change === "image") next = reduce(before, { type: "select_image", id: "4875" });
      if (change === "take") next = reduce(before, { type: "new_take" });
      if (change === "preset") next = reduce(before, { type: "apply_preset", preset: capturePreset(before, "same") });
      if (change === "delete-rearm") {
        const gone = reduce(before, { type: "delete_nodes", ids: [target(kind)] });
        next = { ...before, pickerEpoch: gone.pickerEpoch };
        expect(next.pickerEpoch).not.toBe(before.pickerEpoch);
      }
      if (change === "unmount") view.unmount(); else view.rerender(pane(kind, next, commands));
      commands.length = 0;
      await answer(kind);
      expect(commands).toEqual([]);
    });
    it("the newer of two clicks wins when its answer arrives first", async () => {
      const commands: Command[] = [];
      render(pane(kind, fixture(kind), commands)); click(kind); click(kind);
      await answer(kind, 1, 0.8);
      expect(writes(commands)).toHaveLength(1);
      const count = commands.length;
      await answer(kind, 0, 0.2);
      expect(commands).toHaveLength(count);
    });
    it("equal settings after unrelated node rebuilding still accept the pick", async () => {
      const before = fixture(kind);
      const commands: Command[] = [];
      const view = render(pane(kind, before, commands)); click(kind);
      view.rerender(pane(kind, { ...before, nodes: structuredClone(before.nodes) }, commands));
      await answer(kind);
      expect(writes(commands)).toHaveLength(1);
    });
  });
}

describe("depth tools after their later awaits", () => {
  it("aperture rechecks after the sixteen depth reads too", async () => {
    const before = fixture("aperture");
    const commands: Command[] = [];
    const view = render(pane("aperture", before, commands)); click("aperture");
    await act(async () => { maps[0].resolve("plane"); });
    expect(depths).toHaveLength(16);
    view.rerender(pane("aperture", reduce(before, { type: "new_take" }), commands));
    await act(async () => { depths.forEach((d) => d.resolve(0.4)); });
    expect(writes(commands)).toEqual([]);
  });
  it("From scene keeps edits to a different light while merging its own depth", async () => {
    const before = fixture("light");
    const commands: Command[] = [];
    const view = render(pane("light", before, commands)); click("light");
    const node = before.nodes.find((n) => n.id === "keylight")!;
    const lights = lightsOf(node); lights[1] = { ...lights[1], depth: 90 };
    const next = reduce(before, { type: "set_text_param", id: node.id, param: "lights", value: JSON.stringify(lights) });
    view.rerender(pane("light", next, commands));
    await answer("light");
    const write = writes(commands)[0] as Extract<Command, { type: "set_text_param" }>;
    expect(JSON.parse(write.value).map((l: { depth: number }) => l.depth)).toEqual([73, 90]);
  });
  it("a directional light's From scene reads the depth at its target into its own Depth", async () => {
    // The lamp reads where it stands; a directional light has no
    // place, so it reads where it is aimed, and writes sun_depth, not
    // the lamp's depth it carries unused.
    const bridge = await import("../bridge");
    const before = run(initialState(),
      { type: "set_text_param", id: "keylight", param: "lights", value: '[{"kind":"directional","azimuth":30,"elevation":40,"strength":80,"tx":0.25,"ty":0.75}]' },
      { type: "select_keylight", index: 0 });
    const commands: Command[] = [];
    render(pane("light", before, commands));
    fireEvent.click(screen.getByTestId("keylight-sel-sun-depth-from-scene"));
    const asked = vi.mocked(bridge.depthAt).mock.calls;
    expect(asked[asked.length - 1].slice(1)).toEqual([0.25, 0.75]);
    await answer("light", 0, 0.62);
    const write = writes(commands)[0] as Extract<Command, { type: "set_text_param" }>;
    expect(JSON.parse(write.value)[0]).toMatchObject({ kind: "directional", sun_depth: 62, depth: 30, elevation: 40 });
  });
  it("manual focus settings win over an old focus read", async () => {
    const before = fixture("focus");
    const commands: Command[] = [];
    const view = render(pane("focus", before, commands)); click("focus");
    const next = reduce(before, { type: "set_param", id: "dof", param: "focus", value: 20 });
    view.rerender(pane("focus", next, commands)); await answer("focus");
    expect(commands).toEqual([]);
  });
});
