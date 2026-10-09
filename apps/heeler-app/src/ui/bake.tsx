import { useDialogFocus } from "./dialogfocus";
// Freeze current edits into a new photograph beside the source.

import React from "react";
import type { Command, ImageEntry, State } from "../state";
import { freshGraphFor } from "../state";
import { BAKE_FORMATS, STACK_SET_ASIDE, bakeComposite, loadGraph } from "../bridge";
import { BAKE_CANCELED, watchBake } from "./opprogress";
import { logMsg } from "../log";
import { thumbnailForNew } from "./chrome";

type D = React.Dispatch<Command>;

/** Bakes each photograph in turn and hands back what was made.
 *
 * Sequential rather than at once, and deliberately: a full-resolution
 * merge of eight frames is gigabytes of working memory, and three of them
 * running together is how you find that out the hard way.
 */
export async function runBake(
  state: State,
  ids: string[],
  format: string,
  dispatch: D,
): Promise<ImageEntry[]> {
  const made: ImageEntry[] = [];
  for (const id of ids) {
    const entry = state.images.find(i => i.id === id);
    // While its stack merges, the bake's dialog shows the merge's card
    // (BakeProgressDialog), then its own bar.
    dispatch({ type: "set_baking", id });
    try {
      const graph = id === state.activeImage
        ? { nodes: state.nodes, wires: state.wires }
        : state.graphs[id] ?? await loadGraph(id) ?? freshGraphFor(state, id);
      // Under the bake progress dialog, with its Cancel. The desktop
      // honors Cancel before each stage; one pressed while the file is
      // being written comes too late, and the file it wrote is kept and
      // shown (nothing here deletes files), so the answer is held apart
      // from watchBake's canceled null.
      let answered: { image: ImageEntry | null } | null = null;
      await watchBake(
        `Baking ${entry?.name ?? "the photograph"}`,
        () => bakeComposite(id, format, graph, 92, entry, id !== state.activeImage).then((image) => (answered = { image })),
      );
      if (answered === null) {
        logMsg("info", "Bake canceled");
        break;
      }
      const image = (answered as { image: ImageEntry | null }).image;
      if (!image) {
        logMsg("info", "Baking needs the desktop app and a photograph on disk.");
        break;
      }
      // The edits are pixels now. Copying the recipe would apply them twice.
      const row = { ...image, edited: false };
      made.push(row);
      dispatch({ type: "add_stack_image", image: row });
      logMsg("info", `Baked ${image.name}`);
      void thumbnailForNew(image.id, dispatch, state.prefs.thumbnailEdge, image.name, image);
    } catch (e) {
      // Cancel merge on the stack the bake was waiting for ends the bake
      // too; that is a cancel, not a failure.
      const why = String(e);
      if (why.includes(STACK_SET_ASIDE) || why.includes(BAKE_CANCELED)) {
        logMsg("info", "Bake canceled");
      } else {
        logMsg("error", `Baking failed: ${why}`);
      }
      break;
    } finally {
      dispatch({ type: "set_baking", id: null });
    }
  }
  return made;
}

export function BakeDialog({ state, dispatch }: { state: State; dispatch: D }) {
  const bake = state.bake;
  const focus = useDialogFocus(!!bake);
  if (!bake) return null;

  const names = bake.ids
    .map((id) => state.images.find((i) => i.id === id))
    .filter((i): i is ImageEntry => !!i)
    .map((i) => i.name);
  const format = BAKE_FORMATS.find((f) => f.id === state.bakeFormat) ?? BAKE_FORMATS[0];

  // Bake closes this dialog at once and the bake runs under its own
  // progress (2026-10-08: the stack's merge card showed behind this
  // dialog while it sat on "Baking…"; "close the backing dialog, show
  // the stacking dialog, then show a baking progress dialog").
  const go = () => {
    dispatch({ type: "close_bake" });
    void runBake(state, bake.ids, state.bakeFormat, dispatch);
  };

  return (
    <div className="modal-scrim" data-testid="bake-scrim">
      <div ref={focus} role="dialog" aria-modal="true" aria-label="Bake to an image" tabIndex={-1} className="modal" data-testid="bake-dialog" style={{ width: 520 }}>
        {/* Type at Preferences' sizes, 14 for labels and 13.5 for the
explanations (2026-09-10: "way too small. It should use the same
font size as preferences").*/}
        <div className="kicker" data-testid="bake-title">
          {names.length > 1 ? `Bake ${names.length} photographs` : "Bake to an image"}
        </div>
        <p data-testid="bake-names" style={{ fontSize: 14, lineHeight: 1.5, color: "var(--text-body)", margin: "10px 0 6px" }}>
          {names.length === 1 ? names[0] : names.join(", ")}
        </p>
        <p data-testid="bake-blurb" style={{ fontSize: 13.5, lineHeight: 1.55, color: "var(--text-ghost)", margin: "0 0 16px" }}>
          Creates a new file beside the original with the edits rendered in. The original is untouched.
          Merges and panoramas include their edits too; a neutral recipe keeps the merged result.
        </p>

        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
          <div data-testid="bake-format-label" style={{ fontSize: 14, color: "var(--text-body)", width: 70 }}>Format</div>
          <div
            className="zoom-seg"
            role="group"
            aria-label="Bake format"
            style={{ border: "1px solid var(--line-4)" }}
          >
            {BAKE_FORMATS.map((f) => (
              <button
                key={f.id}
                aria-pressed={state.bakeFormat === f.id}
                data-active={state.bakeFormat === f.id}
                data-testid={`bake-format-${f.id}`}
                data-hint={f.hint}
                style={{ fontSize: 12, padding: "4px 14px" }}
                onClick={() => dispatch({ type: "set_bake_format", format: f.id })}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>
        <div
          data-testid="bake-format-hint"
          style={{ fontSize: 13.5, color: "var(--text-ghost)", lineHeight: 1.55, marginBottom: 18 }}
        >
          {format.hint}.{" "}
          {format.id === "dng"
            ? "DNG keeps highlights past white and opens with fresh controls."
            : "Anything brighter than white clips."}
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button className="chip" data-testid="bake-cancel" style={{ fontSize: 12, padding: "3px 12px" }} onClick={() => dispatch({ type: "close_bake" })}>
            Cancel
          </button>
          <button className="chip" data-testid="bake-ok" style={{ fontSize: 12, padding: "3px 12px" }} onClick={go}>
            Bake
          </button>
        </div>
      </div>
    </div>
  );
}
