'use strict';
// Sending to other Flick devices: another PC, or a phone that takes files from other devices. They're found on the
// network the way a phone finds a PC (discovery), paired once with the 6-digit code, and signed in to the way a phone
// signs in to a PC: server.js is the other side, and to it this PC is a "peer" (it only sends files there). Pairing
// goes both ways at once: right after it, this PC gives the other device a token for its own receiver, and its
// certificate ('peer-back'), so either one can send to the other from then on.
//
// Pure Node, so it can be tested without Electron.
const tls = require('tls');
const http = require('http');
const dgram = require('dgram');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { isUtf8 } = require('buffer');
const { EventEmitter } = require('events');

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const hmac = (key, s) => crypto.createHmac('sha256', String(key)).update(s).digest('hex');
const rid = (n) => crypto.randomBytes(n).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE = 4 * 1024 * 1024;
const MAX_PIECES = 4096;           // pieces of one fragmented message (as in ws.js: empty ones cost memory too)
const MAX_QUEUED = 8 * 1024 * 1024, PONG_QUEUED = 64 * 1024;   // what may wait to be sent on a link (see WsClient._frame)
const MAX_FILES = 100000;              // in one send (a bundle can hold more; this is plenty)
const MAX_DIRS = 50000;                // folders in one send
const MAX_FOUND = 64;                  // devices answering discovery that are kept (the paired ones always are)
const SEEN_MS = 12000;                 // a device that hasn't answered discovery for this long isn't nearby any more
const SCAN_MS = 3000;                  // how often discovery asks while the list is open
const IDLE_MS = 60000;                 // a link nothing was sent over for this long is closed
const RENAME_LOOK_MS = 4000;           // renamed: how long the paired computers are looked for, to sign in to them
// all of it went but the answer to the upload was lost (its connection broke): the other device says over the link that
// all of it came ('got') as it does, so nothing within this long means it never all came
const GOT_MS = 10000;
// an upload with nothing moving for this long is given up (see _post)
const STALL_MS = 30000;
// What went into an upload's connection can take long to arrive over a slow link: its network holds up to this much in
// flight, carried at no less than this pace (a slow Wi-Fi). A device that doesn't say how much came ('recv') is waited
// for that long once all of it went.
const IN_FLIGHT = 8 * 1024 * 1024, SLOW_RATE = 64 * 1024;
// What a device that says how much came reports keeps the wait going only while it shows the rest coming at this pace
// at least (a link far slower than any Wi-Fi): one that keeps saying a byte more came (a broken device, or one that
// means to) is given up on as soon as one that says nothing (see _replies and _post).
const MIN_RATE = 8 * 1024;
// the animations a card can arrive with (pc/overlay/looks, phone/app.js LOOKS)
const LOOKS = ['meteor', 'volt', 'warp', 'glitch'];

function pairCode(chan, nonceP, nonceS) {
  const n = parseInt(sha256('flick-pair-v1|' + chan + '|' + nonceP + '|' + nonceS).slice(0, 8), 16) % 1000000;
  return String(n).padStart(6, '0');
}
function sameHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !/^[0-9a-f]{64}$/.test(a) || !/^[0-9a-f]{64}$/.test(b)) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}
const fail = (message, code) => Object.assign(new Error(message), { code });
// A device's id as another device gives it: letters, digits, _ and -, and never a name every object has ("__proto__",
// "constructor"): ids are keys of the pairings here and in the receiver (server.devices), where such a one would replace
// the table's prototype instead of being kept
const idOk = (x) => typeof x === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(x) && !Object.prototype.hasOwnProperty.call(Object.prototype, x);
// "::ffff:192.168.1.5" (an IPv4 address seen through an IPv6 socket) is 192.168.1.5
const plainIp = (a) => String(a || '').replace(/^::ffff:/i, '');
// where a paired device was reached before (a settings file edited by hand can have anything there, or no entry at all)
const addrsOf = (l) => (l && Array.isArray(l.addrs) ? l.addrs : []);
// (a clock that only moves forward: the wall clock being set ahead mustn't make every link look silent)
const mono = () => performance.now();
const plural = (n, one, many) => n.toLocaleString() + ' ' + (n === 1 ? one : many);
// a file of this side that couldn't be read any more (gone, not allowed): said as such, not as the other device's fault
const readFail = (x) => (x && /^(ENOENT|EACCES|EPERM|EISDIR|EBUSY|ELOOP|EIO)$/.test(x.code || '') ? fail('can’t be read', 'EREAD') : x);
// A device's name as this PC shows and keeps it: text only, without control or direction characters (a name could
// otherwise turn the sentences it's shown in backwards), at most 60 characters. Anything else gives fallback.
// (the zero-width joiner and non-joiner stay: emoji and Persian names are written with them)
const cleanName = (x, fallback) => {
  const t = typeof x === 'string' ? x.slice(0, 200).replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200b\u200e\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g, '').trim().slice(0, 60) : '';
  return t && /[^\s­͏ᅟᅠ឴឵᠋-᠏‌‍⠀ㅤ︀-️ﾠ]/.test(t) ? t : fallback;   // a name of only invisible marks (joiners, U+3164...) reads as none
};

// ---------------------------------------------------------------- an encrypted link to a device, pinned

/** A TLS connection to host:port. pin: the certificate the paired device has (its SHA-256); without one (pairing) the
 * certificate seen is reported, and the pairing code is bound to it. Nothing is sent before it's checked. */
function tlsOpen(host, port, pin, ms = 6000, hold) {
  return new Promise((resolve, reject) => {
    let done = false;
    const sock = tls.connect({ host: plainIp(host), port, rejectUnauthorized: false, minVersion: 'TLSv1.2' });
    // (hold.sock: the caller can close it while it's still connecting, e.g. on Cancel)
    if (hold) hold.sock = sock;
    sock.once('close', () => { if (done) return; done = true; clearTimeout(t); reject(fail('closed', 'ECONNRESET')); });
    const t = setTimeout(() => { if (done) return; done = true; sock.destroy(); reject(fail('timed out', 'ETIMEDOUT')); }, ms);
    sock.once('secureConnect', () => {
      if (done) return;
      done = true;
      clearTimeout(t);
      let fp = '';
      try { const c = sock.getPeerCertificate(); fp = c && c.raw ? sha256(c.raw) : ''; } catch (e) { /* none */ }
      if (!fp || (pin && fp !== pin)) { sock.destroy(); reject(fail('not the device paired with', 'EPIN')); return; }
      sock.setNoDelay(true);
      resolve({ sock, fp });
    });
    sock.once('error', (e) => { if (done) return; done = true; clearTimeout(t); reject(e); });
  });
}

// ---------------------------------------------------------------- WebSocket, the client's side (RFC 6455)

class WsClient extends EventEmitter {
  constructor(sock, rest) {
    super();
    this.sock = sock;
    this.open = true;
    this.buf = Buffer.alloc(0);
    this.parts = []; this.have = 0; this.need = 0;   // a big frame's pieces, joined once it's all here
    this.frag = null; this.fragLen = 0;
    sock.on('data', (d) => this._data(d));
    sock.on('close', () => this._closed());
    sock.on('end', () => this._closed());
    sock.on('error', () => this._closed());
    // a ping every 15 s, answered by the other side: a link that has heard nothing for 40 s is gone (the other device
    // left the network without closing it), and is closed rather than written to for minutes
    this.heard = mono();
    this.pingT = setInterval(() => { if (mono() - this.heard > 40000) this._closed(); else this._frame(0x9, Buffer.alloc(0)); }, 15000);
    if (rest && rest.length) setImmediate(() => this._data(rest));
  }

  /** The handshake over an open (TLS) socket; resolves with a WsClient once the other side switched protocols. */
  static connect(sock, host, port, ms = 6000) {
    return new Promise((resolve, reject) => {
      const key = crypto.randomBytes(16).toString('base64');
      const want = crypto.createHash('sha1').update(key + GUID).digest('base64');
      let head = Buffer.alloc(0), done = false;
      const t = setTimeout(() => finish(fail('no answer', 'ETIMEDOUT')), ms);
      const onData = (d) => {
        head = Buffer.concat([head, d]);
        const i = head.indexOf('\r\n\r\n');
        if (i < 0) { if (head.length > 16384) finish(fail('bad answer', 'EPROTO')); return; }
        const lines = head.slice(0, i).toString('latin1').split('\r\n');
        const hdr = {};
        for (const l of lines.slice(1)) { const k = l.indexOf(':'); if (k > 0) hdr[l.slice(0, k).trim().toLowerCase()] = l.slice(k + 1).trim(); }
        if (!/^HTTP\/1\.1 101/.test(lines[0]) || hdr['sec-websocket-accept'] !== want) { finish(fail('refused', 'EPROTO')); return; }
        finish(null, head.slice(i + 4));
      };
      const onEnd = () => finish(fail('closed', 'ECONNRESET'));
      function finish(err, rest) {
        if (done) return;
        done = true;
        clearTimeout(t);
        sock.removeListener('data', onData);
        sock.removeListener('close', onEnd);
        sock.removeListener('error', onEnd);
        if (err) { sock.destroy(); reject(err); return; }
        resolve(new WsClient(sock, rest));
      }
      sock.on('data', onData);
      sock.once('close', onEnd);
      sock.once('error', onEnd);
      sock.write('GET /ws HTTP/1.1\r\nHost: ' + plainIp(host) + ':' + port + '\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        'Sec-WebSocket-Key: ' + key + '\r\nSec-WebSocket-Version: 13\r\nUser-Agent: Flick-PC\r\n\r\n');
    });
  }

  send(obj) { if (this.open) this._frame(0x1, Buffer.from(JSON.stringify(obj))); }

  close() {
    if (!this.open) return;
    try { this._frame(0x8, Buffer.alloc(0)); } catch (e) { /* ignore */ }
    this._closed();
  }

  _closed() {
    if (!this.open) return;
    this.open = false;
    clearInterval(this.pingT);
    try { this.sock.destroy(); } catch (e) { /* ignore */ }
    this.emit('close');
  }

  // a client's frames are masked
  _frame(op, payload) {
    if (!this.open) return;
    const n = payload.length;
    const head = n < 126 ? Buffer.from([0x80 | op, 0x80 | n])
      : n < 65536 ? Buffer.from([0x80 | op, 0x80 | 126, n >> 8, n & 255])
        : (() => { const b = Buffer.alloc(10); b[0] = 0x80 | op; b[1] = 0x80 | 127; b.writeBigUInt64BE(BigInt(n), 2); return b; })();
    const mask = crypto.randomBytes(4);
    const body = Buffer.alloc(n);
    for (let i = 0; i < n; i++) body[i] = payload[i] ^ mask[i & 3];
    try {
      this.sock.write(Buffer.concat([head, mask, body]));
      // a device that sends and never reads (pings answered with pongs piling up here): the link goes
      if (this.sock.writableLength > MAX_QUEUED) this._closed();
    } catch (e) { this._closed(); }
  }

  _data(d) {
    this.heard = mono();
    // a big frame arriving in many small pieces is joined once it's all here, not copied again with every piece
    if (this.need && this.buf.length + this.have + d.length < this.need) { this.parts.push(d); this.have += d.length; return; }
    if (this.parts.length) { this.parts.push(d); d = Buffer.concat(this.parts); this.parts = []; this.have = 0; }
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    this.need = 0;
    while (this.open) {
      const b = this.buf;
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0, op = b[0] & 0x0f, masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f, at = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); at = 4; }
      else if (len === 127) { if (b.length < 10) return; const big = b.readBigUInt64BE(2); if (big > BigInt(MAX_MESSAGE)) { this.close(); return; } len = Number(big); at = 10; }
      if (len > MAX_MESSAGE) { this.close(); return; }
      // a control frame (close, ping, pong) is whole and small (RFC 6455 5.5)
      if (op >= 0x8 && (!fin || len > 125)) { this.close(); return; }
      const mk = masked ? 4 : 0;
      if (b.length < at + mk + len) { this.need = at + mk + len; return; }
      let p = b.slice(at + mk, at + mk + len);
      if (masked) { const m = b.slice(at, at + 4); p = Buffer.from(p); for (let i = 0; i < p.length; i++) p[i] ^= m[i & 3]; }
      this.buf = b.slice(at + mk + len);
      if (op === 0x8) { this.close(); return; }
      if (op === 0x9) { if (this.sock.writableLength < PONG_QUEUED) this._frame(0xA, p); continue; }
      if (op === 0xA) continue;
      if (op === 0x1 || op === 0x2) {
        if (fin) this._message(p);
        else { this.frag = [p]; this.fragLen = p.length; this.fragN = 1; }
      } else if (op === 0x0 && this.frag) {
        if (++this.fragN > MAX_PIECES) { this.close(); return; }
        if (p.length) this.frag.push(p);
        this.fragLen += p.length;
        if (this.fragLen > MAX_MESSAGE) { this.close(); return; }
        if (fin) { const all = Buffer.concat(this.frag); this.frag = null; this.fragLen = 0; this._message(all); }
      }
    }
  }

  _message(p) {
    let m;
    try { m = JSON.parse(p.toString('utf8')); } catch (e) { return; }
    if (m && typeof m === 'object') this.emit('message', m);
  }
}

