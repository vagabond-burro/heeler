// Every picker that reads the photograph wears the same cursor: the
// eyedropper. 2026-09-07: "every instance of the picker does not use
// the same cursor. Some use the classic picker, which I prefer,
// others use the crosshair." Seven arms, one cursor, checked here so
// the next picker cannot arrive with a crosshair of its own.

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("../bridge", async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return { ...real, sampleImage: vi.fn(() => new Promise(() => {})) };
});

import { Viewer } from "../ui/viewer";
import { initialState } from "../data";
import { reduce, type Command, type State } from "../state";
import { PICK_CURSOR } from "../ui/cursors";

const run = (s: State, ...cmds: Command[]) => cmds.reduce(reduce, s);

function renderViewer(state: State) {
  return render(
    <Viewer
      state={state}
      dispatch={() => {}}
      previewUrl="data:image/png;base64,x"
      previewError={null}
      previewMs={null}
      previewBackend={null}
      originalUrl={null}
      maskUrl={null}
      multiFrames={{}}
    />,
  );
}

const ARMED: { overlay: string; cmds: Command[] }[] = [
  { overlay: "wb-pick-overlay", cmds: [{ type: "arm_wb_pick", id: "stdcolor" }] },
  { overlay: "curve-pick-overlay", cmds: [{ type: "set_category", title: "Curves", on: true }, { type: "arm_curve_pick", nodeId: "curves", channel: "rgb" }] },
  { overlay: "tone-eq-pick-overlay", cmds: [{ type: "set_category", title: "Relight", on: true }, { type: "toggle_tone_eq_pick", id: "toneeq" }] },
  { overlay: "recolor-pick-overlay", cmds: [{ type: "set_category", title: "Recolor", on: true }, { type: "toggle_recolor_pick", id: "recolor" }] },
  { overlay: "recolor-match-overlay", cmds: [{ type: "set_category", title: "Recolor", on: true }, { type: "toggle_recolor_match", id: "recolor" }] },
  { overlay: "console-pick-overlay", cmds: [{ type: "set_category", title: "Color Tune", on: true }, { type: "toggle_console_pick", id: "colorconsole" }] },
  { overlay: "pick-overlay", cmds: [{ type: "set_tool", tool: "pick" }] },
];

describe("the pickers' cursor", () => {
  it("is the eyedropper on every one of them, not the crosshair", () => {
    expect(PICK_CURSOR).toContain("data:image/svg+xml");
    expect(PICK_CURSOR.endsWith(", crosshair")).toBe(true);
    for (const { overlay, cmds } of ARMED) {
      const s = run(initialState(), ...cmds);
      const view = renderViewer(s);
      const el = screen.getByTestId(overlay);
      expect(el.getAttribute("style"), overlay).toContain("data:image/svg+xml");
      expect(el.getAttribute("style"), overlay).not.toMatch(/cursor:\s*(crosshair|ns-resize)/);
      view.unmount();
    }
  });
});
