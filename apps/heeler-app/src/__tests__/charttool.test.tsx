import { StrictMode } from "react";
// The Color Checker's viewport chart tool (26.3 Phase 11): the quad
// with four draggable corners, the patch grid mapped through it, patch
// clicks excluding from the fit and patch drags nudging a center, the
// whole overlay armed and disarmed like every other picker.

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { initialState, NEUTRAL_NODES, NEUTRAL_WIRES } from "../data";
import { anyPickerArmed, reduce, type Command, type State } from "../state";
import {
  serializeGraph,
  chartCalibrate,
  chartDefs,
  chartExport,
  chartImport,
  chartPalette,
  chartSave,
  imageMetadata,
  presetList,
  presetRead,
  presetSave,
  type ChartDef,
} from "../bridge";
import {
  calibrationPreset,
  ChartToolOverlay,
  ColorCheckerControls,
  DEFAULT_QUAD,
  quadOf,
} from "../ui/colorchecker";
import { resetChartsForTests } from "../charts";
import { ChartEditor } from "../ui/charteditor";
import { choose, menuRows } from "./menuhelp";

// A small fake chart, 3 across x 2 down, so the grid and patch indices
// are easy to count.
const FAKE_CHART = {
  id: "colorchecker-classic",
  name: "Fake Chart",
  rows: 2,
  cols: 3,
  neutrals: [4],
  skin: [],
  patches: [
    { name: "p0", rgb: [0.5, 0.2, 0.1], target: true },
    { name: "p1", rgb: [0.1, 0.5, 0.2], target: true },
    { name: "p2", rgb: [0.2, 0.1, 0.5], target: true },
    { name: "p3", rgb: [0.6, 0.6, 0.2], target: true },
    { name: "p4", rgb: [0.5, 0.5, 0.5], target: true },
    { name: "p5", rgb: [0.9, 0.9, 0.9], target: true },
  ],
};

// The editor's target palette, as the desktop would answer it: ten
// entries over two source charts, grays marked neutral.
const FAKE_PALETTE = [
  { key: "red", name: "Red", lab: [53.2, 80.1, 67.2], rgb: [1, 0, 0], neutral: false, chart: "Test Primaries" },
  { key: "green", name: "Green", lab: [87.7, -86.2, 83.2], rgb: [0, 1, 0], neutral: false, chart: "Test Primaries" },
  { key: "blue", name: "Blue", lab: [32.3, 79.2, -107.9], rgb: [0, 0, 1], neutral: false, chart: "Test Primaries" },
  { key: "cyan", name: "Cyan", lab: [91.1, -48.1, -14.1], rgb: [0, 1, 1], neutral: false, chart: "Test Primaries" },
  { key: "magenta", name: "Magenta", lab: [60.3, 98.2, -60.8], rgb: [1, 0, 1], neutral: false, chart: "Test Primaries" },
  { key: "yellow", name: "Yellow", lab: [97.1, -21.6, 94.5], rgb: [1, 1, 0], neutral: false, chart: "Test Primaries" },
  { key: "gray-2", name: "Gray 2%", lab: [16.3, 0, 0], rgb: [0.16, 0.16, 0.16], neutral: true, chart: "Test Grays" },
  { key: "gray-18", name: "Gray 18%", lab: [49.5, 0, 0], rgb: [0.46, 0.46, 0.46], neutral: true, chart: "Test Grays" },
  { key: "gray-50", name: "Gray 50%", lab: [76.1, 0, 0], rgb: [0.74, 0.74, 0.74], neutral: true, chart: "Test Grays" },
  { key: "gray-90", name: "Gray 90%", lab: [95.9, 0, 0], rgb: [0.96, 0.96, 0.96], neutral: true, chart: "Test Grays" },
];

vi.mock("../bridge", async (importOriginal) => {
  const real = await importOriginal<typeof import("../bridge")>();
  return {
    ...real,
    chartDefs: vi.fn(async () => [FAKE_CHART]),
    chartPalette: vi.fn(async () => FAKE_PALETTE),
    // The mock plays the desktop's parser: the def comes back built from
    // the JSON the editor sent, targetless cells flagged.
    chartSave: vi.fn(async (json: string) => {
      const c = JSON.parse(json);
      return {
        id: c.id,
        name: c.name,
        rows: c.rows,
        cols: c.cols,
        neutrals: c.neutrals ?? [],
        skin: c.skin ?? [],
        patches: c.patches.map((p: { name: string; lab: number[] | null }) => ({
          name: p.name,
          rgb: [0.5, 0.5, 0.5],
          target: p.lab != null,
        })),
      };
    }),
    chartImport: vi.fn(async () => ({ imported: [] as string[], failed: [] as [string, string][] })),
    chartExport: vi.fn(async () => null),
    chartCalibrate: vi.fn(),
    presetList: vi.fn(async () => []),
    presetRead: vi.fn(),
    presetSave: vi.fn(async () => "ok"),
    imageMetadata: vi.fn(async () => null),
  };
});

vi.mock("../whitebalance", async (importOriginal) => {
  const real = await importOriginal<typeof import("../whitebalance")>();
  return {
    ...real,
    // The frame's average, answered per url so the overlays below read a
    // dark photograph and a light one without a decode. The urls are
    // distinct per test because the auto color cache is module-level.
    averageColor: vi.fn(async (url: string) =>
      url.includes("dark") ? { r: 0.05, g: 0.05, b: 0.05 } : { r: 0.95, g: 0.95, b: 0.95 },
    ),
  };
});

const run = (s: State, ...cmds: Command[]) => cmds.reduce(reduce, s);
const norm = (e: { clientX: number; clientY: number }) =>
  [e.clientX / 200, e.clientY / 100] as [number, number];

/** A state with the Color Checker section switched on: the node real. */
function withChecker(): State {
  const fresh = {
    ...initialState(),
    nodes: structuredClone(NEUTRAL_NODES),
    wires: structuredClone(NEUTRAL_WIRES),
  };
  return run(fresh, { type: "set_category", title: "Color Checker", on: true });
}

const nodeOf = (s: State) => s.nodes.find((n) => n.type === "heeler.color_checker")!;

const patchWrites = (got: Command[]) =>
  got.filter(
    (c): c is Extract<Command, { type: "set_text_param" }> =>
      c.type === "set_text_param" && c.param === "patches",
  );

beforeEach(() => {
  vi.clearAllMocks();
  resetChartsForTests();
});

