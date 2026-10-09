// The update dialog (src/updates.ts): one small card for the three
// things a check can say, in the confirm dialog's clothes so it reads
// as one of the family.
import { openReleaseUrl } from "../bridge";
import { UPDATE_DOWNLOAD_WORDS, closeUpdatePrompt, skipVersion, useUpdatePrompt } from "../updates";
import { useDialogFocus } from "./dialogfocus";

export function UpdatePrompt() {
  const prompt = useUpdatePrompt();
  const focus = useDialogFocus(!!prompt);
  if (!prompt) return null;
  const o = prompt.outcome;
  const title = !o
    ? "Checking for updates"
    : o.kind === "available"
      ? `Heeler ${o.latest} is available`
      : o.kind === "current"
        ? "You're up to date"
        : "Could not check for updates";
  const body = !o
    ? "Asking the release list whether a newer Heeler exists."
    : o.kind === "available"
      ? `You are running Heeler ${o.current}. ${UPDATE_DOWNLOAD_WORDS}`
      : o.kind === "current"
        ? `Heeler ${o.current} is the newest release.`
        : "The release list could not be reached. Check your connection, then try Help > Check for Updates again.";
  const download = () => {
    if (o?.kind !== "available") return;
    void openReleaseUrl(o.url);
    closeUpdatePrompt();
  };
  return (
    <div className="modal-scrim" data-testid="updates-scrim">
      <div
        ref={focus}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className="modal"
        data-testid="updates-dialog"
        style={{ width: 420, zoom: 1.25 }}
        onKeyDown={(e) => {
          if (e.key === "Escape") closeUpdatePrompt();
        }}
      >
        <div className="kicker" data-testid="updates-title">{title}</div>
        <p data-testid="updates-body" style={{ fontSize: 11, lineHeight: 1.5, color: "var(--text-faint)", margin: "10px 0 16px" }}>
          {body}
        </p>
        {o?.kind === "available" && o.notes && (
          // The notes in a box of fixed height that scrolls, so a long list
          // cannot grow the dialog past the window (2026-09-16). A bullet
          // list, which release.py writes one item a line, is drawn as one;
          // anything else keeps its line breaks as written.
          <div
            data-testid="updates-notes"
            style={{ fontSize: 11, lineHeight: 1.5, color: "var(--text-body)", margin: "0 0 16px", maxHeight: 220, overflowY: "auto", paddingRight: 6 }}
          >
            {(() => {
              const lines = o.notes.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
              const items = lines.map((l) => l.replace(/^[-*•]\s+/, ""));
              const isList = lines.length > 0 && lines.every((l) => /^[-*•]\s+/.test(l));
              return isList ? (
                <ul style={{ margin: 0, paddingLeft: 16 }}>
                  {items.map((item, i) => (
                    <li key={i} style={{ margin: "0 0 4px" }}>{item}</li>
                  ))}
                </ul>
              ) : (
                <p style={{ margin: 0, whiteSpace: "pre-wrap" }}>{o.notes}</p>
              );
            })()}
          </div>
        )}
        {o?.kind === "unreachable" && (
          <p data-testid="updates-detail" style={{ fontSize: 9, color: "var(--text-ghost)", margin: "0 0 12px" }}>
            {o.detail}
          </p>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          {o?.kind === "available" ? (
            <>
              {/* Only the launch prompt can be silenced: the menu is an
                  explicit question, and a question gets its answer. */}
              {prompt.trigger === "launch" && (
                <button className="chip" data-testid="updates-skip" onClick={() => skipVersion(o.latest)} style={{ marginRight: "auto" }}>
                  Skip this version
                </button>
              )}
              <button className="chip" data-testid="updates-later" onClick={closeUpdatePrompt}>
                Later
              </button>
              <button className="chip" data-testid="updates-download" data-initial-focus onClick={download}>
                Download
              </button>
            </>
          ) : (
            <button className="chip" data-testid="updates-ok" data-initial-focus disabled={!o} onClick={closeUpdatePrompt}>
              {o ? "OK" : "Checking…"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
