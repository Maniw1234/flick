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

## Building

Both builds run on Linux.

- `./build_apk.sh <versionCode> <versionName>` builds `build/Flick.apk` (javac, dx, aapt2, uber-apk-signer).
  It needs the Android 34 `android.jar`, `aapt2`, `dx` and uber-apk-signer (paths at the top of the script), plus
  the private signing key described in `signing/README.md`.
- `./build_win.sh` builds `build/win/Flick-Setup.exe` (Electron for Windows, NSIS). The version comes from
  `pc/package.json`, and `build/Flick.apk` of the same version is packed inside it.

## Phone updates over Wi-Fi

The PC app carries the phone app (`phone-app/Flick.apk`) and also looks in `Downloads\Flick` for a newer Flick APK.
When a paired phone connects, the PC tells it the newest version it has. The phone downloads it over Wi-Fi, checks
the size, SHA-256, version and signing key, and then opens Android's installer to confirm.

## Versions

- **1.4.0**: phone updates over Wi-Fi; phone app signed with a private key
- **1.3.0**: select several items at once; send whole folders
- **1.2.0**: four animation themes, chosen on the PC or the phone
