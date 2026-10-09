// Expand settings on select, and the settings chevron (2026-09-30: "for
// adjustment layers (like with the warp layer) I think the layer should
// have an edit button to view and edit the controls so layers aren't
// expanding and collapsing all the time. I think this edit button can be
// toggled off. Add a button to the left of the separator next to the
// group button. It's a toggle button. When on, layer controls auto
// expand when the layer is selected. When off, a layer will have an edit
// button to expand it and view the controls/settings. Whatever the last
// setting the user set will persist, it's a global setting and not
// per-photo."), then: "maybe have the edit (collapse/expand button) on
// the top next to the visibility so it's not like another tool button".
//
// The collapsible layers are the Adjustment layers, Warp, Gradient,
// Image and Fill; Pixel and the paint layers, and Smart ("Smart layer
// should not be collapsible"), are not. A Fill layer's open settings are
// the picker inline with RGB or CMY numbers; the Show mask eye rides the
// layer's button strip instead of a row of its own.
//
// Every test builds its own state and reads only what it made.

import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { useCallback, useState } from "react";
import { describe, expect, it } from "vitest";
import { initialState, NEUTRAL_NODES, NEUTRAL_WIRES } from "../data";
import { ART_FX, artLayers, artMaskOf, paramRange, reduce, type Command, type State } from "../state";
import type { NodeCard } from "../state";
import { uiSettingsCommands, uiSettingsSnapshot } from "../settings";
import { noteFrameAspect } from "../imagelayers";
import { ArtLayersTab, fxReadout, fxReadoutChars, fxReadoutWidth } from "../ui/artlayers";

const run = (s: State, ...cmds: Command[]): State => cmds.reduce(reduce, s);

function fresh(id = "layer_expand_toggle"): State {
  noteFrameAspect(id, 1.5);
  return {
    ...initialState(),
    activeImage: id,
    mode: "simple",
    panelTab: "layers",
    nodes: structuredClone(NEUTRAL_NODES),
    wires: structuredClone(NEUTRAL_WIRES),
  };
}

/** The mounted host's dispatch, for commands no panel control sends
 * (a canvas drag, Escape, a new Take). */
let latestDispatch: (c: Command) => void = () => {};

/** The Finish tab over a live reducer; `latest()` is its state. */
function mount(initial: State) {
  let current = initial;
  function Host() {
    const [s, setS] = useState(initial);
    const dispatch = useCallback((c: Command) => {
      setS((prev) => {
        const next = reduce(prev, c);
        current = next;
        return next;
      });
    }, []);
    latestDispatch = dispatch;
    return <ArtLayersTab state={s} dispatch={dispatch} />;
  }
  const view = render(<Host />);
  return { view, latest: () => current };
}

/** Two Exposure layers over a Pixel layer, tool down; blend ids bottom
 * up. */
function adjustments(on: boolean): { s: State; pixel: string; a: string; b: string } {
  const s = run(
    fresh(),
    { type: "art_add_layer", kind: "paint" },
    { type: "art_add_layer", kind: "exposure" },
    { type: "art_add_layer", kind: "exposure" },
    { type: "set_tool", tool: "none" },
    { type: "set_ui_setting", key: "layerExpandOnSelect", value: on },
  );
  const [pixel, a, b] = artLayers(s).map((l) => l.blend.id);
  return { s, pixel, a, b };
}

const pick = (id: string) => fireEvent.mouseDown(screen.getByTestId(`art-layer-${id}`), { button: 0 });
const sliders = (id: string) => screen.queryByTestId(`art-adjust-${id}`);

