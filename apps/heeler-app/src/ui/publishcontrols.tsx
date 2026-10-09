// Publishing a member's control to its group, and editing what a group
// publishes.
//
// 2026-10-01: "like with frequency separation, how can user create
// attributes on the group node to control the whole network? this will
// be important for custom recipes."
//
// 3D packages call it promoting a parameter, or call them group
// inputs. Here: inside an open group, right-click any control row in
// the Inspector and publish it under a name. The same name again joins
// that control, so one slider drives several nodes. On the group the
// Controls editor renames, reorders, sets the span and Reset value, and
// says which members each control drives. The commands live in
// state.ts (publish_param and its family); this file is their faces.
//
// One seat: the right-click on the row is the only door in (Develop's
// rows already answer a right-click with their per-control menu, the
// link override), and a line at the top of the Inspector says so.

import React, { useState } from "react";
import { createPortal } from "react-dom";
import type { Command, NodeCard, Published } from "../state";
import { publishShape, publishedRange, publishedTargets } from "../state";
import { clampMenu, viewportSize } from "./menupos";
import { useDismiss } from "./hooks";

type D = (cmd: Command) => void;

/** What a right-click inside the Inspector landed on: the row's member,
 * its param, and the words on the row. Rows say who they are with
 * data-node and data-param (the shared Slider always has; the pickers
 * and switches do since this change). */
export function publishRowAt(target: EventTarget | null, fallbackNode: string): { node: string; param: string; label: string } | null {
  const el = target instanceof Element ? target.closest<HTMLElement>("[data-param]") : null;
  const param = el?.dataset.param;
  if (!el || !param) return null;
  const label = el.querySelector(".lbl")?.textContent?.trim() || param.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
  return { node: el.dataset.node || fallbackNode, param, label };
}

/** The status line's words for a member's row inside an open group. */
export const PUBLISH_HINT = "Publish a control to the group: right-click it, and the group offers it from outside";

const fieldStyle: React.CSSProperties = {
  background: "var(--bg-app)",
  border: "none",
  color: "var(--text-hi)",
  fontSize: 12,
  padding: "3px 6px",
  outline: "none",
  boxSizing: "border-box",
};

/** The row's right-click menu inside an open group: a name, Publish,
 * a join onto each control the group already has, and Unpublish for
 * each control this row already drives. Portaled to the body and
 * scaled through the chrome variable, like the graph's own menu, so
 * the Inspector's zoom is not applied twice. */
export function PublishMenu({
  at,
  group,
  member,
  param,
  label,
  dispatch,
  onClose,
}: {
  at: { x: number; y: number };
  group: NodeCard;
  member: NodeCard;
  param: string;
  label: string;
  dispatch: D;
  onClose: () => void;
}) {
  const [name, setName] = useState(label);
  const ref = useDismiss<HTMLDivElement>(true, onClose);
  const list = group.published ?? [];
  const drives = list.filter((p) => publishedTargets(p).some((t) => t.node === member.id && t.param === param));
  const shape = publishShape(member, param);
  // Joinable: the same kind, not already driving this row. The reducer
  // has the last word on spans and choices and says so when it refuses.
  const joinable = list.filter((p) => !drives.includes(p) && !!p.options === (shape.kind === "menu"));
  const publish = (as: string) => {
    if (as.trim()) dispatch({ type: "publish_param", id: group.id, node: member.id, param, label: as.trim() });
    onClose();
  };
  const z = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--chrome-zoom")) || 1;
  const p = clampMenu(at, { w: 240 * z, h: (120 + 30 * (joinable.length + drives.length)) * z }, viewportSize());
  const menu = (
    <div
      ref={ref}
      className="ctx-menu chrome-scale"
      role="menu"
      aria-label={`Publish ${label}`}
      data-testid="publish-menu"
      style={{ position: "fixed", left: p.x, top: p.y, zIndex: 80 }}
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="hd">{`${member.name} · ${label}`.toUpperCase()}</div>
      <div className="sep" />
      <div style={{ display: "flex", gap: 6, padding: "4px 12px 6px", alignItems: "center" }}>
        <input
          autoFocus
          data-testid="publish-name"
          aria-label="Name on the group"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") publish(name);
            if (e.key === "Escape") onClose();
          }}
          style={{ ...fieldStyle, flex: 1, minWidth: 0 }}
        />
      </div>
      <div data-hint={`The group offers ${label} under this name; a name it already has joins that control`}>
        <button data-testid="publish-go" disabled={!name.trim()} onClick={() => publish(name)}>
          Publish to {group.name}
        </button>
      </div>
      {joinable.length > 0 && <div className="sep" />}
      {joinable.map((c) => (
        <div key={c.label} data-hint={`One ${c.label} drives ${label} too`}>
          <button data-testid={`publish-join-${slug(c.label)}`} onClick={() => publish(c.label)}>
            Join {c.label}
          </button>
        </div>
      ))}
      {drives.length > 0 && <div className="sep" />}
      {drives.map((c) => (
        <div key={c.label} data-hint={`${c.label} stops driving ${label}; its value stays as it is`}>
          <button
            data-testid={`publish-remove-${slug(c.label)}`}
            onClick={() => {
              dispatch({ type: "unpublish_param", id: group.id, label: c.label, node: member.id, param });
              onClose();
            }}
          >
            Unpublish from {c.label}
          </button>
        </div>
      ))}
    </div>
  );
  return typeof document !== "undefined" && document.body ? createPortal(menu, document.body) : menu;
}

export const slug = (label: string) => label.toLowerCase().replace(/[^a-z0-9]+/g, "-");

