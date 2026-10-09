/** Help > Check for Updates, and the launch-time check behind it.
 *
 * Check and link only (the plan of 2026-09-07): the app reads one
 * manifest from the public release repo, compares versions, and offers
 * to hand this platform's installer to the browser (update.rs's url is
 * the installer whenever a newer release is offered; the release page
 * only when there is nothing to take). It never downloads or installs
 * anything itself. src-tauri/src/update.rs does the fetch and the
 * compare; this module decides what the user sees:
 *
 * - From the menu, every outcome is shown: a newer release, "You're up
 *   to date", or "could not reach the release list".
 * - At launch, only a newer release is shown, and only when its version
 *   has not been skipped; failures and "up to date" stay silent, since
 *   nobody asked. The launch check is a preference, on by default, and
 *   the menu item works either way.
 */

import { useSyncExternalStore } from "react";
import { updateCheck, type UpdateCheck } from "./bridge";

/** What the update dialog's Download does, in the words the dialog, the
 * Help > Check for Updates hint and the launch-check preference all
 * use (docs review 2026-10-01: the three disagreed). True to the code:
 * a newer release is offered only with an installer for this platform
 * (update.rs assess), and Download opens that link in the browser. */
export const UPDATE_DOWNLOAD_WORDS = "Download hands the installer to your browser. Nothing is installed until you open it.";

export type UpdateTrigger = "launch" | "menu";

export type UpdateOutcome =
  | { kind: "available"; current: string; latest: string; url: string; notes: string }
  | { kind: "current"; current: string; latest: string }
  | { kind: "unreachable"; detail: string };

export interface UpdatePrompt {
  trigger: UpdateTrigger;
  /** null while the check is in flight */
  outcome: UpdateOutcome | null;
}

const SKIP_KEY = "heeler.updates.skip";

let prompt: UpdatePrompt | null = null;
const listeners = new Set<() => void>();
let version = 0;

function notify(): void {
  version += 1;
  listeners.forEach((l) => l());
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function setPrompt(next: UpdatePrompt | null): void {
  prompt = next;
  notify();
}

export function updatePrompt(): UpdatePrompt | null {
  return prompt;
}

export function useUpdatePrompt(): UpdatePrompt | null {
  useSyncExternalStore(subscribe, () => version, () => version);
  return prompt;
}

export function closeUpdatePrompt(): void {
  if (prompt) setPrompt(null);
}

/** The version the user asked not to hear about again at launch. The
 * menu item still reports it: an explicit question gets an answer. */
export function skippedVersion(): string | null {
  try {
    return localStorage.getItem(SKIP_KEY);
  } catch {
    return null;
  }
}

export function skipVersion(latest: string): void {
  try {
    localStorage.setItem(SKIP_KEY, latest);
  } catch {
    // no storage: the launch prompt returns next time, which is the
    // safe side of forgetting
  }
  closeUpdatePrompt();
}

function outcomeOf(reply: UpdateCheck): UpdateOutcome {
  return reply.available
    ? { kind: "available", current: reply.current, latest: reply.latest, url: reply.url, notes: reply.notes }
    : { kind: "current", current: reply.current, latest: reply.latest };
}

/** Whether the saved settings ask for the launch check. Read from the
 * settings file's text so the check can start alongside the load,
 * before the reducer has necessarily applied it. Missing means yes:
 * the preference is on until turned off. */
export function launchCheckWanted(settingsJson: string | null): boolean {
  if (!settingsJson) return true;
  try {
    const saved = JSON.parse(settingsJson) as { prefs?: { checkUpdatesOnLaunch?: unknown } };
    return saved?.prefs?.checkUpdatesOnLaunch !== false;
  } catch {
    return true;
  }
}

/** Runs the check and shows what the trigger warrants. Never throws. */
export async function checkForUpdates(trigger: UpdateTrigger): Promise<UpdateOutcome> {
  if (trigger === "menu") setPrompt({ trigger, outcome: null });
  let outcome: UpdateOutcome;
  try {
    outcome = outcomeOf(await updateCheck());
  } catch (e) {
    outcome = { kind: "unreachable", detail: e instanceof Error ? e.message : String(e) };
  }
  if (trigger === "menu") {
    // Still the prompt this call opened: a close while the fetch was
    // out must not reopen it.
    if (prompt?.trigger === "menu" && prompt.outcome === null) setPrompt({ trigger, outcome });
  } else if (outcome.kind === "available" && outcome.latest !== skippedVersion() && !prompt) {
    setPrompt({ trigger, outcome });
  }
  return outcome;
}

/** Test hook. */
export function resetUpdatesForTests(): void {
  prompt = null;
  try {
    localStorage.removeItem(SKIP_KEY);
  } catch {
    // nothing kept
  }
}
