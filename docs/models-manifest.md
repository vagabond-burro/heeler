# The models manifest (models.json)

Companion to `latest.json`, the app update's list (read by
`apps/heeler-app/src-tauri/src/update.rs`). This is the models' list: how a
model's weights update without an app release, and how Heeler finds
them when Hugging Face, or one owner's repository there, goes away.

## Where it lives

`https://github.com/vagabond-burro/heeler/releases/latest/download/models.json`

The same rule as `latest.json`: the file rides the GitHub release
beside the installers, so the two publish together; the app reads
GitHub's stable `releases/latest/download/` redirect and never
`api.github.com`, which is rate limited to sixty calls an hour per
address. Before the first release the URL is a 404, and Preferences
says the list could not be reached.

## What the app does with it

Preferences > Models > CHECK FOR MODEL UPDATES fetches the file and
compares each entry's `version` against the version of the weights
installed here (the registry's pinned version, or the version an
earlier manifest update left in the model folder's `installed.json`).
An installed model with a newer entry is listed with both versions,
the download size and the entry's notes, and an UPDATE button. A
model that is not installed is never offered from here: its first
download comes from the tool that needs it, through the consent card,
with the registry's own pins.

Applying an update downloads through the same path the registry's
pins use: staged beside the models folder, hashed as it streams,
verified against the entry's `archive_sha256` and every file's pin
before anything is trusted, then renamed into place with an
`installed.json` recording the version and the pins. The loaded model
sessions are dropped first, so nothing serves from files being
replaced.

Upstream "latest" is never followed. An entry appears here only after
Vagabond Burro has run those weights through the tests: a new model
generation usually changes the input contract, and that needs code,
which is to say an app release. This file is for weights-only
refreshes: a better export, a quantization fix, a re-hosting.

## Format

```json
{
  "schema": 1,
  "models": {
    "<model id>": {
      "version": "YYYY.MM",
      "label": "what Preferences calls it (informational)",
      "notes": "one line shown beside the update (optional)",
      "kind": "file" | "zip",
      "urls": ["https://...", "https://... (mirror, tried in order)"],
      "archive_sha256": "64 hex characters",
      "archive_bytes": 12345,
      "files": [["name in the model folder", "64 hex characters"], ...],
      "extra": [
        { "name": "...", "urls": ["https://..."], "sha256": "64 hex", "bytes": 123 }
      ]
    }
  }
}
```

- `schema` is 1. A higher number is refused as written for a newer Heeler.
- `version` is `YYYY.MM` (a third number is allowed), compared as
  numbers, so `2026.10` is newer than `2026.9`.
- `kind` says whether the download is one plain file (`file`, stored
  under `files[0]`'s name) or a zip the listed `files` are extracted
  from (`zip`); anything else in a zip is ignored on principle.
- `urls` are tried in order and must be `https`. The pinned hash makes
  the sources interchangeable, so a mirror joins with one line.
- `extra` is for a model that ships as more than one plain file: an
  ONNX graph whose weights live in an external `.onnx.data` sibling.
  Every extra file is also listed in `files`, since `files` is what
  the app verifies on disk.
- Any entry with a non-https source, a hash that is not sixty-four hex
  characters, a file name with a path in it, or a missing size is
  refused whole, in words, before a byte is fetched.

## Publishing one

1. Vet the weights: pin them in `crates/heeler-vision/src/models.rs`
   on a branch, run the model tests (`cargo test -p heeler-vision`,
   plus the ignored real-model tests with `HEELER_VISION_BASE` set),
   and bump that model's `version`.
2. Regenerate this file's registry copy:
   `cargo test -p heeler-app print_models_manifest -- --ignored --nocapture`
   prints the whole manifest from the registry.
3. Add `notes` for the changed entry, and upload the file as
   `models.json` on the release, beside the installers and
   `latest.json`.
4. Upload the weights themselves as release assets too, and add the
   release URL as a second entry in that model's `urls` (in the
   registry and here). That is the mirror: an owner's Hugging Face
   repository being renamed or deleted then costs nothing. The first
   one is the `models` pre-release (pre-release on purpose, so it
   never becomes the "latest" release the app reads its update list
   from): the weight files, raw, plus `THIRD_PARTY_LICENSES.txt` and a
   `README.md`, with the license table and texts in the release body.
   Its name carries no date so the address never changes (2026-09-28); Heeler 2026.4 and later point there, and the earlier
   `models-2026.09` release stays up for older versions. Never replace
   a file in place: a changed model goes up under a new file name, so
   an older app still finds the exact file its pinned hash expects.
   Update the release body and README's "Last changed" line when a
   file is added. Keep each model's LICENSE text with its asset;
   Apache-2.0 and MIT both ask for it. Release assets have no
   bandwidth quota and take files up to 2 GB, which is why a Git fork
   with LFS (a gigabyte a month) is not the plan B.

## The registry's manifest today

Generated from the registry at the time of writing: every model at
its pinned version, each with two sources, upstream first and the
`models` release mirror second (created 2026-09-28 from the
`models-2026.09` files, every asset verified byte for byte against
the pins). Florence-2 (`florence_2_base`, added 2026-09-28) has its
five files (`florence_2_base_*`) on the same release, uploaded with the owner's
approval the same day and each verified by download against its pin;
Hugging Face, at a pinned revision, stays its first source. A check against this
file reads as current. The same text is kept as `docs/models.json`,
ready to upload with the next app release.

```json
{
  "models": {
    "birefnet_lite": {
      "archive_bytes": 224005088,
      "archive_sha256": "5600024376f572a557870a5eb0afb1e5961636bef4e1e22132025467d0f03333",
      "files": [
        [
          "model.onnx",
          "5600024376f572a557870a5eb0afb1e5961636bef4e1e22132025467d0f03333"
        ]
      ],
      "kind": "file",
      "label": "BiRefNet Lite (subject matte)",
      "notes": "",
      "urls": [
        "https://huggingface.co/onnx-community/BiRefNet_lite-ONNX/resolve/main/onnx/model.onnx",
        "https://github.com/vagabond-burro/heeler/releases/download/models/birefnet_lite.onnx"
      ],
      "version": "2024.09"
    },
    "depth_anything_v2_small": {
      "archive_bytes": 99060839,
      "archive_sha256": "afb6a5c28f3b6bf1618c6e43f02073ef9dfdc70e937502d51603e57b0a1df10c",
      "files": [
        [
          "model.onnx",
          "afb6a5c28f3b6bf1618c6e43f02073ef9dfdc70e937502d51603e57b0a1df10c"
        ]
      ],
      "kind": "file",
      "label": "Depth Anything V2 Small (scene depth)",
      "notes": "",
      "urls": [
        "https://huggingface.co/onnx-community/depth-anything-v2-small/resolve/main/onnx/model.onnx",
        "https://github.com/vagabond-burro/heeler/releases/download/models/depth_anything_v2_small.onnx"
      ],
      "version": "2024.06"
    },
    "florence_2_base": {
      "archive_bytes": 366591558,
      "archive_sha256": "2c7464fce495ea43b415b48afe7dbe84a9ebbe0cfe3c31fdd81c6dd66b39ff75",
      "extra": [
        {
          "bytes": 39390496,
          "name": "embed_tokens_int8.onnx",
          "sha256": "8818c58a214e53bf7e22c48bb4674c2fa3112b9539c3ce4075a2eac797b1ef74",
          "urls": [
            "https://huggingface.co/onnx-community/Florence-2-base/resolve/d59e079711c57174f29265539fb4cc9f0f335916/onnx/embed_tokens_int8.onnx",
            "https://github.com/vagabond-burro/heeler/releases/download/models/florence_2_base_embed_tokens_int8.onnx"
          ]
        },
        {
          "bytes": 173380723,
          "name": "encoder_model.onnx",
          "sha256": "b155b5a0e56a4244c62060751bb1b70dfe481015d0dbfa6d19b1912d9e58da0d",
          "urls": [
            "https://huggingface.co/onnx-community/Florence-2-base/resolve/d59e079711c57174f29265539fb4cc9f0f335916/onnx/encoder_model.onnx",
            "https://github.com/vagabond-burro/heeler/releases/download/models/florence_2_base_encoder_model.onnx"
          ]
        },
        {
          "bytes": 388421910,
          "name": "decoder_model_merged.onnx",
          "sha256": "6d6e1266d7f94f5d4ec9cc07d9c1f7b3e47049c9b0de7bbe82a91e62dfd152af",
          "urls": [
            "https://huggingface.co/onnx-community/Florence-2-base/resolve/d59e079711c57174f29265539fb4cc9f0f335916/onnx/decoder_model_merged.onnx",
            "https://github.com/vagabond-burro/heeler/releases/download/models/florence_2_base_decoder_model_merged.onnx"
          ]
        },
        {
          "bytes": 2297961,
          "name": "tokenizer.json",
          "sha256": "d69dcdb2323e124ac4f800cb9863ddccea0d7bb11e16125e8df3bd60f2f8aeac",
          "urls": [
            "https://huggingface.co/onnx-community/Florence-2-base/resolve/d59e079711c57174f29265539fb4cc9f0f335916/tokenizer.json",
            "https://github.com/vagabond-burro/heeler/releases/download/models/florence_2_base_tokenizer.json"
          ]
        }
      ],
      "files": [
        [
          "vision_encoder.onnx",
          "2c7464fce495ea43b415b48afe7dbe84a9ebbe0cfe3c31fdd81c6dd66b39ff75"
        ],
        [
          "embed_tokens_int8.onnx",
          "8818c58a214e53bf7e22c48bb4674c2fa3112b9539c3ce4075a2eac797b1ef74"
        ],
        [
          "encoder_model.onnx",
          "b155b5a0e56a4244c62060751bb1b70dfe481015d0dbfa6d19b1912d9e58da0d"
        ],
        [
          "decoder_model_merged.onnx",
          "6d6e1266d7f94f5d4ec9cc07d9c1f7b3e47049c9b0de7bbe82a91e62dfd152af"
        ],
        [
          "tokenizer.json",
          "d69dcdb2323e124ac4f800cb9863ddccea0d7bb11e16125e8df3bd60f2f8aeac"
        ]
      ],
      "kind": "file",
      "label": "Florence-2 base (what is in the picture)",
      "notes": "",
      "urls": [
        "https://huggingface.co/onnx-community/Florence-2-base/resolve/d59e079711c57174f29265539fb4cc9f0f335916/onnx/vision_encoder.onnx",
        "https://github.com/vagabond-burro/heeler/releases/download/models/florence_2_base_vision_encoder.onnx"
      ],
      "version": "2025.05"
    },
    "lama": {
      "archive_bytes": 208044816,
      "archive_sha256": "1faef5301d78db7dda502fe59966957ec4b79dd64e16f03ed96913c7a4eb68d6",
      "files": [
        [
          "lama_fp32.onnx",
          "1faef5301d78db7dda502fe59966957ec4b79dd64e16f03ed96913c7a4eb68d6"
        ]
      ],
      "kind": "file",
      "label": "LaMa (inpainting)",
      "notes": "",
      "urls": [
        "https://huggingface.co/Carve/LaMa-ONNX/resolve/main/lama_fp32.onnx",
        "https://github.com/vagabond-burro/heeler/releases/download/models/lama_fp32.onnx"
      ],
      "version": "2024.03"
    },
    "mobile_sam": {
      "archive_bytes": 36655105,
      "archive_sha256": "41aff2660b7531becfee21fb257c49933ddc892c554507bdb775bf504d443942",
      "files": [
        [
          "mobile_sam.encoder.onnx",
          "20deef402855b31222b528f52b04807e41ebe47216ac0e39a0729f43491a0209"
        ],
        [
          "sam_vit_h_4b8939.decoder.onnx",
          "22cf85e35d14182f4b4712364264c06b22edbef63f065189586f080ef4e2f325"
        ]
      ],
      "kind": "zip",
      "label": "Segment Anything (MobileSAM)",
      "notes": "",
      "urls": [
        "https://huggingface.co/vietanhdev/segment-anything-onnx-models/resolve/main/mobile_sam_20230629.zip",
        "https://github.com/vagabond-burro/heeler/releases/download/models/mobile_sam_20230629.zip"
      ],
      "version": "2023.06"
    },
    "scunet_color_real_psnr": {
      "archive_bytes": 3798678,
      "archive_sha256": "231be201ab413dbc999d7951caa9844846b93a12a40a41e037d6b5888ed4e88c",
      "extra": [
        {
          "bytes": 73138176,
          "name": "scunet_color_real_psnr.onnx.data",
          "sha256": "98825ea1210b641c71e5f052f582c70c49fd44b35387ebe2c034268c17df3feb",
          "urls": [
            "https://huggingface.co/Heliosoph/scunet-onnx/resolve/main/scunet_color_real_psnr.onnx.data",
            "https://github.com/vagabond-burro/heeler/releases/download/models/scunet_color_real_psnr.onnx.data"
          ]
        }
      ],
      "files": [
        [
          "scunet_color_real_psnr.onnx",
          "231be201ab413dbc999d7951caa9844846b93a12a40a41e037d6b5888ed4e88c"
        ],
        [
          "scunet_color_real_psnr.onnx.data",
          "98825ea1210b641c71e5f052f582c70c49fd44b35387ebe2c034268c17df3feb"
        ]
      ],
      "kind": "file",
      "label": "SCUNet (noise reduction)",
      "notes": "",
      "urls": [
        "https://huggingface.co/Heliosoph/scunet-onnx/resolve/main/scunet_color_real_psnr.onnx",
        "https://github.com/vagabond-burro/heeler/releases/download/models/scunet_color_real_psnr.onnx"
      ],
      "version": "2026.06"
    },
    "vitmatte": {
      "archive_bytes": 103885865,
      "archive_sha256": "bf28d2e0be2c073286e88d60ad649d7123da2749a2d99133fd1098d5887e0225",
      "files": [
        [
          "model.onnx",
          "bf28d2e0be2c073286e88d60ad649d7123da2749a2d99133fd1098d5887e0225"
        ]
      ],
      "kind": "file",
      "label": "ViTMatte (edge refinement)",
      "notes": "",
      "urls": [
        "https://huggingface.co/Xenova/vitmatte-small-composition-1k/resolve/main/onnx/model.onnx",
        "https://github.com/vagabond-burro/heeler/releases/download/models/vitmatte_small_composition_1k.onnx"
      ],
      "version": "2024.06"
    }
  },
  "schema": 1
}
```
