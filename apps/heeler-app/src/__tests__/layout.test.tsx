import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../app";
import { loadUiSettings, saveUiSettings } from "../bridge";
import { initialState } from "../data";
import { uiSettingsCommands, uiSettingsSnapshot } from "../settings";
import { DEFAULT_PANEL_SIZES, layoutSnapshot, reduce, type Command, type State } from "../state";

const run = (s: State, ...cmds: Command[]) => cmds.reduce(reduce, s);

/* (2026-09-09): "Heeler should remember its last UI state of the
 * elements": the Library, the thumbnail strip, the workspace, the
 * panels and every pop-out.*/
describe("the remembered layout", () => {
  afterEach(async () => {
    await saveUiSettings("{}");
  });

  it("snapshots the frame around the photograph and comes back through the settings file", async () => {
    let s = run(
      initialState(),
      { type: "toggle_browser" },
      { type: "set_ribbon_view", view: "list" },
      { type: "set_mode", mode: "advanced" },
      { type: "set_panel_size", panel: "library", size: 300 },
      { type: "set_panel_size", panel: "libraryTree", size: 240 },
      { type: "set_panel_size", panel: "ribbon", size: 200 },
      { type: "set_spectrums_popped_out", out: true },
      { type: "set_takes_popped_out", out: true },
      { type: "set_tool_popped_out", tool: "curves", out: true },
      { type: "set_console_window", open: true },
    );
    const layout = layoutSnapshot(s);
    expect(layout.browserOpen).toBe(false);
    expect(layout.ribbonView).toBe("list");
    expect(layout.mode).toBe("advanced");
    expect(layout.panelSizes.library).toBe(300);
    expect(layout.popouts).toMatchObject({ spectrums: true, takes: true, console: true, tools: { curves: true } });

    await saveUiSettings(JSON.stringify(uiSettingsSnapshot(s)));
    const restored = uiSettingsCommands(await loadUiSettings()).reduce(reduce, initialState());
    expect(restored.browserOpen).toBe(false);
    expect(restored.ribbonView).toBe("list");
    expect(restored.mode).toBe("advanced");
    expect(restored.panelSizes.library).toBe(300);
    expect(restored.panelSizes.libraryTree).toBe(240);
    expect(restored.panelSizes.ribbon).toBe(200);
    expect(restored.spectrumsPoppedOut).toBe(true);
    expect(restored.takesPoppedOut).toBe(true);
    expect(restored.toolPopouts.curves).toBe(true);
    expect(restored.consoleWindowOpen).toBe(true);
    s = restored;
  });

  it("checks every field on the way back, so a hand-edited or older file restores what it can", () => {
    const s = reduce(initialState(), {
      type: "restore_layout",
      layout: {
        browserOpen: "no" as unknown as boolean,
        ribbonView: "grid" as unknown as "list",
        mode: "poster" as unknown as "canvas",
        panelSizes: { library: 9999, right: -5, libraryTree: Number.NaN, rightSplit: 0 } as never,
        panelTab: "nowhere" as never,
        panelBottom: ["history", "nowhere"] as never,
        popouts: { graph: true, tools: { curves: "yes", nothere: true } } as never,
      },
    });
    expect(s.browserOpen).toBe(true);
    expect(s.ribbonView).toBe("thumbs");
    expect(s.mode).toBe("simple");
    expect(s.panelSizes.library).toBe(420);
    expect(s.panelSizes.right).toBe(260);
    expect(s.panelSizes.libraryTree).toBe(DEFAULT_PANEL_SIZES.libraryTree);
    expect(s.panelSizes.rightSplit).toBe(0);
    expect(s.panelTab).toBe("adjust");
    expect(s.panelBottom).toEqual(["history"]);
    expect(s.graphPoppedOut).toBe(true);
    expect(s.inspectorHome).toBe("graph");
    expect(s.toolPopouts.curves).toBe(false);
    // An older file with no layout at all changes nothing.
    expect(uiSettingsCommands(JSON.stringify({ prefs: {} })).some((c) => c.type === "restore_layout")).toBe(false);
    const fresh = initialState();
    expect(reduce(fresh, { type: "restore_layout", layout: null as never })).toBe(fresh);
  });

  it("Bring all windows back docks every pop-out and Reset layout puts the frame back", () => {
    let s = run(
      initialState(),
      { type: "set_graph_popped_out", out: true },
      { type: "set_spectrums_popped_out", out: true },
      { type: "set_takes_popped_out", out: true },
      { type: "set_bend_popped_out", out: true },
      { type: "set_tool_popped_out", tool: "wheels", out: true },
      { type: "set_console_window", open: true },
      { type: "toggle_browser" },
      { type: "set_ribbon_view", view: "list" },
      { type: "set_panel_size", panel: "right", size: 500 },
    );
    const docked = reduce(s, { type: "dock_all_windows" });
    expect(docked.graphPoppedOut).toBe(false);
    expect(docked.inspectorHome).toBe("main");
    expect(docked.spectrumsPoppedOut).toBe(false);
    expect(docked.takesPoppedOut).toBe(false);
    expect(docked.bendPoppedOut).toBe(false);
    expect(docked.toolPopouts.wheels).toBe(false);
    expect(docked.consoleWindowOpen).toBe(false);
    // The frame is left as it was: that is Reset layout's job.
    expect(docked.browserOpen).toBe(false);
    expect(docked.panelSizes.right).toBe(500);
    const reset = reduce(docked, { type: "reset_layout" });
    expect(reset.browserOpen).toBe(true);
    expect(reset.ribbonView).toBe("thumbs");
    expect(reset.panelSizes).toEqual(DEFAULT_PANEL_SIZES);
    expect(reset.panelTab).toBe("adjust");
    s = reset;
  });

  it("the app comes back as it was left: the library collapsed, the Graph workspace, the spectrums out", async () => {
    const left = run(
      initialState(),
      { type: "toggle_browser" },
      { type: "set_mode", mode: "advanced" },
      { type: "set_spectrums_popped_out", out: true },
    );
    await saveUiSettings(JSON.stringify(uiSettingsSnapshot(left)));
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("mode-advanced")).toHaveAttribute("aria-pressed", "true"));
    expect(screen.queryByTestId("browser-panel")).not.toBeInTheDocument();
    // The spectrums are out: the panel shows the folded bar, not the plots.
    await waitFor(() => expect(screen.getByTestId("spectrum-bar")).toBeInTheDocument());
  });

  it("the Window menu switches the frame and docks everything", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByTestId("menu-window"));
    expect(screen.getByTestId("menu-window-library")).toHaveAttribute("aria-checked", "true");
    expect(screen.getByTestId("menu-window-mode-simple")).toHaveAttribute("aria-checked", "true");
    // The graph pop-out waits for the Graph or Canvas workspace.
    expect(screen.getByTestId("menu-window-graph")).toBeDisabled();
    await user.click(screen.getByTestId("menu-window-library"));
    expect(screen.queryByTestId("browser-panel")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("menu-window"));
    await user.click(screen.getByTestId("menu-window-spectrums"));
    expect(screen.getByTestId("spectrum-bar")).toBeInTheDocument();
    await user.click(screen.getByTestId("menu-window"));
    expect(screen.getByTestId("menu-window-spectrums")).toHaveAttribute("aria-checked", "true");
    await user.click(screen.getByTestId("menu-window-dock-all"));
    await act(async () => {});
    expect(screen.queryByTestId("spectrum-bar")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("menu-window"));
    await user.click(screen.getByTestId("menu-window-reset-layout"));
    expect(screen.getByTestId("browser-panel")).toBeInTheDocument();
  });
});

