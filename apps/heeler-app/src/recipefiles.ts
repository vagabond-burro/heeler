// Node recipes as files (2026-10-01: "As for YAML, I see there are
// crates for YAML can't you use those? I am thinking ease of manual
// editing which YAML is far better at than JSON").
//
// A person's recipes live in <app data>/recipes/<Category>/<Name>
// .heelerrecipe, YAML, beside presets. The desktop reads and writes the
// YAML (src-tauri/src/recipe_files.rs) and hands this side the document
// in the file's own shape as JSON, with the line of every field. Here
// the document becomes a group (groupFromDoc) and a group becomes a
// document (docFromGroup), and the checks only this side can make
// (does this Heeler have the node type, does the node have that port,
// is that a choice the setting offers) name the file's line too.
//
// The file's shape, short: a version, name, description, category;
// `nodes:` keyed by short ids, each with its type and only the settings
// that differ from the type's defaults; `wires:` as `from: blur.out`,
// `to: high.in`; `inputs:` and `output:` for the group's ports;
// `controls:` for the published controls. The user guide's Recipe
// files section has a full commented example (and a test parses it).

import {
  loadNodeRecipes,
  recipeExport,
  recipeImport,
  recipeList,
  recipeRename,
  recipeSave,
  recipeTrash,
  saveNodeRecipes,
  type RecipeFileEntry,
} from "./bridge";
import { makeNode, specFor } from "./nodes";
import { RECIPE_TEMPLATE_ID, parseUserRecipes, type NodeRecipe, type RecipeOp } from "./noderecipes";
import registryDefaultsJson from "./registry-defaults.json";
import { PARAM_OPTIONS, publishedTargets, type Command, type NodeCard, type Published, type Wire } from "./state";

const REGISTRY = registryDefaultsJson as Record<string, Record<string, number>>;

export const RECIPE_FILE_VERSION = 1;

export interface RecipeDocNode {
  id: string;
  type: string;
  name?: string;
  at?: [number, number];
  enabled?: boolean;
  note?: string;
  tint?: string;
  params?: Record<string, number | string | boolean>;
  curves?: NodeCard["curves"];
  curve_interp?: string;
  curve_tangents?: NodeCard["curveTangents"];
  curve_handles?: NodeCard["curveHandles"];
}

export interface RecipeDocControl {
  label: string;
  drives?: string[];
  range?: [number, number];
  default?: number;
  reads?: string;
  options?: { label: string; set: { target: string; value: number | string }[] }[];
}

/** A recipe file's document, in the file's own shape (the desktop's
 * JSON form of the YAML: ordered lists where the file has ordered
 * fields). */
export interface RecipeDoc {
  heeler_recipe: 1;
  name: string;
  description?: string;
  category?: string;
  keywords?: string;
  inputs?: { port: string; to: string[] }[];
  output: string;
  nodes: RecipeDocNode[];
  wires?: { from: string; to: string }[];
  controls?: RecipeDocControl[];
}

export interface ParsedRecipeFile {
  doc: RecipeDoc;
  /** The line of each field by its path: nodes.blur.type, wires.3.to. */
  lines: Record<string, number>;
}

const OUTSIDE = new Set(["in", "in2", "in3", "mask", "depth"]);

/** A readable id from a card's name: "Low (blur)" is low_blur. */
function slugId(s: string): string {
  const out = s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return /^[a-z_]/.test(out) ? out : `n_${out}`;
}

/** A member's short id in the file: its id without the group's suffix
 * (a dropped recipe's members are `${part}_${groupId}`), else a word
 * from its name. */
function shortIds(group: NodeCard): Map<string, string> {
  const taken = new Set<string>();
  const out = new Map<string, string>();
  for (const m of group.groupNodes ?? []) {
    const suffix = `_${group.id}`;
    let base = m.id.endsWith(suffix) && m.id.length > suffix.length ? m.id.slice(0, -suffix.length) : slugId(m.name || m.type.replace("heeler.", ""));
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(base)) base = slugId(base);
    let id = base;
    for (let k = 2; taken.has(id); k++) id = `${base}_${k}`;
    taken.add(id);
    out.set(m.id, id);
  }
  return out;
}

/** The settings a fresh card of the type carries, which a file leaves
 * out: the registry's numbers and makeNode's words. */
function baseCard(type: string): NodeCard | null {
  const spec = specFor(type);
  return spec ? makeNode(spec, "x", 0, 0) : null;
}

