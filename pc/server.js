'use strict';
// Flick PC server: HTTP (uploads/downloads) + WebSocket (live drag stream) + UDP discovery.
// Pure Node so it can be tested without Electron.
const http = require('http');
const dgram = require('dgram');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');
const { EventEmitter } = require('events');
const { acceptUpgrade } = require('./ws');
const { BundleReceiver } = require('./bundle');

const PROTO = 2;   // 2: large files in parallel parts (/api/part) and byte ranges

function rid(n = 12) { return crypto.randomBytes(n).toString('hex'); }

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
    this.session = null;   // active phone session
    this.uploads = new Map();   // tid -> { req, path }
    this.assemblies = new Map(); // tid -> a large file arriving in parallel parts (see _handlePart)
    this.outgoing = new Map();  // fid -> { path, name, size, mime }
    this.pending = new Map();   // deviceId -> session awaiting approval
    this.phoneApp = null;       // newest phone app this PC can hand out: { path, code, name, size, sha256 }
    fs.mkdirSync(this.tmpDir, { recursive: true });
  }

  // ---------- phone app updates ----------
  _appPublic() {
    const a = this.phoneApp;
    return a ? { code: a.code, name: a.name, size: a.size, sha256: a.sha256, url: '/api/app.apk' } : null;
  }

  /** The phone decides for itself whether this is newer than what it runs; `always` answers a "check for updates". */
  setPhoneApp(info, always) {
    const prev = this.phoneApp;
    this.phoneApp = info ? { path: info.path, code: info.code, name: info.name, size: info.size, sha256: info.sha256 } : null;
    const changed = !prev !== !info || (prev && info && (prev.sha256 !== info.sha256 || prev.path !== info.path));
    if (changed || always) this.pushToPhone({ t: 'app', app: this._appPublic() });
  }

  // ---------- lifecycle ----------
  async start() {
    this.http = http.createServer((req, res) => this._onRequest(req, res));
    this.http.on('upgrade', (req, socket, head) => this._onUpgrade(req, socket, head));
    this.http.keepAliveTimeout = 30000;
    this.http.requestTimeout = 0; // large uploads
    this.http.headersTimeout = 20000;
    let lastErr;
    for (let p = this.basePort; p < this.basePort + 6; p++) {
      try {
        await new Promise((resolve, reject) => {
          const onErr = (e) => { this.http.removeListener('listening', onOk); reject(e); };
          const onOk = () => { this.http.removeListener('error', onErr); resolve(); };
          this.http.once('error', onErr);
          this.http.once('listening', onOk);
          this.http.listen(p, '0.0.0.0');
        });
        this.port = p;
        break;
      } catch (e) { lastErr = e; }
    }
    if (!this.port) throw lastErr || new Error('No free port');
    this._startDiscovery();
    return this.port;
  }

  stop() {
    try { this.http && this.http.close(); } catch (e) { /* ignore */ }
    try { this.udp && this.udp.close(); } catch (e) { /* ignore */ }
    if (this.session && this.session.conn) this.session.conn.close();
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
        known: !!(m.id && this.devices[m.id]),
      }));
      sock.send(reply, rinfo.port, rinfo.address, () => {});
      this.emit('discovered-by', { address: rinfo.address, name: m.name });
    });
    sock.bind(this.discoveryPort, () => {
      try { sock.setBroadcast(true); } catch (e) { /* ignore */ }
    });
  }

  setName(name) { this.name = String(name || '').slice(0, 60) || this.name; this.pushToPhone({ t: 'pc', name: this.name }); }

  setSettings(s) {
    Object.assign(this.settings, s);
    this.pushToPhone({ t: 'settings', side: this.settings.side, anchor: this.settings.anchor, theme: this.settings.theme });
  }

  // ---------- trust ----------
  _trusted(device, token) {
    const d = device && this.devices[device];
    return !!(d && token && d.token === token);
  }

  approve(device) {
    const s = this.pending.get(device);
    this.pending.delete(device);
    const token = rid(16);
    this.devices[device] = { name: (s && s.name) || 'Phone', token, added: Date.now() };
    this.emit('devices-changed', this.devices);
    this.emit('pair-cancel', device);
    if (s && s.conn && s.conn.open) {
      s.trusted = true;
      s.token = token;
      s.conn.send({ t: 'paired', token });
      this._connected(s);
    }
  }

  deny(device) {
    const s = this.pending.get(device);
    this.pending.delete(device);
    this.emit('pair-cancel', device);
    if (s && s.conn && s.conn.open) s.conn.send({ t: 'denied' });
  }

  forget(device) {
    delete this.devices[device];
    this.emit('devices-changed', this.devices);
    if (this.session && this.session.device === device) { this.session.conn.close(); }
  }

  // ---------- phone messaging ----------
  pushToPhone(obj) {
    const s = this.session;
    if (s && s.conn && s.conn.open && s.trusted) { s.conn.send(obj); return true; }
    return false;
  }

  get connected() { return !!(this.session && this.session.connected && this.session.conn.open); }

  _connected(s) {
    s.connected = true;
    s.conn.send({ t: 'connected', pc: { id: this.id, name: this.name }, side: this.settings.side, anchor: this.settings.anchor, theme: this.settings.theme, app: this._appPublic() });
    this.emit('connected', this._publicSession(s));
  }

  _publicSession(s) {
    return { device: s.device, name: s.name, screen: s.screen, address: s.address, app: s.app || 0, appName: s.appName || '', via: s.via || '' };
  }

  _onUpgrade(req, socket, head) {
    let u;
    try { u = new URL(req.url, 'http://x'); } catch (e) { socket.destroy(); return; }
    if (u.pathname !== '/ws') { socket.destroy(); return; }
    const conn = acceptUpgrade(req, socket, head);
    if (!conn) return;
    const s = { conn, device: null, name: 'Phone', trusted: false, connected: false, screen: null, address: socket.remoteAddress };
    conn.on('message', (txt) => {
      let m;
      try { m = JSON.parse(txt); } catch (e) { return; }
      this._onPhoneMessage(s, m);
    });
    conn.on('close', () => {
      if (this.session === s) {
        this.session = null;
        this.emit('disconnected', this._publicSession(s));
      }
      if (s.device && this.pending.get(s.device) === s) {
        this.pending.delete(s.device);
        this.emit('pair-cancel', s.device);
      }
    });
  }

  _onPhoneMessage(s, m) {
    switch (m.t) {
      case 'hello': {
        s.device = String(m.device || '').slice(0, 64);
        s.name = String(m.name || 'Phone').slice(0, 60);
        s.screen = { w: +m.w || 400, h: +m.h || 860, dpr: +m.dpr || 2 };
        s.app = Math.max(0, Math.floor(+m.app || 0));          // phone app version code (0 = before 1.4)
        s.appName = String(m.appName || '').slice(0, 20);
        s.via = /^(wifi|usb|hotspot|direct|ethernet|bluetooth)$/.test(m.via) ? m.via : (s.via || '');
        s.trusted = this._trusted(s.device, m.token);
        s.token = s.trusted ? m.token : null;
        // Newest phone session wins.
        if (this.session && this.session !== s) {
          try { this.session.conn.send({ t: 'replaced' }); this.session.conn.close(); } catch (e) { /* ignore */ }
        }
        this.session = s;
        s.conn.send({ t: 'welcome', v: PROTO, pc: { id: this.id, name: this.name }, trusted: s.trusted, side: this.settings.side, anchor: this.settings.anchor, theme: this.settings.theme });
        this.emit('phone-hello', this._publicSession(s));
        if (m.resume && s.trusted) this._connected(s);
        break;
      }
      case 'screen':
        s.screen = { w: +m.w || 400, h: +m.h || 860, dpr: +m.dpr || 2 };
        break;
      case 'hold':
        if (this.session === s) this.emit('hold', { p: Math.max(0, Math.min(1, +m.p || 0)) });
        break;
      case 'hold-cancel':
        if (this.session === s) this.emit('hold', { p: 0, cancel: true });
        break;
      case 'connect':
        if (this.session !== s) return;
        if (s.trusted) this._connected(s);
        else {
          this.pending.set(s.device, s);
          s.conn.send({ t: 'pairing' });
          this.emit('pair-request', this._publicSession(s));
        }
        break;
      case 'lift': case 'move': case 'drop': case 'cancel': case 'send':
        if (this.session === s && s.trusted) this.emit(m.t, m);
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
        if (s.trusted && this.session === s) this.emit('app-check');
        break;
      case 'ping':
        s.conn.send({ t: 'pong', ts: m.ts });
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
    if (req.method === 'OPTIONS') { this._cors(res); res.writeHead(204); res.end(); return; }
    const q = u.searchParams;
    if (req.method === 'GET' && u.pathname === '/api/hello') {
      return this._json(res, 200, { app: 'flick', v: PROTO, id: this.id, name: this.name, port: this.port });
    }
    if (req.method === 'POST' && u.pathname === '/api/upload') {
      if (!this._trusted(q.get('device'), q.get('token'))) return this._json(res, 403, { ok: false, error: 'not paired' });
      return this._handleUpload(req, res, q);
    }
    if (req.method === 'POST' && u.pathname === '/api/part') {
      if (!this._trusted(q.get('device'), q.get('token'))) return this._json(res, 403, { ok: false, error: 'not paired' });
      return this._handlePart(req, res, q);
    }
    if (req.method === 'POST' && u.pathname === '/api/bundle') {
      if (!this._trusted(q.get('device'), q.get('token'))) return this._json(res, 403, { ok: false, error: 'not paired' });
      return this._handleBundle(req, res, q);
    }
    if (req.method === 'GET' && u.pathname.startsWith('/api/file/')) {
      if (!this._trusted(q.get('device'), q.get('token'))) return this._json(res, 403, { ok: false, error: 'not paired' });
      return this._handleDownload(req, res, decodeURIComponent(u.pathname.slice('/api/file/'.length)));
    }
    if (req.method === 'GET' && u.pathname === '/api/app.apk') {
      if (!this._trusted(q.get('device'), q.get('token'))) return this._json(res, 403, { ok: false, error: 'not paired' });
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

  // A new attempt for a transfer the phone is retrying replaces the earlier one, which may still be running or
  // failing: each attempt writes its own file, and a replaced attempt never reports anything.
  _claim(tid, entry) {
    const old = this.uploads.get(tid);
    if (old && old !== entry) { old.superseded = true; try { old.req.destroy(); } catch (e) { /* ignore */ } }
    this.uploads.set(tid, entry);
  }
  _release(tid, entry) { if (this.uploads.get(tid) === entry) this.uploads.delete(tid); }

  _handleUpload(req, res, q) {
    const tid = (q.get('tid') || rid(6)).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40) || rid(6);
    const name = q.get('name') || 'file';
    // the request's own length is exact; the phone's size hint can be stale (media index)
    const clen = parseInt(req.headers['content-length'] || '', 10);
    const total = clen >= 0 ? clen : (parseInt(q.get('size') || '0', 10) || 0);
    const tmpPath = path.join(this.tmpDir, tid + '-' + rid(4) + '.part');
    const entry = { req, path: tmpPath, superseded: false };
    this._claim(tid, entry);
    const out = fs.createWriteStream(tmpPath, { highWaterMark: 1024 * 1024 });
    let received = 0;
    let lastEmit = 0;
    let finished = false;
    const t0 = Date.now();
    this.emit('upload-start', { tid, name, total });

    const removeTmp = () => { if (out.closed) fs.unlink(tmpPath, () => {}); else out.once('close', () => fs.unlink(tmpPath, () => {})); };
    const fail = (why) => {
      if (finished) return;
      finished = true;
      this._release(tid, entry);
      req.removeListener('data', onData);
      out.destroy();
      removeTmp();
      if (!entry.superseded) this.emit('upload-failed', { tid, why });
      if (!res.headersSent) { try { this._json(res, why === 'short' ? 400 : 500, { ok: false, error: why }); } catch (e) { /* ignore */ } }
      try { req.destroy(); } catch (e) { /* ignore */ }
    };
    const onData = (chunk) => {
      if (finished) return;
      received += chunk.length;
      if (!out.write(chunk)) { req.pause(); out.once('drain', () => { if (!finished) req.resume(); }); }
      const now = Date.now();
      if (now - lastEmit > 40) { lastEmit = now; this.emit('upload-progress', { tid, received, total }); }
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
        this.emit('upload-progress', { tid, received, total: total || received });
        this.emit('upload-done', { tid, tmpPath, name, size: received, ms: Date.now() - t0 });
        this._json(res, 200, { ok: true, tid });
      });
    });
  }

  // many files and folders in one streamed request (see bundle.js); staged in a folder of their own
  _handleBundle(req, res, q) {
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
    let asm = this.assemblies.get(tid);
    if (asm && (asm.att !== att || asm.total !== total || asm.parts !== parts)) { this._dropAssembly(asm, true); asm = null; }
    if (!asm) {
      const old = this.uploads.get(tid);
      if (old) { old.superseded = true; try { old.req.destroy(); } catch (e) { /* ignore */ } }
      const p = path.join(this.tmpDir, tid + '-' + att + '-' + rid(3) + '.part');
      asm = { tid, att, total, parts, path: p, name: q.get('name') || 'file', got: new Array(parts).fill(0), done: new Array(parts).fill(false),
        reqs: new Set(), finished: false, superseded: false, t0: Date.now(), lastEmit: 0 };
      asm.fdP = fs.promises.open(p, 'w').then(async (fd) => { if (total) await fd.truncate(total); return fd; });
      asm.fdP.catch(() => {});
      this.assemblies.set(tid, asm);
      this.emit('upload-start', { tid, name: asm.name, total, parts });
    }
    if (asm.finished) { req.resume(); return this._json(res, 409, { ok: false, error: 'finished' }); }
    const A = asm;
    A.reqs.add(req);
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
      A.reqs.delete(req);
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
      try { await (await A.fdP).close(); } catch (e) { this.emit('upload-failed', { tid, why: 'disk' }); return; }
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
          const chunk = k === 1 ? queue.shift() : Buffer.concat(queue.splice(0, k), n);
          queued -= chunk.length;
          let w = 0;
          while (w < chunk.length) { const r = await fd.write(chunk, w, chunk.length - w, pos); w += r.bytesWritten; pos += r.bytesWritten; }
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
      A.got[index] = got;
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
    if (a) { this._dropAssembly(a, false); this.emit('upload-failed', { tid, why: 'aborted' }); }
  }

  offerFile(filePath, mime) {
    const st = fs.statSync(filePath);
    const fid = rid(8);
    this.outgoing.set(fid, { path: filePath, name: path.basename(filePath), size: st.size, mime: mime || 'application/octet-stream' });
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
    res.on('close', () => rs.destroy());
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

module.exports = { FlickServer, lanAddresses, rid };
