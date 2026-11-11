# Signing

Two separate keys protect Flick's updates: the phone app's signing key, which Android checks, and the release key,
which Flick itself checks on the PC and the phone.

## The phone app's signing key

Android only installs an update if it is signed with the same key as the installed app, so this key is what stops
anyone else from passing off a fake Flick update (for example over the Wi-Fi updater).

- Flick is signed with a private RSA-4096 key (CN=Flick, SHA-256 49:DE:70:47…FD:2A), APK Signature Scheme v3 only, so
  it needs Android 9 or newer. The signature carries a rotation record (`flick.lineage`) from the public debug key built
  into uber-apk-signer (CN=Android Debug, SHA-256 1E:08:A9:03…59:53), which signed early test builds: those installs
  update in place, and the record doesn't let that public key roll back, so Android accepts only Flick's key.

The private key is not in this repository. It lives in `Flick-signing-key.zip` (the backup: keep it private, it
also holds the password) and in the GitHub secret `FLICK_SIGNING_KEY` (Settings > Secrets and variables > Actions),
which is the same zip, base64-encoded. GitHub Actions signs the phone app with it when a release changes the phone app
(`ci/phone_app.sh`), and checks every phone app it ships with `signing/verify_apk.sh`.

To set the secret again from the backup on Windows, run this in PowerShell and paste the clipboard as the secret's value:

    [Convert]::ToBase64String([IO.File]::ReadAllBytes("$HOME\Downloads\Flick\Flick-signing-key.zip")) | Set-Clipboard