/** A group as a recipe file's document, or why it cannot be one. */
export function docFromGroup(
  group: NodeCard,
  meta: { name: string; description?: string; category?: string; keywords?: string },
): { doc: RecipeDoc } | { error: string } {
  const members = group.groupNodes ?? [];
  if (!members.length) return { error: `${group.name} has no nodes inside` };
  const ids = shortIds(group);
  const short = (id: string) => ids.get(id);
  const nodes: RecipeDocNode[] = [];
  for (const m of members) {
    if (m.isGroup) return { error: `${m.name} is a group inside the group; a recipe file holds one level` };
    if (m.strokes?.length || m.regions?.length) return { error: `${m.name} carries brush strokes or selections, which belong to a photograph, not a recipe; clear them first` };
    const base = baseCard(m.type);
    if (!base) return { error: `${m.name} is a ${m.type}, which this version of Heeler does not have` };
    const n: RecipeDocNode = { id: short(m.id)!, type: m.type };
    if (m.name !== base.name) n.name = m.name;
    if (m.note) n.note = m.note;
    if (m.tint) n.tint = m.tint;
    n.at = [m.x, m.y];
    if (!m.enabled) n.enabled = false;
    const params: Record<string, number | string> = {};
    const dflt = REGISTRY[m.type] ?? {};
    for (const [k, v] of Object.entries(m.params)) if (typeof v === "number" && Number.isFinite(v) && dflt[k] !== v) params[k] = v;
    for (const [k, v] of Object.entries(m.textParams ?? {})) if (typeof v === "string" && base.textParams?.[k] !== v) params[k] = v;
    if (Object.keys(params).length) n.params = params;
    if (m.curves && Object.keys(m.curves).length) n.curves = m.curves;
    if (m.curveInterp) n.curve_interp = m.curveInterp;
    if (m.curveTangents && Object.keys(m.curveTangents).length) n.curve_tangents = m.curveTangents;
    if (m.curveHandles && Object.keys(m.curveHandles).length) n.curve_handles = m.curveHandles;
    nodes.push(n);
  }
  const wires = (group.groupWires ?? []).flatMap((w) => {
    const from = short(w.from);
    const to = short(w.to);
    return from && to ? [{ from: `${from}.${w.fromPort ?? "out"}`, to: `${to}.${w.toPort}` }] : [];
  });
  // A boundary wire's outside end is "" on a group a recipe dropped, and
  // the real node (Source, Output, a mask) on a group made in the graph by
  // grouping: either way it is the end that is not a member. Reading only
  // "" made every group the user built refuse to save
  // ("nothing inside Cinematic Portrait Grade feeds its output").
  const boundary = group.groupBoundary ?? [];
  const inputs: { port: string; to: string[] }[] = [];
  for (const b of boundary.filter((b) => !short(b.from) && short(b.to))) {
    const port = b.groupPort ?? b.toPort;
    const target = `${short(b.to)}.${b.toPort}`;
    const at = inputs.find((i) => i.port === port);
    if (at) at.to.push(target);
    else inputs.push({ port, to: [target] });
  }
  const outs = boundary.filter((b) => short(b.from) && !short(b.to));
  const leaving = [...new Set(outs.map((b) => `${short(b.from)}${b.fromPort ? `.${b.fromPort}` : ""}`))];
  if (leaving.length === 0) return { error: `nothing inside ${group.name} feeds its output` };
  if (leaving.length > 1) return { error: `${group.name} has ${leaving.length} outputs (${leaving.join(", ")}); a recipe has one` };
  const controls: RecipeDocControl[] = [];
  for (const p of group.published ?? []) {
    const ref = (t: { node: string; param: string }) => (short(t.node) ? `${short(t.node)}.${t.param}` : null);
    if (p.options) {
      const options = p.options.map((o) => ({
        label: o.label,
        set: o.writes.flatMap((w) => (ref(w) ? [{ target: ref(w)!, value: w.value }] : [])),
      })).filter((o) => o.set.length);
      if (!options.length) continue;
      const c: RecipeDocControl = { label: p.label, options };
      const first = options[0].set[0].target;
      if (ref(p) && ref(p) !== first) c.reads = ref(p)!;
      controls.push(c);
    } else {
      const drives = publishedTargets(p).flatMap((t) => (ref(t) ? [ref(t)!] : []));
      if (!drives.length) continue;
      const c: RecipeDocControl = { label: p.label, drives };
      if (p.range) c.range = p.range;
      if (p.default !== undefined) c.default = p.default;
      controls.push(c);
    }
  }
  const doc: RecipeDoc = {
    heeler_recipe: 1,
    name: meta.name,
    ...(meta.description ? { description: meta.description } : {}),
    ...(meta.category ? { category: meta.category } : {}),
    ...(meta.keywords ? { keywords: meta.keywords } : {}),
    ...(inputs.length ? { inputs } : {}),
    output: leaving[0],
    nodes,
    ...(wires.length ? { wires } : {}),
    ...(controls.length ? { controls } : {}),
  };
  return { doc };
}

