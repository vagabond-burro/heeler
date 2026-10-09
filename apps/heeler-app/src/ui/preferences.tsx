import { modLabel } from "../platform";
import { useDialogFocus } from "./dialogfocus";
import { EyeOffIcon, MaskEyeIcon, PinIcon } from "./panelicons";
import { SECTIONS, hiddenSectionCount, sectionHidden } from "./simple";
import React, { useEffect, useMemo, useState } from "react";
import type { Command, State } from "../state";
import { BACKUP_CADENCES, RAW_SHARPENING, tetherShown, DEFAULT_PREFS, MASK_OVERLAY_COLORS, clampMaskOverlayOpacity, SHAPE_LINE_WIDTH_RANGE, clampAutosaveDelay, clampGesturePreviewEdge, clampGrainStep, clampPreviewEdge, clampShapeLineWidth, clampTetherPoll, clampThumbnailEdge, clampViewerRotationStep, clampViewerZoomRate, ribbonBounds, clampDepthSetting, DEPTH_SIZES, snapDepthSize } from "../state";
import {
  catalogUpgradeAlwaysBackup,
  setCatalogUpgradeAlwaysBackup,
  clearProxies,
  clearSmartRasters,
  clearThumbnails,
  modelsLocation,
  modelsMove,
  modelUpdateApply,
  modelUpdatesCheck,
  pickExportFolder,
  revealCatalog,
  revealModels,
  revealProxies,
  revealSmartRasters,
  smartModelDownload,
  smartModelRemove,
  smartModelStatus,
  storageInfo,
  tetherStop,
  usbCameraDisconnect,
  type ModelsLocation,
  type ModelUpdatesCheck,
  type SmartModels,
  type SmartModelStatus,
  type StorageInfo,
} from "../bridge";
import {
  COMMANDS,
  GROUP_ORDER,
  bindingFor,
  bindingOf,
  conflicts,
  exportHotkeys,
  formatBinding,
  importHotkeys,
  isModifierOnly,
  searchCommands,
  type CommandSpec,
} from "../hotkeys";
import { polishEnabled, previewBuild } from "../features";
import {
  CHROME_ZOOM_DEFAULT,
  CHROME_ZOOM_STEPS,
  applyChromeZoom,
  setUiPref,
  uiPref,
} from "../uiprefs";
import { RECENTS_MAX, RECENTS_MIN, clampRecents } from "./nodepalette";
import { TrackSlider, ValueField } from "./track";
import { logMsg } from "../log";
import { BAKED_BACKUP_HINTS } from "../bakedbackups";
import { watchOp } from "./opprogress";
import { ModelConsentCard } from "./modelconsent";
import { AssistantSettings } from "./assistantprefs";
import { MenuField } from "./menufield";
import { PROFILE_CHOICES, SHARPENING_CHOICES, fitOf } from "./sourcemenus";
import { UPDATE_DOWNLOAD_WORDS } from "../updates";

/** The two RAW defaults share one width, the longest choice in either. */
const RAW_DEFAULTS_FIT = fitOf(PROFILE_CHOICES, SHARPENING_CHOICES);

/** Scripting > Media server share link: `serveSimpleLink` false or true. */
const SHARE_LINK_CHOICES = [
  { id: "token", label: "With token", hint: "Protects the next media share with an access token" },
  { id: "simple", label: "Just IP and port", hint: "Uses only the IP address and port on a trusted network" },
];

/** The formats a new export batch can start in, in the menu's order. */
const EXPORT_FORMATS = ["jpeg", "webp", "png", "png16", "tiff", "tiff32", "dng", "exr"] as const;

type D = React.Dispatch<Command>;

export const PREFS_CATEGORIES = [
  { id: "general", label: "General" },
  { id: "interface", label: "Interface" },
  // A sub tab under Interface (2026-09-20): its own pane, listed
  // indented beneath its parent in the rail.
  { id: "adjust-sections", label: "Adjustment sections", parent: "interface" },
  { id: "brush", label: "Editing & Brush" },
  { id: "import", label: "Import & Files" },
  { id: "export", label: "Export" },
  { id: "scripting", label: "Scripting" },
  { id: "assistant", label: "Assistant" },
  { id: "models", label: "Models" },
  { id: "storage", label: "Storage" },
  { id: "backup", label: "Backup" },
  { id: "hotkeys", label: "Hotkeys" },
] as const;
const CATEGORIES = PREFS_CATEGORIES;
type Category = (typeof CATEGORIES)[number]["id"];

const SETTINGS = [
  {
    id: "delete-heals",
    category: "general",
    label: "Deleting reconnects",
    description: "Keeps the graph connected when a node is deleted. Holding SHIFT temporarily reverses the choice.",
  },
  {
    id: "confirm-delete-take",
    category: "general",
    label: "Confirm take deletion",
    description: "Asks before a take and its edits are deleted. The dialog's \"Don't show this again\" turns this off; this switch is the way back.",
  },
  {
    id: "autosave-delay",
    category: "general",
    label: "Autosave settle time",
    description: "Waits for editing to pause before saving the graph and refreshing its thumbnail.",
  },
  {
    id: "experimental-features",
    category: "general",
    label: "Experimental features",
    description:
      "Opens previews of features still being built, starting with the Tether tab. They can be incomplete, they can change, and they may not work with your hardware yet. Turning this off mid-session stops the feature. Feedback is what moves them along.",
  },
  {
    id: "check-updates",
    category: "general",
    label: "Check for updates at launch",
    description:
      `Says at each launch when a newer Heeler exists, read from the public release list. Nothing downloads by itself: ${UPDATE_DOWNLOAD_WORDS} Off, Help > Check for Updates still asks on demand. The check sends your IP address and platform to GitHub, where the releases are hosted.`,
  },
  {
    id: "app-zoom",
    category: "interface",
    label: "App zoom",
    description: "Makes panels, the ribbon, and dialogs larger without scaling the photograph.",
  },
  {
    id: "expand-on-enable",
    category: "interface",
    label: "Open a section when switched on",
    description: "Unfolds a collapsed section the moment its switch turns on. Off, the section stays as it was, and opens when you click its title.",
  },
  {
    id: "palette-recents",
    category: "interface",
    label: "Recent nodes shown",
    description: "Sets how many recent nodes appear before typing in the node palette.",
  },
  {
    id: "console-customs",
    category: "interface",
    label: "Color Tune custom bands",
    description: "Sets how many picked bands Color Tune can hold beyond its six fixed families.",
  },
  {
    id: "curve-mode",
    category: "interface",
    label: "Curves channels",
    description:
      "How Curves opens on a photograph: the RGB channels, or the same curves seen as ink (CMY, C, M, Y), where raising C adds cyan. The toggle in Curves switches for the photograph on screen only; the next photograph opens the way this says.",
  },
  {
    id: "adjust-sections",
    category: "adjust-sections",
    label: "Adjustment sections",
    description:
      "Which sections the Adjustments panel lists, and which sit pinned at its top. A hidden section leaves the panel, the section walk and Find a Control; a photograph that has it switched on keeps rendering it, and its node is still in the graph. Reset puts every section back.",
  },
  {
    id: "shape-line-width",
    category: "interface",
    label: "Shape outline thickness",
    description: "Sets how thick Shape Warp's rings and the Radial layer's gizmo draw over the photograph, in pixels; a photograph's Shape Warp can set its own.",
  },
  {
    id: "viewer-zoom-speed",
    category: "interface",
    label: "Viewer zoom speed",
    description: "Controls how quickly wheel and trackpad movement changes magnification in the viewer and graph.",
  },
  {
    id: "viewer-rotation-step",
    category: "interface",
    label: "Viewer rotation step",
    description: "Sets the number of degrees applied by each modified wheel rotation step.",
  },
  {
    id: "wheel-zoom-direction",
    category: "interface",
    label: "Wheel zoom direction",
    description: "Flips which scroll direction zooms in, in the viewer and the graph.",
  },
  {
    id: "gpu-previews",
    category: "interface",
    label: "GPU previews",
    description: "Uses the graphics card for the interactive preview; exports always render on the CPU.",
  },
  {
    id: "preview-quality",
    category: "interface",
    label: "Interactive render quality",
    description: "Sets the least settled preview edge (the render grows to fit the viewer, up to 4096 pixels) and the smaller edge used while a brush or slider gesture is live.",
  },
  {
    id: "preview-settle",
    category: "interface",
    label: "Settled preview",
    description: "What the preview shows once your hand is off: the reduced tier, or the whole photograph at its own pixels, rendered after the reduced frame and swapped in. Full shows a JPEG of the full-resolution render at the chosen settled quality, at the cost of seconds per edit on a large photograph.",
  },
  {
    id: "preview-settle-quality",
    category: "interface",
    label: "Settled frame quality",
    description: "How the Full settled frame travels from the engine: Smaller for a slow machine, Balanced for most, Sharper for a large display where the frame is shown near its own pixels. The reduced frames and the 1:1 view are not affected.",
  },
  {
    id: "ribbon-sizing",
    category: "interface",
    label: "Thumbnail ribbon limits",
    description: "Sets the narrowest and widest widths available when dragging the thumbnail ribbon.",
  },
  {
    id: "thumbnail-quality",
    category: "interface",
    label: "Thumbnail render quality",
    description: "Sets the longest edge generated for newly loaded or refreshed thumbnail images.",
  },
  {
    id: "grain-steps",
    category: "brush",
    label: "Grain rotation steps",
    description: "Sets the coarse and fine grain rotation applied by the brush keyboard shortcuts.",
  },
  {
    id: "mask-overlay-color",
    category: "brush",
    label: "Mask overlay color",
    description: "Changes the mask wash color in the viewer, brush cursor, and rendered overlay.",
  },
  {
    id: "mask-overlay-opacity",
    category: "brush",
    label: "Mask overlay opacity",
    description: "How strongly the overlay tints where a mask or depth map is white; gray tints in proportion. The brush panel's Overlay slider starts here.",
  },
  {
    id: "raw-profile",
    category: "import",
    label: "RAW default profile",
    description: "Chooses the tone profile applied when a RAW photograph is first imported.",
  },
  {
    id: "raw-sharpening",
    category: "import",
    label: "RAW default sharpening",
    description: "Starts newly imported RAW files with this capture sharpening: Off, Low, Standard or High. Photographs already edited keep their own; the Source section changes it per photograph.",
  },
  {
    id: "tether-defaults",
    category: "import",
    label: "Tether session defaults",
    description: "Sets the starting destination, naming pattern, auto-advance behavior, and polling interval for new tether sessions.",
  },
  {
    id: "quick-export",
    category: "export",
    label: "Quick Export quality and size",
    description: "Keeps the one-click export settings beside the title-bar Export button where they are used.",
  },
  {
    id: "export-defaults",
    category: "export",
    label: "New export batch defaults",
    description: "Sets the format, filename template, and metadata choice inherited by each new export batch.",
  },
  {
    id: "export-overwrite",
    category: "export",
    label: "Never overwrite an existing file",
    description:
      "Saves an export whose name is already taken to the next free name, adding -2, -3, instead of writing over the file. A batch always does; off, a save dialog's Replace? is honored. Either way, an export never writes over a photograph in your library.",
  },
  {
    id: "python-api",
    category: "scripting",
    label: "Python scripting",
    description: "Allows token-protected local Python scripts to control the running app.",
  },
  {
    id: "share-link",
    category: "scripting",
    label: "Media server share link",
    description: "Chooses a protected token link or a shorter address for trusted home networks.",
  },
  {
    id: "assistant-enable",
    category: "assistant",
    label: "Assistant",
    description:
      "Adds an Assistant tab to the Console that answers questions about Heeler from its user guide, using a model you run in an app such as LM Studio or Ollama, on this computer or another one on your home network. It stays off until you turn it on, and the first time you do, you accept a short notice. It cannot change your photographs, your edits, the catalog or any file.",
  },
  {
    id: "assistant-server",
    category: "assistant",
    label: "Server address",
    description:
      "Where your model server is running. LM Studio uses http://localhost:1234 and Ollama uses http://localhost:11434 unless you changed them. A server on another computer at home is reached by its name (such as http://studio.local:1234) or its address. Heeler only connects to this computer or your home network, never the internet.",
  },
  {
    id: "assistant-model",
    category: "assistant",
    label: "Model",
    description: "The model that answers, chosen from the server's list after you press Validate. A model Heeler has not tested asks you to acknowledge it once.",
  },
  {
    id: "assistant-works-with",
    category: "assistant",
    label: "Works with",
    description: "Apps that run models on your computer or a home server. Heeler does not start them: start the app's server yourself, then press Validate.",
  },
  {
    id: "assistant-florence",
    category: "assistant",
    label: "Florence-2",
    description:
      "Lets the assistant know what is in your photograph (the sky, a face, a car) and where, so its advice can point at the right part of the picture. It runs on this computer; nothing is sent anywhere. It is optional: without it the assistant works from the photograph's numbers.",
  },
  {
    id: "depth-edges",
    category: "models",
    label: "Depth map edges",
    description: "Sets the Edges a photograph's Depth Map section starts with and resets to: how firmly the depth's edges snap onto the photograph's.",
  },
  {
    id: "depth-flatten",
    category: "models",
    label: "Depth map flatten",
    description: "Sets the Flatten a photograph's Depth Map section starts with and resets to: how much ripple is smoothed out of what the photograph shows as flat.",
  },
  {
    id: "depth-size",
    category: "models",
    label: "Depth map detail",
    description: "Sets the working size a photograph's Depth Map section starts with: the model's own 518 px, or 700 or 1036 for finer edges at a slower read.",
  },
  {
    id: "model-inventory",
    category: "models",
    label: "Downloaded models",
    description: "Shows installed smart-tool models and their disk use, and points the model store at another folder or drive.",
  },
  {
    id: "storage-caches",
    category: "storage",
    label: "Caches on disk",
    description: "Shows what the thumbnail, proxy and depth caches hold and clears any of them; each rebuilds as you work.",
  },
  {
    id: "catalog-backup",
    category: "backup",
    label: "Catalog backup",
    description: "Checks once at launch and copies the catalog when due, into an existing folder. Changes take effect at the next launch. Backups are never removed automatically.",
  },
  {
    id: "baked-backups",
    category: "backup",
    label: "Keep baked pictures in backups",
    description: "On, a recovery bundle can restore the layers Layer via Copy and Bake Warp made, since it carries their pictures. Off, bundles are smaller, but a baked or copied layer whose picture is lost cannot come back.",
  },
  {
    id: "catalog-upgrade-backup",
    category: "backup",
    label: "Update backup",
    description: "When a newer Heeler first opens a catalog written by an older one, it updates the catalog file, which cannot be undone. With this on, a dated copy of the old file is written beside it first, without asking. Either way the update prompt always offers the choice.",
  },
  {
    id: "keyboard-shortcuts",
    category: "hotkeys",
    label: "Keyboard shortcuts",
    description: "Finds, rebinds, imports, exports, and resets command shortcuts.",
  },
] as const satisfies readonly {
  id: string;
  category: Category;
  label: string;
  description: string;
}[];

