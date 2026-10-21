'use strict';
// Protocol 5 (SPEC §2-§4): what a phone reaches without the fling gesture. The background link (/api/events: one ndjson
// stream per phone, for its LinkService), its clipboard, links, notifications, the answer to files it sends quietly
// (auto-send, tile, widget) and two-way folder sync (sync.js does the files). server.js hands requests here after its
// host/origin check; every route needs the phone's device + token like /api/upload (_trustedReq: a phone that signed in
// over a secure link is refused on a plain one). What arrives is passed on as server events for features.js:
//   'clip-in' {device, name, kind, text | png}   'link-in' {device, name, url}   'notify-in' {device, name, key, pkg, app,
//   title, text, time, removed}   'media' {device, key}   'ring-found' {device}   'stream' {device, open}
const JSON_MAX = 6 * 1024 * 1024;             // JSON bodies
const CLIP_MAX = 9 * 1024 * 1024;             // POST /api/clip: a 6 MB PNG as base64 inside JSON
const CLIP_TEXT_MAX = 1024 * 1024;            // clipboard text, UTF-8 bytes
const CLIP_PNG_MAX = 6 * 1024 * 1024;         // clipboard image, decoded
const URL_MAX = 4096;
const NOTE_STR_MAX = 2048;                    // each string of a notification
const STREAM_BACKLOG = 16 * 1024 * 1024;      // a stream nobody reads is closed rather than buffered without end
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MEDIA_KEYS = new Set(['play', 'next', 'prev', 'vol-up', 'vol-down', 'mute']);
const QUIET_KINDS = new Set(['screenshot', 'photo', 'share']);

const ROUTES = {
  '/api/events': 'GET', '/api/clip': 'POST', '/api/link': 'POST', '/api/notify': 'POST',
  '/api/sync/pair': 'POST', '/api/sync/list': 'GET', '/api/sync/get': 'GET', '/api/sync/put': 'POST', '/api/sync/unpair': 'POST',
};

/** An http(s) link a phone or the user gave, normalized, or null. */
function cleanUrl(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s || s.length > URL_MAX || /[\u0000- \u007f]/.test(s)) return null;
  let u;
  try { u = new URL(s); } catch (e) { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;   // "https://bank.example@evil.example" reads as one site and opens another
  return u.href.length <= URL_MAX ? u.href : null;
}

class PhoneApi {
  constructor(server, opts = {}) {
    this.s = server;
    this.proto = opts.proto || 5;
    this.pingMs = opts.pingMs || 20000;
    this.streams = new Map();   // device -> { device, req, res, at, open, ping }
    this.notes = new Map();     // "device|key" -> { text, at }: the same notification again within 10 s is dropped
    this.feat = { clip: true, notify: true };   // the PC's settings (features.js keeps them current): off -> 409 'off'
  }

  /** Handles a protocol 5 route (true), or leaves the request to server.js (false). */
  handle(req, res, u) {
    const want = ROUTES[u.pathname];
    if (!want) return false;
    const q = u.searchParams;
    if (req.method !== want) { this._refuse(req, res, 405, 'method'); return true; }
    const device = q.get('device');
    if (!this.s._trustedReq(req, device, q.get('token'))) { this._refuse(req, res, 403, 'not paired'); return true; }
    // a phone paired before 1.9 (its token crossed the network in the clear), or any plain link: none of this
    if (!this.s._v5ok(device, this.s._chan(req.socket))) { this._refuse(req, res, 403, 'pair again'); return true; }
    let p;
    switch (u.pathname) {
      case '/api/events': this._openStream(req, res, device); return true;
      case '/api/clip': p = this._post(req, res, CLIP_MAX, (b) => this.clipIn(device, b)); break;
      case '/api/link': p = this._post(req, res, JSON_MAX, (b) => this.linkIn(device, b)); break;
      case '/api/notify': p = this._post(req, res, JSON_MAX, (b) => this.notifyIn(device, b)); break;
      case '/api/sync/pair': p = this._syncPair(req, res, device); break;
      case '/api/sync/list': p = this._sync(req, res).then((sy) => sy && sy.list(device, q.get('pair')).then((r) => this.s._json(res, 200, Object.assign({ ok: true }, r)))); break;
      case '/api/sync/get': p = this._syncGet(req, res, device, q); break;
      case '/api/sync/put': p = this._syncPut(req, res, device, q); break;
      case '/api/sync/unpair': p = this._sync(req, res).then((sy) => { if (sy) { sy.unpair(device, q.get('pair')); this.s._json(res, 200, { ok: true }); } }); break;
      default: return false;
    }
    Promise.resolve(p).catch((e) => {
      if (!e || !e.status) this.s.emit('log', 'phone request failed: ' + u.pathname + ' ' + ((e && e.message) || e));
      this._refuse(req, res, (e && e.status) || 500, (e && e.why) || 'error');
    });
    return true;
  }

