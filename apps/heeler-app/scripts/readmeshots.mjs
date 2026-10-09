// Screenshots for the repository's README.
//
// Drives the browser build headless, the way docshots.mjs does, and
// writes full-window figures into the README's figure folder. Each scene starts from
// a fresh page. The browser build renders the photograph as it came, not
// through the engine, so these scenes show the interface and the graph,
// never an edit's result: a figure of a black and white treatment would
// show a color photograph under it.
//
// node scripts/readmeshots.mjs            # every scene
// node scripts/readmeshots.mjs graph      # scenes whose name starts so
//
// README_APP points it at another port (5173 by default), README_OUT at
// another folder.

import puppeteer from "puppeteer-core";
import { mkdirSync } from "node:fs";

const BROWSER_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const APP = process.env.README_APP ?? "http://localhost:5173";
const OUT = process.env.README_OUT ?? new URL("../../../docs/readme", import.meta.url).pathname;
const only = process.argv[2] ?? "";

const t = (id) => `[data-testid="${id}"]`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: BROWSER_PATH,
  headless: "shell",
  args: ["--hide-scrollbars"],
});
mkdirSync(OUT, { recursive: true });

async function freshPage() {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  await page.goto(APP, { waitUntil: "networkidle0" });
  await page.waitForSelector(t("browser-panel"));
  await sleep(400);
  return page;
}

async function save(page, name) {
  await page.mouse.move(2, 895);
  await sleep(300);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log(`  ✓ ${name}`);
}

async function workspace(page, index) {
  await page.evaluate((index) => {
    document.querySelector('[role="tablist"][aria-label="Workspace mode"]').children[index].click();
  }, index);
  await sleep(600);
}

/** The README's example network on the Devils Tower frame: the detail
 * lifted only where it is bright (a Luminance Mask into Detail), the
 * blues graded on their own (a Hue Range Mask into Color Grade), and a
 * lightning storm screened in from the catalog, all before the Tone
 * Profile. Placed by hand in three bands so it reads at a glance: the
 * masks above the main line, the storm below it. */
async function exampleGraph(page) {
  await page.evaluate(() => {
    const card = (id, type, name, cat, x, y, extra = {}) => ({
      id, type, name, cat, x, y, enabled: true, params: {},
      hasIn: type !== "heeler.image_source" && type !== "heeler.catalog",
      hasOut: type !== "heeler.output", ...extra,
    });
    const img = (from, to, toPort = "in") => ({ from, to, toPort, kind: "image" });
    const msk = (from, to, toPort = "mask") => ({ from, to, toPort, kind: "mask" });
    const nodes = [
      card("src", "heeler.image_source", "Image Source", "source", 0, 150),
      card("lum", "heeler.luminance_range_mask", "Luminance Mask", "masking", 100, 0, { maskOut: true, params: { low: 0.35, high: 1, feather: 0.2 } }),
      card("detail", "heeler.detail", "Detail", "detail", 200, 150, { maskIn: true, params: { clarity: 45, texture: 25 } }),
      card("hue", "heeler.hue_range_mask", "Hue Range Mask", "masking", 300, 0, { maskOut: true, params: { band_center: 210, hue_range: 70, hue_falloff: 30 } }),
      card("grade", "heeler.color_grade", "Color Grade", "color", 400, 150, { maskIn: true, params: { hue_shift: -18, saturation: 30, exposure: -0.3 } }),
      card("cat", "heeler.catalog", "Catalog", "source", 430, 290, { textParams: { image: "4871", mode: "developed" } }),
      card("blend", "heeler.blend", "Blend Mode", "utility", 620, 150, { hasIn2: true, maskIn: true, params: { opacity: 40 }, textParams: { mode: "screen", fit: "fill" } }),
      card("profile", "heeler.tone_profile", "Tone Profile", "color", 820, 150, { maskIn: true }),
      card("output", "heeler.output", "Output", "utility", 1010, 150),
    ];
    const wires = [
      img("src", "lum"), msk("lum", "detail"), img("src", "detail"),
      img("detail", "hue"), msk("hue", "grade"), img("detail", "grade"),
      img("grade", "blend", "in"), img("cat", "blend", "in2"),
      img("blend", "profile"), img("profile", "output"),
    ];
    const h = window.__heeler;
    h.dispatch({ type: "select_image", id: "4866" });
    h.dispatch({ type: "replace_graph", nodes, wires });
    h.dispatch({ type: "toggle_browser" });
    h.dispatch({ type: "toggle_ribbon" });
  });
  await sleep(400);
}

/** An edit made in Develop on the Devils Tower frame: Exposure and Color
 * moved, Detail, Color Wheels and Vignette switched on. Each section
 * writes its own node, so the Canvas scene shows this same edit as the
 * graph Develop built. */
