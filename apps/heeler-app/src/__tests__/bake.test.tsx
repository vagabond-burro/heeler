// Baking edited photographs into fresh negatives.

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { initialState } from "../data";
import { bakeable, freshGraphFor, reduce, type Command, type ImageEntry, type State } from "../state";
import { BAKE_FORMATS } from "../bridge";
import { BakeDialog } from "../ui/bake";
import { COMMANDS } from "../hotkeys";
import { runCommand } from "../commands";

const run = (s: State, ...cmds: Command[]) => cmds.reduce(reduce, s);

const entry = (id: string, name: string): ImageEntry => ({
  id,
  name,
  stars: 0,
  flag: "",
  edited: false,
  filter: "none",
  src: "",
});

/** A folder holding a merge, a panorama and an ordinary photograph. */
function folder() {
  return run(
    initialState(),
    { type: "add_stack_image", image: entry("merge", "HDR_a-c.stack") },
    { type: "add_stack_image", image: entry("pano", "PANO_a-d.pano") },
    { type: "add_stack_image", image: entry("plain", "DSC_0001.arw") },
  );
}

describe("what can be baked", () => {
  it("includes ordinary photographs, merges and panoramas", () => {
    const s = folder();
    expect(bakeable(run(s, { type: "select_image_range", id: "merge" }))).toEqual(["merge"]);
    expect(bakeable(run(s, { type: "select_image_range", id: "pano" }))).toEqual(["pano"]);
    expect(bakeable(run(s, { type: "select_image_range", id: "plain" }))).toEqual(["plain"]);
  });

  it("filters a mixed selection rather than refusing it", () => {
    const s = run(
      folder(),
      { type: "select_image_range", id: "merge" },
      { type: "select_image_range", id: "plain", additive: true },
      { type: "select_image_range", id: "pano", additive: true },
    );
    expect(bakeable(s).sort()).toEqual(["merge", "pano", "plain"]);
  });

  it("opening the dialog drops whatever cannot be baked", () => {
    const s = run(
      folder(),
      { type: "open_bake", ids: ["merge", "plain", "pano", "unknown"] },
    );
    expect(s.bake?.ids).toEqual(["merge", "plain", "pano"]);
    // An unknown photograph cannot be baked.
    expect(run(folder(), { type: "open_bake", ids: ["unknown"] }).bake).toBeNull();
  });

  it("the menu command accepts an ordinary photograph", () => {
    const s = run(folder(), { type: "select_image_range", id: "plain" });
    expect(runCommand("photo.bake", s, (() => {}) as never, {})).toBe(true);
    const merge = run(folder(), { type: "select_image_range", id: "merge" });
    expect(runCommand("photo.bake", merge, (() => {}) as never, {})).toBe(true);
    // And it is a real command in the registry, so it shows in the
    // hotkey editor and can be bound.
    expect(COMMANDS.find((c) => c.id === "photo.bake")?.group).toBe("Photo");
  });
});

describe("the format the user is asked for", () => {
  it("offers the three the owner named, with DNG first and default", () => {
    expect(BAKE_FORMATS.map((f) => f.id)).toEqual(["dng", "tiff", "jpg"]);
    expect(initialState().bakeFormat).toBe("dng");
  });

  it("remembers the last format chosen", () => {
    // Baking a folder of merges one at a time to the same format is the
    // normal way this gets used.
    let s = run(
      folder(),
      { type: "open_bake", ids: ["merge"] },
      { type: "set_bake_format", format: "tiff" },
      { type: "close_bake" },
    );
    expect(s.bake).toBeNull();
    expect(s.bakeFormat).toBe("tiff");
    s = run(s, { type: "open_bake", ids: ["pano"] });
    expect(s.bakeFormat).toBe("tiff");
  });
});

