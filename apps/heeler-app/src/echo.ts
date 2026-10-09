// Echo: a 3D package's best teaching trick, minus its famous mistake.
//
// "In [the 3D package]... we could turn on 'echo' which would then show
// all the MEL commands that were running in the background when you performed an
// action... If you left echo on and closed the script edit it would still be
// verbose in the background and after awhile actually slow things down."
//
// So: every UI action already travels through dispatch as one command,
// and the scripting bridge exposes the same commands to Python. This
// file translates a command into the heeler.* call that would do the
// same thing, runnable as-is in the console. The gate lives at the
// dispatch tap in app.tsx: unless echo is on AND a console is actually
// showing, not one line of this runs. Closing the console closes the
// cost, structurally.

import type { Command } from "./state";
import { API_COMMANDS } from "./api";

/** A value as Python source: True/False/None, quoted strings, lists
 * and dicts. Numbers lose float noise (0.30000000000000004 teaches
 * nobody anything). */
export function pyLiteral(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  if (typeof v === "number") {
    return Number.isFinite(v) ? String(Math.round(v * 10000) / 10000) : "None";
  }
  if (typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(pyLiteral).join(", ")}]`;
  if (typeof v === "object") {
    const inner = Object.entries(v as Record<string, unknown>)
      .map(([k, x]) => `${JSON.stringify(k)}: ${pyLiteral(x)}`)
      .join(", ");
    return `{${inner}}`;
  }
  return "None";
}

/** ids as heeler.rate()/flag() take them: one string, or a list. */
function idArg(ids: string[]): string {
  return ids.length === 1 ? pyLiteral(ids[0]) : pyLiteral(ids);
}

function kwargs(fields: Record<string, unknown>): string {
  return Object.entries(fields)
    .map(([k, v]) => `${k}=${pyLiteral(v)}`)
    .join(", ");
}

/** A line no one can read is a line no one learns from. */
const MAX_LINE = 600;

/** The heeler.* call equivalent to one dispatched command, or null for
 * commands the scripting surface cannot make (view state, dialogs, the
 * whole non-scriptable rest). The named wrappers come first; anything
 * else on the scripting whitelist echoes as heeler.command(...), which
 * is the same escape hatch heeler.py itself is built on. */
export function pyEquivalent(cmd: Command): string | null {
  const c = cmd as Command & Record<string, unknown>;
  let line: string | null = null;
  switch (cmd.type) {
    case "set_param":
      line = `heeler.set_param(${pyLiteral(c.id)}, ${pyLiteral(c.param)}, ${pyLiteral(c.value)})`;
      break;
    case "set_enabled":
      line = `heeler.enable(${pyLiteral(c.id)}${c.enabled ? "" : ", False"})`;
      break;
    case "rename_node":
      line = `heeler.rename(${pyLiteral(c.id)}, ${pyLiteral(c.name)})`;
      break;
    case "node_outside":
      line = `heeler.outside(${pyLiteral(c.id)})`;
      break;
    case "connect": {
      const w = c.wire as { from: string; to: string; toPort: string; kind: string };
      const extra =
        (w.toPort !== "in" ? `, port=${pyLiteral(w.toPort)}` : "") +
        (w.kind !== "image" ? `, kind=${pyLiteral(w.kind)}` : "");
      line = `heeler.connect_nodes(${pyLiteral(w.from)}, ${pyLiteral(w.to)}${extra})`;
      break;
    }
    case "disconnect": {
      const port = c.toPort !== "in" ? `, port=${pyLiteral(c.toPort)}` : "";
      line = `heeler.disconnect(${pyLiteral(c.to)}${port})`;
      break;
    }
    case "set_rating":
      line = `heeler.rate(${idArg(c.ids as string[])}, ${pyLiteral(c.stars)})`;
      break;
    case "set_flag":
      line = `heeler.flag(${idArg(c.ids as string[])}, ${pyLiteral(c.flag)})`;
      break;
    case "select_image":
      line = `heeler.open_image(${pyLiteral(c.id)})`;
      break;
    case "select_image_range":
      // A plain click opens the photo, which scripts do too. Ctrl and
      // shift build a UI selection, which they cannot; those stay quiet
      // rather than echoing something that does half the gesture.
      if (c.additive || c.range) return null;
      line = `heeler.open_image(${pyLiteral(c.id)})`;
      break;
    default: {
      if (!API_COMMANDS.has(cmd.type)) return null;
      const { type, ...fields } = c;
      line = `heeler.command(${pyLiteral(type)}${
        Object.keys(fields).length ? `, ${kwargs(fields)}` : ""
      })`;
    }
  }
  if (line && line.length > MAX_LINE) {
    // A lasso's polygon is real scripting data but useless scrollback;
    // say what ran and where to get the payload instead.
    return `# ${cmd.type}: payload too large to echo (heeler.graph() has the result)`;
  }
  return line;
}

/** Which commands stream during a gesture and should settle before
 * echoing: one line per slider RELEASE, not four hundred per drag.
 * The 3D package echoed the flood; the flood is the part nobody misses. */
const COALESCED = new Set<Command["type"]>(["set_param", "set_params", "set_curve"]);
const COALESCE_MS = 350;

/** The dispatch-side tap: pushes commands in, emits echo lines out.
 * Continuous commands coalesce per node+param with a trailing delay,
 * so a drag echoes once, with the value it landed on. */
export class EchoTap {
  private pending = new Map<string, { line: string; timer: ReturnType<typeof setTimeout> }>();
  constructor(private emit: (line: string) => void) {}

  push(cmd: Command): void {
    const line = pyEquivalent(cmd);
    if (!line) return;
    if (!COALESCED.has(cmd.type)) {
      this.emit(line);
      return;
    }
    const c = cmd as Command & Record<string, unknown>;
    const key = `${cmd.type}:${String(c.id)}:${String(c.param ?? c.channel ?? "")}`;
    const prior = this.pending.get(key);
    if (prior) clearTimeout(prior.timer);
    const timer = setTimeout(() => {
      this.pending.delete(key);
      this.emit(line);
    }, COALESCE_MS);
    this.pending.set(key, { line, timer });
  }
}
