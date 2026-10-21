'use strict';
// Share with a browser: an iPhone, iPad, Mac or any other device on the same network sends and receives files in its
// web browser, with no app. The PC shows a QR code for http://<LAN IP>:<port>/w/<token>; the page asks to join and the
// user allows each browser on the PC.
//
// Browsers don't trust Flick's own certificate, so this is plain HTTP. What keeps it safe:
//  - a fresh 128-bit token per share in every path (/w/<token>/...); a wrong token, or sharing off, is a plain 404
//  - nothing works until the user allows that browser on the PC; prompts are rate-limited like phone pairing
//  - an allowed browser gets a random session id that travels in a header (X-Flick-Session), never in a cookie, so
//    other web pages can't make the browser use it; download links carry a separate random key tied to the session
//  - only same-origin requests to an IP-literal Host are served (no cross-site use, no DNS rebinding), never framed
//  - stopping the share, or 30 minutes without browser activity, ends the token and every session at once
// Everything lives under /w/ and nothing here reaches the phone's API (server.js hands /w/ to handle() first).
const fs = require('fs');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const LIMITS = {
  idleMs: 30 * 60000,      // sharing stops after this long without browser activity
  sessions: 20,            // browsers per share (allowed, waiting or turned away)
  prompts: 6,              // "Let ... send and receive files?" prompts per minute
  coolMs: 20000,           // after "Don't allow", that address waits this long before it can ask again
  askMs: 120000,           // an unanswered prompt goes away after this
  goneMs: 60000,           // a waiting browser that stopped asking for news has left (a locked phone stops asking)
  awayMs: 40000,           // an allowed browser not heard from for this long shows as away
  keepMs: 60000,           // how long a turned-away or ended browser can still learn what happened
  uploadsPerSession: 3,    // uploads at once from one browser
  uploadsTotal: 12,        // ... and from all of them
  pollMs: 25000,           // a request for news waits this long for some
  stallMs: 60000,          // an upload with no bytes arriving for this long is dropped
  dlStallMs: 120000,       // a download that isn't read for this long is dropped
  groupQuietMs: 8000,      // a batch whose remaining files never came is wrapped up after this
  files: 200,              // files shared with browsers
  texts: 30,               // notes kept for the panel
  textLen: 5000,
};

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; " +
    "connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',             // the token is in the URL
  'Cache-Control': 'no-store',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Resource-Policy': 'same-origin',
  // (no Cross-Origin-Opener-Policy: browsers ignore it, with a console error, on a plain-HTTP LAN address)
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

// What a person sees opening a link that no longer works (sharing stopped, or a mistyped address): still a 404,
// with no script and nothing from the share, just plain words. Its one inline style is allowed by its hash.
const GONE_CSS = 'body{margin:0;min-height:100vh;display:grid;place-items:center;background:#000;color:#fff;font:16px/1.5 system-ui,-apple-system,' +
  'Segoe UI,Roboto,sans-serif;-webkit-text-size-adjust:100%}main{max-width:420px;padding:32px 24px;text-align:center}h1{margin:0;font-size:24px;' +
  'letter-spacing:-.02em}p{margin:10px 0 0;color:#8e8e93}@media (prefers-color-scheme:light){body{background:#f2f2f7;color:#000}p{color:#6e6e73}}';
const GONE_HTML = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
  '<meta name="color-scheme" content="dark light"><meta name="referrer" content="no-referrer"><title>Flick</title><style>' + GONE_CSS + '</style></head>' +
  '<body><main><h1>This link doesn’t work</h1><p>Sharing has ended, or the address isn’t complete. To connect, open Flick on the PC, ' +
  'choose Share with a browser and scan the new code.</p></main></body></html>';
const GONE_CSP = "default-src 'none'; style-src 'sha256-" + crypto.createHash('sha256').update(GONE_CSS).digest('base64') + "'; base-uri 'none'; " +
  "form-action 'none'; frame-ancestors 'none'";

// types for downloads; anything a browser could run or render as a page (html, svg, xml, js) is just bytes
const DL_TYPES = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', heic: 'image/heic', heif: 'image/heif',
  bmp: 'image/bmp', mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', aac: 'audio/aac', flac: 'audio/flac', ogg: 'audio/ogg',
  pdf: 'application/pdf', zip: 'application/zip', txt: 'text/plain; charset=utf-8', csv: 'text/csv; charset=utf-8',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

const key = (bytes) => crypto.randomBytes(bytes).toString('base64url');
const TOKEN_RE = /^[A-Za-z0-9_-]{22}$/;

/** A short name for the device a browser runs on, from its User-Agent ("iPhone", "Mac", ...). */
function deviceName(ua, touch) {
  ua = String(ua || '');
  if (/iPhone|iPod/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Macintosh|Mac OS X/.test(ua)) return +touch > 1 ? 'iPad' : 'Mac';     // iPadOS Safari says "Macintosh"
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? 'Android phone' : 'Android tablet';
  if (/CrOS/.test(ua)) return 'Chromebook';
  if (/Windows/.test(ua)) return 'Windows PC';
  if (/Linux|X11/.test(ua)) return 'Linux PC';
  return 'A browser';
}

