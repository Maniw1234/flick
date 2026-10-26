# winget and Homebrew

Both install the files of a GitHub release: `Flick-Setup.exe` (winget, package `Maniw1234.Flick`) and
`Flick-mac-arm64.dmg` / `Flick-mac-x64.dmg` (Homebrew cask `flick`, from the tap `Maniw1234/homebrew-flick`). Flick then
updates itself as usual.

After each release, once it is signed (`signing/sign_release.js`), fill in the version and checksums:

    node packaging/update.js <version>

It checks the release's `SHA256SUMS` against Flick's release key and writes
`winget/manifests/m/Maniw1234/Flick/<version>/` and the version and checksums in `homebrew/flick.rb` (a release
without Mac disk images leaves the cask as it is). Nothing is submitted: that is up to you, below.

## One-time steps

**Homebrew (Mac).**

1. On GitHub, create a public repository named `homebrew-flick` (it must start with `homebrew-`).
2. Put `packaging/homebrew/flick.rb` in it as `Casks/flick.rb`, once `update.js` has filled it in for a release that
   has Mac disk images, and push.
3. From then on: `brew install --cask maniw1234/flick/flick`. For each new release, run `update.js` and push the new
   `flick.rb` to the tap.

**winget (Windows).**

1. Check `License:` in `Maniw1234.Flick.locale.en-US.yaml` against the repository's license.
2. Fork [microsoft/winget-pkgs](https://github.com/microsoft/winget-pkgs), copy the version folder from
   `packaging/winget/manifests/` to the same path in the fork (`manifests/m/Maniw1234/Flick/<version>/`) and open a pull
   request. Optional first, on a Windows PC: `winget validate <folder>`, and `winget install --manifest <folder>`
   (after `winget settings --enable LocalManifestFiles` as administrator).
3. Microsoft's checks and a reviewer approve it; then `winget install Maniw1234.Flick` works. Each new version is a new
   pull request with its own folder (`wingetcreate update Maniw1234.Flick` can do it too).

winget reads Flick's version from Apps & Features, which only the installer writes. A copy that updated itself still
shows the version it was installed with, so `winget upgrade` may offer the newest installer again; installing it is
harmless.
