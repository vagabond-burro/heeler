// The catalog update card and its store (26.3): the three answers, the
// done line naming the backup, and the rule that a failed backup
// approves nothing and re-offers the choices.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const approve = vi.fn<(path: string, backup: boolean) => Promise<BackupResult | null>>();
const written: BackupResult = { path: "/photos/catalog.sqlite.before-26.3.sqlite", bytes: 700_000, images: 2073, folders: 15, thumbnails_dropped: 1686 };
const quit = vi.fn<() => Promise<void>>(() => Promise.resolve());
vi.mock("../bridge", async (original) => ({
  ...await original<Record<string, unknown>>(),
  catalogUpgradeApprove: (path: string, backup: boolean) => approve(path, backup),
  quitApp: () => quit(),
}));

import { parseUpgradePending, type BackupResult, type UpgradePending } from "../bridge";
import { askCatalogUpgrade, noticeCatalogUpgradeDone, resetCatalogUpgradeForTests } from "../catalogupgrade";
import { CatalogUpgradePrompt } from "../ui/catalogupgrade";

const pending: UpgradePending = {
  path: "/photos/catalog.sqlite",
  from: 6,
  to: 7,
  appVersion: "26.3",
};

beforeEach(() => {
  approve.mockReset();
  quit.mockClear();
  resetCatalogUpgradeForTests();
});
afterEach(() => {
  cleanup();
  resetCatalogUpgradeForTests();
});

/** Flushes the microtasks an async card action (the approve call) runs
 * through, inside act so the re-render lands before the assertions. */
function flush(): Promise<void> {
  return act(async () => { await Promise.resolve(); });
}

describe("parseUpgradePending", () => {
  it("reads the typed refusal from the backend's gate", () => {
    const error = new Error('upgrade-pending:{"path":"/a/catalog.sqlite","from":6,"to":7,"app_version":"26.3"}');
    expect(parseUpgradePending(error)).toEqual({ path: "/a/catalog.sqlite", from: 6, to: 7, appVersion: "26.3" });
  });
  it("passes on plain errors and malformed payloads", () => {
    expect(parseUpgradePending(new Error("disk full"))).toBeNull();
    expect(parseUpgradePending("upgrade-pending:{not json")).toBeNull();
    expect(parseUpgradePending(new Error('upgrade-pending:{"path":3}'))).toBeNull();
  });
});