type Setting = (typeof SETTINGS)[number];
type SettingId = Setting["id"];

function setting(id: SettingId): Setting {
  return SETTINGS.find((item) => item.id === id)!;
}

/** A preference's description by its id, for tests that hold its words
 * to the dialogs and menus that describe the same behavior. */
export function settingDescription(id: string): string | undefined {
  return SETTINGS.find((item) => item.id === id)?.description;
}

function categoryLabel(category: Category): string {
  return CATEGORIES.find((item) => item.id === category)!.label;
}

/** Preferences > Interface > Adjustment sections: every section the
 * panel can list, each with two toggles that show their own state,
 * an eye for whether it is listed and a pin for the pinned group,
 * and a Reset that puts every section back (2026-09-20: "a list of
 * all sections in Adjustments that the user can check on or off the
 * visibility ... this same list a user should be able to control
 * pinned sections as well"). Source has no switch and is not
 * offered.*/
function SectionsControl({ state, dispatch }: { state: State; dispatch: D }) {
  const listed = SECTIONS.filter((sec) => !sec.hideToggle);
  const hidden = hiddenSectionCount(state);
  const slug = (title: string) => title.toLowerCase().replace(/[^a-z]+/g, "-");
  return (
    <div data-testid="prefs-sections" style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      {listed.map((sec) => {
        const shown = !sectionHidden(state, sec);
        const pinned = state.prefs.pinnedSections.includes(sec.title);
        return (
          <div
            key={sec.title}
            data-testid={`prefs-section-${slug(sec.title)}`}
            style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 0", fontSize: 12, color: shown ? "var(--text-body)" : "var(--text-faint)" }}
          >
            <span style={{ flex: 1 }}>{sec.title}</span>
            <button
              className="chip"
              data-testid={`prefs-section-pin-${slug(sec.title)}`}
              data-active={pinned}
              aria-pressed={pinned}
              aria-label={pinned ? `Unpin ${sec.title}` : `Pin ${sec.title}`}
              data-hint={pinned ? "Pinned to the top of the Adjustments panel. Click to unpin" : "Pins this section to the top of the Adjustments panel"}
              style={{ padding: "2px 7px", display: "inline-flex", alignItems: "center" }}
              onClick={() => dispatch({ type: "toggle_pinned_section", title: sec.title })}
            >
              <PinIcon filled={pinned} />
            </button>
            <button
              className="chip"
              data-testid={`prefs-section-visible-${slug(sec.title)}`}
              data-active={shown}
              aria-pressed={shown}
              aria-label={shown ? `Hide ${sec.title}` : `Show ${sec.title}`}
              data-hint={shown ? "Listed in the Adjustments panel. Click to take it out; a photograph that has it on keeps rendering it" : "Hidden from the Adjustments panel. Click to list it again"}
              style={{ padding: "2px 7px", display: "inline-flex", alignItems: "center" }}
              onClick={() => dispatch({ type: "toggle_hidden_section", title: sec.title })}
            >
              {shown ? <MaskEyeIcon /> : <EyeOffIcon />}
            </button>
          </div>
        );
      })}
      {/* The hint rides the wrapper: a disabled button takes no hover,
          and Reset is disabled while nothing is hidden. */}
      <div
        style={{ display: "flex", justifyContent: "flex-end", marginTop: 6 }}
        data-hint={hidden === 0 ? "Every section is listed; Reset has nothing to do" : `Reset lists every section again (${hidden} hidden now)`}
      >
        <button
          className="chip"
          data-testid="prefs-sections-reset"
          disabled={hidden === 0}
          style={{ fontSize: 11, padding: "1px 8px" }}
          onClick={() => dispatch({ type: "show_all_sections" })}
        >
          Reset
        </button>
      </div>
    </div>
  );
}

function SettingBlock({
  id,
  landing,
  control,
  wide = false,
}: {
  id: SettingId;
  landing: SettingId | null;
  control: React.ReactNode;
  /** the label becomes a header above a full-width control, for
   * settings whose control IS the content (the models table) */
  wide?: boolean;
}) {
  const item = setting(id);
  if (React.isValidElement<React.HTMLAttributes<HTMLElement>>(control) && control.props.role === "switch") {
    control = React.cloneElement(control, {
      "aria-label": item.label, tabIndex: 0,
      onKeyDown: event => {
        if (event.key === " " || event.key === "Enter") { event.preventDefault(); event.currentTarget.click(); }
      },
    });
  }
  const active = landing === id;
  return (
    <div
      data-pref-row={id}
      data-testid={`prefs-row-${id}`}
      style={{
        padding: "14px",
        margin: "0 -14px",
        borderTop: "1px solid var(--line-1)",
        background: active ? "color-mix(in srgb, var(--accent) 13%, transparent)" : "transparent",
        boxShadow: active ? "inset 3px 0 var(--accent)" : "none",
        transition: "background 180ms ease, box-shadow 180ms ease",
      }}
    >
      {wide ? (
        <>
          <div style={{ fontSize: 14, color: "var(--text-body)", paddingBottom: 9 }}>{item.label}</div>
          {control}
        </>
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(135px, 175px) minmax(0, 1fr)",
            alignItems: "center",
            gap: 18,
          }}
        >
          <div style={{ fontSize: 14, color: "var(--text-body)" }}>{item.label}</div>
          {control}
        </div>
      )}
      <div
        style={{
          fontSize: 13.5,
          color: "var(--text-ghost)",
          lineHeight: 1.55,
          marginTop: 7,
          maxWidth: 680,
        }}
      >
        {item.description}
      </div>
    </div>
  );
}

function CategoryHeading({ category }: { category: Category }) {
  return (
    <div className="kicker" style={{ fontSize: 10, letterSpacing: ".14em", paddingBottom: 12 }}>
      {categoryLabel(category)}
    </div>
  );
}

function NumericSetting({
  id,
  landing,
  label,
  testid,
  value,
  lo,
  hi,
  suffix = "",
  step,
  onChange,
}: {
  id: SettingId;
  landing: SettingId | null;
  label: string;
  testid: string;
  value: number;
  lo: number;
  hi: number;
  suffix?: string;
  /** the slider's step; a short whole-number range wants 1, or the
   * arrow keys round back to where they started */
  step?: number;
  onChange: (value: number) => void;
}) {
  const hint = `${setting(id).description} Current value ${value}${suffix}`;
  return (
    <div className="pnum">
      <div className="tnum" style={{ fontSize: 12.5, color: "var(--text-body)" }}>{label}</div>
      <TrackSlider
        label={label}
        testid={testid}
        hint={hint}
        value={value}
        lo={lo}
        hi={hi}
        step={step}
        onChange={(next) => onChange(Math.min(hi, Math.max(lo, Math.round(next))))}
      />
      <ValueField
        param={testid}
        testid={`${testid}-value`}
        hint={`Types the ${label.toLowerCase()} value from ${lo} to ${hi}`}
        value={value}
        lo={lo}
        hi={hi}
        display={(next) => `${Math.round(next)}${suffix}`}
        onCommit={(next) => onChange(Math.round(next))}
      />
    </div>
  );
}

