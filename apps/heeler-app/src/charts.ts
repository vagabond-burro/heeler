/** The Color Checker's chart catalog, asked of the desktop once and
 * cached for the session: built-ins plus the user's custom charts in one
 * list. The overlay and the section's dropdown both read from here. */

import { chartDefs, chartPalette, type ChartDef, type PaletteTarget } from "./bridge";

let cache: ChartDef[] | null = null;
let pending: Promise<ChartDef[]> | null = null;
let generation = 0;
const savedDuringLoad = new Map<string, ChartDef>();

export function loadCharts(): Promise<ChartDef[]> {
  if (cache) return Promise.resolve(cache);
  if (pending) return pending;
  const issued = generation;
  pending = chartDefs().then((defs) => {
    if (issued !== generation) return loadCharts();
    cache = [...defs.filter((c) => !savedDuringLoad.has(c.id)), ...savedDuringLoad.values()];
    savedDuringLoad.clear();
    pending = null;
    return cache;
  }, (error) => {
    if (issued !== generation) return loadCharts();
    pending = null;
    throw error;
  });
  return pending;
}

/** A successful save invalidates any earlier read, including its consumers. */
export function addChart(def: ChartDef): void {
  generation++;
  pending = null;
  if (cache) cache = [...cache.filter((c) => c.id !== def.id), def];
  else savedDuringLoad.set(def.id, def);
}

/** An import brought charts in behind the cache's back. Older requests
 * follow the new generation instead of publishing their stale answer. */
export function reloadCharts(): Promise<ChartDef[]> {
  generation++;
  cache = null;
  pending = null;
  return loadCharts();
}

let paletteCache: PaletteTarget[] | null = null;

/** The custom-chart editor's target palette, asked of the desktop once:
 * the Lab values are the engine's own, so the editor never ports the
 * color science. */
export function loadPalette(): Promise<PaletteTarget[]> {
  if (paletteCache) return Promise.resolve(paletteCache);
  return chartPalette().then((p) => {
    paletteCache = p;
    return p;
  });
}

export function chartById(charts: ChartDef[], id: string): ChartDef | null {
  return charts.find((c) => c.id === id) ?? charts[0] ?? null;
}

/** Test seam: the cache is module state, so suites reset it between
 * files that each mock the bridge their own way. */
export function resetChartsForTests(): void {
  generation++;
  savedDuringLoad.clear();
  cache = null;
  pending = null;
  paletteCache = null;
}

export type { ChartDef, PaletteTarget };
