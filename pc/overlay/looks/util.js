'use strict';
/* Small deterministic helpers for the looks (looks/*.js): everything a look draws is worked out from the time since
   the flick, so a look plays the same at any frame rate. */
(function () {
  const L = (window.FLICK_LOOKS = window.FLICK_LOOKS || {});
  const U = {};
  L.U = U;
  U.clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  U.lerp = (a, b, t) => a + (b - a) * t;
  U.sstep = (a, b, x) => { const t = U.clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  U.easeOut2 = (t) => 1 - (1 - t) * (1 - t);
  U.easeOut3 = (t) => 1 - Math.pow(1 - t, 3);
  U.easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  U.fract = (x) => x - Math.floor(x);
  U.hash = (n) => U.fract(Math.sin(n * 127.1 + 311.7) * 43758.5453123);
  U.hash2 = (a, b) => U.hash(a * 57.0 + b * 131.0 + 0.5);
  U.rng = (seed) => {                       // mulberry32
    let a = seed >>> 0;
    const f = () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    f.r = (lo, hi) => lo + (hi - lo) * f();
    f.pick = (arr) => arr[Math.floor(f() * arr.length)];
    return f;
  };
  U.noise1 = (x, seed) => {
    const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f);
    return U.lerp(U.hash2(i, seed || 0), U.hash2(i + 1, seed || 0), u);
  };
  U.spring = (t, hz, zeta) => {             // 1 → 0 with a damped wobble
    if (t <= 0) return 1;
    const w = 2 * Math.PI * hz, wd = w * Math.sqrt(Math.max(1 - zeta * zeta, 1e-4));
    return Math.exp(-zeta * w * t) * (Math.cos(wd * t) + (zeta * w / wd) * Math.sin(wd * t));
  };
  U.bez2 = (a, b, c, t) => { const s = 1 - t; return [s * s * a[0] + 2 * s * t * b[0] + t * t * c[0], s * s * a[1] + 2 * s * t * b[1] + t * t * c[1]]; };
  // flight with linear drag k (1/s) and gravity g (px/s², down)
  U.ball = (x0, y0, vx, vy, k, g, tau) => {
    if (k < 1e-4) return [x0 + vx * tau, y0 + vy * tau + 0.5 * g * tau * tau, vx, vy + g * tau];
    const e = Math.exp(-k * tau), a = (1 - e) / k;
    return [x0 + vx * a, y0 + vy * a + (g / k) * (tau - a), vx * e, vy * e + (g / k) * (1 - e)];
  };
  // the look's sound curves (looks/curves.js), 0..1, at t seconds after the flick
  U.feat = (look, key, t) => {
    const c = L.curves && L.curves[look]; if (!c || !c[key]) return 0;
    const a = c[key], x = t * c.rate;
    if (x <= 0) return t >= 0 ? a[0] / 100 : 0;
    if (x >= a.length - 1) return 0;
    const i = Math.floor(x), u = x - i;
    return (a[i] + (a[i + 1] - a[i]) * u) / 100;
  };
  U.featS = (look, key, t, win) => { let s = 0; for (let i = 0; i < 5; i++) s += U.feat(look, key, t - win * (i / 4)); return s / 5; };
  // n times in [t0, t1], spread by a rate curve
  U.births = (n, t0, t1, rate, rnd) => {
    const M = 300, cdf = [0];
    for (let i = 1; i <= M; i++) cdf.push(cdf[i - 1] + Math.max(rate(t0 + (t1 - t0) * (i - 0.5) / M), 0));
    const tot = cdf[M] || 1, out = [];
    for (let k = 0; k < n; k++) {
      const q = ((k + (rnd ? rnd() : 0.5)) / n) * tot;
      let lo = 0, hi = M;
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cdf[m] < q) lo = m; else hi = m; }
      const f = (q - cdf[lo]) / Math.max(cdf[hi] - cdf[lo], 1e-9);
      out.push(t0 + (t1 - t0) * (lo + f) / M);
    }
    return out;
  };
  // a jagged lightning bolt from a to b (midpoint displacement, with branches) → segments [x0, y0, x1, y1, w]
  U.bolt = (ax, ay, bx, by, seed, o) => {
    o = o || {};
    const R = U.rng(seed), segs = [];
    const rough = o.rough == null ? 0.22 : o.rough, depth = o.depth || 6, branch = o.branch == null ? 0.35 : o.branch;
    function go(x0, y0, x1, y1, w, d, lvl) {
      if (d === 0) { segs.push([x0, y0, x1, y1, w]); return; }
      const dx = x1 - x0, dy = y1 - y0, len = Math.hypot(dx, dy) || 1;
      const off = (R() - 0.5) * 2 * rough * len;
      const mx = (x0 + x1) / 2 - (dy / len) * off, my = (y0 + y1) / 2 + (dx / len) * off;
      go(x0, y0, mx, my, w, d - 1, lvl);
      go(mx, my, x1, y1, w, d - 1, lvl);
      if (lvl < 2 && d >= 3 && R() < branch) {
        const ang = Math.atan2(y1 - y0, x1 - x0) + (R() < 0.5 ? -1 : 1) * (0.35 + R() * 0.6);
        const bl = len * (0.35 + R() * 0.45);
        go(mx, my, mx + Math.cos(ang) * bl, my + Math.sin(ang) * bl, w * 0.55, Math.max(d - 2, 2), lvl + 1);
      }
    }
    go(ax, ay, bx, by, o.w || 1, depth, 0);
    return segs;
  };
  // a bolt's segments as sprites: a white-hot core per segment (the bloom makes the glow), one soft glow along it
  U.boltSprites = (out, segs, core, halo, k, col) => {
    col = col || [0.62, 0.8, 1.0];
    for (const s of segs) {
      const dx = s[2] - s[0], dy = s[3] - s[1], len = Math.hypot(dx, dy);
      const cw = core * Math.max(s[4], 0.45), hw = cw * 3 + 1;
      out.push(U.spr((s[0] + s[2]) / 2, (s[1] + s[3]) / 2, len / 2 + hw, hw, Math.atan2(dy, dx), 4, col[0] * k, col[1] * k, col[2] * k, 1, cw, 0));
    }
    if (segs.length && halo > 0) {
      const a = segs[0];
      let ex = a[0], ey = a[1], far = 0;
      for (const s of segs) { const d = Math.hypot(s[2] - a[0], s[3] - a[1]); if (d > far) { far = d; ex = s[2]; ey = s[3]; } }
      out.push(U.spr((a[0] + ex) / 2, (a[1] + ey) / 2, far / 2 + halo * 2, halo * 2.0, Math.atan2(ey - a[1], ex - a[0]), 0, 0.3 * k, 0.45 * k, 1.0 * k, 0.11));
    }
  };
  U.spr = (x, y, a, b, ang, shape, r, g, bl, al, e0, e1) => ({ x, y, a, b, ang, shape, r, g, bl, al, e0, e1 });
})();
