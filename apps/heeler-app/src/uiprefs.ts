// The handful of interface switches that should still be set the way you
// left them next time you open the app.
//
// Deliberately small and deliberately not the edit state: an edit belongs
// to a photograph and rides in its graph, while "did I leave the stroke
// tint on" belongs to the person. localStorage rather than a settings
// file because it wants no round trip and losing it costs a click.
//
// Reads are total: a missing key, a corrupt value or a browser that
// refuses storage all fall back to the default rather than throwing on
// the way to first paint.

const PREFIX = "heeler.ui.";

export function uiPref<T extends boolean | number | string>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (raw === null) return fallback;
    const v: unknown = JSON.parse(raw);
    return typeof v === typeof fallback ? (v as T) : fallback;
  } catch {
    return fallback;
  }
}

export function setUiPref(key: string, value: boolean | number | string): void {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    // Private browsing, a full quota, storage switched off: the switch
    // still works for this session, it just will not be remembered.
  }
}

// The chrome zoom, a preference now (the owner's answer to a 4K
// tester whose slider handles crowded the RESET text: "Add the
// recommended app zoom"). One number scales every .ui-zoom container:
// panels, ribbon, dialogs. The image viewport is deliberately outside
// it and stays pixel-true at every setting.
export const CHROME_ZOOM_DEFAULT = 1.15;
export const CHROME_ZOOM_STEPS = [1, 1.15, 1.3, 1.5] as const;

/** Sets --chrome-zoom from the preference (or an explicit value, when
 * the Preferences dialog is applying a change live). Runs at every
 * window's startup, pop-outs included: each one boots through main.tsx
 * and reads the same stored preference. */
export function applyChromeZoom(v?: number): void {
  const stored = v ?? uiPref("chromeZoom", CHROME_ZOOM_DEFAULT);
  const z = CHROME_ZOOM_STEPS.includes(stored as (typeof CHROME_ZOOM_STEPS)[number])
    ? stored
    : CHROME_ZOOM_DEFAULT;
  document.documentElement.style.setProperty("--chrome-zoom", String(z));
  // The main window fits its panels to the room at this zoom
  // (layoutfit.ts), so it has to hear about a change made live.
  window.dispatchEvent(new Event(CHROME_ZOOM_EVENT));
}

/** Fired on the window whenever applyChromeZoom sets the zoom. */
export const CHROME_ZOOM_EVENT = "heeler-chrome-zoom";

/** The zoom step currently in force, for the spots that live OUTSIDE a
 * .ui-zoom wrapper and must carry the factor on their own fonts (the
 * catalog's captions, the embedded metadata table, portaled menus):
 * they read the same preference the wrapper does, so their type stays
 * in step with the chrome at every setting while the pictures next to
 * it stay pixel-true. Read per render, the same non-reactive pattern
 * the canvas panel placement uses; a zoom change always re-renders via
 * the Preferences dialog closing. */
export function chromeZoomFactor(): number {
  const stored = uiPref("chromeZoom", CHROME_ZOOM_DEFAULT);
  return CHROME_ZOOM_STEPS.includes(stored as (typeof CHROME_ZOOM_STEPS)[number])
    ? stored
    : CHROME_ZOOM_DEFAULT;
}