describe("the dialog", () => {
  const open = (s: State) => {
    const sent: Command[] = [];
    render(<BakeDialog state={s} dispatch={((c: Command) => sent.push(c)) as never} />);
    return sent;
  };

  it("is not there until something asks for it", () => {
    open(folder());
    expect(screen.queryByTestId("bake-dialog")).not.toBeInTheDocument();
  });

  it("names what it is about to bake", () => {
    open(run(folder(), { type: "open_bake", ids: ["merge"] }));
    expect(screen.getByTestId("bake-dialog")).toBeInTheDocument();
    expect(screen.getByTestId("bake-dialog")).toHaveTextContent("HDR_a-c.stack");
    expect(screen.getByTestId("bake-title")).toHaveTextContent(/bake to an image/i);
  });

  it("counts them when there is more than one", () => {
    open(run(folder(), { type: "open_bake", ids: ["merge", "pano"] }));
    expect(screen.getByTestId("bake-title")).toHaveTextContent("2");
  });

  it("says what each format costs, since that is the whole question", () => {
    const sent = open(run(folder(), { type: "open_bake", ids: ["merge"] }));
    // DNG is the one that keeps the highlights, which is why it leads.
    expect(screen.getByTestId("bake-format-dng").dataset.active).toBe("true");
    expect(screen.getByTestId("bake-format-hint")).toHaveTextContent(/highlights past white/i);
    fireEvent.click(screen.getByTestId("bake-format-jpg"));
    expect(sent).toEqual([{ type: "set_bake_format", format: "jpg" }]);
  });

  it("warns that the other two clip", () => {
    let s = run(folder(), { type: "open_bake", ids: ["merge"] });
    s = run(s, { type: "set_bake_format", format: "jpg" });
    open(s);
    expect(screen.getByTestId("bake-format-hint")).toHaveTextContent(/clips/i);
  });

  it("closes without baking when canceled", () => {
    const sent = open(run(folder(), { type: "open_bake", ids: ["merge"] }));
    fireEvent.click(screen.getByTestId("bake-cancel"));
    expect(sent).toEqual([{ type: "close_bake" }]);
  });
});

