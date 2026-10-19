// graph.tsx's values and helpers that are not components, kept apart so
// graph.tsx exports components alone and Vite can refresh it in place as
// it is edited instead of reloading the window.
import type { NodeCard, Wire } from "../state";
import { NODE_H, NODE_W, createsCycle, REGISTRY_DEFAULTS, seatTakes } from "../state";
import { MASK_IN_TYPES, THREE_FIELD_INPUTS } from "../nodes";

/** The output a pipe of `kind` leaves `n` from when the hand chooses the
 * source (a drag that starts on an input), or null when the card has no
 * output of that kind. Image pipes leave the image out (the Export
 * Layer's names its pass-through, 26.3 Phase 8); mask pipes leave the
 * card's field output: a masking node's diamond, Depth Map's depth
 * diamond (Phase 4), a File card's or Export Layer's page alpha (Phases
 * 6 and 8). The same table an output-first drag reads off the port it
 * starts on, so both ends of the gesture write the same wire. */
export function sourceSeat(
  kind: "mask" | "image",
  n: NodeCard,
): { seat: "out" | "maskOut" | "depthOut" | "fileMask"; fromPort?: Wire["fromPort"] } | null {
  if (!n.hasOut || (n.isGroup && !wirableGroup(n))) return null;
  if (kind === "mask") {
    if (n.maskOut) return { seat: "maskOut" };
    if (n.depthOut) return { seat: "depthOut", fromPort: "depth" };
    if (n.fileMaskOut) return { seat: "fileMask", fromPort: "mask" };
    return null;
  }
  if (n.maskOut) return null;
  return n.type === "heeler.export_layer" ? { seat: "out", fromPort: "image" } : { seat: "out" };
}

/** A group a pipe may land on and leave from by hand: a node recipe's
 * (2026-09-30: "a group a user drops into their node graph"), whose
 * inputs and output are declared on its boundary, so a pipe on its in,
 * in2 or depth port has one member to go to. A group made from a
 * selection keeps the wiring it was made with, as before.*/
export function wirableGroup(n: NodeCard): boolean {
  return !!n.isGroup && !!n.recipe;
}

/** An input a card draws, by the name the wire carries. */
export type InSeat = "in" | "in2" | "in3" | "mask" | "alpha" | "depth";

/** The inputs card `n` draws, top to bottom then left to right. */
export function drawnSeats(n: NodeCard): InSeat[] {
  return [
    ...(n.hasIn ? (["in"] as const) : []),
    ...(n.hasIn2 ? (["in2"] as const) : []),
    ...(n.hasIn3 ? (["in3"] as const) : []),
    ...(n.maskIn ? (["mask"] as const) : []),
    ...(n.alphaIn ? (["alpha"] as const) : []),
    ...(n.depthIn ? (["depth"] as const) : []),
  ];
}

/** Whether a pipe of `kind` may run from card `src` into input `seat`
 * of card `dst`. The ONE rule the hand reads from both ends: a pipe
 * drawn out of an output lights every input this passes, a pipe drawn
 * out of an input lights every output it passes, and either drop makes
 * the connect the reducer then accepts (seatTakes is its type rule).
 * (2026-10-01): "when dragging a wire from the IN attribute the OUT
 * attributes that are compatible highlight, but not when I drag from
 * an OUT the IN attributes/connections do not".
 *
 * The source needs an output of the pipe's kind (sourceSeat); the
 * Image Source takes nothing; a selection's group is not the hand's to
 * rewire, and a recipe's group takes pictures on its inputs and a field
 * on its depth diamond alone; no self, no loop (`lifted`, the pipe in
 * hand, is left out of the loop check since it is going). */
export function pipeFits(
  wires: Wire[],
  src: NodeCard,
  kind: "mask" | "image",
  dst: NodeCard,
  seat: Wire["toPort"],
  lifted?: Wire,
  cycle?: (from: string, to: string) => boolean,
): boolean {
  if (src.id === dst.id || dst.id === "src" || !sourceSeat(kind, src)) return false;
  if (dst.isGroup) {
    if (!wirableGroup(dst)) return false;
    if (kind === "mask" ? seat !== "depth" : seat !== "in" && seat !== "in2" && seat !== "in3") return false;
  }
  if (!seatTakes(dst, seat, kind === "mask")) return false;
  // `cycle` is a drag's precomputed answer (dragCycleCheck): the fixed
  // end's reachability solved once, instead of one walk of the graph per
  // port per card per pointer move.
  if (cycle) return !cycle(src.id, dst.id);
  return !createsCycle(lifted ? wires.filter((w) => w !== lifted) : wires, src.id, dst.id);
}

