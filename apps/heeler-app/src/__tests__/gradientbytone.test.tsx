// The Gradient layer's By tone shape, and the Finish Gradient Map
// adjustment it replaced (2026-09-30: "I also think having a Gradient
// Map adjustment layer is redundant with the Gradient layer (and not
// as feature rich as the Gradient layer)", then "do the merge with a
// By tone shape"). The pixels are the desktop's:
// src-tauri/src/gradient_by_tone.rs renders a Gradient Map layer and
// its By tone conversion at Fit, 1:1 and in the export, and the engine
// pins By tone against the Gradient Map node on a ramp.
//
// Every test builds its own state and asserts only on what it made.

import { useReducer } from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { App } from "../app";
import { initialState, NEUTRAL_NODES, NEUTRAL_WIRES } from "../data";
import {
  ART_ADJUSTMENTS,
  ART_ID,
  ART_KINDS,
  GRADIENT_BY_TONE,
  artLayers,
  migrateGraph,
  reduce,
  type Command,
  type NodeCard,
  type State,
} from "../state";
import { serializeGraph } from "../bridge";
import { ArtLayersTab } from "../ui/artlayers";
import { Inspector } from "../ui/graph";
import { tourHostForTests } from "../tourwalk";
import { TOUR_STOPS } from "../tourstops";
import { chooseWith, menuRows } from "./menuhelp";

const IMAGE = "gradient_by_tone";

function fresh(): State {
  return {
    ...initialState(),
    activeImage: IMAGE,
    images: [{ id: IMAGE, name: "gradient_by_tone.jpg", folder: "", edited: false } as unknown as State["images"][number]],
    nodes: structuredClone(NEUTRAL_NODES),
    wires: structuredClone(NEUTRAL_WIRES),
  };
}

const run = (s: State, ...cmds: Command[]): State => cmds.reduce(reduce, s);

/** Every node of the Finish stack, groups opened, by id. */
function finishNode(s: State, id: string): NodeCard | undefined {
  const walk = (ns: NodeCard[]): NodeCard | undefined => {
    for (const n of ns) {
      if (n.id === id) return n;
      const inner = n.groupNodes ? walk(n.groupNodes) : undefined;
      if (inner) return inner;
    }
    return undefined;
  };
  return walk(s.nodes);
}

/** A Gradient Map layer as the Layer menu made it before 2026-09-30:
 * a Gradient layer's seat with the old kind's node in it. */
function savedWithGradientMap(params: Record<string, number>, text: Record<string, string>): State {
  const s = run(fresh(), { type: "art_add_layer", kind: "gradient" });
  const content = artLayers(s)[0].content.id;
  const swap = (ns: NodeCard[]): NodeCard[] =>
    ns.map((n) =>
      n.id === content
        ? ({ ...n, type: "heeler.gradient_map", name: "Gradient Map 1", artKind: "gradient_map", params, textParams: text } as unknown as NodeCard)
        : n.groupNodes
          ? { ...n, groupNodes: swap(n.groupNodes) }
          : n,
    );
  return { ...s, nodes: swap(s.nodes) };
}

/** The Finish tab over a live reducer, so clicks land as commands. */
function LiveFinish({ start, onState }: { start: State; onState: (s: State) => void }) {
  const [s, dispatch] = useReducer(reduce, start);
  onState(s);
  return <ArtLayersTab state={s} dispatch={dispatch} />;
}

describe("Gradient Map is gone from the Finish menus", () => {
  it("is no adjustment kind, so no menu, list or toolbar that lists them offers it", () => {
    expect(ART_ADJUSTMENTS).not.toContain("gradient_map");
    expect(Object.keys(ART_KINDS)).not.toContain("gradient_map");
    expect(Object.values(ART_KINDS).map((k) => k.label)).not.toContain("Gradient Map");
    // Nor any tour stop outside the graph, where the Gradient Map node
    // stays (its add, node and port stops are the graph's).
    const outside = TOUR_STOPS.filter((t) => !/^(graph|node|port)\./.test(t.id));
    expect(outside.length).toBeGreaterThan(0);
    expect(JSON.stringify(outside)).not.toMatch(/gradient.?map/i);
  });

  it("the Adjustment menu, the empty list's Adjustment row and Layer > New Finish Layer say nothing of it", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByTestId("panel-tab-layers"));
    await user.click(screen.getByTestId("art-add-adjust"));
    const menu = screen.getByTestId("art-adjust-menu");
    expect(menu.textContent).not.toMatch(/gradient map/i);
    expect(within(menu).queryByTestId("art-adjust-gradient_map")).toBeNull();
    await user.keyboard("{Escape}");
    fireEvent.contextMenu(screen.getByTestId("art-empty-fill"), { clientX: 200, clientY: 200 });
    fireEvent.mouseEnter(screen.getByTestId("art-new-adjust").parentElement!);
    expect(screen.getByTestId("art-new-adjust-list").textContent).not.toMatch(/gradient map/i);
    await user.keyboard("{Escape}");
    await user.click(screen.getByTestId("menu-layer"));
    fireEvent.mouseEnter(screen.getByTestId("menu-layer-new-finish").parentElement!);
    fireEvent.mouseEnter(screen.getByTestId("menu-finish-adjust").parentElement!);
    expect(screen.getByTestId("menu-finish-adjust-list").textContent).not.toMatch(/gradient map/i);
    expect(screen.queryByTestId("menu-finish-adjust-gradient_map")).toBeNull();
    // The app's own state holds no such layer either.
    expect(artLayers(tourHostForTests()!.getState())).toHaveLength(0);
  });
});

