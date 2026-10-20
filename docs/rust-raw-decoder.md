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
cargo run --release -p heeler-raw --example rawbench -- \
    --decoder libraw --runs 3 --csv libraw.csv
```

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
