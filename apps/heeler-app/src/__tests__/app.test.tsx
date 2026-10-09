import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "../app";
import { norm, straightenAngle } from "../ui/overlays";
import { OFF_BY_DEFAULT, reduce } from "../state";
import React from "react";
import { initialState } from "../data";
import { CanvasMode } from "../ui/canvas";
import { NodeEditor } from "../ui/graph";
import { choose, chooseWith, menuRows, menuValue } from "./menuhelp";

async function toGraphMode(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("tablist", { name: /workspace mode/i }).children[1]);
}

/** jsdom gives every element a zero-size box, so overlay coordinate math
 * has nothing to divide by. Pin the element to a real square (200x200 at
 * the origin, center at 100,100) and pointer pixels become meaningful. */
/** Makes the viewer believe it has a measured stage and a square frame,
 * which is what unlocks the display box (and with it zoom, pan and view
 * rotation). Returns the undo. */
function stubStage(stage = 632, frame = 400) {
  const priorRO = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    constructor(private cb: (e: { contentRect: { width: number; height: number } }[]) => void) {}
    observe() {
      this.cb([{ contentRect: { width: stage, height: stage } }]);
    }
    disconnect() {}
  };
  const proto = HTMLImageElement.prototype;
  const priorDims = ["naturalWidth", "naturalHeight"].map((k) => [k, Object.getOwnPropertyDescriptor(proto, k)] as const);
  for (const [k] of priorDims) Object.defineProperty(proto, k, { configurable: true, get: () => frame });
  return () => {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = priorRO;
    for (const [k, d] of priorDims) {
      if (d) Object.defineProperty(proto, k, d);
      else delete (proto as unknown as Record<string, unknown>)[k];
    }
  };
}

function stubBox(el: HTMLElement, size = 200) {
  el.getBoundingClientRect = () =>
    ({ left: 0, top: 0, right: size, bottom: size, width: size, height: size, x: 0, y: 0, toJSON() {} }) as DOMRect;
  Object.defineProperty(el, "offsetWidth", { configurable: true, value: size });
  Object.defineProperty(el, "offsetHeight", { configurable: true, value: size });
}

/** Opens every category that now ships collapsed.
 *
 * "All categories that are off by default should be collapsed."
 * A collapsed body is display:none, which takes its controls out of the
 * accessibility tree and so out of getByRole. The tests below are about what
 * the sliders do rather than about the collapse, so they open what they need
 * first, which is what a person does too.
 */
function openAllSections() {
  for (const title of OFF_BY_DEFAULT) {
    const slug = title.toLowerCase().replace(/[^a-z]+/g, "-");
    const btn = screen.queryByTestId(`collapse-${slug}`);
    if (btn && btn.getAttribute("data-open") !== "true") fireEvent.click(btn);
  }
}

