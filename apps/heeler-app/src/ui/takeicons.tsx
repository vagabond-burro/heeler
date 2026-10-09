// The glyphs the takes surfaces share: a file of their own so the
// dropdown in the viewer does not pull the Takes window's module into
// the main bundle (main.tsx splits the pop-outs per role).

/** The glyphs the takes surfaces share, so the dropdown and the window
 * say compare, active and delete the same way ("Use the
 * same compare icon in the dropdown to save space").*/
export function CompareIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable="false">
      <rect x="3" y="5" width="8" height="14" rx="1" />
      <rect x="13" y="5" width="8" height="14" rx="1" />
    </svg>
  );
}

/** A ring with a dot for the take in force, an empty ring for one you
 * can switch to: the same picture a radio button paints. */
export function ActiveIcon({ on, size = 15 }: { on: boolean; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden focusable="false">
      <circle cx="12" cy="12" r="8" />
      {on && <circle cx="12" cy="12" r="3.5" fill="currentColor" stroke="none" />}
    </svg>
  );
}

export function TrashIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable="false">
      <path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />
    </svg>
  );
}