describe("the Expand settings on select toggle", () => {
  it("sits immediately left of the divider before Group, off by default, and says what each way does", () => {
    const s = fresh();
    expect(s.layerExpandOnSelect).toBe(false);
    const { latest } = mount(run(s, { type: "art_add_layer", kind: "exposure" }));
    const actions = screen.getByTestId("art-toolbar-actions");
    const kids = Array.from(actions.children);
    const at = kids.findIndex((k) => k.getAttribute("data-testid") === "art-expand-on-select");
    expect(at).toBe(0);
    // Next the divider (a bare 1px rule with no test id), then Group.
    expect(kids[at + 1].tagName).toBe("DIV");
    expect(kids[at + 1].getAttribute("data-testid")).toBeNull();
    expect((kids[at + 1] as HTMLElement).style.width).toBe("1px");
    expect(kids[at + 2].getAttribute("data-testid")).toBe("art-group");
    const toggle = screen.getByTestId("art-expand-on-select");
    expect(toggle).toHaveAttribute("aria-label", "Expand settings on select");
    expect(toggle).toHaveAttribute("data-tip", "Expand settings on select");
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(toggle.getAttribute("data-hint")).toMatch(/^Off: layers stay compact/);
    // The row's opener is the chevron (Show settings); there is no Edit
    // button to name (docs review 2026-10-01).
    expect(toggle.getAttribute("data-hint")).toMatch(/chevron/);
    expect(toggle.getAttribute("data-hint")).not.toMatch(/Edit button/);
    fireEvent.click(toggle);
    expect(latest().layerExpandOnSelect).toBe(true);
    expect(screen.getByTestId("art-expand-on-select")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("art-expand-on-select").getAttribute("data-hint")).toMatch(/^On: selecting a layer opens its settings/);
    expect(screen.getByTestId("art-expand-on-select").getAttribute("data-hint")).toMatch(/chevron/);
    expect(screen.getByTestId("art-expand-on-select").getAttribute("data-hint")).not.toMatch(/Edit button/);
  });

  it("is kept with the UI settings, read back on relaunch, and is no photograph's", () => {
    const on = run(fresh(), { type: "set_ui_setting", key: "layerExpandOnSelect", value: true });
    const saved = JSON.parse(JSON.stringify(uiSettingsSnapshot(on)));
    expect(saved.layerExpandOnSelect).toBe(true);
    // A relaunch: a fresh state takes the saved commands.
    const cmds = uiSettingsCommands(JSON.stringify(saved));
    expect(cmds).toContainEqual({ type: "set_ui_setting", key: "layerExpandOnSelect", value: true });
    const relaunched = run(fresh(), ...cmds);
    expect(relaunched.layerExpandOnSelect).toBe(true);
    // Off is kept the same way, and a hand-edited value is ignored.
    const off = uiSettingsCommands(JSON.stringify({ ...saved, layerExpandOnSelect: false }));
    expect(run(relaunched, ...off).layerExpandOnSelect).toBe(false);
    expect(uiSettingsCommands(JSON.stringify({ ...saved, layerExpandOnSelect: "yes" })).some((c) => c.type === "set_ui_setting" && c.key === "layerExpandOnSelect")).toBe(false);
    // Across photographs: switching to another leaves it as it was.
    const base = initialState();
    const [first, second] = base.images.map((i) => i.id);
    let s = run(base, { type: "select_image", id: first }, { type: "set_ui_setting", key: "layerExpandOnSelect", value: true });
    s = run(s, { type: "select_image", id: second });
    expect(s.activeImage).toBe(second);
    expect(s.layerExpandOnSelect).toBe(true);
  });
});

describe("on: selecting a layer opens its settings", () => {
  it("the selected layer's settings open and the one before closes, with no chevrons", () => {
    const { s, a, b } = adjustments(true);
    mount(s);
    // The last made is selected, and open.
    expect(sliders(b)).not.toBeNull();
    expect(sliders(a)).toBeNull();
    pick(a);
    expect(sliders(a)).not.toBeNull();
    expect(sliders(b)).toBeNull();
    expect(screen.queryByTestId(`art-settings-${a}`)).toBeNull();
    expect(screen.getByTestId(`art-layer-${a}`)).toHaveAttribute("data-settings", "open");
    expect(screen.getByTestId(`art-layer-${b}`)).toHaveAttribute("data-settings", "closed");
  });
});

