// What is in the picture, for the assistant. When Florence-2 is
// installed and a question is asked with a photograph open, the main
// window runs it on the frame the picture report measures (the viewer's
// preview, the one the Spectrums read): a detailed caption and the
// object list always, and where a thing the question names is ("the
// cheetah's face"). Each region's brightness and color are measured from
// the same pixels as the report, so the model can say "the sky measures
// 1.5 stops above the tower".
//
// The text holds the caption, the labels and the regions as fractions
// of the picture, with their numbers: nothing about the file, the place
// or the catalog. Florence-2 runs on this computer; its answers are kept
// per frame in the desktop (florence_describe), so a second question
// about the same frame costs nothing. It has a time limit: a slow run
// never holds up the answer, which then goes without it.

import { florenceDescribe, FLORENCE_NOT_INSTALLED, type FlorenceAnswer, type FlorenceRegion, type FlorenceTask } from "./bridge";
import { ev, hueName, measureRegions, pct, type PictureFrame, type RegionStats } from "./assistantpicture";

/** How long the main window waits for Florence-2 before the answer
 * goes without it. Measured on an M4 Max (release, the nine demo
 * photographs): 0.6 to 0.95 s for the caption, the objects and two
 * phrases, plus 0.7 s to load the weights and about a second to verify
 * them on the first question of a session. The run is not canceled at
 * the limit: it finishes and its answers are kept for the next question
 * about the same frame. */
export const VISION_TIMEOUT_MS = 6000;

/** How a question's Florence-2 run went: "ok" with text, "missing"
 * (not installed: the Console's one-time hint), "late" (past the
 * limit), "failed" (any other refusal), "none" (not asked: no frame). */
export type VisionStatus = "ok" | "missing" | "late" | "failed" | "none";

export interface VisionResult {
  /** Caption and objects only, never question-derived grounding. */
  logText?: string;
  text: string | null;
  status: VisionStatus;
}

/** At most this many phrases are looked for per question. */
export const MAX_PHRASES = 2;
/** At most this many region lines go in the text. */
export const MAX_REGIONS = 4;
/** An object the description does not name, smaller than this share of
 * the picture, is left out as a likely false find. */
export const MIN_UNNAMED_AREA = 0.01;
/** Words for people and their parts, one family when an object's label
 * is checked against the description ("human face" against "a man
 * taking a selfie"). */
const PEOPLE = new Set(["person", "people", "man", "men", "woman", "women", "human", "face", "boy", "girl", "child", "children", "selfie", "portrait"]);
/** The caption's length in the text, at most. */
const CAPTION_CHARS = 260;

const DETERMINERS = new Set(["the", "this", "that", "these", "those", "my", "his", "her", "their", "its", "our", "your"]);

/** Words that end a phrase: prepositions, conjunctions, verbs and
 * comparatives ("the sky look darker", "the tower against the sky"). */
const STOP = new Set(
  (
    "a an and or but so if when while because than as to in on at of for from with without by into onto over under above below behind " +
    "near against between around through across along about after before is are was were be been being am look looks looking seem seems " +
    "appear appears stand stands pop pops more less too very much darker brighter lighter warmer cooler sharper softer bluer redder " +
    "greener better worse up down out off it i me we you can could should would will do does did how what why where which who whose " +
    "only just get make makes has have had not all any some each every one ones there here then now still also even really please " +
    "without enough same other own s"
  ).split(" "),
);

/** Heads that are the whole photograph, not a thing in it. */
const WHOLE = new Set(
  "photo photos photograph photographs picture pictures image images shot shots frame frames edit edits file files scene scenes way whole rest thing things version take takes result".split(
    " ",
  ),
);

/** Words for tones, qualities and Heeler's own parts, never a thing to
 * find: "the shadows", "the sky color" (trimmed to "the sky"), "the
 * Develop panel". */
