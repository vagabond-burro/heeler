// The cross-window transport's delivery rule. Tauri's emit reaches
// every window INCLUDING the sender, where BroadcastChannel (the
// browser transport) never echoes to self. The log store trusted the
// browser rule, so under Tauri every window ingested its own broadcasts
// as duplicates, and the console's replay showed them. "Why
// does the About info print twice in the console?"

import { afterEach, describe, expect, it, vi } from "vitest";

type BusEvent = { payload: unknown };
type Bus = Map<string, ((e: BusEvent) => void)[]>;
// On globalThis so it survives vi.resetModules: each reset simulates a
// separate window importing the same bundle onto the same event bus.
const bus: Bus = ((globalThis as Record<string, unknown>).__testBus as Bus) ?? new Map();
(globalThis as Record<string, unknown>).__testBus = bus;

vi.mock("@tauri-apps/api/event", () => ({
  // Tauri's rule, faithfully: every listener hears every emit, the
  // emitting window's own listeners included.
  emit: async (channel: string, payload: unknown) => {
    for (const fn of bus.get(channel) ?? []) fn({ payload });
  },
  listen: async (channel: string, fn: (e: BusEvent) => void) => {
    const list = bus.get(channel) ?? [];
    list.push(fn);
    bus.set(channel, list);
    return () => {};
  },
}));

const flush = () => new Promise((r) => setTimeout(r, 0));

/** One "window": a fresh copy of the module graph on the shared bus. */
async function windowOnBus() {
  vi.resetModules();
  (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__ = {};
  const { transport, CONSOLE_LOG_CHANNEL } = await import("../popout");
  return { t: transport(), channel: CONSOLE_LOG_CHANNEL };
}

afterEach(() => {
  bus.clear();
  delete (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__;
  vi.resetModules();
});

describe("the Tauri transport's delivery rule", () => {
  it("a window never hears its own sends; its peers hear them once", async () => {
    const a = await windowOnBus();
    const b = await windowOnBus();
    const heardA: unknown[] = [];
    const heardB: unknown[] = [];
    a.t.subscribe(a.channel, (p) => heardA.push(p));
    b.t.subscribe(b.channel, (p) => heardB.push(p));
    await flush(); // let both listeners attach

    a.t.send(a.channel, { entry: "from-a" });
    await flush();
    expect(heardA).toEqual([]);
    expect(heardB).toEqual([{ entry: "from-a" }]);

    b.t.send(b.channel, { entry: "from-b" });
    await flush();
    expect(heardA).toEqual([{ entry: "from-b" }]);
    expect(heardB).toEqual([{ entry: "from-a" }]);
  });

  it("a bare payload from a window without the envelope still arrives", async () => {
    const a = await windowOnBus();
    const heard: unknown[] = [];
    a.t.subscribe(a.channel, (p) => heard.push(p));
    await flush();
    // An older window emits the payload raw, no envelope around it.
    for (const fn of bus.get(a.channel) ?? []) fn({ payload: { entry: "bare" } });
    expect(heard).toEqual([{ entry: "bare" }]);
  });
});
