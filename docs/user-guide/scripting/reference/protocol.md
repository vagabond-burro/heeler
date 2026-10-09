# Low-level protocol appendix

This page completes the reference for the variable `**fields` and `**params` accepted by `command()` and `rpc()`. Named package wrappers remain the preferred interface.

## HTTP request and response rules

The running app listens only on `127.0.0.1`. Connection discovery and the
`X-Heeler-Token` header use the same token shown by the scripting connection;
requests without the matching token are refused. Send one HTTP POST per
connection with a UTF-8 JSON object containing a nonempty `method` string
and optional `params`. The response closes the connection. The Python package
handles this transport for you.

The request body limit is **8 MiB (8,388,608 bytes)**. This counts JSON bytes,
including all decoded chunks when using `Transfer-Encoding: chunked`.
`Content-Length` requests over the limit are refused before the body is read.
Use either `Content-Length` or chunked encoding, never both. Duplicate length
headers and unsupported transfer encodings are refused. Headers, chunk size
lines and trailers share a **16 KiB (16,384 byte)** limit. Send the body
directly; `Expect: 100-continue` is not supported.

The complete request must arrive within **five seconds of acceptance**,
including its headers and body. Sending occasional bytes does not extend
that deadline. This is a request-upload deadline, not a limit on execution:
frontend calls retain their ten-second timeout, with ten minutes for
`stack.create`, `stack.bake` and `pano.create`, and one hour for `export.run`.
A response also has a five-second write deadline once it is ready to send.

| HTTP status | Meaning |
| --- | --- |
| 200 | A complete request reached the dispatcher. Check `ok` for method success or failure. |
| 400 | Malformed JSON, an invalid method field, truncated input or invalid HTTP framing. |
| 403 | Missing, incorrect or duplicate token header. |
| 405 | The request does not use POST. |
| 408 | The request read deadline expired. |
| 411 | Neither a content length nor chunked encoding is present. |
| 413 | The request body exceeds the limit. |
| 417 | An unsupported `Expect` header is present. |
| 431 | Headers or chunk framing exceed the metadata limit. |
| 503 | The dispatcher cannot accept the request. |

Responses use `Content-Type: application/json`. Success is
`{"ok":true,"data":...}`; errors are `{"ok":false,"error":"explanation"}`.
Malformed JSON names the parsing error and never dispatches an empty method.
The Python package reports HTTP refusal messages as `HeelerError` with the
app's explanation.

Socket reads and response writes run separately from the serial command
dispatcher. A client that stalls during upload or stops reading its response
does not block other accepted clients. At most **16 connections** are active;
excess connections are closed immediately. Complete requests enter a bounded
queue and execute one at a time in queue order. A long-running command can
therefore delay another command, even though socket stalls cannot.

Turning scripting off closes the listener and active sockets, cancels waits
for frontend replies and drops requests still queued. It does not undo a
command already dispatched or forcibly interrupt native rendering already
in progress. A disconnected script must check app state before retrying a
mutation because a command that already started may have completed.

## Scriptable `command()` types

The running app accepts the following command dictionaries. `command(type, **fields)` constructs `{"type": type, **fields}`.

