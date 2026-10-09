// Node recipes: a saved GROUP a person drops into their graph.
//
// 2026-09-30: "It reads like Tier 2 would be something we haven't
// started yet, and that is node recipes. Like presets but instead of a
// whole node network its a group a user drops into their node graph,
// doesn't overwrite anything."
//
// A preset replaces the graph; a recipe adds one group to it, at the
// drop point, with ids of its own, and touches nothing else. Inside is
// ordinary nodes and wires, openable and editable like any group, and
// the published controls are its face from outside. Two drops of the
// same recipe are two independent groups.
//
// Not to be confused with recipes.ts: those are the Develop-tied tool
// groups (Sharpening, Skin Softening, noise reduction, Sky Rescue) that
// a Develop control switches on and mirrors. A node recipe has no
// Develop seat; the graph is its only door.
//
// The built-ins below are DATA: a table of members, wires, the group's
// inputs and output, and the published controls, built into a group
// card by buildRecipe. A later recipe on nodes that do not exist yet
// (Morphology, Guided Filter: another branch is adding them) is one more
// entry here, nothing else. The table is checked by noderecipes.test.ts
// against the node catalog and the registry, and the desktop renders
// the dropped groups with known answers (src-tauri/src/node_recipes.rs,
// over the fixture GEN_FIXTURE=1 npx vitest run noderecipes writes).

import { makeNode, specFor } from "./nodes";
import registryDefaultsJson from "./registry-defaults.json";
import type { NodeCard, Published, PublishedOption, Wire } from "./state";
import { isLayerNode } from "./layerids";

/** The id a built-in recipe's group carries in the table. Every member
 * is `${part}_${RECIPE_TEMPLATE_ID}`, so the drop's copy (which keeps
 * the suffix contract tool groups use) names them `${part}_${groupId}`
 * and a member reads as what it is in the inspector's id line. */
export const RECIPE_TEMPLATE_ID = "recipe";

/** One recipe as the palette lists it and a drop copies it. */
export interface NodeRecipe {
  /** Stored files carry it, for a later change of shape. */
  schema: 1;
  /** A built-in's table key, or `user_...` for one a person saved. */
  id: string;
  name: string;
  /** One line, outcome first, shown under the name. */
  blurb: string;
  builtin: boolean;
  /** Extra words the palette search reads (Image Arithmetic answers
   * "subtract"). */
  keywords?: string;
  /** The group itself, at 0,0. */
  group: NodeCard;
  /** A person's recipe file (2026-10-01): its folder under recipes/
   * and its path, for Rename, Remove and Export. */
  category?: string;
  path?: string;
  /** A file that could not be read: the palette shows it grayed with
   * this sentence (its line included) and offers only Remove. */
  error?: string;
  /** Ids this recipe answered to before it became a file (the catalog
   * era's user_...), so a group dropped then still reads as it. */
  aliases?: string[];
}

/** One step of Save as Recipe, Rename or Remove made on disk; see
 * recipefiles.ts runRecipeOps. */
export type RecipeOp =
  | { kind: "save"; recipe: NodeRecipe }
  | { kind: "rename"; recipe: NodeRecipe; name: string }
  | { kind: "remove"; recipe: NodeRecipe };

/** A member in the table: its part name (the id's head), its type, the
 * name on its card, its spot inside the group, and what it is set to. */
interface MemberDef {
  part: string;
  type: string;
  name: string;
  x: number;
  y: number;
  params?: Record<string, number>;
  text?: Record<string, string>;
  /** On the card's face: what this node is for. */
  note?: string;
}

/** A wire inside: from part, to part, onto which of its inputs. */
type WireDef = [from: string, to: string, toPort?: Wire["toPort"]];

/** One of the group's own inputs and the member it lands on. */
interface InputDef {
  /** The group's port: "in", "in2" (a second picture) or "depth". */
  port: "in" | "in2" | "depth";
  part: string;
  /** The member's port, when it is not the group's own name. */
  toPort?: Wire["toPort"];
}

