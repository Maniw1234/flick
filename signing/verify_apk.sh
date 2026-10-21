#!/bin/bash
# Checks that an APK is signed the way Flick's phone app must be (see README.md here): APK Signature Scheme v3 only,
# with Flick's private key and the rotation lineage from the old public key, and minSdk 28 (Android 9), the oldest
# Android that checks v3. expected-signature.txt holds the exact layout, minSdk included.
# usage: signing/verify_apk.sh <apk> [uber-apk-signer.jar]
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
APK=${1:?usage: signing/verify_apk.sh <apk> [uber-apk-signer.jar]}
JAR=${2:-${SIGNER:-/home/claude/tools/signer/uber-apk-signer.jar}}
got=$(java -cp "$JAR" "$HERE/FlickVerify.java" "$APK" 2>&1 | grep -v '^Picked up JAVA_TOOL_OPTIONS' | sed '1s/^[^:]*: //')
if [ "$got" != "$(cat "$HERE/expected-signature.txt")" ]; then
  echo "$APK is not signed the way signing/expected-signature.txt says:"
  echo "$got"
  exit 1
fi
echo "signature ok: Flick's key (49:DE:70:47...FD:2A), rotated from the old key (1E:08:A9:03...59:53); Android 9+ (minSdk 28)"
