// The engine with what it must never run as it is: model files that aren't one of its models or are damaged (their
// sizes, their program), and frames whose size doesn't add up. Each is refused with an error, instead of reading or
// writing outside its own memory: a damaged program the check lets through runs inside its model's arena, and the other
// model, loaded next to it, is left as it was. (A native build under AddressSanitizer checks every access more closely.)
// usage: node engine_safety.js [damaged programs] [simd 1|0]
const fs = require('fs'), path = require('path');
const H = require('../../phone/hand/hand.js');
const CASES = +(process.argv[2] || 300), simd = process.argv[3] !== '0';
const dir = path.join(__dirname, '../../phone/hand');
const file = (n) => { const b = fs.readFileSync(path.join(dir, n)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.length); };
let fails = 0;
const ok = (c, what, extra) => { console.log((c ? '  ok   ' : '  FAIL ') + what + (c || extra === undefined ? '' : ' -- ' + extra)); if (!c) fails++; };
let seed = 12345;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));

// a model file with its head changed by f (the program, the sizes, where things are)
function remake(bytes, f) {
  const dv = new DataView(bytes), jl = dv.getUint32(4, true);
  const head = JSON.parse(new TextDecoder().decode(new Uint8Array(bytes, 8, jl)));
  f(head);
  let js = new TextEncoder().encode(JSON.stringify(head));
  const pad = (4 - (js.length % 4)) % 4;
  const out = new Uint8Array(8 + js.length + pad + (bytes.byteLength - 8 - jl));
  out.set(new Uint8Array(bytes, 0, 4), 0);
  new DataView(out.buffer).setUint32(4, js.length + pad, true);
  out.set(js, 8);
  out.fill(32, 8 + js.length, 8 + js.length + pad);
  out.set(new Uint8Array(bytes, 8 + jl), 8 + js.length + pad);
  return out.buffer;
}
const sum = (u8) => { let a = 1, b = 0; for (let i = 0; i < u8.length; i++) { a = (a + u8[i]) % 65521; b = (b + a) % 65521; } return b * 65536 + a; };

(async () => {
  const wasm = file(simd ? 'hand-simd.wasm' : 'hand.wasm'), palm = file('palm.fhm'), lmk = file('landmark.fhm');
  const engine = async () => new H.Engine((await WebAssembly.instantiate(wasm, {})).instance);

  console.log('the real models');
  let e = await engine();
  const p0 = new H.Model(e, palm), l0 = new H.Model(e, lmk);
  ok(p0.head.ops.length > 50 && l0.head.ops.length > 50, 'both load and pass the check (' + p0.head.ops.length + ' and ' + l0.head.ops.length + ' ops)');

  console.log('model files that are not, or are damaged');
  const refuse = (what, bytes) => { let err = null; try { new H.Model(e, bytes); } catch (x) { err = x; } ok(err && /not a hand model/.test(err.message), what + ': refused', err ? err.message : 'loaded'); };
  refuse('not a model at all', new TextEncoder().encode('PK\x03\x04 not a model, a zip').buffer);
  refuse('cut short', palm.slice(0, 6));
  refuse('its head runs past the end', palm.slice(0, 200));
  refuse('its weights cut short', palm.slice(0, palm.byteLength - 1000));
  refuse('an arena below 0', remake(palm, (h) => { h.arena = -64; }));
  refuse('an arena of 0', remake(palm, (h) => { h.arena = 0; }));
  refuse('an arena too big for the engine', remake(palm, (h) => { h.arena = 2 ** 31; }));
  refuse('an arena that is not a number', remake(palm, (h) => { h.arena = '1e6'; }));
  refuse('more weights than the file has', remake(palm, (h) => { h.weights += 1000; }));
  refuse('its input outside the arena', remake(palm, (h) => { h.input.off = h.arena - 10; }));
  refuse('an output outside the arena', remake(lmk, (h) => { Object.values(h.outputs)[0].off = h.arena; }));
  refuse('an op that is not a list of numbers', remake(palm, (h) => { h.ops[3] = { code: 1 }; }));
  refuse('an op with a word that is not an int', remake(palm, (h) => { h.ops[3][2] = 0.5; }));
  refuse('an op the engine does not know', remake(palm, (h) => { h.ops[0][0] = 99; }));
  refuse('an op one word short', remake(palm, (h) => { h.ops[5].pop(); }));
  refuse('an op that writes past the arena', remake(palm, (h) => { h.ops[7][2] = h.arena - 3; }));
  refuse('an op that reads weights past their end', remake(lmk, (h) => { const op = h.ops.find((o) => o[0] === 2); op[7] = h.weights - 1; }));
  refuse('a first convolution with more outputs than it can hold', remake(lmk, (h) => { const op = h.ops.find((o) => o[0] === 1); op[8] = 5000; }));

  console.log('damaged programs: refused, or run inside their own arena (' + CASES + ', simd ' + simd + ')');
  let refused = 0, ran = 0, outside = 0;
  for (let k = 0; k < CASES; k++) {
    e = await engine();
    const bytes = remake(rnd() < 0.5 ? palm : lmk, (h) => {
      for (let j = ri(1, 3); j > 0; j--) {
        const op = h.ops[ri(0, h.ops.length - 1)], i = ri(1, op.length - 1);
        const r = ri(0, 4);
        op[i] = r === 0 ? ri(-(2 ** 31), 2 ** 31 - 1) : r === 1 ? op[i] + ri(-64, 64) : r === 2 ? -op[i] : r === 3 ? ri(0, 16) : op[i] * ri(2, 9);
        op[i] = Math.max(-(2 ** 31), Math.min(2 ** 31 - 1, op[i]));
      }
    });
    let m = null;
    try { m = new H.Model(e, bytes); } catch (x) { if (!/not a hand model/.test(x.message)) { ok(false, 'a damaged model is refused as one', x.message); } refused++; continue; }
    // the other model, loaded after it: its program and weights must come through the damaged one's run untouched
    const other = new H.Model(e, m.head.ops.length === p0.head.ops.length ? lmk : palm);
    const before = sum(e.u8(other.prog, other.nwords * 4)) + ':' + sum(e.u8(other.w, other.head.weights * 4));
    try { m.run(); } catch (x) { ok(false, 'an accepted program runs to its end', x.message); continue; }
    const after = sum(e.u8(other.prog, other.nwords * 4)) + ':' + sum(e.u8(other.w, other.head.weights * 4));
    if (after !== before) outside++;
    ran++;
  }
  ok(outside === 0, refused + ' refused, ' + ran + ' accepted and run: none wrote outside its own arena', outside + ' did');

  console.log('frames whose size does not add up');
  e = await engine();
  const hands = await H.load({ fetch: async (u) => file(path.basename(u)), simd });
  const px = new Uint8Array(64 * 48 * 4);
  for (const [w, h, what] of [[0, 48, 'no width'], [64, -2, 'a height below 0'], [64.5, 48, 'half a pixel'], [65, 48, 'a pixel more than it has'], [NaN, 48, 'no number']]) {
    let err = null;
    try { hands.track(px, w, h); } catch (x) { err = x; }
    ok(err && /not a frame/.test(err.message), what + ' (' + w + ' x ' + h + '): refused', err ? err.message : 'tracked');
  }
  ok(!!hands.track(px, 64, 48), 'the right size is tracked');
  ok(e.x.hb_malloc(-48) === 0, 'the allocator refuses a size below 0');
  console.log(fails ? fails + ' FAILED' : 'ALL PASS');
  process.exit(fails ? 1 : 0);
})().catch((x) => { console.error(x); process.exit(1); });
