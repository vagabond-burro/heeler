import { expect, it } from "vitest";
import { BUILTIN_RECIPES, parseUserRecipes, recipeFromGroup, searchRecipes } from "../noderecipes";
import { nodeKindLabel } from "../nodekind";
import { initialState } from "../data";
import { reduce } from "../state";

it("a saved user recipe identifies its dropped group by that recipe's type", () => {
  const source = structuredClone(BUILTIN_RECIPES[0].group);
  delete source.recipe;
  const saved = recipeFromGroup(source, "Portrait cleanup", "user_portrait");
  const s = reduce(initialState(), { type: "add_recipe", recipe: saved, x: 100, y: 100, id: "review_drop" });
  const dropped = s.nodes.find(n => n.id === "review_drop")!;
  const renamed = { ...dropped, name: "My renamed group" };
  expect(nodeKindLabel(renamed, [saved])).toBe("Group / Portrait cleanup");
});

it("malformed stored recipe metadata cannot crash palette search", () => {
  const valid = recipeFromGroup(BUILTIN_RECIPES[0].group, "Good", "user_good");
  const bad = [
    { ...valid, id: "no_blurb", blurb: undefined },
    { ...valid, id: "bad_keywords", keywords: 17 },
    { ...valid, id: "bad_members", group: { ...valid.group, groupNodes: {} } },
    { ...valid, id: "bad_wires", group: { ...valid.group, groupWires: {} } },
  ];
  const loaded = parseUserRecipes(JSON.stringify([valid, ...bad]));
  expect(loaded.map(r => r.id)).toEqual([valid.id]);
  expect(() => searchRecipes(loaded, "unmatched search")).not.toThrow();
});


it("a saved recipe drops on another photograph and survives a take and list removal", () => {
  const saved = recipeFromGroup(BUILTIN_RECIPES[0].group, "Across photos", "user_across");
  let s = reduce(initialState(), { type: "select_image", id: "4866" });
  const before = s.nodes;
  s = reduce(s, { type: "add_recipe", recipe: saved, x: 500, y: 500, id: "across" });
  const dropped = structuredClone(s.nodes.find(n => n.id === "across")!);
  expect(s.nodes.filter(n => n.id !== "across")).toEqual(before);
  s = reduce(s, { type: "new_take", name: "With recipe" });
  s = reduce(s, { type: "delete_nodes", ids: ["across"] });
  s = reduce(s, { type: "switch_take", takeId: "take_1" });
  s = reduce({ ...s, userRecipes: [saved] }, { type: "remove_recipe", id: saved.id });
  expect(s.userRecipes).toEqual([]);
  expect(s.nodes.find(n => n.id === "across")).toEqual(dropped);
});