describe("off: rows stay compact and the chevron opens them", () => {
  it("selecting does not open; the chevron opens and closes, and an open layer stays open while others are selected", () => {
    const { s, pixel, a, b } = adjustments(false);
    mount(s);
    expect(sliders(a)).toBeNull();
    expect(sliders(b)).toBeNull();
    pick(a);
    expect(sliders(a)).toBeNull();
    // Beside the visibility dot in the top line, a disclosure, not a
    // tool button.
    const chevron = screen.getByTestId(`art-settings-${a}`);
    expect(chevron).toHaveAttribute("aria-label", "Show settings");
    expect(chevron).toHaveAttribute("aria-expanded", "false");
    expect(chevron.className).not.toContain("chip");
    const line = chevron.parentElement!;
    expect(within(line).getByTestId(`art-vis-${a}`)).toBeTruthy();
    expect(chevron.nextElementSibling).toBe(screen.getByTestId(`art-vis-${a}`));
    fireEvent.click(chevron);
    expect(sliders(a)).not.toBeNull();
    expect(screen.getByTestId(`art-settings-${a}`)).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId(`art-settings-${a}`)).toHaveAttribute("aria-label", "Hide settings");
    // Selecting other layers leaves it open, and does not open them.
    pick(b);
    pick(pixel);
    expect(sliders(a)).not.toBeNull();
    expect(sliders(b)).toBeNull();
    // Two at once, if both are opened.
    fireEvent.click(screen.getByTestId(`art-settings-${b}`));
    expect(sliders(a)).not.toBeNull();
    expect(sliders(b)).not.toBeNull();
    fireEvent.click(screen.getByTestId(`art-settings-${a}`));
    expect(sliders(a)).toBeNull();
    expect(sliders(b)).not.toBeNull();
  });

  it("with no effects, Pixel, paint, Smart and Invert rows have no chevron, only its width; the collapsible kinds each have one", () => {
    let s = run(
      fresh(),
      { type: "art_add_layer", kind: "paint" },
      { type: "art_add_layer", kind: "dodgeburn" },
      { type: "art_add_smart_layer" },
      { type: "art_add_layer", kind: "invert" },
      { type: "art_add_layer", kind: "fill" },
      { type: "art_add_layer", kind: "gradient" },
      { type: "art_add_layer", kind: "warp" },
      { type: "art_add_layer", kind: "curves" },
      { type: "art_add_layer", kind: "levels" },
      { type: "art_add_image_layer", source: { kind: "file", path: "__IMAGE__" }, name: "logo", box: { x: 0.3, y: 0.35, w: 0.4, h: 0.3 } },
    );
    s = run(s, { type: "set_tool", tool: "none" });
    mount(s);
    const layers = artLayers(s);
    const ids = layers.map((l) => l.blend.id);
    const [paint, dodge, smart, invert, ...collapsible] = ids;
    for (const id of [paint, dodge, smart, invert]) {
      expect(screen.queryByTestId(`art-settings-${id}`), id).toBeNull();
      expect(screen.getByTestId(`art-settings-none-${id}`), id).toBeTruthy();
      expect(screen.getByTestId(`art-layer-${id}`).getAttribute("data-settings"), id).toBeNull();
    }
    for (const id of collapsible) {
      expect(screen.getByTestId(`art-settings-${id}`), id).toHaveAttribute("aria-expanded", "false");
    }
    // The Smart layer always shows its own controls while it is the
    // one worked: selected, its dials are there with no chevron.
    pick(smart);
    expect(screen.getByTestId("smart-modes")).toBeTruthy();
  });

  it("a closed row is a Pixel row's height: nothing under the strip of buttons", () => {
    const s = run(
      fresh(),
      { type: "art_add_layer", kind: "paint" },
      { type: "art_add_layer", kind: "gradient" },
      { type: "art_add_layer", kind: "fill" },
      { type: "art_add_layer", kind: "exposure" },
      { type: "set_tool", tool: "none" },
    );
    mount(s);
    const [paint, ...rest] = artLayers(s).map((l) => l.blend.id);
    const count = (id: string) => screen.getByTestId(`art-layer-${id}`).children.length;
    // Less the adjustment layer's Export Mask as Layer row, which sits
    // under its Depth mask button whenever that button shows, closed or not
    // (2026-09-30: "I am not seeing the toggle I requested for export layer
    // in adjustments layers"); Pro only.
    const exportRow = (id: string) => (screen.queryByTestId(`art-mask-export-row-${id}`) ? 1 : 0);
    expect(exportRow(paint)).toBe(0);
    for (const id of rest) {
      pick(id);
      expect(count(id) - exportRow(id), id).toBe(count(paint));
      expect(screen.queryByTestId(`art-grad-shape-${id}`)).toBeNull();
      expect(screen.queryByTestId(`art-fill-color-${id}-field`)).toBeNull();
    }
  });
});