describe("the chart overlay", () => {
  it("draws the default quad, the grid and one sample circle per patch", async () => {
    const s = run(withChecker(), { type: "toggle_chart_place", id: "colorchecker" });
    render(<ChartToolOverlay state={s} dispatch={() => {}} node={nodeOf(s)} norm={norm} />);
    expect(screen.getByTestId("chart-quad-outline")).toBeTruthy();
    for (let i = 0; i < 4; i++) expect(screen.getByTestId(`chart-corner-${i}`)).toBeTruthy();
    // The patches wait on the chart list's one ask of the desktop.
    await waitFor(() => expect(screen.getByTestId("chart-patch-5")).toBeTruthy());
    for (let i = 0; i < 6; i++) expect(screen.getByTestId(`chart-patch-${i}`)).toBeTruthy();
    expect(screen.queryByTestId("chart-patch-6")).toBeNull();
    expect(quadOf(nodeOf(s))).toEqual(DEFAULT_QUAD);
  });

  it("a corner drag writes the quad once per move, one undo step", async () => {
    const s = run(withChecker(), { type: "toggle_chart_place", id: "colorchecker" });
    const got: Command[] = [];
    render(<ChartToolOverlay state={s} dispatch={(c) => got.push(c)} node={nodeOf(s)} norm={norm} />);
    screen
      .getByTestId("chart-corner-0")
      .dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 40, clientY: 20 }));
    window.dispatchEvent(new MouseEvent("pointermove", { clientX: 30, clientY: 14 }));
    window.dispatchEvent(new MouseEvent("pointerup", {}));
    expect(got).toContainEqual({ type: "begin_gesture", key: "colorchecker.quad" });
    expect(got).toContainEqual({ type: "end_gesture" });
    const write = got.find(
      (c): c is Extract<Command, { type: "set_text_param" }> =>
        c.type === "set_text_param" && c.param === "quad",
    )!;
    const q = JSON.parse(write.value) as [number, number][];
    expect(q[0][0]).toBeCloseTo(0.15, 5);
    expect(q[0][1]).toBeCloseTo(0.14, 5);
    expect(q[1]).toEqual(DEFAULT_QUAD[1]);
  });

  // The 26.4.3 full review's R6, as for the light rig: a corner or patch
  // drag the window loses, or whose overlay goes away, ends its gesture
  // and stops following, and a patch drag cut short toggles nothing.
  for (const how of ["blur", "unmount"] as const) {
    it(`a corner and a patch drag ended by ${how} end their gestures and stop following`, async () => {
      const s = run(withChecker(), { type: "toggle_chart_place", id: "colorchecker" });
      const got: Command[] = [];
      const lose = (r: { unmount: () => void }) => (how === "blur" ? window.dispatchEvent(new Event("blur")) : r.unmount());
      let r = render(<ChartToolOverlay state={s} dispatch={(c) => got.push(c)} node={nodeOf(s)} norm={norm} />);
      screen.getByTestId("chart-corner-0").dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 40, clientY: 20 }));
      window.dispatchEvent(new MouseEvent("pointermove", { clientX: 30, clientY: 14 }));
      lose(r);
      expect(got.filter((c) => c.type === "end_gesture")).toHaveLength(1);
      const quads = got.filter((c) => c.type === "set_text_param").length;
      window.dispatchEvent(new MouseEvent("pointermove", { clientX: 10, clientY: 10 }));
      window.dispatchEvent(new MouseEvent("pointerup", {}));
      expect(got.filter((c) => c.type === "set_text_param"), "the corner stopped following").toHaveLength(quads);
      r.unmount();
      got.length = 0;
      r = render(<ChartToolOverlay state={s} dispatch={(c) => got.push(c)} node={nodeOf(s)} norm={norm} />);
      await waitFor(() => expect(screen.getByTestId("chart-patch-5")).toBeTruthy());
      screen.getByTestId("chart-patch-5").dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 100, clientY: 50 }));
      window.dispatchEvent(new MouseEvent("pointermove", { clientX: 120, clientY: 60 }));
      lose(r);
      expect(got.filter((c) => c.type === "end_gesture")).toHaveLength(1);
      const writes = patchWrites(got).length;
      window.dispatchEvent(new MouseEvent("pointermove", { clientX: 10, clientY: 10 }));
      window.dispatchEvent(new MouseEvent("pointerup", {}));
      expect(patchWrites(got), "the patch stopped following and toggled nothing").toHaveLength(writes);
      r.unmount();
    });
  }

  it("a middle or right press moves no corner, patch or rim (the middle button pans)", async () => {
    // (2026-09-30): "I noticed middle mouse button is painting a stroke,
    // this makes panning around with a mouse problematic." The chart's
    // grips start on pointerdown and never asked which button.
    const s = run(withChecker(), { type: "toggle_chart_place", id: "colorchecker" });
    const got: Command[] = [];
    render(<ChartToolOverlay state={s} dispatch={(c) => got.push(c)} node={nodeOf(s)} norm={norm} />);
    await waitFor(() => expect(screen.getByTestId("chart-patch-5")).toBeTruthy());
    for (const id of ["chart-corner-0", "chart-patch-2"]) {
      for (const [button, buttons] of [[1, 4], [2, 2]]) {
        screen
          .getByTestId(id)
          .dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button, buttons, clientX: 40, clientY: 20 }));
        window.dispatchEvent(new MouseEvent("pointermove", { buttons, clientX: 30, clientY: 14 }));
        window.dispatchEvent(new MouseEvent("pointerup", { button }));
      }
    }
    expect(got).toEqual([]);
  });

  it("the quad still drags while the chart list is still on its way", async () => {
    // The injected delay stands in for the slow charts folder: the chart_defs read stays unresolved while
    // the user places corners. Against the old synchronous command the
    // overlay's first paint would have held the UI thread until the
    // folder answered.
    let release!: (defs: ChartDef[]) => void;
    const reading = new Promise<ChartDef[]>((r) => { release = (d) => r(d); });
    vi.mocked(chartDefs).mockImplementationOnce(() => reading);
    const s = run(withChecker(), { type: "toggle_chart_place", id: "colorchecker" });
    const got: Command[] = [];
    render(<ChartToolOverlay state={s} dispatch={(c) => got.push(c)} node={nodeOf(s)} norm={norm} />);
    // The quad is up before the chart answers, and it drags.
    screen
      .getByTestId("chart-corner-0")
      .dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 40, clientY: 20 }));
    window.dispatchEvent(new MouseEvent("pointermove", { clientX: 30, clientY: 14 }));
    window.dispatchEvent(new MouseEvent("pointerup", {}));
    expect(got.some((c) => c.type === "set_text_param" && c.param === "quad")).toBe(true);
    // The patches land when the read comes back.
    release([FAKE_CHART as unknown as ChartDef]);
    await waitFor(() => expect(screen.getByTestId("chart-patch-5")).toBeTruthy());
  });

  it("a patch click excludes it from the fit; a second click takes it back", async () => {
    let s = run(withChecker(), { type: "toggle_chart_place", id: "colorchecker" });
    const { rerender } = render(
      <ChartToolOverlay state={s} dispatch={(c) => (s = run(s, c))} node={nodeOf(s)} norm={norm} />,
    );
    await waitFor(() => expect(screen.getByTestId("chart-patch-2")).toBeTruthy());
    screen
      .getByTestId("chart-patch-2")
      .dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 100, clientY: 40 }));
    window.dispatchEvent(new MouseEvent("pointerup", {}));
    expect(JSON.parse(nodeOf(s).textParams!.patches).excluded).toEqual([2]);
    rerender(<ChartToolOverlay state={s} dispatch={(c) => (s = run(s, c))} node={nodeOf(s)} norm={norm} />);
    screen
      .getByTestId("chart-patch-2")
      .dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 100, clientY: 40 }));
    window.dispatchEvent(new MouseEvent("pointerup", {}));
    expect(JSON.parse(nodeOf(s).textParams!.patches).excluded).toEqual([]);
  });

  it("a patch drag nudges its center, absolute image fractions", async () => {
    let s = run(withChecker(), { type: "toggle_chart_place", id: "colorchecker" });
    const got: Command[] = [];
    render(<ChartToolOverlay state={s} dispatch={(c) => got.push(c)} node={nodeOf(s)} norm={norm} />);
    await waitFor(() => expect(screen.getByTestId("chart-patch-3")).toBeTruthy());
    screen
      .getByTestId("chart-patch-3")
      .dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 100, clientY: 40 }));
    window.dispatchEvent(new MouseEvent("pointermove", { clientX: 60, clientY: 62 }));
    window.dispatchEvent(new MouseEvent("pointerup", {}));
    expect(got).toContainEqual({ type: "begin_gesture", key: "colorchecker.patches" });
    const writes = patchWrites(got);
    const last = JSON.parse(writes[writes.length - 1].value);
    expect(last.nudged["3"][0]).toBeCloseTo(0.3, 5);
    expect(last.nudged["3"][1]).toBeCloseTo(0.62, 5);
    expect(last.excluded ?? []).toEqual([]);
  });

  it("outlines the patches the last fit flagged", async () => {
    let s = withChecker();
    s = run(
      s,
      { type: "set_text_param", id: "colorchecker", param: "fit", value: '{"flagged":[4]}' },
      { type: "toggle_chart_place", id: "colorchecker" },
    );
    render(<ChartToolOverlay state={s} dispatch={() => {}} node={nodeOf(s)} norm={norm} />);
    await waitFor(() => expect(screen.getByTestId("chart-patch-4")).toBeTruthy());
    expect(screen.getByTestId("chart-patch-4").getAttribute("stroke-dasharray")).toBe("4 3");
    expect(screen.getByTestId("chart-patch-3").getAttribute("stroke-dasharray")).toBeNull();
    expect(
      screen.getByTestId("chart-patch-4").querySelector("title")!.textContent,
    ).toContain("flagged");
  });

  it("a rim drag writes sample, shows the number, and moves every circle", async () => {
    // The rim's distance math is in pixels, so the overlay needs a size;
    // jsdom measures zero unless told otherwise.
    const orig = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function () {
      return { x: 0, y: 0, top: 0, left: 0, right: 200, bottom: 100, width: 200, height: 100, toJSON: () => ({}) } as DOMRect;
    };
    try {
      let s = run(withChecker(), { type: "toggle_chart_place", id: "colorchecker" });
      const { rerender } = render(
        <ChartToolOverlay state={s} dispatch={(c) => (s = run(s, c))} node={nodeOf(s)} norm={norm} />,
      );
      await waitFor(() => expect(screen.getByTestId("chart-rim-2")).toBeTruthy());
      const before = screen.getByTestId("chart-patch-0").getAttribute("d");
      // Patch 2's center lands at (140, 35) client px through the default
      // quad; the cell is 30 px, so 12 px out is a diameter of 80%.
      screen
        .getByTestId("chart-rim-2")
        .dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 146, clientY: 35 }));
      window.dispatchEvent(new MouseEvent("pointermove", { clientX: 152, clientY: 35 }));
      rerender(<ChartToolOverlay state={s} dispatch={(c) => (s = run(s, c))} node={nodeOf(s)} norm={norm} />);
      expect(nodeOf(s).params.sample).toBe(80);
      expect(screen.getByTestId("chart-sample-readout").textContent).toBe("80%");
      // Every circle scaled with it: patch 0's path is not the one it
      // drew at 40.
      expect(screen.getByTestId("chart-patch-0").getAttribute("d")).not.toBe(before);
      window.dispatchEvent(new MouseEvent("pointerup", {}));
      // One undo step for the whole drag, like a slider.
      s = run(s, { type: "undo" });
      expect(nodeOf(s).params.sample ?? 40).toBe(40);
    } finally {
      HTMLElement.prototype.getBoundingClientRect = orig;
    }
  });
});

