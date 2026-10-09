// The thumbnail panel: draggable, switchable, and expandable into a table.
//
// "I should be able to resize the panel horizontally which
// should cause the thumbnails to scale (also means less would be visible
// but that's the trade off). We also need to be able to switch between
// thumbnail and list view. I would also like to be able to maximize/expand
// the thumbnail panel. This would hide the viewport, but it would reveal
// metadata sorted by columns for each image."

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { initialState } from "../data";
import {
  META_COLUMNS,
  RIBBON_MAX,
  RIBBON_MIN,
  reduce,
  thumbCell,
  type Command,
  type State,
} from "../state";
import { cellText, sortRows } from "../ui/ribbontable";
import type { ImageMeta } from "../bridge";

const run = (s: State, ...cmds: Command[]) => cmds.reduce(reduce, s);

const meta = (over: Partial<ImageMeta> = {}): ImageMeta => ({
  id: "img_1",
  name: "DSC_0001.arw",
  path: "D:/shoot/DSC_0001.arw",
  size: 40_000_000,
  modified: 0,
  stars: 0,
  flag: "",
  edited: false,
  sidecar: false,
  ...over,
});

describe("dragging the panel scales the thumbnails", () => {
  it("grows the cell with the panel, within the bounds", () => {
    const narrow = thumbCell(RIBBON_MIN);
    const wide = thumbCell(RIBBON_MAX);
    expect(wide.w).toBeGreaterThan(narrow.w);
    // 4:3, not square: most frames are 3:2 and letterbox inside this with
    // a little room, where a square cell would waste a third of the panel
    // on black for every landscape photograph.
    expect(wide.h / wide.w).toBeCloseTo(0.75, 2);
  });

  it("never scales past the bitmap it has", () => {
    // "Limit the max width of the panel?" The thumbnails are
    // rendered once at a fixed size and the panel scales that one bitmap,
    // so the maximum is where it runs out of detail rather than a taste
    // call.
    const past = thumbCell(RIBBON_MAX + 500);
    expect(past).toEqual(thumbCell(RIBBON_MAX));
    // And it stays big enough to be a picture at the other end.
    expect(thumbCell(0).w).toBeGreaterThan(40);
  });

  it("clamps the stored width to the same bounds", () => {
    const s = initialState();
    expect(s.panelSizes.ribbon).toBe(RIBBON_MIN);
    expect(run(s, { type: "set_panel_size", panel: "ribbon", size: 9999 }).panelSizes.ribbon).toBe(
      RIBBON_MAX,
    );
    expect(run(s, { type: "set_panel_size", panel: "ribbon", size: 0 }).panelSizes.ribbon).toBe(
      RIBBON_MIN,
    );
  });

  it("uses customized ribbon bounds", () => {
    let s = run(initialState(), {
      type: "set_prefs",
      prefs: { ribbonMinWidth: 150, ribbonMaxWidth: 520 },
    });
    s = run(s, { type: "set_panel_size", panel: "ribbon", size: 9999 });
    expect(s.panelSizes.ribbon).toBe(520);
    s = run(s, { type: "set_panel_size", panel: "ribbon", size: 0 });
    expect(s.panelSizes.ribbon).toBe(150);
    expect(thumbCell(700, s.prefs.ribbonMaxWidth)).toEqual(thumbCell(520, 520));
  });

  it("starts where it always was, so nothing moves for anyone", () => {
    expect(initialState().panelSizes.ribbon).toBe(124);
  });
});

