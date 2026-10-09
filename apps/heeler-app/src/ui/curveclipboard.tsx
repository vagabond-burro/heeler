// Copy and paste for a curve (, 2026-09-28): "For Curves and Recolor
// a feature that allows a user to copy the curve from one setting to
// another. This is not meant to copy curves between Curves tool and
// Recolor, as Curves is a different layout."
//
// One pair of buttons for both tools. Each tool keeps its own clipboard
// in the state (curveClipboard, recolorClipboard), so a Curves copy can
// never land in Recolor or the reverse; the buttons only say what the
// clipboard holds and hand the click back to the tool, whose paste is
// its ordinary curve write, one undo step.

import type { EqPoint } from "../eqcurve";
import { CopyIcon, PasteIcon } from "./panelicons";

/** The pair: Copy, then Paste, icon buttons in the chip dress the
 * curve editors' reset wears. Paste is disabled with nothing to paste;
 * `pasteBlocked` says why when the clipboard holds a curve this one
 * cannot take. */
export function CurveClipButtons({
  testid,
  what,
  onCopy,
  onPaste,
  clipLabel,
  pasteBlocked,
}: {
  /** the test id prefix: `${testid}-copy`, `${testid}-paste` */
  testid: string;
  /** the shown curve's name, for the hints ("the R curve") */
  what: string;
  onCopy: () => void;
  onPaste: () => void;
  /** the copied curve's name, or null with nothing copied */
  clipLabel: string | null;
  /** why a copied curve cannot be pasted here, or null when it can */
  pasteBlocked?: string | null;
}) {
  const canPaste = clipLabel !== null && !pasteBlocked;
  const pasteHint =
    clipLabel === null
      ? `Paste a copied curve over ${what}: copy one first`
      : pasteBlocked
        ? pasteBlocked
        : `Replace ${what} with the copied ${clipLabel} curve, as it was shown (one undo step)`;
  const box = { padding: "2px 6px", display: "flex", alignItems: "center" } as const;
  return (
    <div role="group" aria-label="Curve clipboard" style={{ display: "flex", gap: 2 }}>
      <button
        className="chip bare"
        data-testid={`${testid}-copy`}
        aria-label={`Copy ${what}`}
        data-hint={`Copy ${what}, to paste onto another channel's curve`}
        style={box}
        onClick={onCopy}
      >
        <CopyIcon />
      </button>
      {/* The hint rides a wrapper: a disabled button takes no pointer
          events, and "copy one first" is the thing it must still say. */}
      <span data-hint={pasteHint} style={{ display: "flex" }}>
        <button
          className="chip bare"
          data-testid={`${testid}-paste`}
          aria-label={clipLabel === null ? `Paste over ${what}` : `Paste the ${clipLabel} curve over ${what}`}
          data-hint={pasteHint}
          disabled={!canPaste}
          style={{ ...box, opacity: canPaste ? 1 : 0.4 }}
          onClick={() => {
            if (canPaste) onPaste();
          }}
        >
          <PasteIcon />
        </button>
      </span>
    </div>
  );
}

/** A Recolor curve carried onto another ADJUST under the same BY: x
 * stays (the BY axis is the same axis), y and the handles' y scale from
 * the range it was drawn against to the range it lands in, so the
 * shape the plot showed is the shape pasted (a Sat curve at +50 of 100
 * is a Hue curve at +30 of 60). Every range is symmetric about zero. */
export function scaleRecolorPoints(points: EqPoint[], from: [number, number], to: [number, number]): EqPoint[] {
  const k = (to[1] - to[0]) / Math.max(1e-9, from[1] - from[0]);
  const scaled = (v: [number, number] | undefined): [number, number] | undefined => (v ? [v[0], v[1] * k] : undefined);
  return points.map((p) => {
    const out: EqPoint = { ...p, y: k === 1 ? p.y : p.y * k };
    if (p.l && k !== 1) out.l = scaled(p.l);
    if (p.r && k !== 1) out.r = scaled(p.r);
    return out;
  });
}