// ---------------------------------------------------------------- one signed-in link to a device

/**
 * A device's receiver, as a phone sees a PC: hello, then either signing in (a token from pairing: each side proves it
 * holds it, the token never crosses the network) or pairing (the code). me: { id, name, kind }; to: { id (expected,
 * when paired), ip, port, pin, token }.
 */
class PeerLink extends EventEmitter {
  constructor(me, to) {
    super();
    this.me = me;
    this.to = Object.assign({}, to);
    this.ws = null;
    this.fp = null;
    this.trusted = false;
    this.connected = false;
    this.waits = new Set();
    this.caps = new Set();       // what the other side takes besides files ('welcome', 'connected': server.js PEER_CAPS)
    this.acks = new Map();       // mid -> resolve, for a message that's answered ('ack')
  }

  // (not 'open': that's the method that opens it, and a getter of the same name would be replaced by it)
  get isOpen() { return !!(this.ws && this.ws.open); }

  // the next message of type t (or one of several), or a failure after ms
  _wait(types, ms) {
    const set = new Set([].concat(types));
    return new Promise((resolve, reject) => {
      const w = { set, resolve, reject };
      w.t = setTimeout(() => { this.waits.delete(w); reject(fail('no answer', 'ETIMEDOUT')); }, ms);
      this.waits.add(w);
    });
  }

  async open(ms = 6000) {
    this.hold = {};
    const { sock, fp } = await tlsOpen(this.to.ip, this.to.port, this.to.pin || null, ms, this.hold);
    // closed while it was connecting (Cancel under "Connecting to…"): it goes no further
    if (this.closing) { sock.destroy(); throw fail('canceled', 'ECANCELED'); }
    this.fp = fp;
    this.ws = await WsClient.connect(sock, this.to.ip, this.to.port, ms);
    if (this.closing) { this.ws.close(); throw fail('canceled', 'ECANCELED'); }
    this.ws.on('message', (m) => this._msg(m));
    this.ws.on('close', () => {
      this.connected = false;
      for (const w of this.waits) { clearTimeout(w.t); w.reject(fail('the link closed', 'ECONNRESET')); }
      this.waits.clear();
      for (const r of this.acks.values()) r(null);
      this.acks.clear();
      this.emit('close');
    });
    this.nonceP = rid(16);
    const welcome = this._wait('welcome', ms);
    this.helloName = this.me.name;               // (signed in under this name: see Peers.setName)
    this.ws.send({ t: 'hello', v: 4, device: this.me.id, name: this.me.name, nonce: this.nonceP, peer: 1, kind: this.me.kind || 'pc', app: 0 });
    const w = await welcome;
    this.trusted = !!w.trusted && !!this.proved;
    this.peerId = w.pc && typeof w.pc.id === 'string' ? w.pc.id : null;
    this.peerName = cleanName(w.pc && w.pc.name, '') || null;
    // a Flick before 2.1 answers as to a phone (no kind): it takes files from its phones only (see pair() and _link)
    this.peerKind = w.kind === 'phone' || w.kind === 'pc' ? w.kind : null;
    this.caps = capsOf(w);
    if (this.to.id && this.peerId && this.peerId !== this.to.id) { this.close(); throw fail('a different device answered', 'EOTHER'); }
    return { trusted: this.trusted, why: w.why, id: this.peerId, name: this.peerName, kind: this.peerKind, old: !this.peerKind };
  }

  /** Signed in (paired before): joins as a connected peer, ready to send. */
  async connect(ms = 6000) {
    if (!this.trusted) throw fail('not paired', 'EAUTH');
    const c = this._wait('connected', ms);
    this.ws.send({ t: 'connect' });
    await c;
    this.connected = true;
  }

  /**
   * Pairing: this side commits to its half of the code, the receiver answers with its half, and only then is this
   * side's revealed, so nobody can steer the code; someone in the middle (another certificate) shows another code.
   * onCode(code) shows it here; resolves with the token once the user allows it on the other device.
   */
  async pair(onCode, ms = 120000) {
    const n = rid(16);
    const first = this._wait(['pairing', 'denied'], 15000);
    this.ws.send({ t: 'connect', commit: sha256(n) });
    const m = await first;
    // (refused for now: it says for how long, its user said no a moment ago or it was asked too often)
    if (m.t === 'denied' && m.why === 'wait' && m.s > 0) throw Object.assign(fail('not yet', 'EWAIT'), { wait: Math.min(3600, Math.ceil(+m.s)) });
    if (m.t === 'denied') throw fail('not allowed', 'EDENIED');
    // Both sides commit to their half of the code (a hash of it) before either says it, and the other side says its own
    // only once its user is shown the code: nobody, nor anyone in the middle, can pick numbers that steer the code, or
    // try again and again unseen until two codes match.
    const commitS = String(m.commit || '');
    if (!/^[0-9a-f]{64}$/.test(commitS)) throw fail('it can\'t show a pairing code', 'EPROTO');
    const second = this._wait(['pair-nonce', 'denied'], 15000);
    const answer = this._wait(['paired', 'denied'], ms + 15000);
    answer.catch(() => {});
    this.ws.send({ t: 'pair-reveal', nonce: n });
    const m2 = await second;
    if (m2.t === 'denied') throw fail('not allowed', 'EDENIED');
    const nS = String(m2.nonce || '');
    if (!/^[0-9a-f]{32,64}$/.test(nS) || sha256(nS) !== commitS) throw fail('it can\'t show a pairing code', 'EPROTO');
    onCode(pairCode(this.fp, n, nS));
    const r = await answer;
    if (r.t === 'denied') throw fail('not allowed', 'EDENIED');
    const token = String(r.token || '');
    if (!/^[0-9a-f]{32}$/.test(token)) throw fail('bad answer', 'EPROTO');
    this.trusted = true;
    this.connected = true;           // a receiver connects a device the moment it's allowed
    return token;
  }

  /**
   * Holding Connect here reached a phone: it's asked to become one of this PC's phones ('connect' with home: 1), with
   * the same code on both screens (as pair()). Resolves with { device, name } (who the phone is to its PCs) once its
   * user allows it there; this PC then gives it its own pairing ('home').
   */
  async pairHome(onCode, ms = 120000) {
    const n = rid(16);
    // (a phone paired with this PC already says so at once, without asking its user: why 'paired')
    const no = (x) => (x.why === 'paired' ? fail('paired there already', 'EPAIREDTHERE') : fail('not allowed', 'EDENIED'));
    const first = this._wait(['pairing', 'denied'], 15000);
    this.ws.send({ t: 'connect', commit: sha256(n), home: 1 });
    const m = await first;
    if (m.t === 'denied') throw no(m);
    const commitS = String(m.commit || '');
    if (!/^[0-9a-f]{64}$/.test(commitS)) throw fail('it can\'t show a pairing code', 'EPROTO');
    const second = this._wait(['pair-nonce', 'denied'], 15000);
    // (the phone gives its user 130 s from showing the request, then closes the link: this side stops waiting first,
    // so it's said as no answer)
    const answer = this._wait(['paired', 'denied'], ms + 5000);
    answer.catch(() => {});
    this.ws.send({ t: 'pair-reveal', nonce: n });
    const m2 = await second;
    if (m2.t === 'denied') throw no(m2);
    const nS = String(m2.nonce || '');
    if (!/^[0-9a-f]{32,64}$/.test(nS) || sha256(nS) !== commitS) throw fail('it can\'t show a pairing code', 'EPROTO');
    onCode(pairCode(this.fp, n, nS));
    const r = await answer;
    if (r.t === 'denied') throw no(r);
    const device = idOk(r.device) ? r.device : '';
    if (r.home !== 1 || !device) throw fail('bad answer', 'EPROTO');
    return { device, name: cleanName(r.name, '') };
  }

  send(obj) { if (this.ws) this.ws.send(obj); }

  /** A message that's answered ('ack' with its mid): resolves with the answer, or null (none in ms, or the link went). */
  ask(obj, ms = 12000) {
    return new Promise((resolve) => {
      if (!this.isOpen) { resolve(null); return; }
      const mid = rid(6);
      const t = setTimeout(() => { this.acks.delete(mid); resolve(null); }, ms);
      this.acks.set(mid, (m) => { clearTimeout(t); this.acks.delete(mid); resolve(m); });
      this.ws.send(Object.assign({}, obj, { mid }));
    });
  }

  close() {
    this.closing = true;
    if (this.ws) this.ws.close();
    else if (this.hold && this.hold.sock) this.hold.sock.destroy();       // (still connecting: it stops now)
  }

  _msg(m) {
    switch (m.t) {
      case 'auth?': {
        // The receiver proves it holds the token this side was given when they paired (an HMAC over both random numbers
        // and the certificate this side sees); only then does this side prove the same.
        const tok = this.to.token || '';
        const pcId = String((m.pc && m.pc.id) || '');
        const nS = String(m.nonce || '');
        const ok = tok && /^[0-9a-f]{32,64}$/.test(nS) && (!this.to.id || pcId === this.to.id) &&
          sameHex(hmac(tok, 'flick-auth-v1|pc|' + this.nonceP + '|' + nS + '|' + this.fp + '|' + this.me.id + '|' + pcId), String(m.proof || ''));
        if (!ok) { this.ws.send({ t: 'auth', proof: 'none' }); break; }
        this.proved = true;
        this.ws.send({ t: 'auth', proof: hmac(tok, 'flick-auth-v1|phone|' + this.nonceP + '|' + nS + '|' + this.fp + '|' + this.me.id + '|' + pcId) });
        break;
      }
      case 'saved': case 'failed': case 'asking': case 'got': case 'recv':
        this.emit('reply', m);
        break;
      case 'ack': { const r = this.acks.get(String(m.mid || '')); if (r) r(m); return; }
      case 'ring-found':
        this.emit('ring-found');
        return;
      // the other device removed this one (its user's Remove), said on this link: see Peers._watch
      case 'peer-forget':
        this.emit('peer-forget');
        return;
      // Flick on the other device is closing (its user quit it): what's on its way there ends, and says so (see
      // Peers.send), rather than that the device couldn't be reached
      case 'bye':
        this.bye = true;
        this.emit('bye');
        return;
      case 'connected':
        if (Array.isArray(m.caps)) this.caps = capsOf(m);
        break;
      default:
        break;
    }
    for (const w of [...this.waits]) {
      if (!w.set.has(m.t)) continue;
      this.waits.delete(w);
      clearTimeout(w.t);
      w.resolve(m);
      break;
    }
  }
}

