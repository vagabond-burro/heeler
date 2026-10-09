// One line of help at a time, shown in the status row rather than in a
// tooltip that follows the cursor around and covers what you are aiming
// at.
//
// The text lives on the element as data-hint and is picked up by a
// single delegated listener, so a control carries its help exactly once
// and nothing has to be wired up per button. data-hint rather than title
// on purpose: title is what draws the native tooltip.

import { useEffect, useState } from "react";
import { bindingFor, formatBinding } from "../hotkeys";
import { logMsg } from "../log";

/** The user's hotkey overrides, published by the app root so hints can
 * print the binding actually in force ("When this mouse
 * hovers any tool that has a hotkey, display that hotkey along with
 * the help message"). A module variable for the same reason the hint
 * store is one: the delegated listener is not a component.*/
let hintOverrides: Record<string, string> = {};
export function setHintOverrides(o: Record<string, string>): void {
  hintOverrides = o;
}

/** The one grammar for help-plus-key. A control names its command with
 * data-hint-cmd and the LIVE binding is looked up (remaps follow); a
 * key outside the registry (a local handler like Compare's C) rides
 * data-hint-key as a literal. An unbound command adds nothing. */
function composeHint(el: Element): string | null {
  const base = el.getAttribute("data-hint");
  const cmd = el.getAttribute("data-hint-cmd");
  const raw = cmd ? bindingFor(cmd, hintOverrides) : el.getAttribute("data-hint-key");
  const key = raw ? formatBinding(raw) : null;
  if (base && key) return `${base} (${key})`;
  if (base) return base;
  return key;
}

/** A tool's failure, where the user is actually looking. A day of
 * The owner's "nothing happened" reports traced to errors landing
 * only in the console panel; the status bar is the visible home,
 * the log keeps the record. On the day's pattern: "I clicked To
 * Mask and nothing happened. There was a flicker."*/
export function reportToolError(what: string, err: unknown): void {
  const msg = `${what} failed: ${String(err)}`;
  flashStatus(msg, 8000);
  logMsg("error", msg);
}

let current: string | null = null;
let flash: string | null = null;
let flashTimer: number | undefined;
const subs = new Set<(v: string | null) => void>();

function publish() {
  subs.forEach((f) => f(flash ?? current));
}

export function setHint(v: string | null) {
  if (v === current) return;
  current = v;
  // A flash owns the row while it lasts; hovering elsewhere underneath it
  // still updates what will be showing when it clears.
  if (!flash) publish();
}

/** Says something in the status row for a few seconds, over whatever the
 * pointer is hinting, then gets out of the way.
 *
 * For the things a tool has to tell you at the moment you tried
 * something: they belong where the help already is, rather than in a
 * dialog to dismiss or a log nobody has open. On clone and heal
 * refusing a stroke with no source: it "would be nice for there to be a
 * notification down in the status line... show up for like 5 seconds
 * then return to the navigation tips".
 */
export function flashStatus(text: string, ms = 5000) {
  flash = text;
  if (flashTimer !== undefined) clearTimeout(flashTimer);
  flashTimer = setTimeout(() => {
    flash = null;
    flashTimer = undefined;
    publish();
  }, ms) as unknown as number;
  publish();
}

/** The flash on screen right now, or null. A reader for code that is
 * not a component: the status line itself uses useHint() below. */
export function currentFlash(): string | null {
  return flash;
}

/** Test hook: drops any flash in progress. */
export function _clearFlashForTests() {
  if (flashTimer !== undefined) clearTimeout(flashTimer);
  flashTimer = undefined;
  flash = null;
  publish();
}

/** The hint under the pointer right now. Only components that call this
 * re-render as the pointer moves, which is why the store is a module
 * rather than context. */
export function useHint(): string | null {
  const [v, setV] = useState(flash ?? current);
  useEffect(() => {
    subs.add(setV);
    setV(flash ?? current);
    return () => {
      subs.delete(setV);
    };
  }, []);
  return v;
}

/** Publishes hints for the whole window. Call once, from a root. */
export function useHintSource() {
  useEffect(() => {
    const read = (t: EventTarget | null) => {
      const el =
        t instanceof Element ? t.closest("[data-hint], [data-hint-cmd], [data-hint-key]") : null;
      return el ? composeHint(el) : null;
    };
    // mouseover fires on entering any element, so moving from a hinted
    // control onto plain background clears it without needing mouseout.
    let last: EventTarget | null = null;
    const onOver = (e: Event) => {
      last = e.target;
      setHint(read(e.target));
    };
    const onLeave = () => {
      last = null;
      setHint(null);
    };
    // A control whose hint changes because it was used (the Spectrums
    // and Curves RGB chip turning into CMY on Option-click) would keep
    // saying its old face until the pointer left and came back. Read
    // the same element again once the click or key has rendered.
    let frame = 0;
    const onUse = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        setHint(last instanceof Element && last.isConnected ? read(last) : null);
      });
    };
    document.addEventListener("mouseover", onOver);
    document.addEventListener("focusin", onOver);
    document.addEventListener("mouseleave", onLeave);
    document.addEventListener("click", onUse);
    document.addEventListener("keyup", onUse);
    window.addEventListener("blur", onLeave);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("mouseover", onOver);
      document.removeEventListener("focusin", onOver);
      document.removeEventListener("mouseleave", onLeave);
      document.removeEventListener("click", onUse);
      document.removeEventListener("keyup", onUse);
      window.removeEventListener("blur", onLeave);
      setHint(null);
    };
  }, []);
}
