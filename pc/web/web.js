'use strict';
// Flick in a web browser: after the PC allows this device, send files to the PC and get the files it shares.
// Talks only to the page's own origin; the session id travels in a header (X-Flick-Session), never in a cookie.
(function () {
  const $ = (id) => document.getElementById(id);
  const m = /^\/w\/([A-Za-z0-9_-]{22})\/?$/.exec(location.pathname);
  if (!m) return;
  const BASE = '/w/' + m[1] + '/';
  const SK = 'flick-session-' + m[1];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const store = {
    get(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { if (v) sessionStorage.setItem(k, v); else sessionStorage.removeItem(k); } catch (e) { /* private browsing */ } },
  };
  function rand() { const a = new Uint8Array(12); crypto.getRandomValues(a); return Array.from(a, (b) => ('0' + b.toString(16)).slice(-2)).join(''); }
  // identifies this browser while it waits to be allowed (a reloaded page keeps its place); nothing else
  const cid = (function () {
    try { let c = localStorage.getItem('flick-cid'); if (!/^[0-9a-f]{24}$/.test(c || '')) { c = rand(); localStorage.setItem('flick-cid', c); } return c; } catch (e) { return rand(); }
  })();

  let sid = store.get(SK);
  // connecting | pending | busy | ok | denied | expired | removed | gone | ended
  let state = 'connecting';
  let pc = '', device = '', v = 0, where = '', isOffline = false;
  let code = '';   // while asking: the code the PC's prompt shows too
  const P = () => pc || 'the PC';
  const thisDevice = () => (device && device !== 'A browser' ? 'this ' + device : 'this browser');

  function call(path, o) {
    o = o || {};
    const h = {};
    if (sid) h['X-Flick-Session'] = sid;
    if (o.json) h['Content-Type'] = 'application/json';
    return fetch(BASE + 'api/' + path, {
      method: o.method || 'GET', headers: h, body: o.json ? JSON.stringify(o.json) : undefined,
      cache: 'no-store', credentials: 'omit', redirect: 'error', signal: o.signal,
    }).then((r) => r.text().then((t) => {
      let b = null;
      try { b = JSON.parse(t); } catch (e) { /* not JSON */ }
      return { status: r.status, body: b };
    }));
  }

  function svg(d, cls) {
    const NS = 'http://www.w3.org/2000/svg';
    const s = document.createElementNS(NS, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('aria-hidden', 'true');
    if (cls) s.setAttribute('class', cls);
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', d);
    s.appendChild(p);
    return s;
  }

  // ------------------------------------------------------------------ screens
  let denyUntil = 0, denyT = null;
  function denyWait(sec) {
    denyUntil = Date.now() + (sec || 0) * 1000;
    clearInterval(denyT);
    if (sec > 0) denyT = setInterval(() => { if (state !== 'denied' || Date.now() >= denyUntil + 1000) clearInterval(denyT); render(); }, 1000);
  }

  function msg(kind, title, text, btn, shownCode) {
    $('main').hidden = true;
    $('msg').hidden = false;
    $('msg').className = 'msg ' + kind;
    $('msgTitle').textContent = title;
    $('msgCode').hidden = !shownCode;
    $('msgCode').textContent = shownCode || '';
    $('msgText').textContent = text || '';
    const b = $('msgBtn');
    b.hidden = !btn;
    if (btn) { b.textContent = btn.label; b.disabled = !!btn.disabled; b.onclick = btn.run; }
  }

  function render() {
    for (const el of document.querySelectorAll('.pcname')) el.textContent = P();
    document.title = pc ? 'Flick · ' + pc : 'Flick';
    $('dot').classList.toggle('on', state === 'ok' && !isOffline);
    const sub = $('sub');
    $('banner').hidden = !(isOffline && state === 'ok');
    $('banner').textContent = 'Can’t reach ' + P() + '. Trying again…';
    if (isOffline && state !== 'ok' && !/^(denied|expired|removed|gone|ended)$/.test(state)) {
      sub.textContent = 'Not connected';
      return msg('bad', 'Can’t reach ' + P(), 'Make sure ' + thisDevice() + ' is on the same Wi-Fi or network as the PC. Trying again…');
    }
    switch (state) {
      case 'connecting':
        sub.textContent = 'Connecting…';
        return msg('wait', 'Connecting…', '');
      case 'pending':
        sub.textContent = 'Waiting for ' + P();
        if (/^\d{4}$/.test(code)) return msg('wait', 'Waiting for ' + P(), 'On the PC, click Allow only if it shows this code.', null, code);
        return msg('wait', 'Waiting for ' + P(), 'On the PC, click Allow to let ' + thisDevice() + ' send and receive files.');
      case 'busy':
        sub.textContent = 'Waiting for ' + P();
        return msg('wait', P() + ' is busy', 'Another device is asking to connect right now. Trying again in a moment…');
      case 'denied': {
        sub.textContent = 'Not connected';
        const left = Math.ceil((denyUntil - Date.now()) / 1000);
        return msg('bad', P() + ' didn’t allow ' + thisDevice(), left > 0 ? 'You can ask again in ' + left + (left === 1 ? ' second.' : ' seconds.') : 'You can ask again.',
          { label: 'Ask again', disabled: left > 0, run: rejoin });
      }
      case 'expired':
        sub.textContent = 'Not connected';
        return msg('bad', 'No answer from ' + P(), 'Nobody clicked Allow on the PC in time.', { label: 'Ask again', run: rejoin });
      case 'removed':
      case 'gone':
        sub.textContent = 'Not connected';
        return msg('bad', 'Disconnected', state === 'removed' ? P() + ' disconnected ' + thisDevice() + '.' : 'This page lost its connection to ' + P() + '.',
          { label: 'Connect again', run: rejoin });
      case 'ended':
        sub.textContent = 'Not connected';
        return msg('bad', 'Sharing has ended', 'To connect again, open Flick on the PC, choose Share with a browser and scan the new code.');
      case 'ok':
      default:
        sub.textContent = 'Connected to ' + P();
        $('msg').hidden = true;
        $('main').hidden = false;
        $('where').hidden = !where;
        $('where').textContent = where ? 'Files you send go to ' + (where === 'Desktop' ? 'the Desktop' : where) + ' on ' + P() + '.' : '';
    }
  }

  function offline(on) { if (on !== isOffline) { isOffline = on; render(); } }

  // ------------------------------------------------------------------ joining and news from the PC
  let retryT = null;
  async function join() {
    clearTimeout(retryT);
    if (state !== 'busy') { state = 'connecting'; render(); }
    let r;
    try { r = await call('join', { method: 'POST', json: { cid, touch: navigator.maxTouchPoints || 0 } }); } catch (e) { r = null; }
    if (!r) { offline(true); retryT = setTimeout(join, 3000); return; }
    offline(false);
    if (r.status === 404) { state = 'ended'; return render(); }
    const b = r.body || {};
    if (b.pc) pc = b.pc;
    if (b.device) device = b.device;
    if (b.state === 'pending' && b.sid) {
      sid = b.sid; store.set(SK, sid); v = b.v || 0; code = String(b.code || '');
      state = 'pending'; render();
      return poll();
    }
    if (b.state === 'denied') { state = 'denied'; denyWait(b.wait || 0); return render(); }
    // another device is being asked right now (or a hiccup): ask again shortly
    state = 'busy'; render();
    retryT = setTimeout(join, 3000);
  }

  function rejoin() {
    sid = null; store.set(SK, null);
    state = 'connecting';
    join();
  }

  let polling = false, pollCtl = null, again = false;
  async function poll() {
    if (polling) return nudge();
    polling = true;
    let fails = 0, resuming = state === 'connecting';
    while (sid) {
      const ctl = window.AbortController ? new AbortController() : null;
      pollCtl = ctl;
      const guard = setTimeout(() => { if (ctl) ctl.abort(); }, 35000);    // the PC answers within 25 s
      const t0 = Date.now();
      let r = null;
      try { r = await call('poll?v=' + v, { signal: ctl ? ctl.signal : undefined }); } catch (e) { r = null; }
      clearTimeout(guard);
      pollCtl = null;
      if (!r) {
        if (again) { again = false; continue; }               // cut short on purpose: ask right away
        fails++; offline(true);
        await sleep(Math.min(8000, 700 * fails));
        continue;
      }
      fails = 0; again = false; offline(false);
      if (r.status === 404) { sid = null; store.set(SK, null); state = 'ended'; dropQueue(); render(); break; }
      if (r.status === 403 || !r.body) {
        sid = null; store.set(SK, null);
        if (resuming) { polling = false; return join(); }    // an old session from before a reload: ask again
        state = 'gone'; dropQueue(); render(); break;
      }
      resuming = false;
      apply(r.body);
      if (state !== 'pending' && state !== 'ok') { sid = null; store.set(SK, null); break; }
      if (Date.now() - t0 < 250) await sleep(250);
    }
    polling = false;
  }
  // back from the background, the network, or the back button: ask for news now instead of waiting
  function nudge() { if (polling && pollCtl) { again = true; pollCtl.abort(); } }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) nudge(); });
  window.addEventListener('online', nudge);
  window.addEventListener('pageshow', (e) => { if (e.persisted) nudge(); });

  let filesSig = '';
  function apply(b) {
    if (b.pc) pc = b.pc;
    if (b.device) device = b.device;
    if (typeof b.v === 'number') v = b.v;
    state = b.state || 'gone';
    if (state === 'pending' && b.code) code = String(b.code);
    if (state === 'denied') denyWait(b.wait || 0);
    if (state === 'ok') {
      where = b.where || '';
      const files = Array.isArray(b.files) ? b.files : [];
      const sig = JSON.stringify(files.map((f) => [f.id, f.name, f.size]));
      if (sig !== filesSig) { filesSig = sig; renderFiles(files); }
    } else dropQueue();
    render();
  }
  // no longer connected: files still waiting their turn won't go
  function dropQueue() {
    const why = state === 'ended' ? 'Sharing has ended' : 'Not connected';
    for (const it of queue.splice(0)) set(it, 'failed', why);
  }

  // ------------------------------------------------------------------ files from the PC
  function fmt(n) {
    n = +n || 0;
    return n >= 1e9 ? (n / 1e9).toFixed(1) + ' GB' : n >= 1e6 ? (n / 1e6).toFixed(1) + ' MB' : n >= 1e3 ? Math.round(n / 1e3) + ' KB' : n + (n === 1 ? ' byte' : ' bytes');
  }
  function extOf(name) { const x = /\.([A-Za-z0-9]{1,5})$/.exec(name || ''); return x ? x[1] : 'file'; }
  function row(name, size) {
    const li = document.createElement('li');
    li.className = 'item';
    const ico = document.createElement('span'); ico.className = 'ico'; ico.textContent = extOf(name).slice(0, 4);
    const meta = document.createElement('span'); meta.className = 'meta';
    const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = name; nm.title = name;
    const sz = document.createElement('span'); sz.className = 'sz'; sz.textContent = fmt(size);
    meta.appendChild(nm); meta.appendChild(sz);
    li.appendChild(ico); li.appendChild(meta);
    return { li, sz };
  }

  let known = null;
  function renderFiles(files) {
    const ul = $('downs');
    ul.textContent = '';
    for (const f of files) {
      const r = row(f.name, f.size);
      const a = document.createElement('a');
      a.className = 'pill';
      a.href = f.url;
      a.setAttribute('download', f.name);
      a.appendChild(svg('M12 4v12M7 11l5 5 5-5M5 20h14'));
      const t = document.createElement('span'); t.textContent = 'Download'; a.appendChild(t);
      a.setAttribute('aria-label', 'Download ' + f.name);
      r.li.appendChild(a);
      if (known && !known.has(f.id)) r.li.classList.add('new');
      ul.appendChild(r.li);
    }
    known = new Set(files.map((f) => f.id));
    $('downsEmpty').hidden = files.length > 0;
  }

  // ------------------------------------------------------------------ sending files to the PC
  const queue = [];
  let running = 0;
  const AT_ONCE = 2;
  const CHECK = 'M5 12.5l4.5 4.5L19 7.5';

  function addFiles(list) {
    if (state !== 'ok' || !sid) return;
    const files = Array.from(list || []).filter((f) => f && typeof f.size === 'number');
    if (!files.length) return;
    const items = files.map((file) => {
      const r = row(file.name || 'file', file.size);
      const st = document.createElement('span'); st.className = 'st';
      const bar = document.createElement('span'); bar.className = 'bar';
      const fill = document.createElement('i'); bar.appendChild(fill);
      r.li.appendChild(st); r.li.appendChild(bar);
      const it = { file, li: r.li, sz: r.sz, st, fill, state: '', batch: '' };
      set(it, 'waiting');
      return it;
    });
    const frag = document.createDocumentFragment();
    for (const it of items) frag.appendChild(it.li);
    $('ups').insertBefore(frag, $('ups').firstChild);
    startBatch(items);
  }

  async function startBatch(items) {
    let batch = '';
    try {
      const r = await call('batch', { method: 'POST', json: { count: items.length, bytes: items.reduce((n, it) => n + it.file.size, 0) } });
      if (r.status === 507) { for (const it of items) set(it, 'failed', 'Not enough free space on ' + P()); return; }
      if (r.status === 404) { for (const it of items) set(it, 'failed', 'Sharing has ended'); nudge(); return; }
      if (r.body && r.body.batch) batch = r.body.batch;
    } catch (e) { /* each file says for itself what happened */ }
    for (const it of items) { it.batch = batch; queue.push(it); }
    pump();
  }

  function pump() {
    while (running < AT_ONCE && queue.length) {
      const it = queue.shift();
      if (it.state !== 'waiting') continue;
      running++;
      send(it).then(() => { running--; pump(); });
    }
  }

  function send(it) {
    return new Promise((resolve) => {
      set(it, 'sending', 0);
      const x = new XMLHttpRequest();
      x.open('POST', BASE + 'api/upload?batch=' + encodeURIComponent(it.batch) + '&name=' + encodeURIComponent(it.file.name || 'file'));
      x.setRequestHeader('X-Flick-Session', sid || '');
      x.upload.onprogress = (e) => { if (e.lengthComputable && e.total) set(it, 'sending', e.loaded / e.total); };
      x.onload = () => {
        let b = null;
        try { b = JSON.parse(x.responseText); } catch (e) { /* not JSON */ }
        if (x.status === 200 && b && b.ok) set(it, 'done', b);
        else set(it, 'failed', reason(x.status, b));
        resolve();
      };
      x.onerror = () => {
        // the PC may have just stopped sharing: wait a moment for that news so the file says why
        nudge();
        setTimeout(() => { set(it, 'failed', state === 'ok' ? 'Connection lost' : state === 'ended' ? 'Sharing has ended' : 'Not connected'); resolve(); }, 500);
      };
      x.onabort = () => { set(it, 'failed', 'Stopped'); resolve(); };
      x.send(it.file);
    });
  }

  function reason(status, b) {
    const e = b && b.error;
    if (status === 507 || e === 'no space') return 'Not enough free space on ' + P();
    if (status === 404 || status === 410 || e === 'ended') return 'Sharing has ended';
    if (status === 403) return 'Not connected';
    if (e === 'save') return 'Couldn’t save it on ' + P();
    return 'Didn’t go through';
  }

  function set(it, st, x) {
    it.state = st;
    it.li.className = 'item ' + st;
    const size = fmt(it.file.size);
    if (st === 'waiting') {
      it.sz.textContent = size + ' · Waiting';
      it.st.textContent = '';
    } else if (st === 'sending') {
      const p = Math.max(0, Math.min(1, x || 0));
      it.fill.style.transform = 'scaleX(' + p + ')';
      it.sz.textContent = size + ' · ' + (p >= 1 ? 'Saving…' : Math.floor(p * 100) + '%');
      if (!it.st.querySelector('.spin')) { it.st.textContent = ''; const s = document.createElement('span'); s.className = 'spin'; it.st.appendChild(s); }
    } else if (st === 'done') {
      it.sz.textContent = 'Sent' + (x && x.name && x.name !== it.file.name ? ' as ' + x.name : '');
      it.st.textContent = '';
      it.st.appendChild(svg(CHECK));
    } else if (st === 'failed') {
      it.sz.textContent = x || 'Didn’t go through';
      it.st.textContent = '';
      if (state === 'ok' && !/ended|space/.test(x || '')) {
        const b = document.createElement('button');
        b.className = 'pill'; b.type = 'button'; b.textContent = 'Retry';
        b.setAttribute('aria-label', 'Send ' + (it.file.name || 'file') + ' again');
        b.onclick = () => { it.batch = ''; set(it, 'waiting'); queue.push(it); pump(); };
        it.st.appendChild(b);
      }
    }
  }

  $('pick').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
  $('pickBtn').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('pick').click(); } });
  $('pickBtn').tabIndex = 0;
  $('pickBtn').setAttribute('role', 'button');

  // drop files anywhere (computers)
  let depth = 0;
  const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).indexOf('Files') >= 0;
  window.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); if (state !== 'ok') return; depth++; $('drop').hidden = false; });
  window.addEventListener('dragover', (e) => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = state === 'ok' ? 'copy' : 'none'; });
  window.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) $('drop').hidden = true; });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0; $('drop').hidden = true;
    if (state !== 'ok') return;
    // folders can't be sent from a browser: leave them out
    const items = Array.from(e.dataTransfer.items || []);
    const files = Array.from(e.dataTransfer.files || []).filter((f, i) => {
      const en = items[i] && items[i].webkitGetAsEntry && items[i].webkitGetAsEntry();
      return !(en && en.isDirectory);
    });
    addFiles(files);
  });

  window.addEventListener('beforeunload', (e) => { if (running > 0 || queue.length) { e.preventDefault(); e.returnValue = ''; } });

  // ------------------------------------------------------------------ a note or a link
  function grow() { const t = $('note'); t.style.height = 'auto'; t.style.height = Math.min(160, t.scrollHeight + 2) + 'px'; }
  async function sendNote() {
    const text = $('note').value.trim();
    if (!text || state !== 'ok') return;
    $('noteSend').disabled = true;
    $('noteState').textContent = 'Sending…';
    let r = null;
    try { r = await call('text', { method: 'POST', json: { text } }); } catch (e) { r = null; }
    if (r && r.status === 200) { $('note').value = ''; grow(); $('noteState').textContent = 'Sent. It’s in Flick on ' + P() + '.'; }
    else $('noteState').textContent = r ? 'Didn’t go through. Try again.' : 'Can’t reach ' + P() + '. Try again.';
    $('noteSend').disabled = false;
  }
  $('note').addEventListener('input', () => { grow(); $('noteState').textContent = ''; });
  $('note').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); sendNote(); } });
  $('noteSend').addEventListener('click', sendNote);

  render();
  if (sid) poll(); else join();
})();
