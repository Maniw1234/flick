/* Clipboard history: the last 20 clipboards (text, links, pictures) that went between this phone and the PC through
 * Flick. The app keeps them, on this phone only (ClipHistory.java), never one an app marked as private, and not at all
 * when Settings › Clipboard history is off. ••• › Clipboard history: tap to copy, Send to PC, Clear. */
(window.FlickFeatures = window.FlickFeatures || []).push(function (A, X) {
  'use strict';
  const h = X.h;
  const WS_MAX = 4 * 1024 * 1024 - 32 * 1024;     // a bigger clipboard goes through the app (see clipboard.js)
  A.icons.cliphist = '<svg viewBox="0 0 24 24"><rect x="5.5" y="4.5" width="13" height="16" rx="2.6" fill="none" stroke="currentColor" stroke-width="1.8"/><rect x="9" y="2.8" width="6" height="3.6" rx="1.3" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="13.6" r="3.7" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M12 11.7v2.1l1.3.9" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const KIND = {
    text: '<svg viewBox="0 0 24 24"><path d="M5 7h14M5 12h14M5 17h9" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg>',
    link: '<svg viewBox="0 0 24 24"><path d="M10.2 13.8a4 4 0 0 0 5.7 0l2.8-2.8a4 4 0 0 0-5.7-5.7l-1.1 1.1M13.8 10.2a4 4 0 0 0-5.7 0l-2.8 2.8a4 4 0 0 0 5.7 5.7l1.1-1.1" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg>',
    image: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="3" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M3.5 16l5-4.5 4 3.5 3-2.5 5 4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>',
  };
  let box = null, openedAt = 0;

  const on = () => { const f = A.njson('features'); return !f || f.clipHistory !== false; };
  const list = () => (A.njson('clipHistory') || []).filter((e) => e && typeof e === 'object' && e.id);
  const isOpen = () => !!(box && box.isConnected && A.sheetOpen);
  const early = () => performance.now() - openedAt < 350;     // the tap that opened the sheet

  X.menu(12, () => (A.has('clipHistory') && on() ? { label: 'Clipboard history', icon: 'cliphist', run: open } : null));

  function open() {
    A.openSheet('Clipboard history', []);
    openedAt = performance.now();
    box = h('div', 'fclips');
    document.getElementById('sheetItems').appendChild(box);
    render();
  }

  function render() {
    if (!box || !box.isConnected) { box = null; return; }
    const items = list();
    box.innerHTML = '';
    if (!items.length) {
      const e = h('div', 'fcempty');
      const ic = h('div', 'eicon');
      ic.appendChild(A.svgEl(A.icons.cliphist));
      e.append(ic, h('b', '', 'Nothing here yet'), h('p', '', 'Text, links and pictures you copy between this phone and ' + X.pcName() + ' show up here.'));
      box.appendChild(e);
      return;
    }
    box.appendChild(h('div', 'fknote', 'Kept on this phone only. Tap one to copy it.'));
    const ul = h('div', 'fcl');
    ul.setAttribute('role', 'list');
    for (const e of items) ul.appendChild(row(e));
    box.appendChild(ul);
    const clear = h('button', 'sitem danger');
    clear.appendChild(A.svgEl(A.icons.trash));
    clear.appendChild(h('span', '', 'Clear clipboard history'));
    clear.onclick = () => { if (!early()) askClear(); };
    box.appendChild(clear);
  }

  function title(e) {
    if (e.kind === 'image') return 'Picture' + (+e.w > 0 && +e.h > 0 ? ' · ' + e.w + ' × ' + e.h : '');
    return String(e.preview || '');
  }

  function row(e) {
    const r = h('div', 'fcrow');
    r.setAttribute('role', 'listitem');
    const main = h('button', 'fcmain');
    main.setAttribute('aria-label', 'Copy: ' + title(e));
    const ic = h('span', 'fcic' + (e.thumb ? ' pic' : ''));
    if (e.thumb && /^data:image\/jpeg;base64,/.test(e.thumb)) { const im = h('img'); im.src = e.thumb; im.alt = ''; ic.appendChild(im); }
    else ic.appendChild(A.svgEl(KIND[e.kind] || KIND.text));
    const tx = h('span', 'fctx');
    tx.appendChild(h('b', e.kind === 'image' ? '' : 'two', title(e)));
    const who = (e.dir === 'in' ? 'From ' : 'To ') + (e.pcName || X.pcName());
    tx.appendChild(h('small', '', (e.kind === 'link' ? 'Link · ' : '') + who + ' · ' + A.fmtWhen(+e.time || Date.now())));
    main.append(ic, tx);
    X.press(main, () => { if (!early()) copy(e); }, () => more(e));
    const send = h('button', 'fcsend');
    send.setAttribute('aria-label', 'Send to ' + X.pcName());
    send.appendChild(A.svgEl(A.icons.send));
    send.onclick = () => { if (!early()) sendTo(e); };
    r.append(main, send);
    return r;
  }

  function copy(e) {
    if (A.nc('clipHistoryCopy', String(e.id)) !== true) { A.toast('Couldn’t copy that', 2000); render(); return; }
    A.haptic('tick');
    A.closeSheet();
    A.toast(e.kind === 'image' ? 'Picture copied' : 'Copied', 1600);
  }

  // over this page's link when it's up (the PC confirms nothing, like any clipboard sent from here); otherwise the
  // app reaches the PC itself and says how it went
  function sendTo(e) {
    if (A.st.connected && A.linkAuthed() && X.newPc()) {
      const c = A.njson('clipHistoryGet', String(e.id));
      if (!c) { A.toast('That’s no longer in the clipboard history', 2200); render(); return; }
      const msg = c.kind === 'image' ? { t: 'clip', kind: 'image', png: String(c.png || '') } : { t: 'clip', kind: 'text', text: String(c.text || '') };
      const json = JSON.stringify(msg);
      if (json.length <= WS_MAX && A.wsSend(msg)) {
        A.nc('clipHistoryAdd', 'out', json);
        A.haptic('tick');
        A.toast((c.kind === 'image' ? 'Image copied to ' : 'Copied to ') + X.pcName(), 1800);
        return;
      }
    }
    if (A.nc('clipHistorySend', String(e.id)) === null) A.toast('Connect to your PC to send', 2400);
  }

  function more(e) {
    A.openSheet(title(e).slice(0, 80), [
      { label: 'Copy', icon: 'keep', run: () => copy(e) },
      { label: 'Send to ' + X.pcName(), icon: 'send', run: () => sendTo(e) },
      A.has('clipHistoryRemove') ? { label: 'Remove from history', icon: 'trash', danger: true, run: () => { A.nc('clipHistoryRemove', String(e.id)); A.toast('Removed from clipboard history', 1600); } } : null,
    ]);
  }

  function askClear() {
    A.openSheet('Clear clipboard history?', [
      { label: 'Clear', icon: 'trash', danger: true, run: () => { A.nc('clipHistoryClear'); A.toast('Clipboard history cleared', 1600); } },
    ]);
  }

  A.on('native', (e) => { if (e.t === 'cliphist' && isOpen()) render(); });
});
