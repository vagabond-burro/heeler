// The tour's card and the scroll before a step (2026-09-28: a step on
// Color > Treatment near the bottom of the Adjustments panel put the
// card at the bottom right, its NEXT, BACK and STOP row almost off the
// window), the step count ("When I clicked show me it
// started on step 3"), and the end card's follow-up field
// ("should be wider to support a field for typing in a follow up
// question").

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { initialState } from "../data";
import { mainConversion, reduce, type Command, type State } from "../state";
import { chatSnapshot, _resetAssistantChatForTests } from "../assistantchat";
import { placeCard, revealInScroller, scrollTargetFor, type Rect, type Reader } from "../tourgeometry";
import { resetToursForTests, setTourHost, startTourHere, tourStop, TourWalk, type Tour, type TourHost } from "../tourwalk";
import { END_W, nodesOf, TourOverlay } from "../ui/touroverlay";

afterEach(() => {
  cleanup();
  resetToursForTests();
  _resetAssistantChatForTests();
});

// -- the scroll before a step ------------------------------------------------------

describe("the scroll before a step", () => {
  it("centers a stop in the top or bottom fifth or off screen, and leaves one in the middle", () => {
    const panel = { scrollTop: 0, clientHeight: 400, scrollHeight: 1200 };
    // In the middle three fifths: left alone.
    expect(scrollTargetFor({ ...panel, top: 150, height: 20 })).toBeNull();
    // In the bottom fifth: moved so it sits near the middle.
    expect(scrollTargetFor({ ...panel, top: 360, height: 20 })).toBe(170);
    // Below the fold.
    expect(scrollTargetFor({ ...panel, top: 900, height: 20 })).toBe(710);
    // Above it, scrolled past: back up.
    expect(scrollTargetFor({ ...panel, scrollTop: 600, top: 100, height: 20 })).toBe(0);
    // Near the end of the content: as far as it scrolls, no further.
    expect(scrollTargetFor({ ...panel, top: 1180, height: 20 })).toBe(800);
  });

  it("measures a stop low in a zoomed panel from offsetTop chains and scrollTop, never client rects or scrollIntoView", () => {
    // The Adjustments panel at chrome zoom 1.25, 400 px tall inside,
    // scrolled to the top; Treatment 380 px down its content.
    const host = document.createElement("div");
    const panel = document.createElement("div");
    const row = document.createElement("div");
    panel.style.overflowY = "auto";
    panel.appendChild(row);
    host.appendChild(panel);
    document.body.appendChild(host);
    const def = (el: HTMLElement, props: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(props)) Object.defineProperty(el, k, { configurable: true, value: v, writable: true });
    };
    def(panel, { offsetTop: 50, offsetLeft: 0, offsetParent: null, clientHeight: 400, scrollHeight: 1200, scrollTop: 0, clientTop: 0, offsetHeight: 400 });
    def(row, { offsetTop: 380, offsetLeft: 0, offsetParent: panel, offsetHeight: 20, offsetWidth: 200 });
    const rects = vi.spyOn(Element.prototype, "getBoundingClientRect");
    const into = vi.fn();
    (Element.prototype as any).scrollIntoView = into;
    const zoomed: Reader = {
      style: (el) => ({ zoom: el === panel ? "1.25" : "1", transform: "none", transformOrigin: "0 0", position: "static" }),
    };
    revealInScroller(row, zoomed);
    // 380 + 20 / 2 - 400 / 2, in the panel's own units.
    expect(panel.scrollTop).toBe(190);
    expect(rects).not.toHaveBeenCalled();
    expect(into).not.toHaveBeenCalled();
    rects.mockRestore();
    delete (Element.prototype as any).scrollIntoView;
    host.remove();
  });
});

// -- where the card goes -----------------------------------------------------------

