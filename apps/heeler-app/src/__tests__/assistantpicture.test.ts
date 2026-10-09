// The picture report (src/assistantpicture.ts): its numbers on frames
// made here, the sun's elevation against published values, and what
// the text never says. Nothing here reaches a server.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  connectConsoleAssistant,
  PICTURE_TIMEOUT_MS,
  requestPictureReport,
  resetAssistantConfigForTests,
  resetAssistantPhotoForTests,
  setPictureProvider,
  systemPrompt,
} from "../assistant";
import type { Transport } from "../popout";
import {
  BAND_HIGH,
  BAND_LOW,
  captureFacts,
  GRID,
  hueName,
  measurePicture,
  parseDegrees,
  PICTURE_ANSWER,
  pictureReportText,
  solarElevation,
  sunPhase,
  type PictureFrame,
} from "../assistantpicture";

function frame(w: number, h: number, at: (x: number, y: number) => [number, number, number, number?]): PictureFrame {
  const pixels = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b, a = 255] = at(x, y);
      const i = (y * w + x) * 4;
      pixels[i] = r;
      pixels[i + 1] = g;
      pixels[i + 2] = b;
      pixels[i + 3] = a;
    }
  }
  return { pixels, w, h };
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

describe("the picture's numbers", () => {
  it("reads a gray ramp: every band filled in order, shares summing to 100%, no color, brightness rising left to right", () => {
    const ramp = frame(256, 64, (x) => [x, x, x]);
    const s = measurePicture(ramp)!;
    expect(s.bands).toHaveLength(BAND_HIGH - BAND_LOW + 1);
    expect(sum(s.bands)).toBeCloseTo(1, 10);
    // sRGB 118 is middle gray: about half the ramp sits under 0 EV.
    expect(s.medianEv).toBeGreaterThan(-0.5);
    expect(s.medianEv).toBeLessThan(0.5);
    expect(s.p2Ev).toBeLessThan(-5);
    expect(s.p98Ev).toBeGreaterThan(2.2);
    expect(s.shadows.strength).toBe(0);
    expect(hueName(s.midtones.hue, s.midtones.strength)).toBe("neutral");
    // One column of 0 and one of 255: 1/256 of the frame at each end,
    // levels 0 and 1 counting as the floor, 254 and 255 as the ceiling.
    expect(s.clipBlack[0]).toBeCloseTo(2 / 256, 5);
    expect(s.clipWhite[2]).toBeCloseTo(2 / 256, 5);
    for (let r = 0; r < GRID; r++) {
      const row = s.grid.slice(r * GRID, r * GRID + GRID).map((c) => c.ev);
      for (let i = 1; i < row.length; i++) expect(row[i]).toBeGreaterThan(row[i - 1]);
    }
    // The gray ramp's neutrals lean nowhere.
    expect(Math.abs(s.balance.a)).toBeLessThan(0.002);
    expect(Math.abs(s.balance.b)).toBeLessThan(0.002);
  });

  it("finds the clipping of a half black, half white frame, and lays the grid out top row first", () => {
    const f = frame(200, 100, (_x, y) => (y < 50 ? [0, 0, 0] : [255, 255, 255]));
    const s = measurePicture(f)!;
    for (let c = 0; c < 3; c++) {
      expect(s.clipBlack[c]).toBeCloseTo(0.5, 5);
      expect(s.clipWhite[c]).toBeCloseTo(0.5, 5);
    }
    expect(s.bands[0]).toBeCloseTo(0.5, 5);
    expect(s.bands[s.bands.length - 1]).toBeCloseTo(0.5, 5);
    expect(sum(s.bands)).toBeCloseTo(1, 10);
    const text = pictureReportText(s);
    expect(text).toContain("Clipped to pure black (level 0 or 1 of 255): R 50.0%, G 50.0%, B 50.0%");
    expect(text).toContain("to pure white (254 or 255): R 50.0%, G 50.0%, B 50.0%");
    expect(text).toContain("under -5: 50%");
    expect(text).toContain("+2 and up: 50%");
    expect(text).toContain("top: black neutral | black neutral | black neutral | black neutral");
    expect(text).toContain("bottom: +2.5 neutral | +2.5 neutral | +2.5 neutral | +2.5 neutral");
    expect(text.split("\n").filter((l) => /^(top|row \d|bottom): /.test(l))).toHaveLength(GRID);
  });

  it("names a blue top half over a warm bottom half, cell by cell and tone by tone", () => {
    const f = frame(160, 120, (_x, y) => (y < 60 ? [60, 110, 210] : [210, 130, 50]));
    const s = measurePicture(f)!;
    const names = s.grid.map((c) => hueName(c.color.hue, c.color.strength));
    expect(names.slice(0, GRID * 2).every((n) => n === "cool blue")).toBe(true);
    expect(names.slice(GRID * 2).every((n) => n === "warm orange")).toBe(true);
    const text = pictureReportText(s);
    expect(text).toContain("top: ");
    expect(text.split("\n").find((l) => l.startsWith("top: "))).toMatch(/^top: (-?[\d.]+ cool blue( \| )?){4}$/);
    expect(text.split("\n").find((l) => l.startsWith("bottom: "))).toMatch(/warm orange/);
    // No near-neutral pixels: the white balance is not guessed.
    expect(text).toContain("White balance: too few near-neutral pixels to judge.");
  });

  it("reads a warm cast off the near-neutral pixels", () => {
    const s = measurePicture(frame(64, 64, () => [148, 132, 116]))!;
    expect(s.balance.share).toBe(1);
    expect(s.balance.b).toBeGreaterThan(0.015);
    expect(pictureReportText(s)).toMatch(/White balance, from the near-neutral pixels \(100% of the frame\): (moderately|strongly) warm/);
  });

  it("leaves transparent pixels out, as the Spectrums do", () => {
    const s = measurePicture(frame(10, 10, (x) => (x < 5 ? [0, 0, 0, 0] : [255, 255, 255])))!;
    expect(s.samples).toBe(50);
    expect(s.clipBlack[0]).toBe(0);
    expect(measurePicture(frame(4, 4, () => [0, 0, 0, 0]))).toBeNull();
  });
});

