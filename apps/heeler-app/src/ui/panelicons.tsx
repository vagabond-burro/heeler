// The right panel's tabs, as pictures.
//
// "we need to change the text labels for Adjustments,
// history, and presets to icon (the name comes up in a tooltip when
// mousing over the tab) and add a metadata tab."
//
// Four words across a 285 pixel panel was already tight and a fifth would
// not have fitted at all, which is the practical reason. The better one is
// that a tab strip is a place you aim at rather than read: after the first
// day nobody reads "Adjustments", they go to the leftmost one.
//
// Drawn rather than fetched. An icon font is a network request, a license
// and a flash of nothing on first paint, for four glyphs that are each a
// handful of lines. These are 16 by 16 with a 1.4 stroke, matching the
// weight of the chrome around them.

import type { ReactNode } from "react";
import type { PanelTab } from "../state";
import type { SpectrumKind } from "../spectrums";
import { harmonyHues, type HarmonyMode } from "../harmony";

/** One glyph, sized and colored by whoever is drawing it. */
export function PanelIcon({ tab }: { tab: PanelTab }) {
  const common = {
    width: 16,
    height: 16,
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.4,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    // Decorative: the accessible name is on the button, and a second
    // reading of it here would have a screen reader say it twice.
    "aria-hidden": true,
    focusable: false,
  };
  switch (tab) {
    // Three sliders with their handles at different places, which is what
    // the panel behind it actually is.
    case "adjust":
      return (
        <svg {...common} data-testid="icon-adjust">
          <path d="M2 4h12M2 8h12M2 12h12" />
          <circle cx="5.5" cy="4" r="1.6" fill="currentColor" stroke="none" />
          <circle cx="10" cy="8" r="1.6" fill="currentColor" stroke="none" />
          <circle cx="4" cy="12" r="1.6" fill="currentColor" stroke="none" />
        </svg>
      );
    // A clock with its hands back, the arrow saying which way time goes.
    case "history":
      return (
        <svg {...common} data-testid="icon-history">
          <path d="M2.6 8a5.4 5.4 0 1 0 1.7-3.9" />
          <path d="M2.2 2.4v2.4h2.4" />
          <path d="M8 5.2V8l2.2 1.4" />
        </svg>
      );
    // A stack of looks with a star on the top one.
    case "presets":
      return (
        <svg {...common} data-testid="icon-presets">
          <path d="M2.4 10.4 8 13.4l5.6-3" />
          <path d="M2.4 7.4 8 10.4l5.6-3" />
          <path d="m8 2 1.3 2.3 2.5.4-1.8 1.8.4 2.5L8 7.8l-2.4 1.2.4-2.5L4.2 4.7l2.5-.4z" />
        </svg>
      );
    // Two sheets offset over each other: layers, drawn the way every
    // layers panel since 1990 has drawn them.
    case "layers":
      return (
        <svg {...common} data-testid="icon-layers">
          <rect x="5" y="2.5" width="8.5" height="8.5" />
          <path d="M10.5 13.5H2.5V5.5" />
        </svg>
      );
    // A label with its hole, which is what metadata is: a tag tied on.
    case "metadata":
      return (
        <svg {...common} data-testid="icon-metadata">
          <path d="M8.6 2H13a1 1 0 0 1 1 1v4.4a1 1 0 0 1-.3.7l-6 6a1 1 0 0 1-1.4 0L2.2 10a1 1 0 0 1 0-1.4l6-6a1 1 0 0 1 .4-.6z" />
          <circle cx="11" cy="5" r="1.1" />
        </svg>
      );
    // A camera body with its cable: the tether.
    case "tether":
      return (
        <svg {...common} data-testid="icon-tether">
          <rect x="2" y="5" width="12" height="7.5" rx="1" />
          <circle cx="8" cy="8.7" r="2.2" />
          <path d="M5.5 5V3.8h2V5" />
          <path d="M14 9h1.4" />
        </svg>
      );
  }
}

/** The house mask-view glyph: the eye. One drawing, used by every
 * "show this mask" button (the Layers panel, the Color Sets rows), so
 * the same idea always wears the same face. */
export function MaskEyeIcon({ size = 11 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      aria-hidden="true"
    >
      <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6z" />
      <circle cx="12" cy="12" r="2.6" />
    </svg>
  );
}

