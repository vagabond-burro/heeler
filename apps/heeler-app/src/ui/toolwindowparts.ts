// toolwindow.tsx's values and helpers that are not components, kept apart so
// toolwindow.tsx exports components alone and Vite can refresh it in place as
// it is edited instead of reloading the window.
import { useEffect, useState } from "react";
import { FRAME_CHANNEL, FRAME_REQUEST, transport } from "../popout";

/** The live preview frame, pushed from the main window on every render
 * (the spectrums' channel; Tone Equalizer's histogram reads the same one, and
 * so does the popped-out graph window's Inspector). */
export function useLiveFrame(want: boolean): string | null {
  const [frame, setFrame] = useState<string | null>(null);
  useEffect(() => {
    if (!want) return;
    const un = transport().subscribe(FRAME_CHANNEL, (payload: unknown) => {
      const f = (payload as { frame?: string | null } | null)?.frame ?? null;
      setFrame(f);
    });
    transport().send(FRAME_REQUEST, true);
    return un;
  }, [want]);
  return frame;
}
