// Every command a key can be bound to, and the machinery for binding.
//
// Shortcuts used to be a pile of if statements reading e.key inline,
// which meant there was no list of them anywhere: not for the user, not
// for the person adding the next one, and not for anything that wanted
// to check two of them had not landed on the same key. This is that
// list, and the key handling reads from it.
//
// A binding is a string like "Ctrl+Shift+Z" or "Shift+Space" or "[".
// Modifiers first in a fixed order so two spellings of the same chord
// cannot both exist, and the key itself as the browser reports it with
// no modifiers applied, so "Shift+," is stored rather than "<".

import { NUDGE_KEYS } from "./keynav";
import { isMac } from "./platform";

export type Scope = "global" | "library" | "develop" | "graph" | "canvas" | "brush";

export interface CommandSpec {
  id: string;
  label: string;
  group: string;
  /** where the command is live. "global" means everywhere. */
  scope: Scope;
  /** what it is bound to out of the box; empty means nothing yet */
  binding: string;
  blurb?: string;
}

/** The whole bindable surface.
 *
 * Commands with an empty binding are deliberate: they are things worth
 * being able to reach from the keyboard that have no obvious default,
 * and leaving them blank is better than inventing a chord nobody
 * expects and that collides with something.
 */
export const COMMANDS: CommandSpec[] = [
  // File
  { id: "file.open", label: "Open Folder…", group: "File", scope: "global", binding: "Ctrl+Shift+O" },
  { id: "file.export", label: "Export Panel", group: "File", scope: "global", binding: "Ctrl+E" },
  { id: "app.preferences", label: "Preferences…", group: "File", scope: "global", binding: "Ctrl+," },
  // Unbound by default and deliberately. They are in the registry so the
  // menu can print a key once someone assigns one, and so the hotkey
  // editor lists them at all; shipping a default for something that
  // deletes files is not a decision to make on the user's behalf.
  { id: "catalog.manage", label: "Catalogs and recovery…", group: "File", scope: "global", binding: "" },

  // Edit
  { id: "edit.undo", label: "Undo", group: "Edit", scope: "global", binding: "Ctrl+Z" },
  { id: "edit.redo", label: "Redo", group: "Edit", scope: "global", binding: "Ctrl+Shift+Z" },
  { id: "edit.reset", label: "Reset All Edits", group: "Edit", scope: "global", binding: "" },
  // Unbound on purpose. Delete is the key a person expects here and the
  // one this must not have: it is already Delete Selected Nodes in the
  // graph, and a global binding that fires while the graph is focused
  // would trash a photograph the user was not even looking at. Assign
  // one in Preferences if you want it; the menus reach it either way.
  { id: "image.trash", label: "Move to Trash…", group: "Edit", scope: "global", binding: "" },
  { id: "edit.delete", label: "Delete Selected Nodes", group: "Edit", scope: "graph", binding: "Delete" },
  { id: "edit.deleteKeep", label: "Delete Nodes (invert reconnect)", group: "Edit", scope: "graph", binding: "Shift+Delete" },
  { id: "graph.group", label: "Group Selection", group: "Edit", scope: "graph", binding: "Ctrl+G" },
  { id: "edit.duplicate", label: "Duplicate Selected Nodes", group: "Edit", scope: "graph", binding: "Ctrl+D" },

  // Layers. Brush, not Paint: the mask type underneath has always been
  // called brush and the panel's own button says so, and one thing with
  // two names in the same product is a bug in waiting.
  { id: "layer.range", label: "New Range Layer", group: "Layer", scope: "develop", binding: "Ctrl+Shift+R" },
  { id: "layer.radial", label: "New Radial Layer", group: "Layer", scope: "develop", binding: "Ctrl+Shift+A" },
  { id: "layer.linear", label: "New Linear Layer", group: "Layer", scope: "develop", binding: "Ctrl+Shift+L" },
  { id: "layer.brush", label: "New Brush Layer", group: "Layer", scope: "develop", binding: "Ctrl+Shift+B" },
  // Unbound: Ctrl+Shift+S is Save in most things and taking it here
  // would be surprising. It is in the registry so it can be given one.
  { id: "layer.selection", label: "New Selection Layer", group: "Layer", scope: "develop", binding: "" },
  // Unbound for the same reason, and registered so the menu entry can
  // show a shortcut the moment one is assigned.
  { id: "layer.smart", label: "New Smart Layer", group: "Layer", scope: "develop", binding: "" },

  // Workspace
  { id: "view.mode.next", label: "Next Workspace", group: "Workspace", scope: "global", binding: "Ctrl+Tab" },
  { id: "view.mode.prev", label: "Previous Workspace", group: "Workspace", scope: "global", binding: "Ctrl+Shift+Tab" },
  { id: "view.mode.toggle", label: "Toggle Develop / Graph", group: "Workspace", scope: "global", binding: "N" },
  { id: "view.mode.develop", label: "Develop Mode", group: "Workspace", scope: "global", binding: "" },
  { id: "view.mode.graph", label: "Graph Mode", group: "Workspace", scope: "global", binding: "" },
  { id: "view.mode.canvas", label: "Canvas Mode", group: "Workspace", scope: "global", binding: "" },
  { id: "view.browser", label: "Show / Hide Library", group: "Workspace", scope: "global", binding: "Shift+L" },
  { id: "view.ribbon", label: "Show / Hide Filmstrip", group: "Workspace", scope: "global", binding: "Shift+T" },
  // The right panel stays open; these move between its tabs.
  { id: "panel.adjustments", label: "Adjustments Tab", group: "Workspace", scope: "global", binding: "Shift+Alt+A" },
  { id: "panel.history", label: "History Tab", group: "Workspace", scope: "global", binding: "Shift+Alt+H" },
  { id: "panel.presets", label: "Presets Tab", group: "Workspace", scope: "global", binding: "Shift+Alt+P" },
  { id: "view.console", label: "Show / Hide Console", group: "Workspace", scope: "global", binding: "Ctrl+`" },
  // The Window menu's own commands, unbound until someone binds them.
  { id: "window.graph", label: "Graph in Its Own Window", group: "Workspace", scope: "global", binding: "" },
  { id: "window.spectrums", label: "Spectrums Window", group: "Workspace", scope: "global", binding: "" },
  { id: "window.takes", label: "Takes Window", group: "Workspace", scope: "global", binding: "" },
  { id: "window.bend", label: "Color Bend Window", group: "Workspace", scope: "global", binding: "" },
  { id: "window.dock_all", label: "Bring All Windows Back", group: "Workspace", scope: "global", binding: "" },
  { id: "view.layout_reset", label: "Reset Layout", group: "Workspace", scope: "global", binding: "" },
  { id: "view.fullscreen", label: "Full Screen", group: "Workspace", scope: "global", binding: "" },
  { id: "view.center_window", label: "Center Main Window", group: "Workspace", scope: "global", binding: "" },
  { id: "view.canvas_nodes", label: "Show / Hide Canvas Nodes", group: "Workspace", scope: "canvas", binding: "`" },

  // View
  { id: "view.sections.expand", label: "Expand All Sections", group: "View", scope: "global", binding: "", blurb: "Opens every adjustment section, the filtered-out ones too; hidden sections stay hidden" },
  { id: "view.sections.collapse", label: "Collapse All Sections", group: "View", scope: "global", binding: "", blurb: "Folds every adjustment section, the filtered-out ones too; hidden sections stay hidden" },
  { id: "view.zoom.in", label: "Zoom In", group: "View", scope: "global", binding: "Ctrl+=" },
  { id: "view.zoom.out", label: "Zoom Out", group: "View", scope: "global", binding: "Ctrl+-" },
  { id: "view.zoom.fit", label: "Fit to Window", group: "View", scope: "global", binding: "Ctrl+0" },
  { id: "view.zoom.100", label: "Zoom to 100%", group: "View", scope: "global", binding: "Ctrl+1" },
  // The one-letter Fit, Develop only: in Graph and Canvas, F belongs to
  // Frame Nodes, and together the two Fs tell one story - F fits the
  // view to what matters, everywhere ("Would F make sense
  // for 'Fit'?"). No single-letter 1:1 to pair with it; "I
  // think Z key should be left out."
  { id: "view.fit", label: "Fit the Photograph", group: "View", scope: "develop", binding: "F", blurb: "The frame key, viewer flavor; Ctrl+0 works in every workspace" },
  { id: "view.before_after", label: "Before / After", group: "View", scope: "global", binding: "" },
  { id: "view.split", label: "Split View", group: "View", scope: "global", binding: "" },

  // Culling
  { id: "nav.next_image", label: "Next Photo", group: "Culling", scope: "global", binding: "ArrowDown" },
  { id: "nav.prev_image", label: "Previous Photo", group: "Culling", scope: "global", binding: "ArrowUp" },
  { id: "rate.0", label: "Clear Rating", group: "Culling", scope: "global", binding: "0" },
  { id: "rate.1", label: "Rate 1 Star", group: "Culling", scope: "global", binding: "1" },
  { id: "rate.2", label: "Rate 2 Stars", group: "Culling", scope: "global", binding: "2" },
  { id: "rate.3", label: "Rate 3 Stars", group: "Culling", scope: "global", binding: "3" },
  { id: "rate.4", label: "Rate 4 Stars", group: "Culling", scope: "global", binding: "4" },
  { id: "rate.5", label: "Rate 5 Stars", group: "Culling", scope: "global", binding: "5" },
  { id: "rate.up", label: "Increase Rating", group: "Culling", scope: "global", binding: "]" },
  { id: "rate.down", label: "Decrease Rating", group: "Culling", scope: "global", binding: "[" },
  { id: "flag.pick", label: "Pick", group: "Culling", scope: "global", binding: "P" },
  { id: "flag.reject", label: "Reject", group: "Culling", scope: "global", binding: "X" },
  { id: "flag.none", label: "Clear Flag", group: "Culling", scope: "global", binding: "U" },

  // Tools These share [ and ] with the rating keys on purpose. They are
  // listed first so they get first refusal, and they decline unless the
  // brush is actually up, at which point the rating command behind them
  // runs instead. "while in brush mode overwrite the hotkey
  // for [] for brush size and SHIFT + [] for falloff (softness)." The
  // three selection commands every editor has, on the keys every editor
  // uses for them. Develop-scoped, since that is where a selection exists
  // at all.
  { id: "select.all", label: "Select All", group: "Select", scope: "develop", binding: "Ctrl+A" },
  { id: "select.none", label: "Deselect", group: "Select", scope: "develop", binding: "Ctrl+D" },
  {
    id: "select.invert",
    label: "Invert Selection",
    group: "Select",
    scope: "develop",
    binding: "Ctrl+Shift+I",
  },
  // The polish commands get no default keys: an invented binding is a
  // binding to unlearn later, and every one of these opens a dialog
  // rather than acting on its own.
  {
    id: "select.to_layer",
    label: "Isolate Selection",
    group: "Select",
    scope: "develop",
    binding: "",
    blurb: "A new pixel layer holding the picture inside the selection",
  },
  // The layer editors' key for it, free here: plain J is Next Control, and
  // Ctrl+J was bound to nothing.
  {
    id: "layer.via_copy",
    label: "New Layer via Copy",
    group: "Layer",
    scope: "develop",
    binding: "Ctrl+J",
    blurb: "Copy the pixels inside the selection to a new layer you can move and warp",
  },
  {
    id: "select.layer_pixels",
    label: "Select Layer Pixels",
    group: "Select",
    scope: "develop",
    binding: "",
    blurb: "Select the shape of what is visible on the active layer",
  },
  // The two layer transforms. Unbound like their neighbors: both are
  // drag tools with an on-screen gizmo, and a key that arms a gizmo you
  // then have to find with the mouse saves nobody anything.
  {
    id: "layer.transform",
    label: "Transform Layer",
    group: "Select",
    scope: "develop",
    binding: "",
    blurb: "Move, scale and rotate the active layer about its own pixels",
  },
  {
    id: "layer.warp",
    label: "Warp Layer",
    group: "Select",
    scope: "develop",
    binding: "",
    blurb: "Drag the four corners of the active layer independently",
  },
  { id: "select.polish", label: "Polish Selection…", group: "Select", scope: "develop", binding: "" },
  { id: "select.remove_object", label: "Remove Object", group: "Select", scope: "develop", binding: "" },
  { id: "select.smooth", label: "Smooth Selection…", group: "Select", scope: "develop", binding: "" },
  { id: "select.feather", label: "Feather Selection…", group: "Select", scope: "develop", binding: "" },
  { id: "select.resize", label: "Resize Selection…", group: "Select", scope: "develop", binding: "" },
  { id: "select.fill", label: "Fill Selection", group: "Select", scope: "develop", binding: "" },
  { id: "select.range.luma", label: "Select by Luma Range…", group: "Select", scope: "develop", binding: "" },
  { id: "select.range.color", label: "Select by Color Range…", group: "Select", scope: "develop", binding: "" },
  { id: "select.range.contrast", label: "Select by Contrast…", group: "Select", scope: "develop", binding: "" },
  { id: "select.range.depth", label: "Select by Depth Range…", group: "Select", scope: "develop", binding: "" },
  // X shares with Reject the way the brackets share with rating: the
  // brush-scope command declines when no brush is up, and Reject runs
  // behind it. "I think the X hotkey was used to switch
  // back and forth between Black and White brush."
  { id: "brush.swap", label: "Swap Paint / Erase", group: "Tools", scope: "brush", binding: "X" },
  { id: "brush.size.down", label: "Smaller Brush", group: "Tools", scope: "brush", binding: "[" },
  { id: "brush.size.up", label: "Bigger Brush", group: "Tools", scope: "brush", binding: "]" },
  { id: "brush.grain.ccw", label: "Turn Grain Left", group: "Tools", scope: "brush", binding: "Alt+[" },
  { id: "brush.grain.cw", label: "Turn Grain Right", group: "Tools", scope: "brush", binding: "Alt+]" },
  // The fine pass. Same gesture with shift held, which is what shift
  // means everywhere else in the app. Both step sizes are settings, so
  // "coarse" and "fine" are whatever the person painting says they are.
  {
    id: "brush.grain.ccw.fine",
    label: "Turn Grain Left a Little",
    group: "Tools",
    scope: "brush",
    binding: "Shift+Alt+[",
  },
  {
    id: "brush.grain.cw.fine",
    label: "Turn Grain Right a Little",
    group: "Tools",
    scope: "brush",
    binding: "Shift+Alt+]",
  },
  { id: "brush.soft.down", label: "Harder Brush Edge", group: "Tools", scope: "brush", binding: "Shift+[" },
  { id: "brush.soft.up", label: "Softer Brush Edge", group: "Tools", scope: "brush", binding: "Shift+]" },
  { id: "tool.crop", label: "Crop Tool", group: "Tools", scope: "global", binding: "Shift+C" },
  { id: "tool.straighten", label: "Straighten Tool", group: "Tools", scope: "global", binding: "Shift+S" },
  { id: "tool.gridwarp", label: "Grid Warp Tool", group: "Tools", scope: "global", binding: "Shift+G" },
  { id: "tool.shapewarp", label: "Shape Warp Tool", group: "Tools", scope: "global", binding: "Shift+W" },
  { id: "tool.brush", label: "Brush Tool", group: "Tools", scope: "global", binding: "" },
  { id: "tool.pick", label: "Eyedropper", group: "Tools", scope: "global", binding: "I" },
  { id: "tool.cancel", label: "Cancel Tool", group: "Tools", scope: "global", binding: "Escape" },
  { id: "tool.apply", label: "Apply Tool", group: "Tools", scope: "global", binding: "Enter" },

  // The Finish toolbar, by key ("hotkeys for the toolbar in
  // Finish"). Live only while that toolbar is on screen: the Finish
  // pane in Develop, and inside the Finish group in Graph or Canvas -
  // the command itself checks, since panel-and-group state is finer
  // than a mode (see artToolbarVisible in state.ts). The one exception
  // is the selection tool, which works wherever selections do (The
  // report: "can work any time since they can also be used in Develop >
  // Adjustments"). Letters follow the conventions people arrive with: V
  // move/cursor, B brush, O dodge and burn, E eraser, G the fill.
  { id: "art.cursor", label: "Cursor (put tools away)", group: "Finish Tools", scope: "global", binding: "V", blurb: "While the Finish toolbar is on screen; puts the Selection Tool away anywhere" },
  { id: "art.shape", label: "Transform / Warp Tool", group: "Finish Tools", scope: "global", binding: "T", blurb: "Arms whichever half the toolbar button last used" },
  { id: "art.select", label: "Selection Tool", group: "Finish Tools", scope: "global", binding: "M", blurb: "Works in Develop, Graph and Canvas, selection panel or not" },
  // The layer-editor Shift+tool reflex, on the whole Draw-with list (The
  // report: "a modifier key that when pressing M cycles through each
  // selection type each time M is pressed").
  { id: "art.select.cycle", label: "Next Selection Method", group: "Finish Tools", scope: "global", binding: "Shift+M", blurb: "Arms the select tool and steps Draw-with to the next method, wrapping at the end" },
  { id: "art.paint", label: "Paint Brush", group: "Finish Tools", scope: "global", binding: "B", blurb: "Only while the Finish toolbar is on screen" },
  { id: "art.dodgeburn", label: "Dodge / Burn", group: "Finish Tools", scope: "global", binding: "O", blurb: "Only while the Finish toolbar is on screen" },
  { id: "art.repair", label: "Clone / Heal", group: "Finish Tools", scope: "global", binding: "H", blurb: "Needs a pixel layer under it, like the button" },
  { id: "art.blur", label: "Blur / Blend", group: "Finish Tools", scope: "global", binding: "R", blurb: "Needs a pixel layer under it, like the button" },
  { id: "art.fill", label: "Fill Brush", group: "Finish Tools", scope: "global", binding: "G", blurb: "Makes its own layer when none is in hand" },
  { id: "art.erase", label: "Eraser", group: "Finish Tools", scope: "global", binding: "E", blurb: "Needs a pixel layer under it, like the button" },

  // Graph navigation
  { id: "graph.frame", label: "Frame Nodes", group: "Graph", scope: "graph", binding: "F", blurb: "Center the selected nodes, or everything when nothing is selected" },

  // Develop, keyboard control of the panel
  {
    // "Adjust by Key", named at last ("it was terribly
    // named... I guess we never decided on a name for this"). The id
    // stays, so a rebound key survives the rename. A for Adjust: F went
    // to Fit so that F frames the view in every workspace, and inside
    // the mode A already nudges the value, so the letter stays in one
    // semantic family.
    id: "develop.keynav",
    label: "Adjust by Key",
    group: "Develop",
    scope: "develop",
    binding: "A",
    blurb: "Letters over each section, then over its controls",
  },
  // ", to a / . to d / ; to s / ' to w. I think that will help keep
  // their fingers in a more comfortable spot." The punctuation these
  // replaced sat under the right little finger, a long way from J and K.
  //
  // Declared from the same constants the navigator matches on, because
  // this table is what the menus and the hotkey editor advertise and a
  // shortcut declared in one place and implemented in another is how the
  // bracket keys got away with doing nothing for two rounds.
  { id: "develop.nudge.up", label: "Increase Control", group: "Develop", scope: "develop", binding: NUDGE_KEYS.more.toUpperCase() },
  { id: "develop.nudge.down", label: "Decrease Control", group: "Develop", scope: "develop", binding: NUDGE_KEYS.less.toUpperCase() },
  { id: "develop.nudge.y_up", label: "Move Wheel Up", group: "Develop", scope: "develop", binding: NUDGE_KEYS.up.toUpperCase() },
  { id: "develop.nudge.y_down", label: "Move Wheel Down", group: "Develop", scope: "develop", binding: NUDGE_KEYS.down.toUpperCase() },
  { id: "develop.next_control", label: "Next Control", group: "Develop", scope: "develop", binding: "J" },
  { id: "develop.prev_control", label: "Previous Control", group: "Develop", scope: "develop", binding: "K" },

  // Nodes
  { id: "node.palette", label: "Find a Node…", group: "Nodes", scope: "graph", binding: "Shift+Space" },
  // D is a compositor's disable key, kept letter for letter: load-bearing muscle
  // memory. Rename would be N there too, but N has toggled Develop/Graph in THIS
  // app since long before today, and the owner's own muscle memory outranks the
  // compositor's. F2 is what renames everywhere else on his platform, and it is
  // rebindable besides.
  { id: "node.disable", label: "Disable / Enable Node", group: "Nodes", scope: "graph", binding: "D" },
  { id: "node.rename", label: "Rename Node", group: "Nodes", scope: "graph", binding: "F2" },
  // A compositor's search and upstream-select, in spirit: / finds by name,
  // Ctrl+U takes everything the selection depends on. The compositor uses
  // Ctrl+drag for upstream, which collides with panning here; bare U is
  // Clear Flag's, whose muscle memory predates this key.
  { id: "graph.search", label: "Find in Graph", group: "Nodes", scope: "graph", binding: "/" },
  { id: "node.upstream", label: "Select Upstream", group: "Nodes", scope: "graph", binding: "Ctrl+U" },
  // A color grader's key for its Outside node, kept: the gesture is borrowed
  // from there, and Alt+O is unclaimed here.
  { id: "node.outside", label: "Grade the Outside", group: "Nodes", scope: "graph", binding: "Alt+O" },

  // Photo
  { id: "photo.stack.hdr", label: "Merge to HDR…", group: "Photo", scope: "global", binding: "" },
  { id: "photo.stack.mean", label: "Merge to Long Exposure…", group: "Photo", scope: "global", binding: "" },
  { id: "photo.stack.median", label: "Merge to Median…", group: "Photo", scope: "global", binding: "" },
  { id: "photo.stack.max", label: "Merge to Light Trails…", group: "Photo", scope: "global", binding: "" },
  { id: "photo.panorama", label: "Stitch to Panorama…", group: "Photo", scope: "global", binding: "" },
  { id: "photo.flip_h", label: "Flip Horizontal", group: "Photo", scope: "global", binding: "" },
  { id: "photo.flip_v", label: "Flip Vertical", group: "Photo", scope: "global", binding: "" },
  {
    id: "photo.bake",
    label: "Bake to Image…",
    group: "Photo",
    scope: "global",
    binding: "",
    blurb: "Freeze the edits in a new photograph beside the original",
  },
  { id: "photo.reset_edits", label: "Reset All Edits", group: "Photo", scope: "global", binding: "" },
];

