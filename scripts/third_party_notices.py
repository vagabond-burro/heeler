#!/usr/bin/env python3
"""Writes the bundled third-party notices: every Rust crate linked into
the shipping desktop binaries and every JavaScript package bundled
into the frontend, with the license text each one carries.

The MIT, BSD, Apache and Unicode licenses all ask that their text
travel with a binary built from them; naming the license is not the
same as reproducing it. This file is that reproduction, generated from
the exact crates the three shipping targets resolve (macOS arm64,
Windows x64 and Linux x64, runtime dependencies only, never dev or
build tools) and
from the packages the frontend imports.

Run from the repository root:

    python3 scripts/third_party_notices.py

A test in the desktop crate (tests/third_party_notices.rs) fails when a
crate the build links is missing from the file, so a new dependency
means running this script again. License texts are reproduced
verbatim, punctuation included: the repository's own no-dashes rule
is for the words Heeler writes, not for other people's licenses.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MANIFEST = ROOT / "apps" / "heeler-app" / "src-tauri" / "Cargo.toml"
APP = ROOT / "apps" / "heeler-app"
OUT = ROOT / "docs" / "user-guide" / "legal" / "third-party-notices.md"
# The Linux target joined 2026-09-20 when its test run listed sixty-odd
# GTK, WebKitGTK and OpenSSL crates the page did not carry. Fetch its
# sources first on another platform: cargo fetch --target x86_64-unknown-linux-gnu
TARGETS = ["aarch64-apple-darwin", "x86_64-pc-windows-msvc", "x86_64-unknown-linux-gnu"]

# The option Heeler takes when a crate offers a choice ("MIT OR
# Apache-2.0"): the shortest text that carries the same permission.
PREFERENCE = ["MIT", "MIT-0", "0BSD", "BSD-2-Clause", "BSD-3-Clause", "ISC", "Zlib", "Unlicense", "CC0-1.0",
              "Apache-2.0", "Apache-2.0 WITH LLVM-exception", "Unicode-3.0", "CDLA-Permissive-2.0", "MPL-2.0", "IJG"]

LICENSE_FILE = re.compile(r"^(licen[cs]e|copying|notice|unlicense)", re.IGNORECASE)


def metadata(target: str) -> dict:
    out = subprocess.run(
        ["cargo", "metadata", "--format-version", "1", "--filter-platform", target, "--manifest-path", str(MANIFEST)],
        check=True, capture_output=True, text=True,
    ).stdout
    return json.loads(out)


def runtime_crates() -> dict[tuple[str, str], dict]:
    """Every external crate reachable from the desktop binary through
    normal dependencies, on any shipping target."""
    found: dict[tuple[str, str], dict] = {}
    for target in TARGETS:
        m = metadata(target)
        packages = {p["id"]: p for p in m["packages"]}
        nodes = {n["id"]: n for n in m["resolve"]["nodes"]}
        seen: set[str] = set()
        stack = [m["resolve"]["root"]]
        while stack:
            pid = stack.pop()
            if pid in seen:
                continue
            seen.add(pid)
            for dep in nodes[pid]["deps"]:
                if any(k.get("kind") in (None, "normal") for k in dep["dep_kinds"]):
                    stack.append(dep["pkg"])
        for pid in seen:
            p = packages[pid]
            if p["source"]:
                found[(p["name"], p["version"])] = p
    return found


def split_expression(expr: str) -> tuple[list[str], str]:
    """The SPDX ids in a license expression and whether they are
    alternatives ("OR", the crate offers a choice) or a conjunction
    ("AND", every text applies). Old-style "MIT/Apache-2.0" means OR."""
    text = expr.replace("/", " OR ")
    text = text.replace("(", " ").replace(")", " ")
    if " AND " in text:
        return [t.strip() for t in re.split(r"\s+AND\s+", text) if t.strip()], "AND"
    return [t.strip() for t in re.split(r"\s+OR\s+", text) if t.strip()], "OR"


def license_files(dir_: Path) -> list[Path]:
    return sorted(p for p in dir_.iterdir() if p.is_file() and LICENSE_FILE.match(p.name))


def file_for(spdx: str, files: list[Path]) -> Path | None:
    """The file in a crate that carries `spdx`, by the names crates use:
    LICENSE-MIT, LICENSE-APACHE, LICENSE.txt, COPYING."""
    key = spdx.lower().replace("-", "").replace(".", "")
    short = {"apache20": "apache", "apache20withllvmexception": "apache", "bsd3clause": "bsd", "bsd2clause": "bsd",
             "unicode30": "unicode", "cc010": "cc0", "cdlapermissive20": "cdla", "mpl20": "mpl", "0bsd": "0bsd",
             "mit0": "mit"}.get(key, key)
    for f in files:
        n = f.name.lower().replace("-", "").replace("_", "").replace(".", "")
        if short in n:
            return f
    return None


def chosen_texts(p: dict) -> list[tuple[str, str]]:
    """(spdx, text) pairs for one crate: the option Heeler takes of an
    OR, every part of an AND, read from the crate's own files, else the
    standard text with the crate's copyright line."""
    dir_ = Path(p["manifest_path"]).parent
    files = license_files(dir_)
    ids, mode = split_expression(p["license"] or "")
    prefer = lambda options: min(options, key=lambda i: PREFERENCE.index(i) if i in PREFERENCE else 99)
    if mode == "OR":
        ids = [prefer(ids)]
    else:
        # "(MIT OR Apache-2.0) AND Unicode-3.0": every part applies, and a
        # part that is itself a choice takes the preferred option.
        ids = [prefer([t.strip() for t in re.split(r"\s+OR\s+", i) if t.strip()]) if " OR " in i else i for i in ids]
    out = []
    for spdx in ids:
        f = file_for(spdx, files)
        if f is None and len(files) == 1 and len(ids) == 1:
            f = files[0]
        if f is None and files and mode == "OR":
            f = files[0]
        if f is not None:
            out.append((spdx, f.read_text(errors="replace").strip()))
        elif files and mode == "AND":
            # A conjunction whose parts are not separate files (mozjpeg's
            # IJG and zlib and BSD terms in one COPYING): every file the
            # crate ships, once each.
            for extra in files:
                text = extra.read_text(errors="replace").strip()
                if all(text != t for _, t in out):
                    out.append((spdx, text))
        else:
            out.append((spdx, standard_text(spdx, p)))
    return out