describe("thumbnails or a list", () => {
  it("starts on thumbnails and switches", () => {
    const s = initialState();
    expect(s.ribbonView).toBe("thumbs");
    expect(run(s, { type: "set_ribbon_view", view: "list" }).ribbonView).toBe("list");
  });

  it("draws a row per photograph in list view and a cell in thumbnails", async () => {
    const { Ribbon } = await import("../ui/chrome");
    const s = initialState();
    const id = s.images[0].id;
    const view = render(<Ribbon state={s} dispatch={() => {}} />);
    expect(screen.getByTestId(`thumb-${id}`)).toBeInTheDocument();
    expect(screen.queryByTestId(`row-${id}`)).not.toBeInTheDocument();
    view.unmount();

    render(<Ribbon state={{ ...s, ribbonView: "list" }} dispatch={() => {}} />);
    expect(screen.getByTestId(`row-${id}`)).toBeInTheDocument();
  });

  it("the switch reports which view was asked for", async () => {
    const { Ribbon } = await import("../ui/chrome");
    const sent: Command[] = [];
    render(<Ribbon state={initialState()} dispatch={((c: Command) => sent.push(c)) as never} />);
    fireEvent.click(screen.getByTestId("ribbon-view-list"));
    expect(sent).toEqual([{ type: "set_ribbon_view", view: "list" }]);
  });
});

describe("expanding takes the window", () => {
  it("swaps the strip for the catalog surface, grid first", async () => {
    const { Ribbon } = await import("../ui/chrome");
    const s = run(initialState(), { type: "toggle_ribbon_expanded" });
    expect(s.ribbonExpanded).toBe(true);
    render(<Ribbon state={s} dispatch={() => {}} />);
    expect(screen.getByTestId("catalog-grid-view")).toBeInTheDocument();
    expect(screen.queryByTestId("ribbon")).not.toBeInTheDocument();
  });

  it("the table is one seg-switch away", async () => {
    const { Ribbon } = await import("../ui/chrome");
    const s = run(
      initialState(),
      { type: "toggle_ribbon_expanded" },
      { type: "set_expanded_view", view: "table" },
    );
    render(<Ribbon state={s} dispatch={() => {}} />);
    expect(screen.getByTestId("ribbon-table")).toBeInTheDocument();
    expect(screen.queryByTestId("catalog-grid-view")).not.toBeInTheDocument();
    // One header: the catalog's, not the table's own copy underneath it.
    expect(screen.getAllByTestId("ribbon-collapse")).toHaveLength(1);
  });

  it("puts down a tool that has nothing left to draw on", () => {
    // The viewport is gone while it is expanded, so a brush armed against
    // a viewer that is not there would be a cursor with no canvas.
    const s = run(
      initialState(),
      { type: "set_tool", tool: "brush" },
      { type: "toggle_ribbon_expanded" },
    );
    expect(s.tool).toBe("none");
    // Coming back does not silently re-arm it either.
    expect(run(s, { type: "toggle_ribbon_expanded" }).tool).toBe("none");
  });

  it("hides the viewer and shows it again", async () => {
    const { App } = await import("../app");
    render(<App />);
    expect(screen.getByTestId("viewer")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("ribbon-expand"));
    await waitFor(() => expect(screen.queryByTestId("viewer")).not.toBeInTheDocument());
    expect(screen.getByTestId("catalog-grid-view")).toBeInTheDocument();
    // And the way back is in the catalog surface, not only in the panel
    // that is no longer on screen.
    fireEvent.click(screen.getByTestId("ribbon-collapse"));
    await waitFor(() => expect(screen.getByTestId("viewer")).toBeInTheDocument());
  });

  it("has no divider to drag while it is the whole window", async () => {
    const { App } = await import("../app");
    render(<App />);
    expect(screen.getByTestId("divider-ribbon")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("ribbon-expand"));
    await waitFor(() =>
      expect(screen.queryByTestId("divider-ribbon")).not.toBeInTheDocument(),
    );
  });
});

