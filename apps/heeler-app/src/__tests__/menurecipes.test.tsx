// Node recipes in the menus (2026-10-10: "custom node recipes ... are not
// available from the Nodes menu", then "They should be under Recipes >
// Custom sub menu"). The menubar's Node > Recipes and the graph's
// right-click Add > Recipes list the shipped recipes, with the person's
// own under Custom; and the Node menu reads the recipes folder when it
// opens, as the palette and the Add menu do, or it listed none of the
// person's until one of those had opened.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("../recipefiles", async (actual) => ({
  ...(await actual<typeof import("../recipefiles")>()),
  refreshRecipeFiles: vi.fn(() => Promise.resolve()),
  importRecipeFiles: vi.fn(() => Promise.resolve()),
  exportRecipeFile: vi.fn(() => Promise.resolve()),
}));

import { exportRecipeFile, importRecipeFiles, refreshRecipeFiles } from "../recipefiles";
import { initialState } from "../data";
import { BUILTIN_RECIPES, type NodeRecipe } from "../noderecipes";
import type { Command, State } from "../state";
import { MenuBar } from "../ui/chrome";
import { NodeEditor } from "../ui/graph";

const own = (id: string, name: string, error?: string): NodeRecipe => ({ ...BUILTIN_RECIPES[0], id, name, builtin: false, ...(error ? { error } : {}) });
const withRecipes = (userRecipes: NodeRecipe[]): State => ({ ...initialState(), mode: "advanced", userRecipes });
const ids = (list: HTMLElement, prefix: string) =>
  [...list.querySelectorAll<HTMLElement>(`[data-testid^="${prefix}"]`)].map((b) => b.dataset.testid!.slice(prefix.length));

beforeEach(() => {
  vi.mocked(refreshRecipeFiles).mockClear();
  vi.mocked(importRecipeFiles).mockClear();
  vi.mocked(exportRecipeFile).mockClear();
});

