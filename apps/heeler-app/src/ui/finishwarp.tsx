// The Finish tab's warps (2026-09-30: "build both, A for image layers
// and B for the photo"): a Warp layer, which bends everything below it
// in the stack, its mask the part that moves, and an image layer's own
// warp, which bends the layer's picture before it is placed.
//
// Both are one engine node (heeler.layer_warp) and both are edited by
// the Develop warps' own sections, GridWarpControls and ShapeWarpControls,
// aimed at the node by `target`, so the grid, the shapes, the wheel and
// the pad are the same controls wherever a warp lives.
//
// Compact (2026-09-30: "Warp layer is too big, too much stack and redundant controls.
// This layer should by default look like a pixel layer (in size), with an additional
// button to go into edit mode which then expands to show the controls. The first
// control is type: Either GRID or SHAPES."). Then (2026-09-30): "I think we can remove
// the EDIT WARP button, when the layer is expanded it should just turn on warp editing.
// Turn warp editing off when collapsed". So a Warp layer has no button: opening its
// settings (the chevron, or selecting it with Expand settings on select on) arms edit
// mode, closing them puts it down. Edit mode is the warp's own tool in hand and aimed
// at it (warpEditing), so one warp at a time is in edit mode, and Enter, Escape,
// another tool, another layer, another photograph or leaving Finish puts it down like
// any tool; the settings stay open until the layer closes, and opening them again arms
// it again. An image layer's own warp keeps its Edit Warp button in the transform row:
// opening an image layer opens its picture and transform, which is not a warp edit. The
// graph inspector has no chevron and keeps the button too. Inside: Type first (with Add
// shape beside it when the type is Shapes: 2026-10-01, "The "Add shape" button takes up
// a whole role. I think move this button up to the right of the TYPE option menu"),
// then an image layer's Room, then only the chosen type's controls. The other type is
// kept on the node, not applied, so switching back restores it (state.ts warpKindOf,
// the engine's layer_warp_uses_shapes).
//
// Not seated here, each with its one seat elsewhere: the lines' color
// (the Develop warp sections) and thickness (Preferences), the layer's
// opacity, blend and mask (the layer row), the arm chips (edit mode
// itself). The same component is the node's face in the graph
// inspector, with the button (features reach their nodes). Last, on a
// Warp layer, Bake Warp, which turns the layer into an image layer of
// what it shows (layeractions.ts runBakeWarp).

import type { Command, State, WarpKind } from "../state";
import { artWarpOwner, editWarpCommand, isPictureWarp, layerBox, warpEditing, warpKindOf, warpNodeById } from "../state";
import { frameAspectFor } from "../imagelayers";
import { GridWarpControls } from "./gridwarp";
import { AddShapeButton, ShapeWarpControls } from "./shapewarp";
import { TrackSlider } from "./track";
import { ValueField } from "./simple";
import { SourceMenuRow } from "./sourcemenus";
import { BAKE_WARP_GLYPH, MESH_WARP_GLYPH } from "./panelicons";
import { BAKE_WARP_HINT, runBakeWarp } from "../layeractions";

type D = (cmd: Command) => void;

/** The two types, in the order a warp is usually reached for. */
export const WARP_KIND_CHOICES: { id: WarpKind; label: string; hint: string }[] = [
  { id: "grid", label: "Grid", hint: "Bend with a grid of handles: drag them and the picture follows" },
  { id: "shapes", label: "Shapes", hint: "Bend with shapes: move, twist or pinch the picture under each one" },
];

/** The Type menu fits its own labels, the Source menus' rule. */
const KIND_FIT = WARP_KIND_CHOICES.map((c) => c.label);

/** The picture's width over its height for a placed layer: its rest box
 * was fitted to the picture's shape, so the box's shape in pixels is the
 * picture's. */
export function pictureAspectOf(state: State, carrier: string): number {
  const box = layerBox(state, carrier);
  const frame = frameAspectFor(state.activeImage) ?? 1;
  return box.h > 0 ? (box.w * frame) / box.h : 1;
}

/** The Edit Warp button's name and hint, one wording for both seats (an
 * image layer's transform row, the graph inspector). */
export function editWarpWords(editing: boolean, picture: boolean): { label: string; hint: string } {
  return editing
    ? {
        label: "Done editing warp",
        hint: "Keep the warp and close its controls (Enter). Escape puts it back the way it was",
      }
    : picture
      ? {
          label: "Edit warp",
          hint: "Bend the picture itself on the canvas, with a grid or shapes, even past its own edges",
        }
      : {
          label: "Edit warp",
          hint: "Bend everything below this layer on the canvas, with a grid or shapes, shown where the layer's mask lets it through",
        };
}

/** The glyph the Edit Warp button wears: the Warp layer's own picture. */
export function EditWarpGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {MESH_WARP_GLYPH}
    </svg>
  );
}

