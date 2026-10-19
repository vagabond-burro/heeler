// One section, one layout: Develop's panel and Graph's inspector draw a
// section's rows and widgets from the same definition (SECTIONS), so the
// Recolor node in Graph can no longer keep an old order of its own
// (2026-10-19: "THe Neutral guard is still above graph and pairs are
// missing. Whether in develop or graph, it should be using the same
// template layout").
import { render, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { initialState } from "../data";
import { reduce, toolNode, type Command, type State } from "../state";
import { SimplePanel } from "../ui/simple";
import { Inspector } from "../ui/graph";
import { SECTIONS } from "../ui/simpledata";

const run = (s: State, ...cmds: Command[]) => cmds.reduce(reduce, s);
afterEach(() => cleanup());

/** The face's pieces in the order they draw: its two dials, the routing
 * grid and curve, the guard's strip and the color pairs. */
const MARKS = '[data-param="smoothing"], [data-param="neutral_guard"], [data-testid="section-widget-recolorGraph"], [data-testid="guard-strip"], [data-testid="recolor-pairs"]';
const order = (root: Element | null) =>
  [...(root?.querySelectorAll(MARKS) ?? [])]
    .filter((e) => !e.parentElement?.closest('[data-param="smoothing"], [data-param="neutral_guard"]'))
    .map((e) => (e.hasAttribute("data-param") ? `param:${e.getAttribute("data-param")}` : e.getAttribute("data-testid")));

describe("Recolor's face", () => {
  it("is the same in Develop and in Graph, from one definition", () => {
    const s = run(initialState(), { type: "set_category", title: "Recolor", on: true }, { type: "open_section", title: "Recolor" });
    const node = toolNode(s, "recolor")!;

    render(<SimplePanel state={{ ...s, mode: "simple" }} dispatch={() => {}} width={320} />);
    const develop = order(document.querySelector('[data-section="Recolor"]'));
    cleanup();

    const { container } = render(<Inspector state={{ ...s, mode: "advanced", selection: [node.id] }} dispatch={() => {}} frame={null} />);
    const graph = order(container.querySelector('[data-testid="section-face-recolor"]'));

    // The guard's strip draws nothing without a picture to read (none in
    // a test); its seat is the definition's, checked below.
    expect(develop).toEqual(["param:smoothing", "section-widget-recolorGraph", "param:neutral_guard", "recolor-pairs"]);
    expect(graph).toEqual(develop);
    const guard = SECTIONS.find((sec) => sec.title === "Recolor")!.rows.find((r) => r.param === "neutral_guard")!;
    expect(guard.widgets).toEqual({ before: ["recolorGraph"], after: ["guardStrip", "recolorPairs"] });
  });
});