function BindingChip({ binding, clash }: { binding: string; clash: boolean }) {
  return (
    <span
      className="tnum"
      style={{
        fontSize: 11,
        fontFamily: "ui-monospace, monospace",
        padding: "1px 6px",
        border: "1px solid",
        borderColor: clash ? "var(--reject)" : binding ? "var(--line-4)" : "transparent",
        borderRadius: 2,
        color: clash ? "var(--reject)" : binding ? "var(--text-body)" : "var(--text-ghost)",
      }}
    >
      {formatBinding(binding) || "unbound"}
    </span>
  );
}

function HotkeyRow({
  spec,
  binding,
  clash,
  capturing,
  onCapture,
  onClear,
  onReset,
}: {
  spec: CommandSpec;
  binding: string;
  clash: boolean;
  capturing: boolean;
  onCapture: () => void;
  onClear: () => void;
  onReset: () => void;
}) {
  const changed = binding !== spec.binding;
  return (
    <div
      data-testid={`hotkey-row-${spec.id}`}
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(180px, 1fr) auto auto auto",
        alignItems: "center",
        gap: 6,
        padding: "4px 12px",
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 14, color: "var(--text-body)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {spec.label}
        </div>
        {spec.blurb && <div style={{ fontSize: 13.5, color: "var(--text-ghost)" }}>{spec.blurb}</div>}
      </div>
      <button
        className="chip"
        aria-label={`Shortcut for ${spec.label}`} data-testid={`hotkey-bind-${spec.id}`}
        data-capturing={capturing || undefined}
        data-hint={capturing ? "Captures the next shortcut you press" : "Starts capturing a new shortcut"}
        onClick={onCapture}
        style={{
          padding: "1px 4px",
          borderColor: capturing ? "var(--accent)" : "transparent",
          background: capturing ? "#202326" : "transparent",
        }}
      >
        {capturing ? <span style={{ fontSize: 11, color: "var(--accent)" }}>press keys...</span> : <BindingChip binding={binding} clash={clash} />}
      </button>
      <span data-hint="Leaves this command without a shortcut; available when a shortcut is assigned"><button
        className="chip" disabled={!binding} aria-label={`Clear shortcut for ${spec.label}`}
        data-testid={`hotkey-clear-${spec.id}`}
        data-hint="Leaves this command without a shortcut"
        style={{ fontSize: 11, padding: "1px 5px" }}
        onClick={onClear}
      >
        ✕
      </button></span>
      <span data-hint="Restores the default shortcut; available after this shortcut is customized"><button
        className="chip" disabled={!changed} aria-label={`Reset shortcut for ${spec.label}`}
        data-testid={`hotkey-reset-${spec.id}`}
        data-hint="Restores the default shortcut for this command"
        style={{ fontSize: 11, padding: "1px 5px" }}
        onClick={onReset}
      >
        ↺
      </button></span>
    </div>
  );
}

function bytesLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** "I just don't like the idea of temporary, and
 * re-creatable, data just filling disk space without giving the user
 * a way to manage their storage." One row per cache: what it holds, a
 * Clear, and a door to where it lives. Thumbnails are rows inside the
 * catalog file, so their door is the catalog's folder; proxies and
 * smart rasters are folders of their own. No confirmation, since
 * nothing is lost: each cache rebuilds as the user works, and the
 * hint says at what cost.*/
function StorageControl() {
  const [info, setInfo] = useState<StorageInfo | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    void storageInfo().then((next) => {
      if (live) setInfo(next);
    });
    return () => {
      live = false;
    };
  }, [tick]);
  const clear = (id: string, act: () => Promise<number>) => {
    setBusy(id);
    // The row id and the operation's name are the same string: the
    // sweep's reports raise a row while the promise runs and it goes
    // when the promise settles, either way.
    void watchOp(id, act).finally(() => {
      setBusy(null);
      setTick((t) => t + 1);
    });
  };
  const rows: {
    id: string;
    label: string;
    holds: string;
    rebuilds: string;
    count: number;
    bytes: number;
    clear: () => Promise<number>;
    reveal: () => Promise<void>;
    revealHint: string;
  }[] = [
    {
      id: "thumbnails",
      label: "Thumbnails",
      holds: "One small preview per photograph, kept inside the catalog file",
      rebuilds: "Rebuilds as photographs are viewed, from the originals",
      count: info?.thumbnails ?? 0,
      bytes: info?.thumbnail_bytes ?? 0,
      clear: clearThumbnails,
      reveal: revealCatalog,
      revealHint: "Opens the folder holding the catalog file",
    },
    {
      id: "proxies",
      label: "Stack and panorama proxies",
      holds: "Rendered stacks and panoramas, so reopening one is instant",
      rebuilds: "Rebuilds on the next open of each stack or panorama, at the cost of that render",
      count: info?.proxies ?? 0,
      bytes: info?.proxy_bytes ?? 0,
      clear: clearProxies,
      reveal: revealProxies,
      revealHint: "Opens the proxies folder",
    },
    {
      id: "rasters",
      label: "Depth and matte rasters",
      holds: "The depth planes and refined mattes the smart tools computed; baked selections and chosen inpaint fills live apart and are never cleared",
      rebuilds: "Rebuilds the next time a tool asks, at the cost of that model run",
      count: info?.rasters ?? 0,
      bytes: info?.raster_bytes ?? 0,
      clear: clearSmartRasters,
      reveal: revealSmartRasters,
      revealHint: "Opens the rasters folder",
    },
  ];
  return (
    <div className="pstack" data-testid="prefs-storage" style={{ gap: 12 }}>
      {rows.map((row) => (
        <div key={row.id} data-testid={`prefs-storage-${row.id}`} style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12, color: "var(--text-body)" }}>{row.label}</div>
            <div style={{ fontSize: 11, color: "var(--text-faint)", lineHeight: 1.5 }}>
              {row.holds}. {row.rebuilds}.
            </div>
          </div>
          <span
            className="tnum"
            data-testid={`prefs-storage-size-${row.id}`}
            style={{ fontSize: 11, color: "var(--text-ghost)", alignSelf: "center", whiteSpace: "nowrap" }}
          >
            {info ? `${row.count.toLocaleString()} · ${bytesLabel(row.bytes)}` : ""}
          </span>
          <button
            className="chip"
            data-testid={`prefs-storage-clear-${row.id}`}
            data-hint={`${row.rebuilds}; nothing you made is lost`}
            disabled={busy !== null || (info !== null && row.count === 0)}
            style={{ fontSize: 11, padding: "1px 8px", flex: "none", alignSelf: "center" }}
            onClick={() => clear(row.id, row.clear)}
          >
            CLEAR
          </button>
          {busy === row.id && (
            <span
              className="op-pending"
              data-testid={`prefs-storage-busy-${row.id}`}
              style={{ fontSize: 11, color: "var(--text-faint)", alignSelf: "center", whiteSpace: "nowrap" }}
            >
              Clearing...
            </span>
          )}
          <button
            className="chip"
            data-testid={`prefs-storage-reveal-${row.id}`}
            data-hint={row.revealHint}
            style={{ fontSize: 11, padding: "1px 8px", flex: "none", alignSelf: "center" }}
            onClick={() => void row.reveal()}
          >
            SHOW ON DISK
          </button>
        </div>
      ))}
    </div>
  );
}

