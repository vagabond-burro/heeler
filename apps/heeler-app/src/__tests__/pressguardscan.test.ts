// Every press handler on the canvas and in the graph goes through the
// one button rule, isPrimaryPress (ui/pointerguard.ts). (2026-09-30): "I
// noticed middle mouse button is painting a stroke, this makes panning
// around with a mouse problematic." The brush's press handler never
// asked which button went down; half the others did, by hand. This scan
// reads the source so the next handler cannot forget it.
//
// A handler passes when its own text calls isPrimaryPress, or when it
// hands the event to a function in the same file whose opening lines do
// (`onMouseDown={begin("move")}`, `(e) => onNodeDown(e, n)`). A handler
// whose whole body is `e.stopPropagation` passes too: it only shields a
// text field or a menu from the surface under it and starts nothing.
// The few that are neither are named below with the reason.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const UI = resolve(process.cwd(), "src/ui");

/** The canvas, its overlays and gizmos, the viewer (and so the pop-outs
 * and the 1:1 view, which are the same component), Canvas mode, and the
 * graph. */
const FILES = [
  "canvas.tsx",
  "colorchecker.tsx",
  "graph.tsx",
  "gridwarp.tsx",
  "keylightgizmo.tsx",
  "mattetool.tsx",
  "overlays.tsx",
  "polish.tsx",
  "selection.tsx",
  "shapewarp.tsx",
  "smarttool.tsx",
  "splitview.tsx",
  "viewer.tsx",
];

/** Handlers that are not tool actions, by their exact expression. */
const EXEMPT: Record<string, string> = {
  // Space-held pan: takes any of the first two buttons on purpose (a
  // held space decides what pans), and it is a pan, not a tool.
  "spacePan.onMouseDown": "space pan",
  "space.onMouseDown": "space pan",
  "spacePan.onPointerDown": "space pan",
  "space.onPointerDown": "space pan",
};

const HANDLER = /\bon(?:Pointer|Mouse)Down(?:Capture)?=\{/g;

/** The balanced `{...}` expression starting at `open`. */
function braced(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  throw new Error("unbalanced handler");
}

/** The opening lines of a function defined in this file, or null. */
function definition(text: string, name: string): string | null {
  const re = new RegExp(`(?:const|let)\\s+${name}\\s*=|function\\s+${name}\\s*\\(`);
  const m = re.exec(text);
  if (!m) return null;
  return text.slice(m.index, m.index + 900);
}

const NOT_CALLEES = new Set(["if", "return", "void", "stopPropagation", "preventDefault"]);

function violations(file: string): string[] {
  const text = readFileSync(resolve(UI, file), "utf8");
  const bad: string[] = [];
  for (const m of text.matchAll(HANDLER)) {
    const open = m.index! + m[0].length - 1;
    const expr = braced(text, open).trim();
    const line = text.slice(0, m.index).split("\n").length;
    if (expr.includes("isPrimaryPress(")) continue;
    if (EXEMPT[expr]) continue;
    if (/^\(?\w+\)?\s*=>\s*\{?\s*\w+\.stopPropagation\(\);?\s*\}?$/.test(expr)) continue;
    // A bare identifier or a call: find the local function it hands to.
    const names = /^[A-Za-z_]\w*$/.test(expr)
      ? [expr]
      : [...expr.matchAll(/(?<![.\w])([A-Za-z_]\w*)\s*\(/g)].map((c) => c[1]).filter((n) => !NOT_CALLEES.has(n));
    const first = names.find((n) => definition(text, n) !== null);
    if (first && definition(text, first)!.includes("isPrimaryPress(")) continue;
    bad.push(`${file}:${line} ${expr.split("\n")[0].slice(0, 80)}`);
  }
  return bad;
}

describe("press handlers on the canvas and in the graph", () => {
  it("every one goes through isPrimaryPress", () => {
    const bad = FILES.flatMap(violations);
    expect(bad).toEqual([]);
  });

  it("the scan sees the handlers it is meant to guard", () => {
    // A scan that matched nothing would pass forever. The brush is the
    // one that painted on a middle press; the graph's node drag is the
    // one that moved a card under a middle-drag pan.
    const overlays = readFileSync(resolve(UI, "overlays.tsx"), "utf8");
    expect([...overlays.matchAll(HANDLER)].length).toBeGreaterThan(8);
    const graph = readFileSync(resolve(UI, "graph.tsx"), "utf8");
    expect([...graph.matchAll(HANDLER)].length).toBeGreaterThan(20);
  });
});
