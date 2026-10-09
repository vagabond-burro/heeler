// Keep baked pictures in backups (2026-10-01: "I would say alert the
// user and give the choice to them. I would lean towards it being on by
// default. maybe even alert the user during bake that these take up more
// for backups"). The desktop half (a bundle with the switch off records
// the pictures by path and checksum only, and a lost one restores as a
// missing layer) is src-tauri/src/recovery.rs.
//
// Held here: the preference is on by default, persists and repairs; its
// switch sits in Preferences > Backup with outcome-first words; a bake or
// a copy with it on passes the dialog its line and says the real size in
// the status line, and with it off says nothing; a recovery report says
// its notes; a kept picture that is gone says so in its own words.
//
// Every test builds its own state and reads only what it made.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { initialState, NEUTRAL_NODES, NEUTRAL_WIRES } from "../data";
import { DEFAULT_PREFS, DOC_SEL_ID, artLayers, reduce, type Command, type State } from "../state";
import { bakeLayerCopy, bakeWarpLayer, loadUiSettings, saveUiSettings } from "../bridge";
import { uiSettingsCommands, uiSettingsSnapshot } from "../settings";
import { Preferences } from "../ui/preferences";
import { BAKED_BACKUP_HINTS, BAKE_DIALOG_BACKUP_LINE, bakeBackupNotice, megabytes } from "../bakedbackups";
import { runBakeWarp } from "../layeractions";
import { runCommand } from "../commands";
import { _clearFlashForTests, currentFlash } from "../ui/hints";
import { recoveryNote } from "../ui/catalogui";
import { ImageLayerControls, keptMissingLine } from "../ui/imagelayers";
import { noteFrameAspect } from "../imagelayers";

const BYTES = 184_123_456;

vi.mock("../bridge", async (importOriginal) => {
  const real = await importOriginal<typeof import("../bridge")>();
  return {
    ...real,
    bakeWarpLayer: vi.fn(async () => ({ path: "/kept/layercopies/00000000000000bb.tif", box: [0, 0, 1, 1], aspect: 1.5, width: 6000, height: 4000, bytes: 184_123_456 })),
    bakeLayerCopy: vi.fn(async () => ({ path: "/kept/layercopies/00000000000000aa.tif", box: [0.4, 0.35, 0.22, 0.31], aspect: 1.5, width: 1320, height: 1240, bytes: 6_543_210 })),
  };
});
// The dialog's words as the launchers hand them over.
const watched = vi.hoisted(() => [] as (string | undefined)[]);
vi.mock("../ui/opprogress", async (importOriginal) => {
  const real = await importOriginal<typeof import("../ui/opprogress")>();
  return {
    ...real,
    watchBake: (title: string, job: () => Promise<unknown>, note?: string) => {
      watched.push(note);
      return real.watchBake(title, job, note);
    },
  };
});

beforeEach(() => {
  vi.mocked(bakeWarpLayer).mockClear();
  vi.mocked(bakeLayerCopy).mockClear();
  watched.length = 0;
  _clearFlashForTests();
});
afterEach(() => {
  cleanup();
  _clearFlashForTests();
});

const run = (s: State, ...cmds: Command[]): State => cmds.reduce(reduce, s);

function fresh(keep: boolean): State {
  noteFrameAspect("baked_backups", 1.5);
  return run(
    {
      ...initialState(),
      activeImage: "baked_backups",
      mode: "simple",
      panelTab: "layers",
      nodes: structuredClone(NEUTRAL_NODES),
      wires: structuredClone(NEUTRAL_WIRES),
    },
    { type: "set_prefs", prefs: { keepBakedInBackups: keep } },
  );
}

describe("the preference", () => {
  it("is on by default", () => {
    expect(DEFAULT_PREFS.keepBakedInBackups).toBe(true);
    expect(initialState().prefs.keepBakedInBackups).toBe(true);
  });

  it("persists off through the app settings save path, and an unreadable value is on", async () => {
    await saveUiSettings(JSON.stringify(uiSettingsSnapshot(run(initialState(), { type: "set_prefs", prefs: { keepBakedInBackups: false } }))));
    let restored = initialState();
    for (const c of uiSettingsCommands(await loadUiSettings())) restored = reduce(restored, c);
    expect(restored.prefs.keepBakedInBackups).toBe(false);
    // The key the desktop reads (recovery.rs keeps_finish_pictures).
    expect(JSON.parse((await loadUiSettings())!).prefs.keepBakedInBackups).toBe(false);
    let repaired = initialState();
    for (const c of uiSettingsCommands(JSON.stringify({ prefs: { keepBakedInBackups: "no" } }))) repaired = reduce(repaired, c);
    expect(repaired.prefs.keepBakedInBackups).toBe(true);
  });

  it("is a switch in Preferences > Backup that says the outcome first", () => {
    const sent: Command[] = [];
    const state = run(initialState(), { type: "open_prefs" });
    const view = render(<Preferences state={state} dispatch={((c: Command) => sent.push(c)) as never} />);
    fireEvent.click(screen.getByTestId("prefs-tab-backup"));
    const toggle = screen.getByTestId("prefs-baked-backups");
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(toggle.getAttribute("data-hint")).toBe(BAKED_BACKUP_HINTS.on);
    expect(screen.getByText("Keep baked pictures in backups")).toBeInTheDocument();
    fireEvent.click(toggle);
    expect(sent).toContainEqual({ type: "set_prefs", prefs: { keepBakedInBackups: false } });
    view.unmount();
    const off = run(state, { type: "set_prefs", prefs: { keepBakedInBackups: false } });
    render(<Preferences state={off} dispatch={() => {}} />);
    fireEvent.click(screen.getByTestId("prefs-tab-backup"));
    expect(screen.getByTestId("prefs-baked-backups").getAttribute("data-hint")).toBe(BAKED_BACKUP_HINTS.off);
    expect(BAKED_BACKUP_HINTS.on).toMatch(/^Recovery bundles carry .* so a backup can restore those layers$/);
    expect(BAKED_BACKUP_HINTS.off).toMatch(/^Recovery bundles are smaller, but .* cannot come back$/);
  });
});

