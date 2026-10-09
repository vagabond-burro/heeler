// The interactive color ribbon: click adds, X removes, a handle drags.
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { RibbonEditor } from "../ui/ribbon";
import type { GradStop } from "../ui/gradientstops";

const two: GradStop[] = [
  { pos: 0, color: "#ff0000", alpha: 100, mid: 50 },
  { pos: 100, color: "#0000ff", alpha: 100, mid: 50 },
];

describe("the color ribbon", () => {
  it("adds a point where the bar is clicked, in the color found there", () => {
    const got: GradStop[][] = [];
    render(<RibbonEditor testid="rb" stops={two} onChange={(n) => got.push(n)} />);
    // No layout in jsdom: a click lands at the middle.
    fireEvent.click(screen.getByTestId("rb-bar"), { clientX: 0 });
    expect(got[0]).toHaveLength(3);
    expect(got[0][2]).toMatchObject({ pos: 50, color: "#800080", alpha: 100 });
    // Two points cannot lose one; three can.
    expect(screen.queryByTestId("rb-remove-0")).not.toBeInTheDocument();
  });

  it("removes a point from its X and keeps the others in stored order", () => {
    const three: GradStop[] = [...two, { pos: 30, color: "#00ff00", alpha: 100, mid: 50 }];
    const got: GradStop[][] = [];
    render(<RibbonEditor testid="rb" stops={three} onChange={(n) => got.push(n)} />);
    fireEvent.click(screen.getByTestId("rb-remove-0"));
    expect(got[0].map((s) => s.pos)).toEqual([100, 30]);
  });

  it("a handle drag moves its own stop and brackets one gesture", () => {
    const got: GradStop[][] = [];
    const marks: string[] = [];
    render(
      <RibbonEditor
        testid="rb"
        stops={two}
        onChange={(n) => got.push(n)}
        onBegin={() => marks.push("begin")}
        onEnd={() => marks.push("end")}
      />,
    );
    const handle = screen.getByTestId("rb-handle-1");
    fireEvent(handle, new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 0 }));
    fireEvent(window, new MouseEvent("pointermove", { bubbles: true, clientX: 10 }));
    fireEvent(window, new MouseEvent("pointerup", { bubbles: true }));
    expect(marks).toEqual(["begin", "end"]);
    // jsdom has no layout, so the position resolves to the middle; the
    // point that moved is the one grabbed, and the other stayed.
    expect(got[got.length - 1].map((s: GradStop) => s.pos)).toEqual([0, 50]);
  });
});
