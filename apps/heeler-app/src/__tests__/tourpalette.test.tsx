// Find a Node under a guided tour (2026-09-29: "In node graph 'show me'
// it would help to highlight the 'find node' dialog to emphasize where
// to type, it was darkened like rest of the app"). While a tour runs
// and the palette is open, however it was opened, the palette gets a
// hole of its own whatever the step points at, its search field has the
// focus, and the card keeps clear of it. jsdom lays nothing out, so the
// palette is given offsets of its own, as tourcard's tests do.

import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App } from "../app";
import { CARD_W } from "../ui/touroverlay";
import { currentWalk, endedTour, resetToursForTests, startTourHere, type Tour } from "../tourwalk";

beforeEach(async () => {
  const { mockResetSessions } = await import("../bridge");
  mockResetSessions();
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 768 });
});
afterEach(() => resetToursForTests());

/** The owner's tour: the palette, then a step that points at a node not
 * yet in the graph, so the stop itself has nothing on screen to
 * spotlight.*/
const TO_NODE: Tour = {
  id: "palette-node",
  question: "How do I add a Recolor node?",
  steps: [
    { stop: "graph.add", say: "Open the palette." },
    { stop: "node.recolor", say: "Here is the Recolor node." },
  ],
  followUps: [],
};

const ADD: Tour = {
  id: "palette-add",
  question: "How do I add a Recolor node?",
  steps: [
    { stop: "graph.add", say: "Open the palette." },
    { stop: "graph.add.recolor", say: "Pick Recolor." },
  ],
  followUps: [],
};

/** Where the browser sends a key: the focused element, else the body. */
function press(init: KeyboardEventInit & { key: string }) {
  const target = (document.activeElement as HTMLElement | null) ?? document.body;
  fireEvent.keyDown(target, init);
  fireEvent.keyUp(target, init);
}

async function graphWithTour(user: ReturnType<typeof userEvent.setup>, tour: Tour) {
  render(<App />);
  await user.click(screen.getByRole("tablist", { name: /workspace mode/i }).children[1]);
  act(() => {
    startTourHere(tour);
  });
  expect(screen.getByTestId("tour-card")).toBeInTheDocument();
}

const PALETTE = { x: 272, y: 90, w: 480, h: 360 };

/** Lays the open palette out where the app puts it (top middle), and
 * lets the tour measure it again. */
function layOutPalette() {
  const backdrop = screen.getByTestId("node-palette-backdrop");
  const box = screen.getByTestId("node-palette");
  const def = (el: HTMLElement, props: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(props)) Object.defineProperty(el, k, { configurable: true, value: v });
  };
  def(backdrop, { offsetLeft: 0, offsetTop: 0, offsetParent: null, offsetWidth: 1024, offsetHeight: 768 });
  def(box, { offsetLeft: PALETTE.x, offsetTop: PALETTE.y, offsetParent: backdrop, offsetWidth: PALETTE.w, offsetHeight: PALETTE.h });
  act(() => {
    window.dispatchEvent(new Event("resize"));
  });
}

function paletteHole() {
  const hole = screen.getByTestId("tour-hole-palette");
  const n = (a: string) => Number(hole.getAttribute(a));
  return { x: n("x"), y: n("y"), w: n("width"), h: n("height") };
}

function cardBox() {
  const box = screen.getByTestId("tour-card-box");
  // The card's height is its measured one; jsdom measures none, so the
  // overlay's guess stands, about a step card's height.
  return { x: parseFloat(box.style.left), y: parseFloat(box.style.top), w: CARD_W, h: 150 };
}

const overlaps = (a: { x: number; y: number; w: number; h: number }, b: typeof a) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

describe("Find a Node while a tour runs", () => {
  it("opened by Shift+Space: the palette is cut out of the dimming, its search has the focus, and the card keeps clear of it", async () => {
    const user = userEvent.setup();
    await graphWithTour(user, TO_NODE);
    press({ key: " ", code: "Space", shiftKey: true });
    expect(screen.getByTestId("node-palette")).toBeInTheDocument();
    // The add-node step is done: the step now points at a node that is
    // not in the graph yet, which is where the palette went dark.
    expect(screen.getByTestId("tour-say").textContent).toBe("Here is the Recolor node.");
    layOutPalette();
    const hole = paletteHole();
    expect(hole.x).toBeLessThanOrEqual(PALETTE.x);
    expect(hole.y).toBeLessThanOrEqual(PALETTE.y);
    expect(hole.x + hole.w).toBeGreaterThanOrEqual(PALETTE.x + PALETTE.w);
    expect(hole.y + hole.h).toBeGreaterThanOrEqual(PALETTE.y + PALETTE.h);
    expect(document.activeElement).toBe(screen.getByTestId("palette-search"));
    expect(overlaps(cardBox(), hole)).toBe(false);
    // The card says where to type, and does not call the palette's step
    // off screen.
    expect(screen.getByTestId("tour-palette-how").textContent).toMatch(/Find a Node/);
    expect(screen.queryByTestId("tour-offscreen")).not.toBeInTheDocument();
  });

  it("opened by the add node button: the same hole, focus and placement", async () => {
    const user = userEvent.setup();
    await graphWithTour(user, ADD);
    await user.click(screen.getByTestId("palette-add"));
    expect(screen.getByTestId("tour-say").textContent).toBe("Pick Recolor.");
    layOutPalette();
    const hole = paletteHole();
    expect(hole.w).toBeGreaterThanOrEqual(PALETTE.w);
    expect(document.activeElement).toBe(screen.getByTestId("palette-search"));
    expect(overlaps(cardBox(), hole)).toBe(false);
  });

  it("Escape closes only the palette, and its hole goes with it", async () => {
    const user = userEvent.setup();
    await graphWithTour(user, ADD);
    press({ key: " ", code: "Space", shiftKey: true });
    layOutPalette();
    expect(screen.getByTestId("tour-hole-palette")).toBeInTheDocument();
    press({ key: "Escape" });
    expect(screen.queryByTestId("node-palette")).not.toBeInTheDocument();
    expect(screen.queryByTestId("tour-hole-palette")).not.toBeInTheDocument();
    expect(screen.queryByTestId("tour-palette-how")).not.toBeInTheDocument();
    expect(currentWalk()).not.toBeNull();
  });

  it("typing in the spotlighted search and Enter adds the node and completes the step", async () => {
    const user = userEvent.setup();
    await graphWithTour(user, ADD);
    press({ key: " ", code: "Space", shiftKey: true });
    layOutPalette();
    await user.keyboard("recolor");
    expect((screen.getByTestId("palette-search") as HTMLInputElement).value).toBe("recolor");
    await user.keyboard("{Enter}");
    expect(screen.queryByTestId("node-palette")).not.toBeInTheDocument();
    expect(currentWalk()).toBeNull();
    expect(endedTour()?.status).toBe("finished");
  });

  it("no palette hole without a tour's step on screen, and none with the palette closed", async () => {
    const user = userEvent.setup();
    await graphWithTour(user, ADD);
    expect(screen.queryByTestId("tour-hole-palette")).not.toBeInTheDocument();
    expect(screen.queryByTestId("tour-palette-how")).not.toBeInTheDocument();
  });
});
