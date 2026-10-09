import { act, fireEvent, render } from "@testing-library/react";
import { useReducer } from "react";
import { expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { initialState, NEUTRAL_NODES, NEUTRAL_WIRES } from "../data";
import { reduce, visibleImages, type State, type Command } from "../state";
import { Ribbon } from "../ui/chrome";
import { serializeGraph } from "../bridge";

it.skipIf(!process.env.HEELER_PERF)("measures a 5000-row library and exports the actual default graph", async () => {
  const start = initialState();
  start.nodes = NEUTRAL_NODES;
  start.wires = NEUTRAL_WIRES;
  writeFileSync("/tmp/heeler-phase6-default-graph.json", JSON.stringify(serializeGraph(start)));
  start.images = Array.from({ length: 5000 }, (_, i) => ({ ...start.images[0], id: `synthetic-${i}`, name: `Photo-${String(i).padStart(5, "0")}.png`, src: "", stars: i % 6 }));
  start.activeImage = start.images[0].id;
  start.ribbonOpen = true;
  let state: State = start;
  let dispatch: React.Dispatch<Command>;
  function Library() {
    const [s, d] = useReducer(reduce, start); state = s; dispatch = d;
    return <Ribbon state={s} dispatch={d} />;
  }
  const before = process.memoryUsage().heapUsed;
  let peak = before;
  const sample = () => { peak = Math.max(peak,process.memoryUsage().heapUsed); };
  let t = performance.now();
  const view = render(<Library />);
  await act(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
  const mount = performance.now() - t;sample();
  const scroll = view.container.querySelector<HTMLElement>('[data-testid="ribbon-scroll"]') ?? view.container.querySelector<HTMLElement>('.ribbon-scroll');
  expect(scroll).not.toBeNull();
  t = performance.now();
  for (let i = 0; i < 100; i++) if (scroll) { fireEvent.scroll(scroll, { target: { scrollTop: i * 5000 } });sample(); }
  const scrollMs = performance.now() - t;
  t = performance.now();
  act(() => dispatch({ type: "set_ribbon_sort", desc: true }));
  const sort = performance.now() - t;sample();
  expect(visibleImages(state)).toHaveLength(5000);
  t = performance.now();
  act(() => dispatch({ type: "set_filter_name", text: "Photo-000" }));
  const filterMs = performance.now() - t;sample();
  expect(visibleImages(state)).toHaveLength(100);
  console.log(JSON.stringify({ fixture: "library-dom", rows: 5000, mountCommitRafMs: mount, scrollDispatchMs: scrollMs, sortMs: sort, filterMs, sampledPeakHeapBytes: peak, heapDeltaBytes: process.memoryUsage().heapUsed - before, sessionJsonBytes: new TextEncoder().encode(JSON.stringify(state)).length, elements: view.container.querySelectorAll("*").length, scrollFound: !!scroll }));
}, 120000);
