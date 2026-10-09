import React from "react";
import { createRoot } from "react-dom/client";
import { connectLogSync, installConsoleTap, logMsg } from "./log";
import { CONSOLE_LOG_CHANNEL, TOOL_WINDOWS, resolveWindowRole, transport } from "./popout";
import { applyChromeZoom } from "./uiprefs";
import { installContextMenuGuard } from "./platform";
import "./theme.css";

installConsoleTap();
// The webview's own right-click menu ("Reload") stays off the screen;
// see guardContextMenu for what keeps the native one.
installContextMenuGuard(import.meta.env.DEV);
// Before first paint, so the chrome never draws at one zoom and jumps
// to another. Every window runs this, so pop-outs match the app.
applyChromeZoom();
// Every window role connects: the popped-out console shows the main
// window's log, and anything a pop-out logs flows back the same way.
{
  const t = transport();
  connectLogSync(
    (p) => t.send(CONSOLE_LOG_CHANNEL, p),
    (fn) => t.subscribe(CONSOLE_LOG_CHANNEL, fn)
  );
}

// Same bundle, several roles: the popped-out graph, spectrums and color
// wheel are thin clients of the main window rather than second copies of
// the app. Resolving the role is async because inside Tauri it comes from
// the window label; a failure here must still render something, or the
// window is a white rectangle with no way out.
//
// Imported per role rather than all at once. "There's some
// lag when popping out the color blend." A pop-out that statically
// imports App parses the whole application on the way up: the library,
// the node editor, the canvas, the catalog dialogs, the export panel,
// none of which it will ever render. Split like this, the color wheel
// window loads the color wheel.
const root = createRoot(document.getElementById("root")!);
resolveWindowRole()
  .catch(() => "main" as const)
  .then(async (role) => {
    if (role === "main" && typeof (window as any).__TAURI_INTERNALS__ !== "undefined") {
      // Name the on-disk console log once per launch, so its home is
      // discoverable from the console itself when a debugging session
      // needs it.
      const { invoke } = await import("@tauri-apps/api/core");
      invoke<string | null>("console_log_file")
        .then((p) => {
          if (p) logMsg("info", `Console log file: ${p}`);
        })
        .catch(() => {});
    }
    if (role !== null && role in TOOL_WINDOWS) {
      const { ToolWindow } = await import("./ui/toolwindow");
      root.render(
        <React.StrictMode>
          <ToolWindow kind={role as import("./popout").ToolWindowKind} />
        </React.StrictMode>,
      );
      return;
    }
    const Root =
      role === "graph"
        ? (await import("./ui/graphwindow")).GraphWindow
        : role === "spectrum"
          ? (await import("./ui/spectrumwindow")).SpectrumWindow
          : role === "takes"
            ? (await import("./ui/takeswindow")).TakesWindow
          : role === "bend"
            ? (await import("./ui/bendwindow")).BendWindow
            : role === "console"
              ? (await import("./ui/consolewindow")).ConsoleWindow
              : (await import("./app")).App;
    root.render(
      <React.StrictMode>
        <Root />
      </React.StrictMode>,
    );
  });
