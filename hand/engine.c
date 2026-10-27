// Flick's hand engine: runs the two small MediaPipe hand models (palm detection, hand landmarks) converted by
// hand/convert.py, and samples camera frames into their input tensors. Built twice by hand/build.sh: with WebAssembly
// SIMD (hand-simd.wasm) and without (hand.wasm, for older browsers and WebViews). No libc: memory comes from a bump
// allocator over the WebAssembly memory.
//
// Tensors are float32, NHWC (batch 1), in one arena per model; the program is a list of ops, each prefixed by its
// length, whose ints are op codes, arena offsets (floats) and sizes (see hand/convert.py for the layout of each op).

#include <stdint.h>
#ifdef __wasm_simd128__
#include <wasm_simd128.h>
#endif

#define EXPORT __attribute__((visibility("default")))

enum { CONV = 1, CONV1, DW, ADD, PRELU, PADC, MAXPOOL2, RESIZE2X, MEAN, FC, SIGMOID, COPY };

// ------------------------------------------------------------------ memory (no libc)
extern unsigned char __heap_base;
static uintptr_t heap_top = 0;

EXPORT void *hb_malloc(int bytes) {
  if (!heap_top) heap_top = ((uintptr_t)&__heap_base + 15) & ~(uintptr_t)15;
  uintptr_t p = heap_top;
  uintptr_t end = (p + (uintptr_t)bytes + 15) & ~(uintptr_t)15;
  uintptr_t have = __builtin_wasm_memory_size(0) * 65536u;
  if (end > have) {
    uintptr_t pages = (end - have + 65535u) / 65536u;
    if (__builtin_wasm_memory_grow(0, pages) == (uintptr_t)-1) return 0;
  }
  heap_top = end;
  return (void *)p;
}

void *memcpy(void *d, const void *s, unsigned long n) {
  unsigned char *a = d;
  const unsigned char *b = s;
  while (n--) *a++ = *b++;
  return d;
}
void *memset(void *d, int c, unsigned long n) {
  unsigned char *a = d;
  while (n--) *a++ = (unsigned char)c;
  return d;
}

// ------------------------------------------------------------------ small maths
static inline float act_f(float v, int act) {
  if (act == 3) return v < 0.f ? 0.f : (v > 6.f ? 6.f : v);
  if (act == 1) return v < 0.f ? 0.f : v;
  return v;
}

static float exp_f(float x) {  // e^x, ~1e-7 relative error over the range that matters here
  if (x > 88.f) x = 88.f;
  if (x < -88.f) return 0.f;
  float t = x * 1.4426950408889634f;  // log2(e)
  int i = (int)(t < 0.f ? t - 1.f : t);
  float f = t - (float)i;  // 0..1
  float p = 1.f + f * (0.6931471806f + f * (0.2402265070f + f * (0.0555041087f + f * (0.0096181291f +
            f * (0.0013333558f + f * 0.0001540353f)))));
  union { uint32_t u; float v; } e = {(uint32_t)(i + 127) << 23};
  return p * e.v;
}

static float half_to_float(uint16_t h) {
  uint32_t s = (uint32_t)(h & 0x8000) << 16, e = (h >> 10) & 0x1f, m = h & 0x3ff, u;
  if (e == 0) {
    if (m == 0) u = s;
    else {  // subnormal
      e = 127 - 15 + 1;
      while (!(m & 0x400)) { m <<= 1; e--; }
      m &= 0x3ff;
      u = s | (e << 23) | (m << 13);
    }
  } else if (e == 31) u = s | 0x7f800000 | (m << 13);
  else u = s | ((e - 15 + 127) << 23) | (m << 13);
  union { uint32_t u; float f; } r = {u};
  return r.f;
}

EXPORT void hb_expand(const uint16_t *src, float *dst, int n) {
  for (int i = 0; i < n; i++) dst[i] = half_to_float(src[i]);
}

