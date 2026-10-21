'use strict';
// Quick Share (formerly Nearby Share) receiver: this PC shows up in Android's own Quick Share menu, and files sent to
// it land here like any other Flick transfer. Wi-Fi LAN only: the PC advertises itself over mDNS (mdns.js), the phone
// connects over TCP, the two run Google's UKEY2 key exchange, and everything after that is encrypted (SecureMessage:
// AES-256-CBC + HMAC-SHA256). The phone shows a 4-digit code; the PC shows the same code when it asks to accept.
//
// Message definitions follow Google's open-source Nearby code (offline_wire_formats.proto, ukey.proto,
// securemessage.proto, securegcm.proto, device_to_device_messages.proto, wire_format.proto); NearDrop (macOS) and
// rquickshare (Linux) were the references for the receiving side.
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const pb = require('./pb');
const { MdnsService } = require('./mdns');

// ---------------------------------------------------------------- schemas (field number, type, sub-schema, repeated)
const S = {};
S.OsInfo = { type: [1, 'enum'] };
S.ConnectionRequest = { endpoint_id: [1, 'string'], endpoint_name: [2, 'string'], handshake_data: [3, 'bytes'], nonce: [4, 'i32'], endpoint_info: [6, 'bytes'], keep_alive_interval_millis: [8, 'i32'], keep_alive_timeout_millis: [9, 'i32'] };
S.ConnectionResponse = { status: [1, 'i32'], handshake_data: [2, 'bytes'], response: [3, 'enum'], os_info: [4, 'msg', S.OsInfo], multiplex_socket_bitmask: [5, 'i32'], safe_to_disconnect_version: [7, 'i32'], keep_alive_timeout_millis: [9, 'i32'] };
S.PayloadHeader = { id: [1, 'i64'], type: [2, 'enum'], total_size: [3, 'i64'], is_sensitive: [4, 'bool'], file_name: [5, 'string'], parent_folder: [6, 'string'] };
S.PayloadChunk = { flags: [1, 'i32'], offset: [2, 'i64'], body: [3, 'bytes'], index: [4, 'i32'] };
S.ControlMessage = { event: [1, 'enum'], offset: [2, 'i64'] };
S.PayloadTransfer = { packet_type: [1, 'enum'], payload_header: [2, 'msg', S.PayloadHeader], payload_chunk: [3, 'msg', S.PayloadChunk], control_message: [4, 'msg', S.ControlMessage] };
S.KeepAlive = { ack: [1, 'bool'], seq_num: [2, 'u32'] };
S.Disconnection = { request_safe_to_disconnect: [1, 'bool'], ack_safe_to_disconnect: [2, 'bool'] };
S.V1Frame = { type: [1, 'enum'], connection_request: [2, 'msg', S.ConnectionRequest], connection_response: [3, 'msg', S.ConnectionResponse], payload_transfer: [4, 'msg', S.PayloadTransfer], keep_alive: [6, 'msg', S.KeepAlive], disconnection: [7, 'msg', S.Disconnection] };
S.OfflineFrame = { version: [1, 'enum'], v1: [2, 'msg', S.V1Frame] };
// UKEY2
S.Ukey2Message = { message_type: [1, 'enum'], message_data: [2, 'bytes'] };
S.CipherCommitment = { handshake_cipher: [1, 'enum'], commitment: [2, 'bytes'] };
S.Ukey2ClientInit = { version: [1, 'i32'], random: [2, 'bytes'], cipher_commitments: [3, 'msg', S.CipherCommitment, 'rep'], next_protocol: [4, 'string'] };
S.Ukey2ServerInit = { version: [1, 'i32'], random: [2, 'bytes'], handshake_cipher: [3, 'enum'], public_key: [4, 'bytes'] };
S.Ukey2ClientFinished = { public_key: [1, 'bytes'] };
S.Ukey2Alert = { type: [1, 'enum'], error_message: [2, 'string'] };
S.EcP256PublicKey = { x: [1, 'bytes'], y: [2, 'bytes'] };
S.GenericPublicKey = { type: [1, 'enum'], ec_p256_public_key: [2, 'msg', S.EcP256PublicKey] };
// SecureMessage / D2D
S.GcmMetadata = { type: [1, 'enum'], version: [2, 'i32'] };
S.Header = { signature_scheme: [1, 'enum'], encryption_scheme: [2, 'enum'], verification_key_id: [3, 'bytes'], decryption_key_id: [4, 'bytes'], iv: [5, 'bytes'], public_metadata: [6, 'bytes'], associated_data_length: [7, 'u32'] };
S.HeaderAndBody = { header: [1, 'msg', S.Header], body: [2, 'bytes'] };
S.SecureMessage = { header_and_body: [1, 'bytes'], signature: [2, 'bytes'] };
S.DeviceToDeviceMessage = { message: [1, 'bytes'], sequence_number: [2, 'i32'] };
// Sharing (inside BYTES payloads)
S.FileMetadata = { name: [1, 'string'], type: [2, 'enum'], payload_id: [3, 'i64'], size: [4, 'i64'], mime_type: [5, 'string'], id: [6, 'i64'], parent_folder: [7, 'string'] };
S.TextMetadata = { text_title: [2, 'string'], type: [3, 'enum'], payload_id: [4, 'i64'], size: [5, 'i64'], id: [6, 'i64'] };
S.Introduction = { file_metadata: [1, 'msg', S.FileMetadata, 'rep'], text_metadata: [2, 'msg', S.TextMetadata, 'rep'], required_package: [3, 'string'], start_transfer: [6, 'bool'] };
S.SharingResponse = { status: [1, 'enum'] };
S.PairedKeyEncryption = { signed_data: [1, 'bytes'], secret_id_hash: [2, 'bytes'], optional_signed_data: [3, 'bytes'] };
S.PairedKeyResult = { status: [1, 'enum'], os_type: [2, 'enum'] };
S.SharingV1 = { type: [1, 'enum'], introduction: [2, 'msg', S.Introduction], connection_response: [3, 'msg', S.SharingResponse], paired_key_encryption: [4, 'msg', S.PairedKeyEncryption], paired_key_result: [5, 'msg', S.PairedKeyResult] };
S.SharingFrame = { version: [1, 'enum'], v1: [2, 'msg', S.SharingV1] };

