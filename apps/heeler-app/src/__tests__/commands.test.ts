import { describe, expect, it, vi } from "vitest";
import { COMMANDS, bindingFor, bindingMap, bindingOf, conflicts } from "../hotkeys";
import { inScope, runCommand } from "../commands";
import { initialState } from "../data";
import { clampGrainStep, reduce, type Command, type State } from "../state";

/** Runs a command against a real reducer and hands back the state it
 * produced, so these are end-to-end through the actual state machine
 * rather than assertions about which action object was built. */
function run(id: string, start: State = initialState(), ctx = {}): State {
  let s = start;
  const dispatch = (c: Command) => {
    s = reduce(s, c);
  };
  runCommand(id, start, dispatch as never, ctx);
  return s;
}

describe("every command does something", () => {
  /// A command in the registry with nothing behind it shows up in the
  /// editor, takes a key, and does nothing when pressed. That is worse
  /// than not offering it.
  it("no command in the registry is unimplemented", () => {
    const ctx = { openFolder: vi.fn(), merge: vi.fn(), stitch: vi.fn() };
    const dead: string[] = [];
    for (const c of COMMANDS) {
      // A few only do anything when there is something to do; give them
      // that something.
      let s = initialState();
      if (c.id === "edit.delete" || c.id === "edit.deleteKeep" || c.id === "edit.duplicate")
        s = reduce(s, { type: "select_nodes", ids: ["cbal"] });
      if (c.id === "graph.group") s = reduce(s, { type: "select_nodes", ids: ["cbal", "curves"] });
      if (c.id === "tool.cancel" || c.id === "tool.apply")
        s = reduce(s, { type: "set_tool", tool: "crop" });
      // D and N act on the graph selection, so they need one.
      if (
        c.id === "node.disable" ||
        c.id === "node.rename" ||
        c.id === "node.upstream" ||
        // Outside needs a masked node; cbal ships wearing lummask.
        c.id === "node.outside"
      )
        s = reduce(s, { type: "select_nodes", ids: ["cbal"] });
      // Select All and friends need a selection to act on; a
      // photograph with no selection layer has none, and they hand the
      // key back rather than inventing one.
      if (c.id.startsWith("select.")) s = reduce(s, { type: "add_layer", maskType: "selection" });
      // Fill needs somewhere to put the color as well as something to
      // shape it, so it also needs a Finish layer to be active.
      if (c.id === "select.fill") s = reduce(s, { type: "art_add_layer", kind: "paint" });
      // The two layer transforms arm a gizmo over the active layer, so
      // they need one. With no layer there is nothing to move and they
      // hand the key back rather than putting handles round the frame.
      if (c.id === "layer.transform" || c.id === "layer.warp")
        s = reduce(s, { type: "art_add_layer", kind: "paint" });
      // Selecting a layer's pixels needs pixels on the layer. A paint
      // layer nobody has painted on has no shape to hand back, and the
      // command says so by handing the key back.
      if (c.id === "select.layer_pixels") {
        s = reduce(s, { type: "art_add_layer", kind: "paint" });
        s = reduce(s, {
          type: "art_add_stroke",
          id: s.artActive!,
          stroke: { points: [[0.4, 0.4], [0.6, 0.6]], radius: 0.05 },
        });
      }
      // Remove Object needs a computed Smart selection to consume.
      if (c.id === "select.remove_object") {
        s = reduce(s, { type: "add_layer", maskType: "smart" });
        s = reduce(s, {
          type: "set_params",
          id: s.activeLayer!.replace("_adj", "_mask"),
          values: {},
          text: { prompts: '[{"x":0.5,"y":0.5,"positive":true}]', model: "mobile_sam" },
        });
      }
      // The Finish toolbar keys are live only while the toolbar is on
      // screen, and the retouch ones need a pixel layer under them,
      // exactly like their buttons.
      if (c.id.startsWith("art.")) {
        s = reduce(s, { type: "set_panel_tab", tab: "layers" });
        s = reduce(s, { type: "art_add_layer", kind: "paint" });
      }
      // Frame measures the graph's element, so give it one to measure.
      if (c.id === "graph.frame") {
        const el = document.createElement("div");
        el.setAttribute("data-testid", "node-editor");
        document.body.appendChild(el);
      }
      // Brush-scoped commands share [ and ] with the rating keys and
      // only take them while the brush is actually up.
      if (c.scope === "brush") s = reduce(s, { type: "set_tool", tool: "brush" });
      // And turning the grain needs a tip that has one; the round brush
      // hands the key back rather than pretending to turn nothing.
      if (c.id.startsWith("brush.grain")) s = reduce(s, { type: "set_brush_tip", tip: "splatter" });
      // Baking needs a merge; an ordinary photograph has no recipe and
      // the command hands the key back rather than opening an empty
      // dialog.
      if (c.id === "photo.bake") {
        s = reduce(s, {
          type: "add_stack_image",
          image: { id: "baked", name: "HDR_a-c.stack", stars: 0, flag: "", edited: false, filter: "none", src: "" },
        });
        s = reduce(s, { type: "select_image_range", id: "baked" });
      }
      const handled = runCommand(c.id, s, (() => {}) as never, ctx);
      // The develop nudge keys belong to the control navigator, which
      // reads them before this is reached.
      if (!handled && !c.id.startsWith("develop.nudge") && !c.id.endsWith("_control")) {
        dead.push(c.id);
      }
    }
    expect(dead).toEqual([]);
  });
});

