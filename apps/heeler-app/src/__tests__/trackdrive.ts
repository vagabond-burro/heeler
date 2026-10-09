// Driving the house track (ui/track.tsx) from a test.
//
// The track is a div with role="slider", so fireEvent.change and
// .value do not exist on it. jsdom draws nothing either, so a pointer
// drag needs the track handed a size first; the drag math then maps
// clientX across that width, quantized to the control's step exactly
// the way the real pointer path is.

import { act } from "@testing-library/react";

/** The track's current value, from the same ARIA channel a screen
 * reader would announce. */
export function trackValue(el: Element): number {
  return Number(el.getAttribute("aria-valuenow"));
}

/** Point the track at `to`: a pointerdown at the spot where that value
 * sits, on a 400px-wide track drawn at the origin. MouseEvent rather
 * than fireEvent.pointerDown: jsdom has no PointerEvent constructor,
 * and without one the coordinates never reach the handler. */
export function dragTrack(el: Element, to: number) {
  const rect = {
    left: 0, top: 0, width: 400, height: 12, right: 400, bottom: 12, x: 0, y: 0,
    toJSON: () => ({}),
  } as DOMRect;
  el.getBoundingClientRect = () => rect;
  const lo = Number(el.getAttribute("aria-valuemin"));
  const hi = Number(el.getAttribute("aria-valuemax"));
  const x = ((to - lo) / (hi - lo)) * rect.width;
  // act() around each: a raw dispatchEvent reaches the handler fine, but
  // without it React flushes the state update after the assertion reads.
  act(() => {
    el.dispatchEvent(new MouseEvent("pointerdown", { clientX: x, bubbles: true, cancelable: true }));
  });
  act(() => {
    el.dispatchEvent(new MouseEvent("pointerup", { clientX: x, bubbles: true, cancelable: true }));
  });
}