describe("a Warp layer's open settings are its edit mode", () => {
  // 2026-09-30: "I think we can remove the EDIT WARP button, when the
  // layer is expanded it should just turn on warp editing. Turn warp
  // editing off when collapsed".
  function warpStack(on: boolean) {
    const s = run(
      fresh(),
      { type: "art_add_layer", kind: "paint" },
      { type: "art_add_layer", kind: "warp" },
      { type: "art_add_layer", kind: "warp" },
      { type: "set_tool", tool: "none" },
      { type: "set_ui_setting", key: "layerExpandOnSelect", value: on },
    );
    const [pixel, blend, other] = artLayers(s).map((l) => l.blend.id);
    const [, warp, otherWarp] = artLayers(s).map((l) => l.content.id);
    return { s: run(s, { type: "select_art_layer", id: pixel }), pixel, blend, warp, other, otherWarp };
  }
  const chevron = (id: string) => screen.getByTestId(`art-settings-${id}`);

  it("has no Edit warp button", () => {
    for (const on of [true, false]) {
      const { s, blend } = warpStack(on);
      const view = mount(run(s, { type: "select_art_layer", id: blend }));
      expect(screen.queryByTestId(`art-warp-edit-${blend}`)).toBeNull();
      expect(screen.queryByLabelText("Edit warp")).toBeNull();
      view.view.unmount();
    }
  });

  it("on: selecting arms it, selecting another layer puts it down and closes it", () => {
    const { s, pixel, blend, warp } = warpStack(true);
    const { latest } = mount(s);
    expect(screen.queryByTestId(`finish-warp-${warp}`)).toBeNull();
    pick(blend);
    expect(screen.getByTestId(`finish-warp-kind-${warp}`)).toBeTruthy();
    expect(latest().tool).toBe("gridwarp");
    expect(latest().warpTarget).toBe(warp);
    pick(pixel);
    expect(latest().tool).toBe("none");
    expect(latest().warpTarget).toBeNull();
    expect(screen.queryByTestId(`finish-warp-${warp}`)).toBeNull();
  });

  it("on: selecting by any door arms it, the Layer menu's and a new Warp layer included", () => {
    const { s, blend, warp } = warpStack(true);
    // The reducer's rule, not the panel's: no panel mounted here.
    const picked = run(s, { type: "select_art_layer", id: blend });
    expect(picked.warpTarget).toBe(warp);
    const added = run(s, { type: "art_add_layer", kind: "warp" });
    const fresh = artLayers(added)[artLayers(added).length - 1];
    expect(added.artActive).toBe(fresh.blend.id);
    expect(added.warpTarget).toBe(fresh.content.id);
    // Off, selecting arms nothing by itself.
    const off = run(s, { type: "set_ui_setting", key: "layerExpandOnSelect", value: false }, { type: "select_art_layer", id: blend });
    expect(off.tool).toBe("none");
  });

  it("off: the chevron opens and arms it, the chevron again closes it and puts it down", () => {
    const { s, blend, warp } = warpStack(false);
    const { latest } = mount(s);
    pick(blend);
    expect(latest().tool).toBe("none");
    expect(screen.queryByTestId(`finish-warp-${warp}`)).toBeNull();
    fireEvent.click(chevron(blend));
    expect(screen.getByTestId(`finish-warp-${warp}`)).toBeTruthy();
    expect(chevron(blend)).toHaveAttribute("aria-expanded", "true");
    expect(latest().tool).toBe("gridwarp");
    expect(latest().warpTarget).toBe(warp);
    const steps = latest().undoStack.length;
    fireEvent.click(chevron(blend));
    expect(screen.queryByTestId(`finish-warp-${warp}`)).toBeNull();
    expect(latest().tool).toBe("none");
    expect(latest().warpTarget).toBeNull();
    // Opening and closing is no edit.
    expect(latest().undoStack.length).toBe(steps);
  });

  it("off: one warp at a time; selecting an open one again moves edit mode back to it", () => {
    const { s, pixel, blend, warp, other, otherWarp } = warpStack(false);
    const { latest } = mount(s);
    fireEvent.click(chevron(blend));
    expect(latest().warpTarget).toBe(warp);
    fireEvent.click(chevron(other));
    expect(latest().artActive).toBe(other);
    expect(latest().warpTarget).toBe(otherWarp);
    // Both open, one edited.
    expect(chevron(blend)).toHaveAttribute("aria-expanded", "true");
    expect(chevron(other)).toHaveAttribute("aria-expanded", "true");
    pick(blend);
    expect(latest().warpTarget).toBe(warp);
    // Another layer: the tool goes down, the open settings stay.
    pick(pixel);
    expect(latest().tool).toBe("none");
    expect(chevron(blend)).toHaveAttribute("aria-expanded", "true");
  });

  it("Escape puts the warp back and down and leaves the settings open; the chevron twice arms it again", () => {
    const { s, blend, warp } = warpStack(false);
    const { latest } = mount(s);
    fireEvent.click(chevron(blend));
    const before = artLayers(latest()).find((l) => l.blend.id === blend)!.content.textParams;
    const MESH = { cols: 1, rows: 1, us: [0, 1], vs: [0, 1], d: [[0.02, 0], [0.02, 0], [0.02, 0.01], [0.02, 0.01]] as [number, number][] };
    act(() => {
      // what a drag on the canvas sends
      latestDispatch({ type: "grid_warp_mesh", mesh: MESH, target: warp });
      latestDispatch({ type: "cancel_tool" });
    });
    expect(latest().tool).toBe("none");
    expect(artLayers(latest()).find((l) => l.blend.id === blend)!.content.textParams).toEqual(before);
    expect(screen.getByTestId(`finish-warp-${warp}`)).toBeTruthy();
    expect(chevron(blend)).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(chevron(blend));
    expect(latest().tool).toBe("none");
    expect(screen.queryByTestId(`finish-warp-${warp}`)).toBeNull();
    fireEvent.click(chevron(blend));
    expect(latest().warpTarget).toBe(warp);
  });

  it("another Take puts it down and closes it; another photograph puts it down", () => {
    const { s, blend, warp } = warpStack(false);
    const { latest } = mount(s);
    fireEvent.click(chevron(blend));
    expect(latest().warpTarget).toBe(warp);
    act(() => latestDispatch({ type: "new_take" }));
    expect(latest().tool).toBe("none");
    expect(latest().warpTarget).toBeNull();
    expect(chevron(blend)).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId(`finish-warp-${warp}`)).toBeNull();
    // A photograph switch, the reducer's part: the warp's tool goes down.
    const armed = run(s, { type: "art_warp_edit", id: warp, on: true });
    const another = armed.images.find((i) => i.id !== armed.activeImage);
    expect(another).toBeDefined();
    {
      const away = run(armed, { type: "select_image", id: another!.id });
      expect(away.tool).toBe("none");
      expect(away.warpTarget).toBeNull();
    }
  });

  it("leaving Finish or deleting the layer puts it down", () => {
    const { s, blend, warp } = warpStack(true);
    const armed = run(s, { type: "select_art_layer", id: blend });
    expect(armed.warpTarget).toBe(warp);
    const left = run(armed, { type: "set_panel_tab", tab: "adjust" });
    expect(left.tool).toBe("none");
    expect(left.warpTarget).toBeNull();
    const gone = run(armed, { type: "art_remove_layer", id: blend });
    expect(gone.tool).toBe("none");
    expect(gone.warpTarget).toBeNull();
  });

  it("a Warp member of a group arms on its own chevron and puts it down on it", () => {
    const { s, blend, warp } = warpStack(false);
    const grouped = run(s, { type: "art_group_layers", ids: [blend] });
    const group = artLayers(grouped).find((l) => l.content.isGroup)!;
    const { latest } = mount(grouped);
    fireEvent.click(screen.getByTestId(`art-open-${group.blend.id}`));
    const member = screen.getAllByTestId(/^art-member-/).find((e) => within(e).queryByTestId(/^art-open-member-/))!;
    const memberId = member.getAttribute("data-testid")!.replace("art-member-", "");
    fireEvent.mouseDown(screen.getByTestId(`art-open-member-${memberId}`), { button: 0 });
    fireEvent.click(screen.getByTestId(`art-open-member-${memberId}`));
    expect(latest().warpTarget).toBe(warp);
    fireEvent.mouseDown(screen.getByTestId(`art-open-member-${memberId}`), { button: 0 });
    fireEvent.click(screen.getByTestId(`art-open-member-${memberId}`));
    expect(latest().tool).toBe("none");
  });
});

