// Lens Flare's lens, sources and source lists stand above its sliders
// (2026-10-29): the Sources row, which decides whether anything flares,
// sat under some twenty sliders, and the owner turned the section on,
// raised every dial and saw nothing ("Just had to FIND the right
// control!").

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { initialState, NEUTRAL_NODES, NEUTRAL_WIRES } from "../data";
import { RIG_OFF_NOTICE, reduce, type Command, type State } from "../state";
import { SimplePanel } from "../ui/simple";

it("puts the flare's lens and sources before its first slider", () => {
  const fresh: State = { ...initialState(), nodes: structuredClone(NEUTRAL_NODES), wires: structuredClone(NEUTRAL_WIRES), sectionsClosed: [] };
  const s = reduce(fresh, { type: "set_category", title: "Lens Flare", on: true });
  render(<SimplePanel state={s} dispatch={() => {}} />);
  const panel = screen.getByTestId("flare-panel");
  const bright = screen.getByTestId("flare-source-bright");
  expect(panel.contains(bright)).toBe(true);
  // The Intensity that follows the panel is the flare's own; every
  // slider of the section comes after it.
  const intensity = screen.getAllByTestId("slider-intensity").find((el) => panel.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)!;
  expect(intensity).toBeTruthy();
  const header = screen.getByTestId("section-header-lens-flare");
  // Between the section's header and its first slider.
  expect(header.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  const between = [...document.querySelectorAll('[data-testid^="slider-"]')].filter(
    (el) => header.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING && el.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING,
  );
  expect(between).toEqual([]);
});

it("lists the rig's lights and the found spots as one list, five rows showing and the rest scrolling", async () => {
  // "it shows up to 5 sources then the rest has to scroll. I see 6": one
  // light and five spots showed as six rows, each kind capped on its own.
  const { FlarePanel } = await import("../ui/flare");
  const { writeSpots } = await import("../ui/flareparts");
  const rig = JSON.stringify([{ kind: "directional", azimuth: 30, elevation: 40, strength: 50, on: true, flare: false, flare_strength: 100 }]);
  const fresh: State = { ...initialState(), nodes: structuredClone(NEUTRAL_NODES), wires: structuredClone(NEUTRAL_WIRES), sectionsClosed: [] };
  let s = reduce(reduce(fresh, { type: "set_category", title: "Depth Lighting", on: true }), { type: "set_category", title: "Lens Flare", on: true });
  const flare = s.nodes.find((n) => n.type === "heeler.flare")!;
  const key = s.nodes.find((n) => n.type === "heeler.key_light")!;
  const spots = Array.from({ length: 6 }, (_, i) => ({ x: 0.1 + i * 0.1, y: 0.5, strength: 1 - i * 0.1, color: [1, 0.9, 0.8] as [number, number, number], size: 0.01 }));
  s = {
    ...s,
    nodes: s.nodes.map((n) =>
      n.id === key.id
        ? { ...n, enabled: true, textParams: { ...n.textParams, lights: rig } }
        : n.id === flare.id
          ? { ...n, params: { ...n.params, rig: 1, bright: 1 }, textParams: { ...n.textParams, spots: writeSpots(spots) } }
          : n,
    ),
  };
  render(<FlarePanel state={s} dispatch={() => {}} node={s.nodes.find((n) => n.id === flare.id)!} />);
  const list = screen.getByTestId("flare-sources-list");
  // Every source is in the one list: the light first, then the spots.
  const rows = [...list.children] as HTMLElement[];
  expect(rows).toHaveLength(7);
  expect(rows[0].contains(screen.getByTestId("flare-light-0"))).toBe(true);
  expect(rows[6].contains(screen.getByTestId("flare-spot-5"))).toBe(true);
  // Five 18 px rows (the chip's own height) and four 2 px gaps show;
  // the rest scroll.
  expect(list.style.maxHeight).toBe("98px");
  expect(list.style.overflowY).toBe("auto");
  for (const r of rows) {
    expect(r.style.height).toBe("18px");
    expect(r.style.flex).toBe("0 0 auto");
  }
  expect(screen.queryByTestId("flare-spots-list")).toBeNull();
  expect(screen.queryByTestId("flare-lights-list")).toBeNull();
});

it("draws no rig flare while Depth Lighting is off: none sent to the engine, none listed", async () => {
  // "I don't think Rig Lights should show anything if Depth Lighting
  // isn't turned on"
  const { serializeGraph } = await import("../bridge");
  const { FlarePanel } = await import("../ui/flare");
  const rig = JSON.stringify([{ kind: "point", px: 0.5, py: 0.5, depth: 30, range: 50, strength: 50, on: true, flare: true, flare_strength: 100 }]);
  const fresh: State = { ...initialState(), nodes: structuredClone(NEUTRAL_NODES), wires: structuredClone(NEUTRAL_WIRES), sectionsClosed: [] };
  const s = reduce(reduce(fresh, { type: "set_category", title: "Depth Lighting", on: true }), { type: "set_category", title: "Lens Flare", on: true });
  const flare = s.nodes.find((n) => n.type === "heeler.flare")!;
  const key = s.nodes.find((n) => n.type === "heeler.key_light")!;
  const withRig = (on: boolean): State => ({
    ...s,
    nodes: s.nodes.map((n) =>
      n.id === key.id ? { ...n, enabled: on, textParams: { ...n.textParams, lights: rig } } : n.id === flare.id ? { ...n, textParams: { ...n.textParams, lights: rig } } : n,
    ),
  });
  const sent = (st: State) => serializeGraph(st).nodes.find((n) => n.id === flare.id)!.params.lights;
  expect(sent(withRig(true))).toBe(rig);
  expect(sent(withRig(false))).toBe("[]");
  // The panel lists nothing for the rig and keeps no note of its own:
  // the status line says why, as Rig lights is chosen ("should be moved
  // to the status line and only appear when either Lens Flare is first
  // turned on and or Rig lights is activated").
  const off = withRig(false);
  const noRig = { ...off, nodes: off.nodes.map((n) => (n.id === flare.id ? { ...n, params: { ...n.params, rig: 0 } } : n)) };
  const sentCmds: Command[] = [];
  render(<FlarePanel state={noRig} dispatch={(c) => sentCmds.push(c)} node={noRig.nodes.find((n) => n.id === flare.id)!} />);
  expect(screen.queryByTestId("flare-relight-off")).toBeNull();
  expect(screen.queryByTestId("flare-light-0")).toBeNull();
  fireEvent.click(screen.getByTestId("flare-source-rig"));
  expect(sentCmds).toContainEqual({ type: "set_notice", text: RIG_OFF_NOTICE });
  // Turning Rig lights off says nothing.
  sentCmds.length = 0;
  cleanup();
  render(<FlarePanel state={off} dispatch={(c) => sentCmds.push(c)} node={off.nodes.find((n) => n.id === flare.id)!} />);
  expect(screen.queryByTestId("flare-light-0")).toBeNull();
  fireEvent.click(screen.getByTestId("flare-source-rig"));
  expect(sentCmds.some((c) => c.type === "set_notice")).toBe(false);
});

it("says so on the status line as Lens Flare is switched on with Depth Lighting off, and not with it on", () => {
  const fresh: State = { ...initialState(), nodes: structuredClone(NEUTRAL_NODES), wires: structuredClone(NEUTRAL_WIRES), sectionsClosed: [] };
  const on = reduce(fresh, { type: "set_category", title: "Lens Flare", on: true });
  expect(on.notice?.text).toBe(RIG_OFF_NOTICE);
  const lit = reduce(reduce({ ...fresh, notice: null }, { type: "set_category", title: "Depth Lighting", on: true }), { type: "set_category", title: "Lens Flare", on: true });
  expect(lit.notice?.text ?? "").not.toBe(RIG_OFF_NOTICE);
  // Switching it off says nothing.
  const off = reduce({ ...on, notice: null }, { type: "set_category", title: "Lens Flare", on: false });
  expect(off.notice).toBeNull();
});
