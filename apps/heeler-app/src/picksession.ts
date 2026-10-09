import { useLayoutEffect, useRef } from "react";
import { reduce, type Command, type PickArm, type State } from "./state";
import { publishBusy } from "./ui/statusbar";

let nextToken = 0;
let busyOwner: number | null = null;
const signature = (value: unknown) => JSON.stringify(value);

type Read = (state: State) => unknown;
export interface PickAim {
  aim: Read;
  /** Only settings this operation will replace. Compare values, not objects. */
  settings?: Read;
  /** The dropper this session answers through, named as a PICK_ARMS
   * member. Its disarm count ends this session even when the arm's value
   * rides in the aim (a disarm batched with a same-value re-arm leaves
   * the aim unchanged). Other droppers putting themselves away are not
   * aimed at this session and must not cancel it. */
  arm?: PickArm;
}

/** One component's sample sessions. New clicks supersede only their own
 * slot; graph/arm generations also catch delete-and-rearm in one render. */
export class PickSessions {
  private current: State;
  private rendered: State;
  private send: (command: Command) => void;
  private sessions = new Map<string, PickSession>();
  private mounted = true;

  constructor(state: State, dispatch: (command: Command) => void) {
    this.current = this.rendered = state;
    this.send = dispatch;
  }
  update(state: State, dispatch: (command: Command) => void) {
    if (state !== this.rendered) this.current = state;
    this.rendered = state;
    this.send = dispatch;
  }
  state = () => this.current;
  isMounted = () => this.mounted;
  activate() { this.mounted = true; }
  start(slot: string, aim: PickAim): PickSession {
    this.cancel(slot);
    const session = new PickSession(this, aim);
    this.sessions.set(slot, session);
    return session;
  }
  /** The slot's session if it is still ours, else a fresh one: for a
   * hover that samples on every move and must not cancel the sample in
   * flight each time (start() does, by design, for one-shot picks). */
  reuse(slot: string, aim: PickAim): PickSession {
    const live = this.sessions.get(slot);
    if (live && live.stillMine()) return live;
    return this.start(slot, aim);
  }
  cancel(slot: string) { this.sessions.get(slot)?.cancel(); this.sessions.delete(slot); }
  validate() { for (const session of this.sessions.values()) session.stillMine(); }
  dispose() {
    for (const session of this.sessions.values()) session.cancel();
    this.sessions.clear();
    this.mounted = false;
  }
  /** Project our own writes until React delivers the next render. This
   * lets two resolved samples merge in dispatch order, even when batched. */
  sendNow(command: Command) {
    this.current = reduce(this.current, command);
    this.send(command);
  }
}

export class PickSession {
  readonly token = ++nextToken;
  private alive = true;
  private image: string;
  private take: string | undefined;
  private epoch: number;
  private disarms: number | undefined;
  private aimValue: string | undefined;
  private settingsValue: string | undefined;
  private cleanup = new Set<() => void>();
  private gesture = false;

  constructor(private owner: PickSessions, private aim: PickAim) {
    const state = owner.state();
    this.image = state.activeImage;
    this.take = state.activeTakes[this.image];
    this.epoch = state.pickerEpoch ?? 0;
    this.disarms = aim.arm !== undefined ? state.pickerDisarms?.[aim.arm] ?? 0 : undefined;
    this.aimValue = signature(aim.aim(state));
    this.settingsValue = signature(aim.settings?.(state));
  }
  state = () => this.owner.state();
  stillMine = (): boolean => {
    const state = this.state();
    const valid = this.alive && this.owner.isMounted() &&
      state.activeImage === this.image && state.activeTakes[this.image] === this.take &&
      (state.pickerEpoch ?? 0) === this.epoch &&
      (this.disarms === undefined || (state.pickerDisarms?.[this.aim.arm!] ?? 0) === this.disarms) &&
      signature(this.aim.aim(state)) === this.aimValue &&
      signature(this.aim.settings?.(state)) === this.settingsValue &&
      (!this.gesture || state.gestureOwner === this.token);
    if (!valid) this.cancel();
    return valid;
  };
  dispatch = (command: Command): boolean => {
    if (!this.stillMine()) return false;
    this.owner.sendNow(command);
    // Our own writes are allowed to change the settings they protect.
    this.settingsValue = signature(this.aim.settings?.(this.state()));
    return true;
  };
  onCleanup(fn: () => void) { this.cleanup.add(fn); }
  listen(type: string, listener: (event: MouseEvent) => void) {
    const callback = listener as EventListener;
    window.addEventListener(type, callback);
    this.onCleanup(() => window.removeEventListener(type, callback));
  }
  beginGesture(key: string) {
    if (this.dispatch({ type: "begin_gesture", key, owner: this.token })) this.gesture = true;
  }
  endGesture() {
    if (!this.gesture) return;
    this.gesture = false;
    // A delayed end must never end somebody else's newer gesture.
    if (this.owner.isMounted() && this.state().gestureOwner === this.token) {
      this.owner.sendNow({ type: "end_gesture", owner: this.token });
    }
  }
  busy(text: string) {
    busyOwner = this.token;
    publishBusy(text);
    const clear = () => {
      if (busyOwner === this.token) { busyOwner = null; publishBusy(null); }
    };
    this.onCleanup(clear);
    return clear;
  }
  cancel = () => {
    if (!this.alive) return;
    this.alive = false;
    this.endGesture();
    for (const cleanup of this.cleanup) cleanup();
    this.cleanup.clear();
  };
}

export function usePickSessions(state: State, dispatch: (command: Command) => void): PickSessions {
  const ref = useRef<PickSessions | null>(null);
  if (!ref.current) ref.current = new PickSessions(state, dispatch);
  const sessions = ref.current;
  sessions.update(state, dispatch);
  useLayoutEffect(() => { sessions.activate(); return () => sessions.dispose(); }, [sessions]);
  useLayoutEffect(() => { sessions.validate(); });
  return sessions;
}
