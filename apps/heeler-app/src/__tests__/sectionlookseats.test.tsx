// Where the section looks sit (2026-09-30): in the Relight and
// Recolor sections of the Develop panel, switched off or on, never
// dimmed with a locked section's body, and on the chain's Relight and
// Recolor nodes in the graph inspector (features reach their nodes).
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { initialState } from "../data";
import { reduce, type Command, type State } from "../state";
import { NodeParams } from "../ui/graph";
import { SimplePanel } from "../ui/simple";

afterEach(() => {
  cleanup();
});

const noop = (() => {}) as (c: Command) => void;

/** A fresh photograph's graph with the two sections unfolded (they
 * ship folded, and a folded section shows only its header). */
function fresh(): State {
  const s = initialState();
  return {
    ...s,
    nodes: structuredClone(s.defaultGraph.nodes),
    wires: structuredClone(s.defaultGraph.wires),
    sectionsClosed: s.sectionsClosed.filter((t) => t !== "Relight" && t !== "Recolor"),
  };
}

const outsideLock = (el: HTMLElement) => el.closest("[data-locked]") === null;

it("a free copy's fresh photograph shows both rows in the unfolded sections, and none while folded", () => {
  render(<SimplePanel state={fresh()} dispatch={noop as never} />);
  for (const slug of ["relight", "recolor"]) {
    const row = screen.getByTestId(`looks-${slug}`);
    expect(outsideLock(row)).toBe(true);
    expect(row.closest(`[data-section]`)?.getAttribute("data-section")).toBe(slug === "relight" ? "Relight" : "Recolor");
  }
  // One menu each, no row of buttons.
  expect(screen.getByTestId("looks-relight-menu")).toBeInTheDocument();
  expect(screen.getByTestId("looks-recolor-menu")).toBeInTheDocument();
  expect(screen.queryByTestId("look-relight-low-key")).toBeNull();
  expect(screen.queryByTestId("look-recolor-teal-orange")).toBeNull();
  cleanup();
  render(<SimplePanel state={{ ...fresh(), sectionsClosed: initialState().sectionsClosed }} dispatch={noop as never} />);
  expect(screen.queryByTestId("looks-relight")).toBeNull();
});

it("an adjustment layer in hand hides the rows: a look is written to the photograph's own chain", () => {
  const s = reduce(fresh(), { type: "add_layer", maskType: "brush" });
  expect(s.activeLayer).not.toBeNull();
  render(<SimplePanel state={s} dispatch={noop as never} />);
  expect(screen.queryByTestId("looks-relight")).toBeNull();
  expect(screen.queryByTestId("looks-recolor")).toBeNull();
});

it("the inspector offers the same row on the chain's Relight and Recolor nodes", () => {
  const s = initialState();
  const toneeq = s.nodes.find((n) => n.id === "toneeq")!;
  const recolor = s.nodes.find((n) => n.id === "recolor")!;
  const a = render(<NodeParams node={toneeq} dispatch={noop as never} appState={s} />);
  expect(screen.getByTestId("looks-relight-inspector")).toBeInTheDocument();
  expect(screen.getByTestId("looks-relight-menu-inspector")).toBeInTheDocument();
  expect(screen.queryByTestId("look-relight-low-key-inspector")).toBeNull();
  a.unmount();
  render(<NodeParams node={recolor} dispatch={noop as never} appState={s} />);
  expect(screen.getByTestId("looks-recolor-inspector")).toBeInTheDocument();
  cleanup();
  // Without the app state (the popped-out graph window) there is no
  // viewer to show a held look on.
  render(<NodeParams node={toneeq} dispatch={noop as never} />);
  expect(screen.queryByTestId("looks-relight-inspector")).toBeNull();
});

it("a Pro copy has the same menu in both sections and on both nodes (\"keep them available on pro\")", () => {
  const s = { ...initialState(), sectionsClosed: initialState().sectionsClosed.filter((t) => t !== "Relight" && t !== "Recolor") };
  const panel = render(<SimplePanel state={s} dispatch={noop as never} />);
  expect(screen.getByTestId("looks-relight-menu")).toBeInTheDocument();
  expect(screen.getByTestId("looks-recolor-menu")).toBeInTheDocument();
  expect(screen.queryByTestId("look-relight-low-key")).toBeNull();
  panel.unmount();
  render(<NodeParams node={s.nodes.find((n) => n.id === "recolor")!} dispatch={noop as never} appState={s} />);
  expect(screen.getByTestId("looks-recolor-menu-inspector")).toBeInTheDocument();
});
