import { useFolderWatcher } from "./ui/folderwatcher";
import { connectConsoleAssistant, setAssistantConfig, setAssistantPhoto, setPictureProvider, setWhereProvider } from "./assistant";
import { connectTours, setTourHost, tourStateChanged } from "./tourwalk";
import { connectAssistantChat } from "./assistantchat";
import { TourOverlay } from "./ui/touroverlay";
import { captureFacts, measurePicture, PICTURE_SAMPLE, pictureReportText } from "./assistantpicture";
import { describeForAssistant } from "./assistantvision";
import { photoFactsOf, whereFactsOf } from "./assistantphoto";
import { useScheduledCatalogBackup } from "./ui/catalogbackup";
import { catalogSaves } from "./savebarrier";
import { startTransition, useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { SelectDialogs } from "./ui/selectdialogs";
import { FileLayersDialog } from "./ui/filelayers";
import { CatalogLayerDialog } from "./ui/imagelayers";
import { DocsViewer } from "./ui/docsviewer";
import { BakeProgressDialog, OpProgressOverlay } from "./ui/opprogress";
import { handleApiAsync } from "./api";
import { onTauriEvent } from "./taurievents";
import { CONTROL_FLASH_MS, maskOverlayWanted, previewEdgeFor, previewTarget, reduce, settleJpegQuality } from "./state";
import type { BootStep, Command, State } from "./state";
import { initialState } from "./data";
import { uiSettingsCommands, uiSettingsSnapshot } from "./settings";
import { GraphPersistence } from "./ui/graphpersistence";
import { setThumbnailGraphs } from "./thumbs";
import { ResetAftermath } from "./ui/resetaftermath";
import {
  CMD_CHANNEL,
  RAISING_COMMANDS,
  raiseThisWindow,
  CONSOLE_LABEL,
  CONSOLE_PY_CHANNEL,
  DOCK_CHANNEL,
  GRAPH_KEY_CHANNEL,
  FRAME_CHANNEL,
  BEND_LABEL,
  SPECTRUM_LABEL,
  FRAME_REQUEST,
  STATE_CHANNEL,
  STATE_REQUEST,
  closeGraphWindow,
  closeBendWindow,
  closeSpectrumWindow,
  closeTakesWindow,
  closeToolWindow,
  restorePopoutFocus,
  graphSnapshot,
  openGraphWindow,
  rememberPopoutOpener,
  followPopout,
  openBendWindow,
  openSpectrumWindow,
  openTakesWindow,
  openToolWindow,
  TOOL_WINDOWS,
  transport,
  type ToolWindowKind,
  GRAPH_LABEL,
  TAKES_LABEL,
} from "./popout";
import {
  catalogUpgradeAlwaysBackup,
  catalogUpgradeApprove,
  catalogUpgradeCheck,
  debugAtLaunch,
  isTauri,
  onStitchProgress,
  onStackProgress,
  persistFlag,
  persistRating,
  renderMaskOf,
  renderOriginal,
  renderPane,
  renderPreview,
  cancelRender,
  settleWanted,
  saveSession,
  serializeGraph,
  serializeThumbnailGraph,
  settleFrameIsLive,
  releaseSettleFrames,
  discardSettleFrame,
  serveUpdate,
  loadUiSettings,
  imageMetadataAll,
  saveUiSettings,
  renderTimedOut,
  STACK_SET_ASIDE,
  PANO_CANCELED,
} from "./bridge";
import type { NodeRecipe } from "./noderecipes";
import { loadRecipeFiles, moveCatalogRecipes, runRecipeOps } from "./recipefiles";
import {
  compareTakeOf,
  cropPreviewGraph,
  paramRange,
  taggingTargets,
} from "./state";
import { handleKey, legend, moveWheel, quantize, stepFor } from "./keynav";
import { COMMANDS, bindingMap, bindingOf, keyBelongsToFocus, popoutGraphCommand } from "./hotkeys";
import { inScope, runCommand } from "./commands";
import { navSections, powerOnSection, SECTIONS } from "./ui/simple";
import {
  TopBar,
  TabRail,
  BrowserPanel,
  Ribbon,
  openFolderRemembering,
  refreshLibrary,
  restoreCatalogSession,
  revealActiveThumb,
} from "./ui/chrome";
import { Viewer } from "./ui/viewer";
import { quadGestureBlendId, transformPreviewPlan } from "./ui/transformpreview";
// The pump's retry policy lives in its own module: exported from here
// it defeated Vite's fast refresh, and every edit cost a full reload.
import { PREVIEW_RETRY_ATTEMPTS, isMissingSource, missingSourcePath, previewRetryDelay } from "./previewretry";

/** How long the hand stays off before the full-resolution settle
 * starts: long enough that a run of quick edits never queues a
 * whole-frame render between them (the engine's render lock would
 * hold the next reduced frame behind it), short enough to feel like
 * the picture settling rather than waiting. */
const SETTLE_DELAY_MS = 600;

/** How long a previewed section look (src/sectionlooks.ts) rests on
 * screen at the gesture tier before the sharper preview-tier frame of
 * it is asked for: a pointer moving down the looks menu gets the quick
 * frame of each row it stops on, and only the row it stays on pays
 * for the sharp one. */
const LOOK_REST_MS = 250;

/** Exact request identity: the whole serialized graph, not a hash of
 * it (the second pre-merge review found two exposures whose JSON had
 * the same length and the same djb2, and a collision here shows a
 * stale full-resolution frame, not a spare render).
 * The edit counter remains a freshness guard for in-flight work, not
 * a pixel identity: Undo can restore exactly the previous graph. Source
 * identity is checked separately, because the editor's state does not
 * describe files or rasters. The preview edges are NOT part of it: a
 * settle is the whole photograph at its own pixels whatever the stage,
 * so a window step should swap the last settle back in rather than
 * render it again; the reduced tier's memory fallback cannot pass as
 * a settle because a frame with a memory notice is never remembered. */
export function settleSignature(s: State): string {
  return JSON.stringify([
    s.activeImage,
    s.previewNonce,
    serializeGraph(s),
    previewTarget(s) ?? "",
    s.gamutView,
    maskOverlayWanted(s),
    s.prefs.maskOverlayColor ?? "red",
    s.brushOverlayStrength ?? 0.5,
    settleJpegQuality(s.prefs),
  ]);
}
import { QuadEditView } from "./ui/quadedit";
import { SimplePanel } from "./ui/simple";
import { framePixels } from "./ui/spectrum";
import { NodeEditor, Inspector, InspectorBar, GroupDialog } from "./ui/graph";
import { CanvasMode } from "./ui/canvas";
import { announceConsoleWindow, connectPySync, consoleWindowLive, echoEnabled, onConsoleWindow, pushEcho } from "./ui/console";
import { closeConsoleWindow, openConsoleWindow } from "./popout";
import { GraphElsewhere } from "./ui/graphelsewhere";
import { EchoTap } from "./echo";
import { checkForUpdates, launchCheckWanted } from "./updates";
import { UpdatePrompt } from "./ui/updates";
import { askCatalogUpgrade, noticeCatalogUpgradeDone } from "./catalogupgrade";
import { CatalogUpgradePrompt } from "./ui/catalogupgrade";
import { Splash } from "./ui/splash";
import { StitchDialog } from "./ui/stitching";
import { stackEventEffects } from "./ui/stackmerge";
import { ExportBar, ExportPanel } from "./ui/exportpanel";
import { PolishPanel } from "./ui/polish";
import { PanelDivider } from "./ui/divider";
import { fittedDragSize, useFittedState, useLayoutRoom } from "./ui/layoutroom";
import { BakeDialog } from "./ui/bake";
import { NodePalette, clampRecents } from "./ui/nodepalette";
import { Preferences } from "./ui/preferences";
import { CatalogDialog, ConfirmDialog } from "./ui/catalogui";
import { mergeSelection, stitchSelection } from "./ui/chrome";
import { addNodeAt } from "./ui/addnode";
import { setHintOverrides, useHintSource } from "./ui/hints";
import { StatusBar } from "./ui/statusbar";
import { CursorTip } from "./ui/cursortip";
import { FindControl } from "./ui/findcontrol";
import { logMsg } from "./log";
import { flashStatus, setHint } from "./ui/hints";
import { logDebug, setLogHome, setLogLevel } from "./log";
import { maskOfLayer } from "./layerids";

/** Crop/rotate geometry of the current graph as a string, so effects can
 * depend on it by value. A function of STATE, not of a render: the before
 * frame fetch below must re-derive it from whatever state is current when
 * the async render lands, or a stale response can win the race against a
 * crop change. */
function cropSigOf(s: State): string {
  const n = s.nodes.find((nd) => nd.type === "heeler.crop_rotate");
  return n
    ? `${n.enabled}|${n.params.angle ?? 0}|${n.params.crop_x ?? 0}|${n.params.crop_y ?? 0}|${n.params.crop_w ?? 1}|${n.params.crop_h ?? 1}`
    : "";
}

/** A frame lands. Mid-gesture (a slider or a stroke streaming) it
 * lands in a transition: the new picture re-renders the whole window,
 * the panels that read the frame with it, and as an ordinary update
 * that render held the main thread while the hand was still moving the
 * handle (a tester, 2026-09-30: "I do get a bit of jitter/lag on the
 * sliders"). As a transition React may split it across frames and
 * serve the handle first; it lands in the same order as the param
 * writes it follows, which ride transitions too (TrackSlider). At rest
 * a frame lands at once, as before, so a view switch never meets a
 * frame from the view it left. */
export function landFrame(snap: Pick<State, "gesture">, commit: () => void): void {
  if (snap.gesture !== null) startTransition(commit);
  else commit();
}

/** The multi-view's frames emptied, keeping the same object when they
 * already are, so React bails out instead of committing again. */
export function noFramesIfAny(prev: Record<string, string>): Record<string, string> {
  return Object.keys(prev).length === 0 ? prev : {};
}

/** Drag handle between panels. Reports pointer deltas; the caller turns
 * them into a set_panel_size dispatch. */
export function App() {
  const [state, innerDispatch] = useReducer(reduce, undefined, () => {
    const s = initialState();
    // The browser dev build keeps its bundled sample session. On the
    // desktop that session must never reach the screen: clearing it in
    // the boot effect ran after the first paint, and the test pattern
    // flashed before the splash went up (visibly so on macOS, where
    // WKWebView paints the first frame sooner than WebView2 did). So
    // the session starts empty and the splash starts raised, before
    // React ever commits a frame.
    if (!isTauri()) return s;
    return {
      ...reduce(s, { type: "begin_session_load" }),
      boot: { step: "catalog" as const, detail: "" },
    };
  });
  // Every dispatch passes one cheap gate on its way through: when echo
  // is on AND a console is actually showing, the command's Python
  // equivalent lands in the scrollback. Console closed = the tap does
  // nothing at all, which is the 3D-package lesson applied (echo left on
  // could never slow a closed console down).
  const echoTap = useRef<EchoTap | null>(null);
  if (!echoTap.current) echoTap.current = new EchoTap(pushEcho);
  const dispatch = useRef((cmd: Command) => {
    innerDispatch(cmd);
    if (
      echoEnabled() &&
      consoleWindowLive()
    ) {
      echoTap.current!.push(cmd);
    }
  }).current;
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  // The image the current previewUrl belongs to: the Viewer refuses frames
  // for any other image, which kills every stale-frame race at the display
  // layer no matter how async writes interleave.
  const [previewFor, setPreviewFor] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewMs, setPreviewMs] = useState<number | null>(null);
  const [previewBackend, setPreviewBackend] = useState<string | null>(null);
  // Counts finished engine renders. Its own state on purpose: a run of
  // renders with IDENTICAL times bails out of setPreviewMs (same
  // value), and the status bar's readout froze solid; this always
  // changes, so every finished render reaches the bar and ticks it.
  const [renderSeq, setRenderSeq] = useState(0);
  // Consecutive preview failures in the current retry run. Reset by a
  // success or an image switch; bounds the backoff below.
  const previewRetry = useRef(0);
  // Missing files already reported this session, so the console gets
  // ONE line per lost path instead of one per render attempt (The
  // report: "I see a lot of noise in the console"). Cleared on any
  // successful render, so a file that breaks again after a relink says
  // so again.
  const missingLogged = useRef(new Set<string>());
  // The last run's dependency snapshot, so the pump can say WHICH
  // change woke it (the audit's wake-reason line).
  const pumpWakeRef = useRef<Record<string, unknown>>({});
  // The selection mask on its own, laid over the frame while polishing.
  const [polishMask, setPolishMask] = useState<string | null>(null);
  // One rendered frame per take being compared, keyed by take id.
  const [multiFrames, setMultiFrames] = useState<Record<string, string>>({});
  // The untouched source at preview resolution, fetched lazily for
  // Before/After and split view so "before" is never a blurry thumbnail.
  const [original, setOriginal] = useState<{ url: string; for: string } | null>(
    null,
  );

  // Controls publish their help through data-hint; this picks it up for
  // the whole window and the viewer's status row prints it.
  useHintSource();
  // The panels fit the window (layoutfit.ts): the state learns the
  // room, and the panels draw `laid`, the saved layout folded and
  // shrunk to fit it, so the center never starves on a small window.
  useLayoutRoom(dispatch);
  const { laid } = useFittedState(state);
  // The browser build only: a door for the documentation's screenshot
  // harness (scripts/docshots.mjs) to load a graph and select nodes
  // without clicking its way there. Never present in the desktop app.
  useEffect(() => {
    if (isTauri()) return;
    (window as unknown as { __heeler?: unknown }).__heeler = {
      dispatch,
      state: () => stateRef.current,
    };
  }, [dispatch]);
  // The log scrubber learns where home is, so pasted bug reports say
  // a shortened photo path instead of carrying the username.
  useEffect(() => {
    if (!isTauri()) return;
    void import("@tauri-apps/api/path")
      .then((p) => p.homeDir())
      .then((h) => setLogHome(h))
      .catch(() => {});
  }, []);
  // The hints print live bindings, so remaps show the moment they land.
  useEffect(() => {
    setHintOverrides(state.prefs.hotkeys);
  }, [state.prefs.hotkeys]);
  // Find a Control's landing: scroll the outlined row into view, hold
  // the glance for a beat, then put the outline away.
  useEffect(() => {
    if (!state.controlFlash) return;
    const t1 = window.setTimeout(() => {
      const flash = state.controlFlash;
      if (!flash) return;
      // Scoped by section: param names repeat across sections
      // (`strength`, `amount`), and an unscoped querySelector returns
      // the first match in the document, which can be another
      // section's row while the gold outline lands on the right one.
      // CSS.escape: section titles carry spaces and "&".
      const sectionEl = document.querySelector(
        `[data-section="${CSS.escape(flash.section)}"]`,
      );
      const el = flash.param
        ? (sectionEl?.querySelector(`[data-param="${CSS.escape(flash.param)}"]`) ?? null)
        : // A section-level hit (a depth chip, the section itself) has
          // no row to name: scroll the section's box instead, or a hit
          // below the fold opens without ever coming into view.
          sectionEl;
      el?.scrollIntoView({ block: "center", behavior: "smooth" });
    }, 60);
    // Two seconds at full, four fading, then the state goes: the fade
    // itself is the .control-flash animation, and this is only the
    // clock that outlives it (2026-09-11).
    const t2 = window.setTimeout(() => dispatch({ type: "clear_control_flash" }), CONTROL_FLASH_MS);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.controlFlash]);

  // Tool settings outlive the session. "Should remember
  // the last selected selection tool. It seems to keep defaulting to
  // Freehand when the app relaunches."
  //
  // Loaded once, then written back whenever one changes. Kept out of
  // the undo stack and out of the graph: which lasso you last held is
  // not an edit to the photograph.
  const settingsLoaded = useRef(false);
  const [backupSettingsReady, setBackupSettingsReady] = useState(false);
  // Once per window, not once per mount: React's development
  // double-mount ran this twice, and two update checks meant two
  // prompts (2026-09-19). The ref outlives the simulated remount.
  const booted = useRef(false);
  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    void (async () => {
      // HEELER_DEBUG at launch: every command's timing from the first
      // one, the boot included (the console's switch cannot reach it).
      if (await debugAtLaunch()) setLogLevel("debug");
      const bootT0 = performance.now();
      // The catalog update gate comes first (26.3): when the active
      // catalog predates this build's schema, the backup choice is
      // answered before anything reads or writes it, and a quit means
      // nothing else loads. The gate itself is on the backend's open
      // path; this is only the prompt ahead of it.
      const pending = await catalogUpgradeCheck().catch(() => null);
      logMsg("info", `boot: catalog update check ${pending ? `pending v${pending.from} to v${pending.to}` : "clear"} after ${Math.round(performance.now() - bootT0)} ms`);
      if (pending) {
        // A question cannot wait behind the splash. The splash lifts on the
        // first decoded frame, and no frame can come while the catalog is held
        // at the gate, so the prompt sat under it until the splash's own
        // thirty-second backstop (2026-09-19: "The moment Heeler sees a version
        // mismatch it should just load the UI without any images and the
        // upgrade prompt"). The empty window and the card, at once.
        dispatch({ type: "dismiss_splash" });
        const alwaysBackup = await catalogUpgradeAlwaysBackup().catch(() => false);
        let approved = false;
        if (alwaysBackup) {
          try {
            const written = await catalogUpgradeApprove(pending.path, true);
            approved = true;
            if (written) void noticeCatalogUpgradeDone(pending, written);
          } catch {
            // The backup failed and approved nothing: fall back to the
            // prompt, which shows the error and offers the choices.
            approved = await askCatalogUpgrade(pending);
          }
        } else {
          approved = await askCatalogUpgrade(pending);
        }
        if (!approved) return; // Quit: the backend is closing the app.
        logMsg("info", `boot: catalog update answered after ${Math.round(performance.now() - bootT0)} ms`);
      }
      const json = await loadUiSettings();
      for (const command of uiSettingsCommands(json)) dispatch(command);
      settingsLoaded.current = true;
      // The node recipes this person saved: files in the recipes folder
      // since 2026-10-01 (recipefiles.ts). Ones still in the catalog
      // move into files first (each marked moved, the catalog's list
      // kept); one whose file could not be written still lists from
      // the catalog.
      {
        const left = await moveCatalogRecipes().catch(() => [] as NodeRecipe[]);
        const files = await loadRecipeFiles().catch(() => null);
        dispatch({ type: "set_user_recipes", recipes: [...(files ?? []), ...left] });
      }
      setBackupSettingsReady(true);
      // The launch update check follows its preference, read from the
      // same file so it starts now rather than a render later. Silent
      // unless a newer release exists (src/updates.ts).
      if (launchCheckWanted(json)) void checkForUpdates("launch");
    })();
  }, []);

  // The scripting bridge follows its switch: started when enabled,
  // stopped (and the discovery file removed) when not. The host below
  // answers what the Rust side forwards, against the live reducers.
  useEffect(() => {
    if (!isTauri()) return;
    void (async () => {
      const { invoke } = await import("@tauri-apps/api/core");
      if (state.apiEnabled) await invoke("api_start").catch(() => {});
      else await invoke("api_stop").catch(() => {});
    })();
  }, [state.apiEnabled]);

  useEffect(() => {
    if (!isTauri()) return;
    // Through the event hub (taurievents.ts): one Tauri listener for the
    // window's life, so StrictMode's double mount cannot leave Rust a
    // callback that is gone (the boot-time "Couldn't find callback id").
    return onTauriEvent<{ id: number; method: string; params: unknown }>("heeler-api", ({ id, method, params }) => {
      // Async all the way down: exports, merges and folder opens take
      // honest awaits, and the reply goes back when the work is done,
      // not when the dispatch returns.
      void handleApiAsync(stateRef.current, dispatch, method, params).then((result) => {
        void import("@tauri-apps/api/core").then(({ invoke }) => invoke("api_respond", { id, result }));
      });
    });
  }, []);

  useEffect(() => {
    // Lines from the Rust side: a stack that merged short a frame, a
    // panorama that left frames out. eprintln would go to a console a
    // packaged build does not have; this is the log the user can open.
    if (!isTauri()) return;
    return onTauriEvent<{ level: "error" | "warn" | "info" | "debug"; message: string }>("heeler:log", (p) =>
      logMsg(p.level, p.message),
    );
  }, []);

  // Save as Recipe, Rename and Remove reach the recipes folder: the
  // reducer queued them (state.recipeOps); they are taken off the queue
  // and run in order, then the folder is listed again.
  useEffect(() => {
    if (!state.recipeOps.length) return;
    const ops = state.recipeOps;
    dispatch({ type: "take_recipe_ops", count: ops.length });
    void runRecipeOps(ops, dispatch);
  }, [state.recipeOps]);

  // The snapshot itself is the dependency: a hand-kept list of fields
  // beside it is where the layout's fields would have been forgotten.
  const settingsJson = JSON.stringify(uiSettingsSnapshot(state));
  useEffect(() => {
    // Saving before the load has landed would overwrite the saved
    // settings with the defaults they are about to replace.
    if (!settingsLoaded.current) return;
    catalogSaves.arm("ui-settings", 250, () => saveUiSettings(settingsJson));
    return () => catalogSaves.cancelPending("ui-settings");
  }, [settingsJson]);

  // The popped-out console's half-duplex partner: this window's Python
  // runs broadcast to it, and its runs land here. The browser transport
  // carries the same announcements as native windows.
  useEffect(() => {
    const t = transport();
    const stopAssistant = connectConsoleAssistant("main", t);
    // Guided tours (src/tourwalk.ts): the Console asks, this window
    // walks them, over the same transport. A tour asked for from the
    // Console window brings this window to the front, so the keys the
    // tour's steps name (Shift+Space in Graph) reach it rather than the
    // Console (2026-09-29).
    const stopTours = connectTours("main", t, { onStart: raiseThisWindow });
    // The assistant's conversation lives here until Heeler quits
    // (src/assistantchat.ts); the Console shows it and asks through it.
    const stopChat = connectAssistantChat("main", t);
    connectPySync(
      (p) => t.send(CONSOLE_PY_CHANNEL, p),
      (fn) => t.subscribe(CONSOLE_PY_CHANNEL, fn)
    );
    return () => { stopAssistant(); stopTours(); stopChat(); };
  }, []);

  // The assistant's saved settings, for the Console window's Assistant
  // tab (src/assistant.ts): the preferences live here, the tab there.
  const { assistantEnabled, assistantAddress, assistantModel, assistantValidated } = state.prefs;
  useEffect(() => {
    setAssistantConfig({ enabled: assistantEnabled, address: assistantAddress, model: assistantModel, validated: assistantValidated });
  }, [assistantEnabled, assistantAddress, assistantModel, assistantValidated]);

  // The open photograph's facts for the assistant (src/assistantphoto.ts):
  // read only while it is on, and sent to the Console only when they
  // change (setAssistantPhoto compares).
  const assistantFacts = useMemo(
    () => (assistantEnabled ? photoFactsOf(state) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [assistantEnabled, state.nodes, state.images, state.activeImage],
  );
  useEffect(() => setAssistantPhoto(assistantFacts), [assistantFacts]);

  // LIVE shares: once the edit settles, re-render the active image into
  // the running share and mark it live, so a polling gallery or the /live
  // proofing page picks it up. The debounce is the difference between
  // "the iPad follows the edit" and "the engine renders every pixel of a
  // slider drag twice".
  useEffect(() => {
    if (!state.serveLive || !state.activeImage) return;
    const timer = window.setTimeout(() => {
      const st = stateRef.current;
      if (!st.serveLive || !st.activeImage) return;
      void serveUpdate(serializeGraph(st), st.activeImage, true).catch(() => {});
    }, 700);
    return () => window.clearTimeout(timer);
  }, [state.serveLive, state.activeImage, state.renderVersion]);

  // The popped-out graph window is a thin client: it sends commands here
  // to be reduced, and renders whatever snapshot we push back. Listening
  // unconditionally costs nothing when no such window exists.
  useEffect(() => {
    const off = [
      transport().subscribe(CMD_CHANNEL, (cmd: Command) => {
        dispatch(cmd);
        // A chapter link or Learn more in the Console opens the Help viewer
        // HERE; without coming forward it opened behind the Console that asked
        // (2026-09-28: "the guide didn't open").
        if (cmd && RAISING_COMMANDS.has(cmd.type)) raiseThisWindow();
      }),
      // A key pressed in the popped-out graph, already resolved to a
      // command there. Run here, where the state is, whatever this
      // window's own mode: the graph out there is live while it has the
      // keyboard, even with Develop showing here. Only graph commands
      // (and Undo, Redo) are taken, so a stray id cannot reach a
      // command the pop-out never offers.
      transport().subscribe(GRAPH_KEY_CHANNEL, (id: unknown) => {
        if (typeof id !== "string" || !popoutGraphCommand(id)) return;
        runCommand(id, stateRef.current, dispatch);
      }),
      transport().subscribe(DOCK_CHANNEL, (which: unknown) => {
        // The payload is the window's label, sent both by a window's own
        // Bring It Back button and by the Rust side when a window is
        // destroyed any other way (its close button, Alt+F4, the
        // taskbar). `true` is the graph window's older signal from
        // before there was a second pop-out to tell apart.
        if (which === SPECTRUM_LABEL) {
          dispatch({ type: "set_spectrums_popped_out", out: false });
          // Already gone when the close came from the window itself;
          // closing a label that is not there is a no-op by design.
          void closeSpectrumWindow();
        } else if (which === TAKES_LABEL) {
          dispatch({ type: "set_takes_popped_out", out: false });
          void closeTakesWindow();
        } else if (which === BEND_LABEL) {
          dispatch({ type: "set_bend_popped_out", out: false });
          void closeBendWindow();
        } else if (typeof which === "string" && which in TOOL_WINDOWS) {
          // Membership DERIVED from the registry: this branch was the
          // sixth hand-maintained list of tool windows, and the sixth
          // place the fourth tool was forgotten.
          const tool = which as ToolWindowKind;
          dispatch({ type: "set_tool_popped_out", tool, out: false });
          void closeToolWindow(tool);
        } else if (which === true || which === GRAPH_LABEL) {
          dispatch({ type: "set_graph_popped_out", out: false });
          // The window closed itself (its dock button) or is already
          // destroyed (OS close); either way the opener gets focus back,
          // the same courtesy the other pop-outs route through their
          // close helpers.
          restorePopoutFocus(GRAPH_LABEL);
        } else if (which === CONSOLE_LABEL) {
          // The console announces its own death from beforeunload, but that
          // broadcast rides an async send and can die with the webview. The Rust
          // side's report here is the one that always arrives; without it the
          // toggle stayed convinced the window was up and kept "closing" it. The
          // report: "when I went to re-open Console by clicking the Console
          // button... nothing happened."
          announceConsoleWindow(false);
          restorePopoutFocus(CONSOLE_LABEL);
        }
        // Any other label is a window this panel does not own; the bare
        // `else` this replaced read every unknown label as "graph".
      }),
    ];
    return () => off.forEach((f) => f());
  }, []);

  // Any thin-client window needs the state it renders from. The bend
  // window edits a real node, so it reads the same snapshot the graph
  // window does and sends its edits back the same way. The spectrum
  // window reads it too: its Harmony row edits session state.
  useEffect(() => {
    if (
      state.graphPoppedOut ||
      state.bendPoppedOut ||
      state.spectrumsPoppedOut ||
      state.takesPoppedOut ||
      // Derived from the registry: the hand-listed version forgot each
      // new window in turn.
      (Object.keys(TOOL_WINDOWS) as ToolWindowKind[]).some((k) => state.toolPopouts[k])
    )
      transport().send(STATE_CHANNEL, graphSnapshot(state));
  }, [state]);

  // And answer when a window asks, which is how one that opened after the
  // last change gets a snapshot at all. Registered once and reading
  // through the ref, so it always replies with the current state rather
  // than the first render's.
  useEffect(
    () =>
      transport().subscribe(STATE_REQUEST, () => {
        transport().send(STATE_CHANNEL, graphSnapshot(stateRef.current));
      }),
    [],
  );

  // Popping out opens the window; taking it back closes it.
  //
  // "I clicked the button in the main window to bring the
  // Bend circle back but it did not close the pop out." The close only
  // ever ran when the request came FROM the window, so the panel's own
  // bar flipped the flag here and left the window sitting there showing a
  // wheel the panel had already taken back.
  useEffect(() => followPopout(state.bendPoppedOut, "Color Bend", openBendWindow, closeBendWindow,
    () => dispatch({ type: "set_bend_popped_out", out: false })), [state.bendPoppedOut]);

  // The spectrum window plots a frame it cannot render for itself: the
  // engine and the graph are over here. Pushed on every new frame, which
  // is exactly when the plot is stale.
  // Same for the spectrums, which had the same hole in the same place.
  useEffect(() => followPopout(state.spectrumsPoppedOut, "Spectrums", openSpectrumWindow, closeSpectrumWindow,
    () => dispatch({ type: "set_spectrums_popped_out", out: false })), [state.spectrumsPoppedOut]);

  // The Takes window reads the snapshot for its list and sends every
  // edit home, the same contract as the spectrums.
  useEffect(() => followPopout(state.takesPoppedOut, "Takes", openTakesWindow, closeTakesWindow,
    () => dispatch({ type: "set_takes_popped_out", out: false })), [state.takesPoppedOut]);

  // The graph window follows its flag like the others, which is what
  // brings it back at launch from a saved layout; the pop-out button
  // only sets the flag now.
  useEffect(() => followPopout(state.graphPoppedOut, "Graph", openGraphWindow, closeGraphWindow,
    () => dispatch({ type: "set_graph_popped_out", out: false })), [state.graphPoppedOut]);

  // The console window is announced by the window itself; the flag in
  // state mirrors it so the layout can remember it, and drives it the
  // other way for a restore or Bring All Windows Back.
  useEffect(() => onConsoleWindow((open) => dispatch({ type: "set_console_window", open })), []);
  useEffect(() => {
    if (state.consoleWindowOpen === consoleWindowLive()) return;
    return followPopout(state.consoleWindowOpen, "Console", openConsoleWindow, closeConsoleWindow,
      () => dispatch({ type: "set_console_window", open: false }));
  }, [state.consoleWindowOpen]);

  // Same contract for the tool windows: the panel's flag is the truth,
  // and the window follows it in both directions. Only the tool whose
  // flag actually MOVED gets a call: the loop used to open-or-close all
  // three on every change, which is three IPC round trips (and three
  // browser-popup checks in dev) to flip one flag. The ref starts at
  // all-false rather than at the current value, so a restored state
  // that begins with a tool already out still opens its window on
  // mount.
  const prevToolPopouts = useRef(
    Object.fromEntries(
      (Object.keys(TOOL_WINDOWS) as ToolWindowKind[]).map((k) => [k, false]),
    ) as Record<ToolWindowKind, boolean>,
  );
  const toolRequests = useRef<Partial<Record<ToolWindowKind, () => void>>>({});
  useEffect(() => () => Object.values(toolRequests.current).forEach(stop => stop?.()), []);
  useEffect(() => {
    for (const tool of Object.keys(TOOL_WINDOWS) as ToolWindowKind[]) {
      if (state.toolPopouts[tool] === prevToolPopouts.current[tool]) continue;
      toolRequests.current[tool]?.();
      toolRequests.current[tool] = followPopout(state.toolPopouts[tool], TOOL_WINDOWS[tool].title,
        () => openToolWindow(tool), () => closeToolWindow(tool),
        () => dispatch({ type: "set_tool_popped_out", tool, out: false }));
    }
    prevToolPopouts.current = state.toolPopouts;
  }, [state.toolPopouts]);

  // A freshly opened tool window asks for state, but a request can go
  // missing while its webview is still wiring up its listeners. The
  // report: "Split Tone didn't work, then I enabled, then it worked":
  // the enable was a state change, and the push that rode on it was the
  // first message the window ever heard. Push unprompted for a few
  // seconds after opening, so a lost request cannot strand a window.
  // Every pop-out, not only the tool windows: a layout restored at
  // launch opens the graph, spectrums or takes window before the main
  // window has a state change to ride on.
  const popoutKey = JSON.stringify([
    state.graphPoppedOut,
    state.spectrumsPoppedOut,
    state.takesPoppedOut,
    state.bendPoppedOut,
    (Object.keys(TOOL_WINDOWS) as ToolWindowKind[]).map((k) => state.toolPopouts[k]),
  ]);
  useEffect(() => {
    if (!JSON.parse(popoutKey).flat().some(Boolean)) return;
    let n = 0;
    const timer = setInterval(() => {
      transport().send(STATE_CHANNEL, graphSnapshot(stateRef.current));
      if (++n >= 10) clearInterval(timer);
    }, 500);
    return () => clearInterval(timer);
  }, [popoutKey]);

  // What the pop-out windows plot. The engine's own frame when there is
  // one, and the photograph's thumbnail when there is not, which is
  // exactly the fallback the Adjustments panel has always had two hundred
  // lines below. Without it the panel plotted the thumbnail while the
  // popped-out window was sent null and said "No frame yet", so the same
  // photograph had scopes in one place and an empty box in the other (The
  // report: "you broke pop out for the Spectrums... Nothing displays").
  // The engine flag rides along so the window can say which of the two it
  // is drawing, the way the status bar does.
  const engineFrame = previewFor === state.activeImage ? previewUrl : null;
  const spectrumFrame =
    engineFrame ?? state.images.find((i) => i.id === state.activeImage)?.src ?? null;
  const spectrumFromEngine = engineFrame !== null;
  // The reply listener is registered once, so it reads the current frame
  // through a ref rather than closing over the first render's value.
  const spectrumFrameRef = useRef(spectrumFrame);
  spectrumFrameRef.current = spectrumFrame;
  const spectrumEngineRef = useRef(spectrumFromEngine);
  spectrumEngineRef.current = spectrumFromEngine;
  useEffect(() => {
    // The Relight window's histogram reads the same live frame the
    // spectrums do, so both windows are on this push.
    if (state.spectrumsPoppedOut || state.toolPopouts.toneeq || state.toolPopouts.recolor)
      transport().send(FRAME_CHANNEL, { frame: spectrumFrame, engine: spectrumFromEngine });
  }, [
    state.spectrumsPoppedOut,
    state.toolPopouts.toneeq,
    state.toolPopouts.recolor,
    spectrumFrame,
    spectrumFromEngine,
  ]);

  // And answer when it asks, which is how a window that opened after the
  // last frame was sent gets one at all.
  useEffect(
    () =>
      transport().subscribe(FRAME_REQUEST, () => {
        transport().send(FRAME_CHANNEL, {
          frame: spectrumFrameRef.current,
          engine: spectrumEngineRef.current,
        });
      }),
    [],
  );

  // The keys are announced in the status row rather than in a panel of
  // their own: it is already the place the app explains itself, and a
  // mode with no visible way out is a trap.
  useEffect(() => {
    if (state.keynav) setHint(legend(state.keynav));
    else setHint(null);
  }, [state.keynav]);

  // A stitch happens inside the render call, so the only way to know it
  // is running is for the backend to say so. The "done" event closes the
  // dialog on both the success and failure paths; a failure keeps it up
  // with the reason, because a panorama that silently does not appear is
  // the thing this exists to prevent.
  useEffect(
    () =>
      onStitchProgress((p) => {
        if (p.done && !p.error) {
          dispatch({ type: "set_stitch_progress", progress: null });
          return;
        }
        // Canceled: the card says so and offers Stitch again, and the
        // panorama is not asked for again until then.
        if (p.done && (p.canceled || p.error === PANO_CANCELED)) {
          dispatch({ type: "set_stitch_canceled", image: p.image_id, on: true });
          dispatch({ type: "set_stitch_progress", progress: { image: p.image_id, fraction: p.fraction, stage: p.stage, error: null, canceled: true } });
          return;
        }
        dispatch({
          type: "set_stitch_progress",
          progress: {
            image: p.image_id,
            fraction: p.fraction,
            stage: p.stage,
            error: p.error ?? null,
            ...(p.frames !== undefined ? { frames: p.frames } : {}),
            ...(p.full !== undefined ? { full: p.full } : {}),
            ...(p.elapsed_ms !== undefined ? { elapsedMs: p.elapsed_ms } : {}),
            ...(p.job_id ? { jobId: p.job_id } : {}),
          },
        });
      }),
    [],
  );

  // Progress can miss its final event after a worker panic or webview
  // disconnect. A quiet merge must not suspend the render pump forever.
  useEffect(() => {
    const jobs = new Map<string, { at: number; progress: NonNullable<ReturnType<typeof stackEventEffects>["progress"]> }>();
    const showImage = (image: string) => {
      const running = [...jobs.values()].filter((j) => j.progress.image === image);
      const progress = running.find((j) => !j.progress.full)?.progress ?? running[running.length - 1]?.progress ?? null;
      dispatch({ type: "set_stack_progress", image, progress });
    };
    const unlisten = onStackProgress((p) => {
      const key = p.job_id ?? `${p.image_id}|${p.full}`;
      const { progress, rerender, failure } = stackEventEffects(p);
      if (progress) jobs.set(key, { at: Date.now(), progress });
      else jobs.delete(key);
      showImage(p.image_id);
      // Canceled by the user: the viewer stops asking for it until
      // Merge again, after showImage so another tier's last word
      // cannot clear the mark it is setting.
      if (p.finished && p.canceled) dispatch({ type: "set_stack_canceled", image: p.image_id, on: true });
      if (failure) {
        logMsg("error", `Stack merge failed: ${failure}`);
        flashStatus(`Stack merge failed: ${failure}`, 10000);
      }
      if (rerender && stateRef.current.activeImage === p.image_id) dispatch({ type: "bump_preview" });
    });
    const timer = setInterval(() => {
      for (const [key, job] of jobs) {
        if (Date.now() - job.at < 90_000) continue;
        jobs.delete(key);
        const image = job.progress.image;
        showImage(image);
        if (stateRef.current.activeImage === image) dispatch({ type: "bump_preview" });
      }
    }, 10_000);
    return () => { unlisten(); clearInterval(timer); };
  }, []);

  // What the commands need that the reducer cannot do for itself.
  const commandContext = {
    openFolder: () => {
      void openFolderRemembering(
        undefined,
        stateRef.current.folderTree,
        dispatch,
        stateRef.current.prefs.thumbnailEdge,
      );
    },
    rate: (stars: number) => {
      for (const id of taggingTargets(stateRef.current))
        void persistRating(id, stars);
    },
    flag: (f: "" | "pick" | "reject") => {
      for (const id of taggingTargets(stateRef.current))
        void persistFlag(id, f);
    },
    merge: (mode: string) =>
      void mergeSelection(stateRef.current, dispatch, mode),
    stitch: () => void stitchSelection(stateRef.current, dispatch),
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Typing swallows shortcuts on purpose: pressing P in a rename box
      // must not flag the photograph. The rule (sliders are not typing,
      // dialogs keep their keys, the tour card is not a dialog) is
      // shared with the popped-out graph window: keyBelongsToFocus.
      if (keyBelongsToFocus(e)) return;

      // Keyboard navigation of the develop controls. While it is on it
      // gets first refusal on every key, so that pressing S to choose a
      // section does not also toggle something; anything it does not
      // claim falls through to the shortcuts below.
      const st = stateRef.current;
      if (st.keynav) {
        const sections = navSections(st);
        // With Option held, macOS rewrites the letter before it reaches e.key
        // (Option+C arrives as "ç"), so the hint never matched and ALT-to-fold
        // only worked on Windows. "I tried all the modifiers here
        // on the mac and they aren't working and I know this worked on
        // Windows." The physical key code says which letter the finger
        // pressed, whatever the layout typed.
        const navKey =
          e.altKey && /^Key[A-Z]$/.test(e.code) ? e.code.slice(3).toLowerCase() : e.key;
        const action = handleKey(st.keynav, sections, navKey, e.shiftKey, e.altKey);
        if (action) {
          e.preventDefault();
          if (action.kind === "fold") {
            // Fold only: an open section closes, a closed one stays
            // closed (toggle would re-open, which is what plain letters
            // are for). Navigation stays up for the next letter.
            if (!st.sectionsClosed.includes(action.section)) {
              dispatch({ type: "toggle_section", title: action.section });
            }
          } else if (action.kind === "state") {
            dispatch({ type: "set_keynav", nav: action.nav });
          } else {
            const { target, axis, delta } = action;
            const node = st.nodes.find((n) => n.id === target.nodeId);
            if (target.kind === "switch") {
              // An off section's one target is its power switch: d (the
              // positive direction) builds and opens it, through the
              // same helper the switch's own click uses. a is a no-op:
              // the section is already off.
              if (delta > 0) {
                const sec = SECTIONS.find((x) => x.title === target.section);
                if (sec) powerOnSection(sec, dispatch, st.prefs.expandSectionOnEnable);
              }
            } else if (target.kind === "wheel") {
              // A wheel moves in x and y, and its angle and radius are
              // worked out from where the puck ends up. Both params are
              // written together so the puck makes one move rather than
              // two, and so the numbers under it agree with it.
              const prefix = target.param.replace(/_hue$/, "");
              const moved = moveWheel(
                node?.params[`${prefix}_hue`] ?? 0,
                node?.params[`${prefix}_sat`] ?? 0,
                axis,
                delta,
                stepFor([0, 100], e.shiftKey),
              );
              dispatch({
                type: "set_params",
                id: target.nodeId,
                values: {
                  [`${prefix}_hue`]: moved.hue,
                  [`${prefix}_sat`]: moved.sat,
                },
                // A gesture, so the harmony aid bends it like a drag.
                harmonize: true,
              });
            } else {
              const range = paramRange(target.param, node?.type);
              const stepSize = stepFor(range, e.shiftKey);
              const cur = node?.params[target.param] ?? 0;
              dispatch({
                type: "set_param",
                id: target.nodeId,
                param: target.param,
                value: quantize(cur + stepSize * delta, stepSize),
              });
            }
          }
          return;
        }
        // Escape is handled inside the model; anything else unclaimed
        // carries on to the shortcuts below.
      }
      // Arrows first, because they are bound to stepping through photos
      // but have to stand aside for anything that reads them itself: a
      // color wheel and a slider both nudge on arrow keys, and
      // swallowing those to add one navigation shortcut is a bad trade.
      if (
        (e.key === "ArrowUp" || e.key === "ArrowDown") &&
        !e.ctrlKey &&
        !e.metaKey
      ) {
        // input[type=range] has an implicit slider role, which an
        // attribute selector does not match, so it is named outright.
        const owner = (e.target as HTMLElement)?.closest?.(
          '[role="slider"], [role="listbox"], [contenteditable="true"], select, input[type="range"]',
        );
        if (owner) return;
      }

      // Everything with a binding runs from the registry, so what the
      // preferences editor shows is what actually happens and rebinding
      // a command changes the key rather than just the label.
      const binding = bindingOf(e);
      for (const id of bindingMap(st.prefs.hotkeys).get(binding) ?? []) {
        const spec = COMMANDS.find((c) => c.id === id);
        if (!spec || !inScope(spec.scope, st.mode)) continue;
        if (runCommand(id, st, dispatch, commandContext)) {
          e.preventDefault();
          return;
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    state.mode,
    state.selection,
    state.activeImage,
    state.tool,
    state.imageSelection,
    state.images,
  ]);

  // Library boot: populate folders/collections, and inside Tauri resume
  // the previous session: rebuild the folder tree from its saved root,
  // expand the ancestor chain, and reopen the folder the user was in.
  // The browser dev build keeps its sample session.
  useEffect(() => {
    void refreshLibrary(dispatch);
    if (!isTauri()) return;
    // The sample session is already gone and the splash already up: the
    // reducer's initializer did both, because doing them here runs after
    // the first paint and the test image flashed.
    // The splash reports each of these as it completes, so the user sees
    // what is actually taking the time.
    const step = (s: BootStep, detail = "") =>
      dispatch({ type: "boot_step", step: s, detail });
    // Backstop: a call that never settles must not leave the splash
    // covering the app forever. Generous, because a cold catalog on a
    // slow drive is legitimately slow.
    const stuck = setTimeout(() => step("ready"), 30_000);
    // Whether the boot landed on a photograph. If it did, the splash
    // hands over to "render" and waits for a frame rather than going
    // straight to ready: see the effect below.
    let landedOnPhoto = false;
    (async () => {
      try {
        // The same restore that runs when the user switches catalogs
        // mid-session; boot's only extra is the splash reporting.
        const landed = await restoreCatalogSession(
          dispatch,
          step,
          stateRef.current.prefs.thumbnailEdge,
        );
        landedOnPhoto = landed === "photo";
      } finally {
        // Whatever happened, including a throw or an early return, the
        // splash hands over. A boot that fails should land you in an
        // empty app, never behind a screen with no way past it.
        clearTimeout(stuck);
        step(landedOnPhoto ? "render" : "ready");
      }
    })();
  }, []);

  // A failed scheduled backup is a dialog, not only a flash.
  const notifyBackupFailure = useCallback(
    (message: string) => dispatch({ type: "ask_confirm", action: { kind: "backup_failed", message } }),
    [],
  );
  useScheduledCatalogBackup(backupSettingsReady, state.prefs.backupFolder, state.prefs.backupEveryDays, notifyBackupFailure);

  // The splash waits for the first frame to actually decode.
  //
  // Reading the catalog is not the same as having something to look at.
  // Lifting the splash at "image" uncovers a viewer whose <img> has a
  // src it has not fetched yet, and what shows in that gap is the alt
  // text: the app appears to boot into the words "Photograph in the
  // viewer". Decoding it here also means the <img> paints from cache the
  // instant it is uncovered.
  useEffect(() => {
    if (state.boot?.step !== "render") return;
    const done = () => dispatch({ type: "boot_step", step: "ready" });
    // Backstop, for the same reason the catalog has one: a render that
    // never lands must not leave the splash covering the app forever.
    const stuck = setTimeout(done, 20_000);
    let live = true;
    // The ENGINE's frame, not the fallback thumbnail the pop-outs now
    // accept: a thumbnail decodes at once and would drop the splash
    // before the render it is waiting for has landed.
    if (engineFrame) {
      const probe = new Image();
      // Either way the wait is over: a frame that will not decode is not
      // going to start, and the viewer is a better place to see that.
      probe.onload = probe.onerror = () => live && done();
      probe.src = engineFrame;
    }
    return () => {
      live = false;
      clearTimeout(stuck);
    };
  }, [state.boot?.step, engineFrame]);

  // The restored photograph's thumbnail, brought into view.
  //
  // "it does go to my last selected photo but the thumbnail
  // needs to auto-scroll so its centered in the thumbnail view." Keyed
  // on the image rather than on boot, so opening a folder that remembers
  // a photo scrolls to it too; skipped when the thumbnail is already on
  // screen, so clicking a visible one never yanks the strip; and no
  // pulse, since the app did this rather than the person asking for it.
  //
  // Deliberately no `expand`. This fires on every change of active
  // photo, so anything it opens, it opens while the user is just
  // browsing. A collapsed strip stays collapsed.
  const scrolledTo = useRef<string | null>(null);
  useEffect(() => {
    const id = state.activeImage;
    if (!id || !state.images.some((i) => i.id === id)) return;
    if (scrolledTo.current === id) return;
    scrolledTo.current = id;
    revealActiveThumb(stateRef.current, dispatch, {
      pulse: false,
      behavior: "auto",
      onlyIfOffscreen: true,
    });
  }, [state.activeImage, state.images]);

  // The reset aftermath (archive, badge, thumbnail) and an undone
  // reset's write-back drain in ResetAftermath, rendered below.

  // Quad edit's pane frames: each member rendered through its own
  // mirrored graph. Keyed on renderVersion like the main preview pump,
  // debounced a touch harder: four engine renders per slider tick would
  // fight the driver's own preview for the executor.
  const [quadFrames, setQuadFrames] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!isTauri() || !state.quadEdit) {
      if (Object.keys(quadFrames).length > 0) setQuadFrames({});
      return;
    }
    let live = true;
    const timer = setTimeout(async () => {
      const s = stateRef.current;
      const q = s.quadEdit;
      if (!q) return;
      for (const [id, g] of Object.entries(s.quadGraphs)) {
        const src = await renderPane(
          { ...s, nodes: g.nodes, wires: g.wires } as State,
          id,
          1000,
        ).catch(() => null);
        if (!live) return;
        if (src) setQuadFrames((f) => ({ ...f, [id]: src }));
      }
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [state.quadEdit, state.quadGraphs, state.renderVersion]);

  // Engine previews render in a throttle loop, not a debounce: the first
  // change renders immediately, and while a drag streams changes the loop
  // keeps re-rendering the LATEST state as fast as the engine finishes.
  // A debounce here postponed every frame until the drag paused, which
  // felt like no feedback until mouse-up.
  const stateRef = useRef(state);
  stateRef.current = state;

  // A guided tour walks here (src/tourwalk.ts): it reads the state and
  // may dispatch view commands only (a mode, a tab, a section opened),
  // and each new state may complete its step.
  useEffect(() => {
    setTourHost({ getState: () => stateRef.current, dispatch });
    return () => setTourHost(null);
  }, [dispatch]);
  useEffect(() => {
    tourStateChanged();
  }, [state]);

  // The assistant's picture report (src/assistantpicture.ts): measured
  // from the frame the viewer and the Spectrums show, read at up to
  // 2048 pixels across, only while the assistant is on and only when a
  // question asks for it. The file's metadata gives the capture time and
  // the sun's height; its position is used here and never sent. With
  // Florence-2 installed, it describes the same frame alongside
  // (src/assistantvision.ts), each region measured from the same
  // pixels, within its own time limit; one reply carries both.
  useEffect(() => {
    if (!assistantEnabled) {
      setPictureProvider(null);
      return;
    }
    setPictureProvider(async (question) => {
      const id = stateRef.current.activeImage;
      const src = spectrumFrameRef.current;
      if (!id || !src) return null;
      const pixels = framePixels(src, PICTURE_SAMPLE);
      const [frame, lines, vision] = await Promise.all([
        pixels,
        imageMetadataAll(id).catch(() => []),
        describeForAssistant({ frameUrl: src, frame: pixels, question }),
      ]);
      const report = pictureReportText(frame ? measurePicture(frame) : null, captureFacts(lines), !spectrumEngineRef.current);
      return { report, vision: vision.text, visionLog: vision.logText, florence: vision.status };
    });
    return () => setPictureProvider(null);
  }, [assistantEnabled]);
  // Where the user is (the workspace, the tab, the tool, the layer, the
  // selected nodes' types), read from the live state when a question is
  // asked, never before (src/assistantphoto.ts, whereFactsOf).
  useEffect(() => {
    setWhereProvider(assistantEnabled ? () => whereFactsOf(stateRef.current) : null);
    return () => setWhereProvider(null);
  }, [assistantEnabled]);
  // A merge has no embedded preview, so its thumbnail renders through
  // the graph the viewer opens it with, read from the live state when
  // the cell asks.
  useEffect(() => {
    setThumbnailGraphs((id, name, source) => serializeThumbnailGraph(stateRef.current, id, name, source));
    return () => setThumbnailGraphs(() => null);
  }, []);
  const renderBusy = useRef(false);
  // Whether the frame on screen shows a held section look. After the
  // press ends, a render that fails must not leave the look standing in
  // for the photograph ("holding the last good frame" is the right
  // answer for the photograph's own frame, never for a look).
  const lookOnScreen = useRef(false);
  /** the token of the full-resolution settle (or a previewed look's
   * sharp frame) in flight, canceled the moment the pump wakes for
   * something newer */
  const settleInFlight = useRef<string | null>(null);
  // The last settle that landed: what it was asked for and the frame it
  // gave. A settle that would ask for the same picture again (a gesture
  // that opened and closed with no net change, a click on a card, a
  // window step back to the same edge: the reduced frame re-renders
  // and the settle would follow) swaps this frame back in after checking its source and decoding it
  // (the pre-merge review's R3: a redundant whole-frame encode, about
  // 620 ms on a 24 megapixel photograph). Skipping the settle instead
  // would leave the reduced frame on screen, a step down the user
  // would see.
  const lastSettle = useRef<{ sig: string; url: string; imageId: string; sourceIdentity: string } | null>(null);
  /** Photographs that have landed a frame this session: their next
   * slow render is a real one, not the cold decode. */
  const warmRenders = useRef(new Set<string>());
  const renderDirty = useRef(false);
  /** Cuts the pump's rest before a look's sharp frame short: set while
   * the pump waits, called when it wakes for something newer, so the
   * next row's quick frame is never held behind the last row's rest. */
  const restWake = useRef<(() => void) | null>(null);

  // Remember which image is open so relaunch (and re-picking the folder)
  // returns to it, not just to its folder. Debounced: culling through a
  // folder should not thrash the catalog with a write per arrow key.
  // Runs in the browser build too: saveSession writes the mock library
  // there, which keeps dev and tests honest about what the desktop saves.
  useEffect(() => {
    const root = state.folderTree?.path;
    const folder = state.activeFolderPath;
    if (!root || !folder) return;
    catalogSaves.arm("session", 600, () => saveSession(root, folder, state.activeImage));
    return () => catalogSaves.cancelPending("session");
  }, [state.activeImage, state.activeFolderPath, state.folderTree?.path]);

  useFolderWatcher(stateRef, dispatch);

  // Switching images drops the previous image's frame instantly so the
  // viewer never shows a stale render of the wrong photo.
  useEffect(() => {
    lastSettle.current = null;
    releaseSettleFrames();
    setPreviewUrl(null);
    setPreviewError(null);
    setPreviewMs(null);
    previewRetry.current = 0;
  }, [state.activeImage]);

  // Returning to the app after the machine slept is exactly when a wedged
  // render needs re-asking for (see previewRetry below), and a throttled
  // webview may not have run its effects while hidden. A nudge costs one
  // cache-hit render.
  useEffect(() => {
    if (!isTauri()) return;
    const nudge = () => {
      if (document.visibilityState === "visible") {
        dispatch({ type: "bump_preview" });
      }
    };
    window.addEventListener("focus", nudge);
    document.addEventListener("visibilitychange", nudge);
    return () => {
      window.removeEventListener("focus", nudge);
      document.removeEventListener("visibilitychange", nudge);
    };
  }, []);

  // The before-frame follows the crop: refetch when geometry changes so
  // both comparison sides always share framing. cropSigOf is a function
  // of STATE, not of this render, because the async guard below must
  // re-derive it from the state that is current when the fetch lands.
  const cropSig = cropSigOf(state);
  // What "before" means: the untouched original, or
  // ("switch up Before/After with take numbers") another take's
  // rendered graph. The take applies to SPLIT only; Before/After is
  // always original against current (the owner's revision: "I don't
  // think we need the dropdown for takes for Before/After"). The
  // source rides the key, so switching it refetches.
  const beforeTake = state.splitOn ? state.compareTake : null;
  const beforeKey = `${state.activeImage}|${cropSig}|${beforeTake ?? "original"}`;
  useEffect(() => {
    if (!isTauri()) return;
    if (!state.compare && !state.splitOn) return;
    const key = beforeKey;
    if (original?.for === key) return;
    if (!state.activeImage) return;
    const take = beforeTake ? compareTakeOf(stateRef.current) : null;
    const fetch = take
      ? renderPreview({ ...stateRef.current, nodes: take.nodes, wires: take.wires }).then(
          (r) => (r.url ? { url: r.url } : null),
        )
      : renderOriginal(stateRef.current);
    void fetch.then((result) => {
      const cur = stateRef.current;
      // Re-derive from the state at land time, not the render-time cropSig:
      // using the closure here would compare a stale key against itself and
      // let a fetch issued before a crop change install its old frame.
      const nowKey = `${cur.activeImage}|${cropSigOf(cur)}|${(cur.splitOn ? cur.compareTake : null) ?? "original"}`;
      if (result && nowKey === key) {
        setOriginal({ url: result.url, for: key });
      }
    });
  }, [state.compare, state.splitOn, state.activeImage, cropSig, beforeTake]);

  // A transform drag paints its own pixels: TransformPreview draws the
  // layer through the quad locally, and this pump rendering per
  // mousemove on top of it was the lag the gizmo outran. One render on
  // release (the dependency flip below re-fires this effect when the
  // gesture ends) is the frame that stays. Only a layer the preview can
  // actually draw qualifies; anything else keeps the old per-mousemove
  // path, because no feedback is worse than late feedback.
  const quadPreview =
    (quadGestureBlendId(state.gesture) ?? "") !== "" &&
    transformPreviewPlan(state, quadGestureBlendId(state.gesture)!) !== null;

  useEffect(() => {
    if (!isTauri()) return;
    if (quadPreview) return;
    // Which dependency woke the pump: mirrors the effect's dep list
    // below, diffed against the last run. "It keeps re-rendering" and
    // "it did not re-render" both start with this line.
    {
      const wake: Record<string, unknown> = {
        renderVersion: state.renderVersion,
        activeImage: state.activeImage,
        tool: state.tool,
        maskView: state.maskView,
        depthView: state.depthView,
        halationView: state.halationView,
        collisionView: state.collisionView,
        collisionTolerance: state.collisionTolerance,
        bwSeparate: state.bwSeparate,
        zonesView: state.zonesView,
        zoneHover: state.zoneHover,
        activeLayer: state.activeLayer,
        previewNonce: state.previewNonce,
        quadPreview,
        probeNode: state.probeNode,
        csetMaskView: state.csetMaskView,
        csetDropper: state.csetDropper,
        gamutView: state.gamutView,
        maskRed: state.maskRed,
        maskOverlayColor: state.prefs.maskOverlayColor,
        // The edge the settled render asks for: the preference raised
        // to the stage's device pixels, in steps of 256, so a window
        // dragged wider re-renders at the wider edge once it crosses a
        // step and a nudge wakes nothing (the groups review's R4: the
        // stage was measured and the pump never asked).
        previewEdge: previewEdgeFor(state),
        gesturePreviewEdge: state.prefs.gesturePreviewEdge,
        settledPreview: state.prefs.settledPreview,
        settleQuality: state.prefs.settleQuality,
        graphLoading: state.graphLoading,
        panelTab: state.panelTab,
        artActive: state.artActive,
        selection: state.selection.join(","),
        gestureReleased: state.gesture === null,
        lookPreview: state.lookPreview,
      };
      const prev = pumpWakeRef.current;
      const changed = Object.keys(wake).filter((k) => wake[k] !== prev[k]);
      pumpWakeRef.current = wake;
      if (Object.keys(prev).length && changed.length === 0) return;
      if (Object.keys(prev).length && changed.length) {
        logDebug(() => `render pump: woke on ${changed.join(", ")}`);
      }
    }
    const pump = async () => {
      if (renderBusy.current) {
        renderDirty.current = true;
        restWake.current?.();
        logDebug("render pump: render in flight, marked dirty for another pass");
        // A full-resolution settle in flight gives way at once: the
        // engine stops it between nodes and the reduced frame for this
        // edit is not held behind it.
        const token = settleInFlight.current;
        if (token) {
          settleInFlight.current = null;
          logDebug(() => `render pump: canceling ${token}`);
          void cancelRender(token);
        }
        return;
      }
      renderBusy.current = true;
      try {
        // The outer pass: the reduced frame, then the full-resolution
        // settle when the preference asks for it, then again if either
        // was overtaken by an edit.
        do {
        let landed: { image: string; version: number; sourceIdentity?: string; look: string | null } | null = null;
        do {
          renderDirty.current = false;
          landed = null;
          const snap = stateRef.current;
          const imageAtStart = snap.activeImage;
          // Nothing open (fresh boot, empty folder): there is no
          // photograph to render, and asking the engine anyway is how
          // a demo-era "sample image" error reached the screen.
          if (!imageAtStart) {
            setPreviewUrl(null);
            setPreviewFor(null);
            setPreviewError(null);
            break;
          }
          // A stack the user canceled is not asked for again: every request
          // would start its merge over (2026-10-07: "canceling a merge does not
          // cancel. it keeps restarting"). The frame on screen stays, and the
          // viewer offers Merge again.
          if (snap.stackCanceled[imageAtStart]) {
            logDebug(() => `render pump: ${imageAtStart} is a canceled stack; not rendering it until Merge again`);
            previewRetry.current = 0;
            break;
          }
          // The same for a panorama the user canceled: Stitch again.
          if (snap.stitchCanceled[imageAtStart]) {
            logDebug(() => `render pump: ${imageAtStart} is a canceled panorama; not rendering it until Stitch again`);
            previewRetry.current = 0;
            break;
          }
          // The saved graph is still being read from disk, so the graph
          // on hand is the fresh template. Rendering it put the
          // photograph's unedited look on screen for a beat between the
          // edited thumbnail and the edited render, on every click
          // ("it seems to flash through all the layers of editing
          // starting with the image in its original state"). The
          // thumbnail holds; the read's settle wakes this effect again.
          if (snap.graphLoading === imageAtStart) {
            logDebug(() => `render pump: ${imageAtStart} waiting for its saved graph, nothing rendered`);
            break;
          }
          // Crop tool previews the UNCROPPED frame so the crop rectangle
          // overlays the full image instead of an already-cropped render.
          const sendState =
            snap.tool === "crop"
              ? { ...snap, ...cropPreviewGraph(snap) }
              : snap;
          logDebug(
            () =>
              `render pump: request for ${imageAtStart} tier=${snap.gesture ? "fast" : "preview"} tool=${snap.tool ?? "none"} v${snap.renderVersion}`,
          );
          // A view can change without changing the edit clock. Never
          // deliver an old photograph over a depth or mask view, even
          // when the switch happened during image decoding.
          const viewIsCurrent = () => {
            const now = stateRef.current;
            return now.activeImage === imageAtStart &&
              now.previewNonce === snap.previewNonce &&
              // A held look's frame never lands after the press ends,
              // and the photograph's never lands over a held look.
              now.lookPreview === snap.lookPreview &&
              previewTarget(now) === previewTarget(snap) &&
              now.gamutView === snap.gamutView &&
              maskOverlayWanted(now) === maskOverlayWanted(snap) &&
              now.prefs.maskOverlayColor === snap.prefs.maskOverlayColor &&
              now.brushOverlayStrength === snap.brushOverlayStrength;
          };
          const pumpT0 = performance.now();
          const result = await renderPreview(sendState);
          const staleImage =
            stateRef.current.activeImage !== imageAtStart ||
            (result.imageId !== undefined &&
              result.imageId !== stateRef.current.activeImage);
          if (staleImage || !viewIsCurrent()) {
            // Frame belongs to a different image: discard and go again.
            logDebug(
              () =>
                `render pump: SUPERSEDED frame for ${result.imageId ?? imageAtStart} (active now ${stateRef.current.activeImage}) after ${Math.round(performance.now() - pumpT0)}ms, discarded`,
            );
            renderDirty.current = true;
            continue;
          }
          // A failed render must not blank the viewer. It used to write
          // previewUrl=null, which dropped the screen to the raw photo plus a CSS
          // guess (the APPROX badge) even though a perfectly recent engine frame
          // was sitting right there, and if the failure was one wedged render
          // rather than a clean error, the await above never even returned, so
          // NOTHING repainted until the call happened to resolve. The owner, after
          // leaving the app idle for hours: "I turned off the gradient layer but
          // the gradient is still visible... when I went back to the image it was
          // pixelated and low resolution." Keep the last frame, say so, and ask
          // again with backoff.
          if (result.error && lookOnScreen.current && snap.lookPreview === null) {
            lookOnScreen.current = false;
            setPreviewUrl(null);
            logDebug(() => `render pump: the photograph's frame after a held look failed, the look taken off screen`);
          }
          if (result.memoryNotice) flashStatus(result.memoryNotice, 10000);
          if (result.error && /Not enough memory|exceed addressable memory/.test(result.error)) {
            flashStatus(result.error, 10000);
            setPreviewError(result.error);
            previewRetry.current = 0;
            break;
          }
          // A stack still merging: the request outlived its deadline
          // while the backend works through the frames. That
          // is no failure, and retrying only queues another wait behind
          // the same merge; its finished event renders again.
          // A merge the backend stopped on purpose (canceled, the viewer
          // moved on, its frames changed) is no failure, and a retry
          // would start it over. What comes next is decided elsewhere:
          // Merge again, the photograph now open, or the edit itself.
          if (result.error === PANO_CANCELED) {
            logDebug(() => `render pump: ${imageAtStart}'s stitch was canceled; not retrying`);
            previewRetry.current = 0;
            break;
          }
          if (result.error?.startsWith(STACK_SET_ASIDE)) {
            logDebug(() => `render pump: ${imageAtStart}'s stack merge was set aside (${result.error}); not retrying`);
            previewRetry.current = 0;
            break;
          }
          if (renderTimedOut("render_preview", result.error) && stateRef.current.stackMerges[imageAtStart]?.full === false) {
            logDebug(() => `render pump: ${imageAtStart} is still merging its stack; waiting for it, not retrying`);
            previewRetry.current = 0;
            break;
          }
          if (result.error) {
            logDebug(() => `render pump: error for ${imageAtStart}: ${result.error}`);
            // A file that is not there will not be there in sixteen seconds either.
            // Retrying it walks the whole backoff, four failures deep, and fills
            // the console with the same line while the viewer sits on APPROX; the
            // owner watched it do that on both sides of a successful relink. Say it
            // once, in words that name the fix, and wait for the next edit.
            if (isMissingSource(result.error)) {
              // Say WHERE. On the old wording: "What file? I don't know where to look
              // to even understand how to fix this. It should show me the expected file
              // path." The path goes last, on purpose: it is the part worth copying
              // into a file browser search, and a sentence that ends in a path is a
              // sentence you can select the end of.
              const path = missingSourcePath(result.error);
              // A warning, not an error ("those should be more of
              // warnings"): the app is fine, a file moved. And once per path: the
              // viewer's own badge repeats it live, the log does not have to.
              const missingKey = path ?? result.error;
              const missingMsg = path
                ? `Nothing to render: the photograph's file is not where the catalog says it is. Put it back, or relink it from the thumbnail's right-click menu. Expected at ${path}`
                : `Nothing to render: the photograph's file is not where the catalog says it is. Put it back, or relink it from the thumbnail's right-click menu. ${result.error}`;
              if (!missingLogged.current.has(missingKey)) {
                missingLogged.current.add(missingKey);
                logMsg("warn", missingMsg);
              }
              // The status line, not a popup over the picture ("I would
              // remove that error popup and instead print the warning to the status
              // line"). Every time, because every time is a click on the missing
              // photo.
              flashStatus(missingMsg);
              setPreviewError(result.error);
              previewRetry.current = 0;
              continue;
            }
            if (previewRetry.current < PREVIEW_RETRY_ATTEMPTS) {
              previewRetry.current += 1;
              const wait = previewRetryDelay(previewRetry.current);
              logMsg(
                "error",
                `Engine preview failed: ${result.error}; retry ${previewRetry.current}/${PREVIEW_RETRY_ATTEMPTS} in ${Math.round(wait / 1000)}s`,
              );
              // Once at the start of the backoff walk, in the status
              // line; four flashes for one failure would be the popup
              // again with extra steps.
              if (previewRetry.current === 1) {
                flashStatus("Engine preview hiccup: holding the last good frame and retrying.");
              }
              setPreviewError(result.error);
              await new Promise((r) => setTimeout(r, wait));
              renderDirty.current = true;
              continue;
            }
            logMsg(
              "error",
              `Engine preview failed ${PREVIEW_RETRY_ATTEMPTS} times in a row; holding the last good frame until the next edit. Last error: ${result.error}`,
            );
            flashStatus("Engine preview failed; holding the last good frame until the next edit.", 8000);
          }
          previewRetry.current = 0;
          // A render landed, so the world may have changed: let a lost
          // file that comes back and goes missing again report anew.
          missingLogged.current.clear();
          // Decoded before it is shown.
          //
          // Swapping an <img> src makes the browser blank the element
          // while it decodes the new bitmap, and a full-resolution
          // render is a big bitmap. "if I am zoomed out,
          // brush a stroke, and zoom in then the stroke disappears for
          // a good second before reappearing." That gap is the decode,
          // and the deeper you zoom the bigger the frame and the longer
          // it lasts. Waiting for it here means the old frame stays up
          // until the new one is ready to paint in the same tick.
          //
          // Best effort: a browser without decode, or a frame that
          // fails to decode, falls through and swaps as before rather
          // than showing nothing at all. The decode is itself bounded:
          // a wedged decode must not park the pump any more than a
          // wedged render may.
          if (result.url) {
            try {
              const img = new Image();
              img.src = result.url;
              await Promise.race([
                img.decode(),
                new Promise((r) => setTimeout(r, 10_000)),
              ]);
            } catch {
              // Fall through: a frame that will not decode is still
              // better handed to the <img>, which has its own error path.
            }
            if (!viewIsCurrent()) {
              renderDirty.current = true;
              continue;
            }
            logDebug(
              () =>
                `render pump: frame landed for ${result.imageId ?? imageAtStart} in ${result.ms ?? "?"}ms engine, ${Math.round(performance.now() - pumpT0)}ms round trip incl. decode, backend=${result.backend ?? "?"}`,
            );
            const url = result.url;
            landFrame(snap, () => {
              setPreviewUrl(url);
              setPreviewFor(result.imageId ?? imageAtStart);
            });
            lookOnScreen.current = snap.lookPreview !== null;
            landed = { image: imageAtStart, version: snap.renderVersion, sourceIdentity: result.sourceIdentity, look: snap.lookPreview };
          }
          // On an error with retries exhausted, the previous lines are
          // skipped on purpose: the frame already on screen stays.
          landFrame(snap, () => {
            setPreviewError(result.error ?? null);
            setPreviewMs(result.ms ?? null);
            setPreviewBackend(result.backend ?? null);
            setRenderSeq((seq) => seq + 1);
          });
          // Failures were already logged by the retry accounting above. A
          // photograph's first frame in the session pays the cold decode, RAW
          // demosaic included, so it is slow by nature and not a warning: every
          // launch printed one and read as a bug ("I get why it
          // shows, I just don't want to answer bug reports and questions on this
          // all the time"). It goes to DEBUG as what it is; a slow render of a
          // photo already rendered once is still worth a warning.
          if (!result.error && result.ms !== undefined) {
            const id = result.imageId ?? imageAtStart;
            const first = !warmRenders.current.has(id);
            warmRenders.current.add(id);
            if (first) {
              logDebug(() => `First render of ${id}: ${result.ms}ms (cold decode)`);
            } else if (result.ms > 250) {
              logMsg("warn", `Slow engine render: ${result.ms}ms`);
            }
          }
        } while (renderDirty.current);
        // A previewed section look (src/sectionlooks.ts) opens at the
        // gesture tier, so the row under the pointer answers at once.
        // When the pointer rests on it (LOOK_REST_MS), one ordinary
        // reduced frame of the look follows, the same picture at the
        // viewer's own edge; the full-resolution settle below is never
        // spent on a look (settleWanted). Latest wins: a newer row cuts
        // the rest short and cancels a sharp frame in flight, and that
        // frame is discarded if it lands after the look changed.
        if (landed && landed.look !== null && !renderDirty.current) {
          const held = landed;
          await new Promise<void>((resolve) => {
            const done = () => {
              clearTimeout(timer);
              restWake.current = null;
              resolve();
            };
            const timer = setTimeout(done, LOOK_REST_MS);
            restWake.current = done;
          });
          const s3 = stateRef.current;
          const stillHeld = () =>
            !renderDirty.current &&
            stateRef.current.lookPreview === held.look &&
            stateRef.current.activeImage === held.image &&
            stateRef.current.renderVersion === held.version &&
            stateRef.current.previewNonce === s3.previewNonce &&
            previewTarget(stateRef.current) === previewTarget(s3) &&
            stateRef.current.gesture === null;
          if (stillHeld()) {
            const sendState = s3.tool === "crop" ? { ...s3, ...cropPreviewGraph(s3) } : s3;
            const t0 = performance.now();
            const token = `look:${crypto.randomUUID()}`;
            settleInFlight.current = token;
            const result = await renderPreview(sendState, { lookSharp: true, cancelToken: token });
            if (settleInFlight.current === token) settleInFlight.current = null;
            let shown = false;
            if (result.url && !result.error && (result.imageId ?? held.image) === held.image && stillHeld()) {
              try {
                const img = new Image();
                img.src = result.url;
                await Promise.race([img.decode(), new Promise((r) => setTimeout(r, 10_000))]);
              } catch {
                // An undecodable frame is still handed to the <img>.
              }
              if (stillHeld()) {
                shown = true;
                setPreviewUrl(result.url);
                setPreviewFor(result.imageId ?? held.image);
                lookOnScreen.current = true;
                setPreviewMs(result.ms ?? null);
                setRenderSeq((seq) => seq + 1);
                logDebug(
                  () =>
                    `render pump: look ${held.look} at the preview tier for ${held.image} in ${result.ms ?? "?"}ms engine, ${Math.round(performance.now() - t0)}ms round trip incl. decode`,
                );
              }
            }
            if (!shown) logDebug(() => `render pump: look ${held.look} preview-tier frame discarded, the press ended or the view moved`);
          }
        }
        // The full-resolution settle (2026-09-23: "people like to see as close
        // as possible to the final render result"): once a reduced frame has
        // landed and the hand has been off for a beat, the whole photograph
        // renders at its own pixels and replaces it, the picture the export will
        // make. Anything that moves the graph, the photograph or the hand in the
        // meantime discards the pass; the next reduced frame comes first, as it
        // always has. Memory or engine refusals are silent here: the reduced
        // frame on screen is a good frame, and the status line has said its
        // piece for the pass that produced it.
        if (landed && settleWanted(stateRef.current) && !renderDirty.current) {
          const { image, version, sourceIdentity } = landed;
          await new Promise((r) => setTimeout(r, SETTLE_DELAY_MS));
          const s2 = stateRef.current;
          const still = () =>
            !renderDirty.current &&
            stateRef.current.activeImage === image &&
            stateRef.current.renderVersion === version &&
            stateRef.current.lookPreview === null &&
            stateRef.current.gesture === null;
          if (still() && settleWanted(s2)) {
            const sendState = s2.tool === "crop" ? { ...s2, ...cropPreviewGraph(s2) } : s2;
            const sig = settleSignature(sendState);
            const cached = lastSettle.current;
            let reuse = !!(cached && sourceIdentity && cached.sourceIdentity === sourceIdentity &&
              cached.sig === sig && cached.imageId === image && settleFrameIsLive(cached.url));
            if (reuse) {
              // The Blob may survive while WebKit evicts decoded pixels.
              // Decode again before swapping and recheck freshness after it.
              let deadline: ReturnType<typeof setTimeout> | undefined;
              try {
                const img = new Image();
                img.src = cached!.url;
                reuse = await Promise.race([
                  img.decode().then(() => true),
                  new Promise<boolean>(resolve => { deadline = setTimeout(() => resolve(false), 20_000); }),
                ]);
              } catch { reuse = false; }
              finally { clearTimeout(deadline); }
            }
            if (reuse && cached && still()) {
              logDebug(() => `render pump: full-resolution frame for ${image} v${version} is the last settle's, swapped back in`);
              setPreviewUrl(cached.url);
              setPreviewFor(cached.imageId);
              lookOnScreen.current = false;
              setRenderSeq((seq) => seq + 1);
            } else if (still()) {
              logDebug(() => `render pump: full-resolution settle for ${image} v${version}`);
              const t0 = performance.now();
              const token = `settle:${crypto.randomUUID()}`;
              settleInFlight.current = token;
              const result = await renderPreview(sendState, { settle: true, cancelToken: token });
              settleInFlight.current = null;
              let shown = false;
              if (result.url && !result.error && (result.imageId ?? image) === image && still()) {
                let decoded = false;
                let deadline: ReturnType<typeof setTimeout> | undefined;
                try {
                  const img = new Image();
                  img.src = result.url;
                  decoded = await Promise.race([
                    img.decode().then(() => true),
                    new Promise<boolean>((resolve) => { deadline = setTimeout(() => resolve(false), 20_000); }),
                  ]);
                } catch {
                  // Keep the good reduced frame when the full JPEG is invalid.
                } finally {
                  clearTimeout(deadline);
                }
                if (decoded && still()) {
                  shown = true;
                  lastSettle.current = result.sourceIdentity && !result.memoryNotice
                    ? { sig, url: result.url, imageId: result.imageId ?? image, sourceIdentity: result.sourceIdentity }
                    : null;
                  setPreviewUrl(result.url);
                  setPreviewFor(result.imageId ?? image);
                  lookOnScreen.current = false;
                  setRenderSeq((seq) => seq + 1);
                  logDebug(
                    () =>
                      `render pump: full-resolution frame landed for ${image} in ${result.ms ?? "?"}ms engine, ${Math.round(performance.now() - t0)}ms round trip incl. decode`,
                  );
                }
              } else {
                logDebug(() => `render pump: full-resolution settle for ${image} discarded${result.error ? `: ${result.error}` : ""}`);
              }
              if (result.url && !shown) discardSettleFrame(result.url);
            }
          }
        }
        } while (renderDirty.current);
      } finally {
        renderBusy.current = false;
      }
    };
    void pump();
    // Zoom is deliberately absent: the reduced base is the same at
    // every zoom. At 1:1 the viewer requests its own sharp ROI patch.
    // Below 1:1 the optional Full settle replaces the reduced base.
    //
    // Keyed on renderVersion, not the nodes array: moving a node across
    // the graph canvas, renaming it, tinting it or noting it replaces
    // the array without changing one pixel of the render, and this pump
    // used to pay a full engine round-trip for every mousemove of it.
  }, [
    state.renderVersion,
    state.activeImage,
    state.prefs.settledPreview,
    state.prefs.settleQuality,
    // The saved graph's arrival, or the read ending without one.
    state.graphLoading,
    state.tool,
    state.maskView,
    // The depth view swaps the whole frame for the farness plane; the
    // pump has to notice the toggle or the eye does nothing (The
    // report: "View Depth was not working on any of them").
    state.depthView,
    state.halationView,
    state.collisionView,
    // The view's Tolerance dial rides in the target, so it is a frame
    // change too (2026-09-15: "Tolerance slider doesn't change
    // anything").
    state.collisionTolerance,
    // Separate shows the collision view while armed and narrows it on
    // the first click: both are frame changes the pump must notice.
    state.bwSeparate,
    state.zonesView,
    state.zoneHover,
    state.activeLayer,
    state.previewNonce,
    quadPreview,
    // A held section look, and its release: the frame the engine is
    // asked for changes with it although no edit did.
    state.lookPreview,
    // Everything maskPreviewNode reads must re-pump the frame: what the
    // viewer SHOWS changed even though no pixel of the edit did. The
    // probe is the newcomer; the Color Set eye and dropper belong on
    // this list for the same reason.
    state.probeNode,
    state.csetMaskView,
    state.csetDropper,
    state.gamutView,
    state.maskRed,
    state.prefs.maskOverlayColor,
    state.prefs.previewEdge,
    state.view.stagePx,
    state.prefs.gesturePreviewEdge,
    // The Finish tab's mask eye reads these two (maskPreviewNode's art
    // branch); without them the mask view froze on whatever frame was up
    // when they changed. The owner, painting a Finish layer mask: "the
    // whole canvas stays white."
    state.panelTab,
    state.artActive,
    // maskBrushTarget (the brush-eye branch of maskPreviewNode) reads
    // the picked node too.
    state.selection.join(","),
    // The gesture tier: while a stroke or drag is live the frame
    // renders half-size for speed, and this dependency is what makes
    // the RELEASE re-render it properly - the last streamed point
    // bumped renderVersion already, but letting go does not.
    state.gesture === null,
  ]);

  // A frame per take, for the multi-view.
  //
  // "Multi-view in the viewport. To be able to view up to 4
  // versions at once of an image." Each cell is a full graph render of
  // the same photograph through a different take's nodes, so they are
  // rendered one after another rather than all at once: four concurrent
  // full-graph renders of a 24 megapixel frame is how you find out what
  // the memory ceiling is.
  //
  // The active take is not re-rendered here. Its frame is the one the
  // normal pump already produced, so asking for it again would double the
  // work to draw the same pixels.
  const multiSig = state.multiTakes.join(",");
  useEffect(() => {
    if (state.multiTakes.length < 2) {
      // Only when there is something to clear. A fresh {} is a new
      // state every time, and this effect wakes on every renderVersion:
      // with the multi-view off it re-rendered the whole window a second
      // time for each step of a slider drag (a tester, 2026-09-30: "a
      // bit of jitter/lag on the sliders").
      setMultiFrames(noFramesIfAny);
      return;
    }
    // A gesture edits the active take's working graph, never the other
    // takes' nodes, but this effect keys on renderVersion, so a
    // transform drag used to re-render every comparison take on every
    // mousemove, queuing full renders behind the lock the preview pump
    // was waiting on. Skip the drag; release re-fires and re-syncs.
    if (state.gesture) return;
    let live = true;
    const activeTake = state.activeTakes[state.activeImage] ?? "take_1";
    const takes = state.takes[state.activeImage] ?? [];
    void (async () => {
      for (const id of state.multiTakes) {
        if (!live || id === activeTake) continue;
        const take = takes.find((t) => t.id === id);
        if (!take) continue;
        const result = await renderPreview({
          ...stateRef.current,
          nodes: take.nodes,
          wires: take.wires,
        });
        if (!live) return;
        if (result.url) setMultiFrames((prev) => ({ ...prev, [id]: result.url! }));
      }
    })();
    return () => {
      live = false;
    };
    // Keyed on the graph as well, so editing the active take refreshes the
    // others' comparison rather than leaving them stale next to it. On
    // renderVersion rather than the nodes array, so dragging a node
    // around the canvas does not re-render four full takes behind it.
  }, [multiSig, state.activeImage, state.renderVersion, state.gesture]);

  // The selection's own mask, for the polish matte.
  //
  // A second render, and deliberately: the matte has to sit ON the
  // photograph, and the "show mask" toggle replaces the photograph with
  // the mask instead of laying one over the other. It only runs while
  // the polish panel is open, and it follows the selection node alone,
  // so dragging an exposure slider does not refetch it.
  const polishNode = state.polishOpen && state.activeLayer
    ? state.nodes.find(
        (n) =>
          n.id === maskOfLayer(state.activeLayer!) &&
          n.type === "heeler.selection_mask",
      )
    : undefined;
  const polishSig = polishNode
    ? JSON.stringify([polishNode.id, polishNode.regions ?? [], polishNode.params])
    : "";
  useEffect(() => {
    if (!polishNode) {
      setPolishMask(null);
      return;
    }
    let live = true;
    void renderMaskOf(stateRef.current, polishNode.id).then((url) => {
      if (live) setPolishMask(url);
    });
    return () => {
      live = false;
    };
  }, [polishSig, state.activeImage]);

  return (
    <div className="app">
      <TopBar state={laid} dispatch={dispatch} />
      <GraphPersistence state={state} dispatch={dispatch} />
      <ResetAftermath state={state} dispatch={dispatch} />
      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        <TabRail state={laid} dispatch={dispatch} />
        {/* Canvas included: it used to be gated out, which left the LIBRARY
rail visibly clickable there while toggling a panel that never
rendered. "Library does expand when in Canvas view." One
rail, one behavior, every mode.*/}
        <BrowserPanel state={laid} dispatch={dispatch} />
        {laid.browserOpen && (
          <PanelDivider
            vertical
            testid="divider-library"
            onDelta={(d) =>
              dispatch({
                type: "set_panel_size",
                panel: "library",
                size: fittedDragSize(stateRef.current, "library", d),
              })
            }
          />
        )}
        <Ribbon state={laid} dispatch={dispatch} />
        {/* "I should be able to resize the panel horizontally which
should cause the thumbnails to scale (also means less would be visible
but that's the trade off)." The thumbnails are rendered once at 2x and
this scales that bitmap, so a drag re-renders nothing. Gone while the
panel is expanded, since then it is the whole window and has no edge to
drag.*/}
        {laid.ribbonOpen && !state.ribbonExpanded && (
          <PanelDivider
            vertical
            testid="divider-ribbon"
            onDelta={(d) =>
              dispatch({
                type: "set_panel_size",
                panel: "ribbon",
                size: fittedDragSize(stateRef.current, "ribbon", d),
              })
            }
          />
        )}

        {/* Expanded, the thumbnail panel has the window and there is no
            photograph on screen to show. */}
        {state.mode === "simple" && !state.ribbonExpanded && (
          <>
            {/* Quad edit takes the viewer's seat: same feed for the
                driver, pane renders for the rest, controls unchanged on
                the right. */}
            {state.quadEdit ? (
              <QuadEditView
                state={state}
                dispatch={dispatch}
                previewUrl={previewFor === state.activeImage ? previewUrl : null}
                quadFrames={quadFrames}
              />
            ) : (
            <Viewer
              state={state}
              dispatch={dispatch}
              previewUrl={previewFor === state.activeImage ? previewUrl : null}
              previewError={previewError}
              previewMs={previewMs}
              previewBackend={previewBackend}
              originalUrl={
                original?.for === beforeKey
                  ? original.url
                  : null
              }
              maskUrl={polishMask}
              multiFrames={multiFrames}
            />
            )}
            <PanelDivider
              vertical
              testid="divider-right"
              onDelta={(d) =>
                dispatch({
                  type: "set_panel_size",
                  panel: "right",
                  size: fittedDragSize(stateRef.current, "right", -d),
                })
              }
            />
            {/* Polish borrows the Adjustments column rather than opening a window.
"temp hide Adjustments panel, bring up a Polish selection
panel so its not like you have to leave the main window." Nothing is
torn down: DONE puts the adjustments back exactly as they were.*/}
            {state.polishOpen ? (
              <div
                style={{
                  width: laid.panelSizes.right,
                  flex: "none",
                  overflowY: "auto",
                  background: "var(--bg-panel)",
                  borderLeft: "1px solid var(--line-2)",
                }}
              >
                <PolishPanel state={state} dispatch={dispatch} />
              </div>
            ) : (
              <SimplePanel
                state={state}
                dispatch={dispatch}
                width={laid.panelSizes.right}
                frame={
                  (previewFor === state.activeImage ? previewUrl : null) ??
                  state.images.find((i) => i.id === state.activeImage)?.src
                }
                engine={previewFor === state.activeImage && previewUrl !== null}
              />
            )}
          </>
        )}

        {state.mode === "advanced" && (
          <>
            <div
              style={{
                flex: 1,
                minWidth: 0,
                display: "flex",
                flexDirection: "column",
              }}
            >
              {/* Popped out, the graph pane collapses to a bar and the
                  viewer takes the height it gave up (no fixed height =
                  flex), so there is nothing left to drag a divider
                  between. */}
              <Viewer
                state={state}
                dispatch={dispatch}
                height={
                  state.graphPoppedOut
                    ? undefined
                    : state.panelSizes.graphViewer
                }
                previewUrl={
                  previewFor === state.activeImage ? previewUrl : null
                }
                previewError={previewError}
                previewMs={previewMs}
                previewBackend={previewBackend}
                originalUrl={
                  original?.for === beforeKey
                    ? original.url
                    : null
                }
              />
              {state.graphPoppedOut ? (
                <GraphElsewhere dispatch={dispatch} />
              ) : (
                <>
                  <PanelDivider
                    vertical={false}
                    testid="divider-graph"
                    onDelta={(d) =>
                      dispatch({
                        type: "set_panel_size",
                        panel: "graphViewer",
                        size: stateRef.current.panelSizes.graphViewer + d,
                      })
                    }
                  />
                  <NodeEditor
                    state={state}
                    dispatch={dispatch}
                    onPopOut={(opener) => {
                      // The button hands itself over: on macOS a mouse
                      // click need not focus it, so the active element is
                      // no witness (review 2026-09-15). The effect on the
                      // flag is the one thing that opens the window, here
                      // and at launch from a saved layout. Opening here
                      // too raced it (see rememberPopoutOpener).
                      rememberPopoutOpener("graph", opener);
                      dispatch({ type: "set_graph_popped_out", out: true });
                    }}
                  />
                </>
              )}
            </div>
            {/* Only one window shows the inspector at a time. Popped
                out, the graph window takes it and this side folds to a
                spine; clicking that brings it back here and folds the
                one out there. */}
            {state.inspectorHome === "main" ? (
              <>
                <PanelDivider
                  vertical
                  testid="divider-right"
                  onDelta={(d) =>
                    dispatch({
                      type: "set_panel_size",
                      panel: "right",
                      size: fittedDragSize(stateRef.current, "right", -d),
                    })
                  }
                />
                <Inspector
                  state={state}
                  dispatch={dispatch}
                  width={laid.panelSizes.right}
                  frame={engineFrame}
                />
              </>
            ) : (
              <InspectorBar
                onClick={() =>
                  dispatch({ type: "set_inspector_home", home: "main" })
                }
              />
            )}
          </>
        )}

        {state.mode === "canvas" && (
          <CanvasMode
            state={laid}
            dispatch={dispatch}
            previewUrl={previewFor === state.activeImage ? previewUrl : null}
            previewError={previewError}
            previewMs={previewMs}
            previewBackend={previewBackend}
            originalUrl={
              original?.for === beforeKey
                ? original.url
                : null
            }
          />
        )}

        {/* Export sits at the far right in every mode, because exporting
            is not a Develop activity: you pick what to export in the
            ribbon and that is visible from anywhere. Folded, it is a
            bar rather than nothing, so the way back is where it was. */}
        {laid.exportOpen && (
          <ExportPanel state={laid} dispatch={dispatch} />
        )}
        <ExportBar open={laid.exportOpen} dispatch={dispatch} />
      </div>
      {/* The real status bar: hints, flashes and the viewer's readouts on
their own opaque strip at the window's bottom, never over the
photograph.*/}
      {state.findControlOpen && <FindControl state={state} dispatch={dispatch} />}
      <TourOverlay state={state} dispatch={dispatch} />
      <UpdatePrompt />
      {/* The catalog update card (26.3): it can open at boot or from a
          catalog switch, and it outranks the dialogs behind it since
          nothing may touch the catalog until it answers. */}
      <CatalogUpgradePrompt />
      <CursorTip />
      <StatusBar
        state={state}
        dispatch={dispatch}
        previewUrl={previewFor === state.activeImage ? previewUrl : null}
        previewError={previewError}
        previewMs={previewMs}
        previewBackend={previewBackend}
        renderSeq={renderSeq}
      />
      <GroupDialog state={state} dispatch={dispatch} />
      <StitchDialog state={state} dispatch={dispatch} />
      <Preferences state={state} dispatch={dispatch} />
      <SelectDialogs state={state} dispatch={dispatch} />
      <FileLayersDialog state={state} dispatch={dispatch} />
      <CatalogLayerDialog state={state} dispatch={dispatch} />
      <DocsViewer state={state} dispatch={dispatch} />
      <CatalogDialog
        open={state.catalogsOpen}
        onClose={() => dispatch({ type: "close_catalogs" })}
        dispatch={dispatch}
        thumbnailEdge={state.prefs.thumbnailEdge}
      />
      <BakeDialog state={state} dispatch={dispatch} />
      {/* Last, so a confirmation sits over whatever raised it. */}
      <ConfirmDialog state={state} dispatch={dispatch} />
      {/* Truly last: whether anyone has agreed to run Heeler at all comes
          first, in every build. */}
      <NodePalette
        state={state}
        dispatch={dispatch}
        recentsLimit={clampRecents(state.prefs.paletteRecents)}
        onAdd={(spec, x, y) => addNodeAt(state, dispatch, spec, x, y)}
      />
      {state.boot && (
        <Splash
          boot={state.boot}
          onDone={() => dispatch({ type: "boot_done" })}
        />
      )}
      {/* The one progress row every long operation uses; floats over
          whichever dialog launched the work. */}
      <OpProgressOverlay />
      <BakeProgressDialog merge={state.baking ? state.stackMerges[state.baking] ?? null : null} />
    </div>
  );
}