describe("a Fill layer's settings", () => {
  function fill() {
    const s = run(fresh(), { type: "art_add_layer", kind: "fill" }, { type: "set_tool", tool: "none" });
    const id = artLayers(s)[0].blend.id;
    return { s, id };
  }
  const color = (s: State, id: string) => artLayers(s).find((l) => l.blend.id === id)!.content.textParams?.color;

  it("closed, a static chip that opens them; open, the picker inline with no popover", () => {
    const { s, id } = fill();
    mount(s);
    const chip = screen.getByTestId(`art-fill-chip-${id}`);
    expect(chip.getAttribute("data-value")).toBe("#808080");
    expect(screen.queryByTestId(`art-fill-color-${id}`)).toBeNull();
    fireEvent.click(chip);
    expect(screen.queryByTestId(`art-fill-chip-${id}`)).toBeNull();
    for (const part of ["field", "hue", "hex", "picker", "r", "g", "b"]) {
      expect(screen.getByTestId(`art-fill-color-${id}-${part}`), part).toBeTruthy();
    }
    expect(screen.queryByTestId(`art-fill-color-${id}-popover`)).toBeNull();
  });

  it("RGB and CMY numbers, each typed number one undo step", () => {
    const { s, id } = fill();
    const { latest } = mount(run(s, { type: "art_content_set", id, param: "color", value: "#336699" }));
    fireEvent.click(screen.getByTestId(`art-settings-${id}`));
    const field = (ch: string) => screen.getByTestId(`art-fill-color-${id}-${ch}`) as HTMLInputElement;
    expect([field("r").value, field("g").value, field("b").value]).toEqual(["51", "102", "153"]);
    expect(screen.getByTestId(`art-fill-color-${id}-mode-rgb`)).toHaveAttribute("aria-pressed", "true");
    const undo = latest().undoStack.length;
    fireEvent.change(field("r"), { target: { value: "255" } });
    fireEvent.blur(field("r"));
    expect(color(latest(), id)).toBe("#ff6699");
    expect(latest().undoStack.length - undo).toBe(1);
    // CMY: the complement of RGB, 0 to 100 percent of ink.
    fireEvent.click(screen.getByTestId(`art-fill-color-${id}-mode-cmy`));
    expect(screen.getByTestId(`art-fill-color-${id}-mode-cmy`)).toHaveAttribute("aria-pressed", "true");
    expect([field("c").value, field("m").value, field("y").value]).toEqual(["0", "60", "40"]);
    expect(screen.queryByTestId(`art-fill-color-${id}-r`)).toBeNull();
    fireEvent.change(field("y"), { target: { value: "100" } });
    fireEvent.blur(field("y"));
    expect(color(latest(), id)).toBe("#ff6600");
    expect(latest().undoStack.length - undo).toBe(2);
    // Past the range is clamped, not refused.
    fireEvent.change(field("c"), { target: { value: "250" } });
    fireEvent.blur(field("c"));
    expect(color(latest(), id)).toBe("#006600");
  });

  it("a drag in the picker is one undo step, and the middle button does nothing", () => {
    const { s, id } = fill();
    const { latest } = mount(s);
    fireEvent.click(screen.getByTestId(`art-settings-${id}`));
    const field = screen.getByTestId(`art-fill-color-${id}-field`);
    field.getBoundingClientRect = () => ({ left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100, x: 0, y: 0, toJSON() {} }) as DOMRect;
    const before = latest().undoStack.length;
    // jsdom has no PointerEvent: a MouseEvent carries the button.
    fireEvent(field, new MouseEvent("pointerdown", { bubbles: true, button: 1, buttons: 4, clientX: 90, clientY: 10 }));
    expect(color(latest(), id)).toBe("#808080");
    fireEvent(field, new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 90, clientY: 10 }));
    fireEvent(window, new MouseEvent("pointermove", { clientX: 50, clientY: 50 }));
    fireEvent(window, new MouseEvent("pointermove", { clientX: 20, clientY: 30 }));
    fireEvent(window, new MouseEvent("pointerup", {}));
    expect(color(latest(), id)).not.toBe("#808080");
    expect(latest().undoStack.length - before).toBe(1);
  });
});