/**
 * Which kind of link an address is reached over from this computer: 'usb' for a cable straight to the other device
 * (USB4 or Thunderbolt networking, a transfer cable, a phone's USB tethering: a network of its own, often without a
 * router, so link-local addresses), 'ethernet', or 'wifi' (anything else).
 */
function linkKind(ip) {
  const i = ifaceOf(ip);
  if (!i) return 'wifi';
  if (WIFI_IF.test(i.name)) return 'wifi';
  if (/thunderbolt|usb|rndis|ncm|bridge/.test(i.name) || i.address.startsWith('169.254.')) return 'usb';
  if (/^(ethernet|eth|enp|eno|ens|enx)/.test(i.name)) return 'ethernet';
  return 'wifi';
}
const WIFI_IF = /^(wi-?fi|wlan|wlp|wlx|wl\d)|wireless|airport/;
// this computer's networks an address is on: [{ name (lower case), address }], in the order the system lists them
function ifacesOf(ip) {
  const p = String(ip || '').split('.').map(Number), out = [];
  if (p.length !== 4) return out;
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if ((a.family !== 'IPv4' && a.family !== 4) || a.internal) continue;
      const q = a.address.split('.').map(Number), m = String(a.netmask || '255.255.255.0').split('.').map(Number);
      if (q.length !== 4 || m.length !== 4 || q.some((x, i) => (x & m[i]) !== (p[i] & m[i]))) continue;
      out.push({ name: name.toLowerCase(), address: a.address });
    }
  }
  return out;
}
const ifaceOf = (ip) => ifacesOf(ip)[0] || null;

/**
 * Whether an address is surely at the other end of a cable from this computer: on an interface named for one
 * (Thunderbolt or USB4 networking, a phone's USB tethering: thunderbolt, usb, rndis, ncm; the Mac's Thunderbolt Bridge,
 * bridge0). Only there does the other device's Allow do without Same code here. Not a link-local address by itself, nor
 * any other bridge (the Mac's Internet Sharing, bridge100…; Windows' Network Bridge): strangers can be on those, as
 * linkKind's 'usb' allows for what the window shows. Every network of this computer's the address could be on must be
 * one (two link-local networks at once, a cable's and another's: there's no telling). (A phone's USB tethering shows up
 * on Windows as "Ethernet N": Same code is asked there, the safe side.)
 */
function surelyCable(ip) {
  const all = ifacesOf(ip);
  const cable = (i) => !WIFI_IF.test(i.name) && (/thunderbolt|usb|rndis|ncm/.test(i.name) || (process.platform === 'darwin' && i.name === 'bridge0'));
  return all.length > 0 && all.every(cable);
}

/** What a 'welcome' or 'connected' says the other side takes besides files (server.js PEER_CAPS, PeerServer.CAPS). */
function capsOf(m) {
  return new Set(Array.isArray(m.caps) ? m.caps.filter((x) => typeof x === 'string' && x.length <= 20).slice(0, 32) : []);
}

// ---------------------------------------------------------------- what goes: files and folders, as a bundle

/** paths (files and folders) → { entries, roots, files, bytes, more, deep, unread }: a folder keeps what's inside it.
 * Read without holding up the rest of Flick (a big folder takes a while to list). Inside a folder, links (symbolic
 * links, Windows junctions) aren't followed: what goes is what's in the folder, never a file somewhere else, nor the
 * folder again. unread: how many items couldn't be read (no access, gone meanwhile): they don't go, and that's said.
 * stop(): true once the user canceled (the listing ends there). */
async function walk(paths, max = MAX_FILES, stop) {
  const fsp = fs.promises;
  const entries = [], roots = [];
  let files = 0, bytes = 0, more = false, dirs = 0, deep = false, unread = 0;
  const usedRoot = new Set();
  const visit = async (abs, rel, depth) => {
    if (more || (stop && stop())) return;
    let st;
    // (what the user picked is followed if it's a link: they picked it)
    try { st = depth === 0 ? await fsp.stat(abs) : await fsp.lstat(abs); } catch (e) { unread++; return; }
    if (st.isFile()) {
      if (files >= max) { more = true; return; }
      entries.push({ abs, p: rel, s: st.size, m: Math.round(st.mtimeMs) });
      files++; bytes += st.size;
      return;
    }
    if (!st.isDirectory()) return;
    // a receiver takes paths 64 folders deep: deeper ones are left out, and that's said
    if (depth >= 63) { deep = true; return; }
    if (++dirs > MAX_DIRS) { more = true; return; }
    const at = entries.push({ p: rel, d: 1 }) - 1;
    let names;
    // (as bytes: a name that isn't UTF-8, from an old disk or a zip, is found by them; by its text it never is.) A folder
    // that can't be opened doesn't go as an empty one.
    try { names = await fsp.readdir(abs, { encoding: 'buffer' }); } catch (e) { entries.splice(at, 1); unread++; return; }
    const kids = [], taken = new Set();
    for (const n of names) if (isUtf8(n)) { kids.push({ name: n.toString() }); taken.add(kids[kids.length - 1].name); }
    for (const n of names) {
      if (isUtf8(n)) continue;
      // such a name is shown (and saved there) as Latin-1, what it most likely is (on Windows, a name with a broken
      // character: that character as �), not as another name already in the folder
      const shown = process.platform === 'win32' ? n.toString('utf8') : n.toString('latin1');
      const ext = path.extname(shown), stem = ext ? shown.slice(0, -ext.length) : shown;
      let name = shown;
      for (let i = 2; taken.has(name); i++) name = stem + ' (' + i + ')' + ext;
      taken.add(name);
      kids.push({ name, raw: n });
    }
    kids.sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
    for (const k of kids) {
      const child = (k.raw || Buffer.isBuffer(abs)) ? Buffer.concat([Buffer.isBuffer(abs) ? abs : Buffer.from(abs), Buffer.from(path.sep), k.raw || Buffer.from(k.name)]) : path.join(abs, k.name);
      await visit(child, rel + '/' + k.name, depth + 1);
    }
  };
  for (const p of paths) {
    // two picked items with the same name (from different folders) don't land on each other
    const orig = path.basename(String(p)) || 'file', ext = path.extname(orig), stem = ext ? orig.slice(0, -ext.length) : orig;
    let base = orig;
    for (let i = 2; usedRoot.has(base.toLowerCase()); i++) base = stem + ' (' + i + ')' + ext;
    usedRoot.add(base.toLowerCase());
    const before = entries.length;
    await visit(String(p), base, 0);
    if (entries.length > before) roots.push(base);
  }
  return { entries, roots, files, bytes, more, deep, unread };
}

const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const jsonPart = (o) => { const b = Buffer.from(JSON.stringify(o)); return Buffer.concat([u32(b.length), b]); };

// ---------------------------------------------------------------- the devices this PC can send to

/**
 * opts: {
 *   me: { id, name, kind: 'pc' }, links: { [id]: { name, kind, fp, token, addrs: ['ip:port'], added } } (kept by the
 *   caller: save() after a change), save(), grant(id, { name, kind }) -> { token, fp, port } (this PC's own receiver
 *   takes that device from now on), revoke(id), kindOf(name), thumbFor(path) -> Promise<{ url } | null>,
 *   discoveryPort (47870), extraPorts ([]: tests, devices on this computer listening elsewhere), log(...)
 * }
 * Events: 'state' (something the list shows changed), 'start' { id, tid, cards: [{ name, kind, thumb }] } (signed in,
 * the files go now), 'sent' { id, tid, name, files, to, path, size } (the other device saved them), 'failed' { id, tid,
 * name, to, why (in words), code, files, size, path } (they didn't go: not for a Cancel here), 'ring-found' { id } (a
 * phone rung through message() was found there: nothing in Flick rings one that way yet)
 */
class Peers extends EventEmitter {
  constructor(opts) {
    super();
    this.o = opts;
    this.me = opts.me;
    this.links = opts.links || {};
    this.found = new Map();        // id -> { id, name, kind, os, ip, port, seen }
    // phones nearby with Flick open, found while the user holds Connect here (any): id -> { id, home, name, ip, port,
    // seen, ready }. home: who the phone is to its PCs (this PC's phones are kept by that id)
    this.phones = new Map();
    this.errKind = new Map();      // id -> what its error is about ('reach': it couldn't be reached)
    this.errAt = new Map();        // id -> when it was said
    this.busy = new Map();         // id -> { what: 'pairing' | 'sending' | 'connecting', ... }
    this.errors = new Map();       // id -> text the list shows (the last thing that went wrong)
    this.live = new Map();         // id -> { link, idleT }: signed-in links kept for a moment after a send
    this.scanning = false;
    this.sock = null;
    this.log = opts.log || (() => {});
  }

  // Renamed: the devices paired with this one take a name from it only as it signs in there, so the links kept from
  // before go (not one a send is using: its next one does it) and the paired computers nearby are signed in to again,
  // now. They're looked for a moment first (the list here is mostly closed, so nothing is known of where they are):
  // each is signed in to as it answers (_reply).
  setName(name) {
    if (this.me.name === name) return;
    this.me.name = name;
    clearTimeout(this.renameT);
    this.renameT = setTimeout(() => {
      for (const id of [...this.live.keys()]) if (!this.busy.has(id)) this._drop(id);
      this.renamed = new Set(Object.keys(this.links).filter((id) => this.links[id] && this.links[id].kind !== 'phone'));
      for (const id of [...this.renamed]) {
        const f = this.found.get(id);
        if (f && mono() - f.seen < SEEN_MS) this._tellName(id);
      }
      clearTimeout(this.renamedT);
      if (!this.renamed.size) { this.renamed = null; return; }
      this.scanFor(RENAME_LOOK_MS);
      this.renamedT = setTimeout(() => { this.renamed = null; }, RENAME_LOOK_MS);
      if (this.renamedT.unref) this.renamedT.unref();
    }, 800);
    if (this.renameT.unref) this.renameT.unref();
  }
  // (once, as it's found: see setName)
  _tellName(id) {
    if (this.renamed) this.renamed.delete(id);
    if (this.links[id] && !this.busy.has(id)) this._link(id, 5000).catch(() => {});
  }

  // ---------- finding devices
  // (asked: the list is showing; any: the user is holding Connect here, which looks for phones too, every 300 ms)
  scan(on) { this.scanAsked = !!on; this._applyScan(); }
  /** The user is holding Connect here: every Flick device nearby is looked for, phones too, every 300 ms. */
  scanAny(on) { this.any = !!on; this._applyScan(); }
  /** Looked for for a moment (a new network here, say a cable just plugged in: what's at its other end shows up). */
  scanFor(ms) {
    // (a longer look already going on goes on as it was)
    if (this.brief && this.briefEnd >= Date.now() + ms) return;
    this.brief = true;
    this.briefEnd = Date.now() + ms;
    clearTimeout(this.briefT);
    this.briefT = setTimeout(() => { this.brief = false; this._applyScan(); }, ms);
    if (this.briefT.unref) this.briefT.unref();
    this._applyScan();
  }
  _applyScan() {
    const on = !!(this.scanAsked || this.any || this.brief), ms = this.any || this.brief ? (this.any ? 300 : 700) : SCAN_MS;
    if (on && (!this.scanning || this.scanMs !== ms)) {
      clearInterval(this.scanT);
      this.scanning = true;
      this.scanMs = ms;
      this._openUdp().then(() => this._query());
      this.scanT = setInterval(() => { this._query(); this._expire(); }, ms);
    } else if (!on && this.scanning) {
      this.scanning = false;
      clearInterval(this.scanT);
      if (!this.pending) this._closeUdp();
    }
  }

