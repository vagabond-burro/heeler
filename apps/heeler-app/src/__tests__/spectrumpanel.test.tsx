// The Spectrums panel: the parts that are not pixels.
//
// jsdom has no canvas, so the drawing itself is not testable here and
// the arithmetic underneath it lives in spectrums.test.ts. What is
// testable is the chrome around the plot: the tabs, the status readout,
// and the bar that brings a popped-out window home.

import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "../app";
import { describe, expect, it, vi } from "vitest";
import { initialState } from "../data";
import { SpectrumBar, Spectrums, readout, type Frame } from "../ui/spectrum";
import { CurveEditor } from "../ui/editors";
import { CHANNEL_CHIPS, CHIP_METRICS, CHIP_METRICS_LARGE } from "../ui/channelchips";
import { HARMONY_MODES } from "../harmony";
import { reduce, type CurveChannel } from "../state";
import {
  histogram,
  LEVELS,
  SPECTRUM_KINDS,
  type Histogram,
} from "../spectrums";

/** A frame of one flat color, so every readout has one right answer. */
function flat(r: number, g: number, b: number, w = 8, h = 4): Frame {
  const pixels = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    pixels[i * 4] = r;
    pixels[i * 4 + 1] = g;
    pixels[i * 4 + 2] = b;
    pixels[i * 4 + 3] = 255;
  }
  return { pixels, w, h };
}

const histOf = (f: Frame): Histogram => histogram(f.pixels, 1);

describe("spectrum readout", () => {
  it("says nothing without a cursor or without a frame", () => {
    const f = flat(128, 128, 128);
    expect(readout("histogram", "rgb", f, histOf(f), null)).toBeNull();
    expect(
      readout("histogram", "rgb", null, null, { x: 0.5, y: 0.5 }),
    ).toBeNull();
  });

  it("reads the histogram across the level axis", () => {
    const f = flat(255, 255, 255);
    const h = histOf(f);
    // Far right of the plot is the top level, and a white frame has all
    // of its pixels there.
    const right = readout("histogram", "rgb", f, h, { x: 1, y: 0.5 })!;
    expect(right).toContain(`level ${LEVELS - 1}`);
    expect(right).toContain("R 100.00%");
    // Far left is level zero, where a white frame has nothing.
    expect(readout("histogram", "rgb", f, h, { x: 0, y: 0.5 })!).toContain(
      "R 0.00%",
    );
  });

  it("names the channel and the count when one channel is showing", () => {
    const f = flat(0, 255, 0);
    const out = readout("histogram", "g", f, histOf(f), { x: 1, y: 0.5 })!;
    expect(out).toContain("G 100.00%");
    expect(out).toContain(`(${f.w * f.h} px)`);
  });

  it("turns a vectorscope position back into a hue and a saturation", () => {
    const f = flat(128, 128, 128);
    // Dead center is gray: no saturation at all.
    expect(readout("vector", "rgb", f, null, { x: 0.5, y: 0.5 })!).toContain(
      "saturation 0%",
    );
    // Straight right is 0 degrees, straight up is 90, since the plot's y
    // axis runs downwards and the angle does not.
    expect(readout("vector", "rgb", f, null, { x: 1, y: 0.5 })!).toContain(
      "hue 0°",
    );
    expect(readout("vector", "rgb", f, null, { x: 0.5, y: 0 })!).toContain(
      "hue 90°",
    );
    // Past the ring reads as fully saturated rather than as more than
    // fully saturated.
    expect(readout("vector", "rgb", f, null, { x: 1, y: 1 })!).toContain(
      "saturation 100%",
    );
  });

  it("gives the parade a band, a column and a level", () => {
    const f = flat(10, 20, 30, 100, 10);
    // Three bands across: left third is red, middle green, right blue.
    expect(readout("parade", "rgb", f, null, { x: 0.1, y: 0.5 })!).toContain(
      "Red",
    );
    expect(readout("parade", "rgb", f, null, { x: 0.5, y: 0.5 })!).toContain(
      "Green",
    );
    expect(readout("parade", "rgb", f, null, { x: 0.9, y: 0.5 })!).toContain(
      "Blue",
    );
    // Within a band the x runs across the whole frame, not across the
    // band: the left edge of the green band is the left of the picture.
    expect(readout("parade", "rgb", f, null, { x: 1 / 3, y: 0.5 })!).toContain(
      "x 0 of 100",
    );
    // The level axis runs up, so the bottom of the plot is level zero.
    expect(readout("parade", "rgb", f, null, { x: 0.1, y: 1 })!).toContain(
      "level 0",
    );
    expect(readout("parade", "rgb", f, null, { x: 0.1, y: 0 })!).toContain(
      `level ${LEVELS - 1}`,
    );
  });

  it("gives the waveform one band, the whole width", () => {
    const f = flat(200, 200, 200, 64, 8);
    const out = readout("waveform", "rgb", f, null, { x: 0.5, y: 0.5 })!;
    expect(out).toContain("Luma");
    expect(out).toContain("of 64");
  });
});

