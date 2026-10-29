// preferences.tsx's values and helpers that are not components, kept apart so
// preferences.tsx exports components alone and Vite can refresh it in place as
// it is edited instead of reloading the window.
import { UPDATE_DOWNLOAD_WORDS } from "../updates";

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

export const CATEGORIES = PREFS_CATEGORIES;

export type Category = (typeof CATEGORIES)[number]["id"];

export const SETTINGS = [
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
    id: "navigator-size",
    category: "interface",
    label: "Navigator size",
    description: "Sets how large the canvas's Navigator draws, as a percent of the canvas; it shows while View > Navigator is on and the photograph is zoomed past the canvas.",
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
    id: "depth-model",
    category: "models",
    label: "Default depth model",
    description: "Sets the depth model a new photograph's Depth Map section reads with: V2 Small, small and fast, or DA3 Mono Large, for relief inside a subject at about four times the time. A photograph keeps the model it was born with.",
  },
  {
    id: "depth-size",
    category: "models",
    label: "Depth map detail",
    description: "Sets the working size a photograph's Depth Map section starts with: V2's own 518 px, or 700 or 1036 for finer edges at a slower read; DA3 reads at 504 or 1008.",
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

/** A preference's description by its id, for tests that hold its words
 * to the dialogs and menus that describe the same behavior. */
export function settingDescription(id: string): string | undefined {
  return SETTINGS.find((item) => item.id === id)?.description;
}
