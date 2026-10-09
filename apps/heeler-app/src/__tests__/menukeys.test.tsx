// Menu items print the key they are bound to.
//
// "The menu items need to list their assigned hotkey, this
// is pretty standard in most apps." The machinery was already there
// (item takes a command id and renders its binding); several items
// simply never passed one, so Ctrl+Shift+O had existed for Open Folder
// since the day it was added and the menu had never said so.
//
// Tested by walking the registry rather than by listing keys here, so a
// rebind in hotkeys.ts cannot make these pass while the menu lies.

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { setMacForTests } from "../platform";
import { App } from "../app";
import { COMMANDS, bindingFor } from "../hotkeys";
import { runCommand } from "../commands";
import { initialState } from "../data";
import { reduce } from "../state";

const defaultBinding = (id: string) => bindingFor(id, {});

/** Menu items that stand for a registry command, and which one. */
const LINKED: [string, string][] = [
  ["menu-file-open", "file.open"],
  ["menu-file-prefs", "app.preferences"],
  ["menu-file-catalogs", "catalog.manage"],
  ["menu-edit-undo", "edit.undo"],
  ["menu-edit-redo", "edit.redo"],
  ["menu-edit-reset", "edit.reset"],
  ["menu-window-library", "view.browser"],
  ["menu-window-ribbon", "view.ribbon"],
  ["menu-window-console", "view.console"],
  // menu-edit-hide is gone with hiding itself; image.trash stays in
  // the registry and its command behavior is pinned below.
];

describe("menu items show their hotkey", () => {
  it("File prints the keys its items are bound to", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByTestId("menu-file"));
    // The one that was wrong: Open Folder has been Ctrl+Shift+O all
    // along and the menu never said so.
    expect(screen.getByTestId("menu-file-open")).toHaveTextContent(defaultBinding("file.open"));
    expect(screen.getByTestId("menu-file-prefs")).toHaveTextContent(
      defaultBinding("app.preferences"),
    );
  });

  it("Edit prints the keys its items are bound to", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByTestId("menu-edit"));
    expect(screen.getByTestId("menu-edit-undo")).toHaveTextContent(defaultBinding("edit.undo"));
    expect(screen.getByTestId("menu-edit-redo")).toHaveTextContent(defaultBinding("edit.redo"));
  });

  it("every linked item names a command that really exists", () => {
    // A typo in a command id would silently print nothing rather than
    // fail, which is exactly how the missing ones went unnoticed.
    for (const [testid, cmd] of LINKED) {
      expect(
        COMMANDS.find((c) => c.id === cmd),
        `${testid} points at "${cmd}", which is not in the registry`,
      ).toBeDefined();
    }
  });

  it("an item with no key assigned shows no key rather than an empty box", async () => {
    // Catalogs ships unbound on purpose; the row should read cleanly.
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByTestId("menu-file"));
    expect(defaultBinding("catalog.manage")).toBe("");
    expect(within(screen.getByTestId("menu-file-catalogs")).queryByText(/\+/)).toBeNull();
  });
});

describe("the new commands are real commands, not menu-only actions", () => {
  // A registry entry the hotkey editor lists but runCommand ignores is a
  // trap: the user assigns a key, presses it, and nothing happens.
  const withImages = () => {
    const s = initialState();
    return reduce(s, { type: "select_image", id: s.images[0].id });
  };

  it("opens the catalogs dialog", () => {
    let s = withImages();
    const ran = runCommand("catalog.manage", s, (c) => {
      s = reduce(s, c);
    });
    expect(ran).toBe(true);
    expect(s.catalogsOpen).toBe(true);
  });

  it("has no keystroke that deletes a photograph, because none exists", () => {
    // There was one here once, and it asked twice before it ran. The
    // command is gone rather than guarded: a keystroke that cannot be
    // reached is still a keystroke somebody can wire back up by
    // accident, and nothing in this app removes a file the user owns.
    let s = withImages();
    const ran = runCommand("image.delete", s, (c) => {
      s = reduce(s, c);
    });
    expect(ran).toBe(false);
    expect(s.confirm).toBeNull();
    expect(s.images).toHaveLength(withImages().images.length);
  });

  it("moving to the trash asks first, and asks once", () => {
    let s = withImages();
    const ran = runCommand("image.trash", s, (c) => {
      s = reduce(s, c);
    });
    expect(ran).toBe(true);
    expect(s.confirm?.action.kind).toBe("trash_images");
    expect(s.confirm?.step).toBe(1);
    // Nothing has moved on the keystroke itself.
    expect(s.images).toHaveLength(withImages().images.length);
  });

  it("leaves Move to Trash unbound, because Delete already belongs to the graph", () => {
    // Delete is the key a person expects here and the one this must not
    // have: a global binding would fire while the graph is focused and
    // trash a photograph the user was not even looking at.
    const entry = COMMANDS.find((h) => h.id === "image.trash");
    expect(entry).toBeDefined();
    expect(entry!.binding).toBe("");
    expect(COMMANDS.find((h) => h.id === "edit.delete")!.binding).toBe("Delete");
  });

  it("names the photographs in the confirmation rather than their ids", () => {
    let s = withImages();
    runCommand("image.trash", s, (c) => {
      s = reduce(s, c);
    });
    const action = s.confirm!.action as { names: string[] };
    expect(action.names[0]).toMatch(/\.NEF$/);
  });

  it("does nothing at all when there is no photograph to act on", () => {
    const empty = { ...initialState(), images: [], imageSelection: [], activeImage: "" };
    expect(runCommand("image.trash", empty, () => {})).toBe(false);
  });
});

describe("menu items on a Mac", () => {
  afterEach(() => setMacForTests(null));

  /// The binding is stored as "Ctrl+Z" either way; only the label
  /// changes, and only on a Mac.
  it("print the Command symbol instead of Ctrl", async () => {
    setMacForTests(true);
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByTestId("menu-edit"));
    expect(screen.getByTestId("menu-edit-undo")).toHaveTextContent("⌘Z");
    expect(screen.getByTestId("menu-edit-redo")).toHaveTextContent("⇧⌘Z");
  });
});