describe("spectrum panel", () => {
  it("offers every kind, and switching one selects it", () => {
    render(<Spectrums state={initialState()} frame={null} />);
    for (const k of SPECTRUM_KINDS) {
      expect(screen.getByTestId(`spectrum-${k.id}`)).toBeInTheDocument();
    }
    expect(screen.getByTestId("spectrum-histogram")).toHaveAttribute("data-active", "true");
    fireEvent.click(screen.getByTestId("spectrum-parade"));
    expect(screen.getByTestId("spectrum-parade")).toHaveAttribute("data-active", "true");
    expect(screen.getByTestId("spectrum-histogram")).toHaveAttribute("data-active", "false");
  });

  /// 2026-08-27: "The type buttons (Hist, RGB, Wave, etc) should have
  /// the labels replaced with icons. The text is small and can be hard
  /// to read." The panel never had room for the real names, so it showed
  /// four-letter abbreviations; now it shows the plot's own shape and
  /// keeps the name where a screen reader and a hint can reach it.
  it("shows icons in the panel and the icon with its name in the window", () => {
    const { unmount } = render(<Spectrums state={initialState()} frame={null} />);
    const inPanel = screen.getByTestId("spectrum-parade");
    expect(inPanel).toHaveTextContent("");
    expect(screen.getByTestId("icon-spectrum-parade")).toBeInTheDocument();
    // Losing the word must not lose the name.
    expect(inPanel).toHaveAttribute("aria-label", "RGB Parade");
    expect(inPanel.getAttribute("data-hint")).toContain("RGB Parade");
    unmount();

    // The window has the room, and is where the icons get learned.
    render(<Spectrums state={initialState()} frame={null} fill />);
    expect(screen.getByTestId("spectrum-parade")).toHaveTextContent("RGB Parade");
    expect(screen.getByTestId("icon-spectrum-parade")).toBeInTheDocument();
  });

  it("draws a distinct icon for every kind", () => {
    render(<Spectrums state={initialState()} frame={null} />);
    for (const k of SPECTRUM_KINDS) {
      expect(screen.getByTestId(`icon-spectrum-${k.id}`)).toBeInTheDocument();
      expect(screen.getByTestId(`spectrum-${k.id}`)).toHaveAttribute("aria-label", k.label);
    }
  });

  it("hides the channel picker on a parade rather than removing it", () => {
    // Removing it moved the plot up and down as the kind changed. It
    // belongs to the histogram alone: a parade is already every channel.
    render(<Spectrums state={initialState()} frame={null} />);
    const group = () => screen.getByTestId("spectrum-channel-luma").parentElement!;
    expect(group()).toHaveStyle({ visibility: "visible" });
    fireEvent.click(screen.getByTestId("spectrum-parade"));
    expect(group()).toHaveStyle({ visibility: "hidden" });
    expect(group()).toHaveAttribute("aria-hidden", "true");
  });

  it("says so when there is no frame rather than showing an empty bar", () => {
    render(<Spectrums state={initialState()} frame={null} />);
    expect(screen.getByTestId("spectrum-status")).toHaveTextContent(
      /no frame yet/i,
    );
  });

  it("pops out on request", () => {
    const onPopOut = vi.fn();
    render(
      <Spectrums state={initialState()} frame={null} onPopOut={onPopOut} />,
    );
    fireEvent.click(screen.getByTestId("spectrums-popout"));
    expect(onPopOut).toHaveBeenCalled();
  });

  it("the bar is the way back from a popped-out window", () => {
    const dispatch = vi.fn();
    render(<SpectrumBar dispatch={dispatch} />);
    fireEvent.click(screen.getByTestId("spectrum-bar"));
    expect(dispatch).toHaveBeenCalledWith({
      type: "set_spectrums_popped_out",
      out: false,
    });
  });
});