function ModelsControl({ state, dispatch }: { state: State; dispatch: D }) {
  const [models, setModels] = useState<SmartModels | null>(null);
  const [location, setLocation] = useState<ModelsLocation | null>(null);
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [pendingMove, setPendingMove] = useState<{ target: string; pref: string } | null>(null);
  const [moveError, setMoveError] = useState<string | null>(null);
  // The model list's answer: the installed models it has newer weights for,
  // or the words for why it could not say.
  const [updates, setUpdates] = useState<ModelUpdatesCheck | null>(null);
  const [updatesError, setUpdatesError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [applying, setApplying] = useState<string | null>(null);
  // INSTALL from the table (2026-09-09: "proactively install it from
  // Preferences"): the same consent card every tool shows, under the
  // table, naming the model, its size, its license and its source
  // before a byte is fetched; the download runs on the card's button.
  const [consent, setConsent] = useState<string | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);
  const working = busy || installing !== null || applying !== null;
  useEffect(() => {
    let live = true;
    void smartModelStatus().then((next) => {
      if (live) setModels(next);
    });
    void modelsLocation().then((next) => {
      if (live) setLocation(next);
    });
    return () => {
      live = false;
    };
  }, [busy, refresh, state.prefs.modelStoreDir]);

  const known = [
    { id: "mobile_sam", label: "Segment Anything (MobileSAM)" },
    { id: "birefnet_lite", label: "BiRefNet Lite (subject matte)" },
    { id: "lama", label: "LaMa (inpainting)" },
    { id: "vitmatte", label: "ViTMatte (edge refinement)" },
    { id: "depth_anything_v2_small", label: "Depth Anything V2 Small (scene depth)" },
    { id: "scunet_color_real_psnr", label: "SCUNet (noise reduction)" },
    { id: "florence_2_base", label: "Florence-2 base (what is in the picture)" },
  ];
  // The table renders at once, before the disk answers: the registry is
  // static, so the rows are, and only the status cell waits for the
  // check, blank rather than guessing (a flashed "not installed" on an
  // installed model is a small lie with a visible correction).
  // A desktop older than Florence-2 (or a test's partial answer) has
  // no florence entry; the row is simply not there then.
  const listed = (m: SmartModels) =>
    [m.sam, m.matte, m.fill, m.refine, m.depth, m.denoise, m.florence].filter((x): x is SmartModelStatus => !!x);
  const rows = models
    ? listed(models)
    : known.map((item) => ({ ...item, installed: false, license: "", url: "", bytes: 0, version: "", pending: true }));

  const setPref = (prefs: Partial<State["prefs"]>) => dispatch({ type: "set_prefs", prefs });
  const anyInstalled = models ? listed(models).some((model) => model.installed) : false;
  const prefDir = state.prefs.modelStoreDir ?? "";
  const applyLocation = (base: string) => {
    setMoveError(null);
    setPendingMove(null);
    setPref({ modelStoreDir: base === location?.defaultBase ? "" : base });
  };
  const pickLocation = () =>
    void pickExportFolder().then((folder) => {
      if (!folder) return;
      if (anyInstalled) setPendingMove({ target: folder, pref: folder === location?.defaultBase ? "" : folder });
      else applyLocation(folder);
    });
  const moveThenApply = (move: { target: string; pref: string }) => {
    setBusy(true);
    setMoveError(null);
    modelsMove(move.target)
      .then(() => applyLocation(move.pref))
      .catch((error) => setMoveError(String(error)))
      .finally(() => setBusy(false));
  };

  return (
    <div>
      <div role="table" aria-label="Downloaded models" style={{ display: "grid", gridTemplateColumns: "minmax(160px, 1fr) 150px 84px", columnGap: 10 }}>
        <div role="row" className="kicker" style={{ display: "contents", fontSize: 10 }}>
          <span role="columnheader">Model</span>
          <span role="columnheader">Status / size on disk</span>
          <span role="columnheader" aria-label="Actions" />
        </div>
        {rows.map((model) => (
          <div key={model.id} role="row" data-testid={`prefs-model-${model.id}`} style={{ display: "contents" }}>
            <span role="cell" style={{ fontSize: 14, color: "var(--text-body)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", padding: "4px 0", borderBottom: "1px solid var(--line-1)" }}>
              {model.label}
            </span>
            <span role="cell" data-testid={`prefs-model-status-${model.id}`} style={{ fontSize: 11, color: "var(--text-ghost)", alignSelf: "center", padding: "4px 0", borderBottom: "1px solid var(--line-1)" }}>
              {"pending" in model ? "\u00a0" : model.installed ? `installed \u00b7 ${Math.round(model.bytes / 1e6)} MB \u00b7 ${model.version}` : "not installed"}
            </span>
            <span role="cell" style={{ alignSelf: "center", padding: "4px 0", borderBottom: "1px solid var(--line-1)" }}>
              {!("pending" in model) && !model.installed && (
                <button
                  className="chip"
                  data-testid={`prefs-model-install-${model.id}`}
                  disabled={working}
                  data-active={consent === model.id || undefined}
                  data-hint="Download this model now, before its tool asks for it; the card below names the size, license and source first"
                  style={{ fontSize: 11, padding: "1px 8px" }}
                  onClick={() => setConsent((cur) => (cur === model.id ? null : model.id))}
                >
                  {installing === model.id ? "INSTALLING\u2026" : "INSTALL"}
                </button>
              )}
              {model.installed && (
                <button
                  className="chip"
                  data-testid={`prefs-model-remove-${model.id}`}
                  disabled={working}
                  data-hint="Frees this model's disk space; its tool can download it again later"
                  style={{ fontSize: 11, padding: "1px 8px" }}
                  onClick={() => {
                    setBusy(true);
                    void smartModelRemove(model.id)
                      .catch((error) => logMsg("error", String(error)))
                      .finally(() => setBusy(false));
                  }}
                >
                  REMOVE
                </button>
              )}
            </span>
          </div>
        ))}
      </div>
      {consent && models && (() => {
        const model = rows.find((m) => m.id === consent);
        if (!model || "pending" in model || model.installed) return null;
        return (
          <ModelConsentCard
            title={`INSTALL ${model.label.toUpperCase()}`}
            model={model}
            testid={`prefs-install-${model.id}`}
            downloading={installing === model.id}
            place={{ marginTop: 8, fontSize: 13, maxWidth: "100%" }}
            onDownload={() => {
              setInstalling(model.id);
              void smartModelDownload(model.id)
                .then(() => {
                  logMsg("info", `${model.label} installed`);
                  setConsent(null);
                  setRefresh((n) => n + 1);
                })
                .catch((error) => logMsg("error", String(error)))
                .finally(() => setInstalling(null));
            }}
            secondary={{ label: "NOT NOW", testid: `prefs-install-${model.id}-later`, onClick: () => setConsent(null) }}
          />
        );
      })()}
      <div style={{ display: "flex", alignItems: "center", gap: 9, marginTop: 8, flexWrap: "wrap" }}>
        <button
          className="chip"
          data-testid="prefs-models-check-updates"
          disabled={checking || busy}
          data-hint="Ask the model list whether newer weights exist for the models installed here; the list is vetted by Vagabond Burro, never upstream's latest"
          style={{ fontSize: 11, padding: "1px 8px" }}
          onClick={() => {
            setChecking(true);
            setUpdatesError(null);
            void modelUpdatesCheck()
              .then(setUpdates)
              .catch((error) => {
                setUpdates(null);
                setUpdatesError(String(error instanceof Error ? error.message : error));
              })
              .finally(() => setChecking(false));
          }}
        >
          {checking ? "CHECKING\u2026" : "CHECK FOR MODEL UPDATES"}
        </button>
        {updatesError && (
          <span data-testid="prefs-models-updates-error" style={{ fontSize: 11, color: "var(--text-dim)" }}>{updatesError}</span>
        )}
        {updates && updates.updates.length === 0 && (
          <span data-testid="prefs-models-updates" style={{ fontSize: 11, color: "var(--text-dim)" }}>
            {updates.checked === 0 ? "No models installed to check." : `The ${updates.checked} installed ${updates.checked === 1 ? "model is" : "models are"} current.`}
          </span>
        )}
      </div>
      {updates && updates.updates.length > 0 && (
        <div data-testid="prefs-models-updates" style={{ display: "grid", rowGap: 4, marginTop: 6 }}>
          {updates.updates.map((u) => (
            <div key={u.id} data-testid={`prefs-model-update-${u.id}`} style={{ display: "flex", alignItems: "center", gap: 9 }}>
              <span style={{ fontSize: 12, color: "var(--text-body)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {u.label}: {u.installed} {"\u2192"} {u.latest} {"\u00b7"} {Math.round(u.bytes / 1e6)} MB{u.notes ? ` \u00b7 ${u.notes}` : ""}
              </span>
              <button
                className="chip"
                data-testid={`prefs-model-update-apply-${u.id}`}
                disabled={working}
                data-hint="Download the newer weights over the ones in place; the tool that uses them picks them up on its next run"
                style={{ fontSize: 11, padding: "1px 8px" }}
                onClick={() => {
                  setApplying(u.id);
                  void modelUpdateApply(u.id)
                    .then(() => {
                      logMsg("info", `${u.label} updated to ${u.latest}`);
                      setUpdates((cur) => (cur ? { ...cur, updates: cur.updates.filter((x) => x.id !== u.id) } : cur));
                      setRefresh((n) => n + 1);
                    })
                    .catch((error) => logMsg("error", String(error)))
                    .finally(() => setApplying(null));
                }}
              >
                {applying === u.id ? "UPDATING\u2026" : "UPDATE"}
              </button>
            </div>
          ))}
        </div>
      )}
      <div style={{ display: "flex", alignItems: "center", gap: 9, marginTop: 10 }}>
        <button
          className="chip"
          data-testid="prefs-models-choose"
          data-hint="Points the model store at another folder or drive"
          style={{ fontSize: 11, padding: "2px 9px", flex: "none" }}
          onClick={pickLocation}
        >
          CHOOSE FOLDER
        </button>
        <span className="tnum" data-testid="prefs-models-location" style={{ fontSize: 11, color: "var(--text-faint)", minWidth: 0, wordBreak: "break-all" }}>
          {location?.current ?? (prefDir || "the app data folder")}
        </span>
        <button
          className="chip"
          data-testid="prefs-models-reveal"
          data-hint="Opens the folder containing downloaded model files"
          style={{ fontSize: 11, padding: "1px 8px", flex: "none" }}
          onClick={() => void revealModels()}
        >
          SHOW ON DISK
        </button>
        {(location?.custom || (!location && prefDir)) && (
          <button
            className="chip"
            data-testid="prefs-models-default"
            data-hint="Points the model store back at the built-in location"
            style={{ fontSize: 11, padding: "2px 9px", flex: "none" }}
            onClick={() => {
              if (anyInstalled && location) setPendingMove({ target: location.defaultBase, pref: "" });
              else setPref({ modelStoreDir: "" });
            }}
          >
            USE DEFAULT
          </button>
        )}
      </div>
      {pendingMove && (
        <div data-testid="prefs-models-move-offer" style={{ marginTop: 9, fontSize: 13.5, color: "var(--text-body)", lineHeight: 1.55 }}>
          Move the installed models to {pendingMove.target}? They copy over first; the old copies are
          removed only after every file verifies. Switching without moving leaves the old copies where
          they are, and each tool offers its download again at the new location.
          <div style={{ display: "flex", gap: 8, marginTop: 7 }}>
            <button
              className="chip"
              data-testid="prefs-models-move"
              disabled={working}
              data-hint="Copies the models to the new location, then removes the old copies"
              style={{ fontSize: 11, padding: "2px 9px" }}
              onClick={() => moveThenApply(pendingMove)}
            >
              MOVE MODELS
            </button>
            <button
              className="chip"
              data-testid="prefs-models-switch"
              disabled={working}
              data-hint="Uses the new location and leaves the old copies behind"
              style={{ fontSize: 11, padding: "2px 9px" }}
              onClick={() => applyLocation(pendingMove.pref === "" ? location?.defaultBase ?? pendingMove.target : pendingMove.pref)}
            >
              SWITCH ONLY
            </button>
            <button
              className="chip"
              data-testid="prefs-models-move-cancel"
              data-hint="Keeps the current model location"
              style={{ fontSize: 11, padding: "2px 9px" }}
              onClick={() => setPendingMove(null)}
            >
              CANCEL
            </button>
          </div>
        </div>
      )}
      {moveError && (
        <div data-testid="prefs-models-move-error" style={{ marginTop: 7, fontSize: 13.5, color: "var(--reject)", lineHeight: 1.5 }}>
          {moveError}
        </div>
      )}
    </div>
  );
}

function AppZoomControl() {
  const [zoom, setZoom] = useState<number>(() => uiPref("chromeZoom", CHROME_ZOOM_DEFAULT));
  return (
    <div className="zoom-seg" role="group" aria-label="App zoom" style={{ border: "1px solid var(--line-4)", width: "fit-content" }}>
      {CHROME_ZOOM_STEPS.map((next) => (
        <button
          key={next}
          data-active={zoom === next} aria-pressed={!!(zoom === next)}
          data-testid={`prefs-app-zoom-${Math.round(next * 100)}`}
          data-hint={`Scales app controls to ${Math.round(next * 100)} percent`}
          style={{ fontSize: 11, padding: "1px 9px" }}
          onClick={() => {
            setZoom(next);
            setUiPref("chromeZoom", next);
            applyChromeZoom(next);
          }}
        >
          {Math.round(next * 100)}%
        </button>
      ))}
    </div>
  );
}

function HotkeysPanel({
  state,
  capturing,
  setCapturing,
  query,
  setQuery,
  setHotkeys,
}: {
  state: State;
  capturing: string | null;
  setCapturing: (id: string | null) => void;
  query: string;
  setQuery: (value: string) => void;
  setHotkeys: (next: Record<string, string>) => void;
}) {
  const overrides = state.prefs.hotkeys;
  const clashes = conflicts(overrides);
  const clashing = new Set([...clashes.values()].flat());
  const rows = searchCommands(query, overrides).filter((command) => command.id !== "select.polish" || polishEnabled());
  const grouped = GROUP_ORDER.map((group) => ({
    group,
    items: rows.filter((command) => command.group === group),
  })).filter((group) => group.items.length > 0);

  const doExport = () => {
    const url = URL.createObjectURL(new Blob([exportHotkeys(overrides)], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "heeler-hotkeys.json";
    anchor.click();
    URL.revokeObjectURL(url);
    logMsg("info", "Exported hotkeys");
  };
  const doImport = (file: File) => {
    void file.text().then((text) => {
      try {
        const { hotkeys, dropped } = importHotkeys(text);
        setHotkeys(hotkeys);
        logMsg(
          dropped.length ? "warn" : "info",
          dropped.length
            ? `Imported hotkeys; ignored ${dropped.length} unknown command${dropped.length === 1 ? "" : "s"}: ${dropped.join(", ")}`
            : "Imported hotkeys",
        );
      } catch (error) {
        logMsg("error", `That is not a hotkey map: ${String(error)}`);
      }
    });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0, height: "100%" }} data-pref-row="keyboard-shortcuts">
      <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "10px 12px", borderBottom: "1px solid var(--line-1)" }}>
        <input
          aria-label="Filter keyboard shortcuts" data-testid="hotkey-search"
          data-hint="Filters commands by name, group, description, or current shortcut"
          placeholder="Filter shortcuts..."
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          style={{ flex: 1, background: "var(--bg-app)", border: "1px solid var(--line-4)", color: "var(--text-body)", fontSize: 13.5, padding: "5px 7px", outline: "none" }}
        />
        <button className="chip" data-testid="hotkey-export" data-hint="Saves this shortcut map to a JSON file" style={{ fontSize: 11, padding: "2px 8px" }} onClick={doExport}>
          EXPORT
        </button>
        <label className="chip" data-hint="Loads a shortcut map from a JSON file" style={{ fontSize: 11, padding: "2px 8px", cursor: "pointer" }}>
          IMPORT
          <input
            type="file"
            accept="application/json,.json"
            aria-label="Import keyboard shortcuts" data-testid="hotkey-import"
            data-hint="Loads a shortcut map from the selected JSON file"
            style={{ display: "none" }}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) doImport(file);
              event.target.value = "";
            }}
          />
        </label>
        <span data-hint="Restores every default shortcut; available after a shortcut is customized"><button
          className="chip"
          data-testid="hotkey-reset-all"
          data-hint="Restores every default shortcut"
          disabled={Object.keys(overrides).length === 0}
          style={{ fontSize: 11, padding: "2px 8px" }}
          onClick={() => setHotkeys({})}
        >
          RESET ALL
        </button></span>
      </div>
      {clashes.size > 0 && (
        <div data-testid="hotkey-conflicts" style={{ fontSize: 13.5, color: "var(--reject)", padding: "6px 12px", lineHeight: 1.5 }}>
          {clashes.size} key{clashes.size === 1 ? "" : "s"} bound to more than one command that can fire at the same time: {[...clashes.keys()].join(", ")}
        </div>
      )}
      <div style={{ flex: 1, overflowY: "auto", padding: "4px 0 10px" }} data-testid="hotkey-list">
        {grouped.length === 0 && <div style={{ fontSize: 13.5, color: "var(--text-ghost)", padding: "10px 12px" }}>Nothing matches "{query}". Try a command, group, or key.</div>}
        {grouped.map((group) => (
          <div key={group.group}>
            <div className="kicker" style={{ fontSize: 10, padding: "9px 12px 3px", position: "sticky", top: 0, background: "var(--bg-panel)" }}>
              {group.group}
            </div>
            {group.items.map((spec) => {
              const binding = bindingFor(spec.id, overrides);
              return (
                <HotkeyRow
                  key={spec.id}
                  spec={spec}
                  binding={binding}
                  clash={clashing.has(spec.id)}
                  capturing={capturing === spec.id}
                  onCapture={() => setCapturing(capturing === spec.id ? null : spec.id)}
                  onClear={() => setHotkeys({ ...overrides, [spec.id]: "" })}
                  onReset={() => {
                    const next = { ...overrides };
                    delete next[spec.id];
                    setHotkeys(next);
                  }}
                />
              );
            })}
          </div>
        ))}
      </div>
      <div style={{ fontSize: 11, color: "var(--text-ghost)", borderTop: "1px solid var(--line-1)", padding: "6px 12px" }}>
        {COMMANDS.length} commands · click a key to rebind, esc to cancel
      </div>
    </div>
  );
}

