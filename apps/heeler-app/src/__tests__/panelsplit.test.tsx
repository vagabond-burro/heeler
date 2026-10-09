// Splitting the right panel, and knowing when to stop being split.
//
// "I should be able to right click on a tab and have the
// option to Split the right panel vertically and move the second tab down
// to its own view. Then other tabs I can move down as well, do not split
// that panel more than twice. Make sure the UI is smart so if someone
// splits the panel to move down history. Then they move the other 3 tabs
// to the bottom split it is smart enough to collapse the top split and
// basically restore the right panel to what it should be."

import { fireEvent, render, screen } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initialState } from "../data";
import { setExperimentalForTests } from "../features";
import { PANEL_TABS, reduce, type Command, type PanelTab, type State } from "../state";
import { SimplePanel } from "../ui/simple";

const run = (s: State, ...cmds: Command[]) => cmds.reduce(reduce, s);

// These tests move the Tether tab as one tab among many, which the
// experimental gate now forbids with default prefs. The gate itself is
// pinned in tether.test.tsx; here it is simply open.
beforeAll(() => setExperimentalForTests(true));
afterAll(() => setExperimentalForTests(null));

/** Renders the panel and hands back whatever it dispatched. */
const mount = (s: State) => {
  const sent: Command[] = [];
  render(<SimplePanel state={s} dispatch={((c: Command) => sent.push(c)) as never} />);
  return sent;
};
const down = (tab: PanelTab): Command => ({ type: "move_tab_down", tab });
const up = (tab: PanelTab): Command => ({ type: "move_tab_up", tab });

describe("moving a tab into a second pane", () => {
  it("starts unsplit", () => {
    expect(initialState().panelBottom).toEqual([]);
  });

  it("the first move makes the split and takes the tab with it", () => {
    const s = run(initialState(), down("history"));
    expect(s.panelBottom).toEqual(["history"]);
    expect(s.panelTabBottom).toBe("history");
    // The tab that left cannot still be the one showing above it.
    expect(s.panelTab).not.toBe("history");
  });

  it("later moves join the pane that already exists", () => {
    const s = run(initialState(), down("history"), down("presets"));
    expect(s.panelBottom).toEqual(["history", "presets"]);
    // Kept in the strip's own order rather than the order they were
    // moved, so the tabs do not shuffle about under the pointer.
    expect(s.panelBottom).toEqual(
      PANEL_TABS.filter((t) => s.panelBottom.includes(t.id)).map((t) => t.id),
    );
  });

  it("moving the same tab twice does nothing the second time", () => {
    const once = run(initialState(), down("history"));
    expect(run(once, down("history"))).toEqual(once);
  });

  it("never makes a third pane, because there is nowhere to put one", () => {
    // "do not split that panel more than twice." Two
    // panes is the whole model, so there is no third to refuse.
    let s = initialState();
    for (const t of PANEL_TABS) s = run(s, down(t.id));
    const total = s.panelBottom.length + PANEL_TABS.filter((t) => !s.panelBottom.includes(t.id)).length;
    expect(total).toBe(PANEL_TABS.length);
  });
});

describe("it knows when the split has stopped meaning anything", () => {
  it("collapses when the last tab leaves the top", () => {
    // The owner's exact walk: split to move History down, then move
    // the other three down as well.
    let s = run(initialState(), down("history"));
    expect(s.panelBottom).toEqual(["history"]);
    s = run(s, down("adjust"), down("presets"), down("layers"), down("tether"));
    // Kept in PANEL_TABS order, not arrival order.
    expect(s.panelBottom).toEqual(["adjust", "layers", "history", "presets", "tether"]);
    // The last one empties the top pane, so there is no split left to
    // be: an empty box above a full one is not a layout.
    s = run(s, down("metadata"));
    expect(s.panelBottom).toEqual([]);
    // And it shows the tab that was moved last, which is the one the
    // person was looking at.
    expect(s.panelTab).toBe("metadata");
  });

  it("collapses the other way too, when the last tab comes back up", () => {
    let s = run(initialState(), down("history"));
    s = run(s, up("history"));
    expect(s.panelBottom).toEqual([]);
    expect(s.panelTab).toBe("history");
  });

  it("keeps the split while either pane still has something in it", () => {
    const s = run(initialState(), down("history"), down("presets"), up("history"));
    expect(s.panelBottom).toEqual(["presets"]);
    expect(s.panelTab).toBe("history");
    expect(s.panelTabBottom).toBe("presets");
  });

  it("moves the lower pane's active tab along when it is the one leaving", () => {
    let s = run(initialState(), down("history"), down("presets"));
    expect(s.panelTabBottom).toBe("presets");
    s = run(s, up("presets"));
    // Presets went up, so the pane below shows what is left rather than a
    // tab that is no longer in it.
    expect(s.panelTabBottom).toBe("history");
  });

  it("moving a tab up that was never down does nothing", () => {
    const s = initialState();
    expect(run(s, up("presets"))).toEqual(s);
  });
});

