'use strict';
/* Glitch (sound: Trap riser, same pitch: a snare roll that speeds up under a rising tone, peaks, then thins out into
   single hits). The card crosses the screen like a lagging video stream: it holds, skips ahead, leaves frozen
   colour-split copies behind; the skips come faster and the colours tear wider as the tone climbs. At the peak the
   whole screen breaks up for three frames and snaps clean with the card in place; the last hits make it twitch.
   To the phone: it stutters toward the phone's side, faster and faster, and breaks up off the edge. */
(function () {
  const LOOKS = (window.FLICK_LOOKS = window.FLICK_LOOKS || {});
  const U = LOOKS.U;
  const spr = U.spr;
  const HIT = 1.2, OUT = 0.75;
  const RED = [1, 0.22, 0.35], CYAN = [0.2, 0.9, 1.0];
  const FRAG = [[1, 1, 1], [0.3, 0.95, 1], [1, 0.25, 0.75], [1, 0.9, 0.3]];

  function schedule(R, end, a, b) {
    const h = [0];
    while (h[h.length - 1] < end - 0.03) {
      const x = h[h.length - 1];
      h.push(x + U.lerp(a, b, Math.pow(x / end, 1.1)) * R.r(0.75, 1.25));
    }
    h[h.length - 1] = end;
    return h;
  }
  function start(ctx) {
    const R = U.rng(ctx.seed);
    const st = {};
    st.C1 = [ctx.E[0] + ctx.dir * 260 * ctx.ks, ctx.E[1] - 170 * ctx.ks];
    st.holds = schedule(R, HIT, 0.105, 0.03);
    st.oholds = schedule(R, OUT, 0.085, 0.028);
    // to the phone: a loop up into the screen, then off the edge
    st.OE = [ctx.exitX, Math.max(0.1 * ctx.H, ctx.E[1] - 0.1 * ctx.H)];
    st.OC = [ctx.E[0] + ctx.dir * 0.2 * ctx.W, ctx.E[1] - 0.16 * ctx.H];
    st.frag = Array.from({ length: Math.round(56 * (ctx.lite ? 0.5 : 1)) }, () => ({ ang: R.r(0, 6.283), sp: R.r(150, 900), life: R.r(0.18, 0.5), w: R.r(3, 11), h: R.r(2, 6), c: R.pick(FRAG) }));
    return st;
  }
  const holdIdx = (holds, t) => { let k = 0; while (k + 1 < holds.length && t >= holds[k + 1]) k++; return k; };

  // the stream lagging along a path: hold, skip, frozen copies behind, tears in the desktop, blocks spat out on a skip
  function stutter(F, ctx, holds, path, scaleAt, t, ts, end) {
    const { ks, kc, hd } = ctx;
    const pitch = U.feat('glitch', 'pitch', ts), env = U.feat('glitch', 'env', ts), flux = U.feat('glitch', 'flux', ts);
    const fr = Math.floor(t * 60);
    const k = holdIdx(holds, t), h = holds[k], since = t - h;
    const p = path(h);
    const burst = since < 0.034;                       // the two frames after a skip
    const R = U.rng(fr * 13 + 7 + ctx.seed);
    const grow = Math.pow(U.clamp(t / end, 0, 1), 1.2);
    F.card = { x: p[0], y: p[1], s: scaleAt(h), rz: 0, shadowK: 0.5,
      fx: { rgb: (2 + 9 * pitch) * (burst ? 1.8 : 1) * kc, gl: burst ? 0.55 : 0.08 * flux, seed: fr * 1.7, slices: 12 + Math.floor(R() * 10),
        scan: 0.25 + 0.35 * env, mosaic: burst ? [0.35, 10 + Math.floor(R() * 8), fr, 0] : [0, 0, 0, 0], margin: 22,
        glow: (k % 2 ? [1, 0.25, 0.7] : [0.25, 0.9, 1]).concat([0.55 + 0.6 * grow]), bright: 0.05 } };
    F.ghosts = [];
    for (let j = Math.max(0, k - 3); j < k; j++) {
      const age = t - holds[j + 1];
      if (age > 0.17) continue;
      const q = path(holds[j]);
      F.ghosts.push({ x: q[0] + (j % 2 ? 10 : -10) * kc, y: q[1], s: scaleAt(holds[j]), op: 0.75 * (1 - age / 0.17), add: true,
        fx: { chan: j % 2 ? RED : CYAN, rgb: 6 * kc, gl: 0.4, seed: j * 3.3, slices: 9, margin: 10 } });
    }
    const nb = burst ? 3 + Math.floor(R() * 3) : (R() < 0.25 + 0.5 * grow ? 1 : 0);
    for (let i = 0; i < nb; i++) {
      const y0 = p[1] + R.r(-1, 1) * ctx.card.h * 0.9, hh = R.r(3, 18) * kc;
      F.desk.bands.push({ y0, y1: y0 + hh, off: R.r(-1, 1) * (burst ? 36 : 12) * (0.4 + grow) * ks, rgb: R.r(2, 7) * ks });
    }
    if (burst) for (let i = 0; i < 6; i++) {
      const c = R.pick([[1, 1, 1], CYAN, RED]), k2 = 0.9 + 0.8 * grow;
      F.add.push(spr(p[0] + R.r(-1, 1) * hd * 1.1, p[1] + R.r(-1, 1) * hd * 0.8, R.r(3, 14) * kc, R.r(1.5, 4) * kc, 0, 7, c[0] * k2, c[1] * k2, c[2] * k2, 0.7));
    }
    F.desk.dim = 1 - 0.18 * grow; F.desk.vig = 0.3 * grow;
    if (burst) F.post.ca = { x: p[0], y: p[1], a: (10 + 18 * grow) * ks };
    const sh = burst ? 3 * grow * ks : 0;
    F.post.shake = [sh * (R() - 0.5) * 2, 0];
    return { p, burst, R, fr };
  }

  // the screen breaking up for three frames (lvl 1, 0.7, 0.4)
  function breakUp(F, ctx, tau, fr, k) {
    if (tau >= 0.05) return;
    const R = U.rng(fr * 31 + 3 + ctx.seed);
    const lvl = (tau < 0.017 ? 1 : tau < 0.034 ? 0.7 : 0.4) * k;
    F.post.gl = { a: lvl, seed: fr * 2.3 + 1, block: R.r(14, 30) * ctx.ks, inv: tau < 0.017 ? k : tau < 0.034 ? 0.45 * k : 0 };
    for (let i = 0; i < 10; i++) { const y0 = R.r(0, ctx.H), hh = R.r(6, 60) * ctx.ks; F.desk.bands.push({ y0, y1: y0 + hh, off: R.r(-1, 1) * 90 * lvl * ctx.ks, rgb: R.r(4, 12) * lvl * ctx.ks }); }
    F.post.full = [0.07 * lvl, 0.02 * lvl, 0.09 * lvl];
  }

  function frame(t, ctx, st) {
    const F = { under: [], add: [], smoke: [], ribbons: [], desk: { lights: [], shocks: [], bands: [] }, post: {} };
    const { L, ks, kc, hd } = ctx, tau = t - HIT;
    const path = (x) => U.bez2(ctx.E, st.C1, L, 1 - Math.pow(1 - U.clamp(x / HIT, 0, 1), 1.6));
    if (t < HIT) {
      stutter(F, ctx, st.holds, path, (x) => U.lerp(0.82, 1, Math.pow(U.clamp(x / HIT, 0, 1), 1.2)), t, t, HIT);
      return F;
    }
    // ---- the drop: three broken frames, then clean
    const fr = Math.floor(t * 60), R = U.rng(fr * 31 + 3 + ctx.seed);
    const flux = U.feat('glitch', 'flux', t);
    breakUp(F, ctx, tau, fr, 1);
    F.post.ca = { x: L[0], y: L[1], a: 46 * ks * Math.exp(-tau / 0.06) };
    const amp = 12 * ks * Math.exp(-tau / 0.06);
    F.post.shake = [amp * (U.noise1(tau * 60, 3) - 0.5) * 2, amp * 0.3 * (U.noise1(tau * 60, 9) - 0.5) * 2];
    // the last hits: twitches that die away
    const dec = Math.exp(-tau / 0.2), hit = flux > 0.55 ? 1 : 0;
    const jx = hit * dec * R.r(-4, 4) * kc;
    F.card = { x: L[0] + jx, y: L[1], s: 1 + 0.11 * U.spring(tau, 6, 0.4), rz: 0, landed: true,
      fx: { rgb: (14 * Math.exp(-tau / 0.08) + 4 * hit * dec) * kc, gl: tau < 0.05 ? 0.6 : 0.3 * hit * dec, seed: fr * 1.3, slices: 10, scan: 0.3 * dec, margin: 20 } };
    if (hit && dec > 0.08) {
      const y0 = L[1] + R.r(-0.5, 0.5) * ctx.card.h;
      F.desk.bands.push({ y0, y1: y0 + R.r(2, 8) * kc, off: R.r(-1, 1) * 14 * dec * ks, rgb: 5 * dec * ks });
    }
    for (const q of st.frag) {
      if (tau > q.life) continue;
      const r = q.sp * ks * (1 - Math.exp(-tau * 6));
      const u = tau / q.life, k = 1.4 * (1 - u);
      const x = L[0] + Math.cos(q.ang) * (hd * 0.6 + r), y = L[1] + Math.sin(q.ang) * (hd * 0.45 + r * 0.6);
      F.add.push(spr(Math.round(x / 4) * 4, Math.round(y / 4) * 4, q.w * kc, q.h * kc, 0, 7, q.c[0] * k, q.c[1] * k, q.c[2] * k, 0.85));
    }
    return F;
  }

  // to the phone: skips toward the phone's side, faster and faster; breaks up and is gone as the sound peaks
  function out(t, ctx, st) {
    const F = { under: [], add: [], smoke: [], ribbons: [], desk: { lights: [], shocks: [], bands: [] }, post: {} };
    const path = (x) => U.bez2(ctx.E, st.OC, st.OE, Math.pow(U.clamp(x / OUT, 0, 1), 1.5));
    if (t < OUT) {
      const r = stutter(F, ctx, st.oholds, path, (x) => U.lerp(1, 0.86, U.clamp(x / OUT, 0, 1)), t, t + HIT - OUT, OUT);
      if (t > OUT - 0.07) {                             // breaking up
        const u = (t - (OUT - 0.07)) / 0.07;
        F.card.fx.mosaic = [0.3 + 0.6 * u, 8 + Math.floor(r.R() * 6), r.fr, 0];
        F.card.fx.gl = 0.5 + 0.5 * u;
        F.card.op = 1 - 0.6 * u;
      }
      return F;
    }
    const tau = t - OUT, fr = Math.floor(t * 60);
    breakUp(F, ctx, tau, fr, 0.55);
    return F;
  }

  LOOKS.glitch = { name: 'glitch', title: 'Glitch', HIT, OUT, DUR: 1.75, color: [1.0, 0.3, 0.75], start, frame, out };
})();
