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
  const SETTINGS_DEFAULTS = { parallel: true, showSpeed: true, haptics: true, autoUpdate: true, bluetooth: false, phoneName: '', skipDup: true, autoConnect: true };
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
    jobs: new Map(),         // tid -> the app's view of a send (protocol 7 PCs): it goes on with Flick closed
    keep: pref.get('keep', '0') === '1',
    screen: 'pair',
  };
  const tokenKey = (pcId) => 'token:' + pcId;
  // the SHA-256 of the PC's certificate, pinned when this phone paired with it (the user checked the pairing code on
  // both screens): only that PC gets a connection
  const pinKey = (pcId) => 'pin:' + pcId;
  const rhex = (n) => { const a = new Uint8Array(n); crypto.getRandomValues(a); return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join(''); };
  // compares two strings in time that doesn't depend on where they differ
  const sameStr = (a, b) => { a = String(a || ''); b = String(b || ''); if (!a || a.length !== b.length) return false; let x = 0; for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i); return x === 0; };
  const SEL = { on: false, ids: new Set() };   // multi-select: ids of the selected items in the current view
  // wireless update: the PC announces the newest phone app it has; app = { code, name, size, sha256, url, sums, sig }
  const UPD = { app: null, pcApp: null, ghApp: null, ghAt: 0, ghAsk: false, pcKnows: false, state: 'idle', got: 0, total: 0, why: '', dismissed: 0, checkT: 0, auto: false, loud: false };
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

  // ---- every PC this phone paired with, and the addresses it was seen at: discovery asks there directly too, so a PC
  // found once (even by typing its address) is found again without it, at home, at work, anywhere
  const KNOWN_KEY = 'knownPcs';
  function knownPcs() { try { const k = JSON.parse(pref.get(KNOWN_KEY, '{}')); return k && typeof k === 'object' ? k : {}; } catch (e) { return {}; } }
  function rememberPc(pc, addrs) {
    if (!pc || !pc.id || pc.via === 'bluetooth') return;
    const k = knownPcs();
    const e = k[pc.id] || { addrs: [] };
    e.name = pc.name || e.name;
    e.last = Date.now();
    const ips = [pc.ip].concat(addrs || []).filter((a) => /^\d{1,3}(\.\d{1,3}){3}$/.test(String(a || '')));
    e.addrs = ips.concat((e.addrs || []).filter((a) => !ips.includes(a))).slice(0, 8);
    k[pc.id] = e;
    const ids = Object.keys(k).sort((a, b) => (k[b].last || 0) - (k[a].last || 0));
    for (const id of ids.slice(12)) delete k[id];       // the 12 used last
    pref.set(KNOWN_KEY, JSON.stringify(k));
    tellKnown();
  }
  function forgetPc(id) { const k = knownPcs(); if (!k[id]) return; delete k[id]; pref.set(KNOWN_KEY, JSON.stringify(k)); tellKnown(); }
  // discovery asks the addresses of PCs this phone is paired with (not ones it only saw)
  function tellKnown() {
    const k = knownPcs(), ips = [];
    for (const id of Object.keys(k)) if (pref.get(tokenKey(id), '')) for (const a of k[id].addrs || []) if (!ips.includes(a)) ips.push(a);
    nc('discoverKnown', JSON.stringify(ips.slice(0, 24)));
  }
  const pairedPc = (p) => !!(p && p.id && pref.get(tokenKey(p.id), ''));

  // faster links first: USB cable, Ethernet, a hotspot or direct link, Wi-Fi, then Bluetooth
  const LINK_RANK = { usb: 5, ethernet: 4, hotspot: 3, direct: 3, wifi: 2, bluetooth: 1 };
  const rankOf = (p) => LINK_RANK[(p && p.via) || 'wifi'] || 2;
  const busyMoving = () => [...st.pending.values()].some((p) => p.phase === 'sent' && !p.uploaded) || (st.incoming && st.incoming.size > 0) || V.items.some((x) => x.incoming);
  function onPcs() {
    // Bluetooth reports the PC it reached through the same list
    st.pcs = (st.lanList || []).filter((p) => p && p.ip && p.port).concat(st.btPc ? [st.btPc] : []);
    const pick = (id) => st.pcs.filter((p) => p.id === id).sort((a, b) => rankOf(b) - rankOf(a))[0];
    // PCs this phone is paired with first, then the faster link
    const best = () => st.pcs.slice().sort((a, b) => pairedPc(b) - pairedPc(a) || rankOf(b) - rankOf(a))[0];
    if (!st.pc && st.pcs.length) {
      const last = pref.get('lastPc', '');
      choosePc(pick(last) || best());
    } else if (st.pc) {
      const same = pick(st.pc.id);
      if (same) st.pcSeenAt = Date.now();
      // The PC in use isn't around but another paired one is (home → work): use that one, without anyone typing an
      // address. Only while not connected, and once the PC in use had a moment to answer.
      const other = !same && best();
      if (other && pairedPc(other) && !st.connected && !st.wsOpen && !busyMoving()) {
        const wait = 2500 - Math.min(Date.now() - (st.pcChosenAt || 0), Date.now() - (st.pcSeenAt || 0));
        if (wait <= 0) { closeLink(); choosePc(other); return; }
        clearTimeout(st.switchT);
        st.switchT = setTimeout(onPcs, wait + 50);          // look again then (discovery may stay quiet meanwhile)
      }
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
    st.pcChosenAt = Date.now();
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
  // certificate is the one this phone pinned. A PC that can't do encrypted links isn't used.
  async function prepareLink(pc) {
    if (pc.via === 'bluetooth') {
      if ((+pc.v || 1) < 4) { linkProblem('old'); return null; }
      return { ip: pc.ip, port: pc.port, chan: 'bluetooth', key: 'bt:' + pc.port };
    }
    const pin = pref.get(pinKey(pc.id), '');
    // a PC this phone pinned is known to encrypt, whatever a discovery reply (which anyone can send) says
    if (!pc.tls && !pin) { linkProblem('old'); return null; }
    const r = await nreqT(20000, 'tlsOpen', pc.ip, pc.port, pin);
    if (!r) return null;
    if (!r.ok) { if (r.why === 'pin') linkProblem('pin'); else if (r.why === 'tls') linkProblem('old'); return null; }
    return { ip: '127.0.0.1', port: r.port, chan: r.fp, fp: r.fp, pinned: !!pin, key: pc.ip + ':' + pc.port };
  }
  // where HTTP requests to the connected PC go (the encrypted link's local port, or the Bluetooth one)
  const linkBase = () => (st.link ? 'http://' + st.link.ip + ':' + st.link.port : 'http://0.0.0.0:0');

  // Why this phone can't connect to st.pc right now: said where the user is looking. Retrying slows down meanwhile.
  function linkProblem(kind) {
    st.linkBlocked = kind;
    const name = '<b>' + esc(st.pc ? st.pc.name : 'your PC') + '</b>';
    let msg = '';
    if (kind === 'old') msg = 'Flick on ' + name + ' needs updating before this phone can connect. Flick updates itself on the PC; restarting it there updates it now.';
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
      if (p.phase === 'lifted') { st.pending.delete(tid); if (p.job) nc('sendCancel', tid); }
      // the file already reached the PC; the "saved" note just can't arrive now
      else if (p.phase === 'sent' && p.uploaded) { st.pending.delete(tid); for (const it of itemsOf(p)) if (it.path || st.keep) restoreItem(it); }
    }
    st.pairAsked = false; st.awaitingApproval = false;
    // a pairing the PC already allowed can still be confirmed here (see 'paired'); one it hadn't is over
    if (!st.pairWait) st.pairOk = false;
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
    runHooks('conn');                        // the features (phone/features/*.js)
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
    st.replaced = false; st.pairAsked = true; st.noAuto = false;
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

  // A phone paired without the code confirms itself once: its token travelled over the network in the clear, so it
  // proves nothing by itself. Holding Connect pairs again, with the code on both screens.
  function needConfirm() {
    if (st.pairAsked || st.awaitingApproval || st.pairWait) return;
    if (st.screen !== 'pair') { st.wantResume = false; showScreen('pair'); }
    pairHint('Confirm this phone with <b>' + esc(st.pc ? st.pc.name : 'your PC') + '</b> once: hold <b>Connect</b>, then check that both screens show the same code.');
  }

  // The pairing code, and the user's half of the check: pairing completes only when the PC allowed it AND the user
  // said here that both screens show the same code. A stranger answering in the PC's place can send "paired" too, but
  // the PC's own screen won't show this code.
  function showPairCode() {
    const name = '<b>' + esc(st.pc ? st.pc.name : 'your PC') + '</b>';
    const code = '<b class="pcode">' + esc(st.pairCode.slice(0, 3) + ' ' + st.pairCode.slice(3)) + '</b>';
    const btn = '<br><button class="pok" id="pairOk">Same code</button>';
    if (st.pairOk) pairHint(code + '<br>Now click <b>Allow</b> on ' + name + '.');
    else if (st.pairWait) pairHint(name + ' allowed this phone. Tap <b>Same code</b> if it shows<br>' + code + btn);
    else pairHint(code + '<br>Check that ' + name + ' shows the same code, then click <b>Allow</b> there and tap <b>Same code</b> here.' + btn);
    const b = $('pairOk');
    if (b) b.onclick = () => { st.pairOk = true; haptic('tick'); if (st.pairWait) finishPairing(); else showPairCode(); };
  }

  function finishPairing() {
    const w = st.pairWait;
    if (!w || !st.pc || w.pc !== st.pc.id) { st.pairWait = null; return; }
    st.pairWait = null;
    pref.set(tokenKey(st.pc.id), w.token);
    // the certificate of the PC the user just approved is the one this phone trusts from now on
    if (w.fp) pref.set(pinKey(st.pc.id), w.fp);
    st.pairAsked = false; st.pairNonce = ''; st.pairCode = ''; st.pairOk = false;
    const held = st.pairConnected; st.pairConnected = null;
    if (w.gen !== wsGen || !st.wsOpen) { st.awaitingApproval = false; pairHint(''); openLink(); return; }   // signs in afresh
    if (st.link && w.fp && st.link.fp === w.fp) st.link.pinned = true;
    st.pcProved = true;
    st.trusted = true;
    pairHint('');
    // the PC said "connected" while this phone was still checking: take it now (or ask again, should it not come)
    if (held) onMsg(held);
    else {
      const gen = wsGen;
      setTimeout(() => { if (gen === wsGen && !st.connected && st.trusted) wsSend({ t: 'connect', user: true }); }, 1500);
    }
  }

  function onMsg(m) {
    switch (m.t) {
      case 'auth?': {
        // Sign-in: the PC shows it holds this phone's token (an HMAC over both random numbers and the link's identity:
        // the certificate this phone sees, or "bluetooth"). Only then does the phone prove the same in return; the
        // token itself never crosses the network.
        if (!st.pc || !st.link || (m.pc && m.pc.id && m.pc.id !== st.pc.id)) { closeLink(); break; }
        const chan = st.link.chan, nS = String(m.nonce || '');
        // Over Wi-Fi only a PC whose certificate this phone pinned when it paired can sign in. One without a pin was
        // paired without the code, with a token that crossed the network in the clear: it pairs once more instead.
        const pinned = chan === 'bluetooth' || st.link.pinned;
        const want = pinned && /^[0-9a-f]{32,64}$/.test(nS) ? nc('authProof', st.pc.id, 'pc', st.nonceP, nS, chan) : '';
        if (!want || !sameStr(want, m.proof)) {
          // not the PC this phone paired with, or it no longer knows this phone: prove nothing to it
          wsSend({ t: 'auth', proof: 'none' });
          if (hasToken()) { if (pinned) linkProblem('auth'); else needConfirm(); }
          break;
        }
        st.pcProved = true;
        wsSend({ t: 'auth', proof: nc('authProof', st.pc.id, 'phone', st.nonceP, nS, chan) });
        break;
      }
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
        if (!m.trusted && (st.link.pinned || st.link.chan === 'bluetooth') && m.why !== 'auth' && m.why !== 'confirm' && !st.pcProved) pref.set(tokenKey(st.pc.id), '');
        if (st.connectWanted && Date.now() - st.connectWanted < 10000) { st.connectWanted = 0; st.pairAsked = true; clearTimeout(connectT); sendConnectUser(); }
        else if (st.wantResume && st.trusted && !st.connected && !st.replaced) wsSend({ t: 'connect' });   // pick the session back up
        // a PC this phone is paired with: connected without holding Connect (Settings › Connect automatically), unless
        // the user disconnected or another phone took this PC over
        else if (settings.autoConnect !== false && st.trusted && hasToken() && !st.connected && !st.replaced && !st.noAuto) wsSend({ t: 'connect' });
        // paired without the code (a token but no pinned certificate): confirm once, whatever this PC claims
        else if (!st.trusted && (m.why === 'confirm' || (hasToken() && st.link.chan !== 'bluetooth' && !st.link.pinned))) needConfirm();
        else if (st.screen === 'pair' && !st.linkBlocked && !st.pairWait) pairHint('');
        break;
      case 'pairing': {
        if (!st.pairAsked || !st.pairNonce) break;  // only after this phone asked to connect
        const nS = String(m.nonce || '');
        if (!/^[0-9a-f]{32,64}$/.test(nS)) break;   // a PC that can't show a pairing code isn't paired with
        // the PC's half of the code is here: now this phone reveals its own, and both screens show the same code
        wsSend({ t: 'pair-reveal', nonce: st.pairNonce });
        st.pairCode = nc('pairCode', st.link.chan, st.pairNonce, nS) || '';
        st.pairOk = false; st.pairWait = null; st.pairConnected = null;
        st.awaitingApproval = true;
        setPcName();
        showPairCode();
        G.hold = 0.35;
        break;
      }
      case 'paired': {
        if (!st.pairAsked || !st.pairCode || typeof m.token !== 'string' || !/^[0-9a-f]{32}$/.test(m.token)) break;   // never a pairing this phone didn't ask for
        // The PC allowed this phone; it counts once the user has also said here that the codes match (showPairCode).
        // Over Bluetooth the phone sees no certificate: the PC names its own, to pin for Wi-Fi.
        const lk = st.link || {};
        const fp = lk.fp || (lk.chan === 'bluetooth' && /^[0-9a-f]{64}$/.test(String(m.fp || '')) ? m.fp : '');
        st.pairWait = { token: m.token, fp, gen: wsGen, pc: st.pc.id };
        if (st.pairOk) finishPairing(); else showPairCode();
        break;
      }
      case 'denied':
        st.pairAsked = false; st.pairOk = false; st.pairWait = null;
        st.awaitingApproval = false; setPcName();
        pairHint('The PC said no. Try again and click <b>Allow</b> on the PC.');
        G.hold = 0;
        haptic('reject');
        break;
      case 'connected':
        if (st.pairWait) { st.pairConnected = m; break; }   // allowed on the PC, not yet confirmed here (finishPairing)
        if (!hasToken() || !st.pcProved) break;
        lostSince = 0; st.lostToast = false;
        st.connected = true; st.trusted = true; st.awaitingApproval = false; st.connectWanted = 0;
        clearTimeout(connectT);
        // sends that wait for this PC (cut off earlier, or from before Flick was closed) carry on where it is now
        if (st.pc && st.pc.ip && st.pc.port) nc('sendRelink', st.pc.id, st.pc.ip, st.pc.port, st.pc.via || 'wifi');
        // found here: next time too, even where discovery can't see it (every address the PC has)
        rememberPc(st.pc, m.pc && Array.isArray(m.pc.addrs) ? m.pc.addrs : []);
        if (m.side) st.side = m.side;
        if (m.theme) applyTheme(m.theme);
        if (m.pc && m.pc.name) { st.pc.name = m.pc.name; pref.set('lastPcName', m.pc.name); }
        updateConn();
        UPD.pcKnows = 'app' in m;               // a PC that doesn't say can't hand out phone updates
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
      default: runHooks('ws', m); break;      // feature messages (clip, link, ring…): phone/features/*.js
    }
  }

  // ------------------------------------------------------------------ updates (from GitHub, or over Wi-Fi from the PC)
  // Both sources offer { code, name, size, sha256, url, sums, sig } (+ minSdk from the PC); the newer one wins. Whatever
  // is downloaded, Android-side code checks that Flick's release key signed sums (the release's SHA256SUMS, in sig) and
  // that it lists this exact file, that it is Flick, that version, and signed with Flick's key before it can be installed.
  const isNewer = (a) => !!(a && a.code > MY_CODE);
  const GH_DL = /^https:\/\/github\.com\/Maniw1234\/flick\/releases\/download\//;
  const canFetch = (a) => !!a && (a.src === 'github' || !!(st.connected && st.pc));
  const fits = (a) => !(+a.minSdk > 0 && +INFO.sdk > 0 && +INFO.sdk < +a.minSdk);   // this Android can install it
  const UNSIGNED = 'This update isn’t signed by Flick, so it won’t be installed';

  // signed: the offer carries a SHA256SUMS that lists this APK, and its signature (which only Android-side code checks)
  function withSig(a, sums, sig) {
    a.sums = typeof sums === 'string' ? sums : '';
    a.sig = typeof sig === 'string' ? sig : '';
    a.signed = !!a.sig.trim() && a.sums.split('\n').some((l) => {
      const m = /^([0-9a-fA-F]{64}) [ *](.+?)\r?$/.exec(l);
      return !!m && m[1].toLowerCase() === a.sha256.toLowerCase() && m[2] === 'Flick-' + a.name + '.apk';
    });
    return a;
  }

  function bestApp() {
    // an update this phone can't install is never offered; an unsigned one only once the user checks for updates
    // (a release goes out a little before it is signed: no alarm in between, just as the PC skips it quietly)
    const ok = (a) => !!a && fits(a) && (a.signed || UPD.loud);
    const p = ok(UPD.pcApp) ? UPD.pcApp : null, g = ok(UPD.ghApp) ? UPD.ghApp : null;
    if (!p || !g) return p || g;
    if (isNewer(p) && isNewer(g) && p.signed !== g.signed) return p.signed ? p : g;
    if (g.code !== p.code) return g.code > p.code ? g : p;
    return st.connected ? p : g;                        // same version: over Wi-Fi when connected
  }

  function applyApp() {
    const was = UPD.app;
    UPD.app = bestApp();
    const a = UPD.app;
    if (isNewer(a) && (!was || was.code !== a.code || was.sha256 !== a.sha256 || was.signed !== a.signed) && !/^(downloading|installing|perm)$/.test(UPD.state)) UPD.state = a.signed ? 'ready' : 'unsigned';
    if (!isNewer(a) && UPD.state !== 'installing') UPD.state = 'idle';
    renderUpd();
    if (UPD.state === 'ready' && canFetch(a)) autoFetch();
  }

  function onAppInfo(app, answer) {
    UPD.pcApp = app && app.code && app.size > 0 && /^[0-9a-f]{64}$/i.test(app.sha256 || '') && app.url ? withSig(Object.assign({}, app, { src: 'pc' }), app.sums, app.sig) : null;
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

  // sums, sig: the release's SHA256SUMS and SHA256SUMS.sig, which the Android side fetched with it (when it has them)
  function ghRelease(body, sums, sig) {
    const r = JSON.parse(body);
    if (!r || r.draft || r.prerelease) return null;
    for (const as of r.assets || []) {
      const m = /^Flick-(\d{1,3})\.(\d{1,2})\.(\d{1,2})\.apk$/.exec((as && as.name) || '');
      const d = /^sha256:([0-9a-f]{64})$/i.exec((as && as.digest) || '');
      if (m && d && as.size > 0 && GH_DL.test(as.browser_download_url || '')) {
        return withSig({ src: 'github', code: 100000 + +m[1] * 10000 + +m[2] * 100 + +m[3], name: +m[1] + '.' + +m[2] + '.' + +m[3], size: +as.size, sha256: d[1].toLowerCase(), url: as.browser_download_url }, sums, sig);
      }
    }
    return null;
  }

  function onGitHub(e) {
    if (e.ok) { try { UPD.ghApp = ghRelease(e.body, e.sums, e.sig); } catch (x) { UPD.ghApp = null; } }
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
    if (!isNewer(a) || !a.signed || !canFetch(a) || settings.autoUpdate === false) return;
    const ns = njson('updateState');
    if (!ns) return;                                    // this phone app can't update itself
    if (ns.ready === a.code && ns.readySha === a.sha256.slice(0, 16).toLowerCase()) { UPD.state = 'fetched'; renderUpd(); return; }
    if (ns.busy) return;
    UPD.auto = true;
    UPD.state = 'downloading'; UPD.got = 0; UPD.total = a.size || 0; UPD.why = '';
    renderUpd();
    if (nc('updateDownload', updUrl(a), String(a.code), String(a.size), a.sha256, a.sums, a.sig) === null) { UPD.auto = false; UPD.state = 'ready'; renderUpd(); }
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
    if (!a.signed) { UPD.state = 'unsigned'; renderUpd(); return; }
    if (!canFetch(a)) { toast('Connect to your PC to update', 2200); renderUpd(); return; }
    const ns = njson('updateState') || {};
    if (ns.ready === a.code && ns.readySha === a.sha256.slice(0, 16).toLowerCase()) { installUpdate(); return; }      // already downloaded and checked
    UPD.auto = false;
    UPD.state = 'downloading'; UPD.got = 0; UPD.total = a.size || 0; UPD.why = '';
    renderUpd();
    haptic('tick');
    if (nc('updateDownload', updUrl(a), String(a.code), String(a.size), a.sha256, a.sums, a.sig) === null) { UPD.state = 'error'; UPD.why = 'unsupported'; renderUpd(); }
  }

  function installUpdate() {
    UPD.state = 'installing';
    renderUpd();
    nc('updateInstall');
  }

  function checkForUpdates() {
    UPD.loud = true;                                    // the user asked: an unsigned update gets its message too
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
    if (/not signed/.test(w)) return UNSIGNED;
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
    $('moreBtn').classList.toggle('dot', newer && UPD.state !== 'installing' && UPD.state !== 'unsigned');
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
      case 'unsigned': title = 'Not installing Flick ' + v; sub = UNSIGNED; break;
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
    UPD.loud = false;
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
        else { UPD.auto = false; UPD.state = /not signed/.test(e.why || '') ? 'unsigned' : 'error'; UPD.why = e.why; renderUpd(); }
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
    renderHacts();                           // the order this view keeps (sort)
    runHooks('view');                        // the folder picker follows the view
  }

  function needsPermission() { return V.cat !== 'shelf' && !STG.granted; }

  function scrollActiveChip() {
    const b = chips.querySelector('.chip.on');
    if (b) { const r = b.getBoundingClientRect(); if (r.left < 8 || r.right > innerWidth - 8) chips.scrollBy({ left: r.left - innerWidth / 2 + r.width / 2, behavior: 'smooth' }); }
  }

  function resetView(cat, title) {
    if (SEL.on) setSelecting(false);
    if (SRCH.on) endSearch(true);            // a search belongs to the view it was started in
    V.gen++;
    V.cat = cat; V.title = title; V.items = []; V.more = false; V.total = 0; V.offset = 0; V.loading = false;
    st.hidden.clear();
    for (const [, el] of cards) el.remove();
    cards.clear();
    scroller.scrollTop = 0;
    $('empty').hidden = true;     // the last view's "Nothing here" mustn't show while this one loads
  }

  function openCat(cat) {
    if (String(cat).indexOf('pin:') === 0) { openPin(cat); return; }   // a pinned folder's tab
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

  function sortShelf(list) { return sortList(list.sort((a, b) => (b.added || 0) - (a.added || 0))); }

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
    V.items = sortList(data.items || []);
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
    const data = await catPage(V.offset);       // in the view's order, only matches while searching
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

  function visibleItems() { return V.items.filter((it) => !st.hidden.has(it.id) && shown(it)); }

  function updateCount() {
    let sending = 0, sent = 0, total = 0, rate = 0, waiting = 0;
    for (const [tid, p] of st.pending) if (p.phase === 'sent' && !p.uploaded && !st.jobs.has(tid)) { sending++; sent += p.sent || 0; total += p.total || 0; rate += p.rate || 0; }
    for (const j of st.jobs.values()) {
      if (!j.committed) continue;
      if (j.state === 'running' || j.state === 'queued') { sending++; sent += +j.sent || 0; total += +j.total || 0; rate += +j.rate || 0; }
      else if (j.state === 'waiting') waiting++;
    }
    $('count').classList.toggle('busy', sending + waiting > 0);
    if (!sending && waiting) { $('count').textContent = 'Waiting for ' + (([...st.jobs.values()].find((j) => j.state === 'waiting') || {}).pcName || 'your PC') + '…'; return void updateEmpty(); }
    const n = needsPermission() ? 0 : V.cat === 'dir' || SRCH.f ? visibleItems().filter((i) => !i.incoming).length : Math.max(V.total - st.hidden.size, visibleItems().length);
    const pct = total > 0 ? Math.min(99, Math.floor((sent / total) * 100)) : -1;
    $('count').textContent = sending ? 'Sending' + (pct >= 0 ? ' ' + pct + '%' : '…') + (rate > 0 && settings.showSpeed ? ' · ' + fmtRate(rate) : '') : n.toLocaleString() + (n === 1 ? ' item' : ' items');
    updateEmpty();
  }
  function updateEmpty() {
    const empty = !V.loading && !needsPermission() && visibleItems().length === 0;
    $('empty').hidden = !empty;
    if (empty) {
      const msgs = {
        shelf: ['Nothing here yet', 'Tap <b>+</b> to add files, or use <b>Share → Flick</b> from any app. Files from your PC also land here.'],
        dir: ['This folder is empty', ''], photos: ['No photos', ''], videos: ['No videos', ''], docs: ['No documents', ''],
        audio: ['No audio files', ''], apks: ['No APK files', ''], recent: ['Nothing recent', ''],
      };
      const m = SRCH.q ? ['No results', 'Nothing here matches “' + esc(SRCH.q) + '”'] : msgs[V.cat] || msgs.recent;
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
    const n = document.createElement('div'); n.className = 'name'; n.textContent = VIEW.list ? it.name : midName(it.name);
    const i = document.createElement('div'); i.className = 'info';
    i.textContent = it.dir ? (it.count === 1 ? '1 item' : (it.count || 0) + ' items') : it.incoming ? 'Receiving…' : fmtSize(it.size) + ' · ' + fmtWhen(it.mtime || it.added);
    if (VIEW.list) i.textContent = rowInfo(it);       // list rows: size, date and type
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
    if (VIEW.list) { listLayout(W); return; }  // rows, one under the other
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
  // several at once: one layout, and one write of the Flick list on the phone (one at a time if the app can only do that)
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
  // video takes a while) and answers with a 'saved' event, or at once with the folder.
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
        pinEntry(it.path, it.name),
        select,
      ]);
      return;
    }
    if (it.path) {
      const parent = it.path.replace(/\/[^/]*$/, '');
      openSheet(it.name, [
        { label: 'Send to ' + pcName, icon: 'send', run: () => sendItems([it]) },
        previewEntry(it),
        { label: 'Open', icon: 'open', run: () => { if (nc('openPath', it.path) === false) toast('Couldn’t open this file'); } },
        { label: 'Share', icon: 'share', run: () => nc('sharePath', it.path) },
        V.cat !== 'dir' || V.path !== parent ? { label: 'Show in folder', icon: 'folder', run: () => showInFolder(parent) } : null,
        select,
      ]);
      return;
    }
    openSheet(it.name, [
      { label: 'Send to ' + pcName, icon: 'send', run: () => sendItems([it]) },
      previewEntry(it),
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
    const all = V.items.filter((it) => !it.incoming && shown(it));
    $('selAll').textContent = all.length && all.every((it) => SEL.ids.has(it.id)) ? 'Select none' : 'Select all';
    const send = $('selSend');
    send.classList.toggle('off', !st.connected);
    $('selSendText').textContent = !st.connected ? 'Connect to send' : 'Send ' + (n === 1 ? '1 item' : n.toLocaleString() + ' items') + ' to ' + (st.pc ? st.pc.name : 'your PC');
  }
  $('selClose').onclick = () => { haptic('soft'); setSelecting(false); };
  $('selAll').onclick = () => {
    const all = V.items.filter((it) => !it.incoming && shown(it));   // (while searching: what the search shows)
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
    if (runHooks('pcTap')) return;           // several paired PCs: a sheet to switch
    if (st.connected) {
      openSheet('Connected to ' + st.pc.name, [
        { label: 'Disconnect', icon: 'off', danger: true, run: () => { st.wantResume = false; st.noAuto = true; closeLink(); showScreen('pair'); openLinkSoon(); } },
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
    const upd = isNewer(UPD.app) && UPD.app.signed;
    openSheet('', [
      upd ? { label: 'Update to Flick ' + (UPD.app.name || UPD.app.code), icon: 'update', tag: 'Ready', run: startUpdate } : null,
      { label: 'Animation', icon: 'spark', tag: themeOf(st.theme).name, run: themeSheet },
      ...runHooksList('menu'),               // the features' entries
      V.cat === 'dir' ? pinEntry(V.path, V.title, true) : null,
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
          ? { text: 'Disconnect', danger: true, run: () => { st.wantResume = false; st.noAuto = true; closeLink(); closeSettings(); showScreen('pair'); openLinkSoon(); } }
          : { text: 'Connect', run: () => { closeSettings(); showScreen('pair'); openLinkSoon(); } },
      } : { label: 'No PC yet', sub: 'Open Flick on your PC, then hold Connect', action: { text: 'Connect', run: () => { closeSettings(); showScreen('pair'); } } },
      { label: 'Connect automatically', sub: 'When Flick opens near a PC it’s paired with, no need to hold Connect', toggle: 'autoConnect' },
      { label: 'Ways to connect', sub: 'Wi-Fi, USB cable, hotspot or Bluetooth', run: waysSheet },
    ]);
    runHooks('settings', body);             // the Features section
    group('Transfers', [
      { label: 'Faster transfers', sub: 'Large files travel over several connections at once', toggle: 'parallel' },
      { label: 'Skip files already on the PC', sub: 'A photo or video your PC already has isn’t sent again', toggle: 'skipDup' },
      (st.pcProto || 1) >= 7 && st.connected && NV && typeof NV.speedTest === 'function'
        ? { label: 'Speed test', sub: st.speedSub || 'How fast files go to ' + (st.pc ? st.pc.name : 'your PC') + ' right now', action: { text: st.speedBusy ? 'Testing…' : 'Test', run: speedTest } } : null,
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
    runHooks('settings-end', body);         // the last sections (Send feedback)
  }
  // Settings › Speed test: bytes to the PC and back over several connections, and what the phone's Wi-Fi says
  async function speedTest() {
    if (st.speedBusy || !st.pc) return;
    st.speedBusy = true; st.speedSub = 'Testing for about 6 seconds…'; renderSettings();
    const r = await nreqT(30000, 'speedTest', st.pc.id, st.pc.ip, st.pc.port, st.pc.via || 'wifi');
    st.speedBusy = false;
    if (!r || !r.ok) st.speedSub = r && r.why === 'unpaired' ? 'Connect to your PC first' : 'Couldn’t reach ' + (st.pc ? st.pc.name : 'your PC');
    else {
      const w = r.wifi, mb = (b) => fmtRate(+b || 0);
      let s = 'To the PC ' + mb(r.up) + ' (1 GB in about ' + Math.max(1, Math.round(1073741824 / Math.max(1, +r.up || 1))) + ' s) · From the PC ' + mb(r.down);
      if (r.via === 'wifi' && w && w.band) s += ' · Wi-Fi ' + w.band + (w.mbps > 0 ? ' at ' + w.mbps + ' Mbit/s' : '');
      if (r.via === 'wifi' && w && w.band === '2.4 GHz') s += '. A 5 GHz or 6 GHz network is much faster.';
      else if (r.via === 'wifi' && +r.up < 30e6) s += '. Faster: a 5 or 6 GHz network close to the router, with the PC on a cable.';
      st.speedSub = s;
    }
    if (!$('settings').hidden) renderSettings();
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
  // A PC that keeps what arrived (protocol 7): the send is handed to the app, where it goes on with Flick closed,
  // waits while the PC can't be reached, and carries on from where it stopped (sendStart; see Sends/Outbox).
  function startSend(tid, items, committed) {
    const p = st.pending.get(tid);
    if ((st.pcProto || 1) >= 7 && NV && typeof NV.sendStart === 'function' && st.pc) {
      const spec = {
        pc: { id: st.pc.id, name: st.pc.name, ip: st.pc.ip, port: st.pc.port, via: st.pc.via || 'wifi' },
        items: items.map((x) => (x.path ? { path: x.path, name: x.name, dir: !!x.dir } : { id: x.id, name: x.name })),
        committed: !!committed, skipDup: settings.skipDup !== false, parallel: !!settings.parallel,
      };
      if (nc('sendStart', tid, JSON.stringify(spec)) === 'ok') { if (p) p.job = true; return; }
    }
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
  // The thumbnails a lift shows on the PC (nativeThumb of the first item, sheetThumbs of the next two), fetched by the
  // app without holding up the page: nativeThumb then finds them on the items. Resolves once they're in, or after ms.
  function thumbsAhead(items, ms) {
    const want = items.slice(0, 3).filter((x, i) => !x.dir && !x.thumbData && (i === 0 || x.kind === 'image' || x.kind === 'video'));
    if (!want.length || !NV || typeof NV.thumbsAsync !== 'function') return Promise.resolve();
    const list = want.map((x) => (x.path ? { path: x.path, mtime: x.mtime || 0, mid: x.mid || 0, mt: x.mt || 0 }
      : { id: String(x.id) }));
    return nreqT(ms, 'thumbsAsync', JSON.stringify(list)).then((r) => {
      const got = r && Array.isArray(r.thumbs) ? r.thumbs : [];
      want.forEach((x, i) => {
        if (typeof got[i] === 'string' && got[i] && !x.thumbData) x.thumbData = 'data:image/jpeg;base64,' + got[i];
      });
    }, () => {});
  }

  // the native side splits large files into this many parts when the PC understands it
  const parallelArg = () => ((st.pcProto || 1) >= 2 && settings.parallel && !(st.pc && st.pc.via === 'bluetooth') ? '&parallel=4' : '');
  function uploadUrl(tid, it) {
    const tok = pref.get(tokenKey(st.pc.id), '');
    const par = parallelArg();
    // protocol 6: the PC checks a file sent in parts against its SHA-256, which the native side sends once they're in
    return linkBase() + '/api/upload?tid=' + encodeURIComponent(tid) + '&device=' + encodeURIComponent(DEVICE) +
      '&token=' + encodeURIComponent(tok) + '&name=' + encodeURIComponent(it.name) + '&size=' + (it.size || 0) + par +
      (par && (st.pcProto || 1) >= 6 ? '&verify=1' : '');
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
    const fr = VIEW.list ? rowCard(it) : r;          // a list row travels as a card the size of the grid's
    D = {
      it, items, el, f: makeStackFloat(items, fr), w: fr.width, h: fr.height, how: how || 'swipe', fx0: fx, fy0: fy,
      offX: c.x0 - r.left, offY: c.y0 - r.top, x: r.left, y: r.top, fx, fy,
      r: 0, s: 1, sT: 1.065, vx: 0, vy: 0, samples: [{ t: now(), x: fx, y: fy }],
      tid: rid(), t0: now(), raf: 0, last: 0, phase: 'drag', sentMove: 0,
    };
    D.x = fx - D.offX; D.y = fy - D.offY;
    if (VIEW.list) rowLift(D, r);                    // (it grows out of the row's thumbnail, under the finger)
    for (const x of items) { const e2 = cards.get(x.id); if (e2) e2.classList.add('lifted'); }
    if (items.length > 1) gather(items.slice(1), () => (D ? { x: D.x, y: D.y, w: D.w, h: D.h } : { x: r.left, y: r.top, w: r.width, h: r.height }));
    haptic('lift');
    if (st.theme === 'teleport') { const src = nativeThumb(it); if (src) { D.sampleImg = new Image(); D.sampleImg.src = src; } }
    // a long press may only be selecting: nothing is sent until the finger actually moves
    if (D.how !== 'press') beginSend();
    D.raf = requestAnimationFrame(dragFrame);
  }
  // The send starts (sendStart) and the PC hears of it ('lift', with the thumbnails) once the card is drawn under the
  // finger and the app has read the thumbnails off the page's thread: both used to freeze the card as it was lifted.
  // Letting go before then starts it at once, so 'lift' still goes before 'drop'.
  function beginSend() {
    if (!D || D.sending || !st.connected) return;
    const d = D;
    if (!d.starting) {
      const go = d.starting = () => {
        if (D !== d || d.phase !== 'drag' || d.sending) return;         // put back (or gone) meanwhile
        if (!st.connected) { d.starting = null; return; }                // (asked again once connected)
        d.sending = true;
        st.pending.set(d.tid, { item: d.it, items: d.items, phase: 'lifted' });
        startSend(d.tid, d.items);
        wsSend({ t: 'lift', tid: d.tid, file: fileInfo(d.items), thumb: nativeThumb(d.it), thumbs: sheetThumbs(d.items), w: d.w, h: d.h, pw: innerWidth, ph: innerHeight });
      };
      const after = () => requestAnimationFrame(() => setTimeout(go, 0));    // after the next frame is on screen
      thumbsAhead(d.items, 600).then(after, after);
    }
    // while the finger moves (startDrag, dragMove) it waits for that; letting go (dragEnd) needs it now
    if (!(window.event && window.event.type === 'touchmove')) d.starting();
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
    if (D.row) rowFrame(D, dt);                      // a list row's card: from its thumbnail to the finger (rowLift)
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
      D.s = lerp(D.bs0, D.bs1 || 1, easeOut(u)); D.r = lerp(D.br0, 0, easeOut(u));
      if (D.row) rowBack(D, u);                      // shrinks back into the row's thumbnail
      if (u >= 1) { unlift(D.items); D.f.remove(); D = null; return; }
    }
    D.f.style.transform = 'translate3d(' + (D.x + (D.gx || 0)).toFixed(1) + 'px,' + (D.y + (D.gy || 0)).toFixed(1) + 'px,0) rotate(' + D.r.toFixed(2) + 'deg) scale(' + D.s.toFixed(4) + ')';

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
      if (p) { p.phase = 'sent'; if (p.job) nc('sendCommit', D.tid); }
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
        if (st.pending.get(D.tid).job) nc('sendCancel', D.tid); else nc('abort', D.tid);
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
      if (D.row) rowHome(D, r);
      EG.target = 0; egKick();
      haptic('soft');
    }
  }

  // send without dragging (⋯ menu, or the Send button while selecting): the stack flies off toward the PC by itself.
  // o.from: the rect it starts from; o.quiet: the caller shows it leaving (the preview)
  function sendItems(items, o) {
    o = o || {};
    items = (items || []).filter((x) => x && !x.incoming);
    if (!items.length) return;
    if (!st.connected) { toast('Not connected to your PC'); return; }
    const it = items[0];
    const el = cards.get(it.id);
    let r = o.from || (el ? el.querySelector('.thumb').getBoundingClientRect() : null);
    if (r && VIEW.list && !o.from) r = rowRect(it, r);         // a list row leaves as a card
    if (!r || r.bottom < 0 || r.top > innerHeight) {          // scrolled away: start from the middle of the screen
      const w = Math.min(190, innerWidth * 0.46), h = w * 0.75;
      r = { left: (innerWidth - w) / 2, top: innerHeight * 0.42 - h / 2, width: w, height: h, right: (innerWidth + w) / 2, bottom: innerHeight * 0.42 + h / 2 };
    }
    const tid = rid();
    st.pending.set(tid, { item: it, items, phase: 'sent' });
    startSend(tid, items, true);
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
    if (o.quiet) { setTimeout(settle, 450); return; }
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

  // ------------------------------------------------------------------ Air grab (features/air.js)
  // A fist over the phone picks files up: their upload starts at once, as for a lift, and the PC shows them waiting at
  // its edge. Taking the hand away toward the PC sends them ('air-go': the PC lands them where its camera sees the hand
  // open, or flies them in from the edge); opening the hand over the phone again puts them back.
  function itemAt(x, y) {
    const el = document.elementFromPoint(x, y);
    const card = el && el.closest ? el.closest('.card') : null;
    if (!card) return null;
    for (const [id, c] of cards) if (c === card) return V.items.find((it) => it.id === id && !it.incoming) || null;
    return null;
  }
  function airLift(items, rect) {
    items = (items || []).filter((x) => x && !x.incoming);
    if (!items.length) return null;
    if (!st.connected) { toast('Not connected to your PC'); return null; }
    const tid = rid();
    const it = items[0];
    st.pending.set(tid, { item: it, items, phase: 'lifted', air: true });
    startSend(tid, items);
    // a card's size on the PC (a photo open full screen is shown as large as a card in the grid)
    const k = rect ? Math.min(1, 230 / Math.max(rect.width, rect.height, 1)) : 1;
    wsSend({ t: 'lift', tid, air: true, file: fileInfo(items), thumb: nativeThumb(it), thumbs: sheetThumbs(items),
      w: rect ? Math.round(rect.width * k) : 160, h: rect ? Math.round(rect.height * k) : 120, y: rect ? Math.round(rect.top + rect.height * (1 - k) / 2) : undefined,
      pw: innerWidth, ph: innerHeight });
    for (const x of items) { const e2 = cards.get(x.id); if (e2) e2.classList.add('lifted'); }
    haptic('lift');
    return tid;
  }
  // o.video: { t } the second a playing video had reached (the PC opens it there)
  function airGo(tid, o) {
    const p = st.pending.get(tid);
    if (!p || p.phase !== 'lifted') return false;
    wsSend({ t: 'air-go', tid, video: o && o.video ? { t: Math.max(0, +o.video.t || 0) } : undefined });
    p.phase = 'sent';
    if (p.job) nc('sendCommit', tid);
    haptic('confirm');
    let hid = false;
    for (const x of itemsOf(p)) {
      x._sentAt = now();
      if (!x.path && !st.keep) { st.hidden.add(x.id); hid = true; }
    }
    if (hid) setTimeout(() => layout(true), 120);
    if (SEL.on) setSelecting(false);
    return true;
  }
  function airCancel(tid) {
    const p = st.pending.get(tid);
    if (!p || p.phase !== 'lifted') return;
    wsSend({ t: 'cancel', tid });
    if (p.job) nc('sendCancel', tid); else nc('abort', tid);
    st.pending.delete(tid);
    unlift(itemsOf(p));
  }
  function selectToggle(it) {
    if (!it || it.incoming) return;
    if (!SEL.on) { setSelecting(true); SEL.ids.add(it.id); haptic('tick'); renderSelection(); return; }
    toggleSel(it);
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
    runHooks('sent', itemsOf(p));            // the history notes what reached the PC
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
    // turned down on a PC set to "Ask each time": the send engine's job says so too (it may have sent every byte)
    if ((m.why === 'declined' || m.why === 'timeout') && st.jobs.has(m.tid)) nc('sendRefused', m.tid, m.why);
    // Air grab: held without being let go of for very long, or its upload failed while held, the PC put it back: so does
    // the phone (its background send stops)
    const held = st.pending.get(m.tid);
    if (m.why === 'held' || (m.why === 'upload' && held && held.air && held.phase === 'lifted')) {
      if (st.jobs.has(m.tid)) nc('sendCancel', m.tid); else nc('abort', m.tid);
    }
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
    const what = items.length > 1 ? items.length + ' items' : midName(p.item.name), pcName = st.pc ? st.pc.name : 'your PC';
    // a PC set to "Ask each time": its user said no, or nobody answered there within a minute
    toast(m.why === 'declined' ? pcName + ' declined ' + what : m.why === 'timeout' ? 'Not accepted on ' + pcName + ' in time'
      : m.why === 'held' ? 'Not sent: ' + what + ' was held too long' : 'Couldn’t send ' + what, 2600);
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

  // a send the app carries on with (features/transfers.js lists them): the toolbar shows how it's going
  function onJob(j) {
    if (!j || !j.tid) return;
    st.jobs.set(j.tid, j);
    if (st.jobs.size > 60) { for (const [k, v] of st.jobs) { if (st.jobs.size <= 50) break; if (['done', 'failed', 'canceled', 'skipped'].includes(v.state)) st.jobs.delete(k); } }
    updateCount();
  }
  $('count').onclick = () => { if (st.jobs.size && runHooks('countTap')) haptic('soft'); };

  function onUpDone(e) {
    const p = st.pending.get(e.tid);
    if (!p) return;
    if (e.ok) {
      p.uploaded = true;
      if (p.phase === 'sent' && !st.wsOpen) { st.pending.delete(e.tid); for (const it of itemsOf(p)) if (it.path || st.keep) restoreItem(it); }
      updateCount();
      return;
    }
    // the app's send engine already tried (and waited) as long as it made sense; canceled from the transfer list: quietly
    if (e.final && e.canceled) { st.pending.delete(e.tid); for (const it of itemsOf(p)) st.hidden.delete(it.id); for (const it of itemsOf(p)) restoreItem(it); layout(true); updateCount(); return; }
    p.tries = (p.tries || 0) + 1;
    if (!e.final && p.tries < 2 && st.connected && st.pc) { startSend(e.tid, itemsOf(p), p.phase === 'sent'); return; } // one quick retry
    if (p.phase === 'sent') { wsSend({ t: 'cancel', tid: e.tid, failed: true }); onFailed({ tid: e.tid }); }
    else p.failed = true;
  }

  // touch handling on the grid
  grid.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2 && !(D && D.phase === 'drag')) pinchStart(e);   // two fingers spreading on a file: its preview
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
    if (P && pinchMove(e)) return;
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
    if (P && (!e.touches || e.touches.length < 2)) P = null;
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
    // fetched first: scrolled far down, its card isn't drawn yet (it shows once the view is back at the top)
    const tok = pref.get(tokenKey(st.pc.id), '');
    const url = linkBase() + m.url + '?device=' + encodeURIComponent(DEVICE) + '&token=' + encodeURIComponent(tok) + parallelArg();
    nc('download', m.fid, url, m.name, String(m.size || 0), m.mime || '');
    const el = cards.get(it.id);
    if (!el) return;
    el.classList.add('ghost');
    const target = el.querySelector('.thumb');
    const w = VIEW.list ? LR.th : it._w, h = it._th;   // (a list row's thumbnail is small and square)
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
    runHooks('native', e);                   // the features see Android's events too
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
      case 'job': onJob(e.job); break;
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
    if (runHooks('back')) return true;       // feature pages and overlays
    if (closeSettings()) return true;
    if (D && D.phase === 'drag') { dragEnd(); return true; }
    if (SEL.on) { setSelecting(false); return true; }
    if (SRCH.on && st.screen === 'main') { endSearch(); return true; }
    if (st.screen === 'main' && V.cat === 'dir' && V.stack.length) { goBack(); return true; }
    if (st.screen === 'main' && !st.connected) { showScreen('pair'); return true; }
    return false;
  };

  // ------------------------------------------------------------------ list view
  // The grid's cards laid out as rows (small thumbnail, name, size · date · type). They are the same elements, so a tap,
  // a long press, selecting, the ⋯ menu and dragging off the edge to the PC work as they do on cards. A dragged row
  // travels as a card the size of the grid's (the size the PC shows it at), grown out of the row's thumbnail.
  const VIEW = { list: pref.get('layout', 'grid') === 'list' };
  const LR = { h: 64, th: 48 };                      // row height, thumbnail size
  grid.classList.toggle('list', VIEW.list);
  const TYPE_NAMES = { image: 'Image', video: 'Video', audio: 'Audio', pdf: 'PDF', text: 'Text', apk: 'APK' };
  function rowType(it) {
    const e = String(it.ext || extOf(it.name) || '').toUpperCase();
    return e && e.length <= 5 ? e : TYPE_NAMES[it.kind] || 'File';
  }
  function rowInfo(it) {
    const when = fmtWhen(it.mtime || it.added);
    if (it.dir) return (it.count === 1 ? '1 item' : (it.count || 0) + ' items') + ' · ' + when;
    return it.incoming ? 'Receiving…' : fmtSize(it.size) + ' · ' + when + ' · ' + rowType(it);
  }
  function listLayout(W) {
    const w = W - L.pad * 2;
    let y = 0;
    for (const it of geo) { it._x = L.pad; it._y = y; it._w = w; it._th = LR.th; y += LR.h; }
    maxCardH = LR.h;
    gridH = y;
    grid.style.height = gridH + 'px';
  }
  // the card the grid would show for this file
  function rowCard(it) {
    const w = Math.round((innerWidth - L.pad * 2 - L.gap) / 2);
    return { width: w, height: thumbH(it, w) };
  }
  // A dragged row's card starts small, over the row's thumbnail, and grows; once the finger moves it comes to the
  // finger (a long press that only selects keeps it in place). It is lifted whole on the screen, so letting go
  // without moving never sends it; the further it is dragged, the more it sits under the middle of the finger, so a
  // row touched near the edge can still be pushed over it. D.x/D.y are where the card is (reaching the edge is
  // measured with them); gx/gy is how far it still looks from there.
  function rowLift(d, r) {
    d.s = Math.min(1, Math.max(r.width / d.w, r.height / d.h));
    d.x = clamp(d.fx - d.w / 2, 4, innerWidth - d.w - 4);
    d.y = clamp(d.fy - d.h / 2, 4, innerHeight - d.h - 4);
    d.offX = d.fx - d.x; d.offY = d.fy - d.y;
    d.row = { s0: d.s, ox: d.offX, oy: d.offY };
    d.gx = r.left + r.width / 2 - (d.x + d.w / 2);
    d.gy = r.top + r.height / 2 - (d.y + d.h / 2);
  }
  function rowFrame(d, dt) {
    const moved = Math.hypot(d.fx - d.fx0, d.fy - d.fy0);
    const held = d.phase === 'drag' && d.how === 'press' && moved < 12;
    if (d.phase === 'drag') {
      d.sT = held ? 0.62 : 1.065;
      const k = clamp((moved - 12) / 80, 0, 1);
      d.offX = lerp(d.row.ox, d.w / 2, k); d.offY = lerp(d.row.oy, d.h / 2, k);
      d.x = d.fx - d.offX; d.y = d.fy - d.offY;
    }
    if (!held) { d.gx = damp(d.gx, 0, dt, 70); d.gy = damp(d.gy, 0, dt, 70); return; }
    const half = d.w * d.s / 2, cx = d.x + d.w / 2 + d.gx;           // only held: whole on the screen
    d.gx += clamp(cx, half + 4, innerWidth - half - 4) - cx;
  }
  // let go: back into the row's thumbnail
  function rowHome(d, r) {
    d.bx0 += d.gx; d.by0 += d.gy; d.gx = 0; d.gy = 0;
    d.bx1 = r.left + r.width / 2 - d.w / 2;
    d.by1 = r.top + r.height / 2 - d.h / 2;
    d.bs1 = d.row.s0;
  }
  function rowBack(d, u) {
    if (u > 0.6) { unlift(d.items); d.f.style.opacity = String(clamp((1 - u) / 0.4, 0, 1)); }
  }
  // sent from the menu or the Send button: the row's card leaves from the row
  function rowRect(it, r) {
    const c = rowCard(it);
    const left = clamp(r.left + r.width / 2 - c.width / 2, 4, innerWidth - c.width - 4), top = r.top + r.height / 2 - c.height / 2;
    return { left, top, width: c.width, height: c.height, right: left + c.width, bottom: top + c.height };
  }
  function setLayout(list) {
    list = !!list;
    if (VIEW.list === list) return;
    const keep = geo.find((it) => it._y + it._th > scroller.scrollTop);   // the file at the top stays at the top
    VIEW.list = list;
    pref.set('layout', list ? 'list' : 'grid');
    grid.classList.toggle('list', list);
    for (const [, el] of cards) el.remove();
    cards.clear();
    computeLayout();
    scroller.scrollTop = keep ? keep._y : 0;
    renderWindow(false);
    updateCount();
    renderHacts();
    haptic('tick');
  }

  // ------------------------------------------------------------------ sort and search (the file browser)
  // Every tab keeps its own order (pref 'sorts': { tab: 'name-asc' }; newest first when not set), and a folder tab's
  // order (Downloads, Phone storage, a pinned folder) holds for the folders opened from it. Folders stay on top.
  // Folders and the Flick list are sorted and searched here; the phone's categories by the app (querySorted).
  const SORT_ROWS = [
    ['name', 'Name', [['asc', 'A to Z'], ['desc', 'Z to A']]],
    ['date', 'Date', [['desc', 'Newest'], ['asc', 'Oldest']]],
    ['size', 'Size', [['desc', 'Largest'], ['asc', 'Smallest']]],
    ['type', 'Type', [['asc', 'A to Z'], ['desc', 'Z to A']]],
  ];
  let sorts = {};
  try { sorts = JSON.parse(pref.get('sorts', '{}')) || {}; } catch (e) { sorts = {}; }
  const viewKey = () => (V.cat === 'dir' ? V.rootCat || 'storage' : V.cat);
  const nativeSort = () => V.cat !== 'dir' && V.cat !== 'shelf' && !!(NV && typeof NV.querySorted === 'function');
  function sortOf() {
    const m = /^(name|date|size|type)-(asc|desc)$/.exec(String(sorts[viewKey()] || ''));
    return m ? { key: m[1], dir: m[2] } : { key: 'date', dir: 'desc' };
  }
  let coll = null;
  function cmpName(a, b) {
    if (!coll) { try { coll = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }); } catch (e) { coll = { compare: (x, y) => (x < y ? -1 : x > y ? 1 : 0) }; } }
    return coll.compare(String(a.name || ''), String(b.name || ''));
  }
  const typeOf = (x) => String(x.mime || x.ext || extOf(x.name) || '').toLowerCase();
  function sortList(list) {
    const s = sortOf(), sign = s.dir === 'asc' ? 1 : -1;
    const when = (x) => +(x.mtime || x.added) || 0;
    const by = s.key === 'name' ? (a, b) => cmpName(a, b) * sign
      : s.key === 'size' ? (a, b) => ((+a.size || 0) - (+b.size || 0)) * sign || cmpName(a, b)
      : s.key === 'type' ? (a, b) => (typeOf(a) < typeOf(b) ? -sign : typeOf(a) > typeOf(b) ? sign : 0) || cmpName(a, b)
      : (a, b) => (when(a) - when(b)) * sign || cmpName(a, b);
    // folders first, by name (the other way round only when sorting by name that way)
    return list.sort((a, b) => (b.dir ? 1 : 0) - (a.dir ? 1 : 0) || (a.dir ? cmpName(a, b) * (s.key === 'name' ? sign : 1) : by(a, b)));
  }
  // a page of a category: in the tab's order, and only what matches while searching
  function catPage(offset) {
    if (!nativeSort()) return nreqT(120000, 'queryAsync', V.cat, offset, PAGE);
    const s = sortOf();
    return nreqT(120000, 'querySorted', V.cat, offset, PAGE, s.key + '-' + s.dir, SRCH.on ? SRCH.q : '');
  }
  // the category again from its first page (another order, another search), same tab
  function requery() {
    V.gen++;
    if (SEL.on) setSelecting(false);
    for (const [, el] of cards) el.remove();
    cards.clear();
    V.items = []; V.offset = 0; V.total = 0; V.more = false; V.loading = false;
    scroller.scrollTop = 0;
    $('empty').hidden = true;
    loadMore();
  }
  function setSort(key, dir) {
    const k = viewKey();
    if (key === 'date' && dir === 'desc') delete sorts[k]; else sorts[k] = key + '-' + dir;
    pref.set('sorts', JSON.stringify(sorts));
    if (nativeSort()) {
      if (SRCH.saved) SRCH.saved = 'stale';          // the tab as it was before the search is in the old order
      requery();
    } else {
      sortList(V.items);
      layout(false);
      scroller.scrollTop = 0;
      renderWindow(false);
    }
    renderHacts();
  }
  function sortSheet() {
    openSheet('Sort by', []);
    const box = $('sheetItems'), cur = sortOf();
    for (const [key, label, dirs] of SORT_ROWS) {
      const row = document.createElement('div');
      row.className = 'sorow';
      row.appendChild(Object.assign(document.createElement('span'), { textContent: label }));
      const seg = document.createElement('div');
      seg.className = 'sseg';
      seg.setAttribute('role', 'radiogroup'); seg.setAttribute('aria-label', label);
      for (const [dir, text] of dirs) {
        const b = document.createElement('button');
        const on = cur.key === key && cur.dir === dir;
        b.className = on ? 'on' : '';
        b.textContent = text;
        b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', String(on));
        b.onclick = () => {
          if (now() - sheetAt < 350) return;
          haptic('tick');
          for (const x of box.querySelectorAll('.sorow button')) { x.classList.remove('on'); x.setAttribute('aria-checked', 'false'); }
          b.classList.add('on'); b.setAttribute('aria-checked', 'true');
          setTimeout(() => { closeSheet(); setSort(key, dir); }, 160);
        };
        seg.appendChild(b);
      }
      row.appendChild(seg);
      box.appendChild(row);
    }
  }

  // Search: in a folder or the Flick list the view is filtered here as you type (SRCH.f); in a category the app
  // searches the phone's media index, and the tab as it was comes back when the search ends.
  const SRCH = { on: false, q: '', f: null, saved: null, t: 0 };
  function shown(it) { return !SRCH.f || !!it.incoming || SRCH.f(it); }
  function fold(s) {
    s = String(s || '').toLowerCase();
    try { s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, ''); } catch (e) { /* as it is */ }
    return s;
  }
  function matcher(q) {
    const words = fold(q).split(' ').filter(Boolean);
    return (it) => { const n = it._fold || (it._fold = fold(it.name)); return words.every((w) => n.indexOf(w) >= 0); };
  }
  function openSearch() {
    if (SEL.on) return;
    if (!SRCH.on) {
      SRCH.on = true; SRCH.q = ''; SRCH.f = null; SRCH.saved = null;
      document.body.classList.add('searching');
      sIn.value = ''; sClear.hidden = true;
      sIn.placeholder = V.cat === 'recent' ? 'Search recent files' : V.cat === 'shelf' ? 'Search the Flick list' : 'Search ' + V.title;
    }
    sIn.focus();
  }
  function runSearch() {
    clearTimeout(SRCH.t);
    if (!SRCH.on) return;
    const q = sIn.value.trim().replace(/\s+/g, ' ').slice(0, 100);
    if (q === SRCH.q) return;
    SRCH.q = q;
    if (nativeSort()) {
      if (q && !SRCH.saved) SRCH.saved = { items: V.items, offset: V.offset, total: V.total, more: V.more, scroll: scroller.scrollTop };
      if (q) requery(); else restoreView();
      return;
    }
    SRCH.f = q ? matcher(q) : null;
    scroller.scrollTop = 0;
    layout(false);
  }
  // the category as it was before the search (or afresh, when its order changed meanwhile)
  function restoreView() {
    const s = SRCH.saved;
    SRCH.saved = null;
    if (s === 'stale' || (s && !s.items.length)) { requery(); return; }    // (searched before its first page came)
    if (!s) return;
    V.gen++;                                          // an answer still on its way was for the search
    for (const [, el] of cards) el.remove();
    cards.clear();
    V.items = s.items; V.offset = s.offset; V.total = s.total; V.more = s.more; V.loading = false;
    layout(false);
    scroller.scrollTop = s.scroll;
    renderWindow(false);
    renderHeader();
  }
  // leaving: the view is being replaced anyway (another tab or folder)
  function endSearch(leaving) {
    if (!SRCH.on) return;
    clearTimeout(SRCH.t);
    SRCH.on = false; SRCH.q = ''; SRCH.f = null;
    document.body.classList.remove('searching');
    try { sIn.blur(); } catch (e) { /* ignore */ }
    if (leaving) { SRCH.saved = null; return; }
    if (SRCH.saved) restoreView(); else layout(false);
  }

  // the header: search, sort and grid/list; the search field takes the title's place while searching
  const HIC = {
    search: '<svg viewBox="0 0 24 24"><circle cx="10.6" cy="10.6" r="6.1" fill="none" stroke="currentColor" stroke-width="2"/><path d="M15.2 15.2l4.6 4.6" stroke="currentColor" stroke-width="2.1" stroke-linecap="round"/></svg>',
    sort: '<svg viewBox="0 0 24 24"><path d="M4.5 7h9M4.5 12h6.5M4.5 17h4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M17.5 5.5v13M14.6 15.6l2.9 2.9 2.9-2.9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    list: '<svg viewBox="0 0 24 24"><rect x="3.5" y="4.5" width="5.2" height="5.2" rx="1.4" fill="none" stroke="currentColor" stroke-width="1.9"/><rect x="3.5" y="14.3" width="5.2" height="5.2" rx="1.4" fill="none" stroke="currentColor" stroke-width="1.9"/><path d="M12 7.1h8.5M12 16.9h8.5" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg>',
    grid: '<svg viewBox="0 0 24 24"><rect x="3.8" y="3.8" width="6.8" height="6.8" rx="1.8" fill="none" stroke="currentColor" stroke-width="1.9"/><rect x="13.4" y="3.8" width="6.8" height="6.8" rx="1.8" fill="none" stroke="currentColor" stroke-width="1.9"/><rect x="3.8" y="13.4" width="6.8" height="6.8" rx="1.8" fill="none" stroke="currentColor" stroke-width="1.9"/><rect x="13.4" y="13.4" width="6.8" height="6.8" rx="1.8" fill="none" stroke="currentColor" stroke-width="1.9"/></svg>',
    back: '<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    clear: '<svg viewBox="0 0 24 24"><path d="M7.5 7.5l9 9M16.5 7.5l-9 9" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>',
    folder: '<svg viewBox="0 0 24 24"><path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H10l2 2.2h6.5A2.5 2.5 0 0 1 21 9.7v7.8a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z" fill="currentColor"/></svg>',
  };
  Object.assign(ICONS, {
    eye: '<svg viewBox="0 0 24 24"><path d="M2.8 12s3.4-6.2 9.2-6.2 9.2 6.2 9.2 6.2-3.4 6.2-9.2 6.2S2.8 12 2.8 12z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><circle cx="12" cy="12" r="2.8" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>',
    pin: '<svg viewBox="0 0 24 24"><path d="M9.4 3.8h5.2l-.9 5.3 3.4 3.4v1.7H6.9v-1.7l3.4-3.4z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M12 14.2v6.3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
    left: '<svg viewBox="0 0 24 24"><path d="M14.5 6l-6 6 6 6" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    right: '<svg viewBox="0 0 24 24"><path d="M9.5 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  });
  function iconBtn(svg, label, run, cls) {
    const b = document.createElement('button');
    b.className = cls || 'hic';
    b.setAttribute('aria-label', label);
    b.appendChild(svgEl(svg));
    b.onclick = (e) => { e.stopPropagation(); run(); };
    return b;
  }
  const hActs = document.createElement('div');
  hActs.className = 'hacts';
  const sortBtn = iconBtn(HIC.sort, 'Sort', () => { haptic('soft'); sortSheet(); });
  const layoutBtn = iconBtn(HIC.list, 'List view', () => setLayout(!VIEW.list));
  hActs.append(iconBtn(HIC.search, 'Search', openSearch), sortBtn, layoutBtn);
  $('hdr').querySelector('.hrow').insertBefore(hActs, $('selAll'));
  const sBar = document.createElement('div');
  sBar.className = 'hsearch';
  const sField = document.createElement('label');
  sField.className = 'sfield';
  const sIn = document.createElement('input');
  sIn.type = 'search'; sIn.id = 'searchIn'; sIn.autocomplete = 'off'; sIn.spellcheck = false;
  sIn.setAttribute('enterkeyhint', 'search'); sIn.setAttribute('aria-label', 'Search');
  const sClear = iconBtn(HIC.clear, 'Clear search', () => { sIn.value = ''; sClear.hidden = true; runSearch(); sIn.focus(); }, 'sclear');
  sClear.hidden = true;
  sField.append(svgEl(HIC.search), sIn, sClear);
  sBar.append(iconBtn(HIC.back, 'Close search', () => { haptic('soft'); endSearch(); }, 'hback'), sField);
  $('hdr').insertBefore(sBar, chips);
  sIn.addEventListener('input', () => { sClear.hidden = !sIn.value; clearTimeout(SRCH.t); SRCH.t = setTimeout(runSearch, 140); });
  sIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { runSearch(); sIn.blur(); } });
  function renderHacts() {
    layoutBtn.innerHTML = '';
    layoutBtn.appendChild(svgEl(VIEW.list ? HIC.grid : HIC.list));
    layoutBtn.setAttribute('aria-label', VIEW.list ? 'Grid view' : 'List view');
    sortBtn.classList.toggle('dot', !!sorts[viewKey()]);   // not the usual order (newest first)
  }
  renderHacts();

  // ------------------------------------------------------------------ pinned folders: tabs after Documents
  // pref 'pins': [{ path, name }], in the tabs' order. A pinned folder opens like Downloads (its own tab, its own
  // order); press and hold its tab to move it or unpin it. Phone storage and Downloads have tabs already.
  let pins = [];
  try { pins = (JSON.parse(pref.get('pins', '[]')) || []).filter((p) => p && typeof p.path === 'string' && p.path); } catch (e) { pins = []; }
  const pinCat = (path) => 'pin:' + path;
  const isPinned = (path) => pins.some((p) => p.path === path);
  const pinnable = (path) => !!path && path !== STG.root && path !== STG.downloads;
  function savePins() { pref.set('pins', JSON.stringify(pins.map((p) => ({ path: p.path, name: p.name })))); renderPins(); }
  function renderPins() {
    for (const b of Array.from(chips.querySelectorAll('.chip.pin'))) b.remove();
    const docs = chips.querySelector('.chip[data-v="docs"]');
    const before = docs ? docs.nextSibling : null;
    for (const p of pins) {
      const b = document.createElement('button');
      b.className = 'chip pin';
      b.dataset.v = pinCat(p.path);
      b.appendChild(svgEl(HIC.folder));
      b.appendChild(Object.assign(document.createElement('span'), { textContent: p.name }));
      b.classList.toggle('on', V.cat === 'dir' && V.rootCat === b.dataset.v);
      b.onclick = () => { if (b._held) { b._held = false; return; } haptic('soft'); openCat(b.dataset.v); };
      onHold(b, () => pinMenu(p));
      chips.insertBefore(b, before);
    }
  }
  function openPin(cat) {
    const p = pins.find((x) => pinCat(x.path) === cat);
    if (!p) { openCat('recent'); return; }
    pref.set('lastView', cat);
    V.stack = [];
    resetView('dir', p.name);
    V.rootCat = cat;
    V.path = p.path;
    loadDir(p.path, p.name);
  }
  // the entry in a folder's menu (here: the ••• menu, for the folder that is open)
  function pinEntry(path, name, here) {
    if (!pinnable(path)) return null;
    if (isPinned(path)) return { label: here ? 'Unpin this folder' : 'Unpin from tabs', icon: 'pin', run: () => unpin(path) };
    return { label: here ? 'Pin this folder' : 'Pin to tabs', icon: 'pin', run: () => pin(path, name) };
  }
  function pin(path, name) {
    if (isPinned(path)) return;
    name = name || path.split('/').pop() || 'Folder';
    pins.push({ path, name });
    savePins();
    haptic('tick');
    toast('Pinned ' + midName(name) + ' to your tabs', 1800);
    const b = chips.querySelector('.chip.pin[data-v="' + CSS.escape(pinCat(path)) + '"]');
    if (b) { const r = b.getBoundingClientRect(); if (r.left < 8 || r.right > innerWidth - 8) chips.scrollBy({ left: r.left - innerWidth / 2 + r.width / 2, behavior: 'smooth' }); }
  }
  function unpin(path) {
    const p = pins.find((x) => x.path === path);
    if (!p) return;
    pins = pins.filter((x) => x !== p);
    delete sorts[pinCat(path)];
    pref.set('sorts', JSON.stringify(sorts));
    if (pref.get('lastView', '') === pinCat(path)) pref.set('lastView', 'storage');
    if (V.cat === 'dir' && V.rootCat === pinCat(path)) {
      // still open: it is a folder in Phone storage now
      V.rootCat = 'storage';
      if (!V.stack.length && path !== STG.root) V.stack = [{ path: STG.root, title: 'Phone storage', scroll: 0 }];
    }
    savePins();
    renderHeader();
    haptic('tick');
    toast('Unpinned ' + midName(p.name), 1600);
  }
  function movePin(i, d) {
    const j = i + d;
    if (j < 0 || j >= pins.length) return;
    const p = pins[i]; pins[i] = pins[j]; pins[j] = p;
    savePins();
    haptic('tick');
  }
  function pinMenu(p) {
    const i = pins.findIndex((x) => x.path === p.path);
    if (i < 0) return;
    openSheet(p.name, [
      { label: 'Open', icon: 'folder', run: () => openCat(pinCat(p.path)) },
      i > 0 ? { label: 'Move left', icon: 'left', run: () => movePin(i, -1) } : null,
      i < pins.length - 1 ? { label: 'Move right', icon: 'right', run: () => movePin(i, 1) } : null,
      { label: 'Unpin from tabs', icon: 'pin', run: () => unpin(p.path) },
    ]);
  }
  // press and hold (a tab): fn; the tap that ends it isn't a tap (el._held)
  function onHold(el, fn) {
    let t = 0, x0 = 0, y0 = 0;
    const stop = () => clearTimeout(t);
    el.addEventListener('pointerdown', (e) => { el._held = false; x0 = e.clientX; y0 = e.clientY; stop(); t = setTimeout(() => { el._held = true; haptic('lift'); fn(); }, 480); });
    el.addEventListener('pointermove', (e) => { if (Math.hypot(e.clientX - x0, e.clientY - y0) > 10) stop(); });
    el.addEventListener('pointerup', stop);
    el.addEventListener('pointercancel', stop);
    el.addEventListener('pointerleave', stop);
  }
  renderPins();

  // ------------------------------------------------------------------ preview (shown by features/preview.js)
  // Opened from a file's menu (Preview) or by spreading two fingers on its card: a tap still opens the menu, a long
  // press still lifts and selects, a sideways swipe still flicks, and two fingers did nothing on the grid before.
  const hasPreview = () => !!(runHooks.list && runHooks.list.preview && runHooks.list.preview.length);
  function previewEntry(it) { return hasPreview() && !it.dir ? { label: 'Preview', icon: 'eye', run: () => openPreview(it) } : null; }
  function openPreview(it) { if (it && !it.dir && !it.incoming) runHooks('preview', { item: it, rect: cardRect(it.id) }); }
  function viewFiles() { return visibleItems().filter((it) => !it.dir && !it.incoming); }
  function cardRect(id) {
    const el = cards.get(id);
    if (!el || !el.isConnected) return null;
    const r = el.querySelector('.thumb').getBoundingClientRect();
    return r.width && r.bottom > 0 && r.top < innerHeight ? r : null;
  }
  // scrolls the view so that this file's card is on screen (the preview closes onto it)
  function showItem(id) {
    const it = geo.find((x) => x.id === id);
    if (!it) return;
    const pad = parseFloat(getComputedStyle(scroller).paddingTop) || 0;
    const room = innerHeight - pad - 96, top = scroller.scrollTop;
    if (it._y < top || it._y + it._th > top + room) { scroller.scrollTop = Math.max(0, it._y - Math.max(0, (room - it._th) / 2)); renderWindow(false); }
  }
  function moreFiles() { if (V.more && !V.loading && V.cat !== 'dir' && V.cat !== 'shelf') loadMore(); }
  let P = null;                                      // two fingers on a card: { it, d0 }
  const fingers = (e) => Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
  function pinchStart(e) {
    P = null;
    if (SEL.on || !hasPreview()) return;
    const hit = document.elementFromPoint((e.touches[0].clientX + e.touches[1].clientX) / 2, (e.touches[0].clientY + e.touches[1].clientY) / 2);
    const tg = e.touches[0].target;
    const card = (hit && hit.closest && hit.closest('#grid .card')) || (tg && tg.closest && tg.closest('#grid .card'));
    const it = card && V.items.find((x) => x.id === card.dataset.id);
    if (it && !it.dir && !it.incoming) P = { it, d0: Math.max(20, fingers(e)) };
  }
  function pinchMove(e) {
    if (e.touches.length < 2) { P = null; return false; }
    if (e.cancelable) e.preventDefault();
    if (fingers(e) / P.d0 > 1.3) { const it = P.it; P = null; haptic('soft'); openPreview(it); }
    return true;
  }

  // ------------------------------------------------------------------ features (phone/features/*.js)
  // The feature files load before this file and queue their start functions in window.FlickFeatures. They reach the
  // app only through FlickApp below; the app calls them back through hooks (FlickApp.on(name, fn)):
  //   ws       a PC message the app doesn't handle itself (clip, link, ring, ring-stop)
  //   native   every Android event (before the app's own handling)
  //   sent     the items of a send the PC confirmed ('saved')
  //   back     Android's back button (return true when handled)
  //   menu     items for the ••• sheet (return one item or a list)
  //   settings the Settings page is being drawn (its body element; add sections to it)
  //   settings-end  the same, after the app's own sections
  //   pcTap    the PC button on the main screen (return true when handled)
  //   view     the file view changed (folder, category, loading)
  //   conn     connected or not
  //   preview  open a file full screen ({ item, rect }: rect = its card on screen, or null)
  function runHooks(name, a) {
    let r;
    for (const f of (runHooks.list && runHooks.list[name]) || []) {
      try { const x = f(a); if (r === undefined && x) r = x; } catch (err) { console.log('feature (' + name + ') failed: ' + err); }
    }
    return r;
  }
  function runHooksList(name) {
    const out = [];
    for (const f of (runHooks.list && runHooks.list[name]) || []) {
      try { const x = f(); if (x) out.push.apply(out, Array.isArray(x) ? x : [x]); } catch (err) { console.log('feature (' + name + ') failed: ' + err); }
    }
    return out;
  }
  runHooks.list = {};
  const FlickApp = Object.freeze({
    on(name, fn) { if (typeof fn === 'function') (runHooks.list[name] = runHooks.list[name] || []).push(fn); },
    // live state, for reading (a change to settings is kept with saveSettings())
    st, V, settings, INFO, DEVICE, LINK_NAMES, icons: ICONS,
    get stg() { return STG; },
    get sheetOpen() { return sheetOpen; },
    // the Android bridge: has(name) tells whether this phone app has that method
    has: (name) => !!(NV && typeof NV[name] === 'function'),
    nc, njson, pref, saveSettings, haptic,
    // the link to the PC. linkAuthed: the PC proved itself on this link (signed in), connected or not
    wsSend, linkTrusted, linkAuthed: () => !!(st.wsOpen && st.trusted && st.pcProved && hasToken()),
    paired: (pcId) => !!pref.get(tokenKey(pcId), ''), rankOf, busyMoving, choosePc, closeLink, openLinkSoon, knownPcs, forgetPc,
    // screens, sheets, toasts, formatting
    toast, openSheet, closeSheet, showScreen, openSettings, closeSettings, renderSettings,
    svgEl, esc, rid, fmtSize, fmtWhen, midName,
    // the file browser, and sending to the PC
    openCat, showInFolder, sendItems, phoneName, fmtRate,
    // the files the view shows (in its order), their thumbnails and cards: for the preview
    viewFiles, thumbUrl, cardRect, showItem, moreFiles, fmtDur,
    // Air grab: the file under a point, the selection, and a send in two steps (lift now, go or cancel later)
    itemAt, selected: selItems, selectToggle, airLift, airGo, airCancel, nativeThumb,
    get selecting() { return SEL.on; },
  });
  window.FlickApp = FlickApp;
  const FEATURES = {};                      // what the feature files share among themselves (features/core.js)
  for (const start of window.FlickFeatures || []) {
    try { start(FlickApp, FEATURES); } catch (err) { console.log('a feature failed to start: ' + err); }
  }

  // ------------------------------------------------------------------ boot
  window.addEventListener('resize', () => { measureHeader(); layout(false); wsSend({ t: 'screen', w: innerWidth, h: innerHeight, dpr: devicePixelRatio }); });
  measureHeader();
  openCat(STG.granted ? (pref.get('lastView', 'recent') || 'recent') : 'recent');
  setPcName();
  showScreen('pair');
  // sends the app is carrying on with (some may be from before Flick was opened)
  for (const j of njson('sendList') || []) if (j && j.tid) st.jobs.set(j.tid, j);
  updateCount();
  // the PC used last is remembered with the rest (from before this memory existed)
  if (pref.get('lastPc', '') && pref.get('lastPcAddr', '') && !knownPcs()[pref.get('lastPc', '')]) {
    const a = pref.get('lastPcAddr', '').split(':');
    rememberPc({ id: pref.get('lastPc', ''), name: pref.get('lastPcName', ''), ip: a[0], port: +a[1] || 47860 }, []);
  }
  tellKnown();
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
