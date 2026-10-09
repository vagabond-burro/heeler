# Smart selection (subject / foreground / sky / removal)

Status: **P1 IN PROGRESS on branch `smart-selection`** (the owner's go,
2026-08-23: "Start a new branch more computer vision for improved
selections"). Built so far: the heeler-vision crate (ort sessions,
MobileSAM registry with pinned SHA-256s, consent download, the
export's 1024x682 canvas contract, verified against the real model
at IoU > 0.85 on the gated test); the smart_mask node with executor
raster injection and post-dials; the desktop commands (status /
consented download / remove / smart_click with per-image embedding
cache); the Smart layer type with the click tool, markers, and the
consent card; rasters planted into preview, export, thumbnail and
media-server renders. The tail closed the same day: rasters persist
beside the proxies as recipe-versioned raw PNGs (restarts survive),
headless serve and the batch API plant from that cache and recompute
from the recipe when the model is installed, and the viewer badges
clicks whose pixels are not on this machine with a one-button
RECOMPUTE. Measured on the gated real-model test (CPU only, Apple
Silicon): encode 209ms, warm click 28ms; the 150ms click budget is
met at 5x headroom and the encode beats the 500ms CoreML target
without CoreML, so the execution provider is deliberately NOT wired;
revisit if BiRefNet (P2) needs it. Still open before P1 can be
called done: live verification on a real photograph in the running
app (needs the owner at the machine for the download consent and the
look-see). The rest of this document is the implementation
instruction it always was. Late addition, same day: the mode picker
stopped being a promise: SUBJECT and SKY one-shots are implemented
via SAM auto-prompts (subject: one ask resolved by the model's own
ambiguity estimate, at the middle of the frame on screen since
2026-09-30, stored in the node's `aim` param beside the clicks, see
docs/spec-art-layers.md "Subject's aim"; sky: a fan of top-band asks, keeping
what touches the top edge and merging), verified against the real
model by a gated test on a synthetic sky.

