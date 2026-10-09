// The Color Wheels puck and brightness bar (first-pass review of the
// Color Wheels, 26.3.2): the numbers stay on the wheel's own ranges, a
// negative strength shows where it really pushes, and a drag is one
// gesture from press to release.
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { reduce, type Command, type NodeCard } from "../state";
import { initialState } from "../data";
import { Wheel } from "../ui/editors";

const node = (params: Record<string, number>): NodeCard =>
  ({ id: "cbal", type: "heeler.color_balance", name: "Color Wheels", cat: "color", x: 0, y: 0, enabled: true, params } as NodeCard);

function mount(params: Record<string, number>) {
  const sent: Command[] = [];
  render(<Wheel name="Mids" range="midtones" node={node(params)} dispatch={(c: Command) => sent.push(c)} />);
  const last = () => {
    const c = [...sent].reverse().find((x) => x.type === "set_params" || x.type === "set_param");
    return c?.type === "set_params" ? c.values : c?.type === "set_param" ? { [c.param]: c.value } : {};
  };
  return { sent, last };
}

describe("the wheel's keys stay on its ranges", () => {
  it("never takes the strength below zero or past full", () => {
    const { last } = mount({ midtones_hue: 30, midtones_sat: 0 });
    fireEvent.keyDown(screen.getByTestId("wheel-midtones"), { key: "ArrowDown" });
    expect(last()).toMatchObject({ midtones_sat: 0, midtones_hue: 30 });
  });

  it("caps the strength at 100", () => {
    const { last } = mount({ midtones_hue: 30, midtones_sat: 98 });
    fireEvent.keyDown(screen.getByTestId("wheel-midtones"), { key: "ArrowUp" });
    expect(last()).toMatchObject({ midtones_sat: 100 });
  });

  it("wraps the hue round the wheel instead of walking off its range", () => {
    const { last } = mount({ midtones_hue: 178, midtones_sat: 50 });
    fireEvent.keyDown(screen.getByTestId("wheel-midtones"), { key: "ArrowRight" });
    expect(last()).toMatchObject({ midtones_hue: -177 });
  });

  it("keeps the brightness bar inside -100..100, with Home and End", () => {
    const { last } = mount({ midtones_lum: 99 });
    const bar = screen.getByLabelText("Mids luminance");
    fireEvent.keyDown(bar, { key: "ArrowRight" });
    expect(last()).toMatchObject({ midtones_lum: 100 });
    fireEvent.keyDown(bar, { key: "Home" });
    expect(last()).toMatchObject({ midtones_lum: -100 });
  });
});

describe("the puck tells the truth", () => {
  it("shows a negative strength as a push toward the opposite hue", () => {
    mount({ midtones_hue: 30, midtones_sat: -40 });
    expect(screen.getByTestId("wheel-midtones-hue")).toHaveTextContent("-150°");
  });
});

describe("a drag is one gesture", () => {
  it("begins on press and ends when the pointer lets go, not at the rim", () => {
    const { sent } = mount({});
    const wheel = screen.getByTestId("wheel-midtones");
    fireEvent.pointerDown(wheel, { pointerId: 1, clientX: 10, clientY: 10 });
    expect(sent.filter((c) => c.type === "begin_gesture")).toHaveLength(1);
    fireEvent.pointerLeave(wheel, { pointerId: 1 });
    fireEvent.mouseLeave(wheel);
    expect(sent.some((c) => c.type === "end_gesture")).toBe(false);
    fireEvent.pointerUp(wheel, { pointerId: 1 });
    expect(sent.filter((c) => c.type === "end_gesture")).toHaveLength(1);
  });
});