#ifdef __wasm_simd128__
static inline v128_t act_v(v128_t v, int act) {
  if (act == 3) return wasm_f32x4_pmin(wasm_f32x4_splat(6.f), wasm_f32x4_pmax(wasm_f32x4_splat(0.f), v));
  if (act == 1) return wasm_f32x4_pmax(wasm_f32x4_splat(0.f), v);
  return v;
}
#define LD(p) wasm_v128_load(p)
#define ST(p, v) wasm_v128_store(p, v)
#define MADD(a, x, w) wasm_f32x4_add(a, wasm_f32x4_mul(x, w))
#endif

// ------------------------------------------------------------------ kernels
// 1x1 convolution: out[p][o] = B[o] + sum_k in[p][k] * W[k][o]   (W is [cin][cout])
static void conv1x1(const float *in, float *out, int P, int cin, int cout, int act, const float *W, const float *B) {
  int p = 0;
#ifdef __wasm_simd128__
  for (; p + 4 <= P; p += 4) {
    const float *i0 = in + p * cin, *i1 = i0 + cin, *i2 = i1 + cin, *i3 = i2 + cin;
    float *o0 = out + p * cout, *o1 = o0 + cout, *o2 = o1 + cout, *o3 = o2 + cout;
    int c = 0;
    for (; c + 16 <= cout; c += 16) {
      v128_t b0 = LD(B + c), b1 = LD(B + c + 4), b2 = LD(B + c + 8), b3 = LD(B + c + 12);
      v128_t a00 = b0, a01 = b1, a02 = b2, a03 = b3, a10 = b0, a11 = b1, a12 = b2, a13 = b3;
      v128_t a20 = b0, a21 = b1, a22 = b2, a23 = b3, a30 = b0, a31 = b1, a32 = b2, a33 = b3;
      const float *w = W + c;
      for (int k = 0; k < cin; k++, w += cout) {
        v128_t w0 = LD(w), w1 = LD(w + 4), w2 = LD(w + 8), w3 = LD(w + 12);
        v128_t x = wasm_f32x4_splat(i0[k]);
        a00 = MADD(a00, x, w0); a01 = MADD(a01, x, w1); a02 = MADD(a02, x, w2); a03 = MADD(a03, x, w3);
        x = wasm_f32x4_splat(i1[k]);
        a10 = MADD(a10, x, w0); a11 = MADD(a11, x, w1); a12 = MADD(a12, x, w2); a13 = MADD(a13, x, w3);
        x = wasm_f32x4_splat(i2[k]);
        a20 = MADD(a20, x, w0); a21 = MADD(a21, x, w1); a22 = MADD(a22, x, w2); a23 = MADD(a23, x, w3);
        x = wasm_f32x4_splat(i3[k]);
        a30 = MADD(a30, x, w0); a31 = MADD(a31, x, w1); a32 = MADD(a32, x, w2); a33 = MADD(a33, x, w3);
      }
      ST(o0 + c, act_v(a00, act)); ST(o0 + c + 4, act_v(a01, act)); ST(o0 + c + 8, act_v(a02, act)); ST(o0 + c + 12, act_v(a03, act));
      ST(o1 + c, act_v(a10, act)); ST(o1 + c + 4, act_v(a11, act)); ST(o1 + c + 8, act_v(a12, act)); ST(o1 + c + 12, act_v(a13, act));
      ST(o2 + c, act_v(a20, act)); ST(o2 + c + 4, act_v(a21, act)); ST(o2 + c + 8, act_v(a22, act)); ST(o2 + c + 12, act_v(a23, act));
      ST(o3 + c, act_v(a30, act)); ST(o3 + c + 4, act_v(a31, act)); ST(o3 + c + 8, act_v(a32, act)); ST(o3 + c + 12, act_v(a33, act));
    }
    for (; c + 4 <= cout; c += 4) {
      v128_t b = LD(B + c), a0 = b, a1 = b, a2 = b, a3 = b;
      const float *w = W + c;
      for (int k = 0; k < cin; k++, w += cout) {
        v128_t wv = LD(w);
        a0 = MADD(a0, wasm_f32x4_splat(i0[k]), wv);
        a1 = MADD(a1, wasm_f32x4_splat(i1[k]), wv);
        a2 = MADD(a2, wasm_f32x4_splat(i2[k]), wv);
        a3 = MADD(a3, wasm_f32x4_splat(i3[k]), wv);
      }
      ST(o0 + c, act_v(a0, act)); ST(o1 + c, act_v(a1, act)); ST(o2 + c, act_v(a2, act)); ST(o3 + c, act_v(a3, act));
    }
    for (; c < cout; c++) {
      float s0 = B[c], s1 = B[c], s2 = B[c], s3 = B[c];
      const float *w = W + c;
      for (int k = 0; k < cin; k++, w += cout) {
        s0 += i0[k] * *w; s1 += i1[k] * *w; s2 += i2[k] * *w; s3 += i3[k] * *w;
      }
      o0[c] = act_f(s0, act); o1[c] = act_f(s1, act); o2[c] = act_f(s2, act); o3[c] = act_f(s3, act);
    }
  }
#endif
  for (; p < P; p++) {
    const float *ip = in + p * cin;
    float *op = out + p * cout;
    int c = 0;
#ifdef __wasm_simd128__
    for (; c + 4 <= cout; c += 4) {
      v128_t a = LD(B + c);
      const float *w = W + c;
      for (int k = 0; k < cin; k++, w += cout) a = MADD(a, wasm_f32x4_splat(ip[k]), LD(w));
      ST(op + c, act_v(a, act));
    }
#endif
    for (; c < cout; c++) {
      float s = B[c];
      const float *w = W + c;
      for (int k = 0; k < cin; k++, w += cout) s += ip[k] * *w;
      op[c] = act_f(s, act);
    }
  }
}

