'use strict';
// Share with a browser: the panel's side of webshare.js (start/stop, the QR code, who joined, files for browsers,
// notes from browsers, and the "Let <device> send and receive files?" prompt). State comes from main as 'panel:web'.
(function () {
  const api = window.flick;
  const $ = (id) => document.getElementById(id);
  const send = (what, extra) => api.send('panel:web', Object.assign({ what }, extra || {}));
  let W = null;            // the latest state from main
  let open = false;        // the share view is showing
  let starting = false;
  let askId = null;
  const answered = new Set();
  let flashText = null;

  const fmt = (n) => (n >= 1e9 ? (n / 1e9).toFixed(1) + ' GB' : n >= 1e6 ? (n / 1e6).toFixed(1) + ' MB' : n >= 1e3 ? Math.round(n / 1e3) + ' KB' : n + ' bytes');
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const X_ICON = '<svg viewBox="0 0 12 12"><path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
  const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);
  const article = (d) => (d === 'A browser' ? 'a browser' : d);

  function showView(on) {
    open = !!on;
    $('webView').hidden = !open;
    if (open) $('webView').focus();            // keyboard focus moves into the view (Tab reaches Back first)
  }

  function renderQr(qr) {
    const box = $('webQr');
    box.textContent = '';
    box.classList.toggle('blank', !qr);
    if (!qr) return;
    // whole pixels per module keep the code sharp on screen
    const px = Math.max(1, Math.floor(248 / qr.n)) * qr.n;
    const NS = 'http://www.w3.org/2000/svg';
    const s = document.createElementNS(NS, 'svg');
    s.setAttribute('viewBox', '0 0 ' + qr.n + ' ' + qr.n);
    s.setAttribute('width', px); s.setAttribute('height', px);
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', qr.d);
    s.appendChild(p);
    box.appendChild(s);
  }

  function render() {
    const w = W || { on: false, browsers: [], files: [], texts: [], addrs: [] };
    // the entry on the main view
    const live = w.browsers.filter((b) => b.state === 'ok').length;
    $('webEntryDot').hidden = !w.on;
    $('webEntryTitle').textContent = w.on ? 'Sharing with browsers' : 'Share with a browser';
    $('webEntrySub').textContent = w.on
      ? (live ? plural(live, 'browser', 'browsers') + ' connected' : 'Waiting for a browser to scan the code') + (w.files.length ? ' · ' + plural(w.files.length, 'file', 'files') + ' shared' : '')
      : 'Send and receive files with an iPhone, iPad, Mac or any computer. No app needed.';
    if (w.on) starting = false;

    // the share view
    const showOn = w.on || starting;
    $('webOn').hidden = !showOn;
    $('webOff').hidden = showOn;
    if (!showOn) {
      $('webOffTitle').textContent = w.ended === 'idle' ? 'Sharing stopped by itself' : 'Sharing has stopped';
      $('webOffText').textContent = w.ended === 'idle'
        ? 'No browser did anything for ' + (w.idleMin || 30) + ' minutes, so the link stopped working. Share again for a new code.'
        : 'The link and the QR code no longer work, and every browser was disconnected. Share again for a new code.';
      return;
    }
    renderQr(w.qr);
    $('webUrl').textContent = w.url || (w.on ? 'No network. Connect this PC to Wi-Fi or a network cable.' : '');
    $('webCopy').hidden = !w.url;
    const net = $('webNet');
    $('webNetRow').hidden = !(w.addrs && w.addrs.length > 1);
    if (!$('webNetRow').hidden && document.activeElement !== net) {
      net.textContent = '';
      for (const a of w.addrs) { const o = el('option', null, a.label + ' · ' + a.address); o.value = a.address; net.appendChild(o); }
      net.value = w.addr || '';
    }

    // browsers that joined
    const bl = $('webBrowsers');
    bl.textContent = '';
    if (!w.browsers.length) bl.appendChild(el('div', 'wempty', 'No browsers yet. When someone scans the code, you’ll be asked to allow their device here.'));
    for (const b of w.browsers) {
      const row = el('div', 'wrow');
      const main = el('div', 'wmain');
      const nm = el('div', 'wname');
      nm.appendChild(el('span', null, b.device));
      const st = b.state === 'ok' ? (b.away ? ['Away', ''] : ['Connected', 'ok']) : b.state === 'pending' ? ['Waiting for you', 'wait'] : ['Not allowed', 'no'];
      nm.appendChild(el('span', 'wtag ' + st[1], st[0]));
      main.appendChild(nm);
      const act = [];
      if (b.sending) act.push('sending ' + plural(b.sending, 'file', 'files'));
      if (b.getting) act.push('downloading');
      main.appendChild(el('div', 'd', b.address + (act.length ? ' · ' + act.join(', ') : '')));
      row.appendChild(main);
      if (b.state === 'ok') {
        const k = el('button', 'link danger', 'Disconnect');
        k.type = 'button';
        k.onclick = () => send('kick', { id: b.id });
        row.appendChild(k);
      } else if (b.state === 'pending' && b.id !== askId) {
        const a = el('button', 'link', 'Answer');
        a.type = 'button';
        a.onclick = () => ask({ id: b.id, device: b.device, address: b.address });
        row.appendChild(a);
      }
      bl.appendChild(row);
    }

    // files for browsers
    const fl = $('webFiles');
    fl.textContent = '';
    if (!w.files.length) fl.appendChild(el('div', 'wempty', 'Add files, or drop them on this window, and every allowed browser can download them.'));
    for (const f of w.files) {
      const row = el('div', 'wrow');
      const main = el('div', 'wmain');
      const nm = el('div', 'wname'); nm.appendChild(el('span', null, f.name)); nm.title = f.name;
      main.appendChild(nm);
      main.appendChild(el('div', 'd', fmt(f.size || 0)));
      row.appendChild(main);
      const x = el('button', 'wx');
      x.type = 'button'; x.title = 'Stop sharing this file'; x.setAttribute('aria-label', 'Stop sharing ' + f.name);
      x.innerHTML = X_ICON;
      x.onclick = () => send('remove', { id: f.id });
      row.appendChild(x);
      fl.appendChild(row);
    }

    // notes and links from browsers
    $('webTextsBox').hidden = !w.texts.length;
    const tl = $('webTexts');
    tl.textContent = '';
    let flashed = false;
    for (const t of w.texts) {
      const row = el('div', 'wrow wtext');
      if (t.id === flashText) { row.classList.add('flash'); flashed = true; }
      const main = el('div', 'wmain');
      main.appendChild(el('div', 'wnote', t.text));
      main.appendChild(el('div', 'd', 'From ' + article(t.from) + ' · ' + new Date(t.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })));
      row.appendChild(main);
      const btns = el('div', 'wtextbtns');
      const c = el('button', 'link', 'Copy');
      c.type = 'button';
      c.onclick = () => { send('copy', { text: t.id }); c.textContent = 'Copied'; setTimeout(() => { c.textContent = 'Copy'; }, 1500); };
      btns.appendChild(c);
      const x = el('button', 'wx');
      x.type = 'button'; x.title = 'Remove'; x.setAttribute('aria-label', 'Remove this note');
      x.innerHTML = X_ICON;
      x.onclick = () => send('drop-text', { id: t.id });
      btns.appendChild(x);
      row.appendChild(btns);
      tl.appendChild(row);
    }
    if (flashed) flashText = null;            // the note may arrive just after the news of it
    $('webFirewall').hidden = !w.isWin;
    $('webSmall').textContent = 'Browsers connect without encryption, so allow only devices you recognize. Sharing stops by itself after ' +
      (w.idleMin || 30) + ' minutes without activity.';
  }

  // ---- the prompt: "Let iPhone send and receive files?"
  // Anyone who saw the link can ask, so the prompt shows the code the asking browser shows: allow only the device in
  // your hand. Focus starts on "Don't allow", and Allow ignores clicks for a moment, so a keystroke or click meant
  // for something else can't accept it.
  let askedAt = 0;
  function ask(a) {
    askId = a.id;
    askedAt = Date.now();
    $('webAskTitle').textContent = 'Let ' + article(a.device || 'A browser') + ' send and receive files?';
    const sub = $('webAskSub');
    sub.textContent = '';
    if (/^\d{4}$/.test(String(a.code || ''))) {
      const b = document.createElement('b');
      b.className = 'pin';
      b.textContent = a.code;
      sub.append('Code ', b, '. Allow only if the browser in front of you shows the same code.');
    } else {
      sub.textContent = 'A browser at ' + (a.address || 'an unknown address') + ' opened your sharing link. Allow only a device you recognize.';
    }
    $('webAsk').hidden = false;
    $('webDeny').focus();
    render();
  }
  function answer(allow) {
    if (allow && Date.now() - askedAt < 1000) return;
    if (askId) { answered.add(askId); send('answer', { id: askId, allow }); }
    $('webAsk').hidden = true;
    askId = null;
  }
  api.on('panel:web-ask', ask);
  api.on('panel:web-ask-done', (m) => { if (!m || m.id === askId) { $('webAsk').hidden = true; askId = null; render(); } });
  $('webAllow').onclick = () => answer(true);
  $('webDeny').onclick = () => answer(false);

  api.on('panel:web', (w) => {
    W = w;
    if (w.asking && w.asking.id !== askId && !answered.has(w.asking.id) && $('webAsk').hidden) ask(w.asking);
    render();
  });
  api.on('panel:web-text', (m) => { flashText = m && m.id; showView(true); render(); });

  $('webEntry').onclick = () => {
    if (!W || !W.on) { starting = true; send('start'); }
    showView(true);
    render();
  };
  $('webBack').onclick = () => showView(false);
  $('webStop').onclick = () => send('stop');
  $('webAgain').onclick = () => { starting = true; send('start'); render(); };
  $('webAdd').onclick = () => send('pick');
  $('webCopy').onclick = () => { send('copy', { url: true }); $('webCopy').textContent = 'Copied'; setTimeout(() => { $('webCopy').textContent = 'Copy'; }, 1500); };
  $('webNet').onchange = (e) => send('addr', { addr: e.target.value });
  $('webFirewall').onclick = () => api.send('panel:action', { what: 'fixFirewall' });

  // While the share view is open, files dropped on the window are shared with browsers (not sent to the phone), and
  // Escape goes back instead of hiding the window. These run before panel.js's own handlers and stop them.
  let depth = 0;
  const hasFiles = (e) => e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files');
  const sharing = () => !!(W && W.on);
  window.addEventListener('dragenter', (e) => { if (!open || !hasFiles(e)) return; e.preventDefault(); e.stopImmediatePropagation(); depth++; $('webDrop').hidden = !sharing(); }, true);
  window.addEventListener('dragover', (e) => { if (!open || !hasFiles(e)) return; e.preventDefault(); e.stopImmediatePropagation(); e.dataTransfer.dropEffect = sharing() ? 'copy' : 'none'; }, true);
  window.addEventListener('dragleave', (e) => { if (!open) return; e.stopImmediatePropagation(); depth = Math.max(0, depth - 1); if (!depth) $('webDrop').hidden = true; }, true);
  window.addEventListener('drop', (e) => {
    if (!open || !hasFiles(e)) return;
    e.preventDefault(); e.stopImmediatePropagation();
    depth = 0; $('webDrop').hidden = true;
    if (!sharing()) return;
    const paths = [...e.dataTransfer.files].map((f) => api.pathFor(f)).filter(Boolean);
    if (paths.length) send('add', { paths });
  }, true);
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('webAsk').hidden) { e.stopImmediatePropagation(); return; }    // answer the question with a button
    if (open) { e.stopImmediatePropagation(); showView(false); }
  }, true);

  send('hello');
})();
