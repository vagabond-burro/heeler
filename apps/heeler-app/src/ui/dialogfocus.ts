import { focusReturnTarget } from "./focusreturn";
import { useLayoutEffect, useRef } from "react";

const focusable = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])';
const stack: HTMLElement[] = [];

/** Dialogs own focus while open and return it to their opener on close.
 * Keep the list live: a preference search or a recovery operation can
 * replace controls without remounting the dialog. */
export function useDialogFocus(open: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const root = ref.current;
    if (!open || !root) return;
    const opener = document.activeElement instanceof HTMLElement ? focusReturnTarget(document.activeElement) : null;
    const items = () => Array.from(root.querySelectorAll<HTMLElement>(focusable))
      .filter(el => !el.closest('[hidden], [inert], [aria-hidden="true"]') && getComputedStyle(el).display !== "none" && getComputedStyle(el).visibility !== "hidden");
    stack.push(root);
    (root.querySelector<HTMLElement>("[data-initial-focus]") ?? items()[0] ?? root).focus();
    const key = (event: KeyboardEvent) => {
      if (stack[stack.length - 1] !== root || event.key !== "Tab") return;
      const list = items();
      const at = list.indexOf(document.activeElement as HTMLElement);
      if (!list.length || at < 0 || (event.shiftKey ? at === 0 : at === list.length - 1)) {
        event.preventDefault();
        (event.shiftKey ? list[list.length - 1] ?? root : list[0] ?? root).focus();
      }
    };
    const focus = (event: FocusEvent) => {
      if (stack[stack.length - 1] !== root || root.contains(event.target as Node)) return;
      // A menu opened from inside the dialog renders through a portal,
      // outside the dialog's subtree but still the dialog's own: pulling
      // focus back would close it the moment it opened.
      if (event.target instanceof Element && event.target.closest('[role="menu"]')) return;
      (items()[0] ?? root).focus();
    };
    document.addEventListener("keydown", key, true);
    document.addEventListener("focusin", focus);
    return () => {
      stack.splice(stack.indexOf(root), 1);
      document.removeEventListener("keydown", key, true);
      document.removeEventListener("focusin", focus);
      if (opener?.isConnected) opener.focus();
    };
  }, [open]);
  return ref;
}
