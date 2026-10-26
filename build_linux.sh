#!/bin/bash
# Packages the Flick Linux app (Electron, x86-64): Flick-linux-x86_64.AppImage, Flick-linux-x64.tar.gz and the update
# bundle.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")" && pwd)
PC=$ROOT/pc
OUT=$ROOT/build/linux
APP=$OUT/Flick
# tool locations: Electron's Linux zip, appimagetool and the AppImage runtime in $FLICK_TOOLS; each can also be set on
# its own with the variable named here (the GitHub workflow does)
TOOLS=${FLICK_TOOLS:-$HOME/flick-tools}
EZIP=${EZIP:-$TOOLS/electron-linux-x64.zip}
APPIMAGETOOL=${APPIMAGETOOL:-$TOOLS/appimagetool-x86_64.AppImage}
RUNTIME=${RUNTIME:-$TOOLS/runtime-x86_64}
VERSION=$(node -p "require('$PC/package.json').version")
ELECTRON=$(unzip -p "$EZIP" version)

rm -rf "$OUT"; mkdir -p "$APP"
echo "== unpack electron"
unzip -q "$EZIP" -d "$APP"
# Electron's program becomes flick-bin; "flick" is the launcher that starts it (installer/flick-launcher.sh)
mv "$APP/electron" "$APP/flick-bin"
rm -f "$APP/resources/default_app.asar"
# keep a few UI locales (Chromium falls back to en-US)
( cd "$APP/locales" && for f in *.pak; do case "$f" in en-US.pak|en-GB.pak|he.pak|es.pak|es-419.pak|fr.pak|de.pak|ru.pak|pt-BR.pak|ar.pak|zh-CN.pak) ;; *) rm -f "$f";; esac; done )

echo "== copy app"
mkdir -p "$APP/resources/app"
# every module at the top of pc/ ships (a new one can't be forgotten here), plus the folders the windows load
cp "$PC"/*.js "$PC/package.json" "$APP/resources/app/"
for d in overlay panel catcher assets phone-app web; do if [ -d "$PC/$d" ]; then cp -r "$PC/$d" "$APP/resources/app/"; fi; done
# the phone app ships inside the PC app, so phones can update over Wi-Fi from here
node -e "const i=require('$PC/apkinfo').apkInfo('$APP/resources/app/phone-app/Flick.apk'); if (i.package !== 'com.flick.app') process.exit(1); console.log('phone app', i.name, '(' + i.code + ')')"
# record which Electron this code was built for (an update for another Electron needs the full download)
node -e "const f='$APP/resources/app/package.json'; const p=require(f); p.flickElectron='$ELECTRON'; require('fs').writeFileSync(f, JSON.stringify(p, null, 2) + '\\n')"
install -m 755 "$ROOT/installer/flick-launcher.sh" "$APP/flick"
cp "$PC/assets/icon.png" "$APP/flick.png"

echo "== app bundle (what installed copies download to update themselves)"
( cd "$APP/resources/app" && zip -qr -X "$OUT/flick-app-linux-$VERSION.zip" . )

echo "== Flick-linux-x64.tar.gz"
tar -C "$OUT" --owner=0 --group=0 --numeric-owner -czf "$OUT/Flick-linux-x64.tar.gz" Flick

echo "== Flick-linux-x86_64.AppImage"
AD=$OUT/Flick.AppDir
cp -a "$APP" "$AD"
cp "$AD/flick" "$AD/AppRun"
ln -s flick.png "$AD/.DirIcon"
cat > "$AD/flick.desktop" <<'DESKTOP'
[Desktop Entry]
Type=Application
Name=Flick
GenericName=File transfer
Comment=Send files between your Android phone and this computer
Exec=flick %F
Icon=flick
Terminal=false
Categories=Network;FileTransfer;
StartupWMClass=Flick
DESKTOP
# appimagetool is itself an AppImage: unpacked to run (build machines may have no FUSE); the runtime it puts in front of
# the image is the pinned one, never one it would fetch
install -m 755 "$APPIMAGETOOL" "$OUT/appimagetool"
( cd "$OUT" && ARCH=x86_64 APPIMAGE_EXTRACT_AND_RUN=1 ./appimagetool --no-appstream --runtime-file "$RUNTIME" Flick.AppDir Flick-linux-x86_64.AppImage )
rm -rf "$OUT/appimagetool" "$AD" "$OUT/squashfs-root"
ls -la "$OUT"/*.AppImage "$OUT"/*.tar.gz "$OUT"/*.zip
