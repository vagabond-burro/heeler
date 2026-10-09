import { useEffect, type MutableRefObject } from "react";
import { listSubfolders } from "../bridge";
import type { Command, State } from "../state";

/** Poll once per 15 seconds, with at most one filesystem request in
 * flight. A sleeping drive must not accumulate overlapping scans. */
export function useFolderWatcher(stateRef: MutableRefObject<State>, dispatch: (command: Command) => void) {
  useEffect(() => {
    let pending = false;
    let live = true;
    const tick = async () => {
      if (pending) return;
      const s = stateRef.current;
      if (!s.activeFolderPath || s.activeCollection !== null) return;
      const path = s.activeFolderPath;
      pending = true;
      const subs = await listSubfolders(path).catch(() => null).finally(() => { pending = false; });
      if (live && subs && stateRef.current.activeFolderPath === path) {
        dispatch({ type: "set_tree_node", path, children: subs });
      }
    };
    const interval = setInterval(() => void tick(), 15000);
    return () => { live = false; clearInterval(interval); };
  }, []);
}
