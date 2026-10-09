// The Depth Lighting rig and the Depth of Field focus picker: typed
// lights with viewport handles, every light first-class, the panel
// steering whichever is selected.

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { initialState } from "../data";
import { reduce, toolNode, type Command, type State } from "../state";
import { choose, menuRows, menuValue } from "./menuhelp";
import {
  DofFocusOverlay,
  KeyLightControls,
  KeyLightGizmo,
  lightsOf,
} from "../ui/keylightgizmo";

vi.mock("../bridge", async (importOriginal) => {
  const real = await importOriginal<typeof import("../bridge")>();
  return {
    ...real,
    depthAt: vi.fn(async () => 0.73),
  };
});

const run = (s: State, ...cmds: Command[]) => cmds.reduce(reduce, s);
const norm = (e: { clientX: number; clientY: number }) =>
  [e.clientX / 200, e.clientY / 100] as [number, number];

const RIG =
  '[{"kind":"directional","azimuth":45,"elevation":45,"strength":60,"tx":0.5,"ty":0.5},' +
  '{"kind":"point","px":0.3,"py":0.6,"strength":-50,"height":50,"range":40}]';

beforeEach(() => vi.clearAllMocks());

describe("the light rig", () => {
  it("legacy params seed a single directional; the JSON is the rig when present", () => {
    let s = run(initialState(), { type: "set_param", id: "keylight", param: "strength", value: 60 });
    expect(lightsOf(toolNode(s, "keylight")!)).toHaveLength(1);
    s = run(s, { type: "set_text_param", id: "keylight", param: "lights", value: RIG });
    const rig = lightsOf(toolNode(s, "keylight")!);
    expect(rig).toHaveLength(2);
    expect(rig[1].kind).toBe("point");
  });

  it("directional lights wear a target and a handle; point lights one disc", () => {
    const s = run(initialState(), { type: "set_text_param", id: "keylight", param: "lights", value: RIG });
    const node = toolNode(s, "keylight")!;
    render(<KeyLightGizmo state={s} dispatch={() => {}} node={node} norm={norm} />);
    expect(screen.getByTestId("keylight-target-0")).toBeTruthy();
    expect(screen.getByTestId("keylight-handle-0")).toBeTruthy();
    expect(screen.queryByTestId("keylight-target-1")).toBeNull();
    const point = screen.getByTestId("keylight-handle-1");
    expect(point.title).toContain("(dark)");
    expect(point.title).toContain("(point)");
  });

  it("dragging the target moves the rig; clicking selects; SHIFT-click deletes any light", () => {
    const s = run(initialState(), { type: "set_text_param", id: "keylight", param: "lights", value: RIG });
    const node = toolNode(s, "keylight")!;
    const got: Command[] = [];
    render(<KeyLightGizmo state={s} dispatch={(c) => got.push(c)} node={node} norm={norm} />);
    // Drag the directional's TARGET: the whole rig translates.
    screen
      .getByTestId("keylight-target-0")
      .dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 100, clientY: 50 }));
    window.dispatchEvent(new MouseEvent("pointermove", { clientX: 40, clientY: 30 }));
    window.dispatchEvent(new MouseEvent("pointerup", {}));
    expect(got).toContainEqual({ type: "select_keylight", index: 0 });
    const write = got.find((c) => c.type === "set_text_param") as Extract<
      Command,
      { type: "set_text_param" }
    >;
    const rig = JSON.parse(write.value) as { tx: number; ty: number; azimuth: number }[];
    expect(rig[0].tx).toBeCloseTo(0.2, 5);
    expect(rig[0].ty).toBeCloseTo(0.3, 5);
    expect(rig[0].azimuth).toBe(45); // the aim survives the move
    // SHIFT-click deletes the FIRST light too: no second-class lights.
    got.length = 0;
    screen
      .getByTestId("keylight-handle-0")
      .dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, shiftKey: true }));
    const del = got.find((c) => c.type === "set_text_param") as Extract<
      Command,
      { type: "set_text_param" }
    >;
    expect((JSON.parse(del.value) as unknown[]).length).toBe(1);
  });

  // The 26.4.3 full review's R6: the rig's drag listened on the window
  // with nothing to end it but its release, so a drag the window lost
  // (focus elsewhere, the release never seen) or the gizmo unmounting
  // mid-drag left the gesture held and the light following the pointer.
  for (const how of ["blur", "unmount"] as const) {
    it(`a light drag ended by ${how === "blur" ? "the window losing focus" : "the gizmo going away"} ends its gesture and stops following`, () => {
      const s = run(initialState(), { type: "set_text_param", id: "keylight", param: "lights", value: RIG });
      const node = toolNode(s, "keylight")!;
      const got: Command[] = [];
      const r = render(<KeyLightGizmo state={s} dispatch={(c) => got.push(c)} node={node} norm={norm} />);
      screen.getByTestId("keylight-target-0").dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 100, clientY: 50 }));
      window.dispatchEvent(new MouseEvent("pointermove", { clientX: 40, clientY: 30 }));
      if (how === "blur") window.dispatchEvent(new Event("blur"));
      else r.unmount();
      expect(got.filter((c) => c.type === "end_gesture")).toHaveLength(1);
      const writes = got.filter((c) => c.type === "set_text_param").length;
      window.dispatchEvent(new MouseEvent("pointermove", { clientX: 10, clientY: 10 }));
      window.dispatchEvent(new MouseEvent("pointerup", {}));
      expect(got.filter((c) => c.type === "set_text_param"), "the light stopped following").toHaveLength(writes);
      expect(got.filter((c) => c.type === "end_gesture"), "ended once").toHaveLength(1);
      r.unmount();
    });
  }

  it("emptying the rig also silences the legacy params light", () => {
    const one = '[{"kind":"directional","azimuth":45,"elevation":45,"strength":60}]';
    let s = run(
      initialState(),
      { type: "set_param", id: "keylight", param: "strength", value: 60 },
      { type: "set_text_param", id: "keylight", param: "lights", value: one },
    );
    const node = toolNode(s, "keylight")!;
    const got: Command[] = [];
    render(<KeyLightGizmo state={s} dispatch={(c) => got.push(c)} node={node} norm={norm} />);
    screen
      .getByTestId("keylight-handle-0")
      .dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, shiftKey: true }));
    expect(got).toContainEqual({
      type: "set_params",
      id: "keylight",
      values: { strength: 0 },
      text: {},
    });
  });

  it("a light toggles off without losing itself, and wears a color", () => {
    // "I should be able to toggle a light on and off"
    // and "We need to be able to color the lights."
    let s = run(
      initialState(),
      { type: "set_text_param", id: "keylight", param: "lights", value: RIG },
      { type: "select_keylight", index: 0 },
    );
    const node = toolNode(s, "keylight")!;
    const got: Command[] = [];
    render(<KeyLightControls state={s} dispatch={(c) => got.push(c)} node={node} />);
    fireEvent.click(screen.getByTestId("keylight-on"));
    let write = got.find((c) => c.type === "set_text_param") as Extract<
      Command,
      { type: "set_text_param" }
    >;
    let rig = JSON.parse(write.value) as { on: boolean; strength?: number; power: number }[];
    expect(rig[0].on).toBe(false);
    // The settings stay: the saved 60 on the old scale is power 30 on
    // the scale since 2026-10-08, written under its new key alone.
    expect(rig[0].power).toBe(30);
    expect(rig[0].strength).toBeUndefined();
    got.length = 0;
    // The same ColorField the paint brushes wear ("for
    // consistency"): open the swatch, type into its hex field.
    fireEvent.click(screen.getByTestId("keylight-color"));
    fireEvent.change(screen.getByTestId("keylight-color-hex"), { target: { value: "#ff2000" } });
    write = got.find((c) => c.type === "set_text_param") as Extract<
      Command,
      { type: "set_text_param" }
    >;
    const colored = JSON.parse(write.value) as { color: string }[];
    expect(colored[0].color).toBe("#ff2000");
  });

  it("the panel steers the selected light: type flips keep it in place", () => {
    let s = run(
      initialState(),
      { type: "set_text_param", id: "keylight", param: "lights", value: RIG },
      { type: "select_keylight", index: 0 },
    );
    const node = toolNode(s, "keylight")!;
    const got: Command[] = [];
    render(<KeyLightControls state={s} dispatch={(c) => got.push(c)} node={node} />);
    // The two kinds are pictures with the words in the label and the
    // hint, not text on the button (2026-09-20).
    for (const [kind, label] of [["point", "Point light"], ["directional", "Directional light"]] as const) {
      const button = screen.getByTestId(`keylight-kind-${kind}`);
      expect(button.getAttribute("aria-label")).toBe(label);
      expect(button).toHaveAttribute("aria-pressed", kind === "directional" ? "true" : "false");
      expect(button.querySelector("svg")).not.toBeNull();
      expect(button.textContent?.trim()).toBe("");
    }
    fireEvent.click(screen.getByTestId("keylight-kind-point"));
    const write = got.find((c) => c.type === "set_text_param") as Extract<
      Command,
      { type: "set_text_param" }
    >;
    const rig = JSON.parse(write.value) as { kind: string; px: number }[];
    expect(rig[0].kind).toBe("point");
    expect(rig[0].px).toBeCloseTo(0.5, 5); // the lamp lands on the old target
    // Delete removes the selected light and clears the selection.
    got.length = 0;
    fireEvent.click(screen.getByTestId("keylight-delete"));
    const del = got.find((c) => c.type === "set_text_param") as Extract<
      Command,
      { type: "set_text_param" }
    >;
    expect((JSON.parse(del.value) as unknown[]).length).toBe(1);
    expect(got).toContainEqual({ type: "select_keylight", index: null });
  });
});

