# Microsoft Store listing copy

The text pasted into Partner Center's Store listing page (2026-10-06). Kept here so the next submission starts from what is live,
and so a change to the feature set can be checked against it. Partner
Center's limits: description 10,000 characters, each feature 200, what's
new 1,500.

## Description

Heeler is a RAW photo editor built around a node graph, with depth-aware tools that work on the scene itself: relight a subject, add fog behind it, rescue a blown sky, or shift the focus after the shot.

Every edit is non-destructive. Behind the familiar Develop panel sits a processing graph you can open at any time, so each slider is a real node you can rewire, group, reuse as a recipe, or drive from a Python script. Start with sliders, move to the graph when you want more control, and never lose your original.

DEPTH AND SMART TOOLS
Heeler estimates the depth of every photograph and uses it. Light a scene from a new direction with Depth Lighting, lay fog between planes, blur the background with a true depth-of-field falloff, and select a subject or sky in one click. The machine-learning models behind these tools are optional downloads that run on your own computer. Your photos never leave your machine.

DEVELOP
Exposure, white balance, tone curves, levels, color wheels, color tuning, black and white, sharpening, noise reduction, lens corrections, vignette, grain, halation and lens character. Recover highlights and shadows, correct geometry, and build a look you can save as a preset.

FINISH
A full layer stack after the develop: adjustment layers, pixel and image layers, fills, gradients, dodge and burn, warps, layer masks, blend modes, groups, clipping and layer effects. Export the stack flat, or write its layers into a layered TIFF or EXR.

MERGE AND STITCH
Merge brackets to HDR, simulate a long exposure, remove moving people with a median stack, or build light trails and star trails. Stitch overlapping frames into a panorama. Merges stay editable recipes, and Bake to Image freezes any result into a new DNG beside the original.

LIBRARY
Browse folders, build collections, rate, flag and keyword your photos, and filter by any of them. Link a set of photographs so an edit to one carries to all, and keep alternate versions of an edit as Takes. Recovery bundles back up your catalog and edits and verify them offline.

EXPORT
JPEG, WebP, PNG, TIFF, EXR and DNG at full resolution, with batch export groups, naming rules, presets and a queue.

AUTOMATION
A built-in Python console and a local scripting API for batch work and custom tools, with a complete reference in the user guide.

FREE AND OPEN SOURCE
Heeler is free and open source under the Mozilla Public License 2.0. Every feature is in every copy: no tiers, no license key, no subscription, no time limit, no watermark and no cap on resolution.

Heeler reads RAW files from most cameras, including Canon, Nikon, Sony, Fujifilm, Panasonic, Olympus, Pentax, Leica and Hasselblad, plus DNG and phone RAW files from iPhone, Pixel and Samsung.

## Product features

1. Node-based, non-destructive RAW editing: every slider is a real node you can rewire
2. Depth Lighting: relight a scene from a new direction using its estimated depth
3. Add fog and haze between the planes of a scene
4. Depth of field after the shot, with a true depth-based blur
5. Sky Rescue for blown and washed-out skies
6. One-click Select Subject and Select Sky, with edge refinement
7. AI models run on your own computer; your photos never leave it
8. Full develop controls: exposure, white balance, curves, levels, color wheels
9. Sharpening, noise reduction, lens corrections and geometry
10. Film character: grain, halation, lens character and black and white
11. Finish layer stack: adjustment layers, masks, blend modes, groups, clipping
12. Layer effects and layered TIFF and EXR export
13. Merge to HDR, long exposure, median, light trails and star trails
14. Panorama stitching that stays an editable recipe
15. Bake to Image: freeze any edit into a new DNG beside the original
16. Library with collections, ratings, flags, keywords and filters
17. Linked edits across a set of photographs, and Takes for alternate versions
18. Export to JPEG, WebP, PNG, TIFF, EXR and DNG at full resolution
19. Python scripting console and local API for automation
20. Free and open source: every feature in every copy, no watermark, no subscription

## What's new in this version

Heeler 2026.4.1
- iPhone ProRAW photos open at the exposure the phone gave them.
- Pixel and Samsung Expert RAW files follow the processing their own files describe, and Samsung thumbnails use the phone's own preview.
- Finish adjustment layers correct the picture at its true brightness, the same way the Develop controls do.
- Adjustments inside a Finish group read the layers below them, and grouping keeps a layer's blend mode and clipping.
- Layer effects keep their size in the export, and large shadows render much faster.
- Depth Lighting's directional light gains Elevation, Depth and Reach sliders.
- Adjustment layers can be written into a TIFF or EXR export as layers of their own.
- Many smaller fixes across the Export panel, sliders and scripting.

## Screenshots

Ten PNGs at 3840x2160, made by `apps/heeler-app/scripts/storeshots.mjs`
from the browser build of the demo session (the owner's own photographs in
`src/demo-photos`). Start the browser build on port 5191 (`npm run
dev -- --port 5191` in `apps/heeler-app`, so 5173 stays free),
then run `node scripts/storeshots.mjs` from `apps/heeler-app`. They land
in the ignored `dist/store-screenshots/`. Upload them in this order;
the first is the one search results show. The caption is the text
Partner Center allows under each (200 characters).

The browser build previews edits with CSS filters, so none of the ten
shows a depth tool: Depth Lighting, Fog and Depth of Field would sit
on an unchanged picture there. Depth shots want the desktop app's own
renders.

| File | Caption |
|---|---|
| 01-develop.png | Non-destructive RAW editing with a full Develop panel |
| 02-graph.png | Every slider is a real node: open the graph and rewire your edit |
| 03-black-and-white.png | Black and white with film stocks, filters and a hue curve |
| 04-finish.png | A layer stack after the develop: adjustments, gradients, warps, masks |
| 05-relight.png | Relight reshapes tone zone by zone |
| 06-catalog.png | Browse, rate, flag and filter your library |
| 07-color.png | Color wheels for shadows, midtones and highlights |
| 08-detail.png | Texture, clarity, noise reduction and sharpening |
| 09-canvas.png | Canvas: the graph laid over the photograph it builds |
| 10-export.png | Full-resolution export with batches, presets and naming rules |
