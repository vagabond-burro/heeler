#!/usr/bin/env python3
"""The release scripts, checked without gh or the network.

    python scripts/test_release.py
"""

from __future__ import annotations

import base64
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from contextlib import ExitStack, redirect_stderr, redirect_stdout
from pathlib import Path
from unittest.mock import patch

import release
import dist
import heeler_build


class Prune(unittest.TestCase):
    """clean.py --prune and dev.py's automatic prune (2026-09-27: 402,133
    loose debug objects made every walk of target/ crawl)."""

    def test_only_loose_objects_under_deps_go(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp)
            deps = target / "debug" / "deps"
            deps.mkdir(parents=True)
            keep = [deps / "libheeler_io-abc.rlib", deps / "heeler_io-abc.d", deps / "libheeler_io-abc.rmeta"]
            for path in keep:
                path.write_text("x")
            for i in range(3):
                (deps / f"heeler_io-abc.heeler_io.{i}.rcgu.o").write_text("object")
            build = target / "debug" / "build" / "ort-sys-1"
            build.mkdir(parents=True)
            (build / "runtime.o").write_text("kept: build scripts' own output")
            self.assertEqual(len(heeler_build.debug_objects(target)), 3)
            with redirect_stdout(io.StringIO()):
                count, size = heeler_build.prune_debug_objects(target)
            self.assertEqual((count, size), (3, 18))
            self.assertTrue(all(p.exists() for p in keep))
            self.assertTrue((build / "runtime.o").exists())
            self.assertEqual(heeler_build.debug_objects(target), [])

    def test_a_missing_target_is_nothing_to_do(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(heeler_build.prune_debug_objects(Path(tmp) / "none", quiet=True), (0, 0))


class Nasm(unittest.TestCase):
    def test_an_x64_build_without_nasm_is_warned_with_the_install_line(self):
        win = heeler_build.nasm_warning("win32", "AMD64", None)
        self.assertIn("winget install NASM.NASM", win)
        linux = heeler_build.nasm_warning("linux", "x86_64", None)
        self.assertIn("linux-setup.sh", linux)

    def test_nasm_present_or_an_arm_mac_says_nothing(self):
        self.assertIsNone(heeler_build.nasm_warning("win32", "AMD64", r"C:\\nasm\\nasm.exe"))
        self.assertIsNone(heeler_build.nasm_warning("darwin", "arm64", None))


class Notes(unittest.TestCase):
    def test_bullets_take_any_marker_and_drop_blank_lines(self):
        text = "- One thing.\n\n* Another\n• A third\nA bare line\n   - indented\n"
        self.assertEqual(release.bullets(text), ["One thing.", "Another", "A third", "A bare line", "indented"])

    def test_the_manifest_notes_keep_one_bullet_a_line(self):
        self.assertEqual(release.notes_text(["One thing.", "Another"]), "- One thing.\n- Another")

    def test_headings_title_sections_and_are_never_items(self):
        text = "## New\n- A feature\n- Another\n\n## Bug fixes\n- A fix\n"
        self.assertEqual(release.bullets(text), ["A feature", "Another", "A fix"])
        self.assertEqual(release.sections(text), [("New", ["A feature", "Another"]), ("Bug fixes", ["A fix"])])
        self.assertEqual(release.sections("- Plain\n"), [(None, ["Plain"])])

    def test_numbered_notes_and_windows_line_endings(self):
        self.assertEqual(release.bullets("1. One\r\n2) Two\r\n\r\n- Three\r\n"), ["One", "Two", "Three"])


class Body(unittest.TestCase):
    def test_the_body_lists_the_files_uploaded_and_the_bullets(self):
        names = {".dmg": "Heeler-26.2.1-macos.dmg", ".exe": "Heeler-26.2.1-windows.exe"}
        text = release.body(["A fix.", "A feature"], names)
        self.assertIn("**Updates**\n- A fix.\n- A feature\n", text)
        self.assertIn("- **macOS (Apple Silicon):** `Heeler-26.2.1-macos.dmg`\n- **Windows:** `Heeler-26.2.1-windows.exe`", text)
        self.assertIn("Both installers are signed.", text)
        self.assertNotIn("{{", text)

    def test_sections_get_their_own_titled_lists_in_the_body(self):
        names = {".dmg": "Heeler-26.2.1-macos.dmg", ".exe": "Heeler-26.2.1-windows.exe"}
        raw = "## New\n- A feature\n## Bug fixes\n- A fix\n"
        text = release.body(release.bullets(raw), names, release.sections(raw))
        self.assertIn("**Updates**\n**New**\n- A feature\n\n**Bug fixes**\n- A fix\n", text)
        # The manifest stays one flat list for the dialog in installed copies.
        self.assertEqual(release.notes_text(release.bullets(raw)), "- A feature\n- A fix")

    def test_one_platform_says_so(self):
        text = release.body(["A fix."], {".dmg": "Heeler-26.2.1-macos.dmg"})
        self.assertIn("The installer is signed and notarized by Apple.", text)
        self.assertNotIn("Windows", text)

    def test_the_msi_rides_beside_the_exe(self):
        names = {".dmg": "Heeler-26.2.1-macos.dmg", ".exe": "Heeler-26.2.1-windows.exe", ".msi": "Heeler-26.2.1-windows.msi"}
        text = release.body(["x"], names)
        self.assertIn("- **Windows (MSI):** `Heeler-26.2.1-windows.msi`", text)
        self.assertIn("All installers are signed.", text)
        self.assertIn("the Windows installers are signed", text)

    def test_linux_signing_wording_names_only_the_signed_platforms(self):
        for others in ((".dmg", ".exe", ".msi"), (".dmg", ".exe"), (".dmg",), (".exe",), ()):
            with self.subTest(others=others):
                names = {ext: release.KINDS[ext][0].format(version="26.3.0") for ext in (*others, ".appimage")}
                text = release.body(["x"], names)
                self.assertIn("The Linux AppImage is not signed", text)
                for misleading in ("All installers are signed", "Both installers are signed", "The installer is signed", "The installers are signed"):
                    self.assertNotIn(misleading, text)
                if ".dmg" in others:
                    self.assertIn("The Mac installer is signed and notarized by Apple.", text)
                if ".exe" in others:
                    windows = "The Windows installers are" if ".msi" in others else "The Windows installer is"
                    self.assertIn(f"{windows} signed through Azure Artifact Signing.", text)

    def test_windows_only_with_and_without_msi(self):
        names = {".exe": "Heeler-26.2.1-windows.exe"}
        text = release.body(["x"], names)
        self.assertIn("The installer is signed through Azure Artifact Signing.", text)
        self.assertNotIn("Apple", text)
        names[".msi"] = "Heeler-26.2.1-windows.msi"
        self.assertIn("The installers are signed through Azure Artifact Signing.", release.body(["x"], names))


class Installers(unittest.TestCase):
    def test_files_are_told_apart_by_extension_and_checked(self):
        with tempfile.TemporaryDirectory() as folder:
            dmg = Path(folder) / "Heeler_26.2.1_aarch64.dmg"
            exe = Path(folder) / "Heeler-26.2.1-windows.exe"
            dmg.write_bytes(b"x"); exe.write_bytes(b"x")
            kinds = release.classify([dmg, exe], "26.2.1")
            self.assertEqual(set(kinds), {".dmg", ".exe"})
            with self.assertRaises(SystemExit):
                release.classify([dmg, Path(folder) / "Heeler-26.2.1-macos.dmg"], "26.2.1")  # missing file
            with self.assertRaises(SystemExit):
                release.classify([exe, exe], "26.2.1")  # one per platform

    def test_windows_bundler_names_and_msi_are_accepted(self):
        with tempfile.TemporaryDirectory() as folder:
            paths = [Path(folder) / name for name in ("Heeler_26.2.1_x64-setup.exe", "Heeler_26.2.1_x64_en-US.msi")]
            for path in paths:
                path.write_bytes(b"x")
            self.assertEqual(set(release.classify(paths, "26.2.1")), {".exe", ".msi"})

    def test_a_name_for_another_version_is_refused(self):
        with tempfile.TemporaryDirectory() as folder:
            for name in ("Heeler-26.2.0-windows.exe", "Heeler_26.2.0_aarch64.dmg", "Heeler_26.2.0_x64-setup.exe", "Heeler_26.2.0_x64_en-US.msi", "Heeler-26.2.0-windows.msi"):
                with self.subTest(name=name):
                    old = Path(folder) / name
                    old.write_bytes(b"x")
                    with self.assertRaises(SystemExit):
                        release.classify([old], "26.2.1")

    def test_another_architecture_is_not_renamed_as_the_default(self):
        with tempfile.TemporaryDirectory() as folder:
            for name in ("Heeler-26.2.1-macos-intel.dmg", "Heeler_26.2.1_x64.dmg", "Heeler-26.2.1-windows-arm64.exe", "Heeler_26.2.1_arm64-setup.exe"):
                with self.subTest(name=name):
                    path = Path(folder) / name
                    path.write_bytes(b"x")
                    with self.assertRaises(SystemExit):
                        release.classify([path], "26.2.1")

    def test_a_linux_appimage_is_optional_and_named_for_its_platform(self):
        # 2026-09-20: Linux builds are around the corner. The bundler's name
        # (product name, Debian's arch word) and the release name both read;
        # another architecture is refused; the manifest gains the key Tauri's
        # updater asks for on Linux; the body says what an AppImage carries instead
        # of a signature.
        with tempfile.TemporaryDirectory() as folder:
            bundled = Path(folder) / "Heeler_26.3.0_amd64.AppImage"
            released = Path(folder) / "Heeler-26.3.0-linux.AppImage"
            bundled.write_bytes(b"x"); released.write_bytes(b"x")
            self.assertEqual(set(release.classify([bundled], "26.3.0")), {".appimage"})
            self.assertEqual(set(release.classify([released], "26.3.0")), {".appimage"})
            with self.assertRaises(SystemExit):
                release.classify([bundled, released], "26.3.0")  # one per platform
            for name in ("Heeler_26.3.0_aarch64.AppImage", "Heeler-26.3.0-linux-arm64.AppImage", "Heeler_26.2.1_amd64.AppImage"):
                with self.subTest(name=name):
                    other = Path(folder) / name
                    other.write_bytes(b"x")
                    with self.assertRaises(SystemExit):
                        release.classify([other], "26.3.0")
        names = {".dmg": "Heeler-26.3.0-macos.dmg", ".exe": "Heeler-26.3.0-windows.exe", ".appimage": "Heeler-26.3.0-linux.AppImage"}
        text = release.body(["A fix."], names)
        self.assertIn("- **Linux (AppImage, x86_64):** `Heeler-26.3.0-linux.AppImage`", text)
        self.assertIn("The Mac installer is signed and notarized by Apple.", text)
        self.assertIn("The Linux AppImage is not signed", text)
        doc, strangers = release.manifest.manifest_for("v26.3.0", "26.3.0", "Notes.", list(names.values()))
        self.assertEqual(strangers, [])
        self.assertEqual(sorted(doc["platforms"]), ["darwin-aarch64", "linux-x86_64", "windows-x86_64"])
        self.assertTrue(doc["platforms"]["linux-x86_64"]["url"].endswith("/v26.3.0/Heeler-26.3.0-linux.AppImage"))
        # Linux alone is no release: the two required installers stay required.
        self.assertEqual(release.REQUIRED, {".dmg", ".exe"})

    def test_dist_finds_the_product_named_appimage_in_its_bundle_directory(self):
        with tempfile.TemporaryDirectory() as folder:
            bundle = Path(folder)
            appimage = bundle / "appimage"
            appimage.mkdir()
            source = appimage / "Heeler_26.3.0_amd64.AppImage"
            source.write_bytes(b"this build")
            with patch.object(dist, "workspace_version", return_value="26.3.0"):
                renamed = dist.rename_for_release(bundle, 0)
            self.assertEqual(renamed, [appimage / "Heeler-26.3.0-linux.AppImage"])
            self.assertEqual(renamed[0].read_bytes(), b"this build")

    def test_the_store_build_is_one_signed_msi_with_webview2_inside(self):
        signed = ["--config", json.dumps({"bundle": {"windows": {"signCommand": "sign %1"}}})]
        args = dist.store_build_args(signed)
        self.assertEqual(args[:2], ["--bundles", "msi"])
        self.assertEqual(args[2], "--config")
        self.assertEqual(len(args), 4)  # one --config, not two side by side
        self.assertEqual(json.loads(args[3]), {"bundle": {"windows": {
            "signCommand": "sign %1",
            "webviewInstallMode": {"type": "offlineInstaller"},
        }}})
        self.assertEqual(json.loads(dist.store_build_args([])[3]), {"bundle": {"windows": {"webviewInstallMode": {"type": "offlineInstaller"}}}})

    def test_the_store_msi_gets_its_own_name_and_leaves_the_websites_alone(self):
        with tempfile.TemporaryDirectory() as folder:
            bundle = Path(folder)
            msi = bundle / "msi"
            msi.mkdir()
            website = msi / "Heeler-26.4.1-windows.msi"
            website.write_bytes(b"website build")
            os.utime(website, (0, 0))  # an earlier build's output
            (msi / "Heeler_26.4.1_x64_en-US.msi").write_bytes(b"store build")
            with patch.object(dist, "workspace_version", return_value="26.4.1"):
                renamed = dist.rename_for_release(bundle, 1, store=True)
            self.assertEqual(renamed, [msi / "Heeler-26.4.1-windows-store.msi"])
            self.assertEqual(renamed[0].read_bytes(), b"store build")
            self.assertEqual(website.read_bytes(), b"website build")
            # Without --store the same bundler file is the website's MSI,
            # and the store build, now an earlier one, is left alone.
            os.utime(renamed[0], (0, 0))
            (msi / "Heeler_26.4.1_x64_en-US.msi").write_bytes(b"next build")
            with patch.object(dist, "workspace_version", return_value="26.4.1"):
                self.assertEqual(dist.rename_for_release(bundle, 1), [website])
            self.assertEqual(website.read_bytes(), b"next build")
            self.assertEqual(renamed[0].read_bytes(), b"store build")

    def test_the_store_msi_stays_out_of_the_release_and_the_manifest(self):
        # It is uploaded by hand for Partner Center. release.py refuses it
        # rather than renaming it to the website's MSI, and a release that
        # carries it still writes the same manifest.
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "Heeler-26.4.1-windows-store.msi"
            path.write_bytes(b"x")
            with self.assertRaisesRegex(SystemExit, "does not read"):
                release.classify([path], "26.4.1")
        doc, strangers = release.manifest.manifest_for("v26.4.1", "26.4.1", "Notes.", [
            "Heeler-26.4.1-macos.dmg", "Heeler-26.4.1-windows.exe",
            "Heeler-26.4.1-windows.msi", "Heeler-26.4.1-windows-store.msi"])
        self.assertEqual(strangers, [])
        self.assertTrue(doc["platforms"]["windows-x86_64"]["url"].endswith("/Heeler-26.4.1-windows.exe"))

    def test_deb_is_refused_with_an_explanation(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "Heeler_26.3.0_amd64.deb"
            path.write_bytes(b"this build")
            with self.assertRaisesRegex(SystemExit, "not an installer this script knows"):
                release.classify([path], "26.3.0")

    def test_the_manifest_names_the_release_files(self):
        doc, strangers = release.manifest.manifest_for("v26.2.1", "26.2.1", "Notes.", ["Heeler-26.2.1-macos.dmg", "Heeler-26.2.1-windows.exe", "Heeler-26.2.1-windows.msi"])
        self.assertEqual(strangers, [])
        self.assertEqual(sorted(doc["platforms"]), ["darwin-aarch64", "windows-x86_64"])
        self.assertTrue(doc["platforms"]["windows-x86_64"]["url"].endswith("/v26.2.1/Heeler-26.2.1-windows.exe"))


class OfflineFlow(unittest.TestCase):
    def setUp(self):
        # No test in this class can run gh or touch the live repository.
        self.addCleanup(patch.stopall)
        patch.object(release.manifest.subprocess, "run", side_effect=AssertionError("unexpected gh call")).start()
        patch.object(release.manifest.urllib.request, "urlopen", side_effect=AssertionError("unexpected network call")).start()

    def test_dry_run_prints_the_assets_it_would_publish_without_writes(self):
        with tempfile.TemporaryDirectory() as folder:
            paths = [Path(folder) / name for name in ("Heeler_26.2.1_aarch64.dmg", "Heeler_26.2.1_x64-setup.exe")]
            for path in paths:
                path.write_bytes(b"stand-in")
            notes = Path(folder) / "NOTES.md"
            notes.write_bytes(b"1. First\r\n2. Second\r\n")
            out, err = io.StringIO(), io.StringIO()
            with patch.object(sys, "argv", ["release.py", *map(str, paths), "--tag", "v26.2.1", "--notes-file", str(notes), "--dry-run"]), patch.object(release, "release_exists", return_value=False), patch.object(release, "tag_exists", return_value=False), redirect_stdout(out), redirect_stderr(err):
                self.assertEqual(release.main(), 0)
            self.assertIn("**Updates**\n- First\n- Second", out.getvalue())
            self.assertIn("Heeler-26.2.1-macos.dmg", out.getvalue())
            self.assertIn('"notes": "- First\\n- Second"', out.getvalue())
            self.assertIn("dry run: nothing published", err.getvalue())
        self.assertIn("heeler-help-kit.zip", err.getvalue())

    def test_the_release_uploads_the_help_kit_beside_the_installers(self):
        # 2026-09-28: the help kit rides every release, so
        # releases/latest/download/heeler-help-kit.zip is always the latest
        # guide. gh and the HEAD checks are stand-ins here.
        uploaded: list[str] = []
        checked: list[str] = []

        def create(*args):
            files = [a for a in args[3:] if not a.startswith("--") and Path(a).is_file()]
            uploaded.extend(Path(a).name for a in files)
            kit = next(Path(a) for a in files if a.endswith(release.help_kit.KIT_ZIP))
            import zipfile
            with zipfile.ZipFile(kit) as archive:
                self.assertIn("heeler-help/SKILL.md", archive.namelist())
            return "https://example.invalid/release"

        with tempfile.TemporaryDirectory() as folder:
            paths = [Path(folder) / name for name in ("Heeler-26.2.1-macos.dmg", "Heeler-26.2.1-windows.exe")]
            for path in paths:
                path.write_bytes(b"stand-in")
            out, err = io.StringIO(), io.StringIO()
            with patch.object(sys, "argv", ["release.py", *map(str, paths), "--tag", "v26.2.1", "--notes", "- x"]), \
                    patch.object(release, "release_exists", return_value=False), patch.object(release, "tag_exists", return_value=False), \
                    patch.object(release.manifest, "gh", side_effect=create), \
                    patch.object(release.manifest, "answers", side_effect=lambda url: checked.append(url)), \
                    patch.object(release.manifest, "stage_manifest", return_value="staged"), \
                    redirect_stdout(out), redirect_stderr(err):
                self.assertEqual(release.main(), 0)
        for name in ("heeler-help-kit.zip", "heeler-user-guide.md", "heeler-help-instructions.txt"):
            self.assertIn(name, uploaded)
            self.assertIn(f"https://github.com/vagabond-burro/heeler/releases/download/v26.2.1/{name}", checked)
        self.assertIn("Heeler-26.2.1-macos.dmg", uploaded)
        self.assertIn("`heeler-help-kit.zip` for Claude", out.getvalue())

    def test_the_help_kit_repo_is_the_one_the_releases_go_to(self):
        # The guide page's stable link must name the repository the
        # release scripts publish to.
        page = (release.REPO_ROOT / "docs" / "user-guide" / "ask-an-ai.md").read_text(encoding="utf-8")
        for name in release.help_kit.RELEASE_FILES:
            self.assertIn(f"https://github.com/{release.manifest.PUBLIC_REPO}/releases/latest/download/{name}", page)

    def test_release_exists_does_not_mistake_other_failures_for_a_missing_release(self):
        for error in ("host not found", "gh: Bad credentials (HTTP 401)"):
            with patch.object(release.manifest, "run_gh", return_value=subprocess.CompletedProcess([], 1, "", error)):
                with self.assertRaises(SystemExit):
                    release.release_exists("v26.2.1")
        with patch.object(release.manifest, "run_gh", return_value=subprocess.CompletedProcess([], 1, "", "release not found\n")):
            self.assertFalse(release.release_exists("v26.2.1"))

    def test_head_redirects_remain_head_requests(self):
        # Through our handler, on every Python: the stock one rebuilt a HEAD as a
        # GET before 3.13 (the owner's 3.12 ran this red, 2026-09-16).
        request = release.manifest.urllib.request.Request("https://github.com/asset", method="HEAD")
        handler = release.manifest.HeadRedirect()
        for code in (301, 302, 303, 307, 308):
            with self.subTest(code=code):
                redirected = handler.redirect_request(request, None, code, "redirect", {}, "https://cdn.example.com/asset")
                self.assertEqual(redirected.get_method(), "HEAD")
                self.assertEqual(redirected.full_url, "https://cdn.example.com/asset")

    def test_a_draft_prerelease_is_never_staged(self):
        rel = {"isDraft": True, "isPrerelease": True, "assets": [{"name": "Heeler-26.2.1-macos.dmg"}]}
        with patch.object(sys, "argv", ["latest_json.py", "--tag", "v26.2.1", "--notes", "x"]), patch.object(release.manifest, "release", return_value=rel), patch.object(release.manifest, "gh") as gh, patch.object(release.manifest, "stage_manifest") as stage, redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            self.assertEqual(release.manifest.main(), 0)
            gh.assert_called_once()
            stage.assert_not_called()

    def test_msi_alone_is_not_an_update_even_with_one_platform(self):
        with tempfile.TemporaryDirectory() as folder:
            msi = Path(folder) / "Heeler-26.2.1-windows.msi"
            msi.write_bytes(b"x")
            with patch.object(sys, "argv", ["release.py", str(msi), "--notes", "- x", "--one-platform", "--dry-run"]), patch.object(release, "release_exists", return_value=False), patch.object(release, "tag_exists", return_value=False), redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit):
                    release.main()

    def test_check_live_reports_main_and_missing_installers_separately(self):
        for live, problem, expected in (("26.2.0", None, 1), ("26.2.1", "HTTP 404", 1), ("26.2.1", None, 0)):
            with self.subTest(live=live, problem=problem):
                served = {"version": live, "platforms": {"darwin-aarch64": {"url": "https://example.com/app.dmg"}}}
                out, err = io.StringIO(), io.StringIO()
                with patch.object(release.manifest, "fetch_json", side_effect=[(served, None), ({"version": "26.2.1"}, None)]), patch.object(release.manifest, "answers", return_value=problem) as answers, redirect_stdout(out), redirect_stderr(err):
                    self.assertEqual(release.manifest.check_live("26.2.1"), expected)
                answers.assert_called_once_with("https://example.com/app.dmg")
                self.assertEqual("merge dev into main" in err.getvalue(), live != "26.2.1")
                self.assertEqual("does not answer" in err.getvalue(), problem is not None)
                self.assertIn("redirect:", out.getvalue())

    def test_check_accepts_the_linux_manifest_and_checks_its_url(self):
        doc, strangers = release.manifest.manifest_for("v26.3.0", "26.3.0", "x", ["Heeler-26.3.0-linux.AppImage"])
        self.assertEqual(strangers, [])
        with patch.object(sys, "argv", ["latest_json.py", "--tag", "v26.3.0", "--check"]), patch.object(release.manifest, "fetch_json", side_effect=[(doc, None), (doc, None)]), patch.object(release.manifest, "answers", return_value=None) as answers, redirect_stdout(io.StringIO()):
            self.assertEqual(release.manifest.main(), 0)
        answers.assert_called_once_with(doc["platforms"]["linux-x86_64"]["url"])

    def test_contents_base64_with_newlines_is_idempotent(self):
        body = json.dumps({"notes": "x" * 300})
        current = {"sha": "old", "content": base64.encodebytes(body.encode()).decode()}
        with patch.object(release.manifest, "ensure_branch"), patch.object(release.manifest, "gh_api", return_value=current) as api:
            self.assertIsNone(release.manifest.stage_manifest(body, "dev", "notes"))
            api.assert_called_once_with("contents/latest.json?ref=dev", missing_ok=True)

    def test_large_contents_do_not_go_on_the_command_line(self):
        body = json.dumps({"notes": "x" * 40000})
        calls = []
        def run(args, **kwargs):
            calls.append((args, kwargs))
            if args[1] == "repos/vagabond-burro/heeler/branches/dev":
                return subprocess.CompletedProcess(args, 0, "{}", "")
            if "?ref=dev" in args[1]:
                return subprocess.CompletedProcess(args, 1, "", "gh: Not Found (HTTP 404)")
            return subprocess.CompletedProcess(args, 0, '{"commit":{"html_url":"commit-url"}}', "")
        with patch.object(release.manifest, "run_gh", side_effect=run):
            self.assertEqual(release.manifest.stage_manifest(body, "dev", "notes"), "commit-url")
        args, kwargs = calls[-1]
        self.assertLess(sum(map(len, args)), 1000)
        payload = json.loads(kwargs["input"])
        self.assertEqual(base64.b64decode(payload["content"]).decode(), body)
        self.assertIn("--input", args)

    def test_gh_only_treats_missing_resources_as_missing(self):
        for stderr, missing in (("gh: Not Found (HTTP 404)", True), ("gh: Bad credentials (HTTP 401)", False)):
            with patch.object(release.manifest, "run_gh", return_value=subprocess.CompletedProcess([], 1, "", stderr)):
                if missing:
                    self.assertIsNone(release.manifest.gh_api("missing", missing_ok=True))
                else:
                    with self.assertRaises(SystemExit):
                        release.manifest.gh_api("missing", missing_ok=True)

class BuildIdentity(unittest.TestCase):
    """The scripts stamp the commit count and the short hash into the
    build's environment; a hand build gets neither and reads dev."""

    def test_the_stamp_is_the_commit_count_and_the_short_hash(self):
        with redirect_stdout(io.StringIO()):
            env = heeler_build.stamp_build_identity({"HEELER_BUILD_NUMBER": "stale", "HEELER_BUILD_HASH": "stale"})
        self.assertEqual(env["HEELER_BUILD_STAMPED"], "1")
        self.assertRegex(env["HEELER_BUILD_NUMBER"], r"^\d+$")
        self.assertRegex(env["HEELER_BUILD_HASH"], r"^[0-9a-f]{7,}$")
        self.assertEqual(
            env["HEELER_BUILD_NUMBER"],
            subprocess.run(["git", "rev-list", "--count", "HEAD"], cwd=heeler_build.REPO_ROOT, capture_output=True, text=True).stdout.strip(),
        )

    def test_dist_checks_signing_before_it_builds(self):
        # A missing certificate or credential stops the run before anything
        # is compiled, not after a long build.
        main = (heeler_build.REPO_ROOT / "scripts" / "dist.py").read_text().split("def main() -> None:")[1]
        mac = main.index("macos_signing_env(unsigned)")
        windows = main.index("windows_build_config(unsigned)")
        build = main.index('[tool("npm"), "run", "build"]')
        self.assertLess(mac, build)
        self.assertLess(windows, build)

    def test_distribution_flag_matrix_checks_before_build_and_keeps_store_signing(self):
        import itertools
        for platform, unsigned, store, pre, names, suites in itertools.product(
            ["darwin", "win32", "linux"], [False, True], [False, True], [False, True], [False, True], [False, True]
        ):
            if store and (platform != "win32" or unsigned or names):
                continue  # rejected by the existing Store argument checks
            args = ["dist.py"] + [flag for flag, on in [
                ("--unsigned", unsigned), ("--store", store), ("--pre-release", pre),
                ("--bundler-names", names), ("--run-tests", suites),
            ] if on]
            with self.subTest(args=args, platform=platform), tempfile.TemporaryDirectory() as tmp, ExitStack() as stack:
                root = Path(tmp)
                (root / "target/release/bundle/macos/Heeler.app").mkdir(parents=True)
                events = []
                calls = []
                stack.enter_context(redirect_stdout(io.StringIO()))
                stack.enter_context(patch.object(sys, "platform", platform))
                stack.enter_context(patch.object(sys, "argv", args))
                stack.enter_context(patch.object(dist, "REPO_ROOT", root))
                for name in ["require_cargo", "ensure_node_modules", "verify_macos_bundle", "verify_windows_bundles"]:
                    stack.enter_context(patch.object(dist, name))
                stack.enter_context(patch.object(dist, "windows_installers", return_value=[root / "installer.exe"]))
                stack.enter_context(patch.object(dist, "rename_for_release", return_value=[]))
                stack.enter_context(patch.object(dist, "tool", side_effect=lambda name: name))
                stack.enter_context(patch.object(dist, "stamp_build_identity", side_effect=lambda env: env))
                stack.enter_context(patch.object(dist, "macos_signing_env", side_effect=lambda _: (events.append("mac") or dict(os.environ), None)))
                stack.enter_context(patch.object(heeler_build, "windows_sign_command", side_effect=lambda: events.append("windows") or "sign %1"))
                stack.enter_context(patch.object(dist, "run_suites", side_effect=lambda: events.append("tests")))
                def run(cmd, **kw):
                    events.append("build")
                    calls.append((cmd, kw))
                stack.enter_context(patch.object(dist, "run", side_effect=run))
                dist.main()
                self.assertEqual(len(calls), 2)
                if platform == "darwin":
                    self.assertLess(events.index("mac"), events.index("build"))
                if platform == "win32" and not unsigned:
                    self.assertLess(events.index("windows"), events.index("build"))
                if suites:
                    self.assertLess(events.index("tests"), events.index("build"))
                if store:
                    cmd = calls[1][0]
                    config = json.loads(cmd[cmd.index("--config") + 1])
                    self.assertEqual(config["bundle"]["windows"]["signCommand"], "sign %1")
                    self.assertEqual(config["bundle"]["windows"]["webviewInstallMode"]["type"], "offlineInstaller")

    def test_failed_signing_and_credentials_only_never_build(self):
        for platform, failed in [("darwin", "macos_signing_env"), ("win32", "windows_build_config")]:
            with self.subTest(platform=platform), ExitStack() as stack:
                stack.enter_context(patch.object(sys, "platform", platform))
                stack.enter_context(patch.object(sys, "argv", ["dist.py", "--run-tests"]))
                for name in ["require_cargo", "ensure_node_modules"]:
                    stack.enter_context(patch.object(dist, name))
                stack.enter_context(patch.object(dist, failed, side_effect=SystemExit("signing failed")))
                build = stack.enter_context(patch.object(dist, "run"))
                suites = stack.enter_context(patch.object(dist, "run_suites"))
                with self.assertRaises(SystemExit):
                    dist.main()
                build.assert_not_called(); suites.assert_not_called()
        with patch.object(sys, "argv", ["dist.py", "--check-credentials", "--unsigned", "--store", "--pre-release", "--run-tests"]), \
             patch.object(dist, "check_credentials") as check, patch.object(dist, "run") as build:
            dist.main()
            check.assert_called_once(); build.assert_not_called()

    def test_windows_signing_names_come_only_from_the_environment(self):
        # The public repository names no signing account: without the
        # three variables the build stops and names them.
        names = {"HEELER_SIGNING_ACCOUNT": "acct", "HEELER_SIGNING_PROFILE": "prof", "HEELER_SIGNING_REGION": "westus2"}
        clean = {k: v for k, v in os.environ.items() if k not in names}
        with patch.dict(os.environ, clean, clear=True):
            self.assertEqual(heeler_build.windows_signing_settings(), {"account": "", "profile": "", "region": ""})
            with self.assertRaises(SystemExit) as stop:
                heeler_build.windows_sign_command()
            for var in names:
                self.assertIn(var, str(stop.exception))
        with patch.dict(os.environ, {**clean, **names}, clear=True), \
             patch.object(heeler_build.shutil, "which", return_value="artifact-signing-cli"), \
             patch.object(heeler_build, "check_signing_credentials"):
            self.assertEqual(
                heeler_build.windows_sign_command(),
                "artifact-signing-cli -e https://wus2.codesigning.azure.net -a acct -c prof -d Heeler %1",
            )

    def test_the_build_script_reads_dev_when_given_nothing(self):
        script = (heeler_build.REPO_ROOT / "apps" / "heeler-app" / "src-tauri" / "build.rs").read_text()
        self.assertIn("build_identity::identity", script)
        self.assertNotIn("rev-list", script, "the build script must not run git itself")
        self.assertNotIn("rerun-if-changed=../../../.git", script, "the build script must not watch the repository")


    def test_ambient_identity_is_not_a_script_stamp(self):
        # Execute the identity part of the real build script, without
        # Tauri's platform resource generation or another Cargo build.
        import shutil
        rustc = shutil.which("rustc")
        self.assertIsNotNone(rustc, "rustc is not on PATH: install the Rust toolchain (rustup) to run this test")
        script = (heeler_build.APP_DIR / "src-tauri" / "build.rs").read_text()
        end = "    // build-identity:end"
        self.assertIn("fn main() {", script)
        self.assertIn(end, script, "build.rs lost its build-identity:end marker, which this test compiles up to")
        identity = script[script.index("fn main() {"):script.index(end)]
        with tempfile.TemporaryDirectory() as folder:
            folder = Path(folder)
            module = heeler_build.APP_DIR / "src-tauri" / "build_identity.rs"
            prefix = 'mod build_identity {\n' + module.read_text() + '\n}\n' if module.exists() else ''
            source = folder / "identity.rs"
            source.write_text(prefix + identity + "}\n")
            binary = folder / ("identity.exe" if os.name == "nt" else "identity")
            compiled = subprocess.run([rustc, "--edition", "2021", str(source), "-o", str(binary)], capture_output=True, text=True)
            self.assertEqual(compiled.returncode, 0, f"rustc failed to compile the build-identity slice:\n{compiled.stderr}")
            env = dict(os.environ, HEELER_BUILD_NUMBER="123", HEELER_BUILD_HASH="abcdef0")
            env.pop("HEELER_BUILD_STAMPED", None)
            plain = subprocess.run([str(binary)], env=env, capture_output=True, text=True, check=True).stdout
            self.assertIn("cargo:rustc-env=HEELER_BUILD_NUMBER=dev\n", plain)
            self.assertIn("cargo:rustc-env=HEELER_BUILD_HASH=dev\n", plain)
            stamped = subprocess.run([str(binary)], env=dict(env, HEELER_BUILD_STAMPED="1"), capture_output=True, text=True, check=True).stdout
            self.assertIn("cargo:rustc-env=HEELER_BUILD_NUMBER=123\n", stamped)
            self.assertIn("cargo:rustc-env=HEELER_BUILD_HASH=abcdef0\n", stamped)

    def test_stamp_uses_its_repository_when_launched_elsewhere(self):
        with tempfile.TemporaryDirectory() as folder, redirect_stdout(io.StringIO()):
            previous = os.getcwd()
            try:
                os.chdir(folder)
                supplied = {"HEELER_BUILD_NUMBER": "old", "HEELER_BUILD_HASH": "old"}
                stamped = heeler_build.stamp_build_identity(supplied)
            finally:
                os.chdir(previous)
        expected = subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=heeler_build.REPO_ROOT, capture_output=True, text=True, check=True).stdout.strip()
        self.assertEqual(stamped["HEELER_BUILD_HASH"], expected)
        self.assertEqual(supplied["HEELER_BUILD_NUMBER"], "old")


    def test_the_packager_passes_the_stamp_to_the_bundler(self):
        for module in (dist,):
            with self.subTest(module=module.__name__), tempfile.TemporaryDirectory() as folder, redirect_stdout(io.StringIO()):
                with patch.object(sys, "platform", "linux"), patch.object(sys, "argv", [module.__name__, "--bundler-names"]), patch.object(module, "REPO_ROOT", Path(folder)), patch.object(module, "require_cargo"), patch.object(module, "ensure_node_modules"), patch.object(module, "run") as run:
                    module.main()
                calls = [c for c in run.call_args_list if "tauri" in c.args[0]]
                self.assertEqual(len(calls), 1)
                env = calls[0].kwargs["env"]
                self.assertEqual(env["HEELER_BUILD_STAMPED"], "1")
                self.assertRegex(env["HEELER_BUILD_NUMBER"], r"^\d+$")
                self.assertRegex(env["HEELER_BUILD_HASH"], r"^[0-9a-f]{7,}$")