// general convolution (used for the first layer: few input channels): W is [kh][kw][cin][cout]
static float acc_buf[4096];
static void conv(const float *in, float *out, int ih, int iw, int cin, int oh, int ow, int cout, int kh, int kw, int s,
                 int pt, int pl, int act, const float *W, const float *B) {
  for (int oy = 0; oy < oh; oy++) {
    for (int ox = 0; ox < ow; ox++) {
      float *acc = acc_buf;
      for (int c = 0; c < cout; c++) acc[c] = B[c];
      for (int ky = 0; ky < kh; ky++) {
        int iy = oy * s - pt + ky;
        if (iy < 0 || iy >= ih) continue;
        for (int kx = 0; kx < kw; kx++) {
          int ix = ox * s - pl + kx;
          if (ix < 0 || ix >= iw) continue;
          const float *ip = in + (iy * iw + ix) * cin;
          const float *wp = W + (ky * kw + kx) * cin * cout;
          for (int k = 0; k < cin; k++, wp += cout) {
            float v = ip[k];
            int c = 0;
#ifdef __wasm_simd128__
            v128_t vv = wasm_f32x4_splat(v);
            for (; c + 4 <= cout; c += 4) ST(acc + c, MADD(LD(acc + c), vv, LD(wp + c)));
#endif
            for (; c < cout; c++) acc[c] += v * wp[c];
          }
        }
      }
      float *op = out + (oy * ow + ox) * cout;
      for (int c = 0; c < cout; c++) op[c] = act_f(acc[c], act);
    }
  }
}

