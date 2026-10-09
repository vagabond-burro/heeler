# Spec: the Python API (and the bridge underneath it)

"I see the API to be largely an API to manage nodes, since that is
the underlying architecture." Correct, and the architecture hands us
the design: Heeler already routes every mutation through one command
bus (the Command union and its reducers), with validation, undo and
serialization built in. The API is not a second way to edit; it is a
remote hand on the same bus the UI uses.

Shiba proved this layout next door: shiba-bridge is an MCP server over
the engine's command bus, every edit undoable, every tool
contract-tested, and an agent drives the editor as readily as a human.
Heeler follows it.

## One bridge, two doors

A single bridge surface exposes commands and queries. Two doors into
it:

1. **Python package** (`heeler`): a thin client over local JSON-RPC on
   loopback, token-authenticated, served by the running app (the serve
   module already establishes the pattern of an in-app server).
   Pythonic wrappers, discoverable params, docstrings generated from
   the node registry.
2. **MCP server** for agents: the same handlers presented as MCP tools
   over stdio, so any MCP-speaking agent (Claude Code and friends) gets
   the identical vocabulary. See spec-agentic.md.

Parity is structural: both doors dispatch the same Commands and read
the same state snapshots, so nothing is scriptable that the UI cannot
do, and vice versa. Script actions land in the same undo history the
user sees, batched through the existing gesture mechanism so one
logical operation is one undo step.

## Categories

the owner's list, refined:

- **Graph** (was "Node"): nodes, wires, params, groups, takes.
  `graph.add(type)`, `connect`, `disconnect`, `splice`, `extract`,
  `set_param`, `outside(node)`, notes and tints, takes and versions.
  The node REGISTRY exports machine-readable (types, params, ranges,
  port kinds, blurbs): it powers Python introspection and the agent's
  tool manifest alike.
- **Catalog**: folders, images, ratings, flags, collections, EXIF,
  filters. Read-heavy; writes are the same commands the ribbon uses.
- **Render** (missing from the original list, and essential): render
  the active graph to bytes at a chosen size, sample pixels, request
  a mask render. Automation is blind without it, and it is how an
  agent judges its own work, which shiba showed is the difference
  between an agent that builds and one that builds correctly.
- **Export**: the batch pipeline as callable: presets, naming
  templates, destinations, the same ICC and EXIF treatment.
- **Stack**: HDR and panorama merges: create, configure, bake.
- **Settings**: preferences, tool settings, hotkeys.
- **App**: session control: open folder, active image, mode. Small on
  purpose.

## Ground rules

- The app owns state; scripts are clients. No second writer, no
  bypassing the reducers, no reaching into the catalog file directly.
- Every mutation validates exactly as the UI's would (cycles, port
  kinds, occupancy) and refuses the same ways. Refusals return the
  reason; the notice system already words them.
- Versioned protocol from day one: `{"heeler": 1, ...}` envelope.
- Headless later: the same bridge behind `heeler --headless` covers
  batch Python without the GUI and aligns with the media server's v2
  headless story. Not v1.

## Status

Items 1-3 are BUILT: the registry manifest (Rust-side, authoritative,
with both ranges), the bridge (api.rs: loopback tiny_http, token,
native ping/registry/render, frontend forwarding through the
heeler-api event into handleApi and the reducers), and the Python
client (tools/python/heeler.py, stdlib-only, contract-tested against a
stub). Off by default behind Preferences > Scripting; discovery at
~/.heeler/api.json. The MCP door (4) is not built and waits on the
agentic discussion.

The CONSOLE is built on top: the Console panel's PYTHON tab runs the
system Python through a JSON-line driver (py.rs + tools/python/
driver.py), with the client preloaded and the bridge's port and token
handed over in HEELER_API_PORT / HEELER_API_TOKEN (the client checks
the environment before the discovery file). One persistent namespace;
a block answers with its last expression's value, Jupyter-style.
Opening the tab ensures the bridge is running; the console holds no
private door.

REVISED per (2026-08-16): the surface is FUNCTIONAL, in a compositor's style.
`import heeler` and the module is the session; module-level functions,
no client class (`connect()` survives only as an explicit-target
escape hatch that returns the module). Connection is lazy: env vars
(console, batch) then the discovery file. And BATCH MODE is built:
`Heeler.exe -x script.heeler [--catalog PATH]` (batch.rs) runs a
script windowless against a native bridge session: catalog list, rate,
flag, open_image loads the saved graph, set_param/enable edit it
(set_param clamps to the registry's hard limits, the same
zero-or-unbounded rule the app's fields apply), graph.save writes it
back through the app's revision gate (and refuses for a photograph the
app has never saved edits for, since the bare pass-through has no
editor shape to write), render.preview renders natively. View-shaped methods refuse by
naming batch mode. Exit code 0/1 mirrors the
script, for .bat chains. User-facing wording is "scripting", not
"API" (the Preferences label and the guide's Scripting pages).

The editor half is a SCRATCHBOARD with tabs, in the style of a 3D package's script editor:
highlight-and-Ctrl+Enter runs a selection (caret line when nothing is
selected), Run runs the active tab, Open/Save/Save-as round-trip tabs
to .heeler/.py files on disk, and the whole tab set persists to
localStorage on every keystroke so a crash loses nothing. Syntax
coloring is a small in-house tokenizer under a transparent textarea.

## Order of work

1. Registry export (machine-readable node manifest). Small, unblocks
   everything, useful to the docs too.
2. The bridge: JSON-RPC loopback server, command dispatch + snapshot
   queries + render-to-bytes.
3. The Python package: generated wrappers over it.
4. MCP door (see spec-agentic.md).