class Suites(unittest.TestCase):
    def test_the_type_check_runs_before_the_frontend_suite(self):
        # vitest strips types without checking them, so a type error in
        # a test file passed every suite while `npm run build`, which
        # starts with tsc, would have refused to build.
        with patch.object(heeler_build, "run") as run, patch.object(heeler_build, "tool", side_effect=lambda n: n), patch.object(heeler_build, "require_cargo"), patch.object(heeler_build, "ensure_node_modules"):
            heeler_build.run_suites()
        commands = [c.args[0] for c in run.call_args_list]
        tsc = commands.index(["npx", "tsc", "--noEmit", "-p", "."])
        self.assertEqual(run.call_args_list[tsc].kwargs["cwd"], heeler_build.APP_DIR)
        self.assertLess(tsc, commands.index(["npm", "test"]))


class PackagingHelp(unittest.TestCase):
    def test_help_never_checks_credentials_or_starts_a_build(self):
        for module in (dist,):
            for flag in ("--help", "-h"):
                with self.subTest(script=module.__name__, flag=flag):
                    with patch.object(sys, "argv", [module.__name__, flag]), patch.object(module, "require_cargo", side_effect=AssertionError("help tried to build")), redirect_stdout(io.StringIO()) as output:
                        module.main()
                    self.assertIn("Usage:", output.getvalue())

    def test_store_refuses_what_the_store_would_refuse_before_building(self):
        cases = (
            ("darwin", ["--store"], "only a Windows machine"),
            ("linux", ["--store"], "only a Windows machine"),
            ("win32", ["--store", "--unsigned"], "trusted signature"),
            ("win32", ["--store", "--bundler-names"], "same as the website's"),
        )
        for platform, flags, reason in cases:
            with self.subTest(platform=platform, flags=flags):
                with patch.object(sys, "argv", ["dist.py", *flags]), patch.object(sys, "platform", platform), patch.object(dist, "require_cargo", side_effect=AssertionError("started a build")):
                    with self.assertRaisesRegex(SystemExit, reason):
                        dist.main()


