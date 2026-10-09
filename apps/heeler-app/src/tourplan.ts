// A graph tour's plan, checked as a network before it is shown
// (2026-09-29: "Check the plan is a complete network before showing it.
// Repair and drop steps"; tours Heeler cannot make whole get the sorry
// line). Live Graph tours on 2026-09-28 added a Recolor node and never
// wired its mask; added a Smart Mask and pointed at its lone mask output
// without adding the Exposure node it feeds; added an unneeded Tone
// Profile and a wrong "Add an Output node" step; and added connect steps
// after a splice that had already made those wires.
//
// After the tour's JSON passes the check (src/tour.ts, checkTour), the
// plan is played on a COPY of the graph as it is in the main window,
// through the reducer on a copy (reducePlanCopy), never on
// the live state: every add, splice and connect as the user would make
// it. Then:
// - an add step for a node type the answer never names is dropped, with
//   every step about that node; a step telling the user to add an Output
//   or an Image Source (every graph has one) is dropped;
// - a node the answer tells the user to add and the plan never adds is
//   added, before the plan's first step about it;
// - a step pointing at a lone port becomes the wire it implies when its
//   sentence names one other node; else it is dropped when it asks for a
//   drag or sits on a node the plan adds, and the wires a whole network
//   needs are made below, where the counterpart is unambiguous;
// - a connect or splice whose wire the plan already made is dropped
//   (a splice makes a node's picture wires, so a connect after it into
//   the same input is refused as the user's would be);
// - every picture node the plan adds must end up in the picture's path:
//   one whose output goes nowhere is spliced, right after it is added
//   (a splice lifts a node's wires first, so it goes before its mask
//   is wired);
// - every mask node the plan adds must be fed the photograph and must
//   feed a mask input of a node that changes the picture: the one
//   picture node with a free mask input the plan adds, else the one the
//   answer names with a mask input, added and spliced for it.
// Each repair is a DEBUG log line, never a line in the chat. A plan
// still not whole after repair is dropped.

import { logDebug } from "./log";
import { makeNode, MASK_IN_TYPES, NODE_CATALOG, producesMask, RETIRED_TYPES, type NodeSpec } from "./nodes";
import { reducePlanCopy, type NodeCard, type State, type Wire } from "./state";
import { graphScope, instanceOf, nodeSlug, portsConnect, STOP_BY_ID, wireFromPort, wirePort } from "./tourstops";
import type { TourStep } from "./tourwalk";

export interface PlanResult {
  steps: TourStep[];
  /** the repairs made, in words, for the log and the tests */
  repairs: string[];
  /** a network that changes the picture as the answer says */
  whole: boolean;
  /** what is still missing, when not whole */
  missing: string[];
}

/** How a step's sentence is written (src/tour.ts, sentence: one line). */
export type Say = (say: string, stopId: string) => string;

const FIXED = new Set(["heeler.image_source", "heeler.output"]);

const specOfSlug = (slug: string): NodeSpec | undefined =>
  NODE_CATALOG.find((n) => nodeSlug(n.type) === slug && !RETIRED_TYPES.has(n.type));

/** The node slug a stop or a ref is about: graph.add.X, node.X, port.X.seat. */
function slugOf(ref: string | undefined): string | null {
  if (!ref) return null;
  const m = /^(?:graph\.add|node|port)\.([a-z0-9_]+)/.exec(ref);
  return m ? m[1] : null;
}

const refsOf = (s: TourStep) => [s.stop, s.from, s.to].filter((r): r is string => !!r);
const involves = (s: TourStep, slug: string) => refsOf(s).some((r) => slugOf(r) === slug);
const addsOf = (s: TourStep) => (s.stop.startsWith("graph.add.") ? s.stop.slice("graph.add.".length) : null);

const cards = new Map<string, NodeCard>();
function cardOf(type: string): NodeCard | null {
  if (!cards.has(type)) {
    const spec = NODE_CATALOG.find((n) => n.type === type);
    if (!spec) return null;
    cards.set(type, makeNode(spec, "x", 0, 0));
  }
  return cards.get(type)!;
}

/** A node whose output is a mask or field. */
export function makesMask(type: string): boolean {
  const c = cardOf(type);
  return !!c && (!!c.maskOut || producesMask(type));
}

/** A node the picture passes through: a picture in and a picture out. */
export function passesPicture(type: string): boolean {
  const c = cardOf(type);
  return !!c && !!c.hasIn && !!c.hasOut && !makesMask(type) && !MASK_IN_TYPES.has(type) && !FIXED.has(type);
}

