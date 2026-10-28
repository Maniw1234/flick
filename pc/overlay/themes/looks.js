'use strict';
/* Flick overlay: the animations Meteor, Volt, Warp and Glitch (looks/*.js), and "Surprise me" (one of them at random for
   each flick). A look is worked out from the time since the flick alone and is timed to its sound (sounds/<look>.wav: its
   big moment is where the card lands, or where it leaves for the phone). fx2.js draws it, with the desktop photo bent,
   dimmed and lit under it. The card a look flies is drawn here (hiddenOnPC) until the look is over; after that the
   overlay draws it as usual (the icon, a fade). Several flicks at once each play their own look, drawn as one frame. */
(function () {
  const THEMES = (window.FLICK_THEMES = window.FLICK_THEMES || {});
  const LOOKS = window.FLICK_LOOKS || {};
  const U = LOOKS.U;
  const R = window.GFX, X = window.FX2, A = window.SFX;
  const spr = U.spr;
  const NAMES = ['meteor', 'volt', 'warp', 'glitch'];
  const okName = (n) => (typeof n === 'string' && NAMES.includes(n) && LOOKS[n] ? n : null);

  const plays = [];                       // the looks playing: see play()
  const edge = { k: 0, y: 0, col: [1, 1, 1], look: null };   // the glow at the phone's edge (a card coming, a hold)
  let conn = null;                        // the light of a phone connecting: { t0, y }
  const notes = [];                       // "<phone> connected"
  let cur = null;                         // this frame (drawBackground → drawUnder → drawOver)
  let E0 = null;
  let lastPick = null;
  // A slow PC gets the light version (no bloom or heat haze, smaller buffers, fewer sparks) for the rest of the session:
  // measured over the first looks' frames (the first few, which may wait on the GPU warming up, aren't counted).
  const perf = { lite: false, frames: 0, sum: 0, n: 0, looks: 0 };
  const isLite = (E) => perf.lite || !!E.S.reduceFx;

  // ---------------------------------------------------------------- which look
  function themeLook(E) { const th = E.S.theme; return okName(th) || (th === 'surprise' ? 'surprise' : 'meteor'); }
  // the look for a flick: the one the phone chose (Surprise me picks on the phone), else this PC's setting
  function pick(E, want) {
    const w = okName(want);
    if (w) { lastPick = w; return w; }
    const th = themeLook(E);
    if (th !== 'surprise') return th;
    const opts = NAMES.filter((n) => n !== lastPick && LOOKS[n]);
    lastPick = opts[Math.floor(Math.random() * opts.length)] || 'meteor';
    return lastPick;
  }
  const colorOf = (name) => (okName(name) ? LOOKS[name].color : [0.86, 0.82, 1.0]);

  // ---------------------------------------------------------------- a look playing
  function makeCtx(E, c, from, to) {
    const S = E.S, hd = Math.hypot(c.w, c.h) / 2;
    return {
      E: from, L: to, W: S.W, H: S.H, ks: S.H / 792, kc: hd / 148, dir: E.dirIn(), card: { w: c.w, h: c.h }, hd,
      lite: isLite(E), seed: (Math.random() * 1e9) >>> 0, floorY: E.floorY(), r0: 0,
      exitX: S.side === 'right' ? S.W + hd * 1.3 : -hd * 1.3,
    };
  }
  // out: the card leaves for the phone (look.out); otherwise it flies in from the phone and lands (look.frame).
  // The picture waits as long as the sound takes to be heard, so they meet.
  function play(E, c, name, out, from, to) {
    const look = LOOKS[name];
    const ctx = makeCtx(E, c, from, to);
    ctx.r0 = out ? 0 : (c.launch && c.launch.r0) || 0;
    let st;
    try { st = look.start(ctx); } catch (e) { console.log('look ' + name + ' failed to start: ' + e.message); return null; }
    const p = { name, look, ctx, st, out, card: c, t0: performance.now() + A.latency() * 1000, end: out ? look.OUT + 0.45 : look.DUR,
      F: null, Ft: -1, t: 0, kill: 0, enter: null };
    if (!out) {
      const L = c.launch || {};
      p.enter = { x: c.pose.x, y: c.pose.y, rz: c.pose.rz || 0, s: c.pose.sx || 1, vx: L.vx || 0, vy: L.vy || 0 };
    }
    // several cards at once (files sent together, a burst of flicks): one sound for the lot, not one each
    p.at = performance.now();
    if (!plays.some((q) => q.out === out && q.snd && p.at - q.at < 600)) p.snd = A.play(name, { offset: out ? look.HIT - look.OUT : 0 });
    plays.push(p);
    c.play = p;
    // (drawn here; if the graphics for the looks couldn't be set up, the overlay draws the card on the look's path)
    c.hiddenOnPC = X.ready();
    c.look = name;
    return p;
  }
  const EMPTY = () => ({ under: [], add: [], smoke: [], ribbons: [], desk: {}, post: {} });
  function frameOf(p, now) {
    if (p.Ft === now && p.F) return p.F;
    const t = Math.max(0, (now - p.t0) / 1000);
    let F = null;
    try { F = p.out ? p.look.out(t, p.ctx, p.st) : p.look.frame(t, p.ctx, p.st); } catch (e) {
      console.log('look ' + p.name + ' failed: ' + e.message);
      if (!p.kill) p.kill = now;
    }
    p.F = F || EMPTY(); p.Ft = now; p.t = t;
    return p.F;
  }
  // the card where the look has it (flying in, resting, leaving)
  function poseFrom(p, c, now) {
    const F = frameOf(p, now), k = F.card, t = p.t;
    if (!k) { c.opacity = 0; return F; }
    let s = k.s == null ? 1 : k.s, rz = k.rz || 0, x = k.x, y = k.y;
    // the first moments carry on from how it left the phone (its size, its tilt) into the look's own
    if (p.enter && p.look.enter !== 'away' && t < 0.12) {
      const e = U.sstep(0, 0.12, t);
      x = U.lerp(p.enter.x, x, e); y = U.lerp(p.enter.y, y, e); s = U.lerp(p.enter.s, s, e); rz = U.lerp(p.enter.rz, rz, e);
    }
    const P = c.pose;
    P.x = x; P.y = y; P.z = 0; P.rx = k.rx || 0; P.ry = k.ry || 0; P.rz = rz; P.sx = P.sy = s;
    c.shadowK = k.shadowK == null ? 1 : k.shadowK;
    c.opacity = k.op == null ? 1 : k.op;
    return F;
  }
  // a look is over: its card (if it's still here) goes back to the overlay
  function finish(p) {
    const c = p.card;
    if (c && c.play === p) {
      c.play = null; c.hiddenOnPC = false;
      if (!c.gone && !p.out) { c.opacity = 1; c.shadowK = 1; }
    }
    if (p.snd && p.kill) p.snd.stop();
  }

  // ---------------------------------------------------------------- one frame, from every look playing
  function merge(E, now) {
    const M = { under: [], add: [], smoke: [], ribbons: [], wantDesk: false,
      desk: { lights: [], shocks: [], haze: [], bands: [], dim: 1, sat: 1, vig: 0, tint: [1, 1, 1], warp: null, scorch: null },
      post: { shake: [0, 0], flash: null, full: [0, 0, 0], ca: null, gl: null } };
    const D = M.desk, P = M.post;
    const add = (F, k) => {
      if (!F || k <= 0.001) return;
      for (const key of ['under', 'add', 'smoke', 'ribbons']) if (F[key] && F[key].length) {
        if (k >= 0.999) for (const s of F[key]) M[key].push(s);
        else if (key === 'ribbons') for (const r of F[key]) M.ribbons.push({ pts: r.pts.map((q) => ({ x: q.x, y: q.y, w: q.w, k: q.k * k })), seed: r.seed, kind: r.kind });
        else for (const s of F[key]) M[key].push(Object.assign({}, s, { al: (s.al == null ? 1 : s.al) * k }));
      }
      const d = F.desk || {}, po = F.post || {};
      if (d.lights) for (const l of d.lights) D.lights.push(k >= 0.999 ? l : Object.assign({}, l, { i: l.i * k }));
      if (d.shocks) for (const s of d.shocks) D.shocks.push(k >= 0.999 ? s : Object.assign({}, s, { s: s.s * k }));
      if (d.haze) for (const h of d.haze) D.haze.push(k >= 0.999 ? h : Object.assign({}, h, { a: h.a * k }));
      if (d.bands) for (const b of d.bands) D.bands.push(k >= 0.999 ? b : Object.assign({}, b, { off: b.off * k, rgb: (b.rgb || 0) * k }));
      if (d.dim != null) D.dim *= U.lerp(1, d.dim, k);
      if (d.sat != null) D.sat *= U.lerp(1, d.sat, k);
      if (d.vig) D.vig = Math.max(D.vig, d.vig * k);
      if (d.tint) for (let i = 0; i < 3; i++) D.tint[i] *= U.lerp(1, d.tint[i], k);
      if (d.warp && (!D.warp || d.warp.blur * k + Math.abs(d.warp.zoom) * k > D.warp.blur + Math.abs(D.warp.zoom))) {
        D.warp = { x: d.warp.x, y: d.warp.y, blur: d.warp.blur * k, zoom: d.warp.zoom * k, ca: (d.warp.ca || 0) * k };
      }
      if (d.scorch && (!D.scorch || d.scorch.a * k > D.scorch.a)) D.scorch = Object.assign({}, d.scorch, { a: d.scorch.a * k, g: (d.scorch.g || 0) * k });
      if (po.shake) { P.shake[0] += po.shake[0] * k; P.shake[1] += po.shake[1] * k; }
      if (po.flash && (!P.flash || po.flash.i * k > P.flash.i)) P.flash = Object.assign({}, po.flash, { i: po.flash.i * k });
      if (po.full) for (let i = 0; i < 3; i++) P.full[i] += po.full[i] * k;
      if (po.ca && (!P.ca || po.ca.a * k > P.ca.a)) P.ca = Object.assign({}, po.ca, { a: po.ca.a * k });
      if (po.gl && (!P.gl || po.gl.a * k > P.gl.a)) P.gl = Object.assign({}, po.gl, { a: po.gl.a * k, inv: (po.gl.inv || 0) * k });
    };
    // (drawn by the processor, without a graphics chip: no desktop photo, nothing over the whole screen)
    const photo = R.desk.ok && !X.software;
    for (const p of plays) {
      const F = frameOf(p, now);
      // it settles back to the plain desktop at its end (or quickly, when it was called off)
      let k = 1 - U.sstep(p.end - 0.3, p.end, p.t);
      if (p.kill) k = Math.min(k, 1 - U.sstep(0, 220, now - p.kill));
      add(F, k);
      M.wantDesk = photo;
    }
    if (X.software) { D.dim = 1; D.vig = 0; D.lights.length = 0; }
    // (several at once add up, but never to a white screen or a shake that throws the desktop about)
    for (let i = 0; i < 3; i++) P.full[i] = Math.min(P.full[i], 0.75);
    const sh = Math.hypot(P.shake[0], P.shake[1]), most = 26 * E.S.H / 792;
    if (sh > most) { P.shake[0] *= most / sh; P.shake[1] *= most / sh; }
    edgeFx(M, E, now);
    connFx(M, E, now);
    if (plays.length && !photo) asLight(M, E);
    return M;
  }

  // Without a desktop photo (macOS without Screen Recording, Wayland, no graphics chip) the screen can't be torn or
  // bent: the tears are drawn as light instead
  const TEAR = [[0.25, 0.9, 1.0], [1.0, 0.25, 0.7]];
  function asLight(M, E) {
    const W = E.S.W;
    M.desk.bands.forEach((b, i) => {
      const h = Math.max(1, (b.y1 - b.y0) / 2), c = TEAR[i % 2], a = Math.min(0.35, 0.06 + Math.abs(b.rgb || 0) * 0.02 + Math.abs(b.off) * 0.002);
      M.add.push(spr(W / 2 + b.off, (b.y0 + b.y1) / 2, W / 2, h, 0, 7, c[0], c[1], c[2], a));
    });
    const g = M.post.gl;
    if (g && g.a > 0.01) {
      const Rn = U.rng(Math.floor(g.seed * 977) + 5), H = E.S.H, bl = g.block || 20;
      for (let i = 0; i < 26; i++) {
        const c = Rn.pick([[1, 1, 1], TEAR[0], TEAR[1]]);
        M.add.push(spr(Rn.r(0, W), Rn.r(0, H), bl * Rn.r(0.6, 3.5), bl * Rn.r(0.2, 0.6), 0, 7, c[0], c[1], c[2], 0.45 * g.a));
      }
    }
  }

  // ---------------------------------------------------------------- a card coming (or a hold): the phone's edge glows
  // in the look's colour, with a little of the look (embers, sparks, streaks, a flicker)
  function edgeFx(M, E, now) {
    const k = edge.k;
    if (k < 0.004) return;
    const S = E.S, ks = S.H / 792, x = E.edgeX(), dir = E.dirIn(), y = edge.y, time = now / 1000;
    let name = edge.look, col = edge.col;
    if (name === 'surprise') {
      // no look chosen yet: the glow goes round all four colours
      const u = time / 0.9, i = Math.floor(u), f = U.sstep(0, 1, u - i);
      const a = colorOf(NAMES[i % 4]), b = colorOf(NAMES[(i + 1) % 4]);
      col = [U.lerp(a[0], b[0], f), U.lerp(a[1], b[1], f), U.lerp(a[2], b[2], f)];
      name = null;
    }
    const span = Math.min(S.H * 0.42, (E.phoneH ? E.phoneH() : S.H * 0.6) * 0.5);
    M.under.push(spr(x, y, (40 + 110 * k) * ks, (70 + 200 * k) * ks, 0, 0, col[0], col[1], col[2], 0.45 * k));
    M.add.push(spr(x + dir * 1.5, y, (50 + 150 * k) * ks, 9, Math.PI / 2, 4, col[0] * 1.6, col[1] * 1.6, col[2] * 1.6, 0.85 * k, 1.1, 1));
    if (name === 'meteor') {
      for (let i = 0; i < 16; i++) {
        const h = U.hash(i * 7.31 + 1), ph = U.fract(time * (0.55 + h * 0.7) + h * 5.3);
        const ex = x + dir * (3 + ph * (30 + 50 * h) * ks), ey = y + (U.hash(i * 3.17) - 0.5) * span * 1.2 * k - ph * 46 * ks;
        const a = k * (1 - ph) * U.sstep(0, 0.12, ph) * (0.6 + 0.5 * Math.sin(time * 30 + i));
        M.add.push(spr(ex, ey, 1.4 + 1.6 * h, 1.4 + 1.6 * h, 0, 0, 1.6 * a, 0.75 * a, 0.2 * a, 1));
      }
    } else if (name === 'volt') {
      const fr = Math.floor(time * 12), n = k > 0.5 ? 2 : 1;
      for (let i = 0; i < n; i++) {
        const Rn = U.rng(fr * 31 + i * 7 + 3);
        if (Rn() > 0.35 + 0.6 * k) continue;
        const ay = y + Rn.r(-1, 1) * span * 0.9 * k, segs = U.bolt(x, ay, x + dir * Rn.r(26, 70) * ks, ay + Rn.r(-40, 40) * ks, fr * 13 + i, { depth: 4, rough: 0.3, branch: 0.3, w: 0.8 });
        U.boltSprites(M.add, segs, 0.8, 7, 2.2 * k * Rn.r(0.6, 1.1), [0.75, 0.88, 1.0]);
      }
    } else if (name === 'warp') {
      for (let i = 0; i < 18; i++) {
        const h = U.hash(i * 5.71 + 2), ph = U.fract(time * (1.1 + h * 0.9) + h * 3.1);
        const ang = (dir > 0 ? 0 : Math.PI) + (U.hash(i * 2.3) - 0.5) * 2.6;
        const r1 = (60 + 200 * h) * ks * Math.pow(1 - ph, 1.6) * (0.4 + 0.6 * k), r0 = r1 + (10 + 50 * (1 - ph)) * ks;
        const a = k * U.sstep(0, 0.2, ph) * (1 - U.sstep(0.85, 1, ph)) * 1.4;
        M.add.push(spr(x + Math.cos(ang) * (r0 + r1) / 2, y + Math.sin(ang) * (r0 + r1) / 2 * 0.8, (r0 - r1) / 2 + 1, 1.0, ang, 1, 0.7 * a, 0.62 * a, 1.0 * a, 1));
      }
    } else if (name === 'glitch') {
      const fr = Math.floor(time * 20), Rn = U.rng(fr * 17 + 11), n = Math.round(2 + 6 * k);
      for (let i = 0; i < n; i++) {
        const c = Rn.pick([[1, 1, 1], TEAR[0], TEAR[1]]);
        M.add.push(spr(x + dir * Rn.r(2, 46) * ks, y + Rn.r(-1, 1) * span * 0.8 * k, Rn.r(4, 22) * ks, Rn.r(1, 3.5), 0, 7, c[0], c[1], c[2], 0.55 * k));
      }
      M.under.push(spr(x + 4, y, (30 + 60 * k) * ks, (60 + 150 * k) * ks, 0, 0, TEAR[0][0], TEAR[0][1], TEAR[0][2], 0.18 * k));
      M.under.push(spr(x - 4, y, (30 + 60 * k) * ks, (60 + 150 * k) * ks, 0, 0, TEAR[1][0], TEAR[1][1], TEAR[1][2], 0.18 * k));
    }
  }

  // ---------------------------------------------------------------- a phone connected: a line of light runs along the
  // phone's edge and a flash crosses the screen, in the look's colour
  function connFx(M, E, now) {
    if (!conn) return;
    const t = (now - conn.t0) / 1000;
    if (t < 0) return;
    if (t > 1.0) { conn = null; return; }
    const S = E.S, ks = S.H / 792, x = E.edgeX(), dir = E.dirIn(), y = conn.y, col = conn.col;
    const span = Math.min(S.H * 0.46, (E.phoneH ? E.phoneH() : S.H * 0.6) * 0.5);
    const grow = U.easeOut3(U.clamp(t / 0.3, 0, 1)), fade = 1 - U.sstep(0.35, 1.0, t);
    M.add.push(spr(x + dir * 1.5, y, span * grow + 4, 10, Math.PI / 2, 4, col[0] * 1.8, col[1] * 1.8, col[2] * 1.8, fade, 1.3, 1));
    M.under.push(spr(x, y, 160 * ks, span * (0.6 + 0.6 * grow), 0, 0, col[0], col[1], col[2], 0.55 * fade));
    if (conn.soft) return;                     // (the send shortcut heard: just the edge)
    const head = U.easeOut3(U.clamp(t / 0.55, 0, 1)) * S.W * 0.85;
    const len = Math.min(head, 340 * ks) / 2;
    if (head > 4) M.add.push(spr(x + dir * (head - len), y, len, 2.2, dir > 0 ? 0 : Math.PI, 1, col[0] * 1.5, col[1] * 1.5, col[2] * 1.5, (1 - U.sstep(0.3, 0.7, t))));
    const r = (30 + 520 * U.easeOut3(U.clamp(t / 0.7, 0, 1))) * ks;
    M.add.push(spr(x, y, r / 0.86, r / 0.86, 0, 3, col[0], col[1], col[2], 0.8 * (1 - U.sstep(0.1, 0.8, t)), 0.03));
    M.post.flash = M.post.flash || { x, y, r: 200 * ks, i: 0.5 * Math.exp(-t / 0.08), c: col };
  }
  function note(E, text, y) {
    const el = document.createElement('div');
    el.className = 'note';
    el.textContent = text;
    const dir = E.dirIn(), x = E.edgeX() + dir * 26;
    el.style.transform = `translate3d(${x}px, ${y - 30}px, 0) translateX(${dir < 0 ? '-100%' : '0'})`;
    E.hud.appendChild(el);
    notes.push({ el, t0: performance.now() });
  }

  // ---------------------------------------------------------------- drawing the cards a look flies
  const facePose = (g) => ({ x: g.x, y: g.y, z: 0, rx: g.rx || 0, ry: g.ry || 0, rz: g.rz || 0, sx: g.s == null ? 1 : g.s, sy: g.s == null ? 1 : g.s });
  function drawPlay(E, p) {
    const c = p.card;
    if (!c || c.gone || c.play !== p || c.visible === false) return;
    const F = p.F || EMPTY();
    const face = { w: c.w, h: c.h, radius: c.radius, tex: c.tex, texW: c.texW, texH: c.texH, opacity: 1 };
    // the card it was on the phone, carrying on its way while the look's card takes over (Warp: it comes out of a tunnel)
    if (p.enter && p.look.enter === 'away' && p.t < 0.14) {
      const u = p.t / 0.14, q = p.enter, ms = p.t * 1000;
      const g = { x: q.x + q.vx * ms, y: q.y + q.vy * ms, rz: q.rz, s: q.s * (1 - 0.35 * u) };
      X.drawCard(face, facePose(g), { glow: [0.55, 0.7, 1.0, 0.9 * u], bright: 0.25 * u, margin: 30 }, { op: 1 - U.sstep(0.2, 1, u) });
    }
    if (F.ghosts) for (const g of F.ghosts) X.drawCard(face, facePose(g), g.fx, { add: !!g.add, op: g.op == null ? 1 : g.op });
    const fx = F.card ? F.card.fx : null;
    if (!F.card && (c.state === 'flight' || c.state === 'out')) return;
    if ((c.opacity == null ? 1 : c.opacity) <= 0.002) return;
    E.drawShadowFor(c);
    if (c.sheets && (c.info.count || 1) > 1 && E.sheetsOf) {
      const sfx = fx ? Object.assign({}, fx, { glow: null, margin: Math.min(fx.margin || 30, 20) }) : null;
      for (const s of E.sheetsOf(c)) X.drawCard({ w: c.w, h: c.h, radius: c.radius, tex: s.tex, texW: s.texW, texH: s.texH, opacity: c.opacity, sat: c.sat }, s.pose, sfx, {});
    }
    X.drawCard(c, c.pose, fx, {});
  }

  // ---------------------------------------------------------------- the overlay's hooks
  const theme = {
    name: 'Looks',
    restHold: 0.25,
    init(E) {
      E0 = E;
      edge.y = E.S.anchor * E.S.H;
      try { if (X.init()) X.warm(); } catch (e) { console.log('fx2 init failed: ' + e.message); }
      if (X.software) { perf.lite = true; console.log('looks: no graphics chip, the light version'); }
      A.preload(NAMES);
    },
    reset() {
      for (const p of plays.splice(0)) { if (p.snd) p.snd.stop(); finish(p); }
      edge.k = 0; conn = null; cur = null;
      for (const n of notes.splice(0)) n.el.remove();
    },
    busy() { return plays.length > 0 || edge.k > 0.004 || !!conn || notes.length > 0; },
    // the overlay is going away (nothing on screen): its buffers are let go until the next flick
    sleep() { if (!plays.length) X.free(); },

    update(E, AP, s) {
      const now = E.now(), ms = s * 1000;
      // the edge: a card on the phone coming close, a hold (connecting), the pointer at the edge, the settings preview
      const p = Math.max(AP.p, AP.hold * 0.9, (AP.hover || 0) * 0.8);
      const y = AP.p > 0.01 ? AP.y : AP.hold > 0 ? E.S.anchor * E.S.H : AP.hover > 0 ? AP.hoverY : edge.y;
      edge.y = E.damp(edge.y || y, y, ms, 30);
      edge.k = E.damp(edge.k, p, ms, p > edge.k ? 40 : 140);
      if (edge.k < 0.004 && p < 0.004) edge.k = 0;
      const want = AP.card && AP.card.info ? okName(AP.card.info.look) : null;
      edge.look = want || themeLook(E);
      edge.col = colorOf(edge.look);
      // looks that are over
      for (let i = plays.length - 1; i >= 0; i--) {
        const q = plays[i];
        const t = (now - q.t0) / 1000;
        if (t > q.end || (q.kill && now - q.kill > 240)) { plays.splice(i, 1); finish(q); }
      }
      // how fast frames come while a look plays (frames 5 to 40 of the first few looks): too slow → the light version
      if (plays.length && !perf.lite && perf.looks <= 3) {
        perf.frames++;
        if (perf.frames > 4 && perf.frames <= 40) { perf.sum += ms; perf.n++; }
        if (perf.n >= 24 && perf.sum / perf.n > 26) { perf.lite = true; console.log('looks: slow frames (' + Math.round(perf.sum / perf.n) + ' ms), the light version from now on'); }
      } else if (!plays.length && perf.frames) { perf.frames = 0; perf.looks++; perf.sum = 0; perf.n = 0; }
      for (let i = notes.length - 1; i >= 0; i--) {
        const n = notes[i], age = (performance.now() - n.t0) / 1000;
        n.el.style.opacity = String(U.clamp(age / 0.25, 0, 1) * (1 - U.clamp((age - 1.35) / 0.4, 0, 1)));
        if (age > 1.8) { n.el.remove(); notes.splice(i, 1); }
      }
    },

    // a card lifted on the phone: the sound gets ready (and, without a choice from the phone, the look is chosen now)
    lift(E, c) {
      A.warm();
      if (!okName(c.info.look)) c.info.look = pick(E, null);
    },

    // ---------------------------------------------------------------- phone → PC
    launch(E, c) {
      const name = pick(E, c.info.look);
      c.info.look = name;
      const L = c.launch || { x0: c.pose.x, y0: c.pose.y };
      if (!play(E, c, name, false, [L.x0, L.y0], [c.target.x, c.target.y])) c.fallback = true;
    },
    fly(E, c, ts) {
      const p = c.play;
      if (!p) return fallbackFly(E, c, ts);
      poseFrom(p, c, E.now());
      return p.t >= p.look.HIT;
    },
    landed(E, c) {
      // the phone gives a short thud as the card hits (not for the settings preview)
      if (E.send && !/^demo-/.test(String(c.id))) E.send('fx:landed', { tid: c.id });
    },
    rest(E, c) {
      const p = c.play;
      if (p && !p.out && !p.kill) poseFrom(p, c, E.now());
    },

    // ---------------------------------------------------------------- PC → phone (sent from here, Air grab)
    outgoing(E, c) {
      const name = pick(E, c.info && c.info.look);
      if (!play(E, c, name, true, [c.pose.x, c.pose.y], [c.pose.x, c.pose.y])) c.fallback = true;
    },
    flyOut(E, c, ts) {
      const p = c.play;
      if (!p) return fallbackOut(E, c, ts);
      poseFrom(p, c, E.now());
      return p.t >= p.look.OUT;
    },

    cancel(E, c) { if (c.play) { c.play.kill = performance.now(); if (c.play.snd) c.play.snd.fade(0.2); } },
    fail(E, c) { if (c.play && c.play.snd) c.play.snd.fade(0.4); },

    hint(E, m) {
      const S = E.S, y = S.anchor * S.H;
      if (m.pulse) {
        const look = themeLook(E);
        conn = { t0: performance.now(), y, col: colorOf(look === 'surprise' ? null : look), soft: true };
      }
      if (m.text) note(E, String(m.text).slice(0, 120), y);
    },
    soundTest(E) { A.play(pick(E, null)); },

    connect(E, info) {
      const S = E.S, y = S.anchor * S.H;
      const look = themeLook(E);
      conn = { t0: performance.now(), y, col: colorOf(look === 'surprise' ? NAMES[Math.floor(Math.random() * 4)] : look) };
      if (info && info.name) note(E, info.name + ' connected', y);
    },

    drawBackground(E) {
      if (!X.ready()) { cur = null; return; }
      cur = merge(E, E.now());
      X.under(cur, isLite(E));
    },
    drawUnder(E) {
      if (!cur) return;
      for (const p of plays) drawPlay(E, p);
    },
    drawOver(E) {
      if (!cur) return;
      X.over(isLite(E));
      cur = null;
    },
  };

  // no graphics for the looks (the look failed to start): the card still flies, plainly
  function fallbackFly(E, c, ts) {
    const u = U.clamp(ts / 0.6, 0, 1), e = U.easeOut3(u), L = c.launch || { x0: c.pose.x, y0: c.pose.y, s0: 1, r0: 0 };
    c.pose.x = U.lerp(L.x0, c.target.x, e); c.pose.y = U.lerp(L.y0, c.target.y, e);
    c.pose.sx = c.pose.sy = U.lerp(L.s0 || 1, 1, e); c.pose.rz = U.lerp(L.r0 || 0, 0, e); c.pose.z = 0;
    return u >= 1;
  }
  function fallbackOut(E, c, ts) {
    c.pose.x += -E.dirIn() * (8 + ts * 60);
    const half = c.w / 2;
    return E.S.side === 'right' ? c.pose.x - half > E.S.W : c.pose.x + half < 0;
  }

  for (const n of NAMES) THEMES[n] = theme;
  THEMES.surprise = theme;
  // test hook: what's playing
  window.__looks = () => ({ plays: plays.map((p) => ({ name: p.name, out: p.out, t: +p.t.toFixed(3), tid: p.card && p.card.id })), lite: perf.lite,
    reduced: !!(E0 && E0.S.reduceFx), software: !!X.software, edge: +edge.k.toFixed(3), last: lastPick });
})();
