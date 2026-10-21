'use strict';
// A small QR code encoder (ISO/IEC 18004), written for Flick: byte mode, all 40 versions, error correction L/M/Q/H,
// automatic mask choice. Used for the "Share with a browser" link. No dependencies.

const ECL = { L: { ord: 0, bits: 1 }, M: { ord: 1, bits: 0 }, Q: { ord: 2, bits: 3 }, H: { ord: 3, bits: 2 } };

// error correction codewords per block, and number of blocks, by level (L, M, Q, H) and version (index 0 unused)
const ECC_PER_BLOCK = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
];
const NUM_BLOCKS = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
];

// bits available for data + error correction in a version (everything that isn't a function pattern)
function rawModules(ver) {
  let r = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const na = Math.floor(ver / 7) + 2;
    r -= (25 * na - 10) * na - 55;
    if (ver >= 7) r -= 36;
  }
  return r;
}
function dataCodewords(ver, e) { return Math.floor(rawModules(ver) / 8) - ECC_PER_BLOCK[e.ord][ver] * NUM_BLOCKS[e.ord][ver]; }

// ---- Reed-Solomon over GF(2^8), polynomial 0x11D
function gfMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}
function rsDivisor(degree) {
  const r = new Array(degree).fill(0);
  r[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      r[j] = gfMul(r[j], root);
      if (j + 1 < degree) r[j] ^= r[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  return r;
}
function rsRemainder(data, div) {
  const r = div.map(() => 0);
  for (const b of data) {
    const f = b ^ r.shift();
    r.push(0);
    for (let i = 0; i < div.length; i++) r[i] ^= gfMul(div[i], f);
  }
  return r;
}

function utf8(text) {
  if (typeof TextEncoder !== 'undefined') return Array.from(new TextEncoder().encode(String(text)));
  return Array.from(Buffer.from(String(text), 'utf8'));
}

/**
 * Encode text (UTF-8, byte mode). opts.ecl: 'L' | 'M' | 'Q' | 'H' (default 'M'; raised for free when it still fits the
 * same size). Returns { version, size, ecl, mask, modules } where modules[y][x] is 1 for a dark module.
 */
function encode(text, opts) {
  opts = opts || {};
  const bytes = utf8(text);
  let ecl = ECL[opts.ecl] || ECL.M;
  let ver = 0;
  for (let v = opts.minVersion || 1; v <= 40; v++) {
    const bits = 4 + (v <= 9 ? 8 : 16) + bytes.length * 8;
    if (bits <= dataCodewords(v, ecl) * 8) { ver = v; break; }
  }
  if (!ver) throw new Error('too long for a QR code');
  const ccBits = ver <= 9 ? 8 : 16;
  const used = 4 + ccBits + bytes.length * 8;
  for (const k of ['M', 'Q', 'H']) if (opts.boost !== false && ECL[k].ord > ecl.ord && used <= dataCodewords(ver, ECL[k]) * 8) ecl = ECL[k];

  // ---- data bits: mode, length, bytes, terminator, padding
  const bb = [];
  const put = (val, len) => { for (let i = len - 1; i >= 0; i--) bb.push((val >>> i) & 1); };
  put(0x4, 4);
  put(bytes.length, ccBits);
  for (const b of bytes) put(b, 8);
  const cap = dataCodewords(ver, ecl) * 8;
  put(0, Math.min(4, cap - bb.length));
  put(0, (8 - (bb.length % 8)) % 8);
  for (let pad = 0xec; bb.length < cap; pad ^= 0xec ^ 0x11) put(pad, 8);
  const data = [];
  for (let i = 0; i < bb.length; i += 8) { let b = 0; for (let j = 0; j < 8; j++) b = (b << 1) | bb[i + j]; data.push(b); }

  // ---- error correction, split into blocks and interleaved
  const nb = NUM_BLOCKS[ecl.ord][ver], eccLen = ECC_PER_BLOCK[ecl.ord][ver];
  const raw = Math.floor(rawModules(ver) / 8);
  const nShort = nb - (raw % nb), shortLen = Math.floor(raw / nb);
  const div = rsDivisor(eccLen);
  const blocks = [];
  for (let i = 0, k = 0; i < nb; i++) {
    const dat = data.slice(k, k + shortLen - eccLen + (i < nShort ? 0 : 1));
    k += dat.length;
    const ecc = rsRemainder(dat, div);
    if (i < nShort) dat.push(0);
    blocks.push(dat.concat(ecc));
  }
  const words = [];
  for (let i = 0; i < blocks[0].length; i++) {
    for (let j = 0; j < blocks.length; j++) if (i !== shortLen - eccLen || j >= nShort) words.push(blocks[j][i]);
  }

  // ---- the symbol
  const size = ver * 4 + 17;
  const mod = Array.from({ length: size }, () => new Uint8Array(size));
  const fn = Array.from({ length: size }, () => new Uint8Array(size));
  const setF = (x, y, dark) => { mod[y][x] = dark ? 1 : 0; fn[y][x] = 1; };
  for (let i = 0; i < size; i++) { setF(6, i, i % 2 === 0); setF(i, 6, i % 2 === 0); }
  const finder = (cx, cy) => {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const d = Math.max(Math.abs(dx), Math.abs(dy)), x = cx + dx, y = cy + dy;
      if (x >= 0 && x < size && y >= 0 && y < size) setF(x, y, d !== 2 && d !== 4);
    }
  };
  finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
  const align = [];
  if (ver > 1) {
    const na = Math.floor(ver / 7) + 2;
    const step = Math.floor((ver * 8 + na * 3 + 5) / (na * 4 - 4)) * 2;
    align.push(6);
    for (let p = size - 7; align.length < na; p -= step) align.splice(1, 0, p);
  }
  const last = align.length - 1;
  for (let i = 0; i < align.length; i++) for (let j = 0; j < align.length; j++) {
    if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) setF(align[i] + dx, align[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }
  const drawFormat = (mask) => {
    const d = (ecl.bits << 3) | mask;
    let rem = d;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((d << 10) | rem) ^ 0x5412;
    const bit = (i) => (bits >>> i) & 1;
    for (let i = 0; i <= 5; i++) setF(8, i, bit(i));
    setF(8, 7, bit(6)); setF(8, 8, bit(7)); setF(7, 8, bit(8));
    for (let i = 9; i < 15; i++) setF(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) setF(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) setF(8, size - 15 + i, bit(i));
    setF(8, size - 8, 1);
  };
  drawFormat(0);                                    // reserves the format areas; redrawn with the real mask below
  if (ver >= 7) {
    let rem = ver;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (ver << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const b = (bits >>> i) & 1, a = size - 11 + (i % 3), c = Math.floor(i / 3);
      setF(a, c, b); setF(c, a, b);
    }
  }
  // codewords in the zigzag order, two columns at a time from the bottom right
  let bi = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j, up = ((right + 1) & 2) === 0, y = up ? size - 1 - vert : vert;
        if (!fn[y][x] && bi < words.length * 8) { mod[y][x] = (words[bi >>> 3] >>> (7 - (bi & 7))) & 1; bi++; }
      }
    }
  }

  const MASKS = [
    (x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x) => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
    (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
  ];
  const applyMask = (m) => {
    const f = MASKS[m];
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fn[y][x] && f(x, y)) mod[y][x] ^= 1;
  };
  let mask = opts.mask >= 0 && opts.mask <= 7 ? opts.mask : -1;
  if (mask < 0) {
    let best = Infinity;
    for (let m = 0; m < 8; m++) {
      applyMask(m); drawFormat(m);
      const p = penalty(mod, size);
      if (p < best) { best = p; mask = m; }
      applyMask(m);                                 // XOR again: undone
    }
  }
  applyMask(mask); drawFormat(mask);
  return { version: ver, size, ecl: Object.keys(ECL).find((k) => ECL[k] === ecl), mask, modules: mod };
}