describe("wheel accessibility and gesture ownership", () => {
  it("announces both coordinates, including reversed strength", () => {
    mount({ midtones_hue: 30, midtones_sat: -40 });
    expect(screen.getByTestId("wheel-midtones")).toHaveAttribute("aria-valuetext", "Hue -150 degrees, strength 40 percent");
  });
  it("ignores secondary clicks and moves that did not start here", () => {
    const { sent } = mount({});
    const wheel = screen.getByTestId("wheel-midtones");
    fireEvent(wheel, new MouseEvent("pointerdown", { button: 2, buttons: 2, bubbles: true }));
    fireEvent.pointerMove(wheel, { buttons: 1, pointerId: 1 });
    expect(sent).toHaveLength(0);
  });
  it("focuses the pressed control and closes a canceled gesture once", () => {
    const { sent } = mount({});
    const wheel = screen.getByTestId("wheel-midtones");
    fireEvent.pointerDown(wheel, { button: 0, pointerId: 1 });
    expect(wheel).toHaveFocus();
    fireEvent.pointerCancel(wheel, { pointerId: 1 });
    fireEvent.lostPointerCapture(wheel, { pointerId: 1 });
    fireEvent.pointerUp(wheel, { pointerId: 1 });
    expect(sent.filter(c => c.type === "end_gesture")).toHaveLength(1);
  });
});

it("grabbing an existing puck keeps its strength at either wheel size", () => {
  const { last } = mount({ midtones_hue: 0, midtones_sat: 50 });
  const wheel = screen.getByTestId("wheel-midtones");
  for (const size of [86, 240]) {
    wheel.getBoundingClientRect = () => ({ left: 0, top: 0, width: size, height: size } as DOMRect);
    fireEvent(wheel, new MouseEvent("pointerdown", { button: 0, clientX: size * .71, clientY: size * .5, bubbles: true }));
    expect(last()).toMatchObject({ midtones_hue: 0, midtones_sat: 50 });
    fireEvent.pointerUp(wheel);
  }
});

it("the face's six hue stops agree with the engine's red-yellow-green-cyan-blue-magenta axis", () => {
  mount({});
  const face = screen.getByTestId("wheel-midtones").style.background;
  const stops = face.match(/#[0-9a-f]{6}/gi)!;
  const hue = (hex: string) => {
    const [r,g,b] = [1,3,5].map(i => parseInt(hex.slice(i,i+2),16));
    const hi=Math.max(r,g,b), lo=Math.min(r,g,b), d=hi-lo;
    return ((hi===r ? (g-b)/d : hi===g ? (b-r)/d+2 : (r-g)/d+4)*60+360)%360;
  };
  expect(stops.map(hue)).toEqual([0,60,120,180,240,300,0]);
});

it.each(["Mids color", "Mids luminance"])("%s keeps ownership when a second pointer releases", label => {
  const { sent }=mount({});
  const control=screen.getByLabelText(label);
  const pointer=(type:string,id:number) => {
    const event=new MouseEvent(type,{button:0,bubbles:true});
    Object.defineProperty(event,"pointerId",{value:id});
    fireEvent(control,event);
  };
  pointer("pointerdown",1);
  pointer("pointerup",2);
  expect(sent.filter(c=>c.type==="end_gesture")).toHaveLength(0);
  pointer("pointercancel",1);
  pointer("lostpointercapture",1);
  expect(sent.filter(c=>c.type==="end_gesture")).toHaveLength(1);
});

// The pop-out wheel test printed "Received NaN for the `children`
// attribute": a pointer event without coordinates (jsdom's, or a pen
// that reports none) made the wheel write NaN hue and strength, which
// the numbers then showed as "NaN" and the engine would have read.
describe("a pointer with no position writes nothing", () => {
  it("the wheel and the brightness bar ignore a press without coordinates", () => {
    const { sent } = mount({ midtones_hue: 30, midtones_sat: 40, midtones_lum: 5 });
    fireEvent.pointerDown(screen.getByTestId("wheel-midtones"), { pointerId: 1 });
    fireEvent.pointerDown(screen.getByLabelText("Mids luminance"), { pointerId: 2 });
    const values = sent.flatMap((c) => (c.type === "set_params" ? Object.values(c.values) : c.type === "set_param" ? [c.value] : []));
    expect(values.some((v) => Number.isNaN(v))).toBe(false);
  });

  it("the reducer keeps a param rather than saving NaN", () => {
    const s = reduce(initialState(), { type: "set_params", id: "cbal", values: { midtones_hue: NaN, midtones_sat: 25 } });
    const p = s.nodes.find((n) => n.id === "cbal")!.params;
    expect(Number.isNaN(p.midtones_hue as number)).toBe(false);
    expect(p.midtones_sat).toBe(25);
  });
});
