/* Transfers: everything moving between this phone and your other devices, both ways. Sends to a PC that the app carries
 * on with (protocol 7 PCs: they go on with Flick closed, wait while the PC can't be reached and carry on where they
 * stopped) have Pause / Resume / Cancel / Try again; files from the PC and sends to and from other phones (the app's
 * list of what moves, Moving.java) have Cancel. This page lists what moves now and what finished lately, with how far
 * each got, its speed and time left; Settings starts with what moves now. Opened from the toolbar while something is
 * sending, from the ••• menu, or from Settings › See all transfers. */
(window.FlickFeatures = window.FlickFeatures || []).push(function (A, X) {
  'use strict';
  const h = X.h;
  const ENDED = ['done', 'failed', 'canceled', 'skipped'];
  const ICON = {
    up: '<svg viewBox="0 0 24 24"><path d="M12 18.5V6M6.8 11.2L12 6l5.2 5.2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    down: '<svg viewBox="0 0 24 24"><path d="M12 5.5V18M6.8 12.8L12 18l5.2-5.2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    ok: '<svg viewBox="0 0 24 24"><path d="M7 12.4l3.3 3.3L17.2 8.6" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    bad: '<svg viewBox="0 0 24 24"><path d="M12 6.5v7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><circle cx="12" cy="17.3" r="1.35" fill="currentColor"/></svg>',
    wait: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="7.4" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 8v4.3l2.8 1.7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    pause: '<svg viewBox="0 0 24 24"><path d="M9 7v10M15 7v10" stroke="currentColor" stroke-width="2.3" stroke-linecap="round"/></svg>',
    play: '<svg viewBox="0 0 24 24"><path d="M9 6.8v10.4l8.2-5.2z" fill="currentColor"/></svg>',
    retry: '<svg viewBox="0 0 24 24"><path d="M18.8 12a6.8 6.8 0 1 1-2-4.8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M17.4 3.8v3.9h-3.9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    stop: '<svg viewBox="0 0 24 24"><path d="M7.6 7.6l8.8 8.8M16.4 7.6l-8.8 8.8" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round"/></svg>',
  };
  const jobs = () => [...A.st.jobs.values()].filter((j) => j.committed || !ENDED.includes(j.state)).sort((a, b) => b.created - a.created);

  // ---- what moves, as the app lists it ({ now, recent }: 'moving' events keep it). A name from another device shows
  // as text without direction controls, and is set apart from the words around it (<bdi>).
  // (core.js X.clean: without direction controls, and a name of only invisible marks is none, so the default shows)
  const clean = (s) => X.clean(s);
  let M = { now: [], recent: [] };
  function setM(s) {
    const list = (a) => (Array.isArray(a) ? a : []).filter((x) => x && typeof x.key === 'string')
      .map((x) => Object.assign({}, x, { name: clean(x.name) || 'File', deviceName: clean(x.deviceName), current: clean(x.current) }));
    M = { now: list(s && s.now), recent: list(s && s.recent) };
    for (const k of [...stopping]) if (!M.now.some((m) => m.key === k)) stopping.delete(k);
  }
  const stopping = new Set();                       // canceled here, not over yet: "Stopping…"
  // Finished ones Clear (or Remove from the list) took off this page: key@when it ended. Kept (a preference) as long as
  // the app lists them (Moving.java: 10 minutes at most): kept in the page only, Flick closed and opened again brought
  // them all back
  const cleared = new Set((() => {
    try { const a = JSON.parse(A.pref.get('xfCleared', '[]')); return Array.isArray(a) ? a.filter((k) => typeof k === 'string') : []; } catch (e) { return []; }
  })());
  function clearedKeep() {
    const listed = new Set(M.recent.map((m) => m.key + '@' + m.ended)), n = cleared.size;
    for (const k of [...cleared]) if (!listed.has(k)) cleared.delete(k);
    if (cleared.size || n) A.pref.set('xfCleared', cleared.size ? JSON.stringify([...cleared]) : '');
  }
  if (A.has('movingState')) { setM(A.njson('movingState')); clearedKeep(); }
  const recent = () => M.recent.filter((m) => !cleared.has(m.key + '@' + m.ended));
  // a send to the PC the app carries on with shows once: as its own row (Pause, Resume, Try again)
  const isJob = (m) => m.key.indexOf('pc-out:') === 0 && A.st.jobs.has(m.key.slice(7));

  const page = X.page({ id: 'fXfers', title: 'Transfers', action: { text: 'Clear', label: 'Clear finished transfers', run: clearEnded } });
  X.menu(25, () => ((A.has('sendList') && A.st.jobs.size) || M.now.length || recent().length ? { label: 'Transfers', icon: 'send', run: open } : null));
  A.on('countTap', () => { open(); return true; });
  A.on('native', (e) => {
    if (e.t === 'job' && page.isOpen()) soon();
    if (e.t === 'resume' && page.isOpen()) soon();               // (the time zone or language may have changed meanwhile)
    if (e.t === 'moving') { setM(e.state); if (page.isOpen()) soon(); settingsSoon(); }
  });

  let renderT = 0;
  function soon(ms) { if (!renderT) renderT = setTimeout(() => { renderT = 0; if (page.isOpen()) render(); }, ms || 120); }
  // time left and "tries again in" count down between events, while the page is open (its clock ran from the start,
  // waking the page every second with the page closed and Flick in the back)
  let clockT = 0;
  function clock() {
    if (!page.isOpen()) { clearInterval(clockT); clockT = 0; return; }
    if (M.now.length || jobs().some((j) => j.state === 'running' || j.state === 'waiting')) render();
  }
  function open() { render(true); page.open(); if (!clockT) clockT = setInterval(clock, 1000); }
  const close0 = page.close;
  page.close = () => { const r = close0(); if (r) { clearInterval(clockT); clockT = 0; } return r; };

  // A list built anew under a finger lost the tap (and a press's timer opened the menu by itself): it waits until the
  // finger is up (a few seconds at most).
  let downOn = null, downAt = 0;
  document.addEventListener('pointerdown', (e) => { downOn = e.target; downAt = Date.now(); }, true);
  const up = () => { downOn = null; };
  document.addEventListener('pointerup', up, true);
  document.addEventListener('pointercancel', up, true);
  const fingerOn = (el) => !!(downOn && el.contains(downOn) && Date.now() - downAt < 4000);

  // While something moves the page is drawn every few hundred ms. Its rows stay the same elements and only their
  // figures change: a row rebuilt under a finger lost the tap, and its press timer opened the menu by itself. A row is
  // made again only when what it is changes (a send pauses, ends, waits), and the list changes around the rows that
  // stay (rebuilding it all for each transfer that started took a tenth of a second with many, and the keyboard's focus
  // dropped to the start of the page).
  const rows = new Map();                           // 'j:' + tid / 'm:' + key -> its row
  let shape = null;
  const G = {};                                     // the page's parts, made once: its groups, the note, the empty page
  // what makes a row what it is (its icon, its bar, its buttons): a change makes it again
  const rowShape = (e) => (e.j ? 'j' + e.j.state : e.m.state + (e.m.ended ? '.' : '') + (e.m.cancel ? '+' : '') + (stopping.has(e.m.key) ? '-' : ''));

  // With many moving, every row's words and bar changed at each update and the whole list was laid out and painted
  // again, four times a second (100 moving: frames of 83 ms on a mid-range phone; 300: 180 ms). Rows more than half a
  // screen out of sight (ffar) now keep what they were last told and are brought up to date as they come near, before
  // they show, and meanwhile a few at each drawing, in turn: a screen reader still finds every row where it is, its
  // figures a few seconds old at most. (content-visibility would have left the rows out of sight out of what a screen
  // reader can reach.)
  const FAR_EACH = 10;
  let farAt = 0;
  const watched = new Set();
  const io = typeof IntersectionObserver === 'function' ? new IntersectionObserver((es) => {
    for (const e of es) {
      const r = e.target, far = !e.isIntersecting;
      if (r._far === far) continue;
      r._far = far;
      r.classList.toggle('ffar', far);
      if (!far) put(r);
    }
  }, { root: page.body, rootMargin: '50% 0px' }) : null;
  // a row's figures: now, or kept for later if it's out of sight (force: every row now, as the page opens)
  function figs(r, e, force) {
    if (e.j) r._j = e.j; else r._m = e.m;
    r._due = e;
    if (!r._far || force) put(r);
  }
  function put(r) {
    const e = r._due;
    if (!e) return;
    r._due = null;
    if (e.j) update(r, e.j); else mvUpdate(r, e.m);
  }
  function render(force) {
    fresh();
    const body = page.body;
    const js = jobs();
    const now = js.filter((j) => !ENDED.includes(j.state)).map((j) => ({ k: 'j:' + j.tid, j, t: j.created }))
      .concat(M.now.filter((m) => !isJob(m)).map((m) => ({ k: 'm:' + m.key, m, t: m.started })))
      .sort((a, b) => b.t - a.t);
    const done = js.filter((j) => ENDED.includes(j.state)).map((j) => ({ k: 'j:' + j.tid, j, t: j.ended || j.created }))
      .concat(recent().filter((m) => !isJob(m)).map((m) => ({ k: 'm:' + m.key, m, t: m.ended })))
      .sort((a, b) => b.t - a.t);
    const all = now.concat(done);
    page.setAct(done.length > 0);
    const wait = js.find((j) => j.state === 'waiting');
    const note = wait ? 'Waiting sends carry on by themselves as soon as ⁨' + (clean(wait.pcName) || 'your PC') + '⁩ can be reached again, even with Flick closed.' : '';
    // the rows out of sight, a few at a time, in turn
    const farTurn = () => {
      for (let i = 0, n = FAR_EACH, len = all.length; i < len && n > 0; i++) {
        const r = rows.get(all[(farAt + i) % len].k);
        if (r && r._due) { put(r); if (!--n) farAt = (farAt + i + 1) % len; }
      }
    };
    const figures = () => { for (const e of all) { const r = rows.get(e.k); if (r && r._shape === rowShape(e)) figs(r, e, force); } farTurn(); };
    const key = now.map((e) => e.k + ' ' + rowShape(e)).join('|') + '#' + done.map((e) => e.k + ' ' + rowShape(e)).join('|') + '#' + note;
    if (key === shape) { figures(); return; }
    // (under a finger the rows don't move: it waits until the finger is up, the figures still change)
    if (shape !== null && fingerOn(body)) { figures(); soon(150); return; }
    shape = key;
    const act = document.activeElement, at = act && body.contains(act) ? act.closest('[data-rk]') : null;
    const fill = (card, list) => sync(card, list.map((e) => {
      let r = rows.get(e.k);
      const sh = rowShape(e);
      if (r && r._shape === sh) { figs(r, e, force); return r; }
      r = e.j ? row(e.j) : mvRow(e.m);
      r._shape = sh;
      r.dataset.rk = e.k;
      rows.set(e.k, r);
      if (io) { io.observe(r); watched.add(r); }
      return r;
    }));
    if (now.length) fill(group('now', 'Now').card, now);
    if (done.length) fill(group('done', 'Finished').card, done);
    if (note) { if (!G.note) G.note = h('div', 'fnote'); if (G.note.textContent !== note) G.note.textContent = note; }
    if (!all.length && !G.empty) G.empty = X.empty(ICON.up, 'Nothing moving', 'Files going between this phone and your other devices show up here while they travel. Sends to your PC keep going if you close Flick.');
    sync(body, [now.length ? G.now.el : null, done.length ? G.done.el : null, note ? G.note : null, all.length ? null : G.empty].filter(Boolean));
    const keep = new Set(all.map((e) => e.k));
    for (const [k, r] of rows) if (!keep.has(k) || !r.isConnected) rows.delete(k);
    for (const r of watched) if (!r.isConnected) { io.unobserve(r); watched.delete(r); }
    farTurn();
    // the keyboard was in a row that went or was made again: it goes to the same control of the row now in its place, or
    // the next one there is (it dropped to the start of the page)
    if (at && !act.isConnected) {
      const r = rows.get(at.dataset.rk), k = act.dataset ? act.dataset.k : '';
      const to = (r && ((k && r.querySelector('[data-k="' + k + '"]')) || r.querySelector('.fmain'))) || body.querySelector('.fmain') || page.el.querySelector('.hback');
      if (to) to.focus({ preventScroll: true });
    }
  }

  // a group of rows (Now, Finished), made once and kept
  function group(id, title) {
    if (!G[id]) {
      const el = h('section', 'sgroup');
      el.appendChild(h('h3', '', title));
      const card = h('div', 'scard');
      card.setAttribute('role', 'list');
      el.appendChild(card);
      G[id] = { el, card };
    }
    return G[id];
  }

  // Makes box hold just these elements, in this order, moving as few as it can: what went goes first, then each one is
  // put in its place (one taken out and put back in loses the keyboard's focus)
  function sync(box, els) {
    const want = new Set(els);
    for (const c of [...box.children]) if (!want.has(c)) c.remove();
    let at = box.firstElementChild;
    for (const e of els) { if (e === at) at = at.nextElementSibling; else box.insertBefore(e, at); }
  }

  // ------------------------------------------------------------------ sends to the PC the app carries on with
  function pct(j) { return j.total > 0 ? Math.min(100, Math.floor((j.sent / j.total) * 100)) : 0; }
  function left(s) {
    if (!(s >= 0)) return '';
    if (s < 60) return Math.max(1, Math.round(s)) + ' s left';
    if (s < 3600) return Math.round(s / 60) + ' min left';
    return (s / 3600).toFixed(1) + ' h left';
  }
  // (the PC's name set apart from the words around it, as on the other rows: one with a right-to-left mark in it turned
  // the whole line around; why it failed, or why some of a finished send didn't go, a sentence that wraps)
  function line(j) {
    const pc = clean(j.pcName) || 'your PC', why = clean(j.why);
    const size = j.total > 0 ? A.fmtSize(j.sent) + ' of ' + A.fmtSize(j.total) : '';
    switch (j.state) {
      case 'running': return [pct(j) + '%', size, j.rate > 0 ? A.fmtRate(j.rate) : '', left(j.eta)].filter(Boolean);
      case 'queued': return ['Starting…'];
      case 'waiting': return [['Waiting for ', pc], j.retryIn > 1500 ? 'tries again in ' + Math.ceil(j.retryIn / 1000) + ' s' : 'trying…', j.total > 0 ? pct(j) + '% there' : ''].filter(Boolean);
      case 'paused': return ['Paused', j.total > 0 ? pct(j) + '% there' : ''].filter(Boolean);
      case 'done': return [['Sent to ', pc], j.total > 0 ? A.fmtSize(j.total) : '', j.had ? j.had + ' already there' : '', why ? { wrap: why } : ''].filter(Boolean);
      case 'skipped': return [['Already on ', pc]];
      case 'failed': return [{ wrap: why || 'Couldn’t send it' }];
      case 'canceled': return [why ? { wrap: why } : 'Canceled'];
      default: return [j.state];
    }
  }

  function row(j) {
    const r = h('div', 'frow fx' + j.state);
    r.setAttribute('role', 'listitem');
    const main = h('button', 'fmain');
    const bad = j.state === 'failed';
    const ic = h('span', 'fic' + (bad ? ' bad' : ''));
    ic.appendChild(A.svgEl(bad ? ICON.bad : j.state === 'done' || j.state === 'skipped' ? ICON.ok : j.state === 'waiting' ? ICON.wait : ICON.up));
    const tx = h('span', 'ftx');
    const top = h('span', 'ftop');
    r._time = h('span', 'ftime');
    top.append(X.nm('b', '', j.name || 'File'), r._time);
    tx.appendChild(top);
    r._sm = h('small', bad ? 'fwrap fbad' : 'fwrap');
    tx.appendChild(r._sm);
    if (j.state === 'running' || j.state === 'paused' || j.state === 'waiting') {
      const bar = h('span', 'fxbar');
      r._fill = h('i');
      bar.appendChild(r._fill);
      tx.appendChild(bar);
    }
    update(r, j);
    rows.set('j:' + j.tid, r);
    main.append(ic, tx);
    X.press(main, () => menu(r._j), () => menu(r._j));     // (the transfer as it is now)
    main.dataset.k = 'main';
    r.appendChild(main);
    // the one thing most often wanted, right there
    const quick = j.state === 'running' || j.state === 'queued' ? ['pause', 'Pause', () => act('sendPause', j)]
      : j.state === 'paused' ? ['play', 'Resume', () => act('sendResume', j)]
        : j.state === 'waiting' ? ['retry', 'Try now', () => act('sendResume', j)]
          : j.state === 'failed' || j.state === 'canceled' ? ['retry', 'Try again', () => act('sendRetry', j)] : null;
    if (quick) {
      const b = h('button', 'fmore');
      b.dataset.k = 'more';
      b.setAttribute('aria-label', quick[1] + ' ' + (j.name || ''));
      b.appendChild(A.svgEl(ICON[quick[0]]));
      b.onclick = quick[2];
      r.appendChild(b);
    }
    return r;
  }

  // a row's figures: how far, how fast, the time
  function update(r, j) {
    r._j = j;
    setTime(r, j.ended || j.created);
    bits(r, line(j));
    if (r._fill) { const tf = 'scaleX(' + (pct(j) / 100) + ')'; if (r._tf !== tf) { r._tf = tf; r._fill.style.transform = tf; } }
  }

  // One way of writing a time, made once (making it again for every row at each change was the page's heaviest work with
  // many transfers), and a row's time worked out only when it changed
  // (made again, and the rows' times written again, when the time zone or language changes: see X.clockKey)
  let timeFmt = null, timeKey = '';
  function fresh() {
    const k = X.clockKey();
    if (k === timeKey) return;
    const was = timeKey;
    timeKey = k; timeFmt = null;
    if (was) for (const r of rows.values()) if (r._time && r._tms != null) { const t = r._tms; r._tms = null; setTime(r, t); }
  }
  window.addEventListener('languagechange', () => { timeKey = '!'; if (page.isOpen()) soon(); });
  function when(t) {
    try { if (!timeFmt) timeFmt = new Intl.DateTimeFormat([], { hour: 'numeric', minute: '2-digit' }); return timeFmt.format(new Date(t)); } catch (e) { return ''; }
  }
  function setTime(r, t) {
    if (r._tms === t) return;
    r._tms = t;
    const s = when(t);
    if (r._time.textContent !== s) r._time.textContent = s;
  }

  // a row's line: its bits joined with dots; a bit with a device's name in it ([before, name, after]) keeps the name apart,
  // and one that's a sentence ({ wrap }) wraps, as a long name does
  function bits(r, list) {
    const text = JSON.stringify(list);
    if (r._text === text) return;
    r._text = text;
    // the same kinds of bits as before (a new figure, most often): their words change in place
    const kinds = list.map((b) => (b && b.wrap ? 'w' : Array.isArray(b) ? (b[2] ? 'n3' : 'n2') : 's')).join(' ');
    if (r._kinds === kinds) {
      list.forEach((b, i) => {
        const s = r._bits[i];
        if (Array.isArray(b)) {
          const c = s.childNodes;
          if (c[0].data !== b[0]) c[0].data = b[0];
          if (c[1].textContent !== b[1]) c[1].textContent = b[1];
          if (b[2] && c[2].data !== b[2]) c[2].data = b[2];
        } else { const t = b && b.wrap ? b.wrap : b; if (s.textContent !== t) s.textContent = t; }
      });
      return;
    }
    r._kinds = kinds;
    r._bits = [];
    r._sm.textContent = '';
    list.forEach((b, i) => {
      if (i) r._sm.appendChild(document.createTextNode(' · '));
      const s = h('span', Array.isArray(b) ? 'fbit fname' : b && b.wrap ? 'fbit fname fwhy' : 'fbit');
      if (b && b.wrap) s.textContent = b.wrap;
      else if (Array.isArray(b)) {
        s.appendChild(document.createTextNode(b[0]));
        const n = document.createElement('bdi');
        n.textContent = b[1];
        s.appendChild(n);
        if (b[2]) s.appendChild(document.createTextNode(b[2]));
      } else s.textContent = b;
      r._sm.appendChild(s);
      r._bits.push(s);
    });
  }

  function act(m, j) { A.haptic('tick'); A.nc(m, j.tid); }

  function menu(j) {
    const live = !ENDED.includes(j.state);
    A.openSheet(j.name || 'Transfer', [
      j.state === 'running' || j.state === 'queued' ? { label: 'Pause', icon: 'send', run: () => act('sendPause', j) } : null,
      j.state === 'paused' ? { label: 'Resume', icon: 'send', run: () => act('sendResume', j) } : null,
      j.state === 'waiting' ? { label: 'Try now', icon: 'send', run: () => act('sendResume', j) } : null,
      j.state === 'failed' || j.state === 'canceled' ? { label: 'Try again', icon: 'send', run: () => act('sendRetry', j) } : null,
      live ? { label: 'Cancel', icon: 'trash', danger: true, run: () => act('sendCancel', j) } : null,
      !live ? { label: 'Remove from the list', icon: 'trash', run: () => { A.nc('sendForget', j.tid); A.st.jobs.delete(j.tid); render(); } } : null,
    ]);
  }

  function clearEnded() {
    for (const j of jobs()) if (ENDED.includes(j.state)) { A.nc('sendForget', j.tid); A.st.jobs.delete(j.tid); }
    for (const m of M.recent) cleared.add(m.key + '@' + m.ended);
    clearedKeep();
    render();
  }

  // ------------------------------------------------------------------ everything else that moves (Moving)
  const who = (m) => m.deviceName || (m.kind === 'pc' ? 'your PC' : 'the other phone');
  const mpct = (m) => (m.total > 0 ? Math.min(100, Math.floor((Math.max(0, m.done) / m.total) * 100)) : -1);
  const iconOf = (m) => (m.state === 'failed' ? ICON.bad : m.state === 'done' ? ICON.ok : m.state === 'canceled' ? ICON.stop
    : m.state === 'waiting' ? ICON.wait : m.state === 'paused' ? ICON.pause : m.dir === 'in' ? ICON.down : ICON.up);

  // what a row says: which way and with whom, how far (full: size, speed and time left too), or how it ended. Settings'
  // short line (not full) leaves out how far: that stands apart in its row (mvFigure), where a long device name can't push
  // it out of sight
  function mvLine(m, full) {
    const d = who(m), to = [m.dir === 'in' ? 'From ' : 'To ', d], p = mpct(m);
    if (!m.ended && stopping.has(m.key)) return [to, 'Stopping…'];
    const size = m.total > 0 ? A.fmtSize(Math.min(m.done, m.total)) + ' of ' + A.fmtSize(m.total) : m.done > 0 ? A.fmtSize(m.done) : '';
    switch (m.state) {
      case 'running': {
        const rest = m.rate > 0 && m.total > m.done ? (m.total - m.done) / m.rate : -1;
        const cur = m.current && m.current !== m.name ? ['', m.current] : '';
        if (!full) return p >= 0 || m.done > 0 ? [to] : [to, 'Starting…'];
        return [to, cur, p >= 0 ? p + '%' : m.done > 0 ? '' : 'Starting…', size, m.rate > 0 ? A.fmtRate(m.rate) : '', left(rest)].filter(Boolean);
      }
      case 'waiting': return [['Waiting for ', d], full && p > 0 ? p + '% there' : ''].filter(Boolean);
      case 'paused': return ['Paused', to, full && p > 0 ? p + '% there' : ''].filter(Boolean);
      case 'done': return [[m.dir === 'in' ? 'Received from ' : 'Sent to ', d], m.total > 0 ? A.fmtSize(m.total) : ''].filter(Boolean);
      case 'canceled': return ['Canceled', to];
      default: return [{ wrap: m.why && m.why !== 'canceled' ? m.why : m.dir === 'in' ? 'Couldn’t receive it' : 'Couldn’t send it' }, to];
    }
  }

  // how far it got, in Settings' rows
  function mvFigure(m) {
    if (m.ended || stopping.has(m.key)) return '';
    const p = mpct(m);
    if (m.state === 'running') return p >= 0 ? p + '%' : m.done > 0 ? A.fmtSize(m.done) : '';
    return p > 0 ? p + '%' : '';
  }

  function mvRow(m) {
    const r = h('div', 'frow fx' + m.state);
    r.setAttribute('role', 'listitem');
    const main = h('button', 'fmain');
    const ic = h('span', 'fic' + (m.state === 'failed' ? ' bad' : ''));
    ic.appendChild(A.svgEl(iconOf(m)));
    const tx = h('span', 'ftx');
    const top = h('span', 'ftop');
    r._name = X.nm('b', '', m.name);
    r._time = h('span', 'ftime');
    top.append(r._name, r._time);
    tx.appendChild(top);
    r._sm = h('small', m.state === 'failed' ? 'fwrap fbad' : 'fwrap');
    tx.appendChild(r._sm);
    if (!m.ended) {
      r._bar = h('span', 'fxbar');
      r._fill = h('i');
      r._bar.appendChild(r._fill);
      tx.appendChild(r._bar);
    }
    mvUpdate(r, m);
    rows.set('m:' + m.key, r);
    main.append(ic, tx);
    X.press(main, () => mvMenu(r._m), () => mvMenu(r._m));
    main.dataset.k = 'main';
    r.appendChild(main);
    if (!m.ended && m.cancel && !stopping.has(m.key)) {
      const b = h('button', 'fmore');
      b.dataset.k = 'more';
      b.setAttribute('aria-label', 'Cancel ' + m.name);
      b.appendChild(A.svgEl(ICON.stop));
      b.onclick = () => cancel(r._m);
      r.appendChild(b);
    }
    return r;
  }

  function mvUpdate(r, m) {
    r._m = m;
    if (r._name.textContent !== m.name) r._name.textContent = m.name;
    setTime(r, m.ended || m.started);
    bits(r, mvLine(m, true));
    bar(r, m);
  }

  // its bar: how far; sliding while the size isn't known yet
  function bar(r, m) {
    if (!r._fill) return;
    const p = mpct(m), ind = p < 0 && m.state === 'running';
    if (r._ind !== ind) { r._ind = ind; r._bar.classList.toggle('ind', ind); }
    const tf = ind ? '' : 'scaleX(' + Math.max(0, p) / 100 + ')';
    if (r._tf !== tf) { r._tf = tf; r._fill.style.transform = tf; }
  }

  function cancel(m) {
    if (!m || m.ended || stopping.has(m.key)) return;
    A.haptic('tick');
    stopping.add(m.key);
    A.nc('movingCancel', m.key);
    if (page.isOpen()) render();
    settingsRender();
  }

  function mvMenu(m) {
    const items = [
      !m.ended && m.cancel && !stopping.has(m.key) ? { label: 'Cancel', icon: 'trash', danger: true, run: () => cancel(m) } : null,
      m.ended ? { label: 'Remove from the list', icon: 'trash', run: () => { cleared.add(m.key + '@' + m.ended); clearedKeep(); render(); } } : null,
    ].filter(Boolean);
    if (items.length) A.openSheet(m.name, items);
  }

  // ------------------------------------------------------------------ Settings: what moves now, at the top
  // Each transfer under way (which way, what, with which device, how far, Cancel), or that nothing moves; See all opens
  // this page. Its rows are kept and their figures change in place, as on the page. A few at most (the rest: See all),
  // the oldest first: one that starts doesn't move the others.
  const SHOW = 5;
  let SG = null;                                    // { el, card, rows, shape }
  A.on('settings', (body) => {
    const g = h('section', 'sgroup fmvset');
    g.appendChild(h('h3', '', 'Transfers'));
    const card = h('div', 'scard');
    card.setAttribute('role', 'list');
    g.appendChild(card);
    body.insertBefore(g, body.firstChild);
    SG = { el: g, card, rows: new Map(), shape: null };
    settingsRender(true);
  });
  let sT = 0;
  // (Settings closed: nothing to draw, it's drawn anew when opened; it was redrawn with every change meanwhile)
  const setOpen = () => { const e = document.getElementById('settings'); return !!e && !e.hidden && !e.classList.contains('closing'); };
  function settingsSoon(ms) { if (!sT && SG && SG.el.isConnected && setOpen()) sT = setTimeout(() => { sT = 0; settingsRender(); }, ms || 30); }

  // As on the page, a row is made again only when what it is changes, the others stay (a transfer that started rebuilt
  // them all, and the keyboard on a Cancel dropped to the start of the page). opening: Settings is being drawn to open
  function settingsRender(opening) {
    if (!SG || !SG.el.isConnected || (!opening && !setOpen())) return;
    const list = M.now.slice(0, SHOW), more = M.now.length - list.length;
    const sh = (m) => m.state + (m.cancel ? '+' : '') + (stopping.has(m.key) ? '-' : '');
    const key = list.map((m) => m.key + ' ' + sh(m)).join('|');
    const figures = () => { for (const m of list) { const r = SG.rows.get(m.key); if (r && r._shape === sh(m)) sUpdate(r, m); } };
    if (!SG.all) {
      SG.all = h('button', 'srow nav fmvall');
      const l = h('div', 'sl');
      l.appendChild(h('b', '', 'See all transfers'));
      SG.more = h('small');
      l.appendChild(SG.more);
      SG.all.appendChild(l);
      SG.all.onclick = () => { A.haptic('soft'); open(); };
      const r = h('div', 'srow fmvnone');
      r.setAttribute('role', 'listitem');
      const n = h('div', 'sl');
      n.appendChild(h('b', '', 'Nothing moving right now'));
      r.appendChild(n);
      SG.none = r;
    }
    // (nothing moving and nothing lately: no section at all, Settings stays short; it comes with the first transfer)
    const quiet = !list.length && !recent().length;
    if (SG.el.hidden !== quiet) SG.el.hidden = quiet;
    const mt = more > 0 ? (more === 1 ? '1 more' : A.fmtNum(more) + ' more') + ' moving' : '';
    if (SG.more.textContent !== mt) SG.more.textContent = mt;
    SG.more.hidden = !mt;
    if (key === SG.shape) { figures(); return; }
    if (SG.shape !== null && fingerOn(SG.card)) { figures(); settingsSoon(150); return; }
    SG.shape = key;
    const act = document.activeElement, at = act && SG.card.contains(act) ? act.closest('[data-rk]') : null;
    const els = list.map((m) => {
      let r = SG.rows.get(m.key);
      if (r && r._shape === sh(m)) { sUpdate(r, m); return r; }
      r = sRow(m);
      r._shape = sh(m);
      r.dataset.rk = m.key;
      return r;
    });
    sync(SG.card, (list.length ? els : [SG.none]).concat([SG.all]));
    for (const [k, r] of SG.rows) if (!r.isConnected) SG.rows.delete(k);
    // the keyboard was in a row that went or was made again (Cancel by keyboard): the same row now, or See all
    if (at && !act.isConnected) {
      const r = SG.rows.get(at.dataset.rk), k = act.dataset ? act.dataset.k : '';
      const to = (r && ((k && r.querySelector('[data-k="' + k + '"]')) || r.querySelector('.fmain'))) || SG.all;
      to.focus({ preventScroll: true });
    }
  }

  function sRow(m) {
    const r = h('div', 'frow fmvrow fx' + m.state);
    r.setAttribute('role', 'listitem');
    const main = h('button', 'fmain');
    main.dataset.k = 'main';
    const ic = h('span', 'fic');
    ic.appendChild(A.svgEl(iconOf(m)));
    const tx = h('span', 'ftx');
    // the file's name, and how far it got beside it (after a long device name in the line under it, two lines at most,
    // it was cut off)
    const top = h('span', 'ftop');
    r._name = X.nm('b', '', m.name);
    r._time = h('span', 'ftime');
    top.append(r._name, r._time);
    r._sm = h('small', 'fwrap');
    r._bar = h('span', 'fxbar');
    r._fill = h('i');
    r._bar.appendChild(r._fill);
    tx.append(top, r._sm, r._bar);
    main.append(ic, tx);
    main.onclick = () => { A.haptic('soft'); open(); };          // (the full list: speed, time left, what finished)
    r.appendChild(main);
    if (m.cancel && !stopping.has(m.key)) {
      const c = h('button', 'fmvstop', 'Cancel');
      c.dataset.k = 'stop';
      c.setAttribute('aria-label', 'Cancel ' + m.name);
      c.onclick = () => cancel(r._m);
      r.appendChild(c);
    }
    SG.rows.set(m.key, r);
    sUpdate(r, m);
    return r;
  }

  function sUpdate(r, m) {
    r._m = m;
    if (r._name.textContent !== m.name) r._name.textContent = m.name;
    const f = mvFigure(m);
    if (r._time.textContent !== f) r._time.textContent = f;
    bits(r, mvLine(m, false));
    bar(r, m);
  }
});
