'use strict';
// The hidden window that looks for a hand in front of this PC (pc/air.js opens it and says when): the PC's camera, the
// phone app's hand tracker (hand/: its files come from the main process) and the hand's events, sent to the main
// process. The camera's pictures stay in this window.
(function () {
  const api = window.flick;
  const HAND = new URLSearchParams(location.search).get('hand') || '../hand';
  const FILES = ['hand-simd.wasm', 'hand.wasm', 'palm.fhm', 'landmark.fhm'];
  const load = (n) => new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = HAND.replace(/\/$/, '') + '/' + n;
    s.onload = resolve;
    s.onerror = () => reject(new Error('could not load ' + n));
    document.head.appendChild(s);
  });
  let cam = null, stream = null, want = false;

  const setup = (async () => {
    for (const n of ['hand.js', 'worker.js', 'camera.js', 'stream.js']) await load(n);
    stream = new window.FlickHandStream({
      mirror: true,                                   // the camera faces the user: the hand moves the way it looks
      // (aim: where the hand was aimed before its pose began to change: a fist that opens lands what it holds there)
      onEvent: (type, e) => api.send('air:event', { type, pose: e.pose, pos: e.pos, aim: e.aim, size: e.size, edge: e.edge }),
    });
    cam = new window.FlickHandCam({
      worker: () => window.FlickHandWorker.inline(),  // this window shows nothing: the tracker can run on its page
      size: 640,                                      // a hand in front of a screen is farther from its camera
      reader: true,                                   // this window is never shown: frames straight from the track
      files: async () => {
        const out = {};
        for (const n of FILES) {
          const b = await api.invoke('air:file', n);
          if (b && b.byteLength) out[n] = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
        }
        return out;
      },
      onResult: (r) => stream.push(r),
      onState: (state, detail) => api.send('air:state', { state, detail: detail ? String(detail).slice(0, 200) : '' }),
    });
    window.__air = { cam: () => cam, stream: () => stream };   // tests (main.js' test control)
    // frames the tracker skipped (nothing moving) still let a hand that went out of view leave
    setInterval(() => { if (cam && cam.on) stream.push({ t: performance.now() }); }, 200);
  })();

  // a phone is ready to grab: load the hand tracker now, so the camera only has to open when it's wanted
  api.on('air:warm', async () => {
    try { await setup; } catch (e) { return; }
    cam.warm();
  });
  api.on('air:start', async () => {
    want = true;
    try { await setup; } catch (e) { api.send('air:state', { state: 'error', detail: String(e && e.message) }); return; }
    if (want) cam.start();
  });
  api.on('air:stop', async () => {
    want = false;
    try { await setup; } catch (e) { return; }
    cam.stop();
    stream.reset();
  });
})();
