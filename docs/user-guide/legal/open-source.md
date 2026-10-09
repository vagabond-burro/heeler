# Open source notices

*This page is about the open-source components inside Heeler. Heeler's
own code is under the [Mozilla Public License 2.0](license.md); the
materials on this page retain their own licenses.*

Heeler is built on other people's work. This page says whose, under what
terms, and where to get the parts you are entitled to.

## LibRaw

Heeler reads RAW files with **LibRaw 0.22.2**, used under the
**Common Development and Distribution License, version 1.0 (CDDL-1.0)**.
LibRaw is offered under either the LGPL or the CDDL; Heeler takes the
CDDL option, and contains no GPL-family code.

Copyright © 2008-2024 LibRaw LLC (info@libraw.org).

The CDDL asks that the source for the covered code be available to
anyone who receives a binary built from it. The exact source Heeler
compiles, unmodified from the upstream 0.22.2 release, is published at:

> **https://www.heeler.app/source/libraw/**

That archive is the tree this build was made from, not a pointer at
whatever upstream happens to be today. Its SHA-256 is published beside
it so you can check the two match.

The full license text is in this app, on the [CDDL 1.0](cddl.md) page
beside this one, and it ships with the source as `LICENSE.CDDL` in the
root of that archive. Both are the same text: the page is generated from the
tree Heeler is built from, and a test compares them.

## zlib and libjpeg

Deflate-compressed and lossy DNG files need these two, and both are
linked in. mozjpeg also encodes the frames the viewer shows while you
edit.

- **zlib**, © 1995-2024 Jean-loup Gailly and Mark Adler, under the zlib
  license.
- **mozjpeg**, a libjpeg-turbo derivative, © the Independent JPEG Group
  and contributors, under the IJG and BSD-3-Clause licenses.

The IJG license asks for one sentence in particular, so here it is in
the words it asks for:

> This software is based in part on the work of the Independent JPEG Group.

Neither library has been altered.

## JPEG XL

Newer DNG files, both the lossy ones and floating-point HDR merges,
store their pixels as JPEG XL. Heeler reads those with
**jxl-oxide**, © its authors, under the **MIT or Apache-2.0** licenses,
at your option.

The library has not been altered.

## OpenEXR

Renders and HDR merges saved as OpenEXR are read with **exrs** (the
`exr` crate), a pure-Rust implementation of the format, © Contributors
to the exrs Project, under the **BSD-3-Clause** license,
which asks that this notice travel with the binary. The crate is not
affiliated with the OpenEXR project or the Academy Software Foundation,
whose format specification and sample images are likewise BSD-3-Clause,
© Contributors to the OpenEXR Project.
The Cryptomatte convention Heeler reads for object mattes is
© Psyop Media Company, LLC, also BSD-3-Clause.

The library has not been altered.

## Lensfun lens database

Heeler ships a snapshot of the **lensfun project's lens database**: the
XML files that describe lenses and their optical corrections, used to
recognize the lens a photograph was taken with. The database is used
under the **Creative Commons Attribution-Share Alike 3.0** license.

Copyright © the lensfun project and its contributors,
https://lensfun.github.io/

Only the database is included. The lensfun software library is not
part of Heeler: the files are read by Heeler's own code. The bundled
snapshot is unmodified; if Heeler ever ships an edited copy, the edits
will be published under the same license, as Share Alike requires. The
snapshot's origin and revision are recorded in the `lensfun-db` folder
that ships inside the app.

## Machine-learning models (downloaded, not bundled)

The smart selection, depth and noise-reduction tools, and the
assistant's optional picture reader, use machine-learning models that are **not
part of the installer**. Each is downloaded only when you ask, from
the source the download dialog names, and verified against a checksum
pinned in the app before it is trusted. Every model also has a second
source, a mirror of the same published files on Vagabond Burro's own
release page, tried when the first does not answer; the checksum is
the same either way. A downloaded model lives in Heeler's data folder
and can be installed, updated or removed from Preferences (see
[Downloaded models](../models.md)).

- **MobileSAM** (the Segment Anything image encoder, distilled) and
  the **Segment Anything mask decoder**, © Meta AI and the MobileSAM
  authors, under the **Apache License 2.0**: code and weights alike.
  The training data (SA-1B) is published by Meta under its own stated
  terms.
- **BiRefNet Lite** (the one-shot subject matte), © Zheng Peng and
  the BiRefNet authors, under the **MIT license**: code and weights
  alike. Its training corpus (DIS5K and related academic datasets) is
  academic in origin; the weights are published by the author under
  MIT, and Heeler uses them as published.
