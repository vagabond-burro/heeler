// The Tether tab's session half. The watch, the naming and the
// no-overwrite settling are pinned in the desktop crate; this file
// pins the panel tab, the session dials, and the append semantics
// arrivals ride into the ribbon.

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { initialState } from "../data";
import { uiSettingsCommands, uiSettingsSnapshot } from "../settings";
import { PANEL_TABS, reduce, visiblePanelTabs, type Command, type ImageEntry, type State } from "../state";
import { TetherTab, arrivalsForRibbon } from "../ui/tether";
import { catalogSaves, flushRecoverySaves } from "../savebarrier";
import { saveUiSettings, usbCameraPoll } from "../bridge";
import { choose, menuRows, menuValue } from "./menuhelp";
import type { TetherImage } from "../bridge";

// The camera seam is hardware: the scan and the session status answer
// with fixtures, and nothing here pretends a device answered.
let mockScan = {
  devices: [
    {
      key: "04da:2372:0:4",
      vendor_id: 0x04da,
      product_id: 0x2372,
      name: "DC-G9M3",
      manufacturer: "Panasonic",
      serial: "ABC123",
      verdict: "PtpCapable" as const,
      note: "PTP interface present; ready to connect",
      interfaces: [6],
    },
    {
      key: "04a9:1234:0:9",
      vendor_id: 0x04a9,
      product_id: 0x1234,
      name: "EOS camera",
      manufacturer: "Canon",
      serial: null,
      verdict: "MassStorageOnly" as const,
      note: "Camera is in card-reader mode.",
      interfaces: [8],
    },
  ],
  report: "Heeler USB camera scan\n2 camera-shaped.",
};
let mockStatus = {
  connected: false,
  name: "",
  model: "",
  serial: "",
  can_capture: false,
  report_lines: [] as string[],
};
// The exposure seam is hardware too: the fixtures are the DC-S5's own
// descriptor dump (2026-08-26), trimmed.
let mockExposure = {
  controls: [
    {
      key: "iso",
      label: "ISO",
      code: 0x02000020,
      value_size: 4,
      current: 400,
      allowed: [0xffffffff, 100, 200, 400, 800],
    },
    {
      key: "shutter",
      label: "Shutter speed",
      code: 0x02000030,
      value_size: 4,
      current: 40000,
      allowed: [0xffffffff, 0x8000ea60, 40000, 80000, 8000000],
    },
    {
      key: "aperture",
      label: "Aperture",
      code: 0x02000040,
      value_size: 2,
      current: 80,
      allowed: [56, 80, 110, 220],
    },
  ],
  failed: ["White balance"],
  battery: 87,
};
// The live view seam is the same hardware: the frame fixture is a
// stand-in JPEG data URL.
let mockLiveFrame: string | null = "data:image/jpeg;base64,/9j/4AAQ";
vi.mock("../bridge", async (importOriginal) => {
  const real = await importOriginal<typeof import("../bridge")>();
  return {
    ...real,
    usbCameraScan: vi.fn(async () => mockScan),
    usbCameraStatus: vi.fn(async () => mockStatus),
    usbCameraConnect: vi.fn(async () => ({
      connected: true,
      name: "Panasonic DC-G9M3",
      model: "DC-G9M3",
      serial: "ABC123",
      can_capture: true,
      report_lines: ["Device: Panasonic DC-G9M3"],
    })),
    usbCameraDisconnect: vi.fn(async () => undefined),
    usbCameraExposure: vi.fn(async () => mockExposure),
    usbCameraSetExposure: vi.fn(async (_code: number, value: number) => ({
      ...mockExposure,
      controls: mockExposure.controls.map((c) => (c.code === _code ? { ...c, current: value } : c)),
    })),
    usbCameraLiveviewStart: vi.fn(async () => undefined),
    usbCameraLiveviewStop: vi.fn(async () => undefined),
    usbCameraLiveviewFrame: vi.fn(async () => mockLiveFrame),
    usbCameraCapture: vi.fn(async () => ({ images: [], session_count: 0 })),
    usbCameraPoll: vi.fn(async () => ({ images: [], session_count: 0 })),
    usbCameraFocusDrive: vi.fn(async (_mode: number) => undefined),
    usbCameraAutofocus: vi.fn(async () => undefined),
    saveUiSettings: vi.fn(async (_json: string) => undefined),
  };
});

