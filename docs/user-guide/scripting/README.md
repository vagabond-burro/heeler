# Python scripting

Heeler exposes one public Python module named `heeler`. The module represents the current Heeler session: import it and call its functions directly. There is no client class to construct and no third-party dependency to install.

```python
import heeler

heeler.set_param("exposure", "exposure", 0.7)
heeler.render("proof.jpg")
```

> **Screenshot placeholder: Python console:** Show the Python tab with a short script in the scratchboard, Echo enabled, printed output above, and Run/Open/Save/Reset controls visible.

## Documentation

- [Getting started](getting-started.md): built-in console, external scripts, batch mode, files, connection discovery, and errors.
- [Objects and return schemas](data-model.md): the dictionaries and lists returned by the package.
- [Examples](examples.md): complete scripts for common workflows.
- [API support matrix](support-matrix.md): which functions work in the app, externally, and in headless batch mode.
- [Complete API reference](reference/README.md): every public symbol, signature, argument, return value, mode restriction, and exception.

## Three ways to run Python

### Built-in console

Open the console and select **Python**. The `heeler` module is already imported and connected. Use this for exploration, one-off automation, and scripts that should update the visible app.

### External script

Enable **Preferences > Scripting > Python scripting**, place the shipped `heeler.py` beside your script or on `PYTHONPATH`, and run it with your Python interpreter. The first API call discovers and connects to the running app automatically.

### Batch mode

Start Heeler with `-x SCRIPT` to run a `.heeler` or `.py` file without opening the interface. Batch mode uses the selected catalog, writes standard output to the terminal, and exits with status 0 when the script completes or 1 when it raises.

```text
Heeler.exe -x "D:\jobs\export-picks.heeler" --catalog "D:\catalogs\work.heeler"
```

Batch mode intentionally supports catalog, saved-graph, render, and export automation. Operations that need live interface state raise `HeelerError` and explicitly name batch mode.

## Package scope

The package currently consists of the single `heeler` module. Its public surface is defined by `heeler.__all__`: `HeelerError` plus 44 functions. Names beginning with `_` are implementation details and are not part of the scripting contract.

All remote operations return JSON-compatible values: dictionaries, lists, strings, numbers, booleans, or `None`. `render()` additionally returns `bytes` when no output path is supplied and a `(width, height)` tuple when it writes a file.
