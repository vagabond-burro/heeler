# Release checklist

1. Build with `scripts/dist.py` in the source repository. It signs, notarizes, and staples the macOS bundle and refuses to finish otherwise.
2. Write `latest.json` from [latest.json.example](latest.json.example): bump `version`, set `pub_date` to now in UTC, replace `notes`, and point each platform `url` at the asset name the release will carry under the tag `v<version>`.
3. Create the GitHub Release with tag `v<version>` (for example `v26.1.0`). Attach every installer and `latest.json`. Paste the release notes into the release body.
4. Publish. Confirm `https://github.com/vagabond-burro/heeler/releases/latest/download/latest.json` returns the new file; the redirect can take a minute.
5. Run **Help > Check for Updates** in the previous version and confirm it offers the new one.

A pre-release (the checkbox on the release form) is skipped by the `latest` redirect, so a beta can carry its own `latest.json` without reaching users on the release channel.
