#!/bin/bash
# Puts the phone app for a release at pc/phone-app/Flick.apk. Used by .github/workflows/release.yml.
#
# usage: ci/phone_app.sh <version>
#
# If android/, phone/ and build_apk.sh are unchanged since the last release, that release's phone app is reused, so
# phones aren't asked to update for nothing. Otherwise the phone app is built as <version> and signed with Flick's
# key, which comes from $FLICK_SIGNING_KEY: the backup file Flick-signing-key.zip, base64-encoded (see
# signing/README.md). FORCE_PHONE_BUILD=1 always builds. Either way the result has to be Flick, signed with Flick's key.
#
# Needs gh (with GH_TOKEN), GITHUB_REPOSITORY, SIGNER (uber-apk-signer 1.3.0), java and node; a build also needs javac,
# zip, and Android platform 34 + build tools 34.0.0 from $ANDROID_HOME (installed with sdkmanager if missing), unless
# AJ/A2/D8 or DX point at them (see build_apk.sh).
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
V=${1:?usage: ci/phone_app.sh <version>}
REPO=${GITHUB_REPOSITORY:?}
SIGNER=${SIGNER:?path to uber-apk-signer.jar}
APK=$ROOT/pc/phone-app/Flick.apk
fail() { echo "::error title=Phone app::$*"; exit 1; }
apk_info() { node -e "const i=require(process.argv[1] + '/pc/apkinfo').apkInfo(process.argv[2]); console.log(i.package, i.code, i.name)" "$ROOT" "$1"; }

mkdir -p "$(dirname "$APK")"
rm -f "$APK"
PREV=$(gh api "repos/$REPO/releases/latest" -q .tag_name 2> /dev/null || true)
how=""

# 1. unchanged since the last release: reuse its phone app
if [ "${FORCE_PHONE_BUILD:-0}" != 1 ] && [ -n "$PREV" ] && git -C "$ROOT" diff --quiet "$PREV" HEAD -- android phone build_apk.sh 2> /dev/null; then
  ID=$(gh api "repos/$REPO/releases/tags/$PREV" -q '[.assets[] | select(.name | test("^Flick-[0-9.]+\\.apk$"))][0].id // empty' 2> /dev/null || true)
  if [ -n "$ID" ] && gh api -H "Accept: application/octet-stream" "repos/$REPO/releases/assets/$ID" > "$APK" 2> /dev/null && [ -s "$APK" ]; then
    how="unchanged since $PREV, reused"
  else
    echo "couldn't fetch the phone app of $PREV: building it instead"
    rm -f "$APK"
  fi
fi

# 2. changed (or forced): build it as this version and sign it with the key from the secret
if [ -z "$how" ]; then
  [ -n "${FLICK_SIGNING_KEY:-}" ] || fail "The phone app has to be signed, but the FLICK_SIGNING_KEY secret isn't set. See signing/README.md."
  IFS=. read -r MA MI PA MORE <<< "$V"
  [[ "$MA" =~ ^[0-9]+$ && "$MI" =~ ^[0-9]+$ && "$PA" =~ ^[0-9]+$ && -z "$MORE" ]] && [ $((10#$MI)) -lt 100 ] && [ $((10#$PA)) -lt 100 ] \
    || fail "version $V must look like 1.2.3, with minor and patch under 100"
  CODE=$((10#$MA * 10000 + 10#$MI * 100 + 10#$PA))

  K=$(mktemp -d)
  trap 'rm -rf "$K"' EXIT
  { printf '%s' "$FLICK_SIGNING_KEY" | tr -d ' \t\r\n' | base64 -d > "$K/key.zip" && unzip -q -o "$K/key.zip" -d "$K"; } 2> /dev/null \
    || fail "FLICK_SIGNING_KEY isn't Flick-signing-key.zip in base64. See signing/README.md."
  # the backup zip keeps the password in its README.txt; a password.txt works too
  [ -s "$K/password.txt" ] || sed -n 's/^[[:space:]]*Password:[[:space:]]*//p' "$K/README.txt" 2> /dev/null | head -1 | tr -d '\r\n' > "$K/password.txt"
  [ -s "$K/flick-release.p12" ] && [ -s "$K/flick.lineage" ] && [ -s "$K/password.txt" ] \
    || fail "FLICK_SIGNING_KEY is missing flick-release.p12, flick.lineage or the password. See signing/README.md."
  [ "${GITHUB_ACTIONS:-}" = true ] && echo "::add-mask::$(cat "$K/password.txt")"
  mkdir -p "$K/olddebug"
  unzip -p "$SIGNER" debug.keystore > "$K/olddebug/debug.keystore"

  if [ -z "${AJ:-}" ] && [ -n "${ANDROID_HOME:-}" ]; then
    if [ ! -f "$ANDROID_HOME/platforms/android-34/android.jar" ] || [ ! -x "$ANDROID_HOME/build-tools/34.0.0/d8" ]; then
      { yes || true; } | "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" --install "platforms;android-34" "build-tools;34.0.0" > /dev/null
    fi
    export AJ="$ANDROID_HOME/platforms/android-34/android.jar" A2="$ANDROID_HOME/build-tools/34.0.0/aapt2" D8="$ANDROID_HOME/build-tools/34.0.0/d8"
  fi

  if [ "${FORCE_PHONE_BUILD:-0}" = 1 ]; then echo "building the phone app as $V ($CODE)"
  else echo "the phone app changed since ${PREV:-the first release}: building it as $V ($CODE)"; fi
  FLICK_KEYS="$K" SIGNER="$SIGNER" "$ROOT/build_apk.sh" "$CODE" "$V"
  how="built and signed"
fi

# 3. whatever ships must be Flick, signed with Flick's key
read -r PKG GOT_CODE NAME <<< "$(apk_info "$APK")"
[ "$PKG" = com.flick.app ] || fail "pc/phone-app/Flick.apk is $PKG, not com.flick.app"
if [ "$how" = "built and signed" ] && { [ "$GOT_CODE" != "$CODE" ] || [ "$NAME" != "$V" ]; }; then
  fail "built $NAME ($GOT_CODE), expected $V ($CODE)"
fi
"$ROOT/signing/verify_apk.sh" "$APK" "$SIGNER" || fail "pc/phone-app/Flick.apk isn't signed with Flick's key"
echo "::notice title=Phone app::Flick $NAME ($GOT_CODE), $how; signed with Flick's key; sha256 $(sha256sum "$APK" | cut -c1-16)"