export const GROUP_ORDER = [
  "File",
  "Edit",
  "Select",
  "Layer",
  "Workspace",
  "View",
  "Culling",
  "Tools",
  "Finish Tools",
  "Develop",
  "Graph",
  "Nodes",
  "Photo",
];

/** Modifiers in one fixed order, so a chord has exactly one spelling.
 * Ctrl, Shift, Alt, which is the order the owner writes them in.*/
const MOD_ORDER = ["Ctrl", "Shift", "Alt"] as const;

/** Keys whose printed name is not what the browser reports. */
const KEY_NAMES: Record<string, string> = {
  " ": "Space",
  ArrowUp: "ArrowUp",
  ArrowDown: "ArrowDown",
  ArrowLeft: "ArrowLeft",
  ArrowRight: "ArrowRight",
  Escape: "Escape",
  Delete: "Delete",
  Backspace: "Backspace",
  Enter: "Enter",
  Tab: "Tab",
};

/** The unshifted spelling of the punctuation shift rewrites.
 *
 * A keyboard reports "<" for shift and comma, so a binding captured
 * while shift was held would record a key that can never be typed
 * without it. Stored unshifted, with Shift as a modifier, which is the
 * only way "Shift+," and "," can be told apart at all. */
const UNSHIFT: Record<string, string> = {
  "<": ",",
  ">": ".",
  '"': "'",
  ":": ";",
  "{": "[",
  "}": "]",
  "?": "/",
  "+": "=",
  _: "-",
  "~": "`",
};

