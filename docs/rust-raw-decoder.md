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
  (gain_map.rs) around LibRaw's develop.
- GoPro GPR: the VC-5 tile is decoded first (gpr.rs, a vendored C library),
  then LibRaw develops the DNG it becomes.
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
2. The rest of DNG: the phones whose lens shading sits in opcode lists
   (77 corpus files are declined today for that alone; `gain_map.rs`
   already applies those maps in Rust and moves across), linear DNG (its
   develop is already Rust, only its metadata still comes from LibRaw), and
   Deflate.
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

- Windows and Linux: the bit-exact claim holds on Apple's arm64; the other
  platforms are covered by the tolerance above but have not been measured.
- The 64 files from cameras whose DNGs the rules accept but which are not
  verified, and the 77 phone and drone DNGs with lens shading opcodes
  (`gain_map.rs` moves across next).
- `heeler-io`'s banded export (`keep_develop`) still develops through
  `decode_sensor_with` and so takes the Rust path with the feature; its
  separate linear DNG path is unchanged.

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
