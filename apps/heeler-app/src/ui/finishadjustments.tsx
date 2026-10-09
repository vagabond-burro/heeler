// One control surface for a Finish adjustment and its Graph node.
import { useEffect, useState } from "react";
import type { Command, NodeCard, State } from "../state";
import { ART_KINDS, curveModeOf, hardRange, paramRange } from "../state";
import { nodeThumbs, serializeGraph } from "../bridge";
import { CurveEditor, Wheel } from "./editors";
import { LevelsEditor } from "./levels";
import { paramDefault } from "./simple";
import { BwControls } from "./bwcontrols";
import { TrackSlider, ValueField } from "./track";

type D = React.Dispatch<Command>;

/** The input, decoded to scene light before the operation, renders as a
 * correctly encoded thumbnail. A full-stack preview would count edits
 * above this layer. In a browser without the engine there is no underlay. */
export function finishHistogramNode(state: State, id: string): string | undefined {
  return serializeGraph(state).connections.find(w => w.to[0] === id && w.to[1] === "in")?.from[0];
}
function useInputHistogram(state: State | undefined, node: NodeCard) {
  const [frame, setFrame] = useState<string>();
  const input = state && ["heeler.curves", "heeler.levels"].includes(node.type) ? finishHistogramNode(state, node.id) : undefined;
  useEffect(() => {
    setFrame(undefined);
    if (!state || !input) return;
    let live = true;
    const timer = window.setTimeout(() => {
      void nodeThumbs(state, [input]).then(frames => { if (live) setFrame(frames?.[input]); });
    }, 300);
    return () => { live = false; window.clearTimeout(timer); };
  }, [input, state?.activeImage, state?.renderVersion]);
  return frame;
}

const labels: Record<string, string> = {
  temperature: "Temp", tint: "Tint", saturation: "Saturation", vibrance: "Vibrance",
  exposure: "Exposure", contrast: "Luminance", color_contrast: "Chroma", highlights: "Highlights", shadows: "Shadows", whites: "Whites", blacks: "Blacks",
  black: "Black point", white: "White point", gamma: "Gamma", black_soft: "Black falloff", white_soft: "White falloff",
};
const tips: Record<string, string> = {
  exposure: "Brightens or darkens the picture in stops", contrast: "Steepens or softens tonal contrast while keeping hue", color_contrast: "Separates or brings together color channels while keeping luminance",
  highlights: "Lifts or recovers bright tones", shadows: "Lifts or deepens dark tones", whites: "Moves the brightest tones", blacks: "Lifts or deepens the darkest tones",
  temperature: "Warms or cools the picture", tint: "Moves the white balance between green and magenta", saturation: "Strengthens or reduces all colors", vibrance: "Strengthens muted colors more than saturated colors",
  black: "Sets where dark tones reach black", white: "Sets where bright tones reach white", gamma: "Brightens or darkens the tones between the endpoints", black_soft: "Softens the transition into black", white_soft: "Softens the transition into white",
};
export function FinishAdjustmentControls({ node, state, dispatch, carrierId, width = 248 }: { node: NodeCard; state?: State; dispatch: D; carrierId?: string; width?: number }) {
  const histogramSrc = useInputHistogram(state, node);
  const kind = ART_KINDS[node.artKind ?? ""];
  const names = kind?.show ?? Object.keys(node.params);
  const reset = () => dispatch({ type: "set_params", id: node.id, values: Object.fromEntries(names.map(p => [p, paramDefault(p, node.type)])) });
  if (node.type === "heeler.invert") return null;
  return <div data-testid={`finish-adjustment-${node.id}`} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
    {node.type === "heeler.curves" ? <CurveEditor node={node} dispatch={dispatch} width={width} channelMode={state ? curveModeOf(state) : "rgb"} clipboard={state?.curveClipboard} histogramSrc={histogramSrc} /> :
     node.type === "heeler.color_balance" ? <>
       <div style={{ display: "flex", gap: 8 }}>
         <Wheel name="Shadows" range="shadows" node={node} dispatch={dispatch} size={Math.floor((width - 16) / 3)} />
         <Wheel name="Mids" range="midtones" node={node} dispatch={dispatch} size={Math.floor((width - 16) / 3)} />
         <Wheel name="Highs" range="highlights" node={node} dispatch={dispatch} size={Math.floor((width - 16) / 3)} />
       </div>
       <button className="chip" data-testid="wheels-reset" style={{ fontSize: 11 }} onClick={() => dispatch({ type: "set_params", id: node.id, values: Object.fromEntries(["shadows", "midtones", "highlights"].flatMap(r => ["hue", "sat", "lum"].map(p => [`${r}_${p}`, 0]))) })}>Reset all</button>
     </> : node.type === "heeler.black_white" ? <BwControls bw={node} nodes={[]} dispatch={dispatch} width={width} /> : <>
       {node.type === "heeler.levels" && <LevelsEditor node={node} dispatch={dispatch} width={width} histogramSrc={histogramSrc} />}
       {names.map(param => {
         const [lo, hi] = paramRange(param, node.type), [hardLo, hardHi] = hardRange(param, node.type);
         const value = node.params[param] ?? paramDefault(param, node.type);
         const set = (value: number) => dispatch({ type: "set_param", id: node.id, param, value });
         return <div key={param} data-node={node.id} data-param={param} data-hint={tips[param]} style={{ display: "flex", alignItems: "center", gap: 7 }}>
           <span style={{ fontSize: 11, color: "var(--text-faint)", width: 78 }}>{labels[param] ?? param}</span>
           <div className="strack-flex" style={{ minWidth: 50 }} onDoubleClick={() => set(paramDefault(param, node.type))}>
             <TrackSlider label={labels[param] ?? param} lo={lo} hi={hi} value={value} testid={carrierId ? `art-param-${carrierId}-${param}` : `finish-param-${node.id}-${param}`} onChange={set}
               onBegin={() => dispatch({ type: "begin_gesture", key: `${node.id}.${param}` })} onEnd={() => dispatch({ type: "end_gesture" })} />
           </div>
           <div style={{ width: 44, flex: "none" }}><ValueField param={param} value={value} lo={hardLo} hi={hardHi} beyond={value < lo || value > hi} onCommit={set} /></div>
         </div>;
       })}
       <button className="chip" style={{ fontSize: 11, alignSelf: "flex-start" }} data-hint="Returns this adjustment's controls to their starting values" onClick={reset}>Reset</button>
     </>}
  </div>;
}