interface PublishedDef {
  label: string;
  part: string;
  param: string;
  range?: [number, number];
  /** More members the same number lands on, as [part, param]. */
  also?: [part: string, param: string][];
  /** A menu: each choice writes these [part, param, value]. */
  options?: { label: string; writes: [part: string, param: string, value: number | string][] }[];
}

export interface RecipeDef {
  id: string;
  name: string;
  blurb: string;
  keywords?: string;
  members: MemberDef[];
  wires: WireDef[];
  inputs: InputDef[];
  /** The member whose output is the group's. */
  output: string;
  published: PublishedDef[];
}

const REGISTRY = registryDefaultsJson as Record<string, Record<string, number>>;

const memberId = (part: string) => `${part}_${RECIPE_TEMPLATE_ID}`;

/** A wire's kind is its source's: a field out is a mask pipe. */
function wireKind(from: NodeCard): Wire["kind"] {
  return from.maskOut ? "mask" : "image";
}

/** The table entry as a group card at 0,0, members at their spots. */
export function buildRecipe(def: RecipeDef): NodeRecipe {
  const members: NodeCard[] = def.members.map((m) => {
    const spec = specFor(m.type);
    if (!spec) throw new Error(`${def.id}: ${m.part} is a ${m.type}, which the catalog does not offer`);
    const card = makeNode(spec, memberId(m.part), m.x, m.y);
    return {
      ...card,
      name: m.name,
      params: { ...(REGISTRY[m.type] ?? {}), ...(m.params ?? {}) },
      ...(m.text || card.textParams ? { textParams: { ...card.textParams, ...m.text } } : {}),
      ...(m.note ? { note: m.note } : {}),
    };
  });
  const byPart = new Map(def.members.map((m, i) => [m.part, members[i]]));
  const card = (part: string) => {
    const c = byPart.get(part);
    if (!c) throw new Error(`${def.id}: no member ${part}`);
    return c;
  };
  const groupWires: Wire[] = def.wires.map(([from, to, toPort = "in"]) => ({
    from: memberId(from),
    to: memberId(to),
    toPort,
    kind: wireKind(card(from)),
  }));
  const out = card(def.output);
  const groupBoundary: Wire[] = [
    ...def.inputs.map((i): Wire => ({
      from: "",
      to: memberId(i.part),
      toPort: i.toPort ?? i.port,
      kind: i.port === "depth" ? "mask" : "image",
      ...(i.toPort && i.toPort !== i.port ? { groupPort: i.port } : {}),
    })),
    { from: memberId(def.output), to: "", toPort: "in", kind: wireKind(out) },
  ];
  const published: Published[] = def.published.map((p) => {
    card(p.part);
    const options: PublishedOption[] | undefined = p.options?.map((o) => ({
      label: o.label,
      writes: o.writes.map(([part, param, value]) => {
        card(part);
        return { node: memberId(part), param, value };
      }),
    }));
    return {
      label: p.label,
      node: memberId(p.part),
      param: p.param,
      ...(p.range ? { range: p.range } : {}),
      ...(p.also ? { also: p.also.map(([part, param]) => (card(part), { node: memberId(part), param })) } : {}),
      ...(options ? { options } : {}),
    };
  });
  const ports = new Set(def.inputs.map((i) => i.port));
  const maskOut = !!out.maskOut;
  const group: NodeCard = {
    id: RECIPE_TEMPLATE_ID,
    type: "heeler.group",
    name: def.name,
    note: def.blurb,
    cat: "group",
    x: 0,
    y: 0,
    enabled: true,
    params: {},
    isGroup: true,
    recipe: def.id,
    groupNodes: members,
    groupWires,
    groupBoundary,
    published,
    hasIn: ports.has("in"),
    ...(ports.has("in2") ? { hasIn2: true } : {}),
    ...(ports.has("depth") ? { depthIn: true } : {}),
    hasOut: true,
    ...(maskOut ? { maskOut: true } : {}),
  };
  return { schema: 1, id: def.id, name: def.name, blurb: def.blurb, builtin: true, ...(def.keywords ? { keywords: def.keywords } : {}), group };
}

