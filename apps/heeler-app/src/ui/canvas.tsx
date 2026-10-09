// Canvas mode: the full-screen workspace. The photo fills the surface
// edge to edge and the node graph floats over it.
//
// Two decisions drive everything here:
//
// 1. The image is the real viewer, not a second implementation of one.
//    Canvas renders <Viewer bare>, so it gets engine frames, split view,
//    before/after, the crop-aware compare and the live tools for free,
//    and any fix to the viewer lands here too.
//
// 2. Navigation drives the GRAPH. Scroll zooms the nodes, middle-drag
//    pans them, exactly as in Graph mode, because that is the thing you
//    are arranging in this view. The image is framed with the HUD's Fit
//    and 1:1 buttons, and panned by holding space, so it still goes to
//    100% when you want to check focus.

import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Command, State } from "../state";
import { isArtMaskId, maskPreviewNode, maskViewOverriddenBy } from "../state";
import { Inspector, InspectorBar, NodeEditor, NodeParams } from "./graph";
import { GraphElsewhere } from "./graphelsewhere";
import { useSpacePan } from "./hooks";
import { useClearsSibling } from "./layoutroom";
import { Viewer } from "./viewer";
import { modLabel } from "../platform";

type D = React.Dispatch<Command>;

/** The viewer toolbar's height (theme.css .viewer-toolbar). */
const TOOLBAR_H = 34;

// Space-drag panning lives in hooks.ts now (useSpacePan): the viewer
// and the graph editor grew the same gesture, and three copies of one
// keyboard listener is two bugs waiting.

/** Width of the floating settings panel, and the gap it keeps from the
 * node it belongs to and from the edges. */
const PANEL_W = 312;
const PANEL_GAP = 12;

/** Where the floating settings panel goes for a node: beside it, flipped
 * to its other side when that would run off the edge, and clamped so it
 * is never partly off screen. Pure, so the awkward cases are testable
 * without rendering anything. */
export function panelPlacement(
  node: { x?: number; y?: number },
  view: { x: number; y: number; zoom: number },
  surface: { w: number; h: number },
  nodeW = 190,
  // The panel's PAINTED width: the ui-zoom on it makes that
  // PANEL_W times the chrome zoom, and flipping and clamping
  // against the layout width let the zoomed box hang off the edge.
  panelW = PANEL_W
) {
  const z = view.zoom;
  const nodeLeft = (node.x ?? 0) * z + view.x;
  const nodeTop = (node.y ?? 0) * z + view.y;
  const right = nodeLeft + nodeW * z + PANEL_GAP;
  // Prefer the right of the node; flip left when the panel would not fit.
  const left = right + panelW + PANEL_GAP <= surface.w ? right : nodeLeft - panelW - PANEL_GAP;
  const maxLeft = Math.max(PANEL_GAP, surface.w - panelW - PANEL_GAP);
  const maxTop = Math.max(52, surface.h - 220);
  return {
    left: Math.min(Math.max(PANEL_GAP, left), maxLeft),
    top: Math.min(Math.max(52, nodeTop), maxTop),
  };
}