describe("ENTER applies the modal tool, ESC still cancels", () => {
  /// "Pressing ENTER/RETURN while in the Crop tool should
  /// apply the crop." Apply means keep what the drag did: the
  /// toggle-off commit the DONE button makes, against Escape's snapshot
  /// revert.
  const press = (id: string, s: State) => {
    let next = s;
    const handled = runCommand(id, s, ((c: Command) => {
      next = reduce(next, c);
    }) as never, {});
    return { handled, next };
  };

  it("keeps the dragged crop and leaves the tool", () => {
    let s = reduce(initialState(), { type: "set_tool", tool: "crop" });
    s = reduce(s, { type: "set_params", id: "crop", values: { crop_w: 0.5 } });
    const applied = press("tool.apply", s);
    expect(applied.handled).toBe(true);
    expect(applied.next.tool).toBe("none");
    expect(applied.next.nodes.find((n) => n.id === "crop")?.params.crop_w).toBe(0.5);
    // The same keys with no tool up decline, so Enter stays free.
    expect(press("tool.apply", applied.next).handled).toBe(false);
  });

  it("cancel still reverts what apply would have kept", () => {
    let s = reduce(initialState(), { type: "set_tool", tool: "crop" });
    const before = s.nodes.find((n) => n.id === "crop")?.params.crop_w;
    s = reduce(s, { type: "set_params", id: "crop", values: { crop_w: 0.5 } });
    const cancelled = press("tool.cancel", s);
    expect(cancelled.next.tool).toBe("none");
    expect(cancelled.next.nodes.find((n) => n.id === "crop")?.params.crop_w).toBe(before);
  });

  it("Escape puts every armed picker away before it touches the tool", () => {
    // 2026-09-07: "There are many pickers throughout the app, not all
    // cancel with the ESC key." One list, one press.
    let s = reduce(initialState(), { type: "set_tool", tool: "crop" });
    s = reduce(s, { type: "arm_wb_pick", id: "stdcolor" });
    expect(s.wbPick).toBe("stdcolor");
    s = reduce(s, { type: "toggle_keylight_pick" });
    // One cursor at a time (2026-09-13): the light's handles put the
    // eyedropper away as they arm.
    expect(s.wbPick).toBeNull();
    expect(s.keyLightPick).toBe(true);
    const first = press("tool.cancel", s);
    expect(first.handled).toBe(true);
    expect(first.next.wbPick).toBe(null);
    expect(first.next.keyLightPick).toBe(false);
    expect(first.next.tool).toBe("crop");
    const second = press("tool.cancel", first.next);
    expect(second.next.tool).toBe("none");
    // The focus picker on its own, with no tool up: one press, then free.
    const focus = reduce(initialState(), { type: "toggle_dof_pick" });
    const peeled = press("tool.cancel", focus);
    expect(peeled.handled).toBe(true);
    expect(peeled.next.dofPick).toBe(false);
    expect(press("tool.cancel", peeled.next).handled).toBe(false);
  });

  it("Escape peels the armed Color Set picker before it touches the tool", () => {
    // "The picker should turn off with the ESC key." One
    // layer per press: the picker first, the tool on the next one.
    let s = reduce(initialState(), { type: "add_color_set" });
    s = reduce(s, { type: "set_tool", tool: "crop" });
    s = reduce(s, { type: "arm_cset_dropper", n: 1 });
    const first = press("tool.cancel", s);
    expect(first.handled).toBe(true);
    expect(first.next.csetDropper).toBe(null);
    expect(first.next.tool).toBe("crop");
    const second = press("tool.cancel", first.next);
    expect(second.next.tool).toBe("none");
    // Nothing armed, no tool: Escape declines and stays free.
    expect(press("tool.cancel", second.next).handled).toBe(false);
  });
});

