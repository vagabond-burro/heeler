// The guided tour's spotlight: the window dimmed with a cut-out around
// the current stop, its sentence beside it, and NEXT, BACK and STOP. A
// dimmed overlay with holes in it, not a frame: nothing is drawn around
// the control itself. The dimming takes no clicks, so the control in the
// hole (and anything a step opens, a menu, a palette) works as it always
// does.
//
// Rendered through a portal to the body, outside every .ui-zoom
// wrapper, and positioned from offsets (src/tourgeometry.ts), never
// from client rects inside the zoom. Measured again on resize, on any
// scroll, and on a short interval while a tour runs, since panels move
// as they open. Before a step shows, the panel holding its stop is
// scrolled so the stop sits near the middle, and the card is placed
// where it fits in the window whole (placeCard): beside the stop, else
// on the other side, below or above, clamped inside with a margin. In
// the graph it also keeps clear of the whole node card that owns each
// spotlighted port (nodesOf), both nodes of a wire, measured the same
// way; the card is placed again as the canvas pans or zooms.
//
// While a tour runs and Find a Node is open, however it was opened
// (Shift+Space, the add node button, a menu, OPEN on a way step), the
// palette gets a hole of its own whatever the step points at, so it is
// never dimmed with the rest of the app (2026-09-29: "it would help to
// highlight the 'find node' dialog to emphasize where to type, it was
// darkened like rest of the app"). Its search field has the focus, the
// card keeps clear of it as it does of any hole, and the card says to
// type there.
//
// The tour is not modal to the keyboard (2026-09-29: a step said to
// press Shift+Space and nothing happened, because the card had taken
// the focus and the app's shortcuts stand aside inside a dialog). The
// card takes no focus when a step shows and a click on its buttons
// leaves the focus where it was; the app's key handler lets the card
// (data-tour-card) through; the tour's own key is Escape, heard as it
// bubbles, so a palette or field that keeps its Escape keeps it. Only
// the end card focuses its follow-up field. NEXT, BACK and STOP stay in
// the Tab order.
//
// When the tour ends the card offers Learn more and a field for a
// follow-up question. A question asked here goes into the assistant's
// conversation (src/assistantchat.ts, kept in this window) and its
// answer shows in the Console, which is opened or brought forward.

import React, { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { measure, placeCard, revealInScroller, type Rect } from "../tourgeometry";
import {
  closeTourEnd,
  currentWalk,
  endedTour,
  subscribeTourWalk,
  tourBack,
  tourClicked,
  tourNext,
  tourStop,
  tourWalkVersion,
  type FollowUp,
  type Tour,
} from "../tourwalk";
import { askAndReveal, tourContext } from "../assistantchat";
import { openConsoleWindow } from "../popout";
import { CloseIcon, SendIcon } from "./panelicons";
import type { Command, State } from "../state";

const PAD = 6;
/** The step card's width, and the end card's: wider, for the follow-up
 * field (2026-09-28: "should be wider to support a field for typing in
 * a follow up question").*/
export const CARD_W = 300;
export const END_W = 400;
/** Until the card has been measured: about a step card's height. */
const CARD_H_GUESS = 150;
const MARGIN = 8;
/** An icon chip on the end card: the close cross and the ask arrow. */
const ICON_CHIP: React.CSSProperties = { boxSizing: "border-box", width: 26, height: 20, padding: 0, display: "inline-flex", alignItems: "center", justifyContent: "center" };

function targetsOf(state: State): HTMLElement[] {
  const walk = currentWalk();
  const v = walk?.view();
  if (!v) return [];
  const out: HTMLElement[] = [];
  for (const selector of v.stop.target(state, v.refs)) {
    let el: Element | null = null;
    try {
      el = document.querySelector(selector);
    } catch {
      el = null;
    }
    // Laid out and showing (jsdom lays nothing out, so there any match
    // counts).
    const laidOut = document.body.offsetWidth > 0;
    if (el instanceof HTMLElement && (!laidOut || el.offsetWidth > 0 || el.offsetHeight > 0) && !out.includes(el)) {
      out.push(el);
      // A composite stop (two ports) spotlights both; any other stop,
      // the first that is on screen.
      if (!v.refs.from && !v.refs.to) break;
    }
  }
  return out;
}

/** Find a Node's box while it is open, else null. */
export function paletteOf(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-testid="node-palette"]');
}

/** The node cards that own the spotlighted elements: a port's card, a
 * node step's card itself, one each. The card keeps clear of them. */
export function nodesOf(els: HTMLElement[]): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (const el of els) {
    const card = el.closest<HTMLElement>('.node[data-testid^="node-"]');
    if (card && !out.includes(card)) out.push(card);
  }
  return out;
}

