import { rememberMenuOrigin } from "./focusreturn";
import React, { forwardRef, useLayoutEffect, useRef } from "react";
import { scrollItemIntoList } from "./hooks";
import { placeSubmenu } from "./menusurfaceparts";

/** The shared menu face supplies focus, arrows and item semantics to the
 * existing button actions. Submenus own their keys independently. */
export const MenuSurface = forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & {
    submenu?: boolean;
    /** Off for a submenu whose rows open submenus of their own: a
     * scrolling list clips its flyouts (overflow-y forces overflow-x),
     * unless those flyouts are `fixed`. */
    scroll?: boolean;
    /** A submenu pinned to the window (placeSubmenu). */
    fixed?: boolean;
  }
>(function MenuSurface({ submenu, scroll = true, fixed = false, ...props }, forwarded) {
  const ref = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const root = ref.current!;
    if (submenu) placeSubmenu(root, scroll, fixed);
    // A fixed list stays beside its row when the list holding that row
    // scrolls under it.
    const follow = (event: Event) => {
      const t = event.target;
      if (t instanceof Node && t !== root && !root.contains(t) && t.contains(root)) placeSubmenu(root, scroll, fixed);
    };
    if (submenu && fixed) window.addEventListener("scroll", follow, true);
    const opener = document.activeElement as HTMLElement | null;
    if (opener) rememberMenuOrigin(root, opener);
    const buttons = () => Array.from(root.querySelectorAll<HTMLButtonElement>("button"))
      .filter(b => b.closest('[role="menu"]') === root);
    const prepare = () => buttons().forEach(b => {
      b.setAttribute("role", b.hasAttribute("aria-checked") ? "menuitemcheckbox" : "menuitem");
    });
    prepare();
    const observer = new MutationObserver(prepare);
    observer.observe(root, { childList: true, subtree: true });
    buttons().find(b => !b.disabled)?.focus({ preventScroll: true });
    const key = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement).closest('[role="menu"]') !== root) return;
      // Keys typed into a field in the menu are the field's: a recipe's
      // Rename field lost its draft to Down, Up, Home and End, which moved
      // the focus to a row (the 2026-10-10 review).
      const target = event.target as HTMLElement;
      if (target.isContentEditable || target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT") return;
      const items = buttons().filter(b => !b.disabled);
      const at = items.indexOf(document.activeElement as HTMLButtonElement);
      let next: number | null = null;
      if (event.key === "ArrowDown") next = (at + 1) % items.length;
      if (event.key === "ArrowUp") next = (at - 1 + items.length) % items.length;
      if (event.key === "Home") next = 0;
      if (event.key === "End") next = items.length - 1;
      if (next !== null && items[next]) {
        event.preventDefault(); event.stopPropagation();
        // The list scrolls to the focused row by its offsets, never by
        // the focus's own scroll, which inside a CSS zoom lands wrong.
        items[next].focus({ preventScroll: true });
        scrollItemIntoList(root, items[next]);
      }
    };
    root.addEventListener("keydown", key);
    // The wheel scrolls the list and nothing under it: the graph's
    // surface zooms on the wheel, natively, so the event stops here
    // before it can reach it (default kept, so the list itself scrolls).
    const wheel = (event: WheelEvent) => event.stopPropagation();
    root.addEventListener("wheel", wheel, { passive: true });
    return () => {
      observer.disconnect(); root.removeEventListener("keydown", key); root.removeEventListener("wheel", wheel);
      window.removeEventListener("scroll", follow, true);
      // A command may open a dialog before the menu unmounts. Its focus
      // must remain there; return only when the menu still owned focus.
      if (opener?.isConnected && (root.contains(document.activeElement) || document.activeElement === document.body)) opener.focus();
    };
  }, []);
  return <div {...props} role="menu" ref={el => { ref.current = el; if (typeof forwarded === "function") forwarded(el); else if (forwarded) forwarded.current = el; }} />;
});
