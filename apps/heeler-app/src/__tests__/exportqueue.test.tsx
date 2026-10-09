// The export queue: batch groups as tabs, each with its own settings.
//
// "We could have a scroll list, where a user can queue
// images for export... right click (or use the Photo menu) to add
// images... able to re-order and remove... the images don't need to
// have all the same export settings... what we can have is a tab of
// batch groups... Create a new tab to create a new batch [group] that
// will all share different export settings. The tabs can be renamed."

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useReducer } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { initialState } from "../data";
import { reduce, type State } from "../state";
import { App } from "../app";
import { ExportPanel } from "../ui/exportpanel";
import { mockExportedLog, mockResetExports, mockSetExportFolder } from "../bridge";
import { quickExport } from "../export";
import { chooseWith, menuRows } from "./menuhelp";

const run = (s: State, cmd: Parameters<typeof reduce>[1]) => reduce(s, cmd);

beforeEach(() => mockResetExports());

describe("the queue's state", () => {
  it("adds to the active group, deduped, in arrival order", () => {
    let s = initialState();
    s = run(s, { type: "export_queue_add", ids: ["4866", "4867"] });
    s = run(s, { type: "export_queue_add", ids: ["4867", "4868"] });
    expect(s.exportQueue.groups[0].queued.map((p) => p.id)).toEqual(["4866", "4867", "4868"]);
    // Captured at add time: names ride with the queue, not the view.
    expect(s.exportQueue.groups[0].queued[0].name).toBe("DSC_04866.NEF");
  });

  it("reorders and removes within the active group", () => {
    let s = initialState();
    s = run(s, { type: "export_queue_add", ids: ["a", "b", "c"] });
    s = run(s, { type: "export_queue_move", from: 2, to: 0 });
    const ids = () => s.exportQueue.groups[0].queued.map((p) => p.id);
    expect(ids()).toEqual(["c", "a", "b"]);
    // Out-of-range moves are a no-op, not a crash.
    s = run(s, { type: "export_queue_move", from: 5, to: 0 });
    expect(ids()).toEqual(["c", "a", "b"]);
    s = run(s, { type: "export_queue_remove", id: "a" });
    expect(ids()).toEqual(["c", "b"]);
  });

  it("each tab keeps its own settings and its own queue", () => {
    let s = initialState();
    s = run(s, { type: "export_queue_add", ids: ["one"] });
    s = run(s, { type: "export_group_settings", settings: { format: "tiff" } });
    s = run(s, { type: "export_group_new" });
    // The new tab is active, empty, and back at defaults.
    expect(s.exportQueue.active).toBe(1);
    expect(s.exportQueue.groups[1].queued).toEqual([]);
    expect(s.exportQueue.groups[1].settings.format).toBe("jpeg");
    s = run(s, { type: "export_queue_add", ids: ["two"] });
    s = run(s, { type: "export_group_settings", settings: { format: "png16" } });
    // The first tab kept everything.
    expect(s.exportQueue.groups[0].queued.map((p) => p.id)).toEqual(["one"]);
    expect(s.exportQueue.groups[0].settings.format).toBe("tiff");
    expect(s.exportQueue.groups[1].settings.format).toBe("png16");
  });

  it("new batches inherit the saved export defaults", () => {
    let s = run(initialState(), {
      type: "set_prefs",
      prefs: {
        exportDefaultFormat: "tiff",
        exportTemplate: "client-{n}",
        exportKeepMetadata: false,
        quickQuality: 84,
        quickResize: "edge",
        quickEdge: 3000,
      },
    });
    s = run(s, { type: "export_group_new" });
    expect(s.exportQueue.groups[1].settings).toMatchObject({
      format: "tiff",
      template: "client-{n}",
      keepMetadata: false,
      quality: 84,
      maxEdge: 3000,
    });
  });

  it("renames, and removal never leaves zero tabs", () => {
    let s = initialState();
    s = run(s, { type: "export_group_rename", index: 0, name: "  Client picks  " });
    expect(s.exportQueue.groups[0].name).toBe("Client picks");
    s = run(s, { type: "export_group_new" });
    s = run(s, { type: "export_group_remove", index: 1 });
    expect(s.exportQueue.groups).toHaveLength(1);
    expect(s.exportQueue.active).toBe(0);
    // Deleting the only tab starts over with a brand-new batch, not the
    // old tab with its photos shaken out. "I should be able to
    // delete the first batch which just creates a new batch tab."
    s = run(s, { type: "export_queue_add", ids: ["x"] });
    s = run(s, { type: "export_group_settings", settings: { format: "tiff" } });
    s = run(s, { type: "export_group_remove", index: 0 });
    expect(s.exportQueue.groups).toHaveLength(1);
    expect(s.exportQueue.groups[0].queued).toEqual([]);
    expect(s.exportQueue.groups[0].name).toBe("Batch 1");
    expect(s.exportQueue.groups[0].settings.format).toBe("jpeg");
    expect(s.exportQueue.groups[0].folder).toBeNull();
  });

  it("each tab keeps its own output folder", () => {
    // "when I set the output folder in one batch, it is
    // applied to another batch. I don't like that."
    let s = initialState();
    s = run(s, { type: "export_group_folder", folder: "D:/web" });
    s = run(s, { type: "export_group_new" });
    expect(s.exportQueue.groups[1].folder).toBeNull();
    s = run(s, { type: "export_group_folder", folder: "D:/archive" });
    expect(s.exportQueue.groups[0].folder).toBe("D:/web");
    expect(s.exportQueue.groups[1].folder).toBe("D:/archive");
  });

  it("a saved queue loads back validated, a damaged one falls to defaults", () => {
    let s = initialState();
    s = run(s, {
      type: "export_queue_load",
      queue: {
        groups: [
          // No folder field at all, as a blob saved before folders
          // existed would be: the load fills it as null.
          // A blob from before the queue carried records: bare ids.
          { id: "g1", name: "Web", imageIds: ["4866"], settings: { format: "png16" } } as never,
        ],
        active: 9,
      },
    });
    expect(s.exportQueue.groups[0].name).toBe("Web");
    expect(s.exportQueue.groups[0].settings.format).toBe("png16");
    // Missing settings fields fill from defaults; a wild active clamps.
    expect(s.exportQueue.groups[0].settings.quality).toBe(92);
    expect(s.exportQueue.groups[0].folder).toBeNull();
    expect(s.exportQueue.groups[0].queued[0]).toEqual({ id: "4866", name: "4866", stars: 0, flag: "" });
    expect(s.exportQueue.active).toBe(0);
    const before = s.exportQueue;
    s = run(s, { type: "export_queue_load", queue: { groups: [], active: 0 } });
    expect(s.exportQueue).toBe(before);
  });
});

