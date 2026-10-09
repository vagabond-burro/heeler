/** The looks menu of the Relight and Recolor sections (2026-09-30: "I
 * think the buttons take up too much room and are not laid out clean.
 * I think it should be a preview dropdown option menu to keep it
 * cleaner ... as the mouse hovers I think might be the cleanest").
 *
 * One dropdown. While the list is open, the row under the
 * pointer (or the keyboard) shows on the viewer: a VIEW
 * (preview_section_look), never an edit, so nothing is saved, nothing
 * enters undo and no setting moves; the render requests alone carry the
 * look (state.ts: lookPreviewState). Closing the list, however it
 * closes, puts the photograph back. A click writes the look onto the
 * section as one undo step (apply_section_look).
 *
 * A short rest (LOOK_HOVER_MS) before a row is shown, so sweeping the
 * pointer down the list renders the row it stops on, not every row it
 * crossed. The pump renders the shown row at the gesture tier and only
 * sharpens it if the pointer stays (app.tsx: LOOK_REST_MS).
 *
 * The window losing focus or hiding takes the look back too, and the
 * reducer ends it for anything that moves the graph, the photograph,
 * the layer or the mode. Nothing to keep even on a crash: the look is
 * never in anything that is written down.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { depthHistogram, depthMap } from "../bridge";
import { looksFor, type LookSection, type SectionLook } from "../sectionlooks";
import { lookPreviewState, type Command, type State } from "../state";
import { depthProgressNow, depthRecipeKey, subscribeDepthProgress } from "./depthtool";
import { MenuField } from "./menufield";
import { publishBusy } from "./statusbar";

type D = (cmd: Command) => void;

/** How long the pointer rests on a row before it is shown. */
export const LOOK_HOVER_MS = 80;

/** Whether the depth looks can show: the photograph's depth map is on
 * disk at the recipe the look would read. "ready" is the only state a
 * depth look is enabled in; "missing" offers the read, "no-model" says
 * what to install. */
type DepthState = "unknown" | "ready" | "missing" | "reading" | "no-model";

/** The answer holds while a dial is being dragged and while the depth
 * runner is reading (, "When both sections are expanded,
 * when I adjust a slider in either the adjustments view shakes up and
 * down"). Every step of a Depth Map dial is a new recipe, and the check
 * ran on each one: back to "unknown", then "missing", since the runner
 * computes a dragged recipe only when the drag ends. The line under
 * Recolor's looks menu left and came back at every step, and everything
 * below it, the Depth Map section included, moved with it. Now a recipe
 * is asked about once the hand is off the dial, a "no" that arrives
 * while the runner is reading is not taken, and the question is asked
 * again when the read ends: before, nothing asked then, and the line
 * stayed up over a map that had landed. Only another photograph forgets
 * the answer.*/
function useLookDepth(state: State, depthLooks: SectionLook[], wanted: boolean): [DepthState, () => void] {
  const [depth, setDepth] = useState<DepthState>("unknown");
  const probe = depthLooks[0];
  // The recipe the look reads is the one the look's own graph carries
  // (its Depth Map node, built with the preference's defaults when the
  // photograph has none), so the check asks with that graph.
  const graphFor = useCallback(
    (s: State) => (probe ? lookPreviewState({ ...s, lookPreview: probe.id }) : s),
    [probe],
  );
  const stateRef = useRef(state);
  stateRef.current = state;
  const image = state.activeImage;
  const epoch = state.depthEpoch;
  const recipe = depthRecipeKey(graphFor(state));
  const depthGeneration = useRef(0);
  const reading = useSyncExternalStore(subscribeDepthProgress, depthProgressNow, depthProgressNow) !== null;
  const held = state.gesture !== null || reading;
  // What the answer on hand is an answer about, so a drag that moved
  // nothing the map is made from asks nothing when it ends; null once
  // the answer may have changed.
  const asking = `${image}|${epoch}|${recipe}`;
  const answered = useRef<string | null>(null);
  // Another photograph's answer is not this one's.
  useEffect(() => {
    ++depthGeneration.current;
    answered.current = null;
    setDepth("unknown");
  }, [image]);
  // A read by the runner may put the plane on disk.
  useEffect(() => {
    if (reading) answered.current = null;
  }, [reading]);
  useEffect(() => {
    if (!wanted || !probe || held || answered.current === asking) return;
    const generation = ++depthGeneration.current;
    let live = true;
    const answer = (found: boolean) => {
      if (!live || generation !== depthGeneration.current) return;
      // The runner began reading after the question went out: its end
      // asks again, and until then the last answer stands.
      if (!found && depthProgressNow() !== null) return;
      answered.current = asking;
      setDepth(found ? "ready" : "missing");
    };
    void depthHistogram(graphFor(stateRef.current), true)
      .then((bins) => answer(!!bins))
      .catch(() => answer(false));
    return () => {
      live = false;
    };
  }, [wanted, probe, asking, graphFor, held]);
  const read = useCallback(() => {
    if (!probe) return;
    const generation = ++depthGeneration.current;
    setDepth("reading");
    publishBusy("DEPTH · reading the scene's depth");
    void depthMap(graphFor(stateRef.current))
      .then(() => { if (generation === depthGeneration.current) setDepth("ready"); })
      .catch((err) => { if (generation === depthGeneration.current) setDepth(String(err).includes("model not installed") ? "no-model" : "missing"); })
      .finally(() => publishBusy(null));
  }, [probe, graphFor]);
  return [depth, read];
}

