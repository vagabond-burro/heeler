// Hiding, deleting, and the confirmations in front of them.
//
// The wording and the number of prompts are the safety feature here, so
// they are tested as behavior rather than left to whoever next edits
// the dialog.

import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "../app";
import { describe, expect, it } from "vitest";
import { initialState } from "../data";
import { isFinalPrompt, promptsFor, reduce, type Command, type Confirm, type State } from "../state";
import { ConfirmDialog, confirmCopy, humanBytes, trashFailure } from "../ui/catalogui";

const trash = (ids: string[]) => ({ kind: "trash_images", ids, names: ids } as const);

describe("how many times an action asks", () => {
  it("asks once for everything, because nothing destroys a file any more", () => {
    // This used to assert that delete-from-disk asked twice and hiding
    // asked once. The delete is gone: the owner's position is that code
    // which removes a photograph should not exist rather than exist and
    // ask carefully. Hiding is gone too, replaced by the trash. So the
    // assertion is now that no action qualifies, and the two-step
    // machinery is kept for whatever grave thing arrives next rather than
    // deleted along with its only caller.
    expect(promptsFor({ kind: "recover_hidden", path: "D:/p", count: 3 })).toBe(1);
    // The nearest thing to a delete this app has, and it asks once,
    // because a rename into a folder beside the file is not a delete.
    expect(promptsFor(trash(["a"]))).toBe(1);
  });

  it("agrees a reversible action on the first yes", () => {
    const s = reduce(initialState(), { type: "ask_confirm", action: trash(["a"]) });
    expect(isFinalPrompt(s.confirm!)).toBe(true);
  });

  it("canceling leaves nothing behind", () => {
    let s = reduce(initialState(), { type: "ask_confirm", action: trash(["a"]) });
    s = reduce(s, { type: "close_confirm" });
    expect(s.confirm).toBeNull();
    s = reduce(s, { type: "ask_confirm", action: trash(["a"]) });
    expect(s.confirm!.step).toBe(1);
  });
});

describe("what the prompts say", () => {
  const at = (action: Confirm["action"], step: number) => confirmCopy({ action, step });

  it("says the trash is a folder, not a deletion, and that nobody empties it", () => {
    const copy = at(trash(["IMG_001.NEF"]), 1);
    // The three things a person needs in order to act on this without
    // the app: where the file went, that it is still a file, and who is
    // responsible for it now.
    expect(copy.body).toMatch(/\.trash folder beside them/i);
    expect(copy.body).toMatch(/not deleted/i);
    expect(copy.body).toMatch(/never empties/i);
    expect(copy.body).toMatch(/put back/i);
    // Not styled as a danger. Coloring a reversible rename red puts it
    // in the same class as the thing this app no longer does.
    expect(copy.danger).toBe(false);
    expect(copy.title).toMatch(/trash/i);
  });

  it("counts what it is about to do", () => {
    expect(at(trash(["a", "b"]), 1).body).toMatch(/2 photographs/);
    // "The dialog will tell the user how many they are about to unhide."
    expect(at({ kind: "recover_hidden", path: "D:/p", count: 12 }, 1).body).toMatch(/12 hidden/);
    expect(at({ kind: "recover_hidden", path: "D:/p", count: 1 }, 1).body).toMatch(/1 hidden photograph\b/);
  });
});

describe("the confirmation dialog", () => {
  const withConfirm = (confirm: Confirm): State => ({ ...initialState(), confirm });

  it("agrees on one click, because nothing left needs a second", () => {
    // The two-click walk this used to assert belonged to delete from
    // disk. Nothing reversible earns a second ask, and nothing
    // irreversible remains.
    let s = withConfirm({ action: trash(["a.stack"]), step: 1 });
    const dispatch = (cmd: Command) => {
      s = reduce(s, cmd);
    };
    render(<ConfirmHost state={s} dispatch={dispatch} />);
    expect(screen.queryByTestId("confirm-step")).not.toBeInTheDocument();
    expect(isFinalPrompt(s.confirm!)).toBe(true);
  });

  it("cancel closes without doing anything", () => {
    let s = withConfirm({ action: trash(["a.stack"]), step: 1 });
    const dispatch = (cmd: Command) => {
      s = reduce(s, cmd);
    };
    render(<ConfirmHost state={s} dispatch={dispatch} />);
    fireEvent.click(screen.getByTestId("confirm-cancel"));
    expect(s.confirm).toBeNull();
  });
});

