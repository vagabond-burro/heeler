# Publishing LibRaw's source

Heeler reads RAW files with LibRaw, used under **CDDL-1.0**. That license
asks for one thing Heeler cannot satisfy from inside the binary: the
source of the covered code has to be **available to anyone who receives
that binary**. It is a hosting commitment, not a code change, and it is
the only third-party obligation here that can block a release.

## Where it is published

The site repo is `repsac/heeler-app`, a GitHub Pages site deploying from
`public/`. The archive lives at `public/source/libraw/`, committed
rather than built by CI: the site repo cannot reach this one, and a file
that has to stay downloadable for years is safest as a file.

That repo is private. It does not matter: the obligation is that
RECIPIENTS can get the source, and the deployed site is public. What
would matter is Pages not serving at all, so confirm the URL resolves
after any change to the plan.

The host name is `www.heeler.app`, matching the site's own canonical
link. The apex may or may not redirect; a license citation should not
depend on finding out.

## The one thing that must be done before a binary ships

`https://www.heeler.app/source/libraw/` must serve the archive and
its checksum. That URL is named in
`docs/user-guide/legal/open-source.md`, which is the notice users read, so a binary that ships before the URL is live is
a binary whose license page points at nothing.

Nothing in this repository can check that for you. It is the only step
here that is a decision rather than a command.

## Producing the archive

```
python3 scripts/libraw_source.py
```

Writes `dist/libraw-<version>-as-shipped-in-heeler.tar.gz` and a
`.sha256` beside it. Publish both.

The archive is the whole vendored tree, not a patch set. That is
deliberate: it means nobody has to establish whether our copy differs
from upstream, because the obligation is met identically either way. It
is two megabytes, which is a rounding error against being asked to prove
a negative later.

It is also reproducible. Fixed mtimes, ownership and ordering, and a
gzip header with no timestamp, so the same tree gives the same bytes and
the same checksum on any machine. A checksum that moves for no reason is
one nobody checks.

## How long it has to stay up

For as long as binaries built from that tree are in anyone's hands.
That outlives the release, and it outlives the *next* release: somebody
running last year's build is still a recipient. In practice this means
old archives are kept, not replaced, and each release points at its own.

## When the vendored version changes

`LIBRAW_VERSION` in `crates/heeler-raw/build.rs` is the only place the
version is written down. Bumping it moves the build, the archive script
and the vendored path together.

The user-facing notice is not automatic, and a test
(`the_licence_page_names_the_libraw_that_is_actually_built`) fails until
`docs/user-guide/legal/open-source.md` names the new version. That test
exists
because the drift already happened once: the build went to 0.22.2 and
the license note in `Cargo.toml` went on citing a 0.21.3 tree that had
been deleted, which is the first file anyone checking compliance would
open.

So the sequence for a version bump is: bump `LIBRAW_VERSION`, vendor the
new tree, update the notice until the test passes, run the script, and
publish the new archive **alongside** the old one.

## The other two obligations

Publishing the source is one of three. The other two live in
`docs/user-guide/legal/`, which is what the Help menu shows, beside
Heeler's own license and the Privacy Policy:

- `open-source.md` names LibRaw, its version, the license chosen
  (CDDL-1.0 rather than the LGPL option), and LibRaw's copyright.
- `cddl.md` carries the license text itself, generated from the tree
  we build so it cannot be paraphrased. Regenerate it whenever the
  vendored version changes; a test compares the two word for word and
  fails if they differ.

Both were stranded for a while: the guide became a tree
(`docs/user-guide`) and only that tree is bundled, but these two pages
were left behind in the old flat `docs/user`, so for several commits the
notices did not ship at all while the About box went on telling people
where to find them. Moved 2026-08-28. If either page ever needs a new
home again, the thing that makes it real is the bundle, not the repo:
`docs/user-guide` is the only folder `tauri.conf.json` carries.

The wording of the warranty and indemnity section in `open-source.md`
has not been reviewed by a lawyer. It follows what the licenses ask for,
but that is a different claim from being correct, and no amount of
further review by software agents closes it.

## What is not covered here

zlib and libjpeg (via `libz-sys` and `mozjpeg-sys`) are permissive and
ask only for their notices to be carried, which
`docs/user-guide/legal/open-source.md` does. So is GoPro's VC-5 decoder
(`third_party/gpr-vc5`, taken under its MIT option, with Heeler's changes
listed in its README): its notice is on the same page, and MIT asks for no
source to be published. The Rust and JavaScript
dependency
trees are essentially all MIT or Apache-2.0 and are covered in the same
place by category rather than package. If a full per-package inventory
is ever wanted, generate it with `cargo about` rather than by hand.
