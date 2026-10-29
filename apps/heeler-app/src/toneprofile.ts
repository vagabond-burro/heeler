// The Tone Profile's Custom mode, the panel's half: the curve as the
// node's `curve` param holds it (the engine reads the same JSON in
// tone_curve.rs), the curve a fresh Custom starts from, and the profile
// menu with the saved profiles listed beside the built-in modes.
//
// The curve runs from scene light in stops around middle gray to a
// display value. Inside its points it is the Curves editor's curve
// (curvesampler.ts: the monotone Hermite, straight segments, or Curves'
// tangent mode, its slopes and handle vectors); past either end the
// end's value holds, as the engine holds it.

import { useSyncExternalStore } from "react";
import { toneProfileList, type ToneProfileEntry } from "./bridge";
import { curveEqPoints, curvePath, curveValueAt, monotoneTangents } from "./curvesampler";
import { evalEq } from "./eqcurve";
import type { CurveHandle, NodeCard } from "./state";
import { PROFILE_CHOICES, type Choice } from "./ui/sourcemenusparts";
import { vtToDisplay } from "./viewtransform";

type Pt = [number, number];

export type ToneInterp = "smooth" | "linear" | "tangent";

/** `tangents` and `handles` are tangent mode's, parallel to the points:
 * each point's slope in display per stop, and its handle vectors in
 * stops and display units (null for an automatic point), as Curves keeps
 * them. The engine reads the same (tone_curve.rs). */
export type ToneCurveDoc = {
  name: string;
  interp: ToneInterp;
  points: Pt[];
  tangents?: number[];
  handles?: (CurveHandle | null)[];
};

/** Scene white, 1.0, in stops above middle gray. */
export const WHITE_STOPS = Math.log2(1 / 0.18);

/** The editor's axis at least: the issue's eight stops under middle
 * gray to six over, wider when a curve's points reach further. */
export const AXIS_MIN = -8;
export const AXIS_MAX = 6;

/** The most points a curve may have, the engine's limit too. */
export const MAX_POINTS = 1024;

/** The curve a `curve` param holds, or null for none or one that is
 * not a curve (the engine refuses the same). */
export function parseToneCurve(json: string | undefined): ToneCurveDoc | null {
  if (!json || !json.trim()) return null;
  try {
    const v = JSON.parse(json);
    const raw = v?.points;
    if (!Array.isArray(raw) || raw.length < 2 || raw.length > MAX_POINTS) return null;
    if (v?.interp !== undefined && v.interp !== "smooth" && v.interp !== "linear" && v.interp !== "tangent") return null;
    if (v?.name !== undefined && typeof v.name !== "string") return null;
    if (!raw.every((p: unknown) => Array.isArray(p) && p.length === 2 && p.every((x) => typeof x === "number" && Number.isFinite(x)))) return null;
    const pts: Pt[] = raw.map((p: Pt) => [p[0], Math.min(1, Math.max(0, p[1]))]);
    if (pts.some(([x]) => Math.abs(x) > 24)) return null;
    const interp: ToneInterp = v.interp === "linear" || v.interp === "tangent" ? v.interp : "smooth";
    // Tangent mode's lists, kept only when they match the points (the
    // engine drops the same), and sorted with them.
    const num = (x: unknown) => typeof x === "number" && Number.isFinite(x);
    const vec = (x: unknown): x is Pt => Array.isArray(x) && x.length === 2 && x.every(num);
    const tangents: number[] | undefined =
      interp === "tangent" && Array.isArray(v.tangents) && v.tangents.length === pts.length && v.tangents.every(num) ? v.tangents : undefined;
    const handles: (CurveHandle | null)[] | undefined =
      interp === "tangent" &&
      Array.isArray(v.handles) &&
      v.handles.length === pts.length &&
      v.handles.every((h: unknown) => h === null || (typeof h === "object" && (h as CurveHandle).l === undefined) || vec((h as CurveHandle).l)) &&
      v.handles.every((h: unknown) => h === null || (typeof h === "object" && (h as CurveHandle).r === undefined) || vec((h as CurveHandle).r))
        ? v.handles.map((h: CurveHandle | null) => (h ? { ...(h.l ? { l: h.l } : {}), ...(h.r ? { r: h.r } : {}), ...(h.broken ? { broken: true } : {}) } : null))
        : undefined;
    const order = pts.map((_, i) => i).sort((a, b) => pts[a][0] - pts[b][0]);
    const sorted = order.map((i) => pts[i]);
    if (sorted.some((p, i) => i > 0 && p[0] - sorted[i - 1][0] < 1e-4)) return null;
    return {
      name: v.name ?? "",
      interp,
      points: sorted,
      ...(tangents ? { tangents: order.map((i) => tangents[i]) } : {}),
      ...(handles ? { handles: order.map((i) => handles[i]) } : {}),
    };
  } catch {
    return null;
  }
}

