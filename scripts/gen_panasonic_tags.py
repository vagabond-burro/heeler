#!/usr/bin/env python3
"""Generates crates/heeler-io/src/panasonic_tags.rs from ExifTool's tables.

The Panasonic maker note and the RW2's raw directory have private tag
meanings that only ExifTool's tables record (Panasonic.pm and
PanasonicRaw.pm, in the exiftool distribution). A hand-written copy of
those tables drifted the first time it was written (2026-09-23: the
review found Time Stamp on the wrong tag, an enumeration with its
values shifted by one, a gamma read raw); this script reads the
installed tables and writes the Rust, so the reference is the
reference. Run it after an update of those tables and commit the result.

    python3 scripts/gen_panasonic_tags.py [path/to/lib/Image/ExifTool]
"""
import glob
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "crates" / "heeler-io" / "src" / "panasonic_tags.rs"


def tables_lib(arg):
    if arg:
        return Path(arg)
    hits = sorted(glob.glob("/opt/homebrew/Cellar/exiftool/*/libexec/lib/perl5/Image/ExifTool"))
    hits += sorted(glob.glob("/usr/local/Cellar/exiftool/*/libexec/lib/perl5/Image/ExifTool"))
    if not hits:
        sys.exit("no ExifTool library found; pass its Image/ExifTool directory")
    return Path(hits[-1])


def tables_version():
    try:
        return subprocess.run(["exiftool", "-ver"], capture_output=True, text=True, check=True).stdout.strip()
    except Exception:
        return "unknown"


def table_text(src, name):
    m = re.search(r"^%" + re.escape(name) + r" = \(\n(.*?)^\);", src, re.S | re.M)
    if not m:
        sys.exit(f"table {name} not found")
    return m.group(1)


def split_entries(text):
    """Top-level `0xNN => ...,` entries of a table, as (tag, body) pairs."""
    entries = []
    i = 0
    n = len(text)
    while i < n:
        m = re.compile(r"^    (0x[0-9a-fA-F]+) => ", re.M).search(text, i)
        if not m:
            break
        tag = int(m.group(1), 16)
        j = m.end()
        # The value: a quoted string, or a balanced { } or [ ] block.
        if text[j] == "'":
            k = text.index("'", j + 1)
            entries.append((tag, text[j:k + 1]))
            i = k + 1
            continue
        opener = text[j]
        closer = {"{": "}", "[": "]"}.get(opener)
        if not closer:
            i = j
            continue
        depth = 0
        k = j
        in_q = None
        while k < n:
            c = text[k]
            if in_q:
                if c == "\\":
                    k += 2
                    continue
                if c == in_q:
                    in_q = None
            elif c in "'\"":
                in_q = c
            elif c == "#":
                k = text.index("\n", k)
                continue
            elif c in "{[":
                depth += 1
            elif c in "}]":
                depth -= 1
                if depth == 0:
                    break
            k += 1
        entries.append((tag, text[j:k + 1]))
        i = k + 1
    return entries


def first_hash(body):
    """The first { ... } block of a conditional [ {..}, {..} ] list."""
    if body.startswith("["):
        m = re.search(r"\{", body)
        return body[m.start():] if m else body
    return body


def name_of(body):
    if body.startswith("'"):
        return body.strip("'")
    m = re.search(r"Name\s*=>\s*'([^']+)'", body)
    return m.group(1) if m else None


def writable_of(body):
    m = re.search(r"Writable\s*=>\s*'([^']+)'", body)
    return m.group(1) if m else None


def scale_of(body):
    m = re.search(r"ValueConv\s*=>\s*'(-?)\$val\s*/\s*([0-9.]+)'", body)
    if not m:
        return None
    return -float(m.group(2)) if m.group(1) else float(m.group(2))


def print_conv(body):
    """The `N => 'word'` pairs of the entry's PrintConv block, if it is a block."""
    m = re.search(r"PrintConv\s*=>\s*\{", body)
    if not m:
        return []
    j = m.end() - 1
    depth = 0
    k = j
    while k < len(body):
        c = body[k]
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                break
        k += 1
    block = body[j + 1:k]
    # Comments go first, then every `key => 'words'` pair, however many
    # sit on one line (`PrintConv => { 1 => 'No', 2 => 'Yes' }`).
    stripped = "\n".join(line.split("#")[0] for line in block.split("\n"))
    pairs = []
    for mm in re.finditer(r"(?<![\w.])(0x[0-9a-fA-F]+|-?\d+)\s*=>\s*'((?:[^'\\]|\\.)*)'", stripped):
        key = int(mm.group(1), 16) if mm.group(1).startswith("0x") else int(mm.group(1))
        pairs.append((key, mm.group(2).replace("\\'", "'")))
    return pairs


