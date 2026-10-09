import { useDialogFocus } from "./dialogfocus";
// Help > User Documentation: the shipped guide, rendered in-app.
//
// "Let's have a viewer that essentially just renders
// Markdown so it is updated from the .md files in the applications
// install path." So the docs ARE the install's markdown, read live:
// update a file, reopen the dialog, see the new text. No copy of the
// content lives here.
//
// The guide became a tree, and the dialog was built for a flat list of
// numbered files. "redesign the UI for the documentation to
// match what is used for the Preferences (including the Search field).
// You will need to make the left column support tree structure, it
// should also be scrollable in case the tree extends past the bottom."
// So the shell, the sizing, the search field and the sidebar buttons
// are Preferences' own, and the sidebar nests.
//
// The renderer is deliberately small: headings, lists, tables, quotes,
// code, emphasis, links, images. A markdown library would render more
// markdown than these docs use, and every renderer feature is a way for
// a doc to look broken.

import React, { useEffect, useMemo, useRef, useState } from "react";
import type { Command, State } from "../state";
import { listDocs, readDoc, readDocAsset, type DocEntry } from "../bridge";
import { buildDocTree, flattenDocs, resolveDocPath, type DocNode } from "../docstree";
import { RIBBON_ICON_CHIP } from "./ribbontable";

type D = React.Dispatch<Command>;

/** Inline markdown: code, bold, italics, and links, in that order of
 * binding. Links to other .md files switch the viewer to that doc,
 * which is how the guide cross-references; external URLs render as
 * plain text since the viewer is not a browser.
 *
 * `from` is the page the text came out of, because every link in the
 * guide is relative to it: "source.md" inside adjustments/README.md is
 * adjustments/source.md, and "../export.md" is export.md. Resolving
 * against the root instead was the difference between a sidebar that
 * navigates and one that dead-ends.
 */
/** One image out of the guide, loaded through the same jail the docs
 * come through and shown where the markdown asks. Falls back to the alt
 * text (styled as before) when the bytes cannot arrive, which is what
 * the browser build and a missing file both get: the caption is what
 * the alt text is FOR. Loaded bytes are cached per path for the life of
 * the module, so scrolling a page does not re-cross the IPC boundary
 * per repaint. */
const assetCache = new Map<string, string | null>();
function DocImage({ file, alt }: { file: string; alt: string }) {
  const [src, setSrc] = useState<string | null | undefined>(assetCache.get(file));
  useEffect(() => {
    if (assetCache.has(file)) {
      setSrc(assetCache.get(file));
      return;
    }
    let live = true;
    void readDocAsset(file).then((b64) => {
      const url = b64
        ? `data:image/${file.toLowerCase().endsWith(".svg") ? "svg+xml" : "png"};base64,${b64}`
        : null;
      assetCache.set(file, url);
      if (live) setSrc(url);
    });
    return () => {
      live = false;
    };
  }, [file]);
  if (!src) {
    return alt ? (
      <span data-testid="doc-image-fallback" style={{ color: "var(--text-dim)" }}>
        {alt}
      </span>
    ) : null;
  }
  // Two kinds of picture, told apart by what the guide actually uses
  // each format for: the SVGs are the little tab and layer glyphs that
  // ride inline beside their labels, and the rasters are screenshots,
  // which stand alone as figures.
  const icon = file.toLowerCase().endsWith(".svg");
  return (
    <img
      data-testid="doc-image"
      src={src}
      alt={alt}
      style={
        icon
          ? { height: 14, verticalAlign: "-2px", display: "inline-block" }
          : {
              display: "block",
              maxWidth: "100%",
              margin: "8px 0 10px",
              border: "1px solid var(--line-2)",
              borderRadius: "var(--radius-btn)",
            }
      }
    />
  );
}

