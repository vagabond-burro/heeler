# GoPro VC-5 decoder

The part of GoPro's GPR SDK that decodes the VC-5 tile inside a GoPro GPR
file. Heeler reads it through a Rust port of that decoder,
`crates/heeler-rawdec/src/vc5.rs`; this folder keeps the license texts the
port carries.

- **Source ported:** https://github.com/gopro/gpr, commit `446c736` ("Add
  support of 65x65 gain maps"), fetched 2026-10-09: `source/lib/vc5_decoder`
  and `source/lib/vc5_common`, the path the SDK's GPR reader takes for a
  raw tile.
- **License:** Apache-2.0 or MIT, at the user's option (both texts are
  here, as upstream ships them). Heeler takes the MIT option.
- **Copyright:** (C) 2018 GoPro Inc.

## How the port relates to the C decoder

On every GPR of the corpora (17 files, HERO5 to HERO11 and Fusion) the port
decodes the same samples as the C decoder Heeler built until 2026-10-25,
which itself decoded a sound tile to the same bytes as upstream. Only the
decode is ported: not the encoder, the RGB and reduced-resolution outputs,
the layer and metadata parts, logging or timing.

Where the C decoder trusted its input, the port refuses it with an error:
a stream that runs past the end of its tile, a header whose image size is
not the one the GPR declares (checked before anything is allocated), a
channel count other than 4, a pattern other than 2x2, odd image
dimensions, a wavelet narrower or shorter than 3, and channel and subband
numbers outside what the header declared. Those were the checks Heeler had
added to the C sources after decoding thousands of damaged copies of real
tiles; a damaged GPR is reported as damaged, never a crash.
