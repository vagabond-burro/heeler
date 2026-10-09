# Registry and graph reference

## `registry()`

```python
heeler.registry()
```

Returns the engine's complete node-type registry.

**Arguments:** none.

**Returns:** `list[dict]`. Each node specification contains `type`, `label`, `version`, `params`, `inputs`, and `outputs`. Each numeric parameter contains `name`, `default`, `min`, `max`, `hard_min`, and `hard_max`. See [Registry node specification](../data-model.md#registry-node-specification).

**Raises:** `HeelerError` on bridge failure.

**Availability:** app, external, and batch.

```python
for spec in heeler.registry():
    print(spec["type"], [p["name"] for p in spec["params"]])
```

## `graph()`

```python
heeler.graph()
```

Returns the active image's graph.

**Arguments:** none.

**Returns:** a dictionary with `nodes`, `wires`, and `selection`. App results include UI card fields; batch reads the flattened embedded render graph and returns an empty selection. See [Graph](../data-model.md#graph).

**Raises:** `HeelerError`, including when batch has no open image.

**Availability:** app, external, and batch.

## `nodes()`

```python
heeler.nodes()
```

Convenience equivalent to `heeler.graph()["nodes"]`.

**Arguments:** none.

**Returns:** `list[dict]` containing the current graph's nodes.

**Raises:** the same exceptions as `graph()`.

**Availability:** app, external, and batch.

```python
exposure = next(n for n in heeler.nodes() if n["type"] == "heeler.exposure")
```

## `command()`

```python
heeler.command(type: str, **fields)
```

Dispatches a raw command through the scriptable command whitelist.

**Arguments**

- `type`: command type, such as `"set_param"`, `"set_curve"`, or `"set_node_note"`.
- `**fields`: JSON-serializable fields required by that command.

**Returns:** app usually returns `{"dispatched": type}`. Batch return values depend on its smaller command implementation; `select_image` returns `{"opened": id}` and supported mutations return a dispatched dictionary.

**Raises:** `HeelerError` when the command is not scriptable, arguments are refused, or the current mode does not implement it. Can raise `TypeError` for non-serializable fields.

**Availability:** app supports the public command whitelist. Batch supports only `select_image`, `set_param`, `set_enabled`, `set_rating`, and `set_flag`.

```python
heeler.command("set_node_note", id="curves", note="Client contrast")
```

The named wrappers below are preferred. The raw command schema follows the app reducer and can grow between versions.

## `set_param()`

```python
heeler.set_param(node: str, param: str, value: float)
```

Sets one numeric parameter on a node.

**Arguments**

- `node`: node id from `nodes()`.
- `param`: numeric parameter name valid for that node.
- `value`: integer or float value.

**Returns:** `{"dispatched": "set_param"}`.

**Raises:** `HeelerError` when no image is open, the node or parameter is invalid, or the command is refused. Hard-limited values are clamped by the server rather than rejected where supported.

**Availability:** app, external, and batch.

```python
heeler.set_param("exposure", "exposure", 0.7)
```

## `connect_nodes()`

```python
heeler.connect_nodes(
    source: str,
    target: str,
    port: str = "in",
    kind: str = "image",
)
```

Connects a source node's output to a target input using the graph's legality checks.

**Arguments**

- `source`: source node id.
- `target`: target node id.
- `port`: target port, normally `"in"`, `"in2"`, `"mask"`, or `"clip"`.
- `kind`: `"image"` or `"mask"`.

**Returns:** `{"dispatched": "connect"}`.

**Raises:** `HeelerError` for missing nodes, incompatible ports, cycles, or unsupported mode.

**Availability:** app and external; not batch.

```python
heeler.connect_nodes("luma_mask", "color_balance", port="mask", kind="mask")
```

## `disconnect()`

```python
heeler.disconnect(target: str, port: str = "in")
```

Removes the wire feeding one target input.

**Arguments**

- `target`: receiving node id.
- `port`: input port to disconnect.

**Returns:** `{"dispatched": "disconnect"}`.

**Raises:** `HeelerError` when the target or command is refused.

**Availability:** app and external; not batch.

## `rename()`

```python
heeler.rename(node: str, name: str)
```

Changes a node card's user-facing name.

**Arguments:** `node` is the node id; `name` is the new nonempty display name.

**Returns:** `{"dispatched": "rename_node"}`.

**Raises:** `HeelerError` for an invalid node, name, or unsupported mode.

**Availability:** app and external; not batch.

## `enable()`

```python
heeler.enable(node: str, enabled: bool = True)
```

Enables or bypasses a node without deleting its settings or connections.

**Arguments**

- `node`: node id.
- `enabled`: `True` to enable; `False` to bypass.

**Returns:** `{"dispatched": "set_enabled"}`.

**Raises:** `HeelerError` when no image is open or the node is invalid.

**Availability:** app, external, and batch.

## `outside()`

```python
heeler.outside(node: str)
```

Performs the graph's Outside operation: copies the selected grade behind itself and drives the copy with the same mask inverted through an Invert Mask node.

**Arguments:** `node` is the id of a node that already has a mask input.

**Returns:** `{"dispatched": "node_outside"}`.

**Raises:** `HeelerError` if the node is missing, unmasked, unsuitable, or the mode is unsupported.

**Availability:** app and external; not batch.
