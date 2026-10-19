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
import { CHANNEL_CHIPS, CHIP_METRICS, CHIP_METRICS_LARGE, INK_CHIPS } from "./channelchipsparts";

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
