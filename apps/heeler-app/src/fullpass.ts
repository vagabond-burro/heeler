// Apply's full-resolution pass, as the rest of the app needs to know it:
// is one still due for a selection (taken by PolishFullRunner and not
// yet finished), and a way to wait for it.
//
// To Mask and every other bake (Selection from Mask, a removal's
// snapshot) wait for it (2026-09-29: "go with option B for To Mask"): a
// selection with a full-resolution twin bakes at the photograph's size
// from it, and a bake that ran while the pass was still going would keep
// the preview's matte while the twin landed a moment later for a mask
// that no longer points at it. Waiting, the bake is made from what the
// pass lands; a pass that is canceled or keeps the preview's matte
// releases the wait and the bake is the preview's, as before. The
// desktop waits for a pass it is running as well (bake_mask_raster),
// which covers a pass started from anywhere.

const due = new Set<string>();
const waiters = new Map<string, (() => void)[]>();

const keyOf = (image: string, node: string) => `${image}|${node}`;

/** PolishFullRunner's word: a pass for this selection is (or is no
 * longer) due. Turning one off releases everything waiting on it. */
export function markFullPassDue(image: string, node: string, on: boolean): void {
  const key = keyOf(image, node);
  if (on) {
    due.add(key);
    return;
  }
  due.delete(key);
  const list = waiters.get(key);
  waiters.delete(key);
  for (const done of list ?? []) done();
}

/** Every pass is off: the runner went away, so nothing will finish them. */
export function clearFullPasses(): void {
  for (const key of [...due]) {
    const [image, ...rest] = key.split("|");
    markFullPassDue(image, rest.join("|"), false);
  }
}

export function fullPassDue(image: string, node: string): boolean {
  return due.has(keyOf(image, node));
}

/** Resolves when no full-resolution pass is due for this selection:
 * at once when none is, or when the one due finishes, is canceled or
 * is superseded. */
export function awaitFullPass(image: string, node: string): Promise<void> {
  const key = keyOf(image, node);
  if (!due.has(key)) return Promise.resolve();
  return new Promise((resolve) => {
    const list = waiters.get(key) ?? [];
    list.push(resolve);
    waiters.set(key, list);
  });
}
