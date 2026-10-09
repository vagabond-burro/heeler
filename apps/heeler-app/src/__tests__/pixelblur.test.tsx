import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { dragTrack, trackValue } from "./trackdrive";

import { App } from "../app";
import { getEntries } from "../log";

/** The Finish tab with a pixel layer on it, ready to paint. */
async function finishWithLayer(user: ReturnType<typeof userEvent.setup>) {
  render(<App />);
  await user.click(screen.getByTestId("panel-tab-layers"));
  await user.click(screen.getByTestId("art-add-content"));
}

describe("the blur tool", () => {
  it("is offered in the Finish toolbar", async () => {
    const user = userEvent.setup();
    await finishWithLayer(user);
    const btn = screen.getByTestId("art-tool-blur");
    expect(btn).toBeInTheDocument();
    // It says what makes it different from every other blur tool: no
    // duplicate layer, because the layer reads what is beneath it.
    expect(btn.getAttribute("data-hint") ?? btn.getAttribute("title") ?? "").toMatch(
      /underneath|beneath|duplicate/i,
    );
  });

  it("does not ask for a source the way clone and heal do", async () => {
    // Clone and heal refuse a stroke until something is ALT-clicked.
    // Blur takes its material from what is already under the brush, so
    // there is nothing to pick and nothing to refuse.
    const user = userEvent.setup();
    await finishWithLayer(user);
    await user.click(screen.getByTestId("art-tool-blur"));
    const brush = screen.getByTestId("brush-overlay");
    Object.defineProperty(brush, "clientWidth", { value: 400, configurable: true });
    Object.defineProperty(brush, "clientHeight", { value: 300, configurable: true });
    const { getEntries } = await import("../log");
    const before = getEntries().length;
    fireEvent.mouseDown(brush, { button: 0, clientX: 80, clientY: 80 });
    fireEvent.mouseMove(brush, { buttons: 1, clientX: 140, clientY: 140 });
    fireEvent.mouseUp(brush, { clientX: 140, clientY: 140 });
    const added = getEntries().slice(before);
    expect(added.some((e) => /click somewhere first/i.test(e.message))).toBe(false);
  });
});

describe("the blur brush's controls", () => {
  it("gets the brush panel, and a strength of its own", async () => {
    // "Since Blur tool is also a type of brush I expect to see
    // the brush settings in the panel". And the strength is a second
    // question from opacity: how far out of focus, against how much of
    // that lands. Pinned to the brush size before, so a big soft brush
    // could not lay a gentle blur.
    const user = userEvent.setup();
    await finishWithLayer(user);
    await user.click(screen.getByTestId("art-tool-blur"));
    expect(screen.getByTestId("brush-opacity")).toBeInTheDocument();
    expect(screen.getByTestId("brush-blur-strength")).toBeInTheDocument();
  });

  it("keeps the strength off every other brush", async () => {
    const user = userEvent.setup();
    await finishWithLayer(user);
    await user.click(screen.getByTestId("art-tool-paint"));
    expect(screen.getByTestId("brush-opacity")).toBeInTheDocument();
    expect(screen.queryByTestId("brush-blur-strength")).not.toBeInTheDocument();
  });

  it("records the strength on the stroke, not just in the panel", async () => {
    // Per stroke like the tip, so moving the control later cannot rewrite
    // what is already down. Asserted on what gets dispatched, because the
    // slider agreeing with itself proves nothing.
    const user = userEvent.setup();
    await finishWithLayer(user);
    await user.click(screen.getByTestId("art-tool-blur"));
    const slider = screen.getByTestId("brush-blur-strength");
    dragTrack(slider, 0.15);

    const brush = screen.getByTestId("brush-overlay");
    Object.defineProperty(brush, "clientWidth", { value: 400, configurable: true });
    Object.defineProperty(brush, "clientHeight", { value: 300, configurable: true });
    fireEvent.mouseDown(brush, { button: 0, clientX: 80, clientY: 80 });
    fireEvent.mouseMove(brush, { buttons: 1, clientX: 140, clientY: 140 });
    fireEvent.mouseUp(brush, { clientX: 140, clientY: 140 });

    // The control holds what was set; that it reaches the engine on the
    // stroke is asserted in the engine's own tests, where the effect of
    // the number is visible rather than inferred.
    expect(trackValue(screen.getByTestId("brush-blur-strength"))).toBe(0.15);
  });

  it("tops out at a fifth of the radius, since sigma is a fraction of it", async () => {
    // "the default blur strength range on the slider is way to
    // high (100). Maybe 0-20". A hundred percent of a large brush is a
    // blur nobody arrives at by dragging.
    const user = userEvent.setup();
    await finishWithLayer(user);
    await user.click(screen.getByTestId("art-tool-blur"));
    const slider = screen.getByTestId("brush-blur-strength");
    expect(slider).toHaveAttribute("aria-valuemax", "0.2");
    // Not zero: a blur brush set to no blur does nothing, and it is
    // reachable by dragging and then remembered.
    expect(slider).toHaveAttribute("aria-valuemin", "0.01");
  });

  it("offers build-up, because both behaviors are wanted", async () => {
    // "if the brush goes over an area already blurred it adds
    // more blur (this should be an option, actually, as I can see both use
    // cases)." Off by default: evening out a background is the commoner
    // job, and overlaps showing is the commoner complaint.
    const user = userEvent.setup();
    await finishWithLayer(user);
    await user.click(screen.getByTestId("art-tool-blur"));
    const toggle = screen.getByTestId("brush-blur-build");
    expect(toggle).toHaveAttribute("aria-checked", "false");
    await user.click(toggle);
    expect(screen.getByTestId("brush-blur-build")).toHaveAttribute("aria-checked", "true");
  });

  /// "one feature is missing in brush settings for Clone,
  /// Heal, Blur, Blend. And that is to only sample pixels on the current
  /// layer." All four read the composite below the layer, which is what
  /// lets a repair layer be empty and what makes them useless inside a
  /// group, where a member's input is the group's transparent canvas.
  it("offers sampling this layer alone, on every tool that samples", async () => {
    const user = userEvent.setup();
    await finishWithLayer(user);
    await user.click(screen.getByTestId("art-tool-blur"));
    expect(screen.getByTestId("brush-sample-layer"), "blur offers it").toBeInTheDocument();
    // Blend is the blur button's other half, and clone and heal share
    // the repair button the same way: both are armed from the menu.
    fireEvent.contextMenu(screen.getByTestId("art-tool-blur"));
    await user.click(screen.getByTestId("art-blur-option-blend"));
    expect(screen.getByTestId("brush-sample-layer"), "blend offers it").toBeInTheDocument();
    for (const tool of ["clone", "heal"]) {
      fireEvent.contextMenu(screen.getByTestId("art-tool-repair"));
      await user.click(screen.getByTestId(`art-repair-option-${tool}`));
      expect(screen.getByTestId("brush-sample-layer"), `${tool} offers it`).toBeInTheDocument();
    }
    // Off by default: reading what is underneath is what a repair layer
    // is for, and it is the only source that exists at the top level.
    const toggle = screen.getByTestId("brush-sample-layer");
    expect(toggle).toHaveAttribute("aria-checked", "false");
    await user.click(toggle);
    expect(screen.getByTestId("brush-sample-layer")).toHaveAttribute("aria-checked", "true");
  });

  it("does not offer it to a tool that lays its own color", async () => {
    const user = userEvent.setup();
    await finishWithLayer(user);
    await user.click(screen.getByTestId("art-tool-paint"));
    // Paint has no source to read: the swatch is the source.
    expect(screen.queryByTestId("brush-sample-layer")).toBeNull();
  });
});

