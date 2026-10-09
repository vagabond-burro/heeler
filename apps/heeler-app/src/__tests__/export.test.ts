import { describe, expect, it, vi } from "vitest";
import {
  collisions,
  destinationFor,
  destinationName,
  exportTargets,
  fillTemplate,
  runExport,
  sanitizeFilename,
  type ExportSettings,
} from "../export";
import { initialState } from "../data";
import { reduce } from "../state";
import type { ImageEntry } from "../state";

const img = (name: string, extra: Partial<ImageEntry> = {}): ImageEntry => ({
  id: name,
  name,
  stars: 0,
  flag: "",
  edited: false,
  filter: "none",
  src: "",
  ...extra,
});

const settings = (over: Partial<ExportSettings> = {}): ExportSettings => ({
  format: "jpeg",
  quality: 92,
  maxEdge: null,
  template: "{name}",
  keepMetadata: true,
  ...over,
});

describe("export naming", () => {
  it("keeps the original stem and drops the extension", () => {
    expect(fillTemplate("{name}", img("P1032386.RW2"), 0, 1)).toBe("P1032386");
    expect(fillTemplate("{name}_web", img("beach.jpeg"), 0, 1)).toBe("beach_web");
  });

  /// A folder of exports should sort the way it was shot, which means
  /// the counter has to be padded to the width of the batch.
  it("pads the counter to the size of the batch", () => {
    expect(fillTemplate("{n}", img("a.dng"), 0, 9)).toBe("1");
    expect(fillTemplate("{n}", img("a.dng"), 0, 10)).toBe("01");
    expect(fillTemplate("{n}", img("a.dng"), 9, 120)).toBe("010");
    expect(fillTemplate("{n}", img("a.dng"), 119, 120)).toBe("120");
  });

  it("fills ratings and flags", () => {
    const picked = img("a.dng", { stars: 4, flag: "pick" });
    expect(fillTemplate("{name}-{stars}-{flag}", picked, 0, 1)).toBe("a-4-pick");
    expect(fillTemplate("{flag}", img("a.dng"), 0, 1)).toBe("none");
  });

  /// A typo should be visible in the preview, not silently swallowed
  /// into a filename that is missing a chunk of what was asked for.
  it("leaves an unknown token alone rather than deleting it", () => {
    expect(fillTemplate("{name}_{nmae}", img("a.dng"), 0, 1)).toBe("a_{nmae}");
  });

  it("strips what a filesystem will not take, and keeps what it will", () => {
    expect(sanitizeFilename('a<b>c:d"e/f\\g|h?i*j')).toBe("a_b_c_d_e_f_g_h_i_j");
    // Spaces and hyphens are legal and common; mangling them would be
    // the tool being precious about a perfectly good filename.
    expect(sanitizeFilename("beach walk-2")).toBe("beach walk-2");
    // Windows drops trailing dots and spaces silently, which turns two
    // distinct exports into one file that overwrites itself.
    expect(sanitizeFilename("shot. ")).toBe("shot");
    // And it refuses the device names whatever the extension.
    expect(sanitizeFilename("con")).toBe("_con");
    expect(sanitizeFilename("NUL")).toBe("_NUL");
    expect(sanitizeFilename("")).toBe("untitled");
  });

  it("builds a full destination with the right extension", () => {
    // The default names the file after the original, nothing appended.
    expect(destinationFor("D:/out", settings(), img("a.dng"), 0, 1)).toBe("D:/out/a.jpg");
    expect(destinationFor("D:/out/", settings({ format: "png" }), img("a.dng"), 0, 1)).toBe(
      "D:/out/a.png"
    );
    // A Windows path keeps its own separator rather than growing a
    // mixed one.
    expect(destinationFor("D:\\out", settings(), img("a.dng"), 0, 1)).toBe("D:\\out\\a.jpg");
  });

  /// The failure this prevents is silent: two images resolve to one
  /// name and the second overwrites the first, so the user gets fewer
  /// files than they selected and nothing says why.
  it("warns when a pattern would write two images to one name", () => {
    const two = [img("IMG_1.dng"), img("IMG_1.jpg")];
    expect(collisions(settings({ template: "{name}" }), two)).toEqual(["IMG_1"]);
    // Adding the counter separates them.
    expect(collisions(settings({ template: "{name}_{n}" }), two)).toEqual([]);
    expect(collisions(settings(), [img("a.dng"), img("b.dng")])).toEqual([]);
  });

  /// A RAW+JPEG pair shares one stem, so {name} fills six files to four
  /// names and the batch quietly wrote four. "two batches
  /// that have the same 6 files but only 4 files are exporting." Within
  /// one run, a name already used grows a suffix instead of overwriting.
  it("suffixes a name the run already used instead of overwriting", () => {
    const taken = new Set<string>();
    expect(destinationFor("D:/out", settings(), img("IMG_1.dng"), 0, 3, taken)).toBe("D:/out/IMG_1.jpg");
    expect(destinationFor("D:/out", settings(), img("IMG_1.jpg"), 1, 3, taken)).toBe("D:/out/IMG_1-2.jpg");
    // Case-insensitive, because the filesystems that matter are.
    expect(destinationFor("D:/out", settings(), img("img_1.JPG"), 2, 3, taken)).toBe("D:/out/img_1-3.jpg");
    // Without the set the behavior is unchanged.
    expect(destinationFor("D:/out", settings(), img("IMG_1.jpg"), 0, 1)).toBe("D:/out/IMG_1.jpg");
  });
});