describe("spectrums in the Inspector", () => {
  // "The spectrums need to be in the Inspector panel in
  // Graph & Canvas mode." They read the same frame the viewer is
  // showing, so the plot means the same thing wherever it is.
  const graphMode = async (user: ReturnType<typeof userEvent.setup>) =>
    user.click(screen.getByRole("tablist", { name: /workspace mode/i }).children[1]);
  const canvasMode = async (user: ReturnType<typeof userEvent.setup>) =>
    user.click(screen.getByRole("tablist", { name: /workspace mode/i }).children[2]);

  it("shows up in Graph mode", async () => {
    const user = userEvent.setup();
    render(<App />);
    await graphMode(user);
    const inspector = screen.getByTestId("inspector");
    expect(within(inspector).getByTestId("spectrums")).toBeInTheDocument();
    expect(within(inspector).getByTestId("spectrum-canvas")).toBeInTheDocument();
  });

  it("shows up in Canvas mode", async () => {
    const user = userEvent.setup();
    render(<App />);
    await canvasMode(user);
    // Canvas starts with the inspector folded to its bar, which is the
    // whole point of Canvas; open it the way a user would.
    await user.click(screen.getByTestId("inspector-bar"));
    const inspector = screen.getByTestId("inspector");
    expect(within(inspector).getByTestId("spectrums")).toBeInTheDocument();
  });

  it("is still in Develop, and only once per window", async () => {
    const user = userEvent.setup();
    render(<App />);
    // Develop keeps its own in the Adjustments panel.
    expect(screen.getAllByTestId("spectrums")).toHaveLength(1);
    await graphMode(user);
    // Graph has one, in the Inspector, not two.
    expect(screen.getAllByTestId("spectrums")).toHaveLength(1);
  });

  it("folds to the bar in the Inspector too when popped out", async () => {
    const user = userEvent.setup();
    render(<App />);
    await graphMode(user);
    await user.click(within(screen.getByTestId("inspector")).getByTestId("spectrums-popout"));
    const inspector = screen.getByTestId("inspector");
    expect(within(inspector).getByTestId("spectrum-bar")).toBeInTheDocument();
    expect(within(inspector).queryByTestId("spectrums")).not.toBeInTheDocument();
  });
});

