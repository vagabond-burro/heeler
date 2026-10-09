// No browser-native range inputs, anywhere, ever again.
//
// The fat slider was caught by screenshot three separate times, in three
// separate corners of the app: it renders taller than the house track,
// ignores the theme, and every repair until now fixed the corner the
// screenshot happened to show. This test walks the source the way
// theme.test.ts walks it for palette drift, so the fourth report cannot
// be written.

import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("the house slider is the only slider", () => {
  it("finds no native range input outside the tests", () => {
    const offenders: string[] = [];
    const walk = (dir: string, prefix: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${e.name}` : e.name;
        if (e.isDirectory()) {
          if (e.name !== "__tests__" && e.name !== "node_modules") walk(`${dir}/${e.name}`, rel);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(e.name)) continue;
        const text = readFileSync(`${dir}/${e.name}`, "utf8");
        // A JSX control is `type="range"`; the one surviving mention is
        // the focus guard's CSS selector in app.tsx, spelled
        // `input[type="range"]`, and the lookbehind lets exactly that
        // through while the guard keeps the clause for old habits.
        if (/(?<!\[)type="range"/.test(text)) offenders.push(rel);
      }
    };
    walk(resolve(process.cwd(), "src"), "");
    expect(offenders).toEqual([]);
  });
});
