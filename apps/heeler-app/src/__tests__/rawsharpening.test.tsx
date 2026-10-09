// 2026-09-29: "I think Sharpening is fine for the name. Tested on
// Windows and I think its in a acceptable range for sharpness. I think
// the global default should be defined in Preferences > Import & Files,
// right below RAW default profile. Also, I noticed we have 'Tether
// session defaults' in that same preferences tab. Tether is hidden right
// now, so should this."

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { initialState } from "../data";
import { loadUiSettings, saveUiSettings } from "../bridge";
import { setExperimentalForTests, setPreviewBuildForTests } from "../features";
import { uiSettingsCommands, uiSettingsSnapshot } from "../settings";
import { reduce, type Command, type State } from "../state";
import { Preferences } from "../ui/preferences";

const run = (s: State, ...cmds: Command[]) => cmds.reduce(reduce, s);
const entry = (id: string, name: string, extra: Partial<State["images"][number]> = {}) =>
  ({ id, name, stars: 0, edited: false, flag: "", ...extra }) as State["images"][number];
const source = (s: State) => s.nodes.find((n) => n.type === "heeler.image_source")!;

afterEach(() => {
  cleanup();
  setPreviewBuildForTests(null);
  setExperimentalForTests(null);
});

function open(prefs: Partial<State["prefs"]> = {}, base: State = initialState()) {
  const sent: Command[] = [];
  const state = run(base, { type: "open_prefs" }, { type: "set_prefs", prefs });
  render(<Preferences state={state} dispatch={((c: Command) => sent.push(c)) as never} />);
  return { sent, state };
}

const importRows = () =>
  Array.from(document.querySelectorAll<HTMLElement>('[data-testid="prefs-panel-import"] [data-pref-row]')).map(
    (row) => row.dataset.prefRow,
  );

describe("the RAW default sharpening preference", () => {
  it("sits right after RAW default profile and offers the Source section's four choices", () => {
    const { sent } = open();
    fireEvent.click(screen.getByTestId("prefs-tab-import"));
    const rows = importRows();
    expect(rows.indexOf("raw-sharpening")).toBe(rows.indexOf("raw-profile") + 1);
    expect(screen.getByTestId("prefs-row-raw-sharpening")).toHaveTextContent("RAW default sharpening");
    expect(screen.getByTestId("prefs-raw-sharpening")).toHaveAttribute("data-value", "standard");
    fireEvent.click(screen.getByTestId("prefs-raw-sharpening"));
    for (const level of ["off", "low", "standard", "high"]) {
      expect(screen.getByTestId(`prefs-raw-sharpening-option-${level}`)).toBeInTheDocument();
    }
    fireEvent.click(screen.getByTestId("prefs-raw-sharpening-option-high"));
    expect(sent).toContainEqual({ type: "set_ui_setting", key: "rawSharpening", value: "high" });
  });

  it("is found by the settings search", () => {
    open();
    fireEvent.change(screen.getByTestId("prefs-search"), { target: { value: "capture sharpening" } });
    fireEvent.click(screen.getByTestId("prefs-search-result-raw-sharpening"));
    expect(screen.getByTestId("prefs-panel-import")).toBeInTheDocument();
  });

  it("survives a relaunch through the app settings, and repairs an unknown value to Standard", async () => {
    expect(initialState().rawSharpening).toBe("standard");
    const changed = run(initialState(), { type: "set_ui_setting", key: "rawSharpening", value: "low" });
    await saveUiSettings(JSON.stringify(uiSettingsSnapshot(changed)));
    let restored = initialState();
    for (const command of uiSettingsCommands(await loadUiSettings())) restored = reduce(restored, command);
    expect(restored.rawSharpening).toBe("low");
    let repaired = initialState();
    for (const command of uiSettingsCommands(JSON.stringify({ rawSharpening: "extreme" }))) repaired = reduce(repaired, command);
    expect(repaired.rawSharpening).toBe("standard");
  });

  it("writes the chosen value into a newly imported RAW's source node", () => {
    for (const level of ["off", "low", "standard", "high"]) {
      const s = run(
        initialState(),
        { type: "set_ui_setting", key: "rawSharpening", value: level },
        { type: "load_images", images: [entry("r1", "IMG_0101.RW2")] },
      );
      expect(source(s).textParams?.sharpening).toBe(level);
    }
  });

  it("gives a rendered file, a bake and a merge nothing", () => {
    for (const image of [
      entry("j1", "IMG_0100.jpg"),
      entry("t1", "IMG_0100.tif"),
      entry("b1", "IMG_0100_baked.dng", { renderedBake: true }),
      entry("i1", "IMG_6991.DNG", { phoneRendered: true }),
      entry("p1", "Harbor.pano"),
    ]) {
      const s = run(
        initialState(),
        { type: "set_ui_setting", key: "rawSharpening", value: "high" },
        { type: "load_images", images: [image] },
      );
      expect(source(s).textParams?.sharpening).toBeUndefined();
    }
  });

  it("never changes a photograph that already has a graph", () => {
    let s = run(initialState(), {
      type: "load_images",
      images: [entry("r1", "IMG_0101.RW2"), entry("r2", "IMG_0102.RW2")],
    });
    s = run(s, { type: "set_text_param", id: source(s).id, param: "sharpening", value: "low" });
    s = run(s, { type: "select_image", id: "r2" });
    expect(source(s).textParams?.sharpening).toBe("standard");
    // One saved before the control existed: absent, read as Standard.
    s = {
      ...s,
      nodes: s.nodes.map((n) => {
        if (n.type !== "heeler.image_source") return n;
        const { sharpening: _gone, ...rest } = n.textParams ?? {};
        return { ...n, textParams: rest };
      }),
    };
    s = run(s, { type: "set_ui_setting", key: "rawSharpening", value: "off" });
    s = run(s, { type: "select_image", id: "r1" });
    expect(source(s).textParams?.sharpening).toBe("low");
    s = run(s, { type: "select_image", id: "r2" });
    expect(source(s).textParams?.sharpening).toBeUndefined();
    // A photograph opened for the first time after the change takes it.
    s = run(s, { type: "load_images", images: [entry("r3", "IMG_0103.RW2")] });
    expect(source(s).textParams?.sharpening).toBe("off");
  });

  it("is where Reset Edits and the Source card's reset put a RAW back", () => {
    let s = run(
      initialState(),
      { type: "set_ui_setting", key: "rawSharpening", value: "high" },
      { type: "load_images", images: [entry("r1", "IMG_0101.RW2")] },
    );
    s = run(s, { type: "set_text_param", id: source(s).id, param: "sharpening", value: "off" });
    s = run(s, { type: "reset_image_edits", id: "r1" });
    expect(source(s).textParams?.sharpening).toBe("high");
    s = run(s, { type: "set_text_param", id: source(s).id, param: "sharpening", value: "off" });
    s = run(s, { type: "reset_node", id: source(s).id, values: {}, textValues: { highlights: "clip", demosaic: "standard", sharpening: "standard" } });
    expect(source(s).textParams?.sharpening).toBe("high");
  });
});

