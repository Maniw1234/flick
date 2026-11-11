// Compares the engine's outputs with reference outputs (OpenCV's TFLite importer, see make_ref.py) for the same input
// tensors: every output of both models, with SIMD or without. Fails when one is further off than a few rounding steps
// (a wrong op is off by far more). usage: node engine_vs_ref.js <ref folder> [simd 1|0]
const fs = require('fs'), path = require('path');
const H = require('../../phone/hand/hand.js');
const ref = process.argv[2];
const simd = process.argv[3] !== '0';
const fetch = async (u) => { const b = fs.readFileSync(path.join(__dirname, '../../phone/hand', path.basename(u))); return b.buffer.slice(b.byteOffset, b.byteOffset + b.length); };
const f32 = (f) => { const b = fs.readFileSync(f); return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length)); };
(async () => {
  const hands = await H.load({ fetch, simd });
  let bad = 0, checked = 0;
  for (const [key, name] of [['palm', 'palm_detection_lite'], ['landmark', 'hand_landmark_lite']]) {
    const m = hands.models[key];
    for (let k = 0; fs.existsSync(path.join(ref, `${name}-in${k}.f32`)); k++) {
      const x = f32(path.join(ref, `${name}-in${k}.f32`));
      m.e.f32(m.inPtr, x.length).set(x);
      const t0 = process.hrtime.bigint();
      m.run();
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      for (const out of Object.keys(m.head.outputs)) {
        const f = path.join(ref, `${name}-in${k}-${out}.f32`);
        if (!fs.existsSync(f)) { console.log(`  FAIL ${key} in${k} ${out}: no reference (${f})`); bad++; continue; }
        const want = f32(f), got = m.out(out);
        let maxd = want.length === got.length ? 0 : NaN, maxv = 0;
        for (let i = 0; i < want.length && i < got.length; i++) { const d = Math.abs(got[i] - want[i]); if (!(d <= maxd)) maxd = d; maxv = Math.max(maxv, Math.abs(want[i])); }
        const ok = maxd <= 1e-4 * Math.max(1, maxv);
        if (!ok) bad++;
        checked++;
        console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${key} in${k} ${out}: max |diff| ${maxd.toExponential(2)} (max |value| ${maxv.toPrecision(4)}), ${ms.toFixed(1)} ms, simd ${simd}`);
      }
    }
  }
  if (!checked) { console.log('  FAIL no reference outputs in ' + ref); bad++; }
  console.log(bad ? bad + ' FAILED' : 'ALL PASS (' + checked + ' outputs)');
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