it("restores the Inspector's chosen home while the graph stays popped out", () => {
  const left = run(initialState(), { type: "set_graph_popped_out", out: true }, { type: "set_inspector_home", home: "main" });
  const restored = uiSettingsCommands(JSON.stringify(uiSettingsSnapshot(left))).reduce(reduce, initialState());
  expect(restored.graphPoppedOut).toBe(true);
  expect(restored.inspectorHome).toBe("main");
});

it("the Graph window can still be brought back after switching to Develop", async () => {
  const user = userEvent.setup();
  const left = run(initialState(), { type: "set_graph_popped_out", out: true });
  await saveUiSettings(JSON.stringify(uiSettingsSnapshot(left)));
  render(<App />);
  await user.click(screen.getByTestId("menu-window"));
  expect(screen.getByTestId("menu-window-graph")).toHaveAttribute("aria-checked", "true");
  expect(screen.getByTestId("menu-window-graph")).toBeEnabled();
});

it("the browser keeps Center main window visible but disabled with a reason", async () => {
  render(<App />);
  await userEvent.click(screen.getByTestId("menu-window"));
  const center = screen.getByTestId("menu-window-center");
  expect(center).toBeDisabled();
  expect(center.parentElement).toHaveAttribute("data-hint", expect.stringContaining("desktop app"));
});

/* The owner left the Magnetic selection armed, relaunched, and the app
 * came back with the Magnetic cursor and the Selection panel up over
 * no selection. The tool in hand is session state now; the method
 * chosen on the bar is still remembered.*/
it("a relaunch opens on the cursor with the Selection panel away, the method kept", async () => {
  const left = run(
    initialState(),
    { type: "set_select_method", method: "magnetic" },
    { type: "arm_document_selection" },
  );
  expect(left.tool).toBe("select");
  const snapshot = uiSettingsSnapshot(left);
  expect("tool" in snapshot).toBe(false);
  // An older settings file that still carries the tool is ignored.
  await saveUiSettings(JSON.stringify({ ...snapshot, tool: "select" }));
  const restored = uiSettingsCommands(await loadUiSettings()).reduce(reduce, initialState());
  expect(restored.tool).toBe("none");
  expect(restored.selectMethod).toBe("magnetic");
  render(<App />);
  await act(async () => {});
  expect(screen.queryByTestId("selection-split")).not.toBeInTheDocument();
  expect(screen.queryByTestId("selection-split-bar")).not.toBeInTheDocument();
  await saveUiSettings("{}");
});