/// 2026-08-27: "We essentially have (at least) 2 sets of buttons that
/// serve similar purposes but do not follow the same design
/// specification. I think how the RGB, R, G, B, and LUM buttons are in
/// Adjustments > Curves should be the standard."
///
/// So the two rows are asserted against each other rather than against
/// a paragraph: same labels, same size, same color when active.
describe("the channel row is one design, used twice", () => {
  /** The Curves editor on its own, with its own channel state: it picks
   * the channel internally, so the test clicks rather than passing one. */
  const curveRow = (pick?: CurveChannel) => {
    const node = initialState().nodes.find((n) => n.type === "heeler.curves")!;
    render(<CurveEditor node={node} dispatch={() => {}} />);
    if (pick) fireEvent.click(screen.getByTestId(`curve-channel-${pick}`));
  };

  it("labels them the same in both places, LUM included", () => {
    const { unmount } = render(<Spectrums state={initialState()} frame={null} />);
    const hist = CHANNEL_CHIPS.map((c) => screen.getByTestId(`spectrum-channel-${c.id}`).textContent);
    unmount();
    curveRow();
    const curves = CHANNEL_CHIPS.map((c) => screen.getByTestId(`curve-channel-${c.id}`).textContent);
    expect(hist).toEqual(curves);
    // The histogram used to call this one "Luma" on its own.
    expect(hist).toEqual(["RGB", "R", "G", "B", "LUM"]);
  });

  it("sizes them the same in both places", () => {
    const { unmount } = render(<Spectrums state={initialState()} frame={null} />);
    const hist = screen.getByTestId("spectrum-channel-r");
    const size = { padding: hist.style.padding, fontSize: hist.style.fontSize };
    expect(size).toEqual({ padding: "2px 8px", fontSize: "9px" });
    expect(hist).toHaveClass("chip");
    unmount();
    curveRow();
    const curve = screen.getByTestId("curve-channel-r");
    expect({ padding: curve.style.padding, fontSize: curve.style.fontSize }).toEqual(size);
    expect(curve).toHaveClass("chip");
  });

  /// The active button wears its OWN channel's color. Five buttons that
  /// all light up accent-blue say "something is selected" five times and
  /// never say which.
  it("lights the active one in its own channel's color, in both places", () => {
    // jsdom hands hex back as rgb(), so compare through it rather than
    // against the literal in the table.
    const hex = CHANNEL_CHIPS.find((c) => c.id === "r")!.color;
    const red = `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(", ")})`;
    const { unmount } = render(<Spectrums state={initialState()} frame={null} />);
    fireEvent.click(screen.getByTestId("spectrum-channel-r"));
    const hist = screen.getByTestId("spectrum-channel-r");
    expect(hist).toHaveAttribute("data-active", "true");
    expect(hist.style.color).toBe(red);
    expect(hist.style.borderColor).toBe(red);
    // And an inactive one is not a color at all. The grayness moved
    // into .chip.channel: written inline it was the one thing a:hover
    // rule could not lift, so a hovered off-channel got a brighter
    // background under unchanged lettering and read as washed out.
    const off = screen.getByTestId("spectrum-channel-g");
    expect(off.style.color).toBe("");
    expect(off).toHaveClass("channel");
    unmount();

    curveRow("r");
    const curve = screen.getByTestId("curve-channel-r");
    expect(curve.style.color).toBe(red);
    expect(curve.style.borderColor).toBe(red);
  });
});

/// 2026-08-27: the EV toggle "should be the same size as the RGB
/// buttons under histogram. And it should be left aligned", and the
/// harmony controls should fill the empty band above them and wear the
/// same chip.
describe("the second row of the panel", () => {
  const rowOf = (el: HTMLElement) => el.parentElement!;

  it("gives EV the channel chips' size and puts it first in the row", () => {
    render(<Spectrums state={initialState()} frame={null} />);
    fireEvent.click(screen.getByTestId("spectrum-waveform"));
    const ev = screen.getByText("EV");
    const channel = screen.getByTestId("spectrum-channel-r");
    expect({ padding: ev.style.padding, fontSize: ev.style.fontSize }).toEqual({
      padding: channel.style.padding,
      fontSize: channel.style.fontSize,
    });
    // Left aligned: the channel row keeps its space when it does not
    // apply, and EV sitting after it was indented by a picker's width.
    expect(rowOf(ev).firstElementChild).toBe(ev);
  });

  it("lights EV in the accent when it is on, the way every chip does", () => {
    render(<Spectrums state={initialState()} frame={null} />);
    fireEvent.click(screen.getByTestId("spectrum-parade"));
    const ev = screen.getByText("EV");
    expect(ev).not.toHaveAttribute("data-active", "true");
    fireEvent.click(ev);
    expect(screen.getByText("EV")).toHaveAttribute("data-active", "true");
    expect(screen.getByText("EV")).toHaveClass("chip");
  });

  /// The harmony wheel has controls of its own directly below, so
  /// reserving the channel row as well left a band of nothing.
  it("drops the reserved channel row on the harmony wheel", () => {
    render(<Spectrums state={initialState()} dispatch={() => {}} frame={null} />);
    expect(screen.getByTestId("spectrum-channel-r")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("spectrum-harmony"));
    expect(screen.queryByTestId("spectrum-channel-r")).toBeNull();
    expect(screen.getByTestId("harmony-controls")).toBeInTheDocument();
  });

  it("gives the harmony modes the same chip as the channels", () => {
    render(<Spectrums state={initialState()} dispatch={() => {}} frame={null} />);
    const channel = screen.getByTestId("spectrum-channel-r");
    // The scope picker is the other icon row in this panel, and an icon
    // wants less width than a word: the harmony chips match its box
    // rather than the channel chips' character-width one.
    const icons = screen.getByTestId("spectrum-vector");
    fireEvent.click(screen.getByTestId("spectrum-harmony"));
    for (const m of HARMONY_MODES) {
      const chip = screen.getByTestId(`harmony-${m.id}`);
      expect(chip).toHaveClass("chip");
      expect(chip.style.padding).toBe(icons.style.padding);
      expect(chip.style.fontSize).toBe(channel.style.fontSize);
      expect(screen.getByTestId(`icon-harmony-${m.id}`)).toBeInTheDocument();
      expect(chip).toHaveAttribute("aria-label", m.label);
    }
    // Accent when live, which is what .chip[data-active] draws: the
    // same look the EV toggle has.
    expect(screen.getByTestId("harmony-off")).toHaveAttribute("data-active", "true");
    expect(screen.getByTestId("harmony-triad")).toHaveAttribute("data-active", "false");
  });
});