/** Turns a keyboard event into a binding string. */
export function bindingOf(e: {
  key: string;
  code?: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}): string {
  let key = e.key;
  if (key === " " || e.code === "Space") key = "Space";
  else key = KEY_NAMES[key] ?? UNSHIFT[key] ?? key;
  // A single letter is stored uppercase so "p" and "P" are one binding.
  if (key.length === 1) key = key.toUpperCase();

  const mods: string[] = [];
  // Command on a Mac and Control elsewhere are the same intent.
  if (e.ctrlKey || e.metaKey) mods.push("Ctrl");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  const ordered = MOD_ORDER.filter((m) => mods.includes(m));
  return [...ordered, key].join("+");
}

/** A binding as macOS users read it: symbols in Apple's order
 * (⌃ ⌥ ⇧ ⌘) with no "+" separators. Display only; stored bindings stay
 * "Ctrl+Shift+Z" everywhere.
 *
 * "Ctrl" in a stored binding means the primary modifier, which on a Mac
 * is Command. Except for Tab: ⌘Tab belongs to the OS app switcher and
 * never reaches the app, so the physical key that works there really is
 * Control, and the label says ⌃. Key names stay as words. */
export function formatBinding(binding: string, mac: boolean = isMac()): string {
  if (!mac || !binding) return binding;
  const parts = binding.split("+");
  const key = parts[parts.length - 1];
  const mods = parts.slice(0, -1);
  const primary = key === "Tab" ? "⌃" : "⌘";
  return (
    (key === "Tab" && mods.includes("Ctrl") ? primary : "") +
    (mods.includes("Alt") ? "⌥" : "") +
    (mods.includes("Shift") ? "⇧" : "") +
    (key !== "Tab" && mods.includes("Ctrl") ? primary : "") +
    key
  );
}

