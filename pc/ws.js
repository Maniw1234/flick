'use strict';
// Minimal, dependency-free WebSocket server side (RFC 6455) for Flick.
const crypto = require('crypto');
// (a clock that only moves forward: the wall clock being set ahead mustn't make every link look silent and close it)
const mono = () => performance.now();
const { EventEmitter } = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
// Flick only sends small JSON control frames over the socket (files go over HTTP), so a few MB is already generous.
// Caps stop a hostile peer from making us buffer without limit (a single giant frame, or endless unfinished fragments).
const MAX_MESSAGE = 4 * 1024 * 1024;
// the pieces of one fragmented message: far more than any client sends (a browser's are tens of KB each), and few
// enough that empty or one-byte pieces, which cost memory here without adding up to many bytes, can't pile up
// (server.js allows far fewer until a device has signed in)
const MAX_PIECES = 4096;
const OPCODES = new Set([0x0, 0x1, 0x2, 0x8, 0x9, 0xA]);   // continuation, text, binary, close, ping, pong
// What may wait to be sent on one link: a clipboard picture for the phone is the biggest message (a 6 MB PNG, about 8 MB
// as text). A peer that sends and never reads (pings answered with pongs that pile up) is closed past this, and pongs
// aren't answered while what's waiting is more than a little.
const MAX_QUEUED = 32 * 1024 * 1024, PONG_QUEUED = 64 * 1024;

