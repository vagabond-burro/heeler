// Walking a guided tour, in the main window, where the controls are.
// The Console's Assistant tab asks for a tour and the model chooses its
// stops (src/tour.ts); this module walks them: for each step it finds
// the stop's element, and when a place on the way is not open (another
// workspace, a closed tab, a folded section) it first shows that place
// as its own step. It then waits for the stop's completing change and
// moves on. NEXT, BACK and STOP are always there; a stop already done
// is skipped; Escape stops.
//
// A tour never changes the edit. The only commands it dispatches are
// the ones in VIEW_COMMANDS (a mode, a tab, a section unfolded, a panel
// shown), and only when NEXT is pressed on a way step, to open that
// place for the user.

import type { Command, State } from "./state";
import { STOP_BY_ID, VIEW_COMMANDS, type StepRefs, type TourStop } from "./tourstops";
import type { Transport } from "./popout";

/** A step as the model chose it and Heeler checked it (src/tour.ts). */
export interface TourStep extends StepRefs {
  stop: string;
  /** one sentence: what to do here */
  say: string;
}

export interface FollowUp {
  label: string;
  /** "help" opens a guide chapter; "ask" asks the assistant */
  kind: "help" | "ask";
  file?: string;
  question?: string;
}

export interface Tour {
  id: string;
  question: string;
  steps: TourStep[];
  /** Learn more, offered at the end (src/tour.ts, learnMore) */
  followUps: FollowUp[];
}

/** What the overlay shows for the current step. */
export interface WalkView {
  /** the step's place in the tour as the model wrote it */
  index: number;
  /** its number as the user counts: steps already done when they were
   * reached are left out, so a tour that starts two steps in reads
   * "Step 1" (2026-09-28: "When I clicked show me it started on step
   * 3")*/
  number: number;
  /** the steps the user sees in all: those shown so far and those still
   * to do, counted again as the state changes */
  total: number;
  /** a step shown before this one to go BACK to */
  canBack: boolean;
  /** the stop pointed at: the step's own, or a place on the way to it */
  stop: TourStop;
  /** the words beside it */
  say: string;
  /** the stop's own instruction under them (TourStop.how), the same
   * every run; absent on a way step, whose words are the stop's own */
  how?: string;
  /** a place on the way, shown before the step itself */
  way: boolean;
  /** the step's refs, for a composite stop's two ports */
  refs: StepRefs;
}

export type WalkStatus = "running" | "finished" | "stopped";

export interface TourHost {
  getState(): State;
  dispatch(cmd: Command): void;
}

/** One tour being walked. Pure over its host: the state comes from
 * getState, the only writes are view commands through dispatch, and
 * the document is passed in so tests can hand it one. */
export class TourWalk {
  readonly tour: Tour;
  index = 0;
  status: WalkStatus = "running";
  /** the state when the current step began: completion is a change
   * from it */
  private at: State;
  /** whether the current step was already done when it began (arrived
   * at by BACK): it then waits for NEXT, or for a fresh change */
  private arrivedDone = false;
  /** the steps skipped as already done, for the tests and the record */
  readonly skipped: number[] = [];
  private readonly skippedSet = new Set<number>();
  /** the steps that have been the current step */
  private readonly shown = new Set<number>();
  private readonly host: TourHost;
  private readonly doc: () => Document | null;

  constructor(tour: Tour, host: TourHost, doc: () => Document | null = () => (typeof document === "undefined" ? null : document)) {
    this.tour = tour;
    this.host = host;
    this.doc = doc;
    this.at = host.getState();
    this.settle(true);
  }

  private stopAt(i: number): TourStop | undefined {
    const step = this.tour.steps[i];
    return step ? STOP_BY_ID.get(step.stop) : undefined;
  }

  /** Whether a stop is done in this state: its test against the state
   * it began in, or for a way stop against itself. Clicks and NEXT are
   * never "already done". */
  private isDone(stop: TourStop, s: State, at: State, refs: StepRefs): boolean {
    const d = stop.done;
    if (d.kind === "state") return d.test(s, at, refs);
    if (d.kind === "dom") {
      const doc = this.doc();
      return !!doc && d.test(doc);
    }
    return false;
  }

