// finishadjustments.tsx's values and helpers that are not components, kept apart so
// finishadjustments.tsx exports components alone and Vite can refresh it in place as
// it is edited instead of reloading the window.
import type { State } from "../state";
import { serializeGraph } from "../bridge";

/** The input, decoded to scene light before the operation, renders as a
 * correctly encoded thumbnail. A full-stack preview would count edits
 * above this layer. In a browser without the engine there is no underlay. */
export function finishHistogramNode(state: State, id: string): string | undefined {
  return serializeGraph(state).connections.find(w => w.to[0] === id && w.to[1] === "in")?.from[0];
}