const V1 = { CONNECTION_REQUEST: 1, CONNECTION_RESPONSE: 2, PAYLOAD_TRANSFER: 3, KEEP_ALIVE: 5, DISCONNECTION: 6 };
const UKEY = { ALERT: 1, CLIENT_INIT: 2, SERVER_INIT: 3, CLIENT_FINISH: 4 };
const P256_SHA512 = 100;
const SHARE = { INTRODUCTION: 1, RESPONSE: 2, PAIRED_KEY_ENCRYPTION: 3, PAIRED_KEY_RESULT: 4, CANCEL: 6 };
const PAYLOAD = { BYTES: 1, FILE: 2 };
const LAST_CHUNK = 1;

// ---------------------------------------------------------------- crypto
const sha256 = (b) => crypto.createHash('sha256').update(b).digest();
const hkdf = (ikm, salt, info, len) => Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, len || 32));
const D2D_SALT = sha256(Buffer.from('D2D'));
const SM_SALT = sha256(Buffer.from('SecureMessage'));

/** EC public key coordinates as Java's BigInteger writes them: big-endian, a leading 0 when the top bit is set. */
function coord(b32) { return b32[0] & 0x80 ? Buffer.concat([Buffer.from([0]), b32]) : b32; }
function unsigned32(b) {
  let x = Buffer.from(b);
  while (x.length > 32 && x[0] === 0) x = x.subarray(1);
  if (x.length > 32) throw new Error('bad key');
  return Buffer.concat([Buffer.alloc(32 - x.length), x]);
}

/** The 4-digit code both sides show (Nearby's hash of the UKEY2 auth string). */
function pinFor(authString) {
  let hash = 0, mult = 1;
  for (const byte of authString) {
    const signed = byte > 127 ? byte - 256 : byte;
    hash = (hash + signed * mult) % 9973;
    mult = (mult * 31) % 9973;
  }
  return String(Math.abs(hash)).padStart(4, '0');
}

