// A Finish tool leaves with Finish. The owner left Heal armed, went
// back to Adjustments, and could not edit his radial layer until he
// noticed the heal target and put the tool away himself: the brush
// overlay still covered the photograph and took every pointer event.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { App } from "../app";
import { initialState } from "../data";
import { ART_ID, reduce, type Command, type State } from "../state";

const run = (s: State, ...cmds: Command[]) => cmds.reduce(reduce, s);

/** The Finish pane up, a pixel layer on it, and Heal in hand. */
function healingInFinish(): State {
  const s = run(
    initialState(),
    { type: "set_panel_tab", tab: "layers" },
    { type: "art_add_layer", kind: "paint" },
    { type: "set_tool", tool: "heal" },
  );
  expect(s.tool).toBe("heal");
  return s;
}

describe("leaving Finish puts its tool down", () => {
  it("going back to Adjustments", () => {
    const s = run(healingInFinish(), { type: "set_panel_tab", tab: "adjust" });
    expect(s.tool).toBe("none");
    // And coming back finds it down, not re-armed.
    expect(run(s, { type: "set_panel_tab", tab: "layers" }).tool).toBe("none");
  });

  it("every Finish tool, not only heal", () => {
    for (const tool of ["paint", "erase", "clone", "dodge", "burn", "blur", "blend"] as const) {
      let s = run(
        initialState(),
        { type: "set_panel_tab", tab: "layers" },
        { type: "art_add_layer", kind: "paint" },
        { type: "set_tool", tool },
      );
      expect(s.tool, tool).toBe(tool);
      s = run(s, { type: "set_panel_tab", tab: "history" });
      expect(s.tool, tool).toBe("none");
    }
  });

  it("switching to Graph, and leaving the Finish group there", () => {
    expect(run(healingInFinish(), { type: "set_mode", mode: "advanced" }).tool).toBe("none");
    // Inside the Finish group in Graph the toolbar is up, so the tool
    // stays; stepping back out of the group puts it down.
    let g = run(initialState(), { type: "set_mode", mode: "advanced" }, { type: "art_add_layer", kind: "paint" });
    g = run(g, { type: "open_group", id: ART_ID }, { type: "set_tool", tool: "clone" });
    expect(g.tool).toBe("clone");
    expect(run(g, { type: "open_group", id: null }).tool).toBe("none");
  });

  it("picking an adjustment layer or Base, even with Finish still on screen below", () => {
    // The split panel: Finish moved to the bottom pane stays on screen
    // while Adjustments is up top, so the tab change alone keeps the
    // tool. Clicking a layer in Adjustments is the way out there.
    let s = run(healingInFinish(), { type: "move_tab_down", tab: "layers" }, { type: "set_panel_tab", tab: "adjust" });
    expect(s.tool).toBe("heal");
    s = run(s, { type: "add_layer", maskType: "radial" });
    expect(s.activeLayer).not.toBeNull();
    expect(s.tool).toBe("none");
    const radial = s.activeLayer;
    expect(run(s, { type: "set_active_layer", id: radial }).tool).toBe("none");
    expect(run(s, { type: "set_active_layer", id: null }).tool).toBe("none");
  });

  it("tools that are not Finish's own stay armed across the tabs", () => {
    // The selection works in Adjustments too ("can work any
// time").
    const s = run(
      initialState(),
      { type: "set_panel_tab", tab: "layers" },
      { type: "set_tool", tool: "select" },
      { type: "set_panel_tab", tab: "adjust" },
    );
    expect(s.tool).toBe("select");
  });

  it("the brush overlay is gone from the viewer once Adjustments is clicked", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByTestId("panel-tab-layers"));
    await user.click(screen.getByTestId("art-add-content"));
    await user.click(screen.getByTestId("art-tool-repair"));
    expect(screen.getByTestId("brush-overlay")).toBeInTheDocument();
    await user.click(screen.getByTestId("panel-tab-adjust"));
    expect(screen.queryByTestId("brush-overlay")).not.toBeInTheDocument();
  });
});
