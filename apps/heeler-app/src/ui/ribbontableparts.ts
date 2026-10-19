// ribbontable.tsx's values and helpers that are not components, kept apart so
// ribbontable.tsx exports components alone and Vite can refresh it in place as
// it is edited instead of reloading the window.
import React from "react";
import { type ImageMeta } from "../bridge";
import { humanShotAt, humanSize } from "./metadataparts";

/** The way into the full catalog view, first in the header 's
 * layout sketch.*/
/** The one box every icon-only chip in the ribbon's header wears, so
 * the Photo view button over the Filter button line up edge for
 * edge ("Make the Filter and Photo view button the same
 * size").*/
export const RIBBON_ICON_CHIP: React.CSSProperties = {
  boxSizing: "border-box",
  width: 30,
  height: 20,
  padding: 0,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 3,
  fontSize: 9,
  flex: "none",
};

/** The picture browser's toolbar: every button in the Filter button's
 * box, so they read as one row (2026-09-15: "All the Buttons in this
 * picture browser should have the same size as what the filter
 * button is"). An icon-only button is exactly that box; one that
 * also carries a count or a label keeps the height and grows
 * sideways.*/
export const BROWSER_CHIP: React.CSSProperties = { ...RIBBON_ICON_CHIP };

export const BROWSER_CHIP_WIDE: React.CSSProperties = {
  ...RIBBON_ICON_CHIP,
  width: "auto",
  minWidth: 30,
  padding: "0 6px",
  boxSizing: "border-box",
};

/** The icon fills nine tenths of the button's height
 * ("make sure the icon scales up to fill 90% of the button space").*/
export const BROWSER_ICON = Math.round(0.9 * 20);

/** One cell's text, for a column and a photograph. */
export function cellText(
  column: string,
  m: ImageMeta,
  takes: number,
): string {
  switch (column) {
    case "name":
      return m.name;
    case "stars":
      return m.stars ? "★".repeat(m.stars) : "";
    case "flag":
      return m.flag === "pick" ? "Pick" : m.flag === "reject" ? "Reject" : "";
    case "edited":
      return m.edited ? "Yes" : "";
    case "takes":
      return String(takes);
    case "shot_at":
      return humanShotAt(m.shot_at);
    case "camera":
      return m.camera ?? "";
    case "lens":
      return m.lens ?? "";
    case "shutter":
      return m.shutter ?? "";
    case "aperture":
      return m.aperture ?? "";
    case "iso":
      return m.iso ? String(m.iso) : "";
    case "focal":
      return m.focal ?? "";
    case "exposure_bias":
      return m.exposure_bias ?? "";
    case "pixels":
      return m.width && m.height ? `${m.width} × ${m.height}` : "";
    case "size":
      return humanSize(m.size);
    default:
      return "";
  }
}

/** What a column sorts by.
 *
 * Numbers sort as numbers, which is the whole reason this is separate
 * from the text: ISO 1600 comes after ISO 400, and "1600" does not.
 * Blanks always sort last whichever way the arrow points, because a photo
 * with no lens recorded is not the smallest lens.
 */
export function sortKey(column: string, m: ImageMeta, takes: number): number | string {
  switch (column) {
    case "stars":
      return m.stars;
    case "iso":
      return m.iso ?? -1;
    case "takes":
      return takes;
    case "size":
      return m.size;
    case "edited":
      return m.edited ? 1 : 0;
    case "pixels":
      return (m.width ?? 0) * (m.height ?? 0);
    // Shutter and aperture are strings shaped like readings ("1/250",
    // "f/2.8"), so they need parsing back to sort in the order a
    // photographer expects rather than alphabetically.
    case "shutter": {
      const t = m.shutter ?? "";
      const frac = /^1\/(\d+)/.exec(t);
      if (frac) return 1 / Number(frac[1]);
      const secs = parseFloat(t);
      return Number.isFinite(secs) ? secs : -1;
    }
    case "aperture": {
      const f = parseFloat((m.aperture ?? "").replace("f/", ""));
      return Number.isFinite(f) ? f : -1;
    }
    case "focal": {
      const mm = parseFloat(m.focal ?? "");
      return Number.isFinite(mm) ? mm : -1;
    }
    case "exposure_bias": {
      const ev = parseFloat(m.exposure_bias ?? "");
      return Number.isFinite(ev) ? ev : -999;
    }
    default:
      return cellText(column, m, takes).toLowerCase();
  }
}

/** Orders the rows, blanks last. */
export function sortRows(
  rows: { meta: ImageMeta; takes: number }[],
  column: string,
  desc: boolean,
): { meta: ImageMeta; takes: number }[] {
  const out = [...rows];
  out.sort((a, b) => {
    const ka = sortKey(column, a.meta, a.takes);
    const kb = sortKey(column, b.meta, b.takes);
    // A photograph with nothing recorded in this column goes to the
    // bottom either way: it is absent, not small.
    const emptyA = ka === "" || ka === -1 || ka === -999;
    const emptyB = kb === "" || kb === -1 || kb === -999;
    if (emptyA !== emptyB) return emptyA ? 1 : -1;
    if (ka < kb) return desc ? 1 : -1;
    if (ka > kb) return desc ? -1 : 1;
    return a.meta.name.localeCompare(b.meta.name);
  });
  return out;
}