/// 2026-08-27: the anchor degrees "should be below the graph and not
/// on top". It used to sit in the controls row, a number floating
/// over the control that sets it.
describe("the harmony anchor readout", () => {
  it("reads under the plot, with the other numbers", () => {
    render(<Spectrums state={initialState()} dispatch={() => {}} frame={null} />);
    fireEvent.click(screen.getByTestId("spectrum-harmony"));
    const anchor = screen.getByTestId("harmony-anchor");
    expect(anchor).toHaveTextContent(/ANCHOR \d+°/);
    // In the status row under the canvas, not in the controls above it.
    expect(screen.getByTestId("spectrum-status")).toContainElement(anchor);
    expect(screen.getByTestId("harmony-controls")).not.toContainElement(anchor);
  });

  it("belongs to the harmony wheel alone", () => {
    render(<Spectrums state={initialState()} dispatch={() => {}} frame={null} />);
    expect(screen.queryByTestId("harmony-anchor")).toBeNull();
    fireEvent.click(screen.getByTestId("spectrum-harmony"));
    expect(screen.getByTestId("harmony-anchor")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("spectrum-vector"));
    expect(screen.queryByTestId("harmony-anchor")).toBeNull();
  });
});

/// 2026-08-27: "The channel buttons should be the same height as the
/// buttons under Harmony", and the same for EV. A chip holding
/// nine-pixel text is shorter than one holding a thirteen-pixel icon
/// unless the line height says otherwise, which is what CHIP_METRICS is
/// for. jsdom lays nothing out, so the contract is asserted here and
/// the pixels were measured in the browser: 21.55, 21.55, 21.53.
describe("one height across the panel's chip rows", () => {
  it("gives the channel row, EV and the harmony families the same box", () => {
    render(<Spectrums state={initialState()} dispatch={() => {}} frame={null} />);
    const boxOf = (el: HTMLElement) => ({
      fontSize: el.style.fontSize,
      lineHeight: el.style.lineHeight,
      paddingTop: el.style.paddingTop,
      paddingBottom: el.style.paddingBottom,
    });
    const want = {
      fontSize: `${CHIP_METRICS.fontSize}px`,
      lineHeight: CHIP_METRICS.lineHeight,
      paddingTop: "2px",
      paddingBottom: "2px",
    };
    expect(boxOf(screen.getByTestId("spectrum-channel-r"))).toEqual(want);

    fireEvent.click(screen.getByTestId("spectrum-parade"));
    expect(boxOf(screen.getByText("EV"))).toEqual(want);

    fireEvent.click(screen.getByTestId("spectrum-harmony"));
    expect(boxOf(screen.getByTestId("harmony-triad"))).toEqual(want);
  });

  /// The Curves row is the same component, so it inherits the height:
  /// that is the point of the shared chip.
  it("carries the same box into the Curves editor", () => {
    const node = initialState().nodes.find((n) => n.type === "heeler.curves")!;
    render(<CurveEditor node={node} dispatch={() => {}} />);
    const chip = screen.getByTestId("curve-channel-r");
    expect(chip.style.lineHeight).toBe(CHIP_METRICS.lineHeight);
  });
});

