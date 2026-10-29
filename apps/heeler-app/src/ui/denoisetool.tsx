// Noise Reduction's Model method: the runner that asks the desktop
// for the SCUNet answer at the preview tier whenever the section
// wants it, the consent card when the model is not installed, and
// the progress the section's status line reads. The full-frame run
// is minutes on the CPU and is asked for on purpose, from the
// section or by an export.

import { useEffect, useRef, useState } from "react";
import { denoiseMap, onDenoiseCacheChanged, onModelsChanged, onDenoiseProgress, smartModelDownload, smartModelStatus, type DenoiseProgress, type SmartModels } from "../bridge";
import { logMsg } from "../log";
import { reportToolError } from "./hints";
import { ModelConsentCard } from "./modelconsent";
import { publishBusy } from "./statusbarparts";
import { previewEdgeFor, type State } from "../state";
import { type D, denoiseMark, denoiseWanted, landed, publish, status, useDenoiseStatus, useFullDenoiseStatus } from "./denoisetoolparts";

export function DenoiseRunner({ state, dispatch }: { state: State; dispatch: D }) {
  const wanted = denoiseWanted(state);
  const { running, failed } = useDenoiseStatus();
  const mark = denoiseMark(state);
  const disk = useFullDenoiseStatus(state, wanted);
  const done = useRef<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [needModel, setNeedModel] = useState(false);
  const [models, setModels] = useState<SmartModels | null>(null);
  const [downloading, setDownloading] = useState(false);

  useEffect(() => onModelsChanged(() => {
    done.current = {};
    setNeedModel(false);
    publish({ ...status, ready: {}, failed: undefined });
  }), []);

  useEffect(() => onDenoiseCacheChanged((cleared) => {
    if (!cleared) return;
    done.current = {};
    publish({ ...status, ready: {}, failed: undefined });
  }), []);

  // The desktop's tile-by-tile progress, for the status line.
  useEffect(
    () =>
      onDenoiseProgress((p: DenoiseProgress) => {
        if (!status.running || status.running.imageId !== p.image_id) return;
        publishBusy(`DENOISE \u00b7 running the model ${p.full ? "at full size" : "on the preview"}`);
        publish({ ...status, running: { ...status.running, full: p.full, done: p.done, total: p.total, phase: "model" } });
      }),
    [],
  );

  useEffect(() => {
    if (!wanted || running || busy || needModel || done.current[mark] || failed === mark) return;
    // Wait while the disk is being asked, but never wait forever on a
    // question that failed: an errored check falls through to the run,
    // which surfaces the error or the consent card the way it always
    // did. Gating on the answer alone made a failed check a silent
    // refusal to compute anything.
    if (!disk) return;
    if (disk.value?.full) { done.current[mark] = true; landed(state, dispatch, true, "cached"); return; }
    // A drag is one compute, not one per frame.
    if (state.gesture !== null) return;
    setBusy(true);
    publishBusy("DENOISE \u00b7 checking the preview cache");
    publish({ ...status, running: { full: false, done: 0, total: 0, imageId: state.activeImage, phase: "checking" } });
    void denoiseMap(state, previewEdgeFor(state))
      .then((answer) => {
        done.current[mark] = true;
        landed(state, dispatch, false, answer.work, answer.tiles);
      })
      .catch((err) => {
        publish({ ...status, running: null });
        if (String(err).includes("model not installed")) {
          setNeedModel(true);
          void smartModelStatus().then(setModels).catch((err) => reportToolError("Models", err));
        } else {
          publish({ ...status, failed: mark });
          reportToolError("Noise Reduction", err);
        }
      })
      .finally(() => {
        publishBusy(null);
        setBusy(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted, mark, busy, needModel, state.gesture, running, failed, disk]);

  if (!wanted) return null;
  return (
    <>
      {needModel && models && (
        <ModelConsentCard
          title="NOISE REDUCTION'S MODEL METHOD NEEDS ITS MODEL"
          model={models.denoise}
          testid="denoise"
          downloading={downloading}
          onDownload={() => {
            setDownloading(true);
            void smartModelDownload("scunet_color_real_psnr")
              .then(() => {
                logMsg("info", "SCUNet installed");
                setNeedModel(false);
              })
              .catch((err) => reportToolError("Download", err))
              .finally(() => setDownloading(false));
          }}
        />
      )}
    </>
  );
}
