// Panorama progress in the stack merge card's format (2026-10-08:
// "the panoramic stitching progress should be the same format as what
// stacking uses"): the mark, a title naming what is stitched, the bar, a
// detail line with the stage, the percent and the time left, and a dog
// line. The stage, percent, bar and failure behavior stay pinned in
// app.test.tsx's "stitch progress" tests.
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { initialState } from "../data";
import { reduce, type State } from "../state";
import { STITCH_QUOTES, StitchDialog, stitchLines } from "../ui/stitching";

const job = (p: Partial<NonNullable<State["stitch"]>>): NonNullable<State["stitch"]> => ({
  image: "pan", fraction: 0.25, stage: "Matching frames 2 and 3", error: null, ...p,
});

describe("the stitch card", () => {
  it("is the stack card: its classes, the mark, and a dog line", () => {
    const s = reduce(initialState(), { type: "set_stitch_progress", progress: job({ frames: 5, elapsedMs: 4000 }) });
    render(<StitchDialog state={s} dispatch={() => {}} />);
    const card = screen.getByRole("dialog");
    expect(card.className).toBe("stack-merge");
    expect(card.querySelector("img")?.getAttribute("src")).toBe("/heeler-icon.svg");
    expect(screen.getByTestId("stitch-title").className).toBe("stack-merge-title");
    expect(screen.getByTestId("stitch-stage").className).toBe("stack-merge-detail");
    expect(STITCH_QUOTES).toContain(screen.getByTestId("stitch-quote").textContent);
  });

  it("names what it stitches, and the full-size tier", () => {
    expect(stitchLines(job({ frames: 5 })).title).toBe("Stitching 5 frames");
    expect(stitchLines(job({ frames: 12, full: true })).title).toBe("Stitching 12 frames · full resolution");
    // An older backend sends no frame count.
    expect(stitchLines(job({})).title).toBe("Stitching panorama");
  });

  it("says how long is left once there is enough to go on", () => {
    // A quarter done in 4 s: three quarters to go at that pace is 12 s.
    expect(stitchLines(job({ elapsedMs: 4000 })).left).toBe("about 12 s left");
    // Too early to say: under 1.5 s, or barely started.
    expect(stitchLines(job({ elapsedMs: 1000 })).left).toBeNull();
    expect(stitchLines(job({ fraction: 0.01, elapsedMs: 4000 })).left).toBeNull();
    // Done has nothing left.
    expect(stitchLines(job({ fraction: 1, elapsedMs: 9000 })).left).toBeNull();
    const s = reduce(initialState(), { type: "set_stitch_progress", progress: job({ frames: 5, elapsedMs: 4000 }) });
    render(<StitchDialog state={s} dispatch={() => {}} />);
    expect(screen.getByTestId("stitch-stage")).toHaveTextContent("Matching frames 2 and 3 · 25% · about 12 s left");
  });

  it("a failure keeps the card with its reason and no bar or dog line", () => {
    const s = reduce(initialState(), { type: "set_stitch_progress", progress: job({ fraction: 1, stage: "Failed", error: "these frames do not overlap enough to stitch", frames: 4 }) });
    render(<StitchDialog state={s} dispatch={() => {}} />);
    expect(screen.getByTestId("stitch-title")).toHaveTextContent("Panorama failed");
    expect(screen.getByTestId("stitch-stage")).toHaveTextContent("do not overlap");
    expect(screen.queryByTestId("stitch-quote")).toBeNull();
    expect(screen.getByTestId("stitch-dismiss")).toBeTruthy();
  });
});

// Centered on the canvas, as the stack's card is, not on the window
// beside it (2026-10-08: "it doesn't seem to be centered").
describe("where the stitch card sits", () => {
  it("at the canvas's center when there is a canvas, and the window's otherwise", () => {
    const s = reduce(initialState(), { type: "set_stitch_progress", progress: job({ frames: 5 }) });
    const first = render(<StitchDialog state={s} dispatch={() => {}} />);
    expect(screen.getByRole("dialog").style.left).toBe("");
    first.unmount();
    const stage = document.createElement("div");
    stage.dataset.testid = "viewer-stage";
    stage.getBoundingClientRect = () => ({ left: 300, top: 60, width: 1000, height: 800, right: 1300, bottom: 860, x: 300, y: 60, toJSON: () => ({}) }) as DOMRect;
    document.body.appendChild(stage);
    try {
      render(<StitchDialog state={s} dispatch={() => {}} />);
      const card = screen.getByRole("dialog");
      expect(card.style.left).toBe("800px");
      expect(card.style.top).toBe("460px");
    } finally {
      stage.remove();
    }
  });
});
