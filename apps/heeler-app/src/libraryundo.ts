// Undo for the library: catalog changes that are not edits to a
// photograph, taken back by the same Undo and Redo as the edits.
//
// "Deleting a collection then undoing does not restore the collection."
// Undo was the photograph's history alone, and a collection is not part
// of any photograph: deleting one while looking at a photo, then Cmd+Z,
// took back that photo's last edit instead. A collection delete cannot simply be pushed onto the
// photograph's history either, since that history is per photograph
// and leaving the deleted collection usually lands on another one.
//
// So the library keeps its own steps (State.libraryUndo, libraryRedo)
// and Undo takes whichever happened last. Which that is, is decided by
// what the photographs' histories held when the library step was made:
// a history step that was already there is older than the delete, one
// that was not came after it. The steps themselves are compared by
// identity, so nothing in the history has to carry a clock.
//
// State carries only each step's number and words. What undoing it
// needs (the collection's name, look and members, which can run to
// thousands of ids) stays here, out of the state every change copies
// and the pop-outs are sent.

import { deleteCollection, restoreCollection, type DeletedCollection } from "./bridge";
import { logMsg } from "./log";
import type { Command, State } from "./state";
import { refreshLibrary } from "./ui/chrome";
import { leaveCollection, openCollection } from "./ui/collectionnav";

type D = (command: Command) => void;

interface CollectionDelete {
  collection: DeletedCollection;
  /** the collection was the one open when it went */
  open: boolean;
  /** the folder the library went back to, when it was open */
  back: string | null;
}

const steps = new Map<number, CollectionDelete>();
/** Every history step that existed when a library step was last done or
 * undone, by the library step's seq. */
const marks = new Map<number, WeakSet<object>>();
let nextSeq = 1;
/** A library step in flight: a second Cmd+Z waits for it rather than
 * restoring the same collection twice. */
let working = false;

/** Every step in every photograph's history, now. */
function historyNow(s: State): WeakSet<object> {
  const seen = new WeakSet<object>();
  const add = (list: readonly object[]) => {
    for (const x of list) seen.add(x);
  };
  add(s.undoStack);
  add(s.redoStack);
  for (const g of Object.values(s.graphs)) {
    add(g.undoStack);
    add(g.redoStack);
  }
  return seen;
}

/** Whether Undo takes the last library step rather than the open
 * photograph's last edit: there is one, and the edit (if any) was
 * already in the history when the library step was made. */
export function libraryUndoFirst(s: State): boolean {
  const top = s.libraryUndo[s.libraryUndo.length - 1];
  if (!top) return false;
  const edit = s.undoStack[s.undoStack.length - 1];
  if (!edit) return true;
  return marks.get(top.seq)?.has(edit) ?? true;
}

/** Redo's half: the last library step undone goes first unless an edit
 * was undone after it. */
export function libraryRedoFirst(s: State): boolean {
  const top = s.libraryRedo[s.libraryRedo.length - 1];
  if (!top) return false;
  const edit = s.redoStack[s.redoStack.length - 1];
  if (!edit) return true;
  return marks.get(top.seq)?.has(edit) ?? true;
}

export function canUndo(s: State): boolean {
  return s.undoStack.length > 0 || s.libraryUndo.length > 0;
}

export function canRedo(s: State): boolean {
  return s.redoStack.length > 0 || s.libraryRedo.length > 0;
}

/** Edit > Undo and its key. */
export function undo(s: State, dispatch: D): void {
  if (working) return;
  if (libraryUndoFirst(s)) void undoLibraryStep(s, dispatch);
  else dispatch({ type: "undo" });
}

/** Edit > Redo and its key. */
export function redo(s: State, dispatch: D): void {
  if (working) return;
  if (libraryRedoFirst(s)) void redoLibraryStep(s, dispatch);
  else dispatch({ type: "redo" });
}

