# Graph editing: where Heeler stands, and what the incumbents know

"you need to educate yourself how nodes could be edited. I took a
glance, there is a long ways to go in Heeler." Sources studied: a leading
compositor's node-management documentation (the deepest node editor in
production use) and a leading color grader's node system. Per the standing
rule, the point is not to clone either: keep the vocabulary and the
load-bearing gestures, rethink the design.

## What the compositor teaches

The compositor's grammar has one premise: **everything on the canvas is a
manipulable object, including the pipes.** The interactions that follow
from it:

- **Add**: Tab, type a name, Return. Repeat last node with Tab+Return.
  Right-click an existing node adds downstream of it.
- **Insert into a pipe**: drag a node onto an existing connection; the
  pipe highlights; release and the node is spliced in. The single most
  load-bearing gesture in the editor.
- **Branch**: hold Shift while creating, and the node starts a new
  branch instead of extending the current path.
- **Replace**: hold Ctrl while creating, and the new node takes the
  selected node's place in the pipes.
- **Extract**: pull a node out of the tree; its neighbors reconnect
  around the hole. (Heeler's spliceOut does this internally already.)
- **Disconnect**: drag either end of a pipe to empty space, or SHAKE the
  node loose (sensitivity configurable).
- **Disable**: D key. Instant A/B of any node's contribution.
- **Rename**: N key, inline on the node.
- **Info**: I key, a diagnostics window per node.
- **Search**: `/` opens find-by-name with wildcards; selection follows.
- **Select upstream**: Ctrl+drag a node takes every contributor with it.
- **Clone vs copy**: a clone stays parameter-linked to its parent
  (edits propagate); a copy is independent. Ctrl+K / declone Alt+Shift+K.
- **Dots**: bend points for pipes, added by Ctrl+clicking the pipe, so a
  big script stays readable.
- **Organization**: node color, notes on the node face, backdrops,
  postage-stamp thumbnails (Alt+P), tool sets (named reusable subtrees).

## What the color grader teaches

The color grader's insight is different: **composition patterns are first-class,
typed, and one keystroke each.** You do not wire a parallel mix by hand;
you press Alt+P and the Parallel Mixer appears wired.

- Serial (Alt+S), Parallel (Alt+P), Layer (Alt+L): each a named
  STRUCTURE, not just a node.
- Layer mixers composite with blend modes, hierarchy inverted (lowest
  wins), which is its answer to a layer editor's layers inside a graph.
- The **Outside node** (Alt+O): duplicates a node and inverts its key,
  wired as its complement. Grade the face, press Alt+O, grade everything
  that is not the face. The pair stays a pair.
- Every node carries an RGB input/output AND a key input/output: masks
  are plumbing, not decoration.
- Labels on everything; icons on the node show which adjustments it
  carries; the culture is "as few nodes as possible, each named."

## What Heeler has today (honest inventory)

- Add: node palette (Shift+Space), fuzzy find, recents. Nodes splice
  into the chain automatically at a sensible point.
- Select: click, Shift-additive, marquee. Delete (Delete), Group
  (Ctrl+G), rename (inline), backdrops (add, move, resize, color).
- Enable/disable per node (checkbox in the inspector).
- Wires are DRAWN but not EDITABLE: there is no port-drag, no
  add_wire/remove_wire gesture, no insert-into-pipe, no branch, no
  extract-by-drag. Every wire is created by programmatic splicing
  (spliceIn/spliceOut, artWires, boundary wires). The graph view is a
  faithful display and a node-parameter editor, not yet a wiring editor.
- No disable hotkey, no node info, no search-in-graph, no dots, no
  clones, no upstream-select, no notes-on-node, no per-node thumbnails.

The gap is real, and it is also partly deliberate: Heeler's graph must
always be a VALID RENDER GRAPH for the engine, and Develop mode's 1:1
rule means most wiring happens through commands that keep the chain
coherent. Free-form wiring can produce graphs Develop mode cannot
represent. That tension needs a policy before the gestures are built,
not after.

## Status

Items 1-6 below are BUILT: insert-into-pipe and ALT-drag extract, D and
F2, mask-pipe port dragging (head handles included; clip ports stay
programmatic until the group-editing story), / search sharing the
thumbnail filter's matcher, Ctrl+U upstream (masks come along), Alt+O
Outside (one mask, both sides, through an Invert Mask node on the
canvas), node tints from the context menu and notes on the card edited
in the inspector. Clones (7) remain parked on the serialization design.

## Recommended order (assessment, pending the owner's priorities)

1. **Insert-into-pipe and extract-by-drag.** The two gestures that make
   a node editor feel like one. Splice logic already exists on both;
   this is exposing it to the hand. Low risk: both preserve graph
   validity by construction.
2. **Disable on D, rename on N, delete stays Delete.** Trivial, huge.
   Disable-toggle is the fastest A/B a grader has.
3. **Port-drag wiring for the ports that are safe**: mask and clip
   inputs (choosing which mask feeds which node is a real decision the
   UI currently makes for you). Image-chain rewiring stays
   command-driven until the Develop-mode policy question is answered.
4. **Search (`/`) and select-upstream.** Cheap, and graphs are already
   big enough to lose a node in.
5. **The color grader's Outside gesture**, adapted: duplicate a masked node with
   its mask inverted, as a paired command. Fits Heeler's mask system
   exactly and no incumbent's photo editor has it.
6. **Notes and node color.** Organization debt; backdrops carry some
   of this today.
7. **Clones (parameter-linked copies)**: powerful but interacts with
   serialization, undo and the sidecar format; needs its own design
   pass. Defer.

Not adopted, deliberately: postage stamps (per-node thumbnails mean
per-node renders; the viewer already shows the one render that
matters), multi-view plumbing, tool sets (groups + recipes cover the
need here).
