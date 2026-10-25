'use strict';
/* Halo — the look from the original video, made properly: the desktop frosts toward the phone edge under a soft
   bloom; on release the screen fills with light and a thin glass edge with a spectral fringe sweeps it clear. */
(function () {
  const THEMES = (window.FLICK_THEMES = window.FLICK_THEMES || {});
  const R = window.GFX;
  let prog = null;
  const st = { frost: 0, reach: 0.2, bloom: 0, bloomR: 80, y: 0, flash: null };
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  const FS = `
in vec2 vUV;
uniform sampler2D uDesk; uniform sampler2D uBlur1; uniform sampler2D uBlur2; uniform sampler2D uBlur3;
uniform float uHasDesk; uniform vec2 uDeskUV;
uniform float uEdgeX; uniform float uEdgeY; uniform float uDir;
uniform float uFrost; uniform float uReach; uniform float uBloom; uniform float uBloomR;
uniform float uWipe; uniform float uWipeOn; uniform float uHaze;
out vec4 o;
vec3 frosted(vec2 uv, vec3 sharp, float f) {
  vec3 b1 = texture(uBlur1, uv).rgb, b2 = texture(uBlur2, uv).rgb, b3 = texture(uBlur3, uv).rgb;
  if (f < 0.33) return mix(sharp, b1, f / 0.33);
  if (f < 0.66) return mix(b1, b2, (f - 0.33) / 0.33);
  return mix(b2, b3, (f - 0.66) / 0.34);
}
void main() {
  vec2 p = fragDip();
  float dE = abs(p.x - uEdgeX);
  float f = uFrost * (1.0 - smoothstep(0.0, max(uReach * uRes.x, 1.0), dE));
  float s = (uWipe - p.x) * uDir;                                 // > 0: behind the glass edge (cleared)
  float cleared = uWipeOn > 0.5 ? smoothstep(-6.0, 70.0, s) : 0.0;
  float band = uWipeOn > 0.5 ? exp(-pow(s / 22.0, 2.0)) : 0.0;
  f *= 1.0 - cleared;
  float d = length((p - vec2(uEdgeX, uEdgeY)) * vec2(1.0, 0.9));
  float bl = uBloom * pow(1.0 / (1.0 + pow(d / max(uBloomR, 1.0), 2.0)), 1.35);
  vec3 col = vec3(1.0); float a;
  if (uHasDesk > 0.5) {
    vec2 uv = p * uDeskUV;
    vec3 sharp = texture(uDesk, uv).rgb;
    vec3 c = frosted(uv, sharp, f);
    // frosted glass scatters light: lift the shadows a little, keep a faint warm tint near the phone
    float warm = exp(-dE / (uRes.x * 0.35));
    c = mix(c, mix(vec3(0.94, 0.96, 1.0), vec3(1.0, 0.95, 0.97), warm), f * uHaze);
    // the glass edge: refracts what's behind it with a narrow spectral fringe
    if (band > 0.003) {
      // thick glass edge: content behind it is displaced, with a narrow spectral split
      float prof = s / 22.0;
      float off = band * 30.0 * uDir * sign(prof + 0.0001) * min(abs(prof) * 1.6, 1.0);
      vec3 rr;
      rr.r = texture(uDesk, (p + vec2(off * 0.75, 0.0)) * uDeskUV).r;
      rr.g = texture(uDesk, (p + vec2(off * 1.2, 0.0)) * uDeskUV).g;
      rr.b = texture(uDesk, (p + vec2(off * 1.75, 0.0)) * uDeskUV).b;
      c = mix(c, rr, band);
      float hi = exp(-pow((s - 3.0) / 2.2, 2.0));              // crisp highlight on the leading face
      float lo = exp(-pow((s + 6.0) / 3.5, 2.0));              // thin dark inner edge
      c = c * (1.0 - lo * 0.16) + hi * 0.3 + band * 0.05;
    }
    c = mix(c, vec3(1.0, 0.985, 0.99), clamp(bl, 0.0, 1.0));
    col = c;
    a = clamp(max(max(f * 3.0, bl * 1.4), band * 1.2), 0.0, 1.0);
  } else {
    col = vec3(1.0, 0.985, 0.99);
    a = clamp(bl * 0.95 + f * 0.25 + band * 0.25, 0.0, 1.0);
  }
  o = vec4(clamp(col, 0.0, 1.0) * a, a);
}`;

  function solveTau(D, v, T) {
    if (D < 1 || v <= (D / T) * 1.05) return T * 6;
    let lo = 0.004, hi = 30;
    for (let i = 0; i < 50; i++) { const m = (lo + hi) / 2; if (D / (m * (1 - Math.exp(-T / m))) > v) lo = m; else hi = m; }
    return (lo + hi) / 2;
  }
  function flash(E, y, big) {
    st.flash = { t0: E.now(), y, big, from: E.edgeX(), to: E.edgeX() + E.dirIn() * (E.S.W + 120) };
    const A = E.A;
    A.noise({ dur: 0.5, type: 'bandpass', f0: 3600, f1: 520, q: 0.7, gain: big ? 0.07 : 0.055, attack: 0.008, verb: 0.35 });
    if (big) { A.tone({ type: 'sine', f0: 1318.5, dur: 0.9, gain: 0.03, attack: 0.006, verb: 0.55 }); A.tone({ at: 0.05, type: 'sine', f0: 1975.5, dur: 1.0, gain: 0.022, attack: 0.006, verb: 0.55 }); }
  }

  const theme = {
    name: 'Halo',
    restHold: 0.35,
    init() { prog = R.fsProgram(R.HEAD + R.FCOMMON + FS, 'halo.bg'); },
    reset() { st.frost = 0; st.bloom = 0; st.flash = null; },
    busy() { return st.frost > 0.004 || st.bloom > 0.004 || !!st.flash; },
    update(E, AP, s) {
      const ms = s * 1000;
      const p = Math.max(AP.p, AP.hold * 0.9, (AP.hover || 0) * 0.8);
      const y = AP.p > 0.01 ? AP.y : AP.hold > 0 ? E.S.anchor * E.S.H : AP.hover > 0 ? AP.hoverY : st.y;
      st.y = E.damp(st.y || y, y, ms, 30);
      let frost = 0.78 * p, reach = 0.18 + 0.42 * p, bloom = 0.92 * Math.pow(p, 1.25), bloomR = (60 + 300 * p) * (AP.crossing ? 1.15 : 1);
      if (st.flash) {
        const u = (E.now() - st.flash.t0) / 1000;
        const k = st.flash.big ? 1 : 0.85;
        // the screen fills with light, then the glass edge sweeps it clear
        frost = Math.max(frost, u < 0.1 ? u / 0.1 : 1) * k;
        reach = 1.25;
        bloom = Math.max(bloom, (u < 0.12 ? E.sstep(0, 0.12, u) : 1 - E.sstep(0.12, 0.75, u)) * k);
        bloomR = E.S.H * (0.35 + 0.5 * E.sstep(0, 0.2, u));
        st.y = st.flash.y;
        if (u > 1.05) {
          // the glass edge has crossed the whole screen: everything behind it is already clear
          st.flash = null;
          st.frost = Math.min(st.frost, 0.78 * p);
          st.bloom = Math.min(st.bloom, 0.92 * Math.pow(p, 1.25));
          frost = 0.78 * p;
        }
      }
      st.frost = E.damp(st.frost, frost, ms, frost > st.frost ? 40 : 120);
      st.reach = E.damp(st.reach, reach, ms, 60);
      st.bloom = E.damp(st.bloom, bloom, ms, bloom > st.bloom ? 25 : 90);
      st.bloomR = E.damp(st.bloomR, bloomR, ms, 40);
    },

    launch(E, c) {
      const L = c.launch;
      const fl = (c.fl = {});
      fl.T = 0.95; fl.x0 = L.x0; fl.y0 = L.y0; fl.tx = c.target.x; fl.ty = c.target.y;
      fl.tau = solveTau(Math.abs(fl.tx - fl.x0), Math.max(Math.abs(L.vx) * 1000, 1500), fl.T);
      c.gloss = 0.4;
      flash(E, c.pose.y, false);
    },
    fly(E, c, ts) {
      const fl = c.fl, T = fl.T, t = Math.min(ts, T);
      const ex = (1 - Math.exp(-t / fl.tau)) / (1 - Math.exp(-T / fl.tau));
      c.pose.x = fl.x0 + (fl.tx - fl.x0) * ex;
      c.pose.y = fl.y0 + (fl.ty - fl.y0) * (ex * ex * (3 - 2 * ex));
      c.pose.rz = c.launch.r0 * (1 - E.sstep(0, 0.6, t));
      c.pose.sx = c.pose.sy = c.launch.s0 + (1 - c.launch.s0) * E.sstep(0.2, 0.95, t);
      c.pose.z = 0;
      return ts >= T;
    },
    landed(E) { E.A.tone({ type: 'sine', f0: 220, f1: 150, sweep: 0.08, dur: 0.12, gain: 0.05, attack: 0.003 }); },

    connect(E) { flash(E, E.S.anchor * E.S.H, true); },

    outgoing(E, c) { c.fl = { x0: c.pose.x, d: -E.dirIn() }; st.flash = null; },
    flyOut(E, c, ts) {
      c.pose.x = c.fl.x0 + c.fl.d * (1300 * ts * ts + 120 * ts);
      st.y = c.pose.y;
      st.bloom = Math.max(st.bloom, 0.75 * (1 - E.sstep(0.15, 0.45, ts)));
      st.bloomR = 160;
      const over = E.S.side === 'right' ? c.pose.x - c.w / 2 - E.S.W : -(c.pose.x + c.w / 2);
      return over > 10 || ts > 1.2;
    },

    drawBackground(E) {
      const wipeOn = !!st.flash && (E.now() - st.flash.t0) / 1000 > 0.12;
      if (st.frost < 0.004 && st.bloom < 0.004 && !wipeOn) return;
      const gl = R.gl;
      const u = R.use(prog);
      R.bindDesk(u, 0);
      gl.uniform1f(u.uEdgeX, E.edgeX());
      gl.uniform1f(u.uEdgeY, st.y);
      gl.uniform1f(u.uDir, E.dirIn());
      gl.uniform1f(u.uFrost, clamp(st.frost, 0, 1));
      gl.uniform1f(u.uReach, st.reach);
      gl.uniform1f(u.uBloom, clamp(st.bloom, 0, 1.2));
      gl.uniform1f(u.uBloomR, st.bloomR);
      gl.uniform1f(u.uHaze, 0.2);
      let wipe = E.edgeX();
      if (wipeOn) {
        const u2 = clamp(((E.now() - st.flash.t0) / 1000 - 0.12) / 0.78, 0, 1);
        const e = 1 - Math.pow(1 - u2, 2.4);
        wipe = st.flash.from + (st.flash.to - st.flash.from) * e;
      }
      gl.uniform1f(u.uWipe, wipe);
      gl.uniform1f(u.uWipeOn, wipeOn ? 1 : 0);
      R.blendOver();
      R.bindTarget(null);
      R.tri();
    },
  };

  THEMES.halo = theme;
})();
