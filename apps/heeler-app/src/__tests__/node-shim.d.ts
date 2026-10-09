// The app runs in a webview, not in Node, so this project deliberately
// carries no @types/node and tsconfig's `types` list keeps it that way.
// One test reads a file from disk (theme.test.ts, which checks the
// palette against its own rules), so it declares exactly the two things
// it uses and nothing else. Adding @types/node instead would put
// `process` and the whole Node surface in scope for every file in the
// app, which is a much wider change than one test needs.
declare module "node:fs" {
  export function writeFileSync(path: string, data: string): void;
  export function readFileSync(path: string, encoding: "utf8"): string;
  export function readdirSync(
    path: string,
    opts: { withFileTypes: true },
  ): { name: string; isDirectory(): boolean; isFile(): boolean }[];
  /** The plain form, for walking one directory of files by name. */
  export function readdirSync(path: string): string[];
}
/** dashes.test.ts lists the tracked files with `git ls-files`. */
declare module "node:child_process" {
  export function execFileSync(
    file: string,
    args: string[],
    opts: { cwd: string; encoding: "utf8"; maxBuffer?: number },
  ): string;
}
declare module "node:path" {
  export function resolve(...parts: string[]): string;
}
declare const process: { cwd(): string; env: Record<string, string | undefined>; memoryUsage(): { heapUsed: number } };