// depthwise convolution, k x k, stride s, depth multiplier 1: W is [k][k][c]
static void dwconv(const float *in, float *out, int ih, int iw, int c, int oh, int ow, int k, int s, int pt, int pl,
                   int act, const float *W, const float *B) {
  for (int oy = 0; oy < oh; oy++) {
    int y0 = oy * s - pt;
    int ky0 = y0 < 0 ? -y0 : 0, ky1 = y0 + k > ih ? ih - y0 : k;
    for (int ox = 0; ox < ow; ox++) {
      int x0 = ox * s - pl;
      int kx0 = x0 < 0 ? -x0 : 0, kx1 = x0 + k > iw ? iw - x0 : k;
      float *op = out + (oy * ow + ox) * c;
      int ch = 0;
#ifdef __wasm_simd128__
      for (; ch + 8 <= c; ch += 8) {
        v128_t a0 = LD(B + ch), a1 = LD(B + ch + 4);
        for (int ky = ky0; ky < ky1; ky++) {
          const float *ip = in + ((y0 + ky) * iw + x0) * c + ch;
          const float *wp = W + (ky * k) * c + ch;
          for (int kx = kx0; kx < kx1; kx++) {
            const float *a = ip + kx * c, *w = wp + kx * c;
            a0 = MADD(a0, LD(a), LD(w));
            a1 = MADD(a1, LD(a + 4), LD(w + 4));
          }
        }
        ST(op + ch, act_v(a0, act));
        ST(op + ch + 4, act_v(a1, act));
      }
      for (; ch + 4 <= c; ch += 4) {
        v128_t a0 = LD(B + ch);
        for (int ky = ky0; ky < ky1; ky++) {
          const float *ip = in + ((y0 + ky) * iw + x0) * c + ch;
          const float *wp = W + (ky * k) * c + ch;
          for (int kx = kx0; kx < kx1; kx++) a0 = MADD(a0, LD(ip + kx * c), LD(wp + kx * c));
        }
        ST(op + ch, act_v(a0, act));
      }
#endif
      for (; ch < c; ch++) {
        float a = B[ch];
        for (int ky = ky0; ky < ky1; ky++)
          for (int kx = kx0; kx < kx1; kx++) a += in[((y0 + ky) * iw + x0 + kx) * c + ch] * W[(ky * k + kx) * c + ch];
        op[ch] = act_f(a, act);
      }
    }
  }
}

static void add(const float *a, const float *b, float *o, int n, int act) {
  int i = 0;
#ifdef __wasm_simd128__
  for (; i + 4 <= n; i += 4) ST(o + i, act_v(wasm_f32x4_add(LD(a + i), LD(b + i)), act));
#endif
  for (; i < n; i++) o[i] = act_f(a[i] + b[i], act);
}

static void prelu(const float *in, float *out, int P, int c, const float *alpha) {
  for (int p = 0; p < P; p++) {
    const float *ip = in + p * c;
    float *op = out + p * c;
    int ch = 0;
#ifdef __wasm_simd128__
    v128_t z = wasm_f32x4_splat(0.f);
    for (; ch + 4 <= c; ch += 4) {
      v128_t v = LD(ip + ch);
      ST(op + ch, wasm_f32x4_add(wasm_f32x4_pmax(z, v), wasm_f32x4_mul(LD(alpha + ch), wasm_f32x4_pmin(z, v))));
    }
#endif
    for (; ch < c; ch++) op[ch] = ip[ch] > 0.f ? ip[ch] : ip[ch] * alpha[ch];
  }
}

static void padc(const float *in, float *out, int P, int cin, int cout) {
  for (int p = 0; p < P; p++) {
    const float *ip = in + p * cin;
    float *op = out + p * cout;
    int ch = 0;
    for (; ch < cin; ch++) op[ch] = ip[ch];
    for (; ch < cout; ch++) op[ch] = 0.f;
  }
}

static void maxpool2(const float *in, float *out, int ih, int iw, int c, int oh, int ow) {
  for (int oy = 0; oy < oh; oy++)
    for (int ox = 0; ox < ow; ox++) {
      const float *a = in + ((2 * oy) * iw + 2 * ox) * c, *b = a + c, *d = a + iw * c, *e = d + c;
      float *op = out + (oy * ow + ox) * c;
      int ch = 0;
#ifdef __wasm_simd128__
      for (; ch + 4 <= c; ch += 4)
        ST(op + ch, wasm_f32x4_pmax(wasm_f32x4_pmax(LD(a + ch), LD(b + ch)), wasm_f32x4_pmax(LD(d + ch), LD(e + ch))));
#endif
      for (; ch < c; ch++) {
        float m = a[ch];
        if (b[ch] > m) m = b[ch];
        if (d[ch] > m) m = d[ch];
        if (e[ch] > m) m = e[ch];
        op[ch] = m;
      }
    }
}