- **LaMa** (the fill behind Remove and the Finish Fill brush), ©
  Samsung AI Center and the LaMa authors, under the **Apache License
  2.0**: code and weights alike; ONNX packaging by Carve, also
  Apache-2.0. Its training corpus (Places2) is academic in origin,
  with research-oriented terms; the weights are published under
  Apache-2.0 and Heeler uses them as published. The fill only ever
  synthesizes pixels inside a mask you made on purpose, and only on
  your machine.
- **ViTMatte** (the Smart matte in Selection Polish), © the Hust
  Vision Lab and the ViTMatte authors: the code under the **MIT
  license**, the published weights under the **Apache License 2.0**;
  ONNX packaging by Xenova. Its training corpus (Composition-1k) is
  academic in origin; the weights are published as stated on the
  author's model card, and Heeler uses them as published. The matte
  reads only the photograph and your own selection, on your machine.
- **Depth Anything V2 Small** (the scene-depth plane behind Fog,
  Depth Lighting, Depth of Field, and depth-range selections), © the
  Depth Anything authors, under the **Apache License 2.0**: code and
  weights alike; ONNX packaging by the Hugging Face onnx-community.
  Only the Small variant is used: the Base and Large weights carry a
  non-commercial (CC-BY-NC) license and are deliberately not offered.
  The plane is relative depth computed from your photograph, on your
  machine.

- **SCUNet** (Noise Reduction's Model method), © Kai Zhang and the
  SCUNet authors, under the **Apache License 2.0**: code and weights
  alike (the weight release in the KAIR repository is under MIT);
  ONNX packaging by Heliosoph, also Apache-2.0. It was trained on
  synthesized noise over public image sets, academic in origin; the
  weights are published as stated and Heeler uses them as published.
  The model reads only your photograph, on your machine.

- **Florence-2 base** (what the assistant knows is in a photograph:
  captions, objects and where a phrase is), © Microsoft Corporation,
  under the **MIT license**: code and weights alike; ONNX packaging by
  the Hugging Face onnx-community, also MIT. It was trained on FLD-5B,
  Microsoft's own dataset of 126 million images with 5.4 billion
  annotations, which Microsoft made largely with its own models and
  filtered; the weights are published under MIT and Heeler uses them
  as published. It reads only the frame on screen, on your machine.

The models are run by **ONNX Runtime** (© Microsoft, MIT) through the
**ort** bindings (MIT or Apache-2.0). Nothing your photographs contain
is uploaded for these models' inference: each runs on your machine.
The optional assistant can send text measurements and descriptions of
the photograph to the model server you choose on your computer or local
network, as described in the [Privacy Policy](privacy-policy.md).

## Rust and JavaScript libraries

Heeler links several hundred open-source Rust crates and bundles a few
JavaScript libraries, nearly all of them under the MIT, Apache-2.0,
BSD or Zlib licenses. Those licenses ask that their text travel with a
binary built from them, so every one of them is reproduced, crate by
crate, on the [Third-party notices](third-party-notices.md) page beside
this one. That page is generated from the exact crates the macOS,
Windows and Linux builds link, and a test fails when a crate is added without
regenerating it.

## Terms and warranties

The components above are provided by their own authors **as is**, with
no warranty of any kind. Their licenses say so, and nothing here changes
that.

Any warranty, support or liability that Heeler offers you is offered
**by Heeler alone**. It does not come from LibRaw LLC, the Independent
JPEG Group, or any other author whose work is named on this page, and
none of them takes on any obligation to you because their code is inside
Heeler. Heeler indemnifies them against any claim arising from terms
Heeler has offered.

Nothing in Heeler's own license limits or alters your rights in the
source code covered by the CDDL. Where the two ever appear to disagree
about that source, the CDDL wins.

## Heeler itself

Heeler's own code is open source under the
[Mozilla Public License 2.0](license.md). The license does not replace the
separate licenses of the components, fixtures or downloaded models
described here, and grants no rights to the Heeler name or logo
([Heeler name and logo](trademark.md)).

The source repository includes an unmodified JPEG XL test payload from
the libjxl testdata contributors under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
Its accompanying attribution records the original source and explains
that the test adds a generated DNG wrapper; that fixture is not covered
by the MPL and is not part of the installer.

## HEIC / HEIF photographs

Heeler contains no HEVC decoder of its own. HEIC files are decoded by
the operating system's own codec:

- **macOS**: Apple's ImageIO framework, licensed by Apple as part of
  the operating system.
- **Windows**: Windows Imaging Component, which decodes HEIC when
  Microsoft's **HEVC Video Extensions** and **HEIF Image Extension**
  are installed from the Microsoft Store. Without them Heeler reports
  HEIC files as unsupported; installing them is all that is needed,
  and nothing about Heeler changes.

On platforms whose operating system provides no HEVC codec, Heeler
does not open HEIC files.
