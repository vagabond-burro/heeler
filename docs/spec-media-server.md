# Spec: served views (the local media server)

From an early tester: "I dump everything into [my RAW editor]... it's all so one way.
If I could pick a slice - eg iPhone photos taken by the fam - and serve
that up locally it'd be a killer feature. It's a view into the catalog
so it can be independent."

The tester's framing is the design: a served view is a READ-ONLY slice
of the catalog exposed over local HTTP. Nothing about serving may
disturb editing, and nothing served may write back.

## v1: serve a collection (this milestone)

- Entry point: a collection's context menu, "Serve on network...".
  One collection served at a time; serving another replaces it.
- On start, Heeler SNAPSHOTS the collection (ids, names, order) and
  pre-renders each member through its own saved graph to JPEG in a
  serve cache (keyed by image id + graph file mtime, so unchanged
  photos never re-render). The HTTP thread then serves only files and
  in-memory data: it holds no catalog connection and no engine handle,
  which makes the no-interference guarantee structural rather than
  polite. Refreshing the slice = restarting the share; live views are
  v2's problem.
- Server: `tiny_http` (small, MIT, no async runtime), one thread,
  bound to 0.0.0.0 on an OS-assigned port unless configured.
- Every URL carries a random token minted at start:
  - `/t/{token}/` - gallery page (self-contained HTML, no CDN)
  - `/t/{token}/manifest.json` - names, ids, dimensions
  - `/t/{token}/img/{id}.jpg` - the rendered photograph
  - `/t/{token}/thumb/{id}.jpg` - small preview for the grid
  Wrong or missing token: 404, not 403 (nothing to enumerate).
- Exports from the share carry the same EXIF/ICC treatment as the
  export panel's files: rendered JPEGs are the export pipeline's
  output, metadata kept.
- UI: a banner above Collections while serving: name, URL, STOP.
  Serving state is app-session-local; quitting Heeler stops it.

## Boundaries (as much a feature as the endpoints)

- No write endpoints of any kind. No upload, no rating, no delete.
- Off unless started. No autostart preference in v1.
- Pro only. A share running when the copy
  stops being Pro (a key is removed or the store refuses it) is stopped,
  with the reason in the status line and the console, rather than
  left frozen at its last frame (2026-09-08: a frozen page "would
  seem like a bug"). Serving again meets the upgrade prompt.
- LAN only by intent: no TLS, no auth beyond the token, and the UI
  says so ("anyone on your network with this link can view").

## v2: headless serve (BUILT)

`heeler serve <catalog> --collection NAME` runs the same
snapshot-and-serve model with no GUI: the installed binary doubles as
the server (src-tauri/src/headless.rs, routed in main.rs before Tauri
ever starts). The port promise held: the renderer is render_export
over decode_any_with, the graphs are the same per-image files the app
saves, and serve::start is byte-for-byte the v1 server.

- Without --collection it lists the catalog's collections and how to
  serve one. Flags: --port, --max-edge (default 2560, 0 = full),
  --graphs, --cache.
- Members with no saved edits render through a bare source-to-output
  graph (the photograph as decoded) and the CLI says so, pointing at
  --graphs for the not-the-editing-machine case. Deliberately NOT a
  copy of the frontend's default look: one recipe, one home.
- Stacks and panoramas are skipped by name: their merge pipeline is
  session-bound today.
- Node-locked builds stay locked headless: license::headless_gate
  checks the same installed license before serving.
- Windows release builds attach to the parent console so the URL
  actually prints from a terminal.

## v3: live shares and static galleries

"Would it be possible to have an option that when broadcasting
that it refreshes when an image updates? What if I want someone to
view the edits from a browser on their ipad." And, from a
photographer missing his old gallery tool: "pushing out pre-made web
galleries that were ready for upload to our web site."

Both ride the v1 architecture unchanged, and the no-interference
guarantee SURVIVES: the server still holds no catalog and no engine.

- The manifest gains a per-image `v` (version) and a `live` id. The
  gallery page polls the manifest every couple of seconds and
  re-fetches only images whose version moved (cache-busting query).
  Polling, not push: it works in every browser including the iPad's,
  survives sleep/wake, and asks nothing exotic of tiny_http.
- The APP re-renders an edited image into the snapshot folder once the
  edit settles (debounced past the gesture), atomically, then bumps
  the version. The server never renders; files arrive in its folder.
- Off by default: the LIVE chip on the share banner opts in, because
  re-rendering while editing is a cost someone should choose.
- `/t/{token}/live` is the proofing page: whatever photo is active in
  Heeler, full screen, refreshing as edits land. The client on the
  sofa watches the edit happen.
- Export Web Gallery: the same snapshot pipeline writes index.html,
  thumbs/ and img/ into a chosen folder, relative paths, no token, no
  polling: a static site ready for any host. One generator serves both
  the share and the export, parametrized by base path and liveness.

## v4 and beyond (design for, do not build)

- Saved filter queries as live views, if pushing into the snapshot
  ever proves too narrow.
- Multiple simultaneous views, per-view tokens.
- Gallery templates beyond the house look; title, columns and thumb
  size options first.
- Headless stacks/panoramas once their render path drops its session
  coupling.
- Casting/DLNA if anyone asks twice.
