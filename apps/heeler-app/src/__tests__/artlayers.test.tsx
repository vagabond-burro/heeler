// The Finish tab: finishing layers over the developed photograph. The
// stack is a view over the "art" group node, so everything here is
// asserting that UI gestures land as graph edits.

import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "../app";
import { dragTrack, trackValue } from "./trackdrive";
import { ART_ADJUSTMENTS, LAYER_MASK_TYPES } from "../state";
import { choose, chooseWith, menuValue } from "./menuhelp";

async function openFinish(user: ReturnType<typeof userEvent.setup>) {
  render(<App />);
  await user.click(screen.getByTestId("panel-tab-layers"));
}

/** jsdom gives every element a zero-size box, so the overlay's pointer
 * math has nothing to divide by and every click lands on the same
 * point. Pin it to a real square and the coordinates mean something. */
function stubBox(el: HTMLElement, size = 200) {
  el.getBoundingClientRect = () =>
    ({ left: 0, top: 0, right: size, bottom: size, width: size, height: size, x: 0, y: 0, toJSON() {} }) as DOMRect;
}

/** The selection shape is picked by holding the Select tool, which is
 * the only way in now: there is no separate shape dropdown. */
async function pickMethod(id: string) {
  const btn = screen.getByTestId("art-tool-select");
  fireEvent.mouseDown(btn, { button: 0 });
  // The hold is a real timer, so this waits for it rather than faking
  // clocks that userEvent also wants to own.
  const menu = await screen.findByTestId("art-select-method-menu", undefined, { timeout: 2000 });
  fireEvent.mouseUp(btn);
  fireEvent.click(within(menu).getByTestId(`art-select-method-option-${id}`));
}

/** The toolbar's dropdowns are Heeler menus, not native selects: click
 * the field, then the option. */
async function pickFrom(
  user: ReturnType<typeof userEvent.setup>,
  field: string,
  option: string,
) {
  await user.click(screen.getByTestId(field));
  await user.click(screen.getByTestId(`${field}-option-${option}`));
}

/** Pixel, Gradient or Fill from the split button's arrow, whatever its
 * left half shows. */
async function addContent(user: ReturnType<typeof userEvent.setup>, kind: "paint" | "gradient" | "fill") {
  await user.click(screen.getByTestId("art-add-content-more"));
  await user.click(screen.getByTestId(`art-content-${kind}`));
}

/** The toolbar is icons; adjustments come from the popup behind one. */
async function addAdjustment(user: ReturnType<typeof userEvent.setup>, kind: string) {
  await user.click(screen.getByTestId("art-add-adjust"));
  await user.click(screen.getByTestId(`art-adjust-${kind}`));
}

