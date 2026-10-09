// Shift+Space: add a node without going to a menu.
//
// A search field and the nodes you reached for most recently, which
// between them cover almost every add: either you know what you want and
// type three letters of it, or it is one of the handful you always use.
// The menus stay for browsing, which is a different activity from
// reaching.

import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import type { Category, Command, State } from "../state";
import { CATEGORY_LABEL, NODE_CATALOG, byName, searchNodes, specFor, type NodeSpec } from "../nodes";
import { BUILTIN_RECIPES, searchRecipes, type NodeRecipe } from "../noderecipes";
import { useDialogFocus } from "./dialogfocus";
import { addRecipeAt } from "./addnode";
import { exportRecipeFile, importRecipeFiles, refreshRecipeFiles } from "../recipefiles";
import { scrollItemIntoList } from "./hooks";

type D = React.Dispatch<Command>;

/** How many recent nodes the shortlist holds. A preference, because five
 * is right for someone with three habits and twenty for someone with a
 * lot of them. */
export const RECENTS_MIN = 5;
export const RECENTS_MAX = 20;
export const RECENTS_DEFAULT = 10;

export function clampRecents(n: number): number {
  if (!Number.isFinite(n)) return RECENTS_DEFAULT;
  return Math.min(RECENTS_MAX, Math.max(RECENTS_MIN, Math.round(n)));
}

/** What the palette shows: matches while typing, recents when not.
 *
 * Split out so the ordering is testable without a keyboard. The recents
 * shortlist falls back to the catalog's own order when there is no
 * history, because an empty palette on first use looks broken.
 */
export function paletteItems(query: string, recents: string[], limit: number, cat?: Category): NodeSpec[] {
  // Opened from a legend glyph: that category, the whole of it, in
  // catalog order; a search still searches everything, since typing is
  // a stronger statement than the glyph was.
  if (cat) {
    const within = byName(NODE_CATALOG.filter((s) => s.cat === cat));
    return query.trim() ? searchNodes(query).filter((s) => s.cat === cat) : within;
  }
  if (query.trim()) return searchNodes(query);
  const known = recents.map(specFor).filter((s): s is NodeSpec => !!s);
  if (known.length >= limit) return known.slice(0, limit);
  // Recents keep their recency; what fills the list after them reads
  // alphabetically, like the menus.
  const rest = byName(NODE_CATALOG.filter((s) => !known.some((k) => k.type === s.type)));
  return [...known, ...rest].slice(0, limit);
}

/** The palette's Recipes section (node recipes, 2026-09-30): every
 * built-in and every recipe this person saved, matched by the same
 * query, under the nodes. A legend glyph's category view is about
 * nodes, so it lists none. */
export function paletteRecipes(query: string, userRecipes: readonly NodeRecipe[], cat?: Category): NodeRecipe[] {
  if (cat) return [];
  return searchRecipes([...BUILTIN_RECIPES, ...userRecipes], query);
}

