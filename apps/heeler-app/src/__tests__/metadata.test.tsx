// The right panel's tabs as icons, and the metadata behind the new one.
//
// "we need to change the text labels for Adjustments,
// history, and presets to icon (the name comes up in a tooltip when
// mousing over the tab) and add a metadata tab."

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { initialState } from "../data";
import { PANEL_TABS, reduce, type Command, type State } from "../state";
import { PanelTabs } from "../ui/panelicons";
import { CursorTip } from "../ui/cursortip";
import { cameraRows, fileRows, humanShotAt, humanSize } from "../ui/metadata";
import type { ImageMeta } from "../bridge";

const meta = (over: Partial<ImageMeta> = {}): ImageMeta => ({
  id: "img_1",
  name: "DSC_0001.arw",
  path: "D:/shoot/DSC_0001.arw",
  size: 48_234_496,
  modified: 1_710_178_928,
  stars: 4,
  flag: "pick",
  edited: true,
  sidecar: false,
  ...over,
});

describe("keywords on the metadata tab", () => {
  it("adds on Enter, removes by chip, and persists through the bridge", async () => {
    const userEvent = (await import("@testing-library/user-event")).default;
    const { MetadataTab } = await import("../ui/metadata");
    const { initialState } = await import("../data");
    const { imageKeywords } = await import("../bridge");
    const user = userEvent.setup();
    const s = initialState();
    render(<MetadataTab state={s} dispatch={() => {}} />);
    const input = await screen.findByTestId("keyword-input");
    await user.type(input, "wedding{Enter}");
    expect(await screen.findByTestId("keyword-wedding")).toBeInTheDocument();
    await user.type(input, "smith-family{Enter}");
    // Case-insensitive dedupe: "Wedding" is already there.
    await user.type(input, "Wedding{Enter}");
    expect(screen.getAllByTestId(/^keyword-w/i)).toHaveLength(1);
    // The set went through the bridge, not just the local state.
    expect(await imageKeywords(s.activeImage)).toEqual(["wedding", "smith-family"]);
    await user.click(screen.getByTestId("keyword-remove-wedding"));
    expect(await imageKeywords(s.activeImage)).toEqual(["smith-family"]);
  });
});