describe("the Show mask eye rides the button strip", () => {
  it("on a Smart layer: beside the mask buttons, no row of its own; it stands down with the brush in hand", () => {
    const s = run(fresh(), { type: "art_add_smart_layer" });
    const blend = s.artActive!;
    expect(artMaskOf(s, blend)?.type).toBe("heeler.smart_mask");
    const { view } = mount(s);
    const eye = screen.getByTestId(`art-mask-eye-${blend}`);
    // The strip that holds the mask's own buttons.
    const strip = eye.parentElement!;
    expect(screen.getByTestId(`art-mask-edit-${blend}`).parentElement).toBe(strip);
    expect(screen.getByTestId(`art-depth-${blend}-toggle`).parentElement).toBe(strip);
    expect(within(strip).getByTestId(`art-mask-edit-${blend}`)).toBeTruthy();
    expect(within(eye).getByTestId("mask-view-chip")).toBeTruthy();
    expect(screen.getAllByTestId("mask-view-chip")).toHaveLength(1);
    view.unmount();
    mount(run(s, { type: "set_tool", tool: "brush" }));
    expect(screen.queryByTestId(`art-mask-eye-${blend}`)).toBeNull();
  });

  it("on any layer kind with a mask, the same seat, on the selected layer only", () => {
    let s = run(fresh(), { type: "art_add_layer", kind: "paint" });
    const pixel = s.artActive!;
    s = run(s, { type: "art_add_mask", id: pixel }, { type: "art_add_layer", kind: "exposure" });
    const adjust = s.artActive!;
    s = run(s, { type: "art_add_mask", id: adjust }, { type: "set_tool", tool: "none" });
    mount(s);
    expect(screen.getByTestId(`art-mask-eye-${adjust}`).parentElement).toBe(screen.getByTestId(`art-mask-edit-${adjust}`).parentElement);
    expect(screen.queryByTestId(`art-mask-eye-${pixel}`)).toBeNull();
    pick(pixel);
    expect(screen.getByTestId(`art-mask-eye-${pixel}`).parentElement).toBe(screen.getByTestId(`art-mask-edit-${pixel}`).parentElement);
    expect(screen.queryByTestId(`art-mask-eye-${adjust}`)).toBeNull();
  });
});

