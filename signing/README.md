# Signing the phone app

Android only installs an update if it is signed with the same key as the installed app, so this key is what stops
anyone else from passing off a fake Flick update (for example over the Wi-Fi updater).

- Flick up to 1.3 was signed with the public debug key built into uber-apk-signer (CN=Android Debug, SHA-256 1E:08:A9:03…59:53).
  Anyone can sign with that key, so it can't protect updates.
- From 1.4.0, Flick is signed with a private RSA-4096 key (CN=Flick, SHA-256 49:DE:70:47…FD:2A) and an APK Signature
  Scheme v3 rotation lineage (old public key → new private key). On Android 13+ the phone then trusts only the new key.
  1.4.0 installs over 1.3 as a normal update, and no app data is lost.

The private key is not in this repository. It lives in `Flick-signing-key.zip` (the backup: keep it private, it
also holds the password) and in the GitHub secret `FLICK_SIGNING_KEY` (Settings > Secrets and variables > Actions),
which is the same zip, base64-encoded. GitHub Actions signs the phone app with it when a release changes the phone app
(`ci/phone_app.sh`), and checks every phone app it ships with `signing/verify_apk.sh`.

To set the secret again from the backup on Windows, run this in PowerShell and paste the clipboard as the secret's value:

    [Convert]::ToBase64String([IO.File]::ReadAllBytes("$HOME\Downloads\Flick\Flick-signing-key.zip")) | Set-Clipboard

Anyone who controls the GitHub account can now ship a phone update that phones accept (as they already could for the
PC app), so keep two-factor sign-in on.

To build by hand, `build_apk.sh` looks for these files in `$FLICK_KEYS` (default `/home/claude/tools/keys`):

    flick-release.p12          private key (alias "flick")
    password.txt               its password
    flick.lineage              the rotation proof (old → new)
    olddebug/debug.keystore    the old public key: `unzip uber-apk-signer.jar debug.keystore` (password "android")

`FlickLineage.java` recreates the lineage from the two keys. `FlickVerify.java` prints how an APK is signed. Run both with
`uber-apk-signer.jar` on the classpath.