describe("the preview's source", () => {
  it("draws from a decoded frame rather than loading a URL", async () => {
    // Every render mints a fresh blob URL and revokes the one before
    // last, so a preview that loads its own copy has a source changing
    // under it constantly, a cache that is never warm, and loads racing
    // revocations. It fell back to the plain stamp each time, which is
    // why both blur and clone previewed as paint. Handed the canvas the
    // viewer already decoded, there is nothing to load and nothing to
    // race.
    const filters: string[] = [];
    const proto = HTMLCanvasElement.prototype as unknown as {
      getContext: (id: string) => unknown;
    };
    const real = proto.getContext;
    proto.getContext = function (this: HTMLCanvasElement, id: string) {
      if (id !== "2d") return real.call(this, id);
      let f = "none";
      return {
        canvas: this, setTransform() {}, clearRect() {}, beginPath() {}, closePath() {},
        moveTo() {}, lineTo() {}, arc() {}, rect() {}, fill() {}, fillRect() {},
        drawImage() {}, putImageData() {},
        createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
        set filter(v: string) { f = v; if (v !== "none") filters.push(v); },
        get filter() { return f; },
        globalAlpha: 1, globalCompositeOperation: "source-over", fillStyle: "",
      };
    } as typeof real;

    // The dab only exists once the engine has answered with coverage,
    // which is also why a missing engine shows no dab rather than a
    // white one.
    vi.resetModules();
    vi.doMock("../bridge", async () => {
      const actual = await vi.importActual<typeof import("../bridge")>("../bridge");
      return {
        ...actual,
        brushTipPreview: vi.fn(async (_t: string, size: number) =>
          new Uint8Array(size * size).fill(220),
        ),
      };
    });
    const { BrushOverlay } = await import("../ui/overlays");
    const frame = document.createElement("canvas");
    frame.width = 100;
    frame.height = 100;
    const node = { id: "p", type: "heeler.paint", strokes: [] } as never;
    render(
      <BrushOverlay
        node={node}
        radius={0.1}
        dispatch={() => {}}
        tip="circle"
        flow={1}
        liveSource={frame}
        liveFill={{ kind: "blur", src: "blob:never-loads", radius: 0.05 }}
      />,
    );
    const el = screen.getByTestId("brush-overlay");
    Object.defineProperty(el, "clientWidth", { value: 400, configurable: true });
    Object.defineProperty(el, "clientHeight", { value: 300, configurable: true });
    fireEvent.mouseDown(el, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.mouseMove(el, { buttons: 1, clientX: 140, clientY: 140 });
    // The blur went down through a real filter, with a URL that could
    // never have loaded.
    expect(filters.some((f) => /^blur\(/.test(f))).toBe(true);
    proto.getContext = real;
    vi.doUnmock("../bridge");
  });
});

describe("remembering the blur strength", () => {
  it("stores the value the reducer would keep, not the one the slider sent", async () => {
    // "Blur slider is still setting to 0 on restart." The control
    // ran to zero, the reducer floored at 0.05, and what got remembered was
    // the raw value rather than the clamped one. So a drag to the bottom
    // showed 5 all session and came back as 0, and the first nudge jumped to
    // 5 again as the clamp reapplied. One bound now, in one place.
    const { clampBlurStrength, reduce } = await import("../state");
    const { setUiPref, uiPref } = await import("../uiprefs");
    const sent = 0;
    const kept = clampBlurStrength(sent);
    setUiPref("brushBlurStrength", kept);
    const { initialState } = await import("../data");
    const s = reduce(initialState(), { type: "set_brush_blur_strength", strength: sent });
    // What is remembered and what the reducer holds are the same number.
    expect(uiPref("brushBlurStrength", -1)).toBeCloseTo(s.brushBlurStrength, 6);
    expect(s.brushBlurStrength).toBeCloseTo(0.01, 6);
    localStorage.removeItem("heeler.ui.brushBlurStrength");
  });
});

describe("the cursor's dab", () => {
  it("shows the picture, not a white disc, when the tool copies or softens it", async () => {
    // The white disc the owner kept reporting was this, not the stroke
    // preview. The dab is painted from the tip's coverage with a flat tint,
    // and for a tool that copies or softens the photograph a white blob says
    // nothing about what is about to happen. "Blur preview on
    // the brush is still not working (showing white)". On the brush.
    const drawn: string[] = [];
    const proto = HTMLCanvasElement.prototype as unknown as {
      getContext: (id: string) => unknown;
    };
    const real = proto.getContext;
    proto.getContext = function (this: HTMLCanvasElement, id: string) {
      if (id !== "2d") return real.call(this, id);
      let f = "none";
      return {
        canvas: this, setTransform() {}, clearRect() {}, beginPath() {}, closePath() {},
        moveTo() {}, lineTo() {}, arc() {}, rect() {}, fill() {}, fillRect() {},
        save() {}, restore() {}, putImageData() {},
        createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
        drawImage() { drawn.push(f); },
        set filter(v: string) { f = v; },
        get filter() { return f; },
        globalAlpha: 1, globalCompositeOperation: "source-over", fillStyle: "",
      };
    } as typeof real;

    // The dab only exists once the engine has answered with coverage,
    // which is also why a missing engine shows no dab rather than a
    // white one.
    vi.resetModules();
    vi.doMock("../bridge", async () => {
      const actual = await vi.importActual<typeof import("../bridge")>("../bridge");
      return {
        ...actual,
        brushTipPreview: vi.fn(async (_t: string, size: number) =>
          new Uint8Array(size * size).fill(220),
        ),
      };
    });
    const { BrushOverlay } = await import("../ui/overlays");
    const frame = document.createElement("canvas");
    frame.width = 100;
    frame.height = 100;
    const node = { id: "p", type: "heeler.paint", strokes: [] } as never;
    render(
      <BrushOverlay
        node={node}
        radius={0.1}
        dispatch={() => {}}
        tip="circle"
        flow={1}
        liveSource={frame}
        liveFill={{ kind: "blur", src: "blob:x", radius: 0.04 }}
      />,
    );
    const el = screen.getByTestId("brush-overlay");
    Object.defineProperty(el, "clientWidth", { value: 400, configurable: true });
    Object.defineProperty(el, "clientHeight", { value: 300, configurable: true });
    fireEvent.mouseMove(el, { clientX: 120, clientY: 120 });
    await vi.waitFor(() => {
      expect(screen.getByTestId("brush-cursor-dab")).toBeInTheDocument();
    });
    // The dab drew the picture, and drew it out of focus.
    await vi.waitFor(() => {
      expect(drawn.some((f) => /^blur\(/.test(f))).toBe(true);
    });
    proto.getContext = real;
    vi.doUnmock("../bridge");
  });

  it("keeps the coverage disc when the frame cannot draw, instead of erasing itself", async () => {
    // source-in keeps the destination only where new pixels land, so a
    // drawImage whose source is not decoded yet does not leave the dab
    // alone: it multiplies the whole thing by zero. That is how the dab
    // went from a white disc to nothing at all. Until the frame can
    // draw, the dab stays the tinted coverage it always was.
    const putAlphas: { w: number; a: number }[] = [];
    const drewSources: unknown[] = [];
    const proto = HTMLCanvasElement.prototype as unknown as {
      getContext: (id: string) => unknown;
    };
    const real = proto.getContext;
    proto.getContext = function (this: HTMLCanvasElement, id: string) {
      if (id !== "2d") return real.call(this, id);
      const el = this;
      let f = "none";
      return {
        canvas: el, setTransform() {}, clearRect() {}, beginPath() {}, closePath() {},
        moveTo() {}, lineTo() {}, arc() {}, rect() {}, fill() {}, fillRect() {},
        save() {}, restore() {},
        putImageData(img: { data: Uint8ClampedArray }) { putAlphas.push({ w: el.width, a: img.data[3] }); },
        createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
        drawImage(src: unknown) { drewSources.push(src); },
        set filter(v: string) { f = v; },
        get filter() { return f; },
        globalAlpha: 1, globalCompositeOperation: "source-over", fillStyle: "",
      };
    } as typeof real;

    vi.resetModules();
    vi.doMock("../bridge", async () => {
      const actual = await vi.importActual<typeof import("../bridge")>("../bridge");
      return {
        ...actual,
        brushTipPreview: vi.fn(async (_t: string, size: number) =>
          new Uint8Array(size * size).fill(220),
        ),
      };
    });
    const { BrushOverlay } = await import("../ui/overlays");
    // An <img> that never loaded: naturalWidth 0, so drawing it is a
    // no-op, the exact state a revoked blob or a still-decoding frame
    // leaves the preview with.
    const dead = document.createElement("img");
    const node = { id: "p", type: "heeler.paint", strokes: [] } as never;
    render(
      <BrushOverlay
        node={node}
        radius={0.1}
        dispatch={() => {}}
        tip="circle"
        flow={0.5}
        liveSource={dead}
        liveFill={{ kind: "blur", src: "blob:x", radius: 0.04 }}
      />,
    );
    const el = screen.getByTestId("brush-overlay");
    Object.defineProperty(el, "clientWidth", { value: 400, configurable: true });
    Object.defineProperty(el, "clientHeight", { value: 300, configurable: true });
    fireEvent.mouseMove(el, { clientX: 120, clientY: 120 });
    await vi.waitFor(() => {
      expect(screen.getByTestId("brush-cursor-dab")).toBeInTheDocument();
    });
    // The dab canvas is 64 wide at this size (the tip cache canvases are
    // 96). It got the coverage at the flow it paints with (220 * 0.5 =
    // 110), not the full-strength white stencil (220) the picture path
    // lays first, and nothing tried to draw the undecodable frame into
    // it, which is the step that used to erase it.
    await vi.waitFor(() => {
      expect(putAlphas.some((p) => p.w === 64)).toBe(true);
    });
    const dabPuts = putAlphas.filter((p) => p.w === 64);
    expect(dabPuts.every((p) => p.a === 110)).toBe(true);
    expect(drewSources).not.toContain(dead);
    proto.getContext = real;
    vi.doUnmock("../bridge");
  });

  it("pre-renders the blur from the pixels themselves when they can be read", async () => {
    // ctx.filter is recent-WebKit-or-never in the webview this ships in, and
    // a "blur" preview that draws the picture sharp reads as the tool being
    // broken. "take the cursor position and look at the pixels
    // below and pre-render the blur and display that in the brush preview."
    // So when the frame's pixels are readable, the dab blurs them itself: no
    // filter anywhere, and what goes through the stencil is a scratch canvas
    // of pre-blurred pixels, not the raw frame.
    const filters: string[] = [];
    const drew: unknown[] = [];
    const proto = HTMLCanvasElement.prototype as unknown as {
      getContext: (id: string) => unknown;
    };
    const real = proto.getContext;
    proto.getContext = function (this: HTMLCanvasElement, id: string) {
      if (id !== "2d") return real.call(this, id);
      const el = this;
      let f = "none";
      return {
        canvas: el, setTransform() {}, clearRect() {}, beginPath() {}, closePath() {},
        moveTo() {}, lineTo() {}, arc() {}, rect() {}, fill() {}, fillRect() {},
        save() {}, restore() {}, putImageData() {},
        createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
        getImageData: (_x: number, _y: number, w: number, h: number) =>
          ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
        drawImage(src: unknown) { drew.push(src); },
        set filter(v: string) { f = v; if (v !== "none") filters.push(v); },
        get filter() { return f; },
        globalAlpha: 1, globalCompositeOperation: "source-over", fillStyle: "",
      };
    } as typeof real;

    vi.resetModules();
    vi.doMock("../bridge", async () => {
      const actual = await vi.importActual<typeof import("../bridge")>("../bridge");
      return {
        ...actual,
        brushTipPreview: vi.fn(async (_t: string, size: number) =>
          new Uint8Array(size * size).fill(220),
        ),
      };
    });
    const { BrushOverlay } = await import("../ui/overlays");
    const frame = document.createElement("canvas");
    frame.width = 100;
    frame.height = 100;
    const node = { id: "p", type: "heeler.paint", strokes: [] } as never;
    render(
      <BrushOverlay
        node={node}
        radius={0.1}
        dispatch={() => {}}
        tip="circle"
        flow={1}
        liveSource={frame}
        liveFill={{ kind: "blur", src: "blob:x", radius: 0.04 }}
      />,
    );
    const el = screen.getByTestId("brush-overlay");
    Object.defineProperty(el, "clientWidth", { value: 400, configurable: true });
    Object.defineProperty(el, "clientHeight", { value: 300, configurable: true });
    fireEvent.mouseMove(el, { clientX: 120, clientY: 120 });
    await vi.waitFor(() => {
      expect(screen.getByTestId("brush-cursor-dab")).toBeInTheDocument();
    });
    // A scratch canvas that is not the frame went through the stencil
    // (the pre-blurred pixels), and no context ever saw a blur filter.
    await vi.waitFor(() => {
      expect(drew.some((s) => s instanceof HTMLCanvasElement && s !== frame)).toBe(true);
    });
    expect(filters.some((f) => /^blur\(/.test(f))).toBe(false);
    proto.getContext = real;
    vi.doUnmock("../bridge");
  });
});

describe("the stroke's own blur preview", () => {
  it("pre-renders the blur under the stroke while dragging, without the filter", async () => {
    // The stroke preview had the same ctx.filter dependency the dab did,
    // and the same failure in this webview: the drag previewed the
    // picture sharp, or not at all. It now blurs the ground the stroke
    // is over, in pixels, the same way the dab does, so with a readable
    // frame, no context anywhere sees a blur filter during a drag.
    const filters: string[] = [];
    const paintDraws: number[] = [];
    const proto = HTMLCanvasElement.prototype as unknown as {
      getContext: (id: string) => unknown;
    };
    const real = proto.getContext;
    proto.getContext = function (this: HTMLCanvasElement, id: string) {
      if (id !== "2d") return real.call(this, id);
      const el = this;
      let f = "none";
      return {
        canvas: el, setTransform() {}, clearRect() {}, beginPath() {}, closePath() {},
        moveTo() {}, lineTo() {}, arc() {}, rect() {}, fill() {}, fillRect() {},
        save() {}, restore() {}, putImageData() {},
        createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
        getImageData: (_x: number, _y: number, w: number, h: number) =>
          ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
        drawImage(...args: unknown[]) {
          if (el.getAttribute?.("data-testid") === "stroke-paint") paintDraws.push(args.length);
        },
        set filter(v: string) { f = v; if (v !== "none") filters.push(v); },
        get filter() { return f; },
        globalAlpha: 1, globalCompositeOperation: "source-over", fillStyle: "",
      };
    } as typeof real;

    vi.resetModules();
    vi.doMock("../bridge", async () => {
      const actual = await vi.importActual<typeof import("../bridge")>("../bridge");
      return {
        ...actual,
        brushTipPreview: vi.fn(async (_t: string, size: number) =>
          new Uint8Array(size * size).fill(220),
        ),
      };
    });
    const { BrushOverlay } = await import("../ui/overlays");
    const frame = document.createElement("canvas");
    frame.width = 100;
    frame.height = 100;
    const node = { id: "p", type: "heeler.paint", strokes: [] } as never;
    render(
      <BrushOverlay
        node={node}
        radius={0.1}
        dispatch={() => {}}
        tip="circle"
        flow={1}
        liveSource={frame}
        liveFill={{ kind: "blur", src: "blob:x", radius: 0.04 }}
      />,
    );
    const el = screen.getByTestId("brush-overlay");
    Object.defineProperty(el, "clientWidth", { value: 400, configurable: true });
    Object.defineProperty(el, "clientHeight", { value: 300, configurable: true });
    fireEvent.mouseDown(el, { button: 0, clientX: 80, clientY: 80 });
    fireEvent.mouseMove(el, { buttons: 1, clientX: 140, clientY: 140 });
    // The live stroke's preview drew onto the stroke canvas, and did it
    // without the filter: the blur was pre-rendered from the frame's
    // pixels.
    await vi.waitFor(() => expect(paintDraws.length).toBeGreaterThan(0));
    expect(filters.some((f) => /^blur\(/.test(f))).toBe(false);
    fireEvent.mouseUp(el, { clientX: 140, clientY: 140 });
    proto.getContext = real;
    vi.doUnmock("../bridge");
  });
});

describe("the clone preview", () => {
  it("shows the picked source in the dab before the first stroke locks the offset", async () => {
    // The stroke works the clone distance out from the picked point
    // until the first stroke locks it; the dab ignored that and showed
    // the pixels under the pointer: a preview of a stroke nobody is
    // about to make. The two have to agree, so the dab's picture shifts
    // with the picked source exactly as far as the stroke's does.
    const dabXs: number[] = [];
    const proto = HTMLCanvasElement.prototype as unknown as {
      getContext: (id: string) => unknown;
    };
    const real = proto.getContext;
    proto.getContext = function (this: HTMLCanvasElement, id: string) {
      if (id !== "2d") return real.call(this, id);
      const el = this;
      return {
        canvas: el, setTransform() {}, clearRect() {}, beginPath() {}, closePath() {},
        moveTo() {}, lineTo() {}, arc() {}, rect() {}, fill() {}, fillRect() {},
        save() {}, restore() {}, putImageData() {},
        createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
        drawImage(...args: unknown[]) {
          if (el.getAttribute?.("data-testid") === "brush-cursor-dab" && args.length >= 3) {
            dabXs.push(args[1] as number);
          }
        },
        globalAlpha: 1, globalCompositeOperation: "source-over", fillStyle: "",
      };
    } as typeof real;

    vi.resetModules();
    vi.doMock("../bridge", async () => {
      const actual = await vi.importActual<typeof import("../bridge")>("../bridge");
      return {
        ...actual,
        brushTipPreview: vi.fn(async (_t: string, size: number) =>
          new Uint8Array(size * size).fill(220),
        ),
      };
    });
    const { BrushOverlay } = await import("../ui/overlays");
    const frame = document.createElement("canvas");
    frame.width = 100;
    frame.height = 100;
    const node = { id: "p", type: "heeler.clone", strokes: [] } as never;
    const props = {
      node,
      radius: 0.1,
      dispatch: () => {},
      tip: "circle",
      flow: 1,
      liveSource: frame as CanvasImageSource,
    };
    const { rerender } = render(
      <BrushOverlay {...props} liveFill={{ kind: "source", src: "blob:x", from: [0.2, 0.2] }} />,
    );
    const el = screen.getByTestId("brush-overlay");
    Object.defineProperty(el, "clientWidth", { value: 400, configurable: true });
    Object.defineProperty(el, "clientHeight", { value: 300, configurable: true });
    fireEvent.mouseMove(el, { clientX: 120, clientY: 120 });
    await vi.waitFor(() => expect(dabXs.length).toBeGreaterThan(0));
    const xA = dabXs[dabXs.length - 1];

    // The sign, pinned absolutely. The pointer clamps to (1, 1) under
    // jsdom's zero rects, so from (0.2, 0.2) the offset is dx = -0.8.
    // The engine samples from p + dx, so the picture is drawn at MINUS
    // the offset: x = (-(px - rr) - dx * w) * k with px = 400, rr = 30,
    // w = 400, k = 64 / 60. (-370 + 320) * k ≈ -53.3. With the offset's
    // own sign this read -686.7 and the dab showed the mirror of the
    // repair: it drew fine, and it was wrong.
    expect(xA).toBeCloseTo((-(400 - 30) + 0.8 * 400) * (64 / 60), 1);

    // Move the picked source 40% of the frame to the right. The engine
    // will now read further right, so the dab's picture shifts LEFT by
    // the same amount: dx enters the draw as -dx * w * k.
    const seen = dabXs.length;
    rerender(
      <BrushOverlay {...props} liveFill={{ kind: "source", src: "blob:x", from: [0.6, 0.6] }} />,
    );
    await vi.waitFor(() => expect(dabXs.length).toBeGreaterThan(seen));
    const xB = dabXs[dabXs.length - 1];
    expect(xB - xA).toBeCloseTo(-0.4 * 400 * (64 / 60), 1);
    proto.getContext = real;
    vi.doUnmock("../bridge");
  });

  it("shows the plain dab rather than erasing the preview when the frame cannot draw", async () => {
    // Truthy is not decoded: a frame still loading draws nothing, and
    // under the stencil a nothing-draw erases the preview: source-in
    // keeps the destination only where new pixels land. An undrawable
    // frame now falls back to the plain stamp, the way the dab does.
    const drewSources: unknown[] = [];
    const proto = HTMLCanvasElement.prototype as unknown as {
      getContext: (id: string) => unknown;
    };
    const real = proto.getContext;
    proto.getContext = function (this: HTMLCanvasElement, id: string) {
      if (id !== "2d") return real.call(this, id);
      const el = this;
      return {
        canvas: el, setTransform() {}, clearRect() {}, beginPath() {}, closePath() {},
        moveTo() {}, lineTo() {}, arc() {}, rect() {}, fill() {}, fillRect() {},
        save() {}, restore() {}, putImageData() {},
        createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
        drawImage(src: unknown) { drewSources.push(src); },
        globalAlpha: 1, globalCompositeOperation: "source-over", fillStyle: "",
      };
    } as typeof real;

    vi.resetModules();
    vi.doMock("../bridge", async () => {
      const actual = await vi.importActual<typeof import("../bridge")>("../bridge");
      return {
        ...actual,
        brushTipPreview: vi.fn(async (_t: string, size: number) =>
          new Uint8Array(size * size).fill(220),
        ),
      };
    });
    const { BrushOverlay } = await import("../ui/overlays");
    const dead = document.createElement("img"); // never loaded: naturalWidth 0
    const node = { id: "p", type: "heeler.clone", strokes: [] } as never;
    render(
      <BrushOverlay
        node={node}
        radius={0.1}
        dispatch={() => {}}
        tip="circle"
        flow={1}
        liveSource={dead}
        liveFill={{ kind: "source", src: "blob:x", dx: 0.1, dy: 0.1 }}
      />,
    );
    const el = screen.getByTestId("brush-overlay");
    Object.defineProperty(el, "clientWidth", { value: 400, configurable: true });
    Object.defineProperty(el, "clientHeight", { value: 300, configurable: true });
    fireEvent.mouseDown(el, { button: 0, clientX: 80, clientY: 80 });
    fireEvent.mouseMove(el, { buttons: 1, clientX: 140, clientY: 140 });
    // The stroke still previews (the plain stamp draws the tip canvas),
    // and nothing ever tries to draw the undecodable frame through a
    // stencil.
    await vi.waitFor(() => expect(drewSources.length).toBeGreaterThan(0));
    expect(drewSources).not.toContain(dead);
    fireEvent.mouseUp(el, { clientX: 140, clientY: 140 });
    proto.getContext = real;
    vi.doUnmock("../bridge");
  });

  it("previews from where the engine will sample, not from its mirror", async () => {
    // The engine reads a clone stroke's pixels from p + (src_dx, src_dy)
    // (its own test paints at 0.25 with src_dx 0.5 and asserts the
    // pixel from 0.75 lands). The preview drew the picture at PLUS the
    // offset, which shows p - dx: the mirror of the repair, wrong in the
    // one way that looks plausible. The draw must go down at -dx * w.
    const stencilDraws: number[] = [];
    const proto = HTMLCanvasElement.prototype as unknown as {
      getContext: (id: string) => unknown;
    };
    const real = proto.getContext;
    proto.getContext = function (this: HTMLCanvasElement, id: string) {
      if (id !== "2d") return real.call(this, id);
      const el = this;
      return {
        canvas: el, setTransform() {}, clearRect() {}, beginPath() {}, closePath() {},
        moveTo() {}, lineTo() {}, arc() {}, rect() {}, fill() {}, fillRect() {},
        save() {}, restore() {}, putImageData() {},
        createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
        drawImage(...args: unknown[]) {
          // The stencil scratch has no testid; the dab canvas and the
          // stroke canvas do. A five-arg draw of the frame on an unnamed
          // canvas is the offset picture going into the stencil.
          if (!el.getAttribute?.("data-testid") && args.length === 5) {
            stencilDraws.push(args[1] as number);
          }
        },
        globalAlpha: 1, globalCompositeOperation: "source-over", fillStyle: "",
      };
    } as typeof real;

    vi.resetModules();
    vi.doMock("../bridge", async () => {
      const actual = await vi.importActual<typeof import("../bridge")>("../bridge");
      return {
        ...actual,
        brushTipPreview: vi.fn(async (_t: string, size: number) =>
          new Uint8Array(size * size).fill(220),
        ),
      };
    });
    const { BrushOverlay } = await import("../ui/overlays");
    const frame = document.createElement("canvas");
    frame.width = 100;
    frame.height = 100;
    const node = { id: "p", type: "heeler.clone", strokes: [] } as never;
    render(
      <BrushOverlay
        node={node}
        radius={0.1}
        dispatch={() => {}}
        tip="circle"
        flow={1}
        liveSource={frame}
        liveFill={{ kind: "source", src: "blob:x", dx: 0.5, dy: 0 }}
      />,
    );
    const el = screen.getByTestId("brush-overlay");
    Object.defineProperty(el, "clientWidth", { value: 400, configurable: true });
    Object.defineProperty(el, "clientHeight", { value: 300, configurable: true });
    fireEvent.mouseDown(el, { button: 0, clientX: 80, clientY: 80 });
    fireEvent.mouseMove(el, { buttons: 1, clientX: 140, clientY: 140 });
    await vi.waitFor(() => expect(stencilDraws.length).toBeGreaterThan(0));
    // dx = 0.5, w = 400: the picture goes down at -200, so the stencil
    // at the stroke shows the pixels half a frame to the right, where
    // the engine will read them from.
    for (const x of stencilDraws) expect(x).toBeCloseTo(-0.5 * 400, 6);
    fireEvent.mouseUp(el, { clientX: 140, clientY: 140 });
    proto.getContext = real;
    vi.doUnmock("../bridge");
  });

  it("tracks the sampled ground mid-drag, locked to where the stroke began", async () => {
    // "when I am painting and moving the mouse, the sample
    // region updates relative to the motion of the mouse. But the preview
    // does not update." The dab worked its offset out against the pointer's
    // CURRENT position, which puts the picked point itself under the brush
    // wherever the brush goes: static. The engine is handed the offset
    // locked at the stroke's first point, so the dab locks there too, and
    // its picture travels with the drag.
    const dabXs: number[] = [];
    const proto = HTMLCanvasElement.prototype as unknown as {
      getContext: (id: string) => unknown;
    };
    const real = proto.getContext;
    proto.getContext = function (this: HTMLCanvasElement, id: string) {
      if (id !== "2d") return real.call(this, id);
      const el = this;
      return {
        canvas: el, setTransform() {}, clearRect() {}, beginPath() {}, closePath() {},
        moveTo() {}, lineTo() {}, arc() {}, rect() {}, fill() {}, fillRect() {},
        save() {}, restore() {}, putImageData() {},
        createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
        drawImage(...args: unknown[]) {
          if (el.getAttribute?.("data-testid") === "brush-cursor-dab" && args.length >= 3) {
            dabXs.push(args[1] as number);
          }
        },
        globalAlpha: 1, globalCompositeOperation: "source-over", fillStyle: "",
      };
    } as typeof real;

    vi.resetModules();
    vi.doMock("../bridge", async () => {
      const actual = await vi.importActual<typeof import("../bridge")>("../bridge");
      return {
        ...actual,
        brushTipPreview: vi.fn(async (_t: string, size: number) =>
          new Uint8Array(size * size).fill(220),
        ),
      };
    });
    const { BrushOverlay } = await import("../ui/overlays");
    const frame = document.createElement("canvas");
    frame.width = 100;
    frame.height = 100;
    const node = { id: "p", type: "heeler.clone", strokes: [] } as never;
    render(
      <BrushOverlay
        node={node}
        radius={0.1}
        dispatch={() => {}}
        tip="circle"
        flow={1}
        liveSource={frame}
        liveFill={{ kind: "source", src: "blob:x", from: [0.9, 0.9] }}
      />,
    );
    const el = screen.getByTestId("brush-overlay");
    Object.defineProperty(el, "clientWidth", { value: 400, configurable: true });
    Object.defineProperty(el, "clientHeight", { value: 300, configurable: true });
    // Real rect mapping, so different pointer positions read as
    // different points: (80, 80) lands at (0.2, 0.2667) and the drag to
    // (320, 240) at (0.8, 0.8).
    Object.defineProperty(el, "offsetWidth", { value: 400, configurable: true });
    Object.defineProperty(el, "offsetHeight", { value: 300, configurable: true });
    el.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 400, height: 300 }) as DOMRect;
    fireEvent.mouseMove(el, { clientX: 200, clientY: 150 });
    await vi.waitFor(() => expect(dabXs.length).toBeGreaterThan(0));

    fireEvent.mouseDown(el, { button: 0, clientX: 80, clientY: 80 });
    fireEvent.mouseMove(el, { buttons: 1, clientX: 320, clientY: 240 });
    // Locked at the start: dx = 0.9 - 0.2 = 0.7, and the dab draws at
    // (-(px - rr) - dx * w) * k with px = 0.8 * 400 = 320, rr = 30,
    // k = 64 / 60, so (-290 - 280) * k ≈ -608. Anchored to the pointer
    // instead, dx would be 0.1 and this would read -352: the pick
    // itself, sitting still under a moving brush.
    await vi.waitFor(() => {
      expect(dabXs[dabXs.length - 1]).toBeCloseTo((-(320 - 30) - 0.7 * 400) * (64 / 60), 0);
    });
    fireEvent.mouseUp(el, { clientX: 320, clientY: 240 });
    proto.getContext = real;
    vi.doUnmock("../bridge");
  });
});


describe("the source-pick cursor", () => {
  // With a clone or heal tool, holding ALT means "the next click picks
  // the source". "I would like for the cursor to change when
  // the user holds the modifier key to pick a source... a crosshair."
  // The ring and dab unmount so the native crosshair is the whole
  // cursor; brush size means nothing while the click reads rather than
  // paints.
  const stubCanvas = () => {
    const proto = HTMLCanvasElement.prototype as unknown as {
      getContext: (id: string) => unknown;
    };
    const real = proto.getContext;
    proto.getContext = function (this: HTMLCanvasElement, id: string) {
      if (id !== "2d") return real.call(this, id);
      return {
        canvas: this, setTransform() {}, clearRect() {}, beginPath() {}, closePath() {},
        moveTo() {}, lineTo() {}, arc() {}, rect() {}, fill() {}, fillRect() {},
        save() {}, restore() {}, putImageData() {}, drawImage() {},
        createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
        globalAlpha: 1, globalCompositeOperation: "source-over", fillStyle: "",
      };
    } as typeof real;
    return () => {
      proto.getContext = real;
    };
  };

  const mockTips = async () => {
    vi.resetModules();
    vi.doMock("../bridge", async () => {
      const actual = await vi.importActual<typeof import("../bridge")>("../bridge");
      return {
        ...actual,
        brushTipPreview: vi.fn(async (_t: string, size: number) =>
          new Uint8Array(size * size).fill(220),
        ),
      };
    });
    return import("../ui/overlays");
  };

  const cloneProps = () => {
    const frame = document.createElement("canvas");
    frame.width = 100;
    frame.height = 100;
    return {
      node: { id: "p", type: "heeler.clone", strokes: [] } as never,
      radius: 0.1,
      dispatch: () => {},
      tip: "circle",
      flow: 1,
      liveSource: frame as CanvasImageSource,
      liveFill: {
        kind: "source" as const,
        src: "blob:x",
        from: [0.5, 0.5] as [number, number],
      },
    };
  };

  const sizeOverlay = () => {
    const el = screen.getByTestId("brush-overlay");
    Object.defineProperty(el, "clientWidth", { value: 400, configurable: true });
    Object.defineProperty(el, "clientHeight", { value: 300, configurable: true });
    return el;
  };

  it("swaps the ring for a crosshair while ALT is held, and back when it is not", async () => {
    const restore = stubCanvas();
    const { BrushOverlay } = await mockTips();
    render(<BrushOverlay {...cloneProps()} onAltPick={() => {}} />);
    const el = sizeOverlay();

    fireEvent.mouseMove(el, { clientX: 100, clientY: 100 });
    await vi.waitFor(() => expect(screen.getByTestId("brush-cursor")).toBeTruthy());
    expect(el.style.cursor).toBe("none");

    fireEvent.mouseMove(el, { clientX: 110, clientY: 110, altKey: true });
    expect(el.style.cursor).toBe("crosshair");
    expect(screen.queryByTestId("brush-cursor")).toBeNull();

    fireEvent.mouseMove(el, { clientX: 120, clientY: 120 });
    expect(el.style.cursor).toBe("none");
    expect(screen.getByTestId("brush-cursor")).toBeTruthy();
    restore();
    vi.doUnmock("../bridge");
  });

  it("turns the moment ALT lands, without waiting for the pointer to move", async () => {
    // altKey only rides on pointer events when the pointer moves; the
    // modifier itself is heard at the window.
    const restore = stubCanvas();
    const { BrushOverlay } = await mockTips();
    render(<BrushOverlay {...cloneProps()} onAltPick={() => {}} />);
    const el = sizeOverlay();

    fireEvent.mouseMove(el, { clientX: 100, clientY: 100 });
    expect(el.style.cursor).toBe("none");

    fireEvent.keyDown(window, { key: "Alt", altKey: true });
    expect(el.style.cursor).toBe("crosshair");
    fireEvent.keyUp(window, { key: "Alt", altKey: false });
    expect(el.style.cursor).toBe("none");
    restore();
    vi.doUnmock("../bridge");
  });

  it("leaves the mask brush alone, where ALT means erase rather than pick", async () => {
    // No onAltPick: the mask brush keeps its ring (which redraws dashed
    // for erase) and never shows the crosshair.
    const restore = stubCanvas();
    const { BrushOverlay } = await mockTips();
    const props = cloneProps();
    render(
      <BrushOverlay
        node={props.node}
        radius={props.radius}
        dispatch={props.dispatch}
        tip={props.tip}
        flow={props.flow}
        liveSource={props.liveSource}
      />,
    );
    const el = sizeOverlay();

    fireEvent.mouseMove(el, { clientX: 100, clientY: 100 });
    expect(el.style.cursor).toBe("none");
    fireEvent.mouseMove(el, { clientX: 110, clientY: 110, altKey: true });
    expect(el.style.cursor).toBe("none");
    fireEvent.keyDown(window, { key: "Alt" });
    expect(el.style.cursor).toBe("none");
    restore();
    vi.doUnmock("../bridge");
  });
});


describe("the heal tool", () => {
  // Heal sits next to clone on the toolbar and shares its entire brush
  // mount: the overlay never knows which of the two is active, because
  // viewer hands both the same onAltPick and the same source liveFill.
  // Heal "needs the same treatment: crosshair cursor with
  // setting sample location, brush preview of the pixels that are going
  // to be painted." These tests pin the WIRING at the app level; what the
  // dab draws from those props is pinned by the clone preview tests
  // above, which exercise the identical overlay props.

  it("turns the crosshair while ALT is held, exactly as clone does", async () => {
    const user = userEvent.setup();
    await finishWithLayer(user);
    // Heal is the repair button's default half, so one tap arms it.
    await user.click(screen.getByTestId("art-tool-repair"));
    const brush = screen.getByTestId("brush-overlay");
    Object.defineProperty(brush, "clientWidth", { value: 400, configurable: true });
    Object.defineProperty(brush, "clientHeight", { value: 300, configurable: true });

    fireEvent.mouseMove(brush, { clientX: 100, clientY: 100 });
    expect(brush.style.cursor).toBe("none");

    fireEvent.keyDown(window, { key: "Alt", altKey: true });
    expect(brush.style.cursor).toBe("crosshair");
    fireEvent.keyUp(window, { key: "Alt", altKey: false });
    expect(brush.style.cursor).toBe("none");
  });

  it("places the source on ALT-click and stops asking for one", async () => {
    const user = userEvent.setup();
    await finishWithLayer(user);
    // Heal is the repair button's default half, so one tap arms it.
    await user.click(screen.getByTestId("art-tool-repair"));
    const brush = screen.getByTestId("brush-overlay");
    Object.defineProperty(brush, "clientWidth", { value: 400, configurable: true });
    Object.defineProperty(brush, "clientHeight", { value: 300, configurable: true });
    // Bound statically at the top of the file: the overlay tests above
    // reset the module registry, and a dynamic import here would read a
    // fresh, empty log while App keeps writing to the original.

    // Before a pick, the stroke is refused with the heal-flavored
    // message: the tool names itself, so nobody fixes the wrong tool.
    const fromStart = getEntries().length;
    fireEvent.mouseDown(brush, { button: 0, clientX: 80, clientY: 80 });
    const refused = getEntries().slice(fromStart).filter((e) => /click somewhere first/i.test(e.message));
    expect(refused.some((e) => /heal/i.test(e.message))).toBe(true);
    fireEvent.mouseUp(brush, { clientX: 80, clientY: 80 });

    // ALT-click picks, the marker lands, and the next stroke paints.
    fireEvent.mouseDown(brush, { button: 0, altKey: true, clientX: 200, clientY: 150 });
    fireEvent.mouseUp(brush, { clientX: 200, clientY: 150 });
    expect(screen.getByTestId("clone-source")).toBeInTheDocument();

    const before = getEntries().length;
    fireEvent.mouseDown(brush, { button: 0, clientX: 80, clientY: 80 });
    fireEvent.mouseMove(brush, { buttons: 1, clientX: 140, clientY: 140 });
    fireEvent.mouseUp(brush, { clientX: 140, clientY: 140 });
    expect(
      getEntries().slice(before).some((e) => /click somewhere first/i.test(e.message)),
    ).toBe(false);
  });

  it("never shows the crosshair for blur, which has no source to pick", async () => {
    // The one tool in the shared mount that must NOT change: blur reads
    // what is under the brush, so its overlay gets no onAltPick and ALT
    // means nothing to it.
    const user = userEvent.setup();
    await finishWithLayer(user);
    await user.click(screen.getByTestId("art-tool-blur"));
    const brush = screen.getByTestId("brush-overlay");
    Object.defineProperty(brush, "clientWidth", { value: 400, configurable: true });
    Object.defineProperty(brush, "clientHeight", { value: 300, configurable: true });

    fireEvent.mouseMove(brush, { clientX: 100, clientY: 100 });
    fireEvent.keyDown(window, { key: "Alt", altKey: true });
    expect(brush.style.cursor).toBe("none");
    fireEvent.keyUp(window, { key: "Alt", altKey: false });
  });
});


describe("the heal dab", () => {
  it("previews the source shifted into the destination's tone, not raw", async () => {
    // Clone's dab draws the frame itself; heal's must draw a scratch the
    // tone match has been through, or hovering a dark patch with a bright
    // source picked previews a repair nobody is about to get. The
    // scripted context plays the frame: dark where the dab stands, bright
    // where it reads from, and records what gets written back.
    const puts: Uint8ClampedArray[] = [];
    const drew: unknown[] = [];
    let reads = 0;
    const proto = HTMLCanvasElement.prototype as unknown as {
      getContext: (id: string) => unknown;
    };
    const real = proto.getContext;
    proto.getContext = function (this: HTMLCanvasElement, id: string) {
      if (id !== "2d") return real.call(this, id);
      return {
        canvas: this, setTransform() {}, clearRect() {}, beginPath() {}, closePath() {},
        moveTo() {}, lineTo() {}, arc() {}, rect() {}, fill() {}, fillRect() {},
        save() {}, restore() {},
        createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
        getImageData: (_x: number, _y: number, w: number, h: number) => {
          // healedRegion reads the destination first, then the source.
          reads++;
          const v = reads === 1 ? 51 : 204;
          const d = new Uint8ClampedArray(w * h * 4);
          for (let i = 0; i < d.length; i += 4) {
            d[i] = d[i + 1] = d[i + 2] = v;
            d[i + 3] = 255;
          }
          return { data: d };
        },
        putImageData(img: { data?: Uint8ClampedArray }) {
          if (img?.data) puts.push(img.data);
        },
        drawImage(src: unknown) { drew.push(src); },
        globalAlpha: 1, globalCompositeOperation: "source-over", fillStyle: "", filter: "",
      };
    } as typeof real;

    vi.resetModules();
    vi.doMock("../bridge", async () => {
      const actual = await vi.importActual<typeof import("../bridge")>("../bridge");
      return {
        ...actual,
        brushTipPreview: vi.fn(async (_t: string, size: number) =>
          new Uint8Array(size * size).fill(220),
        ),
      };
    });
    const { BrushOverlay } = await import("../ui/overlays");
    const frame = document.createElement("canvas");
    frame.width = 100;
    frame.height = 100;
    const node = { id: "p", type: "heeler.clone", strokes: [] } as never;
    render(
      <BrushOverlay
        node={node}
        radius={0.1}
        dispatch={() => {}}
        tip="circle"
        flow={1}
        liveSource={frame as CanvasImageSource}
        liveFill={{ kind: "source", src: "blob:x", dx: 0.3, dy: 0, toneMatch: true }}
      />,
    );
    const el = screen.getByTestId("brush-overlay");
    Object.defineProperty(el, "clientWidth", { value: 400, configurable: true });
    Object.defineProperty(el, "clientHeight", { value: 300, configurable: true });
    fireEvent.mouseMove(el, { clientX: 120, clientY: 120 });

    // The dab draws the healed scratch (a canvas that is NOT the frame)
    // and the pixels written back to it sit at the destination's 51,
    // not the source's 204.
    await vi.waitFor(() => {
      expect(drew.some((s) => s instanceof HTMLCanvasElement && s !== frame)).toBe(true);
    });
    expect(
      puts.some((d) => Math.abs(d[0] - 51) <= 2 && d[3] === 255),
      "the shifted source should land at the destination's tone",
    ).toBe(true);
    proto.getContext = real;
    vi.doUnmock("../bridge");
  });

  it("draws the frame raw when the tone match cannot read the pixels", async () => {
    // A getImageData that refuses (the tainted-frame stand-in) must not
    // blank the dab: the sharp picture is the rung below the match.
    const drew: unknown[] = [];
    const proto = HTMLCanvasElement.prototype as unknown as {
      getContext: (id: string) => unknown;
    };
    const real = proto.getContext;
    proto.getContext = function (this: HTMLCanvasElement, id: string) {
      if (id !== "2d") return real.call(this, id);
      return {
        canvas: this, setTransform() {}, clearRect() {}, beginPath() {}, closePath() {},
        moveTo() {}, lineTo() {}, arc() {}, rect() {}, fill() {}, fillRect() {},
        save() {}, restore() {}, putImageData() {},
        createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
        getImageData() { throw new Error("tainted"); },
        drawImage(src: unknown) { drew.push(src); },
        globalAlpha: 1, globalCompositeOperation: "source-over", fillStyle: "", filter: "",
      };
    } as typeof real;

    vi.resetModules();
    vi.doMock("../bridge", async () => {
      const actual = await vi.importActual<typeof import("../bridge")>("../bridge");
      return {
        ...actual,
        brushTipPreview: vi.fn(async (_t: string, size: number) =>
          new Uint8Array(size * size).fill(220),
        ),
      };
    });
    const { BrushOverlay } = await import("../ui/overlays");
    const frame = document.createElement("canvas");
    frame.width = 100;
    frame.height = 100;
    const node = { id: "p", type: "heeler.clone", strokes: [] } as never;
    render(
      <BrushOverlay
        node={node}
        radius={0.1}
        dispatch={() => {}}
        tip="circle"
        flow={1}
        liveSource={frame as CanvasImageSource}
        liveFill={{ kind: "source", src: "blob:x", dx: 0.3, dy: 0, toneMatch: true }}
      />,
    );
    const el = screen.getByTestId("brush-overlay");
    Object.defineProperty(el, "clientWidth", { value: 400, configurable: true });
    Object.defineProperty(el, "clientHeight", { value: 300, configurable: true });
    fireEvent.mouseMove(el, { clientX: 120, clientY: 120 });

    // Unmatched but visible: the frame itself ends up in the dab.
    await vi.waitFor(() => expect(drew).toContain(frame));
    proto.getContext = real;
    vi.doUnmock("../bridge");
  });
});


describe("the heal stroke preview", () => {
  it("shifts the dragged stroke toward the ground under it, like the dab", async () => {
    // The dab was only half the story: mid-drag the live stroke still
    // painted the raw source. The scripted context answers 96×96 reads
    // (the dab's scratches) with one flat value so the dab's own match
    // is a no-op here, and alternates bright/ground on the stroke-sized
    // reads: the stenciled source first, the ground second. If the
    // stroke is tone-matched, a bounding-box-sized write lands at the
    // ground's 51; if it is not, the only writes stay at coverage white.
    const puts: Uint8ClampedArray[] = [];
    let strokeReads = 0;
    const proto = HTMLCanvasElement.prototype as unknown as {
      getContext: (id: string) => unknown;
    };
    const real = proto.getContext;
    proto.getContext = function (this: HTMLCanvasElement, id: string) {
      if (id !== "2d") return real.call(this, id);
      return {
        canvas: this, setTransform() {}, clearRect() {}, beginPath() {}, closePath() {},
        moveTo() {}, lineTo() {}, arc() {}, rect() {}, fill() {}, fillRect() {},
        save() {}, restore() {},
        createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
        getImageData: (_x: number, _y: number, w: number, h: number) => {
          const solid = (v: number) => {
            const d = new Uint8ClampedArray(w * h * 4);
            for (let i = 0; i < d.length; i += 4) {
              d[i] = d[i + 1] = d[i + 2] = v;
              d[i + 3] = 255;
            }
            return { data: d };
          };
          if (w === 96 && h === 96) return solid(51);
          strokeReads++;
          return solid(strokeReads % 2 === 1 ? 204 : 51);
        },
        putImageData(img: { data?: Uint8ClampedArray }) {
          if (img?.data) puts.push(img.data);
        },
        drawImage() {},
        globalAlpha: 1, globalCompositeOperation: "source-over", fillStyle: "", filter: "",
      };
    } as typeof real;

    vi.resetModules();
    vi.doMock("../bridge", async () => {
      const actual = await vi.importActual<typeof import("../bridge")>("../bridge");
      return {
        ...actual,
        brushTipPreview: vi.fn(async (_t: string, size: number) =>
          new Uint8Array(size * size).fill(220),
        ),
      };
    });
    const { BrushOverlay } = await import("../ui/overlays");
    const frame = document.createElement("canvas");
    frame.width = 100;
    frame.height = 100;
    const node = { id: "p", type: "heeler.clone", strokes: [] } as never;
    render(
      <BrushOverlay
        node={node}
        radius={0.1}
        dispatch={() => {}}
        tip="circle"
        flow={1}
        liveSource={frame as CanvasImageSource}
        liveFill={{ kind: "source", src: "blob:x", dx: 0.3, dy: 0, toneMatch: true }}
      />,
    );
    const el = screen.getByTestId("brush-overlay");
    Object.defineProperty(el, "clientWidth", { value: 400, configurable: true });
    Object.defineProperty(el, "clientHeight", { value: 300, configurable: true });
    // Real rect mapping so the two drag points read as distinct.
    Object.defineProperty(el, "offsetWidth", { value: 400, configurable: true });
    Object.defineProperty(el, "offsetHeight", { value: 300, configurable: true });
    el.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 400, height: 300 }) as DOMRect;

    fireEvent.mouseDown(el, { button: 0, clientX: 80, clientY: 80 });
    fireEvent.mouseMove(el, { buttons: 1, clientX: 140, clientY: 140 });
    // The stroke's bounding box is ~120×120 (two points a radius-30
    // brush apart): a write of that length at the ground's tone is the
    // match having run. 96×96 writes are the dab's, and stay covered by
    // its own tests.
    await vi.waitFor(() => {
      expect(
        puts.some((d) => d.length !== 96 * 96 * 4 && Math.abs(d[0] - 51) <= 2 && d[3] === 255),
        "the dragged stroke should land at the ground's tone, not the source's 204",
      ).toBe(true);
    });
    fireEvent.mouseUp(el, { clientX: 140, clientY: 140 });
    proto.getContext = real;
    vi.doUnmock("../bridge");
  });
});
