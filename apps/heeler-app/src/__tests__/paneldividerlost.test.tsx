// The 26.4.3 full review's R6: the panel seam's drag listened on the
// window with nothing to end it but its release, so a drag the window
// lost (the release never seen) or the seam unmounting mid-drag kept
// resizing panels as the pointer moved, button up.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PanelDivider } from "../ui/divider";

afterEach(() => cleanup());

describe("the panel seam's drag ends with its window or its seam", () => {
  for (const how of ["blur", "unmount"] as const) {
    it(`a seam drag ended by ${how} stops resizing`, () => {
      const deltas: number[] = [];
      const r = render(<PanelDivider vertical testid="seam" onDelta={(d) => deltas.push(d)} />);
      fireEvent.mouseDown(screen.getByTestId("seam"), { button: 0, clientX: 100, clientY: 0 });
      fireEvent.mouseMove(window, { clientX: 110, clientY: 0 });
      expect(deltas).toEqual([10]);
      if (how === "blur") fireEvent.blur(window);
      else r.unmount();
      fireEvent.mouseMove(window, { clientX: 140, clientY: 0 });
      expect(deltas, "the seam stopped following").toEqual([10]);
    });
  }
});
