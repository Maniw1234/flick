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
  // the same for a name (a file's, a folder's, what was copied): it takes the direction of its own text, so a Hebrew or
  // Arabic name reads right to left, its digits and extension in place, and a long one is cut at its end
  X.nm = function (tag, cls, text) { const e = h(tag, cls, text); e.dir = 'auto'; return e; };

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
  // The time zone and language times are written in. A kept formatter (History's, Transfers') keeps the ones it was made
  // in, and the page lives on when they change (Android's settings, travel): kept formatters are made again when this
  // says something else. It's the zone a date's own words name (its offset and name: no formatter made to look, which
  // would cost as much as the one kept), so once per drawing, not per row
  X.clockKey = function () {
    // (with January's and July's offsets: two zones can share today's, Denver and Phoenix in winter, and not the other's)
    const n = new Date(), d = String(n), y = n.getFullYear();
    return d.slice(d.indexOf('GMT')) + '|' + new Date(y, 0, 1).getTimezoneOffset() + '|' + new Date(y, 6, 1).getTimezoneOffset() + '|' + navigator.language;
  };
  X.pcName = () => (A.st.pc && A.st.pc.name) || X.clean(A.pref.get('lastPcName', '')) || 'your PC';
  X.newPc = () => (A.st.pcProto || 1) >= 5;
  // Where files go: the PC in use when this phone is paired with it, '' when it isn't (or not any more: its user removed
  // this phone there, or it lost its settings). Then a send says "Send to a PC" and opens the Connect screen, where
  // holding Connect pairs again, as a file's menu does (app.js); it named that PC and only said "Not connected".
  X.sendPc = () => (A.st.pc && A.st.pc.id && A.paired && A.paired(A.st.pc.id) ? X.pcName() : '');
  X.sendLabel = (what) => what + (X.sendPc() || 'a PC');
  const pages = [];                                 // (X.page's, closed for the Connect screen)
  X.toConnect = function () {
    for (const p of pages) if (p.isOpen()) p.close();
    if (X.preview && X.preview.open()) X.preview.close(true);
    A.closeSheet();
    A.closeSettings();
    A.showScreen('pair');
  };
  /** True when a feature that talks to the PC can go ahead now; otherwise says why (offline: what to say then). */
  X.needPc = function (offline) {
    if (!A.st.connected) { A.toast(offline || 'Connect to your PC first', 2400); return false; }
    if (!X.newPc()) { A.toast(X.OLD_PC, 2800); return false; }
    return true;
  };

  // ---- other devices: a name from the network is shown as text, without direction controls. One of only invisible marks
  // (U+3164, joiners, a zero-width space) is none, so the default shows ("Phone"), not a blank (as app.js cleanName)
  const SEEN_NAME = /[^\s\p{Z}\p{Cc}\p{Cf}\p{M}\u115f\u1160\u2800\u3164\uffa0]/u;
  X.clean = (s) => { const t = String(s == null ? '' : s).replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '').trim(); return SEEN_NAME.test(t) ? t : ''; };
  /**
   * A clipboard ('clip': { kind, text | png }), a link ('link': the address) or Find my phone ('ring': 'on' | 'off') to a
   * paired phone: a promise of { ok, why } (the app's 'peer-msg'); { ok: false, why: 'app' } on an app without it.
   */
  const waitingMsg = new Map();
  X.peerMsg = function (id, what, payload) {
    return new Promise((resolve) => {
      if (!A.has('peerMsg')) { resolve({ ok: false, why: 'app' }); return; }
      const req = 'm' + A.rid();
      const t = setTimeout(() => { waitingMsg.delete(req); resolve({ ok: false, why: 'no answer' }); }, 30000);
      waitingMsg.set(req, (e) => { clearTimeout(t); resolve({ ok: e.ok === true, why: String(e.why || '') }); });
      if (A.nc('peerMsg', id, what, typeof payload === 'string' ? payload : JSON.stringify(payload), req) === null) { clearTimeout(t); waitingMsg.delete(req); resolve({ ok: false, why: 'app' }); }
    });
  };
  A.on('native', (e) => { if (e.t === 'peer-msg') { const f = waitingMsg.get(e.req); if (f) { waitingMsg.delete(e.req); f(e); } } });
  /** What to say when something didn't reach another phone (why: X.peerMsg's). */
  X.peerWhy = function (why, name) {
    const nm = X.clean(name) || 'that phone';
    if (why === 'old' || why === 'app') return 'Update Flick on ' + (why === 'app' ? 'this phone' : nm) + ' first';
    if (why === 'unpaired') return nm + ' isn’t paired with this phone any more';
    if (why === 'auth') return nm + ' doesn’t know this phone any more. Remove it and pair again.';
    if (why === 'busy') return 'That was a lot at once. Try again in a minute.';
    if (why === 'quiet') return nm + ' was found a moment ago';
    if (why === 'too big') return 'That’s too big to send';
    if (why === 'off') return nm + ' doesn’t take that: it’s turned off there';
    if (why === 'bad' || why === 'empty' || why === 'refused') return nm + ' couldn’t take that';
    return 'Couldn’t reach ' + nm + '. Open Flick on it, on the same Wi-Fi.';
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

  // ---- Android's back button: one press does one thing, the topmost first (fn returns true when it handled it).
  // Those above the menus (90 and up: the ringing screen, the walkthrough) come before a menu or prompt under them:
  // Back closed a menu hidden under the ringing screen, and the phone rang on.
  const backs = [];
  X.back = function (topmost, fn) { backs.push({ topmost, fn }); backs.sort((a, b) => b.topmost - a.topmost); };
  A.on('backTop', () => backs.some((b) => b.topmost >= 90 && b.fn()));
  A.on('back', () => backs.some((b) => b.topmost < 90 && b.fn()));

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

  // A tap on what a closing page uncovers, in its first moments, goes nowhere (under the page as it slides away, above
  // the rest): the second tap of a double tap on a button that closes its page (Add a folder, Done, Connect a device)
  // landed on what came under the finger, a folder's menu in the files or a switch in Settings
  let shield = null, shieldT = 0;
  function shieldBehind() {
    if (!shield) { shield = h('div', 'fshield'); shield.setAttribute('aria-hidden', 'true'); }
    document.body.appendChild(shield);
    clearTimeout(shieldT);
    shieldT = setTimeout(() => shield.remove(), 350);
  }

  /** A full page like Settings: { el, body, act, back, open(), close(), isOpen() }. o: { id, title, action: { text, label, run } } */
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
      el, body, act, back,
      isOpen: () => !el.hidden && !el.classList.contains('closing'),
      // its action (Clear, Sync now) on or off; turned off under the keyboard's focus (History cleared from it), the focus
      // goes to Back: on a disabled button it dropped to the start of the document
      setAct(on) {
        if (!act) return;
        const had = document.activeElement === act;
        act.disabled = !on;
        if (!on && had && page.isOpen()) back.focus({ preventScroll: true });
      },
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
        shieldBehind();
        X.block(o.id, screens(), false);
        clearTimeout(hideT);
        hideT = setTimeout(() => { el.hidden = true; el.classList.remove('closing'); }, 200);
        if (before && before.isConnected && typeof before.focus === 'function') { try { before.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }
        before = null;
        if (A.uncovered) A.uncovered();                // (what waited behind the page shows now: app.js homeWait)
        return true;
      },
    };
    back.onclick = () => { A.haptic('soft'); page.close(); };
    X.back(50, () => page.close());
    pages.push(page);
    return page;
  };

  /**
   * A list about to be drawn anew (box: its page's body; rowSel: its rows): returns what puts the keyboard's (and a
   * screen reader's) focus back after it, when it was on one of the rows. On the same control of the same row (key: a
   * row's data-rk) if it's still there; the row that went (removed from its own ⋯ menu), the same control of the row now
   * in its place, or of the last row; no rows left, back (the page's Back). The focus dropped to the start of the
   * document, and TalkBack lost its place in the list.
   */
  const CTLS = 'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';
  X.keepFocus = function (box, rowSel, back) {
    const a = document.activeElement, row = a && box.contains(a) ? a.closest(rowSel) : null;
    if (!row) return () => {};
    const i = Array.from(box.querySelectorAll(rowSel)).indexOf(row), key = row.dataset.rk || '';
    const c = Array.from(row.querySelectorAll(CTLS)).indexOf(a);
    return () => {
      if (a.isConnected && box.contains(a)) { if (document.activeElement !== a) a.focus({ preventScroll: true }); return; }
      const now = document.activeElement;
      if (now && now !== document.body && box.contains(now)) return;        // (put somewhere in the list already)
      const rows = Array.from(box.querySelectorAll(rowSel));
      const r = (key && rows.find((x) => x.dataset.rk === key)) || rows[Math.min(i, rows.length - 1)];
      const cs = r ? Array.from(r.querySelectorAll(CTLS)) : [];
      const to = cs[Math.min(Math.max(c, 0), cs.length - 1)] || back;
      if (to && to.isConnected) { try { to.focus({ preventScroll: true }); } catch (x) { /* ignore */ } }
    };
  };

  /** Press and hold (or right-click) runs onLong; a plain tap runs onTap. Scrolling cancels both. */
  X.press = function (el, onTap, onLong) {
    let t = 0, long = false, x0 = 0, y0 = 0;
    const cancel = () => clearTimeout(t);
    el.addEventListener('pointerdown', (e) => {
      long = false; x0 = e.clientX; y0 = e.clientY;
      clearTimeout(t);
      // (an element taken off the page under the finger hears no pointerup or pointercancel: it holds nothing)
      t = setTimeout(() => { if (!el.isConnected) return; long = true; A.haptic('lift'); onLong(); }, 480);
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

  // ---- Settings drawn again for what changed (the app reported a switch, a hint shows or goes): the keyboard and a
  // screen reader stay on the control they were on. Settings is made anew each time, and the focus dropped to the start
  // of the page: TalkBack lost its place with every switch turned. An app whose renderSettings keeps the focus itself
  // (r9's app.js) is left to it; otherwise a control is known again by its row's name, which of the rows of that name it
  // is (two transfers of IMG_2041.jpg: the keyboard on the second's Cancel went to the first's, and Enter canceled the
  // other one), and its own name (its label, or a button's words)
  const ROWS = '.srow, .frow', ROWNAME = '.sl b, .ftx b';
  const rowName = (row) => { const b = row.querySelector(ROWNAME); return b ? b.textContent : ''; };
  function controlKey(el, body) {
    const row = el.closest(ROWS);
    if (!row || !body.contains(row)) return null;
    const name = rowName(row);
    const nth = Array.from(body.querySelectorAll(ROWS)).filter((r) => rowName(r) === name).indexOf(row);
    return { row: name, nth, tag: el.tagName, isRow: el === row, aria: el.getAttribute('aria-label') || '', text: el.tagName === 'BUTTON' ? el.textContent : '' };
  }
  function findControl(k, body) {
    const same = Array.from(body.querySelectorAll(ROWS)).filter((r) => rowName(r) === k.row);
    const row = same[Math.min(k.nth, same.length - 1)];
    if (!row) return null;
    if (k.isRow) return row.tagName === k.tag ? row : null;
    const all = Array.from(row.querySelectorAll(k.tag.toLowerCase()));
    return all.find((c) => (c.getAttribute('aria-label') || '') === k.aria && (k.tag !== 'BUTTON' || c.textContent === k.text)) ||
      all.find((c) => (c.getAttribute('aria-label') || '') === k.aria) || all[0] || null;
  }
  /** Draws Settings again when it is open, keeping the focus where it was. */
  X.redrawSettings = function () {
    const s = document.getElementById('settings'), body = document.getElementById('setBody');
    if (!s || !body || s.hidden || s.classList.contains('closing')) return;
    const a = document.activeElement, k = a && body.contains(a) ? controlKey(a, body) : null;
    A.renderSettings();
    if (!k || body.contains(document.activeElement)) return;          // (put back by the app, or nothing to put back)
    const e = findControl(k, body);
    if (e) { try { e.focus({ preventScroll: true }); } catch (x) { /* ignore */ } }
  };

  /** Settings › Help, the last group before the Advanced settings row (made by the first feature that adds to it): its card, for a row. */
  X.helpCard = function (body) {
    let g = body.querySelector('section.sgroup[data-help]');
    if (!g) {
      g = h('section', 'sgroup');
      g.dataset.help = '1';
      g.append(h('h3', '', 'Help'), h('div', 'scard'));
      body.appendChild(g);
    }
    return g.querySelector('.scard');
  };
});