/** The cycle half of pipeFits for the pipe in hand, solved once per
 * gesture. Adding src -> dst closes a loop exactly when dst already
 * reaches src, and one end of the pipe is fixed for the gesture's
 * length: drawn out of output `from`, the walk is who reaches `from`
 * (once), and a card fits when it is not in that set; drawn out of
 * input `to`, the walk is whom `to` reaches, and a source fits when it
 * is not in that set. A pointer move then answers in O(1) a question
 * that cost one graph walk per port of every card. */
export function dragCycleCheck(
  wires: Wire[],
  drag: { from?: string; to?: string; lifted?: Wire },
): ((from: string, to: string) => boolean) | undefined {
  const ws = drag.lifted ? wires.filter((w) => w !== drag.lifted) : wires;
  if (drag.from !== undefined) {
    const fixed = drag.from;
    // Every node that can reach the fixed source, itself included (a
    // self loop is a cycle), walking the pipes backward.
    const reaches = new Set<string>([fixed]);
    const stack = [fixed];
    while (stack.length) {
      const cur = stack.pop()!;
      for (const w of ws) {
        if (w.to === cur && !reaches.has(w.from)) {
          reaches.add(w.from);
          stack.push(w.from);
        }
      }
    }
    return (_from, to) => reaches.has(to);
  }
  if (drag.to !== undefined) {
    const fixed = drag.to;
    // Every node the fixed input's card can reach, itself included,
    // walking the pipes forward.
    const reached = new Set<string>([fixed]);
    const stack = [fixed];
    while (stack.length) {
      const cur = stack.pop()!;
      for (const w of ws) {
        if (w.from === cur && !reached.has(w.to)) {
          reached.add(w.to);
          stack.push(w.to);
        }
      }
    }
    return (from, _to) => reached.has(from);
  }
  return undefined;
}

/** Which of `seats` (the fitting inputs of `target`) a drop at `q`
 * lands on, or null when there are none. A drop on or beside an input
 * (within 14 graph px of its center) takes that input. Elsewhere on the
 * card: a picture pipe the nearest stacked input by height (inputAt); a
 * field pipe the operand by height on the logic family, the alpha
 * diamond on Output and Alpha Association, the nearer diamond on the
 * Export Layer and the Displacement Map, the mask diamond elsewhere;
 * and when that input does not fit, the nearest one that does. */
export function dropSeat(target: NodeCard, kind: "mask" | "image", q: { x: number; y: number }, seats: InSeat[]): InSeat | null {
  if (seats.length === 0) return null;
  const dist = (seat: InSeat) => {
    const p = portCenter(target, seat);
    return Math.hypot(q.x - p.x, q.y - p.y);
  };
  const nearest = [...seats].sort((a, b) => dist(a) - dist(b))[0];
  if (dist(nearest) <= 14) return nearest;
  const stacked = seats.filter((s): s is "in" | "in2" | "in3" => s === "in" || s === "in2" || s === "in3");
  const byHeight = (): InSeat | null => {
    if (stacked.length === 0) return null;
    const at = inputAt(target, q.y);
    return stacked.includes(at) ? at : null;
  };
  const preferred: InSeat | null =
    kind === "image" || MASK_IN_TYPES.has(target.type)
      ? byHeight()
      : target.type === "heeler.output" || target.type === "heeler.alpha_association"
        ? "alpha"
        : target.type === "heeler.export_layer" || target.type === "heeler.displacement_map"
          ? Math.abs(q.x - portCenter(target, "alpha").x) < Math.abs(q.x - portCenter(target, "mask").x)
            ? "alpha"
            : "mask"
          : "mask";
  return preferred && seats.includes(preferred) ? preferred : nearest;
}

/** The engine-side name a hand-drawn pipe writes for input `seat`.
 * invert_mask draws its one input as "in" but has always been wired on
 * "mask" by a drop on the card (its registry port's name; recipes write
 * it too), so a drop keeps writing that. */
export function landingPort(target: NodeCard, seat: InSeat): Wire["toPort"] {
  return target.type === "heeler.invert_mask" && seat === "in" ? "mask" : seat;
}

