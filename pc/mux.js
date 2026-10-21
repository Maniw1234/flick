'use strict';
// Several connections over one byte stream (a Bluetooth RFCOMM link): Flick's normal HTTP and WebSocket traffic runs
// over it unchanged. The phone opens streams; each one becomes an ordinary connection to Flick's HTTP server.
//
// Link: both sides first send the 8 bytes "FLKMUX1\n". Then frames: type (1 byte), stream id (4 bytes, big-endian),
// payload length (4 bytes, big-endian), payload (at most 64 KB).
//   1 OPEN  2 DATA  3 FIN (no more data from this side)  4 RST (abort)  5 PING  6 PONG
// The same protocol is spoken by the phone (android/.../BtMux.java).
const { Duplex } = require('stream');
const { EventEmitter } = require('events');

const MAGIC = Buffer.from('FLKMUX1\n');
const T = { OPEN: 1, DATA: 2, FIN: 3, RST: 4, PING: 5, PONG: 6 };
const MAX = 64 * 1024;
// One stream whose reader is briefly slow (a disk or antivirus stall) mustn't freeze the others: each stream may run
// ahead by this much before the shared link stops reading. Bluetooth moves ~0.1-0.3 MB/s, so this is many seconds.
const STREAM_CAP = 8 * 1024 * 1024;
// The phone gives up on a link whose pings go unanswered for 35 s, and a held-back link reads none; its last answer
// may be 10 s old when the link is held back. So one stuck reader is reset well before that, costing its own stream,
// not the whole link.
let STUCK_MS = 20000;

function frame(type, id, payload) {
  const p = payload || Buffer.alloc(0);
  const h = Buffer.alloc(9);
  h[0] = type; h.writeUInt32BE(id >>> 0, 1); h.writeUInt32BE(p.length, 5);
  return p.length ? Buffer.concat([h, p]) : h;
}

class MuxStream extends Duplex {
  constructor(link, id) {
    super({ allowHalfOpen: true });
    this.link = link; this.id = id;
    this.remoteAddress = link.label; this.remotePort = 0; this.remoteFamily = 'bluetooth';
    this.localAddress = '127.0.0.1'; this.localPort = 0;
    this.encrypted = false; this.writableEnded2 = false;
  }
  // what Node's HTTP server and Flick's WebSocket code expect from a socket
  setTimeout(ms, cb) { if (cb) this.once('timeout', cb); return this; }
  setNoDelay() { return this; }
  setKeepAlive() { return this; }
  address() { return { address: this.localAddress, port: 0, family: 'bluetooth' }; }
  ref() { return this; }
  unref() { return this; }
  _read() { this.link._resume(); }
  _write(chunk, enc, cb) {
    if (this.link.closed) return cb(new Error('link closed'));
    let off = 0;
    const parts = [];
    while (off < chunk.length) { const n = Math.min(MAX, chunk.length - off); parts.push(frame(T.DATA, this.id, chunk.subarray(off, off + n))); off += n; }
    this.link._send(Buffer.concat(parts), cb);
  }
  _final(cb) { this.writableEnded2 = true; if (!this.link.closed) this.link._send(frame(T.FIN, this.id), () => {}); cb(); }
  _destroy(err, cb) {
    if (!this.link.closed && this.link.streams.get(this.id) === this) {
      if (!this.remoteDone || !this.writableEnded2) this.link._send(frame(T.RST, this.id), () => {});
    }
    this.link.streams.delete(this.id);
    this.link._resume();          // if this stream was the one holding the link back, the others go on now
    cb(err);
  }
}

