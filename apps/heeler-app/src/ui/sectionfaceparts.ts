// The values beside sectionface.tsx (a .tsx file exports components
// alone): which node type wears which section's face, and which rows a
// widget seats inside its own window layout.
import type { SectionSpec, SectionWidgetKind } from "./simpledata";
import { SECTIONS } from "./simpledata";
import type { ToolWindowKind } from "../popout";

/** The node types whose Graph inspector draws a Develop section's face
 * (SectionFace), and the section each one draws. A node listed here
 * shows the rows of that section that write to it, with the section's
 * widgets, in the section's order. */
export const FACE_SECTIONS: Record<string, string> = {
  "heeler.exposure": "Exposure",
  "heeler.standard_color": "Color",
  "heeler.levels": "Levels",
  "heeler.curves": "Curves",
  "heeler.paper": "Print",
  "heeler.tone_eq": "Tone Equalizer",
  "heeler.color_balance": "Color Wheels",
  "heeler.color_console": "Color Tune",
  "heeler.color_bend": "Color Bend",
  "heeler.recolor": "Recolor",
  "heeler.detail": "Detail",
  "heeler.crop_rotate": "Geometry",
};

/** The section whose face a node of this type wears, if any. */
export function faceSectionOf(type: string): SectionSpec | undefined {
  const title = FACE_SECTIONS[type];
  return title ? sectionNamed(title) : undefined;
}

/** A section by its title. */
export function sectionNamed(title: string): SectionSpec | undefined {
  return SECTIONS.find((sec) => sec.title === title);
}

/** Rows a widget draws itself in its window layout, so the face leaves
 * them out there: Color Tune's window seats Smoothing above its band
 * buttons, in the column beside the wheel. */
export const WINDOWED_ROWS: Partial<Record<SectionWidgetKind, string[]>> = {
  colorConsole: ["smoothing"],
};

/** How each tool window sizes its face to the stage: the least width
 * and plot height it draws at, and the room the stage keeps for what is
 * not the plot (the chip rows, the dials, the wheels' readouts and help
 * line). */
export const WINDOW_FIT: Record<ToolWindowKind, { minW: number; minH: number; reserve: number }> = {
  curves: { minW: 320, minH: 220, reserve: 106 },
  wheels: { minW: 0, minH: 0, reserve: 146 },
  // Above and below the EQ: its two dials and the picker.
  toneeq: { minW: 360, minH: 240, reserve: 150 },
  // The two menus plus the sliders need far less than the old cell grid
  // did, and the leftover read as dead space above the plot.
  recolor: { minW: 380, minH: 240, reserve: 140 },
  colorconsole: { minW: 420, minH: 280, reserve: 60 },
};
