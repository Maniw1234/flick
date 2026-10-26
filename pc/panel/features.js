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
  const clock = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const dayStart = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
  function ago(t) {
    const s = (Date.now() - t) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + ' min ago';
    if (t >= dayStart(Date.now())) return 'at ' + clock(t);
    if (t >= dayStart(Date.now()) - 86400000) return 'yesterday';
    return new Date(t).toLocaleDateString([], { day: 'numeric', month: 'short' });
  }
  function dayLabel(t) {
    const today = dayStart(Date.now());
    if (t >= today) return 'Today';
    if (t >= today - 86400000) return 'Yesterday';
    return new Date(t).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
  }
  const HOW = { auto: 'auto', share: 'shared', quickshare: 'Quick Share', browser: 'browser', sync: 'sync', pull: 'Browse phone' };
  const WHY = { declined: 'Declined', timeout: 'Not accepted in time' };

  let F = null;            // the latest state
  let H = { items: [], total: 0 };
  let histOpen = false;
  let clearArmed = 0;

  // ---------- phones, the link field ----------
  function renderPhones() {
    const list = F.phones || [];
    const pages = list.filter((p) => p.page);
    $('fPhonesBox').hidden = !(list.length > 1 || list.some((p) => p.feat));
    $('fPhonesTitle').textContent = list.length > 1 ? 'Phones' : 'Your phone';
    const box = $('fPhones');
    box.textContent = '';
    const choose = pages.length > 1;          // which one gets what this PC sends: a choice once there are several
    if (choose) { box.setAttribute('role', 'radiogroup'); box.setAttribute('aria-label', 'Send to'); } else { box.removeAttribute('role'); box.removeAttribute('aria-label'); }
    for (const p of list) {
      const row = el('div', 'fph');
      if (choose && p.page) {
        const r = el('button', 'fradio');
        r.type = 'button';
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
        b.appendChild(svg(ICON.ring));
        b.appendChild(el('span', null, ringing ? 'Ringing…' : 'Find my phone'));
        b.disabled = !!ringing;
        b.setAttribute('aria-label', 'Find ' + p.name + ': make it ring');
        b.onclick = (e) => { e.stopPropagation(); send('ring', { device: p.device }); };
        row.appendChild(b);
      }
      box.appendChild(row);
    }
    const t = F.target;
    const linkOk = !!(t && t.feat);
    $('fLinkForm').hidden = !linkOk || $('fPhonesBox').hidden;
    if (linkOk) $('fLink').placeholder = 'Send a link to ' + (list.length > 1 ? t.name : 'your phone');
    // with several phones connected, the big button says which one gets the files
    const active = pages.find((p) => p.active);
    $('sendFiles').textContent = choose && active ? 'Send files to ' + active.name : 'Send files to phone';
  }

  $('fLinkForm').onsubmit = (e) => {
    e.preventDefault();
    const v = $('fLink').value.trim();
    if (!v) { $('fLink').focus(); return; }
    send('link', { url: v });
    $('fLink').value = '';
  };

  // ---------- History entry, synced folders, settings ----------
  function renderEntry() {
    const l = F.last;
    let t = 'Files you send and receive show up here.';
    if (l) {
      const who = l.deviceName ? (l.dir === 'out' ? ' to ' : ' from ') + l.deviceName : '';
      t = !l.ok ? (WHY[l.why] ? 'Declined ' + l.name + who : l.name + ' didn’t arrive') + ' · ' + ago(l.time)
        : (l.dir === 'out' ? 'Sent ' + l.name + who : l.name + who) + ' · ' + ago(l.time);
    }
    $('fHistSub').textContent = t;
  }

  function renderPairs() {
    const pairs = F.pairs || [];
    $('fPairsBox').hidden = !pairs.length;
    const box = $('fPairs');
    box.textContent = '';
    for (const p of pairs) {
      const row = el('div', 'fpair');
      const main = el('div', 'fmain');
      main.appendChild(el('div', 'fname', p.name));
      main.appendChild(el('div', 'd', p.phone + ' · ' + (p.last ? 'synced ' + ago(p.last) : 'not synced yet')));
      main.title = p.folder;
      row.appendChild(main);
      const btns = el('div', 'fbtns');
      const o = el('button', 'link', 'Open folder'); o.type = 'button'; o.onclick = () => send('pair-open', { id: p.id });
      const x = el('button', 'link danger', 'Stop syncing'); x.type = 'button';
      x.title = 'The files stay on this PC and on the phone';
      x.onclick = () => send('pair-stop', { id: p.id });
      btns.appendChild(o); btns.appendChild(x);
      row.appendChild(btns);
      box.appendChild(row);
    }
  }

  function renderSettings() {
    $('fSetBox').hidden = !F.seenFeat;
    $('fClipSync').checked = !!F.clipSync;
    $('fClipHist').checked = !!F.clipHistory;
    $('fOpenLinks').checked = !!F.openLinks;
    $('fNotify').checked = !!F.phoneNotify;
    const apps = F.apps || [];
    $('fAppsRow').hidden = !F.phoneNotify || !apps.length;
    const muted = apps.filter((a) => a.muted).length;
    $('fAppsSub').textContent = apps.length + (apps.length === 1 ? ' app has' : ' apps have') + ' sent notifications' + (muted ? ' · ' + muted + ' muted' : '');
    const box = $('fApps');
    box.textContent = '';
    for (const a of apps) {
      const row = el('div', 'fapp' + (a.muted ? ' muted' : ''));
      row.appendChild(el('span', 'fan', a.app));
      const tog = el('label', 'tog');
      const cb = el('input'); cb.type = 'checkbox'; cb.checked = !a.muted;
      cb.setAttribute('aria-label', 'Show notifications from ' + a.app);
      cb.onchange = () => send('mute', { pkg: a.pkg, on: !cb.checked });
      tog.appendChild(cb); tog.appendChild(el('span'));
      row.appendChild(tog);
      box.appendChild(row);
    }
  }
  $('fClipSync').onchange = (e) => send('set', { key: 'clipSync', value: e.target.checked });
  $('fClipHist').onchange = (e) => send('set', { key: 'clipHistory', value: e.target.checked });
  $('fOpenLinks').onchange = (e) => send('set', { key: 'openLinks', value: e.target.checked });
  $('fNotify').onchange = (e) => send('set', { key: 'phoneNotify', value: e.target.checked });
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
    renderEntry();
    renderPairs();
    renderSettings();
    renderRing();
  }

  // ---------- the History view ----------
  function showHist(on) {
    histOpen = !!on;
    $('fHistView').hidden = !histOpen;
    if (histOpen) { send('hello'); $('fHistView').focus(); }
  }
  $('fHistEntry').onclick = () => { showHist(true); renderHist(); };
  $('fHistBack').onclick = () => showHist(false);
  $('fHistClear').onclick = () => {
    // asks once more: it can't be undone (the files themselves stay)
    if (Date.now() - clearArmed < 4000) { clearArmed = 0; send('h-clear'); $('fHistClear').textContent = 'Clear'; return; }
    clearArmed = Date.now();
    $('fHistClear').textContent = 'Clear all?';
    setTimeout(() => { if (clearArmed && Date.now() - clearArmed >= 4000) { clearArmed = 0; $('fHistClear').textContent = 'Clear'; } }, 4100);
  };

  function iconBtn(icon, label, fn) {
    const b = el('button', 'wx');
    b.type = 'button'; b.title = label; b.setAttribute('aria-label', label);
    b.appendChild(svg(icon));
    b.onclick = (e) => { e.stopPropagation(); fn(); };
    return b;
  }

  function renderHist() {
    const items = H.items || [];
    $('fHistEmpty').hidden = items.length > 0;
    $('fHistClear').hidden = !items.length;
    const list = $('fHistList');
    list.textContent = '';
    let day = -1;
    for (const it of items) {
      const d = dayStart(it.time);
      if (d !== day) { day = d; list.appendChild(el('div', 'fday', dayLabel(it.time))); }
      const row = el('div', 'fh' + (it.ok ? '' : ' bad') + (it.ok && !it.there ? ' gone' : ''));
      const open = el('button', 'fhopen');
      open.type = 'button';
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
      if (!it.ok) { const w = el('span', 'why', WHY[it.why] || 'Didn’t arrive'); sub.appendChild(w); bits.push(''); }
      bits.push(who + (HOW[it.how] ? ' (' + HOW[it.how] + ')' : ''));
      if (it.ok) bits.push(it.folder ? 'Folder' : fmt(it.size || 0));
      if (it.ok && !it.there && it.path) bits.push('moved or deleted');
      bits.push(clock(it.time));
      sub.appendChild(document.createTextNode((it.ok ? '' : ' · ') + bits.filter(Boolean).join(' · ')));
      main.appendChild(sub);
      open.appendChild(main);
      open.onclick = () => { if (it.there) send('h-open', { id: it.id }); };
      row.appendChild(open);
      const acts = el('div', 'fhacts');
      if (it.there) {
        acts.appendChild(iconBtn(ICON.folder, 'Show in folder', () => send('h-show', { id: it.id })));
        acts.appendChild(iconBtn(ICON.send, it.dir === 'out' ? 'Send again' : 'Send to phone', () => send('h-send', { id: it.id })));
      }
      acts.appendChild(iconBtn(ICON.x, 'Remove from history', () => send('h-remove', { id: it.id })));
      row.appendChild(acts);
      list.appendChild(row);
    }
    $('fHistMore').hidden = !(H.total > items.length);
    $('fHistMore').textContent = 'Showing the newest ' + items.length + ' of ' + H.total + '.';
  }

  api.on('panel:feat-state', (s) => { F = s; render(); });
  api.on('panel:feat-history', (h) => { H = h || { items: [], total: 0 }; if (histOpen) renderHist(); });
  setInterval(() => { if (F) { renderEntry(); renderPairs(); } }, 30000);   // "2 min ago" stays true
  document.addEventListener('visibilitychange', () => { if (!document.hidden && histOpen) send('hello'); });   // shown again: fresh list

  // Escape: back out of the History view, stop the ringing (before panel.js would hide the window)
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('fRing').hidden) { e.stopImmediatePropagation(); send('ring-stop'); return; }
    if (histOpen) { e.stopImmediatePropagation(); showHist(false); }
  }, true);

  send('hello');
})();
