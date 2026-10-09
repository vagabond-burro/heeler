// "Layers from File..." (26.3 Phase 7 import): the picker the Layer
// menu opens over a file the user chose from disk. The passes report
// has already been read and turned into choices by the reducer; this
// dialog only checks entries and confirms.
//
// Every chosen entry becomes one image layer at the top of the Finish
// stack, Normal, 100%, its content a File node referencing the source
// by page or layer name. The pixels are never copied into the catalog,
// so a moved file shows the layer as missing, the way a missing
// photograph does.

import React, { useState } from "react";
import type { Command, State } from "../state";
import { Shell } from "./selectdialogs";
import { imageLayerProbe } from "../bridge";
import { restBoxFor } from "./imagelayers";

type D = React.Dispatch<Command>;

function Picker({ state, dispatch }: { state: State; dispatch: D }) {
  const offer = state.fileLayersOffer!;
  // All checked to begin with: the menu item was reached for, so the
  // common case is "everything the file holds".
  const [on, setOn] = useState<boolean[]>(() => offer.choices.map(() => true));
  const chosen = offer.choices.filter((_, i) => on[i]);
  const base = offer.path.split(/[\\/]/).pop() ?? offer.path;
  const confirm = () => {
    dispatch({ type: "close_file_layers" });
    if (chosen.length === 0) return;
    // Each entry is placed like any image layer (2026-09-30): centered
    // and fitted on its own size, a page or an EXR layer measured on
    // its own, so a transform moves the picture rather than a frame.
    void Promise.all(
      chosen.map(async (c) => {
        const probe = await imageLayerProbe({ kind: "file", path: offer.path, layer: c.layer });
        return { layer: c.layer, name: c.label, box: restBoxFor(state, probe) };
      }),
    ).then((items) => dispatch({ type: "art_add_file_layers", path: offer.path, items }));
  };
  return (
    <Shell
      testid="file-layers-dialog"
      title="Layers from File"
      blurb={`${base}: each checked entry becomes an image layer at the top of the Finish stack, referenced from the file in place rather than copied in.`}
      onCancel={() => dispatch({ type: "close_file_layers" })}
      onDone={confirm}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {offer.choices.map((c, i) => (
          <label
            key={`${c.layer}-${i}`}
            data-testid={`file-layers-choice-${i}`}
            style={{
              display: "flex", alignItems: "center", gap: 7, cursor: "pointer",
              fontSize: 11, color: "var(--text-body)", padding: "2px 1px",
            }}
          >
            <input
              type="checkbox"
              checked={on[i] ?? false}
              onChange={() => setOn((prev) => prev.map((v, j) => (j === i ? !v : v)))}
            />
            {c.label}
          </label>
        ))}
      </div>
      {offer.note && (
        <div data-testid="file-layers-note" className="help" style={{ marginTop: 9 }}>
          {offer.note}
        </div>
      )}
      <div data-testid="file-layers-count" style={{ fontSize: 11, color: "var(--text-mid)", marginTop: 9 }}>
        {chosen.length === 0
          ? "Nothing checked; Done adds nothing."
          : `${chosen.length} layer${chosen.length === 1 ? "" : "s"} to add.`}
      </div>
    </Shell>
  );
}

export function FileLayersDialog({ state, dispatch }: { state: State; dispatch: D }) {
  const offer = state.fileLayersOffer;
  if (!offer) return null;
  // Keyed on the path: a second pick while one is open starts its
  // checks fresh rather than inheriting the first file's.
  return <Picker key={offer.path} state={state} dispatch={dispatch} />;
}
