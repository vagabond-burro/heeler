// Several takes of one photograph, side by side.
//
// "Multi-view in the viewport. To be able to view up to 4
// versions at once of an image." And, on the naming: Takes, "a VFX term
// we used", to match the node graph's lineage.

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { initialState } from "../data";
import { MULTI_MAX, multiGrid, reduce, type Command, type State } from "../state";
import { MultiView } from "../ui/viewer";

const run = (s: State, ...cmds: Command[]) => cmds.reduce(reduce, s);
const compare = (takeId: string): Command => ({ type: "toggle_multi_take", takeId });

/** An image with four takes on it. */
function withTakes(): State {
  let s = initialState();
  for (const name of ["Warmer", "Cooler", "Punchy"]) {
    s = run(s, { type: "new_take", name, note: "" });
  }
  return s;
}

const takeIds = (s: State) => (s.takes[s.activeImage] ?? []).map((t) => t.id);

describe("choosing which takes to show", () => {
  it("shows one photograph until asked for a second", () => {
    expect(initialState().multiTakes).toEqual([]);
  });

  it("brings the active take along when the first comparison starts", () => {
    // Nobody means "show me take 3 on its own" by asking to compare.
    const s = withTakes();
    const ids = takeIds(s);
    const active = s.activeTakes[s.activeImage];
    const next = run(s, compare(ids[0]));
    expect(next.multiTakes).toContain(active);
    expect(next.multiTakes).toContain(ids[0]);
    expect(next.multiTakes.length).toBe(2);
  });

  it("stops at four", () => {
    // Each cell is a whole graph render, so a fifth costs a fifth of the
    // frame rate to show a quarter as much of each picture.
    let s = withTakes();
    for (const id of takeIds(s)) s = run(s, compare(id));
    expect(s.multiTakes.length).toBeLessThanOrEqual(MULTI_MAX);
    expect(MULTI_MAX).toBe(4);
  });

  it("dropping back to one take leaves the grid entirely", () => {
    const s = withTakes();
    const ids = takeIds(s);
    let next = run(s, compare(ids[0]));
    expect(next.multiTakes.length).toBe(2);
    // One cell in a grid of one is just the viewer with extra steps.
    next = run(next, compare(ids[0]));
    expect(next.multiTakes).toEqual([]);
  });

  it("toggles a take off without disturbing the others", () => {
    let s = withTakes();
    const ids = takeIds(s);
    s = run(s, compare(ids[0]), compare(ids[1]), compare(ids[2]));
    expect(s.multiTakes.length).toBe(4);
    s = run(s, compare(ids[1]));
    expect(s.multiTakes.length).toBe(3);
    expect(s.multiTakes).not.toContain(ids[1]);
  });

  it("clears in one go", () => {
    const s = run(withTakes(), compare(takeIds(withTakes())[0]), { type: "clear_multi_takes" });
    expect(s.multiTakes).toEqual([]);
  });
});

describe("how the cells are laid out", () => {
  it("puts two side by side rather than stacked", () => {
    // Frames are wider than they are tall, so stacking two wastes the
    // width that makes the comparison readable.
    expect(multiGrid(2)).toEqual({ cols: 2, rows: 1 });
  });

  it("puts three in a row rather than a square with a hole in it", () => {
    expect(multiGrid(3)).toEqual({ cols: 3, rows: 1 });
  });

  it("squares up at four", () => {
    expect(multiGrid(4)).toEqual({ cols: 2, rows: 2 });
  });

  it("is one cell for one, which is the plain viewer", () => {
    expect(multiGrid(1)).toEqual({ cols: 1, rows: 1 });
    expect(multiGrid(0)).toEqual({ cols: 1, rows: 1 });
  });
});

