# Getting started with Python

## Built-in console

Open the console with **Window > Console**, the Console button in the title bar, or `Cmd` + backtick (`Ctrl` + backtick on Windows), and select **Python**. The upper area shows output; the lower scratchboard holds code. `heeler` is preloaded. The console's buttons are icons; point at one to read its name.

- `Cmd` (`Ctrl` on Windows)+`Enter` runs selected code, or the current line when nothing is selected.
- **Run** executes the entire active tab.
- A block returns the representation of its final expression, similar to a notebook cell.
- **+** creates a scratch tab.
- **Open** loads `.heeler` and `.py` files.
- **Save** and **Save as** write the active tab; a dot marks unsaved changes.
- **Reset** restarts the interpreter and clears variables while preserving tabs.
- Scratch tabs persist across restarts.

The console always opens in its own operating-system window. The interpreter namespace remains alive between executions until Reset.

## Echo UI actions as Python

Enable **Echo** in the Python console, then work in Heeler normally. Scriptable actions print their equivalent calls:

```python
heeler.set_param("exposure", "exposure", 0.35)
heeler.rate("4871", 4)
heeler.open_image("4872")
```

A slider drag echoes its final value rather than every intermediate movement. UI-only actions such as zooming or opening a dialog do not emit misleading code. Echo operates only while a console is visible.

## External scripts

1. Enable **Preferences > Scripting > Python scripting**.
2. Copy the shipped `tools/python/heeler.py` beside the script, or add that directory to `PYTHONPATH`.
3. Import `heeler` and make calls.
4. Run the file with a compatible Python 3 interpreter while Heeler remains open.

The module uses only Python's standard library. The app listens only on `127.0.0.1`, writes connection information to `~/.heeler/api.json`, and requires the generated token in every request.

Connection lookup occurs in this order:

1. An explicit `heeler.connect(port, token)` call.
2. `HEELER_API_PORT` and `HEELER_API_TOKEN` environment variables, used by the built-in console and batch runner.
3. The discovery file at `~/.heeler/api.json`.

Use `heeler.disconnect_bridge()` after restarting the scripting bridge so the next call discovers fresh connection details.

## Batch scripts

Batch uses the normal catalog unless `--catalog PATH` selects another. Open an image before using graph or render functions:

```python
import heeler

for image in heeler.images():
    if image["flag"] != "pick":
        continue
    heeler.open_image(image["id"])
    heeler.set_param("exposure", "exposure", 0.2)
    heeler.save()
```

The batch process exits 0 after normal completion and 1 when the script raises. Use that behavior to chain jobs in a shell or scheduler.

## Errors

Every bridge refusal and connection failure raises `heeler.HeelerError`, a subclass of `RuntimeError`. The message carries the app's reason.

```python
try:
    heeler.outside("unmasked_node")
except heeler.HeelerError as error:
    print("Could not create Outside:", error)
```

Local Python operations can raise their normal exceptions. For example, `render(path=...)` can raise `OSError` while opening the destination even after the remote render succeeded, and malformed local arguments can raise `TypeError` before a request is made.

## Discover node parameters

Node ids and parameter names are data, not guessed labels. Use `nodes()` for the current graph and `registry()` for the engine's node vocabulary:

```python
for node in heeler.nodes():
    print(node["id"], node["type"], node["params"])

exposure_spec = next(
    spec for spec in heeler.registry()
    if spec["type"] == "heeler.exposure"
)
print(exposure_spec["params"])
```

`set_param()` accepts a node id, parameter name, and numeric value. The server applies the same hard-limit validation as the UI.