describe("the panel on screen", () => {
  it("shows one pane and no seam until it is split", () => {
    mount(initialState());
    expect(screen.getByTestId("panel-pane-top")).toBeInTheDocument();
    expect(screen.queryByTestId("panel-pane-bottom")).not.toBeInTheDocument();
    expect(screen.queryByTestId("divider-right-split")).not.toBeInTheDocument();
    // Every tab is in the one strip.
    for (const t of PANEL_TABS) {
      expect(screen.getByTestId(`panel-tab-${t.id}`)).toBeInTheDocument();
    }
  });

  it("shows two strips and a seam once it is", () => {
    mount(run(initialState(), down("history")));
    expect(screen.getByTestId("panel-tabs")).toBeInTheDocument();
    expect(screen.getByTestId("panel-tabs-bottom")).toBeInTheDocument();
    expect(screen.getByTestId("divider-right-split")).toBeInTheDocument();
    // The moved tab is in the lower strip and not the upper one.
    const bottom = screen.getByTestId("panel-tabs-bottom");
    expect(bottom.querySelector('[data-testid="panel-tab-history"]')).toBeTruthy();
    const top = screen.getByTestId("panel-tabs");
    expect(top.querySelector('[data-testid="panel-tab-history"]')).toBeNull();
  });

  it("offers the split from a right-click, and says what it will do", () => {
    const sent = mount(initialState());
    fireEvent.contextMenu(screen.getByTestId("panel-tab-history"), { clientX: 40, clientY: 60 });
    // The first one splits; the wording says so rather than saying "move
    // down" into a pane that does not exist.
    expect(screen.getByTestId("tab-menu-down")).toHaveTextContent(/split panel/i);
    fireEvent.click(screen.getByTestId("tab-menu-down"));
    expect(sent).toEqual([{ type: "move_tab_down", tab: "history" }]);
  });

  it("offers plain Move Down once the pane is there", () => {
    mount(run(initialState(), down("history")));
    fireEvent.contextMenu(screen.getByTestId("panel-tab-presets"), { clientX: 40, clientY: 60 });
    expect(screen.getByTestId("tab-menu-down")).toHaveTextContent(/^Move Down$/);
  });

  it("offers the way back from a tab that is already down", () => {
    const sent = mount(run(initialState(), down("history")));
    const bottom = screen.getByTestId("panel-tabs-bottom");
    fireEvent.contextMenu(bottom.querySelector('[data-testid="panel-tab-history"]')!, {
      clientX: 40,
      clientY: 200,
    });
    expect(screen.getByTestId("tab-menu-up")).toHaveTextContent(/move back up/i);
    fireEvent.click(screen.getByTestId("tab-menu-up"));
    expect(sent).toEqual([{ type: "move_tab_up", tab: "history" }]);
  });

  it("renders a pane whose stored active tab has moved away", () => {
    // panelTab still names Adjustments after it has been moved down, and a
    // pane that renders nothing at all would look broken.
    const s = { ...run(initialState(), down("adjust")), panelTab: "adjust" as PanelTab };
    mount(s);
    expect(screen.getByTestId("panel-pane-top")).toBeInTheDocument();
    // The upper strip fell back to its own first tab.
    const top = screen.getByTestId("panel-tabs");
    expect(top.querySelector('[data-active="true"]')).toBeTruthy();
  });

  it("keeps the develop controls mounted when its pane shows another tab", () => {
    // Switching tabs and coming back has to keep the scroll position and
    // every open section, which is why the body is hidden rather than
    // unmounted.
    mount({ ...initialState(), panelTab: "history" });
    const sections = screen.getByTestId("simple-panel").querySelector('[data-testid="layers-section"], .panel-right');
    expect(sections).toBeTruthy();
    // Adjustments is present in the tree while History is on show.
    expect(screen.getByTestId("panel-tab-adjust")).toBeInTheDocument();
  });
});