/** The eye struck through: a section taken out of the panel. */
export function EyeOffIcon({ size = 11 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <path d="M2 12s3.5-6 10-6c1.6 0 3 .3 4.3.9M22 12s-3.5 6-10 6c-1.6 0-3-.3-4.3-.9" />
      <path d="M4 20L20 4" />
    </svg>
  );
}

/** The pin the section header wears when pinned: filled when it is,
 * hollow when it is not, for a toggle that shows its state. */
export function PinIcon({ filled, size = 11 }: { filled: boolean; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 4h6l-1 6 3 3v2H7v-2l3-3z" />
      <path d="M12 15v6" />
    </svg>
  );
}

/** The red-overlay glyph: a frame with the tint sitting ON the
 * picture, deliberately NOT another eye ("Overlay and
 * Show Mask icons are too similar"), and it keeps a red cast even
 * at rest so the two flavors are told apart before either is
 * pressed.*/
export function MaskOverlayIcon({ size = 11 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      aria-hidden="true"
    >
      <rect x="2.5" y="4" width="19" height="16" rx="2" />
      <circle cx="12" cy="12" r="4.6" fill="currentColor" stroke="none" opacity="0.85" />
    </svg>
  );
}

/** The tabs, however many of them this pane is showing.
 *
 * Split out from the panel so the second pane of a split can render the
 * same strip with a different set of tabs in it.
 *
 * The name rides the shared cursor tip (data-tip): the old bespoke
 * tooltip guessed its position from a hardcoded tab width and missed
 * the tab under the pointer (the owner's report), and the cursor tip
 * clamps itself against the window's edges besides. The app's
 * standing contract that nothing carries a `title` stands: a native
 * tooltip is unstyled, late, and outside the window's own look.
 */
export function PanelTabs({
  tabs,
  active,
  onPick,
  onMenu,
  testid = "panel-tabs",
}: {
  tabs: { id: PanelTab; label: string; hint: string }[];
  active: PanelTab;
  onPick: (tab: PanelTab) => void;
  /** right-click, for the split menu */
  onMenu?: (tab: PanelTab, at: { x: number; y: number }) => void;
  testid?: string;
}) {
  return (
    <div
      className="panel-head"
      data-testid={testid}
      style={{ display: "flex", gap: 2, padding: 0, position: "relative" }}
    >
      {tabs.map((t) => (
        <button
          key={t.id}
          className="paneltab"
          data-testid={`panel-tab-${t.id}`}
          data-active={active === t.id}
          // The name, three ways, because they are three different jobs:
          // the cursor tip carries the NAME at the pointer, the app's
          // hint row carries what the tab holds, and the accessible
          // name is what a screen reader and a test both read. No
          // `title`: see the note on this component.
          data-hint={t.hint}
          data-tip={t.label}
          aria-label={t.label}
          onClick={() => onPick(t.id)}
          onContextMenu={
            onMenu
              ? (e) => {
                  e.preventDefault();
                  onMenu(t.id, { x: e.clientX, y: e.clientY });
                }
              : undefined
          }
        >
          <PanelIcon tab={t.id} />
        </button>
      ))}
    </div>
  );
}

/** The depth suite's glyphs: 16x16, 1.4 stroke, like the Finish
 * toolbar's. Shared by Fog, Depth Lighting, and Depth of Field so the
 * same act wears the same picture in every section. */
export function DepthViewIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {/* The scene in depth: a near ridge over a far one, sun behind. */}
      <circle cx="12" cy="4.4" r="1.6" />
      <path d="M1.5 12.5l3.4-4.6 2.4 3 1.8-2.2 3.4 3.8" />
      <path d="M4.5 8.6l2-2.6 1.9 2.2" opacity="0.55" />
    </svg>
  );
}

export function LightRigIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
      {/* A positioned light: the sun on its line to the target. */}
      <circle cx="10.5" cy="5.5" r="2.2" />
      <path d="M10.5 1.6v1.2M14.4 5.5h-1.2M13.3 2.7l-.9.9M13.3 8.3l-.9-.9" />
      <path d="M8.9 7.1L4.6 11.4" />
      <rect x="2.6" y="10.9" width="2.6" height="2.6" transform="rotate(45 3.9 12.2)" />
    </svg>
  );
}

/** A sun: one direction over the whole scene, drawn as the disc with
 * its rays leaving as parallel lines toward the scene. */
