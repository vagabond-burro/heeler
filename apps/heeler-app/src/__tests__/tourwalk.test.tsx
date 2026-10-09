// Walking a guided tour (src/tourwalk.ts) over the real reducer: it
// advances on the completing change, goes back, skips a step already
// done, stops, opens the way to a stop as its own step, and never
// dispatches anything but a view command. The spotlight's position
// comes from offsets under a zoomed container (src/tourgeometry.ts).

import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { initialState } from "../data";
import { makeNode, NODE_CATALOG } from "../nodes";
import { mainConversion, reduce, type Command, type State } from "../state";
import { VIEW_COMMANDS } from "../tourstops";
import {
  currentWalk,
  endedTour,
  resetToursForTests,
  setTourHost,
  startTourHere,
  tourStateChanged,
  TourWalk,
  type Tour,
  type TourHost,
} from "../tourwalk";
import { effectiveZoom, measure, rectFromFrames, type Reader } from "../tourgeometry";
import { TourOverlay } from "../ui/touroverlay";

/** A host over the real reducer that records every command sent. */
function hostFor(start: State) {
  let s = start;
  const sent: Command[] = [];
  const host: TourHost = {
    getState: () => s,
    dispatch: (c) => {
      sent.push(c);
      s = reduce(s, c);
    },
  };
  /** The user doing something: through the reducer, not recorded. */
  const user = (...cmds: Command[]) => {
    for (const c of cmds) s = reduce(s, c);
  };
  return { host, sent, user, state: () => s };
}

const tour = (steps: Tour["steps"]): Tour => ({ id: "t1", question: "q", steps, followUps: [] });

const BW: Tour["steps"] = [
  { stop: "section.color", say: "Open the Color section." },
  { stop: "bw.treatment", say: "Choose black and white." },
  { stop: "bw.mix.blue", say: "Lower Blue to darken the sky." },
];

afterEach(() => resetToursForTests());

