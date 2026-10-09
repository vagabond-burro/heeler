// The preferences dialog, on the settings that are not hotkeys.

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { initialState } from "../data";
import { clearLog, logAsText } from "../log";
import { loadUiSettings, mockSetExportFolder, saveUiSettings } from "../bridge";
import { uiSettingsCommands, uiSettingsSnapshot } from "../settings";
import { DEFAULT_PREFS, DEFAULT_UI_SETTINGS, reduce, type Command, type State } from "../state";
import { Preferences } from "../ui/preferences";
import { experimentalEnabled, previewBuild, setPreviewBuildForTests } from "../features";
import { visiblePanelTabs } from "../state";

function open(prefs: Partial<State["prefs"]> = {}) {
  const sent: Command[] = [];
  const state = reduce(
    reduce(initialState(), { type: "open_prefs" }),
    { type: "set_prefs", prefs },
  );
  render(<Preferences state={state} dispatch={((c: Command) => sent.push(c)) as never} />);
  return { sent, state };
}

describe("the Editing & Brush category", () => {
  /// "Both of the increment values should be
  /// customizable in settings. We will need a brush category."
  it("is a tab beside the others", () => {
    open();
    fireEvent.click(screen.getByTestId("prefs-tab-brush"));
    expect(screen.getByTestId("prefs-grain-step")).toBeInTheDocument();
    expect(screen.getByTestId("prefs-grain-fine-step")).toBeInTheDocument();
  });

  it("starts at the increments the owner asked for", () => {
    expect(DEFAULT_PREFS.brushGrainStep).toBe(15);
    expect(DEFAULT_PREFS.brushGrainFineStep).toBe(5);
    open();
    fireEvent.click(screen.getByTestId("prefs-tab-brush"));
    // The HOUSE slider now ("the sliders in the Brush tab
    // should follow the same style of sliders in rest of the app"), so
    // the value reads through its slider role rather than an input.
    expect(screen.getByTestId("prefs-grain-step").getAttribute("aria-valuenow")).toBe("15");
    expect(screen.getByTestId("prefs-grain-fine-step").getAttribute("aria-valuenow")).toBe("5");
  });

  it("shape outline thickness lives under Interface, at twice the first drawing", () => {
    expect(DEFAULT_PREFS.shapeLineWidth).toBe(2);
    const { sent } = open();
    fireEvent.click(screen.getByTestId("prefs-tab-interface"));
    const dial = screen.getByTestId("prefs-shape-line-width");
    expect(dial.getAttribute("aria-valuenow")).toBe("2");
    dial.focus();
    fireEvent.keyDown(dial, { key: "ArrowRight" });
    const write = sent.find((c) => c.type === "set_prefs");
    const next = write && "prefs" in write ? (write.prefs as { shapeLineWidth?: number }).shapeLineWidth : undefined;
    expect(next).toBe(3);
  });

  it("writes a new step straight into the preferences", () => {
    const { sent } = open();
    fireEvent.click(screen.getByTestId("prefs-tab-brush"));
    const dial = screen.getByTestId("prefs-grain-fine-step");
    dial.focus();
    fireEvent.keyDown(dial, { key: "ArrowRight" });
    const write = sent.find((c) => c.type === "set_prefs");
    expect(write && "prefs" in write && (write.prefs as { brushGrainFineStep?: number }).brushGrainFineStep).toBe(6);
  });

  it("shows a sane number for a session saved before these existed", () => {
    // Preferences are persisted, so an older catalog restores without
    // these keys and a slider reading undefined renders nothing at all.
    const { state } = open({ brushGrainStep: undefined as never });
    expect(state.prefs.brushGrainStep).toBeUndefined();
    fireEvent.click(screen.getByTestId("prefs-tab-brush"));
    expect(screen.getByTestId("prefs-grain-step").getAttribute("aria-valuenow")).toBe("15");
  });
});