function deriveKeys(sharedSecret, clientInitRaw, serverInitRaw) {
  const derived = sha256(sharedSecret);
  const info = Buffer.concat([clientInitRaw, serverInitRaw]);
  const auth = hkdf(derived, Buffer.from('UKEY2 v1 auth'), info);
  const next = hkdf(derived, Buffer.from('UKEY2 v1 next'), info);
  const d2dClient = hkdf(next, D2D_SALT, Buffer.from('client'));
  const d2dServer = hkdf(next, D2D_SALT, Buffer.from('server'));
  return {
    pin: pinFor(auth), auth,
    clientEnc: hkdf(d2dClient, SM_SALT, Buffer.from('ENC:2')), clientSig: hkdf(d2dClient, SM_SALT, Buffer.from('SIG:1')),
    serverEnc: hkdf(d2dServer, SM_SALT, Buffer.from('ENC:2')), serverSig: hkdf(d2dServer, SM_SALT, Buffer.from('SIG:1')),
  };
}

function seal(encKey, sigKey, seq, frameBytes, fixedIv) {
  const d2d = pb.encode(S.DeviceToDeviceMessage, { message: frameBytes, sequence_number: seq });
  const iv = fixedIv || crypto.randomBytes(16);
  const c = crypto.createCipheriv('aes-256-cbc', encKey, iv);
  const body = Buffer.concat([c.update(d2d), c.final()]);
  const hb = pb.encode(S.HeaderAndBody, {
    header: { signature_scheme: 1, encryption_scheme: 2, iv, public_metadata: pb.encode(S.GcmMetadata, { type: 13, version: 1 }) },
    body,
  });
  const sig = crypto.createHmac('sha256', sigKey).update(hb).digest();
  return pb.encode(S.SecureMessage, { header_and_body: hb, signature: sig });
}

function open(encKey, sigKey, sealed) {
  const sm = pb.decode(S.SecureMessage, sealed);
  if (!sm.header_and_body || !sm.signature) throw new Error('not a secure message');
  const want = crypto.createHmac('sha256', sigKey).update(sm.header_and_body).digest();
  if (sm.signature.length !== want.length || !crypto.timingSafeEqual(sm.signature, want)) throw new Error('bad signature');
  const hb = pb.decode(S.HeaderAndBody, sm.header_and_body);
  const h = hb.header || {};
  const meta = h.public_metadata ? pb.decode(S.GcmMetadata, h.public_metadata) : {};
  if (h.signature_scheme !== 1 || h.encryption_scheme !== 2 || h.associated_data_length || meta.type !== 13 || meta.version !== 1 || !h.iv || h.iv.length !== 16) {
    throw new Error('unexpected secure message header');
  }
  const d = crypto.createDecipheriv('aes-256-cbc', encKey, h.iv);
  const plain = Buffer.concat([d.update(hb.body), d.final()]);
  return pb.decode(S.DeviceToDeviceMessage, plain);
}

