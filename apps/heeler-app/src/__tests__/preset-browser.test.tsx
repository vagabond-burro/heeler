// Subject 3, the browser seam: bridge.ts answers the preset calls
// itself when no Tauri runtime is behind it, and the Presets tab has to
// live with those answers. These tests run against the REAL bridge (no
// vi.mock): vitest's jsdom has no Tauri globals, so isTauri() is false
// and every call takes the browser path. That path exists so the app
// can be developed and demoed in a plain browser; what it promises is
// "nothing crashes, nothing pretends to persist".

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { initialState } from "../data";
import { capturePreset } from "../state";
import { presetExport, presetImport, presetList, presetRead, presetSave, presetTrash } from "../bridge";
import { PresetsTab } from "../ui/simple";

describe("the preset bridge in the browser", () => {
  it("lists nothing, reads nothing, and says so rather than pretending", async () => {
    // An empty library, not an error: the tab's first paint depends on
    // this resolving.
    await expect(presetList()).resolves.toEqual([]);
    // A read can never work (there is no file store), and the error
    // names the limitation because the tab flashes it verbatim.
    await expect(presetRead(true, "0")).rejects.toThrow("no preset store in the browser");
  });

  it("accepts writes and drops them: save, trash, import, export", async () => {
    const preset = capturePreset(initialState(), "Browser Look");
    // Save "works" and returns a path-shaped string, but nothing
    // persists: the next list is still empty. The string exists so the
    // tab's flash ("Saved ...") has something true to say happened to
    // the call, not to claim a file exists.
    await expect(presetSave("Trips", "Browser Look", preset)).resolves.toBe("mock-preset-path");
    await expect(presetList()).resolves.toEqual([]);
    await expect(presetTrash("/any/path.heelerpreset")).resolves.toBeUndefined();
    await expect(presetImport()).resolves.toEqual({ imported: [], failed: [] });
    await expect(presetExport(false, "/any/path", "Browser Look")).resolves.toBeNull();
  });

  it("the tab renders the empty library without crashing", async () => {
    render(<PresetsTab state={initialState()} dispatch={() => {}} />);
    // Both roots mount; with an empty list the user root shows its
    // guidance line instead of a tree.
    expect(await screen.findByTestId("preset-root-builtin")).toBeTruthy();
    expect(screen.getByTestId("preset-root-user")).toBeTruthy();
    expect(await screen.findByText(/Nothing saved yet/)).toBeTruthy();
    // The save and import affordances are still there: in the browser
    // they no-op through the mock, which beats hiding them.
    expect(screen.getByTestId("preset-save-open")).toBeTruthy();
    expect(screen.getByTestId("preset-import")).toBeTruthy();
  });
});