describe("the update card", () => {
  it("names the catalog, the formats and the build", () => {
    render(<CatalogUpgradePrompt />);
    let ask!: Promise<boolean>;
    act(() => { ask = askCatalogUpgrade(pending); });
    expect(screen.getByTestId("catalog-upgrade-title").textContent).toContain("needs an update");
    expect(screen.getByTestId("catalog-upgrade-body").textContent).toContain("/photos/catalog.sqlite");
    expect(screen.getByTestId("catalog-upgrade-body").textContent).toContain("v6");
    expect(screen.getByTestId("catalog-upgrade-body").textContent).toContain("v7");
    expect(screen.getByTestId("catalog-upgrade-body").textContent).toContain("26.3");
    // Tidy up the dangling ask.
    fireEvent.click(screen.getByTestId("catalog-upgrade-quit"));
    return expect(ask).resolves.toBe(false);
  });

  it("Back Up and Update writes the copy, names it, and approves on OK", async () => {
    approve.mockResolvedValue(written);
    render(<CatalogUpgradePrompt />);
    let ask!: Promise<boolean>;
    act(() => { ask = askCatalogUpgrade(pending); });
    fireEvent.click(screen.getByTestId("catalog-upgrade-backup"));
    await flush();
    expect(approve).toHaveBeenCalledWith("/photos/catalog.sqlite", true);
    expect(screen.getByTestId("catalog-upgrade-title").textContent).toContain("Backup written");
    expect(screen.getByTestId("catalog-upgrade-body").textContent).toContain("catalog.sqlite.before-26.3.sqlite");
    fireEvent.click(screen.getByTestId("catalog-upgrade-ok"));
    await expect(ask).resolves.toBe(true);
    expect(screen.queryByTestId("catalog-upgrade-dialog")).toBeNull();
  });

  it("Update Without Backup approves at once, with no copy", async () => {
    approve.mockResolvedValue(null);
    render(<CatalogUpgradePrompt />);
    let ask!: Promise<boolean>;
    act(() => { ask = askCatalogUpgrade(pending); });
    fireEvent.click(screen.getByTestId("catalog-upgrade-nobackup"));
    await flush();
    expect(approve).toHaveBeenCalledWith("/photos/catalog.sqlite", false);
    await expect(ask).resolves.toBe(true);
    expect(screen.queryByTestId("catalog-upgrade-dialog")).toBeNull();
  });

  it("a failed backup approves nothing and offers the choices again", async () => {
    approve.mockRejectedValueOnce(new Error("the disk is full")).mockResolvedValue(null);
    render(<CatalogUpgradePrompt />);
    let answered: boolean | undefined;
    let ask!: Promise<boolean>;
    act(() => { ask = askCatalogUpgrade(pending); });
    void ask.then((a) => { answered = a; });
    fireEvent.click(screen.getByTestId("catalog-upgrade-backup"));
    await flush();
    expect(screen.getByTestId("catalog-upgrade-error").textContent).toContain("the disk is full");
    expect(answered).toBeUndefined();
    expect(screen.getByTestId("catalog-upgrade-backup")).toBeEnabled();
    fireEvent.click(screen.getByTestId("catalog-upgrade-nobackup"));
    await flush();
    await expect(ask).resolves.toBe(true);
  });

  it("asks once per catalog, however many callers ask, and remembers a yes (2026-09-19)", async () => {
    approve.mockResolvedValue(null);
    render(<CatalogUpgradePrompt />);
    let first!: Promise<boolean>;
    let second!: Promise<boolean>;
    act(() => {
      first = askCatalogUpgrade(pending);
      second = askCatalogUpgrade(pending);
    });
    expect(screen.getAllByTestId("catalog-upgrade-dialog")).toHaveLength(1);
    fireEvent.click(screen.getByTestId("catalog-upgrade-nobackup"));
    await flush();
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(approve).toHaveBeenCalledTimes(1);
    // The card is gone and a late asker for the same catalog is answered
    // yes without a prompt: the boot's second run, or a command that
    // was refused before the answer landed.
    expect(screen.queryByTestId("catalog-upgrade-dialog")).toBeNull();
    expect(await askCatalogUpgrade(pending)).toBe(true);
    expect(screen.queryByTestId("catalog-upgrade-dialog")).toBeNull();
    // Another catalog is its own question.
    let other!: Promise<boolean>;
    act(() => { other = askCatalogUpgrade({ ...pending, path: "/elsewhere/catalog.sqlite" }); });
    expect(screen.getByTestId("catalog-upgrade-body").textContent).toContain("/elsewhere/catalog.sqlite");
    fireEvent.click(screen.getByTestId("catalog-upgrade-quit"));
    await flush();
    expect(await other).toBe(false);
  });

  it("Quit closes the app and answers no", async () => {
    render(<CatalogUpgradePrompt />);
    let ask!: Promise<boolean>;
    act(() => { ask = askCatalogUpgrade(pending); });
    fireEvent.click(screen.getByTestId("catalog-upgrade-quit"));
    await flush();
    expect(quit).toHaveBeenCalled();
    await expect(ask).resolves.toBe(false);
    expect(screen.queryByTestId("catalog-upgrade-dialog")).toBeNull();
  });

  it("the policy's done line names the backup without offering choices", async () => {
    render(<CatalogUpgradePrompt />);
    let notice!: Promise<void>;
    act(() => { notice = noticeCatalogUpgradeDone(pending, written); });
    expect(screen.getByTestId("catalog-upgrade-title").textContent).toContain("Backup written");
    expect(screen.getByTestId("catalog-upgrade-body").textContent).toContain("catalog.sqlite.before-26.3.sqlite");
    expect(screen.queryByTestId("catalog-upgrade-quit")).toBeNull();
    fireEvent.click(screen.getByTestId("catalog-upgrade-ok"));
    await expect(notice).resolves.toBeUndefined();
    expect(approve).not.toHaveBeenCalled();
  });
});
