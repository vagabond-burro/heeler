#!/usr/bin/env python3
"""Build the LibRaw source archive Heeler is obliged to publish.

LibRaw is used under CDDL-1.0, which asks that the source for the
covered code be available to anyone who receives a binary built from it.
This produces that source: the exact vendored tree this repository
compiles, plus a SHA-256 so a recipient can check that what they
downloaded is what we built.

Publishing the tree WHOLE is deliberate. It means nobody has to decide
whether the vendored copy differs from upstream, or hunt for a patch
set: the obligation is met the same way whether the answer is yes or no.
It is two megabytes.

The output belongs at the source URL named in the bundled license information,
and it has to stay reachable for as long as binaries built from it are out in
the world. That outlives any one release.

    python3 scripts/libraw_source.py [outdir]
"""

from __future__ import annotations

import hashlib
import io
import re
import subprocess
import sys
import tarfile
from pathlib import Path, PurePosixPath

ROOT = Path(__file__).resolve().parent.parent
BUILD_RS = ROOT / "crates" / "heeler-raw" / "build.rs"

# Fixed so the archive is reproducible: the same tree gives the same
# bytes and the same checksum every time. A checksum that moves for no
# reason is a checksum nobody bothers to check.
EPOCH = 1577836800  # 2020-01-01T00:00:00Z


def vendored_version() -> str:
    """The one place the version is written down."""
    m = re.search(r'pub const LIBRAW_VERSION: &str = "([^"]+)";', BUILD_RS.read_text())
    if not m:
        sys.exit(f"cannot read LIBRAW_VERSION from {BUILD_RS}")
    return m.group(1)


def committed_files(tree: Path) -> list[tuple[str, bytes]]:
    """The tree as git holds it at HEAD: (name inside the archive, bytes).

    Read from git, not from the disk, so every machine builds the same
    archive. A checkout can differ from what is committed (line endings
    a platform rewrote, a stray file), and Windows sorts paths without
    regard to case, which reorders the tar and so changes its checksum
    and its name; on Windows the archive came out under a name nobody had
    published. The order is the POSIX path order the first archives were
    built in, so those keep their exact bytes. An uncommitted change to
    the tree stops the build: the source published is the source
    committed.
    """
    rel = tree.relative_to(ROOT).as_posix()

    def git(*args: str, data: bytes | None = None) -> bytes:
        return subprocess.run(["git", "-C", str(ROOT), *args], input=data, capture_output=True, check=True).stdout

    if git("status", "--porcelain", "--", rel).strip():
        sys.exit(f"{rel} has uncommitted changes; commit them before building the archive")
    entries = []
    for line in git("ls-tree", "-r", "-z", "HEAD", "--", rel).split(b"\0"):
        if not line:
            continue
        meta, path = line.split(b"\t", 1)
        _mode, kind, sha = meta.split()
        if kind != b"blob":
            continue
        entries.append((PurePosixPath(path.decode()), sha.decode()))
    entries.sort()
    # One git process for every blob: header line, the bytes, a newline.
    out = git("cat-file", "--batch", data="".join(f"{sha}\n" for _, sha in entries).encode())
    files, at = [], 0
    for path, sha in entries:
        end = out.index(b"\n", at)
        size = int(out[at:end].split()[2])
        files.append((str(path.relative_to(PurePosixPath(rel).parent)), out[end + 1 : end + 1 + size]))
        at = end + 1 + size + 1
    return files


def archive_name(version: str, body: bytes) -> str:
    """The archive's name, from what is in it.

    Every changed tree is a new archive, published BESIDE the ones before
    it, since binaries built from those are still out there. So the name
    carries the first twelve hex digits of the SHA-256 of the
    uncompressed tar: the same tree is always the same name, and a changed
    one can never overwrite an archive already published. (The first
    archive, the unmodified 0.22.2 shipped with Heeler 2026.5.1 and
    earlier, predates this and is published as
    libraw-0.22.2-as-shipped-in-heeler.tar.gz.)
    """
    return f"libraw-{version}-as-shipped-in-heeler-{hashlib.sha256(body).hexdigest()[:12]}.tar.gz"


def build(out_dir: Path) -> tuple[Path, str]:
    version = vendored_version()
    tree = ROOT / "third_party" / f"LibRaw-{version}"
    if not tree.is_dir():
        sys.exit(f"no vendored tree at {tree}")
    if not (tree / "LICENSE.CDDL").is_file():
        # The license travels with the source it covers. An archive
        # without it would satisfy the letter of "here is the code" and
        # none of the point.
        sys.exit(f"{tree} has no LICENSE.CDDL")

    out_dir.mkdir(parents=True, exist_ok=True)

    files = committed_files(tree)
    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode="w", format=tarfile.USTAR_FORMAT) as tar:
        for name, data in files:
            info = tarfile.TarInfo(name)
            info.size = len(data)
            # Everything about the entry that is not its content is
            # pinned, or the archive carries this machine's clock and
            # user id into a file people are meant to verify.
            info.mtime = EPOCH
            info.uid = info.gid = 0
            info.uname = info.gname = ""
            info.mode = 0o644
            tar.addfile(info, io.BytesIO(data))

    # gzip with no timestamp in the header, same reason. The header does
    # carry the file's own name, so the name has to be settled first.
    import gzip

    body = raw.getvalue()
    archive = out_dir / archive_name(version, body)
    with archive.open("wb") as fh:
        with gzip.GzipFile(fileobj=fh, mode="wb", mtime=0) as gz:
            gz.write(body)

    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    (out_dir / f"{archive.name}.sha256").write_text(f"{digest}  {archive.name}\n")
    return archive, digest


def main() -> None:
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "dist"
    archive, digest = build(out)
    print(f"LibRaw {vendored_version()}")
    print(f"  {archive}")
    print(f"  sha256 {digest}")
    print()
    print("Publish both files at the URL named in docs/user-guide/legal/open-source.md,")
    print("and keep them there for as long as binaries built from this tree")
    print("are in anyone's hands.")


if __name__ == "__main__":
    main()
