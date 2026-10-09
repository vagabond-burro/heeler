// The add menus' sections. 2026-10-01: "Either Utility nodes get broken
// out into different (sub?) categories or the menu needs to be
// scrollable. It's quite long and I can see someone with a small window
// layout not seeing all the nodes", then "detail and masking are kind of
// long menus too". Both: every category is split into sections of at
// most SECTION_LIMIT nodes, and every list scrolls when it cannot fit.
// Each test asserts only on the menus and lists it renders itself.
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { initialState } from "../data";
import {
  CATEGORY_ORDER,
  NODE_CATALOG,
  NODE_SECTION,
  NODE_SECTIONS,
  RETIRED_TYPES,
  SECTION_LIMIT,
  menuTree,
  searchNodes,
  sectionOf,
  specFor,
} from "../nodes";
import registryDefaults from "../registry-defaults.json";
import { NodeEditor } from "../ui/graph";
import { MenuBar } from "../ui/chrome";
import { NodePalette } from "../ui/nodepalette";
import { placeSubmenu } from "../ui/menusurface";
import { nodeChapter } from "../tourstops";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

afterEach(() => vi.restoreAllMocks());

/** Engine types built by the Finish tab and the mask plumbing, never
 * added by hand (nodekind.test.tsx keeps the same list). */
const INTERNAL = new Set(["heeler.layer_warp_mask", "heeler.mask_crop"]);

/** Every engine type a person can add, from the registry itself, so a
 * node added to the engine cannot go missing from the menus. */
const addable = () =>
  Object.keys(registryDefaults).filter((t) => !INTERNAL.has(t) && !RETIRED_TYPES.has(t) && t !== "heeler.group");

