// The user guide's navigation: a tree, ordered by the guide itself.
//
// The owner wrote a new guide as a folder tree and asked for the viewer
// to be rebuilt around it: "redesign the UI for the documentation to
// match what is used for the Preferences (including the Search field).
// You will need to make the left column support tree structure, it
// should also be scrollable in case the tree extends past the bottom."
//
// The interesting decision is where the ORDER comes from. Every folder's
// README already lists its children in the sequence a reader should
// meet them, so that IS the manifest: nothing in the app decides what
// follows what, and adding a page means editing one README. These tests
// hold that bargain, and hold the two ways it could go wrong: a page no
// README mentions must still be reachable, and a cross-reference must
// not be mistaken for ownership.

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { App } from "../app";
import { buildDocTree, docLinks, flattenDocs, resolveDocPath } from "../docstree";
import { listDocs, readDoc } from "../bridge";

async function openDocs(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByTestId("menu-help"));
  await user.click(screen.getByTestId("menu-help-docs"));
  return await screen.findByTestId("docs-viewer");
}

describe("where a link points", () => {
  it("resolves against the page it was written in, not the guide root", () => {
    // "source.md" inside adjustments/README.md is adjustments/source.md.
    // Resolving against the root instead is a sidebar that dead-ends.
    expect(resolveDocPath("adjustments/README.md", "source.md")).toBe("adjustments/source.md");
    expect(resolveDocPath("adjustments/README.md", "../export.md")).toBe("export.md");
    expect(resolveDocPath("README.md", "graph/README.md")).toBe("graph/README.md");
    expect(resolveDocPath("scripting/reference/README.md", "../examples.md")).toBe("scripting/examples.md");
    expect(resolveDocPath("adjustments/curves.md", "./levels.md")).toBe("adjustments/levels.md");
  });

  it("reads a page's links in the order they appear, once each", () => {
    const text = "1. [B](b.md)\n2. [A](a.md)\n\nSee [B](b.md) again, and http://x.test and [x](#anchor).";
    expect(docLinks("README.md", text)).toEqual(["b.md", "a.md"]);
  });
});

describe("the tree the guide describes", () => {
  it("follows each README's links, in the order it lists them", async () => {
    const tree = await buildDocTree(await listDocs(), readDoc);
    // The mock guide's README lists Library, Export, Adjustments, then
    // Legal, which is where the shipped guide puts it too.
    expect(tree.map((n) => n.file)).toEqual([
      "README.md",
      "library.md",
      "export.md",
      "adjustments/README.md",
      "legal/README.md",
    ]);
    const adjustments = tree.find((n) => n.file === "adjustments/README.md")!;
    // And that folder's README lists Exposure before Curves, which is
    // the order it teaches them in, not alphabetical.
    expect(adjustments.children.map((n) => n.file)).toEqual([
      "adjustments/exposure.md",
      "adjustments/curves.md",
      // Linked by nobody, and still here.
      "adjustments/unlisted.md",
    ]);
  });

  it("keeps a page nobody linked, under the folder it lives in", async () => {
    // A page that shipped is a page the reader can reach, whether or
    // not the prose remembered it.
    const tree = await buildDocTree(await listDocs(), readDoc);
    const files = flattenDocs(tree).map((n) => n.file);
    for (const doc of await listDocs()) expect(files, doc.file).toContain(doc.file);
  });

  it("does not let a cross-reference file a page under the wrong chapter", async () => {
    // library.md links to export.md. Export is a chapter in its own
    // right; following that link downward would bury it inside Library.
    const tree = await buildDocTree(await listDocs(), readDoc);
    expect(tree.map((n) => n.file)).toContain("export.md");
    expect(tree.find((n) => n.file === "library.md")!.children).toEqual([]);
  });

  it("titles every branch from the page's own heading", async () => {
    const tree = await buildDocTree(await listDocs(), readDoc);
    expect(tree.find((n) => n.file === "adjustments/README.md")!.title).toBe("Adjustments tab");
    expect(tree.find((n) => n.file === "library.md")!.title).toBe("Library");
  });

  it("stops rather than looping when two pages link each other", async () => {
    const entries = [
      { file: "README.md", title: "Root" },
      { file: "a/README.md", title: "A" },
    ];
    const read = async (f: string) =>
      f === "README.md" ? "# Root\n[A](a/README.md)" : "# A\n[Root](../README.md)";
    const tree = await buildDocTree(entries, read);
    expect(flattenDocs(tree).map((n) => n.file)).toEqual(["README.md", "a/README.md"]);
  });
});

