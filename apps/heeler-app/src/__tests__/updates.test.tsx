// Help > Check for Updates and the launch-time check (src/updates.ts).
// Check and link, never download: the dialog says whether a newer
// release exists and hands its installer to the browser. From the
// menu every outcome is shown; at launch only a newer, unskipped
// release is, and the launch check itself follows a preference.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mockOpenedUrls, mockResetOpenedUrls, mockSetUpdateReply, type UpdateCheck } from "../bridge";
import { UPDATE_DOWNLOAD_WORDS, checkForUpdates, launchCheckWanted, resetUpdatesForTests, skippedVersion, updatePrompt } from "../updates";
import { UpdatePrompt } from "../ui/updates";
import { settingDescription } from "../ui/preferences";
import { App } from "../app";

const NEWER: UpdateCheck = {
  available: true,
  current: "2026.1",
  latest: "2026.2",
  url: "https://github.com/vagabond-burro/heeler/releases/download/v26.2.0/Heeler-26.2.0-macos.dmg",
  notes: "Fixes the brush cursor.",
};
const SAME: UpdateCheck = { available: false, current: "2026.1", latest: "2026.1", url: "https://github.com/vagabond-burro/heeler/releases/latest", notes: "" };

beforeEach(() => {
  resetUpdatesForTests();
  mockSetUpdateReply(null);
  mockResetOpenedUrls();
});
afterEach(() => {
  cleanup();
  resetUpdatesForTests();
  mockSetUpdateReply(null);
  mockResetOpenedUrls();
});

describe("from the menu, every outcome is shown", () => {
  it("offers a newer release and hands its installer to the browser", async () => {
    mockSetUpdateReply(NEWER);
    render(<UpdatePrompt />);
    let done: Promise<unknown> = Promise.resolve();
    act(() => {
      done = checkForUpdates("menu");
    });
    expect(screen.getByTestId("updates-title").textContent).toBe("Checking for updates");
    expect(screen.getByTestId("updates-ok")).toBeDisabled();
    await act(() => done);
    expect(screen.getByTestId("updates-title").textContent).toBe("Heeler 2026.2 is available");
    expect(screen.getByTestId("updates-body").textContent).toContain("running Heeler 2026.1");
    expect(screen.getByTestId("updates-notes").textContent).toBe("Fixes the brush cursor.");
    // The menu is an explicit question, so there is nothing to skip.
    expect(screen.queryByTestId("updates-skip")).toBeNull();
    fireEvent.click(screen.getByTestId("updates-download"));
    expect(mockOpenedUrls).toEqual([NEWER.url]);
    expect(screen.queryByTestId("updates-dialog")).toBeNull();
  });

  it("draws a bullet list of notes as a list in a box that scrolls rather than grows (2026-09-16)", async () => {
    mockSetUpdateReply({ ...NEWER, notes: "- The depth axis reads as the depth map.\n- A click drops a point.\n\n- Three." });
    render(<UpdatePrompt />);
    await checkForUpdates("menu");
    const box = screen.getByTestId("updates-notes");
    expect(box.querySelectorAll("li").length).toBe(3);
    expect(box.querySelectorAll("li")[1].textContent).toBe("A click drops a point.");
    expect(box.style.maxHeight).toBe("220px");
    expect(box.style.overflowY).toBe("auto");
  });

  it("keeps a plain paragraph's line breaks", async () => {
    mockSetUpdateReply({ ...NEWER, notes: "First line.\nSecond line." });
    render(<UpdatePrompt />);
    await checkForUpdates("menu");
    const p = screen.getByTestId("updates-notes").querySelector("p")!;
    expect(p.textContent).toBe("First line.\nSecond line.");
    expect(p.style.whiteSpace).toBe("pre-wrap");
  });

  it("says up to date, and closes on OK", async () => {
    mockSetUpdateReply(SAME);
    render(<UpdatePrompt />);
    await checkForUpdates("menu");
    expect(screen.getByTestId("updates-title").textContent).toBe("You're up to date");
    expect(screen.getByTestId("updates-body").textContent).toContain("Heeler 2026.1 is the newest release");
    fireEvent.click(screen.getByTestId("updates-ok"));
    expect(screen.queryByTestId("updates-dialog")).toBeNull();
    expect(mockOpenedUrls).toEqual([]);
  });

  it("says when the release list cannot be reached, with the reason in small print", async () => {
    render(<UpdatePrompt />);
    const outcome = await checkForUpdates("menu");
    expect(outcome.kind).toBe("unreachable");
    expect(screen.getByTestId("updates-title").textContent).toBe("Could not check for updates");
    expect(screen.getByTestId("updates-detail").textContent).toContain("could not reach the release list");
  });

  it("stays closed when the user closed it while the check was out", async () => {
    mockSetUpdateReply(NEWER);
    render(<UpdatePrompt />);
    let done: Promise<unknown> = Promise.resolve();
    act(() => {
      done = checkForUpdates("menu");
    });
    fireEvent.keyDown(screen.getByTestId("updates-dialog"), { key: "Escape" });
    expect(screen.queryByTestId("updates-dialog")).toBeNull();
    await act(() => done);
    expect(updatePrompt()).toBeNull();
    expect(screen.queryByTestId("updates-dialog")).toBeNull();
  });

  it("reports a skipped version too: a question gets its answer", async () => {
    mockSetUpdateReply(NEWER);
    localStorage.setItem("heeler.updates.skip", "2026.2");
    render(<UpdatePrompt />);
    await checkForUpdates("menu");
    expect(screen.getByTestId("updates-title").textContent).toBe("Heeler 2026.2 is available");
  });
});

