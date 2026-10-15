// What the library shows on the way into and out of a collection: the
// photographs in the ribbon, the label over them and which collection
// is open. Opening one, reloading it after a photograph leaves, stepping
// off it, deleting it, and Undo and Redo of a delete each decide that,
// and these pin what each decides today.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "../app";
import * as bridge from "../bridge";
import { addToCollection, createCollection, mockResetCollections, mockSetSubtreeCounts } from "../bridge";
import { initialState } from "../data";
import { deleteCollectionStep, resetLibraryUndo } from "../libraryundo";
import type { Command, State } from "../state";
import { beginNavigation, editCollectionMembership } from "../ui/chrome";
import { leaveCollection, openCollection, reloadCollection } from "../ui/collectionnav";
import { wantThumb } from "../thumbs";

type User = ReturnType<typeof userEvent.setup>;

beforeEach(() => {
  vi.restoreAllMocks();
  mockResetCollections();
  resetLibraryUndo();
});

/** "Picks", holding the active photograph (4871). */
async function picks(user: User): Promise<string> {
  await user.click(screen.getByTestId("new-collection"));
  await user.type(screen.getByTestId("new-collection-name"), "Picks{Enter}");
  const row = await screen.findByTestId(/^collection-row-/);
  const id = row.getAttribute("data-testid")!.replace("collection-row-", "");
  await user.click(screen.getByTestId(`collection-add-${id}`));
  expect(await screen.findByTestId(`collection-row-${id}`)).toHaveTextContent("1");
  return id;
}

/** Into Wedding (mock_1 to mock_3), then into the collection. */
async function fromWedding(user: User, id: string) {
  await user.click(screen.getByTestId("folder-row-1"));
  await waitFor(() => expect(screen.getByTestId("library-label")).toHaveTextContent("Wedding"));
  expect(await screen.findByTestId("thumb-mock_1")).toBeInTheDocument();
  await user.click(screen.getByTestId(`collection-open-${id}`));
  await waitFor(() => expect(screen.getByTestId("library-label")).toHaveTextContent("Picks"));
  await waitFor(() => expect(screen.queryByTestId("thumb-mock_1")).not.toBeInTheDocument());
  expect(screen.getByTestId("thumb-4871")).toBeInTheDocument();
}

async function deleteIt(user: User, id: string) {
  await user.click(screen.getByTestId(`collection-delete-${id}`));
  await user.click(screen.getByTestId("confirm-ok"));
  await waitFor(() => expect(screen.queryByTestId(`collection-row-${id}`)).not.toBeInTheDocument());
}

async function menu(user: User, item: "undo" | "redo") {
  await user.click(screen.getByTestId("menu-edit"));
  await user.click(screen.getByTestId(`menu-edit-${item}`));
}

const openColor = (id: string) => screen.getByTestId(`collection-open-${id}`).style.color;

describe("stepping off a collection", () => {
  it("goes back to the folder it was opened from", async () => {
    const user = userEvent.setup();
    render(<App />);
    const id = await picks(user);
    await fromWedding(user, id);

    await user.click(screen.getByTestId("collections-section"));
    await waitFor(() => expect(screen.getByTestId("library-label")).toHaveTextContent("Wedding"));
    expect(await screen.findByTestId("thumb-mock_1")).toBeInTheDocument();
    expect(screen.queryByTestId("thumb-4871")).not.toBeInTheDocument();
    expect(openColor(id)).toBe("var(--text-hi)");
  });

  it("with no folder behind it, empties the ribbon as a delete does", async () => {
    // Its photographs and name used to stay, with nothing on screen
    // saying what the ribbon held once the collection was let go.
    const user = userEvent.setup();
    render(<App />);
    const id = await picks(user);
    await user.click(screen.getByTestId(`collection-open-${id}`));
    await waitFor(() => expect(screen.getByTestId("library-label")).toHaveTextContent("Picks"));
    expect(await screen.findByTestId("thumb-4871")).toBeInTheDocument();

    await user.click(screen.getByTestId("collections-section"));
    await waitFor(() => expect(openColor(id)).toBe("var(--text-hi)"));
    await waitFor(() => expect(screen.getByTestId("library-label")).toHaveTextContent("No folder open"));
    expect(screen.queryByTestId("thumb-4871")).not.toBeInTheDocument();
    // The collection itself is untouched, and opens again.
    expect(screen.getByTestId(`collection-row-${id}`)).toHaveTextContent("1");
    await user.click(screen.getByTestId(`collection-open-${id}`));
    expect(await screen.findByTestId("thumb-4871")).toBeInTheDocument();
  });
});

