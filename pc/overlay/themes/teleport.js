'use strict';
/* Teleport — the file is beamed across: thousands of particles carrying the image's own colors stream in
   from the phone edge, lock into place as a mosaic, and the card resolves out of it. */
(function () {
  const THEMES = (window.FLICK_THEMES = window.FLICK_THEMES || {});
  const R = window.GFX;
  const BEAM = [1.0, 0.94, 0.84];
  const SPARK = [1.0, 0.86, 0.62];
  let prog = null, vao = null, vbo = null, capacity = 0;
  const streams = [];               // active particle streams
  const st = { beam: 0, beamY: 0, beamH: 120, flare: 0 };
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const rnd = (a, b) => a + Math.random() * (b - a);
  const PENTA = [1046.5, 1174.7, 1396.9, 1568, 1760, 2093, 2349.3, 2793.8, 3136, 3520];

  const VS = `
in vec2 aUV; in vec4 aRnd;
uniform float uT; uniform vec2 uSrc; uniform float uSpread; uniform vec2 uTgt; uniform vec2 uSize;
uniform float uDir; uniform float uCell; uniform float uOut; uniform float uFade; uniform float uHalo;
out vec2 vUV; out float vHot; out float vArr; out float vA;
void main() {
  float lead = uDir < 0.0 ? 1.0 - aUV.x : aUV.x;            // side nearest the phone first
  float delay = lead * 0.34 + aRnd.x * 0.06;
  float dur = 0.5 + aRnd.y * 0.08;
  float t = clamp((uT - delay) / dur, 0.0, 1.0);
  if (uOut > 0.5) t = 1.0 - clamp((uT - (1.0 - lead) * 0.24 - aRnd.x * 0.05) / dur, 0.0, 1.0);
  vec2 tgt = uTgt + (aUV - 0.5) * uSize;
  vec2 src = uSrc + vec2(-uDir * lead * 6.0, (aUV.y - 0.5) * uSpread * 2.0);
  // one coherent ribbon: neighbours travel together, the ribbon arcs and twists on the way
  float twist = sin(aUV.x * 3.2 + uT * 2.0) * 0.5 + (aUV.y - 0.5);
  vec2 mid = mix(src, tgt, 0.5) + vec2(0.0, -90.0 + twist * 70.0) + (aRnd.zw - 0.5) * 14.0;
  float e = 1.0 - pow(1.0 - t, 3.0);
  vec2 P = mix(mix(src, mid, e), mix(mid, tgt, e), e);
  float fly = 1.0 - smoothstep(0.8, 1.0, t);
  P += vec2(sin(uT * 7.0 + aUV.y * 9.0), cos(uT * 6.0 + aUV.x * 9.0)) * 3.0 * fly * step(0.0001, t);
  vHot = fly; vArr = smoothstep(0.86, 1.0, t);
  vA = (t > 0.0 ? 1.0 : 0.0) * uFade;
  vUV = aUV;
  gl_Position = project(vec3(P, 0.0));
  float ps = mix(2.2 + aRnd.y * 1.2, uCell * 1.22, vArr);
  if (uHalo > 0.5) { ps = (7.0 + aRnd.y * 6.0) * fly; vA *= step(0.85, aRnd.z); }
  gl_PointSize = ps * uDpr;
}`;
  const FS = `
in vec2 vUV; in float vHot; in float vArr; in float vA;
uniform sampler2D uTex; uniform vec4 uCover; uniform float uHalo;
out vec4 o;
void main() {
  vec2 pc = gl_PointCoord - 0.5;
  vec3 c = texture(uTex, vUV * uCover.xy + uCover.zw).rgb;
  if (uHalo > 0.5) {                                             // soft light around the stream
    float g = exp(-dot(pc, pc) * 14.0) * 0.16 * vA;
    vec3 hc = mix(c, vec3(1.0, 0.93, 0.82), 0.5);
    o = vec4(hc * g, g);
    return;
  }
  float round_ = 1.0 - smoothstep(0.32, 0.5, length(pc));
  float square = 1.0 - smoothstep(0.46, 0.5, max(abs(pc.x), abs(pc.y)));
  float m = mix(round_, square, vArr);
  c = mix(c, vec3(1.0, 0.94, 0.86), vHot * 0.14) * (1.0 + vHot * 0.28);
  float a = m * vA;
  o = vec4(clamp(c, 0.0, 1.0) * a, a);
}`;

  function ensure(n) {
    const gl = R.gl;
    if (!prog) prog = R.program(R.HEAD + R.COMMON + VS, R.HEAD + R.FCOMMON + FS, 'teleport.points');
    if (!vbo) { vbo = gl.createBuffer(); vao = gl.createVertexArray(); }
    if (n <= capacity) return;
    capacity = n;
  }
  function buildStream(card, cols, rows) {
    const n = cols * rows;
    const data = new Float32Array(n * 6);
    let o = 0;
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
      data[o++] = (i + 0.5) / cols; data[o++] = (j + 0.5) / rows;
      data[o++] = Math.random(); data[o++] = Math.random(); data[o++] = Math.random(); data[o++] = Math.random();
    }
    return { data, n };
  }
  function cover(c) {
    let sx = 1, sy = 1, ox = 0, oy = 0;
    if (c.tex && c.texW && c.texH) {
      const ca = c.w / c.h, ta = c.texW / c.texH;
      if (ta > ca) { sx = ca / ta; ox = (1 - sx) / 2; } else { sy = ta / ca; oy = (1 - sy) / 2; }
    }
    return [sx, sy, ox, oy];
  }
  function startStream(E, c, out) {
    const cell = 1.9;
    const cols = Math.max(8, Math.round(c.w / cell)), rows = Math.max(6, Math.round(c.h / cell));
    const s = buildStream(c, cols, rows);
    s.card = c; s.t0 = E.now(); s.out = !!out; s.cell = Math.max(c.w / cols, c.h / rows);
    s.src = [E.edgeX() + E.dirIn() * 2, c.pose.y]; s.spread = c.h / 2;
    s.tgt = out ? [c.pose.x, c.pose.y] : [c.target.x, c.target.y];
    streams.push(s);
    return s;
  }
  function sparkle(A, n, span, gain) {
    for (let i = 0; i < n; i++) {
      const f = PENTA[Math.floor(Math.random() * PENTA.length)] * (Math.random() < 0.3 ? 2 : 1);
      A.tone({ at: Math.random() * span, type: 'sine', f0: f, dur: rnd(0.06, 0.18), gain: gain * rnd(0.6, 1), attack: 0.003, pan: rnd(-0.6, 0.6), verb: 0.45 });
    }
  }

  const theme = {
    name: 'Teleport',
    restHold: 0.7,
    init() { ensure(1); },
    reset() { streams.length = 0; st.beam = 0; st.flare = 0; },
    busy() { return streams.length > 0 || st.beam > 0.01 || st.flare > 0.01; },

    lift(E, c) { c.revealMode = 0; },

    update(E, AP, s) {
      const p = Math.max(AP.p, AP.hold, (AP.hover || 0) * 0.8);
      st.beam = E.damp(st.beam, p, s * 1000, p > st.beam ? 50 : 120);
      st.flare *= Math.exp(-s / 0.18);
      const y = AP.p > 0.01 ? AP.y : AP.hold > 0 ? E.S.anchor * E.S.H : AP.hover > 0 ? AP.hoverY : st.beamY;
      st.beamY = E.damp(st.beamY || y, y, s * 1000, 30);
      st.beamH = AP.hold > 0 ? E.phoneH() * 0.45 : AP.card ? AP.card.h * 0.75 + 20 : 110;
      // sparks drift off the beam
      if (st.beam > 0.05 && Math.random() < st.beam * s * 70) {
        const dir = E.dirIn();
        E.glow({ x: E.edgeX() + dir * rnd(1, 18), y: st.beamY + rnd(-st.beamH, st.beamH), vx: dir * rnd(20, 90), vy: rnd(-25, 25), drag: 0.8,
          size: rnd(8, 16), color: SPARK, kind: 2, life: rnd(0.5, 1.1), alpha: rnd(0.5, 0.9) * st.beam, twinkle: rnd(14, 30) });
      }
      // a card crossing the edge is half-beamed: shows as a hologram
      for (const c of E.cards.values()) if (c.state === 'track') { c.revealMode = 2; c.revealColor = BEAM; }
      for (let i = streams.length - 1; i >= 0; i--) {
        const sm = streams[i];
        const age = (E.now() - sm.t0) / 1000;
        if (!sm.out) {
          const c = sm.card;
          // resolve the card out of the mosaic once the particles have landed
          if (age > 0.86 && c.hiddenOnPC) {
            c.hiddenOnPC = false; c.revealMode = 1; c.reveal = 0; c.revealAxis = E.dirIn() < 0 ? [-1, 0] : [1, 0]; c.revealColor = BEAM;
            c.revealT = E.now();
            E.A.tone({ type: 'sine', f0: 523.25, dur: 0.7, gain: 0.02, attack: 0.02, verb: 0.5 });
            E.A.tone({ type: 'sine', f0: 783.99, dur: 0.7, gain: 0.016, attack: 0.03, verb: 0.5 });
            E.A.tone({ type: 'sine', f0: 1046.5, dur: 0.8, gain: 0.012, attack: 0.04, verb: 0.5 });
          }
          if (c.revealT) {
            c.reveal = clamp((E.now() - c.revealT) / 380, 0, 1);
            if (c.reveal >= 1) { c.revealMode = 0; c.revealT = 0; }
          }
          sm.fade = 1 - clamp((age - 1.0) / 0.25, 0, 1);
          if (age > 1.3) streams.splice(i, 1);
        } else {
          sm.fade = 1;
          if (age > 1.05) streams.splice(i, 1);
        }
      }
    },

    launch(E, c) {
      c.hiddenOnPC = true;
      c.revealMode = 0;
      const sm = startStream(E, c, false);
      // the stream lands where the card will rest
      c.pose.x = c.target.x; c.pose.y = c.target.y; c.pose.rz = 0; c.pose.sx = c.pose.sy = 1; c.pose.z = 0;
      c.fl = { sm };
      st.flare = 1;
      E.A.noise({ dur: 0.75, type: 'bandpass', f0: 900, f1: 6200, q: 1.1, gain: 0.035, attack: 0.03, verb: 0.4 });
      sparkle(E.A, 22, 0.75, 0.016);
    },
    fly(E, c, ts) {
      c.prev = Object.assign({}, c.pose);
      return ts >= 0.9;
    },
    landed(E, c) {
      for (let i = 0; i < 14; i++) {
        E.glow({ x: c.pose.x + rnd(-c.w / 2, c.w / 2), y: c.pose.y + rnd(-c.h / 2, c.h / 2), size: rnd(10, 22), color: SPARK, kind: 2,
          life: rnd(0.5, 1.0), alpha: rnd(0.6, 1), twinkle: rnd(10, 22), fadeIn: rnd(0.02, 0.3) });
      }
    },

    connect(E) {
      const S = E.S, dir = E.dirIn(), ex = E.edgeX(), cy = S.anchor * S.H, ph = E.phoneH();
      st.flare = 1.4; st.beamY = cy;
      for (let i = 0; i < 240; i++) {
        const a = rnd(-1.05, 1.05), sp = rnd(260, 1500);
        E.glow({ x: ex + dir * 2, y: cy + rnd(-ph * 0.42, ph * 0.42), vx: dir * Math.cos(a) * sp, vy: Math.sin(a) * sp, drag: rnd(0.25, 0.5),
          size: rnd(6, 16), color: i % 3 ? SPARK : BEAM, kind: i % 4 ? 2 : 0, life: rnd(0.6, 1.3), alpha: rnd(0.5, 1), twinkle: rnd(10, 26) });
      }
      E.A.noise({ dur: 0.9, type: 'bandpass', f0: 600, f1: 5200, q: 1, gain: 0.04, attack: 0.02, verb: 0.45 });
      sparkle(E.A, 26, 0.8, 0.018);
    },

    outgoing(E, c) {
      c.hiddenOnPC = false; c.revealMode = 1; c.reveal = 1; c.revealAxis = E.dirIn() < 0 ? [1, 0] : [-1, 0]; c.revealColor = BEAM;
      c.fl = { sm: startStream(E, c, true) };
      sparkle(E.A, 16, 0.6, 0.015);
      E.A.noise({ dur: 0.6, type: 'bandpass', f0: 5200, f1: 900, q: 1, gain: 0.03, attack: 0.02, verb: 0.4 });
    },
    flyOut(E, c, ts) {
      c.reveal = 1 - clamp(ts / 0.4, 0, 1);
      if (c.reveal <= 0) c.hiddenOnPC = true;
      return ts > 1.05;
    },

    drawUnder() {},
    drawOver(E) {
      const gl = R.gl;
      // the beam: a hairline of light on the screen edge
      const b = Math.max(st.beam, st.flare);
      if (b > 0.01) {
        const ex = E.edgeX() + E.dirIn() * 1.5;
        const h = st.flare > st.beam ? Math.max(st.beamH, E.phoneH() * 0.45) : st.beamH;
        R.drawStreaks([{ x0: ex, y0: st.beamY - h, x1: ex, y1: st.beamY + h, w: 9, core: 1.4, color: BEAM, a0: 0.9 * Math.min(1, b), a1: 0.9 * Math.min(1, b) }]);
      }
      if (!streams.length) return;
      R.blendOver();
      R.bindTarget(null);
      const u = R.use(prog);
      for (const sm of streams) {
        const c = sm.card;
        if (!c.tex) continue;
        if (!sm.uploaded) {
          gl.bindVertexArray(vao);
          gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
          gl.bufferData(gl.ARRAY_BUFFER, sm.data, gl.DYNAMIC_DRAW);
          const la = gl.getAttribLocation(prog.p, 'aUV'), lr = gl.getAttribLocation(prog.p, 'aRnd');
          gl.enableVertexAttribArray(la); gl.vertexAttribPointer(la, 2, gl.FLOAT, false, 24, 0); gl.vertexAttribDivisor(la, 0);
          gl.enableVertexAttribArray(lr); gl.vertexAttribPointer(lr, 4, gl.FLOAT, false, 24, 8); gl.vertexAttribDivisor(lr, 0);
          sm.uploaded = true;
          streams.forEach((o) => { if (o !== sm) o.uploaded = false; });
        }
        gl.bindVertexArray(vao);
        gl.uniform1f(u.uT, (E.now() - sm.t0) / 1000);
        gl.uniform2f(u.uSrc, sm.src[0], sm.src[1]);
        gl.uniform1f(u.uSpread, sm.spread);
        gl.uniform2f(u.uTgt, sm.tgt[0], sm.tgt[1]);
        gl.uniform2f(u.uSize, c.w, c.h);
        gl.uniform1f(u.uDir, E.dirIn());
        gl.uniform1f(u.uCell, sm.cell);
        gl.uniform1f(u.uOut, sm.out ? 1 : 0);
        gl.uniform1f(u.uFade, sm.fade == null ? 1 : sm.fade);
        const cv = cover(c);
        gl.uniform4f(u.uCover, cv[0], cv[1], cv[2], cv[3]);
        R.bindTex(0, c.tex, u.uTex);
        gl.uniform1f(u.uHalo, 1);
        gl.drawArrays(gl.POINTS, 0, sm.n);
        gl.uniform1f(u.uHalo, 0);
        gl.drawArrays(gl.POINTS, 0, sm.n);
      }
    },
  };

  THEMES.teleport = theme;
})();
