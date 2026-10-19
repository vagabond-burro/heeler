// The Source section's four choices as dropdowns, one component for
// every seat: Develop's Source section, the graph inspector's Source
// node, and the two RAW defaults in Preferences > Import & Files.
//
// 2026-09-29, on the four rows of segmented buttons: "There are four
// options with buttons of different width and count. It just looks
// sloppy, make these a dropdown option menu. This also means you should
// update Preferences > File & Import to also be a dropdown option menu
// as well." And then: "make sure the dropdowns are all the same width
// (defaulting to the length of the longest word in all 4)". The width
// comes from the labels themselves (MenuField's fitLabels), so renaming
// an option keeps every field fitting and every field the same.

import { MenuField } from "./menufield";
import type React from "react";
import { type Choice, SOURCE_FIT } from "./sourcemenusparts";

/** One labeled row: the kicker in its column and the menu. The column is
 * 78px, the selection panel's label column: at 68 "SHARPENING" in the
 * kicker's letter spacing ran into its menu. */
export function SourceMenuRow({
  label,
  name,
  value,
  choices,
  testid,
  onChange,
  fit = SOURCE_FIT,
  after,
  labelSize,
}: {
  label: string;
  /** the accessible name, which can say more than the kicker */
  name: string;
  value: string;
  choices: Choice[];
  testid: string;
  onChange: (id: string) => void;
  /** the labels the field fits; the Source menus' own by default, and
   * a Finish warp's Type fits its two */
  fit?: string[];
  /** what the row holds after the menu: a Finish warp's Add shape */
  after?: React.ReactNode;
  /** the kicker's size where its panel's other labels are larger than
   * the theme's kicker (a Finish warp's, at the warp sections' 11px) */
  labelSize?: number;
}) {
  const experimental = choices.find((o) => o.id === value)?.experimental;
  const chipId = `${testid}-experimental`;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <div className="kicker" style={{ width: 78, flex: "none", fontSize: labelSize }}>
        {label}
      </div>
      {after ? (
        // A row with something after its menu (a Finish warp's Add shape)
        // keeps its layout: that row measures its children to fit.
        <MenuField testid={testid} label={name} value={value} options={choices} onChange={onChange} size="regular" fitLabels={fit} />
      ) : (
        // The menu and its chip wrap together: the chip sits to the
        // menu's right where the panel has room, and under it at the
        // narrowest panel (260 px) rather than past the edge (the 26.5.1
        // review measured 31 px of overflow).
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, minWidth: 0 }}>
          <MenuField
            testid={testid}
            label={name}
            value={value}
            options={choices}
            onChange={onChange}
            size="regular"
            fitLabels={fit}
            describedBy={experimental ? chipId : undefined}
          />
          <ExperimentalChip why={experimental} testid={chipId} id={chipId} />
        </div>
      )}
      {after}
    </div>
  );
}

/** The Experimental chip beside a menu whose chosen option is not yet
 * right (2026-10-10: "keep Rebuild as experimental ... have the
 * Experimental chip appear to the right of the option menu"). A label in
 * the warning color, not a button; its hint says what is wrong. */
export function ExperimentalChip({ why, testid, id }: { why?: string; testid?: string; id?: string }) {
  if (!why) return null;
  return (
    <span
      id={id}
      data-testid={testid}
      data-hint={why}
      aria-label={why}
      style={{
        flex: "none",
        padding: "1px 6px",
        border: "1px solid var(--warn)",
        borderRadius: "var(--radius-btn)",
        color: "var(--warn)",
        fontSize: 11,
        letterSpacing: "0.06em",
        textTransform: "uppercase",
        whiteSpace: "nowrap",
      }}
    >
      Experimental
    </span>
  );
}