describe("the brush takes [ and ] while it is up", () => {
  /// "while in brush mode overwrite the hotkey for [] for
  /// brush size and SHIFT + [] for falloff (softness)."
  ///
  /// Sharing a key only works if the brush command declines when the
  /// brush is down, so the rating command behind it still runs.
  const press = (id: string, s: State) => {
    let next = s;
    const handled = runCommand(id, s, ((c: Command) => {
      next = reduce(next, c);
    }) as never, {});
    return { handled, next };
  };

  it("resizes the brush while painting", () => {
    const s = reduce(initialState(), { type: "set_tool", tool: "brush" });
    const bigger = press("brush.size.up", s);
    expect(bigger.handled).toBe(true);
    expect(bigger.next.brushRadius).toBeGreaterThan(s.brushRadius);
    const smaller = press("brush.size.down", s);
    expect(smaller.next.brushRadius).toBeLessThan(s.brushRadius);
  });

  it("softens and hardens the edge on SHIFT", () => {
    const s = reduce(initialState(), { type: "set_tool", tool: "brush" });
    // Softer is less hardness, which is what the engine reads.
    expect(press("brush.soft.up", s).next.brushHardness).toBeLessThan(s.brushHardness);
    expect(press("brush.soft.down", s).next.brushHardness).toBeGreaterThan(s.brushHardness);
  });

  it("hands the key back to rating when the brush is down", () => {
    const s = initialState();
    expect(s.tool).not.toBe("brush");
    const attempt = press("brush.size.up", s);
    expect(attempt.handled).toBe(false);
    expect(attempt.next.brushRadius).toBe(s.brushRadius);
    // And the rating command sharing the key still works.
    expect(press("rate.up", s).handled).toBe(true);
  });

  it("is bound to the keys the owner asked for", () => {
    expect(bindingFor("brush.size.down", {})).toBe("[");
    expect(bindingFor("brush.size.up", {})).toBe("]");
    expect(bindingFor("brush.soft.down", {})).toBe("Shift+[");
    expect(bindingFor("brush.soft.up", {})).toBe("Shift+]");
    // A keyboard sends { for shift+[, and the normalizer has to undo it
    // or the chord never matches.
    expect(bindingOf({ key: "{", shiftKey: true })).toBe("Shift+[");
    expect(bindingOf({ key: "}", shiftKey: true })).toBe("Shift+]");
  });

  /// The half my first attempt missed.
  ///
  /// I tested runCommand("brush.size.up") directly, which skips the bit
  /// that decides WHICH command gets the key. Rating is declared earlier
  /// in the table, so it answered "]" first and returned true, and the
  /// brush keys never ran at all. "brush size hotkeys didn't
  /// seem to be working." They did not. This goes through resolution.
  it("gets offered the key before the command that always takes it", () => {
    for (const key of ["[", "]"]) {
      const candidates = bindingMap({}).get(key) ?? [];
      expect(candidates.length).toBe(2);
      const first = COMMANDS.find((c) => c.id === candidates[0])!;
      expect(
        first.scope,
        `"${key}" offers ${candidates[0]} first, which is global, so the brush never sees it`,
      ).toBe("brush");
    }
  });

  it("resolves to the brush while painting and to rating otherwise", () => {
    // The same walk the key handler does: try each candidate in order,
    // take the first that handles it.
    const resolve = (key: string, s: State) => {
      for (const id of bindingMap({}).get(key) ?? []) {
        const spec = COMMANDS.find((c) => c.id === id)!;
        if (!inScope(spec.scope, s.mode)) continue;
        if (runCommand(id, s, (() => {}) as never, {})) return id;
      }
      return null;
    };
    const painting = reduce(initialState(), { type: "set_tool", tool: "brush" });
    expect(resolve("]", painting)).toBe("brush.size.up");
    expect(resolve("[", painting)).toBe("brush.size.down");
    // Brush down: the rating commands get their keys back.
    expect(resolve("]", initialState())).toBe("rate.up");
    expect(resolve("[", initialState())).toBe("rate.down");

    // Polish paints with the same brush, so it holds the same keys. Left
    // off the brush-tool list, the brackets fell through to the rating
    // commands and quietly restarred the photo instead. "The
    // [] hotkeys are not working to change the radius."
    const polishing = reduce(initialState(), { type: "set_tool", tool: "polish" });
    expect(resolve("]", polishing)).toBe("brush.size.up");
    expect(resolve("[", polishing)).toBe("brush.size.down");
  });

  it("turns the grain only for the tips that have one", () => {
    const textured = [
      { type: "set_tool" as const, tool: "brush" as const },
      { type: "set_brush_tip" as const, tip: "crosshatch" },
    ].reduce(reduce, initialState());
    const turned = press("brush.grain.cw", textured);
    expect(turned.handled).toBe(true);
    expect(turned.next.brushTextureAngle).toBe(15);
    expect(press("brush.grain.ccw", textured).next.brushTextureAngle).toBe(-15);

    // A round brush has no grain, so the key goes back to whatever else
    // wants it rather than silently doing nothing.
    const round = reduce(textured, { type: "set_brush_tip", tip: "circle" });
    expect(press("brush.grain.cw", round).handled).toBe(false);
  });

  it("turns it a little on SHIFT, and by whatever the settings say", () => {
    /// "CMD/ALT + [] goes in increments of 15, let's add
    /// SHIFT + CMD/ALT + [] to go in increments of 5. Both of the
    /// increment values should be customizable in settings."
    const textured = [
      { type: "set_tool" as const, tool: "brush" as const },
      { type: "set_brush_tip" as const, tip: "crosshatch" },
    ].reduce(reduce, initialState());
    expect(press("brush.grain.cw.fine", textured).next.brushTextureAngle).toBe(5);
    expect(press("brush.grain.ccw.fine", textured).next.brushTextureAngle).toBe(-5);

    const custom = reduce(textured, {
      type: "set_prefs",
      prefs: { brushGrainStep: 30, brushGrainFineStep: 2 },
    });
    expect(press("brush.grain.cw", custom).next.brushTextureAngle).toBe(30);
    expect(press("brush.grain.cw.fine", custom).next.brushTextureAngle).toBe(2);

    // The fine keys are just as fussy about the tip as the coarse ones.
    const round = reduce(textured, { type: "set_brush_tip", tip: "circle" });
    expect(press("brush.grain.cw.fine", round).handled).toBe(false);
  });

  it("keeps a grain step at a size that does something", () => {
    // Zero would make the key do nothing at all, and past a quarter turn
    // it is a different pattern rather than an adjustment to this one.
    expect(clampGrainStep(0)).toBe(1);
    expect(clampGrainStep(-40)).toBe(1);
    expect(clampGrainStep(400)).toBe(90);
    expect(clampGrainStep(7.4)).toBe(7);
  });

  it("puts the fine turn on SHIFT with the same two keys", () => {
    expect(bindingFor("brush.grain.ccw.fine", {})).toBe("Shift+Alt+[");
    expect(bindingFor("brush.grain.cw.fine", {})).toBe("Shift+Alt+]");
    // A keyboard sends "{" for shift and the bracket, so the chord has
    // to survive the round trip or it can never be typed.
    expect(bindingOf({ key: "{", altKey: true, shiftKey: true })).toBe("Shift+Alt+[");
    expect(bindingOf({ key: "}", altKey: true, shiftKey: true })).toBe("Shift+Alt+]");
  });

  it("wraps the grain angle instead of stopping at the end", () => {
    // Turning a pattern past half a turn should come round the other
    // side; a control that stops dead reads as broken.
    const s = reduce(initialState(), { type: "set_brush_texture_angle", angle: 190 });
    expect(s.brushTextureAngle).toBe(-170);
    expect(reduce(s, { type: "set_brush_texture_angle", angle: -190 }).brushTextureAngle).toBe(170);
  });

  it("is bound to ALT with the brackets, as the owner asked", () => {
    expect(bindingFor("brush.grain.ccw", {})).toBe("Alt+[");
    expect(bindingFor("brush.grain.cw", {})).toBe("Alt+]");
    // A keyboard sends the bare bracket with ALT held, so the chord has
    // to read back the same way it is written.
    expect(bindingOf({ key: "[", altKey: true })).toBe("Alt+[");
    expect(bindingOf({ key: "]", altKey: true })).toBe("Alt+]");
  });

  it("the shared key is not reported as a conflict", () => {
    // It is a handover, not a clash, and flagging it would be crying
    // wolf about the one case that resolves itself.
    expect(conflicts({}).get("[")).toBeUndefined();
    expect(conflicts({}).get("]")).toBeUndefined();
  });
});

