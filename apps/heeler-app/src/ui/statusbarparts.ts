// statusbar.tsx's values and helpers that are not components, kept apart so
// statusbar.tsx exports components alone and Vite can refresh it in place as
// it is edited instead of reloading the window.

export type ViewerReadout = { zoom: string; res: string };

export let readout: ViewerReadout | null = null;

export const subs = new Set<(r: ViewerReadout | null) => void>();

/** The viewer's zoom/resolution labels, published for the bar. Pass
 * null on unmount so a closed viewer leaves no stale numbers. */
export function publishViewerReadout(r: ViewerReadout | null) {
  readout = r;
  subs.forEach((f) => f(readout));
}

// The model-work readout ("Could the status bar show a
// progress read out if its working hard?"). Runners publish what
// they are doing; the bar shows it in gold until they publish null.
// Same module-store pattern as the viewer readout, so nothing
// re-renders but the bar.
export let busy: string | null = null;

export const busySubs = new Set<(b: string | null) => void>();

export function publishBusy(text: string | null) {
  busy = text;
  busySubs.forEach((f) => f(busy));
}
