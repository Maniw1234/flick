/* Settings › Privacy › Lock Flick. The app does the locking (lockState, setLock, lockSetup; AppLock.java): it asks for
 * the phone's fingerprint, face or PIN when Flick opens and when it comes back after more than 30 seconds away, and
 * covers the page meanwhile. Transfers and the background features keep going; the Quick Settings tiles and the
 * widget still work while Flick is locked (they send the last photo or the clipboard and show no files). Without a
 * screen lock on the phone there is nothing to unlock with, so Settings says so instead of offering the switch. */
(window.FlickFeatures = window.FlickFeatures || []).push(function (A, X) {
  'use strict';
  if (!A.has('lockState') || !A.has('setLock')) return;
  const h = X.h;
  let asking = false;                               // turning it on: the app asks for the phone's lock first

  function redraw() {
    const s = document.getElementById('settings');
    if (s && !s.hidden && !s.classList.contains('closing')) A.renderSettings();
  }
  A.on('native', (e) => {
    if (e.t !== 'lock-state') return;
    const was = asking;
    asking = false;
    if (e.on && was) A.toast('Flick will ask for your fingerprint, face or PIN', 2400);
    else if (e.why === 'nosecure') A.toast('Set a screen lock on this phone first', 2400);
    redraw();
  });

  A.on('settings', (body) => {
    const s = A.njson('lockState') || {};
    const g = h('section', 'sgroup');
    g.appendChild(h('h3', '', 'Privacy'));
    const card = h('div', 'scard');
    const row = h('div', 'srow');
    const lab = h('div', 'sl');
    lab.appendChild(h('b', '', 'Lock Flick'));
    row.appendChild(lab);
    if (s.secure === false && !s.on) {
      lab.appendChild(h('small', '', 'This phone has no screen lock, so there is nothing to unlock Flick with. Set a PIN, pattern or password in Android settings first.'));
      const b = h('button', 'sbtn', 'Set up');
      b.setAttribute('aria-label', 'Set up a screen lock');
      b.onclick = (e) => { e.stopPropagation(); A.haptic('tick'); A.nc('lockSetup'); };
      row.appendChild(b);
    } else {
      const on = !!s.on || asking;
      lab.appendChild(h('small', '', on
        ? 'Asks for your fingerprint, face or PIN when Flick opens. The tiles and the widget still work.'
        : 'Ask for your fingerprint, face or PIN when Flick opens'));
      const l = h('label', 'stog');
      const i = h('input');
      i.type = 'checkbox'; i.checked = on;
      i.setAttribute('aria-label', 'Lock Flick');
      i.onchange = () => {
        A.haptic('tick');
        if (i.checked) { asking = true; A.nc('setLock', true); }
        else { asking = false; A.nc('setLock', false); }
      };
      l.append(i, h('span'));
      row.appendChild(l);
    }
    card.appendChild(row);
    g.appendChild(card);
    body.appendChild(g);
  });
});
