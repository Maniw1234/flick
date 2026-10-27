// A camera that watches for a hand: opens the camera, hands small frames to the tracker worker (worker.js) one at a
// time, and reports each result. Shared by the phone app (features/air.js) and the PC app (pc/air/).
//
//   const cam = new FlickHandCam({
//     worker: () => new Worker(...),          // a worker running hand.js + worker.js
//     files: async () => ({ 'hand-simd.wasm': ArrayBuffer, 'hand.wasm': ..., 'palm.fhm': ..., 'landmark.fhm': ... }),
//     facing: 'user',                         // the phone's front camera; a PC takes its default camera
//     onResult(r) {},                         // r: { hand, g, w, h, t } for every frame the tracker looked at
//     onState(s, detail) {},                  // 'starting' | 'on' | 'off' | 'denied' | 'nocamera' | 'error'
//   });
//   await cam.start(); ... cam.stop();
//
// Frames: about 6 a second while no hand is in view (the tracker skips frames where nothing moves), as many as the
// tracker manages (up to 25) while one is followed.
(function (root) {
  'use strict';
  const MAX_SIDE = 320;

  class FlickHandCam {
    constructor(opts) {
      this.o = opts || {};
      this.on = false;
      this.worker = null;
      this.ready = null;
      this.stream = null;
      this.video = null;
      this.cv = null;
      this.cx = null;
      this.bufs = [];
      this.busy = false;
      this.timer = 0;
      this.seen = 0;          // when the hand was last in view
      this.looked = 0;        // when the palm detector last ran on a still frame
      this.id = 0;
      this.stats = { frames: 0, ms: 0, simd: null };
    }

    state(s, d) { this.st = s; if (this.o.onState) try { this.o.onState(s, d); } catch (e) { /* ignore */ } }

    async _worker() {
      if (this.ready) return this.ready;
      this.ready = (async () => {
        const files = await this.o.files();
        const w = this.o.worker();
        await new Promise((res, rej) => {
          const t = setTimeout(() => rej(new Error('the hand tracker did not start')), 20000);
          w.onmessage = (e) => {
            const m = e.data || {};
            if (m.t === 'ready') { clearTimeout(t); this.stats.simd = m.simd; res(); }
            else if (m.t === 'error') { clearTimeout(t); rej(new Error(m.message)); }
          };
          w.onerror = (e) => { clearTimeout(t); rej(new Error((e && e.message) || 'worker error')); };
          const list = Object.values(files).filter((b) => b && b.byteLength);
          w.postMessage({ t: 'init', files }, list);
        });
        w.onmessage = (e) => this._result(e.data || {});
        this.worker = w;
        return w;
      })();
      this.ready.catch(() => { this.ready = null; });
      return this.ready;
    }

    async start() {
      if (this.on) return true;
      this.on = true;
      this.state('starting');
      try {
        await this._worker();
      } catch (err) {
        this.on = false;
        this.state('error', String((err && err.message) || err));
        return false;
      }
      if (!this.on) return false;
      try {
        const md = navigator.mediaDevices;
        if (!md || !md.getUserMedia) throw Object.assign(new Error('no camera'), { name: 'NotFoundError' });
        const video = { width: { ideal: 320 }, height: { ideal: 240 }, frameRate: { ideal: 15, max: 30 } };
        if (this.o.facing) video.facingMode = this.o.facing;
        if (this.o.deviceId) video.deviceId = { exact: this.o.deviceId };
        this.stream = await md.getUserMedia({ video, audio: false });
      } catch (err) {
        this.on = false;
        const n = err && err.name;
        this.state(n === 'NotAllowedError' || n === 'SecurityError' ? 'denied' : n === 'NotFoundError' || n === 'OverconstrainedError' ? 'nocamera' : 'error', String((err && err.message) || err));
        return false;
      }
      if (!this.on) { this._release(); return false; }
      const v = (this.video = document.createElement('video'));
      v.muted = true; v.playsInline = true; v.setAttribute('playsinline', ''); v.autoplay = true;
      v.srcObject = this.stream;
      try { await v.play(); } catch (e) { /* plays once data comes */ }
      this.cv = document.createElement('canvas');
      this.cx = this.cv.getContext('2d', { willReadFrequently: true });
      this.state('on');
      this._tick();
      return true;
    }

    stop() {
      this.on = false;
      clearTimeout(this.timer);
      this._release();
      if (this.worker) this.worker.postMessage({ t: 'reset' });
      this.state('off');
    }

    _release() {
      if (this.stream) for (const t of this.stream.getTracks()) try { t.stop(); } catch (e) { /* ignore */ }
      this.stream = null;
      if (this.video) { try { this.video.srcObject = null; } catch (e) { /* ignore */ } this.video = null; }
    }

    _tick() {
      clearTimeout(this.timer);
      if (!this.on) return;
      const now = performance.now();
      const handNear = now - this.seen < 1200;
      const wait = this.busy ? 8 : handNear ? 0 : 160;
      this.timer = setTimeout(() => {
        if (!this.on) return;
        if (!this.busy) this._grab();
        this._tick();
      }, wait);
    }

    _grab() {
      const v = this.video;
      if (!v || v.readyState < 2 || !v.videoWidth) return;
      const k = Math.min(1, MAX_SIDE / Math.max(v.videoWidth, v.videoHeight));
      const w = Math.round(v.videoWidth * k), h = Math.round(v.videoHeight * k);
      if (this.cv.width !== w || this.cv.height !== h) { this.cv.width = w; this.cv.height = h; this.bufs = []; }
      this.cx.drawImage(v, 0, 0, w, h);
      const img = this.cx.getImageData(0, 0, w, h);
      let buf = this.bufs.pop();
      if (!buf || buf.byteLength !== img.data.length) buf = new ArrayBuffer(img.data.length);
      new Uint8Array(buf).set(img.data);
      const now = performance.now();
      const look = now - this.looked > 1000;
      if (look) this.looked = now;
      this.busy = true;
      this.sent = now;
      this.worker.postMessage({ t: 'frame', id: ++this.id, buf, w, h, look }, [buf]);
      this.w = w; this.h = h;
    }

    _result(m) {
      if (m.t !== 'result') return;
      this.busy = false;
      if (m.buf) this.bufs.push(m.buf);
      if (!this.on) return;
      if (m.skipped) return;
      this.stats.frames++;
      this.stats.ms = this.stats.ms * 0.9 + (m.ms || 0) * 0.1;
      const now = performance.now();
      if (m.hand) this.seen = now;
      if (this.o.onResult) try { this.o.onResult({ hand: m.hand, g: m.g, w: this.w, h: this.h, t: now }); } catch (e) { /* ignore */ }
    }
  }

  root.FlickHandCam = FlickHandCam;
  if (typeof module !== 'undefined' && module.exports) module.exports = FlickHandCam;
})(typeof globalThis !== 'undefined' ? globalThis : this);