/** A recipe (built-in or a person's) as a file's document. */
export function docFromRecipe(r: NodeRecipe): { doc: RecipeDoc } | { error: string } {
  return docFromGroup(r.group, {
    name: r.name,
    // A person's recipe made from a group without a note carries the
    // palette's made-up line; the file keeps only a real description.
    ...(r.group.note?.trim() || r.builtin ? { description: r.group.note?.trim() || r.blurb } : {}),
    ...(r.category ? { category: r.category } : {}),
    ...(r.keywords ? { keywords: r.keywords } : {}),
  });
}

const OUT_PORTS = new Set(["out", "depth", "mask", "image"]);

/** A file's document as a recipe's group, or the sentence that says
 * what is wrong and on which line. */
export function groupFromDoc(parsed: ParsedRecipeFile, meta: { id: string; category?: string; path?: string }): { recipe: NodeRecipe } | { error: string } {
  const { doc, lines } = parsed;
  const at = (path: string) => (lines[path] ? `line ${lines[path]}: ` : "");
  const member = (id: string) => `${id}_${RECIPE_TEMPLATE_ID}`;
  const cards = new Map<string, NodeCard>();
  for (const n of doc.nodes) {
    if (n.type === "heeler.group") return { error: `${at(`nodes.${n.id}.type`)}node "${n.id}" is a group; a recipe file holds one level of nodes` };
    const spec = specFor(n.type);
    if (!spec) return { error: `${at(`nodes.${n.id}.type`)}node "${n.id}" is a ${n.type}, which this version of Heeler does not have` };
    const card = makeNode(spec, member(n.id), n.at?.[0] ?? 0, n.at?.[1] ?? 0);
    const params: Record<string, number> = { ...(REGISTRY[n.type] ?? {}) };
    const text: Record<string, string> = {};
    for (const [k, v] of Object.entries(n.params ?? {})) {
      if (typeof v === "string") {
        const choices = PARAM_OPTIONS[n.type]?.[k];
        if (choices && !choices.some((c) => c.id === v)) {
          return { error: `${at(`nodes.${n.id}.params.${k}`)}"${v}" is not a ${k.replace(/_/g, " ")} of ${spec.name}; it takes ${choices.map((c) => c.id).join(", ")}` };
        }
        text[k] = v;
      } else {
        params[k] = typeof v === "boolean" ? (v ? 1 : 0) : v;
      }
    }
    const built: NodeCard = {
      ...card,
      name: n.name ?? card.name,
      enabled: n.enabled ?? true,
      params,
      ...(Object.keys(text).length || card.textParams ? { textParams: { ...card.textParams, ...text } } : {}),
      ...(n.note ? { note: n.note } : {}),
      ...(n.tint ? { tint: n.tint } : {}),
      ...(n.curves ? { curves: n.curves } : {}),
      ...(n.curve_interp ? { curveInterp: n.curve_interp as NodeCard["curveInterp"] } : {}),
      ...(n.curve_tangents ? { curveTangents: n.curve_tangents } : {}),
      ...(n.curve_handles ? { curveHandles: n.curve_handles } : {}),
    };
    cards.set(n.id, built);
  }
  const split = (s: string) => {
    const [node, port] = s.split(".", 2) as [string, string | undefined];
    return { node, port };
  };
  // Where a pipe may land on a card, and leave it.
  const hasInput = (c: NodeCard, port: string) =>
    (port === "in" && c.hasIn) || (port === "in2" && c.hasIn2) || (port === "in3" && c.hasIn3) ||
    (port === "mask" && c.maskIn) || (port === "alpha" && c.alphaIn) || (port === "depth" && c.depthIn);
  const hasOutput = (c: NodeCard, port: string) =>
    (port === "out" && c.hasOut) || (port === "depth" && c.depthOut) || (port === "mask" && c.fileMaskOut) ||
    (port === "image" && c.type === "heeler.export_layer");
  const kindOf = (c: NodeCard, fromPort?: string): Wire["kind"] => (fromPort === "depth" || fromPort === "mask" || c.maskOut ? "mask" : "image");
  const spec = (c: NodeCard) => specFor(c.type)?.name ?? c.type;

  const groupWires: Wire[] = [];
  for (const [i, w] of (doc.wires ?? []).entries()) {
    const f = split(w.from);
    const t = split(w.to);
    const from = cards.get(f.node)!;
    const to = cards.get(t.node)!;
    const fromPort = f.port ?? "out";
    const toPort = t.port ?? "in";
    if (!OUT_PORTS.has(fromPort) || !hasOutput(from, fromPort)) {
      return { error: `${at(`wires.${i}.from`)}${spec(from)} (node "${f.node}") has no "${fromPort}" output` };
    }
    if (!hasInput(to, toPort)) return { error: `${at(`wires.${i}.to`)}${spec(to)} (node "${t.node}") has no "${toPort}" input` };
    groupWires.push({
      from: member(f.node),
      to: member(t.node),
      toPort: toPort as Wire["toPort"],
      kind: kindOf(from, fromPort),
      ...(fromPort !== "out" ? { fromPort: fromPort as Wire["fromPort"] } : {}),
    });
  }

  const boundary: Wire[] = [];
  const ports = new Set<string>();
  for (const input of doc.inputs ?? []) {
    ports.add(input.port);
    for (const [i, target] of input.to.entries()) {
      const t = split(target);
      const c = cards.get(t.node)!;
      const toPort = t.port ?? input.port;
      if (!hasInput(c, toPort)) return { error: `${at(`inputs.${input.port}.${i}`)}${spec(c)} (node "${t.node}") has no "${toPort}" input` };
      boundary.push({
        from: "",
        to: member(t.node),
        toPort: toPort as Wire["toPort"],
        kind: input.port === "depth" || input.port === "mask" ? "mask" : "image",
        ...(toPort !== input.port && OUTSIDE.has(input.port) ? { groupPort: input.port as Wire["groupPort"] } : {}),
      });
    }
  }
  const o = split(doc.output);
  const out = cards.get(o.node)!;
  const outPort = o.port ?? "out";
  if (!OUT_PORTS.has(outPort) || !hasOutput(out, outPort)) return { error: `${at("output")}${spec(out)} (node "${o.node}") has no "${outPort}" output` };
  boundary.push({
    from: member(o.node),
    to: "",
    toPort: "in",
    kind: kindOf(out, outPort),
    ...(outPort !== "out" ? { fromPort: outPort as Wire["fromPort"] } : {}),
  });

  const published: Published[] = [];
  for (const [i, c] of (doc.controls ?? []).entries()) {
    const target = (s: string) => {
      const t = split(s);
      return { node: member(t.node), param: t.port! };
    };
    if (c.options) {
      const options = c.options.map((opt) => ({ label: opt.label, writes: opt.set.map((w) => ({ ...target(w.target), value: w.value })) }));
      const primary = c.reads ? target(c.reads) : { node: options[0].writes[0].node, param: options[0].writes[0].param };
      published.push({ label: c.label, ...primary, options });
    } else {
      const drives = (c.drives ?? []).map(target);
      for (const [j, d] of drives.entries()) {
        const card = [...cards.values()].find((x) => x.id === d.node)!;
        if (PARAM_OPTIONS[card.type]?.[d.param]) {
          return { error: `${at(`controls.${i}.drives.${j}`)}${d.param} on node "${(c.drives ?? [])[j].split(".")[0]}" is a menu setting; give ${c.label} options instead of drives` };
        }
      }
      const [first, ...rest] = drives;
      published.push({
        label: c.label,
        ...first,
        ...(c.range ? { range: c.range } : {}),
        ...(rest.length ? { also: rest } : {}),
        ...(c.default !== undefined ? { default: c.default } : {}),
      });
    }
  }

  const groupNodes = [...cards.values()];
  const group: NodeCard = {
    id: RECIPE_TEMPLATE_ID,
    type: "heeler.group",
    name: doc.name,
    ...(doc.description ? { note: doc.description } : {}),
    cat: "group",
    x: 0,
    y: 0,
    enabled: true,
    params: {},
    isGroup: true,
    recipe: meta.id,
    groupNodes,
    groupWires,
    groupBoundary: boundary,
    published,
    hasIn: ports.has("in"),
    ...(ports.has("in2") ? { hasIn2: true } : {}),
    ...(ports.has("in3") ? { hasIn3: true } : {}),
    ...(ports.has("depth") ? { depthIn: true } : {}),
    ...(ports.has("mask") ? { maskIn: true } : {}),
    hasOut: true,
    ...(kindOf(out, outPort) === "mask" ? { maskOut: true } : {}),
  };
  const count = groupNodes.length;
  return {
    recipe: {
      schema: 1,
      id: meta.id,
      name: doc.name,
      blurb: doc.description?.trim() || `Your recipe: ${count} node${count === 1 ? "" : "s"}`,
      builtin: false,
      ...(doc.keywords ? { keywords: doc.keywords } : {}),
      ...(meta.category ?? doc.category ? { category: meta.category ?? doc.category } : {}),
      ...(meta.path ? { path: meta.path } : {}),
      group,
    },
  };
}