const NOT_A_THING = new Set(
  (
    "shadow shadows highlight highlights midtone midtones tone tones color colors saturation exposure contrast brightness balance " +
    "white whites black blacks noise grain detail details sharpness clarity texture hue hues curve curves histogram slider sliders " +
    "panel panels menu menus node nodes graph layer layers section sections tool tools button buttons tab tabs mask masks selection " +
    "selections preview viewer catalog export settings preferences preset presets look looks mood style edges edge vignette crop " +
    "light lighting glow haze depth focus blur sharpening dehaze levels level temperature tint vibrance luminance gamma stop stops " +
    "ev pixels pixel area areas part parts side sides top bottom left right center middle corner corners background foreground " +
    "halo halos artifacts banding cast"
  ).split(" "),
);

/** The things a question names in the picture, as phrases for
 * Florence-2 to find: a determiner, then up to three words that end at
 * a stop word ("Select this cheetah's face?" gives "the cheetah's
 * face"; "How can I darken the sky to balance the photo?" gives "the
 * sky"). A phrase naming the whole photograph, a tone or a part of
 * Heeler is left out, and so is one with a capitalized word (Heeler's
 * own names: "the Develop panel", "the Sky Rescue section"). Local and
 * cheap; measured against asking the routing call for phrases (the
 * vision cost rule). */
