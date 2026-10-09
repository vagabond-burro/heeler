import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as bridge from "../bridge";
import { initialState } from "../data";
import { reduce, type Command } from "../state";
import { ShotDateRunner } from "../ui/datefields";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
describe("shot-date read ownership", () => {
  it("publishes bounded batches and stops requesting more after clear", async () => {
    const base = initialState();
    let state = { ...base, filterDateFrom: "2025", images: Array.from({ length: 65 }, (_, i) => ({ ...base.images[0], id: `review-${i}` })), shotDates: {} };
    let finish!: (v: Awaited<ReturnType<typeof bridge.folderMetadata>>) => void;
    const read = vi.spyOn(bridge, "folderMetadata").mockImplementation(() => new Promise(r => { finish = r; }));
    const sent: Command[] = [];
    const dispatch = (c: Command) => { sent.push(c); state = reduce(state, c); };
    const view = render(<ShotDateRunner state={state} dispatch={dispatch} />);
    expect(read.mock.calls[0][1]).toHaveLength(32);
    await act(async () => finish([]));
    expect(Object.keys(state.shotDates)).toHaveLength(32);
    view.rerender(<ShotDateRunner state={state} dispatch={dispatch} />);
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    state = reduce(state, { type: "clear_filters" });
    view.rerender(<ShotDateRunner state={state} dispatch={dispatch} />);
    sent.length = 0;
    await act(async () => finish([]));
    expect(sent).toEqual([]);
    expect(read).toHaveBeenCalledTimes(2);
  });
});