class WSConnection extends EventEmitter {
  constructor(socket, req) {
    super();
    this.socket = socket;
    this.req = req;
    this.open = true;
    this._buf = Buffer.alloc(0);
    this._parts = [];   // chunks that arrived while a frame is still incomplete (joined once it's all there)
    this._have = 0;
    this._need = 0;     // bytes the frame being received needs in total (0 = unknown yet)
    this._frag = null; // { opcode, chunks, len }
    // the biggest message taken, the pieces it may come in, and what may wait to be sent before the link is closed
    // (server.js keeps all three small until a device has signed in, and raises the message for another Flick device's
    // clipboard)
    this.maxMessage = MAX_MESSAGE;
    this.maxPieces = MAX_PIECES;
    this.maxQueued = MAX_QUEUED;
    this._lastPong = mono();
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 10000);
    socket.on('data', (d) => this._onData(d));
    socket.on('close', () => this._closed());
    socket.on('end', () => this._closed());
    socket.on('error', () => this._closed());
    this._ping = setInterval(() => {
      if (!this.open) return;
      if (mono() - this._lastPong > 35000) { this.close(); return; }
      this._sendFrame(0x9, Buffer.alloc(0));
    }, 12000);
  }

  _closed() {
    if (!this.open) return;
    this.open = false;
    clearInterval(this._ping);
    try { this.socket.destroy(); } catch (e) { /* ignore */ }
    this.emit('close');
  }

  // a peer that broke the protocol: nothing more it sends is read, and the connection closes
  _refuse() { this._dead = true; this._buf = Buffer.alloc(0); this._parts = []; this.close(); }

  _onData(d) {
    if (this._dead) return;
    // a big frame trickling in must not be re-copied on every packet: collect, and join once it's complete
    if (this._need && this._buf.length + this._have + d.length < this._need) { this._parts.push(d); this._have += d.length; return; }
    if (this._parts.length) { this._parts.push(d); d = Buffer.concat(this._parts); this._parts = []; this._have = 0; }
    this._buf = this._buf.length ? Buffer.concat([this._buf, d]) : d;
    this._need = 0;
    while (this.open) {
      const b = this._buf;
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0;
      const opcode = b[0] & 0x0f;
      const masked = (b[1] & 0x80) !== 0;
      // a client masks every frame, no extension is agreed (so the reserved bits stay 0), and only these opcodes
      // exist (RFC 6455 5.1-5.2): anything else ends the connection
      if (!masked || (b[0] & 0x70) !== 0 || !OPCODES.has(opcode)) { this._refuse(); return; }
      let len = b[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (b.length < 4) return;
        len = b.readUInt16BE(2); off = 4;
      } else if (len === 127) {
        if (b.length < 10) return;
        const hi = b.readUInt32BE(2), lo = b.readUInt32BE(6);
        len = hi * 4294967296 + lo; off = 10;
      }
      if (len > this.maxMessage) { this._refuse(); return; }
      // a control frame (close, ping, pong) is whole and small (RFC 6455 5.5)
      if (opcode >= 0x8 && (!fin || len > 125)) { this._refuse(); return; }
      // a fragmented message is the sum of its pieces; refuse one that grows past the cap before it finishes, or that
      // comes in more pieces than any client sends
      if (opcode === 0x0 && this._frag && (this._frag.len + len > this.maxMessage || this._frag.n >= this.maxPieces)) { this._refuse(); return; }
      let mask = null;
      if (masked) {
        if (b.length < off + 4) return;
        mask = b.slice(off, off + 4); off += 4;
      }
      if (b.length < off + len) { this._need = off + len; return; }
      let payload = b.slice(off, off + len);
      if (mask) {
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      }
      this._buf = b.slice(off + len);
      this._handleFrame(fin, opcode, payload);
    }
  }

  _handleFrame(fin, opcode, payload) {
    this._lastPong = mono();
    if (opcode === 0x8) { // close
      try { this._sendFrame(0x8, payload.slice(0, 2)); } catch (e) { /* ignore */ }
      this._closed();
      return;
    }
    if (opcode === 0x9) { if (this.socket.writableLength < PONG_QUEUED) this._sendFrame(0xA, payload); return; } // ping -> pong
    if (opcode === 0xA) { return; } // pong
    if (opcode === 0x0) { // continuation
      if (!this._frag) return;
      this._frag.n++;
      if (payload.length) this._frag.chunks.push(payload);
      this._frag.len += payload.length;
      if (fin) {
        const all = Buffer.concat(this._frag.chunks);
        const op = this._frag.opcode;
        this._frag = null;
        this._deliver(op, all);
      }
      return;
    }
    if (!fin) { this._frag = { opcode, chunks: [payload], len: payload.length, n: 1 }; return; }
    this._deliver(opcode, payload);
  }

  _deliver(opcode, data) {
    if (opcode === 0x1) this.emit('message', data.toString('utf8'));
    else if (opcode === 0x2) this.emit('binary', data);
  }

  _sendFrame(opcode, payload) {
    if (!this.open) return false;
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.alloc(2); header[1] = len;
    } else if (len < 65536) {
      header = Buffer.alloc(4); header[1] = 126; header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10); header[1] = 127;
      header.writeUInt32BE(Math.floor(len / 4294967296), 2);
      header.writeUInt32BE(len >>> 0, 6);
    }
    header[0] = 0x80 | opcode;
    try {
      this.socket.write(Buffer.concat([header, payload]));
      if (this.socket.writableLength > this.maxQueued) { this._dead = true; this._closed(); return false; }   // it doesn't read
      return true;
    } catch (e) { this._closed(); return false; }
  }

  send(obj) {
    const s = typeof obj === 'string' ? obj : JSON.stringify(obj);
    return this._sendFrame(0x1, Buffer.from(s, 'utf8'));
  }

  close() {
    if (!this.open) return;
    try { this._sendFrame(0x8, Buffer.from([0x03, 0xe8])); } catch (e) { /* ignore */ }
    setTimeout(() => this._closed(), 50);
  }
}

function acceptUpgrade(req, socket, head) {
  const key = req.headers['sec-websocket-key'];
  const upgrade = (req.headers.upgrade || '').toLowerCase();
  if (!key || upgrade !== 'websocket') {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return null;
  }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
  );
  const conn = new WSConnection(socket, req);
  // (what came with the upgrade request is read once the caller has its handlers on: a message or a close in it would
  // otherwise go unheard, and a close unseen leaves the link counted as open)
  if (head && head.length) setImmediate(() => { if (conn.open) conn._onData(head); });
  return conn;
}

module.exports = { acceptUpgrade, WSConnection, MAX_MESSAGE, MAX_PIECES, MAX_QUEUED };
