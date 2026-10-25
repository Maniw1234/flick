#!/bin/bash
# Builds Flick.apk without Gradle: javac -> dx/d8 -> aapt2 -> zip -> zipalign+sign (signing/FlickSign.java)
# usage: ./build_apk.sh <versionCode> <versionName>   (versionCode = 100000 + major*10000 + minor*100 + patch)
set -euo pipefail
ROOT=$(cd "$(dirname "$0")" && pwd)
AND=$ROOT/android
OUT=$ROOT/build/android
# tool locations: the Android SDK ($ANDROID_HOME: platform 34, build-tools 34.0.0) and uber-apk-signer 1.3.0 in
# $FLICK_TOOLS; each can also be set on its own with the variable named here
SDK=${ANDROID_HOME:-$HOME/Android/Sdk}
TOOLS=${FLICK_TOOLS:-$HOME/flick-tools}
AJ=${AJ:-$SDK/platforms/android-34/android.jar}
A2=${A2:-$SDK/build-tools/34.0.0/aapt2}
D8=${D8:-$([ -x "$SDK/build-tools/34.0.0/d8" ] && echo "$SDK/build-tools/34.0.0/d8" || true)}   # or the dx jar (DX)
DX=${DX:-}
SIGNER=${SIGNER:-$TOOLS/uber-apk-signer.jar}
VERSION_CODE=${1:-1}
VERSION_NAME=${2:-1.0.0}

rm -rf "$OUT"; mkdir -p "$OUT/classes" "$OUT/assets/www"
cp -r "$ROOT"/phone/* "$OUT/assets/www/"

echo "== javac"
javac -encoding UTF-8 -source 8 -target 8 -bootclasspath "$AJ" -Xlint:-options -Xlint:deprecation -d "$OUT/classes" $(find "$AND/src" -name '*.java') 2>&1 | grep -v "JAVA_TOOL_OPTIONS" || true
test -f "$OUT/classes/com/flick/app/MainActivity.class"

echo "== dex"
if [ -n "$D8" ]; then
  "$D8" --release --min-api 24 --lib "$AJ" --output "$OUT" $(find "$OUT/classes" -name '*.class')
else
  java -cp "$DX" com.android.dx.command.Main --dex --min-sdk-version=24 --output="$OUT/classes.dex" "$OUT/classes" 2>&1 | grep -v "JAVA_TOOL_OPTIONS" || true
fi
test -f "$OUT/classes.dex"

echo "== aapt2"
"$A2" compile --dir "$AND/res" -o "$OUT/res.zip"
"$A2" link -o "$OUT/base.apk" -I "$AJ" --manifest "$AND/AndroidManifest.xml" \
  --min-sdk-version 28 --target-sdk-version 34 --version-code "$VERSION_CODE" --version-name "$VERSION_NAME" \
  -A "$OUT/assets" "$OUT/res.zip"
(cd "$OUT" && zip -q -j base.apk classes.dex)

echo "== sign"
# Flick's private key (kept outside the project), APK Signature Scheme v3 only (Android 9+), with its rotation record
# (flick.lineage) so Android refuses any "update" signed only with the public debug key it replaced. FlickSign also
# zip-aligns; SIGNER is only its classpath (apksig). The key files are in $FLICK_KEYS (see signing/README.md).
KEYS=${FLICK_KEYS:-$HOME/flick-keys}
java -cp "$SIGNER" "$ROOT/signing/FlickSign.java" "$KEYS" "$OUT/base.apk" "$OUT/Flick.apk" 2>&1 | { grep -v "JAVA_TOOL_OPTIONS" || true; }
cp "$OUT/Flick.apk" "$ROOT/build/Flick.apk"
# the signed phone app ships inside the PC app (pc/phone-app); it is committed, because the signing key never
# leaves this machine (GitHub builds the PC app around it, see .github/workflows/release.yml)
mkdir -p "$ROOT/pc/phone-app" && cp "$ROOT/build/Flick.apk" "$ROOT/pc/phone-app/Flick.apk"
ls -la "$ROOT/build/Flick.apk"
