#!/bin/bash
# Builds Flick.apk without Gradle: javac -> d8 (or dx) -> aapt2 -> the code added to its zip -> zipalign+sign
# (signing/FlickSign.java)
# usage: ./build_apk.sh <versionCode> <versionName>   (versionCode = 100000 + major*10000 + minor*100 + patch)
#
# FLICK_VARIANT=play builds the Google Play version instead: the same code under its own package name (com.flick.app is
# taken on Play), without the permission to install apps (Play updates it; Store.java tells the app which one it is).
# It makes build/Flick-play.aab, the app bundle Play takes, signed with Flick's key as the upload key (Play signs what
# it hands out with its own key), and build/Flick-play.apk, signed with Flick's key, to try it on a phone first.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")" && pwd)
AND=$ROOT/android
OUT=$ROOT/build/android
VARIANT=${FLICK_VARIANT:-github}
PLAY_PKG=io.github.maniw1234.flick
TARGET_SDK=36
# tool locations: the Android SDK ($ANDROID_HOME: platform 36, build-tools 36.0.0), uber-apk-signer 1.3.0 in
# $FLICK_TOOLS, and for the Play version bundletool ($BUNDLETOOL); each can also be set on its own with the variable
# named here
SDK=${ANDROID_HOME:-$HOME/Android/Sdk}
TOOLS=${FLICK_TOOLS:-$HOME/flick-tools}
AJ=${AJ:-$SDK/platforms/android-$TARGET_SDK/android.jar}
A2=${A2:-$SDK/build-tools/36.0.0/aapt2}
D8=${D8:-$([ -x "$SDK/build-tools/36.0.0/d8" ] && echo "$SDK/build-tools/36.0.0/d8" || true)}   # or the dx jar (DX)
DX=${DX:-}
SIGNER=${SIGNER:-$TOOLS/uber-apk-signer.jar}
BUNDLETOOL=${BUNDLETOOL:-$TOOLS/bundletool-all-1.18.3.jar}
PY=${PYTHON:-$(command -v python3 || command -v python)}
VERSION_CODE=${1:-1}
VERSION_NAME=${2:-1.0.0}
case "$VARIANT" in github|play) ;; *) echo "FLICK_VARIANT is github or play" >&2; exit 1 ;; esac

