'use strict';
// Browse phone (main -> features.js -> browse.js): the phone's photos, videos, downloads, documents and folders in a
// grid with thumbnails; pick files and Copy to PC. The view comes as 'panel:browse' (whole), thumbnails as they arrive as
// 'panel:browse-thumbs', a copy's progress as 'panel:browse-job'; actions go back as 'panel:feat' (b-*).
(function () {
  const api = window.flick;
  const $ = (id) => document.getElementById(id);
  const send = (what, extra) => api.send('panel:feat', Object.assign({ what }, extra || {}));
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const NS = 'http://www.w3.org/2000/svg';
  const svg = (vb, paths, cls) => {
    const s = document.createElementNS(NS, 'svg');
    s.setAttribute('viewBox', vb); s.setAttribute('aria-hidden', 'true');
    if (cls) s.setAttribute('class', cls);
    for (const d of paths) { const p = document.createElementNS(NS, 'path'); p.setAttribute('d', d); s.appendChild(p); }
    return s;
  };
  const FOLDER = ['M3 8.5A2.5 2.5 0 0 1 5.5 6h7.2l2.6 2.6h11.2a2.5 2.5 0 0 1 2.5 2.5v13.4a2.5 2.5 0 0 1-2.5 2.5H5.5A2.5 2.5 0 0 1 3 24.5z'];
  const DOC = ['M9 3.5h10l6 6v17a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2v-21a2 2 0 0 1 2-2z', 'M19 3.5v6h6'];
  const fmt = (n) => (n >= 1e9 ? (n / 1e9).toFixed(1) + ' GB' : n >= 1e6 ? (n / 1e6).toFixed(1) + ' MB' : n >= 1e3 ? Math.round(n / 1e3) + ' KB' : n + ' bytes');
  const dur = (ms) => { const s = Math.round(ms / 1000), m = Math.floor(s / 60); return m >= 60 ? Math.floor(m / 60) + ':' + String(m % 60).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0') : m + ':' + String(s % 60).padStart(2, '0'); };
  const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);
  const EMPTY = { photos: 'No photos', videos: 'No videos', docs: 'No documents', downloads: 'Nothing in Downloads', storage: 'Nothing here', dir: 'This folder is empty' };

  let F = null;               // the phone features' state (the entry on the main view)
  let B = null;               // the view
  let J = null;               // the latest copy
  let open = false;
  let closedJob = '';         // the copy whose result was closed
  const thumbs = new Map();   // path -> data URL
  const tiles = new Map();    // path -> tile element
  const sel = new Map();      // path -> size: the files picked
  let moreAsked = 0;

  // ---------------- the entry on the main view ----------------
  function renderEntry() {
    const t = F && F.target;
    $('bEntry').hidden = !(t && t.feat);
    if (!t) return;
    const several = (F.phones || []).length > 1;
    $('bEntryTitle').textContent = several ? 'Browse ' + t.name : 'Browse your phone';
    $('bEntrySub').textContent = 'See its photos, videos and files, and copy them to this PC.';
  }
  api.on('panel:feat-state', (s) => { F = s; renderEntry(); });

  // ---------------- the view ----------------
  function showView(on) {
    open = !!on;
    $('bView').hidden = !open;
    if (open) { thumbs.clear(); sel.clear(); B = null; render(); send('b-open'); $('bView').focus(); }
    else { send('b-close'); sel.clear(); }
  }
  $('bEntry').onclick = () => showView(true);
  // Back goes up a folder first, then out of the view
  function back() {
    if (B && B.path && B.root && B.path !== B.root && B.crumbs && B.crumbs.length) { send('b-up'); return; }
    showView(false);
  }
  $('bBack').onclick = back;
  $('bRefresh').onclick = () => send('b-refresh');
  for (const b of $('bTabs').querySelectorAll('button')) b.onclick = () => { if (B && B.cat === b.dataset.cat && !(B.crumbs && B.crumbs.length)) return; sel.clear(); send('b-cat', { cat: b.dataset.cat }); };

  function message(title, text, btn) {
    $('bMsg').hidden = false;
    $('bMsgTitle').textContent = title;
    $('bMsgText').textContent = text || '';
    $('bMsgBtn').hidden = !btn;
    if (btn) $('bMsgBtn').textContent = btn;
  }
  $('bMsgBtn').onclick = () => send('b-refresh');

  function render() {
    const v = B;
    const name = (v && v.name) || 'your phone';
    $('bTitle').textContent = v && v.name ? v.name : 'Your phone';
    for (const b of $('bTabs').querySelectorAll('button')) {
      const on = !!v && v.cat === b.dataset.cat;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', String(on));
    }
    renderCrumbs();
    const grid = $('bGrid');
    $('bMsg').hidden = true;
    $('bMore').hidden = true;
    if (!v || v.status === 'loading') { skeleton(); renderBar(); return; }
    const st = v.status;
    if (st !== 'ready') {
      grid.textContent = ''; tiles.clear();
      if (st === 'none') message('No phone connected', 'Open Flick on your phone, or turn on “Stay connected in the background” there.', 'Try again');
      else if (st === 'old') message('Update Flick on ' + name, 'Then you can browse it from here.');
      else if (st === 'off') message('Browsing is off on ' + name, 'On your phone, open Flick, go to Settings and turn on “Let your PC browse this phone”.', 'Try again');
      else if (st === 'storage') message(name + ' needs to allow access to its files', 'Open Flick on your phone and allow it to see your files.', 'Try again');
      else if (st === 'noanswer') message(name + ' didn’t answer', 'Make sure Flick on your phone is up to date, then try again.', 'Try again');
      else if (st === 'unreachable') message(name + ' isn’t reachable', 'Open Flick on it, or turn on “Stay connected in the background” there.', 'Try again');
      else if (st === 'busy' || st === 'slow') message(name + ' is busy', 'Wait a moment, then try again.', 'Try again');
      else if (st === 'notfound') message('That folder isn’t there any more', 'It may have been moved or deleted on your phone.', 'Try again');
      else message('Something went wrong', 'Try again in a moment.', 'Try again');
      renderBar();
      return;
    }
    if (!v.items.length) {
      grid.textContent = ''; tiles.clear();
      message(EMPTY[v.crumbs && v.crumbs.length ? 'dir' : v.cat] || 'Nothing here', '');
      renderBar();
      return;
    }
    grid.textContent = '';
    tiles.clear();
    for (const x of v.items) grid.appendChild(tile(x));
    // drop picks that this listing no longer shows
    for (const p of [...sel.keys()]) if (!v.items.some((x) => x.path === p)) sel.delete(p);
    $('bMore').hidden = !(v.more && v.loading);
    renderBar();
    moreAsked = 0;
    maybeMore();
  }

  function skeleton() {
    const grid = $('bGrid');
    grid.textContent = ''; tiles.clear();
    for (let i = 0; i < 9; i++) { const t = el('div', 'btile bskel'); t.appendChild(el('span', 'bth')); t.appendChild(el('span', 'bname')); grid.appendChild(t); }
  }

  function renderCrumbs() {
    const c = $('bCrumbs');
    const v = B;
    const has = !!(v && v.root && (v.cat === 'downloads' || v.cat === 'storage'));
    c.hidden = !has;
    if (!has) return;
    c.textContent = '';
    const parts = [{ name: v.cat === 'downloads' ? 'Downloads' : (v.rootName || 'Phone storage'), path: v.root }].concat(v.crumbs || []);
    parts.forEach((p, i) => {
      if (i) c.appendChild(svg('0 0 16 16', ['M6 3.5L10.5 8 6 12.5'], 'bsep'));
      const last = i === parts.length - 1;
      const b = el('button', 'bcrumb' + (last ? ' on' : ''), p.name);
      b.type = 'button';
      if (last) b.setAttribute('aria-current', 'location');
      else b.onclick = () => send('b-dir', { path: p.path });
      c.appendChild(b);
    });
    c.scrollLeft = c.scrollWidth;
  }

  function tile(x) {
    const t = el('button', 'btile' + (x.dir ? ' dir' : ''));
    t.type = 'button';
    t.title = x.name;
    const th = el('span', 'bth');
    if (x.dir) {
      th.appendChild(svg('0 0 32 32', FOLDER, 'bfolder'));
      t.setAttribute('aria-label', 'Folder ' + x.name + ', ' + plural(x.count || 0, 'item', 'items'));
      t.onclick = () => send('b-dir', { path: x.path });
    } else {
      t.setAttribute('role', 'option');
      const url = thumbs.get(x.path);
      if (url) th.appendChild(img(url));
      else th.appendChild(docIcon(x));
      if (x.kind === 'video') {
        th.appendChild(svg('0 0 16 16', ['M5.5 4v8l6.5-4z'], 'bplay'));
        if (x.dur) th.appendChild(el('span', 'bdur', dur(x.dur)));
      }
      th.appendChild(el('i', 'bcheck'));
      t.onclick = () => toggle(x, t);
      t.classList.toggle('sel', sel.has(x.path));
      t.setAttribute('aria-selected', String(sel.has(x.path)));
      tiles.set(x.path, t);
    }
    t.appendChild(th);
    t.appendChild(el('span', 'bname', x.name));
    t.appendChild(el('span', 'bmeta', x.dir ? plural(x.count || 0, 'item', 'items') : fmt(x.size || 0)));
    return t;
  }

  function img(url) { const i = el('img'); i.alt = ''; i.decoding = 'async'; i.src = url; return i; }

  function docIcon(x) {
    const w = el('span', 'bdoc');
    w.appendChild(svg('0 0 32 32', DOC));
    const ext = (x.ext || '').toUpperCase().slice(0, 4);
    if (ext && x.kind !== 'image' && x.kind !== 'video') w.appendChild(el('span', 'bext', ext));
    return w;
  }

  function toggle(x, t) {
    if (sel.has(x.path)) sel.delete(x.path); else sel.set(x.path, x.size || 0);
    t.classList.toggle('sel', sel.has(x.path));
    t.setAttribute('aria-selected', String(sel.has(x.path)));
    renderBar();
  }

  // the bottom: the picks and Copy to PC, or the copy under way and how it went
  function renderBar() {
    const running = !!(J && J.state === 'running');
    const showJob = !!(J && (running || J.id !== closedJob));
    $('bJob').hidden = !showJob;
    $('bBar').hidden = showJob || !sel.size || !open;
    if (showJob) renderJob();
    if (!$('bBar').hidden) {
      let bytes = 0;
      for (const s of sel.values()) bytes += s;
      $('bSelText').textContent = plural(sel.size, 'file', 'files') + ' selected · ' + fmt(bytes);
      $('bCopy').disabled = running;
    }
    $('bView').classList.toggle('hasbar', !$('bBar').hidden || showJob);
  }

  function renderJob() {
    const j = J;
    const name = j.deviceName || 'your phone';
    const pct = j.bytes ? Math.min(100, Math.round((j.doneBytes / j.bytes) * 100)) : Math.round((j.done / Math.max(1, j.n)) * 100);
    let title = '', sub = '';
    $('bJob').classList.toggle('bad', ['failed', 'off', 'busy', 'noanswer', 'stalled', 'storage'].includes(j.state));
    if (j.state === 'running') {
      title = 'Copying ' + Math.min(j.done + 1, j.n) + ' of ' + j.n;
      sub = j.current || 'From ' + name;
    } else if (j.state === 'done') {
      title = j.done === 1 && j.last ? 'Copied ' + base(j.last) : 'Copied ' + plural(j.done, 'file', 'files');
      sub = 'Saved to ' + (j.where || 'your folder') + (j.bad ? ' · ' + plural(j.bad, 'file', 'files') + ' couldn’t be copied' : '');
    } else if (j.state === 'stopped') {
      title = 'Stopped';
      sub = j.done + ' of ' + j.n + ' copied';
    } else {
      title = 'Couldn’t copy the files';
      sub = j.state === 'off' ? 'Browsing was turned off on ' + name + '.'
        : j.state === 'busy' ? name + ' is busy. Try again in a moment.'
          : j.state === 'noanswer' ? name + ' didn’t answer.'
            : j.state === 'stalled' ? 'The copy stopped moving. Check the connection and try again.'
              : j.state === 'storage' ? name + ' needs to allow access to its files.' : 'Try again.';
      if (j.done) sub = j.done + ' of ' + j.n + ' copied. ' + sub;
    }
    $('bJobTitle').textContent = title;
    $('bJobSub').textContent = sub;
    $('bJobBar').style.width = (j.state === 'running' ? pct : j.state === 'done' ? 100 : pct) + '%';
    $('bJob').querySelector('.bjbar').hidden = j.state !== 'running';
    $('bJobStop').hidden = j.state !== 'running';
    $('bJobShow').hidden = j.state === 'running' || !j.done;
    $('bJobClose').hidden = j.state === 'running';
  }
  const base = (p) => String(p).split(/[\\/]/).pop();

  $('bSelClear').onclick = () => { sel.clear(); for (const t of tiles.values()) { t.classList.remove('sel'); t.setAttribute('aria-selected', 'false'); } renderBar(); };
  $('bCopy').onclick = () => {
    if (!sel.size) return;
    send('b-copy', { paths: [...sel.keys()] });
    sel.clear();
    for (const t of tiles.values()) { t.classList.remove('sel'); t.setAttribute('aria-selected', 'false'); }
    closedJob = '';
    renderBar();
  };
  $('bJobStop').onclick = () => send('b-stop');
  $('bJobShow').onclick = () => send('b-show');
  $('bJobClose').onclick = () => { if (J) closedJob = J.id; renderBar(); };

  // more of a long list as it scrolls into view
  function maybeMore() {
    const v = B, body = $('bBody');
    if (!open || !v || !v.more || v.loading || Date.now() - moreAsked < 1500) return;
    if (body.scrollTop + body.clientHeight > body.scrollHeight - 400) { moreAsked = Date.now(); $('bMore').hidden = false; send('b-more'); }
  }
  $('bBody').addEventListener('scroll', maybeMore, { passive: true });

  api.on('panel:browse', (s) => {
    if (!s) return;
    if (s.job) J = s.job;
    if (!s.open) { renderBar(); return; }
    if (B && (B.device !== s.device || B.cat !== s.cat || B.path !== s.path)) { sel.clear(); $('bBody').scrollTop = 0; }
    for (const [p, url] of Object.entries(s.thumbs || {})) thumbs.set(p, url);
    B = s;
    if (open) render();
  });
  api.on('panel:browse-thumbs', (m) => {
    if (!m || !B || m.device !== B.device) return;
    for (const [p, url] of Object.entries(m.thumbs || {})) {
      thumbs.set(p, url);
      const t = tiles.get(p);
      const th = t && t.querySelector('.bth');
      if (!th) continue;
      const old = th.querySelector('.bdoc, img');
      const i = img(url);
      if (old) th.replaceChild(i, old); else th.insertBefore(i, th.firstChild);
    }
  });
  api.on('panel:browse-job', (j) => { J = j; renderBar(); });

  // Escape: up a folder, then out of the view (before panel.js would hide the window)
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !open || !$('askBox').hidden) return;
    e.stopImmediatePropagation();
    back();
  }, true);
})();
