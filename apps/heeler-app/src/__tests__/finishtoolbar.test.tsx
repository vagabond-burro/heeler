// The Finish tab's new-layer seats (ui/finishnew.tsx). (2026-09-30), on
// a row of nine icon buttons with a "+" on most of them, wrapping to
// two rows: "I think all the new layer buttons is confusing and sort of
// sloppy looking." The row is a split button for Pixel, Gradient and
// Fill, the Adjustment menu with Smart and Warp in a Utility section
// ("Smart and Warp should be handled like Adjustments. I see them as
// sort of a utility"), one Image button with its two sources, then
// Group and Delete at the right end. The empty stack lists the same
// seats, and the menu bar's Layer > New Finish Layer matches them.
//
// Every test renders its own App and reads only the state it made.

import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../app";
import { ART_ADJUSTMENTS, artLayers, type State } from "../state";
import { tourHostForTests } from "../tourwalk";
import { uiSettingsCommands, uiSettingsSnapshot } from "../settings";
import { toolbarWraps, TOOLBAR_GAP } from "../ui/finishnew";

type User = ReturnType<typeof userEvent.setup>;

const state = (): State => {
  const h = tourHostForTests();
  if (!h) throw new Error("the app registered no tour host");
  return h.getState();
};

async function openFinish(user: User) {
  render(<App />);
  await user.click(screen.getByTestId("panel-tab-layers"));
}

/** The kinds on the stack, bottom up, by content type. */
const kinds = () => artLayers(state()).map((l) => l.content.type);

/** Clicks through `open` then `item`, and holds the add to one undo
 * step: the stack grows by one and the undo stack by exactly one. */
async function addsOne(user: User, clicks: string[], type: string) {
  const before = artLayers(state()).length;
  const undo = state().undoStack.length;
  for (const id of clicks) await user.click(screen.getByTestId(id));
  const after = artLayers(state());
  expect(after.length, clicks.join(" > ")).toBe(before + 1);
  expect(after[after.length - 1].content.type, clicks.join(" > ")).toBe(type);
  expect(state().undoStack.length - undo, `${clicks.join(" > ")} is one undo step`).toBe(1);
}

