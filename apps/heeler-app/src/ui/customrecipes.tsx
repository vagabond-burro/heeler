// Recipes > Custom, the person's own recipes in the menus: the menubar's
// Node > Recipes and the graph's right-click Add > Recipes (2026-10-10:
// "They should be under Recipes > Custom sub menu", then "Custom Recipes
// should the Import at the top. Each recipe should the Export \ Rename \
// Remove but replace the labels with icons"). The node palette's own
// recipe actions, the same calls, as icons on each row.
import React, { useState } from "react";
import type { NodeRecipe } from "../noderecipes";
import type { Command } from "../state";
import { exportRecipeFile, importRecipeFiles } from "../recipefiles";
import { TrashIcon } from "./takeicons";

type D = (cmd: Command) => void;

const ICON = { width: 14, height: 14, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true, focusable: "false" } as const;

/** A tray with an arrow leaving it: save as a file. */
export function ExportIcon() {
  return (
    <svg {...ICON}>
      <path d="M12 15V4M8 8l4-4 4 4M5 13v6h14v-6" />
    </svg>
  );
}

/** A tray with an arrow coming in: add files. */
export function ImportIcon() {
  return (
    <svg {...ICON}>
      <path d="M12 4v11M8 11l4 4 4-4M5 13v6h14v-6" />
    </svg>
  );
}

/** A pencil: give it a new name. */
export function RenameIcon() {
  return (
    <svg {...ICON}>
      <path d="M4 20l1-4L16 5l3 3L8 19l-4 1zM14 7l3 3" />
    </svg>
  );
}

const ICON_BUTTON: React.CSSProperties = {
  all: "unset",
  cursor: "pointer",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 22,
  height: 22,
  flex: "none",
  color: "var(--text-mid)",
  borderRadius: "var(--radius-btn)",
};

/** The Custom submenu's rows: Import… first, then each of the person's
 * recipes with Export, Rename and Remove as icons. `add` drops a recipe
 * (and closes the menu); the icons leave the menu open. A recipe file
 * that cannot be read is grayed with its reason, and keeps Remove. */
export function CustomRecipeItems({ recipes, dispatch, add, testPrefix }: { recipes: NodeRecipe[]; dispatch: D; add: (r: NodeRecipe) => void; testPrefix: string }) {
  const [naming, setNaming] = useState<{ id: string; name: string } | null>(null);
  return (
    <>
      <div data-hint="Add recipe files (.heelerrecipe) to your recipes; a file that cannot be read says why">
        <button data-testid={`${testPrefix}-import`} onClick={() => void importRecipeFiles(dispatch)} style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <ImportIcon />
          Import…
        </button>
      </div>
      <div className="sep" />
      {recipes.length === 0 && (
        <div data-hint="Group some nodes in the graph, then right-click the group and choose Save as Recipe.">
          <button disabled data-testid={`${testPrefix}-none`} style={{ opacity: 0.4 }}>
            None saved yet
          </button>
        </div>
      )}
      {recipes.map((r) => {
        const editing = naming?.id === r.id;
        return (
          <div key={r.id} data-testid={`${testPrefix}-row-${r.id}`} data-hint={r.error ?? r.blurb} style={{ display: "flex", alignItems: "center", gap: 2 }}>
            {editing ? (
              <input
                autoFocus
                data-testid={`${testPrefix}-name-input`}
                aria-label="Recipe name"
                value={naming!.name}
                onChange={(e) => setNaming({ id: r.id, name: e.target.value })}
                onKeyDown={(e) => {
                  // The menu's own keys (arrows, Escape) stay out of the field.
                  e.stopPropagation();
                  if (e.key === "Enter") {
                    if (naming!.name.trim()) dispatch({ type: "rename_recipe", id: r.id, name: naming!.name.trim() });
                    setNaming(null);
                  }
                  if (e.key === "Escape") setNaming(null);
                }}
                onBlur={() => setNaming(null)}
                style={{ flex: 1, minWidth: 0, background: "var(--bg-app)", border: "none", color: "var(--text-hi)", font: "inherit", padding: "4px 6px", outline: "none" }}
              />
            ) : (
              <button
                data-testid={`${testPrefix}-recipe-${r.id}`}
                disabled={!!r.error}
                style={{ flex: 1, minWidth: 0, ...(r.error ? { opacity: 0.4 } : {}) }}
                onClick={() => !r.error && add(r)}
              >
                {r.name}
              </button>
            )}
            {!editing && !r.error && (
              <button data-testid={`${testPrefix}-export-${r.id}`} aria-label={`Export ${r.name}`} data-tip="Export…" data-hint="Save this recipe as a .heelerrecipe file to share or edit by hand" onClick={() => void exportRecipeFile(r, dispatch)} style={ICON_BUTTON}>
                <ExportIcon />
              </button>
            )}
            {!editing && !r.error && (
              <button data-testid={`${testPrefix}-rename-${r.id}`} aria-label={`Rename ${r.name}`} data-tip="Rename" data-hint="Give this recipe a new name" onClick={() => setNaming({ id: r.id, name: r.name })} style={ICON_BUTTON}>
                <RenameIcon />
              </button>
            )}
            {!editing && (
              <button
                data-testid={`${testPrefix}-remove-${r.id}`}
                aria-label={`Remove ${r.name}`}
                data-tip="Remove"
                data-hint="Take this recipe off the list (its file moves to the recipes folder's .trash); groups already dropped stay in their graphs"
                onClick={() => dispatch({ type: "remove_recipe", id: r.id })}
                style={ICON_BUTTON}
              >
                <TrashIcon size={14} />
              </button>
            )}
          </div>
        );
      })}
    </>
  );
}