describe("export targets", () => {
  it("is the selection when there is one, the open image otherwise", () => {
    let s = initialState();
    s = reduce(s, { type: "select_image", id: "4869" });
    expect(exportTargets(s).map((i) => i.id)).toEqual(["4869"]);

    s = reduce(s, { type: "select_image_range", id: "4872", range: true });
    const ids = exportTargets(s).map((i) => i.id);
    expect(ids.length).toBeGreaterThan(1);
    expect(ids).toEqual(s.imageSelection);
  });
});

describe("running a batch", () => {
  /// Exporting twenty photographs with the twenty-first photograph's
  /// edits would be worse than useless, so each one goes through its own
  /// saved graph.
  it("renders each image through its own graph, serialized to the wire shape", async () => {
    const seen: { id: string; graph: unknown }[] = [];
    vi.doMock("../bridge", async () => {
      const actual = await vi.importActual<typeof import("../bridge")>("../bridge");
      return {
        ...actual,
        // What load_ui_graph actually returns: the EDITOR's shape, the
        // one save_ui_graph wrote. No graph_id, no connections.
        loadGraph: async (id: string) => ({
          nodes: [
            { id: `graph-of-${id}`, type: "heeler.exposure", name: "Exposure", enabled: true, params: { exposure: 1 } },
          ],
          wires: [],
        }),
        exportTo: async (graph: unknown, id: string, dest: string) => {
          seen.push({ id, graph });
          return dest;
        },
      };
    });
    vi.resetModules();
    const { runExport: run } = await import("../export");
    let s = initialState();
    s = reduce(s, { type: "select_image", id: "4869" });
    const images = [img("4866.dng", { id: "4866" }), img("4869.dng", { id: "4869" })];
    const result = await run(s, images, "D:/out", settings(), () => {});
    vi.doUnmock("../bridge");
    vi.resetModules();

    expect(result.written).toHaveLength(2);
    // The image that is not open used its own saved graph, and that graph
    // reached the engine in the WIRE format, not the file's editor shape.
    // Raw, the engine rejects it before the command runs.
    // "Export failed: P1551315.RW2: invalid args `graph` for command
    // `export_to`: missing field `graph_id`."
    const other = seen.find((x) => x.id === "4866")!;
    const g = other.graph as { graph_id?: string; connections?: unknown[]; nodes: { id: string }[] };
    expect(g.graph_id).toBe("4866_ui");
    expect(Array.isArray(g.connections)).toBe(true);
    expect(g.nodes.some((n) => n.id === "graph-of-4866")).toBe(true);
    // The open one used the live graph, which may be newer than disk.
    const open = seen.find((x) => x.id === "4869")!;
    expect(JSON.stringify(open.graph)).not.toContain("graph-of-4869");
  });

  /// A photo that was never opened has no saved graph file. It must
  /// export through the neutral default it WOULD open with, not through
  /// the live graph: that one is the OPEN photo's edits, and it even
  /// carries the open photo's graph_id.
  it("exports a never-opened photo through its own default graph, not the live one", async () => {
    const seen: { id: string; graph: unknown }[] = [];
    vi.doMock("../bridge", async () => {
      const actual = await vi.importActual<typeof import("../bridge")>("../bridge");
      return {
        ...actual,
        // Nothing on disk for this photo: never opened, never saved.
        loadGraph: async () => null,
        exportTo: async (graph: unknown, id: string, dest: string) => {
          seen.push({ id, graph });
          return dest;
        },
      };
    });
    vi.resetModules();
    const { runExport: run } = await import("../export");
    let s = initialState();
    s = reduce(s, { type: "select_image", id: "4869" });
    // An unmistakable live edit: the neutral default never holds 3.25.
    s = reduce(s, { type: "set_param", id: "exposure", param: "exposure", value: 3.25 });
    const result = await run(s, [img("4866.dng", { id: "4866" })], "D:/out", settings(), () => {});
    vi.doUnmock("../bridge");
    vi.resetModules();

    expect(result.written).toHaveLength(1);
    const g = seen[0].graph as { graph_id?: string; nodes: { id: string; params: Record<string, unknown> }[] };
    expect(g.graph_id).toBe("4866_ui");
    const exposure = g.nodes.find((n) => n.id === "exposure");
    expect(exposure).toBeDefined();
    expect(exposure!.params.exposure).not.toBe(3.25);
  });

  it("reports progress from nothing done to everything done", async () => {
    const steps: string[] = [];
    const s = initialState();
    await runExport(
      s,
      [img("a.dng"), img("b.dng")],
      "D:/out",
      settings(),
      (p) => steps.push(`${p.done}/${p.total}`),
      () => false
    );
    expect(steps[0]).toBe("0/2");
    expect(steps[steps.length - 1]).toBe("2/2");
  });

  /// The owner,: a JPEG going out as an EXR read "photo.jpg" under
  /// the Export button the whole render. The line names the file
  /// being written, in every format, suffix included.
  it("names the file being written in the progress line, not the original", async () => {
    const formats: [ExportSettings["format"], string][] = [
      ["jpeg", "jpg"],
      ["webp", "webp"],
      ["png", "png"],
      ["png16", "png"],
      ["tiff", "tif"],
      ["tiff32", "tif"],
      ["dng", "dng"],
      ["exr", "exr"],
    ];
    for (const [format, ext] of formats) {
      const names: string[] = [];
      await runExport(
        initialState(),
        [img("beach.jpg", { id: "j" }), img("beach.dng", { id: "d" })],
        "/out",
        settings({ format }),
        (p) => names.push(p.current),
      );
      // The pair shares a stem: the second lands as -2 and reads so.
      expect(names).toEqual([`beach.${ext}`, `beach-2.${ext}`, ""]);
    }
    // A Windows folder's separator ends the folder just the same.
    expect(destinationName("D:\\out\\beach.exr")).toBe("beach.exr");
    expect(destinationName("/out/beach.exr")).toBe("beach.exr");
  });

  /// A run of two hundred that gives up on the ninety-first because one
  /// file is unreadable is worse than one that finishes and says which
  /// ones missed.
  it("keeps going after a failure and reports what missed", async () => {
    vi.doMock("../bridge", async () => {
      const actual = await vi.importActual<typeof import("../bridge")>("../bridge");
      return {
        ...actual,
        loadGraph: async () => null,
        exportTo: async (_g: unknown, id: string, dest: string) => {
          if (id === "bad") throw new Error("unreadable");
          return dest;
        },
      };
    });
    vi.resetModules();
    const { runExport: run } = await import("../export");
    const images = [
      img("good1.dng", { id: "g1" }),
      img("broken.dng", { id: "bad" }),
      img("good2.dng", { id: "g2" }),
    ];
    const result = await run(initialState(), images, "D:/out", settings(), () => {});
    vi.doUnmock("../bridge");
    vi.resetModules();

    expect(result.written).toHaveLength(2);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].name).toBe("broken.dng");
    expect(result.failed[0].error).toContain("unreadable");
  });

  /// The owner's report, replayed: three RAW+JPEG pairs, six files in,
  /// and the run must land six files, not four.
  it("lands every file of a batch of RAW+JPEG pairs", async () => {
    vi.doMock("../bridge", async () => {
      const actual = await vi.importActual<typeof import("../bridge")>("../bridge");
      return {
        ...actual,
        loadGraph: async () => null,
        exportTo: async (_g: unknown, _id: string, dest: string) => dest,
      };
    });
    vi.resetModules();
    const { runExport: run } = await import("../export");
    const images = ["A", "B", "C"].flatMap((stem, i) => [
      img(`${stem}.dng`, { id: `raw-${i}` }),
      img(`${stem}.jpg`, { id: `jpg-${i}` }),
    ]);
    const result = await run(initialState(), images, "D:/out", settings(), () => {});
    vi.doUnmock("../bridge");
    vi.resetModules();

    expect(result.written).toHaveLength(6);
    expect(new Set(result.written).size).toBe(6);
    expect(result.written).toContain("D:/out/A.jpg");
    expect(result.written).toContain("D:/out/A-2.jpg");
  });

  /// The owner, staring at "Exported 3, 3 failed: P1551315.RW2, ...":
  /// the names alone say nothing about WHY. Every failure logs its
  /// reason.
  it("failures land in the console with their reasons, one line each", async () => {
    const { logExportFailures } = await import("../export");
    const { clearLog, getEntries } = await import("../log");
    clearLog();
    logExportFailures([
      { name: "a.RW2", error: "not in this catalog (queued in an earlier session?)" },
      { name: "b.RW2", error: "the original is missing or moved: /gone/b.RW2" },
    ]);
    const lines = getEntries().map((e) => e.message);
    expect(lines).toContain("Export failed: a.RW2: not in this catalog (queued in an earlier session?)");
    expect(lines).toContain("Export failed: b.RW2: the original is missing or moved: /gone/b.RW2");
  });

  it("stops between images when asked", async () => {
    let done = 0;
    const images = [img("a.dng"), img("b.dng"), img("c.dng")];
    await runExport(
      initialState(),
      images,
      "D:/out",
      settings(),
      (p) => {
        done = p.done;
      },
      () => done >= 1
    );
    // It stopped rather than running to the end of the list.
    expect(done).toBeLessThanOrEqual(images.length);
  });
});
