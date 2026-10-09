// Microsoft Store listing screenshots (2026-10-06: "Make me 10
// screenshots"). Same approach as docshots.mjs: the browser build
// driven headless, every scene from a fresh page, with the Dev menu
// hidden. 1920x1080 at 2x, so each PNG is
// 3840x2160, the Store's largest size, and the interface text stays
// sharp when the Store scales it down.
//
// node scripts/storeshots.mjs # all ten node scripts/storeshots.mjs 03- #
// scenes whose name starts so
//
// STORE_APP points it at another port (the default leaves the owner's
// dev app on 5173 alone), STORE_OUT at another folder. The output lands
// in the repo's ignored dist/ folder: the PNGs are a few MB each and
// belong in Partner Center, not in git.
//
// The browser build previews edits with CSS filters, so exposure,
// color, curves and black and white show on the photograph, while the
// depth tools (Depth Lighting, Fog, Depth of Field) would show their
// controls on an unchanged picture. None of the ten is a depth scene
// for that reason: those want the desktop app's own renders.

import puppeteer from "puppeteer-core";
import { mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const BROWSER_PATH = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
].find((p) => existsSync(p));
const APP = process.env.STORE_APP ?? "http://localhost:5191";
const OUT = process.env.STORE_OUT ?? fileURLToPath(new URL("../../../dist/store-screenshots", import.meta.url));
const only = process.argv[2] ?? "";

if (!BROWSER_PATH) {
  console.error("no installed browser found");
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t = (id) => `[data-testid="${id}"]`;
const W = 1920;
const H = 1080;

const browser = await puppeteer.launch({
  executablePath: BROWSER_PATH,
  headless: "shell",
  args: ["--hide-scrollbars", "--force-device-scale-factor=2"],
});

async function freshPage() {
  const page = await browser.newPage();
  await page.setViewport({ width: W, height: H, deviceScaleFactor: 2 });
  await page.goto(APP, { waitUntil: "networkidle0" });
  await page.waitForSelector(t("browser-panel"));
  await sleep(500);
  // The library panel folds to its rail: in the demo session it is a
  // column of three folders and empty space, and the photograph wants
  // the room more.
  await page.evaluate(() => {
    const h = window.__heeler;
    if (h.state().browserOpen) h.dispatch({ type: "toggle_browser" });
  });
  await sleep(400);
  return page;
}

// The opening photograph carries the demo session's full graph (the
// grouped grade, merge, masks and finishing nodes); every other demo
// photograph starts from a fresh five-node graph. Scenes that want a
// photograph mid-edit put the full graph on it.
async function fullGraph(page, id, exposure = {}) {
  await page.evaluate((id) => {
    const h = window.__heeler;
    const s = h.state();
    const nodes = JSON.parse(JSON.stringify(s.nodes));
    const wires = JSON.parse(JSON.stringify(s.wires));
    h.dispatch({ type: "select_image", id });
    h.dispatch({ type: "replace_graph", nodes, wires });
    h.dispatch({ type: "select_nodes", ids: [] });
  }, id);
  await sleep(500);
  if (Object.keys(exposure).length) await params(page, "heeler.exposure", exposure);
}

// What the browser build shows that a released copy does not: the
// APPROX badge (the CSS stand-in for the engine's preview) and the
// test-pattern frame the demo library carries for the scopes.
async function tidy(page) {
  await page.evaluate(() => {
    const badge = document.querySelector('[data-testid="preview-source"]');
    if (badge) {
      badge.style.display = "none";
      const sep = badge.previousElementSibling;
      if (sep && sep.textContent.trim() === "|") sep.style.display = "none";
    }
    for (const id of ["thumb-4878", "grid-4878"]) {
      let el = document.querySelector(`[data-testid="${id}"]`);
      while (el && el.parentElement && !el.querySelector('[data-testid="stars-4878"]')) el = el.parentElement;
      if (el) el.style.display = "none";
    }
  });
  await sleep(150);
}

async function save(page, name) {
  // The pointer goes to the status bar's corner, so no hover state or
  // tooltip lands in a listing image.
  await page.mouse.move(2, H - 4);
  await tidy(page);
  await sleep(300);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log(`  ✓ ${name}`);
}

async function photo(page, id) {
  const thumb = await page.waitForSelector(t(`thumb-${id}`));
  await thumb.evaluate((e) => e.scrollIntoView({ block: "center" }));
  await thumb.click();
  await sleep(700);
}

async function workspace(page, index) {
  await page.evaluate((index) => {
    document.querySelector('[role="tablist"][aria-label="Workspace mode"]').children[index].click();
  }, index);
  await sleep(700);
}

async function openSection(page, slug, block = "start") {
  const btn = await page.waitForSelector(t(`collapse-${slug}`));
  const open = await btn.evaluate((e) => e.getAttribute("aria-expanded") === "true");
  if (!open) {
    await btn.evaluate((e) => e.scrollIntoView({ block: "center" }));
    await btn.click();
    await sleep(250);
  }
  await page.evaluate(({ slug, block }) => {
    document.querySelector(`[data-testid="collapse-${slug}"]`).scrollIntoView({ block });
  }, { slug, block });
  await sleep(250);
}

async function enable(page, slug) {
  const sw = await page.$(t(`toggle-${slug}`));
  if (!sw) return;
  const on = await sw.evaluate((e) => e.dataset.on === "true");
  if (!on) {
    await sw.click();
    await sleep(300);
  }
}

/** Sets node parameters through the store, the way a slider drag lands. */
async function params(page, type, values) {
  await page.evaluate(({ type, values }) => {
    const s = window.__heeler.state();
    const node = s.nodes.find((n) => n.type === type);
    if (!node) throw new Error(`no ${type} node`);
    for (const [param, value] of Object.entries(values)) {
      window.__heeler.dispatch({ type: "set_param", id: node.id, param, value });
    }
  }, { type, values });
  await sleep(400);
}

async function toLayers(page) {
  await page.click(t("panel-tab-layers"));
  await sleep(350);
}
async function addContent(page, kind) {
  await page.click(t("art-add-content-more"));
  await sleep(200);
  await page.click(t(`art-content-${kind}`));
  await sleep(350);
}
async function addAdjust(page, id) {
  await page.click(t("art-add-adjust"));
  await sleep(200);
  await page.click(t(`art-adjust-${id}`));
  await sleep(350);
}
async function addUtility(page, id) {
  await page.click(t("art-add-adjust"));
  await sleep(200);
  await page.click(t(`art-utility-${id}`));
  await sleep(350);
}

async function nodeCenter(page, title) {
  return page.evaluate((title) => {
    const card = [...document.querySelectorAll('[data-testid^="node-"]')]
      .filter((n) => {
        const id = n.dataset.testid;
        return id !== "node-editor" && !id.startsWith("node-thumb-");
      })
      .find((n) => n.textContent.includes(title));
    if (!card) return null;
    const r = card.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, top: r.y };
  }, title);
}