/** A number typed into a field, committed on Enter or on leaving it. */
function NumberField({ value, label, testid, onCommit }: { value: number | undefined; label: string; testid: string; onCommit: (v: number | null) => void }) {
  const shown = value === undefined ? "" : String(Math.round(value * 1000) / 1000);
  return (
    <input
      key={shown}
      data-testid={testid}
      aria-label={label}
      inputMode="decimal"
      placeholder="none"
      defaultValue={shown}
      onBlur={(e) => {
        const raw = e.target.value.trim();
        if (raw === shown) return;
        if (raw === "") return onCommit(null);
        const v = Number(raw);
        if (Number.isFinite(v)) onCommit(v);
        else e.target.value = shown;
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
      style={{ ...fieldStyle, width: "100%", minWidth: 0 }}
    />
  );
}

/** The group's Controls editor: every published control by name, in
 * order, with its span and Reset value for a number, and the members it
 * drives. Behind a disclosure, so a group that is only being used shows
 * its controls and nothing about how they were made. */
export function ControlsEditor({ group, dispatch }: { group: NodeCard; dispatch: D }) {
  const [open, setOpen] = useState(false);
  const list = group.published ?? [];
  const memberName = (id: string) => group.groupNodes?.find((n) => n.id === id)?.name ?? id;
  return (
    <div data-testid="controls-editor" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <button
        className="chip"
        data-testid="controls-editor-toggle"
        data-active={open || undefined}
        aria-expanded={open}
        data-hint={open ? "Put the controls editor away" : "Rename, reorder and set the spans of the controls this group offers"}
        onClick={() => setOpen(!open)}
        style={{ alignSelf: "flex-start", fontSize: 11 }}
      >
        Edit controls
      </button>
      {open && list.length === 0 && (
        <div style={{ fontSize: 12, color: "var(--text-faint)", lineHeight: 1.5 }}>
          Nothing published yet. Open the group, right-click a control on any node inside, and publish it.
        </div>
      )}
      {open &&
        list.map((c: Published, i) => {
          const s = slug(c.label);
          const [lo, hi] = publishedRange(group, c);
          return (
            <div key={c.label} data-testid={`control-${s}`} style={{ display: "flex", flexDirection: "column", gap: 4, padding: "6px 0", background: "var(--bg-row)" }}>
              <div style={{ display: "flex", gap: 4, alignItems: "center", padding: "0 6px" }}>
                <input
                  key={c.label}
                  data-testid={`control-name-${s}`}
                  aria-label={`Name of ${c.label}`}
                  defaultValue={c.label}
                  onBlur={(e) => {
                    const to = e.target.value.trim();
                    if (to && to !== c.label) dispatch({ type: "rename_published", id: group.id, label: c.label, to });
                    else e.target.value = c.label;
                  }}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                  }}
                  style={{ ...fieldStyle, flex: 1, minWidth: 0 }}
                />
                <button
                  className="chip"
                  data-testid={`control-up-${s}`}
                  aria-label={`Move ${c.label} up`}
                  data-hint={`${c.label} one place higher on the group`}
                  disabled={i === 0}
                  onClick={() => dispatch({ type: "move_published", id: group.id, label: c.label, to: i - 1 })}
                  style={{ fontSize: 11, padding: "1px 6px" }}
                >
                  ↑
                </button>
                <button
                  className="chip"
                  data-testid={`control-down-${s}`}
                  aria-label={`Move ${c.label} down`}
                  data-hint={`${c.label} one place lower on the group`}
                  disabled={i === list.length - 1}
                  onClick={() => dispatch({ type: "move_published", id: group.id, label: c.label, to: i + 1 })}
                  style={{ fontSize: 11, padding: "1px 6px" }}
                >
                  ↓
                </button>
                <button
                  className="chip"
                  data-testid={`control-unpublish-${s}`}
                  data-hint={`The group stops offering ${c.label}; the nodes inside keep their values`}
                  onClick={() => dispatch({ type: "unpublish_param", id: group.id, label: c.label })}
                  style={{ fontSize: 11 }}
                >
                  Unpublish
                </button>
              </div>
              {!c.options && (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 4, padding: "0 6px" }}>
                  {(
                    [
                      ["Min", "min", lo, (v: number | null) => v !== null && dispatch({ type: "set_published_range", id: group.id, label: c.label, range: [v, hi] })],
                      ["Max", "max", hi, (v: number | null) => v !== null && dispatch({ type: "set_published_range", id: group.id, label: c.label, range: [lo, v] })],
                      ["Default", "default", c.default, (v: number | null) => dispatch({ type: "set_published_range", id: group.id, label: c.label, default: v })],
                    ] as const
                  ).map(([word, key, value, commit]) => (
                    <label key={key} style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 11, color: "var(--text-faint)" }}>
                      {word}
                      <NumberField value={value} label={`${c.label} ${word.toLowerCase()}`} testid={`control-${key}-${s}`} onCommit={commit} />
                    </label>
                  ))}
                </div>
              )}
              <div style={{ display: "flex", flexDirection: "column", gap: 2, padding: "0 6px" }}>
                {publishedTargets(c).map((t) => (
                  <div key={`${t.node}.${t.param}`} data-testid={`control-target-${s}-${t.node}-${t.param}`} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--text-body)" }}>
                    <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {c.options ? "Sets" : "Drives"} {memberName(t.node)} · {t.param.replace(/_/g, " ")}
                    </span>
                    <button
                      className="chip bare"
                      data-testid={`control-drop-${s}-${t.node}-${t.param}`}
                      aria-label={`${c.label} stops driving ${memberName(t.node)} ${t.param}`}
                      data-hint={`${c.label} stops driving ${memberName(t.node)}; its value stays`}
                      onClick={() => dispatch({ type: "unpublish_param", id: group.id, label: c.label, node: t.node, param: t.param })}
                      style={{ fontSize: 11, padding: "0 5px" }}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
    </div>
  );
}
