'use strict';
// Flick PC server: HTTP (uploads/downloads) + WebSocket (live drag stream) + UDP discovery.
// Pure Node so it can be tested without Electron.
const http = require('http');
const net = require('net');
const tls = require('tls');
const dgram = require('dgram');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');
const { EventEmitter } = require('events');
const { acceptUpgrade } = require('./ws');
const { BundleReceiver } = require('./bundle');
const { PhoneApi } = require('./phoneapi');

// 2: large files in parallel parts (/api/part) and byte ranges; 3: bundles over several streams; 4: encrypted links
// (TLS on the same port, a pinned certificate) and a sign-in that never sends the pairing token (see "sign-in");
// 5: several phones at once, the background link (/api/events), clipboard, links, notifications, folder sync (phoneapi.js)
const PROTO = 5;
// open connections allowed at once from one address, and in all (see _onSocket)
const SOCKS_PER_ADDR = 64, SOCKS_TOTAL = 512;
// phones connected at once; past that a phone gets a place only when its user asks for it (busy / replaced)
const MAX_PHONES = 4;

function rid(n = 12) { return crypto.randomBytes(n).toString('hex'); }
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const hmac = (key, s) => crypto.createHmac('sha256', String(key)).update(s).digest('hex');
function sameHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !/^[0-9a-f]{64}$/.test(a) || !/^[0-9a-f]{64}$/.test(b)) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

/** The pairing code both screens show: a MITM can't make them match (see 'connect' and 'pair-reveal'). */
function pairCode(chan, nonceP, nonceS) {
  const n = parseInt(sha256('flick-pair-v1|' + chan + '|' + nonceP + '|' + nonceS).slice(0, 8), 16) % 1000000;
  return String(n).padStart(6, '0');
}

// The SDK level of the Android version a WebView's user agent names ("...; Android 8.1.0; ...", the lower one where a
// version has two), or 0 when it doesn't say. Phone apps before 1.9 don't send their SDK level in hello, and they are
// all an Android 7-8 phone can run.
function uaSdk(ua) {
  const m = /\bAndroid (\d+)(?:\.(\d+))?/.exec(String(ua || ''));
  if (!m) return 0;
  const v = +m[1], dot1 = +(m[2] || 0) >= 1;
  if (v === 7 || v === 8) return (v === 7 ? 24 : 26) + (dot1 ? 1 : 0);   // 7.0 24, 7.1 25, 8.0 26, 8.1 27
  if (v === 9) return 28;
  if (v >= 10 && v <= 12) return v + 19;                                   // 10 29, 11 30, 12 31 (12L 32)
  return v >= 13 && v < 100 ? v + 20 : 0;                                  // 13 33, 14 34, ...
}

function lanAddresses() {
  const out = [];
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const a of ifs[name] || []) {
      if (a.family === 'IPv4' && !a.internal) out.push({ iface: name, address: a.address, netmask: a.netmask });
    }
  }
  // Prefer typical home LAN ranges first
  const score = (ip) => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : ip.startsWith('172.') ? 2 : 3);
  out.sort((a, b) => score(a.address) - score(b.address));
  return out;
}

class FlickServer extends EventEmitter {
  constructor(opts) {
    super();
    this.id = opts.id || rid(8);
    this.name = opts.name || os.hostname();
    this.basePort = opts.port || 47860;
    this.port = null;
    this.discoveryPort = opts.discoveryPort || 47870;
    this.tmpDir = opts.tmpDir || path.join(os.tmpdir(), 'flick-incoming');
    this.version = opts.version || '1.0.0';
    this.devices = Object.assign({}, opts.devices || {}); // deviceId -> { name, token, added }
    this.settings = Object.assign({ side: 'right', anchor: 0.5, theme: 'roadster' }, opts.settings || {});
    this.session = null;   // active phone session: the one PC-initiated sends go to
    this.sessions = new Map();  // deviceId -> session, every phone connected right now (several at once)
    this.usedAt = new Map();    // deviceId -> when the user last used that phone (a fling from it, a click in the panel)
    this.tidOwner = new Map();  // transfer id -> the phone that started it (its replies go there)
    this.uploads = new Map();   // tid -> { req, path }
    this.assemblies = new Map(); // tid -> a large file arriving in parallel parts (see _handlePart)
    this.partsSeen = new Map();  // "tid:att" -> { done | aborted, until }: late parts of a finished/aborted upload
    this.bundleAsm = new Map();  // tid -> a bundle arriving over several streams at once (see _handleBundleStream)
    this.outgoing = new Map();  // fid -> { path, name, size, mime }
    this.pending = new Map();   // deviceId -> session awaiting approval
    this.pairTimes = [];        // when recent pairing prompts were shown (rate limit)
    this.cool = new Map();      // address -> time until which its pairing requests are refused (after a "Don't allow")
    this.phoneApp = null;       // newest phone app this PC can hand out: { path, code, name, size, sha256 }
    this.allowOrigin = opts.allowOrigin || null;   // tests only (a RegExp); never set by a normal start
    // this PC's certificate ({ key, cert, fp } from tlscert.js): links to the phone are encrypted with it. Without one
    // (it couldn't be made) Flick still answers plain links, which phone apps from 1.9 on refuse to use.
    this.tlsId = opts.tls || null;
    this.fp = this.tlsId ? this.tlsId.fp : null;
    this.sockByAddr = new Map(); // address -> open connections (see _onSocket)
    this.sockCount = 0;
    this.api = new PhoneApi(this, { proto: PROTO });   // the protocol 5 endpoints and background links (phoneapi.js)
    fs.mkdirSync(this.tmpDir, { recursive: true });
  }

  // ---------- phone app updates ----------
  // what phone s is offered: nothing its Android can't install (minSdk); sums + sig are the signed SHA256SUMS of the
  // Flick release that lists this APK, which phone apps from 1.9 on require
  _appPublic(s) {
    const a = this.phoneApp;
    if (!a) return null;
    const sdk = s ? s.sdk || s.uaSdk || 0 : 0;
    if (a.minSdk && sdk && sdk < a.minSdk) return null;
    const o = { code: a.code, name: a.name, size: a.size, sha256: a.sha256, url: '/api/app.apk' };
    if (a.minSdk) o.minSdk = a.minSdk;
    if (a.sums && a.sig) { o.sums = a.sums; o.sig = a.sig; }
    return o;
  }

  /** The phone decides for itself whether this is newer than what it runs; `always` answers a "check for updates". */
  setPhoneApp(info, always) {
    const prev = this.phoneApp;
    this.phoneApp = info ? {
      path: info.path, code: info.code, name: info.name, size: info.size, sha256: info.sha256,
      minSdk: info.minSdk || 0, sums: info.sums || '', sig: info.sig || '',
    } : null;
    const changed = !prev !== !info || (prev && info && (prev.sha256 !== info.sha256 || prev.path !== info.path || prev.sig !== this.phoneApp.sig));
    // news for every phone (each offered what its Android can install); an unchanged answer only for the one that asked
    if (changed) {
      const seen = new Set();
      for (const x of [this.session, ...this.sessions.values()]) {
        if (!x || seen.has(x) || !x.trusted || !x.conn || !x.conn.open) continue;
        seen.add(x);
        x.conn.send({ t: 'app', app: this._appPublic(x) });
      }
    } else if (always) {
      const x = this.appAsker ? this._pageFor(this.appAsker) : this.session;
      if (x && x.trusted && x.conn && x.conn.open) x.conn.send({ t: 'app', app: this._appPublic(x) });
    }
  }

