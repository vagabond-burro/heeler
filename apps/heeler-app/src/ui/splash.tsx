// Startup splash.
//
// Two things at once, on purpose: a rotating dog line for character, and
// underneath it the real state of the boot. The progress is not a timed
// animation. Every step shown here is something the app actually
// finished, with the concrete detail (the folder, the count, the
// filename) alongside it, so a slow catalog looks slow instead of
// looking broken.

import { useEffect, useRef, useState } from "react";
import { BOOT_LABEL, BOOT_STEPS, type Boot } from "../state";

/** Heeler is a blue heeler. The app should sound like one. */
export const QUOTES = [
  "Fetching your pictures",
  "I love editing like I love chasing my tail",
  "Rounding up the strays",
  "Nose down, tail up",
  "Herding the highlights",
  "Sniffing out the good ones",
  "Shaking the noise off",
  "Digging up what you buried last time",
  "Every pixel deserves a walk",
  "Sitting. Staying. Loading.",
  "Counting the squirrels in frame",
  "Chasing the light around the yard",
  "Ears up, shutter open",
  "Good boy energy, applied to raw files",
  "Nudging the shadows back into the pack",
];

/** How long each line stays up before the next one. */
const QUOTE_MS = 2400;
/** How long the finished splash lingers while it fades. */
const FADE_MS = 420;

export function Splash({ boot, onDone }: { boot: Boot; onDone: () => void }) {
  // A random starting line each launch, then in order, so a slow boot
  // never repeats the same one twice running.
  const start = useRef(Math.floor(Math.random() * QUOTES.length));
  const [tick, setTick] = useState(0);
  const quote = QUOTES[(start.current + tick) % QUOTES.length];

  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), QUOTE_MS);
    return () => clearInterval(t);
  }, []);

  const ready = boot.step === "ready";
  useEffect(() => {
    if (!ready) return;
    const t = setTimeout(onDone, FADE_MS);
    return () => clearTimeout(t);
  }, [ready]);

  const reached = BOOT_STEPS.indexOf(boot.step);

  return (
    <div
      data-testid="splash"
      style={{
        position: "fixed", inset: 0, zIndex: 900,
        display: "grid", placeItems: "center",
        background: "radial-gradient(120% 90% at 50% 35%, #23282e 0%, var(--bg-app) 70%)",
        opacity: ready ? 0 : 1,
        transition: `opacity ${FADE_MS}ms ease`,
        pointerEvents: ready ? "none" : "auto",
      }}
    >
      <div style={{ display: "grid", justifyItems: "center", gap: 18, width: 380, maxWidth: "82vw" }}>
        <img src="/heeler-icon.svg" alt="" width={104} height={104} style={{ borderRadius: 24 }} />
        <div style={{ fontSize: 15, fontWeight: 600, letterSpacing: ".34em", color: "var(--text-strong)", paddingLeft: ".34em" }}>
          HEELER
        </div>

        <div
          data-testid="splash-quote"
          style={{
            minHeight: 34, textAlign: "center", fontSize: 13, lineHeight: 1.45,
            color: "var(--text-body)", maxWidth: 340,
          }}
        >
          {quote}
        </div>

        {/* One segment per boot step, filled as each is reached. */}
        <div style={{ display: "flex", gap: 4, width: "100%" }} data-testid="splash-progress">
          {BOOT_STEPS.map((s, i) => (
            <div
              key={s}
              data-testid={`splash-seg-${s}`}
              data-filled={i <= reached}
              style={{
                flex: 1, height: 2, borderRadius: 1,
                background: i <= reached ? "var(--accent)" : "var(--line-2)",
                transition: "background 220ms ease",
              }}
            />
          ))}
        </div>

        <div style={{ display: "flex", width: "100%", gap: 8, fontSize: 9, letterSpacing: ".08em" }}>
          <span data-testid="splash-step" style={{ color: "var(--text-ghost)", textTransform: "uppercase", flex: "none" }}>
            {BOOT_LABEL[boot.step]}
          </span>
          <span
            data-testid="splash-detail"
            className="tnum"
            data-hint={boot.detail}
            style={{
              flex: 1, textAlign: "right", color: "var(--text-faint)",
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", direction: "rtl",
            }}
          >
            {boot.detail}
          </span>
        </div>
      </div>
    </div>
  );
}