  /** The first place on the way to the current step that is not open. */
  private wayStop(s: State): TourStop | null {
    const stop = this.stopAt(this.index);
    if (!stop) return null;
    for (const id of stop.via) {
      const v = STOP_BY_ID.get(id);
      if (!v) continue;
      if (v.done.kind === "state" || v.done.kind === "dom") {
        if (!this.isDone(v, s, s, {})) return v;
      }
    }
    return null;
  }

  /** Whether step i is already done in this state, as settle judges it
   * on arrival. */
  private alreadyDone(i: number, s: State): boolean {
    const stop = this.stopAt(i);
    const step = this.tour.steps[i];
    if (!stop || !step) return false;
    return stop.done.kind === "state" && stop.done.test(s, s, { from: step.from, to: step.to });
  }

  /** The user's count: a step's number leaves out every step before it
   * that was passed over unseen; the total is the steps before this one
   * that were shown, this one, and the ones after it still to do (a
   * step shown before, reached again after BACK, keeps its place). */
  private counts(s: State): { number: number; total: number; canBack: boolean } {
    let before = 0;
    for (let j = 0; j < this.index; j++) if (!this.unseen(j)) before++;
    let after = 0;
    for (let k = this.index + 1; k < this.tour.steps.length; k++) {
      if (this.shown.has(k) || !this.alreadyDone(k, s)) after++;
    }
    return { number: before + 1, total: before + 1 + after, canBack: before > 0 };
  }

  /** Passed over as already done and never shown. */
  private unseen(i: number): boolean {
    return this.skippedSet.has(i) && !this.shown.has(i);
  }

  view(): WalkView | null {
    if (this.status !== "running") return null;
    const step = this.tour.steps[this.index];
    const stop = this.stopAt(this.index);
    if (!step || !stop) return null;
    const s = this.host.getState();
    const count = this.counts(s);
    const way = this.wayStop(s);
    if (way) {
      return {
        index: this.index,
        ...count,
        stop: way,
        say: way.way?.(s) ?? `First, open ${way.name}.`,
        way: true,
        refs: {},
      };
    }
    return {
      index: this.index,
      ...count,
      stop,
      say: step.say,
      ...(stop.how ? { how: stop.how(s) } : {}),
      way: false,
      refs: { from: step.from, to: step.to },
    };
  }

  /** Moves past steps already done, from the current one on (arriving
   * forward only: a step reached by BACK waits). */
  private settle(forward: boolean): void {
    const s = this.host.getState();
    this.at = s;
    this.arrivedDone = false;
    while (this.index < this.tour.steps.length) {
      const stop = this.stopAt(this.index);
      const step = this.tour.steps[this.index];
      if (!stop) break;
      const already = stop.done.kind === "state" && stop.done.test(s, s, { from: step.from, to: step.to });
      if (!already) break;
      if (!forward) {
        this.arrivedDone = true;
        break;
      }
      // A step the user has already seen keeps its number; only one
      // passed over unseen leaves the count.
      if (!this.shown.has(this.index) && !this.skippedSet.has(this.index)) {
        this.skipped.push(this.index);
        this.skippedSet.add(this.index);
      }
      this.index++;
    }
    if (this.index >= this.tour.steps.length) this.status = "finished";
    else this.shown.add(this.index);
  }

  private advance(): void {
    this.index++;
    this.settle(true);
  }

