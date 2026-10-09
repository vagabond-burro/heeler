import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it } from "vitest";
import { initialState } from "../data";
import { CMD_CHANNEL, STATE_CHANNEL, graphSnapshot, setTransport } from "../popout";
import type { Command, State } from "../state";
import { TakesWindow } from "../ui/takeswindow";
import { _clearFlashForTests } from "../ui/hints";

function setup(count = 1) {
  const listeners = new Map<string, (p: unknown) => void>();
  const sent: Command[] = [];
  setTransport({
    send(channel, payload) { if (channel === CMD_CHANNEL) sent.push(payload as Command); },
    subscribe(channel, fn) { listeners.set(channel, fn); return () => { listeners.delete(channel); }; },
  });
  const state = initialState();
  state.takes[state.activeImage] = Array.from({ length: count }, (_, i) => ({ id: `take_${i + 1}`, name: `Take ${i + 1}`, note: "saved note", nodes: [], wires: [] }));
  const push = (next: State) => act(() => listeners.get(STATE_CHANNEL)?.(graphSnapshot(next)));
  render(<TakesWindow />);
  push(state);
  return { state, push, sent };
}

afterEach(() => { setTransport(null); _clearFlashForTests(); });

it("Escape cancels a take name or note without committing the draft", async () => {
  const user = userEvent.setup();
  const { sent } = setup();
  for (const field of ["name", "note"]) {
    const input = screen.getByTestId(`takes-window-${field}-take_1`);
    await user.click(input);
    await user.clear(input);
    await user.type(input, "cancel this");
    await user.keyboard("{Escape}");
    expect(sent.filter(c => c.type === "update_take")).toEqual([]);
    expect(input).toHaveValue(field === "name" ? "Take 1" : "saved note");
  }
});

it("an untouched focused draft does not overwrite a newer snapshot on blur", async () => {
  const user = userEvent.setup();
  const { state, push, sent } = setup();
  const input = screen.getByTestId("takes-window-note-take_1");
  await user.click(input);
  const next = structuredClone(state);
  next.takes[next.activeImage][0].note = "updated elsewhere";
  push(next);
  fireEvent.blur(input);
  expect(sent.filter(c => c.type === "update_take")).toEqual([]);
  expect(input).toHaveValue("updated elsewhere");
});

it("changing photographs cannot carry a focused note into another take_1", async () => {
  const user = userEvent.setup();
  const { state, push, sent } = setup();
  await user.type(screen.getByTestId("takes-window-note-take_1"), " first photo only");
  const next = structuredClone(state);
  next.activeImage = "another-photo";
  next.takes[next.activeImage] = [{ id: "take_1", name: "Other photo", note: "other note", nodes: [], wires: [] }];
  push(next);
  const input = screen.getByTestId("takes-window-note-take_1");
  expect(input).toHaveValue("other note");
  fireEvent.blur(input);
  expect(sent.filter(c => c.type === "update_take")).toEqual([]);
});

it("the take stars work with Enter and Space and expose their pressed state", async () => {
  const user = userEvent.setup();
  const { sent } = setup();
  const star = screen.getByTestId("take-star-take_1-4");
  star.focus();
  expect(star).toHaveFocus();
  expect(star).toHaveAttribute("aria-pressed", "false");
  await user.keyboard("{Enter} ");
  expect(sent.filter(c => c.type === "set_take_rating")).toHaveLength(2);
});

it("the window's own status row shows each control's hint", async () => {
  setup();
  fireEvent.mouseOver(screen.getByTestId("take-star-take_1-3"));
  expect(screen.getByTestId("takes-window-hint")).toHaveTextContent("Rate this take 3 stars");
  fireEvent.mouseOver(screen.getByTestId("takes-window-compare-take_1"));
  expect(screen.getByTestId("takes-window-hint")).toHaveTextContent("beside the others");
});

it("ten takes and a long note have named fields and a disabled full compare action", () => {
  const { state, push } = setup(10);
  state.takes[state.activeImage][0].note = "long note ".repeat(1000);
  state.multiTakes = ["take_1", "take_2", "take_3", "take_4"];
  push({ ...state });
  expect(screen.getByTestId("takes-window-count")).toHaveTextContent("10 TAKES");
  expect(screen.getByTestId("takes-window-note-take_1")).toHaveAccessibleName("Notes for Take 1");
  expect(screen.getByTestId("takes-window-name-take_1")).toHaveAccessibleName("Take name");
  expect(screen.getByTestId("takes-window-compare-take_10")).toBeDisabled();
});
