// modelconsent.tsx's hook, kept apart so modelconsent.tsx exports
// components alone and Vite can refresh it in place.
import { useEffect, useState } from "react";
import { onModelDownloadProgress } from "../bridge";

/** The share of `model`'s download that has landed, 0 to 100, while
 * `downloading`; null before the first report. */
export function useDownloadPercent(model: string, downloading: boolean): number | null {
  const [percent, setPercent] = useState<number | null>(null);
  useEffect(() => {
    if (!downloading) {
      setPercent(null);
      return;
    }
    return onModelDownloadProgress((p) => {
      if (p.model === model && p.total > 0) setPercent(Math.min(100, Math.floor((p.done * 100) / p.total)));
    });
  }, [model, downloading]);
  return percent;
}
