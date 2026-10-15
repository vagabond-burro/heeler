// The folder tree keeping up with the disk.
//
// The tree listed each folder once and never again, so a folder made,
// renamed or removed outside Heeler showed only if its exact parent was
// opened by name; a folder that was gone did nothing when clicked; and a
// branch on an ejected card collapsed to a leaf.

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App } from "../app";
import { mockAddSubfolder, mockRemoveFolder } from "../bridge";
import { _clearFlashForTests, currentFlash } from "../ui/hints";

type User = ReturnType<typeof userEvent.setup>;
let undo: (() => void)[] = [];

beforeEach(() => _clearFlashForTests());
afterEach(() => {
  for (const u of undo) u();
  undo = [];
});

async function openTrip(user: User) {
  await user.click(await screen.findByTestId("folder-row-3"));
  await screen.findByTestId("tree-row-mock://trip/day1");
}

async function menuOn(user: User, path: string, item: string) {
  fireEvent.contextMenu(screen.getByTestId(`tree-row-${path}`));
  await user.click(await screen.findByTestId(`folder-menu-${item}`));
}

describe("Refresh", () => {
  it("lists the open folder again: a subfolder made outside Heeler appears", async () => {
    const user = userEvent.setup();
    render(<App />);
    await openTrip(user);
    mockAddSubfolder("mock://trip", "Day 3");
    expect(screen.queryByTestId("tree-row-mock://trip/day3")).toBeNull();
    await menuOn(user, "mock://trip", "refresh");
    expect(await screen.findByTestId("tree-row-mock://trip/day3")).toBeInTheDocument();
  });

  it("lists a folder that is not the open one", async () => {
    const user = userEvent.setup();
    render(<App />);
    await openTrip(user);
    mockAddSubfolder("mock://trip/day1", "Morning");
    await menuOn(user, "mock://trip/day1", "refresh");
    await user.click(await screen.findByTestId("tree-toggle-mock://trip/day1"));
    expect(await screen.findByTestId("tree-row-mock://trip/day1/morning")).toBeInTheDocument();
    expect(screen.getByTestId("library-label")).toHaveTextContent("Trip");
  });
});

describe("expanding a branch again", () => {
  it("lists it again, so folders made since the last look show up", async () => {
    const user = userEvent.setup();
    render(<App />);
    await openTrip(user);
    await user.click(screen.getByTestId("tree-toggle-mock://trip"));
    await waitFor(() => expect(screen.queryByTestId("tree-row-mock://trip/day1")).toBeNull());
    mockAddSubfolder("mock://trip", "Day 4");
    await user.click(screen.getByTestId("tree-toggle-mock://trip"));
    expect(await screen.findByTestId("tree-row-mock://trip/day4")).toBeInTheDocument();
    expect(screen.getByTestId("tree-row-mock://trip/day1")).toBeInTheDocument();
  });
});

describe("a folder that is gone", () => {
  it("says so when clicked, leaves the library where it was, and leaves the tree", async () => {
    const user = userEvent.setup();
    render(<App />);
    await openTrip(user);
    undo.push(mockRemoveFolder("mock://trip/day2"));
    await user.click(screen.getByTestId("tree-open-mock://trip/day2"));
    await waitFor(() => expect(currentFlash()).toMatch(/Could not open day2: mock:\/\/trip\/day2 is not there/));
    expect(screen.getByTestId("library-label")).toHaveTextContent("Trip");
    await waitFor(() => expect(screen.queryByTestId("tree-row-mock://trip/day2")).toBeNull());
    expect(screen.getByTestId("tree-row-mock://trip/day1")).toBeInTheDocument();
  });

  it("one that cannot be read says so rather than showing as empty", async () => {
    const user = userEvent.setup();
    render(<App />);
    await openTrip(user);
    undo.push(mockRemoveFolder("mock://trip/day1"));
    await user.click(screen.getByTestId("tree-toggle-mock://trip/day1"));
    await waitFor(() => expect(currentFlash()).toMatch(/Could not read Day 1/));
  });
});
