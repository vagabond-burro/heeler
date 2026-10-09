// The Color Tune pick under a moving state. The click handler awaits
// two samples before it answers, and state can move under those
// awaits: an image or take switch disarms the picker, a re-aim from
// the pop-out points it at another band, a delete rewrites the bands.
// The answer must only land while the armed aim is still the click's
// own: the disarm toggle flips per (node, band) aim, so firing it
// after a re-aim ARMS the old aim, and writing from the click's stale
// bands resurrects whatever was deleted in between.

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

type Sample = { luma: number; hue: number; sat: number; r: number; g: number; b: number; source: string };
// One deferred promise per call, resolved by the test when it wants
// the sample to land.
const pending: { resolve: (s: Sample) => void; reject: (error: Error) => void }[] = [];
const SAMPLE: Sample = { luma: 0.5, hue: 30, sat: 0.4, r: 0.6, g: 0.25, b: 0.15, source: "exposure" };

vi.mock("../bridge", async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return {
    ...real,
    sampleImage: vi.fn(() => new Promise<Sample>((resolve, reject) => pending.push({ resolve, reject }))),
  };
});

import { Viewer } from "../ui/viewer";
import { initialState } from "../data";
import { chainTerminalId, reduce, type Command, type State } from "../state";
import { parseConsoleBands } from "../consolebands";

const run = (s: State, ...cmds: Command[]) => cmds.reduce(reduce, s);

/** A state with Color Tune on and the picker armed; band null arms a
 * new-band pick, an id arms a move of that band. */
function armedState(band?: string): State {
  let s = run(initialState(), { type: "set_category", title: "Color Tune", on: true });
  if (band) {
    s = run(s, {
      type: "set_text_param",
      id: "colorconsole",
      param: "bands",
      value: JSON.stringify([{ id: band, center: 40, rgb: [200, 90, 60] }]),
    });
  }
  return run(s, { type: "toggle_console_pick", id: "colorconsole", band });
}

function renderPick(state: State, dispatch: (c: Command) => void) {
  return render(
    <Viewer
      state={state}
      dispatch={dispatch}
      previewUrl="data:image/png;base64,x"
      previewError={null}
      previewMs={null}
      previewBackend={null}
      originalUrl={null}
      maskUrl={null}
      multiFrames={{}}
    />,
  );
}

/** Let the awaited samples resolve, one tick at a time so the handler
 * reaches each await. Expects the click to have happened already. */
async function answerSamples() {
  for (let i = 0; i < 2; i++) {
    await waitFor(() => expect(pending.length).toBeGreaterThan(i));
    pending[i].resolve(SAMPLE);
    await new Promise((r) => setTimeout(r, 0));
  }
}

async function clickAndAnswer() {
  fireEvent.mouseDown(screen.getByTestId("console-pick-overlay"), { button: 0 });
  await answerSamples();
}