describe("the focus picker", () => {
  it("one click reads the depth under the cursor and sets the focus dial", async () => {
    const s = run(initialState(), { type: "toggle_dof_pick" });
    const node = toolNode(s, "dof")!;
    const got: Command[] = [];
    render(<DofFocusOverlay state={s} dispatch={(c) => got.push(c)} node={node} norm={norm} />);
    fireEvent.mouseDown(screen.getByTestId("dof-focus-overlay"), { button: 0, clientX: 100, clientY: 50 });
    await waitFor(() =>
      expect(got).toContainEqual({ type: "set_param", id: "dof", param: "focus", value: 73 }),
    );
    expect(got).toContainEqual({ type: "toggle_dof_pick" });
  });
});

describe("the rig's dials take typed values, and Reset clears the rig", () => {
  it("typing into a dial's field writes the selected light's JSON", () => {
    let s = run(initialState(), { type: "set_text_param", id: "keylight", param: "lights", value: RIG });
    s = { ...s, keyLightSel: 0 };
    const node = toolNode(s, "keylight")!;
    const got: Command[] = [];
    render(<KeyLightControls state={s} dispatch={(c) => got.push(c)} node={node} />);
    const field = screen.getByTestId("value-keylight-sel-strength") as HTMLInputElement;
    // The saved old-scale 60 shows at half its number (2026-10-08).
    expect(field.value).toBe("30");
    fireEvent.change(field, { target: { value: "75" } });
    fireEvent.keyDown(field, { key: "Enter" });
    const write = got.find((c) => c.type === "set_text_param");
    expect(write && "value" in write && JSON.parse(write.value as string)[0].power).toBe(75);
  });

  it("a directional light has Elevation, Depth and Reach; a point light keeps its own Depth and Reach", () => {
    // 2026-10-03: "We added a depth slider for point light but not
    // directional. I think this was an oversight. Also, there is no
    // Reach", then "add the depth, reach, and elevation slider".
    let s = run(initialState(), { type: "set_text_param", id: "keylight", param: "lights", value: RIG });
    s = { ...s, keyLightSel: 0 };
    const got: Command[] = [];
    const view = render(<KeyLightControls state={s} dispatch={(c) => got.push(c)} node={toolNode(s, "keylight")!} />);
    // A light saved before the dials existed reads as the light it
    // always was: nearest plane, the shipped falloff, its own elevation.
    const value = (id: string) => (screen.getByTestId(`value-keylight-sel-${id}`) as HTMLInputElement).value;
    expect(value("elevation")).toBe("45");
    expect(value("sun-depth")).toBe("0");
    expect(value("sun-reach")).toBe("50");
    expect(screen.getByTestId("keylight-sel-sun-depth-from-scene")).toBeInTheDocument();
    // The lamp's rows are not a directional light's.
    expect(screen.queryByTestId("value-keylight-sel-depth")).not.toBeInTheDocument();
    expect(screen.queryByTestId("value-keylight-sel-range")).not.toBeInTheDocument();
    // Each writes its own key on the selected light and leaves the rest.
    const type = (id: string, text: string) => {
      const field = screen.getByTestId(`value-keylight-sel-${id}`) as HTMLInputElement;
      fireEvent.change(field, { target: { value: text } });
      fireEvent.keyDown(field, { key: "Enter" });
      const write = [...got].reverse().find((c) => c.type === "set_text_param")!;
      return JSON.parse((write as { value: string }).value) as Record<string, unknown>[];
    };
    expect(type("sun-depth", "80")[0]).toMatchObject({ kind: "directional", sun_depth: 80, sun_reach: 50, depth: 30, power: 30 });
    expect(type("sun-reach", "100")[0]).toMatchObject({ sun_reach: 100 });
    // Elevation holds to the range the handle on the photograph has.
    expect(type("elevation", "2")[0]).toMatchObject({ elevation: 5 });
    expect(type("elevation", "70")[0]).toMatchObject({ elevation: 70 });
    expect(type("elevation", "70")[1]).toMatchObject({ kind: "point", range: 40 });
    view.unmount();
    // The point light: its own Depth and Reach, none of the sun's.
    render(<KeyLightControls state={{ ...s, keyLightSel: 1 }} dispatch={() => {}} node={toolNode(s, "keylight")!} />);
    expect(screen.getByTestId("value-keylight-sel-depth")).toBeInTheDocument();
    expect(screen.getByTestId("value-keylight-sel-range")).toBeInTheDocument();
    expect(screen.getByTestId("keylight-sel-depth-from-scene")).toBeInTheDocument();
    for (const id of ["elevation", "sun-depth", "sun-reach"]) {
      expect(screen.queryByTestId(`value-keylight-sel-${id}`)).not.toBeInTheDocument();
    }
  });

  it("a typed value clamps to the dial's range", () => {
    let s = run(initialState(), { type: "set_text_param", id: "keylight", param: "lights", value: RIG });
    s = { ...s, keyLightSel: 0 };
    const got: Command[] = [];
    render(<KeyLightControls state={s} dispatch={(c) => got.push(c)} node={toolNode(s, "keylight")!} />);
    const field = screen.getByTestId("value-keylight-sel-strength") as HTMLInputElement;
    fireEvent.change(field, { target: { value: "999" } });
    fireEvent.keyDown(field, { key: "Enter" });
    const write = got.find((c) => c.type === "set_text_param");
    // Strength runs -100 to 100 since 2026-10-08.
    expect(write && "value" in write && JSON.parse(write.value as string)[0].power).toBe(100);
  });

  it("the section's Reset button clears the rig JSON", async () => {
    const { SimplePanel } = await import("../ui/simple");
    let s = run(initialState(), { type: "set_category", title: "Depth Lighting", on: true });
    s = run(s, { type: "set_text_param", id: "keylight", param: "lights", value: RIG });
    const got: Command[] = [];
    render(<SimplePanel state={s} dispatch={((c: Command) => got.push(c)) as never} />);
    fireEvent.click(screen.getByTestId("reset-depth-lighting"));
    const clear = got.find(
      (c) => c.type === "set_params" && "text" in c && (c.text as Record<string, string>).lights === "",
    );
    expect(clear).toBeTruthy();
  });

  it("section Reset clears the rig JSON back to the default light", () => {
    // The reducer-side half: an empty lights text reads as no rig, so
    // lightsOf falls back to the single legacy-param light.
    let s = run(
      initialState(),
      { type: "set_text_param", id: "keylight", param: "lights", value: RIG },
      { type: "set_text_param", id: "keylight", param: "lights", value: "" },
    );
    expect(lightsOf(toolNode(s, "keylight")!)).toHaveLength(1);
    expect(lightsOf(toolNode(s, "keylight")!)[0].color.toLowerCase()).toBe("#ffffff");
    void s;
  });
});