/** A picture node that takes a mask to limit where it works. */
export function takesMask(type: string): boolean {
  return passesPicture(type) && !!cardOf(type)?.maskIn;
}

/** Whether a graph step: the plan touches the graph's network. */
export function isGraphPlan(steps: TourStep[]): boolean {
  return steps.some((s) => s.stop.startsWith("graph.add.") || s.stop === "graph.connect" || s.stop === "graph.splice" || s.stop.startsWith("port."));
}

// -- playing the plan on a copy ---------------------------------------------------

/** "missing": a node the step wires is not in the graph at that point. */
type Outcome = "ok" | "redundant" | "refused" | "missing" | "look";

interface Played {
  state: State;
  outcomes: Outcome[];
  /** the node each add step made, by step index */
  made: Map<number, string>;
  /** the plan's nodes by slug (the newest the plan added) */
  bySlug: Map<string, string>;
}

function idFor(s: State, slug: string, bySlug: Map<string, string>): string | null {
  const own = bySlug.get(slug);
  if (own) return own;
  const spec = specOfSlug(slug);
  return spec ? instanceOf(s, spec.type)?.id ?? null : null;
}

function play(steps: TourStep[], start: State): Played {
  let s = start;
  const outcomes: Outcome[] = [];
  const made = new Map<number, string>();
  const bySlug = new Map<string, string>();
  steps.forEach((step, i) => {
    const add = addsOf(step);
    if (add) {
      const spec = specOfSlug(add);
      if (!spec) return void outcomes.push("refused");
      const id = `tourplan-${i}`;
      const next = reducePlanCopy(s, { type: "add_node", node: makeNode(spec, id, 0, 0), place: "beside" });
      if (next === s) return void outcomes.push("refused");
      s = next;
      made.set(i, id);
      bySlug.set(add, id);
      return void outcomes.push("ok");
    }
    if (step.stop === "graph.splice") {
      const id = idFor(s, slugOf(step.from) ?? "", bySlug);
      const { nodes, wires } = graphScope(s);
      const out = nodes.find((n) => n.type === "heeler.output");
      const target = out ? wires.find((w) => w.to === out.id && w.toPort === "in") : undefined;
      if (!id || !target) return void outcomes.push("refused");
      if (target.from === id) return void outcomes.push("redundant");
      const next = reducePlanCopy(s, { type: "splice_node_into_wire", id, from: target.from, to: target.to, toPort: target.toPort });
      if (next === s) return void outcomes.push("refused");
      s = next;
      return void outcomes.push("ok");
    }
    if (step.stop === "graph.connect") {
      const from = STOP_BY_ID.get(step.from ?? "");
      const to = STOP_BY_ID.get(step.to ?? "");
      if (!from?.port || !to?.port || !from.nodeType || !to.nodeType) return void outcomes.push("refused");
      const fromId = idFor(s, nodeSlug(from.nodeType), bySlug);
      const toId = idFor(s, nodeSlug(to.nodeType), bySlug);
      const toPort = wirePort(to.port.seat);
      const fp = wireFromPort(from.nodeType, from.port.seat);
      if (!fromId || !toId || !toPort) return void outcomes.push("missing");
      const { wires } = graphScope(s);
      if (wires.some((w) => w.from === fromId && w.to === toId && w.toPort === toPort)) return void outcomes.push("redundant");
      const wire: Wire = { from: fromId, to: toId, toPort, kind: from.port.kind === "mask" ? "mask" : "image", ...(fp && fp !== "any" ? { fromPort: fp } : {}) };
      const next = reducePlanCopy(s, { type: "connect", wire });
      if (next === s) return void outcomes.push("refused");
      s = next;
      return void outcomes.push("ok");
    }
    if (step.stop === "graph.disconnect") {
      const to = STOP_BY_ID.get(step.to ?? "");
      const toId = to?.nodeType ? idFor(s, nodeSlug(to.nodeType), bySlug) : null;
      const toPort = to?.port ? wirePort(to.port.seat) : null;
      if (!toId || !toPort) return void outcomes.push("refused");
      const next = reducePlanCopy(s, { type: "disconnect", to: toId, toPort });
      const changed = next !== s;
      s = next;
      return void outcomes.push(changed ? "ok" : "redundant");
    }
    outcomes.push("look");
  });
  return { state: s, outcomes, made, bySlug };
}