describe("everything in the file", () => {
  const lines = [
    { group: "EXIF", name: "Make", value: "Apple" },
    { group: "EXIF", name: "Lens Model", value: "iPhone 15 Pro Max back triple camera 15.66mm f/2.8" },
    { group: "GPS", name: "GPS Latitude", value: "45 deg 58' 59.11\"" },
    { group: "XMP", name: "Creator Tool", value: "18.6.2" },
    { group: "ICC Profile", name: "Profile Description", value: "Display P3" },
    ...Array.from({ length: 10 }, (_, i) => ({ group: "EXIF", name: `Tag 0x${(0xff00 + i).toString(16)}`, value: String(i) })),
  ];

  it("lists every group the reader found, filters it, and the values select while the labels do not", async () => {
    // 2026-09-23: "it should show the user whatever it finds", and
    // "the values of metadata can be selectable".
    const userEvent = (await import("@testing-library/user-event")).default;
    vi.resetModules();
    vi.doMock("../bridge", async () => {
      const actual = await vi.importActual<typeof import("../bridge")>("../bridge");
      return {
        ...actual,
        imageMetadata: vi.fn(async (_s: unknown, id: string) => meta({ id, camera: "Apple iPhone 15 Pro Max" })),
        imageMetadataAll: vi.fn(async () => lines),
      };
    });
    const { MetadataTab } = await import("../ui/metadata");
    const s = initialState();
    const view = render(<MetadataTab state={s} dispatch={(() => {}) as never} />);
    await waitFor(() => expect(screen.getByTestId("meta-group-exif")).toBeInTheDocument());
    expect(screen.getByText("File metadata")).toBeInTheDocument();
    expect(screen.queryByText("Everything in the file")).not.toBeInTheDocument();
    for (const g of ["gps", "xmp", "icc-profile"]) expect(screen.getByTestId(`meta-group-${g}`)).toBeInTheDocument();
    expect(screen.getByTestId("meta-row-profile description")).toHaveTextContent("Display P3");
    for (const el of screen.getByTestId("meta-all").querySelectorAll<HTMLElement>("[style]")) {
      if (el.style.fontSize) expect(parseFloat(el.style.fontSize)).toBeGreaterThanOrEqual(11);
    }
    // Values select, labels do not.
    const row = screen.getByTestId("meta-row-make");
    const [label, value] = Array.from(row.children) as HTMLElement[];
    expect(value.style.userSelect).toBe("text");
    expect(label.style.userSelect).toBe("");
    // The camera block's values select too, and its rows share one
    // label column with the listing, so every value starts on one line.
    await waitFor(() => expect(screen.getByTestId("meta-row-camera")).toBeInTheDocument());
    expect((screen.getByTestId("meta-row-camera").children[1] as HTMLElement).style.userSelect).toBe("text");
    const columns = (id: string) => screen.getByTestId(id).style.gridTemplateColumns;
    expect(columns("meta-row-camera")).toBe(columns("meta-row-make"));
    expect(columns("meta-row-name")).toBe(columns("meta-row-make"));
    const bridge = await import("../bridge");
    expect(bridge.imageMetadataAll).toHaveBeenCalledTimes(1);
    const rated = { ...s, images: s.images.map((i) => i.id === s.activeImage ? { ...i, stars: 5 } : i) };
    view.rerender(<MetadataTab state={rated} dispatch={() => {}} />);
    await waitFor(() => expect(bridge.imageMetadata).toHaveBeenCalledTimes(2));
    expect(bridge.imageMetadataAll).toHaveBeenCalledTimes(1);
    const other = s.images.find((i) => i.id !== s.activeImage)!;
    view.rerender(<MetadataTab state={{ ...rated, activeImage: other.id }} dispatch={() => {}} />);
    await waitFor(() => expect(bridge.imageMetadataAll).toHaveBeenCalledTimes(2));
    // The filter narrows by name, value or group.
    const user = userEvent.setup();
    await user.type(screen.getByTestId("meta-filter"), "p3");
    expect(screen.getByTestId("meta-group-icc-profile")).toBeInTheDocument();
    expect(screen.queryByTestId("meta-group-gps")).not.toBeInTheDocument();
    await user.clear(screen.getByTestId("meta-filter"));
    await user.type(screen.getByTestId("meta-filter"), "nothing here");
    expect(screen.getByTestId("meta-all-none")).toHaveTextContent("Nothing matches.");
    vi.doUnmock("../bridge");
  });
});

describe("the tabs are pictures now", () => {
  const strip = (active = "adjust" as const) => {
    const picked: string[] = [];
    render(
      <>
        <CursorTip />
        <PanelTabs
          tabs={PANEL_TABS}
          active={active}
          onPick={(t) => picked.push(t)}
        />
      </>,
    );
    return picked;
  };

  it("shows one glyph per tab, and a metadata tab that was not there", () => {
    strip();
    for (const t of PANEL_TABS) {
      expect(screen.getByTestId(`panel-tab-${t.id}`)).toBeInTheDocument();
      expect(screen.getByTestId(`icon-${t.id}`)).toBeInTheDocument();
    }
    expect(PANEL_TABS.map((t) => t.id)).toEqual([
      "adjust",
      "layers",
      "history",
      "presets",
      "metadata",
      "tether",
    ]);
  });

  it("carries its name for the cursor tip", () => {
    // The name now rides the SHARED cursor tip (data-tip), which follows
    // the pointer and clamps against the window instead of guessing a
    // position from a hardcoded tab width - the old tip "did not align
    // with the tab I am mousing over". The tip's own behavior is pinned
    // in cursortip.test.tsx; here the strip only has to offer every
    // tab's name.
    strip();
    expect(screen.getByTestId("panel-tab-history").getAttribute("data-tip")).toBe("History");
    expect(screen.getByTestId("panel-tab-metadata").getAttribute("data-tip")).toBe("Metadata");
  });

  it("keeps its name reachable without a mouse at all", () => {
    // The glyph is decorative; the button carries the name, so a screen
    // reader and a keyboard user both get it.
    strip();
    expect(screen.getByLabelText("Presets")).toBeInTheDocument();
    expect(screen.getByTestId("icon-presets")).toHaveAttribute("aria-hidden", "true");
    // Focus shows the shared cursor tip at the control, so the name
    // is as reachable by keyboard as by mouse.
    fireEvent.focusIn(screen.getByTestId("panel-tab-presets"));
    expect(screen.getByTestId("cursor-tip")).toHaveTextContent("Presets");
  });

  it("uses no native tooltip, which the app forbids for good reason", () => {
    // A `title` arrives a second late, unstyled, outside the window's
    // look. There is an app-wide contract test about this; the tooltip
    // above is the replacement rather than an exception to it.
    strip();
    expect(document.querySelectorAll("[title]").length).toBe(0);
  });

  it("reports which tab was clicked", () => {
    const picked = strip();
    fireEvent.click(screen.getByTestId("panel-tab-metadata"));
    expect(picked).toEqual(["metadata"]);
  });

  it("is a tab the reducer and the keyboard can reach", () => {
    const s = reduce(initialState(), { type: "set_panel_tab", tab: "metadata" });
    expect(s.panelTab).toBe("metadata");
  });
});

