# Release checklist

1. Build with `scripts/dist.py` in the source repository. It signs, notarizes, and staples the macOS bundle and refuses to finish otherwise.
2. Create the GitHub Release as a DRAFT with tag `v<version>` (for example `v26.1.1`). Attach `Heeler-macos.dmg` and `Heeler-windows-setup.exe`. Paste the release notes into the release body.
3. In the source repository run `python scripts/latest_json.py --notes-file NOTES.md`. It reads the draft through `gh`, writes `latest.json` pointing at the installers attached, and attaches it to the draft, so the manifest publishes in the same instant as the installers. [latest.json.example](latest.json.example) shows the shape.
4. Publish. `python scripts/latest_json.py --check` confirms `https://github.com/vagabond-burro/heeler/releases/latest/download/latest.json` returns the new file; the redirect can take a minute.
5. Run **Help > Check for Updates** in the previous version and confirm it offers the new one.

A pre-release (the checkbox on the release form) is skipped by the `latest` redirect, so a beta can carry its own `latest.json` without reaching users on the release channel.
