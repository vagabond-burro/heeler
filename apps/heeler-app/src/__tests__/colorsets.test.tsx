// Color Sets: the Develop lens over csetN mask/grade node pairs.
// Half of these tests drive the panel like a person; the other half
// pin the pure splice math, chain healing included.
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "../app";
import { autoNoiseStrengths } from "../bridge";
import { addColorSet, bandAfterPick, listColorSets, oklabHueChroma, removeColorSet } from "../colorsets";
import type { NodeCard, Wire } from "../state";

function chain(): { nodes: NodeCard[]; wires: Wire[] } {
  const node = (id: string, type: string): NodeCard =>
    ({
      id,
      type,
      name: id,
      cat: "color",
      x: 0,
      y: 0,
      enabled: true,
      params: {},
      hasIn: id !== "src",
      hasOut: id !== "output",
    }) as NodeCard;
  return {
    nodes: [
      node("src", "heeler.image_source"),
      node("bend", "heeler.color_bend"),
      node("profile", "heeler.tone_profile"),
      node("output", "heeler.output"),
    ],
    wires: [
      { from: "src", to: "bend", toPort: "in", kind: "image" },
      { from: "bend", to: "profile", toPort: "in", kind: "image" },
      { from: "profile", to: "output", toPort: "in", kind: "image" },
    ],
  };
}

describe("color set splice math", () => {
  it("a new set lands between the bend and the profile, mask on the input", () => {
    const { nodes, wires } = chain();
    const out = addColorSet(nodes, wires)!;
    expect(out.setN).toBe(1);
    const w = out.wires;
    expect(w).toContainEqual({ from: "bend", to: "cset1_grade", toPort: "in", kind: "image" });
    expect(w).toContainEqual({ from: "bend", to: "cset1_mask", toPort: "in", kind: "image" });
    expect(w).toContainEqual({ from: "cset1_mask", to: "cset1_grade", toPort: "mask", kind: "mask" });
    expect(w).toContainEqual({ from: "cset1_grade", to: "profile", toPort: "in", kind: "image" });
    // The straight bend-to-profile wire came out.
    expect(w).not.toContainEqual({ from: "bend", to: "profile", toPort: "in", kind: "image" });
    // The pair starts in step: one center, both nodes.
    const sets = listColorSets(out.nodes);
    expect(sets).toHaveLength(1);
    expect(sets[0].mask.params.band_center).toBe(sets[0].grade.params.band_center);
  });

  it("a second set chains after the first, and delete heals around either", () => {
    const first = addColorSet(chain().nodes, chain().wires)!;
    const second = addColorSet(first.nodes, first.wires)!;
    expect(second.setN).toBe(2);
    expect(second.wires).toContainEqual({ from: "cset1_grade", to: "cset2_grade", toPort: "in", kind: "image" });
    expect(second.wires).toContainEqual({ from: "cset2_grade", to: "profile", toPort: "in", kind: "image" });

    // Removing the FIRST set reconnects the bend straight to the second.
    const healed = removeColorSet(second.nodes, second.wires, 1);
    expect(listColorSets(healed.nodes).map((s) => s.n)).toEqual([2]);
    expect(healed.wires).toContainEqual({ from: "bend", to: "cset2_grade", toPort: "in", kind: "image" });
    expect(healed.wires.some((w) => w.from.startsWith("cset1_") || w.to.startsWith("cset1_"))).toBe(false);
    // And the second set's mask now samples the bend, its new input.
    expect(healed.wires).toContainEqual({ from: "bend", to: "cset2_mask", toPort: "in", kind: "image" });
  });
});

