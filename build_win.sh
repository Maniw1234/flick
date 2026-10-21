#!/bin/bash
# Packages the Flick Windows app (Electron) and builds Flick-Setup.exe with NSIS.
set -euo pipefail
ROOT=/home/claude/flick
PC=$ROOT/pc
OUT=$ROOT/build/win
APP=$OUT/Flick
EZIP=/home/claude/tools/electron/electron-win32-x64.zip
WINE=/home/claude/tools/wine/wine-11.0-amd64-wow64/bin/wine
RCEDIT=/home/claude/tools/rcedit/rcedit-x64.exe
NSISDIR=/home/claude/tools/nsis/nsis
VERSION=$(node -p "require('$PC/package.json').version")

rm -rf "$OUT"; mkdir -p "$APP"
echo "== unpack electron"
unzip -q "$EZIP" -d "$APP"
mv "$APP/electron.exe" "$APP/Flick.exe"
rm -f "$APP/resources/default_app.asar"
# keep a few UI locales (Chromium falls back to en-US)
( cd "$APP/locales" && for f in *.pak; do case "$f" in en-US.pak|en-GB.pak|he.pak|es.pak|es-419.pak|fr.pak|de.pak|ru.pak|pt-BR.pak|ar.pak|zh-CN.pak) ;; *) rm -f "$f";; esac; done )

echo "== copy app"
mkdir -p "$APP/resources/app/phone-app"
cp -r "$PC"/{main.js,server.js,ws.js,bundle.js,apkinfo.js,preload.js,package.json,overlay,panel,catcher,assets} "$APP/resources/app/"
# the phone app ships inside the PC app, so phones can update over Wi-Fi from here
APK_VER=$(node -e "console.log(require('$PC/apkinfo').apkInfo('$ROOT/build/Flick.apk').name)")
[ "$APK_VER" = "$VERSION" ] || { echo "!! build/Flick.apk is $APK_VER but the PC app is $VERSION: build the APK first"; exit 1; }
cp "$ROOT/build/Flick.apk" "$APP/resources/app/phone-app/Flick.apk"
cp "$PC/assets/icon.ico" "$APP/Flick.ico"

echo "== stamp exe (icon + version info)"
export WINEPREFIX=/home/claude/tools/wine/prefix WINEDEBUG=-all WINEDLLOVERRIDES="mscoree,mshtml="
cp "$RCEDIT" "$OUT/rcedit.exe"
( cd "$OUT" && timeout 180 xvfb-run -a "$WINE" rcedit.exe "Flick\\Flick.exe" \
    --set-icon "Flick\\Flick.ico" \
    --set-version-string "FileDescription" "Flick" \
    --set-version-string "ProductName" "Flick" \
    --set-version-string "CompanyName" "Flick" \
    --set-version-string "LegalCopyright" "Flick" \
    --set-version-string "OriginalFilename" "Flick.exe" \
    --set-version-string "InternalName" "Flick" \
    --set-file-version "$VERSION" --set-product-version "$VERSION" ) || echo "!! rcedit failed (exe keeps Electron's icon/name)"
rm -f "$OUT/rcedit.exe"

echo "== installer"
cp "$ROOT/installer/flick.nsi" "$OUT/flick.nsi"
( cd "$OUT" && NSISDIR="$NSISDIR" "$NSISDIR/linux/makensis" -V2 -DVERSION="$VERSION" -DRESDIR=/home/claude/tools/nsis/res flick.nsi )
ls -la "$OUT"/*.exe
