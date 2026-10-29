// The crop tool's lines in the one line color every overlay reads: the
// box, its guides, handles and ring, and the straighten line, picked by
// hand, white by default, or opposed to the photograph where Preferences
// asks; and the crop bar's swatch, which opens a color picker in a
// popover and writes the same setting Grid Warp's LINES row does.

import { useReducer } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { initialState, NEUTRAL_NODES, NEUTRAL_WIRES } from "../data";
import { autoLineColor, lineColorCss } from "../gridwarp";
import { cropNode, lineSetting, reduce, type Command, type LineColorUi, type State } from "../state";
import { LineColorSwatch, LinesRow } from "../ui/linecolor";
import { autoCache, hexToLineColor } from "../ui/linecolorparts";
import { CropOverlay, StraightenOverlay } from "../ui/overlays";
import { Preferences } from "../ui/preferences";

afterEach(() => cleanup());

/** A CSS color as the DOM keeps it, to compare against what was drawn. */
function asDrawn(css: string, prop: "background" | "borderColor" = "background"): string {
  const probe = document.createElement("div");
  probe.style[prop] = css;
  return probe.style[prop];
}

const base = (): State => ({ ...initialState(), nodes: structuredClone(NEUTRAL_NODES), wires: structuredClone(NEUTRAL_WIRES) });

function cropLines(lineColor: LineColorUi, previewUrl: string | null = null) {
  const s = base();
  render(<CropOverlay node={cropNode(s)} dispatch={() => {}} lineColor={lineColor} previewUrl={previewUrl} />);
}

/** Every crop line drawn in `css`: the edge and handles solid, the
 * guides and the resting ring fainter in the same hue and luma. */
function expectCropLinesIn(line: { hue: number; luma: number; sat: number }) {
  const solid = lineColorCss(line.hue, line.luma, line.sat, 0.95);
  const faint = lineColorCss(line.hue, line.luma, line.sat, 0.45);
  expect(screen.getByTestId("crop-rect").style.borderColor).toBe(asDrawn(solid, "borderColor"));
  for (const m of ["tl", "tr", "bl", "br"]) expect(screen.getByTestId(`crop-handle-${m}`).style.background).toBe(asDrawn(solid));
  const guides = screen.getAllByTestId("crop-guide");
  expect(guides).toHaveLength(4);
  for (const g of guides) expect(g.style.background).toBe(asDrawn(faint));
  expect(screen.getByTestId("crop-ring-line").getAttribute("stroke")).toBe(faint);
}

describe("the crop overlay's lines", () => {
  it("draw in a color picked by hand, the outline under the handles kept", () => {
    cropLines({ color: "#4e7ea8" });
    expectCropLinesIn(hexToLineColor("#4e7ea8"));
    expect(screen.getByTestId("crop-handle-tl").style.boxShadow).toBe("0 0 0 1px rgba(0,0,0,.55)");
  });

  it("draw white where nothing is picked", () => {
    cropLines({ color: "#ffffff" });
    expectCropLinesIn({ hue: 0, luma: 100, sat: 0 });
  });

  it("draw on Auto in the color opposed to the photograph's own average", async () => {
    // A bright, cool sky: the lines go dark and warm.
    const url = "frame://croplinecolor-sky";
    const sky = autoLineColor({ r: 0.6, g: 0.8, b: 0.98 });
    autoCache.set(url, Promise.resolve(sky));
    cropLines({ color: null }, url);
    await act(async () => {});
    expect(sky.luma).toBe(12);
    expectCropLinesIn(sky);
  });

  it("include the straighten line and its readout", () => {
    const s = base();
    render(<StraightenOverlay node={cropNode(s)} dispatch={() => {}} lineColor={{ color: "#ff00ff" }} />);
    const overlay = screen.getByTestId("straighten-overlay");
    overlay.getBoundingClientRect = () => ({ left: 0, top: 0, right: 400, bottom: 300, width: 400, height: 300, x: 0, y: 0, toJSON() {} }) as DOMRect;
    fireEvent.mouseDown(overlay, { button: 0, buttons: 1, clientX: 50, clientY: 100 });
    fireEvent.mouseMove(window, { buttons: 1, clientX: 300, clientY: 110 });
    const css = lineColorCss(300, 50, 1, 0.95);
    expect(screen.getByTestId("straighten-line").getAttribute("stroke")).toBe(css);
    expect(screen.getByTestId("straighten-readout").getAttribute("fill")).toBe(css);
    fireEvent.mouseUp(window);
  });
});

