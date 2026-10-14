// The library's Undo below the panel: library steps against photo edits,
// one library action at a time, a newer navigation winning, and the
// memory a step keeps let go once the step is gone. From the
// independent review of 2026.5.4, whose probes these are.

import { beforeEach, describe, expect, it, vi } from "vitest";
import * as bridge from "../bridge";
import { initialState } from "../data";
import { canRedo, deleteCollectionStep, redo, resetLibraryUndo, undo } from "../libraryundo";
import { reduce, type Command, type State } from "../state";

beforeEach(() => {
  vi.restoreAllMocks();
  bridge.mockResetCollections();
  resetLibraryUndo();
});

/** The app's dispatch without React: commands run through reduce. */
function setup() {
  let s: State = initialState();
  const sent: Command[] = [];
  return {
    get s() {
      return s;
    },
    dispatch(c: Command) {
      sent.push(c);
      s = reduce(s, c);
    },
    sent,
  };
}
type Rig = ReturnType<typeof setup>;

const settle = async () => {
  for (let i = 0; i < 80; i++) await Promise.resolve();
};

/** A photo edit: Exposure up a little. */
function edit(r: Rig) {
  const n = r.s.nodes.find((n) => "exposure" in n.params)!;
  r.dispatch({ type: "set_param", id: n.id, param: "exposure", value: n.params.exposure + 0.1 });
}

async function deleted(r: Rig, name = "Picks", open = false) {
  const id = await bridge.createCollection(name);
  await deleteCollectionStep(r.s, r.dispatch, { id, name, open, back: null });
  return id;
}

describe("a new edit ends library Redo", () => {
  it("after an Undo of a delete", async () => {
    const r = setup();
    await deleted(r);
    undo(r.s, r.dispatch);
    await settle();
    expect(canRedo(r.s)).toBe(true);
    edit(r);
    expect(canRedo(r.s)).toBe(false);
  });

  it("after undoing past the delete into the edits before it", async () => {
    const r = setup();
    edit(r);
    await deleted(r);
    undo(r.s, r.dispatch);
    await settle();
    undo(r.s, r.dispatch);
    edit(r);
    expect(canRedo(r.s)).toBe(false);
  });

  it("but Undo, Redo and a photo switch do not end it", async () => {
    const r = setup();
    edit(r);
    await deleted(r);
    undo(r.s, r.dispatch);
    await settle();
    // Undo the edit too, then Redo it: library Redo is still there.
    undo(r.s, r.dispatch);
    expect(r.s.libraryRedo).toHaveLength(1);
    redo(r.s, r.dispatch);
    expect(r.s.libraryRedo).toHaveLength(1);
    const other = r.s.images.find((i) => i.id !== r.s.activeImage)!.id;
    r.dispatch({ type: "select_image", id: other });
    expect(r.s.libraryRedo).toHaveLength(1);
  });
});