function forget(seqs: number[]): void {
  for (const seq of seqs) {
    steps.delete(seq);
    marks.delete(seq);
  }
}

/** Deletes a collection the user has agreed to delete, as one step Undo
 * can take back. */
export async function deleteCollectionStep(
  s: State,
  dispatch: D,
  a: { id: number; name: string; open: boolean; back: string | null },
): Promise<void> {
  working = true;
  try {
    let collection: DeletedCollection;
    try {
      collection = await deleteCollection(a.id);
    } catch (e) {
      logMsg("error", `Could not delete the collection "${a.name}": ${String(e)}`);
      await refreshLibrary(dispatch);
      return;
    }
    // A new step leaves nothing to redo (library_step_done), so what
    // redoing needed goes with it.
    forget(s.libraryRedo.map((x) => x.seq));
    const seq = nextSeq++;
    steps.set(seq, { collection, open: a.open, back: a.back });
    marks.set(seq, historyNow(s));
    dispatch({ type: "library_step_done", step: { seq, label: `Delete collection "${collection.name}"` } });
    if (a.open) await leaveCollection(s, dispatch, a.back);
    await refreshLibrary(dispatch);
    logMsg("info", `Deleted the collection "${collection.name}". Its photographs are untouched, and Undo brings it back.`);
  } finally {
    working = false;
  }
}

async function undoLibraryStep(s: State, dispatch: D): Promise<void> {
  const top = s.libraryUndo[s.libraryUndo.length - 1];
  const step = top && steps.get(top.seq);
  if (!top || !step) return;
  working = true;
  try {
    let id: number;
    try {
      id = await restoreCollection(step.collection);
    } catch (e) {
      // Most likely a collection made since under the same name. The
      // step goes: left in place, every Cmd+Z after would fail on it and
      // never reach the edits beneath.
      logMsg("error", `Could not bring back the collection "${step.collection.name}": ${String(e)}`);
      drop(top.seq, dispatch);
      return;
    }
    // Redo deletes what came back, under the id it came back as.
    step.collection = { ...step.collection, id };
    marks.set(top.seq, historyNow(s));
    dispatch({ type: "library_step_undone", seq: top.seq });
    await refreshLibrary(dispatch);
    // It was open when it went: open again, where the delete took the
    // library from.
    if (step.open) await openCollection(id, step.collection.name, dispatch, s.prefs.thumbnailEdge);
    logMsg("info", `Brought back the collection "${step.collection.name}".`);
  } finally {
    working = false;
  }
}

/** A step that could not be undone or redone leaves both lists. */
function drop(seq: number, dispatch: D): void {
  forget([seq]);
  dispatch({ type: "library_step_dropped", seq });
}

async function redoLibraryStep(s: State, dispatch: D): Promise<void> {
  const top = s.libraryRedo[s.libraryRedo.length - 1];
  const step = top && steps.get(top.seq);
  if (!top || !step) return;
  working = true;
  try {
    const open = s.activeCollection === step.collection.id;
    let collection: DeletedCollection;
    try {
      collection = await deleteCollection(step.collection.id);
    } catch (e) {
      logMsg("error", `Could not delete the collection "${step.collection.name}" again: ${String(e)}`);
      drop(top.seq, dispatch);
      await refreshLibrary(dispatch);
      return;
    }
    // What it is now, renamed or added to since the undo included.
    steps.set(top.seq, { collection, open, back: step.back });
    marks.set(top.seq, historyNow(s));
    dispatch({ type: "library_step_redone", seq: top.seq });
    if (open) await leaveCollection(s, dispatch, step.back);
    await refreshLibrary(dispatch);
    logMsg("info", `Deleted the collection "${collection.name}" again.`);
  } finally {
    working = false;
  }
}

/** Test hook: the module's memory emptied between tests. */
export function resetLibraryUndo(): void {
  steps.clear();
  marks.clear();
  nextSeq = 1;
  working = false;
}
