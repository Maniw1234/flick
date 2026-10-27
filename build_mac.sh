#!/bin/bash
# Packages the Flick Mac app (Electron), one for Apple Silicon and one for Intel Macs, its update bundle and, on a Mac,
# a disk image of each: Flick-mac-arm64.dmg and Flick-mac-x64.dmg. Anywhere else it stops at the .app folders (no
# media-key helper, signature or disk image without a Mac's tools), which is enough to check how they're put together.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")" && pwd)
PC=$ROOT/pc
OUT=$ROOT/build/mac
# tool locations: Electron's macOS zips in $FLICK_TOOLS; each can also be set on its own with the variable named here
# (the GitHub workflow does). ARCHS picks which apps to make.
TOOLS=${FLICK_TOOLS:-$HOME/flick-tools}
EZIP_ARM64=${EZIP_ARM64:-$TOOLS/electron-darwin-arm64.zip}
EZIP_X64=${EZIP_X64:-$TOOLS/electron-darwin-x64.zip}
ARCHS=${ARCHS:-arm64 x64}
VERSION=$(node -p "require('$PC/package.json').version")
ON_MAC=0; [ "$(uname -s)" = Darwin ] && ON_MAC=1
ezip() { case "$1" in arm64) echo "$EZIP_ARM64";; x64) echo "$EZIP_X64";; *) echo "unknown architecture $1" >&2; exit 1;; esac; }
ELECTRON=""
for ARCH in $ARCHS; do
  V=$(unzip -p "$(ezip "$ARCH")" version)
  [ -z "$ELECTRON" ] && ELECTRON=$V
  [ "$V" = "$ELECTRON" ] || { echo "!! the Electron zips are different versions ($ELECTRON, $V)"; exit 1; }
done

