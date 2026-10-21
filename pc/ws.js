'use strict';
// Minimal, dependency-free WebSocket server side (RFC 6455) for Flick.
const crypto = require('crypto');
const { EventEmitter } = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

class WSConnection extends EventEmitter {
  constructor(socket, req) {
    super();
    this.socket = socket;
    this.req = req;
    this.open = true;
    this._buf = Buffer.alloc(0);
    this._frag = null; // { opcode, chunks }
    this._lastPong = Date.now();
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 10000);
    socket.on('data', (d) => this._onData(d));
    socket.on('close', () => this._closed());
    socket.on('end', () => this._closed());
    socket.on('error', () => this._closed());
    this._ping = setInterval(() => {
      if (!this.open) return;
      if (Date.now() - this._lastPong > 35000) { this.close(); return; }
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

  _onData(d) {
    this._buf = this._buf.length ? Buffer.concat([this._buf, d]) : d;
    while (this.open) {
      const b = this._buf;
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0;
      const opcode = b[0] & 0x0f;
      const masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (b.length < 4) return;
        len = b.readUInt16BE(2); off = 4;
      } else if (len === 127) {
        if (b.length < 10) return;
        const hi = b.readUInt32BE(2), lo = b.readUInt32BE(6);
        len = hi * 4294967296 + lo; off = 10;
        if (len > 64 * 1024 * 1024) { this.close(); return; }
      }
      let mask = null;
      if (masked) {
        if (b.length < off + 4) return;
        mask = b.slice(off, off + 4); off += 4;
      }
      if (b.length < off + len) return;
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
    this._lastPong = Date.now();
    if (opcode === 0x8) { // close
      try { this._sendFrame(0x8, payload.slice(0, 2)); } catch (e) { /* ignore */ }
      this._closed();
      return;
    }
    if (opcode === 0x9) { this._sendFrame(0xA, payload); return; } // ping -> pong
    if (opcode === 0xA) { return; } // pong
    if (opcode === 0x0) { // continuation
      if (!this._frag) return;
      this._frag.chunks.push(payload);
      if (fin) {
        const all = Buffer.concat(this._frag.chunks);
        const op = this._frag.opcode;
        this._frag = null;
        this._deliver(op, all);
      }
      return;
    }
    if (!fin) { this._frag = { opcode, chunks: [payload] }; return; }
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
  if (head && head.length) conn._onData(head);
  return conn;
}

module.exports = { acceptUpgrade, WSConnection };
