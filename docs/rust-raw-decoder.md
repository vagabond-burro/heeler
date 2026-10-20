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
