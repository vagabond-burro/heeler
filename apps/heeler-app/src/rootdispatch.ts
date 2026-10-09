/** Which dispatch a per-render wrapper stands in for, so the warp tools'
 * live channels (gridwarplive.ts) key by the root dispatch and the
 * viewer's wrapper and the panel's plain one meet. */
import type { Command } from "./state";

type D = (cmd: Command) => void;

/** The dispatch a wrapper stands in for. A guarded dispatch is made
 * fresh every render, so anything keyed by dispatch identity (the
 * warp tools' live channels, gridwarplive.ts) must key by the root,
 * or the viewer's wrapper and the panel's plain dispatch never meet
 * ("I don't see any pixels update until I release the
 * mouse").*/
const ROOT = Symbol("root dispatch");
export function rootDispatch(dispatch: D): D {
  const root = (dispatch as D & { [ROOT]?: D })[ROOT];
  return root ? rootDispatch(root) : dispatch;
}

/** Marks `wrapper` as standing in for `inner`, so rootDispatch() sees
 * through it. Every wrapper made per render must be stamped this way
 * (the panel's build-on-touch wrapper in simple.tsx, the warp
 * tools' wrappers), or the live channels split by wrapper. */
export function withRootDispatch(wrapper: D, inner: D): D {
  (wrapper as D & { [ROOT]?: D })[ROOT] = rootDispatch(inner);
  return wrapper;
}
