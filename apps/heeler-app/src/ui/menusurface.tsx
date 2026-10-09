import { rememberMenuOrigin } from "./focusreturn";
import React, { forwardRef, useLayoutEffect, useRef } from "react";
import { clipBox, pxBox, scrollItemIntoList } from "./hooks";

/** The gap a submenu keeps from the edge of the room it has. */
const PAD = 6;

/** Places a submenu beside the row that opened it, inside the room it
 * has: the window cut by every ancestor that clips (the graph's surface
 * clips its context menu), all measured by pxBox and clipBox, so a menu
 * inside a `.ui-zoom` box (the menubar) is measured by offsets rather
 * than by client rects (the ui-zoom trap).
 *
 * It opens to the right, or to the left when the right has no room. A
 * list taller than the room scrolls rather than losing its tail
 * (2026-10-01: "I can see someone with a small window layout not
 * seeing all the nodes"); `scroll` is off for lists whose rows are
 * themselves flyouts, which a scrolling list would clip.
 *
 * `fixed` pins the list to the window instead of its row: no ancestor's
 * overflow clips a fixed box, so its room is the whole window and the
 * list it hangs from may scroll without cutting it away. Only for menus
 * outside every CSS zoom (the graph's, portaled to the body), where
 * window pixels are its CSS pixels. Exported for the tests. */
export function placeSubmenu(root: HTMLElement, scroll: boolean, fixed = false): void {
  const anchor = root.parentElement;
  if (!anchor) return;
  const a = pxBox(anchor);
  const z = a.z || 1;
  const c = fixed
    ? { top: 0, left: 0, bottom: window.innerHeight, right: window.innerWidth }
    : clipBox(root);
  if (fixed) root.style.position = "fixed";
  root.style.maxHeight = "";
  root.style.overflowY = "";
  const room = Math.max(0, c.bottom - c.top - 2 * PAD);
  let h = root.offsetHeight * z;
  if (scroll && h > room) {
    root.style.maxHeight = `${room / z}px`;
    root.style.overflowY = "auto";
    h = Math.min(h, room);
  }
  const w = root.offsetWidth * z;
  const x = a.right + w > c.right - PAD ? Math.max(c.left + PAD, a.left - w) : a.right;
  const y = Math.max(c.top + PAD, Math.min(a.top, c.bottom - h - PAD));
  // Fixed: window pixels over the zoom. Otherwise left and top are in
  // the anchor's CSS units, which wear its zoom.
  root.style.left = `${(fixed ? x : x - a.left) / z}px`;
  root.style.top = `${(fixed ? y : y - a.top) / z}px`;
}

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