export function DirectionalLightIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
      <circle cx="4.5" cy="4.5" r="2.2" />
      <path d="M8.2 6.4l4.6 4.6M6.4 8.2l4.6 4.6M9.3 4.3l3.6 3.6" />
    </svg>
  );
}

/** A lamp in the scene: a point with its light leaving every way and
 * fading, drawn as the disc with short rays all round. */
export function PointLightIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
      <circle cx="8" cy="8" r="2.4" />
      <path d="M8 3v1.6M8 11.4V13M3 8h1.6M11.4 8H13M4.5 4.5l1.1 1.1M10.4 10.4l1.1 1.1M11.5 4.5l-1.1 1.1M5.6 10.4l-1.1 1.1" />
    </svg>
  );
}

/** A plain plus: add one more of what the row lists (Add shape, when
 * its row has no room for the label). */
export function AddIcon({ size = 10 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <path d="M8 3v10M3 8h10" />
    </svg>
  );
}

export function LightAddIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
      <circle cx="6.5" cy="8" r="2.4" />
      <path d="M6.5 3.8v1.3M6.5 10.9v1.3M2.3 8h1.3M9.4 8h1.3M3.5 5l.9.9M8.6 10.1l.9.9M9.5 5l-.9.9M4.4 10.1l-.9.9" />
      <path d="M13 3.4v4M11 5.4h4" strokeWidth="1.6" />
    </svg>
  );
}

export function DepthInvertIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {/* Near and far trading places. */}
      <path d="M5 3.2v9.3M5 12.5l-2.3-2.6M5 12.5l2.3-2.6" />
      <path d="M11 12.8V3.5M11 3.5L8.7 6.1M11 3.5l2.3 2.6" />
    </svg>
  );
}

/** The spectrum picker's six kinds, as pictures.
 *
 * "The type buttons (Hist, RGB, Wave, etc) should have the
 * labels replaced with icons. The text is small and can be hard to
 * read." Four characters at nine pixels was the compromise that fitted
 * a 285 pixel panel, and it was thinner than it looked: `Vec`, `CIE`
 * and `Harm` are abbreviations of words most people have not met.
 *
 * A scope has a SHAPE, which is the whole point of it, so each icon is
 * the plot itself in miniature: bars, three columns, a trace, a wheel
 * with a vector, the horseshoe, spokes. The pop-out window keeps the
 * full word beside the icon, which is where the icons get learned.
 *
 * 13 by 13 in a 16 box, matching the panel icons above.
 */
export function SpectrumIcon({ kind, size = 13 }: { kind: SpectrumKind; size?: number }) {
  const line = {
    width: size,
    height: size,
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.4,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
    focusable: false,
  };
  switch (kind) {
    // Counts per level: bars with a hump in them, which is what a
    // histogram of a real photograph looks like.
    case "histogram":
      return (
        <svg {...line} data-testid="icon-spectrum-histogram">
          <g fill="currentColor" stroke="none">
            <rect x="1.9" y="10.4" width="2" height="3.4" />
            <rect x="4.5" y="7.3" width="2" height="6.5" />
            <rect x="7.1" y="4.4" width="2" height="9.4" />
            <rect x="9.7" y="6.6" width="2" height="7.2" />
            <rect x="12.3" y="9.6" width="2" height="4.2" />
          </g>
        </svg>
      );
    // Three channels standing side by side, which is the parade's whole
    // idea and the one thing it has that the waveform does not.
    case "parade":
      return (
        <svg {...line} data-testid="icon-spectrum-parade">
          <g fill="currentColor" stroke="none">
            <rect x="2.1" y="4.2" width="2.8" height="9.6" />
            <rect x="6.6" y="6.4" width="2.8" height="7.4" />
            <rect x="11.1" y="3.2" width="2.8" height="10.6" />
          </g>
        </svg>
      );
    // Brightness across the frame: a trace, drawn the way a scope draws
    // one, with the frame's floor under it.
    case "waveform":
      return (
        <svg {...line} data-testid="icon-spectrum-waveform">
          <path d="M2 9.6c1.6-4 3.1 1.2 4.6-2.4 1.5-3.5 3 3.4 4.5 1.1 1-1.5 1.6-1.9 2.9-2.4" />
          <path d="M2 13.2h12" strokeOpacity="0.45" />
        </svg>
      );
    // Hue around, saturation out: the wheel with one vector on it.
    case "vector":
      return (
        <svg {...line} data-testid="icon-spectrum-vector">
          <circle cx="8" cy="8" r="5.6" />
          <path d="M8 8l3.4-2.6" />
          <circle cx="11.6" cy="5.2" r="1.2" fill="currentColor" stroke="none" />
        </svg>
      );
    // The CIE horseshoe, which is the one shape in color science
    // nobody mistakes for another.
    case "chroma":
      return (
        <svg {...line} data-testid="icon-spectrum-chroma">
          <path d="M3.4 13.2C2.2 8.4 4.6 2.6 8.6 2.6c3.4 0 5.2 3.4 4.4 6.2-.9 3-5.6 4.9-9.6 4.4z" />
        </svg>
      );
    // A family of hues, as the spokes the grading wheels pull toward.
    case "harmony":
      return (
        <svg {...line} data-testid="icon-spectrum-harmony">
          <circle cx="8" cy="8" r="5.6" />
          <path d="M8 8V2.4M8 8l4.8 2.8M8 8L3.2 10.8" />
        </svg>
      );
  }
}

