// Flick's hand tracking: finds one hand in camera frames and says what it is doing (open palm, fist, pinch).
// Runs MediaPipe's palm detection and hand landmark models (lite) on Flick's own engine (hand-simd.wasm, or hand.wasm
// where WebAssembly SIMD is missing), following MediaPipe's hand tracking graph: detect a palm, cut a rotated square
// around it, find 21 landmarks there, then follow the hand with the landmarks of the frame before until it is lost.
//
// Used by the phone app (phone/features/air.js) and the PC app (pc/air/), in a page, a worker or Node:
//   const hands = await FlickHand.load({ base: 'hand/' });
//   const r = hands.track(rgba, width, height);   // r.hand: { lm (21 x [x, y, z], 0..1 of the frame), score, ... }
//   const g = FlickHand.gesture(r.hand.lm, width, height);   // { open, fist, pinch, center, size, ... }
(function (root) {
  'use strict';

  // ------------------------------------------------------------------ engine
  let simdOk = null;
  function hasSimd() {
    if (simdOk !== null) return simdOk;
    try {
      // (module (func (result v128) i32.const 0 i8x16.splat))
      simdOk = WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 8, 1, 6, 0, 65, 0, 253, 15, 11]));
    } catch (e) {
      simdOk = false;
    }
    return simdOk;
  }

  async function defaultFetch(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error('hand: ' + url + ' ' + r.status);
    return r.arrayBuffer();
  }

  class Engine {
    constructor(instance) {
      this.x = instance.exports;
      this.mem = this.x.memory;
    }
    malloc(bytes) {
      const p = this.x.hb_malloc(bytes);
      if (!p) throw new Error('hand: out of memory');
      return p;
    }
    f32(ptr, n) { return new Float32Array(this.mem.buffer, ptr, n); }
    u8(ptr, n) { return new Uint8Array(this.mem.buffer, ptr, n); }
    i32(ptr, n) { return new Int32Array(this.mem.buffer, ptr, n); }
  }

  class Model {
    constructor(engine, bytes) {
      const dv = new DataView(bytes);
      const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
      if (magic !== 'FHM1') throw new Error('hand: not a hand model');
      const jl = dv.getUint32(4, true);
      const head = JSON.parse(new TextDecoder().decode(new Uint8Array(bytes, 8, jl)));
      const e = (this.e = engine);
      this.head = head;
      const words = [];
      for (const op of head.ops) words.push(op.length, ...op);
      this.nwords = words.length;
      this.prog = e.malloc(words.length * 4);
      this.arena = e.malloc(head.arena * 4);
      this.w = e.malloc(head.weights * 4);
      const w16 = e.malloc(head.weights * 2);
      e.u8(w16, head.weights * 2).set(new Uint8Array(bytes, 8 + jl, head.weights * 2));
      e.x.hb_expand(w16, this.w, head.weights);  // (the float16 copy stays allocated: the allocator only grows)
      e.i32(this.prog, words.length).set(words);
      this.inPtr = this.arena + head.input.off * 4;
      [this.ih, this.iw] = head.input.shape;
    }
    run() { this.e.x.hb_run(this.prog, this.nwords, this.arena, this.w); }
    out(name) {
      const o = this.head.outputs[name];
      return this.e.f32(this.arena + o.off * 4, o.shape.reduce((a, b) => a * b, 1));
    }
  }

  // ------------------------------------------------------------------ palm detection (MediaPipe palm_detection_cpu)
  const PALM = 192;
  const ANCHORS = (() => {
    const strides = [8, 16, 16, 16];
    const a = [];
    for (let l = 0; l < strides.length;) {
      let last = l;
      while (last < strides.length && strides[last] === strides[l]) last++;
      const per = (last - l) * 2;  // one aspect ratio (1.0) + the interpolated scale, per layer
      const fm = Math.ceil(PALM / strides[l]);
      for (let y = 0; y < fm; y++) for (let x = 0; x < fm; x++) for (let k = 0; k < per; k++) a.push((x + 0.5) / fm, (y + 0.5) / fm);
      l = last;
    }
    return new Float32Array(a);
  })();

  const sigmoid = (v) => 1 / (1 + Math.exp(-Math.max(-100, Math.min(100, v))));
  const normRad = (a) => a - 2 * Math.PI * Math.floor((a + Math.PI) / (2 * Math.PI));

  function iou(a, b) {
    const ix = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0));
    const iy = Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
    const inter = ix * iy;
    const u = (a.x1 - a.x0) * (a.y1 - a.y0) + (b.x1 - b.x0) * (b.y1 - b.y0) - inter;
    return u > 0 ? inter / u : 0;
  }

  // ------------------------------------------------------------------ the tracker
  class Tracker {
    constructor(engine, palm, landmark, opts) {
      this.e = engine;
      this.palm = palm;
      this.lmk = landmark;
      this.opts = Object.assign({ minDetect: 0.5, minPresence: 0.5 }, opts || {});
      this.roi = null;  // the rotated square around the hand for the next frame (tracking)
      this.frame = 0;
      this.frameBytes = 0;
      this.mat = engine.malloc(6 * 4);
      this.thumb = engine.malloc(32 * 24);
    }

    // copies a frame into the engine's memory (grown when a bigger frame comes)
    load(rgba, w, h) {
      const n = w * h * 4;
      if (n > this.frameBytes) {
        this.frame = this.e.malloc(n);
        this.frameBytes = n;
      }
      this.e.u8(this.frame, n).set(rgba.length === n ? rgba : rgba.subarray(0, n));
      this.w = w;
      this.h = h;
    }

    warp(model, m, border) {
      this.e.f32(this.mat, 6).set(m);
      this.e.x.hb_warp(this.frame, this.w, this.h, model.inPtr, model.iw, model.ih, this.mat, border);
    }

    // mean motion (0..255) and brightness of the frame since the last call: a cheap gate before the models
    motion() {
      const v = this.e.x.hb_motion(this.frame, this.w, this.h, this.thumb, 32, 24);
      return { motion: (v & 0xffff) / 1000, luma: v >>> 16 };
    }

    detectPalms() {
      const { w, h } = this;
      const s = PALM / Math.max(w, h);  // letterbox: the whole frame, centred, black around
      const ox = (PALM - w * s) / 2, oy = (PALM - h * s) / 2;
      this.warp(this.palm, [1 / s, 0, -ox / s, 0, 1 / s, -oy / s], 0);
      this.palm.run();
      const reg = this.palm.out('Identity'), cls = this.palm.out('Identity_1');
      const dets = [];
      for (let i = 0; i < 2016; i++) {
        const sc = sigmoid(cls[i]);
        if (sc < this.opts.minDetect) continue;
        const r = i * 18, ax = ANCHORS[2 * i], ay = ANCHORS[2 * i + 1];
        const cx = reg[r] / PALM + ax, cy = reg[r + 1] / PALM + ay, bw = reg[r + 2] / PALM, bh = reg[r + 3] / PALM;
        const kp = new Float32Array(14);
        for (let k = 0; k < 7; k++) {
          kp[2 * k] = reg[r + 4 + 2 * k] / PALM + ax;
          kp[2 * k + 1] = reg[r + 5 + 2 * k] / PALM + ay;
        }
        dets.push({ score: sc, x0: cx - bw / 2, y0: cy - bh / 2, x1: cx + bw / 2, y1: cy + bh / 2, kp });
      }
      // weighted non-max suppression (MediaPipe: WEIGHTED, IoU 0.3)
      dets.sort((a, b) => b.score - a.score);
      const out = [];
      const used = new Uint8Array(dets.length);
      for (let i = 0; i < dets.length; i++) {
        if (used[i]) continue;
        const group = [];
        for (let j = i; j < dets.length; j++) if (!used[j] && iou(dets[i], dets[j]) > 0.3) { used[j] = 1; group.push(dets[j]); }
        let tw = 0;
        const m = { score: dets[i].score, x0: 0, y0: 0, x1: 0, y1: 0, kp: new Float32Array(14) };
        for (const d of group) {
          tw += d.score;
          m.x0 += d.x0 * d.score; m.y0 += d.y0 * d.score; m.x1 += d.x1 * d.score; m.y1 += d.y1 * d.score;
          for (let k = 0; k < 14; k++) m.kp[k] += d.kp[k] * d.score;
        }
        m.x0 /= tw; m.y0 /= tw; m.x1 /= tw; m.y1 /= tw;
        for (let k = 0; k < 14; k++) m.kp[k] /= tw;
        out.push(m);
      }
      // back from the letterboxed square to the frame (0..1)
      const sx = PALM / (w * s), sy = PALM / (h * s), px = ox / PALM, py = oy / PALM;
      for (const d of out) {
        d.x0 = (d.x0 - px) * sx; d.x1 = (d.x1 - px) * sx;
        d.y0 = (d.y0 - py) * sy; d.y1 = (d.y1 - py) * sy;
        for (let k = 0; k < 7; k++) { d.kp[2 * k] = (d.kp[2 * k] - px) * sx; d.kp[2 * k + 1] = (d.kp[2 * k + 1] - py) * sy; }
      }
      return out;
    }

    // MediaPipe's RectTransformation: shift in the rect's own (rotated) frame, square on the long side, scale
    transformRect(cx, cy, rw, rh, rot, scale, shiftY) {
      const { w, h } = this;
      cx += (-h * rh * shiftY * Math.sin(rot)) / w;
      cy += (h * rh * shiftY * Math.cos(rot)) / h;
      const long = Math.max(rw * w, rh * h);
      return { cx, cy, w: (long / w) * scale, h: (long / h) * scale, rot };
    }

    roiFromPalm(d) {
      const { w, h } = this;
      const x0 = d.kp[0] * w, y0 = d.kp[1] * h, x1 = d.kp[4] * w, y1 = d.kp[5] * h;  // wrist, middle finger MCP
      const rot = normRad(Math.PI / 2 - Math.atan2(-(y1 - y0), x1 - x0));
      return this.transformRect((d.x0 + d.x1) / 2, (d.y0 + d.y1) / 2, d.x1 - d.x0, d.y1 - d.y0, rot, 2.6, -0.5);
    }

    roiFromLandmarks(lm) {
      const { w, h } = this;
      const P = [0, 1, 2, 3, 5, 6, 9, 10, 13, 14, 17, 18];
      const X = (i) => lm[3 * P[i]], Y = (i) => lm[3 * P[i] + 1];
      const x0 = X(0) * w, y0 = Y(0) * h;
      let x1 = (X(4) + X(8)) / 2, y1 = (Y(4) + Y(8)) / 2;
      x1 = ((x1 + X(6)) / 2) * w;
      y1 = ((y1 + Y(6)) / 2) * h;
      const rot = normRad(Math.PI / 2 - Math.atan2(-(y1 - y0), x1 - x0));
      const rev = normRad(-rot);
      let mnx = Infinity, mny = Infinity, mxx = -Infinity, mxy = -Infinity;
      for (let i = 0; i < P.length; i++) { mnx = Math.min(mnx, X(i)); mxx = Math.max(mxx, X(i)); mny = Math.min(mny, Y(i)); mxy = Math.max(mxy, Y(i)); }
      const acx = (mnx + mxx) / 2, acy = (mny + mxy) / 2;
      mnx = mny = Infinity; mxx = mxy = -Infinity;
      const c = Math.cos(rev), s = Math.sin(rev);
      for (let i = 0; i < P.length; i++) {
        const ox = (X(i) - acx) * w, oy = (Y(i) - acy) * h;
        const px = ox * c - oy * s, py = ox * s + oy * c;
        mnx = Math.min(mnx, px); mxx = Math.max(mxx, px); mny = Math.min(mny, py); mxy = Math.max(mxy, py);
      }
      const pcx = (mnx + mxx) / 2, pcy = (mny + mxy) / 2;
      const cx = (pcx * Math.cos(rot) - pcy * Math.sin(rot) + w * acx) / w;
      const cy = (pcx * Math.sin(rot) + pcy * Math.cos(rot) + h * acy) / h;
      return this.transformRect(cx, cy, (mxx - mnx) / w, (mxy - mny) / h, rot, 2.0, -0.1);
    }

    landmarks(roi) {
      const { w, h } = this;
      const L = this.lmk.iw;  // 224
      const side = roi.w * w;  // the square in pixels (roi.w * w == roi.h * h)
      const c = Math.cos(roi.rot), s = Math.sin(roi.rot), k = side / L;
      const cx = roi.cx * w, cy = roi.cy * h;
      this.warp(this.lmk, [c * k, -s * k, cx - (c * k - s * k) * (L / 2), s * k, c * k, cy - (s * k + c * k) * (L / 2)], 1);
      this.lmk.run();
      const raw = this.lmk.out('Identity'), presence = this.lmk.out('Identity_1')[0], hand = this.lmk.out('Identity_2')[0];
      const lm = new Float32Array(63);
      for (let i = 0; i < 21; i++) {
        const x = raw[3 * i] / L - 0.5, y = raw[3 * i + 1] / L - 0.5, z = raw[3 * i + 2] / L / 0.4;
        lm[3 * i] = (c * x - s * y) * roi.w + roi.cx;
        lm[3 * i + 1] = (s * x + c * y) * roi.h + roi.cy;
        lm[3 * i + 2] = z * roi.w;
      }
      return { lm, presence, handedness: hand };
    }

    // one frame: the hand (or null). opts.detect false skips palm detection when no hand is being followed.
    track(rgba, w, h, opts) {
      opts = opts || {};
      this.load(rgba, w, h);
      const t0 = now();
      let detected = false;
      if (!this.roi) {
        if (opts.detect === false) return { hand: null, ms: 0 };
        const palms = this.detectPalms();
        if (!palms.length) return { hand: null, ms: now() - t0, detected: true };
        this.roi = this.roiFromPalm(palms[0]);
        detected = true;
      }
      const r = this.landmarks(this.roi);
      if (r.presence < this.opts.minPresence) {
        this.roi = null;
        return { hand: null, ms: now() - t0, detected };
      }
      this.roi = this.roiFromLandmarks(r.lm);
      return { hand: { lm: r.lm, score: r.presence, handedness: r.handedness }, ms: now() - t0, detected };
    }

    reset() { this.roi = null; }
  }

  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

  // ------------------------------------------------------------------ what the hand is doing
  // lm: 21 landmarks (0..1 of a w x h frame). Distances are measured in pixels, so they don't depend on rotation.
  function gesture(lm, w, h) {
    const P = (i) => [lm[3 * i] * w, lm[3 * i + 1] * h];
    const d = (a, b) => { const p = P(a), q = P(b); return Math.hypot(p[0] - q[0], p[1] - q[1]); };
    const size = d(0, 9) || 1;  // wrist to the middle finger's knuckle
    // a finger is out when its tip is well beyond its knuckle, seen from the wrist
    const fingers = [[5, 6, 8], [9, 10, 12], [13, 14, 16], [17, 18, 20]].map(([mcp, pip, tip]) => d(0, tip) / (d(0, mcp) || 1));
    const out = fingers.map((r) => r > 1.55).filter(Boolean).length;
    const curled = fingers.map((r) => r < 1.3).filter(Boolean).length;
    const thumbOut = d(4, 9) > 0.75 * size;
    const pinchGap = d(4, 8) / size;  // thumb tip to index tip
    const c = [0, 5, 9, 13, 17].map(P).reduce((a, p) => [a[0] + p[0] / 5, a[1] + p[1] / 5], [0, 0]);
    return {
      open: out >= 4 || (out >= 3 && thumbOut),
      fist: curled >= 3 && out === 0,
      // the 'OK' pinch: thumb and index tips together while the other three fingers stay out (a fist doesn't count)
      pinch: pinchGap < 0.3 && fingers.slice(1).filter((r) => r > 1.4).length >= 2,
      pinchGap,
      fingers,
      center: [c[0] / w, c[1] / h],  // palm centre, 0..1 of the frame
      size: size / Math.max(w, h),  // how big the hand looks (bigger = closer)
    };
  }

  // ------------------------------------------------------------------ loading
  async function load(opts) {
    opts = opts || {};
    const base = opts.base || '';
    const get = opts.fetch || defaultFetch;
    const simd = opts.simd !== undefined ? opts.simd : hasSimd();
    const [wasm, palmBytes, lmBytes] = await Promise.all([
      get(base + (simd ? 'hand-simd.wasm' : 'hand.wasm')),
      get(base + 'palm.fhm'),
      get(base + 'landmark.fhm'),
    ]);
    const { instance } = await WebAssembly.instantiate(wasm, {});
    const engine = new Engine(instance);
    const palm = new Model(engine, palmBytes);
    const lmk = new Model(engine, lmBytes);
    const tracker = new Tracker(engine, palm, lmk, opts);
    return {
      simd,
      tracker,
      track: (rgba, w, h, o) => tracker.track(rgba, w, h, o),
      motion: (rgba, w, h) => { tracker.load(rgba, w, h); return tracker.motion(); },
      reset: () => tracker.reset(),
      models: { palm, landmark: lmk },
    };
  }

  const api = { load, gesture, hasSimd, Model, Engine, ANCHORS };
  root.FlickHand = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