export const toneCurveJson = (c: ToneCurveDoc): string =>
  JSON.stringify({
    name: c.name,
    interp: c.interp,
    points: c.points,
    ...(c.interp === "tangent" && c.tangents?.length === c.points.length ? { tangents: c.tangents } : {}),
    ...(c.interp === "tangent" && c.handles?.length === c.points.length ? { handles: c.handles } : {}),
  });

/** The slopes tangent mode reads: the curve's own where they match its
 * points, the monotone ones otherwise. */
export function toneTangents(c: ToneCurveDoc): number[] {
  return c.tangents && c.tangents.length === c.points.length ? c.tangents : monotoneTangents(c.points);
}

/** Curves' choice (curveShape), on the tone curve's axis: tangent mode
 * with a handle on any point reads the handle vectors, otherwise the
 * Hermite through the slopes, or the chord. The engine chooses the same. */
function shapeOf(c: ToneCurveDoc): { at: (x: number) => number; weighted: boolean; slopes?: number[] } {
  const tangent = c.interp === "tangent";
  const handles = tangent && c.handles?.length === c.points.length ? c.handles : null;
  if (handles && handles.some((h) => h && (h.l || h.r))) {
    const eq = curveEqPoints(c.points, handles);
    return { at: (x) => evalEq(eq, x), weighted: true };
  }
  const slopes = tangent ? toneTangents(c) : undefined;
  return { at: (x) => curveValueAt(c.points, c.interp !== "linear", x, slopes), weighted: false, slopes };
}

/** The curve's display value at `stops`, held at the ends. */
export function toneCurveAt(c: ToneCurveDoc, stops: number): number {
  const pts = c.points;
  if (stops <= pts[0][0]) return pts[0][1];
  if (stops >= pts[pts.length - 1][0]) return pts[pts.length - 1][1];
  return Math.min(1, Math.max(0, shapeOf(c).at(stops)));
}

/** The outline the editor draws between the first point and the last. */
export function toneCurvePath(c: ToneCurveDoc): Pt[] {
  const shape = shapeOf(c);
  if (!shape.weighted) return curvePath(c.points, c.interp !== "linear", shape.slopes);
  const lo = c.points[0][0];
  const hi = c.points[c.points.length - 1][0];
  return Array.from({ length: 257 }, (_, i): Pt => {
    const x = lo + ((hi - lo) * i) / 256;
    return [x, shape.at(x)];
  });
}

/** What the Standard mode draws at full amount, in the curve's terms:
 * the S over the display value of the scene, white held. A fresh Custom
 * starts here, so choosing it changes nothing until a point moves. */
export function standardAt(stops: number): number {
  const d = Math.min(1, vtToDisplay(0.18 * 2 ** stops));
  const s = d * d * (3 - 2 * d);
  return d + (s - d) * 0.34;
}

const round4 = (v: number) => Math.round(v * 1e4) / 1e4;

export function standardSeed(): ToneCurveDoc {
  const stops = [-8, -6, -4, -3, -2, -1, 0, 1, 2, WHITE_STOPS];
  return { name: "Custom", interp: "smooth", points: stops.map((x): Pt => [round4(x), round4(standardAt(x))]) };
}

/** The node's curve, or the seed when it has none yet. */
export const curveOf = (node: NodeCard): ToneCurveDoc => parseToneCurve(node.textParams?.curve) ?? standardSeed();

/** The node carries a curve the engine refuses: not a missing one, which
 * the seed stands in for, but one the panel must not draw as Standard
 * while the render reports it. */
