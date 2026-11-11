'use strict';
// What's moving between this PC and its other devices (main.js, moving.js): Transfers at the top of the window's main
// view, while anything moves and for a minute after, one row each (which way, what, the other device, how far, Cancel),
// and the setting for the progress card on the screen. State comes from main as 'panel:moving' (at most every 200 ms);
// Cancel and the setting go back on the same channel.
(function () {
  const api = window.flick;
  const $ = (id) => document.getElementById(id);
  const send = (what, extra) => api.send('panel:moving', Object.assign({ what }, extra || {}));
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const svg = (paths) => {
    const NS = 'http://www.w3.org/2000/svg';
    const s = document.createElementNS(NS, 'svg');
    s.setAttribute('viewBox', '0 0 16 16'); s.setAttribute('aria-hidden', 'true');
    for (const d of paths) { const p = document.createElementNS(NS, 'path'); p.setAttribute('d', d); s.appendChild(p); }
    return s;
  };
  // (the same arrows as History)
  const ICON = {
    in: ['M11.5 4.5l-7 7', 'M4.5 6.5v5h5'], out: ['M4.5 11.5l7-7', 'M6.5 4.5h5v5'],
    ok: ['M3.75 8.5l2.75 2.75 5.75-6.5'], bad: ['M8 4.5v4.25', 'M8 11.25v.25'], off: ['M5 5l6 6M11 5l-6 6'],
  };
  const KEEP = 60000;                  // a transfer that ended stays listed for a minute
  const MAX = 6;                       // rows at most (what's moving first): the rest of the window stays in reach
  // a name inside a sentence keeps to itself: right-to-left letters in it don't reorder the words around it
  const iso = (n) => '\u2068' + n + '\u2069';
  const size = (n) => (n >= 1e9 ? (n / 1e9).toFixed(n < 1e10 ? 1 : 0) + ' GB' : n >= 1e6 ? (n / 1e6).toFixed(n < 1e7 ? 1 : 0) + ' MB'
    : n >= 1e3 ? Math.round(n / 1e3) + ' KB' : n + (n === 1 ? ' byte' : ' bytes'));
  const WHY = window.XF_WHY;            // (xfwhy.js: the same words as the card on the screen)

  let M = { now: [], recent: [], speed: true, card: true };
  let speed = true;
  const rows = new Map();              // key -> a row and its parts
  let nid = 0, hover = false, expT = null;
  let all = false;                     // "+N more" pressed: every one listed (and each can be canceled), until they fit
  const list = $('xfList');

  const pct = (x) => (x.total > 0 ? Math.min(100, Math.floor((x.done / x.total) * 100)) : -1);
  // the line under the name: the other device, then how far, or how it ended (what comes after the device's name, which
  // alone is cut short when the line is too long: the % always shows)
  function line(x) {
    if (x.ended) {
      if (x.ok) return ' · ' + (x.dir === 'out' ? 'Sent' : 'Received') + (x.total > 0 ? ' · ' + size(x.total) : '');
      return ' · ' + (WHY[x.dir][x.why === 'changed' && x.files > 1 ? 'changedN' : x.why] || (x.dir === 'out' ? 'Couldn’t send' : 'Couldn’t receive'));
    }
    if (x.canceling) return ' · Canceling…';
    const p = pct(x);
    if (x.state === 'waiting') return ' · ' + (x.dir === 'out' ? 'Waiting to be accepted' : 'Waiting for you to accept');
    if (x.state === 'paused') return ' · Paused' + (p >= 0 ? ' at ' + p + '%' : '');
    if (x.total > 0 && x.done >= x.total) return ' · ' + (x.dir === 'out' ? 'Finishing…' : 'Saving…');
    let s = '';
    if (p >= 0) s += ' · ' + p + '% · ' + size(x.done) + ' of ' + size(x.total);
    else if (x.total < 0 && x.done > 0) s += ' · ' + size(x.done);
    if (speed && x.rate > 0) s += ' · ' + size(x.rate) + '/s';
    return s;
  }
  // what the end of a transfer is called, for a screen reader
  function said(x) {
    const what = iso(x.name), to = (x.dir === 'out' ? ' to ' : ' from ') + iso(x.deviceName);
    if (x.ok) return (x.dir === 'out' ? 'Sent ' : 'Received ') + what + to;
    if (x.why === 'canceled') return 'Canceled ' + what;
    if (x.why === 'changed') return what + ' changed on this PC. Send ' + (x.files > 1 ? 'them' : 'it') + ' again.';
    return (x.dir === 'out' ? 'Couldn’t send ' : 'Couldn’t receive ') + what + to;
  }
  const setText = (e, t) => { if (e.textContent !== t) e.textContent = t; };
  const setAttr = (e, k, v) => { if (v === null) { if (e.hasAttribute(k)) e.removeAttribute(k); } else if (e.getAttribute(k) !== v) e.setAttribute(k, v); };

  function makeRow(x) {
    const r = el('div', 'xfrow');
    r.setAttribute('role', 'listitem');
    r.tabIndex = -1;                    // (where the keyboard goes when its Cancel goes)
    r.dataset.key = x.key;
    const ico = el('span', 'xfdir');
    const main = el('div', 'xfmain');
    // the name (and the file of a batch going now), with Cancel beside it: the line under it and the bar have the width
    const top = el('div', 'xftop');
    const names = el('div', 'xfname');
    const nm = el('span', 'xfn');
    nm.id = 'xfn' + (++nid);
    const cur = el('span', 'xfcur');
    names.append(nm, cur);
    top.appendChild(names);
    const sub = el('div', 'xfsub');
    const subWho = el('span', 'xfwho'), subDev = el('span', 'xfdev'), subHow = el('span', 'xfhow');
    sub.append(subWho, subDev, subHow);
    const bar = el('div', 'xfbar');
    bar.setAttribute('role', 'progressbar');
    bar.setAttribute('aria-labelledby', nm.id);
    bar.setAttribute('aria-valuemin', '0');
    bar.setAttribute('aria-valuemax', '100');
    const fill = el('i');
    bar.appendChild(fill);
    main.append(top, sub, bar);
    const btn = el('button', 'btn ghost xfx', 'Cancel');
    btn.type = 'button';
    const row = { el: r, ico, top, nm, cur, sub, subWho, subDev, subHow, bar, fill, btn, shape: '', key: x.key, started: x.startT, ran: false };
    btn.onclick = () => { if (btn.getAttribute('aria-disabled') !== 'true') send('cancel', { key: row.key }); };
    r.append(ico, main);
    return row;
  }

  // a row is never made again: what it shows changes in place, and its Cancel stays the same button (the keyboard stays
  // on it) until the transfer ends, when the keyboard moves to the row itself
  function paint(row, x) {
    const kind = x.ended ? (x.ok ? 'ok' : x.why === 'canceled' ? 'off' : 'bad') : x.state === 'paused' ? 'paused' : x.state === 'waiting' ? 'wait' : 'run';
    const can = !x.ended && x.canCancel;
    const shape = kind + '|' + x.dir + '|' + can;
    if (row.shape !== shape) {
      row.shape = shape;
      row.el.className = 'xfrow ' + kind;
      row.ico.textContent = '';
      row.ico.appendChild(svg(ICON[x.ended ? kind : x.dir]));
      if (!can && row.btn.isConnected) {
        const had = document.activeElement === row.btn;
        row.btn.remove();
        if (had) row.el.focus();
      } else if (can && !row.btn.isConnected) row.top.appendChild(row.btn);
    }
    setText(row.nm, x.name);
    setText(row.cur, !x.ended && x.current && x.current !== x.name ? x.current : '');
    setText(row.subWho, x.dir === 'out' ? 'To ' : 'From ');
    setText(row.subDev, iso(x.deviceName));
    setText(row.subHow, line(x));
    const p = pct(x);
    row.bar.classList.toggle('busy', !x.ended && x.total < 0 && x.state === 'running');
    const w = x.ended ? (x.ok ? 100 : 0) : Math.max(0, p);
    if (row.fill.style.width !== w + '%') row.fill.style.width = w + '%';
    // (a screen reader hears how far it is; once it ended the line under the name says how it went)
    setAttr(row.bar, 'aria-hidden', x.ended ? 'true' : null);
    setAttr(row.bar, 'aria-valuenow', !x.ended && p >= 0 ? String(p) : null);
    setAttr(row.bar, 'aria-valuetext', !x.ended ? (p >= 0 ? p + '%, ' + size(x.done) + ' of ' + size(x.total) : x.total < 0 ? size(x.done) + ' so far' : null) : null);
    if (can) {
      setAttr(row.btn, 'aria-label', 'Cancel ' + (x.dir === 'out' ? 'sending ' : 'receiving ') + iso(x.name) + (x.dir === 'out' ? ' to ' : ' from ') + iso(x.deviceName));
      setAttr(row.btn, 'aria-disabled', x.canceling ? 'true' : 'false');
      setText(row.btn, x.canceling ? 'Canceling…' : 'Cancel');
    }
    if (!x.ended) row.ran = true;
  }

  function render() {
    clearTimeout(expT); expT = null;
    const now = performance.now();
    const ended = M.recent.filter((x) => now - x.endT < KEEP);        // (newest first)
    const max = all ? Infinity : MAX;
    const shown = M.now.slice(0, max).concat(ended.slice(0, Math.max(0, max - M.now.length)));
    const extra = M.now.length + ended.length - shown.length;
    if (all && M.now.length + ended.length <= MAX) all = false;      // (they fit again: back to the usual list)
    const keys = new Set();
    const heard = [];
    for (const x of shown) {
      keys.add(x.key);
      let row = rows.get(x.key);
      if (!row) {
        row = makeRow(x);
        rows.set(x.key, row);
        // in the order they started, new ones at the end: the rows above don't move
        let before = null;
        for (const r of rows.values()) if (r !== row && r.el.isConnected && r.started > x.startT && (!before || r.started < before.started)) before = r;
        list.insertBefore(row.el, before ? before.el : null);
      } else if (row.started !== x.startT) row.started = x.startT;
      const was = row.shape;
      paint(row, x);
      // (an end the window saw coming, not one it hears about as it opens)
      if (x.ended && row.ran && was && !/^(ok|off|bad)\|/.test(was)) heard.push(said(x));
    }
    // A minute after it ended a row goes, and so does one main stopped listing; not while the pointer is on the list,
    // where the rows below it would move under it
    let lost = false;
    for (const [key, row] of rows) {
      if (keys.has(key) || hover) continue;
      if (row.el.contains(document.activeElement)) lost = true;
      row.el.remove();
      rows.delete(key);
    }
    $('xf').hidden = rows.size === 0;
    const more = $('xfMore');
    more.hidden = !((extra > 0 || all) && rows.size);
    setText(more, all ? 'Show fewer' : extra > 0 ? '+' + extra + ' more' : '');
    setAttr(more, 'aria-label', all ? 'Show fewer transfers' : extra > 0 ? 'Show ' + extra + ' more transfers' : null);
    setAttr(more, 'aria-expanded', all ? 'true' : 'false');
    // (the keyboard was on a row that went: it stays in Transfers while there's anything left in it, else it goes on to
    // what follows Transfers in the window, not back to the page's start where a screen reader says nothing)
    if (lost && rows.size) { const t = $('xfTitle'); t.tabIndex = -1; t.focus(); }
    else if (lost) {
      const next = [...document.querySelectorAll('#main button, #main input, #main select, #main [tabindex="0"]')]
        .find((el) => ($('xf').compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) && !el.disabled && el.getClientRects().length);
      if (next) next.focus();
      else { const m = $('main'); m.tabIndex = -1; m.focus(); }
    }
    if (heard.length && document.visibilityState === 'visible') setText($('xfLive'), heard.slice(-3).join('. '));
    // the next one to go
    let next = Infinity;
    for (const x of M.recent) if (now - x.endT < KEEP) next = Math.min(next, KEEP - (now - x.endT));
    if (next < Infinity) expT = setTimeout(render, next + 50);
    const box = $('xfCard');
    if (box && document.activeElement !== box) box.checked = M.card !== false;
  }

  api.on('panel:moving', (m) => {
    if (!m || typeof m !== 'object') return;
    M = { now: Array.isArray(m.now) ? m.now : [], recent: Array.isArray(m.recent) ? m.recent : [], speed: m.speed !== false, card: m.card !== false };
    // when each ended, on this page's own clock (main says how long ago; a change of the computer's clock moves neither)
    const at = performance.now();
    for (const x of M.now.concat(M.recent)) {
      x.startT = at - (Number.isFinite(x.age) ? x.age : 0);
      x.endT = at - (Number.isFinite(x.ago) ? x.ago : 0);
    }
    speed = M.speed;
    render();
  });
  // "Show transfer speed" (the Files settings) applies here too
  api.on('panel:state', (s) => { if (s && !!s.showSpeed !== speed) { speed = !!s.showSpeed; render(); } });
  // the ones beyond the first few can be seen, and canceled, too
  $('xfMore').onclick = () => { all = !all; render(); };
  list.addEventListener('mouseenter', () => { hover = true; });
  list.addEventListener('mouseleave', () => { hover = false; render(); });
  // (the window went behind another or was closed with the pointer on the list: it isn't there any more)
  window.addEventListener('blur', () => { if (hover) { hover = false; render(); } });
  document.addEventListener('visibilitychange', () => { if (document.hidden && hover) { hover = false; render(); } });
  $('xfCard').addEventListener('change', (e) => send('card', { on: e.target.checked }));
  send('hello');
})();
