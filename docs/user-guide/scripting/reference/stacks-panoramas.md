# Stacks and panoramas reference

These functions require the desktop app because they operate on real source files and update the visible Library. Batch mode raises `HeelerError` naming the unsupported method.

## `stack_create()`

```python
heeler.stack_create(ids, mode: str)
```

Creates a nondestructive stack recipe from two or more catalog images.

**Arguments**

- `ids`: iterable of at least two image-id strings.
- `mode`: `"hdr"`, `"mean"`, `"median"`, or `"max"`.

**Returns:** the new library-entry dictionary with catalog fields including `id`, `name`, `stars`, `flag`, and `edited`.

**Raises:** `HeelerError` for too few or invalid images, an unsupported mode, missing source files, merge failure, or unavailable desktop app. `TypeError` if `ids` is not iterable.

**Availability:** app and external; not batch.

## `stack_info()`

```python
heeler.stack_info(image_id: str)
```

Reads a stack recipe.

**Arguments:** `image_id` is the catalog id of a stack.

**Returns:** dictionary containing `mode`, `align`, `members`, and `missing`.

**Raises:** `HeelerError` when the id is absent, is an ordinary photograph, or cannot be read.

**Availability:** app and external; not batch.

## `stack_configure()`

```python
heeler.stack_configure(
    image_id: str,
    mode=None,
    align=None,
    members=None,
)
```

Rewrites selected stack-recipe fields without baking it. Omitted `None` arguments preserve their existing values.

**Arguments**

- `image_id`: stack catalog id.
- `mode`: optional `"hdr"`, `"mean"`, `"median"`, or `"max"`.
- `align`: optional boolean controlling frame alignment.
- `members`: optional iterable of at least two member filenames in desired order.

**Returns:** updated stack-info dictionary.

**Raises:** `HeelerError` for an invalid stack or recipe. `TypeError` if `members` is supplied but not iterable.

**Availability:** app and external; not batch.

## `stack_bake()`

```python
heeler.stack_bake(
    image_id: str,
    format: str = "dng",
    quality: int = 92,
)
```

Freezes current edits into a new photograph beside the original, or beside the first member for a stack or panorama. The historical method name also accepts an ordinary photograph. The new DNG opens with fresh controls and its tone profile bypassed; the original is untouched. See [Bake to Image](../../composites.md#bake-to-image).

**Arguments**

- `image_id`: photograph, stack, or panorama catalog id.
- `format`: `"dng"`, `"tiff"`, or `"jpg"`.
- `quality`: JPEG quality when `format="jpg"`.

**Returns:** the new baked library-entry dictionary.

**Raises:** `HeelerError` for an unsupported format, invalid recipe, render/write failure, or unavailable desktop app.

**Availability:** app and external; not batch.

## `pano_create()`

```python
heeler.pano_create(ids)
```

Creates a nondestructive panorama recipe from two or more catalog images. The stitch renders when opened.

**Arguments:** `ids` is an iterable of at least two image ids.

**Returns:** the new panorama library-entry dictionary.

**Raises:** `HeelerError` for invalid images, too few frames, source/stitch failure, or unavailable desktop app.

**Availability:** app and external; not batch.

## `pano_info()`

```python
heeler.pano_info(image_id: str)
```

Reads a panorama recipe.

**Arguments:** `image_id` is the panorama's catalog id.

**Returns:** dictionary containing `surface`, `gain_compensation`, `straighten`, `bands`, `members`, and `missing`.

**Raises:** `HeelerError` when the id is absent, is not a panorama, or cannot be read.

**Availability:** app and external; not batch.

## `pano_configure()`

```python
heeler.pano_configure(
    image_id: str,
    surface=None,
    gain_compensation=None,
    straighten=None,
    bands=None,
    members=None,
)
```

Rewrites selected panorama fields and invalidates its cached render. `None` preserves an existing value.

**Arguments**

- `image_id`: panorama catalog id.
- `surface`: optional `"auto"`, `"cylindrical"`, `"spherical"`, or `"planar"`.
- `gain_compensation`: optional boolean enabling exposure compensation across frames.
- `straighten`: optional boolean enabling automatic leveling.
- `bands`: optional integer blend-band count. The server clamps it to 1 to 6.
- `members`: optional iterable of at least two member filenames in order.

**Returns:** updated panorama-info dictionary.

**Raises:** `HeelerError` for invalid recipe data, a non-panorama id, or unavailable desktop app. `TypeError` if `members` is supplied but not iterable.

**Availability:** app and external; not batch.
