# Flick

Throw files from your Android phone onto your PC (Windows, Mac or Linux) with a flick, and send PC files back to the
phone. Share the clipboard and links, sync folders, see phone notifications on the PC, use the phone as a media remote,
and share files with an iPhone or any computer through a browser. Phone and PC talk directly (Wi-Fi, a USB cable, the
phone's hotspot or Bluetooth), encrypted; nothing goes through the internet.

## Install

1. On the PC, from the latest [release](https://github.com/Maniw1234/flick/releases/latest):
   - **Windows** 10 or 11, 64-bit: download `Flick-Setup.exe` and run it. Flick isn't code-signed, so Windows may show
     "Windows protected your PC" the first time: click **More info**, then **Run anyway** (once). Your browser may also
     warn that the file isn't commonly downloaded: keep it.
   - **Mac** (macOS 13 or newer): `Flick-mac-arm64.dmg` for Apple silicon (M1 and newer), `Flick-mac-x64.dmg` for an
     Intel Mac. Open it and drag Flick to Applications. Or install it with [Homebrew](https://brew.sh):
     `brew install --cask maniw1234/flick/flick`. Flick isn't notarized by Apple (there's no paid Apple Developer
     account), so macOS refuses to open it the first time: open System Settings > Privacy & Security, scroll down to
     the message about Flick and click **Open Anyway** (once). When macOS asks whether Flick may find devices on the
     local network, allow it: Flick can't reach the phone without it.
   - **Linux** (64-bit): `Flick-linux-x86_64.AppImage`: make it executable (`chmod +x`) and run it. Or unpack
     `Flick-linux-x64.tar.gz` anywhere and run `Flick/flick`. Either way Flick adds itself to the applications menu.
2. On the phone (Android 9 or newer): open the same release page, download `Flick-<version>.apk` and install it
   (Android asks you to allow installs from your browser once).
3. Open Flick on both (on the same Wi-Fi), press and hold **Connect** on the phone, check that both
   screens show the same code, then click **Allow** on the PC and tap **Same code** on the phone.

Both update themselves after that.

## Mac and Linux

The PC app is the same everywhere, with these differences:

- **Sending PC files to the phone:** on Windows, File Explorer's right-click menu has Send with Flick and Send to >
  Flick (phone). On a Mac, drop files on Flick in the menu bar or in the Dock, or right-click them in Finder and choose
  Open With > Flick. On Linux, choose Open With > Flick in the file manager.
- **Bluetooth** is Windows only.
- **The phone as a media remote:** on a Mac, macOS asks once to let Flick control the computer (Privacy & Security >
  Accessibility); on Linux it needs `playerctl` (for example `sudo apt install playerctl`). Flick on the PC says so
  when the phone's remote is used without it.
- **Linux:** under Wayland Flick runs through X11 (XWayland), since its animations cover the screen and stay on top,
  which Wayland doesn't let a window do. Received files go to Downloads. To remove Flick, delete the AppImage or the
  folder, and `~/.local/share/applications/flick.desktop` and `~/.config/autostart/flick.desktop`.

## What's in here

| Folder | What it is |
|---|---|
| `pc/` | PC app (Electron, for Windows, macOS and Linux; `platform.js` holds what macOS and Linux do differently): LAN server (HTTP, WebSocket, UDP discovery, mDNS), the transparent overlay with the animation themes (Roadster, Liquid, Teleport, Halo), the settings panel, the service that hands phone updates to the phone, the phone features (`phoneapi.js`, `features.js`, `sync.js`, `clip.js`, `history.js`, `keys.js`, `browse.js`, `cliphist.js`, `ask.js`), files already received (`have.js`), the PC's own Wi-Fi network (`hotspot.js`), Send feedback (`feedback.js`) and the "Share with a browser" page (`webshare.js`, `web/`) |
| `phone/` | The phone app's interface (HTML, CSS, JS) that runs inside the Android app's WebView |
| `android/` | Android app (Java, built without Gradle): WebView host, file browser access, transfers (the send engine that carries on in the background: `Outbox.java`, `Wire.java`, `Sends.java`), folder bundles, self-updater, and the background parts of the features (link service, auto-send, tiles, widget, notification forwarding, folder sync, Browse phone, clipboard history, Send feedback) |
| `native/` | Small helpers: on Windows (built with MinGW) `flick-bt.c` offers Flick's Bluetooth service and `flick-keys.c` presses media keys for the phone's remote; `flick-keys-mac.swift` does the same on a Mac |
| `ci/` | The release workflow's phone-app step (`phone_app.sh`) |
| `installer/` | NSIS script for `Flick-Setup.exe`, and the Linux launcher (`flick-launcher.sh`) |
| `packaging/` | winget manifests and the Homebrew cask, and the script that fills them in for a release |
| `signing/` | How the phone app and releases are signed, plus helper tools (no keys) |
| `art/` | Icons |

## Releasing a new version

1. Raise `"version"` in `pc/package.json` and add a `## <version>` section to `CHANGES.md`.
2. Push to `main`.
3. When the release is out, sign it on the computer that keeps the release key: `node signing/sign_release.js <version>`
   (`signing/README.md`). Installed copies don't take a release before that.
4. Then fill in the winget manifests and the Homebrew cask for it: `node packaging/update.js <version>`
   (`packaging/README.md`).

GitHub Actions (`.github/workflows/release.yml`) then builds the Windows app and its installer, the two Mac apps and
their disk images (on a Mac), and the Linux AppImage and tar.gz, and publishes one release with `Flick-Setup.exe`,
`Flick-mac-arm64.dmg`, `Flick-mac-x64.dmg`, `Flick-linux-x86_64.AppImage`, `Flick-linux-x64.tar.gz`, the update bundles
(`flick-app-<version>.zip` for Windows, `flick-app-mac-<version>.zip`, `flick-app-linux-<version>.zip`), the phone app
and `SHA256SUMS`, which lists every one of them.
If `android/`, `phone/` or `build_apk.sh` changed since the last release, it also builds the phone app as the new
version and signs it with the `FLICK_SIGNING_KEY` secret (`signing/README.md`); otherwise the last release's phone app
is reused, so phones aren't asked to update for nothing. A push without a new version number doesn't release anything.
To try the whole build without publishing: Actions > Release > Run workflow, tick "Only build and check" (the
builds can be downloaded from the run for five days).

## How updates reach your devices

- **PC:** Flick checks the latest GitHub release when it starts and every 30 minutes. Once the release's `SHA256SUMS`
  carries a valid `SHA256SUMS.sig` (Flick's release key), it downloads its system's update bundle
  (`flick-app-<version>.zip` on Windows, `flick-app-mac-<version>.zip`, `flick-app-linux-<version>.zip`), checks its
  SHA-256 against that signed list, unpacks it into a folder of the user's (`%LOCALAPPDATA%\Flick\app` on Windows,
  `~/Library/Application Support/Flick/app` on a Mac, `~/.local/share/Flick/app` on Linux), and restarts into it once
  no transfer is running (`pc/updater.js`, `pc/boot.js`). No installer and no admin prompt is involved. If a new
  version fails to start three times, Flick goes back to the installed copy and skips that version.
- **Phone:** the phone app checks the latest GitHub release when it opens (and every few hours while open) and
  downloads the new `Flick-<version>.apk` from it; a paired PC also offers it over Wi-Fi, with its release's signed
  `SHA256SUMS`. Either way the phone checks that the signed `SHA256SUMS` lists that exact file, and its size, version
  and signing key, and shows **Install**. Android then asks for one more tap to confirm. The phone app needs Android 9
  or newer (the PC doesn't offer it to older phones).

## Connections

- **Wi-Fi, USB cable, hotspot:** the phone finds the PC with a UDP broadcast on every network it is on (Wi-Fi, USB
  tethering, its own hotspot) and uses the fastest one: cable, then hotspot/direct, then Wi-Fi through a router.
  If a faster link appears while connected (a cable is plugged in), it moves over once nothing is being sent.
  It also asks over mDNS (`_flick._tcp`, answered by `pc/mdns.js`) and asks directly at every address each paired PC
  was seen at (the PC lists its addresses when a phone connects), so a PC is found again on networks that drop
  broadcasts or put it in another subnet.
- **Bluetooth** (Windows): for when there's no network. The PC runs `bin/flick-bt.exe` (an RFCOMM service with
  Flick's UUID) when Bluetooth is on in its settings; the phone connects to a paired PC and runs the normal
  HTTP/WebSocket traffic over it through a small multiplexer (`pc/mux.js`, `android/.../BtMux.java`). Much slower than
  Wi-Fi.
- **Quick Share:** `pc/quickshare.js` makes the PC a Quick Share receiver on the local network (mDNS advertisement,
  UKEY2 key exchange, encrypted Nearby frames). The PC asks before accepting and shows the same code as the phone.
- **Large files** go over several connections at once (`/api/part` up, HTTP byte ranges down), and **batches**
  (several files or folders) are split across several `/api/bundle` streams (`streams=k&stream=i`) that write into one
  staging folder on the PC. Once every part of a large file is in, the phone sends the file's SHA-256
  (`commit=1&sha256=…`) and the PC reads back the file it assembled: only a match counts as received; a mismatch is
  refused (422) and the phone sends the file again.
- **Sends that carry on** (protocol 7): the phone's sends are jobs in the app (`Outbox`, `Sends`; written down in
  `files/outbox`), sent straight over pinned TLS (`Wire`) and kept going by a foreground service, with `ResumeJob`
  (JobScheduler) bringing the app back if Android stopped it. With `resume=1` the PC keeps what arrived of each part
  or bundle stream for 6 hours, `GET /api/status` says how far each got, and the phone sends the rest (`from=` bytes
  into a part; `skip=`/`from=` for a bundle stream, whose entries are numbered). The PC hashes each part as it
  arrives, so the check at the end (`commit=1&sums=…`, one SHA-256 per part) only reads back parts that came out of
  order. Also `/api/speed` (Settings > Speed test), `/api/have` (files the PC already has, by name, size and a
  fingerprint of their first and last 256 KB; `pc/have.js`, `Have.java`) and `/api/cancel`. A send canceled or
  turned down on the PC is answered 410 from then on (with `why=declined|timeout` when the PC's user turned it down
  under "Ask each time"); Try again on the phone starts a new attempt with `again=1`, which the PC takes.
- **The PC's own Wi-Fi** (`pc/hotspot.js`), for Share with a browser from another network: the Windows Mobile hotspot
  (PowerShell, WinRT tethering) or, without an internet connection to share, a Wi-Fi Direct network Flick keeps up;
  NetworkManager's hotspot on Linux. The panel shows a Wi-Fi QR code (`WIFI:T:WPA;S:…;P:…;;`) and the page's.
- **Background link:** with "Stay connected in the background" on, the phone's `LinkService` keeps
  `GET /api/events` open (one JSON event per line: clipboard, links, ringing, Browse phone), so the features work
  while Flick is closed; tiles, the widget, auto-send and notification forwarding post to the same encrypted link
  (`PcClient`).
- **Several phones:** up to four stay connected; PC-initiated sends go to the phone in use, chosen in the
  panel or by using a phone, and replies about a transfer go to the phone that started it.
- **Browsers** (Share with a browser): `http://<PC address>:47860/w/<token>/`, from the QR code in the panel. Plain
  HTTP on the same port, with its own routes and checks (`pc/webshare.js`).

## Security

- **Encrypted links.** Everything between phone and PC travels over TLS on the PC's port 47860 (the same port also
  answers plain HTTP, for the browser page). Each PC makes its own certificate once
  (`tls-cert.pem` in its settings folder); a phone pins its SHA-256 when it pairs and from then on connects to no
  other. The phone app reaches the PC through a local port inside the phone (`TlsProxy`); its network security config
  allows unencrypted connections only to the phone itself. Bluetooth links are encrypted by Bluetooth.
- **Pairing.** The PC asks before a new phone can connect, and both screens show the same 6-digit code: the phone
  commits to its half of the code before the PC sends its half, so nobody in between can make the codes match. The
  user clicks Allow on the PC and taps Same code on the phone: the PC gives the phone a random token only after Allow,
  and the phone keeps it (and pins the certificate) only after Same code, so a stranger answering in the PC's place
  gets nowhere either.
- **Signing in.** The token never crosses the network: on every connection the PC proves it holds the phone's token
  (an HMAC over both sides' random numbers and the certificate the phone sees), then the phone proves the same. A
  relay in the middle (with its own certificate) can neither read nor pass on these proofs. A pairing made without the
  code (its token crossed the network in the clear) signs nothing in: that phone is asked to pair again with the code.
- **Requests.** Every upload, download and update fetch needs the token, and once a phone has signed in securely, its
  token works only over an encrypted link (a pairing made without the code is good for plain file transfers only, until
  that phone pairs again). The phone only accepts files, status and updates from the PC it signed in
  to. Pairing prompts are rate-limited, and browsers can't reach the phone API (a web `Origin` or a DNS-name `Host`
  gets 403).
- **Received files** are marked as downloaded from the internet (`Zone.Identifier`), so Windows SmartScreen and
  Office Protected View apply; on a Mac they get the quarantine mark, so Gatekeeper checks an app or script before it
  first opens. "Open files when they arrive" never launches programs, scripts or shortcuts.
- **Limits.** WebSocket messages, pre-accept Quick Share data, open connections (64 per address, 512 in all) and
  Bluetooth stream buffers are capped; request headers must arrive within 20 seconds; WebSocket frames that break the
  protocol (unmasked, reserved bits, unknown opcodes) close the connection; uploads and Quick Shares that won't fit on
  the disk are refused up front.
- **Bluetooth** accepts only paired devices over an encrypted link.
- **Phone features.** Clipboard, links, notifications, folder sync, the background link and the remote work only for a
  phone paired with the code, over an encrypted link: a token from a pairing made without it reaches none of them. Links
  open only `http`/`https` addresses. Synced folders stay inside `<save folder>/Flick Sync/`, one per phone, and refuse
  `..`, absolute paths, Windows reserved names, `:` streams, links and direction marks; nothing is ever deleted.
  Notification forwarding is off until the user turns it on and grants access; clipboards that a password manager marks
  as private are never sent, and a clipboard is never sent back to where it came from.
- **Browse phone** is off until "Let your PC browse this phone" is turned on in the phone's Settings. The PC can then
  only list and copy files in shared storage (never hidden files, `Android/data` or `Android/obb`), never change or
  delete one; the phone answers only the PC it paired with (`PcClient`), and both sides rate-limit the requests. The PC
  takes only answers to requests it made; a "copy" it didn't ask for is treated like any other file from that phone.
- **Ask each time** (per phone, on the PC) saves nothing from that phone before the user clicks Accept; Decline, or no
  answer within a minute, deletes what arrived. **Clipboard histories** (the last 20 on each side) stay on that device
  and never keep a clipboard marked as private.
- **Send feedback** posts to a Google Form only when the user presses Send, with what the form showed: the message,
  the email if given, and the device info and the last crash report only when ticked. Without a connection it waits on
  the device until it can be sent.
- **Lock Flick** (phone Settings, off until turned on, and only on a phone with a screen lock): Flick asks for the
  phone's fingerprint, face or PIN when it opens and when it comes back after more than 30 seconds away, and covers its
  screen until then (Recents shows no picture of it either). Only the screen is locked: transfers and the background
  features keep running, and the Quick Settings tiles and the widget keep working, since they only send the last photo
  or the clipboard and show no files (`AppLock.java`).
- **Share with a browser.** Browsers can't pin Flick's certificate, so this part is plain HTTP: anyone on the network
  could read what an allowed browser sends or downloads. The link carries a random token; the PC asks before each
  browser joins and both screens show a 4-digit code; a browser's session works only from the address that was allowed;
  sharing ends when stopped or after 30 minutes without activity. Its pages can't reach the phone API.
- **Updates.** Every release's `SHA256SUMS` is signed with an offline release key that GitHub never sees; the PC and the
  phone install nothing that signed list doesn't vouch for, so a hijacked GitHub account can't ship an update. The
  phone app is signed only with Flick's own key (Android 9 and newer), which Android checks too. CI pins every
  downloaded tool by checksum and every action it uses by commit.

## Building by hand

The builds run on Linux, except the Mac disk images, which need a Mac.

- `./build_apk.sh <versionCode> <versionName>` builds the phone app (javac, d8 or dx, aapt2, and `FlickSign.java` with
  uber-apk-signer's apksig). The version code is `100000 + major*10000 + minor*100 + patch` (110000 for 1.0.0). It
  uses the Android SDK in `$ANDROID_HOME` (platform 34, build-tools 34.0.0), `uber-apk-signer.jar` in `$FLICK_TOOLS`
  (default `~/flick-tools`) and the private signing key in `$FLICK_KEYS` (default `~/flick-keys`, see
  `signing/README.md`). `pc/phone-app/Flick.apk` isn't committed: build it, or take it from the latest release, before
  building the PC app.
- `./build_win.sh` builds `build/win/Flick-Setup.exe` and the update bundle (Electron for Windows and rcedit from
  `$FLICK_TOOLS`, Wine, NSIS, and a MinGW C compiler for the Bluetooth and media-key helpers).
- `./build_mac.sh` builds `build/mac/Flick-mac-arm64.dmg`, `Flick-mac-x64.dmg` and the update bundle on a Mac
  (Electron's macOS zips from `$FLICK_TOOLS`, and Xcode's command line tools: `swiftc` for the media-key helper,
  `codesign`, `hdiutil`). Elsewhere it stops at the two `Flick.app` folders, unsigned and without the helper.
- `./build_linux.sh` builds `build/linux/Flick-linux-x86_64.AppImage`, `Flick-linux-x64.tar.gz` and the update bundle
  (Electron for Linux, appimagetool and the AppImage runtime from `$FLICK_TOOLS`).

Each tool path can also be set with its own environment variable; the workflow shows how. Electron is the same
version for every system (`electronVersion` in `pc/package.json`, with the checksum of each download next to it).

## Versions

See `CHANGES.md`.

## License

MIT. See `LICENSE`.
