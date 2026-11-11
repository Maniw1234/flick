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
  // how long ago a time taken with now() was (never: forever ago). Waits are counted on it, not on the phone's clock:
  // set ahead or back while Flick is open, the clock had a healthy link dropped, Connect held on or cut short, a
  // PC that forgot this phone said so instead of pairing again as Connect asked
  const since = (t) => (t ? now() - t : Infinity);
  // Android's Remove animations (Settings › Accessibility): what only moves for show keeps still (the Connect screen's
  // glow, the flash once connected), as on the features' pages
  // Settings › Advanced settings › Animations off goes the same way here: the effects keep still (a card comes and goes
  // without its animation's look), what they say is still said. (What app.css itself keeps still for Remove animations,
  // a line that breathes, the cable's bar sliding in, follows Android's setting only.)
  const sysCalm = (() => { try { return window.matchMedia('(prefers-reduced-motion: reduce)'); } catch (e) { return { matches: false }; } })();
  const calm = { get matches() { return !!sysCalm.matches || !fxOn(); } };
  const damp = (cur, target, dt, ms) => target + (cur - target) * Math.exp(-dt / ms);
  const rid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // a name from the network, as text without direction controls (a PC named "Mia" + U+202E showed the rest of a
  // sentence backwards). One of only invisible marks (U+3164, joiners, a zero-width space) is none: it showed as a blank
  // where the computer says "Phone" or "PC" (as the computer's cleanName does)
  const SEEN_NAME = /[^\s\p{Z}\p{Cc}\p{Cf}\p{M}\u115f\u1160\u2800\u3164\uffa0]/u;   // (marks alone: on nothing)
  const cleanName = (s) => { const t = String(s == null ? '' : s).replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '').trim(); return SEEN_NAME.test(t) ? t : ''; };
  // ...and in a sentence built as HTML (the Connect screen's hint): bold, and set apart, so a Hebrew or Arabic name
  // doesn't reorder the words around it either. d: what to say when it has no name
  const nameHtml = (s, d) => '<b><bdi>' + esc(cleanName(s) || d || '') + '</bdi></b>';
  // whether a keyboard or a switch put the focus there (:focus-visible is newer than Android 9's WebView, where asking
  // threw: there, whether a key was the last thing pressed)
  // (html.keys says so to app.css, which draws the keyboard's focus ring by it where :focus-visible isn't known)
  let keyLast = false;
  document.addEventListener('keydown', () => { if (!keyLast) { keyLast = true; document.documentElement.classList.add('keys'); } }, { capture: true, passive: true });
  document.addEventListener('pointerdown', () => { if (keyLast) { keyLast = false; document.documentElement.classList.remove('keys'); } }, { capture: true, passive: true });
  function focusVisible(el) { try { return el.matches(':focus-visible'); } catch (e) { return keyLast && document.activeElement === el; } }
  const SVG_T = new Map();       // each SVG string is parsed once, then cloned
  function svgEl(html) {
    let t = SVG_T.get(html);
    if (!t) {
      t = document.createElement('template'); t.innerHTML = html.trim(); SVG_T.set(html, t);
      // (an icon: what it's on says what it is. A screen reader found a nameless image in each, in every card twice)
      const s = t.content.firstChild;
      if (s && s.nodeName.toLowerCase() === 'svg') s.setAttribute('aria-hidden', 'true');
    }
    return t.content.firstChild.cloneNode(true);
  }

  // ------------------------------------------------------------------ text size
  // Android's font size, which the app gives the page as its text zoom (85% to 200%): every font size grows by it (a size
  // in em with it), boxes in px don't. What holds text grows with it (app.css), the grid's captions and rows are made
  // taller here, and very large headings grow less (as Android's own do). A probe 1em tall in 100px text says how much,
  // and says so again when it changes (Flick open as the setting is changed: see onZoom).
  const fzp = document.createElement('i');
  fzp.id = 'fzp'; fzp.setAttribute('aria-hidden', 'true');
  document.body.appendChild(fzp);
  function readZoom() { const v = parseFloat(getComputedStyle(fzp).fontSize) / 100; return v >= 0.5 && v <= 4 ? Math.round(v * 100) / 100 : 1; }
  let TZ = readZoom();

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
  // a request the app answers with a 'res' event; null when no answer came within ms (each caller says how long: listing
  // a huge folder, or a slow SD card, takes far longer than the rest)
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
  const SETTINGS_DEFAULTS = { parallel: true, showSpeed: true, haptics: true, autoUpdate: true, bluetooth: false, phoneName: '', skipDup: true, autoConnect: true, sounds: true };
  const settings = (() => {
    try { return Object.assign({}, SETTINGS_DEFAULTS, JSON.parse(pref.get('settings', '{}')) || {}); } catch (e) { return Object.assign({}, SETTINGS_DEFAULTS); }
  })();
  function saveSettings() { pref.set('settings', JSON.stringify(settings)); }
  // The animations (the full-screen effects, the Connect screen's glow, their sounds): a new install starts with them off
  // (the app marks it: pref newInstall '1'); settings kept by an older Flick have no effects, and keep them on
  if (typeof settings.effects !== 'boolean') settings.effects = pref.get('newInstall', '0') !== '1';
  function fxOn() { return settings.effects !== false; }
  const haptic = (k) => { if (settings.haptics !== false) nc('haptic', k); };

  const INFO = njson('info') || {};
  const PLAY = INFO.store === 'play';              // the Google Play version: Play updates it, so no update checks here
  const DEVICE = INFO.device || pref.get('device', null) || (() => { const d = 'web-' + rid(); pref.set('device', d); return d; })();
  const DEVNAME = INFO.name || 'Android phone';
  const NAME_MAX = 40;                             // the phone's name: UTF-16 units at most (the PC keeps 60)
  // (cut between characters: an emoji over the 40th place was cut in half, "�" on the PC; a name kept by an older version
  // that ends in such a half loses it)
  const phoneName = () => cutName(String(settings.phoneName || '').replace(/[\ud800-\udbff](?![\udc00-\udfff])|(^|[^\ud800-\udbff])[\udc00-\udfff]/g, '$1').trim(), NAME_MAX) || DEVNAME;
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
  // multi-select: ids of the selected items in the current view (at: see selSend; busy: Select all is listing the rest;
  // n: counts each time selecting starts or ends)
  const SEL = { on: false, ids: new Set(), at: 0, busy: false, n: 0 };
  // Connect (see "Connect: hold it here, Allow on the other device"): newDev: the user asked for another device than the
  // paired PC here; phase idle | looking | asking; target: the device asked; near: the devices it could ask now
  // (started: a phone asked has shown it's pairing; att0: its pairing requests counted before this one (see onAskPeers);
  // askT: see askDevice; failAt: when an asking last ended without a pairing; back: the paired PC that made way for a PC
  // being asked; same: Same code tapped for the phone asked)
  let foundSaid = new Set();          // (devices said found on the Connect screen: saidFound)
  const CN = { newDev: false, phase: 'idle', target: null, near: [], peers: null, lookT: 0, fastT: 0, at: 0, started: false, att0: 0,
    askT: 0, failAt: 0, back: null, same: false };
  // a PC's request allowed here, its user checking the code there (see homeWait): which, its name, the screen it was
  // allowed over
  const HOME = { device: '', name: '', from: '', t: 0, show: false };
  const HOME_MS = 130000;                          // (two minutes there, and a moment for its pairing to come)
  // what finding phones over Bluetooth needs, as the page last heard it (see 'ble-perm'): allowed, Bluetooth on, and on
  // Android 10 and 11 Location on (location false: off there, and nothing is found)
  const bleKeyOf = (b) => [!!b.permitted, !!b.on, b.location !== false].join();
  let bleKey = bleKeyOf(njson('bleState') || {});
  // the USB cable: plugged into a computer, USB tethering on (UsbWatch.java); what its bar has done (usbRender)
  const USB = Object.assign({ cable: false, tether: false, phone: false }, njson('usbState') || {});
  const usbUi = { off: false, readyAt: 0, t: 0, lookAt: 0, h: 0 };
  // another phone on the same cable, linked to this one (UsbPeer): { id, name }
  const usbPeer = { id: '', name: '' };
  // wireless update: the PC announces the newest phone app it has; app = { code, name, size, sha256, url, sums, sig }
  // (auto: being fetched by itself; wifi: not fetched by itself, the phone being on mobile data: it waits for Wi-Fi)
  const UPD = { app: null, pcApp: null, ghApp: null, ghAt: 0, ghAsk: false, pcKnows: false, state: 'idle', got: 0, total: 0, why: '', dismissed: 0, checkT: 0, auto: false, loud: false, wifi: false };
  const MY_CODE = +INFO.code || 0;

  // ------------------------------------------------------------------ animations (the PC is the source of truth)
  // Surprise me: each flick gets one of the four at random, chosen here (and told to the PC with the flick)
  const THEMES = [
    { v: 'meteor', name: 'Meteor', desc: 'Catches fire and crashes down' },
    { v: 'volt', name: 'Volt', desc: 'Jumps across on lightning' },
    { v: 'warp', name: 'Warp', desc: 'Flies out of a tunnel of light' },
    { v: 'glitch', name: 'Glitch', desc: 'Skips across like a broken signal' },
    { v: 'surprise', name: 'Surprise me', desc: 'A different one for each file' },
  ];
  const LOOKS = ['meteor', 'volt', 'warp', 'glitch'];
  // (an older choice, gone now, is Meteor)
  function themeOf(v) { return THEMES.find((t) => t.v === v) || THEMES[0]; }
  let lastLook = null;
  function pickLook() {
    if (st.theme !== 'surprise') return LOOKS.includes(st.theme) ? st.theme : 'meteor';
    const opts = LOOKS.filter((l) => l !== lastLook);
    lastLook = opts[Math.floor(Math.random() * opts.length)];
    return lastLook;
  }
  // flicks this phone sent lately: the PC says when each one's card hits its desktop ('landed'), and the phone thuds
  const flung = new Map();
  function flungNow(tid) { const t = now(); flung.set(tid, t); for (const [k, v] of flung) if (t - v > 15000) flung.delete(k); }
  st.theme = themeOf(pref.get('theme', 'meteor')).v;
  function applyTheme(v) {
    const t = themeOf(v).v;
    st.theme = t;
    document.body.dataset.theme = t;
    pref.set('theme', t);
  }
  applyTheme(st.theme);
  const towardSign = () => (st.side === 'right' ? -1 : 1); // +x direction that points at the PC

  // ------------------------------------------------------------------ numbers
  // How many, in the phone's own digits and grouping ("3,335", "٣٬٣٣٥", "3.335"), by one formatter made just after the
  // first frame (see boot): the page's first toLocaleString() had Chromium ready its number formatting on the way to the
  // first screen, 30 ms of a mid-range phone's start. Until then the count says nothing and a toast with a number waits
  // (see toast): a plain "160" first would change a moment later into Arabic, Persian or Bengali digits, and from 1,000
  // up in every language. Made anew in another language, as the dates are (whenFmt).
  let numF = null;
  function numFmt() {
    if (!numF || numF.loc !== navigator.language) numF = { loc: navigator.language, f: new Intl.NumberFormat() };
    return numF.f;
  }
  const fmtNum = (n) => numFmt().format(n);
  window.addEventListener('languagechange', () => { if (numF) numF.loc = null; });

  // ------------------------------------------------------------------ toast / sheets
  let toastT = 0, toastWait = null;
  // msg: the words, or a function that makes them with a number in them (fmtNum): one before numbers can be written,
  // just after the first frame, waits for them (a frame or so), unless another toast comes meanwhile
  // read: steps to follow (Ways to connect): up long enough to read them, 3 s and a second for every 3 words, and the
  // next tap puts them away (they went after 3-4 s, mid-sentence for a slow reader or large text)
  function toast(msg, ms, read) {
    if (typeof msg === 'function') { if (!numF) { toastWait = [msg, ms, read]; return; } msg = msg(); }
    toastWait = null;
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('on');
    t.classList.toggle('tap', !!read);
    if (read) ms = Math.max(ms || 0, 3000 + Math.round(String(msg).split(/\s+/).length * 1000 / 3));
    clearTimeout(toastT);
    toastT = setTimeout(() => t.classList.remove('on', 'tap'), ms || 2200);
  }
  // (the next tap anywhere puts it away, and still does what it was for: it lies over Settings' Back)
  document.addEventListener('pointerdown', () => { const t = $('toast'); if (t.classList.contains('tap')) { clearTimeout(toastT); t.classList.remove('on', 'tap'); } }, { capture: true, passive: true });

  // Said to a screen reader without showing anything (the cards already show it: a card that flew away). The same words
  // twice in a row are said twice: emptied first, then written a moment later.
  // Words that come while others still wait to be written are joined to them: two files reaching the PC together said
  // only the second.
  let saidT = 0, saidWait = '';
  function sayQuietly(msg) {
    const el = $('said');
    el.textContent = '';
    clearTimeout(saidT);
    saidWait = saidWait ? saidWait + (/[.!?…]$/.test(saidWait) ? ' ' : '. ') + msg : msg;
    saidT = setTimeout(() => { el.textContent = saidWait; saidWait = ''; saidT = setTimeout(() => { el.textContent = ''; }, 6000); }, 60);
  }

  const ICONS = {
    photo: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="3" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M3.5 16l5-4.5 4 3.5 3-2.5 5 4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><circle cx="16" cy="9.5" r="1.6" fill="currentColor"/></svg>',
    file: '<svg viewBox="0 0 24 24"><path d="M7 3h7l5 5v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M14 3v5h5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>',
    send: '<svg viewBox="0 0 24 24"><path d="M4 12h13M12 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    open: '<svg viewBox="0 0 24 24"><path d="M14 4h6v6M20 4l-9 9M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    share: '<svg viewBox="0 0 24 24"><path d="M12 3v12M7 8l5-5 5 5M5 13v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    save: '<svg viewBox="0 0 24 24"><path d="M12 4v11M7 10l5 5 5-5M5 20h14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    trash: '<svg viewBox="0 0 24 24"><path d="M5 7h14M10 7V5h4v2M7 7l1 12a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2l1-12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    pc: '<svg viewBox="0 0 24 24"><rect x="3" y="4.5" width="18" height="12" rx="1.9" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M8.5 20h7M12 16.5V20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
    phone: '<svg viewBox="0 0 24 24"><rect x="6.6" y="2.8" width="10.8" height="18.4" rx="2.6" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M10.6 18.1h2.8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
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
  // how far a file coming in got (its card's ring)
  const PROG_SVG = '<svg class="prog" viewBox="0 0 28 28"><circle cx="14" cy="14" r="12" fill="rgba(0,0,0,.55)"/><circle class="arc" cx="14" cy="14" r="8.5" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-dasharray="53.4" stroke-dashoffset="53.4" transform="rotate(-90 14 14)"/></svg>';

  let sheetOpen = false, sheetAt = 0;
  let sheetHideT = 0, sheetFrom = null, sheetFocused = false;
  let sheetGen = 0, sheetRaf = 0;
  // what a menu puts out of reach (sheetBlock): the screens, and the open feature pages and the Preview, under it too
  const sheetTargets = () => [$('pair'), $('main'), $('settings')].filter((el) => !el.hidden).concat(Array.from(document.querySelectorAll('.fpage:not([hidden]), .fpv:not([hidden])')));
  // a text field being typed in (not a switch)
  const typing = (el) => el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && !/^(checkbox|radio|range|button|submit|reset|color|file|image)$/.test(el.type));
  // when a keyboard or a screen reader (a click no finger or mouse made: TalkBack's double tap) was used last
  let pressedAt = 0, assistAt = 0, focusedAt = 0;
  document.addEventListener('pointerdown', () => { pressedAt = now(); }, { capture: true, passive: true });
  // (the files in use by focus too, the keyboard's or a screen reader's: Flick's boot doesn't move them from under it)
  document.addEventListener('focusin', (e) => { if (e.target.closest && e.target.closest('#main')) focusedAt = now(); }, { capture: true, passive: true });
  document.addEventListener('keydown', () => { assistAt = now(); }, { capture: true, passive: true });
  document.addEventListener('click', () => { if (now() - pressedAt > 1000) assistAt = now(); }, { capture: true, passive: true });
  // Sheets that wait their turn (o.wait: something that came by itself, a link from another phone): one replaced the sheet
  // open under the finger, so a tap meant for that one did what the new one offered. Shown one after another, each once
  // no other sheet is open.
  const sheetQ = [];
  // where the keyboard lands in a menu: its first item, or the one named by o.focus (a question's Cancel: Remove first,
  // an Enter pressed once more deleted)
  function firstItem(box, o) {
    const all = Array.from(box.querySelectorAll('button:not([disabled]), input, [tabindex]')).filter((x) => x.tabIndex >= 0);
    return (o && o.focus && all.find((x) => x.textContent === o.focus)) || all[0] || null;
  }
  function openSheet(title, actions, o) {
    if (o && o.wait && !$('sheet').hidden) { sheetQ.push([title, actions, o]); return; }
    clearTimeout(sheetHideT);          // a sheet opened from another sheet must not be hidden by its close timer
    sheetAt = now();
    const sh = $('sheet');
    $('sheetTitle').textContent = title || '';
    $('sheetTitle').style.display = title ? '' : 'none';
    const box = $('sheetItems');
    box.innerHTML = '';
    box.classList.remove('tsheet');
    box.removeAttribute('role'); box.removeAttribute('aria-label');
    let tiles = null;
    for (const a of actions) {
      if (!a) continue;
      // (the ••• menu's places, Other phones, History and Settings: side by side at its top, as the PC's bar)
      if (a.tile && !tiles) { tiles = document.createElement('div'); tiles.className = 'stiles'; box.appendChild(tiles); }
      if (!a.tile) tiles = null;
      const b = document.createElement('button');
      // (a long note, or large text: the note goes under the item's words; beside them it squeezed them into broken
      // pieces, "Send / clipboar / d")
      const stack = !!a.tag && (String(a.tag).length > 16 || TZ >= 1.25);
      b.className = 'sitem' + (a.tile ? ' stile' : '') + (a.danger ? ' danger' : '') + (stack && !a.tile ? ' stack' + (a.icon ? '' : ' bare') : '');
      if (a.icon) b.appendChild(svgEl(ICONS[a.icon]));
      const s = document.createElement('span'); s.textContent = a.label; b.appendChild(s);
      if (a.tag) { const t = document.createElement('span'); t.className = 'tag'; t.textContent = a.tag; b.appendChild(t); }
      // (once: a second tap or Enter as the sheet slides away isn't another go, see sheetEat)
      b.onclick = () => { if (now() - sheetAt < 350 || sh.classList.contains('closing')) return; closeSheet(); setTimeout(a.run, 60); };
      (tiles || box).appendChild(b);
    }
    if (o && o.note) { const n = document.createElement('p'); n.className = 'snote'; n.textContent = o.note; box.appendChild(n); }
    const from = document.activeElement;
    if ((sh.hidden || sh.classList.contains('closing')) && !sh.contains(from)) { sheetFrom = from; sheetFocused = false; }
    sh.hidden = false; sh.classList.remove('closing');
    sheetOpen = true;
    // What's behind goes out of reach once the menu's first frame is drawn: in the same frame it made the menu slower to
    // show (2-3 times the work, on a slow phone 8 ms instead of 3). Meanwhile Tab already goes round the menu's items.
    const gen = ++sheetGen;
    cancelAnimationFrame(sheetRaf);
    sheetRaf = requestAnimationFrame(() => setTimeout(() => {
      if (!sheetOpen || gen !== sheetGen) return;
      // (a menu that opened by itself, a link from another phone, with the keyboard or a screen reader on what goes out
      // of reach: it's taken into the menu, and back once it's closed. It dropped to the start of the page)
      // (Not for a menu a finger opened, though the keyboard was last on a file: it showed a focus ring. Nor away from a
      // text field being typed in, the search's: it stays in reach, it and its Clear, and keeps its keyboard)
      const a0 = document.activeElement;
      const behind = a0 && a0 !== document.body && !sh.contains(a0) && sheetTargets().some((el) => el.contains(a0));
      const keep = behind && typing(a0) ? (a0.closest('label') || a0) : null;
      const finger = pressedAt > assistAt && sheetAt - pressedAt < 2000;
      if (behind && !keep && !finger) {
        const f = firstItem(box, o);
        if (f) { f.focus({ preventScroll: true }); sheetFocused = true; }
      }
      sheetBlock(true, keep);
    }, 0));
    haptic('soft');
    // A screen reader (or a keyboard) is taken to the menu: it comes last on the page, after every card, so TalkBack
    // reached it only past all of them. (Not for a finger: its menu would show a focus ring. Nor away from a text
    // field being typed in: its keyboard would go.)
    setTimeout(() => {
      const a = document.activeElement;
      if (!sheetOpen || assistAt < pressedAt || now() - assistAt > 1000 || (a && /^(INPUT|TEXTAREA)$/.test(a.tagName) && !sh.contains(a))) return;
      const f = firstItem(box, o);
      if (f) { f.focus({ preventScroll: true }); sheetFocused = true; }
    }, 0);
  }
  // It's a dialog for a screen reader and the keyboard too: what's behind it (the screens, Settings, a feature's page) is
  // out of reach while it shows, as behind the address prompt (askText). Tab went from its last item to the files under
  // the backdrop, and TalkBack could swipe onto the buttons behind it and press them.
  const sheetBehind = new Set();
  function sheetBlock(on, keep) {
    if (on) {
      for (const el of sheetTargets()) {
        if (!keep || !el.contains(keep)) { sheetBehind.add(el); outOfReach(el, 'sheet', true); continue; }
        // (the field kept in reach: everything else around it on the way down goes out of reach instead)
        for (let n = keep; n !== el; n = n.parentElement) {
          for (const x of n.parentElement.children) if (x !== n) { sheetBehind.add(x); outOfReach(x, 'sheet', true); }
        }
      }
    } else {
      for (const el of sheetBehind) outOfReach(el, 'sheet', false);
      sheetBehind.clear();
    }
  }
  function closeSheet() {
    const sh = $('sheet');
    if (sh.hidden) return;
    sh.classList.add('closing');
    sheetOpen = false;
    sheetGen++;
    for (const v of sh.querySelectorAll('video')) v.pause();
    clearTimeout(sheetHideT);
    // (gone: the next waiting sheet, unless the item tapped opened one of its own meanwhile. What's behind comes back in
    // reach then too, once it has slid away, unless the keyboard goes back there now: below)
    sheetHideT = setTimeout(() => { sh.hidden = true; sh.classList.remove('closing'); sheetBlock(false); if (sheetQ.length) openSheet.apply(null, sheetQ.shift()); }, 200);
    // and back where it was opened from (when it took the focus)
    const from = sheetFrom, a = document.activeElement;
    sheetFrom = null;
    // (when the focus is in the menu, or was lost to the start of the page)
    const lost = sheetFocused && (!a || a === document.body || sh.contains(a));
    if (lost) sheetBlock(false);
    if (lost && from && from !== document.body && from.isConnected && typeof from.focus === 'function') {
      try { from.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
    } else if (lost && from && from !== document.body && !from.isConnected && st.screen === 'main' && $('settings').hidden && !document.querySelector('.fpage:not([hidden]), .fpv:not([hidden])')) {
      // (its card went meanwhile: to the files' title, not the start of the page)
      focusScreen('main');
    }
  }
  $('sheet').querySelector('.backdrop').onclick = () => { if (now() - sheetAt > 350) closeSheet(); };
  // (and Tab goes round its items: past the last one it left the page, and the menu's place with it)
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab' || !sheetOpen) return;
    const all = Array.from($('sheetItems').querySelectorAll('button:not([disabled]), input, [tabindex]')).filter((x) => x.offsetParent && x.tabIndex >= 0);
    if (!all.length) return;
    const a = document.activeElement, i = all.indexOf(a);
    if (e.shiftKey ? i <= 0 : (i === -1 || i === all.length - 1)) { e.preventDefault(); all[e.shiftKey ? all.length - 1 : 0].focus(); }
  });
  // A tap begun on a sheet that's sliding away (the second tap of a double tap on an item) goes nowhere. It ran the item
  // that slid under the finger as the panel went down (a file's Select tapped twice sent the file to the PC), or, let
  // go once the sheet was gone, tapped what was under it. (The panel takes no taps then: app.css)
  let sheetEat = 0;
  document.addEventListener('pointerdown', (e) => { const sh = $('sheet'); sheetEat = sh.classList.contains('closing') && sh.contains(e.target) ? now() : 0; }, { capture: true, passive: true });
  document.addEventListener('click', (e) => {
    if (!sheetEat) return;
    const eat = now() - sheetEat < 800;
    sheetEat = 0;
    if (eat) { e.preventDefault(); e.stopPropagation(); }
  }, true);

  // A group of choices (role radiogroup) is one Tab stop, on the one chosen (the first when none is); the arrow keys move
  // in it and choose, as a radio group does. Every choice was its own Tab stop, and the arrows did nothing.
  // rove(el): after a group (or the groups in el) is drawn or its choice changes.
  function rove(el) {
    const groups = el.getAttribute && el.getAttribute('role') === 'radiogroup' ? [el] : el.querySelectorAll('[role=radiogroup]');
    for (const g of groups) {
      const rs = Array.from(g.querySelectorAll('[role=radio]'));
      const on = rs.find((r) => r.getAttribute('aria-checked') === 'true') || rs[0];
      for (const r of rs) r.tabIndex = r === on ? 0 : -1;
    }
  }
  document.addEventListener('keydown', (e) => {
    const r = e.target;
    if (!r || !r.getAttribute || r.getAttribute('role') !== 'radio' || e.altKey || e.ctrlKey || e.metaKey) return;
    const g = r.closest('[role=radiogroup]');
    if (!g) return;
    const rs = Array.from(g.querySelectorAll('[role=radio]')).filter((x) => !x.disabled), i = rs.indexOf(r);
    let j = -1;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') j = (i + 1) % rs.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') j = (i - 1 + rs.length) % rs.length;
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = rs.length - 1;
    if (j < 0 || !rs[j]) return;
    e.preventDefault();
    for (const x of rs) x.tabIndex = x === rs[j] ? 0 : -1;
    rs[j].focus();
    rs[j].click();
  });

  // ------------------------------------------------------------------ formatting
  function fmtSize(n) {
    n = +n || 0;
    if (n < 1024) return n + ' bytes';
    if (n < 1024 * 1024) return Math.max(1, Math.round(n / 1024)) + ' KB';
    if (n < 1024 * 1024 * 1024) return (n / 1048576).toFixed(n < 10 * 1048576 ? 1 : 0) + ' MB';
    return (n / 1073741824).toFixed(1) + ' GB';
  }
  // A card's time or date, by formatters made once (as features/transfers.js does): one made for each card took
  // 0.3-0.5 ms on a phone, and a 3,000-file folder flung past spent 0.6 s in them. Made anew in another language (the
  // page told so, or Flick back in front: languages are changed in Android's settings), so the words stay the same.
  // And in another time zone (Android's settings, travel), or the cards kept the old one's times: the same key as
  // History's and Transfers' (features/core.js X.clockKey, which starts after the first cards may be drawn), looked at
  // once per task, not per card, so a folder flung past doesn't pay for it 3,000 times.
  let whenF = {}, whenSeen = false;
  const WHEN = { t: { hour: 'numeric', minute: '2-digit' }, md: { month: 'short', day: 'numeric' }, mdy: { month: 'short', day: 'numeric', year: 'numeric' } };
  function whenFmt(k) {
    if (!whenSeen) {
      whenSeen = true;
      Promise.resolve().then(() => { whenSeen = false; });
      const n = new Date(), d = String(n), y = n.getFullYear();
      const key = d.slice(d.indexOf('GMT')) + '|' + new Date(y, 0, 1).getTimezoneOffset() + '|' + new Date(y, 6, 1).getTimezoneOffset() + '|' + navigator.language;
      if (whenF.key !== key) whenF = { key };
    }
    return whenF[k] || (whenF[k] = new Intl.DateTimeFormat([], WHEN[k]));
  }
  window.addEventListener('languagechange', () => { whenF = {}; });
  function fmtWhen(ms) {
    const d = new Date(+ms || Date.now());
    if (isNaN(d)) return String(d);                    // (as toLocaleDateString said it; format() throws)
    const today = new Date();
    const sameDay = d.toDateString() === today.toDateString();
    try {
      if (sameDay) return whenFmt('t').format(d);
      return whenFmt(d.getFullYear() === today.getFullYear() ? 'md' : 'mdy').format(d);
    } catch (e) { return d.getHours() + ':' + String(d.getMinutes()).padStart(2, '0'); }
  }
  function fmtDur(ms) {
    const s = Math.round((+ms || 0) / 1000);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0');
  }
  // cut by what shows as one character (an emoji, a letter with its accent), not by UTF-16 unit: an emoji cut in
  // half showed as "�"
  let graph = null;
  function chars(s) {
    if (graph === null) { try { graph = new Intl.Segmenter(undefined, { granularity: 'grapheme' }); } catch (e) { graph = false; } }
    return graph ? Array.from(graph.segment(s), (g) => g.segment) : Array.from(s);
  }
  // at most n UTF-16 units, cut between two characters
  function cutName(s, n) {
    s = String(s || '');
    if (s.length <= n) return s;
    let out = '';
    for (const c of chars(s)) { if (out.length + c.length > n) break; out += c; }
    return out;
  }
  // m: how many characters at most (the grid's cards take fewer as the text grows: see buildCard)
  function midName(n, m) {
    n = String(n || '');
    m = m || 18;
    if (n.length <= m) return n;
    const c = chars(n);
    if (c.length <= m) return n;
    // (cut shorter for larger text, one character stands for the cut, and the end with the extension keeps more)
    const dots = m < 18 ? '…' : '...', head = Math.floor((m - dots.length) / 2) - (m < 18 ? 1 : 0);
    return c.slice(0, head).join('') + dots + c.slice(-(m - dots.length - head)).join('');
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
  const G = { a: Math.random() * 360, speed: 38, hold: 0, active: false, raf: 0, last: 0 };
  function glowLoop(t) {
    const dt = Math.min(50, t - (G.last || t)); G.last = t;
    const h = G.hold;
    G.speed = lerp(38, 420, h);
    if (!calm.matches) G.a = (G.a + G.speed * dt / 1000) % 360;
    const w = lerp(6, 34, easeOut(h)), b = lerp(18, 44, h);
    glow.style.setProperty('--gw', w.toFixed(1) + 'px');
    glow.style.setProperty('--gb', b.toFixed(1) + 'px');
    const tf = 'rotate(' + G.a.toFixed(2) + 'deg)';
    if (tf !== G.tf) { G.tf = tf; spins[0].style.transform = tf; spins[1].style.transform = tf; }
    if (G.active) G.raf = requestAnimationFrame(glowLoop); else G.raf = 0;
  }
  function glowOn(on) {
    glow.classList.toggle('on', on);
    if (on && !G.active) { G.active = true; G.last = 0; G.raf = requestAnimationFrame(glowLoop); }
    if (!on) { setTimeout(() => { if (!glow.classList.contains('on')) G.active = false; }, 600); }
  }

  // ------------------------------------------------------------------ screens
  // Out of reach (Tab, a screen reader) for as long as someone wants it so: kept as the features keep theirs (X.block in
  // features/core.js: who wants it, in data-fblock), so a page that closes doesn't bring back a screen that isn't showing
  function outOfReach(el, who, on) {
    const set = new Set((el.getAttribute('data-fblock') || '').split(' ').filter(Boolean));
    if (on === set.has(who)) return;
    if (on) set.add(who); else set.delete(who);
    if (set.size) { el.setAttribute('data-fblock', Array.from(set).join(' ')); if (!el.inert) el.inert = true; }
    else { el.removeAttribute('data-fblock'); if (el.inert) el.inert = false; }
  }
  // where the keyboard and a screen reader land on a screen: Connect, or the files' title
  function focusScreen(name) {
    const t = name === 'pair' ? $('connect') : $('htitle');
    if (name !== 'pair' && !t.hasAttribute('tabindex')) t.tabIndex = -1;
    try { t.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
  }
  function showScreen(name) {
    const from = st.screen, act = document.activeElement;
    st.screen = name;
    $('pair').classList.toggle('on', name === 'pair');
    $('main').classList.toggle('on', name === 'main');
    // The screen that doesn't show is out of reach (it was only see-through: TalkBack read the Connect screen behind the
    // files, and Tab went into it), and the keyboard or screen reader that was on the one leaving goes along
    outOfReach($('pair'), 'screen', name !== 'pair');
    outOfReach($('main'), 'screen', name !== 'main');
    if (from !== name && act && $(from).contains(act)) focusScreen(name);
    if (from !== name && name === 'pair') foundSaid = new Set();
    glowOn(name === 'pair');
    // the Connect screen: other phones are looked for too (it lists what's nearby), and this phone says it's ready to
    // connect, so a device whose user holds Connect nearby asks this one
    peerScanFor('connect', name === 'pair' && !document.hidden);
    nc('connectReady', name === 'pair');
    // (looking for devices is the Connect screen's: it went on after it was left, then buzzed, could ask for Android's
    // Nearby devices permission or open "Connect to" over the files)
    if (name !== 'pair' && CN.phase === 'looking') { clearInterval(CN.lookT); CN.phase = 'idle'; connectFast(false); G.hold = 0; setPcName(); }
    if (name !== 'pair' && CN.newDev && CN.phase === 'idle') CN.newDev = false;
    nc('discover', !document.hidden);          // also while connected: a faster link (a USB cable) is picked up
    nc('keepAwake', name === 'main' && st.connected);
    if (name === 'main') requestAnimationFrame(() => { measureHeader(); layout(false); });
    renderUpd();
  }

  function flashScreen(cb) {
    if (calm.matches) { if (cb) cb(); return; }
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
  // The Connect screen's three lines: what holding Connect does now. With a paired PC here (and not connected: its
  // connection was turned off, or Connect automatically is), it connects to that PC as always; otherwise it reaches a
  // new device, PC or phone (see Connect below), and the lines say what's nearby.
  function setPcName() {
    const el = $('pcName');
    let a, b, c, searching = false;
    const t = CN.target;
    CN.near = candidates();
    // (as the hint below says it: a computer's Allow is clicked, a phone's tapped)
    if (CN.phase === 'asking' && t) { a = 'Asking'; b = t.name; c = codeCheck() ? 'Check the code.' : (t.kind === 'pc' ? 'Click' : 'Tap') + ' Allow on ' + t.name + '.'; }
    else if (CN.phase === 'looking') { a = 'Looking for'; b = 'devices nearby…'; c = 'Keep Flick open on the other device.'; searching = true; }
    else if (HOME.device) { a = 'Connecting to'; b = HOME.name; c = 'Click Same code on ' + HOME.name + '.'; }   // (allowed here: see homeWait)
    // (the paired PC confirmed once more: once it allowed it, the code is checked here)
    else if (reconnecting()) { a = 'Connect to'; b = st.pc.name; c = st.pairWait && !st.pairOk ? 'Check the code.' : st.awaitingApproval ? 'Click Allow on ' + st.pc.name + '.' : 'Hold Connect.'; }
    else if (!CN.near.length) { a = 'Open Flick on your other device'; b = 'Looking for devices…'; c = 'Then hold Connect here.'; searching = true; }
    else if (CN.near.length === 1) { a = 'Hold Connect to connect to'; b = CN.near[0].name; c = 'Then ' + (CN.near[0].kind === 'pc' ? 'click' : 'tap') + ' Allow on it.'; }
    else { a = 'Hold Connect to connect'; b = CN.near.length + ' devices nearby'; c = 'Then pick yours, and ' + (CN.near.every((x) => x.kind === 'pc') ? 'click' : 'tap') + ' Allow on it.'; }
    $('pairL1').textContent = a;
    el.textContent = b;
    saidFound();
    el.classList.toggle('searching', searching);
    $('pairL3').textContent = c;
    // (holding Connect with a paired PC here connects to it: another device is a tap away)
    // (nor while its code is checked here: Another device took that question away, and its two minutes ran on, to say
    // later that it wasn't confirmed in time)
    $('otherPc').hidden = !reconnecting() || CN.phase !== 'idle' || !!(st.pairWait && !st.pairOk);
    // (off while asking, but not disabled: a disabled button loses the keyboard's focus, which dropped to the start of the
    // page as Enter on Connect started asking)
    const off = CN.phase === 'asking' ? 'true' : 'false', cb = $('connect');
    if (cb.getAttribute('aria-disabled') !== off) cb.setAttribute('aria-disabled', off);
  }

  // A device that turns up while the Connect screen shows is said once to a screen reader ("Desk PC found"): the lines
  // above Connect only changed on screen. Not again on every refresh of the list, nor when it comes and goes; anew the
  // next time the Connect screen is opened.
  function saidFound() {
    if (st.screen !== 'pair' || CN.phase !== 'idle' || document.hidden) return;
    const fresh = CN.near.filter((d) => !foundSaid.has(d.kind + ':' + d.id));
    if (!fresh.length) return;
    for (const d of fresh) foundSaid.add(d.kind + ':' + d.id);
    sayQuietly(fresh.length === 1 ? fresh[0].name + ' found' : fresh.length + ' devices found');
  }
  // the device asked allowed it, and the codes are to be compared here (see showPairCode, onAskPeers)
  function codeCheck() {
    const t = CN.target;
    if (!t) return false;
    if (t.kind === 'pc') return !!(st.pairWait && !st.pairOk);
    const d = ((CN.peers || {}).devices || []).find((x) => x.id === t.id);
    return !!(d && d.busy === 'pairing' && d.allowed && !d.codeOk && !CN.same);
  }

  // The hint is a live region (a screen reader says what it becomes): the same words aren't written again, or it would say
  // them again (the code came again with every change in the state of the phone asked)
  let hintHtml = null, hintLast = null;
  // advice only, that newer advice may replace (nothing found when Connect was held, what Bluetooth needs): see 'ble-perm'
  let hintSoft = null;
  function pairHint(html) {
    html = html || '';
    const el = $('pairHint');
    if (html === hintHtml && el.lastChild === hintLast) return false;  // (unless something was added to it since)
    el.innerHTML = html;
    hintHtml = html; hintLast = el.lastChild;
    return true;
  }
  // "Is this the code it showed?": Same code (the pairing counts) or Different code (it's undone). The keyboard goes to
  // Same code as it shows.
  function askSame(html, same, diff) {
    const fresh = pairHint(html + '<span class="pbtns"><button class="pok ghost" id="pairNo">Different code</button><button class="pok" id="pairOk">Same code</button></span>');
    const ok = $('pairOk'), no = $('pairNo');
    ok.onclick = () => { haptic('tick'); same(); };
    no.onclick = () => { haptic('tick'); diff(); };
    if (fresh && st.screen === 'pair') ok.focus({ preventScroll: true });
  }

  // ---- every PC this phone paired with, and the addresses it was seen at: discovery asks there directly too, so a PC
  // found once (even by typing its address) is found again without it, at home, at work, anywhere
  const KNOWN_KEY = 'knownPcs';
  function knownPcs() { try { const k = JSON.parse(pref.get(KNOWN_KEY, '{}')); return k && typeof k === 'object' ? k : {}; } catch (e) { return {}; } }
  // (pc: as it signed in, at the address it proved itself at; addrs: the others it says it has)
  function rememberPc(pc, addrs) {
    if (!pc || !pc.id || pc.via === 'bluetooth') return;
    const k = knownPcs();
    const e = k[pc.id] || { addrs: [] };
    e.name = pc.name || e.name;
    e.last = Date.now();
    e.at = pc.ip + ':' + pc.port;
    const ips = [pc.ip].concat(addrs || []).filter((a) => /^\d{1,3}(\.\d{1,3}){3}$/.test(String(a || '')));
    e.addrs = ips.concat((e.addrs || []).filter((a) => !ips.includes(a))).slice(0, 8);
    k[pc.id] = e;
    const ids = Object.keys(k).sort((a, b) => (k[b].last || 0) - (k[a].last || 0));
    for (const id of ids.slice(12)) delete k[id];       // the 12 used last
    pref.set(KNOWN_KEY, JSON.stringify(k));
    tellKnown();
  }
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

  // ---- Anything on the network (or another app on this phone) can answer the search in a paired PC's name, and first:
  // an answer proves nothing until the PC shows its pinned certificate there. So a paired PC's link goes to the address
  // it last proved itself at whenever the search lists that one for it too (as fast a link), an address where another
  // certificate answered isn't used for it again for a while, and only the address it proved itself at is kept for it.
  const PIN_BAD_MS = 10 * 60000;
  // where a paired PC last proved itself: {ip, port}, or null
  function verifiedAt(id) {
    const e = knownPcs()[id];
    const at = String((e && e.at) || (pref.get('lastPc', '') === id ? pref.get('lastPcAddr', '') : ''));
    const m = /^(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})$/.exec(at);
    return m ? { ip: m[1], port: +m[2] } : null;
  }
  const pinBadAt = (id, ip, port) => { const t = (st.pinBad || {})[id + '@' + ip + ':' + port]; return !!t && Date.now() - t < PIN_BAD_MS; };
  // a search entry of a pinned PC as its link takes it: at the address it proved itself at when the entry lists that one
  // too, else as it is, or at another of its addresses when that one showed another certificate; when all of them did,
  // at the address it proved itself at (its link keeps looking there, and it stays in the list: it's around), else null
  function leadOf(p) {
    if (!p || !p.id || p.via === 'bluetooth' || !pref.get(pinKey(p.id), '')) return p;
    const v = verifiedAt(p.id), links = Array.isArray(p.links) ? p.links.filter((l) => l && l.ip) : [];
    if (st.repairing === p.id) {                              // (paired again only where repair() went)
      const a = st.repairAt || v;
      return a ? Object.assign({}, p, { ip: a.ip, port: a.port }) : p;
    }
    const portOf = (l) => +l.port || (v && v.ip === l.ip ? v.port : p.port);
    if (v && !(p.ip === v.ip && p.port === v.port)) {
      const l = links.find((x) => x.ip === v.ip && portOf(x) === v.port && rankOf(x) >= rankOf(p));
      if (l) return Object.assign({}, p, { ip: v.ip, port: v.port, via: l.via || p.via });
    }
    if (!pinBadAt(p.id, p.ip, p.port)) return p;
    const alt = links.filter((l) => !pinBadAt(p.id, l.ip, portOf(l))).sort((a, b) => rankOf(b) - rankOf(a))[0];
    if (alt) return Object.assign({}, p, { ip: alt.ip, port: portOf(alt), via: alt.via || p.via });
    return v ? Object.assign({}, p, { ip: v.ip, port: v.port }) : null;
  }
  // files moving now. A send the app carries on with (a job) counts only while it runs or is about to, not while it
  // waits for the PC (that can go on for hours) or is paused: those carry on wherever this page connects.
  function sendMoving(tid, p) {
    if (p.phase !== 'sent' || p.uploaded) return false;
    const j = p.job && st.jobs.get(tid);
    return !j || j.state === 'running' || j.state === 'queued';
  }
  // (files coming from another phone don't count: they don't use the link to the PC)
  const busyMoving = () => [...st.pending].some(([tid, p]) => sendMoving(tid, p)) || (st.incoming && [...st.incoming.keys()].some((f) => !(st.peerIn && st.peerIn.has(f)))) ||
    V.items.some((x) => x.incoming && !x.peer);
  function onPcs() {
    // Bluetooth reports the PC it reached through the same list (a paired PC's entry as its link takes it: see leadOf)
    st.pcs = (st.lanList || []).filter((p) => p && p.ip && p.port).map(leadOf).filter(Boolean).concat(st.btPc ? [st.btPc] : []);
    const pick = (id) => st.pcs.filter((p) => p.id === id).sort((a, b) => rankOf(b) - rankOf(a))[0];
    // PCs this phone is paired with first, then the faster link
    const best = () => st.pcs.slice().sort((a, b) => pairedPc(b) - pairedPc(a) || rankOf(b) - rankOf(a))[0];
    if (!st.pc && st.pcs.length) {
      const last = pref.get('lastPc', '');
      choosePc(pick(last) || best());
    } else if (st.pc) {
      const same = pick(st.pc.id);
      if (same) st.pcSeenAt = now();
      // The PC in use isn't around but another paired one is (home → work): use that one, without anyone typing an
      // address. Only while not connected, and once the PC in use had a moment to answer.
      const other = !same && best();
      if (other && pairedPc(other) && !st.connected && !st.wsOpen && !busyMoving() && !(CN.target && CN.target.kind === 'pc')) {
        const wait = 2500 - Math.min(since(st.pcChosenAt), since(st.pcSeenAt));
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
        // (whether it takes encrypted links is what it says now, said or not: a reply without it kept the old value, so
        // every reply after was a move, and the link was made anew each time; a pinned PC is encrypted to all the same)
        // (its address is kept once it proved itself there: see keepPc)
        st.pc = Object.assign({}, st.pc, same, { tls: +same.tls || 0 });
        // (over the USB cable, its bar says "USB connected. Ready to transfer." instead)
        if (moved && st.connected) { if (same.via !== 'usb' || !USB.cable) toast('Connected over ' + (LINK_NAMES[same.via] || same.via), 2000); openLink(true); }
        else if (moved) openLink(st.wantResume);
      }
    }
    setPcName();
  }

  // keep: it's the PC Flick opens with next time (not one only being asked: see askDevice)
  function choosePc(pc, keep) {
    if (!pc) return;
    // Another PC than the one being asked (picked from the connection button, an address typed in, a PC's own pairing
    // allowed here): that asking is over, its steps with it (it stayed on "Asking", Connect off, and Back canceled it by
    // closing the new PC's link). The paired PC that made way for it isn't brought back: this one is used now.
    // Pairing with the PC in use ends too (its code being checked here, a hold waiting for it to answer): those steps were
    // that PC's, and they held this one back ("Check the code.", its "connected" kept waiting for the other's code), until
    // the other's two minutes closed this one's link with "Not paired with <the other>"
    if (st.pc && st.pc.id !== pc.id) {
      st.pairAsked = false; st.pairOk = false; st.pairWait = null; st.pairConnected = null; st.pairNonce = ''; st.pairCode = '';
      st.awaitingApproval = false; st.connectWanted = 0; st.repairing = ''; st.repairAt = null;
      clearTimeout(connectT); clearTimeout(st.sameT);
    }
    const t = CN.target;
    if (CN.phase === 'asking' && t && t.kind === 'pc' && t.id !== pc.id) {
      CN.back = null;
      connectEnded('pc', t.id);
    }
    st.pcChosenAt = now();
    st.pc = { id: pc.id, name: cleanName(pc.name) || 'PC', ip: pc.ip, port: pc.port, via: pc.via || 'wifi', v: +pc.v || 1, tls: +pc.tls || 0 };
    st.linkBlocked = '';
    if (keep !== false) keepPc();
    st.replaced = false;
    setPcName();
    pairHint('');
    openLink();
  }

  // the PC in use is the one Flick opens with next time. proven: it just signed in at its address (proved it holds this
  // phone's pairing there), which is kept for it then only: the background link, tiles, widget and auto-send go there,
  // and an answer to the search in its name from anywhere else proves nothing
  function keepPc(proven) {
    const pc = st.pc;
    if (!pc) return;
    pref.set('lastPc', pc.id);
    if (proven && pc.via !== 'bluetooth') { pref.set('lastPcAddr', pc.ip + ':' + pc.port); pref.set('lastPcTls', pc.tls ? '1' : '0'); }
    pref.set('lastPcName', pc.name);
  }
  const keptPc = () => !!st.pc && pref.get('lastPc', '') === st.pc.id;

  $('otherPc').onclick = () => { haptic('soft'); CN.newDev = true; pairHint(''); setPcName(); };
  $('skipBtn').onclick = () => { showScreen('main'); };

  // a small prompt with one text field: the PC address here, the phone's name in Settings. What one shown is still doing
  // (looking for a PC at its address) ends with it (askGen): closed with Cancel or Back, a PC that answered late was
  // switched to all the same, off the PC in use, and closed whatever prompt was showing by then
  let askDone = null, askGen = 0, askBusy = false;
  // For a screen reader and the keyboard it's a dialog: what's behind is out of reach while it shows, and they go back
  // where they were once it's closed (they wandered behind it, and Cancel left them at the start of the page); in
  // Settings, drawn again meanwhile (a new phone name), to the same place in it
  let askFrom = null, askPlace = null;
  const askBehind = () => [$('pair'), $('main'), $('settings')];
  function askText(o) {
    askGen++; askBusy = false;
    if ($('ask').hidden) { askFrom = document.activeElement; askPlace = setPlace(); }
    $('askTitle').textContent = o.title; $('askSub').textContent = o.sub || '';
    const inp = $('askInput');
    inp.value = o.value || ''; inp.placeholder = o.placeholder || '';
    inp.setAttribute('inputmode', o.mode || 'text');
    if (o.max) inp.maxLength = o.max; else inp.removeAttribute('maxlength');   // (the field stops where the name would be cut)
    $('askOk').textContent = o.ok || 'OK';
    askDone = o.done;
    $('ask').hidden = false;
    for (const el of askBehind()) outOfReach(el, 'ask', true);
    setTimeout(() => { inp.focus(); inp.select(); }, 50);
  }
  $('manualBtn').onclick = () => askText({
    // (with its port when the PC shows one: Flick takes another when 47860 is in use. A keypad for numbers has no ':')
    title: 'Enter PC address', sub: 'Shown on your PC in the Flick window, e.g. 192.168.1.23 or 192.168.1.23:47861', value: pref.get('manual', ''),
    placeholder: '192.168.1.23', ok: 'Connect', mode: 'url', done: connectManual,
  });
  function askClose() {
    askGen++; askBusy = false;
    if ($('ask').hidden) return;
    const had = $('ask').contains(document.activeElement), f = askFrom, pl = askPlace;
    askFrom = null; askPlace = null;
    $('ask').hidden = true;
    for (const el of askBehind()) outOfReach(el, 'ask', false);
    if (!had) return;
    if (f && f.isConnected && !f.closest('[inert]') && typeof f.focus === 'function') { try { f.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }
    else if (pl && !$('settings').hidden) setPlaceBack(pl);
  }
  $('askCancel').onclick = askClose;
  $('ask').querySelector('.backdrop').onclick = askClose;
  $('askOk').onclick = async () => {
    // (one go at a time: a second tap while connecting looked for the PC again, and switched to it twice)
    if (askBusy || !askDone) return;
    const gen = askGen, live = () => gen === askGen;
    askBusy = true;
    let ok = false;
    try { ok = await askDone($('askInput').value, live); } finally { if (live()) askBusy = false; }
    if (ok && live()) askClose();
  };
  // the keyboard's Enter (Go, Done) does what the button does: it did nothing, the keyboard stayed up
  $('askInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('askOk').click(); } });
  // live: the prompt it was asked from is still the one showing (see askGen)
  async function connectManual(rawIn, live) {
    live = live || (() => true);
    const raw = String(rawIn || '').trim();
    if (!raw) return false;
    pref.set('manual', raw);
    const m = /^([\w.-]+)(?::(\d{1,5}))?$/.exec(raw);
    if (!m || (m[2] && !(+m[2] >= 1 && +m[2] <= 65535))) { toast('That address doesn’t look right'); return false; }
    const ip = m[1], port = +(m[2] || 47860);
    const say = (t) => { if (live()) $('askOk').textContent = t; };
    say('Connecting…');
    try {
      // asked over an encrypted link like everything else (the phone sends nothing over the network in the clear);
      // which certificate to trust is settled when it connects, once the PC's id is known
      const lk = await nreqT(8000, 'tlsOpen', ip, port, '');
      if (!live()) return false;                     // (Cancel or Back meanwhile: the PC in use stays)
      if (!lk || !lk.ok) {
        if (lk && lk.why === 'tls') { toast('Flick on the PC at ' + ip + ' needs updating first', 3200); say('Connect'); return false; }
        throw new Error('unreachable');
      }
      const ctl = new AbortController();
      const to = setTimeout(() => ctl.abort(), 3500);
      const r = await fetch((lk.base || 'http://127.0.0.1:' + lk.port) + '/api/hello', { signal: ctl.signal });
      const j = await r.json();
      clearTimeout(to);
      if (!live()) return false;
      if (!j || j.app !== 'flick') throw new Error('not flick');
      say('Connect');
      const pc = { id: j.id, name: cleanName(j.name) || ip, ip, port: j.port || port, v: +j.v || 4, tls: 1 };
      if (!st.pcs.find((p) => p.id === pc.id)) st.pcs.push(pc);
      closeLink();
      choosePc(pc);
      return true;
    } catch (e) {
      if (live()) toast('Couldn’t reach a PC at ' + ip, 2800);
    }
    say('Connect');
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
    linkEnded(false);
  }

  // The way to the PC. Over Bluetooth: the local port the app's Bluetooth link gives (Bluetooth encrypts that link
  // itself). Otherwise: an encrypted link (TLS) through a local port the app opens, which only reaches a PC whose
  // certificate is the one this phone pinned. A PC that can't do encrypted links isn't used. Either port passes on only
  // requests that carry its key, which the app gives with it (base): other apps on the phone can reach the port too.
  async function prepareLink(pc, gen) {
    if (pc.via === 'bluetooth') {
      if ((+pc.v || 1) < 4) { linkProblem('old'); return null; }
      const base = nc('relayBase', +pc.port);
      return { ip: pc.ip, port: pc.port, base: typeof base === 'string' ? base : '', chan: 'bluetooth', key: 'bt:' + pc.port };
    }
    // (pairing again with it: without the certificate pinned before, which stays until the new pairing is confirmed)
    const again = st.repairing === pc.id;
    const pin = again ? '' : pref.get(pinKey(pc.id), '');
    // a PC this phone pinned is known to encrypt, whatever a discovery reply (which anyone can send) says
    if (!pc.tls && !pin && !again) { linkProblem('old'); return null; }
    const r = await nreqT(20000, 'tlsOpen', pc.ip, pc.port, pin);
    if (!r) return null;
    if (!r.ok && r.why === 'pin' && pin) return pinnedElsewhere(pc, pin, gen);
    if (!r.ok) { if (r.why === 'pin') linkProblem('pin'); else if (r.why === 'tls') linkProblem('old'); return null; }
    return linkTo(r, pc, pin);
  }
  const linkTo = (r, at, pin) => ({ ip: '127.0.0.1', port: r.port, base: r.base || '', chan: r.fp, fp: r.fp, pinned: !!pin, key: at.ip + ':' + at.port });
  // pc's certificate isn't the pinned one at its address: something else may answer there in its name. Its link tries
  // where it last proved itself, then its other addresses, before the user hears it has a new key: said only when the
  // address it proved itself at shows another certificate too (or there's none to go by) and pc isn't found anywhere
  // else (see movedOn), or doesn't answer at all (see below). The link found, or null. gen: the link being made.
  async function pinnedElsewhere(pc, pin, gen) {
    const v = verifiedAt(pc.id), atV = (a) => !!v && a.ip === v.ip && a.port === v.port;
    st.pinBad = st.pinBad || {};
    if (st.newKeyAt && st.newKeyAt.id === pc.id) st.newKeyAt = null;
    if (!atV(pc)) st.pinBad[pc.id + '@' + pc.ip + ':' + pc.port] = Date.now();
    const tries = [];
    const add = (ip, port, via) => { if (ip && port && !(ip === pc.ip && port === pc.port) && !tries.some((t) => t.ip === ip && t.port === port)) tries.push({ ip, port, via }); };
    if (v) add(v.ip, v.port, '');
    const seen = (st.lanList || []).find((p) => p && p.id === pc.id);
    for (const l of (seen && Array.isArray(seen.links) ? seen.links : [])) if (l && l.ip) add(l.ip, +l.port || (v && v.ip === l.ip ? v.port : pc.port), l.via);
    const k = knownPcs()[pc.id];
    for (const ip of (k && k.addrs) || []) add(ip, v ? v.port : pc.port, '');
    let newKey = !v || atV(pc), vSilent = false;
    for (const t of tries.slice(0, 4)) {
      if (pinBadAt(pc.id, t.ip, t.port)) continue;
      const r = await nreqT(12000, 'tlsOpen', t.ip, t.port, pin);
      if (r && r.ok) {
        if (st.pc && st.pc.id === pc.id) st.pc = Object.assign({}, st.pc, { ip: t.ip, port: t.port }, t.via ? { via: t.via } : {});
        return linkTo(r, t, pin);
      }
      if (r && r.why === 'pin') {
        if (atV(t)) newKey = true;
        else st.pinBad[pc.id + '@' + t.ip + ':' + t.port] = Date.now();
      } else if (atV(t)) vSilent = true;
    }
    if (newKey && v) return movedOn(pc, v, pin, gen);
    // Nothing answers where it proved itself, and where it answers it shows another certificate: Flick reinstalled there
    // on a computer that has another address now (from the router, or a cable instead of Wi-Fi), or something else
    // answering in its name while it's away. From here the two look the same, so the user hears it has a new key, as
    // when it shows one where it proved itself; pairing again goes to where it answers (repair), and nothing of this
    // pairing changes unless the user sees the same code on that PC (Same code).
    const moved = !newKey && vSilent;
    if (moved) st.newKeyAt = { id: pc.id, ip: pc.ip, port: pc.port };
    if (newKey || moved) linkProblem('pin');
    // (it's looked for where it proved itself, not where the other certificate answered)
    if (!newKey && v && st.pc && st.pc.id === pc.id) st.pc = Object.assign({}, st.pc, { ip: v.ip, port: v.port });
    return null;
  }
  // Another certificate where pc proved itself can be another program's: Flick takes the next port free when its own is
  // taken (another user's Flick on that computer, say), and says which in its answers to the search. The phone said "new
  // security key" and went to the Connect screen, then connected there a moment later. So first the search's answer (up
  // to 3 s for one, when it hasn't listed pc yet: one listing pc elsewhere starts another link there), then those ports
  // with pc's own certificate, and only then is the user told. Listed only where the other certificate answered, the
  // ports are tried all the same: the search keeps an answer 7 s, so a Flick started again on another port was still
  // listed at its old one, and the user was told of a new key. The link there, or null.
  async function movedOn(pc, v, pin, gen) {
    const live = () => gen === wsGen, entries = () => (st.lanList || []).filter((p) => p && p.id === pc.id);
    const away = (ip, port) => ip && !(ip === v.ip && port === v.port) && !pinBadAt(pc.id, ip, port);
    const elsewhere = () => entries().some((p) => away(p.ip, +p.port) || (Array.isArray(p.links) ? p.links : []).some((l) => l && away(l.ip, +l.port || +p.port)));
    for (let i = 0; i < 20 && live() && !entries().length; i++) await new Promise((r) => { setTimeout(r, 150); });
    if (!live()) return null;
    // (listed elsewhere: tried there, its links or here; else Flick's ports: 47860, or the first free of the next five)
    const lo = v.port >= 47860 && v.port <= 47865 ? 47860 : v.port + 1, hi = lo === 47860 ? 47865 : v.port + 5;
    for (let port = lo; port <= hi && !elsewhere(); port++) {
      if (port === v.port || pinBadAt(pc.id, v.ip, port)) continue;
      const r = await nreqT(12000, 'tlsOpen', v.ip, port, pin);
      if (!live()) { if (r && r.ok) nc('tlsClose', r.port); return null; }
      if (r && r.ok) {
        if (st.pc && st.pc.id === pc.id) st.pc = Object.assign({}, st.pc, { ip: v.ip, port });
        return linkTo(r, { ip: v.ip, port }, pin);
      }
      if (!r || (r.why !== 'pin' && r.why !== 'tls')) break;     // (nothing there: Flick takes the first one free)
      st.pinBad[pc.id + '@' + v.ip + ':' + port] = Date.now();
    }
    if (live()) linkProblem('pin');
    return null;
  }
  // where HTTP requests to the connected PC go (the encrypted link's local port, or the Bluetooth one)
  const linkBase = () => (st.link ? st.link.base || 'http://' + st.link.ip + ':' + st.link.port : 'http://0.0.0.0:0');

  // Why this phone can't connect to st.pc right now: said where the user is looking. Retrying slows down meanwhile.
  function linkProblem(kind) {
    st.linkBlocked = kind;
    const name = nameHtml(st.pc && st.pc.name, 'your PC');
    let msg = '';
    if (kind === 'old') msg = 'Flick on ' + name + ' needs updating before this phone can connect. Flick updates itself on the PC; restarting it there updates it now.';
    else if (kind === 'pin') msg = name + ' has a new security key, so this phone won’t connect to it. If you reinstalled Flick on that PC, <a href="#" id="repairBtn">pair again</a>.';
    else if (kind === 'auth') msg = 'This phone couldn’t verify ' + name + '. Hold Connect to pair again, and check that both screens show the same code.';
    // a PC being asked as a new device: that asking is over (Connect could never be held again)
    const ask = CN.target;
    if (CN.phase === 'asking' && ask && ask.kind === 'pc' && st.pc && ask.id === st.pc.id) {
      connectEnded('pc', ask.id);
      CN.failAt = now();
      G.hold = 0;
      pairHint(msg.replace(/ If you reinstalled.*$/, ''));          // (never paired: nothing to pair again)
      return;
    }
    if (st.screen === 'pair') {
      pairHint(msg);
      const b = $('repairBtn');
      if (b) b.onclick = (e) => { e.preventDefault(); repair(); };
    } else if (st.problemShown !== kind) {
      st.problemShown = kind;
      // as text: the tags left out and the name as it is (stripping the tags left "Alex&#39;s PC", the PC's default
      // name escaped)
      const t = document.createElement('template');
      t.innerHTML = msg;
      toast(t.content.textContent.replace(/ If you reinstalled.*$/, ''), 4200);
      // (tried again every 20 s, as when it's said on the Connect screen: closing the link ended the retries)
      if (kind !== 'old') { closeLink(); showScreen('pair'); linkProblem(kind); scheduleReconnect(20000); }
    }
  }
  // The PC in use no longer has this phone paired (its user removed it there, or it lost its settings): said where the
  // user is looking, and the Connect screen shows, where holding Connect pairs again. It was dropped without a word:
  // the files stayed, still naming that PC, and sending there only said "Not connected to your PC".
  function pcForgot() {
    const nm = st.pc ? st.pc.name : '', say = ' doesn’t have this phone paired any more. Hold Connect to pair again.';
    st.wantResume = false;
    clearTimeout(st.bootT);
    CN.newDev = false;
    CN.failAt = now();                            // (said for a while: the next sign-in doesn't take it away)
    if (st.screen !== 'pair') { toast((nm || 'Your PC') + say, 4200); showScreen('pair'); }
    pairHint(nameHtml(nm, 'Your PC') + say);
    setPcName();
    updateConn();
  }
  // Pair again with this PC (its certificate changed where it proved itself before: it was reinstalled). Its link goes
  // there without the pinned certificate and Connect pairs anew, with the code on both screens; the pairing this phone
  // has (its token and pin) stays until the new one is confirmed (Same code), so nothing is lost to whatever answered
  // in its name. Never to an address where it never proved itself, when there's one where it did that answers (where
  // nothing answers there, to where it answered with its new key: see pinnedElsewhere).
  function repair() {
    if (!st.pc) return;
    const v = verifiedAt(st.pc.id), moved = st.newKeyAt && st.newKeyAt.id === st.pc.id ? st.newKeyAt : null;
    const at = moved || v;
    if (at && (at.ip !== st.pc.ip || at.port !== st.pc.port)) st.pc = Object.assign({}, st.pc, { ip: at.ip, port: at.port });
    st.repairAt = at ? { ip: at.ip, port: at.port } : null;
    st.repairing = st.pc.id;
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
    // A live session moves to a new link (a faster one, or the phone's new name): not connected until the PC says so
    // again, so nothing is sent into the gap (a drop sent there was lost, and the PC threw the file away), and every
    // try asks the PC to pick the session back up (else a retry left the phone "connected" and the PC not).
    if (st.connected) {
      st.connected = false; st.wantResume = true; st.relinkAt = now();
      updateConn();
      linkEnded(true);
    }
    prepareLink(st.pc, gen).then((lk) => {
      if (gen !== wsGen) return;
      if (!lk) { st.connecting = false; scheduleReconnect(st.linkBlocked ? 20000 : 0); return; }
      // (a PC that couldn't be verified is reached all the same: said again only once it has signed in, see 'auth?'.
      // Its link is tried every 20 s, and each try said it again and brought the Connect screen back over the files)
      if (st.linkBlocked !== 'auth') st.problemShown = '';
      st.linkBlocked = '';
      // an encrypted link to an address the phone no longer uses is closed, unless files are still moving over it
      const old = st.link;
      if (old && old.key !== lk.key && old.chan !== 'bluetooth' && !busyMoving()) nc('tlsClose', old.port);
      st.link = lk;
      connectWs(gen, resume);
    });
  }

  function connectWs(gen, resume) {
    let ws;
    try { ws = new WebSocket(linkBase().replace(/^http:/, 'ws:') + '/ws'); } catch (e) { st.connecting = false; scheduleReconnect(); return; }
    st.ws = ws;
    ws.onopen = () => {
      if (gen !== wsGen) return;
      st.wsOpen = true; st.connecting = false; st.lastRx = now();
      // protocol 4: no token in hello. A paired PC answers with proof that it holds this phone's token ('auth?').
      st.nonceP = rhex(16); st.pcProved = false;
      ws.send(JSON.stringify({ t: 'hello', v: 4, device: DEVICE, name: phoneName(), nonce: st.nonceP, w: innerWidth, h: innerHeight, dpr: devicePixelRatio, resume: !!resume, app: MY_CODE, appName: INFO.version || '', via: st.pc.via || 'wifi', sdk: INFO.sdk || 0 }));
      clearInterval(pingT);
      pingT = setInterval(() => {
        if (gen !== wsGen) return;
        // a link that went silent (PC asleep, laptop changed network) can take many minutes to report closing by itself:
        // the PC answers every ping, so 25 s of nothing means it's gone — give up on this socket and reconnect
        if (since(st.lastRx) > 25000) { wsGen++; try { ws.close(); } catch (x) { /* ignore */ } linkLost(); return; }
        wsSend({ t: 'ping', ts: Date.now() });
      }, 10000);
    };
    ws.onmessage = (e) => { if (gen !== wsGen) return; st.lastRx = now(); let m; try { m = JSON.parse(e.data); } catch (x) { return; } onMsg(m); };
    ws.onclose = () => { if (gen !== wsGen) return; linkLost(); };
    ws.onerror = () => { /* onclose follows */ };
  }

  // Flick back in front: a link that went quiet meanwhile (the PC asleep, another network) is found out at once. It
  // showed "connected" until the pings noticed (up to half a minute), and a file flicked then went nowhere.
  function checkLink() {
    const gen = wsGen, at = now();
    if (!wsSend({ t: 'ping', ts: Date.now() })) return;
    setTimeout(() => {
      if (gen !== wsGen || !st.wsOpen || (st.lastRx || 0) >= at) return;
      wsGen++;
      try { st.ws.close(); } catch (x) { /* ignore */ }
      linkLost();
    }, 4000);
  }

  function linkLost() {
    const was = st.connected;
    st.wsOpen = false; st.connected = false; st.connecting = false; st.pcProved = false;
    // (before the connection button is drawn again: while it reconnects, flicks still go to this PC)
    if (was && !st.replaced) st.wantResume = true;
    clearInterval(pingT);
    updateConn();
    linkEnded(false);
    st.pairAsked = false; st.awaitingApproval = false;
    // a pairing the PC already allowed can still be confirmed here (see 'paired'); one it hadn't is over
    if (!st.pairWait) st.pairOk = false;
    // another phone took over this PC: wait for the user rather than fighting over it
    if (st.replaced) { st.wantResume = false; return; }
    if (was) { st.wantResume = true; if (!document.hidden) toast('Reconnecting to ' + st.pc.name + '…', 1800); }
    scheduleReconnect();
    // The PC being asked went (it quit, its Wi-Fi changed): its question went with the link, so the asking is over and its
    // code isn't shown as if it still were (once paired already, it connects when it's back)
    const t = CN.target;
    if (CN.phase === 'asking' && t && t.kind === 'pc' && st.pc && t.id === st.pc.id && !st.pairWait) {   // (allowed there: Same code still counts)
      const nm = st.pc.name, paired = hasToken();
      connectEnded('pc', t.id);
      if (paired) pairHint(''); else askFailed('Lost the connection to ' + nameHtml(nm, 'the PC') + '.', true);
    }
  }

  // What a link that ended (lost, closed here, or replaced by a new one: relink) leaves behind. A send still being
  // dragged or held goes nowhere now (after a relink the session comes back, and the drag with it). One the PC has
  // every byte of is settled: its 'saved' can't arrive now. One still on its way carries on in the app and settles
  // by its up-done, as its 'saved' may be lost meanwhile. The PC's hover glow goes out.
  function linkEnded(relink) {
    for (const [tid, p] of st.pending) {
      if (p.phase === 'lifted') {
        if (relink) continue;
        st.pending.delete(tid);
        if (p.job) nc('sendCancel', tid); else nc('abort', tid);
        // the card still under the finger isn't being sent any more: let go over the PC once connected again, it goes
        // as a new send (the old one's id is canceled on the PC)
        if (D && D.tid === tid && D.phase === 'drag') { D.sending = false; D.tid = rid(); } else unlift(itemsOf(p));
      } else if (p.phase === 'sent') {
        p.relinked = true;
        if (p.uploaded) { if (relink) settleSoon(tid, p); else settleSent(tid, p); }
      }
    }
    edgeOff();
  }

  let lostSince = 0;
  function scheduleReconnect(ms) {
    clearTimeout(reconnectT);
    if (!lostSince) lostSince = now();
    if (st.wantResume && !st.linkBlocked && now() - lostSince > 12000 && st.screen === 'main' && !st.lostToast) {
      st.lostToast = true;
      toast('Lost connection to your PC. Flick will reconnect when it’s back.', 2800);
    }
    reconnectT = setTimeout(() => openLink(st.wantResume), ms || (document.hidden ? 4000 : (st.connectWanted ? 500 : 1200)));
  }

  function updateConn() {
    $('cdot').classList.toggle('on', st.connected);
    renderTarget();
    usbRender();
    nc('keepAwake', st.screen === 'main' && st.connected);
    if (SEL.on) renderSelection();
    // Settings open: its PC row ("Connected over Wi-Fi", Disconnect or Connect) and the speed test follow
    const sp = $('settings');
    if (!sp.hidden && !sp.classList.contains('closing')) renderSettings();
    runHooks('conn');                        // the features (phone/features/*.js)
  }

  // "connect" on the user's go-ahead. Not paired yet (protocol 4): it also commits to this phone's half of the pairing
  // code (a hash of a random number, revealed only once the PC has answered with its half: see 'pairing'), so nobody
  // in between can steer the code the two screens show.
  // The PC is told up front when the codes will be compared here (confirm): it keeps the pairing only once Same code
  // is tapped ('pair-done'), and drops it otherwise. Not over a USB cable, where there's nothing to compare (see
  // showPairCode); older PCs take no notice.
  function sendConnectUser() {
    if (st.trusted) return wsSend({ t: 'connect', user: true });
    st.pairNonce = rhex(16); st.pairCode = '';
    st.pairCheck = !(st.pc && st.pc.via === 'usb');
    return wsSend(Object.assign({ t: 'connect', user: true, commit: nc('sha256', st.pairNonce) || '' }, st.pairCheck ? { confirm: 1 } : {}));
  }

  // The hold finished: connect now, or as soon as the link to the PC is up (never fail just because it's still linking).
  function requestConnect() {
    st.replaced = false; st.pairAsked = true; st.noAuto = false;
    if (st.wsOpen && sendConnectUser()) return;
    st.connectWanted = now();
    pairHint('Connecting to ' + nameHtml(st.pc && st.pc.name, 'your PC') + '…');
    G.hold = Math.max(G.hold, 0.5);
    if (!st.connecting) openLink();
    clearTimeout(connectT);
    connectT = setTimeout(() => {
      if (!st.connectWanted) return;
      st.connectWanted = 0;
      G.hold = 0;
      haptic('reject');
      // (a PC this phone hears on the network but can't reach: most often its firewall, which its Flick can fix)
      const heard = !!(st.pc && (st.lanList || []).some((p) => p && p.id === st.pc.id));
      const msg = 'Can’t reach ' + nameHtml(st.pc && st.pc.name, 'your PC') + (st.pc ? ' at ' + esc(st.pc.ip) : '') + '. Make sure Flick is open on the PC and both are on the same Wi-Fi' +
        (heard ? esc(', or on the PC click “Phone can\'t connect? Fix it”') : '');
      // (a PC asked as a new device: that asking is over, Connect can be held again)
      if (connectEnded('pc', st.pc && st.pc.id)) askFailed(msg + '.', true);
      else pairHint(msg + ', then try again.');
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
    pairHint('Confirm this phone with ' + nameHtml(st.pc && st.pc.name, 'your PC') + ' once: hold <b>Connect</b>, then check that both screens show the same code.');
  }

  // The pairing code, shown here while the PC asks its user: it shows the same one. Once its user allows it there, the
  // pairing counts when the user here says the codes match too (Same code): a stranger's device that answered the hold
  // first could be allowed by its own user, but it can't make the user's PC show this code. Over a USB cable (the PC on
  // the phone's cable is the one asked) there's nothing to check.
  function showPairCode() {
    const name = nameHtml(st.pc && st.pc.name, 'your PC');
    const code = '<b class="pcode">' + esc(st.pairCode.slice(0, 3) + ' ' + st.pairCode.slice(3)) + '</b>';
    if (st.pairWait && !st.pairOk) {
      askSame(name + ' allowed it. Is this the code it showed?<br>' + code, () => { st.pairOk = true; finishPairing(); }, () => pairUndo(name, 'the codes didn’t match'));
      return;
    }
    pairHint(code + '<br>Click <b>Allow</b> on ' + name + '. It shows the same code.<br><a href="#" id="pairStop">Cancel</a>');
    const b = $('pairStop');
    if (b) b.onclick = (e) => { e.preventDefault(); connectCancel(); };
  }
  // A pairing the PC allowed that the user here didn't confirm (Different code, or no answer in time): this phone keeps
  // nothing of it, and its link goes (the PC asked again needs a new one, with a new code)
  function pairUndo(name, why) {
    clearTimeout(st.sameT);
    st.repairing = ''; st.repairAt = null;                       // (the pairing it had stays as it was)
    st.pairWait = null; st.pairConnected = null; st.pairAsked = false; st.pairOk = false; st.pairNonce = ''; st.pairCode = '';
    st.awaitingApproval = false; st.connectWanted = 0;
    clearTimeout(connectT);
    closeLink();
    connectEnded('pc', st.pc && st.pc.id);                       // (a new device: the paired PC comes back)
    setPcName();
    askFailed('Not paired with ' + name + ': ' + why + '.', true);
  }

  function finishPairing() {
    const w = st.pairWait;
    clearTimeout(st.sameT);
    if (!w || !st.pc || w.pc !== st.pc.id) { st.pairWait = null; return; }
    st.pairWait = null;
    pref.set(tokenKey(st.pc.id), w.token);
    if (HOME.device === st.pc.id) homeWait(null);      // (its own request, allowed here, is no longer waited for)
    // the certificate of the PC the user just approved is the one this phone trusts from now on (a pairing again
    // replaces the one before only now)
    if (w.fp) pref.set(pinKey(st.pc.id), w.fp);
    else if (st.repairing === st.pc.id) pref.set(pinKey(st.pc.id), '');
    // (an address where another certificate answered may be its own now: the one just confirmed)
    if (st.pinBad) for (const k of Object.keys(st.pinBad)) if (k.startsWith(st.pc.id + '@')) delete st.pinBad[k];
    if (st.newKeyAt && st.newKeyAt.id === st.pc.id) st.newKeyAt = null;
    st.repairing = ''; st.repairAt = null;
    st.pairAsked = false; st.pairNonce = ''; st.pairCode = ''; st.pairOk = false;
    setPcName();
    const held = st.pairConnected; st.pairConnected = null;
    if (w.gen !== wsGen || !st.wsOpen) { st.awaitingApproval = false; pairHint(''); openLink(); return; }   // signs in afresh
    if (st.link && w.fp && st.link.fp === w.fp) st.link.pinned = true;
    st.pcProved = true; st.problemShown = '';
    st.trusted = true;
    // (the codes matched here too: a PC that keeps a pairing only once its other side says so, as for its other devices,
    // keeps it; older ones take no notice)
    wsSend({ t: 'pair-done' });
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
        st.pcProved = true; st.problemShown = '';
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
        if (m.pc && cleanName(m.pc.name) && st.pc) { st.pc.name = cleanName(m.pc.name); if (keptPc()) pref.set('lastPcName', st.pc.name); setPcName(); }
        // the PC doesn't know this phone (any more): its pairing is over. Believed only from a PC this phone can be
        // sure of (pinned certificate, or Bluetooth), so a stranger can't make it throw a pairing away. Said, unless
        // Connect is being held for it right now (that pairs again)
        if (!m.trusted && (st.link.pinned || st.link.chan === 'bluetooth') && m.why !== 'auth' && m.why !== 'confirm' && !st.pcProved && hasToken()) {
          pref.set(tokenKey(st.pc.id), '');
          if (!(st.connectWanted && since(st.connectWanted) < 10000)) { pcForgot(); break; }
        }
        if (st.connectWanted && since(st.connectWanted) < 10000) { st.connectWanted = 0; st.pairAsked = true; clearTimeout(connectT); sendConnectUser(); }
        else if (st.wantResume && st.trusted && !st.connected && !st.replaced) wsSend({ t: 'connect' });   // pick the session back up
        // a PC this phone is paired with: connected without holding Connect (Settings › Connect automatically), unless
        // the user disconnected or another phone took this PC over
        else if (settings.autoConnect !== false && st.trusted && hasToken() && !st.connected && !st.replaced && !st.noAuto) wsSend({ t: 'connect' });
        // paired without the code (a token but no pinned certificate): confirm once, whatever this PC claims
        else if (!st.trusted && (m.why === 'confirm' || (hasToken() && st.link.chan !== 'bluetooth' && !st.link.pinned))) needConfirm();
        // (what an asking that just ended said stays: the paired PC coming back signs in right after it)
        else if (st.screen === 'pair' && !st.linkBlocked && !st.pairWait && since(CN.failAt) > 10000) pairHint('');
        break;
      case 'pairing': {
        if (!st.pairAsked || !st.pairNonce) break;  // only after this phone asked to connect
        const nS = String(m.nonce || '');
        if (!/^[0-9a-f]{32,64}$/.test(nS)) break;   // a PC that can't show a pairing code isn't paired with
        // the PC's half of the code is here: now this phone reveals its own, and both screens show the same code
        wsSend({ t: 'pair-reveal', nonce: st.pairNonce });
        st.pairCode = nc('pairCode', st.link.chan, st.pairNonce, nS) || '';
        // (the user checks the code once the PC's user allowed it, as the PC was told when this phone asked, unless it's
        // the PC on the phone's USB cable: see showPairCode)
        st.pairOk = st.pairCheck === false; st.pairWait = null; st.pairConnected = null;
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
        if (st.pairOk) { finishPairing(); break; }
        bringPair(st.pc.name);
        showPairCode();
        setPcName();
        // (no answer in two minutes: undone)
        const w = st.pairWait, nm = nameHtml(st.pc.name, 'your PC');
        clearTimeout(st.sameT);
        st.sameT = setTimeout(() => { if (st.pairWait === w && !st.pairOk) pairUndo(nm, 'the code wasn’t confirmed in time'); }, 120000);
        break;
      }
      case 'denied': {
        st.pairAsked = false; st.pairOk = false; st.pairWait = null;
        st.awaitingApproval = false;
        const nm = st.pc && st.pc.name;                          // (the PC asked: see connectEnded)
        connectEnded('pc', st.pc && st.pc.id);
        // why 'wait': asked again right after Don't allow, or too often in a minute; s: the seconds until it may be asked
        const s = m.why === 'wait' ? Math.ceil(+m.s) : 0;
        if (s >= 1 && s <= 3600) askFailed(nameHtml(nm, 'The PC') + ' was asked a moment ago. Try again in ' + s + ' s.');
        else askFailed(nameHtml(nm, 'The PC') + ' didn’t allow it, or is busy with another request.', true);
        break;
      }
      case 'connected':
        if (st.pairWait) { st.pairConnected = m; break; }   // allowed on the PC, not yet confirmed here (finishPairing)
        if (!hasToken() || !st.pcProved) break;
        lostSince = 0; st.lostToast = false;
        st.connected = true; st.trusted = true; st.awaitingApproval = false; st.connectWanted = 0;
        clearTimeout(connectT); clearTimeout(st.bootT);
        // sends that wait for this PC (cut off earlier, or from before Flick was closed) carry on where it is now
        if (st.pc && st.pc.ip && st.pc.port) nc('sendRelink', st.pc.id, st.pc.ip, st.pc.port, st.pc.via || 'wifi');
        // found here: next time too, even where discovery can't see it (every address the PC has)
        rememberPc(st.pc, m.pc && Array.isArray(m.pc.addrs) ? m.pc.addrs : []);
        if (m.side) st.side = m.side;
        if (m.theme) applyTheme(m.theme);
        if (m.pc && cleanName(m.pc.name)) st.pc.name = cleanName(m.pc.name);
        keepPc(true);                           // (a PC asked as a new device is remembered from now on; at this address)
        updateConn();
        UPD.pcKnows = 'app' in m;               // a PC that doesn't say can't hand out phone updates
        onAppInfo(m.app);
        connectEnded('pc', st.pc && st.pc.id);
        if (st.screen === 'pair') {
          const go = () => {
            haptic('confirm');
            G.hold = 1;
            pairHint('');
            flashScreen(() => { showScreen('main'); G.hold = 0; staggerIn(); });
          };
          // (the paired PC back after another device wasn't paired: why it wasn't stays on screen a moment first)
          const wait = 2500 - since(CN.failAt);
          if (wait > 0) setTimeout(() => { if (st.connected && st.screen === 'pair' && CN.phase === 'idle' && !CN.newDev) go(); }, wait);
          else go();
        } else if (st.wantResume && since(st.relinkAt) > 5000) {   // (moved to a new link: quietly)
          toast('Connected to ' + st.pc.name, 1400);
        }
        st.wantResume = false;
        break;
      case 'settings':
        if (m.side) st.side = m.side;
        if (m.theme && m.theme !== st.theme) { applyTheme(m.theme); refreshThemeSheet(); }
        settingsAgain();                        // (Settings open: its Animation and side rows say what the PC has now)
        break;
      case 'pc':
        if (cleanName(m.name) && st.pc) { st.pc.name = cleanName(m.name); setPcName(); }
        break;
      case 'busy':
        // another phone has the PC; this one picked its session back up on its own, so don't push it off — wait for the user
        st.wantResume = false; st.replaced = true; st.connectWanted = 0; st.pairAsked = false;
        connectEnded('pc', st.pc && st.pc.id);                  // (asked as a new device and paired: Connect switches to it)
        if (st.screen === 'pair') { G.hold = 0; pairHint('Another phone is connected to ' + nameHtml(st.pc && st.pc.name, 'your PC') + '. Hold to switch to this one.'); }
        else toast('Another phone is using ' + (st.pc ? st.pc.name : 'your PC') + '. Hold Connect to switch.', 3000);
        break;
      case 'replaced':
        st.wantResume = false; st.replaced = true;
        toast('Another phone is using ' + (st.pc ? st.pc.name : 'your PC') + ' now. Hold Connect to switch back.', 3200);
        break;
      case 'saved': if (linkTrusted()) onSaved(m); break;
      case 'landed':                            // its card just hit the PC's desktop: a short thud in the hand
        if (linkTrusted() && flung.has(m.tid) && now() - flung.get(m.tid) < 8000 && !document.hidden) { flung.delete(m.tid); haptic('thud'); }
        break;
      case 'asking':                            // the PC asks its user first ("Ask each time"): see settleSent
        if (linkTrusted() && st.pending.has(m.tid)) st.pending.get(m.tid).asking = true;
        runHooks('ws', m);
        break;
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
    UPD.app = PLAY ? null : bestApp();
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
    if (PLAY || !NV || typeof NV.updateCheckGitHub !== 'function') return false;
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
    UPD.auto = true; UPD.wifi = false;
    UPD.state = 'downloading'; UPD.got = 0; UPD.total = a.size || 0; UPD.why = '';
    renderUpd();
    // (an app that can wait for Wi-Fi does: one from GitHub isn't fetched over mobile data unasked. It then says
    // 'metered', and the card offers the download, plainly over mobile data, with its size)
    const args = [updUrl(a), String(a.code), String(a.size), a.sha256, a.sums, a.sig];
    const r = NV && typeof NV.updateAutoDownload === 'function' ? nc.apply(null, ['updateAutoDownload'].concat(args)) : nc.apply(null, ['updateDownload'].concat(args));
    if (r === null || r === 'metered') { UPD.auto = false; UPD.wifi = r === 'metered'; UPD.state = 'ready'; renderUpd(); }
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
    UPD.auto = false; UPD.wifi = false;
    UPD.state = 'downloading'; UPD.got = 0; UPD.total = a.size || 0; UPD.why = '';
    haptic('tick');
    // (asked for before the card is drawn: a card that failed to draw said Downloading over a download never asked for)
    if (nc('updateDownload', updUrl(a), String(a.code), String(a.size), a.sha256, a.sums, a.sig) === null) { UPD.state = 'error'; UPD.why = 'unsupported'; }
    renderUpd();
  }

  function installUpdate() {
    UPD.state = 'installing';
    renderUpd();
    nc('updateInstall');
  }

  function checkForUpdates() {
    if (PLAY) return;
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
    if (/no space|ENOSPC|EDQUOT|quota/i.test(w)) return 'Your phone is out of space.';   // (however Android words it)
    if (/unsupported/.test(w)) return 'Install this update from your PC once.';
    return gh ? 'Couldn’t reach GitHub. Try again.' : 'Couldn’t reach your PC. Try again.';
  }

  function renderUpd() {
    const a = UPD.app, card = $('upd');
    const newer = isNewer(a);
    $('moreBtn').classList.toggle('dot', newer && UPD.state !== 'installing' && UPD.state !== 'unsigned');
    // a step the user started stays visible; anything else respects "Not now". One Flick fetches by itself shows once it's
    // ready to install: while it came, its card ("Downloading… 0%") covered the files with no Not now, however long it took
    const started = /^(downloading|installing|perm)$/.test(UPD.state) && !UPD.auto;
    const show = newer && st.screen === 'main' && !SEL.on && (started || UPD.dismissed !== a.code) && !(UPD.auto && UPD.state === 'downloading');
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
      default:
        // (not fetched by itself on mobile data: it waits for Wi-Fi, and Download says what it costs)
        if (UPD.wifi) { title = 'Flick ' + v + ' is available'; sub = 'Waiting for Wi-Fi. Download now uses ' + fmtSize(a.size) + ' of mobile data'; btn = 'Download'; }
        else { title = 'Flick ' + v + ' is ready'; sub = a.src === 'github' ? 'New version on GitHub' : 'Over Wi-Fi from ' + pc; btn = 'Update'; }
    }
    $('updTitle').textContent = title;
    $('updSub').textContent = sub;
    // (Update pressed from a keyboard or a switch, and the download began: the button goes, and its focus to what the
    // card says now, not to the start of the page. A finger's or a mouse's press is left alone)
    const ub = $('updBtn'), kept = !btn && !ub.hidden && document.activeElement === ub && focusVisible(ub);
    ub.textContent = btn;
    ub.hidden = !btn;
    if (kept) $('updTitle').focus({ preventScroll: true });
    // (long words beside a button: the button goes under them; beside it, "Waiting for Wi-Fi. Download now uses…" lost
    // its end, mobile data with it, and "Update didn't finish" its reason)
    card.classList.toggle('stack', !!btn && (title.length > 20 || sub.length > 30));
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
  // (pc: this hold connects to the paired PC, which shows it as it fills; a hold for a new device is no business of the
  // PC connected meanwhile, whose glow followed it)
  const H = { down: false, t0: 0, p: 0, raf: 0, ticks: 0, sentAt: 0, done: false, pc: false };
  function holdFrame(t) {
    if (H.down) H.p = clamp((t - H.t0) / HOLD_MS, 0, 1);
    else H.p = Math.max(0, H.p - 0.06);
    arc.style.strokeDashoffset = String(289 * (1 - easeOut(H.p)));
    G.hold = Math.max(G.hold * (H.down || st.awaitingApproval || st.connectWanted ? 1 : 0.9), H.p);
    const tick = Math.floor(H.p * 4);
    if (H.down && tick > H.ticks && tick < 4) { H.ticks = tick; haptic('tick'); }
    if (H.pc && t - H.sentAt > 33) { H.sentAt = t; wsSend({ t: 'hold', p: H.p }); }
    if (H.down && H.p >= 1 && !H.done) {
      H.done = true; H.down = false;
      btn.classList.remove('down');
      holdDone();
    }
    if (H.down || H.p > 0) H.raf = requestAnimationFrame(holdFrame);
    else { H.raf = 0; arc.style.strokeDashoffset = '289'; if (!st.awaitingApproval && !st.connected && !st.connectWanted) G.hold = 0; }
  }
  function holdStart(e) {
    if (btn.getAttribute('aria-disabled') === 'true') return;
    e.preventDefault();
    H.down = true; H.done = false; H.t0 = now() - H.p * HOLD_MS; H.ticks = Math.floor(H.p * 4);
    btn.classList.add('down');
    haptic('tick');
    // (a paired PC here: its link gets ready; a new device: everything nearby is looked for, fast, while it's held)
    H.pc = reconnecting();
    if (H.pc) { if (!st.wsOpen && !st.connecting) openLink(); } else connectFast(true);
    if (!H.raf) H.raf = requestAnimationFrame(holdFrame);
  }
  function holdEnd() {
    H.upAt = now();
    if (!H.down) return;
    H.down = false;
    btn.classList.remove('down');
    if (!H.done) { if (H.pc) wsSend({ t: 'hold-cancel' }); if (CN.phase === 'idle') connectFast(false); }
  }
  btn.addEventListener('pointerdown', holdStart);
  btn.addEventListener('pointerup', holdEnd);
  btn.addEventListener('pointercancel', holdEnd);
  btn.addEventListener('pointerleave', holdEnd);
  btn.addEventListener('contextmenu', (e) => e.preventDefault());
  // A click with no hold before it is the go-ahead too: a screen reader's double tap (TalkBack) or a keyboard's Enter
  // can't hold, so pairing was out of reach. A finger's or a mouse's own click, as it lets go, is left alone.
  btn.addEventListener('click', () => {
    if (btn.getAttribute('aria-disabled') === 'true' || now() - (H.upAt || 0) < 600) return;
    haptic('tick');
    if (!reconnecting()) connectFast(true);
    holdDone();
  });

  // ------------------------------------------------------------------ Connect: hold it here, Allow on the other device
  // Holding Connect reaches a new device, a PC or another phone alike: everything with Flick open nearby is looked for
  // (every 300 ms while it's held) and the one meant is asked: the only one there; else the one on a cable; else the one
  // whose Connect screen (or, on a PC, Flick's window) is showing; else the user picks it from a short list. That device
  // asks its user (Allow / Don't allow, with the same code on both screens), and once it's allowed there, both are
  // paired, both ways, with nothing more to tap here. A paired PC here is connected to as always (reconnecting).
  const pcHere = () => !!(st.pc && ((st.lanList || []).some((p) => p.id === st.pc.id) || st.wsOpen || st.pc.via === 'bluetooth'));
  function reconnecting() { return !CN.newDev && pcHere() && pairedPc(st.pc) && !st.connected; }
  // Other phones are looked for while something here wants them (the Connect screen, the Other phones page)
  const scanWho = new Set();
  function peerScanFor(who, on) {
    const had = scanWho.size > 0;
    if (on) scanWho.add(who); else scanWho.delete(who);
    if ((scanWho.size > 0) !== had) nc('peerScan', scanWho.size > 0);
  }
  function connectFast(on) {
    clearTimeout(CN.fastT);
    // (on for a moment after the hold too: answers that are on their way still count)
    if (on) { nc('connectFast', true); CN.fastT = setTimeout(() => nc('connectFast', false), 20000); }
    else CN.fastT = setTimeout(() => nc('connectFast', false), 1500);
  }
  // the devices holding Connect could ask now: PCs and phones nearby that this phone isn't paired with (a phone paired one
  // way, that can send here but not the other way, too: pairing from here finishes it)
  function candidates() {
    const out = [];
    for (const p of st.lanList || []) {
      if (!p || !p.id || !p.ip || !p.port || !+p.tls || pairedPc(p)) continue;
      out.push({ kind: 'pc', id: p.id, name: cleanName(p.name) || 'PC', ready: !!p.ready, via: p.via || 'wifi', pc: p });
    }
    // the PC in use, linked to and not paired yet, whether discovery sees it or not: one reached by its address (Enter PC
    // address, there because discovery doesn't find it) said "No device found" when Connect was held, and couldn't pair
    const u = st.pc;
    if (u && st.wsOpen && u.via !== 'bluetooth' && +u.tls && !pairedPc(u) && !out.some((c) => c.id === u.id)) {
      out.push({ kind: 'pc', id: u.id, name: cleanName(u.name) || 'PC', ready: false, via: u.via || 'wifi', pc: u });
    }
    const ps = CN.peers || {};
    for (const d of ps.devices || []) {
      if (!d || !d.id || !d.nearby || (d.paired && !d.oneWay) || d.busy === 'sending') continue;
      out.push({ kind: 'phone', id: d.id, name: cleanName(d.name) || 'Phone', ready: !!d.ready, via: d.via || 'wifi' });
    }
    return out;
  }
  // the one meant, when it's clear: the only one; else one on a cable; else one whose Connect screen is showing
  function pickOne(list) {
    if (list.length === 1) return list[0];
    const score = (c) => (c.via === 'usb' ? 4 : 0) + (c.ready ? 2 : 0);
    const by = list.slice().sort((a, b) => score(b) - score(a));
    return by.length && score(by[0]) > 0 && score(by[0]) > score(by[1]) ? by[0] : null;
  }
  // the hold is complete (or Connect was clicked: a screen reader's double tap, a keyboard)
  function holdDone() {
    st.replaced = false;
    if (reconnecting()) { requestConnect(); return; }
    pairHint('');
    const list = candidates();
    if (list.length) { chooseDevice(list); return; }
    // nothing seen yet: answers can take a moment (a phone that just opened Flick, a slow network; Bluetooth, for a
    // phone that isn't on this Wi-Fi, a few seconds)
    CN.phase = 'looking'; CN.at = now();
    setPcName();
    const ble = njson('bleState') || {};
    // (Android 10 and 11 with Location off find nothing over Bluetooth: not waited for)
    const far = !!(ble.supported && ble.permitted && ble.on && ble.location !== false);
    clearInterval(CN.lookT);
    CN.lookT = setInterval(() => {
      const l = candidates();
      if (!l.length && now() - CN.at < (far ? 7500 : 4000)) return;
      clearInterval(CN.lookT);
      CN.phase = 'idle';
      setPcName();
      if (l.length) { chooseDevice(l); return; }
      connectFast(false);
      G.hold = 0;
      haptic('reject');
      notFound(ble, far);
    }, 250);
  }
  // nothing answered: what to do, and a way to find devices that aren't on this Wi-Fi (Bluetooth), when there is one
  // (a computer on another Wi-Fi isn't found over Bluetooth: a cable, or the computer's own Wi-Fi, made from its Connect)
  // (the computer's own Wi-Fi is made on Windows and Linux only: a Mac never shows that button)
  const FAR_PC = 'A computer on another Wi-Fi: plug this phone into it, or, on Windows or Linux, hold Connect on it and choose “Phone on another Wi-Fi?”.';
  const PC_FAR = ' <span class="hintpc">' + esc(FAR_PC) + '</span>';
  // the button that finds devices over Bluetooth when it can't yet (not allowed, or off); null when it can or never will
  function farFind(ble) {
    if (!ble.supported || (ble.permitted && ble.on)) return null;
    if (!ble.permitted) return { label: 'Find devices that aren’t on this Wi-Fi', run: () => { haptic('tick'); pref.set('bleAsked', '1'); nc('bleAsk'); } };   // (so it isn't asked by itself too, below)
    // (false: Android's question couldn't open; null: an app without it)
    return { label: 'Turn on Bluetooth to find devices that aren’t on this Wi-Fi', run: () => { haptic('tick'); if (nc('btEnable') !== true) toast('Turn on Bluetooth in the quick settings, then hold Connect again', 3200); } };
  }
  function notFound(ble, far) {
    const known = nearbyKnown();
    if (known) { pairHint(known); hintSoft = hintHtml; return; }
    if (far) { pairHint('No device found nearby. Open Flick on the other device, then hold Connect again.' + PC_FAR); hintSoft = hintHtml; return; }
    pairHint(esc('No device found on this Wi-Fi. Open Flick on the other device' + (ble.supported ? '.' : ', on the same Wi-Fi as this phone (or one on the other’s hotspot), then hold Connect again.')) + PC_FAR);
    hintSoft = hintHtml;
    if (!ble.supported) return;
    // (Bluetooth allowed and on, Location off on Android 10 or 11: a button opens Location's settings, as Bluetooth's
    // turns it on; an app that can't open them from here: it's said)
    if (ble.permitted && ble.on && ble.location === false) {
      if (NV && typeof NV.openLocationSettings === 'function') {
        const l = document.createElement('button');
        l.className = 'plink hintgo';
        l.textContent = 'Turn on Location to find phones over Bluetooth';
        l.onclick = () => { haptic('tick'); if (nc('openLocationSettings') !== true) toast('Turn on Location in the quick settings, then hold Connect again', 3200); };
        $('pairHint').appendChild(l);
        return;
      }
      const w = document.createElement('span');
      w.className = 'hintsay';
      w.textContent = 'Turn on Location to find phones over Bluetooth.';
      $('pairHint').appendChild(w);
      return;
    }
    const f = farFind(ble);
    if (!f) return;
    const b = document.createElement('button');
    b.className = 'plink hintgo';
    b.textContent = f.label;
    b.onclick = f.run;
    // (asked by itself the first time: the user is looking for a device right now)
    if (!ble.permitted && !pref.get('bleAsked', '')) setTimeout(() => { if (st.screen !== 'pair' || pref.get('bleAsked', '')) return; pref.set('bleAsked', '1'); nc('bleAsk'); }, 600);
    $('pairHint').appendChild(b);
  }
  // What's nearby that holding Connect doesn't ask: devices paired already, a computer whose Flick is too old to be asked.
  // Said instead of "No device found" (one was right there). Null when there's none.
  function nearbyKnown() {
    const old = (st.lanList || []).find((p) => p && p.id && !+p.tls && !pairedPc(p));
    if (old) return 'Flick on ' + nameHtml(old.name, 'that computer') + ' needs updating before this phone can connect. Flick updates itself on the PC; restarting it there updates it now.';
    const pcs = [];
    for (const p of (st.lanList || []).concat(st.btPc ? [st.btPc] : [])) if (p && p.id && pairedPc(p) && !pcs.some((x) => x.id === p.id)) pcs.push(p);
    const phones = pairedPhones().filter((d) => d.nearby);
    const names = pcs.map((p) => p.name).concat(phones.map((d) => d.name));
    if (!names.length) return null;
    const more = ' To connect another device, open Flick on it and hold Connect again.';
    const who = names.length === 1 ? nameHtml(names[0], 'A device') + ' is' : names.length === 2 ? nameHtml(names[0]) + ' and ' + nameHtml(names[1]) + ' are' : names.length + ' devices nearby are';
    const pc = pcs.length === 1 && !phones.length ? pcs[0] : null;
    if (pc && st.pc && st.pc.id === pc.id && !st.connected) {
      // (the paired PC in use: holding Connect connects to it now, as when no new device was asked for)
      CN.newDev = false;
      setPcName();
      return who + ' paired with this phone already. Hold Connect to connect to it.';
    }
    if (pc && st.connected && st.pc && st.pc.id === pc.id) return who + ' paired with this phone already, and connected.' + more;
    return who + ' paired with this phone already.' + (phones.length && !pcs.length ? ' Send files to ' + (phones.length === 1 ? 'it' : 'them') + ' from a file’s menu, or with the phone button.' : '') + more;
  }
  function chooseDevice(list) {
    const one = pickOne(list);
    if (one) { askDevice(one); return; }
    G.hold = 0;
    connectFast(false);
    const ord = list.slice().sort((a, b) => (b.via === 'usb') - (a.via === 'usb') || b.ready - a.ready || a.name.localeCompare(b.name));
    // (the one wanted may not be in the list: on another Wi-Fi, as when nothing at all is found)
    const f = farFind(njson('bleState') || {});
    openSheet('Connect to', ord.map((c) => ({
      label: c.name, icon: c.kind === 'pc' ? 'pc' : 'phone',
      tag: c.via === 'usb' ? 'USB cable' : c.via === 'bluetooth' ? 'Bluetooth' : c.ready ? 'Flick open' : c.kind === 'pc' ? 'Computer' : 'Phone',
      run: () => askDevice(c),
    })).concat(f ? [{ label: f.label, icon: 'bt', run: f.run }] : []), { note: FAR_PC });
  }
  // asks it: a PC as a phone always has (it shows Allow there), another phone the way phones pair (Allow there too)
  function askDevice(c) {
    CN.phase = 'asking'; CN.target = c; CN.at = now(); CN.started = false; CN.att0 = 0; CN.back = null; CN.same = false;
    connectFast(false);
    if (c.kind === 'pc') {
      if (!st.pc || st.pc.id !== c.id) {
        // One link to a PC at a time: the paired one in use makes way while this one is asked, and comes back if this one
        // isn't paired in the end (the phone stayed on the one asked: off its paired PC, which Connect and Settings no
        // longer showed, even after a restart)
        if (st.pc && pairedPc(st.pc)) CN.back = { pc: Object.assign({}, st.pc), resume: st.connected || st.wantResume, noAuto: !!st.noAuto };
        closeLink();
        choosePc(c.pc, false);
      }
      setPcName();
      requestConnect();
      return;
    }
    // (what it said about an earlier request is no answer to this one: the app counts each request to a device, so only
    // what comes with a higher count is this one's. The count as it is now, from the app itself: a state on its way
    // may be older)
    const d0 = ((njson('peerState') || CN.peers || {}).devices || []).find((x) => x && x.id === c.id);
    CN.att0 = d0 && +d0.attempt > 0 ? +d0.attempt : 0;
    nc(NV && typeof NV.peerPairAuto === 'function' ? 'peerPairAuto' : 'peerPair', c.id);
    setPcName();
    pairHint('Connecting to ' + nameHtml(c.name, 'the phone') + '…');
    // The app may not start the request at all (that phone was out of reach a moment ago): nothing would ever come, and
    // the screen stayed on "Asking" with Connect off. One that hasn't started in 10 s is over.
    clearTimeout(CN.askT);
    CN.askT = setTimeout(() => {
      if (CN.phase !== 'asking' || CN.target !== c || CN.started) return;
      connectEnded('phone', c.id);
      askFailed(esc('Couldn’t connect to ' + c.name + '. Try again.'));
    }, 10000);
  }
  // the asking ended without a pairing: why, on the Connect screen; again: and that holding Connect asks again
  function askFailed(html, again) {
    CN.failAt = now();
    G.hold = 0;
    haptic('reject');
    pairHint(html + (again && !reconnecting() ? ' Hold Connect to ask again.' : ''));   // (else it connects to the paired PC)
  }
  // what the other phone being asked says (the 'peers' state): its code, its answer. The app counts each pairing request
  // to a device (its attempt): a state where the count is higher than before asking was made after this request and
  // carries its answer (pairing, with the code; paired; or its words why not), whenever it comes. One made before it (on
  // its way as Connect was held, still with an earlier request's words) says nothing about it. A phone no longer listed
  // can't be reached. (askDevice's 10 s end an asking that never starts.)
  function onAskPeers() {
    const t = CN.target;
    if (CN.phase !== 'asking' || !t || t.kind !== 'phone') return;
    const d = ((CN.peers || {}).devices || []).find((x) => x && x.id === t.id);
    if (!d) {
      connectEnded('phone', t.id);
      askFailed(esc('Couldn’t reach ' + t.name + '. Make sure Flick is open on it, and that it’s nearby or on the same Wi-Fi.'));
      return;
    }
    if (!(+d.attempt > CN.att0)) return;
    if (d.busy === 'pairing') {
      CN.started = true;
      if (d.code) {
        const code = '<b class="pcode">' + esc(String(d.code).slice(0, 3) + ' ' + String(d.code).slice(3)) + '</b>', nm = nameHtml(t.name, 'the phone');
        // allowed there: it counts once the user here says the codes match too (as for a PC: a stranger's phone could
        // answer the hold first), unless the app knows it already (over a USB cable)
        if (d.allowed && !d.codeOk && !CN.same) {
          bringPair(t.name);
          askSame(nm + ' allowed it. Is this the code it showed?<br>' + code, () => { CN.same = true; nc('peerConfirm', t.id, true); pairHint('Connecting to ' + nm + '…'); },
            () => { nc('peerConfirm', t.id, false); connectEnded('phone', t.id); askFailed('Not paired with ' + nm + ': the codes didn’t match.', true); });
        } else if (!CN.same) {
          pairHint(code + '<br>Tap <b>Allow</b> on ' + nm + '. It shows the same code.<br><a href="#" id="pairStop">Cancel</a>');
          const b = $('pairStop');
          if (b) b.onclick = (e) => { e.preventDefault(); connectCancel(); };
        }
      }
      return;
    }
    const ok = !!(d.paired && !d.oneWay), err = cleanName(d.error);
    if (!ok && !err && !CN.started) return;         // (counted, not under way yet: what comes next says)
    connectEnded('phone', t.id);
    if (ok) {
      haptic('confirm');
      pairHint('');
      toast('Connected to ' + t.name + '. Send files to it from a file’s menu, or with the phone button.', 3200);
      if (st.screen === 'pair') flashScreen(() => { showScreen('main'); staggerIn(); });
    } else if (err) askFailed(esc(err));
    else { G.hold = 0; pairHint(''); }              // (over with no words once it was pairing: canceled here, on Other phones)
  }
  function connectCancel() {
    const t = CN.target;
    haptic('tick');
    if (t && t.kind === 'phone') nc('peerCancel', t.id);
    // (a PC: closing the link takes its question off its screen, when the link is to it (never another PC's link: the
    // one in use could be another by now); the paired PC's own pairing again too, which had no Cancel that did anything)
    else if (t ? !!(st.pc && st.pc.id === t.id) : (st.pairAsked || st.awaitingApproval)) {
      st.pairAsked = false; st.pairOk = false; st.pairWait = null; st.awaitingApproval = false; st.connectWanted = 0;
      clearTimeout(connectT); clearTimeout(st.sameT); closeLink();
    }
    if (t) connectEnded(t.kind, t.id);
    G.hold = 0;
    pairHint('');
  }
  // the asking is over (allowed, refused, failed or canceled): true when there was one, of that device
  function connectEnded(kind, id) {
    const t = CN.target;
    if (!t || t.kind !== kind || (id && t.id !== id)) return false;
    CN.phase = 'idle'; CN.target = null; CN.newDev = false;
    clearInterval(CN.lookT);
    clearTimeout(CN.askT);
    // a PC asked in place of the paired one, and not paired now: the paired one again, connected again if it was
    const back = CN.back;
    CN.back = null;
    if (kind === 'pc' && back && st.pc && st.pc.id === t.id && !pairedPc(st.pc)) {
      st.pairAsked = false; st.pairOk = false; st.pairWait = null; st.awaitingApproval = false; st.connectWanted = 0;
      clearTimeout(connectT);
      closeLink();
      st.noAuto = back.noAuto;
      if (back.resume) st.wantResume = true;
      choosePc(back.pc, false);                         // (it's still the one remembered)
    }
    setPcName();
    return true;
  }
  // A PC asked this phone (its user held Connect there) and the user here allowed it: its user checks the code there now
  // (Same code or Different code, within two minutes), and only then gives this phone its pairing ('pc-paired', which
  // connects as usual). Until then the Connect screen says so, the code still showing to compare. Undone there
  // (Different code, no answer, the link gone): "Not paired with <PC>." and back where it was, once the app says so
  // ('pc-pair-end'), or (an app that doesn't) with no pairing by the time that PC gives up. (o: { device, name, code };
  // null: no longer waited for)
  function homeWait(o) {
    clearTimeout(HOME.t);
    HOME.t = 0;
    if (!o) { if (HOME.device) { HOME.device = ''; setPcName(); } return; }
    HOME.device = String(o.device || ''); HOME.name = cleanName(o.name) || 'the computer'; HOME.from = st.screen; HOME.show = false;
    // (under Settings or a feature's page the Connect screen isn't seen: it shows once that's closed, see uncovered.
    // Under the tour too, even with the Connect screen showing: the tour's next step puts the files there)
    if (st.screen !== 'pair' || touring()) { if (covered()) HOME.show = true; else showScreen('pair'); }
    setPcName();
    const code = String(o.code || '');
    pairHint((/^\d{6}$/.test(code) ? '<b class="pcode">' + code.slice(0, 3) + ' ' + code.slice(3) + '</b><br>' : '')
      + 'Waiting for ' + nameHtml(HOME.name) + ' to confirm the code there…');
    HOME.t = setTimeout(homeFailed, HOME_MS);
  }
  // a code to check here while the files show (see bringPair)
  let pairBack = false;
  const codeHere = () => !!(st.pairWait && !st.pairOk) || codeCheck();
  // Settings, a feature's page or the tour over the screens (what's behind isn't seen, and the tour shows the screen each
  // of its steps is about: a code to check went with its next step); closed: a wait it hid shows now
  const touring = () => !!document.querySelector('.ftour:not([hidden])');
  const covered = () => (!$('settings').hidden && !$('settings').classList.contains('closing')) || !!document.querySelector('.fpage:not([hidden]):not(.closing)') || touring();
  function uncovered() {
    if (pairBack && !covered()) { pairBack = false; if (codeHere() && st.screen !== 'pair') showScreen('pair'); }
    if (!HOME.device || !HOME.show || covered()) return;
    HOME.show = false;
    if (st.screen !== 'pair') showScreen('pair');
  }
  // The device asked allowed it, and its code is to be checked here, while the files show (asked, then "Browse files"):
  // the Connect screen comes back, as for a PC's own request (see homeWait). The question waited there unseen, and two
  // minutes on the pairing was undone, there too. Under Settings or a feature's page (or a file being dragged) it shows
  // once that's done.
  function bringPair(name, again) {
    if (st.screen === 'pair' && !touring()) return;
    if (!again) haptic('soft');
    if (D && D.phase === 'drag') { setTimeout(() => { if (codeHere()) bringPair(name, true); }, 900); return; }
    if (covered()) {
      pairBack = true;
      toast((cleanName(name) || 'The other device') + ' allowed it: check the code on the Connect screen', 3200);
      return;
    }
    showScreen('pair');
  }
  function homeFailed() {
    const nm = HOME.name, from = HOME.from, id = HOME.device;
    HOME.device = ''; HOME.t = 0;
    setPcName();
    // (paired with it from here meanwhile, or connected to it: Connect held on both at once, and this phone's own request
    // went through. That PC's request ending isn't news)
    if (pairedPc({ id }) || (st.connected && st.pc && st.pc.id === id)) return;
    haptic('reject');
    // (said where it was waited for; anywhere else, in a toast)
    if (st.screen === 'pair' && CN.phase === 'idle') {
      if (from === 'main') { pairHint(''); showScreen('main'); toast('Not paired with ' + nm + '.', 3200); }
      else pairHint('Not paired with ' + nameHtml(nm) + '.');
    } else toast('Not paired with ' + nm + '.', 3200);
  }
  // a new device from the menus (Settings, Other phones): the Connect screen, for a device other than the paired PC
  function connectNew() {
    closeSettings();
    CN.newDev = true;
    pairHint('');
    showScreen('pair');
    setPcName();
  }

  // ------------------------------------------------------------------ where a flick goes: the PC in use, or a phone
  // A card flicked off the edge (or sent from a menu) goes to the PC in use, as always; or to another phone the user
  // picked from the connection button (kept: pref 'target'). With no PC connected, the one paired phone is it.
  function pairedPhones() { return ((CN.peers || {}).devices || []).filter((d) => d && d.id && d.paired && !d.oneWay); }
  function flickTarget() {
    const ph = pairedPhones();
    let id = '';
    try { const t = JSON.parse(pref.get('target', '{}')); id = t && t.kind === 'phone' && typeof t.id === 'string' ? t.id : ''; } catch (e) { /* the PC */ }
    const picked = id && ph.find((d) => d.id === id);
    if (picked) return { kind: 'phone', id: picked.id, name: cleanName(picked.name) || 'Phone', nearby: !!picked.nearby };
    // (a PC whose session is moving to a new link, or reconnecting, is still the one in use: flicks made meanwhile went
    // to the phone)
    if (st.connected || (st.wantResume && st.pc && pairedPc(st.pc))) return { kind: 'pc' };
    // no PC: the one phone paired (the one nearby, when there are several and only one is)
    const near = ph.filter((d) => d.nearby), one = ph.length === 1 ? ph[0] : near.length === 1 ? near[0] : null;
    return one ? { kind: 'phone', id: one.id, name: cleanName(one.name) || 'Phone', nearby: !!one.nearby } : null;
  }
  const toPhone = (d) => !!(d && d.target && d.target.kind === 'phone');
  function setTarget(t) {
    pref.set('target', t && t.kind === 'phone' ? JSON.stringify({ kind: 'phone', id: t.id }) : '');
    renderTarget();
  }
  // the connection button says where flicks go: the PC (its dot: connected), or a phone (its dot: nearby)
  function renderTarget() {
    const t = flickTarget(), b = $('pcBtn');
    const ph = !!(t && t.kind === 'phone');
    if (b.dataset.to !== (ph ? 'phone' : 'pc')) {
      b.dataset.to = ph ? 'phone' : 'pc';
      const svg = b.querySelector('svg');
      if (svg) svg.replaceWith(svgEl(ph ? '<svg viewBox="0 0 28 28"><rect x="8.5" y="3.5" width="11" height="21" rx="2.6" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12.5 20.6h3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>'
        : '<svg viewBox="0 0 28 28"><rect x="5" y="6.5" width="18" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M2.5 21.5h23" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>'));
    }
    b.setAttribute('aria-label', ph ? 'Sending to ' + t.name : st.connected ? 'Connected to ' + (st.pc ? st.pc.name : 'your PC') : 'Connection');
    $('cdot').classList.toggle('on', ph ? !!t.nearby : st.connected);
  }
  // sends to a phone flicked lately (its id -> when): its card landing there ('peer-landed') is a thud in the hand
  const flungPeer = new Map();
  // a card flicked off the edge toward a phone: it goes now; false (and a word why) when it can't
  function flickPhone(d, evx) {
    const t = d.target;
    const spec = d.items.map((x) => (x.path ? { path: x.path } : { id: x.id }));
    const fx = { look: d.look, y: clamp((d.y + d.h / 2) / innerHeight, 0, 1), vx: evx };
    const r = NV && typeof NV.peerSendFx === 'function' ? nc('peerSendFx', t.id, JSON.stringify(spec), JSON.stringify(fx)) : nc('peerSend', t.id, JSON.stringify(spec));
    if (r === 'ok') {
      flungPeer.set(t.id, now());
      toast('Sending ' + (d.items.length === 1 ? midName(d.items[0].name) : fmtNum(d.items.length) + ' items') + ' to ' + t.name + '…', 1800);
      return true;
    }
    toast(r === 'busy' ? 'Wait until what’s going to ' + t.name + ' is sent' : r === 'unpaired' ? t.name + ' isn’t paired with this phone any more'
      : d.items.length === 1 ? 'That file can’t be read any more' : 'Those files can’t be read any more', 2600);
    haptic('reject');
    return false;
  }
  // the connection button: where flicks go (the PC, or a paired phone), connecting a new device, disconnecting
  function targetSheet() {
    const t = flickTarget(), phones = pairedPhones();
    const pc = st.pc && pairedPc(st.pc) ? st.pc : null;
    const items = [];
    if (pc) {
      const here = !!(t && t.kind === 'pc');
      items.push({ label: pc.name, icon: 'pc', tag: here ? 'Sending here' : st.connected ? 'Connected' : 'Not connected',
        run: () => { setTarget(null); if (!st.connected) { showScreen('pair'); openLinkSoon(); } else toast('Sending to ' + pc.name, 1400); } });
    }
    // the other paired PCs around: picking one switches to it, as the PC button does when no phone is paired (pcs.js)
    const others = (FEATURES.pairedPcs ? FEATURES.pairedPcs() : []).filter((p) => !pc || p.id !== pc.id)
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));
    for (const p of others) {
      items.push({ label: cleanName(p.name) || 'PC', icon: 'pc', tag: LINK_NAMES[p.via] || 'Wi-Fi', run: () => { setTarget(null); FEATURES.switchPc(p); } });
    }
    for (const d of phones) {
      const here = !!(t && t.kind === 'phone' && t.id === d.id), nm = cleanName(d.name) || 'Phone';
      items.push({ label: nm, icon: 'phone', tag: here ? 'Sending here' : d.nearby ? 'Nearby' : 'Not nearby',
        run: () => { setTarget({ kind: 'phone', id: d.id }); toast('Flicks go to ' + nm + ' now', 1600); } });
    }
    items.push({ label: 'Connect a device', icon: 'spark', run: connectNew });
    if (st.connected) items.push({ label: 'Disconnect from ' + st.pc.name, icon: 'off', danger: true, run: () => { st.wantResume = false; st.noAuto = true; closeLink(); showScreen('pair'); openLinkSoon(); } });
    openSheet('Send to', items);
  }

  // ------------------------------------------------------------------ views (file manager)
  const CATS = [
    { v: 'recent', label: 'Recent' }, { v: 'photos', label: 'Photos' }, { v: 'videos', label: 'Videos' },
    { v: 'downloads', label: 'Downloads' }, { v: 'docs', label: 'Documents' }, { v: 'audio', label: 'Audio' },
    { v: 'apks', label: 'APKs' }, { v: 'storage', label: 'Phone storage' }, { v: 'shelf', label: 'Flick' },
  ];
  const PAGE = 240;
  // failed: why the view couldn't be listed (said where its files would be: it showed "No photos", "0 items"); retryAt:
  // a later page that failed is asked for again from then on, as the grid reaches its end (not on every frame)
  const V = { cat: 'recent', path: null, title: 'Recent', items: [], more: false, total: 0, loading: false, stack: [], gen: 0, offset: 0,
    failed: '', retryAt: 0, failN: 0, loadP: null };

  // the tabs: a screen reader hears which one is open (it was shown only by its colour)
  const chips = $('chips');
  chips.setAttribute('role', 'tablist');
  for (const c of CATS) {
    const b = document.createElement('button');
    b.className = 'chip';
    b.dataset.v = c.v;
    b.setAttribute('role', 'tab'); b.setAttribute('aria-selected', 'false');
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
      if (b.getAttribute('aria-selected') !== String(active)) b.setAttribute('aria-selected', String(active));
    }
    let sub = '';
    if (V.loading && !V.items.length) sub = '<span class="spin"></span>Loading…';
    else if (inDir && V.path && STG.root && V.path.indexOf(STG.root) === 0 && V.path !== STG.root) {
      // breadcrumb, e.g. "Phone storage › DCIM › Camera": each name on its own, so Hebrew or Arabic folder names next
      // to each other keep their order (they read as one right-to-left run: the deepest folder first)
      sub = ['Phone storage'].concat(V.path.slice(STG.root.length).split('/').filter(Boolean)).map((s) => '<bdi>' + esc(s) + '</bdi>').join('  ›  ');
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
    if (SEL.on) selNone();
    if (SRCH.on) endSearch(true);            // a search belongs to the view it was started in
    V.gen++;
    V.cat = cat; V.title = title; V.items = []; V.more = false; V.total = 0; V.offset = 0; V.loading = false;
    V.failed = ''; V.retryAt = 0; V.failN = 0; V.loadP = null;
    // a Flick-list file on its way to the PC stays out of the list until the PC has it (it came back as if never sent
    // once the user had looked at another tab meanwhile); anything else hidden is let go
    const going = new Set();
    for (const p of st.pending.values()) if (p.phase === 'sent') for (const x of itemsOf(p)) going.add(x.id);
    for (const id of st.hidden) if (!going.has(id)) st.hidden.delete(id);
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
    if (cat === 'shelf') { V.items = sortShelf(njson('library') || []); V.total = V.items.length; keepIncoming(); afterLoad(); return; }
    keepIncoming();
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
    if (!data || data.error) {
      // (said where its files would be too: once the toast was gone, it was "This folder is empty")
      V.items = []; V.total = 0;
      V.failed = data ? (data.error === 'notfound' ? 'gone' : 'error') : 'slow';
      afterLoad();
      toast(data ? 'Can’t open this folder' : 'This folder took too long to open', 2400);
      return;
    }
    V.failed = '';
    V.items = sortList(data.items || []);
    V.total = V.items.length;
    if (data.name && V.stack.length === 0 && V.rootCat === 'storage') V.title = data.name;
    afterLoad();
    if (restoreScroll) requestAnimationFrame(() => { scroller.scrollTop = restoreScroll; renderWindow(false); });
  }

  // what a category's files are called in a sentence
  const CAT_WORDS = { recent: 'recent files', photos: 'photos', videos: 'videos', docs: 'documents', audio: 'audio files', apks: 'APK files' };
  const catWords = () => CAT_WORDS[V.cat] || 'files';
  // A category's next page (n files: a page, or more at once for Select all), in the view's order (only matches while
  // searching). Resolves once it's in or failed; one already on its way is waited for.
  function loadMore(n) {
    if (needsPermission()) { afterLoad(); return Promise.resolve(); }
    if (V.loading) return V.loadP || Promise.resolve();
    const gen = V.gen;
    V.loading = true; renderHeader();
    V.loadP = catPage(V.offset, n).then((data) => {
      if (gen !== V.gen) return;
      V.loading = false; V.loadP = null;
      if (!data || data.error) {
        // The phone's media index couldn't list it (an error, or no answer): said, not shown as "No photos", "0 items". A
        // later page leaves the count as it was ("240 items" said the rest were gone), and is asked for again as the grid
        // reaches its end, a few seconds on
        if (V.items.length) { V.retryAt = Date.now() + 3000; if (!V.failN++) toast('Couldn’t list more ' + catWords(), 2400); }
        else { V.failed = 'list'; toast('Couldn’t list ' + (V.cat === 'recent' ? 'recent files' : 'your ' + catWords()), 2400); }
        afterLoad();
        return;
      }
      V.failed = ''; V.failN = 0;
      const add = data.items || [];
      const seen = new Set(V.items.map((i) => i.id));
      for (const it of add) if (!seen.has(it.id)) V.items.push(it);
      V.offset += add.length;
      V.total = data.total || V.items.length;
      V.more = !!data.more && add.length > 0;
      afterLoad();
    });
    return V.loadP;
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
  // the hidden files this view has (one on its way is hidden in every tab, but counted only in its own)
  function hiddenHere() { let n = 0; if (st.hidden.size) for (const it of V.items) if (st.hidden.has(it.id)) n++; return n; }

  // the sends of this busy spell (since one began with none going or waiting): each one's size, and whether it reached
  // the PC. One that got there still counts, whole, in "Sending N%" (it went back from 49% to 10% as the nearly done one
  // of two ended); one canceled or failed doesn't count at all (a 5 GB send canceled at 4% made it 99%)
  const BATCH = new Map();
  function updateCount() {
    let sending = 0, sent = 0, total = 0, rate = 0, waiting = 0;
    const live = new Set();
    for (const [tid, p] of st.pending) {
      if (st.jobs.has(tid) || p.phase !== 'sent') continue;
      if (!p.uploaded) { sending++; sent += p.sent || 0; total += p.total || 0; rate += p.rate || 0; live.add(tid); BATCH.set(tid, { size: p.total || 0, done: false }); }
      else if (BATCH.has(tid)) BATCH.get(tid).done = true;
    }
    for (const [tid, j] of st.jobs) {
      if (!j.committed) continue;
      if (j.state === 'running' || j.state === 'queued') { sending++; sent += +j.sent || 0; total += +j.total || 0; rate += +j.rate || 0; live.add(tid); BATCH.set(tid, { size: +j.total || 0, done: false }); }
      else if (j.state === 'waiting') { waiting++; live.add(tid); }
      else if (j.state === 'done' && BATCH.has(tid)) BATCH.get(tid).done = true;
      else BATCH.delete(tid);                                // (failed, canceled, skipped)
    }
    // (a short "Waiting for the PC" is part of the same spell)
    if (!sending && !waiting) BATCH.clear();
    else for (const [tid, b] of BATCH) {
      if (live.has(tid)) continue;
      if (b.done) { sent += b.size; total += b.size; } else BATCH.delete(tid);   // (a send gone without reaching the PC)
    }
    $('count').classList.toggle('busy', sending + waiting > 0);
    if (!sending && waiting) { $('count').textContent = 'Waiting for ' + (([...st.jobs.values()].find((j) => j.state === 'waiting') || {}).pcName || 'your PC') + '…'; return void updateEmpty(); }
    const n = needsPermission() ? 0 : V.cat === 'dir' || SRCH.f ? visibleItems().filter((i) => !i.incoming).length : Math.max(V.total - hiddenHere(), visibleItems().length);
    const pct = total > 0 ? Math.min(99, Math.floor((sent / total) * 100)) : -1;
    // (nothing counted where nothing could be listed: the files say why; nor while the first of them are on their way, or
    // before numbers can be written: "0 items" showed first, then the count, as the phone listed its files)
    $('count').textContent = sending ? 'Sending' + (pct >= 0 ? ' ' + pct + '%' : '…') + (rate > 0 && settings.showSpeed ? ' · ' + fmtRate(rate) : '')
      : (V.failed || V.loading) && !n || !numF ? '' : fmtNum(n) + (n === 1 ? ' item' : ' items');
    updateEmpty();
  }
  const RETRY = '<button class="eretry" id="emptyRetry">Try again</button>';
  function updateEmpty() {
    const empty = !V.loading && !needsPermission() && visibleItems().length === 0;
    $('empty').hidden = !empty;
    if (empty) {
      const msgs = {
        shelf: ['Nothing here yet', 'Tap <b>+</b> to add files, or use <b>Share → Flick</b> from any app. Files from your PC also land here.'],
        dir: ['This folder is empty', ''], photos: ['No photos', ''], videos: ['No videos', ''], docs: ['No documents', ''],
        audio: ['No audio files', ''], apks: ['No APK files', ''], recent: ['Nothing recent', ''],
      };
      // what couldn't be listed (see loadDir, loadMore), and a way to try again (a folder that's gone won't come back)
      const fail = {
        gone: ['Can’t open this folder', 'It isn’t there any more: it was moved, renamed or deleted.'],
        error: ['Can’t open this folder', RETRY], slow: ['This folder took too long to open', RETRY],
        list: [SRCH.q ? 'Couldn’t search ' + catWords() : 'Couldn’t list ' + (V.cat === 'recent' ? 'recent files' : 'your ' + catWords()), RETRY],
      };
      const m = fail[V.failed] || (SRCH.q ? ['No results', 'Nothing here matches “' + esc(SRCH.q) + '”'] : msgs[V.cat] || msgs.recent);
      $('emptyTitle').textContent = m[0];
      if ($('emptySub').innerHTML !== m[1]) $('emptySub').innerHTML = m[1];
    }
  }
  // Try again: the view anew (a folder, or the category's first page; a search is searched again)
  $('empty').addEventListener('click', (e) => {
    if (!e.target.closest || !e.target.closest('#emptyRetry')) return;
    haptic('tick');
    if (V.cat !== 'dir' && SRCH.on && SRCH.q) requery(); else refreshStorage(true);
  });

  function buildCard(it) {
    const c = document.createElement('div');
    c.className = 'card' + (it.dir ? ' folder' : '');
    c.dataset.id = it.id;
    c._it = it;
    const th = document.createElement('div');
    th.className = 'thumb';
    th.appendChild(Object.assign(document.createElement('i'), { className: 'check' }));
    if (it.dir) {
      th.appendChild(svgEl(FOLDER_SVG));
      if (it.incoming) th.appendChild(svgEl(PROG_SVG));          // a folder arriving from another phone
    } else {
      const isDoc = !(it.kind === 'image' || it.kind === 'video');
      if (isDoc) th.classList.add(it.kind === 'apk' || it.kind === 'audio' ? 'app' : 'doc');
      const src = thumbUrl(it);
      if (src) {
        const img = document.createElement('img');
        img.decoding = 'async';
        img.draggable = false;
        img.alt = '';                        // (the name under it says what it is: a screen reader called each one an image)
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
      th.appendChild(svgEl(PROG_SVG));
    }
    // (a card drawn again, scrolled back to or after a tab change, shows how far its file has come)
    if (it.incoming) { const pr = th.querySelector('.prog'); if (pr) { pr.classList.add('on'); pr.querySelector('.arc').style.strokeDashoffset = String(53.4 * (1 - clamp(it.got || 0, 0, 1))); } }
    c.appendChild(th);
    const meta = document.createElement('div');
    meta.className = 'meta';
    // (a card's name is cut in its middle, to fewer characters as the text grows; a row's at its end)
    const n = document.createElement('div'); n.className = 'name'; n.textContent = VIEW.list ? it.name : midName(it.name, Math.max(8, Math.floor(18 / Math.max(1, TZ))));
    n.dir = 'auto';                          // a Hebrew or Arabic name reads right to left (and is cut at its end)
    const i = document.createElement('div'); i.className = 'info';
    i.textContent = it.incoming ? 'Receiving…' : it.dir ? (it.count === 1 ? '1 item' : (it.count || 0) + ' items') : fmtSize(it.size) + ' · ' + fmtWhen(it.mtime || it.added);
    if (VIEW.list) i.textContent = rowInfo(it);       // list rows: size, date and type
    meta.appendChild(n); meta.appendChild(i);
    {
      const more = document.createElement('button'); more.className = 'more';
      more.setAttribute('aria-label', 'More for ' + it.name);
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
      if (!el) { el = buildCard(it); cards.set(it.id, el); grid.appendChild(el); if (SEL.ids.has(it.id)) el.classList.add('sel'); if (SEL.on) selMark(el, it); }
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
    // (so is the card with the keyboard's or a screen reader's focus, scrolled away: its place in the files stays. Moved
    // to the nearest card each time, the focus went from card to card as the files scrolled, each one said aloud)
    const fa = document.activeElement;
    if (fa && fa !== document.body && grid.contains(fa)) {
      for (const [id, el] of cards) {
        if (keep.has(id) || !el.contains(fa)) continue;
        const it = geo.find((x) => x.id === id);
        if (it) visit(it);
        break;
      }
    }
    let lost = null;
    for (const [id, el] of cards) {
      if (keep.has(id)) continue;
      if (el.contains(document.activeElement)) lost = el.getBoundingClientRect();
      el.remove(); cards.delete(id);
    }
    if (lost) keepFocusNear(lost);
    // once the grid slows down, the thumbnails it skipped are loaded
    clearTimeout(SV.settleT);
    if (!loadImgs) SV.settleT = setTimeout(() => { SV.t = 0; renderWindow(false); }, 140);
  }

  // A card with the keyboard's (or a screen reader's) focus went (sent from its menu, removed): the focus goes to the ⋯ of
  // the card nearest to where it was, or to the files' title. It dropped to the start of the page.
  function keepFocusNear(r) {
    const a = document.activeElement;
    if (a && a !== document.body && a.isConnected) return;
    let best = null, bd = Infinity;
    for (const el of cards.values()) {
      if (el.classList.contains('lifted')) continue;
      const q = el.getBoundingClientRect(), d = Math.hypot(q.left - r.left, q.top - r.top);
      if (d < bd) { bd = d; best = el; }
    }
    const m = best && best.querySelector('.more');
    if (m) { try { m.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }
    else if (st.screen === 'main') focusScreen('main');
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
      // (read before the cards change: read after, each frame of a scroll worked out the page's layout once more)
      const near = scroller.scrollTop + innerHeight * 3 > gridH;
      renderWindow(false);
      if (V.more && !V.loading && V.cat !== 'dir' && V.cat !== 'shelf' && near && Date.now() >= V.retryAt) loadMore();
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
    // (a PC this phone isn't paired with isn't named, nor sent to: that only said "Not connected to your PC". Connect
    // first, where a PC is paired)
    const pcName = st.pc && pairedPc(st.pc) ? st.pc.name : '';
    const toPc = (what) => (pcName ? { label: what + pcName, icon: 'send', run: () => sendItems([it], { say: true }) }
      : { label: what + 'a PC', icon: 'send', run: () => { CN.newDev = false; showScreen('pair'); } });
    const select = { label: 'Select', icon: 'check', run: () => { setSelecting(true); SEL.ids.add(it.id); SEL.at = now(); renderSelection(); } };
    if (it.dir) {
      openSheet(it.name, [
        toPc('Send folder to '),
        ...runHooksList('itemMenu', it),               // (other phones)
        { label: 'Open', icon: 'folder', run: () => openDir(it.path, it.name) },
        pinEntry(it.path, it.name),
        select,
      ]);
      return;
    }
    if (it.path) {
      const parent = it.path.replace(/\/[^/]*$/, '');
      openSheet(it.name, [
        toPc('Send to '),
        ...runHooksList('itemMenu', it),
        previewEntry(it),
        { label: 'Open', icon: 'open', run: () => { if (nc('openPath', it.path) === false) toast('Couldn’t open this file'); } },
        { label: 'Share', icon: 'share', run: () => nc('sharePath', it.path) },
        V.cat !== 'dir' || V.path !== parent ? { label: 'Show in folder', icon: 'folder', run: () => showInFolder(parent) } : null,
        select,
      ]);
      return;
    }
    openSheet(it.name, [
      toPc('Send to '),
      ...runHooksList('itemMenu', it),
      previewEntry(it),
      { label: 'Open', icon: 'open', run: () => { if (nc('open', it.id) === false) toast('Couldn’t open this file'); } },
      { label: 'Share', icon: 'share', run: () => nc('share', it.id) },
      { label: 'Save to phone', icon: 'save', run: () => saveCopy(it) },
      // (asked first, as Clear the Flick list is: Flick's copy is deleted, for a file from another phone the only one here)
      { label: 'Remove from Flick', icon: 'trash', danger: true, run: () => openSheet('Remove ' + midName(it.name, 40) + ' from Flick? Flick’s copy is deleted.', [
        { label: 'Remove', icon: 'trash', danger: true, run: () => dropItem(it.id, true) },
        { label: 'Cancel', run: () => {} },
      ], { focus: 'Cancel' }) },
      select,
    ]);
  }

  // ------------------------------------------------------------------ multi-select
  // what can be selected: the files the grid shows (not one still coming from the PC, nor a Flick-list file already
  // on its way to it: hidden, Select all took it too, and Send sent it again)
  function selectable(it) { return !it.incoming && !st.hidden.has(it.id); }
  function selItems() { return V.items.filter((it) => SEL.ids.has(it.id) && selectable(it)); }
  function setSelecting(on) {
    const was = SEL.on;
    SEL.on = !!on;
    if (was !== SEL.on) { SEL.n++; SEL.busy = false; }
    if (!SEL.on) SEL.ids.clear();
    document.body.classList.toggle('selecting', SEL.on);
    renderSelection();
    if (!SEL.on) renderHeader();
    if (was !== SEL.on) runHooks('select', SEL.on);
  }
  function toggleSel(it) {
    if (SEL.ids.has(it.id)) SEL.ids.delete(it.id); else SEL.ids.add(it.id);
    haptic('tick');
    if (!SEL.ids.size) selNone(); else renderSelection();
  }
  // nothing selected any more: selecting ends, unless a feature keeps it going (choosing what to send to a phone goes on
  // until it's sent or closed)
  function selNone() {
    if (!SEL.on) return;
    if (runHooks('selKeep')) { SEL.ids.clear(); renderSelection(); } else setSelecting(false);
  }
  // a category listed only in part so far (it's listed a page at a time, as the grid reaches its end)
  const moreToList = () => V.more && V.cat !== 'dir' && V.cat !== 'shelf';
  // While selecting, a card is a checkbox: a screen reader hears whether it's selected, and the keyboard reaches it
  // (Space or Enter selects it). Its ⋯ button is out of sight then, so the keyboard could select no file at all.
  function selMark(el, it) {
    const on = SEL.on && !!it && selectable(it);
    if (on) {
      if (el.getAttribute('role') !== 'checkbox') { el.setAttribute('role', 'checkbox'); el.tabIndex = 0; }
      const c = String(SEL.ids.has(it.id));
      if (el.getAttribute('aria-checked') !== c) el.setAttribute('aria-checked', c);
    } else if (el.hasAttribute('role')) { el.removeAttribute('role'); el.removeAttribute('aria-checked'); el.removeAttribute('tabindex'); }
  }
  function renderSelection() {
    for (const [id, el] of cards) { el.classList.toggle('sel', SEL.ids.has(id)); selMark(el, el._it); }
    $('selClose').hidden = !SEL.on;
    $('selAll').hidden = !SEL.on;
    $('selBar').hidden = !SEL.on;
    $('toolbar').hidden = SEL.on;
    renderUpd();
    if (!SEL.on) return;
    $('backBtn').hidden = true;
    const n = SEL.ids.size;
    $('htitle').textContent = n === 0 ? 'Choose files' : n === 1 ? '1 selected' : fmtNum(n) + ' selected';
    // a feature sending them elsewhere (to another phone: chosen for it, or with no PC connected) says so on the button
    const other = runHooks('selOther', n);
    $('hsub').textContent = other ? 'Tap Send' : st.connected ? 'Drag to your PC, or tap Send' : 'Connect to your PC to send';
    const all = V.items.filter((it) => selectable(it) && shown(it));
    $('selAll').textContent = SEL.busy ? 'Selecting…' : !moreToList() && all.length && all.every((it) => SEL.ids.has(it.id)) ? 'Select none' : 'Select all';
    const send = $('selSend');
    send.classList.toggle('off', (!st.connected && !other) || !!SEL.busy);
    $('selSendText').textContent = other || (!st.connected ? 'Connect to send' : 'Send ' + (n === 1 ? '1 item' : fmtNum(n) + ' items') + ' to ' + (st.pc ? st.pc.name : 'your PC'));
  }
  $('selClose').onclick = () => { haptic('soft'); setSelecting(false); };
  // Select all: every file of the view, those not listed yet too. It took the files listed so far (240 of 2,647 photos, and
  // said "240 selected"): someone sending all their photos sent 240. The rest are listed first, several pages at once,
  // the count going up as they come. (While searching: what the search shows.)
  $('selAll').onclick = () => {
    if (SEL.busy) return;
    const all = V.items.filter((it) => selectable(it) && shown(it));
    haptic('tick');
    if (!moreToList() && all.length && all.every((it) => SEL.ids.has(it.id))) { SEL.ids.clear(); selNone(); return; }
    for (const it of all) SEL.ids.add(it.id);
    if (!moreToList()) { renderSelection(); return; }
    selectRest();
  };
  async function selectRest() {
    const gen = V.gen, n = SEL.n, live = () => gen === V.gen && n === SEL.n && SEL.on;
    SEL.busy = true;
    renderSelection();
    let short = false;
    while (moreToList() && live()) {
      const had = new Set(V.items.map((it) => it.id));
      await loadMore(PAGE * 4);
      if (!live()) break;
      // (only the ones just listed: one unselected meanwhile stays so)
      let got = 0;
      for (const it of V.items) if (!had.has(it.id)) { got++; if (selectable(it) && shown(it)) SEL.ids.add(it.id); }
      renderSelection();
      if (!got) { short = moreToList(); break; }       // (couldn't be listed: what was is selected)
    }
    if (n === SEL.n) { SEL.busy = false; if (SEL.on) renderSelection(); }
    if (live() && short) toast('Couldn’t list them all: ' + fmtNum(SEL.ids.size) + ' of ' + fmtNum(V.total) + ' selected', 3200);
  }
  $('selSend').onclick = () => {
    // (not as it slides up after a file menu's Select: it comes up where Select was, and the second tap of a double tap
    // on Select sent the file)
    if (now() - SEL.at < 450 || SEL.busy) return;
    if (runHooks('selOther', SEL.ids.size) && runHooks('selSend', selItems())) return;
    if (!st.connected) { showScreen('pair'); openLinkSoon(); return; }
    sendItems(selItems(), { say: true });
  };

  // toolbar
  $('addBtn').onclick = () => {
    openSheet('Add to Flick', [
      { label: 'Photos & videos', icon: 'photo', run: () => nc('pick', 'media') },
      { label: 'Files', icon: 'file', run: () => nc('pick', 'files') },
    ]);
  };
  $('pcBtn').onclick = () => {
    if (pairedPhones().length) { targetSheet(); return; }   // phones too: where flicks go
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
    openSheet('Animation', []);
    const box = $('sheetItems');
    box.classList.add('tsheet');
    box.setAttribute('role', 'radiogroup'); box.setAttribute('aria-label', 'Animation');   // (the one chosen is said)
    for (const t of THEMES) {
      const b = document.createElement('button');
      b.className = 'titem' + (t.v === st.theme ? ' on' : '');
      b.dataset.v = t.v;
      b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', String(t.v === st.theme));
      // (Remove animations on: each preview keeps still on its first frame)
      b.innerHTML = '<video muted playsinline preload="auto"' + (calm.matches ? '' : ' loop autoplay') + '></video><span class="tt"><span class="tn"></span><span class="td"></span></span><span class="tc"></span>';
      b.querySelector('video').src = 'themes/' + t.v + '.webm';
      b.querySelector('.tn').textContent = t.name;
      b.querySelector('.td').textContent = t.desc;
      b.onclick = () => {
        if (now() - sheetAt < 350) return;
        if (!st.connected) { toast('Connect to your PC to change the animation', 2400); return; }
        applyTheme(t.v);
        wsSend({ t: 'set-theme', theme: t.v });
        refreshThemeSheet();
        settingsAgain();                       // (its row in Settings, under this sheet, names the one chosen)
        haptic('tick');
        toast(t.v === 'surprise' ? 'Your PC plays a different one for each file' : t.name + ' is playing on your PC', 1800);
      };
      box.appendChild(b);
    }
    rove(box);
  }
  function refreshThemeSheet() {
    for (const b of document.querySelectorAll('.tsheet .titem')) { b.classList.toggle('on', b.dataset.v === st.theme); b.setAttribute('aria-checked', String(b.dataset.v === st.theme)); }
    const box = document.querySelector('.tsheet');
    if (box) rove(box);
  }
  // the Flick-list files on their way to a PC: this page's sends, and those the app carries on with (from before Flick was
  // opened too: the app names their first files)
  function goingIds() {
    const s = new Set();
    for (const p of st.pending.values()) for (const x of itemsOf(p)) if (x) s.add(x.id);
    for (const j of st.jobs.values()) {
      if (/^(done|failed|canceled|skipped)$/.test(j.state)) continue;
      for (const x of Array.isArray(j.items) ? j.items : []) if (x && x.id != null) s.add(String(x.id));
    }
    return s;
  }
  const clearable = () => { const g = goingIds(); return V.items.filter((x) => !x.incoming && !g.has(x.id)); };
  // what the ••• menu's update says of it (it said "Ready" while it was still downloading)
  const UPD_TAG = { downloading: 'Downloading', installing: 'Installing', fetched: 'Ready', back: 'Ready', perm: 'Ready', denied: 'Ready', error: 'Didn’t finish' };
  $('moreBtn').onclick = () => {
    const upd = isNewer(UPD.app) && UPD.app.signed;
    // the places first, as tiles (Other phones, History: the features mark theirs; Settings), then the rest
    const hooks = runHooksList('menu').filter(Boolean);
    openSheet('', [
      upd ? { label: 'Update to Flick ' + (UPD.app.name || UPD.app.code), icon: 'update', tag: UPD_TAG[UPD.state] || (UPD.wifi ? 'Waits for Wi-Fi' : 'New'), run: startUpdate } : null,
      ...hooks.filter((a) => a.tile),
      { label: 'Settings', icon: 'gear', tile: true, run: openSettings },
      // (the animation is chosen in Settings › Advanced settings, with the switch that turns the animations on)
      ...hooks.filter((a) => !a.tile),       // the features' other entries
      V.cat === 'dir' ? pinEntry(V.path, V.title, true) : null,
      { label: 'Refresh', icon: 'refresh', run: () => refreshStorage(true) },
      V.cat === 'shelf' && clearable().length ? { label: 'Clear the Flick list', icon: 'clear', danger: true, run: askClearShelf } : null,
    ]);
  };
  // Clear the Flick list: asked first, as History's Clear is (it deletes Flick's copies at once, with no way back; it took
  // one tap). Not a file still on its way to a PC: its send reads it as it goes, and failed with "gone" once it was deleted
  // (out of the list until the PC has it, the user couldn't even see it go)
  function askClearShelf() {
    const n = clearable().length;
    if (!n) return;
    openSheet(n === 1 ? 'Removes the file from Flick' : 'Removes the ' + fmtNum(n) + ' files from Flick', [
      { label: 'Clear the Flick list', icon: 'clear', danger: true, run: clearShelf },
    ]);
  }
  function clearShelf() {
    if (V.cat !== 'shelf') return;
    const ids = clearable().map((x) => x.id), going = V.items.filter((x) => !x.incoming).length - ids.length;
    if (!ids.length) return;
    dropItems(ids, true);
    // (one the app is still sending, that this page didn't know of, the app keeps: it stays in the list)
    const lib = njson('library'), gone = new Set(ids);
    let kept = 0;
    for (const o of Array.isArray(lib) ? lib : []) if (o && gone.has(o.id) && !V.items.some((x) => x.id === o.id)) { V.items.push(o); kept++; }
    if (kept) { sortShelf(V.items); V.total += kept; layout(false); }
    haptic('tick');
    const left = going + kept;
    toast(!left ? 'Flick list cleared' : 'Flick list cleared. ' + (left === 1 ? 'A file still being sent stays until it’s sent'
      : fmtNum(left) + ' files still being sent stay until they’re sent'), 2600);
  }

  // ------------------------------------------------------------------ Settings page
  const LINK_NAMES = { wifi: 'Wi-Fi', usb: 'USB cable', hotspot: 'hotspot', ethernet: 'Ethernet', bluetooth: 'Bluetooth' };
  // The PC keeps which side the phone is on (it says so as the phone connects): chosen with no PC there, Settings showed
  // it, and the PC's replaced it without a word once it was back. As for the animation, the PC is needed.
  function setSide(side) {
    if ((side !== 'left' && side !== 'right') || side === st.side) return;
    if (!st.connected || !wsSend({ t: 'set-side', side })) { toast('Connect to your PC to change this', 2400); return; }
    st.side = side;
  }
  // Settings covers the screens: they're out of reach while it's open, and the keyboard starts at its top, then goes
  // back where it was (as the features' pages do)
  let setBefore = null;
  // which page of Settings shows: 'main', or 'adv' (Advanced settings)
  let setPage = 'main';
  let setHideT = 0;
  function openSettings() {
    clearTimeout(setHideT);            // (opened again while it was closing: that closing mustn't hide it after all)
    if ($('settings').hidden) setPage = 'main';
    renderSettings();
    const pg = $('settings');
    const fresh = pg.hidden || pg.classList.contains('closing');
    pg.hidden = false; pg.classList.remove('closing');
    $('setBody').scrollTop = 0;
    outOfReach($('pair'), 'settings', true); outOfReach($('main'), 'settings', true);
    if (fresh) {
      setBefore = document.activeElement;
      setTimeout(() => { if (!pg.hidden && !pg.classList.contains('closing')) $('setBack').focus({ preventScroll: true }); }, 40);
    }
    haptic('soft');
  }
  // For a moment after Settings starts to close, a tap goes nowhere: a quick second tap on its Back landed on what came
  // out from under it, the files' own Back (a folder up). The same shield as the features' pages (core.js shieldBehind)
  let setShield = null, setShieldT = 0;
  function shieldBehind() {
    if (!setShield) { setShield = document.createElement('div'); setShield.className = 'fshield'; setShield.setAttribute('aria-hidden', 'true'); }
    document.body.appendChild(setShield);
    clearTimeout(setShieldT);
    setShieldT = setTimeout(() => setShield.remove(), 350);
  }
  function closeSettings() {
    const pg = $('settings');
    // (already closed: what was under it is in reach again all the same)
    if (pg.hidden) { outOfReach($('pair'), 'settings', false); outOfReach($('main'), 'settings', false); return false; }
    pg.classList.add('closing');
    shieldBehind();
    outOfReach($('pair'), 'settings', false); outOfReach($('main'), 'settings', false);
    clearTimeout(setHideT);
    setHideT = setTimeout(() => { pg.hidden = true; pg.classList.remove('closing'); }, 200);
    const b = setBefore;
    setBefore = null;
    if (pg.contains(document.activeElement)) {
      if (b && b.isConnected && !b.closest('[inert]') && typeof b.focus === 'function') { try { b.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }
      else focusScreen(st.screen);
    }
    uncovered();
    return true;
  }
  // Back (the page's, and Android's): from Advanced settings to Settings, then out
  function settingsBack() {
    if ($('settings').hidden) return false;
    if ($('settings').classList.contains('closing')) return true;   // (a second Back as it closes isn't one for what's under it)
    if (setPage !== 'adv') return closeSettings();
    setPage = 'main';
    renderSettings();
    $('setBody').scrollTop = 0;
    const ab = $('setAdvBtn');
    if (ab) { try { ab.scrollIntoView({ block: 'center' }); ab.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }
    haptic('soft');
    return true;
  }
  $('setBack').onclick = settingsBack;
  // label: the row's name, said for the switch (its box has no words of its own: a screen reader said only "checkbox")
  function toggleEl(on, onChange, label) {
    const l = document.createElement('label'); l.className = 'stog';
    const i = document.createElement('input'); i.type = 'checkbox'; i.checked = !!on;
    if (label) i.setAttribute('aria-label', label);
    i.onchange = () => { onChange(i.checked); haptic('tick'); };
    l.appendChild(i); l.appendChild(document.createElement('span'));
    return l;
  }
  // Where the keyboard (or a screen reader) is in Settings, as a place that outlives drawing it again (each change of the
  // connection, Bluetooth's, a switch in Features, Left or Right drew it anew, and the focus dropped to the start of the
  // page): the section's title; the row's name, the app's rows and the features' (a transfer, a phone, a synced folder:
  // the keyboard on the third transfer's Cancel went to the first transfer), the how-manieth of that name; the control
  // by its own name (a switch's label, a button's words), by position where a name changed
  const ROWS = '.srow, .frow', ROWNAME = '.sl b, .ftx b';
  const setCtls = (el) => (el.matches('button') ? [el] : []).concat(Array.from(el.querySelectorAll('button, input, select, [tabindex]')));
  const titleOf = (el, sel) => { const t = el && el.querySelector(sel); return t ? t.textContent : ''; };
  const ctlKey = (c) => c.tagName + '|' + (c.getAttribute('aria-label') || '') + '|' + (c.tagName === 'BUTTON' ? c.textContent : '');
  function setPlace() {
    const a = document.activeElement, body = $('setBody');
    if (!a || a === body || !body.contains(a)) return null;
    const grp = a.closest('.sgroup'), row = a.closest(ROWS);
    const pl = { g: titleOf(grp, 'h3'), gi: grp ? Array.from(body.querySelectorAll('.sgroup')).indexOf(grp) : -1, row: !!row,
      r: row ? titleOf(row, ROWNAME) : '', rn: 0, ri: -1, k: ctlKey(a), c: setCtls(row || grp || body).indexOf(a) };
    if (row) {
      const rows = Array.from((grp || body).querySelectorAll(ROWS));
      pl.ri = rows.indexOf(row);
      for (let i = 0; i < pl.ri; i++) if (titleOf(rows[i], ROWNAME) === pl.r) pl.rn++;
    }
    return pl;
  }
  function setPlaceBack(pl) {
    if (!pl) return;
    const body = $('setBody'), groups = Array.from(body.querySelectorAll('.sgroup'));
    const grp = (pl.g && groups.find((g) => titleOf(g, 'h3') === pl.g)) || groups[pl.gi] || null;
    let el = null, within = null;
    if (!pl.row) within = grp || (pl.gi < 0 ? body : null);
    else if (grp || pl.gi < 0) {
      const rows = Array.from((grp || body).querySelectorAll(ROWS));
      const same = pl.r ? rows.filter((x) => titleOf(x, ROWNAME) === pl.r) : [];
      within = same[Math.min(pl.rn, same.length - 1)] || rows[Math.min(pl.ri, rows.length - 1)] || null;
    }
    if (within) {
      const c = setCtls(within);
      el = (c[pl.c] && ctlKey(c[pl.c]) === pl.k ? c[pl.c] : null) || c.find((x) => ctlKey(x) === pl.k) || c[pl.c] || (pl.row ? c[0] : null) || null;
    }
    if (!el && grp) el = grp.querySelector('button, input');
    try { (el || $('setBack')).focus({ preventScroll: true }); } catch (e) { /* ignore */ }
  }
  // Settings drawn again when it shows (what a row says changed: the animation, the side)
  // (under a menu opened from one of its rows, the animation's: the menu goes back to that row as drawn now, by its
  // name, when it closes; the row it was opened from is gone, and the keyboard dropped to the start of the page)
  function settingsAgain() {
    const sp = $('settings'), body = $('setBody');
    if (sp.hidden || sp.classList.contains('closing')) return;
    const row = sheetFrom && body.contains(sheetFrom) ? sheetFrom.closest(ROWS) || sheetFrom : null;
    const name = row ? titleOf(row, ROWNAME) : '';
    renderSettings();
    if (!row) return;
    sheetFrom = (name && Array.from(body.querySelectorAll(ROWS)).find((x) => titleOf(x, ROWNAME) === name && typeof x.focus === 'function' && x.tagName === 'BUTTON')) || $('setBack');
  }
  // The animations on or off (Settings › Advanced settings › Animations, and the tour's "Turn on animations"): kept, their
  // sounds made ready when they come on, and Settings, when it shows, drawn with or without the animation's own rows
  function setEffects(on) {
    settings.effects = !!on;
    saveSettings();
    if (on && settings.sounds !== false) for (const l of LOOKS) sndLoad(l);
    settingsAgain();
  }
  function renderSettings() {
    const body = $('setBody');
    const place = setPlace();
    body.innerHTML = '';
    const group = (title, rows) => {
      const g = document.createElement('section'); g.className = 'sgroup';
      if (title) { const h = document.createElement('h3'); h.textContent = title; g.appendChild(h); }
      const card = document.createElement('div'); card.className = 'scard';
      for (const r of rows) {
        if (!r) continue;
        // (ctl: a button, choices or a value beside its words, which go under them with large text: see app.css)
        const row = document.createElement(r.run ? 'button' : 'div'); row.className = 'srow' + (r.action || r.seg || r.value != null ? ' ctl' : '');
        const lab = document.createElement('div'); lab.className = 'sl';
        const b = document.createElement('b'); b.textContent = r.label; lab.appendChild(b);
        if (r.sub) { const sm = document.createElement('small'); sm.textContent = r.sub; lab.appendChild(sm); }
        row.appendChild(lab);
        if (r.value != null) { const v = document.createElement('span'); v.className = 'sv'; v.textContent = r.value; row.appendChild(v); }
        if (r.toggle) {
          const get = typeof r.toggle === 'string' ? () => settings[r.toggle] : r.toggle;
          row.appendChild(toggleEl(get(), (v) => { if (typeof r.toggle === 'string') { settings[r.toggle] = v; saveSettings(); } if (r.set) r.set(v); }, r.label));
        }
        if (r.seg) {
          // (which one is chosen is said, not only shown, as the features' choices do)
          const sg = document.createElement('div'); sg.className = 'sseg';
          sg.setAttribute('role', 'radiogroup'); sg.setAttribute('aria-label', r.label);
          for (const [v, label] of r.seg) {
            const bt = document.createElement('button'); bt.textContent = label; bt.className = r.get() === v ? 'on' : '';
            bt.setAttribute('role', 'radio'); bt.setAttribute('aria-checked', String(r.get() === v));
            bt.onclick = (e) => { e.stopPropagation(); haptic('tick'); r.set(v); renderSettings(); };
            sg.appendChild(bt);
          }
          rove(sg);
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
    // What most people change, first. Everything else is on the Advanced settings page (setPage 'adv').
    // The features' sections (runHooks 'settings') go there too, but Transfers (what moves now, at the top)
    // and the ones marked data-simple (Notifications, features/settings.js).
    group('Your devices', [
      st.pc && pairedPc(st.pc) ? {
        label: st.pc.name || 'PC',
        sub: st.connected ? 'Connected over ' + via : st.connecting ? 'Connecting…' : 'Not connected',
        action: st.connected
          ? { text: 'Disconnect', danger: true, run: () => { st.wantResume = false; st.noAuto = true; closeLink(); closeSettings(); showScreen('pair'); openLinkSoon(); } }
          : { text: 'Connect', run: () => { closeSettings(); CN.newDev = false; showScreen('pair'); openLinkSoon(); } },
      } : null,
      { label: 'Connect a device', sub: 'A PC or another phone: hold Connect, then tap Allow on the other one', run: connectNew },
    ]);
    group('This phone', [
      { label: 'Phone name', sub: 'How your PC shows this phone', value: phoneName(), run: renamePhone },
      { label: 'Files from your PC', sub: 'Where files you receive are saved', value: 'Download/Flick' },
    ]);
    const ours = Array.from(body.children);
    runHooks('settings', body);             // Transfers (what moves now) at the top, the features' sections after
    const added = Array.from(body.children).filter((g) => ours.indexOf(g) < 0 && !g.classList.contains('fmvset'));
    const simpleHooks = added.filter((g) => g.dataset.simple), fromHooks = added.filter((g) => !g.dataset.simple);
    if (!PLAY) {
      group('Updates', [
        { label: 'Check for updates automatically', sub: 'From GitHub, when Flick opens', toggle: 'autoUpdate' },
      ]);
    }
    const upd = PLAY ? null : body.lastChild;     // (the Play version has no Updates section: the others go last)
    for (const g of simpleHooks) body.insertBefore(g, upd);
    runHooks('settings-end', body);         // the last section (Help: the features' rows, core.js X.helpCard)
    // ---- Advanced settings: a page of its own (setPage 'adv'), opened from its row at the end of Settings
    const ab = document.createElement('button');
    ab.className = 'sadv'; ab.id = 'setAdvBtn';
    ab.innerHTML = '<span class="sl"><b>Advanced settings</b><small>Animations, Air grab, clipboard sync, auto-send, connections and more</small></span><svg aria-hidden="true" class="schev" viewBox="0 0 24 24"><path d="M9 5l7 7-7 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    const adv = document.createElement('div');
    ab.onclick = () => {
      setPage = 'adv';
      renderSettings();
      $('setBody').scrollTop = 0;
      try { $('setBack').focus({ preventScroll: true }); } catch (e) { /* ignore */ }
      haptic('soft');
    };
    body.appendChild(ab);
    body.appendChild(adv);
    const advGroup = (title, rows) => { group(title, rows); adv.appendChild(body.lastChild); };
    advGroup('Animations', [
      { label: 'Animations', sub: fxOn() ? 'Effects as files fly between your devices, and their sounds' : 'Off: files still move, without the effects. Turn on to choose an animation.',
        toggle: () => fxOn(), set: setEffects },
      fxOn() ? { label: 'Animation', sub: 'How files fly between your devices', value: themeOf(st.theme).name, run: themeSheet } : null,
      fxOn() ? { label: 'Sounds', sub: 'Each animation’s own sound as files land here', toggle: 'sounds' } : null,
    ]);
    advGroup('Placement and vibration', [
      { label: 'Phone is on the', sub: 'Which side of the PC screen', seg: [['left', 'Left'], ['right', 'Right']], get: () => st.side, set: setSide },
      { label: 'Vibration', toggle: 'haptics' },
    ]);
    advGroup('Connections', [
      { label: 'Connect automatically', sub: 'When Flick opens near a PC it’s paired with, no need to hold Connect', toggle: 'autoConnect' },
      { label: 'Ways to connect', sub: 'Wi-Fi, USB cable, hotspot or Bluetooth', run: waysSheet },
    ]);
    advGroup('Transfer options', [
      { label: 'Faster transfers', sub: 'Large files travel over several connections at once', toggle: 'parallel' },
      { label: 'Skip files already on the PC', sub: 'A photo or video your PC already has isn’t sent again', toggle: 'skipDup' },
      (st.pcProto || 1) >= 7 && st.connected && NV && typeof NV.speedTest === 'function'
        ? { label: 'Speed test', sub: st.speedSub || 'How fast files go to ' + (st.pc ? st.pc.name : 'your PC') + ' right now', action: { text: st.speedBusy ? 'Testing…' : 'Test', run: speedTest } } : null,
      { label: 'Show transfer speed', toggle: 'showSpeed', set: () => updateCount() },
      { label: 'Use Bluetooth when there’s no Wi-Fi', sub: settings.bluetooth ? BT_TEXT[st.btState || 'off'] || BT_TEXT.off : BT_TEXT.off, toggle: 'bluetooth', set: (v) => { btSetting(v); renderSettings(); } },
      { label: 'Keep files in the Flick list after sending', toggle: () => st.keep, set: (v) => { st.keep = v; pref.set('keep', v ? '1' : '0'); } },
    ]);
    for (const g of fromHooks) adv.appendChild(g);     // (Features, Security, Air grab)
    advGroup('About', [
      PLAY ? { label: 'Flick ' + (INFO.version || ''), sub: 'Updates come from Google Play' }
        : { label: 'Flick ' + (INFO.version || ''), action: { text: 'Check now', run: checkForUpdates } },
    ]);
    // one page or the other: Settings with its Advanced settings row, or Advanced settings' sections alone
    if (setPage === 'adv') { while (body.firstChild) body.removeChild(body.firstChild); while (adv.firstChild) body.appendChild(adv.firstChild); }
    else body.removeChild(adv);
    $('setTitle').textContent = setPage === 'adv' ? 'Advanced settings' : 'Settings';
    setPlaceBack(place);
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
    st.btPc = e.state === 'on' && e.pc && e.pc.id ? Object.assign({}, e.pc, { name: cleanName(e.pc.name) || 'PC', via: 'bluetooth' }) : null;
    onPcs();
    if (!$('settings').hidden) renderSettings();
  }

  function renamePhone() {
    askText({
      title: 'Phone name', sub: 'Shown on your PC (' + NAME_MAX + ' characters at most)', value: phoneName(), placeholder: DEVNAME, ok: 'Save', mode: 'text',
      max: NAME_MAX,
      done: (v) => {
        settings.phoneName = cutName(v.trim(), NAME_MAX);
        saveSettings();
        renderSettings();
        if (st.connected) openLink(true);       // the PC learns the new name on the next hello
        return true;
      },
    });
  }
  function waysSheet() {
    openSheet('Ways to connect', [
      { label: 'Same Wi-Fi as your PC', icon: 'wifi', tag: 'Fast', run: () => toast('Put the phone and the PC on the same Wi-Fi, then hold Connect', 3200, true) },
      { label: 'USB cable', icon: 'usb', tag: 'Fastest', run: () => toast('Plug the phone into the PC, then turn on USB tethering in Android’s Hotspot & tethering settings', 4200, true) },
      { label: 'Your phone’s hotspot', icon: 'hotspot', tag: 'No Wi-Fi needed', run: () => toast('Turn on the phone’s hotspot and join it from the PC; Flick finds the PC by itself', 4200, true) },
      // (Settings, open under it, shows the switch it turns on: it still showed off)
      { label: 'Bluetooth', icon: 'bt', tag: 'Slow', run: () => { if (!settings.bluetooth) { settings.bluetooth = true; saveSettings(); btSetting(true); if (!$('settings').hidden) renderSettings(); } toast('Pair this phone with the PC in Bluetooth settings; Flick uses it when there’s no network', 4200, true); } },
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
    delete edge.dataset.look;                      // (the PC's own: the animation's colours)
    EG.hover = !!m.on;
    EG.target = m.on ? 0.85 : 0;
    EG.h = 380;
    if (typeof m.y === 'number') EG.y = clamp(m.y, 0, innerHeight);
    egKick();
  }
  // the glow goes out when the link is lost: the PC's hover can't send its "off" over a link that's gone, and a lit
  // target would keep the glow and its frame loop on for good
  function edgeOff() { if (EG.target || EG.hover) { EG.hover = false; EG.target = 0; egKick(); } }

  // ------------------------------------------------------------------ release effects (canvas): sparks, lightning, light, colour tears
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
  // ------------------------------------------------------------------ each animation's moment as a card leaves for the
  // PC, at the edge it goes through (the PC plays the rest): Meteor throws sparks back, Volt crackles, Warp pulls light
  // in, Glitch tears the edge into colours. The edge flashes in its colour.
  const back = () => -towardSign();
  function sparks(x, y) {
    for (let i = 0; i < 26; i++) {
      const a = (Math.random() - 0.5) * 2.2, sp = 160 + Math.random() * 480;
      fxParts.push({ x, y: y + (Math.random() - 0.5) * 60, vx: back() * Math.cos(a) * sp, vy: Math.sin(a) * sp - 70, age: -Math.random() * 0.05, life: 0.22 + Math.random() * 0.32,
        draw(p, dt) {
          const f = Math.exp(-dt * 2.5); p.vx *= f; p.vy = p.vy * f + 600 * dt;
          const x0 = p.x, y0 = p.y; p.x += p.vx * dt; p.y += p.vy * dt;
          const k = 1 - p.age / p.life;
          fctx.lineCap = 'round';
          fctx.strokeStyle = 'rgba(255,' + Math.round(140 + 100 * k) + ',' + Math.round(50 + 140 * k * k) + ',' + k.toFixed(3) + ')';
          fctx.lineWidth = 1.7;
          fctx.beginPath(); fctx.moveTo(x0 - p.vx * 0.022, y0 - p.vy * 0.022); fctx.lineTo(p.x, p.y); fctx.stroke();
        } });
    }
    fxKick();
  }
  // a jagged line from (x0, y0) to (x1, y1): midpoint displacement
  function jag(x0, y0, x1, y1) {
    let pts = [[x0, y0], [x1, y1]];
    for (let d = 0; d < 4; d++) {
      const out = [pts[0]];
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1], b = pts[i], len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, off = (Math.random() - 0.5) * 0.55 * len;
        out.push([(a[0] + b[0]) / 2 - (b[1] - a[1]) / len * off, (a[1] + b[1]) / 2 + (b[0] - a[0]) / len * off], b);
      }
      pts = out;
    }
    return pts;
  }
  function crackle(x, y) {
    fxParts.push({ x, y, age: 0, life: 0.28, fr: -1, bolts: null,
      draw(p) {
        const fr = Math.floor(p.age * 30);
        if (fr !== p.fr) {
          p.fr = fr; p.bolts = [];
          for (let i = 0; i < 3; i++) { const yy = p.y + (Math.random() - 0.5) * 60; p.bolts.push(jag(p.x, yy, p.x + back() * (40 + Math.random() * 90), yy + (Math.random() - 0.5) * 130)); }
        }
        const k = 1 - p.age / p.life;
        fctx.lineCap = 'round'; fctx.lineJoin = 'round';
        for (const pts of p.bolts) {
          for (const [w, c] of [[7, 'rgba(120,185,255,' + (0.3 * k).toFixed(3) + ')'], [1.6, 'rgba(235,245,255,' + k.toFixed(3) + ')']]) {
            fctx.strokeStyle = c; fctx.lineWidth = w;
            fctx.beginPath(); fctx.moveTo(pts[0][0], pts[0][1]);
            for (let i = 1; i < pts.length; i++) fctx.lineTo(pts[i][0], pts[i][1]);
            fctx.stroke();
          }
        }
      } });
    fxKick();
  }
  function pullIn(x, y) {
    for (let i = 0; i < 22; i++) {
      const ang = (back() > 0 ? 0 : Math.PI) + (Math.random() - 0.5) * 2.4, r0 = 90 + Math.random() * 220;
      fxParts.push({ x, y, ang, r0, age: -Math.random() * 0.12, life: 0.3 + Math.random() * 0.15,
        draw(p) {
          const u = p.age / p.life, r1 = p.r0 * Math.pow(1 - u, 2), r2 = r1 + 16 + 40 * (1 - u);
          const c = Math.cos(p.ang), sn = Math.sin(p.ang);
          fctx.lineCap = 'round';
          fctx.strokeStyle = 'rgba(205,190,255,' + (Math.min(1, u * 5) * (1 - u)).toFixed(3) + ')';
          fctx.lineWidth = 1.5;
          fctx.beginPath(); fctx.moveTo(p.x + c * r2, p.y + sn * r2); fctx.lineTo(p.x + c * r1, p.y + sn * r1); fctx.stroke();
        } });
    }
    fxKick();
  }
  function tear(x, y) {
    fxParts.push({ x, y, age: 0, life: 0.3, fr: -1, bars: null,
      draw(p) {
        const fr = Math.floor(p.age * 30);
        if (fr !== p.fr) {
          p.fr = fr; p.bars = [];
          for (let i = 0; i < 7; i++) p.bars.push([back() * Math.random() * 70, (Math.random() - 0.5) * 170, 12 + Math.random() * 60, 2 + Math.random() * 5, ['#ff3ea5', '#34e0ff', '#ffffff'][i % 3]]);
        }
        fctx.globalAlpha = 0.85 * (1 - p.age / p.life);
        for (const b of p.bars) { fctx.fillStyle = b[4]; fctx.fillRect(back() > 0 ? p.x + b[0] : p.x + b[0] - b[2], p.y + b[1], b[2], b[3]); }
        fctx.globalAlpha = 1;
      } });
    fxKick();
  }
  // the card that's leaving, in the look: Warp stretches it into a streak; Glitch splits its colours and makes it skip
  function exitLook(d, t) {
    if (calm.matches) return;                        // (Animations off: the card just leaves)
    const u = (t - d.exitT) / 1000;
    if (d.look === 'warp') d.sx = 1 + 3.2 * Math.min(1, u / 0.16) ** 2;
    else if (d.look === 'glitch') {
      if (!d.split) { d.split = true; d.f.style.filter = 'drop-shadow(5px 0 0 rgba(255,40,140,.85)) drop-shadow(-5px 0 0 rgba(40,230,255,.85))'; }
      d.jx = Math.floor(t / 34) % 2 ? (Math.random() - 0.5) * 14 : 0;
    }
  }
  // A card arriving in a look (from the PC, or flicked from another phone): its moment at the edge it comes in through,
  // the sparks, lightning, light or colour tears flying in with it; and where it lands, a smaller one.
  function arriveFx(look, ex, y) {
    if (calm.matches) return;
    if (look === 'meteor') sparks(ex, y);
    else if (look === 'volt') crackle(ex, y);
    else if (look === 'warp') burst(ex, y, 1);
    else if (look === 'glitch') tear(ex, y);
  }
  function landFx(look, x, y) {
    if (calm.matches) return;
    if (look === 'meteor') { for (let i = 0; i < 2; i++) sparks(x, y); }
    else if (look === 'volt') crackle(x, y);
    else if (look === 'warp') burst(x, y, 0.6);
    else if (look === 'glitch') tear(x, y);
  }
  // light streaming out of a point (Warp coming out of its tunnel): the reverse of pullIn
  function burst(x, y, k) {
    for (let i = 0; i < Math.round(22 * k); i++) {
      const ang = Math.random() * Math.PI * 2, r1 = (80 + Math.random() * 200) * k;
      fxParts.push({ x, y, ang, r1, age: -Math.random() * 0.06, life: 0.28 + Math.random() * 0.14,
        draw(p) {
          const u = p.age / p.life, r = p.r1 * (1 - Math.pow(1 - u, 2)), r0 = Math.max(0, r - 18 - 34 * (1 - u));
          const c = Math.cos(p.ang), sn = Math.sin(p.ang);
          fctx.lineCap = 'round';
          fctx.strokeStyle = 'rgba(205,190,255,' + (Math.min(1, u * 5) * (1 - u)).toFixed(3) + ')';
          fctx.lineWidth = 1.5;
          fctx.beginPath(); fctx.moveTo(p.x + c * r0, p.y + sn * r0); fctx.lineTo(p.x + c * r, p.y + sn * r); fctx.stroke();
        } });
    }
    fxKick();
  }

  // ------------------------------------------------------------------ sounds: each animation's own, as on the PC
  // (sounds/<look>.ogg: the PC's, its big moment where the card lands: HIT s in, as in pc/overlay/looks). Played only
  // with Flick on screen and Animations and Sounds on (Settings › Advanced settings), at the media volume; the sound
  // device is let go a moment after.
  const SND = { ctx: null, dec: null, bufs: {}, loads: {}, idleT: 0, idleAt: 0 };
  const HIT = 1.2;
  function sndCtx() {
    if (!SND.ctx) { try { SND.ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' }); } catch (e) { SND.ctx = null; } }
    return SND.ctx;
  }
  // decoded with an offline context, ahead of time: no sound device is opened for it, and a sound is ready the moment a
  // card arrives (decoding it then, it could come too late to go with the picture)
  function sndLoad(name) {
    if (SND.bufs[name]) return Promise.resolve(SND.bufs[name]);
    if (!SND.loads[name]) {
      try { if (!SND.dec) SND.dec = new OfflineAudioContext(2, 1, 48000); } catch (e) { return Promise.resolve(null); }
      // (served by the app, as the hand tracker's files are: a file:// page can't fetch files)
      SND.loads[name] = fetch('https://flick.local/sound/' + name + '.ogg')
        .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); })
        .then((b) => SND.dec.decodeAudioData(b))
        .then((buf) => (SND.bufs[name] = buf))
        .catch((e) => { console.log('sound ' + name + ': ' + (e && e.message)); delete SND.loads[name]; return null; });
    }
    return SND.loads[name];
  }
  setTimeout(() => { if (settings.sounds !== false && fxOn()) for (const l of LOOKS) sndLoad(l); }, 2500);
  // a look's sound, its big moment `land` seconds from now: one that starts late starts further in, so its big moment
  // still comes as the card lands; once the card has landed, it's left out
  function playLook(look, land) {
    if (settings.sounds === false || !fxOn() || document.hidden || !LOOKS.includes(look)) return;
    const c = sndCtx();
    if (!c) return;
    const asked = now();
    if (c.state !== 'running') c.resume().catch(() => {});
    sndLoad(look).then((buf) => {
      if (!buf || document.hidden) return;
      const late = (now() - asked) / 1000, off = Math.max(0, HIT - land) + late;
      if (late >= land - 0.05 || off >= buf.duration) return;
      const src = c.createBufferSource();
      src.buffer = buf;
      const gn = c.createGain();
      gn.gain.value = 0.55;
      src.connect(gn).connect(c.destination);
      // (the sound device was let go while this sound loaded, after the one before: taken again, or it played unheard)
      clearTimeout(SND.idleT);
      if (c.state !== 'running') c.resume().catch(() => {});
      src.start(c.currentTime, off);
      // (let go once the last of the sounds playing has ended: a short one after a long one cut the long one off)
      SND.idleAt = Math.max(SND.idleAt, now() + (buf.duration - off) * 1000 + 1500);
      SND.idleT = setTimeout(() => { SND.idleAt = 0; if (SND.ctx && SND.ctx.state === 'running') SND.ctx.suspend().catch(() => {}); }, SND.idleAt - now());
    });
  }

  // the moment a card leaves the phone toward the PC
  function releaseFx(rect, look) {
    const ex = st.side === 'right' ? 0 : innerWidth;
    const y = clamp(rect.y + rect.h / 2, 0, innerHeight);
    edge.dataset.look = LOOKS.includes(look) ? look : pickLook();
    // (Remove animations on: no full-screen effect; the edge's short glow still says the file went)
    if (calm.matches) { egFlash(y); return; }
    if (look === 'meteor') sparks(ex, y);
    else if (look === 'volt') crackle(ex, y);
    else if (look === 'warp') pullIn(ex, y);
    else if (look === 'glitch') tear(ex, y);
    egFlash(y);
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
      name: items.length === 1 ? it.name : fmtNum(items.length) + ' items', size, count: items.length,
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
      tid: rid(), raf: 0, last: 0, phase: 'drag', sentMove: 0,
    };
    D.x = fx - D.offX; D.y = fy - D.offY;
    if (VIEW.list) rowLift(D, r);                    // (it grows out of the row's thumbnail, under the finger)
    for (const x of items) { const e2 = cards.get(x.id); if (e2) e2.classList.add('lifted'); }
    if (items.length > 1) gather(items.slice(1), () => (D ? { x: D.x, y: D.y, w: D.w, h: D.h } : { x: r.left, y: r.top, w: r.width, h: r.height }));
    haptic('lift');
    D.look = pickLook();
    D.target = flickTarget();                        // where it goes: the PC in use, or a phone picked to send to
    edge.dataset.look = D.look;
    // a long press may only be selecting: nothing is sent until the finger actually moves
    if (D.how !== 'press') beginSend();
    D.raf = requestAnimationFrame(dragFrame);
  }
  // The send starts (sendStart) and the PC hears of it ('lift', with the thumbnails) once the card is drawn under the
  // finger and the app has read the thumbnails off the page's thread: both used to freeze the card as it was lifted.
  // Letting go before then starts it at once, so 'lift' still goes before 'drop'.
  function beginSend() {
    if (!D || D.sending || !st.connected || toPhone(D)) return;     // (a flick to a phone goes as it's let go)
    const d = D;
    if (!d.starting) {
      const go = d.starting = () => {
        if (D !== d || d.phase !== 'drag' || d.sending) return;         // put back (or gone) meanwhile
        if (!st.connected) { d.starting = null; return; }                // (asked again once connected)
        d.sending = true;
        st.pending.set(d.tid, { item: d.it, items: d.items, phase: 'lifted' });
        startSend(d.tid, d.items);
        wsSend({ t: 'lift', tid: d.tid, file: fileInfo(d.items), thumb: nativeThumb(d.it), thumbs: sheetThumbs(d.items), w: d.w, h: d.h, pw: innerWidth, ph: innerHeight, look: d.look });
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
      exitLook(D, t);
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
    D.f.style.transform = 'translate3d(' + (D.x + (D.gx || 0) + (D.jx || 0)).toFixed(1) + 'px,' + (D.y + (D.gy || 0)).toFixed(1) + 'px,0) rotate(' + D.r.toFixed(2) + 'deg) scale(' + D.s.toFixed(4) + ')' +
      (D.sx ? ' scale(' + D.sx.toFixed(3) + ',' + (1 / Math.sqrt(D.sx)).toFixed(3) + ')' : '');

    if (D.phase === 'drag' && (toPhone(D) || (st.connected && D.sending))) {
      const dist = st.side === 'right' ? D.x : innerWidth - (D.x + D.w);
      const p = clamp(1 - dist / (innerWidth * 0.62), 0, 1);
      EG.target = p * p * 0.9;
      EG.y = clamp(D.y + D.h / 2, 0, innerHeight);
      EG.h = 300 + 200 * p;
      egKick();
      if (!toPhone(D) && t - D.sentMove > 14) {
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
    const phone = toPhone(D);
    let commit = (phone || st.connected) && !(pend && pend.failed) && (over > 0.2 || (toward > 0.42 && (nearEdge || over > 0)) || toward > 1.05);
    if (window.__flickDebug) window.__flickDebug.push({ vx: v.x, toward, over, nearEdge, x: D.x, commit, samples: D.samples.length, age: now() - D.samples[D.samples.length - 1].t });
    if (pend && pend.failed && (over > 0.2 || toward > 0.42)) toast('Couldn’t send ' + midName(D.it.name), 2400);
    if (commit && !D.sending && !phone) beginSend();
    const sign = towardSign();
    let evx = v.x;
    if (evx * sign < 1.7) evx = 1.7 * sign;
    if (Math.abs(evx) > 5) evx = 5 * sign;
    // to another phone: it goes now (or says why not, and the card comes back)
    if (commit && phone) commit = flickPhone(D, evx);
    if (commit) {
      const evy = clamp(v.y, -1.6, 1.6) * 0.65;
      D.phase = 'exit'; D.evx = evx; D.evy = evy; D.exitT = now();
      if (!phone) {
        wsSend({ t: 'drop', tid: D.tid, x: Math.round(D.x * 10) / 10, y: Math.round(D.y * 10) / 10, w: D.w, h: D.h, r: Math.round(D.r * 10) / 10, s: D.s, vx: evx, vy: evy, pw: innerWidth, ph: innerHeight, look: D.look });
        flungNow(D.tid);
      }
      runHooks('flicked', D.items);
      const p = st.pending.get(D.tid);
      if (p) { p.phase = 'sent'; if (p.job) nc('sendCommit', D.tid); }
      haptic('confirm');
      releaseFx({ x: D.x + D.w * (1 - D.s) / 2, y: D.y + D.h * (1 - D.s) / 2, w: D.w * D.s, h: D.h * D.s }, D.look);
      // files that stay on the phone keep their place in the grid (an empty slot until the PC has them); one sent to
      // another phone is a copy: it stays where it is
      let hid = false;
      for (const x of D.items) {
        x._sentAt = now();
        if (!phone && !x.path && !st.keep) { st.hidden.add(x.id); hid = true; }
      }
      if (phone) unlift(D.items);
      if (hid) setTimeout(() => layout(true), 120);
      if (SEL.on) setSelecting(false);
    } else {
      if (st.pending.has(D.tid)) {
        wsSend({ t: 'cancel', tid: D.tid });
        if (st.pending.get(D.tid).job) nc('sendCancel', D.tid); else nc('abort', D.tid);
        st.pending.delete(D.tid);
      }
      if (!phone && !st.connected && (D.x < 0 || D.x + D.w > innerWidth)) toast(pairedPhones().length ? 'Not connected to your PC. Tap the connection button to send to a phone.' : 'Not connected to your PC');
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
  // o.from: the rect it starts from; o.quiet: the caller shows it leaving (the preview); o.to: another phone to send it
  // to instead ({ kind: 'phone', id, name }).
  function sendItems(items, o) {
    o = o || {};
    items = (items || []).filter((x) => x && !x.incoming);
    if (!items.length) return;
    // To the PC: what calls this says so ("Send to Desk PC", Send again). Only a flick goes where the connection button
    // points (flickTarget): a menu's "Send to Desk PC" went to the phone picked there.
    const tgt = o.to && o.to.kind === 'phone' && o.to.id ? o.to : null, phone = !!tgt;
    if (!phone && !st.connected) { toast('Not connected to your PC'); return; }
    const it = items[0];
    const el = cards.get(it.id);
    let r = o.from || (el ? el.querySelector('.thumb').getBoundingClientRect() : null);
    if (r && VIEW.list && !o.from) r = rowRect(it, r);         // a list row leaves as a card
    if (!r || r.bottom < 0 || r.top > innerHeight) {          // scrolled away: start from the middle of the screen
      const w = Math.min(190, innerWidth * 0.46), h = w * 0.75;
      r = { left: (innerWidth - w) / 2, top: innerHeight * 0.42 - h / 2, width: w, height: h, right: (innerWidth + w) / 2, bottom: innerHeight * 0.42 + h / 2 };
    }
    const tid = rid(), look = pickLook();
    if (phone) {
      // (another phone: a copy goes, its card arrives there the way this one leaves; phones.js says how it went)
      const fx = { look, y: clamp((r.top + r.height / 2) / innerHeight, 0, 1), vx: towardSign() * 3 };
      if (!(FEATURES.phoneSend && FEATURES.phoneSend(tgt.id, tgt.name, items, fx))) return;
      flungPeer.set(tgt.id, now());
    } else {
      // (sent from a menu or with Send: the way a screen reader, switch access or a keyboard send. Once on the PC that is
      // said: the card flying away was all that showed it)
      st.pending.set(tid, { item: it, items, phase: 'sent', say: !!o.say });
      startSend(tid, items, true);
      wsSend({ t: 'send', tid, file: fileInfo(items), thumb: nativeThumb(it), thumbs: sheetThumbs(items), w: r.width, h: r.height, pw: innerWidth, ph: innerHeight, look });
      flungNow(tid);
    }
    if (SEL.on) setSelecting(false);
    const keep = (x) => phone || !!x.path || st.keep;
    const settle = () => {                                     // the stack is gone from the phone: empty slots until saved
      if (phone || !st.pending.has(tid)) { unlift(items); return; }
      let hid = false;
      for (const x of items) if (!keep(x)) { st.hidden.add(x.id); hid = true; }
      if (hid) { unlift(items.filter((x) => !keep(x))); layout(true); }
    };
    for (const x of items) { x._sentAt = now() + 400; const e2 = cards.get(x.id); if (e2) e2.classList.add('lifted'); }
    haptic('confirm');
    if (o.quiet) { setTimeout(settle, 450); return; }
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
    setTimeout(() => releaseFx({ x: r.left, y: r.top, w: r.width, h: r.height }, look), wait * 1000);
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
    const look = pickLook();
    wsSend({ t: 'lift', tid, air: true, file: fileInfo(items), thumb: nativeThumb(it), thumbs: sheetThumbs(items),
      w: rect ? Math.round(rect.width * k) : 160, h: rect ? Math.round(rect.height * k) : 120, y: rect ? Math.round(rect.top + rect.height * (1 - k) / 2) : undefined,
      pw: innerWidth, ph: innerHeight, look });
    for (const x of items) { const e2 = cards.get(x.id); if (e2) e2.classList.add('lifted'); }
    haptic('lift');
    return tid;
  }
  // o.video: { t } the second a playing video had reached (the PC opens it there)
  function airGo(tid, o) {
    const p = st.pending.get(tid);
    if (!p || p.phase !== 'lifted') return false;
    wsSend({ t: 'air-go', tid, video: o && o.video ? { t: Math.max(0, +o.video.t || 0) } : undefined });
    flungNow(tid);
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

  // sent files that stay on the phone come back into the grid once their departure has finished playing; all of a
  // send at once, with one layout (a big multi-send restored file by file counted the whole view for each)
  function restoreItems(items) {
    if (!items.length) return;
    let wait = 0;
    for (const it of items) wait = Math.max(wait, D && D.it === it ? 120 : 0, (it._sentAt || 0) + 750 - now());
    if (wait > 0) { setTimeout(() => restoreItems(items), wait); return; }
    let hid = false;
    for (const it of items) {
      if (st.hidden.delete(it.id)) hid = true;
      const el = cards.get(it.id);
      if (el) { el.classList.remove('lifted'); el.classList.add('pop'); setTimeout(() => el.classList.remove('pop'), 600); }
      else it._popIn = true;
    }
    if (hid) layout(true); else updateCount();
  }

  function onSaved(m) {
    const p = st.pending.get(m.tid);
    if (!p) return;
    runHooks('sent', itemsOf(p));            // the history notes what reached the PC
    st.pending.delete(m.tid);
    if (p.say) { const n = itemsOf(p).length; sayQuietly('Sent ' + (n > 1 ? n + ' items' : midName(p.item.name)) + ' to ' + ((st.pc && st.pc.name) || cleanName(pref.get('lastPcName', '')) || 'your PC')); }
    // real phone files always stay; Flick-list items follow the "keep" setting
    const back = [], gone = [];
    for (const it of itemsOf(p)) {
      if (it.path || st.keep) back.push(it);
      else gone.push(it.id);
    }
    restoreItems(back);
    dropItems(gone, true);
    updateCount();
  }
  // A send the PC has every byte of, settled without its 'saved' (lost with the link): as if it had come. When the PC
  // asked its user first ("Ask each time"), the answer isn't known: its Flick-list files stay in the list.
  function settleSent(tid, p) {
    if (!p.asking) { onSaved({ tid }); return; }
    st.pending.delete(tid);
    restoreItems(itemsOf(p));
  }
  // The PC has every byte of a send that was let go of: its 'saved' follows at once, unless the PC sent it while the
  // link was down (it isn't sent again). So the send settles by itself: soon when the link went down meanwhile, after
  // a minute otherwise (a big folder can take a while to move into place on the PC), and after the PC's minute to
  // ask its user when it asked.
  function settleSoon(tid, p) {
    clearTimeout(p.settleT);
    const ms = p.asking ? 75000 : p.relinked ? 5000 : 60000;
    p.settleT = setTimeout(() => { if (st.pending.get(tid) === p) settleSent(tid, p); }, ms);
  }

  function onFailed(m) {
    // Canceled there by its user: a newer PC says so (canceled), with why still 'declined' for older phones. A cancel,
    // not a no: said and passed on as one.
    const canceled = m.canceled === true;
    // turned down on a PC set to "Ask each time", or canceled there: the send engine's job says so too (it may have sent
    // every byte)
    if ((canceled || m.why === 'declined' || m.why === 'timeout') && st.jobs.has(m.tid)) nc('sendRefused', m.tid, canceled ? 'canceled' : m.why);
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
    // (canceled there: the cards just go back, as for a phone's cancel; a no or a failure flashes them red, with its buzz)
    for (const it of items) {
      const el = cards.get(it.id);
      if (!el) continue;
      el.classList.remove('lifted');
      if (!canceled) { el.classList.add('err'); setTimeout(() => el.classList.remove('err'), 900); }
    }
    if (!canceled) haptic('reject');
    const what = items.length > 1 ? items.length + ' items' : midName(p.item.name), pcName = st.pc ? st.pc.name : 'your PC';
    // a PC set to "Ask each time": its user said no, or nobody answered there within a minute
    toast(canceled ? 'Canceled on ' + pcName : m.why === 'declined' ? pcName + ' declined ' + what : m.why === 'timeout' ? 'Not accepted on ' + pcName + ' in time'
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
      if (p.phase === 'sent') { if (st.wsOpen) settleSoon(e.tid, p); else settleSent(e.tid, p); }
      updateCount();
      return;
    }
    // the app's send engine already tried (and waited) as long as it made sense; canceled from the transfer list: quietly
    // (an older PC, whose upload the page drives, already counts this send as coming: it is told, so it keeps no half)
    if (e.final && e.canceled) { if (p.phase === 'sent' && !p.job) wsSend({ t: 'cancel', tid: e.tid }); st.pending.delete(e.tid); for (const it of itemsOf(p)) st.hidden.delete(it.id); restoreItems(itemsOf(p)); layout(true); return; }
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
    T = { id: t.identifier, item: it, x0: t.clientX, y0: t.clientY, t0: now(), ts: e.timeStamp, moved: false };
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
      // how long the finger was down, by the touches' own times: a tap that came while the page was busy for a moment
      // (a big folder opening, files arriving) is still a tap (timed by when it was handled, it did nothing)
      const held = e.timeStamp > 0 && T.ts > 0 ? e.timeStamp - T.ts : now() - T.t0;
      const quick = held < 300 && !T.moved;
      const it = T.item;
      T = null;
      if (quick && it && !it.incoming) {
        if (e.cancelable) e.preventDefault();
        tapCard(it);
      }
    }
  }
  // a tap on a card: while selecting it is selected or not; a folder opens; a file shows its menu
  function tapCard(it) {
    if (SEL.on) toggleSel(it);
    else if (it.dir) { haptic('soft'); openDir(it.path, it.name); } else itemMenu(it);
  }
  let touchedAt = 0;
  grid.addEventListener('touchend', (e) => { touchedAt = now(); touchEnd(e); }, { passive: false });
  grid.addEventListener('touchcancel', () => { touchedAt = now(); if (D && D.phase === 'drag') dragEnd(); else if (T) { clearTimeout(T.lp); T = null; } }, { passive: true });
  // A click no finger made does what a tap does: a screen reader's double tap (TalkBack), a switch, a keyboard or a
  // mouse (cards answered only to touches: a folder couldn't be opened, nor a file's menu, without a finger). A
  // finger's own click is left alone: its tap was handled as it ended, and a press that only selected must stay so.
  // (a mouse held down a while before it lets go is a press, not a click)
  let downAt = 0, upAt = 0;
  grid.addEventListener('pointerdown', () => { downAt = now(); }, { passive: true });
  grid.addEventListener('pointerup', () => { upAt = now(); }, { passive: true });
  grid.addEventListener('click', (e) => {
    if (now() - touchedAt < 800 || (now() - upAt < 300 && upAt - downAt > 500)) return;
    if (!e.target.closest || e.target.closest('.more')) return;
    const card = e.target.closest('.card');
    const it = card && V.items.find((x) => x.id === card.dataset.id);
    if (it && !it.incoming && !st.hidden.has(it.id)) tapCard(it);
  });
  // the keyboard on a card while selecting (a checkbox then: see selMark): Space or Enter selects it or not
  grid.addEventListener('keydown', (e) => {
    if (!SEL.on || (e.key !== ' ' && e.key !== 'Enter') || e.repeat) return;
    const card = e.target.closest && e.target.closest('.card');
    if (!card || e.target !== card) return;
    e.preventDefault();                                // (Space would scroll the files)
    const it = card._it;
    if (!it || !selectable(it)) return;
    tapCard(it);
    // (the last one unselected ends selecting: the keyboard stays on that file, on its ⋯, as the card is no longer one)
    if (!SEL.on) { const m = card.querySelector('.more'); if (m) m.focus({ preventScroll: true }); }
  });
  document.addEventListener('contextmenu', (e) => e.preventDefault());

  // ------------------------------------------------------------------ incoming (PC -> phone)
  // A file downloads as soon as the PC offers it; its card comes in when the PC's card reaches the phone (m.delay).
  // Cards due together (a big batch: the PC staggers only the first dozen) are laid out once a frame and only a few
  // of them fly in; a file that arrives before its card has landed shows once it has.
  const IN = { q: [], raf: 0, t: 0, fly: [], flyRaf: 0, wait: new Set(), got: new Map(), done: [], doneRaf: 0, doneT: 0,
    tickAt: 0, held: 0, heldAt: 0, got1: 0, gotAt: 0, gotDl: false, cards: new Map(), failMsg: '', failUntil: 0 };
  // Files on their way show in the Flick tab and Recent only: that's where they arrive (in a folder or Photos, the card
  // stayed listed there after it came, and a tab change dropped it). IN.cards keeps each one's card till it has come.
  const inHere = () => V.cat === 'shelf' || V.cat === 'recent';
  // the view was made again (another tab, back from a search, another order): the cards of files still coming are put
  // back at its top
  function keepIncoming() {
    if (!IN.cards.size || !inHere()) return;
    const have = new Set(V.items.map((x) => x.id));
    const add = [...IN.cards.values()].filter((it) => !have.has(it.id));
    if (!add.length) return;
    V.items.unshift(...add.reverse());
    V.total += add.length;
  }
  function onIncoming(m) {
    const tok = pref.get(tokenKey(st.pc.id), '');
    const url = linkBase() + m.url + '?device=' + encodeURIComponent(DEVICE) + '&token=' + encodeURIComponent(tok) + parallelArg();
    incomingCard(m);
    nc('download', m.fid, url, m.name, String(m.size || 0), m.mime || '');
  }
  // the card of a file on its way here (from the PC, or from another phone: m.folder for a folder): 'down' events fill
  // its ring, 'down-done' puts what arrived in its place
  function incomingCard(m) {
    if (st.incoming && st.incoming.has(m.fid)) return;          // (its card is there already)
    (st.incoming = st.incoming || new Map()).set(m.fid, String(m.name || 'file'));
    if (m.peer) (st.peerIn = st.peerIn || new Set()).add(m.fid);
    IN.wait.add(m.fid);
    setTimeout(() => {
      IN.q.push(m);
      // with the next frame; a timer stands in when no frame comes (Flick in the background)
      if (!IN.raf) { IN.raf = requestAnimationFrame(incomingNow); IN.t = setTimeout(incomingNow, 100); }
    }, m.delay || 0);
  }
  function incomingNow() {
    cancelAnimationFrame(IN.raf); clearTimeout(IN.t); IN.raf = 0;
    const batch = IN.q.splice(0);
    if (!batch.length) return;
    // Files show where they arrive; but they don't pull the user away from pairing (a PC's code on screen, another device
    // being looked for or asked: its question went out of sight, and the pairing ran out): a toast says what's coming,
    // another phone's from phones.js, and the cards are in the list after. (Files from the PC did pull the user away.)
    const pairing = st.screen === 'pair' && (st.pairAsked || st.awaitingApproval || st.pairWait || CN.phase !== 'idle' || !!HOME.device);
    if (st.screen !== 'main' && !pairing) showScreen('main');
    // (in a folder or another tab the cards aren't listed: a toast says what's coming; another phone's says it itself)
    if (pairing || !inHere()) {
      const pcs = batch.filter((m) => !m.peer);
      if (pcs.length) {
        IN.held = (IN.heldAt && now() - IN.heldAt < 3000 ? IN.held : 0) + pcs.length; IN.heldAt = now();   // (a batch comes in a few goes)
        toast(() => (st.pc ? st.pc.name : 'Your PC') + ' is sending ' + (IN.held === 1 ? midName(pcs[0].name) : fmtNum(IN.held) + ' items'), 2400);
      }
    }
    const onMain = st.screen === 'main';
    const its = batch.map((m) => {
      const aspect = clamp(m.aspect || 1.33, 0.5, 2);
      return {
        id: 'in-' + m.fid, fid: m.fid, name: m.name, size: m.size, mime: m.mime, kind: m.kind === 'image' || m.kind === 'video' ? m.kind : (m.ext === 'pdf' ? 'pdf' : 'doc'),
        // the PC's thumbnail is only ever a small inline picture; anything else (a URL) would make the phone fetch it
        ext: m.ext, added: Date.now(), mtime: Date.now(), thumb: typeof m.thumb === 'string' && /^data:image\/(jpeg|png|webp|gif);base64,/.test(m.thumb) ? m.thumb : null,
        w: m.kind === 'image' || m.kind === 'video' ? Math.round(aspect * 1000) : 0, h: 1000, incoming: true, peer: !!m.peer,
        dir: !!m.folder, count: m.folder ? +m.count || 0 : undefined,
      };
    });
    for (const it of its) IN.cards.set(it.fid, it);
    if (!inHere()) { for (const it of its) landed(it.fid); return; }
    for (const it of its) V.items.unshift(it);
    V.total += its.length;
    if (scroller.scrollTop > 40) scroller.scrollTo({ top: 0, behavior: 'smooth' });
    layout(true);
    let flew = 0;
    its.forEach((it, i) => {
      setCardProgress(it.id, 0);
      // (scrolled far down, its card isn't drawn yet: it shows once the view is back at the top)
      const el = cards.get(it.id);
      if (!el || !onMain || document.hidden || flew >= 2 || IN.fly.length >= 8) { landed(it.fid); return; }
      flyIn(it, batch[i], el, flew === 0);           // (one sound for a batch)
      flew++;
    });
    if (flew) haptic('tick');
  }
  function flyIn(it, m, el, sound) {
    el.classList.add('ghost');
    const target = el.querySelector('.thumb');
    const w = VIEW.list ? LR.th : it._w, h = it._th;   // (a list row's thumbnail is small and square)
    const y0 = clamp((typeof m.y === 'number' ? m.y : innerHeight / 2) - h / 2, 20, innerHeight - h - 20);
    // In the animation it was sent with (from the PC, or flicked from another phone): it comes in through the edge in
    // that look, its sound's big moment as it lands. Without one: in as it always came.
    // (Animations off, or Android's Remove animations: without one too. Its sound and its thud as it lands are Flick's
    // own Animations switch's: with Android's Remove animations alone they still come, as Settings' Sounds says)
    const look = !calm.matches && LOOKS.includes(m.look) ? m.look : null;
    const heard = fxOn() && LOOKS.includes(m.look) ? m.look : null;
    const g = { fid: it.fid, el, target, f: makeFloat(it, { width: w, height: h }, target), y0, t0: now(), look, thud: !!heard, peer: !!m.peer,
      sx: st.side === 'right' ? -w - 8 : innerWidth + 8, mx: st.side === 'right' ? 26 : innerWidth - w - 26,
      a: look ? 300 : 210, b0: look ? 240 : 170, b: look ? 450 : 380 };
    g.dur = g.b0 + g.b;
    flyAt(g, g.t0, null);
    if (look) {
      edge.dataset.look = look;
      arriveFx(look, st.side === 'right' ? 0 : innerWidth, y0 + h / 2);
    } else delete edge.dataset.look;
    if (heard && sound) playLook(heard, g.dur / 1000);
    egFlash(y0 + h / 2);
    IN.fly.push(g);
    if (!IN.flyRaf) IN.flyRaf = requestAnimationFrame(flyFrame);
  }
  // in from the edge, then onto its card (rr: where the card is now). A look shows on the way: Meteor glows hot,
  // Volt jumps in steps, Warp comes out of a streak, Glitch skips with its colours split.
  function flyAt(g, t, rr) {
    const u1 = clamp((t - g.t0) / g.a, 0, 1);
    const u2 = clamp((t - g.t0 - g.b0) / g.b, 0, 1);
    let x, y, s, r;
    if (u2 <= 0 || !rr) { const e = easeOut(g.look === 'volt' ? Math.min(1, Math.ceil(u1 * 4) / 4) : u1); x = lerp(g.sx, g.mx, e); y = g.y0; s = 1.07; r = (st.side === 'right' ? 6 : -6) * (1 - e); }
    else { const e = easeInOut(u2); x = lerp(g.mx, rr.left, e); y = lerp(g.y0, rr.top, e); s = lerp(1.07, 1, e); r = 0; }
    let extra = '';
    if (g.look === 'warp') extra = ' scale(' + (1 + 2.4 * Math.pow(1 - u1, 2)).toFixed(3) + ',1)';
    if (g.look === 'glitch' && u2 < 1) x += Math.floor(t / 34) % 2 ? (Math.random() - 0.5) * 12 * (1 - u2) : 0;
    if (g.look && !g.styled) {
      g.styled = true;
      g.f.style.filter = g.look === 'meteor' ? 'drop-shadow(0 0 14px rgba(255,130,40,.9))' : g.look === 'volt' ? 'drop-shadow(0 0 12px rgba(120,185,255,.95))'
        : g.look === 'warp' ? 'drop-shadow(0 0 12px rgba(205,190,255,.9))' : 'drop-shadow(5px 0 0 rgba(255,40,140,.85)) drop-shadow(-5px 0 0 rgba(40,230,255,.85))';
    }
    g.f.style.transform = 'translate3d(' + x + 'px,' + y + 'px,0) rotate(' + r + 'deg) scale(' + s + ')' + extra;
  }
  // every card flying in moves on: their places are read first, then they all move (one layout a frame, not one each)
  function flyFrame(t) {
    IN.flyRaf = 0;
    const rects = IN.fly.map((g) => (g.target.isConnected ? g.target.getBoundingClientRect() : null));
    IN.fly = IN.fly.filter((g, i) => {
      if (rects[i] && t - g.t0 < g.dur) { flyAt(g, t, rects[i]); return true; }
      // landed, or its card left the grid (pushed out of the drawn part by more files): it has no place to fly to
      g.el.classList.remove('ghost');
      g.f.remove();
      if (rects[i] && g.thud) { haptic('thud'); if (g.look) landFx(g.look, rects[i].left + rects[i].width / 2, rects[i].top + rects[i].height / 2); }
      else if (rects[i]) haptic('soft');
      // (another phone flicked it: it hears it landed, a thud in its user's hand)
      if (g.peer && rects[i]) nc('peerLanded', g.fid);
      landed(g.fid);
      return false;
    });
    if (IN.fly.length) IN.flyRaf = requestAnimationFrame(flyFrame);
  }
  // its card is in the grid now: a download that finished meanwhile shows
  function landed(fid) {
    IN.wait.delete(fid);
    const e = IN.got.get(fid);
    if (e) { IN.got.delete(fid); onDownDone(e); }
  }

  function onDown(e) {
    const it = IN.cards.get(e.fid);
    if (it && e.total) { it.got = e.got / e.total; setCardProgress(it.id, it.got); }
  }
  // downloads that finished show together, once a frame (a batch finishing laid the grid out again for each file)
  function onDownDone(e) {
    if (IN.wait.has(e.fid)) { IN.got.set(e.fid, e); return; }    // its card hasn't landed yet (see landed)
    IN.done.push(e);
    if (!IN.doneRaf) { IN.doneRaf = requestAnimationFrame(downDone); IN.doneT = setTimeout(downDone, 100); }
  }
  // another phone's name, as text without direction controls (it can't turn the words around it backwards)
  const plainName = (s) => String(s == null ? '' : s).replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '').trim();
  // A file of a batch that couldn't be received is said, and a file of the same batch that lands while that's shown
  // joins it ("Received 3 items · photo.jpg changed on the PC. Send it again.") rather than replacing it: the user
  // learns which one to send again. (The toast is read out on its own; one that joins another already showing is said
  // to a screen reader by itself as well, so it isn't lost in the words read again.)
  function failToast(msg, ms) {
    const joins = IN.failUntil > now();
    IN.failMsg = joins ? IN.failMsg + ' · ' + msg : msg;
    IN.failUntil = now() + ms;
    toast(IN.failMsg, ms);
    if (joins) sayQuietly(msg);
  }
  function okToast(msg, ms) {
    const fail = IN.failUntil > now() ? IN.failMsg : '';
    if (!fail) { toast(msg, ms); return; }
    ms = Math.max(ms, IN.failUntil - now() + 1200);
    IN.failUntil = now() + ms;
    toast(typeof msg === 'function' ? () => msg() + ' · ' + fail : msg + ' · ' + fail, ms);
  }
  function downDone() {
    cancelAnimationFrame(IN.doneRaf); clearTimeout(IN.doneT); IN.doneRaf = 0;
    const shown = [];
    let gone = false, bad = false, saved = false, ids = null;
    for (const e of IN.done.splice(0)) {
      const idx = V.items.findIndex((x) => x.fid === e.fid);
      const name = (st.incoming && st.incoming.get(e.fid)) || (idx >= 0 ? V.items[idx].name : 'a file');
      if (st.incoming) st.incoming.delete(e.fid);
      if (st.peerIn) st.peerIn.delete(e.fid);
      IN.cards.delete(e.fid);
      // what arrived: one file (from the PC), or what another phone sent (e.items: files, a folder; none when it went
      // where the view doesn't show it, e.where)
      const reals = Array.isArray(e.items) ? e.items.filter((x) => x && x.id) : e.item ? [e.item] : [];
      if (!e.ok || (!reals.length && !e.where)) {
        if (idx >= 0) { V.items.splice(idx, 1); V.total--; gone = true; }
        // (even when the user has moved to another view)
        // (stopped: its Cancel here, in the notification or Settings; a file from the PC: the PC says Canceled too)
        if (e.why === 'stopped' && !e.peer) wsSend({ t: 'incoming-stopped', fid: e.fid });
        // (changed: saved again on the PC while it came, so what arrived was a mix of two versions: the app dropped it;
        // the PC is told, so its row can say so: one from before ignores it)
        if (e.why === 'changed' && !e.peer) wsSend({ t: 'incoming-failed', fid: e.fid, why: 'changed' });
        // (closed: Flick was closed there in the middle of it, which the app says with its 'canceled')
        if (e.why === 'canceled' && e.closed) toast('Flick was closed on ' + (plainName(e.from) || 'the other phone') + ' before ' + midName(name) + ' arrived', 3000);
        else if (e.why === 'canceled' || e.why === 'stopped') toast(e.why === 'canceled' ? (plainName(e.from) || 'The other phone') + ' stopped sending ' + midName(name) : 'Stopped receiving ' + midName(name), 2600);
        else failToast(e.why === 'changed' && !e.peer ? midName(name) + ' changed on the PC. Send it again.' : 'Couldn’t receive ' + midName(name), e.why === 'changed' ? 3400 : 2600);
        bad = true;
        continue;
      }
      if (!e.peer) wsSend({ t: 'incoming-done', fid: e.fid });
      if (!reals.length) {
        if (idx >= 0) { V.items.splice(idx, 1); V.total--; gone = true; }
        okToast('Saved to ' + String(e.where).split('/').join(' › '), 2400);
        continue;
      }
      if (idx < 0) {
        // (its card isn't in this view: the user is in a folder or another tab, or searching) a file from the PC kept in
        // the Flick list comes into the Flick tab when that's open; anything else that arrived is said
        const kept = !e.peer && V.cat === 'shelf' && reals.every((r) => !(r.path && /\/Download\/Flick\//.test(r.path)));
        if (kept) {
          ids = ids || new Set(V.items.map((x) => x.id));
          for (const real of reals) {
            if (!ids.has(real.id)) { V.items.unshift(real); V.total++; ids.add(real.id); }
            shown.push(real);
          }
          continue;
        }
        // (the words are made inside the toast: a number formatted now would ready ICU before the first frame)
        const n1 = reals.length, name1 = midName(reals[0].name);
        if (e.peer) { okToast(() => 'Received ' + (n1 === 1 ? name1 : fmtNum(n1) + ' items') + (plainName(e.from) ? ' from ' + plainName(e.from) : ''), 2400); continue; }
        // (a batch from the PC arrives in a few goes: counted together, as its "is sending" was)
        const fresh = !(IN.gotAt && now() - IN.gotAt < 3000);
        IN.got1 = (fresh ? 0 : IN.got1) + reals.length; IN.gotAt = now();
        IN.gotDl = (fresh ? false : IN.gotDl) || reals.some((r) => r.path && /\/Download\/Flick\//.test(r.path));
        const got = IN.got1, dl = IN.gotDl;
        okToast(() => 'Received ' + (got === 1 ? name1 : fmtNum(got) + ' items') + (dl ? ' in Downloads › Flick' : ''), 2400);
        continue;
      }
      const el = cards.get(V.items[idx].id);
      cards.delete(V.items[idx].id);
      if (el) el.remove();
      ids = ids || new Set(V.items.map((x) => x.id));             // (the view may show the file already)
      V.items.splice(idx, 1);
      let at = idx;
      for (const real of reals) {
        if (ids.has(real.id)) { shown.push(real); continue; }        // (it lights up where it is)
        V.items.splice(at++, 0, real);
        ids.add(real.id);
        shown.push(real);
        if (real.path && /\/Download\/Flick\//.test(real.path)) saved = true;
      }
      V.total += at - idx - 1;
      if (at === idx) gone = true;
    }
    if (gone || shown.length) layout(gone);
    for (const real of shown) {
      const nel = cards.get(real.id);
      if (nel) nel.animate([{ filter: 'brightness(1.6)' }, { filter: 'brightness(1)' }], { duration: 420, easing: 'ease-out' });
    }
    if (saved) okToast('Saved to Downloads › Flick', 1600);
    // one buzz, not one per file
    if (bad) haptic('reject');
    else if (shown.length && now() - IN.tickAt > 300) { IN.tickAt = now(); haptic('tick'); }
  }

  // ------------------------------------------------------------------ native events
  window.__native = function (ev) {
    let e = ev;
    if (typeof ev === 'string') { try { e = JSON.parse(ev); } catch (x) { return; } }
    runHooks('native', e);                   // the features see Android's events too
    switch (e.t) {
      case 'res': { const r = pendingReq.get(e.req); if (r) { pendingReq.delete(e.req); r(e.data); } break; }
      case 'pcs':
        st.lanList = (e.list || []).filter(Boolean);
        // (names as text without direction controls from here on: the screen's lines, sheets, sentences, Settings)
        for (const p of st.lanList) p.name = cleanName(p.name) || 'PC';
        if (st.pc && st.lanList.some((p) => p.id === st.pc.id)) st.lanSeenAt = Date.now();
        onPcs();
        if (USB.cable) usbRender();
        break;
      case 'bt': onBt(e); break;
      case 'usb': onUsb(e); break;
      case 'tunnel':                               // another phone over a cable or Bluetooth (Tunnel.java)
        if (e.via === 'usb') {
          if (e.on) { usbPeer.id = e.id; usbPeer.name = e.name || ''; usbUi.off = false; usbUi.readyAt = 0; }
          else if (usbPeer.id === e.id) { usbPeer.id = ''; usbUi.readyAt = 0; }
          usbRender();
        }
        break;
      case 'bt-perm': btTick(); if (!$('settings').hidden) renderSettings(); break;
      case 'ble-perm': {
        // allowed (or not) to find devices over Bluetooth, Bluetooth or Location turned on or off: on the Connect screen,
        // what now. (Only when that changed: Location comes and goes on every Android, and only 10 and 11 need it)
        const b = njson('bleState') || {}, k = bleKeyOf(b);
        if (k === bleKey) break;
        bleKey = k;
        // (over advice only: it replaced the code being checked, its Same code and Different code with it, the code
        // with its Cancel, "Connecting to…", or why the PC can't be connected to)
        if (st.screen === 'pair' && CN.phase === 'idle' && !HOME.device && (!hintHtml || hintHtml === hintSoft)) {
          pairHint(!b.permitted ? '' : !b.on ? 'Turn on Bluetooth, then hold Connect again.'
            : b.location === false ? 'Turn on Location to find phones over Bluetooth, then hold Connect again.'
              : 'Hold Connect again: devices that aren’t on this Wi-Fi are found over Bluetooth too.');
          hintSoft = hintHtml;
        }
        break;
      }
      case 'pc-pair-end':                          // a PC's request allowed here ended there without its pairing
        if (HOME.device && e.device === HOME.device) { if (cleanName(e.name)) HOME.name = cleanName(e.name); clearTimeout(HOME.t); homeFailed(); }
        break;
      case 'peer-ask':                             // (the question itself: phones.js)
        // the PC waited for asks again: that pairing is over there (Different code, or it gave up)
        if (HOME.device && e.device === HOME.device) { homeWait(null); if (st.screen === 'pair' && CN.phase === 'idle') pairHint(''); }
        break;
      case 'peers':                                // other phones nearby and paired (Peers.java)
        CN.peers = e.state || CN.peers;
        if (st.screen === 'pair') setPcName();
        onAskPeers();
        renderTarget();
        if (usbPeer.id) usbRender();               // (paired over the cable just now: ready)
        break;
      case 'peer-landed':                          // a card flicked to another phone landed on its screen
        if (flungPeer.has(e.id) && now() - flungPeer.get(e.id) < 10000 && !document.hidden) { flungPeer.delete(e.id); haptic('thud'); }
        break;
      case 'pc-paired': {
        // A PC whose user held Connect there asked this phone, and the user allowed it here: the app has kept its
        // pairing (Peers.homePaired) as one made from here; this phone connects to it now, as to the PC in use
        const pc = e.pc;
        if (!pc || typeof pc.id !== 'string' || !pc.ip || !(+pc.port > 0)) break;
        // (confirmed there: no longer waited for)
        if (HOME.device && HOME.device === pc.id) {
          homeWait(null);
          if (st.screen === 'pair' && CN.phase === 'idle') pairHint('Connecting to ' + nameHtml(pc.name, 'the computer') + '…');
        }
        const seen = (st.lanList || []).find((p) => p.id === pc.id);
        rememberPc({ id: pc.id, name: cleanName(pc.name) || 'PC', ip: pc.ip, port: +pc.port }, Array.isArray(pc.addrs) ? pc.addrs : []);
        closeLink();
        st.noAuto = false; st.replaced = false;
        choosePc(seen ? Object.assign({}, seen, { tls: 1 }) : { id: pc.id, name: cleanName(pc.name) || 'PC', ip: pc.ip, port: +pc.port, tls: 1, v: +pc.v || 8 });
        st.connectWanted = now();                    // (connected once signed in: 'welcome')
        haptic('confirm');
        break;
      }
      case 'added':
        // (picked for something, e.tag: the feature that asked says what happens to them)
        if (e.items && e.items.length && !e.tag) toast(e.items.length === 1 ? 'Added ' + midName(e.items[0].name) + ' to Flick' : 'Added ' + e.items.length + ' files to Flick', 1600);
        // (picked to send to a phone: the view stays where the user is; the Flick list has them if it's showing)
        if (!e.tag) addToShelf(e.items); else if (V.cat === 'shelf' && !SEL.on) addToShelf(e.items);
        if (st.screen === 'pair' && !st.pc && !e.tag) showScreen('main');
        break;
      case 'up': onUp(e); break;
      case 'up-done': onUpDone(e); break;
      case 'job': onJob(e.job); break;
      case 'down': onDown(e); break;
      case 'down-done': onDownDone(e); break;
      case 'insets': applyInsets(e.top, e.bottom); break;
      case 'font': onZoom(); break;                // (Android's font size changed: the probe says it too)
      case 'saved': onSavedCopy(e); break;
      case 'toast': if (e.msg) toast(String(e.msg), 2600); break;
      case 'upd': case 'upd-done': case 'upd-installing': case 'upd-perm': case 'upd-perm-denied': case 'upd-back': case 'upd-fail':
        onUpdEvent(e); break;
      case 'gh': onGitHub(e); break;
      case 'storage': refreshStorage(false); break;
      case 'resume':
        whenF = {};                                  // (a language changed meanwhile: see fmtWhen)
        nc('discover', true);
        peerScanFor('connect', st.screen === 'pair');
        refreshStorage(false);
        if (Date.now() - UPD.ghAt > 3600e3) checkGitHub(false);
        if (st.pc && !st.wsOpen && !st.connecting) openLink(st.trusted);
        else if (st.wsOpen) checkLink();
        break;
      case 'pause': nc('discover', false); peerScanFor('connect', false); break;
      default: break;
    }
  };
  window.__back = function () {
    if (runHooks('backTop')) return true;    // overlays above everything (the ringing screen, the walkthrough)
    if (!$('ask').hidden) { askClose(); return true; }
    if (sheetOpen) { closeSheet(); return true; }
    if (runHooks('back')) return true;       // feature pages and overlays
    if (settingsBack()) return true;
    if (D && D.phase === 'drag') { dragEnd(); return true; }
    if (SEL.on) { setSelecting(false); return true; }
    if (SRCH.on && st.screen === 'main') { endSearch(); return true; }
    if (st.screen === 'main' && V.cat === 'dir' && V.stack.length) { goBack(); return true; }
    // The Connect screen opened over the files (connected, for a new device, or with phones to send to): back to them, the
    // asking canceled (it left Flick). With nothing to send to, the files lead back to it, and it out of Flick.
    const files = st.connected || CN.newDev || pairedPhones().length > 0;
    if (st.screen === 'pair' && files) { if (CN.phase === 'asking') connectCancel(); showScreen('main'); return true; }
    if (st.screen === 'main' && !files) { showScreen('pair'); return true; }
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
    if (it.incoming) return 'Receiving…';
    if (it.dir) return (it.count === 1 ? '1 item' : (it.count || 0) + ' items') + ' · ' + when;
    return fmtSize(it.size) + ' · ' + when + ' · ' + rowType(it);
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
  function catPage(offset, n) {
    if (!nativeSort()) return nreqT(120000, 'queryAsync', V.cat, offset, n || PAGE);
    const s = sortOf();
    return nreqT(120000, 'querySorted', V.cat, offset, n || PAGE, s.key + '-' + s.dir, SRCH.on ? SRCH.q : '');
  }
  // the category again from its first page (another order, another search), same tab
  function requery() {
    V.gen++;
    if (SEL.on) selNone();
    for (const [, el] of cards) el.remove();
    cards.clear();
    V.items = []; V.offset = 0; V.total = 0; V.more = false; V.loading = false; V.failed = ''; V.retryAt = 0; V.failN = 0; V.loadP = null;
    scroller.scrollTop = 0;
    $('empty').hidden = true;
    if (!SRCH.q) keepIncoming();
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
          rove(box);
          setTimeout(() => { closeSheet(); setSort(key, dir); }, 160);
        };
        seg.appendChild(b);
      }
      row.appendChild(seg);
      box.appendChild(row);
    }
    rove(box);
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
    // (cards of files that came meanwhile go: those still coming are put back)
    const gone = s.items.filter((x) => x.incoming && !IN.cards.has(x.fid)).length;
    V.items = gone ? s.items.filter((x) => !x.incoming || IN.cards.has(x.fid)) : s.items;
    V.offset = s.offset; V.total = s.total - gone; V.more = s.more; V.loading = false; V.failed = ''; V.loadP = null;
    keepIncoming();
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
  sIn.dir = 'auto';                          // Hebrew or Arabic typed in reads right to left
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
      b.appendChild(Object.assign(document.createElement('span'), { textContent: p.name, dir: 'auto' }));
      b.classList.toggle('on', V.cat === 'dir' && V.rootCat === b.dataset.v);
      b.setAttribute('role', 'tab'); b.setAttribute('aria-selected', String(b.classList.contains('on')));
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
  function moreFiles() { if (V.more && !V.loading && V.cat !== 'dir' && V.cat !== 'shelf' && Date.now() >= V.retryAt) loadMore(); }
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
  //   flicked  the items of a card just flicked off the edge to the PC
  //   back     Android's back button (return true when handled); backTop: the same, before the menus and prompts
  //   menu     items for the ••• sheet (return one item or a list; tile: true puts one among the places at its top)
  //   settings the Settings page is being drawn (its body element; add sections to it: one marked data-simple stays
  //            in Settings itself, the others go to Advanced settings, see renderSettings)
  //   settings-end  the same, after the app's own sections
  //   pcTap    the PC button on the main screen (return true when handled)
  //   view     the file view changed (folder, category, loading)
  //   conn     connected or not
  //   preview  open a file full screen ({ item, rect }: rect = its card on screen, or null)
  //   itemMenu more entries for a file's or folder's menu (it: the item), after its "Send to" entry
  //   select   selecting started (true) or ended (false)
  //   selOther n files selected: the Send button's words when a feature sends them elsewhere, or nothing
  //   selSend  ...and its tap (the selected items; return true when handled)
  //   selKeep  nothing is selected any more: return true to go on selecting (see selNone)
  //   countTap the toolbar's count was tapped while sends are listed (return true when handled)
  function runHooks(name, a) {
    let r;
    for (const f of (runHooks.list && runHooks.list[name]) || []) {
      try { const x = f(a); if (r === undefined && x) r = x; } catch (err) { console.log('feature (' + name + ') failed: ' + err); }
    }
    return r;
  }
  function runHooksList(name, a) {
    const out = [];
    for (const f of (runHooks.list && runHooks.list[name]) || []) {
      try { const x = f(a); if (x) out.push.apply(out, Array.isArray(x) ? x : [x]); } catch (err) { console.log('feature (' + name + ') failed: ' + err); }
    }
    return out;
  }
  runHooks.list = {};
  const FlickApp = Object.freeze({
    on(name, fn) { if (typeof fn === 'function') (runHooks.list[name] = runHooks.list[name] || []).push(fn); },
    // live state, for reading (a change to settings is kept with saveSettings())
    st, V, settings, INFO, LINK_NAMES, icons: ICONS,
    get stg() { return STG; },
    get sheetOpen() { return sheetOpen; },
    // the Android bridge: has(name) tells whether this phone app has that method
    has: (name) => !!(NV && typeof NV[name] === 'function'),
    nc, njson, pref, saveSettings, haptic,
    // the link to the PC. linkAuthed: the PC proved itself on this link (signed in), connected or not
    wsSend, linkTrusted, linkAuthed: () => !!(st.wsOpen && st.trusted && st.pcProved && hasToken()),
    paired: (pcId) => !!pref.get(tokenKey(pcId), ''), rankOf, busyMoving, choosePc, closeLink, openLinkSoon, knownPcs,
    // Connect a new device (the Connect screen, for a device other than the paired PC), and looking for other phones
    // while a page shows them (who: the page's name); a PC's request allowed here, its user checking the code there
    connectNew, peerScanFor, homeWait, uncovered,
    // where flicks go now: { kind: 'pc' }, { kind: 'phone', id, name, nearby }, or null (nowhere yet)
    flickTarget, pairedPhones,
    // screens, sheets, toasts, formatting (a count: fmtNum, in a toast made by a function: see toast)
    toast, say: sayQuietly, openSheet, closeSheet, showScreen, openSettings, closeSettings, renderSettings, setEffects, rove,
    svgEl, rid, fmtSize, fmtWhen, fmtNum, midName,
    // the file browser, and sending to the PC
    openCat, showInFolder, sendItems, fmtRate,
    // the files the view shows (in its order), their thumbnails and cards: for the preview
    viewFiles, thumbUrl, cardRect, showItem, moreFiles, fmtDur,
    // Air grab: the file under a point, the selection, and a send in two steps (lift now, go or cancel later)
    itemAt, selected: selItems, selectToggle, airLift, airGo, airCancel, nativeThumb,
    get selecting() { return SEL.on; },
    endSelection: () => { if (SEL.on) setSelecting(false); },
    startSelection: () => { if (!SEL.on) setSelecting(true); },
    redrawSelection: () => { if (SEL.on) renderSelection(); },
    // a card for files arriving from another phone ({ fid, name, size, kind, folder, count }); 'down' and 'down-done'
    // events with its fid fill it in
    incomingCard,
  });
  window.FlickApp = FlickApp;
  const FEATURES = {};                      // what the feature files share among themselves (features/core.js)
  for (const start of window.FlickFeatures || []) {
    try { start(FlickApp, FEATURES); } catch (err) { console.log('a feature failed to start: ' + err); }
  }

  // ------------------------------------------------------------------ the USB cable
  // Plugged into a computer, Flick says so at once. With USB tethering on, a PC answers over the cable and files go over
  // it (the fastest link): "USB connected. Ready to transfer." Without it, one tap opens the switch (an app can't turn
  // it on itself). Closed with ×, it stays closed until the cable is plugged in again.
  const USB_ICON = '<svg viewBox="0 0 24 24"><path d="M12 21V5M9 7.5l3-4 3 4M12 16l-4.5-3V10M12 13.5l4.5-2.5V8.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><circle cx="12" cy="20" r="1.6" fill="currentColor"/></svg>';
  const USB_OK = '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  function usbOverCable() { return !!(st.connected && st.pc && st.pc.via === 'usb'); }
  function usbPcThere() { return (st.lanList || []).some((p) => p.via === 'usb' || (p.links || []).some((l) => l.via === 'usb')); }
  function usbPeerPaired() { return pairedPhones().some((d) => d.id === usbPeer.id); }
  function usbRender() {
    const bar = $('usbBar');
    let title = '', sub = '', go = '', ready = false;
    if (usbPeer.id && !usbUi.off) {
      // another phone on the cable: ready once they're paired (else: hold Connect, it's the one asked)
      const nm = cleanName(usbPeer.name) || 'the other phone';
      if (usbPeerPaired()) {
        if (!usbUi.readyAt) { usbUi.readyAt = now(); haptic('confirm'); clearTimeout(usbUi.t); usbUi.t = setTimeout(usbRender, 3700); }
        if (now() - usbUi.readyAt < 3500) { title = 'USB connected to ' + nm + '. Ready to transfer.'; ready = true; }
      } else { title = 'USB connected to ' + nm; sub = 'Hold Connect to connect'; }
    } else if (USB.cable && USB.phone && !usbUi.off) {
      title = 'USB connected'; sub = 'Connecting to the other phone…';
    } else if (USB.cable && !usbUi.off) {
      if (usbOverCable()) {
        // once per plug-in: said for a few seconds, then the connection button says it ("over USB cable")
        if (!usbUi.readyAt) { usbUi.readyAt = now(); haptic('confirm'); clearTimeout(usbUi.t); usbUi.t = setTimeout(usbRender, 3700); }
        if (now() - usbUi.readyAt < 3500) { title = 'USB connected. Ready to transfer.'; ready = true; }
      } else if (!USB.tether) {
        title = 'USB connected';
        sub = st.connected ? 'Turn on USB tethering for faster transfers over the cable' : 'Turn on USB tethering to send over the cable';
        go = 'Turn on';
      } else if (usbPcThere()) {
        const p = (st.lanList || []).find((x) => x.via === 'usb');
        title = 'USB connected';
        sub = p && pairedPc(p) ? 'Connecting to ' + cleanName(p.name) + ' over the cable…' : p ? 'Hold Connect to connect to ' + cleanName(p.name) : 'Connecting over the cable…';
      } else {
        if (!usbUi.lookAt) usbUi.lookAt = now();
        title = 'USB connected';
        sub = now() - usbUi.lookAt > 5000 ? 'Open Flick on your computer to send over the cable' : 'Looking for Flick on your computer…';
        if (now() - usbUi.lookAt <= 5000) { clearTimeout(usbUi.t); usbUi.t = setTimeout(usbRender, 5200 - (now() - usbUi.lookAt)); }
      }
    }
    const on = !!title, was = document.body.classList.contains('ubar');
    if (was !== on) document.body.classList.toggle('ubar', on);
    if (!on) { if (!bar.hidden) bar.hidden = true; if (was) measureHeader(); return; }
    const icon = ready ? 'ok' : 'usb';
    if (bar.dataset.icon !== icon) { bar.dataset.icon = icon; const ic = bar.querySelector('.ubic'); ic.textContent = ''; ic.appendChild(svgEl(ready ? USB_OK : USB_ICON)); }
    bar.classList.toggle('ready', ready);
    // (only what changed is written: the bar is a live region, and a screen reader said it again with every discovery
    // report, every 2 s)
    if ($('usbT').textContent !== title) $('usbT').textContent = title;
    if ($('usbS').textContent !== sub) $('usbS').textContent = sub;
    const g = $('usbGo');
    if (g.hidden !== !go) g.hidden = !go;
    if (g.textContent !== go) g.textContent = go;
    if ($('usbX').hidden !== ready) $('usbX').hidden = ready;
    if (bar.hidden) bar.hidden = false;
    // The file browser's header moves down under it (it covered the title, Search, Sort and the tabs until closed), and a
    // toast shows under it
    const bh = bar.offsetHeight;
    if (bh !== usbUi.h || !was) { usbUi.h = bh; root.setProperty('--ubh', bh + 'px'); measureHeader(); }
  }
  $('usbGo').onclick = () => {
    haptic('tick');
    if (nc('openTethering') === false) toast('Open Settings › Network › Hotspot & tethering, and turn on USB tethering', 4200);
  };
  $('usbX').onclick = () => { haptic('tick'); usbUi.off = true; usbRender(); };
  function onUsb(e) {
    const was = USB.cable;
    USB.cable = !!e.cable; USB.tether = !!e.tether; USB.phone = !!e.phone;
    if (!USB.cable || !was) { usbUi.off = false; usbUi.readyAt = 0; usbUi.lookAt = 0; }
    if (USB.tether && !usbOverCable()) usbUi.lookAt = 0;           // (looked for again: its network just came up)
    usbRender();
  }

  // ------------------------------------------------------------------ the text size (see readZoom)
  function applyZoom() {
    const g = Math.max(0, TZ - 1);
    // a card's caption (its name 13px, its size and date 11.5px) and a list row (15px and 12.5px) as tall as their text
    L.meta = 46 + Math.ceil(g * 32);
    LR.h = 64 + Math.ceil(g * 36);
    root.setProperty('--meta', L.meta + 'px');
    root.setProperty('--rowh', LR.h + 'px');
    // the largest headings grow half as much as the rest above 100% (the files' title was 52px at 200%)
    root.setProperty('--hz', String(Math.round((1 + g / 2) / Math.max(1, TZ) * 1000) / 1000));
    document.documentElement.classList.toggle('bigtext', TZ >= 1.25);
  }
  // changed while Flick is open: everything that was measured is measured again, the file at the top stays at the top
  function onZoom() {
    const z = readZoom();
    if (z === TZ) return;
    TZ = z;
    applyZoom();
    for (const [, el] of cards) el.remove();          // (their names are cut for the text size)
    cards.clear();
    measureHeader();
    const top = scroller.scrollTop, keep = top > 0 ? geo.find((it) => it._y + it._th > top) : null;
    layout(false);
    if (keep && geo.includes(keep)) { scroller.scrollTop = keep._y; renderWindow(false); }
    if (SEL.on) renderSelection();
  }
  applyZoom();
  if (window.ResizeObserver) {
    new ResizeObserver(onZoom).observe(fzp);
    // The bars over the files' bottom: the update card sits above the toolbar, and the files' last row scrolls up above
    // both, however tall their text makes them (app.css --tbh, --updh). Measured only as they change size.
    const bars = new ResizeObserver(() => {
      const tb = $('toolbar').offsetHeight, up = $('upd').offsetHeight;
      if (tb) root.setProperty('--tbh', tb + 'px');
      if (up) root.setProperty('--updh', up + 'px');
      measureHeader();                                // (the header too: selecting with large text puts Select all under the count)
    });
    bars.observe($('toolbar'));
    bars.observe($('upd'));
    bars.observe($('hdr'));
  }

  // ------------------------------------------------------------------ boot
  // A new width lays the grid out anew (turned sideways, unfolded, split screen): the file at the top stays at the top
  // (the same scroll position was other files, far from it). A new height only (the keyboard) moves nothing.
  let gridW = innerWidth;
  window.addEventListener('resize', () => {
    measureHeader();
    const top = scroller.scrollTop;
    const keep = innerWidth !== gridW && top > 0 ? geo.find((it) => it._y + it._th > top) : null;
    gridW = innerWidth;
    layout(false);
    if (keep && geo.includes(keep)) { scroller.scrollTop = keep._y; renderWindow(false); }
    wsSend({ t: 'screen', w: innerWidth, h: innerHeight, dpr: devicePixelRatio });
  });
  // Each step on its own: one that fails (something newer than the phone's WebView) leaves the rest to run, as the
  // cable's bar did to the sends, the PC remembered and the Connect screen's fallback
  const boot = (f) => { try { f(); } catch (e) { console.error('Flick start-up step failed: ' + (e && e.stack || e)); } };
  boot(() => {
    measureHeader();
    openCat(STG.granted ? (pref.get('lastView', 'recent') || 'recent') : 'recent');
  });
  boot(() => { CN.peers = njson('peerState'); });
  boot(setPcName);
  // A phone that connects to its PC by itself opens on its files, as index.html showed them before this ran (the
  // Connect screen showed until the PC answered, then flashed over to them)
  const bootFiles = document.documentElement.classList.contains('files');
  boot(() => showScreen(bootFiles ? 'main' : 'pair'));
  document.documentElement.classList.remove('files');
  boot(renderTarget);
  boot(usbRender);
  // sends the app is carrying on with (some may be from before Flick was opened)
  boot(() => {
    for (const j of njson('sendList') || []) if (j && j.tid) st.jobs.set(j.tid, j);
    updateCount();
  });
  // numbers once the first frame is on screen (see fmtNum): then the count, and a toast that waited for them
  requestAnimationFrame(() => setTimeout(() => { numFmt(); updateCount(); if (toastWait) toast(...toastWait); }, 0));
  // the PC used last is remembered with the rest (from before this memory existed)
  boot(() => {
    if (pref.get('lastPc', '') && pref.get('lastPcAddr', '') && !knownPcs()[pref.get('lastPc', '')]) {
      const a = pref.get('lastPcAddr', '').split(':');
      rememberPc({ id: pref.get('lastPc', ''), name: cleanName(pref.get('lastPcName', '')), ip: a[0], port: +a[1] || 47860 }, []);
    }
  });
  boot(tellKnown);
  boot(() => {
    const lastAddr = pref.get('lastPcAddr', '');
    const lastId = pref.get('lastPc', '');
    if (lastAddr && lastId) {
      const parts = lastAddr.split(':');
      // a PC whose certificate is pinned (or that last said so) takes encrypted links; discovery confirms either way
      const tls = pref.get(pinKey(lastId), '') || pref.get('lastPcTls', '') === '1' ? 1 : 0;
      st.pcs = [{ id: lastId, name: pref.get('lastPcName', 'your PC'), ip: parts[0], port: +parts[1], tls, v: tls ? 4 : 1 }];
      choosePc(st.pcs[0]);
    }
  });
  // ...and should its PC not answer for as long as Connect waits for one, the Connect screen shows after all, as when
  // Flick opened on it (not under someone already using the files)
  if (bootFiles) {
    st.bootT = setTimeout(() => {
      st.bootT = 0;
      if (st.connected || st.screen !== 'main' || pressedAt || assistAt || focusedAt || sheetOpen || covered()) return;
      showScreen('pair');
      // why, as the Connect screen said when Flick opened on it (another phone has the PC: it isn't asked again by
      // itself; its Flick is too old: asked again only every 20 s)
      if (st.replaced) pairHint('Another phone is connected to ' + nameHtml(st.pc && st.pc.name, 'your PC') + '. Hold to switch to this one.');
      else if (st.linkBlocked) linkProblem(st.linkBlocked);
    }, 10000);
  }
  // (not over what holding Connect said meanwhile, nor with a paired phone right there)
  setTimeout(() => { if (!st.pc && !CN.near.length && CN.phase === 'idle' && st.screen === 'pair' && !$('pairHint').textContent && !pairedPhones().some((d) => d.nearby)) { pairHint('Make sure Flick is open on the other device, and both are on the <b>same Wi-Fi</b>.'); hintSoft = hintHtml; } }, 4500);
})();