describe("a saved Gradient Map layer", () => {
  it("loads as a Gradient layer set to By tone with the same three colors", () => {
    const old = savedWithGradientMap(
      { midpoint: 30, amount: 60 },
      { color_lo: "#10305a", color_mid: "#c04020", color_hi: "#fff4a0" },
    );
    const loaded = run(fresh(), { type: "replace_graph", nodes: old.nodes, wires: old.wires } as Command);
    const layer = artLayers(loaded)[0];
    expect(layer.content.type).toBe("heeler.gradient");
    expect(layer.content.artKind).toBe("gradient");
    expect(layer.content.textParams?.shape).toBe(GRADIENT_BY_TONE);
    expect(JSON.parse(layer.content.textParams!.stops)).toEqual([
      { pos: 0, color: "#10305a", alpha: 60, mid: 50 },
      { pos: 30, color: "#c04020", alpha: 60, mid: 50 },
      { pos: 100, color: "#fff4a0", alpha: 60, mid: 50 },
    ]);
    // The layer's name and blend are its own and stay.
    expect(layer.blend.params.opacity).toBe(100);
    // What the engine receives is the Gradient node, By tone.
    const sent = serializeGraph(loaded).nodes.find((n) => n.id === layer.content.id)!;
    expect(sent.type).toBe("heeler.gradient");
    expect((sent.params as Record<string, unknown>).shape).toBe("tone");
  });

  it("takes the old menu's defaults when the layer never moved them", () => {
    const old = savedWithGradientMap({ midpoint: 50, amount: 100 }, { color_lo: "#1b2a44", color_mid: "#808080", color_hi: "#f0e0c0" });
    const { nodes } = migrateGraph(old.nodes, old.wires);
    const art = nodes.find((n) => n.id === ART_ID)!;
    const content = art.groupNodes!.find((n) => n.id === artLayers(old)[0].content.id)!;
    expect(JSON.parse(content.textParams!.stops).map((st: { pos: number; color: string; alpha: number }) => [st.pos, st.color, st.alpha])).toEqual([
      [0, "#1b2a44", 100],
      [50, "#808080", 100],
      [100, "#f0e0c0", 100],
    ]);
  });

  it("is converted inside a Finish group too", () => {
    let s = savedWithGradientMap({ midpoint: 40 }, { color_lo: "#000000", color_mid: "#336699", color_hi: "#ffffff" });
    const blend = artLayers(s)[0].blend.id;
    s = run(s, { type: "art_group_layers", ids: [blend] } as Command);
    const loaded = run(fresh(), { type: "replace_graph", nodes: s.nodes, wires: s.wires } as Command);
    const contentId = (() => {
      const walk = (ns: NodeCard[]): string | undefined => {
        for (const n of ns) {
          if (n.type === "heeler.gradient" || n.type === "heeler.gradient_map") return n.id;
          const inner = n.groupNodes ? walk(n.groupNodes) : undefined;
          if (inner) return inner;
        }
        return undefined;
      };
      return walk(loaded.nodes.find((n) => n.id === ART_ID)!.groupNodes!)!;
    })();
    const content = finishNode(loaded, contentId)!;
    expect(content.type).toBe("heeler.gradient");
    expect(content.textParams?.shape).toBe(GRADIENT_BY_TONE);
  });
});

