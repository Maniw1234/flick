/* The phone as a media remote for the PC (play/pause, tracks, volume). Each press sends {t:'media', key}. */
(window.FlickFeatures = window.FlickFeatures || []).push(function (A, X) {
  'use strict';
  const h = X.h;
  const SPK = '<path d="M3.8 9.6h3.1l4.2-3.7a.6.6 0 0 1 1 .45v11.3a.6.6 0 0 1-1 .45l-4.2-3.7H3.8a.8.8 0 0 1-.8-.8v-3.2a.8.8 0 0 1 .8-.8z" fill="currentColor"/>';
  const ln = (d) => '<path d="' + d + '" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>';
  const KEYS = [
    { key: 'prev', text: 'Previous', label: 'Previous track', svg: ln('M6.5 6v12') + '<path d="M18 6.6v10.8a.8.8 0 0 1-1.2.7l-7.5-5.4a.8.8 0 0 1 0-1.4l7.5-5.4a.8.8 0 0 1 1.2.7z" fill="currentColor"/>' },
    { key: 'play', text: 'Play/Pause', label: 'Play or pause', main: true, svg: '<path d="M3.5 6.6v10.8a.8.8 0 0 0 1.2.7l7.5-5.4a.8.8 0 0 0 0-1.4L4.7 5.9a.8.8 0 0 0-1.2.7z" fill="currentColor"/>' + ln('M15.6 6.6v10.8M20.2 6.6v10.8') },
    { key: 'next', text: 'Next', label: 'Next track', svg: ln('M17.5 6v12') + '<path d="M6 6.6v10.8a.8.8 0 0 0 1.2.7l7.5-5.4a.8.8 0 0 0 0-1.4L7.2 5.9A.8.8 0 0 0 6 6.6z" fill="currentColor"/>' },
    { key: 'vol-down', text: 'Volume −', label: 'Volume down', repeat: true, svg: SPK + ln('M15.5 12h5.5') },
    { key: 'mute', text: 'Mute', label: 'Mute', svg: SPK + ln('M15.8 9.4l5 5.2M20.8 9.4l-5 5.2') },
    { key: 'vol-up', text: 'Volume +', label: 'Volume up', repeat: true, svg: SPK + ln('M15.5 12h5.5M18.25 9.25v5.5') },
  ];
  let box = null, note = null, openedAt = 0;

  const state = () => (!A.st.connected ? 'off' : !X.newPc() ? 'old' : 'ok');
  function send(k) {
    if (state() !== 'ok') { refresh(); return; }
    A.haptic('tick');
    A.wsSend({ t: 'media', key: k.key });
  }

  function keyButton(k) {
    const b = h('button', 'fkey' + (k.main ? ' main' : ''));
    b.setAttribute('aria-label', k.label);
    b.appendChild(A.svgEl('<svg viewBox="0 0 24 24" aria-hidden="true">' + k.svg + '</svg>'));
    b.appendChild(h('span', '', k.text));
    let rep = 0, held = false, pid = null;
    function stop() {
      clearTimeout(rep); clearInterval(rep); rep = 0; b.classList.remove('down');
      pid = null;
      document.removeEventListener('pointerup', upAnywhere, true);
      document.removeEventListener('pointercancel', upAnywhere, true);
    }
    function upAnywhere(e) { if (e.pointerId === pid) stop(); }
    if (k.repeat) {
      // volume keeps changing while held, like the buttons on a remote. Until that finger is up, wherever it is, or the
      // key is gone: another sheet put in this one's place under the finger took the key off the page, its pointerup
      // never came, and the PC's volume went on changing every 160 ms for good
      b.addEventListener('pointerdown', (e) => {
        if (state() !== 'ok' || performance.now() - openedAt < 300) return;
        stop();
        held = true; b.classList.add('down');
        pid = e.pointerId;
        send(k);
        rep = setTimeout(() => { rep = setInterval(() => { if (b.isConnected) send(k); else stop(); }, 160); }, 450);
        document.addEventListener('pointerup', upAnywhere, true);
        document.addEventListener('pointercancel', upAnywhere, true);
        try { b.setPointerCapture(e.pointerId); } catch (x) { /* ignore */ }
      });
      b.addEventListener('pointerup', stop);
      b.addEventListener('pointercancel', stop);
      b.addEventListener('lostpointercapture', stop);
    }
    b.addEventListener('click', () => {
      if (held) { held = false; return; }                // already sent on the press
      if (performance.now() - openedAt < 300) return;    // the tap that opened the sheet
      send(k);
    });
    return b;
  }

  function refresh() {
    if (!box || !box.isConnected) { box = null; return; }
    const s = state();
    note.textContent = s === 'off' ? 'Connect to your PC to use the remote' : s === 'old' ? X.OLD_PC : 'Controls what’s playing on ' + X.pcName();
    note.classList.toggle('warn', s !== 'ok');
    // (off, not disabled: a key with the keyboard's or a switch's focus keeps it when the link drops, where a disabled one
    // let it fall to the start of the page; a press then does nothing, see send)
    for (const b of box.querySelectorAll('.fkey')) { if (s === 'ok') b.removeAttribute('aria-disabled'); else b.setAttribute('aria-disabled', 'true'); }
  }

  function open() {
    A.openSheet('Media remote', []);
    openedAt = performance.now();
    box = h('div', 'fremote');
    note = h('div', 'fknote');
    note.setAttribute('role', 'status');
    const grid = h('div', 'fkeys');
    for (const k of KEYS) grid.appendChild(keyButton(k));
    box.append(note, grid);
    document.getElementById('sheetItems').appendChild(box);
    refresh();
  }

  X.menu(20, () => ({ label: 'Media remote', icon: 'remote', run: open }));
  A.on('conn', refresh);
});
