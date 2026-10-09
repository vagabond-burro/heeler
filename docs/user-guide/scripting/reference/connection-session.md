# Connection and session reference

## `HeelerError`

```python
class heeler.HeelerError(RuntimeError)
```

The package's bridge exception. It is raised when the app refuses a method or command, the bridge cannot be discovered, authentication fails, the local HTTP request fails, or the server returns an unsuccessful response.

**Arguments:** inherited from `RuntimeError`; the package raises it with one message string.

**Return value:** not applicable.

```python
try:
    heeler.ping()
except heeler.HeelerError as error:
    print(error)
```

Local file and Python errors are not wrapped automatically. For example, writing a rendered file can raise `OSError`.

## `connect()`

```python
heeler.connect(port: int | None = None, token: str | None = None)
```

Resolves or explicitly sets the module's bridge connection. Ordinary scripts can omit this call because the first API operation connects lazily.

**Arguments**

- `port`: local bridge TCP port. It is used explicitly only when both `port` and `token` are not `None`.
- `token`: bridge authentication token. It is used explicitly only when both arguments are supplied.

If either explicit argument is missing, resolution checks the `HEELER_API_PORT` and `HEELER_API_TOKEN` environment variables, then `~/.heeler/api.json`.

**Returns:** the imported `heeler` module itself. This preserves the older `h = heeler.connect(); h.ping()` style.

**Raises:** `HeelerError` when discovery fails. Invalid discovery JSON, missing keys, or a nonnumeric port can also raise their corresponding Python parsing exceptions.

**Availability:** app, external, and batch.

```python
h = heeler.connect(49200, "session-token")
print(h.ping())
```

## `disconnect_bridge()`

```python
heeler.disconnect_bridge()
```

Forgets the cached connection. It does not stop the app's bridge. The next API call performs discovery again.

**Arguments:** none.

**Returns:** `None`.

**Raises:** none under normal operation.

**Availability:** app, external, and batch.

## `rpc()`

```python
heeler.rpc(method: str, _timeout: float | None = 30, **params)
```

Makes one low-level bridge request. All higher-level package functions ultimately call this function.

**Arguments**

- `method`: protocol method name, such as `"app.ping"` or `"graph.get"`.
- `_timeout`: local HTTP timeout in seconds. `None` disables the urllib timeout. The leading underscore prevents collision with a protocol parameter named `timeout`.
- `**params`: JSON-serializable method parameters.

**Returns:** the response's `data` value, converted from JSON. If a successful response omits `data`, returns `None`.

**Raises**

- `HeelerError` when discovery, transport, authentication, protocol dispatch, or the remote operation fails.
- `TypeError` when parameters cannot be JSON serialized.
- JSON-related exceptions if a malformed non-Heeler service answers the local port.

**Availability:** depends on the method. See [API support matrix](../support-matrix.md).

```python
raw = heeler.rpc("app.state")
```

Use the named wrappers when one exists. `rpc()` is a protocol escape hatch and has fewer compatibility guarantees than the public wrappers.

## `ping()`

```python
heeler.ping()
```

Checks that the bridge is reachable and authenticated.

**Arguments:** none.

**Returns:** app mode returns `{"heeler": 1, "app": "heeler"}`. Batch also includes `"mode": "batch"`.

**Raises:** `HeelerError` on any connection or authentication failure.

**Availability:** app, external, and batch.

```python
if heeler.ping()["heeler"] == 1:
    print("connected")
```

## `state()`

```python
heeler.state()
```

Returns a compact description of the current session.

**Arguments:** none.

**Returns:** dictionary with:

- `imageId`: active catalog id or `None`.
- `imageName`: active filename or `None`.
- `mode`: `"simple"`, `"advanced"`, `"canvas"`, or `"batch"`.
- `tool`: active app tool; app only and absent in batch.

**Raises:** `HeelerError` on bridge failure.

**Availability:** app, external, and batch.

```python
session = heeler.state()
print(session["imageName"], session["mode"])
```
