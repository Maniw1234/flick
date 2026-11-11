'use strict';
// The phone features in the panel (main.js -> features.js): the phones the PC can reach and which one gets what it sends, "Find
// my phone", the link field, History (Open, Show in folder, Send again, Remove, Clear), synced folders and the phone
// feature settings. State comes from main as 'panel:feat-state' and 'panel:feat-history'; actions go back as 'panel:feat'.
(function () {
  const api = window.flick;
  const $ = (id) => document.getElementById(id);
  const send = (what, extra) => api.send('panel:feat', Object.assign({ what }, extra || {}));
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const svg = (paths, cls) => {
    const NS = 'http://www.w3.org/2000/svg';
    const s = document.createElementNS(NS, 'svg');
    s.setAttribute('viewBox', '0 0 16 16'); s.setAttribute('aria-hidden', 'true');
    if (cls) s.setAttribute('class', cls);
    for (const d of paths) { const p = document.createElementNS(NS, 'path'); p.setAttribute('d', d); s.appendChild(p); }
    return s;
  };
  const ICON = {
    phone: ['M5.5 1.75h5a1 1 0 0 1 1 1v10.5a1 1 0 0 1-1 1h-5a1 1 0 0 1-1-1V2.75a1 1 0 0 1 1-1z', 'M7 12.25h2'],
    ring: ['M8 2.25a3.75 3.75 0 0 0-3.75 3.75v2.5L3 11h10l-1.25-2.5V6A3.75 3.75 0 0 0 8 2.25z', 'M6.5 13.25a1.5 1.5 0 0 0 3 0'],
    in: ['M11.5 4.5l-7 7', 'M4.5 6.5v5h5'],
    out: ['M4.5 11.5l7-7', 'M6.5 4.5h5v5'],
    bad: ['M8 4.5v4.25', 'M8 11.25v.25'],
    folder: ['M1.75 4.25a1 1 0 0 1 1-1h3.5l1.5 1.5h5.5a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1H2.75a1 1 0 0 1-1-1z'],
    send: ['M14 2L7 9', 'M14 2l-4.5 12L7 9 2 6.5z'],
    x: ['M4 4l8 8M12 4l-8 8'],
  };
  const VIA = { wifi: 'Wi-Fi', usb: 'USB cable', hotspot: 'hotspot', direct: 'a direct link', ethernet: 'Ethernet', bluetooth: 'Bluetooth' };
  const fmt = (n) => (n >= 1e9 ? (n / 1e9).toFixed(1) + ' GB' : n >= 1e6 ? (n / 1e6).toFixed(1) + ' MB' : n >= 1e3 ? Math.round(n / 1e3) + ' KB' : n + ' bytes');
  // (the time of day; clock.as(t, 'short' / 'long'): a date. One formatter of each kind, kept: toLocaleTimeString with options
  // makes a new one each call, about 100 times slower, and History shows 200 times. A formatter keeps the time zone and
  // languages it was made in, so they're made again when the computer's change: looked at once per History redraw and at
  // most once a second otherwise, by the zone a date's own words name (no formatter made to look); clock.gen counts the changes)
  const clock = (t) => clock.as(t, 'clock'); clock.gen = 0; clock.check = () => { const d = new Date(), y = d.getFullYear(), z = String(d).slice(String(d).indexOf('GMT')) + '|' + new Date(y, 0, 1).getTimezoneOffset() + '|' + new Date(y, 6, 1).getTimezoneOffset() + '|' + (typeof navigator === 'object' ? String(navigator.languages || navigator.language) : ''); if (z !== clock.z) { clock.z = z; clock.f = null; clock.gen++; } clock.at = Date.now(); return clock.gen; }; clock.as = (t, k) => { if (!(Date.now() - clock.at < 1000)) clock.check(); const d = new Date(t), f = clock.f || (clock.f = {}); return isNaN(d) ? String(d) : (f[k] || (f[k] = new Intl.DateTimeFormat([], { clock: { hour: 'numeric', minute: '2-digit' }, short: { day: 'numeric', month: 'short' }, long: { weekday: 'long', day: 'numeric', month: 'long' } }[k]))).format(d); };
  const dayStart = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
  // (a time ahead of this PC's clock, from while it was set wrong, shows as what it is, not "just now"; no time: nothing)
  function ago(t) {
    if (!Number.isFinite(t) || t <= 0) return '';
    const s = (Date.now() - t) / 1000;
    if (s < -60) return t < dayStart(Date.now()) + 86400000 ? 'at ' + clock(t) : clock.as(t, 'short');
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + ' min ago';
    if (t >= dayStart(Date.now())) return 'at ' + clock(t);
    if (t >= dayStart(Date.now()) - 86400000) return 'yesterday';
    return clock.as(t, 'short');
  }
  function dayLabel(t) {
    if (!Number.isFinite(t) || t <= 0) return 'Earlier';
    const today = dayStart(Date.now());
    if (t >= today + 86400000) return clock.as(t, 'long');
    if (t >= today) return 'Today';
    if (t >= today - 86400000) return 'Yesterday';
    return clock.as(t, 'long');
  }
  const HOW = { auto: 'auto', share: 'shared', quickshare: 'Quick Share', browser: 'browser', sync: 'sync', pull: 'Browse phone' };
  const WHY = { declined: 'Declined', timeout: 'Not accepted in time', save: 'Couldn’t be saved', space: 'Couldn’t be saved: not enough space', quit: 'Flick was closed before it finished' };

  let F = null;            // the latest state
  let H = { items: [], total: 0 };
  let histOpen = false;
  let clearArmed = 0;

  // ---------- phones, the link field ----------
  // (drawn again with each news from main: the keyboard stays on the control it was on, as in History: keepFocus)
  function renderPhones() { keepFocus($('fPhones'), drawPhones); }
  function drawPhones() {
    const list = F.phones || [];
    const pages = list.filter((p) => p.page);
    const pc = F.pcTarget;                    // Send to another computer: links go there
    const phonesShown = list.length > 1 || list.some((p) => p.feat);
    $('fPhonesBox').hidden = !(phonesShown || pc);
    $('fPhonesTitle').textContent = !phonesShown ? 'Links' : list.length > 1 ? 'Phones' : 'Your phone';
    const box = $('fPhones');
    box.textContent = '';
    const choose = pages.length > 1;          // which one gets what this PC sends: a choice once there are several
    if (choose) { box.setAttribute('role', 'radiogroup'); box.setAttribute('aria-label', 'Send to'); } else { box.removeAttribute('role'); box.removeAttribute('aria-label'); }
    for (const p of list) {
      const row = el('div', 'fph');
      row.dataset.id = p.device;
      if (choose && p.page) {
        const r = el('button', 'fradio');
        r.type = 'button';
        r.dataset.k = 'use';
        r.setAttribute('role', 'radio');
        r.setAttribute('aria-checked', String(!!p.active));
        r.setAttribute('aria-label', 'Send to ' + p.name);
        r.title = 'Send to this phone';
        r.onclick = (e) => { e.stopPropagation(); if (!p.active) send('use', { device: p.device }); };
        row.appendChild(r);
        row.classList.add('pick');
        row.onclick = () => { if (!p.active) send('use', { device: p.device }); };
      } else row.appendChild(svg(ICON.phone, 'fphico'));
      const main = el('div', 'fmain');
      const nm = el('div', 'fname');
      nm.appendChild(el('span', null, p.name));
      main.appendChild(nm);
      const via = VIA[p.via] ? 'over ' + VIA[p.via] : '';
      const sub = !p.page ? 'Connected in the background'
        : choose && p.active ? 'Files go here' + (via ? ' · ' + VIA[p.via] : '')
          : 'Connected' + (via ? ' ' + via : '');
      main.appendChild(el('div', 'd', sub));
      row.appendChild(main);
      if (p.feat) {
        const ringing = F.ringing && F.ringing.device === p.device;
        const b = el('button', 'btn ghost fbtn');
        b.type = 'button';
        b.dataset.k = 'ring';
        b.appendChild(svg(ICON.ring));
        b.appendChild(el('span', null, ringing ? 'Ringing…' : 'Find my phone'));
        // (while it rings it can't be pressed again, but it keeps the keyboard: a disabled button would drop it, and
        // Stop's answer gives it back here)
        b.setAttribute('aria-disabled', ringing ? 'true' : 'false');
        b.setAttribute('aria-label', 'Find ' + p.name + ': make it ring');
        b.onclick = (e) => { e.stopPropagation(); if (!ringing) send('ring', { device: p.device }); };
        row.appendChild(b);
      }
      box.appendChild(row);
    }
    const t = F.target;
    const linkOk = !!(pc || (t && t.feat));
    $('fLinkForm').hidden = !linkOk || $('fPhonesBox').hidden;
    if (linkOk) {
      const to = pc ? pc.name : list.length > 1 ? t.name : 'your phone';
      $('fLink').placeholder = 'Send a link to ' + to;
      $('fLink').setAttribute('aria-label', 'Send a link to ' + to);
    }
    // with several phones connected, the big button says which one gets the files
    const active = pages.find((p) => p.active);
    const sl = window.flickSendLabel = window.flickSendLabel || {};      // (panel.js writes the computer picked)
    sl.phone = choose && active ? active.name : null;
    $('sendFiles').textContent = sl.pc ? 'Send files to \u2068' + sl.pc + '\u2069' : sl.phone ? 'Send files to \u2068' + sl.phone + '\u2069' : 'Send files to phone';
  }

  $('fLinkForm').onsubmit = (e) => {
    e.preventDefault();
    const v = $('fLink').value.trim();
    if (!v) { $('fLink').focus(); return; }
    send('link', { url: v });
    $('fLink').value = '';
  };

  // ---------- synced folders, settings ----------
  function renderPairs() { keepFocus($('fPairs'), drawPairs); }
  function drawPairs() {
    const pairs = F.pairs || [];
    $('fPairsBox').hidden = !pairs.length;
    const box = $('fPairs');
    box.textContent = '';
    for (const p of pairs) {
      const row = el('div', 'fpair');
      row.dataset.id = p.id;
      const main = el('div', 'fmain');
      main.appendChild(el('div', 'fname', p.name));
      main.appendChild(el('div', 'd', p.phone + ' · ' + (ago(p.last) ? 'synced ' + ago(p.last) : 'not synced yet')));
      main.title = p.folder;
      row.appendChild(main);
      const btns = el('div', 'fbtns');
      const o = el('button', 'link', 'Open folder'); o.type = 'button'; o.dataset.k = 'open'; o.onclick = () => send('pair-open', { id: p.id });
      const x = el('button', 'link danger', 'Stop syncing'); x.type = 'button'; x.dataset.k = 'stop';
      x.title = 'The files stay on this PC and on the phone';
      x.onclick = () => send('pair-stop', { id: p.id });
      btns.appendChild(o); btns.appendChild(x);
      row.appendChild(btns);
      box.appendChild(row);
    }
  }

  // A switch shows what it was last clicked to until main has taken that click, as the window's other switches do
  // (panel.js set): each change is numbered, and a state says the number of the last one main took (setN)
  let sets = 0;
  const unsure = new Map();          // 'clipSync', 'mute:<app>'... -> { n, on }: its last change, until main took it
  function change(k, on, what, extra) { unsure.set(k, { n: ++sets, on }); send(what, Object.assign({ n: sets }, extra)); }
  function shown(k, on) { const u = unsure.get(k); if (u && u.n > (F.setN || 0)) return u.on; unsure.delete(k); return on; }

  function renderSettings() {
    $('fSetBox').hidden = !F.seenFeat;
    $('fNotifyRow').hidden = !F.seenFeat;          // (in Settings › Notifications; the other features under Advanced)
    $('fClipSync').checked = shown('clipSync', !!F.clipSync);
    $('fClipHist').checked = shown('clipHistory', !!F.clipHistory);
    $('fOpenLinks').checked = shown('openLinks', !!F.openLinks);
    $('fNotify').checked = shown('phoneNotify', !!F.phoneNotify);
    const apps = F.apps || [];
    $('fAppsRow').hidden = !F.seenFeat || !$('fNotify').checked || !apps.length;
    const muted = apps.filter((a) => a.muted).length;
    $('fAppsSub').textContent = apps.length + (apps.length === 1 ? ' app has' : ' apps have') + ' sent notifications' + (muted ? ' · ' + muted + ' muted' : '');
    const box = $('fApps');
    keepFocus(box, () => {
      box.textContent = '';
      for (const a of apps) {
        const on = shown('mute:' + a.pkg, !a.muted);
        const row = el('div', 'fapp' + (on ? '' : ' muted'));
        row.dataset.id = a.pkg;
        row.appendChild(el('span', 'fan', a.app));
        const tog = el('label', 'tog');
        const cb = el('input'); cb.type = 'checkbox'; cb.checked = on;
        cb.dataset.k = 'mute';
        cb.setAttribute('aria-label', 'Show notifications from ' + a.app);
        cb.onchange = () => change('mute:' + a.pkg, cb.checked, 'mute', { pkg: a.pkg, on: !cb.checked });
        tog.appendChild(cb); tog.appendChild(el('span'));
        row.appendChild(tog);
        box.appendChild(row);
      }
    });
  }
  for (const [id, key] of [['fClipSync', 'clipSync'], ['fClipHist', 'clipHistory'], ['fOpenLinks', 'openLinks'], ['fNotify', 'phoneNotify']]) {
    $(id).onchange = (e) => change(key, e.target.checked, 'set', { key, value: e.target.checked });
  }
  $('fAppsHead').onclick = () => {
    const open = $('fApps').hidden;
    $('fApps').hidden = !open;
    $('fAppsHead').setAttribute('aria-expanded', String(open));
  };

  // ---------- Find my phone ----------
  function renderRing() {
    const r = F.ringing;
    const was = !$('fRing').hidden;
    $('fRing').hidden = !r;
    if (r) {
      $('fRingName').textContent = r.name;
      if (!was) $('fRingStop').focus();
    }
  }
  $('fRingStop').onclick = () => send('ring-stop');

  function render() {
    if (!F) return;
    renderPhones();
    renderPairs();
    renderSettings();
    renderRing();
  }

  // ---------- the History view ----------
  function showHist(on) {
    histOpen = !!on;
    $('fHistView').hidden = !histOpen;
    send(histOpen ? 'hist-view' : 'hist-leave');      // (main sends the list only while it's open)
    if (histOpen) $('fHistView').focus();
  }
  (window.flickViews = window.flickViews || {}).hist = (on) => { if (histOpen !== !!on) { showHist(on); if (on) renderHist(); } };   // (the bar opens and closes it: nav.js)
  $('fHistClear').onclick = () => {
    // asks once more: it can't be undone (the files themselves stay)
    if (Date.now() - clearArmed < 4000) { clearArmed = 0; send('h-clear'); $('fHistClear').textContent = 'Clear'; return; }
    clearArmed = Date.now();
    $('fHistClear').textContent = 'Clear all?';
    setTimeout(() => { if (clearArmed && Date.now() - clearArmed >= 4000) { clearArmed = 0; $('fHistClear').textContent = 'Clear'; } }, 4100);
  };

  function iconBtn(icon, label, fn, k) {
    const b = el('button', 'wx');
    b.type = 'button'; b.title = label; b.setAttribute('aria-label', label);
    b.dataset.k = k;
    b.appendChild(svg(icon));
    // (a double-click, as many people do out of habit, is one press: its second click would send the file twice, or
    // remove the entry that just moved under the pointer. A key press's click has detail 0)
    b.onclick = (e) => { e.stopPropagation(); if (e.detail > 1) return; fn(); };
    return b;
  }

  // The list drawn again (an item removed, a file added) keeps the keyboard where it was: on the same button of the
  // same item, else of the item that took its place (or the one before, for the last), else in the view. It used to be
  // dropped to the page, to start over from the top after every Remove.
  function keepFocus(list, draw) {
    const a = document.activeElement, row = a && list.contains(a) ? a.closest('[data-id]') : null;
    const was = row ? { id: row.dataset.id, k: a.dataset.k || '', at: [...list.querySelectorAll('[data-id]')].indexOf(row) } : null;
    draw();
    if (!was) return;
    const rows = [...list.querySelectorAll('[data-id]')];
    const r = rows.find((x) => x.dataset.id === was.id) || rows[Math.min(was.at, rows.length - 1)];
    const f = (r && (r.querySelector('[data-k="' + was.k + '"]:not(:disabled)') || r.querySelector('button:not(:disabled)'))) || list.closest('.wview');
    if (f) f.focus();
  }

  function renderHist() {
    const clr = document.activeElement === $('fHistClear');
    keepFocus($('fHistList'), drawHist);
    // (Clear all emptied the list and its button went with it: the keyboard goes to what the view says now, not to the
    // page, where a screen reader says nothing)
    if (clr && $('fHistClear').hidden) ($('fHistEmpty').hidden ? $('fHistView') : $('fHistEmpty')).focus();
  }
  // History's rows by item id, with what each was drawn from. The list comes again up to 4 times a second while files
  // arrive: only new and changed rows are made, the rest stay as they are (and keep the keyboard and the pointer)
  let histRows = new Map();     // id -> { sig, node }
  let histDays = new Map();     // day and its heading's words -> the heading
  const histSig = (it) => JSON.stringify([it.ok, it.there, it.path, it.name, it.dir, it.deviceName, it.why, it.how, it.folder, it.size, it.time]);
  let histGen = -1;            // clock.gen the rows were drawn with
  window.addEventListener('languagechange', () => { clock.f = null; clock.z = null; histRows = new Map(); histDays = new Map(); });

  function drawHist() {
    // (the time zone or languages changed since: every row and heading is made again with the new ones)
    if (clock.check() !== histGen) { histGen = clock.gen; histRows = new Map(); histDays = new Map(); }
    const items = H.items || [];
    $('fHistEmpty').hidden = items.length > 0;
    $('fHistClear').hidden = !items.length;
    const list = $('fHistList');
    const want = [], rows = new Map(), days = new Map();
    let day = -1;
    for (const it of items) {
      const d = Number.isFinite(it.time) && it.time > 0 ? dayStart(it.time) : 0;
      if (d !== day) {
        day = d;
        const label = dayLabel(it.time), k = d + '|' + label;
        let h = days.has(k) ? null : histDays.get(k);
        if (!h) h = el('div', 'fday', label);
        if (!days.has(k)) days.set(k, h);
        want.push(h);
      }
      // (the same id twice: the second gets a row of its own, as before)
      if (rows.has(it.id)) { want.push(histRow(it)); continue; }
      const sig = histSig(it), was = histRows.get(it.id);
      const node = was && was.sig === sig ? was.node : histRow(it);
      rows.set(it.id, { sig, node });
      want.push(node);
    }
    // in order, moving as little as possible: rows already in their place aren't touched
    let at = list.firstChild;
    for (const n of want) { if (n === at) at = at.nextSibling; else list.insertBefore(n, at); }
    while (at) { const next = at.nextSibling; list.removeChild(at); at = next; }
    histRows = rows; histDays = days;
    $('fHistMore').hidden = !(H.total > items.length);
    $('fHistMore').textContent = 'Showing the newest ' + items.length + ' of ' + H.total + '.';
  }
  function histRow(it) {
    const row = el('div', 'fh' + (it.ok ? '' : ' bad') + (it.ok && !it.there ? ' gone' : ''));
    row.dataset.id = it.id;
    const open = el('button', 'fhopen');
    open.type = 'button';
    open.dataset.k = 'open';
    open.disabled = !it.there;
    open.title = it.there ? 'Open ' + it.name : it.path ? 'Not on this PC any more' : '';
    const dir = el('span', 'fhdir');
    dir.appendChild(svg(!it.ok ? ICON.bad : it.dir === 'out' ? ICON.out : ICON.in));
    open.appendChild(dir);
    const main = el('span', 'fhmain');
    main.appendChild(el('span', 'fhname', it.name));
    const sub = el('span', 'fhsub');
    const who = it.deviceName ? (it.dir === 'out' ? 'To ' : 'From ') + it.deviceName : it.dir === 'out' ? 'Sent' : 'Received';
    const bits = [];
    // (a send the other device's user declined: in their words there, as in Transfers)
    if (!it.ok) { const w = el('span', 'why', it.dir === 'out' && it.why === 'declined' ? 'Not accepted' : WHY[it.why] || 'Didn’t arrive'); sub.appendChild(w); bits.push(''); }
    bits.push(who + (HOW[it.how] ? ' (' + HOW[it.how] + ')' : ''));
    if (it.ok) bits.push(it.folder ? 'Folder' : fmt(it.size || 0));
    if (it.ok && !it.there && it.path) bits.push('moved or deleted');
    if (Number.isFinite(it.time) && it.time > 0) bits.push(clock(it.time));
    sub.appendChild(document.createTextNode((it.ok ? '' : ' · ') + bits.filter(Boolean).join(' · ')));
    main.appendChild(sub);
    open.appendChild(main);
    open.onclick = () => { if (it.there) send('h-open', { id: it.id }); };
    row.appendChild(open);
    const acts = el('div', 'fhacts');
    if (it.there) {
      acts.appendChild(iconBtn(ICON.folder, 'Show in folder', () => send('h-show', { id: it.id }), 'show'));
      acts.appendChild(iconBtn(ICON.send, it.dir === 'out' ? 'Send again' : 'Send to phone', () => send('h-send', { id: it.id }), 'send'));
    }
    acts.appendChild(iconBtn(ICON.x, 'Remove from history', () => send('h-remove', { id: it.id }), 'remove'));
    row.appendChild(acts);
    return row;
  }

  // (a page loaded anew numbers its changes on from the last one main took)
  api.on('panel:feat-state', (s) => { F = s; sets = Math.max(sets, s.setN || 0); render(); });
  api.on('panel:feat-history', (h) => { H = h || { items: [], total: 0 }; if (histOpen) renderHist(); });
  setInterval(() => { if (F) renderPairs(); }, 30000);   // "2 min ago" stays true
  document.addEventListener('visibilitychange', () => { if (!document.hidden && histOpen) send('hist-view'); });   // shown again: fresh list

  // Escape: back out of the History view, stop the ringing (before panel.js would hide the window)
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('fRing').hidden) { e.stopImmediatePropagation(); send('ring-stop'); return; }
    // (a question in front, pairing, Accept, Quick Share, a browser's: answered with its buttons; History stays behind it)
    if ([...document.querySelectorAll('.modal')].some((m) => !m.hidden)) return;
    if (histOpen) { e.stopImmediatePropagation(); showHist(false); }
  }, true);

  send('hello');
})();