function inline(text: string, from: string, openDoc: (file: string, anchor?: string) => void): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  // Tokenize by code spans first so nothing inside backticks is styled.
  const parts = text.split(/(`[^`]+`)/g);
  parts.forEach((part, i) => {
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      out.push(
        <code key={i} style={{ background: "var(--bg-app)", padding: "0 4px", fontSize: "0.92em" }}>
          {part.slice(1, -1)}
        </code>,
      );
      return;
    }
    // Images first: the guide illustrates its tab and layer lists with
    // small SVGs, and an unhandled "![Pixel](../assets/...)" renders as
    // that whole string in the middle of a sentence. The viewer has no
    // way to load them, so the alt text stands in, which is what the
    // alt text is for.
    const linked = part.split(/(!?\[[^\]]*\]\([^)]+\))/g).map((seg, j) => {
      const img = /^!\[([^\]]*)\]\(([^)]+)\)$/.exec(seg);
      if (img) {
        return <DocImage key={`${i}-${j}`} file={resolveDocPath(from, img[2])} alt={img[1]} />;
      }
      const m = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(seg);
      if (m) {
        const [, label, href] = m;
        // A link may name a heading on its page, "exposure.md#zones", or on
        // this one, "#zones". The page part decides whether it is a doc link;
        // the anchor rides along to the opener, which scrolls to the heading.
        // (2026-09-15) found "Exposure (exposure.md#zones)" printed as text:
        // the anchor had put the href past the ".md" test.
        const hash = href.indexOf("#");
        const path = hash >= 0 ? href.slice(0, hash) : href;
        const anchor = hash >= 0 ? href.slice(hash + 1) : undefined;
        const external = /^[a-z]+:\/\//i.test(href);
        if (!external && ((path === "" && anchor) || path.endsWith(".md"))) {
          const target = path === "" ? from : resolveDocPath(from, path);
          return (
            <a
              key={`${i}-${j}`}
              href="#"
              data-doc-link={target}
              data-doc-anchor={anchor}
              onClick={(e) => {
                e.preventDefault();
                openDoc(target, anchor);
              }}
              style={{ color: "var(--accent)" }}
            >
              {label}
            </a>
          );
        }
        return (
          <span key={`${i}-${j}`}>
            {label}
            <span style={{ color: "var(--text-ghost)" }}> ({href})</span>
          </span>
        );
      }
      const bolded = seg.split(/(\*\*[^*]+\*\*)/g).map((b, k) => {
        const bm = /^\*\*([^*]+)\*\*$/.exec(b);
        if (bm) return <strong key={k}>{bm[1]}</strong>;
        const it = b.split(/(\*[^*]+\*)/g).map((t, l) => {
          const im = /^\*([^*]+)\*$/.exec(t);
          return im ? <em key={l}>{im[1]}</em> : t;
        });
        return <React.Fragment key={k}>{it}</React.Fragment>;
      });
      return <React.Fragment key={`${i}-${j}`}>{bolded}</React.Fragment>;
    });
    out.push(<React.Fragment key={i}>{linked}</React.Fragment>);
  });
  return out;
}

/** Block-level rendering: the shapes these docs actually use.
 *
 * Counted, rather than guessed: the guide carries 50 blockquotes (the
 * screenshot placeholders), 33 images, 3 tables, no headings past h3,
 * no horizontal rules and no nested lists. Everything below is one of
 * those; anything else would be a feature with nothing to render. */
/** A heading's anchor, the way the guide's own links spell it: lower
 * case, words joined by hyphens, markdown and punctuation dropped, so
 * "## Zones" answers to "#zones" and "## The order of work" to
 * "#the-order-of-work". */
export function docSlug(heading: string): string {
  return heading
    .replace(/[`*_]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function Markdown({ text, from = "README.md", openDoc }: { text: string; from?: string; openDoc: (f: string, anchor?: string) => void }) {
  const blocks: React.ReactNode[] = [];
  const lines = text.split(/\r?\n/);
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith("```")) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) buf.push(lines[i++]);
      i++;
      blocks.push(
        <pre
          key={key++}
          style={{
            background: "var(--bg-app)",
            border: "1px solid var(--line-2)",
            padding: "8px 11px",
            fontSize: 10.5,
            overflowX: "auto",
            margin: "6px 0",
          }}
        >
          {buf.join("\n")}
        </pre>,
      );
      continue;
    }
    // A screenshot placeholder, or any other aside the guide sets off
    // with ">". Fifty of them, and unhandled they ran into the
    // paragraph above as literal angle brackets.
    if (/^>\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ""));
      blocks.push(
        <div
          key={key++}
          data-testid="doc-note"
          style={{
            margin: "8px 0 10px",
            padding: "8px 12px",
            borderLeft: "2px solid var(--accent-dim)",
            background: "var(--bg-app)",
            color: "var(--text-dim)",
            lineHeight: 1.55,
          }}
        >
          {inline(buf.join(" ").trim(), from, openDoc)}
        </div>,
      );
      continue;
    }
    // A table: header row, the dashes under it, then the body.
    if (line.trim().startsWith("|") && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] ?? "")) {
      const cells = (row: string) =>
        row.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const head = cells(line);
      i += 2;
      const body: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) body.push(cells(lines[i++]));
      blocks.push(
        <div key={key++} style={{ overflowX: "auto", margin: "6px 0 10px" }}>
          <table style={{ borderCollapse: "collapse", width: "100%" }}>
            <thead>
              <tr>
                {head.map((c, j) => (
                  <th
                    key={j}
                    style={{
                      textAlign: "left", padding: "5px 9px", fontWeight: 600,
                      color: "var(--text-hi)", borderBottom: "1px solid var(--line-4)",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {inline(c, from, openDoc)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {body.map((row, r) => (
                <tr key={r}>
                  {row.map((c, j) => (
                    <td key={j} style={{ padding: "5px 9px", borderBottom: "1px solid var(--line-1)", verticalAlign: "top" }}>
                      {inline(c, from, openDoc)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    const h = /^(#{1,3}) (.*)$/.exec(line);
    if (h) {
      const level = h[1].length;
      blocks.push(
        <div
          key={key++}
          id={`doc-${docSlug(h[2])}`}
          style={{
            fontSize: level === 1 ? 15 : level === 2 ? 13 : 11.5,
            fontWeight: 600,
            color: "var(--text-hi)",
            margin: level === 1 ? "2px 0 8px" : "14px 0 5px",
          }}
        >
          {inline(h[2], from, openDoc)}
        </div>,
      );
      i++;
      continue;
    }
    if (/^\s*([-*]|\d+\.) /.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*]|\d+\.) /.test(lines[i])) {
        // Continuation lines indent under their bullet.
        let item = lines[i].replace(/^\s*([-*]|\d+\.) /, "");
        while (i + 1 < lines.length && /^\s{2,}\S/.test(lines[i + 1]) && !/^\s*([-*]|\d+\.) /.test(lines[i + 1])) {
          item += " " + lines[++i].trim();
        }
        items.push(item);
        i++;
      }
      blocks.push(
        <ul key={key++} style={{ margin: "4px 0 8px", paddingLeft: 18 }}>
          {items.map((t, j) => (
            <li key={j} style={{ marginBottom: 3, lineHeight: 1.5 }}>
              {inline(t, from, openDoc)}
            </li>
          ))}
        </ul>,
      );
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    // A paragraph runs until a blank line or a structural line.
    const buf: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,3} |```|>|\||\s*([-*]|\d+\.) )/.test(lines[i])) {
      buf.push(lines[i++].trim());
    }
    blocks.push(
      <p key={key++} style={{ margin: "0 0 8px", lineHeight: 1.55 }}>
        {inline(buf.join(" "), from, openDoc)}
      </p>,
    );
  }
  return <>{blocks}</>;
}

/** One branch of the sidebar. Draws itself and its children, which is
 * what makes the column a tree rather than a list with indents. */
function DocBranch({
  node,
  depth,
  current,
  open,
  toggle,
  pick,
}: {
  node: DocNode;
  depth: number;
  current: string | null;
  open: Set<string>;
  toggle: (file: string) => void;
  pick: (file: string) => void;
}) {
  const active = node.file === current;
  const expandable = node.children.length > 0;
  const expanded = open.has(node.file);
  return (
    <>
      <div style={{ display: "flex", alignItems: "stretch", gap: 2 }}>
        {/* The twisty is its own target, so opening a chapter and
            reading it are two different acts. A chapter's README IS a
            page, and clicking the name should show it rather than only
            unfold it. */}
        <button
          className="chip"
          data-testid={`doc-twisty-${node.file}`}
          aria-label={expanded ? `Collapse ${node.title}` : `Expand ${node.title}`}
          aria-expanded={expandable ? expanded : undefined}
          onClick={() => expandable && toggle(node.file)}
          style={{
            flex: "none",
            width: 16,
            marginLeft: depth * 12,
            padding: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            borderColor: "transparent",
            color: "var(--text-faint)",
            cursor: expandable ? "pointer" : "default",
          }}
        >
          {expandable && (
            <svg
              width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.8"
              style={{ transform: expanded ? "none" : "rotate(-90deg)" }}
              aria-hidden
              focusable="false"
            >
              <path d="M6 9l6 6 6-6" />
            </svg>
          )}
        </button>
        <button
          className="chip"
          data-testid={`doc-${node.file}`}
          data-active={active || undefined}
          data-hint={`Opens ${node.title}`}
          onClick={() => pick(node.file)}
          style={{
            flex: 1,
            minWidth: 0,
            textAlign: "left",
            fontSize: 13,
            padding: "5px 8px",
            lineHeight: 1.3,
            color: active ? "var(--accent)" : "var(--text-hi)",
            borderColor: "transparent",
          }}
        >
          {node.title}
        </button>
      </div>
      {expandable && expanded &&
        node.children.map((child) => (
          <DocBranch
            key={child.file}
            node={child}
            depth={depth + 1}
            current={current}
            open={open}
            toggle={toggle}
            pick={pick}
          />
        ))}
    </>
  );
}

/** Where a query matched, and enough of the line around it to recognize
 * the page from. */
interface DocHit {
  file: string;
  title: string;
  excerpt: string;
}

/** Searches titles and bodies. Bodies are already in hand: the viewer
 * reads every page to build its tree, so search costs nothing extra and
 * covers the whole guide rather than only the headings. */
export function searchDocs(query: string, texts: Map<string, string>, titles: Map<string, string>): DocHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const out: DocHit[] = [];
  for (const [file, text] of texts) {
    const title = titles.get(file) ?? file;
    const line = text
      .split(/\r?\n/)
      .find((l) => l.toLowerCase().includes(q) && !l.startsWith("#"));
    const inTitle = title.toLowerCase().includes(q);
    if (!line && !inTitle) continue;
    const raw = (line ?? "").replace(/[*`>|]/g, "").trim();
    out.push({
      file,
      title,
      excerpt: raw.length > 150 ? `${raw.slice(0, 150)}…` : raw,
    });
  }
  // A title match is what you were looking for; a body match is where
  // the words happen to appear.
  return out.sort((a, b) => {
    const at = a.title.toLowerCase().includes(q) ? 0 : 1;
    const bt = b.title.toLowerCase().includes(q) ? 0 : 1;
    return at - bt || a.file.localeCompare(b.file);
  });
}

export function DocsViewer({ state, dispatch }: { state: State; dispatch: D }) {
  const focus = useDialogFocus(state.docsOpen);
  const [tree, setTree] = useState<DocNode[]>([]);
  const [texts, setTexts] = useState<Map<string, string>>(new Map());
  const [current, setCurrent] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  // Where you came from, newest last. Every navigation that LEAVES a
  // page records it, and Back walks the trail; opening the dialog
  // starts a fresh one, since "back" across a closed dialog would be
  // stepping into a room that is no longer there.
  const [trail, setTrail] = useState<string[]>([]);

  // Everything, once, on opening. The guide is sixty small files, the
  // tree is built from their links and the search reads their words, so
  // both want the same thing in hand; reading it lazily would mean a
  // sidebar that fills in as you watch and a search that only knows the
  // pages you already visited.
  useEffect(() => {
    if (!state.docsOpen) return;
    let live = true;
    void (async () => {
      const list: DocEntry[] = await listDocs();
      const bodies = new Map<string, string>();
      await Promise.all(
        list.map(async (entry) => {
          bodies.set(entry.file, (await readDoc(entry.file)) ?? "");
        }),
      );
      if (!live) return;
      const built = await buildDocTree(list, async (f) => bodies.get(f) ?? null);
      setTexts(bodies);
      setTree(built);
      // Chapters start closed ("collapsible sections should be
      // collapsed by default"): the chapter titles are the guide's shape, and a
      // page that is opened by name unfolds its own chapters, the way a search
      // hit or a cross-link does.
      const first = state.docsFile ?? built[0]?.file ?? null;
      const above = new Set<string>();
      if (first) {
        const parts = first.split("/");
        for (let i = 1; i < parts.length; i++) above.add(`${parts.slice(0, i).join("/")}/README.md`);
      }
      setOpen(above);
      // A targeted open (Help > Scripting) lands on its page; otherwise
      // the guide's own front page greets.
      setCurrent(first);
      setTrail([]);
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.docsOpen, state.docsFile]);

  const titles = useMemo(
    () => new Map(flattenDocs(tree).map((n) => [n.file, n.title])),
    [tree],
  );
  const hits = useMemo(() => searchDocs(query, texts, titles), [query, texts, titles]);

  // Opening a page from a search result or a cross-link has to unfold
  // the chapters above it, or the sidebar shows nothing selected while
  // the body shows the page. `reveal` is that much alone; `pick` is a
  // navigation and also writes the page being left onto the trail,
  // which is what Back walks. Going back reveals WITHOUT recording, or
  // the button would chase its own tail.
  const reveal = (file: string) => {
    setCurrent(file);
    setQuery("");
    setOpen((prev) => {
      const next = new Set(prev);
      const parts = file.split("/");
      for (let i = 1; i < parts.length; i++) next.add(`${parts.slice(0, i).join("/")}/README.md`);
      return next;
    });
  };
  // Where to land on the next page: a link's "#zones" is honored once
  // that page has rendered, or at once when it is this page.
  const pendingAnchor = useRef<string | null>(null);
  const scrollToAnchor = (anchor: string) => {
    document.getElementById(`doc-${anchor}`)?.scrollIntoView({ block: "start" });
  };
  useEffect(() => {
    const anchor = pendingAnchor.current;
    if (!anchor || !current || !texts.has(current)) return;
    pendingAnchor.current = null;
    requestAnimationFrame(() => scrollToAnchor(anchor));
  }, [current, texts]);
  const pick = (file: string, anchor?: string) => {
    if (current === file) {
      if (anchor) scrollToAnchor(anchor);
      return;
    }
    pendingAnchor.current = anchor ?? null;
    if (current) setTrail((prev) => [...prev, current]);
    reveal(file);
  };
  const back = () => {
    setTrail((prev) => {
      const last = prev[prev.length - 1];
      if (last) reveal(last);
      return prev.slice(0, -1);
    });
  };

  if (!state.docsOpen) return null;
  const text = current ? texts.get(current) ?? "" : "";
  return (
    <div
      data-testid="docs-viewer"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 70,
        background: "rgba(12,11,10,.62)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
      onMouseDown={() => dispatch({ type: "close_docs" })}
    >
      <div
        // Zoom belongs on the inner box, never the fixed wrapper: CSS
        // zoom repositions fixed descendants. Same note, same reason,
        // as Preferences, whose shape and sizing this borrows whole.
        ref={focus} role="dialog" aria-modal="true" aria-label="User documentation" tabIndex={-1}
        className="ui-zoom"
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          width: "min(1040px, 92vw)",
          height: "min(760px, 86vh)",
          minWidth: 720,
          minHeight: 480,
          maxWidth: "96vw",
          maxHeight: "92vh",
          resize: "both",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          background: "var(--bg-panel)",
          border: "1px solid var(--line-4)",
          boxShadow: "0 18px 44px rgba(0,0,0,.55)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "11px 14px 10px", borderBottom: "1px solid var(--line-1)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {/* Disabled rather than absent before there is anywhere to
                go, per the menu rule: the seat says the capability
                exists and the hint says how it lights. */}
            <span
              data-hint={
                trail.length
                  ? `Back to ${titles.get(trail[trail.length - 1]) ?? "the previous page"}`
                  : "Back to the page you came from. It lights once you follow a link."
              }
            >
              {/* Icons, not words, in the same box every icon chip in the
app wears.*/}
              <button
                className="chip"
                data-testid="docs-back"
                disabled={trail.length === 0}
                aria-label="Back"
                style={RIBBON_ICON_CHIP}
                onClick={back}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable="false">
                  <path d="M15 18l-6-6 6-6" />
                </svg>
              </button>
            </span>
            <div className="kicker" style={{ fontSize: 10, letterSpacing: ".16em" }}>User Documentation</div>
          </div>
          <button
            className="chip"
            data-testid="docs-close"
            aria-label="Close"
            data-hint="Closes the user guide"
            style={RIBBON_ICON_CHIP}
            onClick={() => dispatch({ type: "close_docs" })}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden focusable="false">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "238px minmax(0, 1fr)", flex: 1, minHeight: 0 }}>
          {/* The column scrolls. "it should also be scrollable in
case the tree extends past the bottom", and with the scripting
reference unfolded this tree is a good deal taller than the
dialog.*/}
          <aside style={{ borderRight: "1px solid var(--line-1)", padding: "12px 10px", minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column" }}>
            <input
              data-initial-focus
              data-testid="docs-search"
              data-hint="Finds a page by its title or by any words in it"
              aria-label="Search documentation"
              placeholder="Search documentation..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              style={{ boxSizing: "border-box", flex: "none", width: "100%", background: "var(--bg-app)", border: "1px solid var(--line-4)", color: "var(--text-body)", fontSize: 13.5, padding: "6px 8px", outline: "none", marginBottom: 11 }}
            />
            <nav aria-label="Documentation contents" data-testid="docs-tree" style={{ display: "grid", gap: 2, alignContent: "start" }}>
              {tree.map((node) => (
                <DocBranch
                  key={node.file}
                  node={node}
                  depth={0}
                  current={query.trim() ? null : current}
                  open={open}
                  toggle={(file) =>
                    setOpen((prev) => {
                      const next = new Set(prev);
                      if (next.has(file)) next.delete(file);
                      else next.add(file);
                      return next;
                    })
                  }
                  pick={pick}
                />
              ))}
            </nav>
          </aside>
          <main style={{ minWidth: 0, minHeight: 0, overflow: "hidden" }}>
            {query.trim() ? (
              <div data-testid="docs-search-results" style={{ height: "100%", overflowY: "auto", padding: "16px 20px 28px" }}>
                <div className="kicker" style={{ fontSize: 10, letterSpacing: ".14em", paddingBottom: 10 }}>Search results</div>
                {hits.length === 0 ? (
                  <div data-testid="docs-search-empty" style={{ fontSize: 14, color: "var(--text-ghost)", lineHeight: 1.6, maxWidth: 500 }}>
                    Nothing matched "{query}". Search covers every page title and every word in the guide.
                  </div>
                ) : (
                  hits.map((hit) => (
                    <button
                      key={hit.file}
                      className="chip"
                      data-testid={`docs-search-result-${hit.file}`}
                      data-hint={`Opens ${hit.title}`}
                      onClick={() => pick(hit.file)}
                      style={{ display: "block", width: "100%", textAlign: "left", padding: "8px 10px", marginBottom: 5, borderColor: "var(--line-2)" }}
                    >
                      <span style={{ display: "block", fontSize: 14, color: "var(--text-body)" }}>{hit.title}</span>
                      <span style={{ display: "block", fontSize: 13.5, color: "var(--text-ghost)", marginTop: 2, lineHeight: 1.5 }}>{hit.excerpt}</span>
                    </button>
                  ))
                )}
              </div>
            ) : (
              <div
                data-testid="doc-body"
                key={current ?? ""}
                style={{
                  height: "100%",
                  overflowY: "auto",
                  padding: "16px 22px 28px",
                  fontSize: 13.5,
                  color: "var(--text-body)",
                }}
              >
                <Markdown text={text} from={current ?? "README.md"} openDoc={pick} />
              </div>
            )}
          </main>
        </div>
      </div>
    </div>
  );
}