describe("the crop overlay's thickness", () => {
  it("draws the box, the guides and the ring at the line thickness", () => {
    const s = base();
    render(<CropOverlay node={cropNode(s)} dispatch={() => {}} lineWidth={3} />);
    expect(screen.getByTestId("crop-rect").style.borderWidth).toBe("3px");
    const guides = screen.getAllByTestId("crop-guide");
    expect(guides.map((g) => g.style.width || g.style.height)).toEqual(["3px", "3px", "3px", "3px"]);
    expect(screen.getByTestId("crop-ring-line").getAttribute("stroke-width")).toBe("3");
  });
});

/** The crop bar's swatch beside Grid Warp's LINES row, on one reducer. */
function mountBoth(lineColor: LineColorUi = { color: null }) {
  const view: { state: State; sent: Command[] } = { state: { ...base(), lineColor }, sent: [] };
  function Harness() {
    const [state, dispatch] = useReducer(reduce, view.state);
    view.state = state;
    const send = (cmd: Command) => {
      view.sent.push(cmd);
      dispatch(cmd);
    };
    return (
      <div>
        <div data-testid="outside">elsewhere</div>
        <LineColorSwatch state={state} lineColor={lineSetting(state)} dispatch={send} previewUrl={null} prefix="crop" subject="crop lines" name="Crop line color" />
        <LinesRow lineColor={lineSetting(state)} dispatch={send} previewUrl={null} prefix="gridwarp" subject="grid lines" />
      </div>
    );
  }
  render(<Harness />);
  return view;
}