export function NodePalette({
  state,
  dispatch,
  onAdd,
  onAddRecipe,
  recentsLimit,
}: {
  state: State;
  dispatch: D;
  onAdd: (spec: NodeSpec, x?: number, y?: number) => void;
  /** Where a chosen recipe goes; the graph's own drop by default. */
  onAddRecipe?: (recipe: NodeRecipe, x?: number, y?: number) => void;
  recentsLimit: number;
}) {
  const [query, setQuery] = useState("");
  const [at, setAt] = useState(0);
  // A user recipe being renamed in place: its id and the name so far.
  const [naming, setNaming] = useState<{ id: string; name: string } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const open = state.palette !== null;
  const focus = useDialogFocus(open);
  const listId = useId();
  const listRef = useRef<HTMLDivElement>(null);

  const cat = state.palette?.cat;
  const items = useMemo(
    () => paletteItems(query, state.recentNodes, recentsLimit, cat),
    [query, state.recentNodes, recentsLimit, cat]
  );
  const recipes = useMemo(() => paletteRecipes(query, state.userRecipes, cat), [query, state.userRecipes, cat]);
  // One list for the arrows: the nodes, then the recipes.
  const total = items.length + recipes.length;

  useEffect(() => {
    if (open) {
      setQuery("");
      setAt(0);
      // The point of a search palette is that you can start typing
      // immediately.
      inputRef.current?.focus();
      // The recipes folder read again, so a file edited or added by
      // hand lists now (nothing happens outside the desktop).
      void refreshRecipeFiles(dispatch).catch(() => {});
    }
  }, [open]);

  useEffect(() => setAt(0), [query]);
  useEffect(() => {
    // By offsets, never scrollIntoView: the palette wears .ui-zoom, and
    // inside a CSS zoom WebKit scrolls to the wrong place (the ui-zoom
    // trap), which can leave the keyboard's row off the bottom of a
    // short window at a large UI zoom.
    const list = listRef.current;
    const row = list?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (list && row) scrollItemIntoList(list, row);
  }, [at, open, items]);

  if (!open) return null;
  const spot = state.palette!;

  const choose = (spec: NodeSpec | undefined) => {
    if (!spec) return;
    onAdd(spec, spot.x, spot.y);
    dispatch({ type: "note_recent_node", nodeType: spec.type });
    dispatch({ type: "close_palette" });
  };
  const chooseRecipe = (recipe: NodeRecipe | undefined) => {
    // A file that could not be read is listed for its message, not dropped.
    if (!recipe || recipe.error) return;
    (onAddRecipe ?? ((r, x, y) => addRecipeAt(state, dispatch, r, x, y)))(recipe, spot.x, spot.y);
    dispatch({ type: "close_palette" });
  };
  const chooseAt = (i: number) => (i < items.length ? choose(items[i]) : chooseRecipe(recipes[i - items.length]));

  return (
    <div
      data-testid="node-palette-backdrop"
      style={{ position: "fixed", inset: 0, zIndex: 70, background: "rgba(12,11,10,.45)", display: "flex", justifyContent: "center", alignItems: "flex-start", padding: "min(120px, 12vh) 12px 12px", boxSizing: "border-box" }}
      onMouseDown={() => dispatch({ type: "close_palette" })}
    >
      <div
        data-testid="node-palette"
        ref={focus}
        role="dialog" aria-modal="true" aria-label="Add a node"
        // The Preferences dialog's zoom and type sizes ("needs to be
        // larger. The fonts should be the same size as the font size in
        // Preferences"). Zoom on the inner box, never the fixed backdrop, which
        // is why the backdrop centers it with flex.
        className="ui-zoom"
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          width: "min(480px, calc((100vw - 24px) / var(--chrome-zoom)))",
          maxHeight: "calc((100vh - min(120px, 12vh) - 12px) / var(--chrome-zoom))",
          display: "flex", flexDirection: "column", boxSizing: "border-box",
          background: "#191817",
          border: "1px solid var(--line-4)",
          boxShadow: "0 18px 44px rgba(0,0,0,.55)",
        }}
      >
        <input
          ref={inputRef}
          data-testid="palette-search"
          data-initial-focus
          role="combobox" aria-label="Add a node" aria-expanded="true" aria-autocomplete="list"
          aria-controls={listId} aria-activedescendant={at < total ? `${listId}-${at}` : undefined}
          placeholder="Add a node…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Escape") dispatch({ type: "close_palette" });
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setAt((i) => Math.min(total - 1, i + 1));
            }
            if (e.key === "ArrowUp") {
              e.preventDefault();
              setAt((i) => Math.max(0, i - 1));
            }
            if (e.key === "Enter") chooseAt(at);
          }}
          style={{
            width: "100%",
            boxSizing: "border-box",
            background: "var(--bg-app)",
            border: "none",
            borderBottom: "1px solid var(--line-2)",
            color: "var(--text-hi)",
            fontSize: 13.5,
            padding: "9px 12px",
            outline: "none",
            flex: "none",
          }}
        />
        {!query.trim() && (
          <div className="kicker" data-testid="palette-heading" style={{ fontSize: 10, letterSpacing: ".14em", padding: "8px 12px 3px" }}>
            {cat ? CATEGORY_LABEL[cat] : state.recentNodes.length > 0 ? "Recent" : "Nodes"}
          </div>
        )}
        <div id={listId} ref={listRef} role="listbox" aria-label="Nodes" style={{ position: "relative", minHeight: 0, maxHeight: 440, overflowY: "auto", padding: "2px 0 6px" }}>
          {total === 0 && (
            <div style={{ fontSize: 13.5, color: "var(--text-ghost)", padding: "10px 12px" }}>
              Nothing matches “{query}”
            </div>
          )}
          {items.map((spec, i) => (
            <button
              key={spec.type}
              id={`${listId}-${i}`} role="option" aria-selected={i === at} tabIndex={-1}
              data-testid={`palette-item-${spec.type}`}
              data-active={i === at}
              onMouseEnter={() => setAt(i)}
              onClick={() => choose(spec)}
              style={{
                all: "unset",
                boxSizing: "border-box",
                display: "block",
                width: "100%",
                cursor: "pointer",
                padding: "6px 12px",
                background: i === at ? "#202326" : "transparent",
              }}
            >
              <div style={{ fontSize: 14, color: i === at ? "var(--text-hi)" : "var(--text-body)" }}>
                {spec.name}
              </div>
              <div style={{ fontSize: 13.5, color: "var(--text-ghost)", marginTop: 1 }}>{spec.blurb}</div>
            </button>
          ))}
          {recipes.length > 0 && (
            <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "10px 12px 3px" }}>
              <div className="kicker" data-testid="palette-recipes-heading" style={{ fontSize: 11, letterSpacing: ".14em", flex: 1 }}>
                Recipes
              </div>
              {/* Recipe files (2026-10-01): bring .heelerrecipe files
                  into the recipes folder, as presets are imported. */}
              <button
                className="chip"
                tabIndex={-1}
                data-testid="palette-recipe-import"
                data-hint="Add recipe files (.heelerrecipe) to your recipes; a file that cannot be read says why"
                onClick={() => void importRecipeFiles(dispatch)}
                style={{ fontSize: 11 }}
              >
                Import…
              </button>
            </div>
          )}
          {recipes.map((r, k) => {
            const i = items.length + k;
            const editing = naming?.id === r.id;
            return (
              <div
                key={r.id}
                id={`${listId}-${i}`} role="option" aria-selected={i === at} aria-disabled={r.error ? true : undefined}
                data-testid={`palette-recipe-${r.id}`}
                data-active={i === at}
                data-error={r.error ? true : undefined}
                onMouseEnter={() => setAt(i)}
                style={{ display: "flex", alignItems: "flex-start", gap: 6, padding: "6px 12px", background: i === at ? "#202326" : "transparent" }}
              >
                {editing ? (
                  <input
                    autoFocus
                    data-testid="palette-recipe-name-input"
                    aria-label="Recipe name"
                    value={naming!.name}
                    onChange={(e) => setNaming({ id: r.id, name: e.target.value })}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === "Enter") {
                        if (naming!.name.trim()) dispatch({ type: "rename_recipe", id: r.id, name: naming!.name.trim() });
                        setNaming(null);
                      }
                      if (e.key === "Escape") setNaming(null);
                    }}
                    onBlur={() => setNaming(null)}
                    style={{ flex: 1, minWidth: 0, background: "var(--bg-app)", border: "none", color: "var(--text-hi)", fontSize: 14, padding: "2px 4px", outline: "none" }}
                  />
                ) : r.error ? (
                  // A recipe file that could not be read: grayed, with
                  // the reason and its line, so it can be fixed by hand.
                  <div data-testid={`palette-recipe-error-${r.id}`} style={{ flex: 1, minWidth: 0, opacity: 0.6 }}>
                    <div style={{ fontSize: 14, color: "var(--text-faint)" }}>{r.name}</div>
                    <div style={{ fontSize: 13.5, color: "var(--warn)", marginTop: 1, overflowWrap: "anywhere" }}>{r.error}</div>
                  </div>
                ) : (
                  <button
                    tabIndex={-1}
                    data-testid={`palette-recipe-add-${r.id}`}
                    onClick={() => chooseRecipe(r)}
                    style={{ all: "unset", flex: 1, minWidth: 0, cursor: "pointer" }}
                  >
                    <div style={{ fontSize: 14, color: i === at ? "var(--text-hi)" : "var(--text-body)" }}>{r.name}</div>
                    <div style={{ fontSize: 13.5, color: "var(--text-ghost)", marginTop: 1 }}>{r.blurb}</div>
                  </button>
                )}
                {/* Any recipe that reads, the built-ins included (a
                    built-in's file is a worked example to edit). */}
                {!r.error && !editing && (
                  <button
                    className="chip"
                    tabIndex={-1}
                    data-testid={`palette-recipe-export-${r.id}`}
                    data-hint="Save this recipe as a .heelerrecipe file to share or edit by hand"
                    onClick={() => void exportRecipeFile(r, dispatch)}
                    style={{ fontSize: 11 }}
                  >
                    Export…
                  </button>
                )}
                {/* A person's own recipes can be renamed and taken off
                    the list; the built-ins are the app's. Rename renames
                    the file; Remove moves it into recipes/.trash. */}
                {!r.builtin && !editing && (
                  <>
                    {!r.error && (
                      <button
                        className="chip"
                        tabIndex={-1}
                        data-testid={`palette-recipe-rename-${r.id}`}
                        data-hint="Give this recipe a new name"
                        onClick={() => setNaming({ id: r.id, name: r.name })}
                        style={{ fontSize: 11 }}
                      >
                        Rename
                      </button>
                    )}
                    <button
                      className="chip"
                      tabIndex={-1}
                      data-testid={`palette-recipe-remove-${r.id}`}
                      data-hint="Take this recipe off the list (its file moves to the recipes folder's .trash); groups already dropped stay in their graphs"
                      onClick={() => dispatch({ type: "remove_recipe", id: r.id })}
                      style={{ fontSize: 11 }}
                    >
                      Remove
                    </button>
                  </>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