describe("the sections", () => {
  it("hold every registry node exactly once, each in a named section", () => {
    const listed = menuTree().flatMap((f) => f.sections.flatMap((s) => s.nodes.map((n) => n.type)));
    expect(new Set(listed).size).toBe(listed.length);
    for (const type of addable()) {
      expect(listed.filter((t) => t === type), type).toHaveLength(1);
      const spec = specFor(type)!;
      expect(spec, `${type} is not in the palette`).toBeDefined();
      // Not the fallback: the node was given a section on purpose.
      expect(NODE_SECTIONS.map((s) => s.id), type).toContain(sectionOf(spec).id);
    }
    expect(listed.length).toBe(NODE_CATALOG.length);
    // And no section names a type the palette does not list, or a
    // section that does not exist.
    for (const [type, id] of Object.entries(NODE_SECTION)) {
      expect(specFor(type), type).toBeDefined();
      expect(NODE_SECTIONS.map((s) => s.id), type).toContain(id);
    }
  });

  it(`keep every section at ${SECTION_LIMIT} nodes or fewer, and every category's list of sections short`, () => {
    for (const family of menuTree()) {
      // A list of flyouts cannot scroll without clipping them, so it has
      // to fit a small window at 150 percent on its own.
      expect(family.sections.length, family.label).toBeLessThanOrEqual(8);
      for (const s of family.sections) {
        expect(s.nodes.length, `${family.label} > ${s.label}`).toBeLessThanOrEqual(SECTION_LIMIT);
        expect(s.nodes.length, `${family.label} > ${s.label}`).toBeGreaterThan(0);
      }
    }
    expect(menuTree().map((f) => f.cat)).toEqual(CATEGORY_ORDER.filter((c) => c !== "group"));
  });

  it("list each section's nodes by name", () => {
    for (const family of menuTree()) {
      for (const s of family.sections) {
        const names = s.nodes.map((n) => n.name);
        expect(names, s.label).toEqual([...names].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" })));
      }
    }
  });
});

describe("palette search", () => {
  it("still finds a node by its old category word, and by its section", () => {
    const utility = searchNodes("utility").map((s) => s.type);
    for (const spec of NODE_CATALOG.filter((n) => n.cat === "utility")) expect(utility, spec.type).toContain(spec.type);
    const masking = searchNodes("masking").map((s) => s.type);
    for (const spec of NODE_CATALOG.filter((n) => n.cat === "masking")) expect(masking, spec.type).toContain(spec.type);
    expect(searchNodes("channels").map((s) => s.type)).toEqual(expect.arrayContaining(["heeler.channel_join", "heeler.channel_mixer"]));
    expect(searchNodes("mask tools").map((s) => s.type)).toContain("heeler.morphology");
  });

  it("finds every node by its own name, the name first", () => {
    for (const spec of NODE_CATALOG) {
      const hits = searchNodes(spec.name);
      expect(hits.length, spec.name).toBeGreaterThan(0);
      // Its own name ranks it above anything found only by a category.
      expect(hits.findIndex((h) => h.type === spec.type), spec.name).toBeGreaterThanOrEqual(0);
      expect(hits[0].name.toLowerCase().includes(spec.name.toLowerCase()) || hits[0].type === spec.type, spec.name).toBe(true);
    }
  });
});

/** Opens every category and section of an add menu by hovering, and
 * returns the node test ids it showed. */
function walk(rootPrefix: string, nodePrefix: string): string[] {
  const seen: string[] = [];
  for (const family of menuTree()) {
    fireEvent.mouseEnter(screen.getByTestId(`${rootPrefix}-${family.cat}`).parentElement!);
    for (const s of family.sections) {
      fireEvent.mouseEnter(screen.getByTestId(`${rootPrefix}-section-${s.id}`).parentElement!);
      const list = screen.getByTestId(`${rootPrefix}-section-${s.id}-list`);
      list.querySelectorAll<HTMLElement>(`[data-testid^="${nodePrefix}"]`).forEach((b) => seen.push(b.dataset.testid!.slice(nodePrefix.length)));
    }
  }
  return seen;
}

const slug = (type: string) => type.replace("heeler.", "");

describe("every add menu lists every node once", () => {
  it("the graph's right-click Add menu", () => {
    render(<NodeEditor state={{ ...initialState(), mode: "advanced" }} dispatch={() => {}} />);
    fireEvent.contextMenu(screen.getByTestId("graph-surface"), { clientX: 100, clientY: 100 });
    fireEvent.mouseEnter(screen.getByTestId("menu-add").parentElement!);
    const seen = walk("menu-add", "menu-add-");
    for (const type of addable()) expect(seen.filter((t) => t === slug(type)), type).toHaveLength(1);
    expect(seen).toHaveLength(NODE_CATALOG.length);
  });

  it("the menubar's Node menu", () => {
    render(<MenuBar state={{ ...initialState(), mode: "advanced" }} dispatch={() => {}} />);
    fireEvent.click(screen.getByTestId("menu-node"));
    const seen = walk("menu-node", "menu-node-add-");
    for (const type of addable()) expect(seen.filter((t) => t === slug(type)), type).toHaveLength(1);
    expect(seen).toHaveLength(NODE_CATALOG.length);
  });
});

/** Lays out a jsdom list as rows of `row` pixels, so offsets mean
 * something: each menu row's offsetTop is its index times the row. */
function layOut(list: HTMLElement, rows: HTMLElement[], row: number, height: number) {
  const index = new Map(rows.map((r, i) => [r, i]));
  vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockImplementation(function (this: HTMLElement) {
    return (index.get(this) ?? 0) * row;
  });
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
    if (this === list) return rows.length * row;
    return index.has(this) ? row : 0;
  });
  vi.spyOn(HTMLElement.prototype, "offsetParent", "get").mockImplementation(function (this: HTMLElement) {
    return index.has(this) ? list : null;
  });
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this === list ? height : 0;
  });
}

