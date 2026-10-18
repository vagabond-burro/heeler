// The Line Profile scope's path on the viewer. Draw places it a point a
// click (a drag lays a straight line down at once), double-click or Enter
// finishes; Edit moves its points, takes one out with an Option-click
// (Alt-click), and puts one in with a click on the path. The cursor's
// place along it is marked here and on the scope's plot, whichever it is
// over. A view setting: the path never reaches an edit, a Take, the
// history or an export.
import { useEffect, useRef, useState } from "react";
import type { Command, State } from "../state";
import { alongLine, pointAlong, type ProfileLine } from "../spectrums";
import { PICK_CURSOR } from "./cursors";
import { norm, normFree, type ViewTransform } from "./overlays";
import { isPrimaryPress } from "./pointerguard";

type D = (c: Command) => void;
type Pt = [number, number];

/** How near the path, in frame units, the cursor marks a point on it or
 * an edit click puts one in. */
const HOVER_REACH = 0.02;
/** A press that travels this far, in frame units, before it is let go is
 * a drag: a straight line laid down in one stroke. */
const DRAG_LINE = 0.01;

/** The frame's width over its height, from the element it fills. */
function aspectOf(el: HTMLElement | null | undefined): number {
  const r = el?.getBoundingClientRect();
  return r && r.height > 0 ? r.width / r.height : 1;
}

/** A point of the path as a handle: a fixed size on screen at any zoom. */
function Handle({ p, testid, active, onDown }: { p: Pt; testid: string; active?: boolean; onDown?: (e: React.MouseEvent) => void }) {
  return (
    <div
      data-testid={testid}
      onMouseDown={onDown}
      style={{
        position: "absolute",
        left: `${p[0] * 100}%`,
        top: `${p[1] * 100}%`,
        width: 10,
        height: 10,
        marginLeft: -5,
        marginTop: -5,
        borderRadius: "50%",
        background: active ? "var(--accent)" : "#fff",
        border: "2px solid var(--accent)",
        boxShadow: "0 0 0 1px rgba(0,0,0,.6)",
        transform: "scale(calc(1 / var(--ants-zoom, 1)))",
        cursor: onDown ? "move" : undefined,
        pointerEvents: onDown ? "auto" : "none",
      }}
    />
  );
}