/** The Console, opened or brought forward, for an answer asked from
 * here. A window already open is raised, never loaded again. */
export function showConsole(state: State, dispatch: (cmd: Command) => void): void {
  if (state.consoleWindowOpen) void openConsoleWindow().catch(() => {});
  else dispatch({ type: "set_console_window", open: true });
}

/** A question from the end card: into the conversation, with the tour
 * just walked as its context, answered in the Console. */
export function askAfterTour(question: string, tour: Tour, state: State, dispatch: (cmd: Command) => void): void {
  askAndReveal(question, tourContext(tour));
  showConsole(state, dispatch);
}

export function TourOverlay({ state, dispatch }: { state: State; dispatch: (cmd: Command) => void }) {
  useSyncExternalStore(subscribeTourWalk, tourWalkVersion, tourWalkVersion);
  const walk = currentWalk();
  const view = walk?.view() ?? null;
  const ended = endedTour();
  const [rects, setRects] = useState<Rect[]>([]);
  const [nodeRects, setNodeRects] = useState<Rect[]>([]);
  const [paletteRect, setPaletteRect] = useState<Rect | null>(null);
  const [size, setSize] = useState({ w: window.innerWidth, h: window.innerHeight });
  const [cardH, setCardH] = useState(CARD_H_GUESS);
  const [draft, setDraft] = useState("");
  const revealed = useRef<string>("");
  const stateRef = useRef(state);
  stateRef.current = state;
  const fieldRef = useRef<HTMLInputElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);

  const key = view ? `${view.index}:${view.stop.id}` : "";

  // Measured now and again: panels open and scroll under a tour.
  useEffect(() => {
    if (!view) {
      setRects([]);
      setNodeRects([]);
      setPaletteRect(null);
      return;
    }
    const tick = () => {
      const els = targetsOf(stateRef.current);
      // Once per step, before it is measured: the stop's panel scrolls
      // so it sits near the middle (only when it is near an edge or
      // off screen).
      if (els[0] && revealed.current !== key) {
        revealed.current = key;
        revealInScroller(els[0]);
      }
      const next = els.map((el) => measure(el));
      setRects((was) => (JSON.stringify(was) === JSON.stringify(next) ? was : next));
      const cards = nodesOf(els).map((el) => measure(el));
      setNodeRects((was) => (JSON.stringify(was) === JSON.stringify(cards) ? was : cards));
      const palette = paletteOf();
      const pr = palette ? measure(palette) : null;
      setPaletteRect((was) => (JSON.stringify(was) === JSON.stringify(pr) ? was : pr));
      setSize((was) => (was.w === window.innerWidth && was.h === window.innerHeight ? was : { w: window.innerWidth, h: window.innerHeight }));
    };
    tick();
    const timer = window.setInterval(tick, 250);
    // The graph pans and zooms by transform, which fires no scroll: a
    // wheel or a drag measures again on the next frame, so the card
    // moves with the nodes rather than a quarter second behind.
    let frame = 0;
    const soon = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        tick();
      });
    };
    const onMove = (e: PointerEvent) => {
      if (e.buttons) soon();
    };
    window.addEventListener("resize", tick);
    window.addEventListener("scroll", tick, true);
    window.addEventListener("wheel", soon, { capture: true, passive: true });
    window.addEventListener("pointermove", onMove, { capture: true, passive: true });
    // Typing in Find a Node grows or shrinks its list: its hole follows
    // on the next frame.
    window.addEventListener("input", soon, true);
    return () => {
      window.clearInterval(timer);
      if (frame) window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", tick);
      window.removeEventListener("scroll", tick, true);
      window.removeEventListener("wheel", soon, { capture: true });
      window.removeEventListener("pointermove", onMove, { capture: true });
      window.removeEventListener("input", soon, true);
    };
    // Measured at once when the palette opens or closes, not on the
    // next tick.
  }, [key, !!view, !!state.palette]);

  // The palette opened under a tour: its search field has the focus, so
  // the name is typed there. The palette focuses it itself; this makes
  // sure nothing of the tour's kept it.
  const paletteOpen = !!view && !!state.palette;
  useEffect(() => {
    if (!paletteOpen) return;
    const palette = paletteOf();
    if (palette && !palette.contains(document.activeElement)) {
      palette.querySelector<HTMLInputElement>('[data-testid="palette-search"]')?.focus({ preventScroll: true });
    }
  }, [paletteOpen]);

  // The end card follows the window too.
  useEffect(() => {
    if (view || !ended) return;
    const onResize = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [!!view, !!ended]);

  // The card's own height, measured after each render, so the placement
  // keeps all of it (its NEXT, BACK and STOP row) inside the window.
  useLayoutEffect(() => {
    const h = cardRef.current?.offsetHeight ?? 0;
    if (h > 0 && Math.abs(h - cardH) > 1) setCardH(h);
  });

  // A click anywhere may complete a click stop; Escape stops the tour,
  // or closes the end card. Heard as it bubbles to the window, never in
  // capture and never stopped or prevented: every other key, and an
  // Escape something else keeps (the node palette closing itself), go
  // on exactly as without a tour.
  useEffect(() => {
    if (!walk && !ended) return;
    const onClick = (e: MouseEvent) => tourClicked(e.target instanceof Element ? e.target : null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (currentWalk()) tourStop();
      else if (endedTour()) closeTourEnd();
    };
    document.addEventListener("click", onClick, true);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("click", onClick, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [!!walk, !!ended]);

  // A step card never takes the focus: the canvas keeps it, so the
  // keys a step names work at once. Only the end card's field does, when
  // the tour ends, so a follow-up is typed at once.
  useEffect(() => {
    if (!walk && ended) fieldRef.current?.focus({ preventScroll: true });
  }, [!walk && !!ended, ended?.tour.id]);

  if (!view && !ended) return null;

  const followUp = (f: FollowUp) => {
    if (f.kind === "help" && f.file) dispatch({ type: "open_docs", file: f.file });
    else if (f.question && ended) askAfterTour(f.question, ended.tour, state, dispatch);
    closeTourEnd();
  };

  const askTyped = () => {
    const q = draft.trim();
    if (!q || !ended) return;
    setDraft("");
    askAfterTour(q, ended.tour, state, dispatch);
    closeTourEnd();
  };

  const width = view ? CARD_W : END_W;
  const pad = (r: Rect) => ({ x: r.x - PAD, y: r.y - PAD, w: r.w + PAD * 2, h: r.h + PAD * 2 });
  // The palette is spotlighted whatever the step points at, and the
  // card keeps clear of it like any hole.
  const shown = paletteOpen && paletteRect ? [...rects, paletteRect] : rects;
  const holes = shown.map(pad);
  const { left, top } = placeCard(view ? holes : [], { w: width, h: cardH }, size, { margin: MARGIN, gap: 12, avoid: view ? nodeRects.map(pad) : [] });

  const button: React.CSSProperties = { fontSize: 11, padding: "2px 10px" };

  return createPortal(
    <div data-testid="tour-overlay" style={{ position: "fixed", inset: 0, zIndex: 9000, pointerEvents: "none" }}>
      {view && (
        <svg width={size.w} height={size.h} style={{ position: "absolute", inset: 0 }} aria-hidden focusable="false">
          <defs>
            <mask id="tour-holes">
              <rect x={0} y={0} width={size.w} height={size.h} fill="white" />
              {rects.map((r, i) => (
                <rect key={i} data-testid="tour-hole" x={r.x - PAD} y={r.y - PAD} width={r.w + PAD * 2} height={r.h + PAD * 2} rx={4} fill="black" />
              ))}
              {paletteOpen && paletteRect && (
                <rect data-testid="tour-hole-palette" x={paletteRect.x - PAD} y={paletteRect.y - PAD} width={paletteRect.w + PAD * 2} height={paletteRect.h + PAD * 2} rx={4} fill="black" />
              )}
            </mask>
          </defs>
          <rect x={0} y={0} width={size.w} height={size.h} fill="rgba(0,0,0,.55)" mask="url(#tour-holes)" />
        </svg>
      )}
      <div
        ref={cardRef}
        data-testid="tour-card-box"
        style={{ position: "absolute", left, top, width, pointerEvents: "auto" }}
      >
        <div
          className="ui-zoom"
          role="dialog"
          aria-label="Guided tour"
          data-testid="tour-card"
          data-tour-card=""
          style={{
            background: "var(--bg-panel)",
            boxShadow: "0 12px 34px rgba(0,0,0,.6)",
            padding: "10px 12px",
            width: `calc(${width}px / var(--chrome-zoom))`,
            // Never taller than the window: the sentence scrolls, the
            // buttons stay.
            maxHeight: `calc(${Math.max(120, size.h - MARGIN * 2)}px / var(--chrome-zoom))`,
            display: "flex",
            flexDirection: "column",
            position: "relative",
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              if (currentWalk()) tourStop();
              else closeTourEnd();
            }
          }}
        >
          {view ? (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5, flex: "none" }}>
                <span data-testid="tour-count" style={{ fontSize: 11, fontWeight: 600, letterSpacing: ".12em", color: "var(--accent)" }}>
                  {view.way ? "ON THE WAY" : `STEP ${view.number} OF ${view.total}`}
                </span>
                <span style={{ fontSize: 11, color: "var(--text-ghost)" }}>{view.stop.name}</span>
              </div>
              <div style={{ minHeight: 0, overflowY: "auto" }}>
                <div data-testid="tour-say" role="status" aria-live="polite" style={{ fontSize: 13, lineHeight: 1.5, color: "var(--text-hi)" }}>
                  {view.say}
                </div>
                {view.how && (
                  <div data-testid="tour-how" style={{ fontSize: 12, lineHeight: 1.5, color: "var(--text-body)", marginTop: 4 }}>
                    {view.how}
                  </div>
                )}
                {paletteOpen && (
                  <div data-testid="tour-palette-how" style={{ fontSize: 12, lineHeight: 1.5, color: "var(--accent)", marginTop: 4 }}>
                    Type a few letters of the node's name in Find a Node, then press Enter or click the node.
                  </div>
                )}
                {rects.length === 0 && !paletteOpen && (
                  <div data-testid="tour-offscreen" style={{ fontSize: 12, lineHeight: 1.5, color: "var(--text-ghost)", marginTop: 4 }}>
                    Not on screen right now. NEXT goes on without it.
                  </div>
                )}
              </div>
              {/* A click on these leaves the focus where it was (the
                  canvas), so a shortcut pressed next reaches the app;
                  Tab still reaches them. */}
              <div data-testid="tour-buttons" style={{ display: "flex", gap: 6, marginTop: 9, flex: "none" }} onMouseDown={(e) => e.preventDefault()}>
                <button type="button" className="chip" data-testid="tour-next" aria-label="Next step" data-hint={view.way ? "Opens this for you" : "Goes on to the next step"} style={button} onClick={tourNext}>
                  {view.way && view.stop.open ? "OPEN" : "NEXT"}
                </button>
                <button type="button" className="chip" data-testid="tour-back" aria-label="Previous step" data-hint="Goes back one step" style={button} disabled={!view.canBack} onClick={tourBack}>
                  BACK
                </button>
                <button type="button" className="chip" data-testid="tour-stop" aria-label="Stop the tour" data-hint="Ends the tour (Escape)" style={button} onClick={tourStop}>
                  STOP
                </button>
              </div>
            </>
          ) : ended ? (
            <>
              {/* 2026-09-29: "The close button should be an [X] in the top right
corner and ask should be an icon, this would make more room for the
follow prompt."*/}
              <button
                type="button"
                className="chip"
                data-testid="tour-close"
                aria-label="Close"
                data-hint="Closes this card (Escape)"
                style={{ ...ICON_CHIP, position: "absolute", top: 6, right: 6 }}
                onClick={closeTourEnd}
              >
                <CloseIcon />
              </button>
              <div data-testid="tour-end" role="status" aria-live="polite" style={{ fontSize: 13, lineHeight: 1.5, color: "var(--text-hi)", marginBottom: 6, paddingRight: 30, flex: "none" }}>
                {ended.status === "finished" ? "That is the whole tour." : "Tour stopped."}
                {ended.tour.followUps.length > 0 ? " Learn more:" : ""}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 5, alignItems: "flex-start", minHeight: 0, overflowY: "auto" }}>
                {ended.tour.followUps.map((f, i) => (
                  <button
                    type="button"
                    key={i}
                    className="chip"
                    data-testid={`tour-follow-${i}`}
                    data-hint={f.kind === "help" ? "Opens this chapter of the user guide" : "Asks the assistant this question; the answer shows in the Console"}
                    style={{ ...button, textAlign: "left", fontSize: 12 }}
                    onClick={() => followUp(f)}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
              {/* The field takes the whole row; the ask icon sits at its
                  end, inside it. */}
              <div data-testid="tour-follow-row" style={{ position: "relative", marginTop: 9, flex: "none", width: "100%" }}>
                <input
                  ref={fieldRef}
                  type="text"
                  data-testid="tour-follow-field"
                  aria-label="Ask a follow-up question"
                  data-hint="Type a question; Enter asks, and the answer shows in the Console, in the same conversation"
                  placeholder="Ask a follow-up..."
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      askTyped();
                    }
                  }}
                  style={{ boxSizing: "border-box", width: "100%", background: "var(--bg-app)", border: "1px solid var(--line-4)", color: "var(--text-body)", fontSize: 13, padding: "4px 34px 4px 7px", outline: "none", fontFamily: "inherit" }}
                />
                <button
                  type="button"
                  className="chip"
                  data-testid="tour-follow-ask"
                  aria-label="Ask"
                  data-hint="Asks the assistant; the answer shows in the Console"
                  style={{ ...ICON_CHIP, position: "absolute", top: "50%", right: 3, transform: "translateY(-50%)" }}
                  disabled={!draft.trim()}
                  onClick={askTyped}
                >
                  <SendIcon />
                </button>
              </div>
            </>
          ) : null}
        </div>
      </div>
    </div>,
    document.body,
  );
}