describe("deleting the open collection", () => {
  it("goes back to the folder it was opened from", async () => {
    const user = userEvent.setup();
    render(<App />);
    const id = await picks(user);
    await fromWedding(user, id);

    await deleteIt(user, id);
    await waitFor(() => expect(screen.getByTestId("library-label")).toHaveTextContent("Wedding"));
    expect(await screen.findByTestId("thumb-mock_1")).toBeInTheDocument();
    expect(screen.queryByTestId("thumb-4871")).not.toBeInTheDocument();
  });

  it("and Redo after Undo goes back to that folder again", async () => {
    const user = userEvent.setup();
    render(<App />);
    const id = await picks(user);
    await fromWedding(user, id);
    await deleteIt(user, id);
    await waitFor(() => expect(screen.getByTestId("library-label")).toHaveTextContent("Wedding"));

    await menu(user, "undo");
    await waitFor(() => expect(screen.getByTestId("library-label")).toHaveTextContent("Picks"));
    expect(await screen.findByTestId("thumb-4871")).toBeInTheDocument();

    await menu(user, "redo");
    await waitFor(() => expect(screen.getByTestId("library-label")).toHaveTextContent("Wedding"));
    expect(await screen.findByTestId("thumb-mock_1")).toBeInTheDocument();
    expect(screen.queryByTestId("thumb-4871")).not.toBeInTheDocument();
  });

  it("with no folder behind it, Redo empties the ribbon", async () => {
    const user = userEvent.setup();
    render(<App />);
    const id = await picks(user);
    await user.click(screen.getByTestId(`collection-open-${id}`));
    await deleteIt(user, id);
    await menu(user, "undo");
    await waitFor(() => expect(screen.getByTestId("library-label")).toHaveTextContent("Picks"));

    await menu(user, "redo");
    await waitFor(() => expect(screen.getByTestId("library-label")).toHaveTextContent("No folder open"));
    expect(screen.queryByTestId("thumb-4871")).not.toBeInTheDocument();
  });
});

describe("a photograph leaving the open collection", () => {
  it("reloads the collection, from the thumbnail's menu", async () => {
    const user = userEvent.setup();
    render(<App />);
    const id = await picks(user);
    await user.click(screen.getByTestId("thumb-4866"));
    await user.click(screen.getByTestId(`collection-add-${id}`));
    expect(await screen.findByTestId(`collection-row-${id}`)).toHaveTextContent("2");
    await user.click(screen.getByTestId(`collection-open-${id}`));
    expect(await screen.findByTestId("thumb-4866")).toBeInTheDocument();
    expect(screen.getByTestId("thumb-4871")).toBeInTheDocument();

    fireEvent.contextMenu(screen.getByTestId("thumb-4866"));
    await user.click(await screen.findByTestId("thumb-menu-collection-remove"));
    await waitFor(() => expect(screen.queryByTestId("thumb-4866")).not.toBeInTheDocument());
    expect(screen.getByTestId("thumb-4871")).toBeInTheDocument();
    expect(screen.getByTestId("library-label")).toHaveTextContent("Picks");
    expect(openColor(id)).toBe("var(--accent)");
  });
});

/** A state with collection 1, "Picks", open; and the commands sent. */
function recorder(open: number | null): { state: State; sent: Command[]; dispatch: (c: Command) => void } {
  const sent: Command[] = [];
  const state: State = {
    ...initialState(),
    collections: [{ id: 1, name: "Picks", count: 2, hasLook: false }],
    activeCollection: open,
  };
  return { state, sent, dispatch: (c) => void sent.push(c) };
}

