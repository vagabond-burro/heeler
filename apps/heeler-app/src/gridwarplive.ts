// The owner's performance review: wheel and pad motion belongs beside
// the overlay's live ref, so each pointer move need not repaint the
// app. A dispatch identifies one app instance; a WeakMap cannot keep
// a closed window, test harness or its last photograph alive. Grid
// Warp publishes its mesh here and Shape Warp its shape list, each on
// its own channel.
import { useSyncExternalStore } from "react";
import type { Command } from "./state";
import type { GridMesh } from "./gridwarp";
import type { WarpShape } from "./shapewarp";
import { rootDispatch } from "./rootdispatch";
type Dispatch = (command: Command) => void;
type Channel<T> = { value: T | null; listeners: Set<() => void>; subscribe: (listener: () => void) => () => void; read: () => T | null };

function channels<T>() {
  const map = new WeakMap<Dispatch, Channel<T>>();
  // Keyed by the root dispatch: the viewer's guarded wrapper is a new
  // function every render, and the section publishes on the plain one.
  const channel = (wrapped: Dispatch): Channel<T> => {
    const dispatch = rootDispatch(wrapped);
    let entry = map.get(dispatch);
    if (!entry) {
      const listeners = new Set<() => void>();
      const created: Channel<T> = {
        value: null,
        listeners,
        subscribe: (listener) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        read: () => created.value,
      };
      map.set(dispatch, created);
      entry = created;
    }
    return entry;
  };
  return {
    publish(dispatch: Dispatch, value: T | null): void {
      const entry = channel(dispatch);
      if (entry.value === value) return;
      entry.value = value;
      for (const listener of entry.listeners) listener();
    },
    read(dispatch: Dispatch): T | null {
      return channel(dispatch).value;
    },
    use(dispatch: Dispatch): T | null {
      const entry = channel(dispatch);
      // eslint-disable-next-line react-hooks/rules-of-hooks
      return useSyncExternalStore(entry.subscribe, entry.read, entry.read);
    },
  };
}

const grid = channels<GridMesh>();
const shapes = channels<WarpShape[]>();

export const publishGridWarpLive = grid.publish;
export const readGridWarpLive = grid.read;
export const useGridWarpLive = grid.use;
export const publishShapeWarpLive = shapes.publish;
export const readShapeWarpLive = shapes.read;
export const useShapeWarpLive = shapes.use;

/** A canvas twist or pinch on a shape, as the section's wheel and pad
 * would have said it: the angle swept in radians and the pull on each
 * axis. The overlay publishes it while the drag lasts, so the wheel
 * and the pad show what the hand on the canvas is doing (2026-10-01:
 * "As I warp (twist or pinch) with the shape I should see the widgets
 * update").*/
export type ShapeGestureEcho = { angle: number; scale: number; scaleY: number };
const echo = channels<ShapeGestureEcho>();
export const publishShapeGestureEcho = echo.publish;
export const readShapeGestureEcho = echo.read;
export const useShapeGestureEcho = echo.use;
