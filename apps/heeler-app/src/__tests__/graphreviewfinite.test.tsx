import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { initialState } from "../data";
import { reduce, type Command } from "../state";
import { ColorField } from "../ui/colorfield";
import { ColorConsoleBlock } from "../ui/colorconsole";
import { TrackSlider, ValueField } from "../ui/track";

afterEach(() => { cleanup(); });
for (const bad of [NaN, Infinity, -Infinity]) {
  for (const kind of ["single", "batch", "position", "curve", "stroke", "nested graph"] as const) {
    it(`refuses ${String(bad)} in ${kind} without adding an undo step`, () => {
      const s = initialState();
      const cmd: Command = kind === "single" ? { type: "set_param", id: "exposure", param: "exposure", value: bad }
        : kind === "batch" ? { type: "set_params", id: "exposure", values: { exposure: bad } }
        : kind === "position" ? { type: "move_node", id: "exposure", x: bad, y: 0 }
        : kind === "curve" ? { type: "set_curve", id: "exposure", channel: "rgb", curve: [[0, 0], [1, bad]] } as Command
        : kind === "stroke" ? { type: "add_stroke", id: "exposure", stroke: { points: [[bad, 0.5]], radius: 0.02 } } as Command
        : { type: "replace_graph", nodes: s.nodes.map(n => n.id === "exposure" ? { ...n, params: { exposure: bad } } : n), wires: s.wires } as Command;
      expect(reduce(s, cmd)).toBe(s);
    });
  }
}
it("a batch still applies its finite values while leaving invalid values alone", () => {
  const s = initialState();
  const next = reduce(s, { type: "set_params", id: "exposure", values: { exposure: 0.7, contrast: Infinity } });
  const node = next.nodes.find(n => n.id === "exposure")!;
  expect(node.params.exposure).toBe(0.7);
  expect(node.params.contrast).toBe(s.nodes.find(n => n.id === "exposure")!.params.contrast);
});
it("a slider ignores a pointer with no coordinate instead of displaying NaN", () => {
  const values: number[] = [];
  render(<TrackSlider label="Review slider" value={3} lo={0} hi={10} onChange={v => values.push(v)} />);
  const track = screen.getByRole("slider");
  track.getBoundingClientRect = () => ({ left: 0, width: 100 } as DOMRect);
  fireEvent.pointerDown(track, { button: 0, buttons: 1, pointerId: 1 });
  expect(values).toEqual([]);
  expect(track).toHaveAttribute("aria-valuenow", "3");
  act(() => track.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0, buttons: 1, clientX: 50 })));
  expect(values).toEqual([5]);
});

it("a color picker ignores missing coordinates before producing a hex string", () => {
  const colors: string[] = [];
  render(<ColorField label="Review color" value="#336699" onChange={c => colors.push(c)} testid="review-color" />);
  fireEvent.click(screen.getByTestId("review-color"));
  const field = screen.getByTestId("review-color-field");
  field.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100 } as DOMRect);
  const press = new MouseEvent("pointerdown", { bubbles: true, button: 0, buttons: 1 });
  Object.defineProperty(press, "clientX", { value: undefined });
  act(() => field.dispatchEvent(press));
  fireEvent.pointerUp(window, { pointerId: 1 });
  expect(colors).toEqual([]);
});
for (const seat of ["console-pad-red", "console-sat"]) {
  it(`Color Tune ${seat} ignores missing coordinates before serializing its bands`, () => {
    const sent: Command[] = [];
    const node = initialState().nodes.find(n => n.type === "heeler.color_console")!;
    render(<ColorConsoleBlock node={node} band="red" onBand={() => {}} dispatch={c => sent.push(c)} />);
    const holder = screen.getByTestId(seat);
    const target = seat === "console-sat" ? holder.querySelector('[role="slider"]')! : holder;
    fireEvent.pointerDown(target, { button: 0, pointerId: 1 });
    expect(sent.filter(c => c.type === "set_text_param")).toEqual([]);
  });
}
it("a numeric scrub ignores a non-finite move", () => {
  const values: number[] = [];
  render(<ValueField value={3} param="review" lo={0} hi={10} step={1} onCommit={v => values.push(v)} />);
  fireEvent.mouseDown(screen.getByTestId("value-review"), { button: 0, clientX: 10 });
  const move = new MouseEvent("mousemove", { bubbles: true });
  Object.defineProperty(move, "clientX", { value: NaN });
  act(() => window.dispatchEvent(move));
  fireEvent.mouseUp(window);
  expect(values).toEqual([]);
});