// --- The built-ins ---------------------------------------------------

const COL = 170;
const ROW = 100;
const CHANNELS = [
  ["r", "Red", "red"],
  ["g", "Green", "green"],
  ["b", "Blue", "blue"],
] as const;
/** Channel Join's port for each channel. */
const JOIN_PORT: Record<string, Wire["toPort"]> = { r: "in", g: "in2", b: "in3" };

/** Frequency Separation. Low is the blur; High is the picture minus
 * the blur per channel, signed and unclamped (Math's subtract), scaled
 * by the High gain; and the two add back up per channel (Math's add)
 * with the picture's own alpha, so a picture with transparency comes
 * back as it went in (a blend's compositing would have weighed the
 * high branch by the low branch's coverage). With nothing edited the
 * output is the input within float rounding; with the gain at 0 it is
 * the blur. Each branch has a pass-through where the edits go. */
const FREQUENCY_SEPARATION: RecipeDef = {
  id: "frequency_separation",
  name: "Frequency Separation",
  blurb: "Retouch tone and texture apart: smooth color in the low branch, fix detail in the high, and they add back to the picture",
  keywords: "retouch skin low high blur detail",
  members: [
    { part: "picture", type: "heeler.merge", name: "Picture", x: 0, y: ROW * 2 },
    { part: "blur", type: "heeler.blur", name: "Low (blur)", x: COL, y: 0, params: { radius: 8, angle: 0 }, text: { kind: "gaussian" } },
    { part: "alpha", type: "heeler.measure", name: "Picture alpha", x: COL * 5, y: ROW * 5, text: { metric: "alpha" } },
    ...CHANNELS.flatMap(([c, label, metric], i): MemberDef[] => [
      { part: `pic_${c}`, type: "heeler.measure", name: `Picture ${label}`, x: COL, y: ROW * (2 + i), text: { metric } },
      { part: `low_${c}`, type: "heeler.measure", name: `Low ${label}`, x: COL * 2, y: ROW * (2 + i), text: { metric } },
      { part: `high_${c}`, type: "heeler.math", name: `High ${label}`, x: COL * 3, y: ROW * (2 + i), params: { scale: 1 }, text: { op: "subtract" } },
      { part: `back_low_${c}`, type: "heeler.measure", name: `Edited low ${label}`, x: COL * 6, y: ROW * i, text: { metric } },
      { part: `back_high_${c}`, type: "heeler.measure", name: `Edited high ${label}`, x: COL * 6, y: ROW * (3 + i), text: { metric } },
      { part: `sum_${c}`, type: "heeler.math", name: `${label} low plus high`, x: COL * 7, y: ROW * (1 + i), text: { op: "add" } },
    ]),
    { part: "high", type: "heeler.channel_join", name: "High (detail)", x: COL * 4, y: ROW * 3 },
    {
      part: "edit_low", type: "heeler.merge", name: "Edit low here", x: COL * 4, y: 0,
      note: "Splice tone and color edits after this node",
    },
    {
      part: "edit_high", type: "heeler.merge", name: "Edit high here", x: COL * 5, y: ROW * 3,
      note: "Splice detail edits after this node; values are signed around zero",
    },
    { part: "result", type: "heeler.channel_join", name: "Low plus high", x: COL * 8, y: ROW * 2 },
  ],
  wires: [
    ["picture", "blur"],
    ["blur", "edit_low"],
    ["picture", "alpha"],
    ...CHANNELS.flatMap(([c]): WireDef[] => [
      ["picture", `pic_${c}`],
      ["blur", `low_${c}`],
      [`pic_${c}`, `high_${c}`, "in"],
      [`low_${c}`, `high_${c}`, "in2"],
      [`high_${c}`, "high", JOIN_PORT[c]],
      ["edit_low", `back_low_${c}`],
      ["edit_high", `back_high_${c}`],
      [`back_low_${c}`, `sum_${c}`, "in"],
      [`back_high_${c}`, `sum_${c}`, "in2"],
      [`sum_${c}`, "result", JOIN_PORT[c]],
    ]),
    ["high", "edit_high"],
    ["alpha", "result", "alpha"],
  ],
  inputs: [{ port: "in", part: "picture" }],
  output: "result",
  published: [
    { label: "Radius", part: "blur", param: "radius", range: [0, 200] },
    { label: "High gain", part: "high_r", param: "scale", range: [0, 2], also: [["high_g", "scale"], ["high_b", "scale"]] },
  ],
};