describe("what the metadata panel says", () => {
  it("shows only the fields the file actually has", () => {
    // A scanned negative has no aperture. Ten blank rows read as
    // something failing to load rather than a file with nothing to say.
    expect(cameraRows(meta()).filter((r) => r.value)).toEqual([]);

    const full = cameraRows(
      meta({
        camera: "NIKON Z 7",
        lens: "NIKKOR Z 85mm f/1.8 S",
        shot_at: "2024:03:11 17:42:08",
        shutter: "1/250",
        aperture: "f/2.8",
        iso: 400,
        focal: "85 mm",
      }),
    ).filter((r) => r.value);
    expect(full.find((r) => r.label === "Camera")!.value).toBe("NIKON Z 7");
    expect(full.find((r) => r.label === "ISO")!.value).toBe("400");
    expect(full.find((r) => r.label === "Taken")!.value).toBe("2024-03-11 17:42");
  });

  /// The bug the "no camera data" test found: the pixel dimensions and the
  /// file size are facts about the FILE, and listing them as camera
  /// readings meant a scan with no EXIF still showed two rows under
  /// Camera and so never admitted it had none.
  it("keeps facts about the file out of the camera's list", () => {
    const m = meta({ width: 8256, height: 5504 });
    expect(cameraRows(m).map((r) => r.label)).not.toContain("Pixels");
    const file = fileRows(m).filter((r) => r.value);
    expect(file.find((r) => r.label === "Pixels")!.value).toBe("8256 × 5504");
    expect(file.find((r) => r.label === "On disk")!.value).toBe("46.0 MB");
  });

  it("says the date the way a person writes one", () => {
    // EXIF writes "2024:03:11 17:42:08", which nothing else on earth
    // does, and colons between the date parts read as a time.
    expect(humanShotAt("2024:03:11 17:42:08")).toBe("2024-03-11 17:42");
    expect(humanShotAt("")).toBe("");
    expect(humanShotAt(null)).toBe("");
    // Anything that is not the EXIF shape is shown as it came rather
    // than mangled into something wrong.
    expect(humanShotAt("sometime in March")).toBe("sometime in March");
  });

  it("says file sizes the way a person says them", () => {
    expect(humanSize(0)).toBe("");
    expect(humanSize(900)).toBe("900 B");
    expect(humanSize(2048)).toBe("2 KB");
    expect(humanSize(48_234_496)).toBe("46.0 MB");
    expect(humanSize(3_221_225_472)).toBe("3.0 GB");
  });
});

