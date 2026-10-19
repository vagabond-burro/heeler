import { useDialogFocus } from "./dialogfocus";
// Freeze current edits into a new photograph beside the source.

import type { ImageEntry, State } from "../state";
import { BAKE_FORMATS } from "../bridge";
import { type D, runBake } from "./bakeparts";

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
