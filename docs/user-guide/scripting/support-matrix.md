# API support matrix

The built-in console and an external script connected to the app have the same capabilities. Batch mode has no live UI reducer and therefore supports a smaller, deliberate subset.

| Area | Functions | App / external | Batch |
|---|---|---:|---:|
| Connection | `connect`, `disconnect_bridge`, `rpc`, `ping` | Yes | Yes |
| Session reads | `state` | Yes | Yes |
| Registry | `registry` | Yes | Yes |
| Graph reads | `graph`, `nodes` | Yes | Yes |
| Basic saved-graph edits | `set_param`, `enable` | Yes | Yes |
| Graph structure | `connect_nodes`, `disconnect`, `rename`, `outside`, raw structural `command` calls | Yes | No |
| Catalog | `images`, `rate`, `flag`, `open_image`, `collections` | Yes | Yes |
| Save | `save` | Automatic acknowledgment | Yes, writes graph |
| Render | `render` | Yes, including intermediate node | Yes, final graph only |
| Undo gestures | `begin_gesture`, `end_gesture`, `one_undo` | Yes | No |
| Take reads | `takes` | Yes | Yes |
| Take changes | `new_take`, `switch_take`, `rename_take`, `delete_take` | Yes | No |
| Export | `export_images` | Yes | Yes |
| Stacks and panoramas | `stack_*`, `pano_*` | Yes | No |
| Preferences and hotkeys | `prefs`, `set_prefs`, `hotkeys_export`, `hotkeys_import` | Yes | No |
| UI control | `open_folder`, `set_mode` | Yes | No |

`command()` and `rpc()` are escape hatches. Their availability depends on the command or method passed, not merely on the wrapper itself. Batch mode accepts only `select_image`, `set_param`, `set_enabled`, `set_rating`, and `set_flag` through `graph.command`.

When a function is unsupported, it raises `HeelerError`; it does not partially execute.
