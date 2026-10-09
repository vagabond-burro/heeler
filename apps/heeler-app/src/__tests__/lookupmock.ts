// The engine's lookup for a curve eyedropper (bridge curveLookup), as the
// picker tests stand it in: the tests queue color samples, and a "tone"
// read answers the sample's tone in EV, an "around" read its hue and
// chroma. Relight and Recolor's Around rows read curveLookup since the
// 26.4.3 latest review (R2, R4); the queue lets one test drive both.
import { oklabHueChroma } from "../colorsets";

type Sample = { r?: number; g?: number; b?: number } | null | undefined;

export function lookupOf(s: Sample, kind: "tone" | "around"): { value: number; chroma: number } | null {
  if (!s || s.r === undefined) return null;
  const [r, g, b] = [s.r, s.g ?? 0, s.b ?? 0];
  if (kind === "tone") return { value: Math.log2(Math.max(0.2126 * r + 0.7152 * g + 0.0722 * b, 1e-6) / 0.18), chroma: 0 };
  const { hue, chroma } = oklabHueChroma(r, g, b);
  return { value: hue, chroma };
}
