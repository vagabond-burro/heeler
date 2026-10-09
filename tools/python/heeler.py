"""Heeler scripting: a remote hand on the app's command bus.

The module is the session, the way a compositor's own module is inside it: import it
and call functions, no client object to construct. The connection
happens lazily on the first call: environment first (HEELER_API_PORT /
HEELER_API_TOKEN, which is how the in-app console and batch mode hand
their interpreter the wiring), then the discovery file the app writes
at ~/.heeler/api.json while scripting is enabled.

Zero dependencies on purpose: urllib and json, nothing to install
beyond this file. Everything a script does goes through the same
commands and the same validation as the app's own UI, and lands in the
same undo history: one Ctrl+Z in the app removes what a script just
did.

    import heeler

    print(heeler.state()["imageName"])
    heeler.set_param("exposure", "exposure", 0.7)
    for img in heeler.images():
        if img["stars"] >= 4:
            heeler.flag(img["id"], "pick")
    heeler.render("out.jpg")
"""

from __future__ import annotations

import base64
import contextlib
import json
import math
import os
import urllib.error
import urllib.request

__all__ = [
    "HeelerError", "connect", "disconnect_bridge", "rpc", "ping", "state",
    "registry", "graph", "nodes", "command", "set_param", "connect_nodes",
    "disconnect", "rename", "enable", "outside", "images", "rate", "flag",
    "open_image", "save", "render",
    "begin_gesture", "end_gesture", "one_undo",
    "takes", "new_take", "switch_take", "rename_take", "delete_take",
    "export_images",
    "stack_create", "stack_info", "stack_configure", "stack_bake",
    "pano_create", "pano_info", "pano_configure",
    "prefs", "set_prefs", "hotkeys_export", "hotkeys_import",
    "open_folder", "set_mode", "collections",
]


class HeelerError(RuntimeError):
    """The app refused or the bridge is unreachable, with the reason."""


# The one connection, module-level: (url, token) once resolved.
_session: tuple[str, str] | None = None


def _discovery_path() -> str:
    home = os.environ.get("USERPROFILE") or os.path.expanduser("~")
    return os.path.join(home, ".heeler", "api.json")


def connect(port: int | None = None, token: str | None = None):
    """Points the module at a bridge explicitly. Never needed in the
    normal case: the first call connects by itself. Returns the module,
    so old `h = heeler.connect()` scripts keep working."""
    global _session
    if port is not None and token is not None:
        _session = (f"http://127.0.0.1:{port}/rpc", token)
        return _sess_module()
    env_port = os.environ.get("HEELER_API_PORT")
    env_token = os.environ.get("HEELER_API_TOKEN")
    if env_port and env_token:
        _session = (f"http://127.0.0.1:{int(env_port)}/rpc", env_token)
        return _sess_module()
    try:
        with open(_discovery_path(), "r", encoding="utf-8") as f:
            info = json.load(f)
    except OSError as e:
        raise HeelerError(
            "No running bridge found. Start Heeler and enable "
            "Preferences > Scripting > Python."
        ) from e
    _session = (f"http://127.0.0.1:{int(info['port'])}/rpc", str(info["token"]))
    return _sess_module()


def _sess_module():
    import sys

    return sys.modules[__name__]


def disconnect_bridge():
    """Forgets the connection; the next call reconnects fresh."""
    global _session
    _session = None


def rpc(method: str, _timeout: float | None = 30, **params):
    """One bridge call: raises HeelerError with the app's own wording on
    refusal, returns the data otherwise. The building block under every
    function here. _timeout is seconds; the long jobs (export, merges)
    pass a horizon sized to the work, because the default thirty exists
    to fail a wedged bridge, not to cut an honest batch off."""
    if _session is None:
        connect()
    url, tok = _session  # type: ignore[misc]
    body = json.dumps({"method": method, "params": params}).encode()
    req = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": "application/json", "X-Heeler-Token": tok},
    )
    try:
        with urllib.request.urlopen(req, timeout=_timeout) as resp:
            out = json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        # Transport refusals carry the same error envelope as method failures.
        # Bound error reads even if a different service answers this port.
        try:
            with e:
                error = json.loads(e.read(16384).decode()).get("error")
        except (OSError, ValueError, AttributeError):
            error = None
        raise HeelerError(error if isinstance(error, str) else f"bridge refused request: HTTP {e.code}") from e
    except OSError as e:
        raise HeelerError(f"bridge unreachable: {e}") from e
    if not out.get("ok"):
        raise HeelerError(out.get("error", "unknown error"))
    return out.get("data")


# -- app --------------------------------------------------------------

def ping():
    return rpc("app.ping")


