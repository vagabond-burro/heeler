// The Color Tune's two faces.
//
// "Not enough room for the slider with the full name on the
// labels. When this is the panel it should be the first letter... Use
// the full name on the popout." Both the Adjustments section and the
// graph inspector are panels; only the tool window gets the full words.
// The graph inspector shipped without the compact flag once, and the
// full names crushed the sliders at 280px, so both directions are
// pinned.

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { initialState } from "../data";
import { ColorConsoleBlock } from "../ui/colorconsole";
import { NodeParams } from "../ui/graph";

const consoleNode = () => {
  const n = initialState().nodes.find((k) => k.type === "heeler.color_console");
  if (!n) throw new Error("the default graph lost its Color Tune");
  return n;
};

describe("the Color Tune's slider labels", () => {
  it("the graph inspector is a panel: single letters, full name in aria", () => {
    render(<NodeParams node={consoleNode()} dispatch={() => {}} />);
    // The control is still findable by its full name (accessibility
    // keeps the words), but the visible cell is one letter wide.
    expect(screen.getByLabelText("Saturation")).toBeTruthy();
    expect(screen.queryByText("Saturation")).toBeNull();
    expect(screen.queryByText("Vibrance")).toBeNull();
    expect(screen.getByText("S")).toBeTruthy();
    expect(screen.getByText("V")).toBeTruthy();
  });

  it("the full-width face spells the names out", () => {
    render(
      <ColorConsoleBlock
        node={consoleNode()}
        dispatch={() => {}}
        width={480}
        band="red"
        onBand={() => {}}
      />,
    );
    expect(screen.getByText("Saturation")).toBeTruthy();
    expect(screen.getByText("Vibrance")).toBeTruthy();
  });
});

// The band strip and the custom band list (2026-09-04): custom bands
// stacking up as chips pushed the view buttons around, so the strip
// is the six fixed bands in two families plus one picker icon, and
// custom bands live in a list under the wheel: name, picker, delete,
// with the header naming unnamed bands by their color.

import { fireEvent, within } from "@testing-library/react";
import { parseConsoleBands } from "../consolebands";
import type { Command } from "../state";

const withCustoms = (n: number) => {
  const node = { ...consoleNode() };
  const bands = [];
  for (let i = 1; i <= n; i++) {
    bands.push({ id: `c${i}`, center: 30 + i * 10, rgb: [200 + i, 90, 60] });
  }
  node.textParams = { ...node.textParams, bands: JSON.stringify(bands) };
  return node;
};

describe("the Color Tune's band strip", () => {
  it("groups R G B, then C M Y, then one picker icon, with no custom chips", () => {
    const onTogglePick = vi.fn();
    render(
      <ColorConsoleBlock
        node={withCustoms(2)}
        dispatch={() => {}}
        band="r"
        onBand={() => {}}
        onTogglePick={onTogglePick}
        nameFormat="rgb"
        onNameFormat={() => {}}
      />,
    );
    const strip = screen.getByTestId("console-band-strip");
    const chips = within(strip)
      .getAllByRole("button", { pressed: false })
      .filter((b) => b.dataset.testid?.startsWith("console-band-"))
      .map((b) => b.textContent);
    expect(chips).toEqual(["G", "B", "C", "M", "Y"]);
    expect(within(strip).getByTestId("console-band-r").textContent).toBe("R");
    // The picker is a glyph, not a word, and it arms a NEW band.
    const picker = within(strip).getByTestId("console-add-custom");
    expect(picker.textContent).toBe("");
    expect(screen.queryByText("+ PICK")).toBeNull();
    fireEvent.click(picker);
    expect(onTogglePick).toHaveBeenCalledWith();
    // Custom bands are not chips in the strip.
    expect(within(strip).queryByTestId("console-band-c1")).toBeNull();
  });

  it("grays the picker when the custom bands are full, and says so", () => {
    render(
      <ColorConsoleBlock
        node={withCustoms(2)}
        dispatch={() => {}}
        band="r"
        onBand={() => {}}
        onTogglePick={() => {}}
        customMax={2}
      />,
    );
    const picker = screen.getByTestId("console-add-custom") as HTMLButtonElement;
    expect(picker.disabled).toBe(true);
    expect(picker.parentElement?.getAttribute("data-hint")).toMatch(/Preferences/);
  });
});

