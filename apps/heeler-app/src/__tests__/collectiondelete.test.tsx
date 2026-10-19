// Deleting a collection: it asks first, Undo brings it back, and the
// ribbon does not keep showing the photographs of a collection that is
// gone.

import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "../app";
import { mockResetCollections } from "../bridge";
import { initialState } from "../data";
import { libraryRedoFirst, libraryUndoFirst, resetLibraryUndo } from "../libraryundo";
import { confirmCopy } from "../ui/cataloguiparts";

type User = ReturnType<typeof userEvent.setup>;

beforeEach(() => {
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

async function menu(user: User, item: "undo" | "redo") {
  await user.click(screen.getByTestId("menu-edit"));
  await user.click(screen.getByTestId(`menu-edit-${item}`));
}

describe("deleting a collection asks first", () => {
  it("says the photographs stay, and Cancel keeps the collection", async () => {
    const user = userEvent.setup();
    render(<App />);
    const id = await picks(user);

    await user.click(screen.getByTestId(`collection-delete-${id}`));
    const dialog = await screen.findByTestId("confirm-dialog");
    expect(within(dialog).getByTestId("confirm-title")).toHaveTextContent("Delete collection");
    expect(within(dialog).getByTestId("confirm-body")).toHaveTextContent(
      /"Picks" will be deleted\. The photograph in it stays in the catalog and on disk, with its rating/,
    );
    await user.click(screen.getByTestId("confirm-cancel"));
    expect(screen.queryByTestId("confirm-dialog")).not.toBeInTheDocument();
    expect(screen.getByTestId(`collection-row-${id}`)).toBeInTheDocument();

    await user.click(screen.getByTestId(`collection-delete-${id}`));
    await user.click(screen.getByTestId("confirm-ok"));
    await waitFor(() => expect(screen.queryByTestId(`collection-row-${id}`)).not.toBeInTheDocument());
  });

  it("counts the photographs in the words", () => {
    const copy = confirmCopy({
      action: { kind: "delete_collection", id: 1, name: "Trip", count: 1200, open: false, back: null },
      step: 1,
    });
    expect(copy.body).toContain("The 1,200 photographs in it stay in the catalog and on disk");
    expect(copy.body).toContain("Undo brings the collection back");
    expect(copy.ok).toBe("Delete collection");
    const empty = confirmCopy({
      action: { kind: "delete_collection", id: 1, name: "Trip", count: 0, open: false, back: null },
      step: 1,
    });
    expect(empty.body).toBe('"Trip" will be deleted. It holds no photographs. Undo brings the collection back.');
  });
});

describe("the ribbon after deleting the open collection", () => {
  it("lets go of the collection's photographs", async () => {
    const user = userEvent.setup();
    render(<App />);
    const id = await picks(user);
    await user.click(screen.getByTestId(`collection-open-${id}`));
    expect(await screen.findByTestId("library-label")).toHaveTextContent("Picks");
    expect(await screen.findByTestId("thumb-4871")).toBeInTheDocument();

    await user.click(screen.getByTestId(`collection-delete-${id}`));
    await user.click(screen.getByTestId("confirm-ok"));
    // No folder was open before it, so nothing is left to show.
    await waitFor(() => expect(screen.queryByTestId("thumb-4871")).not.toBeInTheDocument());
    expect(screen.getByTestId("library-label")).not.toHaveTextContent("Picks");
  });

  it("leaves the ribbon alone when another collection is deleted", async () => {
    const user = userEvent.setup();
    render(<App />);
    const id = await picks(user);
    await user.click(screen.getByTestId(`collection-delete-${id}`));
    await user.click(screen.getByTestId("confirm-ok"));
    await waitFor(() => expect(screen.queryByTestId(`collection-row-${id}`)).not.toBeInTheDocument());
    expect(screen.getByTestId("thumb-4866")).toBeInTheDocument();
    expect(screen.getByTestId("thumb-4871")).toBeInTheDocument();
  });
});

describe("Undo after deleting a collection", () => {
  it("brings it back with its photographs, and Redo deletes it again", async () => {
    const user = userEvent.setup();
    render(<App />);
    const id = await picks(user);
    await user.click(screen.getByTestId(`collection-delete-${id}`));
    await user.click(screen.getByTestId("confirm-ok"));
    await waitFor(() => expect(screen.queryByTestId(`collection-row-${id}`)).not.toBeInTheDocument());

    await menu(user, "undo");
    const row = await screen.findByTestId(`collection-row-${id}`);
    expect(row).toHaveTextContent("Picks");
    expect(row).toHaveTextContent("1");

    await menu(user, "redo");
    await waitFor(() => expect(screen.queryByTestId(`collection-row-${id}`)).not.toBeInTheDocument());
    await menu(user, "undo");
    expect(await screen.findByTestId(`collection-row-${id}`)).toHaveTextContent("1");
  });

  it("opens it again when it was the one open", async () => {
    const user = userEvent.setup();
    render(<App />);
    const id = await picks(user);
    await user.click(screen.getByTestId(`collection-open-${id}`));
    await user.click(screen.getByTestId(`collection-delete-${id}`));
    await user.click(screen.getByTestId("confirm-ok"));
    await waitFor(() => expect(screen.queryByTestId("thumb-4871")).not.toBeInTheDocument());

    await menu(user, "undo");
    await waitFor(() => expect(screen.getByTestId("library-label")).toHaveTextContent("Picks"));
    expect(await screen.findByTestId("thumb-4871")).toBeInTheDocument();
  });

  it("takes back an edit made after the delete first, and the delete next", async () => {
    const user = userEvent.setup();
    render(<App />);
    const exposure = () => within(screen.getByTestId("slider-exposure")).getByRole("slider");
    // An edit before the delete, one after.
    fireEvent.keyDown(exposure(), { key: "ArrowRight" });
    const before = exposure().getAttribute("aria-valuenow");
    const id = await picks(user);
    await user.click(screen.getByTestId(`collection-delete-${id}`));
    await user.click(screen.getByTestId("confirm-ok"));
    await waitFor(() => expect(screen.queryByTestId(`collection-row-${id}`)).not.toBeInTheDocument());
    fireEvent.keyDown(exposure(), { key: "ArrowRight" });
    expect(exposure().getAttribute("aria-valuenow")).not.toBe(before);

    await menu(user, "undo");
    expect(exposure().getAttribute("aria-valuenow")).toBe(before);
    expect(screen.queryByTestId(`collection-row-${id}`)).not.toBeInTheDocument();

    await menu(user, "undo");
    expect(await screen.findByTestId(`collection-row-${id}`)).toBeInTheDocument();
    expect(exposure().getAttribute("aria-valuenow")).toBe(before);

    await menu(user, "undo");
    expect(exposure().getAttribute("aria-valuenow")).not.toBe(before);
  });
});

describe("which goes first, the library or the photograph", () => {
  const step = { seq: 1, label: "Delete collection" };

  it("is nothing to do with no library step", () => {
    const s = initialState();
    expect(libraryUndoFirst(s)).toBe(false);
    expect(libraryRedoFirst(s)).toBe(false);
  });

  it("is the library step with no edit, or one this module never marked", () => {
    const s = { ...initialState(), libraryUndo: [step], libraryRedo: [step] };
    expect(libraryUndoFirst(s)).toBe(true);
    expect(libraryRedoFirst(s)).toBe(true);
  });
});
