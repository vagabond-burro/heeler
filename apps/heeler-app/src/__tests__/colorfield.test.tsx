// The hex box is "for when you know the number", which means typing
// one. It was a controlled input bound straight to the canonical value
// with validation in onChange: every keystroke that was not yet a full
// six-digit hex was rejected, the prop never changed, and React snapped
// the text back. You could paste a color but never type one.
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useState } from "react";
import { ColorField, hexToHsv, hsvToHex } from "../ui/colorfield";

function Host({ initial }: { initial: string }) {
  const [value, setValue] = useState(initial);
  return <ColorField value={value} onChange={setValue} label="Color" testid="cf" />;
}

describe("ColorField", () => {
  it("lets you type a hex code character by character", () => {
    render(<Host initial="#000000" />);
    fireEvent.click(screen.getByTestId("cf"));
    const hex = screen.getByTestId("cf-hex") as HTMLInputElement;
    // Clear the field, then type f, f, 0...: every prefix must stay in
    // the box while it is not yet a color.
    fireEvent.change(hex, { target: { value: "" } });
    expect(hex.value).toBe("");
    fireEvent.change(hex, { target: { value: "f" } });
    expect(hex.value).toBe("f");
    fireEvent.change(hex, { target: { value: "ff" } });
    expect(hex.value).toBe("ff");
    fireEvent.change(hex, { target: { value: "ff0000" } });
    expect(hex.value).toBe("ff0000");
  });

  it("commits a complete hex, with or without the #", () => {
    render(<Host initial="#000000" />);
    fireEvent.click(screen.getByTestId("cf"));
    const hex = screen.getByTestId("cf-hex") as HTMLInputElement;
    fireEvent.change(hex, { target: { value: "ff0000" } });
    // The canonical value gains the # and the swatch follows.
    expect(screen.getByTestId("cf").getAttribute("data-value")).toBe("#ff0000");
  });

  it("rejects text that is not a color once the edit ends", () => {
    render(<Host initial="#123456" />);
    fireEvent.click(screen.getByTestId("cf"));
    const hex = screen.getByTestId("cf-hex") as HTMLInputElement;
    fireEvent.change(hex, { target: { value: "notacolor" } });
    // While editing, the draft is what was typed.
    expect(hex.value).toBe("notacolor");
    // Leaving the field on an invalid draft restores the color.
    fireEvent.blur(hex);
    expect(hex.value).toBe("#123456");
  });

  it("round-trips hex through hsv and back", () => {
    for (const hex of ["#000000", "#ffffff", "#ff0000", "#00ff88", "#8a5a3c", "#4e7ea8"]) {
      const [h, s, v] = hexToHsv(hex);
      expect(hsvToHex(h, s, v)).toBe(hex);
    }
  });

  it("brackets a drag in the field as one gesture", () => {
    let begun = 0;
    let ended = 0;
    render(
      <ColorField
        value="#000000"
        onChange={() => {}}
        label="Color"
        testid="cf"
        onBegin={() => begun++}
        onEnd={() => ended++}
      />,
    );
    fireEvent.click(screen.getByTestId("cf"));
    const field = screen.getByTestId("cf-field");
    // A real press carries its button (jsdom has no PointerEvent, so
    // fireEvent.pointerDown would leave it out and read as no button).
    fireEvent(field, new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 10, clientY: 10 }));
    fireEvent.pointerMove(window, { clientX: 40, clientY: 40 });
    fireEvent.pointerMove(window, { clientX: 80, clientY: 80 });
    fireEvent.pointerUp(window);
    expect(begun).toBe(1);
    expect(ended).toBe(1);
  });
});

describe("the picker's sideways room", () => {
  it("hangs from the swatch's right edge when its left edge would run off the window", async () => {
    const { opensLeft } = await import("../ui/hooks");
    const el = document.createElement("div");
    document.body.appendChild(el);
    const at = (left: number, right: number) => {
      el.getBoundingClientRect = () => ({ left, right, top: 0, bottom: 20, width: right - left, height: 20, x: left, y: 0, toJSON: () => ({}) }) as DOMRect;
    };
    Object.defineProperty(window, "innerWidth", { value: 1000, configurable: true });
    at(100, 126);
    expect(opensLeft(el, 186)).toBe(false);
    // "I click on the right side and it got cut
// off."
    at(950, 976);
    expect(opensLeft(el, 186)).toBe(true);
    // No room either way: stays hung from the left rather than off the left.
    Object.defineProperty(window, "innerWidth", { value: 150, configurable: true });
    at(100, 126);
    expect(opensLeft(el, 186)).toBe(false);
    el.remove();
  });
});
