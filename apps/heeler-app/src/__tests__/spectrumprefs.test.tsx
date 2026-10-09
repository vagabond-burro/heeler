// 2026-09-27, on the Spectrums: "when I pop out spectrums it resets to
// the default histogram. So if I was viewing Harmony, I lose that
// view", and with EV on the waveform "it is really hard to see the
// exposure values".
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { initialState } from "../data";
import { Spectrums, drawEvScale } from "../ui/spectrum";

describe("the scope a window opens on", () => {
  it("the pop-out opens on the panel's scope, channel and EV, and the panel comes back on the window's", () => {
    const panel = render(<Spectrums state={initialState()} />);
    fireEvent.click(screen.getByTestId("spectrum-waveform"));
    fireEvent.click(screen.getByRole("button", { name: "EV" }));
    panel.unmount();
    // The window mounts its own Spectrums, as the pop-out does.
    const win = render(<Spectrums state={initialState()} fill />);
    expect(screen.getByTestId("spectrum-waveform")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "EV" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByTestId("spectrum-harmony"));
    win.unmount();
    render(<Spectrums state={initialState()} />);
    expect(screen.getByTestId("spectrum-harmony")).toHaveAttribute("aria-pressed", "true");
  });

  it("a stored scope that no longer exists opens the histogram", () => {
    localStorage.setItem("heeler.ui.spectrumKind", JSON.stringify("oscilloscope"));
    render(<Spectrums state={initialState()} />);
    expect(screen.getByTestId("spectrum-histogram")).toHaveAttribute("aria-pressed", "true");
  });
});

describe("the EV scale", () => {
  it("labels every stop in 11px text on a dark chip, middle gray in the accent", () => {
    const calls: { op: string; arg?: unknown; font?: string; fill?: unknown }[] = [];
    const ctx = new Proxy({} as Record<string, unknown>, {
      get: (t, k: string) => {
        if (k in t) return t[k];
        if (k === "measureText") return (s: string) => ({ width: s.length * 7 });
        return (...args: unknown[]) => calls.push({ op: k, arg: args[0], font: t.font as string, fill: t.fillStyle });
      },
      set: (t, k: string, v) => { t[k] = v; return true; },
    });
    drawEvScale(ctx as unknown as CanvasRenderingContext2D, 400, 600, 1);
    const labels = calls.filter((c) => c.op === "fillText");
    // At 600px every stop has room; top down, as drawn.
    expect(labels.map((c) => c.arg)).toEqual(["+2", "+1", "0 EV", "-1", "-2", "-3", "-4"]);
    expect(labels.every((c) => c.font?.startsWith("11px"))).toBe(true);
    // Each label is preceded by its backing chip.
    const chipsBefore = calls.filter((c, i) => c.op === "fillRect" && calls[i + 1]?.op === "fillText");
    expect(chipsBefore).toHaveLength(labels.length);
    expect(labels.find((c) => c.arg === "0 EV")?.fill).toBe("#8fd6ee");
  });

  it("drops a label that would sit on the one above it, never a line or middle gray", () => {
    const ops: { op: string; arg?: unknown }[] = [];
    const ctx = new Proxy({} as Record<string, unknown>, {
      get: (t, k: string) => (k in t ? t[k] : k === "measureText" ? (s: string) => ({ width: s.length * 7 }) : (...a: unknown[]) => ops.push({ op: k, arg: a[0] })),
      set: (t, k: string, v) => { t[k] = v; return true; },
    });
    drawEvScale(ctx as unknown as CanvasRenderingContext2D, 400, 90, 1);
    const labels = ops.filter((c) => c.op === "fillText").map((c) => c.arg);
    expect(ops.filter((c) => c.op === "stroke")).toHaveLength(7);
    expect(labels).toContain("0 EV");
    expect(labels.length).toBeLessThan(7);
  });
});
