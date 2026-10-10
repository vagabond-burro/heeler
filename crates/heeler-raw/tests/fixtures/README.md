# Test fixtures

## GOPR0055.GPR

A GoPro HERO7 Black raw photograph (4000 by 3000, ISO 100, 1/1079 s) of a ColorChecker Passport in daylight, from the [raw.pixls.us](https://raw.pixls.us/) sample archive, where its uploader released it under [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) (public domain). It is the archive's entry dated 2018-12-11, "Native WB under Daylight w/ ColorChecker Passport (Legacy)".

- Size: 3,045,278 bytes
- SHA-256: `f7d8a5b693bc173a777164dbad48921c8d145d602d5422925a13090404514b66` (as the archive lists it)

It is the smallest GPR in the archive. `tests/gpr_fixture.rs` decodes it in heeler-raw, and heeler-io's tests open it on every path and develop it inside a stack frame's memory slice, so a real VC-5 tile is decoded on every test run. The wider set of GoPro samples, HERO5 to HERO11 and the Fusion, is run by the ignored test in `tests/gpr_samples.rs`.
