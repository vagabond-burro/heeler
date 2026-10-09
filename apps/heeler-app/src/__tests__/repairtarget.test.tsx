// The clone and heal source marker on the canvas: where the next dab
// reads from, which has to move with the brush whenever the pixels do.

import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { App } from "../app";

/** The Finish tab with a pixel layer and Heal in hand, its overlay
 * pinned to a 200 pixel square so pointer positions mean something. */
async function healing(aligned: boolean) {
  localStorage.setItem("heeler.ui.brushCloneAligned", JSON.stringify(aligned));
  const user = userEvent.setup();
  render(<App />);
  await user.click(screen.getByTestId("panel-tab-layers"));
  await user.click(screen.getByTestId("art-add-content"));
  // Heal is the repair button's default half, so one tap arms it.
  await user.click(screen.getByTestId("art-tool-repair"));
  const brush = screen.getByTestId("brush-overlay");
  brush.getBoundingClientRect = () =>
    ({ left: 0, top: 0, right: 200, bottom: 200, width: 200, height: 200, x: 0, y: 0, toJSON() {} }) as DOMRect;
  return brush;
}

/** The marker's center, in 0..1 frame space, from its placement. */
function markerAt(): [number, number] {
  const el = screen.getByTestId("clone-source");
  return [parseFloat(el.style.left) / 100, parseFloat(el.style.top) / 100];
}

describe("the repair source marker", () => {
  it("rides with the brush once Aligned has locked the distance", async () => {
    const brush = await healing(true);
    // ALT-click the middle: the marker sits on the pick.
    fireEvent.mouseDown(brush, { button: 0, altKey: true, clientX: 100, clientY: 100 });
    fireEvent.mouseUp(brush, { clientX: 100, clientY: 100 });
    expect(markerAt()[0]).toBeCloseTo(0.5);
    expect(markerAt()[1]).toBeCloseTo(0.5);

    // The first stroke starts at (0.2, 0.2), which locks a distance of
    // (0.3, 0.3) from brush to source.
    fireEvent.mouseDown(brush, { button: 0, clientX: 40, clientY: 40 });
    fireEvent.mouseMove(brush, { buttons: 1, clientX: 60, clientY: 60 });
    // Mid-stroke the source has moved with the brush already.
    expect(markerAt()[0]).toBeCloseTo(0.6);
    expect(markerAt()[1]).toBeCloseTo(0.6);
    fireEvent.mouseUp(brush, { clientX: 60, clientY: 60 });

    // Hovering elsewhere carries the target along: the brush at (0.4,
    // 0.1) reads from (0.7, 0.4), which is where the marker is. The
    // report: "the pixels that are references are aligning correctly but
    // the target does not move on the canvas."
    fireEvent.mouseMove(brush, { buttons: 0, clientX: 80, clientY: 20 });
    expect(markerAt()[0]).toBeCloseTo(0.7);
    expect(markerAt()[1]).toBeCloseTo(0.4);
    localStorage.removeItem("heeler.ui.brushCloneAligned");
  });

  it("follows the stroke unaligned, then goes back to the pick", async () => {
    const brush = await healing(false);
    fireEvent.mouseDown(brush, { button: 0, altKey: true, clientX: 100, clientY: 100 });
    fireEvent.mouseUp(brush, { clientX: 100, clientY: 100 });

    fireEvent.mouseDown(brush, { button: 0, clientX: 40, clientY: 40 });
    fireEvent.mouseMove(brush, { buttons: 1, clientX: 70, clientY: 50 });
    expect(markerAt()[0]).toBeCloseTo(0.65);
    expect(markerAt()[1]).toBeCloseTo(0.55);
    fireEvent.mouseUp(brush, { clientX: 70, clientY: 50 });

    // Unaligned starts every stroke from the pick again, so at rest the
    // marker says so, wherever the brush is hovering.
    fireEvent.mouseMove(brush, { buttons: 0, clientX: 150, clientY: 20 });
    expect(markerAt()[0]).toBeCloseTo(0.5);
    expect(markerAt()[1]).toBeCloseTo(0.5);
    localStorage.removeItem("heeler.ui.brushCloneAligned");
  });
});
