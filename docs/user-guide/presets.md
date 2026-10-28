# Presets tab

![Presets tab icon](assets/icons/tab-presets.svg)

Presets are saved looks. Applying one replaces the current Develop look while preserving what belongs to the photograph rather than the look: its crop, its develop layers with their masks, the document selection, any removals, and the Finish layer stack. One Undo returns to the previous look.

![Presets tab](assets/screenshots/presets-tab.png)

## Built-in presets

Built-in looks are read-only and grouped into categories. Categories begin collapsed, and stay as you leave them while the app is open, even after visiting another tab. Click a category to open it, or type in **Search** to show matching looks across categories. Click a preset name to apply it. Use **Export** to save a shareable copy.

## Your presets

Your presets work the same way but can be created and removed. The two glyphs beside the heading are the actions: the bookmark with a plus, **Save look**, stores the current Develop chain, and asks for a name and optional category; the tray with an arrow, **Import**, adds preset files. The remove button moves a user preset into `presets/.trash`; it does not permanently erase it.

Presets replace the whole look. To keep a group of nodes you drop into a graph beside what is there, save it as a node recipe instead: recipes are files too, in a `recipes` folder beside `presets`, with the same Import, Export and `.trash`. See [Node recipes](graph/recipes.md#recipe-files).

A Custom tone curve saved as a tone profile is kept apart from presets: it is a file in a `profiles` folder beside `presets`, listed in the Profile menu of every photograph. See [Custom profiles](adjustments/source.md#custom-profiles).

## Preset files

A preset is a text file you can read and edit, written in YAML, the same format as [node recipe files](graph/recipes.md#recipe-files). Your presets live in a `presets` folder in Heeler's app data, one file per preset, with each category a folder: `presets/Travel/Warm Afternoon.heelerpreset`. **Export** writes the same kind of file wherever you choose, and **Import** adds one to the **Imported** category.

A small preset looks like this:

```yaml
# Heeler preset: a look, saved from the Presets tab. Edit it in any text
# editor; Heeler reads it again when you apply it. The user guide
# explains the fields: Presets > Preset files.
schema: 1
name: Warm Afternoon
nodes:
  - id: src
    type: heeler.image_source
    enabled: true
    params: {}
  - id: exposure
    type: heeler.exposure
    enabled: true
    params:
      contrast: 55
  - id: output
    type: heeler.output
    enabled: true
    params: {}
wires:
  - from: src
    to: exposure
    kind: image
    toPort: in
  - from: exposure
    to: output
    kind: image
    toPort: in
```

- `schema` is the preset format's version. A preset from a newer Heeler than yours is refused with a message, not half read.
- `name` is the name the Presets tab shows.
- `nodes` are the look's nodes: each one's `id`, its `type`, whether it is `enabled`, and its settings under `params` (numbers) and `textParams` (curves and other text).
- `wires` connect them: `from` one node's id `to` another's.

You can change a value in any text editor, and Heeler reads the file again when you apply the preset. If a file cannot be read, the error names the line that is wrong. Heeler does not keep your comments when it writes the file itself (Save look over an existing name, for example).

Presets saved by Heeler before 2026.5.3 are JSON files with the same extension. They still import and apply exactly as before, and Heeler writes them as YAML the next time it saves or exports them.

## What a look includes

A look is intended to transfer development decisions: exposure, color, curves, detail, and other Develop-chain operations. It does not capture the photograph's crop, its develop layers or their masks, the document selection, removals, or the Finish layer stack. This makes a look reusable across differently composed photographs.

## A practical workflow

1. Finish the global look on a representative photograph.
2. Open Presets and click the bookmark, **Save look**.
3. Name it for the result, not the source file, and assign a category if useful.
4. Open another photograph and click the new preset.
5. Fine-tune exposure and white balance for that frame.

## Calibrations and charts

The Color Checker's **Save calibration** writes a preset into the
**Calibrations** category: the fitted matrix, exposure, chart and report,
nothing about the photograph it was fitted on. A calibration applies from
the Color Checker section rather than from this tab, in one undo step, and
the section warns when the camera it was fitted on differs from the
photograph's. In the tab a calibration is an ordinary user preset, so it
exports and imports like any other.

Custom charts from the Color Checker's chart editor live beside the
presets in a `charts` folder, one JSON file per chart, and travel the same
way: the editor's **Import** and **Export** chips read and write the
files, and a chart file dropped into that folder lists beside the
built-in charts.
