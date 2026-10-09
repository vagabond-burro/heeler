// The engine mask's ants, traced off the interactive thread (the
// assistant review's R7): a speckled mask took 98 ms to trace before the
// browser could paint the slider that asked for it. The mask arrives at
// its own resolution and aspect and is traced there (maskants.ts).
import { maskAnts } from "./maskants";

self.onmessage = (e: MessageEvent<{ id: number; plane: Float32Array; w: number; h: number }>) => {
  const { id, plane, w, h } = e.data;
  const { traced, shown } = maskAnts(plane, w, h);
  (self as unknown as Worker).postMessage({ id, traced, shown });
};
