import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { STACK_CHANNEL, STACK_SET_ASIDE, STACK_KINDS } from "../bridge";

const root = resolve("src-tauri/src");
const optionalSource = (path: string) => { try { return readFileSync(path, "utf8"); } catch { return ""; } };
const rust = readFileSync(resolve(root, "lib.rs"), "utf8") + optionalSource(resolve(root, "stack_render.rs"));
const bridge = readFileSync(resolve("src/bridge.ts"), "utf8");

it("keeps stack progress fields and constants in agreement across the bridge", () => {
  const fields = (body: string, pattern: RegExp) => [...body.matchAll(pattern)].map(m => m[1]);
  const r = fields(rust.match(/pub struct StackProgress \{([\s\S]*?)\n\}/)![1], /pub (\w+):/g);
  const tsBody = bridge.match(/export interface StackProgress \{([\s\S]*?)\n\}/)![1];
  const ts = fields(tsBody, /^  (\w+)\??:/gm);
  for (const name of r) expect(ts).toContain(name);
  for (const name of fields(tsBody, /^  (\w+):/gm)) expect(r).toContain(name);
  const shared = readFileSync(resolve(root, "progress.rs"), "utf8").match(/pub const PROGRESS_EVENT: &str = "(.*?)"/)![1];
  const channel = rust.match(/pub const STACK_EVENT: &str = "(.*?)"/)?.[1] ?? shared;
  expect(STACK_CHANNEL).toBe(channel);
  expect(STACK_SET_ASIDE).toBe(rust.match(/pub const STACK_SET_ASIDE: &str = "(.*?)"/)![1]);
});

it("offers every engine stack mode once", () => {
  const engine = readFileSync(resolve("../../crates/heeler-engine/src/stack.rs"), "utf8");
  const modes = [...engine.match(/pub enum StackMode \{([\s\S]*?)\n\}/)![1].matchAll(/^    (\w+),/gm)].map(m => m[1].toLowerCase()).sort();
  expect(STACK_KINDS.map(k => k.mode).sort()).toEqual(modes);
});

it("cannot reuse stack proxies from the encoded-space JPEG preview", () => {
  const tiers = [...rust.matchAll(/format!\("(stack\|[^"\n]+)"/g)].map(m => m[1]);
  expect(tiers.length).toBeGreaterThanOrEqual(3);
  expect(tiers.some(t => /^stack\|(full|preview)/.test(t))).toBe(false);
});