  // the socket discovery asks from (bound, and allowed to broadcast, before the first question goes)
  _openUdp() {
    if (this.sock) return this.udpReady;
    const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    s.on('error', (e) => { this.log('peers: discovery', e.message); });
    s.on('message', (msg, r) => this._reply(msg, r));
    this.sock = s;
    this.udpReady = new Promise((resolve) => {
      try { s.bind(0, () => { try { s.setBroadcast(true); } catch (e) { /* ignore */ } resolve(); }); } catch (e) { resolve(); }
    });
    return this.udpReady;
  }
  _closeUdp() { if (this.sock) { try { this.sock.close(); } catch (e) { /* ignore */ } this.sock = null; this.udpReady = null; } }

  // every IPv4 network's broadcast address, the paired devices' last addresses, and (tests) this computer
  _targets() {
    const ports = [this.o.discoveryPort || 47870].concat(this.o.extraPorts || []);
    const ips = new Set(['255.255.255.255']);
    for (const list of Object.values(os.networkInterfaces())) {
      for (const a of list || []) {
        if (a.family !== 'IPv4' && a.family !== 4) continue;
        if (a.internal) continue;
        const ip = a.address.split('.').map(Number), mask = String(a.netmask || '255.255.255.0').split('.').map(Number);
        if (ip.length === 4 && mask.length === 4) ips.add(ip.map((x, i) => (x | (~mask[i] & 255))).join('.'));
      }
    }
    for (const l of Object.values(this.links)) for (const a of addrsOf(l)) { const ip = String(a).split(':')[0]; if (ip) ips.add(ip); }
    if ((this.o.extraPorts || []).length) ips.add('127.0.0.1');
    const out = [];
    for (const ip of ips) for (const p of ports) out.push([ip, p]);
    return out;
  }

  _query() {
    if (!this.sock) return;
    // kind: computers look for computers, phones for phones (a phone pairs with a computer the way it always has)
    const q = { t: 'flick?', id: this.me.id, name: this.me.name, peer: 1, kind: this.me.kind || 'pc' };
    if (this.any) q.any = 1;              // (phones answer that too: the user holding Connect here may mean one)
    const msg = Buffer.from(JSON.stringify(q));
    for (const [ip, port] of this._targets()) { try { this.sock.send(msg, port, ip, () => {}); } catch (e) { /* ignore */ } }
  }

  _reply(msg, r) {
    let m;
    try { m = JSON.parse(msg.toString('utf8')); } catch (e) { return; }
    if (!m || m.t !== 'flick!' || !idOk(m.id) || m.id === this.me.id) return;
    const port = Math.floor(+m.port || 0);
    if (!(port > 0 && port < 65536) || !m.tls) return;               // only devices that take encrypted links
    const prev = this.found.get(m.id);
    // (anyone on the network can answer: the list keeps a sensible number of devices, and the paired ones always)
    if (!prev && !this.links[m.id] && this.found.size >= MAX_FOUND) return;
    const now = mono();
    // a phone with Flick open, answering while the user holds Connect here: one it could ask (see candidates)
    if (m.kind === 'phone') {
      if (!this.any) return;
      const home = idOk(m.home) ? m.home : '';
      if (!this.phones.has(m.id) && this.phones.size >= MAX_FOUND) return;
      const was = this.phones.get(m.id);
      const ph = { id: m.id, home, name: cleanName(m.name, 'Phone'), ip: plainIp(r.address), port, seen: now, ready: m.ready === 1 };
      ph.via = was && was.ip === ph.ip ? was.via : linkKind(ph.ip);          // (on a cable: USB tethering)
      this.phones.set(m.id, ph);
      if (!was || was.name !== ph.name || was.ready !== ph.ready || was.via !== ph.via) this._changed();
      return;
    }
    // (a Flick before 2.1 answers without a kind: a computer that takes files from its phones only. It's listed, to be
    // updated, and never paired with: it would take this PC for a phone)
    const old = m.kind !== 'pc' && m.kind !== 'phone';
    const f = { id: m.id, name: cleanName(m.name, 'Flick device'), kind: old ? 'pc' : m.kind, os: typeof m.os === 'string' ? m.os.slice(0, 20) : '', ip: plainIp(r.address), port, seen: now, ipSeen: now, old, ready: m.ready === 1 };
    f.via = linkKind(f.ip);
    if (f.kind !== (this.me.kind || 'pc') || (old && this.links[m.id])) return;
    // (renamed here a moment ago: a paired computer answering is signed in to, once this answer is taken, so it hears it)
    if (this.renamed && this.renamed.has(m.id)) queueMicrotask(() => this._tellName(m.id));
    // back on the network (or answering again: Flick started there anew, a moment after its last answer): what said it
    // couldn't be reached is out of date (an answer is sent at once, so one that comes later is from a running Flick)
    if (this.errKind.get(m.id) === 'reach' && (!prev || now - prev.seen > SEEN_MS || now - (this.errAt.get(m.id) || 0) > 1500)) this._err(m.id, null);
    // A device seen on several networks at once keeps the address it answered from first, while it still answers there;
    // one that moved (its old address quiet) is found where it answers now. A paired device answering where it was
    // reached before (signed in) is taken there over an address that never was. The other address is kept, to try next.
    const saved = addrsOf(this.links[m.id]);
    const verified = saved.includes(f.ip + ':' + port) && !(prev && saved.includes(prev.ip + ':' + prev.port));
    if (prev && prev.ip !== f.ip && now - prev.ipSeen < SCAN_MS * 2 && !verified) {
      prev.seen = now; prev.name = f.name; prev.old = f.old; prev.alt = { ip: f.ip, port, seen: now };
      if (prev.ready !== f.ready) { prev.ready = f.ready; this._changed(); }
      // (a cable plugged in while it's on Wi-Fi too: the cable is the way to it from now on)
      if (f.via === 'usb' && prev.via !== 'usb') { prev.alt = { ip: prev.ip, port: prev.port, seen: prev.ipSeen }; prev.ip = f.ip; prev.port = port; prev.ipSeen = now; prev.via = 'usb'; this._changed(); }
      return;
    }
    if (prev && prev.ip !== f.ip) f.alt = { ip: prev.ip, port: prev.port, seen: prev.ipSeen };
    this.found.set(m.id, f);
    // (a paired device's saved name and addresses change only over its own signed-in link, never from an answer anyone
    // could send: see _link)
    if (!prev || prev.name !== f.name || prev.ip !== f.ip || prev.ready !== f.ready || prev.via !== f.via) this._changed();
  }

  // where a paired device was reached over its own signed-in link (first in its list), and the name it gives there
  _remember(id, addr, name) {
    const l = this.links[id];
    if (!l) return;
    const addrs = [addr].concat(addrsOf(l).filter((x) => x !== addr)).slice(0, 6);
    const nm = cleanName(name, '') || l.name;
    if (addrs.join() !== addrsOf(l).join() || nm !== l.name) { l.addrs = addrs; l.name = nm; this._save(); this._changed(); }
  }

  _expire() {
    let gone = false;
    for (const [id, f] of this.found) if (mono() - f.seen > SEEN_MS) { this.found.delete(id); gone = true; }
    for (const [id, f] of this.phones) if (mono() - f.seen > SEEN_MS) { this.phones.delete(id); gone = true; }
    if (gone) this._changed();
  }

  /**
   * What holding Connect here could reach now: computers nearby this PC isn't paired with, and phones nearby with Flick
   * open that aren't this PC's (pairedPhone(home id): one of them). Only what answered in the last few seconds. ip: the
   * address it answered from; via: 'usb' on a cable; home: a phone's id to its PCs.
   */
  candidates(pairedPhone) {
    const out = [], now = mono();
    for (const f of this.found.values()) {
      if (now - f.seen > 4000 || f.old || f.kind !== 'pc' || this.links[f.id]) continue;
      out.push({ kind: 'pc', id: f.id, name: f.name, ready: !!f.ready, os: f.os || '', ip: f.ip, via: f.via || 'wifi' });
    }
    for (const p of this.phones.values()) {
      if (now - p.seen > 4000 || !p.home || (pairedPhone && pairedPhone(p.home))) continue;
      out.push({ kind: 'phone', id: p.id, name: p.name, ready: !!p.ready, ip: p.ip, via: p.via || 'wifi', home: p.home });
    }
    return out;
  }

  /**
   * What answered in the last few seconds but can't be asked, so holding Connect can say why: a computer with a Flick
   * from before 2.1 ('old'), a device paired with this PC already ('paired').
   */
  nearbyOthers(pairedPhone) {
    const out = [], now = mono();
    for (const f of this.found.values()) {
      if (now - f.seen > 4000) continue;
      if (this.links[f.id]) out.push({ id: f.id, name: f.name, kind: f.kind, why: 'paired' });
      else if (f.old) out.push({ id: f.id, name: f.name, kind: 'pc', why: 'old' });
    }
    for (const p of this.phones.values()) {
      if (now - p.seen > 4000) continue;
      if (this.links[p.id] || (p.home && pairedPhone && pairedPhone(p.home))) out.push({ id: p.id, name: p.name, kind: 'phone', why: 'paired' });
    }
    return out;
  }

  _save() { try { this.o.save && this.o.save(); } catch (e) { /* ignore */ } }
  _changed() {
    if (this.changeT) return;
    this.changeT = setTimeout(() => { this.changeT = null; this.emit('state'); }, 50);
  }

  /** What the list shows: paired devices first, then the ones nearby, with what each is doing. */
  state() {
    const ids = new Set([...Object.keys(this.links), ...this.found.keys()]);
    const out = [];
    for (const id of ids) {
      const l = this.links[id], f = this.found.get(id), b = this.busy.get(id);
      out.push({
        id, name: cleanName(l && l.name, '') || cleanName(f && f.name, 'Flick device'), kind: (l && l.kind) || (f && f.kind) || 'pc',
        os: (f && f.os) || '', paired: !!l, nearby: !!f, ask: false, old: !l && !!(f && f.old), via: (f && f.via) || '',
        busy: b ? b.what : null, code: b && b.code ? b.code : null, codeOk: !!(b && b.codeOk), allowed: !!(b && b.allowed),
        progress: b && b.what === 'sending' ? { sent: b.sent || 0, total: b.total || 0, files: b.files || 0, items: b.items || 0, name: b.name || '', asking: !!b.asking } : null,
        error: this.errors.get(id) || null,
      });
    }
    out.sort((a, b) => (b.paired - a.paired) || (b.nearby - a.nearby) || String(a.name).localeCompare(String(b.name)));
    return { scanning: this.scanning, devices: out };
  }

  _setBusy(id, b) { if (b) this.busy.set(id, b); else this.busy.delete(id); this._changed(); }
  // kind 'reach': it couldn't be reached (cleared once it answers on the network again)
  _err(id, text, kind) {
    if (text) { this.errors.set(id, text); this.errKind.set(id, kind || ''); this.errAt.set(id, mono()); } else { this.errors.delete(id); this.errKind.delete(id); this.errAt.delete(id); }
    this._changed();
  }
  _nameOf(id) { const f = this.found.get(id), l = this.links[id]; return cleanName(l && l.name, '') || cleanName(f && f.name, 'The other device'); }

