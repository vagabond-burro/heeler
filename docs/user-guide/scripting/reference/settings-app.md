# Settings and app-control reference

These functions require the running app. Batch mode has no live Preferences panel, folder ribbon, or workspace mode and raises `HeelerError`.

## `prefs()`

```python
heeler.prefs()
```

Reads the app's complete preference object.

**Arguments:** none.

**Returns:** preference dictionary. Current keys and meanings are summarized under [Preferences](../data-model.md#preferences).

**Raises:** `HeelerError` on bridge failure or unsupported mode.

**Availability:** app and external; not batch.

## `set_prefs()`

```python
heeler.set_prefs(**fields)
```

Updates one or more preferences through the same reducer used by the Preferences panel.

**Arguments:** keyword fields named exactly as keys returned by `prefs()`. Values must be JSON serializable and valid for the connected app version.

**Returns:** `{"dispatched": "set_prefs"}`.

**Raises:** `HeelerError` for invalid or unsupported preferences and `TypeError` for values that cannot be serialized.

**Availability:** app and external; not batch.

```python
heeler.set_prefs(
    quickQuality=85,
    quickResize="edge",
    quickEdge=2048,
    backupEveryDays=7,
)
```

Read the current object before changing a field if a script must work across multiple app versions.

## `hotkeys_export()`

```python
heeler.hotkeys_export()
```

Serializes the current hotkey overrides in the same versioned JSON format written by Preferences.

**Arguments:** none.

**Returns:** JSON `str`. The document contains a format version and command-to-binding map. Only overrides need to be stored.

**Raises:** `HeelerError` on bridge failure or unsupported mode.

**Availability:** app and external; not batch.

```python
from pathlib import Path

Path("heeler-hotkeys.json").write_text(
    heeler.hotkeys_export(), encoding="utf-8"
)
```

## `hotkeys_import()`

```python
heeler.hotkeys_import(text: str)
```

Imports a versioned hotkey-map document.

**Arguments:** `text` is the complete JSON document as a string.

**Returns:** dictionary with `imported`, the number of accepted overrides, and `dropped`, a list of unknown command ids.

**Raises:** `HeelerError` for malformed JSON, an invalid hotkey-map shape, bridge failure, or unsupported mode.

**Availability:** app and external; not batch.

## `open_folder()`

```python
heeler.open_folder(path: str)
```

Opens a filesystem folder through the same workflow as **File > Open folder…**. The Library tree and thumbnail panel follow it.

**Arguments:** `path` is a nonempty folder path string.

**Returns:** `{"opened": path, "name": folder_name, "images": count}`. The returned `opened` path is the resolved listing path supplied by the desktop bridge.

**Raises:** `HeelerError` for an empty or nonexistent path, folder-read failure, or unsupported mode.

**Availability:** app and external; not batch.

## `set_mode()`

```python
heeler.set_mode(mode: str)
```

Switches the app workspace.

**Arguments:** `mode` is `"simple"` for Develop, `"advanced"` for Graph, or `"canvas"` for Canvas.

**Returns:** `{"dispatched": "set_mode"}`.

**Raises:** `HeelerError` for an invalid mode or unsupported batch operation.

**Availability:** app and external; not batch.

```python
heeler.set_mode("advanced")
```