describe("walking a tour", () => {
  it("opens the way first, as its own step, and only with view commands", () => {
    const start = reduce(reduce(initialState(), { type: "set_mode", mode: "advanced" }), { type: "close_sections", titles: ["Color"] });
    const { host, sent } = hostFor(start);
    const walk = new TourWalk(tour(BW), host, () => null);
    // Graph mode: the first thing shown is the way to Develop.
    let v = walk.view()!;
    expect(v.way).toBe(true);
    expect(v.stop.id).toBe("mode.develop");
    walk.next(); // OPEN: set_mode
    v = walk.view()!;
    // Adjustments is already the tab, so the Color section's own step:
    // it is folded, so this is the step itself, not a way to it.
    expect(v.way).toBe(false);
    expect(v.stop.id).toBe("section.color");
    expect(sent.map((c) => c.type)).toEqual(["set_mode"]);
    for (const c of sent) expect(VIEW_COMMANDS.has(c.type)).toBe(true);
  });

  it("advances on the completing change, skips a step already done, goes back and stops", () => {
    const start = initialState();
    const { host, user, sent, state } = hostFor(reduce(start, { type: "close_sections", titles: ["Color"] }));
    const walk = new TourWalk(tour(BW), host, () => null);
    expect(walk.view()!.stop.id).toBe("section.color");
    // Nothing done yet: pressing nothing, the step stays.
    walk.onState();
    expect(walk.index).toBe(0);
    user({ type: "open_section", title: "Color" });
    walk.onState();
    expect(walk.view()!.stop.id).toBe("bw.treatment");
    const bw = mainConversion(state().nodes)!;
    user({ type: "set_param", id: bw.id, param: "amount", value: 100 });
    walk.onState();
    expect(walk.view()!.stop.id).toBe("bw.mix.blue");
    // BACK to a step already done: it waits rather than skipping ahead.
    walk.back();
    expect(walk.view()!.stop.id).toBe("bw.treatment");
    walk.onState();
    expect(walk.view()!.stop.id).toBe("bw.treatment");
    walk.next();
    expect(walk.view()!.stop.id).toBe("bw.mix.blue");
    user({ type: "set_param", id: bw.id, param: "blue", value: -20 });
    walk.onState();
    expect(walk.status).toBe("finished");
    // The user did every edit; the tour sent none.
    expect(sent).toEqual([]);
  });

  it("skips steps already done when it reaches them", () => {
    const s0 = initialState();
    const bw = mainConversion(s0.nodes)!;
    const done = reduce(reduce(s0, { type: "open_section", title: "Color" }), { type: "set_param", id: bw.id, param: "amount", value: 100 });
    const { host } = hostFor(done);
    const walk = new TourWalk(tour(BW), host, () => null);
    expect(walk.skipped).toEqual([0, 1]);
    expect(walk.view()!.stop.id).toBe("bw.mix.blue");
  });

  it("STOP ends it, and Escape does through the overlay", () => {
    const { host } = hostFor(initialState());
    const walk = new TourWalk(tour(BW), host, () => null);
    walk.stop();
    expect(walk.status).toBe("stopped");
    expect(walk.view()).toBeNull();

    const h = hostFor(reduce(initialState(), { type: "close_sections", titles: ["Color"] }));
    setTourHost(h.host);
    render(<TourOverlay state={h.state()} dispatch={() => {}} />);
    act(() => {
      startTourHere(tour(BW));
    });
    expect(screen.getByTestId("tour-say").textContent).toBe("Open the Color section.");
    expect(screen.getByTestId("tour-say").getAttribute("aria-live")).toBe("polite");
    // The three controls are buttons, reachable by Tab.
    for (const id of ["tour-next", "tour-back", "tour-stop"]) expect(screen.getByTestId(id).tagName).toBe("BUTTON");
    act(() => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    expect(currentWalk()).toBeNull();
    expect(endedTour()?.status).toBe("stopped");
  });

  it("a click stop completes on a click on its own element, not elsewhere", () => {
    const { host } = hostFor(reduce(initialState(), { type: "toggle_export" }));
    const doc = document.implementation.createHTMLDocument("t");
    doc.body.innerHTML = `<button data-testid="export-run"><span id="inner">EXPORT</span></button><button id="other"></button>`;
    const walk = new TourWalk(tour([{ stop: "export.run", say: "Export." }]), host, () => doc);
    walk.onClick(doc.getElementById("other"));
    expect(walk.status).toBe("running");
    walk.onClick(doc.getElementById("inner"));
    expect(walk.status).toBe("finished");
  });

  it("a connect step waits for the wire between the two ports, then finishes", () => {
    let s = reduce(initialState(), { type: "set_mode", mode: "advanced" });
    const spec = (t: string) => NODE_CATALOG.find((n) => n.type === t)!;
    s = reduce(s, { type: "add_node", node: makeNode(spec("heeler.channel_extract"), "ch1", 100, 400) });
    s = reduce(s, { type: "add_node", node: makeNode(spec("heeler.blur"), "bl1", 300, 400) });
    const { host, user, sent } = hostFor(s);
    const walk = new TourWalk(
      tour([{ stop: "graph.connect", from: "port.channel_extract.mask-out", to: "port.blur.mask", say: "Drag the Channel's output to Blur's mask." }]),
      host,
      () => null,
    );
    const v = walk.view()!;
    expect(v.stop.target(s, v.refs)).toEqual(['[data-testid="mask-port-ch1"]', '[data-testid="mask-in-port-bl1"]']);
    walk.onState();
    expect(walk.status).toBe("running");
    user({ type: "connect", wire: { from: "ch1", to: "bl1", toPort: "mask", kind: "mask" } });
    walk.onState();
    expect(walk.status).toBe("finished");
    expect(sent).toEqual([]);
  });

  it("an add step completes when the node lands, though the palette it was picked from has closed", () => {
    const s = reduce(initialState(), { type: "set_mode", mode: "advanced" });
    const { host, user, sent } = hostFor(s);
    const walk = new TourWalk(tour([{ stop: "graph.add.channel_extract", say: "Add a Channel." }, { stop: "graph.inspector", say: "Its controls." }]), host, () => null);
    // The palette is a place on the way: OPEN opens it, a view command.
    expect(walk.view()!.way).toBe(true);
    walk.next();
    expect(sent).toEqual([{ type: "open_palette", x: 260, y: 180 }]);
    expect(walk.view()!.stop.id).toBe("graph.add.channel_extract");
    // Picking the node adds it and closes the palette in the same breath.
    user({ type: "add_node", node: makeNode(NODE_CATALOG.find((n) => n.type === "heeler.channel_extract")!, "c1", 100, 100) });
    user({ type: "close_palette" });
    walk.onState();
    expect(walk.view()!.stop.id).toBe("graph.inspector");
  });

  it("the main window's walk follows state changes and reports its end", () => {
    const h = hostFor(reduce(initialState(), { type: "close_sections", titles: ["Color"] }));
    setTourHost(h.host);
    startTourHere(tour([{ stop: "section.color", say: "Open Color." }]));
    expect(currentWalk()).not.toBeNull();
    h.user({ type: "open_section", title: "Color" });
    tourStateChanged();
    expect(currentWalk()).toBeNull();
    expect(endedTour()?.status).toBe("finished");
  });
});

describe("the spotlight's place", () => {
  it("carries a box up through zoom, scroll and a transform", () => {
    // A 20 by 10 box, 30 px down a list scrolled 12 px, in a panel
    // zoomed 1.15 at x 100, all under a layer translated by (5, 7).
    const z = 1.15;
    const r = rectFromFrames(
      [
        { x: 0, y: 30 * z, scrollX: 0, scrollY: 0, matrix: null, origin: [0, 0] },
        { x: 0, y: 0, scrollX: 0, scrollY: 12 * z, matrix: null, origin: [0, 0] },
        { x: 100, y: 40, scrollX: 0, scrollY: 0, matrix: [1, 0, 0, 1, 5, 7], origin: [0, 0] },
      ],
      20 * z,
      10 * z,
    );
    expect(r.x).toBeCloseTo(105);
    expect(r.y).toBeCloseTo(40 + 7 + (30 - 12) * z);
    expect(r.w).toBeCloseTo(23);
    expect(r.h).toBeCloseTo(11.5);
  });

  it("measures elements from offsets, each scaled by its effective zoom, never by client rects", () => {
    // jsdom lays nothing out, so the offsets are given: a fixed panel
    // with zoom 1.15 at (200, 50) in its own units, holding a scroller
    // scrolled 40, holding a row 100 down, 12 in. Every offset is in
    // its element's zoomed units, the panel's own included.
    document.body.innerHTML = `<div id="panel"><div id="list"><div id="row"></div></div></div>`;
    const panel = document.getElementById("panel")!;
    const list = document.getElementById("list")!;
    const row = document.getElementById("row")!;
    const set = (el: HTMLElement, props: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(props)) Object.defineProperty(el, k, { configurable: true, value: v });
    };
    set(panel, { offsetLeft: 200, offsetTop: 50, offsetParent: null, offsetWidth: 300, offsetHeight: 600 });
    set(list, { offsetLeft: 0, offsetTop: 0, offsetParent: panel, scrollTop: 40, offsetWidth: 300, offsetHeight: 600 });
    set(row, { offsetLeft: 12, offsetTop: 100, offsetParent: panel, offsetWidth: 80, offsetHeight: 20 });
    // No client rect is ever read.
    for (const el of [panel, list, row]) el.getBoundingClientRect = () => { throw new Error("client rects are not used"); };
    const styles = new Map<Element, string>([[panel, "1.15"]]);
    const read: Reader = {
      style: (el) => ({ zoom: styles.get(el) ?? "1", transform: "none", transformOrigin: "0px 0px", position: el === panel ? "fixed" : "static" }),
    };
    expect(effectiveZoom(row, read)).toBeCloseTo(1.15);
    const r = measure(row, read);
    expect(r.x).toBeCloseTo((200 + 12) * 1.15);
    expect(r.y).toBeCloseTo((50 + 100 - 40) * 1.15);
    expect(r.w).toBeCloseTo(80 * 1.15);
    expect(r.h).toBeCloseTo(20 * 1.15);
  });
});