describe("catalog backup cadence", () => {
  /// (2026-09-09): "Add more options for every two weeks (bi-weekly)
  /// and monthly." Five cadences, each a day count the Rust schedule
  /// counts from the last backup.
  it("offers Never, Daily, Weekly, Every two weeks and Monthly, and each pick is the day count", () => {
    const { sent } = open({ backupEveryDays: 7 });
    fireEvent.click(screen.getByTestId("prefs-tab-backup"));
    expect(screen.getByTestId("prefs-backup")).toHaveAttribute("data-value", "7");
    expect(screen.getByTestId("prefs-backup")).toHaveTextContent("Weekly");
    fireEvent.click(screen.getByTestId("prefs-backup"));
    for (const days of [0, 1, 7, 14, 30]) expect(screen.getByTestId(`prefs-backup-option-${days}`)).toBeInTheDocument();
    expect(screen.getByTestId("prefs-backup-option-14")).toHaveTextContent("Every two weeks");
    expect(screen.getByTestId("prefs-backup-option-30")).toHaveTextContent("Monthly");
    fireEvent.click(screen.getByTestId("prefs-backup-option-14"));
    expect(sent).toContainEqual({ type: "set_prefs", prefs: { backupEveryDays: 14 } });
    fireEvent.click(screen.getByTestId("prefs-backup"));
    fireEvent.click(screen.getByTestId("prefs-backup-option-30"));
    expect(sent).toContainEqual({ type: "set_prefs", prefs: { backupEveryDays: 30 } });
  });

  it.each([0, 1, 7, 14, 30])("round trips cadence %s and the chosen folder through saved settings", async days => {
    mockSetExportFolder("/Volumes/Backup disk/Heeler");
    const { sent } = open({ backupEveryDays: days });
    fireEvent.click(screen.getByTestId("prefs-tab-backup"));
    fireEvent.click(screen.getByTestId("prefs-backup-folder"));
    await waitFor(() => expect(sent).toContainEqual({ type: "set_prefs", prefs: { backupFolder: "/Volumes/Backup disk/Heeler" } }));
    const saved = sent.reduce(reduce, reduce(initialState(), { type: "set_prefs", prefs: { backupEveryDays: days } }));
    await saveUiSettings(JSON.stringify(uiSettingsSnapshot(saved)));
    const restored = uiSettingsCommands(await loadUiSettings()).reduce(reduce, initialState());
    expect(restored.prefs.backupEveryDays).toBe(days);
    expect(restored.prefs.backupFolder).toBe("/Volumes/Backup disk/Heeler");
    cleanup();
    render(<Preferences state={reduce(restored, { type: "open_prefs" })} dispatch={(() => {}) as never} />);
    fireEvent.click(screen.getByTestId("prefs-tab-backup"));
    expect(screen.getByTestId("prefs-backup")).toHaveAttribute("data-value", String(days));
    expect(screen.getByTestId("prefs-backup-path")).toHaveTextContent("/Volumes/Backup disk/Heeler");
  });

  it.each([-1, 2, 31, 1.5, "7", null, {}, Number.MAX_VALUE])("restores unsupported cadence %j as Never, and says so in the Console", value => {
    clearLog();
    const restored = uiSettingsCommands(JSON.stringify({ prefs: { backupEveryDays: value, backupFolder: "/backups" } })).reduce(reduce, initialState());
    expect(logAsText()).toContain("is not one Heeler offers; automatic backups are set to Never");
    const { state } = open(restored.prefs);
    expect(state.prefs.backupEveryDays).toBe(0);
    expect(state.prefs.backupFolder).toBe("/backups");
    fireEvent.click(screen.getByTestId("prefs-tab-backup"));
    expect(screen.getByTestId("prefs-backup")).toHaveAttribute("data-value", "0");
  });

  it.each([null, 42, {}])("restores invalid folder %j as unconfigured", value => {
    const restored = uiSettingsCommands(JSON.stringify({ prefs: { backupEveryDays: 1, backupFolder: value } })).reduce(reduce, initialState());
    expect(restored.prefs.backupFolder).toBe("");
    open(restored.prefs);
    fireEvent.click(screen.getByTestId("prefs-tab-backup"));
    expect(screen.getByTestId("prefs-backup-path")).toHaveTextContent("no folder chosen");
  });

  it("explains launch timing and retention beside the control", () => {
    open();
    fireEvent.click(screen.getByTestId("prefs-tab-backup"));
    expect(screen.getByTestId("prefs-row-catalog-backup")).toHaveTextContent("Changes take effect at the next launch");
    expect(screen.getByTestId("prefs-row-catalog-backup")).toHaveTextContent("never removed automatically");
    fireEvent.click(screen.getByTestId("prefs-backup"));
    expect(screen.getByTestId("prefs-backup-option-1").getAttribute("data-hint")).toContain("24 hours");
  });
});