describe("where the card goes", () => {
  const view = { w: 1280, h: 800 };
  const card = { w: 300, h: 150 };
  const inside = (p: { left: number; top: number }, c = card, v = view, margin = 8) => {
    expect(p.left).toBeGreaterThanOrEqual(margin);
    expect(p.top).toBeGreaterThanOrEqual(margin);
    expect(p.left + c.w).toBeLessThanOrEqual(v.w - margin);
    expect(p.top + c.h).toBeLessThanOrEqual(v.h - margin);
  };
  const clear = (p: { left: number; top: number }, holes: Rect[], c = card) => {
    for (const h of holes) {
      const overlap = Math.min(p.left + c.w, h.x + h.w) > Math.max(p.left, h.x) && Math.min(p.top + c.h, h.y + h.h) > Math.max(p.top, h.y);
      expect(overlap).toBe(false);
    }
  };

  it("sits beside the hole where it fits", () => {
    const hole = { x: 400, y: 300, w: 120, h: 24 };
    const p = placeCard([hole], card, view, { gap: 12 });
    expect(p).toEqual({ left: 532, top: 300 });
  });

  it("flips to the left near the right edge, and slides up to stay inside near the bottom (the owner's Treatment)", () => {
    // Treatment in the right-hand panel, 30 px from the window's foot.
    const hole = { x: 1000, y: 740, w: 260, h: 24 };
    const p = placeCard([hole], card, view, { gap: 12 });
    expect(p.left).toBe(1000 - 12 - 300);
    inside(p);
    clear(p, [hole]);
  });

  it("flips above near the bottom edge when neither side has room", () => {
    const hole = { x: 100, y: 700, w: 1100, h: 40 };
    const p = placeCard([hole], card, view, { gap: 12 });
    expect(p.top).toBe(700 - 12 - 150);
    inside(p);
    clear(p, [hole]);
  });

  it("clamps inside the window when nothing else fits", () => {
    const small = { w: 360, h: 240 };
    const hole = { x: 0, y: 0, w: 360, h: 240 };
    const p = placeCard([hole], card, small, { gap: 12 });
    inside(p, card, small);
  });

  it("keeps the NEXT, BACK and STOP row inside the window wherever the stop is", () => {
    for (let x = 0; x < view.w; x += 80) {
      for (let y = 0; y < view.h; y += 50) {
        const hole = { x, y, w: 180, h: 28 };
        inside(placeCard([hole], card, view, { gap: 12 }));
      }
    }
  });

  it("keeps both ports of a wire uncovered, near the canvas edges too", () => {
    // Graph mode: an output port at the canvas's left edge and an input
    // port at its right edge, both low; the two holes' union spans the
    // window, so the places beside each port are tried.
    const holes = [
      { x: 2, y: 700, w: 14, h: 14 },
      { x: 1262, y: 90, w: 14, h: 14 },
    ];
    const p = placeCard(holes, card, view, { gap: 12 });
    inside(p);
    clear(p, holes);
    // A port hard in the bottom right corner, the other beside it.
    const corner = [
      { x: 1250, y: 770, w: 14, h: 14 },
      { x: 1180, y: 770, w: 14, h: 14 },
    ];
    const q = placeCard(corner, card, view, { gap: 12 });
    inside(q);
    clear(q, corner);
  });

  // 2026-09-29: "Connect the Image Source's output to the Luminance
  // Mask's input"; the card sat over the Luminance Mask node, whose
  // input port was spotlighted, "making it hard to see".
  const imageSource = { x: 300, y: 300, w: 150, h: 60 };
  const lumMask = { x: 520, y: 300, w: 150, h: 60 };
  const outPort = { x: 444, y: 324, w: 12, h: 12 };
  const inPort = { x: 514, y: 324, w: 12, h: 12 };

  it("a connect step with two nodes side by side: clear of both node cards and both ports", () => {
    const holes = [outPort, inPort];
    // Without the nodes to avoid, beside the ports it lands on the
    // Luminance Mask, as the owner saw.
    const before = placeCard(holes, card, view, { gap: 12 });
    const onMask = Math.min(before.left + card.w, lumMask.x + lumMask.w) > Math.max(before.left, lumMask.x) && Math.min(before.top + card.h, lumMask.y + lumMask.h) > Math.max(before.top, lumMask.y);
    expect(onMask).toBe(true);
    const p = placeCard(holes, card, view, { gap: 12, avoid: [imageSource, lumMask] });
    inside(p);
    clear(p, [...holes, imageSource, lumMask]);
  });

  it("a node near the canvas edge still gets a clear place", () => {
    // Hard against the left edge, low; and the bottom right corner.
    for (const [node, port] of [
      [{ x: 0, y: 700, w: 150, h: 60 }, { x: -6, y: 724, w: 12, h: 12 }],
      [{ x: 1120, y: 730, w: 150, h: 60 }, { x: 1264, y: 754, w: 12, h: 12 }],
      [{ x: 1120, y: 8, w: 150, h: 60 }, { x: 1114, y: 32, w: 12, h: 12 }],
    ] as [Rect, Rect][]) {
      const p = placeCard([port], card, view, { gap: 12, avoid: [node] });
      inside(p);
      clear(p, [port, node]);
    }
  });

  it("stays inside the window wherever the two nodes are, and never covers a port when a clear place exists", () => {
    for (let x = 0; x < view.w - 380; x += 90) {
      for (let y = 0; y < view.h - 60; y += 70) {
        const a = { x, y, w: 150, h: 60 };
        const b = { x: x + 220, y, w: 150, h: 60 };
        const holes = [
          { x: x + 144, y: y + 24, w: 12, h: 12 },
          { x: x + 214, y: y + 24, w: 12, h: 12 },
        ];
        const p = placeCard(holes, card, view, { gap: 12, avoid: [a, b] });
        inside(p);
        clear(p, [...holes, a, b]);
      }
    }
    // A window too small to clear the nodes: the ports stay uncovered,
    // the nodes the least covered.
    const small = { w: 720, h: 260 };
    const a = { x: 10, y: 40, w: 200, h: 180 };
    const b = { x: 300, y: 40, w: 200, h: 180 };
    const ports = [
      { x: 204, y: 120, w: 12, h: 12 },
      { x: 294, y: 120, w: 12, h: 12 },
    ];
    const q = placeCard(ports, card, small, { gap: 12, avoid: [a, b] });
    inside(q, card, small);
    clear(q, ports);
  });

  it("finds the node card that owns a spotlighted port, once per node", () => {
    document.body.innerHTML = `
      <div class="node" data-testid="node-a"><span data-testid="out-port-a"></span></div>
      <div class="node" data-testid="node-b"><span data-testid="in-port-b"></span><span data-testid="mask-in-port-b"></span></div>
      <div data-testid="palette-add"></div>`;
    const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
    expect(nodesOf([q("out-port-a"), q("in-port-b")]).map((e) => e.dataset.testid)).toEqual(["node-a", "node-b"]);
    expect(nodesOf([q("in-port-b"), q("mask-in-port-b")]).map((e) => e.dataset.testid)).toEqual(["node-b"]);
    // A node step's own card, and a stop outside the graph.
    expect(nodesOf([q("node-a")]).map((e) => e.dataset.testid)).toEqual(["node-a"]);
    expect(nodesOf([q("palette-add")])).toEqual([]);
    document.body.innerHTML = "";
  });
});

