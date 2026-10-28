'use strict';
/* Warp (sound: Noise riser, pitch raised half way: a rushing whoosh, brightening, over a pumping low rumble; it lets go
   all at once). A tunnel opens where the card will land: the desktop stretches toward it and star streaks pour out,
   pulsing with the rumble. The card flies out of the tunnel toward you and drops out of warp the moment the sound lets
   go: the streaks snap off, the desktop springs back, a ring of light. To the phone: the card is pulled into a tunnel
   where it is, and the tunnel closes as the sound lets go. */
(function () {
  const LOOKS = (window.FLICK_LOOKS = window.FLICK_LOOKS || {});
  const U = LOOKS.U;
  const spr = U.spr;
  const HIT = 1.2, T0 = 0.06, OUT = 0.75;

  // how far into warp (0..1): builds with the whoosh
  function W(t) {
    if (t <= 0) return 0;
    const env = U.featS('warp', 'env', Math.min(t, HIT), 0.05);
    return U.clamp(Math.pow(U.sstep(0.0, HIT - 0.05, t), 1.15) * (0.72 + 0.28 * env), 0, 1);
  }
  // card scale: far away in the tunnel, rushing closer, then the last jump to full size
  function scaleAt(t) {
    if (t < T0) return 0;
    if (t < HIT - 0.08) return 0.03 * Math.exp(2.8 * (t - T0));
    const s1 = 0.03 * Math.exp(2.8 * (HIT - 0.08 - T0));
    return U.lerp(s1, 1, U.easeOut3((t - (HIT - 0.08)) / 0.08));
  }
  const cool = (k, h) => [U.lerp(0.62, 0.78, h) * k, U.lerp(0.45, 0.95, h) * k, 1.0 * k];

  function start(ctx) {
    const R = U.rng(ctx.seed);
    const n = (k) => Math.round(k * (ctx.lite ? 0.35 : 1));
    const st = {};
    st.streaks = U.births(n(1100), 0.02, HIT, (t) => Math.pow(0.25 + W(t), 2), R).map((tb) => ({
      tb, ang: R.r(0, 6.283), r0: R.r(8, 95), lam: R.r(2.6, 4.4), w: R.r(0.7, 1.7), hot: R.r(1.0, 2.6), life: R.r(0.45, 0.8), hue: R(),
      wb: W(tb), hb: U.feat('warp', 'hi', tb) }));          // (how far into warp, and how bright the hiss, when it was born)
    st.dust = Array.from({ length: n(70) }, () => ({ ang: R.r(0, 6.283), r0: R.r(20, ctx.hd * 1.2), sp: R.r(40, 160), life: R.r(0.35, 0.8), sz: R.r(1.2, 2.6), hot: R.r(0.8, 1.8) }));
    st.inward = U.births(n(420), 0.0, OUT, (t) => 0.3 + t, R).map((tb) => ({ tb, ang: R.r(0, 6.283), r0: R.r(260, 900), lam: R.r(3.5, 5.5), w: R.r(0.7, 1.5), hot: R.r(1.0, 2.2), life: R.r(0.3, 0.5), hue: R() }));
    // the rumble's pulses (peaks of the low band) → rings travelling down the tunnel
    st.pumps = [];
    let last = -1;
    for (let t = 0.05; t < HIT - 0.04; t += 1 / 120) {
      const a = U.feat('warp', 'lo', t - 1 / 120), b = U.feat('warp', 'lo', t), d = U.feat('warp', 'lo', t + 1 / 120);
      if (b > a && b >= d && b > 0.55 && t - last > 0.055) { st.pumps.push(t); last = t; }
    }
    return st;
  }

  function frame(t, ctx, st) {
    const F = { under: [], add: [], smoke: [], ribbons: [], desk: { lights: [], shocks: [] }, post: {} };
    const C = ctx.L, ks = ctx.ks, hd = ctx.hd, tau = t - HIT, pre = t < HIT;
    const w = pre ? W(t) : W(HIT - 0.001);
    const P = U.feat('warp', 'lo', Math.min(t, HIT));
    if (pre) {
      F.desk.warp = { x: C[0], y: C[1], blur: 0.45 * w + 0.07 * P * w, zoom: 0.1 * w + 0.03 * P * w, ca: 12 * ks * w };
      F.desk.dim = 1 - 0.28 * w; F.desk.vig = 0.45 * w; F.desk.tint = [1 - 0.06 * w, 1 - 0.08 * w, 1 + 0.1 * w];
      const sh = 2.6 * ks * w * P;
      F.post.shake = [sh * (U.noise1(t * 70, 3) - 0.5) * 2, sh * (U.noise1(t * 70, 9) - 0.5) * 2];
      const open = U.sstep(0, 0.1, t);
      F.under.push(spr(C[0], C[1], (40 + 150 * w) * ks, (40 + 150 * w) * ks, 0, 0, 0.62, 0.55, 1.0, (0.35 + 0.5 * P) * w * open));
      F.under.push(spr(C[0], C[1], (10 + 26 * w) * ks, (10 + 26 * w) * ks, 0, 0, 1.6, 1.6, 2.0, open * (0.8 + 0.6 * P)));
      F.add.push(spr(C[0], C[1], (120 + 520 * w) * ks, 2.2 + 2 * w, 0, 1, 0.5, 0.75, 1.2, open * (0.5 + 0.5 * w)));
      F.desk.lights.push({ x: C[0], y: C[1], r: (260 + 260 * w) * ks, i: 0.45 * w * (0.7 + 0.5 * P), c: [0.55, 0.5, 1.0] });
      for (const pt of st.pumps) {
        const a = t - pt; if (a < 0 || a > 0.5) continue;
        const r = 18 * ks * Math.exp(4.6 * a);
        F.under.push(spr(C[0], C[1], r / 0.86, r / 0.86 * 0.94, 0, 3, 0.6, 0.5, 1.0, 0.75 * w * (1 - a / 0.5), 0.02 + 0.03 * a));
      }
      const s = scaleAt(t);
      if (s > 0) {
        const e = U.clamp((t - T0) / (HIT - T0), 0, 1), rz = 1.1 * Math.pow(1 - e, 1.6) * -ctx.dir;
        F.card = { x: C[0], y: C[1], s, rz, shadowK: U.sstep(0.6, 1, e), fx: { glow: [0.55, 0.7, 1.0, 0.9 * (1 - 0.5 * e)], margin: 30, bright: 0.06 * (1 - e) } };
        F.ghosts = [];
        for (let i = 1; i <= (ctx.lite ? 2 : 5); i++) {
          F.ghosts.push({ x: C[0], y: C[1], s: s * (1 + 0.08 * i * w), rz: rz + 0.05 * i * (1 - e), op: 0.16 * (1 - i / 6) * w, add: true, fx: { chan: [0.6, 0.75, 1.0], margin: 10 } });
        }
      } else F.card = { x: C[0], y: C[1], s: 0.001, op: 0, shadowK: 0 };
    } else {
      F.desk.warp = { x: C[0], y: C[1], blur: 0.45 * w * Math.exp(-tau / 0.03), zoom: -0.035 * Math.exp(-tau / 0.09) * Math.cos(tau * 2 * Math.PI / 0.2) + 0.12 * w * Math.exp(-tau / 0.02), ca: 12 * ks * Math.exp(-tau / 0.06) };
      F.desk.dim = 1 - 0.28 * Math.exp(-tau / 0.12); F.desk.vig = 0.45 * Math.exp(-tau / 0.18);
      const ff = 0.3 * Math.exp(-tau / 0.022);
      F.post.full = [ff * 0.75, ff * 0.8, ff];
      F.post.flash = { x: C[0], y: C[1], r: 300 * ks, i: 0.75 * Math.exp(-tau / 0.06), c: [0.75, 0.8, 1.0] };
      F.post.ca = { x: C[0], y: C[1], a: 30 * Math.exp(-tau / 0.08) };
      const r1 = 980 * ks * (1 - Math.exp(-tau / 0.17));
      F.desk.shocks.push({ x: C[0], y: C[1], r: r1, s: 15 * ks * Math.exp(-tau / 0.2), w: (28 + 60 * tau) * ks });
      if (tau < 0.4) F.add.push(spr(C[0], C[1], r1 / 0.86 + 1, r1 / 0.86 + 1, 0, 3, 0.75, 0.88, 1.0, 1.3 * Math.exp(-tau / 0.1), 0.018));
      const amp = 9 * ks * Math.exp(-tau / 0.07);
      F.post.shake = [amp * (U.noise1(tau * 50, 3) - 0.5) * 2, amp * (U.noise1(tau * 50, 9) - 0.5) * 2];
      F.card = { x: C[0], y: C[1], s: 1 + 0.09 * U.spring(tau, 5, 0.35), rz: 0, landed: true, fx: { glow: [0.55, 0.7, 1.0, Math.exp(-tau / 0.12)], margin: 30 } };
      F.add.push(spr(C[0], C[1], (120 + 600 * Math.exp(-tau / 0.1)) * ks, 2.5, 0, 1, 0.5, 0.75, 1.2, Math.exp(-tau / 0.08)));
      F.under.push(spr(C[0], C[1], hd * 1.8, hd * 1.8, 0, 0, 0.6, 0.6, 1.0, 0.5 * Math.exp(-tau / 0.15)));
      for (const q of st.dust) {
        if (tau > q.life) continue;
        const r = q.r0 + q.sp * ks * tau, u = tau / q.life, k = q.hot * (1 - u);
        F.add.push(spr(C[0] + Math.cos(q.ang) * r, C[1] + Math.sin(q.ang) * r, q.sz, q.sz, 0, 0, 0.7 * k, 0.8 * k, 1.0 * k, 1));
      }
    }
    // star streaks pouring out of the tunnel (they snap off when it lets go)
    const cut = pre ? 1 : Math.exp(-tau / 0.035);
    if (cut > 0.01) {
      for (const q of st.streaks) {
        const a = t - q.tb; if (a < 0 || a > q.life) continue;
        const lam = q.lam * (0.75 + 0.6 * q.wb);
        const r = q.r0 * ks * Math.exp(lam * a), r1 = q.r0 * ks * Math.exp(lam * Math.max(a - 0.05, 0));
        if (r > 1700 * ks) continue;
        const k = q.hot * U.sstep(0, 0.06, a) * (1 - U.sstep(q.life * 0.7, q.life, a)) * cut * (0.5 + 0.7 * q.wb);
        const c = cool(k, U.clamp(q.hue * 0.5 + q.hb * 0.6, 0, 1));
        F.add.push(spr(C[0] + Math.cos(q.ang) * (r + r1) / 2, C[1] + Math.sin(q.ang) * (r + r1) / 2, (r - r1) / 2 + 1.5, q.w * (0.6 + r / (900 * ks)), q.ang, 1, c[0], c[1], c[2], 1));
      }
    }
    return F;
  }

  // to the phone: a tunnel opens where the card is and pulls it in; it closes as the sound lets go
  function out(t, ctx, st) {
    const F = { under: [], add: [], smoke: [], ribbons: [], desk: { lights: [], shocks: [] }, post: {} };
    const C = ctx.E, ks = ctx.ks, u = U.clamp(t / OUT, 0, 1), w = Math.pow(u, 1.1) * (t < OUT ? 1 : Math.exp(-(t - OUT) / 0.05));
    F.desk.warp = { x: C[0], y: C[1], blur: 0.35 * w, zoom: 0.08 * w, ca: 8 * ks * w };
    F.desk.dim = 1 - 0.22 * w; F.desk.vig = 0.35 * w;
    if (t < OUT) {
      const s = Math.max(0.02, Math.exp(-4.2 * Math.pow(u, 1.4)));
      F.card = { x: C[0], y: C[1], s, rz: 1.4 * Math.pow(u, 1.5) * ctx.dir, shadowK: 1 - u, op: 1 - U.sstep(0.88, 1, u), fx: { glow: [0.55, 0.7, 1.0, 1.2 * u], margin: 30 } };
      F.under.push(spr(C[0], C[1], (30 + 120 * w) * ks, (30 + 120 * w) * ks, 0, 0, 0.62, 0.55, 1.0, 0.6 * w));
    } else {
      const tau = t - OUT;
      F.post.flash = { x: C[0], y: C[1], r: 220 * ks, i: 0.6 * Math.exp(-tau / 0.06), c: [0.75, 0.8, 1.0] };
      const r1 = 420 * ks * (1 - Math.exp(-tau / 0.12));
      if (tau < 0.3) F.add.push(spr(C[0], C[1], r1 / 0.86 + 1, r1 / 0.86 + 1, 0, 3, 0.75, 0.88, 1.0, 0.9 * Math.exp(-tau / 0.08), 0.02));
    }
    // streaks pour in
    for (const q of st.inward) {
      const a = t - q.tb; if (a < 0 || a > q.life || q.tb > OUT) continue;
      const r = q.r0 * ks * Math.exp(-q.lam * a), r1 = q.r0 * ks * Math.exp(-q.lam * Math.max(a - 0.05, 0));
      const k = q.hot * U.sstep(0, 0.05, a) * (1 - U.sstep(q.life * 0.7, q.life, a)) * (t < OUT ? 1 : Math.exp(-(t - OUT) / 0.03));
      const c = cool(k, q.hue);
      F.add.push(spr(C[0] + Math.cos(q.ang) * (r + r1) / 2, C[1] + Math.sin(q.ang) * (r + r1) / 2, (r1 - r) / 2 + 1.5, q.w, q.ang + Math.PI, 1, c[0], c[1], c[2], 1));
    }
    return F;
  }

  LOOKS.warp = { name: 'warp', title: 'Warp', HIT, OUT, DUR: 2.0, color: [0.68, 0.55, 1.0], enter: 'away', start, frame, out };
})();
