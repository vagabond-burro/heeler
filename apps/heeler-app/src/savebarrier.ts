import { autosaves, FLUSH_ROUNDS, KEEP_ARRIVING, SaveQueue } from "./autosave";

/** Catalog settings/session debounces join the edit recovery save barrier. */
export const catalogSaves = new SaveQueue();
const running = new Set<Promise<unknown>>();
const failed = new Map<string, string>();
const revisions = new Map<string, number>();

export function trackedSave<T>(key: string, write: () => Promise<T>): Promise<T> {
  const revision = (revisions.get(key) ?? 0) + 1;
  revisions.set(key, revision);
  const promise = Promise.resolve().then(write);
  running.add(promise);
  void promise.then(() => {
    if (revisions.get(key) === revision) failed.delete(key);
  }, e => {
    if (revisions.get(key) === revision) failed.set(key, `${key}: ${String(e)}`);
  }).finally(() => running.delete(promise));
  return promise;
}

export async function flushRecoverySaves(): Promise<void> {
  // Bounded like the queues' own flush: writes that keep arming more
  // writes must end in a message, not a dialog that never opens. A save
  // that failed beside the storm is the part the user can act on, so it
  // rides whatever message ends the wait.
  const withFailures = (error: unknown): never => {
    if (failed.size && String(error).includes(KEEP_ARRIVING)) {
      throw new Error(`${error} Saves have also failed: ${[...failed.values()].join("; ")}`);
    }
    throw error;
  };
  for (let round = 0; ; round++) {
    await autosaves.flush().catch(withFailures);
    await catalogSaves.flush().catch(withFailures);
    await Promise.allSettled([...running]);
    if (!running.size && autosaves.pendingImage() === null && catalogSaves.pendingImage() === null) break;
    if (round >= FLUSH_ROUNDS) withFailures(new Error(`Recovery cannot start. ${KEEP_ARRIVING}`));
  }
  if (failed.size) throw new Error(`Recovery cannot start while saves have failed. ${[...failed.values()].join("; ")}`);
}
