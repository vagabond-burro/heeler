// Section looks (2026-09-30): pointing at a look in the menu shows it on
// the photograph and nothing is kept; a click applies one as one undo
// step. These tests make the state they assert on and nothing else.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useEffect, useReducer } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { serializeGraph } from "../bridge";
import { initialState } from "../data";
import { RECOLOR_CELLS, TONE_EQ_DOMAIN } from "../eqcurve";
import { lookById, looksFor, SECTION_LOOKS } from "../sectionlooks";
import { lookPreviewState, reduce, type Command, type State } from "../state";
import { LOOK_HOVER_MS, SectionLooks } from "../ui/sectionlooks";

afterEach(() => {
  cleanup();
});

const run = (s: State, ...cmds: Command[]) => cmds.reduce(reduce, s);
const node = (s: State, id: string) => s.nodes.find((n) => n.id === id);
const hold = (id: string): Command => ({ type: "preview_section_look", id });

/** A fresh photograph's graph (the demo session's sample graph keeps
 * Relight's and Recolor's cards, switched off; a new photograph has
 * neither). */
function fresh(): State {
  const s = initialState();
  return { ...s, nodes: structuredClone(s.defaultGraph.nodes), wires: structuredClone(s.defaultGraph.wires) };
}

describe("the looks, as data", () => {
  it("four for Relight and six for Recolor, two of them reading depth", () => {
    expect(looksFor("Relight")).toHaveLength(4);
    expect(looksFor("Recolor")).toHaveLength(6);
    expect(SECTION_LOOKS.filter((l) => l.depth).map((l) => l.id)).toEqual(["recolor-cool-distance", "recolor-warm-subject"]);
    expect(new Set(SECTION_LOOKS.map((l) => l.id)).size).toBe(SECTION_LOOKS.length);
  });

  it("every number sits inside what the engine reads", () => {
    const cells = new Set<string>(RECOLOR_CELLS.map((c) => c.id));
    for (const look of SECTION_LOOKS) {
      if (look.section === "Relight") {
        for (const p of JSON.parse(look.text.points) as { x: number; y: number }[]) {
          expect(p.x).toBeGreaterThanOrEqual(TONE_EQ_DOMAIN[0]);
          expect(p.x).toBeLessThanOrEqual(TONE_EQ_DOMAIN[1]);
          expect(Math.abs(p.y)).toBeLessThanOrEqual(2);
        }
        continue;
      }
      const curves = JSON.parse(look.text.curves) as Record<string, { x: number; y: number }[]>;
      for (const [cell, pts] of Object.entries(curves)) {
        expect(cells.has(cell), `${look.id}: ${cell} is a Recolor cell`).toBe(true);
        const adjust = cell.split("_")[1];
        const reach = adjust === "hue" ? 60 : adjust === "lum" ? 2 : 100;
        for (const p of pts) expect(Math.abs(p.y), `${look.id} ${cell}`).toBeLessThanOrEqual(reach);
      }
    }
  });
});

describe("a Pro copy's look", () => {
  it("applies as one undo step, and undo takes it all back", () => {
    const s = run(fresh(), { type: "set_param", id: "exposure", param: "exposure", value: 0.5 });
    const look = lookById("recolor-teal-orange")!;
    const applied = run(s, { type: "apply_section_look", id: look.id });
    expect(applied.undoStack.length).toBe(s.undoStack.length + 1);
    const rc = node(applied, "recolor");
    expect(rc?.enabled).toBe(true);
    expect(rc?.textParams?.curves).toBe(look.text.curves);
    // Exactly what a free copy's hold rendered.
    const shown = lookPreviewState(run(s, hold(look.id)));
    expect(JSON.stringify(serializeGraph({ ...applied, lookPreview: null }))).toBe(JSON.stringify(serializeGraph(shown)));
    const undone = run(applied, { type: "undo" });
    expect(undone.nodes).toEqual(s.nodes);
    expect(undone.wires).toEqual(s.wires);
  });

  it("replaces what the section held rather than blending into it", () => {
    const s = run(
      fresh(),
      { type: "set_category", title: "Relight", on: true },
      { type: "set_param", id: "toneeq", param: "range_shift", value: 2 },
    );
    const applied = run(s, { type: "apply_section_look", id: "relight-tame-highlights" });
    expect(node(applied, "toneeq")?.params.range_shift).toBe(0);
    expect(node(applied, "toneeq")?.textParams?.points).toBe(lookById("relight-tame-highlights")!.text.points);
  });
});