CARGO = '[package]\nversion = "0.0.1"\n\n[workspace.package]\nedition = "2021"\nversion = "{version}"\n\n[dependencies]\nversion = "9.9.9"\n'
POSIX = sys.platform != "win32"


class MacReleaseScript(unittest.TestCase):
    """scripts/macos-release.zsh (2026-10-03: "context aware of the latest
    version so I don't have to define it"), run in a copy of the tree's
    shape with echo standing in for python, so the command it would hand
    release.py is what the test reads."""

    SCRIPT = heeler_build.REPO_ROOT / "scripts" / "macos-release.zsh"

    def tree(self, tmp: str, version: str = "31.2.7") -> tuple[Path, Path]:
        root = Path(tmp) / "repo"
        (root / "scripts").mkdir(parents=True)
        shutil.copy(self.SCRIPT, root / "scripts" / "macos-release.zsh")
        (root / "Cargo.toml").write_text(CARGO.format(version=version))
        dmg = root / "target" / "release" / "bundle" / "dmg"
        dmg.mkdir(parents=True)
        (dmg / f"Heeler-{version}-macos.dmg").write_text("dmg")
        builds = Path(tmp) / "shared builds"
        builds.mkdir()
        for name in [f"Heeler-{version}-windows.exe", f"Heeler-{version}-linux.AppImage", f"Heeler-{version}-macos.dmg", "Heeler-31.2.6-windows.exe", "notes.txt"]:
            (builds / name).write_text("x")
        return root, builds

    def run_script(self, root: Path, *args: str) -> subprocess.CompletedProcess:
        env = dict(os.environ, PYTHON="echo")
        env.pop("HEELER_BUILDS", None)
        return subprocess.run(["zsh", str(root / "scripts" / "macos-release.zsh"), *args], capture_output=True, text=True, env=env, cwd=Path(root).parent)

    @unittest.skipUnless(POSIX and shutil.which("zsh"), "zsh is the Mac's shell")
    def test_it_finds_the_version_and_this_releases_installers(self):
        with tempfile.TemporaryDirectory() as tmp:
            root, builds = self.tree(tmp)
            done = self.run_script(root, "--builds", str(builds), "--dry-run", "--pre-release")
            self.assertEqual(done.returncode, 0, done.stderr)
            # The workspace's version, this machine's DMG, the other
            # machines' installers of that version only (no older build,
            # no second DMG, no stray file), then the notes and the flags.
            self.assertEqual(
                done.stdout.strip(),
                f"scripts/release.py target/release/bundle/dmg/Heeler-31.2.7-macos.dmg {builds}/Heeler-31.2.7-linux.AppImage {builds}/Heeler-31.2.7-windows.exe --notes-file NOTES.md --pre-release --dry-run",
            )
            plain = self.run_script(root, f"--builds={builds}")
            self.assertEqual(plain.returncode, 0, plain.stderr)
            self.assertNotIn("--dry-run", plain.stdout, "nothing is a dry run unless asked")
            for spelling in ["--dryrun", "-n"]:
                self.assertTrue(self.run_script(root, "--builds", str(builds), spelling).stdout.strip().endswith("--dry-run"), spelling)

    @unittest.skipUnless(POSIX and shutil.which("zsh"), "zsh is the Mac's shell")
    def test_it_stops_with_a_reason_before_release_py_runs(self):
        with tempfile.TemporaryDirectory() as tmp:
            root, builds = self.tree(tmp)
            missing = self.run_script(root, "--builds", str(Path(tmp) / "not mounted"))
            self.assertEqual((missing.returncode, missing.stdout), (1, ""))
            self.assertIn("Mount the shared volume", missing.stderr)
            (root / "target" / "release" / "bundle" / "dmg" / "Heeler-31.2.7-macos.dmg").unlink()
            unbuilt = self.run_script(root, "--builds", str(builds))
            self.assertEqual((unbuilt.returncode, unbuilt.stdout), (1, ""))
            self.assertIn("Build it first", unbuilt.stderr)

    @unittest.skipUnless(POSIX and shutil.which("zsh"), "zsh is the Mac's shell")
    def test_help_prints_the_usage_and_runs_nothing(self):
        with tempfile.TemporaryDirectory() as tmp:
            root, _ = self.tree(tmp)
            done = self.run_script(root, "--help")
            self.assertEqual(done.returncode, 0)
            self.assertIn("--dry-run", done.stdout)
            self.assertNotIn("release.py target", done.stdout)


