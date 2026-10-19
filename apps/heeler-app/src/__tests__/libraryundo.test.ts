// The library's Undo below the panel: library steps against photo edits,
// one library action at a time, a newer navigation winning, and the
// memory a step keeps let go once the step is gone. From the
// independent review of 2026.5.4, whose probes these are.

import { beforeEach, describe, expect, it, vi } from "vitest";
import * as bridge from "../bridge";
import { initialState } from "../data";
import { canRedo, deleteCollectionStep, pruneLibrarySteps, redo, resetLibraryUndo, retainedLibrarySteps, undo } from "../libraryundo";
import { reduce, type Command, type State } from "../state";
import { beginNavigation } from "../ui/chromeparts";

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

/** restoreCollection held until released. */
function holdRestore() {
  const original = bridge.restoreCollection;
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const spy = vi.spyOn(bridge, "restoreCollection").mockImplementation(async (d) => {
    await held;
    return original(d);
  });
  return { spy, release };
}

describe("one library action at a time", () => {
  it("a delete during a restore does not let a second Undo start another", async () => {
    const r = setup();
    await deleted(r);
    const { spy, release } = holdRestore();
    undo(r.s, r.dispatch);
    const id = await bridge.createCollection("Other");
    const deleting = deleteCollectionStep(r.s, r.dispatch, { id, name: "Other", open: false, back: null });
    // Long enough for a delete that does not wait its turn to finish, and
    // in finishing clear the restore's claim.
    await settle();
    undo(r.s, r.dispatch);
    const calls = spy.mock.calls.length;
    release();
    await deleting;
    await settle();
    expect(calls).toBe(1);
    // The delete waited its turn and then happened.
    expect((await bridge.listCollections()).map((c) => c.name)).toEqual(["Picks"]);
  });

  it("two fast Undo presses restore once", async () => {
    const r = setup();
    await deleted(r);
    const spy = vi.spyOn(bridge, "restoreCollection");
    undo(r.s, r.dispatch);
    undo(r.s, r.dispatch);
    await settle();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("a newer navigation wins over a library step's way in or out", () => {
  it("Undo does not reopen the collection over a folder clicked during the restore", async () => {
    const r = setup();
    await deleted(r, "Picks", true);
    const { release } = holdRestore();
    undo(r.s, r.dispatch);
    beginNavigation();
    r.dispatch({ type: "set_library", label: "New folder", path: "/new", collection: null });
    release();
    await settle();
    expect(r.s.libraryLabel).toBe("New folder");
    expect(r.s.libraryUndo).toEqual([]);
    expect(r.s.libraryRedo).toHaveLength(1);
  });

  it("a delete does not leave over a folder clicked while it ran", async () => {
    const r = setup();
    const id = await bridge.createCollection("Picks");
    const original = bridge.deleteCollection;
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    vi.spyOn(bridge, "deleteCollection").mockImplementation(async (c) => {
      await held;
      return original(c);
    });
    const deleting = deleteCollectionStep(r.s, r.dispatch, { id, name: "Picks", open: true, back: null });
    beginNavigation();
    r.dispatch({ type: "set_library", label: "New folder", path: "/new", collection: null });
    release();
    await deleting;
    expect(r.s.libraryLabel).toBe("New folder");
    expect(r.s.libraryUndo).toHaveLength(1);
  });
});

describe("Redo's way out", () => {
  it("does not leave over a folder clicked while the delete ran again", async () => {
    const r = setup();
    await deleted(r, "Picks", true);
    undo(r.s, r.dispatch);
    await settle();
    expect(r.s.libraryLabel).toBe("Picks");
    const original = bridge.deleteCollection;
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    vi.spyOn(bridge, "deleteCollection").mockImplementation(async (c) => {
      await held;
      return original(c);
    });
    redo(r.s, r.dispatch);
    beginNavigation();
    r.dispatch({ type: "set_library", label: "New folder", path: "/new", collection: null });
    release();
    await settle();
    expect(r.s.libraryLabel).toBe("New folder");
    expect(r.s.libraryUndo).toHaveLength(1);
  });
});

describe("a step's undo data is let go with the step", () => {
  it("when a long history trims it", async () => {
    const r = setup();
    for (let i = 0; i < 101; i++) await deleted(r, `C${i}`);
    expect(r.s.libraryUndo).toHaveLength(100);
    pruneLibrarySteps(r.s);
    expect(retainedLibrarySteps()).toBe(100);
  });

  it("when a catalog switch drops the lists", async () => {
    const r = setup();
    await deleted(r);
    r.dispatch({ type: "begin_session_load" });
    pruneLibrarySteps(r.s);
    expect(retainedLibrarySteps()).toBe(0);
  });

  it("when a new edit ends its Redo, and not before", async () => {
    const r = setup();
    await deleted(r);
    undo(r.s, r.dispatch);
    await settle();
    pruneLibrarySteps(r.s);
    expect(retainedLibrarySteps()).toBe(1);
    edit(r);
    pruneLibrarySteps(r.s);
    expect(retainedLibrarySteps()).toBe(0);
  });

  it("the app prunes whenever the lists change", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const app = readFileSync(resolve(process.cwd(), "src/app.tsx"), "utf8");
    expect(app).toMatch(/pruneLibrarySteps\(state\);\s*\}, \[state\.libraryUndo, state\.libraryRedo\]\)/);
  });
});