/** The four operations a menu chooses between, written on all three
 * channels' Math nodes at once. */
const ARITHMETIC_OPS = [
  ["Add", "add"],
  ["Subtract", "subtract"],
  ["Multiply", "multiply"],
  ["Divide", "divide"],
] as const;

/** Image Arithmetic: A op B per channel, signed and unclamped, divide
 * safe (zero where B is zero), alpha from A. */
const IMAGE_ARITHMETIC: RecipeDef = {
  id: "image_arithmetic",
  name: "Image Arithmetic",
  blurb: "Two pictures combined by the numbers, channel by channel: add, subtract, multiply or divide, negatives kept, alpha from A",
  keywords: "add subtract multiply divide math difference",
  members: [
    { part: "a", type: "heeler.merge", name: "A", x: 0, y: ROW },
    { part: "b", type: "heeler.merge", name: "B", x: 0, y: ROW * 3 },
    { part: "a_alpha", type: "heeler.measure", name: "A alpha", x: COL, y: 0, text: { metric: "alpha" } },
    ...CHANNELS.flatMap(([c, label, metric], i): MemberDef[] => [
      { part: `a_${c}`, type: "heeler.measure", name: `A ${label}`, x: COL, y: ROW * (1 + i), text: { metric } },
      { part: `b_${c}`, type: "heeler.measure", name: `B ${label}`, x: COL * 2, y: ROW * (2 + i), text: { metric } },
      { part: `op_${c}`, type: "heeler.math", name: `${label} A op B`, x: COL * 3, y: ROW * (1 + i), text: { op: "add" } },
    ]),
    { part: "join", type: "heeler.channel_join", name: "Result", x: COL * 4, y: ROW * 2 },
  ],
  wires: [
    ["a", "a_alpha"],
    ...CHANNELS.flatMap(([c]): WireDef[] => [
      ["a", `a_${c}`],
      ["b", `b_${c}`],
      [`a_${c}`, `op_${c}`, "in"],
      [`b_${c}`, `op_${c}`, "in2"],
      [`op_${c}`, "join", JOIN_PORT[c]],
    ]),
    ["a_alpha", "join", "alpha"],
  ],
  inputs: [
    { port: "in", part: "a" },
    { port: "in2", part: "b", toPort: "in" },
  ],
  output: "join",
  published: [
    {
      label: "Operation",
      part: "op_r",
      param: "op",
      options: ARITHMETIC_OPS.map(([label, op]) => ({
        label,
        writes: CHANNELS.map(([c]): [string, string, string] => [`op_${c}`, "op", op]),
      })),
    },
  ],
};

/** Difference Key: where the foreground differs from the clean plate,
 * by the largest of the three channel differences, thresholded, then
 * opened by Cleanup (a Morphology Open: specks of noise narrower than
 * the window go, the key's shapes stay). Cleanup 0 is the key as it
 * was. */