describe("the Finish tab", () => {
  it("starts empty, and the first paint layer builds the stack", async () => {
    const user = userEvent.setup();
    await openFinish(user);
    expect(screen.getByTestId("art-layers")).toBeInTheDocument();
    expect(screen.queryAllByTestId(/^art-layer-/)).toHaveLength(0);

    await user.click(screen.getByTestId("art-add-content"));
    const row = screen.getByTestId("art-layer-art_b1");
    expect(row.getAttribute("data-active")).toBe("true");
    // The graph gained the group; Graph mode can open it like any other.
    // (The stack IS nodes: that is the whole point.)
    expect(menuValue(screen.getByTestId("art-mode-art_b1"))).toBe("normal");
  });

  it("the bottom toolbar appears with the tab and arms the paint tool", async () => {
    const user = userEvent.setup();
    await openFinish(user);
    const bar = screen.getByTestId("art-toolbar");
    expect(bar).toBeInTheDocument();
    // No layer yet: nothing for paint to write on.
    expect(screen.getByTestId("art-tool-paint")).toBeDisabled();

    await user.click(screen.getByTestId("art-add-content"));
    expect(screen.getByTestId("art-tool-paint")).toBeEnabled();
    await user.click(screen.getByTestId("art-tool-paint"));
    expect(screen.getByTestId("art-tool-paint").getAttribute("data-active")).toBe("true");
    // The brush overlay is up, aimed at the paint layer.
    expect(screen.getByTestId("brush-overlay")).toBeInTheDocument();
    // Toggling off puts the tool away.
    await user.click(screen.getByTestId("art-tool-paint"));
    expect(screen.queryByTestId("brush-overlay")).not.toBeInTheDocument();
  });

  it("a mask chip adds, arms the brush, and removes", async () => {
    const user = userEvent.setup();
    await openFinish(user);
    await user.click(screen.getByTestId("art-add-content"));

    await user.click(screen.getByTestId("art-mask-add-art_b1"));
    // The chip flips to edit/remove.
    expect(screen.queryByTestId("art-mask-add-art_b1")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("art-mask-edit-art_b1"));
    // Editing means the brush is up, aimed at the mask node.
    expect(screen.getByTestId("art-mask-edit-art_b1").getAttribute("data-active")).toBe("true");
    expect(screen.getByTestId("brush-overlay")).toBeInTheDocument();

    await user.click(screen.getByTestId("art-mask-remove-art_b1"));
    expect(screen.getByTestId("art-mask-add-art_b1")).toBeInTheDocument();
  });

  it("Select arms a document selection and leaves the layer alone", async () => {
    const user = userEvent.setup();
    await openFinish(user);
    await user.click(screen.getByTestId("art-add-content"));

    await user.click(screen.getByTestId("art-tool-select"));
    // The overlay is up and the tool is armed...
    expect(screen.getByTestId("selection-overlay")).toBeInTheDocument();
    expect(screen.getByTestId("art-tool-select").getAttribute("data-active")).toBe("true");
    // ...and the selection split opened below, layers staying put:
    // context arrives beside your work instead of replacing it.
    expect(screen.getByTestId("selection-split")).toBeInTheDocument();
    expect(screen.getByTestId("select-tab")).toBeInTheDocument();
    // The layer is exactly as it was. Reaching for the
    // tool is not a request to mask anything.
    expect(screen.queryByTestId("art-mask-edit-art_b1")).not.toBeInTheDocument();
    expect(screen.getByTestId("art-mask-add-art_b1")).toBeInTheDocument();
    // With nothing selected yet there is nothing to make a mask from.
    expect(screen.queryByTestId("art-mask-from-selection-art_b1")).not.toBeInTheDocument();

    // Draw one, and the explicit route appears.
    const overlay = screen.getByTestId("selection-overlay");
    stubBox(overlay);
    fireEvent.mouseDown(overlay, { button: 0, clientX: 20, clientY: 20 });
    for (let i = 1; i <= 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      fireEvent.mouseMove(overlay, {
        buttons: 1,
        clientX: 100 + Math.cos(a) * 50,
        clientY: 100 + Math.sin(a) * 50,
      });
    }
    fireEvent.mouseUp(overlay);
    const make = await screen.findByTestId("art-mask-from-selection-art_b1");
    await user.click(make);
    // Now, and only now, the layer has a mask (once the desktop's bake
    // of the selection lands).
    expect(await screen.findByTestId("art-mask-edit-art_b1")).toBeInTheDocument();

    // A pixel mask (2026-09-30): the chip arms the BRUSH to paint it,
    // never the select tool.
    await user.click(screen.getByTestId("art-tool-cursor"));
    await user.click(screen.getByTestId("art-mask-edit-art_b1"));
    expect(screen.getByTestId("brush-overlay")).toBeInTheDocument();
    expect(screen.queryByTestId("selection-overlay")).not.toBeInTheDocument();
  });

  it("group and ungroup from the panel, with members editable inside", async () => {
    const user = userEvent.setup();
    await openFinish(user);
    await user.click(screen.getByTestId("art-add-content"));
    await user.click(screen.getByTestId("art-add-content"));

    // Select both (ctrl-click extends) and group them.
    fireEvent.mouseDown(screen.getByTestId("art-layer-art_b1"));
    fireEvent.mouseDown(screen.getByTestId("art-layer-art_b2"), { ctrlKey: true });
    await user.click(screen.getByTestId("art-group"));

    const groupRow = screen.getAllByTestId(/^art-layer-/)[0];
    const groupId = groupRow.getAttribute("data-testid")!.replace("art-layer-", "");
    expect(groupRow.textContent).toContain("Group");

    // Open the disclosure: members listed with opacity, no mode select.
    await user.click(screen.getByTestId(`art-open-${groupId}`));
    const members = screen.getAllByTestId(/^art-member-/);
    expect(members.length).toBe(2);

    // A member takes paint: select it, arm paint, overlay comes up.
    fireEvent.mouseDown(members[0]);
    await user.click(screen.getByTestId("art-tool-paint"));
    expect(screen.getByTestId("brush-overlay")).toBeInTheDocument();
    await user.click(screen.getByTestId("art-tool-paint"));

    // 2026-08-27: "when I group layers, that I can no longer access any
    // controls of a grouped layer except for opacity... I need a
    // collapse/expand control on those layers to expand them to their
    // full height to be able to edit them as normal." Each member now
    // opens onto its own controls, the way the group opens onto its
    // members.
    const memberId = members[0].getAttribute("data-testid")!.replace("art-member-", "");
    expect(members[0].getAttribute("data-open")).toBe("false");
    await user.click(screen.getByTestId(`art-open-member-${memberId}`));
    expect(screen.getByTestId(`art-member-${memberId}`).getAttribute("data-open")).toBe("true");
    // A pixel layer's own control is its paint, so what proves the row
    // opened is the row's height changing rather than a specific dial:
    // the chevron is the thing under test, and it closes again.
    await user.click(screen.getByTestId(`art-open-member-${memberId}`));
    expect(screen.getByTestId(`art-member-${memberId}`).getAttribute("data-open")).toBe("false");

    // Ungroup returns two top-level rows.
    fireEvent.mouseDown(screen.getByTestId(`art-layer-${groupId}`));
    await user.click(screen.getByTestId("art-ungroup"));
    expect(screen.queryAllByTestId(/^art-member-/)).toHaveLength(0);
    expect(screen.getAllByTestId(/^art-layer-/)).toHaveLength(2);
  });

  it("one layer takes every tool, and clone records where it read from", async () => {
    const user = userEvent.setup();
    await openFinish(user);

    // "We should have one layer that works with all the
    // tools." No layer at all is the only reason a tool is dark.
    expect(screen.getByTestId("art-tool-repair")).toBeDisabled();
    await user.click(screen.getByTestId("art-add-content"));
    // Dodge and burn share one button, and clone and heal share another,
    // so each pair is named for the button rather than for each half.
    for (const t of ["paint", "repair", "dodgeburn", "erase"]) {
      expect(screen.getByTestId(`art-tool-${t}`)).toBeEnabled();
    }
    // Clone is the shared button's other half: a right-click (or a
    // hold) opens the switch menu.
    fireEvent.contextMenu(screen.getByTestId("art-tool-repair"));
    await user.click(screen.getByTestId("art-repair-option-clone"));
    expect(screen.getByTestId("brush-overlay")).toBeInTheDocument();
    // No source picked yet: nothing marks the viewer.
    expect(screen.queryByTestId("clone-source")).not.toBeInTheDocument();

    // ALT-click sets the source instead of switching to an eraser.
    fireEvent.mouseDown(screen.getByTestId("brush-overlay"), { altKey: true, button: 0 });
    expect(screen.getByTestId("clone-source")).toBeInTheDocument();

    // Heal is the same button's other half, on the same layer.
    fireEvent.contextMenu(screen.getByTestId("art-tool-repair"));
    await user.click(screen.getByTestId("art-repair-option-heal"));
    expect(screen.getByTestId("art-tool-repair").getAttribute("data-active")).toBe("true");
    expect(screen.getByTestId("art-tool-repair").getAttribute("data-mode")).toBe("heal");
  });

  it("the toolbar's menus open upward rather than out of the window", async () => {
    const user = userEvent.setup();
    await openFinish(user);
    await user.click(screen.getByTestId("art-add-content"));
    await user.click(screen.getByTestId("art-tool-paint"));

    // "It only does when the window is maximized, I think its
    // a strange experience for it to extend outside the main window." A
    // native select hands its list to the OS, which is free to draw
    // outside the window; this one is ours, and flips on the same rule the
    // color picker uses.
    const near = (el: HTMLElement, top: number) => {
      el.getBoundingClientRect = () =>
        ({ top, bottom: top + 18, left: 0, right: 80, width: 80, height: 18, x: 0, y: top, toJSON() {} }) as DOMRect;
    };
    // Sitting near the bottom of the window: the list goes above.
    near(screen.getByTestId("art-tip"), window.innerHeight - 40);
    await user.click(screen.getByTestId("art-tip"));
    expect(screen.getByTestId("art-tip-menu").style.bottom).toBe("calc(100% + 4px)");
    await user.click(screen.getByTestId("art-tip-option-crosshatch"));

    // With room below, it opens the ordinary way.
    near(screen.getByTestId("art-tip"), 20);
    await user.click(screen.getByTestId("art-tip"));
    expect(screen.getByTestId("art-tip-menu").style.top).toBe("calc(100% + 4px)");
  });

  it("the pen draws curves, and heal asks for a source before it will repair", async () => {
    const user = userEvent.setup();
    await openFinish(user);
    await user.click(screen.getByTestId("art-add-content"));

    // The pen: click for a corner, drag for a curve, close to commit.
    await user.click(screen.getByTestId("art-tool-select"));
    await pickMethod("pen");
    const overlay = screen.getByTestId("selection-overlay");
    stubBox(overlay);
    fireEvent.mouseDown(overlay, { button: 0, clientX: 40, clientY: 40 });
    fireEvent.mouseUp(overlay);
    expect(screen.getByTestId("pen-anchor-0")).toBeInTheDocument();
    fireEvent.mouseDown(overlay, { button: 0, clientX: 160, clientY: 50 });
    fireEvent.mouseUp(overlay);
    fireEvent.mouseDown(overlay, { button: 0, clientX: 120, clientY: 160 });
    fireEvent.mouseUp(overlay);
    expect(screen.getAllByTestId(/^pen-anchor-/)).toHaveLength(3);
    // ENTER closes the path and leaves the anchors behind...
    fireEvent.keyDown(window, { key: "Enter" });
    expect(screen.queryAllByTestId(/^pen-anchor-/)).toHaveLength(0);
    // ...having committed a region, which the marching ants trace. An
    // ENTER that cleared the anchors without storing anything would
    // look identical on screen, so this is the assertion that matters.
    expect(screen.queryAllByTestId(/^ants-/).length).toBeGreaterThan(0);

    // The pen is now the only click-to-place method, so it has to carry
    // what Polygon carried. Two of those: a corner stays a corner even
    // when the hand wobbles, and a double-click closes the path.
    fireEvent.mouseDown(overlay, { button: 0, clientX: 40, clientY: 40 });
    // Two pixels of drift on a 200px box is a click, not a curve.
    fireEvent.mouseMove(overlay, { buttons: 1, clientX: 42, clientY: 41 });
    fireEvent.mouseUp(overlay);
    // Asserted as a boolean: handing chai an SVG element to format
    // crashes it before it can report the real result.
    const hasHandle = (j: number) =>
      !!screen.getByTestId(`pen-anchor-${j}`).querySelector("line");
    expect(hasHandle(0)).toBe(false);
    // A real drag does bend it, so the deadzone is not just deadness.
    fireEvent.mouseDown(overlay, { button: 0, clientX: 160, clientY: 50 });
    fireEvent.mouseMove(overlay, { buttons: 1, clientX: 185, clientY: 75 });
    fireEvent.mouseUp(overlay);
    expect(hasHandle(1)).toBe(true);
    fireEvent.mouseDown(overlay, { button: 0, clientX: 120, clientY: 160 });
    fireEvent.mouseUp(overlay);
    fireEvent.doubleClick(overlay);
    expect(screen.queryAllByTestId(/^pen-anchor-/)).toHaveLength(0);

    // Heal with nothing ALT-clicked used to fall through to
    // content-aware fill. That is gone, so it now refuses exactly as
    // clone always has. Asserted by painting a stroke and finding no
    // stroke on the layer: the previous version of this test only
    // checked that the overlay existed, which stayed true either way and
    // is why it did not notice the behavior change.
    await user.click(screen.getByTestId("art-tool-select"));
    // Heal is the repair button's default half, so one tap arms it.
    await user.click(screen.getByTestId("art-tool-repair"));
    expect(screen.queryByTestId("clone-source")).not.toBeInTheDocument();
    const brush = screen.getByTestId("brush-overlay");
    stubBox(brush);
    const { getEntries } = await import("../log");
    // Refused at mousedown, before anything is laid down. Refusing on
    // release meant a stroke appeared, followed the drag and then
    // vanished with a message, which reads as broken rather than unready.
    fireEvent.mouseDown(brush, { button: 0, clientX: 80, clientY: 80 });
    await vi.waitFor(() => {
      expect(getEntries().some((e) => /^Heal:.*click/i.test(e.message))).toBe(true);
    });
    fireEvent.mouseMove(brush, { buttons: 1, clientX: 100, clientY: 100 });
    expect(screen.queryByTestId("selection-live")).not.toBeInTheDocument();
    fireEvent.mouseUp(brush);
  });

  it("offers Aligned only to the tools that read from a source", async () => {
    // It "should only be visible with clone stamp and healing
    // tool, it doesn't make sense otherwise". A switch that governs nothing
    // is worse than an absent one, because it invites the question of what
    // it just did.
    const user = userEvent.setup();
    await openFinish(user);
    await user.click(screen.getByTestId("art-add-content"));

    await user.click(screen.getByTestId("art-tool-paint"));
    expect(screen.queryByTestId("brush-clone-aligned")).not.toBeInTheDocument();

    // Clone is the repair button's other half, reached from its menu.
    fireEvent.contextMenu(screen.getByTestId("art-tool-repair"));
    await user.click(screen.getByTestId("art-repair-option-clone"));
    expect(screen.getByTestId("brush-clone-aligned")).toBeInTheDocument();

    fireEvent.contextMenu(screen.getByTestId("art-tool-repair"));
    await user.click(screen.getByTestId("art-repair-option-heal"));
    expect(screen.getByTestId("brush-clone-aligned")).toBeInTheDocument();

    await user.click(screen.getByTestId("art-tool-erase"));
    expect(screen.queryByTestId("brush-clone-aligned")).not.toBeInTheDocument();
  });

  it("a clipping mask indents in the stack and releases from the menu", async () => {
    const user = userEvent.setup();
    await openFinish(user);
    await user.click(screen.getByTestId("art-add-content"));
    await user.click(screen.getByTestId("art-add-content"));

    // The top layer clips to the one below via the Layer menu, the
    // route both reference apps share.
    fireEvent.mouseDown(screen.getByTestId("art-layer-art_b2"));
    await user.click(screen.getByTestId("menu-layer"));
    await user.click(screen.getByTestId("menu-layer-clip"));

    // The stack says so: the clipped row indents toward its base and
    // wears the arrow.
    expect(screen.getByTestId("art-clip-mark-art_b2")).toBeInTheDocument();
    expect(screen.getByTestId("art-layer-art_b2")).toHaveStyle({ marginLeft: "14px" });
    expect(screen.queryByTestId("art-clip-mark-art_b1")).not.toBeInTheDocument();

    // The bottom layer cannot clip: nothing is below it.
    fireEvent.mouseDown(screen.getByTestId("art-layer-art_b1"));
    await user.click(screen.getByTestId("menu-layer"));
    expect(screen.getByTestId("menu-layer-clip")).toBeDisabled();
    await user.click(screen.getByTestId("menu-layer"));

    // Release undoes it.
    fireEvent.mouseDown(screen.getByTestId("art-layer-art_b2"));
    await user.click(screen.getByTestId("menu-layer"));
    await user.click(screen.getByTestId("menu-layer-unclip"));
    expect(screen.queryByTestId("art-clip-mark-art_b2")).not.toBeInTheDocument();
  });

  it("the eraser is a brush like any other", async () => {
    const user = userEvent.setup();
    await openFinish(user);
    await user.click(screen.getByTestId("art-add-content"));
    await user.click(screen.getByTestId("art-tool-erase"));
    // Its settings live where every brush's settings live: the same panel,
    // same tips, same size and flow. "Even tho it is a brush it
    // is not using the brush engine we built."
    expect(screen.getByTestId("art-brush-panel")).toBeInTheDocument();
    expect(screen.getByTestId("brush-overlay")).toBeInTheDocument();

    // And what it commits is an erase stroke on the active layer.
    const overlay = screen.getByTestId("brush-overlay");
    stubBox(overlay);
    fireEvent.mouseDown(overlay, { button: 0, clientX: 40, clientY: 40 });
    fireEvent.mouseMove(overlay, { buttons: 1, clientX: 90, clientY: 90 });
    fireEvent.mouseUp(overlay, { clientX: 90, clientY: 90 });
    await user.click(screen.getByTestId("menu-edit"));
    expect(screen.getByTestId("menu-edit-undo")).toBeEnabled();
  });

  it("a dodge and burn layer is empty, soft light, and stores only strokes", async () => {
    const user = userEvent.setup();
    await openFinish(user);
    // No layer button any more: it was heeler.paint with the blend mode set
    // to Soft Light and nothing else, which is a dropdown away.
    // "What does the layer offer that a regular pixel layer does not that
    // uses the same blend method?" The tool makes its own.
    expect(screen.queryByTestId("art-add-dodgeburn")).not.toBeInTheDocument();
    // And the tool is reachable with no layers at all, rather than
    // grayed out until you have built the right one by hand.
    const pair = screen.getByTestId("art-tool-dodgeburn");
    expect(pair).toBeEnabled();
    // One button for the pair, not two: they are one gesture with a
    // sign on it. The freed slot is the eraser.
    expect(screen.queryByTestId("art-tool-dodge")).not.toBeInTheDocument();
    expect(screen.getByTestId("art-tool-erase")).toBeInTheDocument();
    expect(pair).toHaveAttribute("data-mode", "dodge");
    fireEvent.mouseDown(pair, { button: 0 });
    fireEvent.mouseUp(pair);

    // The owner's point: a layer editor needs a 50% gray fill (and people
    // duplicate a whole pixel layer) because its layer has to be opaque for
    // Soft Light to reach the picture. Here an unpainted canvas is
    // transparent and the blend reads that as "leave it alone", so the layer
    // ships empty and the file carries strokes and nothing else.
    expect(screen.getByTestId("art-layer-art_b1").textContent).toContain("Dodge & Burn");
    expect(menuValue(screen.getByTestId("art-mode-art_b1"))).toBe("soft_light");

    expect(screen.getByTestId("brush-overlay")).toBeInTheDocument();
    // Its own strength, kept away from the paint flow: dodging wants a
    // tenth of what painting wants.
    const strength = screen.getByTestId("art-dodge-strength");
    expect(trackValue(strength)).toBeLessThan(30);
    dragTrack(strength, 40);
    expect(trackValue(screen.getByTestId("art-dodge-strength"))).toBe(40);

    // Burn is the same tool pointed the other way, so it is the same
    // button pointed the other way.
    // Holding it offers the other half, and picking one reuses the
    // layer rather than piling up a stack of empty ones.
    await user.click(screen.getByTestId("art-tool-cursor"));
    fireEvent.mouseDown(screen.getByTestId("art-tool-dodgeburn"), { button: 0 });
    const menu = await screen.findByTestId("art-dodgeburn-menu", undefined, { timeout: 2000 });
    fireEvent.mouseUp(screen.getByTestId("art-tool-dodgeburn"));
    fireEvent.click(within(menu).getByTestId("art-dodgeburn-option-burn"));
    expect(screen.getByTestId("art-tool-dodgeburn")).toHaveAttribute("data-mode", "burn");
    expect(screen.getAllByTestId(/^art-layer-/)).toHaveLength(1);
  });

  it("clone and heal share one button, with heal the default half", async () => {
    // "I would like to see Clone and Heal use the same tool
    // slot on the toolbar and the user can switch between the two as
    // needed (like dodge and burn). I think Heal should be the
    // default."
    const user = userEvent.setup();
    await openFinish(user);
    await user.click(screen.getByTestId("art-add-content"));

    // One slot for the pair, not two.
    expect(screen.queryByTestId("art-tool-clone")).not.toBeInTheDocument();
    expect(screen.queryByTestId("art-tool-heal")).not.toBeInTheDocument();
    const pair = screen.getByTestId("art-tool-repair");
    expect(pair).toHaveAttribute("data-mode", "heal");

    // A tap arms the half that is showing.
    await user.click(pair);
    expect(pair).toHaveAttribute("data-active", "true");
    expect(screen.getByTestId("brush-overlay")).toBeInTheDocument();

    // Holding (or right-clicking) offers the other half, and picking it
    // is what the button shows from then on.
    fireEvent.contextMenu(pair);
    const menu = await screen.findByTestId("art-repair-menu");
    await user.click(within(menu).getByTestId("art-repair-option-clone"));
    expect(pair).toHaveAttribute("data-mode", "clone");
    expect(pair).toHaveAttribute("data-active", "true");

    // A tap with the tool in hand puts it down, and the button keeps
    // showing the half it was left with.
    await user.click(pair);
    expect(pair).toHaveAttribute("data-active", "false");
    expect(pair).toHaveAttribute("data-mode", "clone");
  });

  it("the dab wears the color the paint brush is about to lay down", async () => {
    // "fix the color on the dab for paint brush. It always
    // shows as white even when I change the color." The default paint
    // color IS white, which is how the bug hid: the dab and the color
    // agreed by accident until he picked something else.
    const user = userEvent.setup();
    await openFinish(user);
    await user.click(screen.getByTestId("art-add-content"));
    await user.click(screen.getByTestId("art-tool-paint"));
    expect(screen.getByTestId("brush-preview")).toHaveAttribute("data-tint", "255,255,255");
    await user.click(screen.getByTestId("art-color"));
    fireEvent.change(screen.getByTestId("art-color-hex"), { target: { value: "#3a7bd5" } });
    expect(screen.getByTestId("brush-preview")).toHaveAttribute("data-tint", "58,123,213");
  });

  it("layer effects stack, reorder and run between the layer and its blend", async () => {
    const user = userEvent.setup();
    await openFinish(user);
    await user.click(screen.getByTestId("art-add-content"));

    // A layer editor allows one of each effect, in an order you cannot
    // change. These are nodes on a chain, so two glows is a normal
    // thing to want and the order is yours.
    await user.click(screen.getByTestId("art-fx-add-art_b1"));
    await user.click(screen.getByTestId("art-fx-pick-shadow"));
    await user.click(screen.getByTestId("art-fx-add-art_b1"));
    await user.click(screen.getByTestId("art-fx-pick-bevel"));

    const names = () =>
      screen.getAllByTestId(/^art-fx-art_p1_fx/).map((e) => e.textContent?.slice(0, 7));
    expect(names()).toHaveLength(2);
    expect(names()[0]).toContain("Shadow");
    expect(names()[1]).toContain("Bevel");

    // Shadow and glow carry an inner/outer switch; a blur carries its
    // type instead.
    const fxIds = screen
      .getAllByTestId(/^art-fx-art_p1_fx/)
      .map((e) => e.getAttribute("data-testid")!.replace("art-fx-", ""));
    expect(menuValue(screen.getByTestId(`art-fx-inner-${fxIds[0]}`))).toBe("0");
    choose(screen.getByTestId(`art-fx-inner-${fxIds[0]}`), "1");
    expect(menuValue(screen.getByTestId(`art-fx-inner-${fxIds[0]}`))).toBe("1");

    // Reordering is reordering: the bevel runs first now.
    await user.click(screen.getByTestId(`art-fx-up-${fxIds[1]}`));
    expect(names()[0]).toContain("Bevel");

    // And the effects sit between the content and the blend in the
    // graph, which is what makes them effects rather than layers.
    await user.click(screen.getByTestId(`art-fx-remove-${fxIds[0]}`));
    expect(screen.getAllByTestId(/^art-fx-art_p1_fx/)).toHaveLength(1);
  });

  it("a gradient layer has a simple mode and an advanced stop editor", async () => {
    const user = userEvent.setup();
    await openFinish(user);
    await addContent(user, "gradient");
    // Expand settings on select is off by default: the chevron opens it.
    await user.click(screen.getByTestId("art-settings-art_b1"));

    // Simple mode: two colors, an angle, and the center weighting
    // The owner asked for so the split is not always even.
    expect(screen.getByTestId("art-grad-a-art_b1")).toBeInTheDocument();
    expect(screen.getByTestId("art-grad-mid-art_b1")).toBeInTheDocument();
    dragTrack(screen.getByTestId("art-grad-mid-art_b1"), 25);
    expect(trackValue(screen.getByTestId("art-grad-mid-art_b1"))).toBe(25);

    // ADV writes the simple pair out as stops and DRILLS IN: the stack
    // steps aside rather than a popup opening over it. "the
    // pop-up pushed up and got cut off by the header bars... what advanced
    // does is a drill down."
    await user.click(screen.getByTestId("art-grad-advanced-art_b1"));
    expect(screen.getByTestId("art-grad-art_b1-panel")).toBeInTheDocument();
    expect(screen.queryByTestId("art-layer-art_b1")).not.toBeInTheDocument();
    expect(screen.getAllByTestId(/^art-grad-art_b1-stop-\d/)).toHaveLength(2);

    // Every stop gets its own block with its own properties, the way
    // the stack gives one per layer.
    await user.click(screen.getByTestId("art-grad-art_b1-add"));
    expect(screen.getAllByTestId(/^art-grad-art_b1-stop-\d/)).toHaveLength(3);
    for (const i of [0, 1, 2]) {
      expect(screen.getByTestId(`art-grad-art_b1-pos-${i}`)).toBeInTheDocument();
      expect(screen.getByTestId(`art-grad-art_b1-alpha-${i}`)).toBeInTheDocument();
    }
    // Falloff is the blend to the NEXT stop, so the last one has none.
    expect(screen.getByTestId("art-grad-art_b1-mid-1")).toBeInTheDocument();
    expect(screen.queryByTestId("art-grad-art_b1-mid-2")).not.toBeInTheDocument();

    // Down to two: a gradient cannot have fewer.
    await user.click(screen.getByTestId("art-grad-art_b1-remove-2"));
    expect(screen.getAllByTestId(/^art-grad-art_b1-stop-\d/)).toHaveLength(2);
    expect(screen.getByTestId("art-grad-art_b1-remove-0")).toBeDisabled();

    // Back returns to the stack with the layer still advanced.
    await user.click(screen.getByTestId("art-grad-art_b1-back"));
    expect(screen.getByTestId("art-layer-art_b1")).toBeInTheDocument();
    expect(screen.getByTestId("art-grad-advanced-art_b1").getAttribute("data-active")).toBe("true");
  });

  it("fill and gradient layers carry their own controls", async () => {
    const user = userEvent.setup();
    await openFinish(user);

    await addContent(user, "fill");
    // Closed, the row carries the color as a chip that opens the settings;
    // open, Heeler's own picker sits inline (2026-09-30: "instead of having
    // the pop up color swatch the layer could be collapsible/expandable"):
    // a field, a hue rail, swatches and a hex box, with no popover.
    const chip = screen.getByTestId("art-fill-chip-art_b1");
    expect(chip.getAttribute("data-value")).toBe("#808080");
    expect(screen.queryByTestId("art-fill-color-art_b1-field")).toBeNull();
    await user.click(chip);
    expect(screen.queryByTestId("art-fill-chip-art_b1")).toBeNull();
    expect(screen.getByTestId("art-fill-color-art_b1-field")).toBeInTheDocument();
    expect(screen.queryByTestId("art-fill-color-art_b1-popover")).toBeNull();
    fireEvent.change(screen.getByTestId("art-fill-color-art_b1-hex"), {
      target: { value: "#ff0000" },
    });
    expect(screen.getByTestId("art-fill-color-art_b1-r")).toHaveValue("255");
    // A swatch is one click, which is the point of having them.
    await user.click(screen.getByTestId("art-fill-color-art_b1-swatch-000000"));
    expect(screen.getByTestId("art-fill-color-art_b1-r")).toHaveValue("0");

    await addContent(user, "gradient");
    await user.click(screen.getByTestId("art-settings-art_b2"));
    expect(screen.getByTestId("art-grad-a-art_b2")).toBeInTheDocument();
    expect(menuValue(screen.getByTestId("art-grad-shape-art_b2"))).toBe("linear");
    await chooseWith(user, screen.getByTestId("art-grad-shape-art_b2"), "radial");
    expect(menuValue(screen.getByTestId("art-grad-shape-art_b2"))).toBe("radial");
    dragTrack(screen.getByTestId("art-grad-angle-art_b2"), 90);
    expect(trackValue(screen.getByTestId("art-grad-angle-art_b2"))).toBe(90);

    // A pixel layer has no content controls at all: its work is strokes.
    await addContent(user, "paint");
    expect(screen.queryByTestId("art-fill-color-art_b3")).not.toBeInTheDocument();
  });

  it("the tab is called Finish, so 'layers' means one thing per screen", async () => {
    const user = userEvent.setup();
    render(<App />);
    // The word collided with the Develop panel's masking
// layers.
    expect(screen.getByTestId("panel-tab-layers")).toHaveAccessibleName("Finish");
    await user.click(screen.getByTestId("panel-tab-layers"));
    expect(screen.getByTestId("art-layers")).toBeInTheDocument();
  });

  it("the toolbar is icons in two groups, named for hover and screen readers", async () => {
    const user = userEvent.setup();
    await openFinish(user);
    // What makes a layer on the left, what acts on one at the right end.
    const ids = [
      "art-add-content",
      "art-add-content-more",
      "art-add-adjust",
      "art-add-image",
      "art-group",
      "art-delete",
    ];
    for (const id of ids) {
      const btn = screen.getByTestId(id);
      // No words: the glyph carries it, the name is on the label.
      expect(btn.textContent).toBe("");
      expect(btn.querySelector("svg")).toBeTruthy();
      expect(btn.getAttribute("aria-label")).toBeTruthy();
      expect(btn.getAttribute("data-hint")).toBeTruthy();
    }
    // The rendered order is the two groups, in the order asked for.
    const all = Array.from(screen.getByTestId("finish-new-bar").querySelectorAll("[data-testid]")).map((e) => e.getAttribute("data-testid"));
    expect(all.filter((id) => ids.includes(id!))).toEqual(ids);

    // One slot for group/ungroup: a group cannot nest, so when one is
    // selected the position can only mean ungroup.
    expect(screen.queryByTestId("art-ungroup")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("art-add-content"));
    await user.click(screen.getByTestId("art-add-content"));
    fireEvent.mouseDown(screen.getByTestId("art-layer-art_b1"));
    fireEvent.mouseDown(screen.getByTestId("art-layer-art_b2"), { ctrlKey: true });
    await user.click(screen.getByTestId("art-group"));
    expect(screen.getByTestId("art-ungroup")).toBeInTheDocument();
    expect(screen.queryByTestId("art-group")).not.toBeInTheDocument();
  });

  it("the brush keys and settings reach the Finish tools, not just mask brushing", async () => {
    const user = userEvent.setup();
    await openFinish(user);
    await user.click(screen.getByTestId("art-add-content"));
    await user.click(screen.getByTestId("art-tool-paint"));

    // "the [] hotkeys aren't working for brush size". They were
    // gated on the literal "brush" tool, so in Finish they fell through to
    // the rating command instead.
    const size = () => trackValue(screen.getByTestId("art-size"));
    const stars = () =>
      [1, 2, 3, 4, 5].map((n) => screen.getByTestId(`star-4871-${n}`).getAttribute("data-on"));
    const before = size();
    const ratingBefore = stars();
    fireEvent.keyDown(window, { key: "]" });
    expect(size()).toBeGreaterThan(before);
    fireEvent.keyDown(window, { key: "[" });
    fireEvent.keyDown(window, { key: "[" });
    expect(size()).toBeLessThan(before);
    // And the photograph's rating never moved: the same keys rate a
    // photo when no brush is up, which is what they were doing here.
    expect(stars()).toEqual(ratingBefore);

    // The tips from mask painting are here, and the panel below the
    // stack carries their settings: same component, one brush engine.
    await pickFrom(user, "art-tip", "crosshatch");
    expect(screen.getByTestId("art-brush-panel")).toBeInTheDocument();
    expect(menuValue(screen.getByTestId("brush-tip"))).toBe("crosshatch");
    // A textured tip brings its own controls with it.
    expect(screen.getByTestId("brush-texture-scale")).toBeInTheDocument();
    // The panel folds away when the stack wants the room.
    await user.click(screen.getByTestId("art-brush-toggle"));
    expect(screen.queryByTestId("brush-tip")).not.toBeInTheDocument();
  });

  it("exactly one tool is lit, and the cursor is the way out of the others", async () => {
    const user = userEvent.setup();
    await openFinish(user);
    await user.click(screen.getByTestId("art-add-content"));
    const lit = () =>
      ["cursor", "select", "paint", "repair"].filter(
        (t) => screen.getByTestId(`art-tool-${t}`).getAttribute("data-active") === "true",
      );
    // Nothing armed means the cursor is armed: "no tool" is a place you
    // can point at rather than a thing you infer.
    expect(lit()).toEqual(["cursor"]);

    // The repair pair lights its one shared slot (clone is its other
    // half, reached from the menu).
    fireEvent.contextMenu(screen.getByTestId("art-tool-repair"));
    await user.click(screen.getByTestId("art-repair-option-clone"));
    expect(lit()).toEqual(["repair"]);
    expect(screen.getByTestId("art-tool-repair")).toHaveAttribute("data-mode", "clone");
    await user.click(screen.getByTestId("art-tool-paint"));
    expect(lit()).toEqual(["paint"]);
    // The cursor puts whatever is up away, in one click.
    await user.click(screen.getByTestId("art-tool-cursor"));
    expect(lit()).toEqual(["cursor"]);
    expect(screen.queryByTestId("brush-overlay")).not.toBeInTheDocument();
  });

  it("selecting offers the marquee shapes and every method the engine knows", async () => {
    const user = userEvent.setup();
    await openFinish(user);
    await user.click(screen.getByTestId("art-add-content"));

    // No separate shape dropdown: the tool button IS the picker, and it
    // wears the current shape so the row says what it will draw.
    expect(screen.queryByTestId("art-select-method")).not.toBeInTheDocument();
    const tool = screen.getByTestId("art-tool-select");
    expect(tool).toHaveAttribute("data-method", "freehand");

    // What a region does is always on show, and disabled until the tool
    // is armed rather than appearing out of nowhere with it.
    const opField = screen.getByTestId("art-select-op");
    expect(opField).toBeDisabled();

    // A tap arms the tool without opening anything.
    fireEvent.mouseDown(tool, { button: 0 });
    fireEvent.mouseUp(tool);
    expect(screen.queryByTestId("art-select-method-menu")).not.toBeInTheDocument();
    expect(tool).toHaveAttribute("data-active", "true");
    expect(screen.getByTestId("art-select-op")).toBeEnabled();

    // A hold opens the list, above the toolbar and in our own chrome.
    fireEvent.mouseDown(tool, { button: 0 });
    const menu = await screen.findByTestId("art-select-method-menu", undefined, { timeout: 2000 });
    fireEvent.mouseUp(tool);
    expect(menu.style.bottom).toBe("calc(100% + 5px)");
    expect(
      within(menu)
        .getAllByTestId(/^art-select-method-option-/)
        .map((o) => o.getAttribute("data-testid")!.replace("art-select-method-option-", "")),
    ).toEqual([
      "rect",
      "ellipse",
      "pen",
      "freehand",
      "magnetic",
      "paint",
      "wand",
      // Region Select: the picture's own structure does the drawing.
      "region",
      // Smart click: the model does, and it makes a selection only.
      "smart",
    ]);
    fireEvent.click(within(menu).getByTestId("art-select-method-option-ellipse"));
    // And it sticks: the picked shape is what the button now is.
    expect(screen.queryByTestId("art-select-method-menu")).not.toBeInTheDocument();
    expect(screen.getByTestId("art-tool-select")).toHaveAttribute("data-method", "ellipse");

    // Dragging an ellipse leaves an ellipse region on the mask, kept as
    // a shape rather than flattened into a polygon.
    const overlay = screen.getByTestId("selection-overlay");
    fireEvent.mouseDown(overlay, { button: 0, clientX: 10, clientY: 10 });
    fireEvent.mouseMove(overlay, { buttons: 1, clientX: 60, clientY: 40 });
    expect(screen.getByTestId("selection-live-marquee").tagName.toLowerCase()).toBe("ellipse");
    fireEvent.mouseUp(overlay);
  });

  it("an adjustment layer edits what is below it and shows its own controls", async () => {
    const user = userEvent.setup();
    await openFinish(user);

    // What this test reads is Expand settings on select's behavior:
    // the selected layer's controls open, the rest close.
    await user.click(screen.getByTestId("art-expand-on-select"));
    await addAdjustment(user, "exposure");
    expect(screen.getByTestId("art-layer-art_b1").textContent).toContain("Exposure");
    // Selected, so its controls are in place under the row.
    const slider = screen.getByTestId("art-param-art_b1-exposure");
    dragTrack(slider, 1.5);
    expect(trackValue(screen.getByTestId("art-param-art_b1-exposure"))).toBe(1.5);
    // It takes a mask and a blend mode like any other layer: that is
    // the whole reason adjustments live in this stack.
    expect(screen.getByTestId("art-mask-add-art_b1")).toBeInTheDocument();
    expect(screen.getByTestId("art-mode-art_b1")).toBeInTheDocument();

    // A curves adjustment gets the real curve editor, not sliders.
    // Scoped to the tab: the Develop panel keeps its own curve editor
    // mounted behind the scenes.
    await addAdjustment(user, "curves");
    expect(
      within(screen.getByTestId("art-layers")).getByTestId("curve-plot"),
    ).toBeInTheDocument();

    // White Balance and Color are the same engine node showing
    // different halves of itself; neither offers the other's sliders.
    await addAdjustment(user, "white_balance");
    expect(screen.getByTestId("art-param-art_b3-temperature")).toBeInTheDocument();
    expect(screen.queryByTestId("art-param-art_b3-saturation")).not.toBeInTheDocument();
    await addAdjustment(user, "color");
    expect(screen.getByTestId("art-param-art_b4-saturation")).toBeInTheDocument();
    expect(screen.queryByTestId("art-param-art_b4-temperature")).not.toBeInTheDocument();

    // Controls belong to the selected layer only: the stack stays a
    // stack rather than a wall of sliders.
    expect(screen.queryByTestId("art-param-art_b1-exposure")).not.toBeInTheDocument();
  });

  it("opacity, mode, visibility and stacking all drive the graph", async () => {
    const user = userEvent.setup();
    await openFinish(user);
    await user.click(screen.getByTestId("art-add-content"));
    await user.click(screen.getByTestId("art-add-content"));

    // Two layers, newest on top of the panel.
    const rows = screen.getAllByTestId(/^art-layer-/);
    expect(rows.map((r) => r.getAttribute("data-testid"))).toEqual([
      "art-layer-art_b2",
      "art-layer-art_b1",
    ]);

    await chooseWith(user, screen.getByTestId("art-mode-art_b2"), "multiply");
    expect(menuValue(screen.getByTestId("art-mode-art_b2"))).toBe("multiply");

    dragTrack(screen.getByTestId("art-opacity-art_b2"), 40);
    expect(trackValue(screen.getByTestId("art-opacity-art_b2"))).toBe(40);

    // Visibility toggles the blend node rather than deleting anything.
    await user.click(screen.getByTestId("art-vis-art_b2"));
    expect(screen.getByTestId("art-vis-art_b2")).toHaveAccessibleName(/show layer/i);

    // Reorder: move the lower layer up the stack.
    await user.click(screen.getByTestId("art-up-art_b1"));
    expect(
      screen.getAllByTestId(/^art-layer-/).map((r) => r.getAttribute("data-testid")),
    ).toEqual(["art-layer-art_b1", "art-layer-art_b2"]);

    // Delete the selected layer (b1 became active when added; select b2).
    fireEvent.mouseDown(screen.getByTestId("art-layer-art_b2"));
    await user.click(screen.getByTestId("art-delete"));
    expect(screen.queryByTestId("art-layer-art_b2")).not.toBeInTheDocument();
    expect(screen.getByTestId("art-layer-art_b1")).toBeInTheDocument();
  });
});