describe("the eyedropper's arithmetic", () => {
  it("mirrors the engine's OkLab hue for the reference colors", () => {
    // Linear red per the engine's pinned reference: a 0.2249, b 0.1258,
    // hue atan2(b, a) ~ 29.2 degrees.
    const red = oklabHueChroma(1, 0, 0);
    expect(Math.abs(red.hue - 29.2)).toBeLessThan(0.5);
    // A neutral has (near) zero chroma: the gate the overlay relies on.
    expect(oklabHueChroma(0.4, 0.4, 0.4).chroma).toBeLessThan(1e-4);
  });

  it("center moves the band, add grows the near edge, remove shrinks it", () => {
    // Plain pick: center follows, width untouched.
    expect(bandAfterPick(30, 60, 200, "center")).toEqual({ center: 200, range: 60 });
    // Add a hue outside the band: the far edge stays planted (0
    // stays covered), the near edge reaches the pick.
    const grown = bandAfterPick(30, 60, 90, "add");
    expect(grown.range).toBeGreaterThan(60);
    const lo = grown.center - grown.range / 2;
    const hi = grown.center + grown.range / 2;
    expect(lo).toBeLessThanOrEqual(1);
    expect(hi).toBeGreaterThanOrEqual(90);
    // Adding a hue already inside changes nothing.
    expect(bandAfterPick(30, 60, 40, "add")).toEqual({ center: 30, range: 60 });
    // Remove a hue inside: it ends up outside the core.
    const shrunk = bandAfterPick(30, 60, 50, "remove");
    const half = shrunk.range / 2;
    expect(Math.abs(50 - shrunk.center)).toBeGreaterThan(half);
    // Removing a hue already outside changes nothing.
    expect(bandAfterPick(30, 60, 200, "remove")).toEqual({ center: 30, range: 60 });
  });

  it("grows across the red seam without losing the far edge", () => {
    // Band centered at 350; add hue 40 (across 0). Far edge (310)
    // must stay covered.
    const grown = bandAfterPick(350, 80, 40, "add");
    const covers = (h: number) => {
      let d = Math.abs(h - grown.center) % 360;
      if (d > 180) d = 360 - d;
      return d <= grown.range / 2;
    };
    expect(covers(310)).toBe(true);
    expect(covers(40)).toBe(true);
  });
});