export function curveBroken(node: NodeCard): boolean {
  const raw = node.textParams?.curve;
  return !!raw && !!raw.trim() && parseToneCurve(raw) === null;
}

// --- The profiles folder ---------------------------------------------------

/** The saved profiles, read once and again after a save or an import,
 * shared by every seat of the profile menu (Develop and the inspector). */
let profiles: ToneProfileEntry[] = [];
let loaded = false;
let profileRequest = 0;
/** Why the folder could not be read last time, or null. */
let listError: string | null = null;
const listeners = new Set<() => void>();

export async function reloadToneProfiles(): Promise<void> {
  const request = ++profileRequest;
  let next: ToneProfileEntry[] | null;
  let error: string | null = null;
  try {
    next = await toneProfileList();
  } catch (e) {
    next = null;
    error = String(e);
  }
  // A slow read from before a save must not cover the newer folder.
  if (request !== profileRequest) return;
  // A failed read keeps the profiles last read and says why.
  if (next) profiles = next;
  listError = error;
  loaded = true;
  listeners.forEach((l) => l());
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  if (!loaded) {
    loaded = true;
    void reloadToneProfiles();
  }
  return () => listeners.delete(l);
}

export const useToneProfiles = (): ToneProfileEntry[] => useSyncExternalStore(subscribe, () => profiles);
export const useToneProfilesError = (): string | null => useSyncExternalStore(subscribe, () => listError);

export const PROFILE_PREFIX = "profile:";

/** The menu: the built-in modes, Custom (the document's own curve), then
 * each readable saved profile. */
export function profileChoices(saved: ToneProfileEntry[]): Choice[] {
  return [
    ...PROFILE_CHOICES,
    { id: "custom", label: "Custom", hint: "Your own curve, from scene light in stops to display, drawn or imported" },
    ...saved
      .filter((p) => p.curve)
      .map((p) => ({ id: PROFILE_PREFIX + p.path, label: p.name, hint: `A saved tone profile, ${p.file}.heelerprofile` })),
  ];
}

/** The same curve before and after the profile writer's four-decimal
 * rounding, rather than the same JSON spelling. */
function sameToneCurve(a: string, b: string): boolean {
  const ca = parseToneCurve(a);
  const cb = parseToneCurve(b);
  return !!(
    ca &&
    cb &&
    ca.name === cb.name &&
    ca.interp === cb.interp &&
    ca.points.length === cb.points.length &&
    ca.points.every((p, i) => Math.abs(p[0] - cb.points[i][0]) <= 1e-4 && Math.abs(p[1] - cb.points[i][1]) <= 1e-4)
  );
}

/** What the menu shows: the mode, or for Custom the saved profile whose
 * curve the node carries unchanged, else Custom. */
export function profileMenuValue(node: NodeCard, saved: ToneProfileEntry[]): string {
  const mode = node.textParams?.mode ?? "standard";
  if (mode !== "custom") return mode;
  const curve = node.textParams?.curve ?? "";
  const match = saved.find((p) => p.curve && sameToneCurve(p.curve, curve));
  return match ? PROFILE_PREFIX + match.path : "custom";
}

/** The command a menu pick makes: a built-in mode is the mode alone;
 * Custom keeps the node's curve, a broken one too, or starts from the seed; a saved
 * profile copies its curve into the node. */
export function profilePick(
  node: NodeCard,
  id: string,
  saved: ToneProfileEntry[],
): { type: "set_text_param"; id: string; param: string; value: string } | { type: "set_tone_curve"; id: string; curve: string } | null {
  // A broken curve stays as it is, for the panel to show and offer to
  // replace, rather than turning quietly into the seed.
  if (id === "custom" && curveBroken(node)) return { type: "set_text_param", id: node.id, param: "mode", value: "custom" };
  if (id === "custom") return { type: "set_tone_curve", id: node.id, curve: toneCurveJson(curveOf(node)) };
  if (id.startsWith(PROFILE_PREFIX)) {
    const p = saved.find((e) => PROFILE_PREFIX + e.path === id);
    return p?.curve ? { type: "set_tone_curve", id: node.id, curve: p.curve } : null;
  }
  return { type: "set_text_param", id: node.id, param: "mode", value: id };
}
