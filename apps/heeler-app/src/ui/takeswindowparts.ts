// takeswindow.tsx's values and helpers that are not components, kept apart so
// takeswindow.tsx exports components alone and Vite can refresh it in place as
// it is edited instead of reloading the window.
import type { State, Take } from "../state";

/** The takes of the active photograph, the implicit first one included. */
export function takesOf(state: State): { takes: Take[]; activeId: string } {
  const takes: Take[] =
    state.takes[state.activeImage] ??
    ([{ id: "take_1", name: "Take 1", nodes: [], wires: [] }] as Take[]);
  return { takes, activeId: state.activeTakes[state.activeImage] ?? "take_1" };
}
