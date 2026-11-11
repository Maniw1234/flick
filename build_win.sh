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
# Electron's zip must be the one pc/package.json pins for this system (CI checks every download the same way): any
# other zip, or another version, stops the build instead of being packaged without a word. Prints its version.
pinned() {  # <Electron zip> <the key of its SHA-256 in pc/package.json>
  node -e '
    const [pkg, zip, key, v] = process.argv.slice(1);
    const p = require(pkg);
    let got;
    try { got = require("crypto").createHash("sha256").update(require("fs").readFileSync(zip)).digest("hex"); } catch (e) { got = "unreadable (" + e.code + ")"; }
    if (got !== p[key]) { console.error("!! " + zip + " is not the Electron zip pc/package.json pins (" + key + " " + p[key] + "): its SHA-256 is " + got); process.exit(1); }
    if (v !== p.electronVersion) { console.error("!! " + zip + " is Electron " + v + ", but pc/package.json says electronVersion " + p.electronVersion); process.exit(1); }
    console.log(v);' "$PC/package.json" "$1" "$2" "$(unzip -p "$1" version 2> /dev/null)"
}
ELECTRON=$(pinned "$EZIP" electronSha256)

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
# (signing/sign_release.js checks the update bundles against the same list: keep the two in step)
cp "$PC"/*.js "$PC/package.json" "$APP/resources/app/"
for d in overlay panel catcher assets phone-app web air; do if [ -d "$PC/$d" ]; then cp -r "$PC/$d" "$APP/resources/app/"; fi; done
# Air grab's hand tracker (the phone app's): this PC's camera sees where the hand opens (pc/air.js)
cp -r "$ROOT/phone/hand" "$APP/resources/app/hand"
# the Bluetooth bridge (a small native helper, see native/flick-bt.c). No time stamp in the programs: built again from
# the same native/ with the same compiler they come out the same byte for byte, so the SHA-256s vouched for in
# signing/helpers.sha256 still hold (signing/sign_release.js signs only helpers listed there)
mkdir -p "$APP/resources/app/bin"
"$MINGW_CC" -O2 -s -Wall -Wl,--no-insert-timestamp -o "$APP/resources/app/bin/flick-bt.exe" "$ROOT/native/flick-bt.c" -lws2_32
"$MINGW_CC" -O2 -s -Wall -Wl,--no-insert-timestamp -o "$APP/resources/app/bin/flick-keys.exe" "$ROOT/native/flick-keys.c" -luser32
# marks a file sparse before it's written in parts (see native/flick-sparse.c and pc/server.js)
"$MINGW_CC" -O2 -s -Wall -Wl,--no-insert-timestamp -municode -o "$APP/resources/app/bin/flick-sparse.exe" "$ROOT/native/flick-sparse.c"
# the phone app ships inside the PC app, so phones can update over Wi-Fi from here
node -e "const i=require('$PC/apkinfo').apkInfo('$APP/resources/app/phone-app/Flick.apk'); if (i.package !== 'com.flick.app') process.exit(1); console.log('phone app', i.name, '(' + i.code + ')')"
# record which Electron this code was built for (an update for another Electron needs the full installer)
node -e "const f='$APP/resources/app/package.json'; const p=require(f); p.flickElectron='$ELECTRON'; require('fs').writeFileSync(f, JSON.stringify(p, null, 2) + '\\n')"
cp "$PC/assets/icon.ico" "$APP/Flick.ico"

echo "== app bundle (what installed copies download to update themselves)"
# its files stored as they are (-0), not compressed: a downloaded version is compared with this bundle at every start
# (pc/updatecore.js, checkUpdate), and with compressed files that start first waited for all of them to be unpacked.
# The download is a little bigger. Every Flick since 1.0.0 unpacks both kinds.
rm -f "$OUT/flick-app-$VERSION.zip"
( cd "$APP/resources/app" && zip -qr -X -0 "$OUT/flick-app-$VERSION.zip" . )

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

echo "== fuses"
# no running other code as Flick through Electron (ELECTRON_RUN_AS_NODE, NODE_OPTIONS, --inspect): packaging/fuses.js
# (after rcedit, which writes the program anew)
node "$ROOT/packaging/fuses.js" "$APP/Flick.exe"

echo "== installer"
cp "$ROOT/installer/flick.nsi" "$ROOT/installer/folder-check.ps1" "$OUT/"
( cd "$OUT" && NSISDIR="$NSISDIR" "$MAKENSIS" -V2 -DVERSION="$VERSION" flick.nsi )
ls -la "$OUT"/*.exe "$OUT"/*.zip