describe("the grid on screen", () => {
  const mount = (s: State, frames: Record<string, string> = {}) => {
    const sent: Command[] = [];
    render(
      <MultiView
        state={s}
        dispatch={((c: Command) => sent.push(c)) as never}
        frames={frames}
        activeFrame="data:image/png;base64,AAAA"
      />,
    );
    return sent;
  };

  it("draws a cell per take, named", () => {
    let s = withTakes();
    const ids = takeIds(s);
    s = run(s, compare(ids[0]));
    mount(s, { [ids[0]]: "data:image/png;base64,BBBB" });
    for (const id of s.multiTakes) {
      expect(screen.getByTestId(`multi-cell-${id}`)).toBeInTheDocument();
    }
    expect(screen.getByTestId("multi-view")).toHaveTextContent("Take 1");
  });

  it("marks the take being edited, so the sliders have an owner", () => {
    // Four near-identical frames with no mark give no clue which set of
    // controls you are moving.
    let s = withTakes();
    s = run(s, compare(takeIds(s)[0]));
    mount(s);
    const active = s.activeTakes[s.activeImage];
    expect(screen.getByTestId(`multi-cell-${active}`).dataset.active).toBe("true");
    const other = s.multiTakes.find((id) => id !== active)!;
    expect(screen.getByTestId(`multi-cell-${other}`).dataset.active).toBe("false");
  });

  it("says a cell is still rendering rather than showing the wrong take", () => {
    let s = withTakes();
    s = run(s, compare(takeIds(s)[0]));
    mount(s); // no frames yet for the non-active take
    const other = s.multiTakes.find((id) => id !== s.activeTakes[s.activeImage])!;
    expect(screen.getByTestId(`multi-pending-${other}`)).toBeInTheDocument();
    // The active take draws immediately: its frame is the one the normal
    // render pump already produced.
    const active = s.activeTakes[s.activeImage];
    expect(screen.queryByTestId(`multi-pending-${active}`)).not.toBeInTheDocument();
  });

  it("clicking a cell edits that take", () => {
    let s = withTakes();
    s = run(s, compare(takeIds(s)[0]));
    const sent = mount(s);
    const other = s.multiTakes.find((id) => id !== s.activeTakes[s.activeImage])!;
    fireEvent.click(screen.getByTestId(`multi-cell-${other}`));
    expect(sent).toEqual([{ type: "switch_take", takeId: other }]);
  });
});

describe("Takes, not Versions", () => {
  /// The owner asked which to keep and chose Takes: it matches the node
  /// graph's VFX lineage and it is the word he reached for unprompted.
  it("says Takes wherever it used to say Versions", async () => {
    const { Viewer } = await import("../ui/viewer");
    render(<Viewer state={initialState()} dispatch={() => {}} />);
    fireEvent.click(screen.getByTestId("takes-dropdown"));
    expect(screen.getByTestId("takes-list")).toBeInTheDocument();
    expect(screen.getByLabelText("New take")).toBeInTheDocument();
    // The default take is Take 1, not Version 1.
    expect(screen.getByTestId("takes-menu")).toHaveTextContent("Take 1");
    expect(screen.getByTestId("takes-menu")).not.toHaveTextContent(/version/i);
  });

  it("keeps reading the graph key it has always written", async () => {
    // The saved graph's `versions` / `activeVersion` keys are a file
    // format, not a label. Renaming them would orphan every take anybody
    // has already saved, so they stay exactly as they are.
    const { serializeGraph } = await import("../bridge");
    const s = run(withTakes());
    expect(serializeGraph(s)).toBeTruthy();
    expect(s.takes[s.activeImage]!.length).toBe(4);
  });
});

