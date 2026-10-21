# Flick

Throw files from your Android phone onto your Windows PC with a flick, and send PC files back to the phone.
Phone and PC talk directly (Wi-Fi, a USB cable, the phone's hotspot or Bluetooth); nothing goes through the internet.

## What's in here

| Folder | What it is |
|---|---|
| `pc/` | Windows app (Electron): LAN server (HTTP, WebSocket, UDP discovery), the transparent overlay with the animation themes (Roadster, Liquid, Teleport, Halo), the settings panel, the service that hands phone updates to the phone, the phone features (`phoneapi.js`, `features.js`, `sync.js`, `clip.js`, `history.js`, `keys.js`) and the "Share with a browser" page (`webshare.js`, `web/`) |
| `phone/` | The phone app's interface (HTML, CSS, JS) that runs inside the Android app's WebView |
| `android/` | Android app (Java, built without Gradle): WebView host, file browser access, transfers, folder bundles, self-updater, and the background parts of the 2.0 features (link service, auto-send, tiles, widget, notification forwarding, folder sync) |
| `native/` | Small Windows helpers built with MinGW: `flick-bt.c` offers Flick's Bluetooth service, `flick-keys.c` presses media keys for the phone's remote |
| `ci/` | The release workflow's phone-app step (`phone_app.sh`) |
| `installer/` | NSIS script for `Flick-Setup.exe` |
| `signing/` | How the phone app and releases are signed, plus helper tools (no keys) |
| `art/` | Icons |

## Releasing a new version

1. Raise `"version"` in `pc/package.json` and add a `## <version>` section to `CHANGES.md`.
2. Push to `main`.
3. When the release is out, sign it on the computer that keeps the release key: `node signing/sign_release.js <version>`
   (`signing/README.md`). Installed copies don't take a release before that.

GitHub Actions (`.github/workflows/release.yml`) then builds the Windows app and its installer and publishes the
release with `Flick-Setup.exe`, `flick-app-<version>.zip` (the update bundle), the phone app and `SHA256SUMS`.
If `android/`, `phone/` or `build_apk.sh` changed since the last release, it also builds the phone app as the new
version and signs it with the `FLICK_SIGNING_KEY` secret (`signing/README.md`); otherwise the last release's phone app
is reused, so phones aren't asked to update for nothing. A push without a new version number doesn't release anything.
To try the whole build without publishing: Actions > Release > Run workflow, tick "Only build and check".

## How updates reach your devices

- **PC:** Flick checks the latest GitHub release when it starts and every 30 minutes. Once the release's `SHA256SUMS`
  carries a valid `SHA256SUMS.sig` (Flick's release key), it downloads `flick-app-<version>.zip`, checks its SHA-256
  against that signed list, unpacks it into `%LOCALAPPDATA%\Flick\app`, and restarts into it once no transfer is
  running (`pc/updater.js`, `pc/boot.js`). No installer and no admin prompt is involved. If a new version fails to
  start three times, Flick goes back to the installed copy and skips that version.
- **Phone:** the phone app checks the latest GitHub release when it opens (and every few hours while open) and
  downloads the new `Flick-<version>.apk` from it; a paired PC also offers it over Wi-Fi, with its release's signed
  `SHA256SUMS`. Either way the phone checks that the signed `SHA256SUMS` lists that exact file, and its size, version
  and signing key, and shows **Install**. Android then asks for one more tap to confirm. From 1.9 the phone app needs
  Android 9 or newer; phones on Android 7 or 8 stay on 1.8 (the PC doesn't offer them newer).

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
  protocol 2; from protocol 3, **batches** (several files or folders) are split across several `/api/bundle` streams
  (`streams=k&stream=i`) that write into one staging folder on the PC.
- **Background link** (protocol 5): with "Stay connected in the background" on, the phone's `LinkService` keeps
  `GET /api/events` open (one JSON event per line: clipboard, links, ringing), so the features work while Flick is
  closed; tiles, the widget, auto-send and notification forwarding post to the same encrypted link (`PcClient`).
- **Several phones** (protocol 5): up to four stay connected; PC-initiated sends go to the phone in use, chosen in the
  panel or by using a phone, and replies about a transfer go to the phone that started it.
- **Browsers** (Share with a browser): `http://<PC address>:47860/w/<token>/`, from the QR code in the panel. Plain
  HTTP on the same port, with its own routes and checks (`pc/webshare.js`).

## Security

- **Encrypted links.** Everything between phone and PC travels over TLS on the PC's port 47860 (the same port also
  answers plain HTTP, for phone apps before 1.9 and the browser page). Each PC makes its own certificate once
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
  relay in the middle (with its own certificate) can neither read nor pass on these proofs. A phone paired with an
  older Flick sent its token in the clear, so that token signs nothing in: the phone is confirmed once more with the
  pairing code, and plain connections stop working for it.
- **Requests.** Every upload, download and update fetch needs the token, and once a phone has signed in securely, its
  token works only over an encrypted link. The phone only accepts files, status and updates from the PC it signed in
  to. Pairing prompts are rate-limited, and browsers can't reach the phone API (a web `Origin` or a DNS-name `Host`
  gets 403).
- **Received files** are marked as downloaded from the internet (`Zone.Identifier`), so Windows SmartScreen and
  Office Protected View apply. "Open files when they arrive" never launches programs, scripts or shortcuts.
- **Limits.** WebSocket messages, pre-accept Quick Share data, open connections (64 per address, 512 in all) and
  Bluetooth stream buffers are capped; uploads and Quick Shares that won't fit on the disk are refused up front.
- **Bluetooth** accepts only paired devices over an encrypted link.
- **Phone features (2.0).** Clipboard, links, notifications, folder sync, the background link and the remote work only
  for a phone paired with 1.9 or later, over an encrypted link: a token from an older pairing reaches none of them. Links
  open only `http`/`https` addresses. Synced folders stay inside `<save folder>/Flick Sync/`, one per phone, and refuse
  `..`, absolute paths, Windows reserved names, `:` streams, links and direction marks; nothing is ever deleted.
  Notification forwarding is off until the user turns it on and grants access; clipboards that a password manager marks
  as private are never sent, and a clipboard is never sent back to where it came from.
- **Share with a browser.** Browsers can't pin Flick's certificate, so this part is plain HTTP: anyone on the network
  could read what an allowed browser sends or downloads. The link carries a random token; the PC asks before each
  browser joins and both screens show a 4-digit code; a browser's session works only from the address that was allowed;
  sharing ends when stopped or after 30 minutes without activity. Its pages can't reach the phone API.
- **Updates.** Every release's `SHA256SUMS` is signed with an offline release key that GitHub never sees; the PC and the
  phone install nothing that signed list doesn't vouch for, so a hijacked GitHub account can't ship an update. The
  phone app is signed only with Flick's own key (Android 9 and newer), which Android checks too. CI pins every
  downloaded tool by checksum and the checkout action by commit.

## Building by hand

Both builds run on Linux.

- `./build_apk.sh <versionCode> <versionName>` builds the phone app (javac, dx or d8, aapt2, and `FlickSign.java`
  with uber-apk-signer's apksig). It needs the private signing key described in `signing/README.md`.
  `pc/phone-app/Flick.apk` isn't committed: build it, or take it from the latest release, before `./build_win.sh`.
- `./build_win.sh` builds `build/win/Flick-Setup.exe` and the update bundle (Electron for Windows, rcedit through Wine,
  NSIS, and a MinGW C compiler for the Bluetooth helper). Tool paths can be set with environment variables; the
  workflow shows how.

## Versions

See `CHANGES.md`.