  // ---------- lifecycle ----------
  async start() {
    this.http = http.createServer((req, res) => this._onRequest(req, res));
    this.http.on('upgrade', (req, socket, head) => this._onUpgrade(req, socket, head));
    this.http.keepAliveTimeout = 30000;
    this.http.requestTimeout = 0; // large uploads
    this.http.headersTimeout = 20000;
    if (this.tlsId) {
      try { this.tlsCtx = tls.createSecureContext({ key: this.tlsId.key, cert: this.tlsId.cert, minVersion: 'TLSv1.2' }); }
      catch (e) { this.tlsCtx = null; this.fp = null; this.emit('log', 'tls off: ' + e.message); }
    }
    // One port for both: an encrypted link starts with a TLS handshake (first byte 0x16); anything else is plain HTTP
    // (phone apps before 1.9, Bluetooth relayed from this PC, browsers)
    this.net = net.createServer((sock) => this._onSocket(sock));
    let lastErr;
    for (let p = this.basePort; p < this.basePort + 6; p++) {
      try {
        await new Promise((resolve, reject) => {
          const onErr = (e) => { this.net.removeListener('listening', onOk); reject(e); };
          const onOk = () => { this.net.removeListener('error', onErr); resolve(); };
          this.net.once('error', onErr);
          this.net.once('listening', onOk);
          this.net.listen(p, '0.0.0.0');
        });
        this.port = p;
        break;
      } catch (e) { lastErr = e; }
    }
    if (!this.port) throw lastErr || new Error('No free port');
    this._startDiscovery();
    return this.port;
  }

  _onSocket(sock) {
    sock.on('error', () => sock.destroy());
    // Caps on open connections, per address and in all, so nobody can tie up the PC with idle or half-made ones (a phone
    // uses a few at a time: the WebSocket, a handful of parallel transfer streams, thumbnails)
    const addr = sock.remoteAddress || '';
    const n = this.sockByAddr.get(addr) || 0;
    if (n >= SOCKS_PER_ADDR || this.sockCount >= SOCKS_TOTAL) { sock.destroy(); return; }
    this.sockByAddr.set(addr, n + 1); this.sockCount++;
    sock.once('close', () => {
      this.sockCount--;
      const k = (this.sockByAddr.get(addr) || 1) - 1;
      if (k > 0) this.sockByAddr.set(addr, k); else this.sockByAddr.delete(addr);
    });
    // a connection that never says anything doesn't get to hold a socket
    const quiet = setTimeout(() => sock.destroy(), 15000);
    sock.once('close', () => clearTimeout(quiet));
    sock.once('data', (first) => {
      clearTimeout(quiet);
      sock.pause();
      sock.unshift(first);
      if (first[0] === 0x16 && this.tlsCtx) {
        const t = new tls.TLSSocket(sock, { isServer: true, secureContext: this.tlsCtx });
        const hs = setTimeout(() => t.destroy(), 15000);
        t.on('error', () => t.destroy());
        t.once('close', () => clearTimeout(hs));
        t.once('secure', () => { clearTimeout(hs); this.http.emit('connection', t); });
      } else {
        this.http.emit('connection', sock);
      }
      process.nextTick(() => sock.resume());
    });
  }

  // How a socket reached us: 'plain', 'bluetooth' (a paired device over an encrypted Bluetooth link, relayed through
  // the mux) or this PC's certificate fingerprint (TLS). The sign-in and the pairing code are bound to it.
  _chan(sock) {
    if (sock && sock.remoteFamily === 'bluetooth') return 'bluetooth';
    if (sock && sock.encrypted && this.fp) return this.fp;
    return 'plain';
  }

  stop() {
    clearInterval(this.sweepT); this.sweepT = null;
    for (const b of [...this.bundleAsm.values()]) this._dropBundleAsm(b, true);
    try { this.net && this.net.close(); } catch (e) { /* ignore */ }
    try { this.http && this.http.close(); } catch (e) { /* ignore */ }
    try { this.udp && this.udp.close(); } catch (e) { /* ignore */ }
    if (this.session && this.session.conn) this.session.conn.close();
    for (const x of this.sessions.values()) { try { x.conn.close(); } catch (e) { /* ignore */ } }
    this.api.stop();
  }

  _startDiscovery() {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.udp = sock;
    sock.on('error', (e) => { this.emit('log', 'udp error ' + e.message); });
    sock.on('message', (msg, rinfo) => {
      let m;
      try { m = JSON.parse(msg.toString('utf8')); } catch (e) { return; }
      if (!m || m.t !== 'flick?') return;
      const reply = Buffer.from(JSON.stringify({
        t: 'flick!', v: PROTO, id: this.id, name: this.name, port: this.port, os: process.platform,
        known: !!(m.id && this.devices[m.id]), tls: this.tlsCtx ? 1 : 0,
      }));
      sock.send(reply, rinfo.port, rinfo.address, () => {});
      this.emit('discovered-by', { address: rinfo.address, name: m.name });
    });
    sock.bind(this.discoveryPort, () => {
      try { sock.setBroadcast(true); } catch (e) { /* ignore */ }
    });
  }

  setName(name) { this.name = String(name || '').slice(0, 60) || this.name; this.broadcast({ t: 'pc', name: this.name }); }

  setSettings(s) {
    Object.assign(this.settings, s);
    this.broadcast({ t: 'settings', side: this.settings.side, anchor: this.settings.anchor, theme: this.settings.theme });
  }

  // ---------- trust ----------
  _trusted(device, token) {
    const d = device && this.devices[device];
    if (!d || typeof d.token !== 'string' || typeof token !== 'string' || !token) return false;
    const a = Buffer.from(token), b = Buffer.from(d.token);
    return a.length === b.length && crypto.timingSafeEqual(a, b);             // constant-time comparison
  }

  // A request carrying a token: once a phone has signed in over a secure link, its token is only good on one (a
  // phone app from 1.9 never uses a plain link, so a plain request with its token is someone else)
  _trustedReq(req, device, token) {
    if (!this._trusted(device, token)) return false;
    return !this.devices[device].tls || this._chan(req.socket) !== 'plain';
  }

  // The protocol 5 features (clipboard, links, notifications, folder sync, the background link, the remote) are for
  // phones that paired securely (Flick 1.9+: tls) and only over an encrypted link (TLS or Bluetooth). A phone paired
  // before 1.9 sent its token in the clear, so that token reaches none of them, on any link; it pairs again first.
  _v5ok(device, chan) {
    const d = device && Object.prototype.hasOwnProperty.call(this.devices, device) ? this.devices[device] : null;
    return !!(d && d.tls === true && chan && chan !== 'plain');
  }

  _proof(token, role, s) {
    return hmac(token, 'flick-auth-v1|' + role + '|' + s.nonceP + '|' + s.nonceS + '|' + s.chan + '|' + s.device + '|' + this.id);
  }