// A grade that reads as an edit in progress without pushing the
// photograph around: the CSS preview maps exposure to brightness.
const GRADE = { exposure: 0.12, contrast: 14, highlights: -32, shadows: 28, whites: 6, blacks: -10 };

const scenes = {
  // The first image is the one search results show: the whole window,
  // a strong photograph, the Develop panel mid-edit.
  "01-develop": async (page) => {
    await fullGraph(page, "4869", GRADE);
    await openSection(page, "exposure");
    await save(page, "01-develop");
  },

  "02-graph": async (page) => {
    await fullGraph(page, "4866", GRADE);
    await workspace(page, 1);
    await page.keyboard.press("f");
    await sleep(500);
    const exposure = await nodeCenter(page, "Exposure");
    if (exposure) {
      await page.mouse.click(exposure.x, exposure.y);
      await sleep(400);
    }
    await save(page, "02-graph");
  },

  "03-black-and-white": async (page) => {
    // Black and white is the Color section's Treatment, the way the
    // guide's own figure sets it up: full strength, a film stock and a
    // filter, the hue curve on.
    await fullGraph(page, "4868", GRADE);
    await page.evaluate(() => {
      const h = window.__heeler;
      h.dispatch({ type: "set_param", id: "bw", param: "amount", value: 100 });
      h.dispatch({ type: "set_param", id: "bw", param: "hue_curve_on", value: 1 });
      h.dispatch({ type: "set_text_param", id: "profile", param: "film", value: "hp5" });
      h.dispatch({ type: "set_text_param", id: "bw", param: "filter", value: "w25" });
    });
    await sleep(600);
    await openSection(page, "color");
    await save(page, "03-black-and-white");
  },

  "04-finish": async (page) => {
    await fullGraph(page, "4874", GRADE);
    await toLayers(page);
    await addContent(page, "gradient");
    await addAdjust(page, "exposure");
    await addAdjust(page, "curves");
    await addUtility(page, "warp");
    await save(page, "04-finish");
  },

  "05-relight": async (page) => {
    // Relight's tonal equalizer, shaped: shadows lifted, midtones eased.
    await fullGraph(page, "4867", GRADE);
    await enable(page, "relight");
    await openSection(page, "relight", "center");
    const svg = await page.waitForSelector(`${t("eq-editor")} svg`);
    const b = await svg.boundingBox();
    // Domain [-6,3], PAD l34 r8 t6 b15, as docshots.mjs reads it.
    const xAt = (x) => b.x + 34 + ((x + 6) / 9) * (b.width - 42);
    const yAt = (y) => b.y + 6 + (1 - (y + 2) / 4) * (b.height - 21);
    const drag = async (fx, fy, ty) => {
      await page.mouse.move(xAt(fx), yAt(fy));
      await page.mouse.down();
      await page.mouse.move(xAt(fx), yAt(ty), { steps: 6 });
      await page.mouse.up();
      await sleep(150);
    };
    await drag(-3, 0, 0.8);
    await drag(0, 0, -0.4);
    await save(page, "05-relight");
  },

  "06-catalog": async (page) => {
    await page.click(t("ribbon-expand"));
    await sleep(900);
    await save(page, "06-catalog");
  },

  "07-color": async (page) => {
    await fullGraph(page, "4867", GRADE);
    await enable(page, "color-wheels");
    await openSection(page, "color-wheels");
    await save(page, "07-color");
  },

  "08-detail": async (page) => {
    // Devils Tower's columns and talus: the photograph for detail work.
    await fullGraph(page, "4875", GRADE);
    await openSection(page, "sharpening");
    await enable(page, "sharpening");
    await openSection(page, "noise-reduction");
    await openSection(page, "detail");
    await save(page, "08-detail");
  },

  "09-canvas": async (page) => {
    await fullGraph(page, "4870", GRADE);
    await workspace(page, 2);
    await save(page, "09-canvas");
  },

  "10-export": async (page) => {
    await fullGraph(page, "4872", GRADE);
    await page.click(t("export-bar"));
    await sleep(500);
    await save(page, "10-export");
  },
};

for (const [name, run] of Object.entries(scenes)) {
  if (!name.startsWith(only)) continue;
  const page = await freshPage();
  try {
    await run(page);
  } catch (e) {
    console.error(`  ✗ ${name}: ${e.message}`);
  }
  await page.close();
}
await browser.close();
console.log(`done: ${OUT}`);
