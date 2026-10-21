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
2. If the phone app changed, rebuild it with `./build_apk.sh <versionCode> <versionName>`, where
   versionCode = major×10000 + minor×100 + patch. That writes the signed `pc/phone-app/Flick.apk`.
3. Push to `main`.

GitHub Actions (`.github/workflows/release.yml`) then builds the Windows app and its installer and publishes the
release with `Flick-Setup.exe`, `flick-app-<version>.zip` (the update bundle), the phone app and `SHA256SUMS`.
A push without a new version number doesn't release anything.

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
  the private signing key described in `signing/README.md`, which is deliberately not on GitHub.
- `./build_win.sh` builds `build/win/Flick-Setup.exe` and the update bundle (Electron for Windows, rcedit through Wine,
  NSIS). Tool paths can be set with environment variables; the workflow shows how.

## Versions

See `CHANGES.md`.
