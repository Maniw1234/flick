'use strict';
/* Volt (sound: Alarm riser, higher pitch: a siren whose wail speeds up, cut dead with an echo after it).
   The screen goes dark and cold. The card crosses it as a charge, jumping from point to point along lightning bolts, the
   jumps coming faster and faster like the siren. Where the sound cuts, a bolt from the sky strikes it down onto the
   desktop; arcs crawl over it while the echo dies away. To the phone: a few quick jumps and it's gone off the edge. */
(function () {
  const LOOKS = (window.FLICK_LOOKS = window.FLICK_LOOKS || {});
  const U = LOOKS.U;
  const spr = U.spr;
  const HIT = 1.2, OUT = 0.75;
  const JT = [0.07, 0.31, 0.51, 0.67, 0.8, 0.9, 0.98, 1.04, 1.09, 1.13, 1.16, 1.183];
  const JO = [0.14, 0.32, 0.47, 0.59, 0.68, OUT];

  function zigzag(E, T, n, ctx, R, last) {
    const P = [E];
    for (let k = 1; k <= n; k++) {
      const u = 1 - Math.pow(1 - k / n, 1.5);
      const zig = (k % 2 ? -1 : 1) * 175 * ctx.ks * Math.pow(1 - u, 0.75);
      const end = k === n;
      const x = U.lerp(E[0], T[0], u) + (end ? 0 : R.r(-30, 30) * ctx.ks * (1 - u));
      const y = U.lerp(E[1], T[1], u) + (end ? 0 : zig);
      P.push([x, end && !last ? y : U.clamp(y, 0.11 * ctx.H, ctx.floorY - 0.16 * ctx.H)]);
    }
    return P;
  }
  function start(ctx) {
    const R = U.rng(ctx.seed);
    const st = {};
    st.P = zigzag([ctx.E[0] + ctx.dir * 30 * ctx.ks, ctx.E[1]], ctx.L, JT.length, ctx, R, false);
    // to the phone: one jump into the screen first, then across and off the edge
    const I = [ctx.E[0] + ctx.dir * 0.14 * ctx.W, U.clamp(ctx.E[1] - 0.08 * ctx.H, 0.11 * ctx.H, ctx.floorY - 0.16 * ctx.H)];
    st.PO = [ctx.E].concat(zigzag(I, [ctx.exitX, ctx.E[1] - 0.12 * ctx.H], JO.length - 1, ctx, R, true));
    const n = (k) => Math.round(k * (ctx.lite ? 0.4 : 1));
    st.burst = Array.from({ length: n(110) }, () => ({ ang: R.r(0, 6.283), sp: R.r(200, 1100), life: R.r(0.25, 0.75), w: R.r(0.8, 1.8), hot: R.r(1.2, 3.0) }));
    st.jsparks = JT.map(() => Array.from({ length: n(14) }, () => ({ ang: R.r(0, 6.283), sp: R.r(120, 600), life: R.r(0.12, 0.35), hot: R.r(1, 2.4) })));
    return st;
  }
  const at = (times, t) => { let k = 0; while (k < times.length && t >= times[k]) k++; return k; };

  // little arcs reaching out from the card's edge, new shapes 30 times a second
  function crackle(out, ctx, x, y, s, t, n, len, k, seedBase) {
    const fr = Math.floor(t * 30), mn = Math.min(ctx.card.w, ctx.card.h);
    for (let i = 0; i < n; i++) {
      const R = U.rng(seedBase + fr * 31 + i * 7);
      const ang = R.r(0, 6.283), ex = Math.cos(ang), ey = Math.sin(ang);
      const r0 = mn * 0.5 * s;
      const ax = x + ex * r0 * R.r(0.8, 1.2) * (ctx.card.w / mn) * 0.9, ay = y + ey * r0 * R.r(0.8, 1.2);
      const l = len * R.r(0.5, 1.2);
      const segs = U.bolt(ax, ay, ax + ex * l + R.r(-20, 20) * ctx.kc, ay + ey * l + R.r(-20, 20) * ctx.kc, seedBase + fr * 13 + i, { depth: 4, rough: 0.3, branch: 0.25, w: 0.8 });
      U.boltSprites(out, segs, 0.9, 9 * ctx.kc, 2.2 * k * R.r(0.6, 1.1), [0.75, 0.88, 1.0]);
    }
  }
  // the charge between jumps, the bolts it jumped along (fading), the ghost it left, sparks where it arrived
  function jumping(F, ctx, st, P, times, t, look) {
    const k = at(times, t), p = P[Math.min(k, P.length - 1)];
    const fl = U.feat('volt', 'flux', look ? t : t + HIT - OUT), cen = U.feat('volt', 'cen', look ? t : t + HIT - OUT);
    const since = t - (k > 0 ? times[k - 1] : 0);
    const R = U.rng(Math.floor(t * 60) + 5);
    const s = 0.74, ks = ctx.ks;
    const blink = k > 0 && since < 1 / 60;
    F.card = { x: p[0] + R.r(-2.5, 2.5) * ctx.kc, y: p[1] + R.r(-2.5, 2.5) * ctx.kc, s, rz: R.r(-0.03, 0.03), op: blink ? 0.35 : 1, shadowK: 0.3,
      fx: { elec: 0.75 + 0.25 * fl, sat: 0.55, scan: 0.45, margin: 30, tint: [0.92, 0.98, 1.12] } };
    const pulse = 0.55 + 0.45 * fl;
    F.under.push(spr(p[0], p[1], ctx.hd * s * 1.6, ctx.hd * s * 1.6, 0, 0, 0.35, 0.55, 1.0, 0.16 * pulse));
    crackle(F.add, ctx, p[0], p[1], s, t, 3 + Math.round(3 * fl), (46 + 40 * cen) * ctx.kc, 0.9 + 0.6 * fl, 100);
    F.desk.lights.push({ x: p[0], y: p[1], r: 300 * ks, i: 0.55 + 0.35 * pulse, c: [0.45, 0.65, 1.0] });
    let flash = 0;
    for (let j = Math.max(0, k - 3); j < k; j++) {
      const age = t - times[j];
      if (age > 0.11) continue;
      const a = P[j], b = P[j + 1];
      const vis = age < 0.035 ? 1 : Math.exp(-(age - 0.035) / 0.03);
      const segs = U.bolt(a[0], a[1], b[0], b[1], ctx.seed + 300 + j * 17 + (age < 0.035 ? 0 : 1), { depth: ctx.lite ? 5 : 6, rough: 0.24, branch: 0.4, w: 1.15 });
      U.boltSprites(F.add, segs, 1.3, 16 * Math.sqrt(ks), 3.2 * vis, [0.8, 0.9, 1.0]);
      if (age < 0.05) flash = Math.max(flash, 1 - age / 0.05);
      F.desk.lights.push({ x: (a[0] + b[0]) / 2, y: (a[1] + b[1]) / 2, r: 380 * ks, i: 0.75 * vis, c: [0.55, 0.72, 1.0] });
      if (j === k - 1 && age < 0.07) (F.ghosts = F.ghosts || []).push({ x: a[0], y: a[1], s, op: 0.55 * Math.exp(-age / 0.05), add: true,
        fx: { elec: 0.8, sat: 0, chan: [0.35, 0.6, 1.0], tint: [0.6, 0.8, 1.2], margin: 30 } });
      const sp = st.jsparks[j % st.jsparks.length];
      for (const q of sp) {
        if (age > q.life) continue;
        const bb = U.ball(b[0], b[1], Math.cos(q.ang) * q.sp * ks, Math.sin(q.ang) * q.sp * ks, 3, 500 * ks, age);
        const u = age / q.life, kk = q.hot * (1 - u);
        F.add.push(spr(bb[0], bb[1], Math.hypot(bb[2], bb[3]) * 0.02 + 2, 1.1, Math.atan2(bb[3], bb[2]), 1, 0.7 * kk, 0.85 * kk, 1.0 * kk, 1));
      }
    }
    F.post.full = [0.08 * flash, 0.1 * flash, 0.16 * flash];
  }

  function frame(t, ctx, st) {
    const F = { under: [], add: [], smoke: [], ribbons: [], desk: { lights: [], shocks: [] }, post: {} };
    const { L, ks, hd } = ctx, tau = t - HIT;
    const storm = t < HIT ? U.sstep(0, 0.16, t) : Math.exp(-tau / 0.28);
    F.desk.dim = 1 - 0.5 * storm; F.desk.sat = 1 - 0.55 * storm; F.desk.tint = [1 - 0.22 * storm, 1 - 0.1 * storm, 1 + 0.12 * storm]; F.desk.vig = 0.45 * storm;
    if (t < HIT) {
      jumping(F, ctx, st, st.P, JT, t, true);
      const sh = 3 * ks * U.sstep(0.9, HIT, t);
      F.post.shake = [sh * (U.noise1(t * 50, 3) - 0.5) * 2, sh * (U.noise1(t * 50, 9) - 0.5) * 2];
      return F;
    }
    // ---- the strike, then the echo
    const on = tau < 0.05 ? 1 : tau < 0.075 ? 0 : tau < 0.13 ? 0.75 : 0.75 * Math.exp(-(tau - 0.13) / 0.04);
    const segs = U.bolt(L[0] - ctx.dir * 70 * ks, -30, L[0], L[1] - 4, ctx.seed + (tau < 0.075 ? 777 : 778), { depth: ctx.lite ? 6 : 7, rough: 0.2, branch: 0.55, w: 1.6 });
    if (on > 0.01) U.boltSprites(F.add, segs, 1.7, 24 * Math.sqrt(ks), 3.0 * on, [0.85, 0.93, 1.0]);
    const ff = 0.4 * Math.exp(-tau / 0.02) + (tau > 0.075 ? 0.16 * Math.exp(-(tau - 0.075) / 0.02) : 0);
    F.post.full = [ff * 0.7, ff * 0.82, ff];
    F.post.flash = { x: L[0], y: L[1], r: 340 * ks, i: 0.75 * Math.exp(-tau / 0.07), c: [0.6, 0.78, 1.0] };
    F.desk.lights.push({ x: L[0], y: L[1] - 120 * ks, r: 520 * ks, i: 1.0 * on + 0.3 * Math.exp(-tau / 0.25), c: [0.55, 0.72, 1.0] });
    const r1 = 820 * ks * (1 - Math.exp(-tau / 0.26));
    F.desk.shocks.push({ x: L[0], y: L[1], r: r1, s: 13 * ks * Math.exp(-tau / 0.24), w: (26 + 50 * tau) * ks });
    if (tau < 0.35) F.add.push(spr(L[0], L[1], r1 / 0.86 + 1, r1 / 0.86 + 1, 0, 3, 0.6, 0.8, 1.0, 0.9 * Math.exp(-tau / 0.1), 0.02));
    const amp = 13 * ks * Math.exp(-tau / 0.08);
    F.post.shake = [amp * (U.noise1(tau * 45, 3) - 0.5) * 2, amp * (U.noise1(tau * 45, 9) - 0.5) * 2];
    const el = Math.exp(-tau / 0.26);
    F.card = { x: L[0], y: L[1], s: 1 + 0.06 * U.spring(tau, 7, 0.32), rz: 0, landed: true,
      fx: { elec: el, sat: 1 - 0.45 * el, scan: 0.45 * el, margin: 30, tint: [1 - 0.08 * el, 1 - 0.02 * el, 1 + 0.12 * el] } };
    if (tau < 0.42) {
      const k = Math.exp(-tau / 0.13);
      crackle(F.add, ctx, L[0], L[1], 1, tau, Math.max(1, Math.round(6 * k)), (40 + 30 * k) * ctx.kc, 1.3 * k, 900);
      const fr = Math.floor(tau * 30), w = ctx.card.w / 2, h = ctx.card.h / 2;
      for (let i = 0; i < 3; i++) {
        const R = U.rng(5000 + fr * 11 + i);
        const A = R.pick([[-w, R.r(-h, h)], [w, R.r(-h, h)], [R.r(-w, w), -h], [R.r(-w, w), h]]);
        const B = R.pick([[-w, R.r(-h, h)], [w, R.r(-h, h)], [R.r(-w, w), -h], [R.r(-w, w), h]]);
        U.boltSprites(F.add, U.bolt(L[0] + A[0], L[1] + A[1], L[0] + B[0], L[1] + B[1], 7000 + fr * 5 + i, { depth: 5, rough: 0.28, branch: 0.2, w: 0.8 }), 0.9, 9 * ctx.kc, 2.4 * k, [0.8, 0.9, 1.0]);
      }
    }
    for (const q of st.burst) {
      if (tau > q.life) continue;
      const b = U.ball(L[0], L[1], Math.cos(q.ang) * q.sp * ks, (Math.sin(q.ang) * q.sp - 150) * ks, 2.6, 900 * ks, tau);
      const u = tau / q.life, kk = q.hot * Math.pow(1 - u, 1.2);
      F.add.push(spr(b[0], b[1], Math.hypot(b[2], b[3]) * 0.02 + 2, q.w, Math.atan2(b[3], b[2]), 1, 0.7 * kk, 0.85 * kk, 1.0 * kk, 1));
    }
    F.under.push(spr(L[0], L[1], hd * 1.9, hd * 1.9, 0, 0, 0.4, 0.6, 1.0, 0.3 * el));
    return F;
  }

  // to the phone: a few quick jumps along bolts, the last one off the edge as the sound cuts
  function out(t, ctx, st) {
    const F = { under: [], add: [], smoke: [], ribbons: [], desk: { lights: [], shocks: [] }, post: {} };
    const storm = U.sstep(0, 0.12, t) * (1 - U.sstep(OUT, OUT + 0.25, t));
    F.desk.dim = 1 - 0.35 * storm; F.desk.sat = 1 - 0.4 * storm; F.desk.tint = [1 - 0.15 * storm, 1 - 0.07 * storm, 1 + 0.1 * storm]; F.desk.vig = 0.3 * storm;
    jumping(F, ctx, st, st.PO, JO, Math.min(t, OUT + 0.11), false);
    if (t >= OUT) F.card = null;
    return F;
  }

  LOOKS.volt = { name: 'volt', title: 'Volt', HIT, OUT, DUR: 1.95, color: [0.55, 0.78, 1.0], start, frame, out };
})();
