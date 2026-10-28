// The hand tracker in a Web Worker, so the camera never slows the page down. hand.js must be loaded first in the
// worker (importScripts, or the page builds the worker from both files). Messages:
//   in   { t: 'init', files: { 'hand-simd.wasm' | 'hand.wasm', 'palm.fhm', 'landmark.fhm': ArrayBuffer } }
//        { t: 'frame', id, buf: ArrayBuffer (RGBA), w, h, look: bool }   look: run the palm detector even if
//        nothing moved (the page asks for that every second or so)
//   out  { t: 'ready', simd } | { t: 'error', message }
//        { t: 'result', id, buf (handed back for the next frame), hand: null | { lm, score }, g: gesture, ms, skipped,
//          detected (the palm detector ran: no hand was being followed) }
//
// Where Web Workers can't be made, FlickHandWorker.inline() runs the same code on the page (slower to the page).
(function (root) {
  'use strict';

  function attach(port) {
    let hands = null;
    const FH = root.FlickHand;

    port.onmessage = async (e) => {
      const m = e.data || {};
      if (m.t === 'init') {
        try {
          const files = m.files || {};
          hands = await FH.load({ fetch: async (u) => files[String(u).split('/').pop()], simd: !!files['hand-simd.wasm'] && FH.hasSimd() });
          port.postMessage({ t: 'ready', simd: hands.simd });
        } catch (err) {
          port.postMessage({ t: 'error', message: String((err && err.message) || err) });
        }
        return;
      }
      if (m.t === 'reset') { if (hands) hands.reset(); return; }
      if (m.t !== 'frame' || !hands) return;
      const px = new Uint8Array(m.buf);
      let out = { t: 'result', id: m.id, buf: m.buf, hand: null, g: null, ms: 0, skipped: false };
      try {
        const following = !!hands.tracker.roi;
        // nothing being followed and nothing moving in front of the camera: skip the models (saves the battery)
        const mo = hands.motion(px, m.w, m.h);
        if (!following && !m.look && mo.motion < 1.6) {
          out.skipped = true;
        } else if (!following && mo.luma < 12) {
          out.skipped = true;                              // too dark to see a hand (the phone face down, a covered camera)
        } else {
          const r = hands.track(px, m.w, m.h);
          out.ms = r.ms;
          out.detected = !!r.detected;
          if (r.hand) {
            out.hand = { lm: Array.from(r.hand.lm), score: r.hand.score };
            out.g = FH.gesture(r.hand.lm, m.w, m.h);
          }
        }
      } catch (err) {
        out.error = String((err && err.message) || err);
      }
      port.postMessage(out, [m.buf]);
    };
  }

  // a worker-like object running on the page itself. Its messages go through a MessageChannel, not timers: a hidden
  // page's timers are held back to a few a second (the PC's camera window is never shown)
  function inline() {
    const w = { onmessage: null, onerror: null, terminate() {} };
    const port = { onmessage: null };
    const ch = new MessageChannel(), q = [];
    ch.port1.onmessage = () => { const f = q.shift(); if (f) f(); };
    const soon = (f) => { q.push(f); ch.port2.postMessage(0); };
    port.postMessage = (m) => soon(() => { if (w.onmessage) w.onmessage({ data: m }); });
    w.postMessage = (m) => soon(() => port.onmessage({ data: m }));
    w.terminate = () => { try { ch.port1.close(); } catch (e) { /* ignore */ } };
    attach(port);
    return w;
  }

  root.FlickHandWorker = { attach, inline };
  if (typeof WorkerGlobalScope !== 'undefined' && root instanceof WorkerGlobalScope) attach(root);
})(typeof globalThis !== 'undefined' ? globalThis : this);