// Layer effects fold with the layer's chevron (2026-09-30: "actually,
// pixel layers should be collapsible as well. I forgot about layer
// fx"). Every layer that carries effects gets the chevron, Pixel and
// Smart included; a Smart layer's own dials stay out of it.
describe("layer effects fold with the layer's chevron", () => {
  /** The id of the effect a layer carries, the newest one. */
  const fxOf = (s: State, blend: string) => {
    const l = artLayers(s).find((x) => x.blend.id === blend)!;
    return l.fx[l.fx.length - 1].id;
  };
  const settingsOf = (fx: string) => screen.queryByTestId(`art-fx-param-${fx}-size`);

  function pixelWithShadow(on: boolean) {
    let s = run(fresh(), { type: "art_add_layer", kind: "paint" }, { type: "art_add_layer", kind: "exposure" });
    const [pixel, adjust] = artLayers(s).map((l) => l.blend.id);
    s = run(
      s,
      { type: "art_add_fx", id: pixel, fx: "shadow" },
      { type: "set_tool", tool: "none" },
      { type: "set_ui_setting", key: "layerExpandOnSelect", value: on },
      { type: "select_art_layer", id: adjust },
    );
    return { s, pixel, adjust, fx: fxOf(s, pixel) };
  }

  it("off: a Pixel layer with a Shadow has the chevron; it folds and unfolds the effect's settings, and selecting does neither", () => {
    const { s, pixel, adjust, fx } = pixelWithShadow(false);
    mount(s);
    const chevron = screen.getByTestId(`art-settings-${pixel}`);
    expect(chevron).toHaveAttribute("aria-expanded", "false");
    expect(chevron.nextElementSibling).toBe(screen.getByTestId(`art-vis-${pixel}`));
    expect(screen.getByTestId(`art-layer-${pixel}`)).toHaveAttribute("data-settings", "closed");
    // Folded: the effect's name and eye stay, its settings go.
    expect(screen.getByTestId(`art-fx-${fx}`)).toBeTruthy();
    expect(settingsOf(fx)).toBeNull();
    expect(screen.queryByTestId(`art-fx-remove-${fx}`)).toBeNull();
    pick(pixel);
    expect(settingsOf(fx)).toBeNull();
    // The strip stays either way, as on every collapsible layer.
    expect(screen.getByTestId(`art-mode-${pixel}`)).toBeTruthy();
    expect(screen.getByTestId(`art-fx-add-${pixel}`)).toBeTruthy();
    fireEvent.click(screen.getByTestId(`art-settings-${pixel}`));
    expect(settingsOf(fx)).not.toBeNull();
    expect(screen.getByTestId(`art-fx-param-${fx}-angle`)).toBeTruthy();
    expect(screen.getByTestId(`art-settings-${pixel}`)).toHaveAttribute("aria-expanded", "true");
    // Open stays open while another layer is selected.
    pick(adjust);
    expect(settingsOf(fx)).not.toBeNull();
    fireEvent.click(screen.getByTestId(`art-settings-${pixel}`));
    expect(settingsOf(fx)).toBeNull();
    expect(screen.getByTestId(`art-fx-${fx}`)).toBeTruthy();
  });

  it("off: adding an effect opens the layer's settings, so the new effect shows its controls", () => {
    const s = run(fresh(), { type: "art_add_layer", kind: "paint" }, { type: "set_tool", tool: "none" });
    const pixel = artLayers(s)[0].blend.id;
    const { latest } = mount(s);
    // No effects yet: nothing to fold, so no chevron.
    expect(screen.queryByTestId(`art-settings-${pixel}`)).toBeNull();
    fireEvent.click(screen.getByTestId(`art-fx-add-${pixel}`));
    fireEvent.click(screen.getByTestId("art-fx-pick-shadow"));
    const fx = fxOf(latest(), pixel);
    expect(screen.getByTestId(`art-settings-${pixel}`)).toHaveAttribute("aria-expanded", "true");
    expect(settingsOf(fx)).not.toBeNull();
  });

  it("on: selecting a Pixel layer opens its effects' settings and the one before closes, with no chevrons", () => {
    const { s, pixel, adjust, fx } = pixelWithShadow(true);
    mount(s);
    expect(screen.queryByTestId(`art-settings-${pixel}`)).toBeNull();
    expect(settingsOf(fx)).toBeNull();
    expect(sliders(adjust)).not.toBeNull();
    pick(pixel);
    expect(settingsOf(fx)).not.toBeNull();
    expect(sliders(adjust)).toBeNull();
    expect(screen.getByTestId(`art-layer-${pixel}`)).toHaveAttribute("data-settings", "open");
    pick(adjust);
    expect(settingsOf(fx)).toBeNull();
  });

  it("every layer kind that carries an effect folds it with its chevron; a Smart layer's dials stay out of it", () => {
    let s = run(
      fresh(),
      { type: "art_add_layer", kind: "paint" },
      { type: "art_add_layer", kind: "dodgeburn" },
      { type: "art_add_smart_layer" },
      { type: "art_add_layer", kind: "invert" },
      { type: "art_add_layer", kind: "fill" },
      { type: "art_add_layer", kind: "gradient" },
      { type: "art_add_layer", kind: "warp" },
      { type: "art_add_layer", kind: "curves" },
      { type: "art_add_layer", kind: "exposure" },
      { type: "art_add_image_layer", source: { kind: "file", path: "__IMAGE__" }, name: "logo", box: { x: 0.3, y: 0.35, w: 0.4, h: 0.3 } },
    );
    const ids = artLayers(s).map((l) => l.blend.id);
    s = run(s, ...ids.map((id): Command => ({ type: "art_add_fx", id, fx: "glow" })));
    // A group of one more, carrying its own effect.
    s = run(s, { type: "art_add_layer", kind: "paint" });
    const inner = s.artActive!;
    s = run(s, { type: "art_group_layers", ids: [inner] });
    const group = artLayers(s).find((l) => l.content.isGroup)!.blend.id;
    s = run(s, { type: "art_add_fx", id: group, fx: "shadow" }, { type: "set_tool", tool: "none" }, { type: "select_art_layer", id: ids[0] });
    mount(s);
    const smart = ids[2];
    for (const id of [...ids, group]) {
      const fx = fxOf(s, id);
      const chevron = screen.getByTestId(`art-settings-${id}`);
      expect(chevron, id).toHaveAttribute("aria-expanded", "false");
      expect(settingsOf(fx), id).toBeNull();
      fireEvent.click(chevron);
      expect(settingsOf(fx), id).not.toBeNull();
      fireEvent.click(screen.getByTestId(`art-settings-${id}`));
      expect(settingsOf(fx), id).toBeNull();
    }
    // The group keeps its own chevron for the members, ahead of this one.
    expect(screen.getByTestId(`art-open-${group}`).nextElementSibling).toBe(screen.getByTestId(`art-settings-${group}`));
    // Folded, the Smart layer still shows its dials while it is worked.
    pick(smart);
    expect(screen.getByTestId(`art-settings-${smart}`)).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByTestId("smart-modes")).toBeTruthy();
    expect(settingsOf(fxOf(s, smart))).toBeNull();
  });

  it("every effect kind on a Pixel layer folds with it", () => {
    const kinds = ["shadow", "glow", "color_overlay", "gradient_overlay", "bevel", "blur"];
    let s = run(fresh(), { type: "art_add_layer", kind: "paint" });
    const pixel = s.artActive!;
    s = run(s, ...kinds.map((fx): Command => ({ type: "art_add_fx", id: pixel, fx })), { type: "set_tool", tool: "none" });
    mount(s);
    // Blur is the plain blur node, not a heeler.fx_ one: the stack still
    // reads it as an effect and the Pixel layer as the content.
    const fxs = artLayers(s)[0].fx;
    expect(fxs.map((f) => f.artKind)).toEqual(kinds);
    expect(artLayers(s)[0].content.type).toBe("heeler.paint");
    const anyDial = (f: string) => screen.queryAllByTestId(new RegExp(`^art-fx-param-${f}-`));
    for (const f of fxs) expect(anyDial(f.id), f.artKind).toHaveLength(0);
    fireEvent.click(screen.getByTestId(`art-settings-${pixel}`));
    for (const f of fxs) expect(anyDial(f.id).length, f.artKind).toBeGreaterThan(0);
  });
});

