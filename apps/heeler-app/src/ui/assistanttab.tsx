// The Console's Assistant tab: a chat for Help questions, answered from
// the user guide by the model the user picked in Preferences >
// Assistant. Each question takes two calls (src/assistant.ts,
// askGuide): the model picks chapters from the guide's table of
// contents, then answers from their best sections. Each answer names
// the chapters it used, as links that open them in the Help viewer. The
// assistant has no tools here: it reads the guide and a few facts about
// the open photograph, and it cannot touch the graph, the catalog or a
// file.
//
// An answer whose directions can be shown ends with an offer: "Would
// you like me to show you? Say yes, or press Show me." Saying yes, or
// SHOW ME, makes the guided tour then (src/tour.ts: one more call turns
// the answer into stops from Heeler's own list, checked and made whole)
// and walks it in the main window (src/tourwalk.ts), which points and
// waits and never changes the edit. A tour that cannot be made gets the
// sorry line. When the tour ends, Learn more offers the chapter it used
// and what sits near it.
//
// The conversation lives in the main window for as long as Heeler runs
// (src/assistantchat.ts): this tab shows it and sends what the user does
// here, so closing, reopening or reloading the Console loses nothing.
// Never written anywhere; gone at quit or on Clear.
//
// Nothing here navigates. Every chapter link and Learn more is a button
// that asks the main window to open the Help viewer over the transport;
// the Console's own page is never replaced.