describe("By tone on a Gradient layer", () => {
  it("is a shape beside Linear and Radial, one undo step, and hides the angle", async () => {
    const user = userEvent.setup();
    let live = run(fresh(), { type: "art_add_layer", kind: "gradient" });
    const id = artLayers(live)[0].blend.id;
    render(<LiveFinish start={live} onState={(s) => (live = s)} />);
    // The layer's settings, opened with its chevron.
    await user.click(screen.getByTestId(`art-settings-${id}`));
    const shape = screen.getByTestId(`art-grad-shape-${id}`);
    expect(menuRows(shape).map(([, label]) => label)).toEqual(["Linear", "Radial", "By tone"]);
    expect(screen.getByTestId(`art-grad-angle-${id}`)).toBeInTheDocument();
    const undo = live.undoStack.length;
    await chooseWith(user, shape, "tone");
    expect(artLayers(live)[0].content.textParams?.shape).toBe("tone");
    expect(live.undoStack.length - undo).toBe(1);
    // The angle only places the gradient on the frame: hidden By tone.
    expect(screen.queryByTestId(`art-grad-angle-${id}`)).toBeNull();
    expect(screen.queryByTestId(`art-grad-angle-value-${id}`)).toBeNull();
    // The center weighting still means something: where the colors meet.
    expect(screen.getByTestId(`art-grad-mid-${id}`)).toBeInTheDocument();
    // Back to Linear brings the angle back.
    await chooseWith(user, shape, "linear");
    expect(screen.getByTestId(`art-grad-angle-${id}`)).toBeInTheDocument();
  });

  it("keeps ADV: stops, per-stop alpha and falloff, on a Dark to Bright axis", async () => {
    const user = userEvent.setup();
    let live = run(fresh(), { type: "art_add_layer", kind: "gradient" });
    const id = artLayers(live)[0].blend.id;
    live = run(live, { type: "art_content_set", id, param: "shape", value: "tone" });
    render(<LiveFinish start={live} onState={(s) => (live = s)} />);
    // The layer's settings, opened with its chevron.
    await user.click(screen.getByTestId(`art-settings-${id}`));
    await user.click(screen.getByTestId(`art-grad-advanced-${id}`));
    const panel = screen.getByTestId(`art-grad-${id}-panel`);
    expect(within(panel).getByTestId(`art-grad-${id}-tone-axis`).textContent).toBe("DarkBright");
    await user.click(screen.getByTestId(`art-grad-${id}-add`));
    expect(screen.getAllByTestId(new RegExp(`^art-grad-${id}-stop-\\d$`))).toHaveLength(3);
    // A stop's place reads as a tone.
    expect(within(screen.getByTestId(`art-grad-${id}-stop-1`)).getByText("Tone")).toBeInTheDocument();
    const undo = live.undoStack.length;
    const alpha = screen.getByTestId(`art-grad-${id}-alpha-1-value`);
    fireEvent.change(alpha, { target: { value: "25" } });
    fireEvent.keyDown(alpha, { key: "Enter" });
    const stops = JSON.parse(artLayers(live)[0].content.textParams!.stops);
    expect(stops).toHaveLength(3);
    expect(stops[1].alpha).toBe(25);
    expect(live.undoStack.length - undo).toBe(1);
    expect(artLayers(live)[0].content.textParams?.shape).toBe("tone");
  });

  it("is the same control on the Gradient node in the graph inspector", async () => {
    const user = userEvent.setup();
    const node: NodeCard = {
      id: "grad",
      type: "heeler.gradient",
      name: "Gradient",
      cat: "utility",
      x: 0,
      y: 0,
      enabled: true,
      params: { alpha_a: 100, alpha_b: 100, angle: 0, midpoint: 50 },
      textParams: { color_a: "#000000", color_b: "#ffffff", shape: "linear", stops: "" },
      hasIn: true,
      hasOut: true,
    } as NodeCard;
    const sent: Command[] = [];
    let s = run(fresh(), { type: "add_node", node } as Command, { type: "select_nodes", ids: ["grad"] });
    const { rerender } = render(<Inspector state={s} dispatch={(c: Command) => sent.push(c)} />);
    const shape = screen.getByTestId("art-grad-shape-grad");
    expect(menuRows(shape).map(([, label]) => label)).toEqual(["Linear", "Radial", "By tone"]);
    // One seat each: the angle and center are the shared component's,
    // not generic rows as well.
    expect(screen.getByTestId("art-grad-angle-grad")).toBeInTheDocument();
    expect(screen.queryByTestId("slider-angle")).toBeNull();
    expect(screen.queryByTestId("slider-midpoint")).toBeNull();
    await chooseWith(user, shape, "tone");
    expect(sent).toContainEqual({ type: "set_text_param", id: "grad", param: "shape", value: "tone" });
    s = run(s, { type: "set_text_param", id: "grad", param: "shape", value: "tone" });
    rerender(<Inspector state={s} dispatch={(c: Command) => sent.push(c)} />);
    expect(screen.queryByTestId("art-grad-angle-grad")).toBeNull();
    // ADV opens the same stop list in place, on the tone axis.
    await user.click(screen.getByTestId("art-grad-advanced-grad"));
    expect(sent.some((c) => c.type === "set_text_param" && c.param === "stops")).toBe(true);
    expect(screen.getByTestId("node-grad-grad-stops-tone-axis")).toBeInTheDocument();
    act(() => {});
  });
});