def state():
    """The session: active image, mode, tool."""
    return rpc("app.state")


# -- registry ---------------------------------------------------------

def registry():
    """Every node type the engine knows: params, ranges, ports."""
    return rpc("registry.nodes")["nodes"]


# -- graph ------------------------------------------------------------

def graph():
    """The active image's graph: nodes, wires, selection."""
    return rpc("graph.get")


def nodes():
    return graph()["nodes"]


def command(type: str, **fields):
    """Dispatches one scriptable command through the app's own
    reducers. The building block the wrappers below use."""
    return rpc("graph.command", command={"type": type, **fields})


def set_param(node: str, param: str, value: float):
    return command("set_param", id=node, param=param, value=value)


def connect_nodes(source: str, target: str, port: str = "in", kind: str = "image"):
    return command(
        "connect", wire={"from": source, "to": target, "toPort": port, "kind": kind}
    )


def disconnect(target: str, port: str = "in"):
    return command("disconnect", to=target, toPort=port)


def rename(node: str, name: str):
    return command("rename_node", id=node, name=name)


def enable(node: str, enabled: bool = True):
    return command("set_enabled", id=node, enabled=enabled)


def outside(node: str):
    """The Alt+O gesture: the node's complement, sharing its mask."""
    return command("node_outside", id=node)


# -- catalog ----------------------------------------------------------

def images():
    return rpc("catalog.images")


def rate(image_ids, stars: int):
    ids = [image_ids] if isinstance(image_ids, str) else list(image_ids)
    return command("set_rating", ids=ids, stars=stars)


def flag(image_ids, flag: str):
    ids = [image_ids] if isinstance(image_ids, str) else list(image_ids)
    return command("set_flag", ids=ids, flag=flag)


def open_image(image_id: str):
    return command("select_image", id=image_id)


def save():
    """Batch mode: writes the open image's edited graph back to disk.
    Inside the app, saving is automatic and this is not needed."""
    return rpc("graph.save")


# -- render -----------------------------------------------------------

def render(path: str | None = None, node: str = "output", quality: int = 92):
    """Renders the active image through its live graph. With a path,
    writes the JPEG and returns (width, height); without, returns the
    raw bytes."""
    out = rpc("render.preview", node=node, quality=quality)
    data = base64.b64decode(out["base64"])
    if path:
        with open(path, "wb") as f:
            f.write(data)
        return (out["width"], out["height"])
    return data


# -- undo batching ------------------------------------------------------

def begin_gesture(key: str):
    """Starts one undo step. Every edit inside that shares the key
    coalesces into a single Ctrl+Z, the same coalescing a slider drag
    gets. The key names the control being driven: for set_param it is
    f"{node}.{param}". Always pair with end_gesture, or use one_undo."""
    return command("begin_gesture", key=key)


def end_gesture():
    return command("end_gesture")


@contextlib.contextmanager
def one_undo(key: str):
    """A with block that is one undo step:

        with heeler.one_undo("exposure.exposure"):
            for ev in (0.1, 0.2, 0.3):
                heeler.set_param("exposure", "exposure", ev)
    """
    begin_gesture(key)
    try:
        yield
    finally:
        end_gesture()


# -- takes --------------------------------------------------------------

def takes():
    """The open image's takes: {"takes": [{id, name, note}], "active"}.
    Batch mode lists them from the saved document; creating, switching
    and deleting are app-door work."""
    return rpc("takes.list")


def new_take(name: str | None = None, note: str | None = None):
    """Branches the open image: the current edit stays as its take and a
    copy becomes the active one. History is per-take, so takes manage
    themselves rather than sitting in the undo stack."""
    fields = {}
    if name is not None:
        fields["name"] = name
    if note is not None:
        fields["note"] = note
    return command("new_take", **fields)


def switch_take(take_id: str):
    """Makes another take the live edit, snapshotting the current one."""
    return command("switch_take", takeId=take_id)


def rename_take(take_id: str, name: str, note: str | None = None):
    return command(
        "update_take", takeId=take_id, name=name, **({"note": note} if note is not None else {})
    )


def delete_take(take_id: str):
    """Removes one take. The last one refuses: a photograph always has
    at least the edit you are looking at."""
    return command("delete_take", takeId=take_id)


# -- export -------------------------------------------------------------