// -- what a whole network is ---------------------------------------------------------

/** The nodes the picture passes through on its way to Output: upstream
 * of Output along picture wires (never a mask wire). */
function picturePath(s: State): Set<string> {
  const { nodes, wires } = graphScope(s);
  const out = nodes.find((n) => n.type === "heeler.output");
  const path = new Set<string>();
  if (!out) return path;
  const todo = [out.id];
  while (todo.length) {
    const id = todo.pop()!;
    if (path.has(id)) continue;
    path.add(id);
    for (const w of wires) if (w.to === id && w.kind !== "mask" && w.toPort !== "mask" && w.toPort !== "alpha" && w.toPort !== "depth") todo.push(w.from);
  }
  return path;
}

/** Whether a mask node's field reaches a node on the picture's path:
 * directly into its mask, or through mask nodes (an Invert) on the way. */
function feedsPicture(s: State, id: string, path: Set<string>): boolean {
  const { wires } = graphScope(s);
  const seen = new Set<string>();
  const todo = [id];
  while (todo.length) {
    const at = todo.pop()!;
    if (seen.has(at)) continue;
    seen.add(at);
    for (const w of wires) {
      if (w.from !== at) continue;
      if (path.has(w.to)) return true;
      todo.push(w.to);
    }
  }
  return false;
}

const fed = (s: State, id: string, port: Wire["toPort"]) => graphScope(s).wires.some((w) => w.to === id && w.toPort === port);

interface Gap {
  /** the add step of the node that is not yet whole */
  at: number;
  slug: string;
  kind: "off-path" | "no-picture-in" | "mask-unfed" | "mask-unused";
}

function gapsOf(steps: TourStep[], p: Played): Gap[] {
  const path = picturePath(p.state);
  const gaps: Gap[] = [];
  for (const [at, id] of p.made) {
    const slug = addsOf(steps[at])!;
    const type = specOfSlug(slug)!.type;
    // Only the newest node of a type the plan added is the one it wires.
    if (p.bySlug.get(slug) !== id) continue;
    if (makesMask(type)) {
      const c = cardOf(type)!;
      if (c.hasIn && !MASK_IN_TYPES.has(type) && !fed(p.state, id, "in")) gaps.push({ at, slug, kind: "mask-unfed" });
      if (!feedsPicture(p.state, id, path)) gaps.push({ at, slug, kind: "mask-unused" });
    } else if (passesPicture(type)) {
      if (!path.has(id)) gaps.push({ at, slug, kind: "off-path" });
      else if (!fed(p.state, id, "in")) gaps.push({ at, slug, kind: "no-picture-in" });
    } else if (!path.has(id) && !feedsPicture(p.state, id, path)) {
      gaps.push({ at, slug, kind: "off-path" });
    }
  }
  return gaps;
}

// -- the repair ---------------------------------------------------------------------

const nameOf = (slug: string) => specOfSlug(slug)?.name ?? slug;

/** The node names in a text, as whole words, longest first so "Color
 * Grade" is not also "Color". */
function namedTypes(text: string): Set<string> {
  const esc = (n: string) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Output and Image Source only by their names as written: "its
  // output" is a port, not the Output node.
  const word = (spec: NodeSpec) => new RegExp(`(^|[^A-Za-z])${esc(spec.name)}([^A-Za-z]|$)`, FIXED.has(spec.type) ? "" : "i");
  const found = NODE_CATALOG.filter((spec) => !RETIRED_TYPES.has(spec.type) && word(spec).test(text));
  const longer = found.map((s) => s.name).sort((a, b) => b.length - a.length);
  const out = new Set<string>();
  for (const spec of found) {
    let rest = text;
    for (const name of longer) if (name.length > spec.name.length) rest = rest.replace(new RegExp(esc(name), "gi"), " ");
    if (word(spec).test(rest)) out.add(spec.type);
  }
  return out;
}

/** Whether the answer tells the user to add this node: "add a Blur
 * node", "Add **Grain**", "type "Recolor" to add it". A name only
 * mentioned ("limit Exposure with it") is not. */
