
import { INTERP_CYCLE, INTERP_LABEL, type InterpGlyphMode } from "./interpglyphparts";

const S_CURVE = "M2 13C14 13 10 2 22 2";
const INTERP_WHAT: Record<InterpGlyphMode, string> = {
  smooth: "the automatic curve through the points",
  linear: "rulers between the points",
  tangent: "drag a point's handles to steer and stretch the slope",
};

/** One button for the three faces (2026-09-14: "take the 3 buttons for
 * Smooth/Linear/Tangent and make them one button and clicking on it
 * cycles through the point types"). It wears the current face's glyph
 * and names the next one, so a screen reader and the hint both say
 * what the click does. `testid` is the host's ("curve-interp",
 * "eq-interp"); `data-mode` carries the face for tests and styling.*/
export function InterpCycle({
  mode,
  testid,
  onChange,
}: {
  mode: InterpGlyphMode;
  testid: string;
  onChange: (next: InterpGlyphMode) => void;
}) {
  const next = INTERP_CYCLE[(INTERP_CYCLE.indexOf(mode) + 1) % INTERP_CYCLE.length];
  const label = `${INTERP_LABEL[mode]}: ${INTERP_WHAT[mode]}. Click for ${INTERP_LABEL[next].toLowerCase()}`;
  return (
    <button
      className="chip"
      data-testid={testid}
      data-mode={mode}
      aria-label={label}
      data-hint={label}
      style={{ padding: "2px 6px", display: "inline-flex", alignItems: "center" }}
      onClick={() => onChange(next)}
    >
      <InterpGlyph mode={mode} />
    </button>
  );
}

export function InterpGlyph({ mode }: { mode: InterpGlyphMode }) {
  return (
    <svg width="14" height="9" viewBox="0 0 24 15" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden focusable="false">
      <path d={mode === "linear" ? "M2 13L11 10L22 2" : S_CURVE} />
      {mode === "tangent" && (
        <>
          <path d="M7 13.5L17 1.5" strokeWidth="1.2" />
          <circle cx="7" cy="13.5" r="1.8" fill="currentColor" stroke="none" />
          <circle cx="17" cy="1.5" r="1.8" fill="currentColor" stroke="none" />
          <circle cx="12" cy="7.5" r="2.2" fill="var(--bg-app)" strokeWidth="1.5" />
        </>
      )}
    </svg>
  );
}