/// The pop-out window plotted nothing while the panel beside it plotted
/// fine ("you broke pop out for the Spectrums... Nothing
/// displays"). The panel has always fallen back to the photograph's
/// thumbnail when the engine's frame is not ready; the window was sent
/// the engine frame or null, so the same photograph had scopes in one
/// place and an empty box in the other.
describe("the frame a window is given", () => {
  it("plots a fallback frame and says it is approximate", () => {
    render(<Spectrums state={initialState()} frame="data:image/png;base64,x" approx fill />);
    expect(screen.getByTestId("spectrum-status")).toHaveTextContent(/Approximate/);
  });

  it("says nothing extra once the engine's own frame is in", () => {
    render(<Spectrums state={initialState()} frame="data:image/png;base64,x" fill />);
    expect(screen.getByTestId("spectrum-status")).not.toHaveTextContent(/Approximate/);
  });

  it("still says so plainly when there is no frame at all", () => {
    render(<Spectrums state={initialState()} frame={null} fill />);
    expect(screen.getByTestId("spectrum-status")).toHaveTextContent(/No frame yet/);
  });

  /// "the buttons in the Spectrums popout could be scaled by
/// 1.25x".
  it("wears the larger chip in a window and the panel's in a panel", () => {
    const { unmount } = render(<Spectrums state={initialState()} frame={null} fill />);
    expect(screen.getByTestId("spectrum-channel-r").style.fontSize).toBe(
      `${CHIP_METRICS_LARGE.fontSize}px`,
    );
    unmount();
    render(<Spectrums state={initialState()} frame={null} />);
    expect(screen.getByTestId("spectrum-channel-r").style.fontSize).toBe(
      `${CHIP_METRICS.fontSize}px`,
    );
  });
});

describe("selection-scoped spectrums", () => {
  // "selection based spectrums... A button, maybe under
  // the bottom left corner, to toggle off a selected region
  // spectrum."
  const armedWithRegion = () => {
    let s = reduce(initialState(), { type: "arm_document_selection" });
    s = reduce(s, {
      type: "add_region",
      id: "sel_doc",
      region: { kind: "marquee", op: "replace", shape: "rect", x0: 0.25, y0: 0.25, x1: 0.75, y1: 0.75 },
    });
    return s;
  };

  it("the chip waits disabled until a selection exists, hint saying how", () => {
    render(<Spectrums state={initialState()} dispatch={() => {}} />);
    const chip = screen.getByTestId("spectrum-selection");
    expect(chip).toBeDisabled();
    expect(chip.getAttribute("data-hint")).toContain("Draw a selection first");
  });

  it("with a selection it toggles the scope and wears the accent seat", () => {
    const s = armedWithRegion();
    const got: unknown[] = [];
    const { rerender } = render(
      <Spectrums state={s} dispatch={(c) => got.push(c)} />,
    );
    const chip = screen.getByTestId("spectrum-selection");
    expect(chip).toBeEnabled();
    fireEvent.click(chip);
    expect(got).toContainEqual({ type: "toggle_spectrum_selection" });
    const on = reduce(s, { type: "toggle_spectrum_selection" });
    expect(on.spectrumSel).toBe(true);
    rerender(<Spectrums state={on} dispatch={() => {}} />);
    expect(
      screen.getByTestId("spectrum-selection").getAttribute("data-active"),
    ).toBe("true");
  });
});