/** The harmony families, as the shape each one makes on the wheel.
 *
 * "The type buttons (Off/Comp/Split/Triad/Anlg) should have
 * the labels replaced with icons." Comp, Anlg and Triad are the
 * abbreviated names of an idea that is far easier to see than to read:
 * two hues opposite each other, three evenly spread, three side by
 * side.
 *
 * Spokes rather than dots on the ring, which is both what the wheel
 * itself draws and the only version that survives thirteen pixels: dots
 * at that size sit half on the ring and read as a lumpy circle, while
 * three lines from the center keep their angles.
 *
 * The angles are not drawn by hand, they come from harmonyHues with the
 * anchor at three o'clock, the same function that places the spokes on
 * the wheel. The icon cannot say a different thing from the mode it
 * selects.
 */
export function HarmonyIcon({ mode, size = 13 }: { mode: HarmonyMode; size?: number }) {
  const line = {
    width: size,
    height: size,
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.4,
    strokeLinecap: "round" as const,
    "aria-hidden": true,
    focusable: false,
  };
  const R = 5.4;
  // Anchor at three o'clock, degrees running clockwise: the axis the
  // wheel and the anchor readout both use.
  const spoke = (deg: number) => {
    const rad = (deg * Math.PI) / 180;
    return `M8 8L${(8 + R * Math.cos(rad)).toFixed(2)} ${(8 + R * Math.sin(rad)).toFixed(2)}`;
  };
  return (
    <svg {...line} data-testid={`icon-harmony-${mode}`}>
      <circle cx="8" cy="8" r={R} strokeOpacity="0.6" />
      {/* Off is the ring with nothing claimed on it, struck through so
          it cannot read as "a family I have not picked yet". The stroke
          overshoots the ring, which is what tells it apart from the
          complementary pair's diameter at this size. */}
      {mode === "off" ? (
        <path d="M3.4 12.6 12.6 3.4" />
      ) : (
        <path d={harmonyHues({ mode, anchor: 0, strength: 0 }).map(spoke).join(" ")} />
      )}
    </svg>
  );
}

/** The eyedropper, for every control that says "point at the photo".
 *
 * The Curves editor drew one and the Relight toolbar wrote "◎ PICK"
 * instead, which is two pictures for one gesture. On the Relight
 * one: "The pick button only needs the icon, not the PICK label."
 */
export function EyedropperIcon({ size = 10 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M11 7l6 6M4 20l1-4L16 5l3 3L8 19z" />
      <path d="M18 3l3 3" />
    </svg>
  );
}

/** Copy: two sheets, the second behind the first (the console's copy
 * glyph, drawn at the panel's icon size). */
export function CopyIcon({ size = 11.25 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true" focusable="false">
      <path d="M9 9h11v12H9z" />
      <path d="M5 15V3h11" />
    </svg>
  );
}

/** Paste: the clipboard with a sheet on it. */
export function PasteIcon({ size = 11.25 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true" focusable="false">
      <path d="M8 4H5v17h14V4h-3" />
      <path d="M8 2h8v4H8z" />
    </svg>
  );
}

/** Revert: the arrow that goes back round. "All the RESET
 * buttons in Adjustments should be icon button only."
 *
 * The section headers already drew this beside the word; the curve
 * editor and the mask row wrote "Reset" with no picture at all. One
 * glyph for the one action, and the word moves to the button's
 * accessible name and its hint, where it can say WHICH reset it is
 * ("Reset the R curve", "Reset this mask") rather than repeating the
 * same five letters down the panel.
 */
