'use strict';
// A video thrown from the phone by Air grab while it played: it carries on here from the second it had reached
// (pc/air.js opens this window; a video this window can't play opens in the PC's own player instead).
(function () {
  const q = new URLSearchParams(location.search);
  const v = document.getElementById('v');
  const t = Math.max(0, +q.get('t') || 0);
  document.title = q.get('name') || 'Flick';
  let told = false;
  const tell = (d) => { if (!told) { told = true; window.flick.send('air:player', d); } };
  v.addEventListener('loadedmetadata', () => {
    if (Math.abs(v.currentTime - t) > 0.4) v.currentTime = t;
    tell({ w: v.videoWidth, h: v.videoHeight });
    const p = v.play();
    if (p && p.catch) p.catch(() => {});
  });
  v.addEventListener('error', () => tell({ error: true }));
  document.addEventListener('keydown', (e) => {
    if (e.key === ' ') { e.preventDefault(); if (v.paused) v.play(); else v.pause(); }
    else if (e.key === 'Escape') window.close();
  });
  v.src = q.get('src') + '#t=' + t.toFixed(2);
})();
