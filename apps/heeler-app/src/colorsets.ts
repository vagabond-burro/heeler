// Color Sets: user-created, named hue-range grades in the Develop
// panel.
//
// The whole trick is that a set is not new state: it is two ordinary
// graph nodes with a naming convention, exactly the recipe pattern.
// `csetN_mask` (heeler.hue_range_mask) reads the set's input and feeds
// the mask port of `csetN_grade` (heeler.color_grade), which sits in
// the image chain below Color Bend. The Develop section is a lens over
// those nodes, Graph mode shows them plainly, and persistence, undo,
// copy/paste and takes all come along for free because nodes and wires
// already do all of those things.

import { makeNode, NODE_CATALOG } from "./nodes";
import { CHAIN_ORDER } from "./recipes";
import type { NodeCard, Wire } from "./state";

const SET_RE = /^cset(\d+)_(mask|grade)$/;

export const isColorSetNode = (id: string): boolean => SET_RE.test(id);

export interface ColorSet {
  /** the set's number: ids are cset{n}_mask / cset{n}_grade */
  n: number;
  mask: NodeCard;
  grade: NodeCard;
}

/** Every complete set, in chain order.
 *
 * Chain order equals numeric order because sets are only ever spliced
 * at the tail of the run; a half-deleted pair (graph surgery can do
 * that) is not a set and does not appear.
 */
export function listColorSets(nodes: NodeCard[]): ColorSet[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out: ColorSet[] = [];
  for (const node of nodes) {
    const m = SET_RE.exec(node.id);
    if (!m || m[2] !== "grade") continue;
    const n = Number(m[1]);
    const mask = byId.get(`cset${n}_mask`);
    if (mask) out.push({ n, mask, grade: node });
  }
  return out.sort((a, b) => a.n - b.n);
}

const wrapHue = (v: number): number => ((v % 360) + 360) % 360;

/** Shortest signed distance from one hue to another, -180..180. The
 * TS twin of the engine's color::hue_delta; the eyedropper tests pin
 * the two against shared reference values. */