const run = (s: State, ...cmds: Command[]) => cmds.reduce(reduce, s);
const entry = (id: string): ImageEntry =>
  ({ id, name: `${id}.rw2`, stars: 0, flag: "", edited: false, missing: false, filter: "none", src: "" }) as ImageEntry;

describe("append_images", () => {
  it("appends arrivals, never replaces, and leaves known rows alone", () => {
    const s0 = initialState();
    const before = s0.images.length;
    const known = s0.images[0];
    let s = run(s0, { type: "append_images", images: [entry("t1"), { ...known, name: "imposter" }] });
    expect(s.images.length).toBe(before + 1);
    expect(s.images.find((i) => i.id === known.id)!.name).toBe(known.name);
    expect(s.images[s.images.length - 1].id).toBe("t1");
    // The active photograph did not move: advancing is the tab's call.
    expect(s.activeImage).toBe(s0.activeImage);
    // Loading machinery, not an edit: no undo entry.
    expect(s.undoStack.length).toBe(s0.undoStack.length);
  });
});

describe("the Tether tab", () => {
  it("is a panel tab", () => {
    expect(PANEL_TABS.some((t) => t.id === "tether")).toBe(true);
  });

  it("offers the session dials and refuses to start without a hot folder", () => {
    render(<TetherTab state={initialState()} dispatch={() => {}} />);
    expect(screen.getByTestId("tether-hot")).toBeTruthy();
    expect(screen.getByTestId("tether-dest")).toBeTruthy();
    expect(screen.getByTestId("tether-pattern")).toBeTruthy();
    expect(screen.getByTestId("tether-collection")).toBeTruthy();
    expect((screen.getByTestId("tether-start") as HTMLButtonElement).disabled).toBe(true);
    // Auto-advance ships on: tethering exists to put the newest frame
    // in front of the photographer.
    expect(screen.getByTestId("tether-advance").textContent).toBe("On");
    fireEvent.click(screen.getByTestId("tether-advance"));
    expect(screen.getByTestId("tether-advance").textContent).toBe("Off");
  });

  it("starts a new session from the saved destination, naming, and advance defaults", () => {
    const s: State = {
      ...initialState(),
      prefs: {
        ...initialState().prefs,
        tetherDestination: "/shoots/incoming",
        tetherNamingPattern: "{date}-{seq}",
        tetherAutoAdvance: false,
      },
    };
    render(<TetherTab state={s} dispatch={() => {}} />);
    expect(screen.getByTestId("tether-dest").textContent).toBe("incoming");
    expect((screen.getByTestId("tether-pattern") as HTMLInputElement).value).toBe("{date}-{seq}");
    expect(screen.getByTestId("tether-advance").textContent).toBe("Off");
  });

  it("lists the catalog's collections as destinations", () => {
    const s: State = {
      ...initialState(),
      collections: [{ id: 4, name: "Selects", count: 0, hasLook: false }],
    };
    render(<TetherTab state={s} dispatch={() => {}} />);
    const sel = screen.getByTestId("tether-collection");
    const labels = menuRows(sel).map(([, l]) => l).join(" | ");
    expect(labels).toContain("Selects");
    expect(labels).toContain("None");
  });

  it("opens the collection dial on the sidebar's active collection", () => {
    const s: State = {
      ...initialState(),
      activeCollection: 4,
      collections: [{ id: 4, name: "Selects", count: 0, hasLook: false }],
    };
    render(<TetherTab state={s} dispatch={() => {}} />);
    expect(menuValue(screen.getByTestId("tether-collection"))).toBe("4");
  });
});

