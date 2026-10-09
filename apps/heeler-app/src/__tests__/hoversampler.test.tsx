// Tests ahead of the 26.4.3 refactor (the refactoring ledger): the three
// eyedropper hover ghosts in the viewer (the B&W hue curve's, Recolor's
// and the Color Set's) each drive the same sampler by hand. One sample
// in flight, the newest position waiting its turn, at most one sample
// every 40 ms, the queued position taken when the window closes, and
// leaving, pressing, disarming and unmounting each dropping what waits.
// These pin that flow at all three sites against the code as it stands,
// including where the sites differ (what keeps a held button quiet, and
// whether a move after leaving resumes), so the shared sampler can
// replace the copies with nothing a user sees changing.
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initialState } from "../data";
import { reduce, type Command, type State } from "../state";
import { Viewer } from "../ui/viewer";

type Sample = { r: number; g: number; b: number; luma: number; luma_linear: number; hue: number; sat: number };
const pending: { resolve: (sample: Sample) => void; reject: (error: Error) => void }[] = [];
const warm: Sample = { r: 0.6, g: 0.25, b: 0.15, luma: 0.4, luma_linear: 0.4, hue: 30, sat: 0.4 };
vi.mock("../bridge", async (original) => {
  const { lookupOf } = await import("./lookupmock");
  return {
  ...await original<Record<string, unknown>>(),
  sampleImage: vi.fn(() => new Promise<Sample>((resolve, reject) => pending.push({ resolve, reject }))),
  curveLookup: vi.fn((_s: unknown, _n: string, _x: number, _y: number, kind: "tone" | "around") => new Promise((resolve, reject) => pending.push({ resolve: (smp: Sample) => resolve(lookupOf(smp, kind)), reject }))),
  depthAt: vi.fn(() => new Promise<number>(() => {})),
  depthMap: vi.fn(() => new Promise(() => {})),
};
});
import { curveLookup, sampleImage } from "../bridge";

const run = (s: State, ...commands: Command[]) => commands.reduce(reduce, s);

interface Site {
  overlay: string;
  hover: Command["type"];
  /** The command that puts the ghost away. */
  cleared: Command;
  armed: () => State;
  disarm: Command;
  /** Whether a move made after leaving, while the old sample is still
   * out, is sampled when that sample lands. Recolor's restart asks the
   * old (canceled) session, so it waits for the next move. */
  resumesAfterLeave: boolean;
  /** What keeps the hover quiet while the button is down: the site's own
   * drag flag, set by its press, or the move's held button (the Color
   * Set, whose press-and-hold sweep samples on its own). */
  heldGate: "drag" | "button";
}
const SITES: Record<string, Site> = {
  "the hue curve": {
    overlay: "bw-pick-overlay",
    hover: "set_bw_hover",
    cleared: { type: "set_bw_hover", hue: null },
    armed: () => run(initialState(), { type: "toggle_bw_pick" }),
    disarm: { type: "toggle_bw_pick" },
    resumesAfterLeave: true,
    heldGate: "drag",
  },
  Recolor: {
    overlay: "recolor-pick-overlay",
    hover: "set_recolor_hover",
    cleared: { type: "set_recolor_hover", x: null },
    armed: () => run(initialState(), { type: "set_category", title: "Recolor", on: true }, { type: "toggle_recolor_pick", id: "recolor" }),
    disarm: { type: "toggle_recolor_pick", id: "recolor" },
    resumesAfterLeave: false,
    heldGate: "drag",
  },
  // Relight's ghost (2026-10-08: "I am not getting the ghost on the
  // relight curve with the eyedropper"), the same sampler as the rest.
  Relight: {
    overlay: "tone-eq-pick-overlay",
    hover: "set_tone_eq_hover",
    cleared: { type: "set_tone_eq_hover", x: null },
    armed: () => run(initialState(), { type: "set_category", title: "Relight", on: true }, { type: "toggle_tone_eq_pick", id: "toneeq" }),
    disarm: { type: "toggle_tone_eq_pick", id: "toneeq" },
    resumesAfterLeave: false,
    heldGate: "drag",
  },
  "the Color Set": {
    overlay: "cset-dropper-overlay",
    hover: "set_cset_hover",
    cleared: { type: "set_cset_hover", hue: null },
    armed: () => run(initialState(), { type: "add_color_set" }, { type: "arm_cset_dropper", n: 1 }),
    disarm: { type: "arm_cset_dropper", n: null },
    resumesAfterLeave: true,
    heldGate: "button",
  },
};