describe("the queue's panel", () => {
  const openState = (mutate?: (s: State) => State) => {
    let s = { ...initialState(), exportOpen: true };
    if (mutate) s = mutate(s);
    return s;
  };

  it("shows tabs, tiles, and the DNG format; controls dispatch the right commands", async () => {
    const user = userEvent.setup();
    const sent: Parameters<typeof reduce>[1][] = [];
    const s = openState((s0) => {
      let s1 = run(s0, { type: "export_queue_add", ids: ["4866", "4867"] });
      s1 = run(s1, { type: "export_group_new" });
      s1 = run(s1, { type: "export_group_select", index: 0 });
      return s1;
    });
    render(<ExportPanel state={s} dispatch={(c) => sent.push(c)} />);

    expect(screen.getByTestId("export-tab-0")).toHaveTextContent("Batch 12");
    expect(screen.getByTestId("export-tab-1")).toHaveTextContent("Batch 2");
    // The format list is a dropdown now ("Instead of 6
    // buttons just make it a dropdown menu"), DNG among the options.
    expect(within(screen.getByTestId("export-format")).getByText("Linear DNG")).toBeInTheDocument();
    expect(screen.getByTestId("export-count").textContent).toContain("queued in Batch 1");

    const first = screen.getByTestId("export-queue-item-4866");
    expect(within(first).getByText("DSC_04866.NEF")).toBeInTheDocument();
    expect(screen.getByTestId("export-queue-up-4866")).toBeDisabled();

    await user.click(screen.getByTestId("export-queue-down-4866"));
    expect(sent[sent.length - 1]).toEqual({ type: "export_queue_move", from: 0, to: 1 });
    await user.click(screen.getByTestId("export-queue-remove-4867"));
    expect(sent[sent.length - 1]).toEqual({ type: "export_queue_remove", id: "4867" });
    await user.click(screen.getByTestId("export-tab-new"));
    expect(sent[sent.length - 1]).toEqual({ type: "export_group_new" });
    await user.click(screen.getByTestId("export-tab-remove"));
    expect(sent[sent.length - 1]).toEqual({ type: "export_group_remove", index: 0 });

    // Double-click opens the rename field; Enter commits it.
    await user.dblClick(screen.getByTestId("export-tab-0"));
    const field = screen.getByTestId("export-tab-rename");
    await user.clear(field);
    await user.type(field, "Prints{Enter}");
    expect(sent[sent.length - 1]).toEqual({ type: "export_group_rename", index: 0, name: "Prints" });
  });

  it("editing a control writes the active group's settings", async () => {
    const user = userEvent.setup();
    const sent: Parameters<typeof reduce>[1][] = [];
    render(<ExportPanel state={openState()} dispatch={(c) => sent.push(c)} />);
    await chooseWith(user, screen.getByTestId("export-format"), "tiff");
    const cmd = sent[sent.length - 1] as { type: string; settings: { format: string } };
    expect(cmd.type).toBe("export_group_settings");
    expect(cmd.settings.format).toBe("tiff");
  });

  it("an empty queue explains itself and falls back to the selection", () => {
    const s = openState();
    render(<ExportPanel state={s} dispatch={() => {}} />);
    expect(screen.getByText(/right-click a thumbnail/i)).toBeInTheDocument();
    // The sample state has an active image: the count is the fallback.
    expect(screen.getByTestId("export-count").textContent).not.toContain("queued");
  });

  /// Saving a preset spreads the WHOLE settings object, matte included,
  /// but applying one used to set only the five oldest fields: a matted
  /// preset came back with whatever matte the tab happened to have.
  it("a preset round-trips the matte setting", async () => {
    const user = userEvent.setup();
    const seeded = run(openState(), {
      type: "export_group_settings",
      settings: { format: "png", matte: true },
    });
    function Harness() {
      const [s, d] = useReducer(reduce, seeded);
      return <ExportPanel state={s} dispatch={d} />;
    }
    render(<Harness />);
    expect(screen.getByTestId("export-matte")).toHaveTextContent("Transparent");

    await user.click(screen.getByTestId("export-save-preset"));
    await user.type(screen.getByTestId("export-preset-name"), "Matted{Enter}");

    await user.click(screen.getByTestId("export-matte"));
    expect(screen.getByTestId("export-matte")).toHaveTextContent("Opaque");

    const select = screen.getByTestId("export-preset");
    await chooseWith(user, select, menuRows(select).find(([, label]) => label === "Matted")![0]);
    expect(screen.getByTestId("export-matte")).toHaveTextContent("Transparent");
  });
});