describe("every look previews exactly what applying it makes", () => {
  it("the graph the viewer is sent equals the graph a Pro apply writes, look by look", () => {
    for (const look of SECTION_LOOKS) {
      const s = run(fresh(), { type: "set_param", id: "exposure", param: "exposure", value: 0.5 });
      const applied = run(s, { type: "apply_section_look", id: look.id });
      const shown = lookPreviewState(run(s, hold(look.id)));
      expect(JSON.stringify(serializeGraph(shown)), look.id).toBe(JSON.stringify(serializeGraph({ ...applied, lookPreview: null })));
    }
  });
});

/** The menu under a real reducer, with the latest state kept outside
 * and every command it sent counted. */
function Harness({
  section,
  onState,
  sent,
}: {
  section: "Relight" | "Recolor";
  onState: (s: State) => void;
  sent: Command[];
}) {
  const [state, dispatch] = useReducer(reduce, undefined, fresh);
  useEffect(() => {
    onState(state);
  }, [state, onState]);
  const counted = (cmd: Command) => {
    sent.push(cmd);
    dispatch(cmd);
  };
  return <SectionLooks section={section} state={state} dispatch={counted} />;
}

function mount(section: "Relight" | "Recolor" = "Relight") {
  const seen: { s: State | null } = { s: null };
  const sent: Command[] = [];
  const view = render(<Harness section={section} onState={(s) => (seen.s = s)} sent={sent} />);
  return { seen, view, sent };
}

const slugOf = (section: "Relight" | "Recolor") => section.toLowerCase();
const openMenu = (section: "Relight" | "Recolor" = "Relight") =>
  fireEvent.click(screen.getByTestId(`looks-${slugOf(section)}-menu`));
const row = (id: string, section: "Relight" | "Recolor" = "Relight") =>
  screen.getByTestId(`looks-${slugOf(section)}-menu-option-${id}`);
/** The parts of the state an edit, a save or a Take would read. */
const kept = (s: State) => ({
  nodes: s.nodes,
  wires: s.wires,
  undoStack: s.undoStack,
  redoStack: s.redoStack,
  takes: s.takes,
  graphs: s.graphs,
  images: s.images,
  renderVersion: s.renderVersion,
});
const previews = (sent: Command[]) =>
  sent.filter((c): c is Extract<Command, { type: "preview_section_look" }> => c.type === "preview_section_look").map((c) => c.id);

