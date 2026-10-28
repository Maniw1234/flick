'use strict';
/* Flick overlay: the renderer behind Meteor, Volt, Warp and Glitch (looks/*.js, themes/looks.js).
   Light that adds up and glows: effects are drawn into two half-resolution HDR layers (under and over the cards) with
   a bloom made from both. The desktop photo, when there is one, is laid down underneath at full resolution, bent
   (shock rings, heat haze, a warp tunnel, torn bands), dimmed and lit by the effects; without a photo the effects are
   drawn over the real desktop as see-through light. Cards with a look (heat, charge, a broken signal) are drawn here too.
   A frame is a plain description (see looks/*.js: desk, under, add, smoke, ribbons, cards, post); nothing is kept from
   one frame to the next but buffers. Lite mode (a slow PC, or Reduce effects): no bloom or haze, smaller layers.
   The full-screen passes only cover the part of the screen that has something in it (the glow at the phone's edge
   is a strip, not the whole screen), unless the desktop photo is shown or the whole screen is dimmed. */
(function () {
  const R = window.GFX;
  const X = {};
  window.FX2 = X;
  let gl = null, ready = false, P = {};
  let sprVAO = null, sprBuf = null, ribVAO = null, ribBuf = null, cardVAO = null;
  let layU = null, layO = null, bloomChain = null, layScale = 0, layW = 0, layH = 0;
  let hs = 1;                                            // HDR write scale (1 with float targets; 0.25 without)

  const LIB = `
float hash11(float p) { p = fract(p * .1031); p *= p + 33.33; p *= p + p; return fract(p); }
float sstep(float a, float b, float x) { return smoothstep(a, b, x); }
float fbmN(vec2 p) { return fbm(p) / 0.9375; }
vec3 blackbody(float t) {           // 0 → deep red, 0.5 → orange, 0.8 → yellow, 1 → white
  t = clamp(t, 0., 1.2);
  vec3 c = mix(vec3(0.5, 0.03, 0.0), vec3(1.0, 0.32, 0.03), sstep(0.0, 0.45, t));
  c = mix(c, vec3(1.0, 0.72, 0.22), sstep(0.4, 0.75, t));
  c = mix(c, vec3(1.0, 0.96, 0.85), sstep(0.7, 1.05, t));
  return c;
}
vec3 shoulder(vec3 c) { vec3 hi = max(c - 0.8, 0.0); return min(c, vec3(0.8)) + 0.2 * (1.0 - exp(-hi / 0.2)); }
float maxc(vec3 c) { return max(c.r, max(c.g, c.b)); }
`;

  // ---- sprites (into the HDR layers): 0 soft dot, 1 streak, 2 smoke (over), 3 ring, 4 bolt segment, 5 star, 6 disc, 7 block
  const VS_SPR = `
layout(location=0) in vec2 aCorner;
layout(location=1) in vec2 aPos; layout(location=2) in vec2 aSize; layout(location=3) in vec2 aAngShape;
layout(location=4) in vec4 aCol; layout(location=5) in vec2 aExtra;
uniform vec2 uOff;
out vec2 vL; out vec2 vSize; out vec4 vCol; flat out float vShape; out vec2 vExtra;
void main() {
  vec2 l = aCorner * 2.0 * aSize; float c = cos(aAngShape.x), s = sin(aAngShape.x);
  vec2 p = aPos + uOff + vec2(l.x * c - l.y * s, l.x * s + l.y * c);
  vL = aCorner * 2.0; vSize = aSize; vCol = aCol; vShape = aAngShape.y; vExtra = aExtra;
  gl_Position = vec4(p.x / uRes.x * 2.0 - 1.0, 1.0 - p.y / uRes.y * 2.0, 0.0, 1.0);
}`;
  const FS_SPR = `
in vec2 vL; in vec2 vSize; in vec4 vCol; flat in float vShape; in vec2 vExtra; out vec4 o;
uniform float uHs;
void main() {
  float r = length(vL), f = 0.0; int sh = int(vShape + 0.5);
  if (sh == 0) { f = exp(-4.5 * r * r) * (1.0 - sstep(0.9, 1.0, r)); }
  else if (sh == 1) {
    float ax = vL.x * vSize.x, ay = vL.y * vSize.y, rr = vSize.y;
    float d = length(vec2(max(abs(ax) - (vSize.x - rr), 0.0), ay)) / rr;
    f = exp(-3.0 * d * d) * mix(0.15, 1.0, sstep(-1.0, 0.8, vL.x)) * (1.0 - sstep(0.85, 1.0, d));
  }
  else if (sh == 2) {
    float n = fbmN(vL * 1.6 + vExtra * 7.0);
    f = sstep(1.0, 0.25, r + (n - 0.5) * 0.55);
    o = vec4(vCol.rgb * f * vCol.a, f * vCol.a); return;
  }
  else if (sh == 3) { float w = max(vExtra.x, 0.01); f = exp(-pow((r - 0.86) / w, 2.0)) * (1.0 - sstep(0.97, 1.0, r)); }
  else if (sh == 4) {
    float ax = vL.x * vSize.x, ay = vL.y * vSize.y, rr = vSize.y;
    float d = length(vec2(max(abs(ax) - (vSize.x - rr), 0.0), ay));
    float core = max(vExtra.x, 0.5);
    f = (exp(-pow(d / core, 2.0)) + exp(-pow(d / (rr * 0.42), 2.0)) * 0.22 * vExtra.y) * (1.0 - sstep(rr * 0.85, rr, d));
  }
  else if (sh == 5) { f = exp(-10.0 * r * r) + 0.35 * exp(-abs(vL.x) * 3.0 - vL.y * vL.y * 260.0) + 0.35 * exp(-abs(vL.y) * 3.0 - vL.x * vL.x * 260.0); }
  else if (sh == 6) { f = (1.0 - sstep(0.8, 1.0, r)) * (0.75 + 0.25 * (1.0 - r)); }
  else if (sh == 7) { vec2 q = abs(vL) * vSize; f = (1.0 - sstep(vSize.x - 1.0, vSize.x, q.x)) * (1.0 - sstep(vSize.y - 1.0, vSize.y, q.y)); }
  o = vec4(vCol.rgb * f * vCol.a, f * vCol.a) * uHs;
}`;

  // ---- ribbons (a fire trail; a cold streak): strips of (x, y, u, v, k)
  const VS_RIB = `
layout(location=0) in vec2 aPos; layout(location=1) in vec3 aK; uniform vec2 uOff; out vec3 vK;
void main() { vK = aK; vec2 p = aPos + uOff; gl_Position = vec4(p.x / uRes.x * 2.0 - 1.0, 1.0 - p.y / uRes.y * 2.0, 0.0, 1.0); }`;
  const FS_RIB = `
in vec3 vK; out vec4 o; uniform float uSeed; uniform int uKind; uniform float uHs;
void main() {
  float u = vK.x, v = vK.y;
  vec3 col;
  if (uKind == 0) {
    float n = fbmN(vec2(u * 8.0 - uTime * 8.0 + uSeed, v * 1.8 + u * 3.0));
    float n2 = vnoise(vec2(u * 26.0 - uTime * 16.0, v * 3.5 + uSeed));
    float prof = exp(-v * v * (1.2 + 2.2 * u));
    float fl = pow(max(1.0 - u, 0.0), 0.9) * prof * (0.4 + 0.95 * n) * (0.8 + 0.4 * n2) * vK.z;
    col = blackbody(fl * 1.15) * fl * 2.4;
    float gas = pow(max(1.0 - u, 0.0), 1.6) * exp(-v * v * 0.9) * (0.6 + 0.6 * n) * vK.z;
    col += vec3(0.9, 0.22, 0.05) * gas * 0.32;
  } else {
    float fl = pow(max(1.0 - u, 0.0), 1.6) * exp(-v * v * 3.0) * vK.z;
    col = vec3(0.7, 0.85, 1.0) * fl * 2.0;
  }
  o = vec4(col * uHs, 0.0);
}`;

  // ---- cards with a look: heat, charge, a broken signal (slices, colour split, blocks), a neon edge; and their shadow
  const VS_CARD = `
in vec2 aCorner;
uniform mat4 uModel; uniform vec2 uHalf; uniform float uMargin;
out vec2 vL;
void main() { vec2 l = aCorner * 2.0 * (uHalf + uMargin); vL = l; vec4 w = uModel * vec4(l, 0.0, 1.0); gl_Position = project(w.xyz); }`;
  const FS_CARD = `
in vec2 vL; out vec4 o;
uniform sampler2D uTex; uniform float uHasTex; uniform vec4 uCover; uniform vec2 uHalf; uniform float uRadius; uniform float uOp;
uniform float uMargin; uniform int uSolid;
uniform float uHeat; uniform vec2 uHeatDir; uniform float uElec;
uniform vec4 uGl; uniform vec3 uTint; uniform float uBright; uniform vec3 uChan; uniform vec4 uGlow; uniform float uSat; uniform float uScan;
uniform vec4 uMosaic;
vec3 tex(vec2 uv) { return uHasTex > 0.5 ? texture(uTex, clamp(uv, 0.0, 1.0) * uCover.xy + uCover.zw).rgb : vec3(0.95); }
void main() {
  float d = sdRR(vL, uHalf, uRadius);
  float mfade = 1.0 - sstep(uMargin * 0.5, uMargin * 0.97, d);
  float inside = clamp(0.5 - d, 0.0, 1.0);
  vec2 uv = vL / (uHalf * 2.0) + 0.5;
  if (uGl.x > 0.0) {
    float band = floor(uv.y * uGl.w + hash11(uGl.y) * 7.0);
    float h = hash12(vec2(band, uGl.y));
    uv.x += (h > 0.5 ? (h - 0.5) * 2.0 : 0.0) * uGl.x * (hash12(vec2(band, uGl.y + 3.0)) - 0.5) * 0.6;
  }
  if (uMosaic.x > 0.0) { vec2 cell = floor(uv * uMosaic.y); if (hash12(cell + uMosaic.z) < uMosaic.x) uv = (cell + 0.5) / uMosaic.y; }
  vec3 c;
  float rgb = uGl.z / (uHalf.x * 2.0);
  if (rgb != 0.0) c = vec3(tex(uv + vec2(rgb, 0.0)).r, tex(uv).g, tex(uv - vec2(rgb, 0.0)).b);
  else c = tex(uv);
  float l = dot(c, vec3(0.299, 0.587, 0.114));
  c = mix(vec3(l), c, uSat) * uTint + uBright;
  if (uScan > 0.0) c *= 1.0 - uScan * 0.35 * (0.5 + 0.5 * sin(vL.y * 2.1 + uTime * 30.0));
  c *= uChan;
  vec3 glow = vec3(0.0);
  if (uHeat > 0.001) {
    vec2 nl = normalize(vL + 1e-3);
    float lp = max(dot(nl, uHeatDir), 0.0);
    float n = fbmN(vL * 0.055 + vec2(uTime * 3.5, uTime * 1.3));
    float edge = exp(-max(-d, 0.0) / (3.0 + 9.0 * uHeat * (0.4 + lp)));
    float T = uHeat * edge * (0.35 + 0.95 * lp * lp) * (0.7 + 0.6 * n);
    c = mix(c * mix(vec3(1.0), vec3(1.0, 0.72, 0.5), uHeat * 0.55), blackbody(T) * (1.0 + 1.6 * T), clamp(T * 1.25, 0.0, 1.0));
    c += vec3(0.5, 0.12, 0.02) * uHeat * 0.35 * (0.5 + 0.5 * n);
    float og = exp(-max(d, 0.0) / (4.0 + 12.0 * uHeat)) * uHeat * (0.25 + 1.1 * lp * lp) * (0.65 + 0.7 * n);
    if (d > 0.0) glow += blackbody(0.55 + 0.45 * uHeat) * og * 1.3 * mfade;
  }
  if (uElec > 0.001) {
    float ang = atan(vL.y, vL.x);
    float fl = 0.55 + 0.9 * vnoise(vec2(ang * 7.0, uTime * 45.0)) * vnoise(vec2(ang * 3.0 + 4.0, uTime * 23.0));
    float e = (exp(-abs(d) / 2.5) * 1.6 + exp(-max(d, 0.0) / 12.0) * 0.35 * step(0.0, d)) * mfade;
    glow += vec3(0.55, 0.78, 1.0) * e * uElec * fl * 1.6;
    c = mix(c, vec3(l) * vec3(0.6, 0.78, 1.0) * 1.25, uElec * 0.5);
  }
  if (uGlow.a > 0.0) glow += uGlow.rgb * uGlow.a * exp(-abs(d) / 9.0) * (d > 0.0 ? 1.0 : 0.35) * mfade;
  float a = inside * uOp;
  vec3 col = clamp(c, 0.0, 1.0) * a;
  glow = shoulder(glow) * uOp;
  // over a desktop photo the glow is light added to it; over the real desktop it must stay a valid see-through colour
  o = uSolid == 1 ? vec4(col + glow, a) : vec4(col + glow * (1.0 - a), a + (1.0 - a) * min(maxc(glow), 1.0));
}`;

  // ---- the desktop (photo) with the effects' bends, dimming, light; the under layer; full resolution, to the canvas
  const FS_DESK = `
in vec2 vUV; out vec4 o;
uniform sampler2D uDesk; uniform sampler2D uBlur1; uniform float uHasDesk; uniform vec2 uDeskUV;
uniform sampler2D uU; uniform float uHs; uniform int uSolid; uniform int uLite;
uniform vec4 uGrade; uniform vec3 uTint; uniform vec2 uShake;
uniform vec4 uLight[6]; uniform vec3 uLightC[6]; uniform int uNL;
uniform vec4 uShock[4]; uniform float uShockW[4]; uniform int uNS;
uniform vec4 uHaze[12]; uniform int uNH;
uniform vec4 uWarp; uniform float uWarpCA;
uniform vec4 uBand[12]; uniform int uNB;
uniform vec4 uScorch; uniform float uScorchG;
uniform vec4 uCA; uniform vec4 uGl;
vec3 desk(vec2 p) { return texture(uDesk, clamp(p * uDeskUV, vec2(0.0004), vec2(0.9996))).rgb; }
// (read inside a loop that may stop early: an explicit level, so Windows' graphics (Direct3D) has no gradient to work out there)
vec3 deskSoft(vec2 p) { return textureLod(uBlur1, clamp(p * uDeskUV, vec2(0.0004), vec2(0.9996)), 0.0).rgb; }
vec3 layer(vec2 p) { return texture(uU, vec2(p.x / uRes.x, 1.0 - p.y / uRes.y)).rgb / uHs; }
void main() {
  vec2 p = fragDip();
  vec3 lit = vec3(0.0);
  for (int i = 0; i < 6; i++) { if (i >= uNL) break;
    vec2 d = p - uLight[i].xy; lit += uLightC[i] * uLight[i].w * exp(-dot(d, d) / (uLight[i].z * uLight[i].z)); }
  vec2 v = (p / uRes - 0.5) * vec2(1.0, 0.92);
  float vig = 1.0 - uGrade.z * sstep(0.18, 0.78, length(v));
  if (uSolid == 0) {
    // no photo: dim with see-through black, light and the under layer as see-through colour
    vec3 col = shoulder(layer(p) + lit * 0.12);
    float a = clamp(max(1.0 - uGrade.x * vig, maxc(col)), 0.0, 1.0);
    o = vec4(min(col, vec3(a)), a);
    return;
  }
  vec2 q = p + uShake;
  for (int i = 0; i < 4; i++) { if (i >= uNS) break;
    vec2 d = p - uShock[i].xy; float r = length(d) + 1e-3; float x = (r - uShock[i].z) / uShockW[i];
    q -= d / r * uShock[i].w * x * exp(-x * x * 1.5); }
  if (uLite == 0) {
    float hz = 0.0;
    for (int i = 0; i < 12; i++) { if (i >= uNH) break; vec2 d = p - uHaze[i].xy; hz += uHaze[i].w * exp(-dot(d, d) / (uHaze[i].z * uHaze[i].z)); }
    if (hz > 0.002) { vec2 n = vec2(fbmN(p * 0.05 + vec2(0.0, uTime * 7.0)), fbmN(p * 0.05 + vec2(5.2, uTime * 7.0 + 3.1))) - 0.5; q += n * 16.0 * min(hz, 1.5); }
  }
  float rgb = 0.0, inv = 0.0;
  for (int i = 0; i < 12; i++) { if (i >= uNB) break; if (p.y >= uBand[i].x && p.y < uBand[i].y) { q.x += uBand[i].z; rgb += uBand[i].w; } }
  if (uGl.x > 0.0) {
    float row = floor(q.y / uGl.z), h = hash12(vec2(row, uGl.y));
    if (h > 1.0 - uGl.x * 0.8) { q.x += (hash12(vec2(row, uGl.y + 1.7)) - 0.5) * 220.0 * uGl.x; rgb += (hash12(vec2(row, uGl.y + 5.1)) - 0.5) * 40.0 * uGl.x; }
    if (hash12(floor(q / vec2(uGl.z * 4.0, uGl.z)) + uGl.y * 3.1) > 1.0 - uGl.w * 0.09) inv = 1.0;
  }
  vec3 col;
  if (uWarp.z > 0.0001 || uWarp.w > 0.0001) {
    vec2 c = uWarp.xy; vec2 d = q - c; vec2 base = c + d * (1.0 - uWarp.w);
    vec3 acc = desk(base); float ws = 1.0;
    int n = uLite == 1 ? 4 : 9;
    for (int i = 1; i < 9; i++) { if (i >= n) break; float f = float(i) / float(n - 1); float w = 1.0 - f * 0.55; acc += deskSoft(c + (base - c) * (1.0 - uWarp.z * f)) * w; ws += w; }
    col = acc / ws;
    if (uWarpCA > 0.0) { vec2 dir = normalize(d + 1e-4) * uWarpCA * min(length(d) / 450.0, 1.0);
      col.r = mix(col.r, desk(base + dir).r, 0.75); col.b = mix(col.b, desk(base - dir).b, 0.75); }
  } else if (uCA.z > 0.0 || rgb != 0.0) {
    vec2 off = (q - uCA.xy) / uRes.x * uCA.z + vec2(rgb, 0.0);
    col = vec3(desk(q + off).r, desk(q).g, desk(q - off).b);
  } else col = desk(q);
  float l = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(vec3(l), col, uGrade.y) * uTint * uGrade.x;
  col += (col * 0.55 + 0.035) * lit;
  if (uScorch.w > 0.001) {
    float r = length(p - uScorch.xy) / uScorch.z + (fbmN(p * 0.035) - 0.5) * 0.35;
    col *= 1.0 - 0.78 * (1.0 - sstep(0.3, 1.0, r)) * uScorch.w;
    col += vec3(1.0, 0.36, 0.06) * exp(-pow((r - 0.72) / 0.13, 2.0)) * (0.55 + 0.9 * fbmN(p * 0.08 + 3.0)) * uScorchG;
  }
  col *= vig;
  if (inv > 0.5) col = vec3(col.b, col.r, col.g) * 1.35 + 0.04;
  col += layer(p);
  o = vec4(shoulder(col), 1.0);
}`;

  // ---- the over layer, the bloom and flashes, after the cards
  const FS_OVER = `
in vec2 vUV; out vec4 o;
uniform sampler2D uO; uniform sampler2D uBloom; uniform float uBloomK; uniform float uHs; uniform int uSolid;
uniform vec4 uFlash; uniform vec3 uFlashC; uniform vec3 uFull;
void main() {
  vec2 p = fragDip();
  vec2 uv = vec2(p.x / uRes.x, 1.0 - p.y / uRes.y);
  vec3 col = texture(uO, uv).rgb / uHs;
  if (uBloomK > 0.0) col += texture(uBloom, uv).rgb / uHs * uBloomK;
  if (uFlash.w > 0.0) { vec2 d = p - uFlash.xy; col += uFlashC * uFlash.w * exp(-dot(d, d) / (uFlash.z * uFlash.z)); }
  col += uFull;
  col = shoulder(col);
  if (maxc(col) < 0.002) discard;
  o = uSolid == 1 ? vec4(col, 0.0) : vec4(col, min(maxc(col), 1.0));
}`;

  // ---- bloom: the bright part of both layers, then a down/up chain (each up step adds the level below back in)
  const FS_DOWN = `
in vec2 vUV; uniform sampler2D uSrc; uniform vec2 uTexel; out vec4 o;
void main() { vec2 h = uTexel * 0.5;
  o = (texture(uSrc, vUV) * 4.0 + texture(uSrc, vUV - h) + texture(uSrc, vUV + h) + texture(uSrc, vUV + vec2(h.x, -h.y)) + texture(uSrc, vUV - vec2(h.x, -h.y))) / 8.0; }`;
  const FS_UP = `
in vec2 vUV; uniform sampler2D uSrc; uniform sampler2D uAdd; uniform vec2 uTexel; out vec4 o;
void main() { vec2 h = uTexel * 0.5;
  vec4 s = texture(uSrc, vUV + vec2(-h.x * 2.0, 0.0)) + texture(uSrc, vUV + vec2(-h.x, h.y)) * 2.0 + texture(uSrc, vUV + vec2(0.0, h.y * 2.0))
         + texture(uSrc, vUV + vec2(h.x, h.y)) * 2.0 + texture(uSrc, vUV + vec2(h.x * 2.0, 0.0)) + texture(uSrc, vUV + vec2(h.x, -h.y)) * 2.0
         + texture(uSrc, vUV + vec2(0.0, -h.y * 2.0)) + texture(uSrc, vUV + vec2(-h.x, -h.y)) * 2.0;
  o = s / 12.0 + texture(uAdd, vUV); }`;
  const FS_BRIGHT = `
in vec2 vUV; uniform sampler2D uA; uniform sampler2D uB; uniform float uThr; out vec4 o;
void main() {
  vec3 c = texture(uA, vUV).rgb + texture(uB, vUV).rgb;
  float m = maxc(c);
  o = vec4(c * (max(m - uThr, 0.0) / max(m, 1e-4)), 1.0);
}`;

  function prog(vs, fs, label) {
    return R.program(R.HEAD + R.COMMON + vs, R.HEAD + R.FCOMMON + LIB + fs, label);
  }

  X.init = function () {
    if (ready) return true;
    gl = R.gl;
    if (!gl) return false;
    hs = gl.getExtension('EXT_color_buffer_float') ? 1 : 0.25;
    // drawn by the processor, not a graphics chip (no GPU, or a virtual machine): the light version, without the
    // desktop photo, from the start (a full-screen pass takes a large part of a second there)
    try {
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      const ren = String(gl.getParameter(dbg ? dbg.UNMASKED_RENDERER_WEBGL : gl.RENDERER) || '');
      X.renderer = ren;              // (for Flick's log)
      X.software = /swiftshader|llvmpipe|softpipe|software|basic render/i.test(ren) && !window.__fx2Full;
    } catch (e) { X.software = false; }
    P.spr = prog(VS_SPR, FS_SPR, 'fx2.spr');
    P.rib = prog(VS_RIB, FS_RIB, 'fx2.rib');
    P.card = prog(VS_CARD, FS_CARD, 'fx2.card');
    P.desk = R.fsProgram(R.HEAD + R.FCOMMON + LIB + FS_DESK, 'fx2.desk');
    P.over = R.fsProgram(R.HEAD + R.FCOMMON + LIB + FS_OVER, 'fx2.over');
    P.bright = R.fsProgram(R.HEAD + R.FCOMMON + LIB + FS_BRIGHT, 'fx2.bright');
    P.down = R.fsProgram(R.HEAD + FS_DOWN, 'fx2.down');
    P.up = R.fsProgram(R.HEAD + FS_UP, 'fx2.up');
    // sprites: a corner quad + 12 floats per instance
    sprVAO = gl.createVertexArray(); gl.bindVertexArray(sprVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, R.quadVBO());
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0); gl.vertexAttribDivisor(0, 0);
    sprBuf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, sprBuf);
    const st = 48, at = (loc, n, off) => { gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, n, gl.FLOAT, false, st, off * 4); gl.vertexAttribDivisor(loc, 1); };
    at(1, 2, 0); at(2, 2, 2); at(3, 2, 4); at(4, 4, 6); at(5, 2, 10);
    ribVAO = gl.createVertexArray(); gl.bindVertexArray(ribVAO);
    ribBuf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, ribBuf);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 20, 0); gl.vertexAttribDivisor(0, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 20, 8); gl.vertexAttribDivisor(1, 0);
    cardVAO = gl.createVertexArray(); gl.bindVertexArray(cardVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, R.quadVBO());
    const loc = gl.getAttribLocation(P.card.p, 'aCorner');
    gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    ready = true;
    return true;
  };
  X.ready = () => ready;
  // every program run once (off screen, then cleared) when the overlay starts, so the first flick doesn't wait while the
  // graphics driver finishes building them
  X.warm = function () {
    if (!ready) return;
    const s = (shape) => ({ x: -40, y: -40, a: 4, b: 2, ang: 0, shape, r: 0, g: 0, bl: 0, al: 0, e0: 1, e1: 1 });
    const rib = (kind) => ({ pts: [{ x: -40, y: -40, w: 2, k: 0 }, { x: -30, y: -40, w: 2, k: 0 }], seed: 0, kind });
    X.under({ wantDesk: false, under: [s(0)], add: [s(1), s(4), s(7)], smoke: [s(2)], ribbons: [rib(0), rib(1)], desk: { dim: 0.99 }, post: { full: [0.002, 0, 0] } }, false);
    X.drawCard({ w: 8, h: 8, radius: 2 }, { x: -40, y: -40, z: 0 }, { heat: 0.1, elec: 0.1, gl: 0.1, rgb: 1, glow: [1, 1, 1, 0.1], mosaic: [0.1, 4, 0, 0], scan: 0.1 }, {});
    X.over(false);
    R.clear();
  };

  // the two layers (and the bloom chain) at 1/k of the canvas
  function layers(k) {
    const s = R.size();
    const w = Math.max(16, Math.round(s.CW / k)), h = Math.max(16, Math.round(s.CH / k));
    if (layU && layW === w && layH === h && layScale === k) return;
    for (const t of [layU, layO]) R.freeTarget(t);
    if (bloomChain) for (const b of bloomChain) { R.freeTarget(b.d); R.freeTarget(b.u); }
    layU = R.target(w, h, true); layO = R.target(w, h, true);
    bloomChain = [];
    let cw = w >> 1, ch = h >> 1;
    for (let i = 0; i < 4 && cw > 8 && ch > 8; i++) { bloomChain.push({ d: R.target(cw, ch, true), u: R.target(cw, ch, true) }); cw >>= 1; ch >>= 1; }
    layW = w; layH = h; layScale = k;
  }
  X.free = function () {
    for (const t of [layU, layO]) R.freeTarget(t);
    if (bloomChain) for (const b of bloomChain) { R.freeTarget(b.d); R.freeTarget(b.u); }
    layU = layO = null; bloomChain = null; layW = layH = 0;
  };

  // ---- sprites: { x, y, a (half length), b (half width), ang, shape, r, g, bl, al, e0, e1 }
  let sprData = new Float32Array(4096 * 12);
  function drawSprites(list, off) {
    if (!list || !list.length) return;
    const n = list.length;
    if (sprData.length < n * 12) sprData = new Float32Array(n * 12 * 2);
    let k = 0;
    for (const s of list) {
      sprData[k++] = s.x; sprData[k++] = s.y; sprData[k++] = s.a; sprData[k++] = s.b == null ? s.a : s.b;
      sprData[k++] = s.ang || 0; sprData[k++] = s.shape || 0;
      sprData[k++] = s.r; sprData[k++] = s.g; sprData[k++] = s.bl; sprData[k++] = s.al == null ? 1 : s.al;
      sprData[k++] = s.e0 || 0; sprData[k++] = s.e1 || 0;
    }
    const u = R.use(P.spr);
    gl.uniform2f(u.uOff, off[0], off[1]);
    gl.uniform1f(u.uHs, hs);
    gl.bindVertexArray(sprVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, sprBuf);
    gl.bufferData(gl.ARRAY_BUFFER, sprData.subarray(0, n * 12), gl.DYNAMIC_DRAW);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, n);
  }
  // ---- a ribbon: { pts: [{x, y, w, k}], seed, kind }
  function drawRibbon(rb, off) {
    if (!rb || !rb.pts || rb.pts.length < 2) return;
    const n = rb.pts.length, data = new Float32Array(n * 10);
    let k = 0;
    for (let i = 0; i < n; i++) {
      const p = rb.pts[i], q = rb.pts[Math.min(i + 1, n - 1)], o = rb.pts[Math.max(i - 1, 0)];
      let tx = q.x - o.x, ty = q.y - o.y; const L = Math.hypot(tx, ty) || 1; tx /= L; ty /= L;
      for (const sgn of [-1, 1]) { data[k++] = p.x - ty * p.w * sgn; data[k++] = p.y + tx * p.w * sgn; data[k++] = i / (n - 1); data[k++] = sgn; data[k++] = p.k; }
    }
    const u = R.use(P.rib);
    gl.uniform2f(u.uOff, off[0], off[1]);
    gl.uniform1f(u.uSeed, rb.seed || 0); gl.uniform1i(u.uKind, rb.kind || 0); gl.uniform1f(u.uHs, hs);
    gl.bindVertexArray(ribVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, ribBuf);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, n * 2);
  }

  function bloom(thr) {
    gl.disable(gl.BLEND);
    const b0 = bloomChain[0].d;
    R.bindTarget(b0);
    let u = R.use(P.bright);
    R.bindTex(0, layU.tex, u.uA); R.bindTex(1, layO.tex, u.uB);
    gl.uniform1f(u.uThr, thr * hs);
    R.tri();
    for (let i = 1; i < bloomChain.length; i++) {
      const a = bloomChain[i - 1].d, b = bloomChain[i].d;
      R.bindTarget(b); u = R.use(P.down); R.bindTex(0, a.tex, u.uSrc); gl.uniform2f(u.uTexel, 1 / a.w, 1 / a.h); R.tri();
    }
    let top = bloomChain[bloomChain.length - 1].d;
    for (let i = bloomChain.length - 2; i >= 0; i--) {
      const dst = bloomChain[i].u;
      R.bindTarget(dst); u = R.use(P.up); R.bindTex(0, top.tex, u.uSrc); R.bindTex(1, bloomChain[i].d.tex, u.uAdd);
      gl.uniform2f(u.uTexel, 1 / top.w, 1 / top.h); R.tri();
      top = dst;
    }
    return top;
  }

  // ---- the part of the screen sprites and ribbons cover: [x0, y0, x1, y1] (DIP), grown as given
  const EMPTYBOX = () => [Infinity, Infinity, -Infinity, -Infinity];
  function spriteBox(b, list) {
    if (!list) return b;
    for (const s of list) {
      const r = Math.hypot(s.a, s.b == null ? s.a : s.b);
      if (s.x - r < b[0]) b[0] = s.x - r; if (s.y - r < b[1]) b[1] = s.y - r;
      if (s.x + r > b[2]) b[2] = s.x + r; if (s.y + r > b[3]) b[3] = s.y + r;
    }
    return b;
  }
  function ribbonBox(b, list) {
    if (!list) return b;
    for (const rb of list) for (const q of rb.pts || []) {
      if (q.x - q.w < b[0]) b[0] = q.x - q.w; if (q.y - q.w < b[1]) b[1] = q.y - q.w;
      if (q.x + q.w > b[2]) b[2] = q.x + q.w; if (q.y + q.w > b[3]) b[3] = q.y + q.w;
    }
    return b;
  }
  const grow = (b, m) => [b[0] - m, b[1] - m, b[2] + m, b[3] + m];
  const join = (a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
  const isEmpty = (b) => !(b[2] > b[0] && b[3] > b[1]);
  // a full-screen pass, limited to box (DIP; null: all of it); false when the box is off the screen
  function scissor(box) {
    if (!box) { gl.disable(gl.SCISSOR_TEST); return true; }
    const s = R.size();
    const x0 = Math.max(0, Math.floor(box[0] * s.DPR) - 2), x1 = Math.min(s.CW, Math.ceil(box[2] * s.DPR) + 2);
    const y0 = Math.max(0, Math.floor(s.CH - box[3] * s.DPR) - 2), y1 = Math.min(s.CH, Math.ceil(s.CH - box[1] * s.DPR) + 2);
    if (x1 <= x0 || y1 <= y0) return false;
    // (most of the screen anyway: all of it)
    if ((x1 - x0) * (y1 - y0) > s.CW * s.CH * 0.7) { gl.disable(gl.SCISSOR_TEST); return true; }
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(x0, y0, x1 - x0, y1 - y0);
    return true;
  }
  let boxO = null;

  // ---- one frame. f: { desk, under, add, smoke, ribbons, post } merged from every card with a look, plus cards: [{ card,
  //      pose, fx, sheets }] drawn by drawCards() between under() and over(); lite: the light version
  let cur = null, solid = false, bl = null;
  X.under = function (f, lite) {
    if (!ready) return;
    cur = f;
    const D = f.desk || {}, Po = f.post || {};
    solid = !!(R.desk.ok && f.wantDesk);
    const sh = Po.shake || [0, 0], off = [-sh[0], -sh[1]];
    layers(lite ? 3 : 2);
    // the under layer
    R.bindTarget(layU); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    R.blendAdd();
    drawSprites(f.under, off);
    for (const rb of f.ribbons || []) drawRibbon(rb, off);
    // the over layer (smoke goes over first, then light)
    R.bindTarget(layO); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    R.blendOver(); drawSprites(f.smoke, off);
    R.blendAdd(); drawSprites(f.add, off);
    bl = !lite && bloomChain && bloomChain.length ? bloom(Po.thr == null ? 1.0 : Po.thr) : null;
    // where the passes to the screen are needed: the desktop pass everywhere when it shows the photo or dims or lights
    // the screen, else only where the under layer has something; the over pass where the over layer has something,
    // its glow (bloom), a flash, unless the whole screen is tinted
    const lights = (D.lights || []).slice(0, 6);
    const m = Math.hypot(sh[0], sh[1]) + 4;
    const bU = grow(ribbonBox(spriteBox(EMPTYBOX(), f.under), f.ribbons), m);
    let bO = grow(spriteBox(spriteBox(EMPTYBOX(), f.smoke), f.add), m);
    if (bl) bO = join(bO, grow(join(bO, bU), 180));
    const fl = Po.flash, full = Po.full || [0, 0, 0];
    if (fl && fl.i > 0.002) bO = join(bO, [fl.x - fl.r * 3, fl.y - fl.r * 3, fl.x + fl.r * 3, fl.y + fl.r * 3]);
    boxO = Math.max(full[0], full[1], full[2]) > 0.001 ? null : isEmpty(bO) ? 'none' : bO;
    const deskAll = solid || (D.dim != null && D.dim < 0.999) || (D.vig || 0) > 0.001 || lights.length > 0;
    // the desktop and the under layer, to the canvas
    R.bindTarget(null);
    if (!deskAll && isEmpty(bU)) return;
    if (!scissor(deskAll ? null : bU)) return;
    if (solid) gl.disable(gl.BLEND); else R.blendOver();
    const u = R.use(P.desk);
    R.bindDesk(u, 0);
    R.bindTex(4, layU.tex, u.uU);
    gl.uniform1f(u.uHs, hs);
    gl.uniform1i(u.uSolid, solid ? 1 : 0);
    gl.uniform1i(u.uLite, lite ? 1 : 0);
    gl.uniform4f(u.uGrade, D.dim == null ? 1 : D.dim, D.sat == null ? 1 : D.sat, D.vig || 0, 0);
    const t = D.tint || [1, 1, 1]; gl.uniform3f(u.uTint, t[0], t[1], t[2]);
    gl.uniform2f(u.uShake, sh[0], sh[1]);
    gl.uniform1i(u.uNL, lights.length);
    if (lights.length) { gl.uniform4fv(u.uLight, lights.flatMap((l) => [l.x, l.y, l.r, l.i])); gl.uniform3fv(u.uLightC, lights.flatMap((l) => l.c)); }
    const shocks = (D.shocks || []).slice(0, 4);
    gl.uniform1i(u.uNS, shocks.length);
    if (shocks.length) { gl.uniform4fv(u.uShock, shocks.flatMap((s) => [s.x, s.y, s.r, s.s])); gl.uniform1fv(u.uShockW, shocks.map((s) => s.w)); }
    const haze = lite ? [] : (D.haze || []).slice(0, 12);
    gl.uniform1i(u.uNH, haze.length);
    if (haze.length) gl.uniform4fv(u.uHaze, haze.flatMap((h) => [h.x, h.y, h.r, h.a]));
    const W = D.warp;
    gl.uniform4f(u.uWarp, W ? W.x : 0, W ? W.y : 0, W ? W.blur : 0, W ? W.zoom : 0);
    gl.uniform1f(u.uWarpCA, W && !lite ? W.ca || 0 : 0);
    const bands = (D.bands || []).slice(0, 12);
    gl.uniform1i(u.uNB, bands.length);
    if (bands.length) gl.uniform4fv(u.uBand, bands.flatMap((b) => [b.y0, b.y1, b.off, b.rgb || 0]));
    const sc = D.scorch;
    gl.uniform4f(u.uScorch, sc ? sc.x : 0, sc ? sc.y : 0, sc ? sc.r : 1, sc ? sc.a : 0); gl.uniform1f(u.uScorchG, sc ? sc.g || 0 : 0);
    const ca = Po.ca;
    gl.uniform4f(u.uCA, ca ? ca.x : 0, ca ? ca.y : 0, ca && !lite ? ca.a : 0, 0);
    const g = Po.gl;
    gl.uniform4f(u.uGl, g ? g.a : 0, g ? g.seed : 0, g ? g.block : 20, g ? g.inv : 0);
    R.tri();
    gl.disable(gl.SCISSOR_TEST);
  };

  // a card with a look: pose (overlay's), fx (the look's), and the card's own texture / size / sheets
  const mat = new Float32Array(16);
  X.drawCard = function (c, pose, fx, opts) {
    if (!ready) return;
    opts = opts || {};
    fx = fx || {};
    R.bindTarget(null);
    if (opts.add && solid) R.blendAdd(); else R.blendOver();
    const u = R.use(P.card);
    R.model(pose, mat);
    gl.uniformMatrix4fv(u.uModel, false, mat);
    gl.uniform2f(u.uHalf, c.w / 2, c.h / 2);
    const margin = fx.margin != null ? fx.margin : 30;
    gl.uniform1f(u.uMargin, margin);
    gl.uniform1f(u.uRadius, c.radius || 8);
    gl.uniform1f(u.uOp, (opts.op == null ? 1 : opts.op) * (c.opacity == null ? 1 : c.opacity));
    gl.uniform1i(u.uSolid, solid ? 1 : 0);
    let sx = 1, sy = 1, ox = 0, oy = 0;
    const tex = opts.tex || c.tex, tw = opts.texW || c.texW, th = opts.texH || c.texH;
    if (tex && tw && th) {
      const ca = c.w / c.h, ta = tw / th;
      if (ta > ca) { sx = ca / ta; ox = (1 - sx) / 2; } else { sy = ta / ca; oy = (1 - sy) / 2; }
    }
    gl.uniform4f(u.uCover, sx, sy, ox, oy);
    gl.uniform1f(u.uHasTex, tex ? 1 : 0);
    if (tex) R.bindTex(0, tex, u.uTex);
    gl.uniform1f(u.uHeat, fx.heat || 0); gl.uniform2f(u.uHeatDir, fx.hdx || 0, fx.hdy || 0);
    gl.uniform1f(u.uElec, fx.elec || 0);
    gl.uniform4f(u.uGl, fx.gl || 0, fx.seed || 0, fx.rgb || 0, fx.slices || 14);
    const tn = fx.tint || [1, 1, 1]; gl.uniform3f(u.uTint, tn[0], tn[1], tn[2]);
    gl.uniform1f(u.uBright, fx.bright || 0);
    const ch = fx.chan || [1, 1, 1]; gl.uniform3f(u.uChan, ch[0], ch[1], ch[2]);
    const gw = fx.glow || [0, 0, 0, 0]; gl.uniform4f(u.uGlow, gw[0], gw[1], gw[2], gw[3]);
    gl.uniform1f(u.uSat, (fx.sat == null ? 1 : fx.sat) * (c.sat == null ? 1 : c.sat));
    gl.uniform1f(u.uScan, fx.scan || 0);
    const mo = fx.mosaic || [0, 0, 0, 0]; gl.uniform4f(u.uMosaic, mo[0], mo[1], mo[2], mo[3]);
    gl.bindVertexArray(cardVAO);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  };

  X.over = function (lite) {
    if (!ready || !cur) return;
    const Po = cur.post || {};
    R.bindTarget(null);
    if (boxO === 'none' || !scissor(boxO)) { cur = null; return; }
    if (solid) R.blendAdd(); else R.blendOver();
    const u = R.use(P.over);
    R.bindTex(0, layO.tex, u.uO);
    if (bl) R.bindTex(1, bl.tex, u.uBloom);
    gl.uniform1f(u.uBloomK, bl ? (Po.bloom == null ? 1 : Po.bloom) : 0);
    gl.uniform1f(u.uHs, hs);
    gl.uniform1i(u.uSolid, solid ? 1 : 0);
    const fl = Po.flash;
    gl.uniform4f(u.uFlash, fl ? fl.x : 0, fl ? fl.y : 0, fl ? fl.r : 1, fl ? fl.i : 0);
    const fc = fl ? fl.c : [1, 1, 1]; gl.uniform3f(u.uFlashC, fc[0], fc[1], fc[2]);
    const full = Po.full || [0, 0, 0]; gl.uniform3f(u.uFull, full[0], full[1], full[2]);
    R.tri();
    gl.disable(gl.SCISSOR_TEST);
    cur = null;
  };
  X.solid = () => solid;
})();