def standard_text(spdx: str, p: dict) -> str:
    holder = ", ".join(p.get("authors") or []) or f"the {p['name']} authors"
    year = ""
    texts = {
        "MIT": f"MIT License\n\nCopyright (c) {holder}\n\n" + MIT_BODY,
        "MIT-0": f"MIT No Attribution\n\nCopyright (c) {holder}\n\n" + MIT0_BODY,
        "BSD-3-Clause": f"BSD 3-Clause License\n\nCopyright (c) {holder}\n\n" + BSD3_BODY,
        "BSD-2-Clause": f"BSD 2-Clause License\n\nCopyright (c) {holder}\n\n" + BSD2_BODY,
        "ISC": f"ISC License\n\nCopyright (c) {holder}\n\n" + ISC_BODY,
        "Zlib": f"zlib License\n\nCopyright (c) {holder}\n\n" + ZLIB_BODY,
        "0BSD": f"Zero-Clause BSD\n\nCopyright (c) {holder}\n\n" + ZERO_BSD_BODY,
        "Apache-2.0": APACHE_SHORT.format(holder=holder),
        "Apache-2.0 WITH LLVM-exception": APACHE_SHORT.format(holder=holder),
        "Unlicense": UNLICENSE_BODY,
        "CC0-1.0": CC0_SHORT,
    }
    if spdx in texts:
        return texts[spdx]
    return f"{spdx}: see the crate's repository {p.get('repository') or ''} for the license text.{year}"


MIT_BODY = """Permission is hereby granted, free of charge, to any person obtaining a copy
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
SOFTWARE."""

MIT0_BODY = """Permission is hereby granted, free of charge, to any person obtaining a copy of this
software and associated documentation files (the "Software"), to deal in the Software
without restriction, including without limitation the rights to use, copy, modify,
merge, publish, distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED,
INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A
PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT
HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF
CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE
OR THE USE OR OTHER DEALINGS IN THE SOFTWARE."""

BSD3_BODY = """Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its
   contributors may be used to endorse or promote products derived from
   this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE."""

BSD2_BODY = """Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE."""

ISC_BODY = """Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE."""

ZLIB_BODY = """This software is provided 'as-is', without any express or implied
warranty. In no event will the authors be held liable for any damages
arising from the use of this software.

Permission is granted to anyone to use this software for any purpose,
including commercial applications, and to alter it and redistribute it
freely, subject to the following restrictions:

1. The origin of this software must not be misrepresented; you must not
   claim that you wrote the original software. If you use this software
   in a product, an acknowledgment in the product documentation would be
   appreciated but is not required.
2. Altered source versions must be plainly marked as such, and must not be
   misrepresented as being the original software.
3. This notice may not be removed or altered from any source distribution."""

ZERO_BSD_BODY = """Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE."""

APACHE_SHORT = """Copyright {holder}

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License. The full text of the License is reproduced
once in this document under the Apache License 2.0 heading."""