function pane(state: State, commands: Command[]) {
  return <Viewer state={state} dispatch={(c) => commands.push(c)} previewUrl="data:image/png;base64,x"
    previewError={null} previewMs={null} previewBackend={null} originalUrl={null} maskUrl={null} multiFrames={{}} />;
}

// The throttle reads performance.now(); the clock is held and moved by
// hand, and the window's timer runs on fake timers.
let clock = 1000;
beforeEach(() => {
  pending.length = 0;
  vi.mocked(sampleImage).mockClear();
  vi.mocked(curveLookup).mockClear();
  clock = 1000;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

for (const [name, site] of Object.entries(SITES)) {
  describe(`${name}'s hover sampler`, () => {
    const mount = (state = site.armed()) => {
      const commands: Command[] = [];
      const view = render(pane(state, commands));
      const overlay = () => screen.getByTestId(site.overlay);
      // A 100 by 100 picture at the origin: clientX 30 is x 0.3.
      vi.spyOn(overlay(), "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100, x: 0, y: 0, toJSON: () => ({}) } as DOMRect);
      const move = (x: number, init: MouseEventInit = {}) => fireEvent.mouseMove(overlay(), { clientX: x, clientY: 50, ...init });
      return { commands, view, overlay, move };
    };
    // Relight reads the engine's lookup (curveLookup), the others a
    // color patch (sampleImage); a site uses one or the other.
    const xs = () => [
      ...vi.mocked(sampleImage).mock.calls.map((c) => c[1]),
      ...vi.mocked(curveLookup).mock.calls.map((c) => c[2]),
    ].map((x) => Math.round(x * 100) / 100);
    const land = async (i: number, sample = warm) => { await act(async () => { pending[i].resolve(sample); }); };
    const fail = async (i: number) => { await act(async () => { pending[i].reject(new Error("no engine")); }); };
    const ghosts = (commands: Command[]) => commands.filter((c) => c.type === site.hover);
    const tick = async (ms: number) => { await act(async () => { clock += ms; vi.advanceTimersByTime(ms); }); };

    it("samples the first move at once and paints its answer", async () => {
      const { commands, move } = mount();
      move(10);
      expect(xs()).toEqual([0.1]);
      await land(0);
      expect(ghosts(commands)).toHaveLength(1);
    });

    it("holds only the newest position while a sample is out, and takes it when the sample lands", async () => {
      const { move } = mount();
      move(10);
      clock += 100; move(20);
      clock += 100; move(30);
      expect(xs()).toEqual([0.1]);
      await land(0);
      expect(xs()).toEqual([0.1, 0.3]);
      await land(1);
      expect(xs()).toEqual([0.1, 0.3]);
    });

    it("takes a position queued inside the 40 ms window when the window closes, once, at the latest position", async () => {
      const { move } = mount();
      move(10);
      await land(0);
      clock += 10; move(20);
      clock += 10; move(30);
      expect(xs()).toEqual([0.1]);
      await tick(29);
      expect(xs()).toEqual([0.1]);
      await tick(1);
      expect(xs()).toEqual([0.1, 0.3]);
      await land(1);
      await tick(200);
      expect(xs()).toEqual([0.1, 0.3]);
    });

    it("the window's sample opens a window of its own: the next move inside it waits", async () => {
      const { move } = mount();
      move(10);
      await land(0);
      clock += 10; move(20);
      await tick(30);
      expect(xs()).toEqual([0.1, 0.2]);
      await land(1);
      clock += 10; move(30);
      expect(xs()).toEqual([0.1, 0.2]);
      await tick(30);
      expect(xs()).toEqual([0.1, 0.2, 0.3]);
    });

    it("the window closes on a queued position every time, not only the first", async () => {
      const { move } = mount();
      move(10);
      await land(0);
      for (const [i, x] of [[1, 20], [2, 30], [3, 40]]) {
        clock += 10; move(x);
        await tick(30);
        expect(xs()).toHaveLength(i + 1);
        expect(xs()[i]).toBe(x / 100);
        await land(i);
      }
    });

    it("a window closing while a sample is out starts no second one", async () => {
      const { move } = mount();
      move(10);
      await land(0);
      clock += 10; move(20);
      // The window's timer is late (a busy main thread): the next move
      // is already past the window and samples at once.
      clock += 30; move(30);
      clock += 1; move(40);
      expect(xs()).toEqual([0.1, 0.3]);
      await act(async () => { vi.advanceTimersByTime(100); });
      expect(xs()).toEqual([0.1, 0.3]);
      await land(1);
      expect(xs()).toEqual([0.1, 0.3, 0.4]);
    });

    it("a move sampled at once drops an older position waiting on the window", async () => {
      // The window's timer is late and the next move, past the window,
      // samples at once; the position the window held is older than it.
      // It used to stay queued and be sampled after the newer one, so
      // the ghost ended on a hue the cursor had left.
      const { commands, move } = mount();
      move(10);
      await land(0);
      clock += 10; move(20);
      clock += 30; move(30);
      await act(async () => { vi.advanceTimersByTime(100); });
      await land(1);
      await tick(200);
      expect(xs()).toEqual([0.1, 0.3]);
      expect(ghosts(commands)).toHaveLength(2);
    });

    it("putting the picker away drops a position waiting on the window", async () => {
      const { commands, move, view } = mount();
      const armed = site.armed();
      move(10);
      await land(0);
      clock += 10; move(30);
      view.rerender(pane(reduce(armed, site.disarm), commands));
      await tick(200);
      expect(xs()).toEqual([0.1]);
    });

    it("samples a move after the window at once", async () => {
      const { move } = mount();
      move(10);
      await land(0);
      clock += 40; move(30);
      expect(xs()).toEqual([0.1, 0.3]);
    });

    it("a window's queued position waits for a sample still out, and that sample's landing takes it", async () => {
      const { move } = mount();
      move(10);
      await land(0);
      clock += 50; move(20);
      clock += 10; move(30);
      // 20 is out, 30 waits on the window; the window closes first.
      await tick(100);
      expect(xs()).toEqual([0.1, 0.2]);
      await land(1);
      expect(xs()).toEqual([0.1, 0.2, 0.3]);
    });

    it("a sample the engine refused still frees the sampler for the queued position", async () => {
      const { commands, move } = mount();
      move(10);
      clock += 100; move(30);
      await fail(0);
      expect(xs()).toEqual([0.1, 0.3]);
      expect(ghosts(commands)).toHaveLength(0);
    });

    it("leaving the picture clears the ghost, drops the queued position, and the answer out lands nowhere", async () => {
      const { commands, move, overlay } = mount();
      move(10);
      clock += 100; move(30);
      fireEvent.mouseLeave(overlay());
      expect(commands.slice(-1)).toEqual([site.cleared]);
      const count = commands.length;
      await land(0);
      expect(xs()).toEqual([0.1]);
      expect(commands).toHaveLength(count);
    });

    it("leaving drops a position waiting on the window", async () => {
      const { move, overlay } = mount();
      move(10);
      await land(0);
      clock += 10; move(30);
      fireEvent.mouseLeave(overlay());
      await tick(200);
      expect(xs()).toEqual([0.1]);
    });

    it(site.resumesAfterLeave
      ? "a move after leaving, made while the old sample is out, is sampled when it lands"
      : "a move after leaving, made while the old sample is out, waits for the next move", async () => {
      const { commands, move, overlay } = mount();
      move(10);
      fireEvent.mouseLeave(overlay());
      clock += 100; move(30);
      const count = ghosts(commands).length;
      await land(0);
      expect(ghosts(commands)).toHaveLength(count);
      expect(xs()).toEqual(site.resumesAfterLeave ? [0.1, 0.3] : [0.1]);
    });

    it("putting the picker away drops the queued position and the answer out", async () => {
      const { commands, move, view } = mount();
      const armed = site.armed();
      move(10);
      clock += 100; move(30);
      view.rerender(pane(reduce(armed, site.disarm), commands));
      commands.length = 0;
      await land(0);
      await tick(200);
      expect(xs()).toEqual([0.1]);
      expect(ghosts(commands)).toEqual([]);
    });

    it("unmounting stops the window's timer", async () => {
      const { move, view } = mount();
      move(10);
      await land(0);
      clock += 10; move(30);
      view.unmount();
      await tick(200);
      expect(xs()).toEqual([0.1]);
    });

    it(site.heldGate === "drag"
      ? "a drag from a press samples no hover"
      : "a move with the button held samples no hover", async () => {
      const { move, overlay } = mount();
      if (site.heldGate === "drag") fireEvent.mouseDown(overlay(), { button: 0, buttons: 1, clientX: 50, clientY: 50 });
      const clicks = xs().length;
      clock += 100; move(20, { buttons: 1 });
      clock += 100; move(30, { buttons: 1 });
      await tick(200);
      expect(xs()).toHaveLength(clicks);
      fireEvent.mouseUp(window);
    });

    it("a press drops the position queued behind the hover sample out", async () => {
      const { move, overlay } = mount();
      move(10);
      clock += 100; move(30);
      fireEvent.mouseDown(overlay(), { button: 0, buttons: 1, clientX: 50, clientY: 50 });
      const afterPress = xs();
      await land(0);
      expect(xs()).toEqual(afterPress);
      fireEvent.mouseUp(window);
    });
  });
}