function SettingsCategory({
  category,
  state,
  dispatch,
  landing,
}: {
  category: Exclude<Category, "hotkeys">;
  state: State;
  dispatch: D;
  landing: SettingId | null;
}) {
  const setPref = (prefs: Partial<State["prefs"]>) => dispatch({ type: "set_prefs", prefs });
  const recents = clampRecents(state.prefs.paletteRecents);
  const customBands = Math.min(8, Math.max(1, state.prefs.consoleCustomMax));
  const [ribbonMin, ribbonMax] = ribbonBounds(state.prefs);
  const previewEdge = clampPreviewEdge(state.prefs.previewEdge);
  const gestureEdge = clampGesturePreviewEdge(state.prefs.gesturePreviewEdge, previewEdge);
  // The update-backup policy lives outside the catalog (26.3), so it is
  // not one of state.prefs: read from its own file on mount, written
  // back on each flip. null while the read is in flight.
  const [upgradeBackup, setUpgradeBackup] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    void catalogUpgradeAlwaysBackup().then((on) => { if (!cancelled) setUpgradeBackup(on); });
    return () => { cancelled = true; };
  }, []);
  const flipUpgradeBackup = () => {
    const next = !(upgradeBackup === true);
    setUpgradeBackup(next);
    void setCatalogUpgradeAlwaysBackup(next);
  };

  return (
    <div style={{ height: "100%", overflowY: "auto", padding: "16px 20px 28px" }} data-testid={`prefs-panel-${category}`}>
      <CategoryHeading category={category} />
      {category === "general" && (
        <>
          <SettingBlock
            id="delete-heals"
            landing={landing}
            control={
              <div
                className="toggle"
                data-on={state.deleteHeals}
                role="switch"
                aria-checked={state.deleteHeals}
                data-testid="prefs-delete-heals"
                data-hint={state.deleteHeals ? "Keeps graph neighbors connected after deletion" : "Leaves graph neighbors disconnected after deletion"}
                onClick={() => dispatch({ type: "set_ui_setting", key: "deleteHeals", value: !state.deleteHeals })}
              >
                <div className="dot" />
              </div>
            }
          />
          <SettingBlock
            id="confirm-delete-take"
            landing={landing}
            control={
              <div
                className="toggle"
                data-on={state.prefs.confirmDeleteTake}
                role="switch"
                aria-checked={state.prefs.confirmDeleteTake}
                data-testid="prefs-confirm-delete-take"
                data-hint={state.prefs.confirmDeleteTake ? "Deleting a take asks first" : "Deleting a take happens immediately, no dialog"}
                onClick={() =>
                  dispatch({ type: "set_prefs", prefs: { confirmDeleteTake: !state.prefs.confirmDeleteTake } })
                }
              >
                <div className="dot" />
              </div>
            }
          />
          <SettingBlock
            id="autosave-delay"
            landing={landing}
            control={
              <NumericSetting
                id="autosave-delay"
                landing={landing}
                label="Delay"
                testid="prefs-autosave-delay"
                value={clampAutosaveDelay(state.prefs.autosaveDelayMs)}
                lo={100}
                hi={3000}
                suffix=" ms"
                onChange={(value) => setPref({ autosaveDelayMs: clampAutosaveDelay(value) })}
              />
            }
          />
          <SettingBlock
            id="check-updates"
            landing={landing}
            control={
              <div
                className="toggle"
                data-on={state.prefs.checkUpdatesOnLaunch}
                role="switch"
                aria-checked={state.prefs.checkUpdatesOnLaunch}
                data-testid="prefs-check-updates"
                data-hint={state.prefs.checkUpdatesOnLaunch ? "Stops asking the release list at launch; Help > Check for Updates still works" : "Asks the release list at launch and says when a newer Heeler exists"}
                onClick={() => setPref({ checkUpdatesOnLaunch: !state.prefs.checkUpdatesOnLaunch })}
              >
                <div className="dot" />
              </div>
            }
          />
          {/* Development builds only. A shipped build cannot promise
              the previews behind this toggle (tethering answers one
              Panasonic body and no other has been tried), so it does
              not offer the toggle either: no grayed row, no tooltip
              about a build the user does not have. */}
          {previewBuild() && (
            <SettingBlock
              id="experimental-features"
              landing={landing}
              control={
                <div
                  className="toggle"
                  data-on={state.prefs.experimentalFeatures}
                  role="switch"
                  aria-checked={state.prefs.experimentalFeatures}
                  data-testid="prefs-experimental"
                  data-hint={state.prefs.experimentalFeatures ? "Hides in-development previews like the Tether tab" : "Shows in-development previews like the Tether tab"}
                  onClick={() => {
                    const next = !state.prefs.experimentalFeatures;
                    setPref({ experimentalFeatures: next });
                    if (!next) {
                      // A running tether session and any connected camera
                      // are the hidden tab's live halves: stopping them
                      // here keeps the backend from holding a folder or a
                      // USB interface the user can no longer see.
                      void tetherStop().catch(() => undefined);
                      void usbCameraDisconnect().catch(() => undefined);
                      logMsg("info", "Experimental features off: tether session stopped, camera disconnected");
                    }
                  }}
                >
                  <div className="dot" />
                </div>
              }
            />
          )}
        </>
      )}
      {category === "interface" && (
        <>
          <SettingBlock id="app-zoom" landing={landing} control={<AppZoomControl />} />
          <SettingBlock
            id="expand-on-enable"
            landing={landing}
            control={
              <div
                className="toggle"
                data-on={state.prefs.expandSectionOnEnable}
                role="switch"
                aria-checked={state.prefs.expandSectionOnEnable}
                data-testid="prefs-expand-on-enable"
                data-hint={state.prefs.expandSectionOnEnable ? "A section unfolds when its switch turns on" : "A section stays folded when its switch turns on"}
                onClick={() =>
                  dispatch({ type: "set_prefs", prefs: { expandSectionOnEnable: !state.prefs.expandSectionOnEnable } })
                }
              >
                <div className="dot" />
              </div>
            }
          />
          <SettingBlock
            id="palette-recents"
            landing={landing}
            control={
              <NumericSetting
                id="palette-recents"
                landing={landing}
                label="Nodes"
                testid="prefs-palette-recents"
                value={recents}
                lo={RECENTS_MIN}
                hi={RECENTS_MAX}
                onChange={(value) => setPref({ paletteRecents: clampRecents(value) })}
              />
            }
          />
          <SettingBlock
            id="console-customs"
            landing={landing}
            control={
              <NumericSetting
                id="console-customs"
                landing={landing}
                label="Bands"
                testid="prefs-console-customs"
                value={customBands}
                lo={1}
                hi={8}
                onChange={(value) => setPref({ consoleCustomMax: Math.min(8, Math.max(1, value)) })}
              />
            }
          />
          <SettingBlock
            id="curve-mode"
            landing={landing}
            control={
              <div className="zoom-seg" role="group" aria-label="Curves channels" style={{ border: "1px solid var(--line-4)", width: "fit-content" }}>
                {(
                  [
                    ["rgb", "RGB", "Curves opens on the RGB channels"],
                    ["cmy", "CMY", "Curves opens on the same curves seen as ink: C, M and Y"],
                  ] as const
                ).map(([id, label, hint]) => (
                  <button
                    key={id}
                    data-active={(state.prefs.curveMode ?? "rgb") === id}
                    aria-pressed={(state.prefs.curveMode ?? "rgb") === id}
                    data-testid={`prefs-curve-mode-${id}`}
                    data-hint={hint}
                    style={{ fontSize: 11, padding: "1px 9px" }}
                    onClick={() => setPref({ curveMode: id })}
                  >
                    {label}
                  </button>
                ))}
              </div>
            }
          />
          <SettingBlock
            id="shape-line-width"
            landing={landing}
            control={
              <NumericSetting
                id="shape-line-width"
                landing={landing}
                label="Thickness"
                testid="prefs-shape-line-width"
                value={state.prefs.shapeLineWidth}
                lo={SHAPE_LINE_WIDTH_RANGE[0]}
                hi={SHAPE_LINE_WIDTH_RANGE[1]}
                suffix=" px"
                step={1}
                onChange={(value) => setPref({ shapeLineWidth: clampShapeLineWidth(value) })}
              />
            }
          />
          <SettingBlock
            id="viewer-zoom-speed"
            landing={landing}
            control={
              <NumericSetting
                id="viewer-zoom-speed"
                landing={landing}
                label="Sensitivity"
                testid="prefs-viewer-zoom-speed"
                value={Math.round((clampViewerZoomRate(state.prefs.viewerZoomRate) / DEFAULT_PREFS.viewerZoomRate) * 100)}
                lo={33}
                hi={267}
                suffix="%"
                onChange={(value) => setPref({ viewerZoomRate: clampViewerZoomRate(DEFAULT_PREFS.viewerZoomRate * value / 100) })}
              />
            }
          />
          <SettingBlock
            id="viewer-rotation-step"
            landing={landing}
            control={
              <NumericSetting
                id="viewer-rotation-step"
                landing={landing}
                label="Degrees"
                testid="prefs-viewer-rotation-step"
                value={clampViewerRotationStep(state.prefs.viewerRotationStep)}
                lo={1}
                hi={15}
                suffix="°"
                onChange={(value) => setPref({ viewerRotationStep: clampViewerRotationStep(value) })}
              />
            }
          />
          <SettingBlock
            id="wheel-zoom-direction"
            landing={landing}
            control={
              <div
                className="toggle"
                data-on={state.prefs.wheelZoomInverted ?? false}
                role="switch"
                aria-checked={state.prefs.wheelZoomInverted ?? false}
                data-testid="prefs-wheel-zoom-invert"
                data-hint={state.prefs.wheelZoomInverted ? "Scrolling up zooms out" : "Scrolling up zooms in"}
                onClick={() => setPref({ wheelZoomInverted: !(state.prefs.wheelZoomInverted ?? false) })}
              >
                <div className="dot" />
              </div>
            }
          />
          <SettingBlock
            id="gpu-previews"
            landing={landing}
            control={
              <div
                className="toggle"
                data-on={state.prefs.gpuPreviews ?? true}
                role="switch"
                aria-checked={state.prefs.gpuPreviews ?? true}
                data-testid="prefs-gpu-previews"
                data-hint={state.prefs.gpuPreviews ?? true ? "Previews render on the graphics card" : "Previews render on the CPU"}
                onClick={() => setPref({ gpuPreviews: !(state.prefs.gpuPreviews ?? true) })}
              >
                <div className="dot" />
              </div>
            }
          />
          <SettingBlock
            id="preview-settle"
            landing={landing}
            control={
              <div className="zoom-seg" role="group" aria-label="Settled preview" style={{ border: "1px solid var(--line-4)", width: "fit-content" }}>
                {(
                  [
                    ["screen", "Screen", "The reduced tier at the settled edge: quick, and what the preview has always shown"],
                    ["full", "Full", "The whole photograph at its own pixels once your hand is off: the picture the export makes, seconds per edit on a large photograph"],
                  ] as const
                ).map(([id, label, hint]) => (
                  <button
                    key={id}
                    data-active={(state.prefs.settledPreview ?? "screen") === id}
                    aria-pressed={(state.prefs.settledPreview ?? "screen") === id}
                    data-testid={`prefs-settled-preview-${id}`}
                    data-hint={hint}
                    style={{ fontSize: 11, padding: "1px 9px" }}
                    onClick={() => setPref({ settledPreview: id })}
                  >
                    {label}
                  </button>
                ))}
              </div>
            }
          />
          <SettingBlock
            id="preview-settle-quality"
            landing={landing}
            control={
              <div className="zoom-seg" role="group" aria-label="Settled frame quality" style={{ border: "1px solid var(--line-4)", width: "fit-content" }}>
                {(
                  [
                    ["smaller", "Smaller", "JPEG quality 75: the lightest frame, for a slow machine or a small display"],
                    ["balanced", "Balanced", "JPEG quality 85: 42% fewer bytes than Sharper for a difference that does not read at Fit"],
                    ["sharper", "Sharper", "JPEG quality 94, the reduced frames' own: for a large display where the settle shows near its own pixels"],
                  ] as const
                ).map(([id, label, hint]) => (
                  <button
                    key={id}
                    data-active={(state.prefs.settleQuality ?? "balanced") === id}
                    aria-pressed={(state.prefs.settleQuality ?? "balanced") === id}
                    data-testid={`prefs-settle-quality-${id}`}
                    data-hint={hint}
                    style={{ fontSize: 11, padding: "1px 9px" }}
                    onClick={() => setPref({ settleQuality: id })}
                  >
                    {label}
                  </button>
                ))}
              </div>
            }
          />
          <SettingBlock
            id="preview-quality"
            landing={landing}
            control={
              <div className="pstack">
                <NumericSetting
                  id="preview-quality"
                  landing={landing}
                  label="Settled edge, at least"
                  testid="prefs-preview-edge"
                  value={previewEdge}
                  lo={1024}
                  hi={4096}
                  suffix=" px"
                  onChange={(value) => {
                    const next = clampPreviewEdge(value);
                    setPref({
                      previewEdge: next,
                      gesturePreviewEdge: clampGesturePreviewEdge(gestureEdge, next),
                    });
                  }}
                />
                <NumericSetting
                  id="preview-quality"
                  landing={landing}
                  label="Live edge"
                  testid="prefs-gesture-preview-edge"
                  value={gestureEdge}
                  lo={512}
                  hi={Math.min(2048, previewEdge)}
                  suffix=" px"
                  onChange={(value) => setPref({ gesturePreviewEdge: clampGesturePreviewEdge(value, previewEdge) })}
                />
              </div>
            }
          />
          <SettingBlock
            id="ribbon-sizing"
            landing={landing}
            control={
              <div className="pstack">
                <NumericSetting
                  id="ribbon-sizing"
                  landing={landing}
                  label="Minimum"
                  testid="prefs-ribbon-min"
                  value={ribbonMin}
                  lo={100}
                  hi={Math.min(260, ribbonMax)}
                  suffix=" px"
                  onChange={(value) => setPref({ ribbonMinWidth: Math.min(value, ribbonMax) })}
                />
                <NumericSetting
                  id="ribbon-sizing"
                  landing={landing}
                  label="Maximum"
                  testid="prefs-ribbon-max"
                  value={ribbonMax}
                  lo={ribbonMin}
                  hi={640}
                  suffix=" px"
                  onChange={(value) => setPref({ ribbonMaxWidth: Math.max(value, ribbonMin) })}
                />
              </div>
            }
          />
          <SettingBlock
            id="thumbnail-quality"
            landing={landing}
            control={
              <NumericSetting
                id="thumbnail-quality"
                landing={landing}
                label="Longest edge"
                testid="prefs-thumbnail-edge"
                value={clampThumbnailEdge(state.prefs.thumbnailEdge)}
                lo={240}
                hi={1200}
                suffix=" px"
                onChange={(value) => setPref({ thumbnailEdge: clampThumbnailEdge(value) })}
              />
            }
          />
        </>
      )}
      {category === "brush" && (
        <>
          <SettingBlock
            id="grain-steps"
            landing={landing}
            control={
              <div className="pstack">
                <NumericSetting
                  id="grain-steps"
                  landing={landing}
                  label={`${modLabel("alt")} + [ and ]`}
                  testid="prefs-grain-step"
                  value={clampGrainStep(state.prefs.brushGrainStep ?? DEFAULT_PREFS.brushGrainStep)}
                  lo={1}
                  hi={90}
                  suffix="°"
                  onChange={(value) => setPref({ brushGrainStep: clampGrainStep(value) })}
                />
                <NumericSetting
                  id="grain-steps"
                  landing={landing}
                  label={`${modLabel("shift")} + ${modLabel("alt")} + [ and ]`}
                  testid="prefs-grain-fine-step"
                  value={clampGrainStep(state.prefs.brushGrainFineStep ?? DEFAULT_PREFS.brushGrainFineStep)}
                  lo={1}
                  hi={90}
                  suffix="°"
                  onChange={(value) => setPref({ brushGrainFineStep: clampGrainStep(value) })}
                />
              </div>
            }
          />
          <SettingBlock
            id="mask-overlay-color"
            landing={landing}
            control={
              /* A dropdown whose field and rows keep each color's dot beside its
name (2026-09-30: "make the 4 color options a dropdown option menu
but keep the color dots with labels").*/
              <MenuField
                testid="prefs-mask-color"
                label="Mask overlay color"
                size="regular"
                fitLabels={MASK_OVERLAY_COLORS.map((c) => c.label)}
                value={state.prefs.maskOverlayColor ?? "red"}
                options={MASK_OVERLAY_COLORS.map((c) => ({
                  id: c.id,
                  label: c.label,
                  swatch: `rgb(${c.rgb})`,
                  hint: `Uses ${c.label.toLowerCase()} for mask overlays and brush washes`,
                }))}
                onChange={(id) => setPref({ maskOverlayColor: id as State["prefs"]["maskOverlayColor"] })}
              />
            }
          />
          <SettingBlock
            id="mask-overlay-opacity"
            landing={landing}
            control={
              <NumericSetting
                id="mask-overlay-opacity"
                landing={landing}
                label="Where white"
                testid="prefs-mask-overlay-opacity"
                value={clampMaskOverlayOpacity(state.prefs.maskOverlayOpacity)}
                lo={0}
                hi={100}
                step={1}
                suffix="%"
                onChange={(value) => setPref({ maskOverlayOpacity: clampMaskOverlayOpacity(value) })}
              />
            }
          />
        </>
      )}
      {category === "import" && (
        <>
          <SettingBlock
            id="raw-profile"
            landing={landing}
            control={
              /* The Source section's own dropdowns, sized together to the longest
choice in the two (2026-09-29: "update Preferences > File & Import to
also be a dropdown option menu as well").*/
              <MenuField
                testid="prefs-raw-profile"
                label="RAW default profile"
                size="regular"
                fitLabels={RAW_DEFAULTS_FIT}
                value={state.rawProfile}
                options={PROFILE_CHOICES.map((o) => ({
                  ...o,
                  hint: `Starts newly imported RAW files with the ${o.label.toLowerCase()} profile`,
                }))}
                onChange={(value) => dispatch({ type: "set_ui_setting", key: "rawProfile", value })}
              />
            }
          />
          <SettingBlock
            id="raw-sharpening"
            landing={landing}
            control={
              <MenuField
                testid="prefs-raw-sharpening"
                label="RAW default sharpening"
                size="regular"
                fitLabels={RAW_DEFAULTS_FIT}
                value={state.rawSharpening}
                options={SHARPENING_CHOICES.filter((o) => (RAW_SHARPENING as readonly string[]).includes(o.id)).map((o) => ({
                  ...o,
                  hint:
                    o.id === "off"
                      ? "Starts newly imported RAW files with no capture sharpening"
                      : `Starts newly imported RAW files with ${o.label.toLowerCase()} capture sharpening`,
                }))}
                onChange={(value) => dispatch({ type: "set_ui_setting", key: "rawSharpening", value })}
              />
            }
          />
          {/* Tethering's defaults open and close with the Tether tab
(2026-09-29: "Tether is hidden right now, so should this").*/}
          {tetherShown(state.prefs) && (
          <SettingBlock
            id="tether-defaults"
            landing={landing}
            control={
              <div className="pstack">
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <button
                    className="chip"
                    data-testid="prefs-tether-destination"
                    data-hint="Chooses where new tether sessions move arriving files"
                    style={{ fontSize: 11, padding: "2px 9px", flex: "none" }}
                    onClick={() => void pickExportFolder().then((folder) => folder && setPref({ tetherDestination: folder }))}
                  >
                    DESTINATION
                  </button>
                  <span className="tnum" data-testid="prefs-tether-destination-path" style={{ fontSize: 11, color: "var(--text-faint)", minWidth: 0, wordBreak: "break-all" }}>
                    {state.prefs.tetherDestination || "leave files in the hot folder"}
                  </span>
                  {state.prefs.tetherDestination && (
                    <button className="chip" data-testid="prefs-tether-destination-clear" data-hint="Leaves tethered files in the hot folder" style={{ fontSize: 11, padding: "1px 6px" }} onClick={() => setPref({ tetherDestination: "" })}>
                      ✕
                    </button>
                  )}
                </div>
                <input
                  data-testid="prefs-tether-pattern"
                  data-hint="Sets the naming pattern for new tether sessions"
                  aria-label="Tether naming pattern"
                  value={state.prefs.tetherNamingPattern ?? ""}
                  placeholder="{date}-{seq}-{name}"
                  spellCheck={false}
                  onChange={(event) => setPref({ tetherNamingPattern: event.target.value })}
                  style={{ background: "var(--bg-app)", border: "1px solid var(--line-4)", color: "var(--text-body)", fontSize: 13.5, padding: "5px 7px", outline: "none" }}
                />
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ fontSize: 13.5, color: "var(--text-faint)" }}>Auto-advance</span>
                  <div
                    className="toggle"
                    data-on={state.prefs.tetherAutoAdvance ?? true}
                    role="switch" aria-label="Show new tethered arrivals" tabIndex={0} onKeyDown={e=>{if(e.key === " " || e.key === "Enter"){e.preventDefault();e.currentTarget.click();}}}
                    aria-checked={state.prefs.tetherAutoAdvance ?? true}
                    data-testid="prefs-tether-auto-advance"
                    data-hint="Makes each tethered arrival the active photograph"
                    onClick={() => setPref({ tetherAutoAdvance: !(state.prefs.tetherAutoAdvance ?? true) })}
                  >
                    <div className="dot" />
                  </div>
                </div>
                <NumericSetting
                  id="tether-defaults"
                  landing={landing}
                  label="Poll interval"
                  testid="prefs-tether-poll"
                  value={clampTetherPoll(state.prefs.tetherPollMs)}
                  lo={500}
                  hi={10000}
                  suffix=" ms"
                  onChange={(value) => setPref({ tetherPollMs: clampTetherPoll(value) })}
                />
              </div>
            }
          />
          )}
        </>
      )}
      {category === "export" && (
        <>
          <SettingBlock
            id="export-defaults"
            landing={landing}
            control={
              <div className="pstack">
                {/* Eight formats of unequal width wrapped onto two lines: the sloppiness
the owner named in the Source section (2026-09-29), so the same
dropdown.*/}
                <MenuField
                  testid="prefs-export-format"
                  label="Default export format"
                  size="regular"
                  fitLabels={EXPORT_FORMATS.map((f) => f.toUpperCase())}
                  value={state.prefs.exportDefaultFormat ?? "jpeg"}
                  options={EXPORT_FORMATS.map((f) => ({
                    id: f,
                    label: f.toUpperCase(),
                    hint: `Starts new export batches in ${f.toUpperCase()} format`,
                  }))}
                  onChange={(format) => setPref({ exportDefaultFormat: format as (typeof EXPORT_FORMATS)[number] })}
                />
                <input
                  data-testid="prefs-export-template"
                  data-hint="Sets the filename template inherited by new export batches"
                  aria-label="Default export filename template"
                  value={state.prefs.exportTemplate ?? DEFAULT_PREFS.exportTemplate}
                  onChange={(event) => setPref({ exportTemplate: event.target.value })}
                  spellCheck={false}
                  style={{ background: "var(--bg-app)", border: "1px solid var(--line-4)", color: "var(--text-body)", fontSize: 13.5, padding: "5px 7px", outline: "none" }}
                />
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ fontSize: 13.5, color: "var(--text-faint)" }}>Keep metadata</span>
                  <div
                    className="toggle"
                    data-on={state.prefs.exportKeepMetadata ?? true}
                    role="switch"
                    aria-checked={state.prefs.exportKeepMetadata ?? true}
                    aria-label="Keep export metadata" tabIndex={0} onKeyDown={e=>{if(e.key === " " || e.key === "Enter"){e.preventDefault();e.currentTarget.click();}}}
                    data-testid="prefs-export-metadata"
                    data-hint="Keeps camera metadata in Quick Export and new export batches"
                    onClick={() => setPref({ exportKeepMetadata: !(state.prefs.exportKeepMetadata ?? true) })}
                  >
                    <div className="dot" />
                  </div>
                </div>
              </div>
            }
          />
          <SettingBlock
            id="export-overwrite"
            landing={landing}
            control={
              /* The switch alone in its cell, as every other switch row is; what it
does and the half of the rule that is not a preference are one
description below (2026-09-30: "the checkbox and help text are pushed
up against each other").*/
              <div
                className="toggle"
                data-on={state.prefs.exportNeverOverwrite ?? true}
                role="switch"
                aria-checked={state.prefs.exportNeverOverwrite ?? true}
                data-testid="prefs-export-overwrite"
                data-hint="Writes to the next free name instead of over a file that is already there"
                onClick={() =>
                  setPref({ exportNeverOverwrite: !(state.prefs.exportNeverOverwrite ?? true) })
                }
              >
                <div className="dot" />
              </div>
            }
          />
          <SettingBlock
            id="quick-export"
            landing={landing}
            control={
              <div style={{ fontSize: 13.5, color: "var(--text-faint)", lineHeight: 1.5 }}>
                Right-click the title-bar Export button to set shared quality and output size. New batches inherit those values.
              </div>
            }
          />
        </>
      )}
      {category === "scripting" && (
        <>
          <SettingBlock
            id="python-api"
            landing={landing}
            control={
              <div
                className="toggle"
                data-on={state.apiEnabled}
                role="switch"
                aria-checked={state.apiEnabled}
                data-testid="prefs-api-toggle"
                data-hint={state.apiEnabled ? "Allows local token-protected Python control" : "Prevents external Python control"}
                onClick={() => dispatch({ type: "set_ui_setting", key: "apiEnabled", value: !state.apiEnabled })}
              >
                <div className="dot" />
              </div>
            }
          />
          <SettingBlock
            id="share-link"
            landing={landing}
            control={
              /* 2026-09-30: "the two options for 'With token' and 'Just IP and port'
should be a dropdown option menu".*/
              <MenuField
                testid="prefs-serve-link"
                label="Media server share link"
                size="regular"
                fitLabels={SHARE_LINK_CHOICES.map((c) => c.label)}
                value={state.prefs.serveSimpleLink ? "simple" : "token"}
                options={SHARE_LINK_CHOICES}
                onChange={(id) => setPref({ serveSimpleLink: id === "simple" })}
              />
            }
          />
        </>
      )}
      {category === "assistant" && (
        <AssistantSettings
          state={state}
          dispatch={dispatch}
          block={(id, control) => <SettingBlock key={id} id={id} landing={landing} control={control} />}
        />
      )}
      {category === "models" && (
        <>
          <SettingBlock
            id="depth-edges"
            landing={landing}
            control={
              <NumericSetting
                id="depth-edges"
                landing={landing}
                label="Edges"
                testid="prefs-depth-edges"
                value={clampDepthSetting(state.prefs.depthEdges, DEFAULT_PREFS.depthEdges)}
                lo={0}
                hi={100}
                onChange={(value) => setPref({ depthEdges: clampDepthSetting(value, DEFAULT_PREFS.depthEdges) })}
              />
            }
          />
          <SettingBlock
            id="depth-flatten"
            landing={landing}
            control={
              <NumericSetting
                id="depth-flatten"
                landing={landing}
                label="Flatten"
                testid="prefs-depth-flatten"
                value={clampDepthSetting(state.prefs.depthFlatten, DEFAULT_PREFS.depthFlatten)}
                lo={0}
                hi={100}
                onChange={(value) => setPref({ depthFlatten: clampDepthSetting(value, DEFAULT_PREFS.depthFlatten) })}
              />
            }
          />
          <SettingBlock
            id="depth-size"
            landing={landing}
            control={
              /* 2026-09-30: "the 3 options for 518, 700, and 1036 should
be a dropdown option menu".*/
              <MenuField
                testid="prefs-depth-size"
                label="Depth map detail"
                size="regular"
                fitLabels={DEPTH_SIZES.map(String)}
                value={String(snapDepthSize(state.prefs.depthSize))}
                options={DEPTH_SIZES.map((size) => ({
                  id: String(size),
                  label: String(size),
                  hint:
                    size === 518
                      ? "New photographs read the scene at the model's own 518 px: fastest"
                      : size === 700
                        ? "New photographs read the scene at 700 px: finer edges, about twice the time"
                        : "New photographs read the scene at 1036 px: the finest edges, about four times the time and memory",
                }))}
                onChange={(id) => setPref({ depthSize: snapDepthSize(Number(id)) })}
              />
            }
          />
          <SettingBlock id="model-inventory" landing={landing} wide control={<ModelsControl state={state} dispatch={dispatch} />} />
        </>
      )}
      {category === "adjust-sections" && <SettingBlock id="adjust-sections" landing={landing} wide control={<SectionsControl state={state} dispatch={dispatch} />} />}
      {category === "storage" && <SettingBlock id="storage-caches" landing={landing} wide control={<StorageControl />} />}
      {category === "backup" && (
        <>
        <SettingBlock
          id="catalog-backup"
          landing={landing}
          control={
            <div className="pstack">
              {/* Five choices from "Daily" to "Every two weeks" made a row of very
unequal buttons, the look the owner called sloppy in the Source section
(2026-09-29); the same dropdown.*/}
              <MenuField
                testid="prefs-backup"
                label="Backup cadence"
                size="regular"
                fitLabels={BACKUP_CADENCES.map((c) => c.label)}
                value={String(state.prefs.backupEveryDays)}
                options={BACKUP_CADENCES.map((c) => ({ id: String(c.days), label: c.label, hint: c.hint }))}
                onChange={(days) => setPref({ backupEveryDays: Number(days) })}
              />
              <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                <button
                  className="chip"
                  data-testid="prefs-backup-folder"
                  data-hint="Chooses the folder that receives catalog backups"
                  style={{ fontSize: 11, padding: "2px 9px", flex: "none" }}
                  onClick={() => void pickExportFolder().then((folder) => folder && setPref({ backupFolder: folder }))}
                >
                  CHOOSE FOLDER
                </button>
                <span className="tnum" data-testid="prefs-backup-path" style={{ fontSize: 11, color: "var(--text-faint)", minWidth: 0, wordBreak: "break-all" }}>
                  {state.prefs.backupFolder || "no folder chosen"}
                </span>
              </div>
            </div>
          }
        />
        <SettingBlock
          id="baked-backups"
          landing={landing}
          control={
            <div
              className="toggle"
              data-on={state.prefs.keepBakedInBackups}
              role="switch"
              aria-checked={state.prefs.keepBakedInBackups}
              data-testid="prefs-baked-backups"
              data-hint={BAKED_BACKUP_HINTS[state.prefs.keepBakedInBackups ? "on" : "off"]}
              onClick={() => setPref({ keepBakedInBackups: !state.prefs.keepBakedInBackups })}
            >
              <div className="dot" />
            </div>
          }
        />
        <SettingBlock
          id="catalog-upgrade-backup"
          landing={landing}
          control={
            <div
              className="toggle"
              data-on={upgradeBackup === true}
              role="switch"
              aria-checked={upgradeBackup === true}
              data-testid="prefs-upgrade-backup"
              data-hint={upgradeBackup === true ? "An older catalog is copied beside itself before a newer Heeler updates it, without asking" : "The update prompt asks each time whether to copy the catalog first"}
              onClick={flipUpgradeBackup}
            >
              <div className="dot" />
            </div>
          }
        />
        </>
      )}
    </div>
  );
}