export function ResetIcon({ size = 11.25 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M3 12a9 9 0 1 0 3-6.7" />
      <path d="M3 4v5h5" />
    </svg>
  );
}

/** Which chain a Develop section writes to while a layer is selected:
 * two stacked sheets for the layer, a globe for the whole photograph.
 * It was the word LAYER or GLOBAL in a chip on every header, 45
 * pixels of an eight pixel font; a glyph the width of Reset's leaves
 * the header room for the Export box beside the switch (2026-10-03:
 * "the LAYER/GLOBAL label taking up lots of space"). The words are in
 * its hint and its accessible name.*/
export function ScopeIcon({ layer, size = 11.25 }: { layer: boolean; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {layer ? (
        <>
          <path d="M12 3 22 9 12 15 2 9z" />
          <path d="M2 15l10 6 10-6" />
        </>
      ) : (
        <>
          <circle cx="12" cy="12" r="9" />
          <path d="M3 12h18" />
          <path d="M12 3c3.4 3.4 3.4 14.6 0 18c-3.4-3.4-3.4-14.6 0-18z" />
        </>
      )}
    </svg>
  );
}

/** Close: the cross the catalog's and the user guide's close chips
 * wear, for a card or a panel that goes away. */
export function CloseIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true" focusable="false">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

/** Send: an arrow pointing up and out of the field, for asking what
 * was typed. */
export function SendIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M12 19V5M6 11l6-6 6 6" />
    </svg>
  );
}

/* The smart mask's six buttons as pictures (2026-09-29: "the 6 buttons
 * in smart adjustment layers don't scale down well when the app window
 * scale is 150% and the adjustment view is horizontally scaled down.
 * replace all 6 button labels with icons"). Three of the drawings
 * already meant the same thing somewhere else in the app and are shared
 * from here, so one idea keeps one face: refine the Selection Polish
 * "Refine edge" chip: the same ViTMatte pass at the edge, a head's dome
 * with flyaway strands; remove the Fill brush: the same model filling a
 * hole from the surroundings, a patch with the strokes closing it;
 * toMask the Layers toolbar's "mask from selection": a dashed marquee
 * becoming a solid mask. Three are new. Click arms the smart overlay's
 * crosshair cursor, so its picture is that crosshair (the picker cursor
 * and its icon agree); Subject and Sky arm no cursor (they compute at
 * once) and are drawn as what they select: a head and shoulders, a
 * cloud. 16 by 16 at the 1.4 stroke, like the rest of the chrome.*/

/** Selection Polish's Refine edge and the smart mask's Refine. */
export const REFINE_EDGE_GLYPH: ReactNode = (
  <>
    <path d="M3 14a5 5 0 0 1 10 0" />
    <path d="M6 6.4 4.8 3.4M8 5.8V2.6M10 6.4l1.2-3" />
  </>
);

/** The Fill brush and the smart mask's Remove: the model fill. */
export const MODEL_FILL_GLYPH: ReactNode = (
  <>
    <rect x="2" y="2" width="12" height="12" rx="2" />
    <path d="M5.5 10.5c1.5-1 2-3.5 4-4M6.5 12c2-1 3-4 5-5" />
  </>
);

/** The Layers toolbar's mask from selection and the smart mask's To Mask. */
export const MASK_FROM_SELECTION_GLYPH: ReactNode = (
  <>
    <rect x="2" y="3" width="7" height="7" strokeDasharray="2 1.6" />
    <rect x="7" y="6" width="7" height="7" />
    <path d="M9.5 9.5h2" />
  </>
);

export type SmartIconId = "click" | "subject" | "sky" | "refine" | "remove" | "toMask" | "clear";

