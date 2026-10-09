// A group that publishes its own controls.
//
// "A container is like a group, but you instead define a list
// of attributes. So if we select the Grain container we see the controls we
// do now, but if we expand we see how those controls are connected to
// specific nodes... It's an abstraction layer another user works with
// without having to dig into the complex node network."
//
// And, on whether that should be a second type beside groups: "I would be
// good keeping group only and not introducing the second type Container."
//
// So a group with nothing published is today's group and a group that
// publishes is the abstraction. One concept, and the difference is a list
// rather than a type nobody can tell apart from the other.

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { initialState } from "../data";
import {
  publishedTarget,
  publishedValue,
  reduce,
  type Command,
  type NodeCard,
  type State,
} from "../state";
import { Inspector } from "../ui/graph";

const run = (s: State, ...cmds: Command[]) => cmds.reduce(reduce, s);

/** A sharpening group: a blur and a blend inside, two controls outside. */
function sharpenGroup(): NodeCard {
  return {
    id: "grp_sharpen",
    type: "heeler.group",
    name: "Sharpening",
    cat: "group",
    x: 400,
    y: 100,
    enabled: true,
    params: {},
    isGroup: true,
    hasIn: true,
    hasOut: true,
    groupNodes: [
      {
        id: "grp_blur",
        type: "heeler.blur",
        name: "Blur",
        cat: "detail",
        x: 0,
        y: 0,
        enabled: true,
        params: { radius: 3 },
      },
      {
        id: "grp_over",
        type: "heeler.blend",
        name: "Blend Mode",
        cat: "detail",
        x: 0,
        y: 0,
        enabled: true,
        params: { opacity: 50 },
      },
    ],
    published: [
      { label: "Radius", node: "grp_blur", param: "radius", range: [0, 200] },
      { label: "Intensity", node: "grp_over", param: "opacity", range: [0, 100] },
    ],
  } as NodeCard;
}

const withGroup = () => {
  const s = initialState();
  const g = sharpenGroup();
  return { ...s, nodes: [...s.nodes, g], selection: [g.id] };
};

describe("what a group publishes", () => {
  it("names a control, and where it writes", () => {
    const g = sharpenGroup();
    // The label is the group's, the target is the child's. That gap is the
    // whole point: "Radius" means something to whoever uses the group, and
    // it is a blur's radius underneath.
    expect(publishedTarget(g, "Radius")).toEqual({ node: "grp_blur", param: "radius" });
    expect(publishedTarget(g, "Intensity")).toEqual({ node: "grp_over", param: "opacity" });
    expect(publishedTarget(g, "Nothing")).toBeNull();
  });

  it("reads its value from the child that owns it", () => {
    const g = sharpenGroup();
    expect(publishedValue(g, "Radius")).toBe(3);
    expect(publishedValue(g, "Intensity")).toBe(50);
    expect(publishedValue(g, "Nothing")).toBeUndefined();
  });

  it("writes through to the child, not to the group", () => {
    const s = run(withGroup(), { type: "set_published", id: "grp_sharpen", label: "Radius", value: 12 });
    const g = s.nodes.find((n) => n.id === "grp_sharpen")!;
    expect(publishedValue(g, "Radius")).toBe(12);
    // The group itself holds no such param: it is a name for one inside.
    expect(g.params.Radius).toBeUndefined();
    expect(g.params.radius).toBeUndefined();
    // And nothing else inside moved.
    expect(publishedValue(g, "Intensity")).toBe(50);
  });

  it("ignores a control it does not publish", () => {
    const before = withGroup();
    const after = run(before, { type: "set_published", id: "grp_sharpen", label: "Ghost", value: 9 });
    expect(after.nodes).toEqual(before.nodes);
  });

  it("is undoable, since it is an edit like any other", () => {
    const before = withGroup();
    const after = run(before, { type: "set_published", id: "grp_sharpen", label: "Radius", value: 12 });
    expect(after.undoStack.length).toBe(before.undoStack.length + 1);
    const back = run(after, { type: "undo" });
    expect(publishedValue(back.nodes.find((n) => n.id === "grp_sharpen")!, "Radius")).toBe(3);
  });
});

describe("the group in the inspector", () => {
  it("shows the controls it publishes, under the group's names", () => {
    render(<Inspector state={withGroup()} dispatch={() => {}} />);
    expect(screen.getByTestId("published-radius")).toBeInTheDocument();
    expect(screen.getByTestId("published-intensity")).toBeInTheDocument();
    // The names outside are the group's, not the children's.
    expect(screen.getByLabelText("Radius")).toBeInTheDocument();
    expect(screen.queryByLabelText("Opacity")).not.toBeInTheDocument();
  });

  it("says so plainly when a group publishes nothing", () => {
    const s = initialState();
    const bare = { ...sharpenGroup(), published: undefined };
    render(
      <Inspector state={{ ...s, nodes: [...s.nodes, bare], selection: [bare.id] }} dispatch={() => {}} />,
    );
    expect(screen.getByText(/publishes no controls/i)).toBeInTheDocument();
    // And the way in is still offered, because a group with nothing
    // published is exactly today's group.
    expect(screen.getByTestId("open-group")).toBeInTheDocument();
  });

  it("moves with the arrows, so it works without a mouse", () => {
    const sent: Command[] = [];
    render(
      <Inspector state={withGroup()} dispatch={((c: Command) => sent.push(c)) as never} />,
    );
    const track = screen.getByLabelText("Radius");
    fireEvent.keyDown(track, { key: "ArrowRight" });
    // Radius is 3 on a 0..200 control, so one step of a twentieth is 10.
    expect(sent).toEqual([
      { type: "set_published", id: "grp_sharpen", label: "Radius", value: 13 },
    ]);
    // Shift is the fine step, as everywhere else.
    fireEvent.keyDown(track, { key: "ArrowLeft", shiftKey: true });
    expect((sent[1] as { value: number }).value).toBeCloseTo(2, 5);
  });

  it("refuses a pointer event that carries no coordinates", () => {
    // Writing NaN into a parameter takes the render down, and a synthetic
    // event without clientX is exactly how that arrives.
    const sent: Command[] = [];
    render(
      <Inspector state={withGroup()} dispatch={((c: Command) => sent.push(c)) as never} />,
    );
    fireEvent.pointerDown(screen.getByLabelText("Radius"));
    expect(sent).toEqual([]);
  });
});
