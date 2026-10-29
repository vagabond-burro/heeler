// Every model's consent card stands in the middle of the window
// (2026-10-29: "make sure all consent prompts are centered in the
// screen"), put on the page itself so no canvas transform, panel scroll
// or dialog can carry it off center.

import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ModelConsentCard } from "../ui/modelconsent";

const model = { id: "lama", label: "LaMa (inpainting)", bytes: 208_044_816, installed: false, license: "Apache-2.0", url: "https://example.test/lama", version: "1" };

describe("the model consent card", () => {
  it("stands in the middle of the window, on the page itself, over Preferences", () => {
    const outer = vi.fn();
    render(
      <div data-testid="host" style={{ transform: "rotate(30deg)" }} onMouseDown={outer}>
        <ModelConsentCard title="REMOVE NEEDS ITS MODEL" model={model} testid="fill" downloading={false} onDownload={() => {}} />
      </div>,
    );
    const card = screen.getByTestId("fill-consent");
    expect(card.parentElement).toBe(document.body);
    expect(screen.getByTestId("host").contains(card)).toBe(false);
    expect(card.style.position).toBe("fixed");
    expect(card.style.left).toBe("50%");
    expect(card.style.top).toBe("50%");
    expect(card.style.transform).toBe("translate(-50%, -50%)");
    // Above the Preferences dialog's 80.
    expect(Number(card.style.zIndex)).toBeGreaterThan(80);
    // A press on it still does not reach the tool that asked.
    fireEvent.mouseDown(card);
    expect(outer).not.toHaveBeenCalled();
  });

  it("is placed by the card alone: no caller passes a place of its own", () => {
    const dir = resolve(process.cwd(), "src/ui");
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".tsx"))) {
      const text = readFileSync(resolve(dir, file), "utf8");
      if (!text.includes("<ModelConsentCard")) continue;
      const cards = text.split("<ModelConsentCard").slice(1).map((t) => t.slice(0, t.indexOf("/>")));
      for (const card of cards) expect(card, file).not.toMatch(/\bplace=/);
    }
  });
});
