// Halation on the app side: its seat in the chain, its view state, and
// its format menu's param.
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { initialState } from "../data";
import { CATEGORY_PIECES, CHAIN_ORDER } from "../recipes";
import { LAYER_TOOLS, reduce, type Command, type State } from "../state";

const run = (s: State, ...cmds: Command[]) => cmds.reduce(reduce, s);
const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>;

afterEach(() => {
  invokeMock.mockReset();
  delete (window as any).__TAURI_INTERNALS__;
});

describe("halation", () => {
  it("sits after the flare and before the bend, as its own category", () => {
    expect(CHAIN_ORDER.indexOf("halation")).toBe(CHAIN_ORDER.indexOf("flare") + 1);
    expect(CHAIN_ORDER.indexOf("halation")).toBeLessThan(CHAIN_ORDER.indexOf("bend"));
    expect(CATEGORY_PIECES.Halation[0].type).toBe("heeler.halation");
  });

  it("the isolated-regions view is view state, exclusive with the depth view", () => {
    let s = run(initialState(), { type: "toggle_halation_view" });
    expect(s.halationView).toBe(true);
    s = run(s, { type: "toggle_depth_view" });
    expect(s.depthView).toBe(true);
    expect(s.halationView).toBe(false);
    s = run(s, { type: "toggle_halation_view" });
    expect(s.halationView).toBe(true);
    expect(s.depthView).toBe(false);
    // Not undoable: nothing in the photograph changed.
    expect(run(s, { type: "undo" }).halationView).toBe(true);
  });

  it("the demo node carries the format and every dial the section shows", () => {
    const s = initialState();
    const n = s.nodes.find((x) => x.id === "halation")!;
    expect(n.enabled).toBe(false);
    expect(n.textParams?.format).toBe("35mm");
    for (const k of Object.keys(LAYER_TOOLS.halation.params)) expect(n.params).toHaveProperty(k);
  });

  it("the 1:1 patch renders the isolated view, not the frame over it", async () => {
    // renderRoi used to derive its target from maskPreviewNode only, so
    // at 1:1 the sharp patch showed the developed frame while the fit
    // view behind it showed the gate map (or the depth plane).
    (window as any).__TAURI_INTERNALS__ = {};
    invokeMock.mockRejectedValue(new Error("no envelope in a test"));
    const { renderRoi } = await import("../bridge");
    const rect: [number, number, number, number] = [0.1, 0.1, 0.2, 0.2];
    let s = run(initialState(), { type: "toggle_halation_view" });
    await renderRoi(s, rect);
    expect(invokeMock).toHaveBeenCalledWith(
      "render_preview",
      expect.objectContaining({ maskNode: "__halation__" }),
    );
    s = run(s, { type: "toggle_depth_view" });
    await renderRoi(s, rect);
    expect(invokeMock).toHaveBeenLastCalledWith(
      "render_preview",
      expect.objectContaining({ maskNode: "__depth__" }),
    );
    s = run(s, { type: "toggle_depth_view" });
    await renderRoi(s, rect);
    expect(invokeMock).toHaveBeenLastCalledWith(
      "render_preview",
      expect.objectContaining({ maskNode: null }),
    );
  });
});