export function toldToAdd(answer: string, name: string, type = ""): boolean {
  const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // The name, or the type as the model sometimes writes it (heeler.recolor).
  const n = `(?:${esc(name)}${type ? `|${esc(type)}` : ""})`;
  const q = "[`\"'*_]*";
  return (
    new RegExp(`\\badd(?:s|ing)?\\s+(?:(?:a|an|the|one|another|new|second)\\s+)*${q}${n}${q}(?![A-Za-z])`, "i").test(answer) ||
    new RegExp(`${q}${n}${q}(?:\\s+node)?[^.\\n]{0,40}\\bto add\\b`, "i").test(answer) ||
    // Typed into the palette: "type Recolor", "type "Grain"".
    new RegExp(`\\btype\\s+${q}${n}${q}(?![A-Za-z])`, "i").test(answer)
  );
}

export function repairPlan(input: TourStep[], opts: { answer: string; graph: State; say: Say; maxSteps?: number }): PlanResult {
  const repairs: string[] = [];
  if (!isGraphPlan(input)) return { steps: input, repairs, whole: true, missing: [] };
  const named = namedTypes(opts.answer);
  let steps = [...input];

  // An add of a node the answer never names, with every step about that
  // node; a step telling the user to add a node every graph has once.
  for (const slug of new Set(steps.map(addsOf).filter((x): x is string => !!x))) {
    const spec = specOfSlug(slug);
    if (spec && named.has(spec.type)) continue;
    repairs.push(`dropped the add of ${nameOf(slug)} (the answer never names it), with its ${steps.filter((s) => involves(s, slug)).length - 1} other steps`);
    steps = steps.filter((s) => !involves(s, slug));
  }
  steps = steps.filter((s) => {
    const fixed = /\badd(?:ing)?\s+(?:a|an|the|one)?\s*(?:new\s+)?(Output|Image Source)\b/i.exec(s.say);
    if (!fixed) return true;
    repairs.push(`dropped "${s.stop}" asking to add ${fixed[1]} (every graph has one)`);
    return false;
  });

  const insertAfter = (at: number, add: TourStep[]) => {
    steps = [...steps.slice(0, at + 1), ...add, ...steps.slice(at + 1)];
  };
  const connect = (from: string, to: string, say: string): TourStep => ({ stop: "graph.connect", from, to, say: opts.say(say, "graph.connect") });
  const splice = (slug: string): TourStep => ({
    stop: "graph.splice",
    from: `node.${slug}`,
    say: opts.say(`Drag the ${nameOf(slug)} node onto a wire, the one into Output for the whole picture, and drop it: a node changes nothing until the picture passes through it.`, "graph.splice"),
  });
  const addIndex = (slug: string) => steps.findIndex((s) => addsOf(s) === slug);
  const lastIndexAbout = (slug: string) => {
    let at = addIndex(slug);
    steps.forEach((s, i) => {
      if ((s.stop === "graph.splice" && slugOf(s.from) === slug) || (s.stop === "graph.connect" && s.to === `port.${slug}.in`)) at = Math.max(at, i);
    });
    return at;
  };

  const outSeatOf = (slug: string) => (STOP_BY_ID.has(`port.${slug}.mask-out`) ? "mask-out" : "out");
  const maskWire = (from: string, to: string) =>
    connect(`port.${from}.${outSeatOf(from)}`, `port.${to}.mask`, `Drag from ${nameOf(from)}'s output to ${nameOf(to)}'s mask input: ${nameOf(to)} then changes only where the mask lets it.`);
  const addStep = (slug: string): TourStep => {
    const spec = specOfSlug(slug)!;
    return { stop: `graph.add.${slug}`, say: opts.say(`Add a ${spec.name} node: ${spec.blurb.charAt(0).toLowerCase()}${spec.blurb.slice(1)}.`, `graph.add.${slug}`) };
  };

  /** One gap closed, when the way to close it is unambiguous. */
  const close = (gap: Gap, p: Played): boolean => {
    const id = p.bySlug.get(gap.slug)!;
    if (gap.kind === "off-path") {
      // A picture node whose output goes nowhere: spliced right after it
      // is added, before anything wires its mask (a splice lifts the
      // node's wires first).
      const goes = graphScope(p.state).wires.some((w) => w.from === id);
      if (goes || !passesPicture(specOfSlug(gap.slug)!.type)) return false;
      const had = steps.findIndex((s) => s.stop === "graph.splice" && slugOf(s.from) === gap.slug);
      if (had >= 0) steps = steps.filter((_, i) => i !== had);
      insertAfter(addIndex(gap.slug), [splice(gap.slug)]);
      repairs.push(had >= 0 ? `moved the splice of ${nameOf(gap.slug)} to right after its add` : `spliced ${nameOf(gap.slug)} into the picture's path`);
      return true;
    }
    if (gap.kind === "mask-unfed") {
      insertAfter(addIndex(gap.slug), [
        connect("port.image_source.out", `port.${gap.slug}.in`, `Drag from Image Source's output to ${nameOf(gap.slug)}'s input, so the mask is made from the photograph.`),
      ]);
      repairs.push(`fed ${nameOf(gap.slug)} the photograph`);
      return true;
    }
    if (gap.kind === "mask-unused") {
      // The node whose mask it limits: the one picture node with a free
      // mask input the plan adds, else the one the answer names.
      const free = [...p.bySlug.entries()].filter(([slug, nid]) => takesMask(specOfSlug(slug)!.type) && !fed(p.state, nid, "mask"));
      if (free.length === 1) {
        const [to] = free[0];
        insertAfter(Math.max(lastIndexAbout(gap.slug), lastIndexAbout(to)), [maskWire(gap.slug, to)]);
        repairs.push(`wired ${nameOf(gap.slug)} into ${nameOf(to)}'s mask`);
        return true;
      }
      if (free.length > 1) return false;
      const want = [...named].filter((t) => takesMask(t) && !p.bySlug.has(nodeSlug(t)) && STOP_BY_ID.has(`graph.add.${nodeSlug(t)}`) && STOP_BY_ID.has(`port.${nodeSlug(t)}.mask`));
      if (want.length !== 1) return false;
      const to = nodeSlug(want[0]);
      insertAfter(lastIndexAbout(gap.slug), [addStep(to), splice(to), maskWire(gap.slug, to)]);
      repairs.push(`added ${nameOf(to)}, which the answer names, spliced it, and wired ${nameOf(gap.slug)} into its mask`);
      return true;
    }
    return false;
  };

  /** A picture node the plan adds with its mask input free, and a mask
   * node the answer names with it in one sentence that the plan never
   * adds: the mask node is added after it (the gaps then feed it the
   * photograph and wire it into that mask). */
  const addNamedMask = (p: Played): boolean => {
    const free = [...p.bySlug.entries()].filter(([slug, nid]) => takesMask(specOfSlug(slug)!.type) && !fed(p.state, nid, "mask"));
    if (free.length !== 1) return false;
    const [to] = free[0];
    const sentences = opts.answer.split(/(?<=[.!?])\s+|\n+/);
    // A sentence about masking it, not one that only shares a word
    // ("weight by channel" beside Grain is not the Channel node).
    const withIt = sentences.filter((s) => namedTypes(s).has(specOfSlug(to)!.type) && /\bmask/i.test(s));
    const masks = [...named].filter((t) => makesMask(t) && !p.bySlug.has(nodeSlug(t)) && STOP_BY_ID.has(`graph.add.${nodeSlug(t)}`) && withIt.some((s) => namedTypes(s).has(t)));
    if (masks.length !== 1) return false;
    const slug = nodeSlug(masks[0]);
    insertAfter(lastIndexAbout(to), [addStep(slug)]);
    repairs.push(`added ${nameOf(slug)}, which the answer names for ${nameOf(to)}'s mask`);
    return true;
  };

  const ORDER: Gap["kind"][] = ["off-path", "no-picture-in", "mask-unfed", "mask-unused"];
  let triedNamedMask = false;
  // A node the answer tells the user to add ("add a Blur node", "type
  // Recolor to add it") that the plan never adds: added before the
  // plan's first step about it, else after the palette step that names
  // it, else after the plan's last add.
  for (const type of named) {
    const slug = nodeSlug(type);
    if (FIXED.has(type) || !STOP_BY_ID.has(`graph.add.${slug}`) || addIndex(slug) >= 0 || !toldToAdd(opts.answer, specOfSlug(slug)!.name, type)) continue;
    const about = steps.findIndex((x) => involves(x, slug));
    const palette = steps.map((x, i) => (x.stop === "graph.add" && namedTypes(x.say).has(type) ? i : -1)).filter((i) => i >= 0).pop() ?? -1;
    const lastAdd = steps.map((x, i) => (addsOf(x) ? i : -1)).filter((i) => i >= 0).pop() ?? -1;
    const at = about >= 0 ? about - 1 : palette >= 0 ? palette : lastAdd >= 0 ? lastAdd : steps.length - 1;
    insertAfter(at, [addStep(slug)]);
    repairs.push(`added ${nameOf(slug)}, which the answer says to add`);
  }

  // A step at a lone port: the wire it implies, when its sentence names
  // one other node to wire to (the plan then keeps it or drops it as
  // any connect); else, when its sentence asks for a drag or it is a
  // port of a node the plan adds, dropped (a port stop only points, and
  // the gaps below make the wires a whole network needs).
  steps = steps.flatMap((x) => {
    const stop = STOP_BY_ID.get(x.stop);
    if (!stop?.port || !stop.nodeType) return [x];
    const own = nodeSlug(stop.nodeType);
    const others = [...namedTypes(x.say)].filter((t) => t !== stop.nodeType);
    if (others.length === 1) {
      const other = nodeSlug(others[0]);
      const pair =
        stop.port.dir === "out"
          ? { from: x.stop, to: `port.${other}.${/\bmask\b/i.test(x.say) && STOP_BY_ID.has(`port.${other}.mask`) ? "mask" : "in"}` }
          : { from: `port.${other}.${outSeatOf(other)}`, to: x.stop };
      if (portsConnect(STOP_BY_ID.get(pair.from), STOP_BY_ID.get(pair.to))) {
        repairs.push(`made the lone port step ${x.stop} the wire it implies, ${pair.from} to ${pair.to}`);
        return [{ stop: "graph.connect", ...pair, say: x.say }];
      }
    }
    const planned = addIndex(own) >= 0;
    if (planned || /\b(drag|connect|wire|plug|link)\b/i.test(x.say)) {
      repairs.push(`dropped the lone port step ${x.stop} (it only points; the plan's wires are made below)`);
      return [];
    }
    return [x];
  });

  /** A splice after a wire into or out of its node lifts that wire (the
   * drop heals the node out of where it was first): the splice moves to
   * right after the node's add. */
  const spliceFirst = (): boolean => {
    for (let j = 0; j < steps.length; j++) {
      const s = steps[j];
      const slug = s.stop === "graph.splice" ? slugOf(s.from) : null;
      const at = slug ? addIndex(slug) : -1;
      if (!slug || at < 0 || at > j) continue;
      const lifted = steps.slice(at + 1, j).some((x) => x.stop === "graph.connect" && [x.from, x.to].some((r) => slugOf(r) === slug));
      if (!lifted) continue;
      steps = steps.filter((_, i) => i !== j);
      insertAfter(at, [s]);
      repairs.push(`moved the splice of ${nameOf(slug)} to right after its add, before its wires`);
      return true;
    }
    return false;
  };

  for (let round = 0; round < 24; round++) {
    if (spliceFirst()) continue;
    const p = play(steps, opts.graph);
    // A wire the plan already made, or one the reducer refuses as the
    // user's drag would be refused (an input already fed by a splice).
    const idle = p.outcomes.findIndex((o, i) => (o === "redundant" || o === "refused" || o === "missing") && (steps[i].stop === "graph.connect" || steps[i].stop === "graph.splice"));
    if (idle >= 0) {
      const s = steps[idle];
      const why = { redundant: "the plan already made it", refused: "its input is already fed", missing: "a node it wires is not there yet" }[p.outcomes[idle] as "redundant" | "refused" | "missing"];
      repairs.push(`dropped ${s.stop} ${[s.from, s.to].filter(Boolean).join(" to ")} (${why})`);
      steps = steps.filter((_, i) => i !== idle);
      continue;
    }
    const gaps = gapsOf(steps, p).sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
    if (gaps.some((g) => close(g, p))) continue;
    if (gaps.length === 0 && !triedNamedMask) {
      triedNamedMask = true;
      if (addNamedMask(p)) continue;
    }
    break;
  }

  const p = play(steps, opts.graph);
  const missing = gapsOf(steps, p).map((g) => `${nameOf(g.slug)}: ${g.kind}`);
  const max = opts.maxSteps ?? 12;
  if (steps.length > max) missing.push(`${steps.length} steps, over ${max}`);
  if (!steps.some((s) => s.stop !== "graph.canvas")) missing.push("no steps left");
  for (const r of repairs) logDebug(() => `tour plan: ${r}`);
  if (repairs.length > 0 || missing.length > 0) {
    logDebug(() => `tour plan: before [${input.map((s) => [s.stop, s.from, s.to].filter(Boolean).join(" ")).join(", ")}] after [${steps.map((s) => [s.stop, s.from, s.to].filter(Boolean).join(" ")).join(", ")}]${missing.length ? `, not whole: ${missing.join("; ")}` : ""}`);
  }
  return { steps, repairs, whole: missing.length === 0, missing };
}
