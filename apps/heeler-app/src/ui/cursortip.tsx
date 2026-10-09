// The name at the pointer. An icon-only control needs its name AT the
// icon ("a tool tip should appear with the name of the
// control"), and the panel tabs' bespoke tooltip guessed its position
// from a hardcoded tab width and missed ("the tool tips
// do not align with the tab I am mousing over"). One mechanism now:
// any element carrying data-tip grows a small name chip beside the
// cursor, and the chip measures itself against the window so it never
// clips at an edge. The status-line hint (data-hint) still carries
// the longer WHAT-IT-DOES sentence; data-tip is only the name.

import { useEffect, useRef, useState } from "react";

const DELAY_MS = 250;
const OFFSET = 13;

export function CursorTip() {
  const [tip, setTip] = useState<{ text: string; x: number; y: number; below: boolean } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const armed = useRef<{ text: string; below: boolean } | null>(null);
  // The pointer's latest position while a tip is armed: the delay
  // fires 250ms after the mouseover that ARMED it, and appearing at
  // that stale spot (a control's edge, usually) misplaces the chip
  // the cursor has already left.
  const pointerAt = useRef({ x: 0, y: 0 });

  useEffect(() => {
    const clear = () => {
      if (timer.current !== undefined) window.clearTimeout(timer.current);
      timer.current = undefined;
      armed.current = null;
      setTip(null);
    };
    const onOver = (e: MouseEvent) => {
      const el =
        e.target instanceof Element ? e.target.closest("[data-tip]") : null;
      const text = el?.getAttribute("data-tip") ?? null;
      if (!text) {
        clear();
        return;
      }
      // Below the pointer on request (the graph's ports: the owner, "a
      // tooltip below the mouse"), above it otherwise, so the cursor never
      // sits on the name of the control it is over.
      const below = !!el?.hasAttribute("data-tip-below");
      pointerAt.current = { x: e.clientX, y: e.clientY };
      if (armed.current?.text === text) return;
      clear();
      armed.current = { text, below };
      timer.current = window.setTimeout(() => {
        timer.current = undefined;
        // The CURRENT pointer position, not the arming one's.
        if (armed.current?.text === text) setTip({ text, below, ...pointerAt.current });
      }, DELAY_MS) as unknown as number;
    };
    const onMove = (e: MouseEvent) => {
      pointerAt.current = { x: e.clientX, y: e.clientY };
      if (!armed.current) return;
      setTip((t) => (t ? { ...t, x: e.clientX, y: e.clientY } : t));
    };
    // Keyboard reach: focusing a named control shows its name at the
    // control (there is no cursor to follow), so a keyboard user sees
    // what a mouse user sees.
    const onFocus = (e: FocusEvent) => {
      const el =
        e.target instanceof Element ? e.target.closest("[data-tip]") : null;
      const text = el?.getAttribute("data-tip");
      if (!text || !el) {
        clear();
        return;
      }
      const r = el.getBoundingClientRect();
      const below = el.hasAttribute("data-tip-below");
      armed.current = { text, below };
      setTip({ text, below, x: r.left, y: r.bottom });
    };
    document.addEventListener("mouseover", onOver);
    document.addEventListener("mousemove", onMove);
    document.addEventListener("focusin", onFocus);
    document.addEventListener("mouseleave", clear);
    window.addEventListener("blur", clear);
    return () => {
      document.removeEventListener("mouseover", onOver);
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("focusin", onFocus);
      document.removeEventListener("mouseleave", clear);
      window.removeEventListener("blur", clear);
      clear();
    };
  }, []);

  if (!tip) return null;
  // Clamp against the window's edges: measured when available, a
  // sane estimate on the first frame before the ref lands.
  const w = box.current?.offsetWidth ?? tip.text.length * 7 + 18;
  const h = box.current?.offsetHeight ?? 20;
  const left = Math.min(tip.x + 8, window.innerWidth - w - 6);
  // ABOVE the pointer by default: below, the cursor itself sat on the name
  // ("they are coming in below and getting clipped off by the
  // mouse"). Only a control at the very top of the window flips it
  // underneath. Below on request, above otherwise; either way, never off
  // the window.
  const fitsBelow = tip.y + OFFSET + h < window.innerHeight - 6;
  const fitsAbove = tip.y - h - 10 >= 6;
  const top = tip.below ? (fitsBelow || !fitsAbove ? tip.y + OFFSET : tip.y - h - 10) : fitsAbove ? tip.y - h - 10 : tip.y + OFFSET;
  return (
    <div
      ref={box}
      data-testid="cursor-tip"
      role="tooltip"
      style={{
        position: "fixed",
        left,
        top,
        zIndex: 90,
        pointerEvents: "none",
        whiteSpace: "nowrap",
        background: "var(--bg-app)",
        border: "1px solid var(--line-4)",
        color: "var(--text-body)",
        // 1.15x the status-row size, 's read while testing.
        fontSize: 10.4,
        letterSpacing: ".08em",
        textTransform: "uppercase",
        padding: "3.5px 8px",
        boxShadow: "0 4px 12px rgba(0,0,0,.45)",
      }}
    >
      {tip.text}
    </div>
  );
}
