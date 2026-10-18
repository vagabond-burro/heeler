// The Line Profile scope: the levels along a drawn line, the line's
// state, its drawing on the viewer, and the hover shared by both.
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { initialState } from "../data";
import { anyPickerArmed, reduce, type Command, type State } from "../state";
import { alongLine, lineProfile, SPECTRUM_KINDS } from "../spectrums";
import { profileReadout } from "../ui/spectrum";
import { ProfileLineLayer } from "../ui/profileline";
import { IDENTITY_VIEW } from "../ui/overlays";

const run = (s: State, ...cmds: Command[]) => cmds.reduce(reduce, s);

/** A frame dark on the left, bright on the right, with a transparent
 * column at the far right (a warp's empty edge). */
function ramp(w: number, h: number) {
  const pixels = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const v = Math.round((x / (w - 1)) * 255);
      pixels.set([v, v / 2, 0, x === w - 1 ? 0 : 255], i);
    }
  }
  return { pixels, w, h };
}

describe("Line Profile", () => {
  it("is one of the scopes", () => {
    expect(SPECTRUM_KINDS.map((k) => k.id)).toContain("profile");
  });

  it("reads the levels along the line, start to end, with a gap off the photograph", () => {
    const frame = ramp(101, 11);
    const p = lineProfile(frame, { x0: 0, y0: 0.5, x1: 1, y1: 0.5 }, 11);
    expect(p.luma).toHaveLength(11);
    expect(p.r[0]).toBeCloseTo(0, 2);
    expect(p.r[5]).toBeCloseTo(0.5, 1);
    expect(p.g[5]).toBeCloseTo(0.25, 1);
    expect(p.luma[5]).toBeCloseTo(0.2126 * p.r[5] + 0.7152 * p.g[5] + 0.0722 * p.b[5], 5);
    expect(Number.isNaN(p.luma[10])).toBe(true);
    // Drawn the other way, it reads the other way.
    const back = lineProfile(frame, { x0: 0.98, y0: 0.5, x1: 0, y1: 0.5 }, 11);
    expect(back.r[0]).toBeGreaterThan(back.r[10]);
    expect(profileReadout(p, 0.5)).toMatch(/^50% along · L \d+ · R 50 G 25 B 0$/);
    expect(profileReadout(p, 1)).toMatch(/off the photograph/);
  });

  it("finds where a point falls along the line", () => {
    const line = { x0: 0.1, y0: 0.1, x1: 0.9, y1: 0.1 };
    expect(alongLine(line, 0.5, 0.11).t).toBeCloseTo(0.5, 5);
    expect(alongLine(line, 0.5, 0.11).dist).toBeCloseTo(0.01, 5);
    expect(alongLine(line, -1, 0.1).t).toBe(0);
  });

  it("drawing is one picker among the rest, and the line is view state", () => {
    let s = run(initialState(), { type: "arm_wb_pick", id: "stdcolor" }, { type: "toggle_profile_draw" });
    expect(s.wbPick).toBeNull();
    expect(s.profileDraw).toBe(true);
    s = run(s, { type: "set_profile_line", line: { x0: 0.2, y0: 0.5, x1: 1.3, y1: 0.5 } });
    expect(s.profileDraw).toBe(false);
    expect(s.profileLine).toEqual({ x0: 0.2, y0: 0.5, x1: 1, y1: 0.5 });
    expect(anyPickerArmed(s)).toBe(false);
    // Not undoable: nothing in the photograph changed.
    expect(run(s, { type: "undo" }).profileLine).toEqual(s.profileLine);
    s = run(s, { type: "set_profile_hover", t: 1.4 });
    expect(s.profileHover).toBe(1);
    // A click without a drag draws no line.
    expect(run(s, { type: "set_profile_line", line: { x0: 0.3, y0: 0.3, x1: 0.3, y1: 0.3 } }).profileLine).toBeNull();
    expect(run(s, { type: "set_profile_line", line: null }).profileLine).toBeNull();
  });

  it("a drag on the viewer lays the line down, and the hover marks it", () => {
    const dispatch = vi.fn();
    const s = run(initialState(), { type: "toggle_profile_draw" });
    const { rerender } = render(
      <div style={{ position: "relative", width: 200, height: 100 }}>
        <ProfileLineLayer state={s} dispatch={dispatch} view={IDENTITY_VIEW} />
      </div>,
    );
    const overlay = screen.getByTestId("profile-draw-overlay");
    overlay.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 100, right: 200, bottom: 100, x: 0, y: 0, toJSON: () => ({}) });
    fireEvent.mouseDown(overlay, { button: 0, clientX: 20, clientY: 50 });
    fireEvent.mouseMove(overlay, { clientX: 180, clientY: 50 });
    expect(screen.getByTestId("profile-line")).toBeTruthy();
    fireEvent.mouseUp(overlay);
    const laid = dispatch.mock.calls[dispatch.mock.calls.length - 1][0];
    expect(laid.type).toBe("set_profile_line");
    for (const [k, v] of Object.entries({ x0: 0.1, y0: 0.5, x1: 0.9, y1: 0.5 })) expect(laid.line[k]).toBeCloseTo(v, 6);
    const drawn = run(s, { type: "set_profile_line", line: { x0: 0.1, y0: 0.5, x1: 0.9, y1: 0.5 } }, { type: "set_profile_hover", t: 0.5 });
    rerender(
      <div style={{ position: "relative", width: 200, height: 100 }}>
        <ProfileLineLayer state={drawn} dispatch={dispatch} view={IDENTITY_VIEW} />
      </div>,
    );
    expect(screen.queryByTestId("profile-draw-overlay")).toBeNull();
    const mark = screen.getByTestId("profile-mark");
    expect(Number(mark.getAttribute("cx"))).toBeCloseTo(0.5, 5);
  });
});