describe("app zoom", () => {
  /// The owner's answer to the 4K tester whose slider handles
  /// crowded the RESET text: "Add the recommended app zoom."
  it("offers the four steps under Interface and applies the pick live", () => {
    open();
    fireEvent.click(screen.getByTestId("prefs-tab-interface"));
    fireEvent.click(screen.getByTestId("prefs-app-zoom-130"));
    expect(document.documentElement.style.getPropertyValue("--chrome-zoom")).toBe("1.3");
    expect(localStorage.getItem("heeler.ui.chromeZoom")).toBe("1.3");
    fireEvent.click(screen.getByTestId("prefs-app-zoom-115"));
    expect(document.documentElement.style.getPropertyValue("--chrome-zoom")).toBe("1.15");
  });

  it("falls back to the house 1.15 when the stored value is nonsense", async () => {
    const { applyChromeZoom } = await import("../uiprefs");
    localStorage.setItem("heeler.ui.chromeZoom", "9");
    applyChromeZoom();
    expect(document.documentElement.style.getPropertyValue("--chrome-zoom")).toBe("1.15");
    localStorage.removeItem("heeler.ui.chromeZoom");
  });
});

describe("preferences navigation and search", () => {
  it("keeps categories in a left rail and settings in an independent panel", () => {
    open();
    expect(screen.getByLabelText("Preference categories")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("prefs-tab-import"));
    expect(screen.getByTestId("prefs-panel-import")).toBeInTheDocument();
    expect(screen.getByTestId("prefs-raw-profile")).toHaveAttribute("data-value", "standard");
  });

  it("searches descriptions and lands on the selected setting", () => {
    open();
    fireEvent.change(screen.getByTestId("prefs-search"), { target: { value: "token-protected" } });
    fireEvent.click(screen.getByTestId("prefs-search-result-python-api"));
    expect(screen.getByTestId("prefs-panel-scripting")).toBeInTheDocument();
    expect(screen.getByTestId("prefs-row-python-api").style.boxShadow).toContain("var(--accent)");
  });

  it("gives a useful empty search result", () => {
    open();
    fireEvent.change(screen.getByTestId("prefs-search"), { target: { value: "not-a-real-preference" } });
    expect(screen.getByTestId("prefs-search-empty")).toHaveTextContent("Try a category");
  });

  it("accepts typed numeric values and clamps them", () => {
    const { sent } = open();
    fireEvent.click(screen.getByTestId("prefs-tab-brush"));
    const field = screen.getByTestId("prefs-grain-step-value");
    fireEvent.change(field, { target: { value: "999" } });
    fireEvent.blur(field);
    const write = sent.find(
      (command) => command.type === "set_prefs" && command.prefs.brushGrainStep === 90,
    );
    expect(write).toBeDefined();
  });

  it("surfaces every behavior preference without native range controls", () => {
    // Tethering shown, so its defaults row is drawn (it hides with the
    // Tether tab; rawsharpening.test.tsx proves both ways).
    open({ experimentalFeatures: true });
    expect(screen.getByTestId("prefs-autosave-delay")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("prefs-tab-interface"));
    for (const id of [
      "prefs-viewer-zoom-speed",
      "prefs-viewer-rotation-step",
      "prefs-wheel-zoom-invert",
      "prefs-gpu-previews",
      "prefs-preview-edge",
      "prefs-gesture-preview-edge",
      "prefs-ribbon-min",
      "prefs-ribbon-max",
      "prefs-thumbnail-edge",
    ]) expect(screen.getByTestId(id)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("prefs-tab-brush"));
    expect(screen.getByTestId("prefs-mask-color")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("prefs-tab-import"));
    expect(screen.getByTestId("prefs-tether-poll")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("prefs-tab-export"));
    expect(screen.getByTestId("prefs-export-format")).toBeInTheDocument();
    expect(document.querySelector('[data-testid="preferences"] input[type="range"]')).toBeNull();
  });

  it("rides every slider on the one shared numeric row treatment", () => {
    open();
    // One panel mounts at a time, so check each category in turn.
    let seen = 0;
    for (const tab of ["general", "interface", "brush", "import"]) {
      fireEvent.click(screen.getByTestId(`prefs-tab-${tab}`));
      const sliders = document.querySelectorAll('[data-testid="preferences"] .strack');
      seen += sliders.length;
      for (const slider of sliders) {
        expect(slider.closest(".pnum")).not.toBeNull();
      }
    }
    expect(seen).toBeGreaterThan(10);
  });

  it("writes the wheel zoom and GPU switches into durable preferences", () => {
    const { sent } = open();
    fireEvent.click(screen.getByTestId("prefs-tab-interface"));
    fireEvent.click(screen.getByTestId("prefs-wheel-zoom-invert"));
    fireEvent.click(screen.getByTestId("prefs-gpu-previews"));
    expect(sent).toContainEqual({ type: "set_prefs", prefs: { wheelZoomInverted: true } });
    expect(sent).toContainEqual({ type: "set_prefs", prefs: { gpuPreviews: false } });
  });

  it("writes color, tether, and export choices into durable preferences", () => {
    const { sent } = open({ experimentalFeatures: true });
    fireEvent.click(screen.getByTestId("prefs-tab-brush"));
    fireEvent.click(screen.getByTestId("prefs-mask-color"));
    fireEvent.click(screen.getByTestId("prefs-mask-color-option-cyan"));
    fireEvent.click(screen.getByTestId("prefs-tab-import"));
    fireEvent.change(screen.getByTestId("prefs-tether-pattern"), { target: { value: "shoot-{seq}" } });
    fireEvent.click(screen.getByTestId("prefs-tab-export"));
    fireEvent.click(screen.getByTestId("prefs-export-format"));
    fireEvent.click(screen.getByTestId("prefs-export-format-option-tiff"));
    expect(sent).toContainEqual({ type: "set_prefs", prefs: { maskOverlayColor: "cyan" } });
    expect(sent).toContainEqual({ type: "set_prefs", prefs: { tetherNamingPattern: "shoot-{seq}" } });
    expect(sent).toContainEqual({ type: "set_prefs", prefs: { exportDefaultFormat: "tiff" } });
  });

  it("finds the new settings by their outcome descriptions", () => {
    open();
    fireEvent.change(screen.getByTestId("prefs-search"), { target: { value: "gesture is live" } });
    expect(screen.getByTestId("prefs-search-result-preview-quality")).toBeInTheDocument();
  });
});

