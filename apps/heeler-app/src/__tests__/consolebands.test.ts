// The Color Tune's band model: the JSON contract the engine reads.
import { describe, expect, it } from "vitest";
import {
  FIXED_BANDS,
  faceAngleToOkHue,
  okHueToFaceAngle,
  bandForHue,
  bandLabel,
  bandOf,
  bandRgb,
  consolePickOutcome,
  customCount,
  formatColor,
  hueToRgb255,
  linearToSrgb255,
  nextCustomId,
  nextNameFormat,
  parseConsoleBands,
  rgbToHex,
  serializeConsoleBands,
  withBand,
} from "../consolebands";

describe("console bands", () => {
  it("round-trips and drops bands that say nothing", () => {
    const bands = [
      { id: "r", sat: 40 },
      { id: "g" }, // untouched fixed band: gone on save
      { id: "c1", center: 41.5 }, // untouched CUSTOM: kept, it was made
    ];
    const json = serializeConsoleBands(bands);
    const back = parseConsoleBands(json);
    expect(back.map((b) => b.id)).toEqual(["r", "c1"]);
    expect(serializeConsoleBands([{ id: "r" }])).toBe("");
    expect(parseConsoleBands("junk")).toEqual([]);
  });

  it("custom ids never collide and the count only counts customs", () => {
    const bands = [{ id: "r", sat: 10 }, { id: "c1", center: 30 }, { id: "c3", center: 200 }];
    expect(nextCustomId(bands)).toBe("c2");
    expect(customCount(bands)).toBe(2);
    // A graded fixed CYAN band ("c") is not a custom band: it must not
    // consume one of the user's custom-band slots.
    expect(customCount([{ id: "c", sat: 10 }, { id: "c1", center: 30 }])).toBe(1);
  });

  it("finds the nearest band for a picked hue, wrap included", () => {
    expect(bandForHue([], 30)).toBe("r");
    expect(bandForHue([], 355)).toBe("m");
    // A custom band close to the pick wins over a fixed one further off.
    expect(bandForHue([{ id: "c1", center: 50 }], 55)).toBe("c1");
  });

  it("the face bridge is an inverse pair and lands the landmarks", () => {
    // Round trip: any OkLab hue survives face-angle and back.
    for (const h of [0, 25, 60, 110, 180, 264, 320, 355]) {
      const back = faceAngleToOkHue(okHueToFaceAngle(h));
      const d = Math.min(Math.abs(back - h), 360 - Math.abs(back - h));
      expect(d, `hue ${h} came back as ${back}`).toBeLessThan(0.01);
    }
    // The face's red sits at three o'clock, teal at nine: the same
    // places Color Wheels shows them. The bridge is calibrated to the
    // face's actual gradient (measured, 26.3.2): the red there has
    // OkLab hue 21.88, the teal 195.32.
    expect(faceAngleToOkHue(0)).toBeCloseTo(21.88, 5);
    expect(okHueToFaceAngle(21.88)).toBeCloseTo(0, 5);
    expect(faceAngleToOkHue(180)).toBeCloseTo(195.32, 5);
    expect(okHueToFaceAngle(195.32)).toBeCloseTo(180, 5);
  });

  it("withBand edits in place and appends the new", () => {
    let bands = withBand([], { id: "r", sat: 20 });
    bands = withBand(bands, { id: "r", sat: 35 });
    expect(bands).toHaveLength(1);
    expect(bandOf(bands, "r").sat).toBe(35);
    expect(bandOf(bands, "b")).toEqual({ id: "b" });
    // The fixed set is the vectorscope's landmarks, six of them.
    expect(FIXED_BANDS.map((f) => f.id)).toEqual(["r", "y", "g", "c", "b", "m"]);
  });

  it("keeps the picked color through a save", () => {
    const json = serializeConsoleBands([{ id: "c1", center: 41.5, rgb: [212, 96, 64] }]);
    expect(parseConsoleBands(json)[0].rgb).toEqual([212, 96, 64]);
  });

  it("a band saved before the color was kept round-trips with its name", () => {
    // Graphs from before rgb rode along carry center and name only;
    // they must survive a parse/serialize turn whole.
    const old = '[{"id":"c1","center":41.5,"name":"Bride\\u2019s skin","sat":12}]';
    const bands = parseConsoleBands(old);
    expect(bands[0].rgb).toBeUndefined();
    const again = parseConsoleBands(serializeConsoleBands(bands));
    expect(again[0]).toEqual({ id: "c1", center: 41.5, name: "Bride’s skin", sat: 12 });
    // And an UNNAMED band from that era falls back to the hue-only
    // stand-in, not a blank.
    expect(bandLabel({ id: "c2", center: 41.5 }, "hex")).toBe(rgbToHex(hueToRgb255(41.5)));
  });

  it("a corrupt band is dropped at the parser, so neither the engine nor the face sees it", () => {
    // A hand-edited file can put a string where a number goes. The
    // engine's deserializer would reject the whole list; the parser
    // drops the band whose center is not a number and the fields that
    // are not finite, and keeps the rest.
    expect(parseConsoleBands('[{"id":"c1","center":"abc"}]')).toEqual([]);
    // A center-less band whose id is none of the six fixed ones is a
    // custom band missing its center: the engine errors the whole list
    // on it ("band 'c1' has no center"), so the parser drops it too.
    expect(parseConsoleBands('[{"id":"c1","sat":20}]')).toEqual([]);
    const kept = parseConsoleBands(
      '[{"id":"r","sat":"loud","hue":12,"wheel":[0.2,"x"],"name":5},{"id":"c2","center":40,"rgb":[1,2],"lum":null}]',
    );
    expect(kept).toEqual([{ id: "r", hue: 12 }, { id: "c2", center: 40 }]);
    // And the encoder still refuses to print NaN if one ever reaches it.
    expect(linearToSrgb255(NaN, Infinity, -Infinity)).toEqual([0, 255, 0]);
    expect(rgbToHex(bandRgb({ id: "c1", center: NaN }))).toBe("#000000");
  });
});