  // an error answer; a request whose body is still coming isn't read to the end (the connection closes after it)
  _refuse(req, res, code, error) {
    if (res.headersSent || res.destroyed) return;
    const early = !req.complete;
    if (early) res.setHeader('Connection', 'close');
    this.s._json(res, code, { ok: false, error });
    if (early) res.once('finish', () => setTimeout(() => { try { req.destroy(); } catch (e) { /* ignore */ } }, 200));
  }

  _body(req, max) {
    return new Promise((resolve) => {
      const len = parseInt(req.headers['content-length'] || '', 10);
      if (len > max) return resolve({ code: 413, error: 'too big' });
      const parts = [];
      let n = 0, over = false;
      const end = (r) => { if (!over) { over = true; resolve(r); } };
      req.on('data', (c) => {
        if (over) return;
        n += c.length;
        if (n > max) return end({ code: 413, error: 'too big' });
        parts.push(c);
      });
      req.on('end', () => end({ buf: Buffer.concat(parts, n) }));
      req.on('error', () => end({ code: 400, error: 'aborted' }));
      req.on('close', () => { if (!req.complete) end({ code: 400, error: 'aborted' }); });
    });
  }

  async _readJson(req, max) {
    const b = await this._body(req, max);
    if (b.error) return b;
    let o;
    try { o = JSON.parse(b.buf.toString('utf8')); } catch (e) { return { code: 400, error: 'bad json' }; }
    if (!o || typeof o !== 'object' || Array.isArray(o)) return { code: 400, error: 'bad json' };
    return { obj: o };
  }

  // a JSON POST answered by fn(body) -> { ok... } | { code, error }
  async _post(req, res, max, fn) {
    const b = await this._readJson(req, max);
    if (b.error) return this._refuse(req, res, b.code, b.error);
    const r = fn(b.obj);
    if (r.error) return this._refuse(req, res, r.code || 400, r.error);
    this.s._json(res, 200, r);
  }

  /** The phone's name as the PC knows it: its page's hello, else the name it paired with. */
  nameOf(device) {
    const s = this.s._pageFor(device);
    if (s && s.name) return s.name;
    const d = device && this.s.devices[device];
    return (d && d.name) || 'Phone';
  }

  // ---------- the background link: GET /api/events ----------
  _openStream(req, res, device) {
    const old = this.streams.get(device);
    if (old) this._endStream(old);                              // a newer stream from the same phone replaces it
    this.s._cors(res);
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    try { req.socket.setNoDelay(true); req.socket.setKeepAlive(true, 15000); req.socket.setTimeout(0); } catch (e) { /* ignore */ }
    const st = { device, req, res, at: Date.now(), open: true, ping: null };
    this.streams.set(device, st);
    st.ping = setInterval(() => this._line(st, { t: 'ping' }), this.pingMs);
    if (st.ping.unref) st.ping.unref();
    res.on('close', () => this._gone(st));                       // the phone went away (or the stream was ended)
    this._line(st, { t: 'hello', v: this.proto, pc: { id: this.s.id, name: this.s.name } });
    this.s.emit('stream', { device, open: true });
  }

  _line(st, obj) {
    if (!st.open || st.res.destroyed) return false;
    if (st.res.writableLength > STREAM_BACKLOG) { this._endStream(st, true); return false; }
    st.res.write(JSON.stringify(obj) + '\n');
    return true;
  }

  _gone(st) {
    if (!st.open) return;
    st.open = false;
    clearInterval(st.ping);
    if (this.streams.get(st.device) === st) { this.streams.delete(st.device); this.s.emit('stream', { device: st.device, open: false }); }
  }