describe("the crop bar's line color swatch", () => {
  it("shows the color in use, white by default, with a hint that names it", () => {
    mountBoth();
    expect(screen.getByTestId("crop-line-color-chip").style.background).toBe(asDrawn("#ffffff"));
    expect(screen.getByTestId("crop-line-color").getAttribute("data-hint")).toMatch(/^Crop line color: #ffffff\./);
    cleanup();
    mountBoth({ color: "#4e7ea8" });
    expect(screen.getByTestId("crop-line-color-chip").style.background).toBe(asDrawn("#4e7ea8"));
    expect(screen.getByTestId("crop-line-color").getAttribute("data-hint")).toMatch(/^Crop line color: #4e7ea8\./);
  });

  it("holds a color picker and the thickness, a quarter larger than a section's rows, and no Hue, Luma or Auto", () => {
    // "remove the Hue and Luma sliders as well and only have a color
    // picker"; "hide the AUTO button option" (2026-10-29).
    const view = mountBoth();
    fireEvent.click(screen.getByTestId("crop-line-color"));
    const panel = screen.getByTestId("crop-line-color-panel");
    expect((panel.firstElementChild as HTMLElement).style.zoom).toBe("1.25");
    expect(panel.querySelector("[data-testid=crop-line-color-field-picker]")).not.toBeNull();
    expect(panel.querySelector("[data-testid=crop-line-width-row]")).not.toBeNull();
    for (const id of ["crop-line-hue", "crop-line-luma", "crop-line-auto"]) expect(screen.queryByTestId(id)).toBeNull();
    // A swatch in the picker writes the shared line color.
    fireEvent.click(screen.getByTestId("crop-line-color-field-swatch-4e7ea8"));
    expect(view.sent).toContainEqual({ type: "set_line_color", color: "#4e7ea8" });
    expect(view.state.lineColor).toEqual({ color: "#4e7ea8" });
    expect(screen.getByTestId("crop-line-color-chip").style.background).toBe(asDrawn("#4e7ea8"));
    // The thickness's reset is an icon, gray while the preference is
    // already in use.
    const reset = screen.getByTestId("crop-line-width-pref");
    expect(reset).toHaveAttribute("aria-label", "Reset line thickness");
    expect(reset.querySelector("svg")).not.toBeNull();
    expect(reset).toBeDisabled();
    fireEvent.keyDown(screen.getByTestId("crop-line-width-track"), { key: "ArrowRight" });
    expect(view.sent).toContainEqual({ type: "set_photo_line_width", width: 3 });
    expect(screen.getByTestId("crop-line-width-pref")).not.toBeDisabled();
    fireEvent.click(screen.getByTestId("crop-line-width-pref"));
    expect(view.sent[view.sent.length - 1]).toEqual({ type: "set_photo_line_width", width: 0 });
  });

  it("opens the picker on a click, and Escape or a press outside closes it", () => {
    mountBoth();
    const swatch = screen.getByTestId("crop-line-color");
    expect(screen.queryByTestId("crop-line-color-panel")).toBeNull();
    fireEvent.click(swatch);
    expect(screen.getByTestId("crop-line-color-panel")).toBeInTheDocument();
    expect(swatch).toHaveAttribute("aria-expanded", "true");
    const hex = screen.getByTestId("crop-line-color-field-hex");
    hex.focus();
    fireEvent.keyDown(hex, { key: "Escape" });
    expect(screen.queryByTestId("crop-line-color-panel")).toBeNull();
    expect(document.activeElement).toBe(swatch);
    fireEvent.click(swatch);
    fireEvent.mouseDown(screen.getByTestId("outside"));
    expect(screen.queryByTestId("crop-line-color-panel")).toBeNull();
    // A click on the swatch itself toggles it shut.
    fireEvent.click(swatch);
    fireEvent.mouseDown(swatch);
    fireEvent.click(swatch);
    expect(screen.queryByTestId("crop-line-color-panel")).toBeNull();
  });

  it("is reachable from the keyboard, and a hex typed in the picker writes the shared line color", async () => {
    const view = mountBoth();
    const user = userEvent.setup();
    await user.tab();
    expect(document.activeElement).toBe(screen.getByTestId("crop-line-color"));
    await user.keyboard("{Enter}");
    expect(screen.getByTestId("crop-line-color-panel")).toBeInTheDocument();
    // Opening it takes focus into the picker.
    const hex = screen.getByTestId("crop-line-color-field-hex");
    expect(document.activeElement).toBe(hex);
    await user.clear(hex);
    await user.type(hex, "#ff8800");
    expect(view.sent.filter((c) => c.type === "set_line_color").pop()).toEqual({ type: "set_line_color", color: "#ff8800" });
    expect(view.state.lineColor).toEqual({ color: "#ff8800" });
  });

  it("opens under the swatch and stays inside the window wherever the swatch is", () => {
    // jsdom lays nothing out: the popover is given its size, the swatch its place.
    const sized = Object.getOwnPropertyDescriptors(HTMLElement.prototype);
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, get() { return this.getAttribute("role") === "dialog" ? 290 : 0; } });
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get() { return this.getAttribute("role") === "dialog" ? 90 : 0; } });
    try {
      const openAt = (left: number, top: number) => {
        cleanup();
        mountBoth();
        const swatch = screen.getByTestId("crop-line-color");
        swatch.getBoundingClientRect = () => ({ left, top, right: left + 26, bottom: top + 20, width: 26, height: 20, x: left, y: top, toJSON() {} }) as DOMRect;
        fireEvent.click(swatch);
        const panel = screen.getByTestId("crop-line-color-panel");
        expect(panel.parentElement).toBe(document.body);
        return [parseFloat(panel.style.left), parseFloat(panel.style.top)];
      };
      // Room to the left: its right edge on the swatch's, under it.
      expect(openAt(600, 40)).toEqual([600 + 26 - 290, 68]);
      // A swatch near the left edge (a bar wrapped on a narrow window):
      // slid in to the window's margin, still under the swatch.
      expect(openAt(20, 40)).toEqual([8, 68]);
      // No room below: above the swatch, not over it.
      expect(openAt(600, 700)).toEqual([336, 700 - 8 - 90]);
    } finally {
      Object.defineProperty(HTMLElement.prototype, "offsetWidth", sized.offsetWidth);
      Object.defineProperty(HTMLElement.prototype, "offsetHeight", sized.offsetHeight);
    }
  });

  it("is the one setting Grid Warp's LINES row shows, both ways", () => {
    const view = mountBoth();
    expect(screen.queryByTestId("gridwarp-line-auto")).toBeNull();
    fireEvent.click(screen.getByTestId("crop-line-color"));
    fireEvent.click(screen.getByTestId("crop-line-color-field-swatch-4e7ea8"));
    expect(screen.getByTestId("gridwarp-line-color-field")).toHaveAttribute("data-value", "#4e7ea8");
    // Grid Warp's row sets it; the crop's swatch shows it.
    fireEvent.mouseDown(screen.getByTestId("outside"));
    fireEvent.click(screen.getByTestId("gridwarp-line-color-field"));
    fireEvent.click(screen.getByTestId("gridwarp-line-color-field-swatch-8a5a3c"));
    expect(view.state.lineColor).toEqual({ color: "#8a5a3c" });
    expect(screen.getByTestId("crop-line-color").getAttribute("data-hint")).toMatch(/^Crop line color: #8a5a3c\./);
  });
});

