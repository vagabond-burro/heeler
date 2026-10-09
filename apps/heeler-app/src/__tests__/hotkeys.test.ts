import { describe, expect, it } from "vitest";
import {
  COMMANDS,
  GROUP_ORDER,
  bindingFor,
  bindingOf,
  conflicts,
  exportHotkeys,
  formatBinding,
  importHotkeys,
  isModifierOnly,
  searchCommands,
} from "../hotkeys";

describe("the command list", () => {
  it("has unique ids and a known group for every command", () => {
    const ids = COMMANDS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of COMMANDS) {
      expect(c.label.length).toBeGreaterThan(0);
      expect(GROUP_ORDER).toContain(c.group);
    }
  });

  /// The whole reason for the registry: two commands quietly landing on
  /// the same key was previously undetectable, because the shortcuts
  /// were a pile of if statements with no list anywhere.
  it("ships with no conflicting defaults", () => {
    const clashes = conflicts({});
    expect(
      [...clashes.entries()].map(([b, ids]) => `${b}: ${ids.join(", ")}`)
    ).toEqual([]);
  });

  /// Two commands can share a key when they can never both be live.
  it("only calls it a conflict when both commands can fire at once", () => {
    // Same binding, one graph-only and one canvas-only: never both.
    const apart = conflicts({ "edit.delete": "Q", "view.canvas_nodes": "Q" });
    expect(apart.size).toBe(0);
    // Against a global command, it is a conflict.
    const clash = conflicts({ "edit.delete": "Q", "flag.pick": "Q" });
    expect(clash.get("Q")).toContain("edit.delete");
  });
});

describe("reading a keypress", () => {
  it("spells a chord one way only", () => {
    expect(bindingOf({ key: "z", ctrlKey: true })).toBe("Ctrl+Z");
    expect(bindingOf({ key: "Z", ctrlKey: true, shiftKey: true })).toBe("Ctrl+Shift+Z");
    // Command and Control are the same intent.
    expect(bindingOf({ key: "z", metaKey: true })).toBe("Ctrl+Z");
    // Modifier order is fixed, so it cannot come out as "Shift+Ctrl+Z".
    expect(bindingOf({ key: "z", shiftKey: true, ctrlKey: true, altKey: true })).toBe(
      "Ctrl+Shift+Alt+Z"
    );
  });

  it("names the keys that have no printable form", () => {
    expect(bindingOf({ key: " " })).toBe("Space");
    expect(bindingOf({ key: " ", shiftKey: true })).toBe("Shift+Space");
    expect(bindingOf({ key: "ArrowDown" })).toBe("ArrowDown");
    expect(bindingOf({ key: "Escape" })).toBe("Escape");
  });

  /// The bug that cost an afternoon on the develop keys: a keyboard
  /// reports "<" for shift and comma, so a binding captured with shift
  /// held would record a key that can never be typed without it.
  it("stores punctuation unshifted, with Shift as a modifier", () => {
    expect(bindingOf({ key: "<", shiftKey: true })).toBe("Shift+,");
    expect(bindingOf({ key: ">", shiftKey: true })).toBe("Shift+.");
    expect(bindingOf({ key: ":", shiftKey: true })).toBe("Shift+;");
    expect(bindingOf({ key: '"', shiftKey: true })).toBe("Shift+'");
    // And unshifted stays unshifted.
    expect(bindingOf({ key: "," })).toBe(",");
  });

  it("treats a letter as one binding whatever its case", () => {
    expect(bindingOf({ key: "p" })).toBe("P");
    expect(bindingOf({ key: "P", shiftKey: true })).toBe("Shift+P");
  });

  /// Capturing a modifier on its own would produce "Ctrl+Ctrl".
  it("knows when only a modifier was pressed", () => {
    for (const k of ["Control", "Shift", "Alt", "Meta"]) {
      expect(isModifierOnly(k)).toBe(true);
    }
    expect(isModifierOnly("p")).toBe(false);
  });
});

describe("showing a binding on a Mac", () => {
  /// Stored bindings say "Ctrl" everywhere; only the label changes.
  it("prints symbols in Apple's order, off the Mac prints the string as stored", () => {
    expect(formatBinding("Ctrl+Z", false)).toBe("Ctrl+Z");
    expect(formatBinding("Ctrl+Z", true)).toBe("⌘Z");
    expect(formatBinding("Ctrl+Shift+Z", true)).toBe("⇧⌘Z");
    expect(formatBinding("Ctrl+Shift+Alt+Z", true)).toBe("⌥⇧⌘Z");
    expect(formatBinding("Alt+[", true)).toBe("⌥[");
    expect(formatBinding("Shift+Space", true)).toBe("⇧Space");
    expect(formatBinding("[", true)).toBe("[");
    expect(formatBinding("", true)).toBe("");
  });

  /// ⌘Tab belongs to the OS app switcher, so the label for a Tab chord
  /// says the key that actually works: Control.
  it("labels Tab chords with the Control symbol", () => {
    expect(formatBinding("Ctrl+Tab", true)).toBe("⌃Tab");
    expect(formatBinding("Ctrl+Shift+Tab", true)).toBe("⌃⇧Tab");
  });
});

describe("overrides", () => {
  it("prefers the user's binding, and remembers one deliberately cleared", () => {
    expect(bindingFor("flag.pick", {})).toBe("P");
    expect(bindingFor("flag.pick", { "flag.pick": "Ctrl+P" })).toBe("Ctrl+P");
    // Empty is a choice, not an absence: it means "unbound", and must
    // not fall back to the default.
    expect(bindingFor("flag.pick", { "flag.pick": "" })).toBe("");
  });

  it("searches names, groups and bindings", () => {
    expect(searchCommands("pick", {}).map((c) => c.id)).toContain("flag.pick");
    expect(searchCommands("culling", {}).length).toBeGreaterThan(5);
    // Finding every chord is the reason bindings are searchable.
    expect(searchCommands("ctrl", {}).every((c) => bindingFor(c.id, {}).includes("Ctrl"))).toBe(true);
    expect(searchCommands("", {})).toHaveLength(COMMANDS.length);
  });
});

describe("import and export", () => {
  /// Writing out only what differs keeps a map readable and lets a later
  /// change to a default reach someone who exported today.
  it("exports only what differs from the defaults", () => {
    expect(JSON.parse(exportHotkeys({})).hotkeys).toEqual({});
    const out = JSON.parse(exportHotkeys({ "flag.pick": "Ctrl+P" }));
    expect(out.hotkeys).toEqual({ "flag.pick": "Ctrl+P" });
  });

  it("round trips", () => {
    const mine = { "flag.pick": "Ctrl+P", "rate.5": "Shift+5" };
    const { hotkeys } = importHotkeys(exportHotkeys(mine));
    expect(hotkeys).toEqual(mine);
  });

  /// A command id from a build that had it would otherwise sit in the
  /// preferences forever, bound to nothing and silently holding a key.
  it("drops bindings for commands that do not exist", () => {
    const { hotkeys, dropped } = importHotkeys(
      JSON.stringify({ version: 1, hotkeys: { "flag.pick": "Q", "gone.away": "W" } })
    );
    expect(hotkeys).toEqual({ "flag.pick": "Q" });
    expect(dropped).toEqual(["gone.away"]);
  });

  it("refuses a file that is not a hotkey map", () => {
    expect(() => importHotkeys("not json at all")).toThrow();
    // Valid JSON with nothing in it is empty rather than an error.
    expect(importHotkeys("{}").hotkeys).toEqual({});
  });
});