/** A file's id in the palette: its category and file name. */
export const fileRecipeId = (category: string, file: string) => `user:${category}/${file}`;

/** The palette's entry for a file the desktop listed: the recipe, or a
 * grayed entry carrying the file's error. */
export function recipeFromEntry(e: RecipeFileEntry): NodeRecipe {
  const id = fileRecipeId(e.category, e.file);
  const built = e.parsed ? groupFromDoc(e.parsed as ParsedRecipeFile, { id, category: e.category, path: e.path }) : { error: e.error ?? "the file could not be read" };
  if ("recipe" in built) return built.recipe;
  return {
    schema: 1,
    id,
    name: e.file,
    blurb: built.error,
    builtin: false,
    category: e.category,
    path: e.path,
    error: built.error,
    group: { id: RECIPE_TEMPLATE_ID, type: "heeler.group", name: e.file, cat: "group", x: 0, y: 0, enabled: true, params: {}, isGroup: true, groupNodes: [] },
  };
}

/** The recipes folder as the palette lists it; null outside the
 * desktop (the browser build and tests have no folder). */
export async function loadRecipeFiles(): Promise<NodeRecipe[] | null> {
  const entries = await recipeList();
  return entries ? entries.map(recipeFromEntry).map((r) => (movedIds.has(r.id) ? { ...r, aliases: movedIds.get(r.id) } : r)) : null;
}

