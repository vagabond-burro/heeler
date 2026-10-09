# Undo and takes reference

## `begin_gesture()`

```python
heeler.begin_gesture(key: str)
```

Starts command coalescing so repeated edits to the same logical control land as one Undo step.

**Arguments:** `key` identifies the logical control. For a node parameter, use `f"{node}.{param}"`.

**Returns:** `{"dispatched": "begin_gesture"}`.

**Raises:** `HeelerError` when unsupported or the bridge fails.

**Availability:** app and external; not batch.

Always pair this call with `end_gesture()`. Prefer `one_undo()` to guarantee pairing when an exception occurs.

## `end_gesture()`

```python
heeler.end_gesture()
```

Ends the active undo-coalescing gesture.

**Arguments:** none.

**Returns:** `{"dispatched": "end_gesture"}`.

**Raises:** `HeelerError` when unsupported or the bridge fails.

**Availability:** app and external; not batch.

## `one_undo()`

```python
heeler.one_undo(key: str)
```

Returns a context manager that calls `begin_gesture(key)` on entry and `end_gesture()` in a `finally` block on exit.

**Arguments:** `key` is the same logical-control key accepted by `begin_gesture()`.

**Yields:** `None` to the `with` block.

**Returns:** the context manager object when called; normal context-manager exit suppresses no exceptions.

**Raises:** `HeelerError` from gesture calls. Exceptions raised inside the block propagate after `end_gesture()` is attempted.

**Availability:** app and external; not batch.

```python
with heeler.one_undo("exposure.exposure"):
    for value in (0.1, 0.2, 0.3):
        heeler.set_param("exposure", "exposure", value)
```

## `takes()`

```python
heeler.takes()
```

Lists alternate edits for the open image.

**Arguments:** none.

**Returns:** dictionary with `imageId`, `active`, and `takes`. Each take has `id`, `name`, and `note`. An unbranched image reports an implicit `take_1`.

**Raises:** `HeelerError`, including when batch has no open image.

**Availability:** app, external, and batch.

## `new_take()`

```python
heeler.new_take(name: str | None = None, note: str | None = None)
```

Branches the current edit and makes the new copy active.

**Arguments**

- `name`: optional display name. When `None`, the app generates its normal take name.
- `note`: optional descriptive note. When `None`, the argument is omitted rather than clearing a note.

**Returns:** `{"dispatched": "new_take"}`.

**Raises:** `HeelerError` when no image is open or the operation is unsupported.

**Availability:** app and external; not batch.

## `switch_take()`

```python
heeler.switch_take(take_id: str)
```

Snapshots the current take and makes another take active.

**Arguments:** `take_id` from `takes()["takes"]`.

**Returns:** `{"dispatched": "switch_take"}`.

**Raises:** `HeelerError` for an unknown id, absent image, or unsupported mode.

**Availability:** app and external; not batch.

## `rename_take()`

```python
heeler.rename_take(
    take_id: str,
    name: str,
    note: str | None = None,
)
```

Changes a take's name and optionally its note.

**Arguments**

- `take_id`: take identifier.
- `name`: new nonempty name.
- `note`: new note. `None` omits the field and preserves the existing note; pass `""` to clear it.

**Returns:** `{"dispatched": "update_take"}`.

**Raises:** `HeelerError` for invalid data, missing take, or unsupported mode.

**Availability:** app and external; not batch.

## `delete_take()`

```python
heeler.delete_take(take_id: str)
```

Deletes a take and its edit history. The last remaining take cannot be deleted.

**Arguments:** `take_id` is the take to remove.

**Returns:** `{"dispatched": "delete_take"}`.

**Raises:** `HeelerError` for an unknown take, the final take, or unsupported mode.

**Availability:** app and external; not batch.