// The effect dials' readouts (the owner's screenshot read "+135."
// for the Shadow's Angle: a 34px seat for "+135.0" and a degree
// mark).
describe("an effect dial's readout fits its widest value", () => {
  it("the seat holds the widest readout of every dial at either end of its slider, in ch so it scales with the UI zoom", () => {
    for (const [kind, spec] of Object.entries(ART_FX)) {
      const node = { id: `fx_${kind}`, type: spec.type, params: { ...spec.params } } as unknown as NodeCard;
      const chars = fxReadoutChars(node);
      for (const param of Object.keys(spec.params).filter((k) => k !== "inner")) {
        const [lo, hi] = paramRange(param, spec.type);
        for (const v of [lo, hi, spec.params[param]]) {
          expect(fxReadout(param, v).length, `${kind} ${param} ${v}`).toBeLessThanOrEqual(chars);
        }
      }
    }
    // An angle reads in whole degrees, its slider's step.
    expect(fxReadout("angle", 135)).toBe("+135°");
    expect(fxReadout("angle", -180)).toBe("−180°");
    expect(fxReadoutChars({ type: "heeler.fx_shadow", params: ART_FX.shadow.params } as unknown as NodeCard)).toBeGreaterThanOrEqual(5);
    // Each character is a ch, plus the field's padding and border.
    expect(fxReadoutWidth(5)).toBe("calc(5ch + 6px)");
  });

  it("the Shadow's seats are that width and show the angle whole", () => {
    let s = run(fresh(), { type: "art_add_layer", kind: "paint" });
    const pixel = s.artActive!;
    s = run(s, { type: "art_add_fx", id: pixel, fx: "shadow" }, { type: "set_ui_setting", key: "layerExpandOnSelect", value: true });
    mount(s);
    const fx = artLayers(s)[0].fx[0];
    const chars = fxReadoutChars(fx);
    for (const param of ["size", "distance", "angle", "opacity"]) {
      const seat = screen.getByTestId(`art-fx-readout-${fx.id}-${param}`);
      expect(seat.style.width, param).toBe(fxReadoutWidth(chars));
      // The ch is the field's own 11px figures.
      expect(seat.style.fontSize, param).toBe("11px");
    }
    expect((within(screen.getByTestId(`art-fx-readout-${fx.id}-angle`)).getByRole("textbox") as HTMLInputElement).value).toBe("+135°");
  });
});