describe("the tether session defaults follow the Tether tab", () => {
  it("are absent, row and search result, while tethering is hidden", () => {
    // A shipped build: no tethering whatever the stored preference says.
    setPreviewBuildForTests(false);
    open({ experimentalFeatures: true });
    fireEvent.click(screen.getByTestId("prefs-tab-import"));
    expect(screen.queryByTestId("prefs-row-tether-defaults")).toBeNull();
    expect(importRows()).not.toContain("tether-defaults");
    fireEvent.change(screen.getByTestId("prefs-search"), { target: { value: "tether" } });
    expect(screen.queryByTestId("prefs-search-result-tether-defaults")).toBeNull();
  });

  it("are absent in a development build with experimental features off", () => {
    setPreviewBuildForTests(true);
    open({ experimentalFeatures: false });
    fireEvent.click(screen.getByTestId("prefs-tab-import"));
    expect(screen.queryByTestId("prefs-row-tether-defaults")).toBeNull();
    fireEvent.change(screen.getByTestId("prefs-search"), { target: { value: "polling interval" } });
    expect(screen.queryByTestId("prefs-search-result-tether-defaults")).toBeNull();
  });

  it("are present and unchanged, after the sharpening row, when tethering is shown", () => {
    setPreviewBuildForTests(true);
    open({ experimentalFeatures: true });
    fireEvent.click(screen.getByTestId("prefs-tab-import"));
    expect(importRows()).toEqual(["raw-profile", "raw-sharpening", "tether-defaults"]);
    expect(screen.getByTestId("prefs-tether-poll")).toBeInTheDocument();
    expect(screen.getByTestId("prefs-tether-pattern")).toBeInTheDocument();
    fireEvent.change(screen.getByTestId("prefs-search"), { target: { value: "polling interval" } });
    expect(screen.getByTestId("prefs-search-result-tether-defaults")).toBeInTheDocument();
  });
});