/** A Finish warp's controls: the Type, an image layer's Room, and the
 * chosen type's own controls. Shown in edit mode, or with `open` (the
 * layer's settings are open), which shows them whether or not the tool
 * is in hand: a Warp layer's opening armed it, and Enter or Escape may
 * have put it down since. With `editButton` (the graph inspector, which
 * has no layer row to seat it) the Edit Warp button comes first and is
 * all that shows otherwise. */
export function FinishWarpControls({
  state,
  dispatch,
  target,
  frame = null,
  editButton = false,
  open = false,
}: {
  state: State;
  dispatch: D;
  target: string;
  frame?: string | null;
  editButton?: boolean;
  /** show the controls without edit mode (the layer's settings are open) */
  open?: boolean;
}) {
  const node = warpNodeById(state, target);
  if (!node) return null;
  // A Finish layer's warp has a layer; one placed by hand in the graph
  // has none and works in the frame it is given.
  const owner = artWarpOwner(state, target);
  const picture = owner ? owner.picture : isPictureWarp(node);
  const editing = warpEditing(state, target);
  const kind = warpKindOf(node);
  const button = editButton ? (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      {(() => {
        const words = editWarpWords(editing, picture);
        return (
          <button
            className="chip"
            data-testid={`finish-warp-edit-${target}`}
            data-active={editing || undefined}
            aria-pressed={editing}
            aria-label={words.label}
            data-tip={words.label}
            data-hint={words.hint}
            onClick={() => dispatch(editWarpCommand(state, target))}
            style={{ padding: "3px 5px", display: "inline-flex", alignItems: "center" }}
          >
            <EditWarpGlyph />
          </button>
        );
      })()}
    </div>
  ) : null;
  if (!editing && !open) return button;
  const frameUrl = frame ?? state.images.find((i) => i.id === state.activeImage)?.src ?? null;
  const aspect = owner?.picture ? pictureAspectOf(state, owner.carrier) : (frameAspectFor(state.activeImage) ?? undefined);
  const room = node.params.room ?? 25;
  const setRoom = (v: number) => dispatch({ type: "art_fx_set", fxId: node.id, param: "room", value: Math.min(100, Math.max(0, Math.round(v))) });
  return (
    <div
      data-testid={`finish-warp-${target}`}
      data-space={picture ? "picture" : "frame"}
      data-kind={kind}
      onMouseDown={(e) => e.stopPropagation()}
      style={{ display: "flex", flexDirection: "column", gap: 6 }}
    >
      {button}
      <SourceMenuRow
        label="Type"
        name="Warp type"
        value={kind}
        choices={WARP_KIND_CHOICES}
        fit={KIND_FIT}
        labelSize={11}
        testid={`finish-warp-kind-${target}`}
        onChange={(id) => dispatch({ type: "art_warp_kind", id: target, kind: id as WarpKind })}
        after={kind === "shapes" ? <AddShapeButton state={state} dispatch={dispatch} target={target} /> : undefined}
      />
      {picture && (
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div className="kicker" style={{ width: 78, flex: "none", fontSize: 11 }}>
            Room
          </div>
          <div className="strack-flex" style={{ minWidth: 60 }}>
            <TrackSlider
              label="Room"
              lo={0}
              hi={100}
              step={1}
              testid={`finish-warp-room-${target}`}
              value={room}
              hint="How far past its own edges the picture can be pulled, in percent of each side"
              onChange={setRoom}
              onBegin={() => dispatch({ type: "begin_gesture", key: `${node.id}.room` })}
              onEnd={() => dispatch({ type: "end_gesture" })}
            />
          </div>
          <div style={{ width: 40, flex: "none" }}>
            <ValueField param="room" value={room} lo={0} hi={100} onCommit={setRoom} />
          </div>
        </div>
      )}
      {kind === "grid" ? (
        <GridWarpControls state={state} dispatch={dispatch} frame={frameUrl} target={target} spaceAspect={aspect} lines={false} armChip={false} />
      ) : (
        <ShapeWarpControls state={state} dispatch={dispatch} frame={frameUrl} target={target} lines={false} armChip={false} addChip={false} />
      )}
      {/* Bake Warp (2026-09-30: "a bake option on the warp layer that bakes
warping effect down to a pixel layer"): a Warp layer's last seat,
after the warp it fixes; the layer's right-click menu and the Layer
menu carry it too (layeractions.ts, one wording). Not on an image
layer's own warp: its picture is already one.*/}
      {owner && !owner.picture && (
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button
            className="chip"
            data-testid={`finish-warp-bake-${target}`}
            aria-label="Bake Warp"
            data-hint={BAKE_WARP_HINT}
            onClick={() => runBakeWarp(state, dispatch, owner.carrier)}
            style={{ padding: "3px 6px", display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11 }}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              {BAKE_WARP_GLYPH}
            </svg>
            Bake Warp
          </button>
        </div>
      )}
    </div>
  );
}
