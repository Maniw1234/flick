/* Flick phone app (runs inside the Android WebView). */
(function () {
  'use strict';

  // ------------------------------------------------------------------ utils
  const $ = (id) => document.getElementById(id);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const easeOut = (t) => 1 - Math.pow(1 - t, 3);
  const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const now = () => performance.now();
  const damp = (cur, target, dt, ms) => target + (cur - target) * Math.exp(-dt / ms);
  const rid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const SVG_T = new Map();       // each SVG string is parsed once, then cloned
  function svgEl(html) {
    let t = SVG_T.get(html);
    if (!t) { t = document.createElement('template'); t.innerHTML = html.trim(); SVG_T.set(html, t); }
    return t.content.firstChild.cloneNode(true);
  }

  // ------------------------------------------------------------------ native bridge
  const NV = window.FlickNative || null;
  function nc(name) {
    const args = Array.prototype.slice.call(arguments, 1);
    if (!NV || typeof NV[name] !== 'function') return null;
    try { const r = NV[name].apply(NV, args); return r === undefined ? true : r; } catch (e) { console.log('native ' + name + ' failed: ' + e); return null; }
  }
  function njson(name) { const r = nc.apply(null, arguments); if (!r || r === true) return null; try { return JSON.parse(r); } catch (e) { return null; } }
  const pendingReq = new Map();
  let reqSeq = 0;
  function nreq(method) { return nreqT.apply(null, [25000].concat(Array.prototype.slice.call(arguments))); }
  // the same with its own time limit: listing a huge folder (or a slow SD card) can take far longer than 25 s
  function nreqT(ms, method) {
    const args = Array.prototype.slice.call(arguments, 2);
    return new Promise((resolve) => {
      const id = 'r' + (++reqSeq);
      pendingReq.set(id, resolve);
      const r = nc.apply(null, [method, id].concat(args));
      if (r === null) { pendingReq.delete(id); resolve(null); return; }
      setTimeout(() => { if (pendingReq.has(id)) { pendingReq.delete(id); resolve(null); } }, ms);
    });
  }
  const pref = {
    get(k, d) { const v = nc('getPref', k); return v === null || v === undefined || v === '' || v === true ? d : v; },
    set(k, v) { nc('setPref', k, v === null || v === undefined ? '' : String(v)); },
  };
  // ------------------------------------------------------------------ settings (Settings page, from the ••• menu)
  const SETTINGS_DEFAULTS = { parallel: true, showSpeed: true, haptics: true, autoUpdate: true, bluetooth: false, phoneName: '' };
  const settings = (() => {
    try { return Object.assign({}, SETTINGS_DEFAULTS, JSON.parse(pref.get('settings', '{}')) || {}); } catch (e) { return Object.assign({}, SETTINGS_DEFAULTS); }
  })();
  function saveSettings() { pref.set('settings', JSON.stringify(settings)); }
  const haptic = (k) => { if (settings.haptics !== false) nc('haptic', k); };

  const INFO = njson('info') || {};
  const DEVICE = INFO.device || pref.get('device', null) || (() => { const d = 'web-' + rid(); pref.set('device', d); return d; })();
  const DEVNAME = INFO.name || 'Android phone';
  const phoneName = () => String(settings.phoneName || '').trim().slice(0, 40) || DEVNAME;
  const root = document.documentElement.style;
  function applyInsets(top, bottom) {
    if (typeof top === 'number') root.setProperty('--top', Math.max(0, top) + 'px');
    if (typeof bottom === 'number') root.setProperty('--bottom', Math.max(0, bottom) + 'px');
    requestAnimationFrame(measureHeader);
  }
  applyInsets(INFO.top, INFO.bottom);
  if (INFO.corner) root.setProperty('--corner', clamp(INFO.corner, 0, 80) + 'px');
  let STG = njson('storage') || { granted: false };

  // ------------------------------------------------------------------ state
  const st = {
    pcs: [], pc: null,
    ws: null, wsOpen: false, trusted: false, connected: false, connecting: false, wantResume: false, connectWanted: 0,
    side: 'right',           // where the PHONE sits relative to the PC
    hidden: new Set(),       // items hidden while being sent
    pending: new Map(),      // tid -> {item, phase}
    keep: pref.get('keep', '0') === '1',
    screen: 'pair',
  };
  const tokenKey = (pcId) => 'token:' + pcId;
  // the SHA-256 of the PC's certificate, pinned when this phone paired with it (or when a PC paired before 1.9 first
  // proved over an encrypted link that it holds this phone's token): only that PC gets a connection
  const pinKey = (pcId) => 'pin:' + pcId;
  const rhex = (n) => { const a = new Uint8Array(n); crypto.getRandomValues(a); return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join(''); };
  const SEL = { on: false, ids: new Set() };   // multi-select: ids of the selected items in the current view
  // wireless update: the PC announces the newest phone app it has; app = { code, name, size, sha256, url }
  const UPD = { app: null, pcApp: null, ghApp: null, ghAt: 0, ghAsk: false, pcKnows: false, state: 'idle', got: 0, total: 0, why: '', dismissed: 0, checkT: 0, auto: false };
  const MY_CODE = +INFO.code || 0;

  // ------------------------------------------------------------------ animation themes (the PC is the source of truth)
  const THEMES = [
    { v: 'roadster', name: 'Roadster', desc: 'Launches on jets, flips, lands' },
    { v: 'liquid', name: 'Liquid', desc: 'Ripples through your desktop' },
    { v: 'teleport', name: 'Teleport', desc: 'Beamed in, pixel by pixel' },
    { v: 'halo', name: 'Halo', desc: 'Soft light and a glass sweep' },
  ];
  function themeOf(v) { return THEMES.find((t) => t.v === v) || THEMES[0]; }
  st.theme = themeOf(pref.get('theme', 'roadster')).v;
  function applyTheme(v) {
    const t = themeOf(v).v;
    st.theme = t;
    document.body.dataset.theme = t;
    pref.set('theme', t);
  }
  applyTheme(st.theme);
  const towardSign = () => (st.side === 'right' ? -1 : 1); // +x direction that points at the PC

  // ------------------------------------------------------------------ toast / sheets
  let toastT = 0;
  function toast(msg, ms) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('on');
    clearTimeout(toastT);
    toastT = setTimeout(() => t.classList.remove('on'), ms || 2200);
  }

  const ICONS = {
    photo: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="3" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M3.5 16l5-4.5 4 3.5 3-2.5 5 4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><circle cx="16" cy="9.5" r="1.6" fill="currentColor"/></svg>',
    file: '<svg viewBox="0 0 24 24"><path d="M7 3h7l5 5v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M14 3v5h5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>',
    send: '<svg viewBox="0 0 24 24"><path d="M4 12h13M12 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    open: '<svg viewBox="0 0 24 24"><path d="M14 4h6v6M20 4l-9 9M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    share: '<svg viewBox="0 0 24 24"><path d="M12 3v12M7 8l5-5 5 5M5 13v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    save: '<svg viewBox="0 0 24 24"><path d="M12 4v11M7 10l5 5 5-5M5 20h14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    trash: '<svg viewBox="0 0 24 24"><path d="M5 7h14M10 7V5h4v2M7 7l1 12a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2l1-12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    side: '<svg viewBox="0 0 24 24"><rect x="2.5" y="6" width="12" height="9" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M1.5 18h14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><rect x="17.5" y="5" width="5" height="13" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>',
    keep: '<svg viewBox="0 0 24 24"><rect x="8" y="8" width="12" height="12" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>',
    off: '<svg viewBox="0 0 24 24"><path d="M12 3v8M6.3 6.3a8 8 0 1 0 11.4 0" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
    clear: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg>',
    folder: '<svg viewBox="0 0 24 24"><path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H10l2 2.2h6.5A2.5 2.5 0 0 1 21 9.7v7.8a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>',
    spark: '<svg viewBox="0 0 24 24"><path d="M12 3l1.9 5.6L19.5 10l-5.6 1.9L12 17.5l-1.9-5.6L4.5 10l5.6-1.4z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M18.5 16l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z" fill="currentColor"/></svg>',
    refresh: '<svg viewBox="0 0 24 24"><path d="M20 12a8 8 0 1 1-2.4-5.7M20 4v5h-5" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    gear: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3.2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 2.8v2.4M12 18.8v2.4M21.2 12h-2.4M5.2 12H2.8M18.5 5.5l-1.7 1.7M7.2 16.8l-1.7 1.7M18.5 18.5l-1.7-1.7M7.2 7.2L5.5 5.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
    wifi: '<svg viewBox="0 0 24 24"><path d="M2.5 9a14 14 0 0 1 19 0M5.8 12.6a9 9 0 0 1 12.4 0M9.1 16.1a4.3 4.3 0 0 1 5.8 0" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="12" cy="19.2" r="1.3" fill="currentColor"/></svg>',
    usb: '<svg viewBox="0 0 24 24"><path d="M12 21V5M9 7.5l3-4 3 4M12 16l-4.5-3V10M12 13.5l4.5-2.5V8.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><circle cx="12" cy="20" r="1.6" fill="currentColor"/><rect x="6.2" y="8.2" width="2.6" height="2.4" rx=".4" fill="currentColor"/><circle cx="16.5" cy="7.4" r="1.3" fill="currentColor"/></svg>',
    hotspot: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="1.8" fill="currentColor"/><path d="M8.2 15.8a5.4 5.4 0 0 1 0-7.6M15.8 8.2a5.4 5.4 0 0 1 0 7.6M5.3 18.7a9.5 9.5 0 0 1 0-13.4M18.7 5.3a9.5 9.5 0 0 1 0 13.4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
    bt: '<svg viewBox="0 0 24 24"><path d="M7 7.5l10 9-5 4.5V3l5 4.5-10 9" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    check: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.6" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M8.3 12.3l2.6 2.6 5-5.3" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    update: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.6" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 7.7v8.2M8.6 12.6l3.4 3.4 3.4-3.4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  };
  const FOLDER_SVG = '<svg viewBox="0 0 64 52"><defs><linearGradient id="fg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8fb4ff"/><stop offset="1" stop-color="#4c7dff"/></linearGradient></defs><path d="M4 9a5 5 0 0 1 5-5h14l6 6h26a5 5 0 0 1 5 5v28a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5z" fill="#3a5fcc"/><path d="M4 18a5 5 0 0 1 5-5h46a5 5 0 0 1 5 5v25a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5z" fill="url(#fg)"/></svg>';

  let sheetOpen = false, sheetAt = 0;
  let sheetHideT = 0;
  function openSheet(title, actions) {
    clearTimeout(sheetHideT);          // a sheet opened from another sheet must not be hidden by its close timer
    sheetAt = now();
    const sh = $('sheet');
    $('sheetTitle').textContent = title || '';
    $('sheetTitle').style.display = title ? '' : 'none';
    const box = $('sheetItems');
    box.innerHTML = '';
    box.classList.remove('tsheet');
    for (const a of actions) {
      if (!a) continue;
      const b = document.createElement('button');
      b.className = 'sitem' + (a.danger ? ' danger' : '');
      if (a.icon) b.appendChild(svgEl(ICONS[a.icon]));
      const s = document.createElement('span'); s.textContent = a.label; b.appendChild(s);
      if (a.tag) { const t = document.createElement('span'); t.className = 'tag'; t.textContent = a.tag; b.appendChild(t); }
      b.onclick = () => { if (now() - sheetAt < 350) return; closeSheet(); setTimeout(a.run, 60); };
      box.appendChild(b);
    }
    sh.hidden = false; sh.classList.remove('closing');
    sheetOpen = true;
    haptic('soft');
  }
  function closeSheet() {
    const sh = $('sheet');
    if (sh.hidden) return;
    sh.classList.add('closing');
    sheetOpen = false;
    for (const v of sh.querySelectorAll('video')) v.pause();
    clearTimeout(sheetHideT);
    sheetHideT = setTimeout(() => { sh.hidden = true; sh.classList.remove('closing'); }, 200);
  }
  $('sheet').querySelector('.backdrop').onclick = () => { if (now() - sheetAt > 350) closeSheet(); };

  // ------------------------------------------------------------------ formatting
  function fmtSize(n) {
    n = +n || 0;
    if (n < 1024) return n + ' bytes';
    if (n < 1024 * 1024) return Math.max(1, Math.round(n / 1024)) + ' KB';
    if (n < 1024 * 1024 * 1024) return (n / 1048576).toFixed(n < 10 * 1048576 ? 1 : 0) + ' MB';
    return (n / 1073741824).toFixed(1) + ' GB';
  }
  function fmtWhen(ms) {
    const d = new Date(+ms || Date.now());
    const today = new Date();
    const sameDay = d.toDateString() === today.toDateString();
    try {
      if (sameDay) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      const opts = d.getFullYear() === today.getFullYear() ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' };
      return d.toLocaleDateString([], opts);
    } catch (e) { return d.getHours() + ':' + String(d.getMinutes()).padStart(2, '0'); }
  }
  function fmtDur(ms) {
    const s = Math.round((+ms || 0) / 1000);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0');
  }
  function midName(n) {
    n = String(n || '');
    if (n.length <= 18) return n;
    return n.slice(0, 7) + '...' + n.slice(-8);
  }
  function extOf(n) { const m = /\.([^.]+)$/.exec(n || ''); return m ? m[1].toLowerCase() : ''; }
  function badgeOf(it) {
    if (it.dir || it.kind === 'image' || it.kind === 'video') return '';
    const e = (it.ext || extOf(it.name) || 'file').toUpperCase();
    return e.slice(0, 4);
  }
  function pcKind(it) { return it.kind === 'image' ? 'image' : it.kind === 'video' ? 'video' : 'doc'; }
  function thumbUrl(it) {
    if (it.thumb) return it.thumb;
    if (!it.path || it.dir) return null;
    if (!/^(image|video|pdf|text|audio|apk)$/.test(it.kind || '')) return null;
    return 'https://flick.local/t?p=' + encodeURIComponent(it.path) + '&v=' + (it.mtime || 0) + '&m=' + (it.mid || 0) + '&t=' + (it.mt || 0);
  }

  // ------------------------------------------------------------------ neon glow (pairing)
  const glow = $('glow');
  const spins = glow.querySelectorAll('.gspin');
  const G = { a: Math.random() * 360, w: 6, b: 18, speed: 38, hold: 0, active: false, raf: 0, last: 0 };
  function glowLoop(t) {
    const dt = Math.min(50, t - (G.last || t)); G.last = t;
    const h = G.hold;
    G.speed = lerp(38, 420, h);
    G.a = (G.a + G.speed * dt / 1000) % 360;
    const w = lerp(6, 34, easeOut(h)), b = lerp(18, 44, h);
    glow.style.setProperty('--gw', w.toFixed(1) + 'px');
    glow.style.setProperty('--gb', b.toFixed(1) + 'px');
    const tf = 'rotate(' + G.a.toFixed(2) + 'deg)';
    spins[0].style.transform = tf; spins[1].style.transform = tf;
    if (G.active) G.raf = requestAnimationFrame(glowLoop); else G.raf = 0;
  }
  function glowOn(on) {
    glow.classList.toggle('on', on);
    if (on && !G.active) { G.active = true; G.last = 0; G.raf = requestAnimationFrame(glowLoop); }
    if (!on) { setTimeout(() => { if (!glow.classList.contains('on')) G.active = false; }, 600); }
  }

  // ------------------------------------------------------------------ screens
  function showScreen(name) {
    st.screen = name;
    $('pair').classList.toggle('on', name === 'pair');
    $('main').classList.toggle('on', name === 'main');
    glowOn(name === 'pair');
    nc('discover', !document.hidden);          // also while connected: a faster link (a USB cable) is picked up
    nc('keepAwake', name === 'main' && st.connected);
    if (name === 'main') requestAnimationFrame(() => { measureHeader(); layout(false); });
    renderUpd();
  }

  function flashScreen(cb) {
    const f = $('flash');
    f.style.transition = 'none';
    f.style.opacity = '0';
    void f.offsetWidth;
    f.style.transition = 'opacity 170ms ease-out';
    f.style.opacity = '0.96';
    setTimeout(() => {
      if (cb) cb();
      f.style.transition = 'opacity 560ms ease-in';
      f.style.opacity = '0';
    }, 190);
  }

  // ------------------------------------------------------------------ discovery + PC choice
  function setPcName() {
    const el = $('pcName');
    if (st.pc) {
      el.textContent = st.pc.name;
      el.classList.remove('searching');
      $('pairL1').textContent = 'Hold phone next to';
      $('pairL3').textContent = st.awaitingApproval ? 'Click “Allow” on your PC.' : 'Then press and hold Connect.';
    } else {
      el.textContent = 'Looking for your PC…';
      el.classList.add('searching');
      $('pairL3').textContent = 'Open Flick on your PC.';
    }
    $('otherPc').hidden = st.pcs.length < 2;
    $('connect').disabled = !st.pc;
  }

  function pairHint(html) { $('pairHint').innerHTML = html || ''; }

  // faster links first: USB cable, Ethernet, a hotspot or direct link, Wi-Fi, then Bluetooth
  const LINK_RANK = { usb: 5, ethernet: 4, hotspot: 3, direct: 3, wifi: 2, bluetooth: 1 };
  const rankOf = (p) => LINK_RANK[(p && p.via) || 'wifi'] || 2;
  const busyMoving = () => [...st.pending.values()].some((p) => p.phase === 'sent' && !p.uploaded) || (st.incoming && st.incoming.size > 0) || V.items.some((x) => x.incoming);
  function onPcs() {
    // Bluetooth reports the PC it reached through the same list
    st.pcs = (st.lanList || []).filter((p) => p && p.ip && p.port).concat(st.btPc ? [st.btPc] : []);
    const pick = (id) => st.pcs.filter((p) => p.id === id).sort((a, b) => rankOf(b) - rankOf(a))[0];
    if (!st.pc && st.pcs.length) {
      const last = pref.get('lastPc', '');
      choosePc(pick(last) || st.pcs.slice().sort((a, b) => rankOf(b) - rankOf(a))[0]);
    } else if (st.pc) {
      const same = pick(st.pc.id);
      if (same && (same.ip !== st.pc.ip || same.port !== st.pc.port || same.name !== st.pc.name || same.via !== st.pc.via || (+same.tls || 0) !== (+st.pc.tls || 0))) {
        // a PC that turned out to take encrypted links (it just updated) is reconnected like one that moved
        const moved = same.ip !== st.pc.ip || same.port !== st.pc.port || (+same.tls || 0) !== (+st.pc.tls || 0);
        const faster = rankOf(same) > rankOf(st.pc);
        // a faster link to the connected PC (say, a USB cable was just plugged in): move over once nothing is in flight
        if (moved && st.connected && (!faster || busyMoving())) { setPcName(); return; }
        st.pc = Object.assign({}, st.pc, same);
        if (same.via !== 'bluetooth') { pref.set('lastPcAddr', same.ip + ':' + same.port); pref.set('lastPcTls', same.tls ? '1' : '0'); }
        if (moved && st.connected) { toast('Connected over ' + (LINK_NAMES[same.via] || same.via), 2000); openLink(true); }
        else if (moved) openLink(st.wantResume);
      }
    }
    setPcName();
  }

  function choosePc(pc) {
    if (!pc) return;
    st.pc = { id: pc.id, name: pc.name, ip: pc.ip, port: pc.port, via: pc.via || 'wifi', v: +pc.v || 1, tls: +pc.tls || 0 };
    st.linkBlocked = '';
    pref.set('lastPc', pc.id);
    if (pc.via !== 'bluetooth') { pref.set('lastPcAddr', pc.ip + ':' + pc.port); pref.set('lastPcTls', pc.tls ? '1' : '0'); }
    pref.set('lastPcName', pc.name);
    st.replaced = false;
    setPcName();
    pairHint('');
    openLink();
  }

  $('otherPc').onclick = () => {
    openSheet('Choose your PC', st.pcs.map((p) => ({ label: p.name, tag: p.ip, icon: 'side', run: () => { closeLink(); choosePc(p); } })));
  };
  $('skipBtn').onclick = () => { showScreen('main'); };

  // a small prompt with one text field: the PC address here, the phone's name in Settings
  let askDone = null;
  function askText(o) {
    $('askTitle').textContent = o.title; $('askSub').textContent = o.sub || '';
    const inp = $('askInput');
    inp.value = o.value || ''; inp.placeholder = o.placeholder || '';
    inp.setAttribute('inputmode', o.mode || 'text');
    $('askOk').textContent = o.ok || 'OK';
    askDone = o.done;
    $('ask').hidden = false;
    setTimeout(() => { inp.focus(); inp.select(); }, 50);
  }
  $('manualBtn').onclick = () => askText({
    title: 'Enter PC address', sub: 'Shown on your PC in the Flick window, e.g. 192.168.1.23', value: pref.get('manual', ''),
    placeholder: '192.168.1.23', ok: 'Connect', mode: 'decimal', done: connectManual,
  });
  $('askCancel').onclick = () => { $('ask').hidden = true; };
  $('ask').querySelector('.backdrop').onclick = () => { $('ask').hidden = true; };
  $('askOk').onclick = async () => {
    const v = $('askInput').value;
    if (askDone && await askDone(v)) $('ask').hidden = true;
  };
  async function connectManual(rawIn) {
    const raw = String(rawIn || '').trim();
    if (!raw) return false;
    pref.set('manual', raw);
    const m = /^([\w.-]+)(?::(\d+))?$/.exec(raw);
    if (!m) { toast('That address doesn’t look right'); return false; }
    const ip = m[1], port = +(m[2] || 47860);
    $('askOk').textContent = 'Connecting…';
    try {
      // asked over an encrypted link like everything else (the phone sends nothing over the network in the clear);
      // which certificate to trust is settled when it connects, once the PC's id is known
      const lk = await nreqT(8000, 'tlsOpen', ip, port, '');
      if (!lk || !lk.ok) {
        if (lk && lk.why === 'tls') { toast('Flick on the PC at ' + ip + ' needs updating first', 3200); $('askOk').textContent = 'Connect'; return false; }
        throw new Error('unreachable');
      }
      const ctl = new AbortController();
      const to = setTimeout(() => ctl.abort(), 3500);
      const r = await fetch('http://127.0.0.1:' + lk.port + '/api/hello', { signal: ctl.signal });
      clearTimeout(to);
      const j = await r.json();
      if (!j || j.app !== 'flick') throw new Error('not flick');
      $('askOk').textContent = 'Connect';
      const pc = { id: j.id, name: j.name, ip, port: j.port || port, v: +j.v || 4, tls: 1 };
      if (!st.pcs.find((p) => p.id === pc.id)) st.pcs.push(pc);
      closeLink();
      choosePc(pc);
      return true;
    } catch (e) {
      toast('Couldn’t reach a PC at ' + ip, 2800);
    }
    $('askOk').textContent = 'Connect';
    return false;
  }

  // ------------------------------------------------------------------ link (WebSocket to the PC)
  let wsGen = 0, reconnectT = 0, pingT = 0, connectT = 0;
  function wsSend(o) { if (st.ws && st.ws.readyState === 1) { st.ws.send(JSON.stringify(o)); return true; } return false; }

  function closeLink() {
    wsGen++;
    clearTimeout(reconnectT); clearInterval(pingT);
    if (st.ws) { try { st.ws.close(); } catch (e) { /* ignore */ } }
    st.ws = null; st.wsOpen = false; st.connected = false; st.trusted = false; st.awaitingApproval = false; st.connecting = false;
    st.pcProved = false;
    updateConn();
  }

  // The way to the PC. Over Bluetooth: the local port the app's Bluetooth link gives (Bluetooth encrypts that link
  // itself). Otherwise: an encrypted link (TLS) through a local port the app opens, which only reaches a PC whose
  // certificate is the one this phone pinned. A PC that can't do encrypted links (Flick before 1.9) isn't used.
  async function prepareLink(pc) {
    if (pc.via === 'bluetooth') {
      if ((+pc.v || 1) < 4) { linkProblem('old'); return null; }
      return { ip: pc.ip, port: pc.port, chan: 'bluetooth', key: 'bt:' + pc.port };
    }
    if (!pc.tls) { linkProblem('old'); return null; }
    const pin = pref.get(pinKey(pc.id), '');
    const r = await nreqT(20000, 'tlsOpen', pc.ip, pc.port, pin);
    if (!r) return null;
    if (!r.ok) { if (r.why === 'pin') linkProblem('pin'); return null; }
    return { ip: '127.0.0.1', port: r.port, chan: r.fp, fp: r.fp, pinned: !!pin, key: pc.ip + ':' + pc.port };
  }
  // where HTTP requests to the connected PC go (the encrypted link's local port, or the Bluetooth one)
  const linkBase = () => (st.link ? 'http://' + st.link.ip + ':' + st.link.port : 'http://0.0.0.0:0');

  // Why this phone can't connect to st.pc right now: said where the user is looking. Retrying slows down meanwhile.
  function linkProblem(kind) {
    st.linkBlocked = kind;
    const name = '<b>' + esc(st.pc ? st.pc.name : 'your PC') + '</b>';
    let msg = '';
    if (kind === 'old') msg = 'Flick on ' + name + ' needs updating before this phone can connect: connections are now encrypted. Flick updates itself on the PC; restarting it there updates it now.';
    else if (kind === 'pin') msg = name + ' has a new security key, so this phone won’t connect to it. If you reinstalled Flick on that PC, <a href="#" id="repairBtn">pair again</a>.';
    else if (kind === 'auth') msg = 'This phone couldn’t verify ' + name + '. Hold Connect to pair again, and check that both screens show the same code.';
    if (st.screen === 'pair') {
      pairHint(msg);
      const b = $('repairBtn');
      if (b) b.onclick = (e) => { e.preventDefault(); repair(); };
    } else if (st.problemShown !== kind) {
      st.problemShown = kind;
      toast(msg.replace(/<[^>]+>/g, '').replace(/ If you reinstalled.*$/, ''), 4200);
      if (kind !== 'old') { closeLink(); showScreen('pair'); linkProblem(kind); }
    }
  }
  // forget this PC's key and pairing: the next connection pairs again (with the code on both screens)
  function repair() {
    if (!st.pc) return;
    pref.set(tokenKey(st.pc.id), ''); pref.set(pinKey(st.pc.id), '');
    st.linkBlocked = ''; st.problemShown = '';
    pairHint('Hold Connect, then check that your PC shows the same code as this phone.');
    openLink();
  }

  function openLink(resume) {
    if (!st.pc) return;
    const gen = ++wsGen;
    clearTimeout(reconnectT);
    if (st.ws) { try { st.ws.close(); } catch (e) { /* ignore */ } }
    st.ws = null; st.wsOpen = false; st.connecting = true;
    prepareLink(st.pc).then((lk) => {
      if (gen !== wsGen) return;
      if (!lk) { st.connecting = false; scheduleReconnect(st.linkBlocked ? 20000 : 0); return; }
      st.linkBlocked = ''; st.problemShown = '';
      // an encrypted link to an address the phone no longer uses is closed, unless files are still moving over it
      const old = st.link;
      if (old && old.key !== lk.key && old.chan !== 'bluetooth' && !busyMoving()) nc('tlsClose', old.port);
      st.link = lk;
      connectWs(gen, resume);
    });
  }

  function connectWs(gen, resume) {
    let ws;
    try { ws = new WebSocket('ws://' + st.link.ip + ':' + st.link.port + '/ws'); } catch (e) { st.connecting = false; scheduleReconnect(); return; }
    st.ws = ws;
    ws.onopen = () => {
      if (gen !== wsGen) return;
      st.wsOpen = true; st.connecting = false; st.lastRx = Date.now();
      // protocol 4: no token in hello. A paired PC answers with proof that it holds this phone's token ('auth?').
      st.nonceP = rhex(16); st.pcProved = false;
      ws.send(JSON.stringify({ t: 'hello', v: 4, device: DEVICE, name: phoneName(), nonce: st.nonceP, w: innerWidth, h: innerHeight, dpr: devicePixelRatio, resume: !!resume, app: MY_CODE, appName: INFO.version || '', via: st.pc.via || 'wifi', sdk: INFO.sdk || 0 }));
      clearInterval(pingT);
      pingT = setInterval(() => {
        if (gen !== wsGen) return;
        // a link that went silent (PC asleep, laptop changed network) can take many minutes to report closing by itself:
        // the PC answers every ping, so 25 s of nothing means it's gone — give up on this socket and reconnect
        if (Date.now() - (st.lastRx || 0) > 25000) { wsGen++; try { ws.close(); } catch (x) { /* ignore */ } linkLost(); return; }
        wsSend({ t: 'ping', ts: Date.now() });
      }, 10000);
    };
    ws.onmessage = (e) => { if (gen !== wsGen) return; st.lastRx = Date.now(); let m; try { m = JSON.parse(e.data); } catch (x) { return; } onMsg(m); };
    ws.onclose = () => { if (gen !== wsGen) return; linkLost(); };
    ws.onerror = () => { /* onclose follows */ };
  }

  function linkLost() {
    const was = st.connected;
    st.wsOpen = false; st.connected = false; st.connecting = false; st.pcProved = false;
    clearInterval(pingT);
    updateConn();
    for (const [tid, p] of st.pending) {
      if (p.phase === 'lifted') st.pending.delete(tid);
      // the file already reached the PC; the "saved" note just can't arrive now
      else if (p.phase === 'sent' && p.uploaded) { st.pending.delete(tid); for (const it of itemsOf(p)) if (it.path || st.keep) restoreItem(it); }
    }
    st.pairAsked = false; st.awaitingApproval = false;
    // another phone took over this PC: wait for the user rather than fighting over it
    if (st.replaced) { st.wantResume = false; return; }
    if (was) { st.wantResume = true; if (!document.hidden) toast('Reconnecting to ' + st.pc.name + '…', 1800); }
    scheduleReconnect();
  }

  let lostSince = 0;
  function scheduleReconnect(ms) {
    clearTimeout(reconnectT);
    if (!lostSince) lostSince = Date.now();
    if (st.wantResume && !st.linkBlocked && Date.now() - lostSince > 12000 && st.screen === 'main' && !st.lostToast) {
      st.lostToast = true;
      toast('Lost connection to your PC. Flick will reconnect when it’s back.', 2800);
    }
    reconnectT = setTimeout(() => openLink(st.wantResume), ms || (document.hidden ? 4000 : (st.connectWanted ? 500 : 1200)));
  }

  function updateConn() {
    $('cdot').classList.toggle('on', st.connected);
    nc('keepAwake', st.screen === 'main' && st.connected);
    if (SEL.on) renderSelection();
  }

  // "connect" on the user's go-ahead. Not paired yet (protocol 4): it also commits to this phone's half of the pairing
  // code (a hash of a random number, revealed only once the PC has answered with its half: see 'pairing'), so nobody
  // in between can steer the code the two screens show.
  function sendConnectUser() {
    if (st.trusted) return wsSend({ t: 'connect', user: true });
    st.pairNonce = rhex(16); st.pairCode = '';
    return wsSend({ t: 'connect', user: true, commit: nc('sha256', st.pairNonce) || '' });
  }

  // The hold finished: connect now, or as soon as the link to the PC is up (never fail just because it's still linking).
  function requestConnect() {
    st.replaced = false; st.pairAsked = true;
    if (st.wsOpen && sendConnectUser()) return;
    st.connectWanted = Date.now();
    pairHint('Connecting to <b>' + esc(st.pc ? st.pc.name : 'your PC') + '</b>…');
    G.hold = Math.max(G.hold, 0.5);
    if (!st.connecting) openLink();
    clearTimeout(connectT);
    connectT = setTimeout(() => {
      if (!st.connectWanted) return;
      st.connectWanted = 0;
      G.hold = 0;
      haptic('reject');
      pairHint('Can’t reach <b>' + esc(st.pc ? st.pc.name : 'your PC') + '</b>' + (st.pc ? ' at ' + esc(st.pc.ip) : '') + '. Make sure Flick is open on the PC and both are on the same Wi-Fi, then try again.');
    }, 10000);
  }

  // The phone's own view of trust: it holds a token for this PC id, given by that PC when the user allowed pairing.
  // Only such a PC can say "connected", send files, or offer an update; anything else on the network is ignored.
  const hasToken = () => !!(st.pc && pref.get(tokenKey(st.pc.id), ''));
  const linkTrusted = () => st.connected && hasToken() && st.pcProved;

  function onMsg(m) {
    switch (m.t) {
      case 'auth?': {
        // Sign-in: the PC shows it holds this phone's token (an HMAC over both random numbers and the link's identity:
        // the certificate this phone sees, or "bluetooth"). Only then does the phone prove the same in return; the
        // token itself never crosses the network.
        if (!st.pc || !st.link || (m.pc && m.pc.id && m.pc.id !== st.pc.id)) { closeLink(); break; }
        const chan = st.link.chan, nS = String(m.nonce || '');
        const want = /^[0-9a-f]{32,64}$/.test(nS) ? nc('authProof', st.pc.id, 'pc', st.nonceP, nS, chan) : '';
        if (!want || want !== m.proof) {
          // not the PC this phone paired with, or it no longer knows this phone: prove nothing to it
          wsSend({ t: 'auth', proof: 'none' });
          if (hasToken()) linkProblem('auth');
          break;
        }
        st.pcProved = true;
        wsSend({ t: 'auth', proof: nc('authProof', st.pc.id, 'phone', st.nonceP, nS, chan) });
        // it proved itself over this very link: a PC paired before 1.9 gets its certificate pinned now
        if (st.link.fp && !pref.get(pinKey(st.pc.id), '')) { pref.set(pinKey(st.pc.id), st.link.fp); st.link.pinned = true; }
        break;
      }
      case 'token':
        // the PC's first sign-in from this phone over a secure link replaces a token that may have travelled in the clear
        if (st.pcProved && typeof m.token === 'string' && /^[0-9a-f]{32}$/.test(m.token)) pref.set(tokenKey(st.pc.id), m.token);
        break;
      case 'welcome':
        // a different PC answered at this address (its IP went to another computer): leave every pairing alone
        if (m.pc && m.pc.id && st.pc && m.pc.id !== st.pc.id) { closeLink(); break; }
        lostSince = 0;
        st.trusted = !!m.trusted && st.pcProved;    // trusted only after the PC proved itself ('auth?')
        st.pcProto = +m.v || 1;                 // 2+: large files travel in several parts at once
        if (m.side) st.side = m.side;
        if (m.theme) applyTheme(m.theme);
        if (m.pc && m.pc.name && st.pc) { st.pc.name = m.pc.name; pref.set('lastPcName', m.pc.name); setPcName(); }
        // the PC doesn't know this phone (any more): its pairing is over. Believed only from a PC this phone can be
        // sure of (pinned certificate, or Bluetooth), so a stranger can't make it throw a pairing away.
        if (!m.trusted && (st.link.pinned || st.link.chan === 'bluetooth') && m.why !== 'auth' && !st.pcProved) pref.set(tokenKey(st.pc.id), '');
        if (st.connectWanted && Date.now() - st.connectWanted < 10000) { st.connectWanted = 0; st.pairAsked = true; clearTimeout(connectT); sendConnectUser(); }
        else if (st.wantResume && st.trusted && !st.connected && !st.replaced) wsSend({ t: 'connect' });   // pick the session back up
        else if (st.screen === 'pair' && !st.linkBlocked) pairHint('');
        break;
      case 'pairing': {
        if (!st.pairAsked || !st.pairNonce) break;  // only after this phone asked to connect
        const nS = String(m.nonce || '');
        if (!/^[0-9a-f]{32,64}$/.test(nS)) break;   // a PC that can't show a pairing code isn't paired with
        // the PC's half of the code is here: now this phone reveals its own, and both screens show the same code
        wsSend({ t: 'pair-reveal', nonce: st.pairNonce });
        st.pairCode = nc('pairCode', st.link.chan, st.pairNonce, nS) || '';
        st.awaitingApproval = true;
        setPcName();
        pairHint('Click <b>Allow</b> on your PC only if it shows this code:<br><b class="pcode">' + esc(st.pairCode.slice(0, 3) + ' ' + st.pairCode.slice(3)) + '</b>');
        G.hold = 0.35;
        break;
      }
      case 'paired':
        if (!st.pairAsked || !st.pairCode || typeof m.token !== 'string' || !/^[0-9a-f]{32}$/.test(m.token)) break;   // never a pairing this phone didn't ask for
        pref.set(tokenKey(st.pc.id), m.token);
        // the certificate of the PC the user just approved is the one this phone trusts from now on
        if (st.link && st.link.fp) { pref.set(pinKey(st.pc.id), st.link.fp); st.link.pinned = true; }
        st.pcProved = true;
        st.trusted = true; st.awaitingApproval = false; st.pairAsked = false; st.pairNonce = ''; st.pairCode = '';
        break;
      case 'denied':
        st.pairAsked = false;
        st.awaitingApproval = false; setPcName();
        pairHint('The PC said no. Try again and click <b>Allow</b> on the PC.');
        G.hold = 0;
        haptic('reject');
        break;
      case 'connected':
        if (!hasToken() || !st.pcProved) break;
        lostSince = 0; st.lostToast = false;
        st.connected = true; st.trusted = true; st.awaitingApproval = false; st.connectWanted = 0;
        clearTimeout(connectT);
        if (m.side) st.side = m.side;
        if (m.theme) applyTheme(m.theme);
        if (m.pc && m.pc.name) { st.pc.name = m.pc.name; pref.set('lastPcName', m.pc.name); }
        updateConn();
        UPD.pcKnows = 'app' in m;               // PCs before 1.4 can't hand out phone updates
        onAppInfo(m.app);
        if (st.screen === 'pair') {
          haptic('confirm');
          G.hold = 1;
          pairHint('');
          flashScreen(() => { showScreen('main'); G.hold = 0; staggerIn(); });
        } else if (st.wantResume) {
          toast('Connected to ' + st.pc.name, 1400);
        }
        st.wantResume = false;
        break;
      case 'settings':
        if (m.side) st.side = m.side;
        if (m.theme && m.theme !== st.theme) { applyTheme(m.theme); refreshThemeSheet(); }
        break;
      case 'pc':
        if (m.name && st.pc) { st.pc.name = m.name; setPcName(); }
        break;
      case 'busy':
        // another phone has the PC; this one picked its session back up on its own, so don't push it off — wait for the user
        st.wantResume = false; st.replaced = true; st.connectWanted = 0; st.pairAsked = false;
        if (st.screen === 'pair') { G.hold = 0; pairHint('Another phone is connected to <b>' + esc(st.pc ? st.pc.name : 'your PC') + '</b>. Hold to switch to this one.'); }
        else toast('Another phone is using ' + (st.pc ? st.pc.name : 'your PC') + '. Hold Connect to switch.', 3000);
        break;
      case 'replaced':
        st.wantResume = false; st.replaced = true;
        toast('Another phone is using ' + (st.pc ? st.pc.name : 'your PC') + ' now. Hold Connect to switch back.', 3200);
        break;
      case 'saved': if (linkTrusted()) onSaved(m); break;
      case 'failed': if (linkTrusted()) onFailed(m); break;
      case 'incoming': if (linkTrusted()) onIncoming(m); break;
      case 'edge': if (linkTrusted()) onEdge(m); break;
      case 'app': if (linkTrusted()) { UPD.pcKnows = true; onAppInfo(m.app, true); } break;
      default: break;
    }
  }

  // ------------------------------------------------------------------ updates (from GitHub, or over Wi-Fi from the PC)
  // Both sources offer { code, name, size, sha256, url }; the newer one wins. Whatever is downloaded, Android-side
  // code checks it is Flick, that exact version, and signed with Flick's key before it can be installed.
  const isNewer = (a) => !!(a && a.code > MY_CODE);
  const GH_DL = /^https:\/\/github\.com\/Maniw1234\/flick\/releases\/download\//;
  const canFetch = (a) => !!a && (a.src === 'github' || !!(st.connected && st.pc));

  function bestApp() {
    const p = UPD.pcApp, g = UPD.ghApp;
    if (!p || !g) return p || g;
    if (g.code !== p.code) return g.code > p.code ? g : p;
    return st.connected ? p : g;                        // same version: over Wi-Fi when connected
  }

  function applyApp() {
    const was = UPD.app;
    UPD.app = bestApp();
    if (isNewer(UPD.app) && (!was || was.code !== UPD.app.code || was.sha256 !== UPD.app.sha256) && !/^(downloading|installing|perm)$/.test(UPD.state)) UPD.state = 'ready';
    if (!isNewer(UPD.app) && UPD.state !== 'installing') UPD.state = 'idle';
    renderUpd();
    if (UPD.state === 'ready' && canFetch(UPD.app)) autoFetch();
  }

  function onAppInfo(app, answer) {
    UPD.pcApp = app && app.code && app.size > 0 && /^[0-9a-f]{64}$/i.test(app.sha256 || '') && app.url ? Object.assign({}, app, { src: 'pc' }) : null;
    applyApp();
    if (answer && UPD.checkT && !UPD.ghAsk) {
      // reply to "Check for updates" (when GitHub isn't being asked)
      clearTimeout(UPD.checkT); UPD.checkT = 0;
      if (isNewer(UPD.app)) { UPD.dismissed = 0; renderUpd(); }
      else toast('Flick is up to date (' + (INFO.version || 'this version') + ')', 2200);
    }
  }

  // GitHub: the latest release of github.com/Maniw1234/flick carries Flick-<version>.apk
  function checkGitHub(ask) {
    if (!NV || typeof NV.updateCheckGitHub !== 'function') return false;
    if (!ask && settings.autoUpdate === false) return false;
    UPD.ghAt = Date.now();
    if (ask) UPD.ghAsk = true;
    nc('updateCheckGitHub');
    return true;
  }

  function ghRelease(body) {
    const r = JSON.parse(body);
    if (!r || r.draft || r.prerelease) return null;
    for (const as of r.assets || []) {
      const m = /^Flick-(\d{1,3})\.(\d{1,2})\.(\d{1,2})\.apk$/.exec((as && as.name) || '');
      const d = /^sha256:([0-9a-f]{64})$/i.exec((as && as.digest) || '');
      if (m && d && as.size > 0 && GH_DL.test(as.browser_download_url || '')) {
        return { src: 'github', code: +m[1] * 10000 + +m[2] * 100 + +m[3], name: +m[1] + '.' + +m[2] + '.' + +m[3], size: +as.size, sha256: d[1].toLowerCase(), url: as.browser_download_url };
      }
    }
    return null;
  }

  function onGitHub(e) {
    if (e.ok) { try { UPD.ghApp = ghRelease(e.body); } catch (x) { UPD.ghApp = null; } }
    const ask = UPD.ghAsk;
    UPD.ghAsk = false;
    applyApp();
    if (ask && UPD.checkT) {
      clearTimeout(UPD.checkT); UPD.checkT = 0;
      if (isNewer(UPD.app)) { UPD.dismissed = 0; renderUpd(); }
      else toast(e.ok ? 'Flick is up to date (' + (INFO.version || 'this version') + ')' : 'Couldn’t reach GitHub. Try again.', 2400);
    }
  }

  setTimeout(() => checkGitHub(false), 2500);
  setInterval(() => { if (!document.hidden && Date.now() - UPD.ghAt > 3 * 3600e3) checkGitHub(false); }, 10 * 60e3);

  // a newer version is out: fetch it in the background, so installing takes one tap
  function autoFetch() {
    const a = UPD.app;
    if (!isNewer(a) || !canFetch(a) || settings.autoUpdate === false) return;
    const ns = njson('updateState');
    if (!ns) return;                                    // this phone app can't update itself
    if (ns.ready === a.code && ns.readySha === a.sha256.slice(0, 16).toLowerCase()) { UPD.state = 'fetched'; renderUpd(); return; }
    if (ns.busy) return;
    UPD.auto = true;
    UPD.state = 'downloading'; UPD.got = 0; UPD.total = a.size || 0; UPD.why = '';
    renderUpd();
    if (nc('updateDownload', updUrl(a), String(a.code), String(a.size), a.sha256) === null) { UPD.auto = false; UPD.state = 'ready'; renderUpd(); }
  }

  function updUrl(a) {
    if (a.src === 'github') return a.url;
    const tok = pref.get(tokenKey(st.pc.id), '');
    return linkBase() + a.url + '?device=' + encodeURIComponent(DEVICE) + '&token=' + encodeURIComponent(tok);
  }

  function startUpdate() {
    const a = UPD.app;
    if (!isNewer(a)) return;
    UPD.dismissed = 0;
    if (!canFetch(a)) { toast('Connect to your PC to update', 2200); renderUpd(); return; }
    const ns = njson('updateState') || {};
    if (ns.ready === a.code && ns.readySha === a.sha256.slice(0, 16).toLowerCase()) { installUpdate(); return; }      // already downloaded and checked
    UPD.auto = false;
    UPD.state = 'downloading'; UPD.got = 0; UPD.total = a.size || 0; UPD.why = '';
    renderUpd();
    haptic('tick');
    if (nc('updateDownload', updUrl(a), String(a.code), String(a.size), a.sha256) === null) { UPD.state = 'error'; UPD.why = 'unsupported'; renderUpd(); }
  }

  function installUpdate() {
    UPD.state = 'installing';
    renderUpd();
    nc('updateInstall');
  }

  function checkForUpdates() {
    const gh = checkGitHub(true);
    if (!gh && !st.connected) { toast('Connect to your PC to check for updates', 2400); return; }
    clearTimeout(UPD.checkT);
    UPD.checkT = setTimeout(() => {
      UPD.checkT = 0; UPD.ghAsk = false;
      toast(gh || UPD.pcKnows ? 'Couldn’t check right now. Try again.' : 'Update Flick on your PC to get phone updates', 2800);
    }, gh ? 15000 : 4000);
    if (st.connected) wsSend({ t: 'app-check' });
  }

  function updWhy(w) {
    w = String(w || '');
    const gh = !!(UPD.app && UPD.app.src === 'github');
    if (/checksum|incomplete|too long|size changed|bad size/.test(w)) return 'The download didn’t arrive intact. Try again.';
    if (gh && /^http /.test(w)) return 'GitHub didn’t send the update (' + w + '). Try again later.';
    if (/^http 403/.test(w)) return 'Your PC didn’t recognize this phone. Reconnect first.';
    if (/^http (404|409)/.test(w)) return 'The update on your PC changed. Try again.';
    if (/not newer/.test(w)) return 'You already have this version.';
    if (/signature|not Flick|not an app|unexpected version/.test(w)) return 'That file isn’t a genuine Flick update.';
    if (/installer/.test(w)) return 'Android’s installer didn’t open.';
    if (/settings/.test(w)) return 'Android settings didn’t open.';
    if (/no space/.test(w)) return 'Your phone is out of space.';
    if (/unsupported/.test(w)) return 'Install this update from your PC once.';
    return gh ? 'Couldn’t reach GitHub. Try again.' : 'Couldn’t reach your PC. Try again.';
  }

  function renderUpd() {
    const a = UPD.app, card = $('upd');
    const newer = isNewer(a);
    $('moreBtn').classList.toggle('dot', newer && UPD.state !== 'installing');
    // a step the user started stays visible; anything else respects "Not now"
    const started = /^(downloading|installing|perm)$/.test(UPD.state) && !UPD.auto;
    const show = newer && st.screen === 'main' && !SEL.on && (started || UPD.dismissed !== a.code);
    document.body.classList.toggle('upd-on', !!show);
    if (!show) { card.hidden = true; return; }
    const v = a.name || String(a.code);
    const pc = a.src === 'github' ? 'GitHub' : st.pc ? st.pc.name : 'your PC';
    let title, sub, btn = '';
    switch (UPD.state) {
      case 'downloading': {
        const p = UPD.total ? Math.min(100, Math.round(UPD.got / UPD.total * 100)) : 0;
        title = 'Downloading Flick ' + v; sub = p + '% from ' + pc;
        $('updBar').style.width = p + '%';
        break;
      }
      case 'installing': title = 'Installing Flick ' + v; sub = 'Tap Update when Android asks'; $('updBar').style.width = '100%'; break;
      case 'perm': title = 'Allow Flick to update itself'; sub = 'Turn on “Allow from this source”, then go back'; break;
      case 'denied': title = 'Allow Flick updates'; sub = 'A one-time Android permission'; btn = 'Allow'; break;
      case 'back': title = 'Flick ' + v + ' is downloaded'; sub = 'Tap Install to finish'; btn = 'Install'; break;
      case 'fetched': title = 'Flick ' + v + ' is ready'; sub = 'Downloaded from ' + pc; btn = 'Install'; break;
      case 'error': title = 'Update didn’t finish'; sub = updWhy(UPD.why); btn = 'Try again'; break;
      default: title = 'Flick ' + v + ' is ready'; sub = a.src === 'github' ? 'New version on GitHub' : 'Over Wi-Fi from ' + pc; btn = 'Update';
    }
    $('updTitle').textContent = title;
    $('updSub').textContent = sub;
    $('updBtn').textContent = btn;
    $('updBtn').hidden = !btn;
    card.classList.toggle('busy', UPD.state === 'downloading' || UPD.state === 'installing' || UPD.state === 'perm');
    if (card.hidden) { card.hidden = false; haptic('soft'); }
  }

  $('updBtn').onclick = () => {
    if (UPD.state === 'back' || UPD.state === 'denied' || UPD.state === 'fetched') installUpdate();
    else startUpdate();
  };
  $('updClose').onclick = () => {
    if (UPD.app) UPD.dismissed = UPD.app.code;
    if (UPD.state === 'error' || UPD.state === 'denied') UPD.state = 'ready';
    haptic('soft');
    renderUpd();
  };

  function onUpdEvent(e) {
    switch (e.t) {
      case 'upd': UPD.got = +e.got || 0; UPD.total = +e.total || UPD.total; if (UPD.state === 'downloading') renderUpd(); break;
      case 'upd-done':
        if (e.ok && UPD.auto) { UPD.auto = false; UPD.state = 'fetched'; renderUpd(); haptic('soft'); }   // fetched in the background: wait for a tap
        else if (e.ok) installUpdate();
        else { UPD.auto = false; UPD.state = 'error'; UPD.why = e.why; renderUpd(); }
        break;
      case 'upd-installing': UPD.state = 'installing'; renderUpd(); break;
      case 'upd-perm': UPD.state = 'perm'; renderUpd(); break;
      case 'upd-perm-denied': UPD.state = 'denied'; renderUpd(); break;
      case 'upd-back': UPD.state = 'back'; renderUpd(); break;     // the installer was closed without updating
      case 'upd-fail': UPD.state = 'error'; UPD.why = e.why; haptic('reject'); renderUpd(); break;
      default: break;
    }
  }

  // ------------------------------------------------------------------ hold-to-connect
  const btn = $('connect');
  const arc = btn.querySelector('.arc');
  const HOLD_MS = 950;
  const H = { down: false, t0: 0, p: 0, raf: 0, ticks: 0, sentAt: 0, done: false };
  function holdFrame(t) {
    if (H.down) H.p = clamp((t - H.t0) / HOLD_MS, 0, 1);
    else H.p = Math.max(0, H.p - 0.06);
    arc.style.strokeDashoffset = String(289 * (1 - easeOut(H.p)));
    G.hold = Math.max(G.hold * (H.down || st.awaitingApproval || st.connectWanted ? 1 : 0.9), H.p);
    const tick = Math.floor(H.p * 4);
    if (H.down && tick > H.ticks && tick < 4) { H.ticks = tick; haptic('tick'); }
    if (t - H.sentAt > 33) { H.sentAt = t; wsSend({ t: 'hold', p: H.p }); }
    if (H.down && H.p >= 1 && !H.done) {
      H.done = true; H.down = false;
      btn.classList.remove('down');
      requestConnect();
    }
    if (H.down || H.p > 0) H.raf = requestAnimationFrame(holdFrame);
    else { H.raf = 0; arc.style.strokeDashoffset = '289'; if (!st.awaitingApproval && !st.connected && !st.connectWanted) G.hold = 0; }
  }
  function holdStart(e) {
    if (btn.disabled) return;
    e.preventDefault();
    H.down = true; H.done = false; H.t0 = now() - H.p * HOLD_MS; H.ticks = Math.floor(H.p * 4);
    btn.classList.add('down');
    haptic('tick');
    if (!st.wsOpen && !st.connecting) openLink();
    if (!H.raf) H.raf = requestAnimationFrame(holdFrame);
  }
  function holdEnd() {
    if (!H.down) return;
    H.down = false;
    btn.classList.remove('down');
    if (!H.done) wsSend({ t: 'hold-cancel' });
  }
  btn.addEventListener('pointerdown', holdStart);
  btn.addEventListener('pointerup', holdEnd);
  btn.addEventListener('pointercancel', holdEnd);
  btn.addEventListener('pointerleave', holdEnd);
  btn.addEventListener('contextmenu', (e) => e.preventDefault());

  // ------------------------------------------------------------------ views (file manager)
  const CATS = [
    { v: 'recent', label: 'Recent' }, { v: 'photos', label: 'Photos' }, { v: 'videos', label: 'Videos' },
    { v: 'downloads', label: 'Downloads' }, { v: 'docs', label: 'Documents' }, { v: 'audio', label: 'Audio' },
    { v: 'apks', label: 'APKs' }, { v: 'storage', label: 'Phone storage' }, { v: 'shelf', label: 'Flick' },
  ];
  const PAGE = 240;
  const V = { cat: 'recent', path: null, title: 'Recent', items: [], more: false, total: 0, loading: false, stack: [], gen: 0, offset: 0 };

  const chips = $('chips');
  for (const c of CATS) {
    const b = document.createElement('button');
    b.className = 'chip';
    b.dataset.v = c.v;
    b.textContent = c.label;
    b.onclick = () => { haptic('soft'); openCat(c.v); };
    chips.appendChild(b);
  }

  let hdrH = 104;
  function measureHeader() {
    const h = $('hdr').offsetHeight;
    const top = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--top')) || 0;
    if (h > 0) { hdrH = h - top; root.setProperty('--hdr', Math.max(60, hdrH) + 'px'); }
  }

  function renderHeader() {
    $('htitle').textContent = V.title;
    const inDir = V.cat === 'dir';
    $('backBtn').hidden = !(inDir && V.stack.length);
    for (const b of chips.children) {
      const active = b.dataset.v === V.cat || (inDir && b.dataset.v === V.rootCat);
      b.classList.toggle('on', active);
    }
    let sub = '';
    if (V.loading && !V.items.length) sub = '<span class="spin"></span>Loading…';
    else if (inDir && V.path && STG.root && V.path.indexOf(STG.root) === 0 && V.path !== STG.root) {
      // breadcrumb, e.g. "Phone storage › DCIM › Camera"
      sub = esc(['Phone storage'].concat(V.path.slice(STG.root.length).split('/').filter(Boolean)).join('  ›  '));
    }
    $('hsub').innerHTML = sub;
    if (SEL.on) renderSelection();
  }

  function needsPermission() { return V.cat !== 'shelf' && !STG.granted; }

  function scrollActiveChip() {
    const b = chips.querySelector('.chip.on');
    if (b) { const r = b.getBoundingClientRect(); if (r.left < 8 || r.right > innerWidth - 8) chips.scrollBy({ left: r.left - innerWidth / 2 + r.width / 2, behavior: 'smooth' }); }
  }

  function resetView(cat, title) {
    if (SEL.on) setSelecting(false);
    V.gen++;
    V.cat = cat; V.title = title; V.items = []; V.more = false; V.total = 0; V.offset = 0; V.loading = false;
    st.hidden.clear();
    for (const [, el] of cards) el.remove();
    cards.clear();
    scroller.scrollTop = 0;
    $('empty').hidden = true;     // the last view's "Nothing here" mustn't show while this one loads
  }

  function openCat(cat) {
    const meta = CATS.find((c) => c.v === cat) || CATS[0];
    pref.set('lastView', cat);
    if (cat === 'downloads' || cat === 'storage') {
      const path = cat === 'downloads' ? STG.downloads : STG.root;
      V.stack = [];
      resetView('dir', meta.label);
      V.rootCat = cat;
      V.path = path;
      loadDir(path, meta.label);
      return;
    }
    V.stack = [];
    V.rootCat = cat;
    resetView(cat, meta.label);
    if (cat === 'shelf') { V.items = sortShelf(njson('library') || []); V.total = V.items.length; afterLoad(); return; }
    loadMore();
  }

  function sortShelf(list) { return list.sort((a, b) => (b.added || 0) - (a.added || 0)); }

  function openDir(path, title) {
    V.stack.push({ path: V.path, title: V.title, scroll: scroller.scrollTop });
    const rc = V.rootCat;
    resetView('dir', title);
    V.rootCat = rc;
    V.path = path;
    loadDir(path, title);
  }

  function showInFolder(dirPath) {
    const title = dirPath.split('/').pop() || 'Folder';
    resetView('dir', title);
    V.rootCat = 'storage';
    V.path = dirPath;
    V.stack = dirPath !== STG.root ? [{ path: STG.root, title: 'Phone storage', scroll: 0 }] : [];
    loadDir(dirPath, title);
  }

  function goBack() {
    const prev = V.stack.pop();
    if (!prev) return false;
    const rc = V.rootCat, stack = V.stack;
    resetView('dir', prev.title);
    V.rootCat = rc; V.stack = stack; V.path = prev.path;
    loadDir(prev.path, prev.title, prev.scroll);
    return true;
  }
  $('backBtn').onclick = () => { haptic('soft'); goBack(); };

  async function loadDir(path, title, restoreScroll) {
    if (needsPermission()) { afterLoad(); return; }
    const gen = V.gen;
    V.loading = true; renderHeader();
    const data = await nreqT(120000, 'listDirAsync', path || '');
    if (gen !== V.gen) return;
    V.loading = false;
    if (!data || data.error) { V.items = []; afterLoad(); toast(data ? 'Can’t open this folder' : 'This folder took too long to open', 2400); return; }
    V.items = data.items || [];
    V.total = V.items.length;
    if (data.name && V.stack.length === 0 && V.rootCat === 'storage') V.title = data.name;
    afterLoad();
    if (restoreScroll) requestAnimationFrame(() => { scroller.scrollTop = restoreScroll; renderWindow(false); });
  }

  async function loadMore() {
    if (needsPermission()) { afterLoad(); return; }
    if (V.loading) return;
    const gen = V.gen;
    V.loading = true; renderHeader();
    const data = await nreqT(120000, 'queryAsync', V.cat, V.offset, PAGE);
    if (gen !== V.gen) return;
    V.loading = false;
    if (!data) { afterLoad(); return; }
    const add = data.items || [];
    const seen = new Set(V.items.map((i) => i.id));
    for (const it of add) if (!seen.has(it.id)) V.items.push(it);
    V.offset += add.length;
    V.total = data.total || V.items.length;
    V.more = !!data.more && add.length > 0;
    afterLoad();
  }

  function afterLoad() {
    renderHeader();
    const perm = needsPermission();
    $('perm').hidden = !perm;
    if (perm) $('permSub').textContent = (STG.sdk || 30) >= 30
      ? 'Flick needs “All files access” to show everything on this phone, like the Files app. On the next screen, turn on “Allow access to manage all files”.'
      : 'Allow Flick to show the photos, videos and files on this phone, like the Files app.';
    layout(false);
    scrollActiveChip();
  }

  $('permBtn').onclick = () => { haptic('tick'); nc('askStorage'); };

  function refreshStorage(reload) {
    const was = STG.granted;
    STG = njson('storage') || STG;
    if (STG.granted !== was || reload) {
      if (V.cat === 'dir') {
        const path = V.path || (V.rootCat === 'downloads' ? STG.downloads : STG.root);
        const stack = V.stack, rc = V.rootCat, title = V.title;
        resetView('dir', title); V.stack = stack; V.rootCat = rc; V.path = path;
        loadDir(path, title);
      } else openCat(V.cat);
    }
  }

  // ------------------------------------------------------------------ grid (virtualized masonry)
  const grid = $('grid');
  const scroller = $('scroller');
  const cards = new Map(); // id -> rendered element
  const L = { pad: 14, gap: 12, meta: 46 };
  let geo = [];            // visible items with positions
  let gridH = 0;

  function thumbH(it, w) {
    if (it.dir) return Math.round(w * 0.56);
    if (it.kind === 'image' || it.kind === 'video') {
      const a = it.w && it.h ? it.w / it.h : 1;
      return Math.round(w / clamp(a, 0.62, 1.75));
    }
    if (it.kind === 'apk' || it.kind === 'audio') return Math.round(w);
    return Math.round(w / 0.76);
  }

  function visibleItems() { return V.items.filter((it) => !st.hidden.has(it.id)); }

  function updateCount() {
    let sending = 0, sent = 0, total = 0, rate = 0;
    for (const p of st.pending.values()) if (p.phase === 'sent' && !p.uploaded) { sending++; sent += p.sent || 0; total += p.total || 0; rate += p.rate || 0; }
    const n = needsPermission() ? 0 : V.cat === 'dir' ? visibleItems().filter((i) => !i.incoming).length : Math.max(V.total - st.hidden.size, visibleItems().length);
    const pct = total > 0 ? Math.min(99, Math.floor((sent / total) * 100)) : -1;
    $('count').textContent = sending ? 'Sending' + (pct >= 0 ? ' ' + pct + '%' : '…') + (rate > 0 && settings.showSpeed ? ' · ' + fmtRate(rate) : '') : n.toLocaleString() + (n === 1 ? ' item' : ' items');
    const empty = !V.loading && !needsPermission() && visibleItems().length === 0;
    $('empty').hidden = !empty;
    if (empty) {
      const msgs = {
        shelf: ['Nothing here yet', 'Tap <b>+</b> to add files, or use <b>Share → Flick</b> from any app. Files from your PC also land here.'],
        dir: ['This folder is empty', ''], photos: ['No photos', ''], videos: ['No videos', ''], docs: ['No documents', ''],
        audio: ['No audio files', ''], apks: ['No APK files', ''], recent: ['Nothing recent', ''],
      };
      const m = msgs[V.cat] || msgs.recent;
      $('emptyTitle').textContent = m[0];
      $('emptySub').innerHTML = m[1];
    }
  }

  function buildCard(it) {
    const c = document.createElement('div');
    c.className = 'card' + (it.dir ? ' folder' : '');
    c.dataset.id = it.id;
    const th = document.createElement('div');
    th.className = 'thumb';
    th.appendChild(Object.assign(document.createElement('i'), { className: 'check' }));
    if (it.dir) {
      th.appendChild(svgEl(FOLDER_SVG));
    } else {
      const isDoc = !(it.kind === 'image' || it.kind === 'video');
      if (isDoc) th.classList.add(it.kind === 'apk' || it.kind === 'audio' ? 'app' : 'doc');
      const src = thumbUrl(it);
      if (src) {
        const img = document.createElement('img');
        img.decoding = 'async';
        img.draggable = false;
        img.onload = () => img.classList.add('ok');
        img.onerror = () => { img.remove(); if (isDoc && it.kind !== 'apk' && it.kind !== 'audio') { th.classList.add('doc'); th.appendChild(Object.assign(document.createElement('div'), { className: 'doclines' })); } };
        c._img = img; c._src = src;          // loaded by renderWindow once the grid isn't flying past it
        th.appendChild(img);
        if (isDoc) th.classList.add('hasimg');
      } else if (isDoc) {
        th.classList.add('doc');
        const l = document.createElement('div'); l.className = 'doclines'; th.appendChild(l);
      }
      const b = badgeOf(it);
      if (b) { const s = document.createElement('span'); s.className = 'badge'; s.textContent = b; th.appendChild(s); }
      if (it.kind === 'video') {
        const p = document.createElement('div'); p.className = 'playb'; th.appendChild(p);
        if (it.dur) { const d = document.createElement('span'); d.className = 'dur'; d.textContent = fmtDur(it.dur); th.appendChild(d); }
      }
      const prog = svgEl('<svg class="prog" viewBox="0 0 28 28"><circle cx="14" cy="14" r="12" fill="rgba(0,0,0,.55)"/><circle class="arc" cx="14" cy="14" r="8.5" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-dasharray="53.4" stroke-dashoffset="53.4" transform="rotate(-90 14 14)"/></svg>');
      th.appendChild(prog);
    }
    c.appendChild(th);
    const meta = document.createElement('div');
    meta.className = 'meta';
    const n = document.createElement('div'); n.className = 'name'; n.textContent = midName(it.name);
    const i = document.createElement('div'); i.className = 'info';
    i.textContent = it.dir ? (it.count === 1 ? '1 item' : (it.count || 0) + ' items') : it.incoming ? 'Receiving…' : fmtSize(it.size) + ' · ' + fmtWhen(it.mtime || it.added);
    meta.appendChild(n); meta.appendChild(i);
    {
      const more = document.createElement('button'); more.className = 'more';
      more.appendChild(svgEl('<svg viewBox="0 0 24 24"><circle cx="5.5" cy="12" r="1.7" fill="currentColor"/><circle cx="12" cy="12" r="1.7" fill="currentColor"/><circle cx="18.5" cy="12" r="1.7" fill="currentColor"/></svg>'));
      more.onclick = (e) => { e.stopPropagation(); itemMenu(it); };
      meta.appendChild(more);
    }
    c.appendChild(meta);
    return c;
  }

  function setCardProgress(id, p) {
    const c = cards.get(id);
    if (!c) return;
    const pr = c.querySelector('.prog');
    if (!pr) return;
    pr.classList.toggle('on', p >= 0 && p < 1);
    pr.querySelector('.arc').style.strokeDashoffset = String(53.4 * (1 - clamp(p, 0, 1)));
  }

  let layoutGen = 0, maxCardH = 0;
  function computeLayout() {
    const W = innerWidth;
    const colW = (W - L.pad * 2 - L.gap) / 2;
    const cols = [0, 0];
    geo = visibleItems();
    layoutGen++; maxCardH = 0;
    for (const it of geo) {
      const c = cols[0] <= cols[1] + 1 ? 0 : 1;
      const th = thumbH(it, colW);
      it._x = L.pad + c * (colW + L.gap); it._y = cols[c]; it._w = colW; it._th = th;
      cols[c] += th + L.meta + L.gap;
      if (th + L.meta > maxCardH) maxCardH = th + L.meta;
    }
    gridH = Math.max(cols[0], cols[1]);
    grid.style.height = gridH + 'px';
  }

  function placeCard(el, it, animate, fresh) {
    el._gen = layoutGen; el._anim = !!(animate && !fresh);
    el.style.width = it._w + 'px';
    el.querySelector('.thumb').style.height = it._th + 'px';
    const tf = 'translate3d(' + it._x.toFixed(1) + 'px,' + it._y.toFixed(1) + 'px,0)';
    el.style.setProperty('--tf', tf);
    if (animate && !fresh) el.classList.add('anim'); else el.classList.remove('anim');
    el.style.transform = tf;
  }

  // how fast the grid is moving (px/s): thumbnails wait while it flies past
  const SV = { top: 0, t: 0, v: 0, settleT: 0 };
  function renderWindow(animate) {
    const st0 = scroller.scrollTop, tnow = performance.now();
    if (tnow - SV.t < 200) SV.v = Math.abs(st0 - SV.top) / Math.max(1, tnow - SV.t) * 1000; else SV.v = 0;
    SV.top = st0; SV.t = tnow;
    const top = st0 - innerHeight * 1.0;
    const bottom = st0 + innerHeight * 2.2;
    const keep = new Set();
    // geo is ordered by _y (masonry: within 1 px), so start at the first item that can reach `top`
    let lo = 0, hi = geo.length;
    const from = top - maxCardH - 2;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (geo[mid]._y < from) lo = mid + 1; else hi = mid; }
    const loadImgs = SV.v < 1500;                     // slow: the whole window
    const loadVisible = SV.v < 3000;                  // medium: what is on screen
    const visTop = st0 - 200, visBottom = st0 + innerHeight + 200;
    const visit = (it) => {
      keep.add(it.id);
      let el = cards.get(it.id);
      const fresh = !el;
      if (!el) { el = buildCard(it); cards.set(it.id, el); grid.appendChild(el); if (SEL.ids.has(it.id)) el.classList.add('sel'); }
      if (fresh || el._gen !== layoutGen || animate) placeCard(el, it, animate, fresh);
      else if (el._anim) { el._anim = false; el.classList.remove('anim'); }
      if (el._src && (loadImgs || (loadVisible && it._y + it._th > visTop && it._y < visBottom))) { el._img.src = el._src; el._src = null; }
      if (fresh && animate && it._popIn) { delete it._popIn; el.classList.add('pop'); setTimeout(() => el.classList.remove('pop'), 600); }
    };
    for (let i = lo; i < geo.length; i++) {
      const it = geo[i];
      if (it._y >= bottom + 2) break;
      if (it._y + it._th + L.meta > top) visit(it);
    }
    if (D && D.it && !keep.has(D.it.id) && geo.includes(D.it)) visit(D.it);
    for (const [id, el] of cards) {
      if (!keep.has(id)) { el.remove(); cards.delete(id); }
    }
    // once the grid slows down, the thumbnails it skipped are loaded
    clearTimeout(SV.settleT);
    if (!loadImgs) SV.settleT = setTimeout(() => { SV.t = 0; renderWindow(false); }, 140);
  }

  function layout(animate) {
    computeLayout();
    renderWindow(animate);
    updateCount();
  }

  let scrollRaf = 0;
  scroller.addEventListener('scroll', () => {
    if (scrollRaf) return;
    scrollRaf = requestAnimationFrame(() => {
      scrollRaf = 0;
      renderWindow(false);
      if (V.more && !V.loading && V.cat !== 'dir' && V.cat !== 'shelf' && scroller.scrollTop + innerHeight * 3 > gridH) loadMore();
    });
  }, { passive: true });

  function staggerIn() {
    let i = 0;
    const top = scroller.scrollTop, bottom = top + innerHeight;
    for (const it of geo) {
      const el = cards.get(it.id);
      if (!el || it._y > bottom || it._y + it._th < top - 50) continue;
      el.animate([{ opacity: 0, transform: el.style.transform + ' translateY(26px) scale(.94)' }, { opacity: 1, transform: el.style.transform }],
        { duration: 520, delay: 40 + i * 32, easing: 'cubic-bezier(.2,.9,.25,1)', fill: 'backwards' });
      i++;
    }
  }

  function addToShelf(list) {
    if (!list || !list.length) return;
    if (V.cat !== 'shelf') { openCat('shelf'); return; }
    for (const it of list.slice().reverse()) {
      if (V.items.find((x) => x.id === it.id)) continue;
      it._popIn = true;
      V.items.unshift(it);
    }
    V.total = V.items.length;
    scroller.scrollTo({ top: 0, behavior: 'smooth' });
    layout(true);
  }

  function dropItem(id, deleteFromShelf) { dropItems([id], deleteFromShelf); }
  // several at once: one layout, and one write of the Flick list on the phone (older phone apps: one at a time)
  function dropItems(ids, deleteFromShelf) {
    if (!ids.length) return;
    const set = new Set(ids), before = V.items.length;
    V.items = V.items.filter((x) => !set.has(x.id));
    for (const id of ids) st.hidden.delete(id);
    if (deleteFromShelf && nc('removeMany', JSON.stringify(ids)) === null) for (const id of ids) nc('remove', id);
    V.total = Math.max(0, V.total - (before - V.items.length));   // only what this view actually showed
    layout(true);
  }

  // A copy into the phone's Pictures / Movies / Music / Download folder. The app copies in the background (a long
  // video takes a while) and answers with a 'saved' event; older apps answered at once with the folder.
  function saveCopy(it) {
    const r = nc('saveCopy', it.id);
    if (typeof r === 'string') toast(r ? 'Saved to ' + r : 'Couldn’t save on this phone');
    else if (r === null) toast('Couldn’t save on this phone');
    else toast('Saving ' + midName(it.name) + '…', 1600);
  }
  function onSavedCopy(e) {
    if (e.ok) { toast('Saved to ' + (e.where || 'your phone'), 2200); haptic('tick'); return; }
    toast(e.why === 'unsupported' ? 'Saving a copy needs Android 10 or newer'
      : e.why === 'missing' ? 'That file is no longer in Flick' : 'Couldn’t save on this phone', 2600);
  }

  function itemMenu(it) {
    if (it.incoming) return;
    const pcName = st.pc ? st.pc.name : 'PC';
    const select = { label: 'Select', icon: 'check', run: () => { setSelecting(true); SEL.ids.add(it.id); renderSelection(); } };
    if (it.dir) {
      openSheet(it.name, [
        { label: 'Send folder to ' + pcName, icon: 'send', run: () => sendItems([it]) },
        { label: 'Open', icon: 'folder', run: () => openDir(it.path, it.name) },
        select,
      ]);
      return;
    }
    if (it.path) {
      const parent = it.path.replace(/\/[^/]*$/, '');
      openSheet(it.name, [
        { label: 'Send to ' + pcName, icon: 'send', run: () => sendItems([it]) },
        { label: 'Open', icon: 'open', run: () => { if (nc('openPath', it.path) === false) toast('Couldn’t open this file'); } },
        { label: 'Share', icon: 'share', run: () => nc('sharePath', it.path) },
        V.cat !== 'dir' || V.path !== parent ? { label: 'Show in folder', icon: 'folder', run: () => showInFolder(parent) } : null,
        select,
      ]);
      return;
    }
    openSheet(it.name, [
      { label: 'Send to ' + pcName, icon: 'send', run: () => sendItems([it]) },
      { label: 'Open', icon: 'open', run: () => { if (nc('open', it.id) === false) toast('Couldn’t open this file'); } },
      { label: 'Share', icon: 'share', run: () => nc('share', it.id) },
      { label: 'Save to phone', icon: 'save', run: () => saveCopy(it) },
      { label: 'Remove from Flick', icon: 'trash', danger: true, run: () => dropItem(it.id, true) },
      select,
    ]);
  }

  // ------------------------------------------------------------------ multi-select
  function selItems() { return V.items.filter((it) => SEL.ids.has(it.id) && !it.incoming); }
  function setSelecting(on) {
    SEL.on = !!on;
    if (!SEL.on) SEL.ids.clear();
    document.body.classList.toggle('selecting', SEL.on);
    renderSelection();
    if (!SEL.on) renderHeader();
  }
  function toggleSel(it) {
    if (SEL.ids.has(it.id)) SEL.ids.delete(it.id); else SEL.ids.add(it.id);
    haptic('tick');
    if (!SEL.ids.size) setSelecting(false); else renderSelection();
  }
  function renderSelection() {
    for (const [id, el] of cards) el.classList.toggle('sel', SEL.ids.has(id));
    $('selClose').hidden = !SEL.on;
    $('selAll').hidden = !SEL.on;
    $('selBar').hidden = !SEL.on;
    $('toolbar').hidden = SEL.on;
    renderUpd();
    if (!SEL.on) return;
    $('backBtn').hidden = true;
    const n = SEL.ids.size;
    $('htitle').textContent = n === 1 ? '1 selected' : n.toLocaleString() + ' selected';
    $('hsub').textContent = st.connected ? 'Drag to your PC, or tap Send' : 'Connect to your PC to send';
    const all = V.items.filter((it) => !it.incoming);
    $('selAll').textContent = all.length && all.every((it) => SEL.ids.has(it.id)) ? 'Select none' : 'Select all';
    const send = $('selSend');
    send.classList.toggle('off', !st.connected);
    $('selSendText').textContent = !st.connected ? 'Connect to send' : 'Send ' + (n === 1 ? '1 item' : n.toLocaleString() + ' items') + ' to ' + (st.pc ? st.pc.name : 'your PC');
  }
  $('selClose').onclick = () => { haptic('soft'); setSelecting(false); };
  $('selAll').onclick = () => {
    const all = V.items.filter((it) => !it.incoming);
    const every = all.every((it) => SEL.ids.has(it.id));
    if (every) SEL.ids.clear(); else for (const it of all) SEL.ids.add(it.id);
    haptic('tick');
    if (!SEL.ids.size) setSelecting(false); else renderSelection();
  };
  $('selSend').onclick = () => {
    if (!st.connected) { showScreen('pair'); openLinkSoon(); return; }
    sendItems(selItems());
  };

  // toolbar
  $('addBtn').onclick = () => {
    openSheet('Add to Flick', [
      { label: 'Photos & videos', icon: 'photo', run: () => nc('pick', 'media') },
      { label: 'Files', icon: 'file', run: () => nc('pick', 'files') },
    ]);
  };
  $('pcBtn').onclick = () => {
    if (st.connected) {
      openSheet('Connected to ' + st.pc.name, [
        { label: 'Disconnect', icon: 'off', danger: true, run: () => { st.wantResume = false; closeLink(); showScreen('pair'); openLinkSoon(); } },
      ]);
    } else {
      showScreen('pair');
      openLinkSoon();
    }
  };
  function openLinkSoon() { setTimeout(() => { if (st.pc && !st.wsOpen) openLink(); }, 300); }
  function themeSheet() {
    openSheet('Animation on your PC', []);
    const box = $('sheetItems');
    box.classList.add('tsheet');
    for (const t of THEMES) {
      const b = document.createElement('button');
      b.className = 'titem' + (t.v === st.theme ? ' on' : '');
      b.dataset.v = t.v;
      b.innerHTML = '<video muted loop playsinline autoplay preload="auto"></video><span class="tt"><span class="tn"></span><span class="td"></span></span><span class="tc"></span>';
      b.querySelector('video').src = 'themes/' + t.v + '.webm';
      b.querySelector('.tn').textContent = t.name;
      b.querySelector('.td').textContent = t.desc;
      b.onclick = () => {
        if (now() - sheetAt < 350) return;
        if (!st.connected) { toast('Connect to your PC to change the animation', 2400); return; }
        applyTheme(t.v);
        wsSend({ t: 'set-theme', theme: t.v });
        refreshThemeSheet();
        haptic('tick');
        toast(t.name + ' is playing on your PC', 1800);
      };
      box.appendChild(b);
    }
  }
  function refreshThemeSheet() {
    for (const b of document.querySelectorAll('.tsheet .titem')) b.classList.toggle('on', b.dataset.v === st.theme);
  }
  $('moreBtn').onclick = () => {
    const upd = isNewer(UPD.app);
    openSheet('', [
      upd ? { label: 'Update to Flick ' + (UPD.app.name || UPD.app.code), icon: 'update', tag: 'Ready', run: startUpdate } : null,
      { label: 'Animation', icon: 'spark', tag: themeOf(st.theme).name, run: themeSheet },
      { label: 'Refresh', icon: 'refresh', run: () => refreshStorage(true) },
      V.cat === 'shelf' && V.items.length ? { label: 'Clear the Flick list', icon: 'clear', danger: true, run: () => {
        V.total = 0;
        dropItems(V.items.map((x) => x.id), true);
      } } : null,
      { label: 'Settings', icon: 'gear', run: openSettings },
    ]);
  };

  // ------------------------------------------------------------------ Settings page
  const LINK_NAMES = { wifi: 'Wi-Fi', usb: 'USB cable', hotspot: 'hotspot', ethernet: 'Ethernet', bluetooth: 'Bluetooth' };
  function setSide(side) {
    if (side !== 'left' && side !== 'right') return;
    st.side = side;
    wsSend({ t: 'set-side', side });
  }
  function openSettings() {
    renderSettings();
    const pg = $('settings');
    pg.hidden = false; pg.classList.remove('closing');
    $('setBody').scrollTop = 0;
    haptic('soft');
  }
  function closeSettings() {
    const pg = $('settings');
    if (pg.hidden) return false;
    pg.classList.add('closing');
    setTimeout(() => { pg.hidden = true; pg.classList.remove('closing'); }, 200);
    return true;
  }
  $('setBack').onclick = closeSettings;
  function toggleEl(on, onChange) {
    const l = document.createElement('label'); l.className = 'stog';
    const i = document.createElement('input'); i.type = 'checkbox'; i.checked = !!on;
    i.onchange = () => { onChange(i.checked); haptic('tick'); };
    l.appendChild(i); l.appendChild(document.createElement('span'));
    return l;
  }
  function renderSettings() {
    const body = $('setBody');
    body.innerHTML = '';
    const group = (title, rows) => {
      const g = document.createElement('section'); g.className = 'sgroup';
      if (title) { const h = document.createElement('h3'); h.textContent = title; g.appendChild(h); }
      const card = document.createElement('div'); card.className = 'scard';
      for (const r of rows) {
        if (!r) continue;
        const row = document.createElement(r.run ? 'button' : 'div'); row.className = 'srow';
        const lab = document.createElement('div'); lab.className = 'sl';
        const b = document.createElement('b'); b.textContent = r.label; lab.appendChild(b);
        if (r.sub) { const sm = document.createElement('small'); sm.textContent = r.sub; lab.appendChild(sm); }
        row.appendChild(lab);
        if (r.value != null) { const v = document.createElement('span'); v.className = 'sv'; v.textContent = r.value; row.appendChild(v); }
        if (r.toggle) {
          const get = typeof r.toggle === 'string' ? () => settings[r.toggle] : r.toggle;
          row.appendChild(toggleEl(get(), (v) => { if (typeof r.toggle === 'string') { settings[r.toggle] = v; saveSettings(); } if (r.set) r.set(v); }));
        }
        if (r.seg) {
          const sg = document.createElement('div'); sg.className = 'sseg';
          for (const [v, label] of r.seg) {
            const bt = document.createElement('button'); bt.textContent = label; bt.className = r.get() === v ? 'on' : '';
            bt.onclick = (e) => { e.stopPropagation(); haptic('tick'); r.set(v); renderSettings(); };
            sg.appendChild(bt);
          }
          row.appendChild(sg);
        }
        if (r.action) {
          const ab = document.createElement('button'); ab.className = 'sbtn' + (r.action.danger ? ' danger' : ''); ab.textContent = r.action.text;
          ab.onclick = (e) => { e.stopPropagation(); r.action.run(); };
          row.appendChild(ab);
        }
        if (r.run) { row.classList.add('nav'); row.onclick = () => { haptic('soft'); r.run(); }; }
        card.appendChild(row);
      }
      g.appendChild(card);
      body.appendChild(g);
    };
    const via = st.pc && st.pc.via ? LINK_NAMES[st.pc.via] || st.pc.via : 'Wi-Fi';
    group('Your PC', [
      st.pc ? {
        label: st.pc.name || 'PC',
        sub: st.connected ? 'Connected over ' + via : st.connecting ? 'Connecting…' : 'Not connected',
        action: st.connected
          ? { text: 'Disconnect', danger: true, run: () => { st.wantResume = false; closeLink(); closeSettings(); showScreen('pair'); openLinkSoon(); } }
          : { text: 'Connect', run: () => { closeSettings(); showScreen('pair'); openLinkSoon(); } },
      } : { label: 'No PC yet', sub: 'Open Flick on your PC, then hold Connect', action: { text: 'Connect', run: () => { closeSettings(); showScreen('pair'); } } },
      { label: 'Ways to connect', sub: 'Wi-Fi, USB cable, hotspot or Bluetooth', run: waysSheet },
    ]);
    group('Transfers', [
      { label: 'Faster transfers', sub: 'Large files travel over several connections at once', toggle: 'parallel' },
      { label: 'Show transfer speed', toggle: 'showSpeed', set: () => updateCount() },
      { label: 'Use Bluetooth when there’s no Wi-Fi', sub: settings.bluetooth ? BT_TEXT[st.btState || 'off'] || BT_TEXT.off : BT_TEXT.off, toggle: 'bluetooth', set: (v) => { btSetting(v); renderSettings(); } },
      { label: 'Keep files in the Flick list after sending', toggle: () => st.keep, set: (v) => { st.keep = v; pref.set('keep', v ? '1' : '0'); } },
      { label: 'Files from your PC', value: 'Download/Flick' },
    ]);
    group('This phone', [
      { label: 'Phone name', sub: 'How your PC shows this phone', value: phoneName(), run: renamePhone },
      { label: 'Animation on your PC', value: themeOf(st.theme).name, run: themeSheet },
      { label: 'Phone is on the', sub: 'Which side of the PC screen', seg: [['left', 'Left'], ['right', 'Right']], get: () => st.side, set: setSide },
      { label: 'Vibration', toggle: 'haptics' },
    ]);
    group('Updates', [
      { label: 'Check for updates automatically', sub: 'From GitHub, when Flick opens', toggle: 'autoUpdate' },
      { label: 'Flick ' + (INFO.version || ''), action: { text: 'Check now', run: checkForUpdates } },
    ]);
  }
  // ------------------------------------------------------------------ Bluetooth (when there's no network between phone and PC)
  let btWanted = false;
  const BT_TEXT = {
    off: 'Much slower than Wi-Fi. Pair this phone with your PC in Bluetooth settings first.',
    searching: 'Looking for your PC over Bluetooth…', on: 'Connected over Bluetooth',
    denied: 'Flick needs permission to use Bluetooth', 'radio-off': 'Turn on Bluetooth on this phone', unsupported: 'This phone has no Bluetooth',
  };
  function btSetting(on) {
    if (on) nc('btPermission');
    btTick();
  }
  function btTick() {
    // only when allowed in Settings, for a PC this phone knows, and only while no network path to it exists
    const known = !!(st.pc && pref.get('lastPc', ''));
    const lan = !!(st.pc && (st.lanList || []).some((p) => p.id === st.pc.id));
    const onBtNow = !!(st.connected && st.pc && st.pc.via === 'bluetooth');
    const quiet = Date.now() - (st.lanSeenAt || 0) > 6000;
    // Connected over Bluetooth: keep the link until the session has moved to a faster one (onPcs moves it once nothing
    // is in flight) — dropping it first would cut the session. In the background it stays only while files move.
    if (onBtNow && lan && !busyMoving()) onPcs();
    const want = !!settings.bluetooth && known &&
      (onBtNow ? (!document.hidden || busyMoving()) : (!document.hidden && !lan && quiet && !(st.connected && st.pc.via !== 'bluetooth')));
    if (want !== btWanted) { btWanted = want; nc('btWant', want); }
  }
  setInterval(btTick, 3000);
  function onBt(e) {
    st.btState = e.state || 'off';
    st.btPc = e.state === 'on' && e.pc && e.pc.id ? Object.assign({}, e.pc, { via: 'bluetooth' }) : null;
    onPcs();
    if (!$('settings').hidden) renderSettings();
  }

  function renamePhone() {
    askText({
      title: 'Phone name', sub: 'Shown on your PC', value: phoneName(), placeholder: DEVNAME, ok: 'Save', mode: 'text',
      done: (v) => {
        settings.phoneName = v.trim().slice(0, 40);
        saveSettings();
        renderSettings();
        if (st.connected) openLink(true);       // the PC learns the new name on the next hello
        return true;
      },
    });
  }
  function waysSheet() {
    openSheet('Ways to connect', [
      { label: 'Same Wi-Fi as your PC', icon: 'wifi', tag: 'Fast', run: () => toast('Put the phone and the PC on the same Wi-Fi, then hold Connect', 3200) },
      { label: 'USB cable', icon: 'usb', tag: 'Fastest', run: () => toast('Plug the phone into the PC, then turn on USB tethering in Android’s Hotspot & tethering settings', 4200) },
      { label: 'Your phone’s hotspot', icon: 'hotspot', tag: 'No Wi-Fi needed', run: () => toast('Turn on the phone’s hotspot and join it from the PC; Flick finds the PC by itself', 4200) },
      { label: 'Bluetooth', icon: 'bt', tag: 'Slow', run: () => { if (!settings.bluetooth) { settings.bluetooth = true; saveSettings(); btSetting(true); } toast('Pair this phone with the PC in Bluetooth settings; Flick uses it when there’s no network', 4200); } },
    ]);
  }

  // ------------------------------------------------------------------ edge glow (phone side)
  const edge = $('edgeGlow');
  const EG = { o: 0, target: 0, y: innerHeight / 2, h: 360, flashT: 0, raf: 0, last: 0, hover: false };
  function edgeX() { return st.side === 'right' ? 0 : innerWidth; }
  function egFrame(t) {
    const dt = Math.min(48, t - (EG.last || t)); EG.last = t;
    let target = EG.target;
    if (EG.flashT) {
      const u = (t - EG.flashT) / 520;
      if (u >= 1) EG.flashT = 0; else target = Math.max(target, u < 0.18 ? 1 : 1 - (u - 0.18) / 0.82);
      EG.h = lerp(EG.h, 640, 0.15);
    }
    EG.o = damp(EG.o, target, dt, target > EG.o ? 45 : 110);
    const w = 170 + 110 * EG.o;
    edge.style.width = w + 'px';
    edge.style.height = EG.h + 'px';
    edge.style.transform = 'translate3d(' + (edgeX() - w / 2) + 'px,' + (EG.y - EG.h / 2) + 'px,0)';
    edge.style.opacity = String(clamp(EG.o, 0, 1));
    if (EG.o > 0.003 || EG.target > 0 || EG.flashT) EG.raf = requestAnimationFrame(egFrame);
    else { EG.raf = 0; edge.style.opacity = '0'; }
  }
  function egKick() { if (!EG.raf) { EG.last = 0; EG.raf = requestAnimationFrame(egFrame); } }
  function egFlash(y) { EG.y = y; EG.flashT = now(); egKick(); }
  function onEdge(m) {
    EG.hover = !!m.on;
    EG.target = m.on ? 0.85 : 0;
    EG.h = 380;
    if (typeof m.y === 'number') EG.y = clamp(m.y, 0, innerHeight);
    egKick();
  }

  // ------------------------------------------------------------------ release effects (canvas): vapor, ripples, particles
  const fxc = $('fx');
  const fctx = fxc.getContext('2d');
  const fxParts = [];
  let fxRaf = 0, fxLast = 0;
  function fxSize() { const d = devicePixelRatio || 1; fxc.width = Math.round(innerWidth * d); fxc.height = Math.round(innerHeight * d); fctx.setTransform(d, 0, 0, d, 0, 0); }
  fxSize();
  window.addEventListener('resize', fxSize);
  fxc.style.display = 'none';      // a full-screen layer costs every frame even when empty: shown only while an effect plays
  function fxKick() { if (!fxRaf) { fxc.style.display = ''; fxLast = now(); fxRaf = requestAnimationFrame(fxFrame); } }
  function fxFrame(t) {
    const dt = Math.min(50, t - fxLast) / 1000; fxLast = t;
    fctx.clearRect(0, 0, innerWidth, innerHeight);
    for (let i = fxParts.length - 1; i >= 0; i--) {
      const p = fxParts[i];
      p.age += dt;
      if (p.age < 0) continue;
      if (p.age >= p.life) { fxParts.splice(i, 1); continue; }
      p.draw(p, dt);
    }
    if (fxParts.length) fxRaf = requestAnimationFrame(fxFrame);
    else { fxRaf = 0; fctx.clearRect(0, 0, innerWidth, innerHeight); fxc.style.display = 'none'; }
  }
  // a soft cloud sprite, drawn once
  // vapor puffs: a few turbulent, wispy sprites (value-noise fbm, lit from the upper left), made once at startup
  // made on first use (or once the page is idle), not while the app starts: ~25 ms on a desktop, ~90 ms on a phone
  let puffCache = null;
  const puffImgs = () => puffCache || (puffCache = makePuffs());
  (window.requestIdleCallback || ((f) => setTimeout(f, 2000)))(() => puffImgs(), { timeout: 4000 });
  function makePuffs() {
    const N = 128, out = [];
    const hash = (x, y, sd) => { let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(sd, 1442695041)) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967295; };
    const vn = (x, y, sd) => {
      const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi, u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
      const a = hash(xi, yi, sd), b = hash(xi + 1, yi, sd), c = hash(xi, yi + 1, sd), d = hash(xi + 1, yi + 1, sd);
      return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
    };
    const fbm = (x, y, sd) => { let t = 0, a = 0.5; for (let i = 0; i < 4; i++) { t += a * vn(x, y, sd + i * 17); x = x * 2.03 + 1.7; y = y * 2.03 + 9.2; a *= 0.5; } return t; };
    for (let k = 0; k < 3; k++) {
      const c = document.createElement('canvas'); c.width = c.height = N;
      const g = c.getContext('2d'), id = g.createImageData(N, N), d = id.data;
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
        const nx = (x - N / 2 + 0.5) / (N / 2), ny = (y - N / 2 + 0.5) / (N / 2), r2 = nx * nx + ny * ny;
        if (r2 >= 1) continue;
        const wx = fbm(nx * 2.2 + 3.1, ny * 2.2, k * 5) - 0.5, wy = fbm(nx * 2.2, ny * 2.2 + 7.3, k * 5 + 3) - 0.5;
        const n = fbm(nx * 2.7 + wx * 1.8, ny * 2.7 + wy * 1.8, k * 11 + 1);
        const win = 1 - r2;
        const a = Math.max(0, Math.min(1, (Math.exp(-r2 * 2.4) * win * win * (0.3 + 1.2 * n) - 0.06) * 1.6));
        const lit = Math.max(0, Math.min(1, 0.55 - (nx * 0.5 + ny * 0.7) * 0.45 + (n - 0.5) * 0.8));
        const l = 214 + 41 * lit, i = (y * N + x) * 4;
        d[i] = l - 5; d[i + 1] = l - 2; d[i + 2] = l; d[i + 3] = Math.round(a * 255);
      }
      g.putImageData(id, 0, 0);
      out.push(c);
    }
    return out;
  }
  function vaporBurst(x, y, dir, n) {
    for (let i = 0; i < n; i++) {
      const sp = 240 + Math.random() * 560, a = (Math.random() - 0.5) * 1.4;
      fxParts.push({ x: x + (Math.random() - 0.5) * 10, y: y + (Math.random() - 0.5) * 70, vx: dir * Math.cos(a) * sp, vy: Math.sin(a) * sp * 0.6,
        s0: 16 + Math.random() * 14, s1: 90 + Math.random() * 90, rot: Math.random() * 6.28, spin: (Math.random() - 0.5) * 1.2,
        img: (P => P[i % P.length])(puffImgs()), al: 0.55 + Math.random() * 0.3, age: -Math.random() * 0.07, life: 0.75 + Math.random() * 0.5,
        draw(p, dt) {
          const f = Math.exp(-dt / 0.17); p.vx *= f; p.vy *= f; p.x += p.vx * dt; p.y += p.vy * dt;
          const u = p.age / p.life, s = p.s0 + (p.s1 - p.s0) * (1 - Math.exp(-p.age / 0.22));
          // fast gas is streaky, slow gas billows; it thins out as it spreads
          const spd = Math.hypot(p.vx, p.vy), stretch = 1 + Math.min(spd / 650, 1.2);
          fctx.globalAlpha = p.al * Math.pow(p.s0 / s, 0.3) * (1 - u * u) * Math.min(1, p.age / 0.04);
          fctx.save(); fctx.translate(p.x, p.y); fctx.rotate(Math.atan2(p.vy, p.vx)); fctx.scale(stretch, 1 / Math.sqrt(stretch));
          fctx.rotate(p.rot + p.age * p.spin); fctx.drawImage(p.img, -s / 2, -s / 2, s, s); fctx.restore();
          fctx.globalAlpha = 1;
        } });
    }
    fxKick();
  }
  function ripples(x, y) {
    for (let i = 0; i < 3; i++) {
      fxParts.push({ x, y, age: -i * 0.11, life: 0.85,
        draw(p) {
          const u = p.age / p.life, r = 18 + 230 * (1 - Math.pow(1 - u, 2));
          fctx.lineWidth = 3.2 * (1 - u) + 0.6;
          fctx.strokeStyle = `rgba(190,244,255,${(0.75 * (1 - u)).toFixed(3)})`;
          fctx.beginPath(); fctx.arc(p.x, p.y, r, 0, Math.PI * 2); fctx.stroke();
          fctx.lineWidth = 1;
          fctx.strokeStyle = `rgba(255,255,255,${(0.5 * (1 - u)).toFixed(3)})`;
          fctx.beginPath(); fctx.arc(p.x, p.y, r - 3, 0, Math.PI * 2); fctx.stroke();
        } });
    }
    fxKick();
  }
  // the card dissolves into its own pixels, which stream off toward the PC
  function dissolve(img, rect, rot, dir) {
    const cols = 34, rows = Math.max(12, Math.round(34 * rect.h / rect.w));
    const cv = document.createElement('canvas'); cv.width = cols; cv.height = rows;
    const g = cv.getContext('2d');
    let data = null;
    try {
      if (img && img.complete && img.naturalWidth) {
        const ia = img.naturalWidth / img.naturalHeight, ca = rect.w / rect.h;
        let sw = img.naturalWidth, sh = img.naturalHeight, sx = 0, sy = 0;
        if (ia > ca) { sw = sh * ca; sx = (img.naturalWidth - sw) / 2; } else { sh = sw / ca; sy = (img.naturalHeight - sh) / 2; }
        g.drawImage(img, sx, sy, sw, sh, 0, 0, cols, rows);
      } else { g.fillStyle = '#f2f2f5'; g.fillRect(0, 0, cols, rows); }
      data = g.getImageData(0, 0, cols, rows).data;
    } catch (e) { data = null; }
    const cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2, cs = Math.cos(rot), sn = Math.sin(rot);
    const cw = rect.w / cols, ch = rect.h / rows;
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
      const lx = (i + 0.5) * cw - rect.w / 2, ly = (j + 0.5) * ch - rect.h / 2;
      const x = cx + lx * cs - ly * sn, y = cy + lx * sn + ly * cs;
      const k = (j * cols + i) * 4;
      const col = data ? `rgb(${data[k]},${data[k + 1]},${data[k + 2]})` : '#f2f2f5';
      const lead = dir < 0 ? i / cols : 1 - i / cols;          // the side nearest the PC goes first
      fxParts.push({ x, y, vx: dir * (700 + Math.random() * 900), vy: (Math.random() - 0.5) * 120 + (j / rows - 0.5) * 80, col, s: Math.max(cw, ch) * 1.05,
        age: -(lead * 0.22 + Math.random() * 0.06), life: 0.5 + Math.random() * 0.2,
        draw(p, dt) {
          p.vx *= 1 + dt * 1.8; p.x += p.vx * dt; p.y += p.vy * dt;
          const u = p.age / p.life;
          const s = p.s * (1 - u * 0.6);
          fctx.globalAlpha = 1 - u * u;
          fctx.fillStyle = p.col; fctx.fillRect(p.x - s / 2, p.y - s / 2, s, s);
          fctx.globalAlpha = 1;
        } });
    }
    fxKick();
  }
  // themed moment when a card leaves the phone toward the PC
  function releaseFx(rect, rot, img) {
    const dir = towardSign();
    const ex = st.side === 'right' ? 0 : innerWidth;
    const y = clamp(rect.y + rect.h / 2, 0, innerHeight);
    if (st.theme === 'roadster') { vaporBurst(ex, y, -dir, 20); egFlash(y); return false; }
    if (st.theme === 'liquid') { ripples(ex + dir * -6, y); egFlash(y); return false; }
    if (st.theme === 'teleport') { dissolve(img, rect, rot, dir); return true; }
    egFlash(y);
    return false;
  }

  // ------------------------------------------------------------------ drag engine (phone -> PC)
  let T = null;   // touch candidate
  let D = null;   // active drag
  const layer = $('dragLayer');

  function makeFloat(it, rect, src) {
    const f = document.createElement('div');
    f.className = 'float' + (it.dir ? ' folder' : it.kind === 'image' || it.kind === 'video' ? '' : ' doc');
    f.style.width = rect.width + 'px'; f.style.height = rect.height + 'px';
    const th = src || (cards.get(it.id) && cards.get(it.id).querySelector('.thumb'));
    if (th) {
      for (const ch of th.children) {
        if (ch.classList && (ch.classList.contains('prog') || ch.classList.contains('check'))) continue;
        f.appendChild(ch.cloneNode(true));
      }
      f.querySelectorAll('img').forEach((i) => i.classList.add('ok'));
      if (th.classList.contains('app')) f.style.background = '#1e1e22';
    }
    layer.appendChild(f);
    return f;
  }

  // several items travel as one stack: the touched one on top, two more peeking out underneath, and a count
  function makeStackFloat(items, rect) {
    if (items.length < 2) return makeFloat(items[0], rect);
    const w = document.createElement('div');
    w.className = 'float stackf';
    w.style.width = rect.width + 'px'; w.style.height = rect.height + 'px';
    for (let i = Math.min(2, items.length - 1); i >= 1; i--) {
      const sh = document.createElement('div');
      sh.className = 'sheet s' + i;
      const el = cards.get(items[i].id);
      const img = el && el.querySelector('.thumb img.ok');
      if (img) { const im = img.cloneNode(); im.classList.add('ok'); sh.appendChild(im); }
      else if (items[i].dir) { sh.style.background = 'linear-gradient(155deg, #2a2a30, #1b1b20)'; }
      else if (!(items[i].kind === 'image' || items[i].kind === 'video')) sh.style.background = '#fbfbfd';
      w.appendChild(sh);
    }
    const face = makeFloat(items[0], rect);
    face.classList.add('face');
    w.appendChild(face);
    const b = document.createElement('span');
    b.className = 'nbadge';
    b.textContent = items.length > 999 ? '999+' : String(items.length);
    w.appendChild(b);
    layer.appendChild(w);
    return w;
  }
  // the other selected cards fly from their places in the grid into the stack
  function gather(others, target) {
    const fl = [];
    for (const x of others.slice(0, 14)) {
      const el = cards.get(x.id);
      if (!el) continue;
      const r = el.querySelector('.thumb').getBoundingClientRect();
      if (r.bottom < -40 || r.top > innerHeight + 40) continue;
      const f = makeFloat(x, r);
      f.classList.add('gathering');
      layer.insertBefore(f, layer.firstChild);
      fl.push({ f, x0: r.left, y0: r.top, w: r.width, h: r.height, d: fl.length * 18 });
    }
    if (!fl.length) return;
    const t0 = now();
    (function step(t) {
      const tg = target();
      let live = false;
      for (const g of fl) {
        const u = clamp((t - t0 - g.d) / 280, 0, 1), e = easeInOut(u);
        const s = lerp(1, (tg.w / g.w) * 0.94, e);
        const x = lerp(g.x0, tg.x + (tg.w - g.w) / 2, e), y = lerp(g.y0, tg.y + (tg.h - g.h) / 2, e);
        g.f.style.transform = 'translate3d(' + x.toFixed(1) + 'px,' + y.toFixed(1) + 'px,0) rotate(' + (e * (g.d % 36 ? 5 : -5)).toFixed(2) + 'deg) scale(' + s.toFixed(4) + ')';
        g.f.style.opacity = String(1 - clamp((u - 0.78) / 0.22, 0, 1));
        if (u < 1) live = true; else if (g.f.parentNode) g.f.remove();
      }
      if (live) requestAnimationFrame(step);
    })(t0);
  }
  // what the PC needs to know about what's coming: one file, one folder, or a stack of several items
  function fileInfo(items) {
    const it = items[0];
    if (items.length === 1 && !it.dir) return { name: it.name, size: it.size, kind: pcKind(it), badge: badgeOf(it), mime: it.mime };
    let size = 0;
    for (const x of items) if (!x.dir) size += +x.size || 0;
    return {
      name: items.length === 1 ? it.name : items.length.toLocaleString() + ' items', size, count: items.length,
      kind: it.dir ? 'folder' : pcKind(it), badge: badgeOf(it), folder: !!it.dir, mime: it.mime || '',
    };
  }
  function sheetThumbs(items) {
    const out = [];
    for (const x of items.slice(1, 3)) out.push(x.dir || !(x.kind === 'image' || x.kind === 'video') ? null : nativeThumb(x));
    return out;
  }
  function bundleUrl(tid) {
    const tok = pref.get(tokenKey(st.pc.id), '');
    // PCs that speak protocol 3 take a bundle over several connections at once (the phone app decides when it's worth it)
    return linkBase() + '/api/bundle?tid=' + encodeURIComponent(tid) + '&device=' + encodeURIComponent(DEVICE) + '&token=' + encodeURIComponent(tok) +
      ((st.pcProto || 1) >= 3 ? parallelArg() : '');
  }
  // one file goes as it is; several items, or any folder, go as one bundle (folders keep their insides)
  function startSend(tid, items) {
    if (items.length === 1 && !items[0].dir) { startUpload(tid, items[0]); return; }
    const list = items.map((x) => (x.path ? { path: x.path, name: x.name, dir: !!x.dir } : { id: x.id, name: x.name }));
    nc('uploadBundle', tid, JSON.stringify(list), bundleUrl(tid));
  }
  function itemsOf(p) { return p.items || [p.item]; }

  function nativeThumb(it) {
    if (it.dir) return null;
    if (it.thumbData) return it.thumbData;
    const b = it.path ? nc('thumbPath', it.path, String(it.mtime || 0), String(it.mid || 0), String(it.mt || 0)) : nc('thumb', it.id);
    if (b && b !== true) { it.thumbData = 'data:image/jpeg;base64,' + b; return it.thumbData; }
    return null;
  }

  // the native side splits large files into this many parts when the PC understands it
  const parallelArg = () => ((st.pcProto || 1) >= 2 && settings.parallel && !(st.pc && st.pc.via === 'bluetooth') ? '&parallel=4' : '');
  function uploadUrl(tid, it) {
    const tok = pref.get(tokenKey(st.pc.id), '');
    return linkBase() + '/api/upload?tid=' + encodeURIComponent(tid) + '&device=' + encodeURIComponent(DEVICE) +
      '&token=' + encodeURIComponent(tok) + '&name=' + encodeURIComponent(it.name) + '&size=' + (it.size || 0) + parallelArg();
  }

  function startUpload(tid, it) {
    if (it.path) nc('uploadPath', tid, it.path, uploadUrl(tid, it));
    else nc('upload', tid, it.id, uploadUrl(tid, it));
  }

  function settleDrag() {
    if (!D) return;
    cancelAnimationFrame(D.raf);
    if (D.phase === 'back') unlift(D.items);
    D.f.remove();
    D = null;
  }
  function startDrag(tch, how) {
    const c = T;
    T = null;
    if (!c || !c.item || c.item.incoming) return;
    if (D && D.phase !== 'drag') settleDrag();
    if (D) return;
    const it = c.item;
    const el = cards.get(it.id);
    if (!el) return;
    // while selecting, the touched card joins the selection and the whole selection travels together
    if (SEL.on && !SEL.ids.has(it.id)) { SEL.ids.add(it.id); renderSelection(); }
    const items = SEL.on ? [it].concat(selItems().filter((x) => x.id !== it.id)) : [it];
    const thumb = el.querySelector('.thumb');
    const r = thumb.getBoundingClientRect();
    const fx = tch ? tch.clientX : c.x0, fy = tch ? tch.clientY : c.y0;
    D = {
      it, items, el, f: makeStackFloat(items, r), w: r.width, h: r.height, how: how || 'swipe', fx0: fx, fy0: fy,
      offX: c.x0 - r.left, offY: c.y0 - r.top, x: r.left, y: r.top, fx, fy,
      r: 0, s: 1, sT: 1.065, vx: 0, vy: 0, samples: [{ t: now(), x: fx, y: fy }],
      tid: rid(), t0: now(), raf: 0, last: 0, phase: 'drag', sentMove: 0,
    };
    D.x = fx - D.offX; D.y = fy - D.offY;
    for (const x of items) { const e2 = cards.get(x.id); if (e2) e2.classList.add('lifted'); }
    if (items.length > 1) gather(items.slice(1), () => (D ? { x: D.x, y: D.y, w: D.w, h: D.h } : { x: r.left, y: r.top, w: r.width, h: r.height }));
    haptic('lift');
    if (st.theme === 'teleport') { const src = nativeThumb(it); if (src) { D.sampleImg = new Image(); D.sampleImg.src = src; } }
    // a long press may only be selecting: nothing is sent until the finger actually moves
    if (D.how !== 'press') beginSend();
    D.raf = requestAnimationFrame(dragFrame);
  }
  function beginSend() {
    if (!D || D.sending || !st.connected) return;
    D.sending = true;
    st.pending.set(D.tid, { item: D.it, items: D.items, phase: 'lifted' });
    startSend(D.tid, D.items);
    wsSend({ t: 'lift', tid: D.tid, file: fileInfo(D.items), thumb: nativeThumb(D.it), thumbs: sheetThumbs(D.items), w: D.w, h: D.h, pw: innerWidth, ph: innerHeight });
  }
  function unlift(items) { for (const x of items) { const e2 = cards.get(x.id); if (e2) e2.classList.remove('lifted'); } }

  function velocity() {
    const s = D.samples;
    const last = s[s.length - 1];
    let i = s.length - 1;
    while (i > 0 && last.t - s[i - 1].t < 85) i--;
    const first = s[Math.max(0, i - 1)];
    const dt = Math.max(8, last.t - first.t);
    if (now() - last.t > 90) return { x: 0, y: 0 };
    return { x: (last.x - first.x) / dt, y: (last.y - first.y) / dt };
  }

  function dragFrame(t) {
    if (!D) return;
    const dt = Math.min(48, t - (D.last || t)); D.last = t;
    if (D.phase === 'drag') {
      D.s = damp(D.s, D.sT, dt, 55);
      const v = velocity();
      D.vx = v.x; D.vy = v.y;
      D.r = damp(D.r, clamp(v.x * 6.5, -11, 11), dt, 70);
    } else if (D.phase === 'exit') {
      D.x += D.evx * dt; D.y += D.evy * dt;
      D.r = damp(D.r, D.evx > 0 ? 6 : -6, dt, 90);
      const off = D.evx < 0 ? D.x + D.w * D.s < -10 : D.x > innerWidth + 10;
      if (off || t - D.exitT > 900) { D.f.remove(); D = null; EG.target = 0; egKick(); return; }
    } else if (D.phase === 'back') {
      const u = clamp((t - D.backT) / 330, 0, 1);
      const e = 1 - Math.pow(1 - u, 3) + Math.sin(u * Math.PI) * 0.04;
      D.x = lerp(D.bx0, D.bx1, e); D.y = lerp(D.by0, D.by1, e);
      D.s = lerp(D.bs0, 1, easeOut(u)); D.r = lerp(D.br0, 0, easeOut(u));
      if (u >= 1) { unlift(D.items); D.f.remove(); D = null; return; }
    }
    D.f.style.transform = 'translate3d(' + D.x.toFixed(1) + 'px,' + D.y.toFixed(1) + 'px,0) rotate(' + D.r.toFixed(2) + 'deg) scale(' + D.s.toFixed(4) + ')';

    if (D.phase === 'drag' && st.connected && D.sending) {
      const dist = st.side === 'right' ? D.x : innerWidth - (D.x + D.w);
      const p = clamp(1 - dist / (innerWidth * 0.62), 0, 1);
      EG.target = p * p * 0.9;
      EG.y = clamp(D.y + D.h / 2, 0, innerHeight);
      EG.h = 300 + 200 * p;
      egKick();
      if (t - D.sentMove > 14) {
        D.sentMove = t;
        wsSend({ t: 'move', tid: D.tid, x: Math.round(D.x * 10) / 10, y: Math.round(D.y * 10) / 10, w: D.w, h: D.h, r: Math.round(D.r * 10) / 10, s: Math.round(D.s * 1000) / 1000, vx: Math.round(D.vx * 1000) / 1000, vy: Math.round(D.vy * 1000) / 1000, pw: innerWidth, ph: innerHeight });
      }
    }
    D.raf = requestAnimationFrame(dragFrame);
  }

  function dragMove(tch) {
    if (!D || D.phase !== 'drag') return;
    D.fx = tch.clientX; D.fy = tch.clientY;
    D.x = D.fx - D.offX; D.y = D.fy - D.offY;
    D.samples.push({ t: now(), x: D.fx, y: D.fy });
    if (D.samples.length > 40) D.samples.splice(0, D.samples.length - 40);
    if (!D.sending && Math.hypot(D.fx - D.fx0, D.fy - D.fy0) > 12) beginSend();
  }

  function dragEnd() {
    if (!D || D.phase !== 'drag') return;
    const v = velocity();
    const toward = v.x * towardSign();
    const over = st.side === 'right' ? -D.x / D.w : (D.x + D.w - innerWidth) / D.w;
    const nearEdge = st.side === 'right' ? D.x < innerWidth * 0.38 : D.x + D.w > innerWidth * 0.62;
    const pend = st.pending.get(D.tid);
    const commit = st.connected && !(pend && pend.failed) && (over > 0.2 || (toward > 0.42 && (nearEdge || over > 0)) || toward > 1.05);
    if (window.__flickDebug) window.__flickDebug.push({ vx: v.x, toward, over, nearEdge, x: D.x, commit, samples: D.samples.length, age: now() - D.samples[D.samples.length - 1].t });
    if (pend && pend.failed && (over > 0.2 || toward > 0.42)) toast('Couldn’t send ' + midName(D.it.name), 2400);
    if (commit && !D.sending) beginSend();
    if (commit) {
      const sign = towardSign();
      let evx = v.x;
      if (evx * sign < 1.7) evx = 1.7 * sign;
      if (Math.abs(evx) > 5) evx = 5 * sign;
      const evy = clamp(v.y, -1.6, 1.6) * 0.65;
      D.phase = 'exit'; D.evx = evx; D.evy = evy; D.exitT = now();
      wsSend({ t: 'drop', tid: D.tid, x: Math.round(D.x * 10) / 10, y: Math.round(D.y * 10) / 10, w: D.w, h: D.h, r: Math.round(D.r * 10) / 10, s: D.s, vx: evx, vy: evy, pw: innerWidth, ph: innerHeight });
      const p = st.pending.get(D.tid);
      if (p) p.phase = 'sent';
      haptic('confirm');
      const gone = releaseFx({ x: D.x + D.w * (1 - D.s) / 2, y: D.y + D.h * (1 - D.s) / 2, w: D.w * D.s, h: D.h * D.s }, D.r * Math.PI / 180, D.sampleImg);
      // files that stay on the phone keep their place in the grid (an empty slot until the PC has them)
      let hid = false;
      for (const x of D.items) {
        x._sentAt = now();
        if (!x.path && !st.keep) { st.hidden.add(x.id); hid = true; }
      }
      if (hid) setTimeout(() => layout(true), 120);
      if (SEL.on) setSelecting(false);
      if (gone) { D.f.remove(); D = null; }
    } else {
      if (st.pending.has(D.tid)) {
        wsSend({ t: 'cancel', tid: D.tid });
        nc('abort', D.tid);
        st.pending.delete(D.tid);
      }
      if (!st.connected && (D.x < 0 || D.x + D.w > innerWidth)) toast('Not connected to your PC');
      // press, hold and let go without moving: select it (the way Android file managers do)
      if (D.how === 'press' && Math.hypot(D.fx - D.fx0, D.fy - D.fy0) < 12) {
        if (!SEL.on) setSelecting(true);
        SEL.ids.add(D.it.id);
        renderSelection();
        haptic('tick');
      }
      const r = D.el.querySelector('.thumb').getBoundingClientRect();
      D.phase = 'back'; D.backT = now();
      D.bx0 = D.x; D.by0 = D.y; D.bx1 = r.left; D.by1 = r.top; D.bs0 = D.s; D.br0 = D.r;
      EG.target = 0; egKick();
      haptic('soft');
    }
  }

  // send without dragging (⋯ menu, or the Send button while selecting): the stack flies off toward the PC by itself
  function sendItems(items) {
    items = (items || []).filter((x) => x && !x.incoming);
    if (!items.length) return;
    if (!st.connected) { toast('Not connected to your PC'); return; }
    const it = items[0];
    const el = cards.get(it.id);
    let r = el ? el.querySelector('.thumb').getBoundingClientRect() : null;
    if (!r || r.bottom < 0 || r.top > innerHeight) {          // scrolled away: start from the middle of the screen
      const w = Math.min(190, innerWidth * 0.46), h = w * 0.75;
      r = { left: (innerWidth - w) / 2, top: innerHeight * 0.42 - h / 2, width: w, height: h, right: (innerWidth + w) / 2, bottom: innerHeight * 0.42 + h / 2 };
    }
    const tid = rid();
    st.pending.set(tid, { item: it, items, phase: 'sent' });
    startSend(tid, items);
    wsSend({ t: 'send', tid, file: fileInfo(items), thumb: nativeThumb(it), thumbs: sheetThumbs(items), w: r.width, h: r.height, pw: innerWidth, ph: innerHeight });
    if (SEL.on) setSelecting(false);
    const keep = (x) => !!x.path || st.keep;
    const settle = () => {                                     // the stack is gone from the phone: empty slots until saved
      if (!st.pending.has(tid)) { unlift(items); return; }
      let hid = false;
      for (const x of items) if (!keep(x)) { st.hidden.add(x.id); hid = true; }
      if (hid) { unlift(items.filter((x) => !keep(x))); layout(true); }
    };
    for (const x of items) { x._sentAt = now() + 400; const e2 = cards.get(x.id); if (e2) e2.classList.add('lifted'); }
    haptic('confirm');
    if (st.theme === 'teleport') {
      const img = new Image();
      const src = nativeThumb(it);
      for (const x of items) x._sentAt = now();
      if (items.length > 1) gather(items.slice(1), () => ({ x: r.left, y: r.top, w: r.width, h: r.height }));
      const go = () => { releaseFx({ x: r.left, y: r.top, w: r.width, h: r.height }, 0, img); settle(); };
      if (src) { img.onload = go; img.onerror = go; img.src = src; } else go();
      return;
    }
    const f = makeStackFloat(items, r);
    let x = r.left, last = 0, s = 1;
    const y = r.top;
    if (items.length > 1) gather(items.slice(1), () => ({ x, y, w: r.width, h: r.height }));
    const t0 = now();
    const wait = items.length > 1 ? 0.22 : 0;                 // let the stack gather before it leaves
    (function fly(t) {
      const dt = Math.min(48, t - (last || t)); last = t;
      const u = Math.max(0, (t - t0) / 1000 - wait);
      const vx = u > 0 ? towardSign() * Math.min(4.2, 0.2 + u * 14) : 0;
      x += vx * dt; s = damp(s, 1.07, dt, 60);
      f.style.transform = 'translate3d(' + x + 'px,' + y + 'px,0) rotate(' + (towardSign() * -4) + 'deg) scale(' + s + ')';
      if ((towardSign() < 0 ? x + r.width * s < -10 : x > innerWidth + 10) || u > 1.2) {
        f.remove();
        settle();
        return;
      }
      requestAnimationFrame(fly);
    })(t0);
    setTimeout(() => releaseFx({ x: r.left, y: r.top, w: r.width, h: r.height }, 0, null), wait * 1000);
  }

  // a sent file that stays on the phone comes back into the grid once its departure has finished playing
  function restoreItem(item) {
    const wait = Math.max(D && D.it === item ? 120 : 0, (item._sentAt || 0) + 750 - now());
    if (wait > 0) { setTimeout(() => restoreItem(item), wait); return; }
    const wasHidden = st.hidden.delete(item.id);
    const el = cards.get(item.id);
    if (el) { el.classList.remove('lifted'); el.classList.add('pop'); setTimeout(() => el.classList.remove('pop'), 600); }
    else item._popIn = true;
    if (wasHidden) layout(true);
    updateCount();
  }

  function onSaved(m) {
    const p = st.pending.get(m.tid);
    if (!p) return;
    st.pending.delete(m.tid);
    // real phone files always stay; Flick-list items follow the "keep" setting
    const gone = [];
    for (const it of itemsOf(p)) {
      if (it.path || st.keep) restoreItem(it);
      else gone.push(it.id);
    }
    dropItems(gone, true);
    updateCount();
  }

  function onFailed(m) {
    const p = st.pending.get(m.tid);
    if (!p) return;
    st.pending.delete(m.tid);
    const items = itemsOf(p);
    for (const it of items) st.hidden.delete(it.id);
    layout(true);
    for (const it of items) {
      const el = cards.get(it.id);
      if (el) { el.classList.remove('lifted'); el.classList.add('err'); setTimeout(() => el.classList.remove('err'), 900); }
    }
    haptic('reject');
    toast('Couldn’t send ' + (items.length > 1 ? items.length + ' items' : midName(p.item.name)), 2600);
    updateCount();
  }

  // bytes on their way (folders and stacks can take a while): shown in the toolbar
  function onUp(e) {
    const p = st.pending.get(e.tid);
    if (!p || !e.total) return;
    // transfer speed, smoothed over the last second or so
    const t = performance.now();
    if (!p.rt) { p.rt = t; p.rs = e.sent; }
    else if (t - p.rt > 400) {
      const inst = Math.max(0, e.sent - p.rs) / ((t - p.rt) / 1000);
      p.rate = p.rate ? p.rate * 0.6 + inst * 0.4 : inst;
      p.rt = t; p.rs = e.sent;
    }
    p.sent = e.sent; p.total = e.total;
    updateCount();
  }
  function fmtRate(r) { return r >= 1e7 ? Math.round(r / 1e6) + ' MB/s' : r >= 1e6 ? (r / 1e6).toFixed(1) + ' MB/s' : Math.max(1, Math.round(r / 1e3)) + ' KB/s'; }

  function onUpDone(e) {
    const p = st.pending.get(e.tid);
    if (!p) return;
    if (e.ok) {
      p.uploaded = true;
      if (p.phase === 'sent' && !st.wsOpen) { st.pending.delete(e.tid); for (const it of itemsOf(p)) if (it.path || st.keep) restoreItem(it); }
      updateCount();
      return;
    }
    p.tries = (p.tries || 0) + 1;
    if (p.tries < 2 && st.connected && st.pc) { startSend(e.tid, itemsOf(p)); return; } // one quick retry
    if (p.phase === 'sent') { wsSend({ t: 'cancel', tid: e.tid, failed: true }); onFailed({ tid: e.tid }); }
    else p.failed = true;
  }

  // touch handling on the grid
  grid.addEventListener('touchstart', (e) => {
    // a card still settling back (or flying off) never blocks the next touch
    if ((D && D.phase === 'drag') || e.touches.length !== 1) { if (T) { clearTimeout(T.lp); T = null; } return; }
    const tgt = e.target;
    if (tgt.closest && tgt.closest('.more')) return;
    const card = tgt.closest && tgt.closest('.card');
    if (!card) return;
    const it = V.items.find((x) => x.id === card.dataset.id);
    if (!it || it.incoming) return;
    const t = e.touches[0];
    T = { id: t.identifier, item: it, x0: t.clientX, y0: t.clientY, t0: now(), moved: false };
    T.lp = setTimeout(() => { if (T && !T.moved) startDrag(null, 'press'); }, 230);
  }, { passive: true });

  function findTouch(list, id) { for (let i = 0; i < list.length; i++) if (list[i].identifier === id) return list[i]; return null; }

  grid.addEventListener('touchmove', (e) => {
    if (D && D.phase === 'drag') {
      if (e.cancelable) e.preventDefault();
      const t = e.touches[0]; if (t) dragMove(t);
      return;
    }
    if (!T) return;
    const t = findTouch(e.touches, T.id); if (!t) return;
    const dx = t.clientX - T.x0, dy = t.clientY - T.y0;
    if (Math.abs(dx) > 7 && Math.abs(dx) > Math.abs(dy) * 1.05) {
      clearTimeout(T.lp);
      if (e.cancelable) e.preventDefault();
      startDrag(t, 'swipe');
      if (D) dragMove(t);
    } else if (Math.abs(dy) > 9 || Math.abs(dx) > 12) {
      clearTimeout(T.lp); T = null;
    } else if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
      T.moved = Math.hypot(dx, dy) > 6;
    }
  }, { passive: false });

  function touchEnd(e) {
    if (D && D.phase === 'drag') {
      if (!e.touches || e.touches.length === 0) dragEnd();
      return;
    }
    if (T) {
      clearTimeout(T.lp);
      const quick = now() - T.t0 < 300 && !T.moved;
      const it = T.item;
      T = null;
      if (quick && it && !it.incoming) {
        if (e.cancelable) e.preventDefault();
        if (SEL.on) toggleSel(it);
        else if (it.dir) { haptic('soft'); openDir(it.path, it.name); } else itemMenu(it);
      }
    }
  }
  grid.addEventListener('touchend', touchEnd, { passive: false });
  grid.addEventListener('touchcancel', () => { if (D && D.phase === 'drag') dragEnd(); else if (T) { clearTimeout(T.lp); T = null; } }, { passive: true });
  document.addEventListener('contextmenu', (e) => e.preventDefault());

  // ------------------------------------------------------------------ incoming (PC -> phone)
  function onIncoming(m) { setTimeout(() => incomingNow(m), m.delay || 0); }
  function incomingNow(m) {
    if (st.screen !== 'main') showScreen('main');
    const aspect = clamp(m.aspect || 1.33, 0.5, 2);
    const it = {
      id: 'in-' + m.fid, fid: m.fid, name: m.name, size: m.size, mime: m.mime, kind: m.kind === 'image' || m.kind === 'video' ? m.kind : (m.ext === 'pdf' ? 'pdf' : 'doc'),
      // the PC's thumbnail is only ever a small inline picture; anything else (a URL) would make the phone fetch it
      ext: m.ext, added: Date.now(), mtime: Date.now(), thumb: typeof m.thumb === 'string' && /^data:image\/(jpeg|png|webp|gif);base64,/.test(m.thumb) ? m.thumb : null,
      w: m.kind === 'image' || m.kind === 'video' ? Math.round(aspect * 1000) : 0, h: 1000, incoming: true,
    };
    (st.incoming = st.incoming || new Map()).set(m.fid, String(m.name || 'file'));
    V.items.unshift(it);
    V.total++;
    if (scroller.scrollTop > 40) scroller.scrollTo({ top: 0, behavior: 'smooth' });
    layout(true);
    const el = cards.get(it.id);
    if (!el) return;
    el.classList.add('ghost');
    const target = el.querySelector('.thumb');
    const w = it._w, h = it._th;
    const f = makeFloat(it, { width: w, height: h }, target);
    const y0 = clamp((typeof m.y === 'number' ? m.y : innerHeight / 2) - h / 2, 20, innerHeight - h - 20);
    const sx = st.side === 'right' ? -w - 8 : innerWidth + 8;
    const mx = st.side === 'right' ? 26 : innerWidth - w - 26;
    egFlash(y0 + h / 2);
    haptic('tick');
    const t0 = now();
    (function anim(t) {
      const u1 = clamp((t - t0) / 210, 0, 1);
      const u2 = clamp((t - t0 - 170) / 380, 0, 1);
      const rr = target.getBoundingClientRect();
      let x, y, s, r;
      if (u2 <= 0) { const e = easeOut(u1); x = lerp(sx, mx, e); y = y0; s = 1.07; r = (st.side === 'right' ? 6 : -6) * (1 - e); }
      else { const e = easeInOut(u2); x = lerp(mx, rr.left, e); y = lerp(y0, rr.top, e); s = lerp(1.07, 1, e); r = 0; }
      f.style.transform = 'translate3d(' + x + 'px,' + y + 'px,0) rotate(' + r + 'deg) scale(' + s + ')';
      if (u2 < 1) requestAnimationFrame(anim);
      else { el.classList.remove('ghost'); f.remove(); haptic('soft'); }
    })(t0);
    setCardProgress(it.id, 0);
    const tok = pref.get(tokenKey(st.pc.id), '');
    const url = linkBase() + m.url + '?device=' + encodeURIComponent(DEVICE) + '&token=' + encodeURIComponent(tok) + parallelArg();
    nc('download', m.fid, url, m.name, String(m.size || 0), m.mime || '');
  }

  function onDown(e) {
    const it = V.items.find((x) => x.fid === e.fid);
    if (it && e.total) setCardProgress(it.id, e.got / e.total);
  }
  function onDownDone(e) {
    const idx = V.items.findIndex((x) => x.fid === e.fid);
    const name = (st.incoming && st.incoming.get(e.fid)) || (idx >= 0 ? V.items[idx].name : 'a file');
    if (st.incoming) st.incoming.delete(e.fid);
    if (!e.ok || !e.item) {
      if (idx >= 0) { V.items.splice(idx, 1); V.total--; layout(true); }
      toast('Couldn’t receive ' + midName(name), 2600);          // even when the user has moved to another view
      haptic('reject');
      return;
    }
    if (idx < 0) { wsSend({ t: 'incoming-done', fid: e.fid }); return; }
    const real = e.item;
    const el = cards.get(V.items[idx].id);
    cards.delete(V.items[idx].id);
    if (el) el.remove();
    if (V.items.find((x) => x.id === real.id)) V.items.splice(idx, 1); else V.items[idx] = real;
    layout(false);
    const nel = cards.get(real.id);
    if (nel) nel.animate([{ filter: 'brightness(1.6)' }, { filter: 'brightness(1)' }], { duration: 420, easing: 'ease-out' });
    wsSend({ t: 'incoming-done', fid: e.fid });
    if (real.path && /\/Download\/Flick\//.test(real.path)) toast('Saved to Downloads › Flick', 1600);
    haptic('tick');
  }

  // ------------------------------------------------------------------ native events
  window.__native = function (ev) {
    let e = ev;
    if (typeof ev === 'string') { try { e = JSON.parse(ev); } catch (x) { return; } }
    switch (e.t) {
      case 'res': { const r = pendingReq.get(e.req); if (r) { pendingReq.delete(e.req); r(e.data); } break; }
      case 'pcs':
        st.lanList = e.list || [];
        if (st.pc && st.lanList.some((p) => p.id === st.pc.id)) st.lanSeenAt = Date.now();
        onPcs();
        break;
      case 'bt': onBt(e); break;
      case 'bt-perm': btTick(); if (!$('settings').hidden) renderSettings(); break;
      case 'added':
        if (e.items && e.items.length) toast(e.items.length === 1 ? 'Added ' + midName(e.items[0].name) + ' to Flick' : 'Added ' + e.items.length + ' files to Flick', 1600);
        addToShelf(e.items);
        if (st.screen === 'pair' && !st.pc) showScreen('main');
        break;
      case 'up': onUp(e); break;
      case 'up-done': onUpDone(e); break;
      case 'down': onDown(e); break;
      case 'down-done': onDownDone(e); break;
      case 'insets': applyInsets(e.top, e.bottom); break;
      case 'saved': onSavedCopy(e); break;
      case 'toast': if (e.msg) toast(String(e.msg), 2600); break;
      case 'upd': case 'upd-done': case 'upd-installing': case 'upd-perm': case 'upd-perm-denied': case 'upd-back': case 'upd-fail':
        onUpdEvent(e); break;
      case 'gh': onGitHub(e); break;
      case 'storage': refreshStorage(false); break;
      case 'resume':
        nc('discover', true);
        refreshStorage(false);
        if (Date.now() - UPD.ghAt > 3600e3) checkGitHub(false);
        if (st.pc && !st.wsOpen && !st.connecting) openLink(st.trusted);
        break;
      case 'pause': nc('discover', false); break;
      default: break;
    }
  };
  window.__back = function () {
    if (!$('ask').hidden) { $('ask').hidden = true; return true; }
    if (sheetOpen) { closeSheet(); return true; }
    if (closeSettings()) return true;
    if (D && D.phase === 'drag') { dragEnd(); return true; }
    if (SEL.on) { setSelecting(false); return true; }
    if (st.screen === 'main' && V.cat === 'dir' && V.stack.length) { goBack(); return true; }
    if (st.screen === 'main' && !st.connected) { showScreen('pair'); return true; }
    return false;
  };

  // ------------------------------------------------------------------ boot
  window.addEventListener('resize', () => { measureHeader(); layout(false); wsSend({ t: 'screen', w: innerWidth, h: innerHeight, dpr: devicePixelRatio }); });
  measureHeader();
  openCat(STG.granted ? (pref.get('lastView', 'recent') || 'recent') : 'recent');
  setPcName();
  showScreen('pair');
  const lastAddr = pref.get('lastPcAddr', '');
  const lastId = pref.get('lastPc', '');
  if (lastAddr && lastId) {
    const parts = lastAddr.split(':');
    // a PC whose certificate is pinned (or that last said so) takes encrypted links; discovery confirms either way
    const tls = pref.get(pinKey(lastId), '') || pref.get('lastPcTls', '') === '1' ? 1 : 0;
    st.pcs = [{ id: lastId, name: pref.get('lastPcName', 'your PC'), ip: parts[0], port: +parts[1], tls, v: tls ? 4 : 1 }];
    choosePc(st.pcs[0]);
  }
  setTimeout(() => { if (!st.pc) pairHint('Make sure Flick is open on your PC and both are on the <b>same Wi-Fi</b>.'); }, 4500);
})();
