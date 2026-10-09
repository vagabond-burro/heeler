import { useEffect, useRef, useState } from "react";
import type { State, Command } from "../state";
import { clampAutosaveDelay, needsMergedDefaults, needsProfileDefaults, needsRenderedBypass } from "../state";
import { armAutosave, flushAutosave, autosaves, saveBeforeClose } from "../autosave";
import { nextSaveRevision } from "../saverevision";
import { clearThumbnail, isTauri, loadGraphResult, loadLastGoodGraph, loadThumbnail, saveGraph, renderThumbnail, type GraphLoadResult } from "../bridge";
import { queueQuadMembers } from "../quadedit";
import { linkedWith } from "../links";
import { writeGraphKeepingTakes } from "../copyedits";
import { freshNodesFor, photoLineWidth } from "../state";
import { logDebug, logMsg } from "../log";

/** A save can finish while Reset or a newer edit replaces its graph.
 * Its late thumbnail must not cover the photograph that replaced it. */
function graphIsCurrent(state: State, id: string, graph: Pick<State, "nodes" | "wires">): boolean {
  if (state.resetPending.includes(id)) return false;
  const live = id === state.activeImage ? state : state.graphs[id];
  return live?.nodes === graph.nodes && live?.wires === graph.wires;
}

export function GraphPersistence({ state, dispatch }: { state: State; dispatch: (command: Command) => void }) {
  const stateRef = useRef(state);
  stateRef.current = state;
  const [saveErrors, setSaveErrors] = useState<string[]>([]);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [loadedImage, setLoadedImage] = useState<string | null>(null);
  const graphReady = useRef<string | null>(null);
  /** The read the load effect last started, image and attempt, so the
   * hold clearing after it does not start the same read again. */
  const lastRead = useRef<string | null>(null);
  const [recovery, setRecovery] = useState<(Extract<GraphLoadResult, { status: "blocked" }> & { image: string }) | null>(null);
  const recoveryRef = useRef(recovery);
  recoveryRef.current = recovery;
  useEffect(() => autosaves.subscribe(() => setSaveErrors(autosaves.errors())), []);
  const retrySave = async () => {
    try { await flushAutosave(); setSaveErrors([]); }
    catch (error) { setSaveErrors([String(error)]); }
  };
  const resolveGraph = async (useLastGood: boolean) => {
    if (!recovery) return;
    const image = recovery.image;
    const s = stateRef.current;
    if (s.activeImage !== image) return;
    const revision = nextSaveRevision(image);
    const chosenEdit = JSON.stringify([s.nodes, s.wires, s.backdrops, s.takes[image], s.activeTakes[image], photoLineWidth(s, image)]);
    try {
      const activeVersion = s.activeTakes[image] ?? "take_1";
      const lineWidth = photoLineWidth(s, image);
      const payload = useLastGood ? await loadLastGoodGraph(image) : {
        nodes: s.nodes, wires: s.wires, backdrops: s.backdrops,
        versions: (s.takes[image] ?? []).map(v => v.id === activeVersion ? { ...v, nodes: s.nodes, wires: s.wires } : v), activeVersion,
        ...(lineWidth > 0 ? { lineWidth } : {}),
      };
      const live = stateRef.current;
      if (live.activeImage !== image || JSON.stringify([live.nodes, live.wires, live.backdrops, live.takes[image], live.activeTakes[image], photoLineWidth(live, image)]) !== chosenEdit) {
        throw new Error("The edit changed during recovery. Choose which edit to keep again.");
      }
      await saveGraph(image, payload, true, revision, true, s.images.find(i => i.id === image));
      if (stateRef.current.activeImage === image) setLoadAttempt(n => n + 1);
    } catch (error) { setSaveErrors([String(error)]); }
  };

  // Per-image graph persistence (Tauri): restore on switch, save debounced.
  useEffect(() => {
    if (!isTauri()) return;
    // The old empty-id autosave can have left a .json file behind.
    // It is not an open photograph and must not load into the editor.
    if (!state.activeImage) {
      graphReady.current = null;
      // Forget the last read too: coming back to the same photograph
      // must read it again, or its autosave stays blocked.
      lastRead.current = null;
      setLoadedImage(null);
      return;
    }
    // Quad edit owns its graphs: anchoring to a pane swaps the live
    // graph in memory, and the disk copy this effect would load is the
    // stale one from before the mirrored deltas landed.
    if (stateRef.current.quadEdit) {
      graphReady.current = state.activeImage;
      setLoadedImage(state.activeImage);
      dispatch({ type: "graph_settled", id: state.activeImage });
      return;
    }
    // A hold on the photo already read asks for the read again, even
    // though the photo did not change. Re-opening a folder from the
    // shortlist (or OPEN on the same root) reloads the image list and
    // lands on the photo already open: load_images and the stash-less
    // select_image put the template in the live graph under the same
    // activeImage, this effect never re-ran, and the autosave below
    // persisted the template within 400ms. The owner lost days-old edits
    // on P2578574 that way, the edited badge still on. The hold clearing
    // is not a reason to read: the read that cleared it just ran.
    const read = `${state.activeImage}|${loadAttempt}`;
    if (lastRead.current === read && state.graphLoading !== state.activeImage) return;
    lastRead.current = read;
    let live = true;
    graphReady.current = null;
    setLoadedImage(null);
    setRecovery(null);
    const image = state.activeImage;
    const name = state.images.find((i) => i.id === image)?.name ?? "";
    const entry = state.images.find((i) => i.id === image);
    const takeAtRead = state.activeTakes[image];
    const widthAtRead = photoLineWidth(state, image);
    const editAtRead = JSON.stringify([state.nodes, state.wires, state.backdrops, state.takes[image]]);
    // Finish outgoing revisions before returning to their saved graph.
    // Every way out of the read settles the pump's hold on this image
    // (see State.graphLoading), the recovery paths included: a photo
    // whose graph cannot be read still renders from the template it
    // has, as it always did.
    void (async () => {
      try { await load(); }
      // load() handles its own expected failures; anything still
      // reaching here is a bug, and an unhandled rejection would vanish
      // it. The hold settles either way, in the finally.
      catch (error) { logMsg("error", `graph load failed unexpectedly: ${String(error)}`); }
      finally { if (live) dispatch({ type: "graph_settled", id: image }); }
    })();
    async function load() {
      try { await flushAutosave(); }
      catch (error) {
        if (live) { setSaveErrors([String(error)]); setRecovery({ status: "blocked", image, path: name || image, error: String(error), broken: null, last_good: false }); }
        return;
      }
      const result = await loadGraphResult(image);
      if (!live) return;
      if (result.status === "blocked") { setRecovery({ ...result, image }); return; }
      if (stateRef.current.activeTakes[image] !== takeAtRead || JSON.stringify([stateRef.current.nodes, stateRef.current.wires, stateRef.current.backdrops, stateRef.current.takes[image]]) !== editAtRead) {
        setRecovery({ status: "blocked", image, path: name || image, error: "The edit changed while saved edits were being read. Choose which edit to keep.", broken: null, last_good: false });
        return;
      }
      let g = result.status === "ready" ? result.graph : null;
      // A link edit and photo switch can share a React batch, before
      // the member save effect ever arms. Its real stash is newer than
      // this disk read; take history still comes from the saved file.
      const linked = stateRef.current.linkDirty.includes(image) ? stateRef.current.graphs[image] : undefined;
      if (linked && !linked.preRead) {
        g = { ...g, nodes: linked.nodes, wires: linked.wires, backdrops: linked.backdrops, linkOverrides: linked.overrides ?? [] };
        dispatch({ type: "mark_edited", id: image });
      }
      graphReady.current = image;
      setLoadedImage(image);
      // A merge needs a highlight shoulder or its recovered sky renders
      // as flat white. Asked of the saved graph as well as of a missing
      // one: a stack made before the shoulder existed has a graph file,
      // and checking only for the absence of one left every such stack
      // blown. It is a real param the user can see and zero out, not a
      // hidden setting, and an image anyone has actually edited is left
      // exactly as they left it.
      const upgrade = needsMergedDefaults(entry ?? { name, edited: false }, g);
      logDebug(
        () =>
          `graph load: ${image} ${g ? `file with ${g.nodes.length} nodes / ${g.wires.length} wires` : "no file, fresh graph"}${upgrade ? ", merged-defaults upgrade" : ""}`,
      );
      // The photograph's own line thickness rides the file beside the
      // graph; a file without one follows the preference. No file keeps
      // what this session set.
      if (photoLineWidth(stateRef.current, image) === widthAtRead) {
        const width = g?.lineWidth ?? (result.status === "absent" ? result.lineWidth : undefined);
        if (g || width !== undefined) dispatch({ type: "set_photo_line_width", id: image, width: typeof width === "number" ? width : 0 });
      }
      if (!g) {
        if (upgrade) dispatch({ type: "apply_merged_defaults" });
        dispatch({ type: "settle_link_edits", id: image });
        return;
      }
      dispatch({
        type: "replace_graph",
        nodes: g.nodes,
        wires: g.wires,
        backdrops: (g as any).backdrops ?? [],
        overrides: Array.isArray((g as any).linkOverrides) ? (g as any).linkOverrides : [],
      });
      // A rendered source (JPEG, HEIC, TIFF) whose saved graph still
      // carries an untouched profile catches up to the format rule: the
      // camera already rendered it once, and the fresh-graph bypass never
      // reached graphs saved before the rule existed. "I
      // still have profiles being added to JPG." Instead of the defaults
      // upgrade, not before it - upgrading a profile that is about to
      // switch off would dirty the very params the untouched-check reads
      // on the next load.
      if (needsRenderedBypass(entry ?? { name }, g)) {
        logDebug(() => `graph load: ${image} rendered-bypass upgrade applied`);
        dispatch({ type: "apply_rendered_bypass" });
        // The thumbnail this photo already has was rendered with the
        // profile on; the catalog would keep it forever. Cleared, the
        // ribbon falls back to the file's own preview, right by
        // construction for a rendered source.
        void clearThumbnail(image)
          .then(() => loadThumbnail(image, stateRef.current.prefs.thumbnailEdge ?? 480))
          .then((src) => {
            if (src) dispatch({ type: "set_thumb", id: image, src });
          })
          .catch(() => {});
      } else if (needsProfileDefaults(entry ?? { edited: false }, g)) {
        logDebug(() => `graph load: ${image} profile-defaults upgrade applied`);
        // An unedited image whose graph predates the profile defaults
        // gets today's default look (baseline lift, toe, shoulder).
        // Before the merged upgrade, which may then raise the shoulder
        // further.
        dispatch({ type: "apply_profile_defaults" });
      }
      if (upgrade) dispatch({ type: "apply_merged_defaults" });
      // A Color Checker fit saved before the order fix: the matrix is
      // re-expressed for the graph's order, exactly, so the picture
      // becomes what the chart measured (2026-09-20).
      dispatch({ type: "convert_legacy_fits" });
      // Saved graphs from when curves sat before the profile: while the
      // curve is untouched the move is invisible, so every such graph
      // catches up to the current chain. The reducer refuses to move a
      // curve anyone has bent.
      dispatch({ type: "move_curves_late" });
      // Levels made the same move on 2026-09-13, under the same rule.
      dispatch({ type: "move_levels_late" });
      // A conversion saved with one face for its three curves: the
      // infrared guess and the depth curve take their own copy, so the
      // hue curve's face stops reshaping them (2026-09-15).
      dispatch({ type: "split_curve_faces" });
      const versions = (g as any).versions;
      if (Array.isArray(versions) && versions.length > 0) {
        dispatch({
          type: "restore_takes",
          imageId: image,
          versions,
          activeVersion: (g as any).activeVersion ?? versions[0].id,
        });
      }
      dispatch({ type: "settle_link_edits", id: image });
    }
    return () => {
      live = false;
    };
  }, [state.activeImage, loadAttempt, state.graphLoading]);

  useEffect(() => {
    if (!isTauri()) return;
    // Armed rather than timed here: the pending save lives in the
    // autosave module so a photo switch and the window's close can
    // flush it (round-5 review, T5), where clearing the timer threw the
    // window's edits away.
    const forImage = state.activeImage;
    // No photograph, no save: with quad edit up and nothing open the
    // ready markers above are both the empty id, and the autosave wrote
    // a graph file literally named ".json" (the pre-merge review's F1).
    if (!forImage) return;
    if (graphReady.current !== forImage || loadedImage !== forImage) return;
    // Never while the photo's saved graph is being read: the live graph
    // is the template then, and saving it is how a folder reload wrote
    // a template over real edits (the read effect above says how).
    if (state.graphLoading === forImage) return;
    const edited = state.images.find((i) => i.id === forImage)?.edited ?? false;
    const activeVersion = state.activeTakes[forImage] ?? "take_1";
    const versions = (state.takes[forImage] ?? []).map((v) =>
      v.id === activeVersion ? { ...v, nodes: state.nodes, wires: state.wires } : v,
    );
    const lineWidth = photoLineWidth(state, forImage);
    const payload = {
      nodes: state.nodes,
      wires: state.wires,
      backdrops: state.backdrops,
      versions,
      activeVersion,
      // The link overrides travel with the edits they protect.
      linkOverrides: state.linkOverrides,
      // The photograph's own line thickness, a view setting kept with
      // it but outside its graph; absent follows the preference. It
      // changes no edited badge: `edited` below is the image's own.
      ...(lineWidth > 0 ? { lineWidth } : {}),
    };
    const delay = clampAutosaveDelay(state.prefs.autosaveDelayMs);
    armAutosave(forImage, delay, async (revision) => {
      logDebug(
        () =>
          `autosave: ${forImage} nodes=${payload.nodes.length} wires=${payload.wires.length} takes=${versions.length} edited=${edited} after ${delay}ms${edited ? ", thumbnail refresh queued" : ""}`,
      );
      try { await saveGraph(forImage, payload, edited, revision, false, state.images.find(i => i.id === forImage)); }
      catch (error) { throw new Error(`${state.images.find(i => i.id === forImage)?.name ?? forImage}: ${String(error)}`); }
      if (state.graphs[forImage]) dispatch({ type: "link_saved", id: forImage, graph: state.graphs[forImage] });
      if (edited && graphIsCurrent(stateRef.current, forImage, payload)) {
        // Through the graph that was just written, never the live one: a flush
        // after a photo switch found the NEXT photo's graph live, and rendered
        // this one's thumbnail through it, a RAW's profile on a JPEG (The
        // report: "they look right in the canvas but the thumbnail is blown
        // out"), which the catalog then kept.
        void renderThumbnail({ ...stateRef.current, nodes: payload.nodes, wires: payload.wires, activeImage: forImage } as State, forImage).then((src) => {
          if (src && graphIsCurrent(stateRef.current, forImage, payload)) dispatch({ type: "set_thumb", id: forImage, src });
        });
      }
    });
  }, [
    state.nodes,
    state.wires,
    state.backdrops,
    state.prefs.autosaveDelayMs,
    state.activeImage,
    state.graphLoading,
    state.takes,
    state.activeTakes,
    loadedImage,
  
    state.linkOverrides,
    state.photoLineWidth[state.activeImage],
  ]);

  // The outgoing photograph's pending save runs at once when the
  // photograph changes (the cleanup fires before the next effect arms
  // the new one), and the window's close waits for whatever is pending.
  useEffect(() => {
    return () => {
      void flushAutosave().catch(error => setSaveErrors([String(error)]));
    };
  }, [state.activeImage]);
  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void import("@tauri-apps/api/window").then(async ({ getCurrentWindow }) => {
      const win = getCurrentWindow();
      unlisten = await win.onCloseRequested(saveBeforeClose(
        async () => {
          await flushAutosave();
          // Edits still queued for a member whose graph never arrived
          // (a blocked read, a photo out of reach) are in memory only.
          // They are not a reason to refuse the close: the member keeps
          // its saved edit, as it did before the queue existed, and the
          // console says which photographs did not get theirs.
          {
            const waiting = Object.keys(stateRef.current.linkPending ?? {});
            if (waiting.length) {
              const names = waiting.map((id) => stateRef.current.images.find((i) => i.id === id)?.name ?? id);
              logMsg("warn", `Linked edits for ${names.join(", ")} were still waiting for those photographs' saved edits to load, and were not applied.`);
            }
          }
          if (recoveryRef.current) throw new Error(`${recoveryRef.current.path}: resolve the saved edits before closing.`);
          // No photograph open (an empty collection or folder) is nothing
          // being read: the load effect leaves graphReady null for it.
          const open = stateRef.current.activeImage;
          if (open && graphReady.current !== open) throw new Error("Saved edits are still being read. Try closing again when reading finishes.");
        },
        () => win.destroy(),
        error => setSaveErrors([error]),
      ));
      if (disposed) unlisten();
    });
    return () => { disposed = true; unlisten?.(); };
  }, []);

  useEffect(() => {
    if (isTauri() && state.quadEdit) queueQuadMembers(state, dispatch, clampAutosaveDelay(state.prefs.autosaveDelayMs));
  }, [state.quadGraphs, state.quadEdit, state.prefs.autosaveDelayMs]);

  // Linked photographs (2026-09-09). When the active photograph is in a
  // link, its members' graphs are read into the stash, so the reducer's
  // mirror has somewhere to land an edit; the read is skipped for a
  // member whose stash already holds real edits.
  const linkKey = [...new Set([...linkedWith(state, state.activeImage), ...Object.keys(state.linkPending ?? {})])].filter((id) => id !== state.activeImage).sort().join("|");
  useEffect(() => {
    const members = linkKey ? linkKey.split("|") : [];
    const missing = members.filter((id) => !stateRef.current.graphs[id] || stateRef.current.graphs[id].preRead);
    if (missing.length === 0) return;
    let live = true;
    void (async () => {
      const graphs: Record<string, { nodes: never[]; wires: never[]; backdrops?: never[] }> = {};
      for (const id of missing) {
        try {
          const result = await loadGraphResult(id);
          if (result.status === "blocked") throw new Error(`${id}: ${result.error}`);
          const g = (result.status === "ready" ? result.graph : null) as { nodes: never[]; wires: never[]; backdrops?: never[] } | null;
          graphs[id] = g ?? { nodes: freshNodesFor(stateRef.current, id) as never[], wires: structuredClone(stateRef.current.defaultGraph.wires) as never[], backdrops: [] };
        } catch (e) {
          logMsg("error", `Could not read a linked photograph's edits: ${String(e)}`);
        }
      }
      if (live && Object.keys(graphs).length) dispatch({ type: "stash_graphs", graphs });
    })();
    return () => {
      live = false;
    };
  }, [linkKey, state.activeImage]);

  // A member that took a mirrored edit is owed its file and its
  // thumbnail, through the same close/Retry queue the quad uses.
  useEffect(() => {
    if (!isTauri() || state.linkDirty.length === 0) return;
    const delay = clampAutosaveDelay(state.prefs.autosaveDelayMs);
    for (const id of state.linkDirty) {
      const graph = state.graphs[id];
      if (!graph || id === state.activeImage) continue;
      armAutosave(id, delay, async (revision) => {
        await writeGraphKeepingTakes(id, { nodes: graph.nodes, wires: graph.wires, backdrops: graph.backdrops, linkOverrides: graph.overrides ?? [] }, revision, true, state.images.find(i => i.id === id));
        if (!graphIsCurrent(stateRef.current, id, graph)) return;
        dispatch({ type: "link_saved", id, graph });
        dispatch({ type: "mark_edited", id });
        const src = await renderThumbnail({ ...stateRef.current, nodes: graph.nodes, wires: graph.wires, activeImage: id } as State, id);
        if (src && graphIsCurrent(stateRef.current, id, graph)) dispatch({ type: "set_thumb", id, src });
      });
    }
  }, [state.graphs, state.linkDirty, state.prefs.autosaveDelayMs]);
  return <>
      {saveErrors.length > 0 && <div role="alert" className="save-recovery" data-testid="save-recovery-errors">
        <strong>Edits are still unsaved.</strong> {saveErrors.join("; ")}
        <button
          className="chip"
          data-hint="Save the latest edits again; the window stays open until saving succeeds"
          onClick={() => void retrySave()}
        >
          Retry save
        </button>
      </div>}
      {recovery && recovery.image === state.activeImage && <div role="alert" className="save-recovery" data-testid="save-recovery-notice">
        <strong>Saved edits need attention: {state.images.find(i => i.id === recovery.image)?.name ?? recovery.image}</strong>
        <p>{recovery.path}: {recovery.error} Automatic saving is paused for this photograph.</p>
        <p>{recovery.broken ? `The original bytes are also preserved at ${recovery.broken}.` : "The saved file stays protected. Restore access to it, then try reading again."}</p>
        <button
          className="chip"
          data-hint="Read the saved edits again, after restoring access to the file or repairing it"
          onClick={() => setLoadAttempt(n => n + 1)}
        >
          Try reading again
        </button>
        {/* The hint rides a wrapper: a disabled button fires no mouse
            events, and a grayed control still owes its explanation. */}
        <span
          data-hint={
            recovery.last_good
              ? "Restore the previous successful save, takes included"
              : "Restore the previous successful save. Not available: no valid previous copy exists for this photograph"
          }
          style={{ display: "inline-block" }}
        >
          <button className="chip" disabled={!recovery.last_good} onClick={() => void resolveGraph(true)}>
            Use previous saved edits
          </button>
        </span>
        <button
          className="chip"
          data-hint="Save the edit on screen and keep the damaged file beside it under a .broken name; takes that cannot be read are not included"
          onClick={() => void resolveGraph(false)}
        >
          Save current edit instead
        </button>
      </div>}
  </>;
}