describe("the sidebar", () => {
  it("nests, with its chapters closed until asked", async () => {
    // "collapsible sections should be collapsed by
// default."
    const user = userEvent.setup();
    render(<App />);
    await openDocs(user);
    const nav = screen.getByTestId("docs-tree");
    expect(within(nav).getByTestId("doc-adjustments/README.md")).toBeInTheDocument();
    expect(within(nav).queryByTestId("doc-adjustments/exposure.md")).not.toBeInTheDocument();
  });

  it("unfolds and folds a chapter without navigating to it", async () => {
    const user = userEvent.setup();
    render(<App />);
    await openDocs(user);
    const front = screen.getByTestId("doc-README.md");
    expect(front).toHaveAttribute("data-active");
    await user.click(screen.getByTestId("doc-twisty-adjustments/README.md"));
    expect(screen.getByTestId("doc-adjustments/exposure.md")).toBeInTheDocument();
    // The twisty is a separate target from the name, so unfolding did
    // not also open the chapter.
    expect(front).toHaveAttribute("data-active");
    await user.click(screen.getByTestId("doc-twisty-adjustments/README.md"));
    expect(screen.queryByTestId("doc-adjustments/exposure.md")).not.toBeInTheDocument();
  });

  it("scrolls, since the real guide is taller than the dialog", async () => {
    const user = userEvent.setup();
    render(<App />);
    await openDocs(user);
    // "it should also be scrollable in case the tree
    // extends past the bottom."
    const aside = screen.getByTestId("docs-tree").parentElement!;
    expect(aside.style.overflowY).toBe("auto");
    expect(aside.style.minHeight).toBe("0");
  });

  it("opens a page from a deep link and unfolds the chapters above it", async () => {
    const user = userEvent.setup();
    render(<App />);
    await openDocs(user);
    // Chapters start folded, so the page is not in the tree yet.
    expect(screen.queryByTestId("doc-adjustments/curves.md")).not.toBeInTheDocument();
    // A cross-link from the chapter page into its folded chapter.
    await user.click(screen.getByTestId("doc-adjustments/README.md"));
    const body = await screen.findByTestId("doc-body");
    await user.click(within(body).getByText("Curves"));
    expect(await screen.findByTestId("doc-adjustments/curves.md")).toHaveAttribute("data-active");
  });
});

describe("searching the guide", () => {
  it("finds a page by words in its body, not only by its title", async () => {
    const user = userEvent.setup();
    render(<App />);
    await openDocs(user);
    await user.type(screen.getByTestId("docs-search"), "highlights");
    const results = await screen.findByTestId("docs-search-results");
    expect(within(results).getByTestId("docs-search-result-adjustments/exposure.md")).toBeInTheDocument();
    // And shows the line it matched, so the result is recognizable.
    expect(results.textContent).toContain("room the highlights keep");
  });

  it("takes a result to its page and clears the field", async () => {
    const user = userEvent.setup();
    render(<App />);
    await openDocs(user);
    await user.type(screen.getByTestId("docs-search"), "batch");
    await user.click(await screen.findByTestId("docs-search-result-export.md"));
    expect(screen.getByTestId("doc-export.md")).toHaveAttribute("data-active");
    expect(screen.getByTestId("docs-search")).toHaveValue("");
    expect(screen.queryByTestId("docs-search-results")).not.toBeInTheDocument();
  });

  it("says so plainly when nothing matches", async () => {
    const user = userEvent.setup();
    render(<App />);
    await openDocs(user);
    await user.type(screen.getByTestId("docs-search"), "xyzzy");
    expect(await screen.findByTestId("docs-search-empty")).toHaveTextContent("Nothing matched");
  });
});