import React, { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { assistantContextLength, assistantValidate, type AssistantValidation } from "../bridge";
import { assistantConfig, assistantConfigVersion, subscribeAssistantConfig, validationWords } from "../assistant";
import {
  askAssistant,
  chatSnapshot,
  chatVersion,
  clearAssistantConversation,
  dismissVisionHint,
  knownContext,
  noteContext,
  pendingOffer,
  showTour,
  stopAssistant,
  subscribeChat,
  _resetAssistantChatForTests,
} from "../assistantchat";
import { subscribeTourStatus, tourStatus, tourSteps, type FollowUp, type Tour } from "../tourwalk";
import { OFFER_LINE } from "../tour";
import { AssistantMarkdown } from "./assistantmarkdown";
import { sendCommand } from "../popout";

export { clearAssistantConversation };

export function _resetAssistantTabForTests(): void {
  _resetAssistantChatForTests();
}

/** A chapter opens in the Help viewer, in the main window. */
export function openChapter(file: string): void {
  sendCommand({ type: "open_docs", file });
}

/** Learn more: a chapter opens in Help, a question is asked. */
function followUp(f: FollowUp): void {
  if (f.kind === "help" && f.file) openChapter(f.file);
  else if (f.question) askAssistant(f.question);
}

let tourVersion = 0;
function subscribeTours(fn: () => void): () => void {
  return subscribeTourStatus(() => {
    tourVersion++;
    fn();
  });
}
const tourVer = () => tourVersion;

function openPreferences(): void {
  sendCommand({ type: "open_prefs", landing: "assistant-server" });
}

const TEXT: React.CSSProperties = { fontSize: 13, lineHeight: 1.55, whiteSpace: "pre-wrap", wordBreak: "break-word" };
/** An answer is rendered markdown: its own paragraphs and lists, so
 * the text flows rather than keeping the model's line breaks. */
const ANSWER: React.CSSProperties = { fontSize: 13, lineHeight: 1.55, wordBreak: "break-word", color: "var(--text-body)" };

const SHOW_ME_HINT = "Walks you through these steps in the main window: it points at each control and waits for you to use it; it never changes your edit";

/** The offer under an answer: the line while it is the last turn (a
 * "yes" then takes it), and SHOW ME, which makes the tour and walks it. */
function OfferRow({ turn, pending }: { turn: number; pending: boolean }) {
  return (
    <div data-testid="assistant-offer" style={{ marginTop: 6, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
      {pending && (
        <span data-testid="assistant-offer-line" style={{ fontSize: 13, lineHeight: 1.55, color: "var(--text-body)" }}>
          {OFFER_LINE}
        </span>
      )}
      <button
        type="button"
        className="chip"
        data-testid="assistant-show-me"
        aria-label="Show me, a guided tour in the main window"
        data-hint={SHOW_ME_HINT}
        style={{ fontSize: 11, padding: "1px 8px" }}
        onClick={() => showTour(turn)}
      >
        SHOW ME
      </button>
    </div>
  );
}

/** SHOW ME, and when the tour has ended, Learn more. */
function TourRow({ tour, turn }: { tour: Tour; turn: number }) {
  // The main window's word first (kept with the conversation, so a
  // Console opened after the tour still knows), then what this window
  // heard since SHOW ME.
  const status = chatSnapshot().tours[tour.id] ?? tourStatus(tour.id);
  // No count before the tour starts: the steps already done are left
  // out of the walk, and which those are is the main window's state
  // when the tour starts, not when the answer came. Once it runs, the
  // count is the walk's own, as the card shows it.
  const n = chatSnapshot().tourSteps[tour.id] ?? tourSteps(tour.id);
  const steps = n === null || n === undefined ? "" : `, ${n} ${n === 1 ? "step" : "steps"}`;
  return (
    <div data-testid="assistant-tour" style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 5 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <button
          type="button"
          className="chip"
          data-testid="assistant-show-me"
          aria-label="Show me, a guided tour in the main window"
          data-hint={SHOW_ME_HINT}
          style={{ fontSize: 11, padding: "1px 8px" }}
          onClick={() => showTour(turn)}
        >
          SHOW ME
        </button>
        <span style={{ fontSize: 12, color: "var(--text-ghost)" }}>
          {status === "running"
            ? `The tour is running in the main window${steps}.`
            : status === "finished"
              ? "Tour done."
              : status === "stopped"
                ? "Tour stopped."
                : "A guided tour of these steps, in the main window."}
        </span>
      </div>
      {(status === "finished" || status === "stopped") && tour.followUps.length > 0 && (
        <div data-testid="assistant-learn-more" style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          <span style={{ fontSize: 11, color: "var(--text-ghost)" }}>Learn more:</span>
          {tour.followUps.map((f, i) => (
            <button
              type="button"
              key={i}
              className="chip"
              data-testid={`assistant-follow-${i}`}
              data-hint={f.kind === "help" ? "Opens this chapter in the Help viewer" : "Asks the assistant this question"}
              style={{ fontSize: 11, padding: "1px 8px" }}
              onClick={() => followUp(f)}
            >
              {f.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function AssistantTab() {
  useSyncExternalStore(subscribeChat, chatVersion, chatVersion);
  useSyncExternalStore(subscribeAssistantConfig, assistantConfigVersion, assistantConfigVersion);
  useSyncExternalStore(subscribeTours, tourVer, tourVer);
  const { turns, busy, visionHint } = chatSnapshot();
  const pending = pendingOffer();
  const c = assistantConfig();
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState<AssistantValidation | "checking" | "failed" | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Checked when the tab opens: the tab stays
  // either way, and says so when the server has gone away. No dialog.
  useEffect(() => {
    let live = true;
    setStatus("checking");
    void assistantValidate(c.address)
      .then((v) => { if (live) setStatus(v); })
      .catch(() => { if (live) setStatus("failed"); });
    return () => { live = false; };
  }, [c.address]);

  // The model's context, once per address and model: a larger one
  // lets more of the guide go with each question. Never required.
  useEffect(() => {
    const key = `${c.address} ${c.model}`;
    if (!c.model || knownContext(key)) return;
    void assistantContextLength(c.address, c.model)
      .then((tokens) => noteContext(key, tokens))
      .catch(() => noteContext(key, null));
  }, [c.address, c.model]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  });

  const connected = status !== null && typeof status === "object" && status.kind === "connected";
  const modelListed = connected && status.models.some((m) => m.id === c.model);
  let notice: string | null = null;
  if (status === "failed") notice = `Not connected: the server at ${c.address} could not be checked.`;
  else if (status && typeof status === "object" && status.kind !== "connected") notice = `Not connected. ${validationWords(status)}`;
  else if (connected && !modelListed) notice = `Not connected to ${c.model}: the server no longer lists it. Load it again, or pick another model.`;

  const send = () => {
    const q = draft.trim();
    if (!q || busy) return;
    setDraft("");
    askAssistant(q);
  };

  return (
    <>
      <div ref={scrollRef} data-testid="assistant-output" style={{ flex: 1, overflowY: "auto", padding: "8px 12px", display: "flex", flexDirection: "column", gap: 10 }}>
        {notice && (
          <div data-testid="assistant-offline" style={{ ...TEXT, color: "var(--warn)" }}>
            {notice}{" "}
            <button
              type="button"
              className="chip"
              data-testid="assistant-open-prefs"
              aria-label="Open Preferences, Assistant"
              data-hint="Opens Preferences at the assistant's server address"
              style={{ fontSize: 11, padding: "1px 8px" }}
              onClick={openPreferences}
            >
              PREFERENCES
            </button>
          </div>
        )}
        {turns.length === 0 && (
          <div data-testid="assistant-intro" style={{ ...TEXT, color: "var(--text-ghost)" }}>
            Ask how to do something in Heeler. Answers come from the user guide, through {c.model} on {c.address}, and name
            the chapters they used. The assistant reads the guide only: it cannot change your photographs, the graph or
            the catalog, and it can be wrong, so check what it says against the chapter.
          </div>
        )}
        {turns.map((t, i) => (
          <div key={i} data-testid={`assistant-turn-${t.role}`}>
            <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: ".12em", color: t.role === "user" ? "var(--text-ghost)" : "var(--accent)", marginBottom: 2 }}>
              {t.role === "user" ? "YOU" : t.role === "assistant" ? "ASSISTANT" : "NOT ANSWERED"}
            </div>
            {t.role === "assistant" ? (
              <div data-testid="assistant-answer" style={{ ...ANSWER, WebkitUserSelect: "text", userSelect: "text" }}>
                <AssistantMarkdown text={t.text} />
              </div>
            ) : (
              <div style={{ ...TEXT, color: t.role === "error" ? "var(--warn)" : "var(--text-body)", WebkitUserSelect: "text", userSelect: "text" }}>{t.text}</div>
            )}
            {t.cites && t.cites.length > 0 && (
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", marginTop: 5 }}>
                <span style={{ fontSize: 11, color: "var(--text-ghost)" }}>From the guide:</span>
                {t.cites.map((cite) => (
                  <button
                    type="button"
                    key={cite.file}
                    className="chip"
                    data-testid="assistant-cite"
                    data-file={cite.file}
                    aria-label={`Open ${cite.title} in Help`}
                    data-hint={`Opens ${cite.title} in the Help viewer`}
                    style={{ fontSize: 11, padding: "1px 8px" }}
                    onClick={() => openChapter(cite.file)}
                  >
                    {cite.title}
                  </button>
                ))}
              </div>
            )}
            {t.role === "assistant" && t.tour === "offered" && <OfferRow turn={i} pending={pending === i && !busy} />}
            {t.role === "assistant" && t.tour === "building" && (
              <div data-testid="assistant-tour-building" style={{ fontSize: 12, color: "var(--text-ghost)", marginTop: 5 }}>
                Making the guided tour of these steps...
              </div>
            )}
            {t.role === "assistant" && t.tour && typeof t.tour === "object" && (
              <TourRow tour={t.tour} turn={i} />
            )}
            {t.role === "assistant" && !t.local && (!t.cites || t.cites.length === 0) && (
              <div data-testid="assistant-uncited" style={{ fontSize: 11, color: "var(--text-ghost)", marginTop: 4 }}>
                This answer names no chapter of the guide; treat it with care.
              </div>
            )}
          </div>
        ))}
        {visionHint === "showing" && (
          <div data-testid="assistant-vision-hint" style={{ fontSize: 12, lineHeight: 1.5, color: "var(--text-ghost)", display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            <span>Let the assistant know what is in your photograph: the Florence-2 download in Preferences &gt; Assistant runs on this computer.</span>
            <button
              type="button"
              className="chip"
              data-testid="assistant-vision-hint-open"
              aria-label="Open Preferences, Assistant, Florence-2"
              data-hint="Opens Preferences at the Florence-2 download"
              style={{ fontSize: 11, padding: "1px 8px" }}
              onClick={() => sendCommand({ type: "open_prefs", landing: "assistant-florence" })}
            >
              PREFERENCES
            </button>
            <button
              type="button"
              className="chip"
              data-testid="assistant-vision-hint-dismiss"
              aria-label="Dismiss the Florence-2 hint"
              data-hint="Hides this hint for the rest of the session"
              style={{ fontSize: 11, padding: "1px 8px" }}
              onClick={dismissVisionHint}
            >
              DISMISS
            </button>
          </div>
        )}
        {busy && (
          <div data-testid="assistant-busy" style={{ ...TEXT, color: "var(--text-ghost)" }}>
            Thinking. A local model can take a minute.
          </div>
        )}
      </div>
      <div style={{ display: "flex", gap: 6, padding: "6px 8px", borderTop: "1px solid var(--line-2)", alignItems: "flex-end" }}>
        <textarea
          data-testid="assistant-input"
          aria-label="Ask the assistant"
          data-hint="Type a question about Heeler; Enter asks, Shift+Enter starts a new line"
          placeholder="How do I..."
          value={draft}
          rows={2}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          style={{ flex: 1, resize: "none", background: "var(--bg-app)", border: "1px solid var(--line-4)", color: "var(--text-body)", fontSize: 13, padding: "5px 7px", outline: "none", fontFamily: "inherit" }}
        />
        {busy ? (
          <button type="button" className="chip" data-testid="assistant-stop" aria-label="Stop waiting for the answer" data-hint="Stops waiting for this answer" style={{ fontSize: 11, padding: "2px 9px" }} onClick={stopAssistant}>
            STOP
          </button>
        ) : (
          <button type="button" className="chip" data-testid="assistant-ask" aria-label="Ask" data-hint="Sends the question, the guide's contents, the photograph's facts, its measured numbers and Florence-2's description when installed to your model server, then the chapters it picks" style={{ fontSize: 11, padding: "2px 9px" }} disabled={!draft.trim()} onClick={send}>
            ASK
          </button>
        )}
      </div>
    </>
  );
}
