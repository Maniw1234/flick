'use strict';
/* Flick overlay — synthesized sound (no samples). */
(function () {
  const A = {};
  window.SFX = A;
  A.enabled = true;
  let ctx = null, out = null, verbIn = null, noise = null;

  function init() {
    if (ctx) return ctx;
    try {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -14; comp.knee.value = 10; comp.ratio.value = 4; comp.attack.value = 0.003; comp.release.value = 0.15;
      out = ctx.createGain(); out.gain.value = 0.75;
      out.connect(comp).connect(ctx.destination);
      // short synthetic room
      const len = Math.floor(ctx.sampleRate * 1.4);
      const ir = ctx.createBuffer(2, len, ctx.sampleRate);
      for (let ch = 0; ch < 2; ch++) {
        const d = ir.getChannelData(ch);
        for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3.2) * (i < 40 ? i / 40 : 1);
      }
      const conv = ctx.createConvolver(); conv.buffer = ir;
      verbIn = ctx.createGain(); verbIn.gain.value = 1;
      const wet = ctx.createGain(); wet.gain.value = 0.22;
      verbIn.connect(conv).connect(wet).connect(out);
      noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
      const nd = noise.getChannelData(0);
      for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
    } catch (e) { ctx = null; }
    return ctx;
  }
  function ready() {
    if (!A.enabled) return null;
    const c = init();
    if (c && c.state === 'suspended') c.resume();
    return c;
  }
  A.now = () => (ctx ? ctx.currentTime : 0);

  // Once nothing has played for a moment (and no hum is held) the context is suspended: left running it renders
  // silence all the time, an audio thread busy for nothing and the sound device kept awake. The next sound resumes it.
  let playsUntil = 0, drones = 0, idleT = null;
  function playing(end) {
    playsUntil = Math.max(playsUntil, end);
    clearTimeout(idleT);
    idleT = setTimeout(rest, Math.max(0, playsUntil - ctx.currentTime) * 1000 + 1600);   // (+ the room's echo)
  }
  function rest() {
    idleT = null;
    if (!ctx || drones > 0 || ctx.state !== 'running') return;
    if (ctx.currentTime < playsUntil + 1.5) { playing(playsUntil); return; }
    ctx.suspend().catch(() => {});
  }

  function route(node, pan, verb) {
    let n = node;
    if (pan && ctx.createStereoPanner) { const p = ctx.createStereoPanner(); p.pan.value = Math.max(-1, Math.min(1, pan)); n.connect(p); n = p; }
    n.connect(out);
    if (verb) { const s = ctx.createGain(); s.gain.value = verb; n.connect(s).connect(verbIn); }
  }
  function env(g, t, gain, attack, dur, curve) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(gain, 0.0002), t + Math.max(0.002, attack));
    g.gain.exponentialRampToValueAtTime(0.0001, t + Math.max(attack + 0.01, dur) * (curve || 1));
  }

  // filtered noise burst: hiss, whoosh, splash
  A.noise = function (o) {
    const c = ready(); if (!c) return;
    const t = c.currentTime + (o.at || 0);
    const src = c.createBufferSource(); src.buffer = noise; src.loop = true;
    src.playbackRate.value = o.rate || 1;
    const f = c.createBiquadFilter(); f.type = o.type || 'bandpass'; f.Q.value = o.q || 0.8;
    f.frequency.setValueAtTime(o.f0 || 1000, t);
    if (o.f1) f.frequency.exponentialRampToValueAtTime(o.f1, t + (o.dur || 0.3));
    const g = c.createGain();
    env(g, t, o.gain || 0.1, o.attack || 0.01, o.dur || 0.3);
    src.connect(f).connect(g);
    route(g, o.pan, o.verb);
    src.start(t, Math.random() * 1.5); src.stop(t + (o.dur || 0.3) + 0.1);
    playing(t + (o.dur || 0.3) + 0.1);
  };
  // oscillator with pitch sweep
  A.tone = function (o) {
    const c = ready(); if (!c) return;
    const t = c.currentTime + (o.at || 0);
    const osc = c.createOscillator(); osc.type = o.type || 'sine';
    osc.frequency.setValueAtTime(o.f0 || 440, t);
    if (o.f1) osc.frequency.exponentialRampToValueAtTime(o.f1, t + (o.sweep || o.dur || 0.3));
    if (o.detune) osc.detune.value = o.detune;
    const g = c.createGain();
    env(g, t, o.gain || 0.05, o.attack || 0.005, o.dur || 0.3);
    let n = osc.connect(g);
    if (o.lp) { const f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = o.lp; n = g.connect(f); }
    route(n, o.pan, o.verb);
    osc.start(t); osc.stop(t + (o.dur || 0.3) + 0.1);
    playing(t + (o.dur || 0.3) + 0.1);
  };
  // a held voice whose level/pitch are driven every frame (approach hums)
  A.drone = function (o) {
    const c = ready(); if (!c) return null;
    const oscs = (o.freqs || [55]).map((f, i) => { const s = c.createOscillator(); s.type = (o.types && o.types[i]) || 'sine'; s.frequency.value = f; return s; });
    const f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = o.lp || 400; f.Q.value = 0.7;
    const g = c.createGain(); g.gain.value = 0.0001;
    for (const s of oscs) { s.connect(f); s.start(); }
    f.connect(g);
    route(g, 0, o.verb);
    let alive = true;
    drones++;
    return {
      set(level, pitch) {
        if (!alive) return;
        const t = c.currentTime;
        g.gain.setTargetAtTime(Math.max(0.0001, level), t, 0.05);
        if (pitch) oscs.forEach((s, i) => s.frequency.setTargetAtTime((o.freqs[i] || 55) * pitch, t, 0.08));
      },
      stop() {
        if (!alive) return; alive = false;
        const t = c.currentTime;
        g.gain.setTargetAtTime(0.0001, t, 0.06);
        for (const s of oscs) s.stop(t + 0.4);
        drones--;
        playing(t + 0.4);
      },
    };
  };
})();