describe("the columns", () => {
  it("covers the workspace's half and the camera's, marked apart", () => {
    // "Some metadata is from the workspace; rating,
    // status, etc. Other columns are common camera data."
    const own = META_COLUMNS.filter((c) => c.own).map((c) => c.id);
    expect(own).toEqual(["name", "stars", "flag", "edited", "takes"]);
    const camera = META_COLUMNS.filter((c) => !c.own).map((c) => c.id);
    expect(camera).toContain("iso");
    expect(camera).toContain("shutter");
    expect(camera).toContain("lens");
  });

  it("renders each column from the same record", () => {
    const m = meta({
      stars: 3,
      flag: "pick",
      edited: true,
      iso: 800,
      shutter: "1/125",
      aperture: "f/4",
      shot_at: "2024:03:11 17:42:08",
      width: 6000,
      height: 4000,
    });
    expect(cellText("stars", m, 1)).toBe("★★★");
    expect(cellText("flag", m, 1)).toBe("Pick");
    expect(cellText("edited", m, 1)).toBe("Yes");
    expect(cellText("takes", m, 3)).toBe("3");
    expect(cellText("iso", m, 1)).toBe("800");
    expect(cellText("shot_at", m, 1)).toBe("2024-03-11 17:42");
    expect(cellText("pixels", m, 1)).toBe("6000 × 4000");
    // Nothing recorded is blank rather than a zero that reads as a value.
    expect(cellText("lens", meta(), 1)).toBe("");
    expect(cellText("stars", meta(), 1)).toBe("");
  });

  it("sorts readings as readings, not as text", () => {
    // 1/1000 is a faster shutter than 1/60, and "1/1000" sorts before
    // "1/60" alphabetically, which would be exactly backwards.
    const rows = [
      { meta: meta({ id: "a", name: "a", shutter: "1/60" }), takes: 1 },
      { meta: meta({ id: "b", name: "b", shutter: "1/1000" }), takes: 1 },
      { meta: meta({ id: "c", name: "c", shutter: "2s" }), takes: 1 },
    ];
    expect(sortRows(rows, "shutter", false).map((r) => r.meta.id)).toEqual(["b", "a", "c"]);
    expect(sortRows(rows, "shutter", true).map((r) => r.meta.id)).toEqual(["c", "a", "b"]);

    // And ISO 1600 comes after ISO 400 rather than before it.
    const isos = [
      { meta: meta({ id: "a", name: "a", iso: 1600 }), takes: 1 },
      { meta: meta({ id: "b", name: "b", iso: 400 }), takes: 1 },
    ];
    expect(sortRows(isos, "iso", false).map((r) => r.meta.id)).toEqual(["b", "a"]);
  });

  it("puts photographs with nothing recorded last, either way round", () => {
    // A photo with no lens recorded is absent from that column, not the
    // smallest lens in it.
    const rows = [
      { meta: meta({ id: "a", name: "a" }), takes: 1 },
      { meta: meta({ id: "b", name: "b", iso: 100 }), takes: 1 },
      { meta: meta({ id: "c", name: "c", iso: 6400 }), takes: 1 },
    ];
    expect(sortRows(rows, "iso", false).map((r) => r.meta.id)).toEqual(["b", "c", "a"]);
    expect(sortRows(rows, "iso", true).map((r) => r.meta.id)).toEqual(["c", "b", "a"]);
  });

  it("clicking the same column twice turns it around", () => {
    let s = run(initialState(), { type: "set_ribbon_sort", column: "iso" });
    expect(s.ribbonSort).toEqual({ column: "iso", desc: false });
    s = run(s, { type: "set_ribbon_sort", column: "iso" });
    expect(s.ribbonSort).toEqual({ column: "iso", desc: true });
    // A different column starts ascending rather than inheriting the
    // arrow from the last one.
    s = run(s, { type: "set_ribbon_sort", column: "camera" });
    expect(s.ribbonSort).toEqual({ column: "camera", desc: false });
  });

  it("a click on a row selects that photograph", async () => {
    const { MetadataTable } = await import("../ui/ribbontable");
    const s = run(initialState(), { type: "toggle_ribbon_expanded" });
    const sent: Command[] = [];
    render(<MetadataTable state={s} dispatch={((c: Command) => sent.push(c)) as never} />);
    const id = s.images[0].id;
    await waitFor(() => expect(screen.getByTestId(`table-row-${id}`)).toBeInTheDocument());
    fireEvent.click(screen.getByTestId(`table-row-${id}`));
    expect(sent[0]).toMatchObject({ type: "select_image_range", id });
  });
});

