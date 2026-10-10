// A depth export says which way its plane runs (2026-10-01): the "Depth
// Map Export Layer" card's thumbnail shows near BLACK, far WHITE (what
// the export writes, EXR's mist.Z, kept on purpose) while Develop's
// Depth Map view shows near WHITE, far BLACK. It read like a bug. His
// call: keep both and SAY so, a short line on the card and in the
// Inspector, "Written near black, far white (the EXR depth
// convention)". Only depth exports say it; color and mask exports do
// not. One constant holds the words in every seat.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen } from "@testing-library/react";
import { initialState, NEUTRAL_NODES, NEUTRAL_WIRES } from "../data";
import {
  DEPTH_EXPORT_CONVENTION,
  DEPTH_MAP_CARD_CONVENTION,
  depthMapShowsDepth,
  exportLayerCard,
  exportWritesDepth,
  layerMaskExportId,
  reduce,
  sectionExportId,
  type Command,
  type State,
} from "../state";
import { SECTIONS, SimplePanel, sectionExportTap } from "../ui/simple";
import { Inspector, NodeEditor } from "../ui/graph";


const run = (s: State, ...cmds: Command[]): State => cmds.reduce(reduce, s);
const fresh = (): State => ({
  ...initialState(),
  nodes: structuredClone(NEUTRAL_NODES),
  wires: structuredClone(NEUTRAL_WIRES),
});

function sectionToggle(s: State, title: string): State {
  const tap = sectionExportTap(s, SECTIONS.find((x) => x.title === title)!)!;
  return run(s, { type: "set_section_export", title, tap: tap.tap, depth: tap.depth, on: true });
}

/** One of each kind: the Depth Map's plane, Curves' picture, and a
 * Develop layer's mask. */
function threeExports(): { s: State; depth: string; color: string; mask: string } {
  let s = sectionToggle(initialState(), "Depth Map");
  s = sectionToggle(s, "Curves");
  s = run(s, { type: "add_layer", maskType: "range" });
  const layer = s.activeLayer!;
  s = run(s, { type: "set_layer_mask_export", id: layer, on: true });
  return { s, depth: sectionExportId("Depth Map"), color: sectionExportId("Curves"), mask: layerMaskExportId(layer) };
}