describe("the Models category", () => {
  it("is a real table: headers on top, rows rendered before the disk answers", () => {
    open();
    fireEvent.click(screen.getByTestId("prefs-tab-models"));
    expect(screen.getByRole("columnheader", { name: "Model" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Status / size on disk" })).toBeInTheDocument();
    // The registry is static, so every row is up immediately; only the
    // status cell waits, and it must not guess "not installed".
    expect(screen.getByTestId("prefs-model-mobile_sam")).toBeInTheDocument();
    expect(screen.getByTestId("prefs-model-status-mobile_sam").textContent).not.toContain("not installed");
  });

  it("shows the storage location and chooses a new one", async () => {
    const { sent } = open();
    fireEvent.click(screen.getByTestId("prefs-tab-models"));
    expect(screen.getByTestId("prefs-models-location").textContent).toBe("the app data folder");
    mockSetExportFolder("/Volumes/big/vision");
    fireEvent.click(screen.getByTestId("prefs-models-choose"));
    // No models are installed in the mock, so there is nothing to move
    // and the pick applies without the offer.
    await waitFor(() =>
      expect(sent).toContainEqual({ type: "set_prefs", prefs: { modelStoreDir: "/Volumes/big/vision" } }),
    );
    mockSetExportFolder(null);
  });

  it("lists Florence-2 with the others: size, license, version, and INSTALL through the same card", async () => {
    open();
    fireEvent.click(screen.getByTestId("prefs-tab-models"));
    expect(screen.getByTestId("prefs-model-florence_2_base")).toHaveTextContent("Florence-2 base (what is in the picture)");
    const install = await screen.findByTestId("prefs-model-install-florence_2_base");
    expect(screen.getByTestId("prefs-model-status-florence_2_base").textContent).toBe("not installed");
    fireEvent.click(install);
    const card = screen.getByTestId("prefs-install-florence_2_base-consent");
    expect(card.textContent).toContain("970 MB");
    expect(card.textContent).toContain("MIT");
    expect(card.textContent).toContain("huggingface.co/onnx-community/Florence-2-base");
  });

  it("offers INSTALL on a model that is not installed, through the consent card (2026-09-09)", async () => {
    open();
    fireEvent.click(screen.getByTestId("prefs-tab-models"));
    // The mock reports every model not installed, so every row has INSTALL.
    const install = await screen.findByTestId("prefs-model-install-scunet_color_real_psnr");
    expect(screen.queryByTestId("prefs-install-scunet_color_real_psnr-consent")).toBeNull();
    fireEvent.click(install);
    // The card names the model, its size and its source before anything downloads.
    const card = screen.getByTestId("prefs-install-scunet_color_real_psnr-consent");
    expect(card.textContent).toContain("SCUNet");
    expect(card.textContent).toContain("MB");
    fireEvent.click(screen.getByTestId("prefs-install-scunet_color_real_psnr-later"));
    expect(screen.queryByTestId("prefs-install-scunet_color_real_psnr-consent")).toBeNull();
    fireEvent.click(install);
    fireEvent.click(screen.getByTestId("prefs-install-scunet_color_real_psnr-download"));
    await waitFor(() => expect(screen.queryByTestId("prefs-install-scunet_color_real_psnr-consent")).toBeNull());
    await waitFor(() => expect(screen.getByTestId("prefs-models-choose")).not.toBeDisabled());
    expect(screen.getByTestId("prefs-models-check-updates")).not.toBeDisabled();
  });

  it("checks the model list for newer weights and applies one", async () => {
    const { mockSetModelUpdatesReply } = await import("../bridge");
    open();
    fireEvent.click(screen.getByTestId("prefs-tab-models"));
    // Unreachable: the words, not a crash.
    mockSetModelUpdatesReply(null);
    fireEvent.click(screen.getByTestId("prefs-models-check-updates"));
    await waitFor(() => expect(screen.getByTestId("prefs-models-updates-error").textContent).toContain("could not reach the model list"));
    // Current: says so with the count.
    mockSetModelUpdatesReply({ updates: [], checked: 2 });
    fireEvent.click(screen.getByTestId("prefs-models-check-updates"));
    await waitFor(() => expect(screen.getByTestId("prefs-models-updates").textContent).toBe("The 2 installed models are current."));
    // An update: named with both versions and its size, applied on its button.
    mockSetModelUpdatesReply({
      updates: [{ id: "scunet_color_real_psnr", label: "SCUNet (noise reduction)", installed: "2026.06", latest: "2026.09", bytes: 76_936_854, notes: "Re-export with opset 18." }],
      checked: 2,
    });
    fireEvent.click(screen.getByTestId("prefs-models-check-updates"));
    await waitFor(() => expect(screen.getByTestId("prefs-model-update-scunet_color_real_psnr")).toBeInTheDocument());
    expect(screen.getByTestId("prefs-model-update-scunet_color_real_psnr").textContent).toContain("2026.06 \u2192 2026.09 \u00b7 77 MB");
    fireEvent.click(screen.getByTestId("prefs-model-update-apply-scunet_color_real_psnr"));
    await waitFor(() => expect(screen.queryByTestId("prefs-model-update-scunet_color_real_psnr")).toBeNull());
    await waitFor(() => expect(screen.getByTestId("prefs-models-check-updates")).not.toBeDisabled());
    expect(screen.getByTestId("prefs-models-choose")).not.toBeDisabled();
    mockSetModelUpdatesReply(null);
  });

  it("offers the way back to the default location", () => {
    const { sent } = open({ modelStoreDir: "/Volumes/big/vision" });
    fireEvent.click(screen.getByTestId("prefs-tab-models"));
    expect(screen.getByTestId("prefs-models-location").textContent).toBe("/Volumes/big/vision");
    fireEvent.click(screen.getByTestId("prefs-models-default"));
    expect(sent).toContainEqual({ type: "set_prefs", prefs: { modelStoreDir: "" } });
  });
});

describe("preference persistence", () => {
  it("round trips preferences through the app settings save path", async () => {
    const changed = reduce(initialState(), {
      type: "set_prefs",
      prefs: {
        quickQuality: 81,
        brushGrainStep: 24,
        previewEdge: 3072,
        maskOverlayColor: "magenta",
        tetherPollMs: 3500,
        modelStoreDir: "/Volumes/big/vision",
        wheelZoomInverted: true,
        gpuPreviews: false,
      },
    });
    await saveUiSettings(JSON.stringify(uiSettingsSnapshot(changed)));

    let restored = initialState();
    for (const command of uiSettingsCommands(await loadUiSettings())) {
      restored = reduce(restored, command);
    }

    expect(restored.prefs.quickQuality).toBe(81);
    expect(restored.prefs.brushGrainStep).toBe(24);
    expect(restored.prefs.previewEdge).toBe(3072);
    expect(restored.prefs.maskOverlayColor).toBe("magenta");
    expect(restored.prefs.tetherPollMs).toBe(3500);
    expect(restored.prefs.modelStoreDir).toBe("/Volumes/big/vision");
    expect(restored.prefs.wheelZoomInverted).toBe(true);
    expect(restored.prefs.gpuPreviews).toBe(false);
  });

  it("loads older app settings that have no preferences field", () => {
    let restored = initialState();
    for (const command of uiSettingsCommands(JSON.stringify(DEFAULT_UI_SETTINGS))) {
      restored = reduce(restored, command);
    }
    expect(restored.prefs).toEqual(DEFAULT_PREFS);
  });

  it("repairs invalid saved values before they reach rendering and navigation", () => {
    let restored = initialState();
    const json = JSON.stringify({
      prefs: {
        viewerZoomRate: 99,
        previewEdge: 12,
        gesturePreviewEdge: 99999,
        ribbonMinWidth: 900,
        ribbonMaxWidth: 20,
        thumbnailEdge: -1,
        maskOverlayColor: "orange",
        exportDefaultFormat: "bmp",
        modelStoreDir: 42,
      },
    });
    for (const command of uiSettingsCommands(json)) restored = reduce(restored, command);

    expect(restored.prefs.viewerZoomRate).toBe(0.004);
    expect(restored.prefs.previewEdge).toBe(1024);
    expect(restored.prefs.gesturePreviewEdge).toBe(1024);
    expect(restored.prefs.ribbonMinWidth).toBe(260);
    expect(restored.prefs.ribbonMaxWidth).toBe(260);
    expect(restored.prefs.thumbnailEdge).toBe(240);
    expect(restored.prefs.maskOverlayColor).toBe("red");
    expect(restored.prefs.exportDefaultFormat).toBe("jpeg");
    expect(restored.prefs.modelStoreDir).toBe("");
  });
});

/// 2026-08-26: "disable experimental feature options in preferences
/// when not in dev mode." Tethering is the only thing behind the
/// toggle, and it answers one Panasonic body; a build that ships
/// cannot stand behind the rest, so it does not offer the door.
describe("the experimental-features toggle and the build it ships in", () => {
  afterEach(() => setPreviewBuildForTests(null));

  it("is a development build's control only", () => {
    setPreviewBuildForTests(true);
    open();
    expect(screen.getByTestId("prefs-experimental")).toBeInTheDocument();

    // Second render of the same dialog: the first has to go, or the
    // query below finds the development build's row still on screen.
    cleanup();
    setPreviewBuildForTests(false);
    open();
    expect(screen.queryByTestId("prefs-experimental")).toBeNull();
  });

  it("keeps the shipped build's search from offering a row that is not there", () => {
    setPreviewBuildForTests(false);
    open();
    fireEvent.change(screen.getByTestId("prefs-search"), { target: { value: "Experimental" } });
    expect(screen.queryByTestId("prefs-search-result-experimental-features")).toBeNull();
  });

  it("finds it in a development build's search", () => {
    setPreviewBuildForTests(true);
    open();
    fireEvent.change(screen.getByTestId("prefs-search"), { target: { value: "Experimental" } });
    expect(screen.getByTestId("prefs-search-result-experimental-features")).toBeInTheDocument();
  });

  /// The preference is left as the user set it: a shipped build simply
  /// stops honoring it, and the same install in a development build
  /// picks up where it left off.
  it("overrules a stored preference rather than rewriting it", () => {
    setPreviewBuildForTests(false);
    expect(experimentalEnabled(true)).toBe(false);
    expect(visiblePanelTabs({ experimentalFeatures: true }).some((t) => t.id === "tether")).toBe(false);

    setPreviewBuildForTests(true);
    expect(experimentalEnabled(true)).toBe(true);
    expect(visiblePanelTabs({ experimentalFeatures: true }).some((t) => t.id === "tether")).toBe(true);
  });

  /// The test suite runs as a development build, which is what lets
  /// every other tether test drive the tab at all.
  it("reads the build from vite, and the suite is a development one", () => {
    expect(previewBuild()).toBe(true);
  });
});

describe("the outline thickness carries across its change of units", () => {
  /// It was a percentage (50 to 800, shipped 200) and became pixels (1
  /// to 8, shipped 2) on 2026-09-07. A saved percentage read as pixels
  /// clamps to 8, the thickest line the app draws, which is what the
  /// owner saw on every photograph: "way too thick for a default".
  it("reads a saved percentage as the pixels it meant", async () => {
    const { migrateShapeLineWidth, clampShapeLineWidth } = await import("../state");
    // The shipped percentage is the shipped pixel count.
    expect(migrateShapeLineWidth(200)).toBe(2);
    // The old ends of the scale land on the new ones.
    expect(migrateShapeLineWidth(800)).toBe(8);
    expect(migrateShapeLineWidth(50)).toBe(1);
    // A value already in pixels is left alone.
    expect(migrateShapeLineWidth(2)).toBe(2);
    expect(migrateShapeLineWidth(8)).toBe(8);
    // Nothing saved: the shipped default.
    expect(migrateShapeLineWidth(undefined)).toBe(2);
    // A live write still clamps rather than converting: 9999 is
    // somebody asking for the maximum, not a percentage.
    expect(clampShapeLineWidth(9999)).toBe(8);
  });
});

it("the zoomed Preferences dialog keeps its close button inside the viewport", () => {
  render(<Preferences state={reduce(initialState(), { type: "open_prefs" })} dispatch={() => {}} />);
  const box = screen.getByRole("dialog", { name: "Preferences" });
  expect(box.style.maxWidth).toContain("/ var(--chrome-zoom)");
  expect(box.style.maxHeight).toContain("/ var(--chrome-zoom)");
  expect(box.style.minWidth).toContain("min(");
  expect(box.style.minHeight).toContain("min(");
});
