// Screenshot harness for the user guide.
//
// Drives the dev app (the browser build at localhost:5173) through the
// owner's own installed browser, headless, and clips the regions the
// guide's screenshot placeholders describe into its asset folder
// screenshots/. Re-runnable: every shot rebuilds its state from a fresh
// page, so a screenshot is never a fossil of whatever the last scene left
// behind.
//
// node scripts/docshots.mjs # everything node scripts/docshots.mjs
// section- # scenes whose name starts so
//
// DOCS_APP points it at another port (a worktree's browser build, so
// The owner's dev app on 5173 is left alone), DOCS_OUT at another
// folder. Every scene runs with the Dev menu hidden, as a released copy
// shows the menu bar.
//
// deviceScaleFactor 2, so the guide's figures stay crisp when the
// dialog renders them at column width.

import puppeteer from "puppeteer-core";
import { mkdirSync } from "node:fs";

const BROWSER_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const APP = process.env.DOCS_APP ?? "http://localhost:5173";
const OUT = process.env.DOCS_OUT ?? new URL("../../../docs/user-guide/assets/screenshots", import.meta.url).pathname;
const only = process.argv[2] ?? "";

const t = (id) => `[data-testid="${id}"]`;

const browser = await puppeteer.launch({
  executablePath: BROWSER_PATH,
  headless: "shell",
  args: ["--hide-scrollbars", "--force-device-scale-factor=2"],
});

mkdirSync(OUT, { recursive: true });

