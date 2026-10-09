/** Feature gates for work that exists but is not ready to hand to a
 * user. A gate hides every door to a feature while its engine and its
 * tests stay alive underneath, so development continues without a
 * broken tool sitting in the menu.
 */

let polishOverride: boolean | null = null;

/** Test hook: force polishEnabled() to a value; null restores. */
export function setPolishForTests(v: boolean | null): void {
  polishOverride = v;
}

/** Polish Selection. It was hidden while the classical matte lost
 * fine fur against matched backgrounds ("I don't want to
 * deliver a broken feature"), and the gate opened with P4: the
 * ViTMatte refinement recovers the hair-strand cases the classical
 * pass never could, and the Smart matte button in the polish toolbar
 * is the door to it. The gate itself stays, so one flip can pull the
 * tool back if real photographs disagree.*/
export function polishEnabled(): boolean {
  if (polishOverride !== null) return polishOverride;
  return true;
}

let previewBuildOverride: boolean | null = null;

/** Test hook: force previewBuild() to a value; null restores. */
export function setPreviewBuildForTests(v: boolean | null): void {
  previewBuildOverride = v;
}

/** Whether this build may offer previews at all: development builds
 * only. 2026-08-26, on tethering: "Since it's hard to verify numerous
 * cameras, I don't think making it available even as an experimental
 * feature is a good idea for the commercial release." A camera Heeler
 * has never met is not a rough edge the user can see around, it is a
 * body that does not answer, and no preference text makes that a fair
 * thing to sell. So the door is not merely closed in a shipped build,
 * it is not on the wall: the Preferences toggle is absent there too,
 * and nothing hints at a feature the build will not give. The stored
 * preference is left alone, so a development build still honors
 * whichever way it was last set.*/
export function previewBuild(): boolean {
  if (previewBuildOverride !== null) return previewBuildOverride;
  return import.meta.env.DEV;
}

let experimentalOverride: boolean | null = null;

/** Test hook: force experimentalEnabled() to a value; null restores. */
export function setExperimentalForTests(v: boolean | null): void {
  experimentalOverride = v;
}

/** Experimental features (the Preferences toggle, off by default).
 * Unlike the polish gate this one is user-facing: the user opts in,
 * knowing the feature is a preview. Tether is the first feature behind
 * it: the tab watches a folder honestly, but direct USB capture is
 * proven on one Panasonic body and untested on every other.
 *
 * Two locks, not one. The preference is the user's own opt-in; the
 * build check above is ours, and a shipped build says no whatever the
 * preference says. */
export function experimentalEnabled(pref: boolean): boolean {
  if (experimentalOverride !== null) return experimentalOverride;
  return previewBuild() && pref;
}