describe("baking itself", () => {
  it("bakes each merge and adds what it made to the folder", async () => {
    vi.resetModules();
    const baked = vi.fn(async (id: string) => entry(`${id}_baked`, `${id}.dng`));
    const saved: [string, unknown][] = [];
    vi.doMock("../bridge", async () => {
      const actual = await vi.importActual<typeof import("../bridge")>("../bridge");
      return {
        ...actual,
        bakeComposite: baked,
        loadGraph: vi.fn(async () => ({ nodes: [{ id: "n" }], wires: [] })),
        saveGraph: vi.fn(async (id: string, graph: unknown) => {
          saved.push([id, graph]);
        }),
      };
    });
    const { runBake } = await import("../ui/bake");
    const sent: Command[] = [];
    const made = await runBake(
      folder(),
      ["merge", "pano"],
      "tiff",
      ((c: Command) => sent.push(c)) as never,
    );

    expect(baked).toHaveBeenCalledTimes(2);
    expect(baked.mock.calls.map((c) => c[0])).toEqual(["merge", "pano"]);
    expect(made.map((m) => m.id)).toEqual(["merge_baked", "pano_baked"]);
    // Straight into the library, the same way a fresh merge arrives,
    // each bake bracketed by set_baking so its stack's merge card shows
    // in the bake's dialog (2026-10-08).
    expect(sent.map((c) => c.type === "set_baking" ? `baking ${c.id}` : c.type)).toEqual([
      "baking merge", "add_stack_image", "baking null",
      "baking pano", "add_stack_image", "baking null",
    ]);
    expect(saved).toEqual([]);
    expect(made.every((m) => !m.edited)).toBe(true);
    expect(baked).toHaveBeenCalledWith("merge", "tiff", expect.objectContaining({ nodes: expect.any(Array), wires: expect.any(Array) }), 92, expect.objectContaining({ id: "merge" }), true);
    vi.doUnmock("../bridge");
  });

  it("stops at the first failure instead of grinding through the rest", async () => {
    vi.resetModules();
    const baked = vi.fn(async () => {
      throw new Error("disk full");
    });
    vi.doMock("../bridge", async () => {
      const actual = await vi.importActual<typeof import("../bridge")>("../bridge");
      return { ...actual, bakeComposite: baked, loadGraph: vi.fn(async () => null), saveGraph: vi.fn() };
    });
    const { runBake } = await import("../ui/bake");
    const made = await runBake(folder(), ["merge", "pano"], "dng", (() => {}) as never);
    expect(made).toEqual([]);
    // A full-resolution merge is expensive; there is no sense running
    // the second one to watch it fail the same way.
    expect(baked).toHaveBeenCalledTimes(1);
    vi.doUnmock("../bridge");
  });

  it("a canceled merge ends the bake as canceled, not failed, and stops there", async () => {
    vi.resetModules();
    // Cancel merge on the stack the bake is waiting for: the desktop
    // answers the stack's set-aside error.
    const baked = vi.fn(async () => {
      throw new Error("Stack merge set aside: canceled");
    });
    vi.doMock("../bridge", async () => {
      const actual = await vi.importActual<typeof import("../bridge")>("../bridge");
      return { ...actual, bakeComposite: baked, loadGraph: vi.fn(async () => null), saveGraph: vi.fn() };
    });
    const { runBake } = await import("../ui/bake");
    const { getEntries } = await import("../log");
    const sent: Command[] = [];
    const made = await runBake(folder(), ["merge", "pano"], "dng", ((c: Command) => sent.push(c)) as never);
    expect(made).toEqual([]);
    expect(baked).toHaveBeenCalledTimes(1);
    const last = getEntries()[getEntries().length - 1];
    expect(last.message).toBe("Bake canceled");
    expect(last.level).toBe("info");
    // The bake lets go of the photograph either way.
    expect(sent[sent.length - 1]).toEqual({ type: "set_baking", id: null });
    vi.doUnmock("../bridge");
  });

  it("a Cancel that comes while the file is being written keeps and shows the file it made", async () => {
    vi.resetModules();
    const baked = vi.fn(async (id: string) => entry(`${id}_baked`, `${id}.dng`));
    vi.doMock("../bridge", async () => {
      const actual = await vi.importActual<typeof import("../bridge")>("../bridge");
      return { ...actual, bakeComposite: baked, loadGraph: vi.fn(async () => null), saveGraph: vi.fn() };
    });
    // The dialog's watcher answers canceled although the job finished:
    // Cancel was pressed during the last stage.
    vi.doMock("../ui/opprogress", async () => {
      const actual = await vi.importActual<typeof import("../ui/opprogress")>("../ui/opprogress");
      return { ...actual, watchBake: async (_t: string, job: () => Promise<unknown>) => { await job(); return null; } };
    });
    const { runBake } = await import("../ui/bake");
    const sent: Command[] = [];
    const made = await runBake(folder(), ["merge"], "dng", ((c: Command) => sent.push(c)) as never);
    expect(made.map((m) => m.id)).toEqual(["merge_baked"]);
    expect(sent.some((c) => c.type === "add_stack_image")).toBe(true);
    vi.doUnmock("../ui/opprogress");
    vi.doUnmock("../bridge");
  });

  it("says so rather than failing silently in the browser build", async () => {
    vi.resetModules();
    vi.doMock("../bridge", async () => {
      const actual = await vi.importActual<typeof import("../bridge")>("../bridge");
      return { ...actual, bakeComposite: vi.fn(async () => null), loadGraph: vi.fn(async () => null), saveGraph: vi.fn() };
    });
    const { runBake } = await import("../ui/bake");
    const { getEntries } = await import("../log");
    const before = getEntries().length;
    const made = await runBake(folder(), ["merge"], "dng", (() => {}) as never);
    expect(made).toEqual([]);
    expect(getEntries().length).toBeGreaterThan(before);
    expect(getEntries()[getEntries().length - 1].message).toMatch(/desktop app/i);
    vi.doUnmock("../bridge");
  });
});