  // ---------- pairing
  /**
   * Pair with a device found nearby: its code shows here, and on the other device, whose user allows it there; the user
   * here then says it's the same code (confirm(id, true): Same code) within 2 minutes, as there, and only then is it
   * paired (Different code, Cancel or no answer undoes it on both sides): anyone nearby can answer as the device meant,
   * and allow itself. A device surely on a cable (USB4, Thunderbolt, a transfer cable: surelyCable) is the one on the
   * other end of it: its Allow is the go-ahead, with nothing more to tap here. auto: false asks here even then.
   */
  async pair(id, o = {}) {
    const f = this.found.get(id);
    if (!f || this.busy.has(id)) return false;
    if (f.old) { this._err(id, 'Flick on ' + f.name + ' needs updating before files can go to it.'); return false; }
    this._err(id, null);
    const b = { what: 'pairing', code: null, codeOk: (o.auto !== false && surelyCable(f.ip)) || !!this.o.sameCode, allowed: false };
    this._setBusy(id, b);
    const link = new PeerLink(this.me, { id, ip: f.ip, port: f.port });
    b.link = link;
    this._watch(id, link, b);
    try {
      const w = await link.open();
      if (b.canceled) throw fail('canceled', 'ECANCELED');
      if (w.old) throw fail('an older Flick', 'EOLD');
      if (w.trusted) throw fail('already paired', 'EPAIRED');
      const token = await link.pair((code) => { b.code = code; this._changed(); });
      if (b.canceled) throw fail('canceled', 'ECANCELED');
      if (b.removed) throw fail('removed there', 'EREMOVED');
      b.allowed = true; b.token = token; this._changed();
      // the other side allowed it; it counts once the user here says the codes match too (within 2 minutes, as there)
      if (!b.codeOk) await this._confirmed(b, link);
      if (b.removed) throw fail('removed there', 'EREMOVED');
      // (its link gone by now: it let go of the pairing it allowed, and wouldn't hear this side kept it)
      if (!link.isOpen) throw fail('the link closed', 'ECONNRESET');
      this._finishPair(id, f, link, token);
      return true;
    } catch (e) {
      // (what it came to: the other side removed this PC, its link closing right after; the user here said Different code)
      const code = b.removed ? 'EREMOVED' : b.different ? 'EDIFFERENT' : e.code;
      // The other side allowed it, and the user here said no (or never answered): it's undone on both sides. Here too:
      // whatever pairing with it this PC had (from it pairing the other way at the same moment) goes with it, as the
      // other side removes this PC entirely when told.
      if (b.allowed && code !== 'ECONNRESET') {
        try { link.send({ t: 'peer-forget' }); } catch (x) { /* ignore */ }
        if (this.links[id]) { delete this.links[id]; this._save(); }
        try { this.o.revoke && this.o.revoke(id); } catch (x) { /* ignore */ }
      }
      link.close();
      if (this.busy.get(id) === b) this._setBusy(id, null);
      const nm = this._nameOf(id);
      if (b.canceled) { this._err(id, null); return false; }
      if (code === 'EOLD') { f.old = true; this._changed(); }
      this._err(id, code === 'EDENIED' ? nm + ' didn’t allow it, or is busy with another request.'
        // (its link went because Flick there was closing: said as such)
        : code === 'ECONNRESET' && link.bye ? 'Flick was closed on ' + nm + '.'
        : code === 'EWAIT' ? nm + ' was asked a moment ago. Try again in ' + e.wait + ' s.'
        : code === 'EREMOVED' ? nm + ' removed this PC.'
        : code === 'EDIFFERENT' ? 'Not paired with ' + nm + ': the codes didn’t match.'
        : code === 'EOLD' ? 'Flick on ' + nm + ' needs updating before files can go to it.'
        : code === 'ECANCELED' ? null
          : code === 'EPAIRED' ? null
            : code === 'ETIMEDOUT' ? 'No answer from ' + nm + '. Open Flick there and try again.'
              : code === 'ECONFIRM' ? 'The code wasn’t confirmed here in time. Try again.'
                : 'Pairing with ' + nm + ' didn’t work. Try again.');
      if (code === 'EPAIRED') this.log('peers: already paired with', id);
      else this.log('peers: pairing with', id, 'failed:', code || e.message);
      return false;
    }
  }

  /**
   * Holding Connect here reached a phone (found by candidates): it's asked to become one of this PC's phones, its user
   * allows it there (the same code shows on both), the user here says it's the same code (as pair()), and it then gets
   * this PC's pairing: grant(home id, name) -> { token, fp, port, addrs } makes it one of this PC's phones; it connects
   * here on its own right after. Resolves with { ok, name, device } or { ok: false, why } (why in words for the user, or
   * null when canceled).
   */
  async invite(id, grant) {
    const f = this.phones.get(id);
    // (one that stopped answering a while ago is no longer listed here: said in words, as everything here is)
    if (!f) return { ok: false, why: 'The phone isn’t answering any more. Hold Connect again.' };
    if (this.busy.has(id)) return { ok: false, why: cleanName(f.name, 'The phone') + ' is busy with another request. Try again in a moment.' };
    // (a phone surely on USB tethering is the one on the other end of the cable: its Allow is the go-ahead, as in pair())
    const b = { what: 'pairing', code: null, codeOk: surelyCable(f.ip) || !!this.o.sameCode, allowed: false, home: true };
    this._setBusy(id, b);
    const link = new PeerLink(this.me, { id, ip: f.ip, port: f.port });
    b.link = link;
    try {
      const w = await link.open();
      if (b.canceled) throw fail('canceled', 'ECANCELED');
      if (w.kind !== 'phone') throw fail('not a phone', 'EPROTO');
      const r = await link.pairHome((code) => { b.code = code; this._changed(); });
      if (b.canceled) throw fail('canceled', 'ECANCELED');
      // Its user allowed it. Nothing of this PC's pairing (its token, certificate, addresses) goes to it before the user
      // here says it's the same code too: whoever answered as the phone meant could have allowed itself.
      b.allowed = true; this._changed();
      if (!b.codeOk) await this._confirmed(b, link);
      if (b.canceled) throw fail('canceled', 'ECANCELED');
      if (!link.isOpen) throw fail('the link closed', 'ECONNRESET');       // (nothing is granted to a phone that left)
      const name = r.name || f.name;
      const g = grant(r.device, name);
      if (g && g.exists) throw fail('paired already', 'EPAIRED');
      if (!g) throw fail('can\'t pair', 'EPROTO');
      const ok = link._wait('home-ok', 6000);
      link.send({ t: 'home', token: g.token, fp: g.fp, port: g.port, addrs: g.addrs || [] });
      await ok.catch(() => {});
      this.log('peers: paired with the phone', name);
      return { ok: true, name, device: r.device };
    } catch (e) {
      const nm = cleanName(f.name, 'The phone');
      // (what it came to: the user here said Different code. The phone closes its link when its time for the request is
      // up (130 s from showing it), allowed or not: before its Allow that's no answer; after it, the code wasn't
      // confirmed here in time)
      // (or Flick there was closing: its link went because of that)
      const code = b.different ? 'EDIFFERENT' : e.code === 'ECONNRESET' ? (link.bye ? 'EQUITTHERE' : b.allowed && !b.codeOk ? 'ECONFIRM' : b.allowed ? e.code : 'ETIMEDOUT') : e.code;
      this.log('peers: asking the phone', id, 'failed:', code || e.message);
      return { ok: false, why: b.canceled || code === 'ECANCELED' ? null : code === 'EDENIED' ? nm + ' didn’t allow it, or is busy with another request.'
        : code === 'EQUITTHERE' ? 'Flick was closed on ' + nm + '.'
        : code === 'EDIFFERENT' ? 'Not paired with ' + nm + ': the codes didn’t match.'
        : code === 'ETIMEDOUT' ? 'No answer from ' + nm + '. Open Flick there and try again.'
          : code === 'ECONFIRM' ? 'The code wasn’t confirmed here in time. Hold Connect to try again.'
          : code === 'EPAIRED' ? nm + ' is paired with this PC already. If it can’t connect, remove it in Paired phones, then connect again.'
            // (the phone still has this PC from a pairing this PC no longer has. Held there, Connect reaches this PC, which
            // says it doesn't know that phone: the phone lets go of the old pairing by itself and pairs anew)
            : code === 'EPAIREDTHERE' ? nm + ' still has this PC paired from before. Hold Connect on ' + nm + ' instead.'
            : 'Connecting to ' + nm + ' didn’t work. Try again.' };
    } finally {
      link.close();
      if (this.busy.get(id) === b) this._setBusy(id, null);
    }
  }

  // the user here says whether the code is the same as on the other device, within 2 minutes (confirm)
  _confirmed(b, link) {
    return new Promise((resolve, reject) => {
      // (its link went already, in the same breath as its Allow: there's nothing left to confirm with)
      if (!link.isOpen) { reject(fail('the link closed', 'ECONNRESET')); return; }
      const t = setTimeout(() => reject(fail('not confirmed here', 'ECONFIRM')), 120000);
      b.confirm = () => { clearTimeout(t); resolve(); };
      b.cancel = (e) => { clearTimeout(t); reject(e); };
      link.once('close', () => { clearTimeout(t); reject(fail('the link closed', 'ECONNRESET')); });
    });
  }

  /** The user's answer: the code here is the same as the one the other device shows (or not: pairing is undone). */
  confirm(id, same) {
    const b = this.busy.get(id);
    if (!b || b.what !== 'pairing') return;
    if (!same) {
      // Different code (said so: "Not paired with …"), or Cancel (b.canceled: nothing said)
      if (!b.canceled) b.different = true;
      const e = b.canceled ? fail('canceled', 'ECANCELED') : fail('the codes didn\'t match', 'EDIFFERENT');
      if (b.cancel) b.cancel(e); else { b.codeOk = false; if (b.link) b.link.close(); }
      return;
    }
    b.codeOk = true;
    this._changed();
    if (b.confirm) b.confirm();
  }

  _finishPair(id, f, link, token) {
    const name = cleanName(link.peerName, '') || cleanName(f.name, 'Flick device');
    const kind = link.peerKind || f.kind;
    this.links[id] = { name, kind, fp: link.fp, token, addrs: [f.ip + ':' + f.port], added: Date.now() };
    // both ways: the other device gets a token for this PC's own receiver, and its certificate to pin
    let g = null;
    try { g = this.o.grant(id, { name, kind }); } catch (e) { this.log('peers: grant failed', e.message); }
    // on disk before the other device hears it's done (Flick here quitting, or the PC going off, right after can't
    // leave the other device paired with this PC while this PC isn't with it)
    try { if (this.o.saveNow) this.o.saveNow(); else this._save(); } catch (e) { this._save(); }
    // the codes matched here too: the other device keeps the pairing its user allowed (until now it would drop it if
    // this side went away)
    link.send({ t: 'pair-done' });
    if (g) link.send({ t: 'peer-back', token: g.token, fp: g.fp, port: g.port });
    this._setBusy(id, null);
    this._keep(id, link);
    this.log('peers: paired with', name);
  }

  /** A paired device's new name (it signed in here under it: server.js 'peer-name'). */
  rename(id, name) {
    const l = this.links[id], nm = cleanName(name, '');
    if (l && nm && l.name !== nm) { l.name = nm; this._save(); this._changed(); }
  }

  /** The other device paired with this PC and said how to reach it back (server.js 'peer-back'). */
  addLink(id, info) {
    const prev = this.links[id] || {};
    const addr = info.ip && info.port ? plainIp(info.ip) + ':' + info.port : null;
    this.links[id] = {
      name: cleanName(info.name, '') || cleanName(prev.name, 'Flick device'), kind: info.kind === 'phone' ? 'phone' : 'pc',
      fp: info.fp, token: info.token, addrs: (addr ? [addr] : []).concat(addrsOf(prev).filter((x) => x !== addr)).slice(0, 6),
      added: prev.added || Date.now(),
    };
    this._save();
    this._changed();
  }

