// The print resolution an export declares (2026-10-06: "I think we are
// missing DPI settings for exports", then "make sure its in the quick
// export"): 300 unless set, in the export panel, its presets, the quick
// export menu and the quick export from a selection, and on the wire to
// both export commands.

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useReducer } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initialState } from "../data";
import { DEFAULT_EXPORT_SETTINGS, exportDpi, exportSettingsFromPrefs, reduce, type State } from "../state";
import { App } from "../app";
import { ExportPanel } from "../ui/exportpanel";
import { exportImage, exportTo, mockExportedLog, mockResetExports, mockSetExportFolder } from "../bridge";
import { quickExport } from "../export";
import { chooseWith, menuRows } from "./menuhelp";
import { handleApiAsync } from "../api";

const invoked = vi.hoisted(() => [] as [string, Record<string, unknown>][]);
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args: Record<string, unknown>) => {
    invoked.push([cmd, args]);
    return "written";
  },
}));

beforeEach(() => mockResetExports());
afterEach(() => {
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  invoked.length = 0;
});

describe("the resolution value", () => {
  it("is whole dots per inch a JPEG can store, 300 when unset or nonsense", () => {
    expect(exportDpi(undefined)).toBe(300);
    expect(exportDpi(null)).toBe(300);
    expect(exportDpi(Number.NaN)).toBe(300);
    expect(exportDpi(240.4)).toBe(240);
    expect(exportDpi(0)).toBe(1);
    expect(exportDpi(-5)).toBe(1);
    expect(exportDpi(1e9)).toBe(65535);
  });

  it("defaults to 300 and follows the quick export's preference", () => {
    expect(DEFAULT_EXPORT_SETTINGS.dpi).toBe(300);
    expect(initialState().prefs.quickDpi).toBe(300);
    expect(exportSettingsFromPrefs({}).dpi).toBe(300);
    expect(exportSettingsFromPrefs({ quickDpi: 150 }).dpi).toBe(150);
  });
});

describe("the quick export", () => {
  it("offers DPI in its menu and exports with it", async () => {
    const user = userEvent.setup();
    render(<App />);
    fireEvent.contextMenu(screen.getByTestId("btn-export"));
    const field = screen.getByTestId("quick-dpi") as HTMLInputElement;
    expect(field.value).toBe("300");
    fireEvent.change(field, { target: { value: "240" } });
    fireEvent.blur(field);
    expect((screen.getByTestId("quick-dpi") as HTMLInputElement).value).toBe("240");
    await user.click(screen.getByTestId("quick-export-jpg"));
    await waitFor(() => expect(mockExportedLog()).toHaveLength(1));
    expect(mockExportedLog()[0].dpi).toBe(240);
  });

  it("exports at 300 when nothing was set", async () => {
    render(<App />);
    fireEvent.click(screen.getByTestId("btn-export"));
    await waitFor(() => expect(mockExportedLog()).toHaveLength(1));
    expect(mockExportedLog()[0].dpi).toBe(300);
  });

  it("from a selection, takes the export panel's DPI with its other settings", async () => {
    // quickExport writes the selection with the active batch group's
    // settings, format and quality included, so its DPI is the panel's.
    mockSetExportFolder("D:/quick");
    let s = { ...initialState(), imageSelection: ["4866"] };
    s = reduce(s, { type: "export_group_settings", settings: { dpi: 72 } });
    await quickExport(s as State);
    expect(mockExportedLog().map((e) => e.dpi)).toEqual([72]);
  });
});

describe("the export panel", () => {
  function Harness({ seeded }: { seeded: State }) {
    const [s, d] = useReducer(reduce, seeded);
    return <ExportPanel state={s} dispatch={d} />;
  }

  it("sets the batch's DPI, and a preset keeps it", async () => {
    mockSetExportFolder("D:/out");
    const user = userEvent.setup();
    let s = { ...initialState(), exportOpen: true };
    s = reduce(s, { type: "export_queue_add", ids: ["4866"] });
    render(<Harness seeded={s} />);
    const field = () => screen.getByTestId("export-dpi") as HTMLInputElement;
    expect(field().value).toBe("300");
    fireEvent.change(field(), { target: { value: "150" } });
    fireEvent.blur(field());
    expect(field().value).toBe("150");

    await user.click(screen.getByTestId("export-save-preset"));
    await user.type(screen.getByTestId("export-preset-name"), "Print 150{Enter}");
    fireEvent.change(field(), { target: { value: "600" } });
    fireEvent.blur(field());
    const select = screen.getByTestId("export-preset");
    await chooseWith(user, select, menuRows(select).find(([, label]) => label === "Print 150")![0]);
    expect(field().value).toBe("150");

    await user.click(screen.getByTestId("export-run"));
    await waitFor(() => expect(mockExportedLog()).toHaveLength(1));
    expect(mockExportedLog()[0].dpi).toBe(150);
  });

  it("loads a preset saved before the setting at 300", async () => {
    const user = userEvent.setup();
    const s = { ...initialState(), exportOpen: true };
    render(<Harness seeded={s} />);
    fireEvent.change(screen.getByTestId("export-dpi"), { target: { value: "72" } });
    fireEvent.blur(screen.getByTestId("export-dpi"));
    // The starter presets predate the setting and carry no dpi.
    const select = screen.getByTestId("export-preset");
    await chooseWith(user, select, menuRows(select).find(([, label]) => label === "Web JPEG 2048")![0]);
    expect((screen.getByTestId("export-dpi") as HTMLInputElement).value).toBe("300");
  });
});