describe("the Back button", () => {
  // "The user documentation could use a back-button to go
  // back to the last page."

  it("sits disabled until a link is followed, then walks the trail home", async () => {
    const user = userEvent.setup();
    render(<App />);
    await openDocs(user);
    const backBtn = () => screen.getByTestId("docs-back");
    expect(backBtn()).toBeDisabled();
    expect(backBtn().closest("[data-hint]")?.getAttribute("data-hint")).toContain("once you follow a link");

    // Front page -> Library (sidebar), Library -> Export (cross-link).
    await user.click(screen.getByTestId("doc-library.md"));
    const body = await screen.findByTestId("doc-body");
    await user.click(within(body).getByText("Export"));
    expect(screen.getByTestId("doc-export.md")).toHaveAttribute("data-active");

    // The hint names where Back goes, not just that it goes.
    expect(backBtn().closest("[data-hint]")?.getAttribute("data-hint")).toContain("Library");
    await user.click(backBtn());
    expect(screen.getByTestId("doc-library.md")).toHaveAttribute("data-active");
    await user.click(backBtn());
    expect(screen.getByTestId("doc-README.md")).toHaveAttribute("data-active");
    expect(backBtn()).toBeDisabled();
  });

  it("does not record going back as a step of its own", async () => {
    // Back must walk the trail, not lengthen it: forward once, back
    // once, and the trail is spent rather than bouncing forever.
    const user = userEvent.setup();
    render(<App />);
    await openDocs(user);
    await user.click(screen.getByTestId("doc-library.md"));
    await user.click(screen.getByTestId("docs-back"));
    expect(screen.getByTestId("docs-back")).toBeDisabled();
  });

  it("reveals the chapters above wherever it lands", async () => {
    // Back into a folded chapter has to unfold it, exactly as a
    // forward navigation does, or the sidebar shows nothing selected.
    const user = userEvent.setup();
    render(<App />);
    await openDocs(user);
    await user.click(screen.getByTestId("doc-twisty-adjustments/README.md"));
    await user.click(screen.getByTestId("doc-adjustments/exposure.md"));
    await user.click(screen.getByTestId("doc-library.md"));
    await user.click(screen.getByTestId("doc-twisty-adjustments/README.md"));
    expect(screen.queryByTestId("doc-adjustments/exposure.md")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("docs-back"));
    expect(screen.getByTestId("doc-adjustments/exposure.md")).toHaveAttribute("data-active");
  });

  it("ignores a click on the page already open", async () => {
    // Re-picking the current page is not a journey, and Back should
    // not pretend it was one.
    const user = userEvent.setup();
    render(<App />);
    await openDocs(user);
    await user.click(screen.getByTestId("doc-README.md"));
    expect(screen.getByTestId("docs-back")).toBeDisabled();
  });
});

describe("the guide's header buttons", () => {
  it("are icons with their names as labels", async () => {
    const user = userEvent.setup();
    render(<App />);
    await openDocs(user);
    for (const [id, name] of [["docs-back", "Back"], ["docs-close", "Close"]] as const) {
      const b = screen.getByTestId(id);
      expect(b.textContent).toBe("");
      expect(b.querySelector("svg")).not.toBeNull();
      expect(b.getAttribute("aria-label")).toBe(name);
      expect(b.style.width).toBe("30px");
    }
  });
});

describe("a slow catalog", () => {
  it("a settings save stuck on the catalog does not hold up the guide", async () => {
    // The stall plan's Phase 5 probe for the settings and docs batch:
    // the hold stands in for save_ui_settings waiting on a slow volume.
    // Against the old inline body the catalog write held an
    // async-runtime worker and every later command queued behind it,
    // read_doc included; the desktop's shape test pins the move to
    // spawn_blocking, and this probe pins that the frontend never
    // serializes the guide behind the save.
    const bridge = await import("../bridge");
    const { catalogSaves, flushRecoverySaves } = await import("../savebarrier");
    let release!: () => void;
    bridge.mockSetUiSettingsHold(new Promise<void>((r) => { release = r; }));
    const user = userEvent.setup();
    try {
      render(<App />);
      // A settings save, armed the way the app arms it, goes out and
      // sticks on the catalog. The flush is not awaited: waiting on it
      // would be waiting on the stuck save, which is the stall.
      catalogSaves.arm("ui-settings", 250, () => bridge.saveUiSettings("{}"));
      void flushRecoverySaves().catch(() => {});
      await waitFor(() => expect(bridge.mockUiSettingsCalls).toBeGreaterThan(0));
      // The guide opens and renders a page while the save is still out:
      // the sidebar chip AND the page's own heading.
      await openDocs(user);
      await waitFor(async () =>
        expect((await screen.findAllByText("Heeler user guide")).length).toBeGreaterThan(1),
      );
      release();
    } finally {
      bridge.mockSetUiSettingsHold(null);
    }
  });
});