describe("a list that does not fit scrolls", () => {
  it.each([1, 1.15, 1.5])("caps a submenu at the room a 1000 by 650 window leaves, at zoom %s", (z) => {
    // The menubar's lists sit inside the topbar's .ui-zoom, so the list
    // is measured by offsets and the zoom (pxBox), never client rects.
    // 700 CSS pixels of nodes cannot fit 650 at any zoom: the list takes
    // the room less its margins, in its own units, and scrolls.
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(650);
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(1000);
    const panel = document.createElement("div");
    const anchor = document.createElement("div");
    const list = document.createElement("div");
    const flyouts = document.createElement("div");
    panel.appendChild(anchor);
    anchor.appendChild(list);
    anchor.appendChild(flyouts);
    document.body.appendChild(panel);
    const at = (el: HTMLElement, v: { top?: number; h?: number; w?: number; parent?: HTMLElement | null }) => {
      Object.defineProperty(el, "offsetTop", { value: v.top ?? 0, configurable: true });
      Object.defineProperty(el, "offsetLeft", { value: 0, configurable: true });
      Object.defineProperty(el, "offsetHeight", { value: v.h ?? 0, configurable: true });
      Object.defineProperty(el, "offsetWidth", { value: v.w ?? 0, configurable: true });
      Object.defineProperty(el, "offsetParent", { value: v.parent ?? null, configurable: true });
    };
    at(panel, {});
    at(anchor, { top: 500 / z, h: 40 / z, w: 240, parent: panel });
    at(list, { h: 700, w: 240, parent: anchor });
    at(flyouts, { h: 700, w: 240, parent: anchor });
    const real = window.getComputedStyle.bind(window);
    vi.spyOn(window, "getComputedStyle").mockImplementation((el, pseudo) => {
      if (el === panel && z !== 1) return { zoom: String(z) } as CSSStyleDeclaration;
      return real(el, pseudo);
    });
    if (z === 1) {
      vi.spyOn(anchor, "getBoundingClientRect").mockReturnValue({ left: 0, right: 240, top: 500, bottom: 540, width: 240, height: 40 } as DOMRect);
    }
    placeSubmenu(list, true);
    expect(list.style.overflowY).toBe("auto");
    expect(parseFloat(list.style.maxHeight)).toBeCloseTo((650 - 12) / z);
    // Pulled up from its row so all of it is on screen: 6 from the top.
    expect(parseFloat(list.style.top)).toBeCloseTo((6 - 500) / z);
    // Opens to the right of its row, which has the room.
    expect(parseFloat(list.style.left)).toBeCloseTo(240);
    // A list of flyouts is never capped: a scrolling list clips them.
    placeSubmenu(flyouts, false);
    expect(flyouts.style.overflowY).toBe("");
    expect(flyouts.style.maxHeight).toBe("");
    panel.remove();
  });

  it("the graph's context menu lives in the window, not the graph's pane, and scrolls when taller than the window", () => {
    // In a 1000 by 650 window the graph pane is a strip a few rows tall;
    // a menu kept inside it could not show an Add list at all.
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(300);
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.dataset.testid === "context-menu" ? 600 : 0;
    });
    render(<NodeEditor state={{ ...initialState(), mode: "advanced" }} dispatch={() => {}} />);
    fireEvent.contextMenu(screen.getByTestId("graph-surface"), { clientX: 100, clientY: 100 });
    const menu = screen.getByTestId("context-menu");
    expect(menu.parentElement).toBe(document.body);
    expect(menu.style.position).toBe("fixed");
    expect(menu.style.maxHeight).toBe("288px");
    expect(menu.style.overflowY).toBe("auto");
    expect(parseFloat(menu.style.top)).toBe(6);
    // Its flyouts are pinned to the window as well, so the scrolling
    // list cannot clip them.
    fireEvent.mouseEnter(screen.getByTestId("menu-add").parentElement!);
    expect(screen.getByTestId("menu-add-list").style.position).toBe("fixed");
  });

  it("the graph's section list reaches its last node by keyboard, scrolled by offsets", () => {
    const scroll = vi.spyOn(Element.prototype, "scrollIntoView");
    render(<NodeEditor state={{ ...initialState(), mode: "advanced" }} dispatch={() => {}} />);
    fireEvent.contextMenu(screen.getByTestId("graph-surface"), { clientX: 100, clientY: 100 });
    fireEvent.mouseEnter(screen.getByTestId("menu-add").parentElement!);
    fireEvent.mouseEnter(screen.getByTestId("menu-add-utility").parentElement!);
    fireEvent.mouseEnter(screen.getByTestId("menu-add-section-channels").parentElement!);
    const list = screen.getByTestId("menu-add-section-channels-list");
    const rows = Array.from(list.querySelectorAll<HTMLElement>("button"));
    const section = menuTree().find((f) => f.cat === "utility")!.sections.find((s) => s.id === "channels")!;
    expect(rows.map((r) => r.textContent)).toEqual(section.nodes.map((n) => n.name));
    // Three rows of 40 show at once.
    layOut(list, rows, 40, 120);
    rows[0].focus();
    for (let i = 1; i < rows.length; i++) fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(rows[rows.length - 1]);
    expect(list.scrollTop).toBe(rows.length * 40 - 120);
    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    expect(document.activeElement).toBe(rows[0]);
    expect(list.scrollTop).toBe(0);
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(list.scrollTop).toBe(rows.length * 40 - 120);
    expect(scroll).not.toHaveBeenCalled();
  });

  it("the wheel over a menu scrolls the menu, not the graph under it", () => {
    render(<NodeEditor state={{ ...initialState(), mode: "advanced" }} dispatch={() => {}} />);
    fireEvent.contextMenu(screen.getByTestId("graph-surface"), { clientX: 100, clientY: 100 });
    fireEvent.mouseEnter(screen.getByTestId("menu-add").parentElement!);
    fireEvent.mouseEnter(screen.getByTestId("menu-add-detail").parentElement!);
    const list = screen.getByTestId("menu-add-detail-list");
    const surfaceWheel = vi.fn();
    screen.getByTestId("graph-surface").addEventListener("wheel", surfaceWheel);
    fireEvent.wheel(list, { deltaY: 40 });
    expect(surfaceWheel).not.toHaveBeenCalled();
  });

  it("the palette's keyboard row is scrolled into its list by offsets", () => {
    const scroll = vi.spyOn(Element.prototype, "scrollIntoView");
    const state = { ...initialState(), palette: { x: 0, y: 0 } };
    render(<NodePalette state={state} dispatch={() => {}} onAdd={() => {}} recentsLimit={20} />);
    const list = screen.getByRole("listbox");
    const rows = Array.from(list.querySelectorAll<HTMLElement>('[role="option"]'));
    layOut(list, rows, 40, 200);
    const search = screen.getByRole("combobox", { name: "Add a node" });
    for (let i = 1; i < rows.length; i++) fireEvent.keyDown(search, { key: "ArrowDown" });
    expect(rows[rows.length - 1]).toHaveAttribute("aria-selected", "true");
    expect(list.scrollTop).toBe(rows.length * 40 - 200);
    expect(scroll).not.toHaveBeenCalled();
  });
});