/** Whether a keypress belongs to whatever has focus rather than to the
 * shortcuts: typing in a field, a dialog or menu keeping its keys, a
 * bare Space or Enter pressing a focused button. One rule for every
 * window that listens, so the main window and the popped-out graph
 * cannot disagree about when a shortcut fires.
 *
 * A range slider is not typing: panels are mostly sliders, and bailing
 * on every INPUT left every shortcut dead after the first one was
 * touched (the owner, through the brush size keys). The guided tour's
 * card is not modal either (2026-09-29: a step told him to press
 * Shift+Space and nothing happened).*/
export function keyBelongsToFocus(e: KeyboardEvent): boolean {
  if (e.defaultPrevented) return true;
  const el = e.target as HTMLElement | null;
  const tag = el?.tagName;
  const type = (el as HTMLInputElement | null)?.type ?? "";
  const typing =
    tag === "TEXTAREA" ||
    el?.isContentEditable === true ||
    (tag === "INPUT" &&
      !["range", "checkbox", "radio", "button", "submit", "reset", "color", "file"].includes(type));
  if (typing) return true;
  const modal = el?.closest?.('[role="dialog"], [role="menu"]');
  if (e.key !== "Escape" && modal && !modal.hasAttribute("data-tour-card")) return true;
  // A chord is a shortcut even with a button focused.
  const chord = e.shiftKey || e.ctrlKey || e.metaKey || e.altKey;
  return !chord && (e.key === " " || e.key === "Enter") && !!el?.closest?.("button, [role=switch]");
}

