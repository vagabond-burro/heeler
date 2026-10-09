/** The Wratten filters the conversion can look through, mirrored
 * from the engine's spectral.rs FILTERS: the key the node carries,
 * the name the panel shows, and what each is modeled on. Smooth
 * models of the published shapes, labeled as such.*/
import { filmStock } from "./film";

export const WRATTEN_FILTERS: { key: string; name: string; modelledOn: string }[] = [
  { key: "w8", name: "8 yellow", modelledOn: "Wratten 8 (K2), a sharp cut at about 495 nm" },
  { key: "w11", name: "11 yellow-green", modelledOn: "Wratten 11 (X1), green through with a little red and less blue" },
  { key: "w15", name: "15 deep yellow", modelledOn: "Wratten 15 (G), a sharp cut at about 520 nm" },
  { key: "w21", name: "21 orange", modelledOn: "Wratten 21, a sharp cut at about 550 nm" },
  { key: "w25", name: "25 red", modelledOn: "Wratten 25 (A), a sharp cut at about 600 nm" },
  { key: "w29", name: "29 deep red", modelledOn: "Wratten 29 (F), a sharp cut at about 620 nm" },
  { key: "w47", name: "47 blue", modelledOn: "Wratten 47 (B), a band around 450 nm" },
  { key: "w58", name: "58 green", modelledOn: "Wratten 58 (B2), a band around 530 nm" },
  { key: "r72", name: "720 infrared", modelledOn: "an R72, a sharp cut at 720 nm: the visible band gone, the near infrared through. What it shows is a guess from color, an artistic tool, not a simulation" },
  { key: "r85", name: "850 infrared", modelledOn: "an 850 nm long-pass: deep infrared only, for a film that reaches it. A guess from color, an artistic tool, not a simulation" },
];

/** Whether a filter or a film makes the conversion infrared: the pair's
 * throughput lies past the visible band, and the material guess is in
 * play.
 *
 * The engine's rule (spectral.rs, Conversion::with_prior): an infrared
 * stock, or an infrared filter with NO stock behind it. A visible stock
 * behind an r72 is the documented black frame: the visible band alone
 * integrates, the guess never runs, and a fold of dials for it would
 * move nothing. */
export function isInfrared(filterKey: string | undefined, filmKey: string | undefined): boolean {
  if (filmKey === "rolleiir" || filmKey === "hie") return true;
  // A key no stock answers to is no stock: the engine's lookup misses
  // it the same way.
  const stocked = filmStock(filmKey) !== null;
  return !stocked && (filterKey === "r72" || filterKey === "r85");
}

export function wrattenFilter(key: string | undefined): (typeof WRATTEN_FILTERS)[number] | null {
  return WRATTEN_FILTERS.find((f) => f.key === key) ?? null;
}