describe("Node > Recipes in the menubar", () => {
  it("reads the recipes folder when the Node menu opens", () => {
    render(<MenuBar state={withRecipes([])} dispatch={() => {}} />);
    expect(refreshRecipeFiles).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("menu-node"));
    expect(refreshRecipeFiles).toHaveBeenCalledTimes(1);
  });

  it("lists the shipped recipes, and the person's own under Custom, a broken one grayed with its reason", () => {
    const sent: Command[] = [];
    const state = withRecipes([own("user:Mine/Soft", "Soft look"), own("user:Mine/Broken", "Broken", "line 3: unknown node type heeler.nope")]);
    render(<MenuBar state={state} dispatch={(c) => sent.push(c)} />);
    fireEvent.click(screen.getByTestId("menu-node"));
    fireEvent.mouseEnter(screen.getByTestId("menu-node-recipes").parentElement!);
    const shipped = ids(screen.getByTestId("menu-node-recipes-list"), "menu-node-recipe-");
    expect(shipped).toEqual(BUILTIN_RECIPES.map((r) => r.id));
    fireEvent.mouseEnter(screen.getByTestId("menu-node-recipes-custom").parentElement!);
    expect(ids(screen.getByTestId("menu-node-recipes-custom-list"), "menu-node-recipe-")).toEqual(["user:Mine/Soft", "user:Mine/Broken"]);
    const broken = screen.getByTestId("menu-node-recipe-user:Mine/Broken");
    expect(broken).toBeDisabled();
    expect(screen.getByTestId("menu-node-row-user:Mine/Broken").getAttribute("data-hint")).toMatch(/unknown node type/);
    fireEvent.click(screen.getByTestId("menu-node-recipe-user:Mine/Soft"));
    const add = sent.find((c) => c.type === "add_recipe");
    expect(add && add.type === "add_recipe" && add.recipe.id).toBe("user:Mine/Soft");
  });

  it("says how to make one while Custom is empty", () => {
    render(<MenuBar state={withRecipes([])} dispatch={() => {}} />);
    fireEvent.click(screen.getByTestId("menu-node"));
    fireEvent.mouseEnter(screen.getByTestId("menu-node-recipes").parentElement!);
    fireEvent.mouseEnter(screen.getByTestId("menu-node-recipes-custom").parentElement!);
    const none = screen.getByTestId("menu-node-none");
    expect(none).toBeDisabled();
    expect(none.parentElement!.getAttribute("data-hint")).toMatch(/Save as Recipe/);
    // Import is there even with none saved.
    expect(screen.getByTestId("menu-node-import")).toBeTruthy();
  });

  it("Custom has Import first, and Export, Rename and Remove as icons on each recipe", () => {
    // 2026-10-10: "Custom Recipes should the Import at the top. Each recipe
    // should the Export \\ Rename \\ Remove but replace the labels with icons".
    const sent: Command[] = [];
    const soft = own("user:Mine/Soft", "Soft look");
    render(<MenuBar state={withRecipes([soft, own("user:Mine/Broken", "Broken", "line 3: unknown")])} dispatch={(c) => sent.push(c)} />);
    fireEvent.click(screen.getByTestId("menu-node"));
    fireEvent.mouseEnter(screen.getByTestId("menu-node-recipes").parentElement!);
    fireEvent.mouseEnter(screen.getByTestId("menu-node-recipes-custom").parentElement!);
    const list = screen.getByTestId("menu-node-recipes-custom-list");
    expect(list.querySelector("button")!.dataset.testid).toBe("menu-node-import");
    fireEvent.click(screen.getByTestId("menu-node-import"));
    expect(importRecipeFiles).toHaveBeenCalledTimes(1);
    for (const action of ["export", "rename", "remove"]) {
      const b = screen.getByTestId(`menu-node-${action}-user:Mine/Soft`);
      expect(b.textContent, action).toBe("");
      expect(b.querySelector("svg"), action).toBeTruthy();
      expect(b.getAttribute("aria-label"), action).toMatch(/Soft look$/);
    }
    fireEvent.click(screen.getByTestId("menu-node-export-user:Mine/Soft"));
    expect(exportRecipeFile).toHaveBeenCalledWith(soft, expect.any(Function));
    fireEvent.click(screen.getByTestId("menu-node-rename-user:Mine/Soft"));
    const input = screen.getByTestId("menu-node-name-input") as HTMLInputElement;
    expect(input.value).toBe("Soft look");
    fireEvent.change(input, { target: { value: "Softer" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(sent).toContainEqual({ type: "rename_recipe", id: "user:Mine/Soft", name: "Softer" });
    fireEvent.click(screen.getByTestId("menu-node-remove-user:Mine/Soft"));
    expect(sent).toContainEqual({ type: "remove_recipe", id: "user:Mine/Soft" });
    // A file that cannot be read keeps Remove only.
    expect(screen.queryByTestId("menu-node-export-user:Mine/Broken")).toBeNull();
    expect(screen.queryByTestId("menu-node-rename-user:Mine/Broken")).toBeNull();
    expect(screen.getByTestId("menu-node-remove-user:Mine/Broken")).toBeTruthy();
  });
});

describe("renaming in the menu", () => {
  it("keeps the draft through the menu's navigation keys, and hands the focus back to the row", async () => {
    // The 2026-10-10 review: Down, Up, Home and End moved the focus to a
    // row and the draft was lost; Escape left the focus nowhere.
    render(<MenuBar state={withRecipes([own("user:Mine/Soft", "Soft look")])} dispatch={() => {}} />);
    fireEvent.click(screen.getByTestId("menu-node"));
    fireEvent.mouseEnter(screen.getByTestId("menu-node-recipes").parentElement!);
    fireEvent.mouseEnter(screen.getByTestId("menu-node-recipes-custom").parentElement!);
    fireEvent.click(screen.getByTestId("menu-node-rename-user:Mine/Soft"));
    const input = screen.getByTestId("menu-node-name-input") as HTMLInputElement;
    input.focus();
    fireEvent.change(input, { target: { value: "Unsaved draft" } });
    for (const key of ["ArrowDown", "ArrowUp", "Home", "End"]) {
      fireEvent.keyDown(input, { key });
      expect(document.activeElement, key).toBe(input);
      expect(input.value, key).toBe("Unsaved draft");
    }
    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("menu-node-rename-user:Mine/Soft")));
  });
});

describe("Add > Recipes in the graph", () => {
  it("has the same shape: the shipped ones, then Custom with the person's own", () => {
    const sent: Command[] = [];
    render(<NodeEditor state={withRecipes([own("user:Mine/Soft", "Soft look")])} dispatch={(c: Command) => sent.push(c)} />);
    fireEvent.contextMenu(screen.getByTestId("graph-surface"), { clientX: 300, clientY: 200 });
    fireEvent.click(screen.getByTestId("menu-add"));
    fireEvent.click(screen.getByTestId("menu-add-recipes"));
    expect(screen.queryByTestId("menu-add-recipe-user:Mine/Soft")).toBeNull();
    expect(screen.getByTestId(`menu-add-recipe-${BUILTIN_RECIPES[0].id}`)).toBeTruthy();
    fireEvent.click(screen.getByTestId("menu-add-recipes-custom"));
    fireEvent.click(screen.getByTestId("menu-add-recipe-user:Mine/Soft"));
    const add = sent.find((c) => c.type === "add_recipe");
    expect(add && add.type === "add_recipe" && add.recipe.id).toBe("user:Mine/Soft");
  });
});
