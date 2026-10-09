// Driving a MenuField from a test, the app's one dropdown (2026-10-06:
// "dropdowns are NOT consistent in this app ... Standardize this"). A
// native <select> took fireEvent.change; this is the click a person
// makes: open the field, then press the row.
import { fireEvent, within } from "@testing-library/react";
import type { UserEvent } from "@testing-library/user-event";

const rowOf = (field: HTMLElement, id: string): HTMLElement => {
  if (field.getAttribute("aria-expanded") !== "true") fireEvent.click(field);
  const list = document.querySelector<HTMLElement>(`[data-testid="${field.dataset.testid}-menu"]`);
  if (!list) throw new Error(`${field.dataset.testid} did not open`);
  return within(list).getByTestId(`${field.dataset.testid}-option-${id}`);
};

/** Choose `id` from the MenuField `field`. */
export function choose(field: HTMLElement, id: string): void {
  fireEvent.click(rowOf(field, id));
}

/** The same through user-event, for tests written with it. */
export async function chooseWith(user: UserEvent, field: HTMLElement, id: string): Promise<void> {
  if (field.getAttribute("aria-expanded") !== "true") await user.click(field);
  await user.click(rowOf(field, id));
}

/** The chosen id, what a select's .value was. */
export const menuValue = (field: HTMLElement): string => field.dataset.value ?? "";

/** Every row's [id, label], read by opening the list and closing it. */
export function menuRows(field: HTMLElement): [string, string][] {
  const wasOpen = field.getAttribute("aria-expanded") === "true";
  if (!wasOpen) fireEvent.click(field);
  const prefix = `${field.dataset.testid}-option-`;
  const list = document.querySelector<HTMLElement>(`[data-testid="${field.dataset.testid}-menu"]`)!;
  const rows = within(list)
    .getAllByRole("option", { hidden: true })
    .map((r) => [r.dataset.testid!.slice(prefix.length), r.textContent ?? ""] as [string, string]);
  if (!wasOpen) fireEvent.click(field);
  return rows;
}
