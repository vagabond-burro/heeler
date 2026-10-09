// The cursor tip: the NAME of an icon-only control, at the pointer,
// clamped against the window so it never clips at an edge (The
// report: "Make sure the tool tip is aware of the side of the
// window").

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CursorTip } from "../ui/cursortip";

const hoverAt = (el: Element, x: number, y: number) => {
  fireEvent.mouseOver(el, { clientX: x, clientY: y });
  fireEvent.mouseMove(el, { clientX: x, clientY: y });
};

describe("the cursor tip", () => {
  it("shows the name beside the pointer after a beat, and puts it away", async () => {
    render(
      <>
        <CursorTip />
        <button data-tip="Set focus">x</button>
        <div data-testid="plain" />
      </>,
    );
    expect(screen.queryByTestId("cursor-tip")).toBeNull();
    hoverAt(screen.getByRole("button"), 120, 80);
    const tip = await screen.findByTestId("cursor-tip");
    expect(tip).toHaveTextContent("Set focus");
    expect(parseInt(tip.style.left)).toBeGreaterThan(120);
    // Above the pointer, not under it (the cursor sat on
// the name).
    expect(parseInt(tip.style.top)).toBeLessThan(80);
    // Hovering anything without a tip clears it.
    fireEvent.mouseOver(screen.getByTestId("plain"));
    await waitFor(() => expect(screen.queryByTestId("cursor-tip")).toBeNull());
  });

  it("clamps against the window's right edge instead of clipping", async () => {
    render(
      <>
        <CursorTip />
        <button data-tip="A rather long control name">x</button>
      </>,
    );
    hoverAt(screen.getByRole("button"), window.innerWidth - 4, 80);
    const tip = await screen.findByTestId("cursor-tip");
    const left = parseInt(tip.style.left);
    expect(left).toBeLessThan(window.innerWidth - 4);
  });
});

describe("a tip asked to sit below", () => {
  it("flips above when the window's bottom is in the way", async () => {
    render(
      <>
        <CursorTip />
        <button data-tip="Exposure.in" data-tip-below="">x</button>
      </>,
    );
    hoverAt(screen.getByRole("button"), 120, window.innerHeight - 4);
    const tip = await screen.findByTestId("cursor-tip");
    expect(parseInt(tip.style.top)).toBeLessThan(window.innerHeight - 4);
  });
});
