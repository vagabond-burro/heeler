// A photograph that moved after it was edited.
//
// "if a photo had been edited and then later moved, that
// when the app launched it still loads the thumbnail but indicates
// that the source file is missing."
//
// The failure this replaces was silence. The folder listing was built
// from the files on disk, so a photograph moved in the file browser stopped
// existing: no row, no thumbnail, no route to the edits, and nothing
// said about any of it. The library looked correct, which is worse than
// an error.

import { render, screen, fireEvent } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";

import { initialState } from "../data";
import { BrowserPanel, Ribbon, loadSessionImages } from "../ui/chrome";
import { reduce, type Command, type ImageEntry, type State } from "../state";
import type { FolderImage } from "../bridge";
import { isMissingSource } from "../previewretry";

const files: FolderImage[] = [
  { id: "img_here", name: "here.NEF", stars: 3, flag: "", edited: true },
  { id: "img_gone", name: "gone.NEF", stars: 5, flag: "pick", edited: true, missing: true },
];

/** The ribbon session the bridge hands over on a folder open. */
function loaded(): State {
  let s = initialState();
  loadSessionImages(files, (c: Command) => {
    s = reduce(s, c);
  });
  return s;
}

describe("a photograph whose file has moved", () => {
  it("is still in the library, carrying its rating and its edited mark", () => {
    const s = loaded();
    const gone = s.images.find((i) => i.id === "img_gone");
    expect(gone).toBeDefined();
    expect(gone!.missing).toBe(true);
    // The row is what holds the work. Losing it would lose the rating,
    // the flag and the route to the saved graph, none of which moved
    // anywhere.
    expect(gone!.stars).toBe(5);
    expect(gone!.flag).toBe("pick");
    expect(gone!.edited).toBe(true);
  });

  it("leaves the photographs that did not move alone", () => {
    const s = loaded();
    expect(s.images.find((i) => i.id === "img_here")!.missing).toBe(false);
  });

  it("marks the thumbnail without hiding the picture", () => {
    // The cached thumbnail is the point: it is what lets somebody
    // recognize which photograph needs finding. A gray box would not.
    const s = loaded();
    render(<Ribbon state={s} dispatch={() => {}} />);
    expect(screen.getByTestId("thumb-missing-img_gone")).toBeInTheDocument();
    expect(screen.queryByTestId("thumb-missing-img_here")).not.toBeInTheDocument();
  });

  it("says both things at once when it is edited AND missing", () => {
    // The exact pairing the owner described. The two marks sit in
    // opposite corners so neither covers the other.
    const s = loaded();
    render(<Ribbon state={s} dispatch={() => {}} />);
    const mark = screen.getByTestId("thumb-missing-img_gone");
    expect(mark).toBeInTheDocument();
    const cell = mark.parentElement!;
    expect(cell.getAttribute("data-edited")).toBe("true");
  });
});

/** The ribbon with a real reducer behind it, so right-clicking moves the
 * selection the way it does in the app. */
function RibbonHost({ start }: { start: State }) {
  const [s, setS] = useState(start);
  return <Ribbon state={s} dispatch={(c: Command) => setS((p) => reduce(p, c))} />;
}

describe("relinking is offered only where it means something", () => {
  it("offers Relink on a photograph that has moved", async () => {
    render(<RibbonHost start={loaded()} />);
    fireEvent.contextMenu(screen.getByTestId("thumb-img_gone"), { clientX: 40, clientY: 40 });
    expect(await screen.findByTestId("thumb-menu-relink")).toBeInTheDocument();
  });

  it("does not offer it on one that is exactly where it should be", async () => {
    // An always-on Relink invites people to re-point files that never
    // moved, which is a way to break a library rather than mend one.
    render(<RibbonHost start={loaded()} />);
    fireEvent.contextMenu(screen.getByTestId("thumb-img_here"), { clientX: 40, clientY: 40 });
    await screen.findByTestId("thumb-menu-trash");
    expect(screen.queryByTestId("thumb-menu-relink")).not.toBeInTheDocument();
  });
});

/** Guards the shape the bridge promises, since the flag crosses from
 * Rust and a rename on either side would go unnoticed. */
