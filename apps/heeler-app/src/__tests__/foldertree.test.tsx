// The folder tree keeping up with the disk.
//
// The tree listed each folder once and never again, so a folder made,
// renamed or removed outside Heeler showed only if its exact parent was
// opened by name; a folder that was gone did nothing when clicked; and a
// branch on an ejected card collapsed to a leaf.

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../app";
import { loadSession, mockAddSubfolder, mockFailListing, mockSetRelink, mockRemoveFolder, mockResetSessions, mockSetFolderSession, mockSetSubfolderHold } from "../bridge";
import { initialState } from "../data";
import { catalogSaves } from "../savebarrier";
import { rememberExpanded, rememberedExpanded } from "../uiprefs";
import { reduce, type Command, type State, type TreeNode } from "../state";
import { openFolderPlain, openFolderRemembering, relinkFrom } from "../ui/chrome";
import { EXPAND_ALL_CAP, expandAllChildren, expandedPaths, newFolderIn, stopExpanding } from "../ui/foldertree";
import { _clearFlashForTests, currentFlash } from "../ui/hints";

type User = ReturnType<typeof userEvent.setup>;
let undo: (() => void)[] = [];

beforeEach(() => {
  _clearFlashForTests();
  // A remembered way down in one test would take the next one's open of
  // the same folder somewhere else.
  mockResetSessions();
  // The open folders are remembered between launches; between tests
  // they would leak one test's tree into the next.
  localStorage.removeItem("heeler.ui.treeExpanded");
});
afterEach(() => {
  for (const u of undo) u();
  undo = [];
});

async function openTrip(user: User) {
  await user.click(await screen.findByTestId("folder-row-3"));
  await screen.findByTestId("tree-row-mock://trip/day1");
}

async function menuOn(user: User, path: string, item: string) {
  fireEvent.contextMenu(screen.getByTestId(`tree-row-${path}`));
  await user.click(await screen.findByTestId(`folder-menu-${item}`));
}

describe("Refresh", () => {
  it("lists the open folder again: a subfolder made outside Heeler appears", async () => {
    const user = userEvent.setup();
    render(<App />);
    await openTrip(user);
    mockAddSubfolder("mock://trip", "Day 3");
    expect(screen.queryByTestId("tree-row-mock://trip/day3")).toBeNull();
    await menuOn(user, "mock://trip", "refresh");
    expect(await screen.findByTestId("tree-row-mock://trip/day3")).toBeInTheDocument();
  });

  it("lists a folder that is not the open one", async () => {
    const user = userEvent.setup();
    render(<App />);
    await openTrip(user);
    mockAddSubfolder("mock://trip/day1", "Morning");
    await menuOn(user, "mock://trip/day1", "refresh");
    await user.click(await screen.findByTestId("tree-toggle-mock://trip/day1"));
    expect(await screen.findByTestId("tree-row-mock://trip/day1/morning")).toBeInTheDocument();
    expect(screen.getByTestId("library-label")).toHaveTextContent("Trip");
  });
});

describe("expanding a branch again", () => {
  it("lists it again, so folders made since the last look show up", async () => {
    const user = userEvent.setup();
    render(<App />);
    await openTrip(user);
    await user.click(screen.getByTestId("tree-toggle-mock://trip"));
    await waitFor(() => expect(screen.queryByTestId("tree-row-mock://trip/day1")).toBeNull());
    mockAddSubfolder("mock://trip", "Day 4");
    await user.click(screen.getByTestId("tree-toggle-mock://trip"));
    expect(await screen.findByTestId("tree-row-mock://trip/day4")).toBeInTheDocument();
    expect(screen.getByTestId("tree-row-mock://trip/day1")).toBeInTheDocument();
  });
});