rm -rf "$OUT"; mkdir -p "$OUT/classes" "$OUT/assets/www"
cp -r "$ROOT"/phone/* "$OUT/assets/www/"

# the files as one argument each, so a checkout whose path has spaces in it builds too (bash 3 has no mapfile)
files() { FILES=(); while IFS= read -r f; do FILES+=("$f"); done < <(find "$1" -name "$2" | sort); }
# adds files to a zip, each at the path it has under the folder given (Python's zipfile: no zip program is needed)
addzip() {
  local zipf=$1 dir=$2; shift 2
  "$PY" - "$zipf" "$dir" "$@" << 'EOF'
import sys, zipfile, os
z, d = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(z, 'a', zipfile.ZIP_DEFLATED) as f:
    for n in sys.argv[3:]:
        f.write(os.path.join(d, n), n)
EOF
}

# the manifest: the Play version's names its providers after its own package (an authority is one app's) and has no
# REQUEST_INSTALL_PACKAGES (Play doesn't allow it in an app that isn't an app store)
MANIFEST=$AND/AndroidManifest.xml
if [ "$VARIANT" = play ]; then
  MANIFEST=$OUT/AndroidManifest.xml
  sed -e '/update itself over Wi-Fi from the PC/d' -e '/REQUEST_INSTALL_PACKAGES/d' \
      -e "s/android:authorities=\"com\.flick\.app\./android:authorities=\"$PLAY_PKG./" "$AND/AndroidManifest.xml" > "$MANIFEST"
  ! grep -q 'REQUEST_INSTALL_PACKAGES\|authorities="com\.flick' "$MANIFEST" || { echo "play manifest still has GitHub's parts" >&2; exit 1; }
fi

echo "== javac"
# javac still writes the classes that compiled when another one has an error: its exit status is what says it failed
# (an APK without that class would crash wherever it's used)
files "$AND/src" '*.java'
javac -encoding UTF-8 -source 8 -target 8 -bootclasspath "$AJ" -Xlint:-options -Xlint:deprecation -d "$OUT/classes" "${FILES[@]}" 2>&1 | { grep -v "JAVA_TOOL_OPTIONS" || true; }
test -f "$OUT/classes/com/flick/app/MainActivity.class"

echo "== dex"
if [ -n "$D8" ]; then
  files "$OUT/classes" '*.class'
  "$D8" --release --min-api 28 --lib "$AJ" --output "$OUT" "${FILES[@]}"
else
  java -cp "$DX" com.android.dx.command.Main --dex --min-sdk-version=28 --output="$OUT/classes.dex" "$OUT/classes" 2>&1 | { grep -v "JAVA_TOOL_OPTIONS" || true; }
fi
test -f "$OUT/classes.dex"

echo "== aapt2"
# (the Play version: the package renamed, the code's classes still com.flick.app's)
RENAME=(); [ "$VARIANT" = play ] && RENAME=(--rename-manifest-package "$PLAY_PKG")
"$A2" compile --dir "$AND/res" -o "$OUT/res.zip"
LINK=(-I "$AJ" --manifest "$MANIFEST" ${RENAME[@]+"${RENAME[@]}"} --min-sdk-version 28 --target-sdk-version "$TARGET_SDK"
  --version-code "$VERSION_CODE" --version-name "$VERSION_NAME" -A "$OUT/assets")
"$A2" link -o "$OUT/base.apk" "${LINK[@]}" "$OUT/res.zip"
addzip "$OUT/base.apk" "$OUT" classes.dex

echo "== sign"
# Flick's private key (kept outside the project), APK Signature Scheme v3 only (Android 9+), with its rotation record
# (flick.lineage) so Android refuses any "update" signed only with the public debug key it replaced. FlickSign also
# zip-aligns; SIGNER is only its classpath (apksig). The key files are in $FLICK_KEYS (see signing/README.md).
KEYS=${FLICK_KEYS:-$HOME/flick-keys}
if [ "$VARIANT" = github ]; then
  java -cp "$SIGNER" "$ROOT/signing/FlickSign.java" "$KEYS" "$OUT/base.apk" "$OUT/Flick.apk" 2>&1 | { grep -v "JAVA_TOOL_OPTIONS" || true; }
  cp "$OUT/Flick.apk" "$ROOT/build/Flick.apk"
  # the signed phone app ships inside the PC app (pc/phone-app, not committed): build_win.sh, build_mac.sh and
  # build_linux.sh put it in; for a release, ci/phone_app.sh builds it or reuses the last release's
  mkdir -p "$ROOT/pc/phone-app" && cp "$ROOT/build/Flick.apk" "$ROOT/pc/phone-app/Flick.apk"
  ls -la "$ROOT/build/Flick.apk"
  exit 0
fi

# ---- the Play version: an APK to try, then the bundle
java -cp "$SIGNER" "$ROOT/signing/FlickSign.java" "$KEYS" "$OUT/base.apk" "$OUT/Flick-play.apk" 2>&1 | { grep -v "JAVA_TOOL_OPTIONS" || true; }
cp "$OUT/Flick-play.apk" "$ROOT/build/Flick-play.apk"

echo "== bundle"
# bundletool takes a module zip: the manifest under manifest/, the code under dex/, and resources.pb, res/ and
# assets/ as aapt2 makes them in its protocol-buffer form
"$A2" link --proto-format -o "$OUT/proto.apk" "${LINK[@]}" "$OUT/res.zip"
"$PY" - "$OUT/proto.apk" "$OUT/classes.dex" "$OUT/base.zip" << 'EOF'
import sys, zipfile
src, dex, out = sys.argv[1:4]
with zipfile.ZipFile(src) as i, zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as o:
    for e in i.infolist():
        n = e.filename
        o.writestr('manifest/AndroidManifest.xml' if n == 'AndroidManifest.xml' else n, i.read(n))
    o.write(dex, 'dex/classes.dex')
EOF
rm -f "$OUT/Flick-play.aab"
java -jar "$BUNDLETOOL" build-bundle --modules="$OUT/base.zip" --output="$OUT/Flick-play.aab" 2>&1 | { grep -v "JAVA_TOOL_OPTIONS" || true; }
# signed with Flick's key as the upload key (jarsigner: what Play wants on a bundle)
jarsigner -keystore "$KEYS/flick-release.p12" -storetype PKCS12 -storepass:file "$KEYS/password.txt" \
  -sigalg SHA256withRSA -digestalg SHA-256 "$OUT/Flick-play.aab" flick 2>&1 | { grep -v "JAVA_TOOL_OPTIONS" || true; }
# (jarsigner -verify ends well for a bundle with no signature at all, and -strict ends badly for a key that vouches for
# itself, as Flick's does: what it says is what tells)
SAID=$(jarsigner -J-Duser.language=en -verify "$OUT/Flick-play.aab" 2>&1 || true)
case "$SAID" in *"jar verified"*) ;; *) echo "the Google Play bundle isn't signed: $SAID" >&2; exit 1 ;; esac
cp "$OUT/Flick-play.aab" "$ROOT/build/Flick-play.aab"
ls -la "$ROOT/build/Flick-play.apk" "$ROOT/build/Flick-play.aab"
