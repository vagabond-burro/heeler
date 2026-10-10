# GoPro VC-5 decoder

The part of GoPro's GPR SDK that decodes the VC-5 tile inside a GoPro GPR
file, vendored so Heeler can read GPR without the rest of the SDK.

- **Source:** https://github.com/gopro/gpr, commit `446c736` ("Add support
  of 65x65 gain maps"), fetched 2026-10-09.
- **License:** Apache-2.0 or MIT, at the user's option (both texts are
  here, as upstream ships them). Heeler takes the MIT option.
- **Copyright:** (C) 2018 GoPro Inc.

## What is here

Only what decoding needs, copied unchanged except as listed below:

- `vc5_decoder/`: every `.c` and `.h` from `source/lib/vc5_decoder`.
- `vc5_common/`: every `.c`, `.h` and `.inc` from `source/lib/vc5_common`.
- `common/private/`: `gpr_allocator.c`, `gpr_buffer.c`, `log.c`, `log.h`,
  `macros.h`, `stdc_includes.h`, `timer.c`, `timer.h` from
  `source/lib/common/private`.
- `common/public/`: every header from `source/lib/common/public`.

Not vendored: the SDK's VC-5 encoder, its patched Adobe DNG SDK, the XMP
toolkit, expat, md5, tiny_jpeg, the C++ GPR reader and writer, and the
command-line tools. Heeler reads the DNG around the tile itself
(`crates/heeler-raw/src/gpr.rs`) and calls the decoder through one C
function (`crates/heeler-raw/src/gpr_shim.c`). The build is in
`crates/heeler-raw/build.rs` (`build_vc5`), with `GPR_READING=1`,
`GPR_WRITING=0`, `GPR_TIMING=0` and `NDEBUG`.

## Changes from upstream

The reference decoder trusts its input: it read past the end of a short
buffer, and many of its checks were `assert`s, which a release build
compiles out. A damaged GPR (a bad card, a truncated copy) crashed the
process. Every change is marked with a `Heeler:` comment, and each one
turns a crash into an error code without changing what a valid file
decodes to:

- `vc5_common/stream.h`, `stream.c`: memory reads (`GetWord`, `GetByte`,
  `GetBlockMemory`) are bounds checked. A read past the end returns zeros
  and sets the new `overrun` flag.
- `vc5_decoder/vc5_decoder.c`: a decode whose stream overran returns
  `CODEC_ERROR_FILE_READ`.
- `vc5_decoder/decoder.c`:
  - the channel count, channel number and subband number from the header
    are range checked before they index fixed arrays;
  - a run that would extend past its band, or a band wider than its
    pitch, returns `CODEC_ERROR_DECODING_SUBBAND`;
  - a wavelet the header never sized is skipped when the transforms are
    reset, and decoding into it returns `CODEC_ERROR_UNEXPECTED`.

These were found by decoding thousands of damaged copies of real HERO7
and HERO11 tiles under AddressSanitizer, and each case that crashed
before now returns an error.
