// The app's shortcuts while a guided tour runs (2026-09-29, in Graph: a
// step told him to press Shift+Space to add a node and nothing
// happened, "I think the dialog blocks the popup from opening"). The
// cause: the step card took the focus when the tour started (NEXT), the
// card is a role="dialog", and the app's key handler stands aside for
// every key but Escape inside a dialog. Now the card takes no focus, a
// click on its buttons leaves the focus where it was, the handler lets
// the card through, and the tour hears only Escape, as it bubbles. Keys
// are sent where the browser sends them: to the focused element.

import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App } from "../app";
import { initialState } from "../data";
import { makeNode, NODE_CATALOG } from "../nodes";
import { reduce, type State } from "../state";
import { addNodeWays } from "../tourstops";
import { connectTours, currentWalk, endedTour, resetToursForTests, setTourHost, startTourHere, tourStop, TourWalk, type Tour, type TourHost } from "../tourwalk";

beforeEach(async () => {
  const { mockResetSessions } = await import("../bridge");
  mockResetSessions();
});
afterEach(() => resetToursForTests());

const ADD: Tour = {
  id: "keys",
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

async function graphWithTour(user: ReturnType<typeof userEvent.setup>) {
  render(<App />);
  await user.click(screen.getByRole("tablist", { name: /workspace mode/i }).children[1]);
  act(() => {
    startTourHere(ADD);
  });
  expect(screen.getByTestId("tour-card")).toBeInTheDocument();
}

const inCard = () => !!document.activeElement?.closest('[data-testid="tour-card"]');

describe("shortcuts while a tour runs", () => {
  it("the step card takes no focus, and Shift+Space in Graph opens Find a Node, completing the add-node step", async () => {
    const user = userEvent.setup();
    await graphWithTour(user);
    expect(inCard()).toBe(false);
    expect(screen.queryByTestId("node-palette")).not.toBeInTheDocument();
    press({ key: " ", code: "Space", shiftKey: true });
    expect(screen.getByTestId("node-palette")).toBeInTheDocument();
    // The palette open is the add-node step done: on to picking Recolor.
    expect(screen.getByTestId("tour-say").textContent).toBe("Pick Recolor.");
  });

  it("the add node button completes the same step", async () => {
    const user = userEvent.setup();
    await graphWithTour(user);
    await user.click(screen.getByTestId("palette-add"));
    expect(screen.getByTestId("node-palette")).toBeInTheDocument();
    expect(screen.getByTestId("tour-say").textContent).toBe("Pick Recolor.");
  });

  it("a click on NEXT leaves the focus where it was, and Tab still reaches the buttons", async () => {
    const user = userEvent.setup();
    await graphWithTour(user);
    const next = screen.getByTestId("tour-next");
    // mousedown is where a browser moves the focus; the card keeps it
    // from moving.
    expect(fireEvent.mouseDown(next)).toBe(false);
    expect(next.tabIndex).toBe(0);
    expect(next.tagName).toBe("BUTTON");
  });

  it("other shortcuts dispatch with the focus on the card, exactly as without it", async () => {
    const user = userEvent.setup();
    await graphWithTour(user);
    const pressed = () => ["simple", "advanced", "canvas"].findIndex((m) => screen.getByTestId(`mode-${m}`).getAttribute("aria-pressed") === "true");
    expect(pressed()).toBe(1);
    // Tabbed onto STOP, the user presses N (Toggle Develop / Graph).
    screen.getByTestId("tour-stop").focus();
    expect(inCard()).toBe(true);
    press({ key: "n", code: "KeyN" });
    expect(pressed()).toBe(0);
    expect(currentWalk()).not.toBeNull();
  });

  it("Shift+Space works with NEXT focused, where the card used to put the focus", async () => {
    const user = userEvent.setup();
    await graphWithTour(user);
    screen.getByTestId("tour-next").focus();
    press({ key: " ", code: "Space", shiftKey: true });
    expect(screen.getByTestId("node-palette")).toBeInTheDocument();
  });

  it("a tour asked for from the Console brings the main window forward, so its keys land there", () => {
    const subs = new Map<string, (p: unknown) => void>();
    const t = { send: () => {}, subscribe: (ch: string, fn: (p: unknown) => void) => (subs.set(ch, fn), () => subs.delete(ch)) };
    let s = reduce(initialState(), { type: "set_mode", mode: "advanced" });
    setTourHost({ getState: () => s, dispatch: (c) => { s = reduce(s, c); } });
    let raised = 0;
    const off = connectTours("main", t, { onStart: () => raised++ });
    subs.get("heeler:tour-start")!(ADD);
    expect(currentWalk()?.tour.id).toBe("keys");
    expect(raised).toBe(1);
    off();
  });

  it("Escape still stops the tour; an Escape the palette keeps closes only the palette", async () => {
    const user = userEvent.setup();
    await graphWithTour(user);
    press({ key: " ", code: "Space", shiftKey: true });
    expect(screen.getByTestId("node-palette")).toBeInTheDocument();
    // The palette's search has the focus and keeps its Escape.
    expect(document.activeElement).toBe(screen.getByTestId("palette-search"));
    press({ key: "Escape" });
    expect(screen.queryByTestId("node-palette")).not.toBeInTheDocument();
    expect(currentWalk()).not.toBeNull();
    // Then Escape on the canvas stops the tour.
    (document.activeElement as HTMLElement | null)?.blur();
    act(() => press({ key: "Escape" }));
    expect(currentWalk()).toBeNull();
    expect(endedTour()?.status).toBe("stopped");
  });

  it("typing in the end card's field triggers no shortcut", async () => {
    const user = userEvent.setup();
    await graphWithTour(user);
    act(() => tourStop());
    const field = screen.getByTestId("tour-follow-field");
    // Only the end card takes the focus, into its field.
    expect(document.activeElement).toBe(field);
    await user.type(field, "n");
    expect((field as HTMLInputElement).value).toBe("n");
    expect(screen.getByTestId("mode-advanced").getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByTestId("node-palette")).not.toBeInTheDocument();
  });
});

describe("the add-node step's words", () => {
  function hostFor(start: State) {
    let s = start;
    const host: TourHost = { getState: () => s, dispatch: (c) => { s = reduce(s, c); } };
    return { host, user: (c: Parameters<typeof reduce>[1]) => { s = reduce(s, c); } };
  }
  const graph = () => reduce(initialState(), { type: "set_mode", mode: "advanced" });

  it("name both ways, whatever the model wrote", async () => {
    for (const say of ["Press Shift+Space to add a node.", "Open the palette.", "Click the plus."]) {
      const { host } = hostFor(graph());
      const walk = new TourWalk({ ...ADD, steps: [{ stop: "graph.add", say }] }, host, () => null);
      const v = walk.view()!;
      expect(v.say).toBe(say);
      expect(v.how).toBe("Press Shift+Space or click the add node button (+ at the top of the graph's left toolbar).");
    }
    // Reached on the way to a node (the palette closed), the way words
    // say the same.
    const { host } = hostFor(graph());
    const walk = new TourWalk({ ...ADD, steps: [{ stop: "graph.add.recolor", say: "Add Recolor." }] }, host, () => null);
    expect(walk.view()!.way).toBe(true);
    expect(walk.view()!.say).toBe(`Open the node palette: ${addNodeWays(graph())}`);
    expect(walk.view()!.say).toMatch(/Shift\+Space or click the add node button/);
  });

  it("the node step completes however the node is added", () => {
    const recolor = NODE_CATALOG.find((n) => n.type === "heeler.recolor")!;
    // Through the palette, and without it (dropped in another way).
    for (const viaPalette of [true, false]) {
      const { host, user } = hostFor(graph());
      const walk = new TourWalk({ ...ADD, steps: [{ stop: "graph.add.recolor", say: "Add Recolor." }, { stop: "mode.develop", say: "Back to Develop." }] }, host, () => null);
      if (viaPalette) user({ type: "open_palette" });
      user({ type: "add_node", node: makeNode(recolor, "rc1", 200, 200) });
      if (viaPalette) user({ type: "close_palette" });
      walk.onState();
      expect(walk.view()!.stop.id).toBe("mode.develop");
    }
  });
});