def words(name):
    """The source tables' own description rule: a space before a capital that
    follows a lower-case letter, before a capital that starts a word
    inside a run of capitals, and between a letter and a digit."""
    s = re.sub(r"([a-z])([A-Z])", r"\1 \2", name)
    s = re.sub(r"([A-Z])([A-Z][a-z])", r"\1 \2", s)
    s = re.sub(r"([a-zA-Z])(\d)", r"\1 \2", s)
    return s


def rust_str(s):
    return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'


def emit(table, prefix, out):
    names, enums, signed, strings, scales = [], [], [], [], []
    for tag, body in table:
        body = first_hash(body)
        name = name_of(body)
        if not name:
            continue
        names.append((tag, words(name)))
        w = writable_of(body) or ""
        f = re.search(r"Format\s*=>\s*'([^']+)'", body)
        if w in ("int16s", "int32s", "int8s") or (f and f.group(1) in ("int16s", "int32s", "int8s")):
            signed.append(tag)
        if w == "string":
            strings.append(tag)
        sc = scale_of(body)
        if sc is not None:
            scales.append((tag, sc))
        for k, v in print_conv(body):
            enums.append((tag, k, v))
    out.append(f"/// Tag names of the source's {prefix} table, as it prints them.")
    out.append(f"pub(crate) fn {prefix}_name(tag: u16) -> Option<&'static str> {{")
    out.append("    Some(match tag {")
    seen = set()
    for tag, name in names:
        if tag in seen:
            continue
        seen.add(tag)
        out.append(f"        0x{tag:04x} => {rust_str(name)},")
    out.append("        _ => return None,")
    out.append("    })")
    out.append("}")
    out.append("")
    out.append(f"/// The {prefix} table's enumerations, in the source's words.")
    out.append(f"pub(crate) fn {prefix}_enum(tag: u16, v: i64) -> Option<&'static str> {{")
    out.append("    Some(match (tag, v) {")
    seen = set()
    for tag, k, v in enums:
        if (tag, k) in seen:
            continue
        seen.add((tag, k))
        out.append(f"        (0x{tag:04x}, {k}) => {rust_str(v)},")
    out.append("        _ => return None,")
    out.append("    })")
    out.append("}")
    out.append("")
    out.append(f"/// Tags the {prefix} table declares signed, whatever type the file stored.")
    out.append(f"pub(crate) fn {prefix}_signed(tag: u16) -> bool {{")
    out.append("    matches!(tag, " + (" | ".join(f"0x{t:04x}" for t in sorted(set(signed))) or "0xffff_u16") + ")")
    out.append("}")
    out.append("")
    out.append(f"/// Tags the {prefix} table declares as text.")
    out.append(f"pub(crate) fn {prefix}_string(tag: u16) -> bool {{")
    out.append("    matches!(tag, " + (" | ".join(f"0x{t:04x}" for t in sorted(set(strings))) or "0xffff_u16") + ")")
    out.append("}")
    out.append("")
    out.append(f"/// A plain `$val / N` value conversion of the {prefix} table; negative")
    out.append("/// for `-$val / N`.")
    out.append(f"pub(crate) fn {prefix}_scale(tag: u16) -> Option<f64> {{")
    out.append("    Some(match tag {")
    seen = set()
    for tag, sc in scales:
        if tag in seen:
            continue
        seen.add(tag)
        out.append(f"        0x{tag:04x} => {sc!r},")
    out.append("        _ => return None,")
    out.append("    })")
    out.append("}")
    out.append("")


def main():
    lib = tables_lib(sys.argv[1] if len(sys.argv) > 1 else None)
    main_src = (lib / "Panasonic.pm").read_text(encoding="utf-8", errors="replace")
    raw_src = (lib / "PanasonicRaw.pm").read_text(encoding="utf-8", errors="replace")
    note = split_entries(table_text(main_src, "Image::ExifTool::Panasonic::Main"))
    raw = split_entries(table_text(raw_src, "Image::ExifTool::PanasonicRaw::Main"))
    out = [
        "//! Panasonic's tag tables, GENERATED by scripts/gen_panasonic_tags.py",
        f"//! from ExifTool {tables_version()} (Panasonic.pm and PanasonicRaw.pm).",
        "//! Do not edit by hand: rerun the script after an update of those tables.",
        "",
        "#![allow(clippy::all, dead_code)]",
        "",
    ]
    emit(note, "note", out)
    emit(raw, "raw", out)
    OUT.write_text("\n".join(out) + "\n", encoding="utf-8")
    print(f"wrote {OUT.relative_to(ROOT)}: {len(note)} note tags, {len(raw)} raw tags")


if __name__ == "__main__":
    main()