export function hueDelta(from: number, to: number): number {
  let d = (to - from) % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

/** OkLab hue and chroma of a scene-linear RGB sample: the published
 * Ottosson constants, mirrored from the engine's color.rs so the
 * eyedropper lands the strip on the hue the mask will actually
 * select. Tests hold this copy against the engine's reference values
 * (linear red at ~29 degrees). */
export function oklabHueChroma(r: number, g: number, b: number): { hue: number; chroma: number; lightness: number } {
  const cbrt = Math.cbrt;
  const l = cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const lightness = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  return { hue: wrapHue((Math.atan2(bb, a) * 180) / Math.PI), chroma: Math.hypot(a, bb), lightness };
}

/** The eyedropper's band arithmetic (interaction spec settled with the owner,
 * the hue-range rule):
 * - "center": the band moves to the pick, width untouched;
 * - "add": the band grows JUST enough to include the pick, the far
 * edge stays planted so existing coverage is kept;
 * - "remove": the band shrinks so the pick falls outside the core,
 * again moving only the near edge.
 * A pick already inside (add) or outside (remove) changes nothing.*/
export function bandAfterPick(
  center: number,
  range: number,
  picked: number,
  mode: "center" | "add" | "remove",
): { center: number; range: number } {
  // Tenths, not whole degrees: rounding the center a half degree can
  // push the planted edge out from under coverage it promised to keep.
  const r1 = (v: number) => Math.round(v * 10) / 10;
  if (mode === "center") return { center: wrapHue(r1(picked)), range };
  const half = range / 2;
  const d = hueDelta(center, picked);
  const side = Math.sign(d) || 1;
  const margin = 5;
  const farEdge = center - side * half;
  if (mode === "add") {
    if (Math.abs(d) <= half) return { center, range };
    const span = Math.min(180, Math.abs(hueDelta(farEdge, picked)) + margin);
    return { center: wrapHue(r1(farEdge + (side * span) / 2)), range: r1(span) };
  }
  if (Math.abs(d) > half) return { center, range };
  const span = Math.max(2, Math.abs(hueDelta(farEdge, picked)) - margin);
  return { center: wrapHue(r1(farEdge + (side * span) / 2)), range: r1(span) };
}

/** The complete set a node belongs to, when it is half of one. The
 * graph Inspector uses this so selecting EITHER half offers the whole
 * set's controls, same as the Develop panel. */
export function colorSetOf(nodes: NodeCard[], id: string): ColorSet | null {
  const m = SET_RE.exec(id);
  if (!m) return null;
  const n = Number(m[1]);
  const mask = nodes.find((k) => k.id === `cset${n}_mask`);
  const grade = nodes.find((k) => k.id === `cset${n}_grade`);
  return mask && grade ? { n, mask, grade } : null;
}

/** Where the run of sets hands the chain back: the first main-chain
 * node after Color Bend that exists and is fed. Mirrors the noise
 * block's anchor logic. */
function setAnchor(nodes: NodeCard[], wires: Wire[]): string | undefined {
  return CHAIN_ORDER.slice(CHAIN_ORDER.indexOf("bend") + 1).find(
    (id) =>
      nodes.some((n) => n.id === id) && wires.some((w) => w.to === id && w.kind === "image"),
  );
}

/** Builds a new set and splices it in below Color Bend, after any
 * existing sets. Returns null when the chain has no anchor to splice
 * against (no output wired: nothing sensible to do). */
export function addColorSet(
  nodes: NodeCard[],
  wires: Wire[],
): { nodes: NodeCard[]; wires: Wire[]; setN: number } | null {
  const anchor = setAnchor(nodes, wires);
  if (!anchor) return null;
  const intoAnchor = wires.find((w) => w.to === anchor && w.kind === "image");
  if (!intoAnchor) return null;
  const feed = intoAnchor.from;

  const n =
    Math.max(0, ...nodes.map((k) => Number(SET_RE.exec(k.id)?.[1] ?? 0))) + 1;
  const maskId = `cset${n}_mask`;
  const gradeId = `cset${n}_grade`;

  const maskSpec = NODE_CATALOG.find((s) => s.type === "heeler.hue_range_mask")!;
  const gradeSpec = NODE_CATALOG.find((s) => s.type === "heeler.color_grade")!;
  const feedNode = nodes.find((k) => k.id === feed);
  const x = (feedNode?.x ?? 300) + 200;
  const y = (feedNode?.y ?? 60) + 170;

  const grade = { ...makeNode(gradeSpec, gradeId, x, y), name: `Set ${n}` };
  const mask = { ...makeNode(maskSpec, maskId, x - 180, y + 120), name: `Set ${n} Range` };
  // Written out rather than left to type defaults, so the Develop strip
  // reads real values and the grade's uniformity target starts in step
  // with the mask's center.
  mask.params = { band_center: 30, hue_range: 60, hue_falloff: 30 };
  grade.params = { band_center: 30 };

  return {
    setN: n,
    nodes: [...nodes, grade, mask],
    wires: [
      ...wires.filter((w) => w !== intoAnchor),
      { from: feed, to: gradeId, toPort: "in", kind: "image" },
      // The mask samples the set's INPUT, not its output: a set must
      // not re-select what it just changed.
      { from: feed, to: maskId, toPort: "in", kind: "image" },
      { from: maskId, to: gradeId, toPort: "mask", kind: "mask" },
      { from: gradeId, to: intoAnchor.to, toPort: intoAnchor.toPort, kind: intoAnchor.kind },
    ],
  };
}

/** Deletes a set outright and heals the chain around it. Unlike the
 * category switches, delete here really means delete: sets are
 * user-created, and the panel's toggle is the reversible half. */
export function removeColorSet(
  nodes: NodeCard[],
  wires: Wire[],
  setN: number,
): { nodes: NodeCard[]; wires: Wire[] } {
  const maskId = `cset${setN}_mask`;
  const gradeId = `cset${setN}_grade`;
  const feed = wires.find((w) => w.to === gradeId && w.toPort === "in")?.from;
  const onward = wires.filter((w) => w.from === gradeId && w.kind === "image");
  const rest = wires.filter(
    (w) => ![w.from, w.to].some((end) => end === maskId || end === gradeId),
  );
  return {
    nodes: nodes.filter((k) => k.id !== maskId && k.id !== gradeId),
    wires: feed
      ? [...rest, ...onward.map((w) => ({ ...w, from: feed }))]
      : rest,
  };
}