describe("a depth export names its convention", () => {
  it("knows a depth export from a color or mask export by its wire", () => {
    const { s, depth, color, mask } = threeExports();
    const node = (id: string) => s.nodes.find((n) => n.id === id)!;
    expect(exportWritesDepth(node(depth), s.wires)).toBe(true);
    expect(exportWritesDepth(node(color), s.wires)).toBe(false);
    expect(exportWritesDepth(node(mask), s.wires)).toBe(false);
  });

  it("says it on the depth export's card in the Graph, under the thumbnail, and on no other card", () => {
    const { s, depth, color, mask } = threeExports();
    render(<NodeEditor state={s} dispatch={() => {}} />);
    const line = screen.getByTestId(`depth-convention-${depth}`);
    expect(line.textContent).toBe(DEPTH_EXPORT_CONVENTION);
    // Under the thumbnail: the thumbnail is the line's previous sibling.
    expect(line.previousElementSibling?.classList.contains("thumb")).toBe(true);
    expect(screen.queryByTestId(`depth-convention-${color}`)).toBeNull();
    expect(screen.queryByTestId(`depth-convention-${mask}`)).toBeNull();
    // Exactly one card says it.
    expect(screen.getAllByText(DEPTH_EXPORT_CONVENTION)).toHaveLength(1);
  });

  it("says it on a hand-wired depth export's card too", () => {
    let s = sectionToggle(initialState(), "Depth Map");
    const dm = s.nodes.find((n) => n.type === "heeler.depth_map")!;
    s = run(s, { type: "add_node", node: exportLayerCard("hand_x", "Export Layer", 0, 600, {}) });
    s = { ...s, wires: [...s.wires, { from: dm.id, fromPort: "depth", to: "hand_x", toPort: "mask", kind: "mask" }] };
    render(<NodeEditor state={s} dispatch={() => {}} />);
    expect(screen.getByTestId("depth-convention-hand_x").textContent).toBe(DEPTH_EXPORT_CONVENTION);
  });

  it("says it in the depth export's Inspector, under the Name row, and not in a color or mask export's", () => {
    const { s, depth, color, mask } = threeExports();
    const seen = (id: string) => {
      const { unmount } = render(<Inspector state={run(s, { type: "select_nodes", ids: [id] })} dispatch={() => {}} />);
      const line = screen.queryByTestId("export-layer-depth-convention");
      const out = line
        ? {
            text: line.textContent,
            help: line.classList.contains("help"),
            afterName: !!line.previousElementSibling?.querySelector('[data-testid="export-layer-name"]'),
          }
        : null;
      expect(screen.getByTestId("export-layer-name")).toBeInTheDocument();
      unmount();
      return out;
    };
    expect(seen(depth)).toEqual({ text: DEPTH_EXPORT_CONVENTION, help: true, afterName: true });
    expect(seen(color)).toBeNull();
    expect(seen(mask)).toBeNull();
  });

  it("says it in the Depth Map section's Export box hint, the same words", () => {
    const s = fresh();
    render(<SimplePanel state={s} dispatch={(() => {}) as never} />);
    expect(screen.getByTestId("section-export-depth-map").getAttribute("data-hint")).toContain(DEPTH_EXPORT_CONVENTION);
    // A color section's box does not.
    expect(screen.getByTestId("section-export-curves").getAttribute("data-hint")).not.toContain("near black");
  });

  it("keeps the words in one constant: no seat spells them out by hand", () => {
    for (const file of ["ui/graph.tsx", "ui/simple.tsx", "ui/exporttick.tsx"]) {
      const text = readFileSync(resolve(process.cwd(), "src", file), "utf8");
      expect(text, file).not.toMatch(/near black, far white/);
    }
  });
});

/** The Depth Map card is drawn from its depth plane once its depth is
 * wired out (the desktop's node_thumbs), so it says so; unwired, its card
 * is the photograph it passes through and says nothing (2026-10-10: "the
 * depth map node is not black and white"). */
describe("the Depth Map card names what its picture is", () => {
  const withDepthWire = (on: boolean): State => {
    const s = initialState();
    const wires = s.wires.filter((w) => !(w.from === "depthmap" && w.fromPort === "depth"));
    return { ...s, wires: on ? [...wires, { from: "depthmap", fromPort: "depth", to: "keylight", toPort: "depth", kind: "mask" } as State["wires"][number]] : wires };
  };

  it("only once its depth output feeds something", () => {
    const node = (s: State) => s.nodes.find((n) => n.id === "depthmap")!;
    expect(depthMapShowsDepth(node(withDepthWire(true)), withDepthWire(true).wires)).toBe(true);
    expect(depthMapShowsDepth(node(withDepthWire(false)), withDepthWire(false).wires)).toBe(false);
    // An image wire out of the Depth Map is its picture, not its depth.
    const s = withDepthWire(false);
    expect(depthMapShowsDepth(node(s), [...s.wires, { from: "depthmap", to: "keylight", kind: "image" } as State["wires"][number]])).toBe(false);
  });

  it("says it under the card's thumbnail in the Graph, and not when unwired", () => {
    const { unmount } = render(<NodeEditor state={withDepthWire(true)} dispatch={() => {}} />);
    const line = screen.getByTestId("depth-map-convention-depthmap");
    expect(line.textContent).toBe(DEPTH_MAP_CARD_CONVENTION);
    expect(line.previousElementSibling?.classList.contains("thumb")).toBe(true);
    unmount();
    render(<NodeEditor state={withDepthWire(false)} dispatch={() => {}} />);
    expect(screen.queryByTestId("depth-map-convention-depthmap")).toBeNull();
  });
});