// bilinear x2 with half-pixel centres, as TFLite's RESIZE_BILINEAR (align_corners false, half_pixel_centers true)
static void resize2x(const float *in, float *out, int ih, int iw, int c) {
  int oh = ih * 2, ow = iw * 2;
  for (int y = 0; y < oh; y++) {
    float fy = (y + 0.5f) * 0.5f - 0.5f;
    int fl = fy < 0.f ? (int)fy - ((float)(int)fy != fy) : (int)fy;  // floor
    int y0 = fl < 0 ? 0 : fl, y1 = fl + 1 > ih - 1 ? ih - 1 : fl + 1;
    if (fy < 0.f) y1 = 0;
    float wy = fy - (float)fl;
    for (int x = 0; x < ow; x++) {
      float fx = (x + 0.5f) * 0.5f - 0.5f;
      int flx = fx < 0.f ? (int)fx - ((float)(int)fx != fx) : (int)fx;
      int x0 = flx < 0 ? 0 : flx, x1 = flx + 1 > iw - 1 ? iw - 1 : flx + 1;
      if (fx < 0.f) x1 = 0;
      float wx = fx - (float)flx;
      const float *p00 = in + (y0 * iw + x0) * c, *p01 = in + (y0 * iw + x1) * c;
      const float *p10 = in + (y1 * iw + x0) * c, *p11 = in + (y1 * iw + x1) * c;
      float *op = out + (y * ow + x) * c;
      float w00 = (1 - wy) * (1 - wx), w01 = (1 - wy) * wx, w10 = wy * (1 - wx), w11 = wy * wx;
      int ch = 0;
#ifdef __wasm_simd128__
      v128_t v00 = wasm_f32x4_splat(w00), v01 = wasm_f32x4_splat(w01), v10 = wasm_f32x4_splat(w10), v11 = wasm_f32x4_splat(w11);
      for (; ch + 4 <= c; ch += 4)
        ST(op + ch, wasm_f32x4_add(wasm_f32x4_add(wasm_f32x4_mul(LD(p00 + ch), v00), wasm_f32x4_mul(LD(p01 + ch), v01)),
                                   wasm_f32x4_add(wasm_f32x4_mul(LD(p10 + ch), v10), wasm_f32x4_mul(LD(p11 + ch), v11))));
#endif
      for (; ch < c; ch++) op[ch] = p00[ch] * w00 + p01[ch] * w01 + p10[ch] * w10 + p11[ch] * w11;
    }
  }
}

static void mean(const float *in, float *out, int P, int c) {
  for (int ch = 0; ch < c; ch++) out[ch] = 0.f;
  for (int p = 0; p < P; p++)
    for (int ch = 0; ch < c; ch++) out[ch] += in[p * c + ch];
  float inv = 1.f / (float)P;
  for (int ch = 0; ch < c; ch++) out[ch] *= inv;
}

static void fc(const float *in, float *out, int cin, int cout, int act, const float *W, const float *B) {
  conv1x1(in, out, 1, cin, cout, act, W, B);
}

static void sigmoid(const float *in, float *out, int n) {
  for (int i = 0; i < n; i++) out[i] = 1.f / (1.f + exp_f(-in[i]));
}

