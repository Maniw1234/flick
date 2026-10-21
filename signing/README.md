# Signing the phone app

Android only installs an update if it is signed with the same key as the installed app, so this key is what stops
anyone else from passing off a fake Flick update (for example over the Wi-Fi updater).

- Flick up to 1.3 was signed with the public debug key built into uber-apk-signer (CN=Android Debug, SHA-256 1E:08:A9:03…59:53).
  Anyone can sign with that key, so it can't protect updates.
- From 1.4.0, Flick is signed with a private RSA-4096 key (CN=Flick, SHA-256 49:DE:70:47…FD:2A) and an APK Signature
  Scheme v3 rotation lineage (old public key → new private key). On Android 13+ the phone then trusts only the new key.
  1.4.0 installs over 1.3 as a normal update, and no app data is lost.

The private key is NOT in this repository, and not in GitHub's secrets either. It lives in `Flick-signing-key.zip`
(keep it private and backed up). Because of that, GitHub can't sign the phone app: it is built and signed by hand
with `build_apk.sh`, which writes the signed `pc/phone-app/Flick.apk` that is committed and shipped inside the PC app.
So even someone who took over the GitHub account couldn't make a phone update your phone would accept.
`build_apk.sh` looks for these files in `$FLICK_KEYS` (default `/home/claude/tools/keys`):

    flick-release.p12          private key (alias "flick")
    password.txt               its password
    flick.lineage              the rotation proof (old → new)
    olddebug/debug.keystore    the old public key: `unzip uber-apk-signer.jar debug.keystore` (password "android")

`FlickLineage.java` recreates the lineage from the two keys. `FlickVerify.java` prints how an APK is signed. Run both with
`uber-apk-signer.jar` on the classpath.