rm -rf "$OUT"; mkdir -p "$OUT"
echo "== app code"
CODE=$OUT/app
mkdir -p "$CODE"
# every module at the top of pc/ ships (a new one can't be forgotten here), plus the folders the windows load
cp "$PC"/*.js "$PC/package.json" "$CODE/"
for d in overlay panel catcher assets phone-app web air; do if [ -d "$PC/$d" ]; then cp -R "$PC/$d" "$CODE/"; fi; done
# Air grab's hand tracker (the phone app's): this Mac's camera sees where the hand opens (pc/air.js)
cp -R "$ROOT/phone/hand" "$CODE/hand"
# the phone app ships inside the PC app, so phones can update over Wi-Fi from here
node -e "const i=require('$PC/apkinfo').apkInfo('$CODE/phone-app/Flick.apk'); if (i.package !== 'com.flick.app') process.exit(1); console.log('phone app', i.name, '(' + i.code + ')')"
# record which Electron this code was built for (an update for another Electron needs the full download)
node -e "const f='$CODE/package.json'; const p=require(f); p.flickElectron='$ELECTRON'; require('fs').writeFileSync(f, JSON.stringify(p, null, 2) + '\\n')"
# the media-key helper (native/flick-keys-mac.swift): one program for both kinds of Mac (the update bundle serves both),
# signed, since Apple Silicon runs nothing unsigned
if [ $ON_MAC = 1 ] && command -v swiftc > /dev/null; then
  mkdir -p "$CODE/bin" "$OUT/keys"
  for a in arm64 x86_64; do swiftc -O -swift-version 5 -target $a-apple-macos13 -o "$OUT/keys/flick-keys-$a" "$ROOT/native/flick-keys-mac.swift"; done
  lipo -create -output "$CODE/bin/flick-keys" "$OUT/keys/flick-keys-arm64" "$OUT/keys/flick-keys-x86_64"
  codesign --force --sign - "$CODE/bin/flick-keys"
  rm -rf "$OUT/keys"
else
  echo "!! no Swift compiler here: no media-key helper (the phone's remote then says it can't work on this Mac)"
  [ "${STRICT:-0}" = 1 ] && exit 1
fi

echo "== app bundle (what installed copies download to update themselves)"
( cd "$CODE" && zip -qr -X "$OUT/flick-app-mac-$VERSION.zip" . )

echo "== icon"
# .icns: "icns", its length, then one (type, length, PNG) entry per size; the 2x types take the next size's PNG
node - "$OUT/flick.icns" "$ROOT/art/icon-256.png" "$ROOT/art/icon-512.png" "$ROOT/art/icon-1024.png" <<'JS'
const fs = require('fs');
const [out, ...pngs] = process.argv.slice(2);
const TYPES = { 256: ['ic08', 'ic13'], 512: ['ic09', 'ic14'], 1024: ['ic10'] };
const parts = [];
for (const f of pngs) {
  const png = fs.readFileSync(f);
  if (png.readUInt32BE(0) !== 0x89504e47) throw new Error(f + ' is not a PNG');
  const w = png.readUInt32BE(16), h = png.readUInt32BE(20);
  if (w !== h || !TYPES[w]) throw new Error(f + ': no icon type for ' + w + 'x' + h);
  for (const t of TYPES[w]) { const head = Buffer.alloc(8); head.write(t, 0, 'latin1'); head.writeUInt32BE(png.length + 8, 4); parts.push(head, png); }
}
const body = Buffer.concat(parts);
const head = Buffer.alloc(8); head.write('icns', 0, 'latin1'); head.writeUInt32BE(body.length + 8, 4);
fs.writeFileSync(out, Buffer.concat([head, body]));
JS

for ARCH in $ARCHS; do
  echo "== Flick.app ($ARCH)"
  D=$OUT/$ARCH; APP=$D/Flick.app
  mkdir -p "$D/electron"
  unzip -q "$(ezip "$ARCH")" -d "$D/electron"            # keeps the frameworks' links and the programs' modes
  mv "$D/electron/Electron.app" "$APP"
  cp "$D/electron/LICENSE" "$D/electron/LICENSES.chromium.html" "$APP/Contents/Resources/"
  rm -rf "$D/electron"
  mv "$APP/Contents/MacOS/Electron" "$APP/Contents/MacOS/Flick"
  rm -f "$APP/Contents/Resources/default_app.asar" "$APP/Contents/Resources/electron.icns"
  cp -R "$CODE" "$APP/Contents/Resources/app"
  cp "$OUT/flick.icns" "$APP/Contents/Resources/flick.icns"
  python3 -I - "$APP/Contents/Info.plist" "$VERSION" <<'PY'
import plistlib, sys
path, version = sys.argv[1], sys.argv[2]
with open(path, 'rb') as f:
    p = plistlib.load(f)
p.update({
    'CFBundleDisplayName': 'Flick', 'CFBundleName': 'Flick', 'CFBundleExecutable': 'Flick',
    'CFBundleIdentifier': 'com.flick.pc', 'CFBundleIconFile': 'flick.icns',
    'CFBundleShortVersionString': version, 'CFBundleVersion': version,
    'LSApplicationCategoryType': 'public.app-category.utilities', 'NSHumanReadableCopyright': 'Flick',
    # Flick can't reach the phone without the local network: macOS asks the user once, with this line
    'NSLocalNetworkUsageDescription': 'Flick finds your phone on the local network and sends files to it and from it.',
    # every Bonjour service Flick advertises or looks for: Quick Share (pc/quickshare.js, through pc/mdns.js)
    'NSBonjourServices': ['_FC9F5ED42C8A._tcp'],
    # Air grab: after a file is grabbed on the phone, the camera looks for the hand for a few seconds (pc/air.js)
    'NSCameraUsageDescription': 'Air grab: for a few seconds after you grab a file on your phone, or select files here, Flick looks for your hand. Nothing is recorded.',
    # Air grab: which files are selected in Finder (pc/selwatch.js); macOS asks once
    'NSAppleEventsUsageDescription': 'Air grab: Flick asks Finder which files you selected, so a fist in front of the screen can pick them up.',
    # any file or folder can be dropped on Flick in the Dock or opened with it (it goes to the phone); Flick is never
    # the default app for anything
    'CFBundleDocumentTypes': [{'CFBundleTypeName': 'Any file', 'CFBundleTypeRole': 'Viewer',
                               'LSHandlerRank': 'Alternate', 'LSItemContentTypes': ['public.item']}],
})
p.pop('ElectronAsarIntegrity', None)      # it vouches for default_app.asar, which isn't there any more
with open(path, 'wb') as f:
    plistlib.dump(p, f)
PY
  if [ $ON_MAC = 1 ]; then
    # ad-hoc: Flick has no Apple Developer ID, but Apple Silicon runs nothing unsigned (README: Open Anyway)
    codesign --force --deep --sign - "$APP"
    codesign --verify --deep --strict "$APP"
    echo "== Flick-mac-$ARCH.dmg"
    S=$D/dmg; mkdir -p "$S"
    ditto "$APP" "$S/Flick.app"
    ln -s /Applications "$S/Applications"
    # hdiutil now and then finds the disk busy: try again
    for i in 1 2 3; do hdiutil create -quiet -volname Flick -srcfolder "$S" -ov -format UDZO "$OUT/Flick-mac-$ARCH.dmg" && break; [ $i = 3 ] && exit 1; sleep 5; done
    rm -rf "$S"
  fi
done
[ $ON_MAC = 1 ] || echo "!! not a Mac: the apps aren't signed and there are no disk images"
ls -la "$OUT"
