# A pure Rust raw decoder beside LibRaw

Heeler opens every raw file through LibRaw 0.22.2 (vendored, with Heeler's
patches, reached through `crates/heeler-raw`). This plan replaces it,
format by format, with a pure Rust decoder and develop, for two reasons:
opening a raw is a visible cost, and the C++ dependency complicates every
build, the iOS one most of all. LibRaw stays in place for every file the
Rust path has not been verified on.

## The goal, in numbers

Speed is wall time in release, on one file, from the file's bytes to the
`SensorImage` Heeler takes from LibRaw today, under the same `DevelopOpts`,
on the same machine and thread count.

- Floor: at least 30% less time than LibRaw (new time at most 0.70 of
  LibRaw's). A format below the floor stays on LibRaw.
- Target: 50% less time (at most 0.50).

Correctness comes first: a format ships on the Rust path only once its
output matches LibRaw's within the tolerances below (for DNG, to the bit).

Every number in this document was measured on one machine: a 16-core
Apple M4 Max (12 performance and 4 efficiency cores), 48 GB, macOS,
`cargo build --release`, every core available to both decoders.

## What Heeler takes from LibRaw

Only `heeler-io` calls `heeler-raw`; the app, `heeler-vision`, the engine
and the graph reach raw files through `heeler-io`'s `decode_*`,
`probe_memory`, `picture_dimensions` and `is_raw_path`.

| Entry point | Called from (heeler-io) | Develop choices |
|---|---|---|
| `decode_sensor_with` | `develop_full`, `keep_develop`, `decode_any_inner`, `decode_preview_inner` | full or half size, `fixed_white` for scene-linear stacks, white balance, matrix, highlights and demosaic from the source node |
| `decode_sensor_until` (stop flag) | `clip_and_blend`: the Blend develop beside the Clip one, stopped when Clip finds too few pixels at white | as above, highlight 2 |
| `decode_sensor_half`, `decode_sensor` | `decode_thumbnail_inner` (GPR, raw TIFF, last resort) | defaults |
| `develop_bytes` | `clip_and_blend`, to admit two develops at once | |
| `dimensions`, `demosaic_extra_bytes` | `estimate_from` (memory admission, from an 8 MiB prefix) | |
| `picture_dimensions` | `picture_dimensions` (catalog, viewer), `raw_tiff::libraw_knows` | |
| `set_ahd_threads`, `set_xtrans_threads`, `set_parallel_ahd` | tests and examples only | |

The source node's defaults are the camera's white balance and matrix,
Blend highlights (2) and the standard demosaic (-1, AHD); the node also
offers Clip (0), Rebuild (5), the fast demosaic (0, linear) and the fine
one (11, DHT).

Metadata: the white balance, color matrix, black and white levels, active
area, pixel aspect and orientation a develop uses are LibRaw's, read
inside the develop and never handed to Rust. Everything else Heeler shows
or uses about a raw file is already its own Rust: EXIF, lens and the
metadata panel (`heeler-io` exif.rs and metadata.rs), the orientation of
previews (raw_preview.rs), embedded previews, DNG profile gain tables and
tone curves (dng_gain.rs), and lens correction (lens_warp.rs, lensdb.rs).

Files that already bypass LibRaw, wholly or in part:

- JPEG XL DNG: decoded by `heeler-io` (dng_jxl.rs), never by LibRaw.
- Linear DNG in lossless JPEG tiles (ProRAW): developed by
  `heeler-raw/src/linear_dng.rs` on the banded export path, with LibRaw's
  open for the metadata.
- DNG gain maps: LibRaw supplies the opcode bytes, Rust applies them
  (heeler-rawdec's gain_map) around LibRaw's develop.
- GoPro GPR: the VC-5 tile is decoded first (gpr.rs; a vendored C library
  until 2026-10-25, since then heeler-rawdec's Rust port, vc5.rs), then
  LibRaw develops the DNG it becomes.
- An LGPL-2.1 Rust decoder: an optional `heeler-io` feature for the
  `rawdiff` comparison harness only, never shipped.

## The sample corpus

The corpus is a public archive of sample raw files, read from
`HEELER_RAW_CORPUS` (maker/camera/file). On 2026-10-19 the archive's
listing (its SHA-256 file list, 2020 files) was compared with
the local manifest dated 2026-09-08 (2016 files): 4 files added, none
removed, none changed. The four (Panasonic DC-FZ83, 87.6 MB) were
downloaded over the archive's HTTPS mirror (`/data/`) and checked against
the listed SHA-256. The corpus is now 2020 files, 60.5 GB.

## The harness

`crates/heeler-raw/examples/rawbench.rs` times each file: one untimed
develop, then the median of N timed ones, split into open (identification
and metadata), unpack (the sensor data) and develop (everything after:
levels, white balance, demosaic, color, the copy out). It writes one CSV
row a file and prints per-format and per-camera totals; `--compare BASE
NEW` gives the ratio per format and camera with the floor and target
marked. A DNG is classed by its raw image's compression and photometric
interpretation, since one extension hides several decoders.

```
cargo run --release -p heeler-raw --features rust-decoder --example rawbench -- \
    --decoder libraw --runs 3 --csv libraw.csv
```

Two more harnesses hold the Rust path to LibRaw: `dngfacts` (each DNG's
tags as the Rust reader reads them against what LibRaw read when it
opened the file) and `rustdiff` (the unpacked mosaic, the white-balanced
mosaic and the four develops, sample by sample).

## The baseline

LibRaw 0.22.2, full-size develops with `DevelopOpts::default()` (the camera's white balance and matrix, Clip highlights, AHD), median of 3 timed runs after one untimed, 2020 files: 1961 developed, 59 failed. The corpus's sum of medians is 822 s. Per file and per camera: `rust-raw-decoder/baseline-libraw-full.csv`.

| Format | Files | Share of files | Sum s | Share of time | Median ms | Median ms/MP | Unpack | Develop | Failed |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| RAF | 151 | 7.5% | 229.8 | 28.0% | 1432 | 39.2 | 32% | 68% | 0 |
| RW2 | 400 | 19.8% | 111.8 | 13.6% | 237 | 14.8 | 28% | 72% | 2 |
| NEF | 263 | 13.0% | 84.2 | 10.2% | 296 | 16.9 | 45% | 55% | 14 |
| ARW | 202 | 10.0% | 60.9 | 7.4% | 252 | 10.5 | 27% | 73% | 4 |
| ORF | 93 | 4.6% | 48.5 | 5.9% | 353 | 21.9 | 59% | 41% | 0 |
| IIQ | 35 | 1.7% | 46.7 | 5.7% | 1052 | 21.0 | 21% | 79% | 0 |
| CR2 | 142 | 7.0% | 46.6 | 5.7% | 342 | 20.4 | 59% | 41% | 0 |
| CR3 | 110 | 5.4% | 37.6 | 4.6% | 342 | 14.3 | 41% | 59% | 0 |
| DNG-Uncompressed-CFA | 162 | 8.0% | 30.3 | 3.7% | 175 | 14.1 | 24% | 76% | 0 |
| DNG-LJ92-CFA | 72 | 3.6% | 28.2 | 3.4% | 315 | 19.9 | 52% | 48% | 0 |
| PEF | 42 | 2.1% | 14.6 | 1.8% | 345 | 16.7 | 50% | 50% | 0 |
| FFF | 11 | 0.5% | 10.4 | 1.3% | 735 | 14.5 | 44% | 56% | 0 |
| ORI | 19 | 0.9% | 8.9 | 1.1% | 479 | 23.5 | 63% | 37% | 0 |
| TIF | 20 | 1.0% | 8.2 | 1.0% | 350 | 22.6 | 18% | 82% | 0 |
| DNG-LJ92-Linear | 12 | 0.6% | 8.2 | 1.0% | 402 | 33.6 | 81% | 19% | 0 |
| SRW | 27 | 1.3% | 7.4 | 0.9% | 293 | 14.3 | 37% | 63% | 0 |
| CRW | 48 | 2.4% | 7.2 | 0.9% | 132 | 17.3 | 26% | 74% | 3 |
| 3FR | 11 | 0.5% | 6.6 | 0.8% | 556 | 8.2 | 18% | 82% | 0 |
| GPR | 17 | 0.8% | 5.9 | 0.7% | 279 | 23.3 | 53% | 47% | 0 |
| RWL | 20 | 1.0% | 3.9 | 0.5% | 182 | 15.0 | 24% | 76% | 0 |
| RAW | 38 | 1.9% | 3.6 | 0.4% | 87 | 11.0 | 6% | 94% | 11 |
| MOS | 4 | 0.2% | 2.9 | 0.4% | 615 | 20.0 | 50% | 50% | 0 |
| NRW | 12 | 0.6% | 1.8 | 0.2% | 142 | 11.4 | 18% | 82% | 0 |
| DNG-Deflate-CFA | 3 | 0.1% | 1.5 | 0.2% | 513 | 22.9 | 62% | 38% | 0 |
| DNG-Uncompressed-Linear | 8 | 0.4% | 1.5 | 0.2% | 116 | 7.2 | 45% | 55% | 0 |
| MRW | 14 | 0.7% | 1.0 | 0.1% | 79 | 13.1 | 18% | 82% | 0 |
| DCR | 5 | 0.2% | 0.7 | 0.1% | 162 | 12.0 | 25% | 75% | 0 |
| KDC | 9 | 0.4% | 0.7 | 0.1% | 91 | 12.7 | 22% | 78% | 0 |
| SRF | 1 | 0.0% | 0.6 | 0.1% | 559 | 69.1 | 2% | 98% | 0 |
| ARQ | 1 | 0.0% | 0.4 | 0.0% | 368 | 8.7 | 14% | 86% | 0 |
| MEF | 1 | 0.0% | 0.4 | 0.0% | 353 | 16.5 | 17% | 83% | 0 |
| DNG-LossyJPEG | 2 | 0.1% | 0.3 | 0.0% | 149 | 9.1 | 46% | 54% | 0 |
| STI | 1 | 0.0% | 0.3 | 0.0% | 276 | 8.3 | 5% | 95% | 0 |
| ERF | 3 | 0.1% | 0.2 | 0.0% | 82 | 13.3 | 23% | 77% | 0 |
| SR2 | 1 | 0.0% | 0.1 | 0.0% | 101 | 9.9 | 5% | 95% | 0 |
| MDC | 1 | 0.0% | 0.0 | 0.0% | 24 | 16.2 | 3% | 97% | 0 |
| ARI | 0 | | | | | | | | 1 |
| CAM | 0 | | | | | | | | 2 |
| LRI | 0 | | | | | | | | 1 |
| X3F | 0 | | | | | | | | 18 |
| DNG-unknown | 0 | | | | | | | | 2 |
| DNG-JXL-Linear | 0 | | | | | | | | 1 |

Two things stand out. Compressed RAF is 28% of the corpus's time on 7.5%
of its files, and nearly all of that is the X-Trans demosaic, not the
decoding. And for most formats the develop, not the unpack, is the larger
share: 70% or more for RW2, ARW, IIQ, RWL and uncompressed DNG.

## Where LibRaw's time goes

Sampled profiles of LibRaw develops (samples per thread over a 4 s window
of repeated full-size develops):

| Function | 24 MP ARW | 46 MP NEF lossless | 30 MP CR2 | 20 MP RW2 | CR3 (C-RAW, crop) | 20 MP ORF | 24 MP DNG (one strip) |
|---|---:|---:|---:|---:|---:|---:|---:|
| unpack (format decoder) | 480 | 1311 | 1591 | 726 | 1003 | 1790 | 1641 |
| AHD, 4 steps, all threads | 4400 | 3366 | 2606 | 3104 | 3068 | 2312 | 2336 |
| convert_to_rgb_loop | 640 | 443 | 385 | 477 | 442 | 322 | 354 |
| scale_colors_loop | 368 | 278 | 215 | 273 | 274 | 194 | 201 |
| copy_mem_image | 329 | 209 | 190 | 245 | 224 | 171 | 177 |
| fcol, copy_bayer | 434 | 315 | 252 | 325 | 325 | 230 | 240 |
| subtract_black_internal | | | | 361 | | | |

On the 24 MP RAF the patched, parallel X-Trans demosaic is nearly all of
it (14291 samples in its tiles, 1133 in cielab).

Two things follow. First, the AHD is already parallel (Heeler's shim runs
LibRaw's own tile steps on every core), so its samples spread across 16
threads are a small share of the wall time; everything else in the table
runs on one thread. On the ARW the single-threaded stages are more than
half the wall time: the unpack, `scale_colors`, `convert_to_rgb` (which
also builds a histogram for auto-brightening that Heeler turns off),
`copy_mem_image`, and `copy_bayer` and `fcol`, which copy the mosaic into
a four-channel image at 8 bytes a pixel through a function call a sample.
Second, the unpack is the other large serial cost wherever the format
codes the frame as one Huffman stream (NEF, CR2, ORF, one-strip DNG).

The candidates, measured on the first format:

- Work LibRaw does that Heeler throws away, and copies: the four-channel
  image, the histogram, the separate scale, convert and copy passes. The
  Rust develop keeps one 2-byte mosaic, scales it in place, and writes each
  demosaiced pixel through the matrix straight into the output, turned as
  the file says, with no second copy of the frame.
- Parallel stages: every pass across the cores (black, scale, demosaic in
  tiles, half-size binning). This is most of the develop's gain.
- Parallel decoding of tiles and strips: lossless JPEG tiles side by side;
  for a frame in one strip (most camera-written DNGs), the code stream read
  from many points at once (below).
- SIMD unpacking and Huffman decoding: a 12-bit table that decodes a code
  and its difference in one lookup, and 8-byte loads. On one stream this
  measured close to its latency bound already (about 3.6 ns a sample);
  reading the stream from many points at once gave 3x, where faster serial
  decoding could not.
- Memory-mapped input: not needed. The callers hand `heeler-raw` the
  file's bytes already read, and the develop reads them in place.

## The survey

The Rust raw decoders published as of 2026-10, by license and reach:

| License | Upkeep | Formats | Speed against LibRaw |
|---|---|---|---|
| LGPL-2.1 | active (2026-08) | broad: CR2, CR3, NEF, ARW, RAF, RW2 v4 to v8, ORF, PEF, IIQ, DNG (LJ92, Deflate, JPEG XL), and more; no NEF High Efficiency | none published |
| LGPL-2.1 | mostly dormant (2026-08, a dependency bump) | broad, but no CR3 and no compressed RAF | none published |
| LGPL-3.0-or-later | alpha | thumbnails and metadata first; raw data for the main formats | none |
| LGPL-2.1 | stale (2023) | a short camera list | none |
| MIT OR Apache-2.0 | one release (2024) | Sony ARW only | none |
| MPL-2.0 | alpha (2026) | ARW and DNG maturing; CR2, NEF, RAF incomplete | none |
| AGPL-3.0 | 2026 | DNG read and write | none |

None is usable as is. The broad ones are LGPL, which Heeler keeps out of
shipped binaries (the first is linked only into the `rawdiff` harness), and
their own source headers say several of their decoders (CRX, Panasonic v8,
compressed RAF) were ported from LibRaw or other LGPL code. The
permissively licensed ones cover one or two formats, and none publishes
numbers against LibRaw. A decoder that only replaces LibRaw's decoders,
format for format, gains little where LibRaw's own decoding is not the
cost: the profile above shows the develop's serial stages are most of the
time for the common formats. So the plan leans on a fused, parallel
develop shared by every format, and on parallel decoding for the formats
coded as one long stream.

### Where the formats are documented

Heeler's decoder is written from specifications and documented format
descriptions, never by copying or translating LibRaw or any other
decoder's code. That divides the formats:

| Format | Public description | Owner's decision needed |
|---|---|---|
| DNG: uncompressed, lossless JPEG, Deflate, lossy JPEG, JPEG XL | DNG Specification 1.7.1; ITU-T T.81; RFC 1950/1951; TIFF Technical Note 3; ISO/IEC 18181 | no |
| CR3 (CRX) | a published prose description of the format, a patent (US 2016/0323602 A1), ITU-T T.87 and T.800 | no, but the description's sample code is GPL and must not be read |
| CR2 (lossless JPEG in slices) | a published prose description, ITU-T T.81 | no |
| Sony ARW2 (the compressed curve) | a 2016 paper describing the coding; tag documentation | no |
| Sony lossless ARW, ARW1, newer "compressed RAW 2" | partly (SMPTE RDD 34 with undocumented departures) | yes |
| Nikon NEF lossless and lossy | the Huffman tables are not in the files; documented only by GPL, LGPL and CDDL code | yes |
| Nikon High Efficiency | ISO/IEC 21122 (JPEG XS) with undocumented changes | yes |
| Panasonic RW2 compressed (all versions) | code only | yes |
| Olympus ORF compressed, Pentax PEF Huffman details, Samsung SRW, Phase One IIQ, Hasselblad 3FR, compressed RAF | code only | yes |

A second question applies to every format except DNG. A DNG carries its
own color matrices and levels; other formats do not, and LibRaw develops
them with matrices, black levels and white levels from its own built-in
camera tables. Matching LibRaw's develop means using the same numbers.
Whether Heeler may take those numbers (by reading them from LibRaw's
output for each camera, as `dngfacts` does for DNGs, or from another
source) is the owner's decision, and it gates every non-DNG format.

## The formats, in order

The estimate for each format is LibRaw's own unpack and develop, measured
in the baseline, each times a factor: the develop's factor is the one the
DNG develop measured (0.40 for a Bayer develop, full size), since every
Bayer format shares that develop; the unpack's factor is what the format's
coding allows (side by side where it is cut into independent pieces, read
from many points where it is one stream, about LibRaw's own where each row
depends on the rows before it). The X-Trans develop is already parallel in
LibRaw's patched build, so RAF assumes a smaller gain there.

| Order | Format | Files | Share of time | LibRaw median ms (unpack/develop) | Estimated ratio | Against floor / target | Difficulty | Public description |
|---:|---|---:|---:|---|---:|---|---|---|
| 1 | DNG-Uncompressed-CFA | 162 | 3.7% | 25/135 | 0.29 | target | done | specification |
| 1 | DNG-LJ92-CFA | 72 | 3.4% | 172/142 | 0.26 | target | done | specification |
| 2 | DNG-LJ92-Linear | 12 | 1.0% | 320/74 | 0.36 | target | low | specification |
| 2 | DNG-Deflate-CFA | 3 | 0.2% | 322/190 | 0.34 | target | low | specification |
| 2 | DNG-Uncompressed-Linear | 8 | 0.2% | 19/98 | 0.47 | target | low | specification |
| 3 | ARW | 202 | 7.4% | 47/204 | 0.40 | target | medium | ARW2 documented; lossless and ARW1 not |
| 3 | CR2 | 142 | 5.7% | 192/140 | 0.31 | target | medium | documented |
| 4 | DNG-LossyJPEG | 2 | 0.0% | 69/80 | 0.55 | floor | medium | specification |
| 5 | CR3 | 110 | 4.6% | 138/203 | 0.44 | target | high | documented (CRX, patents) |
| 6 | NEF | 263 | 10.2% | 136/178 | 0.38 | target | high | none (the Huffman tables are in no file or prose) |
| 6 | NRW | 12 | 0.2% | 32/116 | 0.42 | target | high | none |
| 7 | RW2 | 400 | 13.6% | 58/178 | 0.40 | target | high | none |
| 7 | RWL | 20 | 0.5% | 43/139 | 0.40 | target | high | none |
| 8 | RAF | 151 | 28.0% | 35/832 | 0.60 | floor | very high | none for the compressed coding |
| 9 | ORF | 93 | 5.9% | 217/140 | 0.70 | floor | high | none |
| 9 | PEF | 42 | 1.8% | 171/162 | 0.38 | target | high | none |
| 9 | ORI | 19 | 1.1% | 307/172 | 0.72 | below floor | high | none |
| 10 | IIQ | 35 | 5.7% | 196/811 | 0.40 | target | high | none |
| 10 | FFF | 11 | 1.3% | 328/402 | 0.40 | target | high | none |
| 10 | SRW | 27 | 0.9% | 60/175 | 0.44 | target | high | none |
| 10 | 3FR | 11 | 0.8% | 6/403 | 0.40 | target | high | none |

Why this order:

1. DNG first: it is common (262 files), fully specified, carries its own
   matrices and levels (so it needs no camera tables), and its two codings
   for Bayer data (lossless JPEG and uncompressed) are the simplest. It
   also builds everything the other formats share: the TIFF reader, the
   lossless JPEG decoder read from many points at once, and the develop.
2. The rest of DNG (done in Phase 3, below): the phones whose lens
   shading sits in opcode lists (77 corpus files were declined for that
   alone), linear DNG (its develop was already Rust, only its metadata
   came from LibRaw), and Deflate.
3. ARW and CR2: common, documented, Bayer, and both mostly develop, so
   they reach the target on the develop alone. Both need the camera tables
   decision.
4. Then CR3 (documented but the most complex coding), and the formats
   documented only by LGPL or CDDL code (NEF, RW2, RAF, ORF, PEF and the
   medium formats), which wait for the owner's decision on each.

A shorter path to most of the speed, if the owner wants it before the
formats: the develop is most of LibRaw's time on every Bayer format, and
the Rust develop is held to LibRaw's to the bit. Fed LibRaw's own unpacked
mosaic and its own numbers (the shim already reads them: `libraw_facts`,
`libraw_mosaic`), it would take every Bayer format to the develop's gain
at once, with no camera tables and no new decoders, while LibRaw keeps
the parsing and decoding. That keeps the C++ dependency, so it serves the
desktop and not the iOS goal; the formats then come off LibRaw one by one
as above.

## Verification and tolerances

Every format is held to LibRaw's develop of the same file, on every file
of that format in the corpus, at four points:

1. Geometry and metadata: raw size, active area, CFA phase, orientation,
   black level at every site of the pattern, white level, the camera's
   white balance and the develop matrix. Exact: the matrix to the last bit
   of LibRaw's single-precision value.
2. The unpacked mosaic over the active area, before any arithmetic: bit
   for bit.
3. The mosaic after black subtraction, white level and white balance (the
   input to the demosaic), under Clip and Blend: bit for bit.
4. The developed output, full size and half, Clip and Blend.

Tolerance for point 4: bit for bit on Apple's arm64 (macOS and iOS), which
is what the DNG develop achieves on every file it takes. Getting there
meant following LibRaw's float arithmetic as its build computes it: single
precision for the white balance reciprocals, the scale multipliers, the
color matrix inputs and the CIELab cube root table, and the multiply-adds
clang fuses. On other platforms (Windows, Linux x86-64) a last-place float
difference can move a demosaic decision; there the tolerance is at most
0.5% of samples different, a mean absolute difference of at most 0.05
code values and a PSNR of at least 80 dB. Those bounds sit just above the
worst file measured while the float details above were still wrong (0.3%
of samples, PSNR 86 dB), which no one could see side by side: they are
differences of a few code values in isolated pixels where the demosaic's
two directions nearly tie.

Tests: `crates/heeler-raw/tests/rust_decoder.rs` makes DNGs in code
(lossless JPEG tiles and uncompressed strips, every Bayer phase, four
orientations, black patterns with a fraction, a linearization table,
margins even and odd) and holds every develop to LibRaw's to the bit, with
cancellation, memory admission, header sizes and declines; it needs no
corpus. `rust_decoder_corpus.rs` does the same for every corpus DNG the
Rust path takes, and skips when `HEELER_RAW_CORPUS` is unset.

## The fallback design

- A new pure Rust crate, `crates/heeler-rawdec`, with no C or C++ and no
  build script; it builds for `aarch64-apple-ios` as is.
- `heeler-raw` routes to it behind the `rust-decoder` cargo feature, off by
  default: the shipped app is unchanged until the owner turns it on. With
  the feature, `rust_path::set_enabled` switches it at run time (for the
  harnesses).
- The Rust path takes a file only when its rules accept it (format,
  layout, develop choices) and its camera (Make and Model) is on the list
  of cameras verified against LibRaw on the corpus
  (`crates/heeler-rawdec/src/verified.rs`). The corpus test fails if a
  listed camera no longer has a corpus file the path takes.
- Every other file goes to LibRaw exactly as before. So does a file the
  Rust path finds damaged: a decode error is a reason to try LibRaw, not
  an answer. Cancellation and a memory refusal are answers.
- The same entry points answer for both paths: `dimensions`,
  `picture_dimensions`, `develop_bytes` and `demosaic_extra_bytes` give the
  Rust path's numbers for a file it takes, so admission matches what the
  develop allocates (the develop admits `Plan::bytes` itself, and a test
  holds it to running within that budget and failing one byte short).
- The stop flag of `decode_sensor_until` is checked between stages, between
  tiles and between pieces of the code stream.

## Phase 2: DNG, end to end

The first format is DNG's Bayer raw image, in lossless JPEG (tiles or
strips) and uncompressed (8 to 16 bits, packed or whole). It is the
corpus's third most common extension and, alone among the common formats,
carries its own matrices and levels, so it is verified without any camera
table; its compressions are fully specified; and it shows the speedup:
LibRaw decodes its tiles one after another and develops on one thread
outside the demosaic.

### What was built

- `crates/heeler-rawdec`: TIFF directories (`tiff.rs`), the DNG tags a
  develop needs (`dng.rs`), lossless JPEG (`ljpeg.rs`: a table that decodes
  a code and its difference in one lookup; tiles side by side; a one-strip
  frame read from many points at once and put back together in order),
  the color math (`color.rs`), AHD from the published algorithm
  (`ahd.rs`), and the develop (`develop.rs`). DNGs made in code for the
  tests (`synthetic.rs`) and the verified cameras (`verified.rs`).
- `heeler-raw`: the routing (`rust_path.rs`, the `rust-decoder` feature),
  and three read-only views of LibRaw's own state for the harnesses
  (`linear_dng::libraw_facts`, `libraw_black_8x8`, `libraw_mosaic`).

### What LibRaw does with a DNG, as measured

These are LibRaw's readings of a DNG, found by holding the Rust reader to
LibRaw's on the corpus and on DNGs made in code; the Rust path follows
them because it verifies against LibRaw.

- The color matrix is the one calibrated under the higher color
  temperature (D65 over Standard A, D55 over A, daylight over tungsten).
  A diagonal CameraCalibration or AnalogBalance has no effect (the rows
  are normalized away). For some camera-written DNGs (older Canon
  compacts, a few drones and phones) LibRaw develops with matrices of its
  own instead, a few float steps away from the file's; those cameras are
  not on the verified list.
- The camera white balance is the reciprocal of AsShotNeutral, in single
  precision; a file with only AsShotWhiteXY gets no camera white balance.
- Black levels drop their fraction; BlackLevelDeltaH and DeltaV are
  declined (none in the corpus).
- An odd ActiveArea top or left moves in by one, keeping whole 2 by 2
  blocks. Some camera-written files (Pentax, Samsung GX, the Leica SL2)
  have their ActiveArea read differently or not at all; they stay on
  LibRaw.
- The white level drops to the frame's brightest sample after black when
  that lies within a quarter of it (unless the develop asks for fixed
  white).
- At half size an odd last row or column is left out.
- A lossless JPEG tile whose line, times its components, spans the raw
  width is read as two tile rows a line (one writer's layout): such files
  stay on LibRaw.
- Files LibRaw decodes in ways the specification does not (0xFF bytes in
  the coded data without the stuffed zero) are reported damaged by the
  Rust path and go to LibRaw, as do floating-point DNGs.

### Verification results

On the 2020-file corpus: 262 DNGs, 236 with a Bayer raw image. In the
stage-by-stage comparison (`rustdiff`, every DNG the rules then accepted)
95 files matched LibRaw at every stage (the unpacked mosaic, the
white-balanced mosaic, and full and half develops under Clip and Blend) to
the bit, 52 differed for the reasons above, and 2 were reported damaged
(0xFF without the stuffed zero) and went to LibRaw. The verified list
takes the 70 cameras (Make and Model) all of whose files matched. With the
final rules, 148 Bayer DNGs pass the rules: 84, from the verified cameras,
are developed by the Rust path, every one identical to LibRaw's develop
(`rust_decoder_corpus.rs`), and 64 stay on LibRaw because their camera is
not verified. The fixture
tests hold the same on DNGs made in code, including layouts the corpus
lacks.

### Speed

Measured on those 84 files, both decoders in one binary, the median of 5
timed develops each after one untimed, one decoder after the other with
nothing else running.

#### Full size, per format

| Format | Files | LibRaw s | Rust s | Ratio (sums) | Median ratio | LibRaw unpack s | Rust unpack s | LibRaw develop s | Rust develop s | Verdict |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| DNG-Uncompressed-CFA | 47 | 9.56 | 2.54 | 0.27 | 0.25 | 2.80 | 0.07 | 6.75 | 2.47 | target |
| DNG-LJ92-CFA | 37 | 16.34 | 4.18 | 0.26 | 0.25 | 9.00 | 1.24 | 7.34 | 2.94 | target |
| all | 84 | 25.90 | 6.72 | 0.26 | 0.25 | 11.80 | 1.31 | 14.09 | 5.41 | target |

#### Half size, per format

| Format | Files | LibRaw s | Rust s | Ratio (sums) | Median ratio | LibRaw unpack s | Rust unpack s | LibRaw develop s | Rust develop s | Verdict |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| DNG-Uncompressed-CFA | 47 | 4.88 | 0.19 | 0.04 | 0.04 | 2.76 | 0.06 | 2.12 | 0.13 | target |
| DNG-LJ92-CFA | 37 | 11.51 | 1.29 | 0.11 | 0.10 | 9.04 | 1.14 | 2.46 | 0.14 | target |
| all | 84 | 16.39 | 1.48 | 0.09 | 0.06 | 11.80 | 1.20 | 4.59 | 0.27 | target |

#### Per camera

Full-size develops; median ms of each decoder (open and unpack, then develop), and the ratio of the totals, with the half-size ratio beside it.

| Maker folder | Camera | Format | Files | MP | LibRaw ms | LibRaw unpack/develop | Rust ms | Rust unpack/develop | Ratio | Half ratio | Verdict |
|---|---|---|---:|---:|---:|---|---:|---|---:|---:|---|
| Arashi Vision | Insta360 One X | DNG-Uncompressed-CFA | 1 | 18.5 | 167 | 15/152 | 56 | 1/55 | 0.34 | 0.06 | target |
| Autel | Model 323 | DNG-Uncompressed-CFA | 1 | 12.0 | 119 | 10/109 | 38 | 1/38 | 0.32 | 0.07 | target |
| Autel Robotics | XB015 | DNG-Uncompressed-CFA | 1 | 9.0 | 97 | 7/90 | 31 | 1/30 | 0.32 | 0.08 | target |
| Canon | Canon PowerShot A560 | DNG-Uncompressed-CFA | 1 | 7.2 | 109 | 37/72 | 26 | 1/25 | 0.23 | 0.04 | target |
| Canon | EOS 60D | DNG-LJ92-CFA | 1 | 0.5 | 16 | 5/11 | 4 | 2/3 | 0.28 | 0.37 | target |
| Canon | EOS 7D Mark II | DNG-LJ92-CFA | 1 | 20.2 | 391 | 217/175 | 71 | 8/63 | 0.18 | 0.04 | target |
| Canon | PowerShot G1 X | DNG-Uncompressed-CFA | 1 | 14.6 | 220 | 90/130 | 49 | 2/47 | 0.22 | 0.03 | target |
| Canon | PowerShot G7 X | DNG-Uncompressed-CFA | 1 | 20.0 | 285 | 112/172 | 67 | 2/64 | 0.23 | 0.03 | target |
| Canon | PowerShot S100 | DNG-Uncompressed-CFA | 1 | 12.3 | 202 | 71/131 | 43 | 2/41 | 0.21 | 0.03 | target |
| Canon | PowerShot SX50 HS | DNG-Uncompressed-CFA | 1 | 12.8 | 186 | 71/116 | 44 | 2/42 | 0.23 | 0.04 | target |
| Canon | PowerShot SX60 HS | DNG-Uncompressed-CFA | 1 | 16.3 | 234 | 90/144 | 56 | 2/54 | 0.24 | 0.03 | target |
| Canon | PowerShot SX710 HS | DNG-Uncompressed-CFA | 1 | 20.6 | 291 | 117/175 | 71 | 3/69 | 0.24 | 0.03 | target |
| DJI | FC350 | DNG-Uncompressed-CFA | 1 | 9.0 | 97 | 7/90 | 31 | 0/31 | 0.32 | 0.07 | target |
| DJI | FC4382 | DNG-LJ92-CFA | 1 | 12.2 | 227 | 117/109 | 87 | 49/38 | 0.38 | 0.34 | target |
| DJI | FC9287 | DNG-LJ92-CFA | 1 | 37.8 | 732 | 423/308 | 274 | 162/112 | 0.37 | 0.30 | target |
| Eyedeas | E1 | DNG-Uncompressed-CFA | 1 | 16.1 | 202 | 13/189 | 51 | 1/50 | 0.25 | 0.07 | target |
| KanDao | QooCam | DNG-LJ92-CFA | 1 | 9.3 | 198 | 103/94 | 34 | 4/30 | 0.17 | 0.04 | target |
| KanDao | QooCam | DNG-Uncompressed-CFA | 2 | 9.3 | 102 | 8/95 | 31 | 0/30 | 0.30 | 0.06 | target |
| KanDao | QooCam 8K | DNG-Uncompressed-CFA | 1 | 29.5 | 262 | 24/238 | 95 | 1/94 | 0.36 | 0.06 | target |
| LG | D855 | DNG-Uncompressed-CFA | 1 | 13.0 | 127 | 11/117 | 44 | 1/43 | 0.34 | 0.07 | target |
| LG | H815 | DNG-Uncompressed-CFA | 1 | 15.9 | 223 | 78/144 | 52 | 2/50 | 0.23 | 0.03 | target |
| LG | LG-F800K | DNG-Uncompressed-CFA | 1 | 16.3 | 223 | 81/142 | 55 | 2/53 | 0.25 | 0.03 | target |
| LG | LG-H870 | DNG-Uncompressed-CFA | 1 | 13.0 | 182 | 64/117 | 45 | 1/44 | 0.25 | 0.03 | target |
| LG | VS995 | DNG-Uncompressed-CFA | 1 | 16.3 | 222 | 80/142 | 54 | 2/52 | 0.24 | 0.03 | target |
| Leica | CL | DNG-Uncompressed-CFA | 1 | 24.2 | 350 | 146/204 | 83 | 3/80 | 0.24 | 0.03 | target |
| Leica | M (Typ 240) | DNG-LJ92-CFA | 1 | 23.9 | 460 | 257/204 | 113 | 37/77 | 0.25 | 0.12 | target |
| Leica | M (Typ 240) | DNG-Uncompressed-CFA | 1 | 23.9 | 223 | 20/203 | 80 | 1/79 | 0.36 | 0.05 | target |
| Leica | M10 | DNG-LJ92-CFA | 1 | 23.9 | 469 | 266/202 | 109 | 33/76 | 0.23 | 0.10 | target |
| Leica | M8 | DNG-Uncompressed-CFA | 1 | 10.3 | 143 | 45/98 | 36 | 1/35 | 0.25 | 0.03 | target |
| Leica | M9 | DNG-Uncompressed-CFA | 1 | 18.1 | 237 | 78/159 | 62 | 1/60 | 0.26 | 0.03 | target |
| Leica | M9 Digital Camera | DNG-Uncompressed-CFA | 1 | 18.1 | 173 | 15/158 | 61 | 1/60 | 0.35 | 0.06 | target |
| Leica | Q (Typ 116) | DNG-Uncompressed-CFA | 1 | 24.2 | 348 | 144/204 | 85 | 3/81 | 0.24 | 0.03 | target |
| Leica | Q2 | DNG-Uncompressed-CFA | 1 | 47.3 | 652 | 278/375 | 161 | 6/155 | 0.25 | 0.03 | target |
| Leica | SL (Typ 601) | DNG-Uncompressed-CFA | 1 | 24.2 | 348 | 144/203 | 84 | 3/81 | 0.24 | 0.03 | target |
| Leica | X2 | DNG-Uncompressed-CFA | 1 | 16.2 | 231 | 88/143 | 56 | 2/54 | 0.24 | 0.03 | target |
| Leica Camera AG | LEICA M10-R | DNG-LJ92-CFA | 1 | 41.0 | 767 | 441/328 | 200 | 58/143 | 0.26 | 0.11 | target |
| Nikon | D80 | DNG-LJ92-CFA | 1 | 10.2 | 202 | 106/97 | 39 | 4/35 | 0.19 | 0.04 | target |
| OnePlus | ONEPLUS A3003 | DNG-Uncompressed-CFA | 1 | 16.3 | 155 | 13/142 | 57 | 1/56 | 0.36 | 0.05 | target |
| OnePlus | ONEPLUS A5000 | DNG-Uncompressed-CFA | 1 | 16.3 | 155 | 13/142 | 56 | 1/55 | 0.36 | 0.05 | target |
| OnePlus | ONEPLUS A6003 | DNG-Uncompressed-CFA | 1 | 16.3 | 155 | 13/142 | 58 | 1/57 | 0.37 | 0.06 | target |
| Panasonic | DMC-LX1 | DNG-LJ92-CFA | 1 | 8.4 | 171 | 87/85 | 33 | 4/29 | 0.19 | 0.04 | target |
| Parrot | Bebop 2 | DNG-Uncompressed-CFA | 1 | 13.6 | 201 | 11/190 | 48 | 1/47 | 0.24 | 0.05 | target |
| Parrot | Bebop Drone | DNG-Uncompressed-CFA | 1 | 13.6 | 203 | 11/191 | 49 | 1/48 | 0.24 | 0.05 | target |
| Pentax | 645Z | DNG-LJ92-CFA | 1 | 51.3 | 950 | 544/405 | 257 | 73/184 | 0.27 | 0.11 | target |
| Pentax | K-01 | DNG-LJ92-CFA | 1 | 16.1 | 315 | 173/142 | 72 | 20/53 | 0.23 | 0.09 | target |
| Pentax | K-1 | DNG-LJ92-CFA | 2 | 36.4 | 653 | 358/294 | 176 | 47/129 | 0.27 | 0.10 | target |
| Pentax | K-1 Mark II | DNG-LJ92-CFA | 6 | 32.9 | 594 | 326/268 | 160 | 44/116 | 0.27 | 0.11 | target |
| Pentax | K-3 | DNG-LJ92-CFA | 1 | 24.3 | 448 | 244/203 | 111 | 31/80 | 0.25 | 0.10 | target |
| Pentax | K-3 II | DNG-LJ92-CFA | 2 | 24.3 | 471 | 266/204 | 120 | 38/82 | 0.25 | 0.12 | target |
| Pentax | K-3 Mark III | DNG-LJ92-CFA | 1 | 25.9 | 466 | 248/217 | 119 | 33/86 | 0.26 | 0.10 | target |
| Pentax | K-30 | DNG-LJ92-CFA | 1 | 16.1 | 307 | 165/142 | 69 | 18/52 | 0.22 | 0.09 | target |
| Pentax | K-50 | DNG-LJ92-CFA | 1 | 16.1 | 305 | 162/143 | 69 | 17/53 | 0.23 | 0.08 | target |
| Pentax | K-500 | DNG-LJ92-CFA | 1 | 16.1 | 309 | 167/143 | 69 | 18/51 | 0.22 | 0.08 | target |
| Pentax | K-70 | DNG-LJ92-CFA | 2 | 24.2 | 440 | 236/204 | 109 | 30/79 | 0.25 | 0.10 | target |
| Pentax | K-S1 | DNG-LJ92-CFA | 1 | 20.1 | 369 | 195/174 | 87 | 22/66 | 0.24 | 0.09 | target |
| Pentax | K-S2 | DNG-LJ92-CFA | 1 | 20.1 | 367 | 192/175 | 89 | 23/66 | 0.24 | 0.10 | target |
| Pentax | KP | DNG-LJ92-CFA | 1 | 24.3 | 455 | 251/205 | 112 | 33/79 | 0.25 | 0.11 | target |
| Pentax | MX-1 | DNG-Uncompressed-CFA | 1 | 12.1 | 176 | 66/110 | 44 | 2/42 | 0.25 | 0.04 | target |
| Pentax | Q | DNG-Uncompressed-CFA | 1 | 12.0 | 176 | 67/109 | 43 | 2/41 | 0.24 | 0.03 | target |
| Pentax | Q7 | DNG-Uncompressed-CFA | 1 | 12.0 | 177 | 67/110 | 43 | 2/41 | 0.24 | 0.03 | target |
| RaspberryPi | RP_imx477 | DNG-Uncompressed-CFA | 3 | 12.3 | 180 | 67/113 | 45 | 2/43 | 0.25 | 0.04 | target |
| Ricoh | GR | DNG-LJ92-CFA | 1 | 16.2 | 307 | 164/143 | 69 | 16/53 | 0.22 | 0.08 | target |
| Ricoh | GR DIGITAL 2 | DNG-Uncompressed-CFA | 1 | 10.0 | 148 | 54/94 | 37 | 1/35 | 0.25 | 0.04 | target |
| Ricoh | GR II | DNG-LJ92-CFA | 1 | 10.4 | 271 | 172/99 | 53 | 20/34 | 0.19 | 0.10 | target |
| Ricoh | GR III | DNG-LJ92-CFA | 1 | 24.2 | 463 | 257/205 | 112 | 34/80 | 0.24 | 0.11 | target |
| Ricoh | GR IIIx | DNG-LJ92-CFA | 1 | 24.2 | 445 | 240/205 | 111 | 32/79 | 0.25 | 0.11 | target |
| Ricoh | GXR | DNG-Uncompressed-CFA | 1 | 10.1 | 164 | 56/107 | 37 | 1/35 | 0.22 | 0.03 | target |
| Xiaomi | HM NOTE 1LTE | DNG-Uncompressed-CFA | 1 | 13.1 | 185 | 66/119 | 48 | 2/45 | 0.26 | 0.05 | target |
| Xiaomi | MI MAX | DNG-Uncompressed-CFA | 1 | 16.4 | 227 | 84/143 | 58 | 2/56 | 0.26 | 0.04 | target |
| YI TECHNOLOGY | M1 | DNG-Uncompressed-CFA | 1 | 20.3 | 285 | 112/173 | 70 | 2/68 | 0.25 | 0.03 | target |
| Yuneec | CGO3 | DNG-LJ92-CFA | 1 | 12.0 | 234 | 125/109 | 46 | 5/41 | 0.19 | 0.04 | target |
| Yuneec | CGO3P | DNG-Uncompressed-CFA | 1 | 12.0 | 119 | 10/109 | 42 | 1/41 | 0.35 | 0.06 | target |
| asus | ASUS_Z01KD | DNG-Uncompressed-CFA | 1 | 11.5 | 137 | 9/128 | 40 | 1/40 | 0.30 | 0.06 | target |

Every verified camera reaches the target: full-size ratios from 0.18 to
0.38, half size from 0.03 to 0.37 (the 0.5 MP file, where fixed costs
dominate). Where the time went, from the stage split: the unpack is a
tenth of LibRaw's (tiles side by side, and one-strip frames read from many
points at once: a 24 MP strip from 90 ms to 31 ms), and the develop is two
fifths (one pass a stage, every stage across the cores, no four-channel
copy, no histogram, no second copy out). At half size LibRaw still
unpacks and copies the full frame and scales it on one thread; the Rust
develop bins 2 by 2 blocks straight from the mosaic.

### Not yet done

Phase 3 below takes up these: Windows and Linux, the unverified cameras,
the lens shading opcodes, and the linear DNG path.

## Phase 3: the rest of DNG, and the DNG color model

### What was built

- The develop's color is the DNG specification's model (chapter 6, as
  `color::camera_to_xyz_d50` implements it) for each shot's white: the
  profile's two calibrations weighted by that white's color temperature,
  through the ForwardMatrix, else the ColorMatrix with a Bradford
  adaptation, then to sRGB with each row normalized so the shot's white
  stays white (`color::srgb_from_balanced`, `develop::develop_matrix`).
  Two guards: a profile with hue and saturation or look tables is taken
  through its ColorMatrix (such a ForwardMatrix can leave most of the
  color to the tables, which are not applied yet), and so is a profile
  whose ForwardMatrix develops the 24 ColorChecker Classic patches more
  than 5 CIEDE2000 (mean) from its own ColorMatrix (`FORWARD_AGREEMENT`):
  the hand-made profiles of some compacts and phones, whose ForwardMatrix
  does not describe the camera. A non-diagonal CameraCalibration, which
  LibRaw's reading could not take, is part of the model and accepted.
- Lens shading: the GainMap and FixVignetteRadial opcode code moved from
  heeler-raw to `heeler-rawdec::gain_map` (heeler-raw still applies it
  around LibRaw's develop), its CFA pass across the cores, and a per-pixel
  form (`PixelGains`) the develop applies between the highlights and the
  matrix, where heeler-raw applies it around LibRaw. heeler-rawdec is now
  an ordinary dependency of heeler-raw; the `rust-decoder` feature still
  decides the routing alone.
- Floating-point DNGs (HDR merges): Deflate (`deflate.rs`, the
  floating-point predictor 3, 34894 and 34895, from the TIFF technical
  note and the DNG specification; inflating with `miniz_oxide`) and
  uncompressed, 16, 24 and 32 bits. A sample's whole part is LibRaw's
  integer while the frame's brightest lies in 4096 to 32767, the defaults
  LibRaw documents for its float conversion; outside that LibRaw
  rescales, and such a file goes to LibRaw.
- Linear DNGs: heeler-raw's linear module (heeler-io's banded loader) now
  reads its facts from the file in Rust with the feature
  (`linear_dng::rust_facts`, every field LibRaw reads, checked against
  LibRaw's on the corpus) and decodes its pieces with heeler-rawdec, so it
  no longer opens the file in LibRaw. It now also takes strips and
  uncompressed pieces: the Samsung phones (one strip with a restart
  marker every line, decoded interval by interval across the cores,
  `ljpeg::decode_intervals`, which single-strip Bayer DNGs use too) and
  three-sample uncompressed files.
- `fmadd`: every multiply-add the develop shares with LibRaw's arithmetic
  goes through one helper, fused on aarch64 (where clang contracts them)
  and not elsewhere, with an `unfused` feature to check the other case on
  an aarch64 machine.

### What LibRaw does, measured further

- With one ColorMatrix in the file, LibRaw uses its values as they are;
  with two or more, rounded to single precision (every corpus DNG but
  one, a drone's, follows this). It matters only to the comparisons:
  the shipped develop uses the DNG model.
- For some cameras LibRaw develops with matrices of its own a few float
  steps from the file's. The corpus comparison now gives LibRaw's matrix
  to both develops (`develop::develop_with`), so it holds the decode and
  develop to LibRaw and not where the color comes from, which is the
  model's and is tested on its own. That alone lets several cameras
  join the verified list.
- At half size the stage 3 opcodes are read over the half-size image's
  own size (whole 2 by 2 blocks).

### Verification

- `rustdiff --any` over every DNG the rules accept: 213 matched LibRaw at
  every stage, 14 did not (the Pentax, Samsung GX and Ricoh GX200
  ActiveArea readings and the Leica SL2 crop of Phase 2), and 3 were
  reported damaged (and go to LibRaw). The verified list
  (`verified.rs`) is the 173 cameras all of whose files matched, the 70
  of Phase 2 among them. `rust_decoder_corpus.rs` holds 204 corpus DNGs
  from those cameras to LibRaw to the bit, lens shading files and float
  files included.
- The linear module, its facts read in Rust: the 13 corpus linear DNGs it
  takes develop as LibRaw does, to the bit, under Clip and Blend
  (`rust_decoder_corpus.rs`). The single-sample (monochrome) and scanner
  files and those with a crop stay on LibRaw; the JPEG XL one is
  heeler-io's, as before.
- Synthetic files for each new case: lens shading in both lists, every
  orientation, odd sizes (`rust_decoder.rs`); Deflate and float
  conversions, restart intervals (heeler-rawdec's own tests).

### Windows and Linux

No x86-64 machine, emulator or cross target was at hand, so the platform
difference that matters was reproduced here: x86-64 builds of LibRaw (and
MSVC's) do not fuse multiply-adds, as clang does on aarch64. LibRaw built
with `-ffp-contract=off` and the Rust develop with `heeler-rawdec/unfused`
agree to the bit on every synthetic test and on all 204 corpus DNGs; the
fused Rust develop against that LibRaw fails, so the flag took. The
unfused helper also keeps x86-64 from calling a software fused
multiply-add. Not covered: GCC on aarch64 Linux, which contracts more
widely than clang (expect differences of a level or two, within the
tolerance above), and an actual build and run on Windows and Linux.

### Color

The DNG model against LibRaw's daylight matrix on the 204 files the Rust
path takes, as the 24 Classic patches move (`colorcheck shift`, mean
CIEDE2000 a file): median 0.73, 90th percentile 2.51; 13 files move more
than 3. The largest are what the model is for (tungsten whites, 2300 to
3900 K) or profiles whose two calibrations disagree (a phone at 20.8,
the two drones at 6 to 8). The Xiaomi file was looked at side by side:
LibRaw's rendering is gray-green, the model's has natural grass and the
flowers' color. 138 files go through the ColorMatrix, 66 through the
ForwardMatrix.

### Speed

The 204 verified files, both decoders in one binary, the median of 5
timed develops each, with the DNG model and lens shading in the Rust
develop (LibRaw's side includes heeler-raw's gain maps). CSVs in
`docs/rust-raw-decoder/dng3-*.csv`.

| Size | Format | Files | LibRaw s | Rust s | Ratio | LibRaw unpack s | Rust unpack s | LibRaw develop s | Rust develop s |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Full | DNG-Uncompressed-CFA | 148 | 25.62 | 7.29 | 0.28 | 6.27 | 0.19 | 19.34 | 7.09 |
| Full | DNG-LJ92-CFA | 53 | 21.35 | 4.98 | 0.23 | 11.73 | 1.32 | 9.62 | 3.65 |
| Full | DNG-Deflate-CFA | 3 | 1.49 | 0.29 | 0.19 | 0.91 | 0.07 | 0.58 | 0.22 |
| Full | all | 204 | 48.46 | 12.56 | 0.26 | 18.91 | 1.58 | 29.54 | 10.96 |
| Half | DNG-Uncompressed-CFA | 148 | 12.44 | 0.73 | 0.06 | 6.28 | 0.17 | 6.16 | 0.56 |
| Half | DNG-LJ92-CFA | 53 | 14.89 | 1.48 | 0.10 | 11.67 | 1.24 | 3.22 | 0.24 |
| Half | DNG-Deflate-CFA | 3 | 1.12 | 0.08 | 0.07 | 0.93 | 0.07 | 0.19 | 0.01 |
| Half | all | 204 | 28.45 | 2.29 | 0.08 | 18.88 | 1.48 | 9.57 | 0.81 |

Every camera is under the 0.50 target; the slowest at full size is 0.41
(a medium-format drone camera), at half size 0.38 (a 60D file of a few
kilobytes). The linear module, its rows whole against LibRaw's develop
(`LinearDng` with its Rust facts): the Samsung phones at 0.27 to 0.37 of
LibRaw's time (one strip, now read across the cores), the tiled files at
0.08 to 0.11, the uncompressed ones at 0.25 to 1.0 (the small ones gain
least: the module reads a frame twice, once for its brightest sample and
once for the rows).

### Not yet done

- The profile's hue and saturation tables and look table (the model
  stops at the matrices), and a third calibration (DNG 1.6).
- DNGs that stay on LibRaw develop with LibRaw's color, so a camera off
  the verified list does not yet get the model.
- The Pentax, Samsung GX, Ricoh GX200 and Leica SL2 readings of the
  active area; files with AsShotWhiteXY and no AsShotNeutral; monochrome
  and scanner linear DNGs; lossy JPEG DNGs.
- An actual build and run on Windows and Linux.

## Phase 4: CR2 and ARW

### The owner's decisions it rests on

- Color: the calibration table (two calibrations a camera, 2026-10-20)
  through the DNG model, for every camera.
- Geometry (2026-10-20): the image area (LibRaw's margins and size within
  the raw frame), the CFA colors at its corner and the white level come
  from LibRaw's own reading of each camera, kept in a table
  (`heeler-rawdec/src/geometry.rs`, generated by heeler-raw's
  `examples/geometry.rs` from the corpus). A document stores its crop,
  strokes and masks as fractions of the image, so an image a few pixels
  smaller would shift every edit (up to about 18 px at the edges on a
  5D Mark III); LibRaw's area keeps them in place. The files' own crop
  tags describe the camera's JPEG, smaller on every camera (5760 by 3840
  against LibRaw's 5796 by 3870 on the 5D Mark III); a converter's
  ActiveArea matched LibRaw's on the Canon tried and not on the Sony
  (6048 against LibRaw's 6024 columns).

### What was built

- `canon.rs`: CR2 from its published description and Canon's documented
  tag tables. IFD0's chain, its fourth directory the raw frame: one
  lossless JPEG strip, filled in vertical slices where tag 0xC640 says so
  (the slices also set the frame's width: a 4-component JPEG line can
  cover two of its rows, as on the 5D Mark IV and 6D Mark II). The white
  balance as shot from ColorData (0x4001 in the maker notes, read as
  16-bit words whether stored as words or bytes) at word 25 of the
  582-word block, 34 of the 653-word block, 71 of the mirrorless and
  compact bodies' 2560-word block, and 63 of every other (each checked
  against the corpus). The black level: those 2560-word blocks state it
  (version -3 at word 264, -4 at 333); every other body's is measured on
  the frame's masked border, the rounded mean of each pattern site over
  the columns left of the image area, two in from either side, over the
  area's rows. On every corpus CR2 that lands within 2 levels of
  LibRaw's (its region differs by camera). sRAW and mRAW (subsampled
  YCbCr) are declined.
- `sony.rs`: ARW, uncompressed (14 bits in 16-bit words) and Sony's
  compressed coding. Each row is 16-byte blocks, each block 16 pixels of
  one color every second column, the two colors' blocks alternating along
  32 columns: an 11-bit maximum and minimum, their 4-bit places, 14 7-bit
  steps above the minimum scaled by the fewest doublings that span the
  range. The 11-bit values go through the tone curve (tag 0x7010): found
  from the data against LibRaw's mosaic, it is twice the value, then
  linear with slope 1, 2, 4, 8 and 16 between knots at a quarter of the
  tag's four values, running on past the white level. The white balance,
  black and white level are the raw directory's own tags (0x7313, 0x7310,
  0xC61D).
- The develop scales the green on blue's row by its own multiplier (a
  CR2's second green can differ from the first); `Dng::open` reads any of
  the three formats into the same terms; the verified list is keyed by
  format.
- The comparisons give the Rust develop LibRaw's matrix, white balance,
  black and white level (`heeler_raw::with_libraw_numbers`), so they hold
  the decode and develop to LibRaw's, not where those numbers come from.
  LibRaw reads no white balance from a few CR2s that state one (a 5D
  Mark IV and a 6D file develop with unity multipliers, green); the Rust
  path takes the file's.

### Verification

- `rustdiff --any` over every CR2 and ARW: 187 matched LibRaw at every
  stage, and one did not (the 1D Mark III, whose frame LibRaw places two
  columns over). 104 CR2s from 99 cameras and 82 ARWs from 36 cameras
  join the verified list; the corpus test now holds 391 files from 308
  cameras (DNG, CR2, ARW) to LibRaw to the bit.
- A CR2 made in code, in slices (`synthetic::cr2`, an EOS 20D's frame):
  put back in place, LibRaw's mosaic, and its develops, full and half,
  Clip and Blend; and the shipped develop at LibRaw's size.
- Declined and left to LibRaw: Sony's lossless and "compressed RAW 2"
  codings (31 files), ARWs that keep their levels only in the enciphered
  SR2 block (70, older bodies), sRAW and mRAW CR2s (31), and a few files
  without a camera's geometry, calibrations or maker notes.

### Color

As the 24 Classic patches move from LibRaw's develop (`colorcheck shift`
with LibRaw's own matrix): CR2 median 0.70, 90th percentile 1.44,
largest 3.42 (an M2 under tungsten); ARW median 0.56, 90th percentile
1.30, largest 4.48 (the newest Sony body, in daylight, where LibRaw's
matrix and the calibration table disagree).

### Speed

The 187 files, both decoders in one binary, the median of 5 timed
develops each. CSVs in `docs/rust-raw-decoder/cr2-arw-*.csv`.

| Size | Format | Files | LibRaw s | Rust s | Ratio | LibRaw unpack s | Rust unpack s | LibRaw develop s | Rust develop s |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Full | ARW | 82 | 25.26 | 8.78 | 0.35 | 3.40 | 0.30 | 21.85 | 8.48 |
| Full | CR2 | 105 | 38.64 | 9.01 | 0.23 | 21.74 | 3.05 | 16.87 | 5.94 |
| Half | ARW | 82 | 10.81 | 0.77 | 0.07 | 3.34 | 0.28 | 7.47 | 0.48 |
| Half | CR2 | 105 | 26.50 | 3.29 | 0.12 | 21.07 | 2.92 | 5.43 | 0.36 |

Every camera is under the 0.50 target, the slowest at 0.37 (full size,
the 61-megapixel Sony bodies; the slowest CR2 is at 0.26). A CR2's strip
is one lossless JPEG stream with a Huffman table for each of its two
components; the speculative parallel decode reads each piece once for
each place in the tables' cycle (a reader that starts mid-stream cannot
know which component its first code belongs to) and keeps a reading
only from a code boundary where both the bit and the place agree with
the true reading. That halved a CR2's unpack (21.7 s for LibRaw, 7.1 s
on one core, 3.1 s across the cores; CR2 rows as measured after it, in
`docs/rust-raw-decoder/cr2-rust-parallel-*.csv`).

### Not yet done

- Sony's lossless coding and the older bodies: done in Phase 4b, below.
- sRAW and mRAW.

## Phase 4b: the rest of Sony, and LibRaw's known faults

### The owner's decisions (2026-10-20)

- Sony's lossless coding: its layout may be found from the data against
  LibRaw's reading.
- The SR2 block's cipher, described only in code: it may be learned from
  a widely used metadata reader's source (Artistic or GPL licensed) and
  written again in Heeler's own terms, verified against LibRaw. No
  decoder's code is read.
- "Compressed RAW 2" (the A7 V's and A7R VI's lossy coding) and ARW1 (the
  DSLR-A100's): find what is publicly described first.

### What was built

- Sony lossless (`Coding::SonyTiles`): TIFF tiles of 512 by 512, each an
  ITU-T T.81 lossless JPEG of 256 by 256 pixels with four components (one
  table, predictor 1); a JPEG pixel's components are one 2 by 2 block of
  the tile in reading order, the first two on its upper row. Found by
  trying the 24 orders against LibRaw's mosaic; all 16,384 samples tried
  agreed with the first. Where the frame states no white level the
  camera's comes from geometry.rs. The medium and small lossless sizes
  are not Bayer and stay on LibRaw.
- The SR2 block: IFD0's DNGPrivateData holds (in four bytes) the offset of
  the SR2Private directory, which gives the enciphered block's offset,
  length and 32-bit key (also four bytes). The keystream: four steps of
  the linear congruential generator x -> x * 0x02E90EDD + 1 from the key,
  extended to a ring of 127 words by shifted exclusive ors, then each
  stream word the exclusive or of the ring's words 1 and 65 ahead,
  replacing the oldest; it is applied to the block as big-endian 32-bit
  words. The block is then an IFD with the older bodies' black level,
  white balance and (unused) white level; their white level comes from
  geometry.rs. Black stated for 12-bit uncompressed data is in 14-bit
  units, a quarter of it used.
- 12-bit uncompressed (the A850 and A900, marked 32767 in the files): two
  samples in three bytes, least significant bits first
  (`Coding::PackedLow`).

### Verification

- Every ARW of the corpus: 168 match LibRaw at every stage (82 before),
  from 95 cameras (36 before): the lossless files of the current bodies,
  and the A7, A7 II, A7R II, A7S, A6000 to A6500, NEX, SLT, A-mount and
  RX bodies through the SR2 block. The corpus test now holds 477 files
  from 367 cameras to LibRaw to the bit.
- Declined: the A200 to A390's coding (8 files; variable length, not
  ARW2's blocks, and described only by code), "Compressed RAW 2" (4),
  ARW1 (1), files from 5 bodies the calibration table lacks, and the
  non-Bayer sizes (20).
- Speed over the 168: 0.33 of LibRaw's time at full size (the slowest
  camera 0.40, the A7R III), 0.06 at half size. CSVs in
  `docs/rust-raw-decoder/arw-*.csv`.

### What is publicly described of Sony's other codings

- "Compressed RAW 2" (compression 32766): no prose description of the
  bitstream. A Sony patent (WO2024043054A1) describes a lossy RAW mode
  with a wavelet transform on Bayer data and per-band quantization, with
  no filter, tables, entropy code or layout. SMPTE RDD 34 (LLVC, a Sony
  line-based wavelet codec; free to read) is a plausible relative, but no
  public source ties it to these files. Building a decoder would be
  reverse engineering against sample files; it stays on LibRaw.
- ARW1 and the A200 to A390's coding: no prose, patent or standard found;
  the only detailed descriptions are other decoders' code. They stay on
  LibRaw.

### LibRaw's known faults, against the Rust path

Verifying against LibRaw risks copying its mistakes. Its issue tracker
(659 issues, the 384 touching these formats or the develop) was read for
wrong results on DNG, CR2 and ARW:

- A CR2 whose IFD0 orientation tag is invalid (some EOS 40D firmware
  writes 0): LibRaw reads the camera's way up from the maker notes, laid
  out model by model; the Rust path read 0 and would have shown the
  photograph sideways. Such files are now declined and stay LibRaw's
  (CR2 and ARW alike), with a test. The corpus had no such file; the
  issue's sample did.
- Sony white levels above 16383 for the A500 to A580 (an issue says the
  true clip is 16383): their clipped highlights reach exactly 16596, the
  level LibRaw uses, so the level is right for them.
- Sony crop-mode areas LibRaw guessed for several full-frame bodies: of
  those, only the 7S's crop mode is in geometry.rs, and its area ends
  inside real data (the columns after LibRaw's full-frame area are
  repeated padding, its crop area stops eight real columns short).
- Not carried over by design, and possible later improvements in the
  app rather than the decoder: the camera's own aspect crop (Sony) and a
  DNG's DefaultCrop are not applied (LibRaw's area is the image; a
  document could start with them as its crop).
- A camera LibRaw does not know (the A7R VI, issue 828): it develops the
  whole 10240 by 7168 tile frame, padding included, with a fallback
  matrix, where the file states a 9984 by 6656 image at (12, 8). The Rust
  path declines it (no geometry and no calibration yet) rather than copy
  that.
- A 32-bit float DNG reported as rendering wrongly: its shared sample had
  its picture blacked out, so the claim could not be checked; its white
  level is a normalized 1.0, which the Rust path declines.
- Crashes, memory-safety reports and fuzzing finds (about 260) concern
  LibRaw's code, not its results.

### Second corpus

A second public archive of sample raw files (CC0, 807 camera models,
about 120 GB) is mirrored to the sample storage, each file checked against its SHA-256;
the issue samples above are kept beside it. Its CR2, ARW and DNG files
(337 CR2 and ARW, 88 DNG), with the first corpus's, went through
`rustdiff --any`:

- 760 files matched LibRaw at every stage. The 22 that did not are the
  known ones: the Pentax, Samsung GX and Ricoh GX200 ActiveArea readings,
  the Leica SL2 crop and the 1D Mark III (none on the verified list),
  and three damaged files that stay LibRaw's.
- The 6D Mark II's CR2 states no slices before the last (0, 6384, 6384)
  and codes four components, a JPEG line two frame rows: the reader took
  only slice counts above zero, so its files went to LibRaw. A count of
  zero with a slice width is now one slice the frame's width; a count of
  zero and no width (the PowerShot G16's and S120's 0, 0, 4176, the last
  narrower than a JPEG line) still means the JPEG's own frame. A test
  holds both (`synthetic::cr2`).
- LibRaw takes in the tile frame's padding for five Sony bodies it does
  not know, as for the A7R VI above: the A1 II (8704 by 6144 developed
  where the file states 8664 by 5784 of sensor data, tag 0x7038), the
  A7 V, the RX1R III and the RX10 V. geometry.rs (`examples/geometry`,
  which now takes further folders after its output) leaves out any
  camera whose LibRaw area is larger than the data a file states. The
  A1 II had matched LibRaw, padding and all.
- The owner decided (2026-10-20) that those cameras take the size the
  file states, though documents made before move. heeler-raw's open of
  a file (`open_buffer`) now keeps LibRaw's image area to the sensor data
  a Sony file states (0x7038, from the frame's top left) wherever
  LibRaw's is larger, so LibRaw's develop and the table agree: the
  columns past it were measured as zeros (the A1 II's 8672 to 8704, the
  A7 V's 7040 to 7168), the few between the stated width and the zeros
  repeat the edge. Untiled files of those cameras (uncompressed, lossy)
  state no such size and hold no padding. With the table rebuilt from
  the trimmed areas, all 335 ARWs the Rust path takes match LibRaw, and
  the A1 II is back on the verified list; the A7 V, A7R VI, RX1R III and
  RX10 V wait for calibrations.
- New on the verified list: the 6D Mark II (CR2) and the DJI FC3582
  (DNG): 369 entries. The corpus test reads both
  corpora when HEELER_RAW_CORPUS names both folders (separated as PATH's
  are): 773 files from 368 cameras, to the bit.
- Declined as expected: Sony's Medium and Small raw (not a CFA frame,
  42), sRAW and mRAW (62), the A100 and A200 to A390 codings and
  Compressed RAW 2 (32), and the cameras without a calibration yet.

## Phase 5: CR3, lossless and C-RAW

### What was built

- `cr3.rs` reads the container (ISO/IEC 14496-12, brand "crx "): Canon's
  box in moov for IFD0 (CMT1), the third track's sample entry (CRAW) for
  the codec's image header (CMP1: frame and tile sizes, bit depth,
  planes, wavelet levels), the track's one sample for the tile, plane
  and subband records and the planes' data, and the metadata track's
  records (CTMD, type 8) for the maker notes' ColorData. The white
  balance as shot and the black level per channel are ColorData's, at
  places by its version (16 to 19: words 71 and 329; 32 and 33: 85 and
  343; 34 and 48: 105 and 363; 64 to 66: 105 and 383). The image area,
  CFA colors and white level come from geometry.rs as for CR2 (the
  table's builder now reads CR3 too), the color from the calibration
  table, where a camera's other market name (the Rebel T8i for the 850D)
  takes the same row.
- `crx.rs` decodes the lossless coding. The format's description and
  Canon's patent (US 2016/0323602 A1) give the outline, close to JPEG-LS
  (ITU-T T.87): median edge detection, a symbol per error coded
  Golomb-Rice with an adaptive parameter, a run mode. Every detail they
  leave open was found from the data against LibRaw's unpacked frame
  (`examples/rawframe`), one rule at a time, each checked on whole planes:
  - the escape: 41 zeros, then the symbol in 21 bits;
  - K's update: from the symbol, or from the average of the symbol and
    twice the difference of the samples above and above right (the
    patent's estimate of the next symbol, unsigned), up 2 for a quotient
    of 6 or more, up 1 for 3 or more, down 1 below half a step; the
    symbol alone on the first line and at a line's end;
  - the run context: left, above and above right equal (above left
    plays no part);
  - the run: a flag bit (0 an empty run, the run index untouched; 1 one
    sample at least), then the rest as T.87 codes a run, with T.87's
    table, the index falling by 1 when a run is cut short and not at a
    line's end;
  - the sample that ends a run: predicted by the left neighbor, or by
    the one above where the two differ;
  - the first line: the samples above it (and left of its start) are
    half the range, which also makes a plane's first sample an empty run
    predicted by half the range.
  Each tile's four planes (one site of the 2 by 2 pattern each) decode
  side by side. A test codes planes the other way round (runs that end
  inside a line, at its end and across many blocks, escapes, flat
  first lines) and decodes them.
- C-RAW of the header's first version (14 bodies: the 250D, 850D, 90D,
  M200, M50, M50 Mark II, M6 Mark II, R, R100, RP and the G5 X Mark II,
  G7 X Mark III and SX70 HS) is read too. The patent gives the outline: a
  reversible 5/3 wavelet (ITU-T T.800's lifting), three levels, each
  subband coded with the lossless coding's tools. The details were found
  from the data against the forward transform of LibRaw's unpacked frame,
  band by band:
  - the transform runs down the columns first, then along the rows; the
    subbands are stored coarsest first (LL3, then HL, LH and HH of levels
    3, 2 and 1);
  - LL3 is a lossless plane of the frame's depth, as above;
  - the other subbands: no prediction, the lines above the first and
    past the band's edges 0; a run where the left, above and above right
    coefficients are 0, never starting in a line's last column; the
    coefficient that ends a run predicted by the left one and mapped
    without 0; K from the symbol alone, then raised by 1 where a line's
    ring of K (each column's K once coded, 0 for a run's coefficients)
    holds one more than K + 1 a column ahead, below the first line and
    before the last column;
  - each subband's coefficients times its quantizer's step (the
    quantizer, bits 19 to 26 of the record's second word, q, giving
    2^((q - 4) / 6) rounded down; the files use 4, 16, 22, 26 and 32);
  - frames of two tiles transform each tile on its own: a tile's bands
    reach past its edge into its neighbor's, as many columns at each
    level as the tile's rebuild needs, and a tile's transform takes its
    phase from its own first sample (`crx::tile_columns` states the
    widths, and a test pins those of the three tile edges the corpus
    has).
  Each plane rebuilds on its own core. Round-trip tests code high bands
  and a one-tile plane's three levels the other way round and decode
  them.
- C-RAW of the second version (records 0xFF11 to 0xFF13: the R3, R5, R5
  Mark II, R5 C, R6, R6 Mark II, R6 Mark III, R7, R8, R10, R50, R50 V,
  1D X Mark III, C50 and PowerShot V1) is read too. Found from the
  forward transform of LibRaw's frame (each map cell's true step read
  off level 1's coefficients), first on an R5, an R3 and an R50, then
  checked on every file:
  - the subbands are coded exactly as the first version's; each tile's
    data opens with a map of quantizers (its size in the tile record,
    padded to 8 bytes) before the planes;
  - the steps of both versions are H.265's scaling (8.6.3): 40, 45, 51,
    57, 64 and 72 by q's remainder after 6, doubled for each whole 6,
    over 64 (`crx::quant_step`; the first version's 4, 16, 22, 26 and 32
    give the steps it had);
  - the map has an entry for every 4 columns of level 1 (the plane's LL3
    width) and a line for every row of level 1; level 2 takes the mean
    of its two level-1 rows' entries, rounded down, at half its
    columns; level 3 is not quantized (the subband records' flag). With
    S that scaling before its division by 64, the records' field takes
    S / 64 at 4 (HL2, LH2), S / 32 at 8 (HH2, HL1, LH1) and twice that
    at 16 (HH1), each rounded down;
  - the map's header is 24 bits holding 1, then the base quantizer
    plus 2 in 7 bits, then a bit that must be 0 (LibRaw reads otherwise
    where it is 1, found by changing it in copies). The entries, each
    the quantizer less the base, follow line by line with the lossless
    coding's tools: no runs, K from 2, carried from line to line, held
    at no bound (LibRaw uses a negative entry as it is); the first line's
    first entry 0 and not coded, the rest of it predicted by the entry
    to its left, the later lines by median edge detection
    (`crx_more::decode_quant_map`, which replaces a first reading fitted
    to a constant prefix and wrong on the R6 at ISO 204800).
  - one step rule for every band: max(1, (S(q) / 32 times the record's
    field (its third word's low 19 bits), over 8, each rounded down)
    plus its offset (the fourth word, signed)); field 0 with offset 1
    is not quantized, and the fields 4, 8 and 16 give the steps above.
    Level 3 and LL3 take the mean of four level-1 rows' entries.
  - Roll-burst files (encoding 3: the R7's, R8's and R10's bursts, one
    tile, the first of their frames) code four planes Y, Cb, D = G1 - G2
    and Cr, LL3 quantized where the plane's record's bit 27 is clear (the
    D plane), none clamped before the inverse of BT.2020's conversion in
    1/1024 steps (R = Y + (1510 Cr' + 512) / 1024, B = Y + (1927 Cb' +
    512) / 1024, G = Y + (-168 Cb' - 585 Cr' + 512) / 1024, each shift
    rounding down, Cb' and Cr' less half the range), G1 = G + (D + 1) / 2
    and G2 = G1 - D, each clamped to the depth (`crx_more.rs`).
  - The lossless coding's first line takes d past its end as 0, as the
    other lines do (a fault before, which the R8 burst's Cr plane shows).
  Tests code samples the other way round, and pin the steps the files use.
  All 1,648 CR3s were compared again after these changes: the 4 newly
  read files and every one read before match LibRaw.
- `rustdiff` reports the develop's own black, white level and balance
  against LibRaw's (they are not in the outputs, which take LibRaw's).

### Verification

- `rustdiff --any` over all 1,648 CR3s of both corpora: every file the
  Rust path takes, 1,618 of them (lossless and C-RAW of both versions),
  matches LibRaw at every stage. Declined: 26 of the R5 C, R6 Mark III
  and C50, which the calibration table does not have yet, 3 roll-burst
  files, and the one R6 file whose map does not read (below). The 850D's
  27 develop under its other name. Before the tile rule was right, the
  second tile of the EOS R, M6 Mark II and 90D frames (123 files)
  failed.
- 28 CR3 cameras join the verified list.
- The own black against LibRaw's: the same on most files; of the 404
  that differ, 257 differ by 1 level and 31 by 2. The EOS RP's crop mode
  is the exception: LibRaw's black
  climbs with ISO to 2193 at ISO 51200 where the camera states 2048,
  and that file's masked border reads about 2200, so LibRaw is right
  there and the stated level is not. On the R5 Mark II the border reads
  some 25 below the stated 512, which LibRaw takes. The stated level is
  kept; the RP crop case is open.
- LibRaw's black for the R6 Mark III, C50 and PowerShot V1 is 0, 58, 113
  and 145 (or 0, 32, 64, 96) across the pattern, where the masked border
  reads 512 and ColorData states 512. The Rust path takes the stated
  level, so the V1 (the only one of the three with calibrations) no
  longer carries that fault.

### Speed

| | files | LibRaw s | Rust s | ratio | median | unpack, LibRaw / Rust |
|---|---:|---:|---:|---:|---:|---|
| CR3, full size | 33 | 10.21 | 3.15 | 0.31 | 0.32 | 4.08 / 1.04 |
| CR3, half size | 33 | 6.13 | 1.18 | 0.19 | 0.23 | 4.09 / 1.03 |

(`rawbench --ext CR3 --per-camera 3` over the first corpus, the median
of 3 runs on a 16-core M4 Max.) A plane is one stream, so a frame of one
tile decodes on four cores at most.

### Not yet done

- Calibrations for the R5 C, R6 Mark III and C50.

## Phase 6: NEF

### What was built

- `nef.rs` reads the container: TIFF, the raw frame the SubIFD with CFA
  photometric, the maker notes ("Nikon" and a TIFF of their own) for
  WB_RBLevels (0x000C, red then blue against green, LibRaw's balance as
  is), BlackLevel (0x003D, stated for 14-bit samples and shifted down for
  12-bit ones; 0 without it), the compression (0x0093) and the
  linearization record (0x0096). The image area and CFA colors come from
  geometry.rs, whose builder now reads NEF; the white level from a table
  the same builder writes by camera and sample depth (`NEF_WHITE`: a
  camera's 12-bit and 14-bit files share a frame size but not a level,
  the D600's 14-bit level being 15879), else the depth's top.
- The uncompressed codings, found against LibRaw's frame: 16-bit words
  in the file's byte order, or 12-bit samples packed most significant
  bits first; and, marked as Nikon's compression but stored whole (NEF
  compression 6 and 10, and Z bodies without the tag), 12 and 14-bit
  samples packed least significant bits first, a row padded to 16 bytes
  in some files.
- Nikon's Huffman coding, which no file and no prose documents (its
  tables live only in code), derived from the data: for each sample of
  LibRaw's frame (a lossy frame's back through its curve) the
  difference from its prediction is known, so the code is what makes
  the stream read as those differences. A search over the first few
  thousand samples, backtracking where a category's code length is
  ambiguous, then a learner over whole files (each candidate code
  judged by how far the samples after it decode), found:
  - a row's first two samples predicted by the same columns of the last
    row of its parity (the record's four seeds above the first rows),
    the others by the sample two to the left; each difference a Huffman
    symbol and then its bits, ITU-T T.81's sign rule; a sample held to
    0 to 2^14 - 1 (the prediction runs on unbounded);
  - six codes: lossless 12 and 14-bit, lossy 12 and 14-bit, and, from a
    row the record names (the 16-bit word at its byte 562, after a
    257-point curve), a second lossy code for each depth whose symbols
    carry a shift: the difference's low bits left out, filled by a 1
    and zeros halved (the high-ISO files' coarse differences);
  - the lossy curve: 257 points over the samples' range (their depth,
    or two bits less in record version 0x40), a point every 256th of
    it, linear between and including the last; an older record (version
    0x10) holds the whole table; a sample past the curve passes through,
    up to 14 bits.
  Each code is stored as the codes the corpus uses; a symbol it never
  used reads as unsupported, and the file stays LibRaw's. One stream, so
  the frame decodes on one core.
- Declined and LibRaw's: High Efficiency (and its starred variant) of
  the Z8, Z9, Z f, Z50 II, Z5 II and Z6 III; the small NEF; the D100's
  own coding and the D1X's compressed files; files without a stated
  balance (the D1, D1H, D1X, D2H, D50, D70 and D70s, a few D2Hs and D2X
  files, the Coolpix E series); scanner files; the D810A and ZR (no
  calibrations yet).
- Tests: rows coded the other way round and decoded (both lossless
  codes, jumps of every category), a shifted symbol's bits, and every
  code prefix-free.

### Verification

- `rustdiff --any` over all 548 NEFs of both corpora: the 444 the Rust
  path takes match LibRaw at every stage, and its own black, white and
  balance are LibRaw's (the balance as ratios; LibRaw states some bodies'
  in 256ths). Declined: 62 High Efficiency, small, D100 and D1X files,
  24 without a stated balance, 13 of the D810A and ZR, 5 scanner files.
- 71 NEF cameras join the verified list.

### Not yet done

- The balance of the bodies that keep it only in ColorBalance (0x0097),
  enciphered from version 0200 on; High Efficiency; the small NEF.
- Calibrations for the D810A and ZR.
- Speed: the Huffman frame is one stream and decodes on one core.

## Phase 7: RW2

### What was built

- `rw2.rs` reads the container: TIFF-shaped with 0x55 for TIFF's 42
  (`Tiff::with_magic`), its raw facts in IFD0's own tags: the frame's
  width and height (0x02, 0x03), the depth (0x0A), the coding
  (RawFormat, 0x2D), the samples' offset (0x118), the black levels of
  red, green and blue (0x1C to 0x1E; LibRaw's are these and 15 in
  RawFormats 4 and 5, as stated in the others) and the balance as shot
  (0x24 to 0x26, red, green, blue, LibRaw's as is). The image area and
  CFA colors come from geometry.rs, whose builder now reads RW2; the
  white level from it too, else (the S1RM2, whose 12 and 14-bit files
  share a frame size) LibRaw's for the depth: 255/256 of the range in
  RawFormats 6 to 8 below 16 bits.
- Every coding derived from the data against LibRaw's unpacked frame:
  - RawFormat 4 (12-bit, 14 samples a 16-byte packet): the packets in
    blocks of 0x4000 bytes, each block's stream starting 0x1FF8 bytes in
    and wrapping to its start; a packet one 128-bit little-endian number
    read from its top bit. Even samples one color of the row, odd ones
    the other; every third sample from the third starts a group of three
    with a two-bit code, the shift of its steps (0, 1, 2, 4). A color's
    first sample is 8 bits and 4 more (while those 8 are 0, the last
    value again); after it an 8-bit field of 0 repeats the last value;
    under shift 4, or while the last value is below 128 shifted, the
    field shifted over the last value's low bits is the value; else the
    last value plus the field less 128, shifted.
  - RawFormat 5 (12 and 14-bit) and 7 (14-bit): whole samples packed
    least significant bits first, 10 or 9 a packet; 5 in the turned
    blocks of 4, 7 straight.
  - RawFormat 6 (14-bit, 11 a packet; 12-bit, 14): the first two samples
    whole, then groups of three, each a two-bit shift code and fields of
    10 bits (8 for 12-bit); under shift 4 or while the last value of the
    color is below the field's middle shifted, the field shifted is the
    value, else the last value plus the field less its middle, shifted;
    every value 15 less.
  - RawFormat 8 (12, 14 and 16-bit): tiles in a grid, each its own
    stream (offsets 0x44, places 0x45 with the top row in the high 16
    bits, lengths in bits 0x46, widths 0x47, heights 0x48), one Huffman
    code for all (0x40: 17 lengths and codes, the symbols 0 to 16). A
    tile runs two rows at a time in 2 by 2 blocks, each block's samples
    down then across; a sample is a symbol, its difference's number of
    bits, then the difference (lossless JPEG's sign rule) from the same
    site of the block before, a row pair's first block from the first
    block of the pair above, 0 at the tile's top. The stream's bits run
    from each byte's lowest, the codes and differences top bit first.
    Where one code starts another (some files' table), the shorter is
    read. The tiles decode across the cores.
- LibRaw takes an RW2's samples of 0 as bad ones and fills each with the
  mean, rounded down, of the nonzero samples of its color two rows or
  columns away and diagonally (`develop::fill_zeros`, after the unpack);
  found where the FZ80's develop differed around its 124 zero samples.
- Declined and LibRaw's: RawFormat 7 frames taller than the sensor's
  stated rows (the S5's high-resolution mode, whose last two rows LibRaw
  leaves at 0, a rule two files cannot settle); other RawFormats and
  depths; a RawFormat 8 layout whose tiles do not cover the frame once,
  or whose symbols carry a shift (0x41); the DC-FZ45, L10, S5D and
  TZ220D (no calibrations yet); the DMC-G7's 4816 by 3464 frames (its
  files disagree on LibRaw's area).
- Tests: RawFormat 4 and 6 packets coded and decoded (each mode: a
  color's start, a 0 field, the absolute and step forms), whole samples,
  a turned block's packets, a RawFormat 8 tile coded and decoded and cut
  short, the shorter of two codes read.

### Verification

- `rustdiff --any` over all 781 RW2s of both corpora: the 752 the Rust
  path takes match LibRaw at every stage (643 RawFormat 4, 20 of 5, 17
  of 6, 2 of 7, 70 of 8), with LibRaw's own black, white and balance.
  Declined: 17 without calibrations, 6 DMC-G7 frames without geometry,
  2 S5 high-resolution frames.
- Four files LibRaw cannot open (an input/output error): two FZ38 3:2
  frames and two S1RM2 high-resolution frames (eight tiles in a 4 by 2
  grid). Their data is whole and the Rust path develops them; nothing
  holds them to LibRaw, so they were checked by eye (the FZ38's against
  its own preview), and the corpus test counts them apart.
- 111 RW2 cameras join the verified list.

### Not yet done

- Calibrations for the DC-FZ45, L10, S5D and TZ220D.
- The S5's high-resolution frames; the DMC-G7's 4816 by 3464 area.

## Phase 8: ORF

### What was built

- `orf.rs` reads the container: TIFF-shaped with "RO" or "RS" for TIFF's
  42 (`Tiff::with_magic`), the frame's size and strips in IFD0, and the
  maker notes in their three headers: "OM SYSTEM" (entries at 16) and
  "OLYMPUS" (at 12), offsets from the notes' start, and "OLYMP" (at 8),
  offsets from the file's (`Tiff::with_order` reads directories without a
  header). The balance as shot is ImageProcessing's (0x2040, an IFD at
  an offset or inline) 0x0100, red then blue against 256, else the notes'
  0x1017 and 0x1018; the black level ImageProcessing's 0x0600 (red, the
  green on red's row, the other green, blue; stated for 12-bit samples,
  four times it for 14-bit ones), else LibRaw's for the camera, which
  geometry.rs's builder now writes (`ORF_BLACK`) with the area, CFA
  colors and white level of every ORF camera.
- Every layout derived from the data against LibRaw's unpacked frame:
  - 16-bit words in the file's byte order, the sample in the top bits:
    12 of a little-endian file's, 10 of a big-endian one's (the E-10 and
    E-20), taken through a linearization table that shifts them down;
  - 12-bit samples least significant bits first, 10 in 15 bytes and a
    byte of 0 (the E-300, E-330, E-500 and some high-resolution frames);
  - "RS" files (the C and SP series): 12-bit samples most significant
    bits first in two fields, the even rows from the first strip and the
    odd ones from the first strip after them, every strip its 16 rows
    whole (the last rows past the stated counts), the odd stated height
    a row short of the rows LibRaw reads;
  - 12-bit samples most significant bits first inside 32-bit
    little-endian words (the XZ-2, XZ-10 and SH-2);
  - Olympus's compression, after a header of four 0 bytes (12-bit) or
    five (14-bit) and 1, 0, 0: rows left to right, each column parity
    with a state reset every row; a sample is 3 bits (a sign and the two
    low bits of its difference), the high bits as a run of 0s ended by a
    1 (twelve 0s escape to a field of 16 less the width, halved), then a
    width that adapts to the last magnitude and to how many small ones
    came; the difference carries a running mean and adds to a prediction
    from the samples two to the left, two above and two above and left
    (where the corner lies between, their sum less it when either
    differs from it by more than 32, else their mean; otherwise the one
    farther from it). The first rows of an E-PL1 fixed the reading; each
    part was then held to the data by changing it (a threshold of 31 or
    33 for the 32 breaks two thirds of 120 rows; the escape is taken 94
    times in them). One stream, decoded on one core.
- Tests: a frame coded the other way round and decoded (an escape among
  its samples) and cut short; the padded and word layouts.

### Verification

- `rustdiff --any` over all 185 ORFs of both corpora: the 182 the Rust
  path takes match LibRaw at every stage (132 compressed 12-bit, 6
  compressed 14-bit, 20 in two fields, 10 padded, 8 in 16-bit words, 6
  in 32-bit words), with LibRaw's own black, white and balance. Declined:
  3 of the OM PEN (no calibrations yet).
- 71 ORF cameras join the verified list.

### Not yet done

- Calibrations for the OM PEN.
- Speed: the compressed frame is one stream and decodes on one core.

## The variants: NRW, RAW, RWL and ORI

The corpus test and the comparisons had picked files by extension, so
the variants whose headers the NEF, RW2 and ORF readers already accept
had never been compared. Over their 159 files (2026-10-22) none decoded
wrong under the verified cameras, but the Coolpix NRWs did under
`--any`, and most were declined. Now:

- NRW (the Coolpix bodies), each layout from the data against LibRaw's
  frame: NEF compression 9, 12-bit samples packed most significant bits
  first; 7, 16-bit big-endian words in a little-endian file (`Coding::
  BigWords`), their top 12 bits where LibRaw's white level is 12-bit (the
  P330); uncompressed 12-bit from a "COOLPIX" body, the samples in 32-bit
  little-endian words (as the XZ-2's ORFs hold them). The balance of the
  bodies without WB_RBLevels is their NRW record's (0x0014: red, green,
  the other green, blue at byte 56, or at 1556 in "NRW 0100"), red and
  blue doubled as LibRaw takes them. The black level where none is
  stated is LibRaw's for the camera (geometry.rs's `BLACK`, which the
  builder now writes for ORF, NEF and RW2 cameras).
- Older Panasonic RAW and Leica RAW and RWL: no RawFormat, 16-bit words
  with the sample in their top 12 bits (whatever depth is stated);
  RawFormat 2, 10 whole samples a packet; RawFormat 3, the RawFormat 4
  coding without the turned blocks; the balance in 0x11 and 0x12
  against 256 where 0x24 to 0x26 are missing; the samples' offset the
  strip's where 0x118 is missing.
- A fix found on the way: RawFormat 5's black level is as stated (only 3
  and 4 add 15), and where 0 is stated LibRaw's table level is taken
  (the G10's 0). The comparisons hold the develop to LibRaw's own
  levels, so the outputs had matched while the levels Heeler would use
  did not; every comparison run now also checks Heeler's own black, white
  and balance against LibRaw's.
- The same audit over the verified cameras' CR2, CR3, ARW and DNG files
  (2,678): one more fault, the 12-bit uncompressed ARWs of the A7R II,
  whose samples are 16-bit words at 14-bit scale but whose SR2 black was
  quartered as for 12-bit packed data (128 for LibRaw's 512); the quarter
  is now taken only for packed data. The rest are the CR2 and CR3 black
  measured on the masked border (within 2 levels of LibRaw's but for the
  EOS RP's ISO 102400 crop frames, where LibRaw's region reads 248 more
  than the left border), the PowerShot V1's (LibRaw's own level runs 0
  to 121 across the pattern's sites; Heeler's is the stated 512), and two
  CR2s whose balance LibRaw does not read.
- The geometry builder, the corpus test and the comparisons read the
  variants' extensions.
- A half-size fault the variants showed: where the image area's height
  or width is odd, LibRaw's half size leaves the last row or column out
  of the brightest sample as it leaves it out of the blocks, so a frame
  whose brightest sample lay there (an FZ50's 2439 rows) developed a
  little darker; the half-size develop now takes its brightest sample
  from the whole blocks only. (The comparisons' tally had counted such a
  file as exact on its full-size outputs; they now count any differing
  half-size sample too.)

## Phase 9: PEF

### What was built

- `pef.rs` reads the container: TIFF, the frame and its one strip in
  IFD0, the maker notes in two headers ("AOC", entries at 6, offsets from
  the file's start; "PENTAX", entries at 10, offsets from the notes'
  start; each in the notes' byte order). The black level (0x0200) and
  balance as shot (0x0201) are red, green, the other green, blue, as
  LibRaw takes them. Samsung's Pentax-made bodies are left to LibRaw,
  which reads neither from their notes.
- The codings, from the data against LibRaw's frame:
  - Pentax's Huffman coding (compression 65535), its code in the maker
    notes (0x0220): a 16-bit count c, 12 bytes, c + 12 codes aligned to
    the top of 12 bits, then their lengths; the symbols are lossless
    JPEG's difference sizes. A row's first two samples add to the same
    columns two rows above (0 at the top), the others to the sample two
    to the left. One stream, one core.
  - Compression 32773, though nothing is run-length coded: 12-bit
    samples packed most significant bits first.
  - Compression 1: 16-bit big-endian words.
- Tests: rows coded the other way round, decoded, and cut short.

### Verification

- `rustdiff --any` over all 78 PEFs of both corpora: 74 match LibRaw at
  every stage with LibRaw's own black, white and balance. Declined: the
  K-3 Mark III Monochrome (2, no balance; not a mosaic), the GX-1L and
  GX-1S (Samsung's).
- 30 PEF cameras join the verified list, with 12 Coolpix NRW cameras and
  22 RW2 cameras of older Panasonic and Leica files.

### Not yet done

- Monochrome PEFs and Samsung's Pentax-made bodies.

## Phase 10: SRW, uncompressed and packed

### What was built

- `srw.rs` reads the container: TIFF, the raw frame the SubIFD with a CFA
  pattern (0x828D, no photometric tag), the maker notes an IFD at their
  start with offsets from there. LibRaw's balance is 0xA021 less the first
  four values of 0xA020 and its black level 0xA028 less the same (red,
  green, the other green, blue), as the corpus shows on every body.
- The codings, from the data against LibRaw's frame: compression 32769,
  16-bit little-endian words whatever the file's order (`Coding::
  LittleWords`), shifted down one bit where the stated depth is 12 (the
  EX2F); 32770 at 1.5 bytes a sample, 12-bit samples packed most
  significant bits first where SamplesPerPixel states 1 (NX5, NX10, NX11,
  NX100) and least significant first where it states 3 (NX20 to NX1100).
- On the bodies packing most significant bits first LibRaw measures the
  black level instead: the mean, rounded down, of each pattern site over
  the masked columns left and right of the image area, along its rows.
  `srw.rs` measures it from the packed samples while it reads the file.
- Declined and LibRaw's: Samsung's three compressed codings (32770 in
  fewer bytes than packing, 32772, 32773: NX300, NX30, NX2000, NX mini,
  NX3000, NX3300, NX1, NX500, EK-GN120).

### Verification

- `rustdiff --any` over all 51 SRWs of both corpora: the 26 the Rust path
  takes match LibRaw at every stage, full size and half, with LibRaw's
  own black, white and balance. 12 cameras join the verified list.

### Not yet done

- Samsung's compressed codings.

## Phase 11: MRW

- `mrw.rs` reads the container: "\0MRM", the header's length, blocks of a
  name and a length. PRD gives the sensor's size and the storage, 0x59
  for 12-bit samples packed most significant bits first and 0x52 for
  16-bit big-endian words (both from the data against LibRaw's frame);
  WBG the balance as shot (red, green, the other green, blue after 4
  bytes, LibRaw's as is); TTW a TIFF with Make, Model and orientation.
  The black level is 0, as LibRaw takes it.
- `rustdiff --any` over all 25 MRWs of both corpora: the 22 MRM files
  match LibRaw at every stage; the other three are not MRM files (two
  G600 files wrapped in JPEG, a headerless Z2) and stay LibRaw's with the
  headerless formats. The MRW cameras join the verified list.

## Phase 12: CRW

### What was built

- `crw.rs` reads Canon's CIFF container: "II", the header's length,
  "HEAPCCDR", then a heap of records with its directory at the end,
  records being heaps of their own where their tag says so. Read: the
  samples (0x2005), the code table set (0x1835), the sensor's size
  (0x1031), Make and Model (0x080A), the rotation (0x1810) and the balance
  as shot (0x10A9 on the EOS bodies; 0x102C on the G2, S30 and S40, as
  LibRaw takes them).
- The coding, from the data against LibRaw's frame: blocks of 64 samples
  in JPEG's run and size symbols with byte stuffing, a first difference
  carried from block to block, each sample adding its difference to the
  last of its column parity in the row (512 at each row's start). Where
  the frame has 12-bit samples, their 2 low bits come first, a quarter
  byte each; the coded 10-bit part starts 514 bytes after them. Those 514
  bytes are zeros, or on the later PowerShots a baseline JPEG header that
  ends where the coded part starts.
- The three table sets were learned from the corpus files against
  LibRaw's frame. Each is a whole JPEG code table (12 first-difference
  symbols, 162 run symbols, codes in canonical order), and sets 0 and 1
  are exactly the tables the PowerShots' JPEG headers state, which filled
  in the few symbols no file had used.
- On the 2672-wide sensor (G5, S50, S60), LibRaw's frame holds every
  sample below 512 (low bits included) 2 higher than the coding gives,
  found from the data and kept.
- Bodies stating no balance (the D30 and the PowerShots with JPEG
  headers) get the daylight balance of the camera's matrix, where
  LibRaw's develop balances from the picture. Without low bits the white
  level is 1023. The develop's own black is the masked border's mean,
  rounded down.
- Declined: the G1 and Pro70, whose sensors have four colors (cyan,
  magenta, yellow, green); the develop is three-color.

### Verification

- `rustdiff --any` over all 41 CRWs of both corpora: the 38 from 16 RGB
  cameras match LibRaw at every stage, full size and half, Clip and
  Blend, given LibRaw's black, white and balance. For the bodies stating
  no balance, the comparisons give the develop the multipliers LibRaw's
  develop takes from the picture in each highlight mode
  (`with_libraw_balance`). The 16 cameras join the verified list.
- The develop's own black, which the comparisons replace, is within 1 of
  LibRaw's on most bodies and within 2 on the G5, S50 and S60. LibRaw's
  value there is no simple mean of either masked border.

### Not yet done

- Four-color sensors (G1, Pro70 and the other CMYG PowerShots).

## Phase 13: headerless files

### What was built

- `headerless.rs` reads raw files with no header: known by their size
  alone, as LibRaw knows them, and named as LibRaw names them (it names
  an ELPH 180 "IXUS 160", and every camera that writes a size by that
  size's first camera). Most come from the add-on firmware of Canon's
  compacts; the others from Gitup action cameras and the cameras writing
  their sizes, the Samsung WB550's size, the Minolta DiMAGE G600 and Z2,
  and the Pentax Optio S4.
- The layouts, from the data against LibRaw's frame, are one row reader:
  rows from an offset (or ending at the file's end), the bytes in words
  of 1, 2 or 4, little-endian, read top bit first, a fixed number of bits
  a sample, shifted down where LibRaw shifts it. Canon's firmware writes
  10 or 12 bits in 16-bit words; Gitup 16-bit words; the WB550's size
  16-bit words shifted down 6; the G600 big-endian words ending at the
  file's end; the Optio S4 12 bits in rows of 3520 bytes; the Z2 12 bits
  in 32-bit words, in two fields (the even rows from the start, the odd
  from half the file).
- The image area, CFA colors and white level come from the geometry
  table. The others take a fixed black (Gitup's 3200 or 4160, else 0);
  Canon's firmware files measure theirs, on the masked columns either
  side of the image area that read darkest (within 6 of the darkest,
  columns under 16 being dead), each site's mean rounded down. LibRaw's
  own masks take in lit columns on some bodies (the A3300 IS, A640 and
  SX30 IS sizes, up to 239 against the dark columns' 127), and on the
  IXUS 160, SX40 HS and SX710 HS sizes its level is up to 9 below the
  darkest columns; elsewhere the two agree within 1.
- Samples of 0 in Canon's firmware files (but the D10's) are bad ones,
  filled from their neighbors as LibRaw fills a Panasonic file's.
- Left out: the size the A610 and S2 IS share (LibRaw tells them apart
  by the picture, which two files cannot pin down), the S100's (its own
  CR2s take another image area under the same name), the Kodak C330 and
  C603 (8-bit samples through a curve, or not a mosaic), the Raspberry
  Pi's and the RD175.

### Verification

- `every_corpus_headerless_frame_is_libraws`: the 62 corpus files of the
  sizes the table knows (23 sizes) decode to LibRaw's whole frame, to
  the sample.
- With LibRaw's matrices (below), `rustdiff --any` over them: every file
  of 19 cameras matches LibRaw at every stage, full size and half, given
  LibRaw's black and balance (these files state none, and LibRaw's
  develop balances them from the picture in each size and highlight mode,
  `with_libraw_balance`; the shipped develop takes daylight). The SX30 IS
  size's one file differs at half size and is not listed. The Optio S4,
  WB550 and G600, which LibRaw develops without a matrix, stay declined.

## Speed of the formats from NEF to the headerless files

Timed on 2026-10-23 with `rawbench --ext NEF,NRW,RW2,RAW,RWL,ORF,ORI,PEF,SRW,MRW,CRW --per-camera 3 --runs 3`
over the first corpus, each decoder on its own with nothing else running
(the median of 3 runs after one untimed, on a 16-core M4 Max); 683 files
both decoders developed. CSVs in `docs/rust-raw-decoder/formats-*.csv`.

| Format | Files | Full: LibRaw s | Rust s | Ratio | Unpack, LibRaw / Rust s | Half ratio |
|---|---:|---:|---:|---:|---|---:|
| RW2 | 291 | 82.07 | 20.16 | 0.25 | 22.24 / 3.61 | 0.11 |
| NEF | 147 | 50.46 | 29.05 | 0.58 | 23.44 / 18.76 | 0.60 |
| ORF | 82 | 32.94 | 21.48 | 0.65 | 18.84 / 15.37 | 0.63 |
| CRW | 43 | 6.58 | 2.06 | 0.31 | 1.76 / 0.89 | 0.29 |
| PEF | 35 | 11.59 | 5.85 | 0.51 | 5.66 / 3.82 | 0.52 |
| RAW | 21 | 2.57 | 0.67 | 0.26 | 0.14 / 0.04 | 0.08 |
| RWL | 17 | 3.43 | 0.70 | 0.20 | 0.79 / 0.05 | 0.06 |
| MRW | 14 | 1.01 | 0.25 | 0.24 | 0.18 / 0.01 | 0.06 |
| SRW | 14 | 2.69 | 0.70 | 0.26 | 0.59 / 0.02 | 0.05 |
| NRW | 12 | 1.78 | 0.50 | 0.28 | 0.33 / 0.02 | 0.06 |
| ORI | 7 | 3.16 | 2.29 | 0.72 | 2.00 / 1.69 | 0.69 |

- The uncompressed and packed formats, RW2 and the headerless files reach
  the target, most near 0.2. NEF, ORF and PEF reached only the floor and
  ORI fell below it: each frame is one coded stream, decoded on one core.

### Faster streams

- `huffman.rs` reads a stream of Huffman-coded differences across the
  cores: the stream cut into pieces, each read from its own start (a
  reading from mid-code that meets bits no code has starts afresh a bit
  on), then each fallen into step with the true reading where the piece
  before it truly ended, at a code start the piece remembers; a piece
  that never falls into step is read on in order, and a true reading that
  goes wrong sends the whole stream to the reader in order, so a damaged
  stream reports the same either way. A frame whose code changes partway
  down (some lossy NEFs) is read with each code, and the piece the change
  falls in is read in order. The prediction runs on unbounded in both
  formats, so the differences come first, then the first two columns down
  the rows, then each row on its own. NEF and PEF use it.
- CRW reads the same way at a block's start, its stuffing taken out
  first; the first differences are then carried from block to block.
- ORF's coding keeps state per row and predicts from the rows above, so
  it reads its bits on a thread of its own while the predictions are made
  on another, and its bit reader takes eight bytes at a time.

| Format | Files | Full: LibRaw s | Rust s | Ratio | Unpack, LibRaw / Rust s | Half ratio |
|---|---:|---:|---:|---:|---|---:|
| NEF | 147 | 50.46 | 11.84 | 0.23 | 23.44 / 2.18 | 0.09 |
| ORF | 82 | 32.94 | 13.07 | 0.40 | 18.84 / 8.15 | 0.37 |
| PEF | 35 | 11.59 | 2.67 | 0.23 | 5.66 / 0.49 | 0.09 |
| CRW | 43 | 6.58 | 1.24 | 0.19 | 1.76 / 0.20 | 0.08 |
| ORI | 7 | 3.16 | 1.32 | 0.42 | 2.00 / 0.92 | 0.42 |

Every camera of these formats is now under the 0.50 target at full size
and half. CSVs in `docs/rust-raw-decoder/formats-rust-faster-*.csv` and
`formats-rust-crw-nef-*.csv`, the same timing as above.

- Found on the way: the shipped develop (the develop's own levels, which
  the comparisons replace with LibRaw's) failed on the CRWs of the Pro1
  and S30, whose left border is too narrow to measure black on, and
  heeler-raw then developed them with LibRaw without a word. They now
  measure on the darkest columns of both borders, as a headerless file
  does (the Pro1's level LibRaw's, the S30's within 1), and the corpus
  test now holds every file it compares to finishing the shipped develop
  too. The Z f and Z fc's slow develop in the first timing did not recur.

## Phase 14: RAF, Bayer and uncompressed

### What was built

- `raf.rs` reads Fujifilm's container: "FUJIFILMCCD-RAW ", then at 84
  big-endian offsets and lengths of the preview JPEG (its EXIF gives Make,
  Model and the orientation), a block of records (a count, then a 16-bit
  tag, a 16-bit length and data each), and the raw section. The later
  bodies' raw section is a little-endian TIFF whose directory at 0xF000
  gives the frame's width, height and depth (0xF001 to 0xF003), the
  samples' offset and length (0xF007, 0xF008), their packing (0xF004,
  0xF006), each CFA site's black level (0xF00A) and the balance as shot,
  green, red, blue (0xF00E), all as LibRaw takes them.
- The layouts, from the data against LibRaw's frame: 16-bit
  little-endian words; samples of the depth in 32-bit little-endian words
  read top bit first; 12-bit samples packed least significant bits first.
  The first two read through headerless.rs's row reader.
- The white level is LibRaw's for the camera and depth (the GFX bodies'
  14-bit files 15872, their 16-bit ones 65535; the geometry table's NEF
  depth table now holds RAF too).
- Fujifilm's lossless compression (`fuji.rs`), Bayer and X-Trans: a
  header ("IS", lossless or lossy, the raw type, the depth, the frame's
  size, a block's width, the lines), each block's length, then blocks of
  768 columns read on their own (across the cores), six rows at a time
  as color lines read in pairs, each sample from its neighbors above with
  an adaptive Golomb-like code in one of 41 contexts per pair kind. Its
  structure was recalled rather than derived from a published description
  (the owner's decision of 2026-10-24, as with ORF), then each part
  confirmed against LibRaw's frame: the header and the block table
  against every file's samples' length, the coding and the lines'
  arrangement sample for sample on whole frames. X-Trans files read some
  even samples from the line above where the sensor's pixels never use
  them, and their 6 by 6 pattern is record 0x131 read backwards; both
  found from the data.
- X-Trans at half size (2026-10-24), each rule found from LibRaw's
  stages: the 6 by 6 pattern and the 36 black levels move with the image
  area's top left; the scale takes each site's color's multiplier. Each 2
  by 2 block becomes one pixel of the last sample of each color it holds
  in reading order. Every third block across and down holds only greens
  and takes its red and blue as the mean of its left and right
  neighbors' (none in the first and last columns). An odd last row or
  column makes blocks of its own (3997 rows give 1999), and the
  brightest sample for the white level is taken over every sample, not
  only the kept ones. The geometry table now holds the X-Trans bodies
  (82 camera sizes): the generator takes LibRaw's 6 by 6 from a shim
  accessor, and a file's own pattern (record 0x131) must agree with its
  first 2 by 2.
- X-Trans at full size: `xtrans.rs`, a demosaic of the 6 by 6 written
  from the method's plain meaning (directional candidates weighed by
  homogeneity, as AHD is for Bayer) and held to LibRaw's by a tolerance,
  as the owner decided on 2026-10-22. Each pixel is interpolated along
  the row and along the column: green from the nearest green either
  side, the nearer weighing more, corrected by half the site's own
  color's change along the line; red and blue from the color differences
  of every sample of the color in the 5 by 5, weighted by 1 over the
  squared offset along the direction plus 8 times the squared offset
  across it. The candidates' roughness in lightness along their own
  direction gives each a homogeneity score over the 3 by 3, and the
  candidates are blended by their scores to the fourth power. The weights
  were chosen by how close they bring the output to LibRaw's on eight
  bodies' files; diagonal candidates, a second refining pass, a harder
  choice and a median of the color differences all scored lower. It
  takes 0.10 of LibRaw's time at full size (0.15 s against 1.61 s on an
  X-T3).
- Thin dark lines against bright backgrounds (2026-10-25, the owner's
  request): the first version dotted them where LibRaw's stay
  continuous. Two causes, found on an X100F's branches against clipped
  sky. The roughness took chroma in, and a thin line's color fringes (its
  red and blue displaced by the lens) made the candidate that follows the
  line look rough, so the one that crosses it, bright from the sky either
  side, won half the blend; roughness is now lightness alone. And red and
  blue took every sample of the 5 by 5 alike, reaching across the line;
  they now weigh samples along the candidate's direction eight times
  more than samples across it. On three lines of that file the darkest
  point along each line now sits 3.4k, 2.4k and 2.1k (of 65535) from
  LibRaw's on average, from 6.2k, 4.5k and 2.3k, and the brightest gap
  along the first is 54k against LibRaw's 54k (61k before). The eight
  bodies' mean PSNR against LibRaw rose from 51.3 to 52.7 dB.
- Declined for now: Fujifilm's lossy compression (46 files: one byte a
  six rows of each block, a step, ahead of the blocks; the recalled rule
  for it did not reproduce LibRaw's frame) and the earlier bodies without
  the TIFF raw section (35; most with the sensor turned 45 degrees).
- The 37 X-Trans bodies join the verified list (2026-10-25, the owner's
  decision once thin lines held): exact to LibRaw through the scaled
  mosaic and at half size, and at full size held by the corpus test to a
  PSNR of at least 38 dB against LibRaw's develop under Clip and Blend
  (`XTRANS_FLOOR_DB`, just under the corpora's worst, 38.5).

### Verification

- `rustdiff --any` over all 304 RAFs of both corpora: the 71 uncompressed
  Bayer files and the 26 losslessly compressed GFX files match LibRaw at
  every stage, full size and half, with LibRaw's black, white and
  balance, and with its own. 32 cameras join the verified list. With
  X-Trans at half size, all 223 RAFs the develop reads match LibRaw at
  half size, Clip and Blend.
- X-Trans at full size, `rustdiff --any` over the 126 X-Trans files the
  develop reads (37 bodies): the mosaic and the scaled mosaic match
  LibRaw's to the bit; the output against LibRaw's (its matrix and
  balance) has a PSNR of 38.5 to 61.9 dB under Clip, median 51.9, mean
  51.2 (37.1 to 60.3, median 50.1, before the thin-line changes); under
  Blend from 43.6, median 58.2. The lowest are fine detail against
  clipped highlights (an X100F's branches against white sky, the X-H1's
  twigs); there the two now look alike at the pixel level, LibRaw's
  thinnest lines a little more continuous. In midtones the two look
  alike, LibRaw's with more color fringing.
- `every_corpus_raf_frame_is_libraws`: every RAF whose samples are read
  (the X-Trans ones too, 76 losslessly compressed among them) decodes to
  LibRaw's whole frame, to the sample. A lossless compressed frame takes
  55 to 177 ms.

## Phase 15: the remaining formats, by census

### The census (2026-10-25)

- Every raw file of both corpora the app opens (heeler-io's raw
  extensions), 5074, through the Rust plan, with the routine LibRaw
  unpacks each with: 4408 develop in Rust on verified cameras; 34 LibRaw
  itself cannot open (out of scope: the app cannot open them today
  either); the rest are the gaps this phase works through, largest
  first.
- Nikon's high-efficiency NEF coding (HE and HE*, from the Z 9 on) is a
  licensed codec with no public description. LibRaw declines it on the
  Z 9, Z 8, Z f and Z6 III, and misreads it on the Z5 II and Z50 II as a
  plain NEF (its image is noise). Neither path can show these files;
  once LibRaw is gone they say so instead of showing noise.

### Smaller gaps

- Ten cameras the develop already read exactly but no verified camera
  named join the verified list: five Blackmagic cinema cameras, Parrot's
  Anafi, a YI action camera, Canon's PowerShot A610 and S3 IS (CHDK DNGs)
  and the Rebel SL3. A DNG naming no Make (the cinema and action
  cameras) is verified by its UniqueCameraModel (`camera_key`).
- The EOS-1D Mark III's CR2 frame is 3984 samples wide; LibRaw lays its
  samples two places early (its first two dropped), found against its
  frame. Both files of the corpora now match at every stage.
- DNGs whose stated image area LibRaw develops smaller (13 Pentax,
  Samsung and Ricoh bodies' in-camera DNGs, which state none, and
  Leica's SL2, whose area LibRaw takes 19 rows shorter): LibRaw's own
  table for the camera decides, so documents keep their geometry. The
  geometry generator records such DNGs' areas in a table of their own
  (`DNG_GEOMETRY`, `geometry::find_dng`), and the DNG reader takes a
  row's area when it lies within the stated one an even number of rows
  and columns in, the CFA pattern moved with it.

### Canon sRAW and mRAW

- `sraw.rs`, every rule found against LibRaw's unpacked image: the frame
  is YCbCr in lossless JPEG, the luma sampled 2 by 1 (sRAW) or 2 by 2
  (mRAW). Its scan predicts each component's samples in a line from the
  one before it in the stream, the MCU's luma samples one chain (not
  each from its left neighbor in its plane, as T.81 would), a line's
  first sample of each component from the first of the line above. The
  samples fill the CR2's slices, counted in samples; some bodies' mRAWs
  (from the 6D on) state their scan across the image's short side, and
  the slices lay the image out. Each pixel's chroma is its MCU's at the
  MCU's first pixel, the rounded-up mean of its MCU's and the next one's
  (along the row, then the column, then both) elsewhere, the image's last
  row and column their own MCU's (LibRaw's image, which on the 50D and
  5D Mark II mRAWs is a few columns narrower than the frame). The
  conversion is integer: with Cb and Cr less 16384,
  R = (Y + Cr) m_r >> 10, G = (Y + ((-778 Cb - 2048 Cr) >> 12)) m_g >> 10,
  B = (Y + Cb) m_b >> 10, the multipliers a ColorData level set's
  (entry 78, 123 or 128 by the ColorData version) each times the set's
  green over 1024. The 40D takes 512 off the luma first. The ColorData
  version 6, 7 and 9 bodies (50D, 5D Mark II, 7D, 60D, 1D Mark IV)
  convert otherwise, with chroma times 4 plus an offset and weights over
  16384; those weights are the least-squares fit to LibRaw's image times
  4096, then confirmed on every pixel, and their shape matched what was
  recalled of how such conversions are written: flagged, as for ORF and
  Fujifilm's compression.
- The develop takes an image of three samples a pixel (`Plan::three`):
  no CFA and no black level; the brightest sample sets the white level as
  for a mosaic; each channel is scaled by its multiplier; each pixel is
  finished as a demosaiced one is. LibRaw shrinks only a mosaic, so a
  three-color image develops at full size whichever size is asked for.
  The geometry generator records such images' areas and white levels in
  a table of their own (`RGB_GEOMETRY`, `geometry::find_rgb`).

### Sony M and S sizes

- `sony_ycc.rs`: the raw directory is YCbCr (photometric 6), the luma
  sampled 2 by 2, in tiles of lossless JPEG. The scan predicts each
  sample from its left neighbor in its component's plane, as T.81 does,
  but a plane row's first sample from above: the luma's first row from
  the first luma sample of the MCU row above, its second from the
  sample above it. Every pixel takes its own MCU's chroma (2 by 2 for an
  M size, 2 by 1 for an S). With Cb and Cr less 16383, in single
  precision, each step a fused multiply-add, truncated, 1024 off:
  R = Y + 1.402 Cr, G = (Y - 0.34414 Cb) - 0.71414 Cr, B = Y + 1.772 Cb;
  those weights, the order and the fused steps decide the sums that fall
  within a hair of a whole number (about one pixel in twenty thousand),
  each tried against every pixel of the corpus's files. LibRaw then
  holds a black level of 1024 (already off) and a white level of 17536,
  so 16512, and develops these files with no white balance (its
  multipliers are all 1: the samples come balanced). The image is the
  sensor data's size the directory states (0x7038), from the top left,
  or LibRaw's own area for the frame where smaller. All 40 such files of
  the corpora (seven bodies) match LibRaw's develop.

### GoPro GPR

- `vc5.rs` ports GoPro's VC-5 decoder (its MIT option): the bitstream's
  header, the ten subbands of each of the four channels (GoPro's codebook
  17, cubic companding, quantization), the three inverse wavelets, and the
  channels recombined and taken through GoPro's log curve to 14 bits
  (RGGB sensors) or 12 (GBRG). On all 17 GPRs of the corpora it decodes
  the same samples as the C decoder it replaces, in about half its time;
  the C sources and their build are gone, their license texts kept beside
  the port's notes (third_party/gpr-vc5). heeler-raw's rewrite for
  LibRaw now calls the port, and the Rust develop reads a GPR's tile
  itself (compression 9). A neutral of zeros (the HERO10's) states no
  balance.
- Fifteen GPRs from seven bodies develop as LibRaw does. The HERO10's two
  files state no balance, and LibRaw then balances them from the picture
  with unequal greens, which the comparison does not yet model; they stay
  LibRaw's.

### Hasselblad 3FR and FFF

- `hasselblad.rs`, every rule found against LibRaw's frame: IFD0 states
  Make, Model, the orientation and AsShotNeutral; a sub-IFD holds the
  frame, 16-bit samples uncompressed or in Hasselblad's coding (a
  lossless JPEG header, predictor field 8, then the code stream read from
  32-bit little-endian words top bit first without byte stuffing; each
  row's predictors start at 32768; samples in pairs, both lengths' codes
  first, a length of 16 always -32768). The H4D-60's frames (9044 by
  6732) are coded less 256, which LibRaw adds back and takes as its black
  level. Where the frame states masked areas, the black level is the
  mean of their samples, rounded down; else the stated one. The stated
  strip length is the uncompressed size; the stream ends with the file.
- Verified: all 31 files of the 15 camera names (as their files name
  them) that have a calibration match LibRaw at every stage, with
  LibRaw's levels and with the file's own (each site's masked mean). The
  three FFFs that name their bodies "Hasselblad CFV-50c" and "Hasselblad
  X1DM2-50c" have no calibration yet.

### Epson ERF, Mamiya MEF, Samsung GX-1

- `plain.rs`: both state their frame in a directory of its own, 12-bit
  samples most significant bits first. An ERF's rows are blocks of 16
  bytes, 10 samples in the first 15; its maker notes ("EPSON") state each
  site's black level (0x0401) and the balance in 0x0E80's 16-bit numbers
  24 and 25, times 567 and 431 over 65536, red's and blue's multipliers
  (the ratios of LibRaw's multipliers to the coded numbers, the same on
  every file of all three bodies). An MEF states no
  black and no balance (daylight).
- Samsung's GX-1L and GX-1S are Pentax-made PEFs (pef.rs). Their notes
  state a black level and a balance, but LibRaw takes neither, so they
  read as black 0 with no stated balance.
- Verified: the three Epson bodies (6 files), the ZD (2) and the GX-1L
  (1); the GX-1S has no calibration yet.

### Leaf MOS

- `leaf.rs`: IFD0 holds the frame as one tile, uncompressed or a lossless
  JPEG whose scan numbers its two components 1 and 2 where its frame
  numbers them 0 and 1 (ljpeg.rs takes either), and Leaf's metadata
  records (0x8606, "PKTS" each). The back type (ShootObj_back_type) names
  the camera as LibRaw does; CaptProf_mosaic_pattern the CFA (1 red, 2
  and 3 green, 0 blue); NeutObj_neutrals the balance (the first number
  over red's, green's and blue's); ImgProf_rotation_angle 90 the
  orientation. The AFi-II 12 reads its sensor from both ends: JPEG line
  2k is row k, line 2k + 1 row h - 1 - k.
- Verified: the Aptus 22 (3 files, both codings). The Aptus 75 and
  AFi-II 12 decode to LibRaw's frame but have no calibration yet.

### Older Nikons

- Notes without the "Nikon" header (the D1, D1H, D1X: a directory at the
  notes' start, offsets from the file's) are read. Without WB_RBLevels
  the balance comes from an unenciphered ColorBalance record (0x0097:
  version 0100 red, blue, green, green at byte 72; 0102 red, green,
  green, blue at byte 10; 0103 red, green, blue, green at byte 20), else a
  Coolpix record of 2560 bytes (0x0014: red and blue times 256 at bytes
  14 and 16). LibRaw takes the D1 and the E5700 at 1 for each channel.
  The later ColorBalance versions are enciphered and stay LibRaw's.
- The older Coolpix NEFs (models E and digits) hold one strip of two
  fields, the even rows then the odd.
- The D1X's pixels are twice as wide as tall: LibRaw develops each of its
  1324 rows twice, at both sizes, and so does the develop. Its compressed
  NEFs state no linearization table and stay LibRaw's.
- Verified: the D1, D1H, D1X, D2H, D70, D70s, E5400, E8400 and E8800
  (18 files). The D50, D2Hs and D2X files state only enciphered balance
  records; they stay LibRaw's. The E5700's mosaic is of four colors (see
  Four-color mosaics).

### Fujifilm's earlier RAF layout

- The earlier bodies' raw section is no TIFF but the samples alone,
  16-bit little-endian words (big-endian on the S2Pro, as LibRaw reads
  it); record 0x100 holds the frame's height and width, 0x2FF0 the
  balance (green, red, green, blue) and 0x4000 the black levels by color
  (green, red, the other green, blue). The F700's and the GX680 back's
  samples LibRaw lays out its own way; they stay LibRaw's. The S5500 and
  S200EXR (4 files) match LibRaw; every other earlier frame decodes to
  LibRaw's frame.
- The other earlier bodies' sensors are turned 45 degrees (SuperCCD).
  `superccd.rs` holds the rules, found from LibRaw's output alone and
  exact on all 27 such files: each sample's place on the diagonal mosaic
  LibRaw demosaics (two layouts, by the frame's shape; the SR bodies'
  second frame unused), and the turn upright after the demosaic and
  before the color conversion (bilinear, single precision, the source
  position a step of the square root of one half). The develop places,
  demosaics, blends the highlights on the diagonal image, turns and
  converts; the S2Pro is turned a quarter whatever its EXIF says, as
  LibRaw turns it. LibRaw's default demosaic for these files is not its
  AHD but its PPG: against LibRaw asked for AHD the develop is exact on all
  27 files, against its default 35 to 51 dB. A PPG demosaic would be
  written from recall (the owner's call, as for ORF and Fujifilm's
  compression), so these bodies stay LibRaw's for now, and half size is
  declined. For the S2Pro, S5000 and S7000 LibRaw's balance is not record
  0x2FF0's, and where it comes from is not found.

### Fujifilm's lossy compression

- fuji.rs reads the lossy variant: a quantizer base for each line group
  of each block, stored before the blocks; each group's gradients,
  value count, code width and difference step follow from its base, and
  where the base exceeds 0, 1 or 2, samples with small gradients take
  small tables of their own (base 0, 1, 2 up to gradient sums 5, 6, 7,
  weighted 3). The outline was recalled, as for the lossless coding
  (flagged above); the details were settled by trial against LibRaw's
  frame. All 46 lossy files (18 bodies, Bayer and X-Trans) and the 76
  lossless ones match LibRaw's frame in every sample.

### Cameras LibRaw has no matrix for

- LibRaw develops a camera it has no matrix for in the camera's own
  colors. The matrix generator now records such cameras of the corpora
  (libraw_matrices.rs, rows without a matrix), and the develop takes
  the identity for them, and where a file states no balance, 1 for each
  channel. The Nikon ZR, Panasonic DC-L10, Canon EOS C50, Samsung GX-1S
  and Pentax Optio S4 (16 files) match LibRaw. The C50 states its black
  level (2048), which LibRaw, not knowing the body, develops at about 0;
  the develop keeps the stated level. The DiMAGE G600's files are a JPEG
  with the samples after it; LibRaw finds a balance in the JPEG's EXIF
  segment outside any tag, which two files cannot make a rule of, so they
  stay LibRaw's.

### Monochrome sensors

- A LinearRaw frame of one sample a pixel develops as LibRaw develops
  it: the black level off, each sample times 65535 over the white level
  less the black in single precision, truncated, the value in all three
  channels, at full size whichever size is asked for. The Leica M
  Monochrom and M Monochrom (Typ 246) and the Pentax K-3 Mark III
  Monochrome's DNG and PEF (pef.rs reads photometric 34892 as monochrome)
  match LibRaw.
  LibRaw's white balance headroom for such a frame comes from multipliers
  it never applies; the develop's is 1.

### Samsung's compressed SRWs

- `srw_codec.rs`, every rule found from the files against LibRaw's frame:
  32770 in fewer bytes than 1.5 a sample (rows from a row offset table,
  0xA010; blocks of 16 columns, a mode bit and four groups' length codes,
  each group's samples differences in two's complement, predicted from
  the row above or two above or from the block before; the coded frame's
  2 by 2 cells transposed), 32772 (one stream of prefix coded length
  classes, each sample predicted two to the left, the first two of a row
  from two rows up) and 32773 (rows on 16-byte boundaries, blocks like
  32770's with eight predictors and, in the lossy variant, a quantizer
  each 64 columns). All 51 SRWs of the corpora match LibRaw; ten more
  bodies verified.

### Kodak's later KDCs

- `kodak.rs`: Kodak's directory (0xFE00) states the frame's width and
  height (LibRaw's height that rounded up to even), a white balance mode
  and six presets; IFD0's sub-IFD, offsets from byte 64, lists the strips.
  12-bit samples most significant bits first. Modes 0, 3 and 6 take the
  first, fourth and sixth presets (the only modes the files hold; others
  are declined). The Z981, Z990, Z1015 IS, P712 and P880 (10 files) match
  LibRaw. The DC120 and DC50 (their own codings) stay LibRaw's.

### Kodak's DCRs

- `kodak_codec.rs` decodes compression 65000: each row in segments of
  256 samples (0xFDE8), each segment at its offset in 0xFDE9, a block of
  4-bit lengths and then the differences (least significant bits first
  from big-endian words), each sample the difference plus the one two to
  its left, through Kodak's curve (0x090D of Kodak's directory, 0x8290).
- `dcr.rs`: the frame is the widest compression 65000 sub-IFD; the white
  level is the curve's last entry (3700 or 4095). The balance is the
  RATIONAL triple at 0x0848 plus the mode in 0x03FC, each multiplier
  green's level squared over its own, the fraction dropped. The DCS760C,
  DCS Pro 14N, 14nx and SLR/n (8 files) match LibRaw with Heeler's own
  numbers; the SLR/c matches to the demosaic with LibRaw's numbers, but
  LibRaw takes a balance for it that the file does not state, so it
  stays LibRaw's.

### Kodak's raw TIFFs

- `dcs.rs`: the frame is the widest sub-IFD of one sample a pixel in one
  strip. The DCS460D and EOS DCS 1 and 3 hold a byte a sample (the
  directory states no compression, and photometric 1) through IFD0's
  0x0123 (256 SHORTs), LibRaw's image area 2 columns in, no stated
  balance. The DCS520C and DCS560C hold a 12-bit lossless JPEG through
  Kodak's 0x090D, their balance read as a DCR's; their black levels (178
  and 177) are LibRaw's for the cameras, since no tag or sample of the
  files moves them. The white level is the curve's last entry. All five
  bodies (10 files) match LibRaw.
- The EOS D2000C (Kodak's body under Canon's name) is read the same way
  as the DCS520C; its black level is the mean of Kodak's 0x03EF and
  0x03F0, the fraction dropped, as LibRaw's moves with those tags (2
  files match LibRaw).

### Canon's raw TIFFs

- `canon_tif.rs`: the EOS-1D's and EOS-1DS's directories hold only
  thumbnails; the frame is a 12-bit lossless JPEG at the Canon maker
  notes' 0x0081, two components a line, each line two frame rows. The
  balance is the first three SHORTs of the maker notes' 0x00A4, the black
  level 0, the white level LibRaw's (3616, geometry.rs). Both bodies (4
  files) match LibRaw. Phase One's raw TIFFs are IIQs inside and read as
  such.

### The DC120, C330, C603 and Sinar's STI

- The DC120's KDCs (`kodak.rs`): an 848 by 976 frame, uncompressed with
  each row rotated or a byte-swapped baseline JPEG (`kodak_codec.rs`),
  white levels 255 and 510. Its pixels are narrow: LibRaw's image is 244
  over 159 times as wide, each column a source column picked by a running
  sum of 159 over 244 in double precision, no blending (the develop's
  `widen`). 5 files match LibRaw at both sizes.
- The C330's and C603's headerless files (`headerless.rs`, by size): the
  C603's 8-bit mosaics through Kodak's exponential curve or the header's
  own (CFAI), and both cameras' YRGB images, three colors a pixel through
  the same curve, developed as three-color images in LibRaw's own colors.
  11 files match LibRaw.
- The Raspberry Pi camera's IMX219 captures (`rpi.rs`): a JPEG with a
  "BRCM" block at its end, a 32768-byte header naming the sensor and
  mode, then rows of 10-bit samples four in five bytes; the balance the
  maker note's "gain_r=" and "gain_b=", the black level LibRaw's for the
  sensor (66). Both files match LibRaw.
- RW2 RawFormat 7: LibRaw leaves the rows below the sensor's stated
  bottom (0x04 plus 0x06) at 0; the DC-S5's high-resolution file, two
  rows taller, matches LibRaw so.
- The DiMAGE G600's balance (headerless.rs): four big-endian SHORTs at
  byte 2030 of the file, inside the EXIF segment but outside any tag
  (found by changing the file's bytes one at a time against LibRaw's
  numbers), red, blue and both greens, the greens 256. Both files match
  LibRaw. The HERO10 Black's GPRs (2) match too.
- The PowerShot A610's and S2 IS's CRW-named headerless frames are one
  size; LibRaw names the camera by the byte at 36684 (16 or more the S2
  IS's, found by changing it), and develops another image area than its
  other files of that size (the headerless table now carries it). The S2
  IS matches LibRaw; the A610 and the S100's frame match with LibRaw's
  black level but not with the border's as measured, and stay LibRaw's.
- The Phase One P40+ and P65+ (`iiq_quarters.rs`): each quarter's curve a
  cubic spline through (0, 0), each of 0x041F's 16 levels paired with the
  four quarters' mean at it (rounded half up) and (65535, 65535), the
  slope 1 at the top, after a gain of 1 plus 0x041E's float for the
  quarter. With two fixes to the grids (held to 0 to 65535 before them
  and after each; each applies short of its stated size by a spacing),
  which leave no IIQ worse, the 9 files develop at 83 to 98 dB against
  LibRaw (none to the bit) and join the backs held within the tolerance.
- Nikon's film scans (`coolscan.rs`): an RGB image, LibRaw's white the
  depth's largest sample (never lowered), its balance made from the
  picture in 8 by 8 blocks (a block with a sample past the white less 25
  left out), no matrix. The 16-bit scans (V ED, SUPER COOLSCAN 5000 ED,
  4 files) match LibRaw; the 8-bit IV ED is declined (LibRaw takes its
  white as 255 though its samples reach 65535, so its output is all 0 or
  65535).
- Sony's pixel shift ARQs (`arq.rs`): four samples a pixel combined in
  the file, LibRaw's image the samples as stored; the develop takes the
  black off, lowers the white to the brightest of all four samples, and
  drops the other green. Both files match LibRaw with highlights
  clipped; blending (which mixes the fourth sample) is declined.
- Sinar's STI (`sinar.rs`): one tile of 16-bit samples, its directory's
  own orientation, the balance the "Neutral" line of IFD0's 0xC517. The
  one file matches LibRaw.
- LibRaw's matrices for the DC120, DC50, Sinarback and (none) C330 and
  C603 are generated with the rest (`examples/libraw_matrices.rs` now
  also reads KDC, DCR, TIF and STI files, and records a three-color
  camera LibRaw develops in its own colors).

### Linear DNGs

- A linear DNG of three samples a pixel (photometric 34892), uncompressed
  or in lossless JPEG (its lines running on across a piece's rows),
  through its linearization table, develops by the three-color plan
  (as a Canon sRAW does), its balance AsShotNeutral's reciprocals in
  single precision. All 15 such files of the corpora with a black level
  of 0 and a stated neutral (Samsung's Galaxy phones, iPhone ProRAW and
  a third-party camera app's, the Light L16, the sd Quattro, converter
  and denoiser output) match LibRaw at both sizes. JPEG XL DNGs are
  heeler-io's (never LibRaw's). A scanner's DNG stating its white as
  AsShotWhiteXY (the LS-5000's) takes the neutral its one color matrix
  gives that white; it matches LibRaw.
- The Phase One P45's raw TIFFs (named P45, not P45+) take the P45+'s
  image area and develop within the IIQ calibration's tolerance (65
  dB).
- Lossy DNGs (`lossy_dng.rs`): LinearRaw tiles of baseline JPEG
  (compression 34892), each YCbCr turned to RGB in 16-bit fixed point,
  each color through a 256-entry curve from its plane's MapPolynomial
  (OpcodeList2), floor(65535 p(v / 255)) in double precision; LibRaw's
  white level is then 65535. The corpus's two (a full-size and a
  downscaled conversion) match LibRaw at both sizes. A lossy CFA image,
  other sampling or transforms, and other opcodes are declined.
- The comparison harness takes LibRaw's balance from the picture only
  where the file states none (a Pixel 8 Pro's DNG): LibRaw takes it after
  the gain maps, so the harness now applies them before it looks.

### Smaller fixes, 2026-10-25

- A DNG before version 1.1 whose lossless JPEG gives a difference 16
  bits: LibRaw reads the difference's 16 bits after the code, where T.81
  gives it none (found on a YI 4K file, exact once read so). The decoder
  does not yet take the option, so such files (two of the corpora) are
  declined and stay LibRaw's.
- The DSC-R1's SR2 block keeps its black level under 0x7300 and its
  balance under 0x7303 (green, red, blue, green), and its 16-bit words are
  big-endian in its little-endian file; the geometry generator now takes
  SR2, SRF and ARQ files. Both R1 files match LibRaw.

### Four-color mosaics

- Four cameras of the corpora have sensors of four colors: the PowerShot
  G1 (CMYG, CRW), the PowerShot Pro70 (CRW, a pattern of 8 rows), the
  E5700 (CMYG, NEF) and the DSC-F828 (RGBE, SRF). `four_color.rs` holds
  LibRaw's develop of them, every rule found against its stages and
  output, to the bit: the black of each color off and the white level
  lowered as for three colors, four multipliers, the clip level the
  smallest of the four; at full size the variable number of gradients
  (eight gradients of same-colored pairs from two tables turned to each
  direction, the threshold the smallest plus half the largest, each
  direction's estimates the 4, 2, 1 weighted means of the 3 by 3 around
  its neighbor, the own color's the mean of the site and the sample two
  steps on where that is of its color), the edge band two pixels wide
  interpolated apart (3 by 3 means, weighted on the inner ring); at half
  size each 2 by 2 block one pixel; the highlights blended through the
  four sign patterns [1, 1, 1, 1], [1, -1, 1, -1], [1, 1, -1, -1],
  [1, -1, -1, 1] (that order fixes the rounding); the 3 by 4 matrix's rows
  summed first two, then third and fourth.
- A four-color file reads as a Dng of an 8 by 2 pattern of LibRaw's color
  indices (`Dng::four_colors`), and its plan carries the pattern and the
  3 by 4 matrix (`Plan::four`). The geometry generator records LibRaw's
  area, pattern, white and black levels for such cameras
  (`FOUR_GEOMETRY`), the matrix generator their XYZ to camera matrix,
  four rows of three (`LIBRAW_MATRICES_4`): LibRaw's 3 by 4 inverted (its
  pseudoinverse), each row divided back by LibRaw's daylight multiplier,
  sRGB's primaries in XYZ, rounded to LibRaw's four places. The develop
  turns it back as LibRaw does (`color::srgb_from_camera4`): sRGB's
  primaries in, rows scaled to sum to 1 (their reciprocal sums the
  daylight balance), the pseudoinverse; exact in single precision for all
  four cameras once the matrix's values are taken in single precision.
- The G1's CRW is Canon's coding (table 1, no low bits) and its balance
  the 0x102C words 60 to 63 (LibRaw's colors 2, 3, 0, 1). Its left border
  is 4 columns; its black (LibRaw's 31 at every site after unpacking) is
  the mean, rounded down, of the run of live masked columns right of the
  area up to the first dead one (under three quarters of the column two
  in), two in from either end (found on its one file). The NEF reader now
  takes the largest CFA frame of a file: the E5700 also keeps a 656 by
  484 one marked as the full image. The Pro70's CRW states no
  sensor size: its frame is the geometry row's whose 10-bit samples fill
  the samples' record (1552 by 1024), the samples packed most significant
  bit first through 16-bit little-endian words (`Coding::SwappedWords`),
  its black 34 and white 1023 LibRaw's, and it states no balance, so it
  develops in daylight. The E5700's NEF is the older Coolpix's two
  fields, balance 1 for each color as LibRaw takes it.
- Verified: the G1, Pro70 and E5700 (5 files, two of them copies), exact
  at full and half size, highlights clipped and blended, with LibRaw's
  numbers and with the develop's own (the Pro70's balance then daylight,
  LibRaw's taken from the picture).
- Open: the DSC-F828. Its frame is the file's last 3360 by 2460 16-bit
  big-endian samples (IFD0 states their byte count and no offset),
  enciphered as 32-bit big-endian words with the SR2 keystream (sony.rs)
  from a key per file; `four_color::unpack_srf` reads it given the key,
  exact against LibRaw's frame with the key recovered from the keystream
  itself. Where the file keeps the key is not derived, so the camera
  stays LibRaw's. LibRaw also takes other black levels for it at half
  size than at full (colors 2 and 3), not explained.
- The Sony ILCE-7RM3's pixel shift ARQ reports four colors too; it has no
  mosaic and is the three-color path's (arq.rs).

### Still to do in this phase

- Nikon's small raw (D810, D810A, D4S): 12-bit YCbCr 4:2:2 packed least
  significant bits first, two luma, Cb, Cr; LibRaw's conversion includes
  a curve not yet worked out. Nikon's film scanner NEFs (Coolscan).

## Cameras without a converter calibration

- Heeler's calibration table comes from DNGs a converter wrote, so a
  camera no converter reads has no row: the firmware and action cameras
  above, and bodies newer than the installed converter. Such a camera
  takes the matrix LibRaw develops it with, kept in a table of its own
  (`libraw_matrices.rs`, generated by heeler-raw's example
  `libraw_matrices`): LibRaw's camera to sRGB matrix inverted, each row
  scaled back by LibRaw's daylight multiplier, as one D65 XYZ to camera
  matrix. `cameras::find` reads it only where the calibration table has
  no row.
- Of the 39 cameras of the corpora that had no calibration, 35 take one
  this way and 30 join the verified list: 19 headerless, the EOS R5 C and
  R6 Mark III, the D810A, OM's PEN, the DC-FZ45, DC-S5D and DC-TZ220D,
  and Sony's RX10 V, RX1R III, A7 V and A7R VI. LibRaw has no matrix for
  the EOS C50, the Nikon ZR, the DC-L10, Samsung's GX-1S, the G600, the
  Optio S4 and the WB550, which stay declined.
- After the calibration table is next regenerated with a newer
  converter, regenerate this one: a camera the converter has gained
  drops out of it.
- 2026-10-24, converter 18.7: four cameras gain a converter calibration
  (the EOS R6 Mark III, the X-T30 III, the RX1R III and the A7 V), and
  the first three leave this table, which now holds 32. The converter's
  rows for the Raspberry Pi sensors carry one generic matrix for three
  different sensors and no illuminants, so they are left out. The
  existing 771 rows are kept as they were: this converter writes newer
  profiles for 731 of them (other ForwardMatrix values for 562, other
  ColorMatrix values for 263, and hue and saturation tables for nearly
  all), and taking those would move the color of most cameras, which is
  the owner's call and not part of filling in missing cameras.

## IIQ

- `iiq.rs` reads Phase One's container (a directory of 16-byte entries
  at byte 8) and decodes codings 3, 5 and 8: coding 8 is coding 3's
  stream with 16-bit samples, coding 5 coding 3's through a square-law
  table (4 c i^2 rounded, i a quarter of the sample, c found between
  0.2519525 and 0.2519527 from every value the files hold). `iiq_s.rs`
  decodes coding 6 (the later backs' IIQ S: groups of 8 samples, each
  parity's range and the group's width coded before it, differences
  scaled by the range, so lossy) and coding 0 (uncompressed), found
  against LibRaw's frame. All 68 IIQs of the corpora decode to LibRaw's
  frame. The container's 0x0100 of 1 turns the frame (orientation 6).
- `iiq_cal.rs` applies the sensor calibration LibRaw applies after the
  unpack, every rule found from the files against LibRaw's loaded image
  (its header lists them): the black level and each half's row and
  column offsets, each quarter's response curve (0x0431), the right
  half's and the whole sensor's response, the defect list, and the gain
  grids in the block's order, with LibRaw's single-precision steps and
  rounding. LibRaw's white is then 65532 less the black. The P40+ and
  P65+ calibrate by rules not found exactly and are declined.
- Verified: the IQ150, IQ3 100MP (and Trichromatic), IQ4 150MP, iXM-100,
  iXM-RS150F and iXU-RS1000 develop as LibRaw does to the bit (24 files).
  The Credo 40, H 25, IQ140, IQ180, iXU180, P20+, P25, P25+, P30 and P45+
  (35 files) develop within 65 dB of LibRaw or better: their defective
  columns (LibRaw's rule for them is not found; the mean of the columns
  two to each side is used),
  the quarter curves' spline arithmetic and the H 25's float flat field
  differ slightly. The owner allowed IIQ's calibration to be verified by
  tolerance; the corpus test holds them to a 60 dB floor (NEAR_FLOOR_DB,
  verified.rs's NEAR).

## Color sources, measured

Every non-DNG format needs a camera matrix the file does not carry, and
the choice of source is the owner's (above). This section measures the
candidates, so the choice rests on accuracy and not on which program a
number came from. The harness is `crates/heeler-raw/examples/colorcheck.rs`;
every score is the mean CIEDE2000 (lower is better; about 1 is a just
noticeable difference side by side) against reference values.

The sources:

- LibRaw's matrix: the one Heeler develops with today, a single matrix a
  camera for daylight: its table's, or, for some makers (Olympus, Pentax,
  Samsung, Phase One and others), the matrix the camera writes in its
  own maker notes, which LibRaw prefers when the develop asks for the
  camera's matrix, as Heeler's does.
- The DNG model: the DNG specification's own color model (chapter 6),
  which blends a camera's two calibrations (Standard Illuminant A and D65)
  by the color temperature of the scene's white, through the
  ForwardMatrix where there is one. The tags come from DNGs written from
  the same raw files by the converter most raw workflows use to write
  DNGs; those
  per-camera numbers are the de facto industry reference, and LibRaw's own
  table largely descends from them. "ColorMatrix only" is the same model
  ignoring the ForwardMatrix.
- A fit to the measured sensitivities: a 3 by 3 matrix fitted from the
  camera's spectral sensitivities as the Academy Software Foundation's
  ACES camera data (Apache-2.0) gives them, which is independent of every
  raw converter.
- The chart's own fit: a 3 by 3 matrix fitted to the very shot, each
  patch scored by a fit that never saw it. No single matrix does better on
  that shot; it shows what the shot itself allows.

### On real charts

The corpus holds five raw shots of X-Rite charts with published reference
values: four Digital ColorChecker SG (140 patches, the edition before
November 2014, as their print shows) and one ColorChecker Classic (24
patches, the edition after). No DNG among them, and none of the cameras
in the spectral data. Each patch's mean camera RGB is read from LibRaw's
unpacked mosaic (no demosaic), white balanced on the chart's own neutral
patches, taken to XYZ by each source, and its exposure matched on the
neutrals. The windows behind the SG charts throw a few percent of veiling
light into every patch (the black patches read L* 22 to 35 against 6.5),
so the main scores subtract that flare, estimated from the neutral
patches, the same for every source. Mean CIEDE2000, and in brackets the
mean over the patches of L* 25 or more:

| Shot | LibRaw matrix | DNG model, converter's tags | DNG model, ColorMatrix only | Chart's own fit (cross-validated) | Without flare correction: LibRaw / DNG model / fit |
|---|---|---|---|---|---|
| Hasselblad CFV-50 (FFF), SG, daylight | 3.85 (2.96) | 3.96 (3.05) | 3.96 (3.05) | 2.78 (1.90) | 4.14 / 4.20 / 3.81 |
| Hasselblad H5D-40 (FFF), SG, daylight | 3.63 (2.78) | 3.64 (2.79) | 3.64 (2.79) | 2.70 (1.90) | 4.46 / 4.46 / 4.23 |
| Hasselblad H5D-50c (FFF), SG, daylight | 3.10 (1.94) | 3.04 (1.93) | 3.04 (1.93) | 2.39 (1.29) | 4.09 / 4.12 / 3.98 |
| Nikon D5 (NEF), SG, daylight | 3.38 (2.11) | 3.39 (2.12) | 3.30 (1.97) | 3.16 (1.76) | 7.02 / 7.03 / 5.85 |
| Olympus E-M1 Mark II (ORF), Classic, tungsten | 6.10 (6.21) | 4.60 (4.65) | 4.61 (4.66) | 4.49 (4.55) | 5.88 / 4.61 / 4.66 |

### Simulated from measured sensitivities

For the 49 cameras with both measured spectral sensitivities and a corpus
file, the camera's response to 190 measured surface colors (the data
set's training patches) is simulated under CIE D65 and Standard
Illuminant A and scored the same way. The fit to the sensitivities is
fitted on half the patches and scored on the other half; it is scored by
the same sensitivities that made it, so it shows how far each matrix is
from the best a 3 by 3 matrix can do for that sensor, not an independent
check of the sensitivities. Median over the cameras:

| Illuminant | LibRaw matrix | DNG model, converter's tags | DNG model, ColorMatrix only | Fit to the sensitivities (held out) |
|---|---:|---:|---:|---:|
| D65 | 2.19 | 2.17 | 2.21 | 1.04 |
| A | 3.69 | 2.73 | 2.81 | 1.46 |
| D65, without the 3 Fujifilm | 2.06 | 2.05 | 2.08 | 1.02 |
| A, without the 3 Fujifilm | 3.65 | 2.73 | 2.73 | 1.46 |

Under A the DNG model (ForwardMatrix or ColorMatrix, whichever the file has) beats LibRaw's matrix by more than 0.1 on 45 of 49 cameras, LibRaw beats it on 4; under D65 the DNG model beats LibRaw on 0, LibRaw beats it on 3.

The three Fujifilm cameras' DNG profiles keep most of their color
correction in a hue and saturation table (their ForwardMatrix is ProPhoto
RGB's own), which this model does not apply, so their full DNG model
scores are not that profile's real rendering; the ColorMatrix-only column
is the fair one for them. Per camera:

| Camera | D65: LibRaw | D65: DNG model | D65: ColorMatrix only | D65: fit | A: LibRaw | A: DNG model | A: ColorMatrix only | A: fit |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Canon Digital Rebel XTi | 2.47 | 2.47 | 2.42 | 0.91 | 4.17 | 3.11 | 3.18 | 1.38 |
| Canon EOS-1D X Mark II | 1.66 | 1.65 | 1.67 | 0.89 | 3.36 | 1.86 | 1.92 | 1.38 |
| Canon EOS-1Ds Mark III | 1.96 | 1.97 | 1.99 | 1.00 | 4.21 | 2.60 | 2.57 | 1.33 |
| Canon EOS-1Ds Mark II | 2.02 | 2.02 | 2.06 | 0.88 | 3.48 | 2.69 | 2.74 | 1.22 |
| Canon EOS 100D | 1.39 | 1.41 | 1.47 | 0.99 | 3.78 | 1.84 | 1.76 | 1.46 |
| Canon EOS 200D | 1.60 | 1.60 | 1.68 | 1.10 | 3.62 | 2.04 | 1.97 | 1.33 |
| Canon EOS 5DS | 1.50 | 1.50 | 1.47 | 1.09 | 3.36 | 1.75 | 1.84 | 1.47 |
| Canon EOS 5D | 2.44 | 2.44 | 2.42 | 1.37 | 4.87 | 3.35 | 3.21 | 1.84 |
| Canon EOS 5D Mark III | 1.17 | 1.16 | 1.18 | 0.90 | 3.13 | 1.58 | 1.58 | 1.50 |
| Canon EOS 5D Mark II | 2.03 | 1.99 | 2.03 | 0.94 | 4.63 | 2.68 | 2.68 | 1.36 |
| Canon EOS 5D Mark IV | 1.55 | 1.55 | 1.51 | 1.00 | 3.69 | 2.11 | 2.22 | 1.47 |
| Canon EOS 600D | 1.45 | 1.45 | 1.49 | 0.94 | 3.76 | 1.94 | 1.82 | 1.47 |
| Canon EOS M | 1.21 | 1.21 | 1.25 | 1.02 | 3.55 | 1.61 | 1.61 | 1.49 |
| Canon EOS R10 | 2.19 | 2.17 | 2.24 | 1.06 | 3.64 | 2.78 | 2.81 | 1.26 |
| Canon EOS R5 | 2.40 | 2.39 | 2.44 | 0.89 | 4.51 | 3.17 | 3.22 | 1.43 |
| Canon EOS R5m2 | 2.02 | 2.00 | 2.01 | 0.99 | 4.00 | 2.96 | 2.91 | 1.52 |
| Canon EOS R6 | 1.80 | 1.75 | 1.88 | 1.04 | 3.78 | 2.86 | 2.90 | 1.54 |
| Canon EOS R6m2 | 2.34 | 2.33 | 2.36 | 0.98 | 4.42 | 2.98 | 3.13 | 1.44 |
| Canon EOS RP | 2.32 | 2.34 | 2.35 | 0.96 | 4.27 | 2.72 | 2.67 | 1.46 |
| Canon EOS R | 2.83 | 2.85 | 2.85 | 1.02 | 4.52 | 3.40 | 3.43 | 1.50 |
| Canon PowerShot S90 | 2.09 | 2.09 | 2.09 | 1.87 | 5.19 | 4.20 | 4.21 | 2.57 |
| Fujifilm GFX 100 | 4.28 | 7.47 | 4.33 | 1.84 | 5.85 | 6.65 | 3.66 | 2.16 |
| Fujifilm X-T3 | 3.04 | 7.72 | 3.06 | 1.80 | 5.06 | 6.75 | 3.35 | 2.13 |
| Fujifilm X-T4 | 3.20 | 7.79 | 3.00 | 1.83 | 5.43 | 6.85 | 3.82 | 2.18 |
| Hasselblad L1D-20c | 2.63 | 2.63 | 2.63 | 1.06 | 4.51 | 5.12 | 5.12 | 1.45 |
| Hasselblad L2D-20c | 3.95 | 3.95 | 3.95 | 1.39 | 4.95 | 4.45 | 4.45 | 1.91 |
| Nikon D200 | 2.53 | 2.53 | 2.53 | 1.51 | 3.61 | 3.23 | 3.24 | 1.65 |
| Nikon D3300 | 1.94 | 1.93 | 1.94 | 1.28 | 3.35 | 2.25 | 2.31 | 1.55 |
| Nikon D5100 | 1.25 | 1.25 | 1.25 | 1.21 | 3.79 | 1.54 | 1.55 | 1.49 |
| Nikon D5300 | 1.87 | 1.86 | 1.87 | 1.16 | 3.14 | 2.38 | 2.48 | 1.48 |
| Nikon D7000 | 1.23 | 1.23 | 1.23 | 1.12 | 3.65 | 1.40 | 1.40 | 1.36 |
| Nikon D700 | 2.22 | 2.22 | 2.22 | 1.26 | 3.39 | 2.73 | 2.71 | 1.43 |
| Nikon D70 | 2.51 | 2.51 | 2.51 | 1.21 | 3.58 | 2.91 | 3.05 | 1.60 |
| Nikon D800E | 1.43 | 1.45 | 1.43 | 1.11 | 2.94 | 1.50 | 1.51 | 1.41 |
| Nikon D810 | 2.36 | 2.38 | 2.36 | 1.13 | 2.99 | 2.62 | 2.65 | 1.40 |
| Nikon D850 | 1.78 | 1.79 | 1.78 | 1.15 | 3.42 | 2.43 | 2.42 | 1.58 |
| Nikon Z f | 2.38 | 2.32 | 2.38 | 1.26 | 3.84 | 3.20 | 3.16 | 1.53 |
| Panasonic DC-GX9 | 2.21 | 2.23 | 2.21 | 1.41 | 3.54 | 2.74 | 2.82 | 1.83 |
| Sony DSC-RX100M4 | 2.60 | 2.60 | 2.77 | 1.22 | 4.16 | 3.48 | 3.58 | 1.57 |
| Sony ILCE-6400 | 2.77 | 2.80 | 2.59 | 1.03 | 4.48 | 3.63 | 3.72 | 1.45 |
| Sony ILCE-7CM2 | 2.91 | 2.82 | 2.84 | 0.93 | 3.86 | 3.03 | 3.02 | 1.27 |
| Sony ILCE-7M3 | 2.44 | 2.47 | 2.28 | 0.98 | 3.56 | 2.73 | 2.84 | 1.32 |
| Sony ILCE-7M4 | 2.72 | 2.63 | 2.57 | 0.93 | 3.58 | 2.92 | 2.82 | 1.24 |
| Sony ILCE-7RM2 | 1.53 | 1.59 | 1.66 | 0.99 | 2.62 | 2.19 | 2.25 | 1.28 |
| Sony ILCE-7RM3 | 1.96 | 1.96 | 1.90 | 0.99 | 2.97 | 1.94 | 1.93 | 1.30 |
| Sony ILCE-7RM4 | 2.55 | 2.58 | 2.57 | 0.93 | 3.82 | 2.96 | 3.07 | 1.25 |
| Sony ILCE-7SM2 | 2.22 | 2.29 | 2.45 | 1.14 | 3.31 | 3.00 | 3.02 | 1.80 |
| Sony ILCE-7SM3 | 1.82 | 1.74 | 1.95 | 0.97 | 3.10 | 2.31 | 2.40 | 1.36 |
| Sony ILCE-9 | 1.71 | 1.71 | 1.65 | 0.96 | 2.73 | 2.48 | 2.50 | 1.29 |

### What the measurements say

1. In daylight, LibRaw's matrix and the DNG model are the same to within
   0.11 on every real chart and within a tenth on 46 of the 49 simulated
   cameras: LibRaw's table is the daylight half of the same calibration.
   On the real charts both sit within about one unit of the best a single
   matrix can do on that shot (1.9 to 3.0 on the lit patches).
2. Away from daylight LibRaw's single matrix falls behind. Under tungsten
   the DNG model is better on the real Classic chart (4.6 against 6.1, as
   good as the chart's own fit) and on 45 of the 49 simulated cameras (2.7
   against 3.7, median), because it moves to the camera's tungsten
   calibration as the white warms, and LibRaw keeps the daylight one.
3. Matrices fitted to measured sensitivities are about one unit closer to
   the sensor's best than either, in simulation. No chart shot in the
   corpus comes from those cameras, so this is not yet confirmed on real
   photographs.
4. The real charts cannot separate sources finer than about a unit: the
   shots' own light (flare, uneven light, the window's daylight against
   the charts' D50 reference) leaves even the chart's own fit at 2.4 to
   3.2.

### Recommendation

- For DNG, develop with the DNG model, the dual-illuminant blend and the
  ForwardMatrix, and later the profile's hue and saturation tables. It is
  what the file asks for, and it is measurably better than LibRaw's
  reading away from daylight. In daylight it changes nothing visible; under
  warm light it changes colors toward correct. That is a deliberate step
  away from matching LibRaw for those files, and the owner's to take.
- For the other formats, the dual-illuminant model needs two calibrations
  a camera, and LibRaw's table has one. That converter's calibrations
  are the most complete and the best measured here; whether Heeler may
  ship numbers read from another program's output is the open question.
  The spectral data is the independent source, for the cameras it covers.
- To confirm the spectral matrices, and to judge any source for a camera
  with no reference, shoot a ColorChecker in daylight and under tungsten
  with the camera. Two frames a camera settle it at the level this
  harness measures.

### Reproducing

The chart shots are in the corpus (`HEELER_RAW_CORPUS`):
`Hasselblad/CFV-50/20170401_CCSG_on_Hasselblad_CFV-50-0002297.fff`,
`Hasselblad/H5D-40/20151114_CCSG_on_Hasselblad_H5D40-0726.fff`,
`Hasselblad/H5D-50c/20151114_CCSG_on_Hasselblad_H5D50c-0017.fff`,
`Nikon/D5/20170603_CCSG_on_Nikon_D5-DSC3096.NEF` and
`Olympus/E-M1MarkII/Olympus_EM1mk2_Standard_20MP_ColorChecker.ORF`.
With `colorcheck preview` find the chart, then pass the preview
coordinates of the centers of the four corner patches (top left, top right,
bottom left, bottom right) to `mark` to check the boxes and to `chart` to
score, with a DNG written from the same file. At K = 4 the corners used
here were:

| Shot | Chart | Corner patch centers |
|---|---|---|
| CFV-50 | sg | 277,350 762,348 278,686 762,686 |
| H5D-40 | sg | 206,126 679,120 209,455 683,449 |
| H5D-50c | sg | 264,145 799,140 266,514 802,511 |
| D5 | sg | 172,48 502,47 174,276 503,275 |
| E-M1 Mark II | classic | 190,298 397,298 190,420 397,420 |

`COLORCHECK_FLARE=1` subtracts the flare. For the simulation, `spectral`
takes the ACES camera data's folder, a camera's sensitivity file, a raw
file from that camera (for LibRaw's matrix) and a DNG written from it.

## Camera calibrations for the other formats

The owner's decision (2026-10-20): the non-DNG formats take their two
calibrations from DNGs written by the converter most raw workflows use.
`crates/heeler-raw/examples/calibrations.rs` writes one small DNG from one
file of every camera folder in the corpus (the profile tags are the
camera's whatever the image size) and turns its profile into a row of
`crates/heeler-rawdec/src/calibrations.rs`, keyed by Make and Model;
`heeler_rawdec::cameras::find` looks a camera up and `Calibration::profile`
hands it to the DNG color model (`color::camera_to_xyz_d50`, the same model
the measurements above scored). The develop does not use the table yet:
it comes in with the first non-DNG format. The per-camera report is
`rust-raw-decoder/camera-calibrations.csv`.

```
cargo run --release -p heeler-raw --example calibrations -- CONVERTER WORK_DIR \
    crates/heeler-rawdec/src/calibrations.rs docs/rust-raw-decoder/camera-calibrations.csv
```

What the table holds, from the 859 camera folders with non-DNG files:

- 771 cameras. 733 have the usual pair (Standard Illuminant A and D65),
  8 a tungsten and D50 pair, 1 D55 and D75, and 28 a single calibration
  (scanners, a few old bodies). 736 have forward matrices. 58 profiles also
  carry hue and saturation tables (the Fujifilm bodies among them), which
  the matrices alone do not reproduce; the table marks them.
- 80 folders have no calibration: bodies newer than the converter
  installed here (Canon EOS R6 Mark III, Fujifilm X-T30 III, Sony ILCE-7M5,
  DSC-RX1RM3), Foveon cameras, Canon compacts running CHDK, and devices
  without a profile (Raspberry Pi sensors, action cameras). Running the
  generator with a newer converter adds the new bodies.

Against LibRaw's develop matrix for the same files (the daylight
calibration as a camera to sRGB matrix, element by element):

| | Cameras |
|---|---:|
| The same (within 0.002) | 544 |
| Close (within 0.05) | 13 |
| Different | 207 |
| LibRaw cannot open the sample | 7 |

The 544 are LibRaw's own table, which is the same converter's daylight
calibration. Of the 207 that differ, 125 match once LibRaw's preference
for a maker-note matrix is turned off: for those cameras (Olympus and OM
System, Pentax, Samsung, Phase One, Leaf, Kodak, some Panasonic and Sony)
Heeler develops today with the manufacturer's own matrix. The other 82 are
cameras whose entry in LibRaw's table holds other numbers (older
calibrations, or a sibling model's). For all 207 the table would change
the daylight color of what Heeler shows today, by amounts no measurement
here ranks except one: the Olympus E-M1 Mark II, whose real chart above
favors the table's pair under tungsten (4.6 against 6.1). The owner's
decision (2026-10-20): every camera takes the table's pair throughout,
these 207 included, so a develop never uses a maker-note matrix; their
daylight color changes from what Heeler shows today when their formats
move to the Rust path, and the release notes for that change should say
so.

Cross-check with the lab measurements: the table's pairs are the
calibrations the "DNG model" column above scored for the 49 cameras with
measured spectral sensitivities (2.17 under D65 and 2.73 under illuminant
A, median, against 2.19 and 3.69 for LibRaw's single matrix).