  /** It removed this PC (or this PC removes it): gone both ways. tell: let the other device know, if it can be reached. */
  async forget(id, tell = true) {
    const l = this.links[id];
    if (this.busy.has(id)) this.cancel(id);        // what's going to it (or the pairing) stops
    // gone from here at once: it can't send here any more, and isn't listed (whatever telling it takes)
    try { this.o.revoke && this.o.revoke(id); } catch (e) { /* ignore */ }
    this._drop(id);
    delete this.links[id];
    this._save();
    this.errors.delete(id); this.errKind.delete(id); this.errAt.delete(id);
    this._changed();
    if (tell && l) {
      try {
        const link = await this._link(id, 3000, null, l);
        link.send({ t: 'peer-forget' });
        await sleep(150);
      } catch (e) { /* not reachable: it finds out when it next tries */ }
      this._drop(id);
    }
  }

  // The other device removed this one and said so on a link of this PC's to it (its only way when it was removed right
  // after its user allowed it, before it knew how to reach this PC back). A pairing still being made then doesn't
  // finish; one made is undone here too, as when it says so through this PC's own receiver (server.js 'peer-forget').
  _watch(id, link, b) {
    link.once('peer-forget', () => {
      if (b && this.busy.get(id) === b) { b.removed = true; return; }
      if (!this.links[id]) return;
      const k = this.live.get(id);
      if (k && k.link !== link) return;                 // (an older link: the one in use hears it too)
      this.log('peers:', id, 'removed this PC');
      this.forget(id, false);
    });
  }

  // ---------- links kept open for a moment
  _keep(id, link) {
    const cur = this.live.get(id);
    if (cur && cur.link !== link) { clearTimeout(cur.idleT); cur.link.close(); }
    const k = { link, idleT: null };
    this.live.set(id, k);
    link.once('close', () => { if (this.live.get(id) === k) { clearTimeout(k.idleT); this.live.delete(id); } });
    this._idle(id);
  }
  _idle(id) {
    const k = this.live.get(id);
    if (!k) return;
    clearTimeout(k.idleT);
    k.idleT = setTimeout(() => { if (!this.busy.has(id)) { k.link.close(); this.live.delete(id); } else this._idle(id); }, IDLE_MS);
  }
  _drop(id) { const k = this.live.get(id); if (k) { clearTimeout(k.idleT); k.link.close(); this.live.delete(id); } }

  /** A signed-in, connected link to a paired device: kept from a moment ago, or made at each address it was seen at. */
  async _link(id, ms = 5000, b = null, rec = null) {
    const k = this.live.get(id);
    // a kept link that answered its last ping, to where the device still is (one that hasn't answered may be gone, and
    // one that now answers discovery elsewhere has moved: a new link is made, wherever it is now)
    const fd = this.found.get(id);
    const moved = !!(k && fd && (fd.ip !== plainIp(k.link.to.ip) || fd.port !== k.link.to.port) && mono() - (fd.ipSeen || fd.seen || 0) < SCAN_MS * 2);
    // (a send to it is under way on that link: what else goes to it (a link, the clipboard, Find) goes on the same one,
    // even when this PC was renamed or the device answers elsewhere since: a second link would make the other device
    // close this one, and the send would no longer hear how far it got or whether it was saved. The new name goes with
    // the next link, after the send.)
    const sb = this.busy.get(id);
    if (k && !b && sb && sb.what === 'sending' && sb.link === k.link && !k.link.bye && k.link.isOpen && k.link.connected) { this._idle(id); return k.link; }
    // (and signed in under this PC's name as it is now: one from before a rename is made again, so it hears the new one)
    // (nor one whose Flick said it's closing: a new one finds out whether it's back)
    if (k && !moved && !k.link.bye && k.link.isOpen && k.link.connected && k.link.ws && mono() - k.link.ws.heard < 25000 && k.link.helloName === this.me.name) { this._idle(id); return k.link; }
    if (k) this._drop(id);
    const l = rec || this.links[id];
    if (!l) throw fail('not paired', 'EAUTH');
    const stopped = () => !!(b && b.canceled);
    const tried = new Set();
    const f = fd && mono() - fd.seen < SEEN_MS ? fd : null;      // (an answer from a while ago: not where it is now)
    const addrs = (f ? [f.ip + ':' + f.port] : []).concat(f && f.alt && mono() - f.alt.seen < SEEN_MS ? [f.alt.ip + ':' + f.alt.port] : []).concat(addrsOf(l));
    let last = fail('not reachable', 'EUNREACH');
    for (let round = 0; round < 2; round++) {
      for (const a of addrs) {
        if (tried.has(a)) continue;
        tried.add(a);
        if (stopped()) throw fail('canceled', 'ECANCELED');
        const i = a.lastIndexOf(':');
        const link = new PeerLink(this.me, { id, ip: a.slice(0, i), port: +a.slice(i + 1), pin: l.fp, token: l.token });
        this._watch(id, link, null);
        if (b) b.opening = link;                       // (Cancel closes it, wherever it is in opening)
        try {
          const w = await link.open(ms);
          if (!w.trusted) { link.close(); throw fail('it doesn’t know this PC any more', 'EAUTH'); }
          if (w.old) { link.close(); throw fail('an older Flick', 'EOLD'); }
          await link.connect(ms);
          if (stopped()) { link.close(); throw fail('canceled', 'ECANCELED'); }
          this._keep(id, link);
          this._remember(id, a, link.peerName);
          this.errKind.get(id) === 'reach' && this._err(id, null);
          return link;
        } catch (e) {
          link.close();
          last = stopped() ? fail('canceled', 'ECANCELED') : e;
          if (last.code === 'EAUTH' || last.code === 'EOTHER' || last.code === 'ECANCELED' || last.code === 'EOLD') throw last;
        } finally { if (b && b.opening === link) b.opening = null; }
      }
      if (round === 0) {
        // not where it was: look for it on the network for a moment, then try where it answers from
        const was = this.scanning;
        const asked = mono();
        this.pending = (this.pending || 0) + 1;
        await this._openUdp();
        for (let i = 0; i < 4 && !stopped() && !((this.found.get(id) || {}).seen >= asked); i++) { this._query(); await sleep(400); }
        this.pending--;
        if (!was && !this.scanning && !this.pending) this._closeUdp();
        const g = this.found.get(id);
        if (stopped()) throw fail('canceled', 'ECANCELED');
        if (!g || g.seen < asked) break;
        if (g.alt && g.alt.seen >= asked) addrs.unshift(g.alt.ip + ':' + g.alt.port);    // (answered from there too)
        addrs.unshift(g.ip + ':' + g.port);
      }
    }
    throw last;
  }

  // ---------- besides files: a clipboard, a link, find my phone
  /**
   * m (its t: 'clip', 'link', 'ring', 'ring-stop') to a paired device that takes cap: resolves with { ok, why } once it
   * answered. why: 'unpaired', 'old' (its Flick is from before this), 'auth' (it doesn't know this PC any more),
   * 'unreachable', 'no answer', or what it said ('busy', 'quiet', 'off', 'bad', ...).
   */
  async message(id, cap, m) {
    if (!this.links[id]) return { ok: false, why: 'unpaired' };
    let link;
    try { link = await this._link(id, 5000); } catch (e) {
      if (e.code === 'EAUTH') return { ok: false, why: 'auth' };
      if (e.code === 'EOLD') return { ok: false, why: 'old' };
      return { ok: false, why: 'unreachable' };
    }
    if (!link.caps.has(cap)) return { ok: false, why: 'old' };
    if (cap === 'ring' && !link.ringWatch) {
      // its user found it there: whoever rang it here hears so ('ring-found')
      link.ringWatch = true;
      link.on('ring-found', () => this.emit('ring-found', { id }));
    }
    // (its answer comes once all of it is there: a clipboard picture of a few megabytes takes a while over a slow link)
    const size = typeof m.png === 'string' ? m.png.length : typeof m.text === 'string' ? Buffer.byteLength(m.text) : 0;
    const a = await link.ask(m, 12000 + Math.round(size / SLOW_RATE * 1000));
    if (!a) return { ok: false, why: link.isOpen ? 'no answer' : 'unreachable' };
    return a.ok === true ? { ok: true } : { ok: false, why: typeof a.why === 'string' && a.why ? a.why.slice(0, 40) : 'refused' };
  }