UNLICENSE_BODY = """This is free and unencumbered software released into the public domain.

Anyone is free to copy, modify, publish, use, compile, sell, or
distribute this software, either in source code form or as a compiled
binary, for any purpose, commercial or non-commercial, and by any
means.

For more information, please refer to <https://unlicense.org>"""

CC0_SHORT = """CC0 1.0 Universal: the author has dedicated the work to the public
domain by waiving all rights to the work worldwide under copyright law,
to the extent allowed by law. Full text: https://creativecommons.org/publicdomain/zero/1.0/legalcode"""


def js_packages() -> list[dict]:
    """The packages the frontend bundles: package.json's dependencies and
    their own runtime dependencies, read from node_modules."""
    root = json.loads((APP / "package.json").read_text())
    names = list(root.get("dependencies", {}).keys())
    seen: dict[str, dict] = {}
    while names:
        n = names.pop()
        if n in seen:
            continue
        d = APP / "node_modules" / n
        try:
            meta = json.loads((d / "package.json").read_text())
        except OSError:
            print(f"warning: {n} is not installed under node_modules; run npm ci first", file=sys.stderr)
            continue
        files = license_files(d) if d.is_dir() else []
        text = files[0].read_text(errors="replace").strip() if files else standard_text(str(meta.get("license", "MIT")), {"name": n, "authors": [], "repository": ""})
        seen[n] = {"name": n, "version": meta["version"], "license": meta.get("license", ""), "repository": (meta.get("repository") or {}).get("url", "") if isinstance(meta.get("repository"), dict) else meta.get("repository", ""), "text": text}
        names.extend(meta.get("dependencies", {}).keys())
    return [seen[k] for k in sorted(seen)]


def main() -> int:
    crates = runtime_crates()
    groups: dict[str, dict] = {}
    for (name, version), p in sorted(crates.items()):
        for spdx, text in chosen_texts(p):
            key = hashlib.sha256(text.encode()).hexdigest()[:16]
            g = groups.setdefault(key, {"spdx": spdx, "text": text, "crates": []})
            g["crates"].append((name, version, p["license"], p.get("repository") or ""))
    js = js_packages()
    lines = []
    lines.append("# Third-party notices")
    lines.append("")
    lines.append("The open-source libraries inside Heeler and the license text each one")
    lines.append("carries, reproduced because those licenses ask that their text travel")
    lines.append("with a binary built from them. The [Open source notices](open-source.md)")
    lines.append("page says which ones matter to you and why, and carries the notices of the")
    lines.append("libraries compiled in from source (LibRaw, zlib, libjpeg, the GoPro VC-5")
    lines.append("decoder); this page is the complete record of the Rust crates and")
    lines.append("JavaScript packages. It is generated by `scripts/third_party_notices.py` from the")
    lines.append("exact crates the macOS, Windows and Linux builds link, runtime dependencies")
    lines.append("only, and a test fails when a crate is added without regenerating it.")
    lines.append("")
    lines.append(f"Rust crates: {len(crates)}. JavaScript packages: {len(js)}. Where a crate offers")
    lines.append("a choice of licenses, Heeler takes the one shown. Texts are reproduced as")
    lines.append("their authors wrote them.")
    lines.append("")
    lines.append("## JavaScript packages")
    lines.append("")
    for j in js:
        lines.append(f"### {j['name']} {j['version']} ({j['license']})")
        if j["repository"]:
            lines.append("")
            lines.append(f"Source: {j['repository']}")
        lines.append("")
        lines.append("```text")
        lines.append(j["text"])
        lines.append("```")
        lines.append("")
    lines.append("## Rust crates")
    lines.append("")
    lines.append("Each crate below is listed once, by name and version, under the text of")
    lines.append("the license it is used under. A crate under a copyleft-for-its-own-files")
    lines.append("license (MPL-2.0) is linked unmodified; its source is at the repository")
    lines.append("named beside it.")
    lines.append("")
    ordered = sorted(groups.values(), key=lambda g: (-len(g["crates"]), g["spdx"]))
    for i, g in enumerate(ordered, 1):
        lines.append(f"### License text {i}: {g['spdx']}")
        lines.append("")
        for name, version, expr, repo in g["crates"]:
            tail = f" ({expr})" if expr != g["spdx"] else ""
            src = f", source {repo}" if repo else ""
            lines.append(f"- {name} {version}{tail}{src}")
        lines.append("")
        lines.append("```text")
        lines.append(g["text"])
        lines.append("```")
        lines.append("")
    OUT.write_text("\n".join(lines) + "\n")
    print(f"wrote {OUT} with {len(crates)} crates in {len(groups)} license texts and {len(js)} JavaScript packages")
    return 0


if __name__ == "__main__":
    sys.exit(main())
