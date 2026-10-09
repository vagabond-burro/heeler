import { BACKUP_CADENCES, isArtContentKind, isRawSharpening, isShapeMode, layoutSnapshot, type Command, type State, type UiSettings } from "./state";
import { logMsg } from "./log";

export function uiSettingsSnapshot(state: State): UiSettings {
  return {
    prefs: state.prefs,
    apiEnabled: state.apiEnabled,
    shapeMode: state.shapeMode,
    dodgeMode: state.dodgeMode,
    repairMode: state.repairMode,
    blurMode: state.blurMode,
    artContentKind: state.artContentKind,
    layerExpandOnSelect: state.layerExpandOnSelect,
    selectMethod: state.selectMethod,
    selectFromCenter: state.selectFromCenter,
    selectAntialias: state.selectAntialias,
    selectAutoClear: state.selectAutoClear,
    selectShowClicks: state.selectShowClicks,
    deleteHeals: state.deleteHeals,
    rawProfile: state.rawProfile,
    rawSharpening: state.rawSharpening,
    exportQueue: state.exportQueue,
    layout: layoutSnapshot(state),
  };
}

export function uiSettingsCommands(json: string | null): Command[] {
  if (!json) return [];

  try {
    const saved = JSON.parse(json) as Partial<UiSettings>;
    const commands: Command[] = [];

    if (saved.prefs && typeof saved.prefs === "object" && !Array.isArray(saved.prefs)) {
      // The reducer sets an unoffered cadence back to Never; a schedule
      // that stops without a word is the failure this line prevents.
      const cadence = (saved.prefs as { backupEveryDays?: unknown }).backupEveryDays;
      if (cadence !== undefined && !BACKUP_CADENCES.some((c) => c.days === cadence)) {
        logMsg("warn", `Catalog backup cadence ${JSON.stringify(cadence)} in the saved settings is not one Heeler offers; automatic backups are set to Never. Choose a cadence in Preferences > Backup.`);
      }
      commands.push({ type: "set_prefs", prefs: saved.prefs });
    }
    if (typeof saved.selectMethod === "string") {
      commands.push({ type: "set_select_method", method: saved.selectMethod });
    }
    if (isShapeMode(saved.shapeMode)) {
      commands.push({ type: "set_shape_mode", mode: saved.shapeMode });
    }
    if (saved.dodgeMode === "dodge" || saved.dodgeMode === "burn") {
      commands.push({ type: "set_dodge_mode", mode: saved.dodgeMode });
    }
    if (saved.repairMode === "clone" || saved.repairMode === "heal") {
      commands.push({ type: "set_repair_mode", mode: saved.repairMode });
    }
    if (saved.blurMode === "blur" || saved.blurMode === "blend") {
      commands.push({ type: "set_blur_mode", mode: saved.blurMode });
    }
    // An unknown kind (a hand edit, a later build's choice) keeps Pixel.
    if (isArtContentKind(saved.artContentKind)) {
      commands.push({ type: "set_art_content_kind", kind: saved.artContentKind });
    }
    // The tool in hand is not restored: an app that opens with the
    // Magnetic cursor armed and the Selection panel up reads as a
    // selection left half made. A saved "tool" from an older settings
    // file is ignored; the app opens on the cursor.
    for (const key of ["apiEnabled", "selectFromCenter", "selectAntialias", "selectAutoClear", "selectShowClicks", "deleteHeals", "layerExpandOnSelect"] as const) {
      if (typeof saved[key] === "boolean") {
        commands.push({ type: "set_ui_setting", key, value: saved[key] });
      }
    }
    if (saved.rawProfile === "linear" || saved.rawProfile === "standard" || saved.rawProfile === "film") {
      commands.push({ type: "set_ui_setting", key: "rawProfile", value: saved.rawProfile });
    }
    // An unknown value (a hand edit, a later build's choice) leaves
    // the default in place, Standard, the way rawProfile repairs.
    if (isRawSharpening(saved.rawSharpening)) {
      commands.push({ type: "set_ui_setting", key: "rawSharpening", value: saved.rawSharpening });
    }
    if (saved.exportQueue) {
      commands.push({ type: "export_queue_load", queue: saved.exportQueue });
    }
    // The window as it was left. The reducer checks every field, so a
    // hand-edited or older file restores what it can and nothing else.
    if (saved.layout && typeof saved.layout === "object" && !Array.isArray(saved.layout)) {
      commands.push({ type: "restore_layout", layout: saved.layout });
    }
    return commands;
  } catch {
    return [];
  }
}
