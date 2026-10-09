// What "before" means: the photo as it opens fresh, wearing only the
// user's geometry. It used to be the raw decode plus crop, which
// skipped the default base rendering every fresh photo gets, so a
// zero-edit photo compared darker than itself in Split
// ("I have a photo with zero edits but when I turn on split the before
// gets darker").

import { describe, expect, it } from "vitest";
import { initialState } from "../data";
import { reduce, type Command, type State } from "../state";
import { serializeBeforeGraph, serializeFreshGraph } from "../bridge";

const run = (s: State, ...cmds: Command[]) => cmds.reduce(reduce, s);

type Ser = { nodes: { id: string; type: string; enabled: boolean; params: Record<string, unknown> }[] };

describe("the before graph", () => {
  it("is the fresh-open graph, edits shed, whatever the live graph carries", () => {
    let s = initialState();
    const exposure = s.nodes.find((n) => n.type === "heeler.exposure")!;
    const profile = s.nodes.find((n) => n.type === "heeler.tone_profile")!;
    s = run(
      s,
      { type: "set_param", id: exposure.id, param: "exposure", value: 1.4 },
      { type: "set_param", id: profile.id, param: "baseline_ev", value: 0.9 },
    );
    const before = serializeBeforeGraph(s, s.activeImage) as unknown as Ser;
    const fresh = serializeFreshGraph(s, s.activeImage) as unknown as Ser;
    const of = (g: Ser, type: string) => g.nodes.find((n) => n.type === type);
    // The edited exposure and profile do NOT ride along: before means
    // fresh, and at zero edits before equals after by construction.
    expect(of(before, "heeler.exposure")?.params).toEqual(of(fresh, "heeler.exposure")?.params);
    expect(of(before, "heeler.tone_profile")?.params).toEqual(
      of(fresh, "heeler.tone_profile")?.params,
    );
    // And the base rendering IS in the before graph at all: the old
    // miniature had no profile node to run.
    expect(of(before, "heeler.tone_profile")).toBeTruthy();
  });

  it("carries the live crop, so the panes stay aligned", () => {
    let s = initialState();
    const crop = s.nodes.find((n) => n.type === "heeler.crop_rotate")!;
    s = run(s, { type: "set_param", id: crop.id, param: "crop_w", value: 0.5 });
    const before = serializeBeforeGraph(s, s.activeImage) as unknown as Ser;
    const cropNode = before.nodes.find((n) => n.type === "heeler.crop_rotate");
    expect(cropNode?.params.crop_w).toBe(0.5);
  });
});