**P2 is BUILT** (same day, after the owner's first live test passed and his
red-overlay ask shipped as the mask view's RED flavor): BiRefNet
Lite (MIT, 224 MB, pinned) answers the SUBJECT one-shot when
installed, SAM remains the fallback; the recipe version carries the
model that made each raster; a consented offer chip upgrades subject
mode; the export panel's Matte control writes the Smart mask into
the alpha channel for PNG/TIFF (background removal, opaque-with-a-
warning when no mask is computed); Preferences lists both models
with sizes and per-model removal; the open-source page carries the
notices. Measured: the matte at 3.1s CPU, inside the 4s budget.
**P3 is AUTHORIZED** (2026-08-23: "inpainting and generative
fill (AI) is back in scope and make it official", then "Yes,
approved"): the Section 17 amendment is made, scoped to mask-driven
local-only cleanup. **P3 is BUILT**, on every surface the owner named ("I
also want the smart selection and inpainting in the Finish (Pixel
Layers) as well"):

- LaMa (Apache-2.0, 208 MB, pinned) in heeler-vision: crop around the
  hole, fixed-512 fill, composited home through the original soft
  mask so everything outside is bit-identical; gated test at 1.2s CPU
  per fill.
- The Inpaint node: its mask port IS the hole, so brush strokes,
  Smart selections, and any mask wire drive one mechanism; the
  desktop-computed raster plants via the executor like the smart
  masks; no raster is a perfect passthrough. fill_id is the recipe
  pointer, deterministic from the feeds' content keys.
- Develop: REMOVE in the smart panel splices Inpaint at the chain's
  end wired to the selection and runs the fill.
- Finish: the Fill brush (self-created brush-mask + Inpaint pair,
  refills a beat after each stroke, consent card in place), and Add
  mask grows a Smart option so a pixel layer shows only inside the
  model's selection; the smart panel and click tool follow the
  active Finish layer.
- Headless/batch serve persisted fills or an honest passthrough;
  no generative recompute ever happens off the user's action.
- Reworked same day to the owner's unified Finish model: Fill and Smart are
  REAL layers (inpaint content / lift-through-smart-mask content),
  with layer-native hide, reorder, opacity and delete; the engine's
  inpaint op knows its two lives (wire-gated Remove vs layer-gated
  content). APPLY-to-pixels is an open design note: paint layers
  store strokes, not rasters, so literal conversion needs a raster
  content type; finalizing today = normal layers stacked above,
  which read the composite below, fill included.

## P4: matting-grade Selection Polish (the owner's ask 2026-08-23; BUILT 2026-08-24)

Can this stack take a fresh pass at Selection Polish, where
classical algorithms never resolved hair strands? Yes - the tool
class is trimap-guided MATTING: the existing coarse selection erodes
and dilates into fg / bg / unknown bands, and a matting model
resolves the unknown band into a soft alpha; fine hair is exactly
the training objective. ViTMatte small was chosen (code MIT, weights
Apache-2.0 per the author's model card, 104MB fp32 ONNX by Xenova,
pinned by hash); MODNet (Apache-2.0) stays noted for the portrait
special case; RVM is GPL-3 and REJECTED.

Quality was PROVEN before integration, 's "see if it can
actually work good": a synthetic acceptance probe (90 one-to-two
pixel hair strands radiating off a subject over busy bokeh, coarse
selection covering only the subject) showed the coarse selection
recovering 0% of the strand alpha mass and ViTMatte recovering 98.4%
at 0.17s CPU. The same probe lives on as the vision crate's gated
test (`gated_the_matte_recovers_hair_strands`, 95%+ recovery
through the full Rust pipeline, ~300ms).

How it landed:

- `heeler-vision::refine`: `Refiner` (dynamic-size 4-channel input,
  /32 padding), `trimap_from_coarse` (chamfer-distance erode/band;
  the band errs WIDE at 22% of the short side, because a strand tip
  poking past the band gets labeled certain-background and poisons
  the whole strand), and `refine_selection` (crop the unknown band's
  bbox, work under 1024px, stitch back with trimap certainties
  enforced).
- The refined alpha is planted as the `selection_mask` node's raster
  base through the same executor injection smart_mask and inpaint
  use. The regions loop is skipped when the raster is present;
  grow, smooth, polish strokes, feather, ramp and invert all still
  run ON TOP of it, so the matte is a better base, not a new tool.
- The recipe pointer is `matte_id` on the node; the raster's version
  hashes (image, node, regions), so EDITING the selection sheds the
  matte automatically and the render falls back to classical
  geometry - never a stale matte, never a silent one (the stale
  session-raster fallback smart masks enjoy is explicitly denied to
  selection mattes).
- UI: one "Smart matte" chip in the polish toolbar. Press to refine,
  lit while the matte is current, press again to take it off; if the
  geometry moved on it says so and offers the re-run. The consent
  card names the model, size, license and source like every other
  model in the registry; the marching ants trace the engine's mask
  whenever a matte is on, exactly as they do for polish strokes.
- Headless/batch serves the persisted matte raster or the honest
  classical render; like fills, it never recomputes a matte off-
  session.

### P4.1: the matte brush is the model's (2026-08-24)

the owner's first live test failed, and the log forensics told the story:
the CLASSICAL matte stroke sampler was still running per render, its
cost growing with every stroke (388ms to 4s per preview inside one
minute of brushing), the single render lock backed up into 30-second
timeouts, the selection overlay fell back to geometry, and the
ViTMatte raster - correctly computed and sitting on disk - never
reached the screen. "Nope. This Selection Polish still sucks."
He was right, and the model was never the thing he was looking at.

The rework:

- A matte stroke now marks the BAND, and the model resolves it: the
  stroke coverage is the trimap's unknown region
  (`refine_selection_banded`), the desktop recomputes a beat after
  the stroke lands (PolishMatteRunner, FillRunner's pattern), and the
  refined raster replaces the node's base as before. Cost lands once
  per finished stroke, off the render path; per-render cost is a 3ms
  raster resample.
- In the engine a matte stroke is a deliberate no-op. The classical
  sampler is retired (its quality on fur is why the tool was gated;
  its render cost is what drowned the owner's first test). Add, Remove and
  Soften strokes stay engine-side - cheap and predictable.
- The recipe now hashes regions AND strokes (raw strings as the
  frontend serialized them, no re-serialization anywhere), so editing
  either sheds the stale matte; the gated banded test holds 95%
  strand recovery inside a brushed ring with the outside passing
  through bit-identical.
- Reviewed and rejected along the way: SharpRazor (PMC10234178, the owner's
  find) - dermoscopy hair REMOVAL via directional filters, no code
  released, not an edge-refinement fit.

### P4.2: the workflow round (2026-08-24, the owner's live-testing day)

A day of the owner testing sky selections end to end reshaped the smart
panel and taught one systemic lesson. The shipped shape:

- The smart panel SELECTS: Click / Subject / Sky / Refine / To Mask /
  Clear. Refine (the owner's name) runs ViTMatte over the mask's edge with
  "<base>+vitmatte" provenance. Remove left the panel for Select >
  Remove Object - an action taken WITH a selection is not a way of
  making one - and a Remove owns a SNAPSHOT of the selection
  (inpaint_m_* node + copied raster), never the live node: "I click
  to select, I should be able to clear that."
- To Mask converts ANY mask to a selection mask in place:
  bake_mask_raster renders the node (dials and all) and persists it,
  convert_mask_to_selection points a "baked:<hex>" base at it. Baked
  bases never shed; regions COMBINE on top (a matte base skips them);
  the develop mask panel's Polish... chip is the same flow ending in
  the polish tool. the owner's round-trip needs no return leg: the
  conversion happens where the mask lives.
- Sky prompts reach the frame edges (0.06/0.94). Clear resets the
  MODE too, and a mask with nothing asked plants nothing - while a
  computed model always counts as a selection (the reload lesson).
- The systemic lesson, twice earned: every silent refusal or
  console-only error became a visible one. Tool failures flash in
  the status bar (reportToolError); guards that returned state
  unchanged now either work in every seat (the maskOut/hasOut flag
  split silently refused the whole Finish tab) or say why not.

Still open here: matte brush on baked bases (falls back to Add);
"Selection from Mask" in the load-elsewhere sense; the Finish
edit-mask pick-leak cousin.

## The shape of the answer

Classical CV (edge detection, GrabCut, color models) cannot deliver
2026-grade subject selection; every serious tool ships learned
segmentation. So the question decomposes into four independently
licensed layers, and each must clear the no-GPL / zero-exposure bar
separately:

1. the INFERENCE RUNTIME (Rust code that runs models),
2. the MODEL ARCHITECTURES (code),
3. the MODEL WEIGHTS (the files we ship or download),
4. the TRAINING DATA those weights were fitted on (the murkiest
   layer, and the one most vendors stay quiet about).

## Recommended stack

### Runtime: `ort` (ONNX Runtime bindings)

- License: MIT OR Apache-2.0 for the bindings; ONNX Runtime itself is
  MIT. No conflict. ([crates.io](https://crates.io/crates/ort),
  [github.com/pykeio/ort](https://github.com/pykeio/ort))
- Production-proven (used by SurrealDB, Supabase, Wasmtime among
  others), actively maintained, currently tracking ONNX Runtime 1.24.
- Decisive advantage for us: execution providers. CoreML on Apple
  Silicon and DirectML on Windows give GPU/NPU inference with zero
  vendor SDKs, matching our two shipping platforms.
- Fallback candidates if we ever want pure Rust with no C++ payload:
  `tract` (Sonos, MIT/Apache-2.0, CPU-only) or `candle` (Hugging
  Face, MIT/Apache-2.0, which even carries a Segment Anything example
  including a WASM demo). Keep them noted, not adopted: `ort`'s
  execution providers are worth the bundled library.

### Subject and foreground selection: the SAM family

- **Segment Anything (SAM / SAM 2, Meta)**: code AND weights under
  Apache-2.0; SAM 2's SA-V dataset is published under CC-BY-4.0.
  This is the cleanest licensing story in the entire field: the
  vendor released the training data under a permissive license, so
  even layer 4 is clean.
  ([roboflow.com/model-licenses/segment-anything-2](https://roboflow.com/model-licenses/segment-anything-2))
- **MobileSAM** (distilled SAM, ~40MB, CPU-interactive): Apache-2.0.
  ([github.com/ChaoningZhang/MobileSAM](https://github.com/ChaoningZhang/MobileSAM/blob/master/LICENSE))
- Interaction model is a perfect fit for Heeler: the image ENCODER
  runs once per photo (heavy, ~0.5-2s at 1024px on CPU, far less via
  CoreML) and produces an embedding; the mask DECODER runs per click
  in tens of milliseconds. Click-to-select-subject with live add and
  subtract clicks is the native shape of this model, and it is
  exactly our ◎ PICK gesture pointed at masks.

### Automatic one-shot mattes (subject / background removal): BiRefNet

- **BiRefNet**: MIT, weights included; the current open-weights
  state of the art for dichotomous segmentation (a high-quality
  subject-vs-background matte with soft edges, one shot, no clicks).
  ([github.com/zhengpeng7/birefnet](https://github.com/zhengpeng7/birefnet),
  [ONNX build](https://huggingface.co/onnx-community/BiRefNet-ONNX))
- **Explicitly rejected: BRIA RMBG-2.0.** Same architecture family,
  markedly restrictive terms: CC-BY-NC with commercial use requiring
  a paid BRIA agreement. It appears in every "best background
  removal" list; it must never appear in ours.
  ([huggingface.co/briaai/RMBG-2.0](https://huggingface.co/briaai/RMBG-2.0))
- Layer-4 caveat, stated honestly: BiRefNet's training corpus (DIS5K
  and friends) is academic in origin and does not carry the tidy
  CC-BY-4.0 story SAM 2 has. MIT weights from the author are a solid
  legal position; it is still one notch below SAM's. The phasing
  below leans on SAM first partly for this reason.

### Sky selection: SAM-prompted first, dedicated model later

The dedicated-sky-model landscape is thin: the useful open ONNX
(`skyseg`, MIT, U2Net-p based) is a small demo-grade model whose
high-precision sibling is proprietary
([huggingface.co/JianyuanWang/skyseg](https://huggingface.co/JianyuanWang/skyseg)).
So v1 derives sky from machinery we already license:

- Auto-prompt SAM with a grid of points across the upper frame, keep
  masks that touch the top edge, merge, and validate against cheap
  priors (chroma/luminance gradient, position). Zero new licenses,
  quality follows SAM.
- Hold `skyseg` (MIT) as a cross-check or cheap first-pass hint, and
  revisit a dedicated model (or a small fine-tune of our own) if
  SAM-derived sky underwhelms on real skies: horizons through trees
  are the known hard case.

### Inpainting: the heal-tool upgrade AND subject removal, gated, phase 3

the owner asked directly whether this stack can replace the earlier
traditional-inpainting attempt that "didn't work well". Yes, and
decisively: this is the sharpest quality gap in the whole plan.
Classical algorithms (Telea, Navier-Stokes, PatchMatch-style patch
copying) only ever recycle pixels from the same photo, so they smear
on texture boundaries and hallucinate repeats on structure; LaMa's
whole contribution is exactly the cases PatchMatch fails (large
masks, regular structure like railings and window grids, long
edges), and MI-GAN packages the same class of result at
mobile-inference cost. The models learned what walls, skies, skin
and foliage look like; a patch copier can only be told where to look.

Two applications, one engine, in ascending ambition:

1. **Heal/repair upgrade**: the existing repair-brush strokes become
   the inpainting mask. Small blemishes, dust, wires, distractions.
   This is where the traditional pass hurt most and where ML
   inpainting is night-and-day, and it needs no SAM at all.
2. **Subject removal**: P1's SAM mask (dilated) becomes the mask,
   same engine, larger canvas. Results at this size are good, not
   miraculous; the honest product story is "remove, then finish with
   the healing tools", never one-click magic.

Both are generative and both sit behind the same gate below; the
Section 17 amendment should be written once to cover this whole
spectrum, from a dust speck to a person. Ratified by (2026-08-23):
BOTH mask sources ship as first-class: brush-driven inpainting and
selection-driven inpainting are separate use cases ("there are
certainly use-cases for each"), not ambition tiers: the phasing
orders the work, not the product.

### Subject removal candidates: gated, phase 3

- Candidates: **LaMa** (Apache-2.0, including maintained ONNX
  exports; [github.com/advimman/lama](https://github.com/advimman/lama))
  and **MI-GAN** (Picsart, MIT, designed for mobile-class inference;
  [github.com/Picsart-AI-Research/MI-GAN](https://github.com/Picsart-AI-Research/MI-GAN)).
- Layer-4 caveat is real here: both are trained on Places2 (research
  -oriented terms) and MI-GAN's face model on FFHQ. This is the
  weakest licensing ground in the whole plan, which is one of two
  reasons removal comes last.
- The other reason is governance: the engineering spec's Section 17
  currently EXCLUDES generative cleanup. Subject removal is
  generative cleanup. **Step zero of phase 3 is the spec amendment,
  exactly like tethering; no code before it.**

## Architecture (how it lands in Heeler)

### New crate: `heeler-vision`

Owns `ort`, sessions, model files, pre/post-processing (resize,
normalization, mask upsampling, soft-edge refinement). The engine
crate stays pure: it never learns about ML. The desktop crate calls
heeler-vision the way it calls LibRaw: as a source of pixels (here,
of masks).

### Model distribution: downloaded, never bundled

The installer is under 10MB and stays that way. Models (MobileSAM
~40MB, BiRefNet ~90-400MB depending on variant) are downloaded on
first use of a smart tool:

- explicit consent dialog naming the model, its license, its size,
  and its source; nothing fetched silently;
- SHA-256 pinned per model version, verified on download and on
  load; stored under the app data dir; a Preferences page lists
  installed models with sizes and a delete;
- fully offline behavior: the tools report "model not installed"
  with the download offer, and everything else in Heeler is
  untouched. Batch/headless mode inherits the same cache.
- Apache/MIT notices for shipped-or-downloaded weights join the
  open-source page, same treatment as LibRaw and lensfun.

### Graph integration: a smart mask is still just a mask

New node `heeler.smart_mask` (masking category), mask output like
every other mask node. Its parameters are the RECIPE, not the pixels:

- `mode`: subject | foreground | sky | click
- `prompts`: JSON list of positive/negative click points in image
  coordinates (the SAM contract), empty for the one-shot modes
- `model`: which model produced it (recorded for honesty and cache
  keying), plus feather/expand/threshold post-dials reusing the
  existing mask post-op patterns.

The computed raster is a CACHE, not graph content: stored in the
catalog beside proxies, keyed by (image content, node params, model
version). Graphs stay small and portable; opening a graph on a
machine without the cache recomputes if the model is present, or
renders the mask empty with a badge if not: visible, never silent.
Determinism note for batch: same model version + same inputs =>
same mask; the model version in the params is what makes a `.heeler`
script reproducible.

The engine sees the mask through the existing side-channel the ROI
and layer machinery already use for desktop-supplied buffers; the
executor's generic mask blending does the rest. No engine op learns
about ML.

### UI

- Viewer toolbar grows a Select group: SUBJECT (one shot), SKY (one
  shot), and the click tool (SAM): click adds, ALT-click subtracts,
  each click refining the same mask; the overlay preview rides
  maskPreviewNode exactly like Color Sets' eye.
- Results land as a `smart_mask` node wired to whatever the user is
  doing, following the existing layer-mask flow (a smart selection
  becomes a layer mask the way a brush selection does).
- Background REMOVAL (the export flavor: subject matted onto
  transparency) is the subject matte + existing alpha-aware export;
  it needs no new engine machinery, only an export toggle.

## Phases

- **P1: click-to-select (SAM).** heeler-vision + ort + MobileSAM
  encoder/decoder ONNX; embedding cached per image per session;
  click gesture; smart_mask node; mask cache in catalog; model
  download flow with consent + checksums. Acceptance: click on a
  subject at preview res, mask under 150ms per click after the
  initial encode, add/subtract clicks refine, batch renders
  reproduce it.
- **P2: one-shot subject + sky + background removal.** BiRefNet
  ONNX for SUBJECT/matting (with the layer-4 caveat recorded on the
  open-source page); SAM-prompted sky; alpha export path. Optional:
  upgrade P1's decoder to SAM 2.1 tiny if the ONNX export proves
  clean.
- **P3: subject removal.** Spec Section 17 amendment FIRST. Then
  LaMa or MI-GAN behind the same download-consent flow, driven by
  P1's masks, with the Places2/FFHQ provenance stated plainly in the
  docs. Quality bar: hand the result to the healing/polish tools for
  finishing rather than promising one-click miracles.

## Performance budget

- Encode (MobileSAM, 1024px preview): <= 2s CPU, target <500ms via
  CoreML; runs once per photo, async, never blocks the render pump.
- Per-click decode: <= 150ms end-to-end including upsample.
- BiRefNet one-shot: <= 4s CPU at 1024, async with progress; cached
  thereafter.
- Memory: sessions lazy-loaded, dropped on idle; embeddings in the
  session cache under the existing budget accounting.

## Test strategy

- heeler-vision unit tests against tiny fixture tensors (pre/post
  processing, mask upsample, RLE round-trip): no models in CI.
- One gated integration test (env-var opt-in, model present) that
  runs a real click on a fixture photo and asserts IoU against a
  stored reference mask, pinned per model version.
- Contract tests: smart_mask with no cache and no model renders
  empty-with-badge, never errors the graph; batch determinism
  (same inputs, same mask hash).

## Risk register

| Risk | Standing |
|---|---|
| Runtime licenses (ort/ONNX Runtime) | Clean (MIT/Apache) |
| SAM family code+weights+data | Clean (Apache-2.0; SA-V is CC-BY-4.0): the anchor of the plan |
| BiRefNet weights | MIT, author-released; training corpus academic: acceptable, one notch below SAM; documented |
| RMBG-2.0 | Rejected: non-commercial without a BRIA contract |
| Inpainting weights (Places2/FFHQ provenance) | Weakest layer; phase 3 only, behind the Section 17 amendment and explicit documentation |
| Model size vs installer | Solved by download-on-consent; installer unchanged |
| ort bundles a C++ runtime | Accepted for CoreML/DirectML; tract/candle recorded as pure-Rust fallbacks |
