// Cmd+D (Ctrl+D on Windows) duplicates the selected nodes in the Graph.
//
// 2026-10-01: "We need a hotkey to duplicate selected nodes. That is
// pretty common in node editors". The key existed; nothing showed it.
// These drive the real key path (the App's window listener, the
// registry, scope resolution) rather than calling the reducer, and pin
// the places that tell a person the key exists: the Edit menu, the
// right-click hint and the guide.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App } from "../app";
import { GraphWindow } from "../ui/graphwindow";
import { initialState } from "../data";
import { setMacForTests } from "../platform";
import { CMD_CHANNEL, STATE_CHANNEL, setTransport, type Transport } from "../popout";
import { conflicts, formatBinding } from "../hotkeys";
import { duplicable, reduce, type State } from "../state";
import { _clearFlashForTests } from "../ui/hints";

const PLATFORMS = [
  { name: "Mac", mac: true, chord: { key: "d", metaKey: true } },
  { name: "Windows", mac: false, chord: { key: "d", ctrlKey: true } },
] as const;

/** Two cards the stock graph wires together, both copyable. Read from
 * the state this file builds, not from a list typed here. */
function wiredPair() {
  const s = initialState();
  const w = s.wires.find((k) => k.kind === "image" && duplicable(k.from) && duplicable(k.to) &&
    s.nodes.some((n) => n.id === k.from && !n.isGroup) && s.nodes.some((n) => n.id === k.to && !n.isGroup))!;
  return { from: w.from, to: w.to, port: w.toPort };
}

const cards = () => [...screen.getByTestId("node-editor").querySelectorAll<HTMLElement>(".node")];
const selected = () => cards().filter((c) => c.getAttribute("data-selected") === "true");
const cardId = (el: HTMLElement) => el.getAttribute("data-testid")!.replace(/^node-/, "");

async function toGraph(user: ReturnType<typeof userEvent.setup>) {
  await user.click(within(screen.getByRole("tablist", { name: /workspace mode/i })).getByRole("button", { name: "Graph" }));
}

function fakeTransport() {
  const subs = new Map<string, ((p: unknown) => void)[]>();
  const sent: { channel: string; payload: unknown }[] = [];
  const t: Transport & { sent: typeof sent } = {
    sent,
    send(channel, payload) {
      sent.push({ channel, payload });
      [...(subs.get(channel) ?? [])].forEach((f) => f(payload));
    },
    subscribe(channel, fn) {
      subs.set(channel, [...(subs.get(channel) ?? []), fn]);
      return () => subs.set(channel, (subs.get(channel) ?? []).filter((f) => f !== fn));
    },
  };
  setTransport(t);
  return t;
}

beforeEach(async () => {
  const { mockResetSessions } = await import("../bridge");
  mockResetSessions();
});
afterEach(() => {
  setMacForTests(null);
  setTransport(null);
  _clearFlashForTests();
});