export function Preferences({ state, dispatch }: { state: State; dispatch: D }) {
  const focus = useDialogFocus(state.prefsOpen);
  const [category, setCategory] = useState<Category>("general");
  const [settingsQuery, setSettingsQuery] = useState("");
  const [hotkeyQuery, setHotkeyQuery] = useState("");
  const [capturing, setCapturing] = useState<string | null>(null);
  const [landing, setLanding] = useState<SettingId | null>(null);
  // Something outside asked for a setting (the Adjustments panel's
  // hidden-sections chip): open its category and land there, once.
  useEffect(() => {
    if (!state.prefsOpen || !state.prefsLanding) return;
    const item = SETTINGS.find((s) => s.id === state.prefsLanding);
    if (item) {
      setCategory(item.category);
      setSettingsQuery("");
      setLanding(item.id);
    }
    dispatch({ type: "open_prefs" });
  }, [state.prefsOpen, state.prefsLanding, dispatch]);

  const matches = useMemo(() => {
    const query = settingsQuery.trim().toLocaleLowerCase();
    if (!query) return [];
    // A shipped build has no experimental row to land on, so the
    // search must not offer one: a result that scrolls to nothing is
    // worse than no result.
    // Nor the tether defaults while the Tether tab is hidden: the row
    // is not drawn, so the search holds the same gate.
    const tether = tetherShown(state.prefs);
    return SETTINGS.filter(
      (item) =>
        (previewBuild() || item.id !== "experimental-features") &&
        (tether || item.id !== "tether-defaults") &&
        `${item.label} ${item.description} ${categoryLabel(item.category)}`.toLocaleLowerCase().includes(query),
    );
  }, [settingsQuery, state.prefs]);

  useEffect(() => {
    if (!landing) return;
    const scrollTimer = window.setTimeout(() => {
      document.querySelector<HTMLElement>(`[data-pref-row="${landing}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
    }, 40);
    const clearTimer = window.setTimeout(() => setLanding(null), 2200);
    return () => {
      window.clearTimeout(scrollTimer);
      window.clearTimeout(clearTimer);
    };
  }, [landing, category]);

  if (!state.prefsOpen) return null;

  const overrides = state.prefs.hotkeys;
  const setHotkeys = (next: Record<string, string>) => dispatch({ type: "set_prefs", prefs: { hotkeys: next } });
  const capture = (event: React.KeyboardEvent) => {
    if (!capturing) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape") {
      setCapturing(null);
      return;
    }
    if (isModifierOnly(event.key)) return;
    setHotkeys({ ...overrides, [capturing]: bindingOf(event) });
    setCapturing(null);
  };
  const pickResult = (item: Setting) => {
    setCategory(item.category);
    setSettingsQuery("");
    setLanding(item.id);
  };
  const visibleCategories = settingsQuery.trim()
    ? CATEGORIES.filter((item) => matches.some((match) => match.category === item.id))
    : CATEGORIES;

  return (
    <div
      data-testid="preferences"
      onKeyDown={capture}
      style={{ position: "fixed", inset: 0, zIndex: 80, background: "rgba(12,11,10,.62)", display: "flex", alignItems: "center", justifyContent: "center" }}
      onMouseDown={() => dispatch({ type: "close_prefs" })}
    >
      <div
        // Zoom belongs on the inner box, never the fixed wrapper: CSS
        // zoom repositions fixed descendants, which is the context-menu
        // bug this placement avoids.
        ref={focus} role="dialog" aria-modal="true" aria-label="Preferences" tabIndex={-1}
        className="ui-zoom"
        onMouseDown={(event) => event.stopPropagation()}
        style={{
          width: "min(1040px, calc(92vw / var(--chrome-zoom)))",
          height: "min(760px, calc(86vh / var(--chrome-zoom)))",
          minWidth: "min(720px, calc(96vw / var(--chrome-zoom)))",
          minHeight: "min(480px, calc(92vh / var(--chrome-zoom)))",
          maxWidth: "calc(96vw / var(--chrome-zoom))",
          maxHeight: "calc(92vh / var(--chrome-zoom))",
          resize: "both",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          background: "var(--bg-panel)",
          border: "1px solid var(--line-4)",
          boxShadow: "0 18px 44px rgba(0,0,0,.55)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "11px 14px 10px", borderBottom: "1px solid var(--line-1)" }}>
          <div className="kicker" style={{ fontSize: 10, letterSpacing: ".16em" }}>Preferences</div>
          <button className="chip" data-testid="prefs-close" data-hint="Closes Preferences" style={{ fontSize: 11, padding: "2px 9px" }} onClick={() => dispatch({ type: "close_prefs" })}>
            CLOSE
          </button>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "238px minmax(0, 1fr)", flex: 1, minHeight: 0 }}>
          <aside style={{ borderRight: "1px solid var(--line-1)", padding: "12px 10px", minHeight: 0, overflowY: "auto" }}>
            <input
              data-initial-focus
              data-testid="prefs-search"
              data-hint="Finds preferences by label, category, or outcome"
              aria-label="Search preferences"
              placeholder="Search preferences..."
              value={settingsQuery}
              onChange={(event) => setSettingsQuery(event.target.value)}
              style={{ boxSizing: "border-box", width: "100%", background: "var(--bg-app)", border: "1px solid var(--line-4)", color: "var(--text-body)", fontSize: 13.5, padding: "6px 8px", outline: "none", marginBottom: 11 }}
            />
            <nav aria-label="Preference categories" style={{ display: "grid", gap: 3 }}>
              {visibleCategories.map((item) => (
                <button
                  key={item.id}
                  className="chip"
                  data-testid={`prefs-tab-${item.id}`}
                  data-active={category === item.id && !settingsQuery.trim()} aria-pressed={!!(category === item.id && !settingsQuery.trim())}
                  data-hint={`Opens ${item.label} preferences`}
                  data-parent={"parent" in item ? item.parent : undefined}
                  onClick={() => {
                    setCategory(item.id);
                    setSettingsQuery("");
                    setLanding(null);
                  }}
                  style={{ textAlign: "left", fontSize: "parent" in item ? 13 : 14, padding: "parent" in item ? "5px 9px 5px 22px" : "7px 9px", color: category === item.id && !settingsQuery.trim() ? "var(--accent)" : "var(--text-body)", borderColor: "transparent" }}
                >
                  {item.label}
                  {settingsQuery.trim() && <span className="tnum" style={{ float: "right", fontSize: 11, color: "var(--text-ghost)" }}>{matches.filter((match) => match.category === item.id).length}</span>}
                </button>
              ))}
            </nav>
            {settingsQuery.trim() && matches.length === 0 && (
              <div data-testid="prefs-search-empty" style={{ fontSize: 13.5, color: "var(--text-ghost)", lineHeight: 1.5, padding: "8px 5px" }}>
                No preferences match. Try a category, feature name, or the result you want.
              </div>
            )}
          </aside>
          <main style={{ minWidth: 0, minHeight: 0, overflow: "hidden" }}>
            {settingsQuery.trim() ? (
              <div data-testid="prefs-search-results" style={{ height: "100%", overflowY: "auto", padding: "16px 20px 28px" }}>
                <div className="kicker" style={{ fontSize: 10, letterSpacing: ".14em", paddingBottom: 10 }}>Search results</div>
                {matches.length === 0 ? (
                  <div style={{ fontSize: 14, color: "var(--text-ghost)", lineHeight: 1.6, maxWidth: 500 }}>
                    Nothing matched "{settingsQuery}". Search covers setting labels, descriptions, and category names.
                  </div>
                ) : (
                  CATEGORIES.map((group) => {
                    const items = matches.filter((item) => item.category === group.id);
                    if (items.length === 0) return null;
                    return (
                      <section key={group.id} style={{ marginBottom: 14 }}>
                        <div className="kicker" style={{ fontSize: 10, padding: "5px 0" }}>{group.label}</div>
                        {items.map((item) => (
                          <button
                            key={item.id}
                            className="chip"
                            data-testid={`prefs-search-result-${item.id}`}
                            data-hint={`Opens ${item.label} and highlights it`}
                            onClick={() => pickResult(item)}
                            style={{ display: "block", width: "100%", textAlign: "left", padding: "8px 10px", marginBottom: 5, borderColor: "var(--line-2)" }}
                          >
                            <span style={{ display: "block", fontSize: 14, color: "var(--text-body)" }}>{item.label}</span>
                            <span style={{ display: "block", fontSize: 13.5, color: "var(--text-ghost)", marginTop: 2 }}>{item.description}</span>
                          </button>
                        ))}
                      </section>
                    );
                  })
                )}
              </div>
            ) : category === "hotkeys" ? (
              <HotkeysPanel
                state={state}
                capturing={capturing}
                setCapturing={setCapturing}
                query={hotkeyQuery}
                setQuery={setHotkeyQuery}
                setHotkeys={setHotkeys}
              />
            ) : (
              <SettingsCategory category={category} state={state} dispatch={dispatch} landing={landing} />
            )}
          </main>
        </div>
      </div>
    </div>
  );
}