// 2026-10-08: baking a stack, its merge card showed behind this
// dialog while it sat on "Baking…". Bake now closes the dialog at once;
// the merge's card and then the bake's bar show in the bake's own
// progress dialog (bakeprogress.test.tsx).
it("Bake closes the dialog at once, before the bake has done anything", () => {
  const sent: Command[] = [];
  render(<BakeDialog state={run(folder(), { type: "open_bake", ids: ["plain"] })} dispatch={((c: Command) => sent.push(c)) as never} />);
  fireEvent.click(screen.getByTestId("bake-ok"));
  expect(sent[0]).toEqual({ type: "close_bake" });
  expect(screen.getByTestId("bake-ok")).toHaveTextContent("Bake");
  expect(screen.getByTestId("bake-ok")).not.toBeDisabled();
});

it("explains an ordinary bake and its untouched original", () => {
  render(<BakeDialog state={run(folder(), { type: "open_bake", ids: ["plain"] })} dispatch={vi.fn()} />);
  const dialog = screen.getByTestId("bake-dialog");
  expect(dialog).toHaveTextContent("DSC_0001.arw");
  expect(dialog).toHaveTextContent("new file beside the original with the edits rendered in");
  expect(dialog).toHaveTextContent("original is untouched");
  expect(dialog).toHaveTextContent("Merges and panoramas include their edits too");
});

it("a marked DNG opens with neutral controls and its tone profile bypassed", () => {
  const state = initialState();
  state.images = [entry("raw", "camera.dng"), { ...entry("baked", "camera_2.dng"), renderedBake: true }];
  const raw = freshGraphFor(state, "raw");
  const baked = freshGraphFor(state, "baked");
  expect(raw.nodes.find((n) => n.type === "heeler.tone_profile")?.enabled).not.toBe(false);
  expect(baked.nodes.find((n) => n.type === "heeler.tone_profile")?.enabled).toBe(false);
  // A camera DNG is born with the RAW default sharpening; a bake is
  // never capture sharpened, so its source carries no choice.
  expect(raw.nodes.find((n) => n.type === "heeler.image_source")?.textParams?.sharpening).toBe(state.rawSharpening);
  expect(baked.nodes).toEqual(
    raw.nodes.map((n) => {
      if (n.type === "heeler.tone_profile") return { ...n, enabled: false };
      if (n.type !== "heeler.image_source") return n;
      const { sharpening: _born, ...textParams } = n.textParams ?? {};
      const { textParams: _all, ...rest } = n;
      return Object.keys(textParams).length ? { ...rest, textParams } : rest;
    }),
  );
  const loaded = reduce(state, { type: "load_images", images: [state.images[1]] });
  expect(loaded.nodes.find((n) => n.type === "heeler.tone_profile")?.enabled).toBe(false);
});

it("a phone's DNG opens with its tone profile bypassed, like a bake", () => {
  // Its decode follows the gain table map, baseline exposure and tone
  // curve the file carries, which is the picture its thumbnail shows;
  // the profile's lift on top came out over a stop bright (2026-10-02:
  // "match the thumbnail").
  const state = initialState();
  state.images = [entry("raw", "L1000123.DNG"), { ...entry("phone", "IMG_6991.DNG"), phoneRendered: true }];
  const raw = freshGraphFor(state, "raw");
  const phone = freshGraphFor(state, "phone");
  expect(raw.nodes.find((n) => n.type === "heeler.tone_profile")?.enabled).not.toBe(false);
  expect(phone.nodes.find((n) => n.type === "heeler.tone_profile")?.enabled).toBe(false);
  // No sensor data left to capture sharpen: the phone demosaiced it.
  expect(phone.nodes.find((n) => n.type === "heeler.image_source")?.textParams?.sharpening).toBeUndefined();
  const loaded = reduce(state, { type: "load_images", images: [state.images[1]] });
  expect(loaded.nodes.find((n) => n.type === "heeler.tone_profile")?.enabled).toBe(false);
});

