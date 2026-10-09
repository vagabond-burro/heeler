// The depth looks (Cool Distance, Warm Subject) read the photograph's
// depth map. With no map there is nothing for them to show, so their rows
// in the looks menu are disabled and the section says what they need:
// never a row that shows the photograph unchanged (2026-09-30).
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect, useReducer } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const depth = vi.hoisted(() => ({ histogram: vi.fn(), map: vi.fn() }));
vi.mock("../bridge", async (original) => ({
  ...(await original<typeof import("../bridge")>()),
  depthHistogram: depth.histogram,
  depthMap: depth.map,
}));

import { initialState } from "../data";
import { reduce, type Command, type State } from "../state";
import { DepthRunner, depthProgressNow, depthRecipeKey } from "../ui/depthtool";
import { LOOK_HOVER_MS, SectionLooks } from "../ui/sectionlooks";

beforeEach(() => {
  depth.histogram.mockReset();
  depth.map.mockReset();
});
afterEach(() => {
  cleanup();
});

function fresh(): State {
  const s = initialState();
  return { ...s, nodes: structuredClone(s.defaultGraph.nodes), wires: structuredClone(s.defaultGraph.wires) };
}

function mount() {
  const seen: { s: State | null } = { s: null };
  function Harness() {
    const [state, dispatch] = useReducer(reduce, undefined, fresh);
    useEffect(() => {
      seen.s = state;
    }, [state]);
    return <SectionLooks section="Recolor" state={state} dispatch={dispatch} />;
  }
  render(<Harness />);
  return seen;
}

const row = (id: string) => screen.getByTestId(`looks-recolor-menu-option-${id}`);
const openMenu = () => fireEvent.click(screen.getByTestId("looks-recolor-menu"));
const rest = () => act(() => new Promise((r) => setTimeout(r, LOOK_HOVER_MS + 20)));

