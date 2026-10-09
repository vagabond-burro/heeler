// One clock for every graph writer, including direct writes and queued retries.
const revisions = new Map<string, number>();
export function observeSaveRevision(image: string, revision: number): void {
  if (Number.isSafeInteger(revision)) revisions.set(image, Math.max(revisions.get(image) ?? 0, revision));
}
export function nextSaveRevision(image: string): number {
  const revision = Math.max(Date.now() * 1000, (revisions.get(image) ?? 0) + 1);
  revisions.set(image, revision);
  return revision;
}