/** The addresses a browser can use, best first (a real Wi-Fi or Ethernet adapter before VMs, WSL, VPNs), labeled. */
function shareAddresses(list) {
  const virt = /vethernet|virtual|vmware|vbox|hyper-v|docker|wsl|loopback|tailscale|zerotier|vpn|\btap|\btun|utun|^br-|^veth|npcap/i;
  const label = (a) => {
    const n = String(a.iface || '');
    if (/^local area connection\*/i.test(n) || /^192\.168\.137\./.test(a.address)) return 'Hotspot';
    if (/wi-?fi|wlan|wireless|^wl/i.test(n)) return 'Wi-Fi';
    if (/^ethernet( \d+)?$|^eth\d|^en[ops]?\d/i.test(n)) return 'Ethernet';
    return n || 'Network';
  };
  return (list || []).map((a, i) => ({ address: a.address, iface: a.iface, label: label(a), i, v: virt.test(a.iface || '') ? 1 : 0 }))
    .sort((a, b) => a.v - b.v || a.i - b.i)
    .map(({ address, iface, label: l }) => ({ address, iface, label: l }));
}

// RFC 6266 / 5987: an ASCII fallback plus the exact UTF-8 name
function contentDisposition(name) {
  const clean = String(name || 'file').replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, '_') || 'file';
  const ascii = clean.replace(/[^\x20-\x7e]/g, '_').replace(/["\\%;]/g, '_');
  const star = encodeURIComponent(clean).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return 'attachment; filename="' + ascii + '"; filename*=UTF-8\'\'' + star;
}

class WebShare extends EventEmitter {
  /**
   * opts.server: the FlickServer (its port, name, tmpDir and free-space check are used)
   * opts.save(tmpPath, name, info): moves a received file into place the way phone uploads are saved and resolves
   *   to { name, path, where }; required for uploads
   * opts.where(): the label of the folder files are saved to ("Desktop"), shown on the page
   * opts.limits: overrides for LIMITS (tests: idleMs etc.)
   */
  constructor(opts) {
    super();
    this.server = opts.server;
    this.save = opts.save || null;
    this.where = opts.where || (() => '');
    this.webDir = opts.webDir || path.join(__dirname, 'web');
    this.assetDir = opts.assetDir || path.join(__dirname, 'assets');
    this.limits = Object.assign({}, LIMITS, opts.limits || {});
    this.token = null;
    this.endedWhy = '';
    this.sessions = new Map();   // session id -> browser (see _join)
    this.pendingBytes = 0;       // what uploads in progress have yet to write (counted against free space)
    this.byId = new Map();       // public id (what the panel sees) -> browser
    this.byDl = new Map();       // download key -> browser
    this.files = new Map();      // file id -> a file shared with browsers
    this.texts = [];             // notes and links browsers sent, newest first
    this.groups = new Map();     // batch id -> files a browser sends together (one card flies in on the PC)
    this.asking = null;          // the browser the panel is asking about (one at a time)
    this.prompts = [];           // when recent prompts were shown
    this.cool = new Map();       // address -> until when it can't ask again
    this.uploading = 0;
    this.downloading = 0;
    this.cache = new Map();
  }

  get active() { return !!this.token; }

  // ---------------------------------------------------------------- the PC side
  start() {
    if (this.token) return;
    this.token = key(16);
    this.endedWhy = '';
    this.lastActive = Date.now();
    this._armIdle();
    this.sweepT = setInterval(() => this._sweep(), 2000);
    if (this.sweepT.unref) this.sweepT.unref();
    this.emit('log', 'sharing with browsers');
    this.emit('state');
  }

  /** Ends the token and every browser session right away. why: 'user' | 'idle' | ... */
  stop(why) {
    if (!this.token) return;
    this.token = null;
    this.endedWhy = why || 'user';
    clearTimeout(this.idleT); clearInterval(this.sweepT);
    for (const s of this.sessions.values()) this._end(s, 'ended');
    this.sessions.clear(); this.byId.clear(); this.byDl.clear();
    for (const f of this.files.values()) for (const r of f.streams) { try { r.destroy(); } catch (e) { /* ignore */ } }
    this.files.clear();
    this.texts = [];
    this.prompts = [];
    this.cool.clear();
    if (this.asking) { const a = this.asking; this.asking = null; this.emit('ask-done', { id: a.id }); }
    this.emit('log', 'stopped sharing with browsers' + (why === 'idle' ? ' (no activity)' : ''));
    this.emit('state');
  }

  /** http://<address>:<port>/w/<token> for the QR code, or '' when not sharing */
  urlFor(address) {
    if (!this.token || !address) return '';
    const host = String(address).includes(':') ? '[' + address + ']' : String(address);
    return 'http://' + host + ':' + this.server.port + '/w/' + this.token;
  }

  allow(id) {
    const s = this.byId.get(id);
    if (!s || s.state !== 'pending') return false;
    s.state = 'ok';
    this._doneAsking(s);
    this._touch();
    this.emit('log', 'allowed a browser: ' + s.device + ' at ' + s.address);
    this._changed(s);
    this.emit('state');
    return true;
  }

  deny(id) {
    const s = this.byId.get(id);
    if (!s || s.state !== 'pending') return false;
    const now = Date.now();
    for (const [a, until] of this.cool) if (until < now) this.cool.delete(a);
    this.cool.set(s.address, now + this.limits.coolMs);
    this._doneAsking(s);
    this.emit('log', 'did not allow a browser: ' + s.device + ' at ' + s.address);
    this._end(s, 'denied');
    this.emit('state');
    return true;
  }

  /** disconnect an allowed browser (it can ask again) */
  kick(id) {
    const s = this.byId.get(id);
    if (!s || s.state !== 'ok') return false;
    this._end(s, 'removed');
    this.emit('state');
    return true;
  }

  addFiles(paths) {
    let n = 0;
    for (const p of paths || []) {
      if (this.files.size >= this.limits.files) break;
      if (typeof p !== 'string' || !path.isAbsolute(p)) continue;
      let st;
      try { st = fs.statSync(p); } catch (e) { continue; }
      if (!st.isFile()) continue;
      if ([...this.files.values()].some((f) => f.path === p)) continue;
      const id = key(9);
      this.files.set(id, { id, path: p, name: path.basename(p), size: st.size, added: Date.now(), streams: new Set() });
      n++;
    }
    if (n) { this._touch(); this._filesChanged(); }
    return n;
  }

  removeFile(id) {
    const f = this.files.get(id);
    if (!f) return false;
    this.files.delete(id);
    for (const r of f.streams) { try { r.destroy(); } catch (e) { /* ignore */ } }
    this._filesChanged();
    return true;
  }

  removeText(id) { const n = this.texts.length; this.texts = this.texts.filter((t) => t.id !== id); if (n !== this.texts.length) this.emit('state'); }

  /** for the panel: who joined (without their keys) */
  browsers() {
    const now = Date.now();
    return [...this.sessions.values()].filter((s) => s.state === 'ok' || s.state === 'pending' || s.state === 'denied').map((s) => ({
      id: s.id, device: s.device, address: s.address, state: s.state, since: s.created,
      away: s.state === 'ok' && !s.waiters.size && now - s.seen > this.limits.awayMs, sending: s.uploads.size, getting: s.downloads.size,
    }));
  }

  sharedFiles() { return [...this.files.values()].map((f) => ({ id: f.id, name: f.name, size: f.size })); }

  /** the share should not be cut off (an app update restart waits) */
  busy() { return this.active; }

  // ---------------------------------------------------------------- requests
  /**
   * server.js calls this before anything else. Returns true when the request was answered here: everything under /w/,
   * and any request a page from this server (ours) makes to the phone's API, which it has no business using.
   */
  handle(req, res, u) {
    const p = u.pathname;
    if (p !== '/w' && !p.startsWith('/w/')) {
      if (req.headers['sec-fetch-site'] === 'same-origin') { this._plain(res, 403); return true; }
      return false;
    }
    try { this._route(req, res, u); } catch (e) {
      this.emit('log', 'browser request failed: ' + e.message);
      try { if (!res.headersSent) this._plain(res, 500); else res.destroy(); } catch (x) { /* ignore */ }
    }
    return true;
  }

  _route(req, res, u) {
    if (!this.token) return this._notFound(req, res);
    if (!this._hostOk(req)) return this._plain(res, 403);
    const m = /^\/w\/([^/]*)(\/.*)?$/.exec(u.pathname);
    if (!m || !this._tokenOk(m[1])) return this._notFound(req, res);
    if (req.method === 'OPTIONS') return this._plain(res, 403);   // never any cross-origin access
    const rest = m[2] || '';
    const site = req.headers['sec-fetch-site'];
    const sameOrigin = !site || site === 'same-origin';
    const get = req.method === 'GET' || req.method === 'HEAD';

    if (rest === '' || rest === '/') {
      // the page itself: a top-level visit from anywhere (a QR scan, a typed or pasted link), never inside a frame
      const dest = req.headers['sec-fetch-dest'];
      if (dest && dest !== 'document') return this._plain(res, 403);
      if (!get) return this._plain(res, 405);
      return this._page(req, res);
    }
    if (rest.startsWith('/dl/')) {
      // a download link: the user taps it on the page, or opens it in a new tab
      if (!(sameOrigin || site === 'none')) return this._plain(res, 403);
      if (!get) return this._plain(res, 405);
      const d = /^\/dl\/([A-Za-z0-9_-]{22})\/([A-Za-z0-9_-]{12})(?:\/[^/]*)?$/.exec(rest);
      if (!d) return this._plain(res, 404);
      return this._download(req, res, d[1], d[2]);
    }
    if (!sameOrigin) return this._plain(res, 403);
    const ASSETS = { '/web.js': 1, '/web.css': 1, '/inter.woff2': 1, '/icon.png': 1 };
    if (ASSETS[rest]) { if (!get) return this._plain(res, 405); return this._asset(req, res, rest.slice(1)); }
    if (!rest.startsWith('/api/')) return this._plain(res, 404);

    const api = rest.slice(5);
    if (api === 'join') { if (req.method !== 'POST') return this._plain(res, 405); return this._join(req, res); }
    const s = this._session(req);
    if (api === 'poll') {
      if (req.method !== 'GET') return this._plain(res, 405);
      if (!s) return this._json(res, 403, { state: 'gone' });
      return this._poll(req, res, s, u.searchParams);
    }
    // everything else needs a browser the user allowed
    if (!s || s.state !== 'ok') return this._refuse(req, res, 403, { ok: false, error: s ? s.state : 'gone' });
    s.seen = Date.now();
    if (req.method !== 'POST') return this._plain(res, 405);
    if (api === 'batch') return this._batch(req, res, s);
    if (api === 'upload') return this._upload(req, res, s, u.searchParams);
    if (api === 'text') return this._text(req, res, s);
    return this._refuse(req, res, 404, { ok: false });
  }

  // Same-origin only, to an IP-literal Host: a page on another site can't use this, and neither can one that rebinds
  // its own DNS name to this PC. A paired phone's Bluetooth link is never a browser.
  _hostOk(req) {
    if (req.socket && req.socket.remoteFamily === 'bluetooth') return false;
    const host = String(req.headers.host || '').trim().toLowerCase();
    let m = /^\[([0-9a-f:.]+)\](?::(\d{1,5}))?$/.exec(host);
    const ok = m ? net.isIPv6(m[1]) : ((m = /^(\d{1,3}(?:\.\d{1,3}){3})(?::(\d{1,5}))?$/.exec(host)) && net.isIPv4(m[1]));
    if (!ok) return false;
    const origin = req.headers.origin;
    if (origin === undefined) return true;
    const scheme = req.socket && req.socket.encrypted ? 'https' : 'http';
    const strip = (h) => h.replace(scheme === 'https' ? /:443$/ : /:80$/, '');
    return String(origin).toLowerCase() === scheme + '://' + strip(host);
  }

  _tokenOk(t) {
    if (!this.token || !TOKEN_RE.test(t || '')) return false;
    return crypto.timingSafeEqual(Buffer.from(t), Buffer.from(this.token));
  }

  // A session only works from the address the user allowed: on plain HTTP someone on the same Wi-Fi could read the
  // session id off the air, and this way it is useless to them from another device.
  _session(req) {
    const sid = req.headers['x-flick-session'];
    if (typeof sid !== 'string' || !TOKEN_RE.test(sid)) return null;
    const s = this.sessions.get(sid);
    return s && s.address === this._addr(req) ? s : null;
  }

  _addr(req) { return String((req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/, ''); }

  _headers(extra) { return Object.assign({}, SECURITY_HEADERS, extra || {}); }

  _plain(res, code) {
    if (res.headersSent) { res.destroy(); return; }
    res.writeHead(code, this._headers(Object.assign({ 'Content-Type': 'text/plain; charset=utf-8' }, this._early(res))));
    res.end(code === 404 ? 'Not found' : code === 403 ? 'Not allowed' : '');
  }

  // An answer sent before the request's body was read (a refused upload, say): the connection closes right after it
  // instead of reading everything the browser still sends (the timer is a backstop). The page asks about free space
  // before it uploads (see _batch), so it doesn't depend on reading such an answer mid-upload.
  _early(res) {
    const req = res.req;
    if (!req || req.complete || req.readableEnded) return null;
    req.resume();
    const t = setTimeout(() => { try { req.destroy(); } catch (e) { /* ignore */ } }, 3000);
    if (t.unref) t.unref();
    req.once('end', () => clearTimeout(t));
    return { Connection: 'close' };
  }

  // a person opening a dead link gets a few words; anything else gets a bare 404
  _notFound(req, res) {
    const dest = req.headers['sec-fetch-dest'];
    const page = req.method === 'GET' && (dest ? dest === 'document' : /text\/html/.test(req.headers.accept || ''));
    if (!page) return this._plain(res, 404);
    const body = Buffer.from(GONE_HTML);
    res.writeHead(404, this._headers({ 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': body.length, 'Content-Security-Policy': GONE_CSP }));
    res.end(body);
  }

  _json(res, code, obj) {
    if (res.headersSent || res.destroyed) return;
    const body = JSON.stringify(obj);
    res.writeHead(code, this._headers(Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) }, this._early(res))));
    res.end(body);
  }

  // answer a request whose body hasn't been read (an upload that can't be taken); see _early
  _refuse(req, res, code, obj) { this._json(res, code, obj); }

  _body(req, max) {
    return new Promise((resolve) => {
      const len = parseInt(req.headers['content-length'] || '0', 10);
      if (len > max) return resolve(undefined);
      const chunks = [];
      let n = 0, over = false;
      req.on('data', (c) => { if (over) return; n += c.length; if (n > max) { over = true; return resolve(undefined); } chunks.push(c); });
      req.on('end', () => {
        if (over) return;
        try { const o = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); resolve(o && typeof o === 'object' ? o : null); } catch (e) { resolve(null); }
      });
      req.on('error', () => resolve(null));
    });
  }

  _read(file) {
    let b = this.cache.get(file);
    if (!b) { b = fs.readFileSync(file); this.cache.set(file, b); }
    return b;
  }

  _send(req, res, body, type) {
    res.writeHead(200, this._headers({ 'Content-Type': type, 'Content-Length': body.length }));
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  _page(req, res) {
    const html = this._read(path.join(this.webDir, 'index.html')).toString('utf8').replace(/__BASE__/g, '/w/' + this.token + '/');
    this._send(req, res, Buffer.from(html), 'text/html; charset=utf-8');
  }

  _asset(req, res, name) {
    const files = {
      'web.js': [path.join(this.webDir, 'web.js'), 'text/javascript; charset=utf-8'],
      'web.css': [path.join(this.webDir, 'web.css'), 'text/css; charset=utf-8'],
      'inter.woff2': [path.join(this.assetDir, 'fonts', 'InterVariable.woff2'), 'font/woff2'],
      'icon.png': [path.join(this.assetDir, 'icon.png'), 'image/png'],
    };
    const [file, type] = files[name];
    let body;
    try { body = this._read(file); } catch (e) { return this._plain(res, 404); }
    this._send(req, res, body, type);
  }

  _touch() { this.lastActive = Date.now(); }

  // the panel's list says who is sending or downloading: tell it, at most a few times a second
  _stateSoon() {
    if (this.stateT) return;
    this.stateT = setTimeout(() => { this.stateT = null; this.emit('state'); }, 250);
    if (this.stateT.unref) this.stateT.unref();
  }

  // 30 minutes without a browser doing anything (an upload or download in progress counts) ends the share
  _armIdle() {
    clearTimeout(this.idleT);
    const wait = Math.max(20, this.lastActive + this.limits.idleMs - Date.now());
    this.idleT = setTimeout(() => {
      if (!this.token) return;
      if (this.uploading > 0 || this.downloading > 0) this._touch();
      if (Date.now() - this.lastActive >= this.limits.idleMs) return this.stop('idle');
      this._armIdle();
    }, wait);
    if (this.idleT.unref) this.idleT.unref();
  }

  // ---------------------------------------------------------------- joining
  async _join(req, res) {
    const body = await this._body(req, 4096);
    if (!this.token) return this._plain(res, 404);
    if (!body) return this._json(res, 400, { state: 'error' });
    const now = Date.now();
    const address = this._addr(req);
    const pc = this.server.name;
    // (asking isn't activity: only browsers the user allowed keep the share alive, see _armIdle)
    this._sweep();
    const coolUntil = this.cool.get(address) || 0;
    if (coolUntil > now) return this._json(res, 200, { state: 'denied', wait: Math.ceil((coolUntil - now) / 1000), pc });
    const cid = String(body.cid || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
    const ua = String(req.headers['user-agent'] || '').slice(0, 400);
    const device = deviceName(ua, body.touch);
    const a = this.asking;
    if (a && cid && a.cid === cid && a.address === address) {
      // the same browser asking again (its page reloaded): it takes over its own prompt, which stays up
      this.sessions.delete(a.sid);
      this._answerAll(a);
      a.sid = key(16); a.seen = now;
      this.sessions.set(a.sid, a);
      return this._json(res, 200, { sid: a.sid, state: 'pending', pc, device: a.device, v: a.v, code: a.code });
    }
    // Each request brings the Flick window to the front, so: one prompt at a time, a pause for an address the user
    // just turned away, and a cap per minute (as for phones)
    if (a) return this._json(res, 200, { state: 'busy', pc });
    this.prompts = this.prompts.filter((t) => now - t < 60000);
    if (this.prompts.length >= this.limits.prompts || this.sessions.size >= this.limits.sessions) return this._json(res, 200, { state: 'busy', pc });
    this.prompts.push(now);
    const s = {
      sid: key(16), dl: key(16), id: key(6), device, address, cid, state: 'pending', created: now, seen: now, changed: now,
      v: 1, waiters: new Set(), uploads: new Set(), downloads: new Set(),
      // shown on the browser's page and in the PC's prompt: the user allows only the device in their hand (anyone who
      // saw the link could ask too, but can't make the PC show the code that device shows)
      code: String(crypto.randomInt(0, 10000)).padStart(4, '0'),
    };
    this.sessions.set(s.sid, s); this.byId.set(s.id, s); this.byDl.set(s.dl, s);
    this.asking = s;
    this.emit('log', 'a browser asks to join: ' + device + ' at ' + address);
    this.emit('ask', { id: s.id, device, address, code: s.code });
    this.emit('state');
    this._json(res, 200, { sid: s.sid, state: 'pending', pc, device, v: s.v, code: s.code });
  }

  _doneAsking(s) {
    if (this.asking === s) { this.asking = null; this.emit('ask-done', { id: s.id }); }
  }

  // a browser leaves: told why (if it's still asking for news), its transfers stop, its keys stop working
  _end(s, state) {
    s.state = state;
    s.changed = Date.now();
    this.byDl.delete(s.dl);
    this._doneAsking(s);
    for (const u of [...s.uploads]) u.abort('ended');
    for (const r of [...s.downloads]) { try { r.destroy(); } catch (e) { /* ignore */ } }
    this._changed(s);
  }

  _sweep() {
    const now = Date.now(), L = this.limits;
    let changed = false;
    for (const s of [...this.sessions.values()]) {
      if (s.state === 'pending' && ((!s.waiters.size && now - s.seen > L.goneMs) || now - s.created > L.askMs)) {
        this.emit('log', 'a browser stopped waiting: ' + s.device);
        this._end(s, 'expired');
        changed = true;
      } else if (s.state !== 'ok' && s.state !== 'pending' && now - s.changed > L.keepMs) {
        this.sessions.delete(s.sid); this.byId.delete(s.id);
        changed = true;
      } else if (s.state === 'ok') {
        const away = !s.waiters.size && now - s.seen > L.awayMs;
        if (away !== !!s.away) { s.away = away; changed = true; }
      }
    }
    for (const g of [...this.groups.values()]) {
      if (!g.active.size && now - g.last > (g.announced ? L.groupQuietMs : 60000)) this._finishGroup(g);
    }
    if (changed) this.emit('state');
  }

  // ---------------------------------------------------------------- news for the page (long poll)
  _view(s) {
    const v = { state: s.state, v: s.v, pc: this.server.name, device: s.device };
    if (s.state === 'ok' && this.token) {
      v.where = this.where() || '';
      const base = '/w/' + this.token + '/dl/' + s.dl + '/';
      v.files = [...this.files.values()].reverse().map((f) => ({ id: f.id, name: f.name, size: f.size, url: base + f.id + '/' + encodeURIComponent(f.name) }));
    }
    if (s.state === 'pending') v.code = s.code;
    if (s.state === 'denied') v.wait = Math.max(0, Math.ceil(((this.cool.get(s.address) || 0) - Date.now()) / 1000));
    return v;
  }

  _poll(req, res, s, q) {
    s.seen = Date.now();
    if (Number(q.get('v')) !== s.v) return this._json(res, 200, this._view(s));
    // nothing new yet: wait for news. A few may wait at once (the page open in two tabs); the oldest makes way.
    if (s.waiters.size >= 3) this._answer(s, s.waiters.values().next().value);
    const w = { res, t: null };
    w.t = setTimeout(() => this._answer(s, w), this.limits.pollMs);
    s.waiters.add(w);
    res.on('close', () => { clearTimeout(w.t); if (s.waiters.delete(w)) s.seen = Date.now(); });
  }

  _answer(s, w) {
    if (!s.waiters.delete(w)) return;
    clearTimeout(w.t);
    s.seen = Date.now();
    this._json(w.res, 200, this._view(s));
  }

  _answerAll(s) { for (const w of [...s.waiters]) this._answer(s, w); }

  _changed(s) { s.v++; this._answerAll(s); }

  _filesChanged() {
    for (const s of this.sessions.values()) if (s.state === 'ok') this._changed(s);
    this.emit('state');
  }

  // ---------------------------------------------------------------- receiving files
  // A batch is the files a browser sends together; the PC shows them as one card. Free space is checked up front.
  async _batch(req, res, s) {
    const b = await this._body(req, 2048);
    if (!b) return this._json(res, 400, { ok: false, error: 'bad request' });
    const count = Math.max(1, Math.min(10000, Math.floor(+b.count) || 1));
    const bytes = Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.floor(+b.bytes) || 0));
    if (!this.server._roomFor(bytes + this.pendingBytes)) return this._json(res, 507, { ok: false, error: 'no space' });
    const g = this._group(s, count, bytes);
    this._touch();
    this._json(res, 200, { ok: true, batch: g.id });
  }

  _group(s, count, bytes) {
    const g = { id: key(9), s, count, bytes, active: new Set(), saved: [], failed: 0, done: 0, last: Date.now(), announced: false, lastEmit: 0, over: false };
    this.groups.set(g.id, g);
    return g;
  }

  _upload(req, res, s, q) {
    const L = this.limits;
    const len = Number(req.headers['content-length']);
    if (req.headers['transfer-encoding'] || !Number.isSafeInteger(len) || len < 0) return this._refuse(req, res, 411, { ok: false, error: 'length required' });
    if (!this.save) return this._refuse(req, res, 503, { ok: false, error: 'not ready' });
    if (s.uploads.size >= L.uploadsPerSession || this.uploading >= L.uploadsTotal) return this._refuse(req, res, 429, { ok: false, error: 'busy' });
    // what uploads in progress will still write counts too, or several at once could fill the disk between them
    if (!this.server._roomFor(len + this.pendingBytes)) return this._refuse(req, res, 507, { ok: false, error: 'no space' });
    // the name only ever becomes a file name through the same rules as the phone's (save -> sanitizeName)
    const name = String(q.get('name') || '').slice(0, 1000) || 'file';
    let g = this.groups.get(String(q.get('batch') || ''));
    if (!g || g.s !== s || g.over) g = this._group(s, 1, len);
    const tmp = path.join(this.server.tmpDir, 'w-' + crypto.randomBytes(8).toString('hex') + '.part');
    let out;
    try { out = fs.createWriteStream(tmp, { highWaterMark: 1024 * 1024 }); } catch (e) { return this._refuse(req, res, 500, { ok: false, error: 'disk' }); }
    const u = { got: 0, len, over: false, saving: false, abort: null };
    s.uploads.add(u); g.active.add(u); this.uploading++;
    this.pendingBytes += len;
    g.last = Date.now();
    this._stateSoon();
    this._touch();
    if (!g.announced) {
      g.announced = true;
      // for the card on screen only (shown as text): invisible direction marks could make "x<RLO>gnp.exe" read as a photo
      const shown = name.replace(/[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '').slice(0, 200) || 'file';
      this.emit('incoming-start', { gid: g.id, device: s.device, count: g.count, total: Math.max(g.bytes, len), name: shown });
    }
    let ended = false, lastTouch = 0;
    let owed = len;                                       // promised bytes not written yet (pendingBytes)
    const pay = (n) => { const k = Math.min(n, owed); owed -= k; this.pendingBytes -= k; };
    const settle = () => { pay(owed); s.uploads.delete(u); g.active.delete(u); this.uploading--; g.last = Date.now(); this._stateSoon(); };
    const removeTmp = () => { if (out.closed) fs.rm(tmp, { force: true }, () => {}); else out.once('close', () => fs.rm(tmp, { force: true }, () => {})); };
    const fail = (why, code) => {
      if (u.over) return;
      u.over = true;
      settle();
      out.destroy();
      removeTmp();
      g.failed++;
      if (why !== 'ended') this.emit('log', 'a browser upload failed: ' + why);
      if (!res.headersSent && !res.destroyed) this._refuse(req, res, code || 500, { ok: false, error: why });
      else { try { req.destroy(); } catch (e) { /* ignore */ } }
      this._groupCheck(g);
    };
    u.abort = (why) => {
      // a file that has fully arrived is saved even so; only the answer to the browser is lost
      if (u.saving) { try { req.destroy(); } catch (e) { /* ignore */ } return; }
      fail(why, 410);
      try { req.destroy(); } catch (e) { /* ignore */ }
    };
    req.setTimeout(L.stallMs, () => fail('stalled', 408));
    out.on('error', (e) => fail(e.code === 'ENOSPC' ? 'no space' : 'disk', e.code === 'ENOSPC' ? 507 : 500));
    req.on('data', (c) => {
      if (u.over) return;
      u.got += c.length;
      if (u.got > len) return fail('too long', 400);
      pay(c.length);
      if (!out.write(c)) { req.pause(); out.once('drain', () => { if (!u.over) req.resume(); }); }
      const now = Date.now();
      if (now - lastTouch > 1000) { lastTouch = now; this._touch(); s.seen = now; }
      this._progress(g);
    });
    req.on('error', () => fail('error'));
    req.on('close', () => { if (!ended) fail('closed'); });
    req.on('end', () => {
      ended = true;
      if (u.over) return;
      if (u.got !== len) return fail('short', 400);
      u.saving = true;
      out.end(async () => {
        if (u.over) return;
        let r = null, err = null;
        try { r = await this.save(tmp, name, { device: s.device }); } catch (e) { err = e; }
        u.over = true;
        settle();
        if (err || !r) {
          fs.rm(tmp, { force: true }, () => {});
          g.failed++;
          this.emit('log', 'a browser upload could not be saved: ' + ((err && err.message) || 'no answer'));
          this._json(res, 500, { ok: false, error: 'save' });
        } else {
          g.done += len;
          g.saved.push({ name: r.name, path: r.path });
          this._json(res, 200, { ok: true, name: r.name, where: r.where || '' });
        }
        this._progress(g, true);
        this._groupCheck(g);
      });
    });
  }

  _progress(g, force) {
    const now = Date.now();
    if (!force && now - g.lastEmit < 40) return;
    g.lastEmit = now;
    let got = g.done;
    let total = g.done;
    for (const u of g.active) { got += u.got; total += u.len; }
    this.emit('incoming-progress', { gid: g.id, received: got, total: Math.max(g.bytes, total) });
  }

  _groupCheck(g) {
    if (g.over || g.active.size) return;
    if (g.saved.length + g.failed >= g.count) this._finishGroup(g);
  }

  _finishGroup(g) {
    if (g.over) return;
    g.over = true;
    this.groups.delete(g.id);
    if (g.announced) this.emit('incoming-done', { gid: g.id, device: g.s.device, saved: g.saved, failed: Math.max(g.failed, g.count - g.saved.length) });
  }

  async _text(req, res, s) {
    const b = await this._body(req, 64 * 1024);
    if (!b || typeof b.text !== 'string') return this._json(res, 400, { ok: false, error: 'bad request' });
    const text = b.text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, this.limits.textLen);
    if (!text) return this._json(res, 400, { ok: false, error: 'empty' });
    if (!this.token || s.state !== 'ok') return this._json(res, 403, { ok: false, error: 'gone' });
    const t = { id: key(6), from: s.device, text, at: Date.now() };
    this.texts.unshift(t);
    this.texts.length = Math.min(this.texts.length, this.limits.texts);
    this._touch();
    this.emit('log', 'a browser sent a note: ' + s.device);
    this.emit('text', t);
    this.emit('state');
    this._json(res, 200, { ok: true });
  }

  // ---------------------------------------------------------------- downloads
  _download(req, res, dl, fid) {
    const s = this.byDl.get(dl);
    const f = this.files.get(fid);
    if (!s || s.state !== 'ok' || s.address !== this._addr(req) || !f) return this._plain(res, 404);
    fs.stat(f.path, (err, st) => {
      if (err || !st.isFile() || !this.files.has(fid) || s.state !== 'ok') return this._plain(res, 404);
      const size = st.size;
      const etag = '"' + size.toString(36) + '-' + Math.floor(st.mtimeMs).toString(36) + '"';
      let start = 0, end = size - 1, partial = false;
      const range = String(req.headers.range || '');
      const ifRange = req.headers['if-range'];
      const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      if (m && (m[1] || m[2]) && (!ifRange || ifRange === etag || ifRange === st.mtime.toUTCString())) {
        if (m[1] === '') {
          const n = Number(m[2]);                            // the last n bytes
          start = Math.max(0, size - n); end = size - 1;
          if (!n || !size) return this._unsatisfiable(res, size);
        } else {
          start = Number(m[1]); end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
          if (start >= size || start > end) return this._unsatisfiable(res, size);
        }
        partial = true;
      }
      const ext = (/\.([^.]+)$/.exec(f.name) || [])[1];
      const headers = this._headers({
        'Content-Type': DL_TYPES[String(ext || '').toLowerCase()] || 'application/octet-stream',
        'Content-Length': size ? end - start + 1 : 0,
        'Content-Disposition': contentDisposition(f.name),
        'Accept-Ranges': 'bytes',
        'ETag': etag,
        'Last-Modified': st.mtime.toUTCString(),
      });
      if (partial) headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + size;
      res.writeHead(partial ? 206 : 200, headers);
      if (req.method === 'HEAD' || !size) return res.end();
      this._touch();
      const rs = fs.createReadStream(f.path, { start, end, highWaterMark: 256 * 1024 });
      s.downloads.add(res); f.streams.add(res); this.downloading++;
      this._stateSoon();
      let closed = false, lastTouch = 0;
      res.on('close', () => {
        if (closed) return;
        closed = true;
        rs.destroy();
        s.downloads.delete(res); f.streams.delete(res); this.downloading--;
        this._touch();
        this._stateSoon();
      });
      res.setTimeout(this.limits.dlStallMs, () => res.destroy());
      rs.on('data', () => { const now = Date.now(); if (now - lastTouch > 1000) { lastTouch = now; this._touch(); s.seen = now; } });
      rs.on('error', () => res.destroy());
      rs.pipe(res);
    });
  }

  _unsatisfiable(res, size) {
    res.writeHead(416, this._headers({ 'Content-Range': 'bytes */' + size, 'Content-Type': 'text/plain; charset=utf-8' }));
    res.end();
  }
}

module.exports = { WebShare, deviceName, shareAddresses, contentDisposition, LIMITS };
