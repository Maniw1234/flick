# Flick

Throw files from your Android phone onto your Windows PC with a flick, and drag PC files back to the phone.
Phone and PC talk directly over your Wi-Fi; nothing goes through the internet.

## What's in here

| Folder | What it is |
|---|---|
| `pc/` | Windows app (Electron): LAN server (HTTP, WebSocket, UDP discovery), the transparent overlay with the animation themes (Roadster, Liquid, Teleport, Halo), the settings panel, and the service that hands phone updates to the phone |
| `phone/` | The phone app's interface (HTML, CSS, JS) that runs inside the Android app's WebView |
| `android/` | Android app (Java, built without Gradle): WebView host, file browser access, transfers, folder bundles, self-updater |
| `installer/` | NSIS script for `Flick-Setup.exe` |
| `signing/` | How the phone app is signed, plus helper tools (no keys) |
| `art/` | Icons |

## Releasing a new version

1. Raise `"version"` in `pc/package.json` and add a `## <version>` section to `CHANGES.md`.
2. Push to `main`.

GitHub Actions (`.github/workflows/release.yml`) then builds the Windows app and its installer and publishes the
release with `Flick-Setup.exe`, `flick-app-<version>.zip` (the update bundle), the phone app and `SHA256SUMS`.
If `android/`, `phone/` or `build_apk.sh` changed since the last release, it also builds the phone app as the new
version and signs it with the `FLICK_SIGNING_KEY` secret (`signing/README.md`); otherwise the last release's phone app
is reused, so phones aren't asked to update for nothing. A push without a new version number doesn't release anything.
To try the whole build without publishing: Actions > Release > Run workflow, tick "Only build and check".

## How updates reach your devices

- **PC:** Flick checks the latest GitHub release when it starts and every 30 minutes. It downloads
  `flick-app-<version>.zip`, checks its SHA-256 against GitHub's, unpacks it into `%LOCALAPPDATA%\Flick\app`, and
  restarts into it once no transfer is running (`pc/updater.js`, `pc/boot.js`). No installer and no admin prompt is
  involved. If a new version fails to start three times, Flick goes back to the installed copy and skips that version.
- **Phone:** the PC app carries the phone app. When a paired phone connects, the PC tells it the newest version.
  The phone downloads it in the background over Wi-Fi, checks the size, SHA-256, version and signing key, and shows
  **Install**. Android then asks for one more tap to confirm.

## Building by hand

Both builds run on Linux.

- `./build_apk.sh <versionCode> <versionName>` builds the phone app (javac, dx or d8, aapt2, uber-apk-signer). It needs
  the private signing key described in `signing/README.md`. `pc/phone-app/Flick.apk` isn't committed: build it, or take
  it from the latest release, before running `./build_win.sh`.
- `./build_win.sh` builds `build/win/Flick-Setup.exe` and the update bundle (Electron for Windows, rcedit through Wine,
  NSIS). Tool paths can be set with environment variables; the workflow shows how.

## Versions

See `CHANGES.md`.