const DIFFERENCE_KEY: RecipeDef = {
  id: "difference_key",
  name: "Difference Key",
  blurb: "A mask of what changed: the foreground against a clean plate of the same scene, white where they differ",
  keywords: "matte clean plate keyer change",
  members: [
    { part: "fg", type: "heeler.merge", name: "Foreground", x: 0, y: ROW },
    { part: "plate", type: "heeler.merge", name: "Clean plate", x: 0, y: ROW * 3 },
    ...CHANNELS.flatMap(([c, label, metric], i): MemberDef[] => [
      { part: `fg_${c}`, type: "heeler.measure", name: `Foreground ${label}`, x: COL, y: ROW * i, text: { metric } },
      { part: `plate_${c}`, type: "heeler.measure", name: `Plate ${label}`, x: COL, y: ROW * (3 + i), text: { metric } },
      { part: `diff_${c}`, type: "heeler.math", name: `${label} difference`, x: COL * 2, y: ROW * (1 + i), text: { op: "difference" } },
    ]),
    { part: "max_rg", type: "heeler.math", name: "Larger of red, green", x: COL * 3, y: ROW, text: { op: "max" } },
    { part: "max", type: "heeler.math", name: "Largest difference", x: COL * 4, y: ROW * 2, text: { op: "max" } },
    { part: "key", type: "heeler.compare", name: "Key", x: COL * 5, y: ROW * 2, params: { level: 0.05, softness: 0.02 }, text: { op: "gt" } },
    { part: "clean", type: "heeler.morphology", name: "Cleanup", x: COL * 6, y: ROW * 2, params: { radius: 0 }, text: { mode: "open" }, note: "Open: specks narrower than the radius go" },
  ],
  wires: [
    ...CHANNELS.flatMap(([c]): WireDef[] => [
      ["fg", `fg_${c}`],
      ["plate", `plate_${c}`],
      [`fg_${c}`, `diff_${c}`, "in"],
      [`plate_${c}`, `diff_${c}`, "in2"],
    ]),
    ["diff_r", "max_rg", "in"],
    ["diff_g", "max_rg", "in2"],
    ["max_rg", "max", "in"],
    ["diff_b", "max", "in2"],
    ["max", "key", "in"],
    ["key", "clean", "in"],
  ],
  inputs: [
    { port: "in", part: "fg" },
    { port: "in2", part: "plate", toPort: "in" },
  ],
  output: "clean",
  published: [
    { label: "Threshold", part: "key", param: "level", range: [0, 1] },
    { label: "Softness", part: "key", param: "softness", range: [0, 1] },
    { label: "Cleanup", part: "clean", param: "radius", range: [0, 20] },
  ],
};

/** Depth and Color Matte: a window on the depth plane (Near to Far,
 * each edge feathered) and a hue band, combined by Intersect (min) or
 * Union (max). Depth is farness, 0 near and 1 far, the Depth Map's
 * depth output. */
const DEPTH_COLOR_MATTE: RecipeDef = {
  id: "depth_color_matte",
  name: "Depth and Color Matte",
  blurb: "A mask by distance and by color at once: a band of depth and a band of hue, where both hold or where either does",
  keywords: "mask matte hue depth range distance",
  members: [
    { part: "depth", type: "heeler.math", name: "Depth", x: 0, y: 0, text: { op: "add" } },
    { part: "near", type: "heeler.compare", name: "Near edge", x: COL, y: 0, params: { level: 0, softness: 0 }, text: { op: "ge" } },
    { part: "far", type: "heeler.compare", name: "Far edge", x: COL, y: ROW, params: { level: 0.5, softness: 0.05 }, text: { op: "le" } },
    { part: "window", type: "heeler.logic", name: "Depth window", x: COL * 2, y: ROW / 2, text: { op: "and" } },
    { part: "hue", type: "heeler.hue_range_mask", name: "Hue band", x: COL * 2, y: ROW * 2 },
    { part: "combine", type: "heeler.logic", name: "Combine", x: COL * 3, y: ROW, text: { op: "and" } },
  ],
  wires: [
    ["depth", "near"],
    ["depth", "far"],
    ["near", "window", "in"],
    ["far", "window", "in2"],
    ["window", "combine", "in"],
    ["hue", "combine", "in2"],
  ],
  inputs: [
    { port: "in", part: "hue" },
    { port: "depth", part: "depth", toPort: "in" },
  ],
  output: "combine",
  published: [
    { label: "Near", part: "near", param: "level", range: [0, 1] },
    { label: "Near feather", part: "near", param: "softness", range: [0, 1] },
    { label: "Far", part: "far", param: "level", range: [0, 1] },
    { label: "Far feather", part: "far", param: "softness", range: [0, 1] },
    { label: "Hue", part: "hue", param: "band_center", range: [0, 360] },
    { label: "Hue width", part: "hue", param: "hue_range", range: [0, 180] },
    { label: "Hue feather", part: "hue", param: "hue_falloff", range: [0, 120] },
    {
      label: "Combine",
      part: "combine",
      param: "op",
      options: [
        { label: "Intersect", writes: [["combine", "op", "and"]] },
        { label: "Union", writes: [["combine", "op", "or"]] },
      ],
    },
  ],
};

