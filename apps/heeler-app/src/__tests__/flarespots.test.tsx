// Lens Flare's Bright spots on the app side (2026.7): the photograph's
// own lamps flare with no rig, the found sources keep their switches as
// the dials move, the presets leave the source finding alone, and a
// flare saved before the choice opens as Rig lights alone.

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useReducer } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { flareSpots, serializeGraph, type FlareSpot } from "../bridge";
import { initialState } from "../data";
import { FLARE_PRESETS, NEUTRAL_PARAMS, migrateNodes, reduce, toolNode, type Command, type State } from "../state";
import { FlarePanel, FlareSpotsRunner } from "../ui/flare";
import { readSpots, readSpotsOff, spotIsOff, toggleSpotOff, writeSpots } from "../ui/flareparts";
import { SECTIONS } from "../ui/simpledata";
import { lightsOf } from "../ui/keylightgizmoparts";

/** What the desktop finds: two headlights, nudged by the threshold the
 * way a blob's centroid moves as it grows. */
let found: FlareSpot[] = [];
vi.mock("../bridge", async (importOriginal) => {
  const real = await importOriginal<typeof import("../bridge")>();
  return { ...real, flareSpots: vi.fn(async () => found) };
});

const run = (s: State, ...cmds: Command[]) => cmds.reduce(reduce, s);
const HEADLIGHTS: FlareSpot[] = [
  { x: 0.41, y: 0.62, strength: 1, color: [1, 0.95, 0.8], size: 0.02 },
  { x: 0.58, y: 0.61, strength: 0.8, color: [1, 0.95, 0.8], size: 0.018 },
];

/** The section's panel and the runner over one live state, the way the
 * app mounts them. */
let current: State;
function Harness({ start }: { start: State }) {
  const [state, dispatch] = useReducer(reduce, start);
  current = state;
  const node = toolNode(state, "flare")!;
  return (
    <>
      <FlarePanel state={state} dispatch={dispatch} node={node} />
      <FlareSpotsRunner state={state} dispatch={dispatch} />
      <button data-testid="threshold-up" onClick={() => dispatch({ type: "set_param", id: node.id, param: "spot_threshold", value: 7 })} />
    </>
  );
}

/** A photograph with Lens Flare on and no rig at all. */
function noRig(): State {
  let s = run(initialState(), { type: "set_category", title: "Lens Flare", on: true });
  s = run(s, { type: "set_text_param", id: "keylight", param: "lights", value: "[]" });
  return s;
}

const flare = () => current.nodes.find((n) => n.id === "flare")!;

beforeEach(() => {
  vi.clearAllMocks();
  found = HEADLIGHTS;
});

