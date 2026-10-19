// publishcontrols.tsx's values and helpers that are not components, kept apart so
// publishcontrols.tsx exports components alone and Vite can refresh it in place as
// it is edited instead of reloading the window.

/** What a right-click inside the Inspector landed on: the row's member,
 * its param, and the words on the row. Rows say who they are with
 * data-node and data-param (the shared Slider always has; the pickers
 * and switches do since this change). */
export function publishRowAt(target: EventTarget | null, fallbackNode: string): { node: string; param: string; label: string } | null {
  const el = target instanceof Element ? target.closest<HTMLElement>("[data-param]") : null;
  const param = el?.dataset.param;
  if (!el || !param) return null;
  const label = el.querySelector(".lbl")?.textContent?.trim() || param.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
  return { node: el.dataset.node || fallbackNode, param, label };
}

/** The status line's words for a member's row inside an open group. */
export const PUBLISH_HINT = "Publish a control to the group: right-click it, and the group offers it from outside";

export const slug = (label: string) => label.toLowerCase().replace(/[^a-z0-9]+/g, "-");