/** Whether two port names are the same input of `target` (invert_mask's
 * one input goes by both "in" and "mask"). */
export function sameInput(target: Pick<NodeCard, "type">, a: Wire["toPort"], b: Wire["toPort"]): boolean {
  if (a === b) return true;
  return target.type === "heeler.invert_mask" && (a === "in" || a === "mask") && (b === "in" || b === "mask");
}

/** The inputs of `dst` a pipe of `kind` out of `src` may land on. */
export function seatsFor(wires: Wire[], src: NodeCard, kind: "mask" | "image", dst: NodeCard, lifted?: Wire, cycle?: (from: string, to: string) => boolean): InSeat[] {
  return drawnSeats(dst).filter((seat) => pipeFits(wires, src, kind, dst, seat, lifted, cycle));
}

/** Where an input sits down the card's left edge. Two inputs stack
 * around the middle; three (Channel Join's r, g, b) spread the height. */
export function inputY(card: { hasIn2?: boolean; hasIn3?: boolean }, port: "in" | "in2" | "in3"): number {
  if (card.hasIn3) return port === "in" ? 20 : port === "in2" ? 36 : 52;
  if (card.hasIn2) return port === "in2" ? 48 : 26;
  return 35;
}

/** The center of a port, in canvas space: where a wire's end belongs.
 *
 * A port is a 7px square (8px for the diamonds) placed by its top-left
 * inside a card that has a 1px border, so its center sits 4.5px in
 * from the coordinate its style names. The wires used to end on that
 * coordinate and so sat a hair above and outside every dot (The
 * report: "the lines between the inputs and outputs aren't exactly
 * aligned with the points, they are slightly offset in +Y"). One
 * function for the wire, the hit-test, the drag ghost and the head
 * handle, so they cannot disagree again.*/
export function portCenter(
  card: NodeCard,
  seat: "in" | "in2" | "in3" | "out" | "maskOut" | "mask" | "clip" | "depthOut" | "depth" | "fileMask" | "alpha",
): { x: number; y: number } {
  switch (seat) {
    case "in":
    case "in2":
    case "in3":
      // left: -4 inside the border, 7px wide.
      return { x: card.x + 0.5, y: card.y + inputY(card, seat) + 4.5 };
    case "out":
      // right: -4, top: 35 - or top: 24 when a depth diamond sits
      // below it (Depth Map, 26.3 Phase 4).
      return { x: card.x + NODE_W - 0.5, y: card.y + (card.depthOut ? 24 : 35) + 4.5 };
    case "maskOut":
      // right: -5, top: 34, 8px diamond.
      return { x: card.x + NODE_W, y: card.y + 34 + 5 };
    case "depthOut":
      // right: -5, top: 47, 8px diamond, under the image out.
      return { x: card.x + NODE_W, y: card.y + 47 + 5 };
    case "fileMask":
      // The File card's second output (26.3 Phase 6): where Depth
      // Map's second diamond sits, a seat one card family each.
      return { x: card.x + NODE_W, y: card.y + 47 + 5 };
    case "alpha":
      // Output's transparency input (26.3 Phase 5): where a mask
      // diamond would sit, on the one card without a mask input. The
      // Export Layer has both (Phase 8), so its alpha diamond sits one
      // seat over, where a clip diamond would sit.
      return { x: card.x + (card.maskIn ? 30 : 9), y: card.y + NODE_H - 1 };
    case "depth":
      // A depth consumer's plane input (26.3 Phase 10.3): beside the
      // mask diamond on the picture tools, in the mask diamond's place
      // on the masks, which have none. No card carries both a depth and
      // an alpha input, so the seat cannot collide.
      return { x: card.x + (card.maskIn ? 30 : 9), y: card.y + NODE_H - 1 };
    case "mask":
      // left: 4, bottom: -4, 8px diamond.
      return { x: card.x + 9, y: card.y + NODE_H - 1 };
    case "clip":
      return { x: card.x + 30, y: card.y + NODE_H - 1 };
  }
}

/** What color an input port wears. Channel Join's three say which
 * plane they are ("The inputs of Channel Join should
 * match the color channel they represent"); everywhere else the
 * primary is the neutral gray and a second input the accent.*/