describe("Lens Flare's Bright spots", () => {
  it("switched on with no rig, finds the photograph's lights and puts them in the render", async () => {
    render(<Harness start={noRig()} />);
    // Rig lights alone to begin with, as every flare before 2026.7.
    expect(screen.getByTestId("flare-source-rig").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("flare-source-bright").getAttribute("aria-pressed")).toBe("false");
    expect(lightsOf(toolNode(current, "keylight")!).some((l) => l.flare && l.on)).toBe(false);
    fireEvent.click(screen.getByTestId("flare-source-bright"));
    await waitFor(() => expect(vi.mocked(flareSpots)).toHaveBeenCalled());
    expect(vi.mocked(flareSpots).mock.calls[0][1]).toBe("flare");
    await waitFor(() => expect(readSpots(flare().textParams?.spots)).toHaveLength(2));
    // The list, brightest first, each with its switch on.
    expect(screen.getByTestId("flare-spot-0").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("flare-spot-1").getAttribute("aria-pressed")).toBe("true");
    // What the render is sent: the flare on, Bright spots on, the list.
    const g = serializeGraph(current) as unknown as { nodes: { id: string; enabled: boolean; params: Record<string, unknown> }[] };
    const sent = g.nodes.find((n) => n.id === "flare")!;
    expect(sent.enabled).toBe(true);
    expect(sent.params.bright).toBe(1);
    expect(readSpots(String(sent.params.spots))[0].x).toBeCloseTo(0.41, 5);
    // Writing the list is not an undo step: one undo takes back the switch.
    const undone = run(current, { type: "undo" });
    expect((undone.nodes.find((n) => n.id === "flare")!.params.bright as number) ?? 0).toBe(0);
  });

  it("an answer dropped by a gesture is asked for again when the gesture ends", async () => {
    // A slider pressed and let go without moving, while the find was still
    // rendering: the answer is dropped, the recipe is the same, and it
    // must still be asked again rather than taken as answered.
    let release!: (spots: FlareSpot[]) => void;
    vi.mocked(flareSpots).mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const got: Command[] = [];
    const on = run(noRig(), { type: "set_param", id: "flare", param: "bright", value: 1 });
    const view = render(<FlareSpotsRunner state={on} dispatch={(c) => got.push(c)} />);
    await waitFor(() => expect(vi.mocked(flareSpots)).toHaveBeenCalledTimes(1));
    const held = run(on, { type: "begin_gesture", key: "slider" });
    view.rerender(<FlareSpotsRunner state={held} dispatch={(c) => got.push(c)} />);
    await act(async () => release(HEADLIGHTS));
    expect(got.filter((c) => c.type === "flare_spots_found")).toHaveLength(0);
    view.rerender(<FlareSpotsRunner state={run(held, { type: "end_gesture" })} dispatch={(c) => got.push(c)} />);
    await waitFor(() => expect(vi.mocked(flareSpots)).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(got.filter((c) => c.type === "flare_spots_found")).toHaveLength(1));
  });

  it("a source switched off stays off when Threshold moves it", async () => {
    render(<Harness start={run(noRig(), { type: "set_param", id: "flare", param: "bright", value: 1 })} />);
    await waitFor(() => expect(screen.getByTestId("flare-spot-1")).toBeTruthy());
    fireEvent.click(screen.getByTestId("flare-spot-1"));
    expect(screen.getByTestId("flare-spot-1").getAttribute("aria-pressed")).toBe("false");
    expect(readSpotsOff(flare().textParams?.spots_off)).toHaveLength(1);
    // A higher threshold shrinks the blob, and its centroid moves a hair.
    found = HEADLIGHTS.map((s) => ({ ...s, x: s.x + 0.004, y: s.y - 0.003, size: s.size * 0.7 }));
    const asked = vi.mocked(flareSpots).mock.calls.length;
    await act(async () => {
      fireEvent.click(screen.getByTestId("threshold-up"));
    });
    await waitFor(() => expect(vi.mocked(flareSpots).mock.calls.length).toBeGreaterThan(asked));
    await waitFor(() => expect(readSpots(flare().textParams?.spots)[1].x).toBeCloseTo(0.584, 5));
    expect(screen.getByTestId("flare-spot-0").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("flare-spot-1").getAttribute("aria-pressed")).toBe("false");
    // And back on from the list.
    fireEvent.click(screen.getByTestId("flare-spot-1"));
    expect(readSpotsOff(flare().textParams?.spots_off)).toEqual([]);
  });

  it("the switch is keyed by position, within the engine's reach", () => {
    const off = toggleSpotOff(HEADLIGHTS[0], []);
    expect(spotIsOff({ x: 0.415, y: 0.615 }, off)).toBe(true);
    expect(spotIsOff(HEADLIGHTS[1], off)).toBe(false);
    expect(toggleSpotOff({ x: 0.412, y: 0.62 }, off)).toEqual([]);
    // The stored list is rounded, so a re-found list writes the same text.
    expect(writeSpots([{ ...HEADLIGHTS[0], x: 0.4100000001 }])).toBe(writeSpots([HEADLIGHTS[0]]));
  });

  it("applying a preset leaves the source dials alone", () => {
    const source = ["rig", "bright", "spot_threshold", "spot_count", "spot_min_size", "spot_strength"];
    for (const p of FLARE_PRESETS) {
      for (const k of source) expect(p.params, `${p.id} writes ${k}`).not.toHaveProperty(k);
      for (const k of ["spots", "spots_off"]) expect(p.text ?? {}, `${p.id} writes ${k}`).not.toHaveProperty(k);
    }
    let s = run(noRig(), { type: "set_params", id: "flare", values: { bright: 1, rig: 0, spot_threshold: 3, spot_count: 2, spot_min_size: 1.5, spot_strength: 140 } });
    s = run(s, { type: "set_text_param", id: "flare", param: "spots_off", value: "[[0.41,0.62]]" });
    const before = s.nodes.find((n) => n.id === "flare")!;
    for (const p of FLARE_PRESETS) {
      const after = run(s, { type: "set_params", id: "flare", values: { ...p.params }, text: { preset: p.id, ...(p.text ?? {}) } }).nodes.find((n) => n.id === "flare")!;
      for (const k of source) expect(after.params[k], `${p.id} moved ${k}`).toBe(before.params[k]);
      expect(after.textParams?.spots_off).toBe("[[0.41,0.62]]");
    }
  });

  it("a flare saved before the choice opens as Rig lights alone", () => {
    expect(NEUTRAL_PARAMS["heeler.flare"].rig).toBe(1);
    expect(NEUTRAL_PARAMS["heeler.flare"].bright).toBe(0);
    const s = noRig();
    const saved = s.nodes.find((n) => n.id === "flare")!;
    const params = { ...saved.params };
    for (const k of ["rig", "bright", "spot_threshold", "spot_count", "spot_min_size", "spot_strength"]) delete params[k];
    const text = { ...saved.textParams };
    delete text.spots;
    delete text.spots_off;
    const opened = migrateNodes(s.nodes.map((n) => (n.id === "flare" ? { ...n, params, textParams: text } : n)));
    const node = opened.find((n) => n.id === "flare")!;
    expect(((node.params.rig as number) ?? 1) >= 0.5).toBe(true);
    expect(((node.params.bright as number) ?? 0) >= 0.5).toBe(false);
    render(<Harness start={{ ...s, nodes: opened }} />);
    expect(screen.getByTestId("flare-source-rig").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("flare-source-bright").getAttribute("aria-pressed")).toBe("false");
    expect(screen.queryByTestId("flare-spots")).toBeNull();
    // Nothing is searched for a flare that is not asking.
    expect(vi.mocked(flareSpots)).not.toHaveBeenCalled();
  });

  it("shows the source-finding rows only while Bright spots is on", () => {
    const sec = SECTIONS.find((x) => x.title === "Lens Flare")!;
    const rows = sec.rows.filter((r) => r.param.startsWith("spot_"));
    expect(rows.map((r) => r.label)).toEqual(["Threshold", "Sources", "Min size", "Spot strength"]);
    const off = noRig();
    const on = run(off, { type: "set_param", id: "flare", param: "bright", value: 1 });
    for (const r of rows) {
      expect(r.when!(off)).toBe(false);
      expect(r.when!(on)).toBe(true);
    }
  });
});