export function SectionLooks({
  section,
  state,
  dispatch,
  seat = "panel",
}: {
  section: LookSection;
  state: State;
  dispatch: D;
  /** where the menu is drawn: the Develop panel or the graph inspector,
   * so two seats on screen at once keep their own test ids */
  seat?: "panel" | "inspector";
}) {
  const looks = looksFor(section);
  const depthLooks = looks.filter((l) => l.depth);
  const [depth, readDepth] = useLookDepth(state, depthLooks, depthLooks.length > 0);
  // The look this menu put on the viewer, if any: ending answers only
  // its own, so the inspector's menu never takes back the panel's.
  const showing = useRef<string | null>(null);
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dispatchRef = useRef(dispatch);
  dispatchRef.current = dispatch;

  const end = useCallback(() => {
    if (pending.current !== null) {
      clearTimeout(pending.current);
      pending.current = null;
    }
    if (showing.current === null) return;
    showing.current = null;
    dispatchRef.current({ type: "preview_section_look", id: null });
  }, []);

  const preview = useCallback(
    (id: string | null) => {
      if (id === null) {
        end();
        return;
      }
      if (pending.current !== null) clearTimeout(pending.current);
      pending.current = setTimeout(() => {
        pending.current = null;
        showing.current = id;
        dispatchRef.current({ type: "preview_section_look", id });
      }, LOOK_HOVER_MS);
    },
    [end],
  );

  // The window going away takes the look back; so does the menu leaving
  // the screen (MenuField tells null on unmount, and this clears a row
  // still waiting out its rest).
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden") end();
    };
    window.addEventListener("blur", end);
    document.addEventListener("visibilitychange", onHide);
    return () => {
      window.removeEventListener("blur", end);
      document.removeEventListener("visibilitychange", onHide);
      end();
    };
  }, [end]);

  // A hover can still be waiting for its delay when the document moves.
  // End that pending request as well as a look already on screen.
  useEffect(() => end, [end, state.activeImage, state.activeTakes[state.activeImage], state.renderVersion, state.activeLayer]);

  // The reducer ended the look (an edit, another photograph): the menu
  // lets go of it too, so a later close sends nothing stale.
  useEffect(() => {
    if (showing.current !== null && state.lookPreview !== showing.current) showing.current = null;
  }, [state.lookPreview]);

  if (state.activeLayer) return null;

  const slug = section.toLowerCase();
  const tag = seat === "inspector" ? "-inspector" : "";
  const depthBlocked = depth !== "ready";

  const choose = (id: string) => {
    end();
    dispatch({ type: "apply_section_look", id });
  };

  const options = looks.map((look) => {
    const blocked = look.depth && depthBlocked;
    return {
      id: look.id,
      label: look.name,
      disabled: blocked,
      hint: blocked
        ? `${look.name} reads the photograph's depth map: ${depth === "no-model" ? "install the depth model in Preferences, Models, first" : "read this photograph's depth first"}`
        : `${look.does}. Click to apply it as one undo step`,
    };
  });

  return (
    <div data-testid={`looks-${slug}${tag}`} style={{ padding: "2px 0 8px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <MenuField
          value=""
          placeholder="Preview a look"
          options={options}
          onChange={choose}
          onPreview={preview}
          label={`${section} looks`}
          testid={`looks-${slug}-menu${tag}`}
          hint={`Shows each ${section} look on your photograph as you point at it; click one to apply it as one undo step`}
          size="regular"
          fitLabels={["Preview a look", ...looks.map((l) => l.name)]}
        />
      </div>
      {depthLooks.length > 0 && depthBlocked && depth !== "unknown" && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }} data-testid={`looks-${slug}-depth${tag}`}>
          <span style={{ fontSize: 11, color: "var(--text-faint)", flex: 1 }}>
            {depth === "no-model"
              ? `${depthLooks.map((l) => l.name).join(" and ")} need the depth model.`
              : depth === "reading"
                ? "Reading this photograph's depth..."
                : `${depthLooks.map((l) => l.name).join(" and ")} need this photograph's depth map.`}
          </span>
          {depth === "no-model" ? (
            <button
              type="button"
              className="chip"
              style={{ fontSize: 11 }}
              data-testid={`looks-${slug}-install${tag}`}
              data-hint="Opens Preferences at Models, where the depth model installs"
              onClick={() => dispatch({ type: "open_prefs", landing: "model-inventory" })}
            >
              Get the model
            </button>
          ) : depth === "missing" ? (
            <button
              type="button"
              className="chip"
              style={{ fontSize: 11 }}
              data-testid={`looks-${slug}-read-depth${tag}`}
              data-hint="Reads how far away each part of the photograph is, once, so the depth looks can show"
              onClick={readDepth}
            >
              Read depth
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}