describe("the size a bake adds to each backup", () => {
  it("says megabytes the way a file browser counts them", () => {
    expect(megabytes(BYTES)).toBe("184 MB");
    expect(megabytes(6_543_210)).toBe("6.5 MB");
    expect(megabytes(40_000)).toBe("under 0.1 MB");
    expect(bakeBackupNotice("Bake Warp", BYTES, true)).toBe("Bake Warp: this picture adds about 184 MB to each recovery bundle (Preferences > Backup)");
    expect(bakeBackupNotice("Bake Warp", 40_000, true)).toBe("Bake Warp: this picture adds under 0.1 MB to each recovery bundle (Preferences > Backup)");
    expect(bakeBackupNotice("Bake Warp", BYTES, false)).toBeNull();
    expect(bakeBackupNotice("Bake Warp", undefined, true)).toBeNull();
  });

  for (const keep of [true, false]) {
    it(`Bake Warp ${keep ? "passes the dialog its line and states the file's size" : "says nothing with the pictures left out"}`, async () => {
      const s = run(fresh(keep), { type: "art_add_layer", kind: "warp" } as Command);
      const id = s.artActive!;
      let latest = s;
      runBakeWarp(s, (c) => void (latest = reduce(latest, c)), id);
      await waitFor(() => expect(artLayers(latest).find((l) => l.blend.id === id)!.content.type).toBe("heeler.file"));
      await waitFor(() => expect(watched).toHaveLength(1));
      expect(watched[0]).toBe(keep ? BAKE_DIALOG_BACKUP_LINE : undefined);
      if (keep) await waitFor(() => expect(currentFlash()).toBe("Bake Warp: this picture adds about 184 MB to each recovery bundle (Preferences > Backup)"));
      else {
        await new Promise((r) => setTimeout(r, 30));
        expect(currentFlash()).toBeNull();
      }
    });

    it(`New Layer via Copy ${keep ? "states its file's size" : "says nothing with the pictures left out"}`, async () => {
      const s = run(
        fresh(keep),
        { type: "set_select_method", method: "rect" } as Command,
        { type: "arm_document_selection" } as Command,
        { type: "add_region", id: DOC_SEL_ID, region: { kind: "marquee", op: "add", x0: 0.4, y0: 0.35, x1: 0.62, y1: 0.66 } } as unknown as Command,
      );
      const seen: Command[] = [];
      expect(runCommand("layer.via_copy", s, (c) => void seen.push(c as Command))).toBe(true);
      await waitFor(() => expect(seen.some((c) => c.type === "art_layer_via_copy")).toBe(true));
      expect(watched[0]).toBe(keep ? BAKE_DIALOG_BACKUP_LINE : undefined);
      if (keep) await waitFor(() => expect(currentFlash()).toBe("New Layer via Copy: this picture adds about 6.5 MB to each recovery bundle (Preferences > Backup)"));
      else {
        await new Promise((r) => setTimeout(r, 30));
        expect(currentFlash()).toBeNull();
      }
    });
  }
});

describe("what a restore without the picture shows", () => {
  it("the recovery report carries its notes", () => {
    const base = { path: "/b", complete: true, images: 1, graphs: 1, takes: 1, presets: 0, assets: 2, required_inputs: 0, app_version: "26.4.0", problems: [] };
    const note = "1 Layer via Copy or Bake Warp picture is not in this bundle (Keep baked pictures in backups is off): read where Heeler keeps it; a layer whose picture is lost comes back without it";
    expect(recoveryNote({ ...base, notes: [note] })).toContain(note);
    expect(recoveryNote(base)).toMatch(/Original files match their checksums\.$/);
  });

  it("a baked layer whose kept picture is gone says so, where it was, and why a backup may lack it", async () => {
    const gone = "/old/vision/layercopies/missing00000bb.tif";
    const s = run(fresh(false), { type: "art_add_layer", kind: "warp" } as Command);
    const id = s.artActive!;
    const baked = run(s, { type: "art_bake_warp", id, path: gone, box: { x: 0, y: 0, w: 1, h: 1 }, aspect: 1.5 });
    const layer = artLayers(baked).find((l) => l.blend.id === id)!;
    render(<ImageLayerControls layer={layer} active state={baked} dispatch={() => {}} />);
    const line = await screen.findByTestId(`art-image-missing-${id}`);
    expect(line.textContent).toBe(keptMissingLine(gone));
    expect(line.textContent).toMatch(/^The picture Heeler kept for this layer is missing\. It was at \/old\/vision\/layercopies\/missing00000bb\.tif\./);
    expect(screen.getByTestId(`art-image-choose-${id}`).getAttribute("aria-label")).toBe("Relink");
  });
});
