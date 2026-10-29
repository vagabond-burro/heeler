// The crop tool's lines in the one line color every overlay reads: the
// box, its guides, handles and ring, and the straighten line, set by
// hand or opposed to the photograph; and the crop bar's swatch, which
// opens the LINES row in a popover and writes the same setting Grid
// Warp's LINES row does.

import { useReducer } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { initialState, NEUTRAL_NODES, NEUTRAL_WIRES } from "../data";
import { autoLineColor, lineColorCss } from "../gridwarp";
import { cropNode, reduce, type Command, type LineColorUi, type State } from "../state";
import { LineColorSwatch, LinesRow } from "../ui/linecolor";
import { autoCache, resolveLineColor } from "../ui/linecolorparts";
import { CropOverlay, StraightenOverlay } from "../ui/overlays";

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
  it("draw in a hue and luma set by hand, the outline under the handles kept", () => {
    cropLines({ hue: 120, luma: 40 });
    expectCropLinesIn({ hue: 120, luma: 40, sat: 0.75 });
    expect(screen.getByTestId("crop-handle-tl").style.boxShadow).toBe("0 0 0 1px rgba(0,0,0,.55)");
  });

  it("draw on Auto in the color opposed to the photograph's own average", async () => {
    // A bright, cool sky: the lines go dark and warm.
    const url = "frame://croplinecolor-sky";
    const sky = autoLineColor({ r: 0.6, g: 0.8, b: 0.98 });
    autoCache.set(url, Promise.resolve(sky));
    cropLines({ hue: null, luma: null }, url);
    await act(async () => {});
    expect(sky.luma).toBe(12);
    expectCropLinesIn(sky);
  });

  it("include the straighten line and its readout", () => {
    const s = base();
    render(<StraightenOverlay node={cropNode(s)} dispatch={() => {}} lineColor={{ hue: 300, luma: 70 }} />);
    const overlay = screen.getByTestId("straighten-overlay");
    overlay.getBoundingClientRect = () => ({ left: 0, top: 0, right: 400, bottom: 300, width: 400, height: 300, x: 0, y: 0, toJSON() {} }) as DOMRect;
    fireEvent.mouseDown(overlay, { button: 0, buttons: 1, clientX: 50, clientY: 100 });
    fireEvent.mouseMove(window, { buttons: 1, clientX: 300, clientY: 110 });
    const css = lineColorCss(300, 70, 0.75, 0.95);
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
function mountBoth(lineColor: LineColorUi = { hue: null, luma: null }) {
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
        <LineColorSwatch state={state} lineColor={state.lineColor} dispatch={send} previewUrl={null} prefix="crop" subject="crop lines" name="Crop line color" />
        <LinesRow lineColor={state.lineColor} dispatch={send} previewUrl={null} prefix="gridwarp" subject="grid lines" />
      </div>
    );
  }
  render(<Harness />);
  return view;
}

describe("the crop bar's line color swatch", () => {
  it("shows the color in use, with a hint that names it", () => {
    mountBoth({ hue: 200, luma: 30 });
    const swatch = screen.getByTestId("crop-line-color");
    expect(screen.getByTestId("crop-line-color-chip").style.background).toBe(asDrawn(lineColorCss(200, 30, 0.75, 1)));
    expect(swatch.getAttribute("data-hint")).toMatch(/^Crop line color: hue 200, luma 30\./);
    cleanup();
    mountBoth();
    const auto = resolveLineColor({ hue: null, luma: null }, autoLineColor(null));
    expect(screen.getByTestId("crop-line-color-chip").style.background).toBe(asDrawn(lineColorCss(auto.hue, auto.luma, auto.sat, 1)));
    expect(screen.getByTestId("crop-line-color").getAttribute("data-hint")).toMatch(/^Crop line color: Auto\./);
  });

  it("holds the thickness under the color, a quarter larger than a section's rows", () => {
    // "The font size of the line properties is too small, scale by 1.25x
    // and also missing the line thickness controls."
    const view = mountBoth();
    fireEvent.click(screen.getByTestId("crop-line-color"));
    const panel = screen.getByTestId("crop-line-color-panel");
    expect((panel.firstElementChild as HTMLElement).style.zoom).toBe("1.25");
    expect(panel.querySelector("[data-testid=crop-lines]")).not.toBeNull();
    expect(panel.querySelector("[data-testid=crop-line-width-row]")).not.toBeNull();
    // Hue, Luma and Thickness share one grid: one name column, one track
    // column, one number column, so their tracks line up.
    const grid = screen.getByTestId("crop-lines");
    expect(grid.style.display).toBe("grid");
    for (const id of ["crop-line-hue", "crop-line-luma", "crop-line-width-track"]) {
      expect(screen.getByTestId(id).closest(".strack-flex")?.parentElement).toBe(grid);
    }
    // The reset sits under Auto, an icon, and grays while the
    // preference is already in use.
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
    screen.getByTestId("crop-line-hue").focus();
    fireEvent.keyDown(screen.getByTestId("crop-line-hue"), { key: "Escape" });
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

  it("is reachable from the keyboard, and its hue, luma and Auto write the shared line color", async () => {
    const view = mountBoth();
    const user = userEvent.setup();
    await user.tab();
    expect(document.activeElement).toBe(screen.getByTestId("crop-line-color"));
    await user.keyboard("{Enter}");
    expect(screen.getByTestId("crop-line-color-panel")).toBeInTheDocument();
    // Opening it takes focus to Hue, and Tab goes on to Luma.
    expect(document.activeElement).toBe(screen.getByTestId("crop-line-hue"));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByTestId("crop-line-luma"));
    fireEvent.keyDown(screen.getByTestId("crop-line-hue"), { key: "ArrowRight" });
    fireEvent.keyDown(screen.getByTestId("crop-line-luma"), { key: "Home" });
    expect(view.sent.filter((c) => c.type === "set_line_color")).toEqual([
      { type: "set_line_color", hue: 1 },
      { type: "set_line_color", luma: 0 },
    ]);
    expect(view.state.lineColor).toEqual({ hue: 1, luma: 0 });
    fireEvent.click(screen.getByTestId("crop-line-auto"));
    expect(view.sent[view.sent.length - 1]).toEqual({ type: "set_line_color", hue: null, luma: null });
    expect(view.state.lineColor).toEqual({ hue: null, luma: null });
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
    fireEvent.click(screen.getByTestId("crop-line-color"));
    fireEvent.keyDown(screen.getByTestId("crop-line-hue"), { key: "End" });
    expect(screen.getByTestId("gridwarp-line-hue-value").textContent).toBe("0");
    fireEvent.keyDown(screen.getByTestId("crop-line-luma"), { key: "Home" });
    expect(screen.getByTestId("gridwarp-line-luma-value").textContent).toBe("0");
    // Grid Warp's row sets it; the crop's swatch shows it.
    fireEvent.keyDown(screen.getByTestId("gridwarp-line-hue"), { key: "ArrowRight" });
    expect(view.state.lineColor.hue).toBe(1);
    expect(screen.getByTestId("crop-line-color").getAttribute("data-hint")).toMatch(/^Crop line color: hue 1, luma 0\./);
    expect(screen.getByTestId("crop-line-hue-value").textContent).toBe("1");
    fireEvent.click(screen.getByTestId("gridwarp-line-auto"));
    expect(screen.getByTestId("crop-line-color").getAttribute("data-hint")).toMatch(/^Crop line color: Auto\./);
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
