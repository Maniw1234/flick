// FlickHandCam turned off and on again quickly (Air grab off and on) while the tracker still had a frame: the hand is
// looked for again as soon as the camera is back (a new tracker answers at once), not 3 s later. With the same tracker
// (Flick to the back and back) its frame is finished first, as before.
// usage: node camera_restart.js [path to camera.js]
const path = require('path');
const camPath = process.argv[2] || path.join(__dirname, '../../phone/hand/camera.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true, value: { mediaDevices: { getUserMedia: async () => { const tr = { stop() {}, addEventListener() {} }; return { getTracks: () => [tr], getVideoTracks: () => [tr] }; } } } });
globalThis.document = { createElement: (t) => (t === 'video'
  ? { play: async () => {}, setAttribute() {}, readyState: 4, videoWidth: 320, videoHeight: 240 }
  : { width: 0, height: 0, getContext: () => ({ drawImage() {}, getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }) }) }) };
const FlickHandCam = require(camPath);
let fails = 0;
const ok = (c, what) => { console.log((c ? '  ok   ' : '  FAIL ') + what); if (!c) fails++; };
(async () => {
  for (const how of ['stop', 'close']) {
    let sent = [], results = [], slow = true;
    const worker = () => {
      const w = { onmessage: null, terminated: false, terminate() { this.terminated = true; } };
      w.postMessage = (m) => {
        if (m.t === 'init') { setTimeout(() => w.onmessage({ data: { t: 'ready' } }), 5); return; }
        if (m.t !== 'frame') return;
        sent.push(Date.now());
        // the first frame takes the tracker a long while (a slow phone, the models warming up); the rest are quick
        setTimeout(() => { if (!w.terminated) w.onmessage({ data: { t: 'result', id: m.id, buf: m.buf, hand: { lm: [] }, g: {}, ms: 10 } }); }, slow ? 2500 : 10);
        slow = false;
      };
      return w;
    };
    const cam = new FlickHandCam({ worker, files: async () => ({}), onResult() { results.push(Date.now()); } });
    await cam.start();
    for (let i = 0; i < 40 && !sent.length; i++) await sleep(20);
    await sleep(50);                                    // the first frame is in the tracker
    ok(sent.length === 1, how + ': the first frame went (' + sent.length + ')');
    cam[how]();
    await sleep(50);
    const t0 = Date.now();
    sent = []; results = [];
    await cam.start();
    await sleep(3300);
    const first = results.length ? results[0] - t0 : -1;
    if (how === 'close') ok(first >= 0 && first < 400, 'closed and on again at once: the new tracker answers in ' + (first >= 0 ? first + ' ms' : 'more than 3.3 s'));
    else ok(first >= 0 && first < 2900, 'stopped and on again at once: an answer once its frame is done (' + first + ' ms), and frames keep going');
    cam.close();
  }
  console.log(fails ? fails + ' FAILED' : 'ALL PASS');
  process.exit(fails ? 1 : 0);
})();