describe("the sun", () => {
  it("matches published positions", () => {
    // SunCalc's own test (github.com/mourner/suncalc): 2013-03-05 00:00
    // UTC at 50.5 N, 30.5 E, altitude -0.7000406838781611 rad.
    expect(solarElevation(Date.UTC(2013, 2, 5), 50.5, 30.5)).toBeCloseTo((-0.7000406838781611 * 180) / Math.PI, 0);
    // The June solstice at solar noon on 40 N: 90 - 40 + 23.44.
    expect(solarElevation(Date.UTC(2024, 5, 20, 12, 2), 40, 0)).toBeGreaterThan(73.2);
    expect(solarElevation(Date.UTC(2024, 5, 20, 12, 2), 40, 0)).toBeLessThan(73.7);
    // The March equinox at noon on the equator: overhead, within a degree.
    expect(solarElevation(Date.UTC(2024, 2, 20, 12, 7), 0, 0)).toBeGreaterThan(89);
    // Midnight on the same day: under the horizon.
    expect(solarElevation(Date.UTC(2024, 2, 20, 0, 7), 0, 0)).toBeLessThan(-80);
  });

  it("names the light", () => {
    expect(sunPhase(30)).toBe("day");
    expect(sunPhase(3)).toBe("golden hour");
    expect(sunPhase(-3)).toBe("golden hour");
    expect(sunPhase(-10)).toBe("twilight");
    expect(sunPhase(-30)).toBe("night");
  });

  it("reads the time and the position from the metadata, and never says the position", () => {
    const lines = [
      { group: "EXIF", name: "Date/Time Original", value: "2024:06:20 12:02:00" },
      { group: "EXIF", name: "Offset Time Original", value: "+02:00" },
      { group: "GPS", name: "GPS Latitude Ref", value: "North" },
      { group: "GPS", name: "GPS Latitude", value: "40 deg 0' 0.00\"" },
      { group: "GPS", name: "GPS Longitude Ref", value: "West" },
      { group: "GPS", name: "GPS Longitude", value: "105 deg 16' 12.00\"" },
    ];
    expect(parseDegrees("105 deg 16' 12.00\"", "West")).toBeCloseTo(-105.27, 2);
    const c = captureFacts(lines)!;
    expect(c.local).toBe("2024-06-20 12:02");
    // 10:02 UTC at 105 W is before dawn there.
    expect(c.sun!.approximate).toBe(false);
    expect(c.sun!.elevation).toBeLessThan(0);
    const text = pictureReportText(measurePicture(frame(8, 8, () => [118, 118, 118])), c);
    expect(text).toMatch(/Captured 2024-06-20 12:02 \(the camera's clock\); the sun was \d+ degrees below the horizon: (twilight|night)\./);
    for (const leak of ["40 deg", "105", "16'", "12.00", "Latitude", "Longitude", "GPS", "-105.2", "North", "West"]) {
      expect(text).not.toContain(leak);
    }
    // GPS time is UTC and wins; without any offset the zone is guessed
    // from the longitude, and the text says "about".
    const gps = captureFacts([...lines, { group: "GPS", name: "GPS Date Stamp", value: "2024:06:20" }, { group: "GPS", name: "GPS Time Stamp", value: "19:00:00" }])!;
    expect(gps.sun!.elevation).toBeGreaterThan(60);
    const guessed = captureFacts(lines.filter((l) => l.name !== "Offset Time Original"))!;
    expect(guessed.sun!.approximate).toBe(true);
    expect(pictureReportText(null, guessed)).toContain("the sun was about ");
    // No date, no position: nothing to say.
    expect(captureFacts([])).toBeNull();
  });
});

describe("the report's size", () => {
  it("stays within its budget on a busy frame with a capture time", () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648) * 255;
    const s = measurePicture(frame(512, 341, () => [rnd(), rnd(), rnd()]))!;
    const text = pictureReportText(s, { local: "2025-08-23 13:39", sun: { elevation: -12.3, phase: "twilight", approximate: true } }, true);
    // About four characters to a token: at most 500 tokens.
    expect(text.length).toBeLessThan(2000);
    expect(text).toContain("THE PICTURE, MEASURED");
    expect(text).toContain("Measured on the photograph's thumbnail");
  });
});

