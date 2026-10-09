import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { initialState } from "../data";
import { NodeEditor } from "../ui/graph";
import { NodePalette } from "../ui/nodepalette";
import { CanvasMode } from "../ui/canvas";
import { NODE_CATALOG } from "../nodes";

afterEach(() => vi.restoreAllMocks());

it.each([1, 1.15, 1.3, 1.5])("a graph submenu at zoom %s flips left at the window edge", zoom => {
  const width = 240 * zoom;
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(width);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.dataset.testid === "menu-add-list") return { left: 1000, right: 1000 + width, top: 100, bottom: 300, width, height: 200 } as DOMRect;
    if (this.firstElementChild?.getAttribute("data-testid") === "menu-add") return { left: 1000 - width, right: 1000, top: 100, bottom: 124, width, height: 24 } as DOMRect;
    return { left: 0, right: 1024, top: 0, bottom: 768, width: 1024, height: 768 } as DOMRect;
  });
  render(<NodeEditor state={initialState()} dispatch={() => {}} />);
  fireEvent.contextMenu(screen.getByTestId("graph-surface"), { clientX: 1000, clientY: 100 });
  fireEvent.click(screen.getByTestId("menu-add"));
  const submenu = screen.getByTestId("menu-add-list");
  // Pinned to the window since the menus got sections (2026-10-01): its
  // right edge meets the Add row's left edge, in window pixels.
  expect(submenu.style.position).toBe("fixed");
  expect(parseFloat(submenu.style.left)).toBeCloseTo(1000 - width - width);
  expect(submenu).toHaveAttribute("role", "menu");
});

it("a graph submenu opens with ArrowRight and closes with Escape", () => {
  render(<NodeEditor state={initialState()} dispatch={() => {}} />);
  fireEvent.contextMenu(screen.getByTestId("graph-surface"), { clientX: 300, clientY: 200 });
  const add = screen.getByTestId("menu-add");
  add.focus();
  fireEvent.keyDown(add, { key: "ArrowRight" });
  expect(screen.getByTestId("menu-add-list")).toBeInTheDocument();
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  expect(screen.queryByTestId("menu-add-list")).not.toBeInTheDocument();
  expect(add).toHaveFocus();
});

it("palette arrow navigation exposes and scrolls the active option", () => {
  const state = initialState();
  state.palette = { x: 0, y: 0 };
  const scroll = vi.spyOn(Element.prototype, "scrollIntoView");
  render(<NodePalette state={state} dispatch={() => {}} onAdd={() => {}} recentsLimit={20} />);
  const search = screen.getByRole("combobox", { name: "Add a node" });
  fireEvent.keyDown(search, { key: "ArrowDown" });
  expect(search).toHaveAttribute("aria-activedescendant", expect.any(String));
  // Scrolled by offsets inside the palette's .ui-zoom, never by
  // scrollIntoView (nodemenugroups.test.tsx checks where it lands).
  expect(scroll).not.toHaveBeenCalled();
  const list = screen.getByRole("listbox");
  expect(list.querySelector('[aria-selected="true"]')?.id).toBe(search.getAttribute("aria-activedescendant"));
  expect(NODE_CATALOG.length).toBeGreaterThan(20);
});

// Resolve the inline CSS math against a short viewport. This checks the
// declared space budget; jsdom does not paint or measure flex layouts.
function cssPixels(css: string, zoom: number, w: number, h: number): number {
  if (!css || css === "none") return Infinity;
  const expression = css.replaceAll("var(--chrome-zoom)", String(zoom))
    .replace(/([\d.]+)v([wh])/g, (_, value, axis) => String(Number(value) * (axis === "w" ? w : h) / 100))
    .replaceAll("px", "").replaceAll("calc(", "(");
  if (!/^[\d\s.+*/(),-]+$/.test(expression.replace(/min|max/g, ""))) throw new Error(`Unsupported CSS math: ${css}`);
  return Function("min", "max", `return (${expression})`)(Math.min, Math.max);
}

it.each([1, 1.15, 1.3, 1.5])("the palette's size budget fits a 340 by 260 window at zoom %s", zoom => {
  const state = initialState();
  state.palette = { x: 0, y: 0 };
  render(<NodePalette state={state} dispatch={() => {}} onAdd={() => {}} recentsLimit={20} />);
  const box = screen.getByTestId("node-palette");
  const backdrop = screen.getByTestId("node-palette-backdrop");
  const px = (css: string) => cssPixels(css, zoom, 340, 260);
  const pad = (css: string) => css ? px(css) : 0;
  const maxHeight = px(box.style.maxHeight) * zoom;
  expect(maxHeight).toBeGreaterThan(100);
  expect(maxHeight + pad(backdrop.style.paddingTop) + pad(backdrop.style.paddingBottom)).toBeLessThanOrEqual(260.01);
  expect(px(box.style.width) * zoom + pad(backdrop.style.paddingLeft) + pad(backdrop.style.paddingRight)).toBeLessThanOrEqual(340.01);
  expect(screen.getByRole("listbox")).toHaveStyle({ overflowY: "auto", minHeight: "0" });
});

it("Canvas leaves the graph and Inspector with their popped-out window", () => {
  const state = initialState();
  state.mode = "canvas";
  state.graphPoppedOut = true;
  state.inspectorHome = "graph";
  state.canvasInspectorOpen = true;
  render(<CanvasMode state={state} dispatch={() => {}} previewUrl={null} originalUrl={null} />);
  expect(screen.queryByTestId("node-editor")).not.toBeInTheDocument();
  expect(screen.queryByTestId("inspector")).not.toBeInTheDocument();
  expect(screen.getByTestId("viewer").parentElement).toHaveStyle({ right: "26px" });
});