function CanvasModeImpl({
  state,
  dispatch: outerDispatch,
  previewUrl,
  previewError,
  previewMs,
  previewBackend,
  originalUrl,
}: {
  state: State;
  dispatch: D;
  previewUrl?: string | null;
  previewError?: string | null;
  previewMs?: number | null;
  previewBackend?: string | null;
  originalUrl?: string | null;
}) {
  const dispatch = outerDispatch;
  // The selected card: at the top level, or inside the opened group,
  // whose members are what the canvas is drawing (2026-09-23: inside the
  // Sharpening group "the settings didn't open for that node. The
  // settings only open when the node is in the main graph").
  const openedGroup = state.openedGroup ? state.nodes.find((n) => n.id === state.openedGroup) : undefined;
  const pool = openedGroup?.groupNodes ?? state.nodes;
  const picked = state.selection.length === 1 ? pool.find((n) => n.id === state.selection[0]) : null;
  // A Finish layer's mask is a member of the Finish group (2026-10-01),
  // and the Layers panel picks it to aim a mask tool at it: that pick is
  // the tool's, not a request for the mask card's settings over the
  // photograph being painted.
  const maskTool = ["brush", "select", "smart", "object", "fill", "polish"].includes(state.tool);
  const single = picked && !(maskTool && isArtMaskId(picked.id)) ? picked : null;
  const space = useSpacePan((dx, dy) => dispatch({ type: "pan_viewer", dx, dy }));
  // The surface's real size, so the settings panel can be kept inside it.
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const [surface, setSurface] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = surfaceRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0].contentRect;
      setSurface({ w: r.width, h: r.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // With the inspector docked, settings belong in it; the floating panel
  // is only for when the inspector is folded away.
  const showPanel = single && !state.canvasNodesHidden && !state.canvasInspectorOpen && state.inspectorHome === "main";
  // The floating panel wears ui-zoom so its controls match Develop's
  // scale; placement must clamp against the width it paints at, not
  // the width it declares.
  const chromeZoom =
    parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue("--chrome-zoom"),
    ) || 1;
  const [toolbarHeight, setToolbarHeight] = useState(TOOLBAR_H);
  useLayoutEffect(() => {
    const toolbar = surfaceRef.current?.querySelector<HTMLElement>(".viewer-toolbar");
    if (!toolbar) return;
    const measure = () => {
      const height = toolbar.getBoundingClientRect().height;
      if (height > 0) setToolbarHeight(height);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(toolbar);
    return () => observer.disconnect();
  }, [chromeZoom]);
  const place = single
    ? panelPlacement(single, state.graphView, surface, undefined, PANEL_W * chromeZoom)
    : { left: 0, top: 0 };
  // Everything full-bleed stops at the dock rather than sliding under
  // it, so the photo stays centered in the space you can actually see.
  // The docked inspector wears ui-zoom, so it paints at its width times
  // the zoom; the bleed has to stop where it actually starts.
  const dockW = state.canvasInspectorOpen && state.inspectorHome === "main" ? state.panelSizes.right * chromeZoom : 26;
  const bleed = { position: "absolute", left: 0, top: 0, bottom: 0, right: dockW } as const;
  /** Keep graph hits and the HUD below the toolbar's actual wrapped size. */
  const stage = { ...bleed, top: toolbarHeight } as const;

  const maskOverride = state.maskView ? maskViewOverriddenBy(state) : null;
  const hudBtn = (
    label: string,
    active: boolean,
    onClick: (e: React.MouseEvent) => void,
    testid: string,
    hint: string,
    cmd?: string,
    disabled = false,
  ) => (
    <button data-overridden={maskOverride ? "true" : undefined} style={{ color: maskOverride ? "var(--warn)" : undefined, borderColor: maskOverride ? "var(--warn)" : undefined }} data-active={active} data-testid={testid} data-hint={maskOverride ? `Show mask is on, but ${maskOverride} is showing instead. Turn it off to see the mask. ${hint}` : hint} data-hint-cmd={cmd} disabled={disabled} onClick={onClick}>
      {label}
    </button>
  );
  // The mask eye has something to show only when a layer, a Color Set or
  // a probe would answer it. Disabled with the reason otherwise, rather
  // than a button that does nothing ("there is a MASK button
  // in Canvas that doesn't seem to do anything").
  const maskable = maskPreviewNode({ ...state, maskView: true }) !== null;

  return (
    <div
      ref={surfaceRef}
      style={{ flex: 1, minWidth: 0, position: "relative", background: "var(--bg-viewer)", overflow: "hidden", display: "flex" }}
      data-testid="canvas-mode"
    >
      {/* The photo, full bleed, from the same render path as Develop. */}
      <div style={{ ...bleed, display: "flex" }}>
        <Viewer
          bare
          withToolbar
          state={state}
          dispatch={dispatch}
          previewUrl={previewUrl}
          previewError={previewError}
          previewMs={previewMs}
          previewBackend={previewBackend}
          originalUrl={originalUrl}
        />
      </div>

      {/* Just enough scrim for the graph and HUD to stay legible over a bright
frame, weighted to the edges so the photo stays honest in the middle.
Below the viewer's toolbar, which Canvas shares with Develop and
Graph ("This is not using the same canvas header as
Adjustments and Graph").*/}
      <div
        style={{
          ...stage, pointerEvents: "none",
          background:
            "linear-gradient(to top,rgba(8,8,8,.72) 0%,rgba(8,8,8,.30) 22%,rgba(8,8,8,0) 46%,rgba(8,8,8,0) 62%,rgba(8,8,8,.46) 100%)",
        }}
      />

      {/* The graph floats on top and owns the navigation. Hidden with
          tilde, it is unmounted rather than made transparent, so the
          photo underneath gets the scroll and drag back and Canvas
          becomes a plain full-screen view of the picture. */}
      {!state.canvasNodesHidden && !state.graphPoppedOut && (
        // An armed eyedropper needs the click to land on the photograph, and
        // this layer blankets it ("I am trying to Curves picker
        // now and its not working. I suspect the overlay that draws the nodes
        // might be in the way"). The pick-through class flattens the whole
        // subtree, because node cards and wire hit zones re-enable their own
        // pointer events; the inspector and floating panel are siblings and
        // stay clickable, so the disarm button always works.
        <div
          className={
            state.curvePick || state.toneEqPick || state.recolorPick || state.consolePick || state.wbPick || state.bwSeparate || state.bwPick || state.zonePlace || state.chartPlace
              ? "pick-through"
              : undefined
          }
          style={{ ...stage, display: "flex", cursor: space.held ? "grab" : undefined }}
          onMouseDownCapture={space.onMouseDown}
          onPointerDownCapture={space.onPointerDown}
          data-testid="canvas-graph-layer"
        >
          <NodeEditor state={state} dispatch={dispatch} overlay />
        </div>
      )}

      {/* Only what the shared toolbar does not have: the mask eye. Before
          / After, Split, Fit and 1:1 live on the toolbar now, icons and
          sub-bar included. */}
      <div className="hud" style={{ right: dockW + 14, top: toolbarHeight + 14 }}>
        {/* Same contract as every other Show Mask ("Missing the
modifier key on Show Mask to switch to overlay"): click shows or
hides, ALT/CMD-click switches the app-wide flavor between
black/white and the red overlay.*/}
        {hudBtn(
          "MASK",
          state.maskView,
          (e) => {
            if (e.altKey || e.metaKey) {
              dispatch({ type: "toggle_mask_flavor" });
              if (!state.maskView) dispatch({ type: "toggle_mask_view" });
              return;
            }
            dispatch({ type: "toggle_mask_view" });
          },
          "canvas-mask",
          maskable
            ? `Show the active layer's mask; ${modLabel("alt")}-click switches between black/white and the red overlay`
            : "Shows a mask once a layer or a Color Set with one is active: pick one in the Adjustments or Layers panel",
          undefined,
          !maskable,
        )}
      </div>

      {/* A selected node opens its controls beside it. Positioned in
          screen space through the graph's own pan and zoom, so the panel
          tracks the node instead of drifting off once you move the
          view. */}
      {showPanel && (
        <div
          className="ui-zoom"
          style={{
            position: "absolute",
            // zoom scales the element's own left/top along with its
            // box, so screen coordinates must be divided by the zoom
            // to land where the placement math intended.
            left: place.left / chromeZoom,
            top: place.top / chromeZoom,
            width: PANEL_W, maxHeight: "72%", overflowY: "auto",
            background: "var(--bg-panel)", border: "1px solid var(--node-border)",
            borderTop: "2px solid var(--cat-color)", boxShadow: "0 20px 46px rgba(0,0,0,.6)", zIndex: 30,
          }}
          data-testid="canvas-settings"
        >
          <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "10px 12px", borderBottom: "1px solid var(--line-1)" }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-hi)" }}>{single.name}</div>
              <div style={{ fontSize: 9, letterSpacing: ".12em", color: "var(--text-faint)", textTransform: "uppercase" }}>
                Node {state.nodes.indexOf(single) + 1} of {state.nodes.length}
              </div>
            </div>
            <div
              className="toggle"
              data-on={single.enabled}
              role="switch"
              aria-checked={single.enabled}
              aria-label={`${single.name} on/off`}
              onClick={() => dispatch({ type: "set_enabled", id: single.id, enabled: !single.enabled })}
            >
              <div className="dot" />
            </div>
            <button style={{ all: "unset", cursor: "pointer", padding: 2 }} aria-label="Close settings" onClick={() => dispatch({ type: "clear_selection" })}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--text-faint)" strokeWidth="2">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
          {/* The Inspector's own controls, so a node offers the same
              knobs here as it does in Graph mode. */}
          <div style={{ padding: "11px 12px 12px" }}>
            <NodeParams node={single} dispatch={dispatch} allNodes={state.nodes} gestureActive={state.gesture !== null} panelWidth={PANEL_W} appState={state} frame={previewUrl ?? null} session={{ ...state, treeRoot: state.folderTree?.path ?? null }} wires={state.wires} />
          </div>
        </div>
      )}

      {/* The graph out in its own window: the same bar Graph mode shows,
          so Canvas has a way back that is not the Window menu. */}
      {state.graphPoppedOut && !state.canvasNodesHidden && (
        <div style={{ position: "absolute", left: 0, right: dockW, bottom: 0, zIndex: 15 }}>
          <GraphElsewhere dispatch={dispatch} />
        </div>
      )}
      {/* No zoom or dimension readout here on purpose: the viewer under
          this already prints the real ones, with the engine timing
          beside them. Repeating them would mean inventing them. */}
      <CanvasHints style={{ right: dockW + 14, bottom: state.graphPoppedOut && !state.canvasNodesHidden ? 40 : 14 }}>
        <span data-testid="canvas-hint-nodes">
          {state.canvasNodesHidden ? "~, show nodes" : "~, hide nodes"}
        </span>
        {state.canvasNodesHidden ? (
          <span>SCROLL, zoom photo</span>
        ) : (
          <>
            <span>SCROLL, zoom graph</span>
            <span>SPACE DRAG, pan photo</span>
          </>
        )}
      </CanvasHints>

      {/* The inspector docks down the right edge. Opened, a selected
          node's settings land in it and the floating panel stays away,
          which is the fix for a panel that opens beside a node near the
          edge and gets cut in half. Folded, it is a spine like the one
          in the popped-out graph window. */}
      <div style={{ marginLeft: "auto", zIndex: 20, display: "flex", flex: "none" }} data-testid="canvas-inspector-dock">
        {state.canvasInspectorOpen && state.inspectorHome === "main" ? (
          // No width or border on this wrapper: .panel-right brings both,
          // and setting them again pushed the panel a pixel off the edge.
          <div style={{ display: "flex", flexDirection: "column", background: "var(--bg-panel)" }}>
            <button
              className="chip"
              data-testid="canvas-inspector-collapse"
              data-hint="Fold the inspector away and use floating panels"
              style={{ fontSize: 9, padding: "4px 8px", letterSpacing: ".08em", margin: 6, textAlign: "center" }}
              onClick={() => dispatch({ type: "set_canvas_inspector", open: false })}
            >
              Collapse inspector
            </button>
            <Inspector state={state} dispatch={dispatch} width={state.panelSizes.right} frame={previewUrl ?? null} />
          </div>
        ) : (
          <InspectorBar onClick={() => {
            dispatch({ type: "set_inspector_home", home: "main" });
            dispatch({ type: "set_canvas_inspector", open: true });
          }} />
        )}
      </div>
    </div>
  );
}

// NOT memoized against view-only fields: CanvasMode renders the Viewer,
// which is exactly the component pan and zoom must reach. Its expensive
// children (Inspector, the floating NodeEditor) carry their own memo
// boundary, so a nav dispatch still skips them.
export const CanvasMode = CanvasModeImpl;

/** The key hints, bottom right over the photo. They share the bottom
 * edge with the graph's centered node count, and on a narrow canvas
 * they step aside rather than print over it. */
function CanvasHints({ style, children }: { style: React.CSSProperties; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const clear = useClearsSibling(ref, "graph-footer");
  return (
    <div ref={ref} className="hud" style={{ ...style, visibility: clear ? undefined : "hidden" }} data-testid="canvas-hints">
      {children}
    </div>
  );
}