describe("a folder that is gone", () => {
  it("says so when clicked, leaves the library where it was, and leaves the tree", async () => {
    const user = userEvent.setup();
    render(<App />);
    await openTrip(user);
    undo.push(mockRemoveFolder("mock://trip/day2"));
    await user.click(screen.getByTestId("tree-open-mock://trip/day2"));
    await waitFor(() => expect(currentFlash()).toMatch(/Could not open day2: mock:\/\/trip\/day2 is not there/));
    expect(screen.getByTestId("library-label")).toHaveTextContent("Trip");
    await waitFor(() => expect(screen.queryByTestId("tree-row-mock://trip/day2")).toBeNull());
    expect(screen.getByTestId("tree-row-mock://trip/day1")).toBeInTheDocument();
  });

  it("one that cannot be read says so rather than showing as empty", async () => {
    const user = userEvent.setup();
    render(<App />);
    await openTrip(user);
    undo.push(mockRemoveFolder("mock://trip/day1"));
    await user.click(screen.getByTestId("tree-toggle-mock://trip/day1"));
    await waitFor(() => expect(currentFlash()).toMatch(/Could not read Day 1/));
  });
});

/** The library state behind a real reducer, for driving folder opens
 * without the panel. */
function harness() {
  let s: State = initialState();
  return {
    get: () => s,
    dispatch: (c: Command) => {
      s = reduce(s, c);
    },
  };
}

function find(node: TreeNode | null, path: string): TreeNode | null {
  if (!node) return null;
  if (node.path === path) return node;
  for (const c of node.children ?? []) {
    const hit = find(c, path);
    if (hit) return hit;
  }
  return null;
}

describe("re-picking a folder inside the tree", () => {
  beforeEach(() => mockResetSessions());

  // A remembered subfolder used to save the picked folder as the session's
  // root, so the next launch restored a different tree from the one on
  // screen.
  it("keeps the tree's root as the session's root when it descends to where work stopped", async () => {
    const h = harness();
    await openFolderPlain("mock://trip", null, h.dispatch);
    mockAddSubfolder("mock://trip/day1", "Morning");
    mockSetFolderSession("mock://trip/day1", { activeFolder: "mock://trip/day1/morning" });
    await openFolderRemembering("mock://trip/day1", h.get().folderTree, h.dispatch);
    await catalogSaves.flush();
    expect(h.get().folderTree?.path).toBe("mock://trip");
    expect(await loadSession()).toMatchObject({ treeRoot: "mock://trip", activeFolder: "mock://trip/day1/morning" });
  });

  it("keeps the root for a folder deep in a branch the tree has not loaded", async () => {
    const h = harness();
    await openFolderPlain("mock://trip", null, h.dispatch);
    mockAddSubfolder("mock://trip/day2", "Evening");
    await openFolderPlain("mock://trip/day2/evening", h.get().folderTree, h.dispatch);
    expect(h.get().folderTree?.path).toBe("mock://trip");
    expect(find(h.get().folderTree, "mock://trip/day2/evening")).not.toBeNull();
    expect(h.get().activeFolderPath).toBe("mock://trip/day2/evening");
  });

  it("puts the old tree back under a new root above it, expanded as it was", async () => {
    const h = harness();
    mockAddSubfolder("mock://trip/day1", "Noon");
    await openFolderPlain("mock://trip/day1", null, h.dispatch);
    expect(h.get().folderTree?.path).toBe("mock://trip/day1");
    await openFolderPlain("mock://trip", h.get().folderTree, h.dispatch);
    await waitFor(() => expect(find(h.get().folderTree, "mock://trip/day1")?.expanded).toBe(true));
    expect(h.get().folderTree?.path).toBe("mock://trip");
    expect(find(h.get().folderTree, "mock://trip/day1/noon")).not.toBeNull();
  });
});

