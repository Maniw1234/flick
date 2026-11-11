/* Transfer history. The app keeps it (history(), newest first); this page adds the sends it runs itself that the PC
 * confirmed, and shows it: Open, Show in folder, Send again, Remove. */
(window.FlickFeatures = window.FlickFeatures || []).push(function (A, X) {
  'use strict';
  const h = X.h;
  const ARROW = {
    out: '<svg viewBox="0 0 24 24"><path d="M7 17L17 7M9.5 7H17v7.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    in: '<svg viewBox="0 0 24 24"><path d="M17 7L7 17M14.5 17H7V9.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    bad: '<svg viewBox="0 0 24 24"><path d="M12 6.5v7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><circle cx="12" cy="17.3" r="1.35" fill="currentColor"/></svg>',
  };
  const HOW = { auto: 'Auto-send', tile: 'Quick Settings', widget: 'Widget', share: 'Shared', sync: 'Folder sync', browse: 'Browse phone' };
  const WHY = { declined: 'Declined', timeout: 'Not accepted in time', canceled: 'Canceled' };    // a PC set to "Ask each time"; canceled there

  // ---- entries for what this page sends and receives
  const queue = [];
  let flushT = 0;
  // who: the other end when it isn't the PC ({ id, name, how }: another phone)
  function add(it, dir, who) {
    if (!it || !A.has('historyAdd')) return;
    const pc = who || A.st.pc || {};
    const e = { id: A.rid(), dir, name: String(it.name || 'File'), size: +it.size || 0, time: Date.now(), pc: pc.id || '', pcName: pc.name || X.pcName(),
      how: who ? who.how : dir === 'out' ? 'fling' : 'pc', ok: true };
    if (it.path) e.path = it.path; else if (it.id) e.libId = String(it.id);
    if (it.dir) e.kind = 'folder'; else if (it.kind) e.kind = String(it.kind);
    queue.push(e);
    if (!flushT) flushT = setTimeout(flush, 0);
  }
  // one entry as an object; the files of a stack as one array (one write on the app's side instead of one per file)
  function flush() {
    flushT = 0;
    const batch = queue.splice(0, 50);
    if (batch.length) A.nc('historyAdd', JSON.stringify(batch.length === 1 ? batch[0] : batch));
    if (queue.length) flushT = setTimeout(flush, 40);
  }
  A.on('sent', (items) => { for (const it of (items || []).slice(0, 300)) add(it, 'out'); });   // the app keeps 300
  A.on('native', (e) => {
    // (files received, from the PC or another phone: the app puts those in History itself, so one that arrived while
    // the page was being made again is there too)
    if (e.t === 'history' && page.isOpen()) render();
    else if (e.t === 'resume' && page.isOpen()) render();         // (the time zone or language may have changed meanwhile)
  });

  // ---- the History page
  const page = X.page({ id: 'fHistory', title: 'History', action: { text: 'Clear', label: 'Clear history', run: askClear } });
  X.menu(30, () => (A.has('history') ? { label: 'History', icon: 'history', tile: true, run: () => { render(); page.open(); } } : null));

  // The ways of writing a day and a time, made once: made again for each of the 300 rows (toLocaleDateString,
  // toLocaleTimeString), drawing History took a tenth of a second on a fast PC, and it's drawn again with every
  // change while it's open (a file every quarter second during a big receive)
  // (made again, and every row with them, when the time zone or language changes: see X.clockKey)
  let fmts = {}, fmtsKey = '';
  function fresh() {
    const k = X.clockKey();
    if (k !== fmtsKey) { fmtsKey = k; fmts = {}; made = new Map(); }
  }
  window.addEventListener('languagechange', () => { fmtsKey = ''; if (page.isOpen()) render(); });
  function fmt(name, o) {
    if (!(name in fmts)) { try { fmts[name] = new Intl.DateTimeFormat([], o); } catch (x) { fmts[name] = null; } }
    return fmts[name];
  }
  function dayOf(t) {
    const d = new Date(t), today = new Date();
    const day0 = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const ago = Math.round((day0(today) - day0(d)) / 864e5);
    if (ago === 0) return 'Today';
    if (ago === 1) return 'Yesterday';
    const year = d.getFullYear() !== today.getFullYear();
    const f = fmt(year ? 'dayYear' : 'day', year ? { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' } : { weekday: 'long', month: 'short', day: 'numeric' });
    return f ? f.format(d) : d.toDateString();
  }
  function timeOf(t) {
    const d = new Date(t), f = fmt('time', { hour: 'numeric', minute: '2-digit' });
    return f ? f.format(d) : d.getHours() + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  let gone = new Set();                     // Flick-list files an entry points at that are no longer in the list
  const here = (e) => !!e.path || (!!e.libId && !gone.has(e.libId));

  // Each entry's row, kept while the entry stays the same: drawn again with every change, the page made 300 rows anew
  // (and the keyboard or TalkBack on one dropped to the start of the page)
  let made = new Map();                     // entry id -> { sig, el }
  function render() {
    fresh();
    const list = (A.njson('history') || []).filter((e) => e && typeof e === 'object' && e.name);
    if (list.some((e) => e.libId && !e.path)) {
      const lib = new Set((A.njson('library') || []).map((x) => x.id));
      gone = new Set(list.filter((e) => e.libId && !lib.has(e.libId)).map((e) => e.libId));
    } else gone = new Set();
    const body = page.body;
    const refocus = X.keepFocus(body, '.frow', page.back);
    body.innerHTML = '';
    page.setAct(list.length > 0 && A.has('historyClear'));
    if (!list.length) {
      made = new Map();
      body.appendChild(X.empty(A.icons.history, 'No transfers yet', 'Files you send and get with Flick show up here.'));
      refocus();
      return;
    }
    const keep = new Map();
    let group = null, card = null;
    for (const e of list) {
      const day = dayOf(+e.time || 0);
      if (day !== group) {
        group = day;
        const g = h('section', 'sgroup');
        g.appendChild(h('h3', '', day));
        card = h('div', 'scard');
        card.setAttribute('role', 'list');
        g.appendChild(card);
        body.appendChild(g);
      }
      const sig = JSON.stringify([e.dir, e.name, e.size, e.time, e.ok, e.why, e.pcName, e.how, e.kind, e.path, e.libId, gone.has(e.libId)]);
      let m = made.get(String(e.id));
      if (!m || m.sig !== sig || keep.has(String(e.id))) m = { sig, el: row(e) };
      keep.set(String(e.id), m);
      card.appendChild(m.el);
    }
    made = keep;
    refocus();
  }

  function row(e) {
    const r = h('div', 'frow');
    r.setAttribute('role', 'listitem');
    r.dataset.rk = String(e.id);
    const main = h('button', 'fmain');
    const bad = e.ok === false;
    const ic = h('span', 'fic' + (bad ? ' bad' : ''));
    ic.appendChild(A.svgEl(bad ? ARROW.bad : e.dir === 'in' ? ARROW.in : ARROW.out));
    const tx = h('span', 'ftx');
    const top = h('span', 'ftop');
    top.append(X.nm('b', '', e.name), h('span', 'ftime', timeOf(+e.time || 0)));
    tx.appendChild(top);
    const sm = h('small', 'fwrap');
    if (bad) sm.appendChild(h('span', 'fbad', (WHY[e.why] || (e.dir === 'in' ? 'Didn’t arrive' : 'Didn’t send')) + ' · '));
    const bits = [e.kind === 'folder' ? 'Folder' : A.fmtSize(e.size), (e.dir === 'in' ? 'From ' : 'To ') + (X.clean(e.pcName) || 'your PC')];
    if (HOW[e.how]) bits.push(HOW[e.how]);
    if (e.libId && !e.path && gone.has(e.libId)) bits.push('No longer in Flick');
    bits.forEach((b, i) => { if (i) sm.appendChild(document.createTextNode(' · ')); sm.appendChild(h('span', 'fbit', b)); });   // lines break between parts
    tx.appendChild(sm);
    main.append(ic, tx);
    X.press(main, () => openEntry(e), () => menu(e));
    const more = h('button', 'fmore');
    more.setAttribute('aria-label', 'More for ' + e.name);
    more.appendChild(A.svgEl(X.SVG.dots));
    more.onclick = () => menu(e);
    r.append(main, more);
    return r;
  }

  function menu(e) {
    const ok = here(e);
    const items = [
      ok ? { label: 'Open', icon: 'open', run: () => openEntry(e) } : null,
      e.path ? { label: 'Show in folder', icon: 'folder', run: () => showFolder(e) } : null,
      ok ? { label: e.dir === 'in' ? X.sendLabel('Send to ') : e.how === 'phone' ? 'Send again to ' + (X.clean(e.pcName) || 'that phone') : 'Send again', icon: 'send', run: () => sendAgain(e) } : null,
      A.has('historyRemove') ? { label: 'Remove from history', icon: 'trash', danger: true, run: () => remove(e) } : null,
    ];
    if (!items.some(Boolean)) { A.toast('That file is no longer on this phone', 2200); return; }
    A.openSheet(e.name, items);
  }

  function openEntry(e) {
    if (e.kind === 'folder' && e.path) { toFiles(() => A.showInFolder(e.path)); return; }
    if (e.path) { const r = A.nc('openPath', e.path); if (r === false || r === null) A.toast('Couldn’t open ' + A.midName(e.name), 2200); return; }
    if (e.libId && !gone.has(e.libId)) { const r = A.nc('open', e.libId); if (r === false || r === null) A.toast('That file is no longer in Flick', 2200); return; }
    A.toast('That file is no longer on this phone', 2200);
  }
  // the file browser is behind this page: close it first so the folder (or the file flying off) is seen
  function toFiles(fn) {
    page.close();
    setTimeout(() => { if (A.st.screen !== 'main') A.showScreen('main'); fn(); }, 220);
  }
  function showFolder(e) {
    const parent = e.path.replace(/\/[^/]*$/, '') || e.path;
    toFiles(() => A.showInFolder(parent));
  }
  function sendAgain(e) {
    const it = e.path
      ? { id: 'p:' + e.path, path: e.path, name: e.name, size: e.size, kind: e.kind === 'folder' ? '' : e.kind || '', dir: e.kind === 'folder' }
      : { id: e.libId, name: e.name, size: e.size, kind: e.kind || '' };
    // sent to another phone: again to that phone
    if (e.dir === 'out' && e.how === 'phone' && X.phoneSend) { X.phoneSend(e.pc, e.pcName, [it]); return; }
    if (!X.sendPc()) { X.toConnect(); return; }      // (no PC paired, or not any more: Connect)
    if (!A.st.connected) { A.toast('Connect to your PC to send', 2400); return; }
    toFiles(() => A.sendItems([it]));
  }
  function remove(e) {
    A.nc('historyRemove', String(e.id));
    render();
    A.toast('Removed from history', 1600);
  }
  function askClear() {
    A.openSheet('Your files stay where they are', [
      { label: 'Clear history', icon: 'trash', danger: true, run: () => { A.nc('historyClear'); render(); A.toast('History cleared', 1600); } },
    ]);
  }
});