| Type | Required and optional fields | Result |
|---|---|---|
| `set_param` | `id: str`, `param: str`, `value: number` | Set one numeric node parameter. |
| `set_params` | `id: str`, `values: dict[str, number]`; optional `text: dict[str, str]`, `harmonize: bool` | Set several numeric/text parameters as one command. |
| `set_curve` | `id: str`, `channel: str`, `curve: list[[x, y]]`; optional `tangents: list[number]` | Replace one node curve. |
| `set_text_param` | `id: str`, `param: str`, `value: str` | Set a text or enum parameter. |
| `connect` | `wire: {from, to, toPort, kind}` | Connect graph ports. |
| `disconnect` | `to: str`, `toPort: str` | Remove an input wire. |
| `splice_node_into_wire` | `id`, `from`, `to`, `toPort` | Insert an existing node into a wire. Field pass-through nodes insert into mask and alpha wires. |
| `extract_node` | `id: str` | Remove a node from its chain and heal around it. |
| `delete_nodes` | `ids: list[str]`; optional `heal: bool` | Delete selected nodes with optional neighbor healing. |
| `set_enabled` | `id: str`, `enabled: bool` | Enable or bypass a node. |
| `rename_node` | `id: str`, `name: str` | Rename a node. |
| `node_outside` | `id: str` | Build the masked node's Outside branch. |
| `set_node_tint` | `id: str`, `tint: str | None` | Set or clear node-card color. |
| `set_node_note` | `id: str`, `note: str` | Set the node note. |
| `select_nodes` | `ids: list[str]`; optional `additive: bool` | Change graph selection. |
| `group_selection` | `name: str`; optional `note: str` | Group the current node selection. |
| `add_region` | `id: str`, `region: dict` | Add one region to a selection-mask node. |
| `clear_regions` | `id: str` | Remove all regions from a selection-mask node. |
| `set_regions` | `id: str`, `regions: list[dict]` | Replace selection regions. |
| `set_rating` | `ids: list[str]`, `stars: int` | Rate catalog images. |
| `set_flag` | `ids: list[str]`, `flag: str` | Pick, reject, or clear catalog images. |
| `select_image` | `id: str` | Open an image. |
| `new_take` | optional `name: str`, `note: str` | Branch the current take. |
| `update_take` | `takeId: str`, `name: str`; optional `note: str` | Rename or annotate a take. |
| `switch_take` | `takeId: str` | Activate a take. |
| `delete_take` | `takeId: str` | Delete a take. |
| `set_prefs` | `prefs: dict` | Update preferences. |
| `set_mode` | `mode: str` | Switch workspace. |
| `begin_gesture` | `key: str` | Begin undo coalescing. |
| `end_gesture` | no fields | End undo coalescing. |

Batch accepts only `select_image`, `set_param`, `set_enabled`, `set_rating`, and `set_flag` from this table.

Selection-region dictionaries use normalized image coordinates. A path region has `kind="path"`, `op`, and `points`, with optional `smooth`, `via`, and `off`. A key region has `kind="key"`, `op`, `x`, `y`, `tolerance`, and optional `space`/`off`. Sample regions use `kind="samples"`, `op`, `points`, `tolerance`, and optional `space`/`off`. `op` is `replace`, `add`, `subtract`, or `intersect`.

## Bridge `rpc()` methods

| Method | Parameters | Returned data |
|---|---|---|
| `app.ping` | none | Protocol/app identification. |
| `app.state` | none | Session-state dictionary. |
| `app.open_folder` | `path` | Opened path, name, and image count. |
| `registry.nodes` | none | `{heeler, nodes}` registry manifest. |
| `graph.get` | none | Graph dictionary. |
| `graph.serialize` | none | App-internal serialized graph and image id. |
| `graph.command` | `command: dict` | Command acknowledgment. |
| `graph.save` | none | Save acknowledgment. Refuses, naming the photograph, when it has no edits saved by the app to update: open it in Heeler and change something once. |
| `catalog.images` | none | Catalog image list. |
| `catalog.collections` | none | Collection list. |
| `takes.list` | none | Take-list dictionary. |
| `prefs.get` | none | Preference dictionary. |
| `hotkeys.export` | none | `{json: str}`. |
| `hotkeys.import` | `json: str` | Import report. |
| `export.run` | `dir`, plus export settings | Export report. |
| `stack.create` | `ids`, `mode` | New library entry. |
| `stack.info` | `id` | Stack recipe. |
| `stack.configure` | `id`, optional recipe fields | Updated stack recipe. |
| `stack.bake` | `id`, optional `format`, `quality` | New baked library entry. |
| `pano.create` | `ids` | New panorama library entry. |
| `pano.info` | `id` | Panorama recipe. |
| `pano.configure` | `id`, optional recipe fields | Updated panorama recipe. |
| `render.preview` | optional `node`, `quality` | `{format, width, height, base64}`. |
| `noise.estimate` | none | Batch-only `{luma_sigma, chroma_sigma}`. |

`registry()` unwraps `registry.nodes["nodes"]`; `hotkeys_export()` unwraps the `json` field; `render()` decodes the `base64` field. Direct `rpc()` callers receive the unwrapped method `data` but must perform these additional transformations themselves.

Protocol names are additive but lower-level than the package wrappers. Code intended for long-term compatibility should prefer named functions and `registry()` discovery.