/** The commands the popped-out graph window answers by key: everything
 * scoped to the graph, plus Undo and Redo, which are what a person
 * reaches for right after a key did the wrong thing. They run in the
 * main window, which owns the state; the pop-out only says which. */
export function popoutGraphCommand(id: string): boolean {
  if (id === "edit.undo" || id === "edit.redo") return true;
  return COMMANDS.find((c) => c.id === id)?.scope === "graph";
}

/** Whether a modifier key is all that was pressed. Capturing one of
 * these as a binding would produce "Ctrl+Ctrl". */
export function isModifierOnly(key: string): boolean {
  return ["Control", "Meta", "Alt", "Shift", "CapsLock"].includes(key);
}

/** The binding in force for a command: the user's, or the default. */
export function bindingFor(id: string, overrides: Record<string, string>): string {
  if (Object.prototype.hasOwnProperty.call(overrides, id)) return overrides[id];
  return COMMANDS.find((c) => c.id === id)?.binding ?? "";
}

/** Command ids by binding, for dispatching a keypress. Later entries do
 * not clobber earlier ones, so a conflict resolves predictably rather
 * than by object key order. */
export function bindingMap(overrides: Record<string, string>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const c of COMMANDS) {
    const b = bindingFor(c.id, overrides);
    if (!b) continue;
    const list = out.get(b) ?? [];
    list.push(c.id);
    out.set(b, list);
  }
  // The caller tries these in order and stops at the first that handles
  // the key, so a command that is live only sometimes has to be offered
  // the key BEFORE the one that always takes it. Otherwise the specific
  // case is unreachable: [ and ] resize the brush only while it is up,
  // and rating is declared earlier in the table, so rating answered
  // first and the brush keys did nothing at all.
  //
  // Sorted here rather than by shuffling the table, because the table is
  // grouped for the hotkey editor to read and that grouping should not
  // have to double as a priority order.
  for (const list of out.values()) {
    list.sort((a, z) => scopeRank(a) - scopeRank(z));
  }
  return out;
}