describe("the entry the bridge hands over", () => {
  it("defaults to present when the backend says nothing", () => {
    let s = initialState();
    loadSessionImages([{ id: "a", name: "a.NEF", stars: 0, flag: "" }], (c: Command) => {
      s = reduce(s, c);
    });
    const entry: ImageEntry = s.images[0];
    expect(entry.missing).toBe(false);
  });
});

describe("a render that cannot be retried into working", () => {
  it("recognizes the one failure that waiting will not mend", () => {
    // The owner's console, on both sides of a successful relink: five
    // attempts over thirty-one seconds, the same line each time, while the
    // viewer sat on APPROX. A file that is not there will not be there in
    // sixteen seconds either.
    expect(isMissingSource("io error: No such file or directory (os error 2)")).toBe(true);
    expect(isMissingSource("the original is missing or moved: /a/b.RW2")).toBe(true);
  });

  it("still retries the failures that are worth retrying", () => {
    // The backoff exists for wedged or slow renders, and taking it away
    // from those would trade one bug for another.
    expect(isMissingSource("engine busy")).toBe(false);
    expect(isMissingSource("Slow engine render: 500ms")).toBe(false);
    expect(isMissingSource("gpu device lost")).toBe(false);
  });
});

describe("finding a folder's trash", () => {
  // "if a folder has a .trash in it then in the context menu
  // for folders have an option to open the trash folder in the system
  // browser." Better than a Trash view inside the app, and consistent with
  // the rule the folder already lives by: nothing in Heeler empties it, so
  // the app's job ends at showing you where it is.
  const withTrashAt = (paths: string[]): State => ({
    ...initialState(),
    foldersWithTrash: paths,
    folders: [
      { id: 1, name: "Wedding", path: "mock://wedding", count: 3, lastOpened: 0 },
      { id: 2, name: "Landscapes", path: "mock://landscapes", count: 3, lastOpened: 0 },
    ],
    // The context menu is the tree's; the shortlist rows above it open
    // a folder and nothing else.
    folderTree: {
      name: "Wedding",
      path: "mock://wedding",
      expanded: true,
      children: [{ name: "day1", path: "mock://wedding/day1", expanded: false, children: null }],
    },
  });

  it("badges only the folder that actually has one", () => {
    // The passive half of the discovery story: you learn about a trash
    // without having gone looking, which is what catches the person who
    // forgot. Exact match, not prefix, so an ancestor does not claim a
    // bin that is four folders down.
    render(<BrowserPanel state={withTrashAt(["mock://wedding"])} dispatch={() => {}} />);
    // Both places a folder appears: the shortlist above and the tree
    // below. Badging one and not the other would make the mark depend
    // on where you happened to be looking.
    expect(screen.getAllByTestId("folder-trash-mock://wedding").length).toBeGreaterThan(0);
    expect(screen.queryByTestId("folder-trash-mock://landscapes")).not.toBeInTheDocument();
    expect(screen.queryByTestId("folder-trash-mock://wedding/day1")).not.toBeInTheDocument();
  });

  it("says nothing at all when no folder has a trash", () => {
    render(<BrowserPanel state={withTrashAt([])} dispatch={() => {}} />);
    expect(screen.queryByTestId(/^folder-trash-/)).not.toBeInTheDocument();
  });

  it("offers Show Trash on that folder's menu and nowhere else", async () => {
    const withMenu = (paths: string[]) => {
      const s = withTrashAt(paths);
      return <BrowserPanel state={s} dispatch={() => {}} />;
    };
    const { rerender } = render(withMenu(["mock://wedding"]));
    fireEvent.contextMenu(screen.getByTestId("tree-row-mock://wedding"), { clientX: 40, clientY: 40 });
    expect(await screen.findByTestId("folder-menu-trash")).toBeInTheDocument();
    // The plain reveal is still there beside it: the folder and its bin
    // are two different places to be sent.
    expect(screen.getByTestId("folder-menu-reveal")).toBeInTheDocument();

    // A folder with no trash beside it offers no way into one.
    rerender(withMenu([]));
    expect(screen.queryByTestId("folder-menu-trash")).not.toBeInTheDocument();
    expect(screen.getByTestId("folder-menu-reveal")).toBeInTheDocument();
  });
});