describe("arrivals and the ribbon", () => {
  const arrival = (id: string, folder: string): TetherImage =>
    ({ id, name: `${id}.rw2`, stars: 0, flag: "", folder });

  it("appends only the arrivals that landed in the folder on screen", () => {
    const s: State = { ...initialState(), activeFolderPath: "/shoots/incoming" };
    const got = arrivalsForRibbon(
      [arrival("a", "/shoots/incoming"), arrival("b", "/shoots/other")],
      s,
      null,
    );
    expect(got.map((f) => f.id)).toEqual(["a"]);
  });

  it("treats a trailing separator as the same folder", () => {
    const s: State = { ...initialState(), activeFolderPath: "/shoots/incoming/" };
    expect(arrivalsForRibbon([arrival("a", "/shoots/incoming")], s, null).length).toBe(1);
  });

  it("shows arrivals in the collection they are joining, and nowhere else", () => {
    const s: State = { ...initialState(), activeCollection: 7, activeFolderPath: "/shoots/incoming" };
    // The dial targets the collection on screen: the arrivals show.
    expect(arrivalsForRibbon([arrival("a", "/shoots/incoming")], s, 7).length).toBe(1);
    // The dial targets another collection: nothing here.
    expect(arrivalsForRibbon([arrival("a", "/shoots/incoming")], s, 9).length).toBe(0);
    // No dial: a collection view takes nothing.
    expect(arrivalsForRibbon([arrival("a", "/shoots/incoming")], s, null).length).toBe(0);
  });

  it("appends nothing when no folder is open", () => {
    expect(initialState().activeFolderPath).toBeNull();
    expect(arrivalsForRibbon([arrival("a", "/shoots/incoming")], initialState(), null).length).toBe(0);
  });
});

