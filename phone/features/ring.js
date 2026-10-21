/* Flick 2.0: "find my phone". The PC asks this phone to ring; the app rings at alarm volume (ring(true, sec)) and this
 * page covers every screen with a big Stop until the phone is found (ring(false, 0) + 'ring-found' to the PC). */
(window.FlickFeatures = window.FlickFeatures || []).push(function (A, X) {
  'use strict';
  const h = X.h;
  const PHONE = '<svg viewBox="0 0 48 48"><rect x="14.5" y="5.5" width="19" height="37" rx="5" fill="none" stroke="currentColor" stroke-width="3.2"/><path d="M21 36.5h6" stroke="currentColor" stroke-width="3.2" stroke-linecap="round"/><path d="M7.5 17.5a14 14 0 0 0 0 13M40.5 17.5a14 14 0 0 1 0 13" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round"/></svg>';
  let on = false, shownAt = 0, endT = 0, hideT = 0, before = null;

  const el = h('div', 'fring');
  el.id = 'fRing'; el.hidden = true;
  el.setAttribute('role', 'alertdialog'); el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-labelledby', 'fRingT'); el.setAttribute('aria-describedby', 'fRingS');
  const pulse = h('div', 'frpulse');
  const icon = h('div', 'frphone');
  icon.appendChild(A.svgEl(PHONE));
  pulse.append(h('i'), h('i'), h('i'), icon);
  const title = h('div', 'frt', 'Your PC is looking for this phone');
  title.id = 'fRingT';
  const sub = h('div', 'frs', 'Found it? Tap anywhere to stop.');
  sub.id = 'fRingS';
  const mid = h('div', 'frbody');
  mid.append(pulse, title, sub);
  const stopBtn = h('button', 'frstop', 'Stop');
  stopBtn.setAttribute('aria-label', 'Stop ringing');
  el.append(h('div', 'frglow'), mid, stopBtn);
  document.body.appendChild(el);

  // anywhere counts (the phone may be face down under a cushion); not the touch that was already going on
  el.addEventListener('click', () => { if (performance.now() - shownAt > 600) stop(); });
  el.addEventListener('keydown', (e) => { if (e.key === 'Tab') { e.preventDefault(); stopBtn.focus(); } });
  const others = () => Array.from(document.body.children).filter((c) => c !== el && c.id !== 'toast' && c.tagName !== 'SCRIPT');

  function show(sec) {
    clearTimeout(endT);
    endT = setTimeout(hide, (sec + 2) * 1000);          // the app stops by itself after sec; so does this
    if (on) return;
    on = true; shownAt = performance.now();
    clearTimeout(hideT);
    before = document.activeElement;
    el.hidden = false; el.classList.remove('closing');
    X.block('ring', others(), true);
    setTimeout(() => { if (on) stopBtn.focus({ preventScroll: true }); }, 60);
  }
  function hide() {
    clearTimeout(endT);
    if (!on) return;
    on = false;
    el.classList.add('closing');
    X.block('ring', others(), false);
    hideT = setTimeout(() => { if (!on) { el.hidden = true; el.classList.remove('closing'); } }, 240);
    if (before && before.isConnected && typeof before.focus === 'function') { try { before.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }
    before = null;
  }
  function stop() {
    if (!on) return;
    A.nc('ring', false, 0);
    if (A.linkAuthed()) A.wsSend({ t: 'ring-found' });
    A.haptic('confirm');
    hide();
  }
  stopBtn.addEventListener('click', (e) => { e.stopPropagation(); stop(); });

  A.on('ws', (m) => {
    if (!A.linkAuthed()) return;
    if (m.t === 'ring') {
      const sec = Math.max(1, Math.min(60, Math.round(+m.sec || 30)));
      A.nc('ring', true, sec);
      show(sec);
    } else if (m.t === 'ring-stop') {
      A.nc('ring', false, 0);
      hide();
    }
  });
  // the app rings (asked over the background link, say) or stopped (its time ran out, or Stop in the notification)
  A.on('native', (e) => {
    if (e.t !== 'ring') return;
    if (!e.on) hide();
    else if (!on) show(60);                             // already showing: the PC's own time limit stands
  });
  X.back(100, () => { if (!on) return false; stop(); return true; });
});
