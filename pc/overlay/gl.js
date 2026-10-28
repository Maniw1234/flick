'use strict';
/* Flick overlay — WebGL2 renderer core.
   Units are DIP (CSS px): x right, y down, z toward the viewer (z > 0 = lifted off the desktop).
   Everything is drawn premultiplied and composited "over" the real desktop. */
(function () {
  const R = {};
  window.GFX = R;

  let gl = null, canvas = null;
  let W = 1, H = 1, DPR = 1, FOCAL = 1000, CW = 1, CH = 1;
  let fullW = 1, fullH = 1;                 // display size (DIP) that the desktop capture covers
  let floatTargets = false;
  const P = {};                             // programs
  let triVAO, quadVAO, quadVBO;
  let spriteVAO, spriteVBO, streakVAO, streakVBO, vdenVAO;
  let vden = null;                          // vapor density target
  let acc = null;                           // motion-blur accumulation target
  let time = 0;

  const desk = { raw: null, tex: null, w: 0, h: 0, blur: [], ok: false, at: 0 };

  // ------------------------------------------------------------------ GLSL
  const HEAD = '#version 300 es\nprecision highp float;\nprecision highp int;\n';
  const COMMON = `
uniform vec2 uRes; uniform float uFocal; uniform float uTime; uniform float uDpr; uniform float uCanvasH;
vec4 project(vec3 P) {
  vec2 c = P.xy - uRes * 0.5; float d = max(uFocal - P.z, 1.0);
  return vec4(c.x * uFocal / (uRes.x * 0.5), -c.y * uFocal / (uRes.y * 0.5), 0.0, d);
}
float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float vnoise(vec2 p) { vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3. - 2. * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y); }
float fbm(vec2 p) { float a = .5, s = 0.; for (int i = 0; i < 4; i++) { s += a * vnoise(p); p = p * 2.03 + vec2(1.7, 9.2); a *= .5; } return s; }
float sdRR(vec2 p, vec2 b, float r) { vec2 q = abs(p) - b + r; return length(max(q, 0.)) + min(max(q.x, q.y), 0.) - r; }
`;
  const FCOMMON = COMMON + `
vec2 fragDip() { return vec2(gl_FragCoord.x, uCanvasH - gl_FragCoord.y) / uDpr; }
`;
  R.HEAD = HEAD; R.COMMON = COMMON; R.FCOMMON = FCOMMON;

  const VS_TRI = HEAD + `
out vec2 vUV;
void main() { vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2); vUV = p; gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }`;

  // desk conversion (raw BGRA bytes → RGBA texture), copy & blur chain (texel space, no flips)
  const FS_CONVERT = HEAD + `
in vec2 vUV; uniform sampler2D uSrc; uniform float uSwz; out vec4 o;
void main() { vec4 c = texture(uSrc, vUV); o = vec4(uSwz > 0.5 ? c.bgr : c.rgb, 1.0); }`;
  const FS_DOWN = HEAD + `
in vec2 vUV; uniform sampler2D uSrc; uniform vec2 uTexel; out vec4 o;
void main() { vec2 h = uTexel * 0.5;
  vec4 s = texture(uSrc, vUV) * 4.0 + texture(uSrc, vUV - h) + texture(uSrc, vUV + h)
         + texture(uSrc, vUV + vec2(h.x, -h.y)) + texture(uSrc, vUV - vec2(h.x, -h.y));
  o = s / 8.0; }`;
  const FS_UP = HEAD + `
in vec2 vUV; uniform sampler2D uSrc; uniform vec2 uTexel; out vec4 o;
void main() { vec2 h = uTexel * 0.5;
  vec4 s = texture(uSrc, vUV + vec2(-h.x * 2.0, 0.0)) + texture(uSrc, vUV + vec2(-h.x, h.y)) * 2.0
         + texture(uSrc, vUV + vec2(0.0, h.y * 2.0)) + texture(uSrc, vUV + vec2(h.x, h.y)) * 2.0
         + texture(uSrc, vUV + vec2(h.x * 2.0, 0.0)) + texture(uSrc, vUV + vec2(h.x, -h.y)) * 2.0
         + texture(uSrc, vUV + vec2(0.0, -h.y * 2.0)) + texture(uSrc, vUV + vec2(-h.x, -h.y)) * 2.0;
  o = s / 12.0; }`;
  const FS_COMPOSITE = HEAD + `
in vec2 vUV; uniform sampler2D uSrc; out vec4 o;
void main() { vec4 c = texture(uSrc, vUV); o = c.a > 0.0001 ? vec4(min(c.rgb, vec3(c.a)), min(c.a, 1.0)) : vec4(0.0); }`;

  // ---- cards: perspective quads with lighting, back face, reveal mask
  const VS_CARD = HEAD + COMMON + `
in vec2 aCorner;
uniform mat4 uModel; uniform vec2 uSize;
out vec2 vUV; out vec3 vPos;
void main() { vec4 w = uModel * vec4(aCorner * uSize, 0.0, 1.0); vPos = w.xyz; vUV = aCorner + 0.5; gl_Position = project(w.xyz); }`;
  const FS_CARD = HEAD + FCOMMON + `
in vec2 vUV; in vec3 vPos;
uniform sampler2D uTex; uniform float uHasTex; uniform vec2 uSize; uniform float uRadius;
uniform vec3 uNormal; uniform float uOpacity; uniform float uWeight; uniform float uGloss;
uniform int uBack; uniform vec4 uCover; uniform float uSat; uniform float uBright;
uniform float uReveal; uniform int uRevealMode; uniform vec2 uRevealAxis; uniform vec3 uRevealColor;
out vec4 o;
vec3 carbon(vec2 p, vec3 N, vec3 V, vec3 L) {
  vec2 g = p / 5.0; vec2 cell = floor(g); vec2 f = fract(g);
  float tw = mod(cell.x + cell.y, 2.0);
  float stripe = tw > 0.5 ? f.x : f.y;
  float weave = 0.55 + 0.45 * sin(stripe * 3.14159);
  vec3 base = vec3(0.055, 0.06, 0.068) + weave * 0.045;
  vec3 Hh = normalize(L + V);
  float aniso = pow(max(dot(N, Hh), 0.0), 18.0) * (tw > 0.5 ? 0.22 : 0.12);
  return base + aniso;
}
void main() {
  vec2 p = (vUV - 0.5) * uSize;
  float d = sdRR(p, uSize * 0.5, uRadius);
  float aa = max(fwidth(d) * 0.75, 0.35);
  float mask = 1.0 - smoothstep(-aa, aa, d);
  if (mask <= 0.002) discard;
  vec3 cam = vec3(uRes * 0.5, uFocal);
  vec3 V = normalize(cam - vPos);
  float facing = dot(uNormal, V);
  vec3 N = facing >= 0.0 ? uNormal : -uNormal;
  vec3 L = normalize(vec3(-0.5, -0.7, 0.9));
  vec3 col;
  if (facing >= 0.0) {
    vec2 uv = vUV * uCover.xy + uCover.zw;
    col = uHasTex > 0.5 ? texture(uTex, uv).rgb : vec3(0.95);
    float l = dot(col, vec3(0.299, 0.587, 0.114));
    col = mix(vec3(l), col, uSat) * uBright;
  } else if (uBack == 1) {
    // glossy white paint (clear-coat gradient)
    float gy = vUV.y;
    col = mix(vec3(0.975, 0.98, 0.985), vec3(0.83, 0.85, 0.87), gy * gy);
  } else if (uBack == 2) {
    col = carbon(vec2(-p.x, p.y), N, V, L);
  } else {
    col = vec3(0.90, 0.905, 0.91) - vnoise(p * 0.9) * 0.025;
  }
  float diff = clamp(dot(N, L), 0.0, 1.0);
  float shade = 1.0 + (diff - L.z) * 0.55;
  // specular uses an orthographic view vector so a resting card never glares, only a tilting one
  vec3 Hh = normalize(L + vec3(0.0, 0.0, 1.0));
  float spec = pow(max(dot(N, Hh), 0.0), 64.0) * uGloss;
  spec = max(spec - pow(Hh.z, 64.0) * uGloss, 0.0);
  float tilt = 1.0 - abs(N.z);
  float rim = (1.0 - smoothstep(0.0, 1.6, -d)) * (0.05 + 0.3 * tilt);
  col = col * shade + spec + rim * (facing >= 0.0 ? 1.0 : 0.4);
  float a = mask * uOpacity;
  if (uRevealMode > 0) {
    // reveal: 0 → hidden, 1 → fully shown, sweeping along uRevealAxis with a hot edge
    float s = dot(vUV - 0.5, uRevealAxis) + 0.5;
    float n = fbm(p * 0.09 + 3.7) * 0.35;
    float edge = uReveal * 1.45 - 0.2;
    float v = s + n - edge;                          // < 0 → revealed
    float shown = 1.0 - smoothstep(-0.02, 0.02, v);
    float hot = exp(-v * v * 900.0) * step(-0.25, v);
    if (uRevealMode == 2) {                          // hologram (partly beamed)
      float scan = 0.65 + 0.35 * sin(vPos.y * 1.9 + uTime * 9.0);
      col = mix(col, uRevealColor, 0.35) * scan + uRevealColor * 0.25;
      a *= 0.55 + 0.25 * vnoise(p * 0.4 + uTime * 3.0);
    } else {
      col = mix(col, uRevealColor * 1.4, clamp(hot, 0.0, 1.0));
      a *= max(shown, hot * 0.9);
    }
  }
  o = vec4(clamp(col, 0.0, 1.0) * a, a) * uWeight;
}`;

  // ---- soft shadow of a rounded rect on the desktop plane
  const VS_SHADOW = HEAD + COMMON + `
in vec2 aCorner;
uniform vec2 uCenter; uniform vec2 uHalfExt; uniform float uAngle;
out vec2 vLocal;
void main() {
  vec2 l = aCorner * 2.0 * uHalfExt; vLocal = l;
  float c = cos(uAngle), s = sin(uAngle);
  vec2 w = uCenter + vec2(l.x * c - l.y * s, l.x * s + l.y * c);
  gl_Position = project(vec3(w, 0.0));
}`;
  const FS_SHADOW = HEAD + FCOMMON + `
in vec2 vLocal; uniform vec2 uHalf; uniform float uRadius; uniform float uBlur; uniform float uOpacity; out vec4 o;
void main() {
  float d = sdRR(vLocal, uHalf, uRadius);
  float a = uOpacity * (1.0 - smoothstep(-uBlur * 0.9, uBlur * 1.1, d));
  o = vec4(0.0, 0.0, 0.0, a);
}`;

  // ---- instanced sprites: 0 glow, 1 vapor, 2 spark, 3 lamp, 4 ring
  const VS_SPRITE = HEAD + COMMON + `
in vec2 aCorner;
in vec3 iPos; in vec4 iShape; in vec3 iColor; in vec4 iMisc;   // shape: size, rot, stretchX, stretchY | misc: alpha, seed, kind, life
out vec2 vUV; out vec3 vColor; out float vAlpha; out float vSeed; out float vLife; flat out int vKind;
void main() {
  vec2 c = aCorner * iShape.x * iShape.zw;
  float cs = cos(iShape.y), sn = sin(iShape.y);
  vec3 P = iPos + vec3(c.x * cs - c.y * sn, c.x * sn + c.y * cs, 0.0);
  gl_Position = project(P);
  vUV = aCorner * 2.0; vColor = iColor; vAlpha = iMisc.x; vSeed = iMisc.y; vKind = int(iMisc.z + 0.5); vLife = iMisc.w;
}`;
  const FS_SPRITE = HEAD + FCOMMON + `
in vec2 vUV; in vec3 vColor; in float vAlpha; in float vSeed; in float vLife; flat in int vKind; out vec4 o;
void main() {
  float r = length(vUV);
  vec3 col = vColor; float a = 0.0;
  if (vKind == 0) {                    // soft glow
    a = exp(-r * r * 5.5) * 0.85 + exp(-r * r * 22.0) * 0.6;
    col = mix(vColor, vec3(1.0), exp(-r * r * 30.0));
  } else if (vKind == 1) {             // vapor: soft billowing cloud, domain-warped low-frequency noise
    vec2 q = vUV * 0.8 + vec2(vSeed * 13.1, vSeed * 7.7);
    vec2 warp = vec2(fbm(q + vec2(1.7, 9.2) + vLife * 0.35), fbm(q + vec2(8.3, 2.8) - vLife * 0.3));
    float n = fbm(q + warp * 0.9);
    float g = exp(-r * r * 2.3);
    float dens = smoothstep(0.12, 0.78, g * (0.55 + 0.95 * n));
    float edge = 1.0 - smoothstep(0.82, 1.0, r);
    dens *= edge;
    float light = 0.8 + 0.2 * clamp(-(vUV.x * 0.55 + vUV.y * 0.75), -1.0, 1.0) + (n - 0.45) * 0.35;
    col = vColor * clamp(light, 0.62, 1.04);
    a = dens;
  } else if (vKind == 2) {             // spark / star glint
    float core = exp(-r * r * 40.0);
    float rays = max(0.0, 1.0 - abs(vUV.x) * 14.0) * max(0.0, 1.0 - abs(vUV.y)) + max(0.0, 1.0 - abs(vUV.y) * 14.0) * max(0.0, 1.0 - abs(vUV.x));
    a = core + rays * 0.55 + exp(-r * r * 6.0) * 0.25;
    col = mix(vColor, vec3(1.0), core);
  } else if (vKind == 3) {             // lamp: crisp disc + halo
    float disc = 1.0 - smoothstep(0.17, 0.22, r);
    a = disc + exp(-r * r * 7.0) * 0.55;
    col = mix(vColor, vec3(1.0), disc * 0.85);
  } else if (vKind == 4) {             // thin ring
    float w = 0.035 + 0.05 * vLife;
    float k = (r - 0.82) / w;                 // (squared by hand: pow is undefined for a negative base)
    a = exp(-k * k);
  }
  a *= vAlpha;
  o = vec4(clamp(col, 0.0, 1.0) * a, a);
}`;

  // ---- volumetric vapor: puffs only add density into a half-res buffer; one pass then shades the merged cloud,
  //      so overlapping puffs read as one body of gas (no visible discs) with turbulent, wispy edges
  const FS_VDEN = HEAD + FCOMMON + `
in vec2 vUV; in vec3 vColor; in float vAlpha; in float vSeed; in float vLife; flat in int vKind; out vec4 o;
uniform float uDenScale;
void main() {
  float r = length(vUV);
  if (r >= 1.0) discard;
  vec2 q = vUV * 1.15 + vec2(vSeed * 13.1, vSeed * 7.7);
  float n = fbm(q + vec2(vLife * 0.6, -vLife * 0.4));
  float win = 1.0 - r * r;
  float g = exp(-r * r * 2.4) * win * win;                    // smooth all the way to the rim: no disc edges
  o = vec4(g * (0.5 + n) * vAlpha * uDenScale, 0.0, 0.0, 0.0);
}`;
  const FS_VAPOR = HEAD + FCOMMON + `
in vec2 vUV; uniform sampler2D uDen; uniform vec2 uPx; uniform vec3 uColor; uniform float uK; uniform float uDenScale;
out vec4 o;
float den(vec2 uv) { return texture(uDen, uv).r / uDenScale; }
void main() {
  if (den(vUV) < 0.0005) discard;
  vec2 p = fragDip();
  float t = uTime;
  // large slow eddies push the gas around, smaller billows break up its surface
  vec2 w = vec2(fbm(p * 0.008 + vec2(0.0, t * 0.21)), fbm(p * 0.008 + vec2(5.2, 1.3) - vec2(t * 0.17, 0.0))) - 0.5;
  vec2 uv = vUV + vec2(w.x, -w.y) * 34.0 * uPx;
  float D = den(uv);
  float n = fbm(p * 0.028 + w * 3.5 + vec2(t * 0.12, -t * 0.09));
  float wisps = fbm(p * 0.075 - w * 5.0 + vec2(-t * 0.2, t * 0.15));
  D *= (0.45 + 1.0 * n) * (0.8 + 0.4 * wisps);
  float a = 1.0 - exp(-D * uK);
  if (a < 0.002) discard;
  // light from the upper left; the density gradient stands in for the cloud's surface normal
  float e = 5.0;
  float gx = den(uv + vec2(e, 0.0) * uPx) - den(uv - vec2(e, 0.0) * uPx);
  float gy = -(den(uv + vec2(0.0, e) * uPx) - den(uv - vec2(0.0, e) * uPx));
  vec3 N = normalize(vec3(-vec2(gx, gy) * 7.0, 1.0));
  vec3 L = normalize(vec3(-0.5, -0.7, 0.9));
  float lit = dot(N, L) - L.z;
  float shade = clamp(0.93 + lit * 0.55 + (n - 0.5) * 0.12 - (1.0 - exp(-D * 0.6)) * 0.06, 0.74, 1.06);
  o = vec4(uColor * shade * a, a);
}`;

  // ---- instanced light streak segments (taillights, light lines)
  const VS_STREAK = HEAD + COMMON + `
in vec2 aCorner;
in vec4 iSeg; in vec4 iStyle; in vec3 iColor;  // seg: x0 y0 x1 y1 | style: width, alpha0, alpha1, core
out vec2 vQ; out float vAlpha; out vec3 vColor; out float vCore; out float vLen;
void main() {
  vec2 a = iSeg.xy, b = iSeg.zw; vec2 d = b - a; float len = max(length(d), 0.001); vec2 t = d / len; vec2 n = vec2(-t.y, t.x);
  float w = iStyle.x;
  vec2 P = mix(a - t * w, b + t * w, aCorner.x + 0.5) + n * aCorner.y * 2.0 * w;
  vQ = vec2((aCorner.x + 0.5) * (len + 2.0 * w) - w, aCorner.y * 2.0 * w); vLen = len;
  vAlpha = mix(iStyle.y, iStyle.z, clamp(aCorner.x + 0.5, 0.0, 1.0)); vColor = iColor; vCore = iStyle.w;
  gl_Position = project(vec3(P, 0.0));
}`;
  const FS_STREAK = HEAD + FCOMMON + `
in vec2 vQ; in float vAlpha; in vec3 vColor; in float vCore; in float vLen; out vec4 o;
void main() {
  float along = vQ.x < 0.0 ? -vQ.x : (vQ.x > vLen ? vQ.x - vLen : 0.0);
  float d = length(vec2(along, vQ.y));
  float core = exp(-pow(d / max(vCore, 0.3), 2.0));
  float halo = exp(-pow(d / (vCore * 5.0 + 0.5), 2.0)) * 0.45;
  float a = (core + halo) * vAlpha;
  vec3 col = mix(vColor, vec3(1.0, 0.95, 0.92), core * 0.7);
  o = vec4(col * a, a);
}`;

  // ------------------------------------------------------------------ helpers
  function compile(type, src, label) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(s);
      console.log('shader error [' + label + ']: ' + log);
      throw new Error('shader ' + label + ': ' + log);
    }
    return s;
  }
  function program(vs, fs, label) {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl.VERTEX_SHADER, vs, label + '.vs'));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs, label + '.fs'));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('link ' + label + ': ' + gl.getProgramInfoLog(p));
    const u = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(p, i);
      const name = info.name.replace(/\[0\]$/, '');
      u[name] = gl.getUniformLocation(p, info.name);
    }
    return { p, u, label };
  }
  R.program = program;
  R.fsProgram = (fs, label) => program(VS_TRI, fs, label);

  function setCommon(pr) {
    const u = pr.u;
    if (u.uRes) gl.uniform2f(u.uRes, W, H);
    if (u.uFocal) gl.uniform1f(u.uFocal, FOCAL);
    if (u.uTime) gl.uniform1f(u.uTime, time);
    if (u.uDpr) gl.uniform1f(u.uDpr, DPR);
    if (u.uCanvasH) gl.uniform1f(u.uCanvasH, CH);
  }
  R.use = function (pr) { gl.useProgram(pr.p); setCommon(pr); return pr.u; };

  function makeTexture(w, h, internal, format, type, data, filter) {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter || gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter || gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, data || null);
    return t;
  }
  function target(w, h, hdr) {
    w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h));
    const useF = hdr && floatTargets;
    const tex = makeTexture(w, h, useF ? gl.RGBA16F : gl.RGBA8, gl.RGBA, useF ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE, null);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { fbo, tex, w, h };
  }
  function freeTarget(t) { if (!t) return; gl.deleteFramebuffer(t.fbo); gl.deleteTexture(t.tex); }
  R.target = target; R.freeTarget = freeTarget;

  function bindTarget(t) {
    if (t) { gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo); gl.viewport(0, 0, t.w, t.h); }
    else { gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, CW, CH); }
  }
  R.bindTarget = bindTarget;

  R.tri = function () { gl.bindVertexArray(triVAO); gl.drawArrays(gl.TRIANGLES, 0, 3); };
  R.blendOver = function () { gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); };
  R.blendAdd = function () { gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE); };
  R.blendOff = function () { gl.disable(gl.BLEND); };
  R.bindTex = function (unit, tex, loc) { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, tex); if (loc) gl.uniform1i(loc, unit); };

  // ------------------------------------------------------------------ setup
  R.init = function (cv) {
    canvas = cv;
    gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false, powerPreference: 'high-performance' });
    if (!gl) return false;
    // A GPU reset (driver update, docking, some sleep/resume) loses every texture and program. Tell Flick, which
    // reloads this page so the effects come back, instead of drawing nothing until the next restart.
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      try { (window.flick || { send() {} }).send('fx:lost'); } catch (x) { /* ignore */ }
    }, { once: true });
    R.gl = gl;
    floatTargets = !!gl.getExtension('EXT_color_buffer_float');
    gl.getExtension('OES_texture_float_linear');
    P.convert = program(VS_TRI, FS_CONVERT, 'convert');
    P.down = program(VS_TRI, FS_DOWN, 'down');
    P.up = program(VS_TRI, FS_UP, 'up');
    P.composite = program(VS_TRI, FS_COMPOSITE, 'composite');
    P.card = program(VS_CARD, FS_CARD, 'card');
    P.shadow = program(VS_SHADOW, FS_SHADOW, 'shadow');
    P.sprite = program(VS_SPRITE, FS_SPRITE, 'sprite');
    P.streak = program(VS_STREAK, FS_STREAK, 'streak');
    P.vden = program(VS_SPRITE, FS_VDEN, 'vden');
    P.vapor = program(VS_TRI, FS_VAPOR, 'vapor');

    triVAO = gl.createVertexArray();
    // unit quad (triangle strip) shared by cards, shadows and instanced primitives
    quadVBO = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quadVBO);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, 0.5]), gl.STATIC_DRAW);
    quadVAO = gl.createVertexArray();
    gl.bindVertexArray(quadVAO);
    for (const pr of [P.card, P.shadow]) {
      const loc = gl.getAttribLocation(pr.p, 'aCorner');
      if (loc >= 0) { gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0); }
    }
    // sprites: per-instance 14 floats (pos3, shape4, color3, misc4) → stride 56
    spriteVBO = gl.createBuffer();
    spriteVAO = gl.createVertexArray();
    gl.bindVertexArray(spriteVAO);
    bindCorner(P.sprite);
    gl.bindBuffer(gl.ARRAY_BUFFER, spriteVBO);
    attrib(P.sprite, 'iPos', 3, 56, 0); attrib(P.sprite, 'iShape', 4, 56, 12); attrib(P.sprite, 'iColor', 3, 56, 28); attrib(P.sprite, 'iMisc', 4, 56, 40);
    vdenVAO = gl.createVertexArray();
    gl.bindVertexArray(vdenVAO);
    bindCorner(P.vden);
    gl.bindBuffer(gl.ARRAY_BUFFER, spriteVBO);
    attrib(P.vden, 'iPos', 3, 56, 0); attrib(P.vden, 'iShape', 4, 56, 12); attrib(P.vden, 'iColor', 3, 56, 28); attrib(P.vden, 'iMisc', 4, 56, 40);
    // streaks: 11 floats (seg4, style4, color3) → stride 44
    streakVBO = gl.createBuffer();
    streakVAO = gl.createVertexArray();
    gl.bindVertexArray(streakVAO);
    bindCorner(P.streak);
    gl.bindBuffer(gl.ARRAY_BUFFER, streakVBO);
    attrib(P.streak, 'iSeg', 4, 44, 0); attrib(P.streak, 'iStyle', 4, 44, 16); attrib(P.streak, 'iColor', 3, 44, 32);
    gl.bindVertexArray(null);
    return true;
  };
  function bindCorner(pr) {
    gl.bindBuffer(gl.ARRAY_BUFFER, quadVBO);
    const loc = gl.getAttribLocation(pr.p, 'aCorner');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(loc, 0);
  }
  function attrib(pr, name, size, stride, offset) {
    const loc = gl.getAttribLocation(pr.p, name);
    if (loc < 0) return;
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, offset);
    gl.vertexAttribDivisor(loc, 1);
  }
  R.attrib = attrib;
  R.quadVBO = () => quadVBO;

  R.resize = function (w, h, dpr, dispW, dispH) {
    W = w; H = h; DPR = dpr || 1;
    fullW = dispW || w; fullH = dispH || h;
    FOCAL = H * 1.55;
    const cw = Math.max(1, Math.round(W * DPR)), ch = Math.max(1, Math.round(H * DPR));
    if (cw !== CW || ch !== CH) {
      CW = cw; CH = ch;
      canvas.width = CW; canvas.height = CH;
      canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
      freeTarget(acc); acc = null;
    }
  };
  R.size = () => ({ W, H, DPR, FOCAL, CW, CH, fullW, fullH });
  R.setTime = (t) => { time = t; };

  R.clear = function () {
    bindTarget(null);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
  };

  // ------------------------------------------------------------------ the real desktop
  // shot = { bgra: Uint8Array, w, h } (raw from Electron) or an ImageBitmap/HTMLImageElement
  R.setDesk = function (shot) {
    let src, w, h, swz = 0;
    if (shot && shot.bgra) {
      w = shot.w; h = shot.h; swz = shot.rgba ? 0 : 1;
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      src = makeTexture(w, h, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, shot.bgra instanceof Uint8Array ? shot.bgra : new Uint8Array(shot.bgra));
    } else if (shot && (shot.width || shot.naturalWidth)) {
      w = shot.naturalWidth || shot.width; h = shot.naturalHeight || shot.height;
      src = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, src);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, shot);
    } else return false;
    // full-res RGBA copy
    if (desk.tex && (desk.w !== w || desk.h !== h)) {
      freeTarget(desk.tex); desk.tex = null;
      for (const b of [].concat(desk.blur || [], desk.levels || [], desk.tmp || [])) freeTarget(b);
      desk.blur = []; desk.levels = null; desk.tmp = null;
    }
    if (!desk.tex) desk.tex = target(w, h, false);
    desk.w = w; desk.h = h;
    R.blendOff();
    bindTarget(desk.tex);
    const u = R.use(P.convert);
    R.bindTex(0, src, u.uSrc);
    gl.uniform1f(u.uSwz, swz);
    R.tri();
    gl.deleteTexture(src);
    buildBlur();
    desk.ok = true;
    desk.at = performance.now();
    bindTarget(null);
    return true;
  };
  function buildBlur() {
    const w = desk.w, h = desk.h;
    if (!desk.levels) {
      desk.levels = [1, 2, 3, 4].map((i) => target(w / Math.pow(2, i), h / Math.pow(2, i), false));
      // results at half res: light, medium, heavy
      desk.blur = [target(w / 2, h / 2, false), target(w / 2, h / 2, false), target(w / 2, h / 2, false)];
      desk.tmp = [target(w / 4, h / 4, false), target(w / 8, h / 8, false), target(w / 4, h / 4, false)];
    }
    const L = desk.levels;
    let srcTex = desk.tex.tex, sw = w, sh = h;
    for (let i = 0; i < 4; i++) {
      bindTarget(L[i]);
      const u = R.use(P.down);
      R.bindTex(0, srcTex, u.uSrc);
      gl.uniform2f(u.uTexel, 1 / sw, 1 / sh);
      R.tri();
      srcTex = L[i].tex; sw = L[i].w; sh = L[i].h;
    }
    const up = (src, dst) => { bindTarget(dst); const u = R.use(P.up); R.bindTex(0, src.tex, u.uSrc); gl.uniform2f(u.uTexel, 1 / src.w, 1 / src.h); R.tri(); };
    up(L[1], desk.blur[0]);                       // light   (1/4 → 1/2)
    up(L[2], desk.tmp[0]); up(desk.tmp[0], desk.blur[1]);            // medium  (1/8 → 1/4 → 1/2)
    up(L[3], desk.tmp[1]); up(desk.tmp[1], desk.tmp[2]); up(desk.tmp[2], desk.blur[2]); // heavy (1/16 → … → 1/2)
  }
  R.desk = desk;
  R.deskUV = () => [1 / fullW, 1 / fullH];
  R.dropDesk = function () { desk.ok = false; };
  // binds the desk textures for a background program: uDesk, uBlur1..3, uDeskUV, uHasDesk
  R.bindDesk = function (u, unit0) {
    const b = unit0 || 0;
    gl.uniform1f(u.uHasDesk, desk.ok ? 1 : 0);
    if (u.uDeskUV) gl.uniform2f(u.uDeskUV, 1 / fullW, 1 / fullH);
    if (!desk.ok) return;
    if (u.uDesk) R.bindTex(b, desk.tex.tex, u.uDesk);
    if (u.uBlur1) R.bindTex(b + 1, desk.blur[0].tex, u.uBlur1);
    if (u.uBlur2) R.bindTex(b + 2, desk.blur[1].tex, u.uBlur2);
    if (u.uBlur3) R.bindTex(b + 3, desk.blur[2].tex, u.uBlur3);
  };

  // ------------------------------------------------------------------ textures from images / canvas
  R.texFrom = function (img) {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, img);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  };
  R.freeTex = (t) => { if (t) gl.deleteTexture(t); };

  // ------------------------------------------------------------------ matrices
  // pose: {x,y,z, rx (roll about world x), ry (pitch about world y), rz (in-plane), sx, sy}
  // model = translate · rotY(ry) · rotX(rx) · rotZ(rz) · scale(sx, sy) (column-major), worked out in one go and
  // written into `out` (a new matrix when none is given): several are needed per card and frame, none made between
  function model(p, out) {
    const m = out || new Float32Array(16);
    const cx = Math.cos(p.rx || 0), sx = Math.sin(p.rx || 0), cy = Math.cos(p.ry || 0), sy = Math.sin(p.ry || 0);
    const cz = Math.cos(p.rz || 0), sz = Math.sin(p.rz || 0), kx = p.sx || 1, ky = p.sy || 1;
    m[0] = (cy * cz + sy * sx * sz) * kx; m[1] = cx * sz * kx; m[2] = (cy * sx * sz - sy * cz) * kx; m[3] = 0;
    m[4] = (sy * sx * cz - cy * sz) * ky; m[5] = cx * cz * ky; m[6] = (sy * sz + cy * sx * cz) * ky; m[7] = 0;
    m[8] = sy * cx; m[9] = -sx; m[10] = cy * cx; m[11] = 0;
    m[12] = p.x; m[13] = p.y; m[14] = p.z || 0; m[15] = 1;
    return m;
  }
  R.model = model;
  R.apply = function (m, x, y, z) {
    return [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];
  };
  R.projectPt = function (x, y, z) {
    const d = Math.max(FOCAL - (z || 0), 1);
    return [W / 2 + (x - W / 2) * FOCAL / d, H / 2 + (y - H / 2) * FOCAL / d, FOCAL / d];
  };

  // ------------------------------------------------------------------ cards
  // card: { tex, texW, texH, w, h, radius, pose, prev, opacity, gloss, back, sat, bright, reveal, revealMode, revealAxis, revealColor }
  // m: the card's model matrix
  function drawCardOnce(c, m, weight) {
    const u = R.use(P.card);
    gl.uniformMatrix4fv(u.uModel, false, m);
    gl.uniform2f(u.uSize, c.w, c.h);
    gl.uniform1f(u.uRadius, c.radius);
    const nx = m[8], ny = m[9], nz = m[10];
    const nl = Math.hypot(nx, ny, nz) || 1;
    gl.uniform3f(u.uNormal, nx / nl, ny / nl, nz / nl);
    gl.uniform1f(u.uOpacity, c.opacity == null ? 1 : c.opacity);
    gl.uniform1f(u.uWeight, weight);
    gl.uniform1f(u.uGloss, c.gloss == null ? 0.55 : c.gloss);
    gl.uniform1i(u.uBack, c.back || 0);
    gl.uniform1f(u.uSat, c.sat == null ? 1 : c.sat);
    gl.uniform1f(u.uBright, c.bright == null ? 1 : c.bright);
    // cover-fit the texture into the card
    let sx = 1, sy = 1, ox = 0, oy = 0;
    if (c.tex && c.texW && c.texH) {
      const ca = c.w / c.h, ta = c.texW / c.texH;
      if (ta > ca) { sx = ca / ta; ox = (1 - sx) / 2; } else { sy = ta / ca; oy = (1 - sy) / 2; }
    }
    gl.uniform4f(u.uCover, sx, sy, ox, oy);
    gl.uniform1f(u.uHasTex, c.tex ? 1 : 0);
    if (c.tex) R.bindTex(0, c.tex, u.uTex);
    gl.uniform1i(u.uRevealMode, c.revealMode || 0);
    gl.uniform1f(u.uReveal, c.reveal == null ? 1 : c.reveal);
    const ax = c.revealAxis || [1, 0];
    gl.uniform2f(u.uRevealAxis, ax[0], ax[1]);
    const rc = c.revealColor || [1, 0.92, 0.8];
    gl.uniform3f(u.uRevealColor, rc[0], rc[1], rc[2]);
    gl.bindVertexArray(quadVAO);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
  const POSE_KEYS = ['x', 'y', 'z', 'rx', 'ry', 'rz', 'sx', 'sy'];
  function lerpPose(a, b, s, o) {
    for (const k of POSE_KEYS) {
      const va = a[k] == null ? (k === 'sx' || k === 'sy' ? 1 : 0) : a[k];
      const vb = b[k] == null ? (k === 'sx' || k === 'sy' ? 1 : 0) : b[k];
      o[k] = va + (vb - va) * s;
    }
    return o;
  }
  const subPose = {}, mats = Array.from({ length: 12 }, () => new Float32Array(16));
  // [x, y, w, h] in canvas pixels (y from the bottom, as gl.scissor takes it) around a DIP box, a few pixels wider;
  // null when none of it is on the canvas
  function scissorBox(x0, y0, x1, y1, pad) {
    const a = Math.max(0, Math.floor(x0 * DPR) - pad), b = Math.min(CW, Math.ceil(x1 * DPR) + pad);
    const lo = Math.max(0, Math.floor(CH - y1 * DPR) - pad), hi = Math.min(CH, Math.ceil(CH - y0 * DPR) + pad);
    return a < b && lo < hi ? [a, lo, b - a, hi - lo] : null;
  }
  R.drawCard = function (c) {
    const pose = c.pose, prev = c.prev || pose;
    // how far does the card move this frame (DIP)? → number of motion-blur sub-frames
    const dist = Math.abs(pose.x - prev.x) + Math.abs(pose.y - prev.y) + Math.abs((pose.z || 0) - (prev.z || 0)) * 0.5 +
      (Math.abs((pose.rx || 0) - (prev.rx || 0)) + Math.abs((pose.ry || 0) - (prev.ry || 0))) * Math.max(c.w, c.h) * 0.5 +
      Math.abs((pose.rz || 0) - (prev.rz || 0)) * Math.max(c.w, c.h) * 0.5;
    const K = c.noBlur ? 1 : Math.max(1, Math.min(12, Math.ceil(dist / 2.5)));
    if (K === 1) {
      R.blendOver();
      bindTarget(null);
      drawCardOnce(c, model(pose, mats[0]), 1);
      return;
    }
    // The sub-frames add up in a buffer that is then laid over the screen. Only the part of the screen they cover is
    // cleared and laid over (scissor), not all of it: the box around every sub-frame's projected corners.
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const hw = c.w / 2, hh = c.h / 2;
    for (let i = 0; i < K; i++) {
      const m = model(lerpPose(prev, pose, (i + 0.5) / K, subPose), mats[i]);
      for (let k = 0; k < 4; k++) {
        const lx = k & 1 ? hw : -hw, ly = k & 2 ? hh : -hh;
        const f = FOCAL / Math.max(FOCAL - (m[2] * lx + m[6] * ly + m[14]), 1);
        const sx = W / 2 + (m[0] * lx + m[4] * ly + m[12] - W / 2) * f;
        const sy = H / 2 + (m[1] * lx + m[5] * ly + m[13] - H / 2) * f;
        if (sx < x0) x0 = sx; if (sx > x1) x1 = sx; if (sy < y0) y0 = sy; if (sy > y1) y1 = sy;
      }
    }
    const box = scissorBox(x0, y0, x1, y1, 2);
    if (!box) return;                                // all of it off screen
    if (!acc) acc = target(CW, CH, true);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(box[0], box[1], box[2], box[3]);
    bindTarget(acc);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    R.blendAdd();
    for (let i = 0; i < K; i++) drawCardOnce(c, mats[i], 1 / K);
    bindTarget(null);
    R.blendOver();
    const u = R.use(P.composite);
    R.bindTex(0, acc.tex, u.uSrc);
    R.tri();
    gl.disable(gl.SCISSOR_TEST);
  };

  // soft contact / cast shadow on the desktop plane
  R.drawShadow = function (cx, cy, hw, hh, angle, radius, blur, opacity) {
    if (opacity <= 0.002) return;
    R.blendOver();
    const u = R.use(P.shadow);
    gl.uniform2f(u.uCenter, cx, cy);
    gl.uniform2f(u.uHalfExt, hw + blur * 2.2, hh + blur * 2.2);
    gl.uniform1f(u.uAngle, angle);
    gl.uniform2f(u.uHalf, hw, hh);
    gl.uniform1f(u.uRadius, Math.min(radius, Math.min(hw, hh)));
    gl.uniform1f(u.uBlur, Math.max(0.5, blur));
    gl.uniform1f(u.uOpacity, opacity);
    gl.bindVertexArray(quadVAO);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  };

  // ------------------------------------------------------------------ sprites & streaks
  // Sprites come as a list of objects (a theme's few lamps) or packed: { data, n }, 14 floats each (x y z, size rot
  // stretchX stretchY, r g b, alpha seed kind life). The overlay packs its particles straight into one (R.pack), so
  // no object is made per particle and frame.
  R.spritePack = () => ({ data: new Float32Array(14 * 1024), n: 0 });
  const WHITE = [1, 1, 1];
  R.pack = function (pk, x, y, z, size, rot, stx, sty, color, alpha, seed, kind, life) {
    if (pk.data.length < (pk.n + 1) * 14) { const d = new Float32Array(pk.data.length * 2); d.set(pk.data); pk.data = d; }
    const d = pk.data, c = color || WHITE;
    let o = pk.n * 14;
    d[o++] = x; d[o++] = y; d[o++] = z || 0; d[o++] = size; d[o++] = rot || 0; d[o++] = stx || 1; d[o++] = sty || 1;
    d[o++] = c[0]; d[o++] = c[1]; d[o++] = c[2]; d[o++] = alpha; d[o++] = seed || 0; d[o++] = kind || 0; d[o++] = life || 0;
    pk.n++;
  };
  let spriteData = new Float32Array(14 * 2048);
  const listPack = { data: null, n: 0 };
  function packed(list) {
    if (list.data) return list;
    const n = list.length;
    if (spriteData.length < n * 14) spriteData = new Float32Array(n * 14 * 2);
    let o = 0;
    for (let i = 0; i < n; i++) {
      const s = list[i];
      spriteData[o++] = s.x; spriteData[o++] = s.y; spriteData[o++] = s.z || 0;
      spriteData[o++] = s.size; spriteData[o++] = s.rot || 0; spriteData[o++] = s.stx || 1; spriteData[o++] = s.sty || 1;
      const c = s.color || [1, 1, 1];
      spriteData[o++] = c[0]; spriteData[o++] = c[1]; spriteData[o++] = c[2];
      spriteData[o++] = s.alpha; spriteData[o++] = s.seed || 0; spriteData[o++] = s.kind || 0; spriteData[o++] = s.life || 0;
    }
    listPack.data = spriteData; listPack.n = n;
    return listPack;
  }
  function fillSprites(pk) {
    gl.bindBuffer(gl.ARRAY_BUFFER, spriteVBO);
    gl.bufferData(gl.ARRAY_BUFFER, pk.data.subarray(0, pk.n * 14), gl.DYNAMIC_DRAW);
  }
  R.drawSprites = function (list) {
    const pk = packed(list), n = pk.n;
    if (!n) return;
    R.blendOver();
    bindTarget(null);
    R.use(P.sprite);
    gl.bindVertexArray(spriteVAO);
    fillSprites(pk);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, n);
  };
  // vapor puffs (same instance layout as sprites) → density buffer → one shaded cloud
  R.drawVapor = function (list, color, k) {
    const pk = packed(list), n = pk.n;
    if (!n) return;
    // the shading pass looks only where the puffs are (everywhere else it would find no gas and stop)
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0, d = pk.data; i < n; i++) {
      const o = i * 14, f = FOCAL / Math.max(FOCAL - d[o + 2], 1);
      const r = d[o + 3] * 0.5 * Math.hypot(d[o + 5], d[o + 6]) * f;
      const cx = W / 2 + (d[o] - W / 2) * f, cy = H / 2 + (d[o + 1] - H / 2) * f;
      if (cx - r < x0) x0 = cx - r; if (cx + r > x1) x1 = cx + r;
      if (cy - r < y0) y0 = cy - r; if (cy + r > y1) y1 = cy + r;
    }
    const box = scissorBox(x0, y0, x1, y1, 8);
    if (!box) return;
    const tw = Math.max(1, Math.round(CW / 2)), th = Math.max(1, Math.round(CH / 2));
    if (!vden || vden.w !== tw || vden.h !== th) { freeTarget(vden); vden = target(tw, th, true); }
    const ds = floatTargets ? 1 : 0.5;          // 8-bit fallback: keep sums below 1.0
    bindTarget(vden);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    R.blendAdd();
    let u = R.use(P.vden);
    gl.uniform1f(u.uDenScale, ds);
    gl.bindVertexArray(vdenVAO);
    fillSprites(pk);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, n);
    bindTarget(null);
    R.blendOver();
    u = R.use(P.vapor);
    R.bindTex(0, vden.tex, u.uDen);
    gl.uniform2f(u.uPx, DPR / CW, DPR / CH);
    const c = color || [0.955, 0.97, 0.99];
    gl.uniform3f(u.uColor, c[0], c[1], c[2]);
    gl.uniform1f(u.uK, k || 1.45);
    gl.uniform1f(u.uDenScale, ds);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(box[0], box[1], box[2], box[3]);
    R.tri();
    gl.disable(gl.SCISSOR_TEST);
  };
  let streakData = new Float32Array(11 * 1024);
  R.drawStreaks = function (list) {
    const n = list.length;
    if (!n) return;
    if (streakData.length < n * 11) streakData = new Float32Array(n * 11 * 2);
    let o = 0;
    for (let i = 0; i < n; i++) {
      const s = list[i];
      streakData[o++] = s.x0; streakData[o++] = s.y0; streakData[o++] = s.x1; streakData[o++] = s.y1;
      streakData[o++] = s.w; streakData[o++] = s.a0; streakData[o++] = s.a1; streakData[o++] = s.core || 1;
      const c = s.color || [1, 1, 1];
      streakData[o++] = c[0]; streakData[o++] = c[1]; streakData[o++] = c[2];
    }
    R.blendOver();
    bindTarget(null);
    R.use(P.streak);
    gl.bindVertexArray(streakVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, streakVBO);
    gl.bufferData(gl.ARRAY_BUFFER, streakData.subarray(0, n * 11), gl.DYNAMIC_DRAW);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, n);
  };

  R.lost = () => !gl || gl.isContextLost();
})();
