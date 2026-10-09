// The console as an OS window of its own. "I would like to
// be able to drag that console window outside of the main window." A
// floating div can never leave its webview; this can, to another
// monitor.
//
// It renders the same ConsolePanel the main window floats, in windowed
// mode: filling the window, no drag handle (the OS titlebar drags), no
// close chip (the OS close button closes). The log and the Python
// scrollback arrive over the console sync channels main.tsx wires for
// every window role, and the scratchboard tabs come along through
// localStorage; the interpreter itself lives in Rust, one session
// whichever window is typing at it.

import { useEffect, useState } from "react";
import { connectPySync, ConsolePanel } from "./console";
import { connectConsoleAssistant } from "../assistant";
import { connectTours } from "../tourwalk";
import { connectAssistantChat } from "../assistantchat";
import { CONSOLE_PY_CHANNEL, transport } from "../popout";
import { useHintSource } from "./hints";
import { PopoutStatusRow } from "./popoutstatus";

let synced = false;

export function ConsoleWindow() {
  useHintSource();
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const stopAssistant = connectConsoleAssistant("console", transport());
    const stopTours = connectTours("console", transport());
    // The conversation is the main window's (src/assistantchat.ts): this
    // window shows it, and asks for it again whenever it opens.
    const stopChat = connectAssistantChat("console", transport());
    if (!synced) {
      synced = true;
      const t = transport();
      connectPySync(
        (p) => t.send(CONSOLE_PY_CHANNEL, p),
        (fn) => t.subscribe(CONSOLE_PY_CHANNEL, fn)
      );
    }
    setReady(true);
    return () => { stopAssistant(); stopTours(); stopChat(); };
  }, []);
  if (!ready) return null;
  return (
    <div style={{ position: "fixed", inset: 0, background: "var(--bg-panel)", display: "flex", flexDirection: "column" }} data-testid="console-window">
      <div className="ui-zoom" style={{ flex: 1, minHeight: 0, position: "relative" }}>
        {/* The panel's own close chip closes the OS window in windowed
            mode (pop-outs are undecorated, so it is the only close), and
            no other command reaches a reducer from here: the dispatch is
            a no-op by design. */}
        <ConsolePanel open windowed dispatch={() => {}} />
      </div>
      <PopoutStatusRow testid="console-window-hint" />
    </div>
  );
}
