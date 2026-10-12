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
import sys
import tarfile
from pathlib import Path

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

    files = sorted(p for p in tree.rglob("*") if p.is_file())
    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode="w", format=tarfile.USTAR_FORMAT) as tar:
        for path in files:
            info = tar.gettarinfo(str(path), arcname=str(path.relative_to(tree.parent)))
            # Everything about the entry that is not its content is
            # pinned, or the archive carries this machine's clock and
            # user id into a file people are meant to verify.
            info.mtime = EPOCH
            info.uid = info.gid = 0
            info.uname = info.gname = ""
            info.mode = 0o644
            with path.open("rb") as fh:
                tar.addfile(info, fh)

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