/** A fresh page per scene: 1440x900 unless the scene says otherwise. */
async function freshPage(viewport = { width: 1440, height: 900 }, dsf = 2) {
  const page = await browser.newPage();
  // Control crops ship at 2x for crispness in the guide's column;
  // full-window shots ship at 1x, because a 4MB PNG of the whole app
  // is weight the installer carries for no visible gain at page width.
  await page.setViewport({ ...viewport, deviceScaleFactor: dsf });
  await page.goto(APP, { waitUntil: "networkidle0" });
  await page.waitForSelector(t("browser-panel"));
  await sleep(400);
  return page;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function boxOf(page, sel, pad = 6) {
  const el = await page.waitForSelector(sel, { timeout: 8000 });
  await el.evaluate((e) => e.scrollIntoView({ block: "nearest" }));
  await sleep(120);
  const b = await el.boundingBox();
  return pad ? grow(b, pad) : b;
}
const grow = (b, p) => ({ x: b.x - p, y: b.y - p, width: b.width + 2 * p, height: b.height + 2 * p });

function union(boxes, pad = 6) {
  const x0 = Math.min(...boxes.map((b) => b.x));
  const y0 = Math.min(...boxes.map((b) => b.y));
  const x1 = Math.max(...boxes.map((b) => b.x + b.width));
  const y1 = Math.max(...boxes.map((b) => b.y + b.height));
  return { x: x0 - pad, y: y0 - pad, width: x1 - x0 + 2 * pad, height: y1 - y0 + 2 * pad };
}

async function save(page, name, clip) {
  const vp = page.viewport();
  const c = clip
    ? {
        x: Math.max(0, clip.x),
        y: Math.max(0, clip.y),
        width: Math.min(vp.width - Math.max(0, clip.x), clip.width),
        height: Math.min(vp.height - Math.max(0, clip.y), clip.height),
      }
    : undefined;
  await page.screenshot({ path: `${OUT}/${name}.png`, clip: c, captureBeyondViewport: false });
  console.log(`  ✓ ${name}`);
}

/** Opens a Develop section by its slug, scrolled into view. */
async function openSection(page, slug) {
  const btn = await page.waitForSelector(t(`collapse-${slug}`));
  await btn.evaluate((e) => e.scrollIntoView({ block: "center" }));
  await sleep(120);
  const open = await btn.evaluate((e) => e.getAttribute("aria-expanded") === "true");
  if (!open) {
    await btn.click();
    await sleep(200);
  }
}

/** Clips one section: from its header to the next header below. */
async function sectionClip(page, slug) {
  await openSection(page, slug);
  // The header goes to the top THIRD of the panel, so the rows beneath
  // it are inside the viewport even for the last section: centered, a
  // tail section's rows can hang past the panel's bottom edge, which is
  // how lens came back as sixty pixels of header.
  await page.evaluate((slug) => {
    document
      .querySelector(`[data-testid="collapse-${slug}"]`)
      .scrollIntoView({ block: "start" });
  }, slug);
  await sleep(150);
  return page.evaluate((slug) => {
    const panel = document.querySelector('[data-testid="simple-panel"]').getBoundingClientRect();
    const heads = [...document.querySelectorAll('[data-testid^="collapse-"]')]
      .map((e) => ({ id: e.dataset.testid, top: e.getBoundingClientRect().top }))
      .sort((a, b) => a.top - b.top);
    const at = heads.findIndex((h) => h.id === `collapse-${slug}`);
    const top = heads[at].top - 8;
    const bottom = at + 1 < heads.length ? heads[at + 1].top - 4 : panel.bottom - 4;
    return { x: panel.x + 1, y: top, width: panel.width - 2, height: Math.min(bottom, panel.bottom) - top };
  }, slug);
}

async function enable(page, slug) {
  const sw = await page.$(t(`toggle-${slug}`));
  if (!sw) return;
  const on = await sw.evaluate((e) => e.dataset.on === "true");
  if (!on) {
    await sw.click();
    await sleep(250);
  }
}

const SECTION_PAGES = [
  "source", "exposure", "color", "levels", "curves", "color-wheels", "color-tune",
  "color-bend", "recolor", "detail", "noise-reduction", "sharpening",
  "skin-softening", "sky-rescue", "vignette", "grain", "depth-map", "fog", "depth-lighting",
  "depth-of-field", "geometry", "lens",
];
// Widgets read better lit: these sections switch on before their shot.
const ENABLE_FIRST = new Set([
  "levels", "curves", "color-wheels", "color-tune", "color-bend", "recolor",
  "vignette", "grain", "sharpening", "lens", "depth-map",
]);

/** A card for the reducer: enough for the migration to finish. */
const card = (id, type, name, cat, extra = {}) => ({
  id, type, name, cat, x: 0, y: 0, enabled: true, params: {},
  hasIn: type !== "heeler.image_source" && type !== "heeler.file" && type !== "heeler.catalog",
  hasOut: type !== "heeler.output", ...extra,
});
const img = (from, to, toPort = "in") => ({ from, to, toPort, kind: "image" });
const msk = (from, to, toPort = "mask") => ({ from, to, toPort, kind: "mask" });
const twoIn = { hasIn2: true };
const maskIn = { maskIn: true };
const maskOut = { maskOut: true };
const SRC = card("src", "heeler.image_source", "Image Source", "source");
const PROFILE = card("profile", "heeler.tone_profile", "Tone Profile", "color", maskIn);
const OUT_CARD = card("output", "heeler.output", "Output", "utility");
const EXAMPLES = {
  "double-exposure": {
    photo: "4866", catalog: "4870",
    nodes: [SRC, card("cat", "heeler.catalog", "Catalog", "source"), card("blend", "heeler.blend", "Blend Mode", "utility", { ...twoIn, ...maskIn, params: { opacity: 65 }, textParams: { mode: "screen", fit: "fill" } }), PROFILE, OUT_CARD],
    wires: [img("src", "blend", "in"), img("cat", "blend", "in2"), img("blend", "profile"), img("profile", "output")],
  },
  "texture-overlay": {
    photo: "4867",
    nodes: [SRC, card("tex", "heeler.file", "File", "source"), card("xf", "heeler.transform", "Transform", "utility", { params: { size: 130, rotate: 8, move_x: 6 } }), card("blend", "heeler.blend", "Blend Mode", "utility", { ...twoIn, ...maskIn, params: { opacity: 45 }, textParams: { mode: "soft_light", fit: "fill" } }), PROFILE, OUT_CARD],
    wires: [img("src", "blend", "in"), img("tex", "xf"), img("xf", "blend", "in2"), img("blend", "profile"), img("profile", "output")],
  },
  "channel-join": {
    photo: "4868",
    nodes: [SRC, card("m_luma", "heeler.measure", "Measure", "masking", { ...maskOut, textParams: { metric: "luma" } }), card("m_chroma", "heeler.measure", "Measure", "masking", { ...maskOut, textParams: { metric: "chroma" } }), card("m_sat", "heeler.measure", "Measure", "masking", { ...maskOut, textParams: { metric: "saturation" } }), card("join", "heeler.channel_join", "Channel Join", "utility", { hasIn2: true, hasIn3: true }), OUT_CARD],
    wires: [img("src", "m_luma"), img("src", "m_chroma"), img("src", "m_sat"), msk("m_luma", "join", "in"), msk("m_chroma", "join", "in2"), msk("m_sat", "join", "in3"), img("join", "output")],
  },
  "conditional": {
    photo: "4869",
    nodes: [SRC, card("measure", "heeler.measure", "Measure", "masking", maskOut), card("cmp", "heeler.compare", "Compare", "masking", { ...maskOut, params: { level: 0.25, softness: 0.1 }, textParams: { op: "gt" } }), card("darker", "heeler.exposure", "Exposure", "color", { ...maskIn, params: { exposure: -1.5 } }), card("cond", "heeler.conditional", "Conditional", "utility", { ...twoIn, ...maskIn }), PROFILE, OUT_CARD],
    wires: [img("src", "measure"), msk("measure", "cmp", "in"), msk("cmp", "cond"), img("src", "darker"), img("darker", "cond", "in2"), img("src", "cond", "in"), img("cond", "profile"), img("profile", "output")],
  },
  "masked-detail": {
    photo: "4871",
    nodes: [SRC, card("lum", "heeler.luminance_range_mask", "Luminance Mask", "masking", { ...maskOut, params: { low: 0.35, high: 1, feather: 0.2 } }), card("detail", "heeler.detail", "Detail", "detail", { ...maskIn, params: { clarity: 45, texture: 25 } }), PROFILE, OUT_CARD],
    wires: [img("src", "lum"), msk("lum", "detail"), img("src", "detail"), img("detail", "profile"), img("profile", "output")],
  },
  "split-denoise": {
    photo: "4873",
    nodes: [SRC, card("luma", "heeler.luma_chroma_split", "Luma / Color Split", "utility", { textParams: { part: "luma" } }), card("color", "heeler.luma_chroma_split", "Luma / Color Split", "utility", { textParams: { part: "color" } }), card("dn_luma", "heeler.denoise", "Denoise", "detail", { ...maskIn, params: { strength: 15 } }), card("dn_color", "heeler.denoise", "Denoise", "detail", { ...maskIn, params: { strength: 70 } }), card("join", "heeler.luma_chroma_join", "Luma / Color Join", "utility", twoIn), PROFILE, OUT_CARD],
    wires: [img("src", "luma"), img("luma", "dn_luma"), img("dn_luma", "join", "in"), img("src", "color"), img("color", "dn_color"), img("dn_color", "join", "in2"), img("join", "profile"), img("profile", "output")],
  },
  "hue-grade": {
    photo: "4874",
    nodes: [SRC, card("hue", "heeler.hue_range_mask", "Hue Range Mask", "masking", { ...maskOut, params: { band_center: 210, hue_range: 70, hue_falloff: 30 } }), card("grade", "heeler.color_grade", "Color Grade", "color", { ...maskIn, params: { hue_shift: -18, saturation: 30, exposure: -0.3 } }), PROFILE, OUT_CARD],
    wires: [img("src", "hue"), msk("hue", "grade"), img("src", "grade"), img("grade", "profile"), img("profile", "output")],
  },
  "view-transform": {
    photo: "4866",
    nodes: [SRC, card("color", "heeler.standard_color", "Color", "color", { ...maskIn, params: { saturation: 45, vibrance: 30 } }), card("view", "heeler.view_transform", "View Transform", "color", { ...maskIn, params: { exposure_ev: 0.4 }, textParams: { mode: "agx" } }), card("gamut", "heeler.gamut_map", "Gamut Map", "color", maskIn), OUT_CARD],
    wires: [img("src", "color"), img("color", "view"), img("view", "gamut"), img("gamut", "output")],
  },
};

const scenes = {
  // ---------- the window and its regions ----------
  "main-window": async (page) => save(page, "main-window"),

  "workspace-switcher": async (page) => {
    const b = await boxOf(page, '[role="tablist"][aria-label="Workspace mode"]', 10);
    await save(page, "workspace-switcher", b);
  },

  "menu-layer-open": async (page) => {
    await (await page.$(t("menu-layer"))).click();
    await sleep(150);
    const bar = await boxOf(page, t("menubar"), 4);
    const list = await boxOf(page, t("menu-layer-list"), 4);
    await save(page, "menu-layer-open", union([bar, list], 8));
  },

  "thumb-context-menu": async (page) => {
    const thumb = await page.waitForSelector('[data-testid^="thumb-4"]');
    await thumb.click({ button: "right" });
    await sleep(200);
    await save(page, "thumb-context-menu", await boxOf(page, t("thumb-menu"), 8));
  },

  "library-panel": async (page) => {
    // A collection and an opened tree, so the panel shows its parts.
    await (await page.$(t("new-collection"))).click();
    await page.type(t("new-collection-name"), "Selects");
    await page.keyboard.press("Enter");
    await sleep(200);
    await (await page.$(t("folder-row-1"))).click();
    await sleep(500);
    await save(page, "library-panel", await boxOf(page, t("browser-panel"), 2));
  },

  "thumbnail-panel": async (page) => {
    const thumbs = await page.$$('[data-testid^="thumb-4"]');
    const boxes = [];
    for (const th of thumbs.slice(0, 5)) boxes.push(await th.boundingBox());
    boxes.push(await boxOf(page, t("ribbon-sort-asc"), 2));
    boxes.push(await boxOf(page, t("ribbon-collapse"), 2));
    const filter = await page.$(t("filter-toggle"));
    if (filter) boxes.push(await filter.boundingBox());
    await save(page, "thumbnail-panel", union(boxes.filter(Boolean), 6));
  },

  "viewport": async (page) => {
    const lib = await boxOf(page, t("browser-panel"), 0);
    const right = await boxOf(page, t("simple-panel"), 0);
    const top = await boxOf(page, t("topbar"), 0);
    const status = await boxOf(page, t("status-bar"), 0);
    await save(page, "viewport", {
      x: lib.x + lib.width + 8,
      y: top.y + top.height + 2,
      width: right.x - (lib.x + lib.width) - 16,
      height: status.y - (top.y + top.height) - 4,
    });
  },

  "right-panel": async (page) => save(page, "right-panel", await boxOf(page, t("simple-panel"), 2)),

  "adjustments-panel": async () => {
    const page = await freshPage({ width: 1440, height: 2400 });
    await save(page, "adjustments-panel", await boxOf(page, t("simple-panel"), 2));
    await page.close();
  },

  "export-panel": async (page) => {
    await (await page.$(t("export-bar"))).click();
    await sleep(400);
    await save(page, "export-panel", await boxOf(page, t("export-panel"), 2));
  },

  "history-tab": async (page) => {
    // A few edits first, so the list has rows to show.
    await enable(page, "levels");
    await enable(page, "grain");
    await (await page.$(t("panel-tab-history"))).click();
    await sleep(300);
    await save(page, "history-tab", await boxOf(page, t("simple-panel"), 2));
  },

  "presets-tab": async (page) => {
    await (await page.$(t("panel-tab-presets"))).click();
    await sleep(300);
    await save(page, "presets-tab", await boxOf(page, t("simple-panel"), 2));
  },

  "metadata-tab": async (page) => {
    await (await page.$(t("panel-tab-metadata"))).click();
    await sleep(300);
    await save(page, "metadata-tab", await boxOf(page, t("simple-panel"), 2));
  },

  "expanded-catalog": async (page) => {
    await (await page.waitForSelector(t("ribbon-expand"))).click();
    await sleep(700);
    await save(page, "expanded-catalog");
  },

  // ---------- workspaces ----------
  "workspace-graph": async (page) => {
    await page.evaluate(() => {
      const tabs = document.querySelector('[role="tablist"][aria-label="Workspace mode"]');
      tabs.children[1].click();
    });
    await sleep(600);
    await save(page, "workspace-graph");
  },

  "workspace-canvas": async (page) => {
    await page.evaluate(() => {
      const tabs = document.querySelector('[role="tablist"][aria-label="Workspace mode"]');
      tabs.children[2].click();
    });
    await sleep(600);
    await save(page, "workspace-canvas");
  },

  // ---------- graph details ----------
  "graph-wiring": async (page) => {
    await page.evaluate(() => {
      document.querySelector('[role="tablist"][aria-label="Workspace mode"]').children[1].click();
    });
    await sleep(600);
    const nodes = await page.$$('[data-testid^="node-heeler"], [data-testid^="node-"]');
    const boxes = [];
    for (const n of nodes.slice(0, 4)) {
      const b = await n.boundingBox();
      if (b && b.width > 40) boxes.push(b);
    }
    if (boxes.length >= 2) await save(page, "graph-wiring", union(boxes.slice(0, 3), 24));
  },

  "graph-context-menu": async (page) => {
    await page.evaluate(() => {
      document.querySelector('[role="tablist"][aria-label="Workspace mode"]').children[1].click();
    });
    await sleep(600);
    const surface = await boxOf(page, t("graph-surface"), 0);
    await page.mouse.click(surface.x + surface.width * 0.5, surface.y + surface.height * 0.72, { button: "right" });
    await sleep(250);
    await save(page, "graph-context-menu", await boxOf(page, t("context-menu"), 10));
  },

  "node-inspector": async (page) => {
    await page.evaluate(() => {
      document.querySelector('[role="tablist"][aria-label="Workspace mode"]').children[1].click();
    });
    await sleep(600);
    const node = await page.$(t("node-exposure"));
    if (node) {
      await node.click();
      await sleep(300);
    }
    await save(page, "node-inspector", await boxOf(page, t("inspector"), 2));
  },

  // ---------- graph: the example networks ---------- Loaded straight
  // into the reducer through the browser build's documentation door
  // (window.__heeler), then arranged and framed: the same example
  // graphs the guide describes and the engine test proves.
  ...Object.fromEntries(
    Object.entries(EXAMPLES).map(([name, build]) => [
      `graph-example-${name}`,
      async (page) => {
        await page.evaluate(() => {
          document.querySelector('[role="tablist"][aria-label="Workspace mode"]').children[1].click();
        });
        await sleep(500);
        await page.evaluate((nodes, wires, photo, catalog) => {
          const h = window.__heeler;
          // The same photograph the engine test rendered the example
          // over, so the cards and the result figure agree.
          h.dispatch({ type: "select_image", id: photo });
          const withCatalog = nodes.map((n) =>
            n.type === "heeler.catalog" && catalog ? { ...n, textParams: { image: catalog, mode: "developed" } } : n,
          );
          h.dispatch({ type: "replace_graph", nodes: withCatalog, wires });
          h.dispatch({ type: "arrange_nodes" });
          h.dispatch({ type: "select_nodes", ids: [] });
        }, build.nodes, build.wires, build.photo, build.catalog ?? null);
        await sleep(300);
        await page.keyboard.press("f");
        await sleep(500);
        await save(page, `graph-example-${name}`, await boxOf(page, t("graph-surface"), 0));
      },
    ]),
  ),

  "graph-catalog-picker": async (page) => {
    await page.evaluate(() => {
      document.querySelector('[role="tablist"][aria-label="Workspace mode"]').children[1].click();
    });
    await sleep(500);
    await page.evaluate(() => {
      const h = window.__heeler;
      h.dispatch({ type: "add_node", node: { id: "cat_doc", type: "heeler.catalog", name: "Catalog", cat: "source", x: 60, y: 320, enabled: true, params: {}, hasOut: true } });
      h.dispatch({ type: "select_nodes", ids: ["cat_doc"] });
    });
    await sleep(300);
    await (await page.waitForSelector(t("catalog-node-choose"))).click();
    await sleep(400);
    await save(page, "graph-catalog-picker", await boxOf(page, t("inspector"), 2));
  },

  // ---------- finish ----------
  "finish-panel": async (page) => {
    await (await page.$(t("panel-tab-layers"))).click();
    await sleep(300);
    for (const id of ["art-add-paint", "art-add-gradient", "art-add-fill"]) {
      const b = await page.$(t(id));
      if (b) {
        await b.click();
        await sleep(200);
      }
    }
    const adj = await page.$(t("art-add-adjust"));
    if (adj) {
      await adj.click();
      await sleep(150);
      const kind = await page.$(t("art-adjust-exposure"));
      if (kind) await kind.click();
      await sleep(200);
    }
    await save(page, "finish-panel", await boxOf(page, t("simple-panel"), 2));
  },

  "finish-toolbar": async (page) => {
    await (await page.$(t("panel-tab-layers"))).click();
    await sleep(300);
    const ids = ["art-add-paint", "art-add-dodgeburn", "art-add-adjust", "art-add-gradient", "art-add-fill", "art-group", "art-delete"];
    const boxes = [];
    for (const id of ids) {
      const el = await page.$(t(id));
      if (el) boxes.push(await el.boundingBox());
    }
    await save(page, "finish-toolbar", union(boxes.filter(Boolean), 8));
  },

  // ---------- relight, shaped ----------
  "relight-widget": async (page) => {
    await enable(page, "relight");
    await openSection(page, "relight");
    const svg = await page.waitForSelector(`${t("eq-editor")} svg`);
    const b = await svg.boundingBox();
    // Domain [-6,3], PAD l34 r8 t6 b15 at the panel's editor size.
    const xAt = (x) => b.x + (34 + ((x + 6) / 9) * (b.width - 42)) * 1;
    const yAt = (y) => b.y + (6 + (1 - (y + 2) / 4) * (b.height - 21)) * 1;
    const drag = async (fx, fy, ty) => {
      await page.mouse.move(xAt(fx), yAt(fy));
      await page.mouse.down();
      await page.mouse.move(xAt(fx), yAt(ty), { steps: 6 });
      await page.mouse.up();
      await sleep(120);
    };
    await drag(-3, 0, 0.8);
    await drag(0, 0, -0.4);
    await save(page, "relight-widget", await sectionClip(page, "relight"));
  },
};

// ---------- the finish layer types, one honest stack each ----------
async function toLayers(page) {
  await (await page.$(t("panel-tab-layers"))).click();
  await sleep(300);
}
async function addLayer(page, id) {
  const b = await page.waitForSelector(t(id));
  await b.click();
  await sleep(250);
}
async function stackShot(page, name) {
  // The stack container is full-height flex; the shot ends at the last
  // row rather than carrying a panel of empty dark to the guide.
  const clip = await page.evaluate(() => {
    const box = document.querySelector('[data-testid="art-layers"]').getBoundingClientRect();
    const rows = [...document.querySelectorAll('[data-testid^="art-layer-"], [data-testid^="art-add-"]')]
      .map((e) => e.getBoundingClientRect().bottom);
    const bottom = Math.min(box.bottom, Math.max(...rows) + 14);
    return { x: box.x - 2, y: box.y - 2, width: box.width + 4, height: bottom - box.y + 4 };
  });
  await save(page, name, clip);
}
async function rowMenu(page, entry) {
  const row = (await page.$$('[data-testid^="art-layer-"]'))[0];
  await row.click({ button: "right" });
  await sleep(200);
  const item = await page.waitForSelector(t(entry));
  await item.click();
  await sleep(250);
}

Object.assign(scenes, {
  "finish-pixel-layer": async (page) => {
    await toLayers(page);
    await addLayer(page, "art-add-paint");
    await stackShot(page, "finish-pixel-layer");
  },
  "finish-gradient-layer": async (page) => {
    await toLayers(page);
    await addLayer(page, "art-add-gradient");
    await stackShot(page, "finish-gradient-layer");
  },
  "finish-fill-layer": async (page) => {
    await toLayers(page);
    await addLayer(page, "art-add-fill");
    await stackShot(page, "finish-fill-layer");
  },
  "finish-dodge-burn": async (page) => {
    // There is no add button on purpose: the tool makes its own layer
    // on the first stroke ("What does the layer offer that
    // a regular pixel layer does not?"). So: arm the tool, stroke the
    // photograph, and photograph what appeared.
    await toLayers(page);
    const tool = await page.waitForSelector(t("art-tool-dodgeburn"));
    await tool.click();
    await sleep(250);
    const img = await boxOf(page, '[data-testid="viewer-image"], .app img', 0).catch(() => null);
    const zone = img ?? { x: 700, y: 400, width: 400, height: 200 };
    await page.mouse.move(zone.x + zone.width * 0.4, zone.y + zone.height * 0.5);
    await page.mouse.down();
    await page.mouse.move(zone.x + zone.width * 0.6, zone.y + zone.height * 0.55, { steps: 8 });
    await page.mouse.up();
    await sleep(350);
    await stackShot(page, "finish-dodge-burn");
  },
  "finish-smart-layer": async (page) => {
    await toLayers(page);
    await addLayer(page, "art-add-smart");
    await stackShot(page, "finish-smart-layer");
  },
  "finish-adjustment-layers": async (page) => {
    await toLayers(page);
    await addLayer(page, "art-add-paint");
    await addLayer(page, "art-add-adjust");
    const kind = await page.$(t("art-adjust-exposure"));
    if (kind) {
      await kind.click();
      await sleep(250);
    }
    await stackShot(page, "finish-adjustment-layers");
  },
  "finish-masks": async (page) => {
    await toLayers(page);
    await addLayer(page, "art-add-paint");
    await rowMenu(page, "art-menu-mask-add");
    await stackShot(page, "finish-masks");
  },
  "finish-groups-clipping": async (page) => {
    await toLayers(page);
    await addLayer(page, "art-add-paint");
    await rowMenu(page, "art-menu-group");
    await addLayer(page, "art-add-gradient");
    await rowMenu(page, "art-menu-clip");
    await stackShot(page, "finish-groups-clipping");
  },
  "finish-layer-effects": async (page) => {
    await toLayers(page);
    await addLayer(page, "art-add-paint");
    const fx = await page.$('[data-testid^="art-fx-add-"]');
    if (fx) {
      await fx.click();
      await sleep(200);
      const pick = await page.$(t("art-fx-pick-shadow"));
      if (pick) {
        await pick.click();
        await sleep(250);
      }
    }
    await stackShot(page, "finish-layer-effects");
  },
});

Object.assign(scenes, {
  "finish-isolate": async (page) => {
    // A rectangle drawn on the photograph, made a layer: the Isolate
    // page's whole story in two gestures.
    await toLayers(page);
    await page.click(t("menu-select"));
    await sleep(120);
    await page.hover(t("menu-select-tools"));
    await sleep(200);
    await page.click(t("menu-select-tool-rect"));
    await sleep(250);
    const img = await boxOf(page, ".app img", 0);
    await page.mouse.move(img.x + img.width * 0.35, img.y + img.height * 0.3);
    await page.mouse.down();
    await page.mouse.move(img.x + img.width * 0.7, img.y + img.height * 0.7, { steps: 8 });
    await page.mouse.up();
    await sleep(300);
    await page.click(t("menu-select"));
    await sleep(120);
    await page.click(t("menu-select-to-layer"));
    await sleep(400);
    await stackShot(page, "finish-isolate");
  },
});

// The black and white darkroom, for its guide page (2026-09-15: "the
// Black and White page deserves some screenshots. There are lots of
// great controls there"). The treatment is the conversion's amount;
// the film sits on the profile, the filters on the conversion.
async function darkroom(page, { film = "hp5", filter = "w25", far = "" } = {}) {
  await page.evaluate(({ film, filter, far }) => {
    const h = window.__heeler;
    h.dispatch({ type: "set_param", id: "bw", param: "amount", value: 100 });
    h.dispatch({ type: "set_param", id: "bw", param: "hue_curve_on", value: 1 });
    h.dispatch({ type: "set_text_param", id: "profile", param: "film", value: film });
    h.dispatch({ type: "set_text_param", id: "bw", param: "filter", value: filter });
    if (far) h.dispatch({ type: "set_text_param", id: "bw", param: "far_filter", value: far });
  }, { film, filter, far });
  await sleep(600);
}
Object.assign(scenes, {
  "section-black-and-white": async (page) => {
    await darkroom(page);
    await save(page, "section-black-and-white", await sectionClip(page, "color"));
  },
  "section-black-and-white-infrared": async (page) => {
    await darkroom(page, { film: "rolleiir", filter: "r72" });
    await openSection(page, "color");
    // From the Film row down: the stock and filter that made it
    // infrared, the Far row, and the fold that opens for them. One
    // scroll, then one measurement of all three: boxOf scrolls each
    // element into view on its own, and a union of boxes taken at
    // different scroll positions is nothing on screen.
    const clip = await page.evaluate(() => {
      document.querySelector('[data-testid="bw-film"]').scrollIntoView({ block: "start" });
      const panel = document.querySelector('[data-testid="simple-panel"]').getBoundingClientRect();
      const rects = ["bw-film", "bw-far", "bw-infrared"].map((id) => document.querySelector(`[data-testid="${id}"]`).getBoundingClientRect());
      const top = Math.min(...rects.map((r) => r.top)) - 10;
      const bottom = Math.min(panel.bottom, Math.max(...rects.map((r) => r.bottom)) + 10);
      return { x: panel.x + 1, y: top, width: panel.width - 2, height: bottom - top };
    });
    await sleep(150);
    await save(page, "section-black-and-white-infrared", clip);
  },
  "section-exposure-zones": async (page) => {
    await darkroom(page);
    await page.evaluate(() => {
      const h = window.__heeler;
      if (!h.state().zonesOpen) h.dispatch({ type: "toggle_zones_fold" });
    });
    await sleep(500);
    await save(page, "section-exposure-zones", await sectionClip(page, "exposure"));
  },
  "section-print": async (page) => {
    await darkroom(page);
    await enable(page, "print");
    await save(page, "section-print", await sectionClip(page, "print"));
  },
  "section-grain-film": async (page) => {
    await darkroom(page);
    await enable(page, "grain");
    await save(page, "section-grain-film", await sectionClip(page, "grain"));
  },
});

// One scene per Develop section.
for (const slug of SECTION_PAGES) {
  scenes[`section-${slug}`] = async (page) => {
    if (ENABLE_FIRST.has(slug)) await enable(page, slug);
    let clip = await sectionClip(page, slug);
    // Recolor's Neutral guard strip draws once its histogram lands, a
    // moment after the open section settles, and makes the section taller.
    if (slug === "recolor" && await page.waitForSelector(t("guard-strip"), { timeout: 5000 }).catch(() => null)) {
      clip = await sectionClip(page, slug);
    }
    await save(page, `section-${slug}`, clip);
  };
}


// ---------- 26.4: the add bar's menus, and the new figures ----------
// The add bar became a split button and two menus (finishnew.tsx), so
// the Finish scenes add through them; the scenes after them are the
// figures the 26.4 pages added.
async function addContent(page, kind) {
  await page.click(t("art-add-content-more"));
  await sleep(200);
  await page.click(t(`art-content-${kind}`));
  await sleep(350);
}
async function addUtility(page, id) {
  await page.click(t("art-add-adjust"));
  await sleep(200);
  await page.click(t(`art-utility-${id}`));
  await sleep(350);
}
async function addAdjust(page, id) {
  await page.click(t("art-add-adjust"));
  await sleep(200);
  await page.click(t(`art-adjust-${id}`));
  await sleep(350);
}
async function expandActive(page) {
  await page.evaluate(() => {
    const s = window.__heeler.state();
    const el = document.querySelector(`[data-testid="art-settings-${s.artActive}"]`);
    if (el && el.getAttribute("aria-expanded") === "false") el.click();
  });
  await sleep(350);
}
async function dispatchAll(page, cmds) {
  await page.evaluate((cmds) => { for (const c of cmds) window.__heeler.dispatch(c); }, cmds);
  await sleep(350);
}
async function runCmd(page, id) {
  await page.evaluate(async (id) => {
    const m = await import("/src/commands.ts");
    m.runCommand(id, window.__heeler.state(), window.__heeler.dispatch);
  }, id);
  await sleep(450);
}
async function toGraph(page) {
  await page.evaluate(() => {
    document.querySelector('[role="tablist"][aria-label="Workspace mode"]').children[1].click();
  });
  await sleep(600);
}
/** Every open menu surface, with whatever else the scene adds. */
async function menusBox(page, extra = [], pad = 8) {
  const boxes = await page.evaluate(() =>
    [...document.querySelectorAll(".ctx-menu")]
      .map((e) => e.getBoundingClientRect())
      .filter((r) => r.width > 0 && r.height > 0)
      .map((r) => ({ x: r.x, y: r.y, width: r.width, height: r.height })),
  );
  return union([...boxes, ...extra], pad);
}
async function parkMouse(page) {
  await page.mouse.move(2, 895);
  await sleep(250);
}

Object.assign(scenes, {
  "finish-panel": async (page) => {
    // A small stack, every row at rest: the compact rows 26.4 brought.
    await toLayers(page);
    await addContent(page, "paint");
    await addContent(page, "gradient");
    await addAdjust(page, "exposure");
    await addUtility(page, "warp");
    await parkMouse(page);
    await save(page, "finish-panel", await boxOf(page, t("simple-panel"), 2));
  },
  "finish-pixel-layer": async (page) => { await toLayers(page); await addContent(page, "paint"); await expandActive(page); await stackShot(page, "finish-pixel-layer"); },
  "finish-gradient-layer": async (page) => { await toLayers(page); await addContent(page, "gradient"); await expandActive(page); await stackShot(page, "finish-gradient-layer"); },
  "finish-fill-layer": async (page) => { await toLayers(page); await addContent(page, "fill"); await expandActive(page); await stackShot(page, "finish-fill-layer"); },
  "finish-smart-layer": async (page) => { await toLayers(page); await addUtility(page, "smart"); await expandActive(page); await stackShot(page, "finish-smart-layer"); },
  "finish-adjustment-layers": async (page) => {
    await toLayers(page);
    await addContent(page, "paint");
    await addAdjust(page, "exposure");
    await expandActive(page);
    await stackShot(page, "finish-adjustment-layers");
  },
  "finish-masks": async (page) => {
    await toLayers(page);
    await addContent(page, "paint");
    await rowMenu(page, "art-menu-mask-add");
    await stackShot(page, "finish-masks");
  },
  "finish-groups-clipping": async (page) => {
    await toLayers(page);
    await addContent(page, "paint");
    await rowMenu(page, "art-menu-group");
    await addContent(page, "gradient");
    await rowMenu(page, "art-menu-clip");
    await stackShot(page, "finish-groups-clipping");
  },
  "finish-layer-effects": async (page) => {
    await toLayers(page);
    await addContent(page, "paint");
    const fx = await page.$('[data-testid^="art-fx-add-"]');
    if (fx) {
      await fx.click();
      await sleep(200);
      const pick = await page.$(t("art-fx-pick-shadow"));
      if (pick) { await pick.click(); await sleep(250); }
    }
    await expandActive(page);
    await stackShot(page, "finish-layer-effects");
  },
  "finish-isolate": async (page) => {
    await toLayers(page);
    await page.click(t("menu-select"));
    await sleep(120);
    await page.hover(t("menu-select-interactive"));
    await sleep(250);
    await page.click(t("menu-select-tool-rect"));
    await sleep(250);
    const img = await boxOf(page, ".app img", 0);
    await page.mouse.move(img.x + img.width * 0.35, img.y + img.height * 0.3);
    await page.mouse.down();
    await page.mouse.move(img.x + img.width * 0.7, img.y + img.height * 0.7, { steps: 8 });
    await page.mouse.up();
    await sleep(300);
    await page.click(t("menu-select"));
    await sleep(120);
    await page.click(t("menu-select-to-layer"));
    await sleep(400);
    await stackShot(page, "finish-isolate");
  },
  "finish-toolbar": async (page) => {
    // Wide enough that the bar keeps to one row, as on a usual window.
    await page.setViewport({ width: 1720, height: 900, deviceScaleFactor: 2 });
    await sleep(400);
    await toLayers(page);
    await parkMouse(page);
    await save(page, "finish-toolbar", await boxOf(page, t("art-toolbar"), 4));
  },
  "finish-add-toolbar": async (page) => {
    await toLayers(page);
    await parkMouse(page);
    await save(page, "finish-add-toolbar", await boxOf(page, t("finish-new-bar"), 4));
  },
  "finish-warp-layer": async (page) => {
    await toLayers(page);
    await addUtility(page, "warp");
    await expandActive(page);
    // Shapes, with one shape, so the page's Twist and Pinch show.
    const warpId = await page.evaluate(async () => {
      const m = await import("/src/state.ts");
      const s = window.__heeler.state();
      return m.artFindLayer(s, s.artActive).content.id;
    });
    await dispatchAll(page, [{ type: "art_warp_kind", id: warpId, kind: "shapes" }, { type: "shape_warp_add", target: warpId }]);
    await parkMouse(page);
    await stackShot(page, "finish-warp-layer");
  },
  "finish-warp-ring": async (page) => {
    await toLayers(page);
    await addUtility(page, "warp");
    await expandActive(page);
    const warpId = await page.evaluate(async () => {
      const m = await import("/src/state.ts");
      const s = window.__heeler.state();
      return m.artFindLayer(s, s.artActive).content.id;
    });
    await dispatchAll(page, [{ type: "art_warp_kind", id: warpId, kind: "shapes" }, { type: "shape_warp_add", target: warpId }]);
    await parkMouse(page);
    await save(page, "finish-warp-ring");
  },
  "finish-mask-export": async (page) => {
    await toLayers(page);
    await addAdjust(page, "exposure");
    await expandActive(page);
    await page.evaluate(() => {
      const s = window.__heeler.state();
      window.__heeler.dispatch({ type: "art_add_mask", id: s.artActive, kind: "brush", edit: false });
    });
    await sleep(400);
    await parkMouse(page);
    await stackShot(page, "finish-mask-export");
  },
  "develop-mask-export": async (page) => {
    await runCmd(page, "layer.brush");
    await sleep(300);
    await parkMouse(page);
    const clip = await page.evaluate(() => {
      const panel = document.querySelector('[data-testid="simple-panel"]').getBoundingClientRect();
      const base = document.querySelector('[data-testid="layer-base"]').getBoundingClientRect();
      const exp = document.querySelector('[data-testid="layer-mask-export"]') ?? document.querySelector('[data-testid="layer-mask-controls"]');
      const r = exp.getBoundingClientRect();
      const top = base.top - 34;
      return { x: panel.x + 1, y: top, width: panel.width - 2, height: Math.min(panel.bottom, r.bottom + 10) - top };
    });
    await save(page, "develop-mask-export", clip);
  },
  "relight-looks-menu": async (page) => {
    await openSection(page, "relight");
    await page.evaluate(() => document.querySelector('[data-testid="collapse-relight"]').scrollIntoView({ block: "start" }));
    await sleep(200);
    await page.click(t("looks-relight-menu"));
    await sleep(350);
    const sec = await sectionClip(page, "relight");
    const menu = await boxOf(page, '[role="listbox"]', 4);
    await save(page, "relight-looks-menu", union([sec, menu], 0));
  },
  "bake-progress-dialog": async (page) => {
    await page.evaluate(async () => {
      const op = await import("/src/ui/opprogress.tsx");
      const bb = await import("/src/bakedbackups.ts");
      const br = await import("/src/bridge.ts");
      op.beginOp("bake", "Bake Warp", bb.BAKE_DIALOG_BACKUP_LINE);
      br.mockEmitProgress({ id: "docs-bake", op: "bake", message: "Rendering the layers below at full size", done: 1, total: 5 });
    });
    await sleep(800);
    await save(page, "bake-progress-dialog", await boxOf(page, t("bake-dialog"), 0));
  },
  "node-menu-sections": async (page) => {
    await toGraph(page);
    await page.click(t("menu-node"));
    await sleep(200);
    await page.hover(t("menu-node-utility"));
    await sleep(300);
    await page.hover(t("menu-node-section-channels"));
    await sleep(350);
    await save(page, "node-menu-sections", await menusBox(page, [await boxOf(page, t("menu-node"), 2)], 8));
  },
  "node-recipes-palette": async (page) => {
    await toGraph(page);
    await page.click(t("palette-add"));
    await sleep(300);
    await page.type(t("palette-search"), "frequency");
    await sleep(400);
    await save(page, "node-recipes-palette", await boxOf(page, t("node-palette"), 0));
  },
  "recipe-controls-editor": async (page) => {
    await toGraph(page);
    await page.click(t("palette-add"));
    await sleep(300);
    await page.type(t("palette-search"), "frequency");
    await sleep(400);
    await page.click('[data-testid^="palette-recipe-add-"]');
    await sleep(500);
    await page.click(t("controls-editor-toggle"));
    await sleep(350);
    await parkMouse(page);
    await save(page, "recipe-controls-editor", await boxOf(page, t("inspector"), 2));
  },
  "recipe-publish-controls": async (page) => {
    await toGraph(page);
    await page.click(t("palette-add"));
    await sleep(300);
    await page.type(t("palette-search"), "frequency");
    await sleep(400);
    await page.click('[data-testid^="palette-recipe-add-"]');
    await sleep(500);
    const g = await page.evaluate(() => window.__heeler.state().selection[0]);
    await dispatchAll(page, [{ type: "open_group", id: g }]);
    const blur = await page.evaluate((g) => window.__heeler.state().nodes.find((n) => n.id === g)?.groupNodes?.find((n) => n.type === "heeler.blur")?.id, g);
    await dispatchAll(page, [{ type: "select_nodes", ids: [blur] }]);
    const el = await page.waitForSelector('[data-testid="inspector"] [data-param="radius"]');
    await el.evaluate((e) => e.scrollIntoView({ block: "center" }));
    await sleep(150);
    await el.click({ button: "right" });
    await sleep(350);
    await save(page, "recipe-publish-controls", union([await boxOf(page, t("publish-menu"), 0), await el.boundingBox()], 8));
  },
});

const picked = Object.entries(scenes).filter(([name]) => name.startsWith(only));
console.log(`${picked.length} scene(s)`);
const FULL_WINDOW = new Set(["main-window", "workspace-graph", "workspace-canvas", "expanded-catalog", "viewport", "finish-warp-ring"]);
let failed = 0;
for (const [name, fn] of picked) {
  try {
    if (name === "adjustments-panel") {
      await fn();
    } else {
      const page = await freshPage(undefined, FULL_WINDOW.has(name) ? 1 : 2);
      await fn(page);
      await page.close();
    }
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}: ${String(e).split("\n")[0]}`);
  }
}
await browser.close();
console.log(failed ? `${failed} failed` : "all captured");
process.exit(failed ? 1 : 0);