describe("the seam between the panes", () => {
  /// "I split the panel but it did not split in half, the
  /// bottom split is taking up the most room. And I can't resize it."
  it("starts even rather than at a fixed height", () => {
    // A fixed top pane against a bottom one that takes everything else is a
    // sliver on a tall window. Zero means nobody has dragged it, and both
    // panes take flex: 1.
    expect(initialState().panelSizes.rightSplit).toBe(0);
    mount(run(initialState(), down("history")));
    const top = screen.getByTestId("panel-pane-top");
    const bottom = screen.getByTestId("panel-pane-bottom");
    // jsdom expands the shorthand, so both panes read as "1 1 0%": grow,
    // shrink, and no fixed basis, which is an even split.
    expect(top.style.flex).toBe(bottom.style.flex);
    expect(top.style.flexGrow).toBe("1");
    expect(bottom.style.flexGrow).toBe("1");
    expect(top.style.height).toBe("");
  });

  it("takes a dragged height once there is one", () => {
    const s = run(
      initialState(),
      down("history"),
      { type: "set_panel_size", panel: "rightSplit", size: 300 },
    );
    expect(s.panelSizes.rightSplit).toBe(300);
    mount(s);
    const top = screen.getByTestId("panel-pane-top");
    expect(top.style.height).toBe("300px");
    // Not growing: the height is the height.
    expect(top.style.flexGrow).toBe("0");
  });

  it("keeps the seam inside sensible bounds", () => {
    const s = run(initialState(), down("history"));
    expect(
      run(s, { type: "set_panel_size", panel: "rightSplit", size: 5 }).panelSizes.rightSplit,
    ).toBeGreaterThan(100);
    expect(
      run(s, { type: "set_panel_size", panel: "rightSplit", size: 99999 }).panelSizes.rightSplit,
    ).toBeLessThan(1000);
  });

  it("drags from the pane's measured height, not a remembered one", () => {
    // The bug: the drag handler is registered once on mousedown and closed
    // over the render it was made in, so every delta was added to the same
    // stale number and the seam sprang back. Reading the pane's own height
    // at event time is what app.tsx's dividers do through a ref.
    const sent: Command[] = [];
    render(
      <SimplePanel
        state={run(initialState(), down("history"))}
        dispatch={((c: Command) => sent.push(c)) as never}
      />,
    );
    const top = screen.getByTestId("panel-pane-top");
    Object.defineProperty(top, "offsetHeight", { value: 420, configurable: true });

    const seam = screen.getByTestId("divider-right-split");
    fireEvent.mouseDown(seam, { clientY: 500 });
    fireEvent(window, new MouseEvent("mousemove", { clientY: 530 }));
    fireEvent(window, new MouseEvent("mouseup"));

    const resize = sent.find((c) => c.type === "set_panel_size");
    expect(resize, "the drag should have asked for a resize").toBeTruthy();
    // 420 measured plus the 30 pixels the pointer moved, rather than
    // whatever the state happened to hold when the handler was made.
    expect(resize).toEqual({ type: "set_panel_size", panel: "rightSplit", size: 450 });
  });

  it("is a horizontal seam, since the panes are stacked", () => {
    mount(run(initialState(), down("history")));
    expect(screen.getByTestId("divider-right-split")).toHaveAttribute(
      "aria-orientation",
      "horizontal",
    );
  });
});
