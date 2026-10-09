import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

type Sample = { r: number; g: number; b: number; luma: number; hue: number; sat: number };
let answer: (sample: Sample | null) => void;
let reject: (error: Error) => void;
vi.mock("../bridge", async (original) => ({
  ...await original<Record<string, unknown>>(),
  sampleImage: vi.fn(() => new Promise<Sample | null>((resolve, fail) => { answer = resolve; reject = fail; })),
}));
import { Viewer } from "../ui/viewer";
import { initialState } from "../data";
import { reduce, type Command, type State } from "../state";

const sample: Sample = { r: 0.56, g: 0.5, b: 0.42, luma: 0.5, hue: 30, sat: 0.4 };
function pane(state: State, commands: Command[]) {
  return <Viewer state={state} dispatch={(c) => commands.push(c)}
    previewUrl="data:image/png;base64,x" previewError={null} previewMs={null}
    previewBackend={null} originalUrl={null} maskUrl={null} multiFrames={{}} />;
}
function armed() {
  return reduce(initialState(), { type: "arm_wb_pick", id: "stdcolor" });
}

describe("white balance answers under changing state", () => {
  it("writes and disarms a quiet pick", async () => {
    const commands: Command[] = [];
    render(pane(armed(), commands));
    fireEvent.mouseDown(screen.getByTestId("wb-pick-overlay"), { button: 0 });
    await act(async () => { answer(sample); });
    expect(commands.map((c) => c.type)).toEqual(["set_params", "arm_wb_pick"]);
  });

  it.each(["image", "take", "reaim", "manual", "delete"])("drops a late answer after %s changes", async (change) => {
    const commands: Command[] = [];
    const before = armed();
    const view = render(pane(before, commands));
    fireEvent.mouseDown(screen.getByTestId("wb-pick-overlay"), { button: 0 });
    let next: State = before;
    if (change === "image") next = reduce(before, { type: "select_image", id: "4875" });
    if (change === "take") next = { ...before, activeTakes: { ...before.activeTakes, [before.activeImage]: "take_2" } };
    if (change === "reaim") next = { ...before, wbPick: "another-color" };
    if (change === "manual") next = reduce(before, { type: "set_param", id: "stdcolor", param: "temperature", value: 5000 });
    if (change === "delete") next = { ...before, nodes: before.nodes.filter((n) => n.id !== "stdcolor") };
    view.rerender(pane(next, commands));
    await act(async () => { answer(sample); });
    expect(commands).toEqual([]);
  });

  it("an empty late sample cannot disarm a new aim", async () => {
    const commands: Command[] = [];
    const before = armed();
    const view = render(pane(before, commands));
    fireEvent.mouseDown(screen.getByTestId("wb-pick-overlay"), { button: 0 });
    view.rerender(pane({ ...before, wbPick: "another-color" }, commands));
    await act(async () => { answer(null); });
    expect(commands).toEqual([]);
  });
});


it("white balance accepts equal target settings after unrelated node rebuilding", async () => {
  const before = armed();
  const commands: Command[] = [];
  const view = render(pane(before, commands));
  fireEvent.mouseDown(screen.getByTestId("wb-pick-overlay"), { button: 0 });
  view.rerender(pane({ ...before, nodes: structuredClone(before.nodes) }, commands));
  await act(async () => { answer(sample); });
  expect(commands.map((c) => c.type)).toEqual(["set_params", "arm_wb_pick"]);
});


it("white balance reports a rejected read and disarms only its own aim", async () => {
  const commands: Command[] = [];
  render(pane(armed(), commands));
  fireEvent.mouseDown(screen.getByTestId("wb-pick-overlay"), { button: 0 });
  await act(async () => { reject(new Error("sample unavailable")); });
  expect(commands).toEqual([{ type: "arm_wb_pick", id: null }]);
});
