// Echo: UI actions printed as runnable Python, the way a 3D package
// echoes, without its mistake.
//
// "echo should only work when the Python console
// is open."

import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EchoTap, pyEquivalent, pyLiteral } from "../echo";
import type { Command } from "../state";
import {
  ConsolePanel,
  _resetPyConsoleForTests,
  announceConsoleWindow,
  consoleWindowLive,
  echoEnabled,
  pushEcho,
  setEcho,
} from "../ui/console";

beforeEach(() => _resetPyConsoleForTests());
afterEach(() => vi.useRealTimers());

describe("the translation", () => {
  it("prefers the named wrappers, values as Python", () => {
    expect(
      pyEquivalent({ type: "set_param", id: "portra", param: "grade_strength", value: 88 }),
    ).toBe('heeler.set_param("portra", "grade_strength", 88)');
    expect(pyEquivalent({ type: "set_enabled", id: "vig", enabled: false } as Command)).toBe(
      'heeler.enable("vig", False)',
    );
    expect(pyEquivalent({ type: "select_image", id: "4871" })).toBe(
      'heeler.open_image("4871")',
    );
    expect(
      pyEquivalent({ type: "set_rating", ids: ["4871"], stars: 3 } as Command),
    ).toBe('heeler.rate("4871", 3)');
    expect(
      pyEquivalent({ type: "set_flag", ids: ["a", "b"], flag: "pick" } as Command),
    ).toBe('heeler.flag(["a", "b"], "pick")');
  });

  it("drops wire defaults the way the wrapper's signature does", () => {
    expect(
      pyEquivalent({
        type: "connect",
        wire: { from: "a", to: "b", toPort: "in", kind: "image" },
      } as Command),
    ).toBe('heeler.connect_nodes("a", "b")');
    expect(
      pyEquivalent({
        type: "connect",
        wire: { from: "m", to: "b", toPort: "mask", kind: "mask" },
      } as Command),
    ).toBe('heeler.connect_nodes("m", "b", port="mask", kind="mask")');
  });

  it("whitelisted commands without a wrapper echo as heeler.command", () => {
    expect(pyEquivalent({ type: "delete_nodes", ids: ["n1", "n2"] } as Command)).toBe(
      'heeler.command("delete_nodes", ids=["n1", "n2"])',
    );
  });

  it("a plain thumbnail click is open_image; modified clicks are not scriptable", () => {
    expect(
      pyEquivalent({ type: "select_image_range", id: "4867", additive: false, range: false }),
    ).toBe('heeler.open_image("4867")');
    expect(
      pyEquivalent({ type: "select_image_range", id: "4867", additive: true, range: false }),
    ).toBeNull();
  });

  it("stays quiet for commands scripts cannot send", () => {
    expect(pyEquivalent({ type: "toggle_split" } as Command)).toBeNull();
    expect(pyEquivalent({ type: "toggle_ribbon_expanded" } as Command)).toBeNull();
  });

  it("float noise is trimmed and literals are Python's", () => {
    expect(pyLiteral(0.30000000000000004)).toBe("0.3");
    expect(pyLiteral(true)).toBe("True");
    expect(pyLiteral(null)).toBe("None");
    expect(pyLiteral({ a: [1, "x"] })).toBe('{"a": [1, "x"]}');
  });
});

describe("the tap", () => {
  it("a drag echoes once, with the value it landed on", () => {
    vi.useFakeTimers();
    const lines: string[] = [];
    const tap = new EchoTap((l) => lines.push(l));
    for (const value of [10, 30, 55, 88]) {
      tap.push({ type: "set_param", id: "portra", param: "grade_strength", value });
    }
    expect(lines).toEqual([]);
    vi.advanceTimersByTime(400);
    expect(lines).toEqual(['heeler.set_param("portra", "grade_strength", 88)']);
  });

  it("different params settle separately; one-shot commands pass straight through", () => {
    vi.useFakeTimers();
    const lines: string[] = [];
    const tap = new EchoTap((l) => lines.push(l));
    tap.push({ type: "set_param", id: "a", param: "exposure", value: 1 });
    tap.push({ type: "set_param", id: "a", param: "contrast", value: 2 });
    tap.push({ type: "set_rating", ids: ["4871"], stars: 5 } as Command);
    expect(lines).toEqual(['heeler.rate("4871", 5)']); // immediate
    vi.advanceTimersByTime(400);
    expect(lines).toHaveLength(3);
  });
});

describe("the gate", () => {
  it("echo starts off, announces itself, and the window flag follows the popped-out console", () => {
    expect(echoEnabled()).toBe(false);
    setEcho(true);
    expect(echoEnabled()).toBe(true);
    expect(consoleWindowLive()).toBe(false);
    announceConsoleWindow(true);
    expect(consoleWindowLive()).toBe(true);
    announceConsoleWindow(false);
    expect(consoleWindowLive()).toBe(false);
  });

  it("the chip toggles it and echoed lines land in the scrollback", async () => {
    const user = userEvent.setup();
    render(<ConsolePanel open dispatch={() => {}} />);
    await user.click(screen.getByTestId("console-tab-python"));
    await user.click(screen.getByTestId("py-echo-toggle"));
    expect(echoEnabled()).toBe(true);
    act(() => pushEcho('heeler.set_param("portra", "grade_strength", 88)'));
    const echoes = screen.getAllByTestId("py-echo");
    // The announcement comment plus the pushed line, code-highlighted.
    expect(echoes[0]).toHaveTextContent("# echo on");
    expect(echoes[echoes.length - 1]).toHaveTextContent(
      'heeler.set_param("portra", "grade_strength", 88)',
    );
    await user.click(screen.getByTestId("py-echo-toggle"));
    expect(echoEnabled()).toBe(false);
  });

  it("a windowed console announces on mount and takes it back on unmount", () => {
    const view = render(<ConsolePanel open windowed dispatch={() => {}} />);
    expect(consoleWindowLive()).toBe(true);
    view.unmount();
    expect(consoleWindowLive()).toBe(false);
  });
});