describe("naming and deleting takes", () => {
  /// "I created new takes but they are coming in as
  /// Version#." The rename caught every label on screen and missed the
  /// one place that MAKES a name, which is the only one that ends up on
  /// disk.
  it("names a new take Take, not Version", () => {
    let s = initialState();
    s = run(s, { type: "new_take" });
    const takes = s.takes[s.activeImage]!;
    expect(takes.map((t) => t.name)).toEqual(["Take 1", "Take 2"]);
    s = run(s, { type: "new_take" });
    expect(s.takes[s.activeImage]!.map((t) => t.name)).not.toContain("Version 3");
    // A name typed in is still used as typed.
    s = run(s, { type: "new_take", name: "Warmer" });
    const list = s.takes[s.activeImage]!;
    expect(list[list.length - 1].name).toBe("Warmer");
  });

  /// "Also missing a way to delete a take."
  it("deletes one that is not on screen without touching the graph", () => {
    let s = withTakes();
    const ids = takeIds(s);
    const before = s.nodes;
    s = run(s, { type: "switch_take", takeId: ids[0] });
    s = run(s, { type: "delete_take", takeId: ids[3] });
    expect(takeIds(s)).not.toContain(ids[3]);
    expect(s.activeTakes[s.activeImage]).toBe(ids[0]);
    expect(s.nodes.length).toBe(before.length);
  });

  it("brings up the one before it when the one on screen goes", () => {
    let s = withTakes();
    const ids = takeIds(s);
    // Take 4 is active after three new_takes; delete it.
    expect(s.activeTakes[s.activeImage]).toBe(ids[3]);
    s = run(s, { type: "delete_take", takeId: ids[3] });
    expect(s.activeTakes[s.activeImage]).toBe(ids[2]);
    // The graph on screen is that take's graph now.
    expect(s.nodes).toEqual(s.takes[s.activeImage]!.find((t) => t.id === ids[2])!.nodes);
    // And history went with the take it belonged to, rather than offering
    // to undo edits into a graph that no longer exists.
    expect(s.undoStack).toEqual([]);
  });

  it("refuses to delete the only take there is", () => {
    // A photograph always has at least one: the edit you are looking at is
    // one, it just may have no siblings.
    let s = run(initialState(), { type: "new_take" });
    const ids = takeIds(s);
    s = run(s, { type: "delete_take", takeId: ids[1] });
    expect(takeIds(s).length).toBe(1);
    const only = takeIds(s)[0];
    expect(run(s, { type: "delete_take", takeId: only })).toEqual(s);
  });

  it("stops comparing a take it has just deleted", () => {
    let s = withTakes();
    const ids = takeIds(s);
    s = run(s, compare(ids[0]), compare(ids[1]));
    expect(s.multiTakes.length).toBe(3);
    s = run(s, { type: "delete_take", takeId: ids[1] });
    expect(s.multiTakes).not.toContain(ids[1]);
    expect(s.multiTakes.length).toBe(2);
    // And dropping to one leaves the grid, same as toggling would.
    s = run(s, { type: "delete_take", takeId: s.multiTakes[0] });
    expect(s.multiTakes).toEqual([]);
  });

  it("asks before it does it, and says what survives", async () => {
    // History is per-take and switching clears it, so there is no undo
    // behind this one.
    const { confirmCopy } = await import("../ui/catalogui");
    const { promptsFor } = await import("../state");
    const action = { kind: "delete_take" as const, takeId: "take_2", name: "Warmer" };
    expect(promptsFor(action)).toBe(1);
    const copy = confirmCopy({ action, step: 1 });
    expect(copy.title).toMatch(/delete take/i);
    expect(copy.body).toContain("Warmer");
    expect(copy.body).toMatch(/photograph and your other takes are untouched/i);
    expect(copy.danger).toBe(true);
  });

  it("offers the button, except on the last take", async () => {
    const { Viewer } = await import("../ui/viewer");
    const sent: Command[] = [];
    const s = withTakes();
    const ids = takeIds(s);
    render(<Viewer state={s} dispatch={((c: Command) => sent.push(c)) as never} />);
    fireEvent.click(screen.getByTestId("takes-dropdown"));
    fireEvent.click(screen.getByTestId(`delete-take-${ids[1]}`));
    // Goes through the confirmation rather than deleting on the spot.
    expect(sent).toEqual([
      { type: "ask_confirm", action: { kind: "delete_take", takeId: ids[1], name: "Warmer" } },
    ]);
  });

  it("hides the button when there is only one take to lose", async () => {
    const { Viewer } = await import("../ui/viewer");
    render(<Viewer state={initialState()} dispatch={() => {}} />);
    fireEvent.click(screen.getByTestId("takes-dropdown"));
    expect(screen.queryByTestId("delete-take-take_1")).not.toBeInTheDocument();
  });

  it("the silenced confirmation skips straight to the deed, and only for takes", () => {
    // "There should be a 'Don't show this again' option for
    // the DELETE TAKE." The pref is the reducer's door: ask_confirm with
    // it off IS the delete, so every raise site obeys at once.
    let s = withTakes();
    const ids = takeIds(s);
    const asked = run(s, {
      type: "ask_confirm",
      action: { kind: "delete_take", takeId: ids[1], name: "Warmer" },
    });
    expect(asked.confirm).not.toBe(null);
    expect(takeIds(asked)).toContain(ids[1]);
    s = { ...s, prefs: { ...s.prefs, confirmDeleteTake: false } };
    const skipped = run(s, {
      type: "ask_confirm",
      action: { kind: "delete_take", takeId: ids[1], name: "Warmer" },
    });
    expect(skipped.confirm).toBe(null);
    expect(takeIds(skipped)).not.toContain(ids[1]);
    // Every other confirmation still asks, pref or no pref.
    const trash = run(s, {
      type: "ask_confirm",
      action: { kind: "trash_images", ids: [s.activeImage], names: ["x"] } as never,
    });
    expect(trash.confirm).not.toBe(null);
  });

  it("the dialog offers the silence tick on delete take only, and it sticks on OK", async () => {
    const { ConfirmDialog } = await import("../ui/catalogui");
    const sent: Command[] = [];
    const s = withTakes();
    const ids = takeIds(s);
    const asked = run(s, {
      type: "ask_confirm",
      action: { kind: "delete_take", takeId: ids[1], name: "Warmer" },
    });
    render(<ConfirmDialog state={asked} dispatch={((c: Command) => sent.push(c)) as never} />);
    fireEvent.click(screen.getByTestId("confirm-silence"));
    fireEvent.click(screen.getByTestId("confirm-ok"));
    expect(sent).toContainEqual({ type: "set_prefs", prefs: { confirmDeleteTake: false } });
    expect(sent).toContainEqual({ type: "delete_take", takeId: ids[1] });
  });

  it("a trash confirmation has no silence tick to offer", async () => {
    const { ConfirmDialog } = await import("../ui/catalogui");
    const s = run(initialState(), {
      type: "ask_confirm",
      action: { kind: "trash_images", ids: [initialState().activeImage], names: ["x"] } as never,
    });
    render(<ConfirmDialog state={s} dispatch={() => {}} />);
    expect(screen.queryByTestId("confirm-silence")).not.toBeInTheDocument();
  });
});