def export_images(
    dest: str,
    ids=None,
    format: str = "jpeg",
    quality: int = 92,
    max_edge: int | None = None,
    template: str = "{name}",
    keep_metadata: bool = True,
    matte: bool = False,
    dpi: float | None = None,
):
    """The Export panel as a call: dest is the destination folder, ids a
    list of image ids (the selection or the open image when omitted).
    format is jpeg, webp, png, png16, tiff or dng; max_edge caps the
    long side in px (None is full size); template is the naming pattern
    ({name}, {n}, {stars}, {flag}); keep_metadata carries EXIF across;
    matte puts the Smart mask into the alpha channel (png, png16, tiff).
    dpi declares print resolution, 300 when omitted or non-finite, without resizing.

    Returns {"written": [paths], "failed": [{"name", "error"}]}: one bad
    image never stops the run. Works in batch mode too."""
    params = {
        "dir": dest,
        "format": format,
        "quality": quality,
        "maxEdge": max_edge,
        "template": template,
        "keepMetadata": keep_metadata,
        "matte": matte,
    }
    # Non-finite values are not JSON numbers. The bridge owns the default.
    if dpi is not None and math.isfinite(dpi):
        params["dpi"] = dpi
    if ids is not None:
        params["ids"] = [ids] if isinstance(ids, str) else list(ids)
    return rpc("export.run", _timeout=3600, **params)


# -- stacks and panoramas ----------------------------------------------

def stack_create(ids, mode: str):
    """Merges frames into one stack, the Photo menu's Merge as a call.
    mode is hdr, mean, median or max. Returns the new library entry.
    App door only; batch mode refuses by name."""
    return rpc("stack.create", _timeout=600, ids=list(ids), mode=mode)


def stack_info(image_id: str):
    """A stack's recipe: mode, align, members, and any members the
    folder no longer has. Raises for an ordinary photograph."""
    return rpc("stack.info", id=image_id)


def stack_configure(image_id: str, mode=None, align=None, members=None):
    """Rewrites a stack's recipe without rebaking it: pass only what
    changes. Returns the updated info."""
    params = {"id": image_id}
    if mode is not None:
        params["mode"] = mode
    if align is not None:
        params["align"] = align
    if members is not None:
        params["members"] = list(members)
    return rpc("stack.configure", _timeout=600, **params)


def stack_bake(image_id: str, format: str = "dng", quality: int = 92):
    """Bakes a merge or panorama to a real file beside its frames:
    dng (the default, keeps the merged range), tiff or jpg. Returns the
    new library entry."""
    return rpc("stack.bake", _timeout=600, id=image_id, format=format, quality=quality)


def pano_create(ids):
    """Stitches frames into a panorama, the Photo menu's Stitch as a
    call. Returns the new library entry; the stitch itself runs when
    the panorama is opened."""
    return rpc("pano.create", _timeout=600, ids=list(ids))


def pano_info(image_id: str):
    """A panorama's recipe: surface, gain compensation, straighten,
    bands, members, and any the folder no longer has."""
    return rpc("pano.info", id=image_id)


def pano_configure(
    image_id: str,
    surface=None,
    gain_compensation=None,
    straighten=None,
    bands=None,
    members=None,
):
    """Rewrites a panorama's recipe: surface is auto, cylindrical,
    spherical or planar. Pass only what changes; returns the updated
    info."""
    params = {"id": image_id}
    if surface is not None:
        params["surface"] = surface
    if gain_compensation is not None:
        params["gainCompensation"] = gain_compensation
    if straighten is not None:
        params["straighten"] = straighten
    if bands is not None:
        params["bands"] = bands
    if members is not None:
        params["members"] = list(members)
    return rpc("pano.configure", _timeout=600, **params)


# -- settings -----------------------------------------------------------

def prefs():
    """The app's preferences, as the Preferences panel holds them."""
    return rpc("prefs.get")


def set_prefs(**fields):
    """Writes preferences by name, the panel's own command:
    set_prefs(quickQuality=85, backupEveryDays=7). Unknown names are the
    reducer's to refuse, not the client's."""
    return command("set_prefs", prefs=fields)


def hotkeys_export():
    """The hotkey map as versioned JSON text, the same shape the
    Preferences panel writes to a file."""
    return rpc("hotkeys.export")["json"]


def hotkeys_import(text: str):
    """Reads a hotkey map back. Unknown command ids are dropped and
    reported, never kept: they would claim keys bound to nothing.
    Returns {"imported": n, "dropped": [ids]}."""
    return rpc("hotkeys.import", json=text)


# -- app control --------------------------------------------------------

def open_folder(path: str):
    """Opens a folder in the library, the ribbon and tree following, the
    way OPEN... does. App door only; batch mode already sees the whole
    catalog and refuses by name."""
    return rpc("app.open_folder", _timeout=120, path=path)


def set_mode(mode: str):
    """The session's mode: simple, advanced or canvas."""
    return command("set_mode", mode=mode)


def collections():
    """The catalog's collections: [{id, name, count, hasLook}]."""
    return rpc("catalog.collections")
