// Lab D50 to sRGB hex and back, for the custom chart editor's color
// block: a datasheet value typed as Lab shows as a color, and a color
// typed as hex stores as the Lab the chart file carries. The chain is
// the engine's own (ops_colorchecker.rs): Lab D50 to XYZ D50, Bradford
// to D65, XYZ to linear Rec.709, sRGB encode; the reverse inverts the
// two matrices. Kept in step with the engine, never rederived: the
// test's expected values come from a scratch run of the engine itself.

type Mat3 = [[number, number, number], [number, number, number], [number, number, number]];
type Vec3 = [number, number, number];

/** ICC D50 white, Y = 1. */
const D50: Vec3 = [0.9642, 1.0, 0.8251];
/** Bradford D50 to D65, the same constants the engine uses. */
const D50_TO_D65: Mat3 = [
  [0.9555766, -0.0230393, 0.0631636],
  [-0.0282895, 1.0099416, 0.0210077],
  [0.0122982, -0.020483, 1.3299098],
];
/** XYZ D65 to linear Rec.709 (the working space). */
const XYZ_D65_TO_RGB: Mat3 = [
  [3.2404542, -1.5371385, -0.4985314],
  [-0.969266, 1.8760108, 0.041556],
  [0.0556434, -0.2040259, 1.0572252],
];

function matMul(m: Mat3, v: Vec3): Vec3 {
  return [
    m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
    m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
    m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
  ];
}

function invert3(m: Mat3): Mat3 {
  const det =
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
    m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
    m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const out: Mat3 = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      const a = (i + 1) % 3;
      const b = (i + 2) % 3;
      const c = (j + 1) % 3;
      const d = (j + 2) % 3;
      out[j][i] = (m[a][c] * m[b][d] - m[a][d] * m[b][c]) / det;
    }
  }
  return out;
}

const RGB_TO_XYZ_D65 = invert3(XYZ_D65_TO_RGB);
const D65_TO_D50 = invert3(D50_TO_D65);

function labToXyzD50(lab: Vec3): Vec3 {
  const fy = (lab[0] + 16) / 116;
  const fx = fy + lab[1] / 500;
  const fz = fy - lab[2] / 200;
  const finv = (f: number) => {
    const d = 6 / 29;
    return f > d ? f * f * f : 3 * d * d * (f - 4 / 29);
  };
  return [D50[0] * finv(fx), D50[1] * finv(fy), D50[2] * finv(fz)];
}

function xyzToLabD50(xyz: Vec3): Vec3 {
  const d = 6 / 29;
  const f = (t: number) => {
    const tt = Math.max(0, t);
    return tt > d * d * d ? Math.cbrt(tt) : tt / (3 * d * d) + 4 / 29;
  };
  const fx = f(xyz[0] / D50[0]);
  const fy = f(xyz[1] / D50[1]);
  const fz = f(xyz[2] / D50[2]);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

function srgbEncode(c: number): number {
  const cc = Math.max(0, Math.min(1, c));
  return cc <= 0.0031308 ? 12.92 * cc : 1.055 * Math.pow(cc, 1 / 2.4) - 0.055;
}

function srgbDecode(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Lab D50 to sRGB-encoded 0..1, clipped to display range. */
export function labD50ToSrgb(lab: Vec3): Vec3 {
  const linear = matMul(XYZ_D65_TO_RGB, matMul(D50_TO_D65, labToXyzD50(lab)));
  return [srgbEncode(linear[0]), srgbEncode(linear[1]), srgbEncode(linear[2])];
}

/** sRGB-encoded 0..1 to Lab D50. */
export function srgbToLabD50(rgb: Vec3): Vec3 {
  const linear: Vec3 = [srgbDecode(rgb[0]), srgbDecode(rgb[1]), srgbDecode(rgb[2])];
  return xyzToLabD50(matMul(D65_TO_D50, matMul(RGB_TO_XYZ_D65, linear)));
}

/** Lab D50 to a hex string, "#rrggbb". */
export function labD50ToHex(lab: Vec3): string {
  const [r, g, b] = labD50ToSrgb(lab);
  const h = (v: number) => Math.round(v * 255).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

/** A hex string ("#rrggbb" or "rrggbb") to Lab D50, or null when the
 * text is not a color. */
export function hexToLabD50(hex: string): Vec3 | null {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return null;
  const v = parseInt(m[1], 16);
  return srgbToLabD50([((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255]);
}
