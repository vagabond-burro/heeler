/** The looks a Relight or Recolor section offers as one press
 * (2026-09-30, from a tester's note: "you might get some mileage out
 * of having a 'free preview' of some of your more standout features
 * (like relight) ... maybe having some presets. the user can't change
 * the settings but they could see the effect on their image"; the
 * owner chose "go with A for Relight, maybe a few as well for Recolor
 * as that one has lots of feature combinations including depth").
 *
 * Each look is a whole setting of its section, written in the
 * section's own params: the numbers the apply writes onto the node, and
 * the numbers the held preview renders. One list, so the preview is
 * exactly what the apply would make.
 *
 * The shape follows the other per-section presets (FLARE_PRESETS and
 * LENS_CHARACTERS in state.ts): values and text params by name. A look
 * REPLACES the section's settings rather than merging into them, so the
 * picture it shows is the look, not the look plus whatever the node
 * held before.
 *
 * Axes, for reading the numbers below (src/eqcurve.ts):
 * - Relight's `points`: x is the tone in stops around middle gray,
 *   -6 (deep shadow) to +3 (bright highlight); y is the exposure change
 *   in stops, -2 to +2.
 * - Recolor's `curves`: "<by>_<adjust>" cells. By hue is the OkLCh hue
 *   circle in degrees (red about 30, orange 60, yellow 110, green 140,
 *   cyan 195, blue 260, magenta 330); by sat is 0 to 100 percent of
 *   full chroma; by lum is Relight's stops; by depth is 0 near to 100
 *   far. Hue shifts are degrees (plus or minus 60), sat, temp, vib and
 *   pastel are percent (plus or minus 100, temp positive is warm), lum
 *   is stops (plus or minus 2).
 */

export type LookSection = "Relight" | "Recolor";

export interface SectionLook {
  id: string;
  section: LookSection;
  name: string;
  /** what the look does, outcome first, for the chip's hint */
  does: string;
  /** reads the photograph's depth map: disabled until there is one */
  depth: boolean;
  values: Record<string, number>;
  text: Record<string, string>;
}

const pts = (list: [number, number][]): string => JSON.stringify(list.map(([x, y]) => ({ x, y })));
const cells = (map: Record<string, [number, number][]>): string =>
  JSON.stringify(Object.fromEntries(Object.entries(map).map(([k, v]) => [k, v.map(([x, y]) => ({ x, y }))])));

/** Relight's settings at rest, which every look starts from. */
const RELIGHT_BASE = { values: { smoothing: 50, range_shift: 0 }, text: {} };
/** Recolor's settings at rest: every curve, surface and choice empty. */
const RECOLOR_BASE = {
  values: { neutral_guard: 10, smoothing: 50, around_radius: 15 },
  text: { curves: "", surfaces: "", hue_hue_mode: "", by_mask: "" },
};

const relight = (id: string, name: string, does: string, points: [number, number][], values: Record<string, number> = {}): SectionLook => ({
  id,
  section: "Relight",
  name,
  does,
  depth: false,
  values: { ...RELIGHT_BASE.values, ...values },
  text: { ...RELIGHT_BASE.text, points: pts(points) },
});

const recolor = (
  id: string,
  name: string,
  does: string,
  curves: Record<string, [number, number][]>,
  values: Record<string, number> = {},
): SectionLook => ({
  id,
  section: "Recolor",
  name,
  does,
  depth: Object.keys(curves).some((k) => k.startsWith("depth_")),
  values: { ...RECOLOR_BASE.values, ...values },
  text: { ...RECOLOR_BASE.text, curves: cells(curves) },
});

export const SECTION_LOOKS: readonly SectionLook[] = [
  relight(
    "relight-open-shadows",
    "Open Shadows",
    "Lifts the shadows by most of a stop and leaves the highlights alone, the fill light a reflector would give",
    [[-6, 0.9], [-4, 0.8], [-2, 0.45], [0, 0.1], [3, 0]],
  ),
  relight(
    "relight-tame-highlights",
    "Tame Highlights",
    "Brings bright skies and hot skin down by up to a stop while the shadows and midtones stay put",
    [[-6, 0], [-1, 0], [1, -0.35], [3, -0.9]],
  ),
  relight(
    "relight-even-light",
    "Even Light",
    "Lifts the shadows and lowers the highlights together, so a contrasty scene reads like an overcast one",
    [[-6, 0.8], [-3, 0.5], [-1, 0.1], [0.5, -0.15], [3, -0.8]],
  ),
  relight(
    "relight-low-key",
    "Low Key",
    "Sinks the shadows and midtones and keeps the brightest tones, for a darker, moodier photograph",
    [[-6, -0.8], [-3, -0.7], [-1, -0.45], [0.5, -0.1], [3, 0]],
  ),
  recolor(
    "recolor-cool-distance",
    "Cool Distance",
    "Cools and quiets the color the farther away it is, the way real air does, read from the depth map",
    {
      depth_temp: [[0, 0], [40, 0], [100, -35]],
      depth_sat: [[0, 0], [50, 0], [100, -25]],
    },
  ),
  recolor(
    "recolor-warm-subject",
    "Warm Subject",
    "Warms and enriches whatever is nearest the camera and leaves the background as it was, read from the depth map",
    {
      depth_temp: [[0, 30], [35, 15], [60, 0], [100, 0]],
      depth_vib: [[0, 20], [40, 0], [100, 0]],
    },
  ),
  recolor(
    "recolor-teal-orange",
    "Teal and Orange",
    "Turns greens and blues toward teal, keeps skin tones warm, and splits the tones cool in the shadows and warm in the highlights",
    {
      hue_hue: [[30, 0], [70, 0], [110, 15], [150, 40], [200, 5], [250, -20], [300, 0]],
      hue_sat: [[20, 0], [55, 12], [100, 0], [190, 10], [260, 0]],
      lum_temp: [[-6, -25], [-2, -10], [0, 0], [3, 20]],
    },
  ),
  recolor(
    "recolor-autumn",
    "Autumn",
    "Swaps the greens for golds and oranges, the same scene a few weeks later",
    {
      hue_hue: [[60, 0], [100, -25], [140, -55], [180, -20], [220, 0]],
      hue_sat: [[80, 0], [120, 15], [160, 10], [200, 0]],
    },
  ),
  recolor(
    "recolor-muted",
    "Muted Palette",
    "Quiets the loudest colors most and the gentle ones least, a soft, printed look",
    { sat_sat: [[0, -5], [30, -30], [100, -55]] },
  ),
  recolor(
    "recolor-deep-skies",
    "Deep Skies",
    "Deepens and darkens the blues, so a pale sky turns rich without touching the rest",
    {
      hue_sat: [[180, 0], [230, 30], [265, 35], [300, 0]],
      hue_lum: [[180, 0], [230, -0.35], [265, -0.45], [300, 0]],
    },
  ),
];

export function looksFor(section: string): SectionLook[] {
  return SECTION_LOOKS.filter((l) => l.section === section);
}

export function lookById(id: string | null | undefined): SectionLook | undefined {
  return id ? SECTION_LOOKS.find((l) => l.id === id) : undefined;
}
