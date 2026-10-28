'use strict';
/* Meteor (sound: Titan riser, same pitch: a swelling tone that rises and stops dead at its peak).
   The card is thrown up and away, catches fire at the top of its arc and dives back burning hotter as the tone climbs.
   It hits the desktop where the sound stops: a flash, a shockwave, sparks, then it cools down in silence.
   To the phone: it ignites and shoots off toward the phone's side, gone as the sound stops. */
(function () {
  const LOOKS = (window.FLICK_LOOKS = window.FLICK_LOOKS || {});
  const U = LOOKS.U;
  const spr = U.spr;
  const HIT = 1.2, TA = 0.4, OUT = 0.75;
  const fireCol = (age) => {                     // white-yellow → orange → red
    if (age < 0.25) return [1, U.lerp(0.95, 0.7, age / 0.25), U.lerp(0.75, 0.3, age / 0.25)];
    if (age < 0.6) return [1, U.lerp(0.7, 0.36, (age - 0.25) / 0.35), U.lerp(0.3, 0.06, (age - 0.25) / 0.35)];
    return [U.lerp(1, 0.75, (age - 0.6) / 0.4), U.lerp(0.36, 0.12, (age - 0.6) / 0.4), 0.03];
  };

  // how hot it is (0..1): a glow at the top of the arc, then up with the tone
  function heat(t) {
    if (t <= 0) return 0;
    const hi = U.featS('meteor', 'hi', Math.min(t, HIT - 0.01), 0.04);
    return U.clamp((0.26 * U.sstep(0.16, 0.42, t) + 0.8 * Math.pow(U.sstep(0.38, HIT, t), 1.35)) * (0.86 + 0.14 * hi), 0, 1);
  }

  function start(ctx) {
    const { E, L, ks, dir, H, lite } = ctx;
    const st = {};
    st.A = [L[0] + 0.45 * (E[0] - L[0]), Math.max(0.08 * H, Math.min(E[1], L[1]) - 0.3 * H)];
    st.C1 = [E[0] + dir * 250 * ks, E[1] - 150 * ks];
    st.C2 = [st.A[0] + dir * 75 * ks, st.A[1] + 93 * ks];
    const R = U.rng(ctx.seed);
    const n = (k) => Math.round(k * (lite ? 0.38 : 1));
    st.sparks = U.births(n(560), 0.24, HIT, (t) => Math.pow(heat(t), 1.5), R).map((tb) => ({
      tb, life: R.r(0.14, 0.46), ox: R.r(-0.45, 0.45), oy: R.r(-0.45, 0.45), sp: R.r(0.05, 0.32), side: R.r(-1, 1), j: R.r(60, 360), hot: R.r(0.9, 2.0), w: R.r(0.9, 1.9) }));
    st.embers = U.births(n(150), 0.3, HIT, (t) => heat(t), R).map((tb) => ({
      tb, life: R.r(0.4, 0.95), ox: R.r(-0.5, 0.5), oy: R.r(-0.5, 0.5), vx: R.r(-90, 90), vy: R.r(-120, 40), sz: R.r(1.6, 3.6), ph: R.r(0, 50), hot: R.r(0.7, 1.6) }));
    st.smoke = U.births(n(54), 0.5, HIT, (t) => heat(t), R).map((tb) => ({
      tb, life: R.r(0.55, 1.05), ox: R.r(-0.4, 0.4), oy: R.r(-0.4, 0.4), vx: R.r(-30, 30), vy: R.r(-50, -10), sz: R.r(0.8, 1.3), seed: R.r(0, 9) }));
    st.burst = Array.from({ length: n(220) }, () => {
      const up = R() < 0.82;
      const ang = up ? R.r(-Math.PI * 0.97, -Math.PI * 0.03) : R.r(0, Math.PI);
      return { ang, sp: R.r(260, 1500) * (up ? 1 : 0.5), life: R.r(0.32, 1.05), w: R.r(0.9, 2.3), hot: R.r(1.6, 3.6), r0: R.r(0.2, 0.9) };
    });
    st.bembers = Array.from({ length: n(70) }, () => ({ ang: R.r(-Math.PI, 0), sp: R.r(60, 420), life: R.r(0.8, 1.7), sz: R.r(1.8, 4.2), ph: R.r(0, 50), hot: R.r(0.8, 1.7), r0: R.r(0, 1) }));
    st.bsmoke = Array.from({ length: n(12) }, () => ({ ox: R.r(-0.6, 0.6), oy: R.r(-0.5, 0.5), vx: R.r(-70, 70), vy: R.r(-130, -50), life: R.r(0.8, 1.4), sz: R.r(0.7, 1.15), seed: R.r(0, 9), d: R.r(0.02, 0.14) }));
    // to the phone
    st.osparks = U.births(n(260), 0.02, OUT, (t) => 0.3 + t, R).map((tb) => ({ tb, life: R.r(0.14, 0.4), ox: R.r(-0.45, 0.45), oy: R.r(-0.45, 0.45), sp: R.r(0.05, 0.3), side: R.r(-1, 1), j: R.r(60, 300), hot: R.r(0.9, 2.0), w: R.r(0.9, 1.8) }));
    return st;
  }

  // the card's centre, size and tilt before the hit
  function path(t, ctx, st) {
    t = U.clamp(t, 0, HIT);
    let p, s, rz, rx, ry;
    if (t < TA) {
      const u = t / TA, e = 1 - Math.pow(1 - u, 1.6);
      p = U.bez2(ctx.E, st.C1, st.A, e);
      s = U.lerp(0.9, 0.34, U.easeInOut(u));
      rz = U.lerp(ctx.r0 || 0, 0.5 * -ctx.dir, U.easeOut2(u)); rx = -0.55 * U.easeOut2(u); ry = -0.35 * ctx.dir * U.easeOut2(u);
    } else {
      const u = (t - TA) / (HIT - TA), e = Math.pow(u, 1.85);
      p = U.bez2(st.A, st.C2, ctx.L, e);
      s = 0.34 + 0.66 * Math.pow(e, 1.15);
      rz = U.lerp(0.5 * -ctx.dir, 0, U.sstep(0, 1, u)); rx = U.lerp(-0.55, 0, u); ry = U.lerp(-0.35 * ctx.dir, 0, u);
    }
    return { x: p[0], y: p[1], s, rz, rx, ry };
  }
  const vel = (f, t) => { const a = f(t - 0.004), b = f(t); return [(b.x - a.x) / 0.004, (b.y - a.y) / 0.004]; };

  // fire around a moving card: the trail, the plasma at its leading edge, the light it casts, the air it bends
  function burning(F, ctx, pf, t, H, t0, M_) {
    const p = pf(t), v = vel(pf, t), sp = Math.hypot(v[0], v[1]) || 1;
    const hd = ctx.hd, ks = ctx.ks;
    const pts = [];
    for (let k = 0; k <= M_; k++) {
      const tk = t - k * 0.0085 * (44 / M_);
      if (tk < t0) break;
      const q = pf(tk), hk = H(tk), u = k / M_;
      pts.push({ x: q.x, y: q.y, w: hd * q.s * (0.5 + 0.62 * Math.sqrt(u) + 0.25 * hk) * Math.pow(1 - u, 0.35) + 3, k: Math.min(hk * 2.0, 1.8) * U.sstep(0, 0.06, u) });
    }
    if (pts.length > 2) F.ribbons.push({ pts, seed: 1.3, kind: 0 });
    const h = H(t), dir = [v[0] / sp, v[1] / sp], ang = Math.atan2(v[1], v[0]), a = hd * p.s;
    F.add.push(spr(p.x + dir[0] * a * 0.74, p.y + dir[1] * a * 0.74, a * (0.1 + 0.08 * h), a * (0.7 + 0.2 * h), ang, 0, 1, 0.86, 0.6, 0.85 * Math.pow(h, 1.3)));
    F.add.push(spr(p.x + dir[0] * a * 0.66, p.y + dir[1] * a * 0.66, a * (0.22 + 0.12 * h), a * (0.95 + 0.25 * h), ang, 0, 1, 0.55, 0.18, 0.26 * h));
    F.add.push(spr(p.x, p.y, a * 1.35, a * 1.35, 0, 0, 1, 0.42, 0.1, 0.12 * h));
    F.add.push(spr(p.x - dir[0] * a * 1.6, p.y - dir[1] * a * 1.6, a * 2.6, a * (0.22 + 0.12 * h), ang, 1, 1, 0.5, 0.15, 0.35 * h));
    F.desk.lights.push({ x: p.x, y: p.y, r: (220 + 260 * p.s) * ks, i: 1.1 * h, c: [1, 0.46, 0.15] });
    for (const k of [3, 8, 13, 19, 25, 31]) { const q = pts[Math.round(k * M_ / 44)]; if (q) F.desk.haze.push({ x: q.x, y: q.y, r: (36 + 34 * p.s) * ks, a: 0.7 * h }); }
    const c = Math.cos(-p.rz), sn = Math.sin(-p.rz);
    return { p, v, sp, dl: [(v[0] * c - v[1] * sn) / sp, (v[0] * sn + v[1] * c) / sp], h };
  }
  function trailSparks(F, ctx, pf, list, t) {
    const hd = ctx.hd, ks = ctx.ks;
    for (const q of list) {
      const age = t - q.tb; if (age < 0 || age > q.life) continue;
      const p = pf(q.tb), v = vel(pf, q.tb), sp = Math.hypot(v[0], v[1]) || 1;
      const nx = -v[1] / sp, ny = v[0] / sp, dx = v[0] / sp, dy = v[1] / sp;
      const back = hd * p.s * (0.45 + 0.2 * q.oy), side = q.ox * 1.3 * hd * p.s;
      const b = U.ball(p.x - dx * back + nx * side, p.y - dy * back + ny * side, -v[0] * q.sp + nx * q.side * q.j * ks, -v[1] * q.sp + ny * q.side * q.j * ks, 3.2, 420 * ks, age);
      const u = age / q.life, c = fireCol(u), k = q.hot * Math.pow(1 - u, 1.2);
      F.add.push(spr(b[0], b[1], Math.hypot(b[2], b[3]) * 0.02 + 2.5, q.w, Math.atan2(b[3], b[2]), 1, c[0] * k, c[1] * k, c[2] * k, 1));
    }
  }

  function frame(t, ctx, st) {
    const F = { under: [], add: [], smoke: [], ribbons: [], desk: { lights: [], shocks: [], haze: [] }, post: {} };
    const { L, ks, hd } = ctx, tau = t - HIT, pre = t < HIT;
    const pf = (x) => path(x, ctx, st);
    if (pre) {
      const b = burning(F, ctx, pf, t, heat, 0.2, ctx.lite ? 22 : 44);
      F.card = { x: b.p.x, y: b.p.y, s: b.p.s, rz: b.p.rz, rx: b.p.rx, ry: b.p.ry, shadowK: 0.15, fx: { heat: b.h, hdx: b.dl[0], hdy: b.dl[1], margin: 44 } };
      const sh = 5 * ks * U.sstep(0.82, HIT, t) * b.h;
      F.post.shake = [sh * (U.noise1(t * 40, 3) - 0.5) * 2, sh * (U.noise1(t * 40, 7) - 0.5) * 2];
      F.desk.dim = 1 - 0.3 * b.h; F.desk.vig = 0.38 * b.h; F.desk.tint = [1, 0.97, 0.94];
    } else {
      const Hc = Math.exp(-tau / 0.34);
      F.card = { x: L[0], y: L[1], s: 1 + 0.07 * U.spring(tau, 6, 0.33), rz: 0, landed: true, fx: { heat: Hc * 0.95, hdx: 0, hdy: -1, margin: 44 } };
      const ff = 0.7 * Math.exp(-tau / 0.022);
      F.post.full = [ff, ff * 0.93, ff * 0.82];
      F.post.flash = { x: L[0], y: L[1], r: 420 * ks, i: 1.3 * Math.exp(-tau / 0.075), c: [1, 0.78, 0.52] };
      const r1 = 1400 * ks * (1 - Math.exp(-tau / 0.36));
      F.desk.shocks.push({ x: L[0], y: L[1], r: r1, s: 24 * ks * Math.exp(-tau / 0.32), w: (30 + 80 * tau) * ks });
      if (tau < 0.5) F.add.push(spr(L[0], L[1], r1 / 0.86 + 1, r1 / 0.86 + 1, 0, 3, 1, 0.72, 0.42, 1.3 * Math.exp(-tau / 0.13), 0.022));
      const r2 = 470 * ks * (1 - Math.exp(-tau / 0.42));
      if (tau < 1.2) F.add.push(spr(L[0], L[1], r2 / 0.86 + 1, r2 / 0.86 * 0.55 + 1, 0, 3, 1, 0.45, 0.14, 0.55 * Math.exp(-tau / 0.32), 0.05));
      F.desk.scorch = { x: L[0], y: L[1], r: hd * 1.25, a: 0.55 * Math.exp(-tau / 0.55) * U.sstep(0, 0.03, tau), g: 0.9 * Math.exp(-tau / 0.3) };
      F.desk.lights.push({ x: L[0], y: L[1], r: 430 * ks, i: 1.6 * Math.exp(-tau / 0.15) + 0.35 * Math.exp(-tau / 0.6), c: [1, 0.5, 0.17] });
      for (let k = 0; k < 4; k++) F.desk.haze.push({ x: L[0] + (k - 1.5) * 40 * ctx.kc, y: L[1] - ctx.card.h / 2 - (20 + 26 * k) * ctx.kc, r: 52 * ctx.kc, a: 0.85 * Math.exp(-tau / 0.75) });
      const amp = 22 * ks * Math.exp(-tau / 0.12);
      F.post.shake = [amp * (U.noise1(tau * 38, 3) - 0.5) * 2, amp * (U.noise1(tau * 38, 7) - 0.5) * 2];
      F.desk.dim = 1 - 0.3 * Math.exp(-tau / 0.45); F.desk.vig = 0.38 * Math.exp(-tau / 0.5);
      if (Hc > 0.01) F.add.push(spr(L[0], L[1], hd * 1.5, hd * 1.25, 0, 0, 1, 0.42, 0.1, 0.32 * Hc));
    }
    trailSparks(F, ctx, pf, st.sparks, t);
    for (const q of st.embers) {
      const age = t - q.tb; if (age < 0 || age > q.life) continue;
      const p = pf(q.tb);
      const b = U.ball(p.x + q.ox * ctx.card.w * p.s, p.y + q.oy * ctx.card.h * p.s, q.vx * ks, q.vy * ks, 1.6, -40 * ks, age);
      const u = age / q.life, k = q.hot * (1 - u) * (0.55 + 0.45 * Math.sin(age * 38 + q.ph));
      F.add.push(spr(b[0], b[1], q.sz, q.sz, 0, 0, k, 0.5 * k, 0.12 * k, 1));
    }
    for (const q of st.smoke) {
      const age = t - q.tb; if (age < 0 || age > q.life) continue;
      const p = pf(q.tb), v = vel(pf, q.tb), sp = Math.hypot(v[0], v[1]) || 1;
      const b = U.ball(p.x - v[0] / sp * hd * p.s * 1.2 + q.ox * 40 * p.s * ctx.kc, p.y - v[1] / sp * hd * p.s * 1.2 + q.oy * 40 * p.s * ctx.kc,
        q.vx * ks - v[0] * 0.06, q.vy * ks - v[1] * 0.06, 1.2, -30 * ks, age);
      const u = age / q.life, sz = (14 + 46 * U.easeOut2(u)) * p.s * q.sz * 1.4 * ctx.kc;
      F.smoke.push(spr(b[0], b[1], sz, sz, 0, 2, 0.1, 0.085, 0.08, 0.26 * Math.pow(1 - u, 1.6) * U.sstep(0, 0.12, u), q.seed, 0));
    }
    if (!pre) {
      for (const q of st.burst) {
        if (tau > q.life) continue;
        const b = U.ball(L[0] + Math.cos(q.ang) * ctx.card.w * 0.45 * q.r0, L[1] + Math.sin(q.ang) * ctx.card.h * 0.45 * q.r0,
          Math.cos(q.ang) * q.sp * ks, Math.sin(q.ang) * q.sp * ks, 2.4, 1300 * ks, tau);
        const u = tau / q.life, c = fireCol(u * 0.9), k = q.hot * Math.pow(1 - u, 1.1);
        F.add.push(spr(b[0], b[1], Math.hypot(b[2], b[3]) * 0.022 + 2.5, q.w, Math.atan2(b[3], b[2]), 1, c[0] * k, c[1] * k, c[2] * k, 1));
      }
      for (const q of st.bembers) {
        if (tau > q.life) continue;
        const b = U.ball(L[0] + Math.cos(q.ang) * ctx.card.w * 0.4 * q.r0, L[1] + Math.sin(q.ang) * ctx.card.h * 0.4 * q.r0,
          Math.cos(q.ang) * q.sp * ks, Math.sin(q.ang) * q.sp * ks, 1.5, 230 * ks, tau);
        const u = tau / q.life, k = q.hot * Math.pow(1 - u, 1.3) * (0.5 + 0.5 * Math.sin(tau * 30 + q.ph));
        F.add.push(spr(b[0], b[1], q.sz, q.sz, 0, 0, k, 0.48 * k, 0.1 * k, 1));
      }
      for (const q of st.bsmoke) {
        const age = tau - q.d; if (age < 0 || age > q.life) continue;
        const b = U.ball(L[0] + q.ox * ctx.card.w, L[1] + q.oy * ctx.card.h, q.vx * ks, q.vy * ks, 0.9, -25 * ks, age);
        const u = age / q.life, sz = (30 + 90 * U.easeOut2(u)) * q.sz * ctx.kc;
        F.smoke.push(spr(b[0], b[1], sz, sz, 0, 2, 0.13, 0.11, 0.1, 0.2 * Math.pow(1 - u, 1.8) * U.sstep(0, 0.08, u), q.seed, 0));
      }
    }
    return F;
  }

  // to the phone: it ignites where it is, swings up into the screen and dives off toward the phone's side, gone as the
  // sound stops (and on along the same line after that, its fire going out)
  function out(t, ctx, st) {
    const F = { under: [], add: [], smoke: [], ribbons: [], desk: { lights: [], shocks: [], haze: [] }, post: {} };
    const P0 = ctx.E, X = ctx.exitX, Y = Math.max(0.06 * ctx.H, P0[1] - 0.3 * ctx.H);
    const C = [P0[0] + ctx.dir * 0.16 * ctx.W, P0[1] - 0.17 * ctx.H];
    const end = [X, Y], v = [2 * (X - C[0]) * 1.6 / OUT, 2 * (Y - C[1]) * 1.6 / OUT];      // its speed as it leaves
    const pf = (x) => {
      const u = U.clamp(x / OUT, 0, 1), e = Math.pow(u, 1.6);
      const p = x <= OUT ? U.bez2(P0, C, end, e) : [X + v[0] * (x - OUT), Y + v[1] * (x - OUT)];
      return { x: p[0], y: p[1], s: U.lerp(1, 0.78, e), rz: U.lerp(0, 0.35 * ctx.dir, e), rx: 0, ry: 0 };
    };
    const H = (x) => U.sstep(0, 0.2, x) * (0.6 + 0.4 * U.clamp(x / OUT, 0, 1)) * (x > OUT ? Math.exp(-(x - OUT) / 0.08) : 1);
    const b = burning(F, ctx, pf, t, H, 0.03, ctx.lite ? 18 : 34);
    F.card = { x: b.p.x, y: b.p.y, s: b.p.s, rz: b.p.rz, shadowK: 0.2 * (1 - U.clamp(t / OUT, 0, 1)), fx: { heat: b.h, hdx: b.dl[0], hdy: b.dl[1], margin: 44 } };
    trailSparks(F, ctx, pf, st.osparks, t);
    F.desk.dim = 1 - 0.18 * b.h; F.desk.vig = 0.25 * b.h;
    return F;
  }

  LOOKS.meteor = { name: 'meteor', title: 'Meteor', HIT, OUT, DUR: 2.45, color: [1, 0.5, 0.16], start, frame, out };
})();