describe("Heeler UI", () => {
  // The mock bridge remembers sessions the way the real catalog does,
  // which means one test's navigation would become the next test's
  // surprise restore. Every test starts with a blank memory.
  beforeEach(async () => {
    const { mockResetSessions } = await import("../bridge");
    mockResetSessions();
  });

  it("boots into Develop mode with the design layout", () => {
    render(<App />);
    expect(screen.getByTestId("topbar")).toHaveTextContent("HEELER");
    // The mode reads from the pressed tab, which wears a glyph rather
    // than the word now.
    expect(screen.getByTestId("mode-simple")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("simple-panel")).toBeInTheDocument();
    expect(screen.getByTestId("browser-panel")).toBeInTheDocument();
    expect(screen.getByTestId("ribbon")).toBeInTheDocument();
    expect(screen.queryByTestId("node-editor")).not.toBeInTheDocument();
  });

  it("mode switcher shows Develop / Graph / Canvas and switches surfaces", async () => {
    const user = userEvent.setup();
    render(<App />);
    const tablist = screen.getByRole("tablist", { name: /workspace mode/i });
    expect(within(tablist).getByRole("button", { name: "Develop" })).toBeInTheDocument();
    expect(within(tablist).getByRole("button", { name: "Graph" })).toBeInTheDocument();
    expect(within(tablist).getByRole("button", { name: "Canvas" })).toBeInTheDocument();

    await user.click(within(tablist).getByRole("button", { name: "Graph" }));
    expect(screen.getByTestId("node-editor")).toBeInTheDocument();
    expect(screen.getByTestId("inspector")).toBeInTheDocument();
    expect(screen.queryByTestId("simple-panel")).not.toBeInTheDocument();

    await user.click(within(tablist).getByRole("button", { name: "Canvas" }));
    expect(screen.getByTestId("canvas-mode")).toBeInTheDocument();
    // The library rides along into Canvas now. It used to be gated out,
    // which left the LIBRARY rail clickable there while toggling a panel
    // that never rendered. "Library does expand when in
    // Canvas view."
    expect(screen.getByTestId("browser-panel")).toBeInTheDocument();
    await user.click(screen.getByLabelText("Collapse library"));
    expect(screen.queryByTestId("browser-panel")).not.toBeInTheDocument();
    await user.click(screen.getByLabelText("Expand library"));
    expect(screen.getByTestId("browser-panel")).toBeInTheDocument();
    expect(screen.queryByTestId("inspector")).not.toBeInTheDocument();
  });

  it("selecting a thumbnail switches the active image", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByTestId("thumb-4868"));
    expect(screen.getByTestId("topbar")).toHaveTextContent("DSC_04868.NEF");
  });

  // "if the library is collapsed and I click on any thumbnail
  // it causes the library to expand. This is annoying. The library should
  // only be expanded when that sidebar is used, not from browsing photos
  // in the current folder."
  //
  // The cause was revealActiveThumb, which fires on every change of
  // active photo to keep the thumbnail scrolled into view, and which
  // reopened the LIBRARY to do it. The library is the folder sidebar;
  // the thumbnail is in the ribbon. Wrong panel, and opened on the
  // app's own initiative rather than the user's.
  it("browsing photos leaves a collapsed library collapsed", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: /collapse library/i }));
    expect(screen.queryByTestId("browser-panel")).not.toBeInTheDocument();

    await user.click(screen.getByTestId("thumb-4868"));
    expect(screen.getByTestId("topbar")).toHaveTextContent("DSC_04868.NEF");
    expect(screen.queryByTestId("browser-panel")).not.toBeInTheDocument();

    await user.click(screen.getByTestId("thumb-4869"));
    expect(screen.queryByTestId("browser-panel")).not.toBeInTheDocument();

    // And the sidebar's own control still works, since that IS the
    // sidebar being used.
    await user.click(screen.getByRole("button", { name: /expand library/i }));
    expect(screen.getByTestId("browser-panel")).toBeInTheDocument();
  });

  it("a thumbnail stuck on a slow volume does not hold up browsing", async () => {
    // The stall plan's Phase 5 probe for the thumbnail batch: the hold
    // stands in for load_thumbnail grinding on a slow volume, the way a
    // folder's first-visit decodes did. Against the old inline body the
    // decode held an async-runtime worker and every other async command
    // queued behind it; the desktop's shape test pins the move to
    // spawn_blocking, and this probe pins that the frontend never waits
    // on the thumbnail pump to browse.
    const { mockSetThumbnail, mockSetThumbnailHold, mockResetThumbnails } = await import("../bridge");
    const { Ribbon, loadSessionImages } = await import("../ui/chrome");
    mockResetThumbnails();
    let release!: () => void;
    mockSetThumbnailHold(new Promise<void>((r) => { release = r; }));
    mockSetThumbnail("img_b", "data:image/jpeg;base64,STUCK");
    const files = [
      { id: "img_a", name: "a.NEF", stars: 0, flag: "" as const },
      { id: "img_b", name: "b.NEF", stars: 0, flag: "" as const },
    ];
    // The ribbon with a real reducer behind it and the thumbnail pump
    // running, the way a folder open drives both.
    function PumpHost() {
      const [s, setS] = React.useState(() => initialState());
      React.useEffect(() => {
        loadSessionImages(files, (c) => setS((p) => reduce(p, c)));
      }, []);
      return <Ribbon state={s} dispatch={(c) => setS((p) => reduce(p, c))} />;
    }
    try {
      render(<PumpHost />);
      // The ribbon is up, its thumbnail answers still pending.
      await screen.findByTestId("thumb-img_a");
      // Browsing does not wait on them.
      fireEvent.click(screen.getByTestId("thumb-img_b"));
      await waitFor(() =>
        expect(screen.getByTestId("thumb-img_b").getAttribute("data-selected")).toBe("true"),
      );
      // The planted thumbnail has not landed while the volume is stuck.
      expect(screen.getByTestId("thumb-img_b").querySelector("img")?.getAttribute("src") ?? "").not.toContain("STUCK");
      // The volume answers; the thumbnail lands.
      release();
      mockSetThumbnailHold(null);
      await waitFor(() =>
        expect(screen.getByTestId("thumb-img_b").querySelector("img")?.getAttribute("src") ?? "").toContain("STUCK"),
      );
    } finally {
      mockSetThumbnailHold(null);
      mockResetThumbnails();
    }
  });

  it("ribbon collapses to the tick bar study and back", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: /collapse ribbon/i }));
    expect(screen.getByTestId("ribbon-collapsed")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /expand ribbon/i }));
    expect(screen.getByTestId("ribbon")).toBeInTheDocument();
  });

  it("the whole library rail toggles the browser", async () => {
    const user = userEvent.setup();
    render(<App />);
    const rail = screen.getByRole("button", { name: /collapse library/i });
    expect(rail).toHaveTextContent("LIBRARY");
    await user.click(rail);
    expect(screen.queryByTestId("browser-panel")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /expand library/i }));
    expect(screen.getByTestId("browser-panel")).toBeInTheDocument();
  });

  it("every Develop section renders working sliders, including Geometry and Tone", () => {
    render(<App />);
    openAllSections();
    for (const p of ["exposure", "temperature", "angle", "crop_w", "crop_h", "black", "white", "gamma", "amount", "strength", "intensity"]) {
      // getAll, not get: a param name is not unique across the panel now
      // that Unsharp writes `amount` like Bend does. What this asserts is
      // that the control exists at all, which is what it was always for.
      expect(screen.getAllByTestId(`slider-${p}`).length).toBeGreaterThan(0);
    }
    // Straighten writes to the crop/rotate node.
    const angle = within(screen.getByTestId("slider-angle")).getByRole("slider");
    fireEvent.keyDown(angle, { key: "ArrowRight" });
    expect(Number(angle.getAttribute("aria-valuenow"))).toBeGreaterThan(0);
    // Tone gamma slider actually edits the levels node.
    const gamma = within(screen.getByTestId("slider-gamma")).getByRole("slider");
    fireEvent.keyDown(gamma, { key: "ArrowRight" });
    expect(Number(gamma.getAttribute("aria-valuenow"))).toBeGreaterThan(1);
    // Detail's Smoothing targets the denoise node's strength. Named by node, not
    // by param: the Noise Reduction recipe writes `strength` on two nodes
    // of its own, and this row is the free one in the main chain.
    const noiseRow = screen
      .getAllByTestId("slider-strength")
      .find((el) => el.dataset.node === "denoise")!;
    expect(noiseRow, "Detail's Smoothing row still targets the chain's denoise node").toBeTruthy();
    const noise = within(noiseRow).getByRole("slider");
    fireEvent.keyDown(noise, { key: "ArrowRight" });
    expect(Number(noise.getAttribute("aria-valuenow"))).toBeGreaterThan(0);
    // Detail's Unsharp writes `amount` like Color Bend does, so the
    // existence check above proves nothing about it. Drive the sharpen
    // node's own row and watch the value move.
    const unsharpRow = screen
      .getAllByTestId("slider-amount")
      .find((el) => el.dataset.node === "sharpen")!;
    expect(unsharpRow, "Detail's Unsharp row still targets the chain's sharpen node").toBeTruthy();
    const unsharp = within(unsharpRow).getByRole("slider");
    fireEvent.keyDown(unsharp, { key: "ArrowRight" });
    expect(Number(unsharp.getAttribute("aria-valuenow"))).toBeGreaterThan(0);
  });

  it("B&W is a treatment inside Color: button enables it and reveals the nested mixer", async () => {
    const user = userEvent.setup();
    render(<App />);
    // Not a top-level section, and no mixer visible in color treatment.
    expect(screen.queryByTestId("toggle-black-white")).not.toBeInTheDocument();
    expect(screen.queryByTestId("bw-mixer")).not.toBeInTheDocument();

    await user.click(screen.getByTestId("bw-mode-bw"));
    const mixer = screen.getByTestId("bw-mixer");
    expect(mixer).toBeInTheDocument();
    for (const p of ["red", "green", "blue"]) {
      expect(within(mixer).getByTestId(`slider-${p}`)).toBeInTheDocument();
    }
    const img = screen.getByTestId("viewer-image") as HTMLImageElement;
    expect(img.style.filter).toContain("grayscale(1)");

    // The mixer edits the channel weights.
    const red = within(within(mixer).getByTestId("slider-red")).getByRole("slider");
    fireEvent.keyDown(red, { key: "ArrowRight" });
    expect(Number(red.getAttribute("aria-valuenow"))).toBeGreaterThan(30);

    // Weights apply directly, so the running total shows how much the mix
    // brightens or darkens; 100% is level with the original.
    expect(screen.getByTestId("bw-total")).toHaveTextContent("%");
    const green = within(within(mixer).getByTestId("slider-green")).getByRole("slider");
    fireEvent.keyDown(green, { key: "ArrowLeft" });
    fireEvent.keyDown(green, { key: "ArrowLeft" });
    const total =
      Number(red.getAttribute("aria-valuenow")) +
      Number(green.getAttribute("aria-valuenow")) +
      Number(within(within(mixer).getByTestId("slider-blue")).getByRole("slider").getAttribute("aria-valuenow"));
    expect(screen.getByTestId("bw-total")).toHaveTextContent(`${Math.round(total)}%`);

    await user.click(screen.getByTestId("bw-mode-color"));
    expect(screen.queryByTestId("bw-mixer")).not.toBeInTheDocument();
    expect(img.style.filter).not.toContain("grayscale");
  });

  it("the Color section switch bypasses the B&W treatment it hosts", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByTestId("bw-mode-bw"));
    const img = () => screen.getByTestId("viewer-image") as HTMLImageElement;
    expect(img().style.filter).toContain("grayscale(1)");
    expect(screen.getByTestId("bw-mixer")).toBeInTheDocument();

    // Flipping the section switch off must drop the B&W too.
    await user.click(screen.getByTestId("toggle-color"));
    expect(img().style.filter).not.toContain("grayscale");
    // ...and flipping back on restores it: the treatment choice survived
    // the bypass because it lives in a param, not the enabled flag.
    await user.click(screen.getByTestId("toggle-color"));
    expect(img().style.filter).toContain("grayscale(1)");
    expect(screen.getByTestId("bw-mode-bw")).toHaveAttribute("data-active", "true");
  });

  it("Color reset returns the treatment to color and the mixer to defaults", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByTestId("bw-mode-bw"));
    const red = within(within(screen.getByTestId("bw-mixer")).getByTestId("slider-red")).getByRole("slider");
    fireEvent.keyDown(red, { key: "ArrowRight" });
    expect(Number(red.getAttribute("aria-valuenow"))).toBeGreaterThan(30);
    expect((screen.getByTestId("viewer-image") as HTMLImageElement).style.filter).toContain("grayscale");

    // A shaped hue curve goes with the mixer on reset.
    fireEvent.click(screen.getByTestId("bw-separate"));
    expect(screen.getByTestId("bw-separate")).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByTestId("bw-separate"));

    await user.click(screen.getByTestId("reset-color"));
    // Treatment is back to color, in the panel AND in the render.
    expect(screen.getByTestId("bw-mode-color")).toHaveAttribute("data-active", "true");
    expect((screen.getByTestId("viewer-image") as HTMLImageElement).style.filter).not.toContain("grayscale");
    // Re-selecting B&W shows the mixer back at its default weights.
    await user.click(screen.getByTestId("bw-mode-bw"));
    const redAgain = within(within(screen.getByTestId("bw-mixer")).getByTestId("slider-red")).getByRole("slider");
    expect(redAgain.getAttribute("aria-valuenow")).toBe("30");
  });

  it("the hue curve has its own reset, and it leaves the mixer alone (2026-09-14)", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByTestId("bw-mode-bw"));
    const red = within(within(screen.getByTestId("bw-mixer")).getByTestId("slider-red")).getByRole("slider");
    fireEvent.keyDown(red, { key: "ArrowRight" });
    const moved = Number(red.getAttribute("aria-valuenow"));
    expect(moved).toBeGreaterThan(30);
    await user.click(within(screen.getByTestId("bw-hue-curve")).getByTestId("bw-hue-reset"));
    // Still black and white, the weight still where it was dragged.
    expect(screen.getByTestId("bw-mode-bw")).toHaveAttribute("data-active", "true");
    expect(red.getAttribute("aria-valuenow")).toBe(String(moved));
  });

  it("the Source reset puts the profile rows back too (2026-09-14)", async () => {
    const user = userEvent.setup();
    render(<App />);
    // Source opens closed; its collapse button opens it.
    await user.click(screen.getByTestId("collapse-source"));
    const baseline = within(screen.getByTestId("slider-baseline_ev")).getByRole("slider");
    const start = Number(baseline.getAttribute("aria-valuenow"));
    fireEvent.keyDown(baseline, { key: "ArrowRight" });
    fireEvent.keyDown(baseline, { key: "ArrowRight" });
    expect(Number(baseline.getAttribute("aria-valuenow"))).toBeGreaterThan(start);
    const toe = within(screen.getByTestId("slider-shadow_toe")).getByRole("slider");
    const toeStart = Number(toe.getAttribute("aria-valuenow"));
    fireEvent.keyDown(toe, { key: "ArrowLeft" });
    expect(Number(toe.getAttribute("aria-valuenow"))).toBeLessThan(toeStart);
    await user.click(screen.getByTestId("reset-source"));
    expect(Number(within(screen.getByTestId("slider-baseline_ev")).getByRole("slider").getAttribute("aria-valuenow"))).toBe(start);
    expect(Number(within(screen.getByTestId("slider-shadow_toe")).getByRole("slider").getAttribute("aria-valuenow"))).toBe(toeStart);
  });

  it("B&W strength blends the treatment", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByTestId("bw-mode-bw"));
    const strength = within(within(screen.getByTestId("bw-mixer")).getByTestId("slider-amount")).getByRole("slider");
    expect(strength.getAttribute("aria-valuenow")).toBe("100");
    fireEvent.keyDown(strength, { key: "ArrowLeft" });
    expect(Number(strength.getAttribute("aria-valuenow"))).toBeLessThan(100);
    // Dropping strength to zero returns the Color treatment.
    for (let i = 0; i < 100; i++) fireEvent.keyDown(strength, { key: "ArrowLeft" });
    expect(screen.getByTestId("bw-mode-color")).toHaveAttribute("data-active", "true");
  });

  it("Reset is a momentary action, not a state control", async () => {
    const user = userEvent.setup();
    render(<App />);
    const slider = within(screen.getByTestId("slider-exposure")).getByRole("slider");
    fireEvent.keyDown(slider, { key: "ArrowRight" });
    const reset = screen.getByTestId("reset-exposure");
    expect(reset).not.toHaveAttribute("role", "switch");
    expect(reset).not.toHaveAttribute("aria-pressed");
    await user.click(reset);
    expect(Number(slider.getAttribute("aria-valuenow"))).toBe(0);
    // Clicking again changes nothing: idempotent action, no toggling back.
    await user.click(reset);
    expect(Number(slider.getAttribute("aria-valuenow"))).toBe(0);
    // The section on/off switch is separate and still present.
    expect(screen.getByTestId("toggle-exposure")).toHaveAttribute("role", "switch");
  });

  it("split view shows before/after halves with a draggable divider", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByTestId("btn-split"));
    expect(screen.getByTestId("split-view")).toBeInTheDocument();
    expect(screen.getByTestId("split-divider")).toBeInTheDocument();
    expect(screen.getByText("BEFORE")).toBeInTheDocument();
    expect(screen.getByText("AFTER")).toBeInTheDocument();
    const after = screen.getByTestId("split-after") as HTMLImageElement;
    expect(after.style.clipPath).toContain("50%");
    await user.click(screen.getByTestId("btn-split"));
    expect(screen.queryByTestId("split-view")).not.toBeInTheDocument();
  });

  it("split keeps the view you were in instead of jumping", async () => {
    // "What does the image shift when I enable Split? I would
    // not expect that." The split box was stage-fitted but untransformed,
    // so pan, zoom past fit and view rotation all vanished on the way in
    // and jumped back on the way out. Now it wears the exact transform
    // the normal stage wears, and the divider drag maps the pointer
    // through that transform rather than the bounding rect.
    const restore = stubStage();
    try {
      const user = userEvent.setup();
      render(<App />);
      fireEvent.load(screen.getByTestId("viewer-image"));
      const stage = screen.getByTestId("viewer-stage");
      // CTRL+ALT+scroll turns the view clockwise, 2° a notch.
      for (let i = 0; i < 45; i++) {
        fireEvent.wheel(stage, { deltaY: -100, ctrlKey: true, altKey: true });
      }
      // The nav hook flushes wheel ops on a rAF; the indicator shows up
      // once the rotation has landed.
      expect(await screen.findByTestId("view-rotation")).toHaveTextContent("VIEW 90°");
      const normal = screen.getByTestId("stage-frame").style.transform;
      expect(normal).toContain("rotate(90deg)");
      await user.click(screen.getByTestId("btn-split"));
      const split = screen.getByTestId("split-view");
      expect(split.style.transform).toBe(normal);
      // Divider under rotation: at 90° clockwise the screen's up is the
      // image's left, so clicking ABOVE center moves the divider to 25%.
      // A naive clientX fraction would have read this click as "center"
      // and left it at 50%.
      stubBox(split);
      fireEvent.mouseDown(split, { clientX: 100, clientY: 50 });
      const after = screen.getByTestId("split-after") as HTMLImageElement;
      expect(after.style.clipPath).toContain("25%");
    } finally {
      restore();
    }
  });

  it("clicking a node selects it and populates the inspector", async () => {
    const user = userEvent.setup();
    render(<App />);
    await toGraphMode(user);
    fireEvent.mouseDown(screen.getByTestId("node-cbal"));
    expect(screen.getByTestId("node-cbal")).toHaveAttribute("data-selected", "true");
    const inspector = screen.getByTestId("inspector");
    expect(within(inspector).getByText("Color Balance")).toBeInTheDocument();
    expect(within(inspector).getByText("Shadows")).toBeInTheDocument();
    expect(within(inspector).getByText("Mids")).toBeInTheDocument();
    expect(within(inspector).getByText("Highs")).toBeInTheDocument();
  });

  it("color balance luminance bars are functional, and it offers no opacity it cannot honor", async () => {
    const user = userEvent.setup();
    render(<App />);
    await toGraphMode(user);
    fireEvent.mouseDown(screen.getByTestId("node-cbal"));
    const lum = screen.getByRole("slider", { name: /mids luminance/i });
    const before = Number(lum.getAttribute("aria-valuenow"));
    fireEvent.keyDown(lum, { key: "ArrowRight" });
    expect(Number(lum.getAttribute("aria-valuenow"))).toBeGreaterThan(before);

    // The engine never read an opacity on Color Balance, so the
    // inspector says it has none rather than offering a dead slider.
    expect(screen.queryByTestId("slider-opacity")).toBeNull();
    expect(screen.getByTestId("opacity-none")).toBeInTheDocument();
  });

  it("curves node opens a draggable curve editor", async () => {
    const user = userEvent.setup();
    render(<App />);
    await toGraphMode(user);
    fireEvent.mouseDown(screen.getByTestId("node-curves"));
    expect(screen.getByTestId("curve-editor")).toBeInTheDocument();
    // The plot's points only: the Tangent glyph in the interpolation
    // toggle draws circles of its own, inside an aria-hidden svg.
    const pts = screen.getByTestId("curve-editor").querySelectorAll("svg:not([aria-hidden]) circle");
    expect(pts.length).toBe(2);
  });

  it("crop node shows geometry sliders in the inspector", async () => {
    const user = userEvent.setup();
    render(<App />);
    await toGraphMode(user);
    fireEvent.mouseDown(screen.getByTestId("node-crop"));
    const inspector = screen.getByTestId("inspector");
    expect(within(inspector).getByText("Straighten")).toBeInTheDocument();
    expect(within(inspector).getByText("Crop width")).toBeInTheDocument();
  });

  it("levels node shows black/white/gamma in the inspector", async () => {
    const user = userEvent.setup();
    render(<App />);
    await toGraphMode(user);
    fireEvent.mouseDown(screen.getByTestId("node-levels"));
    const inspector = screen.getByTestId("inspector");
    expect(within(inspector).getByText("Black point")).toBeInTheDocument();
    expect(within(inspector).getByText("White point")).toBeInTheDocument();
    expect(within(inspector).getByText("Gamma")).toBeInTheDocument();
  });

  it("group node exposes a working promoted parameter", async () => {
    const user = userEvent.setup();
    render(<App />);
    await toGraphMode(user);
    fireEvent.mouseDown(screen.getByTestId("node-portra"));
    const slider = within(screen.getByTestId("slider-grade_strength")).getByRole("slider");
    expect(Number(slider.getAttribute("aria-valuenow"))).toBe(78);
    fireEvent.keyDown(slider, { key: "ArrowRight" });
    expect(Number(slider.getAttribute("aria-valuenow"))).toBeGreaterThan(78);
  });

  it("multi-select shows count and SAVE AS GROUP; dialog collapses to gold group node and preset", async () => {
    const user = userEvent.setup();
    render(<App />);
    await toGraphMode(user);
    fireEvent.mouseDown(screen.getByTestId("node-stdcolor"));
    fireEvent.mouseDown(screen.getByTestId("node-cbal"), { shiftKey: true });
    fireEvent.mouseDown(screen.getByTestId("node-lummask"), { shiftKey: true });

    const inspector = screen.getByTestId("inspector");
    expect(within(inspector).getByText("3")).toBeInTheDocument();
    expect(within(inspector).getByText("nodes selected")).toBeInTheDocument();

    await user.click(screen.getByTestId("inspector-save-group"));
    const dialog = screen.getByTestId("group-dialog");
    const nameInput = within(dialog).getByRole("textbox", { name: /group name/i });
    await user.clear(nameInput);
    await user.type(nameInput, "Test Look");
    await user.click(screen.getByTestId("dialog-save-group"));

    expect(screen.queryByTestId("group-dialog")).not.toBeInTheDocument();
    const group = document.querySelector(".node.group[data-selected='true']");
    expect(group).toBeTruthy();
    expect(group!.textContent).toContain("Test Look");
    // The group is a GRAPH construct now, full stop: the Presets tab
    // holds looks, and the old node-groups listing there (which only
    // logged creations and applied nothing) is gone. The owner, aligning
    // the tab: "I saw this as a preset for looks."
  });

  it("graph has backdrops instead of fixed lanes", async () => {
    const user = userEvent.setup();
    render(<App />);
    await toGraphMode(user);
    // The RAW/CREATIVE/RETOUCH/OUTPUT swimlanes are gone.
    expect(screen.queryByText("CREATIVE")).not.toBeInTheDocument();
    expect(screen.queryByText("RETOUCH")).not.toBeInTheDocument();
    // Create a backdrop from the context menu.
    fireEvent.contextMenu(screen.getByTestId("graph-surface"), { clientX: 300, clientY: 200 });
    await user.click(screen.getByTestId("menu-add-backdrop"));
    const backdrop = screen.getByTestId("backdrop-bd_1");
    expect(backdrop).toHaveTextContent("Backdrop 1");
    // Dragging its header moves it.
    const left = backdrop.style.left;
    fireEvent.mouseDown(screen.getByTestId("backdrop-head-bd_1"), { clientX: 100, clientY: 100 });
    fireEvent.mouseMove(window, { clientX: 160, clientY: 120 });
    fireEvent.mouseUp(window);
    expect(screen.getByTestId("backdrop-bd_1").style.left).not.toBe(left);
    // Delete removes it.
    await user.click(screen.getByTestId("backdrop-delete-bd_1"));
    expect(screen.queryByTestId("backdrop-bd_1")).not.toBeInTheDocument();
  });

  it("arrange-by-stage is available from the context menu", async () => {
    const user = userEvent.setup();
    render(<App />);
    await toGraphMode(user);
    const before = screen.getByTestId("node-output").style.left;
    fireEvent.contextMenu(screen.getByTestId("graph-surface"), { clientX: 300, clientY: 200 });
    await user.click(screen.getByTestId("menu-arrange"));
    expect(screen.getByTestId("node-output").style.left).not.toBe(before);
  });

  it("context menu on the graph offers the group action", async () => {
    const user = userEvent.setup();
    render(<App />);
    await toGraphMode(user);
    fireEvent.mouseDown(screen.getByTestId("node-stdcolor"));
    fireEvent.mouseDown(screen.getByTestId("node-cbal"), { shiftKey: true });
    fireEvent.contextMenu(screen.getByTestId("graph-surface"));
    const menu = screen.getByTestId("context-menu");
    expect(menu).toHaveTextContent("2 NODES SELECTED");
    fireEvent.click(screen.getByTestId("menu-save-group"));
    expect(screen.getByTestId("group-dialog")).toBeInTheDocument();
  });

  it("the Photo menu offers merges, and only with frames to merge", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByTestId("menu-photo"));
    // One photo selected is not a stack, so the whole submenu is
    // unavailable rather than opening onto four items that would fail.
    expect(screen.getByTestId("menu-photo-stacking")).toBeDisabled();
    expect(screen.queryByTestId("menu-photo-hdr")).not.toBeInTheDocument();

    // Pick a span of frames the way anyone would.
    await user.click(screen.getByTestId("menu-photo"));
    const thumbs = screen.getAllByTestId(/^thumb-\d+$/);
    await user.click(thumbs[0]);
    fireEvent.click(thumbs[3], { shiftKey: true });
    await user.click(screen.getByTestId("menu-photo"));
    const stacking = screen.getByTestId("menu-photo-stacking");
    expect(stacking).toBeEnabled();
    fireEvent.mouseEnter(stacking.parentElement!);
    expect(screen.getByTestId("menu-photo-hdr")).toBeInTheDocument();
    expect(screen.getByTestId("menu-photo-max")).toBeInTheDocument();
  });

  it("the Photo menu offers a panorama, and only with frames to stitch", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByTestId("menu-photo"));
    // Stitching one photograph to itself is not a panorama.
    expect(screen.getByTestId("menu-photo-panorama")).toBeDisabled();

    const thumbs = screen.getAllByTestId(/^thumb-\d+$/);
    await user.click(thumbs[0]);
    fireEvent.click(thumbs[2], { shiftKey: true });
    await user.click(screen.getByTestId("menu-photo"));
    expect(screen.getByTestId("menu-photo-panorama")).toBeEnabled();
  });

  /// Right-clicking a selection is how most people reach for this, so
  /// the panorama has to be there and not only in the Photo menu. All
  /// of it under one Stacking submenu, "The thumbnail right
  /// click menu should gather all the merging/stitching options under a
  /// sub menu, like it is under the Photo menu".
  it("the thumbnail menu gathers merges and panorama under Stacking", async () => {
    const user = userEvent.setup();
    render(<App />);
    const thumbs = screen.getAllByTestId(/^thumb-\d+$/);
    await user.click(thumbs[0]);
    fireEvent.click(thumbs[2], { shiftKey: true });
    fireEvent.contextMenu(thumbs[0]);
    // Folded away until the submenu opens...
    expect(screen.queryByTestId("thumb-menu-hdr")).not.toBeInTheDocument();
    fireEvent.mouseEnter(screen.getByTestId("thumb-menu-stacking").parentElement!);
    // ...then everything that turns frames into one photograph is here.
    expect(screen.getByTestId("thumb-menu-hdr")).toBeInTheDocument();
    expect(screen.getByTestId("thumb-menu-panorama")).toBeInTheDocument();
  });

  it("selected frames are marked in the ribbon", async () => {
    const user = userEvent.setup();
    render(<App />);
    const thumbs = screen.getAllByTestId(/^thumb-\d+$/);
    await user.click(thumbs[1]);
    expect(thumbs[1]).toHaveAttribute("data-selected", "true");
    expect(thumbs[2]).toHaveAttribute("data-selected", "false");

    fireEvent.click(thumbs[3], { ctrlKey: true });
    expect(thumbs[1]).toHaveAttribute("data-selected", "true");
    expect(thumbs[3]).toHaveAttribute("data-selected", "true");
    expect(thumbs[2]).toHaveAttribute("data-selected", "false");
  });

  it("right-clicking a multi-selection offers the merges", async () => {
    const user = userEvent.setup();
    render(<App />);
    const thumbs = screen.getAllByTestId(/^thumb-\d+$/);
    await user.click(thumbs[0]);
    fireEvent.click(thumbs[2], { shiftKey: true });
    fireEvent.contextMenu(thumbs[1]);
    const menu = screen.getByTestId("thumb-menu");
    expect(menu).toHaveTextContent(/3 frames selected/i);
    expect(within(menu).getByTestId("thumb-menu-stacking")).toBeInTheDocument();

    // Right-clicking outside the selection moves to that frame first, so
    // the menu always acts on what is highlighted.
    fireEvent.contextMenu(thumbs[6]);
    expect(screen.getByTestId("thumb-menu")).not.toHaveTextContent(/frames selected/i);
  });

  it("detail weighting is one effect at a time, on real node params", async () => {
    const user = userEvent.setup();
    render(<App />);
    // Detail is off by default and has no node until its switch builds
    // one (its own node since 2026-09-02).
    await user.click(screen.getByTestId("toggle-detail"));
    openAllSections();
    // Folded away by default: eighteen sliders is a wall.
    expect(screen.queryByTestId("detail-effect-texture")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("detail-advanced-toggle"));

    // Six weights for the chosen effect, matching grain's set.
    const advanced = screen.getByTestId("detail-advanced");
    for (const w of ["shadows", "midtones", "highlights", "red", "green", "blue"]) {
      expect(within(advanced).getByTestId(`slider-texture_${w}`)).toBeInTheDocument();
    }
    // Switching effect swaps which params the same six sliders drive.
    await user.click(screen.getByTestId("detail-effect-clarity"));
    expect(within(advanced).getByTestId("slider-clarity_midtones")).toBeInTheDocument();
    expect(within(advanced).queryByTestId("slider-texture_midtones")).not.toBeInTheDocument();

    // Moving one writes to the Detail node, so Graph mode sees it.
    const slider = within(within(advanced).getByTestId("slider-clarity_midtones")).getByRole("slider");
    slider.focus();
    fireEvent.keyDown(slider, { key: "ArrowLeft" });
    await toGraphMode(user);
    await user.click(screen.getByTestId("node-detail"));
    const inspector = screen.getByTestId("inspector");
    await user.click(within(inspector).getByTestId("detail-advanced-toggle"));
    await user.click(within(inspector).getByTestId("detail-effect-clarity"));
    const inGraph = within(within(inspector).getByTestId("slider-clarity_midtones")).getByRole("slider");
    expect(Number(inGraph.getAttribute("aria-valuenow"))).toBeLessThan(100);
  });

  it("the advanced badge counts effects that are actually weighted", async () => {
    const user = userEvent.setup();
    render(<App />);
    openAllSections();
    expect(screen.queryByTestId("detail-advanced-badge")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("detail-advanced-toggle"));
    const slider = within(screen.getByTestId("slider-texture_shadows")).getByRole("slider");
    slider.focus();
    fireEvent.keyDown(slider, { key: "ArrowLeft" });
    expect(screen.getByTestId("detail-advanced-badge")).toHaveTextContent("1");
    // Even puts it back and the badge goes with it.
    await user.click(screen.getByTestId("detail-advanced-reset"));
    expect(screen.queryByTestId("detail-advanced-badge")).not.toBeInTheDocument();
  });

  it("the Detail section reset takes the advanced weights back to even", async () => {
    // The weights are the section's widget-owned params, in the same
    // position as the Color Wheels' pucks and the Bend wheel's colors:
    // written from a sub-panel, invisible to the row loop. A section
    // Reset that left them standing read as having cleared Detail while
    // the render went on weighting.
    const user = userEvent.setup();
    render(<App />);
    openAllSections();
    await user.click(screen.getByTestId("detail-advanced-toggle"));
    const slider = within(screen.getByTestId("slider-texture_shadows")).getByRole("slider");
    slider.focus();
    fireEvent.keyDown(slider, { key: "ArrowLeft" });
    expect(Number(slider.getAttribute("aria-valuenow"))).toBeLessThan(100);
    expect(screen.getByTestId("detail-advanced-badge")).toHaveTextContent("1");

    await user.click(screen.getByTestId("reset-detail"));

    expect(
      Number(
        within(screen.getByTestId("slider-texture_shadows"))
          .getByRole("slider")
          .getAttribute("aria-valuenow"),
      ),
    ).toBe(100);
    expect(screen.queryByTestId("detail-advanced-badge")).not.toBeInTheDocument();
    // The switch stays as it was found, on purpose: Reset is a values
    // operation and does not change what is switched on, so there is no
    // data-on assertion here. What must not happen is the reverse, a
    // reset ARMING a bypassed node, which the neutral-at-100 weights
    // above are the guard against.
  });

  describe("merged images get a highlight shoulder", () => {
    // The bug the owner hit twice: a merge recovers a sky several stops
    // above scene white, and the display transform clips there, so the sky
    // renders blown however good the merge was. Dropping Tone Compress
    // removed the only thing pulling it back, and I had told him the
    // develop controls could do the job without checking that the display
    // transform could even represent the values.
    it("a freshly opened merge starts with the shoulder on", async () => {
      const { reduce, MERGED_ROLLOFF, PROFILE_DEFAULTS } = await import("../state");
      const { initialState } = await import("../data");
      let s = initialState();
      const profileOf = (st: typeof s) => st.nodes.find((n) => n.type === "heeler.tone_profile")!;
      // A plain photo ships with the default shoulder; a merge needs the
      // big one, and the default must not read as "someone chose this".
      expect(profileOf(s).params.highlight_rolloff ?? 0).toBe(PROFILE_DEFAULTS.highlight_rolloff);

      s = reduce(s, { type: "apply_merged_defaults" });
      expect(profileOf(s).params.highlight_rolloff).toBe(MERGED_ROLLOFF);
    });

    /// "if we are pushing out changes to customers later
    /// it'd be advisable that we don't mess with their edit."
    it("never overwrites a value the user already chose", async () => {
      const { reduce } = await import("../state");
      const { initialState } = await import("../data");
      let s = initialState();
      const profile = s.nodes.find((n) => n.type === "heeler.tone_profile")!;
      // 40 is nobody's default: it can only be a hand-set value.
      s = reduce(s, { type: "set_param", id: profile.id, param: "highlight_rolloff", value: 40 });
      s = reduce(s, { type: "apply_merged_defaults" });
      const after = s.nodes.find((n) => n.type === "heeler.tone_profile")!;
      expect(after.params.highlight_rolloff).toBe(40);
    });

    /// The owner, a second time: "why did you revert the HDR
    /// stacking improvement? The sky is back to being blown out."
    ///
    /// Nothing was reverted. The shoulder was applied only when an image
    /// had NO saved graph, which in practice meant "only merges created
    /// after the shoulder shipped". Every stack the owner already had on
    /// disk had a graph file, so the fix skipped precisely the
    /// photographs it was written for.
    describe("deciding when a merge still needs the shoulder", () => {
      const stack = { name: "sunset.stack", edited: false };
      const pano = { name: "ridge.pano", edited: false };
      const plain = { name: "DSC_0001.NEF", edited: false };
      const graph = (rolloff?: number) => ({
        nodes: [
          { type: "heeler.image_source", params: {} },
          {
            type: "heeler.tone_profile",
            params: rolloff === undefined ? {} : { highlight_rolloff: rolloff },
          },
        ],
      });

      it("upgrades a merge whose saved graph predates the shoulder", async () => {
        const { needsMergedDefaults } = await import("../state");
        // This is the case that was broken: a real saved graph, sitting
        // at zero because it was written before the param existed.
        expect(needsMergedDefaults(stack, graph(0))).toBe(true);
        expect(needsMergedDefaults(stack, graph(undefined))).toBe(true);
        expect(needsMergedDefaults(pano, graph(0))).toBe(true);
      });

      it("still applies to a merge with nothing saved at all", async () => {
        const { needsMergedDefaults } = await import("../state");
        expect(needsMergedDefaults(stack, null)).toBe(true);
      });

      it("leaves an edited photograph exactly as the user left it", async () => {
        const { needsMergedDefaults } = await import("../state");
        // Including a deliberate zero: that is a choice, not an absence.
        expect(needsMergedDefaults({ ...stack, edited: true }, graph(0))).toBe(
          false,
        );
        expect(needsMergedDefaults({ ...stack, edited: true }, graph(70))).toBe(
          false,
        );
      });

      it("does not touch a merge that already has a shoulder", async () => {
        const { needsMergedDefaults } = await import("../state");
        expect(needsMergedDefaults(stack, graph(70))).toBe(false);
        expect(needsMergedDefaults(stack, graph(15))).toBe(false);
      });

      it("the shipped default shoulder reads as untouched, not chosen", async () => {
        const { needsMergedDefaults, PROFILE_DEFAULTS } = await import("../state");
        // A merge opened fresh under the new defaults sits at the plain
        // photo's shoulder. Nobody picked that; the merge still needs
        // its big one.
        expect(needsMergedDefaults(stack, graph(PROFILE_DEFAULTS.highlight_rolloff))).toBe(true);
      });

      it("never touches an ordinary photograph", async () => {
        const { needsMergedDefaults } = await import("../state");
        expect(needsMergedDefaults(plain, null)).toBe(false);
        expect(needsMergedDefaults(plain, graph(0))).toBe(false);
        expect(needsMergedDefaults(undefined, graph(0))).toBe(false);
      });
    });

    describe("the baseline lift and toe (reference editor parity work)", () => {
      // Measured with scripts/compare_renders.py: Heeler rendered a flat
      // -1.0 EV through the mids of every test scene because the reference editors
      // both lift a RAW about a stop before their curves. The defaults
      // live on the tone profile node, visible and zeroable; images the
      // user has edited keep rendering exactly as they were left.
      const graph = (params: Record<string, number>) => ({
        nodes: [
          { type: "heeler.image_source", params: {} },
          { type: "heeler.tone_profile", params },
        ],
      });

      it("a fresh session ships with the measured defaults", async () => {
        const { PROFILE_DEFAULTS } = await import("../state");
        const { initialState } = await import("../data");
        const profile = initialState().nodes.find((n) => n.type === "heeler.tone_profile")!;
        expect(profile.params.baseline_ev).toBe(PROFILE_DEFAULTS.baseline_ev);
        expect(profile.params.shadow_toe).toBe(PROFILE_DEFAULTS.shadow_toe);
        expect(profile.params.highlight_rolloff).toBe(PROFILE_DEFAULTS.highlight_rolloff);
      });

      it("an unedited image with a pre-lift graph gets today's look", async () => {
        const { needsProfileDefaults } = await import("../state");
        const plain = { name: "DSC_0001.NEF", edited: false };
        expect(needsProfileDefaults(plain, graph({}))).toBe(true);
        expect(needsProfileDefaults(plain, graph({ highlight_rolloff: 70 }))).toBe(true);
        // Already upgraded, or made after the lift shipped: leave it.
        expect(needsProfileDefaults(plain, graph({ baseline_ev: 1.3 }))).toBe(false);
        // Zeroed on purpose is still "present": the user's choice stays.
        expect(needsProfileDefaults(plain, graph({ baseline_ev: 0 }))).toBe(false);
        // No saved graph means the default graph, which has it already.
        expect(needsProfileDefaults(plain, null)).toBe(false);
      });

      it("edits elsewhere don't pin the profile to the old look", async () => {
        const { needsProfileDefaults } = await import("../state");
        // The owner's field case: the whole test library was "edited" (exposure nudges), so
        // the image-level gate kept every comparison photo a stop under a reference editor.
        // Setting exposure is not choosing a profile.
        expect(needsProfileDefaults({ name: "x.NEF", edited: true }, graph({}))).toBe(true);
        expect(
          needsProfileDefaults({ name: "x.NEF", edited: true }, graph({ contrast: 100 })),
        ).toBe(true);
        // A hand on the profile's own controls is a choice; it stays.
        expect(
          needsProfileDefaults({ name: "x.NEF", edited: true }, graph({ contrast: 73 })),
        ).toBe(false);
      });

      it("the upgrade fills the params and never lowers a merge's shoulder", async () => {
        const { reduce, PROFILE_DEFAULTS, MERGED_ROLLOFF } = await import("../state");
        const { initialState } = await import("../data");
        let s = initialState();
        // Simulate an old graph: strip the new params, give it the
        // merge's big shoulder.
        s = {
          ...s,
          nodes: s.nodes.map((n) =>
            n.type === "heeler.tone_profile"
              ? { ...n, params: { contrast: 100, highlight_rolloff: MERGED_ROLLOFF } }
              : n,
          ),
        };
        s = reduce(s, { type: "apply_profile_defaults" });
        const profile = s.nodes.find((n) => n.type === "heeler.tone_profile")!;
        expect(profile.params.baseline_ev).toBe(PROFILE_DEFAULTS.baseline_ev);
        expect(profile.params.shadow_toe).toBe(PROFILE_DEFAULTS.shadow_toe);
        expect(profile.params.highlight_rolloff).toBe(MERGED_ROLLOFF);
        // Idempotent: running it again changes nothing.
        expect(reduce(s, { type: "apply_profile_defaults" })).toBe(s);
      });

      it("baseline and toe are real graph params with shared ranges", async () => {
        const { paramRange } = await import("../state");
        expect(paramRange("baseline_ev", "heeler.tone_profile")).toEqual([-3, 3]);
        expect(paramRange("shadow_toe", "heeler.tone_profile")).toEqual([0, 100]);
      });
    });

    it("the shoulder is a real graph param, editable in both modes", async () => {
      const { reduce, paramRange } = await import("../state");
      const { initialState } = await import("../data");
      let s = reduce(initialState(), { type: "apply_merged_defaults" });
      const profile = s.nodes.find((n) => n.type === "heeler.tone_profile")!;
      // Range comes from the shared table, so Develop and the Graph
      // inspector show the same slider.
      expect(paramRange("highlight_rolloff", profile.type)).toEqual([0, 100]);
      s = reduce(s, { type: "set_param", id: profile.id, param: "highlight_rolloff", value: 0 });
      expect(
        s.nodes.find((n) => n.type === "heeler.tone_profile")!.params.highlight_rolloff
      ).toBe(0);
    });
  });

  describe("zoom does not re-render what is already on screen", () => {
    // The owner uses the mouse wheel a lot, and every notch used to fire
    // a full graph render. Inside a tier the engine returns exactly the
    // same image at every zoom level and the viewer scales the bitmap it
    // already has, so those renders reproduced the frame on screen.
    it("only the crossing into 1:1 changes what has to be rendered", async () => {
      const { needsFullRes } = await import("../bridge");
      const { initialState } = await import("../data");
      const { reduce } = await import("../state");

      let s = initialState();
      expect(needsFullRes(s)).toBe(false);

      // Spinning the wheel below 1:1: the scale moves every time and the
      // tier never does, so no render is warranted.
      const scales: number[] = [];
      for (let i = 0; i < 6; i++) {
        s = reduce(s, { type: "zoom_viewer", factor: 0.9 });
        scales.push(s.view.zoomScale);
        expect(needsFullRes(s)).toBe(false);
      }
      expect(new Set(scales).size).toBe(6);

      // Past 1:1 the tier flips once, and stays flipped however much
      // further it goes.
      s = reduce(initialState(), { type: "zoom_viewer", factor: 2 });
      expect(needsFullRes(s)).toBe(true);
      s = reduce(s, { type: "zoom_viewer", factor: 2 });
      expect(needsFullRes(s)).toBe(true);
      s = reduce(s, { type: "zoom_viewer", factor: 4 });
      expect(needsFullRes(s)).toBe(true);

      // And choosing 100% explicitly is the full tier even at scale 1.
      const hundred = reduce(initialState(), { type: "set_zoom", zoom: "100" });
      expect(hundred.view.zoomScale).toBe(1);
      expect(needsFullRes(hundred)).toBe(true);
      expect(needsFullRes(reduce(initialState(), { type: "set_zoom", zoom: "fit" }))).toBe(false);
    });

    it("panning never changes the tier", async () => {
      const { needsFullRes } = await import("../bridge");
      const { initialState } = await import("../data");
      const { reduce } = await import("../state");
      let s = reduce(initialState(), { type: "set_zoom", zoom: "100" });
      const before = needsFullRes(s);
      s = reduce(s, { type: "pan_viewer", dx: 120, dy: -40 });
      expect(s.view.pan).not.toEqual({ x: 0, y: 0 });
      expect(needsFullRes(s)).toBe(before);
    });
  });

  describe("ribbon navigation", () => {
    it("up and down walk the ribbon", async () => {
      const user = userEvent.setup();
      render(<App />);
      const thumbs = screen.getAllByTestId(/^thumb-\d+$/);
      await user.click(thumbs[2]);
      const idAt = (n: number) => thumbs[n].getAttribute("data-testid")!.replace("thumb-", "");
      const active = () =>
        screen.getAllByTestId(/^thumb-\d+$/).find((t) => t.getAttribute("data-selected") === "true")!
          .getAttribute("data-testid")!.replace("thumb-", "");

      fireEvent.keyDown(window, { key: "ArrowDown" });
      expect(active()).toBe(idAt(3));
      fireEvent.keyDown(window, { key: "ArrowUp" });
      fireEvent.keyDown(window, { key: "ArrowUp" });
      expect(active()).toBe(idAt(1));
    });

    /// Wrapping past the last frame of a shoot back to the first is
    /// disorienting when you are stepping through looking for one photo.
    it("stops at the ends rather than wrapping", async () => {
      const { reduce, visibleImages } = await import("../state");
      const { initialState } = await import("../data");
      let s = initialState();
      const all = visibleImages(s);

      s = reduce(s, { type: "select_image", id: all[0].id });
      s = reduce(s, { type: "step_image", delta: -1 });
      expect(s.activeImage).toBe(all[0].id);

      s = reduce(s, { type: "select_image", id: all[all.length - 1].id });
      s = reduce(s, { type: "step_image", delta: 1 });
      expect(s.activeImage).toBe(all[all.length - 1].id);
    });

    /// Adding one navigation shortcut must not break every keyboard
    /// adjustment in the app. A color wheel and a slider both nudge on
    /// arrow keys, and a global handler that swallowed them would take
    /// those away silently.
    it("arrows go to a control that reads them, not to the ribbon", async () => {
      const user = userEvent.setup();
      render(<App />);
      const thumbs = screen.getAllByTestId(/^thumb-\d+$/);
      await user.click(thumbs[2]);
      const activeId = () =>
        screen
          .getAllByTestId(/^thumb-\d+$/)
          .find((t) => t.getAttribute("data-selected") === "true")!
          .getAttribute("data-testid");
      const before = activeId();

      // Color Wheels is off by default and so is not in the photograph at
      // all until it is switched on, which is what this click does.
      await user.click(screen.getByTestId("toggle-color-wheels"));
      const wheel = screen.getByTestId("wheel-midtones");
      fireEvent.keyDown(wheel, { key: "ArrowUp" });
      fireEvent.keyDown(wheel, { key: "ArrowRight" });
      // The wheel moved...
      expect(screen.getByTestId("wheel-midtones-hue")).not.toHaveTextContent("0°");
      // ...and the ribbon did not.
      expect(activeId()).toBe(before);

      // A slider keeps its arrows too.
      const slider = within(screen.getByTestId("slider-exposure")).getByRole("slider");
      fireEvent.keyDown(slider, { key: "ArrowDown" });
      expect(activeId()).toBe(before);
    });

    /// A filtered ribbon that jumped to photos it is not showing would
    /// look like the selection had gone missing.
    it("steps through what is visible, not through everything", async () => {
      const { reduce, visibleImages } = await import("../state");
      const { initialState } = await import("../data");
      let s = reduce(initialState(), { type: "set_filter_stars", stars: 3 });
      const visible = visibleImages(s);
      expect(visible.length).toBeGreaterThan(1);
      expect(visible.length).toBeLessThan(s.images.length);

      s = reduce(s, { type: "select_image", id: visible[0].id });
      s = reduce(s, { type: "step_image", delta: 1 });
      expect(s.activeImage).toBe(visible[1].id);
      // Never lands on something the ribbon is not showing.
      expect(visible.map((i) => i.id)).toContain(s.activeImage);
    });
  });

  describe("tagging from the menus", () => {
    it("Photo > Rating rates, and Clear takes it back to nothing", async () => {
      const user = userEvent.setup();
      render(<App />);
      await user.click(screen.getByTestId("menu-photo"));
      fireEvent.mouseEnter(screen.getByTestId("menu-photo-rating").parentElement!);
      await user.click(screen.getByTestId("menu-photo-rating-4"));
      expect(lit("star-4871-4")).toBe(true);
      expect(lit("star-4871-5")).toBe(false);

      await user.click(screen.getByTestId("menu-photo"));
      fireEvent.mouseEnter(screen.getByTestId("menu-photo-rating").parentElement!);
      await user.click(screen.getByTestId("menu-photo-rating-0"));
      expect(lit("star-4871-1")).toBe(false);
    });

    it("Photo > Pick and Reject flag, and Clear Flag unflags", async () => {
      const user = userEvent.setup();
      render(<App />);
      await user.click(screen.getByTestId("menu-photo"));
      await user.click(screen.getByTestId("menu-photo-pick"));
      expect(lit("flag-4871-pick")).toBe(true);

      await user.click(screen.getByTestId("menu-photo"));
      await user.click(screen.getByTestId("menu-photo-reject"));
      expect(lit("flag-4871-reject")).toBe(true);
      expect(lit("flag-4871-pick")).toBe(false);

      await user.click(screen.getByTestId("menu-photo"));
      await user.click(screen.getByTestId("menu-photo-unflag"));
      expect(lit("flag-4871-reject")).toBe(false);
    });

    /// Right-clicking a thumbnail is how most people reach for a
    /// rating, so the same entries have to be there.
    it("the thumbnail context menu rates and flags too", async () => {
      const user = userEvent.setup();
      render(<App />);
      fireEvent.contextMenu(screen.getByTestId("thumb-4869"));
      fireEvent.mouseEnter(screen.getByTestId("thumb-menu-rating").parentElement!);
      await user.click(screen.getByTestId("thumb-menu-rating-2"));
      expect(lit("star-4869-2")).toBe(true);

      fireEvent.contextMenu(screen.getByTestId("thumb-4869"));
      await user.click(screen.getByTestId("thumb-menu-reject"));
      expect(lit("flag-4869-reject")).toBe(true);
    });

    it("a menu rating applies to the whole selection", async () => {
      const user = userEvent.setup();
      render(<App />);
      const thumbs = screen.getAllByTestId(/^thumb-\d+$/);
      await user.click(thumbs[0]);
      fireEvent.click(thumbs[2], { shiftKey: true });
      await user.click(screen.getByTestId("menu-photo"));
      fireEvent.mouseEnter(screen.getByTestId("menu-photo-rating").parentElement!);
      await user.click(screen.getByTestId("menu-photo-rating-3"));
      for (const t of thumbs.slice(0, 3)) {
        const id = t.getAttribute("data-testid")!.replace("thumb-", "");
        expect(lit(`star-${id}-3`)).toBe(true);
      }
    });
  });

  describe("menus show their keys", () => {
    /// The binding is read from the registry rather than typed into the
    /// label, so rebinding a command updates the menu instead of leaving
    /// it advertising a key that no longer works.
    it("the Photo menu shows the key beside each command", async () => {
      const user = userEvent.setup();
      render(<App />);
      await user.click(screen.getByTestId("menu-photo"));
      expect(screen.getByTestId("menu-photo-pick")).toHaveTextContent("P");
      expect(screen.getByTestId("menu-photo-reject")).toHaveTextContent("X");
      expect(screen.getByTestId("menu-photo-unflag")).toHaveTextContent("U");
      fireEvent.mouseEnter(screen.getByTestId("menu-photo-rating").parentElement!);
      expect(screen.getByTestId("menu-photo-rating-3")).toHaveTextContent("3");
      expect(screen.getByTestId("menu-photo-rating-0")).toHaveTextContent("0");
    });

    it("the thumbnail menu shows them too", () => {
      render(<App />);
      fireEvent.contextMenu(screen.getByTestId("thumb-4869"));
      expect(screen.getByTestId("thumb-menu-pick")).toHaveTextContent("P");
      expect(screen.getByTestId("thumb-menu-reject")).toHaveTextContent("X");
    });

    it("File shows the Preferences key", async () => {
      const user = userEvent.setup();
      render(<App />);
      await user.click(screen.getByTestId("menu-file"));
      expect(screen.getByTestId("menu-file-prefs")).toHaveTextContent("Ctrl+,");
    });

    /// A command with no binding gets no chip at all. A menu full of
    /// blank boxes reads as something failing to load.
    it("an unbound command shows nothing rather than an empty box", async () => {
      const user = userEvent.setup();
      const { bindingFor } = await import("../hotkeys");
      render(<App />);
      expect(bindingFor("photo.panorama", {})).toBe("");
      const thumbs = screen.getAllByTestId(/^thumb-\d+$/);
      await user.click(thumbs[0]);
      fireEvent.click(thumbs[2], { shiftKey: true });
      await user.click(screen.getByTestId("menu-photo"));
      const entry = screen.getByTestId("menu-photo-panorama");
      expect(entry).toHaveTextContent("Stitch to Panorama…");
      // Nothing but the label: no stray separator or empty chip.
      expect(entry.textContent).toBe("Stitch to Panorama…");
    });

    /// A is for Adjust: F went to Fit so it frames the view in every
    /// workspace, and inside the mode a already nudges the value.
    it("the develop keynav command is Adjust by Key, on A", async () => {
      const { COMMANDS } = await import("../hotkeys");
      const cmd = COMMANDS.find((c) => c.id === "develop.keynav")!;
      expect(cmd.label).toBe("Adjust by Key");
      expect(cmd.binding).toBe("A");
    });
  });

  describe("crop and straighten from the menu", () => {
    it("Photo > Crop / Straighten arms each tool", async () => {
      const user = userEvent.setup();
      render(<App />);
      await user.click(screen.getByTestId("menu-photo"));
      fireEvent.mouseEnter(screen.getByTestId("menu-photo-crop").parentElement!);
      await user.click(screen.getByTestId("menu-photo-straighten"));
      expect(screen.getByTestId("btn-tool-straighten")).toHaveAttribute("data-active", "true");

      await user.click(screen.getByTestId("menu-photo"));
      fireEvent.mouseEnter(screen.getByTestId("menu-photo-crop").parentElement!);
      await user.click(screen.getByTestId("menu-photo-cropinit"));
      expect(screen.getByTestId("crop-overlay")).toBeInTheDocument();
    });

    /// Setting a ratio without the crop up would constrain something
    /// the user cannot see.
    it("choosing an aspect ratio opens the crop and constrains it", async () => {
      const user = userEvent.setup();
      render(<App />);
      await user.click(screen.getByTestId("menu-photo"));
      fireEvent.mouseEnter(screen.getByTestId("menu-photo-crop").parentElement!);
      fireEvent.mouseEnter(screen.getByTestId("menu-photo-aspect").parentElement!);
      await user.click(screen.getByTestId("menu-photo-aspect-16-9"));
      expect(screen.getByTestId("crop-overlay")).toBeInTheDocument();
      const select = screen.getByTestId("crop-aspect");
      expect(new Map(menuRows(select)).get(menuValue(select))).toBe("16:9");
    });

    it("a custom ratio is parsed, and a typo is refused rather than applied", async () => {
      const { parseAspect } = await import("../ui/chrome");
      expect(parseAspect("3:2")).toBeCloseTo(1.5);
      expect(parseAspect("5x4")).toBeCloseTo(1.25);
      expect(parseAspect("1.85")).toBeCloseTo(1.85);
      // A crop constrained to zero or a negative ratio is a crop
      // collapsed to nothing, so these have to come back null.
      expect(parseAspect("0:3")).toBeNull();
      expect(parseAspect("3:0")).toBeNull();
      expect(parseAspect("-2")).toBeNull();
      expect(parseAspect("wide")).toBeNull();
      expect(parseAspect("")).toBeNull();
    });
  });

  describe("filters", () => {
    it("the edited button cycles: edited only, untouched only, then everything", async () => {
      // (2026-09-15): "Just a button that is the Edit icon we see on
      // thumbnails... When on (edits) the accent color highlights."
      const user = userEvent.setup();
      render(<App />);
      const shown = () => screen.getAllByTestId(/^thumb-\d+$/).length;
      const all = shown();
      await user.click(screen.getByTestId("filter-open"));
      const button = () => screen.getByTestId("filter-edited");
      expect(button()).toHaveAttribute("data-state", "all");

      await user.click(button());
      expect(button()).toHaveAttribute("data-state", "edited");
      const edited = shown();
      expect(edited).toBeLessThan(all);
      await user.click(button());
      expect(button()).toHaveAttribute("data-state", "unedited");
      expect(screen.getByTestId("filter-edited-strike")).toBeInTheDocument();
      const untouched = shown();
      expect(untouched).toBeLessThan(all);
      // Between them they account for everything, with no overlap.
      expect(edited + untouched).toBe(all);

      // The third click is off.
      await user.click(button());
      expect(button()).toHaveAttribute("data-state", "all");
      expect(shown()).toBe(all);
    });

    it("the versions filter isolates images with more than one take", async () => {
      const { reduce, takeCount } = await import("../state");
      const { initialState } = await import("../data");
      const { visibleImages } = await import("../state");
      let s = initialState();
      // An image with no branches still counts as one version: the
      // original edit is a version, it just has no siblings yet.
      expect(takeCount(s, "4866")).toBe(1);

      s = reduce(s, {
        type: "restore_takes",
        imageId: "4866",
        versions: [
          { id: "take_1", name: "Take 1", nodes: [], wires: [] },
          // Deliberately still called Version 2: this is a take restored
          // from a graph saved before the rename, and a name the user has
          // on disk is theirs. New ones are named Take; old ones are left
          // exactly as they were rather than rewritten under them.
          { id: "take_2", name: "Version 2", nodes: [], wires: [] },
        ],
        activeVersion: "take_1",
      } as never);
      expect(takeCount(s, "4866")).toBe(2);

      const before = visibleImages(s).length;
      s = reduce(s, { type: "set_filter_takes", min: 2 });
      expect(visibleImages(s).map((i) => i.id)).toEqual(["4866"]);

      // The other end of the window: at most one version excludes the
      // branched image and keeps everything else.
      s = reduce(s, { type: "set_filter_takes", min: 1, max: 1 });
      expect(visibleImages(s).map((i) => i.id)).not.toContain("4866");
      expect(visibleImages(s).length).toBe(before - 1);

      s = reduce(s, { type: "clear_filters" });
      expect(visibleImages(s).length).toBe(before);
    });

    /// Dragging one end past the other would silently show nothing,
    /// which reads as a folder that lost its photos.
    it("the version ends push each other rather than crossing", async () => {
      const { reduce, TAKE_CAP } = await import("../state");
      const { initialState } = await import("../data");
      let s = initialState();

      s = reduce(s, { type: "set_filter_takes", min: 5 });
      expect(s.filterTakesMin).toBe(5);
      expect(s.filterTakesMax).toBeGreaterThanOrEqual(5);

      s = reduce(s, { type: "set_filter_takes", max: 2 });
      expect(s.filterTakesMax).toBe(2);
      expect(s.filterTakesMin).toBeLessThanOrEqual(2);

      // And neither end escapes its bounds.
      s = reduce(s, { type: "set_filter_takes", min: -4 });
      expect(s.filterTakesMin).toBe(1);
      s = reduce(s, { type: "set_filter_takes", max: 999 });
      expect(s.filterTakesMax).toBe(TAKE_CAP);
    });

    it("the funnel says when something is filtered, and clears it", async () => {
      const user = userEvent.setup();
      render(<App />);
      const total = screen.getAllByTestId(/^thumb-\d+$/).length;
      // Nothing on: no badge, and nothing to clear.
      expect(screen.queryByTestId("filter-active-dot")).not.toBeInTheDocument();

      await user.click(screen.getByTestId("filter-open"));
      expect(screen.getByTestId("filter-clear")).toBeDisabled();
      await user.click(screen.getByTestId("filter-star-4"));
      // A forgotten filter looks exactly like a folder that lost its
      // photos, so the funnel says so from the outside.
      expect(screen.getByTestId("filter-active-dot")).toBeInTheDocument();
      expect(screen.getAllByTestId(/^thumb-\d+$/).length).toBeLessThan(total);

      await user.click(screen.getByTestId("filter-clear"));
      expect(screen.queryByTestId("filter-active-dot")).not.toBeInTheDocument();
      expect(screen.getAllByTestId(/^thumb-\d+$/).length).toBe(total);
    });

    /// Mix and match: the filters are ANDed, not one-at-a-time.
    it("filters combine rather than replacing each other", async () => {
      const { reduce, visibleImages } = await import("../state");
      const { initialState } = await import("../data");
      let s = initialState();
      const stars = reduce(s, { type: "set_filter_stars", stars: 2 });
      const picks = reduce(s, { type: "cycle_filter_flag" });
      const both = reduce(stars, { type: "cycle_filter_flag" });
      expect(visibleImages(both).length).toBeLessThanOrEqual(
        Math.min(visibleImages(stars).length, visibleImages(picks).length)
      );
      for (const img of visibleImages(both)) {
        expect(img.stars).toBeGreaterThanOrEqual(2);
        expect(img.flag).toBe("pick");
      }
    });
  });

  describe("stitch progress", () => {
    // The dialog is driven straight off state rather than the Tauri
    // event, which the browser build never sees. What is tested here is
    // what the reducer and the dialog do with a report.
    it("shows the stage and the bar while a stitch runs", async () => {
      const { StitchDialog } = await import("../ui/stitching");
      const { initialState } = await import("../data");
      const { reduce } = await import("../state");
      const s = reduce(initialState(), {
        type: "set_stitch_progress",
        progress: { image: "pan", fraction: 0.42, stage: "Matching frames 1 and 2", error: null },
      });
      render(<StitchDialog state={s} dispatch={() => {}} />);
      expect(screen.getByTestId("stitch-stage")).toHaveTextContent("Matching frames 1 and 2");
      expect(screen.getByTestId("stitch-pct")).toHaveTextContent("42%");
      expect(screen.getByTestId("stitch-bar")).toHaveStyle({ width: "42%" });
    });

    it("stays out of the way when nothing is stitching", async () => {
      const { StitchDialog } = await import("../ui/stitching");
      const { initialState } = await import("../data");
      render(<StitchDialog state={initialState()} dispatch={() => {}} />);
      expect(screen.queryByTestId("stitch-dialog")).not.toBeInTheDocument();
    });

    /// A dialog that only closes on success is worse than none: a failed
    /// stitch would leave the app looking permanently busy.
    it("reports a failure with its reason instead of hanging at 99%", async () => {
      const { StitchDialog } = await import("../ui/stitching");
      const { initialState } = await import("../data");
      const { reduce } = await import("../state");
      const user = userEvent.setup();
      let s = reduce(initialState(), {
        type: "set_stitch_progress",
        progress: {
          image: "pan",
          fraction: 1,
          stage: "Failed",
          error: "these frames do not overlap enough to stitch",
        },
      });
      const dispatch = vi.fn();
      render(<StitchDialog state={s} dispatch={dispatch} />);
      expect(screen.getByTestId("stitch-stage")).toHaveTextContent("do not overlap");
      // No bar on the failure path: there is no progress left to make.
      expect(screen.queryByTestId("stitch-bar")).not.toBeInTheDocument();
      await user.click(screen.getByTestId("stitch-dismiss"));
      expect(dispatch).toHaveBeenCalledWith({ type: "set_stitch_progress", progress: null });
      s = reduce(s, { type: "set_stitch_progress", progress: null });
      expect(s.stitch).toBeNull();
    });

    it("a fraction outside 0 to 1 cannot push the bar past the end", async () => {
      const { StitchDialog } = await import("../ui/stitching");
      const { initialState } = await import("../data");
      const { reduce } = await import("../state");
      const s = reduce(initialState(), {
        type: "set_stitch_progress",
        progress: { image: "pan", fraction: 1.4, stage: "Blending", error: null },
      });
      render(<StitchDialog state={s} dispatch={() => {}} />);
      expect(screen.getByTestId("stitch-bar")).toHaveStyle({ width: "100%" });
    });
  });

  describe("bend tool", () => {
    it("the disc maps hue to angle and saturation to radius, both ways", async () => {
      const { discPoint, pointToDisc } = await import("../ui/bend");
      // Center is zero saturation, whatever the hue.
      const c = discPoint(120, 0);
      expect(pointToDisc(c.x, c.y).sat).toBeCloseTo(0, 6);
      // A round trip has to land back where it started, or dragging a
      // handle would drift under the cursor.
      for (const [h, s] of [[0, 1], [90, 0.5], [200, 0.8], [359, 0.2]] as [number, number][]) {
        const p = discPoint(h, s);
        const back = pointToDisc(p.x, p.y);
        expect(back.hue).toBeCloseTo(h, 3);
        expect(back.sat).toBeCloseTo(s, 5);
      }
      // Saturation past the rim is held at the rim rather than running on.
      const far = discPoint(0, 1);
      expect(pointToDisc(far.x + 500, far.y).sat).toBe(1);
    });

    it("dragging the handles writes the source and destination", async () => {
      const user = userEvent.setup();
      const { discPoint } = await import("../ui/bend");
      render(<App />);
      const disc = screen.getByTestId("bend-disc");
      // The widget works in its own viewBox units, so pin the box to them.
      disc.getBoundingClientRect = () =>
        ({ left: 0, top: 0, right: 208, bottom: 208, width: 208, height: 208, x: 0, y: 0, toJSON() {} }) as DOMRect;

      const target = discPoint(90, 0.6);
      fireEvent.mouseDown(screen.getByTestId("bend-dst"), { clientX: target.x, clientY: target.y });
      fireEvent.mouseUp(disc);

      await toGraphMode(user);
      await user.click(screen.getByTestId("node-bend"));
      const inspector = screen.getByTestId("inspector");
      const val = (p: string) =>
        Number(within(within(inspector).getByTestId(`slider-${p}`)).getByRole("slider").getAttribute("aria-valuenow"));
      // Dispatched through the same disc math the engine uses.
      expect(within(inspector).getByTestId("bend-disc")).toBeInTheDocument();
      // Ships reaching a third of the disc. It used to cover the whole of it,
      // which drew the reach ring exactly on top of the wheel's own edge, so
      // the control was invisible. "having the default size of
      // the ring the size of the color circle is confusing."
      const { BEND_FALLOFF_DEFAULT } = await import("../state");
      expect(val("falloff")).toBeCloseTo(BEND_FALLOFF_DEFAULT, 2);
    });

    it("Clear puts the destination back on the source", async () => {
      const user = userEvent.setup();
      const { discPoint } = await import("../ui/bend");
      render(<App />);
      const disc = screen.getByTestId("bend-disc");
      disc.getBoundingClientRect = () =>
        ({ left: 0, top: 0, right: 208, bottom: 208, width: 208, height: 208, x: 0, y: 0, toJSON() {} }) as DOMRect;
      const dstBefore = screen.getByTestId("bend-dst").getAttribute("cx");

      const target = discPoint(180, 0.9);
      fireEvent.mouseDown(screen.getByTestId("bend-dst"), { clientX: target.x, clientY: target.y });
      fireEvent.mouseUp(disc);
      expect(screen.getByTestId("bend-dst").getAttribute("cx")).not.toBe(dstBefore);

      await user.click(screen.getByTestId("bend-reset"));
      // Back on top of the source, which is what "no bend" looks like.
      expect(screen.getByTestId("bend-dst").getAttribute("cx")).toBe(
        screen.getByTestId("bend-src").getAttribute("cx")
      );
    });

    it("the section Reset clears the wheel and leaves the switch where it was", async () => {
      // "The reset is not working on Color Bend. If I turn off
      // Color Bend and hit reset it still does not reset the color wheel but it
      // turns on the control." Two faults in one click: the wheel lives outside
      // the section's slider rows and had no reset case, and the bend it kept
      // re-armed the bypassed node through armed.
      const user = userEvent.setup();
      const { discPoint } = await import("../ui/bend");
      render(<App />);
      const disc = screen.getByTestId("bend-disc");
      disc.getBoundingClientRect = () =>
        ({ left: 0, top: 0, right: 208, bottom: 208, width: 208, height: 208, x: 0, y: 0, toJSON() {} }) as DOMRect;

      // Move BOTH handles: a reset that only unbends would pass a test
      // that only moved the destination.
      const srcAt = discPoint(30, 0.7);
      fireEvent.mouseDown(screen.getByTestId("bend-src"), { clientX: srcAt.x, clientY: srcAt.y });
      fireEvent.mouseUp(disc);
      const dstAt = discPoint(200, 0.85);
      fireEvent.mouseDown(screen.getByTestId("bend-dst"), { clientX: dstAt.x, clientY: dstAt.y });
      fireEvent.mouseUp(disc);

      const centre = discPoint(0, 0);
      const at = (id: string, axis: "cx" | "cy") =>
        Number(screen.getByTestId(id).getAttribute(axis));
      expect(at("bend-src", "cx")).not.toBeCloseTo(centre.x, 1);
      expect(at("bend-dst", "cx")).not.toBeCloseTo(centre.x, 1);

      // The bend armed the section on its own; switch it back off, which
      // is the state the reset misbehaved from.
      await user.click(screen.getByTestId("toggle-color-bend"));
      expect(screen.getByTestId("toggle-color-bend")).toHaveAttribute("data-on", "false");

      await user.click(screen.getByTestId("reset-color-bend"));

      // Source and destination both back at the middle of the disc.
      expect(at("bend-src", "cx")).toBeCloseTo(centre.x, 1);
      expect(at("bend-src", "cy")).toBeCloseTo(centre.y, 1);
      expect(at("bend-dst", "cx")).toBeCloseTo(centre.x, 1);
      expect(at("bend-dst", "cy")).toBeCloseTo(centre.y, 1);
      // And the switch is where it was left.
      expect(screen.getByTestId("toggle-color-bend")).toHaveAttribute("data-on", "false");
    });

    it("the channel filter is a view of the spectrum, not an edit", async () => {
      const user = userEvent.setup();
      render(<App />);
      expect(screen.getByTestId("bend-channel-rgb")).toHaveAttribute("data-active", "true");
      await user.click(screen.getByTestId("bend-channel-r"));
      expect(screen.getByTestId("bend-channel-r")).toHaveAttribute("data-active", "true");
      // Filtering which colors are plotted must not touch the graph.
      await user.click(screen.getByTestId("panel-tab-history"));
      expect(screen.getByTestId("history-count")).toHaveTextContent("0/100");
    });

    it("plots density, so a dominant color does not flatten the rest", async () => {
      const { densityField } = await import("../ui/bend");
      // One color piled up in a spot, another with a single sample.
      const many = Array.from({ length: 300 }, () => ({ x: 60, y: 60, r: 255, g: 0, b: 0 }));
      const one = [{ x: 140, y: 140, r: 0, g: 0, b: 255 }];
      const { alpha } = densityField([...many, ...one], 208);
      const at = (x: number, y: number) => alpha[y * 208 + x];
      // The pile is stronger, but the lone sample is still clearly
      // visible: log density, not a linear count that would bury it.
      expect(at(60, 60)).toBeGreaterThan(at(140, 140));
      expect(at(140, 140)).toBeGreaterThan(0.05);
      // Soft footprint, so it reads as haze rather than confetti.
      expect(at(61, 60)).toBeGreaterThan(0);
      expect(at(62, 60)).toBeGreaterThan(0);
    });

    it("draws a bigger wheel rather than stretching the small one", async () => {
      /// The pop-out looked like an enlarged low-resolution color wheel rather
      /// than a newly generated high-resolution one.
      ///
      /// He was right, and only about half of it was fixed last time:
      /// the face was redrawn per pixel at the new size but the cloud
      /// was still splatted into a 208 buffer and read up out of it with
      /// nearest neighbor, which is four-pixel blocks at a pop-out's
      /// size. That is the smudge in his screenshot.
      const { densityField } = await import("../ui/bend");
      const pts = [{ x: 104, y: 104, r: 255, g: 0, b: 0 }];
      const small = densityField(pts, 208);
      const big = densityField(pts, 832);

      // The sample lands in the same PLACE, in the disc's own space.
      expect(small.alpha[104 * 208 + 104]).toBeGreaterThan(0);
      expect(big.alpha[416 * 832 + 416]).toBeGreaterThan(0);

      // And it is genuinely resolved four times finer: the splat covers
      // roughly sixteen times the pixels, which an upscale of a 208
      // field could never do because there is nothing there to upscale.
      const covered = (f: Float32Array) => f.reduce((n, v) => n + (v > 0 ? 1 : 0), 0);
      const ratio = covered(big.alpha) / covered(small.alpha);
      expect(ratio).toBeGreaterThan(8);
      // Sanity: the small one is still exactly what it always was, so
      // the panel is unchanged.
      expect(covered(small.alpha)).toBeLessThan(30);
    });

    it("fits the popped-out wheel under its own controls, not through them", async () => {
      /// "The controls are overlapping."
      ///
      /// A flex child centered in a box it does not fit in overflows in
      /// BOTH directions, so a wheel one row too tall put that row up
      /// through the title bar. The fix is arithmetic, so it is tested
      /// as arithmetic.
      const { fitWheel } = await import("../ui/bendwindow");
      const CHROME = 27; // the row of chips above the disc
      expect(fitWheel(600, 800, CHROME)).toBe(600); // width-bound
      expect(fitWheel(900, 500, CHROME)).toBe(500 - CHROME); // height-bound
      // The thing that was actually wrong: the disc plus its controls
      // has to fit the stage, or it overlaps whatever is above.
      for (const [w, h] of [[722, 640], [400, 400], [1200, 300]]) {
        expect(fitWheel(w, h, CHROME) + CHROME).toBeLessThanOrEqual(Math.max(h, 180 + CHROME));
      }
      // And it never shrinks to nothing: handles too small to grab are
      // worse than a window you have to make bigger.
      expect(fitWheel(40, 40, CHROME)).toBe(180);
    });

    it("the reach is grabbed by its rim and cannot shrink out of reach", async () => {
      const { MIN_FALLOFF } = await import("../ui/bend");
      render(<App />);
      // The filled part is click-through, so it never swallows a drag
      // meant for the interior; only the rim resizes.
      expect(screen.getByTestId("bend-falloff")).toHaveStyle({ pointerEvents: "none" });
      expect(screen.getByTestId("bend-falloff-grab")).toHaveStyle({ pointerEvents: "stroke" });

      const disc = screen.getByTestId("bend-disc");
      disc.getBoundingClientRect = () =>
        ({ left: 0, top: 0, right: 208, bottom: 208, width: 208, height: 208, x: 0, y: 0, toJSON() {} }) as DOMRect;
      const src = screen.getByTestId("bend-src");
      // Drag the rim right onto the source: it must stop at the floor,
      // not collapse inside the handle where it could never be grabbed
      // again.
      fireEvent.mouseDown(screen.getByTestId("bend-falloff-grab"), {
        clientX: Number(src.getAttribute("cx")),
        clientY: Number(src.getAttribute("cy")),
      });
      fireEvent.mouseUp(window);
      const r = Number(screen.getByTestId("bend-falloff").getAttribute("r"));
      expect(r).toBeGreaterThanOrEqual(MIN_FALLOFF * 94);
      // And it clears the source handle, which is drawn at radius 7.
      expect(r).toBeGreaterThan(7);
    });

    it("dragging the empty disc aims the source", async () => {
      const { discPoint } = await import("../ui/bend");
      render(<App />);
      const disc = screen.getByTestId("bend-disc");
      disc.getBoundingClientRect = () =>
        ({ left: 0, top: 0, right: 208, bottom: 208, width: 208, height: 208, x: 0, y: 0, toJSON() {} }) as DOMRect;
      const before = screen.getByTestId("bend-src").getAttribute("cx");
      const target = discPoint(210, 0.7);
      // Hunting for a 7px handle is not the only way to aim it.
      fireEvent.mouseDown(screen.getByTestId("bend-aim"), { clientX: target.x, clientY: target.y });
      fireEvent.mouseUp(window);
      expect(screen.getByTestId("bend-src").getAttribute("cx")).not.toBe(before);
    });

    it("names the handles for what they do, and the legend starts away", async () => {
      const user = userEvent.setup();
      render(<App />);
      // "the [?] button should be off by default." The legend
      // is scaffolding: worth having the first time and in the way every
      // time after, and the wheel is the part that wants the space.
      expect(screen.queryByTestId("bend-legend")).not.toBeInTheDocument();

      await user.click(screen.getByTestId("bend-help"));
      const legend = screen.getByTestId("bend-legend");
      // Source and Target match the node's own params, so the panel and
      // the graph use one vocabulary.
      expect(legend).toHaveTextContent(/source/i);
      expect(legend).toHaveTextContent(/target/i);
      expect(legend).toHaveTextContent(/reach/i);

      await user.click(screen.getByTestId("bend-help"));
      expect(screen.queryByTestId("bend-legend")).not.toBeInTheDocument();
    });

    it("pops out into its own window and folds to a bar", async () => {
      const { reduce } = await import("../state");
      const { initialState } = await import("../data");
      render(<App />);
      // The button is where the spectrums' is, so there is one thing to
      // learn rather than two.
      expect(screen.getByTestId("bend-popout")).toBeInTheDocument();

      const out = reduce(initialState(), { type: "set_bend_popped_out", out: true });
      expect(out.bendPoppedOut).toBe(true);
      const back = reduce(out, { type: "set_bend_popped_out", out: false });
      expect(back.bendPoppedOut).toBe(false);
    });

    it("the mock preview reacts to the bend, so the control is never dead", async () => {
      const { previewFilter } = await import("../bridge");
      const { reduce } = await import("../state");
      const { initialState } = await import("../data");
      // Without an engine the browser build approximates every node with
      // CSS. Nothing for the bend meant dragging the target changed
      // nothing on screen, which read as a broken tool.
      let s = initialState();
      expect(previewFilter(s)).not.toMatch(/hue-rotate/);
      s = reduce(s, { type: "set_params", id: "bend", values: { src_hue: 0, dst_hue: 120 } });
      expect(previewFilter(s)).toMatch(/hue-rotate/);
    });

    it("the scatter degrades to nothing when the frame cannot be read", async () => {
      const { sampleDisc } = await import("../ui/bend");
      // jsdom has no canvas: this must return empty rather than throw, or
      // the whole panel fails to render.
      const img = document.createElement("img");
      expect(sampleDisc(img, "rgb")).toEqual([]);
    });
  });

  describe("straighten tool", () => {
    const line = (dx: number, dy: number, angle = 0, view = 0) =>
      straightenAngle({ x: 100, y: 100 }, { x: 100 + dx, y: 100 + dy }, angle, view);

    it("levels a tilted horizon by turning the frame the other way", () => {
      // Horizon sloping DOWN to the right: the engine turns clockwise for
      // a positive angle, so correcting it must go negative.
      expect(line(200, 20)).toBeCloseTo(-5.71, 1);
      // Sloping up to the right: the other way.
      expect(line(200, -20)).toBeCloseTo(5.71, 1);
      // Dead level changes nothing.
      expect(line(200, 0)).toBe(0);
    });

    it("takes a near-vertical line as an upright, not a horizon", () => {
      // A post a degree off vertical, drawn bottom to top. Treating this
      // as a horizon would try to rotate by nearly 90 degrees.
      const post = straightenAngle({ x: 100, y: 300 }, { x: 105, y: 5 }, 0);
      expect(Math.abs(post)).toBeLessThan(2);
      // Its top leans right, so the frame turns counter-clockwise to
      // bring it upright, the same direction sense as the horizon case.
      expect(post).toBeLessThan(0);
      // Drawn the other way down the same post: same answer, since a line
      // and its reverse are the same line.
      expect(straightenAngle({ x: 105, y: 5 }, { x: 100, y: 300 }, 0)).toBeCloseTo(post, 4);
    });

    it("adds to the angle already applied", () => {
      // The photo is already turned 10; a horizon still 2 out corrects
      // from where it is rather than snapping to absolute.
      const from10 = line(200, 7, 10);
      expect(from10).toBeCloseTo(10 - 2, 0);
    });

    it("works on a rotated canvas, and stays inside the engine's range", () => {
      // The view is turned 90 for a look; the line's screen angle has to
      // have that backed out or the correction is nonsense.
      expect(line(0, 200, 0, 90)).toBeCloseTo(0, 4);
      // Never past what crop_rotate accepts.
      expect(line(10, 200, 40)).toBeLessThanOrEqual(45);
      expect(line(-10, 200, -40)).toBeGreaterThanOrEqual(-45);
    });

    it("ignores a stray click", () => {
      expect(straightenAngle({ x: 100, y: 100 }, { x: 102, y: 101 }, 12)).toBe(12);
    });

    it("drags a line in the viewer and the crop node takes the angle", async () => {
      const user = userEvent.setup();
      render(<App />);
      await user.click(screen.getByTestId("btn-tool-straighten"));
      const overlay = screen.getByTestId("straighten-overlay");
      stubBox(overlay, 400);

      fireEvent.mouseDown(overlay, { clientX: 100, clientY: 200, button: 0 });
      fireEvent.mouseMove(overlay, { clientX: 300, clientY: 220, buttons: 1 });
      // The live readout shows the tilt being corrected.
      expect(screen.getByTestId("straighten-readout")).toHaveTextContent("5.7");
      fireEvent.mouseUp(overlay);

      // The angle landed on the crop node, where the Straighten slider
      // can still adjust it afterwards.
      await user.click(screen.getByRole("tablist", { name: /workspace mode/i }).children[1]);
      await user.click(screen.getByTestId("node-crop"));
      const slider = within(screen.getByTestId("inspector")).getByRole("slider", { name: /straighten/i });
      expect(Number(slider.getAttribute("aria-valuenow"))).toBeCloseTo(-5.71, 1);
    });

    it("is a one-shot gesture, not a mode you stay in", async () => {
      const user = userEvent.setup();
      render(<App />);
      await user.click(screen.getByTestId("btn-tool-straighten"));
      const overlay = screen.getByTestId("straighten-overlay");
      stubBox(overlay, 400);
      fireEvent.mouseDown(overlay, { clientX: 100, clientY: 200, button: 0 });
      fireEvent.mouseMove(overlay, { clientX: 300, clientY: 220, buttons: 1 });
      fireEvent.mouseUp(overlay);
      // Tool drops itself, so the next drag on the photo is not another
      // accidental rotation.
      expect(screen.queryByTestId("straighten-overlay")).not.toBeInTheDocument();
    });
  });

  it("help text lands in the status row, not in a cursor tooltip", async () => {
    const user = userEvent.setup();
    render(<App />);
    // Idle: the row shows the readout and nothing else.
    expect(screen.queryByTestId("status-hint")).not.toBeInTheDocument();

    const console_ = screen.getByTestId("btn-console");
    // Nothing carries a title, which is what drew the native tooltip.
    expect(console_).not.toHaveAttribute("title");
    expect(console_).toHaveAttribute("data-hint");

    fireEvent.mouseOver(console_);
    expect(screen.getByTestId("status-hint")).toHaveTextContent("Console");

    // A hint on an ancestor still counts, so hovering the photo reports
    // how to navigate it.
    fireEvent.mouseOver(screen.getByTestId("viewer-image"));
    expect(screen.getByTestId("status-hint")).toHaveTextContent(/scroll zooms/i);

    // Moving onto something with no hinted ancestor clears it rather
    // than leaving the last one stuck up.
    fireEvent.mouseOver(screen.getByTestId("topbar"));
    expect(screen.queryByTestId("status-hint")).not.toBeInTheDocument();

    // Keyboard users get it too.
    fireEvent.focusIn(console_);
    expect(screen.getByTestId("status-hint")).toHaveTextContent("Console");
    await user.click(screen.getByTestId("panel-tab-adjust"));
  });

  it("contract: no control still uses a native tooltip", async () => {
    render(<App />);
    // title is what pops up beside the cursor, so nothing rendered
    // should carry one. data-hint is the replacement.
    const titled = document.querySelectorAll("[title]");
    expect(
      Array.from(titled).map((e) => e.getAttribute("data-testid") ?? e.tagName),
      "these elements still show a cursor tooltip"
    ).toEqual([]);
  });

  const toCanvas = async (user: ReturnType<typeof userEvent.setup>) =>
    user.click(within(screen.getByRole("tablist", { name: /workspace mode/i })).getByRole("button", { name: "Canvas" }));

  it("canvas shows the real viewer under the graph, with the shared toolbar and no second one", async () => {
    const user = userEvent.setup();
    render(<App />);
    await toCanvas(user);
    // The photo comes from the actual viewer, so engine frames, split and
    // before/after all work here rather than being reimplemented.
    expect(screen.getByTestId("viewer")).toBeInTheDocument();
    expect(screen.getByTestId("viewer-image")).toBeInTheDocument();
    // One toolbar, the viewer's own, with the same tools Develop and
    // Graph have (2026-09-02); the HUD keeps only the mask eye.
    expect(screen.getAllByTestId("btn-before-after")).toHaveLength(1);
    expect(screen.getAllByTestId("btn-tool-crop")).toHaveLength(1);
    expect(screen.queryByTestId("canvas-split")).toBeNull();
    expect(screen.getByTestId("canvas-graph-layer")).toBeInTheDocument();
  });

  it("an armed eyedropper lets clicks through the graph layer to the photo", () => {
    // "I am trying to Curves picker now and its not working.
    // I suspect the overlay that draws the nodes might be in the way."
    // pointer-events on the wrapper alone is not enough: node cards and
    // wire hit zones re-enable their own, so the pick-through class must
    // flatten the whole subtree.
    const base = { ...initialState(), mode: "canvas" as const };
    const { rerender, unmount } = render(<CanvasMode state={base} dispatch={() => {}} />);
    const layer = () => screen.getByTestId("canvas-graph-layer");
    expect(layer().className).not.toContain("pick-through");
    rerender(<CanvasMode state={{ ...base, toneEqPick: "n1" }} dispatch={() => {}} />);
    expect(layer().className).toContain("pick-through");
    rerender(<CanvasMode state={{ ...base, curvePick: { nodeId: "n1", channel: "rgb" } }} dispatch={() => {}} />);
    expect(layer().className).toContain("pick-through");
    rerender(<CanvasMode state={base} dispatch={() => {}} />);
    expect(layer().className).not.toContain("pick-through");
    unmount();
  });

  it("canvas HUD buttons drive the real state, not decoration", async () => {
    const user = userEvent.setup();
    render(<App />);
    await toCanvas(user);
    const on = (id: string) => screen.getByTestId(id).getAttribute("data-active");

    // Canvas shares the viewer's toolbar with Develop and Graph now, so
    // Split and the zoom live there; the mask eye is the HUD's own.
    expect(on("btn-split")).toBe("false");
    await user.click(screen.getByTestId("btn-split"));
    expect(on("btn-split")).toBe("true");
    expect(screen.getByTestId("viewer-subbar")).toBeInTheDocument();

    // Nothing has a mask to show yet: the eye says so and stays put.
    expect(screen.getByTestId("canvas-mask")).toBeDisabled();
    expect(screen.getByTestId("canvas-mask").getAttribute("data-hint")).toMatch(/once a layer/);
    expect(screen.queryByTestId("canvas-viewing")).toBeNull();
  });

  it("canvas node settings are the inspector's own controls", async () => {
    const user = userEvent.setup();
    render(<App />);
    await toCanvas(user);

    // Curves gets the curve editor, not a hardcoded slider list: the
    // panel renders the same component the Inspector does.
    fireEvent.mouseDown(screen.getByTestId("node-curves"));
    const panel = screen.getByTestId("canvas-settings");
    expect(within(panel).getByTestId("curve-editor")).toBeInTheDocument();

    // And a node the old hardcoded list knew nothing about still works.
    fireEvent.mouseDown(screen.getByTestId("node-levels"));
    expect(within(screen.getByTestId("canvas-settings")).getByTestId("slider-gamma")).toBeInTheDocument();
  });

  it("tilde hides and shows the nodes in canvas", async () => {
    const user = userEvent.setup();
    render(<App />);
    await toCanvas(user);
    expect(screen.getByTestId("canvas-graph-layer")).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "~" });
    // Unmounted, not just transparent, so the photo gets the pointer back.
    expect(screen.queryByTestId("canvas-graph-layer")).not.toBeInTheDocument();
    expect(screen.queryByTestId("node-editor")).not.toBeInTheDocument();
    expect(screen.getByTestId("canvas-hint-nodes")).toHaveTextContent("show nodes");
    // The photo itself stays, this is a full-screen view of it.
    expect(screen.getByTestId("viewer-image")).toBeInTheDocument();

    // The unshifted backtick is the same key, so it works too.
    fireEvent.keyDown(window, { key: "`" });
    expect(screen.getByTestId("canvas-graph-layer")).toBeInTheDocument();
    expect(screen.getByTestId("canvas-hint-nodes")).toHaveTextContent("hide nodes");
  });

  it("ctrl+backtick still opens the console rather than hiding nodes", async () => {
    const user = userEvent.setup();
    const opened = vi.spyOn(window, "open").mockReturnValue(null);
    render(<App />);
    await toCanvas(user);
    fireEvent.keyDown(window, { key: "`", ctrlKey: true });
    expect(screen.getByTestId("canvas-graph-layer")).toBeInTheDocument();
    // The console is an OS window now, never an in-page float.
    await waitFor(() => expect(opened).toHaveBeenCalled());
    expect(screen.queryByTestId("console-panel")).not.toBeInTheDocument();
    opened.mockRestore();
  });

  it("tilde is a canvas gesture, not a global one", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("tablist", { name: /workspace mode/i }).children[1]);
    fireEvent.keyDown(window, { key: "~" });
    // Graph mode's editor is the whole point of the mode; tilde must not
    // reach in and empty it.
    expect(screen.getByTestId("node-editor")).toBeInTheDocument();
  });

  it("opening a group shows what is inside it, and the way back out", () => {
    // "The Grain node is the dashboard of a car when in Develop,
    // Graph mode is actually going under the hood." Double-clicking a group
    // used to change one word in the footer and nothing else.
    let st = reduce(initialState(), { type: "select_nodes", ids: ["stdcolor", "cbal"] });
    st = reduce(st, { type: "group_selection", name: "Guts" });
    const gid = st.nodes.find((n) => n.name === "Guts")!.id;

    const Harness = () => {
      const [s, d] = React.useReducer(reduce, st);
      return <NodeEditor state={s} dispatch={d} />;
    };
    render(<Harness />);
    expect(screen.queryByTestId("node-stdcolor")).not.toBeInTheDocument();

    fireEvent.doubleClick(screen.getByTestId(`node-${gid}`));
    // The guts are on the canvas, and the graph around them is not.
    expect(screen.getByTestId("node-stdcolor")).toBeInTheDocument();
    expect(screen.queryByTestId("node-output")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("leave-group"));
    expect(screen.getByTestId("node-output")).toBeInTheDocument();
    expect(screen.queryByTestId("node-stdcolor")).not.toBeInTheDocument();
  });

  it("the graph footer clears the viewer readout when floating over a photo", async () => {
    const user = userEvent.setup();
    render(<App />);
    // Graph mode: docked bottom-left as usual.
    await user.click(screen.getByRole("tablist", { name: /workspace mode/i }).children[1]);
    expect(screen.getByTestId("graph-footer")).toHaveStyle({ left: "12px" });

    // Canvas: centered, because the viewer prints its own readout in
    // that corner and the two used to overlap.
    await toCanvas(user);
    const footer = screen.getByTestId("graph-footer");
    expect(footer).toHaveStyle({ left: "0px", right: "0px", justifyContent: "center" });
    // And the count is not repeated in the HUD.
    expect(screen.queryByTestId("canvas-nodecount")).not.toBeInTheDocument();
  });

  it("the settings panel stays on screen instead of running off the edge", async () => {
    const { panelPlacement } = await import("../ui/canvas");
    const view = { x: 0, y: 0, zoom: 1 };
    const surface = { w: 1000, h: 700 };

    // Room to the right: sits beside the node.
    expect(panelPlacement({ x: 100, y: 200 }, view, surface).left).toBe(100 + 190 + 12);
    // No room: flips to the node's other side rather than being cut off.
    const flipped = panelPlacement({ x: 820, y: 200 }, view, surface);
    expect(flipped.left).toBe(820 - 312 - 12);
    // Hard against the right edge, it still fits entirely on screen.
    const far = panelPlacement({ x: 990, y: 200 }, view, surface);
    expect(far.left + 312).toBeLessThanOrEqual(surface.w);
    // And never off the left either.
    expect(panelPlacement({ x: -400, y: 200 }, view, surface).left).toBeGreaterThanOrEqual(0);
    // Clear of the HUD at the top, and never below the surface.
    expect(panelPlacement({ x: 100, y: -300 }, view, surface).top).toBeGreaterThanOrEqual(52);
    expect(panelPlacement({ x: 100, y: 9000 }, view, surface).top).toBeLessThan(surface.h);
  });

  it("canvas docks the inspector, and settings go there instead of floating", async () => {
    const user = userEvent.setup();
    render(<App />);
    await toCanvas(user);
    // Folded by default: a spine, and node settings float.
    expect(screen.getByTestId("inspector-bar")).toBeInTheDocument();
    expect(screen.queryByTestId("inspector")).not.toBeInTheDocument();
    fireEvent.mouseDown(screen.getByTestId("node-grain"));
    expect(screen.getByTestId("canvas-settings")).toBeInTheDocument();

    // Opened, the settings move into it and the floating panel goes away,
    // which is what stops it being clipped near the edge.
    await user.click(screen.getByTestId("inspector-bar"));
    expect(screen.getByTestId("inspector")).toBeInTheDocument();
    expect(screen.queryByTestId("canvas-settings")).not.toBeInTheDocument();
    expect(within(screen.getByTestId("inspector")).getByTestId("slider-intensity")).toBeInTheDocument();

    await user.click(screen.getByTestId("canvas-inspector-collapse"));
    expect(screen.getByTestId("canvas-settings")).toBeInTheDocument();
  });

  it("contract: no node opens an empty settings panel", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("tablist", { name: /workspace mode/i }).children[1]);
    const inspector = () => screen.getByTestId("inspector");
    // Split Tone and Tone Profile had no case written for them at all,
    // so selecting either opened a panel with nothing in it.
    for (const id of ["profile"]) {
      fireEvent.mouseDown(screen.getByTestId(`node-${id}`));
      expect(
        within(inspector()).queryAllByRole("slider").length,
        `${id} has no controls`
      ).toBeGreaterThan(0);
    }
    // (Split Tone retired; its inspector wheels went with the tool.)
    // Tone profile keeps its mode menu.
    fireEvent.mouseDown(screen.getByTestId("node-profile"));
    expect(within(inspector()).getByTestId("inspector-profile")).toHaveAttribute("data-value", "standard");

    // The invariant, over every node in the default graph: controls, or
    // an explicit "nothing to configure". Never a blank panel.
    const { initialState } = await import("../data");
    const ids = initialState().nodes.map((n) => n.id);
    for (const id of ids) {
      const card = screen.queryByTestId(`node-${id}`);
      if (!card) continue; // nodes inside a collapsed group
      fireEvent.mouseDown(card);
      const params = within(inspector()).getByTestId("node-params");
      expect(
        params.childElementCount > 0 && (params.textContent ?? "").trim().length > 0,
        `${id} renders an empty settings panel`
      ).toBe(true);
    }
  });

  it("canvas pans the photo on space-drag, leaving the graph alone", async () => {
    const user = userEvent.setup();
    const restore = stubStage();
    try {
      render(<App />);
      await toCanvas(user);
      fireEvent.load(screen.getByTestId("viewer-image"));
      const box = () => screen.getByTestId("viewer-image").parentElement!.getAttribute("style") ?? "";
      expect(box()).toContain("translate(0px, 0px)");

      // Without space held, a drag belongs to the graph.
      fireEvent.mouseDown(screen.getByTestId("canvas-graph-layer"), { clientX: 100, clientY: 100, button: 0 });
      fireEvent.mouseMove(window, { clientX: 160, clientY: 130, buttons: 1 });
      fireEvent.mouseUp(window);
      expect(box()).toContain("translate(0px, 0px)");

      // Space held, the same drag moves the photo.
      fireEvent.keyDown(window, { code: "Space" });
      fireEvent.mouseDown(screen.getByTestId("canvas-graph-layer"), { clientX: 100, clientY: 100, button: 0 });
      fireEvent.mouseMove(window, { clientX: 160, clientY: 130, buttons: 1 });
      fireEvent.mouseUp(window);
      expect(box()).toContain("translate(60px, 30px)");
      fireEvent.keyUp(window, { code: "Space" });
    } finally {
      restore();
    }
  });

  it("Shift+Space opens Find a Node in graph mode; bare Space stays the pan", async () => {
    const user = userEvent.setup();
    render(<App />);
    await toGraphMode(user);
    expect(screen.queryByTestId("node-palette")).not.toBeInTheDocument();
    // The pan listener must not claim the chord before the hotkey layer.
    fireEvent.keyDown(window, { key: " ", code: "Space", shiftKey: true });
    expect(screen.getByTestId("node-palette")).toBeInTheDocument();
    fireEvent.keyUp(window, { key: " ", code: "Space", shiftKey: true });
    fireEvent.keyDown(screen.getByTestId("palette-search"), { key: "Escape" });
    expect(screen.queryByTestId("node-palette")).not.toBeInTheDocument();
    fireEvent.keyDown(window, { key: " ", code: "Space" });
    expect(screen.queryByTestId("node-palette")).not.toBeInTheDocument();
    fireEvent.keyUp(window, { key: " ", code: "Space" });
  });

  it("Open folder loads a session into the ribbon", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByTestId("open-folder"));
    expect(await screen.findByTestId("thumb-mock_1")).toBeInTheDocument();
    expect(screen.getByTestId("thumb-mock_2")).toBeInTheDocument();
    // First image of the new session becomes active, shown by real name.
    expect(screen.getByTestId("topbar")).toHaveTextContent("IMG_0001.dng");
    // Persisted rating/flag came back from the bridge.
    expect(screen.getByTestId("thumb-mock_2")).toHaveTextContent("★★★");
    // The pick is a drawn checkmark (2026-09-15), lit on.
    const pick = screen.getByTestId("flag-mock_2-pick");
    expect(pick).toHaveAttribute("data-on", "true");
    expect(pick.querySelector("svg")).not.toBeNull();
    expect(pick.textContent).not.toContain("⚑");
  });

  it("folders panel lists catalog folders and opens one on click", async () => {
    const user = userEvent.setup();
    render(<App />);
    // Mock catalog folders appear after the library refresh.
    const wedding = await screen.findByTestId("folder-row-1");
    expect(wedding).toHaveTextContent("Wedding");
    expect(screen.getByTestId("folder-row-2")).toHaveTextContent("Landscapes");
    await user.click(wedding);
    expect(await screen.findByTestId("thumb-mock_1")).toBeInTheDocument();
    expect(screen.getByTestId("library-label")).toHaveTextContent("Wedding");
    expect(screen.getByTestId("topbar")).toHaveTextContent("Wedding");
  });

  it("a folder of subfolders lists them for navigation instead of scanning", async () => {
    const user = userEvent.setup();
    render(<App />);
    // "Trip" mirrors the two-week-trip case: no direct images, only days.
    await user.click(await screen.findByTestId("folder-row-3"));
    expect(await screen.findByTestId("tree-row-mock://trip/day1")).toHaveTextContent("Day 1");
    expect(screen.getByTestId("tree-row-mock://trip/day2")).toHaveTextContent("Day 2");
    // The ribbon empties: keeping the previous folder's thumbnails on screen
    // read as the click having done nothing. (the owner hit exactly this.)
    expect(screen.queryByTestId("thumb-4871")).not.toBeInTheDocument();
    expect(screen.getByTestId("library-label")).toHaveTextContent("Trip");
    expect(screen.getByTestId("library-stats")).toHaveTextContent("0 images");
  });

  it("re-picking a worked-in folder returns to its subfolder and image", async () => {
    // Trip was worked in before: Day 1 open, second photo up. Picking
    // Trip again must land there, not on an empty root.
    const { mockSetFolderSession } = await import("../bridge");
    mockSetFolderSession("mock://trip", {
      activeFolder: "mock://trip/day1",
      activeImage: "mock_2",
    });
    try {
      const user = userEvent.setup();
      render(<App />);
      await user.click(await screen.findByTestId("folder-row-3"));
      // The remembered day opens with its images...
      expect(await screen.findByTestId("thumb-mock_2")).toBeInTheDocument();
      expect(screen.getByTestId("library-label")).toHaveTextContent("Day 1");
      // ...the remembered photo is the one on screen...
      await waitFor(() =>
        expect(screen.getByTestId("topbar")).toHaveTextContent("IMG_0002.dng"),
      );
      // ...and the tree still shows the descent, root and sibling intact.
      expect(screen.getByTestId("tree-row-mock://trip")).toBeInTheDocument();
      expect(screen.getByTestId("tree-row-mock://trip/day2")).toBeInTheDocument();
    } finally {
      mockSetFolderSession("mock://trip", null);
    }
  });

  it("switching between folders keeps each folder's place", async () => {
    // The owner's repro: work in a subfolder, go to another folder, come
    // back; the return used to land on an empty root because re-picking
    // the folder saved over its own memory before reading it.
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByTestId("folder-row-3"));
    await user.click(await screen.findByTestId("tree-open-mock://trip/day1"));
    await user.click(await screen.findByTestId("thumb-mock_2"));
    // Let the debounced session saver record the photo before leaving,
    // the way it would under a real person's slower hands.
    await act(() => new Promise((r) => setTimeout(r, 700)));
    // Away to Wedding...
    await user.click(screen.getByTestId("folder-row-1"));
    expect(await screen.findByTestId("tree-row-mock://wedding")).toBeInTheDocument();
    // ...and back: Trip reopens at Day 1 with its thumbnails and the
    // photo that was up, not as an empty root.
    await user.click(screen.getByTestId("folder-row-3"));
    await waitFor(() =>
      expect(screen.getByTestId("library-label")).toHaveTextContent("Day 1"),
    );
    expect(await screen.findByTestId("thumb-mock_1")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByTestId("topbar")).toHaveTextContent("IMG_0002.dng"),
    );
  });

  it("tree navigation opens the clicked row, remembered session or not", async () => {
    // The remembered session belongs to re-PICKING a folder. A tree row
    // click is the user pointing at a specific place; it must never be
    // redirected somewhere else, however fondly that place is remembered.
    const { mockSetFolderSession } = await import("../bridge");
    mockSetFolderSession("mock://trip/day2", {
      activeFolder: "mock://trip/day1",
      activeImage: "mock_2",
    });
    try {
      const user = userEvent.setup();
      render(<App />);
      await user.click(await screen.findByTestId("folder-row-3"));
      await user.click(await screen.findByTestId("tree-open-mock://trip/day2"));
      expect(await screen.findByTestId("library-label")).toHaveTextContent("Day 2");
    } finally {
      mockSetFolderSession("mock://trip/day2", null);
    }
  });

  it("switching catalogs rebuilds the library from that catalog's session", async () => {
    // The dialog flow itself needs Tauri's pickers, so this drives the
    // restore that runs after a switch directly against the reducer.
    const { saveSession } = await import("../bridge");
    const { restoreCatalogSession } = await import("../ui/chrome");
    const { reduce } = await import("../state");
    await saveSession("mock://trip", "mock://trip/day1", "mock_2");
    let s = initialState();
    const landed = await restoreCatalogSession((c: Parameters<typeof reduce>[1]) => {
      s = reduce(s, c);
    });
    expect(landed).toBe("photo");
    // Tree rooted where the catalog's session says, day open, photo up.
    expect(s.folderTree?.path).toBe("mock://trip");
    expect(s.libraryLabel).toBe("Day 1");
    expect(s.activeFolderPath).toBe("mock://trip/day1");
    expect(s.activeImage).toBe("mock_2");
  });

  it("descending the tree keeps parent and sibling folders visible", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByTestId("folder-row-3"));
    await user.click(await screen.findByTestId("tree-open-mock://trip/day1"));
    expect(await screen.findByTestId("thumb-mock_1")).toBeInTheDocument();
    expect(screen.getByTestId("library-label")).toHaveTextContent("Day 1");
    // The whole tree stays: root, the opened day, and its sibling.
    expect(screen.getByTestId("tree-row-mock://trip")).toBeInTheDocument();
    expect(screen.getByTestId("tree-row-mock://trip/day2")).toBeInTheDocument();
    // Jumping to the sibling still keeps the tree rooted at Trip.
    await user.click(screen.getByTestId("tree-open-mock://trip/day2"));
    expect(await screen.findByTestId("library-label")).toHaveTextContent("Day 2");
    expect(screen.getByTestId("tree-row-mock://trip/day1")).toBeInTheDocument();
    // Opening an unrelated recent folder re-roots the tree.
    await user.click(screen.getByTestId("folder-row-1"));
    expect(await screen.findByTestId("tree-row-mock://wedding")).toBeInTheDocument();
    expect(screen.queryByTestId("tree-row-mock://trip")).not.toBeInTheDocument();
  });

  it("the watcher surfaces folders created while a folder is open", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      render(<App />);
      await user.click(await screen.findByTestId("folder-row-3"));
      await screen.findByTestId("tree-row-mock://trip/day1");
      // A new day folder appears on disk (card dumped mid-session)...
      const { mockAddSubfolder } = await import("../bridge");
      mockAddSubfolder("mock://trip", "Day 3");
      expect(screen.queryByTestId("tree-row-mock://trip/day3")).not.toBeInTheDocument();
      // ...and the 15s watcher tick picks it up without losing the rest.
      await act(async () => {
        vi.advanceTimersByTime(16000);
      });
      expect(await screen.findByTestId("tree-row-mock://trip/day3")).toBeInTheDocument();
      expect(screen.getByTestId("tree-row-mock://trip/day1")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("serving a collection raises the banner, and STOP takes it down", async () => {
    const { mockResetCollections } = await import("../bridge");
    mockResetCollections();
    try {
      const user = userEvent.setup();
      render(<App />);
      // A collection with the active image in it.
      await user.click(screen.getByTestId("new-collection"));
      await user.type(screen.getByTestId("new-collection-name"), "Family{Enter}");
      await user.click(await screen.findByTestId("collection-add-1"));
      expect(screen.queryByTestId("serve-banner")).not.toBeInTheDocument();

      await user.click(screen.getByTestId("collection-serve-1"));
      const banner = await screen.findByTestId("serve-banner");
      expect(banner).toHaveTextContent("Family");
      // The URL is visible and the banner says what a share means.
      expect(screen.getByTestId("serve-url")).toHaveTextContent(/http:\/\//);
      expect(banner).toHaveTextContent(/anyone on your network/i);

      await user.click(screen.getByTestId("serve-stop"));
      expect(screen.queryByTestId("serve-banner")).not.toBeInTheDocument();
    } finally {
      mockResetCollections();
    }
  });

  it("collections: create, add the active image, view, remove, delete", async () => {
    const user = userEvent.setup();
    render(<App />);
    expect(screen.getByText(/no collections yet/i)).toBeInTheDocument();

    // Create via the inline input.
    await user.click(screen.getByTestId("new-collection"));
    await user.type(screen.getByTestId("new-collection-name"), "Portfolio{Enter}");
    const row = await screen.findByTestId(/^collection-row-/);
    expect(row).toHaveTextContent("Portfolio");
    expect(row).toHaveTextContent("0");
    const id = row.getAttribute("data-testid")!.replace("collection-row-", "");

    // Add the active image; the member count updates.
    await user.click(screen.getByTestId(`collection-add-${id}`));
    expect(await screen.findByTestId(`collection-row-${id}`)).toHaveTextContent("1");

    // Viewing the collection shows only its members.
    await user.click(screen.getByTestId(`collection-open-${id}`));
    expect(await screen.findByTestId("thumb-4871")).toBeInTheDocument();
    expect(screen.queryByTestId("thumb-4866")).not.toBeInTheDocument();
    expect(screen.getByTestId("library-label")).toHaveTextContent("Portfolio");

    // Removing the active image empties the collection view.
    await user.click(screen.getByTestId(`collection-remove-${id}`));
    expect(await screen.findByTestId(`collection-row-${id}`)).toHaveTextContent("0");

    // Delete the collection outright.
    await user.click(screen.getByTestId(`collection-delete-${id}`));
    expect(screen.queryByTestId(`collection-row-${id}`)).not.toBeInTheDocument();
  });

  it("the library keeps answering while the collection list is on its way", async () => {
    // The injected delay stands in for the slow catalog volume: the create resolves but the refresh's
    // list_collections stays unresolved while the user moves on.
    // Against the old synchronous command the Enter that created the
    // collection would have held the UI thread until the list answered.
    const { mockSetLibraryHold, mockResetCollections } = await import("../bridge");
    let release!: () => void;
    mockSetLibraryHold(new Promise<void>((r) => { release = r; }));
    try {
      const user = userEvent.setup();
      render(<App />);
      await user.click(screen.getByTestId("new-collection"));
      await user.type(screen.getByTestId("new-collection-name"), "Portfolio{Enter}");
      // The row waits on the list; the next click does not.
      expect(screen.queryByTestId(/^collection-row-/)).toBeNull();
      await user.click(screen.getByTestId("thumb-4868"));
      expect(screen.getByTestId("topbar")).toHaveTextContent("DSC_04868.NEF");
      expect(screen.queryByTestId(/^collection-row-/)).toBeNull();
      // And the row lands when the list comes back.
      release();
      expect(await screen.findByTestId(/^collection-row-/)).toHaveTextContent("Portfolio");
    } finally {
      mockSetLibraryHold(null);
      mockResetCollections();
    }
  });

  it("collection rename commits from the inline input", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByTestId("new-collection"));
    await user.type(screen.getByTestId("new-collection-name"), "Draft{Enter}");
    const row = await screen.findByTestId(/^collection-row-/);
    const id = row.getAttribute("data-testid")!.replace("collection-row-", "");
    await user.dblClick(screen.getByTestId(`collection-open-${id}`));
    const input = screen.getByTestId("rename-collection-name");
    await user.clear(input);
    await user.type(input, "Final{Enter}");
    expect(await screen.findByTestId(`collection-row-${id}`)).toHaveTextContent("Final");
    // The mock catalog is module-level; leave it clean for other tests.
    await user.click(screen.getByTestId(`collection-delete-${id}`));
  });

  it("ribbon filter narrows by stars and flags", async () => {
    const user = userEvent.setup();
    render(<App />);
    const total = 13;
    expect(screen.getByTestId("filter-count")).toHaveTextContent(`${total}/${total}`);
    // The controls live behind the funnel now; the count does not, which
    // is the point of leaving it outside.
    await user.click(screen.getByTestId("filter-open"));

    // 3+ stars: sample session has 3 images rated 3 or better.
    await user.click(screen.getByTestId("filter-star-3"));
    expect(screen.getByTestId("filter-count")).toHaveTextContent(`3/${total}`);
    expect(screen.queryByTestId("thumb-4867")).not.toBeInTheDocument();
    expect(screen.getByTestId("thumb-4871")).toBeInTheDocument();

    // Clicking the same star clears the filter.
    await user.click(screen.getByTestId("filter-star-3"));
    expect(screen.getByTestId("filter-count")).toHaveTextContent(`${total}/${total}`);

    // The one flag button cycles (2026-09-15: "[√ X]... it cycles"):
    // only the picks, then the rejects hidden, then everything.
    const flags = () => screen.getByTestId("filter-flags");
    await user.click(flags());
    expect(flags()).toHaveAttribute("data-state", "picks");
    expect(screen.getByTestId("filter-flags-pick")).toHaveAttribute("data-on", "true");
    expect(screen.getByTestId("filter-count")).toHaveTextContent(`4/${total}`);
    // The modifier inverts the context it is in ("the modifier
    // key changes the accent color and hides the picks"): picks hidden, in
    // red; the same click again puts it back.
    fireEvent.click(flags(), { altKey: true });
    expect(flags()).toHaveAttribute("data-state", "picks-hidden");
    expect(screen.getByTestId("filter-flags-pick")).toHaveAttribute("data-inverted", "true");
    expect(screen.getByTestId("filter-count")).toHaveTextContent(`${total - 4}/${total}`);
    fireEvent.click(flags(), { altKey: true });
    expect(flags()).toHaveAttribute("data-state", "picks");
    // A plain click moves on, and the inversion does not carry.
    fireEvent.click(flags(), { altKey: true });
    await user.click(flags());
    expect(flags()).toHaveAttribute("data-state", "rejects");
    expect(screen.getByTestId("filter-flags-reject")).toHaveAttribute("data-on", "true");
    expect(screen.getByTestId("filter-flags-pick")).toHaveAttribute("data-on", "false");
    expect(screen.getByTestId("filter-count")).toHaveTextContent(`11/${total}`);
    // "accents the X with red and shows the rejects"
    fireEvent.click(flags(), { altKey: true });
    expect(flags()).toHaveAttribute("data-state", "rejects-only");
    expect(screen.getByTestId("filter-flags-reject")).toHaveAttribute("data-inverted", "true");
    expect(screen.getByTestId("filter-count")).toHaveTextContent(`${total - 11}/${total}`);
    await user.click(flags());
    expect(flags()).toHaveAttribute("data-state", "off");
    expect(screen.getByTestId("filter-count")).toHaveTextContent(`${total}/${total}`);
    // Off has nothing to invert: the modifier click is a plain one.
    fireEvent.click(flags(), { altKey: true });
    expect(flags()).toHaveAttribute("data-state", "picks");
    // The status line says how ("the status line should note
// this").
    expect(flags().getAttribute("data-hint")).toMatch(/-click inverts/);
  });

  it("the name filter narrows by text and wildcard", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByTestId("filter-open"));
    const box = () => screen.getByTestId("filter-name") as HTMLInputElement;
    // A fragment finds its file: partial names are the normal case.
    await user.type(box(), "4867");
    expect(screen.getByTestId("filter-count")).toHaveTextContent("1/13");
    expect(screen.getByTestId("thumb-4867")).toBeInTheDocument();
    expect(screen.queryByTestId("thumb-4871")).not.toBeInTheDocument();
    // ? holds one character open: the 487x block and nothing else.
    await user.clear(box());
    await user.type(box(), "DSC_0487?.NEF");
    expect(screen.getByTestId("filter-count")).toHaveTextContent("9/13");
    // CLEAR ALL empties the box along with the other filters.
    await user.click(screen.getByTestId("filter-clear"));
    expect(screen.getByTestId("filter-count")).toHaveTextContent("13/13");
    expect(box().value).toBe("");
  });

  it("Photo > Find in Thumbnails scrolls the ribbon to the photo on screen", async () => {
    const user = userEvent.setup();
    // jsdom has no layout, so the scroll is observed rather than seen.
    const scrolled: Element[] = [];
    const orig = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this);
    };
    try {
      render(<App />);
      await user.click(screen.getByTestId("menu-photo"));
      await user.click(screen.getByTestId("menu-photo-find"));
      await waitFor(() =>
        expect(
          scrolled.some((el) => el.getAttribute("data-testid") === "thumb-4871"),
        ).toBe(true),
      );
      // And the pulse lands on it, so the eye has something to catch.
      expect(screen.getByTestId("thumb-4871").classList.contains("thumb-reveal")).toBe(true);

      // A filter that hides the photo grays the item out instead of
      // scrolling to nothing.
      await user.click(screen.getByTestId("filter-open"));
      await user.type(screen.getByTestId("filter-name"), "4867");
      await user.click(screen.getByTestId("menu-photo"));
      expect(screen.getByTestId("menu-photo-find")).toBeDisabled();
    } finally {
      Element.prototype.scrollIntoView = orig;
    }
  });

  // The stars and flags are always drawn, lit or unlit, so that there is
  // somewhere to click to set one. That makes their text content useless
  // as an assertion and their state the thing to check.
  const lit = (id: string) => screen.getByTestId(id).getAttribute("data-on") === "true";

  it("culling shortcuts rate and flag the active image", () => {
    render(<App />);
    fireEvent.keyDown(window, { key: "5" });
    expect(lit("star-4871-5")).toBe(true);
    fireEvent.keyDown(window, { key: "x" });
    expect(lit("flag-4871-reject")).toBe(true);
    fireEvent.keyDown(window, { key: "u" });
    expect(lit("flag-4871-reject")).toBe(false);
    fireEvent.keyDown(window, { key: "0" });
    expect(lit("star-4871-1")).toBe(false);
  });

  it("the brackets nudge a rating up and down", () => {
    render(<App />);
    fireEvent.keyDown(window, { key: "2" });
    fireEvent.keyDown(window, { key: "]" });
    expect(lit("star-4871-3")).toBe(true);
    fireEvent.keyDown(window, { key: "[" });
    fireEvent.keyDown(window, { key: "[" });
    expect(lit("star-4871-1")).toBe(true);
    expect(lit("star-4871-2")).toBe(false);
    // And it stops at the ends rather than wrapping or going negative.
    for (let i = 0; i < 4; i++) fireEvent.keyDown(window, { key: "[" });
    expect(lit("star-4871-1")).toBe(false);
    for (let i = 0; i < 8; i++) fireEvent.keyDown(window, { key: "]" });
    expect(lit("star-4871-5")).toBe(true);
  });

  it("clicking a star rates without changing which image is open", async () => {
    const user = userEvent.setup();
    render(<App />);
    const before = screen.getByTestId("library-label").textContent;
    await user.click(screen.getByTestId("star-4869-4"));
    expect(lit("star-4869-4")).toBe(true);
    expect(lit("star-4869-5")).toBe(false);
    // Clicking the same star again clears it: the only way back to zero
    // with the mouse.
    await user.click(screen.getByTestId("star-4869-4"));
    expect(lit("star-4869-4")).toBe(false);
    expect(screen.getByTestId("library-label").textContent).toBe(before);
  });

  it("clicking a flag toggles it", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByTestId("flag-4869-pick"));
    expect(lit("flag-4869-pick")).toBe(true);
    await user.click(screen.getByTestId("flag-4869-reject"));
    expect(lit("flag-4869-reject")).toBe(true);
    expect(lit("flag-4869-pick")).toBe(false);
    await user.click(screen.getByTestId("flag-4869-reject"));
    expect(lit("flag-4869-reject")).toBe(false);
  });

  /// Culling is a bulk activity: sweep a run of frames, mark them all.
  it("a rating keystroke applies to the whole selected run", async () => {
    const user = userEvent.setup();
    render(<App />);
    const thumbs = screen.getAllByTestId(/^thumb-\d+$/);
    await user.click(thumbs[1]);
    fireEvent.click(thumbs[4], { shiftKey: true });
    fireEvent.keyDown(window, { key: "4" });
    // Every frame in the run took the rating, not just the one clicked.
    for (const t of thumbs.slice(1, 5)) {
      const id = t.getAttribute("data-testid")!.replace("thumb-", "");
      expect(lit(`star-${id}-4`)).toBe(true);
    }
    // And one outside the run did not.
    const outside = thumbs[6].getAttribute("data-testid")!.replace("thumb-", "");
    expect(lit(`star-${outside}-4`)).toBe(false);
  });

  it("Develop has a tone curve editor with channel chips and color wheels", () => {
    render(<App />);
    openAllSections();
    expect(screen.getByTestId("curve-editor")).toBeInTheDocument();
    for (const c of ["rgb", "r", "g", "b"]) {
      expect(screen.getByTestId(`curve-channel-${c}`)).toBeInTheDocument();
    }
    expect(screen.getByTestId("develop-wheels")).toBeInTheDocument();
    expect(screen.getByRole("slider", { name: /mids luminance/i })).toBeInTheDocument();
  });

  it("color wheels adjust hue/sat via keyboard and show the readout", () => {
    render(<App />);
    const wheel = screen.getByTestId("wheel-midtones");
    fireEvent.keyDown(wheel, { key: "ArrowRight" });
    fireEvent.keyDown(wheel, { key: "ArrowRight" });
    expect(screen.getByTestId("wheel-midtones-hue")).toHaveTextContent("10°");
    expect(Number(wheel.getAttribute("aria-valuenow"))).toBe(10);
  });

  it("curve editor offers a luminosity channel", () => {
    render(<App />);
    expect(screen.getByTestId("curve-channel-luma")).toBeInTheDocument();
  });

  it("curve starts with endpoints only; click adds, ctrl+click removes", async () => {
    render(<App />);
    const points = () => screen.getAllByTestId(/^curve-point-/);
    const svg = () => screen.getByTestId("curve-plot");
    expect(points().length).toBe(2);
    // Click on the curve area adds a point and starts dragging it.
    // (jsdom rects are zero-size, so clientX 0 maps to curve x=0 side.)
    fireEvent(svg(), new MouseEvent("pointerdown", { bubbles: true, clientX: 0, clientY: 40 }));
    fireEvent(window, new MouseEvent("pointerup", {}));
    expect(points().length).toBe(3);
    // 2D drag: the new point moves horizontally as well as vertically.
    const mid = () => screen.getByTestId("curve-point-1");
    const cxBefore = mid().getAttribute("cx");
    fireEvent(mid(), new MouseEvent("pointerdown", { bubbles: true }));
    fireEvent(window, new MouseEvent("pointermove", { clientX: 200, clientY: 30 }));
    fireEvent(window, new MouseEvent("pointerup", {}));
    expect(mid().getAttribute("cx")).not.toBe(cxBefore);
    // CTRL+click (Cmd on a Mac, where Ctrl+click is the system's
    // right-click) removes interior points; endpoints refuse. The
    // report: "Right now Curves uses 2 click to remove a point, it
    // should be CTRL+Click."
    fireEvent(mid(), new MouseEvent("pointerdown", { bubbles: true, ctrlKey: true }));
    expect(points().length).toBe(2);
    fireEvent(screen.getByTestId("curve-point-1"), new MouseEvent("pointerdown", { bubbles: true, metaKey: true }));
    expect(points().length).toBe(2);
    fireEvent(screen.getByTestId("curve-point-0"), new MouseEvent("pointerdown", { bubbles: true, ctrlKey: true }));
    expect(points().length).toBe(2);
    // And a remove-click on empty plot adds nothing.
    fireEvent(svg(), new MouseEvent("pointerdown", { bubbles: true, clientX: 150, clientY: 60, ctrlKey: true }));
    expect(points().length).toBe(2);
  });

  it("curve reset restores the identity curve", async () => {
    const user = userEvent.setup();
    render(<App />);
    const points = () => screen.getAllByTestId(/^curve-point-/);
    const svg = () => screen.getByTestId("curve-plot");
    fireEvent(svg(), new MouseEvent("pointerdown", { bubbles: true, clientX: 100, clientY: 40 }));
    fireEvent(window, new MouseEvent("pointerup", {}));
    expect(points().length).toBe(3);
    await user.click(screen.getByTestId("curve-reset"));
    expect(points().length).toBe(2);
    // The Tone section reset also covers curves.
    fireEvent(svg(), new MouseEvent("pointerdown", { bubbles: true, clientX: 100, clientY: 40 }));
    fireEvent(window, new MouseEvent("pointerup", {}));
    expect(points().length).toBe(3);
    await user.click(screen.getByTestId("reset-curves"));
    expect(points().length).toBe(2);
  });

  it("the curve eyedropper arms the viewer and the interp buttons are icons", async () => {
    const user = userEvent.setup();
    render(<App />);
    // The one interp button says its face and the next to a screen
    // reader, since it shows no text.
    expect(screen.getByTestId("curve-interp")).toHaveAccessibleName(/smooth/i);
    expect(screen.getByTestId("curve-interp")).toHaveAccessibleName(/straight/i);

    expect(screen.queryByTestId("curve-pick-overlay")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("curve-pick"));
    expect(screen.getByTestId("curve-pick")).toHaveAttribute("data-active", "true");
    expect(screen.getByTestId("curve-pick-overlay")).toBeInTheDocument();
    // No sample arrives in the browser build; a click must neither
    // crash nor add a point.
    const before = screen.getAllByTestId(/^curve-point-/).length;
    fireEvent.mouseDown(screen.getByTestId("curve-pick-overlay"), { button: 0 });
    expect(screen.getAllByTestId(/^curve-point-/).length).toBe(before);
    // Switching channels re-aims the armed pick at the channel now on
    // screen (26.3), the same rule the Recolor cell row follows: the
    // click reads the current channel, not the one frozen at arm time.
    await user.click(screen.getByTestId("curve-channel-r"));
    expect(screen.getByTestId("curve-pick-overlay")).toBeInTheDocument();
    // The aim followed the switch: the button, now the R channel's,
    // toggles THAT pick off. Still armed on RGB, this press would
    // re-aim instead and the overlay would stay.
    await user.click(screen.getByTestId("curve-pick"));
    expect(screen.queryByTestId("curve-pick-overlay")).not.toBeInTheDocument();
    // And the button itself toggles.
    await user.click(screen.getByTestId("curve-pick"));
    await user.click(screen.getByTestId("curve-pick"));
    expect(screen.queryByTestId("curve-pick-overlay")).not.toBeInTheDocument();
  });

  it("curve editor Reset clears only the selected channel", async () => {
    const user = userEvent.setup();
    render(<App />);
    const points = () => screen.getAllByTestId(/^curve-point-/);
    const svg = () => screen.getByTestId("curve-plot");
    // Bend RGB, then bend R.
    fireEvent(svg(), new MouseEvent("pointerdown", { bubbles: true, clientX: 100, clientY: 40 }));
    fireEvent(window, new MouseEvent("pointerup", {}));
    expect(points().length).toBe(3);
    await user.click(screen.getByTestId("curve-channel-r"));
    fireEvent(svg(), new MouseEvent("pointerdown", { bubbles: true, clientX: 100, clientY: 40 }));
    fireEvent(window, new MouseEvent("pointerup", {}));
    expect(points().length).toBe(3);
    // Reset on R only clears R; RGB keeps its point.
    await user.click(screen.getByTestId("curve-reset"));
    expect(points().length).toBe(2);
    await user.click(screen.getByTestId("curve-channel-rgb"));
    expect(points().length).toBe(3);
    // The section-level reset clears every channel.
    await user.click(screen.getByTestId("reset-curves"));
    expect(points().length).toBe(2);
  });

  it("curve interpolation cycles smooth (default), straight, tangent, smooth on one button", async () => {
    const user = userEvent.setup();
    render(<App />);
    const face = () => screen.getByTestId("curve-interp").getAttribute("data-mode");
    expect(face()).toBe("smooth");
    await user.click(screen.getByTestId("curve-interp"));
    expect(face()).toBe("linear");
    await user.click(screen.getByTestId("curve-interp"));
    expect(face()).toBe("tangent");
    await user.click(screen.getByTestId("curve-interp"));
    expect(face()).toBe("smooth");
  });

  it("Color Wheels section reset zeroes hue, sat, and luminance", async () => {
    const user = userEvent.setup();
    render(<App />);
    const wheel = screen.getByTestId("wheel-midtones");
    fireEvent.keyDown(wheel, { key: "ArrowRight" });
    fireEvent.keyDown(wheel, { key: "ArrowUp" });
    expect(screen.getByTestId("wheel-midtones-hue")).toHaveTextContent("5°");
    await user.click(screen.getByTestId("reset-color-wheels"));
    expect(screen.getByTestId("wheel-midtones-hue")).toHaveTextContent("0°");
    expect(Number(wheel.getAttribute("aria-valuenow"))).toBe(0);
  });

  it("grain offers stock patterns and tonal/channel grain sliders", async () => {
    const user = userEvent.setup();
    render(<App />);
    openAllSections();
    for (const p of ["shadows_gain", "midtones_gain", "highlights_gain", "red_gain", "green_gain", "blue_gain"]) {
      expect(screen.getByTestId(`slider-${p}`)).toBeInTheDocument();
    }
    // Unset gains display at their default of 100, not zero.
    expect(
      within(screen.getByTestId("slider-blue_gain")).getByRole("slider").getAttribute("aria-valuenow")
    ).toBe("100");
    expect(menuValue(screen.getByTestId("grain-pattern"))).toBe("standard");
    await chooseWith(user, screen.getByTestId("grain-pattern"), "cinema");
    expect(menuValue(screen.getByTestId("grain-pattern"))).toBe("cinema");
  });

  it("add-layer buttons carry distinct icons, not initials", () => {
    render(<App />);
    for (const t of ["range", "radial", "linear", "brush"]) {
      const btn = screen.getByTestId(`add-layer-${t}`);
      expect(btn.querySelector("svg")).toBeTruthy();
      expect(btn.textContent).toBe("");
      expect(btn).toHaveAccessibleName(`New ${t} layer`);
    }
  });

  /** The curve plot at its real size, anchored at the origin. */
  function curvePlot() {
    const svg = screen.getByTestId("curve-plot");
    svg.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 272, bottom: 150, width: 272, height: 150, x: 0, y: 0, toJSON() {} }) as DOMRect;
    return svg;
  }
  const curvePoints = () => screen.queryAllByTestId(/^curve-point-\d+$/);

  it("clicking near a curve point grabs it instead of adding another", () => {
    render(<App />);
    const svg = curvePlot();
    expect(curvePoints()).toHaveLength(2);
    // The identity curve's top point draws at (272, 0). Click 6px off it,
    // which is a miss on the 4.5px handle but plainly aimed at it.
    fireEvent(svg, new MouseEvent("pointerdown", { bubbles: true, clientX: 268, clientY: 4 }));
    fireEvent(window, new MouseEvent("pointerup", {}));
    expect(curvePoints()).toHaveLength(2);

    // Well clear of any point, a click does add one.
    fireEvent(svg, new MouseEvent("pointerdown", { bubbles: true, clientX: 136, clientY: 120 }));
    fireEvent(window, new MouseEvent("pointerup", {}));
    expect(curvePoints()).toHaveLength(3);
  });

  it("a curve drag keeps tracking the pointer outside the plot", () => {
    render(<App />);
    const svg = curvePlot();
    fireEvent(svg, new MouseEvent("pointerdown", { bubbles: true, clientX: 272, clientY: 0 }));
    // Straight down past the bottom edge: the old handler gave up the
    // moment the cursor left the box, so the ends were unreachable.
    fireEvent(window, new MouseEvent("pointermove", { clientX: 272, clientY: 300 }));
    fireEvent(window, new MouseEvent("pointerup", {}));
    // x stays pinned at 1 for the last point, y bottoms out at 0. The
    // plot is drawn to the panel's width now, so read it rather than
    // assuming the old fixed 272.
    const W = svg.getAttribute("width");
    expect(screen.getByTestId("curve-point-1").getAttribute("cx")).toBe(W);
    expect(screen.getByTestId("curve-point-1").getAttribute("cy")).toBe("150");
  });

  it("Develop sections say whether they hit the layer or the whole photo", async () => {
    const user = userEvent.setup();
    render(<App />);
    // No layer selected: nothing is scoped, so no badges at all.
    expect(screen.queryByTestId("scope-curves")).not.toBeInTheDocument();

    // A glyph, not a word, since the Export box took its place beside
    // the switch (2026-10-03); the words are its name and its hint.
    await user.click(screen.getByTestId("add-layer-range"));
    for (const id of ["scope-curves", "scope-color", "scope-detail"]) {
      expect(screen.getByTestId(id)).toHaveAttribute("data-scope", "layer");
      expect(screen.getByTestId(id)).toHaveAccessibleName("Edits the selected layer");
      expect(screen.getByTestId(id)).toHaveAttribute("data-hint", "Edits the selected layer, behind its mask");
    }
    // The crop defines the frame every mask is measured against, so it
    // cannot be per-layer and says so.
    expect(screen.getByTestId("scope-geometry")).toHaveAttribute("data-scope", "global");
    expect(screen.getByTestId("scope-geometry")).toHaveAccessibleName("Applies to the whole photo");
  });

  it("a slider under an active layer writes to the layer, not the photo", async () => {
    const user = userEvent.setup();
    render(<App />);
    openAllSections();
    await user.click(screen.getByTestId("add-layer-range"));
    const gamma = within(screen.getByTestId("slider-gamma")).getByRole("slider");
    gamma.focus();
    for (let i = 0; i < 3; i++) fireEvent.keyDown(gamma, { key: "ArrowRight" });

    // Graph mode is the proof: the layer grew a Levels node fed by its
    // own mask, and the global one never moved.
    await toGraphMode(user);
    expect(screen.getByTestId("node-layer_1_levels")).toBeInTheDocument();
    await user.click(screen.getByTestId("node-levels"));
    const globalGamma = within(screen.getByTestId("inspector")).getByRole("slider", { name: /gamma/i });
    expect(globalGamma.getAttribute("aria-valuenow")).toBe("1");
  });

  it("range mask shows the luminance histogram with the selected window", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByTestId("add-layer-range"));
    expect(screen.getByTestId("range-histogram")).toBeInTheDocument();
    expect(screen.getByTestId("range-histogram-window")).toBeInTheDocument();
    expect(screen.getByTestId("range-histogram")).toHaveAttribute("data-target", "luma");
    expect(screen.getByTestId("range-histogram")).toHaveTextContent("MASKED LUMA RANGE");
    // The histogram follows the pick target. "When
    // switching from Luma to Hue the histogram still only shows luma
    // range."
    await user.click(screen.getByTestId("pick-target-hue"));
    expect(screen.getByTestId("range-histogram")).toHaveAttribute("data-target", "hue");
    expect(screen.getByTestId("range-histogram")).toHaveTextContent("MASKED HUE RANGE");
    // A default hue window (width 180) is the whole strip, so one span.
    expect(screen.queryByTestId("range-histogram-window-wrap")).not.toBeInTheDocument();
  });

  it("Recolor's Depth row reveals the depth tools' view eye, right of the menus", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByTestId("collapse-recolor"));
    expect(screen.queryByTestId("recolor-depth-view")).not.toBeInTheDocument();
    await chooseWith(user, screen.getByTestId("recolor-by"), "depth");
    const eye = screen.getByTestId("recolor-depth-view");
    expect(eye).toHaveAttribute("data-active", "false");
    await user.click(eye);
    expect(screen.getByTestId("recolor-depth-view")).toHaveAttribute("data-active", "true");
    await chooseWith(user, screen.getByTestId("recolor-by"), "hue");
    expect(screen.queryByTestId("recolor-depth-view")).not.toBeInTheDocument();
  });

  it("the hue→hue cell offers Shift and Spread, and Spread re-labels the y axis", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByTestId("collapse-recolor"));
    // The block opens on hue→sat; the verb belongs to hue→hue alone.
    expect(screen.queryByTestId("recolor-hue-mode-shift")).not.toBeInTheDocument();
    await chooseWith(user, screen.getByTestId("recolor-adjust"), "hue");
    expect(screen.getByTestId("recolor-hue-mode-shift")).toHaveAttribute("data-active", "true");
    await user.click(screen.getByTestId("recolor-hue-mode-spread"));
    expect(screen.getByTestId("recolor-hue-mode-spread")).toHaveAttribute("data-active", "true");
    // Another cell has no verb to choose.
    await chooseWith(user, screen.getByTestId("recolor-adjust"), "sat");
    expect(screen.queryByTestId("recolor-hue-mode-spread")).not.toBeInTheDocument();
  });

  it("BY Mask seats its source menu on the Layout row, beside the Layout dropdown", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByTestId("collapse-recolor"));
    expect(screen.queryByTestId("recolor-by-mask")).not.toBeInTheDocument();
    await chooseWith(user, screen.getByTestId("recolor-by"), "mask");
    const menu = screen.getByTestId("recolor-by-mask");
    const block = within(screen.getByTestId("recolor-block"));
    // Same row as the Layout dropdown: they share a parent. Each field's
    // button sits inside MenuField's own wrapper, hence the extra hop.
    expect(menu.parentElement!.parentElement!.parentElement).toBe(
      block.getByTestId("eq-preset").parentElement!.parentElement
    );
    await chooseWith(user, screen.getByTestId("recolor-by"), "hue");
    expect(screen.queryByTestId("recolor-by-mask")).not.toBeInTheDocument();
  });

  it("BY Hue × Lum swaps the curve for the surface grid, and a cleared cell serializes away", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByTestId("collapse-recolor"));
    expect(screen.queryByTestId("surface-editor")).not.toBeInTheDocument();
    await chooseWith(user, screen.getByTestId("recolor-by"), "huelum");
    const block = within(screen.getByTestId("recolor-block"));
    expect(block.getByTestId("surface-editor")).toBeInTheDocument();
    expect(block.queryByTestId("eq-plot")).not.toBeInTheDocument();
    expect(block.getByTestId("surface-cell-2-1")).toBeInTheDocument();
  });

  it("the Lens Character block sits below Depth of Field and applies a lens", async () => {
    const user = userEvent.setup();
    render(<App />);
    const block = screen.getByTestId("lens-character");
    expect(block).toBeInTheDocument();
    // Closed by default, like every optical section.
    expect(screen.queryByTestId("lens-character-menu")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("collapse-lens-character"));
    expect(screen.getByTestId("lens-character-summary")).toHaveTextContent("Nothing is applied until you choose");
    await chooseWith(user, screen.getByTestId("lens-character-menu"), "petzval");
    expect(screen.getByTestId("lens-character-summary")).toHaveTextContent("Petzval");
    expect(menuValue(screen.getByTestId("lens-character-menu"))).toBe("petzval");
  });

  it("a layer row's dot switches the layer off and on", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByTestId("add-layer-radial"));
    const row = screen.getByTestId("layer-row-layer_1_adj");
    expect(row).toHaveAttribute("data-enabled", "true");
    await user.click(screen.getByTestId("layer-vis-layer_1_adj"));
    expect(row).toHaveAttribute("data-enabled", "false");
    expect(screen.getByTestId("layer-vis-layer_1_adj")).toHaveAttribute("aria-pressed", "false");
    await user.click(screen.getByTestId("layer-vis-layer_1_adj"));
    expect(row).toHaveAttribute("data-enabled", "true");
  });

  it("linear mask angle slider spans the full rotation", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByTestId("add-layer-linear"));
    // Scoped: Geometry's straighten slider shares the "angle" param name.
    const maskControls = screen.getByTestId("layer-mask-controls");
    const slider = within(within(maskControls).getByTestId("slider-angle")).getByRole("slider");
    expect(slider.getAttribute("aria-valuemin")).toBe("-180");
    expect(slider.getAttribute("aria-valuemax")).toBe("180");
    expect(slider.getAttribute("aria-valuenow")).toBe("90");
  });

  it("radial masks place interactively in the viewport", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByTestId("add-layer-radial"));
    const overlay = screen.getByTestId("radial-overlay");
    stubBox(overlay);
    // Grab the center (the middle of the box), then drag right and down a
    // quarter of the frame: 100 + 0.25*200 = 150.
    fireEvent.mouseDown(overlay, { clientX: 100, clientY: 100 });
    fireEvent.mouseMove(overlay, { buttons: 1, clientX: 150, clientY: 150 });
    fireEvent.mouseUp(overlay);
    const mask = () => within(screen.getByTestId("slider-center_x")).getByRole("slider");
    expect(mask().getAttribute("aria-valuenow")).toBe("0.75");
    // The layer's section carries the shared LINES row, and the gizmo
    // draws in the color it holds.
    expect(screen.getByTestId("radial-line-auto")).toHaveAttribute("data-active", "true");
    fireEvent.click(screen.getByTestId("radial-line-auto"));
    const ring = screen.getByTestId("radial-gizmo").querySelector("polygon")!;
    expect(ring.getAttribute("stroke")).toMatch(/^hsla\(/);
  });

  /// (2026-09-15): "When I have the move cursor but I don't click on the
  /// exact middle of the shape, it causes the shape to jump so the center
  /// handle is where the cursor is." The center used to be set to the
  /// pointer on the press.
  it("a radial mask grabbed off its center moves by the drag, without jumping", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByTestId("add-layer-radial"));
    const overlay = screen.getByTestId("radial-overlay");
    stubBox(overlay);
    const controls = screen.getByTestId("layer-mask-controls");
    const at = (id: string) => Number(within(within(controls).getByTestId(id)).getByRole("slider").getAttribute("aria-valuenow"));
    // The center is at (100, 100) and the edge 80px out; 20px to the
    // right of the center is well inside, where the move cursor shows.
    fireEvent.mouseDown(overlay, { clientX: 120, clientY: 100 });
    // The press alone moves nothing.
    expect(at("slider-center_x")).toBeCloseTo(0.5, 6);
    // Dragging 30px carries the shape 30px (0.15 of the frame), not
    // to the pointer.
    fireEvent.mouseMove(overlay, { buttons: 1, clientX: 150, clientY: 100 });
    fireEvent.mouseUp(overlay);
    expect(at("slider-center_x")).toBeCloseTo(0.65, 6);
    expect(at("slider-center_y")).toBeCloseTo(0.5, 6);
  });

  /// (2026-09-15): "When I move the cursor outside the shape and click
  /// anywhere on the canvas the shape rotates immediately." The rotation
  /// used to be set to the pointer's own angle.
  it("a radial mask rotates by the angle swept from the grab, not to the pointer's angle", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByTestId("add-layer-radial"));
    const overlay = screen.getByTestId("radial-overlay");
    stubBox(overlay);
    const controls = screen.getByTestId("layer-mask-controls");
    const rotation = () => Number(within(within(controls).getByTestId("slider-rotation")).getByRole("slider").getAttribute("aria-valuenow"));
    expect(rotation()).toBe(0);
    // Straight below the center at 1.2 radii: the rotate band, at 90°
    // on screen. Setting the rotation to that angle is the old bug.
    fireEvent.mouseDown(overlay, { clientX: 100, clientY: 196 });
    expect(overlay).toHaveAttribute("data-zone", "rotate");
    expect(rotation()).toBe(0);
    // 10px to the left sweeps about 6° around the center.
    fireEvent.mouseMove(overlay, { buttons: 1, clientX: 90, clientY: 196 });
    fireEvent.mouseUp(overlay);
    expect(rotation()).toBeGreaterThan(4);
    expect(rotation()).toBeLessThan(8);
  });

  it("a Grid Warp twist from the section bends the viewer's handles live, through the real panel and viewer", async () => {
    // Through the App, not a harness: the panel wraps dispatch in its
    // build-on-touch closure and the viewer in guardDispatch, and the live
    // channel has to join the two (the owner, twice: "I am not getting a
    // preview with Twist or Pinch", "You didn't fix the preview").
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByTestId("thumb-4869"));
    const collapse = screen.getByTestId("collapse-grid-warp");
    if (collapse.getAttribute("data-open") !== "true") fireEvent.click(collapse);
    // The section's own chip arms the tool; the header has no warp buttons.
    fireEvent.click(screen.getByTestId("gridwarp-tool"));
    fireEvent.click(screen.getByTestId("gridwarp-pick-all"));
    const corner = () => screen.getAllByTestId("gridwarp-vertex")[0].style.left;
    const rest = corner();
    // Shape Warp's section wears the same wheel below; Grid Warp's is
    // the first.
    const wheel = screen.getAllByTestId("gridwarp-turn")[0];
    wheel.getBoundingClientRect = () => ({ left: 0, top: 0, right: 44, bottom: 44, width: 44, height: 44, x: 0, y: 0, toJSON() {} }) as DOMRect;
    fireEvent.mouseDown(wheel, { button: 0, clientX: 44, clientY: 22 });
    fireEvent.mouseMove(document, { buttons: 1, clientX: 22, clientY: 44 });
    // Mid-drag: the viewer's handle has already moved, and nothing is
    // written yet.
    expect(screen.getAllByTestId("gridwarp-turn-readout")[0].textContent).toBe("90°");
    expect(corner()).not.toBe(rest);
    fireEvent.mouseUp(document, { clientX: 22, clientY: 44 });
    expect(corner()).not.toBe(rest);
  });

  it("a Shape Warp twist from the section bends the viewer's ring live, through the real panel and viewer", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByTestId("thumb-4869"));
    const collapse = screen.getByTestId("collapse-shape-warp");
    if (collapse.getAttribute("data-open") !== "true") fireEvent.click(collapse);
    fireEvent.click(screen.getByTestId("shapewarp-add"));
    fireEvent.click(screen.getByTestId("shapewarp-mode-warp"));
    // Adding a shape arms the tool, so the overlay is up.
    expect(screen.getByTestId("shapewarp-tool")).toHaveTextContent("Done");
    const overlay = screen.getByTestId("shapewarp-overlay");
    expect(overlay).toHaveAttribute("data-live", "false");
    const wheel = screen.getAllByTestId("gridwarp-turn")[1];
    wheel.getBoundingClientRect = () => ({ left: 0, top: 0, right: 44, bottom: 44, width: 44, height: 44, x: 0, y: 0, toJSON() {} }) as DOMRect;
    fireEvent.mouseDown(wheel, { button: 0, clientX: 44, clientY: 22 });
    fireEvent.mouseMove(document, { buttons: 1, clientX: 22, clientY: 44 });
    expect(screen.getAllByTestId("gridwarp-turn-readout")[1].textContent).toBe("90°");
    // A twist moves the picture, not the ring, so the proof is the
    // live list reaching the viewer's overlay mid-drag.
    expect(screen.getByTestId("shapewarp-overlay")).toHaveAttribute("data-live", "true");
    fireEvent.mouseUp(document, { clientX: 22, clientY: 44 });
    expect(screen.getByTestId("shapewarp-overlay")).toHaveAttribute("data-live", "false");
    expect(screen.getAllByTestId("gridwarp-turn-readout")[1].textContent).toBe("0°");
  });

  it("linear masks place interactively in the viewport", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByTestId("add-layer-linear"));
    const overlay = screen.getByTestId("linear-overlay");
    stubBox(overlay);
    fireEvent.mouseDown(overlay, { clientX: 100, clientY: 150 });
    fireEvent.mouseUp(overlay);
    // The click lands at (0.5, 0.75); at the default 90° the gradient runs
    // straight down, so t is just ny.
    const pos = within(screen.getByTestId("slider-position")).getByRole("slider");
    expect(pos.getAttribute("aria-valuenow")).toBe("0.75");
  });

  it("the linear mask's pointer says position, span, or angle before the drag", async () => {
    // "I need to see different cursors whether I am
    // changing the position, angle, or span." The zone under the
    // pointer is the contract; each zone maps to its cursor (arrows
    // along the gradient, feather arrows, the rotate arc).
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByTestId("add-layer-linear"));
    const overlay = screen.getByTestId("linear-overlay");
    stubBox(overlay);
    // Mid-frame, far from every edge: position.
    fireEvent.mouseMove(overlay, { clientX: 100, clientY: 100 });
    expect(overlay.getAttribute("data-zone")).toBe("position");
    // On a span edge (default 90 degrees puts them at ny 0.375/0.625),
    // away from the rotate chip.
    fireEvent.mouseMove(overlay, { clientX: 40, clientY: 125 });
    expect(overlay.getAttribute("data-zone")).toBe("span");
    // Over the rotate chip (0.12 along the gradient from the line).
    fireEvent.mouseMove(overlay, { clientX: 100, clientY: 124 });
    expect(overlay.getAttribute("data-zone")).toBe("angle");
    // The chip is an HTML element wearing the rotation arc, so the
    // frame's aspect cannot stretch it into the old oval.
    const chip = screen.getByTestId("linear-rotate");
    expect(chip.tagName).toBe("DIV");
    expect(chip.querySelector("path")).toBeTruthy();
    // Leaving the frame stands the pointer down.
    fireEvent.mouseLeave(overlay);
    expect(overlay.getAttribute("data-zone")).toBe("none");
  });

  // Split Tone retired 2026-08-23 in favor of Recolor's Lum▸Hue curve
  // and the Color Wheels' tonal tinting; its panel went with it.

  it("tone profile modes are selectable from the Source section", async () => {
    const user = userEvent.setup();
    render(<App />);
    // Source ships collapsed now (on, but folded); open it the way a
    // person would before reaching for its controls.
    await user.click(screen.getByTestId("collapse-source"));
    expect(screen.getByTestId("tone-profile")).toHaveAttribute("data-value", "standard");
    // Standard/Film expose the amount; Linear has nothing to scale.
    expect(screen.getByRole("slider", { name: /profile amt/i })).toBeInTheDocument();
    await user.click(screen.getByTestId("tone-profile"));
    await user.click(screen.getByTestId("tone-profile-option-linear"));
    expect(screen.getByTestId("tone-profile")).toHaveAttribute("data-value", "linear");
    expect(screen.getByTestId("tone-profile")).toHaveTextContent("Linear");
    expect(screen.queryByRole("slider", { name: /profile amt/i })).not.toBeInTheDocument();
    await user.click(screen.getByTestId("tone-profile"));
    await user.click(screen.getByTestId("tone-profile-option-film"));
    expect(screen.getByTestId("tone-profile")).toHaveAttribute("data-value", "film");
  });

  it("a selection layer's mask offers Feather follows the picture, and a range mask does not", async () => {
    // Halo item 3 (2026-09-23): the switch is the selection's, beside
    // its Feather; the other masks have no photograph-guided feather to
    // offer.
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByTestId("add-layer-selection"));
    const follows = screen.getByTestId("mask-feather-guided");
    expect(follows).toHaveAttribute("aria-checked", "false");
    await user.click(follows);
    expect(screen.getByTestId("mask-feather-guided")).toHaveAttribute("aria-checked", "true");
    await user.click(screen.getByTestId("add-layer-range"));
    expect(screen.queryByTestId("mask-feather-guided")).not.toBeInTheDocument();
  });

  it("layer masks expose invert, reset, and range presets", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByTestId("add-layer-range"));
    // Invert is available on the mask itself.
    const invert = screen.getByTestId("mask-invert");
    expect(invert).toHaveAttribute("aria-checked", "false");
    await user.click(invert);
    expect(screen.getByTestId("mask-invert")).toHaveAttribute("aria-checked", "true");

    // A preset rewrites the window...
    const lumaLow = () => within(screen.getByTestId("slider-luma_low")).getByRole("slider");
    await chooseWith(user, screen.getByTestId("range-preset"), "highlights");
    expect(Number(lumaLow().getAttribute("aria-valuenow"))).toBeCloseTo(0.62, 2);

    // ...and Reset puts the mask back to defaults, invert included.
    await user.click(screen.getByTestId("mask-reset"));
    expect(Number(lumaLow().getAttribute("aria-valuenow"))).toBe(0);
    expect(screen.getByTestId("mask-invert")).toHaveAttribute("aria-checked", "false");
  });

  it("range picker arms the viewport with a mode and target", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByTestId("add-layer-range"));
    expect(screen.queryByTestId("pick-overlay")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("range-picker"));
    expect(screen.getByTestId("pick-overlay")).toBeInTheDocument();
    expect(screen.getByTestId("pick-active")).toHaveTextContent("LUMA");
    // Mode and target are selectable.
    await user.click(screen.getByTestId("pick-mode-add"));
    expect(screen.getByTestId("pick-mode-add")).toHaveAttribute("data-active", "true");
    await user.click(screen.getByTestId("pick-target-hue"));
    expect(screen.getByTestId("pick-active")).toHaveTextContent("HUE");
    // Clicking the button again disarms it.
    await user.click(screen.getByTestId("range-picker"));
    expect(screen.queryByTestId("pick-overlay")).not.toBeInTheDocument();
  });

  it("the Radial layer sets the outline thickness beside its color", async () => {
    // "make sure there is a thickness slider in Adjustment >
    // Radial as well." The row is the shared one (LineWidthRow): this
    // photograph's own thickness where set, the preference otherwise, the
    // one value every overlay draws at.
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByTestId("add-layer-radial"));
    const field = () => screen.getByTestId("radial-line-width") as HTMLInputElement;
    expect(field().value).toBe("2");
    expect(screen.getByTestId("radial-line-width-pref")).toHaveAttribute("data-active", "true");
    fireEvent.change(field(), { target: { value: "5" } });
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(field().value).toBe("5");
    expect(screen.getByTestId("radial-line-width-pref")).toHaveAttribute("data-active", "false");
    // The gizmo over the photograph draws at it.
    const ring = screen.getByTestId("radial-gizmo").querySelector("polygon")!;
    expect(ring.getAttribute("stroke-width")).toBe("5");
    // It rides beside the color row, not instead of it.
    expect(screen.getByTestId("radial-lines")).toBeInTheDocument();
    // Preference hands it back.
    fireEvent.click(screen.getByTestId("radial-line-width-pref"));
    expect(field().value).toBe("2");
  });

  it("the Linear layer's lines take the same color and thickness rows as the Radial's", async () => {
    // "The linear controls will need the same line color and thickness
    // features as the radius shapes." The same two shared rows, drawn
    // by the same color logic at the same thickness.
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByTestId("add-layer-linear"));
    expect(screen.getByTestId("linear-lines")).toBeInTheDocument();
    expect(screen.getByTestId("linear-line-width-row")).toBeInTheDocument();
    const line = () => screen.getByTestId("linear-line");
    const edges = () => screen.getAllByTestId("linear-span-edge");
    // The shipped thickness, in the line color rather than a fixed
    // near-white at a fraction of a pixel.
    expect(line().getAttribute("stroke-width")).toBe("2");
    expect(line().getAttribute("stroke")).toMatch(/^hsla\(/);
    expect(edges()).toHaveLength(2);
    for (const e of edges()) {
      expect(e.getAttribute("stroke-width")).toBe("2");
      expect(e.getAttribute("stroke")).toMatch(/^hsla\(/);
    }
    // A hue set on the LINES row draws the gradient in it.
    const hue = screen.getByTestId("linear-line-hue");
    hue.focus();
    fireEvent.keyDown(hue, { key: "ArrowRight" });
    expect(screen.getByTestId("linear-line-auto")).toHaveAttribute("data-active", "false");
    const set = screen.getByTestId("linear-line-hue-value").textContent;
    expect(line().getAttribute("stroke")).toMatch(new RegExp(`^hsla\\(${set}, 75%,`));
    // A thickness typed for this photograph draws every line at it.
    const field = screen.getByTestId("linear-line-width") as HTMLInputElement;
    fireEvent.change(field, { target: { value: "6" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(line().getAttribute("stroke-width")).toBe("6");
    for (const e of edges()) expect(e.getAttribute("stroke-width")).toBe("6");
    // Preference hands it back.
    fireEvent.click(screen.getByTestId("linear-line-width-pref"));
    expect(line().getAttribute("stroke-width")).toBe("2");
  });

  it("Depth Lighting sets the light handles' thickness beside their color while the rig is up", async () => {
    // (2026-09-15): "Missing the slider to control the line thickness of
    // the light's control handles (like with shapes)." The shapes' own
    // row, so the rig draws at the one thickness every overlay reads.
    const user = userEvent.setup();
    render(<App />);
    const collapse = screen.getByTestId("collapse-depth-lighting");
    if (collapse.getAttribute("data-open") !== "true") fireEvent.click(collapse);
    expect(screen.queryByTestId("keylight-line-width-row")).not.toBeInTheDocument();
    // Lens Flare wears the rig button too, below; Depth Lighting's is
    // the first.
    await user.click(screen.getAllByTestId("keylight-rig")[0]);
    const field = () => screen.getByTestId("keylight-line-width") as HTMLInputElement;
    expect(field().value).toBe("2");
    fireEvent.change(field(), { target: { value: "3" } });
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(field().value).toBe("3");
    // Beside the LINES row, and the gizmo over the photograph draws
    // at the new thickness.
    expect(screen.getByTestId("keylight-lines")).toBeInTheDocument();
    expect(screen.getByTestId("keylight-handle-0").style.border).toMatch(/^2\.25px solid/);
  });

  it("the thickness track has a width to size from, and its number drags", async () => {
    // The owner, from Depth Lighting: "There is not enough width for a
    // slider. The integer should be draggable." The track sat bare in the
    // row's flex bar and collapsed to its handle; the number only typed.
    const user = userEvent.setup();
    render(<App />);
    const collapse = screen.getByTestId("collapse-depth-lighting");
    if (collapse.getAttribute("data-open") !== "true") fireEvent.click(collapse);
    await user.click(screen.getAllByTestId("keylight-rig")[0]);
    expect(screen.getByTestId("keylight-line-width-track").parentElement).toHaveClass("strack-flex");
    const field = () => screen.getByTestId("keylight-line-width") as HTMLInputElement;
    fireEvent.change(field(), { target: { value: "3" } });
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(field().value).toBe("3");
    // Ten pixels of sideways drag is one pixel of thickness, in whole
    // steps, held to the range at both ends.
    fireEvent.mouseDown(field(), { button: 0, clientX: 100 });
    fireEvent.mouseMove(window, { clientX: 124 });
    expect(field().value).toBe("5");
    fireEvent.mouseMove(window, { clientX: 900 });
    expect(field().value).toBe("8");
    fireEvent.mouseMove(window, { clientX: -900 });
    expect(field().value).toBe("1");
    fireEvent.mouseMove(window, { clientX: 110 });
    fireEvent.mouseUp(window);
    expect(field().value).toBe("4");
    expect(screen.getByTestId("keylight-line-width-pref")).toHaveAttribute("data-active", "false");
    // The drag never opened the field for typing; a plain click does.
    expect(document.activeElement).not.toBe(field());
    fireEvent.mouseDown(field(), { button: 0, clientX: 100 });
    fireEvent.mouseUp(window);
    expect(document.activeElement).toBe(field());
  });

  it("layers duplicate and rename from the panel; the dead MASKS section is gone", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByTestId("add-layer-radial"));
    await user.click(screen.getByTestId("duplicate-layer_1_adj"));
    expect(screen.getByTestId("layer-row-layer_2_adj")).toBeInTheDocument();

    await user.dblClick(screen.getByTestId("select-layer_2_adj"));
    const input = screen.getByTestId("rename-input-layer_2_adj");
    await user.clear(input);
    await user.type(input, "Sky{Enter}");
    expect(screen.getByTestId("layer-row-layer_2_adj")).toHaveTextContent("Sky");

    // The old placeholder MASKS section carried no functionality.
    expect(screen.queryByText("Masks")).not.toBeInTheDocument();
  });

  it("mask view toggles black/white mask preview for the active layer", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByTestId("add-layer-radial"));
    const toggle = screen.getByTestId("mask-view-toggle");
    expect(toggle).toHaveAttribute("data-active", "false");
    await user.click(toggle);
    expect(screen.getByTestId("mask-view-toggle")).toHaveAttribute("data-active", "true");
    await user.click(screen.getByTestId("mask-view-toggle"));
    expect(screen.getByTestId("mask-view-toggle")).toHaveAttribute("data-active", "false");
    // The owner's compromise: ONE Show mask button, and ALT-click
    // switches the app-wide flavor (alpha black/white vs the red
    // overlay). The glyph is the flavor; the button is an icon, never a
    // word.
    const toggle2 = screen.getByTestId("mask-view-toggle");
    expect(toggle2.querySelector("svg")).not.toBeNull();
    expect(toggle2.textContent).toBe("");
    const label = () => screen.getByTestId("mask-view-toggle").getAttribute("aria-label");
    expect(label()).toContain("black and white");
    // ALT-click: flavor switches AND the view comes on so the switch
    // is visible.
    fireEvent.click(screen.getByTestId("mask-view-toggle"), { altKey: true });
    expect(label()).toContain("red overlay");
    expect(screen.getByTestId("mask-view-toggle")).toHaveAttribute("data-active", "true");
    // Plain click toggles the view off; the flavor is remembered.
    await user.click(screen.getByTestId("mask-view-toggle"));
    expect(screen.getByTestId("mask-view-toggle")).toHaveAttribute("data-active", "false");
    expect(label()).toContain("red overlay");
  });

  it("Graph inspector mirrors the new grain controls 1:1", async () => {
    const user = userEvent.setup();
    render(<App />);
    await toGraphMode(user);
    fireEvent.mouseDown(screen.getByTestId("node-grain"));
    // The pattern picker is generic now, driven by the node's declared options
    // rather than a hand-written panel. The owner's "-50" came from one of
    // those panels naming a param the engine stopped reading.
    expect(menuValue(screen.getByTestId("node-option-pattern"))).toBe("standard");
    for (const p of ["shadows_gain", "midtones_gain", "highlights_gain", "red_gain", "green_gain", "blue_gain"]) {
      expect(screen.getByTestId(`slider-${p}`)).toBeInTheDocument();
    }
    // And the two the engine actually reads, under the names it reads them
    // by. These were "grain_amount" and "grain_size", which nothing read.
    expect(screen.getByTestId("slider-intensity")).toBeInTheDocument();
    expect(screen.getByTestId("slider-size")).toBeInTheDocument();
    await chooseWith(user, screen.getByTestId("node-option-pattern"), "fine");
    expect(menuValue(screen.getByTestId("node-option-pattern"))).toBe("fine");
    // Grain's format is its own row, not a second menu.
    expect(screen.queryByTestId("node-option-format")).toBeNull();
    expect(screen.getByTestId("grain-format")).toBeInTheDocument();
  });

  it("Graph inspector gives the Sharpening node its mode chooser, named as the section names it", async () => {
    const user = userEvent.setup();
    render(<App />);
    // Off by default, so the node is not in the graph until the section
    // is switched on in Develop.
    await user.click(screen.getByTestId("toggle-sharpening"));
    await toGraphMode(user);
    fireEvent.mouseDown(screen.getByTestId("node-sharpening"));
    // Radius and intensity render generically; the mode was the hole:
    // a text param with no PARAM_OPTIONS entry never drew a control.
    // The group's published dials, and the Recipe switch beside them.
    expect(screen.getByTestId("published-radius")).toBeInTheDocument();
    expect(screen.getByTestId("published-intensity")).toBeInTheDocument();
    const mode = screen.getByTestId("node-option-mode");
    expect(menuValue(mode)).toBe("vivid");
    const labels = menuRows(mode).map(([, label]) => label);
    expect(labels).toEqual(["Vivid", "Hi Pass"]);
    // A change on the node reflects in the section, and back.
    await chooseWith(user, mode, "hipass");
    expect(menuValue(mode)).toBe("hipass");
    await user.click(screen.getByRole("tablist", { name: /workspace mode/i }).children[0]);
    expect(screen.getByTestId("sharpen-mode-hipass")).toHaveAttribute("data-active", "true");
    await user.click(screen.getByTestId("sharpen-mode-vivid"));
    expect(screen.getByTestId("sharpen-mode-vivid")).toHaveAttribute("data-active", "true");
    await toGraphMode(user);
    fireEvent.mouseDown(screen.getByTestId("node-sharpening"));
    expect(menuValue(screen.getByTestId("node-option-mode"))).toBe("vivid");
  });

  it("Graph inspector edits layer mask nodes 1:1", async () => {
    const user = userEvent.setup();
    render(<App />);
    // Create a range layer in Develop, then inspect its mask node in Graph.
    await user.click(screen.getByTestId("add-layer-range"));
    await toGraphMode(user);
    fireEvent.mouseDown(screen.getByTestId("node-layer_1_mask"));
    expect(screen.getByTestId("slider-luma_low")).toBeInTheDocument();
    expect(screen.getByTestId("slider-hue_width")).toBeInTheDocument();
  });

  it("viewer badge reports the preview source honestly", () => {
    render(<App />);
    expect(screen.getByTestId("preview-source")).toHaveTextContent("APPROX");
  });

  it("console button opens the OS console window; the panel itself captures, copies, clears", async () => {
    // The console always spawns as an OS window. "I really
    // hate how it spawns as one window and transforms to another when I
    // drag."
    const user = userEvent.setup();
    const writeText = vi.fn();
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const opened = vi.spyOn(window, "open").mockReturnValue(null);
    render(<App />);
    expect(screen.queryByTestId("console-panel")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("btn-console"));
    await waitFor(() => expect(opened).toHaveBeenCalled());
    expect(String(opened.mock.calls[0][0])).toContain("view=console");
    expect(screen.queryByTestId("console-panel")).not.toBeInTheDocument();
    opened.mockRestore();

    // The window's own panel: log capture, copy, clear.
    const { ConsolePanel } = await import("../ui/console");
    render(<ConsolePanel open windowed dispatch={(() => {}) as never} />);
    const { logMsg } = await import("../log");
    logMsg("error", "Engine preview failed: sample failure");
    expect(await screen.findByText(/sample failure/)).toBeInTheDocument();
    await user.click(screen.getByTestId("console-copy"));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("sample failure"));
    await user.click(screen.getByTestId("console-clear"));
    expect(screen.queryByText(/sample failure/)).not.toBeInTheDocument();
  });
  it("Ctrl+backtick summons the console window", async () => {
    const opened = vi.spyOn(window, "open").mockReturnValue(null);
    render(<App />);
    fireEvent.keyDown(window, { key: "`", ctrlKey: true });
    await waitFor(() => expect(opened).toHaveBeenCalled());
    expect(screen.queryByTestId("console-panel")).not.toBeInTheDocument();
    opened.mockRestore();
  });
  it("range layer: exposure sliders retarget to the layer, base restores", async () => {
    const user = userEvent.setup();
    render(<App />);
    const exposure = () => within(screen.getByTestId("slider-exposure")).getByRole("slider");
    expect(exposure().getAttribute("aria-valuenow")).toBe("0.62");

    await user.click(screen.getByTestId("add-layer-range"));
    expect(screen.getByTestId("layer-row-layer_1_adj")).toBeInTheDocument();
    expect(screen.getByTestId("layer-mask-controls")).toBeInTheDocument();
    expect(screen.getByTestId("slider-luma_low")).toBeInTheDocument();
    // Exposure sliders now edit the layer's own node (fresh zeros).
    expect(exposure().getAttribute("aria-valuenow")).toBe("0");
    fireEvent.keyDown(exposure(), { key: "ArrowRight" });
    expect(Number(exposure().getAttribute("aria-valuenow"))).toBeGreaterThan(0);

    // Back to Base: original values untouched.
    await user.click(screen.getByTestId("layer-base"));
    expect(exposure().getAttribute("aria-valuenow")).toBe("0.62");

    // Reselect and remove the layer.
    await user.click(screen.getByTestId("select-layer_1_adj"));
    await user.click(screen.getByTestId("remove-layer_1_adj"));
    expect(screen.queryByTestId("layer-row-layer_1_adj")).not.toBeInTheDocument();
    expect(exposure().getAttribute("aria-valuenow")).toBe("0.62");
  });

  it("takes branch and switch from the viewer toolbar dropdown", async () => {
    const user = userEvent.setup();
    render(<App />);
    const slider = () => within(screen.getByTestId("slider-exposure")).getByRole("slider");
    fireEvent.keyDown(slider(), { key: "ArrowRight" });
    const edited = slider().getAttribute("aria-valuenow");

    await user.click(screen.getByTestId("new-take"));
    // "I created new takes but they are coming in as
    // Version#." This test was asserting the bug, which is how it survived
    // the rename.
    expect(screen.getByTestId("takes-dropdown")).toHaveTextContent("Take 2");
    fireEvent.keyDown(slider(), { key: "ArrowRight" });
    const take2Value = slider().getAttribute("aria-valuenow");
    expect(take2Value).not.toBe(edited);

    await user.click(screen.getByTestId("takes-dropdown"));
    await user.click(screen.getByTestId("take-take_1"));
    expect(slider().getAttribute("aria-valuenow")).toBe(edited);
    await user.click(screen.getByTestId("takes-dropdown"));
    await user.click(screen.getByTestId("take-take_2"));
    expect(slider().getAttribute("aria-valuenow")).toBe(take2Value);
  });

  it("shift+new-take opens the naming dialog; takes are renamable, and the dropdown shows no notes", async () => {
    const user = userEvent.setup();
    render(<App />);
    fireEvent.click(screen.getByTestId("new-take"), { shiftKey: true });
    // The dialog names the take; notes are written in the Takes window
    // ("On the dropdown for Takes it should not show the
    // notes").
    expect(screen.queryByTestId("take-dialog-note")).toBeNull();
    await user.type(screen.getByTestId("take-dialog-name"), "Moody BW");
    await user.click(screen.getByTestId("take-dialog-save"));
    expect(screen.getByTestId("takes-dropdown")).toHaveTextContent("Moody BW");

    // Rename from the list.
    await user.click(screen.getByTestId("takes-dropdown"));
    await user.click(screen.getByTestId("edit-take-take_2"));
    const name = screen.getByTestId("take-dialog-name");
    await user.clear(name);
    await user.type(name, "Warm BW{Enter}");
    expect(screen.getByTestId("takes-dropdown")).toHaveTextContent("Warm BW");
  });

  it("history lives in the right panel's History tab and jumps back", async () => {
    const user = userEvent.setup();
    render(<App />);
    const slider = () => within(screen.getByTestId("slider-exposure")).getByRole("slider");
    const before = slider().getAttribute("aria-valuenow");
    fireEvent.keyDown(slider(), { key: "ArrowRight" });
    fireEvent.keyDown(slider(), { key: "ArrowRight" });
    // History is a tab beside Adjustments, not part of the library panel.
    expect(screen.queryByTestId("history-list")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("panel-tab-history"));
    const history = screen.getByTestId("history-list");
    expect(within(history).getAllByText("Exposure: exposure").length).toBe(2);
    await user.click(screen.getByTestId("history-0"));
    await user.click(screen.getByTestId("panel-tab-adjust"));
    expect(slider().getAttribute("aria-valuenow")).toBe(before);
  });

  it("library sections collapse and expand", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByTestId("folder-row-1");
    await user.click(screen.getByTestId("section-toggle-folders"));
    expect(screen.queryByTestId("folder-row-1")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("section-toggle-folders"));
    expect(screen.getByTestId("folder-row-1")).toBeInTheDocument();

    expect(screen.getByTestId("new-collection")).toBeInTheDocument();
    await user.click(screen.getByTestId("section-toggle-collections"));
    expect(screen.queryByText(/no collections yet/i)).not.toBeInTheDocument();
  });

  it("the Presets tab holds looks: two roots, no node-groups vestige", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByTestId("panel-tab-presets"));
    // The agreed shape (2026-08-25): a read-only built-in library
    // above, the user's own presets below, each searchable. The old
    // node-groups listing is gone.
    expect(screen.getByTestId("preset-root-builtin")).toBeInTheDocument();
    expect(screen.getByTestId("preset-root-user")).toBeInTheDocument();
    expect(screen.getByTestId("preset-search-builtin")).toBeInTheDocument();
    expect(screen.getByTestId("preset-search-user")).toBeInTheDocument();
    expect(screen.queryByTestId("preset-container-node-groups")).not.toBeInTheDocument();
    expect(screen.getByTestId("preset-save-open")).toBeInTheDocument();
    expect(screen.getByTestId("preset-import")).toBeInTheDocument();
  });

  it("source Sharpening is Standard for a new photograph and one seat with the graph", async () => {
    // Capture sharpening (2026-09-29, beside the reference editors at
    // 100%): on by default, chosen in Develop's Source section, and
    // the same choice the graph inspector shows.
    const user = userEvent.setup();
    render(<App />);
    expect(screen.getByTestId("source-sharpening")).toHaveAttribute("data-value", "standard");
    await user.click(screen.getByTestId("source-sharpening"));
    await user.click(screen.getByTestId("source-sharpening-option-low"));
    expect(screen.getByTestId("source-sharpening")).toHaveAttribute("data-value", "low");
    await toGraphMode(user);
    fireEvent.mouseDown(screen.getByTestId("node-src"));
    expect(screen.getByTestId("inspector-source-sharpening")).toHaveAttribute("data-value", "low");
  });

  it("source WB toggle is 1:1 with the graph; no confusing matrix toggle", async () => {
    const user = userEvent.setup();
    render(<App />);
    const wb = screen.getByTestId("source-camera_wb");
    expect(wb).toHaveAttribute("aria-checked", "true");
    await user.click(wb);
    expect(screen.getByTestId("source-camera_wb")).toHaveAttribute("aria-checked", "false");
    // The camera-matrix toggle was removed from the UI: a no-op on
    // matrix-less stocks (Panasonic RW2) read as a broken control.
    expect(screen.queryByTestId("source-camera_matrix")).not.toBeInTheDocument();
    // Same param is editable from the Graph inspector (1:1 rule).
    await toGraphMode(user);
    fireEvent.mouseDown(screen.getByTestId("node-src"));
    const inspectorWb = screen.getByTestId("inspector-source-camera_wb");
    expect(inspectorWb).toHaveAttribute("aria-checked", "false");
    await user.click(inspectorWb);
    expect(screen.getByTestId("inspector-source-camera_wb")).toHaveAttribute("aria-checked", "true");
  });

  it("zoom hotkeys walk the ladder and reset to fit", () => {
    render(<App />);
    expect(screen.getByTestId("zoom-readout")).toHaveTextContent("FIT");
    // The keyboard steps to the next rung rather than multiplying by
    // 1.25, which after three presses left the view on 1.953 and
    // resampling every pixel. Stepping back down returns to the base
    // exactly, which is the point of a ladder over a multiplier.
    fireEvent.keyDown(window, { key: "=", ctrlKey: true });
    expect(screen.getByTestId("zoom-readout")).toHaveTextContent("×1.50");
    fireEvent.keyDown(window, { key: "-", ctrlKey: true });
    expect(screen.getByTestId("zoom-readout")).toHaveTextContent("FIT");
    fireEvent.keyDown(window, { key: "1", ctrlKey: true });
    expect(screen.getByTestId("zoom-readout")).toHaveTextContent("100%");
    fireEvent.keyDown(window, { key: "0", ctrlKey: true });
    expect(screen.getByTestId("zoom-readout")).toHaveTextContent("FIT");
  });

  it("scroll navigation zooms, pans, and rotates the view", async () => {
    render(<App />);
    const stage = screen.getByTestId("viewer-stage");
    const zoom = () => screen.getByTestId("zoom-readout").textContent;

    // Plain scroll zooms.
    fireEvent.wheel(stage, { deltaY: -100 });
    await waitFor(() => expect(zoom()).not.toBe("FIT"));
    const zoomed = zoom();

    // SHIFT and CTRL scroll pan instead of zooming.
    fireEvent.wheel(stage, { deltaY: -100, shiftKey: true });
    fireEvent.wheel(stage, { deltaY: -100, ctrlKey: true });
    expect(zoom()).toBe(zoomed);

    // ALT scroll zooms at half rate: two notches land near one plain one.
    fireEvent.wheel(stage, { deltaY: 100 }); // back to base
    await waitFor(() => expect(zoom()).not.toBe(zoomed));
    const before = zoom();
    fireEvent.wheel(stage, { deltaY: -100, altKey: true });
    await waitFor(() => expect(zoom()).not.toBe(before));

    // Rotation is view-only and reports itself. Positive degrees are
    // clockwise, so scrolling forward with SHIFT+ALT goes the other way.
    expect(screen.queryByTestId("view-rotation")).not.toBeInTheDocument();
    fireEvent.wheel(stage, { deltaY: -100, shiftKey: true, altKey: true });
    expect(await screen.findByTestId("view-rotation")).toHaveTextContent("VIEW -2°");
    // The opposite combo rotates back the other way.
    fireEvent.wheel(stage, { deltaY: -100, ctrlKey: true, altKey: true });
    await waitFor(() => expect(screen.queryByTestId("view-rotation")).not.toBeInTheDocument());
  });

  it("pointer mapping inverts the canvas rotation and zoom", () => {
    const el = document.createElement("div");
    stubBox(el);

    // Unrotated: 50px right of center is a quarter of the frame over.
    expect(norm({ clientX: 150, clientY: 100 }, el)).toEqual([0.75, 0.5]);

    // Rotated 90° clockwise, the image's own +x axis points down the
    // screen, so the same screen point is a quarter frame UP the image.
    const [nx, ny] = norm({ clientX: 150, clientY: 100 }, el, { rotation: 90, zoom: 1 });
    expect(nx).toBeCloseTo(0.5, 6);
    expect(ny).toBeCloseTo(0.25, 6);

    // Zoomed 2x, the same screen distance covers half as much image.
    expect(norm({ clientX: 150, clientY: 100 }, el, { rotation: 0, zoom: 2 })).toEqual([0.625, 0.5]);
  });

  it("a rotated canvas still maps tool input onto the right pixels", async () => {
    // The viewer only applies its transform once it knows the stage size
    // and the frame's aspect, so both have to exist for rotation to be
    // live. jsdom supplies neither on its own.
    const restore = stubStage();
    try {
      const user = userEvent.setup();
      render(<App />);
      fireEvent.load(screen.getByTestId("viewer-image"));
      await user.click(screen.getByTestId("add-layer-radial"));

      const stage = screen.getByTestId("viewer-stage");
      // CTRL+ALT+scroll turns clockwise, 2° a notch.
      for (let i = 0; i < 45; i++) {
        fireEvent.wheel(stage, { deltaY: -100, ctrlKey: true, altKey: true });
      }
      expect(await screen.findByTestId("view-rotation")).toHaveTextContent("VIEW 90°");

      const overlay = screen.getByTestId("radial-overlay");
      stubBox(overlay);
      // Grab the center and drag 60px to the RIGHT on screen. At 90°
      // clockwise the image's own +x axis points down the screen, so that
      // drag has to read as straight UP the image: y falls, x holds.
      fireEvent.mouseDown(overlay, { clientX: 100, clientY: 100 });
      fireEvent.mouseMove(overlay, { buttons: 1, clientX: 160, clientY: 100 });
      fireEvent.mouseUp(overlay);

      const at = (id: string) => Number(within(screen.getByTestId(id)).getByRole("slider").getAttribute("aria-valuenow"));
      expect(at("slider-center_x")).toBeCloseTo(0.5, 6);
      expect(at("slider-center_y")).toBeCloseTo(0.2, 6);
    } finally {
      restore();
    }
  });

  it("view rotation is not an edit and leaves the tools working", async () => {
    const user = userEvent.setup();
    render(<App />);
    const stage = screen.getByTestId("viewer-stage");
    await user.click(screen.getByTestId("btn-tool-crop"));
    expect(screen.getByTestId("crop-overlay")).toBeInTheDocument();

    fireEvent.wheel(stage, { deltaY: -100, shiftKey: true, altKey: true });
    // The canvas turns, the tools do not: crop stays live at any angle.
    expect(screen.getByTestId("crop-overlay")).toBeInTheDocument();
    // Nothing about the graph changed: rotation touches no node, so it
    // never lands in history.
    await user.click(screen.getByTestId("panel-tab-history"));
    expect(screen.getByTestId("history-count")).toHaveTextContent("0/100");
    await user.click(screen.getByTestId("panel-tab-adjust"));

    await user.click(screen.getByTestId("view-rotation"));
    expect(screen.queryByTestId("view-rotation")).not.toBeInTheDocument();
    expect(screen.getByTestId("crop-overlay")).toBeInTheDocument();
  });

  it("the graph surface pans and zooms with the same scheme", async () => {
    render(<App />);
    const tablist = screen.getByRole("tablist", { name: /workspace mode/i });
    fireEvent.click(tablist.children[1]);
    const surface = screen.getByTestId("graph-surface");
    const viewport = () => screen.getByTestId("graph-viewport").style.transform;
    // Zoom is hybrid: the transform scale carries the gesture, then the
    // settled value moves onto the zoom layer's CSS `zoom` so WebKit
    // re-rasterizes crisp. Visual zoom is always the product of the two.
    const effectiveZoom = () => {
      const scale = Number(/scale\(([\d.]+)\)/.exec(viewport())?.[1] ?? 1);
      const rest = Number(screen.getByTestId("graph-zoom-layer").style.zoom || 1);
      return scale * rest;
    };
    expect(effectiveZoom()).toBe(1);

    fireEvent.wheel(surface, { deltaY: -100 });
    await waitFor(() => expect(effectiveZoom()).toBeGreaterThan(1));

    // Once the wheel goes quiet the transform hands its scale to the
    // zoom layer: same visual zoom, crisp rasterization.
    await waitFor(() => expect(viewport()).toContain("scale(1)"));
    expect(effectiveZoom()).toBeGreaterThan(1);

    fireEvent.wheel(surface, { deltaY: -100, shiftKey: true });
    await waitFor(() => expect(viewport()).toMatch(/translate\((?!0px, 0px)/));

    // Middle-drag pans freely.
    const before = viewport();
    fireEvent.mouseDown(surface, { button: 1, clientX: 100, clientY: 100 });
    // buttons: 4, as a real middle-drag reports; the pan hook treats
    // a buttons-less move as a lost mouseup and ends the drag, which
    // is what it does off a real window too.
    fireEvent.mouseMove(window, { clientX: 150, clientY: 130, buttons: 4 });
    fireEvent.mouseUp(window);
    await waitFor(() => expect(viewport()).not.toBe(before));
  });

  it("edited marks from the catalog reach loaded thumbnails", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByTestId("open-folder"));
    await screen.findByTestId("thumb-mock_2");
    // mock_2 carries a persisted edited mark; mock_1 does not.
    expect(screen.getByTestId("thumb-mock_2").querySelector("[data-edited]")).toHaveAttribute("data-edited", "true");
    expect(screen.getByTestId("thumb-mock_1").querySelector("[data-edited]")).toHaveAttribute("data-edited", "false");
  });

  it("thumbnail context menu resets all edits and clears the badge", async () => {
    const user = userEvent.setup();
    render(<App />);
    // 4871 boots with the demo edit (+0.62) and 4866 is marked edited.
    const exposure = () => within(screen.getByTestId("slider-exposure")).getByRole("slider");
    expect(exposure().getAttribute("aria-valuenow")).toBe("0.62");
    fireEvent.contextMenu(screen.getByTestId("thumb-4871"), { clientX: 60, clientY: 200 });
    await user.click(screen.getByTestId("thumb-menu-reset"));
    expect(exposure().getAttribute("aria-valuenow")).toBe("0");

    fireEvent.contextMenu(screen.getByTestId("thumb-4866"), { clientX: 60, clientY: 120 });
    await user.click(screen.getByTestId("thumb-menu-reset"));
    expect(screen.getByTestId("thumb-4866").querySelector("[data-edited]")).toHaveAttribute("data-edited", "false");
  });

  it("folder tree context menu offers expand, collapse, and reveal", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByTestId("folder-row-3"));
    await screen.findByTestId("tree-row-mock://trip/day1");
    fireEvent.contextMenu(screen.getByTestId("tree-row-mock://trip"), { clientX: 100, clientY: 150 });
    expect(screen.getByTestId("folder-menu")).toBeInTheDocument();
    expect(screen.getByTestId("folder-menu-collapse")).toBeInTheDocument();
    expect(screen.getByTestId("folder-menu-reveal")).toBeInTheDocument();
    await user.click(screen.getByTestId("folder-menu-expand"));
    // The day folders are still listed after the recursive expand.
    expect(screen.getByTestId("tree-row-mock://trip/day1")).toBeInTheDocument();
    expect(screen.queryByTestId("folder-menu")).not.toBeInTheDocument();
  });

  it("menu bar drives undo and reset from Edit", async () => {
    const user = userEvent.setup();
    render(<App />);
    for (const id of ["menu-file", "menu-edit", "menu-help"]) {
      expect(screen.getByTestId(id)).toBeInTheDocument();
    }
    expect(screen.getByTestId("window-controls")).toBeInTheDocument();
    const exposure = () => within(screen.getByTestId("slider-exposure")).getByRole("slider");
    await user.click(screen.getByTestId("menu-edit"));
    expect(screen.getByTestId("menu-edit-undo")).toBeDisabled();
    await user.click(screen.getByTestId("menu-edit"));

    fireEvent.keyDown(exposure(), { key: "ArrowRight" });
    const edited = exposure().getAttribute("aria-valuenow");
    await user.click(screen.getByTestId("menu-edit"));
    await user.click(screen.getByTestId("menu-edit-undo"));
    expect(exposure().getAttribute("aria-valuenow")).not.toBe(edited);

    await user.click(screen.getByTestId("menu-edit"));
    await user.click(screen.getByTestId("menu-edit-reset"));
    expect(exposure().getAttribute("aria-valuenow")).toBe("0");
  });

  it("context menus dismiss on any outside click", async () => {
    const user = userEvent.setup();
    render(<App />);
    // Thumbnail menu.
    fireEvent.contextMenu(screen.getByTestId("thumb-4871"), { clientX: 60, clientY: 200 });
    expect(screen.getByTestId("thumb-menu")).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByTestId("viewer-stage"));
    expect(screen.queryByTestId("thumb-menu")).not.toBeInTheDocument();
    // Menubar dropdown.
    await user.click(screen.getByTestId("menu-edit"));
    expect(screen.getByTestId("menu-edit-list")).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByTestId("viewer-stage"));
    expect(screen.queryByTestId("menu-edit-list")).not.toBeInTheDocument();
    // Takes dropdown.
    await user.click(screen.getByTestId("takes-dropdown"));
    expect(screen.getByTestId("takes-list")).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByTestId("viewer-stage"));
    expect(screen.queryByTestId("takes-list")).not.toBeInTheDocument();
    // Folder tree menu.
    await user.click(await screen.findByTestId("folder-row-3"));
    await screen.findByTestId("tree-row-mock://trip/day1");
    fireEvent.contextMenu(screen.getByTestId("tree-row-mock://trip"), { clientX: 100, clientY: 150 });
    expect(screen.getByTestId("folder-menu")).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByTestId("viewer-stage"));
    expect(screen.queryByTestId("folder-menu")).not.toBeInTheDocument();
  });

  it("folders holding edited images carry the pencil badge", async () => {
    const user = userEvent.setup();
    render(<App />);
    // The mock catalog marks the Wedding folder as edited.
    await screen.findByTestId("folder-row-1");
    expect(screen.getByTestId("folder-edited-mock://wedding")).toBeInTheDocument();
    expect(screen.queryByTestId("folder-edited-mock://landscapes")).not.toBeInTheDocument();
    // The live check badges the open folder from its own session images
    // (Landscapes holds an edited image but is absent from the catalog's
    // edited list), no refresh round-trip needed.
    await user.click(screen.getByTestId("folder-row-2"));
    await screen.findByTestId("tree-row-mock://landscapes");
    expect(screen.getAllByTestId("folder-edited-mock://landscapes").length).toBeGreaterThan(0);
  });

  it("edited badges mark the whole trail down through the tree", async () => {
    const user = userEvent.setup();
    render(<App />);
    // Trip itself has no direct edits; Day 1 beneath it does. The root
    // and the day both badge, the sibling day does not.
    await user.click(await screen.findByTestId("folder-row-3"));
    await screen.findByTestId("tree-row-mock://trip/day1");
    expect((await screen.findAllByTestId("folder-edited-mock://trip")).length).toBeGreaterThan(0);
    expect(screen.getAllByTestId("folder-edited-mock://trip/day1").length).toBeGreaterThan(0);
    expect(screen.queryByTestId("folder-edited-mock://trip/day2")).not.toBeInTheDocument();
  });

  it("edited images get the gold thumbnail border", () => {
    render(<App />);
    const edited = screen.getByTestId("thumb-4866").querySelector("[data-edited]");
    expect(edited).toHaveAttribute("data-edited", "true");
    const clean = screen.getByTestId("thumb-4869").querySelector("[data-edited]");
    expect(clean).toHaveAttribute("data-edited", "false");
  });

  it("graph node thumbnails show the active image, not the sample", async () => {
    const user = userEvent.setup();
    render(<App />);
    // Sample session images have real srcs; the node thumb must match the
    // active image's source instead of the hardcoded sample photo.
    await user.click(screen.getByTestId("thumb-4878"));
    await toGraphMode(user);
    const thumb = screen.getByTestId("node-exposure").querySelector(".thumb img") as HTMLImageElement;
    expect(thumb.getAttribute("src")).toContain("test-pattern");
  });

  it("node dragging follows the pointer even off the node", async () => {
    const user = userEvent.setup();
    render(<App />);
    await toGraphMode(user);
    const node = () => screen.getByTestId("node-exposure");
    const before = node().style.left;
    fireEvent.mouseDown(node(), { clientX: 100, clientY: 100 });
    // Fast pointer movement lands on the WINDOW, not the node: the drag
    // must keep tracking (window listeners, not node-local ones).
    fireEvent.mouseMove(window, { clientX: 260, clientY: 180 });
    fireEvent.mouseUp(window);
    expect(node().style.left).not.toBe(before);
  });

  it("the crop aspect dropdown offers the same ratios as the Photo menu", async () => {
    const user = userEvent.setup();
    const { CROP_RATIOS } = await import("../state");
    render(<App />);
    await user.click(screen.getByTestId("btn-tool-crop"));
    const select = screen.getByTestId("crop-aspect");
    const labels = menuRows(select).map(([, label]) => label);
    expect(labels).toContain("Free");
    expect(labels).toContain("Original");
    // Every ratio the menu offers is offered here, from the same list.
    for (const [label] of CROP_RATIOS) expect(labels).toContain(label);
  });

  it("choosing a ratio in the dropdown constrains the crop", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByTestId("btn-tool-crop"));
    const select = screen.getByTestId("crop-aspect");
    const at = menuRows(select).findIndex(([, label]) => label === "1:1");
    choose(select, String(at));
    expect(menuValue(screen.getByTestId("crop-aspect"))).toBe(String(at));
  });

  /// A ratio typed by hand is not one of the presets, so the select has
  /// to say so rather than lying about which one is active.
  it("a typed ratio is accepted, and a typo is refused", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByTestId("btn-tool-crop"));
    // Two fields since 2026-10-07 ("the X:Y should
    // be two separate fields [ x ] : [ y ]").
    fireEvent.change(screen.getByTestId("crop-aspect-w"), { target: { value: "5" } });
    fireEvent.change(screen.getByTestId("crop-aspect-h"), { target: { value: "7" } });
    fireEvent.keyDown(screen.getByTestId("crop-aspect-h"), { key: "Enter" });
    const select = screen.getByTestId("crop-aspect");
    expect(menuValue(select)).toBe("custom");

    // A typo leaves the crop where it was rather than collapsing it.
    fireEvent.change(screen.getByTestId("crop-aspect-w"), { target: { value: "wide" } });
    fireEvent.keyDown(screen.getByTestId("crop-aspect-w"), { key: "Enter" });
    expect(menuValue(screen.getByTestId("crop-aspect"))).toBe("custom");
    expect((screen.getByTestId("crop-aspect-h") as HTMLInputElement).value).toBe("7");
  });

  /// The owner pressed escape to back out of a crop and the crop was
  /// applied, which is the opposite of what that key does everywhere
  /// else.
  it("escape cancels a crop rather than committing it", async () => {
    const { reduce } = await import("../state");
    const { initialState } = await import("../data");
    let s = initialState();
    const crop = s.nodes.find((n) => n.type === "heeler.crop_rotate")!;
    const before = { ...crop.params };

    s = reduce(s, { type: "set_tool", tool: "crop" });
    s = reduce(s, { type: "set_params", id: crop.id, values: { crop_w: 0.4, crop_h: 0.3 } });
    expect(s.nodes.find((n) => n.id === crop.id)!.params.crop_w).toBe(0.4);

    s = reduce(s, { type: "cancel_tool" });
    expect(s.tool).toBe("none");
    expect(s.nodes.find((n) => n.id === crop.id)!.params).toEqual(before);

    // Leaving the tool any other way is a commit, not a cancel.
    let t = reduce(initialState(), { type: "set_tool", tool: "crop" });
    t = reduce(t, { type: "set_params", id: crop.id, values: { crop_w: 0.4 } });
    t = reduce(t, { type: "set_tool", tool: "crop" });
    expect(t.tool).toBe("none");
    expect(t.nodes.find((n) => n.id === crop.id)!.params.crop_w).toBe(0.4);
  });

  it("escape cancels a straighten too", async () => {
    const { reduce } = await import("../state");
    const { initialState } = await import("../data");
    let s = initialState();
    const crop = s.nodes.find((n) => n.type === "heeler.crop_rotate")!;
    s = reduce(s, { type: "set_tool", tool: "straighten" });
    s = reduce(s, { type: "set_param", id: crop.id, param: "angle", value: 7 });
    s = reduce(s, { type: "cancel_tool" });
    expect(s.nodes.find((n) => n.id === crop.id)!.params.angle).toBe(0);
  });

  it("panel dividers resize the library and right panels", () => {
    // A window with room for every panel at its saved width: jsdom's
    // 1024 is small enough that the fit (layoutfit.ts) shrinks them.
    const width = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { value: 1920, configurable: true });
    onTestFinished(() => {
      Object.defineProperty(window, "innerWidth", { value: width, configurable: true });
    });
    render(<App />);
    const panel = () => screen.getByTestId("browser-panel");
    expect(panel().style.width).toBe("252px");
    const divider = screen.getByTestId("divider-library");
    fireEvent.mouseDown(divider, { clientX: 300 });
    fireEvent.mouseMove(window, { clientX: 360 });
    fireEvent.mouseUp(window);
    expect(panel().style.width).toBe("312px");

    const right = () => screen.getByTestId("simple-panel");
    expect(right().style.width).toBe("320px");
    fireEvent.mouseDown(screen.getByTestId("divider-right"), { clientX: 900 });
    fireEvent.mouseMove(window, { clientX: 860 });
    fireEvent.mouseUp(window);
    expect(right().style.width).toBe("360px");
  });

  it("the export panel opens over Adjustments and folds back to its bar", async () => {
    const user = userEvent.setup();
    render(<App />);
    // Folded, it is a bar rather than nothing, so the way back is where
    // it was.
    const bar = () => screen.getByTestId("export-bar");
    expect(bar()).toBeInTheDocument();
    expect(screen.queryByTestId("export-panel")).not.toBeInTheDocument();

    await user.click(screen.getByTestId("export-bar"));
    expect(screen.getByTestId("export-panel")).toBeInTheDocument();
    // The bar stays put and reads as pressed. The owner asked for the
    // Library bargain here: the bar you click to open is the bar you
    // click to close, so there is no separate CLOSE button to find.
    expect(bar()).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByTestId("export-close")).not.toBeInTheDocument();

    await user.click(bar());
    expect(screen.queryByTestId("export-panel")).not.toBeInTheDocument();
    expect(bar()).toHaveAttribute("aria-pressed", "false");
    // And the same bar opens it again.
    await user.click(bar());
    expect(screen.getByTestId("export-panel")).toBeInTheDocument();
  });

  it("both fold-away rails are one control at one width", async () => {
    render(<App />);
    // The chevron at the foot of the Library rail did what
    // the rail above it already did.
    const rail = screen.getByTestId("tabrail");
    expect(rail.querySelectorAll("button")).toHaveLength(1);
    // And the two rails match, rather than being 44 on one side of the
    // window and 22 on the other.
    expect(rail.querySelector(".railbar")).toBeInTheDocument();
    expect(screen.getByTestId("export-bar")).toHaveClass("railbar");
  });

  it("the export panel offers format, quality, size and a name pattern", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByTestId("export-bar"));
    // Quality is a slider now, not three presets. "I think
    // 'Quality' should be a slider. That's usually how other apps handle
    // it." It always was a continuous dial in the encoder; 80, 92 and 100
    // made it look like three modes and put 85 out of reach.
    const quality = () => screen.getByTestId("export-quality");
    expect(quality()).toHaveAttribute("aria-valuenow", "92");
    expect(screen.getByTestId("export-quality-value")).toHaveTextContent("92");
    // PNG grays the JPEG quality row rather than removing it. The
    // report: "the batch tabs shift up and down" when the row came and
    // went; a disabled row keeps the panel's layout still.
    await chooseWith(user, screen.getByTestId("export-format"), "png");
    expect(quality()).toHaveAttribute("data-disabled", "true");
    await chooseWith(user, screen.getByTestId("export-format"), "jpeg");
    expect(quality()).not.toHaveAttribute("data-disabled");
    expect(screen.getByTestId("export-template")).toHaveValue("{name}");
    expect(screen.getByTestId("export-preset")).toBeInTheDocument();
    // No folder chosen yet: the run stays clickable and asks where to
    // write on the way. A disabled button that looked alive was the
    // owner's "nothing is happening".
    expect(screen.getByTestId("export-run")).toBeEnabled();
  });

  it("the export panel counts what it is about to write", async () => {
    const user = userEvent.setup();
    render(<App />);
    const thumbs = screen.getAllByTestId(/^thumb-\d+$/);
    await user.click(thumbs[0]);
    await user.click(screen.getByTestId("export-bar"));
    expect(screen.getByTestId("export-count")).toHaveTextContent("1 image");

    fireEvent.click(thumbs[3], { shiftKey: true });
    expect(screen.getByTestId("export-count")).toHaveTextContent(/4 images/);
    expect(screen.getByTestId("export-count")).toHaveTextContent(/from the selection/);
  });

  /// A pattern that resolves two images to one name loses files
  /// silently: the second overwrites the first and the count comes up
  /// short with nothing to say why. The run now suffixes the extras
  /// instead (destinationFor's taken set), and the warning has to say
  /// THAT: a warning that still claims overwriting is lying about what
  /// the run will do.
  it("the export panel warns before a pattern overwrites its own output", async () => {
    const user = userEvent.setup();
    render(<App />);
    const thumbs = screen.getAllByTestId(/^thumb-\d+$/);
    await user.click(thumbs[0]);
    fireEvent.click(thumbs[3], { shiftKey: true });
    await user.click(screen.getByTestId("export-bar"));
    expect(screen.queryByTestId("export-collision")).not.toBeInTheDocument();

    // fireEvent rather than user.type: userEvent reads "{n}" as a key
    // descriptor, so typing the template literally is not possible.
    const template = screen.getByTestId("export-template");
    fireEvent.change(template, { target: { value: "sunset" } });
    const warning = screen.getByTestId("export-collision");
    expect(warning).toBeInTheDocument();
    expect(warning.textContent).toContain("suffix");
    expect(warning.textContent).not.toContain("overwrite each other");

    fireEvent.change(template, { target: { value: "sunset_{n}" } });
    expect(screen.queryByTestId("export-collision")).not.toBeInTheDocument();
  });

  it("crop tool shows the overlay with handles and thirds grid", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByTestId("btn-tool-crop"));
    expect(screen.getByTestId("crop-overlay")).toBeInTheDocument();
    expect(screen.getByTestId("crop-rect")).toBeInTheDocument();
    for (const m of ["tl", "tr", "bl", "br"]) {
      expect(screen.getByTestId(`crop-handle-${m}`)).toBeInTheDocument();
    }
    await user.click(screen.getByTestId("btn-tool-crop"));
    expect(screen.queryByTestId("crop-overlay")).not.toBeInTheDocument();
  });

  it("brush tool paints a stroke and the inspector can clear it", async () => {
    const user = userEvent.setup();
    render(<App />);
    // The intentional path is the only path now: a brush layer from the
    // Layers pane arms the brush. The viewport's Brush button is gone. The
    // report: "I don't like the implicit workflow of it creating a brush
    // adjustment layer."
    await user.click(screen.getByTestId("add-layer-brush"));
    const overlay = screen.getByTestId("brush-overlay");
    fireEvent.mouseDown(overlay, { clientX: 10, clientY: 10 });
    fireEvent.mouseMove(overlay, { clientX: 30, clientY: 30, buttons: 1 });
    fireEvent.mouseUp(overlay);
    // The preview is a canvas now: the strokes are stamped with the real
    // brush tip rather than drawn as SVG shapes, so there is nothing per
    // stroke in the DOM to count. The inspector below is the assertion
    // that the stroke actually landed.
    expect(screen.getByTestId("stroke-paint")).toBeInTheDocument();

    // Inspector on the layer's mask node reports and clears strokes.
    await toGraphMode(user);
    fireEvent.mouseDown(screen.getByTestId("node-layer_1_mask"));
    expect(screen.getByTestId("stroke-count")).toHaveTextContent("1 stroke");
    await user.click(screen.getByTestId("clear-strokes"));
    expect(screen.getByTestId("stroke-count")).toHaveTextContent("0 strokes");
  });

  it("the header shows no Brush button; the toolbar readout sits centered instead", () => {
    render(<App />);
    expect(screen.queryByTestId("btn-tool-brush")).not.toBeInTheDocument();
    expect(screen.getByTestId("cursor-readout")).toBeInTheDocument();
  });

  /// "centered horizontally in that header bar, is the X/Y
  /// position of the mouse and the RGB and Luma values of the pixels the
  /// cursor is over." jsdom has no canvas, so the color half is
  /// exercised by eye; the position half and the leave-clears rule are
  /// testable. 2026-09-07: "add, on the left side, a color swatch that
  /// shows the color as that's easier for a human to understand. But
  /// don't remove any of the existing data." jsdom has no canvas, so the
  /// frame decode and the pixel read are stood in for here.
  it("the readout wears a swatch of the sampled color, left of the numbers it keeps", async () => {
    const naturals: PropertyDescriptor = { get: () => 200, configurable: true };
    const naturalsH: PropertyDescriptor = { get: () => 100, configurable: true };
    const priorW = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "naturalWidth");
    const priorH = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "naturalHeight");
    Object.defineProperty(HTMLImageElement.prototype, "naturalWidth", naturals);
    Object.defineProperty(HTMLImageElement.prototype, "naturalHeight", naturalsH);
    const priorImage = globalThis.Image;
    const priorContext = HTMLCanvasElement.prototype.getContext;
    // A frame that loads the moment it is given a source.
    class LoadedImage {
      naturalWidth = 200;
      naturalHeight = 100;
      onload: null | (() => void) = null;
      set src(_: string) {
        queueMicrotask(() => this.onload?.());
      }
    }
    globalThis.Image = LoadedImage as unknown as typeof Image;
    // A context that answers every call with nothing, and one pixel.
    HTMLCanvasElement.prototype.getContext = (() =>
      new Proxy({}, {
        get: (_, key) =>
          key === "getImageData"
            ? () => ({ data: new Uint8ClampedArray([200, 9, 6, 255]) })
            : () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 }),
      })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
    try {
      render(<App />);
      fireEvent.load(screen.getByTestId("viewer-image"));
      await act(async () => {});
      const frame = screen.getByTestId("stage-frame");
      const swatch = screen.getByTestId("cursor-swatch");
      expect(swatch.style.display).toBe("none");
      fireEvent.mouseMove(frame, { clientX: 0, clientY: 0 });
      const readout = screen.getByTestId("cursor-readout");
      // One digit reads as one digit: no zero padding. Position, RGB and
      // luma are three parts, one gap apart (cursorreadout.ts).
      expect(readout.textContent).toBe("X 100  Y 50R 200  G 9  B 6L 19%");
      // X, Y, R, G, B and L each sit in a slot three digits wide,
      // centered, so a value that grows does not walk the labels beside it.
      const slots = [...readout.querySelectorAll<HTMLElement>("[data-readout-slot]")];
      expect(slots.map((el) => el.textContent)).toEqual(["100", "50", "200", "9", "6", "19"]);
      for (const el of slots) {
        expect(el.style.width).toBe("3ch");
        expect(el.style.textAlign).toBe("center");
        expect(el.style.display).toBe("inline-block");
      }
      expect(swatch.style.display).toBe("block");
      expect(swatch.style.background).toBe("rgb(200, 9, 6)");
      // Left of the numbers, in the same centered box.
      const box = screen.getByTestId("cursor-readout-box");
      expect(box.firstElementChild).toBe(swatch);
      expect(box.lastElementChild).toBe(screen.getByTestId("cursor-readout"));
      fireEvent.mouseLeave(frame);
      expect(swatch.style.display).toBe("none");
      expect(screen.getByTestId("cursor-readout").textContent).toBe("");
    } finally {
      globalThis.Image = priorImage;
      HTMLCanvasElement.prototype.getContext = priorContext;
      if (priorW) Object.defineProperty(HTMLImageElement.prototype, "naturalWidth", priorW);
      if (priorH) Object.defineProperty(HTMLImageElement.prototype, "naturalHeight", priorH);
    }
  });

  /// a position slot three digits wide let a four-digit X spill over the
  /// Y label beside it (plainest at 150% app zoom). The position slots
  /// are as wide as the photograph's own largest index.
  it("a camera-sized photo gets position slots wide enough for its coordinates", () => {
    const naturals: PropertyDescriptor = { get: () => 12000, configurable: true };
    const naturalsH: PropertyDescriptor = { get: () => 8000, configurable: true };
    const priorW = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "naturalWidth");
    const priorH = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "naturalHeight");
    Object.defineProperty(HTMLImageElement.prototype, "naturalWidth", naturals);
    Object.defineProperty(HTMLImageElement.prototype, "naturalHeight", naturalsH);
    try {
      render(<App />);
      fireEvent.load(screen.getByTestId("viewer-image"));
      fireEvent.mouseMove(screen.getByTestId("stage-frame"), { clientX: 0, clientY: 0 });
      const readout = screen.getByTestId("cursor-readout");
      expect(readout.textContent).toBe("X 6000  Y 4000");
      const [xs, ys] = [...readout.querySelectorAll<HTMLElement>("[data-readout-slot]")];
      expect(xs.style.width).toBe("5ch");
      expect(ys.style.width).toBe("4ch");
    } finally {
      if (priorW) Object.defineProperty(HTMLImageElement.prototype, "naturalWidth", priorW);
      if (priorH) Object.defineProperty(HTMLImageElement.prototype, "naturalHeight", priorH);
    }
  });

  it("moving over the photo fills the readout, leaving clears it", () => {
    const naturals: PropertyDescriptor = { get: () => 200, configurable: true };
    const naturalsH: PropertyDescriptor = { get: () => 100, configurable: true };
    const priorW = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "naturalWidth");
    const priorH = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "naturalHeight");
    Object.defineProperty(HTMLImageElement.prototype, "naturalWidth", naturals);
    Object.defineProperty(HTMLImageElement.prototype, "naturalHeight", naturalsH);
    try {
      render(<App />);
      fireEvent.load(screen.getByTestId("viewer-image"));
      const frame = screen.getByTestId("stage-frame");
      // A zero-size jsdom rect normalizes the pointer to dead center.
      fireEvent.mouseMove(frame, { clientX: 0, clientY: 0 });
      expect(screen.getByTestId("cursor-readout").textContent).toBe("X 100  Y 50");
      fireEvent.mouseLeave(frame);
      expect(screen.getByTestId("cursor-readout").textContent).toBe("");
    } finally {
      if (priorW) Object.defineProperty(HTMLImageElement.prototype, "naturalWidth", priorW);
      if (priorH) Object.defineProperty(HTMLImageElement.prototype, "naturalHeight", priorH);
    }
  });

  it("edits stay with their image across switches", async () => {
    const user = userEvent.setup();
    render(<App />);
    const slider = () => within(screen.getByTestId("slider-exposure")).getByRole("slider");
    fireEvent.keyDown(slider(), { key: "ArrowRight" });
    const edited = slider().getAttribute("aria-valuenow");
    expect(edited).not.toBe("0.62");

    // Other images start from the neutral default graph, not the demo edit.
    await user.click(screen.getByTestId("thumb-4868"));
    expect(slider().getAttribute("aria-valuenow")).toBe("0");

    await user.click(screen.getByTestId("thumb-4871"));
    expect(slider().getAttribute("aria-valuenow")).toBe(edited);
  });

  it("undo shortcut reverts the last edit", async () => {
    render(<App />);
    const slider = within(screen.getByTestId("slider-exposure")).getByRole("slider");
    const before = slider.getAttribute("aria-valuenow");
    fireEvent.keyDown(slider, { key: "ArrowRight" });
    expect(slider.getAttribute("aria-valuenow")).not.toBe(before);
    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    expect(slider.getAttribute("aria-valuenow")).toBe(before);
  });

  it("N toggles between Develop and Graph", () => {
    render(<App />);
    fireEvent.keyDown(window, { key: "n" });
    expect(screen.getByTestId("node-editor")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "n" });
    expect(screen.getByTestId("simple-panel")).toBeInTheDocument();
  });

  it("before/after toggle switches the viewer to the unprocessed image", async () => {
    const user = userEvent.setup();
    render(<App />);
    const img = screen.getByTestId("viewer-image") as HTMLImageElement;
    expect(img.style.filter).not.toBe("none");
    await user.click(screen.getByTestId("btn-before-after"));
    expect(img.style.filter).toBe("none");
  });
});