describe("the owner's bindings", () => {
  it("opens a folder on Ctrl+Shift+O", () => {
    expect(bindingFor("file.open", {})).toBe("Ctrl+Shift+O");
    expect(bindingOf({ key: "O", ctrlKey: true, shiftKey: true })).toBe("Ctrl+Shift+O");
  });

  it("adds each kind of layer", () => {
    const cases: [string, string, number][] = [
      ["layer.range", "Ctrl+Shift+R", 1],
      ["layer.radial", "Ctrl+Shift+A", 1],
      ["layer.linear", "Ctrl+Shift+L", 1],
      ["layer.brush", "Ctrl+Shift+B", 1],
    ];
    for (const [id, binding, added] of cases) {
      expect(bindingFor(id, {})).toBe(binding);
      const before = initialState();
      const after = run(id, before);
      expect(after.nodes.length).toBeGreaterThan(before.nodes.length);
      expect(added).toBe(1);
    }
  });

  /// Three workspaces, and round again. Wrapping is right here, unlike
  /// stepping through photographs: there are three and you can see which
  /// one you are in.
  it("cycles the workspaces forwards and backwards", () => {
    let s = initialState();
    expect(s.mode).toBe("simple");
    s = run("view.mode.next", s);
    expect(s.mode).toBe("advanced");
    s = run("view.mode.next", s);
    expect(s.mode).toBe("canvas");
    s = run("view.mode.next", s);
    expect(s.mode).toBe("simple");
    s = run("view.mode.prev", s);
    expect(s.mode).toBe("canvas");
    expect(bindingFor("view.mode.next", {})).toBe("Ctrl+Tab");
    expect(bindingFor("view.mode.prev", {})).toBe("Ctrl+Shift+Tab");
  });

  it("collapses the library and the filmstrip", () => {
    expect(bindingFor("view.browser", {})).toBe("Shift+L");
    expect(bindingFor("view.ribbon", {})).toBe("Shift+T");
    const s = initialState();
    expect(run("view.browser", s).browserOpen).toBe(!s.browserOpen);
    expect(run("view.ribbon", s).ribbonOpen).toBe(!s.ribbonOpen);
  });

  /// The right panel stays open; these move between its tabs.
  it("moves between the right panel's tabs", () => {
    expect(bindingFor("panel.history", {})).toBe("Shift+Alt+H");
    expect(bindingFor("panel.presets", {})).toBe("Shift+Alt+P");
    expect(bindingFor("panel.adjustments", {})).toBe("Shift+Alt+A");
    let s = initialState();
    expect(s.panelTab).toBe("adjust");
    s = run("panel.history", s);
    expect(s.panelTab).toBe("history");
    s = run("panel.presets", s);
    expect(s.panelTab).toBe("presets");
    s = run("panel.adjustments", s);
    expect(s.panelTab).toBe("adjust");
  });

  it("arms each tool", () => {
    expect(bindingFor("tool.crop", {})).toBe("Shift+C");
    expect(bindingFor("tool.straighten", {})).toBe("Shift+S");
    expect(bindingFor("tool.pick", {})).toBe("I");
    expect(run("tool.crop").tool).toBe("crop");
    expect(run("tool.straighten").tool).toBe("straighten");
    expect(run("tool.pick").tool).toBe("pick");
  });

  it("still has no conflicting defaults after all of that", () => {
    expect([...conflicts({}).keys()]).toEqual([]);
  });

  /// Every default has to be a chord bindingOf can actually produce, or
  /// the command is unreachable however correct the table looks.
  it("every default binding is one a keyboard can produce", () => {
    for (const c of COMMANDS) {
      if (!c.binding) continue;
      const parts = c.binding.split("+");
      const key = parts[parts.length - 1];
      const made = bindingOf({
        key: key === "Space" ? " " : key,
        ctrlKey: parts.includes("Ctrl"),
        altKey: parts.includes("Alt"),
        shiftKey: parts.includes("Shift"),
      });
      expect(made, `${c.id} is bound to ${c.binding}, which reads back as ${made}`).toBe(c.binding);
    }
  });
});

