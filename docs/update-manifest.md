# The update manifest

The file `latest.json` at the root of this repository's `main` branch names the current release. The app (from 2026.2.1) and the website's download button both read it at one fixed URL:

```
https://raw.githubusercontent.com/vagabond-burro/heeler/main/latest.json
```

It is written by a script in the source repository from the installers attached to the published release, staged on the `dev` branch, and merged into `main` to make the release live for both readers at once. Apps before 2026.2.1 read the copy attached to each release through GitHub's `releases/latest/download/latest.json` redirect, so every release still carries one.

## Format

The shape is the Tauri updater manifest, so moving from "check and link" to in-place updates later needs no change here.

```json
{
  "version": "26.1.0",
  "notes": "One paragraph of what changed, plain text.",
  "pub_date": "2026-09-15T17:00:00Z",
  "platforms": {
    "darwin-aarch64": {
      "url": "https://github.com/vagabond-burro/heeler/releases/download/v26.1.0/Heeler-26.1.0-macos.dmg",
      "signature": ""
    },
    "windows-x86_64": {
      "url": "https://github.com/vagabond-burro/heeler/releases/download/v26.1.0/Heeler-26.1.0-windows.msi",
      "signature": ""
    }
  }
}
```

- `version` is the carried form, `YY.UPDATE.PATCH`, exactly as in the app's `tauri.conf.json`. The app shows it as `2026.1`. Compare as three integers, never as strings.
- `pub_date` is RFC 3339 in UTC.
- `platforms` keys are Tauri target triples: `darwin-aarch64`, `darwin-x86_64`, `windows-x86_64`. A platform with no installer in a release is left out, and the app treats a missing key as "no update for this machine".
- `url` is the release asset's permanent download URL, which includes the tag, so an old manifest keeps pointing at the right file after newer releases exist.
- `signature` is the minisign signature the Tauri updater will require once in-place updates ship. Until then it is the empty string and the app ignores it.

## How the app uses it

The app fetches the manifest with a ten second timeout on launch (unless the preference turning that off is set) and when the user chooses **Help > Check for Updates**. It compares `version` to its own. Newer means it offers to open the release page in the browser; equal or older means "You're up to date"; any failure to fetch means nothing on launch and a "could not reach the release list" message from the menu item. The app never downloads or runs anything on its own.

The fetch reveals the machine's IP address and, through the platform it asks for, its operating system. That is stated in the Heeler privacy policy.