// -- the step count ----------------------------------------------------------------

function hostFor(start: State) {
  let s = start;
  const host: TourHost = { getState: () => s, dispatch: (c) => { s = reduce(s, c); } };
  const user = (...cmds: Command[]) => {
    for (const c of cmds) s = reduce(s, c);
  };
  return { host, user, state: () => s };
}

const SEVEN: Tour["steps"] = [
  { stop: "mode.develop", say: "Go to Develop." },
  { stop: "tab.adjust", say: "Open Adjustments." },
  { stop: "section.color", say: "Open the Color section." },
  { stop: "bw.treatment", say: "Choose black and white." },
  { stop: "bw.mix.red", say: "Raise Red." },
  { stop: "bw.mix.green", say: "Lower Green." },
  { stop: "bw.mix.blue", say: "Lower Blue." },
];
const tourOf = (steps: Tour["steps"]): Tour => ({ id: "count", question: "q", steps, followUps: [] });

describe("the step count", () => {
  it("leaves out the steps already done when the tour starts: Step 1 of 5, and no BACK to them", () => {
    // Develop and Adjustments are already where the user is.
    const { host } = hostFor(reduce(initialState(), { type: "close_sections", titles: ["Color"] }));
    const walk = new TourWalk(tourOf(SEVEN), host, () => null);
    expect(walk.skipped).toEqual([0, 1]);
    const v = walk.view()!;
    expect(v.stop.id).toBe("section.color");
    expect([v.number, v.total]).toEqual([1, 5]);
    expect(v.canBack).toBe(false);
    walk.back();
    expect(walk.view()!.stop.id).toBe("section.color");
  });

  it("a step done ahead of time mid-tour lowers the total without renumbering what was shown", () => {
    const { host, user, state } = hostFor(reduce(initialState(), { type: "close_sections", titles: ["Color"] }));
    const walk = new TourWalk(tourOf(SEVEN), host, () => null);
    let v = walk.view()!;
    expect([v.stop.id, v.number, v.total]).toEqual(["section.color", 1, 5]);
    // The user sets the Treatment before opening Color (a step ahead,
    // done on its own): this step keeps its number, the total drops.
    const bw = mainConversion(state().nodes)!;
    user({ type: "set_param", id: bw.id, param: "amount", value: 100 });
    walk.onState();
    v = walk.view()!;
    expect([v.stop.id, v.number, v.total]).toEqual(["section.color", 1, 4]);
    user({ type: "open_section", title: "Color" });
    walk.onState();
    v = walk.view()!;
    expect([v.stop.id, v.number, v.total, v.canBack]).toEqual(["bw.mix.red", 2, 4, true]);
    walk.next();
    v = walk.view()!;
    expect([v.stop.id, v.number, v.total]).toEqual(["bw.mix.green", 3, 4]);
    // BACK shows each step with the number it had, and passes over the
    // one never shown.
    walk.back();
    v = walk.view()!;
    expect([v.stop.id, v.number, v.total]).toEqual(["bw.mix.red", 2, 4]);
    walk.back();
    v = walk.view()!;
    expect([v.stop.id, v.number, v.total]).toEqual(["section.color", 1, 4]);
  });

  it("the card shows the count as the user counts", () => {
    const { host } = hostFor(reduce(initialState(), { type: "close_sections", titles: ["Color"] }));
    setTourHost(host);
    act(() => {
      startTourHere(tourOf(SEVEN));
    });
    render(<TourOverlay state={host.getState()} dispatch={host.dispatch} />);
    expect(screen.getByTestId("tour-count")).toHaveTextContent("STEP 1 OF 5");
    expect(screen.getByTestId("tour-back")).toBeDisabled();
  });
});