describe("Expand all children", () => {
  // A slow expand opened the branches again one by one after Collapse
  // all children.
  it("stops when the branch is collapsed while it runs", async () => {
    const h = harness();
    await openFolderPlain("mock://trip", null, h.dispatch);
    let release!: () => void;
    mockSetSubfolderHold(new Promise<void>((r) => { release = r; }));
    const running = expandAllChildren("mock://trip", h.dispatch);
    stopExpanding();
    h.dispatch({ type: "collapse_tree_below", path: "mock://trip" });
    mockSetSubfolderHold(null);
    release();
    await running;
    expect(find(h.get().folderTree, "mock://trip/day1")?.expanded).toBe(false);
    expect(find(h.get().folderTree, "mock://trip/day2")?.expanded).toBe(false);
  });

  it("says so when it reaches its cap", async () => {
    const h = harness();
    for (let i = 0; i <= EXPAND_ALL_CAP; i++) mockAddSubfolder("mock://landscapes", `F${i}`);
    await openFolderPlain("mock://landscapes", null, h.dispatch);
    await expandAllChildren("mock://landscapes", h.dispatch);
    expect(currentFlash()).toMatch(new RegExp(`Expanded the first ${EXPAND_ALL_CAP} folders`));
  });

  it("is not offered on a folder the tree does not hold", async () => {
    const user = userEvent.setup();
    render(<App />);
    await openTrip(user);
    fireEvent.contextMenu(screen.getByTestId("folder-row-1"));
    await screen.findByTestId("folder-menu");
    expect(screen.queryByTestId("folder-menu-expand")).toBeNull();
    expect(screen.queryByTestId("folder-menu-collapse")).toBeNull();
    expect(screen.getByTestId("folder-menu-refresh")).toBeInTheDocument();
  });
});

// A relink re-reads the folder it started in when it is done, and a
// folder clicked while it ran was replaced by that one.
describe("a relink that takes a while", () => {
  afterEach(() => mockSetRelink(null));

  it("gives way to a folder clicked while it ran", async () => {
    const h = harness();
    await openFolderPlain("mock://wedding", null, h.dispatch);
    const gone = h.get().images[0].id;
    h.dispatch({ type: "select_image", id: gone });
    const before: State = { ...h.get(), images: h.get().images.map((i) => (i.id === gone ? { ...i, missing: true } : i)) };
    let release!: () => void;
    mockSetRelink("mock://elsewhere/IMG_0001.dng", new Promise<void>((r) => { release = r; }));
    const relinking = relinkFrom(before, h.dispatch);
    // The file is picked and the relink is under way before the click.
    await new Promise((r) => setTimeout(r, 0));
    await openFolderPlain("mock://trip", h.get().folderTree, h.dispatch);
    release();
    await relinking;
    expect(h.get().activeFolderPath).toBe("mock://trip");
  });
});