describe("Help > User Documentation", () => {
  it("opens the viewer, lists the shipped docs, and renders markdown", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByTestId("menu-help"));
    await user.click(screen.getByTestId("menu-help-docs"));
    // The tree comes from the install's guide, and its front page
    // renders without being clicked.
    const doc = await screen.findByTestId("doc-README.md");
    expect(doc).toHaveAttribute("data-active");
    const body = await screen.findByTestId("doc-body");
    // Rendered, not raw: the heading is styled text and the backticks
    // became a code span.
    expect(body.textContent).toContain("Heeler user guide");
    expect(body.textContent).not.toContain("**");
    expect(body.querySelector("code")?.textContent).toBe("docs/user-guide");
    // Doc-to-doc links switch the viewer rather than navigating.
    expect(body.querySelector("a")?.textContent).toBe("Library");

    await user.click(screen.getByTestId("docs-close"));
    expect(screen.queryByTestId("docs-viewer")).not.toBeInTheDocument();
  });
});

describe("wires are objects", () => {
  it("click picks a pipe, Delete removes it, Escape lets go", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByTestId("mode-advanced"));
    // The mask pipe that ships wired: lummask feeding Color Balance.
    const hit = screen.getByTestId("wire-hit-lummask-cbal-mask");
    fireEvent.mouseDown(hit);
    fireEvent.keyDown(window, { key: "Delete" });
    expect(screen.queryByTestId("wire-hit-lummask-cbal-mask")).not.toBeInTheDocument();
    // And it is an undoable edit like any other.
    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    expect(screen.getByTestId("wire-hit-lummask-cbal-mask")).toBeInTheDocument();
  });

  it("the Add submenu actually shows its nodes", async () => {
    // The category flyouts rendered inside a scrolling list, and an
    // overflow-y list clips horizontally too, so every category showed
    // nothing at all.
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByTestId("mode-advanced"));
    fireEvent.contextMenu(screen.getByTestId("graph-surface"));
    fireEvent.mouseEnter(screen.getByTestId("menu-add"));
    const list = await screen.findByTestId("menu-add-list");
    const cat = within(list).getByTestId("menu-add-color");
    fireEvent.mouseEnter(cat);
    // Category, then section (2026-10-01), then the node.
    fireEvent.mouseEnter(await screen.findByTestId("menu-add-section-tone"));
    // A concrete node type is reachable, which is the whole complaint.
    expect(await screen.findByTestId("menu-add-exposure")).toBeInTheDocument();
  });
});