const SMART_GLYPHS: Record<SmartIconId, ReactNode> = {
  // The crosshair the smart overlay wears while Click is the mode: a
  // plus opened in the middle, where the click lands.
  click: <path d="M8 1.5v4.3M8 10.2v4.3M1.5 8h4.3M10.2 8h4.3" />,
  subject: (
    <>
      <circle cx="8" cy="5.2" r="2.6" />
      <path d="M2.8 14c0-2.9 2.3-5 5.2-5s5.2 2.1 5.2 5" />
    </>
  ),
  sky: <path d="M4.6 12.5h6.9a2.6 2.6 0 0 0 .4-5.2 3.6 3.6 0 0 0-7-.9A2.9 2.9 0 0 0 4.6 12.5z" />,
  refine: REFINE_EDGE_GLYPH,
  remove: MODEL_FILL_GLYPH,
  toMask: MASK_FROM_SELECTION_GLYPH,
  // The Console's Clear picture, a crossed circle, drawn on this grid.
  clear: (
    <>
      <circle cx="8" cy="8" r="5.6" />
      <path d="M4 4l8 8" />
    </>
  ),
};

/** One of the smart mask's six pictures, sized and colored by the
 * button it sits in. Size pinned in CSS as well as attributes, the
 * guard selecticons.tsx keeps against WebKit stretching an svg in a
 * flex parent under CSS zoom. */
export function SmartIcon({ id, size = 14 }: { id: SmartIconId; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      data-testid={`smart-icon-${id}`}
      style={{ width: size, height: size, flex: "none" }}
    >
      {SMART_GLYPHS[id]}
    </svg>
  );
}

/* The transform pictures (2026-09-30: "Replace button labels with
 * icons"). Transform, Skew, Perspective and Warp are the Finish
 * toolbar's Transform slot (since 2026-10-01 the image layer's own
 * Transform, Skew and Distort buttons are gone: Distort was Warp), the
 * flips sit above the canvas, and the rest stay on the image layer;
 * Reset is ResetIcon. 16 by 16 at the 1.4 stroke: flipH, flipV a
 * picture and its mirror image across a dashed axis skew the square
 * slid into a parallelogram perspective the square pinched into a
 * trapezoid lock, unlock the proportions chain, whole and broken
 * choose a folder with a picture going in relink a folder and the
 * magnifier that finds the file meshWarp a grid whose lines bow: an
 * image layer's own warp unwarp the same grid struck through: take
 * that warp away*/

/** The Transform half of the shape tool pair: a box and its corners. */
export const TRANSFORM_GLYPH: ReactNode = (
  <>
    <rect x="3.5" y="3.5" width="9" height="9" />
    <path d="M2 2h1.4M12.6 2H14M2 14h1.4M12.6 14H14" strokeLinecap="round" />
  </>
);

/** The Warp half, and the image layer's Distort: one corner pulled. */
export const WARP_GLYPH: ReactNode = (
  <>
    <path d="M4.5 3.5h8l1 9h-10z" />
    <circle cx="4.5" cy="3.5" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="12.5" cy="3.5" r="1.1" fill="currentColor" stroke="none" />
  </>
);

/** The Transform slot's Skew: the square slid into a parallelogram. */
export const SKEW_GLYPH: ReactNode = (
  <>
    <path d="M5.5 3.5h8l-3 9h-8z" />
    <path d="M1.5 1.8h4M11.5 14.2h3" />
  </>
);

/** The Transform slot's Perspective: the square pinched into a
 * trapezoid, its top corners drawn in together. */
export const PERSPECTIVE_GLYPH: ReactNode = (
  <>
    <path d="M5.5 3.5h5l3 9h-11z" />
    <circle cx="5.5" cy="3.5" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="10.5" cy="3.5" r="1.1" fill="currentColor" stroke="none" />
  </>
);

/** A Finish warp (2026-09-30: "build both, A for image layers and B for
 * the photo"): a grid whose lines bow, the Grid and Shape Warp idea in
 * one picture. The Warp layer's button and an image layer's own warp
 * both wear it.*/
export const MESH_WARP_GLYPH: ReactNode = (
  <>
    <path d="M2.5 3c3.5 1.6 7.5 1.6 11 0M2.5 8c3.5 2.2 7.5 2.2 11 0M2.5 13c3.5 1 7.5 1 11 0" />
    <path d="M3 2.5c-.9 3.7-.9 7.3 0 11M8 2.5c1.2 3.7 1.2 7.3 0 11M13 2.5c-.9 3.7-.9 7.3 0 11" />
  </>
);

/** A Warp layer's Bake Warp: the bowed grid pressed down onto a flat
 * line, the warp becoming a fixed picture. */