describe("scope", () => {
  it("keeps graph commands out of Develop and back again", () => {
    expect(inScope("graph", "simple")).toBe(false);
    expect(inScope("graph", "advanced")).toBe(true);
    expect(inScope("develop", "simple")).toBe(true);
    expect(inScope("develop", "advanced")).toBe(false);
    expect(inScope("canvas", "advanced")).toBe(false);
    expect(inScope("global", "canvas")).toBe(true);
  });

  it("a binding resolves to the command that is live", () => {
    const map = bindingMap({});
    // Ctrl+Shift+L is a layer command, which only exists in Develop.
    const ids = map.get("Ctrl+Shift+L") ?? [];
    expect(ids).toContain("layer.linear");
    const spec = COMMANDS.find((c) => c.id === "layer.linear")!;
    expect(inScope(spec.scope, "simple")).toBe(true);
    expect(inScope(spec.scope, "advanced")).toBe(false);
  });
});

describe("resetting edits queues its aftermath", () => {
  /// "Resetting edits does not update the thumbnails." Every
  /// reset door dispatches reset_image_edits, the reducer queues the id,
  /// and app.tsx drains the queue (on-disk graph, catalog badge,
  /// thumbnail re-render). The queue is the contract this pins.
  it("edit.reset queues the active image, and settling drains it", () => {
    let s = run("edit.reset");
    expect(s.resetPending).toEqual([s.activeImage]);
    // A second reset does not double-queue.
    s = reduce(s, { type: "reset_image_edits", id: s.activeImage });
    expect(s.resetPending).toEqual([s.activeImage]);
    s = reduce(s, { type: "reset_settled", id: s.activeImage });
    expect(s.resetPending).toEqual([]);
  });

  it("edit.reset over a multi-selection queues every photo in it", () => {
    // "When I have more than one Thumbnail selected,
    // Reset all edits should be applied to all that are selected."
    const start = initialState();
    const other = start.images.find((i) => i.id !== start.activeImage)!.id;
    const s = run("edit.reset", reduce(start, { type: "select_images", ids: [start.activeImage, other] }));
    expect(s.resetPending).toEqual([start.activeImage, other]);
    expect(s.images.filter((i) => i.id === start.activeImage || i.id === other).every((i) => !i.edited)).toBe(true);
  });

  it("the thumbnail context menu's target queues too, active or not", () => {
    const start = initialState();
    const other = start.images.find((i) => i.id !== start.activeImage)!.id;
    const s = reduce(start, { type: "reset_image_edits", id: other });
    expect(s.resetPending).toEqual([other]);
  });
});

/* (2026-09-09): "The Select By... tools at the bottom of the
 * Selection menu should always be usable and enabled." With no
 * selection they start one, and the range goes into it. (2026-09-10):
 * starting that selection must not arm the select tool; the ants
 * render for a selection with substance regardless of the tool in
 * hand.*/
describe("Select by with no selection yet", () => {
  it("starts the document selection without arming the select tool, and puts the range in", () => {
    const s0 = initialState();
    expect(s0.nodes.some((n) => n.id === "sel_doc")).toBe(false);
    const s = run("select.range.luma", s0);
    const doc = s.nodes.find((n) => n.id === "sel_doc")!;
    expect(doc).toBeTruthy();
    expect(s.tool).toBe(s0.tool);
    expect(s.selection).toEqual(["sel_doc"]);
    expect(doc.regions?.map((r) => r.kind)).toEqual(["range"]);
    expect(s.selectDialog).toMatchObject({ kind: "range", mode: "luma", index: 0, restoreRegions: [] });
  });
});
