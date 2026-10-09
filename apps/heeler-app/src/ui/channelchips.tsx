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

import type React from "react";
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

/** One chip. Exported for the rows that need to interleave other
 * buttons among them (the Curves toolbar puts its eyedropper first). */
export function ChannelChip({
  channel,
  active,
  onPick,
  testid,
  tabIndex,
  metrics = CHIP_METRICS,
  hint,
  onKeyDown,
}: {
  channel: (typeof CHANNEL_CHIPS)[number];
  active: boolean;
  onPick: (e: React.MouseEvent) => void;
  /** the row's own naming, since two rows on screen at once must not
   * share test ids */
  testid: string;
  tabIndex?: number;
  /** CHIP_METRICS in a panel, CHIP_METRICS_LARGE in a window */
  metrics?: typeof CHIP_METRICS | typeof CHIP_METRICS_LARGE;
  /** what hovering says, where the chip does more than pick */
  hint?: string;
  onKeyDown?: React.KeyboardEventHandler<HTMLButtonElement>;
}) {
  return (
    <button
      className="chip channel"
      data-testid={testid}
      data-hint={hint}
      data-active={active}
      aria-pressed={active}
      tabIndex={tabIndex}
      style={{
        ...metrics,
        // Its own channel's color, not the accent: which channel is
        // live is the thing this row exists to say, and five buttons
        // that all light up blue say it once instead of five times.
        //
        // Only when it is live. The off state is a plain gray with
        // nothing to say, and written inline it was the one thing a
        // :hover rule could not lift, so a hovered chip here got a
        // brighter background under unchanged lettering and read as
        // washed out. It lives in .chip.channel now.
        color: active ? channel.color : undefined,
        borderColor: active ? channel.color : "var(--line-4)",
      }}
      onClick={onPick}
      onKeyDown={onKeyDown}
    >
      {channel.label}
    </button>
  );
}

/** The whole row.
 *
 * `hidden` keeps it mounted and invisible rather than unmounting it: the
 * histogram's picker belongs to the histogram alone, and removing it
 * moved the plot up and down as the scope changed.
 *
 * `face` is the Curves editor's RGB | CMY  for a row that wants it: the
 * CMY face is INK_CHIPS, the same five ids under ink names, and its
 * chips carry those names in their test ids, as Curves' do. With
 * `onFlip`, Option-click (Alt-click) on the composite chip, or
 * Option+Enter with it focused, turns the face over instead of picking.
 */
export function ChannelChips({
  value,
  onPick,
  testidPrefix,
  hidden = false,
  label = "Channel",
  metrics = CHIP_METRICS,
  face = "rgb",
  onFlip,
  flipHint,
}: {
  value: CurveChannel;
  onPick: (c: CurveChannel) => void;
  testidPrefix: string;
  hidden?: boolean;
  label?: string;
  metrics?: typeof CHIP_METRICS | typeof CHIP_METRICS_LARGE;
  face?: "rgb" | "cmy";
  /** turns the face over; without it an Option-click is a plain pick */
  onFlip?: () => void;
  /** what the composite chip says on hover when it can flip */
  flipHint?: string;
}) {
  const chips = face === "cmy" ? INK_CHIPS : CHANNEL_CHIPS;
  return (
    <div
      role="group"
      aria-label={face === "cmy" ? `${label}: CMY` : label}
      aria-hidden={hidden || undefined}
      style={{
        display: "flex",
        gap: 4,
        flex: "none",
        visibility: hidden ? "hidden" : "visible",
      }}
    >
      {chips.map((c) => (
        <ChannelChip
          key={c.id}
          channel={c}
          active={value === c.id}
          testid={`${testidPrefix}-${face === "cmy" && c.id !== "luma" ? c.label.toLowerCase() : c.id}`}
          metrics={metrics}
          tabIndex={hidden ? -1 : undefined}
          hint={c.id === "rgb" && onFlip ? flipHint : undefined}
          onKeyDown={
            c.id === "rgb" && onFlip
              ? (e) => {
                  if (e.altKey && (e.key === "Enter" || e.key === " ")) {
                    e.preventDefault();
                    e.stopPropagation();
                    if (!e.repeat) onFlip();
                  }
                }
              : undefined
          }
          onPick={(e) => {
            if (c.id === "rgb" && onFlip && e.altKey) {
              onFlip();
              return;
            }
            onPick(c.id);
          }}
        />
      ))}
    </div>
  );
}
