// One dropdown in the app (2026-10-06: "Basically, dropdowns are NOT
// consistent in this app. That is NOT cool. Not by a mile ...
// Standardize this"). Every value menu is MenuField, the one Source
// uses; every typed suggestion list is SuggestField, on the same list
// surface; every color is ColorField. A native <select>, <datalist> or
// color, date or time input hands its popup to the OS, which drew the
// Grain, Halation, Film and Filter lists white on Windows, so none may
// come back.

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const SRC = resolve(process.cwd(), "src");

/** The source of every .tsx and .ts outside the tests, comments taken
 * out so a comment that names <select> to explain the rule is not a
 * use. .ts walks too: document.createElement needs no JSX. */
function sources(): [string, string][] {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
      d.isDirectory()
        ? d.name === "__tests__" ? [] : walk(resolve(dir, d.name))
        : /\.tsx?$/.test(d.name) ? [resolve(dir, d.name)] : [],
    );
  return walk(SRC).map((f) => [
    f.slice(SRC.length + 1).replace(/\\/g, "/"),
    readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, ""),
  ]);
}

const NATIVE: [string, RegExp][] = [
  ["<select>", /<select[\s>]/],
  ["<datalist>", /<datalist[\s>]/],
  ["a createElement select or datalist", /createElement\(\s*["'](?:select|datalist)["']/],
  ["an input's list= suggestions", /\slist=\s*\{?\s*["']/],
  ["a native color, date or time input", /type=\s*\{?\s*["'](?:color|date|time|datetime-local|month|week)["']/],
];

describe("native popups", () => {
  it("no file draws a dropdown, suggestion list or picker the OS owns", () => {
    const found = sources().flatMap(([file, text]) =>
      NATIVE.filter(([, re]) => re.test(text)).map(([what]) => `${file}: ${what}`),
    );
    expect(found).toEqual([]);
  });

  it("the scan sees through to real uses", () => {
    // A guard that matches nothing would pass forever.
    const probe = '<select value="a">\n<input list="x" />\n<input type="color" />\n<datalist id="x">';
    expect(NATIVE.filter(([, re]) => re.test(probe)).length).toBe(4);
    expect(sources().length).toBeGreaterThan(100);
  });

  it("the scan catches the forms around the literal tags too", () => {
    // createElement, the expression attribute and the single-quoted
    // forms draw the same OS popup as the literal tag; a scan that
    // knows only the literal would wave them through.
    const forms: [string, string][] = [
      ["React.createElement select", 'React.createElement("select", props)'],
      ["document.createElement select", 'document.createElement("select")'],
      ["document.createElement datalist", 'document.createElement("datalist")'],
      ["expression color input", '<input type={"color"} />'],
      ["expression date input", "<input type={ 'date' } />"],
      ["single-quoted time input", "<input type='time' />"],
      ["single-quoted list", "<input list='x' />"],
    ];
    for (const [what, snippet] of forms) {
      expect(
        NATIVE.some(([, re]) => re.test(snippet)),
        `${what} should trip the scan`,
      ).toBe(true);
    }
  });
});
