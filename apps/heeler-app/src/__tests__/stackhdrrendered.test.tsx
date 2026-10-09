// The Stack panel says when an HDR merge is approximate (the stacking
// review's R3; 2026-10-08: "aligned with recommendation"). HDR divides
// each frame by its exposure as if its light were linear; a JPEG still
// carries the camera's tone curve, and the review measured a camera JPEG
// two stops over at 4.9 to 7.8 times its 0 EV frame where the RAW
// measured 4. The merge is not refused: the panel says so, and says RAW is
// the accurate route.
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { StackInfo } from "../bridge";
import { initialState } from "../data";

let fakeInfo: StackInfo;
vi.mock("../bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../bridge")>();
  return {
    ...actual,
    stackInfo: vi.fn(async () => fakeInfo),
    updateStack: vi.fn(async (_id: string, c: Record<string, unknown>) => ({ ...fakeInfo, ...c })),
  };
});

import { StackPanel } from "../ui/simple";

const RAW = ["P1032358.RW2", "P1032359.RW2", "P1032360.RW2"];
const JPG = ["P1032358.JPG", "P1032359.JPG", "P1032360.JPG"];

async function mount(info: StackInfo) {
  fakeInfo = info;
  render(<StackPanel state={initialState()} dispatch={(() => {}) as never} />);
  await screen.findByTestId(`stack-member-${info.members[0]}`);
}

describe("the Stack panel's HDR warning", () => {
  it("says a merge of finished pictures is approximate and RAW is accurate", async () => {
    await mount({ mode: "hdr", align: true, members: JPG, missing: [], rendered: JPG });
    const note = screen.getByTestId("stack-hdr-rendered");
    expect(note.textContent).toContain("approximate");
    expect(note.textContent).toContain("Merge the RAW files");
    expect(note.className).toBe("help");
  });

  it("names the finished pictures in a mixed bracket", async () => {
    const members = [RAW[0], "P1032359.JPG", RAW[2]];
    await mount({ mode: "hdr", align: true, members, missing: [], rendered: ["P1032359.JPG"] });
    const note = screen.getByTestId("stack-hdr-rendered");
    expect(note.textContent).toContain("1 of 3 frames");
    expect(note.textContent).toContain("P1032359.JPG");
    expect(note.textContent).toContain("Merge only RAW files");
  });

  it("is quiet for an all-RAW bracket", async () => {
    await mount({ mode: "hdr", align: true, members: RAW, missing: [], rendered: [] });
    expect(screen.queryByTestId("stack-hdr-rendered")).toBeNull();
  });

  it("is quiet for an older backend that sends no list", async () => {
    await mount({ mode: "hdr", align: true, members: JPG, missing: [] });
    expect(screen.queryByTestId("stack-hdr-rendered")).toBeNull();
  });

  it("is quiet for the other methods, and appears when a JPEG stack switches to HDR", async () => {
    await mount({ mode: "max", align: false, members: JPG, missing: [], rendered: JPG });
    expect(screen.queryByTestId("stack-hdr-rendered")).toBeNull();
    fireEvent.click(screen.getByTestId("stack-mode-hdr"));
    expect(await screen.findByTestId("stack-hdr-rendered")).toBeTruthy();
  });
});