describe("the Select menu", () => {
  it("carries every selection command, and none are left in Edit", async () => {
    const user = userEvent.setup();
    await openFinish(user);

    // Moved out of Edit wholesale, rather than living in both places.
    await user.click(screen.getByTestId("menu-edit"));
    expect(screen.queryByTestId("menu-edit-select-all")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("menu-edit"));

    await user.click(screen.getByTestId("menu-select"));
    for (const id of [
      "all", "none", "invert",
      "smooth", "feather", "resize",
      "fill",
    ]) {
      expect(screen.getByTestId(`menu-select-${id}`)).toBeInTheDocument();
    }
    // The Select by four live in their own submenu now.
    fireEvent.mouseEnter(screen.getByTestId("menu-select-by").parentElement!);
    for (const id of ["luma", "color", "contrast"]) {
      expect(screen.getByTestId(`menu-select-${id}`)).toBeInTheDocument();
    }
    // Grayed with nothing to act on, rather than silently doing
    // nothing when clicked.
    expect(screen.getByTestId("menu-select-smooth")).toBeDisabled();
  });

  it("Smooth steers the real mask and Cancel puts it back", async () => {
    const user = userEvent.setup();
    await openFinish(user);
    await user.click(screen.getByTestId("art-add-content"));
    await user.click(screen.getByTestId("art-tool-select"));

    await user.click(screen.getByTestId("menu-select"));
    await user.click(screen.getByTestId("menu-select-smooth"));
    const slider = screen.getByTestId("select-param-smooth");
    dragTrack(slider, 0.6);
    expect(screen.getByTestId("select-param-smooth-value")).toHaveValue("60");

    // Cancel is an undo of what you just watched happen, not the
    // discarding of a draft: the photograph was rendering with it the
    // whole time.
    await user.click(screen.getByTestId("select-param-dialog-cancel"));
    expect(screen.queryByTestId("select-param-dialog")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("menu-select"));
    await user.click(screen.getByTestId("menu-select-smooth"));
    expect(screen.getByTestId("select-param-smooth-value")).toHaveValue("0");
  });

  it("Draw from Center, Antialias and Auto Clear are switches in the menu", async () => {
    const user = userEvent.setup();
    await openFinish(user);
    await user.click(screen.getByTestId("art-add-content"));
    await user.click(screen.getByTestId("art-tool-select"));

    await user.click(screen.getByTestId("menu-select"));
    // Shipped defaults: center off, antialias on, auto clear on, and
    // the smart click dots showing.
    expect(screen.getByTestId("menu-select-from-center")).not.toHaveAttribute("data-checked");
    expect(screen.getByTestId("menu-select-antialias")).toHaveAttribute("data-checked");
    expect(screen.getByTestId("menu-select-autoclear")).toHaveAttribute("data-checked");
    expect(screen.getByTestId("menu-select-show-clicks")).toHaveAttribute("data-checked");
    await user.click(screen.getByTestId("menu-select-from-center"));
    await user.click(screen.getByTestId("menu-select"));
    expect(screen.getByTestId("menu-select-from-center")).toHaveAttribute("data-checked");
    await user.click(screen.getByTestId("menu-select"));

    // A rectangle now grows from where the drag began.
    const overlay = screen.getByTestId("selection-overlay");
    stubBox(overlay);
    await pickMethod("rect");
    fireEvent.mouseDown(overlay, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.mouseMove(overlay, { buttons: 1, clientX: 140, clientY: 140 });
    const live = screen.getByTestId("selection-live-marquee");
    // Centered on the start: 60..140 of 200, not 100..140.
    expect(Number(live.getAttribute("x"))).toBeCloseTo(30, 0);
    expect(Number(live.getAttribute("width"))).toBeCloseTo(40, 0);
    fireEvent.mouseUp(overlay, { clientX: 140, clientY: 140 });
  });

  it("Polish puts you in a brush, and the strokes land on the mask", async () => {
    // Behind the gate for users until the matte holds up on real
    // photographs; the machinery stays tested underneath it.
    const { setPolishForTests } = await import("../features");
    setPolishForTests(true);
    const user = userEvent.setup();
    await openFinish(user);
    await user.click(screen.getByTestId("art-add-content"));
    await user.click(screen.getByTestId("art-tool-select"));
    const overlay = screen.getByTestId("selection-overlay");
    stubBox(overlay);
    fireEvent.mouseDown(overlay, { button: 0, clientX: 20, clientY: 20 });
    for (let i = 1; i <= 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      fireEvent.mouseMove(overlay, { buttons: 1, clientX: 100 + Math.cos(a) * 50, clientY: 100 + Math.sin(a) * 50 });
    }
    fireEvent.mouseUp(overlay);

    await user.click(screen.getByTestId("menu-select"));
    await user.click(screen.getByTestId("menu-select-polish"));
    // A brush, not a dialog. "In both [the layer
    // editors] this is an interactive tool."
    expect(screen.queryByTestId("select-polish-dialog")).not.toBeInTheDocument();
    const brush = screen.getByTestId("brush-overlay");
    // The ants stand down while refining, per the layer editors:
    // the overlay is the selection here, and a boundary traced from the
    // pre-polish geometry would contradict what the brush is doing.
    expect(screen.queryByTestId("selection-ants")).not.toBeInTheDocument();
    // Modal: the two ways out are on screen.
    expect(screen.getByTestId("art-polish-apply")).toBeInTheDocument();
    expect(screen.getByTestId("art-polish-cancel")).toBeInTheDocument();

    // Four modes, the same four both apps settled on.
    await user.click(screen.getByTestId("art-polish-mode"));
    expect(
      screen
        .getAllByTestId(/^art-polish-mode-option-/)
        .map((o) => o.getAttribute("data-testid")!.replace("art-polish-mode-option-", "")),
    ).toEqual(["matte", "foreground", "background", "feather"]);
    await user.click(screen.getByTestId("art-polish-mode-option-feather"));

    // A stroke lands on the mask as geometry, carrying its mode and its
    // own radius: no Apply, nothing baked.
    stubBox(brush);
    fireEvent.mouseDown(brush, { button: 0, clientX: 40, clientY: 100 });
    fireEvent.mouseMove(brush, { buttons: 1, clientX: 90, clientY: 100 });
    fireEvent.mouseUp(brush, { clientX: 90, clientY: 100 });
    // The undo entry proves it reached the graph rather than the canvas.
    await user.click(screen.getByTestId("menu-edit"));
    expect(screen.getByTestId("menu-edit-undo")).toBeEnabled();
    setPolishForTests(null);
  });

  it("polishing slims the toolbar to what polish can use", async () => {
    // "hide the other icons that don't get used in selection
    // polish... only show controls that are relevant." The left cluster
    // (cursor, transform, select) and the paint half (op menu, paint,
    // retouch, color) stand down; the brush size and tip stay, because the
    // polish brush rides the same engine. Everything returns when polish
    // ends.
    const { setPolishForTests } = await import("../features");
    setPolishForTests(true);
    const user = userEvent.setup();
    await openFinish(user);
    await user.click(screen.getByTestId("art-add-content"));
    await user.click(screen.getByTestId("art-tool-select"));
    const overlay = screen.getByTestId("selection-overlay");
    stubBox(overlay);
    fireEvent.mouseDown(overlay, { button: 0, clientX: 20, clientY: 20 });
    for (let i = 1; i <= 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      fireEvent.mouseMove(overlay, { buttons: 1, clientX: 100 + Math.cos(a) * 50, clientY: 100 + Math.sin(a) * 50 });
    }
    fireEvent.mouseUp(overlay);
    expect(screen.getByTestId("art-tool-cursor")).toBeInTheDocument();
    expect(screen.getByTestId("art-tool-paint")).toBeInTheDocument();

    await user.click(screen.getByTestId("menu-select"));
    await user.click(screen.getByTestId("menu-select-polish"));
    for (const gone of ["art-tool-cursor", "art-tool-select", "art-select-op", "art-tool-paint", "art-color"]) {
      expect(screen.queryByTestId(gone)).not.toBeInTheDocument();
    }
    for (const kept of ["art-polish-preview", "art-polish-mode", "art-polish-matte", "art-polish-apply", "art-polish-cancel", "art-size", "art-tip"]) {
      expect(screen.getByTestId(kept)).toBeInTheDocument();
    }

    // Apply ends the pass and the bar comes back whole.
    await user.click(screen.getByTestId("art-polish-apply"));
    expect(screen.getByTestId("art-tool-cursor")).toBeInTheDocument();
    expect(screen.getByTestId("art-tool-paint")).toBeInTheDocument();
    setPolishForTests(null);
  });

  it("arming the select tool opens the selection split with its dials", async () => {
    // The dials lived only in the Develop tab's selection-layer section,
    // so the document-selection flow had a tool with no settings anywhere
    // on screen. "I am not seeing the sensitivity slider... I
    // would imagine tool settings in the right panel." They arrive as an
    // automatic split below the panes, and leave when the tool does.
    const user = userEvent.setup();
    await openFinish(user);
    await user.click(screen.getByTestId("art-add-content"));
    expect(screen.queryByTestId("select-tab")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("art-tool-select"));
    expect(screen.getByTestId("select-tab")).toBeInTheDocument();
    // Magnetic shows its own two dials, and RESET puts them back.
    choose(screen.getByTestId("select-method"), "magnetic");
    expect(screen.getByTestId("select-tolerance")).toBeInTheDocument();
    const sense = screen.getByTestId("select-magnet-sense");
    dragTrack(sense, 0.9);
    expect(trackValue(sense)).toBe(0.9);
    await user.click(screen.getByTestId("select-reset"));
    expect(trackValue(screen.getByTestId("select-magnet-sense"))).toBe(0.5);

    // The split folds to a bar and comes back. "it
    // should have a minimize button so it collapses to the bottom."
    await user.click(screen.getByTestId("selection-split-min"));
    expect(screen.queryByTestId("select-tab")).not.toBeInTheDocument();
    expect(screen.getByTestId("selection-split-bar")).toBeInTheDocument();
    await user.click(screen.getByTestId("selection-split-bar"));
    expect(screen.getByTestId("select-tab")).toBeInTheDocument();
    // A dragged height survives the fold: the seam is there to drag,
    // and the height is state rather than layout accident.
    expect(screen.getByTestId("divider-selection-split")).toBeInTheDocument();

    // And it closes outright, not just folds. "The
    // Selection panel that appears should also have a close button and
    // not just the min button." Close puts the tool away and the panel
    // follows; arming the select tool brings it back.
    await user.click(screen.getByTestId("selection-split-close"));
    expect(screen.queryByTestId("select-tab")).not.toBeInTheDocument();
    expect(screen.queryByTestId("selection-split-bar")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("art-tool-select"));
    expect(screen.getByTestId("select-tab")).toBeInTheDocument();
  });

  it("Polish is in the menu now, and the gate can still pull it", async () => {
    // The tool was hidden while the classical matte lost fine fur (The
    // report: "I don't want to deliver a broken feature"); P4's ViTMatte
    // refinement opened the gate. The gate itself must keep working both
    // ways, so one flip can retract the tool if real photographs disagree
    // with the synthetic proof.
    const { setPolishForTests } = await import("../features");
    const user = userEvent.setup();
    await openFinish(user);
    await user.click(screen.getByTestId("art-add-content"));
    await user.click(screen.getByTestId("menu-select"));
    expect(screen.getByTestId("menu-select-polish")).toBeInTheDocument();
    expect(screen.getByTestId("menu-select-smooth")).toBeInTheDocument();
    // Close (the label toggles), gate off, reopen: the item is gone
    // and its neighbors are untouched.
    await user.click(screen.getByTestId("menu-select"));
    setPolishForTests(false);
    await user.click(screen.getByTestId("menu-select"));
    expect(screen.queryByTestId("menu-select-polish")).not.toBeInTheDocument();
    expect(screen.getByTestId("menu-select-smooth")).toBeInTheDocument();
    setPolishForTests(null);
  });

  it("Resize takes a value typed past the slider's reach", async () => {
    const user = userEvent.setup();
    await openFinish(user);
    await user.click(screen.getByTestId("art-add-content"));
    await user.click(screen.getByTestId("art-tool-select"));
    const overlay = screen.getByTestId("selection-overlay");
    stubBox(overlay);
    fireEvent.mouseDown(overlay, { button: 0, clientX: 20, clientY: 20 });
    for (let i = 1; i <= 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      fireEvent.mouseMove(overlay, { buttons: 1, clientX: 100 + Math.cos(a) * 50, clientY: 100 + Math.sin(a) * 50 });
    }
    fireEvent.mouseUp(overlay);

    await user.click(screen.getByTestId("menu-select"));
    await user.click(screen.getByTestId("menu-select-resize"));
    const field = screen.getByTestId("select-param-grow-value");
    // The slider stops at 100; 250 is a number someone meant.
    fireEvent.change(field, { target: { value: "250" } });
    fireEvent.blur(field);
    expect(screen.getByTestId("select-param-grow-value")).toHaveValue("+250");
    // The slider itself still works within its own range, parked at the
    // end rather than drawn off the track: the value reads past the end
    // (the typed 250%), while the handle sits at 100%.
    const growTrack = screen.getByTestId("select-param-grow");
    expect(trackValue(growTrack)).toBeGreaterThan(1);
    expect((growTrack.querySelector(".handle") as HTMLElement).style.left).toBe("100%");

    // And a limit that is real still holds: no negative feather.
    await user.click(screen.getByTestId("select-param-dialog-done"));
    await user.click(screen.getByTestId("menu-select"));
    await user.click(screen.getByTestId("menu-select-feather"));
    const f = screen.getByTestId("select-param-feather-value");
    fireEvent.change(f, { target: { value: "-40" } });
    fireEvent.blur(f);
    expect(screen.getByTestId("select-param-feather-value")).toHaveValue("0");
  });

  it("a luma range selects on open, and Cancel takes it back out", async () => {
    const user = userEvent.setup();
    await openFinish(user);
    await user.click(screen.getByTestId("art-add-content"));
    await user.click(screen.getByTestId("art-tool-select"));

    await user.click(screen.getByTestId("menu-select"));
    fireEvent.mouseEnter(screen.getByTestId("menu-select-by").parentElement!);
    await user.click(screen.getByTestId("menu-select-luma"));
    // The ants are already tracing something: the region went in on
    // open so the dialog shows its work.
    expect(screen.getByTestId("range-lo-value")).toHaveValue("50");
    dragTrack(screen.getByTestId("range-lo"), 0.7);
    expect(screen.getByTestId("range-lo-value")).toHaveValue("70");
    // The two limits cannot cross.
    dragTrack(screen.getByTestId("range-hi"), 0.3);
    expect(Number((screen.getByTestId("range-hi-value") as HTMLInputElement).value)).toBeGreaterThanOrEqual(70);

    await user.click(screen.getByTestId("select-range-dialog-cancel"));
    expect(screen.queryByTestId("select-range-dialog")).not.toBeInTheDocument();
    // Cancel removed the region it added, or Cancel would mean apply.
    expect(screen.queryAllByTestId(/^ants-/)).toHaveLength(0);
  });

  it("the color range offers channels; contrast offers no histogram", async () => {
    const user = userEvent.setup();
    await openFinish(user);
    await user.click(screen.getByTestId("art-add-content"));
    await user.click(screen.getByTestId("art-tool-select"));

    await user.click(screen.getByTestId("menu-select"));
    fireEvent.mouseEnter(screen.getByTestId("menu-select-by").parentElement!);
    await user.click(screen.getByTestId("menu-select-color"));
    expect(screen.getByTestId("range-channel")).toHaveAttribute("data-value", "red");
    await user.click(screen.getByTestId("range-channel"));
    await user.click(screen.getByTestId("range-channel-option-blue"));
    expect(screen.getByTestId("range-channel")).toHaveAttribute("data-value", "blue");
    await user.click(screen.getByTestId("select-range-dialog-done"));

    await user.click(screen.getByTestId("menu-select"));
    fireEvent.mouseEnter(screen.getByTestId("menu-select-by").parentElement!);
    await user.click(screen.getByTestId("menu-select-contrast"));
    // Contrast has no channel to pick and no histogram to draw: local
    // contrast is not a plane the thumbnail carries.
    expect(screen.queryByTestId("range-channel")).not.toBeInTheDocument();
    expect(screen.queryByTestId("range-dialog-histogram")).not.toBeInTheDocument();
    expect(screen.getByTestId("range-soft")).toBeInTheDocument();
  });
});

/// 2026-08-27: "I think a lot of this could be handled with context
/// menus for the layers and groups. And add to the contex menu the
/// ability to rename layers. Make sure all this functionality is also
/// mirrored in the Layer menu."
describe("the layer context menu", () => {
  const addTwo = async (user: ReturnType<typeof userEvent.setup>) => {
    await openFinish(user);
    await user.click(screen.getByTestId("art-add-content"));
    await user.click(screen.getByTestId("art-add-content"));
  };

  it("opens on the row it was aimed at, and renames from it", async () => {
    const user = userEvent.setup();
    await addTwo(user);
    fireEvent.contextMenu(screen.getByTestId("art-layer-art_b1"));
    expect(screen.getByTestId("art-layer-menu")).toBeInTheDocument();

    await user.click(screen.getByTestId("art-menu-rename"));
    // The name becomes an input, in place: a dialog for one field is a
    // lot of ceremony for typing six letters.
    const box = screen.getByTestId("art-rename-art_b1");
    await user.clear(box);
    await user.type(box, "Sky patch{Enter}");
    expect(screen.getByTestId("art-name-art_b1")).toHaveTextContent("Sky patch");
  });

  it("puts a layer into a group, and lets a member back out", async () => {
    const user = userEvent.setup();
    await addTwo(user);
    await user.click(screen.getByTestId("art-add-content"));
    // Group the first two, leaving the third outside.
    fireEvent.mouseDown(screen.getByTestId("art-layer-art_b1"));
    fireEvent.mouseDown(screen.getByTestId("art-layer-art_b2"), { ctrlKey: true });
    await user.click(screen.getByTestId("art-group"));
    // The group is the row with a disclosure on it, not simply the top
    // one: art_b3 was added last and sits above the group.
    const groupId = screen
      .getAllByTestId(/^art-open-/)[0]
      .getAttribute("data-testid")!
      .replace("art-open-", "");

    // The third joins from its own menu, and the group opens so the layer
    // is where you can see it went. The owner asked for the groups to be a
    // fold-out rather than a run of items: "It keeps the context menu from
    // scaling out of control if there many groups added."
    fireEvent.contextMenu(screen.getByTestId("art-layer-art_b3"));
    // Fold-outs open on hover, and the suite drives them the way it
    // drives every other one: enter the host, then click the item.
    fireEvent.mouseEnter(screen.getByTestId("art-menu-add-to-group").parentElement!);
    fireEvent.click(screen.getByTestId(`art-menu-add-to-${groupId}`));
    expect(screen.queryByTestId("art-layer-art_b3")).toBeNull();
    const members = screen.getAllByTestId(/^art-member-/);
    expect(members.length).toBe(3);

    // And back out again from the member's own menu.
    const memberId = members[0].getAttribute("data-testid")!.replace("art-member-", "");
    fireEvent.contextMenu(members[0]);
    await user.click(screen.getByTestId("art-menu-remove-from-group"));
    expect(screen.getAllByTestId(/^art-member-/).length).toBe(2);
    expect(screen.queryByTestId(`art-member-${memberId}`)).toBeNull();
  });

  it("offers a member the moves that make sense inside a group", async () => {
    const user = userEvent.setup();
    await addTwo(user);
    fireEvent.mouseDown(screen.getByTestId("art-layer-art_b1"));
    fireEvent.mouseDown(screen.getByTestId("art-layer-art_b2"), { ctrlKey: true });
    await user.click(screen.getByTestId("art-group"));
    const groupId = screen
      .getAllByTestId(/^art-layer-/)[0]
      .getAttribute("data-testid")!
      .replace("art-layer-", "");
    await user.click(screen.getByTestId(`art-open-${groupId}`));
    const members = screen.getAllByTestId(/^art-member-/);

    fireEvent.contextMenu(members[0]);
    // Top of the group: up is spent, down is not.
    expect(screen.getByTestId("art-menu-up")).toBeDisabled();
    expect(screen.getByTestId("art-menu-down")).not.toBeDisabled();
    // A member composites inside its group, where there is no layer below
    // in the stack's sense, so clipping is grayed. It used to be absent;
    // "Hiding unavailable menu items... it's not clear what are
    // all the possible tools that could be available."
    expect(screen.getByTestId("art-menu-clip")).toBeDisabled();
    // A mask is, which is the whole point of the carrier change.
    expect(screen.getByTestId("art-menu-mask-add")).not.toBeDisabled();
    expect(screen.getByTestId("art-menu-mask-smart")).not.toBeDisabled();
  });

  /// The same list, one door up: the panel acts on the layer you
  /// pointed at, the menu bar acts on the active one.
  it("mirrors itself in the Layer menu", async () => {
    const user = userEvent.setup();
    await addTwo(user);
    await user.click(screen.getByTestId("menu-layer"));
    for (const id of [
      "menu-layer-up",
      "menu-layer-down",
      "menu-layer-mask-add",
      "menu-layer-mask-smart",
      "menu-layer-delete",
    ]) {
      expect(screen.getByTestId(id), id).toBeInTheDocument();
    }
    // Rename stays in the panel: there is no row up here to edit.
    expect(screen.queryByTestId("menu-layer-rename")).toBeNull();
  });
});

/// 2026-08-27: "In the Layer menu, I think the layers at the bottom
/// that are specific to Adjustments should be moved into a sub menu for
/// 'New Adjustment Layer... >'."
describe("the Layer menu's shape", () => {
  it("folds the Develop mask layers into their own submenu", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByTestId("menu-layer"));
    // Not sitting at the foot of the menu any more.
    expect(screen.queryByTestId("menu-layer-range")).toBeNull();
    const fold = screen.getByTestId("menu-layer-new-adjustment");
    fireEvent.mouseEnter(fold.parentElement!);
    // EVERY mask type, read from the same list the app builds them
    // from. Spelling the five out here is what let Smart go missing:
    // the menu and the test were two copies of one list, and they
    // agreed with each other while both disagreed with the app.
    // Object shows only for a photograph whose file names objects (its
    // seat is pinned in mattetool.test.tsx); a plain photograph offers
    // every other kind.
    for (const t of LAYER_MASK_TYPES.filter((k) => k !== "object")) {
      expect(screen.getByTestId(`menu-layer-${t}`), t).toBeInTheDocument();
    }
    expect(screen.queryByTestId("menu-layer-object")).toBeNull();
    expect(screen.getByTestId("menu-layer-smart")).toBeInTheDocument();
  });

  /// 2026-08-28: "Layer menu is missing a sub menu for New Finish
  /// Layers... Pixel Layer, Smart Layer, Adjustments Layer, Gradient
  /// Layer, Fill Layer."
  it("offers every Finish layer type, before any layer exists", async () => {
    const user = userEvent.setup();
    // Deliberately NOT opening Finish or adding a layer first: these
    // are how the first layer gets made, so they have to be reachable
    // from a document with an empty stack.
    render(<App />);
    await user.click(screen.getByTestId("menu-layer"));
    const fold = screen.getByTestId("menu-layer-new-finish");
    fireEvent.mouseEnter(fold.parentElement!);
    for (const id of [
      "menu-finish-paint",
      "menu-finish-gradient",
      "menu-finish-fill",
    ]) {
      expect(screen.getByTestId(id), id).toBeInTheDocument();
    }
    // Adjustments fold again, and carry every kind ART_KINDS marks as
    // one rather than a list written out here.
    const adj = screen.getByTestId("menu-finish-adjust");
    fireEvent.mouseEnter(adj.parentElement!);
    for (const k of ART_ADJUSTMENTS) {
      expect(screen.getByTestId(`menu-finish-adjust-${k}`), k).toBeInTheDocument();
    }
  });

  it("makes a pixel layer from the menu", async () => {
    const user = userEvent.setup();
    await openFinish(user);
    // The stack is empty; the menu is the only door used here.
    expect(screen.queryByTestId("art-layer-art_b1")).toBeNull();
    await user.click(screen.getByTestId("menu-layer"));
    fireEvent.mouseEnter(screen.getByTestId("menu-layer-new-finish").parentElement!);
    await user.click(screen.getByTestId("menu-finish-paint"));
    expect(screen.getByTestId("art-layer-art_b1")).toBeInTheDocument();
  });

  /// 2026-08-28: "the Delete Layer function is there but not the Group
  /// Layers function", then "technically I should be able to group
  /// just one layer." Present beside Delete, and live for one.
  it("groups a single layer from the menu, and counts up for more", async () => {
    const user = userEvent.setup();
    await openFinish(user);
    await user.click(screen.getByTestId("art-add-content"));
    await user.click(screen.getByTestId("menu-layer"));
    const one = screen.getByTestId("menu-layer-group");
    expect(screen.getByTestId("menu-layer-delete")).toBeInTheDocument();
    expect(one).not.toBeDisabled();
    expect(one).toHaveTextContent("Group Layer");
    await user.click(one);
    // A group of one is a group: the row is a group, and the layer is
    // inside it rather than beside it.
    const group = screen.getByTestId("art-layer-art_b2");
    expect(group).toBeInTheDocument();
    expect(screen.queryByTestId("art-layer-art_b1")).toBeNull();
    await user.click(screen.getByTestId("art-open-art_b2"));
    expect(screen.getByTestId("art-member-art_g2_m1")).toBeInTheDocument();

    // Two selected and contiguous: the same seat, counting.
    await user.click(screen.getByTestId("art-add-content"));
    await user.click(screen.getByTestId("art-add-content"));
    fireEvent.mouseDown(screen.getByTestId("art-layer-art_b3"));
    fireEvent.mouseDown(screen.getByTestId("art-layer-art_b4"), { ctrlKey: true });
    await user.click(screen.getByTestId("menu-layer"));
    const two = screen.getByTestId("menu-layer-group");
    expect(two).not.toBeDisabled();
    expect(two).toHaveTextContent("Group 2 Layers");
  });

  it("keeps the groups fold-out out of the way until it is wanted", async () => {
    const user = userEvent.setup();
    await openFinish(user);
    await user.click(screen.getByTestId("art-add-content"));
    await user.click(screen.getByTestId("art-add-content"));
    fireEvent.mouseDown(screen.getByTestId("art-layer-art_b1"));
    fireEvent.mouseDown(screen.getByTestId("art-layer-art_b2"), { ctrlKey: true });
    await user.click(screen.getByTestId("art-group"));
    await user.click(screen.getByTestId("art-add-content"));

    await user.click(screen.getByTestId("menu-layer"));
    const fold = screen.getByTestId("menu-layer-add-to-group");
    // One entry in the menu however many groups there are, which is the
    // whole reason it is a fold-out.
    expect(screen.queryByTestId(/^menu-layer-add-to-art_b/)).toBeNull();
    fireEvent.mouseEnter(fold.parentElement!);
    expect(screen.getAllByTestId(/^menu-layer-add-to-art_b/).length).toBe(1);
  });
});