describe("running the batch", () => {
  it("wears the same solid accent as the top bar's quick export", () => {
    // "It's just that the quick export is a solid color, just
    // seems like the 'Export #' button(s) in the export view should follow
    // the same." They are the two doors onto one errand, and once the
    // segmented controls stopped spending the solid accent on "this option
    // is picked", it was free to mean only this: the button that writes
    // files. Same class, so they cannot drift apart.
    let s = { ...initialState(), exportOpen: true };
    s = run(s, { type: "export_queue_add", ids: ["4866"] });
    render(<ExportPanel state={s} dispatch={() => {}} />);
    const button = screen.getByTestId("export-run");
    expect(button).toHaveClass("btn-export");
    // Nothing left inline that would repaint it: the old version set
    // its own accent lettering and a dim border.
    const style = button.getAttribute("style") ?? "";
    expect(style).not.toContain("border-color");
    expect(style).not.toContain("color:");
  });


  it("a batch with no folder asks for one, remembers it, and exports", async () => {
    // "I am trying to run the batch export and nothing is
    // happening." The folder-less button used to disable and dead-end; now
    // the click asks where to write and gets on with it.
    mockSetExportFolder("D:/out");
    const user = userEvent.setup();
    const sent: Parameters<typeof reduce>[1][] = [];
    let s = { ...initialState(), exportOpen: true };
    s = run(s, { type: "export_queue_add", ids: ["4866", "4867"] });
    render(<ExportPanel state={s} dispatch={(c) => sent.push(c)} />);
    const button = screen.getByTestId("export-run");
    expect(button).toBeEnabled();
    await user.click(button);
    await waitFor(() => expect(mockExportedLog()).toHaveLength(2));
    expect(mockExportedLog()[0].dest.replace(/\\/g, "/")).toContain("D:/out");
    expect(sent).toContainEqual({ type: "export_group_folder", folder: "D:/out" });
  });

  it("canceling the folder picker cancels the run quietly", async () => {
    const user = userEvent.setup();
    let s = { ...initialState(), exportOpen: true };
    s = run(s, { type: "export_queue_add", ids: ["4866"] });
    render(<ExportPanel state={s} dispatch={() => {}} />);
    await user.click(screen.getByTestId("export-run"));
    expect(mockExportedLog()).toHaveLength(0);
  });
});

