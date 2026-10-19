// The exports' progress dialog (2026-10-17: "a progress dialog for
// exports (whether batch or quick export) similar to the stacking dialog
// would help"). Held here: an export reports under the "export" op and
// shows the bakes' modal dialog once its first report is half a second
// old, so a quick export flashes nothing and the time a save dialog was
// open does not count; the bar and stage follow the desktop's reports;
// Cancel reaches the desktop's registry and the quick export answers
// null; a batch names the photograph it has reached, stops on Cancel and
// still reports what it wrote. The desktop's half (stages, bands, Cancel
// between them) is a_watched_export_reports_its_stages_and_bands_and_stops_on_cancel.
//
// Every test builds its own state and reads only what it made.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initialState } from "../data";
import { BakeProgressDialog } from "../ui/opprogress";
import { BAKE_DIALOG_DELAY_MS, EXPORT_CANCELED, EXPORT_OP, beginOp, clearAllOps, clearOp, opCanceled, retitleOp, watchExport } from "../ui/opprogressparts";
import { mockResetOps } from "../bridge";
import { runExport } from "../export";
import { DEFAULT_EXPORT_SETTINGS } from "../state";

const bus = vi.hoisted(() => new Map<string, ((e: { payload: unknown }) => void)[]>());
vi.mock("@tauri-apps/api/event", () => ({
  emit: async (channel: string, payload: unknown) => {
    for (const fn of bus.get(channel) ?? []) fn({ payload });
  },
  listen: async (channel: string, fn: (e: { payload: unknown }) => void) => {
    const list = bus.get(channel) ?? [];
    list.push(fn);
    bus.set(channel, list);
    return () => bus.set(channel, (bus.get(channel) ?? []).filter((f) => f !== fn));
  },
}));
const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

async function report(done: number, total: number, message: string, id = "export-1") {
  const { emit } = await import("@tauri-apps/api/event");
  await act(async () => {
    await emit("heeler:progress", { op: EXPORT_OP, id, done, total, message });
  });
}

const wait = (ms: number) => act(() => new Promise((r) => setTimeout(r, ms)));

afterEach(() => {
  cleanup();
  clearAllOps();
  mockResetOps();
  bus.clear();
  invokeMock.mockReset();
  delete (window as any).__TAURI_INTERNALS__;
});

function tauri() {
  (window as any).__TAURI_INTERNALS__ = { invoke: invokeMock };
}

describe("an export under the progress dialog", () => {
  it("shows half a second after its first report, with its line, bar and stage", async () => {
    tauri();
    render(<BakeProgressDialog />);
    let land!: (v: string | null) => void;
    const done = watchExport("Exporting DSC00114", () => new Promise<string | null>((r) => (land = r)));
    // The save dialog stays open a while: nothing shows, nothing counts.
    await wait(BAKE_DIALOG_DELAY_MS + 50);
    expect(screen.queryByTestId("bake-dialog")).toBeNull();
    await report(0, 8000, "Reading the photograph");
    expect(screen.queryByTestId("bake-dialog"), "a quick export flashes nothing").toBeNull();
    await wait(BAKE_DIALOG_DELAY_MS + 50);
    await report(7500, 8000, "Rendering and writing the file");
    expect(screen.getByTestId("bake-dialog")).toHaveAttribute("aria-modal", "true");
    expect(screen.getByTestId("bake-dialog-title")).toHaveTextContent("Exporting DSC00114");
    expect(screen.getByTestId("bake-dialog-stage")).toHaveTextContent("Rendering and writing the file");
    expect(screen.getByTestId("bake-dialog-bar").style.width).toBe("94%");
    await act(async () => land("/out/DSC00114.jpg"));
    expect(await done).toBe("/out/DSC00114.jpg");
    expect(screen.queryByTestId("bake-dialog")).toBeNull();
  });

  it("cancels through the desktop's registry and answers null", async () => {
    tauri();
    render(<BakeProgressDialog />);
    let fail!: (e: unknown) => void;
    const done = watchExport("Exporting DSC00114", () => new Promise<string | null>((_, f) => (fail = f)));
    await report(0, 8000, "Reading the photograph");
    await wait(BAKE_DIALOG_DELAY_MS + 50);
    await report(2000, 8000, "Refining the depth map");
    fireEvent.click(screen.getByTestId("bake-dialog-cancel"));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("cancel_operation", { id: "export-1" }));
    await act(async () => fail(EXPORT_CANCELED));
    expect(await done).toBeNull();
  });

  it("reports a successful file when Cancel arrives after publication", async () => {
    tauri();
    render(<BakeProgressDialog />);
    let land!: (path: string) => void;
    const done = watchExport("Exporting DSC00114", () => new Promise<string>((r) => (land = r)));
    await report(7999, 8000, "Rendering and writing the file");
    await wait(BAKE_DIALOG_DELAY_MS + 50);
    fireEvent.click(screen.getByTestId("bake-dialog-cancel"));
    await act(async () => land("/out/DSC00114.jpg"));
    expect(await done).toBe("/out/DSC00114.jpg");
    expect(screen.queryByTestId("bake-dialog")).toBeNull();
  });

  it("a batch names its photograph, stops on Cancel and keeps what it wrote", async () => {
    tauri();
    const s = initialState();
    const images = s.images.slice(0, 3);
    let calls = 0;
    invokeMock.mockImplementation(async (cmd: string, args: { dest?: string }) => {
      if (cmd === "load_ui_graph") return { status: "absent" };
      if (cmd === "export_to") {
        calls += 1;
        if (calls === 2) {
          // Cancel pressed while the second photograph renders.
          const { emit } = await import("@tauri-apps/api/event");
          await emit("heeler:progress", { op: EXPORT_OP, id: "export-2", done: 100, total: 8000, message: "Reading the photograph" });
          throw EXPORT_CANCELED;
        }
        return args.dest ?? "out";
      }
      return null;
    });
    render(<BakeProgressDialog />);
    beginOp(EXPORT_OP, "Exporting 3 photographs");
    const result = await runExport(s, images, "/out", DEFAULT_EXPORT_SETTINGS, () => {});
    expect(opCanceled(EXPORT_OP)).toBe(false);
    clearOp(EXPORT_OP);
    expect(calls, "the third photograph never starts").toBe(2);
    expect(result.written).toHaveLength(1);
    expect(result.failed, "the canceled photograph is not a failure").toHaveLength(0);
  });

  it("names the photograph a batch has reached", async () => {
    tauri();
    render(<BakeProgressDialog />);
    beginOp(EXPORT_OP, "Exporting 3 photographs");
    retitleOp(EXPORT_OP, "Exporting DSC_04867.jpg, 2 of 3");
    await report(0, 8000, "Reading the photograph");
    await wait(BAKE_DIALOG_DELAY_MS + 50);
    await report(10, 8000, "Reading the photograph");
    expect(screen.getByTestId("bake-dialog-title")).toHaveTextContent("Exporting DSC_04867.jpg, 2 of 3");
    clearOp(EXPORT_OP);
  });
});
