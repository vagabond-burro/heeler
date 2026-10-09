/** The link glyph every linked-photographs surface wears: the thumbnail
 * mark, the viewer header's note, and the menu items that belong to the
 * feature, so a Link item is told from its neighbors at a glance. */
export function LinkIcon({ size = 11, style }: { size?: number; style?: React.CSSProperties }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable="false" style={{ flex: "none", ...style }}>
      <path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1" />
      <path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1" />
    </svg>
  );
}
