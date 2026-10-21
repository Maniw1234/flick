/* Flick 2.0: transfer history. The app keeps it (history(), newest first); this page adds the transfers it runs itself
 * (sends the PC confirmed, files received from the PC) and shows it: Open, Show in folder, Send again, Remove. */
(window.FlickFeatures = window.FlickFeatures || []).push(function (A, X) {
  'use strict';
  const h = X.h;
  const ARROW = {
    out: '<svg viewBox="0 0 24 24"><path d="M7 17L17 7M9.5 7H17v7.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    in: '<svg viewBox="0 0 24 24"><path d="M17 7L7 17M14.5 17H7V9.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    bad: '<svg viewBox="0 0 24 24"><path d="M12 6.5v7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><circle cx="12" cy="17.3" r="1.35" fill="currentColor"/></svg>',
  };
  const HOW = { auto: 'Auto-send', tile: 'Quick Settings', widget: 'Widget', share: 'Shared', sync: 'Folder sync' };

  // ---- entries for what this page sends and receives
  const queue = [];
  let flushT = 0;
  function add(it, dir) {
    if (!it || !A.has('historyAdd')) return;
    const pc = A.st.pc || {};
    const e = { id: A.rid(), dir, name: String(it.name || 'File'), size: +it.size || 0, time: Date.now(), pc: pc.id || '', pcName: pc.name || X.pcName(), how: dir === 'out' ? 'fling' : 'pc', ok: true };
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
    if (e.t === 'down-done' && e.ok && e.item) add(e.item, 'in');
    else if (e.t === 'history' && page.isOpen()) render();
  });

  // ---- the History page
  const page = X.page({ id: 'fHistory', title: 'History', action: { text: 'Clear', label: 'Clear history', run: askClear } });
  X.menu(30, () => (A.has('history') ? { label: 'History', icon: 'history', run: () => { render(); page.open(); } } : null));

  function dayOf(t) {
    const d = new Date(t), today = new Date();
    const day0 = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const ago = Math.round((day0(today) - day0(d)) / 864e5);
    if (ago === 0) return 'Today';
    if (ago === 1) return 'Yesterday';
    const o = { weekday: 'long', month: 'short', day: 'numeric' };
    if (d.getFullYear() !== today.getFullYear()) o.year = 'numeric';
    try { return d.toLocaleDateString([], o); } catch (x) { return d.toDateString(); }
  }
  function timeOf(t) {
    const d = new Date(t);
    try { return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); } catch (x) { return d.getHours() + ':' + String(d.getMinutes()).padStart(2, '0'); }
  }

  let gone = new Set();                     // Flick-list files an entry points at that are no longer in the list
  const here = (e) => !!e.path || (!!e.libId && !gone.has(e.libId));

  function render() {
    const list = (A.njson('history') || []).filter((e) => e && typeof e === 'object' && e.name);
    if (list.some((e) => e.libId && !e.path)) {
      const lib = new Set((A.njson('library') || []).map((x) => x.id));
      gone = new Set(list.filter((e) => e.libId && !lib.has(e.libId)).map((e) => e.libId));
    } else gone = new Set();
    const body = page.body;
    body.innerHTML = '';
    page.act.disabled = !list.length || !A.has('historyClear');
    if (!list.length) {
      body.appendChild(X.empty(A.icons.history, 'No transfers yet', 'Files you send to your PC and get from it show up here.'));
      return;
    }
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
      card.appendChild(row(e));
    }
  }

  function row(e) {
    const r = h('div', 'frow');
    r.setAttribute('role', 'listitem');
    const main = h('button', 'fmain');
    const bad = e.ok === false;
    const ic = h('span', 'fic' + (bad ? ' bad' : ''));
    ic.appendChild(A.svgEl(bad ? ARROW.bad : e.dir === 'in' ? ARROW.in : ARROW.out));
    const tx = h('span', 'ftx');
    const top = h('span', 'ftop');
    top.append(h('b', '', e.name), h('span', 'ftime', timeOf(+e.time || 0)));
    tx.appendChild(top);
    const sm = h('small', 'fwrap');
    if (bad) sm.appendChild(h('span', 'fbad', (e.dir === 'in' ? 'Didn’t arrive' : 'Didn’t send') + ' · '));
    const bits = [e.kind === 'folder' ? 'Folder' : A.fmtSize(e.size), (e.dir === 'in' ? 'From ' : 'To ') + (e.pcName || 'your PC')];
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
      ok ? { label: e.dir === 'in' ? 'Send to ' + X.pcName() : 'Send again', icon: 'send', run: () => sendAgain(e) } : null,
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
    if (!A.st.connected) { A.toast('Connect to your PC to send', 2400); return; }
    const it = e.path
      ? { id: 'p:' + e.path, path: e.path, name: e.name, size: e.size, kind: e.kind === 'folder' ? '' : e.kind || '', dir: e.kind === 'folder' }
      : { id: e.libId, name: e.name, size: e.size, kind: e.kind || '' };
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
