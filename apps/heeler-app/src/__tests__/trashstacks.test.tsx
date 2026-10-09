// On macOS: "Multi-selected stacked photos could not move to trash. It
// seems I can only send one stacked photo at a time to the trash."
//
// The whole door, through the App: a folder holding two stacks among
// its frames, the stacks picked the way a Mac user picks them, the
// thumbnail menu's Move to Trash, the confirmation, and both stacks out
// of the ribbon. The bridge is the one thing faked, so the ids the
// backend would have been handed are on the record.

import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../app";
import { setMacForTests } from "../platform";
import type { Command, ImageEntry, State } from "../state";

const trashed: string[][] = [];
vi.mock("../bridge", async (importOriginal) => {
  const real = await importOriginal<typeof import("../bridge")>();
  return {
    ...real,
    moveImagesToTrash: async (ids: string[]) => {
      trashed.push([...ids]);
      return { moved: ids.length, moved_ids: ids, failed: [] };
    },
  };
});

const entry = (id: string, name: string): ImageEntry => ({
  id,
  name,
  stars: 0,
  flag: "",
  edited: false,
  missing: false,
  filter: "none",
  src: "",
});

const FOLDER: ImageEntry[] = [
  entry("f1", "P1000001.RW2"),
  entry("f2", "P1000002.RW2"),
  entry("s1", "MAX_P1000001-P1000002.stack"),
  entry("s2", "MEDIAN_P1000001-P1000002.stack"),
];

type Door = { dispatch: (c: Command) => void; state: () => State };
const door = () => (window as unknown as { __heeler: Door }).__heeler;

function openFolder() {
  render(<App />);
  act(() => door().dispatch({ type: "load_images", images: FOLDER }));
}

/** A Mac's Control-click, as WebKit delivers it: the button goes down
 * with Control held and the system turns it into the secondary click,
 * so the element hears `contextmenu` and never a `click`. */
function macControlClick(el: Element) {
  fireEvent.mouseDown(el, { button: 0, ctrlKey: true });
  fireEvent.contextMenu(el, { button: 0, ctrlKey: true });
  fireEvent.mouseUp(el, { button: 0, ctrlKey: true });
}

/** A real right-click (two-finger click, the mouse's second button):
 * button 2, no Control. */
function rightClick(el: Element) {
  fireEvent.mouseDown(el, { button: 2 });
  fireEvent.contextMenu(el, { button: 2, clientX: 60, clientY: 90 });
  fireEvent.mouseUp(el, { button: 2 });
}

async function trashFromMenu(onId: string) {
  rightClick(screen.getByTestId(`thumb-${onId}`));
  fireEvent.click(await screen.findByTestId("thumb-menu-trash"));
  await act(async () => {
    fireEvent.click(await screen.findByTestId("confirm-ok"));
  });
}

beforeEach(() => {
  trashed.length = 0;
  setMacForTests(true);
});
afterEach(() => setMacForTests(null));