/** The eight sources a Channel Shuffle output channel can take. Each
 * is the writes on that channel's four members: whether the source
 * picks B (the selector's offset, 0 or 1), which channel is read, and
 * whether the value passes (scale 1) or a constant replaces it. */
function shuffleOptions(c: string): NonNullable<PublishedDef["options"]> {
  const pick = (image: 0 | 1, metric: string, label: string) => ({
    label,
    writes: [
      [`sel_${c}`, "offset", image],
      [`read_${c}`, "metric", metric],
      [`value_${c}`, "scale", 1],
      [`value_${c}`, "offset", 0],
    ] as [string, string, number | string][],
  });
  const constant = (v: 0 | 1) => ({
    label: String(v),
    writes: [
      [`value_${c}`, "scale", 0],
      [`value_${c}`, "offset", v],
    ] as [string, string, number | string][],
  });
  return [
    pick(0, "red", "A red"),
    pick(0, "green", "A green"),
    pick(0, "blue", "A blue"),
    pick(1, "red", "B red"),
    pick(1, "green", "B green"),
    pick(1, "blue", "B blue"),
    constant(0),
    constant(1),
  ];
}

/** Channel Shuffle: each output channel from any channel of A or B, or
 * a constant 0 or 1; alpha from A. Per channel a Conditional picks A or
 * B (its condition a uniform field, 0 or 1, from a Math node), a
 * Measure reads the chosen channel, and a Math passes it or replaces it
 * with a constant. */
const CHANNEL_SHUFFLE: RecipeDef = {
  id: "channel_shuffle",
  name: "Channel Shuffle",
  blurb: "Rebuild a picture from channels: each of red, green and blue taken from either picture, or set to 0 or 1",
  keywords: "swap channels copy channel rgb",
  members: [
    { part: "a", type: "heeler.merge", name: "A", x: 0, y: ROW },
    { part: "b", type: "heeler.merge", name: "B", x: 0, y: ROW * 3 },
    { part: "a_alpha", type: "heeler.measure", name: "A alpha", x: COL, y: 0, text: { metric: "alpha" } },
    ...CHANNELS.flatMap(([c, label, metric], i): MemberDef[] => [
      { part: `sel_${c}`, type: "heeler.math", name: `${label}: B when 1`, x: COL * 2, y: ROW * (1 + i), params: { constant: 0, scale: 0, offset: 0 }, text: { op: "add" } },
      { part: `pick_${c}`, type: "heeler.conditional", name: `${label} source`, x: COL * 3, y: ROW * (1 + i) },
      { part: `read_${c}`, type: "heeler.measure", name: `${label} channel`, x: COL * 4, y: ROW * (1 + i), text: { metric } },
      { part: `value_${c}`, type: "heeler.math", name: `${label} value`, x: COL * 5, y: ROW * (1 + i), params: { constant: 0, scale: 1, offset: 0 }, text: { op: "add" } },
    ]),
    { part: "join", type: "heeler.channel_join", name: "Result", x: COL * 6, y: ROW * 2 },
  ],
  wires: [
    ["a", "a_alpha"],
    ...CHANNELS.flatMap(([c]): WireDef[] => [
      ["a_alpha", `sel_${c}`, "in"],
      ["a", `pick_${c}`, "in"],
      ["b", `pick_${c}`, "in2"],
      [`sel_${c}`, `pick_${c}`, "mask"],
      [`pick_${c}`, `read_${c}`],
      [`read_${c}`, `value_${c}`, "in"],
      [`value_${c}`, "join", JOIN_PORT[c]],
    ]),
    ["a_alpha", "join", "alpha"],
  ],
  inputs: [
    { port: "in", part: "a" },
    { port: "in2", part: "b", toPort: "in" },
  ],
  output: "join",
  published: CHANNELS.map(([c, label]) => ({
    label: `${label} from`,
    part: `read_${c}`,
    param: "metric",
    options: shuffleOptions(c),
  })),
};