To build by hand, `build_apk.sh` looks for these files in `$FLICK_KEYS` (default `~/flick-keys`):

    flick-release.p12          private key (alias "flick")
    password.txt               its password
    flick.lineage              the rotation record (debug key → Flick's key)

`FlickSign.java` signs an APK this way (zip-aligning it first: apksig keeps alignment but doesn't create it).
`FlickVerify.java` prints how an APK is signed (each certificate by its whole SHA-256, and what each key in the lineage
may still do); `verify_apk.sh` compares that with `expected-signature.txt` (minSdk 28 included, and the old key unable to
roll back). `FlickLineage.java` recreates the lineage from the two keys (the old one is `debug.keystore` inside
uber-apk-signer.jar, password "android"). Run them with `uber-apk-signer.jar` on the classpath, for example:

    java -cp uber-apk-signer.jar signing/FlickSign.java <keys folder> <unsigned.apk> <signed.apk>

## The release key

Whoever controls the GitHub account, or the `FLICK_SIGNING_KEY` secret, could otherwise publish an update that
installed copies take. So every release is also signed, after GitHub has published it, with a key GitHub never sees:

- `flick-update-key.pem`, an ECDSA P-256 private key. Keep it offline with a backup; never put it on GitHub. Its public
  half is built into the apps: `RELEASE_KEYS` in `pc/updatecore.js` and `KEYS` in `android/.../Updater.java`.
- The release asset `SHA256SUMS.sig` is the signature (SHA-256, DER, base64 on one line) of
  `flick-release-v1\nversion <version>\n` followed by the release's `SHA256SUMS`, byte for byte.

After each release, on the computer that has the key, in your checkout of Flick on the commit you pushed for it:

    node signing/sign_release.js <version> [--key flick-update-key.pem] [--commit <the commit you pushed>] [--dry-run]

Installed PCs run whatever a signed release holds, so before signing it checks the release against that commit as your
checkout has it (never as GitHub describes it):

- the release's tag `v<version>` on GitHub is that commit (`--commit` names it when your checkout has moved on);
- `SHA256SUMS` lists exactly what the release workflow publishes, every file matches it, and nothing else is on the
  release, but for `Flick.apk`: the phone app once more under a name that stays the same (for a link that always gives
  the latest), which must be the listed `Flick-<its version>.apk` byte for byte;
- every file of the three update bundles (`flick-app-<version>.zip`, `flick-app-mac-<version>.zip`,
  `flick-app-linux-<version>.zip`) is the commit's, byte for byte, as the build scripts copy them; `package.json` only
  gains `flickElectron` (the commit's `electronVersion`), and besides them there is only what the build makes: the
  phone app and the native helpers (`bin/`);
- each native helper is one you have vouched for: its SHA-256 is in `signing/helpers.sha256` (below);
- the phone app (`Flick-<its version>.apk`) is signed with Flick's own key and nothing else (`FlickVerify.java` against
  `expected-signature.txt`, as `verify_apk.sh` checks it; no v1 or v2 signature beside it); its page (`assets/www`) is
  the commit's `phone/`, byte for byte, as `build_apk.sh` packs it; it was built for this release (versionName
  `<version>`, versionCode as `ci/phone_app.sh` computes it) or it is the phone app of an earlier release you signed,
  unchanged since (`android/`, `phone/` and `build_apk.sh` as at that release's commit, which `ci/phone_app.sh` reuses
  then); and every bundle carries that same file.

Anything else stops it, with what differs, and nothing is signed. What it can't check against the source stays trusted
as GitHub built it: the installers and disk images (which new installs, winget and Homebrew use), and the phone app's
compiled code and resources, which GitHub builds and signs with the `FLICK_SIGNING_KEY` secret (signing the phone app
offline with a key GitHub never sees, as the release key is, would close that: your decision).
The check is only as good as your checkout: it first prints the commit it vouches for (subject, author, date), so sign
before pulling anything you haven't read into it.
Besides `gh` it needs git, Java 11 or newer, and `uber-apk-signer.jar` 1.3.0 (the one CI uses; it checks the jar's
SHA-256) in `$FLICK_TOOLS` (default `~/flick-tools`), or named with `--signer`.

### Native helpers

The Windows and Mac bundles carry small programs GitHub compiles from `native/` (`bin/flick-bt.exe`, `flick-keys.exe`,
`flick-sparse.exe`; the Mac's `bin/flick-keys`), and every Windows PC and Mac that updates runs them, so the signature
must not vouch for ones you haven't. `signing/helpers.sha256` lists the ones you have, one line per helper and system
(`<sha256>  win32 bin/flick-bt.exe`), and `sign_release.js` reads it as your checkout has it. The first time, and
whenever `native/` or the compiler CI uses changes, it stops, names each new helper with its SHA-256 and gives the line
to add. Before adding it, check that `native/` is what you wrote (it says which `git log` to read) and, best, build the
helper yourself the way `build_win.sh` or `build_mac.sh` does and compare: the Windows ones come out the same byte for
byte with the same MinGW compiler (Ubuntu 24.04's `gcc-mingw-w64-x86-64`), since they're built without a time stamp.
Then add the line, run it again and commit the file. Built again from an unchanged `native/` with the same compiler,
a helper keeps its SHA-256, so the next releases sign without asking.

`helpers.sha256` lists none yet, so the next signing stops once and gives four lines:
the three Windows helpers and the Mac's `flick-keys`. The file is read from your checkout as it is on disk, so add the
lines, sign, and commit the file afterwards (the release's tag stays the commit you pushed). The Mac's helper can only
be built again to compare on a Mac (`swiftc`, `lipo`, `codesign`); without one, reading `native/flick-keys-mac.swift`
in that commit is what vouches for it, and an update of GitHub's Mac image (Xcode) can change its SHA-256 with no
change in `native/`.

Then it signs, uploads `SHA256SUMS.sig` and reads it back. Where a file can't be uploaded from (a network that only lets
JSON requests through), it sends the signature as text to the "Attach release signature" workflow
(`.github/workflows/attach-signature.yml`), which checks it against the release key before attaching it;
`--via-workflow` goes that way directly. Only the signature reaches GitHub, never the key. If the release already has
one, it only checks it, and stops (deleting nothing) if it's wrong. Until a release is signed, PCs skip it quietly and
phones don't install it.

To change keys later: add the new public key to both lists and release that, then sign later releases with the new key.

That happened once: the first key (1.0.0 to 2.0.0) was lost before 2.1.0 could be signed. 2.1.0 adds the second key
and is the first release signed with it. Flick 2.0.0 and older trust only the first key, so they don't take 2.1.0 or
later by themselves: those copies are updated by hand once. Keep a backup of the key (and of this lesson):
`flick-update-key.pem` in `$FLICK_KEYS`, on something that isn't this computer.
