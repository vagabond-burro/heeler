// One Tauri subscription per event, for the window's whole life, with
// the app's handlers joining and leaving it in plain JavaScript.
//
// 2026-09-29: "Couldn't find callback id ... This might happen when the
// app is reloaded while Rust is running an asynchronous operation",
// twice, on every launch of the dev app. React's StrictMode mounts each
// component twice in development, so an effect that called listen
// subscribed, unsubscribed and subscribed again at boot; Rust's boot log
// lines (heeler:log) arrived for the dropped subscription in the moment
// between the JavaScript side forgetting its callback and the Rust side
// hearing so, and Tauri warned. The same race ran whenever a progress
// listener left while its operation was still reporting.
//
// Here the Tauri listener is registered once per event name and never
// removed; subscribing and unsubscribing only add and remove a handler
// from a set, synchronously, so nothing Rust sends can reach a callback
// that is gone. An event with no handlers left is dropped here, which
// costs a function call.

type Handler = (payload: unknown) => void;

interface Hub {
  handlers: Set<Handler>;
}

const hubs = new Map<string, Hub>();

/** Tauri's event module, imported once and shared by every hub. */
let eventApi: Promise<typeof import("@tauri-apps/api/event")> | null = null;
function tauriEventApi() {
  if (!eventApi) eventApi = import("@tauri-apps/api/event");
  return eventApi;
}

/** Subscribes `fn` to the Tauri event `name`; returns the unsubscribe.
 * Safe to call and undo any number of times: the Tauri listener behind
 * it is registered once and stays. */
export function onTauriEvent<T>(name: string, fn: (payload: T) => void): () => void {
  let hub = hubs.get(name);
  if (!hub) {
    const created: Hub = { handlers: new Set() };
    hub = created;
    hubs.set(name, created);
    void tauriEventApi()
      .then(({ listen }) =>
        listen(name, (e) => {
          // A copy, so a handler that unsubscribes while being called
          // does not skip its neighbor.
          for (const h of [...created.handlers]) {
            try { h(e.payload); } catch {
              // Keep delivering. Neither the payload nor a handler's
              // error is safe to log (it can contain conversation text).
            }
          }
        }),
      )
      .catch(() => {
        // No Tauri (a browser build that got here by mistake): the hub
        // stays silent rather than throwing into a render.
      });
  }
  const handler = fn as Handler;
  hub.handlers.add(handler);
  return () => {
    hub!.handlers.delete(handler);
  };
}

/** Test hook: forgets every hub, so a test's mocked listen is asked
 * again. */
export function _resetTauriEventsForTests(): void {
  hubs.clear();
  eventApi = null;
}