async function developEdit(page) {
  await page.evaluate(() => window.__heeler.dispatch({ type: "select_image", id: "4866" }));
  await sleep(600);
  for (const slug of ["detail", "color-wheels", "vignette"]) {
    await page.evaluate((slug) => {
      const sw = document.querySelector(`[data-testid="toggle-${slug}"]`);
      if (sw && sw.dataset.on !== "true") sw.click();
    }, slug);
    await sleep(200);
  }
  await page.evaluate(() => {
    const h = window.__heeler;
    const set = (id, param, value) => h.dispatch({ type: "set_param", id, param, value });
    set("exposure", "exposure", 0.3);
    set("exposure", "highlights", -40);
    set("exposure", "shadows", 25);
    set("stdcolor", "temperature", 5800);
    set("stdcolor", "vibrance", 20);
    set("detail", "clarity", 30);
    set("detail", "texture", 20);
    set("vignette", "vignette", -25);
    h.dispatch({ type: "open_sections", titles: ["Exposure", "Detail"] });
    h.dispatch({ type: "close_sections", titles: ["Color", "Color Wheels"] });
  });
  await sleep(400);
}

/** Develop's chain, kept node for node with its values, grown into what
 * only the graph can do: a Luminance Mask steering Detail to the bright
 * rock, a Hue Range Mask steering Color Balance to the sky, and a
 * lightning storm screened into the sky from the catalog before the Tone
 * Profile. Placed by hand in three bands: the masks above the chain, the
 * storm below it. */
async function growTree(page) {
  await page.evaluate(() => {
    const h = window.__heeler;
    const s = h.state();
    const card = (id, type, name, cat, extra = {}) => ({
      id, type, name, cat, x: 0, y: 0, enabled: true, params: {},
      hasIn: type !== "heeler.catalog", hasOut: true, ...extra,
    });
    const chain = ["src", "stdcolor", "detail", "cbal", "exposure", "vignette", "blend", "profile", "output"];
    const added = [
      card("lum", "heeler.luminance_range_mask", "Luminance Mask", "masking", { maskOut: true, params: { low: 0.35, high: 1, feather: 0.2 } }),
      card("hue", "heeler.hue_range_mask", "Hue Range Mask", "masking", { maskOut: true, params: { band_center: 230, hue_range: 70, hue_falloff: 30 } }),
      card("cat", "heeler.catalog", "Catalog", "source", { textParams: { image: "4871", mode: "developed" } }),
      card("blend", "heeler.blend", "Blend Mode", "utility", { hasIn2: true, maskIn: true, params: { opacity: 40 }, textParams: { mode: "screen", fit: "fill" } }),
    ];
    const byId = new Map([...s.nodes, ...added].map((n) => [n.id, n]));
    const at = (id, x, y) => ({ ...byId.get(id), x, y });
    const nodes = [
      ...chain.map((id, i) => at(id, i * 200, 150)),
      at("lum", 300, 0), at("hue", 500, 0), at("cat", 1100, 300),
    ];
    const img = (from, to, toPort = "in") => ({ from, to, toPort, kind: "image" });
    const msk = (from, to) => ({ from, to, toPort: "mask", kind: "mask" });
    const wires = [
      ...chain.slice(1).map((id, i) => img(chain[i], id)),
      img("src", "lum"), msk("lum", "detail"),
      img("detail", "hue"), msk("hue", "cbal"),
      img("cat", "blend", "in2"),
    ];
    h.dispatch({ type: "replace_graph", nodes, wires });
  });
  await sleep(400);
}

/** Fits the graph to its pane: the F key, with the pointer over it. */
async function fitGraph(page) {
  const surface = await page.$(t("graph-surface"));
  const b = await surface.boundingBox();
  await page.mouse.move(b.x + b.width * 0.3, b.y + b.height * 0.5);
  await page.keyboard.press("f");
  await sleep(600);
}

const scenes = {
  // The README's lead, first of two: an edit made with Develop's sliders.
  "develop-edit": async (page) => {
    await developEdit(page);
    await page.evaluate(() => window.__heeler.dispatch({ type: "toggle_browser" }));
    await sleep(1200);
    await save(page, "develop-edit");
  },

  // The Develop workspace on a landscape, the library and thumbnails open.
  develop: async (page) => {
    await page.evaluate(() => window.__heeler.dispatch({ type: "select_image", id: "4867" }));
    await sleep(1200);
    await save(page, "develop");
  },

  // The example network in the Graph workspace, Color Grade selected so
  // the inspector shows a node's own controls.
  graph: async (page) => {
    await workspace(page, 1);
    await exampleGraph(page);
    await page.evaluate(() => window.__heeler.dispatch({ type: "set_panel_size", panel: "graphViewer", size: 330 }));
    await sleep(300);
    await fitGraph(page);
    await page.evaluate(() => window.__heeler.dispatch({ type: "select_nodes", ids: ["grade"] }));
    await sleep(600);
    await save(page, "graph");
  },

  // The lead's second figure: the Develop edit above in Canvas, the
  // nodes its sections wrote grown into a tree over the photograph.
  canvas: async (page) => {
    await developEdit(page);
    await workspace(page, 2);
    await page.evaluate(() => {
      window.__heeler.dispatch({ type: "toggle_browser" });
      window.__heeler.dispatch({ type: "toggle_ribbon" });
    });
    await growTree(page);
    await fitGraph(page);
    await save(page, "canvas");
  },
};

for (const [name, scene] of Object.entries(scenes)) {
  if (only && !name.startsWith(only)) continue;
  const page = await freshPage();
  try {
    await scene(page);
  } catch (e) {
    console.log(`  ✗ ${name}: ${e.message}`);
  } finally {
    await page.close();
  }
}
await browser.close();