describe("images leaving the ribbon", () => {
  it("drops them and lands on a neighbor rather than on nothing", () => {
    const base = initialState();
    const first = base.images[0].id;
    const second = base.images[1].id;
    let s = reduce(base, { type: "select_image", id: first });
    s = reduce(s, { type: "remove_images", ids: [first] });
    expect(s.images.find((i) => i.id === first)).toBeUndefined();
    expect(s.images).toHaveLength(base.images.length - 1);
    // The active photo went with them, so the next one takes over.
    expect(s.activeImage).toBe(second);
    expect(s.imageSelection).toEqual([second]);
  });

  it("leaves the active photo alone when something else goes", () => {
    const base = initialState();
    const active = base.images[0].id;
    const other = base.images[3].id;
    let s = reduce(base, { type: "select_image", id: active });
    s = reduce(s, { type: "remove_images", ids: [other] });
    expect(s.activeImage).toBe(active);
    expect(s.images.find((i) => i.id === other)).toBeUndefined();
  });

  it("removing nothing changes nothing", () => {
    const base = initialState();
    expect(reduce(base, { type: "remove_images", ids: ["not-here"] })).toBe(base);
  });
});

describe("sizes people can judge", () => {
  it("reads bytes at the scale they arrive in", () => {
    expect(humanBytes(512)).toBe("512 B");
    expect(humanBytes(20 * 1024)).toBe("20 KB");
    // The owner's real catalog, and the part of it that cannot be
// regenerated.
    expect(humanBytes(10_760_000)).toBe("10.3 MB");
    expect(humanBytes(1_640_000)).toBe("1.6 MB");
    expect(humanBytes(3 * 1024 ** 3)).toBe("3.00 GB");
  });
});

describe("moving a photograph to the trash", () => {
  it("takes it out of the ribbon once the move has actually happened", async () => {
    let s: State = { ...initialState(), confirm: { action: trash([initialState().images[0].id]), step: 1 } };
    const before = s.images.length;
    const gone = s.images[0].id;
    const dispatch = (cmd: Command) => {
      s = reduce(s, cmd);
    };
    render(<ConfirmHost state={s} dispatch={dispatch} />);
    fireEvent.click(screen.getByTestId("confirm-ok"));
    // The move is a round trip to the backend, so the ribbon does not
    // change on the click itself.
    await new Promise((r) => setTimeout(r, 0));
    expect(s.images).toHaveLength(before - 1);
    expect(s.images.some((i) => i.id === gone)).toBe(false);
  });

  it("names the reason when a photograph stays where it was", () => {
    // "3 could not be moved" tells the user something went wrong and
    // nothing about what, and the reason is usually the same one for
    // all three.
    expect(trashFailure(["D:/p/IMG_1.NEF: permission denied"])).toMatch(/permission denied/);
    const many = trashFailure(["D:/p/IMG_1.NEF: read-only", "D:/p/IMG_2.NEF: read-only"]);
    expect(many).toMatch(/2/);
    expect(many).toMatch(/read-only/);
  });
});

/** Renders the dialog against a state the test controls. */
function ConfirmHost({ state, dispatch }: { state: State; dispatch: (c: Command) => void }) {
  return <ConfirmDialog state={state} dispatch={dispatch as React.Dispatch<Command>} />;
}

describe("where the menus put all this", () => {
  it("File offers catalog management", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByTestId("menu-file"));
    expect(screen.getByTestId("menu-file-catalogs")).toHaveTextContent("Catalogs and recovery");
    expect(screen.queryByTestId("menu-file-recovery")).toBeNull();
  });

  it("Edit offers Move to Trash, and neither hiding nor deleting from disk", async () => {
    // "I would expect this in both the Edit menu and the
    // thumbnail context menu." Deleting from disk left the app; hiding left
    // with it, because two commands that both mean "stop showing me this"
    // is one more than anybody needs and the weaker one leaves the file
    // where it is.
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByTestId("menu-edit"));
    expect(screen.getByTestId("menu-edit-trash")).toBeInTheDocument();
    expect(screen.queryByTestId("menu-edit-hide")).not.toBeInTheDocument();
    expect(screen.queryByTestId("menu-edit-delete")).not.toBeInTheDocument();
  });

  it("asking to trash from the thumbnail menu raises the confirmation, not the action", async () => {
    // Nothing moves on the click itself. This is the only removal the
    // thumbnail menu offers now: hiding sat above it and is gone, so
    // there is one answer to "stop showing me this" rather than two
    // that differ in a way nobody could see from the menu.
    const user = userEvent.setup();
    render(<App />);
    const id = initialState().images[0].id;
    fireEvent.contextMenu(screen.getByTestId(`thumb-${id}`), { clientX: 60, clientY: 90 });
    expect(screen.queryByTestId("thumb-menu-hide")).not.toBeInTheDocument();

    await user.click(await screen.findByTestId("thumb-menu-trash"));
    expect(screen.getByTestId("confirm-dialog")).toBeInTheDocument();
    expect(screen.getByTestId("confirm-title")).toHaveTextContent(/trash/i);
  });
});
