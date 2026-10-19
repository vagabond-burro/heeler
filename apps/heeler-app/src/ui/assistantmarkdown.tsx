// The assistant's answers as they were written to be read: **bold**,
// *italic*, `code`, headings, and simple lists, rendered as React
// elements. Nothing is parsed as HTML and nothing is injected: a model's
// "<b>" stays the four characters it is. No dependency: the handful of
// marks a chat answer uses, and anything else left as text.

import React from "react";
import { blocks, renderInline } from "./assistantmarkdownparts";

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