/** How specific a command's scope is. Lower runs first. */
function scopeRank(id: string): number {
  const scope = COMMANDS.find((c) => c.id === id)?.scope;
  return scope === "global" ? 1 : 0;
}

/** Commands that share a binding with another in an overlapping scope.
 *
 * Two commands can share a key when they can never both be live: Delete
 * in the graph and Delete in the library are not a conflict. Anything
 * that can fire at the same moment is.
 */
export function conflicts(overrides: Record<string, string>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [binding, ids] of bindingMap(overrides)) {
    if (ids.length < 2) continue;
    // A brush-scoped command is live only while the brush tool is up,
    // and declines the key otherwise so whatever shares it runs instead.
    // That is a deliberate handover, not a clash, and flagging it red in
    // the editor would be crying wolf about the one case that works.
    // The nudge entries are the same bargain from the other side: the
    // control navigator reads them before the registry ever does, and
    // at the registry they always decline. That is what lets Adjust by
    // Key live on A while a is also the nudge - one enters, one moves,
    // never both.
    const live = ids
      .filter((id) => !id.startsWith("develop.nudge."))
      .map((id) => COMMANDS.find((c) => c.id === id)!.scope)
      .filter((sc) => sc !== "brush");
    if (live.length < 2) continue;
    const overlapping =
      live.includes("global") || new Set(live).size < live.length;
    if (overlapping) out.set(binding, ids);
  }
  return out;
}