describe("what an unnamed custom band is called", () => {
  it("goes by its picked color in the header's notation, or by its name", () => {
    const band = { id: "c1", center: 30, rgb: [212, 96, 64] as [number, number, number] };
    expect(bandLabel(band, "rgb")).toBe("212 96 64");
    expect(bandLabel(band, "cmy")).toBe("17% 62% 75%");
    expect(bandLabel(band, "hex")).toBe("#D46040");
    // A named band keeps its name whatever the header says.
    expect(bandLabel({ ...band, name: "Bride's skin" }, "hex")).toBe("Bride's skin");
    // Blank names do not count as names.
    expect(bandLabel({ ...band, name: "   " }, "hex")).toBe("#D46040");
  });

  it("cycles RGB, CMY, hex and back", () => {
    expect(nextNameFormat("rgb")).toBe("cmy");
    expect(nextNameFormat("cmy")).toBe("hex");
    expect(nextNameFormat("hex")).toBe("rgb");
  });

  it("stands in a hue-only color for bands picked before the color was kept", () => {
    // Linear red encodes to full red; a mid gray lands where sRGB puts it.
    expect(linearToSrgb255(1, 0, 0)).toEqual([255, 0, 0]);
    expect(linearToSrgb255(0.2, 0.2, 0.2)[0]).toBe(124);
    // An OkLab hue near red comes out reddish, near blue bluish, and
    // never out of range.
    const red = hueToRgb255(29);
    const blue = hueToRgb255(264);
    expect(red[0]).toBeGreaterThan(red[2]);
    expect(blue[2]).toBeGreaterThan(blue[0]);
    for (const c of [...red, ...blue]) {
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThanOrEqual(255);
    }
    expect(bandRgb({ id: "c1", center: 29 })).toEqual(red);
    expect(formatColor([0, 255, 128], "hex")).toBe("#00FF80");
  });
});

// One click, one answer (2026-09-05: the row's picker "doesn't seem
// to pick up the color", and sometimes "doesn't release"). The
// decision is pure so every path is named here.
describe("what a Color Tune pick does", () => {
  const rgb: [number, number, number] = [200, 90, 60];
  it("a new pick is born on the hue with the display color", () => {
    const out = consolePickOutcome({ bands: [], pickBand: null, hue: 41.56, chroma: 0.1, rgb, customMax: 4 });
    expect(out).toEqual({ kind: "born", id: "c1", bands: [{ id: "c1", center: 41.6, rgb }] });
  });
  it("a row's pick moves that band and keeps its name and grade", () => {
    const bands = [{ id: "c1", center: 30, rgb: [1, 2, 3] as [number, number, number], name: "Sky", sat: 12 }];
    const out = consolePickOutcome({ bands, pickBand: "c1", hue: 250, chroma: 0.1, rgb, customMax: 1 });
    expect(out).toEqual({ kind: "moved", id: "c1", bands: [{ id: "c1", center: 250, rgb, name: "Sky", sat: 12 }] });
  });
  it("names every miss: neutral, a band that is gone, a full list", () => {
    const neutral = consolePickOutcome({ bands: [], pickBand: null, hue: 30, chroma: 0.001, rgb, customMax: 4 });
    expect(neutral.kind).toBe("miss");
    expect(neutral.kind === "miss" && neutral.reason).toMatch(/neutral/);
    const gone = consolePickOutcome({ bands: [], pickBand: "c1", hue: 30, chroma: 0.1, rgb, customMax: 4 });
    expect(gone.kind === "miss" && gone.reason).toMatch(/gone/);
    const full = consolePickOutcome({ bands: [{ id: "c1", center: 30 }], pickBand: null, hue: 30, chroma: 0.1, rgb, customMax: 1 });
    expect(full.kind === "miss" && full.reason).toMatch(/Preferences/);
    // A full list still lets a row's pick move an existing band.
    const move = consolePickOutcome({ bands: [{ id: "c1", center: 30 }], pickBand: "c1", hue: 90, chroma: 0.1, rgb, customMax: 1 });
    expect(move.kind).toBe("moved");
  });
});

it("ignores repeated band IDs so one visible row means one grade", () => {
  expect(parseConsoleBands('[{"id":"r","sat":20},{"id":"r","lum":2}]')).toEqual([{ id: "r", sat: 20 }]);
});

it("refuses a nonfinite chroma sample instead of creating an unusable band", () => {
  for (const chroma of [NaN, Infinity, -Infinity]) {
    expect(consolePickOutcome({ bands: [], pickBand: null, hue: 30, chroma, rgb: [120,80,60], customMax: 4 }).kind).toBe("miss");
  }
});