describe("the chart tool as a picker", () => {
  it("arms and disarms like every other picker, Escape included", () => {
    let s = run(withChecker(), { type: "toggle_chart_place", id: "colorchecker" });
    expect(s.chartPlace).toBe(true);
    expect(anyPickerArmed(s)).toBe(true);
    // Escape's path is disarm_pickers, the one command that puts every
    // picker away.
    s = run(s, { type: "disarm_pickers" });
    expect(s.chartPlace).toBe(false);
    expect(anyPickerArmed(s)).toBe(false);
  });

  it("arming it puts the other pickers away, and they it", () => {
    let s = run(withChecker(), { type: "toggle_keylight_pick" });
    expect(s.keyLightPick).toBe(true);
    s = run(s, { type: "toggle_chart_place", id: "colorchecker" });
    expect(s.chartPlace).toBe(true);
    expect(s.keyLightPick).toBe(false);
    s = run(s, { type: "toggle_dof_pick" });
    expect(s.dofPick).toBe(true);
    expect(s.chartPlace).toBe(false);
  });

  it("a photo switch puts the overlay away with the other pickers", () => {
    let s = run(withChecker(), { type: "toggle_chart_place", id: "colorchecker" });
    expect(s.chartPlace).toBe(true);
    // select_image carries the shared picker reset: an overlay placed on
    // one photograph must not aim its writes at the next one's node.
    s = run(s, { type: "select_image", id: "other-photo" });
    expect(s.chartPlace).toBe(false);
  });

  it("refuses to arm with no Color Checker in the graph, and a stuck arm still disarms", () => {
    // The overlay's gate draws nothing without the node, so the arm
    // cannot go through over a graph that does not have it; the panel
    // builds an off section on the way through instead. A bare arm is
    // refused, and putting a stuck arm away always works.
    const fresh = {
      ...initialState(),
      nodes: structuredClone(NEUTRAL_NODES),
      wires: structuredClone(NEUTRAL_WIRES),
    };
    let s = run(fresh, { type: "toggle_chart_place", id: "colorchecker" });
    expect(s.chartPlace).toBe(false);
    s = run({ ...s, chartPlace: true }, { type: "toggle_chart_place", id: "colorchecker" });
    expect(s.chartPlace).toBe(false);
  });

  it("the arm leaves with its node", () => {
    let s = run(withChecker(), { type: "toggle_chart_place", id: "colorchecker" });
    expect(s.chartPlace).toBe(true);
    s = run(s, { type: "delete_nodes", ids: ["colorchecker"] });
    expect(s.nodes.some((n) => n.type === "heeler.color_checker")).toBe(false);
    expect(s.chartPlace).toBe(false);
  });
});

describe("the section's controls", () => {
  it("offer the chart dropdown and the Place chip, which names its node", async () => {
    // The bare component's whole bargain: the chip dispatches one command
    // carrying the node's id. Building an off section on the way through
    // is the panel's dispatch (build-on-touch), which a bare mount does
    // not have, so the build and the arm are pinned at the panel seat in
    // placechart.test.tsx instead.
    const fresh = {
      ...initialState(),
      nodes: structuredClone(NEUTRAL_NODES),
      wires: structuredClone(NEUTRAL_WIRES),
    };
    const got: Command[] = [];
    render(<ColorCheckerControls state={fresh} dispatch={(c) => got.push(c)} />);
    await waitFor(() => expect(screen.getByTestId("colorchecker-chart").textContent).toContain("Fake Chart"));
    screen.getByTestId("colorchecker-place").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(got).toEqual([{ type: "toggle_chart_place", id: "colorchecker" }]);
  });

  it("dispatches the same single command on a free copy", async () => {
    // The chip itself is tier-blind: the free copy's prompt and refusal
    // live in the panel's dispatch and the reducer's gate, both pinned
    // where they live (placechart.test.tsx and the reducer tests above).
    const fresh = {
      ...initialState(),
      nodes: structuredClone(NEUTRAL_NODES),
      wires: structuredClone(NEUTRAL_WIRES),
    };
    const got: Command[] = [];
    try {
      render(<ColorCheckerControls state={fresh} dispatch={(c) => got.push(c)} />);
      await waitFor(() => expect(screen.getByTestId("colorchecker-chart").textContent).toContain("Fake Chart"));
      screen.getByTestId("colorchecker-place").dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(got).toEqual([{ type: "toggle_chart_place", id: "colorchecker" }]);
    } finally {
    }
  });
});

