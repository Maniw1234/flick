'use strict';
/* Roadster — the file launches on cold-gas jets, corkscrews once in the air and touches down on a cushion of vapor.
   Inspired by the Oct 2026 Roadster reveal: night stage, compressed-air thrusters (no flame, just a hiss),
   a flip mid-air, a controlled descent on the thrusters and a 0-60 time on screen. */
(function () {
  const THEMES = (window.FLICK_THEMES = window.FLICK_THEMES || {});
  const R = window.GFX;
  const VAPOR = [0.955, 0.97, 0.99];
  const TAIL = [1.0, 0.17, 0.13];
  const LAMP = [1.0, 0.965, 0.92];

  const st = {
    dim: 0, boost: 0, lampY: 0, laneHalf: 60, lamps: [0, 0, 0, 0, 0], lampsOn: 0, launchT: -1, launchY: 0, launchHalf: 60,
    column: [0, 0, 0, 0, 0, 0, 0], columnOn: 0, connectT: -1, line: null, hum: null, humIdle: 0, shake: null, notes: [],
  };
  let bg = null;

  const FS_BG = `
in vec2 vUV;
uniform float uDim; uniform float uEdgeX; uniform float uEdgeY;
uniform vec2 uShake; uniform float uShakeOn;
uniform sampler2D uDesk; uniform float uHasDesk; uniform vec2 uDeskUV;
out vec4 o;
void main() {
  vec2 p = fragDip();
  float dx = abs(p.x - uEdgeX) / uRes.x;
  float dy = (p.y - uEdgeY) / uRes.y;
  float v = clamp(uDim * exp(-dx * 2.2) * (0.55 + 0.45 * exp(-dy * dy * 4.0)), 0.0, 1.0);
  if (uHasDesk > 0.5) {
    // night grade of the real desktop: darker, cooler, a little desaturated (stage lights going down)
    vec3 d = texture(uDesk, (p - uShake * uShakeOn) * uDeskUV).rgb;
    float l = dot(d, vec3(0.299, 0.587, 0.114));
    vec3 night = mix(vec3(l), d, 0.55) * vec3(0.52, 0.6, 0.74);
    vec3 g = mix(d, night, min(v * 2.4, 1.0));
    float a = uShakeOn > 0.5 ? 1.0 : smoothstep(0.0, 0.04, v);
    o = vec4(g * a, a);
  } else {
    vec3 night = vec3(0.022, 0.03, 0.042);
    o = vec4(night * v, v);
  }
}`;

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const rnd = (a, b) => a + Math.random() * (b - a);
  const bump = (t, a, peak, b) => (t <= a || t >= b ? 0 : t < peak ? Math.sin(((t - a) / (peak - a)) * Math.PI / 2) : Math.cos(((t - peak) / (b - peak)) * Math.PI / 2));
  const easeInOutCubic = (u) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);

  function fmtSize(n) {
    n = +n || 0;
    if (n <= 0) return '';
    if (n < 1024) return n + ' bytes';
    if (n < 1048576) return Math.max(1, Math.round(n / 1024)) + ' KB';
    if (n < 1073741824) return (n / 1048576).toFixed(n < 10485760 ? 1 : 0) + ' MB';
    return (n / 1073741824).toFixed(1) + ' GB';
  }

  // exponential approach x(t) = D (1 - e^{-t/τ}) / (1 - e^{-T/τ}) whose initial speed is v
  function solveTau(D, v, T) {
    if (D < 1 || v <= (D / T) * 1.05) return T * 6;
    let lo = 0.004, hi = 30;
    for (let i = 0; i < 50; i++) {
      const m = (lo + hi) / 2;
      const sp = D / (m * (1 - Math.exp(-T / m)));
      if (sp > v) lo = m; else hi = m;
    }
    return (lo + hi) / 2;
  }

  // world position + world direction of a nozzle on the card
  function nozzle(c, lx, ly, dx, dy, dz) {
    const M = R.model(c.pose);
    const p = R.apply(M, lx, ly, 0);
    const o = R.apply(M, 0, 0, 0);
    const q = R.apply(M, dx, dy, dz);
    let vx = q[0] - o[0], vy = q[1] - o[1], vz = q[2] - o[2];
    const l = Math.hypot(vx, vy, vz) || 1;
    return { x: p[0], y: p[1], z: p[2], dx: vx / l, dy: vy / l, dz: vz / l };
  }

  // thrust straight down into the desktop whatever the card's attitude (keeps the ground cloud under the card)
  function down(n) { n.dx = 0; n.dy = 0; n.dz = -1; return n; }

  function jet(E, c, n, count, speed, opts) {
    const cv = c.fl && c.fl.vel ? c.fl.vel : [0, 0, 0];
    for (let i = 0; i < count; i++) {
      const sp = speed * rnd(0.65, 1.15);
      const spread = (opts && opts.spread) || 0.22;
      const jx = n.dx + rnd(-spread, spread), jy = n.dy + rnd(-spread, spread), jz = n.dz + rnd(-spread, spread) * 0.5;
      E.puff({
        x: n.x + rnd(-1.5, 1.5), y: n.y + rnd(-1.5, 1.5), z: Math.max(0, n.z),
        vx: jx * sp + cv[0] * 0.25, vy: jy * sp + cv[1] * 0.25, vz: jz * sp,
        s0: rnd(12, 18), s1: rnd(80, 140) * ((opts && opts.big) || 1), grow: rnd(0.2, 0.34), drag: rnd(0.09, 0.16), life: rnd(0.75, 1.25),
        alpha: rnd(0.34, 0.48) * ((opts && opts.alpha) || 1), color: VAPOR, cx: c.pose.x, cy: c.pose.y,
      });
    }
  }

  // emit `rate` puffs/s from a nozzle during the frame, carrying fractional counts over
  function emit(E, c, key, n, rate, dt, speed, opts) {
    const fl = c.fl;
    fl.acc[key] = (fl.acc[key] || 0) + rate * dt;
    const k = Math.floor(fl.acc[key]);
    if (k > 0) { fl.acc[key] -= k; jet(E, c, n, k, speed, opts); }
  }

  function readout(E, c) {
    const el = document.createElement('div');
    el.className = 'readout';
    el.innerHTML = '<div class="t"><span class="num">0.00</span><span class="unit">s</span></div><div class="n"></div>';
    const size = fmtSize(c.size);
    el.querySelector('.n').textContent = (c.info.name || '') + (size ? ', ' + size : '');
    E.hud.appendChild(el);
    (c.extraEls = c.extraEls || []).push(el);
    c.readout = { el, num: el.querySelector('.num'), t0: E.now(), shown: 0 };
    // above the card if there is room, otherwise below
    const top = c.pose.y - c.h / 2;
    const above = top > 110;
    c.readout.above = above;
    placeReadout(E, c);
  }
  function placeReadout(E, c) {
    const r = c.readout; if (!r) return;
    const left = c.pose.x - c.w / 2;
    const y = r.above ? c.pose.y - c.h / 2 - 14 : c.pose.y + c.h / 2 + 18;
    r.el.style.transform = `translate3d(${left}px, ${y}px, 0) translateY(${r.above ? '-100%' : '0'})`;
    const end = c.savedAt || E.now();
    const secs = Math.max(0.01, (end - c.liftAt) / 1000);
    const u = clamp((E.now() - r.t0) / 520, 0, 1);
    const shown = c.savedAt ? secs * (1 - Math.pow(1 - u, 3)) : secs;
    r.num.textContent = shown.toFixed(2);
    const fadeIn = clamp((E.now() - r.t0) / 260, 0, 1);
    const fadeOut = r.outT ? 1 - clamp((E.now() - r.outT) / 300, 0, 1) : 1;
    r.el.style.opacity = String(fadeIn * fadeOut);
  }

  const theme = {
    name: 'Roadster',
    restHold: 1.15,

    init(E) {
      bg = R.fsProgram(R.HEAD + R.FCOMMON + FS_BG, 'roadster.bg');
      st.lampY = E.S.anchor * E.S.H;
    },

    reset() {
      st.dim = 0; st.boost = 0; st.lamps.fill(0); st.column.fill(0); st.launchT = -1; st.line = null; st.shake = null;
      if (st.hum) { st.hum.stop(); st.hum = null; }
      for (const n of st.notes) n.el.remove();
      st.notes = [];
    },

    lift() {},

    update(E, AP, s) {
      const S = E.S;
      const now = E.now();
      const hover = AP.hover || 0;
      const p = Math.max(AP.p, hover * 0.85);
      if (AP.card) { st.laneHalf = E.damp(st.laneHalf, (AP.card.h * (AP.card.pose.sy || 1)) / 2 + 16, s * 1000, 60); }
      const ly = AP.p > 0.01 ? AP.y : hover > 0 ? AP.hoverY : st.lampY;
      st.lampY = E.damp(st.lampY, ly, s * 1000, 40);

      // stage lights go down as the file approaches
      st.boost *= Math.exp(-s / 0.42);
      st.dim = E.damp(st.dim, Math.max(p * 0.32, AP.hold * 0.22), s * 1000, 90);

      // launch lamps: light one by one with proximity
      let on = 0;
      for (let n = 0; n < 5; n++) {
        const target = E.sstep(n * 0.17 + 0.05, n * 0.17 + 0.17, p);
        st.lamps[n] = E.damp(st.lamps[n], target, s * 1000, 35);
        if (st.lamps[n] > 0.6) on++;
      }
      if (on > st.lampsOn) E.A.tone({ type: 'sine', f0: 2400 + on * 180, dur: 0.035, gain: 0.012, attack: 0.002 });
      st.lampsOn = on;

      // connect: vertical column at the phone edge charges with the hold
      let con = 0;
      for (let n = 0; n < 7; n++) {
        const target = E.sstep(n / 7, (n + 0.8) / 7, AP.hold);
        st.column[n] = E.damp(st.column[n], target, s * 1000, 30);
        if (st.column[n] > 0.6) con++;
      }
      if (con > st.columnOn) E.A.tone({ type: 'sine', f0: 1900 + con * 140, dur: 0.035, gain: 0.011, attack: 0.002 });
      st.columnOn = con;

      // vapor seeping from the edge while the file waits in the lane
      if (AP.p > 0.25 && Math.random() < AP.p * s * 12) {
        const dir = E.dirIn();
        E.puff({ x: E.edgeX() + dir * rnd(2, 10), y: st.lampY + rnd(-st.laneHalf, st.laneHalf) * 0.8, vx: dir * rnd(25, 70), vy: rnd(-12, 12),
          s0: 18, s1: rnd(70, 110), grow: 0.6, drag: 0.8, life: rnd(1.1, 1.6), alpha: 0.12 * AP.p, color: VAPOR });
      }

      // low hum rises with proximity
      const humLevel = Math.max(AP.p, AP.hold * 0.8, hover * 0.5);
      if (humLevel > 0.02 && !st.hum) st.hum = E.A.drone({ freqs: [46, 92, 138], types: ['sine', 'triangle', 'sine'], lp: 420, verb: 0.15 });
      if (st.hum) {
        st.hum.set(0.045 * humLevel, 1 + 0.38 * humLevel);
        if (humLevel < 0.01) { st.humIdle += s; if (st.humIdle > 0.6) { st.hum.stop(); st.hum = null; st.humIdle = 0; } } else st.humIdle = 0;
      }

      // light line from the connect moment
      if (st.line) {
        const L = st.line;
        const u = clamp((now - L.t0) / 420, 0, 1);
        const e = 1 - Math.pow(1 - u, 3);
        const head = L.from + (L.to - L.from) * e;
        if (Math.abs(head - L.head) > 0.5) {
          E.seg({ x0: L.head, y0: L.y, x1: head, y1: L.y, w: 6, core: 1.1, color: [1, 1, 1], life: 0.95, alpha: 0.95 });
          L.head = head;
        }
        if (u >= 1) st.line = null;
      }
      for (let i = st.notes.length - 1; i >= 0; i--) {
        const n = st.notes[i];
        const age = (now - n.t0) / 1000;
        n.el.style.opacity = String(clamp(age / 0.25, 0, 1) * (1 - clamp((age - 1.35) / 0.4, 0, 1)));
        if (age > 1.8) { n.el.remove(); st.notes.splice(i, 1); }
      }
      // readouts follow their cards
      for (const c of E.cards.values()) if (c.readout) placeReadout(E, c);
    },

    busy(E) {
      return st.dim > 0.004 || st.boost > 0.004 || st.lamps.some((v) => v > 0.01) || st.column.some((v) => v > 0.01) || !!st.line ||
        !!st.hum || (st.shake && E.now() - st.shake.t0 < 260) || st.notes.length > 0 || (st.launchT > 0 && E.now() - st.launchT < 700);
    },

    // ---------------------------------------------------------------- phone → PC
    launch(E, c) {
      const L = c.launch, dir = E.dirIn();
      const fl = (c.fl = { acc: {}, trail: [null, null], vel: [0, 0, 0], last: null });
      fl.dir = dir;
      fl.T = 1.2;
      fl.x0 = L.x0; fl.y0 = L.y0; fl.tx = c.target.x; fl.ty = c.target.y;
      const v = Math.max(Math.abs(L.vx) * 1000 * 1.5, 2400);
      fl.tau = solveTau(Math.abs(fl.tx - fl.x0), v, fl.T);
      fl.Hmax = E.S.H * 0.34;
      c.back = 1; c.gloss = 0.9;
      st.launchT = E.now(); st.launchY = c.pose.y; st.launchHalf = st.laneHalf;
      st.boost = 0.34;
      const A = E.A;
      for (let i = 0; i < 4; i++) A.noise({ at: i * 0.014, dur: 0.46, type: 'highpass', f0: 2900, f1: 1500, q: 0.5, gain: 0.07, attack: 0.004, pan: rnd(-0.35, 0.35), verb: 0.25 });
      A.noise({ dur: 0.55, type: 'bandpass', f0: 700, f1: 3200, q: 0.6, gain: 0.05, attack: 0.012, verb: 0.3 });
      A.tone({ type: 'sawtooth', f0: 130, f1: 1150, sweep: 0.8, dur: 0.95, gain: 0.016, attack: 0.04, lp: 2600, verb: 0.2 });
      A.tone({ type: 'sine', f0: 260, f1: 2300, sweep: 0.8, dur: 0.9, gain: 0.012, attack: 0.05, verb: 0.2 });
      A.tone({ type: 'sine', f0: 74, f1: 40, sweep: 0.15, dur: 0.2, gain: 0.17, attack: 0.003 });
      A.noise({ at: 0.27, dur: 0.1, type: 'highpass', f0: 3400, q: 0.5, gain: 0.035, attack: 0.003, pan: 0.2 });
      A.noise({ at: 0.79, dur: 0.1, type: 'highpass', f0: 3400, q: 0.5, gain: 0.035, attack: 0.003, pan: -0.2 });
      A.noise({ at: 0.8, dur: 0.42, type: 'highpass', f0: 2000, f1: 1200, q: 0.5, gain: 0.05, attack: 0.03, verb: 0.2 });
    },

    fly(E, c, ts, dtMs) {
      const fl = c.fl, T = fl.T, dir = fl.dir;
      const t = Math.min(ts, T);
      const dt = dtMs / 1000;
      const ex = (1 - Math.exp(-t / fl.tau)) / (1 - Math.exp(-T / fl.tau));
      const before = { x: c.pose.x, y: c.pose.y, z: c.pose.z };
      c.pose.x = fl.x0 + (fl.tx - fl.x0) * ex;
      c.pose.y = fl.y0 + (fl.ty - fl.y0) * (ex * ex * (3 - 2 * ex));
      // lift-off, hover, controlled descent (zero vertical speed at touchdown)
      let lift;
      if (t < 0.08) lift = 0;
      else if (t < 0.46) lift = Math.sin(((t - 0.08) / 0.38) * Math.PI / 2);
      else if (t < 0.8) lift = 1 + 0.03 * Math.sin(((t - 0.46) / 0.34) * Math.PI);
      else lift = 0.5 * (1 + Math.cos(((t - 0.8) / (T - 0.8)) * Math.PI));
      c.pose.z = fl.Hmax * lift;
      // one full corkscrew around the travel axis
      const ur = clamp((t - 0.25) / 0.55, 0, 1);
      c.pose.rx = -2 * Math.PI * easeInOutCubic(ur);
      // nose up at lift-off, flare before touchdown
      c.pose.ry = -dir * (0.27 * bump(t, 0.04, 0.17, 0.44) + 0.1 * bump(t, 0.88, 1.06, 1.2));
      c.pose.rz = c.launch.r0 * (1 - E.sstep(0, 0.45, t));
      c.pose.sx = c.pose.sy = c.launch.s0 + (1 - c.launch.s0) * E.sstep(0, 0.3, t);
      if (dt > 0) fl.vel = [(c.pose.x - before.x) / dt, (c.pose.y - before.y) / dt, (c.pose.z - before.z) / dt];

      const w = c.w, h = c.h;
      // thrusters
      if (t < 0.22) {
        const k = 1 - t / 0.22;
        for (const sy of [-1, 1]) emit(E, c, 'rear' + sy, nozzle(c, -dir * w * 0.47, sy * h * 0.33, -dir, 0, -0.35), 230 * (0.35 + 0.65 * k), dt, 2300, { spread: 0.16 });
      }
      if (t > 0.05 && t < 0.24) {
        for (const sx of [-1, 1]) for (const sy of [-1, 1]) emit(E, c, 'lift' + sx + sy, down(nozzle(c, sx * w * 0.38, sy * h * 0.34, 0, 0, -1)), 60, dt, 1500, { spread: 0.3, alpha: 0.8 });
      }
      if ((t > 0.25 && t < 0.29) || (t > 0.79 && t < 0.83)) {
        // short attitude puffs from the sides: slow and round, they kick the roll on and off
        const sgn = t < 0.5 ? 1 : -1;
        emit(E, c, 'att' + sgn, nozzle(c, 0, sgn * h * 0.5, 0, sgn, 0), 110, dt, 420, { spread: 0.35, big: 0.5, alpha: 0.7 });
      }
      if (t > 0.82 && t < T) {
        const rate = 40 + 230 * (1 - c.pose.z / fl.Hmax);
        for (const sx of [-1, 1]) for (const sy of [-1, 1]) emit(E, c, 'retro' + sx + sy, down(nozzle(c, sx * w * 0.38, sy * h * 0.34, 0, 0, -1)), rate / 4, dt, 1300, { spread: 0.35, alpha: 0.85 });
      }
      // red taillight trails from the rear corners (they corkscrew with the roll)
      if (t < 0.66) {
        const glowK = 1 - E.sstep(0.3, 0.66, t);
        const M = R.model(c.pose);
        [-1, 1].forEach((sy, i) => {
          const wp = R.apply(M, -dir * w * 0.49, sy * h * 0.3, 0);
          const sp = R.projectPt(wp[0], wp[1], wp[2]);
          const prev = fl.trail[i];
          if (prev) E.seg({ x0: prev[0], y0: prev[1], x1: sp[0], y1: sp[1], w: 8 * sp[2], core: 1.4 * sp[2], color: TAIL, life: 0.24, alpha: glowK, taper: true });
          fl.trail[i] = sp;
        });
      }
      return ts >= T;
    },

    landed(E, c) {
      const dir = E.dirIn();
      // vapor ring spreads along the desktop
      const n = 18;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + rnd(-0.1, 0.1);
        const ex = Math.cos(a) * (c.w / 2 + 6), ey = Math.sin(a) * (c.h / 2 + 6);
        const sp = rnd(420, 900);
        E.puff({ x: c.pose.x + ex, y: c.pose.y + ey, vx: Math.cos(a) * sp + dir * 60, vy: Math.sin(a) * sp, s0: 22, s1: rnd(110, 170), grow: 0.34,
          drag: rnd(0.16, 0.24), life: rnd(1.0, 1.45), alpha: rnd(0.3, 0.42), color: VAPOR });
      }
      st.shake = { t0: E.now(), amp: 3.2 };
      E.A.tone({ type: 'sine', f0: 96, f1: 42, sweep: 0.16, dur: 0.22, gain: 0.2, attack: 0.003 });
      E.A.noise({ dur: 0.045, type: 'bandpass', f0: 2900, q: 3, gain: 0.05, attack: 0.002, verb: 0.2 });
      E.A.noise({ dur: 0.5, type: 'highpass', f0: 1800, f1: 900, q: 0.4, gain: 0.035, attack: 0.01, verb: 0.25 });
      readout(E, c);
    },

    rest(E, c, ts) {
      const f = Math.exp(-ts / 0.07) * Math.cos((2 * Math.PI * ts) / 0.19);
      c.pose.sx = 1 + 0.045 * f; c.pose.sy = 1 - 0.055 * f;
      c.pose.z = 0; c.pose.rx = 0; c.pose.ry = 0;
    },

    toIcon(E, c) { if (c.readout) c.readout.outT = E.now(); },

    // ---------------------------------------------------------------- connect
    connect(E, info) {
      const S = E.S, dir = E.dirIn();
      const ex = E.edgeX(), cy = S.anchor * S.H, ph = E.phoneH();
      const fake = { pose: { x: ex, y: cy, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1 }, fl: { vel: [0, 0, 0] } };
      for (let i = 0; i < 7; i++) {
        const y = cy + (i / 6 - 0.5) * ph * 0.8;
        jet(E, fake, { x: ex + dir * 2, y, z: 0, dx: dir, dy: (i / 6 - 0.5) * 0.5, dz: 0 }, 9, 2300, { spread: 0.22, big: 1.2 });
      }
      st.line = { t0: E.now(), y: cy, from: ex, head: ex, to: ex + dir * S.W * 1.02 };
      st.column.fill(1.3);
      st.boost = 0.26;
      if (info && info.name) {
        const el = document.createElement('div');
        el.className = 'note';
        el.textContent = info.name + ' connected';
        el.style.transform = `translate3d(${ex + dir * 26}px, ${cy - 30}px, 0) translateX(${dir < 0 ? '-100%' : '0'})`;
        E.hud.appendChild(el);
        st.notes.push({ el, t0: E.now() });
      }
      const A = E.A;
      A.noise({ dur: 0.6, type: 'highpass', f0: 2500, f1: 1300, q: 0.5, gain: 0.08, attack: 0.006, verb: 0.3 });
      A.tone({ type: 'sawtooth', f0: 150, f1: 880, sweep: 0.6, dur: 0.75, gain: 0.014, attack: 0.03, lp: 2200, verb: 0.25 });
      A.tone({ type: 'sine', f0: 70, f1: 42, sweep: 0.14, dur: 0.2, gain: 0.14, attack: 0.003 });
    },

    // ---------------------------------------------------------------- PC → phone
    outgoing(E, c) {
      const dirOut = -E.dirIn();
      c.fl = { acc: {}, trail: [null, null], vel: [0, 0, 0], dirOut, x0: c.pose.x, T: 0.62 };
      c.back = 1; c.gloss = 0.85;
      E.A.noise({ dur: 0.4, type: 'highpass', f0: 2600, f1: 1500, q: 0.5, gain: 0.07, attack: 0.004, verb: 0.25 });
      E.A.tone({ type: 'sawtooth', f0: 180, f1: 1300, sweep: 0.5, dur: 0.6, gain: 0.014, attack: 0.02, lp: 2400, verb: 0.2 });
    },
    flyOut(E, c, ts, dtMs) {
      const fl = c.fl, dt = dtMs / 1000, d = fl.dirOut, w = c.w, h = c.h;
      const before = { x: c.pose.x, y: c.pose.y, z: c.pose.z };
      const u = ts / fl.T;
      c.pose.x = fl.x0 + d * (E.S.W * 0.06 * u + 1500 * Math.pow(Math.max(0, ts - 0.08), 2));
      c.pose.z = E.S.H * 0.08 * Math.sin(Math.min(1, u * 1.4) * Math.PI / 2);
      c.pose.ry = -(-d) * 0.18 * bump(ts, 0, 0.12, 0.4);
      if (dt > 0) fl.vel = [(c.pose.x - before.x) / dt, 0, (c.pose.z - before.z) / dt];
      if (ts < 0.3) for (const sy of [-1, 1]) emit(E, c, 'r' + sy, nozzle(c, -d * w * 0.47, sy * h * 0.33, -d, 0, -0.3), 200, dt, 2200, { spread: 0.16 });
      const M = R.model(c.pose);
      [-1, 1].forEach((sy, i) => {
        const wp = R.apply(M, -d * w * 0.49, sy * h * 0.3, 0);
        const sp = R.projectPt(wp[0], wp[1], wp[2]);
        if (fl.trail[i]) E.seg({ x0: fl.trail[i][0], y0: fl.trail[i][1], x1: sp[0], y1: sp[1], w: 8 * sp[2], core: 1.4 * sp[2], color: TAIL, life: 0.24, alpha: 0.95, taper: true });
        fl.trail[i] = sp;
      });
      const half = w / 2 + 30;
      return E.S.side === 'right' ? c.pose.x - half > E.S.W : c.pose.x + half < 0;
    },

    cancel() {},

    fail(E, c) {
      for (let i = 0; i < 5; i++) E.puff({ x: c.pose.x + rnd(-c.w / 2, c.w / 2), y: c.pose.y + rnd(-c.h / 2, c.h / 2), vx: rnd(-60, 60), vy: rnd(-60, 60), s0: 16, s1: 60, life: 0.8, alpha: 0.2, color: VAPOR });
      E.A.noise({ dur: 0.25, type: 'bandpass', f0: 600, f1: 200, q: 1, gain: 0.05, attack: 0.005 });
    },

    // ---------------------------------------------------------------- drawing
    drawBackground(E, AP) {
      const now = E.now();
      const shaking = st.shake && now - st.shake.t0 < 240;
      const dim = Math.max(st.dim, st.boost);
      if (dim < 0.003 && !shaking) return;
      const u = R.use(bg);
      R.bindDesk(u, 0);
      let sx = 0, sy = 0;
      if (shaking) {
        const ts = (now - st.shake.t0) / 1000;
        const a = st.shake.amp * Math.exp(-ts / 0.06);
        sx = a * Math.sin(ts * 95); sy = a * Math.cos(ts * 77) * 0.8;
      }
      R.gl.uniform1f(u.uDim, dim);
      R.gl.uniform1f(u.uEdgeX, E.edgeX());
      R.gl.uniform1f(u.uEdgeY, st.lampY);
      R.gl.uniform2f(u.uShake, sx, sy);
      R.gl.uniform1f(u.uShakeOn, shaking ? 1 : 0);
      R.blendOver();
      R.bindTarget(null);
      R.tri();
    },

    drawOver(E) {
      const dir = E.dirIn(), ex = E.edgeX();
      const list = [];
      const now = E.now();
      // launch lane lamps (two rows framing the card's path)
      let launchAge = st.launchT > 0 ? (now - st.launchT) / 1000 : 99;
      for (let n = 0; n < 5; n++) {
        let a = st.lamps[n];
        const y0 = launchAge < 0.6 ? st.launchY : st.lampY, half = launchAge < 0.6 ? st.launchHalf : st.laneHalf;
        if (launchAge < 0.6) {
          // flash, then chase off toward the screen
          const offAt = 0.07 + n * 0.05;
          a = launchAge < 0.06 ? 1.25 : 1.1 * (1 - E.sstep(offAt, offAt + 0.09, launchAge));
        }
        if (a < 0.01) continue;
        const x = ex + dir * (20 + n * 34);
        for (const sy of [-1, 1]) list.push({ x, y: y0 + sy * half, size: 40, alpha: Math.min(1, a), color: LAMP, kind: 3 });
      }
      // connect column along the phone edge
      const cy = E.S.anchor * E.S.H, ph = E.phoneH();
      for (let n = 0; n < 7; n++) {
        let a = st.column[n];
        if (a < 0.01) continue;
        if (a > 1.05) { st.column[n] = Math.max(0, a - 0.035); a = Math.min(1, a); }
        const y = cy + (0.5 - (n + 0.5) / 7) * ph * 0.8;
        list.push({ x: ex + dir * 16, y, size: 36, alpha: a, color: LAMP, kind: 3 });
      }
      R.drawSprites(list);
    },
  };

  THEMES.roadster = theme;
})();