describe("quick export, no queue involved", () => {
  it("takes the selection straight to a picked folder", async () => {
    // "how do I quick export a selecting image without
    // having to add it to a queue?"
    mockSetExportFolder("D:/quick");
    const s = { ...initialState(), imageSelection: ["4866", "4867"] };
    await quickExport(s as State);
    expect(mockExportedLog().map((e) => e.imageId)).toEqual(["4866", "4867"]);
    expect(mockExportedLog()[0].dest.replace(/\\/g, "/")).toContain("D:/quick");
  });

  it("falls back to the active photo, and a canceled picker exports nothing", async () => {
    mockSetExportFolder("D:/quick");
    await quickExport(initialState());
    expect(mockExportedLog().map((e) => e.imageId)).toEqual(["4871"]);
    mockResetExports(); // picker back to answering nothing
    await quickExport({ ...initialState(), imageSelection: ["4866"] });
    expect(mockExportedLog()).toHaveLength(0);
  });

  it("is offered from the Photo menu and the thumbnail menu", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByTestId("menu-photo"));
    expect(screen.getByTestId("menu-photo-quick-export")).toBeEnabled();
    await user.keyboard("{Escape}");
    const thumbs = screen.getAllByTestId(/^thumb-\d+$/);
    fireEvent.contextMenu(thumbs[0]);
    expect(screen.getByTestId("thumb-menu-quick-export")).toBeInTheDocument();
  });
});

describe("the queue's entry points", () => {
  it("the Photo menu queues the active photo and opens the panel", async () => {
    const user = userEvent.setup();
    render(<App />);
    expect(screen.queryByTestId("export-panel")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("menu-photo"));
    await user.click(screen.getByTestId("menu-photo-export-queue"));
    expect(await screen.findByTestId("export-panel")).toBeInTheDocument();
    // The active image landed as a tile.
    await waitFor(() =>
      expect(screen.getByTestId("export-queue-list").children.length).toBeGreaterThan(0)
    );
    expect(screen.getByTestId("export-count").textContent).toContain("queued in");
  });
});