export function inputColor(card: { type: string }, seat: "in" | "in2" | "in3"): string {
  if (THREE_FIELD_INPUTS.has(card.type)) {
    return seat === "in" ? CHANNEL_PORT.r : seat === "in2" ? CHANNEL_PORT.g : CHANNEL_PORT.b;
  }
  return seat === "in" ? "#6b7178" : "var(--accent)";
}

export const CHANNEL_PORT = { r: "#d9534f", g: "#5cb85c", b: "#4a90e2" } as const;

/** Which stacked input a drop at height `y` on `card` means: the card's
 * height split evenly between however many inputs it has. */
export function inputAt(card: NodeCard, y: number): "in" | "in2" | "in3" {
  // The nearest port's center, so a drop on any pixel of a port lands on
  // that port (thirds of the card height cut into the outer ports).
  const seats: ("in" | "in2" | "in3")[] = card.hasIn3 ? ["in", "in2", "in3"] : card.hasIn2 ? ["in", "in2"] : ["in"];
  let best: "in" | "in2" | "in3" = "in";
  let bestD = Infinity;
  for (const seat of seats) {
    const d = Math.abs(y - (card.y + inputY(card, seat) + 4.5));
    if (d < bestD) {
      bestD = d;
      best = seat;
    }
  }
  return best;
}

/** Node ids whose OUTPUT is display-shaped: everything at or below an
 * enabled Tone Profile or View Transform on the image path (proposal
 * §5's edge badges). The engine's contract keeps every wire
 * scene-linear in ENCODING, but past the display transform the values
 * are shaped for the screen, and an edit that assumes photographic
 * light (white balance, exposure math) is quietly wrong there. The
 * badge is that warning, on the wire where it belongs. Disabled
 * shapers shape nothing; disabled nodes downstream still pass a
 * shaped signal through. */
export function displayShapedIds(
  nodes: { id: string; type: string; enabled: boolean }[],
  wires: Wire[],
): Set<string> {
  const shaped = new Set<string>(
    nodes
      .filter(
        (n) =>
          n.enabled &&
          (n.type === "heeler.tone_profile" || n.type === "heeler.view_transform"),
      )
      .map((n) => n.id),
  );
  // Fixpoint over the image pipes: cheap at graph scale, and immune to
  // the wire array's order.
  let grew = true;
  while (grew) {
    grew = false;
    for (const w of wires) {
      if (w.kind === "mask") continue;
      if (shaped.has(w.from) && !shaped.has(w.to)) {
        shaped.add(w.to);
        grew = true;
      }
    }
  }
  return shaped;
}

/** How many times a graph card has rendered: the test seam for the card
 * drag (a move renders the card in hand, not the other cards). */
export const cardRenders = { n: 0 };

/** How many times a pipe has rendered: the card drag's seam for the
 * pipes (a move redraws the pipes on the cards in hand). */
export const wireRenders = { n: 0 };

/** How many times the editor has rendered: a test seam for the drag
 * probes (a pointer move during a wire drag must not render the cards). */
export const editorRenders = { n: 0 };

/** Which of Develop's mask block rows a mask node's face adds at its
 * foot: Invert where the type declares one (the Luminance Mask and the
 * Smart Mask seat theirs in their own faces), and the Depth mask block
 * where it declares depth_on. */
export function maskFoot(type: string): { invert: boolean; depth: boolean } {
  const declared = REGISTRY_DEFAULTS[type] ?? {};
  const own = type === "heeler.smart_mask" || type === "heeler.luminance_range_mask";
  const isMask = type.endsWith("_mask");
  return {
    invert: isMask && !own && "invert" in declared,
    depth: isMask && type !== "heeler.smart_mask" && "depth_on" in declared,
  };
}

/** The folder above `path`, or null at the tree's root or outside it. */
export function parentFolder(path: string, root: string | null): string | null {
  const trim = (p: string) => (p.length > 1 ? p.replace(/[\\/]+$/, "") : p);
  const here = trim(path);
  const top = root ? trim(root) : null;
  const cut = Math.max(here.lastIndexOf("/"), here.lastIndexOf("\\"));
  if (cut <= 0) return null;
  const up = here.slice(0, cut);
  if (top !== null) {
    if (here === top) return null;
    // Inside the root means below it as a folder, not merely sharing its
    // first letters: /photos2 is not under /photos.
    const inside = up === top || up.startsWith(top + "/") || up.startsWith(top + "\\");
    if (!inside) return null;
  }
  return up;
}
