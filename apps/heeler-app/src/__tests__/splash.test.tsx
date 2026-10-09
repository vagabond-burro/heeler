import { describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { Splash, QUOTES } from "../ui/splash";
import { BOOT_STEPS, reduce, type State } from "../state";
import { initialState } from "../data";

describe("startup splash", () => {
  it("shows a dog line and the real step it is on", () => {
    render(<Splash boot={{ step: "photos", detail: "248 in JUNE-2023" }} onDone={() => {}} />);
    expect(QUOTES).toContain(screen.getByTestId("splash-quote").textContent);
    // The concrete part is what makes it feedback rather than decoration.
    expect(screen.getByTestId("splash-step")).toHaveTextContent(/lining up the photos/i);
    expect(screen.getByTestId("splash-detail")).toHaveTextContent("248 in JUNE-2023");
  });

  it("fills the progress up to the current step and no further", () => {
    render(<Splash boot={{ step: "folders", detail: "" }} onDone={() => {}} />);
    const filled = (s: string) => screen.getByTestId(`splash-seg-${s}`).getAttribute("data-filled");
    expect(filled("catalog")).toBe("true");
    expect(filled("folders")).toBe("true");
    expect(filled("photos")).toBe("false");
    expect(filled("image")).toBe("false");
  });

  it("rotates the line while a slow boot grinds on", () => {
    vi.useFakeTimers();
    try {
      render(<Splash boot={{ step: "catalog", detail: "" }} onDone={() => {}} />);
      const first = screen.getByTestId("splash-quote").textContent;
      act(() => void vi.advanceTimersByTime(2500));
      const second = screen.getByTestId("splash-quote").textContent;
      expect(second).not.toBe(first);
      expect(QUOTES).toContain(second);
    } finally {
      vi.useRealTimers();
    }
  });

  it("hands over once the boot reaches ready", () => {
    vi.useFakeTimers();
    try {
      const onDone = vi.fn();
      render(<Splash boot={{ step: "ready", detail: "" }} onDone={onDone} />);
      // Fades first, so the app is not revealed by a hard cut.
      expect(screen.getByTestId("splash")).toHaveStyle({ opacity: "0" });
      expect(onDone).not.toHaveBeenCalled();
      act(() => void vi.advanceTimersByTime(500));
      expect(onDone).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("boot progress state", () => {
  const run = (s: State, ...cmds: Parameters<typeof reduce>[1][]) => cmds.reduce(reduce, s);

  it("starts with no splash in the browser build", () => {
    // Nothing to wait for without a catalog, so no splash is correct.
    expect(initialState().boot).toBeNull();
  });

  it("never walks the progress backwards", () => {
    // Real boots interleave: a folder listing can resolve after the
    // photos step already started. The bar must not jump back.
    let s = run(initialState(), { type: "boot_step", step: "photos", detail: "248" });
    s = run(s, { type: "boot_step", step: "folders", detail: "late" });
    expect(s.boot).toEqual({ step: "photos", detail: "248" });
    // Forward still moves.
    s = run(s, { type: "boot_step", step: "image", detail: "DSC_04871.NEF" });
    expect(s.boot!.step).toBe("image");
  });

  it("boot_done clears the splash for good", () => {
    let s = run(initialState(), { type: "boot_step", step: "catalog" });
    expect(s.boot).not.toBeNull();
    s = run(s, { type: "boot_done" });
    expect(s.boot).toBeNull();
  });

  it("every boot step has a label to show", async () => {
    const { BOOT_LABEL } = await import("../state");
    for (const step of BOOT_STEPS) {
      expect(BOOT_LABEL[step], `${step} has no label`).toBeTruthy();
    }
  });
});