// -- the end card's follow-up field ------------------------------------------------

describe("the end card's follow-up field", () => {
  beforeEach(() => {
    (window as any).__TAURI_INTERNALS__ = { invoke: (name: string, args?: Record<string, unknown>) => invoke(name, args) };
    // The model is slow: a question asked stays asked.
    invoke.mockImplementation(async (name: string) => (name === "assistant_chat" ? new Promise(() => {}) : name === "list_docs" ? [] : null));
  });
  afterEach(() => {
    delete (window as any).__TAURI_INTERNALS__;
    invoke.mockReset();
  });

  function endCard(consoleWindowOpen: boolean) {
    let s: State = { ...reduce(initialState(), { type: "set_mode", mode: "advanced" }), consoleWindowOpen };
    const dispatched: Command[] = [];
    const dispatch = (c: Command) => {
      dispatched.push(c);
      s = reduce(s, c);
    };
    setTourHost({ getState: () => s, dispatch });
    const tour: Tour = { id: "end", question: "How do I go to Develop?", steps: [{ stop: "mode.develop", say: "Go to Develop." }], followUps: [] };
    act(() => {
      startTourHere(tour);
    });
    render(<TourOverlay state={s} dispatch={dispatch} />);
    act(() => tourStop());
    return { dispatched };
  }

  it("typing and Enter asks into the shared conversation with the tour as context, and opens the Console", () => {
    const { dispatched } = endCard(false);
    const field = screen.getByTestId("tour-follow-field");
    // Keyboard reachable: the field has the focus when the tour ends.
    expect(document.activeElement).toBe(field);
    fireEvent.change(field, { target: { value: "What does Canvas do?" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(chatSnapshot().turns[0]).toEqual({ role: "user", text: "What does Canvas do?" });
    expect(chatSnapshot().busy).toBe(true);
    expect(chatSnapshot().reveal).toBe(true);
    expect(dispatched).toContainEqual({ type: "set_console_window", open: true });
    // The card closes; the answer is the Console's.
    expect(screen.queryByTestId("tour-end")).toBeNull();
  });

  it("the cross in the top right corner closes the card, the arrow at the field's end asks, and the field spans the row", () => {
    endCard(true);
    const close = screen.getByTestId("tour-close");
    expect(close).toHaveAttribute("aria-label", "Close");
    expect(close.textContent).toBe("");
    expect(close.querySelector("svg")).not.toBeNull();
    expect(close.style.position).toBe("absolute");
    expect(close.style.top).toBe("6px");
    expect(close.style.right).toBe("6px");
    // One row: the field at the whole width, the ask icon inside its end,
    // and no word buttons beside it.
    const row = screen.getByTestId("tour-follow-row");
    const field = screen.getByTestId("tour-follow-field");
    const ask = screen.getByTestId("tour-follow-ask");
    expect(row.style.width).toBe("100%");
    expect(field.style.width).toBe("100%");
    expect(field.parentElement).toBe(row);
    expect(ask.parentElement).toBe(row);
    expect([...row.children]).toEqual([field, ask]);
    expect(ask).toHaveAttribute("aria-label", "Ask");
    expect(ask.textContent).toBe("");
    expect(ask.querySelector("svg")).not.toBeNull();
    expect(ask).toBeDisabled();
    fireEvent.change(field, { target: { value: "What does Canvas do?" } });
    fireEvent.click(ask);
    expect(chatSnapshot().turns[0]).toEqual({ role: "user", text: "What does Canvas do?" });
    expect(screen.queryByTestId("tour-end")).toBeNull();
  });

  it("the cross closes the card without asking anything", () => {
    endCard(true);
    fireEvent.click(screen.getByTestId("tour-close"));
    expect(screen.queryByTestId("tour-end")).toBeNull();
    expect(chatSnapshot().turns).toHaveLength(0);
  });

  it("Escape closes the end card", () => {
    endCard(true);
    fireEvent.keyDown(screen.getByTestId("tour-follow-field"), { key: "Escape" });
    expect(screen.queryByTestId("tour-end")).toBeNull();
  });

  it("the wider card stays inside the window, however narrow", () => {
    for (const [w, h] of [[1280, 800], [520, 360]]) {
      cleanup();
      resetToursForTests();
      Object.defineProperty(window, "innerWidth", { configurable: true, value: w });
      Object.defineProperty(window, "innerHeight", { configurable: true, value: h });
      endCard(false);
      const box = screen.getByTestId("tour-card-box");
      const left = parseFloat(box.style.left);
      const top = parseFloat(box.style.top);
      expect(parseFloat(box.style.width)).toBe(END_W);
      expect(left).toBeGreaterThanOrEqual(8);
      expect(left + END_W).toBeLessThanOrEqual(w - 8);
      expect(top).toBeGreaterThanOrEqual(8);
      expect(top + 150).toBeLessThanOrEqual(h - 8);
    }
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 768 });
  });
});