describe("the metadata tab in the panel", () => {
  const mount = async (s: State, over: Partial<ImageMeta> = {}) => {
    vi.resetModules();
    const written: unknown[] = [];
    vi.doMock("../bridge", async () => {
      const actual = await vi.importActual<typeof import("../bridge")>("../bridge");
      return {
        ...actual,
        imageMetadata: vi.fn(async () => meta({ id: s.activeImage!, ...over })),
        writeImageMetadata: vi.fn(async (...args: unknown[]) => {
          written.push(args);
          return "D:/shoot/DSC_0001.xmp";
        }),
      };
    });
    const { MetadataTab } = await import("../ui/metadata");
    const sent: Command[] = [];
    render(<MetadataTab state={s} dispatch={((c: Command) => sent.push(c)) as never} />);
    return { written, sent };
  };

  it("shows the workspace's half and the camera's half apart", async () => {
    const s = initialState();
    await mount(s, { camera: "NIKON Z 7", iso: 400 });
    expect(screen.getByTestId("metadata-tab")).toHaveTextContent(/this workspace/i);
    await waitFor(() => expect(screen.getByTestId("metadata-tab")).toHaveTextContent("NIKON Z 7"));
    // The workspace's own fields come from state, not from the file, so
    // they are right the moment the tab opens.
    expect(screen.getByTestId("meta-row-status")).toBeInTheDocument();
    vi.doUnmock("../bridge");
  });

  it("says so plainly when a file has no camera data", async () => {
    await mount(initialState());
    await waitFor(() => expect(screen.getByTestId("meta-none")).toHaveTextContent(/no camera data/i));
    vi.doUnmock("../bridge");
  });

  it("writes the takes and their notes out only when asked", async () => {
    // "write out custom metadata about the version number and
    // notes that were set during editing." A sidecar appearing beside every
    // RAW you merely looked at would be its own kind of rude.
    const s = initialState();
    const { written } = await mount(s);
    expect(written).toHaveLength(0);
    fireEvent.click(screen.getByTestId("meta-write"));
    await waitFor(() => expect(written).toHaveLength(1));
    const [id, activeTake, takes] = written[0] as [string, string, unknown[]];
    expect(id).toBe(s.activeImage);
    expect(typeof activeTake).toBe("string");
    expect(Array.isArray(takes)).toBe(true);
    vi.doUnmock("../bridge");
  });

  it("says whether a sidecar is already on disk", async () => {
    await mount(initialState(), { sidecar: true });
    await waitFor(() =>
      expect(screen.getByTestId("meta-sidecar-state")).toHaveTextContent(/xmp on disk/i),
    );
    vi.doUnmock("../bridge");
  });

  it("a sidecar write stuck on a slow disk does not hold up the tab's reads", async () => {
    // The stall plan's Phase 5 probe for the metadata batch: the
    // deferred write stands in for write_image_metadata waiting on a
    // slow volume. Against the old inline body the sidecar write held
    // an async-runtime worker and every later command queued behind
    // it, the panel's own re-reads included; the desktop's shape test
    // pins the move to spawn_blocking, and this probe pins that the
    // tab keeps reading while a write is out.
    vi.resetModules();
    let release!: (path: string) => void;
    const blocked = new Promise<string>((r) => { release = r; });
    const reads: string[] = [];
    vi.doMock("../bridge", async () => {
      const actual = await vi.importActual<typeof import("../bridge")>("../bridge");
      return {
        ...actual,
        imageMetadata: vi.fn(async (_s: unknown, id: string) => {
          reads.push(id);
          return meta({ id, camera: "NIKON Z 7" });
        }),
        writeImageMetadata: vi.fn(async () => blocked),
      };
    });
    const { MetadataTab } = await import("../ui/metadata");
    try {
      const s = initialState();
      const { rerender } = render(<MetadataTab state={s} dispatch={(() => {}) as never} />);
      await waitFor(() => expect(reads).toHaveLength(1));
      await waitFor(() => expect(screen.getByTestId("metadata-tab")).toHaveTextContent("NIKON Z 7"));
      // The write goes out and sticks on the disk.
      fireEvent.click(screen.getByTestId("meta-write"));
      expect(screen.getByTestId("meta-write")).toBeDisabled();
      // A rating change re-reads the file, and the answer lands even
      // though the write is still out.
      const starred: State = {
        ...s,
        images: s.images.map((i) => (i.id === s.activeImage ? { ...i, stars: 2 } : i)),
      };
      rerender(<MetadataTab state={starred} dispatch={(() => {}) as never} />);
      await waitFor(() => expect(reads).toHaveLength(2));
      await waitFor(() => expect(screen.getByTestId("metadata-tab")).toHaveTextContent("NIKON Z 7"));
      // The disk answers; the write's own re-read lands and the button comes back.
      release("D:/shoot/DSC_0001.xmp");
      await waitFor(() => expect(reads.length).toBeGreaterThanOrEqual(3));
      await waitFor(() => expect(screen.getByTestId("meta-write")).not.toBeDisabled());
    } finally {
      vi.doUnmock("../bridge");
      vi.resetModules();
    }
  });
});
