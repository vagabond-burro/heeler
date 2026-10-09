import { beforeEach } from "vitest";
import { mockResetUiSettings } from "./bridge";
import { _resetTauriEventsForTests } from "./taurievents";
import "@testing-library/jest-dom";
import { configure } from "@testing-library/react";
import { TIME_SLACK } from "./__tests__/timeslack";

// waitFor and findBy give up after a second by default; a platform
// slower than the Mac gets the same room as every other time limit.
configure({ asyncUtilTimeout: 1_000 * TIME_SLACK });

// jsdom has no 2D canvas and shouts about it on every getContext call,
// which buries real failures under a wall of stack traces. Returning
// null is what the spectrum code already handles: it is the same answer
// a browser gives for a context it cannot supply, and every caller
// checks. Anything that genuinely needs pixels is tested against the
// arithmetic in spectrums.ts instead, which needs no canvas at all.
HTMLCanvasElement.prototype.getContext = (() => null) as never;

// jsdom implements no scrolling at all, so scrollIntoView is simply
// absent. The launch auto-scroll runs on a timer, which means it fires
// after the test that rendered the app has finished and lands as an
// unhandled exception rather than a failure: 235 of them across the
// suite, enough to hide a real one. Scrolling is verified by asserting
// on the call, not by watching jsdom move a viewport it does not have.
Element.prototype.scrollIntoView = function () {};

// This jsdom exposes localStorage as an inert object with no methods,
// which would silently disable the console scratchboard's crash
// persistence under test (its try/catch treats a broken store as "no
// storage"). A minimal real store keeps that contract testable.
if (typeof window.localStorage?.getItem !== "function") {
  const store = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: (i: number) => [...store.keys()][i] ?? null,
      get length() {
        return store.size;
      },
    },
  });
}

// Tool settings are remembered across launches on purpose, which across
// tests means one test's choice of selection tool becomes the next
// one's default. Wiped between tests so each starts from the shipped
// defaults.
beforeEach(() => {
  // The Tauri event hub keeps one listener per event for a window's
  // life; a test's mocked event module is fresh, so the hub starts over.
  _resetTauriEventsForTests();
  mockResetUiSettings();
  // The spectrum's remembered scope, channel and EV graticule live in
  // localStorage (ui/spectrum.tsx), which outlives a test: one test's
  // waveform must not become the next one's opening scope.
  for (const key of ["spectrumKind", "spectrumChannel", "spectrumEvLines"]) {
    try { localStorage.removeItem(`heeler.ui.${key}`); } catch { /* no storage */ }
  }
});
