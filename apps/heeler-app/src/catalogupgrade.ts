/** The catalog update prompt (26.3): when a catalog predates this
 * build's schema, nothing opens or migrates it until the user has had
 * the backup choice. The gate lives in src-tauri (every open door
 * passes through it); this store holds the pending prompt and its
 * three answers, and ui/catalogupgrade.tsx draws the card.
 *
 * The choices: Quit (nothing was touched, the app closes), Update
 * Without Backup, or Back Up and Update (the default). A backup that
 * fails approves NOTHING: the error shows in the card and the choices
 * are offered again, so approval can never fall through a failed copy.
 * A written backup gets a done line naming the file, so the user knows
 * where the pre-update copy went. */

import { useSyncExternalStore } from "react";
import { catalogUpgradeApprove, installUpgradeAsk, quitApp, type BackupResult, type UpgradePending } from "./bridge";

export interface CatalogUpgradePrompt {
  pending: UpgradePending;
  /** The done stage after a written backup names the file. */
  done: BackupResult | null;
  /** A failed backup's error; the choices stay on offer beside it. */
  error: string | null;
  busy: boolean;
}

let prompt: CatalogUpgradePrompt | null = null;
const listeners = new Set<() => void>();
let version = 0;
let resolveAsk: ((approved: boolean) => void) | null = null;
let askChain: Promise<unknown> = Promise.resolve();

function notify(): void {
  version += 1;
  listeners.forEach((l) => l());
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function setPrompt(next: CatalogUpgradePrompt | null): void {
  prompt = next;
  notify();
}

export function useCatalogUpgradePrompt(): CatalogUpgradePrompt | null {
  useSyncExternalStore(subscribe, () => version, () => version);
  return prompt;
}

function finish(approved: boolean): void {
  const resolve = resolveAsk;
  resolveAsk = null;
  setPrompt(null);
  resolve?.(approved);
}

function openAsk(pending: UpgradePending): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    resolveAsk = resolve;
    setPrompt({ pending, done: null, error: null, busy: false });
  });
}

/** Shows the card and resolves true once the update is approved (backup
 * or not), false when the user quit. Asks queue rather than stack: a
 * boot check and a catalog switch can both arrive, and one card at a
 * time is the rule the rest of the dialogs keep. An idle store opens
 * synchronously, so the caller sees the card in the same tick. */
/** One prompt per catalog, however many callers ask. The boot effect
 * runs twice under React's development double-mount, and every
 * command refused at the gate asks too, so without this each ask
 * queued its own card and the prompt came back after it was answered
 * (2026-09-19: "it returned me back to the prompt"). An ask for a
 * catalog with a card already open shares that card's answer; an ask
 * for one approved this session is answered yes at once.*/
const inflight = new Map<string, Promise<boolean>>();
const approvedPaths = new Set<string>();

/** A restore put a different file under this path: the approval given
 * for the one set aside does not carry over, so an older copy meets the
 * prompt again (review, 2026-09-20). */
export function forgetCatalogUpgradeApproval(path: string): void {
  approvedPaths.delete(path);
}

export function askCatalogUpgrade(pending: UpgradePending): Promise<boolean> {
  if (approvedPaths.has(pending.path)) return Promise.resolve(true);
  const open = inflight.get(pending.path);
  if (open) return open;
  const start = () => openAsk(pending);
  const ask = (!prompt && !resolveAsk ? start() : askChain.then(start)).then((approved) => {
    inflight.delete(pending.path);
    if (approved) approvedPaths.add(pending.path);
    return approved;
  });
  inflight.set(pending.path, ask);
  askChain = ask;
  return ask;
}

// Every bridge call refused at the gate comes here for its answer,
// then retries once on yes (bridge.ts nativeCall).
installUpgradeAsk(askCatalogUpgrade);

/** The boot path with the policy on: the backup is already written and
 * the update approved, so only the done line remains to say where the
 * pre-update copy went. Resolves when the line is acknowledged. */
export function noticeCatalogUpgradeDone(pending: UpgradePending, backup: BackupResult): Promise<void> {
  const open = () =>
    new Promise<void>((resolve) => {
      resolveAsk = () => resolve();
      setPrompt({ pending, done: backup, error: null, busy: false });
    });
  if (!prompt && !resolveAsk) {
    const notice = open();
    askChain = notice;
    return notice;
  }
  const notice = askChain.then(open);
  askChain = notice;
  return notice;
}

/** Back Up and Update, or Update Without Backup. A failure (the backup
 * could not be written) approves nothing: the error returns to the
 * card and the choices are offered again. */
export async function chooseCatalogUpgrade(choice: "backup" | "nobackup"): Promise<void> {
  const p = prompt;
  if (!p || p.busy || p.done) return;
  setPrompt({ ...p, busy: true, error: null });
  try {
    const written = await catalogUpgradeApprove(p.pending.path, choice === "backup");
    if (written) {
      setPrompt({ ...p, busy: false, done: written });
      return;
    }
    finish(true);
  } catch (e) {
    setPrompt({ ...p, busy: false, error: e instanceof Error ? e.message : String(e) });
  }
}

/** The done line's OK: the update is already approved, so this simply
 * closes the card and lets the waiting caller continue. */
export function acknowledgeCatalogUpgrade(): void {
  finish(true);
}

/** Quit: close the card, answer the ask, and hand the app to the
 * backend's exit. Nothing was opened and nothing migrated. */
export async function quitForCatalogUpgrade(): Promise<void> {
  finish(false);
  await quitApp();
}

/** Test hook. */
export function resetCatalogUpgradeForTests(): void {
  resolveAsk = null;
  askChain = Promise.resolve();
  prompt = null;
  inflight.clear();
  approvedPaths.clear();
  notify();
}