describe("the experimental gate", () => {
  const gatedOn = (): State => ({
    ...initialState(),
    prefs: { ...initialState().prefs, experimentalFeatures: true },
  });

  it("hides the tab by default and shows it when the preference is on", () => {
    expect(initialState().prefs.experimentalFeatures).toBe(false);
    expect(visiblePanelTabs(initialState().prefs).some((t) => t.id === "tether")).toBe(false);
    expect(visiblePanelTabs(gatedOn().prefs).some((t) => t.id === "tether")).toBe(true);
    // The full list still declares the tab; the gate filters seats, not
    // the declaration.
    expect(PANEL_TABS.some((t) => t.id === "tether")).toBe(true);
  });

  it("refuses to seat the hidden tab from any command", () => {
    const s = initialState();
    expect(run(s, { type: "set_panel_tab", tab: "tether" })).toEqual(s);
    expect(run(s, { type: "set_panel_tab_bottom", tab: "tether" })).toEqual(s);
    expect(run(s, { type: "move_tab_down", tab: "tether" }).panelBottom).toEqual([]);
    // ... and honors the same commands once the gate is open.
    expect(run(gatedOn(), { type: "set_panel_tab", tab: "tether" }).panelTab).toBe("tether");
    expect(run(gatedOn(), { type: "move_tab_down", tab: "tether" }).panelBottom).toEqual(["tether"]);
  });

  it("clears the tab out of live panel state when the preference flips off", () => {
    let s = run(gatedOn(), { type: "set_panel_tab", tab: "tether" }, { type: "move_tab_down", tab: "history" });
    s = { ...s, panelTabBottom: "tether" as never };
    const off = run(s, { type: "set_prefs", prefs: { experimentalFeatures: false } });
    expect(off.panelTab).not.toBe("tether");
    expect(off.panelTabBottom).not.toBe("tether");
    expect(off.panelBottom.includes("tether")).toBe(false);
    // Unrelated split state survives the scrub.
    expect(off.panelBottom).toEqual(["history"]);
  });

  it("persists the preference through the settings round trip", () => {
    const on = run(initialState(), { type: "set_prefs", prefs: { experimentalFeatures: true } });
    const json = JSON.stringify(uiSettingsSnapshot(on));
    let restored = initialState();
    for (const command of uiSettingsCommands(json)) restored = reduce(restored, command);
    expect(restored.prefs.experimentalFeatures).toBe(true);
    // And a saved true cannot stick once the user turns it off.
    const off = run(on, { type: "set_prefs", prefs: { experimentalFeatures: false } });
    let again = initialState();
    for (const command of uiSettingsCommands(JSON.stringify(uiSettingsSnapshot(off)))) again = reduce(again, command);
    expect(again.prefs.experimentalFeatures).toBe(false);
    expect(visiblePanelTabs(again.prefs).some((t) => t.id === "tether")).toBe(false);
  });

  it("leads the tab with the plain disclaimer, folded but labeled", () => {
    render(<TetherTab state={gatedOn()} dispatch={() => {}} />);
    const note = screen.getByTestId("tether-disclaimer");
    // First thing in the tab, not a footnote; the label carries the
    // gist while the body is folded away.
    expect(screen.getByTestId("tether-tab").firstElementChild).toBe(note);
    expect(note.textContent).toContain("DISCLAIMER: Early Preview");
    expect(note.textContent).not.toContain("support@heeler.app");
    fireEvent.click(screen.getByTestId("tether-disclaimer-toggle"));
    expect(note.textContent).toMatch(/untested/i);
    expect(note.textContent).toMatch(/folder/i);
    // Where reports and feedback go.
    expect(note.textContent).toContain("support@heeler.app");
  });

  it("names the folders in words that say what they are for", () => {
    render(<TetherTab state={gatedOn()} dispatch={() => {}} />);
    const tab = screen.getByTestId("tether-tab");
    expect(tab.textContent).toContain("Destination");
    expect(tab.textContent).not.toContain("Move to");
    expect(tab.textContent).toContain("Watch folder");
    // The field says where the photos write; the why folds out beside it.
    expect(screen.getByTestId("tether-dest").textContent).toBe("Set the folder the photos will write to");
    const note = screen.getByTestId("tether-hot-note");
    fireEvent.click(screen.getByTestId("tether-hot-note-toggle"));
    expect(note.textContent).toMatch(/tether software/);
    expect(note.textContent).toMatch(/stays empty/i);
  });

  it("says that START SESSION is only for the folder watch", () => {
    render(<TetherTab state={gatedOn()} dispatch={() => {}} />);
    const note = screen.getByTestId("tether-start-note");
    expect(note.textContent).toMatch(/watches the Watch folder/);
    expect(note.textContent).toMatch(/needs no Start/);
  });
});

