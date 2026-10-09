// A menu command disappears when it opens a dialog. The durable return
// target is the control that opened that menu, including nested menus.
const origins = new WeakMap<HTMLElement, HTMLElement>();
export function rememberMenuOrigin(menu: HTMLElement, opener: HTMLElement) {
  origins.set(menu, focusReturnTarget(opener));
}
export function focusReturnTarget(element: HTMLElement): HTMLElement {
  const menu = element.closest<HTMLElement>('[role="menu"]');
  return menu && origins.has(menu) ? origins.get(menu)! : element;
}