it("a panorama of phone frames opens with its tone profile bypassed; a stack of them is developed like any merge", () => {
  // 2026-10-03: "stacks use scene-linear, panoramas keep phone
  // rendering". A panorama is stitched from the phone's finished
  // pictures, so the listing marks it and the profile stays off; a
  // stack's members merge scene-linear and take the profile, with the
  // merge's highlight shoulder.
  const state = initialState();
  state.images = [{ ...entry("pano", "Harbor.pano"), phoneRendered: true }, entry("camerapano", "Ridge.pano"), entry("stack", "HDR_a-c.stack")];
  const profile = (id: string) => freshGraphFor(state, id).nodes.find((n) => n.type === "heeler.tone_profile")!;
  expect(profile("pano").enabled).toBe(false);
  expect(profile("camerapano").enabled).not.toBe(false);
  expect(profile("stack").enabled).not.toBe(false);
  const loaded = reduce(state, { type: "load_images", images: [state.images[0]] });
  expect(loaded.nodes.find((n) => n.type === "heeler.tone_profile")?.enabled).toBe(false);
});

it("enables Bake in the Photo menu for the selected ordinary photograph", async () => {
  const { App } = await import("../app");
  render(<App />);
  fireEvent.click(screen.getByTestId("menu-photo"));
  expect(screen.getByTestId("menu-photo-bake")).not.toBeDisabled();
  fireEvent.click(screen.getByTestId("menu-photo-bake"));
  expect(screen.getByTestId("bake-dialog")).toHaveTextContent("original is untouched");
});


it("shows a baked photograph's source filename in Metadata", async () => {
  const { MetadataTab } = await import("../ui/metadata");
  const state = initialState();
  state.images = [{ ...entry("baked", "IMG_1234.dng"), renderedBake: true, bakedFrom: "IMG_1234.CR3" }];
  state.activeImage = "baked";
  render(<MetadataTab state={state} dispatch={vi.fn()} />);
  expect(screen.getByText("Baked from")).toBeInTheDocument();
  expect(screen.getByText("IMG_1234.CR3")).toBeInTheDocument();
});

it("passes unsaved active and cached edits before baking without saving a copied recipe", async () => {
  vi.resetModules();
  const baked = vi.fn(async (id: string) => entry(id + "_baked", id + ".dng"));
  const loaded = vi.fn();
  const saved = vi.fn();
  vi.doMock("../bridge", async () => ({
    ...await vi.importActual<typeof import("../bridge")>("../bridge"),
    bakeComposite: baked, loadGraph: loaded, saveGraph: saved,
  }));
  const { runBake } = await import("../ui/bake");
  const state = folder();
  const cached = { ...state.graphs.merge, nodes: structuredClone(state.nodes), wires: state.wires };
  cached.nodes[0].badge = "pending cached edit";
  state.graphs.merge = cached;
  await runBake(state, ["plain", "merge"], "dng", vi.fn());
  expect(baked).toHaveBeenNthCalledWith(1, "plain", "dng", { nodes: state.nodes, wires: state.wires }, 92, state.images.find(i => i.id === "plain"), false);
  expect(baked).toHaveBeenNthCalledWith(2, "merge", "dng", cached, 92, state.images.find(i => i.id === "merge"), true);
  expect(loaded).not.toHaveBeenCalled();
  expect(saved).not.toHaveBeenCalled();
  vi.doUnmock("../bridge");
});

it("reads at Preferences' type sizes, 14 for labels and 13.5 for explanations", async () => {
  // 2026-09-10: "The bake to image dialog is way too small. It
  // should use the same font size as preferences."
  const { App } = await import("../app");
  render(<App />);
  fireEvent.click(screen.getByTestId("menu-photo"));
  fireEvent.click(screen.getByTestId("menu-photo-bake"));
  expect(screen.getByTestId("bake-names").style.fontSize).toBe("14px");
  expect(screen.getByTestId("bake-format-label").style.fontSize).toBe("14px");
  expect(screen.getByTestId("bake-blurb").style.fontSize).toBe("13.5px");
  expect(screen.getByTestId("bake-format-hint").style.fontSize).toBe("13.5px");
  expect(screen.getByTestId("bake-format-dng").style.fontSize).toBe("12px");
});
