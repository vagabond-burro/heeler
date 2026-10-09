import { expect, it, vi } from "vitest";
import { announceConsoleWindow, connectPySync, consoleWindowLive, onConsoleWindow } from "../ui/console";

it("remote Console open and OS-close announcements notify layout listeners without echoing", () => {
  let receive!: (p: { window: boolean }) => void;
  const send = vi.fn();
  connectPySync(send, fn => { receive = fn; });
  const changed = vi.fn();
  const stop = onConsoleWindow(changed);
  receive({ window: true });
  expect(consoleWindowLive()).toBe(true);
  expect(changed).toHaveBeenLastCalledWith(true);
  receive({ window: false });
  expect(consoleWindowLive()).toBe(false);
  expect(changed).toHaveBeenLastCalledWith(false);
  expect(send).not.toHaveBeenCalled();
  stop();
  announceConsoleWindow(false);
});
