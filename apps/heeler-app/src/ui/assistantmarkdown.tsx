// The assistant's answers as they were written to be read: **bold**,
// *italic*, `code`, headings, and simple lists, rendered as React
// elements. Nothing is parsed as HTML and nothing is injected: a model's
// "<b>" stays the four characters it is. No dependency: the handful of
// marks a chat answer uses, and anything else left as text.

import React from "react";

/** Inline marks: `code` first (nothing inside it is a mark), then
 * **bold** or __bold__, then *italic* or _italic_. A lone asterisk or
 * an underscore inside a word (snake_case) stays as written. */
// No lookbehind: an older WebKit refuses the whole module over one. The
// character before an italic mark is captured instead and put back.
const INLINE =
  /(`[^`\n]+`)|\*\*([^*\n]+?)\*\*|__([^_\n]+?)__|(^|[^*\w])\*([^\s*](?:[^*\n]*[^\s*])?)\*(?![*\w])|(^|[^_\w])_([^\s_](?:[^_\n]*[^\s_])?)_(?![_\w])/g;

export function renderInline(text: string, key = "i"): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let last = 0;
  let n = 0;
  for (const m of text.matchAll(INLINE)) {
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const k = `${key}-${n++}`;
    if (m[1] !== undefined) {
      out.push(
        <code key={k} style={{ fontFamily: "var(--font-mono, ui-monospace, monospace)", fontSize: 12, background: "var(--bg-row)", padding: "0 3px" }}>
          {m[1].slice(1, -1)}
        </code>,
      );
    } else if (m[2] !== undefined || m[3] !== undefined) {
      out.push(<strong key={k}>{renderInline(m[2] ?? m[3], k)}</strong>);
    } else {
      const before = m[4] ?? m[6] ?? "";
      if (before) out.push(before);
      out.push(<em key={k}>{renderInline(m[5] ?? m[7], k)}</em>);
    }
    last = at + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

type Block =
  | { kind: "p"; lines: string[] }
  | { kind: "h"; text: string }
  | { kind: "ul" | "ol"; items: string[]; start: number };

/** Blocks: paragraphs split at blank lines, "#" headings, and lists
 * whose items start "- ", "* ", "+ " or "1. " / "1) ". A line that
 * continues an item (indented) joins it. */
export function blocks(text: string): Block[] {
  const out: Block[] = [];
  let cur: Block | null = null;
  const end = () => { if (cur) out.push(cur); cur = null; };
  for (const raw of text.replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) { end(); continue; }
    const h = /^\s{0,3}#{1,6}\s+(.*)$/.exec(line);
    const ul = /^\s{0,6}[-*+]\s+(.*)$/.exec(line);
    const ol = /^\s{0,6}(\d{1,3})[.)]\s+(.*)$/.exec(line);
    if (h) { end(); out.push({ kind: "h", text: h[1].replace(/\s*#+$/, "") }); continue; }
    if (ul) {
      if (!cur || cur.kind !== "ul") { end(); cur = { kind: "ul", items: [], start: 1 }; }
      cur.items.push(ul[1]);
      continue;
    }
    if (ol) {
      if (!cur || cur.kind !== "ol") { end(); cur = { kind: "ol", items: [], start: Number(ol[1]) }; }
      cur.items.push(ol[2]);
      continue;
    }
    if (cur && (cur.kind === "ul" || cur.kind === "ol") && /^\s+/.test(raw)) {
      cur.items[cur.items.length - 1] += ` ${line.trim()}`;
      continue;
    }
    if (!cur || cur.kind !== "p") { end(); cur = { kind: "p", lines: [] }; }
    cur.lines.push(line);
  }
  end();
  return out;
}

/** An answer, rendered. */
export function AssistantMarkdown({ text }: { text: string }) {
  return (
    <>
      {blocks(text).map((b, i) => {
        const k = `b${i}`;
        const gap = i === 0 ? 0 : 6;
        if (b.kind === "h") return <div key={k} style={{ fontWeight: 600, marginTop: gap }}>{renderInline(b.text, k)}</div>;
        if (b.kind === "p") {
          return (
            <p key={k} style={{ margin: `${gap}px 0 0` }}>
              {b.lines.map((l, j) => (
                <React.Fragment key={j}>
                  {j > 0 && <br />}
                  {renderInline(l, `${k}-${j}`)}
                </React.Fragment>
              ))}
            </p>
          );
        }
        const items = b.items.map((it, j) => <li key={j} style={{ margin: "2px 0" }}>{renderInline(it, `${k}-${j}`)}</li>);
        const style: React.CSSProperties = { margin: `${gap}px 0 0`, paddingLeft: 20 };
        return b.kind === "ol" ? <ol key={k} start={b.start} style={style}>{items}</ol> : <ul key={k} style={style}>{items}</ul>;
      })}
    </>
  );
}