describe("the Color Sets panel", () => {
  it("adds a set, grades through it, renames it, and deletes it clean", async () => {
    render(<App />);
    const block = screen.getByTestId("color-sets");
    fireEvent.click(within(block).getByTestId("add-color-set"));

    // The set appears with its strip and sliders.
    const set = screen.getByTestId("color-set-1");
    expect(within(set).getByTestId("hue-strip-1")).toBeInTheDocument();
    const sat = within(within(set).getByTestId("slider-saturation")).getByRole("slider");
    fireEvent.keyDown(sat, { key: "ArrowRight" });
    expect(Number(sat.getAttribute("aria-valuenow"))).toBeGreaterThan(0);

    // The pair is real graph machinery, visible in Graph mode.
    const tablist = screen.getByRole("tablist", { name: /workspace mode/i });
    fireEvent.click(tablist.children[1]);
    expect(screen.getByTestId("node-cset1_grade")).toBeInTheDocument();
    expect(screen.getByTestId("node-cset1_mask")).toBeInTheDocument();
    fireEvent.click(tablist.children[0]);

    // Rename via the panel: the grade node carries the name.
    fireEvent.doubleClick(screen.getByTestId("color-set-name-1"));
    const field = screen.getByTestId("rename-color-set-1");
    fireEvent.change(field, { target: { value: "Skin tones" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(screen.getByTestId("color-set-name-1")).toHaveTextContent("Skin tones");

    // The toggle is the reversible off; delete really deletes.
    fireEvent.click(screen.getByTestId("toggle-color-set-1"));
    expect(screen.getByTestId("toggle-color-set-1").getAttribute("data-on")).toBe("false");
    fireEvent.click(screen.getByTestId("delete-color-set-1"));
    expect(screen.queryByTestId("color-set-1")).not.toBeInTheDocument();
    fireEvent.click(tablist.children[1]);
    expect(screen.queryByTestId("node-cset1_grade")).not.toBeInTheDocument();
  });

  it("the graph inspector shows the full set of controls, strip included", () => {
    // "I was previewing the node in the graph, it looks
    // terribly incomplete." The grade was seeded with only the strip's
    // params and the generic inspector renders from the instance, so it
    // showed one slider. Now the pair migrates to its full identity set
    // and both nodes have hand-built editors.
    render(<App />);
    fireEvent.click(screen.getByTestId("add-color-set"));
    const tablist = screen.getByRole("tablist", { name: /workspace mode/i });
    fireEvent.click(tablist.children[1]);

    // Either half of the pair answers with the WHOLE set: strip plus
    // all six sliders, exactly the Adjustments panel's controls.
    for (const half of ["node-cset1_grade", "node-cset1_mask"]) {
      fireEvent.mouseDown(screen.getByTestId(half));
      fireEvent.mouseUp(window);
      expect(screen.getByTestId("hue-strip-1")).toBeInTheDocument();
      for (const p of ["hue_range", "hue_falloff", "hue_shift", "saturation", "exposure", "uniformity"]) {
        expect(screen.getByTestId(`slider-${p}`)).toBeInTheDocument();
      }
    }
  });

  it("the dropper arms from the set header and the viewer offers the overlay", () => {
    render(<App />);
    fireEvent.click(screen.getByTestId("add-color-set"));
    expect(screen.queryByTestId("cset-dropper-overlay")).not.toBeInTheDocument();
    const btn = screen.getByTestId("dropper-color-set-1");
    fireEvent.click(btn);
    expect(btn.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("cset-dropper-overlay")).toBeInTheDocument();
    // The button is a toggle, like the curve pick's.
    fireEvent.click(btn);
    expect(screen.queryByTestId("cset-dropper-overlay")).not.toBeInTheDocument();
  });

  it("the status line names the armed picker and Esc puts it away", () => {
    // "The picker should turn off with the ESC key,
    // and that should be clear in the status line."
    render(<App />);
    fireEvent.click(screen.getByTestId("add-color-set"));
    fireEvent.click(screen.getByTestId("dropper-color-set-1"));
    expect(screen.getByTestId("cset-dropper-overlay")).toBeInTheDocument();
    const seat = screen.getByTestId("status-cset-pick");
    expect(seat.textContent).toContain("Esc turns the picker off");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("cset-dropper-overlay")).not.toBeInTheDocument();
    expect(screen.queryByTestId("status-cset-pick")).not.toBeInTheDocument();
  });

  it("deleting the set while its picker is armed puts the cursor down", () => {
    // "If I delete the color set while the picker for that
    // same set is active, the picker tool stays active. My cursor does
    // not reset until I add a new color set."
    render(<App />);
    fireEvent.click(screen.getByTestId("add-color-set"));
    fireEvent.click(screen.getByTestId("dropper-color-set-1"));
    expect(screen.getByTestId("cset-dropper-overlay")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("delete-color-set-1"));
    expect(screen.queryByTestId("cset-dropper-overlay")).not.toBeInTheDocument();
  });

  it("arming the picker leaves the strip whole; only a held click moves the band", () => {
    // A hover-tracking candidate was built and the owner pulled it the
    // same day: "Let's only update the color selection when the user is
    // pressing and hold left-click." The strip must show its full band,
    // falloff and grips while the picker is merely armed. A hover's ghost
    // (csetghost.test.tsx) is the one thing it may add.
    render(<App />);
    fireEvent.click(screen.getByTestId("add-color-set"));
    fireEvent.click(screen.getByTestId("dropper-color-set-1"));
    expect(screen.getByTestId("cset-dropper-overlay")).toBeInTheDocument();
    expect(screen.getByTestId("hue-band-1")).toBeInTheDocument();
    expect(screen.getByTestId("hue-edge-lo-1")).toBeInTheDocument();
    expect(screen.getByTestId("hue-edge-hi-1")).toBeInTheDocument();
    // Moving the mouse over the image with no button down is inert.
    fireEvent.mouseMove(screen.getByTestId("cset-dropper-overlay"), { clientX: 40, clientY: 40 });
    expect(screen.getByTestId("hue-band-1")).toBeInTheDocument();
  });

  it("adding and deleting are one undo step each", () => {
    render(<App />);
    fireEvent.click(screen.getByTestId("add-color-set"));
    expect(screen.getByTestId("color-set-1")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    expect(screen.queryByTestId("color-set-1")).not.toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Z", ctrlKey: true, shiftKey: true });
    expect(screen.getByTestId("color-set-1")).toBeInTheDocument();
  });
});

describe("Auto noise (NLF)", () => {
  it("maps bigger sigmas to bigger strengths, capped short of the mush zone", () => {
    const quiet = autoNoiseStrengths({ luma_sigma: 0.002, chroma_sigma: 0.003 });
    const loud = autoNoiseStrengths({ luma_sigma: 0.02, chroma_sigma: 0.03 });
    expect(loud.luma).toBeGreaterThan(quiet.luma);
    expect(loud.chroma).toBeGreaterThan(quiet.chroma);
    // The caps: Auto must never dial in the destructive top end.
    const extreme = autoNoiseStrengths({ luma_sigma: 9, chroma_sigma: 9 });
    expect(extreme.luma).toBeLessThanOrEqual(60);
    expect(extreme.chroma).toBeLessThanOrEqual(80);
    // A clean frame stays untouched: below the luminance noise floor
    // the answer is zero, not a little smoothing for its own sake.
    expect(autoNoiseStrengths({ luma_sigma: 0.001, chroma_sigma: 0.0 }).luma).toBe(0);
  });

  it("reproduces the owner's calibration picks on his own frames", () => {
    // The two photographs the constants were fitted through, engine
    // sigmas measured on the actual files (2026-08-23). If a constant
    // drifts, this says whose taste it was calibrated to.
    const raf = autoNoiseStrengths({ luma_sigma: 0.004636, chroma_sigma: 0.018624 });
    expect(raf).toEqual({ luma: 16, chroma: 31 });
    const rw2 = autoNoiseStrengths({ luma_sigma: 0.003787, chroma_sigma: 0.013984 });
    expect(rw2).toEqual({ luma: 7, chroma: 23 });
  });

  it("the AUTO button rides the Noise Reduction section and fails safe in the mock", () => {
    render(<App />);
    // The sample session carries the NR block, so the button is there
    // from boot; outside the app the estimator answers null and the
    // click must change nothing rather than guess.
    const auto = screen.getByTestId("noise-auto");
    const lumaRow = screen
      .getAllByTestId("slider-strength")
      .find((el) => el.dataset.node === "dn_luma_nr")!;
    const before = lumaRow.textContent;
    fireEvent.click(auto);
    expect(lumaRow.textContent).toBe(before);
  });
});

describe("the Color Sets header and set rows", () => {
  it("adds from an icon and closes from a drawn cross, with room between the widgets", async () => {
    const { render, screen } = await import("@testing-library/react");
    const { initialState } = await import("../data");
    const { reduce } = await import("../state");
    const { ColorSetsBlock } = await import("../ui/colorsets");
    const s = reduce(initialState(), { type: "add_color_set" });
    render(<ColorSetsBlock state={s} dispatch={() => {}} />);
    const add = screen.getByTestId("add-color-set");
    expect(add.textContent).toBe("");
    expect(add.querySelector("svg")).not.toBeNull();
    expect(add.getAttribute("aria-label")).toBe("Add a color set");
    const close = screen.getByTestId("delete-color-set-1");
    expect(close.textContent).toBe("");
    expect(close.querySelector("svg")?.getAttribute("width")).toBe("12");
    expect((close.parentElement as HTMLElement).style.gap).toBe("10px");
  });
});

describe("a color set in the Graph inspector", () => {
  it("keeps its Depth controls in a popped-out inspector without a viewer", async () => {
    const { Inspector } = await import("../ui/graph");
    const { initialState } = await import("../data");
    const { reduce } = await import("../state");
    let s = reduce(initialState(), { type: "add_color_set" });
    s = reduce(s, { type: "set_param", id: "cset1_mask", param: "depth_on", value: 1 });
    s = reduce(s, { type: "select_nodes", ids: ["cset1_grade"] });
    render(<Inspector state={s} dispatch={() => {}} pickers={false} />);
    expect(screen.getByTestId("cset-depth-1-levels-editor")).toBeInTheDocument();
    expect(screen.queryByTestId("cset-depth-1-view")).toBeNull();
  });
  it("keeps its mask eye and eyedropper above its controls", async () => {
    const { render, screen } = await import("@testing-library/react");
    const { initialState } = await import("../data");
    const { reduce } = await import("../state");
    const { Inspector } = await import("../ui/graph");
    let s = reduce(initialState(), { type: "add_color_set" });
    s = reduce(s, { type: "select_nodes", ids: ["cset1_grade"] });
    render(<Inspector state={s} dispatch={() => {}} />);
    expect(screen.getByTestId("mask-view-color-set-1")).toBeInTheDocument();
    expect(screen.getByTestId("dropper-color-set-1")).toBeInTheDocument();
  });
});
