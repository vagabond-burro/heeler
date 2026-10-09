// A catalog held at the update gate at boot: the splash lifts at once
// and the prompt shows over the empty window, rather than waiting under
// the splash for its thirty-second backstop (2026-09-19: twenty-nine
// seconds before the prompt, with the check itself answered in 46 ms).

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pending = { path: "/photos/catalog.sqlite", from: 16, to: 17, appVersion: "26.3.0" };
const quit = vi.fn(() => Promise.resolve());
vi.mock("../bridge", async (original) => ({
  ...await original<Record<string, unknown>>(),
  catalogUpgradeCheck: () => Promise.resolve(pending),
  catalogUpgradeAlwaysBackup: () => Promise.resolve(false),
  quitApp: () => quit(),
}));

import { App } from "../app";
import { resetCatalogUpgradeForTests } from "../catalogupgrade";

beforeEach(() => resetCatalogUpgradeForTests());
afterEach(() => {
  cleanup();
  resetCatalogUpgradeForTests();
});

describe("a catalog pending an update at boot", () => {
  it("shows the prompt over an empty window with no splash in front of it", async () => {
    render(<App />);
    const dialog = await screen.findByTestId("catalog-upgrade-dialog");
    expect(dialog).toBeInTheDocument();
    expect(screen.queryByTestId("splash")).toBeNull();
    expect(screen.getByTestId("catalog-upgrade-body").textContent).toContain("/photos/catalog.sqlite");
    // The prompt is not covered by anything the boot draws later.
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByTestId("splash")).toBeNull();
    await waitFor(() => expect(screen.getByTestId("catalog-upgrade-quit")).toBeInTheDocument());
  });
});
