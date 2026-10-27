// reader mode: drawImage throws once (5th frame). Does reading stop with the camera still on, and is that frame left open?
const camPath = process.argv[2] || require('path').join(__dirname, '../../phone/hand/camera.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let made = 0; const open = new Set(); let draws = 0;
globalThis.MediaStreamTrackProcessor = class {
  constructor({ track }) {
    let timer;
    this.readable = new ReadableStream({
      start(c) { timer = setInterval(() => { const f = { displayWidth: 640, displayHeight: 480, close() { open.delete(this); } }; made++; open.add(f); c.enqueue(f); }, 10); track.end = () => { clearInterval(timer); c.close(); }; },
      cancel() { clearInterval(timer); for (const f of [...open]) f.close(); },   // a canceled processor closes what it still holds
    }, { highWaterMark: 1 });
  }
};
globalThis.OffscreenCanvas = class { constructor(w, h) { this.width = w; this.height = h; } getContext() { return { drawImage() { if (++draws === 5) throw new Error('boom'); }, getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }) }; } };
Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true, value: { mediaDevices: { getUserMedia: async () => { const tr = { stop() { if (tr.end) tr.end(); } }; return { getTracks: () => [tr], getVideoTracks: () => [tr] }; } } } });
globalThis.document = { createElement: () => ({}) };
const FlickHandCam = require(camPath);
let sent = 0;
const worker = () => { const w = { onmessage: null }; w.postMessage = (m) => { if (m.t === 'init') setTimeout(() => w.onmessage({ data: { t: 'ready' } }), 1); else if (m.t === 'frame') { sent++; setTimeout(() => w.onmessage({ data: { t: 'result', id: m.id, buf: m.buf, hand: {}, g: {} } }), 2); } }; return w; };
(async () => {
  const cam = new FlickHandCam({ reader: true, worker, files: async () => ({}) });
  await cam.start(); await sleep(300);
  const leakedBeforeStop = [...open].length;
  console.log('frames to tracker', sent, '| draws', draws, '| camera on', cam.on, 'state', cam.st, '| unclosed frames while running', leakedBeforeStop);
  cam.stop(); await sleep(50);
  console.log('after stop: unclosed frames', open.size);
  process.exit(0);
})();