// ---------------------------------------------------------------- endpoint info (who this PC is)
function b64url(b) { return Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function endpointInfo(name) {
  // the whole endpoint info may be at most 131 bytes: the name gets 113, cut on a character boundary
  let n = Buffer.from(String(name || 'PC'), 'utf8');
  if (n.length > 113) { let cut = 113; while (cut > 0 && (n[cut] & 0xc0) === 0x80) cut--; n = n.subarray(0, cut); }
  // byte 0: version 0, name present (visible to everyone), device type 3 (laptop) in bits 1-3
  return Buffer.concat([Buffer.from([3 << 1]), crypto.randomBytes(16), Buffer.from([n.length]), n]);
}
function parseEndpointInfo(b) {
  try {
    if (!b || b.length < 1) return { name: 'Android phone' };
    const type = (b[0] >> 1) & 7;
    if (b[0] & 0x10 || b.length < 19) return { name: 'Android phone', type };      // hidden: no name
    const len = b[17];
    const name = b.toString('utf8', 18, Math.min(b.length, 18 + len)).replace(/\uFFFD/g, '').trim();
    return { name: name || 'Android phone', type };
  } catch (e) { return { name: 'Android phone' }; }
}

// ---------------------------------------------------------------- one incoming phone
class Inbound extends EventEmitter {
  constructor(sock, server) {
    super();
    this.sock = sock;
    this.srv = server;
    this.id = crypto.randomBytes(4).toString('hex');
    this.buf = Buffer.alloc(0);
    this.state = 'request';          // request → clientInit → clientFinish → response → encrypted
    this.keys = null;
    this.outSeq = 0; this.inSeq = 0;
    this.payloads = new Map();       // payload id (string) → { chunks: [], size } for BYTES; file sinks for FILE
    this.files = new Map();          // payload id (string) → { meta, tmp, fd, got, size, done }
    this.texts = [];
    this.remote = { name: 'Android phone' };
    this.accepted = false;
    this.closed = false;
    this.bytes = 0; this.total = 0;
    sock.setNoDelay(true);
    sock.on('data', (d) => this._data(d));
    sock.on('close', () => this._close('closed'));
    sock.on('error', () => this._close('error'));
    this.idle = setTimeout(() => this.fail('handshake timeout'), 15000);
    this.lastRx = Date.now(); this.lastTx = Date.now();
    this.kaInterval = 5000; this.kaTimeout = 30000; this.kaSeq = 0;
  }

  // after the key exchange: answer and send keep-alives, and give up when the phone goes quiet
  _startKeepAlive() {
    clearTimeout(this.idle);
    this.kaTimer = setInterval(() => {
      const now = Date.now();
      if (now - this.lastRx > this.kaTimeout) return this.fail('phone went quiet');
      if (now - this.lastTx >= this.kaInterval) this._send({ version: 1, v1: { type: V1.KEEP_ALIVE, keep_alive: { ack: false, seq_num: ++this.kaSeq } } });
    }, 1000);
  }

  _touch() { this.lastRx = Date.now(); }

  _data(d) {
    if (this.closed) return;
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32BE(0);
      if (len > 5 * 1024 * 1024) return this.fail('frame too big');
      if (this.buf.length < 4 + len) break;
      const frame = this.buf.subarray(4, 4 + len);
      this.buf = this.buf.subarray(4 + len);
      try { this._frame(frame); } catch (e) { this.srv.log('quick share:', e.message); return this.fail(e.message); }
      if (this.closed) return;
    }
  }

  _write(bytes) { if (this.closed) return; const h = Buffer.alloc(4); h.writeUInt32BE(bytes.length, 0); this.lastTx = Date.now(); this.sock.write(Buffer.concat([h, bytes])); }

  _send(offlineFrame) {
    const bytes = pb.encode(S.OfflineFrame, offlineFrame);
    if (!this.keys) return this._write(bytes);
    this.outSeq++;
    this._write(seal(this.keys.serverEnc, this.keys.serverSig, this.outSeq, bytes));
  }

  // a sharing frame goes as a BYTES payload: one chunk with the data, then an empty last chunk
  _sendSharing(frame) {
    const body = pb.encode(S.SharingFrame, { version: 1, v1: frame });
    const id = BigInt.asIntN(64, crypto.randomBytes(8).readBigUInt64BE(0));
    const header = { id, type: PAYLOAD.BYTES, total_size: body.length, is_sensitive: false };
    this._send({ version: 1, v1: { type: V1.PAYLOAD_TRANSFER, payload_transfer: { packet_type: 1, payload_header: header, payload_chunk: { flags: 0, offset: 0, body } } } });
    this._send({ version: 1, v1: { type: V1.PAYLOAD_TRANSFER, payload_transfer: { packet_type: 1, payload_header: header, payload_chunk: { flags: LAST_CHUNK, offset: body.length } } } });
  }

  _frame(raw) {
    this._touch();
    switch (this.state) {
      case 'request': {
        const f = pb.decode(S.OfflineFrame, raw);
        if (!f.v1 || f.v1.type !== V1.CONNECTION_REQUEST || !f.v1.connection_request) throw new Error('expected a connection request');
        const cr = f.v1.connection_request;
        this.remote = parseEndpointInfo(cr.endpoint_info);
        if (cr.keep_alive_interval_millis > 0 && cr.keep_alive_timeout_millis > cr.keep_alive_interval_millis) {
          this.kaInterval = Math.min(60000, cr.keep_alive_interval_millis); this.kaTimeout = Math.min(300000, cr.keep_alive_timeout_millis);
        }
        this.state = 'clientInit';
        return;
      }
      case 'clientInit': {
        const m = pb.decode(S.Ukey2Message, raw);
        if (m.message_type !== UKEY.CLIENT_INIT) throw new Error('expected UKEY2 client init');
        const ci = pb.decode(S.Ukey2ClientInit, m.message_data || Buffer.alloc(0));
        if (ci.version !== 1) return this._alert(100, 'bad version');
        if (!ci.random || ci.random.length !== 32) return this._alert(101, 'bad random');
        const cc = (ci.cipher_commitments || []).find((c) => c.handshake_cipher === P256_SHA512);
        if (!cc || !cc.commitment) return this._alert(102, 'no P256_SHA512');
        if (ci.next_protocol !== 'AES_256_CBC-HMAC_SHA256') return this._alert(103, 'bad next protocol');
        this.clientInitRaw = Buffer.from(raw);
        this.commitment = cc.commitment;
        this.ecdh = crypto.createECDH('prime256v1');
        const pub = this.ecdh.generateKeys();                 // 0x04 || X || Y
        const pk = pb.encode(S.GenericPublicKey, { type: 1, ec_p256_public_key: { x: coord(pub.subarray(1, 33)), y: coord(pub.subarray(33, 65)) } });
        const si = pb.encode(S.Ukey2ServerInit, { version: 1, random: crypto.randomBytes(32), handshake_cipher: P256_SHA512, public_key: pk });
        this.serverInitRaw = pb.encode(S.Ukey2Message, { message_type: UKEY.SERVER_INIT, message_data: si });
        this._write(this.serverInitRaw);
        this.state = 'clientFinish';
        return;
      }
      case 'clientFinish': {
        const m = pb.decode(S.Ukey2Message, raw);
        if (m.message_type !== UKEY.CLIENT_FINISH) throw new Error('expected UKEY2 client finish');
        const commit = crypto.createHash('sha512').update(raw).digest();
        if (!crypto.timingSafeEqual(commit, this.commitment.length === 64 ? this.commitment : Buffer.alloc(64))) throw new Error('commitment mismatch');
        const cf = pb.decode(S.Ukey2ClientFinished, m.message_data || Buffer.alloc(0));
        const gk = pb.decode(S.GenericPublicKey, cf.public_key || Buffer.alloc(0));
        if (!gk.ec_p256_public_key) throw new Error('no client key');
        const cpub = Buffer.concat([Buffer.from([4]), unsigned32(gk.ec_p256_public_key.x), unsigned32(gk.ec_p256_public_key.y)]);
        const secret = this.ecdh.computeSecret(cpub);
        this.pendingKeys = deriveKeys(secret, this.clientInitRaw, this.serverInitRaw);
        this.pin = this.pendingKeys.pin;
        this.state = 'response';
        return;
      }
      case 'response': {
        // the phone's (unencrypted) connection response; we answer, and from then on everything is encrypted
        const f = pb.decode(S.OfflineFrame, raw);
        if (f.v1 && f.v1.type === V1.KEEP_ALIVE) return;
        if (!f.v1 || f.v1.type !== V1.CONNECTION_RESPONSE) throw new Error('expected a connection response');
        const r = f.v1.connection_response || {};
        if (!(r.response === 1 || (r.response === undefined && (r.status || 0) === 0))) return this.fail('phone declined');
        this._send({ version: 1, v1: { type: V1.CONNECTION_RESPONSE, connection_response: { status: 0, response: 1, os_info: { type: 3 } } } });
        this.keys = this.pendingKeys;
        this._startKeepAlive();
        this.state = 'encrypted';
        // no shared contacts here: an empty "paired key" exchange (random data of the usual sizes)
        this._sendSharing({ type: SHARE.PAIRED_KEY_ENCRYPTION, paired_key_encryption: { secret_id_hash: crypto.randomBytes(6), signed_data: crypto.randomBytes(72) } });
        return;
      }
      case 'encrypted': {
        let f;
        try {
          const d2d = open(this.keys.clientEnc, this.keys.clientSig, raw);
          if (d2d.sequence_number !== this.inSeq + 1) throw new Error('out of order');
          this.inSeq = d2d.sequence_number;
          f = pb.decode(S.OfflineFrame, d2d.message || Buffer.alloc(0));
        } catch (e) {
          // a plain keep-alive or goodbye can still arrive right after the switch to encryption
          let plain = null;
          try { plain = pb.decode(S.OfflineFrame, raw); } catch (x) { /* not plain either */ }
          if (!plain || !plain.v1 || (plain.v1.type !== V1.KEEP_ALIVE && plain.v1.type !== V1.DISCONNECTION)) throw e;
          f = plain;
        }
        if (!f.v1) return;
        if (f.v1.type === V1.KEEP_ALIVE) {
          const ka = f.v1.keep_alive || {};
          if (!ka.ack) this._send({ version: 1, v1: { type: V1.KEEP_ALIVE, keep_alive: { ack: true, seq_num: ka.seq_num } } });
          return;
        }
        if (f.v1.type === V1.DISCONNECTION) { this._finishIfDone(); this._close('phone disconnected'); return; }
        if (f.v1.type === V1.PAYLOAD_TRANSFER && f.v1.payload_transfer) return this._payload(f.v1.payload_transfer);
        return;
      }
      default: throw new Error('bad state');
    }
  }

  _alert(type, msg) {
    this._write(pb.encode(S.Ukey2Message, { message_type: UKEY.ALERT, message_data: pb.encode(S.Ukey2Alert, { type, error_message: msg }) }));
    this.fail(msg);
  }

  _payload(pt) {
    const h = pt.payload_header || {}, c = pt.payload_chunk;
    if (pt.packet_type === 2) {                         // control: the phone canceled or failed
      if (pt.control_message && (pt.control_message.event === 1 || pt.control_message.event === 2)) this.fail('canceled on the phone');
      return;
    }
    if (!c) return;
    const key = String(h.id);
    if (h.type === PAYLOAD.BYTES) {
      let p = this.payloads.get(key);
      if (!p) { p = { chunks: [], size: 0 }; this.payloads.set(key, p); }
      if (BigInt(c.offset || 0n) !== BigInt(p.size)) throw new Error('payload chunk out of order');
      if (c.body && c.body.length) { p.size += c.body.length; if (p.size > 5 * 1024 * 1024) throw new Error('payload too big'); p.chunks.push(c.body); }
      if (c.flags & LAST_CHUNK) {
        this.payloads.delete(key);
        const data = Buffer.concat(p.chunks);
        const text = this.texts.find((t) => String(t.payload_id) === key);
        if (text) { text.value = data.toString('utf8'); text.done = true; this._finishIfDone(); return; }
        let frame;
        try { frame = pb.decode(S.SharingFrame, data); } catch (e) { this.srv.log('quick share: skipped a payload it could not read'); return; }
        if (frame.version === 1) this._sharing(frame);
      }
      return;
    }
    if (h.type === PAYLOAD.FILE) {
      const f = this.files.get(key);
      if (!this.accepted) return;
      if (!f) throw new Error('unknown file');
      if (f.done) return;
      if (c.body && c.body.length) {
        if (BigInt(c.offset || 0n) !== BigInt(f.got)) throw new Error('file chunk out of order');
        if (f.got + c.body.length > f.size) throw new Error('file larger than announced');
        fs.writeSync(f.fd, c.body);
        f.got += c.body.length;
        this.bytes += c.body.length;
        this.emit('progress', { id: this.id, got: this.bytes, total: this.total });
      }
      if (c.flags & LAST_CHUNK) {
        if (f.got !== f.size) throw new Error('file shorter than announced');
        fs.closeSync(f.fd); f.fd = null; f.done = true;
        this._finishIfDone();
      }
    }
  }

  _sharing(frame) {
    const v1 = frame.v1 || {};
    switch (v1.type) {
      case SHARE.PAIRED_KEY_ENCRYPTION:
        this._sendSharing({ type: SHARE.PAIRED_KEY_RESULT, paired_key_result: { status: 3 } });   // UNABLE: no shared contacts
        return;
      case SHARE.PAIRED_KEY_RESULT:
        return;
      case SHARE.INTRODUCTION: {
        const intro = v1.introduction || {};
        const files = (intro.file_metadata || []).map((m) => ({
          name: path.basename(String(m.name || 'file').replace(/\\/g, '/')) || 'file',
          size: Number(m.size || 0n), payload_id: m.payload_id, mime: m.mime_type || 'application/octet-stream',
        }));
        this.texts = (intro.text_metadata || []).map((t) => ({ title: t.text_title || '', type: t.type || 0, payload_id: t.payload_id, size: Number(t.size || 0n) }));
        if (!files.length && !this.texts.length) { this._sendSharing({ type: SHARE.RESPONSE, connection_response: { status: 4 } }); return this.fail('nothing supported'); }
        this.offer = { files, texts: this.texts };
        this.total = files.reduce((s, f) => s + f.size, 0);
        this.emit('request', { id: this.id, from: this.remote.name, pin: this.pin, files: files.map((f) => ({ name: f.name, size: f.size, mime: f.mime })), texts: this.texts.map((t) => ({ title: t.title, type: t.type })) });
        return;
      }
      case SHARE.CANCEL:
        this._bye();
        this.fail('canceled on the phone');
        return;
      default: return;
    }
  }

  /** The user's answer on the PC (why = 'timeout' when nobody answered in time). */
  answer(accept, why) {
    if (this.closed || !this.offer || this.answered) return;
    this.answered = true;
    if (!accept) {
      this._sendSharing({ type: SHARE.RESPONSE, connection_response: { status: why === 'timeout' ? 5 : 2 } });
      setTimeout(() => { this._bye(); this._close('declined'); }, 1000);
      return;
    }
    fs.mkdirSync(this.srv.tmpDir, { recursive: true });
    for (const f of this.offer.files) {
      const tmp = path.join(this.srv.tmpDir, 'qs-' + this.id + '-' + crypto.randomBytes(3).toString('hex') + '.part');
      this.files.set(String(f.payload_id), { meta: f, tmp, fd: fs.openSync(tmp, 'w'), got: 0, size: f.size, done: false });
    }
    this.accepted = true;
    this._touch();
    this._sendSharing({ type: SHARE.RESPONSE, connection_response: { status: 1 } });
    this.emit('accepted', { id: this.id, total: this.total, files: this.offer.files.length });
  }

  _finishIfDone() {
    if (this.finished || !this.accepted) return;
    const filesDone = [...this.files.values()].every((f) => f.done);
    const textsDone = this.texts.every((t) => t.done);
    if (!filesDone || !textsDone) return;
    this.finished = true;
    this.emit('done', {
      id: this.id, from: this.remote.name,
      files: [...this.files.values()].map((f) => ({ tmpPath: f.tmp, name: f.meta.name, size: f.got, mime: f.meta.mime })),
      texts: this.texts.map((t) => ({ title: t.title, type: t.type, value: t.value || '' })),
    });
    // the receiver hangs up: the phone shows "sent" once we disconnect
    this._bye();
    setTimeout(() => this._close('done'), 300);
  }

  _bye() { try { if (!this.closed && this.keys) this._send({ version: 1, v1: { type: V1.DISCONNECTION, disconnection: {} } }); } catch (e) { /* ignore */ } }

  /** Stop from the PC side: tell the phone, then hang up. */
  cancel(why) {
    if (this.closed) return;
    if (this.keys) { try { this._sendSharing({ type: SHARE.CANCEL }); } catch (e) { /* ignore */ } }
    this.fail(why || 'canceled');
  }

  fail(why) {
    if (this.closed) return;
    if (!this.finished) this.emit('failed', { id: this.id, why, accepted: this.accepted });
    this._close(why);
  }

  _close(why) {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.idle);
    clearInterval(this.kaTimer);
    for (const f of this.files.values()) {
      if (f.fd != null) { try { fs.closeSync(f.fd); } catch (e) { /* ignore */ } f.fd = null; }
      if (!f.done || !this.finished) fs.unlink(f.tmp, () => {});
    }
    if (!this.finished && this.accepted && why !== 'done') this.emit('failed', { id: this.id, why, accepted: true });
    const sock = this.sock;
    try { sock.end(); } catch (e) { /* ignore */ }
    setTimeout(() => { try { sock.destroy(); } catch (e) { /* ignore */ } }, 1000).unref();
    this.emit('closed', why);
  }
}