  /** The app's state moved: a way step may have opened, or the step
   * may be done. */
  onState(): void {
    if (this.status !== "running") return;
    const s = this.host.getState();
    // The step's own change counts even when a place on its way has
    // closed since: picking a node in the palette closes the palette,
    // and the node added is the step done (seen in the browser build).
    const stop = this.stopAt(this.index);
    const step = this.tour.steps[this.index];
    if (!stop || !step) return;
    const refs = { from: step.from, to: step.to };
    if (stop.done.kind === "state") {
      const now = stop.done.test(s, this.at, refs);
      // A step reached by BACK that was already done waits for a
      // change: it completes when its test turns true against a state
      // where it was false, which the arrival state was not.
      if (now && !this.arrivedDone) this.advance();
      else if (!now && this.arrivedDone) {
        this.arrivedDone = false;
        this.at = s;
      }
    } else if (stop.done.kind === "dom") {
      const doc = this.doc();
      if (doc && stop.done.test(doc)) this.advance();
    }
  }

  /** A click landed on this element: a click stop is done when it lands
   * on the stop's own element. */
  onClick(target: Element | null): void {
    if (this.status !== "running" || !target) return;
    const v = this.view();
    if (!v || v.way || v.stop.done.kind !== "click") return;
    const doc = this.doc();
    if (!doc) return;
    const s = this.host.getState();
    for (const selector of v.stop.target(s, v.refs)) {
      const el = doc.querySelector(selector);
      if (el && (el === target || el.contains(target))) {
        this.advance();
        return;
      }
    }
  }

  /** NEXT: on a way step, open that place (view commands only); on a
   * step, go on as if it were done. */
  next(): void {
    if (this.status !== "running") return;
    const s = this.host.getState();
    const way = this.wayStop(s);
    if (way) {
      const cmds = way.open?.(s) ?? [];
      if (cmds.length > 0) {
        for (const c of cmds) this.dispatchView(c);
        return;
      }
    }
    this.advance();
  }

  /** BACK goes to the step shown before this one: a step passed over
   * unseen (done before the tour reached it) is not offered. */
  back(): void {
    if (this.status !== "running") return;
    let i = this.index - 1;
    while (i >= 0 && this.unseen(i)) i--;
    if (i < 0) return;
    this.index = i;
    this.settle(false);
  }

  stop(): void {
    if (this.status === "running") this.status = "stopped";
  }

  /** Every command a tour sends goes through here, and only a view
   * command passes. */
  private dispatchView(cmd: Command): void {
    if (!VIEW_COMMANDS.has(cmd.type)) return;
    this.host.dispatch(cmd);
  }
}

// -- the main window's walk ---------------------------------------------------------

let host: TourHost | null = null;
let walk: TourWalk | null = null;
let walkVersion = 0;
const listeners = new Set<() => void>();
/** A finished or stopped walk's end card, kept until closed. */
let ended: { tour: Tour; status: WalkStatus } | null = null;

function notify(): void {
  walkVersion++;
  for (const fn of listeners) fn();
}

