// The main window as a window: full screen and centering, for the
// Window menu. Tauri owns the window on the desktop; the browser build
// does what a browser can.
import { isTauri } from "./bridge";

export async function toggleFullscreen(): Promise<void> {
  if (isTauri()) {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const win = getCurrentWindow();
    await win.setFullscreen(!(await win.isFullscreen()));
    return;
  }
  if (typeof document === "undefined") return;
  if (document.fullscreenElement) await document.exitFullscreen?.();
  else await document.documentElement.requestFullscreen?.();
}

/** Puts the main window back in the middle of its display: the way
 * home when the window itself has been dragged out of reach. */
export async function centerMainWindow(): Promise<void> {
  if (!isTauri()) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const win = getCurrentWindow();
  if (await win.isFullscreen()) await win.setFullscreen(false);
  await win.unmaximize().catch(() => {});
  await win.center();
}