// ---------------------------------------------------------------- the receiver
class QuickShare extends EventEmitter {
  /** opts: { name, tmpDir, log } */
  constructor(opts) {
    super();
    this.name = opts.name || os.hostname();
    this.tmpDir = opts.tmpDir || path.join(os.tmpdir(), 'flick-quickshare');
    this.log = opts.log || (() => {});
    this.conns = new Map();
    this.server = null;
    this.mdns = null;
    this.state = 'off';
  }

  _set(s) { if (s !== this.state) { this.state = s; this.emit('state', s); } }

  async start() {
    if (this.server) return;
    this._set('starting');
    this.server = net.createServer((sock) => this._conn(sock));
    try { await new Promise((res, rej) => { this.server.once('error', rej); this.server.listen(0, '0.0.0.0', res); }); }
    catch (e) { this.log('quick share', e.message); this.server = null; this._set('error'); return; }
    const port = this.server.address().port;
    // endpoint id: 4 random letters/digits; the service id hash for "NearbySharing" is FC 9F 5E
    const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const endpoint = Array.from(crypto.randomBytes(4), (b) => abc[b % abc.length]).join('');
    const instance = b64url(Buffer.concat([Buffer.from([0x23]), Buffer.from(endpoint, 'ascii'), Buffer.from([0xfc, 0x9f, 0x5e, 0, 0])]));
    this.mdns = new MdnsService({
      type: '_FC9F5ED42C8A._tcp.local', instance, host: 'flick-' + endpoint.toLowerCase() + '.local', port,
      txt: { n: b64url(endpointInfo(this.name)) },
    }, this.log);
    this.mdns.on('unavailable', () => this._set('no-mdns'));
    this.mdns.start();
    this.port = port;
    this.log('quick share ready on port', port, 'as', this.name);
    this._set('on');
  }

  setName(name) {
    this.name = name || this.name;
    if (this.mdns) { this.mdns.svc.txt = { n: b64url(endpointInfo(this.name)) }; this.mdns.announce(); }
  }

  _conn(sock) {
    const c = new Inbound(sock, this);
    this.conns.set(c.id, c);
    for (const ev of ['request', 'accepted', 'progress', 'done', 'failed']) c.on(ev, (m) => this.emit(ev, m));
    c.on('closed', () => this.conns.delete(c.id));
  }

  answer(id, accept, why) { const c = this.conns.get(id); if (c) c.answer(accept, why); }
  cancel(id, why) { const c = this.conns.get(id); if (c) c.cancel(why); }

  stop() {
    if (this.mdns) { this.mdns.stop(); this.mdns = null; }
    if (this.server) { try { this.server.close(); } catch (e) { /* ignore */ } this.server = null; }
    for (const c of this.conns.values()) c.fail('stopped');
    this.conns.clear();
    this._set('off');
  }
}

module.exports = { QuickShare, S, pb, deriveKeys, seal, open, pinFor, endpointInfo, parseEndpointInfo, coord, unsigned32, V1, UKEY, SHARE, PAYLOAD };
