// The Line Profile scope's line on the viewer: drawn by a drag while
// the scope's Draw is armed, shown while it exists, and marked where
// the cursor sits along it, here or over the scope's plot. A view
// setting: the line never reaches an edit, a Take, the history or an
// export.
import { useEffect, useRef, useState } from "react";
import type { Command, State } from "../state";
import { alongLine, type ProfileLine } from "../spectrums";
import { PICK_CURSOR } from "./cursors";
import { norm, type ViewTransform } from "./overlays";
import { isPrimaryPress } from "./pointerguard";

type D = (c: Command) => void;

/** How near the line, in frame units, the cursor marks a point on it. */
const HOVER_REACH = 0.02;

export function ProfileLineLayer({ state, dispatch, view }: { state: State; dispatch: D; view: ViewTransform }) {
  const [draft, setDraft] = useState<ProfileLine | null>(null);
  const start = useRef<[number, number] | null>(null);
  const line = draft ?? state.profileLine;
  const mark = !draft && line && state.profileHover !== null
    ? [line.x0 + (line.x1 - line.x0) * state.profileHover, line.y0 + (line.y1 - line.y0) * state.profileHover]
    : null;
  const finish = () => {
    if (!start.current) return;
    start.current = null;
    if (draft) dispatch({ type: "set_profile_line", line: draft });
    setDraft(null);
  };
  return (
    <>
      {line && (
        <svg
          data-testid="profile-line"
          viewBox="0 0 1 1"
          preserveAspectRatio="none"
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none", overflow: "visible" }}
        >
          <line x1={line.x0} y1={line.y0} x2={line.x1} y2={line.y1} stroke="rgba(0,0,0,.6)" strokeWidth={3} vectorEffect="non-scaling-stroke" />
          <line x1={line.x0} y1={line.y0} x2={line.x1} y2={line.y1} stroke="var(--accent)" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
          <circle cx={line.x0} cy={line.y0} r={0.004} fill="var(--accent)" />
          {mark && <circle data-testid="profile-mark" cx={mark[0]} cy={mark[1]} r={0.008} fill="none" stroke="#fff" strokeWidth={2} vectorEffect="non-scaling-stroke" />}
        </svg>
      )}
      {state.profileLine && !state.profileDraw && <ProfileHover line={state.profileLine} hover={state.profileHover} dispatch={dispatch} view={view} />}
      {state.profileDraw && (
        <div
          data-testid="profile-draw-overlay"
          data-hint="Drag across the photograph to draw the line the Line Profile reads. Escape puts it away."
          style={{ position: "absolute", inset: 0, cursor: PICK_CURSOR }}
          tabIndex={-1}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              setDraft(null);
              start.current = null;
              dispatch({ type: "toggle_profile_draw" });
            }
          }}
          onMouseDown={(e) => {
            if (!isPrimaryPress(e)) return;
            e.stopPropagation();
            e.preventDefault();
            e.currentTarget.focus();
            const [x, y] = norm(e, e.currentTarget, view);
            start.current = [x, y];
            setDraft({ x0: x, y0: y, x1: x, y1: y });
          }}
          onMouseMove={(e) => {
            if (!start.current) return;
            const [x, y] = norm(e, e.currentTarget, view);
            setDraft({ x0: start.current[0], y0: start.current[1], x1: x, y1: y });
          }}
          onMouseUp={finish}
          onMouseLeave={finish}
        />
      )}
    </>
  );
}

/** The cursor's point along the line, from the frame under it: the
 * stage's moves are listened to, so the frame's own tools keep their
 * clicks. */
function ProfileHover({ line, hover, dispatch, view }: { line: ProfileLine; hover: number | null; dispatch: D; view: ViewTransform }) {
  const ref = useRef<HTMLDivElement>(null);
  const live = useRef({ line, hover, view });
  live.current = { line, hover, view };
  useEffect(() => {
    const host = ref.current?.parentElement;
    if (!host) return;
    const move = (e: MouseEvent) => {
      const { line: l, hover: h, view: v } = live.current;
      const [x, y] = norm(e, host, v);
      const { t, dist } = alongLine(l, x, y);
      const next = dist <= HOVER_REACH ? t : null;
      if (next !== h) dispatch({ type: "set_profile_hover", t: next });
    };
    const leave = () => {
      if (live.current.hover !== null) dispatch({ type: "set_profile_hover", t: null });
    };
    host.addEventListener("mousemove", move);
    host.addEventListener("mouseleave", leave);
    return () => {
      host.removeEventListener("mousemove", move);
      host.removeEventListener("mouseleave", leave);
    };
  }, [dispatch]);
  return <div ref={ref} data-testid="profile-hover" style={{ position: "absolute", inset: 0, pointerEvents: "none" }} />;
}