class LinuxStageScript(unittest.TestCase):
    """scripts/linux-stage.sh moves this release's AppImage onto the
    shared folder, in a copy of the tree's shape."""

    def tree(self, tmp: str) -> tuple[Path, Path, Path]:
        root = Path(tmp) / "repo"
        (root / "scripts").mkdir(parents=True)
        shutil.copy(heeler_build.REPO_ROOT / "scripts" / "linux-stage.sh", root / "scripts" / "linux-stage.sh")
        (root / "Cargo.toml").write_text(CARGO.format(version="31.2.7"))
        bundle = root / "target" / "release" / "bundle" / "appimage"
        bundle.mkdir(parents=True)
        (bundle / "Heeler-31.2.7-linux.AppImage").write_text("this release")
        (bundle / "Heeler-31.2.6-linux.AppImage").write_text("the last one")
        builds = Path(tmp) / "shared builds"
        builds.mkdir()
        return root, bundle, builds

    def run_script(self, root: Path, *args: str) -> subprocess.CompletedProcess:
        env = dict(os.environ)
        env.pop("HEELER_BUILDS", None)
        return subprocess.run(["bash", str(root / "scripts" / "linux-stage.sh"), *args], capture_output=True, text=True, env=env, cwd=Path(root).parent)

    @unittest.skipUnless(POSIX and shutil.which("bash"), "a bash script")
    def test_it_moves_this_versions_appimage_and_no_other(self):
        with tempfile.TemporaryDirectory() as tmp:
            root, bundle, builds = self.tree(tmp)
            dry = self.run_script(root, "--builds", str(builds), "--dry-run")
            self.assertEqual(dry.returncode, 0, dry.stderr)
            self.assertIn("nothing moved", dry.stdout)
            self.assertEqual(list(builds.iterdir()), [], "a dry run moves nothing")
            self.assertTrue((bundle / "Heeler-31.2.7-linux.AppImage").exists())
            done = self.run_script(root, "--builds", str(builds))
            self.assertEqual(done.returncode, 0, done.stderr)
            self.assertEqual([p.name for p in builds.iterdir()], ["Heeler-31.2.7-linux.AppImage"])
            self.assertEqual((builds / "Heeler-31.2.7-linux.AppImage").read_text(), "this release")
            self.assertEqual([p.name for p in bundle.iterdir()], ["Heeler-31.2.6-linux.AppImage"], "moved, and the older build left alone")

    @unittest.skipUnless(POSIX and shutil.which("bash"), "a bash script")
    def test_one_already_staged_is_kept_unless_forced(self):
        with tempfile.TemporaryDirectory() as tmp:
            root, bundle, builds = self.tree(tmp)
            (builds / "Heeler-31.2.7-linux.AppImage").write_text("staged earlier")
            kept = self.run_script(root, f"--builds={builds}")
            self.assertEqual(kept.returncode, 1)
            self.assertIn("already there", kept.stderr)
            self.assertEqual((builds / "Heeler-31.2.7-linux.AppImage").read_text(), "staged earlier")
            self.assertTrue((bundle / "Heeler-31.2.7-linux.AppImage").exists())
            forced = self.run_script(root, f"--builds={builds}", "--force")
            self.assertEqual(forced.returncode, 0, forced.stderr)
            self.assertEqual((builds / "Heeler-31.2.7-linux.AppImage").read_text(), "this release")

    @unittest.skipUnless(POSIX and shutil.which("bash"), "a bash script")
    def test_it_stops_with_a_reason(self):
        with tempfile.TemporaryDirectory() as tmp:
            root, bundle, builds = self.tree(tmp)
            away = self.run_script(root, "--builds", str(Path(tmp) / "not mounted"))
            self.assertEqual(away.returncode, 1)
            self.assertIn("Mount the shared drive", away.stderr)
            wrong = self.run_script(root, "--builds", str(builds), "--dry-runn")
            self.assertEqual(wrong.returncode, 2)
            (bundle / "Heeler-31.2.7-linux.AppImage").unlink()
            unbuilt = self.run_script(root, "--builds", str(builds))
            self.assertEqual(unbuilt.returncode, 1)
            self.assertIn("Build it first", unbuilt.stderr)
            self.assertEqual(list(builds.iterdir()), [])


