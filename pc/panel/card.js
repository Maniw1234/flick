'use strict';
// The progress card on the screen (main.js cardShow): what's moving while Flick's window isn't open, like a phone's
// progress notification. Up to three rows ("Receiving IMG_2041.jpg" / "From Pixel 7 · 45%" and a line), "+2 more" past
// that; a row that ended shows a check, or what went wrong. Its window never takes the focus; a click opens Flick's.
(function () {
  const api = window.flick;
  const $ = (id) => document.getElementById(id);
  const box = $('cd'), list = $('rows'), more = $('more');
  const rows = new Map();              // key -> a row and its parts
  let outT = null;
  const NS = 'http://www.w3.org/2000/svg';
  const ICON = {
    in: ['M11.5 4.5l-7 7', 'M4.5 6.5v5h5'], out: ['M4.5 11.5l7-7', 'M6.5 4.5h5v5'],
    ok: ['M3.75 8.5l2.75 2.75 5.75-6.5'], bad: ['M8 4.5v4.25', 'M8 11.25v.25'], off: ['M5 5l6 6M11 5l-6 6'],
  };
  const WHY = window.XF_WHY;            // (xfwhy.js: the same words as the window's Transfers)
  const el = (tag, cls) => { const e = document.createElement(tag); if (cls) e.className = cls; return e; };
  const setText = (e, t) => { if (e.textContent !== t) e.textContent = t; };
  function icon(e, k) {
    if (e.dataset.k === k) return;
    e.dataset.k = k;
    e.textContent = '';
    const s = document.createElementNS(NS, 'svg');
    s.setAttribute('viewBox', '0 0 16 16');
    for (const d of ICON[k]) { const p = document.createElementNS(NS, 'path'); p.setAttribute('d', d); s.appendChild(p); }
    e.appendChild(s);
  }

  function make() {
    const r = el('div', 'r'), ic = el('div', 'ic'), tx = el('div', 'tx');
    const t1 = el('div', 't1'), verb = el('span'), name = el('bdi');
    t1.append(verb, ' ', name);
    // names from other devices are isolated (<bdi>): right-to-left letters in one can't reorder the words around it
    const t2 = el('div', 't2'), who = el('span'), dev = el('bdi'), how = el('span');
    t2.append(who, dev, how);
    const ln = el('div', 'ln'), fill = el('i');
    ln.appendChild(fill);
    tx.append(t1, t2, ln);
    r.append(ic, tx);
    return { el: r, ic, verb, name, who, dev, how, ln, fill };
  }

  // x: { key, dir, name, device, state (running | waiting | paused | done | canceled | failed), why, canceling, pct (-1: size not known) }
  function paint(row, x) {
    const out = x.dir === 'out';
    const ended = x.state === 'done' || x.state === 'canceled' || x.state === 'failed';
    const kind = x.state === 'done' ? 'ok' : x.state === 'canceled' ? 'off' : x.state === 'failed' ? 'bad' : x.state === 'paused' ? 'paused' : x.state === 'waiting' ? 'wait' : 'run';
    const cls = 'r ' + kind;
    if (row.el.className !== cls) row.el.className = cls;
    icon(row.ic, ended ? kind : out ? 'out' : 'in');
    // (one that all went, its answer lost: sent, not confirmed)
    setText(row.verb, x.state === 'done' || (x.state === 'failed' && x.why === 'unconfirmed') ? (out ? 'Sent' : 'Received') : x.state === 'canceled' ? (out ? 'Didn’t send' : 'Didn’t receive')
      : x.state === 'failed' ? (out ? 'Couldn’t send' : 'Couldn’t receive') : out ? 'Sending' : 'Receiving');
    setText(row.name, x.name || 'File');
    setText(row.who, out ? 'To ' : 'From ');
    setText(row.dev, x.device || '');
    setText(row.how, ended ? (x.state === 'done' ? '' : ' · ' + (WHY[out ? 'out' : 'in'][x.why === 'changed' && x.files > 1 ? 'changedN' : x.why] || 'Something went wrong'))
      : x.canceling ? ' · Canceling…' : x.state === 'waiting' ? (out ? ' · Waiting to be accepted' : ' · Waiting for you to accept')
        : x.state === 'paused' ? ' · Paused' : x.pct >= 100 ? (out ? ' · Finishing…' : ' · Saving…') : x.pct >= 0 ? ' · ' + x.pct + '%' : '');
    row.ln.classList.toggle('busy', !ended && x.pct < 0 && x.state === 'running');
    const w = (ended ? (x.state === 'done' ? 100 : 0) : Math.max(0, x.pct)) + '%';
    if (row.fill.style.width !== w) row.fill.style.width = w;
  }

  function show(m) {
    clearTimeout(outT); outT = null;
    if (m.accent) document.documentElement.style.setProperty('--accent', m.accent);
    box.classList.toggle('top', !!m.top);
    const keep = new Set();
    let prev = null;
    for (const x of m.rows || []) {
      keep.add(x.key);
      let row = rows.get(x.key);
      if (!row) { row = make(); rows.set(x.key, row); }
      paint(row, x);
      if (prev ? prev.nextSibling !== row.el : list.firstChild !== row.el) list.insertBefore(row.el, prev ? prev.nextSibling : list.firstChild);
      prev = row.el;
    }
    for (const [k, row] of rows) if (!keep.has(k)) { row.el.remove(); rows.delete(k); }
    more.hidden = !(m.more > 0);
    setText(more, m.more > 0 ? '+' + m.more + ' more' : '');
    if (box.hidden) {
      // (it comes in with a short fade, from the edge it's nearest)
      box.hidden = false;
      void box.offsetWidth;
    }
    box.classList.remove('out');
  }
  // it fades, then its rows go: the window is hidden empty, so it never shows an old row when it comes back
  function hide() {
    box.classList.add('out');
    clearTimeout(outT);
    outT = setTimeout(() => { outT = null; box.hidden = true; list.textContent = ''; rows.clear(); more.hidden = true; }, 160);
  }

  api.on('app:card', (m) => {
    if (!m || typeof m !== 'object') return;
    if (m.what === 'show') show(m);
    else if (m.what === 'hide') hide();
  });
  box.addEventListener('click', () => api.send('app:card', { what: 'open' }));
})();