describe("the Finish toolbar", () => {
  it("is the split button, Adjustment, Image, then Group and Delete, with no plus badges", async () => {
    const user = userEvent.setup();
    await openFinish(user);
    const bar = screen.getByTestId("finish-new-bar");
    const ids = ["art-add-content", "art-add-content-more", "art-add-adjust", "art-add-image", "art-expand-on-select", "art-group", "art-delete"];
    const order = Array.from(bar.querySelectorAll("button")).map((b) => b.getAttribute("data-testid"));
    expect(order).toEqual(ids);
    // The old one-kind-a-button seats are gone from the row.
    for (const gone of ["art-add-paint", "art-add-smart", "art-add-gradient", "art-add-fill", "art-add-warp"]) {
      expect(screen.queryByTestId(gone), gone).toBeNull();
    }
    // No "+" anywhere on the row: the plus was a 10 unit cross.
    expect(bar.querySelector('path[d="M8 3v10M3 8h10"]')).toBeNull();
    // A caret only on the seats that open a menu, and those say so.
    const menus = ["art-add-content-more", "art-add-adjust", "art-add-image"];
    for (const id of ids) {
      const btn = screen.getByTestId(id);
      expect(btn.getAttribute("aria-label"), id).toBeTruthy();
      expect(btn.getAttribute("data-hint"), id).toBeTruthy();
      expect(btn.getAttribute("aria-haspopup"), id).toBe(menus.includes(id) ? "menu" : null);
    }
    // Group and Delete sit after the divider, in their own cluster.
    const actions = screen.getByTestId("art-toolbar-actions");
    expect(within(actions).getByTestId("art-group")).toBeInTheDocument();
    expect(within(actions).getByTestId("art-delete")).toBeInTheDocument();
    expect(within(screen.getByTestId("art-toolbar-adds")).queryByTestId("art-group")).toBeNull();
  });

  it("repeats whichever of Pixel, Gradient and Fill was made last, and keeps it with the settings", async () => {
    const user = userEvent.setup();
    await openFinish(user);
    const main = () => screen.getByTestId("art-add-content");
    // Pixel to start.
    expect(main()).toHaveAttribute("aria-label", "Pixel layer");
    await addsOne(user, ["art-add-content"], "heeler.paint");
    // The arrow's Gradient makes one and takes the button face.
    await addsOne(user, ["art-add-content-more", "art-content-gradient"], "heeler.gradient");
    expect(main()).toHaveAttribute("aria-label", "Gradient layer");
    expect(screen.getByTestId("art-add-content-more")).toHaveAttribute("data-kind", "gradient");
    await addsOne(user, ["art-add-content"], "heeler.gradient");
    // Fill the same way.
    await addsOne(user, ["art-add-content-more", "art-content-fill"], "heeler.fill");
    expect(main()).toHaveAttribute("aria-label", "Fill layer");
    await addsOne(user, ["art-add-content"], "heeler.fill");
    expect(kinds()).toEqual(["heeler.paint", "heeler.gradient", "heeler.gradient", "heeler.fill", "heeler.fill"]);
    // Saved with the tool pairs, and read back.
    const saved = uiSettingsSnapshot(state());
    expect(saved.artContentKind).toBe("fill");
    expect(uiSettingsCommands(JSON.stringify(saved))).toContainEqual({ type: "set_art_content_kind", kind: "fill" });
    // A hand-edited kind keeps Pixel rather than a button that makes nothing.
    expect(uiSettingsCommands(JSON.stringify({ ...saved, artContentKind: "sparkle" })).some((c) => c.type === "set_art_content_kind")).toBe(false);
  });

  it("holds Smart and Warp in the Adjustment menu's Utility section, after the adjustments", async () => {
    const user = userEvent.setup();
    await openFinish(user);
    await user.click(screen.getByTestId("art-add-adjust"));
    const menu = screen.getByTestId("art-adjust-menu");
    const rows = Array.from(menu.querySelectorAll("[data-testid]")).map((e) => e.getAttribute("data-testid"));
    expect(rows).toEqual([
      ...ART_ADJUSTMENTS.map((k) => `art-adjust-${k}`),
      "art-adjust-utility",
      "art-utility-smart",
      "art-utility-warp",
    ]);
    expect(screen.getByTestId("art-adjust-utility")).toHaveTextContent("UTILITY");
    for (const id of ["art-utility-smart", "art-utility-warp"]) {
      const item = screen.getByTestId(id);
      expect(item.querySelector("svg"), id).toBeTruthy();
      expect(item.closest("[data-hint]")?.getAttribute("data-hint"), id).toBeTruthy();
    }
    // Keyboard: the menu takes focus, arrows walk it, Escape closes it.
    expect(document.activeElement).toBe(screen.getByTestId(`art-adjust-${ART_ADJUSTMENTS[0]}`));
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(document.activeElement).toBe(screen.getByTestId("art-utility-warp"));
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByTestId("art-adjust-menu")).toBeNull();
  });

  it("makes each menu's layer, one undo step apiece", async () => {
    const user = userEvent.setup();
    await openFinish(user);
    await addsOne(user, ["art-add-content-more", "art-content-paint"], "heeler.paint");
    await addsOne(user, ["art-add-content-more", "art-content-gradient"], "heeler.gradient");
    await addsOne(user, ["art-add-content-more", "art-content-fill"], "heeler.fill");
    await addsOne(user, ["art-add-adjust", "art-adjust-curves"], "heeler.curves");
    await addsOne(user, ["art-add-adjust", "art-utility-warp"], "heeler.layer_warp");
    await addsOne(user, ["art-add-adjust", "art-utility-smart"], "heeler.lift");
    // From Catalog opens the photograph picker; From File asks the OS;
    // From Selection is New Layer via Copy (layerviacopy.test.tsx).
    await user.click(screen.getByTestId("art-add-image"));
    expect(within(screen.getByTestId("art-image-menu")).getAllByRole("menuitem").map((b) => b.getAttribute("aria-label"))).toEqual(["From File…", "From Catalog…", "From Selection"]);
    await user.click(screen.getByTestId("art-image-from-catalog"));
    expect(state().catalogLayerPick).toBe(true);
    expect(screen.queryByTestId("art-image-menu")).toBeNull();
  });

  it("lists the seats while the stack is empty, and each row makes its layer", async () => {
    const user = userEvent.setup();
    await openFinish(user);
    const empty = screen.getByTestId("art-empty");
    expect(empty).toHaveTextContent(/Finish group you can open like any other/);
    const rows = within(empty).getAllByRole("button").map((b) => b.getAttribute("data-testid"));
    expect(rows).toEqual(["art-empty-paint", "art-empty-gradient", "art-empty-fill", "art-empty-adjust", "art-empty-smart", "art-empty-warp", "art-empty-image"]);
    for (const id of rows) expect(screen.getByTestId(id!).getAttribute("data-hint"), id!).toBeTruthy();
    // Adjustment and Image are choices: their rows open the toolbar's menus.
    await user.click(screen.getByTestId("art-empty-adjust"));
    expect(screen.getByTestId("art-adjust-menu")).toBeInTheDocument();
    await user.click(screen.getByTestId("art-empty-image"));
    expect(screen.getByTestId("art-image-menu")).toBeInTheDocument();
    expect(screen.queryByTestId("art-adjust-menu")).toBeNull();
    // A content row makes its layer (and the split button remembers it).
    await addsOne(user, ["art-empty-gradient"], "heeler.gradient");
    expect(screen.getByTestId("art-add-content")).toHaveAttribute("aria-label", "Gradient layer");
    // The list stands in for the stack only while there is none.
    expect(screen.queryByTestId("art-empty")).toBeNull();
  });

  it("makes Smart and Warp from the empty list, one step each", async () => {
    const user = userEvent.setup();
    await openFinish(user);
    await addsOne(user, ["art-empty-warp"], "heeler.layer_warp");
    // Undo empties the stack again, and the list comes back.
    act(() => tourHostForTests()!.dispatch({ type: "undo" }));
    expect(artLayers(state())).toHaveLength(0);
    await addsOne(user, ["art-empty-smart"], "heeler.lift");
  });

  it("offers the same seats on a right-click of the empty list", async () => {
    const user = userEvent.setup();
    await openFinish(user);
    fireEvent.contextMenu(screen.getByTestId("art-empty-fill"), { clientX: 200, clientY: 200 });
    const menu = screen.getByTestId("art-new-menu");
    const top = Array.from(menu.querySelectorAll(":scope > div > button, :scope > div > div > button")).map((b) => b.getAttribute("data-testid"));
    expect(top).toEqual(["art-new-paint", "art-new-gradient", "art-new-fill", "art-new-adjust", "art-new-image"]);
    fireEvent.mouseEnter(screen.getByTestId("art-new-adjust").parentElement!);
    const adj = Array.from(screen.getByTestId("art-new-adjust-list").querySelectorAll("button")).map((b) => b.getAttribute("data-testid"));
    expect(adj).toEqual([...ART_ADJUSTMENTS.map((k) => `art-new-adjust-${k}`), "art-new-smart", "art-new-warp"]);
    await addsOne(user, ["art-new-warp"], "heeler.layer_warp");
    expect(screen.queryByTestId("art-new-menu")).toBeNull();
  });

  it("the Layer menu's New Finish Layer lists the same seats in the same order", async () => {
    const user = userEvent.setup();
    await openFinish(user);
    await user.click(screen.getByTestId("menu-layer"));
    fireEvent.mouseEnter(screen.getByTestId("menu-layer-new-finish").parentElement!);
    const list = screen.getByTestId("menu-layer-new-finish-list");
    const top = Array.from(list.querySelectorAll(":scope > div > button")).map((b) => b.getAttribute("data-testid"));
    expect(top).toEqual(["menu-finish-paint", "menu-finish-gradient", "menu-finish-fill", "menu-finish-adjust", "menu-finish-image"]);
    fireEvent.mouseEnter(screen.getByTestId("menu-finish-adjust").parentElement!);
    const adj = Array.from(screen.getByTestId("menu-finish-adjust-list").querySelectorAll("[data-testid]")).map((e) => e.getAttribute("data-testid"));
    expect(adj).toEqual([...ART_ADJUSTMENTS.map((k) => `menu-finish-adjust-${k}`), "menu-finish-utility", "menu-finish-smart", "menu-finish-warp"]);
    fireEvent.mouseEnter(screen.getByTestId("menu-finish-image").parentElement!);
    const img = Array.from(screen.getByTestId("menu-finish-image-list").querySelectorAll("button")).map((b) => b.textContent);
    expect(img).toEqual(["From File…", "From Catalog…"]);
    // The old top-level image items folded into Image Layer.
    expect(screen.getAllByTestId("menu-image-layer-file")).toHaveLength(1);
    // And the menu's Gradient is the split button's Gradient: it
    // remembers, and it is one step.
    await addsOne(user, ["menu-finish-gradient"], "heeler.gradient");
    expect(screen.getByTestId("art-add-content")).toHaveAttribute("aria-label", "Gradient layer");
  });
});