describe("the node reference follows the menus", () => {
  const GUIDE = resolve(process.cwd(), "../../docs/user-guide/graph/nodes");
  const chapter = (family: string) => readFileSync(`${GUIDE}/${family}.md`, "utf8");
  const mentions = (text: string, type: string) => text.includes(`\`${type}\``);

  it("each category's chapter has a heading per section, and each documented node sits under its own", () => {
    const documented: string[] = [];
    for (const family of menuTree()) {
      const text = chapter(family.cat);
      const headings = text.split("\n").filter((l) => l.startsWith("## ")).map((l) => l.slice(3));
      for (const s of family.sections) {
        // A section with no node written up yet needs no heading.
        const nodes = s.nodes.filter((n) => mentions(text, n.type));
        if (!nodes.length) continue;
        expect(headings, `${family.cat}.md`).toContain(s.label);
        // Every node of the section that this chapter documents is
        // under the section's own heading.
        const start = text.indexOf(`\n## ${s.label}\n`);
        const end = text.indexOf("\n## ", start + 1);
        const body = text.slice(start, end < 0 ? undefined : end);
        for (const n of nodes) {
          expect(mentions(body, n.type), `${n.type} under ${family.cat}.md > ${s.label}`).toBe(true);
          documented.push(n.type);
        }
      }
    }
    // No write-up was lost in the move: every node any chapter gives a
    // heading of its own is found in its own section.
    const all = ["source", "color", "detail", "masking", "utility"].map(chapter).join("\n");
    for (const spec of NODE_CATALOG) {
      const own = all.split("\n").some((l) => /^#{2,3} /.test(l) && mentions(l, spec.type));
      if (own) expect(documented, spec.type).toContain(spec.type);
    }
    expect(documented.length).toBeGreaterThan(80);
  });

  it("a node's Help chapter is its menu category's", () => {
    expect(nodeChapter(specFor("heeler.transform")!)).toBe("graph/nodes/source.md");
    expect(nodeChapter(specFor("heeler.measure")!)).toBe("graph/nodes/utility.md");
    expect(nodeChapter(specFor("heeler.tone_mask")!)).toBe("graph/nodes/masking.md");
    expect(nodeChapter(specFor("heeler.channel_extract")!)).toBe("graph/nodes/utility.md");
  });
});
