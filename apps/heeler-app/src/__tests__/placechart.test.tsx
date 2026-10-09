// The chart tool's arm, pinned at the seats the owner actually
// clicks.
//
// Why these tests mount the whole app and start from a fresh
// photograph: the panel's state carries placeholder cards for unbuilt
// sections, so an off section can still draw its controls, and the chip
// once mistook the placeholder for the real node. It skipped the build,
// the arm reduced to a no-op, and the click read as dead. Every earlier
// test missed it because each one mounted either the bare component or
// the whole app with the bundled demo graph, and the demo graph SHIPS
// the Color Checker node, so the mistaken check found a real node every
// time. A fresh photograph (Edit, Reset all edits) has only the
// placeholder; a bare component mount cannot prove the build-on-touch
// either way, because that bargain lives in the panel's dispatch. Mount
// the app, reset the photo, click the real chip.

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App } from "../app";
import { clearLog, getEntries, setLogLevel } from "../log";
import { _clearFlashForTests } from "../ui/hints";

/** Edit > Reset all edits: the demo photo back to the factory graph,
 * which has no Color Checker node, only the panel's placeholder. */
async function resetToFreshPhoto(): Promise<void> {
  fireEvent.click(screen.getByTestId("menu-edit"));
  fireEvent.click(screen.getByTestId("menu-edit-reset"));
  // The section folds back to factory; the chip stays mounted inside.
  await waitFor(() =>
    expect(screen.getByTestId("colorchecker-place").getAttribute("aria-pressed")).toBe("false"),
  );
}

/** The reduce spine's lines, in the order they were written. */
const reduceLines = () =>
  getEntries()
    .map((e) => e.message)
    .filter((m) => m.startsWith("reduce:"));

describe("Place chart from a fresh photograph", () => {
  beforeEach(async () => {
    const { mockResetSessions } = await import("../bridge");
    mockResetSessions();
  });

  afterEach(() => {
    setLogLevel("info");
    clearLog();
    _clearFlashForTests();
  });

  it("one click on the panel chip builds the section, then arms the tool", async () => {
    render(<App />);
    await resetToFreshPhoto();
    setLogLevel("debug");
    clearLog();
    fireEvent.click(screen.getByTestId("colorchecker-place"));
    await waitFor(() => expect(screen.getByTestId("chart-tool-overlay")).toBeTruthy());
    // The bargain, in order: the build the click stands for lands first,
    // then the arm itself, naming the node it was built for.
    const lines = reduceLines();
    const build = lines.findIndex((m) => m.startsWith("reduce: set_category"));
    const arm = lines.findIndex((m) => m === "reduce: toggle_chart_place id=colorchecker");
    expect(build, `no set_category in:\n${lines.join("\n")}`).toBeGreaterThanOrEqual(0);
    expect(arm, `no arm in:\n${lines.join("\n")}`).toBeGreaterThanOrEqual(0);
    expect(build).toBeLessThan(arm);
    expect(screen.getByTestId("colorchecker-place").getAttribute("aria-pressed")).toBe("true");
    // And the node is real, not the placeholder: the graph workspace
    // draws a card for it.
    fireEvent.click(screen.getByRole("tablist", { name: /workspace mode/i }).children[1]);
    expect(await screen.findByTestId("node-colorchecker")).toBeTruthy();
  });

  it("arms from the graph inspector seat too", async () => {
    render(<App />);
    await resetToFreshPhoto();
    // Build the node from the panel first, then put the tool away, so
    // the graph has a Color Checker to select.
    fireEvent.click(screen.getByTestId("colorchecker-place"));
    await waitFor(() => expect(screen.getByTestId("chart-tool-overlay")).toBeTruthy());
    fireEvent.click(screen.getByTestId("colorchecker-place"));
    await waitFor(() => expect(screen.queryByTestId("chart-tool-overlay")).toBeNull());
    // Graph workspace: the panel seat unmounts, and selecting the node
    // mounts its inspector face with the same chip.
    fireEvent.click(screen.getByRole("tablist", { name: /workspace mode/i }).children[1]);
    fireEvent.mouseDown(await screen.findByTestId("node-colorchecker"));
    const inspectorChip = await screen.findByTestId("colorchecker-place");
    fireEvent.click(inspectorChip);
    await waitFor(() => expect(screen.getByTestId("chart-tool-overlay")).toBeTruthy());
  });
});