describe("the restored photograph's thumbnail", () => {
  it("scrolls itself into view on launch, without pulsing or yanking", async () => {
    // "it does go to my last selected photo but the
    // thumbnail needs to auto-scroll so its centered in the thumbnail
    // view."
    const { App } = await import("../app");
    const scrolled: { el: Element; opts: unknown }[] = [];
    const orig = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element, opts: unknown) {
      scrolled.push({ el: this, opts });
    };
    // A strip taller than its box, with the active photo below the fold.
    // jsdom hands every element a zero-size rect, so both the geometry
    // and the scrollability have to be supplied for "off screen" to
    // mean anything.
    const proto = HTMLElement.prototype;
    const prior = ["scrollHeight", "clientHeight"].map(
      (k) => [k, Object.getOwnPropertyDescriptor(proto, k)] as const,
    );
    Object.defineProperty(proto, "scrollHeight", { configurable: true, get: () => 2000 });
    Object.defineProperty(proto, "clientHeight", { configurable: true, get: () => 400 });
    const priorRect = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function (this: Element) {
      const thumb = (this as HTMLElement).getAttribute?.("data-testid")?.startsWith("thumb-");
      const [top, bottom] = thumb ? [900, 980] : [0, 400];
      return { top, bottom, left: 0, right: 200, width: 200, height: bottom - top, x: 0, y: top, toJSON() {} } as DOMRect;
    };
    try {
      render(<App />);
      await waitFor(() =>
        expect(
          scrolled.some(
            (s) => (s.el as HTMLElement).getAttribute("data-testid") === "thumb-4871",
          ),
        ).toBe(true),
      );
      // Instant, centered, and no gold flash: the app did this, not the
      // person, so it should not ask for attention.
      const hit = scrolled.find(
        (s) => (s.el as HTMLElement).getAttribute("data-testid") === "thumb-4871",
      )!;
      expect(hit.opts).toMatchObject({ block: "center", behavior: "auto" });
      expect(
        (hit.el as HTMLElement).classList.contains("thumb-reveal"),
      ).toBe(false);
    } finally {
      Element.prototype.scrollIntoView = orig;
      Element.prototype.getBoundingClientRect = priorRect;
      for (const [k, d] of prior) if (d) Object.defineProperty(proto, k, d);
    }
  });

  it("leaves the strip alone when the photograph is already on screen", async () => {
    const { App } = await import("../app");
    const scrolled: Element[] = [];
    const orig = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this);
    };
    try {
      // No stubbing: nothing scrolls in jsdom, so every thumbnail counts
      // as visible and the app has no reason to move anything.
      render(<App />);
      await new Promise((r) => setTimeout(r, 50));
      expect(scrolled).toHaveLength(0);
    } finally {
      Element.prototype.scrollIntoView = orig;
    }
  });
});

describe("menus that live inside a zoomed panel", () => {
  it("puts the thumbnail context menu on the body, not in the zoom", async () => {
    const { App } = await import("../app");
    // The ribbon carries ui-zoom (CSS zoom 1.15), and zoom rescales
    // position:fixed descendants too, so a menu asked for top:400 drew at
    // 460. "the context menu is like way off, like one whole
    // thumbnail below." A portal to the body leaves the zoom behind.
    render(<App />);
    const thumb = screen.getByTestId("thumb-4871");
    fireEvent.contextMenu(thumb, { clientX: 120, clientY: 400 });
    const menu = await screen.findByTestId("thumb-menu");
    expect(menu.style.top).toBe("400px");
    // Nothing between the menu and the body may be zoomed.
    for (let el = menu.parentElement; el && el !== document.body; el = el.parentElement) {
      expect(el.className).not.toContain("ui-zoom");
    }
  });
});
