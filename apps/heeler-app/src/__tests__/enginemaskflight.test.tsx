// The selection overlay's engine mask: one render in flight at a time,
// and the newest change rendered once the one in flight lands. A stroke
// asked faster than renders finished, they queued behind the render lock
// past the 30 s answer limit, and Polish's matte never reached the
// overlay (the owner, 2026-10-17).
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, act } from "@testing-library/react";

const calls: Array<{ resolve: (v: string | null) => void; version: number }> = [];
vi.mock("../bridge", async (orig) => {
  const real = await orig<typeof import("../bridge")>();
  return {
    ...real,
    renderMaskOf: vi.fn((s: { renderVersion: number }) => new Promise<string | null>((resolve) => calls.push({ resolve, version: s.renderVersion }))),
  };
});

import { initialState } from "../data";
import { reduce, type State } from "../state";
import { useEngineMask } from "../ui/selectionparts";
// The hook reaches the bridge through a dynamic import; loading it here
// first keeps that import from taking real time under the fake clock.
import "../bridge";

function Probe({ state, id }: { state: State; id: string }) {
  useEngineMask(state, id);
  return null;
}

afterEach(() => {
  calls.length = 0;
  vi.useRealTimers();
});

describe("the overlay's engine mask", () => {
  it("keeps one render in flight and renders the newest change after it", async () => {
    vi.useFakeTimers();
    let s = reduce(initialState(), { type: "add_layer", maskType: "selection" });
    const sel = s.nodes.find((n) => n.type === "heeler.selection_mask");
    expect(sel).toBeTruthy();
    const view = render(<Probe state={s} id={sel!.id} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    expect(calls).toHaveLength(1);
    // A stroke's worth of changes while the first render is still out.
    for (let i = 0; i < 10; i++) {
      s = { ...s, renderVersion: s.renderVersion + 1 };
      view.rerender(<Probe state={s} id={sel!.id} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    }
    expect(calls).toHaveLength(1);
    // The first lands: the newest change, and only it, is asked next.
    await act(async () => { calls[0].resolve(null); await vi.advanceTimersByTimeAsync(10); });
    expect(calls).toHaveLength(2);
    expect(calls[1].version).toBe(s.renderVersion);
    await act(async () => { calls[1].resolve(null); await vi.advanceTimersByTimeAsync(400); });
    expect(calls).toHaveLength(2);
  });
});