class LinuxTestScript(unittest.TestCase):
    """scripts/linux-test.sh pulls, then runs the suites: in a clone of
    a small repository whose scripts/test.py prints a file the remote
    changes, so the output says which commit the suites ran on."""

    def git(self, cwd: Path, *args: str) -> None:
        env = dict(os.environ, GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@example.com", GIT_COMMITTER_NAME="t", GIT_COMMITTER_EMAIL="t@example.com")
        subprocess.run(["git", "-c", "init.defaultBranch=main", "-c", "commit.gpgsign=false", *args], cwd=cwd, check=True, capture_output=True, env=env)

    def repos(self, tmp: str) -> tuple[Path, Path]:
        origin = Path(tmp) / "origin"
        (origin / "scripts").mkdir(parents=True)
        shutil.copy(heeler_build.REPO_ROOT / "scripts" / "linux-test.sh", origin / "scripts" / "linux-test.sh")
        (origin / "scripts" / "test.py").write_text("import sys\nfrom pathlib import Path\nprint('suites ran on', Path('marker').read_text().strip())\nsys.exit(3)\n")
        (origin / "marker").write_text("first\n")
        self.git(origin, "init")
        self.git(origin, "add", ".")
        self.git(origin, "commit", "-m", "first")
        clone = Path(tmp) / "clone"
        self.git(Path(tmp), "clone", str(origin), str(clone))
        return origin, clone

    def run_script(self, clone: Path, *args: str) -> subprocess.CompletedProcess:
        return subprocess.run(["bash", str(clone / "scripts" / "linux-test.sh"), *args], capture_output=True, text=True, cwd=Path(clone).parent)

    @unittest.skipUnless(POSIX and shutil.which("bash") and shutil.which("git") and shutil.which("python3"), "bash, git and python3")
    def test_it_pulls_first_and_hands_back_the_suites_exit_code(self):
        with tempfile.TemporaryDirectory() as tmp:
            origin, clone = self.repos(tmp)
            (origin / "marker").write_text("second\n")
            self.git(origin, "commit", "-am", "second")
            done = self.run_script(clone)
            self.assertIn("suites ran on second", done.stdout, done.stderr)
            self.assertEqual(done.returncode, 3, "the suites' own exit code")

    @unittest.skipUnless(POSIX and shutil.which("bash") and shutil.which("git") and shutil.which("python3"), "bash, git and python3")
    def test_a_pull_that_cannot_fast_forward_runs_no_suite(self):
        with tempfile.TemporaryDirectory() as tmp:
            origin, clone = self.repos(tmp)
            (origin / "marker").write_text("second\n")
            self.git(origin, "commit", "-am", "second")
            (clone / "marker").write_text("mine\n")
            self.git(clone, "commit", "-am", "local work")
            done = self.run_script(clone)
            self.assertNotEqual(done.returncode, 0)
            self.assertNotIn("suites ran", done.stdout)
            self.assertEqual(self.run_script(clone, "--fast").returncode, 2, "it takes no options")


class WindowsStageScript(unittest.TestCase):
    """scripts/windows-stage.ps1 moves this release's installer onto the
    shared folder. Windows only: there is no PowerShell elsewhere."""

    def tree(self, tmp: str) -> tuple[Path, Path, Path]:
        root = Path(tmp) / "repo"
        (root / "scripts").mkdir(parents=True)
        shutil.copy(heeler_build.REPO_ROOT / "scripts" / "windows-stage.ps1", root / "scripts" / "windows-stage.ps1")
        (root / "Cargo.toml").write_text(CARGO.format(version="31.2.7"))
        bundle = root / "target" / "release" / "bundle" / "nsis"
        bundle.mkdir(parents=True)
        (bundle / "Heeler-31.2.7-windows.exe").write_text("this release")
        (bundle / "Heeler-31.2.6-windows.exe").write_text("the last one")
        builds = Path(tmp) / "shared builds"
        builds.mkdir()
        return root, bundle, builds

    def run_script(self, root: Path, *args: str) -> subprocess.CompletedProcess:
        env = dict(os.environ)
        env.pop("HEELER_BUILDS", None)
        return subprocess.run(
            ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(root / "scripts" / "windows-stage.ps1"), *args],
            capture_output=True, text=True, env=env, cwd=Path(root).parent,
        )

    @unittest.skipUnless(sys.platform == "win32" and shutil.which("powershell"), "Windows PowerShell")
    def test_it_moves_this_versions_installer_and_no_other(self):
        with tempfile.TemporaryDirectory() as tmp:
            root, bundle, builds = self.tree(tmp)
            for dry in ["-DryRun", "--dry-run"]:
                done = self.run_script(root, "-Builds", str(builds), dry)
                self.assertEqual(done.returncode, 0, done.stderr)
                self.assertEqual(list(builds.iterdir()), [], f"{dry} moves nothing")
            done = self.run_script(root, "-Builds", str(builds))
            self.assertEqual(done.returncode, 0, done.stderr)
            self.assertEqual([p.name for p in builds.iterdir()], ["Heeler-31.2.7-windows.exe"])
            self.assertEqual((builds / "Heeler-31.2.7-windows.exe").read_text(), "this release")
            self.assertEqual([p.name for p in bundle.iterdir()], ["Heeler-31.2.6-windows.exe"], "moved, and the older build left alone")

    @unittest.skipUnless(sys.platform == "win32" and shutil.which("powershell"), "Windows PowerShell")
    def test_one_already_staged_is_kept_unless_forced_and_a_missing_folder_stops_it(self):
        with tempfile.TemporaryDirectory() as tmp:
            root, bundle, builds = self.tree(tmp)
            away = self.run_script(root, "-Builds", str(Path(tmp) / "not connected"))
            self.assertEqual(away.returncode, 1)
            self.assertTrue((bundle / "Heeler-31.2.7-windows.exe").exists())
            (builds / "Heeler-31.2.7-windows.exe").write_text("staged earlier")
            kept = self.run_script(root, "-Builds", str(builds))
            self.assertEqual(kept.returncode, 1)
            self.assertEqual((builds / "Heeler-31.2.7-windows.exe").read_text(), "staged earlier")
            forced = self.run_script(root, "-Builds", str(builds), "-Force")
            self.assertEqual(forced.returncode, 0, forced.stderr)
            self.assertEqual((builds / "Heeler-31.2.7-windows.exe").read_text(), "this release")


class PipelineScriptModes(unittest.TestCase):
    def test_the_shell_scripts_are_executable_in_the_repository(self):
        # The mode git records is what a fresh clone gets on the Mac and on
        # Linux (2026-10-03: "make sure the mac and linux shell scripts are
        # set to be executable").
        for name in ["macos-release.zsh", "linux-stage.sh", "linux-test.sh", "linux-setup.sh"]:
            listed = subprocess.run(["git", "ls-files", "--stage", f"scripts/{name}"], cwd=heeler_build.REPO_ROOT, capture_output=True, text=True).stdout
            self.assertTrue(listed.startswith("100755 "), f"{name}: {listed!r}")


if __name__ == "__main__":
    unittest.main()
