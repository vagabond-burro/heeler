# Open source notices

*This page is about the open-source components inside Heeler. Heeler's
own code is under the [Mozilla Public License 2.0](license.md); the
materials on this page retain their own licenses.*

Heeler is built on other people's work. This page says whose, under what
terms, and where to get the parts you are entitled to.

## RAW files

Heeler develops RAW files with its own decoder, written in Rust for
Heeler and under Heeler's own license. (GoPro's VC-5 codec, below, is the
one part ported from another project.)

The decoder's color for each camera is data, not code. For most cameras it
is the pair of calibrations a converter writes into the camera profile of
the DNG files it makes. For cameras no converter reads, it is the matrix
LibRaw develops the camera with, as measured from LibRaw's output.

Earlier versions of Heeler, through 2026.6, read RAW files with
**LibRaw**, © 2008-2024 LibRaw LLC, under the **Common Development and
Distribution License, version 1.0 (CDDL-1.0)**. This version contains no
LibRaw code. The source those earlier versions were built from stays
published, with its license, at:

> **https://www.heeler.app/source/libraw/**

## libjpeg

The frames the viewer shows while you edit are encoded with
**mozjpeg**, a libjpeg-turbo derivative, © the Independent JPEG Group and
contributors, under the IJG and BSD-3-Clause licenses.

The IJG license asks for one sentence in particular, so here it is in
the words it asks for:

> This software is based in part on the work of the Independent JPEG Group.

The library has not been altered.

The IJG's terms, as the Independent JPEG Group's README states them:

```text
The authors make NO WARRANTY or representation, either express or implied,
with respect to this software, its quality, accuracy, merchantability, or
fitness for a particular purpose.  This software is provided "AS IS", and you,
its user, assume the entire risk as to its quality and accuracy.

This software is copyright (C) 1991-2020, Thomas G. Lane, Guido Vollbeding.
All Rights Reserved except as specified below.

Permission is hereby granted to use, copy, modify, and distribute this
software (or portions thereof) for any purpose, without fee, subject to these
conditions:
(1) If any part of the source code for this software is distributed, then this
README file must be included, with this copyright and no-warranty notice
unaltered; and any additions, deletions, or changes to the original files
must be clearly indicated in accompanying documentation.
(2) If only executable code is distributed, then the accompanying
documentation must state that "this software is based in part on the work of
the Independent JPEG Group".
(3) Permission for use of this software is granted only if the user accepts
full responsibility for any undesirable consequences; the authors accept
NO LIABILITY for damages of any kind.

These conditions apply to any software derived from or based on the IJG code,
not just to the unmodified library.  If you use our work, you ought to
acknowledge us.

Permission is NOT granted for the use of any IJG author's name or company name
in advertising or publicity relating to this software or products derived from
it.  This software may be referred to only as "the Independent JPEG Group's
software".

We specifically permit and encourage the use of this software as the basis of
commercial products, provided that all warranty or liability claims are
assumed by the product vendor.
```

## JPEG XL

Newer DNG files, both the lossy ones and floating-point HDR merges,
store their pixels as JPEG XL. Heeler reads those with
**jxl-oxide**, © its authors, under the **MIT or Apache-2.0** licenses,
at your option.

The library has not been altered.

## GoPro VC-5 decoder

GoPro GPR files compress their pixels with GoPro's VC-5 codec. Heeler
decodes them with its own Rust port of the VC-5 decoder from **GoPro's GPR
SDK**, © 2018 GoPro, Inc., offered under the **Apache-2.0 or MIT** licenses
at your option; Heeler takes the MIT option. Only the decoder is ported,
not the rest of the SDK.

The port decodes a sound file to the same pixels as GoPro's decoder, and
reports a damaged GPR as damaged instead of closing the app: it checks
that it stays inside the file it is reading and that the sizes and counts
in the file's own header are ones it can hold (its image size must match
the one the GPR declares). How it relates to GoPro's code is described in
`third_party/gpr-vc5/README.md` in Heeler's repository.

The MIT license asks that its text travel with the software:

```text
Copyright 2018 GoPro, Inc.

Permission is hereby granted, free of charge, to any person obtaining a
copy of this software and associated documentation files (the "Software"),
to deal in the Software without restriction, including without limitation
the rights to use, copy, modify, merge, publish, distribute, sublicense,
and/or sell copies of the Software, and to permit persons to whom the
Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included
in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL
THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
DEALINGS IN THE SOFTWARE.
```

## mimalloc

Heeler's memory is managed by **mimalloc**, © 2018-2025 Microsoft
Corporation and Daan Leijen, under the **MIT** license, built in from
source through the `libmimalloc-sys` crate. It hands memory Heeler has
finished with back to the system sooner than the built-in allocator,
which keeps large exports lighter.

The library has not been altered. The MIT license asks that its text
travel with the software:

```text
MIT License

Copyright (c) 2018-2025 Microsoft Corporation, Daan Leijen

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## libwebp

WebP exports and the media server's frames are encoded by **libwebp**
1.3.1, © 2010 Google Inc., under the **BSD-3-Clause** license, built in
from source through the `libwebp-sys` crate. The library has not been
altered. Its license asks that its text travel with the software, and
Google grants a patent license for it, reproduced as it comes:

```text
Copyright (c) 2010, Google Inc. All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are
met:

  * Redistributions of source code must retain the above copyright
    notice, this list of conditions and the following disclaimer.

  * Redistributions in binary form must reproduce the above copyright
    notice, this list of conditions and the following disclaimer in
    the documentation and/or other materials provided with the
    distribution.

  * Neither the name of Google nor the names of its contributors may
    be used to endorse or promote products derived from this software
    without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
"AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

```text
Additional IP Rights Grant (Patents)
------------------------------------

"These implementations" means the copyrightable works that implement the WebM
codecs distributed by Google as part of the WebM Project.

Google hereby grants to you a perpetual, worldwide, non-exclusive, no-charge,
royalty-free, irrevocable (except as stated in this section) patent license to
make, have made, use, offer to sell, sell, import, transfer, and otherwise
run, modify and propagate the contents of these implementations of WebM, where
such license applies only to those patent claims, both currently owned by
Google and acquired in the future, licensable by Google that are necessarily
infringed by these implementations of WebM. This grant does not include claims
that would be infringed only as a consequence of further modification of these
implementations. If you or your agent or exclusive licensee institute or order
or agree to the institution of patent litigation or any other patent
enforcement activity against any entity (including a cross-claim or
counterclaim in a lawsuit) alleging that any of these implementations of WebM
or any code incorporated within any of these implementations of WebM
constitute direct or contributory patent infringement, or inducement of
patent infringement, then any patent rights granted to you under this License
for these implementations of WebM shall terminate as of the date such
litigation is filed.
```

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
- **BiRefNet dynamic** (the one-shot subject matte) and **BiRefNet
  Lite** (the subject matte before it, kept for selections made with
  it), © Zheng Peng and the BiRefNet authors, under the **MIT
  license**: code and weights alike; ONNX packaging by the Hugging
  Face onnx-community. Their training corpus (DIS5K and related
  academic datasets) is academic in origin; the weights are published
  by the author under MIT, and Heeler uses them as published.
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
**by Heeler alone**. It does not come from the Independent JPEG Group,
or any other author whose work is named on this page, and
none of them takes on any obligation to you because their code is inside
Heeler. Heeler indemnifies them against any claim arising from terms
Heeler has offered.

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
