// sectionlooks.tsx's values and helpers that are not components, kept apart so
// sectionlooks.tsx exports components alone and Vite can refresh it in place as
// it is edited instead of reloading the window.
/** The looks menu of the Tone Equalizer and Recolor sections (2026-09-30: "I
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

/** How long the pointer rests on a row before it is shown. */
export const LOOK_HOVER_MS = 80;