/** The PC end of a link. Emits 'stream' (a socket-like Duplex) for each stream the phone opens, and 'close'. */
class MuxLink extends EventEmitter {
  constructor(sock, label) {
    super();
    this.sock = sock; this.label = label || 'bluetooth';
    this.streams = new Map();
    this.buf = Buffer.alloc(0);
    this.ready = false; this.closed = false; this.paused = false;
    sock.on('data', (d) => this._data(d));
    sock.on('close', () => this._close());
    sock.on('error', () => this._close());
    sock.write(MAGIC);
  }
  _send(b, cb) {
    if (this.closed) return cb && cb(new Error('link closed'));
    if (this.sock.write(b)) cb && process.nextTick(cb);
    else this.sock.once('drain', () => cb && cb());
  }
  // A stream that has ended (or whose reader stopped asking) never calls _read() again, so while the link is held
  // back it is also looked at a few times a second. A reader that takes nothing at all for STUCK_MS has stopped for
  // good: that one stream is reset, so it can't freeze every other stream on the link.
  _pause() {
    if (this.paused) return;
    this.paused = true; this.sock.pause();
    this.overLen = Infinity; this.progressAt = Date.now();
    this.pauseT = setInterval(() => this._check(), 200);
  }
  _check() {
    if (!this.paused) return;
    let over = 0;
    for (const s of this.streams.values()) if (s.readableLength > STREAM_CAP) over += s.readableLength;
    if (!over) { this._resume(); return; }
    if (over < this.overLen) this.progressAt = Date.now();
    this.overLen = over;
    if (Date.now() - this.progressAt > STUCK_MS) {
      for (const s of [...this.streams.values()]) if (s.readableLength > STREAM_CAP) s.destroy();
      this._resume();
    }
  }
  _resume() {
    if (!this.paused || this.closed) return;
    for (const s of this.streams.values()) if (s.readableLength > STREAM_CAP) return;   // still one too far behind
    this.paused = false; clearInterval(this.pauseT); this.pauseT = null;
    this.sock.resume();
  }
  _data(d) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    if (!this.ready) {
      if (this.buf.length < MAGIC.length) return;
      if (!this.buf.subarray(0, MAGIC.length).equals(MAGIC)) { this.sock.destroy(); return; }
      this.buf = this.buf.subarray(MAGIC.length);
      this.ready = true;
      this.emit('ready');
    }
    while (this.buf.length >= 9) {
      const type = this.buf[0], id = this.buf.readUInt32BE(1), len = this.buf.readUInt32BE(5);
      if (len > MAX) { this.sock.destroy(); return; }
      if (this.buf.length < 9 + len) break;
      const p = Buffer.from(this.buf.subarray(9, 9 + len));
      this.buf = this.buf.subarray(9 + len);
      this._frame(type, id, p);
    }
  }
  _frame(type, id, p) {
    const s = this.streams.get(id);
    switch (type) {
      case T.OPEN:
        if (!s && id) { const ns = new MuxStream(this, id); this.streams.set(id, ns); this.emit('stream', ns); }
        break;
      case T.DATA:
        if (s && !s.remoteDone) { s.push(p); if (s.readableLength > STREAM_CAP) this._pause(); }
        break;
      case T.FIN:
        if (s && !s.remoteDone) { s.remoteDone = true; s.push(null); }
        break;
      case T.RST:
        if (s) { s.remoteDone = true; this.streams.delete(id); s.destroy(); }
        break;
      case T.PING:
        this._send(frame(T.PONG, 0, p), () => {});
        break;
      default: break;
    }
  }
  _close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.pauseT); this.pauseT = null;
    for (const s of [...this.streams.values()]) s.destroy();
    this.streams.clear();
    this.emit('close');
  }
  close() { try { this.sock.destroy(); } catch (e) { /* ignore */ } this._close(); }
}

/** The phone end, for tests: open() gives a socket-like Duplex to use as an HTTP connection. */
class MuxClient extends EventEmitter {
  constructor(sock) {
    super();
    this.sock = sock; this.next = 1; this.streams = new Map(); this.buf = Buffer.alloc(0); this.ready = false; this.closed = false;
    sock.write(MAGIC);
    sock.on('data', (d) => {
      this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
      if (!this.ready) {
        if (this.buf.length < 8) return;
        if (!this.buf.subarray(0, 8).equals(MAGIC)) { sock.destroy(); return; }
        this.buf = this.buf.subarray(8); this.ready = true; this.emit('ready');
      }
      while (this.buf.length >= 9) {
        const type = this.buf[0], id = this.buf.readUInt32BE(1), len = this.buf.readUInt32BE(5);
        if (this.buf.length < 9 + len) break;
        const p = Buffer.from(this.buf.subarray(9, 9 + len)); this.buf = this.buf.subarray(9 + len);
        const s = this.streams.get(id);
        if (type === T.DATA && s) s.push(p);
        else if (type === T.FIN && s) { s.remoteDone = true; s.push(null); }
        else if (type === T.RST && s) { s.remoteDone = true; this.streams.delete(id); s.destroy(); }
      }
    });
    sock.on('close', () => { this.closed = true; for (const s of this.streams.values()) s.destroy(); });
  }
  open() {
    const id = this.next; this.next += 2;
    const fake = { closed: false, label: 'test', streams: this.streams, _send: (b, cb) => { if (this.sock.write(b)) process.nextTick(cb); else this.sock.once('drain', cb); }, _resume() {} };
    Object.defineProperty(fake, 'closed', { get: () => this.closed });
    const s = new MuxStream(fake, id);
    this.streams.set(id, s);
    this.sock.write(frame(T.OPEN, id));
    return s;
  }
}

module.exports = { MuxLink, MuxClient, MuxStream, MAGIC, T, frame, STREAM_CAP, _setStuckMs: (ms) => { STUCK_MS = ms; } };