it("with no depth map the depth rows are disabled, say so, and the section offers the read", async () => {
  depth.histogram.mockResolvedValue(null);
  depth.map.mockResolvedValue({ version: "v", work: "model" });
  const seen = mount();
  await screen.findByTestId("looks-recolor-read-depth");
  openMenu();
  const cool = row("recolor-cool-distance");
  expect(cool.getAttribute("aria-disabled")).toBe("true");
  expect(cool.getAttribute("data-hint")).toMatch(/reads the photograph's depth map: read this photograph's depth first/);
  expect(screen.getByTestId("looks-recolor-depth").textContent).toMatch(/Cool Distance and Warm Subject need this photograph's depth map/);
  // Pointing at it shows nothing, and a click on it does nothing.
  fireEvent.mouseEnter(cool);
  await rest();
  expect(seen.s!.lookPreview).toBeNull();
  fireEvent.click(cool);
  // The rows that need no depth preview as ever.
  expect(row("recolor-autumn").getAttribute("aria-disabled")).toBeNull();
  fireEvent.keyDown(cool, { key: "Escape" });
  // Reading the depth, which asks with the look's own graph, enables them.
  fireEvent.click(screen.getByTestId("looks-recolor-read-depth"));
  await waitFor(() => expect(screen.queryByTestId("looks-recolor-depth")).toBeNull());
  const asked = depth.map.mock.calls[0][0] as State;
  expect(asked.nodes.some((n) => n.type === "heeler.depth_map")).toBe(true);
  expect(seen.s!.nodes.some((n) => n.type === "heeler.depth_map")).toBe(false);
  openMenu();
  expect(row("recolor-cool-distance").getAttribute("aria-disabled")).toBeNull();
});

it("without the depth model the section says to get it and opens Preferences at Models", async () => {
  depth.histogram.mockResolvedValue(null);
  depth.map.mockRejectedValue(new Error("model not installed"));
  const seen = mount();
  fireEvent.click(await screen.findByTestId("looks-recolor-read-depth"));
  await screen.findByTestId("looks-recolor-install");
  expect(screen.getByTestId("looks-recolor-depth").textContent).toMatch(/need the depth model/);
  openMenu();
  const warm = row("recolor-warm-subject");
  expect(warm.getAttribute("aria-disabled")).toBe("true");
  expect(warm.getAttribute("data-hint")).toMatch(/install the depth model in Preferences, Models, first/);
  fireEvent.click(screen.getByTestId("looks-recolor-install"));
  expect(seen.s!.prefsOpen).toBe(true);
  expect(seen.s!.prefsLanding).toBe("model-inventory");
});

it("with the depth map on disk the depth rows preview like any other", async () => {
  depth.histogram.mockResolvedValue([1, 0.5]);
  const seen = mount();
  await waitFor(() => expect(depth.histogram).toHaveBeenCalled());
  await act(() => Promise.resolve());
  openMenu();
  const cool = row("recolor-cool-distance");
  expect(cool.getAttribute("aria-disabled")).toBeNull();
  fireEvent.mouseEnter(cool);
  await rest();
  expect(seen.s!.lookPreview).toBe("recolor-cool-distance");
  fireEvent.keyDown(cool, { key: "Escape" });
  expect(seen.s!.lookPreview).toBeNull();
});

it("a dragged Depth Map dial neither brings the depth line up nor takes it away", async () => {
  // "When both sections are expanded, when I adjust a slider
  // in either the adjustments view shakes up and down." Every step of
  // the drag is a recipe the desktop has no plane for yet, and the line
  // under Recolor's looks came and went at each one, moving everything
  // below it. The desktop here holds the planes the runner has read.
  const onDisk = new Set<string>();
  depth.histogram.mockImplementation(async (s: State) => (onDisk.has(depthRecipeKey(s)) ? [1, 0.5] : null));
  const reads: (() => void)[] = [];
  depth.map.mockImplementation(
    (s: State) =>
      new Promise((resolve) =>
        reads.push(() => {
          onDisk.add(depthRecipeKey(s));
          resolve({ version: "v", work: "cached" });
        }),
      ),
  );
  // A depth look on Recolor: Recolor reads the map, so the Depth Map
  // node is there and the runner reads for it.
  const held: { state: State | null; dispatch: ((c: Command) => void) | null } = { state: null, dispatch: null };
  function Harness() {
    const [state, dispatch] = useReducer(reduce, undefined, () =>
      reduce(fresh(), { type: "apply_section_look", id: "recolor-cool-distance" }),
    );
    held.state = state;
    held.dispatch = dispatch;
    return (
      <>
        <DepthRunner state={state} dispatch={dispatch} />
        <SectionLooks section="Recolor" state={state} dispatch={dispatch} />
      </>
    );
  }
  render(<Harness />);
  const send = (c: Command) => act(() => held.dispatch!(c));
  const settle = () => act(() => new Promise((r) => setTimeout(r, 10)));
  const line = () => screen.queryByTestId("looks-recolor-depth");
  const depthLookOffered = () => {
    openMenu();
    const offered = row("recolor-cool-distance").getAttribute("aria-disabled") === null;
    fireEvent.keyDown(row("recolor-cool-distance"), { key: "Escape" });
    return offered;
  };
  // The first read lands: the looks have their map, no line.
  await waitFor(() => expect(reads.length).toBe(1));
  await act(async () => reads[0]());
  await waitFor(() => expect(depthProgressNow()).toBeNull());
  await settle();
  expect(line()).toBeNull();
  expect(depthLookOffered()).toBe(true);

  // The drag: three steps, each a recipe with no plane on disk.
  const node = held.state!.nodes.find((n) => n.type === "heeler.depth_map")!;
  const asked = depth.histogram.mock.calls.length;
  send({ type: "begin_gesture", key: `${node.id}.edges` });
  const recipes = new Set<string>();
  for (const edges of [11, 23, 37]) {
    send({ type: "set_param", id: node.id, param: "edges", value: edges });
    await settle();
    recipes.add(depthRecipeKey(held.state!));
    expect(line()).toBeNull();
  }
  expect(recipes.size).toBe(3);
  // Nothing was asked mid-drag, and the runner waited for the hand.
  expect(depth.histogram.mock.calls.length).toBe(asked);
  expect(reads.length).toBe(1);

  // The hand lets go: the runner reads the plane, and the "no" that
  // comes back while it reads is not taken.
  send({ type: "end_gesture" });
  await waitFor(() => expect(reads.length).toBe(2));
  await settle();
  expect(depthProgressNow()).not.toBeNull();
  expect(line()).toBeNull();
  // The read lands, the question is asked again, and the answer is yes.
  await act(async () => reads[1]());
  await waitFor(() => expect(depthProgressNow()).toBeNull());
  await waitFor(() => expect(depth.histogram.mock.calls.length).toBeGreaterThan(asked));
  await settle();
  expect(line()).toBeNull();
  expect(depthLookOffered()).toBe(true);

  // A Recolor dial moves nothing the map is made from: its drag asks
  // nothing, during or after, and the line stays away.
  const recolor = held.state!.nodes.find((n) => n.type === "heeler.recolor")!;
  const before = depth.histogram.mock.calls.length;
  send({ type: "begin_gesture", key: `${recolor.id}.smoothing` });
  for (const smoothing of [20, 35]) {
    send({ type: "set_param", id: recolor.id, param: "smoothing", value: smoothing });
    await settle();
    expect(line()).toBeNull();
  }
  send({ type: "end_gesture" });
  await settle();
  expect(line()).toBeNull();
  expect(depth.histogram.mock.calls.length).toBe(before);
  expect(reads.length).toBe(2);
});
