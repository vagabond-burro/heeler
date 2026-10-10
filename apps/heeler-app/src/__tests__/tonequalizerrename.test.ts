// Relight became Tone Equalizer in 2026.5.1 (the owner, 2026-10-10:
// "rename Relight to Tone Equalizer"), after people looking for Adobe's
// depth relight found a tone equalizer under that name. What a photograph
// or the settings file saved under the old name carries over.
import { describe, expect, it } from "vitest";
import { initialState } from "../data";
import { migrateGraph, reduce, sectionExportId, type State } from "../state";
import { searchNodes } from "../nodes";

const toneEq = (s: State) => s.nodes.find((n) => n.type === "heeler.tone_eq");

describe("Relight is Tone Equalizer", () => {
  it("a saved node under the old default name takes the new one; a name somebody chose stays", () => {
    const s = reduce(initialState(), { type: "set_category", title: "Tone Equalizer", on: true });
    const base = toneEq(s)!;
    const graph = (name: string) =>
      migrateGraph(s.nodes.map((n) => (n.id === base.id ? { ...n, name } : n)), s.wires).nodes.find((n) => n.id === base.id)!;
    expect(graph("Relight").name).toBe("Tone Equalizer");
    expect(graph("Sky lift").name).toBe("Sky lift");
    expect(graph("Tone Equalizer").name).toBe("Tone Equalizer");
  });

  it("a pinned or hidden Relight section stays pinned or hidden under its new name", () => {
    const s = reduce(initialState(), { type: "set_prefs", prefs: { pinnedSections: ["Relight", "Curves"], hiddenSections: ["Relight", "Tone Equalizer"] } });
    expect(s.prefs.pinnedSections).toEqual(["Tone Equalizer", "Curves"]);
    expect(s.prefs.hiddenSections).toEqual(["Tone Equalizer"]);
  });

  it("keeps the section's export id, so a photograph exporting it stays linked", () => {
    expect(sectionExportId("Tone Equalizer")).toBe("dev_x_relight");
    expect(sectionExportId("Tone Equalizer", "layer_1")).toBe("dev_x_layer_1_relight");
    expect(sectionExportId("Depth Map")).toBe("dev_x_depth_map");
  });

  it("searching relight finds Depth Lighting, the tool that relights a scene by depth", () => {
    expect(searchNodes("relight").map((n) => n.name)).toContain("Depth Lighting");
    expect(searchNodes("tone equalizer").map((n) => n.name)).toContain("Tone Equalizer");
  });
});
