// eqeditor.tsx's values and helpers that are not components, kept apart so
// eqeditor.tsx exports components alone and Vite can refresh it in place as
// it is edited instead of reloading the window.
import { isMac, modLabel } from "../platform";

/** How far the plot sits in from the editor's left edge, for its axis
 * labels. Exported so a host can line its own controls up with the
 * spectrum's left edge ("Left align BY / ADJUST with the
 * left edge of the spectrum").*/
export const EQ_PLOT_INSET = 34;

/** Illuminance histogram in EV bins, read from the on-screen frame the
 * way every scope reads it: decode the transfer, log2 around middle
 * gray. Returns bin fractions plus how much mass sits beyond each edge
 * of the window, for the edge arrows. */
/** A spectrum bar's color: the hue at the center of bin `i` of `n`
 * across the domain, drawn the way the hue strip draws it. */
export function spectrumBarFill(i: number, n: number, domain: [number, number]): string {
  const hue = domain[0] + ((i + 0.5) / n) * (domain[1] - domain[0]);
  return `hsl(${Math.round(((hue % 360) + 360) % 360)} 90% 55%)`;
}

/** The point gestures, spelled in the OS's own keys ("It
 * says ALT click to remove... when it should be OS aware like in
 * curves"). On a Mac the key is Option, and a legend saying ALT sent
 * him hunting for a key his keyboard does not label.*/
export function eqHelpText(): string {
  return `2\u00d7click add \u00b7 ${modLabel("alt")}-click remove \u00b7 ${modLabel("shift")}-drag snaps \u00b7 ${isMac() ? "\u2325/\u2318" : "ALT"} mid-drag locks an axis \u00b7 2\u00d7click point: auto tangents`;
}