describe("the wire", () => {
  it("sends the DPI to both export commands, 300 when unset, clamped when wild", async () => {
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    await exportTo({}, "img", "D:/out/a.jpg", { format: "jpeg", quality: 90, maxEdge: null, dpi: 240 });
    await exportTo({}, "img", "D:/out/b.jpg", { format: "jpeg", quality: 90, maxEdge: null });
    await exportImage(initialState(), { format: "jpeg", quality: 90, maxEdge: null, keepMetadata: true, dpi: 1e9 });
    await exportImage(initialState(), { format: "png", quality: 90, maxEdge: null, keepMetadata: false });
    const dpis = invoked.filter(([cmd]) => cmd === "export_to" || cmd === "export_image").map(([cmd, a]) => [cmd, a.dpi]);
    expect(dpis).toEqual([
      ["export_to", 240],
      ["export_to", 300],
      ["export_image", 65535],
      ["export_image", 300],
    ]);
  });
});


describe("editing export numbers", () => {
  it("keeps a cleared quick DPI draft until the new number is committed", async () => {
    const user = userEvent.setup();
    render(<App />);
    fireEvent.contextMenu(screen.getByTestId("btn-export"));
    const field = screen.getByTestId("quick-dpi") as HTMLInputElement;
    await user.clear(field);
    expect(field.value).toBe("");
    await user.type(field, "240");
    expect(field.value).toBe("240");
    await user.tab();
    await user.click(screen.getByTestId("quick-export-png"));
    await waitFor(() => expect(mockExportedLog()).toHaveLength(1));
    expect(mockExportedLog()[0].dpi).toBe(240);
  });

  it("keeps a cleared panel DPI draft and ignores a blank commit", async () => {
    const user = userEvent.setup();
    function Harness() {
      const [s, d] = useReducer(reduce, { ...initialState(), exportOpen: true });
      return <ExportPanel state={s} dispatch={d} />;
    }
    render(<Harness />);
    const field = screen.getByTestId("export-dpi") as HTMLInputElement;
    await user.clear(field);
    expect(field.value).toBe("");
    await user.tab();
    expect(field.value).toBe("300");
    await user.clear(field);
    await user.type(field, "240.4");
    expect(field.value).toBe("240.4");
    await user.tab();
    expect(field.value).toBe("240");
  });

  it("lets the quick size be replaced without inserting one", async () => {
    const user = userEvent.setup();
    render(<App />);
    fireEvent.contextMenu(screen.getByTestId("btn-export"));
    await user.click(screen.getByText("px", { exact: true }));
    const field = screen.getByTestId("quick-size-value") as HTMLInputElement;
    await user.clear(field);
    expect(field.value).toBe("");
    await user.type(field, "2048");
    await user.tab();
    expect(field.value).toBe("2048");
  });
});


describe("scripting DPI", () => {
  it("carries custom and default DPI through app export.run", async () => {
    for (const [dpi, expected] of [[240, 240], [undefined, 300], [0, 1], [-5, 1], [240.4, 240], [1e9, 65535], [Number.NaN, 300]] as const) {
      mockResetExports();
      const s = initialState();
      const result = await handleApiAsync(s, () => {}, "export.run", {
        dir: "D:/script-out", ids: [s.images[0].id], format: "jpeg", dpi,
      });
      expect(result.error).toBeUndefined();
      expect(mockExportedLog()).toHaveLength(1);
      expect(mockExportedLog()[0].dpi).toBe(expected);
    }
  });
});


it("uses the same default and bounds for old preferences and queue groups", async () => {
  for (const raw of [undefined, null, Number.NaN, Infinity, -Infinity]) {
    expect(exportDpi(raw)).toBe(300);
    expect(exportSettingsFromPrefs({ quickDpi: raw as number }).dpi).toBe(300);
  }
  const s = initialState();
  const settings = { ...DEFAULT_EXPORT_SETTINGS };
  delete settings.dpi;
  s.exportQueue.groups[s.exportQueue.active].settings = settings;
  mockSetExportFolder("D:/old-queue");
  await quickExport(s);
  expect(mockExportedLog()).toHaveLength(1);
  expect(mockExportedLog()[0].dpi).toBe(300);
});
