# Test fixtures

## GOPR0055.GPR

A GoPro HERO7 Black raw photograph (4000 by 3000, ISO 100, 1/1079 s) of a ColorChecker Passport in daylight, from the [raw.pixls.us](https://raw.pixls.us/) sample archive, where its uploader released it under [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) (public domain). It is the archive's entry dated 2018-12-11, "Native WB under Daylight w/ ColorChecker Passport (Legacy)".

- Size: 3,045,278 bytes
- SHA-256: `f7d8a5b693bc173a777164dbad48921c8d145d602d5422925a13090404514b66` (as the archive lists it)

It is the smallest GPR in the archive. `tests/gpr_fixture.rs` decodes it in heeler-raw, and heeler-io's tests open it on every path and develop it inside a stack frame's memory slice, so a real VC-5 tile is decoded on every test run. The wider set of GoPro samples, HERO5 to HERO11 and the Fusion, is run by the ignored test in `tests/gpr_samples.rs`.

## IMG_3310.CR2

A Canon PowerShot G11 raw photograph (3648 by 2736, ISO 400, 1/320 s at f/8) of a street of houses under an overcast sky that is blown out, about a fifth of the frame at the sensor's white, from the [raw.pixls.us](https://raw.pixls.us/) sample archive, where its uploader released it under [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) (public domain). It is the archive's entry dated 2018-09-12.

- Size: 12,322,820 bytes
- SHA-256: `50ef4d6712c7add1c65ef4c48c74ac5017f24ff1789f1d8a8d5d9accd3aab0fa` (as the archive lists it)

`tests/highlight_neutrality.rs` develops it under clip and blend and checks that the blown sky comes out neutral rather than pink.
