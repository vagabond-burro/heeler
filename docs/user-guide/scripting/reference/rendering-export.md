# Rendering and export reference

## `save()`

```python
heeler.save()
```

Persists the open image's current graph.

**Arguments:** none.

**Returns:** app returns `{"saved": image_id, "automatic": True}` because the live app already saves continuously. Batch writes the graph file, marks the catalog image edited, and returns `{"saved": image_id}`.

**Raises:** `HeelerError` when batch has no open image or the graph cannot be written.

**Availability:** app, external, and batch. It is operationally necessary only in batch after graph edits.

## `render()`

```python
heeler.render(
    path: str | None = None,
    node: str = "output",
    quality: int = 92,
)
```

Renders the active image through the engine and encodes the result as JPEG.

**Arguments**

- `path`: local destination filename. If `None`, no file is written and encoded bytes are returned.
- `node`: graph node id to render. The app can render an intermediate image-output node. Batch currently renders the final graph and ignores this targeting distinction.
- `quality`: JPEG quality. The batch renderer clamps to 1 to 100; use that range consistently.

**Returns**

- With `path=None`: JPEG `bytes`.
- With a path: writes the file and returns `(width, height)` as an integer tuple.

**Raises**

- `HeelerError` when no image is open, the target is missing or does not produce an image, decoding/rendering fails, or the bridge fails.
- `OSError` when Python cannot write `path` after receiving the rendered bytes.

**Availability:** app, external, and batch. Intermediate-node targeting is app-only.

```python
width, height = heeler.render("proof.jpg", quality=88)
print(width, height)
```

`render()` always produces JPEG. Use `export_images()` for WebP, PNG, PNG 16, TIFF, DNG, resizing, naming templates, and metadata options.

## `export_images()`

```python
heeler.export_images(
    dest: str,
    ids=None,
    format: str = "jpeg",
    quality: int = 92,
    max_edge: int | None = None,
    template: str = "{name}",
    keep_metadata: bool = True,
    matte: bool = False,
    dpi: float | None = None,
)
```

Runs the same per-image export pipeline as the Export panel.

**Arguments**

- `dest`: destination directory. The export pipeline creates it when supported and needed.
- `ids`: one image-id string, an iterable of image ids, or `None`. `None` uses the app's export targets: current selection or active image. In batch, supply ids for predictable multi-image work.
- `format`: `"jpeg"`, `"webp"`, `"png"`, `"png16"`, `"tiff"`, `"tiff32"`, or `"dng"`. `"tiff32"` is the 32-bit float scene-linear TIFF for compositing; it carries no metadata.
- `quality`: 1 to 100 for lossy JPEG and WebP output; supplied but not meaningful for lossless formats.
- `max_edge`: positive long-edge pixel cap, or `None` for full size.
- `template`: filename template using `{name}`, `{n}`, `{stars}`, and `{flag}`.
- `keep_metadata`: retain supported EXIF/camera metadata when `True`.
- `matte`: place the graph's Smart mask into the alpha channel. It applies to PNG, PNG 16, and TIFF (16-bit and 32-bit float) output.
- `dpi`: print resolution in dots per inch, 300 when omitted. Finite numbers round to the nearest whole number and clamp to 1 through 65535. NaN and infinity use the default. It changes declared print size without changing pixels. Heeler does not apply this setting to DNG or EXR exports.

**Returns:** `{"written": list[str], "failed": list[dict]}`. Each failure dictionary has `name` and `error`. Duplicate generated names receive `-2`, `-3`, and later suffixes rather than overwriting.

**Raises:** `HeelerError` for request-level errors such as an absent destination, unsupported format, bridge failure, or export pipeline failure before per-image processing. Individual image errors are collected in `failed`.

**Availability:** app, external, and batch.

```python
result = heeler.export_images(
    "exports/web",
    ids=[image["id"] for image in heeler.images() if image["stars"] >= 4],
    format="jpeg",
    quality=85,
    max_edge=2048,
    template="{name}_web",
    keep_metadata=False,
)
for path in result["written"]:
    print("wrote", path)
for failure in result["failed"]:
    print("failed", failure["name"], failure["error"])
```