// how hard a masked symbol is to read (the standard's four rules); the mask with the lowest score is used
function penalty(mod, size) {
  let score = 0;
  // rule 3 on run lengths: a dark:light:dark:light:dark run of n:n:3n:n:n (a finder look-alike at any scale) with a
  // light run of 4n or more on either side; the quiet zone around the symbol counts as light
  const finders = (h) => {
    const n = h[1];
    const core = n > 0 && h[2] === n && h[3] === n * 3 && h[4] === n && h[5] === n;
    return (core && h[0] >= n * 4 && h[6] >= n ? 1 : 0) + (core && h[6] >= n * 4 && h[0] >= n ? 1 : 0);
  };
  const push = (h, len) => { if (h[0] === 0) len += size; h.pop(); h.unshift(len); };
  const line = (get) => {
    // rule 1: runs of 5+ modules of one color
    let color = 0, run = 0;
    const h = [0, 0, 0, 0, 0, 0, 0];
    for (let i = 0; i < size; i++) {
      if (get(i) === color) {
        run++;
        if (run === 5) score += 3; else if (run > 5) score++;
      } else {
        push(h, run);
        if (!color) score += finders(h) * 40;
        color = get(i); run = 1;
      }
    }
    if (color) { push(h, run); run = 0; }
    push(h, run + size);
    score += finders(h) * 40;
  };
  for (let y = 0; y < size; y++) line((x) => mod[y][x]);
  for (let x = 0; x < size; x++) line((y) => mod[y][x]);
  let dark = 0;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const c = mod[y][x];
    dark += c;
    if (x < size - 1 && y < size - 1 && c === mod[y][x + 1] && c === mod[y + 1][x] && c === mod[y + 1][x + 1]) score += 3;
  }
  const total = size * size;
  score += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
  return score;
}

/** SVG path data for the dark modules (one subpath per horizontal run), with a quiet zone of `border` modules. */
function svgPath(qr, border) {
  const b = border == null ? 4 : border;
  let d = '';
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size;) {
      if (!qr.modules[y][x]) { x++; continue; }
      let n = 1;
      while (x + n < qr.size && qr.modules[y][x + n]) n++;
      d += 'M' + (x + b) + ' ' + (y + b) + 'h' + n + 'v1h-' + n + 'z';
      x += n;
    }
  }
  return { d, n: qr.size + 2 * b };
}

module.exports = { encode, svgPath };
