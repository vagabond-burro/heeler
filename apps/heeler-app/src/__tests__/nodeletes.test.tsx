// Heeler does not delete files. Not photographs, not the recipes it
// wrote itself, not as a favor, not with a confirmation.
//
// The owner, closing the last exception: "The reasoning is to remove
// ALL code related to deleting files. Even if we limit Heeler to
// delete only panoramas and stacks, its still deleting from disk. I am
// trying to manage risk here."
//
// The Rust side has its own guard (nothing_here_deletes_a_file_the_user
// _owns, per call site). This is the other half: the frontend must not
// have a door to walk through, because a command that exists is a
// command something eventually calls.

import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import * as bridge from "../bridge";
import { DEFAULT_PREFS } from "../state";

/** Every source file in the app, production only. */
function sources(dir = resolve(process.cwd(), "src"), out: [string, string][] = []): [string, string][] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "__tests__" || entry.name === "node_modules") continue;
    const at = `${dir}/${entry.name}`;
    if (entry.isDirectory()) sources(at, out);
    else if (/\.tsx?$/.test(entry.name)) out.push([entry.name, readFileSync(at, "utf8")]);
  }
  return out;
}

describe("no way to ask for a deletion", () => {
  it("has no bridge function that deletes a file", () => {
    // The command is gone from the backend; an exported wrapper for it
    // would be a call into nothing, and worse, a thing to reinstate.
    expect(bridge).not.toHaveProperty("deleteComposites");
    // What may still be called delete is what is not a file. A
    // collection is rows in the catalog naming photographs that stay
    // exactly where they are; a take is a saved edit history. Neither
    // touches the disk the user's pictures are on.
    const names = Object.keys(bridge).filter((k) => /^delete/i.test(k));
    expect(names).toEqual(["deleteCollection"]);
  });

  it("invokes no deleting command anywhere in the app", () => {
    const banned = ["delete_composites", "delete_images", "remove_file"];
    const offenders: string[] = [];
    for (const [name, text] of sources()) {
      for (const word of banned) if (text.includes(word)) offenders.push(`${name}: ${word}`);
    }
    expect(offenders).toEqual([]);
  });

  it("keeps Move to Trash as the one way a file leaves a folder", () => {
    // Which is a rename into .trash beside the images, and reversible.
    expect(bridge).toHaveProperty("moveImagesToTrash");
    expect(bridge).toHaveProperty("restoreImagesFromTrash");
  });
});

describe("exports never write over what is already there", () => {
  it("ships the guard on", () => {
    // "Maybe we have an option in place (on by default) to not
    // overwrite original files or add an index _1.extension if the file is
    // found."
    expect(DEFAULT_PREFS.exportNeverOverwrite).toBe(true);
  });

  it("hands the preference to the one export that could overwrite", () => {
    // A batch never could: no dialog asks, so a taken name has always
    // moved aside. The save dialog is the only path where a yes exists
    // to be honored, so it is the only one that reads the preference.
    const text = readFileSync(resolve(process.cwd(), "src/bridge.ts"), "utf8");
    const call = text.slice(text.indexOf('call<string | null>("export_image"'));
    expect(call).toContain("allowOverwrite: !state.prefs.exportNeverOverwrite");
  });

  it("says in Preferences that the library is protected either way", () => {
    // The half of the rule that is not a preference, stated where
    // somebody is deciding whether to turn the other half off. Since
    // 2026-09-30 that is the row's one description ("the
    // checkbox and help text are pushed up against each other").
    const text = readFileSync(resolve(process.cwd(), "src/ui/preferences.tsx"), "utf8");
    const entry = text.slice(text.indexOf('id: "export-overwrite"'));
    const description = entry.slice(0, entry.indexOf("},"));
    expect(description).toContain("photograph in your library");
  });
});