/** Filters the list for the editor: matches a command's name, its group
 * or its binding, so "ctrl" finds every chord and "rate" finds the
 * ratings. */
export function searchCommands(query: string, overrides: Record<string, string>): CommandSpec[] {
  const q = query.trim().toLowerCase();
  if (!q) return COMMANDS;
  return COMMANDS.filter((c) => {
    const b = bindingFor(c.id, overrides).toLowerCase();
    return (
      c.label.toLowerCase().includes(q) ||
      c.group.toLowerCase().includes(q) ||
      c.id.toLowerCase().includes(q) ||
      b.includes(q)
    );
  });
}

/** Only what differs from the defaults is written out, so a map stays
 * readable and a later change to a default is picked up rather than
 * being frozen by an export made today. */
export function exportHotkeys(overrides: Record<string, string>): string {
  const out: Record<string, string> = {};
  for (const c of COMMANDS) {
    const b = bindingFor(c.id, overrides);
    if (b !== c.binding) out[c.id] = b;
  }
  return JSON.stringify({ version: 1, hotkeys: out }, null, 2);
}

/** Reads a map back. Unknown command ids are dropped rather than kept:
 * they would sit in the preferences forever, bound to nothing, and
 * silently claim a key from a command that does exist. */
export function importHotkeys(json: string): { hotkeys: Record<string, string>; dropped: string[] } {
  const parsed = JSON.parse(json) as { hotkeys?: Record<string, string> };
  const raw = parsed?.hotkeys ?? {};
  const hotkeys: Record<string, string> = {};
  const dropped: string[] = [];
  for (const [id, binding] of Object.entries(raw)) {
    if (COMMANDS.some((c) => c.id === id) && typeof binding === "string") hotkeys[id] = binding;
    else dropped.push(id);
  }
  return { hotkeys, dropped };
}