describe("the roster and the reach grip", () => {
  it("the dropdown lists every light and switches the selection", () => {
    let s = run(initialState(), { type: "set_text_param", id: "keylight", param: "lights", value: RIG });
    s = { ...s, keyLightSel: 0 };
    const got: Command[] = [];
    render(<KeyLightControls state={s} dispatch={(c) => got.push(c)} node={toolNode(s, "keylight")!} />);
    const roster = screen.getByTestId("keylight-roster");
    const rows = menuRows(roster);
    expect(rows.length).toBe(2);
    expect(rows[1][1]).toContain("point");
    expect(rows[1][1]).toContain("(dark)");
    choose(roster, "1");
    expect(got).toContainEqual({ type: "select_keylight", index: 1 });
  });

  it("with nothing selected the dropdown is the way in", () => {
    let s = run(initialState(), { type: "set_text_param", id: "keylight", param: "lights", value: RIG });
    s = { ...s, keyLightSel: null };
    const got: Command[] = [];
    render(<KeyLightControls state={s} dispatch={(c) => got.push(c)} node={toolNode(s, "keylight")!} />);
    const roster = screen.getByTestId("keylight-roster");
    expect(menuValue(roster)).toBe("");
    choose(roster, "0");
    expect(got).toContainEqual({ type: "select_keylight", index: 0 });
  });

  it("dragging the reach grip writes the lamp's range", () => {
    // jsdom draws nothing: hand the overlay a size so the ring, the
    // grip, and the drag math all see the same 400x200 stage.
    const origRect = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function () {
      return { left: 0, top: 0, width: 400, height: 200, right: 400, bottom: 200, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
    };
    try {
      let s = run(initialState(), { type: "set_text_param", id: "keylight", param: "lights", value: RIG });
      s = { ...s, keyLightSel: 1 };
      const node = toolNode(s, "keylight")!;
      const got: Command[] = [];
      render(<KeyLightGizmo state={s} dispatch={(c) => got.push(c)} node={node} norm={norm} />);
      const overlay = screen.getByTestId("keylight-gizmo");
      Object.defineProperty(overlay, "clientWidth", { value: 400 });
      Object.defineProperty(overlay, "clientHeight", { value: 200 });
      const grip = screen.getByTestId("keylight-reach-1");
      fireEvent(grip, new MouseEvent("pointerdown", { bubbles: true, clientX: 60 + 48 * Math.SQRT1_2, clientY: 60 + 48 * Math.SQRT1_2 }));
      // The lamp sits at (0.3, 0.6); the harness norm maps clientX/200
      // and clientY/100. Pointing at (0.6, 0.6) puts the grip 120px
      // out on a 200px short side: reach 50.
      window.dispatchEvent(new MouseEvent("pointermove", { clientX: 120, clientY: 60 }));
      window.dispatchEvent(new MouseEvent("pointerup", {}));
      const writes = got.filter((c) => c.type === "set_text_param");
      const last = writes[writes.length - 1] as Extract<Command, { type: "set_text_param" }>;
      expect(JSON.parse(last.value)[1].range).toBe(50);
      // The lamp itself never moved.
      expect(JSON.parse(last.value)[1].px).toBeCloseTo(0.3, 5);
      expect(got).toContainEqual({ type: "begin_gesture", key: "keylight.lights" });
    } finally {
      HTMLElement.prototype.getBoundingClientRect = origRect;
    }
  });
});

/* (2026-09-15): "Missing the slider to control the line thickness of
 * the light's control handles (like with shapes)". The rig reads the
 * same shape outline thickness the shape overlays do: 2 is the shipped
 * look, and every line and border scales with it.*/
describe("the rig's thickness", () => {
  const rigWith = (lineWidth?: number) => {
    const s = run(initialState(), { type: "set_text_param", id: "keylight", param: "lights", value: RIG });
    const node = toolNode(s, "keylight")!;
    return render(<KeyLightGizmo state={s} dispatch={() => {}} node={node} norm={norm} lineWidth={lineWidth} />);
  };
  const aimLine = () => screen.getByTestId("keylight-gizmo").querySelector("line")!;

  it("draws the shipped look at the default", () => {
    rigWith();
    expect(screen.getByTestId("keylight-handle-0").style.border).toMatch(/^1\.5px solid/);
    expect(aimLine().getAttribute("stroke-width")).toBe("1.2");
  });

  it("scales every line and border with the preference", () => {
    rigWith(4);
    expect(screen.getByTestId("keylight-handle-0").style.border).toMatch(/^3px solid/);
    expect(screen.getByTestId("keylight-target-0").style.border).toMatch(/^3px solid/);
    expect(aimLine().getAttribute("stroke-width")).toBe("2.4");
    // The rings too: the first circle is the directional light's rim.
    const ring = screen.getByTestId("keylight-gizmo").querySelectorAll("circle")[0];
    expect(ring.getAttribute("stroke-width")).toBe("2");
  });
});

/* (2026-09-13): "the interactive controls for lights should use the
 * same logic as the warp tools to color the controls based on the
 * scene". The rig's handles wear the shared LINES color.*/
it("the rig's handles take the LINES color, and the section offers the LINES row while the rig is up", () => {
  const s0 = initialState();
  const s = reduce(reduce(s0, { type: "toggle_keylight_pick" }), { type: "set_line_color", hue: 120, luma: 50 });
  const node = s.nodes.find((n) => n.id === "keylight")!;
  render(<KeyLightGizmo state={s} dispatch={() => {}} node={node} norm={() => [0.5, 0.5]} />);
  // hsla(120, 75%, 50%) as jsdom resolves it: the LINES green.
  expect(screen.getByTestId("keylight-handle-0").style.border).toContain("rgba(32, 223, 32");
});
