// A camera that watches for a hand: opens the camera, hands small frames to the tracker worker (worker.js) one at a
// time, and reports each result. Shared by the phone app (features/air.js) and the PC app (pc/air/).
//
//   const cam = new FlickHandCam({
//     worker: () => new Worker(...),          // a worker running hand.js + worker.js
//     files: async () => ({ 'hand-simd.wasm': ArrayBuffer, 'hand.wasm': ..., 'palm.fhm': ..., 'landmark.fhm': ... }),
//     facing: 'user',                         // the phone's front camera; a PC takes its default camera
//     size: 320,                              // the frames' long side (a PC's hand is farther away: 640)
//     reader: false,                          // frames straight from the camera's track (the PC's hidden window)
//     onResult(r) {},                         // r: { hand, g, w, h, t } for every frame the tracker looked at
//     onState(s, detail) {},                  // 'starting' | 'on' | 'off' | 'denied' | 'nocamera' | 'error'
//   });
//   await cam.start(); ... cam.stop();
//
// Frames: about 6 a second while no hand is in view (the tracker skips frames where nothing moves), as many as the
// tracker manages while one is near, each of the camera's frames at most once. For a moment after a hand was last seen
// the tracker looks for it in every frame, even a still one (it loses a hand now and then: a fist held still over the
// phone is found again before it counts as gone).
(function (root) {
  'use strict';
  const MAX_SIDE = 320;

  // a 0 ms wait that a hidden page doesn't slow down: Chromium holds a hidden page's timers back to a few a second
  // (the PC's camera window is never shown), while messages go at once
  const soon = (() => {
    if (typeof MessageChannel === 'undefined') return (f) => setTimeout(f, 0);
    const ch = new MessageChannel(), q = [];
    ch.port1.onmessage = () => { const f = q.shift(); if (f) f(); };
    if (ch.port1.unref) ch.port1.unref();          // (Node, in tests: not a reason to keep running)
    return (f) => { q.push(f); ch.port2.postMessage(0); };
  })();

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
      this.vfc = false;       // the video says when it has a new frame (requestVideoFrameCallback)
      this.vf = 0;            // frames it has shown
      this.gf = -1;           // the frame last handed to the tracker
      this.want = null;       // what runs with the next new frame
      this.lastGrab = 0;
      this.stats = { frames: 0, ms: 0, simd: null };
    }

    state(s, d) { this.st = s; if (this.o.onState) try { this.o.onState(s, d); } catch (e) { /* ignore */ } }

    async _worker() {
      if (this.ready) return this.ready;
      const p = (this.ready = (async () => {
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
        // closed meanwhile (close()): not wanted any more
        if (this.ready !== p) { try { w.terminate(); } catch (e) { /* ignore */ } throw new Error('closed'); }
        w.onmessage = (e) => this._result(e.data || {});
        this.worker = w;
        return w;
      })());
      p.catch(() => { if (this.ready === p) this.ready = null; });
      return p;
    }

    // done with it for now (Air grab turned off): the camera off, and the tracker's memory given back (it loads again
    // on the next start)
    close() {
      this.stop();
      const w = this.worker;
      this.worker = null;
      this.ready = null;
      if (w) try { w.terminate(); } catch (e) { /* ignore */ }
    }

    // the tracker loaded ahead (its models are compiled and ready), with the camera still off
    warm() { return this._worker().then(() => true, () => false); }

    async start() {
      if (this.on) return true;
      this.on = true;
      // each start has its own number: a start that a stop() (and maybe another start) overtook while it waited for
      // the tracker or the camera gives up, and closes the camera it opened itself
      const gen = (this.gen = (this.gen || 0) + 1);
      const current = () => this.on && this.gen === gen;
      this.state('starting');
      try {
        await this._worker();
      } catch (err) {
        if (current()) { this.on = false; this.state('error', String((err && err.message) || err)); }
        return false;
      }
      if (!current()) return false;
      let stream;
      try {
        const md = navigator.mediaDevices;
        if (!md || !md.getUserMedia) throw Object.assign(new Error('no camera'), { name: 'NotFoundError' });
        const side = this.o.size || MAX_SIDE;
        // 30 frames a second where the camera gives them: the tracker takes the newest one each time it is free, so a
        // hand is followed as often as the tracker can (at 15, it waited for frames)
        const video = { width: { ideal: side }, height: { ideal: Math.round(side * 3 / 4) }, frameRate: { ideal: 30, max: 30 } };
        if (this.o.facing) video.facingMode = this.o.facing;
        if (this.o.deviceId) video.deviceId = { exact: this.o.deviceId };
        stream = await md.getUserMedia({ video, audio: false });
      } catch (err) {
        if (current()) {
          this.on = false;
          const n = err && err.name;
          this.state(n === 'NotAllowedError' || n === 'SecurityError' ? 'denied' : n === 'NotFoundError' || n === 'OverconstrainedError' ? 'nocamera' : 'error', String((err && err.message) || err));
        }
        return false;
      }
      if (!current()) { for (const t of stream.getTracks()) try { t.stop(); } catch (e) { /* ignore */ } return false; }
      this.stream = stream;
      // a camera that ends by itself (unplugged, taken by another app, turned off in Android's quick settings): off, and
      // said so (frames would stop, and the last one would keep showing a hand that isn't there)
      const track = stream.getVideoTracks ? stream.getVideoTracks()[0] : null;
      if (track && track.addEventListener) track.addEventListener('ended', () => this._fail(gen, new Error('the camera stopped')));
      // a page that is never shown (the PC's camera window) draws a video element only a few times a second: there the
      // frames come straight from the camera's track, each one once
      if (this.o.reader && typeof MediaStreamTrackProcessor === 'function' && typeof OffscreenCanvas === 'function') {
        this.state('on');
        this._read(stream.getVideoTracks()[0], gen);
        return true;
      }
      const v = (this.video = document.createElement('video'));
      v.muted = true; v.playsInline = true; v.setAttribute('playsinline', ''); v.autoplay = true;
      v.srcObject = stream;
      try { await v.play(); } catch (e) { /* plays once data comes */ }
      if (!current()) return false;                 // stop() released this stream meanwhile
      this.cv = document.createElement('canvas');
      this.cx = this.cv.getContext('2d', { willReadFrequently: true });
      this._frames(v, gen);
      this.state('on');
      this._tick();
      return true;
    }

    // the video's frames as it shows them (requestVideoFrameCallback): the tracker gets each one at most once. Grabbing
    // again before a new one comes only hands it the same picture: work for nothing (and a hand that seems to stop)
    _frames(v, gen) {
      this.vf = 0; this.gf = -1; this.want = null;
      this.vfc = typeof v.requestVideoFrameCallback === 'function';
      if (!this.vfc) return;
      const on = () => {
        if (!this.on || this.gen !== gen || this.video !== v) return;
        this.vf++;
        const f = this.want;
        if (f) { this.want = null; clearTimeout(this.timer); f(); }
        v.requestVideoFrameCallback(on);
      };
      v.requestVideoFrameCallback(on);
    }

    stop() {
      this.on = false;
      this.gen = (this.gen || 0) + 1;
      this.want = null;
      clearTimeout(this.timer);
      this._release();
      if (this.worker) this.worker.postMessage({ t: 'reset' });
      this.state('off');
    }

    _release() {
      if (this.stream) for (const t of this.stream.getTracks()) try { t.stop(); } catch (e) { /* ignore */ }
      this.stream = null;
      if (this.rd) { try { this.rd.cancel().catch(() => {}); } catch (e) { /* ignore */ } this.rd = null; }
      if (this.video) { try { this.video.srcObject = null; } catch (e) { /* ignore */ } this.video = null; }
    }

    // the next frame: as soon as there is a new one while a hand is near (as fast as the tracker goes), else after a
    // short rest; never while the tracker still has one (its result asks for the next)
    _tick() {
      clearTimeout(this.timer);
      this.want = null;
      if (!this.on || this.busy || this.rd) return;    // (frames read from the track come by themselves)
      const go = () => {
        if (!this.on || this.busy) return;
        try { if (!this._grab()) this.timer = setTimeout(() => this._tick(), 40); }    // no picture yet
        catch (e) { this.timer = setTimeout(() => this._tick(), 200); }               // a frame that can't be read
      };
      if (performance.now() - this.seen < 1200) this._next(go);
      else this.timer = setTimeout(() => this._next(go), 160);
    }

    // go, with a frame the tracker hasn't had: at once if the video has one, else as soon as it shows the next
    _next(go) {
      if (!this.vfc) {
        // (no word from the video about its frames: at most one a camera frame's time)
        const wait = this.lastGrab + 30 - performance.now();
        if (wait <= 0) soon(go); else this.timer = setTimeout(go, wait);
        return;
      }
      if (this.vf !== this.gf) { soon(go); return; }
      this.want = go;
      // a video that never says (frame callbacks that don't come here): it's asked no more, and frames are timed instead.
      // One that said before and stops (a camera that froze) is waited for: its last picture would only show a hand
      // that may have gone
      if (!this.vf) this.timer = setTimeout(() => { if (this.want === go && !this.vf) { this.vfc = false; this.want = null; go(); } }, 600);
    }

    // frames from the camera's track as they come (reader: true): one at a time to the tracker, every third one while
    // no hand is near (about 5 a second)
    async _read(track, gen) {
      let rd;
      try { rd = this.rd = new MediaStreamTrackProcessor({ track }).readable.getReader(); } catch (e) { this._fail(gen, e); return; }
      let n = 0, errors = 0;
      for (;;) {
        let f = null;
        try {
          const r = await rd.read();
          if (r.done) break;
          f = r.value;
        } catch (e) { break; }                       // the camera stopped (stop() cancels the reader)
        try {
          if (!this.on || this.gen !== gen) break;
          const near = performance.now() - this.seen < 1200;
          if (this.busy || (!near && n++ % 3 !== 0)) continue;
          const k = Math.min(1, (this.o.size || MAX_SIDE) / Math.max(f.displayWidth, f.displayHeight));
          const w = Math.round(f.displayWidth * k), h = Math.round(f.displayHeight * k);
          if (!this.oc || this.oc.width !== w || this.oc.height !== h) {
            this.oc = new OffscreenCanvas(w, h);
            this.ox = this.oc.getContext('2d', { willReadFrequently: true });
            this.bufs = [];
          }
          this.ox.drawImage(f, 0, 0, w, h);
          f.close(); f = null;
          this._send(this.ox.getImageData(0, 0, w, h), w, h);
          errors = 0;
        } catch (e) {
          if (++errors >= 5) { this._fail(gen, e); break; }   // a frame that can't be read is skipped; five in a row stop it
        } finally {
          if (f) try { f.close(); } catch (e) { /* ignore */ }
        }
      }
      // the camera ended by itself (not stopped here): off, and said so
      this._fail(gen, new Error('the camera stopped'));
    }

    // the camera can't be read: off, and said so
    _fail(gen, e) {
      if (!this.on || this.gen !== gen) return;
      this.stop();
      this.state('error', String((e && e.message) || e));
    }

    _grab() {
      const v = this.video;
      if (!v || v.readyState < 2 || !v.videoWidth) return false;
      const k = Math.min(1, (this.o.size || MAX_SIDE) / Math.max(v.videoWidth, v.videoHeight));
      const w = Math.round(v.videoWidth * k), h = Math.round(v.videoHeight * k);
      if (this.cv.width !== w || this.cv.height !== h) { this.cv.width = w; this.cv.height = h; this.bufs = []; }
      this.gf = this.vf;
      this.lastGrab = performance.now();
      this.cx.drawImage(v, 0, 0, w, h);
      this._send(this.cx.getImageData(0, 0, w, h), w, h);
      return true;
    }

    // one frame's pixels to the tracker
    _send(img, w, h) {
      let buf = this.bufs.pop();
      if (!buf || buf.byteLength !== img.data.length) buf = new ArrayBuffer(img.data.length);
      new Uint8Array(buf).set(img.data);
      const now = performance.now();
      const every = now - this.looked > 1000;
      if (every) this.looked = now;
      // a hand seen a moment ago is looked for in every frame, moving or not (the tracker lost it: it comes back)
      const look = every || now - this.seen < 1200;
      this.busy = true;
      this.sent = now;
      this.w = w; this.h = h;
      const id = (this.inflight = ++this.id);
      // a tracker that never answers (it shouldn't) doesn't stop the camera's frames for good: that frame is given up
      clearTimeout(this.busyT);
      this.busyT = setTimeout(() => { if (this.inflight === id) { this.inflight = 0; this.busy = false; this._tick(); } }, 3000);
      this.worker.postMessage({ t: 'frame', id, buf, w, h, look }, [buf]);
    }

    _result(m) {
      if (m.t !== 'result') return;
      if (m.buf) this.bufs.push(m.buf);
      if (m.id !== this.inflight) return;           // a frame given up on (see _send): the one in flight is another
      this.inflight = 0;
      clearTimeout(this.busyT);
      this.busy = false;
      if (!this.on) return;
      if (!m.skipped) {
        this.stats.frames++;
        this.stats.ms = this.stats.ms * 0.9 + (m.ms || 0) * 0.1;
        const now = performance.now();
        if (m.hand) this.seen = now;
        // (detected: the tracker had lost the hand and looked for it afresh: it may be another one)
        if (this.o.onResult) try { this.o.onResult({ hand: m.hand, g: m.g, w: this.w, h: this.h, t: now, detected: !!m.detected }); } catch (e) { /* ignore */ }
      }
      if (!this.rd) this._tick();                   // (frames read from the track come by themselves)
    }
  }

  root.FlickHandCam = FlickHandCam;
  if (typeof module !== 'undefined' && module.exports) module.exports = FlickHandCam;
})(typeof globalThis !== 'undefined' ? globalThis : this);
