// Lens Flare's lens, sources and source lists stand above its sliders
// (2026-10-29): the Sources row, which decides whether anything flares,
// sat under some twenty sliders, and the owner turned the section on,
// raised every dial and saw nothing ("Just had to FIND the right
// control!").

import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { initialState, NEUTRAL_NODES, NEUTRAL_WIRES } from "../data";
import { reduce, type State } from "../state";
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

it("shows at most five found sources and scrolls the rest, so the list never pushes the dials down", async () => {
  // "Make sure the SOURCES list is scrollable with only up to 5 sources
  // visible, we don't need this list to grow and push rest of the
  // controls down"
  const { FlarePanel } = await import("../ui/flare");
  const { writeSpots } = await import("../ui/flareparts");
  const fresh: State = { ...initialState(), nodes: structuredClone(NEUTRAL_NODES), wires: structuredClone(NEUTRAL_WIRES), sectionsClosed: [] };
  let s = reduce(fresh, { type: "set_category", title: "Lens Flare", on: true });
  const node = s.nodes.find((n) => n.type === "heeler.flare")!;
  const spots = Array.from({ length: 16 }, (_, i) => ({ x: 0.05 + i * 0.05, y: 0.5, strength: 1 - i * 0.05, color: [1, 0.9, 0.8] as [number, number, number], size: 0.01 }));
  s = reduce(s, { type: "set_param", id: node.id, param: "bright", value: 1 });
  s = reduce(s, { type: "set_text_param", id: node.id, param: "spots", value: writeSpots(spots) });
  render(<FlarePanel state={s} dispatch={() => {}} node={s.nodes.find((n) => n.id === node.id)!} />);
  const list = screen.getByTestId("flare-spots-list");
  expect(list.querySelectorAll('[data-testid^="flare-spot-"]')).toHaveLength(16);
  // Five 16 px rows and four 2 px gaps.
  expect(list.style.maxHeight).toBe("88px");
  expect(list.style.overflowY).toBe("auto");
  const row = screen.getByTestId("flare-spot-0").parentElement!;
  expect(row.style.height).toBe("16px");
});