describe("Duplicate Selected Nodes by key, through the whole App", () => {
  for (const p of PLATFORMS) {
    it(`${p.name}: the chord copies the selection, offset, wired among themselves, as one undo step`, async () => {
      setMacForTests(p.mac);
      const user = userEvent.setup();
      render(<App />);
      await toGraph(user);
      const { from, to, port } = wiredPair();
      fireEvent.mouseDown(screen.getByTestId(`node-${from}`));
      fireEvent.mouseDown(screen.getByTestId(`node-${to}`), { shiftKey: true });
      expect(selected().map(cardId).sort()).toEqual([from, to].sort());
      const before = cards().length;

      fireEvent.keyDown(window, p.chord);

      // Two new cards, and they are the selection now.
      expect(cards().length).toBe(before + 2);
      const copies = selected().map(cardId);
      expect(copies).toHaveLength(2);
      expect(copies).not.toContain(from);
      expect(copies).not.toContain(to);
      // Same names as their originals, and not on top of them.
      const nameOf = (id: string) => screen.getByTestId(`node-${id}`).textContent;
      const original = (id: string) => (nameOf(id) === nameOf(from) ? from : to);
      for (const c of copies) {
        const o = screen.getByTestId(`node-${original(c)}`);
        const k = screen.getByTestId(`node-${c}`);
        expect(`${k.style.left},${k.style.top}`).not.toBe(`${o.style.left},${o.style.top}`);
      }
      // The wire between the originals is copied between the copies,
      // and nothing feeds the copies from outside the set.
      const cFrom = copies.find((c) => original(c) === from)!;
      const cTo = copies.find((c) => original(c) === to)!;
      expect(screen.getByTestId(`wire-hit-${cFrom}-${cTo}-${port}`)).toBeInTheDocument();
      expect(document.querySelector(`[data-testid^="wire-hit-"][data-testid$="-${cFrom}-in"]`)).toBeNull();
      // The original wire is untouched.
      expect(screen.getByTestId(`wire-hit-${from}-${to}-${port}`)).toBeInTheDocument();

      // One undo takes both back.
      fireEvent.keyDown(window, { ...p.chord, key: "z" });
      expect(cards().length).toBe(before);
      expect(screen.queryByTestId(`node-${cFrom}`)).toBeNull();
      expect(screen.queryByTestId(`node-${cTo}`)).toBeNull();
    });
  }

  it("a recipe group and a mixed selection copy whole, members and all", async () => {
    setMacForTests(true);
    const user = userEvent.setup();
    const t = fakeTransport();
    render(<App />);
    await toGraph(user);
    act(() => t.send(CMD_CHANNEL, { type: "set_category", title: "Sharpening", on: true }));
    const group = screen.getByTestId("node-sharpening");
    const { from } = wiredPair();
    fireEvent.mouseDown(group);
    fireEvent.mouseDown(screen.getByTestId(`node-${from}`), { shiftKey: true });
    const before = cards().length;
    fireEvent.keyDown(window, { key: "d", metaKey: true });
    expect(cards().length).toBe(before + 2);
    const copy = selected().find((c) => c.classList.contains("group"));
    expect(copy, "the group was not copied").toBeTruthy();
    expect(cardId(copy!)).not.toBe("sharpening");
  });

  it("Output alone is refused with a sentence, not silence", async () => {
    setMacForTests(true);
    const user = userEvent.setup();
    render(<App />);
    await toGraph(user);
    fireEvent.mouseDown(screen.getByTestId("node-output"));
    const before = cards().length;
    fireEvent.keyDown(window, { key: "d", metaKey: true });
    expect(cards().length).toBe(before);
    expect(screen.getByTestId("node-editor")).toHaveTextContent(/Nothing to duplicate: Output is one per graph/);
  });

  it("in Develop the same chord is Deselect, and no card is copied", async () => {
    setMacForTests(true);
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByTestId("add-layer-selection"));
    // Select All lays a region, which Deselect then clears.
    fireEvent.keyDown(window, { key: "a", metaKey: true });
    expect(screen.getByTestId("region-row-0")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "d", metaKey: true });
    expect(screen.queryByTestId("region-row-0")).toBeNull();
    // And no card was copied while it did.
    await toGraph(user);
    const ids = cards().map(cardId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("the hotkey editor sees no clash between Duplicate and Deselect", () => {
    // Graph and Develop are never live together, so sharing Ctrl+D is
    // two meanings in two places, not a conflict.
    expect(conflicts({}).has("Ctrl+D")).toBe(false);
  });
});

describe("Duplicate in the popped-out graph window", () => {
  it("the chord pressed in the pop-out duplicates there, even with the main window in Develop", async () => {
    setMacForTests(true);
    const user = userEvent.setup();
    const t = fakeTransport();
    render(<App />);
    await toGraph(user);
    await user.click(screen.getByTestId("graph-popout"));
    // The main window goes back to Develop, the graph stays out.
    await user.click(within(screen.getByRole("tablist", { name: /workspace mode/i })).getByRole("button", { name: "Develop" }));
    render(<GraphWindow />);
    const win = screen.getByTestId("graph-window");
    const { from } = wiredPair();
    await user.click(within(win).getByTestId(`node-${from}`));
    const snapshot = () => t.sent.filter((m) => m.channel === STATE_CHANNEL).slice(-1)[0].payload as State;
    const before = snapshot().nodes.length;
    expect(snapshot().selection).toEqual([from]);

    fireEvent.keyDown(within(win).getByTestId("node-editor"), { key: "d", metaKey: true });

    await waitFor(() => expect(snapshot().nodes.length).toBe(before + 1));
    const copy = snapshot().selection[0];
    expect(copy).not.toBe(from);
    expect(within(win).getByTestId(`node-${copy}`)).toBeInTheDocument();
  });
});

describe("the key is shown where people look", () => {
  it("Edit > Duplicate Nodes prints the chord and runs it in the Graph", async () => {
    setMacForTests(true);
    const user = userEvent.setup();
    render(<App />);
    await toGraph(user);
    const { from } = wiredPair();
    fireEvent.mouseDown(screen.getByTestId(`node-${from}`));
    const before = cards().length;
    await user.click(screen.getByTestId("menu-edit"));
    const item = screen.getByTestId("menu-edit-duplicate");
    expect(item).toHaveTextContent("Duplicate Nodes");
    expect(item).toHaveTextContent(formatBinding("Ctrl+D", true));
    expect(item).not.toBeDisabled();
    await user.click(item);
    expect(cards().length).toBe(before + 1);
  });

  it("Edit > Duplicate Nodes is grayed in Develop and says where it works", async () => {
    setMacForTests(true);
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByTestId("menu-edit"));
    const item = screen.getByTestId("menu-edit-duplicate");
    expect(item).toBeDisabled();
    expect(item.parentElement!.getAttribute("data-hint")).toMatch(/graph/i);
  });

  it("Edit > Duplicate Nodes is grayed in the Graph with nothing selected", async () => {
    setMacForTests(true);
    const user = userEvent.setup();
    render(<App />);
    await toGraph(user);
    // Clicking empty graph clears the selection.
    fireEvent.mouseDown(screen.getByTestId("graph-surface"), { button: 0 });
    fireEvent.mouseUp(window);
    await user.click(screen.getByTestId("menu-edit"));
    const item = screen.getByTestId("menu-edit-duplicate");
    expect(item).toBeDisabled();
    expect(item.parentElement!.getAttribute("data-hint")).toMatch(/select/i);
  });

  it("the guide lists the chord in the menus page and the graph keys", () => {
    const root = resolve(process.cwd(), "../../docs/user-guide");
    const menus = readFileSync(resolve(root, "menus.md"), "utf8");
    expect(menus).toMatch(/Duplicate Nodes[^\n]*(Cmd|Ctrl)\+D/);
    const canvas = readFileSync(resolve(root, "graph/canvas.md"), "utf8");
    expect(canvas).toMatch(/Duplicate[^\n]*`D`/);
  });
});

// The reducer is the one door; a refusal names what was left behind.
describe("what duplicate leaves behind", () => {
  it("copies what it can and says what it skipped", () => {
    let s = initialState();
    const { from } = wiredPair();
    s = reduce(s, { type: "duplicate_nodes", ids: [from, "output"] });
    expect(s.notice?.text ?? "").toMatch(/output/i);
    expect(s.selection).toHaveLength(1);
  });
});
