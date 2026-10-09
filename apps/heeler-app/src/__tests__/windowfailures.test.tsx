import { render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { App } from "../app";
import { loadUiSettings, saveUiSettings } from "../bridge";
import { initialState } from "../data";
import { uiSettingsSnapshot } from "../settings";
import { layoutSnapshot } from "../state";
import { _clearFlashForTests, currentFlash } from "../ui/hints";
import { followPopout, openSpectrumWindow } from "../popout";
import * as bridge from "../bridge";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

afterEach(() => { vi.restoreAllMocks(); _clearFlashForTests(); });

it.each(["graph", "spectrums", "takes", "bend", "console", "curves"])("a restored %s popup blocked by the browser returns its controls to the main window", async kind => {
  vi.spyOn(window, "open").mockReturnValue(null);
  const state = initialState();
  const layout = layoutSnapshot(state);
  if (kind === "curves") layout.popouts.tools.curves = true;
  else (layout.popouts as unknown as Record<string, boolean>)[kind] = true;
  await saveUiSettings(JSON.stringify({ ...uiSettingsSnapshot(state), layout }));
  render(<App />);
  await waitFor(async () => {
    const saved = JSON.parse((await loadUiSettings())!);
    const flag = kind === "curves" ? saved.layout.popouts.tools.curves : saved.layout.popouts[kind];
    expect(flag).toBe(false);
    if (kind === "graph") expect(saved.layout.inspectorHome).toBe("main");
  });
});

it("a rejected native window creation restores the docked controls and explains the failure", async () => {
  vi.spyOn(bridge, "isTauri").mockReturnValue(true);
  vi.mocked(invoke).mockRejectedValueOnce(new Error("window creation failed"));
  const rollback = vi.fn();
  followPopout(true, "Spectrums", openSpectrumWindow, async () => {}, rollback);
  await waitFor(() => expect(rollback).toHaveBeenCalledOnce());
  expect(invoke).toHaveBeenCalledWith("open_popout", expect.objectContaining({ label: "spectrum" }));
  expect(currentFlash()).toContain("Spectrums window could not open");
});

it("a late failure from an obsolete request leaves the newer window choice alone", async () => {
  let reject!: (error: Error) => void;
  const pending = new Promise<void>((_, fail) => { reject = fail; });
  const rollback = vi.fn();
  const cancel = followPopout(true, "Graph", () => pending, async () => {}, rollback);
  cancel();
  reject(new Error("old request failed"));
  await Promise.resolve();
  expect(rollback).not.toHaveBeenCalled();
  expect(currentFlash()).toBeNull();
});
