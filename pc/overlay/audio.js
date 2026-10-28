'use strict';
/* Flick overlay: each look's sound (sounds/<look>.wav: a riser played fast, its big moment where the card lands), at the
   volume set in Settings. The sounds are decoded once, without opening the sound device; the device opens when a card
   is lifted on the phone (so the flick that follows is heard at once) and is let go again a moment after the last sound. */
(function () {
  const A = {};
  window.SFX = A;
  A.enabled = true;
  let vol = 0.7;
  let ctx = null, out = null, told = false;
  const bufs = {}, loads = {};
  const live = new Set();                 // sounds playing: { src, g, end }
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  // the slider's quiet half gets most of its travel: loudness follows it more evenly than a straight line would
  const gainOf = (v) => Math.pow(clamp(v, 0, 1), 1.6);

  function init() {
    if (ctx) return ctx;
    try {
      ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
      out = ctx.createGain();
      out.gain.value = gainOf(vol);
      out.connect(ctx.destination);
    } catch (e) {
      ctx = null;
      if (!told) { told = true; console.log('sound: no sound device (' + e.message + ')'); }    // (to Flick's log)
    }
    return ctx;
  }
  A.now = () => (ctx ? ctx.currentTime : 0);
  A.state = () => (ctx ? ctx.state : 'none');
  A.setVolume = function (v) {
    v = +v;
    vol = Number.isFinite(v) ? clamp(v, 0, 1) : 0.7;
    if (out) out.gain.setTargetAtTime(gainOf(vol), ctx.currentTime, 0.015);
  };
  A.volume = () => vol;

  // decoded with an offline context: no sound device is opened for it
  let decoder = null;
  function load(name) {
    if (bufs[name]) return Promise.resolve(bufs[name]);
    if (!loads[name]) {
      loads[name] = fetch('sounds/' + name + '.wav')
        .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); })
        .then((b) => {
          if (!decoder) decoder = new OfflineAudioContext(2, 1, 44100);
          return decoder.decodeAudioData(b);
        })
        .then((buf) => (bufs[name] = buf))
        .catch((e) => { console.log('sound ' + name + ': ' + e.message); delete loads[name]; return null; });
    }
    return loads[name];
  }
  A.preload = (names) => { for (const n of names || []) load(n); };

  // The device is let go once nothing has played for a moment: a context left running renders silence all the time (an
  // audio thread busy for nothing, the sound device kept awake). The next sound (or lift) opens it again.
  let until = 0, idleT = null, suspending = null;
  function keep(sec) {
    if (!ctx) return;
    until = Math.max(until, performance.now() + sec * 1000);
    clearTimeout(idleT);
    idleT = setTimeout(rest, Math.max(0, until - performance.now()) + 1200);
  }
  function rest() {
    idleT = null;
    if (!ctx || ctx.state !== 'running') return;
    if (live.size || performance.now() < until) { keep(0.2); return; }
    suspending = ctx.suspend().catch(() => {}).then(() => { suspending = null; });
  }
  // running, now or soon: resolves when the context plays
  function running() {
    const c = init();
    if (!c) return Promise.resolve(null);
    if (c.state === 'running' && !suspending) return Promise.resolve(c);
    return (suspending || Promise.resolve()).then(() => c.resume()).then(() => c, () => c);
  }
  // a card was lifted: open the sound device now so the flick that follows plays at once
  A.warm = function () {
    if (!A.enabled) return;
    running();
    keep(6);
  };
  // how long after now a sound started now is heard (the picture waits as long, to meet it)
  A.latency = function () {
    if (!A.enabled || !ctx || ctx.state !== 'running') return 0;
    return clamp((ctx.outputLatency || 0) + (ctx.baseLatency || 0), 0, 0.08);
  };

  // plays a look's sound from `offset` s into it. A sound that can't start at once (still decoding, the device still
  // opening) starts later that much further in, so it stays with the picture; more than half a second late, it's dropped.
  // Never more than two at a time: a third (many files thrown at once) stops the oldest.
  A.play = function (name, o) {
    const h = { stopped: false, src: null, g: null, stop() { h.fade(0.03); }, fade(sec) {
      h.stopped = true;
      if (!h.src || !ctx) return;
      const t = ctx.currentTime;
      try { h.g.gain.setTargetAtTime(0.0001, t, Math.max(0.005, sec / 4)); h.src.stop(t + sec + 0.05); } catch (e) { /* already stopped */ }
    } };
    if (!A.enabled) return h;
    const asked = performance.now(), offset = (o && o.offset) || 0;
    Promise.all([load(name), running()]).then(([buf, c]) => {
      if (!buf || !c || h.stopped || !A.enabled) return;
      const late = (performance.now() - asked) / 1000;
      if (late > 0.5) { console.log('sound ' + name + ': the sound device took too long to start, skipped'); return; }
      if (offset + late >= buf.duration) return;
      if (live.size >= 2) { const first = live.values().next().value; first.h.fade(0.06); live.delete(first); }
      const src = c.createBufferSource();
      src.buffer = buf;
      const g = c.createGain();
      src.connect(g).connect(out);
      src.start(c.currentTime, offset + late);
      h.src = src; h.g = g;
      const rec = { h };
      live.add(rec);
      src.onended = () => { live.delete(rec); keep(0); };
      keep(buf.duration - offset);
    });
    return h;
  };
  A.stopAll = () => { for (const r of live) r.h.stop(); live.clear(); };
})();