describe("two stacks leave together", () => {
  it("Command-click picks both, and the menu trashes both", async () => {
    openFolder();
    fireEvent.click(screen.getByTestId("thumb-s1"));
    fireEvent.click(screen.getByTestId("thumb-s2"), { metaKey: true });
    expect(door().state().imageSelection).toEqual(["s1", "s2"]);
    await trashFromMenu("s2");
    expect(trashed).toEqual([["s1", "s2"]]);
    expect(screen.queryByTestId("thumb-s1")).toBeNull();
    expect(screen.queryByTestId("thumb-s2")).toBeNull();
    expect(door().state().images.map((i) => i.id)).toEqual(["f1", "f2"]);
  });

  it("Control-click on a Mac adds to the selection the way it does on Windows", async () => {
    // The ribbon's rule is "ctrl adds or removes", and on Windows the
    // click carries it. On a Mac the same chord never becomes a click:
    // the system spends it on the secondary click, and the thumbnail's
    // menu door took the photo as outside the selection and replaced
    // the selection with it. Each Control-click left one stack picked,
    // so Move to Trash moved one.
    openFolder();
    fireEvent.click(screen.getByTestId("thumb-s1"));
    macControlClick(screen.getByTestId("thumb-s2"));
    expect(door().state().imageSelection).toEqual(["s1", "s2"]);
    // A gesture that picks, not a menu: nothing to dismiss in between.
    expect(screen.queryByTestId("thumb-menu")).toBeNull();
    await trashFromMenu("s1");
    expect(trashed).toEqual([["s1", "s2"]]);
    expect(door().state().images.map((i) => i.id)).toEqual(["f1", "f2"]);
  });

  it("Control-click on a picked stack takes it back out, as Command-click does", () => {
    openFolder();
    fireEvent.click(screen.getByTestId("thumb-s1"));
    macControlClick(screen.getByTestId("thumb-s2"));
    macControlClick(screen.getByTestId("thumb-f1"));
    macControlClick(screen.getByTestId("thumb-s2"));
    expect(door().state().imageSelection).toEqual(["s1", "f1"]);
  });

  it("a real right-click outside the selection still moves to that photo first", () => {
    openFolder();
    fireEvent.click(screen.getByTestId("thumb-s1"));
    fireEvent.click(screen.getByTestId("thumb-s2"), { metaKey: true });
    rightClick(screen.getByTestId("thumb-f1"));
    expect(door().state().imageSelection).toEqual(["f1"]);
    expect(screen.getByTestId("thumb-menu")).toBeInTheDocument();
  });

  it("the expanded grid and table take a Mac's Control-click the same way", async () => {
    // The two other seats of the thumbnail menu had the same door.
    openFolder();
    act(() => door().dispatch({ type: "toggle_ribbon_expanded" }));
    fireEvent.click(screen.getByTestId("grid-s1"));
    macControlClick(screen.getByTestId("grid-s2"));
    expect(door().state().imageSelection).toEqual(["s1", "s2"]);
    act(() => door().dispatch({ type: "set_expanded_view", view: "table" }));
    fireEvent.click(await screen.findByTestId("table-row-f1"));
    macControlClick(screen.getByTestId("table-row-s1"));
    expect(door().state().imageSelection).toEqual(["f1", "s1"]);
    expect(screen.queryByTestId("thumb-menu")).toBeNull();
  });

  it("Control-click off a Mac is still a click the webview hands over", () => {
    // Windows and Linux deliver Control-click as a click, which the
    // ribbon already reads; a contextmenu with Control there is a real
    // right-click with a key held, and it keeps the menu's rule.
    setMacForTests(false);
    openFolder();
    fireEvent.click(screen.getByTestId("thumb-s1"));
    fireEvent.click(screen.getByTestId("thumb-s2"), { ctrlKey: true });
    expect(door().state().imageSelection).toEqual(["s1", "s2"]);
    fireEvent.contextMenu(screen.getByTestId("thumb-f1"), { button: 2, ctrlKey: true });
    expect(door().state().imageSelection).toEqual(["f1"]);
    expect(screen.getByTestId("thumb-menu")).toBeInTheDocument();
  });

  it("on a Mac, the second button with Control held is still a right-click", () => {
    openFolder();
    fireEvent.click(screen.getByTestId("thumb-s1"));
    fireEvent.contextMenu(screen.getByTestId("thumb-f1"), { button: 2, ctrlKey: true });
    expect(door().state().imageSelection).toEqual(["f1"]);
    expect(screen.getByTestId("thumb-menu")).toBeInTheDocument();
  });

  it("a right-click inside the selection keeps it, and the menu acts on all of it", async () => {
    openFolder();
    fireEvent.click(screen.getByTestId("thumb-s1"));
    fireEvent.click(screen.getByTestId("thumb-s2"), { metaKey: true });
    await trashFromMenu("s1");
    expect(trashed).toEqual([["s1", "s2"]]);
  });
});
