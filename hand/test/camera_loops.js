// Exercises phone/hand/camera.js (reader mode and video mode) with stubbed browser APIs.
// usage: node camera_loops.js [path to camera.js]
const camPath = process.argv[2] || require('path').join(__dirname, '../../phone/hand/camera.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- camera track + MediaStreamTrackProcessor stubs (reader mode)
let framesMade = 0, framesClosed = 0, readsAfterStop = 0, stoppedAt = 0;
const liveFrames = new Set();
function makeTrack() {
  const tr = { live: true, listeners: [], stop() { this.live = false; for (const f of this.listeners) f(); } };
  return tr;
}
globalThis.MediaStreamTrackProcessor = class {
  constructor({ track }) {
    let timer = null;
    this.readable = new ReadableStream({
      start(c) {
        timer = setInterval(() => {
          if (!track.live) return;
          const f = { displayWidth: 640, displayHeight: 480, closed: false, close() { if (!this.closed) { this.closed = true; framesClosed++; liveFrames.delete(this); } } };
          framesMade++; liveFrames.add(f);
          try { c.enqueue(f); } catch (e) { f.close(); }
        }, 10);                                                     // ~100 fps camera, to stress it
        track.listeners.push(() => { clearInterval(timer); try { c.close(); } catch (e) { /* closed */ } });
      },
      cancel() { clearInterval(timer); },
    }, { highWaterMark: 1 });
    const r = this.readable.getReader.bind(this.readable);
    this.readable.getReader = () => {
      const rd = r();
      const read = rd.read.bind(rd);
      rd.read = () => { if (stoppedAt) readsAfterStop++; return read(); };
      return rd;
    };
  }
};
globalThis.OffscreenCanvas = class {
  constructor(w, h) { this.width = w; this.height = h; }
  getContext() { return { drawImage(f) { if (f.closed) throw new Error('drawImage on a closed frame'); }, getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }) }; }
};
// ---- getUserMedia + video element stubs (video mode)
let tracks = [];
Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true, value: { mediaDevices: { getUserMedia: () => new Promise((res) => {
  const tr = makeTrack();
  tracks.push(tr);
  setTimeout(() => res({ getTracks: () => [tr], getVideoTracks: () => [tr] }), 30);
}) } } });
globalThis.document = { createElement: (t) => (t === 'video'
  ? { play: () => new Promise((r) => setTimeout(r, 10)), setAttribute() {}, readyState: 4, videoWidth: 320, videoHeight: 240 }
  : { width: 0, height: 0, getContext: () => ({ drawImage() {}, getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }) }) }) };

const FlickHandCam = require(camPath);

// a worker that answers each frame after `delay(id)` ms, FIFO, one at a time; reports a hand so the camera stays "near"
function makeWorker(delay, stats) {
  const w = { onmessage: null, onerror: null };
  let busyUntil = 0;
  w.postMessage = (m) => {
    if (m.t === 'init') { setTimeout(() => w.onmessage({ data: { t: 'ready', simd: false } }), 5); return; }
    if (m.t !== 'frame') return;
    stats.sent++; stats.inflight++; stats.max = Math.max(stats.max, stats.inflight);
    if (stats.afterStop !== undefined && stats.stopped) stats.afterStop++;
    const now = Date.now();
    busyUntil = Math.max(busyUntil, now) + delay(m.id);
    setTimeout(() => { stats.inflight--; w.onmessage({ data: { t: 'result', id: m.id, buf: m.buf, hand: { lm: [] }, g: {}, ms: 1, skipped: false } }); }, busyUntil - now);
  };
  return w;
}

(async () => {
  // 1. reader mode: run, stop, restart, stop: frames all closed, no reads after the final stop, one reader at a time
  {
    const st = { sent: 0, inflight: 0, max: 0 };
    const cam = new FlickHandCam({ reader: true, size: 640, worker: () => makeWorker(() => 5, st), files: async () => ({}) });
    await cam.start(); await sleep(300);
    cam.stop(); await sleep(5);
    await cam.start(); await sleep(300);
    cam.stop(); stoppedAt = Date.now(); const sentAtStop = st.sent;
    await sleep(300);
    console.log('reader: frames made', framesMade, 'closed', framesClosed, 'still open', liveFrames.size,
      '| frames to tracker', st.sent, 'max in flight', st.max, '| sent after final stop', st.sent - sentAtStop, '| reads after final stop', readsAfterStop);
  }
  // 2. video mode, normal: one frame in flight at a time, nothing sent after stop
  {
    const st = { sent: 0, inflight: 0, max: 0, afterStop: 0, stopped: false };
    const cam = new FlickHandCam({ worker: () => makeWorker(() => 20, st), files: async () => ({}) });
    await cam.start(); await sleep(500);
    cam.stop(); st.stopped = true; await sleep(400);
    console.log('video normal: frames', st.sent, 'max in flight', st.max, 'sent after stop', st.afterStop);
  }
  // 3. video mode, stop + start while a frame is in flight
  {
    const st = { sent: 0, inflight: 0, max: 0 };
    const cam = new FlickHandCam({ worker: () => makeWorker(() => 100, st), files: async () => ({}) });
    await cam.start(); await sleep(20);
    cam.stop(); cam.start(); await sleep(800);
    console.log('video stop+start mid-frame: frames', st.sent, 'max in flight', st.max, 'on', cam.on);
    cam.stop(); await sleep(200);
  }
  // 4. video mode, one frame takes longer than the 3 s busy watchdog, the rest 20 ms (hand stays near)
  {
    const st = { sent: 0, inflight: 0, max: 0 };
    const cam = new FlickHandCam({ worker: () => makeWorker((id) => (id === 3 ? 3400 : 20), st), files: async () => ({}) });
    await cam.start(); await sleep(3200);
    const before = st.max;
    st.max = 0;
    let samples = 0, two = 0;
    for (let i = 0; i < 40; i++) { await sleep(25); samples++; if (st.inflight >= 2) two++; }
    console.log('video slow frame: max in flight before watchdog', before, '| after it: max', st.max, ', samples with 2 in flight', two + '/' + samples);
    cam.stop(); await sleep(100);
  }
  process.exit(0);
})();