describe("at launch, only a newer release speaks", () => {
  it("shows a newer release with a way to skip it", async () => {
    mockSetUpdateReply(NEWER);
    render(<UpdatePrompt />);
    await checkForUpdates("launch");
    await waitFor(() => expect(screen.getByTestId("updates-title").textContent).toBe("Heeler 2026.2 is available"));
    fireEvent.click(screen.getByTestId("updates-skip"));
    expect(skippedVersion()).toBe("2026.2");
    expect(screen.queryByTestId("updates-dialog")).toBeNull();
  });

  it("stays silent for a skipped version, up to date, or no network", async () => {
    render(<UpdatePrompt />);
    await checkForUpdates("launch");
    expect(screen.queryByTestId("updates-dialog")).toBeNull();
    mockSetUpdateReply(SAME);
    await checkForUpdates("launch");
    expect(screen.queryByTestId("updates-dialog")).toBeNull();
    mockSetUpdateReply(NEWER);
    localStorage.setItem("heeler.updates.skip", "2026.2");
    await checkForUpdates("launch");
    expect(screen.queryByTestId("updates-dialog")).toBeNull();
    // A release after the skipped one is news again.
    mockSetUpdateReply({ ...NEWER, latest: "2026.3" });
    await checkForUpdates("launch");
    expect(screen.getByTestId("updates-title").textContent).toBe("Heeler 2026.3 is available");
  });

  it("Later closes the launch prompt without skipping", async () => {
    mockSetUpdateReply(NEWER);
    render(<UpdatePrompt />);
    await checkForUpdates("launch");
    fireEvent.click(screen.getByTestId("updates-later"));
    expect(screen.queryByTestId("updates-dialog")).toBeNull();
    expect(skippedVersion()).toBeNull();
  });
});

describe("the launch check follows its preference", () => {
  it("runs unless the saved settings say not to", () => {
    expect(launchCheckWanted(null)).toBe(true);
    expect(launchCheckWanted("not json")).toBe(true);
    expect(launchCheckWanted(JSON.stringify({ prefs: {} }))).toBe(true);
    expect(launchCheckWanted(JSON.stringify({ prefs: { checkUpdatesOnLaunch: true } }))).toBe(true);
    expect(launchCheckWanted(JSON.stringify({ prefs: { checkUpdatesOnLaunch: false } }))).toBe(false);
  });
});

// Docs review 2026-10-01: the dialog said Download hands the installer
// to the browser, while the Help menu's hint and the launch-check
// preference said it opens the release page. The code decides: a newer
// release is offered only with this platform's installer link
// (update.rs assess), and Download opens that link. All three say so.
describe("the dialog, the menu hint and the preference say the same thing", () => {
  it("Download hands the installer to the browser, in all three", async () => {
    mockSetUpdateReply(NEWER);
    render(<UpdatePrompt />);
    await act(() => checkForUpdates("menu"));
    const dialog = screen.getByTestId("updates-body").textContent ?? "";
    cleanup();
    resetUpdatesForTests();
    render(<App />);
    await new Promise((r) => setTimeout(r, 30));
    fireEvent.click(screen.getByTestId("menu-help"));
    const menu = screen.getByTestId("menu-help-updates").parentElement!.getAttribute("data-hint") ?? "";
    const pref = settingDescription("check-updates") ?? "";
    for (const words of [dialog, menu, pref]) {
      expect(words).toContain("Download hands the installer to your browser.");
      expect(words).toContain("Nothing is installed until you open it.");
      expect(words).toContain(UPDATE_DOWNLOAD_WORDS);
      expect(words).not.toMatch(/release page|download page/);
    }
    // The menu hint leads with the outcome and fits a menu hint.
    expect(menu).toMatch(/^Find out whether a newer Heeler exists\./);
    expect(menu.length).toBeLessThanOrEqual(165);
  });
});
