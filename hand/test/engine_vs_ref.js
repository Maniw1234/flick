// Compares the engine's outputs with reference outputs (OpenCV's TFLite importer) for the same input tensors.
// usage: node engine_vs_ref.js <ref folder> [simd 1|0]
const fs = require('fs'), path = require('path');
const H = require('../../phone/hand/hand.js');
const ref = process.argv[2];
const simd = process.argv[3] !== '0';
const fetch = async (u) => { const b = fs.readFileSync(path.join(__dirname, '../../phone/hand', path.basename(u))); return b.buffer.slice(b.byteOffset, b.byteOffset + b.length); };
(async () => {
  const hands = await H.load({ fetch, simd });
  const cases = [['palm', 'palm_detection_lite', 'Identity'], ['landmark', 'hand_landmark_lite', 'Identity_3']];
  for (const [key, name, out] of cases) {
    const m = hands.models[key];
    for (const k of [0, 1]) {
      const x = new Float32Array(fs.readFileSync(path.join(ref, `${name}-in${k}.f32`)).buffer.slice(0));
      const want = new Float32Array(fs.readFileSync(path.join(ref, `${name}-in${k}-${out}.f32`)).buffer.slice(0));
      m.e.f32(m.inPtr, x.length).set(x);
      const t0 = process.hrtime.bigint();
      m.run();
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      const got = m.out(out);
      let maxd = 0, maxv = 0;
      for (let i = 0; i < want.length; i++) { maxd = Math.max(maxd, Math.abs(got[i] - want[i])); maxv = Math.max(maxv, Math.abs(want[i])); }
      console.log(`${key} in${k} ${out}: max |diff| ${maxd.toExponential(2)} (max |value| ${maxv.toFixed(3)}), ${ms.toFixed(1)} ms, simd ${simd}`);
    }
  }
})().catch((e) => { console.error(e); process.exit(1); });
