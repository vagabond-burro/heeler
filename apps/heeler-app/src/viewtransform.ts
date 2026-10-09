// The View Transform's curves, mirrored for the curve face.
//
// The engine owns the rendering (crates/heeler-engine/src/ops_view.rs);
// this mirror exists so the graph inspector can DRAW the curve the node
// will apply, at widget cost, without a render round-trip. Same
// published curves, same constants, and the two implementations are
// pinned to the same hand-computed vectors (see viewtransform.test.ts
// and ops_view.rs's the_two_implementations_agree_on_the_vectors) so
// they cannot drift apart silently: the eqcurve bargain again.
//
// Everything here maps a SCENE-LINEAR neutral value to a DISPLAY-LINEAR
// value in 0..1. The face encodes for the screen when it plots.

/** Middle gray in scene-linear terms, the anchor every mode agrees on. */
export const VT_GRAY = 0.18;

const A = 0.15, B = 0.5, C = 0.1, D = 0.2, E = 0.02, F = 0.3;
/** Hable's filmic operator (Uncharted 2 constants), unnormalized. */
export function hable(x: number): number {
  return (x * (A * x + C * B) + D * E) / (x * (A * x + B) + D * F) - E / F;
}

/** Narkowicz's ACES fit: linear in, linear out. */
export function acesFit(x: number): number {
  return Math.min(1, Math.max(0, (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14)));
}

const AGX_INSET = [
  [0.842479062253094, 0.0784335999999992, 0.0792237451477643],
  [0.0423282422610123, 0.878468636469772, 0.0791661274605434],
  [0.0423756549057051, 0.0784336, 0.879142973793104],
];
const AGX_OUTSET = [
  [1.19687900512017, -0.0980208811401368, -0.0990297440797205],
  [-0.0528968517574562, 1.15190312990417, -0.0989611768448433],
  [-0.0529716355144438, -0.0980434501171241, 1.15107367264116],
];
const AGX_EV_MIN = -12.47393;
const AGX_EV_MAX = 4.026069;

function mat3(m: number[][], v: number[]): number[] {
  return [0, 1, 2].map((i) => m[i][0] * v[0] + m[i][1] * v[1] + m[i][2] * v[2]);
}

function agxSigmoid(v: number): number {
  const v2 = v * v;
  const v4 = v2 * v2;
  return (
    15.5 * v4 * v2 - 40.14 * v4 * v + 31.96 * v4 - 6.868 * v2 * v + 0.4298 * v2 + 0.1191 * v -
    0.00232
  );
}

/** AgX on a neutral value (the face plots the neutral axis; the rows
 * sum to one so gray in is gray out and one channel tells the story). */
export function agxNeutral(x: number): number {
  const v = mat3(AGX_INSET, [Math.max(x, 1e-10), Math.max(x, 1e-10), Math.max(x, 1e-10)]);
  const s = v.map((c) => {
    const ev = Math.min(Math.max(Math.log2(c), AGX_EV_MIN), AGX_EV_MAX);
    return Math.min(1, Math.max(0, agxSigmoid((ev - AGX_EV_MIN) / (AGX_EV_MAX - AGX_EV_MIN))));
  });
  const o = mat3(AGX_OUTSET, s);
  return Math.min(Math.pow(Math.max(o[0], 0), 2.2), 1);
}

/** sRGB decode, matching the engine's to_scene. */
export function vtToScene(d: number): number {
  return d <= 0.04045 ? d / 12.92 : Math.pow((d + 0.055) / 1.055, 2.4);
}

/** sRGB encode, matching the engine's to_display. */
export function vtToDisplay(v: number): number {
  const c = Math.max(v, 0);
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

export interface VtParams {
  mode: string;
  exposure_ev: number;
  contrast: number;
  white_ev: number;
}

/** The whole transform as the engine will run it: scene-linear neutral
 * in, display-linear out, exposure trim included. */
export function vtCurve(p: VtParams, x: number): number {
  const gain = Math.pow(2, Math.min(4, Math.max(-4, p.exposure_ev)));
  const v = Math.max(x * gain, 0);
  switch (p.mode) {
    case "filmic": {
      const white = VT_GRAY * Math.pow(2, Math.min(10, Math.max(1, p.white_ev)));
      const hw = Math.max(hable(white), 1e-6);
      return Math.min(1, Math.max(0, hable(v) / hw));
    }
    case "aces":
      return acesFit(v);
    case "agx":
      return agxNeutral(v);
    default: {
      const slope = 1.7 * (Math.min(300, Math.max(25, p.contrast)) / 100);
      const xc = Math.pow(v, slope);
      const d = xc / (xc + Math.pow(VT_GRAY, slope));
      return vtToScene(d);
    }
  }
}
