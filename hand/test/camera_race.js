// FlickHandCam (phone/hand/camera.js) with stubbed browser APIs: however start() and stop() interleave while the
// tracker or the camera is still starting, no camera is left open after the last stop(), and one is open after a
// last start(). usage: node camera_race.js
const path = require('path');
const tracks = [];
let opened = 0;
// (Node has a navigator of its own: replaced, not assigned)
Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true, value: { mediaDevices: { getUserMedia: () => new Promise((res) => {
  const tr = { id: ++opened, live: true, stop() { this.live = false; } };
  tracks.push(tr);
  setTimeout(() => res({ getTracks: () => [tr] }), 40);          // the camera takes a moment to open
}) } } });
globalThis.document = { createElement: (t) => (t === 'video'
  ? { play: () => new Promise((r) => setTimeout(r, 15)), setAttribute() {}, readyState: 0, videoWidth: 0 }
  : { getContext: () => ({}) }) };
const FlickHandCam = require(path.join(__dirname, '../../phone/hand/camera.js'));
const worker = () => {
  const w = { onmessage: null, onerror: null };
  w.postMessage = (m) => { if (m.t === 'init') setTimeout(() => w.onmessage({ data: { t: 'ready', simd: false } }), 20); };
  return w;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const live = () => tracks.filter((t) => t.live).length;

// each plan: [ 'start' | 'stop' | ms to wait, ... ]; the camera must end up as its last command says
const PLANS = [
  ['start', 10, 'stop', 'start', 200, 'stop'],           // put back and grab again while the camera opens
  ['start', 30, 'stop', 200],                            // stopped while opening
  ['start', 50, 'stop', 200],                            // stopped while the video starts playing
  ['start', 'stop', 'start', 'stop', 'start', 200],      // a burst: on at the end
  ['start', 5, 'stop', 5, 'start', 5, 'stop', 200],
  ['start', 200, 'stop', 'start', 'stop', 'start', 200, 'stop', 50],
];
(async () => {
  let bad = 0;
  for (const plan of PLANS) {
    tracks.length = 0;
    const states = [];
    const cam = new FlickHandCam({ worker, files: async () => ({}), onState: (s) => states.push(s) });
    let want = false;
    for (const step of plan) {
      if (step === 'start') { want = true; cam.start(); } else if (step === 'stop') { want = false; cam.stop(); } else await sleep(step);
    }
    await sleep(150);
    const ok = want ? live() === 1 && cam.on : live() === 0 && !cam.on;
    if (!ok) bad++;
    console.log((ok ? 'ok   ' : 'FAIL ') + plan.join(' ') + '  -> live cameras ' + live() + ', on ' + cam.on + '  (' + states.join(' > ') + ')');
    cam.stop();
  }
  console.log(bad ? bad + ' failed' : 'all ' + PLANS.length + ' passed');
  process.exit(bad ? 1 : 0);
})();
