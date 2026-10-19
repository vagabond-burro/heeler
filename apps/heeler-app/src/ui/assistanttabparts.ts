// assistanttab.tsx's values and helpers that are not components, kept apart so
// assistanttab.tsx exports components alone and Vite can refresh it in place as
// it is edited instead of reloading the window.
import { _resetAssistantChatForTests } from "../assistantchat";
import { sendCommand } from "../popout";

export function _resetAssistantTabForTests(): void {
  _resetAssistantChatForTests();
}

/** A chapter opens in the Help viewer, in the main window. */
export function openChapter(file: string): void {
  sendCommand({ type: "open_docs", file });
}
