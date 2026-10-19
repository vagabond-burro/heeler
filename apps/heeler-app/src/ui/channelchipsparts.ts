// channelchips.tsx's values and helpers that are not components, kept apart so
// channelchips.tsx exports components alone and Vite can refresh it in place as
// it is edited instead of reloading the window.
/** The RGB / R / G / B / LUM row, once.
 *
 * 2026-08-27: "We essentially have (at least) 2 sets of buttons that
 * serve similar purposes but do not follow the same design
 * specification. I think how the RGB, R, G, B, and LUM buttons are in
 * Adjustments > Curves should be the standard."
 *
 * They were two rows: the Curves editor drew chips that light up in
 * their own channel's color, and the histogram drew a segmented strip
 * of smaller buttons that lit up accent-blue whichever channel it was,
 * and called the last one "Luma" instead of "LUM". Same five channels,
 * two dialects, three inconsistencies (size, active color, labels).
 *
 * This is the Curves version, extracted rather than re-specified, so
 * the standard is a component and not a paragraph somebody has to
 * remember. The next place that needs these five buttons imports it.
 */

import type { CurveChannel } from "../state";

/** The five, with the color each one lights up in.
 *
 * The palette is load-bearing and was chosen against the accent: B is
 * slate rather than the amber it replaced, because "the orange is about
 * as close to red as the blue accent is to the blue channel". At
 * #4272e0 the accent sits 55.7 dE away, further apart than the pair it
 * replaced ever was.
 */
export const CHANNEL_CHIPS: { id: CurveChannel; label: string; color: string }[] = [
  { id: "rgb", label: "RGB", color: "var(--accent)" },
  // Each channel's own hue, lifted until it is readable as lettering
  // rather than only recognizable as a color: R ran 3.90:1 against the
  // panel head and B 3.72:1, where small text needs 4.5. Hue and
  // saturation are untouched, so red still says red; only the lightness
  // moved.
  { id: "r", label: "R", color: "#c86c6c" },
  { id: "g", label: "G", color: "#7ec25b" },
  { id: "b", label: "B", color: "#5983e4" },
  // Luminosity: scales RGB proportionally in the engine, so pulling it
  // down darkens without the saturation push RGB curves cause.
  { id: "luma", label: "LUM", color: "#c2c7cb" },
];

/** The Curves editor's CMY face (, "Expand on the color
 * channels and add four buttons CMY, C, M, and Y to the curves"): the
 * same four stored curves as the RGB chips, seen as ink, so each chip
 * names the channel it shows. C is the red curve, M the green, Y the
 * blue and CMY the composite; LUM is the same in both faces. The
 * Spectrums histogram wears it too (2026-10-02: "the same thing for
 * Spectrums > Histogram"), through ChannelChips' `face`.
 *
 * Each lit in its ink, lifted to read as lettering the way R, G and B
 * were; the composite takes the paper tone, the one neutral left that
 * is neither the accent nor LUM's gray. */
export const INK_CHIPS: { id: CurveChannel; label: string; color: string }[] = [
  { id: "rgb", label: "CMY", color: "#d2c3a4" },
  { id: "r", label: "C", color: "#4fb9c6" },
  { id: "g", label: "M", color: "#cc6fb8" },
  { id: "b", label: "Y", color: "#c9b44a" },
  { id: "luma", label: "LUM", color: "#c2c7cb" },
];

/** The box every chip in these rows wears.
 *
 * The line height is the part worth naming: it makes a chip holding
 * nine-pixel text exactly as tall as one holding a thirteen-pixel icon,
 * which is what lets the channel row, the EV toggle and the harmony
 * families sit at one height ("The channel buttons should
 * be the same height as the buttons under Harmony"). Without it the
 * text chips were two pixels shorter and every row of them read as a
 * different control.
 */
export const CHIP_METRICS = {
  padding: "2px 8px",
  fontSize: 9,
  letterSpacing: ".08em",
  lineHeight: "13px",
} as const;

/** The same box, 1.25x, for the pop-out window. "the
 * buttons in the Spectrums popout could be scaled by 1.25x": a window
 * that can be dragged to a second monitor is read from further away
 * than a panel at arm's length, and its chrome had stayed panel-sized.*/
export const CHIP_METRICS_LARGE = {
  padding: "3px 10px",
  fontSize: 11.25,
  letterSpacing: ".08em",
  lineHeight: "16px",
} as const;
