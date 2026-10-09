// The catalog update card (src/catalogupgrade.ts): an older catalog
// held at the schema gate gets three answers, in the confirm dialog's
// clothes so it reads as one of the family. Fixed height, no overflow:
// the choices must never scroll out of reach.
import {
  acknowledgeCatalogUpgrade,
  chooseCatalogUpgrade,
  quitForCatalogUpgrade,
  useCatalogUpgradePrompt,
} from "../catalogupgrade";
import { useDialogFocus } from "./dialogfocus";

export function CatalogUpgradePrompt() {
  const prompt = useCatalogUpgradePrompt();
  const focus = useDialogFocus(!!prompt);
  if (!prompt) return null;
  const { pending, done, error, busy } = prompt;
  const title = done ? "Backup written, catalog updated" : "This catalog needs an update";
  return (
    <div className="modal-scrim" data-testid="catalog-upgrade-scrim">
      <div
        ref={focus}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className="modal"
        data-testid="catalog-upgrade-dialog"
        style={{ width: 440, zoom: 1.25 }}
      >
        <div className="kicker" data-testid="catalog-upgrade-title">{title}</div>
        {done ? (
          <p data-testid="catalog-upgrade-body" style={{ fontSize: 11, lineHeight: 1.5, color: "var(--text-faint)", margin: "10px 0 16px" }}>
            A copy of the catalog as it was before the update is at{" "}
            <span className="tnum" style={{ wordBreak: "break-all" }}>{done.path}</span>: {done.folders} folders and{" "}
            {done.images.toLocaleString()} photographs, verified against the catalog, thumbnails left out since they rebuild.
            The catalog itself is now current. To go back to the copy later, use Restore catalog from copy in Catalogs and
            recovery, or open the copy with Open catalog. Do not copy the file over the catalog by hand: the catalog's
            journal file beside it would be applied to the copy.
          </p>
        ) : (
          <>
            <p data-testid="catalog-upgrade-body" style={{ fontSize: 11, lineHeight: 1.5, color: "var(--text-faint)", margin: "10px 0 16px" }}>
              <span className="tnum" style={{ wordBreak: "break-all" }}>{pending.path}</span>{" "}
              was written by an older Heeler (catalog format v{pending.from}). Heeler {pending.appVersion} reads
              v{pending.to}, and updates the file the first time it opens. The update cannot be undone, so a copy
              first is the safe road. Quitting opens nothing and changes nothing.
            </p>
            {error && (
              <p data-testid="catalog-upgrade-error" style={{ fontSize: 11, lineHeight: 1.5, color: "var(--warn)", margin: "0 0 12px" }}>
                The backup could not be written, so nothing was updated: {error}
              </p>
            )}
          </>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          {done ? (
            <button className="chip" data-testid="catalog-upgrade-ok" data-initial-focus onClick={acknowledgeCatalogUpgrade}>
              OK
            </button>
          ) : (
            <>
              <button
                className="chip"
                data-testid="catalog-upgrade-quit"
                disabled={busy}
                style={{ marginRight: "auto" }}
                onClick={() => void quitForCatalogUpgrade()}
              >
                Quit
              </button>
              <button
                className="chip"
                data-testid="catalog-upgrade-nobackup"
                disabled={busy}
                onClick={() => void chooseCatalogUpgrade("nobackup")}
              >
                Update Without Backup
              </button>
              <button
                className="chip"
                data-testid="catalog-upgrade-backup"
                data-initial-focus
                disabled={busy}
                onClick={() => void chooseCatalogUpgrade("backup")}
              >
                {busy ? "Working…" : "Back Up and Update"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
