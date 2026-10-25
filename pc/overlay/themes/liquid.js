'use strict';
/* Liquid — the desktop behaves like water. Ripples refract the real desktop; the file skims across and floats. */
(function () {
  const THEMES = (window.FLICK_THEMES = window.FLICK_THEMES || {});
  const R = window.GFX;
  const MAXW = 8;
  const waves = [];                 // {x,y,t0,amp,speed,len,decay,width}
  const men = { x: 0, y: 0, rx: 80, ry: 120, k: 0 };   // meniscus bulge at the edge
  let hProg = null, cProg = null, hT = null;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const rnd = (a, b) => a + Math.random() * (b - a);

  const FS_HEIGHT = `
in vec2 vUV;
uniform vec4 uW[${MAXW}]; uniform vec4 uWP[${MAXW}]; uniform int uNW;
uniform vec4 uMen; uniform float uMenK; uniform vec2 uTexSize; uniform float uNow;
out vec4 o;
float waveH(vec2 p, vec4 w, vec4 wp) {
  float tau = uNow - w.z;
  if (tau <= 0.0) return 0.0;
  vec2 dp = p - w.xy;
  float r = length(dp);
  // a slight wobble so the rings are never perfect circles (seeded by the wave's origin, stable over time)
  float th = atan(dp.y, dp.x), sd = w.x * 0.013 + w.y * 0.007;
  r += (sin(th * 3.0 + sd) * 0.6 + sin(th * 5.0 - sd * 1.7) * 0.4) * min(r * 0.012, 3.5);
  float x = r - wp.x * tau;                                   // > 0: not reached yet
  // a short packet: a sharp leading front and only a few crests behind it
  float env = x > 0.0 ? exp(-x * x / (wp.w * wp.w * 0.10)) : exp(-x * x / (wp.w * wp.w * 0.6));
  // dispersion: the crests behind the front bunch up
  float k = 6.2831853 / wp.y * (1.0 + 0.3 * clamp(-x / wp.w, 0.0, 2.0));
  return w.w * env * cos(k * x) * exp(-tau * wp.z) / sqrt(1.0 + r / 140.0);
}
void main() {
  vec2 p = vUV * uRes;                                         // DIP (texel space, y down = row order)
  vec2 d = (p - uMen.xy) / uMen.zw;
  float h = uMenK * exp(-dot(d, d));
  for (int i = 0; i < ${MAXW}; i++) { if (i >= uNW) break; h += waveH(p, uW[i], uWP[i]); }
  o = vec4(h, 0.0, 0.0, 1.0);
}`;

  const FS_COMP = `
in vec2 vUV;
uniform sampler2D uH; uniform vec2 uHTexel; uniform float uHScale;
uniform sampler2D uDesk; uniform float uHasDesk; uniform vec2 uDeskUV;
uniform float uRefr;
out vec4 o;
float hAt(vec2 p) { return texture(uH, p / uRes).r * uHScale; }
void main() {
  vec2 p = fragDip();
  vec2 e = uHTexel * uRes;                                     // one height texel in DIP
  float h = hAt(p);
  float hx1 = hAt(p + vec2(e.x, 0.0)), hx0 = hAt(p - vec2(e.x, 0.0));
  float hy1 = hAt(p + vec2(0.0, e.y)), hy0 = hAt(p - vec2(0.0, e.y));
  vec2 g = vec2(hx1 - hx0, hy1 - hy0) / (2.0 * e);
  float lap = (hx1 + hx0 + hy1 + hy0 - 4.0 * h) / (e.x * e.y);
  float slope = length(g);
  float act = smoothstep(0.004, 0.04, slope) + smoothstep(0.4, 2.5, abs(h));
  act = clamp(act, 0.0, 1.0);
  if (act < 0.002) { o = vec4(0.0); return; }
  // water is seen almost straight on: what you mostly see is the desktop bent by the surface,
  // with small glints only where a steep crest catches the light
  vec3 N = normalize(vec3(-g, 1.0));
  vec3 L = normalize(vec3(-0.5, -0.7, 0.9));
  vec3 Rr = reflect(-L, N);
  float rz = max(Rr.z, 0.0), rz0 = reflect(-L, vec3(0.0, 0.0, 1.0)).z;
  float spec = max(pow(rz, 700.0) - pow(rz0, 700.0), 0.0) * 0.75;
  float sheen = max(pow(rz, 12.0) - pow(rz0, 12.0), 0.0);
  vec3 col; float a;
  if (uHasDesk > 0.5) {
    vec2 off = -g * uRefr;
    vec3 c;
    c.r = texture(uDesk, (p + off * 1.00) * uDeskUV).r;
    c.g = texture(uDesk, (p + off * 1.04) * uDeskUV).g;
    c.b = texture(uDesk, (p + off * 1.09) * uDeskUV).b;
    float lum = dot(c, vec3(0.299, 0.587, 0.114));
    c *= 1.0 + clamp(-lap * 1.4, -0.045, 0.06);                 // faint light focusing under crests
    c = mix(c, vec3(0.04, 0.13, 0.19), clamp(-h * 0.006, 0.0, 0.04)); // troughs a hair deeper
    c += (sheen * 0.035 + spec) * (1.0 - 0.65 * lum);           // reflections read on dark areas, never chalk bright ones
    col = c; a = act;
  } else {
    col = vec3(1.0); a = clamp(spec + sheen * 0.2, 0.0, 1.0) * act;
  }
  o = vec4(clamp(col, 0.0, 1.0) * a, a);
}`;

  function addWave(o) {
    if (waves.length >= MAXW) waves.shift();
    waves.push(Object.assign({ amp: 6, speed: 700, len: 72, decay: 1.25, width: 150 }, o));
  }
  function heightAt(E, x, y) {
    const now = E.now() / 1000;
    let h = 0;
    const dx = (x - men.x) / men.rx, dy = (y - men.y) / men.ry;
    h += men.k * Math.exp(-(dx * dx + dy * dy));
    for (const w of waves) {
      const tau = now - w.t0; if (tau <= 0) continue;
      const r = Math.hypot(x - w.x, y - w.y);
      const xx = r - w.speed * tau;
      const env = xx > 0 ? Math.exp(-xx * xx / (w.width * w.width * 0.10)) : Math.exp(-xx * xx / (w.width * w.width * 0.6));
      const k = (6.2831853 / w.len) * (1 + 0.3 * clamp(-xx / w.width, 0, 2));
      h += w.amp * env * Math.cos(k * xx) * Math.exp(-tau * w.decay) / Math.sqrt(1 + r / 140);
    }
    return h;
  }

  function solveTau(D, v, T) {
    if (D < 1 || v <= (D / T) * 1.05) return T * 6;
    let lo = 0.004, hi = 30;
    for (let i = 0; i < 50; i++) { const m = (lo + hi) / 2; if (D / (m * (1 - Math.exp(-T / m))) > v) lo = m; else hi = m; }
    return (lo + hi) / 2;
  }
  function bloop(A, f0, f1, dur, gain) {
    A.tone({ type: 'sine', f0, f1, sweep: dur, dur: dur * 1.6, gain, attack: 0.004, verb: 0.45 });
  }

  const theme = {
    name: 'Liquid',
    restHold: 0.45,
    init() {
      hProg = R.fsProgram(R.HEAD + R.FCOMMON + FS_HEIGHT, 'liquid.h');
      cProg = R.fsProgram(R.HEAD + R.FCOMMON + FS_COMP, 'liquid.c');
    },
    reset() { waves.length = 0; men.k = 0; },
    busy(E) {
      const now = E.now() / 1000;
      return men.k > 0.05 || waves.some((w) => w.amp * Math.exp(-(now - w.t0) * w.decay) > 0.08 && now - w.t0 < 4);
    },
    update(E, AP, s) {
      const now = E.now() / 1000;
      for (let i = waves.length - 1; i >= 0; i--) {
        const w = waves[i];
        if (now - w.t0 > 4 || w.amp * Math.exp(-(now - w.t0) * w.decay) < 0.05) waves.splice(i, 1);
      }
      // meniscus: the water at the edge bulges toward the approaching file
      const dir = E.dirIn();
      let target = 0, mx = E.edgeX(), my = men.y || E.S.anchor * E.S.H, ry = 120;
      if (AP.p > 0.01 && AP.card) {
        target = 7 * AP.p;
        my = AP.y;
        ry = (AP.card.h * 0.5 + 40) * (0.8 + 0.4 * AP.p);
        const lead = AP.card.pose.x + dir * (AP.card.w * (AP.card.pose.sx || 1)) / 2;   // leading edge of the card
        mx = AP.crossing ? lead + dir * 8 : E.edgeX() - dir * (1 - AP.p) * 60;
      } else if (AP.hold > 0) { target = 9 * AP.hold; my = E.S.anchor * E.S.H; ry = E.phoneH() * 0.42; mx = E.edgeX(); }
      else if (AP.hover > 0) { target = 6 * AP.hover; my = AP.hoverY; ry = 140; mx = E.edgeX(); }
      men.k = E.damp(men.k, target, s * 1000, target > men.k ? 70 : 140);
      men.x = E.damp(men.x || mx, mx, s * 1000, 25); men.y = E.damp(men.y || my, my, s * 1000, 25);
      men.ry = E.damp(men.ry, ry, s * 1000, 60); men.rx = 70 + 50 * Math.min(1, men.k / 7);
      // floating cards ride the waves
      for (const c of E.cards.values()) {
        if (c.state !== 'rest' && c.state !== 'icon') continue;
        const h = heightAt(E, c.pose.x, c.pose.y);
        const gx = (heightAt(E, c.pose.x + 6, c.pose.y) - heightAt(E, c.pose.x - 6, c.pose.y)) / 12;
        const gy = (heightAt(E, c.pose.x, c.pose.y + 6) - heightAt(E, c.pose.x, c.pose.y - 6)) / 12;
        c.pose.z = h * 2.2;
        c.pose.ry = -gx * 0.9; c.pose.rx = gy * 0.9;
      }
    },

    launch(E, c) {
      const L = c.launch, dir = E.dirIn();
      const fl = (c.fl = {});
      fl.T = 1.0; fl.x0 = L.x0; fl.y0 = L.y0; fl.tx = c.target.x; fl.ty = c.target.y;
      fl.tau = solveTau(Math.abs(fl.tx - fl.x0), Math.max(Math.abs(L.vx) * 1000, 1600), fl.T);
      fl.skipAt = 0.36; fl.skipped = false;
      c.gloss = 1.0;
      const now = E.now() / 1000;
      addWave({ x: E.edgeX() + dir * 6, y: L.y0, t0: now, amp: 9, speed: 760, len: 72, decay: 1.25, width: 190 });
      men.k = 0;
      bloop(E.A, 560, 150, 0.13, 0.11);
      E.A.noise({ dur: 0.38, type: 'bandpass', f0: 1500, f1: 420, q: 0.9, gain: 0.06, attack: 0.004, verb: 0.4 });
    },
    fly(E, c, ts) {
      const fl = c.fl, T = fl.T;
      const t = Math.min(ts, T);
      const ex = (1 - Math.exp(-t / fl.tau)) / (1 - Math.exp(-T / fl.tau));
      c.pose.x = fl.x0 + (fl.tx - fl.x0) * ex;
      c.pose.y = fl.y0 + (fl.ty - fl.y0) * (ex * ex * (3 - 2 * ex));
      // one skim: a low hop that touches down again
      const hop = t > 0.05 && t < fl.skipAt ? Math.sin(((t - 0.05) / (fl.skipAt - 0.05)) * Math.PI) : 0;
      c.pose.z = 34 * hop;
      c.pose.ry = -E.dirIn() * 0.16 * hop;
      c.pose.rz = c.launch.r0 * (1 - E.sstep(0, 0.5, t));
      c.pose.sx = c.pose.sy = c.launch.s0 + (1 - c.launch.s0) * E.sstep(0, 0.35, t);
      if (!fl.skipped && t >= fl.skipAt) {
        fl.skipped = true;
        addWave({ x: c.pose.x, y: c.pose.y, t0: E.now() / 1000, amp: 5.5, speed: 620, len: 60, decay: 1.4, width: 130 });
        bloop(E.A, 760, 260, 0.08, 0.06);
      }
      return ts >= T;
    },
    landed(E, c) {
      addWave({ x: c.pose.x, y: c.pose.y, t0: E.now() / 1000, amp: 4.5, speed: 520, len: 54, decay: 1.5, width: 120 });
      bloop(E.A, 420, 190, 0.09, 0.045);
    },

    connect(E) {
      const S = E.S;
      addWave({ x: E.edgeX(), y: S.anchor * S.H, t0: E.now() / 1000, amp: 10, speed: 1250, len: 120, decay: 0.75, width: 280 });
      men.k = 0;
      bloop(E.A, 320, 78, 0.3, 0.14);
      E.A.noise({ dur: 1.1, type: 'lowpass', f0: 1100, f1: 260, q: 0.5, gain: 0.04, attack: 0.03, verb: 0.5 });
    },

    outgoing(E, c) {
      c.fl = { x0: c.pose.x, d: -E.dirIn(), waved: false };
      c.gloss = 1.0;
    },
    flyOut(E, c, ts) {
      const fl = c.fl;
      c.pose.x = fl.x0 + fl.d * (1400 * ts * ts + 90 * ts);
      const over = E.S.side === 'right' ? c.pose.x + c.w / 2 - E.S.W : -(c.pose.x - c.w / 2);
      if (!fl.waved && over > -10) {
        fl.waved = true;
        addWave({ x: E.edgeX(), y: c.pose.y, t0: E.now() / 1000, amp: 7, speed: 700, len: 66, decay: 1.2, width: 150 });
        bloop(E.A, 300, 620, 0.12, 0.08);
      }
      c.bright = 1 - 0.25 * E.sstep(0, 0.4, ts);
      return over > c.w + 20 || ts > 1.2;
    },

    drawBackground(E) {
      if (!waves.length && men.k < 0.05) return;
      const sz = R.size();
      const tw = Math.max(64, Math.round(sz.W / 3)), th = Math.max(64, Math.round(sz.H / 3));
      if (!hT || hT.w !== tw || hT.h !== th) { if (hT) R.freeTarget(hT); hT = R.target(tw, th, true); }
      const gl = R.gl;
      // 1) height field at 1/3 resolution
      R.blendOff();
      R.bindTarget(hT);
      let u = R.use(hProg);
      const now = E.now() / 1000;
      const W = new Float32Array(MAXW * 4), WP = new Float32Array(MAXW * 4);
      // times relative to now keep full float precision on the GPU
      waves.forEach((w, i) => { W.set([w.x, w.y, w.t0 - now, w.amp], i * 4); WP.set([w.speed, w.len, w.decay, w.width], i * 4); });
      gl.uniform4fv(u.uW, W); gl.uniform4fv(u.uWP, WP); gl.uniform1i(u.uNW, waves.length);
      gl.uniform4f(u.uMen, men.x, men.y, men.rx, men.ry); gl.uniform1f(u.uMenK, men.k);
      gl.uniform1f(u.uNow, 0);
      R.tri();
      // 2) refract the desktop through it
      R.bindTarget(null);
      R.blendOver();
      u = R.use(cProg);
      R.bindTex(1, hT.tex, u.uH);
      gl.uniform2f(u.uHTexel, 1 / tw, 1 / th);
      gl.uniform1f(u.uHScale, 1);
      gl.uniform1f(u.uRefr, 22);
      R.bindDesk(u, 2);
      R.tri();
    },
  };

  THEMES.liquid = theme;
})();
