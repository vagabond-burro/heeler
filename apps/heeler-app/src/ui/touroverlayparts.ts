// touroverlay.tsx's values and helpers that are not components, kept apart so
// touroverlay.tsx exports components alone and Vite can refresh it in place as
// it is edited instead of reloading the window.
import { type Tour } from "../tourwalk";
import { askAndReveal, tourContext } from "../assistantchat";
import { openConsoleWindow } from "../popout";
import type { Command, State } from "../state";

/** The step card's width, and the end card's: wider, for the follow-up
 * field (2026-09-28: "should be wider to support a field for typing in
 * a follow up question").*/
export const CARD_W = 300;

export const END_W = 400;

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