export function subscribeTourWalk(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function tourWalkVersion(): number {
  return walkVersion;
}

export function currentWalk(): TourWalk | null {
  return walk;
}

export function endedTour(): { tour: Tour; status: WalkStatus } | null {
  return ended;
}

/** app.tsx hands over the state and dispatch while the window lives. */
export function setTourHost(next: TourHost | null): void {
  host = next;
  if (!next && walk) {
    walk.stop();
    walk = null;
    notify();
  }
}

export function tourHostForTests(): TourHost | null {
  return host;
}

/** The app's state, when this window walks tours (the main window):
 * what a tour is planned against (src/tour.ts, repairPlan), read, never
 * written. */
export function tourHostState(): State | null {
  return host?.getState() ?? null;
}

/** A walk's status as it is told to whoever listens. steps, with
 * "running" when the walk starts: the steps the user will see,
 * counted as the walk counts them (the steps already done in the main
 * window's state at that moment left out), so the Console says the
 * same number as the card (2026-09-29: "went down to 5 steps and was
 * accurate, but in the prompt window it still read 8 steps").*/
export type StatusListener = (id: string, status: WalkStatus, steps?: number) => void;

let statusOut: StatusListener | null = null;

const statusHere = new Set<StatusListener>();

/** This window hearing its own walks' status (src/assistantchat.ts keeps
 * it with the conversation). */
export function onTourStatus(fn: StatusListener): () => void {
  statusHere.add(fn);
  return () => statusHere.delete(fn);
}

function tell(id: string, status: WalkStatus, steps?: number): void {
  statusOut?.(id, status, steps);
  for (const fn of statusHere) fn(id, status, steps);
}

function report(): void {
  if (!walk) return;
  if (walk.status !== "running") {
    ended = { tour: walk.tour, status: walk.status };
    tell(walk.tour.id, walk.status);
    walk = null;
  }
  notify();
}

/** Starts a tour here, replacing any tour already running. */
export function startTourHere(tour: Tour): boolean {
  if (!host) return false;
  walk?.stop();
  ended = null;
  walk = new TourWalk(tour, host);
  // The count the card starts with: STEP 1 OF this.
  tell(tour.id, "running", walk.view()?.total ?? 0);
  report();
  return true;
}

/** The app's state changed (app.tsx calls this after each render). */
export function tourStateChanged(): void {
  if (!walk) return;
  const before = `${walk.index} ${walk.status}`;
  walk.onState();
  if (`${walk.index} ${walk.status}` !== before) report();
  else notify();
}

export function tourClicked(target: Element | null): void {
  if (!walk) return;
  const before = walk.index;
  walk.onClick(target);
  if (walk.index !== before || walk.status !== "running") report();
}

export function tourNext(): void {
  walk?.next();
  report();
}

export function tourBack(): void {
  walk?.back();
  report();
}

export function tourStop(): void {
  walk?.stop();
  report();
}

export function closeTourEnd(): void {
  ended = null;
  notify();
}

export function resetToursForTests(): void {
  walk = null;
  ended = null;
  host = null;
  statusIn.clear();
  stepsIn.clear();
  notify();
}

// -- between the Console and the main window ------------------------------------------

const START = "heeler:tour-start";
const STATUS = "heeler:tour-status";

let tourTransport: Transport | null = null;
const statusIn = new Map<string, WalkStatus>();
const stepsIn = new Map<string, number>();
const statusListeners = new Set<() => void>();

/** A tour's status as the Console last heard it. */
export function tourStatus(id: string): WalkStatus | null {
  return statusIn.get(id) ?? null;
}

/** A running tour's step count as the main window counted it at the
 * start, when the Console heard it. */
export function tourSteps(id: string): number | null {
  return stepsIn.get(id) ?? null;
}

export function subscribeTourStatus(fn: () => void): () => void {
  statusListeners.add(fn);
  return () => statusListeners.delete(fn);
}

function heardStatus(id: string, status: WalkStatus, steps?: number): void {
  statusIn.set(id, status);
  if (typeof steps === "number") stepsIn.set(id, steps);
  for (const fn of statusListeners) fn();
}

export function connectTours(role: "main" | "console", transport: Transport, opts: { onStart?: () => void } = {}): () => void {
  if (role === "main") {
    statusOut = (id, status, steps) => transport.send(STATUS, { id, status, ...(typeof steps === "number" ? { steps } : {}) });
    const off = transport.subscribe(START, (tour: Tour) => {
      // The tour walks here, and its keys are pressed here: this
      // window comes forward (app.tsx passes raiseThisWindow).
      if (tour && Array.isArray(tour.steps) && startTourHere(tour)) opts.onStart?.();
    });
    return () => {
      off();
      statusOut = null;
    };
  }
  tourTransport = transport;
  const offStatus = transport.subscribe(STATUS, (m: { id: string; status: WalkStatus; steps?: number }) => {
    if (m && typeof m.id === "string") heardStatus(m.id, m.status, typeof m.steps === "number" ? m.steps : undefined);
  });
  return () => {
    offStatus();
    if (tourTransport === transport) tourTransport = null;
  };
}

/** SHOW ME: the Console asks the main window to walk the tour. */
export function requestTour(tour: Tour): void {
  heardStatus(tour.id, "running");
  tourTransport?.send(START, tour);
}
