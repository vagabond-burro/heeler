# Catalog reference

## `images()`

```python
heeler.images()
```

Lists visible catalog images. Hidden catalog entries are excluded.

**Arguments:** none.

**Returns:** `list[dict]` with `id`, `name`, `stars`, and `flag`. App results also contain `edited`; batch results contain `path`. See [Catalog image](../data-model.md#catalog-image).

**Raises:** `HeelerError` on catalog or bridge failure.

**Availability:** app, external, and batch.

```python
picks = [item for item in heeler.images() if item["flag"] == "pick"]
```

## `rate()`

```python
heeler.rate(image_ids, stars: int)
```

Sets the star rating for one or more catalog images.

**Arguments**

- `image_ids`: one image-id string or any iterable of image-id strings. A bare string is treated as one id rather than iterated by character.
- `stars`: integer rating from 0 through 5. Batch clamps larger nonnegative values to 5; use the documented range for consistent behavior.

**Returns:** `{"dispatched": "set_rating"}`.

**Raises:** `HeelerError` on invalid catalog operations or bridge failure. `TypeError` can occur if `image_ids` is neither a string nor iterable.

**Availability:** app, external, and batch.

## `flag()`

```python
heeler.flag(image_ids, flag: str)
```

Sets or clears the review flag for one or more images.

**Arguments**

- `image_ids`: one id string or an iterable of id strings.
- `flag`: `"pick"`, `"reject"`, or `""` to clear. Use only these values; batch treats unknown text as clear while the app can reject invalid values.

**Returns:** `{"dispatched": "set_flag"}`.

**Raises:** `HeelerError` on catalog or bridge failure.

**Availability:** app, external, and batch.

## `open_image()`

```python
heeler.open_image(image_id: str)
```

Makes a catalog image current. In the app this selects its thumbnail; in batch it loads the source path and saved graph for subsequent graph, render, and save operations.

**Arguments:** `image_id` is an id from `images()`.

**Returns:** app returns `{"dispatched": "select_image"}`. Batch returns `{"opened": image_id}`.

**Raises:** `HeelerError` when the id is not in the catalog or the source/session cannot be opened.

**Availability:** app, external, and batch.

## `collections()`

```python
heeler.collections()
```

Lists catalog collections.

**Arguments:** none.

**Returns:** `list[dict]` with `id`, `name`, `count`, and `hasLook`.

**Raises:** `HeelerError` on catalog or bridge failure.

**Availability:** app, external, and batch.