describe("the sample param's seats", () => {
  it("the section's slider row and the inspector face write the same value", async () => {
    // The full app, because the panel's row comes from the section spec
    // and the inspector's from the shared controls: only the real panel
    // proves both seats land on the one param.
    const { mockResetSessions } = await import("../bridge");
    mockResetSessions();
    const { App } = await import("../app");
    render(<App />);
    // The section's own row, written by typing: 65 it is.
    const field = await screen.findByTestId("value-sample");
    fireEvent.change(field, { target: { value: "65" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect((screen.getByTestId("value-sample") as HTMLInputElement).value).toBe("65"));
    // The inspector face reads the same node.
    fireEvent.click(screen.getByRole("tablist", { name: /workspace mode/i }).children[1]);
    fireEvent.mouseDown(await screen.findByTestId("node-colorchecker"));
    const insp = await screen.findByTestId("value-colorchecker-sample");
    expect((insp as HTMLInputElement).value).toBe("65");
    // And writes it back, visible from the panel's row.
    fireEvent.change(insp, { target: { value: "30" } });
    fireEvent.keyDown(insp, { key: "Enter" });
    await waitFor(() => expect((screen.getByTestId("value-colorchecker-sample") as HTMLInputElement).value).toBe("30"));
    fireEvent.click(screen.getByRole("tablist", { name: /workspace mode/i }).children[0]);
    await waitFor(() => expect((screen.getByTestId("value-sample") as HTMLInputElement).value).toBe("30"));
  });
});

describe("the chart lines' color and thickness", () => {
  it("the stroke color answers the frame: light lines on a dark photograph, dark on a light one", async () => {
    const s = run(withChecker(), { type: "toggle_chart_place", id: "colorchecker" });
    const { unmount } = render(
      <ChartToolOverlay state={s} dispatch={() => {}} node={nodeOf(s)} norm={norm} previewUrl="frame://chart-dark" />,
    );
    // A dark frame's automatic is the light line at the opposite hue;
    // the no-frame stand-in would be hue 0, so 180 proves the frame
    // was read.
    await waitFor(() =>
      expect(screen.getByTestId("chart-quad-outline").getAttribute("stroke")).toBe("hsla(180, 0%, 92%, 0.85)"),
    );
    unmount();
    render(
      <ChartToolOverlay state={s} dispatch={() => {}} node={nodeOf(s)} norm={norm} previewUrl="frame://chart-light" />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("chart-quad-outline").getAttribute("stroke")).toBe("hsla(180, 0%, 12%, 0.85)"),
    );
  });

  it("every line takes the shared thickness: the preference, then this photograph's own", async () => {
    let s = run(withChecker(), { type: "toggle_chart_place", id: "colorchecker" });
    const { rerender } = render(<ChartToolOverlay state={s} dispatch={() => {}} node={nodeOf(s)} norm={norm} />);
    await waitFor(() => expect(screen.getByTestId("chart-patch-5")).toBeTruthy());
    // The shipped preference, 2 pixels, on the quad, the patches and
    // the handles alike.
    expect(screen.getByTestId("chart-quad-outline").getAttribute("stroke-width")).toBe("2");
    expect(screen.getByTestId("chart-patch-0").getAttribute("stroke-width")).toBe("2");
    expect((screen.getByTestId("chart-corner-0") as HTMLElement).style.width).toBe("12px");
    // This photograph's own, written through the shared row's command.
    s = run(s, { type: "set_photo_line_width", width: 5 });
    rerender(<ChartToolOverlay state={s} dispatch={() => {}} node={nodeOf(s)} norm={norm} />);
    expect(screen.getByTestId("chart-quad-outline").getAttribute("stroke-width")).toBe("5");
    expect(screen.getByTestId("chart-patch-0").getAttribute("stroke-width")).toBe("5");
    expect((screen.getByTestId("chart-corner-0") as HTMLElement).style.width).toBe("18px");
    // Preference hands it back.
    s = run(s, { type: "set_photo_line_width", width: 0 });
    rerender(<ChartToolOverlay state={s} dispatch={() => {}} node={nodeOf(s)} norm={norm} />);
    expect(screen.getByTestId("chart-quad-outline").getAttribute("stroke-width")).toBe("2");
  });

  it("a thickness on a photograph with no Shape Warp adds no node, marks nothing edited and is no undo step", () => {
    // 2026-09-28: "I don't want to add a hidden node to the photo".
    const base = initialState();
    const fresh = {
      ...base,
      nodes: structuredClone(NEUTRAL_NODES),
      wires: structuredClone(NEUTRAL_WIRES),
      images: base.images.map((i) => ({ ...i, edited: false })),
    };
    expect(fresh.nodes.some((n) => n.type === "heeler.shape_warp")).toBe(false);
    const next = run(fresh, { type: "set_photo_line_width", width: 4 });
    expect(next.nodes).toBe(fresh.nodes);
    expect(next.wires).toBe(fresh.wires);
    expect(next.images.find((i) => i.id === fresh.activeImage)!.edited).toBe(false);
    expect(next.undoStack).toBe(fresh.undoStack);
    expect(next.photoLineWidth).toEqual({ [fresh.activeImage]: 4 });
    // The same write again is a no-op.
    expect(run(next, { type: "set_photo_line_width", width: 4 })).toBe(next);
  });

  it("the section mounts the shared line rows, and they write the photograph's own thickness", async () => {
    const fresh = {
      ...initialState(),
      nodes: structuredClone(NEUTRAL_NODES),
      wires: structuredClone(NEUTRAL_WIRES),
    };
    let s = fresh;
    const { rerender } = render(<ColorCheckerControls state={s} dispatch={(c) => (s = run(s, c))} />);
    const again = () => rerender(<ColorCheckerControls state={s} dispatch={(c) => (s = run(s, c))} />);
    // The color row and the thickness row, the same components Shape
    // Warp's section mounts.
    expect(screen.getByTestId("colorchecker-lines")).toBeTruthy();
    expect(screen.getByTestId("colorchecker-line-width-row")).toBeTruthy();
    expect((screen.getByTestId("colorchecker-line-width") as HTMLInputElement).value).toBe("2");
    expect(screen.getByTestId("colorchecker-line-width-pref")).toHaveAttribute("data-active", "true");
    // Typing a thickness writes the photograph's own, and no node.
    fireEvent.change(screen.getByTestId("colorchecker-line-width"), { target: { value: "6" } });
    fireEvent.keyDown(screen.getByTestId("colorchecker-line-width"), { key: "Enter" });
    again();
    expect(s.nodes.some((n) => n.type === "heeler.shape_warp")).toBe(false);
    expect(s.photoLineWidth[s.activeImage]).toBe(6);
    expect((screen.getByTestId("colorchecker-line-width") as HTMLInputElement).value).toBe("6");
    expect(screen.getByTestId("colorchecker-line-width-pref")).toHaveAttribute("data-active", "false");
    // Preference puts the photograph back on the preference.
    fireEvent.click(screen.getByTestId("colorchecker-line-width-pref"));
    again();
    expect(s.photoLineWidth).toEqual({});
    expect((screen.getByTestId("colorchecker-line-width") as HTMLInputElement).value).toBe("2");
  });
});

// Calibrate: the desktop samples the node's input through the executor
// and fits; the panel writes the node, the White Balance node when the
// chip is on, and the report the node keeps.

const FIT_ANSWER = {
  fit: {
    temperature: 5200,
    tint: 8,
    exposure: -0.3,
    matrix: [1.02, -0.03, 0.01, 0.0, 1.01, -0.01, 0.02, -0.02, 1.0],
    matrix_is_identity: false,
    wb_in_matrix: false,
    residuals: [
      [5, 3.4],
      [1, 1.2],
    ],
    mean_de: 1.6,
    illuminant: "daylight",
    flagged: [3],
    fitted: 22,
    note: "fitted on 22 patches",
  },
  patches: [
    { index: 5, name: "white 9.5", before: [0.9, 0.88, 0.85], after: [0.9, 0.9, 0.9], de: 3.4, flag: null },
    { index: 1, name: "blue sky", before: [0.2, 0.3, 0.6], after: [0.2, 0.3, 0.55], de: 1.2, flag: null },
    { index: 3, name: "foliage", before: [0.2, 0.4, 0.2], after: [0.2, 0.4, 0.2], de: null, flag: "glare" },
  ],
  camera: "SONY ILCE-7RM5",
};

describe("Calibrate", () => {
  it("loads chart choices under the app's StrictMode mount", async () => {
    render(<StrictMode><ColorCheckerControls state={withChecker()} dispatch={() => {}} /></StrictMode>);
    await waitFor(() => expect(screen.getByText("Fake Chart")).toBeInTheDocument());
  });

  it("a late calibration cannot write into another photograph", async () => {
    let answer!: (value: typeof FIT_ANSWER) => void;
    vi.mocked(chartCalibrate).mockImplementationOnce(() => new Promise((resolve) => { answer = resolve as typeof answer; }));
    const initial = withChecker();
    const got: Command[] = [];
    const dispatch = (c: Command) => { got.push(c); };
    const view = render(<ColorCheckerControls state={initial} dispatch={dispatch} />);
    fireEvent.click(screen.getByTestId("colorchecker-calibrate"));
    const next = { ...withChecker(), activeImage: "next-photo" };
    view.rerender(<ColorCheckerControls state={next} dispatch={dispatch} />);
    await act(async () => { answer(FIT_ANSWER); });
    expect(serializeGraph(run(next, ...got))).toEqual(serializeGraph(next));
    expect(got).toEqual([]);
  });

  it("writes the node, the White Balance node, and the report, worst first", async () => {
    vi.mocked(chartCalibrate).mockResolvedValue(FIT_ANSWER as never);
    let s = withChecker();
    const { rerender } = render(
      <ColorCheckerControls state={s} dispatch={(c) => (s = run(s, c))} />,
    );
    const btn = screen.getByTestId("colorchecker-calibrate");
    expect((btn as HTMLButtonElement).disabled).toBe(false);
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await waitFor(() => expect(nodeOf(s).textParams!.fit ?? "").not.toBe(""));
    const node = nodeOf(s);
    expect(node.params.m00).toBeCloseTo(1.02, 5);
    expect(node.params.m22).toBeCloseTo(1.0, 5);
    expect(node.params.exposure).toBeCloseTo(-0.3, 5);
    // The desktop was asked for the node's input with the placed quad.
    expect(vi.mocked(chartCalibrate).mock.calls[0][2]).toEqual(DEFAULT_QUAD);
    // Set white balance on: the fit's temperature and tint went to the
    // Color section's node, the WB seat.
    const wb = s.nodes.find((n) => n.id === "stdcolor")!;
    expect(wb.params.temperature).toBe(5200);
    expect(wb.params.tint).toBe(8);
    // The report the node keeps: provenance and the panel rows.
    const report = JSON.parse(node.textParams!.fit);
    expect(report.camera).toBe("SONY ILCE-7RM5");
    expect(report.chart).toBe("colorchecker-classic");
    expect(report.set_wb).toBe(true);
    expect(report.patches).toHaveLength(3);
    rerender(<ColorCheckerControls state={s} dispatch={(c) => (s = run(s, c))} />);
    expect(screen.getByTestId("colorchecker-report")).toBeTruthy();
    // Sorted worst first: the desktop's order is the panel's order.
    expect(screen.getByTestId("colorchecker-residual-5").textContent).toContain("dE 3.4");
    expect(screen.getByTestId("colorchecker-residual-3").textContent).toContain("glare");
    expect(screen.getByTestId("colorchecker-provenance").textContent).toContain("SONY ILCE-7RM5");
  });

  it("with the white balance sent into the matrix, the WB node stays untouched", async () => {
    vi.mocked(chartCalibrate).mockResolvedValue({
      ...FIT_ANSWER,
      fit: { ...FIT_ANSWER.fit, wb_in_matrix: true },
    } as never);
    let s = withChecker();
    render(<ColorCheckerControls state={s} dispatch={(c) => (s = run(s, c))} />);
    // A two-way choice, both named, never a toggle (2026-09-19).
    expect(screen.getByTestId("colorchecker-wb-node").getAttribute("data-active")).toBe("true");
    fireEvent.click(screen.getByTestId("colorchecker-wb-matrix"));
    expect(screen.getByTestId("colorchecker-wb-matrix").getAttribute("data-active")).toBe("true");
    fireEvent.click(screen.getByTestId("colorchecker-calibrate"));
    await waitFor(() => expect(nodeOf(s).textParams!.fit ?? "").not.toBe(""));
    const wb = s.nodes.find((n) => n.id === "stdcolor")!;
    expect(wb.params.temperature ?? 6500).toBe(6500);
    const report = JSON.parse(nodeOf(s).textParams!.fit);
    expect(report.set_wb).toBe(false);
    expect(report.wb_in_matrix).toBe(true);
  });

  it("is disabled while the section is off", () => {
    const fresh = {
      ...initialState(),
      nodes: structuredClone(NEUTRAL_NODES),
      wires: structuredClone(NEUTRAL_WIRES),
    };
    render(<ColorCheckerControls state={fresh} dispatch={() => {}} />);
    expect((screen.getByTestId("colorchecker-calibrate") as HTMLButtonElement).disabled).toBe(true);
  });
});

// Saved calibrations: a preset in the Calibrations folder carrying only
// the matrix, exposure, chart id and fit report; apply creates the
// section when absent, records the name, and warns on a different
// camera without refusing.

describe("saved calibrations", () => {
  it("a saved calibration carries only the matrix, exposure, chart and fit report", () => {
    let s = withChecker();
    s = run(
      s,
      { type: "set_params", id: "colorchecker", values: { m00: 1.02, exposure: -0.3, amount: 60 } },
      { type: "set_text_param", id: "colorchecker", param: "quad", value: "[[0,0],[1,0],[1,1],[0,1]]" },
      { type: "set_text_param", id: "colorchecker", param: "patches", value: '{"excluded":[2]}' },
      { type: "set_text_param", id: "colorchecker", param: "fit", value: '{"mean_de":1.2,"patches":[]}' },
    );
    const preset = calibrationPreset(nodeOf(s), "Studio A");
    expect(preset.nodes).toHaveLength(1);
    const n = preset.nodes[0];
    expect(n.type).toBe("heeler.color_checker");
    expect(n.params.m00).toBeCloseTo(1.02, 5);
    expect(n.params.exposure).toBeCloseTo(-0.3, 5);
    // Amount is the user's dial; the quad and the patch overrides belong
    // to the photograph the chart was shot in.
    expect(n.params.amount).toBeUndefined();
    expect(n.textParams).toEqual({ chart: "colorchecker-classic", fit: '{"mean_de":1.2,"patches":[]}' });
  });

  it("applying creates the section when absent, in one undo step", () => {
    const fresh = {
      ...initialState(),
      nodes: structuredClone(NEUTRAL_NODES),
      wires: structuredClone(NEUTRAL_WIRES),
    };
    const cmd: Command = {
      type: "apply_calibration",
      name: "Studio A",
      matrix: [1.1, 0, 0, 0, 0.9, 0, 0, 0, 1.05],
      exposure: -0.5,
      chart: "spydercheckr-24",
      fit: '{"name":"Studio A"}',
    };
    let s = run(fresh, cmd);
    const node = nodeOf(s);
    expect(node.enabled).toBe(true);
    expect(node.params.m00).toBeCloseTo(1.1, 5);
    expect(node.params.m22).toBeCloseTo(1.05, 5);
    expect(node.params.exposure).toBeCloseTo(-0.5, 5);
    expect(node.textParams!.chart).toBe("spydercheckr-24");
    expect(node.textParams!.fit).toBe('{"name":"Studio A"}');
    expect(s.wires.some((w) => w.from === "colorchecker" && w.to === "stdcolor")).toBe(true);
    // One undo: the section goes with the fit.
    s = run(s, { type: "undo" });
    expect(s.nodes.some((n) => n.type === "heeler.color_checker")).toBe(false);
  });

  it("applying onto an existing section keeps the placement, and undoes the fit alone", () => {
    let s = withChecker();
    s = run(s, {
      type: "set_text_param",
      id: "colorchecker",
      param: "quad",
      value: "[[0.1,0.1],[0.9,0.1],[0.9,0.9],[0.1,0.9]]",
    });
    s = run(s, {
      type: "apply_calibration",
      name: "B",
      matrix: [1, 0, 0, 0, 1, 0, 0, 0, 2],
      exposure: 0.4,
      chart: "colorchecker-sg",
      fit: '{"name":"B"}',
    });
    let node = nodeOf(s);
    // The placement stays: the quad belongs to this photograph.
    expect(node.textParams!.quad).toContain("0.1");
    expect(node.params.m22).toBeCloseTo(2, 5);
    s = run(s, { type: "undo" });
    node = nodeOf(s);
    expect(node.params.m22).toBe(1);
    expect(node.textParams!.quad).toContain("0.1");
  });

  it("a saved calibration cannot land on a different photograph after metadata returns", async () => {
    let s = withChecker();
    const got: Command[] = [];
    const dispatch = (c: Command) => { got.push(c); s = run(s, c); };
    vi.mocked(presetList).mockResolvedValue([
      { category: "Calibrations", name: "Studio", path: "/p/studio", builtin: false },
    ]);
    vi.mocked(presetRead).mockResolvedValue({
      schema: 1, name: "Studio", nodes: [{ ...nodeOf(s), params: { m00: 2 } }], wires: [],
    } as never);
    let finish!: (value: never) => void;
    vi.mocked(imageMetadata).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const { rerender } = render(<ColorCheckerControls state={s} dispatch={dispatch} />);
    await waitFor(() => expect(menuRows(screen.getByTestId("colorchecker-calibrations")).map(([, label]) => label)).toContain("Studio"));
    choose(screen.getByTestId("colorchecker-calibrations"), "/p/studio");
    fireEvent.click(screen.getByTestId("colorchecker-apply-calibration"));
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    s = { ...s, activeImage: "next-photo" };
    const before = serializeGraph(s);
    rerender(<ColorCheckerControls state={s} dispatch={dispatch} />);
    await act(async () => { finish({ camera: null } as never); });
    expect(serializeGraph(s)).toEqual(before);
    expect(got).toEqual([]);
  });

  it("the widget saves under Calibrations and applies a saved one back, warning on a different camera", async () => {
    const donorFit = {
      mean_de: 0.9,
      patches: [],
      residuals: [],
      flagged: [],
      fitted: 20,
      note: "fitted on 20 patches",
      camera: "SONY ILCE-7RM5",
      chart: "spydercheckr-24",
      photo: "someone-elses-photo",
      when: "2026-09-01T10:00:00.000Z",
      set_wb: true,
      temperature: 6500,
      tint: 0,
      exposure: -0.2,
      matrix: [1.05, 0, 0, 0, 1, 0, 0, 0, 0.95],
      wb_in_matrix: false,
    };
    let s = withChecker();
    // A fitted node, so Save calibration has something to save.
    s = run(s, {
      type: "set_text_param",
      id: "colorchecker",
      param: "fit",
      value: JSON.stringify({ ...donorFit, camera: null }),
    });
    vi.mocked(presetList).mockResolvedValue([
      { category: "Calibrations", name: "Studio A", path: "/p/Studio A.heelerpreset", builtin: false },
    ]);
    vi.mocked(presetRead).mockResolvedValue({
      schema: 1,
      name: "Studio A",
      nodes: [
        {
          ...nodeOf(s),
          params: { m00: 1.05, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0, m20: 0, m21: 0, m22: 0.95, exposure: -0.2 },
          textParams: { chart: "spydercheckr-24", fit: JSON.stringify(donorFit) },
        },
      ],
      wires: [],
    } as never);
    vi.mocked(imageMetadata).mockResolvedValue({ camera: "Canon EOS R5" } as never);
    const { rerender } = render(<ColorCheckerControls state={s} dispatch={(c) => (s = run(s, c))} />);
    // Save first.
    fireEvent.click(screen.getByTestId("colorchecker-save-calibration"));
    fireEvent.change(screen.getByTestId("colorchecker-cal-name"), { target: { value: "Studio B" } });
    fireEvent.click(screen.getByTestId("colorchecker-cal-save"));
    await waitFor(() => expect(vi.mocked(presetSave)).toHaveBeenCalled());
    const [cat, name, preset] = vi.mocked(presetSave).mock.calls[0];
    expect(cat).toBe("Calibrations");
    expect(name).toBe("Studio B");
    expect(preset.nodes[0].textParams!.quad).toBeUndefined();
    // Then apply the saved one. The dropdown lists it.
    await waitFor(() => expect(menuRows(screen.getByTestId("colorchecker-calibrations")).map(([, label]) => label)).toContain("Studio A"));
    choose(screen.getByTestId("colorchecker-calibrations"), "/p/Studio A.heelerpreset");
    fireEvent.click(screen.getByTestId("colorchecker-apply-calibration"));
    await waitFor(() => expect(nodeOf(s).params.m00).toBeCloseTo(1.05, 5));
    const stored = JSON.parse(nodeOf(s).textParams!.fit);
    expect(stored.name).toBe("Studio A");
    expect(stored.camera).toBe("SONY ILCE-7RM5");
    expect(nodeOf(s).textParams!.chart).toBe("spydercheckr-24");
    rerender(<ColorCheckerControls state={s} dispatch={(c) => (s = run(s, c))} />);
    // The warning: fitted on a Sony, this photo is a Canon. Applied anyway.
    await waitFor(() => expect(screen.getByTestId("colorchecker-camera-warn").textContent).toContain("SONY ILCE-7RM5"));
    expect(screen.getByTestId("colorchecker-camera-warn").textContent).toContain("Canon EOS R5");
    expect(screen.getByTestId("colorchecker-provenance").textContent).toContain("Studio A");
  });
});

describe("custom charts", () => {
  /** Open the editor from the section controls and shrink it to 2x2. */
  async function openEditor(dispatch: (c: Command) => void) {
    const view = render(<ColorCheckerControls state={withChecker()} dispatch={dispatch} />);
    fireEvent.click(screen.getByTestId("colorchecker-custom-chart"));
    await waitFor(() => expect(screen.getByTestId("charteditor")).toBeTruthy());
    // The grid fields are the shared ValueField: a typed value commits
    // on Enter, like every number in the app.
    fireEvent.change(screen.getByTestId("charteditor-rows"), { target: { value: "2" } });
    fireEvent.keyDown(screen.getByTestId("charteditor-rows"), { key: "Enter" });
    fireEvent.change(screen.getByTestId("charteditor-cols"), { target: { value: "2" } });
    fireEvent.keyDown(screen.getByTestId("charteditor-cols"), { key: "Enter" });
    return view;
  }

  /** The colors are a column beside the grid, not a block that unfolds
   * below it (26.3.1). They are in the dialog before anything is clicked,
   * aimed at A1, and clicking a cell only re-aims them: nothing appears,
   * vanishes, or moves under the pointer. */
  it("the target column stands beside the grid and is there before a cell is clicked", async () => {
    await openEditor(() => {});
    const picker = screen.getByTestId("charteditor-picker");
    await waitFor(() => expect(screen.getByTestId("charteditor-target-gray-18")).toBeTruthy());
    expect(picker.textContent).toContain("Target for A1");
    expect(screen.getByTestId("charteditor-colour-swatch")).toBeTruthy();
    // Beside: one flex row holds the grid's column and the picker's, the
    // grid first.
    const grid = screen.getByTestId("charteditor-grid");
    const row = picker.parentElement!;
    expect(row.style.display).toBe("flex");
    expect(row.contains(grid)).toBe(true);
    expect(grid.compareDocumentPosition(picker) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // A1 is the cell in hand, so the grid says so from the first frame.
    expect(screen.getByTestId("charteditor-cell-0").style.border).toContain("var(--text-hi)");
    // Clicking another cell re-aims the same column, in place.
    fireEvent.click(screen.getByTestId("charteditor-cell-3"));
    expect(screen.getByTestId("charteditor-picker")).toBe(picker);
    expect(picker.textContent).toContain("Target for B2");
    // And a grid that shrinks past the cell in hand keeps a live one.
    fireEvent.change(screen.getByTestId("charteditor-cols"), { target: { value: "1" } });
    fireEvent.keyDown(screen.getByTestId("charteditor-cols"), { key: "Enter" });
    expect(screen.getByTestId("charteditor-picker").textContent).toContain("Target for B1");
  });

  it("a custom chart with four controls saves in the chart file format and selects itself", async () => {
    const got: Command[] = [];
    await openEditor((c) => got.push(c));
    // Four cells, four targets: the 18% gray and the three primaries.
    const pick = async (cell: number, key: string) => {
      fireEvent.click(screen.getByTestId(`charteditor-cell-${cell}`));
      await waitFor(() => expect(screen.getByTestId("charteditor-picker")).toBeTruthy());
      fireEvent.click(screen.getByTestId(`charteditor-target-${key}`));
    };
    await pick(0, "gray-18");
    await pick(1, "red");
    await pick(2, "green");
    await pick(3, "blue");
    // A gray is aboard, so the white-balance warning stays away.
    expect(screen.queryByTestId("charteditor-no-neutral")).toBeNull();
    fireEvent.change(screen.getByTestId("charteditor-name"), { target: { value: "Test Card" } });
    fireEvent.click(screen.getByTestId("charteditor-save"));
    await waitFor(() => expect(vi.mocked(chartSave)).toHaveBeenCalled());
    const json = JSON.parse(vi.mocked(chartSave).mock.calls[0][0]);
    expect(json.id).toBe("custom-test-card");
    expect(json.name).toBe("Test Card");
    expect(json.rows).toBe(2);
    expect(json.cols).toBe(2);
    expect(json.patches).toHaveLength(4);
    expect(json.patches.map((p: { name: string }) => p.name)).toEqual(["Gray 18%", "Red", "Green", "Blue"]);
    expect(json.patches[0].lab).toEqual([49.5, 0, 0]);
    // The gray is the chart's neutral; the primaries are not.
    expect(json.neutrals).toEqual([0]);
    // The new chart selects itself on the node, so the next Place chart
    // and Calibrate run against it.
    expect(got).toContainEqual({
      type: "set_text_param",
      id: "colorchecker",
      param: "chart",
      value: "custom-test-card",
    });
  });

  it("a Lab entry from a datasheet lands verbatim; an untargeted cell saves with no value", async () => {
    await openEditor(() => {});
    fireEvent.click(screen.getByTestId("charteditor-cell-0"));
    await waitFor(() => expect(screen.getByTestId("charteditor-picker")).toBeTruthy());
    fireEvent.click(screen.getByTestId("charteditor-colour-lab"));
    fireEvent.change(screen.getByTestId("charteditor-lab-l"), { target: { value: "50" } });
    fireEvent.change(screen.getByTestId("charteditor-lab-a"), { target: { value: "20" } });
    fireEvent.change(screen.getByTestId("charteditor-lab-b"), { target: { value: "-30" } });
    fireEvent.click(screen.getByTestId("charteditor-colour-set"));
    // Cell 1 stays untargeted. Without a gray the editor warns.
    expect(screen.getByTestId("charteditor-no-neutral").textContent).toContain("white balance");
    fireEvent.change(screen.getByTestId("charteditor-name"), { target: { value: "Datasheet Card" } });
    fireEvent.click(screen.getByTestId("charteditor-save"));
    await waitFor(() => expect(vi.mocked(chartSave)).toHaveBeenCalled());
    const json = JSON.parse(vi.mocked(chartSave).mock.calls[0][0]);
    expect(json.patches[0]).toEqual({ name: "A1", lab: [50, 20, -30] });
    expect(json.patches[1]).toEqual({ name: "A2", lab: null });
    // A chromatic Lab entry is not a neutral.
    expect(json.neutrals).toEqual([]);
  });

  it("a neutral Lab entry (a and b at zero) counts as a gray", async () => {
    await openEditor(() => {});
    fireEvent.click(screen.getByTestId("charteditor-cell-0"));
    await waitFor(() => expect(screen.getByTestId("charteditor-picker")).toBeTruthy());
    fireEvent.click(screen.getByTestId("charteditor-colour-lab"));
    fireEvent.change(screen.getByTestId("charteditor-lab-l"), { target: { value: "76" } });
    fireEvent.change(screen.getByTestId("charteditor-lab-a"), { target: { value: "0" } });
    fireEvent.change(screen.getByTestId("charteditor-lab-b"), { target: { value: "0" } });
    fireEvent.click(screen.getByTestId("charteditor-colour-set"));
    expect(screen.queryByTestId("charteditor-no-neutral")).toBeNull();
    fireEvent.change(screen.getByTestId("charteditor-name"), { target: { value: "Gray Card" } });
    fireEvent.click(screen.getByTestId("charteditor-save"));
    await waitFor(() => expect(vi.mocked(chartSave)).toHaveBeenCalled());
    const json = JSON.parse(vi.mocked(chartSave).mock.calls[0][0]);
    expect(json.neutrals).toEqual([0]);
  });

  it("resizing the grid keeps assignments whose cell still exists", async () => {
    await openEditor(() => {});
    fireEvent.click(screen.getByTestId("charteditor-cell-0"));
    await waitFor(() => expect(screen.getByTestId("charteditor-picker")).toBeTruthy());
    fireEvent.click(screen.getByTestId("charteditor-target-gray-18"));
    fireEvent.change(screen.getByTestId("charteditor-cols"), { target: { value: "4" } });
    fireEvent.keyDown(screen.getByTestId("charteditor-cols"), { key: "Enter" });
    fireEvent.change(screen.getByTestId("charteditor-name"), { target: { value: "Wide Card" } });
    fireEvent.click(screen.getByTestId("charteditor-save"));
    await waitFor(() => expect(vi.mocked(chartSave)).toHaveBeenCalled());
    const json = JSON.parse(vi.mocked(chartSave).mock.calls[0][0]);
    expect(json.cols).toBe(4);
    expect(json.patches).toHaveLength(8);
    expect(json.patches[0]).toEqual({ name: "Gray 18%", lab: [49.5, 0, 0] });
    expect(json.neutrals).toEqual([0]);
  });

  it("a hex color saves as Lab, the modes convert into each other, and equal channels mark a gray", async () => {
    await openEditor(() => {});
    fireEvent.click(screen.getByTestId("charteditor-cell-0"));
    await waitFor(() => expect(screen.getByTestId("charteditor-picker")).toBeTruthy());
    // Hex is the mode in hand first; the swatch reads the field live.
    expect(screen.getByTestId("charteditor-colour-hex")).toHaveAttribute("aria-pressed", "true");
    fireEvent.change(screen.getByTestId("charteditor-hex"), { target: { value: "#744f41" } });
    expect(screen.getByTestId("charteditor-colour-swatch").style.background).toBe("rgb(116, 79, 65)");
    // Switching to Lab converts: the engine's round trip for the Classic's
    // dark skin through #744f41 is [37.5, 14.7, 14.9] at one decimal.
    fireEvent.click(screen.getByTestId("charteditor-colour-lab"));
    expect((screen.getByTestId("charteditor-lab-l") as HTMLInputElement).value).toBe("37.5");
    expect((screen.getByTestId("charteditor-lab-a") as HTMLInputElement).value).toBe("14.7");
    expect((screen.getByTestId("charteditor-lab-b") as HTMLInputElement).value).toBe("14.9");
    // And back to hex rewrites the field.
    fireEvent.click(screen.getByTestId("charteditor-colour-hex"));
    expect((screen.getByTestId("charteditor-hex") as HTMLInputElement).value).toBe("#744f41");
    fireEvent.click(screen.getByTestId("charteditor-colour-set"));
    // A gray by hex: equal channels mark the cell a neutral.
    fireEvent.click(screen.getByTestId("charteditor-cell-1"));
    fireEvent.change(screen.getByTestId("charteditor-hex"), { target: { value: "#808080" } });
    fireEvent.click(screen.getByTestId("charteditor-colour-set"));
    expect(screen.queryByTestId("charteditor-no-neutral")).toBeNull();
    fireEvent.change(screen.getByTestId("charteditor-name"), { target: { value: "Hex Card" } });
    fireEvent.click(screen.getByTestId("charteditor-save"));
    await waitFor(() => expect(vi.mocked(chartSave)).toHaveBeenCalled());
    const json = JSON.parse(vi.mocked(chartSave).mock.calls[0][0]);
    // Cell A1: the Lab the hex converts to, quantized by the 8-bit trip.
    expect(json.patches[0].lab[0]).toBeCloseTo(37.5, 1);
    expect(json.patches[0].lab[1]).toBeCloseTo(14.67, 1);
    expect(json.patches[0].lab[2]).toBeCloseTo(14.87, 1);
    expect(json.neutrals).toEqual([1]);
  });

  it("rows and cols drag, nudge and clamp; Clear empties the picked cell", async () => {
    render(<ChartEditor dispatch={() => {}} nodeId="colorchecker" currentChart={null} onClose={() => {}} />);
    // The default 4x6 grid is up right away; the palette waits for a pick.
    await waitFor(() => expect(screen.getByTestId("charteditor-cell-23")).toBeTruthy());
    const rows = screen.getByTestId("charteditor-rows");
    expect((rows as HTMLInputElement).value).toBe("4");
    // A sideways drag scrubs: ten pixels a step.
    fireEvent.mouseDown(rows, { button: 0, clientX: 100 });
    act(() => {
      window.dispatchEvent(new MouseEvent("mousemove", { clientX: 120 }));
      window.dispatchEvent(new MouseEvent("mouseup", {}));
    });
    expect((rows as HTMLInputElement).value).toBe("6");
    // The arrows nudge one step.
    fireEvent.keyDown(rows, { key: "ArrowUp" });
    expect((rows as HTMLInputElement).value).toBe("7");
    fireEvent.keyDown(rows, { key: "ArrowDown" });
    expect((rows as HTMLInputElement).value).toBe("6");
    // Typing past the range clamps: rows to 12, cols to 14.
    fireEvent.change(rows, { target: { value: "99" } });
    fireEvent.keyDown(rows, { key: "Enter" });
    expect((rows as HTMLInputElement).value).toBe("12");
    const cols = screen.getByTestId("charteditor-cols");
    fireEvent.change(cols, { target: { value: "99" } });
    fireEvent.keyDown(cols, { key: "Enter" });
    expect((cols as HTMLInputElement).value).toBe("14");
    // Clear, once "No target", empties the picked cell's assignment.
    fireEvent.click(screen.getByTestId("charteditor-cell-0"));
    await waitFor(() => expect(screen.getByTestId("charteditor-target-red")).toBeTruthy());
    fireEvent.click(screen.getByTestId("charteditor-target-red"));
    expect(screen.getByTestId("charteditor-cell-0").title).toContain("Red");
    const clear = screen.getByTestId("charteditor-clear");
    expect(clear.textContent).toBe("Clear");
    expect(clear).toHaveAttribute("data-hint", "Clear this cell's target");
    fireEvent.click(clear);
    expect(screen.getByTestId("charteditor-cell-0").title).toContain("no target");
  });

  it("the palette groups by source chart, and a long list earns a filter", async () => {
    const first = await openEditor(() => {});
    fireEvent.click(screen.getByTestId("charteditor-cell-0"));
    await waitFor(() => expect(screen.getByTestId("charteditor-picker")).toBeTruthy());
    // Ten entries: grouped under their charts, no filter field yet.
    expect(screen.queryByTestId("charteditor-palette-filter")).toBeNull();
    const groups = screen.getByTestId("charteditor-palette");
    const headers = Array.from(groups.querySelectorAll("[data-testid^='charteditor-palette-group-']")).map(
      (h) => h.textContent,
    );
    expect(headers).toEqual(["TEST PRIMARIES", "TEST GRAYS"]);
    // Each row: swatch, name, source chart.
    const red = screen.getByTestId("charteditor-target-red");
    expect(red.textContent).toContain("Red");
    expect(red.textContent).toContain("Test Primaries");
    first.unmount();
    // A list past a dozen earns the filter, and the filter narrows by name.
    resetChartsForTests();
    vi.mocked(chartPalette).mockResolvedValue(
      Array.from({ length: 15 }, (_, i) => ({
        key: `c${i}`,
        name: i === 14 ? "Pumpkin" : `Color ${i}`,
        lab: [50, 0, 0] as [number, number, number],
        rgb: [0.5, 0.5, 0.5] as [number, number, number],
        neutral: false,
        chart: "Big Card",
      })),
    );
    render(<ChartEditor dispatch={() => {}} nodeId="colorchecker" currentChart={null} onClose={() => {}} />);
    fireEvent.click(await screen.findByTestId("charteditor-cell-0"));
    const filter = await screen.findByTestId("charteditor-palette-filter");
    fireEvent.change(filter, { target: { value: "pump" } });
    await waitFor(() => expect(screen.getByTestId("charteditor-target-c14")).toBeTruthy());
    expect(screen.queryByTestId("charteditor-target-c0")).toBeNull();
  });

  it("import re-reads the catalog; export writes the chart the dropdown shows", async () => {
    vi.mocked(chartImport).mockResolvedValue({ imported: ["Shared Card"], failed: [["bad.json", "nope"]] });
    await openEditor(() => {});
    fireEvent.click(screen.getByTestId("charteditor-import"));
    await waitFor(() => expect(vi.mocked(chartImport)).toHaveBeenCalled());
    // The catalog was re-read so the import shows without a restart:
    // once at mount, once after the import.
    await waitFor(() => expect(vi.mocked(chartDefs).mock.calls.length).toBe(2));
    await waitFor(() => expect(vi.mocked(chartPalette)).toHaveBeenCalled());
    // The Export chip waits on the catalog: the dropdown's chart must
    // be known before it can be written out.
    await waitFor(() => expect(screen.getByTestId("charteditor-export")).toBeTruthy());
    fireEvent.click(screen.getByTestId("charteditor-export"));
    await waitFor(() =>
      expect(vi.mocked(chartExport)).toHaveBeenCalledWith("colorchecker-classic", "Fake Chart"),
    );
  });
});


it("the chart portal owns focus, traps Tab, closes on Escape and restores its opener", async () => {
  const opener = document.createElement("button");
  document.body.append(opener);
  opener.focus();
  const close = vi.fn();
  const view = render(<ChartEditor dispatch={() => {}} nodeId="colorchecker" currentChart={null} onClose={close} />);
  await screen.findByTestId("charteditor-picker");
  const dialog = screen.getByRole("dialog");
  expect(dialog.contains(document.activeElement)).toBe(true);
  const buttons = dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]');
  buttons[buttons.length - 1].focus();
  fireEvent.keyDown(document.activeElement!, { key: "Tab" });
  expect(document.activeElement).toBe(buttons[0]);
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  expect(close).toHaveBeenCalledOnce();
  view.unmount();
  expect(document.activeElement).toBe(opener);
  opener.remove();
});
