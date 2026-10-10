// Photo > Flip Horizontal and Flip Vertical, as switches beside the crop's
// numbers (2026-10-01: "how hard is it to have a "Flip Image" in the Photo
// menu?"). The Develop Geometry section and the Crop & Rotate node's inspector
// mount this one component (features reach their nodes); the menu is the other
// seat. Each press is flip_photo, one undo step: the photograph and every edit
// on it mirror ("In [the other editor], the edits flip with the
// photo."), and a second press puts it back.

import React from "react";
import type { Command, NodeCard } from "../state";
import { photoFlipBlocked, photoFlips, photoTurn, photoTurnBlocked } from "../state";
import { XformIcon } from "./panelicons";

const ICON_CHIP: React.CSSProperties = {
  width: 22,
  height: 20,
  padding: 0,
  boxSizing: "border-box",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  flex: "none",
};

export function FlipPhotoRow({
  nodes,
  activeImage,
  dispatch,
}: {
  nodes: NodeCard[];
  activeImage: string;
  dispatch: React.Dispatch<Command>;
}) {
  const flips = photoFlips({ nodes });
  const blocked = photoFlipBlocked({ nodes, activeImage });
  return (
    <>
    <div data-testid="flip-photo-row" style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <span className="lbl" style={{ fontSize: 11, flex: 1 }}>
        Flip
      </span>
      {(["h", "v"] as const).map((axis) => {
        const name = axis === "h" ? "Flip Horizontal" : "Flip Vertical";
        const way = axis === "h" ? "left for right" : "top for bottom";
        const on = axis === "h" ? flips.h : flips.v;
        const hint = blocked
          ? `${name}: ${blocked}`
          : on
            ? `${name}: on, the photograph and every edit on it mirrored ${way}; click to put it back`
            : `${name}: mirror the photograph ${way}, with every edit on it`;
        return (
          <button
            key={axis}
            className="chip"
            data-testid={`flip-photo-${axis}`}
            aria-label={name}
            aria-pressed={on}
            data-active={on || undefined}
            data-tip={name}
            data-hint={hint}
            disabled={!!blocked}
            style={ICON_CHIP}
            onClick={() => dispatch({ type: "flip_photo", axis })}
          >
            <XformIcon id={axis === "h" ? "flipH" : "flipV"} />
          </button>
        );
      })}
    </div>
    <RotatePhotoRow nodes={nodes} activeImage={activeImage} dispatch={dispatch} />
    </>
  );
}

/** Photo > Rotate's quarter turns as two buttons under Flip: each press is
 * turn_photo, one undo step, the photograph and every edit on it turned.
 * The half turn is in the menu (or two presses). */
function RotatePhotoRow({ nodes, activeImage, dispatch }: { nodes: NodeCard[]; activeImage: string; dispatch: React.Dispatch<Command> }) {
  const blocked = photoTurnBlocked({ nodes, activeImage });
  const turn = photoTurn({ nodes });
  const state = turn ? ` Turned ${turn === 2 ? "180°" : turn === 1 ? "90° right" : "90° left"} now.` : "";
  return (
    <div data-testid="rotate-photo-row" style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <span className="lbl" style={{ fontSize: 11, flex: 1 }}>
        Rotate
      </span>
      {([3, 1] as const).map((quarters) => {
        const name = quarters === 1 ? "Rotate 90° Right" : "Rotate 90° Left";
        const way = quarters === 1 ? "clockwise" : "counterclockwise";
        return (
          <button
            key={quarters}
            className="chip"
            data-testid={`rotate-photo-${quarters === 1 ? "right" : "left"}`}
            aria-label={name}
            data-tip={name}
            data-hint={blocked ? `${name}: ${blocked}` : `${name}: turn the photograph a quarter turn ${way}, with every edit on it.${state}`}
            disabled={!!blocked}
            style={ICON_CHIP}
            onClick={() => dispatch({ type: "turn_photo", quarters })}
          >
            <XformIcon id={quarters === 1 ? "rotateRight" : "rotateLeft"} />
          </button>
        );
      })}
    </div>
  );
}
