#!/bin/bash
# Packages the Flick Windows app (Electron) and builds Flick-Setup.exe with NSIS.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")" && pwd)
PC=$ROOT/pc
OUT=$ROOT/build/win
APP=$OUT/Flick
# tool locations: Electron's Windows zip and rcedit in $FLICK_TOOLS, Wine, NSIS and a MinGW compiler on the PATH; each
# can also be set on its own with the variable named here (the GitHub workflow does)
TOOLS=${FLICK_TOOLS:-$HOME/flick-tools}
EZIP=${EZIP:-$TOOLS/electron-win32-x64.zip}
WINE=${WINE:-$(command -v wine64 || command -v wine || echo wine)}
RCEDIT=${RCEDIT:-$TOOLS/rcedit-x64.exe}
NSISDIR=${NSISDIR:-/usr/share/nsis}
MAKENSIS=${MAKENSIS:-makensis}
export WINEPREFIX=${WINEPREFIX:-$HOME/.wine-flick}
MINGW_CC=${MINGW_CC:-x86_64-w64-mingw32-gcc}
VERSION=$(node -p "require('$PC/package.json').version")
ELECTRON=$(unzip -p "$EZIP" version)

rm -rf "$OUT"; mkdir -p "$APP"
echo "== unpack electron"
unzip -q "$EZIP" -d "$APP"
mv "$APP/electron.exe" "$APP/Flick.exe"
rm -f "$APP/resources/default_app.asar"
# keep a few UI locales (Chromium falls back to en-US)
( cd "$APP/locales" && for f in *.pak; do case "$f" in en-US.pak|en-GB.pak|he.pak|es.pak|es-419.pak|fr.pak|de.pak|ru.pak|pt-BR.pak|ar.pak|zh-CN.pak) ;; *) rm -f "$f";; esac; done )

echo "== copy app"
mkdir -p "$APP/resources/app"
# every module at the top of pc/ ships (a new one can't be forgotten here), plus the folders the windows load
cp "$PC"/*.js "$PC/package.json" "$APP/resources/app/"
for d in overlay panel catcher assets phone-app web; do if [ -d "$PC/$d" ]; then cp -r "$PC/$d" "$APP/resources/app/"; fi; done
# the Bluetooth bridge (a small native helper, see native/flick-bt.c)
mkdir -p "$APP/resources/app/bin"
"$MINGW_CC" -O2 -s -Wall -o "$APP/resources/app/bin/flick-bt.exe" "$ROOT/native/flick-bt.c" -lws2_32
"$MINGW_CC" -O2 -s -Wall -o "$APP/resources/app/bin/flick-keys.exe" "$ROOT/native/flick-keys.c" -luser32
# the phone app ships inside the PC app, so phones can update over Wi-Fi from here
node -e "const i=require('$PC/apkinfo').apkInfo('$APP/resources/app/phone-app/Flick.apk'); if (i.package !== 'com.flick.app') process.exit(1); console.log('phone app', i.name, '(' + i.code + ')')"
# record which Electron this code was built for (an update for another Electron needs the full installer)
node -e "const f='$APP/resources/app/package.json'; const p=require(f); p.flickElectron='$ELECTRON'; require('fs').writeFileSync(f, JSON.stringify(p, null, 2) + '\\n')"
cp "$PC/assets/icon.ico" "$APP/Flick.ico"

echo "== app bundle (what installed copies download to update themselves)"
rm -f "$OUT/flick-app-$VERSION.zip"
( cd "$APP/resources/app" && zip -qr -X "$OUT/flick-app-$VERSION.zip" . )

echo "== stamp exe (icon + version info)"
export WINEDEBUG=-all WINEDLLOVERRIDES="mscoree,mshtml="
cp "$RCEDIT" "$OUT/rcedit.exe"
( cd "$OUT" && timeout 180 xvfb-run -a "$WINE" rcedit.exe "Flick\\Flick.exe" \
    --set-icon "Flick\\Flick.ico" \
    --set-version-string "FileDescription" "Flick" \
    --set-version-string "ProductName" "Flick" \
    --set-version-string "CompanyName" "Flick" \
    --set-version-string "LegalCopyright" "Flick" \
    --set-version-string "OriginalFilename" "Flick.exe" \
    --set-version-string "InternalName" "Flick" \
    --set-file-version "$VERSION" --set-product-version "$VERSION" ) || { echo "!! rcedit failed (exe keeps Electron's icon/name)"; [ "${STRICT:-0}" = 1 ] && exit 1; }
rm -f "$OUT/rcedit.exe"

echo "== installer"
cp "$ROOT/installer/flick.nsi" "$OUT/flick.nsi"
( cd "$OUT" && NSISDIR="$NSISDIR" "$MAKENSIS" -V2 -DVERSION="$VERSION" flick.nsi )
ls -la "$OUT"/*.exe "$OUT"/*.zip