describe("the Color Tune's custom band list", () => {
  it("is absent with no custom bands and names them by color otherwise", () => {
    const { unmount } = render(
      <ColorConsoleBlock node={consoleNode()} dispatch={() => {}} band="r" onBand={() => {}} />,
    );
    expect(screen.queryByTestId("console-custom-list")).toBeNull();
    unmount();
    render(
      <ColorConsoleBlock
        node={withCustoms(2)}
        dispatch={() => {}}
        band="c2"
        onBand={() => {}}
        nameFormat="rgb"
        onNameFormat={() => {}}
      />,
    );
    expect(screen.getByTestId("console-custom-name-c1").textContent).toBe("201 90 60");
    expect(screen.getByTestId("console-custom-name-c2").textContent).toBe("202 90 60");
    // The active band's row is the pressed one.
    expect(screen.getByTestId("console-custom-name-c2").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("console-custom-name-c1").getAttribute("aria-pressed")).toBe("false");
    // The list holds five rows before it scrolls.
    const rows = screen.getByTestId("console-custom-c1").parentElement!;
    expect(rows.style.overflowY).toBe("auto");
    // Five panel rows of 20px; the sixth band scrolls.
    expect(rows.style.maxHeight).toBe("100px");
  });

  it("the header cycles RGB, CMY, hex, through the preference when it has one", () => {
    const onNameFormat = vi.fn();
    const { rerender } = render(
      <ColorConsoleBlock
        node={withCustoms(1)}
        dispatch={() => {}}
        band="r"
        onBand={() => {}}
        nameFormat="rgb"
        onNameFormat={onNameFormat}
      />,
    );
    const header = screen.getByTestId("console-name-format");
    expect(header.textContent).toBe("RGB");
    fireEvent.click(header);
    expect(onNameFormat).toHaveBeenCalledWith("cmy");
    rerender(
      <ColorConsoleBlock
        node={withCustoms(1)}
        dispatch={() => {}}
        band="r"
        onBand={() => {}}
        nameFormat="hex"
        onNameFormat={onNameFormat}
      />,
    );
    expect(screen.getByTestId("console-name-format").textContent).toBe("HEX");
    expect(screen.getByTestId("console-custom-name-c1").textContent).toBe("#C95A3C");
    fireEvent.click(screen.getByTestId("console-name-format"));
    expect(onNameFormat).toHaveBeenLastCalledWith("rgb");
  });

  it("without a preference the header cycles on its own", () => {
    render(<ColorConsoleBlock node={withCustoms(1)} dispatch={() => {}} band="r" onBand={() => {}} />);
    fireEvent.click(screen.getByTestId("console-name-format"));
    expect(screen.getByTestId("console-name-format").textContent).toBe("CMY");
    expect(screen.getByTestId("console-custom-name-c1").textContent).toBe("21% 65% 76%");
  });

  it("the edit icon names a band, Enter keeps it, Escape does not, blank clears it", () => {
    const commands: Command[] = [];
    const node = withCustoms(1);
    render(
      <ColorConsoleBlock node={node} dispatch={(c) => commands.push(c)} band="r" onBand={() => {}} />,
    );
    fireEvent.click(screen.getByTestId("console-rename-c1"));
    const input = screen.getByTestId("console-rename-input-c1") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Bride's skin" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.blur(input);
    const written = commands.find((c) => c.type === "set_text_param");
    expect(written && written.type === "set_text_param" && parseConsoleBands(written.value)[0].name).toBe(
      "Bride's skin",
    );
    // Escape walks away without writing.
    commands.length = 0;
    fireEvent.click(screen.getByTestId("console-rename-c1"));
    const again = screen.getByTestId("console-rename-input-c1") as HTMLInputElement;
    fireEvent.change(again, { target: { value: "nope" } });
    fireEvent.keyDown(again, { key: "Escape" });
    fireEvent.blur(again);
    expect(commands.find((c) => c.type === "set_text_param")).toBeUndefined();
    expect(screen.queryByTestId("console-rename-input-c1")).toBeNull();
  });

  it("a named band shows its name and a blank name goes back to the color", () => {
    const commands: Command[] = [];
    const node = withCustoms(1);
    node.textParams = {
      ...node.textParams,
      bands: JSON.stringify([{ id: "c1", center: 40, rgb: [201, 90, 60], name: "Sky" }]),
    };
    render(
      <ColorConsoleBlock
        node={node}
        dispatch={(c) => commands.push(c)}
        band="r"
        onBand={() => {}}
        nameFormat="hex"
        onNameFormat={() => {}}
      />,
    );
    expect(screen.getByTestId("console-custom-name-c1").textContent).toBe("Sky");
    fireEvent.click(screen.getByTestId("console-rename-c1"));
    const input = screen.getByTestId("console-rename-input-c1") as HTMLInputElement;
    expect(input.value).toBe("Sky");
    fireEvent.change(input, { target: { value: "  " } });
    fireEvent.blur(input);
    const written = commands.find((c) => c.type === "set_text_param");
    expect(written && written.type === "set_text_param" && parseConsoleBands(written.value)[0]).toEqual({
      id: "c1",
      center: 40,
      rgb: [201, 90, 60],
    });
  });

  it("a row's picker arms a move of THAT band, and its cross deletes it", () => {
    const commands: Command[] = [];
    const onTogglePick = vi.fn();
    const onBand = vi.fn();
    render(
      <ColorConsoleBlock
        node={withCustoms(2)}
        dispatch={(c) => commands.push(c)}
        band="c1"
        onBand={onBand}
        pickArmed
        pickBand="c2"
        onTogglePick={onTogglePick}
      />,
    );
    // The armed move shows on its row, not on the strip's picker.
    expect(screen.getByTestId("console-repick-c2").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("console-add-custom").getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(screen.getByTestId("console-repick-c1"));
    expect(onTogglePick).toHaveBeenCalledWith("c1");
    // Deleting the active band falls back to red; the other band stays.
    fireEvent.click(screen.getByTestId("console-delete-c1"));
    const written = commands.find((c) => c.type === "set_text_param");
    expect(written && written.type === "set_text_param" && parseConsoleBands(written.value).map((b) => b.id)).toEqual(["c2"]);
    expect(onBand).toHaveBeenCalledWith("r");
    // The old DELETE BAND button under the sliders is gone: one seat.
    expect(screen.queryByText("DELETE BAND")).toBeNull();
    expect(screen.queryByTestId("console-delete-band")).toBeNull();
  });
});

// The same list in the pop-out window: the header still cycles through
// the preference, a delete still falls back to red, and the wheel's
// column makes room for the list or scrolls.
describe("the custom band list in the pop-out", () => {
  const windowed = (n: number, extra: Partial<Parameters<typeof ColorConsoleBlock>[0]> = {}) => (
    <ColorConsoleBlock
      node={withCustoms(n)}
      dispatch={(extra.dispatch as never) ?? (() => {})}
      band={extra.band ?? "r"}
      onBand={extra.onBand ?? (() => {})}
      onTogglePick={extra.onTogglePick ?? (() => {})}
      pickArmed={extra.pickArmed}
      pickBand={extra.pickBand}
      nameFormat={extra.nameFormat ?? "rgb"}
      onNameFormat={extra.onNameFormat ?? (() => {})}
      windowed
      width={420}
      height={280}
    />
  );

  it("the header cycles from the window too", () => {
    const onNameFormat = vi.fn();
    render(windowed(1, { onNameFormat }));
    fireEvent.click(screen.getByTestId("console-name-format"));
    expect(onNameFormat).toHaveBeenCalledWith("cmy");
  });

  it("deleting the active band from the window falls back to red", () => {
    const commands: Command[] = [];
    const onBand = vi.fn();
    render(windowed(2, { band: "c1", onBand, dispatch: (c: Command) => commands.push(c) as never }));
    fireEvent.click(screen.getByTestId("console-delete-c1"));
    const written = commands.find((c) => c.type === "set_text_param");
    expect(written && written.type === "set_text_param" && parseConsoleBands(written.value).map((b) => b.id)).toEqual(["c2"]);
    expect(onBand).toHaveBeenCalledWith("r");
  });

  it("a row's picker re-aims while the strip's new-band pick is armed", () => {
    const onTogglePick = vi.fn();
    render(windowed(1, { onTogglePick, pickArmed: true, pickBand: null }));
    // The strip's picker shows armed for a NEW band...
    expect(screen.getByTestId("console-add-custom").getAttribute("aria-pressed")).toBe("true");
    // ...and aiming at a row instead is one click, not two.
    fireEvent.click(screen.getByTestId("console-repick-c1"));
    expect(onTogglePick).toHaveBeenCalledWith("c1");
  });

  it("the wheel's column scrolls rather than clip at the smallest window with a full list", () => {
    // 280px is the floor toolwindow passes; eight custom bands is the
    // preference's ceiling. Wheel (floored at 180) plus five 26px rows
    // plus the header is taller than that, so the column must scroll:
    // plain centering would clip the wheel off the top.
    render(windowed(8));
    const left = screen.getByTestId("console-window-left");
    expect(left.style.overflowY).toBe("auto");
    expect(screen.getByTestId("console-custom-list")).toBeTruthy();
  });
});

// The band pad's drag (first-pass review, 26.3.2): the band pad's drag is one gesture from
// press to release. It ended on mouse-leave, so a drag grazing the rim
// stopped short of full strength and the moves back inside wrote an
// undo step each.
describe("the band pad's drag", () => {
  it("begins on press and ends on release, not at the rim", async () => {
    const { fireEvent } = await import("@testing-library/react");
    const sent: { type: string }[] = [];
    render(<ColorConsoleBlock node={consoleNode()} dispatch={((c: { type: string }) => sent.push(c)) as never} band="r" onBand={() => {}} />);
    const pad = screen.getByTestId("console-pad-r");
    fireEvent.pointerDown(pad, { pointerId: 1, clientX: 5, clientY: 5 });
    fireEvent.pointerLeave(pad, { pointerId: 1 });
    fireEvent.mouseLeave(pad);
    expect(sent.filter((c) => c.type === "begin_gesture")).toHaveLength(1);
    expect(sent.some((c) => c.type === "end_gesture")).toBe(false);
    fireEvent.pointerUp(pad, { pointerId: 1 });
    expect(sent.filter((c) => c.type === "end_gesture")).toHaveLength(1);
  });
});

// Second pass, 26.3.2: the pad and the band sliders get the rest of the
// gesture contract the Color Wheels pass gave the Wheel (one owner per
// gesture, focus on press, a cancel closes once), the puck reads where
// it is drawn, the arrows step the way they point on screen, and the
// face bridge names the hues the pad's gradient actually shows.
import { faceAngleToOkHue, okHueToFaceAngle } from "../consolebands";

const padNode = (wheel: [number, number]) => {
  const n = consoleNode();
  n.textParams = { ...n.textParams, bands: JSON.stringify([{ id: "r", wheel }]) };
  return n;
};

const mountPad = (wheel: [number, number]) => {
  const sent: Command[] = [];
  const view = render(
    <ColorConsoleBlock
      node={padNode(wheel)}
      dispatch={(c) => sent.push(c)}
      band="r"
      onBand={() => {}}
    />,
  );
  const lastWheel = (): [number, number] | undefined => {
    const c = [...sent].reverse().find((x) => x.type === "set_text_param");
    if (!c || c.type !== "set_text_param") return undefined;
    return parseConsoleBands(c.value)[0]?.wheel;
  };
  return { sent, lastWheel, pad: screen.getByTestId("console-pad-r"), unmount: view.unmount };
};

/** Where the puck is drawn for a wheel value, in the pad's own screen
 * frame (y down, three o'clock is 0 degrees): strength at 42 percent of
 * the width, along the face angle of the wheel's OkLab hue. */
const puckScreen = (wheel: [number, number]) => {
  const strength = Math.hypot(wheel[0], wheel[1]);
  const okHue = ((Math.atan2(wheel[1], wheel[0]) * 180) / Math.PI + 360) % 360;
  const faceDeg = okHueToFaceAngle(okHue);
  return {
    x: strength * Math.cos((faceDeg * Math.PI) / 180),
    y: strength * Math.sin((faceDeg * Math.PI) / 180),
  };
};

describe("the band pad owns its gesture", () => {
  it("ignores a secondary press and a move that did not start here", () => {
    const { sent, pad } = mountPad([0, 0]);
    fireEvent(pad, new MouseEvent("pointerdown", { button: 2, buttons: 2, bubbles: true }));
    fireEvent.pointerMove(pad, { buttons: 1, pointerId: 1, clientX: 9, clientY: 9 });
    expect(sent).toHaveLength(0);
  });

  it("focuses on press and a cancel closes the gesture exactly once", () => {
    const { sent, pad } = mountPad([0, 0]);
    fireEvent.pointerDown(pad, { button: 0, pointerId: 1, clientX: 5, clientY: 5 });
    expect(pad).toHaveFocus();
    fireEvent.pointerCancel(pad, { pointerId: 1 });
    fireEvent.lostPointerCapture(pad, { pointerId: 1 });
    fireEvent.pointerUp(pad, { pointerId: 1 });
    expect(sent.filter((c) => c.type === "end_gesture")).toHaveLength(1);
  });

  it("a second pointer's release does not end the first's drag", () => {
    const { sent, pad } = mountPad([0, 0]);
    const pointer = (type: string, id: number) => {
      const event = new MouseEvent(type, { button: 0, bubbles: true });
      Object.defineProperty(event, "pointerId", { value: id });
      fireEvent(pad, event);
    };
    pointer("pointerdown", 1);
    pointer("pointerup", 2);
    expect(sent.filter((c) => c.type === "end_gesture")).toHaveLength(0);
    pointer("pointerup", 1);
    expect(sent.filter((c) => c.type === "end_gesture")).toHaveLength(1);
  });

  it.each(["Saturation", "Width"])("the %s slider keeps ownership when a second pointer releases", (label) => {
    const sent: Command[] = [];
    const node = padNode([0, 0]);
    node.textParams = {
      ...node.textParams,
      bands: JSON.stringify([{ id: "c1", center: 40, rgb: [200, 90, 60] }]),
    };
    render(<ColorConsoleBlock node={node} dispatch={(c) => sent.push(c)} band="c1" onBand={() => {}} />);
    const slider = screen.getByLabelText(label);
    const pointer = (type: string, id: number) => {
      const event = new MouseEvent(type, { button: 0, bubbles: true });
      Object.defineProperty(event, "pointerId", { value: id });
      fireEvent(slider, event);
    };
    pointer("pointerdown", 1);
    pointer("pointerup", 2);
    expect(sent.filter((c) => c.type === "end_gesture")).toHaveLength(0);
    pointer("pointercancel", 1);
    pointer("lostpointercapture", 1);
    expect(sent.filter((c) => c.type === "end_gesture")).toHaveLength(1);
  });
});

describe("the puck reads where it is drawn", () => {
  it("grabbing the drawn full-strength puck writes full strength, not 0.84", () => {
    const wheel: [number, number] = [1, 0];
    const { lastWheel, pad } = mountPad(wheel);
    const size = 100;
    pad.getBoundingClientRect = () => ({ left: 0, top: 0, width: size, height: size } as DOMRect);
    const p = puckScreen(wheel);
    fireEvent(
      pad,
      new MouseEvent("pointerdown", {
        button: 0,
        clientX: size / 2 + size * 0.42 * p.x,
        clientY: size / 2 + size * 0.42 * p.y,
        bubbles: true,
      }),
    );
    const written = lastWheel();
    expect(written).toBeDefined();
    expect(Math.hypot(written![0], written![1])).toBeGreaterThan(0.99);
  });
});

describe("the pad's arrows move the puck the way they point", () => {
  const arrows: [string, number][] = [
    ["ArrowRight", 0],
    ["ArrowUp", -90],
    ["ArrowLeft", 180],
    ["ArrowDown", 90],
  ];
  it.each(arrows)("%s steps on screen within a degree of where it points", (key, wantDeg) => {
    for (const okHue of [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330]) {
      const wheel: [number, number] = [0.5 * Math.cos((okHue * Math.PI) / 180), 0.5 * Math.sin((okHue * Math.PI) / 180)];
      const before = puckScreen(wheel);
      const { lastWheel, pad, unmount } = mountPad(wheel);
      fireEvent.keyDown(pad, { key });
      const written = lastWheel();
      expect(written, `hue ${okHue} wrote nothing`).toBeDefined();
      const after = puckScreen(written!);
      unmount();
      const moved = (Math.atan2(after.y - before.y, after.x - before.x) * 180) / Math.PI;
      let d = Math.abs(((moved - wantDeg) % 360 + 360) % 360);
      if (d > 180) d = 360 - d;
      expect(d, `hue ${okHue}: ${key} moved the puck ${moved.toFixed(1)} degrees on screen`).toBeLessThan(1);
    }
  });
});

describe("the face bridge names the colors the pad shows", () => {
  // sRGB to OkLab hue, the published Ottosson matrices, kept local so
  // the test measures the gradient rather than trusting the bridge.
  const okHueOf = (hex: string): number => {
    const [r8, g8, b8] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
    const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
    const [r, g, b] = [lin(r8), lin(g8), lin(b8)];
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
    const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
    return ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360;
  };
  const blend = (h0: string, h1: string): string => {
    const ch = [1, 3, 5].map((i) =>
      Math.round((parseInt(h0.slice(i, i + 2), 16) + parseInt(h1.slice(i, i + 2), 16)) / 2)
        .toString(16)
        .padStart(2, "0"),
    );
    return `#${ch.join("")}`;
  };
  const circularDiff = (a: number, b: number) => {
    let d = Math.abs(((a - b) % 360 + 360) % 360);
    return d > 180 ? 360 - d : d;
  };

  it("stays within three degrees of the gradient at its stops and blends", () => {
    const { pad } = mountPad([0, 0]);
    const stops = pad.style.background.match(/#[0-9a-f]{6}/gi)!;
    expect(stops).toHaveLength(7);
    for (let i = 0; i < 6; i++) {
      const named = faceAngleToOkHue(i * 60);
      expect(circularDiff(okHueOf(stops[i]), named), `stop ${i} shows ${okHueOf(stops[i]).toFixed(1)}`).toBeLessThanOrEqual(3);
      const namedMid = faceAngleToOkHue(i * 60 + 30);
      const shownMid = okHueOf(blend(stops[i], stops[i + 1]));
      expect(circularDiff(shownMid, namedMid), `blend ${i} shows ${shownMid.toFixed(1)}`).toBeLessThanOrEqual(3);
    }
  });
});
