import { useEffect, useRef } from "react";
import { isTauri, runScheduledBackup } from "../bridge";
import { logMsg } from "../log";
import { flashStatus } from "./hints";

/** The scheduled catalog backup, once per launch.
 *
 * On launch rather than on a timer: a photo editor is not open all
 * week, and a backup that only happens if the app runs past midnight
 * is one nobody can rely on. The Rust side decides whether it is
 * actually due, so this is safe to call every time.
 *
 * It waits for `ready`, set once the saved settings have been
 * dispatched: the mount-only effect it replaces read the default
 * preferences, an empty folder, so a configured schedule never ran. One
 * attempt per launch is the whole design, which is why a preference
 * changed mid-session does not fire it again. */
export function useScheduledCatalogBackup(
  ready: boolean,
  folder: string,
  everyDays: number,
  /** Where a failure is put in front of the user: the main window
   * hands this a dialog, since a status flash at launch is easy to
   * miss and a backup that quietly stopped is the failure that
   * matters ("the user should be notified with what
   * happened, why it happened, and how they can resolve").*/
  notify?: (message: string) => void,
) {
  const attempted = useRef(false);
  useEffect(() => {
    if (!ready || attempted.current || !isTauri()) return;
    attempted.current = true;
    if (!folder || everyDays <= 0) return;
    void runScheduledBackup(folder, everyDays).then(result => {
      if (result) logMsg("info", `Catalog backed up to ${result.path} (${result.images} photographs)`);
    }).catch(error => {
      // The native message already says what happened, why, and what to
      // do; only the retry is added here, once.
      const message = `Scheduled catalog backup failed: ${String(error)} Heeler will try again at the next launch.`;
      logMsg("error", message);
      flashStatus(message, 12000);
      notify?.(message);
    });
  }, [ready, folder, everyDays, notify]);
}
