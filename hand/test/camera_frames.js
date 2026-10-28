// camera.js on the phone (frames drawn from a video element): the tracker gets each of the camera's frames at most once.
// Right after a hand leaves, frames the tracker skips (nothing moving) come back at once; grabbing again then must wait
// for the camera's next frame instead of drawing the same picture over and over on the page's thread.
// A made-up 30 fps camera, with and without requestVideoFrameCallback, and a made-up tracker.
// usage: node camera_frames.js
const path = require('path');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const ok = (c, what) => { console.log((c ? '  ok   ' : '  FAIL ') + what); if (!c) fails++; };

async function run(withCallback) {
  let grabs = 0, distinct = 0, dup = 0, lastFrame = -1, looks = 0, sent = 0;
  const t0 = Date.now();
  const camFrame = () => Math.floor((Date.now() - t0) / 33.3);
  Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true, value: { mediaDevices: { getUserMedia: async () => { const tr = { stop() {}, addEventListener() {} }; return { getTracks: () => [tr], getVideoTracks: () => [tr] }; } } } });
  global.document = {
    createElement: (t) => {
      if (t === 'video') {
        const v = { play: async () => {}, setAttribute() {}, readyState: 4, videoWidth: 320, videoHeight: 240, lastF: -1 };
        if (withCallback) v.requestVideoFrameCallback = (cb) => { const tick = () => { const f = camFrame(); if (f > v.lastF) { v.lastF = f; cb(0, {}); } else setTimeout(tick, 2); }; setTimeout(tick, 2); };
        return v;
      }
      return { width: 0, height: 0, getContext: () => ({
        drawImage() { grabs++; const f = camFrame(); if (f === lastFrame) dup++; else distinct++; lastFrame = f; },
        getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
      }) };
    },
  };
  delete require.cache[require.resolve('../../phone/hand/camera.js')];
  const FlickHandCam = require('../../phone/hand/camera.js');
  let phase = 'hand';
  const worker = () => {
    const w = { onmessage: null, terminate() {} };
    w.postMessage = (m) => {
      if (m.t === 'init') { setTimeout(() => w.onmessage({ data: { t: 'ready' } }), 1); return; }
      if (m.t !== 'frame') return;
      sent++;
      if (m.look) looks++;
      if (phase === 'hand') setTimeout(() => w.onmessage({ data: { t: 'result', id: m.id, buf: m.buf, hand: { lm: [] }, g: {}, ms: 12 } }), 12);
      else setImmediate(() => w.onmessage({ data: { t: 'result', id: m.id, buf: m.buf, hand: null, g: null, ms: 0, skipped: !m.look } }));
    };
    return w;
  };
  const cam = new FlickHandCam({ worker, files: async () => ({}), onResult() {} });
  if (!(await cam.start())) throw new Error('the camera did not start: ' + cam.st);
  await sleep(1000);
  const a = { grabs, distinct, dup };
  grabs = distinct = dup = 0; looks = sent = 0;
  phase = 'gone';
  await sleep(1200);
  const b = { grabs, distinct, dup, looks, sent };
  grabs = 0;
  await sleep(1000);
  const c = { grabs };
  cam.close();
  return { a, b, c };
}

(async () => {
  console.log('with requestVideoFrameCallback');
  let r = await run(true);
  ok(r.a.dup <= 2 && r.a.grabs >= 20 && r.a.grabs <= 33, 'a hand in view, 1 s: ' + r.a.grabs + ' frames to the tracker, ' + r.a.dup + ' of them the same picture again');
  ok(r.b.grabs >= 30 && r.b.grabs <= 40 && r.b.dup <= 2, 'the hand just gone, 1.2 s: ' + r.b.grabs + ' frames (the camera made about 36), ' + r.b.dup + ' the same picture again');
  ok(r.b.looks >= r.b.sent - 2, 'and the tracker looks for it in each of them, still or not (' + r.b.looks + ' of ' + r.b.sent + ')');
  ok(r.c.grabs >= 3 && r.c.grabs <= 8, 'later, no hand: ' + r.c.grabs + ' frames a second');
  console.log('without it (frames timed instead)');
  r = await run(false);
  ok(r.a.grabs >= 20 && r.a.grabs <= 36, 'a hand in view, 1 s: ' + r.a.grabs + ' frames');
  ok(r.b.grabs >= 25 && r.b.grabs <= 45, 'the hand just gone, 1.2 s: ' + r.b.grabs + ' frames (not thousands)');
  ok(r.c.grabs >= 3 && r.c.grabs <= 8, 'later: ' + r.c.grabs + ' frames a second');
  console.log(fails ? fails + ' FAILED' : 'ALL PASS');
  process.exit(fails ? 1 : 0);
})();