export function ProfileLineLayer({ state, dispatch, view }: { state: State; dispatch: D; view: ViewTransform }) {
  const root = useRef<HTMLDivElement>(null);
  // Draw: the points placed so far, and where the pointer is, for the
  // stretch still to be placed.
  const [draft, setDraft] = useState<Pt[]>([]);
  const [hover, setHover] = useState<Pt | null>(null);
  const press = useRef<{ at: Pt; moved: boolean } | null>(null);
  // Edit: the point being dragged, and the path as it is dragged.
  const [dragging, setDragging] = useState<{ index: number; points: Pt[] } | null>(null);

  // A draw put away drops what it had placed.
  useEffect(() => {
    if (!state.profileDraw) {
      setDraft([]);
      setHover(null);
    }
  }, [state.profileDraw]);

  const finish = (points: Pt[]) => {
    setDraft([]);
    setHover(null);
    dispatch(points.length >= 2 ? { type: "set_profile_line", line: { points } } : { type: "toggle_profile_draw" });
  };
  const settle = () => {
    if (!dragging) return;
    dispatch({ type: "set_profile_line", line: { points: dragging.points } });
    setDragging(null);
  };

  const editing = state.profileEdit && !!state.profileLine;
  const shown: ProfileLine | null = dragging
    ? { points: dragging.points }
    : state.profileDraw && draft.length
      ? { points: hover ? [...draft, hover] : draft }
      : state.profileLine;
  const mark =
    !state.profileDraw && !dragging && state.profileLine && state.profileHover !== null
      ? pointAlong(state.profileLine, state.profileHover, aspectOf(root.current))
      : null;

  return (
    <div ref={root} style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
      {shown && shown.points.length >= 2 && (
        <svg
          data-testid="profile-line"
          viewBox="0 0 1 1"
          preserveAspectRatio="none"
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none", overflow: "visible" }}
        >
          <polyline points={shown.points.map((p) => p.join(",")).join(" ")} fill="none" stroke="rgba(0,0,0,.6)" strokeWidth={3} vectorEffect="non-scaling-stroke" />
          <polyline points={shown.points.map((p) => p.join(",")).join(" ")} fill="none" stroke="var(--accent)" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
        </svg>
      )}
      {/* The path's points, shown as it is read or drawn; handles while it
          is edited. */}
      {shown && !editing && shown.points.map((p, i) => <Handle key={i} p={p} testid={`profile-point-${i}`} />)}
      {mark && (
        <div
          data-testid="profile-mark"
          data-x={mark[0]}
          data-y={mark[1]}
          style={{
            position: "absolute",
            left: `${mark[0] * 100}%`,
            top: `${mark[1] * 100}%`,
            width: 14,
            height: 14,
            marginLeft: -7,
            marginTop: -7,
            borderRadius: "50%",
            border: "2px solid #fff",
            boxShadow: "0 0 0 1px rgba(0,0,0,.6)",
            transform: "scale(calc(1 / var(--ants-zoom, 1)))",
            pointerEvents: "none",
          }}
        />
      )}
      {state.profileLine && !state.profileDraw && !editing && (
        <ProfileHover line={state.profileLine} hover={state.profileHover} dispatch={dispatch} view={view} host={root} />
      )}
      {state.profileDraw && (
        <div
          data-testid="profile-draw-overlay"
          data-hint="Click to place each point of the path, double-click or Enter to finish; drag for a straight line. Escape puts it away."
          style={{ position: "absolute", inset: 0, cursor: PICK_CURSOR, pointerEvents: "auto" }}
          tabIndex={-1}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              dispatch({ type: "toggle_profile_draw" });
            } else if (e.key === "Enter") {
              e.stopPropagation();
              finish(draft);
            }
          }}
          onMouseDown={(e) => {
            if (!isPrimaryPress(e)) return;
            e.stopPropagation();
            e.preventDefault();
            e.currentTarget.focus();
            const at = norm(e, e.currentTarget, view);
            press.current = { at, moved: false };
            setDraft((d) => [...d, at]);
          }}
          onMouseMove={(e) => {
            const at = normFree(e, e.currentTarget, view);
            setHover(at);
            const p = press.current;
            if (p && Math.hypot(at[0] - p.at[0], at[1] - p.at[1]) > DRAG_LINE) p.moved = true;
          }}
          onMouseUp={(e) => {
            const p = press.current;
            press.current = null;
            // A drag from the first point lays a straight line down.
            if (p?.moved && draft.length === 1) finish([draft[0], norm(e, e.currentTarget, view)]);
          }}
          onDoubleClick={(e) => {
            e.stopPropagation();
            finish(draft);
          }}
          onMouseLeave={() => setHover(null)}
        />
      )}
      {editing && (
        <div
          data-testid="profile-edit-overlay"
          data-hint="Drag a point to move it, Option-click a point to take it out, click the path to put a point in. Escape ends editing."
          style={{ position: "absolute", inset: 0, cursor: PICK_CURSOR, pointerEvents: "auto" }}
          tabIndex={-1}
          onKeyDown={(e) => {
            if (e.key === "Escape" || e.key === "Enter") {
              e.stopPropagation();
              dispatch({ type: "toggle_profile_edit" });
            }
          }}
          onMouseDown={(e) => {
            // A click on the path between points: a point goes in there,
            // and drags on from the same press.
            if (!isPrimaryPress(e) || !state.profileLine) return;
            e.currentTarget.focus();
            const at = norm(e, e.currentTarget, view);
            const pts = state.profileLine.points;
            let best = { index: -1, dist: Infinity };
            for (let i = 1; i < pts.length; i++) {
              const { dist } = alongLine({ points: [pts[i - 1], pts[i]] }, at[0], at[1]);
              if (dist < best.dist) best = { index: i, dist };
            }
            if (best.dist > HOVER_REACH) return;
            e.preventDefault();
            const points = [...pts.slice(0, best.index), at, ...pts.slice(best.index)];
            dispatch({ type: "set_profile_line", line: { points } });
            setDragging({ index: best.index, points });
          }}
          onMouseMove={(e) => {
            if (!dragging) return;
            const at = norm(e, e.currentTarget, view);
            setDragging({ index: dragging.index, points: dragging.points.map((p, i) => (i === dragging.index ? at : p)) });
          }}
          onMouseUp={settle}
          onMouseLeave={settle}
        >
          {(dragging?.points ?? state.profileLine!.points).map((p, i) => (
            <Handle
              key={i}
              p={p}
              testid={`profile-handle-${i}`}
              active={dragging?.index === i}
              onDown={(e) => {
                if (!isPrimaryPress(e)) return;
                e.stopPropagation();
                e.preventDefault();
                (e.currentTarget.parentElement as HTMLElement | null)?.focus();
                const pts = state.profileLine!.points;
                if (e.altKey) {
                  // Taking a point out of a two-point path would leave no
                  // path: the last two stay.
                  if (pts.length > 2) dispatch({ type: "set_profile_line", line: { points: pts.filter((_, k) => k !== i) } });
                  return;
                }
                setDragging({ index: i, points: pts });
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** The cursor's place along the path, from the frame under it: the
 * stage's moves are listened to, so the frame's own tools keep their
 * clicks. */
function ProfileHover({ line, hover, dispatch, view, host }: { line: ProfileLine; hover: number | null; dispatch: D; view: ViewTransform; host: React.RefObject<HTMLDivElement | null> }) {
  const live = useRef({ line, hover, view });
  live.current = { line, hover, view };
  useEffect(() => {
    const stage = host.current?.parentElement;
    if (!stage) return;
    const move = (e: MouseEvent) => {
      const { line: l, hover: h, view: v } = live.current;
      const [x, y] = norm(e, stage, v);
      const { t, dist } = alongLine(l, x, y, aspectOf(stage));
      const next = dist <= HOVER_REACH ? t : null;
      if (next !== h) dispatch({ type: "set_profile_hover", t: next });
    };
    const leave = () => {
      if (live.current.hover !== null) dispatch({ type: "set_profile_hover", t: null });
    };
    stage.addEventListener("mousemove", move);
    stage.addEventListener("mouseleave", leave);
    return () => {
      stage.removeEventListener("mousemove", move);
      stage.removeEventListener("mouseleave", leave);
    };
  }, [dispatch, host]);
  return null;
}