/** The table, in palette order. */
export const RECIPE_DEFS: readonly RecipeDef[] = [
  FREQUENCY_SEPARATION,
  IMAGE_ARITHMETIC,
  DIFFERENCE_KEY,
  DEPTH_COLOR_MATTE,
  CHANNEL_SHUFFLE,
];

export const BUILTIN_RECIPES: readonly NodeRecipe[] = RECIPE_DEFS.map(buildRecipe);

/** The palette's search over recipes: name first, then the blurb and
 * keywords, the same order nodes are scored in. */
export function searchRecipes(recipes: readonly NodeRecipe[], query: string): NodeRecipe[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...recipes];
  const scored: { r: NodeRecipe; score: number }[] = [];
  for (const r of recipes) {
    const name = r.name.toLowerCase();
    let score = -1;
    if (name.startsWith(q)) score = 0;
    else if (name.includes(q)) score = 1;
    else if ((r.keywords ?? "").toLowerCase().split(/\s+/).some((k) => k.startsWith(q))) score = 2;
    else if (r.blurb.toLowerCase().includes(q)) score = 3;
    if (score >= 0) scored.push({ r, score });
  }
  return scored.sort((a, b) => a.score - b.score).map((s) => s.r);
}

/** Whether a group may be saved as a recipe: a group of the graph's own,
 * not a Develop tool group (its Develop control would be orphaned) and
 * not a layer's or the Finish stack's (their ids are the photograph's). */
export function savableAsRecipe(n: NodeCard | undefined): boolean {
  return !!n && !!n.isGroup && !!n.groupNodes?.length && !n.tool && n.id !== "art" && !isLayerNode(n.id) && !n.id.startsWith("art_");
}

/** A person's group as a recipe: a snapshot of the group (members,
 * wires, boundary, published controls, notes), at 0,0, its outside
 * wires left behind. */
export function recipeFromGroup(group: NodeCard, name: string, id: string): NodeRecipe {
  const snapshot: NodeCard = structuredClone({ ...group, x: 0, y: 0, name, recipe: id });
  delete snapshot.tool;
  const count = group.groupNodes?.length ?? 0;
  return {
    schema: 1,
    id,
    name,
    blurb: group.note?.trim() || `Your recipe: ${count} node${count === 1 ? "" : "s"}`,
    builtin: false,
    group: snapshot,
  };
}

/** The stored list, read back. Anything that is not a recipe of a
 * known schema is left out rather than breaking the list, and so is an
 * entry already moved into a recipe file (`movedTo`, recipefiles.ts):
 * the catalog keeps it, the file is what lists. */
export function parseUserRecipes(json: string | null): NodeRecipe[] {
  if (!json) return [];
  try {
    const raw = JSON.parse(json) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (r): r is NodeRecipe =>
        !!r && typeof r === "object" && (r as NodeRecipe).schema === 1 && typeof (r as NodeRecipe).id === "string" &&
        typeof (r as NodeRecipe).name === "string" && typeof (r as NodeRecipe).blurb === "string" &&
        ((r as NodeRecipe).keywords === undefined || typeof (r as NodeRecipe).keywords === "string") &&
        !!(r as NodeRecipe).group?.isGroup && Array.isArray((r as NodeRecipe).group.groupNodes) &&
        Array.isArray((r as NodeRecipe).group.groupWires) &&
        ((r as NodeRecipe).group.groupBoundary === undefined || Array.isArray((r as NodeRecipe).group.groupBoundary)) &&
        !(r as { movedTo?: string }).movedTo,
    ).map((r) => ({ ...r, builtin: false }));
  } catch {
    return [];
  }
}
