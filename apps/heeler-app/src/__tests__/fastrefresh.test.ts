// Every .tsx file exports components alone, so Vite's React plugin can
// refresh it in place as it is edited. A file that exports anything else
// beside its components (a constant, a helper, a hook) is not a Fast
// Refresh boundary: tauri dev logs "Could not Fast Refresh (... export is
// incompatible)" and reloads the whole window, dropping the app's state
// (the owner, 2026-10-18, after a burst of them). Such values live in the
// file's "parts" companion (zones.tsx beside zonesparts.ts). Types are
// erased and do not count.
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const SRC = resolve(process.cwd(), "src");

function tsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = resolve(dir, e.name);
    if (e.isDirectory()) return e.name === "__tests__" || e.name === "node_modules" ? [] : tsxFiles(p);
    return e.isFile() && p.endsWith(".tsx") ? [p] : [];
  });
}

/** A name the plugin takes for a component: capitalized, not all caps. */
const componentName = (n: string) => /^[A-Z][a-z0-9]/.test(n) && !/^[A-Z0-9_]+$/.test(n);

/** The file's exports that are not components, by name. */
function nonComponentExports(file: string): string[] {
  const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: string[] = [];
  let components = 0;
  for (const st of sf.statements) {
    if (ts.isExportDeclaration(st)) {
      if (st.isTypeOnly || !st.exportClause || !ts.isNamedExports(st.exportClause)) continue;
      for (const e of st.exportClause.elements) {
        if (e.isTypeOnly) continue;
        if (componentName(e.name.text)) components++;
        else out.push(e.name.text);
      }
      continue;
    }
    const exported = (ts.canHaveModifiers(st) ? ts.getModifiers(st) ?? [] : []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (!exported) continue;
    if (ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st)) continue;
    if (ts.isFunctionDeclaration(st) && st.name) {
      if (componentName(st.name.text)) components++;
      else out.push(st.name.text);
    } else if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        const n = d.name.getText(sf);
        const init = d.initializer;
        const fn =
          !!init &&
          (ts.isArrowFunction(init) || ts.isFunctionExpression(init) || (ts.isCallExpression(init) && /\b(memo|forwardRef|lazy)\b/.test(init.expression.getText(sf))));
        if (componentName(n) && fn) components++;
        else out.push(n);
      }
    } else if (ts.isClassDeclaration(st) || ts.isEnumDeclaration(st)) {
      out.push(st.name?.text ?? "(anonymous)");
    }
  }
  // A file with no components is no refresh boundary; what it exports is
  // its own business (paneliconsparts.tsx's glyphs).
  return components > 0 ? out : [];
}

describe("Fast Refresh boundaries", () => {
  it("no .tsx file exports anything beside its components", () => {
    const mixed = tsxFiles(SRC)
      .map((f) => [f.slice(SRC.length + 1), nonComponentExports(f)] as const)
      .filter(([, names]) => names.length > 0)
      .map(([f, names]) => `${f}: ${names.join(", ")}`);
    expect(mixed, `move these into the file's "parts" companion:\n${mixed.join("\n")}`).toEqual([]);
  });
});
