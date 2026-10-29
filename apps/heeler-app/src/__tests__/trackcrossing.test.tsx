// A slider follows only a drag pressed on it. The window follows a drag
// carried off the canvas (the straighten line, a crop edge, a brush
// stroke), so the button is still held as the pointer crosses the
// panels, and the Color panel's Temp took the crossing for its own drag
// and moved (2026-10-29: "when I dragged outside of the canvas the image
// shifted its color tone").

import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TrackSlider } from "../ui/track";

// jsdom's PointerEvent drops `buttons`; a MouseEvent carries it.
const NativePointer = window.PointerEvent;
beforeEach(() => { window.PointerEvent = MouseEvent as typeof PointerEvent; });
afterEach(() => { window.PointerEvent = NativePointer; });

function slider() {
  const onChange = vi.fn();
  render(<TrackSlider label="Temp" value={6500} lo={2000} hi={50000} testid="temp" onChange={onChange} />);
  const track = screen.getByTestId("temp");
  track.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 10 } as DOMRect);
  return { track, onChange };
}

it("a held drag that began elsewhere crosses the slider without moving it", () => {
  const { track, onChange } = slider();
  fireEvent.pointerMove(track, { buttons: 1, clientX: 180 });
  fireEvent.pointerUp(track);
  expect(onChange).not.toHaveBeenCalled();
});

it("its own press still drags it, and a move after the release does not", () => {
  const { track, onChange } = slider();
  fireEvent.pointerDown(track, { button: 0, buttons: 1, clientX: 100 });
  fireEvent.pointerMove(track, { buttons: 1, clientX: 150 });
  expect(onChange).toHaveBeenCalledTimes(2);
  fireEvent.pointerUp(track);
  onChange.mockClear();
  fireEvent.pointerMove(track, { buttons: 1, clientX: 20 });
  expect(onChange).not.toHaveBeenCalled();
});
