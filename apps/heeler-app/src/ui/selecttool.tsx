// The selection tool in the Finish toolbar: one button that is also the
// shape picker.
//
// "the user should be able to change selection types by
// clicking and hold the selection tool, a popup menu extends vertically
// (above the toolbar) allowing the user to select the selection tool
// type. That selection type then becomes the active type in the toolbar
// until the user selects a different one. Then you can remove the option
// menu for selection type."
//
// So the button carries the current method's own glyph rather than a
// generic marquee box: the toolbar answers "what will this draw" without
// a second control sitting next to it saying so. A tap arms the tool, a
// hold opens the list, and the seven methods cost no width at all until
// they are asked for.

import React, { useRef, useState } from "react";
import type { Command, State } from "../state";
import { SELECT_METHODS } from "../state";
import { MethodIcon } from "./selecticons";
import { useDismiss } from "./hooks";
import { MENU_LIST_SURFACE } from "./menufield";

/** How long a press has to last before it means "show me the others".
 * Long enough that a normal tap never trips it, short enough that a
 * deliberate hold does not feel broken. */
const HOLD_MS = 320;

export function SelectToolButton({
  state,
  dispatch,
}: {
  state: State;
  dispatch: React.Dispatch<Command>;
}) {
  const [open, setOpen] = useState(false);
  const root = useDismiss<HTMLDivElement>(open, () => setOpen(false));
  const timer = useRef<number | null>(null);
  // Set when the hold fires, so the release that follows does not also
  // count as a tap and arm the tool behind the menu.
  const held = useRef(false);
  const method = state.selectMethod;
  const current = SELECT_METHODS.find((m) => m.id === method);

  /** Arm the tool, and nothing else.
   *
   * This used to grow a selection mask on the active layer, so picking
   * up the tool silently changed the layer. "This is not
   * expected. Yes, creating a mask from selection is a feature to have
   * but not just because I selected the tool... There are a lot of
   * reasons I may be using a selection that have nothing to do with
   * masking."
   *
   * The selection now belongs to the picture. What it goes on to do is
   * a separate decision: clip the paint (automatic, the moment you
   * paint under one), or become a layer mask (a button, when you ask).
   */
  const arm = () => dispatch({ type: "arm_document_selection" });

  const cancel = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  };

  // Always upward. "a popup menu extends vertically (above
  // the toolbar)". The other menus measure which way there is room
  // because they appear in several places; this one is nailed to a bar
  // across the bottom of the viewer, so there is nothing to measure and a
  // list that sometimes dropped downward would only ever be covering the
  // photograph.
  const openMenu = () => setOpen(true);

  return (
    <div ref={root} style={{ position: "relative", display: "inline-flex" }}>
      <button
        className="chip"
        data-testid="art-tool-select"
        data-active={state.tool === "select"}
        aria-label={`Select: ${current?.label ?? method}`}
        aria-haspopup="menu"
        aria-expanded={open}
        data-method={method}
        data-hint={`${current?.hint ?? "Select on the active layer"} · hold for other shapes`}
        style={{ padding: "3px 6px", display: "inline-flex", position: "relative" }}
        onMouseDown={(e) => {
          if (e.button !== 0) return;
          held.current = false;
          cancel();
          timer.current = window.setTimeout(() => {
            held.current = true;
            openMenu();
          }, HOLD_MS);
        }}
        onMouseUp={() => {
          cancel();
          if (held.current) return;
          // Clicking the tool you are already holding does nothing.
          //
          // It used to put the tool away and drop you back on the
          // cursor. "When the selection tool is already
          // active and I click the icon again it turns off the tool and
          // goes to layer selection tool." Nothing else in the toolbar
          // toggles off that way, and there is already a button whose
          // whole job is putting the tools down.
          if (state.tool === "select") return;
          arm();
        }}
        // A press that wanders off the button is not a click, and it is
        // not a hold either.
        onMouseLeave={cancel}
        // Hold is a mouse gesture and nothing else, so the list needs a
        // way in from the keyboard and from the other button.
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            openMenu();
          }
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          cancel();
          openMenu();
        }}
      >
        <MethodIcon id={method} />
        {/* The corner tick that says there is more here. Without it a
            hold gesture is something you have to be told about. */}
        <span
          aria-hidden="true"
          style={{
            position: "absolute",
            right: 1.5,
            bottom: 1.5,
            width: 0,
            height: 0,
            borderLeft: "3px solid transparent",
            borderBottom: "3px solid currentColor",
            opacity: 0.65,
          }}
        />
      </button>
      {open && (
        <div
          data-testid="art-select-method-menu"
          role="menu"
          onMouseDown={(e) => e.stopPropagation()}
          style={{
            position: "absolute",
            bottom: "calc(100% + 5px)",
            left: 0,
            ...MENU_LIST_SURFACE,
            maxHeight: undefined,
            minWidth: 144,
          }}
        >
          {SELECT_METHODS.map((m) => (
            <button
              key={m.id}
              role="menuitem"
              data-testid={`art-select-method-option-${m.id}`}
              data-active={m.id === method || undefined}
              data-hint={m.hint}
              onClick={() => {
                dispatch({ type: "set_select_method", method: m.id });
                setOpen(false);
                // Picking a shape means you want to draw one, so the
                // tool arms itself rather than making you click again.
                if (state.tool !== "select") arm();
              }}
              style={{
                all: "unset",
                cursor: "pointer",
                // With the toolbar's zoom this lands at about 1.25x the old
                // rows ("could be scaled up by 1.25x").
                fontSize: 11.5,
                padding: "4px 8px",
                whiteSpace: "nowrap",
                display: "flex",
                alignItems: "center",
                gap: 8,
                color: m.id === method ? "var(--accent)" : "var(--text-body)",
              }}
            >
              <MethodIcon id={m.id} size={13} />
              {m.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
