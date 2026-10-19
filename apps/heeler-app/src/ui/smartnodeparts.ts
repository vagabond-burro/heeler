// smartnode.tsx's values and helpers that are not components, kept apart so
// smartnode.tsx exports components alone and Vite can refresh it in place as
// it is edited instead of reloading the window.
import { useEffect, useState } from "react";
import { smartModelStatus, type SmartModels } from "../bridge";
import type { NodeCard } from "../state";

/** The smart models' standing for a face or a card: asked when `ask`
 * turns true and again whenever `refresh` changes (the graph passes
 * Preferences' open flag, so an install there is seen on the way back).
 * Null until the answer lands, and in the browser mock. */
export function useSmartModels(ask: boolean, refresh: unknown = 0): SmartModels | null {
  const [models, setModels] = useState<SmartModels | null>(null);
  useEffect(() => {
    if (!ask) return;
    let live = true;
    void smartModelStatus()
      .then((m) => {
        if (live) setModels(m);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [ask, refresh]);
  return models;
}

/** Whether the model a Smart mask's mode needs is missing here: SAM for
 * every mode, except Subject, which BiRefNet answers when it is
 * installed (lib.rs smart_compute). Not known yet is not missing. */
export function smartModelMissing(models: SmartModels | null, mode: string): boolean {
  if (!models?.sam) return false;
  if (mode === "subject" && models.matte?.installed) return false;
  return !models.sam.installed;
}

/** The words a Smart Mask card wears under its picture when the mask is
 * empty for a reason the black picture cannot tell (the badge the spec
 * promises): the model is missing, or nothing has been asked of it yet.
 * Empty when there is nothing to say. */
export function smartCardNote(n: NodeCard, models: SmartModels | null): string {
  if (n.type !== "heeler.smart_mask" || !n.enabled) return "";
  const mode = n.textParams?.mode || "click";
  if (smartModelMissing(models, mode)) return "Model not installed: mask empty";
  if ((n.textParams?.model ?? "") !== "") return "";
  if (mode === "subject" || mode === "sky") return "Not detected yet: Detect in the Inspector";
  if ((n.textParams?.prompts || "[]") === "[]") return "No clicks yet: mask empty";
  return "";
}
