/* What the feature files share (icons, the PC check, full pages, the ••• entries).
 * Every file in phone/features/ queues a start function; app.js calls them in order with (FlickApp, shared). */
(window.FlickFeatures = window.FlickFeatures || []).push(function (A, X) {
  'use strict';

  const h = X.h = function (tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };

  // icons in the style of app.js's ICONS (24 px grid, 1.8 strokes); sheets use them by name
  Object.assign(A.icons, {
    clipboard: '<svg viewBox="0 0 24 24"><rect x="5.5" y="4.5" width="13" height="16" rx="2.6" fill="none" stroke="currentColor" stroke-width="1.8"/><rect x="9" y="2.8" width="6" height="3.6" rx="1.3" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M9 11h6M9 14.6h4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
    remote: '<svg viewBox="0 0 24 24"><rect x="6.5" y="2.8" width="11" height="18.4" rx="3.2" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="9" r="2.6" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M10 15.2h4M10 18h4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
    history: '<svg viewBox="0 0 24 24"><path d="M4.6 12a7.4 7.4 0 1 0 2.2-5.3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M4.4 4.3v3.9h3.9" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M12 8v4.4l2.9 1.8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    sync: '<svg viewBox="0 0 24 24"><path d="M19.4 10.4A7.6 7.6 0 0 0 5.9 7.3L4.6 8.7M4.6 13.6A7.6 7.6 0 0 0 18.1 16.7l1.3-1.4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M4.6 4.7v4h4M19.4 19.3v-4h-4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  });
  X.SVG = {
    back: '<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    dots: '<svg viewBox="0 0 24 24"><circle cx="5.5" cy="12" r="1.7" fill="currentColor"/><circle cx="12" cy="12" r="1.7" fill="currentColor"/><circle cx="18.5" cy="12" r="1.7" fill="currentColor"/></svg>',
    close: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round"/></svg>',
    plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>',
    folder: '<svg viewBox="0 0 64 52"><defs><linearGradient id="ffg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8fb4ff"/><stop offset="1" stop-color="#4c7dff"/></linearGradient></defs><path d="M4 9a5 5 0 0 1 5-5h14l6 6h26a5 5 0 0 1 5 5v28a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5z" fill="#3a5fcc"/><path d="M4 18a5 5 0 0 1 5-5h46a5 5 0 0 1 5 5v25a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5z" fill="url(#ffg)"/></svg>',
  };

  // ---- the PC: features need a PC that speaks protocol 5
  X.OLD_PC = 'Update Flick on your PC to use this';
  X.pcName = () => (A.st.pc && A.st.pc.name) || A.pref.get('lastPcName', '') || 'your PC';
  X.newPc = () => (A.st.pcProto || 1) >= 5;
  /** True when a feature that talks to the PC can go ahead now; otherwise says why (offline: what to say then). */
  X.needPc = function (offline) {
    if (!A.st.connected) { A.toast(offline || 'Connect to your PC first', 2400); return false; }
    if (!X.newPc()) { A.toast(X.OLD_PC, 2800); return false; }
    return true;
  };

  // a hash for "has this changed" checks: SHA-256 like Java's (Bridge.sha256), or a quick one without it
  X.hash = function (s) {
    s = String(s || '');
    const r = A.nc('sha256', s);
    if (typeof r === 'string' && r) return r;
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677); }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return 'q' + (h2 >>> 0).toString(16) + (h1 >>> 0).toString(16) + ':' + s.length;
  };

  // ---- entries in the ••• sheet, in a fixed order whatever order the files load in
  const menu = [];
  X.menu = function (order, fn) { menu.push({ order, fn }); menu.sort((a, b) => a.order - b.order); };
  A.on('menu', () => menu.map((m) => m.fn()).filter(Boolean));

  // ---- Android's back button: one press does one thing, the topmost first (fn returns true when it handled it)
  const backs = [];
  X.back = function (topmost, fn) { backs.push({ topmost, fn }); backs.sort((a, b) => b.topmost - a.topmost); };
  A.on('back', () => backs.some((b) => b.fn()));

  // ---- what's behind a page or an overlay is out of reach (taps, Tab, screen readers) while it is open
  X.block = function (owner, els, on) {
    for (const el of els) {
      if (!el || el.nodeType !== 1) continue;
      const who = new Set((el.getAttribute('data-fblock') || '').split(' ').filter(Boolean));
      if (on) who.add(owner); else who.delete(owner);
      if (who.size) { el.setAttribute('data-fblock', Array.from(who).join(' ')); el.inert = true; }
      else { el.removeAttribute('data-fblock'); el.inert = false; }
    }
  };
  const screens = () => ['pair', 'main', 'settings'].map((id) => document.getElementById(id));

  /** A full page like Settings: { el, body, act, open(), close(), isOpen() }. o: { id, title, action: { text, label, run } } */
  X.page = function (o) {
    const el = h('section', 'fpage');
    el.id = o.id; el.hidden = true;
    el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true'); el.setAttribute('aria-labelledby', o.id + 'Title');
    const hdr = h('header', 'fhdr');
    const back = h('button', 'hback');
    back.setAttribute('aria-label', 'Back');
    back.appendChild(A.svgEl(X.SVG.back));
    const title = h('h1', 'ftitle', o.title);
    title.id = o.id + 'Title';
    hdr.append(back, title);
    let act = null;
    if (o.action) {
      act = h('button', 'fact', o.action.text);
      if (o.action.label) act.setAttribute('aria-label', o.action.label);
      act.onclick = () => { A.haptic('soft'); o.action.run(); };
      hdr.appendChild(act);
    }
    const body = h('div', 'fbody');
    el.append(hdr, body);
    document.body.appendChild(el);
    let hideT = 0, before = null;
    const page = {
      el, body, act,
      isOpen: () => !el.hidden && !el.classList.contains('closing'),
      open() {
        clearTimeout(hideT);
        const fresh = !page.isOpen();
        if (fresh) { before = document.activeElement; body.scrollTop = 0; A.haptic('soft'); }
        el.hidden = false; el.classList.remove('closing');
        X.block(o.id, screens(), true);
        if (fresh) setTimeout(() => { if (page.isOpen()) back.focus({ preventScroll: true }); }, 40);
      },
      close() {
        if (!page.isOpen()) return false;
        el.classList.add('closing');
        X.block(o.id, screens(), false);
        clearTimeout(hideT);
        hideT = setTimeout(() => { el.hidden = true; el.classList.remove('closing'); }, 200);
        if (before && before.isConnected && typeof before.focus === 'function') { try { before.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }
        before = null;
        return true;
      },
    };
    back.onclick = () => { A.haptic('soft'); page.close(); };
    X.back(50, () => page.close());
    return page;
  };

  /** Press and hold (or right-click) runs onLong; a plain tap runs onTap. Scrolling cancels both. */
  X.press = function (el, onTap, onLong) {
    let t = 0, long = false, x0 = 0, y0 = 0;
    const cancel = () => clearTimeout(t);
    el.addEventListener('pointerdown', (e) => {
      long = false; x0 = e.clientX; y0 = e.clientY;
      clearTimeout(t);
      t = setTimeout(() => { long = true; A.haptic('lift'); onLong(); }, 480);
    });
    el.addEventListener('pointermove', (e) => { if (Math.hypot(e.clientX - x0, e.clientY - y0) > 10) cancel(); });
    el.addEventListener('pointerup', cancel);
    el.addEventListener('pointercancel', cancel);
    el.addEventListener('pointerleave', cancel);
    el.addEventListener('contextmenu', (e) => { e.preventDefault(); if (!long) { cancel(); long = true; onLong(); } });
    el.addEventListener('click', (e) => {
      if (long) { long = false; e.preventDefault(); return; }    // the hold already opened the menu
      onTap(e);
    });
  };

  /** An empty page: icon, title, a line of help and, optionally, a button. */
  X.empty = function (icon, title, text, button) {
    const box = h('div', 'fempty');
    const ic = h('div', 'eicon');
    ic.appendChild(A.svgEl(icon));
    box.append(ic, h('b', '', title), h('p', '', text));
    if (button) box.appendChild(button);
    return box;
  };
});