export function groundingPhrases(question: string): string[] {
  const tokens = [...question.replace(/[‘’]/g, "'").matchAll(/[A-Za-z][A-Za-z'-]*/g)].map((m) => m[0]);
  const out: string[] = [];
  for (let i = 0; i < tokens.length && out.length < MAX_PHRASES; i++) {
    if (!DETERMINERS.has(tokens[i].toLowerCase())) continue;
    const words: string[] = [];
    let named = false;
    let j = i + 1;
    for (; j < tokens.length && words.length < 3; j++) {
      const t = tokens[j];
      const low = t.toLowerCase();
      if (STOP.has(low) || DETERMINERS.has(low)) break;
      if (/^[A-Z]/.test(t)) named = true;
      words.push(low);
    }
    if (named || words.length === 0) continue;
    while (words.length && NOT_A_THING.has(words[words.length - 1].replace(/'s?$/, ""))) words.pop();
    if (words.length === 0) continue;
    words[words.length - 1] = words[words.length - 1].replace(/'s?$/, "");
    const head = words[words.length - 1];
    if (!head || WHOLE.has(head) || NOT_A_THING.has(head) || words.some((w) => WHOLE.has(w.replace(/'s?$/, "")))) continue;
    const phrase = `the ${words.join(" ")}`;
    if (!out.includes(phrase)) out.push(phrase);
  }
  return out;
}

/** What Florence-2 is asked for a question: the detailed caption and
 * the objects always, then each phrase the question names. */
export function visionTasks(question: string): FlorenceTask[] {
  return [{ task: "detailed_caption" }, { task: "objects" }, ...groundingPhrases(question).map((phrase) => ({ task: "grounding" as const, phrase }))];
}

function iou(a: FlorenceRegion, b: FlorenceRegion): number {
  const ix = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0));
  const iy = Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
  const inter = ix * iy;
  const area = (r: FlorenceRegion) => Math.max(0, r.x1 - r.x0) * Math.max(0, r.y1 - r.y0);
  const union = area(a) + area(b) - inter;
  return union > 0 ? inter / union : 0;
}

/** How much of `a` lies inside `b`, 0 to 1. */
function overlap(a: FlorenceRegion, b: FlorenceRegion): number {
  const ix = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0));
  const iy = Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
  const area = Math.max(0, a.x1 - a.x0) * Math.max(0, a.y1 - a.y0);
  return area > 0 ? (ix * iy) / area : 0;
}

/** Where a box sits, in words: "top left", "center", "most of the
 * picture". */
export function placeWords(r: FlorenceRegion): string {
  if ((r.x1 - r.x0) * (r.y1 - r.y0) > 0.6) return "most of the picture";
  const cx = (r.x0 + r.x1) / 2;
  const cy = (r.y0 + r.y1) / 2;
  const v = cy < 1 / 3 ? "top" : cy > 2 / 3 ? "bottom" : "middle";
  const hz = cx < 1 / 3 ? "left" : cx > 2 / 3 ? "right" : "center";
  if (v === "middle" && hz === "center") return "center";
  return v === "middle" ? `middle ${hz}` : `${v} ${hz}`;
}

const frac = (x: number) => Math.max(0, Math.min(1, x)).toFixed(2);

function regionLine(name: string, r: FlorenceRegion, s: RegionStats | null): string {
  const where = `${placeWords(r)}, x ${frac(r.x0)}-${frac(r.x1)}, y ${frac(r.y0)}-${frac(r.y1)}`;
  if (!s) return `- ${name}: ${where}`;
  const rest = Number.isFinite(s.restEv) ? ` (rest ${ev(s.restEv)})` : "";
  return `- ${name}: ${where}, area ${pct(s.area)}; ${ev(s.ev)} EV${rest}, ${hueName(s.color.hue, s.color.strength)}, saturation ${pct(s.color.saturation)}`;
}

/** Florence-2's answers as the model reads them, labeled as data: the
 * caption, then the regions (the phrases the question named first,
 * then the objects by size), each measured from `frame`. `tasks` are
 * the tasks the answers answer, in order. */
export function visionText(tasks: FlorenceTask[], answers: FlorenceAnswer[], frame: PictureFrame | null): string {
  const lines = [
    "WHAT IS IN THE PICTURE (a machine description by Florence-2, a small local vision model; it can be wrong)",
  ];
  const caption = tasks.findIndex((t) => t.task === "detailed_caption" || t.task === "caption");
  let described = "";
  if (caption >= 0 && answers[caption]) {
    let text = answers[caption].text.replace(/\s+/g, " ").trim();
    described = text.toLowerCase();
    if (text.length > CAPTION_CHARS) text = `${text.slice(0, CAPTION_CHARS).replace(/\s+\S*$/, "")}...`;
    if (text) lines.push(`Description: ${text}`);
  }
  /** Whether the description names an object's label, by any of its
   * words ("human face" by "face", "man" by "man"). */
  const inDescription = (label: string) =>
    label
      .toLowerCase()
      .split(/\s+/)
      .map((w) => w.replace(/[^a-z]/g, ""))
      .some((w) => w.length > 2 && (PEOPLE.has(w) ? [...PEOPLE].some((p) => new RegExp(`\\b${p}`).test(described)) : new RegExp(`\\b${w}`).test(described)));
  // Phrases first, then objects by size; a box that repeats one already
  // listed is left out.
  const picked: { name: string; r: FlorenceRegion }[] = [];
  const notFound: string[] = [];
  const kept = (r: FlorenceRegion) => picked.some((p) => iou(p.r, r) > 0.85);
  tasks.forEach((t, i) => {
    if (t.task !== "grounding") return;
    const boxes = (answers[i]?.regions ?? []).filter((r) => r.x1 > r.x0 && r.y1 > r.y0);
    if (boxes.length === 0) {
      notFound.push(`"${t.phrase}"`);
      return;
    }
    // The first box, the one Florence-2 gives first; others that are
    // not inside it are counted, not listed (a phrase's boxes are often
    // one place and a part of it).
    const r = boxes[0];
    if (picked.length >= MAX_REGIONS || kept(r)) return;
    const elsewhere = boxes.slice(1).filter((o) => overlap(o, r) < 0.5).length;
    // The label of a phrase's box is the question's own words (or a
    // part of them), not Florence-2 naming the thing: said so, so a
    // model never reads it as an identification.
    const label = r.label.trim();
    const same = !label || label.toLowerCase() === t.phrase.toLowerCase();
    const also = elsewhere ? `, and ${elsewhere} more ${elsewhere === 1 ? "place" : "places"}` : "";
    picked.push({
      name: same ? `"${t.phrase}" (the question's words${also})` : `"${t.phrase}" (the question's words; found only as "${label}", so the box may hold more${also})`,
      r,
    });
  });
  // An object the description does not name is marked, and a tiny one
  // it does not name is left out: measured on the demo photographs,
  // those were the false finds (a "person" of 0.2% in an empty
  // landscape, which a model then advised lifting).
  const area = (r: FlorenceRegion) => (r.x1 - r.x0) * (r.y1 - r.y0);
  const objects = tasks
    .flatMap((t, i) => (t.task === "objects" ? answers[i]?.regions ?? [] : []))
    .filter((r) => r.x1 > r.x0 && r.y1 > r.y0)
    .filter((r) => !described || inDescription(r.label) || area(r) >= MIN_UNNAMED_AREA)
    .sort((a, b) => area(b) - area(a));
  const more = new Map<string, number>();
  for (const r of objects) {
    if (kept(r)) continue;
    if (picked.length >= MAX_REGIONS) {
      more.set(r.label, (more.get(r.label) ?? 0) + 1);
      continue;
    }
    const label = r.label || "object";
    picked.push({ name: !described || inDescription(label) ? label : `${label} (not in the description)`, r });
  }
  const stats = frame ? measureRegions(frame, picked.map((p) => p.r)) : picked.map(() => null);
  if (picked.length) {
    lines.push("Regions (x, y as fractions from the top left; mean brightness and color measured by Heeler):");
    picked.forEach((p, i) => lines.push(regionLine(p.name, p.r, stats[i])));
    if (more.size) lines.push(`Also found: ${[...more].map(([label, count]) => `${count} more ${label}`).join(", ")}.`);
  } else {
    lines.push("Regions: no objects found.");
  }
  if (notFound.length) lines.push(`Not found: ${notFound.join(", ")}.`);
  return lines.join("\n");
}

/** Florence-2 for a question, in the main window, on the frame the
 * picture report measures: the caption, the objects and the question's
 * phrases, with each region measured from `frame`, or nothing when it
 * is not installed, fails, or runs past `limitMs`. Never rejects. */
export async function describeForAssistant(opts: {
  frameUrl: string;
  frame: Promise<PictureFrame | null>;
  question: string;
  describe?: (frameUrl: string, tasks: FlorenceTask[]) => Promise<FlorenceAnswer[]>;
  limitMs?: number;
}): Promise<VisionResult> {
  const describe = opts.describe ?? florenceDescribe;
  const tasks = visionTasks(opts.question);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<VisionResult>((resolve) => {
    timer = setTimeout(() => resolve({ text: null, status: "late" }), opts.limitMs ?? VISION_TIMEOUT_MS);
  });
  const run = (async (): Promise<VisionResult> => {
    try {
      const answers = await describe(opts.frameUrl, tasks);
      const frame = await opts.frame.catch(() => null);
      const pictureOnly = tasks.flatMap((task, i) => task.task === "grounding" ? [] : [{ task, answer: answers[i] }]);
      return {
        text: visionText(tasks, answers, frame),
        logText: visionText(pictureOnly.map((p) => p.task), pictureOnly.map((p) => p.answer), frame),
        status: "ok",
      };
    } catch (e) {
      const words = String(e instanceof Error ? e.message : e);
      return { text: null, status: words.startsWith(FLORENCE_NOT_INSTALLED.slice(0, 27)) ? "missing" : "failed" };
    }
  })();
  try {
    return await Promise.race([run, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** Said to the model with the description: what it is and how far to
 * trust it (2026-09-28: Florence-2 called a cheetah a leopard and a
 * serval).*/
export const VISION_ANSWER =
  "- WHAT IS IN THE PICTURE comes from Florence-2, a small vision model running on this computer, not from you and not from the photographer. It can be wrong: it has called a cheetah a leopard and a serval, and it can find things that are not there. Use it for where things are and roughly what they are; a region marked \"not in the description\" may not be there at all, so never build advice around it. Use the regions' measured brightness and color to compare parts of the picture (\"the sky measures 1.5 stops above the tower\"); say where things are in plain words (\"the left half\", \"top right\"), not as coordinates. Never state a species, a name, a place or a brand from it, and never use it to correct the user: when the user names the subject, use the user's word and leave the description's name for it out. When it disagrees with the user, the user is right: the photographer's eyes decide.";
