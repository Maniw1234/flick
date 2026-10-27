#!/bin/sh
# Builds Flick's hand engine into phone/hand/ (the phone app ships phone/; the PC app copies phone/hand):
#   hand-simd.wasm, hand.wasm   engine.c with and without WebAssembly SIMD (clang 15+ with the wasm32 target, wasm-ld)
#   palm.fhm, landmark.fhm      MediaPipe's palm detection and hand landmark models (lite), converted by convert.py
#
# The models come from MediaPipe v0.8.10.2 (Apache 2.0), the last release that kept them in its repository:
#   https://github.com/google-ai-edge/mediapipe  tag v0.8.10.2
#   mediapipe/modules/palm_detection/palm_detection_lite.tflite  sha256 e9a4aaddf90dda56a87235303cf00e4c2d3fb28725f68fd88772997dac905c18
#   mediapipe/modules/hand_landmark/hand_landmark_lite.tflite    sha256 d7fde8ac11f8ce03f8663775bfc323f4fc9f2a38062b4f4efa142874ef5b2a48
# usage: hand/build.sh [<folder with the two .tflite files>]   (without it, they are fetched with git)
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
OUT="$HERE/../phone/hand"
CC=${CLANG:-clang}
mkdir -p "$OUT"

FLAGS="--target=wasm32 -O3 -nostdlib -fno-builtin -ffast-math -Wall -Wl,--no-entry -Wl,--export-dynamic -Wl,--strip-all"
"$CC" $FLAGS -msimd128 -o "$OUT/hand-simd.wasm" "$HERE/engine.c"
"$CC" $FLAGS -mno-simd128 -o "$OUT/hand.wasm" "$HERE/engine.c"

SRC="$1"
if [ -z "$SRC" ]; then
  SRC=$(mktemp -d)
  git -c gc.auto=0 clone -q --depth 1 --branch v0.8.10.2 --filter=blob:none --no-checkout https://github.com/google-ai-edge/mediapipe "$SRC/mp"
  git -C "$SRC/mp" -c gc.auto=0 checkout -q HEAD -- mediapipe/modules/palm_detection/palm_detection_lite.tflite mediapipe/modules/hand_landmark/hand_landmark_lite.tflite
  cp "$SRC/mp/mediapipe/modules/palm_detection/palm_detection_lite.tflite" "$SRC/mp/mediapipe/modules/hand_landmark/hand_landmark_lite.tflite" "$SRC/"
fi
echo "e9a4aaddf90dda56a87235303cf00e4c2d3fb28725f68fd88772997dac905c18  $SRC/palm_detection_lite.tflite" | sha256sum -c --quiet
echo "d7fde8ac11f8ce03f8663775bfc323f4fc9f2a38062b4f4efa142874ef5b2a48  $SRC/hand_landmark_lite.tflite" | sha256sum -c --quiet
python3 "$HERE/convert.py" "$SRC/palm_detection_lite.tflite" "$OUT/palm.fhm"
python3 "$HERE/convert.py" "$SRC/hand_landmark_lite.tflite" "$OUT/landmark.fhm"
ls -l "$OUT"