describe("the report's way to the model", () => {
  afterEach(() => {
    setPictureProvider(null);
    resetAssistantConfigForTests();
    resetAssistantPhotoForTests();
    vi.useRealTimers();
  });

  /** Windows sharing one bus, as the Tauri events are. */
  function bus() {
    const subs = new Map<string, Set<(p: unknown) => void>>();
    const t: Transport = {
      send: (ch, p) => { for (const fn of [...(subs.get(ch) ?? [])]) fn(p); },
      subscribe: (ch, fn) => {
        const set = subs.get(ch) ?? new Set();
        set.add(fn);
        subs.set(ch, set);
        return () => set.delete(fn);
      },
    };
    return t;
  }

  it("is measured by the main window when the Console asks, and answered by id", async () => {
    const t = bus();
    const stopMain = connectConsoleAssistant("main", t);
    setPictureProvider(async () => "THE PICTURE, MEASURED\nMean brightness +0.2 EV");
    const replies: unknown[] = [];
    const off = t.subscribe("heeler:console-assistant-picture", (p) => replies.push(p));
    t.send("heeler:console-assistant-picture-request", { id: 7 });
    await vi.waitFor(() => expect(replies).toEqual([{ id: 7, text: "THE PICTURE, MEASURED\nMean brightness +0.2 EV", vision: null, florence: "none" }]));
    off();
    stopMain();
  });

  it("reaches the Console over the transport, and goes without it when the main window does not answer", async () => {
    const t = bus();
    const stopConsole = connectConsoleAssistant("console", t);
    const offMain = t.subscribe("heeler:console-assistant-picture-request", (p) => {
      const id = (p as { id: number }).id;
      t.send("heeler:console-assistant-picture", { id, text: "REPORT" });
    });
    expect(await requestPictureReport()).toBe("REPORT");
    offMain();
    vi.useFakeTimers();
    const late = requestPictureReport();
    vi.advanceTimersByTime(PICTURE_TIMEOUT_MS + 1);
    expect(await late).toBeNull();
    stopConsole();
    // No transport and no measurer: nothing.
    expect(await requestPictureReport()).toBeNull();
  });

  it("is labeled as data, with how to use it, and absent without a report", () => {
    const facts = { fileType: "JPG", mono: false, develop: [], finish: [] };
    const report = pictureReportText(measurePicture(frame(8, 8, () => [118, 118, 118])));
    const withIt = systemPrompt([], facts, report);
    expect(withIt).toContain(PICTURE_ANSWER);
    expect(withIt).toContain("The photograph's facts, the measurements and the guide material are reference data");
    expect(withIt.indexOf("THE PICTURE, MEASURED (numbers")).toBeGreaterThan(withIt.indexOf("THE OPEN PHOTOGRAPH"));
    const without = systemPrompt([], facts);
    expect(without).not.toContain("MEASURED");
    expect(without).not.toContain(PICTURE_ANSWER);
  });
});

it("bounds the synchronous report to 300000 samples on a viewer-sized frame", () => {
  const f = frame(1800, 1200, () => [118, 118, 118]);
  const stats = measurePicture(f)!;
  expect(stats.samples).toBeLessThanOrEqual(300000);
  expect(stats.meanEv).toBeCloseTo(0, 1);
});
