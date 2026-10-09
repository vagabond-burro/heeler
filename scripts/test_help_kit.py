#!/usr/bin/env python3
"""The help kit (build_help_kit.py), built from the real guide and
checked the way Claude, ChatGPT and Gemini will read it.

    python scripts/test_help_kit.py
"""

from __future__ import annotations

import re
import tempfile
import unittest
import zipfile
from pathlib import Path

import build_help_kit as kit


class HelpKit(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.folder = tempfile.TemporaryDirectory()
        cls.out = Path(cls.folder.name)
        cls.files = kit.build(cls.out / "one")
        cls.version = kit.manifest.workspace_version()
        with zipfile.ZipFile(cls.files[kit.KIT_ZIP]) as archive:
            cls.names = archive.namelist()
            cls.texts = {n: archive.read(n).decode("utf-8") for n in cls.names if not n.endswith("/")}
        cls.guide = cls.files[kit.GUIDE_FILE].read_text(encoding="utf-8")
        cls.instructions = cls.files[kit.INSTRUCTIONS_FILE].read_text(encoding="utf-8")
        cls.chapters = sorted(
            p.relative_to(kit.GUIDE).as_posix() for p in kit.GUIDE.rglob("*.md") if p.relative_to(kit.GUIDE).as_posix() not in kit.EXCLUDED
        )

    @classmethod
    def tearDownClass(cls):
        cls.folder.cleanup()

    def test_the_three_release_files(self):
        self.assertEqual(sorted(p.name for p in (self.out / "one").iterdir()), sorted(kit.RELEASE_FILES))

    def test_the_zip_top_level_is_the_skill_folder(self):
        # Claude's Upload a skill reads heeler-help/SKILL.md inside the
        # archive; a SKILL.md at the root is not recognized.
        self.assertEqual({n.split("/", 1)[0] for n in self.names}, {"heeler-help"})
        self.assertIn("heeler-help/SKILL.md", self.names)
        self.assertNotIn("SKILL.md", self.names)
        for chapter in self.chapters:
            self.assertIn(f"heeler-help/references/{chapter}", self.names)

    def test_skill_frontmatter(self):
        text = self.texts["heeler-help/SKILL.md"]
        match = re.match(r"^---\nname: (.+)\ndescription: \"(.+)\"\n---\n", text)
        self.assertIsNotNone(match, text[:300])
        self.assertEqual(match[1], "heeler-help")
        description = match[2]
        self.assertIn("Heeler photo editor", description)
        self.assertLessEqual(len(description), 1024)
        self.assertNotIn('"', description)
        # Every chapter is in the index.
        for chapter in self.chapters:
            self.assertIn(f"`references/{chapter}`", text)

    def test_excluded_files_are_absent(self):
        for excluded in kit.EXCLUDED:
            self.assertNotIn(f"heeler-help/references/{excluded}", self.names)
            self.assertNotIn(f"# {excluded}\n", self.guide)
            self.assertNotIn(f"`references/{excluded}`", self.texts["heeler-help/SKILL.md"])
        self.assertFalse(any(n.endswith((".png", ".jpg", ".svg")) for n in self.names))

    def test_no_screenshot_placeholders_or_image_references(self):
        # The guide itself has both, so the check means something.
        source = "\n".join(p.read_text(encoding="utf-8") for p in kit.GUIDE.rglob("*.md"))
        self.assertRegex(source, r"(?i)screenshot placeholder")
        self.assertIn("](assets/screenshots/", source)
        for name, text in [*self.texts.items(), (kit.GUIDE_FILE, self.guide)]:
            self.assertNotRegex(text, r"(?i)screenshot placeholder", name)
            self.assertNotIn("assets/screenshots/", text, name)
            self.assertNotIn("assets/icons/", text, name)

    def test_the_single_file_has_every_chapter_in_the_guide_order(self):
        order = kit.guide_order({c: kit.clean((kit.GUIDE / c).read_text(encoding="utf-8")) for c in self.chapters})
        self.assertEqual(sorted(order), self.chapters)
        positions = []
        for chapter in order:
            heading = f"\n# {chapter}\n"
            self.assertIn(heading, self.guide)
            positions.append(self.guide.index(heading))
            text = (kit.GUIDE / chapter).read_text(encoding="utf-8")
            heading = next(line for line in text.splitlines() if line.startswith("# "))
            self.assertTrue(self.guide[positions[-1]:].startswith(f"\n# {chapter}\n\n#{heading}\n"), chapter)
        self.assertEqual(positions, sorted(positions))
        # The guide's own order: the README first, Menus before the adjustments.
        self.assertEqual(order[0], "README.md")
        self.assertLess(order.index("menus.md"), order.index("adjustments/sky-rescue.md"))
        # Only the path headings are top level; chapter headings are demoted.
        top, fenced = [], False
        for line in self.guide.split("\n"):
            if kit.FENCE.match(line):
                fenced = not fenced
            elif not fenced and line.startswith("# "):
                top.append(line)
        self.assertEqual(len(top), len(order) + 1)

    def test_deterministic(self):
        again = kit.build(self.out / "two")
        for name in kit.RELEASE_FILES:
            self.assertEqual(self.files[name].read_bytes(), again[name].read_bytes(), name)
        with zipfile.ZipFile(self.files[kit.KIT_ZIP]) as archive:
            infos = archive.infolist()
        self.assertEqual([i.filename for i in infos], sorted(i.filename for i in infos))
        self.assertTrue(all(i.date_time == kit.ZIP_TIME for i in infos))

    def test_the_version_is_stamped(self):
        shown = kit.manifest.display_version(self.version)
        for text in (self.texts["heeler-help/SKILL.md"], self.instructions, self.guide):
            self.assertIn(f"Heeler {shown} (version {self.version})" if text is not self.guide else f"({shown}, version {self.version})", text)

    def test_the_instructions_are_the_same_in_both_places(self):
        rules = "\n".join(kit.rules(self.version))
        self.assertIn(rules, self.texts["heeler-help/SKILL.md"])
        self.assertTrue(self.instructions.startswith(rules))
        # The owner's own test: darkening a sky got Black and White
# advice.
        self.assertIn("Do not suggest Black and White for a color photograph", rules)
        self.assertIn("Sky Rescue and Color Tune", rules)
        self.assertIn(kit.GUIDE_FILE, self.instructions)
        for dash in ("\u2014", "\u2013"):
            self.assertNotIn(dash, rules)
            self.assertNotIn(dash, kit.DESCRIPTION)

    def test_cleaning_keeps_code_and_drops_notes(self):
        text = "# T\n\n![Shot](assets/x.png)\n\n> **Screenshot placeholder: X:** Show it.\n\n- ![Icon](a.svg) [Link](b.md)\n\n```\n# code\n![kept](x)\n```\n"
        cleaned = kit.clean(text)
        self.assertEqual(cleaned, "# T\n\n- [Link](b.md)\n\n```\n# code\n![kept](x)\n```\n")
        self.assertEqual(kit.demote(cleaned).split("\n")[0], "## T")
        self.assertIn("# code", kit.demote(cleaned))


if __name__ == "__main__":
    unittest.main()
