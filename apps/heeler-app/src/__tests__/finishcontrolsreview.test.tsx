import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TrackSlider } from "../ui/track";

afterEach(cleanup);
function track() {
  const change = vi.fn(), begin = vi.fn(), end = vi.fn();
  render(<TrackSlider label="Exposure" value={0} lo={-5} hi={5} onChange={change} onBegin={begin} onEnd={end} />);
  const el = screen.getByRole("slider");
  el.getBoundingClientRect = () => ({ left: 0, width: 100 } as DOMRect);
  return { el, change, begin, end };
}
const pointer = (el: HTMLElement, type: string, button: number, buttons: number, clientX = 90) => act(() => {
  el.dispatchEvent(new MouseEvent(type, { bubbles: true, button, buttons, clientX }));
});
for (const [button, buttons] of [[1, 4], [2, 2], [0, 5]]) {
  it(`slider ignores a non-primary press ${button}/${buttons} and its release`, () => {
    const t = track();
    pointer(t.el, "pointerdown", button, buttons);
    pointer(t.el, "pointerup", button, 0);
    expect(t.change).not.toHaveBeenCalled();
    expect(t.begin).not.toHaveBeenCalled();
    expect(t.end).not.toHaveBeenCalled();
  });
}
it("a primary slider drag still commits and ends once", () => {
  const t = track();
  pointer(t.el, "pointerdown", 0, 1, 50);
  pointer(t.el, "pointermove", 0, 1, 80);
  pointer(t.el, "pointerup", 0, 0, 80);
  pointer(t.el, "lostpointercapture", 0, 0, 80);
  expect(t.change).toHaveBeenLastCalledWith(3);
  expect(t.begin).toHaveBeenCalledTimes(1);
  expect(t.end).toHaveBeenCalledTimes(1);
});
