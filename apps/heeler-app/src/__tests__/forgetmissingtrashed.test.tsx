// Edit > Forget Missing Trashed Photos (2026-10-01: "yes, build the
// purge"). Trashed photographs whose file the user removed from .trash
// outside Heeler leave the catalog; no file is touched. One seat, beside
// Move to Trash; grayed with a reason when there is nothing to forget;
// one confirmation that lists every path and says there is no undo.

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initialState } from "../data";
import { reduce, type Command, type Confirm, type State } from "../state";
import { MenuBar } from "../ui/chrome";
import { ConfirmDialog, confirmCopy } from "../ui/catalogui";

const native = vi.hoisted(() => ({ invoke: vi.fn(async (_name: string, _args?: unknown): Promise<any> => []) }));
vi.mock("@tauri-apps/api/core", () => native);

afterEach(() => {
  delete (window as any).__TAURI_INTERNALS__;
  native.invoke.mockReset();
  native.invoke.mockImplementation(async (): Promise<any> => []);
});

type Forget = Extract<Confirm["action"], { kind: "forget_missing_trashed" }>;
const action = (over: Partial<Forget> = {}): Forget => ({
  kind: "forget_missing_trashed",
  ids: ["img_a", "img_b"],
  paths: ["/Photos/TEST/.trash/DSCF2858.dng", "/Photos/TEST/.trash/P1551400.RW2"],
  skipped: 0,
  skippedVolumes: [],
  ...over,
});

describe("the menu item", () => {
  it("is grayed with nothing to forget, and says why", () => {
    render(<MenuBar state={initialState()} dispatch={vi.fn()} />);
    fireEvent.click(screen.getByTestId("menu-edit"));
    const item = screen.getByTestId("menu-edit-forget-missing-trashed");
    expect(item).toBeDisabled();
    expect(item.textContent).toMatch(/Forget Missing Trashed Photos/);
    const hint = item.parentElement!.getAttribute("data-hint")!;
    expect(hint).toMatch(/No file is touched/);
    expect(hint).toMatch(/None to forget/);
    expect(hint.length).toBeLessThanOrEqual(165);
  });

  it("names the unplugged drives it could not check while grayed", () => {
    const state: State = { ...initialState(), missingTrashed: { count: 0, skipped: 3 } };
    render(<MenuBar state={state} dispatch={vi.fn()} />);
    fireEvent.click(screen.getByTestId("menu-edit"));
    const hint = screen.getByTestId("menu-edit-forget-missing-trashed").parentElement!.getAttribute("data-hint")!;
    expect(hint).toMatch(/3 on unplugged drives were not checked/);
    expect(hint.length).toBeLessThanOrEqual(165);
  });

  it("sits beside Move to Trash, its one seat", () => {
    render(<MenuBar state={initialState()} dispatch={vi.fn()} />);
    fireEvent.click(screen.getByTestId("menu-edit"));
    const trash = screen.getByTestId("menu-edit-trash").parentElement!;
    expect(trash.nextElementSibling?.querySelector("[data-testid=menu-edit-forget-missing-trashed]")).not.toBeNull();
    expect(screen.getAllByText(/Forget Missing Trashed Photos/)).toHaveLength(1);
  });

  it("asks the disk, then raises the confirmation with every path", async () => {
    (window as any).__TAURI_INTERNALS__ = { invoke: native.invoke };
    native.invoke.mockImplementation(async (name: string): Promise<any> =>
      name === "missing_trashed_photos"
        ? { ids: ["img_a"], paths: ["/Photos/TEST/.trash/DSCF2858.dng"], skipped: 1, skipped_volumes: ["/Volumes/DATA"] }
        : [],
    );
    const dispatch = vi.fn();
    const state: State = { ...initialState(), missingTrashed: { count: 1, skipped: 1 } };
    render(<MenuBar state={state} dispatch={dispatch} />);
    fireEvent.click(screen.getByTestId("menu-edit"));
    const item = screen.getByTestId("menu-edit-forget-missing-trashed");
    expect(item).not.toBeDisabled();
    fireEvent.click(item);
    await waitFor(() =>
      expect(dispatch).toHaveBeenCalledWith({
        type: "ask_confirm",
        action: { kind: "forget_missing_trashed", ids: ["img_a"], paths: ["/Photos/TEST/.trash/DSCF2858.dng"], skipped: 1, skippedVolumes: ["/Volumes/DATA"] },
      }),
    );
    // Asking is a read: nothing was forgotten on the click.
    expect(native.invoke.mock.calls.map((c) => c[0])).not.toContain("forget_missing_trashed_photos");
  });
});

describe("the confirmation", () => {
  it("says the outcome first: what leaves, that no file is touched, and that there is no undo", () => {
    const copy = confirmCopy({ action: action(), step: 1 });
    expect(copy.body).toMatch(/^Removes 2 trashed photographs and their edits from the catalog\./);
    expect(copy.body).toMatch(/No file on disk is touched/);
    expect(copy.body).toMatch(/recovery bundles made earlier still hold their edits/);
    expect(copy.body).toMatch(/There is no undo/);
    expect(copy.ok).toBe("Forget 2 photographs");
    expect(copy.danger).toBe(true);
  });

  it("says how many on an unplugged drive were skipped, and which drive", () => {
    const copy = confirmCopy({ action: action({ skipped: 4, skippedVolumes: ["/Volumes/DATA"] }), step: 1 });
    expect(copy.body).toMatch(/4 on a drive that is not connected \(\/Volumes\/DATA\) are not checked and stay\./);
  });

  it("asks once", () => {
    const s = reduce(initialState(), { type: "ask_confirm", action: action() });
    expect(s.confirm!.step).toBe(1);
  });

  it("lists every path, and forgetting removes them from the catalog and the ribbon", async () => {
    (window as any).__TAURI_INTERNALS__ = { invoke: native.invoke };
    native.invoke.mockImplementation(async (name: string): Promise<any> => (name === "forget_missing_trashed_photos" ? 2 : []));
    const dispatched: Command[] = [];
    const state: State = { ...initialState(), confirm: { action: action(), step: 1 } };
    render(<ConfirmDialog state={state} dispatch={(c: Command) => dispatched.push(c)} />);
    const list = screen.getByTestId("confirm-paths");
    expect(list.querySelectorAll("li")).toHaveLength(2);
    expect(list).toHaveTextContent("/Photos/TEST/.trash/DSCF2858.dng");
    expect(list).toHaveTextContent("/Photos/TEST/.trash/P1551400.RW2");
    fireEvent.click(screen.getByTestId("confirm-ok"));
    await waitFor(() => expect(dispatched).toContainEqual({ type: "close_confirm" }));
    const forget = native.invoke.mock.calls.find((c) => c[0] === "forget_missing_trashed_photos");
    expect(forget?.[1]).toEqual({ imageIds: ["img_a", "img_b"] });
    expect(dispatched).toContainEqual({ type: "remove_images", ids: ["img_a", "img_b"] });
  });
});

it("the library refresh's count reaches the state", () => {
  const s = reduce(initialState(), { type: "set_missing_trashed", count: 28, skipped: 2 });
  expect(s.missingTrashed).toEqual({ count: 28, skipped: 2 });
});
