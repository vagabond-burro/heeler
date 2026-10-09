# Complete `heeler` API reference

This reference covers every name exported by `heeler.__all__`. The package is one module; the sections below are organizational pages, not Python submodules.

## Reference pages

- [Connection and session](connection-session.md): `HeelerError`, `connect`, `disconnect_bridge`, `rpc`, `ping`, `state`
- [Registry and graph](registry-graph.md): `registry`, `graph`, `nodes`, `command`, `set_param`, `connect_nodes`, `disconnect`, `rename`, `enable`, `outside`
- [Catalog](catalog.md): `images`, `rate`, `flag`, `open_image`, `collections`
- [Rendering and export](rendering-export.md): `save`, `render`, `export_images`
- [Undo and takes](undo-takes.md): `begin_gesture`, `end_gesture`, `one_undo`, `takes`, `new_take`, `switch_take`, `rename_take`, `delete_take`
- [Stacks and panoramas](stacks-panoramas.md): `stack_create`, `stack_info`, `stack_configure`, `stack_bake`, `pano_create`, `pano_info`, `pano_configure`
- [Settings and app control](settings-app.md): `prefs`, `set_prefs`, `hotkeys_export`, `hotkeys_import`, `open_folder`, `set_mode`
- [Low-level protocol appendix](protocol.md): accepted `command()` types and `rpc()` methods

## Common behavior

Unless an entry says otherwise:

- A remote refusal or transport failure raises [`HeelerError`](connection-session.md#heelererror).
- App commands participate in the same command validation and history model as UI actions.
- Parameters are positional or keyword arguments according to the displayed Python signature.
- Returned dictionaries use the schemas in [Objects and return schemas](../data-model.md).
- “App” includes the built-in console and external scripts connected to the running application.
- “Batch” means a script launched with Heeler's `-x` option.

No public function is asynchronous from Python's perspective. Long operations block until the bridge returns or raises.