/** The catalog-era ids each moved recipe answered to, by its file id:
 * a group dropped before the move names the old id, and nodeKind finds
 * the file's recipe through these (its kind line stays GROUP / name). */
const movedIds = new Map<string, string[]>();

/** A moved recipe's file id from the path it was written to. */
function idFromPath(path: string, category = "Personal"): string {
  const file = path.split(/[\\/]/).pop()!.replace(/\.heelerrecipe$/, "");
  return fileRecipeId(category, file);
}

/** Moves the recipes saved in the catalog (before 2026-10-01) into
 * files, once: each is written as a file, then marked `movedTo` in the
 * catalog list, which keeps every entry (the catalog's data is never
 * deleted). Returns the recipes not yet moved (a write that failed),
 * which the palette still shows from the catalog. */
export async function moveCatalogRecipes(): Promise<NodeRecipe[]> {
  const json = await loadNodeRecipes().catch(() => null);
  if (!json) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const left: NodeRecipe[] = [];
  let changed = false;
  movedIds.clear();
  const remember = (entry: Record<string, unknown>) => {
    if (typeof entry.id !== "string" || typeof entry.movedTo !== "string") return;
    const to = typeof entry.movedId === "string" ? entry.movedId : idFromPath(entry.movedTo);
    movedIds.set(to, [...(movedIds.get(to) ?? []), entry.id]);
  };
  for (const entry of raw as Record<string, unknown>[]) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.movedTo) {
      remember(entry);
      continue;
    }
    const [r] = parseUserRecipes(JSON.stringify([entry]));
    if (!r) continue;
    const made = docFromRecipe(r);
    if ("error" in made) {
      left.push(r);
      continue;
    }
    try {
      entry.movedTo = await recipeSave("Personal", made.doc);
      // Old id to new file id, kept in the catalog beside the entry.
      entry.movedId = idFromPath(entry.movedTo as string);
      remember(entry);
      changed = true;
    } catch {
      left.push(r);
    }
  }
  if (changed) await saveNodeRecipes(JSON.stringify(raw));
  stillInCatalog = left;
  return left;
}