describe("the Finish toolbar's width", () => {
  // Measured in the browser build (offsetWidth, CSS pixels inside the
  // app's zoom): the add seats 121 to 123, the actions with their
  // divider 68 to 69, at 100, 115 and 150 percent. The panel's size is
  // CSS pixels inside the zoom too, so the row is 295 wide at the
  // default panel (320) and 235 at the narrowest (260) at every zoom.
  const ADDS = 123;
  const ACTIONS = 69;
  let restore: (() => void) | null = null;
  afterEach(() => {
    restore?.();
    restore = null;
  });

  /** Stands in for layout: offsetWidth by test id. */
  function widths(row: number) {
    const proto = HTMLElement.prototype;
    const prior = Object.getOwnPropertyDescriptor(proto, "offsetWidth");
    const table: Record<string, number> = { "finish-new-bar": row, "art-toolbar-adds": ADDS, "art-toolbar-actions": ACTIONS };
    Object.defineProperty(proto, "offsetWidth", {
      configurable: true,
      get(this: HTMLElement) {
        return table[this.dataset.testid ?? ""] ?? 0;
      },
    });
    restore = () => {
      if (prior) Object.defineProperty(proto, "offsetWidth", prior);
      else delete (proto as unknown as Record<string, unknown>).offsetWidth;
    };
  }

  it("keeps one row at 100 and 115 percent at the default width, and at 150 percent at the narrowest", async () => {
    for (const [zoom, panel] of [[1, 320], [1.15, 320], [1.5, 260]] as const) {
      // The panel's padding is 12 a side; its width does not change with zoom.
      const row = panel - 1 - 24;
      expect(toolbarWraps(row, ADDS, ACTIONS), `${zoom} at ${panel}`).toBe(false);
    }
    widths(235);
    const user = userEvent.setup();
    await openFinish(user);
    expect(screen.getByTestId("finish-new-bar")).not.toHaveAttribute("data-wrapped");
  });

  it("moves Group and Delete to the right end of a second row when the row is too narrow, never the add seats", async () => {
    // Narrower than any panel size allows, standing in for a window
    // that squeezes the panel.
    const row = ADDS + TOOLBAR_GAP + ACTIONS - 1;
    expect(toolbarWraps(row, ADDS, ACTIONS)).toBe(true);
    widths(row);
    const user = userEvent.setup();
    await openFinish(user);
    const bar = screen.getByTestId("finish-new-bar");
    expect(bar).toHaveAttribute("data-wrapped", "true");
    // The add seats stay together, first; the actions' slot takes a
    // whole line and pushes them to its right end.
    const adds = screen.getByTestId("art-toolbar-adds");
    const slot = screen.getByTestId("art-toolbar-actions").parentElement!;
    expect(bar.firstElementChild).toBe(adds);
    expect(adds.style.flex).toBe("0 0 auto");
    expect(slot.style.flexBasis).toBe("100%");
    expect(slot.style.justifyContent).toBe("flex-end");
    expect(within(adds).getAllByRole("button").map((b) => b.getAttribute("data-testid"))).toEqual([
      "art-add-content",
      "art-add-content-more",
      "art-add-adjust",
      "art-add-image",
    ]);
  });
});