export const BAKE_WARP_GLYPH: ReactNode = (
  <>
    <path d="M2.5 3c3.5 1.6 7.5 1.6 11 0M2.5 7c3.5 2.2 7.5 2.2 11 0" />
    <path d="M3 2.5c-.6 2-.6 4 0 5.5M8 2.5c.8 2 .8 4 0 5.5M13 2.5c-.6 2-.6 4 0 5.5" />
    <path d="M8 9.5v3.5M6.2 11.6L8 13.3l1.8-1.7M2.5 14.5h11" />
  </>
);

/** A baked layer's Unbake: Bake Warp's picture read the other way, the
 * flat line lifting back into the bowed grid, the picture becoming a
 * live warp again. */
export const UNBAKE_WARP_GLYPH: ReactNode = (
  <>
    <path d="M2.5 3c3.5 1.6 7.5 1.6 11 0M2.5 7c3.5 2.2 7.5 2.2 11 0" />
    <path d="M3 2.5c-.6 2-.6 4 0 5.5M8 2.5c.8 2 .8 4 0 5.5M13 2.5c-.6 2-.6 4 0 5.5" />
    <path d="M8 13.3V9.8M6.2 11.5L8 9.8l1.8 1.7M2.5 14.5h11" />
  </>
);

/** The Finish toolbar's Expand settings on select: a layer row with its
 * settings opening under it. */
export const EXPAND_ON_SELECT_GLYPH: ReactNode = (
  <>
    <rect x="2.5" y="2.5" width="11" height="4" />
    <path d="M4.5 9.5h7M4.5 12.5h7" />
  </>
);

export type XformIconId = "flipH" | "flipV" | "transform" | "skew" | "perspective" | "distort" | "lock" | "unlock" | "choose" | "relink" | "meshWarp" | "unwarp";

const XFORM_GLYPHS: Record<XformIconId, ReactNode> = {
  flipH: (
    <>
      <path d="M8 1.5v13" strokeDasharray="1.6 1.6" />
      <path d="M6 4L2 12h4z" fill="currentColor" />
      <path d="M10 4l4 8h-4z" />
    </>
  ),
  flipV: (
    <>
      <path d="M1.5 8h13" strokeDasharray="1.6 1.6" />
      <path d="M4 6l8-4v4z" fill="currentColor" />
      <path d="M4 10l8 4v-4z" />
    </>
  ),
  transform: TRANSFORM_GLYPH,
  skew: SKEW_GLYPH,
  perspective: PERSPECTIVE_GLYPH,
  distort: WARP_GLYPH,
  lock: (
    <>
      <path d="M6.8 9.2l2.4-2.4" />
      <path d="M7.4 4.6l1.1-1.1a2.5 2.5 0 0 1 3.5 3.5l-1.1 1.1" />
      <path d="M8.6 11.4l-1.1 1.1A2.5 2.5 0 0 1 4 9l1.1-1.1" />
    </>
  ),
  unlock: (
    <>
      <path d="M7.4 4.6l1.1-1.1a2.5 2.5 0 0 1 3.5 3.5l-1.1 1.1" />
      <path d="M8.6 11.4l-1.1 1.1A2.5 2.5 0 0 1 4 9l1.1-1.1" />
      <path d="M11.5 11.5l1.8 1.8M2.7 2.7l1.8 1.8" />
    </>
  ),
  choose: (
    <>
      <path d="M1.5 13v-9.5h4l1.4 2h7.6v7.5z" />
      <path d="M8 7.2v4M6.2 9.6L8 11.3l1.8-1.7" />
    </>
  ),
  relink: (
    <>
      <path d="M8 13H1.5V3.5h4l1.4 2h7.6v2" />
      <circle cx="11.2" cy="10.4" r="2.2" />
      <path d="M12.8 12l1.7 1.7" />
    </>
  ),
  meshWarp: MESH_WARP_GLYPH,
  // The same grid struck through: take the picture's warp away.
  unwarp: (
    <>
      {MESH_WARP_GLYPH}
      <path d="M1.5 14.5l13-13" strokeWidth="1.8" />
    </>
  ),
};

/** One of the image layer's transform pictures, sized and colored by
 * the button it sits in (size pinned in CSS as well, SmartIcon's guard
 * against WebKit stretching an svg in a flex parent under CSS zoom). */
export function XformIcon({ id, size = 14 }: { id: XformIconId; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      data-testid={`xform-icon-${id}`}
      style={{ width: size, height: size, flex: "none" }}
    >
      {XFORM_GLYPHS[id]}
    </svg>
  );
}