  // ---------- sending
  /**
   * Sends files and folders to a paired device: its card flies in there like one thrown from a phone. Resolves with
   * { ok, why } once the other device saved them (or turned them down). o.look: the animation its card arrives with
   * there (the same as leaves this screen).
   */
  async send(id, paths, o = {}) {
    if (!this.links[id] || this.busy.has(id)) return { ok: false, why: 'busy' };
    // busy from the start (Cancel works while a big folder is still being listed)
    const tid = 'p' + rid(8);
    // sent: what the list shows went (what the other device says has come, when it says so: recv; else what went into
    // the connection); wrote: what went into the connection
    const b = { what: 'sending', tid, sent: 0, wrote: 0, recv: 0, total: 0, files: 0, items: 0, name: '', req: null, link: null, left: [] };
    this._setBusy(id, b);
    let nm = this._nameOf(id);
    let list;
    // Flick closing in the middle of it (quit): it ends now, said at once. All of it there already (being saved, or its
    // user being asked): sent, not confirmed. Otherwise not sent, for that reason, and the other device is told why.
    b.end = () => {
      if (b.ended) return;
      b.ended = true;
      const it = { id, tid, name: b.name || path.basename(String(paths[0])), to: nm, path: String(paths[0]), size: b.total };
      if (b.got) {
        const left = b.left.length + ((list && list.unread) || 0);
        this.emit('sent', Object.assign(it, { files: b.files - b.left.length, more: !!b.more, left, unread: (list && list.unread) || 0, deep: !!(list && list.deep), unconfirmed: true }));
      } else {
        this.emit('failed', Object.assign(it, { why: 'Flick was closed before the send finished.', code: 'EQUIT', files: b.files }));
        if (b.link && b.link.isOpen) b.link.send({ t: 'cancel', tid, failed: true, why: 'quit' });
      }
      if (b.req) { try { b.req.destroy(); } catch (x) { /* ignore */ } }
      if (this.busy.get(id) === b) this._setBusy(id, null);
    };
    try { list = await walk(paths, MAX_FILES, () => b.canceled); } catch (e) { list = { entries: [], roots: [], files: 0, bytes: 0, more: false, deep: false, unread: 0 }; }
    if (b.canceled || this.busy.get(id) !== b) { if (this.busy.get(id) === b) this._setBusy(id, null); return { ok: false, why: 'ECANCELED' }; }
    if (!list.files && !list.entries.length) {
      this._setBusy(id, null);
      this._err(id, paths.length === 1 ? 'That can’t be read any more.' : 'Those can’t be read any more.');
      return { ok: false, why: 'nothing' };
    }
    this._err(id, null);
    const single = list.entries.length === 1 && !list.entries[0].d;
    const first = list.entries.find((x) => !x.d);
    const name = single ? list.roots[0] : list.roots.length === 1 ? list.roots[0] : list.roots.length + ' items';
    Object.assign(b, { total: list.bytes, files: list.files, items: list.roots.length, name, more: list.more });
    this._changed();
    let link = null;
    // the other device's answer, as an error: why it didn't save them (canceled: its user canceled them there, while they
    // came; one from before says only declined)
    const turnedDown = (r) => (r.canceled === true ? fail('canceled there', 'ECANCELEDTHERE')
      : r.why === 'declined' || r.why === 'timeout' ? fail(r.why === 'declined' ? 'declined' : 'no answer', 'EDECLINED')
      : r.why === 'space' ? fail('no room', 'ENOSPACE') : r.why === 'upload' || r.why === 'stalled' ? fail('cut off', 'ECUT')
        : r.why === 'busy' ? fail('too many at once', 'EBUSY') : r.why === 'removed' ? fail('removed', 'EAUTH') : fail('not saved', 'ESAVE'));
    try {
      link = await this._link(id, 5000, b);
      b.link = link;
      nm = this._nameOf(id);                          // (the name it gave as this signed in there: renamed meanwhile)
      if (b.canceled) throw fail('canceled', 'ECANCELED');
      const kindOf = this.o.kindOf || (() => 'file');
      const folder = !single && list.roots.length === 1 && list.entries[0] && list.entries[0].d === 1;
      const kind = single ? kindOf(first.p) : folder ? 'folder' : (first ? kindOf(first.p) : 'folder');
      let thumb = null;
      if (first && typeof first.abs === 'string' && this.o.thumbFor && /^(image|video)$/.test(kindOf(first.p))) {
        try { const th = await Promise.race([this.o.thumbFor(first.abs), sleep(700).then(() => null)]); if (th && th.url && th.url.length < 300000) thumb = th.url; } catch (e) { /* none */ }
      }
      if (b.canceled) throw fail('canceled', 'ECANCELED');
      const ext = first ? path.extname(first.p).slice(1).toUpperCase().slice(0, 4) : '';
      const replies = this._replies(link, tid, b);
      // (one that says how much of an upload has come is asked to: its progress is followed, see _post)
      b.reports = link.caps.has('recv');
      link.send({
        t: 'send', tid, w: 150, h: 150, thumb, look: LOOKS.includes(o.look) ? o.look : undefined,
        file: { name, size: list.bytes, kind, count: single ? 1 : list.roots.length, folder: folder || undefined, badge: kind === 'doc' ? ext : '' },
        recv: b.reports ? 1 : undefined,
      });
      // what leaves this screen: a card for each of the first items
      const cards = list.roots.slice(0, 3).map((r, i) => {
        const top = list.entries.find((x) => x.p === r);
        return { name: r, kind: top && top.d ? 'folder' : kindOf(r), thumb: i === 0 ? thumb : null };
      });
      this.emit('start', { id, tid, cards, look: LOOKS.includes(o.look) ? o.look : undefined });
      const l = this.links[id];
      const target = { ip: link.to.ip, port: link.to.port, pin: l.fp };
      const q = 'tid=' + encodeURIComponent(tid) + '&device=' + encodeURIComponent(this.me.id) + '&token=' + encodeURIComponent(l.token);
      let r = null;
      try {
        if (single) await this._post(b, target, '/api/upload?' + q + '&name=' + encodeURIComponent(name) + '&size=' + first.s, { 'Content-Length': String(first.s) }, (req) => this._pipeFile(req, first, b));
        else await this._post(b, target, '/api/bundle?' + q + '&bytes=' + list.bytes, {}, (req) => this._pipeBundle(req, list, b));
        b.got = true;                                   // its answer: all of it is there
      } catch (e) {
        if (b.canceled) throw fail('canceled', 'ECANCELED');
        if (/^E(SHORT|READ)$/.test(e.code || '')) throw e;                // (this side's file, not the other device)
        // all of it went and only the answer to the upload was lost: the other device says over the link whether it
        // saved them. Cut off before the end: its answer over the link says why it stopped them (its user declined
        // while they came, it has no room).
        // (its answer may be here already: the link can close right after it, when it removed this PC)
        // (ECONNABORTED: how Windows says a connection its own side ended)
        const lost = b.bodyDone && /^(ECONNRESET|EPIPE|ECONNABORTED)$/.test(e.code || '');
        if (replies.got) { r = replies.got; if (r.t === 'failed') throw turnedDown(r); }
        else if (b.got) { /* all of it is there (it said so over the link): its answer follows */ }
        else if (!lost) {
          r = replies.got || (link.isOpen ? await Promise.race([replies.wait.catch(() => null), sleep(1500).then(() => null)]) : null);
          // (all of it went into the connection, but the other device says less came, and nothing more for a while: the
          // network stopped carrying it, not "sent")
          if (!r && !b.got) throw b.bodyDone && e.code === 'ETIMEDOUT' && !(b.reports && b.recv < b.total) ? fail('no answer', 'EUNCONFIRMED') : e;
          if (r && r.t === 'failed') throw turnedDown(r);
        } else if (!link.isOpen) throw fail('no answer', 'EUNCONFIRMED');
        else {
          // the other device says at once over the link that all of it came ('got'); nothing about it in seconds: it never
          // all came (the connection broke before it read it all, or even what it was)
          let tm = null;
          await Promise.race([replies.all, replies.wait.catch(() => null), new Promise((ok) => { tm = setTimeout(ok, GOT_MS); })]);
          clearTimeout(tm);
          if (b.canceled) throw fail('canceled', 'ECANCELED');
          if (replies.got) { r = replies.got; if (r.t === 'failed') throw turnedDown(r); }
          else if (!b.got) throw link.isOpen ? fail('not all of it came', 'ECUT') : fail('no answer', 'EUNCONFIRMED');
        }
      }
      // delivered: the other device said all of it is there (Cancel can't stop it now); all of it went, but its answer was
      // lost: whether it got there is said over the link
      b.sent = b.total; b.delivered = !!b.got; this._changed();
      if (!r) {
        // uploaded: the other device saves it (or asks its user first, "Ask each time")
        if (b.armReply) b.armReply();
        try { r = await replies.wait; } catch (e) {
          if (b.canceled) throw fail('canceled', 'ECANCELED');
          // All of it is there (its answer said so) and the user stopped waiting, or the link went: it ends as sent
          // (the link went: not confirmed, and that's said). Otherwise, or while its user was being asked whether to
          // take them, whether it was saved can't be heard.
          if (e.code === 'ELATE') r = { t: 'saved', late: true };
          else if (e.code === 'ECONNRESET' && b.got && !b.asking) r = { t: 'saved', unconfirmed: true };
          else if (e.code === 'ECONNRESET' || e.code === 'ETIMEDOUT') throw fail('no answer', 'EUNCONFIRMED');
          else throw e;
        }
        if (r.t === 'failed') throw turnedDown(r);
      }
      clearTimeout(b.lateCancel);
      this._setBusy(id, null);
      // what went: a file that changed or went away since it was picked is left out, as is what couldn't be read in a
      // folder (no access there), a folder past the most one send takes stops there, folders too deep to be taken are
      // left out: each is said (left: how many items didn't go)
      const went = list.files - b.left.length, left = b.left.length + (list.unread || 0);
      const notes = [];
      if (b.left.length) notes.push(plural(b.left.length, 'file', 'files') + ' couldn’t be read (changed or gone since picked) and didn’t go.');
      if (list.unread) notes.push(plural(list.unread, 'item', 'items') + ' couldn’t be read (no access, or gone) and didn’t go.');
      if (list.more) notes.push('Only the first ' + list.files.toLocaleString() + ' files went. Send the rest separately.');
      if (list.deep) notes.push('Folders more than 62 levels deep were left out.');
      if (b.ended) return { ok: true, files: went, more: list.more, left, unconfirmed: true };     // (said: quit)
      if (notes.length) this._err(id, notes.join(' '));
      this.emit('sent', { id, tid, name, files: went, to: nm, path: String(paths[0]), size: list.bytes, more: list.more, left, unread: list.unread || 0, deep: !!list.deep, unconfirmed: !!r.unconfirmed });
      return { ok: true, files: went, more: list.more, left };
    } catch (x) {
      // (Flick there said it's closing: what broke after that broke because of it, not the network)
      const e = link && link.bye && !b.canceled && (!b.got || b.asking) && /^(ECONNRESET|EPIPE|ECONNABORTED|ECONNREFUSED|ETIMEDOUT|EUNCONFIRMED|ECUT)$/.test(x.code || '') ? fail('closed there', 'EQUITTHERE') : x;
      clearTimeout(b.lateCancel);
      // no answer is waited for any more (its listeners come off the link, which is kept for the next send)
      if (b.rejectReply) b.rejectReply(e);
      // (why: the user here canceled it, so the other device can say so rather than that it failed; older ones ignore it)
      if (link && link.isOpen && b.tid && e.code !== 'ECONNRESET' && !b.ended) link.send(Object.assign({ t: 'cancel', tid: b.tid, failed: true }, b.canceled ? { why: 'canceled' } : {}));
      if (b.req) { try { b.req.destroy(); } catch (z) { /* ignore */ } }
      // the network failed, or Flick there closed: the next try makes a new link (this one may be to where the device was)
      if (/EUNREACH|ETIMEDOUT|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ECONNRESET|EPIPE|EQUITTHERE/.test(e.code || '')) this._drop(id);
      if (this.busy.get(id) === b) this._setBusy(id, null);
      if (b.ended) return { ok: false, why: 'EQUIT' };                                 // (said: quit)
      const reach = /EUNREACH|ETIMEDOUT|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ECONNRESET|EOTHER|EPIPE/.test(e.code || '');
      const why = b.canceled || e.code === 'ECANCELED' || !this.links[id] ? null     // (canceled, or removed meanwhile: nothing to say)
        : e.code === 'ECANCELEDTHERE' ? 'Canceled on ' + nm + '.'
        : e.code === 'EQUITTHERE' ? 'Flick was closed on ' + nm + ' before the send finished.'
        : e.code === 'EDECLINED' ? nm + ' didn’t accept the files.'
          : e.code === 'EAUTH' ? nm + ' doesn’t know this PC any more. Remove it and pair again.'
            : e.code === 'EPIN' ? 'Something other than ' + nm + ' answered at its address. Nothing was sent. If Flick was installed again there, remove it and pair again.'
              : e.code === 'EOLD' ? 'Flick on ' + nm + ' needs updating before files can go to it.'
                : e.code === 'ENOSPACE' ? nm + ' doesn’t have enough space for them.'
                  : e.code === 'ESAVE' ? nm + ' couldn’t save them.'
                  : e.code === 'EBUSY' ? nm + ' has had too many sends from this PC in the last minute. Try again in a minute.'
                    : e.code === 'EUNCONFIRMED' ? 'Sent, but ' + nm + ' didn’t say whether it saved them. Check there before sending again.'
                      : e.code === 'ESHORT' ? (single ? 'The file' : 'A file') + ' changed while it was being sent. Try again.'
                        : e.code === 'EREAD' ? (single ? 'That file' : 'A file') + ' can’t be read any more.'
                          : reach ? 'Couldn’t reach ' + nm + '. Make sure Flick is open there, on the same network.'
                            : 'Sending to ' + nm + ' didn’t work. Try again.';
      // (canceled there by its user: nothing went wrong with the device, so its row doesn't say it as an error. Flick
      // closed there: said until it answers on the network again, as when it can't be reached)
      this._err(id, e.code === 'ECANCELEDTHERE' ? null : why, reach || e.code === 'EQUITTHERE' ? 'reach' : '');
      if (why) this.emit('failed', { id, tid, name, to: nm, why, code: e.code || '', files: list.files, size: list.bytes, path: String(paths[0]) });
      this.log('peers: send to', id, 'failed:', e.code || e.message);
      return { ok: false, why: e.code || 'error' };
    }
  }