// The tree had no way in from the keyboard and said nothing to a screen
// reader.
describe("the tree from the keyboard", () => {
  it("is a tree of rows with levels, one of them in the Tab order", async () => {
    const user = userEvent.setup();
    render(<App />);
    await openTrip(user);
    expect(screen.getByRole("tree", { name: "Folders" })).toBeInTheDocument();
    const trip = screen.getByTestId("tree-row-mock://trip");
    expect(trip).toHaveAttribute("role", "treeitem");
    expect(trip).toHaveAttribute("aria-level", "1");
    expect(trip).toHaveAttribute("aria-expanded", "true");
    expect(trip).toHaveAttribute("aria-selected", "true");
    expect(trip.tabIndex).toBe(0);
    expect(screen.getByTestId("tree-row-mock://trip/day1")).toHaveAttribute("aria-level", "2");
    expect(screen.getByTestId("tree-row-mock://trip/day1").tabIndex).toBe(-1);
  });

  it("moves with the arrows, opens and closes branches, and opens a folder on Enter", async () => {
    const user = userEvent.setup();
    render(<App />);
    mockAddSubfolder("mock://trip/day1", "Dawn");
    await openTrip(user);
    const row = (p: string) => screen.getByTestId(`tree-row-${p}`);
    row("mock://trip").focus();
    fireEvent.keyDown(row("mock://trip"), { key: "ArrowDown" });
    expect(document.activeElement).toBe(row("mock://trip/day1"));
    fireEvent.keyDown(row("mock://trip/day1"), { key: "ArrowRight" });
    expect(await screen.findByTestId("tree-row-mock://trip/day1/dawn")).toBeInTheDocument();
    fireEvent.keyDown(row("mock://trip/day1"), { key: "ArrowRight" });
    // Into its first child (other tests in this file add more under it).
    const child = document.activeElement as HTMLElement;
    expect(child.getAttribute("aria-level")).toBe("3");
    expect(child.dataset.treePath?.startsWith("mock://trip/day1/")).toBe(true);
    fireEvent.keyDown(child, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(row("mock://trip/day1"));
    fireEvent.keyDown(row("mock://trip/day1"), { key: "ArrowLeft" });
    await waitFor(() => expect(screen.queryByTestId("tree-row-mock://trip/day1/dawn")).toBeNull());
    fireEvent.keyDown(row("mock://trip/day1"), { key: "End" });
    const rows = screen.getAllByRole("treeitem");
    const last = rows[rows.length - 1];
    expect(document.activeElement).toBe(last);
    fireEvent.keyDown(last, { key: "Enter" });
    await waitFor(() => expect(screen.getByTestId("library-label")).toHaveTextContent(last.getAttribute("aria-label")!));
  });
});

describe("the open folder's row", () => {
  it("is brought into the tree's box when a folder opens", async () => {
    const seen: string[] = [];
    const before = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = vi.fn(function (this: Element) {
      seen.push(this.getAttribute("data-tree-path") ?? "");
    });
    try {
      const user = userEvent.setup();
      render(<App />);
      await openTrip(user);
      await user.click(screen.getByTestId("tree-open-mock://trip/day2"));
      await waitFor(() => expect(seen).toContain("mock://trip/day2"));
    } finally {
      Element.prototype.scrollIntoView = before;
    }
  });
});

// Only the restored session's one path came back open after a launch.
describe("the folders left open", () => {
  it("are remembered for the tree's root as they open and close", async () => {
    const user = userEvent.setup();
    render(<App />);
    mockAddSubfolder("mock://trip/day2", "Dusk");
    await openTrip(user);
    await user.click(screen.getByTestId("tree-toggle-mock://trip/day2"));
    await waitFor(() => expect(rememberedExpanded("mock://trip")).toContain("mock://trip/day2"));
    await user.click(screen.getByTestId("tree-toggle-mock://trip/day2"));
    await waitFor(() => expect(rememberedExpanded("mock://trip")).not.toContain("mock://trip/day2"));
  });

  it("open again when the root is opened again", async () => {
    mockAddSubfolder("mock://trip/day1", "Sunrise");
    rememberExpanded("mock://trip", ["mock://trip/day1", "mock://elsewhere/x"]);
    const h = harness();
    await openFolderPlain("mock://trip", null, h.dispatch);
    await waitFor(() => expect(find(h.get().folderTree, "mock://trip/day1")?.expanded).toBe(true));
    expect(find(h.get().folderTree, "mock://trip/day1/sunrise")).not.toBeNull();
  });

  it("are read off a tree, the root left out", () => {
    const tree: TreeNode = {
      name: "r", path: "/r", expanded: true,
      children: [
        { name: "a", path: "/r/a", expanded: true, children: [{ name: "b", path: "/r/a/b", expanded: false, children: null }] },
        { name: "c", path: "/r/c", expanded: false, children: [{ name: "d", path: "/r/c/d", expanded: true, children: [] }] },
      ],
    };
    expect(expandedPaths(tree)).toEqual(["/r/a"]);
    expect(expandedPaths(null)).toEqual([]);
  });
});

describe("New Folder, Rename and Copy Path", () => {
  it("makes a folder inside the one right-clicked and shows it in the tree", async () => {
    const user = userEvent.setup();
    render(<App />);
    await openTrip(user);
    await menuOn(user, "mock://trip", "new");
    await user.type(await screen.findByTestId("folder-name-input"), "Day 9{Enter}");
    expect(await screen.findByTestId("tree-row-mock://trip/Day 9")).toBeInTheDocument();
    expect(screen.queryByTestId("folder-name")).toBeNull();
  });

  it("says why a name is refused and keeps the field open", async () => {
    const user = userEvent.setup();
    render(<App />);
    await openTrip(user);
    await menuOn(user, "mock://trip", "new");
    await user.type(await screen.findByTestId("folder-name-input"), "Day 8{Enter}");
    await screen.findByTestId("tree-row-mock://trip/Day 8");
    await menuOn(user, "mock://trip", "new");
    await user.type(await screen.findByTestId("folder-name-input"), "Day 8{Enter}");
    expect(await screen.findByTestId("folder-name-error")).toHaveTextContent("already there");
    expect(screen.getByTestId("folder-name")).toBeInTheDocument();
  });

  it("renames a folder in the tree, keeping where it sits", async () => {
    const user = userEvent.setup();
    render(<App />);
    await openTrip(user);
    await menuOn(user, "mock://trip", "new");
    await user.type(await screen.findByTestId("folder-name-input"), "Spare{Enter}");
    await screen.findByTestId("tree-row-mock://trip/Spare");
    await menuOn(user, "mock://trip/Spare", "rename");
    const field = await screen.findByTestId("folder-name-input");
    expect(field).toHaveValue("Spare");
    await user.clear(field);
    await user.type(field, "Extras{Enter}");
    expect(await screen.findByTestId("tree-row-mock://trip/Extras")).toBeInTheDocument();
    expect(screen.queryByTestId("tree-row-mock://trip/Spare")).toBeNull();
    expect(screen.getByTestId("library-label")).toHaveTextContent("Trip");
  });

  it("renaming the folder you are in takes the library with it", async () => {
    const user = userEvent.setup();
    render(<App />);
    await openTrip(user);
    await menuOn(user, "mock://trip", "new");
    await user.type(await screen.findByTestId("folder-name-input"), "Here{Enter}");
    await user.click(await screen.findByTestId("tree-open-mock://trip/Here"));
    await waitFor(() => expect(screen.getByTestId("library-label")).toHaveTextContent("Here"));
    await menuOn(user, "mock://trip/Here", "rename");
    const field = await screen.findByTestId("folder-name-input");
    await user.clear(field);
    await user.type(field, "There{Enter}");
    await waitFor(() => expect(screen.getByTestId("library-label")).toHaveTextContent("There"));
    expect(screen.getByTestId("tree-row-mock://trip/There")).toHaveAttribute("aria-selected", "true");
  });

  it("copies the folder's path", async () => {
    const copied: string[] = [];
    const user = userEvent.setup();
    // After setup, which puts a clipboard of its own on navigator.
    Object.defineProperty(navigator, "clipboard", { value: { writeText: async (t: string) => { copied.push(t); } }, configurable: true });
    render(<App />);
    await openTrip(user);
    await menuOn(user, "mock://trip/day2", "copy-path");
    await waitFor(() => expect(copied).toEqual(["mock://trip/day2"]));
    await waitFor(() => expect(currentFlash()).toMatch(/Path copied/));
  });
});

describe("folder names", () => {
  it("are refused with a separator in them, as the app refuses them", async () => {
    const user = userEvent.setup();
    render(<App />);
    await openTrip(user);
    await menuOn(user, "mock://trip", "new");
    await user.type(await screen.findByTestId("folder-name-input"), "a/b{Enter}");
    expect(await screen.findByTestId("folder-name-error")).toHaveTextContent('cannot contain "/"');
  });
});

/** The harness, with every command it was given kept in order. */
function recording() {
  const h = harness();
  const sent: Command[] = [];
  return {
    ...h,
    sent,
    dispatch: (c: Command) => {
      sent.push(c);
      h.dispatch(c);
    },
  };
}

// Each caller that lists a folder into the tree has its own rule for a
// listing that fails or is overtaken by a newer click: these pin every
// one, so the tree never takes an error for an empty folder.
describe("listing into the tree, each caller's own rule", () => {
  it("a folder deep in an unloaded branch stops at a branch it cannot list", async () => {
    mockAddSubfolder("mock://trip/day2", "Evening");
    mockAddSubfolder("mock://trip/day2/evening", "Late");
    const h = harness();
    await openFolderPlain("mock://trip", null, h.dispatch);
    undo.push(mockFailListing("mock://trip/day2"));
    await openFolderPlain("mock://trip/day2/evening/late", h.get().folderTree, h.dispatch);
    expect(h.get().folderTree?.path).toBe("mock://trip");
    expect(find(h.get().folderTree, "mock://trip/day2")?.children).toBeNull();
    expect(find(h.get().folderTree, "mock://trip/day2/evening")).toBeNull();
    expect(h.get().activeFolderPath).toBe("mock://trip/day2/evening/late");
  });

  it("a folder deep in an unloaded branch gives way to a newer click while it lists", async () => {
    mockAddSubfolder("mock://trip/day2", "Evening");
    const h = recording();
    await openFolderPlain("mock://trip", null, h.dispatch);
    let release!: () => void;
    mockSetSubfolderHold(new Promise<void>((r) => { release = r; }));
    const slow = openFolderPlain("mock://trip/day2/evening", h.get().folderTree, h.dispatch);
    await new Promise((r) => setTimeout(r, 0));
    await openFolderPlain("mock://trip/day1", h.get().folderTree, h.dispatch);
    const before = h.sent.length;
    mockSetSubfolderHold(null);
    release();
    await slow;
    expect(h.sent.slice(before).filter((c) => c.type === "set_tree_node" || c.type === "set_folder_tree" || c.type === "set_library")).toEqual([]);
    expect(h.get().activeFolderPath).toBe("mock://trip/day1");
  });

  it("the old tree goes back under a new root two levels up, and not when the way down cannot be listed", async () => {
    mockAddSubfolder("mock://trip/day1", "Noon");
    mockAddSubfolder("mock://trip/day1/noon", "Shade");
    const ok = harness();
    await openFolderPlain("mock://trip/day1/noon", null, ok.dispatch);
    await openFolderPlain("mock://trip", ok.get().folderTree, ok.dispatch);
    await waitFor(() => expect(find(ok.get().folderTree, "mock://trip/day1/noon")?.expanded).toBe(true));
    expect(find(ok.get().folderTree, "mock://trip/day1/noon/shade")).not.toBeNull();

    const blocked = harness();
    await openFolderPlain("mock://trip/day1/noon", null, blocked.dispatch);
    undo.push(mockFailListing("mock://trip/day1"));
    await openFolderPlain("mock://trip", blocked.get().folderTree, blocked.dispatch);
    await new Promise((r) => setTimeout(r, 20));
    expect(find(blocked.get().folderTree, "mock://trip/day1")?.expanded).toBe(false);
    expect(find(blocked.get().folderTree, "mock://trip/day1/noon")).toBeNull();
  });

  it("the old tree is not put back once a newer click has come", async () => {
    mockAddSubfolder("mock://trip/day1", "Noon");
    const h = recording();
    await openFolderPlain("mock://trip/day1/noon", null, h.dispatch);
    let release!: () => void;
    mockSetSubfolderHold(new Promise<void>((r) => { release = r; }));
    await openFolderPlain("mock://trip", h.get().folderTree, h.dispatch);
    await openFolderPlain("mock://wedding", h.get().folderTree, h.dispatch);
    const before = h.sent.length;
    mockSetSubfolderHold(null);
    release();
    await new Promise((r) => setTimeout(r, 20));
    expect(h.sent.slice(before).filter((c) => c.type === "graft_tree_node" || c.type === "set_tree_node")).toEqual([]);
  });

  it("a remembered folder that cannot be listed is skipped and the rest still open", async () => {
    rememberExpanded("mock://trip", ["mock://trip/day1", "mock://trip/day2"]);
    undo.push(mockFailListing("mock://trip/day1"));
    const h = harness();
    await openFolderPlain("mock://trip", null, h.dispatch);
    await waitFor(() => expect(find(h.get().folderTree, "mock://trip/day2")?.expanded).toBe(true));
    expect(find(h.get().folderTree, "mock://trip/day1")?.expanded).toBe(false);
  });

  it("remembered folders stop opening once a newer click has come", async () => {
    rememberExpanded("mock://trip", ["mock://trip/day1", "mock://trip/day2"]);
    const h = recording();
    let release!: () => void;
    mockSetSubfolderHold(new Promise<void>((r) => { release = r; }));
    await openFolderPlain("mock://trip", null, h.dispatch);
    await openFolderPlain("mock://wedding", h.get().folderTree, h.dispatch);
    const before = h.sent.length;
    mockSetSubfolderHold(null);
    release();
    await new Promise((r) => setTimeout(r, 20));
    expect(h.sent.slice(before).filter((c) => c.type === "set_tree_node")).toEqual([]);
  });

  it("a remembered way down still opens past a branch it cannot list", async () => {
    mockAddSubfolder("mock://trip/day1", "Dawn");
    mockSetFolderSession("mock://trip", { activeFolder: "mock://trip/day1/dawn" });
    undo.push(mockFailListing("mock://trip/day1"));
    const h = harness();
    await openFolderRemembering("mock://trip", null, h.dispatch);
    expect(h.get().activeFolderPath).toBe("mock://trip/day1/dawn");
    expect(find(h.get().folderTree, "mock://trip/day1")?.expanded).toBe(true);
    expect(find(h.get().folderTree, "mock://trip/day1")?.children).toBeNull();
  });

  it("a remembered way down gives way to a newer click", async () => {
    mockAddSubfolder("mock://trip/day1", "Dawn");
    mockSetFolderSession("mock://trip", { activeFolder: "mock://trip/day1/dawn" });
    const h = harness();
    let release!: () => void;
    mockSetSubfolderHold(new Promise<void>((r) => { release = r; }));
    const slow = openFolderRemembering("mock://trip", null, h.dispatch);
    await new Promise((r) => setTimeout(r, 0));
    await openFolderPlain("mock://wedding", h.get().folderTree, h.dispatch);
    mockSetSubfolderHold(null);
    release();
    await slow;
    expect(h.get().activeFolderPath).toBe("mock://wedding");
  });

  it("Expand all children goes on past a folder it cannot list", async () => {
    mockAddSubfolder("mock://trip/day2", "Dusk");
    const h = harness();
    await openFolderPlain("mock://trip", null, h.dispatch);
    undo.push(mockFailListing("mock://trip/day1"));
    await expandAllChildren("mock://trip", h.dispatch);
    expect(find(h.get().folderTree, "mock://trip/day1")?.expanded).toBe(false);
    expect(find(h.get().folderTree, "mock://trip/day2")?.expanded).toBe(true);
  });

  it("opening a branch again keeps what it showed when it cannot be listed this time", async () => {
    const user = userEvent.setup();
    render(<App />);
    mockAddSubfolder("mock://trip/day1", "Glow");
    await openTrip(user);
    await user.click(screen.getByTestId("tree-toggle-mock://trip/day1"));
    await screen.findByTestId("tree-row-mock://trip/day1/glow");
    await user.click(screen.getByTestId("tree-toggle-mock://trip/day1"));
    await waitFor(() => expect(screen.queryByTestId("tree-row-mock://trip/day1/glow")).toBeNull());
    undo.push(mockFailListing("mock://trip/day1"));
    await user.click(screen.getByTestId("tree-toggle-mock://trip/day1"));
    expect(await screen.findByTestId("tree-row-mock://trip/day1/glow")).toBeInTheDocument();
  });

  it("Refresh on a folder that is gone says so", async () => {
    const user = userEvent.setup();
    render(<App />);
    await openTrip(user);
    undo.push(mockRemoveFolder("mock://trip/day2"));
    await menuOn(user, "mock://trip/day2", "refresh");
    await waitFor(() => expect(currentFlash()).toMatch(/Could not open day2: mock:\/\/trip\/day2 is not there/));
  });

  it("a gone folder's row stays when its parent cannot be listed either", async () => {
    const user = userEvent.setup();
    render(<App />);
    await openTrip(user);
    undo.push(mockRemoveFolder("mock://trip/day2"));
    undo.push(mockFailListing("mock://trip"));
    await user.click(screen.getByTestId("tree-open-mock://trip/day2"));
    await waitFor(() => expect(currentFlash()).toMatch(/Could not open day2/));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByTestId("tree-row-mock://trip/day2")).toBeInTheDocument();
    expect(screen.getByTestId("library-label")).toHaveTextContent("Trip");
  });

  it("a new folder is made even when the folder it is in cannot be listed after", async () => {
    const h = harness();
    await openFolderPlain("mock://trip", null, h.dispatch);
    undo.push(mockFailListing("mock://trip"));
    expect(await newFolderIn("mock://trip", "Late", h.dispatch)).toBeNull();
    expect(currentFlash()).toMatch(/Made Late/);
    expect(find(h.get().folderTree, "mock://trip/Late")).toBeNull();
  });
});
