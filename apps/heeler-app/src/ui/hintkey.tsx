// The letter you press, sitting over the thing it selects.
//
// Its own module because both the sliders and the color wheels wear
// one, and the wheels live in editors.tsx while the sliders live in
// simple.tsx, which already imports editors: putting it in either would
// make the pair circular.

/** Overlaid rather than inserted, so pressing F does not reflow the
 * whole panel by a few pixels: nothing moves, the letters simply appear.
 * The label underneath dims so the letter is what the eye lands on,
 * which is the entire trick Vimium plays. */
export function HintKey({ hint, testid }: { hint: string; testid?: string }) {
  return (
    <span
      data-testid={testid}
      style={{
        position: "absolute",
        left: -3,
        top: "50%",
        transform: "translateY(-50%)",
        zIndex: 5,
        minWidth: 12,
        textAlign: "center",
        padding: "1px 3px",
        borderRadius: 2,
        background: "var(--accent)",
        color: "#0f1517",
        fontSize: 9,
        fontWeight: 700,
        lineHeight: 1.25,
        letterSpacing: ".04em",
        fontFamily: "ui-monospace, monospace",
        boxShadow: "0 1px 4px rgba(0,0,0,.6)",
        pointerEvents: "none",
      }}
    >
      {hint}
    </span>
  );
}
