// The Tone Profile's switch in Source (2026-10-08, on a fresh bake:
// "profile curve is on in the settings, but I also noted that when I
// flipped it to Linear that there was no change"). A bake, a JPEG, a
// phone DNG and a composite of finished pictures are born with the
// profile node switched off; Source drew its rows as if it were on,
// with no switch to show it or turn it on, so its controls did nothing.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../app";
import { initialState } from "../data";
import { reduce, type State } from "../state";
import { navSections } from "../ui/simple";

afterEach(() => cleanup());

function openSource() {
  const fold = screen.getByTestId("collapse-source");
  if (fold.getAttribute("data-open") !== "true") fireEvent.click(fold);
}

describe("Source's Tone profile switch", () => {
  it("shows the profile on or off, and its rows only while it is on", () => {
    render(<App />);
    openSource();
    const sw = screen.getByTestId("source-tone-profile-on");
    expect(sw).toHaveAttribute("aria-checked", "true");
    expect(screen.getByTestId("tone-profile")).toBeInTheDocument();
    expect(screen.getByRole("slider", { name: /baseline/i })).toBeInTheDocument();
    fireEvent.click(sw);
    expect(screen.getByTestId("source-tone-profile-on")).toHaveAttribute("aria-checked", "false");
    expect(screen.queryByTestId("tone-profile")).not.toBeInTheDocument();
    expect(screen.queryByRole("slider", { name: /baseline/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("source-tone-profile-on"));
    expect(screen.getByTestId("source-tone-profile-on")).toHaveAttribute("aria-checked", "true");
    expect(screen.getByTestId("tone-profile")).toBeInTheDocument();
  });

  it("is one undo step and offers the keyboard no profile rows while off", () => {
    const s0: State = initialState();
    const profile = s0.nodes.find((n) => n.type === "heeler.tone_profile")!;
    const rowsOf = (s: State) => navSections(s).find((sec) => sec.section === "Source")?.targets.map((t) => t.label) ?? [];
    expect(rowsOf(s0)).toContain("Baseline");
    const off = reduce(s0, { type: "set_enabled", id: profile.id, enabled: false });
    expect(rowsOf(off)).not.toContain("Baseline");
    expect(rowsOf(off)).not.toContain("Profile amt");
    const back = reduce(off, { type: "undo" });
    expect(back.nodes.find((n) => n.id === profile.id)!.enabled).not.toBe(false);
  });
});

// 2026-10-08: "Reset should not set the tone profile active if the
// metadata in the XMP says otherwise." A bake, a JPEG or a phone DNG is
// born with the profile off; Source's Reset puts the profile's numbers
// back and leaves its switch where it is: off stays off, and one the
// user switched on stays on (Reset changes values, never what is
// switched on).
describe("Source's Reset and the Tone profile switch", () => {
  it("leaves a profile that is off switched off, and one that is on switched on", () => {
    render(<App />);
    openSource();
    fireEvent.click(screen.getByTestId("source-tone-profile-on"));
    expect(screen.getByTestId("source-tone-profile-on")).toHaveAttribute("aria-checked", "false");
    fireEvent.click(screen.getByTestId("reset-source"));
    expect(screen.getByTestId("source-tone-profile-on"), "Reset turned the profile on").toHaveAttribute("aria-checked", "false");
    fireEvent.click(screen.getByTestId("source-tone-profile-on"));
    fireEvent.click(screen.getByTestId("reset-source"));
    expect(screen.getByTestId("source-tone-profile-on")).toHaveAttribute("aria-checked", "true");
  });
});
