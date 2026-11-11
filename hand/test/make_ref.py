#!/usr/bin/env python3
"""Makes the reference outputs engine_vs_ref.js compares the engine with: MediaPipe's two hand models (the .tflite files
build.sh converts) run by OpenCV's TFLite importer (cv2.dnn, OpenCV 5), every output, on the same input tensors.

usage: make_ref.py <folder with palm_detection_lite.tflite, hand_landmark_lite.tflite> <ref folder> [image ...]
Each image given becomes an input of both models (<model>-in<k>.f32: RGB, 0..1, float32, the model's own size);
without images, the inputs already in the ref folder are used. Writes <model>-in<k>-<output>.f32 next to them."""
import glob, os, sys
import cv2
import numpy as np

MODELS = {'palm_detection_lite': (192, ['Identity', 'Identity_1']),
          'hand_landmark_lite': (224, ['Identity', 'Identity_1', 'Identity_2', 'Identity_3'])}


def main(src, ref, images):
    os.makedirs(ref, exist_ok=True)
    for name, (side, outs) in MODELS.items():
        for k, img in enumerate(images):
            px = cv2.imread(img, cv2.IMREAD_COLOR)
            if px is None:
                raise SystemExit('not an image: ' + img)
            px = cv2.resize(cv2.cvtColor(px, cv2.COLOR_BGR2RGB), (side, side), interpolation=cv2.INTER_AREA)
            (px.astype(np.float32) / 255.0).tofile(os.path.join(ref, '%s-in%d.f32' % (name, k)))
        net = cv2.dnn.readNetFromTFLite(os.path.join(src, name + '.tflite'))
        for f in sorted(glob.glob(os.path.join(ref, name + '-in*.f32'))):
            if os.path.basename(f).count('-') != 1:
                continue                     # (an output, not an input)
            x = np.fromfile(f, dtype=np.float32).reshape(1, side, side, 3).transpose(0, 3, 1, 2).copy()   # OpenCV: NCHW
            for out in outs:
                net.setInput(x)
                y = np.asarray(net.forward(out), dtype=np.float32).ravel()
                y.tofile(f[:-4] + '-' + out + '.f32')
            print(os.path.basename(f), 'done')


if __name__ == '__main__':
    if len(sys.argv) < 3:
        raise SystemExit(__doc__)
    main(sys.argv[1], sys.argv[2], sys.argv[3:])
