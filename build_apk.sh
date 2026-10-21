#!/bin/bash
# Builds Flick.apk without Gradle: javac -> dx/d8 -> aapt2 -> zip -> zipalign+sign (uber-apk-signer)
# usage: ./build_apk.sh <versionCode> <versionName>   (versionCode = major*10000 + minor*100 + patch)
set -euo pipefail
ROOT=$(cd "$(dirname "$0")" && pwd)
AND=$ROOT/android
OUT=$ROOT/build/android
# tool locations (override with environment variables on another machine)
AJ=${AJ:-/home/claude/tools/aplat/repo/android-34/android.jar}
A2=${A2:-/home/claude/tools/aapt2/aapt2}
D8=${D8:-}                                     # Android build-tools d8, if available; otherwise the old dx jar
DX=${DX:-$(ls /home/claude/tools/dex2jar/x/*/lib/dx-30.0.2.jar 2>/dev/null || true)}
SIGNER=${SIGNER:-/home/claude/tools/signer/uber-apk-signer.jar}
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
  --min-sdk-version 24 --target-sdk-version 34 --version-code "$VERSION_CODE" --version-name "$VERSION_NAME" \
  -A "$OUT/assets" "$OUT/res.zip"
(cd "$OUT" && zip -q -j base.apk classes.dex)

echo "== sign"
# Flick's private release key (kept outside the project). Builds up to 1.3 used the public debug key that ships inside
# uber-apk-signer; the v3 lineage proves that key handed over to the private one, so phones update in place and
# Android refuses any "update" signed only with the old, public key.
KEYS=${FLICK_KEYS:-/home/claude/tools/keys}
PW=$(cat "$KEYS/password.txt")
java -jar "$SIGNER" -a "$OUT/base.apk" -o "$OUT/signed" --allowResign \
  --ks 1="$KEYS/olddebug/debug.keystore" 2="$KEYS/flick-release.p12" --ksAlias 1=androiddebugkey 2=flick \
  --ksPass 1=android 2="$PW" --ksKeyPass 1=android 2="$PW" -l "$KEYS/flick.lineage" \
  2>&1 | grep -v "JAVA_TOOL_OPTIONS" | grep -E "verified|Successfully|ERROR|error" || true
cp "$OUT"/signed/*.apk "$ROOT/build/Flick.apk"
# the signed phone app ships inside the PC app (pc/phone-app); it is committed, because the signing key never
# leaves this machine (GitHub builds the PC app around it, see .github/workflows/release.yml)
mkdir -p "$ROOT/pc/phone-app" && cp "$ROOT/build/Flick.apk" "$ROOT/pc/phone-app/Flick.apk"
ls -la "$ROOT/build/Flick.apk"
