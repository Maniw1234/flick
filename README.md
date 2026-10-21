# Flick

Throw files from your Android phone onto your Windows PC with a flick, and send PC files back to the phone.
Phone and PC talk directly (Wi-Fi, a USB cable, the phone's hotspot or Bluetooth); nothing goes through the internet.

## What's in here

| Folder | What it is |
|---|---|
| `pc/` | Windows app (Electron): LAN server (HTTP, WebSocket, UDP discovery), the transparent overlay with the animation themes (Roadster, Liquid, Teleport, Halo), the settings panel, and the service that hands phone updates to the phone |
| `phone/` | The phone app's interface (HTML, CSS, JS) that runs inside the Android app's WebView |
| `android/` | Android app (Java, built without Gradle): WebView host, file browser access, transfers, folder bundles, self-updater |
| `native/` | `flick-bt.c`: the small Windows helper that offers Flick's Bluetooth service (built with MinGW) |
| `ci/` | The release workflow's phone-app step (`phone_app.sh`) |
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
- **Phone:** the phone app checks the latest GitHub release when it opens (and every few hours while open) and
  downloads the new `Flick-<version>.apk` from it; a paired PC also offers it over Wi-Fi. Either way the phone checks
  the size, SHA-256, version and signing key, and shows **Install**. Android then asks for one more tap to confirm.

## Connections

- **Wi-Fi, USB cable, hotspot:** the phone finds the PC with a UDP broadcast on every network it is on (Wi-Fi, USB
  tethering, its own hotspot) and uses the fastest one: cable, then hotspot/direct, then Wi-Fi through a router.
  If a faster link appears while connected (a cable is plugged in), it moves over once nothing is being sent.
- **Bluetooth:** for when there's no network. The PC runs `bin/flick-bt.exe` (an RFCOMM service with Flick's UUID)
  when Bluetooth is on in its settings; the phone connects to a paired PC and runs the normal HTTP/WebSocket traffic
  over it through a small multiplexer (`pc/mux.js`, `android/.../BtMux.java`). Much slower than Wi-Fi.
- **Quick Share:** `pc/quickshare.js` makes the PC a Quick Share receiver on the local network (mDNS advertisement,
  UKEY2 key exchange, encrypted Nearby frames). The PC asks before accepting and shows the same code as the phone.
- **Large files** go over several connections at once (`/api/part` up, HTTP byte ranges down) when both sides speak
  protocol 2.

## Security

- **Pairing.** A phone gets a random token only after the user clicks Allow on the PC. Every upload, download and
  update fetch needs it, and the phone in turn only accepts files, status and updates from a PC it holds a token for.
  Pairing prompts are rate-limited, and browsers are refused (a web page can't reach the PC's server: requests with a
  web `Origin` or a DNS-name `Host` get 403).
- **Received files** are marked as downloaded from the internet (`Zone.Identifier`), so Windows SmartScreen and
  Office Protected View apply. "Open files when they arrive" never launches programs, scripts or shortcuts.
- **Limits.** WebSocket messages, pre-accept Quick Share data, sockets per address and Bluetooth stream buffers are
  capped; uploads and Quick Shares that won't fit on the disk are refused up front.
- **Bluetooth** accepts only paired devices over an encrypted link.
- **Updates.** The PC verifies each update bundle's SHA-256 (from GitHub, over HTTPS) before installing it; Android
  checks the phone app's signature. CI pins every downloaded tool by checksum and the checkout action by commit.
- **Not yet:** traffic between phone and PC is plain HTTP on the local network (pairing tokens included), so someone
  sniffing the same Wi-Fi could read it. Encrypting it (TLS with a key pinned at pairing) is the next step.

## Building by hand

Both builds run on Linux.

- `./build_apk.sh <versionCode> <versionName>` builds the phone app (javac, dx or d8, aapt2, uber-apk-signer). It needs
  the private signing key described in `signing/README.md`. `pc/phone-app/Flick.apk` isn't committed: build it, or take
  it from the latest release, before running `./build_win.sh`.
- `./build_win.sh` builds `build/win/Flick-Setup.exe` and the update bundle (Electron for Windows, rcedit through Wine,
  NSIS, and a MinGW C compiler for the Bluetooth helper). Tool paths can be set with environment variables; the
  workflow shows how.

## Versions

See `CHANGES.md`.