/** Catalog recipes whose file could not be written: listed after the
 * files on every read, so none vanishes, and tried again next launch. */
let stillInCatalog: NodeRecipe[] = [];

type D = (cmd: Command) => void;

/** Saved recipes whose file could not be written this session: listed
 * after the files, grayed with the reason (their `error`), so a failed
 * Save as Recipe does not vanish at the next read of the folder. Remove
 * takes one away. */
let unsaved: NodeRecipe[] = [];

/** The list again, from the folder, after a file changed. */
async function reload(dispatch: D): Promise<void> {
  const files = await loadRecipeFiles();
  if (files) dispatch({ type: "set_user_recipes", recipes: [...files, ...stillInCatalog, ...unsaved] });
}

/** The folder read again: the node palette does this each time it
 * opens, so a file added or edited by hand shows without a relaunch. */
export const refreshRecipeFiles = (dispatch: D): Promise<void> => reload(dispatch);

const say = (dispatch: D, text: string) => dispatch({ type: "set_notice", text });

/** The palette's and the graph's recipe edits, made on disk: the
 * reducer has already changed the list on screen; the folder follows
 * and the list is read back. */
export async function runRecipeOps(ops: RecipeOp[], dispatch: D): Promise<void> {
  let touched = false;
  // A save that fails stays in the list as unsaved, grayed with the
  // reason, and is said in plain words; only a written file is "Saved".
  const notSaved = (recipe: NodeRecipe, why: string) => {
    const kept = { ...recipe, error: `Not saved: ${why}` };
    unsaved = [...unsaved.filter((r) => r.id !== recipe.id), kept];
    dispatch({ type: "recipe_not_saved", recipe: kept });
    say(dispatch, `Recipe "${recipe.name}" was not saved: ${why}`);
  };
  for (const op of ops) {
    try {
      if (op.kind === "save") {
        const made = docFromRecipe({ ...op.recipe, category: op.recipe.category ?? "Personal" });
        if ("error" in made) {
          notSaved(op.recipe, made.error);
          continue;
        }
        try {
          await recipeSave(made.doc.category ?? "Personal", made.doc);
        } catch (e) {
          notSaved(op.recipe, e instanceof Error ? e.message : String(e));
          continue;
        }
        touched = true;
        say(dispatch, `Saved recipe "${op.recipe.name}": it is in the node palette under Recipes`);
      } else if (op.recipe.path) {
        if (op.kind === "rename") await recipeRename(op.recipe.path, op.name);
        else await recipeTrash(op.recipe.path);
        touched = true;
      } else if (op.kind === "remove" && unsaved.some((r) => r.id === op.recipe.id)) {
        // An unsaved one has no file: removing it forgets it.
        unsaved = unsaved.filter((r) => r.id !== op.recipe.id);
        touched = true;
      }
    } catch (e) {
      say(dispatch, `${op.recipe.name}: ${String(e)}`);
    }
  }
  if (touched) await reload(dispatch);
}

/** The palette's Import: pick files, copy the readable ones in, say
 * what was refused and why. */
export async function importRecipeFiles(dispatch: D): Promise<void> {
  const report = await recipeImport();
  if (!report) return;
  const n = report.imported.length;
  const failed = report.failed.map(([file, why]) => `${file}: ${why}`);
  if (n || failed.length) {
    say(dispatch, [n ? `Imported ${n} recipe${n === 1 ? "" : "s"}` : "", failed.length ? `Not imported: ${failed.join("; ")}` : ""].filter(Boolean).join(". "));
  }
  if (n) await reload(dispatch);
}

/** The palette's Export: the recipe written to a file the person picks. */
export async function exportRecipeFile(recipe: NodeRecipe, dispatch: D): Promise<void> {
  const made = docFromRecipe(recipe);
  if ("error" in made) {
    say(dispatch, `${recipe.name} cannot be exported: ${made.error}`);
    return;
  }
  try {
    const dest = await recipeExport(made.doc, recipe.name);
    if (dest) say(dispatch, `Exported ${recipe.name} to ${dest}`);
  } catch (e) {
    say(dispatch, `${recipe.name} was not exported: ${String(e)}`);
  }
}