describe("the commands behind it", () => {
  it("opening a collection takes the navigation, loads its members and names it", async () => {
    const id = await createCollection("Picks");
    await addToCollection(id, "a", "A.dng");
    const { sent, dispatch } = recorder(null);
    const before = beginNavigation();
    await openCollection(id, "Picks", dispatch, 480);
    // One for the open, one for this probe: an open makes a folder
    // listing still on its way stale.
    expect(beginNavigation()).toBe(before + 2);
    const load = sent.find((c) => c.type === "load_images");
    expect(load && load.type === "load_images" && load.images.map((i) => i.id)).toEqual(["a"]);
    expect(sent).toContainEqual({ type: "set_library", label: "Picks", collection: id, path: null });
  });

  it("a removal reloads the open collection without taking the navigation", async () => {
    // A folder clicked while the removal was on its way is the newer
    // wish, and must still land.
    const id = await createCollection("Picks");
    expect(id).toBe(1);
    await addToCollection(1, "a", "A.dng");
    await addToCollection(1, "b", "B.dng");
    const { state, sent, dispatch } = recorder(1);
    const before = beginNavigation();
    await editCollectionMembership(state, dispatch, ["a"], "remove");
    expect(beginNavigation()).toBe(before + 1);
    const load = sent.find((c) => c.type === "load_images");
    expect(load && load.type === "load_images" && load.images.map((i) => i.id)).toEqual(["b"]);
    expect(sent).toContainEqual({ type: "set_library", label: "Picks", collection: 1, path: null });
  });

  it("removing from every collection reloads the open one too", async () => {
    await createCollection("Picks");
    await addToCollection(1, "a", "A.dng");
    const { state, sent, dispatch } = recorder(1);
    await editCollectionMembership(state, dispatch, ["a"], "remove-all");
    const load = sent.find((c) => c.type === "load_images");
    expect(load && load.type === "load_images" && load.images).toEqual([]);
    expect(sent).toContainEqual({ type: "set_library", label: "Picks", collection: 1, path: null });
  });

  it("deleting the open collection with no folder behind it takes the navigation", async () => {
    // So a folder listing still on its way cannot land over the emptied
    // ribbon. From the second reader's mutation pass: nothing read the
    // token on this way out.
    const id = await createCollection("Picks");
    await addToCollection(id, "a", "A.dng");
    const { state, sent, dispatch } = recorder(id);
    const before = beginNavigation();
    await deleteCollectionStep(state, dispatch, { id, name: "Picks", open: true, back: null });
    // One for the way out, one for this probe.
    expect(beginNavigation()).toBe(before + 2);
    expect(sent).toContainEqual({ type: "set_library", label: "No folder open", collection: null, path: null });
  });

  it("an open overtaken by a newer navigation does not land", async () => {
    // A folder row clicked while the members load is the newer wish,
    // even when its listing comes back first.
    const id = await createCollection("Picks");
    await addToCollection(id, "a", "A.dng");
    const { sent, dispatch } = recorder(null);
    const opening = openCollection(id, "Picks", dispatch, 480);
    beginNavigation();
    await opening;
    expect(sent.some((c) => c.type === "set_library" || c.type === "load_images")).toBe(false);
  });

  it("a reload overtaken by a navigation does not land", async () => {
    const id = await createCollection("Picks");
    await addToCollection(id, "a", "A.dng");
    const { sent, dispatch } = recorder(id);
    const reloading = reloadCollection(id, "Picks", dispatch, 480);
    beginNavigation();
    await reloading;
    expect(sent.some((c) => c.type === "set_library" || c.type === "load_images")).toBe(false);
  });

  it("a removal's reload gives way to a folder clicked while the removal itself ran", async () => {
    // From the independent review: the reload noted the navigation only
    // after the removal's own wait, by when the click had moved it.
    await createCollection("Picks");
    await addToCollection(1, "a", "A.dng");
    const original = bridge.removeFromCollection;
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    vi.spyOn(bridge, "removeFromCollection").mockImplementation(async (c, i) => {
      await held;
      return original(c, i);
    });
    const { state, sent, dispatch } = recorder(1);
    const removing = editCollectionMembership(state, dispatch, ["a"], "remove");
    beginNavigation();
    release();
    await removing;
    expect(sent.some((c) => c.type === "set_library" || c.type === "load_images")).toBe(false);
  });

  it("each way in and out passes the thumbnail size it was given", async () => {
    // From the independent review: nothing read the size a collection
    // listing hands the thumbnail session, so dropping it survived.
    const id = await createCollection("Picks");
    await addToCollection(id, "a", "A.dng");
    const thumbs = vi.spyOn(bridge, "loadThumbnail").mockResolvedValue(null);
    const asked = async (id: string) => {
      thumbs.mockClear();
      wantThumb(id);
      await Promise.resolve();
      return thumbs.mock.calls[0]?.[1];
    };
    const { state, dispatch } = recorder(id);
    await openCollection(id, "Picks", dispatch, 1024);
    expect(await asked("a")).toBe(1024);
    await reloadCollection(id, "Picks", dispatch, 777);
    expect(await asked("a")).toBe(777);
    const sized = { ...state, prefs: { ...state.prefs, thumbnailEdge: 640 } };
    await leaveCollection(sized, dispatch, null);
    expect(await asked("b")).toBe(640);
    await leaveCollection({ ...sized, prefs: { ...sized.prefs, thumbnailEdge: 320 } }, dispatch, "mock://wedding");
    expect(await asked("mock_1")).toBe(320);
  });

  it("the way back to a folder has landed when it returns", async () => {
    // The callers await it before refreshing and logging; one that did
    // not wait would report the way out done with the folder not shown.
    const original = bridge.openFolder;
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    vi.spyOn(bridge, "openFolder").mockImplementation(async (path) => {
      await held;
      return original(path);
    });
    const { state, sent, dispatch } = recorder(1);
    let returned = false;
    const leaving = leaveCollection(state, dispatch, "mock://wedding").then(() => {
      returned = true;
    });
    for (let i = 0; i < 40; i++) await Promise.resolve();
    expect(returned).toBe(false);
    release();
    await leaving;
    expect(sent).toContainEqual(expect.objectContaining({ type: "set_library", label: "Wedding", collection: null }));
  });

  it("adding does not reload, and nothing reloads with no collection open", async () => {
    await createCollection("Picks");
    const added = recorder(1);
    await editCollectionMembership(added.state, added.dispatch, ["a"], "add");
    expect(added.sent.some((c) => c.type === "load_images" || c.type === "set_library")).toBe(false);

    const closed = recorder(null);
    await editCollectionMembership(closed.state, closed.dispatch, ["a"], "remove-all");
    expect(closed.sent.some((c) => c.type === "load_images" || c.type === "set_library")).toBe(false);
  });
});