  // A real phone reaches us at a LAN IP and its page is local (file://), so it sends no web Origin and a Host that is
  // a bare IP:port. Reject anything with a real browser Origin (a web page trying to drive us) or a DNS-name Host
  // (so a rebinding page can't pose as the phone). Loopback/absent is fine — that's how the phone and tests connect.
  _hostOk(req) {
    // a Bluetooth stream comes from a paired device through the mux, never from a browser: nothing to check
    if (req.socket && req.socket.remoteFamily === 'bluetooth') return true;
    const origin = req.headers.origin;
    // the phone's page is a local file: Android WebView reports that as "null" or as a file: origin (a web page can
    // produce neither from the network). allowOrigin lets tests serve the phone page over http.
    if (origin && origin !== 'null' && !/^file:/i.test(origin) && !(this.allowOrigin && this.allowOrigin.test(origin))) return false;
    const host = (req.headers.host || '').replace(/^\[(.*)\]/, '$1').replace(/:\d+$/, '').trim();
    if (!host) return true;
    return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':') || host === 'localhost';
  }

  approve(device) {
    const s = this.pending.get(device);
    if (s && s.v4 && !s.pairCode) return;                  // the code wasn't shown yet: nothing the user could approve
    this.pending.delete(device);
    const token = rid(16);
    this.devices[device] = { name: (s && s.name) || 'Phone', token, added: Date.now() };
    if (s && s.chan && s.chan !== 'plain') this.devices[device].tls = true;      // paired over a secure link: stays secure
    this.emit('devices-changed', this.devices);
    this.emit('pair-cancel', device);
    if (s && s.conn && s.conn.open) {
      s.trusted = true;
      s.token = token;
      // fp: this PC's certificate, for a phone that paired over Bluetooth (it sees no certificate there) to pin before
      // its first Wi-Fi connection. Over TLS the phone pins the one it sees itself.
      s.conn.send({ t: 'paired', token, fp: this.fp || undefined });
      this._join(s, true);                        // the user just allowed this phone: it joins and becomes the one in use
    }
  }

  // the phone the PC listens to becomes s, unless a different phone is connected right now (nothing is closed)
  _focus(s) {
    const cur = this.session;
    if (cur && cur !== s && cur.connected && cur.conn.open) return false;
    this.session = s;
    return true;
  }

  // make s the phone in use even though another one is connected (the user asked for it): that one is told why it
  // lost the PC and closed. quiet: it's the same phone's older link, so there's nobody to tell.
  _takeOver(s, quiet) {
    const cur = this.session;
    if (cur && cur !== s) {
      const was = cur.connected && cur.conn.open;
      if (was || quiet) { try { if (!quiet) cur.conn.send({ t: 'replaced' }); cur.conn.close(); } catch (e) { /* ignore */ } }
      if (was) { cur.connected = false; this._unlist(cur); this.emit('disconnected', this._publicSession(cur)); }
    }
    this.session = s;
  }

  // ---------- several phones at once ----------
  _unlist(s) { if (s && s.device && this.sessions.get(s.device) === s) this.sessions.delete(s.device); }
  _live() { return [...this.sessions.values()].filter((x) => x.connected && x.conn.open); }

  // s joins the phones connected right now. Past MAX_PHONES a phone takes a place only when its user asked for it
  // (held Connect, or allowed it here): the one used longest ago is told 'replaced'. Returns false when it can't join.
  _join(s, asked) {
    if (!this.sessions.has(s.device) && this._live().length >= MAX_PHONES) {
      if (!asked) return false;
      const live = this._live().filter((x) => x !== s);
      const old = live.reduce((a, b) => ((this.usedAt.get(b.device) || 0) < (this.usedAt.get(a.device) || 0) ? b : a), live[0]);
      if (old) {
        try { old.conn.send({ t: 'replaced' }); old.conn.close(); } catch (e) { /* ignore */ }
        old.connected = false; this._unlist(old);
        this.emit('disconnected', this._publicSession(old));
      }
    }
    this._connected(s);
    if (asked) this.use(s.device);
    return true;
  }

  /** The user used this phone (a fling from it, a click in the panel): what the PC sends now goes to it. */
  use(device) {
    const s = device && this.sessions.get(device);
    if (!s || !s.connected || !s.conn.open) return false;
    this.usedAt.set(device, Date.now());
    if (this.session !== s) { this.session = s; this.emit('active', this._publicSession(s)); }
    return true;
  }

  // the phone in use left: the connected one used most recently takes its place (or the only one left)
  _pickActive() {
    let best = null;
    for (const x of this._live()) if (!best || (this.usedAt.get(x.device) || 0) > (this.usedAt.get(best.device) || 0)) best = x;
    this.session = best;
    if (best) this.emit('active', this._publicSession(best));
  }

  /** Every phone connected right now (the panel's list): the active one is where the PC's sends go. */
  phones() {
    return this._live().map((x) => Object.assign(this._publicSession(x), { active: x === this.session }));
  }

  // the page of `device` if it's open and signed in: connected, or the session the PC is listening to
  _pageFor(device) {
    if (!device) return null;
    const x = this.sessions.get(device);
    if (x && x.conn.open && x.trusted) return x;
    const c = this.session;
    return c && c.device === device && c.trusted && c.conn && c.conn.open ? c : null;
  }

  // which phone started a transfer: replies about it ('saved', 'failed') go to that phone only
  _own(tid, device) {
    if (!tid || !device) return;
    tid = String(tid).slice(0, 64);
    this.tidOwner.delete(tid);
    this.tidOwner.set(tid, device);
    if (this.tidOwner.size > 2000) { let n = 500; for (const k of this.tidOwner.keys()) { this.tidOwner.delete(k); if (--n <= 0) break; } }
  }
  ownerOf(tid) { return (tid && this.tidOwner.get(String(tid).slice(0, 64))) || null; }

  /** Something about this PC every phone shows (its name, the animation settings, the phone app it hands out). */
  broadcast(obj) {
    const seen = new Set();
    for (const x of [this.session, ...this.sessions.values()]) {
      if (!x || seen.has(x) || !x.trusted || !x.conn || !x.conn.open) continue;
      seen.add(x);
      x.conn.send(obj);
    }
    return seen.size > 0;
  }

  /**
   * An event for one phone (protocol 5: clip, link, ring, ring-stop): over its page's WebSocket when Flick is open
   * there, else over its background link (/api/events); false when it has neither (the PC drops it).
   */
  sendEvent(device, obj) {
    const s = this._pageFor(device);
    if (s) {
      if (!this._v5ok(s.device, s.chan)) return false;      // never the clipboard etc. to a phone paired before 1.9
      s.conn.send(obj);
      return true;
    }
    return this.api.streamSend(device, obj);
  }

  /** The phone PC-initiated events go to: the phone in use, else the background link used or opened last. */
  eventTarget() {
    const s = this.session;
    if (s && s.device && s.trusted && s.conn && s.conn.open) return s.device;
    let best = null, bestAt = -1;
    for (const d of this.api.streamDevices()) {
      const at = this.usedAt.get(d) || 0;
      if (best === null || at > bestAt || (at === bestAt && this.api.streamOpenedAt(d) > this.api.streamOpenedAt(best))) { best = d; bestAt = at; }
    }
    return best;
  }

  deny(device) {
    const s = this.pending.get(device);
    this.pending.delete(device);
    if (s) {
      const now = Date.now();
      for (const [a, until] of this.cool) if (until < now) this.cool.delete(a);
      this.cool.set(s.address, now + 20000);
    }
    this.emit('pair-cancel', device);
    if (s && s.conn && s.conn.open) s.conn.send({ t: 'denied' });
  }

  forget(device) {
    delete this.devices[device];
    this.emit('devices-changed', this.devices);
    const x = this.sessions.get(device);
    if (x && x !== this.session) x.conn.close();
    if (this.session && this.session.device === device) { this.session.conn.close(); }
    this.api.closeStream(device);                 // its background link ends with the pairing
  }

  // ---------- phone messaging ----------
  // `device` names the phone; without it a reply about a transfer goes to the phone that started it, and anything
  // else to the phone in use (the active one)
  pushToPhone(obj, device) {
    let s = this.session;
    if (device) s = this._pageFor(device);
    else if (obj && this.ownerOf(obj.tid)) s = this._pageFor(this.ownerOf(obj.tid));
    if (s && s.conn && s.conn.open && s.trusted) { s.conn.send(obj); return true; }
    return false;
  }

  get connected() { return !!(this.session && this.session.connected && this.session.conn.open); }

  _connected(s) {
    s.connected = true;
    if (s.device) this.sessions.set(s.device, s);
    // joining next to another phone: it becomes the one in use only if the user used it more recently (a phone back
    // from a dropped link gets its place back)
    const cur = this.session;
    if (cur !== s && (!cur || !cur.connected || !cur.conn.open || (this.usedAt.get(s.device) || 0) > (this.usedAt.get(cur.device) || 0))) this.session = s;
    s.conn.send({ t: 'connected', pc: { id: this.id, name: this.name }, side: this.settings.side, anchor: this.settings.anchor, theme: this.settings.theme, app: this._appPublic(s) });
    this.emit('connected', this._publicSession(s));
  }

  _publicSession(s) {
    return { device: s.device, name: s.name, screen: s.screen, address: s.address, app: s.app || 0, appName: s.appName || '', via: s.via || '', secure: !!s.chan && s.chan !== 'plain' };
  }

  // after hello (and the sign-in, if any): s joins as trusted or not, and is told so
  _helloDone(s, trusted, why) {
    s.trusted = !!trusted;
    if (!s.trusted) s.token = null;
    // Opening Flick on a second phone must not knock the connected one off: a new socket becomes the session when
    // nobody is connected, or when it's the same phone (signed in) on a newer link. Other phones join next to it when
    // they "connect" (several at once, see _join).
    const cur = this.session;
    if (cur && cur !== s && cur.device === s.device && s.trusted) this._takeOver(s, true);   // same phone, newer link
    else {
      const prev = s.trusted && this.sessions.get(s.device);
      if (prev && prev !== s) {                                  // same phone, newer link (connected, not the one in use)
        prev.connected = false; this._unlist(prev);
        try { prev.conn.close(); } catch (e) { /* ignore */ }
        this.emit('disconnected', this._publicSession(prev));
      }
      this._focus(s);                                                                           // never knocks one off
    }
    const w = { t: 'welcome', v: PROTO, pc: { id: this.id, name: this.name }, trusted: s.trusted, side: this.settings.side, anchor: this.settings.anchor, theme: this.settings.theme };
    if (why) w.why = why;
    s.conn.send(w);
    this.emit('phone-hello', this._publicSession(s));
    if (s.resume && s.trusted && this.session === s) this._connected(s);
  }

  _onUpgrade(req, socket, head) {
    let u;
    try { u = new URL(req.url, 'http://x'); } catch (e) { socket.destroy(); return; }
    if (u.pathname !== '/ws') { socket.destroy(); return; }
    if (!this._hostOk(req)) { try { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); } catch (e) { socket.destroy(); } return; }
    // a phone needs one socket (two while it moves to a faster link); a flood from one address is refused
    const addr = socket.remoteAddress || '';
    this.wsByAddr = this.wsByAddr || new Map();
    if ((this.wsByAddr.get(addr) || 0) >= 8) { socket.destroy(); return; }
    const conn = acceptUpgrade(req, socket, head);
    if (!conn) return;
    this.wsByAddr.set(addr, (this.wsByAddr.get(addr) || 0) + 1);
    const s = { conn, device: null, name: 'Phone', trusted: false, connected: false, screen: null, address: socket.remoteAddress, chan: this._chan(socket) };
    s.uaSdk = uaSdk(req.headers['user-agent']);
    // a phone says hello right away (and signs in right after); a socket that doesn't is closed
    const helloT = setTimeout(() => { if (!s.device || s.authWait) conn.close(); }, 10000);
    conn.on('message', (txt) => {
      let m;
      try { m = JSON.parse(txt); } catch (e) { return; }
      this._onPhoneMessage(s, m);
    });
    conn.on('close', () => {
      clearTimeout(helloT);
      const n = (this.wsByAddr.get(addr) || 1) - 1;
      if (n > 0) this.wsByAddr.set(addr, n); else this.wsByAddr.delete(addr);
      const was = s.connected;
      s.connected = false;
      this._unlist(s);
      if (this.session === s) {
        this.session = null;
        this._pickActive();                       // another connected phone (if any) gets what the PC sends now
        this.emit('disconnected', this._publicSession(s));
      } else if (was) this.emit('disconnected', this._publicSession(s));
      if (s.device && this.pending.get(s.device) === s) {
        this.pending.delete(s.device);
        this.emit('pair-cancel', s.device);
      }
    });
  }

  _onPhoneMessage(s, m) {
    switch (m.t) {
      case 'hello': {
        if (s.helloed) break;                                   // one hello per socket
        s.helloed = true;
        s.device = String(m.device || '').slice(0, 64);
        s.name = String(m.name || 'Phone').slice(0, 60);
        s.screen = { w: +m.w || 400, h: +m.h || 860, dpr: +m.dpr || 2 };
        s.app = Math.max(0, Math.floor(+m.app || 0));          // phone app version code (0 = before 1.4)
        s.appName = String(m.appName || '').slice(0, 20);
        s.sdk = Math.max(0, Math.floor(+m.sdk || 0));           // Android SDK level (0 = not said: phone apps before 1.9)
        s.via = /^(wifi|usb|hotspot|direct|ethernet|bluetooth)$/.test(m.via) ? m.via : (s.via || '');
        s.resume = !!m.resume;
        const d = this.devices[s.device];
        if ((+m.v || 0) >= 4 && /^[0-9a-f]{32,64}$/.test(String(m.nonce || ''))) {
          // Sign-in (phone apps from 1.9). The token never crosses the network: each side proves it holds it with an
          // HMAC over both sides' random numbers and the link's identity (this PC's certificate), so someone in the
          // middle can neither read it nor relay the proof onto a link of their own. The PC proves itself first.
          s.v4 = true; s.nonceP = m.nonce; s.nonceS = rid(16);
          if (d && d.token && d.tls && s.chan !== 'plain') {
            s.authWait = true;
            s.conn.send({ t: 'auth?', v: PROTO, nonce: s.nonceS, proof: this._proof(d.token, 'pc', s), pc: { id: this.id, name: this.name } });
            break;                                              // continues at 'auth'
          }
          // Not paired here: it can ask to pair. A phone paired before 1.9 is one too: its token travelled in the clear
          // and may have been overheard, so it isn't enough to sign in with. It confirms once with the pairing code.
          this._helloDone(s, false, d && d.token && !d.tls && s.chan !== 'plain' ? 'confirm' : undefined);
          break;
        }
        // phone apps before 1.9 send the token itself: good only over a plain link, from a phone that never signed in
        // over a secure one
        s.trusted = this._trusted(s.device, m.token) && !(d && d.tls);
        s.token = s.trusted ? m.token : null;
        this._helloDone(s, s.trusted);
        break;
      }
      case 'auth': {
        if (!s.authWait) break;
        s.authWait = false;
        const d = this.devices[s.device];
        if (!d || !d.token || !sameHex(String(m.proof || ''), this._proof(d.token, 'phone', s))) {
          this.emit('log', 'sign-in failed for a phone');
          this._helloDone(s, false, 'auth');                    // it can still ask to pair again
          break;
        }
        s.token = d.token;
        this._helloDone(s, true);
        break;
      }
      case 'screen':
        s.screen = { w: +m.w || 400, h: +m.h || 860, dpr: +m.dpr || 2 };
        break;
      case 'hold':
        // a paired phone's hold shows even while another phone is connected (it's about to join)
        if (this.session === s || this._focus(s) || s.trusted) this.emit('hold', { p: Math.max(0, Math.min(1, +m.p || 0)) });
        break;
      case 'hold-cancel':
        if (this.session === s || s.trusted) this.emit('hold', { p: 0, cancel: true });
        break;
      case 'connect':
        if (s.trusted) {
          // asked: the user held Connect on this phone (phone apps before 1.8 only ever send "connect" when the user
          // held it, so for them it always counts). It then becomes the phone in use.
          const asked = m.user === true || (s.app || 0) < 10800;
          if (this.session === s || this._focus(s)) { this._connected(s); if (asked) this.use(s.device); }
          else if (!this._join(s, asked)) s.conn.send({ t: 'busy' });   // MAX_PHONES connected and nobody asked
        } else {
          if (!s.helloed || s.authWait) break;
          // Each request pulls the Flick window to the front, so a stranger mustn't be able to spam them: one prompt
          // at a time, a short pause for an address the user just declined, and a cap per minute.
          const now = Date.now();
          if ((this.cool.get(s.address) || 0) > now) { s.conn.send({ t: 'denied' }); break; }
          for (const [dev, p] of this.pending) if (!p.conn || !p.conn.open) this.pending.delete(dev);
          if ([...this.pending.values()].some((p) => p !== s)) { s.conn.send({ t: 'denied' }); break; }
          if (s.v4 && !/^[0-9a-f]{64}$/.test(String(m.commit || ''))) break;
          this.pairTimes = this.pairTimes.filter((t) => now - t < 60000);
          if (this.pairTimes.length >= 6) { s.conn.send({ t: 'denied' }); break; }
          this.pairTimes.push(now);
          this.pending.set(s.device, s);
          if (s.v4) {
            // Pairing code (phone apps from 1.9): the phone has committed to its random number (a hash of it); we
            // answer with ours; only then does it reveal its own. So nobody, the phone included, can pick numbers that
            // steer the code, and someone in the middle (with a different certificate) shows a different code.
            s.pairCommit = String(m.commit); s.pairNonceS = rid(16); s.pairCode = null;
            s.conn.send({ t: 'pairing', nonce: s.pairNonceS });
            break;                                              // the PC asks once the phone reveals ('pair-reveal')
          }
          s.conn.send({ t: 'pairing' });
          this.emit('pair-request', this._publicSession(s));
        }
        break;
      case 'pair-reveal': {
        if (!s.v4 || !s.pairCommit || s.pairCode || this.pending.get(s.device) !== s) break;
        const n = String(m.nonce || '');
        if (!/^[0-9a-f]{32,64}$/.test(n) || sha256(n) !== s.pairCommit) {
          this.pending.delete(s.device);
          s.conn.send({ t: 'denied' });
          break;
        }
        s.pairCode = pairCode(s.chan, n, s.pairNonceS);
        const was = this.devices[s.device];
        // upgrade: a phone paired before 1.9 confirming itself once for encrypted connections
        this.emit('pair-request', Object.assign(this._publicSession(s), { code: s.pairCode, upgrade: !!(was && was.token && !was.tls) }));
        break;
      }
      case 'lift': case 'move': case 'drop': case 'cancel': case 'send':
        if (s.trusted && (this.session === s || (s.connected && this.sessions.get(s.device) === s))) {
          // a fling makes this the phone in use; its replies ('saved', 'failed') go back to it
          if (m.t === 'lift' || m.t === 'send') this.use(s.device);
          this._own(m.tid, s.device);
          m.device = s.device;
          this.emit(m.t, m);
        }
        break;
      case 'set-side':
        if (s.trusted && (m.side === 'left' || m.side === 'right')) this.emit('set-side', m.side);
        break;
      case 'set-theme':
        if (s.trusted && typeof m.theme === 'string') this.emit('set-theme', m.theme.slice(0, 20));
        break;
      case 'incoming-done':
        if (s.trusted) this.emit('incoming-done', m);
        break;
      case 'app-check':
        if (s.trusted && (this.session === s || s.connected)) { this.appAsker = s.device; this.emit('app-check'); }
        break;
      case 'ping':
        s.conn.send({ t: 'pong', ts: m.ts });
        break;
      // protocol 5 (§3): the remote, the clipboard and links from the page, and "found it" after the PC rang the phone
      case 'media': case 'clip': case 'link': case 'ring-found':
        if (s.trusted && s.device && this._v5ok(s.device, s.chan)) this.api.fromPage(s, m);
        break;
      default:
        break;
    }
  }

  // ---------- HTTP ----------
  _cors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  }

  _json(res, code, obj) {
    this._cors(res);
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  }

  _onRequest(req, res) {
    let u;
    try { u = new URL(req.url, 'http://x'); } catch (e) { res.writeHead(400); res.end(); return; }
    // browsers on the "Share with a browser" page (webshare.js): their own routes under /w/ with their own checks
    if (this.web && this.web.handle(req, res, u)) return;
    if (req.method === 'OPTIONS') { this._cors(res); res.writeHead(204); res.end(); return; }
    if (!this._hostOk(req)) { res.writeHead(403); res.end(); return; }
    const q = u.searchParams;
    if (req.method === 'GET' && u.pathname === '/api/hello') {
      // reachable only by non-browser clients (the host/origin gate above blocks web pages); the phone needs id+name
      return this._json(res, 200, { app: 'flick', v: PROTO, id: this.id, name: this.name, port: this.port, tls: this.tlsCtx ? 1 : 0 });
    }
    // protocol 5: /api/events, /api/clip, /api/link, /api/notify, /api/sync/* (phoneapi.js, same token checks)
    if (this.api.handle(req, res, u)) return;
    if (req.method === 'POST' && u.pathname === '/api/upload') {
      if (!this._trustedReq(req, q.get('device'), q.get('token'))) return this._json(res, 403, { ok: false, error: 'not paired' });
      if (q.get('quiet') !== '1') this._own(q.get('tid'), q.get('device'));
      return this._handleUpload(req, res, q);
    }
    if (req.method === 'POST' && u.pathname === '/api/part') {
      if (!this._trustedReq(req, q.get('device'), q.get('token'))) return this._json(res, 403, { ok: false, error: 'not paired' });
      this._own(q.get('tid'), q.get('device'));
      return this._handlePart(req, res, q);
    }
    if (req.method === 'POST' && u.pathname === '/api/bundle') {
      if (!this._trustedReq(req, q.get('device'), q.get('token'))) return this._json(res, 403, { ok: false, error: 'not paired' });
      this._own(q.get('tid'), q.get('device'));
      return this._handleBundle(req, res, q);
    }
    if (req.method === 'GET' && u.pathname.startsWith('/api/file/')) {
      if (!this._trustedReq(req, q.get('device'), q.get('token'))) return this._json(res, 403, { ok: false, error: 'not paired' });
      return this._handleDownload(req, res, decodeURIComponent(u.pathname.slice('/api/file/'.length)));
    }
    if (req.method === 'GET' && u.pathname === '/api/app.apk') {
      if (!this._trustedReq(req, q.get('device'), q.get('token'))) return this._json(res, 403, { ok: false, error: 'not paired' });
      return this._handleAppDownload(req, res);
    }
    this._json(res, 404, { ok: false });
  }

  // the phone app update; the phone checks size + SHA-256 (and Android checks the signature) before installing
  _handleAppDownload(req, res) {
    const a = this.phoneApp;
    if (!a) return this._json(res, 404, { ok: false, error: 'no update' });
    fs.stat(a.path, (err, st) => {
      if (err || !st.isFile()) return this._json(res, 404, { ok: false, error: 'missing' });
      if (st.size !== a.size) return this._json(res, 409, { ok: false, error: 'changed' });
      this._cors(res);
      res.writeHead(200, {
        'Content-Type': 'application/vnd.android.package-archive',
        'Content-Length': st.size,
        'Cache-Control': 'no-store',
        'X-Flick-Version': String(a.code),
      });
      const rs = fs.createReadStream(a.path, { highWaterMark: 256 * 1024 });
      rs.on('error', () => { try { res.destroy(); } catch (e) { /* ignore */ } });
      rs.pipe(res);
      this.emit('app-download', { code: a.code, size: st.size });
    });
  }

  // Is there room for `bytes` more (plus a margin) where incoming files land? A phone mustn't fill the disk.
  _roomFor(bytes) {
    try {
      const st = fs.statfsSync(this.tmpDir);
      return st.bavail * st.bsize >= (+bytes || 0) + 256 * 1024 * 1024;
    } catch (e) { return true; }                      // can't tell: don't block transfers over it
  }

  // A new attempt for a transfer the phone is retrying replaces the earlier one, which may still be running or
  // failing: each attempt writes its own file, and a replaced attempt never reports anything.
  _claim(tid, entry) {
    const old = this.uploads.get(tid);
    if (old && old !== entry) { old.superseded = true; try { old.req.destroy(); } catch (e) { /* ignore */ } }
    const asm = this.assemblies.get(tid);
    if (asm) this._dropAssembly(asm, true);
    const ba = this.bundleAsm.get(tid);
    if (ba) this._dropBundleAsm(ba, true);
    this.uploads.set(tid, entry);
  }

  _remember(tid, att, what) {
    const now = Date.now();
    for (const [k, v] of this.partsSeen) if (v.until < now) this.partsSeen.delete(k);
    this.partsSeen.set(tid + ':' + att, { what, until: now + 5 * 60000 });
  }

  // a parallel upload with no part arriving for a minute was given up by the phone: free its file and say so
  _sweepAssemblies() {
    const now = Date.now();
    for (const a of [...this.assemblies.values()]) {
      if (a.reqs.size === 0 && now - a.active > 60000) { this._dropAssembly(a, false); this.emit('upload-failed', { tid: a.tid, why: 'abandoned' }); }
    }
    for (const b of [...this.bundleAsm.values()]) {
      if (b.reqs.size === 0 && now - b.active > 60000) { this._dropBundleAsm(b, false); this.emit('upload-failed', { tid: b.tid, why: 'abandoned' }); }
    }
  }
  _sweepSoon() { if (!this.sweepT) { this.sweepT = setInterval(() => this._sweepAssemblies(), 15000); if (this.sweepT.unref) this.sweepT.unref(); } }
  _release(tid, entry) { if (this.uploads.get(tid) === entry) this.uploads.delete(tid); }

  _handleUpload(req, res, q) {
    const tid = (q.get('tid') || rid(6)).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40) || rid(6);
    const name = q.get('name') || 'file';
    // quiet=1 (protocol 5): sent without the fling gesture (auto-send, tile, widget). No card flies in; it's saved
    // like any received file once it's all here (phoneapi.js quietDone), and only then answered.
    const quiet = q.get('quiet') === '1';
    const note = (ev, x) => { if (!quiet) this.emit(ev, x); };
    // the request's own length is exact; the phone's size hint can be stale (media index)
    const clen = parseInt(req.headers['content-length'] || '', 10);
    const total = clen >= 0 ? clen : (parseInt(q.get('size') || '0', 10) || 0);
    if (!this._roomFor(total)) { req.resume(); return this._json(res, 507, { ok: false, error: 'no space' }); }
    const tmpPath = path.join(this.tmpDir, tid + '-' + rid(4) + '.part');
    const entry = { req, path: tmpPath, superseded: false };
    this._claim(tid, entry);
    const out = fs.createWriteStream(tmpPath, { highWaterMark: 1024 * 1024 });
    let received = 0;
    let lastEmit = 0;
    let finished = false;
    const t0 = Date.now();
    note('upload-start', { tid, name, total });

    const removeTmp = () => { if (out.closed) fs.unlink(tmpPath, () => {}); else out.once('close', () => fs.unlink(tmpPath, () => {})); };
    const fail = (why) => {
      if (finished) return;
      finished = true;
      this._release(tid, entry);
      req.removeListener('data', onData);
      out.destroy();
      removeTmp();
      if (!entry.superseded) note('upload-failed', { tid, why });
      if (!res.headersSent) { try { this._json(res, why === 'short' ? 400 : 500, { ok: false, error: why }); } catch (e) { /* ignore */ } }
      try { req.destroy(); } catch (e) { /* ignore */ }
    };
    const onData = (chunk) => {
      if (finished) return;
      received += chunk.length;
      if (!out.write(chunk)) { req.pause(); out.once('drain', () => { if (!finished) req.resume(); }); }
      const now = Date.now();
      if (now - lastEmit > 40) { lastEmit = now; note('upload-progress', { tid, received, total }); }
    };
    out.on('error', (e) => fail('disk ' + (e.code || e.message)));
    req.on('data', onData);
    req.on('aborted', () => fail('aborted'));
    req.on('error', () => fail('error'));
    req.on('end', () => {
      if (finished) return;
      if (total && received < total) return fail('short');
      out.end(() => {
        if (finished) return;
        finished = true;
        this._release(tid, entry);
        if (entry.superseded) { removeTmp(); return; }
        if (quiet) return this.api.quietDone(res, { tid, tmpPath, name, size: received, kind: q.get('kind'), device: q.get('device') });
        this.emit('upload-progress', { tid, received, total: total || received });
        this.emit('upload-done', { tid, tmpPath, name, size: received, ms: Date.now() - t0 });
        this._json(res, 200, { ok: true, tid });
      });
    });
  }

  // A bundle striped over several connections (streams=K, stream=i): each stream is an ordinary bundle body carrying
  // some of the files; all of them write into one staging folder, and the transfer is done when every stream is.
  // A stream sent again (same "att") starts over and rewrites the files it had written; a new attempt replaces all.
  _handleBundleStream(req, res, q) {
    const clean = (v, n) => String(v || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, n);
    const tid = clean(q.get('tid'), 40) || rid(6);
    const att = clean(q.get('att'), 20) || 'a';
    const K = parseInt(q.get('streams'), 10), si = parseInt(q.get('stream'), 10);
    if (!(K >= 2 && K <= 8 && si >= 0 && si < K)) { req.resume(); return this._json(res, 400, { ok: false, error: 'bad stream' }); }
    const seen = this.partsSeen.get(tid + ':' + att);
    if (seen && seen.until > Date.now()) {
      req.resume();
      return seen.what === 'done' ? this._json(res, 200, { ok: true, stream: si, done: true }) : this._json(res, 410, { ok: false, error: 'aborted' });
    }
    let A = this.bundleAsm.get(tid);
    if (A && (A.att !== att || A.K !== K)) { if (A.att !== att) this._remember(tid, A.att, 'aborted'); this._dropBundleAsm(A, true); A = null; }
    if (!A) {
      if (!this._roomFor(+q.get('bytes') || 0)) { req.resume(); return this._json(res, 507, { ok: false, error: 'no space' }); }
      const old = this.uploads.get(tid);
      if (old) { old.superseded = true; try { old.req.destroy(); } catch (e) { /* ignore */ } }
      const pa = this.assemblies.get(tid);
      if (pa) this._dropAssembly(pa, true);
      const root = path.join(this.tmpDir, 'b-' + tid + '-' + att + '-' + rid(3));
      try { fs.mkdirSync(root, { recursive: true }); } catch (e) { req.resume(); return this._json(res, 500, { ok: false, error: 'staging' }); }
      A = { tid, att, K, root, shared: { taken: new Map(), tops: [], assigned: new Map() }, got: new Array(K).fill(0), done: new Array(K).fill(false),
        reqs: new Set(), manifest: null, total: +q.get('bytes') || 0, finished: false, superseded: false, t0: Date.now(), lastEmit: 0, active: Date.now() };
      this.bundleAsm.set(tid, A);
      this.emit('upload-start', { tid, name: 'bundle', total: A.total, streams: K });
    }
    if (A.finished) { req.resume(); return this._json(res, 409, { ok: false, error: 'finished' }); }
    A.reqs.add(req); A.active = Date.now();
    this._sweepSoon();
    A.got[si] = 0; A.done[si] = false;
    let over = false;
    const progress = () => {
      const now = Date.now();
      if (now - A.lastEmit < 40) return;
      A.lastEmit = now;
      this.emit('upload-progress', { tid, received: A.got.reduce((x, y) => x + y, 0), total: A.total });
    };
    const rx = new BundleReceiver(A.root, {
      onManifest: (m) => {
        if (A.manifest) return;
        A.manifest = m; A.total = +m.bytes || A.total;
        this.emit('bundle-manifest', { tid, files: +m.files || 0, bytes: +m.bytes || 0, roots: Array.isArray(m.roots) ? m.roots.slice(0, 500).map(String) : [] });
      },
      onProgress: (got) => { A.got[si] = got; A.active = Date.now(); progress(); },
    }, A.shared);
    const fail = (why, code) => {
      if (over) return;
      over = true;
      A.reqs.delete(req); A.active = Date.now();
      A.got[si] = 0;
      Promise.resolve().then(() => rx.abort()).catch(() => {});
      if (!res.headersSent) { try { this._json(res, code || 500, { ok: false, error: why }); } catch (e) { /* ignore */ } }
      try { req.destroy(); } catch (e) { /* ignore */ }
    };
    const complete = () => {
      if (over) return;
      if (!rx.done) return fail('short', 400);
      over = true;
      A.reqs.delete(req);
      A.done[si] = true;
      this._json(res, 200, { ok: true, stream: si });
      if (A.finished || A.superseded || !A.done.every(Boolean)) return progress();
      A.finished = true;
      this.bundleAsm.delete(tid);
      this._remember(tid, att, 'done');
      // the items in the order the phone listed them, whichever stream carried them
      const roots = (A.manifest && Array.isArray(A.manifest.roots)) ? A.manifest.roots.map(String) : [];
      const order = (x) => { const i = roots.indexOf(x); return i < 0 ? 1e9 : i; };
      const tops = A.shared.tops.slice().sort((a, b) => order(a) - order(b));
      const received = A.got.reduce((x, y) => x + y, 0);
      this.emit('upload-progress', { tid, received, total: A.total || received });
      this.emit('upload-done', { tid, tmpPath: A.root, name: tops.length === 1 ? tops[0] : tops.length + ' items', size: received, ms: Date.now() - A.t0, streams: K,
        bundle: { tops, files: +(A.manifest && A.manifest.files) || 0, bytes: received } });
    };
    const queue = [];
    let busy = false, ended = false;
    const pump = async () => {
      busy = true;
      try { while (queue.length && !over && !A.superseded) await rx.push(queue.shift()); } catch (e) { busy = false; return fail(e.message || 'bad bundle', 400); }
      busy = false;
      if (over || A.superseded) return;
      if (ended) return complete();
      req.resume();
    };
    req.on('data', (chunk) => { if (over || A.superseded) return; queue.push(chunk); if (!busy) { req.pause(); pump(); } });
    req.on('end', () => { ended = true; if (!busy) complete(); });
    req.on('aborted', () => fail('aborted'));
    req.on('error', () => fail('error'));
    // cut short in any other way (a replaced attempt destroys its requests): the open file is closed either way
    req.on('close', () => { if (!ended) fail('closed'); });
  }

  _dropBundleAsm(A, superseded) {
    A.superseded = !!superseded; A.finished = true;
    if (this.bundleAsm.get(A.tid) === A) this.bundleAsm.delete(A.tid);
    for (const r of A.reqs) { try { r.destroy(); } catch (e) { /* ignore */ } }
    A.reqs.clear();
    setTimeout(() => fs.rm(A.root, { recursive: true, force: true, maxRetries: 3 }, () => {}), 50);
  }

  // many files and folders in one streamed request (see bundle.js); staged in a folder of their own
  _handleBundle(req, res, q) {
    if (q.get('streams') && q.get('streams') !== '1') return this._handleBundleStream(req, res, q);
    const tid = (q.get('tid') || rid(6)).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40) || rid(6);
    const root = path.join(this.tmpDir, 'b-' + tid + '-' + rid(4));
    let finished = false;
    const entry = { req, path: root, superseded: false };
    this._claim(tid, entry);
    try { fs.mkdirSync(root, { recursive: true }); }
    catch (e) { this._release(tid, entry); return this._json(res, 500, { ok: false, error: 'staging' }); }
    const t0 = Date.now();
    let lastEmit = 0;
    const rx = new BundleReceiver(root, {
      onManifest: (m) => this.emit('bundle-manifest', { tid, files: +m.files || 0, bytes: +m.bytes || 0, roots: Array.isArray(m.roots) ? m.roots.slice(0, 500).map(String) : [] }),
      onProgress: (got, total) => { const now = Date.now(); if (now - lastEmit > 40) { lastEmit = now; this.emit('upload-progress', { tid, received: got, total }); } },
    });
    if (!this._roomFor(+q.get('bytes') || 0)) { this._release(tid, entry); fs.rm(root, { recursive: true, force: true }, () => {}); req.resume(); return this._json(res, 507, { ok: false, error: 'no space' }); }
    this.emit('upload-start', { tid, name: 'bundle', total: +q.get('bytes') || 0 });

    const fail = (why, code) => {
      if (finished) return;
      finished = true;
      this._release(tid, entry);
      Promise.resolve().then(() => rx.abort()).catch(() => {}).finally(() => fs.rm(root, { recursive: true, force: true, maxRetries: 3 }, () => {}));
      if (code && !res.headersSent) { try { this._json(res, code, { ok: false, error: why }); } catch (e) { /* ignore */ } }
      try { req.destroy(); } catch (e) { /* ignore */ }
      if (!entry.superseded) this.emit('upload-failed', { tid, why });
    };

    // one chunk at a time: the socket is paused while the previous chunk is written to disk
    const queue = [];
    let busy = false, ended = false;
    const pump = async () => {
      busy = true;
      try {
        while (queue.length && !finished) await rx.push(queue.shift());
      } catch (e) { fail(e.message || 'bad bundle', 400); return; }
      busy = false;
      if (finished) return;
      if (ended) return complete();
      req.resume();
    };
    const complete = () => {
      if (finished) return;
      if (!rx.done) return fail('short', 400);
      finished = true;
      this._release(tid, entry);
      if (entry.superseded) { fs.rm(root, { recursive: true, force: true }, () => {}); return; }
      this.emit('upload-progress', { tid, received: rx.received, total: rx.total || rx.received });
      this.emit('upload-done', { tid, tmpPath: root, name: rx.tops.length === 1 ? rx.tops[0] : rx.tops.length + ' items', size: rx.received, ms: Date.now() - t0, bundle: { tops: rx.tops.slice(), files: +(rx.manifest && rx.manifest.files) || 0, bytes: rx.received } });
      this._json(res, 200, { ok: true, tid });
    };
    req.on('data', (chunk) => { if (finished) return; queue.push(chunk); if (!busy) { req.pause(); pump(); } });
    req.on('end', () => { ended = true; if (!busy) complete(); });
    req.on('aborted', () => fail('aborted'));
    req.on('error', () => fail('error'));
    req.on('close', () => { if (!ended) fail('closed'); });
  }

  // One large file sent as several parts at once, each over its own connection (Wi-Fi moves more data that way),
  // written straight into place. A part that fails is sent again by the phone; a new attempt ("att") of the same
  // transfer replaces the old one.
  _handlePart(req, res, q) {
    const clean = (v, n) => String(v || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, n);
    const tid = clean(q.get('tid'), 40) || rid(6);
    const att = clean(q.get('att'), 20) || 'a';
    const index = parseInt(q.get('index'), 10), parts = parseInt(q.get('parts'), 10);
    const offset = Number(q.get('offset')), total = Number(q.get('total'));
    const len = parseInt(req.headers['content-length'] || '', 10);
    if (!(parts >= 1 && parts <= 16 && index >= 0 && index < parts && Number.isSafeInteger(offset) && Number.isSafeInteger(total) &&
      offset >= 0 && total >= 0 && len >= 0 && offset + len <= total)) {
      req.resume();
      return this._json(res, 400, { ok: false, error: 'bad part' });
    }
    const seen = this.partsSeen.get(tid + ':' + att);
    if (seen && seen.until > Date.now()) {
      req.resume();
      // already complete (its 200 got lost, say): the part is in. Aborted: stop sending.
      return seen.what === 'done' ? this._json(res, 200, { ok: true, index, done: true }) : this._json(res, 410, { ok: false, error: 'aborted' });
    }
    let asm = this.assemblies.get(tid);
    if (asm && (asm.att !== att || asm.total !== total || asm.parts !== parts)) {
      // a new attempt replaces this one; parts of the old attempt that still turn up are turned away, not let back in
      if (asm.att !== att) this._remember(tid, asm.att, 'aborted');
      this._dropAssembly(asm, true); asm = null;
    }
    if (!asm && !this._roomFor(total)) { req.resume(); return this._json(res, 507, { ok: false, error: 'no space' }); }
    if (!asm) {
      const old = this.uploads.get(tid);
      if (old) { old.superseded = true; try { old.req.destroy(); } catch (e) { /* ignore */ } }
      const p = path.join(this.tmpDir, tid + '-' + att + '-' + rid(3) + '.part');
      asm = { tid, att, total, parts, path: p, name: q.get('name') || 'file', got: new Array(parts).fill(0), done: new Array(parts).fill(false),
        reqs: new Set(), finished: false, superseded: false, t0: Date.now(), lastEmit: 0, active: Date.now() };
      // pre-size the file; if that fails (disk full) close it again rather than leaking the handle
      asm.fdP = fs.promises.open(p, 'w').then(async (fd) => {
        try { if (total) await fd.truncate(total); } catch (e) { await fd.close().catch(() => {}); throw e; }
        return fd;
      });
      asm.fdP.catch(() => {});
      this.assemblies.set(tid, asm);
      this.emit('upload-start', { tid, name: asm.name, total, parts });
    }
    if (asm.finished) { req.resume(); return this._json(res, 409, { ok: false, error: 'finished' }); }
    const A = asm;
    A.reqs.add(req); A.active = Date.now();
    this._sweepSoon();
    A.got[index] = 0; A.done[index] = false;      // a part sent again starts over
    let pos = offset, got = 0, queued = 0, writing = false, ended = false, over = false;
    const queue = [];
    const progress = () => {
      const now = Date.now();
      if (now - A.lastEmit < 40) return;
      A.lastEmit = now;
      this.emit('upload-progress', { tid, received: A.got.reduce((s, x) => s + x, 0), total });
    };
    const partFail = (why) => {
      if (over) return;
      over = true;
      A.reqs.delete(req); A.active = Date.now();
      A.got[index] = 0;
      if (!res.headersSent) { try { this._json(res, 500, { ok: false, error: why }); } catch (e) { /* ignore */ } }
      try { req.destroy(); } catch (e) { /* ignore */ }
    };
    const partDone = async () => {
      if (over) return;
      if (got !== len) return partFail('short');
      over = true;
      A.reqs.delete(req);
      A.done[index] = true;
      this._json(res, 200, { ok: true, index });
      if (A.finished || A.superseded || !A.done.every(Boolean)) return progress();
      A.finished = true;
      this.assemblies.delete(tid);
      this._remember(tid, A.att, 'done');
      try { await (await A.fdP).close(); } catch (e) { fs.unlink(A.path, () => {}); this.emit('upload-failed', { tid, why: 'disk' }); return; }
      this.emit('upload-progress', { tid, received: total, total });
      this.emit('upload-done', { tid, tmpPath: A.path, name: A.name, size: total, ms: Date.now() - A.t0, parts });
    };
    const pump = async () => {
      writing = true;
      try {
        const fd = await A.fdP;
        while (queue.length && !over && !A.superseded) {
          // write what has arrived in one go (fewer, larger writes)
          let n = 0, k = 0;
          while (k < queue.length && n < 4 * 1024 * 1024) n += queue[k++].length;
          // one writev for everything that has arrived: no copy into a joined buffer
          let bufs = queue.splice(0, k);
          queued -= n;
          let left = n;
          while (left > 0) {
            const r = await fd.writev(bufs, pos);
            pos += r.bytesWritten; left -= r.bytesWritten;
            if (left > 0) { let skip = r.bytesWritten; while (skip >= bufs[0].length) { skip -= bufs[0].length; bufs.shift(); } if (skip) bufs[0] = bufs[0].subarray(skip); }
          }
          if (req.isPaused() && queued < 4 * 1024 * 1024) req.resume();
        }
      } catch (e) { writing = false; return partFail('disk ' + (e.code || e.message)); }
      writing = false;
      if (ended && !queue.length) partDone();
    };
    req.on('data', (chunk) => {
      if (over || A.superseded) return;
      got += chunk.length;
      if (got > len) return partFail('too long');
      A.got[index] = got; A.active = Date.now();
      queue.push(chunk); queued += chunk.length;
      if (queued > 8 * 1024 * 1024) req.pause();
      if (!writing) pump();
      progress();
    });
    req.on('end', () => { ended = true; if (!writing) pump(); });
    req.on('aborted', () => partFail('aborted'));
    req.on('error', () => partFail('error'));
  }

  _dropAssembly(asm, superseded) {
    asm.superseded = !!superseded;
    asm.finished = true;
    if (this.assemblies.get(asm.tid) === asm) this.assemblies.delete(asm.tid);
    for (const r of asm.reqs) { try { r.destroy(); } catch (e) { /* ignore */ } }
    asm.reqs.clear();
    asm.fdP.then((fd) => fd.close()).catch(() => {}).finally(() => fs.unlink(asm.path, () => {}));
  }

  abortUpload(tid) {
    const e = this.uploads.get(tid);
    if (e) { try { e.req.destroy(); } catch (x) { /* ignore */ } }
    const a = this.assemblies.get(tid);
    if (a) { this._remember(tid, a.att, 'aborted'); this._dropAssembly(a, false); this.emit('upload-failed', { tid, why: 'aborted' }); }
    const b = this.bundleAsm.get(tid);
    if (b) { this._remember(tid, b.att, 'aborted'); this._dropBundleAsm(b, false); this.emit('upload-failed', { tid, why: 'aborted' }); }
  }

  /** files are on their way to the phone, or were just offered and not fetched yet: don't restart now */
  outgoingBusy() {
    if (this.streaming > 0) return true;
    if (!this.connected) return false;                // offered to a phone that's gone: it can't fetch them now
    const now = Date.now();
    for (const f of this.outgoing.values()) if (!f.doneSent && now - f.at < 2 * 60000) return true;
    return false;
  }

  offerFile(filePath, mime) {
    const st = fs.statSync(filePath);
    const fid = rid(8);
    // device: the phone it's offered to (the one in use), for the history once it has fetched it
    this.outgoing.set(fid, { path: filePath, name: path.basename(filePath), size: st.size, mime: mime || 'application/octet-stream', at: Date.now(), device: this.session ? this.session.device : null });
    setTimeout(() => this.outgoing.delete(fid), 30 * 60 * 1000);
    return { fid, name: path.basename(filePath), size: st.size };
  }

  // Whole file, or one byte range of it (the phone fetches large files in several ranges at once).
  _handleDownload(req, res, fid) {
    const f = this.outgoing.get(fid);
    if (!f) return this._json(res, 404, { ok: false });
    let st;
    try { st = fs.statSync(f.path); } catch (e) { return this._json(res, 404, { ok: false }); }
    let start = 0, end = st.size - 1, partial = false;
    const m = /^bytes=(\d+)-(\d*)$/.exec(String(req.headers.range || ''));
    if (m) {
      start = Number(m[1]); end = m[2] ? Math.min(Number(m[2]), st.size - 1) : st.size - 1;
      if (!(start <= end) || start >= st.size) { this._cors(res); res.writeHead(416, { 'Content-Range': 'bytes */' + st.size }); return res.end(); }
      partial = true;
    }
    this._cors(res);
    const headers = {
      'Content-Type': f.mime,
      'Content-Length': st.size ? end - start + 1 : 0,
      'Accept-Ranges': 'bytes',
      'Content-Disposition': 'attachment; filename*=UTF-8\'\'' + encodeURIComponent(f.name),
    };
    if (partial) headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + st.size;
    res.writeHead(partial ? 206 : 200, headers);
    if (!st.size) { res.end(); this.emit('download-done', { fid, total: 0 }); return; }
    const rs = fs.createReadStream(f.path, { highWaterMark: 1024 * 1024, start, end });
    this.streaming = (this.streaming || 0) + 1;
    res.on('close', () => { rs.destroy(); this.streaming = Math.max(0, (this.streaming || 0) - 1); });
    f.sent = f.sent || 0;
    let last = 0;
    rs.on('data', (c) => {
      f.sent += c.length;
      const now = Date.now();
      if (now - last > 50) { last = now; this.emit('download-progress', { fid, sent: Math.min(f.sent, st.size), total: st.size }); }
    });
    rs.on('end', () => { if (f.sent >= st.size && !f.doneSent) { f.doneSent = true; this.emit('download-done', { fid, total: st.size }); } });
    rs.on('error', () => { try { res.destroy(); } catch (e) { /* ignore */ } });
    rs.pipe(res);
  }
}

module.exports = { FlickServer, lanAddresses, rid, pairCode, PROTO };
