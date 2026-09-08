# Contributing

Three kinds of contribution are accepted here. Open a pull request against `main`.

## What goes where

- **`scripts/`**: Python scripts that use only the public `heeler` package and the standard library. One script per file, a docstring at the top saying what it does and whether it runs in the app console, the batch runner, or both.
- **`presets/`**: `.heelerpreset` files exported from Heeler's Presets tab with **Export**. Put each in a folder named for the category it belongs in, and add a line to that folder's README saying what the look is for.
- **`controllers/`**: profiles for hardware controllers. One folder per device, the profile file plus a README with the version of the vendor software it was made in.

## Licensing of contributions

By opening a pull request you agree that your contribution is licensed as its folder is: MIT for `scripts/`, CC0 for `presets/` and `controllers/`. See [LICENSE](LICENSE). Do not contribute anything you do not have the right to license that way.

## What is not accepted here

- Heeler source code, decompiled or otherwise.
- Copies of the installers. Link to the Releases page instead.
- Bug reports about Heeler itself. Use the app's Help menu.