describe("the camera section", () => {
  it("distinguishes detected-but-wrong-mode from ready, with no dead controls", async () => {
    render(<TetherTab state={initialState()} dispatch={() => {}} />);
    // The scan resolves on mount.
    expect(await screen.findByText(/DC-G9M3/)).toBeTruthy();
    // The PTP body offers Connect; the card-reader body says why not
    // instead of offering a button that would fail.
    expect(screen.getByTestId("tether-connect-04da:2372:0:4")).toBeTruthy();
    expect(screen.queryByTestId("tether-connect-04a9:1234:0:9")).toBeNull();
    expect(screen.getByText(/card-reader mode/)).toBeTruthy();
    // No camera connected, so no capture control exists at all.
    expect(screen.queryByTestId("tether-capture")).toBeNull();
    expect(screen.getByTestId("tether-refresh")).toBeTruthy();
    expect(screen.getByTestId("tether-copy-diagnostics")).toBeTruthy();
  });

  it("says when nothing camera-shaped answered", async () => {
    const saved = mockScan;
    mockScan = { devices: [], report: "empty" };
    render(<TetherTab state={initialState()} dispatch={() => {}} />);
    expect(await screen.findByText(/No camera seen on USB/)).toBeTruthy();
    mockScan = saved;
  });

  it("connects and then offers capture only with somewhere to land", async () => {
    render(<TetherTab state={initialState()} dispatch={() => {}} />);
    fireEvent.click(await screen.findByTestId("tether-connect-04da:2372:0:4"));
    expect(await screen.findByTestId("tether-camera-status")).toHaveTextContent(/DC-G9M3/);
    const capture = screen.getByTestId("tether-capture") as HTMLButtonElement;
    // No destination and no hot folder: the control says what it needs.
    expect(capture.disabled).toBe(true);
    expect(screen.getByTestId("tether-disconnect")).toBeTruthy();
  });

  it("shows the exposure group from the body's own descriptors, formatted", async () => {
    render(<TetherTab state={initialState()} dispatch={() => {}} />);
    fireEvent.click(await screen.findByTestId("tether-connect-04da:2372:0:4"));
    const labels = (el: HTMLElement) => menuRows(el).map(([, l]) => l).join(" | ");
    const iso = await screen.findByTestId("tether-exposure-iso");
    expect(menuValue(iso)).toBe("400");
    expect(labels(iso)).toContain("Auto");
    const shutter = screen.getByTestId("tether-exposure-shutter");
    expect(labels(shutter)).toContain("Bulb");
    expect(labels(shutter)).toContain("60 s");
    expect(labels(shutter)).toContain("1/40");
    expect(labels(shutter)).toContain("1/8000");
    const aperture = screen.getByTestId("tether-exposure-aperture");
    expect(labels(aperture)).toContain("f/8.0");
    expect(labels(aperture)).toContain("f/22.0");
    // A property that did not answer is said in words, not faked.
    expect(screen.getByTestId("tether-exposure-failed").textContent).toMatch(/white balance/i);
    expect(screen.getByTestId("tether-battery").textContent).toBe("Battery 87%");
  });

  it("setting a value sends the base code and follows the re-read state", async () => {
    const { usbCameraSetExposure } = await import("../bridge");
    render(<TetherTab state={initialState()} dispatch={() => {}} />);
    fireEvent.click(await screen.findByTestId("tether-connect-04da:2372:0:4"));
    const iso = await screen.findByTestId("tether-exposure-iso");
    choose(iso, "800");
    expect(usbCameraSetExposure).toHaveBeenCalledWith(0x02000020, 800);
    // The control shows what the re-read answered, not the optimism.
    expect(menuValue(await screen.findByTestId("tether-exposure-iso"))).toBe("800");
  });

  it("keeps the exposure group hidden until a body connects", async () => {
    render(<TetherTab state={initialState()} dispatch={() => {}} />);
    await screen.findByText(/DC-G9M3/);
    expect(screen.queryByTestId("tether-exposure")).toBeNull();
  });

  it("pumps live view frames only while the toggle is on, and stops the stream", async () => {
    const { usbCameraLiveviewStart, usbCameraLiveviewStop } = await import("../bridge");
    render(<TetherTab state={initialState()} dispatch={() => {}} />);
    // No body: no dead toggle.
    expect(screen.queryByTestId("tether-liveview")).toBeNull();
    fireEvent.click(await screen.findByTestId("tether-connect-04da:2372:0:4"));
    const toggle = await screen.findByTestId("tether-liveview");
    fireEvent.click(toggle);
    expect(usbCameraLiveviewStart).toHaveBeenCalled();
    const frame = (await screen.findByTestId("tether-liveview-frame")) as HTMLImageElement;
    expect(frame.src).toContain("data:image/jpeg;base64,");
    expect(screen.getByTestId("tether-liveview-fps").textContent).toMatch(/measuring|fps measured/);
    // Off: the body gets the stop parameter and the frame goes away.
    fireEvent.click(screen.getByTestId("tether-liveview"));
    expect(usbCameraLiveviewStop).toHaveBeenCalled();
    expect(screen.queryByTestId("tether-liveview-box")).toBeNull();
  });

  it("a failing pump stops itself instead of lying frozen", async () => {
    const saved = mockLiveFrame;
    const { usbCameraLiveviewFrame } = await import("../bridge");
    (usbCameraLiveviewFrame as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("cable out"));
    render(<TetherTab state={initialState()} dispatch={() => {}} />);
    fireEvent.click(await screen.findByTestId("tether-connect-04da:2372:0:4"));
    fireEvent.click(await screen.findByTestId("tether-liveview"));
    // The stream starts (a box, no frame yet), then three errors in a
    // row and the toggle lets go instead of lying frozen.
    await screen.findByTestId("tether-liveview-box");
    await waitFor(() => expect(screen.queryByTestId("tether-liveview-box")).toBeNull(), { timeout: 3000 });
    (usbCameraLiveviewFrame as ReturnType<typeof vi.fn>).mockImplementation(async () => saved);
    mockLiveFrame = saved;
  });

  it("pauses the frame pump while a capture is in flight", async () => {
    const { usbCameraCapture, usbCameraLiveviewFrame } = await import("../bridge");
    type Mock = ReturnType<typeof vi.fn>;
    const captureMock = usbCameraCapture as Mock;
    const frameMock = usbCameraLiveviewFrame as Mock;
    let release!: () => void;
    captureMock.mockImplementation(
      () => new Promise((res) => { release = () => res({ images: [], session_count: 0 }); }),
    );
    const s: State = {
      ...initialState(),
      prefs: { ...initialState().prefs, tetherDestination: "/shoots/incoming" },
    };
    render(<TetherTab state={s} dispatch={() => {}} />);
    fireEvent.click(await screen.findByTestId("tether-connect-04da:2372:0:4"));
    fireEvent.click(await screen.findByTestId("tether-liveview"));
    await screen.findByTestId("tether-liveview-frame");
    const callsBefore = frameMock.mock.calls.length;
    fireEvent.click(screen.getByTestId("tether-capture"));
    // Several pump intervals pass with the capture in flight; at most
    // the one tick already in the air may land.
    await new Promise((r) => setTimeout(r, 120));
    expect(frameMock.mock.calls.length).toBeLessThanOrEqual(callsBefore + 1);
    release();
    await waitFor(() => expect(frameMock.mock.calls.length).toBeGreaterThan(callsBefore + 1));
    captureMock.mockImplementation(async () => ({ images: [], session_count: 0 }));
  });

  it("drives focus only over a running stream, with the body's own modes", async () => {
    const { usbCameraFocusDrive, usbCameraAutofocus } = await import("../bridge");
    render(<TetherTab state={initialState()} dispatch={() => {}} />);
    // No body: no dead row.
    expect(screen.queryByTestId("tether-focus")).toBeNull();
    fireEvent.click(await screen.findByTestId("tether-connect-04da:2372:0:4"));
    // Connected but stream off: the row shows, the buttons stay off
    // (the body refuses every drive without the stream).
    const nearFast = (await screen.findByTestId("tether-focus-4")) as HTMLButtonElement;
    expect(nearFast.disabled).toBe(true);
    const af = screen.getByTestId("tether-af") as HTMLButtonElement;
    expect(af.disabled).toBe(true);
    fireEvent.click(screen.getByTestId("tether-liveview"));
    await screen.findByTestId("tether-liveview-frame");
    expect((screen.getByTestId("tether-focus-4") as HTMLButtonElement).disabled).toBe(false);
    // Left drives closer, right drives farther; one chevron small, two big.
    fireEvent.click(screen.getByTestId("tether-focus-4"));
    expect(usbCameraFocusDrive).toHaveBeenCalledWith(4);
    fireEvent.click(screen.getByTestId("tether-focus-1"));
    expect(usbCameraFocusDrive).toHaveBeenCalledWith(1);
    // Autofocus sits between the halves and shares the stream gate.
    expect((screen.getByTestId("tether-af") as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByTestId("tether-af"));
    expect(usbCameraAutofocus).toHaveBeenCalled();
  });

  it("passes the AF-on-capture option through to the capture call", async () => {
    const { usbCameraCapture } = await import("../bridge");
    const captureMock = usbCameraCapture as ReturnType<typeof vi.fn>;
    captureMock.mockClear();
    const s: State = {
      ...initialState(),
      prefs: { ...initialState().prefs, tetherDestination: "/shoots/incoming" },
    };
    render(<TetherTab state={s} dispatch={() => {}} />);
    fireEvent.click(await screen.findByTestId("tether-connect-04da:2372:0:4"));
    const toggle = (await screen.findByTestId("tether-af-on-capture")) as HTMLButtonElement;
    // Default off: a plain capture carries no AF request.
    fireEvent.click(screen.getByTestId("tether-capture"));
    await waitFor(() => expect(captureMock).toHaveBeenCalled());
    expect(captureMock.mock.calls[0][0].af).toBe(false);
    // On: the sweep runs before the shutter.
    fireEvent.click(toggle);
    fireEvent.click(screen.getByTestId("tether-capture"));
    await waitFor(() => expect(captureMock.mock.calls.length).toBe(2));
    expect(captureMock.mock.calls[1][0].af).toBe(true);
  });

  // Tests ahead of the 26.4.3 second refactor (entryrows.test.ts): an
  // arrival becomes the ribbon's entry with its identity, rating, edits
  // and missing mark, read the way the app reads them.
  it("a captured arrival lands in the ribbon as an entry of its row", async () => {
    const { usbCameraCapture } = await import("../bridge");
    const captureMock = usbCameraCapture as ReturnType<typeof vi.fn>;
    captureMock.mockResolvedValueOnce({
      images: [{ id: "t9", name: "P1.RW2", stars: 2, flag: "pick", edited: true, missing: true, linkGroup: "g1", renderedBake: true, phoneRendered: true, renderedFrames: true, bakedFrom: "a.jpg", folder: "/shoots/incoming" }],
      session_count: 1,
    });
    const sent: Command[] = [];
    const s: State = {
      ...initialState(),
      activeFolderPath: "/shoots/incoming",
      prefs: { ...initialState().prefs, tetherDestination: "/shoots/incoming" },
    };
    render(<TetherTab state={s} dispatch={(c) => sent.push(c)} />);
    fireEvent.click(await screen.findByTestId("tether-connect-04da:2372:0:4"));
    await screen.findByTestId("tether-capture");
    fireEvent.click(screen.getByTestId("tether-capture"));
    await waitFor(() => expect(sent.some((c) => c.type === "append_images")).toBe(true));
    const got = (sent.find((c) => c.type === "append_images") as Extract<Command, { type: "append_images" }>).images[0];
    expect({ id: got.id, name: got.name, stars: got.stars, flag: got.flag, edited: !!got.edited, missing: !!got.missing, filter: got.filter, src: got.src })
      .toEqual({ id: "t9", name: "P1.RW2", stars: 2, flag: "pick", edited: true, missing: true, filter: "none", src: "" });
  });

  // And no field the desktop sent is dropped (2026-10-08, the panorama's
  // lost phoneRendered): its link group, how it was rendered, its origin.
  it("a captured arrival keeps every field of its row", async () => {
    const { usbCameraCapture } = await import("../bridge");
    (usbCameraCapture as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      images: [{ id: "t8", name: "P2.DNG", stars: 0, flag: "", linkGroup: "g1", renderedBake: true, phoneRendered: true, renderedFrames: true, bakedFrom: "a.jpg", folder: "/shoots/incoming" }],
      session_count: 1,
    });
    const sent: Command[] = [];
    const s: State = {
      ...initialState(),
      activeFolderPath: "/shoots/incoming",
      prefs: { ...initialState().prefs, tetherDestination: "/shoots/incoming" },
    };
    render(<TetherTab state={s} dispatch={(c) => sent.push(c)} />);
    fireEvent.click(await screen.findByTestId("tether-connect-04da:2372:0:4"));
    await screen.findByTestId("tether-capture");
    fireEvent.click(screen.getByTestId("tether-capture"));
    await waitFor(() => expect(sent.some((c) => c.type === "append_images")).toBe(true));
    const got = (sent.find((c) => c.type === "append_images") as Extract<Command, { type: "append_images" }>).images[0];
    expect({ linkGroup: got.linkGroup, renderedBake: got.renderedBake, phoneRendered: got.phoneRendered, renderedFrames: got.renderedFrames, bakedFrom: got.bakedFrom })
      .toEqual({ linkGroup: "g1", renderedBake: true, phoneRendered: true, renderedFrames: true, bakedFrom: "a.jpg" });
  });

  it("a poll blocked on the camera does not delay a settings save", async () => {
    // The injected delay stands in for the stuck camera: the card poll's answer never arrives while the
    // photographer changes a setting. Against the old inline body the
    // poll held an async-runtime worker for the whole wait, and every
    // other async command queued behind it, saves included. The
    // desktop's shape test pins the move to spawn_blocking; this probe
    // pins the frontend half, that the panel's in-flight poll is not
    // something the save path waits on.
    let release!: (v: { images: TetherImage[]; session_count: number }) => void;
    const blocked = new Promise<{ images: TetherImage[]; session_count: number }>((r) => {
      release = r;
    });
    const pollMock = usbCameraPoll as ReturnType<typeof vi.fn>;
    pollMock.mockImplementation(() => blocked);
    const saveMock = saveUiSettings as ReturnType<typeof vi.fn>;
    saveMock.mockClear();
    const s: State = {
      ...initialState(),
      prefs: { ...initialState().prefs, tetherDestination: "/shoots/incoming", tetherPollMs: 500 },
    };
    render(<TetherTab state={s} dispatch={() => {}} />);
    fireEvent.click(await screen.findByTestId("tether-connect-04da:2372:0:4"));
    await screen.findByTestId("tether-capture");
    // The watch's first poll is in flight and stuck on the camera.
    await waitFor(() => expect(pollMock).toHaveBeenCalled(), { timeout: 4000 });
    // The settings save, armed the way the app arms it, lands anyway.
    catalogSaves.arm("ui-settings", 250, () => saveUiSettings("{}"));
    await flushRecoverySaves();
    expect(saveMock).toHaveBeenCalled();
    // The poll still gets its answer when the camera comes back.
    release({ images: [], session_count: 0 });
    pollMock.mockImplementation(async () => ({ images: [], session_count: 0 }));
  });

  it("a live view frame stuck on the camera does not hold up an autofocus", async () => {
    // Same probe for the live view batch: a frame request whose answer
    // never arrives stands in for the body stalling mid-stream. The
    // autofocus click must reach the bridge without waiting for that
    // frame; against the old inline bodies every async command queued
    // behind the stuck one.
    const { usbCameraLiveviewFrame, usbCameraAutofocus } = await import("../bridge");
    type Mock = ReturnType<typeof vi.fn>;
    const frameMock = usbCameraLiveviewFrame as Mock;
    const afMock = usbCameraAutofocus as Mock;
    render(<TetherTab state={initialState()} dispatch={() => {}} />);
    fireEvent.click(await screen.findByTestId("tether-connect-04da:2372:0:4"));
    fireEvent.click(await screen.findByTestId("tether-liveview"));
    await screen.findByTestId("tether-liveview-frame");
    // The stream is up; now the next frame sticks on the camera.
    let release!: (v: string | null) => void;
    const blocked = new Promise<string | null>((r) => { release = r; });
    const callsBefore = frameMock.mock.calls.length;
    frameMock.mockImplementation(() => blocked);
    await waitFor(() => expect(frameMock.mock.calls.length).toBeGreaterThan(callsBefore));
    afMock.mockClear();
    fireEvent.click(screen.getByTestId("tether-af"));
    expect(afMock).toHaveBeenCalled();
    // The frame still lands when the body answers.
    release("data:image/jpeg;base64,/9j/4AAQ");
    frameMock.mockImplementation(async () => mockLiveFrame);
  });
});
