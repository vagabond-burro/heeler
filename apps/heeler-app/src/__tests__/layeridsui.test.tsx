// Develop layer identity in the panels and windows, pinned before the
// 26.4.2 refactor moves it into one module. These are the UI sites a
// mutation pass found no test noticed breaking: each test is green on
// the code as it stands and fails when its site is.

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useReducer } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initialState } from "../data";
import { reduce, type Command, type State } from "../state";
import { STATE_CHANNEL, graphSnapshot, setTransport, type Transport } from "../popout";

const spy = vi.hoisted(() => ({ bake: vi.fn(), renderMask: vi.fn() }));
vi.mock("../bridge", async (original) => ({
  ...await original<typeof import("../bridge")>(),
  bakeMaskRaster: (...args: unknown[]) => {
    spy.bake(...args);
    return new Promise(() => {});
  },
  renderMaskOf: (...args: unknown[]) => {
    spy.renderMask(...args);
    return Promise.resolve(null);
  },
}));

import { ToolWindow } from "../ui/toolwindow";
import { BendWindow } from "../ui/bendwindow";
import { SimplePanel } from "../ui/simple";
import { Viewer } from "../ui/viewer";

const run = (s: State, ...cmds: Command[]) => cmds.reduce(reduce, s);

function fakeTransport() {
  const subs = new Map<string, ((p: unknown) => void)[]>();
  const sent: { channel: string; payload: unknown }[] = [];
  const t: Transport & { sent: typeof sent } = {
    sent,
    send(channel, payload) {
      sent.push({ channel, payload });
      [...(subs.get(channel) ?? [])].forEach((f) => f(payload));
    },
    subscribe(channel, fn) {
      subs.set(channel, [...(subs.get(channel) ?? []), fn]);
      return () => subs.set(channel, (subs.get(channel) ?? []).filter((f) => f !== fn));
    },
  };
  setTransport(t);
  return t;
}

afterEach(() => {
  setTransport(null);
  spy.bake.mockClear();
  spy.renderMask.mockClear();
});

describe("a tool window with a layer selected", () => {
  // The layer's tool is a stand-in that reads off until first touch; the
  // window shows it rather than the main chain's "not used yet" screen.
  const layered = () => graphSnapshot(run(initialState(), { type: "add_layer", maskType: "brush" }));

  it("Curves shows the layer's plot, not the switch", async () => {
    const t = fakeTransport();
    render(<ToolWindow kind="curves" />);
    act(() => t.send(STATE_CHANNEL, layered()));
    expect(await screen.findByTestId("curve-plot")).toBeInTheDocument();
    expect(screen.queryByTestId("tool-window-off")).not.toBeInTheDocument();
  });

  it("Color Wheels shows the layer's wheels, not the switch", async () => {
    const t = fakeTransport();
    render(<ToolWindow kind="wheels" />);
    act(() => t.send(STATE_CHANNEL, layered()));
    expect(await screen.findByTestId("wheel-midtones")).toBeInTheDocument();
    expect(screen.queryByTestId("tool-window-off")).not.toBeInTheDocument();
  });

  it("the Bend window shows a layer's wheel even switched off; a main-chain one off shows the switch", async () => {
    const s0 = initialState();
    const bend = s0.nodes.find((n) => n.type === "heeler.color_bend");
    const base = { ...s0, nodes: s0.nodes.filter((n) => n.type !== "heeler.color_bend") };
    const asLayer = { ...base, nodes: [...base.nodes, { ...(bend ?? base.nodes[0]), id: "layer_1_bend", type: "heeler.color_bend", enabled: false }] };
    const asMain = { ...base, nodes: [...base.nodes, { ...(bend ?? base.nodes[0]), id: "bend", type: "heeler.color_bend", enabled: false }] };
    const t = fakeTransport();
    const view = render(<BendWindow />);
    act(() => t.send(STATE_CHANNEL, graphSnapshot(asLayer)));
    expect(await screen.findByTestId("bend-wheel")).toBeInTheDocument();
    view.unmount();
    const t2 = fakeTransport();
    render(<BendWindow />);
    act(() => t2.send(STATE_CHANNEL, graphSnapshot(asMain)));
    expect(await screen.findByTestId("tool-window-off")).toBeInTheDocument();
  });
});

describe("the Develop panel with a layer selected", () => {
  function Harness({ seeded, engine = true }: { seeded: State; engine?: boolean }) {
    const [s, d] = useReducer(reduce, seeded);
    return <SimplePanel state={s} dispatch={d} engine={engine} />;
  }

  it("Ctrl-click on a layer bakes that layer's own mask into the selection", async () => {
    const s = run(initialState(), { type: "add_layer", maskType: "range" }, { type: "add_layer", maskType: "radial" });
    render(<Harness seeded={s} />);
    fireEvent.click(screen.getByTestId("select-layer_1_adj"), { ctrlKey: true });
    // The bake runs behind a dynamic import of the bridge.
    await waitFor(() => expect(spy.bake).toHaveBeenCalledTimes(1));
    expect(spy.bake.mock.calls[0][1]).toBe("layer_1_mask");
  });

  it("a selection layer's empty mask still opens the selection split", () => {
    const s = { ...run(initialState(), { type: "add_layer", maskType: "selection" }), selectionSplitClosed: false, tool: "none" as const };
    expect(s.activeLayer).toBe("layer_1_adj");
    render(<Harness seeded={s} />);
    expect(screen.getByTestId("divider-selection-split")).toBeInTheDocument();
  });

  it("a layer's Color Bend says it edits the layer only", () => {
    let s = run(initialState(), { type: "add_layer", maskType: "brush" });
    s = { ...s, sectionsClosed: [] };
    render(<Harness seeded={s} />);
    const status = screen.getAllByTestId("bend-status");
    expect(status.some((el) => /Editing this layer only/.test(el.textContent ?? ""))).toBe(true);
  });
});

describe("Polish on a selection layer", () => {
  it("the viewer lays the polish overlay over the layer's selection", () => {
    const s = { ...run(initialState(), { type: "add_layer", maskType: "selection" }), polishOpen: true };
    render(<Viewer state={s} dispatch={() => {}} />);
    expect(screen.getByTestId("polish-overlay")).toBeInTheDocument();
  });
});
