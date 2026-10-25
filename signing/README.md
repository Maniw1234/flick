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
`FlickVerify.java` prints how an APK is signed; `verify_apk.sh` compares that with `expected-signature.txt` (minSdk 28
included). `FlickLineage.java` recreates the lineage from the two keys (the old one is `debug.keystore` inside
uber-apk-signer.jar, password "android"). Run them with `uber-apk-signer.jar` on the classpath, for example:

    java -cp uber-apk-signer.jar signing/FlickSign.java <keys folder> <unsigned.apk> <signed.apk>

## The release key

Whoever controls the GitHub account, or the `FLICK_SIGNING_KEY` secret, could otherwise publish an update that
installed copies take. So every release is also signed, after GitHub has published it, with a key GitHub never sees:

- `flick-update-key.pem`, an ECDSA P-256 private key. Keep it offline with a backup; never put it on GitHub. Its public
  half is built into the apps: `RELEASE_KEYS` in `pc/updatecore.js` and `KEYS` in `android/.../Updater.java`.
- The release asset `SHA256SUMS.sig` is the signature (SHA-256, DER, base64 on one line) of
  `flick-release-v1\nversion <version>\n` followed by the release's `SHA256SUMS`, byte for byte.

After each release, on the computer that has the key:

    node signing/sign_release.js <version> [--key flick-update-key.pem] [--dry-run]

It downloads the release, checks every file against `SHA256SUMS` and that `flick-app-<version>.zip` is that version,
signs, uploads `SHA256SUMS.sig` and reads it back. Where a file can't be uploaded from (a network that only lets JSON
requests through), it sends the signature as text to the "Attach release signature" workflow
(`.github/workflows/attach-signature.yml`), which checks it against the release key before attaching it; `--via-workflow`
goes that way directly. Only the signature reaches GitHub, never the key. If the release already has one, it only
checks it, and stops (deleting nothing) if it's wrong. Until a release is signed, PCs skip it quietly and phones don't
install it.

To change keys later: add the new public key to both lists and release that, then sign later releases with the new key.
