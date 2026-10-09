// The Stack panel's member list grows hands: scrolls past ten
// frames, selects with the ribbon's grammar, removes from a context
// menu, appends through the picker, and can hand its selection to the
// thumbnail strip.
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StackInfo } from "../bridge";
import { initialState } from "../data";
import type { Command } from "../state";

// Twelve frames named after the sample session's own files, so
// "Select in ribbon" has real ids to find; the tail names are
// strangers to the folder on purpose.
const NAMES = [
  ...initialState().images.slice(0, 8).map((i) => i.name),
  "DSC_09001.NEF",
  "DSC_09002.NEF",
  "DSC_09003.NEF",
  "DSC_09004.NEF",
];
let fakeInfo: StackInfo;
const updates: { mode?: string; align?: boolean; members?: string[] }[] = [];
const addCalls: string[] = [];

vi.mock("../bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../bridge")>();
  return {
    ...actual,
    stackInfo: vi.fn(async () => fakeInfo),
    updateStack: vi.fn(async (_id: string, c: Record<string, unknown>) => {
      updates.push(c);
      return { ...fakeInfo, ...c };
    }),
    stackAddFrames: vi.fn(async (id: string) => {
      addCalls.push(id);
      return null; // a canceled dialog
    }),
  };
});

import { StackPanel } from "../ui/simple";

async function mount(members = NAMES) {
  fakeInfo = { mode: "max", align: false, members, missing: [] };
  const sent: Command[] = [];
  render(
    <StackPanel state={initialState()} dispatch={((c: Command) => sent.push(c)) as never} />,
  );
  // The panel fetches its info on mount; the list appears when it lands.
  await screen.findByTestId(`stack-member-${members[0]}`);
  return sent;
}

describe("the Stack panel's member list", () => {
  beforeEach(() => {
    updates.length = 0;
    addCalls.length = 0;
  });

  it("scrolls past ten frames instead of growing forever", async () => {
    await mount();
    const list = screen.getByTestId("stack-members");
    expect(list.style.maxHeight).toBe("170px");
    expect(list.style.overflowY).toBe("auto");
    expect(list.children.length).toBe(12);
    // flex none on every row, or the column SHRINKS them to fit the cap
    // instead of overflowing into the scrollbar: past thirteen frames
    // each row squeezed to a few pixels and the names clipped to dotted
    // slivers (the owner's screenshot).
    for (const row of Array.from(list.children)) {
      // jsdom expands flex:none to its longhand; the 0 in the middle
      // (flex-shrink) is the part that matters.
      expect((row as HTMLElement).style.flexShrink).toBe("0");
    }
  });

  it("selects with the ribbon's grammar and removes from the context menu", async () => {
    await mount();
    fireEvent.click(screen.getByTestId(`stack-member-${NAMES[1]}`));
    fireEvent.click(screen.getByTestId(`stack-member-${NAMES[4]}`), { shiftKey: true });
    for (const n of NAMES.slice(1, 5)) {
      expect(screen.getByTestId(`stack-member-${n}`).getAttribute("data-selected")).toBe("true");
    }
    // The menu opens on the selection and removal rewrites the recipe
    // without the chosen four.
    fireEvent.contextMenu(screen.getByTestId(`stack-member-${NAMES[2]}`));
    fireEvent.click(screen.getByTestId("stack-remove-frames"));
    expect(updates).toEqual([
      { members: [NAMES[0], ...NAMES.slice(5)] },
    ]);
  });

  it("right-clicking outside the selection moves it there first", async () => {
    await mount();
    fireEvent.click(screen.getByTestId(`stack-member-${NAMES[0]}`));
    fireEvent.contextMenu(screen.getByTestId(`stack-member-${NAMES[7]}`));
    // The menu portals OUT of the panel: inside it, the panel's
    // ui-zoom scales the fixed coordinates and paints the menu 1.15x
    // to the right of the pointer.
    expect(screen.getByTestId("stack-member-menu").closest('[data-testid="stack-panel"]')).toBeNull();
    expect(screen.getByTestId("stack-member-menu").parentElement).toBe(document.body);
    expect(screen.getByTestId(`stack-member-${NAMES[7]}`).getAttribute("data-selected")).toBe("true");
    expect(screen.getByTestId(`stack-member-${NAMES[0]}`).getAttribute("data-selected")).toBe("false");
    expect(screen.getByTestId("stack-remove-frames")).toHaveTextContent("Remove frame");
  });

  it("will not remove down past two frames", async () => {
    await mount(NAMES.slice(0, 3));
    fireEvent.click(screen.getByTestId(`stack-member-${NAMES[0]}`));
    fireEvent.click(screen.getByTestId(`stack-member-${NAMES[2]}`), { shiftKey: true });
    fireEvent.contextMenu(screen.getByTestId(`stack-member-${NAMES[1]}`));
    expect(screen.getByTestId("stack-remove-frames")).toBeDisabled();
  });

  it("hands the selection to the ribbon by id, skipping names the folder lacks", async () => {
    const sent = await mount();
    // Frames 6..11: two real folder names, then the strangers.
    fireEvent.click(screen.getByTestId(`stack-member-${NAMES[6]}`));
    fireEvent.click(screen.getByTestId(`stack-member-${NAMES[9]}`), { shiftKey: true });
    fireEvent.contextMenu(screen.getByTestId(`stack-member-${NAMES[7]}`));
    fireEvent.click(screen.getByTestId("stack-select-in-ribbon"));
    const ids = initialState().images.slice(6, 8).map((i) => i.id);
    expect(sent).toContainEqual({ type: "select_images", ids });
  });

  it("the ADD button asks the picker, and a canceled dialog changes nothing", async () => {
    const sent = await mount();
    fireEvent.click(screen.getByTestId("stack-add-frames"));
    // The mock answers null (cancel); no re-render nudge follows.
    await vi.waitFor(() => expect(addCalls.length).toBe(1));
    expect(sent.find((c) => c.type === "bump_preview")).toBeUndefined();
  });
});