  /** Stops what's being sent to (or the pairing with) a device. */
  cancel(id) {
    const b = this.busy.get(id);
    if (!b) return;
    if (b.what === 'pairing') { b.canceled = true; this.confirm(id, false); return; }
    // (not while the other device's user is being asked: that stops it there too)
    if (!b.asking) {
      // all of it is there and being saved: too late to stop (the other device doesn't either). It ends as sent, now.
      if (b.got) { if (b.rejectReply) b.rejectReply(fail('too late to stop', 'ELATE')); return; }
      // all of it went and its answer is on the way: a moment for it (then it's too late to stop, or it stops)
      if (b.bodyDone) {
        if (b.lateCancel) return;
        b.lateCancel = setTimeout(() => {
          if (this.busy.get(id) !== b) return;
          if (b.got) { if (b.rejectReply) b.rejectReply(fail('too late to stop', 'ELATE')); } else { b.bodyDone = false; this.cancel(id); }
        }, 1000);
        return;
      }
    }
    clearTimeout(b.lateCancel);
    b.canceled = true;
    if (b.opening) b.opening.close();                        // (still connecting: it stops now)
    if (b.req) { try { b.req.destroy(fail('canceled', 'ECANCELED')); } catch (e) { /* ignore */ } }
    if (b.rejectReply) b.rejectReply(fail('canceled', 'ECANCELED'));
    this._changed();
  }

  // the other device's answer about tid: 'saved', or 'failed' (declined, couldn't save); 'asking' means its user is
  // asked first ("Ask each time"), which gives it longer. Waited for from when the upload is complete (an upload takes
  // as long as it takes), and longer for more: putting thousands of files in place, or copying a big one to another
  // drive, takes a while.
  _replies(link, tid, b) {
    const out = {};
    // all: settles once the other device says all of it came ('got'; the upload's own answer can be lost), or answers
    let gotAll = null;
    out.all = new Promise((r) => { gotAll = r; });
    out.wait = new Promise((resolve, reject) => {
      let t = null, armed = false, settled = false;
      const done = (fn, v) => { settled = true; clearTimeout(t); link.removeListener('reply', on); link.removeListener('close', onClose); link.removeListener('bye', onBye); b.rejectReply = null; fn(v); };
      const arm = () => {
        if (settled) return;                     // (answered already: no wait to time)
        armed = true;
        clearTimeout(t);
        const ms = (b.asking ? 150000 : 120000) + (b.files || 0) * 5 + (b.total || 0) / 50000;
        t = setTimeout(() => done(reject, fail('no answer', 'ETIMEDOUT')), ms);
      };
      const on = (m) => {
        if (m.tid !== tid) return;
        // how much of the upload has come there (it was asked to say): the list shows that, and _post goes by it
        if (m.t === 'recv') {
          const n = Math.min(Math.floor(+m.bytes) || 0, b.total || 0);
          if (n > b.recv) {
            // (each report buys as long as what it adds takes at MIN_RATE, never more than STALL_MS from now)
            const now = mono();
            b.recvOk = Math.min(now + STALL_MS, Math.max(b.recvOk || 0, now) + (n - b.recv) / MIN_RATE * 1000);
            b.recv = n;
            if (b.reports) { b.sent = n; this._changed(); }
          }
          return;
        }
        if (m.t === 'asking') { if (!b.asking) { b.asking = true; this._changed(); if (armed) arm(); } return; }
        if (m.t === 'got') { b.got = true; gotAll(); return; }          // ('saved' or 'failed' follows)
        out.got = m;
        gotAll();
        done(resolve, m);
      };
      const onClose = () => done(reject, fail('the link closed', 'ECONNRESET'));
      // Flick there is closing: what isn't all there yet, or waits for its user's answer there, isn't saved, and the
      // upload stops now (all of it there and being saved: whether it was is said once the link goes, as before)
      const onBye = () => {
        if (b.got && !b.asking) return;
        if (b.req) { try { b.req.destroy(fail('closed there', 'EQUITTHERE')); } catch (e) { /* ignore */ } }
        done(reject, fail('closed there', 'EQUITTHERE'));
      };
      link.on('reply', on);
      link.once('close', onClose);
      link.on('bye', onBye);
      b.rejectReply = (e) => done(reject, e);
      b.armReply = arm;                        // once the upload is complete
    });
    out.wait.catch(() => {});
    return out;
  }

  // one request over a new encrypted connection, pinned to the device's certificate; write(req) sends the body
  async _post(b, to, p, headers, write) {
    if (b.canceled) throw fail('canceled', 'ECANCELED');
    const { sock } = await tlsOpen(to.ip, to.port, to.pin, 6000);
    // stopped while the connection was being made: nothing goes
    if (b.canceled) { sock.destroy(); throw fail('canceled', 'ECANCELED'); }
    b.bodyDone = false;
    return new Promise((resolve, reject) => {
      const req = http.request({
        host: plainIp(to.ip), port: to.port, method: 'POST', path: p, createConnection: () => sock,
        headers: Object.assign({ 'Content-Type': 'application/octet-stream', 'User-Agent': 'Flick-PC' }, headers),
      }, (res) => {
        const ch = [];
        res.on('data', (c) => { if (ch.length < 64) ch.push(c); });
        res.on('end', () => {
          let j = {};
          try { j = JSON.parse(Buffer.concat(ch).toString('utf8')); } catch (e) { /* not JSON */ }
          if (!j || typeof j !== 'object') j = {};                    // (JSON, but not an answer: null, 7, "x")
          if (typeof j.error !== 'string') delete j.error;
          if (res.statusCode === 200 && j.ok) resolve(j);
          else reject(fail(j.error || 'HTTP ' + res.statusCode, res.statusCode === 507 ? 'ENOSPACE' : res.statusCode === 403 ? 'EAUTH'
            : res.statusCode === 410 ? (j.canceled === true ? 'ECANCELEDTHERE' : 'EDECLINED') : 'EHTTP'));
        });
      });
      b.req = req;
      // Nothing moves for STALL_MS (the other device stopped reading, or never answers once all of it went, or the
      // network went): it ends, instead of "sending" for ever. What went into the connection can take long to arrive
      // over a slow link (its network holds megabytes in flight, and the connection is quiet meanwhile): what the other
      // device says has come ('recv') counts as moving while it keeps a slow link's pace (MIN_RATE), and once all of it
      // went the wait goes by that, for no longer than what can be on its way (IN_FLIGHT) takes at that pace. One that
      // doesn't say is given the time that much takes to drain at a slow link's pace.
      const stalled = () => req.destroy(fail('no answer', 'ETIMEDOUT'));
      const quiet = () => {
        if (b.bodyDone) return;                                                    // (the watch below, from then on)
        if (b.reports && (b.recvOk || 0) > mono()) { sock.setTimeout(STALL_MS, quiet); return; }   // still coming there
        stalled();
      };
      sock.setTimeout(STALL_MS, quiet);
      req.on('error', (e) => reject(e.code ? e : fail(e.message, b.canceled ? 'ECANCELED' : 'ECONNRESET')));
      let watch = null, closed = false;
      req.on('close', () => { closed = true; clearInterval(watch); });
      Promise.resolve().then(() => write(req)).then(() => {
        b.bodyDone = true;
        if (closed) return;                                // (answered, or ended, before the last of it went)
        sock.setTimeout(0);
        const doneAt = mono(), drain = STALL_MS + Math.min(b.wrote, IN_FLIGHT) / SLOW_RATE * 1000;
        const last = doneAt + STALL_MS + Math.min(Math.max(b.wrote - b.recv, 0), IN_FLIGHT) / MIN_RATE * 1000;
        watch = setInterval(() => {
          const now = mono();
          // (its link gone too: the network or the device went, nothing is on its way)
          if (b.reports ? now > Math.min(last, Math.max(doneAt + STALL_MS, b.recvOk || 0)) : now - doneAt > (b.link && !b.link.isOpen ? STALL_MS : drain)) stalled();
        }, 1000);
      }, (e) => { e = readFail(e); req.destroy(e); reject(e); });
    });
  }

  // a file's bytes into the request, as fast as the link takes them
  _pipeFile(req, e, b) {
    return new Promise((resolve, reject) => {
      const rs = fs.createReadStream(e.abs, { highWaterMark: 1024 * 1024, start: 0, end: Math.max(0, e.s - 1) });
      if (!e.s) { rs.destroy(); req.end(); resolve(); return; }
      let last = 0, read = 0;
      rs.on('data', (c) => {
        read += c.length;
        b.wrote += c.length;
        if (!b.reports) b.sent = b.wrote;
        if (mono() - last > 100) { last = mono(); this._changed(); }
        if (!req.write(c)) { rs.pause(); req.once('drain', () => rs.resume()); }
      });
      // (a file that got shorter while it went ends here: what was said it holds didn't all go)
      rs.on('end', () => { if (read < e.s) { const x = fail('the file got shorter while it was sent', 'ESHORT'); req.destroy(x); reject(x); return; } req.end(); resolve(); });
      rs.on('error', (x) => { x = readFail(x); req.destroy(x); reject(x); });
      req.on('close', () => rs.destroy());
    });
  }

  // a Flick bundle (bundle.js): the list, then each folder and file in turn
  async _pipeBundle(req, list, b) {
    const write = (buf) => new Promise((resolve, reject) => {
      if (req.destroyed) { reject(fail('canceled', b.canceled ? 'ECANCELED' : 'ECONNRESET')); return; }
      if (req.write(buf)) { resolve(); return; }
      const go = () => { req.removeListener('drain', go); req.removeListener('close', go); resolve(); };
      req.on('drain', go);
      req.on('close', go);
    });
    await write(Buffer.from('FLKB1\n', 'latin1'));
    await write(jsonPart({ v: 1, files: list.files, bytes: list.bytes, roots: list.roots }));
    let i = 0, last = 0;
    for (const e of list.entries) {
      if (b.canceled || req.destroyed) throw fail('canceled', b.canceled ? 'ECANCELED' : 'ECONNRESET');
      if (e.d) { await write(jsonPart({ i: i++, p: e.p, d: 1 })); continue; }
      // a file that's gone, or got shorter, since it was picked is left out (what was said of it can't go); one still
      // being written (a log growing) goes as it was when picked: its first bytes, as many as were said
      let fh;
      try { fh = await fs.promises.open(e.abs, 'r'); } catch (x) { b.left.push(e.p); continue; }
      try {
        if ((await fh.stat()).size < e.s) { b.left.push(e.p); continue; }
        b.now = e.p;                                  // (the file going now: the window's Transfers says it)
        await write(jsonPart({ i: i++, p: e.p, s: e.s, m: e.m }));
        let at = 0;
        while (at < e.s) {
          const buf = Buffer.allocUnsafe(Math.min(1024 * 1024, e.s - at));
          const { bytesRead } = await fh.read(buf, 0, buf.length, at);
          if (bytesRead <= 0) throw fail('the file got shorter while it was sent', 'ESHORT');
          at += bytesRead;
          b.wrote += bytesRead;
          if (!b.reports) b.sent = b.wrote;
          await write(bytesRead === buf.length ? buf : buf.subarray(0, bytesRead));
          if (mono() - last > 100) { last = mono(); this._changed(); }
        }
      } finally { try { await fh.close(); } catch (x) { /* ignore */ } }
    }
    await write(u32(0));
    req.end();
  }

  /**
   * Flick is closing: every send to another device ends now, each said at once ('failed' with code EQUIT, or 'sent' not
   * confirmed when all of it was there already: see send), as the app goes right after. Then stop().
   */
  quit() {
    for (const b of [...this.busy.values()]) if (b.what === 'sending' && b.end) b.end();
    this.stop();
  }

  stop() {
    clearTimeout(this.renameT); clearTimeout(this.renamedT); this.renamed = null;
    clearTimeout(this.briefT); this.brief = false;
    this.scan(false);
    this._closeUdp();
    for (const id of [...this.live.keys()]) this._drop(id);
  }
}

module.exports = { Peers, PeerLink, WsClient, tlsOpen, walk, pairCode, linkKind, surelyCable };