describe("the line color preferences", () => {
  it("start the lines white with Auto off, and set the color or Auto for every overlay", () => {
    const s0 = base();
    expect(s0.prefs.lineColor).toBe("#ffffff");
    expect(s0.prefs.lineColorAuto).toBe(false);
    expect(lineSetting(s0)).toEqual({ color: "#ffffff" });
    // A color picked in a tool wins for the session.
    const picked = reduce(s0, { type: "set_line_color", color: "#4E7EA8" });
    expect(lineSetting(picked)).toEqual({ color: "#4e7ea8" });
    // Setting the preference puts it back in use, over the pick.
    const red = reduce(picked, { type: "set_prefs", prefs: { lineColor: "#ff0000" } });
    expect(lineSetting(red)).toEqual({ color: "#ff0000" });
    // Auto, in Preferences only: the photograph's opposite.
    const auto = reduce(red, { type: "set_prefs", prefs: { lineColorAuto: true } });
    expect(lineSetting(auto)).toEqual({ color: null });
    expect(lineSetting(reduce(auto, { type: "set_line_color", color: "#000000" }))).toEqual({ color: "#000000" });
    // A settings file holding something else falls back to white.
    expect(reduce(s0, { type: "set_prefs", prefs: { lineColor: "white" } }).prefs.lineColor).toBe("#ffffff");
  });

  it("are rows in Preferences", () => {
    let latest = base();
    function Harness() {
      const [state, dispatch] = useReducer(reduce, reduce(base(), { type: "open_prefs" }));
      latest = state;
      return <Preferences state={state} dispatch={dispatch as never} />;
    }
    render(<Harness />);
    fireEvent.click(screen.getByTestId("prefs-tab-interface"));
    expect(screen.getByTestId("prefs-line-color")).toHaveAttribute("data-value", "#ffffff");
    expect(screen.getByTestId("prefs-line-color-auto")).toHaveAttribute("aria-checked", "false");
    fireEvent.click(screen.getByTestId("prefs-line-color-auto"));
    expect(latest.prefs.lineColorAuto).toBe(true);
    fireEvent.click(screen.getByTestId("prefs-line-color"));
    fireEvent.click(screen.getByTestId("prefs-line-color-swatch-4e7ea8"));
    expect(latest.prefs.lineColor).toBe("#4e7ea8");
  });
});

describe("the crop bar", () => {
  it("carries the swatch while the crop tool is up, with a hint", async () => {
    const { App } = await import("../app");
    const user = userEvent.setup();
    render(<App />);
    expect(screen.queryByTestId("crop-line-color")).toBeNull();
    await user.click(screen.getByTestId("btn-tool-crop"));
    const swatch = screen.getByTestId("crop-line-color");
    expect(screen.getByTestId("viewer-subbar")).toContainElement(swatch);
    expect(swatch.getAttribute("data-hint")).toMatch(/^Crop line color/);
  });
});