describe("the Color Tune pick under a moving state", () => {
  it("a quiet pick writes the band, selects it, and disarms", async () => {
    pending.length = 0;
    const s = armedState();
    const log: Command[] = [];
    renderPick(s, (c) => log.push(c));
    await clickAndAnswer();
    const write = log.find((c) => c.type === "set_text_param");
    expect(write && write.type === "set_text_param" && parseConsoleBands(write.value)[0].id).toBe("c1");
    expect(log.some((c) => c.type === "set_console_band" && c.id === "c1")).toBe(true);
    // The disarm is the same aim the click started with: a toggle that
    // definitely puts the picker away.
    const toggles = log.filter((c) => c.type === "toggle_console_pick");
    expect(toggles).toEqual([{ type: "toggle_console_pick", id: "colorconsole", band: undefined }]);
    expect(run(s, ...log).consolePick).toBe(null);
  });

  it("a re-aim mid-pick keeps the new aim and the click says nothing", async () => {
    pending.length = 0;
    const s = armedState();
    const log: Command[] = [];
    // The pop-out re-aims the picker at band c1 while the samples fly.
    const reaimed = run(s, { type: "toggle_console_pick", id: "colorconsole", band: "c1" });
    const view = renderPick(s, (c) => log.push(c));
    fireEvent.mouseDown(screen.getByTestId("console-pick-overlay"), { button: 0 });
    await waitFor(() => expect(pending.length).toBe(1));
    view.rerender(
      <Viewer
        state={reaimed}
        dispatch={(c: Command) => log.push(c)}
        previewUrl="data:image/png;base64,x"
        previewError={null}
        previewMs={null}
        previewBackend={null}
        originalUrl={null}
        maskUrl={null}
        multiFrames={{}}
      />,
    );
    pending[0].resolve(SAMPLE);
    await new Promise((r) => setTimeout(r, 0));
    // No second sample, no write, and above all no disarm toggle: that
    // toggle would have ARMED the old new-band aim over the user's.
    expect(pending.length).toBe(1);
    expect(log).toEqual([]);
    expect(reaimed.consolePick).toBe("colorconsole");
    expect(reaimed.consolePickBand).toBe("c1");
  });

  it("an image switch mid-pick neither writes nor re-arms", async () => {
    pending.length = 0;
    const s = armedState();
    const log: Command[] = [];
    const switched = run(s, { type: "select_image", id: "4875" });
    expect(switched.consolePick).toBe(null);
    const view = renderPick(s, (c) => log.push(c));
    fireEvent.mouseDown(screen.getByTestId("console-pick-overlay"), { button: 0 });
    await waitFor(() => expect(pending.length).toBe(1));
    view.rerender(
      <Viewer
        state={switched}
        dispatch={(c: Command) => log.push(c)}
        previewUrl="data:image/png;base64,x"
        previewError={null}
        previewMs={null}
        previewBackend={null}
        originalUrl={null}
        maskUrl={null}
        multiFrames={{}}
      />,
    );
    pending[0].resolve(SAMPLE);
    await new Promise((r) => setTimeout(r, 0));
    expect(log).toEqual([]);
    expect(run(switched, ...log).consolePick).toBe(null);
  });

  it("a band deleted mid-pick stays deleted and the picker disarms", async () => {
    pending.length = 0;
    const s = armedState("c1");
    const log: Command[] = [];
    // The delete lands from another face while the samples fly.
    const deleted = run(s, { type: "set_text_param", id: "colorconsole", param: "bands", value: "" });
    const view = renderPick(s, (c) => log.push(c));
    fireEvent.mouseDown(screen.getByTestId("console-pick-overlay"), { button: 0 });
    await waitFor(() => expect(pending.length).toBe(1));
    view.rerender(
      <Viewer
        state={deleted}
        dispatch={(c: Command) => log.push(c)}
        previewUrl="data:image/png;base64,x"
        previewError={null}
        previewMs={null}
        previewBackend={null}
        originalUrl={null}
        maskUrl={null}
        multiFrames={{}}
      />,
    );
    await answerSamples();
    // No write: the stale bands from the click must not resurrect c1.
    expect(log.some((c) => c.type === "set_text_param")).toBe(false);
    // The miss is named and the picker is put away with its own aim.
    const toggles = log.filter((c) => c.type === "toggle_console_pick");
    expect(toggles).toEqual([{ type: "toggle_console_pick", id: "colorconsole", band: "c1" }]);
    expect(run(deleted, ...log).consolePick).toBe(null);
  });

  it("with no Output node the display sample reads the chain's terminal", async () => {
    pending.length = 0;
    // Graph mode can delete Output; the label must still come from the
    // frame on screen, not the console's scene-linear input. The
    // terminal is named by the desktop's own rule, mirrored in
    // chainTerminalId: a real node id, never a sentinel.
    const s = run(armedState(), { type: "delete_nodes", ids: ["output"], heal: false });
    expect(s.nodes.some((n) => n.type === "heeler.output")).toBe(false);
    const terminal = chainTerminalId(s.nodes, s.wires);
    expect(terminal).toBeDefined();
    expect(terminal).not.toBe("colorconsole");
    expect(s.nodes.some((n) => n.id === terminal)).toBe(true);
    const log: Command[] = [];
    const { sampleImage } = await import("../bridge");
    vi.mocked(sampleImage).mockClear();
    renderPick(s, (c) => log.push(c));
    await clickAndAnswer();
    // The input sample first, the terminal second.
    expect(vi.mocked(sampleImage).mock.calls.map((c) => c[4])).toEqual(["colorconsole", terminal]);
    // And the pick itself still lands.
    expect(log.some((c) => c.type === "set_text_param")).toBe(true);
  });
});


it("a rejected Color Tune read disarms the current aim without creating a band", async () => {
  pending.length = 0;
  const commands: Command[] = [];
  renderPick(armedState(), (c) => commands.push(c));
  fireEvent.mouseDown(screen.getByTestId("console-pick-overlay"), { button: 0 });
  pending[0].reject(new Error("sample unavailable"));
  await waitFor(() => expect(commands).toEqual([{ type: "toggle_console_pick", id: "colorconsole", band: undefined }]));
});