// A folder hidden or flushed while a collection was open: the
// collection kept showing the flushed photographs, and stepping off it
// went back to the folder, which added it to the catalog again
// (vagabond-burro/heeler#40).
describe("a folder that leaves while a collection is open", () => {
  beforeEach(() => mockSetSubtreeCounts({ folders: 1, images: 0 }));

  it("a flush takes its photographs out of the open collection, and stepping off does not go back to it", async () => {
    const user = userEvent.setup();
    render(<App />);
    const id = await picks(user);
    await addToCollection(Number(id), "mock_1", "IMG_0001.dng");
    await user.click(screen.getByTestId("folder-row-1"));
    await waitFor(() => expect(screen.getByTestId("library-label")).toHaveTextContent("Wedding"));
    await user.click(screen.getByTestId(`collection-open-${id}`));
    await waitFor(() => expect(screen.getByTestId("library-label")).toHaveTextContent("Picks"));
    expect(await screen.findByTestId("thumb-4871")).toBeInTheDocument();
    expect(screen.getByTestId("thumb-mock_1")).toBeInTheDocument();

    mockSetSubtreeCounts({ folders: 1, images: 3 });
    fireEvent.contextMenu(screen.getByTestId("folder-row-1"));
    await user.click(await screen.findByTestId("folder-menu-flush"));
    await user.click(await screen.findByTestId("confirm-ok"));
    await user.click(await screen.findByTestId("confirm-ok"));
    await waitFor(() => expect(screen.queryByTestId("thumb-mock_1")).not.toBeInTheDocument());
    expect(screen.getByTestId("thumb-4871")).toBeInTheDocument();
    expect(screen.getByTestId("library-label")).toHaveTextContent("Picks");

    await user.click(screen.getByTestId("collections-section"));
    await waitFor(() => expect(screen.getByTestId("library-label")).toHaveTextContent("No folder open"));
  });

  it("after a hide, stepping off does not open the hidden folder again", async () => {
    const user = userEvent.setup();
    render(<App />);
    const id = await picks(user);
    await fromWedding(user, id);
    fireEvent.contextMenu(screen.getByTestId("folder-row-1"));
    await user.click(await screen.findByTestId("folder-menu-hide"));
    await waitFor(() => expect(screen.queryByTestId("folder-row-1")).not.toBeInTheDocument());

    await user.click(screen.getByTestId("collections-section"));
    await waitFor(() => expect(screen.getByTestId("library-label")).toHaveTextContent("No folder open"));
  });
});
