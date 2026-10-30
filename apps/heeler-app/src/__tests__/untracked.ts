// The files this checkout holds that git is told to leave out (.gitignore,
// or a local .git/info/exclude): a scan of what the repository keeps
// reads none of them. A working copy carries notes, prompts and scratch
// files nobody commits, and a scan that walked the folders failed on one
// of them on one machine and passed on another (2026-10-29: an excluded
// prompt file named another decoder). A new file not yet added is still
// scanned, so the run before its first commit catches it. Not a test
// file: the scans import it.
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const REPO = resolve(process.cwd(), "../..");
let ignored: string[] | undefined;

/** Whether `file` (an absolute path) is one git ignores, itself or by a
 * folder it is in. Without git (a source archive), none is. */
export function untracked(file: string): boolean {
  if (ignored === undefined) {
    try {
      // --directory names an ignored folder once rather than every file in it.
      const out = execFileSync("git", ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"], { cwd: REPO, encoding: "utf8", maxBuffer: 64 << 20 });
      ignored = out.split("\0").filter(Boolean).map((f) => resolve(REPO, f));
    } catch {
      ignored = [];
    }
  }
  const path = resolve(file);
  return ignored.some((p) => path === p || path.startsWith(`${p}/`) || path.startsWith(`${p}\\`));
}