describe("the looks menu", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a Pro copy shows the same menu, no buttons and no Pro line", () => {
    mount();
    expect(screen.getByTestId("looks-relight-menu")).toBeInTheDocument();
    expect(screen.queryByTestId("look-relight-low-key")).toBeNull();
    expect(screen.queryByTestId("looks-relight-line")).toBeNull();
    openMenu();
    expect(row("relight-low-key").getAttribute("data-hint")).toMatch(/Click to apply it as one undo step$/);
  });

  it("pointing previews a row, the next row replaces it, closing restores the exact state", () => {
    vi.useFakeTimers();
    const { seen } = mount();
    const before = kept(seen.s!);
    const beforeJson = JSON.stringify(serializeGraph(seen.s!));
    openMenu();
    fireEvent.mouseEnter(row("relight-low-key"));
    act(() => vi.advanceTimersByTime(LOOK_HOVER_MS));
    expect(seen.s!.lookPreview).toBe("relight-low-key");
    fireEvent.mouseEnter(row("relight-open-shadows"));
    act(() => vi.advanceTimersByTime(LOOK_HOVER_MS));
    expect(seen.s!.lookPreview).toBe("relight-open-shadows");
    // The pointer leaving the list is not a close: the last row stays.
    fireEvent.mouseLeave(screen.getByTestId("looks-relight-menu-menu"));
    act(() => vi.advanceTimersByTime(500));
    expect(seen.s!.lookPreview).toBe("relight-open-shadows");
    // Escape closes, and the photograph is what it was.
    fireEvent.keyDown(row("relight-open-shadows"), { key: "Escape" });
    expect(screen.queryByTestId("looks-relight-menu-menu")).toBeNull();
    expect(seen.s!.lookPreview).toBeNull();
    expect(kept(seen.s!)).toEqual(before);
    expect(seen.s!.nodes).toBe(before.nodes);
    expect(seen.s!.undoStack).toBe(before.undoStack);
    expect(JSON.stringify(serializeGraph(seen.s!))).toBe(beforeJson);
  });

  it("a click outside closes and restores", () => {
    vi.useFakeTimers();
    const { seen } = mount("Recolor");
    const before = kept(seen.s!);
    openMenu("Recolor");
    fireEvent.mouseEnter(row("recolor-autumn", "Recolor"));
    act(() => vi.advanceTimersByTime(LOOK_HOVER_MS));
    expect(seen.s!.lookPreview).toBe("recolor-autumn");
    fireEvent.mouseDown(document.body);
    expect(screen.queryByTestId("looks-recolor-menu-menu")).toBeNull();
    expect(seen.s!.lookPreview).toBeNull();
    expect(kept(seen.s!)).toEqual(before);
  });

  it("sweeping the pointer down the list shows only the row it stops on", () => {
    vi.useFakeTimers();
    const { seen, sent } = mount("Recolor");
    openMenu("Recolor");
    for (const look of looksFor("Recolor").filter((l) => !l.depth)) {
      fireEvent.mouseEnter(row(look.id, "Recolor"));
      act(() => vi.advanceTimersByTime(20));
    }
    act(() => vi.advanceTimersByTime(LOOK_HOVER_MS));
    expect(previews(sent)).toEqual(["recolor-deep-skies"]);
    expect(seen.s!.lookPreview).toBe("recolor-deep-skies");
  });

  it("a close before the rest is up shows nothing at all", () => {
    vi.useFakeTimers();
    const { seen, sent } = mount();
    openMenu();
    fireEvent.mouseEnter(row("relight-low-key"));
    fireEvent.keyDown(row("relight-low-key"), { key: "Escape" });
    act(() => vi.advanceTimersByTime(LOOK_HOVER_MS * 3));
    expect(previews(sent)).toEqual([]);
    expect(seen.s!.lookPreview).toBeNull();
  });

  it("the keyboard previews too: the arrows walk the rows, Escape puts the photograph back", () => {
    vi.useFakeTimers();
    const { seen } = mount();
    const field = screen.getByTestId("looks-relight-menu");
    fireEvent.keyDown(field, { key: "ArrowDown" });
    act(() => vi.advanceTimersByTime(LOOK_HOVER_MS));
    const first = looksFor("Relight")[0].id;
    expect(document.activeElement).toBe(row(first));
    expect(seen.s!.lookPreview).toBe(first);
    fireEvent.keyDown(row(first), { key: "ArrowDown" });
    act(() => vi.advanceTimersByTime(LOOK_HOVER_MS));
    expect(seen.s!.lookPreview).toBe(looksFor("Relight")[1].id);
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(seen.s!.lookPreview).toBeNull();
    expect(document.activeElement).toBe(field);
  });

  it("a Pro click applies the look as one undo step and closes the menu", () => {
    vi.useFakeTimers();
    const { seen } = mount();
    const undoBefore = seen.s!.undoStack.length;
    openMenu();
    fireEvent.mouseEnter(row("relight-low-key"));
    act(() => vi.advanceTimersByTime(LOOK_HOVER_MS));
    fireEvent.click(row("relight-low-key"));
    expect(screen.queryByTestId("looks-relight-menu-menu")).toBeNull();
    expect(seen.s!.lookPreview).toBeNull();
    expect(seen.s!.undoStack).toHaveLength(undoBefore + 1);
    expect(node(seen.s!, "toneeq")?.textParams?.points).toBe(lookById("relight-low-key")!.text.points);
    // One undo takes it all back.
    const undone = reduce(seen.s!, { type: "undo" });
    expect(node(undone, "toneeq")).toBeUndefined();
  });

  it("the window losing focus takes the look back; the menu leaving the screen does too", () => {
    vi.useFakeTimers();
    const { seen, view } = mount();
    openMenu();
    fireEvent.mouseEnter(row("relight-even-light"));
    act(() => vi.advanceTimersByTime(LOOK_HOVER_MS));
    expect(seen.s!.lookPreview).toBe("relight-even-light");
    act(() => {
      fireEvent.blur(window);
    });
    expect(seen.s!.lookPreview).toBeNull();
    fireEvent.mouseEnter(row("relight-low-key"));
    act(() => vi.advanceTimersByTime(LOOK_HOVER_MS));
    expect(seen.s!.lookPreview).toBe("relight-low-key");
    let latest: State | null = null;
    let setShown: (v: boolean) => void = () => {};
    view.unmount();
    function Outer() {
      const [state, dispatch] = useReducer(reduce, undefined, fresh);
      const [shown, set] = useReducer((_: boolean, v: boolean) => v, true);
      setShown = set;
      latest = state;
      return shown ? <SectionLooks section="Relight" state={state} dispatch={dispatch} /> : null;
    }
    render(<Outer />);
    fireEvent.click(screen.getByTestId("looks-relight-menu"));
    fireEvent.mouseEnter(row("relight-low-key"));
    act(() => vi.advanceTimersByTime(LOOK_HOVER_MS));
    expect(latest!.lookPreview).toBe("relight-low-key");
    act(() => setShown(false));
    expect(latest!.lookPreview).toBeNull();
  });
});
