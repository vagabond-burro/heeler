# Release checklist

1. Build with `scripts/dist.py` in the source repository. It signs, notarizes, and staples the macOS bundle and refuses to finish otherwise.
2. In the source repository run `python scripts/release.py <the .dmg> <the .exe> --notes-file NOTES.md`, the notes a bullet list of what is new. It creates and publishes the GitHub Release with tag `v<version>` (for example `v26.2.1`), carrying the installers under the names `dist.py` gives them, `models.json`, and `latest.json` written for those names, the body filled from a template with the notes under Updates.
3. The same run checks every upload answers and commits `latest.json` to this repository's `dev` branch. [latest.json.example](latest.json.example) shows the shape. (`python scripts/latest_json.py --notes-file NOTES.md` does this half alone for a release that already exists.)
4. Merge `dev` into `main` (https://github.com/vagabond-burro/heeler/compare/main...dev). That is the moment the release is live for the app and the website. `python scripts/latest_json.py --check` confirms `main` serves the new file and every installer it names answers; raw content can lag five minutes.
5. Run **Help > Check for Updates** in the previous version and confirm it offers the new one.

Publish before merging: a manifest on `main` that names an unpublished release's installers sends every app and the download button to a 404. A pre-release (the checkbox on the release form) is attached to but never staged on `dev`, so a beta cannot reach `main` by mistake; the `latest` redirect skips it as well.
