/** Which OS the app is running on, as far as key labels care.
 *
 * A function rather than a module-level constant so tests can flip it
 * after import; jsdom reports an empty platform, so tests see Windows
 * behavior unless they opt in with setMacForTests.
 */

let macOverride: boolean | null = null;

/** Test hook: force isMac() to a value; null restores detection. */
export function setMacForTests(v: boolean | null): void {
  macOverride = v;
}

export function isMac(): boolean {
  if (macOverride !== null) return macOverride;
  if (detectedMac === null) detectedMac = detectMac();
  return detectedMac;
}

/** The platform read once: the OS does not change under a running
 * window, and the navigator getters are not free. Every hint and menu
 * label asks, the whole panel re-renders on each step of a slider
 * drag, and reading userAgentData each time was measurable in the
 * drag's profile (a tester, 2026-09-30: "a bit of jitter/lag on the
 * sliders"). */
let detectedMac: boolean | null = null;
function detectMac(): boolean {
  if (typeof navigator === "undefined") return false;
  const plat =
    (navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform ??
    navigator.platform ??
    "";
  return /mac/i.test(plat);
}

/** The name of a physical modifier as prose hints spell it: the Mac
 * symbol on a Mac, shouted text elsewhere. For hint strings, not for
 * bindings; those go through formatBinding. */
export function modLabel(m: "ctrl" | "alt" | "shift"): string {
  if (!isMac()) return { ctrl: "CTRL", alt: "ALT", shift: "SHIFT" }[m];
  return { ctrl: "⌘", alt: "⌥", shift: "⇧" }[m];
}

/** Whether a `contextmenu` event is a Mac's Control-click rather than a
 * real right-click.
 *
 * On a Mac, Control held on the primary button never arrives as a
 * click: the system turns it into the secondary click, so the element
 * hears `contextmenu` with ctrlKey set. A right-click proper (the
 * second button, a two-finger click) carries no Control. Anywhere the
 * app gives Control-click a job of its own, the photograph selection's
 * "ctrl adds or removes" among them, the menu handler has to hand the
 * gesture back, or on a Mac that job cannot be done at all (each
 * Control-click on a stack replaced the selection with it, so Move to
 * Trash moved one at a time).
 */
export function isMacControlClick(e: { ctrlKey: boolean; button?: number }): boolean {
  // The second button with Control held is still a right-click: only
  // the primary button's Control-click is the system's stand-in.
  return isMac() && e.ctrlKey && e.button !== 2;
}

/** Keeps the webview's own context menu off the screen.
 *
 * Wherever the app had no menu of its own, a right-click brought up
 * the platform webview's: "Reload", Back, Forward. It showed in dev
 * builds and the owner assumed it would not ship; it did.
 * "when I right click I get a small popup that has 'Reload'... it
 * does" show up in release builds. The app's own menus are
 * unaffected: they handle the event on their element first and this
 * only stops the default.
 *
 * Two places keep the native menu, because it does real work there:
 * editable fields (Cut, Copy, Paste live in it), and a run of selected
 * text (Copy, Look Up). In a development build, holding Alt or Option
 * keeps it everywhere, so Inspect Element stays one click away.
 */
export function guardContextMenu(e: MouseEvent, dev = false): boolean {
  if (dev && e.altKey) return false;
  const t = e.target as Element | null;
  if (t?.closest?.("input, textarea, [contenteditable=''], [contenteditable='true']")) return false;
  const sel = typeof window !== "undefined" ? window.getSelection?.() : null;
  if (sel && !sel.isCollapsed && sel.toString().length > 0) return false;
  e.preventDefault();
  return true;
}

export function installContextMenuGuard(dev = false): void {
  if (typeof document === "undefined") return;
  document.addEventListener("contextmenu", (e) => {
    guardContextMenu(e, dev);
  });
}