  _endStream(st, hard) {
    try { st.res.end(); } catch (e) { /* ignore */ }
    if (hard) { try { st.req.socket.destroy(); } catch (e) { /* ignore */ } }
    this._gone(st);
  }

  /** An event line for this phone's background link; false when it has none open. */
  streamSend(device, obj) { const st = device && this.streams.get(device); return st ? this._line(st, obj) : false; }
  streamDevices() { return [...this.streams.keys()]; }
  streamOpenedAt(device) { const st = this.streams.get(device); return st ? st.at : 0; }
  /** The phone's pairing was removed: its link ends now. */
  closeStream(device) { const st = this.streams.get(device); if (st) this._endStream(st, true); }
  stop() { for (const st of [...this.streams.values()]) this._endStream(st, true); }

  // ---------- clipboard, links, notifications (POST or the page's WebSocket) ----------
  /** A clipboard from a phone: { ok } or { code, error }. */
  clipIn(device, b) {
    if (!this.feat.clip) return { code: 409, error: 'off' };
    if (b.kind === 'text') {
      if (typeof b.text !== 'string' || !b.text) return { code: 400, error: 'empty' };
      if (Buffer.byteLength(b.text, 'utf8') > CLIP_TEXT_MAX) return { code: 413, error: 'too big' };
      this.s.emit('clip-in', { device, name: this.nameOf(device), kind: 'text', text: b.text });
      return { ok: true };
    }
    if (b.kind === 'image') {
      if (typeof b.png !== 'string' || !b.png) return { code: 400, error: 'empty' };
      const b64 = b.png.replace(/^data:image\/png;base64,/, '');
      if (b64.length > Math.ceil(CLIP_PNG_MAX / 3) * 4 + 16) return { code: 413, error: 'too big' };
      const png = Buffer.from(b64, 'base64');
      if (png.length > CLIP_PNG_MAX) return { code: 413, error: 'too big' };
      if (png.length < 8 || !png.subarray(0, 8).equals(PNG_SIG)) return { code: 400, error: 'not png' };
      this.s.emit('clip-in', { device, name: this.nameOf(device), kind: 'image', png });
      return { ok: true };
    }
    return { code: 400, error: 'bad kind' };
  }

  /** A link to open on the PC (http/https only): { ok } or { code, error }. */
  linkIn(device, b) {
    const url = cleanUrl(b.url);
    if (!url) return { code: 400, error: 'bad url' };
    this.s.emit('link-in', { device, name: this.nameOf(device), url });
    return { ok: true };
  }

  /** A phone notification to show (or, removed: true, to withdraw): { ok } or { code, error }. */
  notifyIn(device, b) {
    if (!this.feat.notify && b.removed !== true) return { code: 409, error: 'off' };   // withdrawing one still works
    const str = (v) => (typeof v === 'string' ? v.slice(0, NOTE_STR_MAX) : typeof v === 'number' ? String(v) : '');
    const n = { key: str(b.key), pkg: str(b.pkg), app: str(b.app), title: str(b.title), text: str(b.text), time: Number(b.time) || Date.now(), removed: b.removed === true };
    if (!n.key) n.key = n.pkg + '|' + n.title;
    if (!n.removed && !n.title && !n.text) return { code: 400, error: 'empty' };
    const k = device + '|' + n.key, now = Date.now();
    // at most 5 new notifications a second from one phone (it throttles too; this keeps a misbehaving one from
    // burying the screen)
    if (!n.removed) {
      this.noteRate = this.noteRate || new Map();
      const r = (this.noteRate.get(device) || []).filter((t) => now - t < 1000);
      if (r.length >= 5) { this.noteRate.set(device, r); return { code: 429, error: 'slow down' }; }
      r.push(now); this.noteRate.set(device, r);
    }
    for (const [x, v] of this.notes) if (now - v.at > 10000) this.notes.delete(x);
    if (n.removed) this.notes.delete(k);
    else {
      // the same notification again within 10 s (an app re-posting it, the phone retrying): shown once
      const prev = this.notes.get(k);
      if (prev && prev.text === n.text) return { ok: true, dup: true };
      this.notes.set(k, { text: n.text, at: now });
    }
    this.s.emit('notify-in', Object.assign({ device, name: this.nameOf(device) }, n));
    return { ok: true };
  }

