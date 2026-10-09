# Objects and return schemas

The bridge serializes data as JSON. Python receives dictionaries, lists, strings, floats, integers, booleans, and `None`. Key names intentionally follow the app protocol and are sometimes camelCase.

## Command result

Most wrappers that dispatch a live command return:

```python
{"dispatched": "set_param"}
```

The `dispatched` value is the command type, not a render-completion signal. If the command is invalid or unavailable, the call raises `HeelerError` instead of returning an error dictionary.

Batch `open_image()` is the exception among command wrappers and returns `{"opened": image_id}`.

## Session state

`state()` returns:

```python
{
    "imageId": "4871",       # str or None
    "imageName": "frame.CR3",# str or None
    "mode": "simple",        # simple, advanced, canvas, or batch
    "tool": "none",          # app only; absent in batch
}
```

## Catalog image

`images()` returns a list of image dictionaries.

| Key | Type | Notes |
|---|---|---|
| `id` | `str` | Stable catalog id used by other functions. |
| `name` | `str` | Filename shown in the Library. |
| `stars` | `int` | 0 through 5. |
| `flag` | `str` | `""`, `"pick"`, or `"reject"`. |
| `edited` | `bool` | App connection only. |
| `path` | `str` | Batch mode only. |

Stack, panorama, and bake creation return a new library-entry dictionary with at least `id`, `name`, `stars`, `flag`, and `edited`. The live app may additionally include UI fields such as `filter` and `src`; scripts should rely on the catalog fields.

## Collection

`collections()` returns dictionaries with `id`, `name`, `count`, and `hasLook`. `id` is the catalog's collection identifier, `count` is its current image count, and `hasLook` indicates an associated collection look.

## Graph

`graph()` returns:

```python
{
    "nodes": [...],
    "wires": [...],
    "selection": ["node_id", ...],
}
```

App node dictionaries contain:

| Key | Type |
|---|---|
| `id`, `type`, `name`, `cat` | `str` |
| `enabled`, `isGroup` | `bool` |
| `params`, `textParams` | `dict` |
| `tint`, `note` | `str` or `None` |
| `x`, `y` | `number` |

Batch nodes are read from the embedded render graph and can omit UI-only keys. Common keys are `id`, `type`, `name`, `enabled`, `params`, and text-parameter storage used by the saved graph.

An image wire normally contains `from`, `to`, `toPort`, and `kind`. `toPort` is typically `"in"`, `"in2"`, `"mask"`, or `"clip"`; `kind` is `"image"`, `"mask"`, or an internal group connection.

## Registry node specification

Each dictionary from `registry()` contains:

| Key | Type | Meaning |
|---|---|---|
| `type` | `str` | Stable node type, such as `heeler.exposure`. |
| `label` | `str` | User-facing name. |
| `version` | `int` | Node schema version. |
| `params` | `list[dict]` | Numeric parameter specifications. |
| `inputs` | `list` | Declared input ports. |
| `outputs` | `list` | Declared output ports. |

Each parameter specification contains `name`, `default`, `min`, `max`, `hard_min`, and `hard_max`. `min` and `max` describe the ordinary UI range. Hard limits describe legal values; `None` means unbounded in that direction.

## Takes

`takes()` returns:

```python
{
    "imageId": "4871",
    "active": "take_2",
    "takes": [
        {"id": "take_1", "name": "Take 1", "note": None},
        {"id": "take_2", "name": "Warm", "note": "client choice"},
    ],
}
```

An image without explicit versions reports one implicit `take_1`.

## Export report

`export_images()` returns:

```python
{
    "written": ["/output/a.jpg", "/output/b.jpg"],
    "failed": [
        {"name": "missing-id", "error": "not in the open folder"},
    ],
}
```

Per-image failures do not raise and do not stop the run. A request-level failure, such as an invalid format or inaccessible bridge, raises `HeelerError`.

## Stack recipe

`stack_info()` and `stack_configure()` return:

```python
{
    "mode": "hdr",          # hdr, mean, median, or max
    "align": True,
    "members": ["a.CR3", "b.CR3"],
    "missing": [],
}
```

Members are stored filenames in recipe order. `missing` lists members that cannot currently be read.

## Panorama recipe

`pano_info()` and `pano_configure()` return:

```python
{
    "surface": "cylindrical",
    "gain_compensation": True,
    "straighten": True,
    "bands": 4,
    "members": ["left.CR3", "right.CR3"],
    "missing": [],
}
```

## Preferences

`prefs()` returns the current preference dictionary. The supported keys are:

- `paletteRecents`, `consoleCustomMax`, `hotkeys`
- `backupEveryDays`, `backupFolder`
- `brushGrainStep`, `brushGrainFineStep`
- `quickQuality`, `quickResize`, `quickEdge`, `quickPercent`
- `serveSimpleLink`
- `viewerZoomRate`, `viewerRotationStep`, `wheelZoomInverted`
- `previewEdge`, `gesturePreviewEdge`, `gpuPreviews`
- `ribbonMinWidth`, `ribbonMaxWidth`, `thumbnailEdge`
- `autosaveDelayMs`
- `maskOverlayColor`, `maskOverlayOpacity` (whole percent, 0 to 100)
- `tetherDestination`, `tetherNamingPattern`, `tetherAutoAdvance`, `tetherPollMs`
- `exportDefaultFormat`, `exportTemplate`, `exportKeepMetadata`
- `modelStoreDir`, `experimentalFeatures`

Unknown keys from a newer build can be preserved by the app, but `set_prefs()` should use fields recognized by the connected build.

## Hotkey import report

`hotkeys_import()` returns `{"imported": int, "dropped": list[str]}`. Unknown command ids are listed in `dropped` rather than retained.

## Render result

`render()` returns raw JPEG `bytes` when `path` is `None`. When a path is supplied, it writes the bytes locally and returns `(width, height)` as a two-integer tuple.