// ------------------------------------------------------------------ the program
EXPORT void hb_run(const int32_t *prog, int words, float *A, const float *W) {
  const int32_t *p = prog, *end = prog + words;
  while (p < end) {
    int n = p[0];
    const int32_t *a = p + 1;
    switch (a[0]) {
      case CONV: conv(A + a[1], A + a[2], a[3], a[4], a[5], a[6], a[7], a[8], a[9], a[10], a[11], a[12], a[13], a[14], W + a[15], W + a[16]); break;
      case CONV1: conv1x1(A + a[1], A + a[2], a[3], a[4], a[5], a[6], W + a[7], W + a[8]); break;
      case DW: dwconv(A + a[1], A + a[2], a[3], a[4], a[5], a[6], a[7], a[8], a[9], a[10], a[11], a[12], W + a[13], W + a[14]); break;
      case ADD: add(A + a[1], A + a[2], A + a[3], a[4], a[5]); break;
      case PRELU: prelu(A + a[1], A + a[2], a[3], a[4], W + a[5]); break;
      case PADC: padc(A + a[1], A + a[2], a[3], a[4], a[5]); break;
      case MAXPOOL2: maxpool2(A + a[1], A + a[2], a[3], a[4], a[5], a[6], a[7]); break;
      case RESIZE2X: resize2x(A + a[1], A + a[2], a[3], a[4], a[5]); break;
      case MEAN: mean(A + a[1], A + a[2], a[3], a[4]); break;
      case FC: fc(A + a[1], A + a[2], a[3], a[4], a[5], W + a[6], W + a[7]); break;
      case SIGMOID: sigmoid(A + a[1], A + a[2], a[3]); break;
      case COPY: { const float *s = A + a[1]; float *d = A + a[2]; for (int i = 0; i < a[3]; i++) d[i] = s[i]; } break;
    }
    p += n + 1;
  }
}

// ------------------------------------------------------------------ camera frame -> input tensor
// Samples an RGBA frame (sw x sh) into an RGB float tensor (ow x oh, values 0..1) through an affine map: the source
// point for output pixel centre (x + 0.5, y + 0.5) is (m0 x' + m1 y' + m2, m3 x' + m4 y' + m5), in source pixels.
// Bilinear; outside the frame is black (border 0) or the nearest edge pixel (border 1).
EXPORT void hb_warp(const uint8_t *src, int sw, int sh, float *out, int ow, int oh, const float *m, int border) {
  const float k = 1.f / 255.f;
  for (int y = 0; y < oh; y++) {
    float yc = y + 0.5f;
    for (int x = 0; x < ow; x++) {
      float xc = x + 0.5f;
      float sx = m[0] * xc + m[1] * yc + m[2] - 0.5f, sy = m[3] * xc + m[4] * yc + m[5] - 0.5f;
      int x0 = sx < 0.f ? (int)sx - 1 : (int)sx, y0 = sy < 0.f ? (int)sy - 1 : (int)sy;
      float fx = sx - (float)x0, fy = sy - (float)y0;
      float r = 0.f, g = 0.f, b = 0.f;
      for (int j = 0; j < 2; j++) {
        int yy = y0 + j;
        float wy = j ? fy : 1.f - fy;
        if (yy < 0 || yy >= sh) {
          if (!border) continue;
          yy = yy < 0 ? 0 : sh - 1;
        }
        for (int i = 0; i < 2; i++) {
          int xx = x0 + i;
          float w = wy * (i ? fx : 1.f - fx);
          if (xx < 0 || xx >= sw) {
            if (!border) continue;
            xx = xx < 0 ? 0 : sw - 1;
          }
          const uint8_t *p = src + (yy * sw + xx) * 4;
          r += w * p[0];
          g += w * p[1];
          b += w * p[2];
        }
      }
      float *o = out + (y * ow + x) * 3;
      o[0] = r * k;
      o[1] = g * k;
      o[2] = b * k;
    }
  }
}

// a cheap motion and brightness probe on a small grey thumbnail: lets the camera loop skip the models while nothing
// moves in front of the phone. Writes the new thumbnail over prev; returns mean |difference| * 1000 + mean luma << 16.
EXPORT int hb_motion(const uint8_t *src, int sw, int sh, uint8_t *prev, int tw, int th) {
  long diff = 0, luma = 0;
  for (int y = 0; y < th; y++) {
    int sy = (y * sh) / th;
    for (int x = 0; x < tw; x++) {
      int sx = (x * sw) / tw;
      const uint8_t *p = src + (sy * sw + sx) * 4;
      int v = (p[0] * 77 + p[1] * 150 + p[2] * 29) >> 8;
      int d = v - prev[y * tw + x];
      diff += d < 0 ? -d : d;
      luma += v;
      prev[y * tw + x] = (uint8_t)v;
    }
  }
  int n = tw * th;
  int md = (int)(diff * 1000 / n);
  if (md > 65535) md = 65535;
  return md | (int)((luma / n) << 16);
}