  /** Protocol 5 messages from a signed-in page (§3): media, clip, link, ring-found. */
  fromPage(s, m) {
    switch (m.t) {
      case 'media':
        if (MEDIA_KEYS.has(m.key)) this.s.emit('media', { device: s.device, key: m.key });
        break;
      case 'clip': { const r = this.clipIn(s.device, m); if (r.error && r.error !== 'off') this.s.emit('log', 'clipboard from a phone refused: ' + r.error); break; }
      case 'link': { const r = this.linkIn(s.device, m); if (r.error) this.s.emit('log', 'link from a phone refused: ' + r.error); break; }
      case 'ring-found': this.s.emit('ring-found', { device: s.device }); break;
      default: break;
    }
  }

  // ---------- quiet uploads (POST /api/upload?quiet=1, server.js _handleUpload) ----------
  /** All of it arrived: save it like any received file (server.quietSave, set by features.js), then answer. */
  async quietDone(res, f) {
    const kind = QUIET_KINDS.has(f.kind) ? f.kind : 'share';
    let r = null, err = null;
    if (this.s.quietSave) {
      try { r = await this.s.quietSave({ tid: f.tid, tmpPath: f.tmpPath, name: f.name, size: f.size, kind, device: f.device, phone: this.nameOf(f.device) }); }
      catch (e) { err = e; }
    }
    if (!r) {
      require('fs').rm(f.tmpPath, { force: true }, () => {});
      this.s.emit('log', 'a file sent quietly could not be saved: ' + (err ? err.message : 'nothing saves it'));
      return this.s._json(res, err ? 500 : 503, { ok: false, error: err ? 'save' : 'not ready' });
    }
    this.s._json(res, 200, { ok: true, tid: f.tid, name: r.name, where: r.where || '' });
  }

  // ---------- folder sync (sync.js) ----------
  async _sync(req, res) {
    if (this.s.sync) return this.s.sync;
    this._refuse(req, res, 503, 'sync off');
    return null;
  }

  async _syncPair(req, res, device) {
    const sy = await this._sync(req, res);
    if (!sy) return;
    const b = await this._readJson(req, JSON_MAX);
    if (b.error) return this._refuse(req, res, b.code, b.error);
    const r = await sy.pair(device, this.nameOf(device), b.obj.name);
    this.s._json(res, 200, { ok: true, pair: r.id, folder: r.folder });
  }

  async _syncGet(req, res, device, q) {
    const sy = await this._sync(req, res);
    if (!sy) return;
    const f = await sy.open(device, q.get('pair'), q.get('p'));
    this.s._cors(res);
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': f.size, 'X-Flick-Mtime': String(f.mtime), 'Cache-Control': 'no-store' });
    if (!f.size) { await f.fh.close().catch(() => {}); res.end(); sy.sent(device, this.nameOf(device), f); return; }
    const rs = f.fh.createReadStream({ start: 0, end: f.size - 1, highWaterMark: 1024 * 1024 });
    let n = 0;
    rs.on('data', (c) => { n += c.length; });
    rs.on('error', () => { try { res.destroy(); } catch (e) { /* ignore */ } });
    rs.on('end', () => { if (n >= f.size) sy.sent(device, this.nameOf(device), f); });
    res.on('close', () => rs.destroy());
    rs.pipe(res);
  }

  async _syncPut(req, res, device, q) {
    const sy = await this._sync(req, res);
    if (!sy) return;
    const mtime = Number(q.get('mtime')), size = Number(q.get('size'));
    if (!Number.isSafeInteger(mtime) || mtime < 0 || !Number.isSafeInteger(size) || size < 0) return this._refuse(req, res, 400, 'bad request');
    const clen = req.headers['content-length'];
    if (clen !== undefined && Number(clen) !== size) return this._refuse(req, res, 400, 'size');
    if (!this.s._roomFor(size)) return this._refuse(req, res, 507, 'no space');
    const r = await sy.put(device, this.nameOf(device), q.get('pair'), q.get('p'), mtime, size, req);
    this.s._json(res, 200, { ok: true, stored: r.stored });
  }
}

module.exports = { PhoneApi, cleanUrl, MEDIA_KEYS };
