'use strict';
// This PC's own TLS certificate: a P-256 key and a self-signed certificate, made once and kept in Flick's settings
// folder. Phones don't trust it because of who signed it (nobody did): they pin its SHA-256 fingerprint when they
// pair, after the user has checked the pairing code shown on both screens (see server.js, "pairing code").
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------- just enough DER to write one certificate
function len(n) {
  if (n < 0x80) return Buffer.from([n]);
  const b = [];
  while (n > 0) { b.unshift(n & 0xff); n = Math.floor(n / 256); }
  return Buffer.from([0x80 | b.length, ...b]);
}
const tlv = (tag, body) => Buffer.concat([Buffer.from([tag]), len(body.length), body]);
const seq = (...parts) => tlv(0x30, Buffer.concat(parts));
const set = (...parts) => tlv(0x31, Buffer.concat(parts));
const int = (buf) => tlv(0x02, buf);
const oid = (hex) => tlv(0x06, Buffer.from(hex, 'hex'));
const utf8 = (s) => tlv(0x0c, Buffer.from(s, 'utf8'));
const bits = (buf) => tlv(0x03, Buffer.concat([Buffer.from([0]), buf]));
const octets = (buf) => tlv(0x04, buf);
const explicit = (n, body) => tlv(0xa0 + n, body);

const OID_ECDSA_SHA256 = '2a8648ce3d040302';   // 1.2.840.10045.4.3.2
const OID_CN = '550403';                       // 2.5.4.3
const OID_BASIC_CONSTRAINTS = '551d13';        // 2.5.29.19

function time(d) {
  // UTCTime up to 2049, GeneralizedTime after (RFC 5280)
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const y = d.getUTCFullYear();
  const rest = p(d.getUTCMonth() + 1) + p(d.getUTCDate()) + p(d.getUTCHours()) + p(d.getUTCMinutes()) + p(d.getUTCSeconds()) + 'Z';
  return y < 2050 ? tlv(0x17, Buffer.from(p(y % 100) + rest)) : tlv(0x18, Buffer.from(p(y, 4) + rest));
}

/** A self-signed certificate for a P-256 key pair, as DER. */
function selfSigned(privateKey, publicKey, commonName) {
  const serial = crypto.randomBytes(16);
  serial[0] = (serial[0] & 0x7f) | 0x40;                       // positive, no leading zero byte
  const alg = seq(oid(OID_ECDSA_SHA256));
  const name = seq(set(seq(oid(OID_CN), utf8(commonName))));
  const now = Date.now();
  const tbs = seq(
    explicit(0, int(Buffer.from([2]))),                          // v3
    int(serial),
    alg,
    name,
    seq(time(new Date(now - 24 * 3600e3)), time(new Date(now + 30 * 365.25 * 24 * 3600e3))),
    name,
    publicKey.export({ type: 'spki', format: 'der' }),
    explicit(3, seq(seq(oid(OID_BASIC_CONSTRAINTS), tlv(0x01, Buffer.from([0xff])), octets(seq())))),   // CA: no (critical)
  );
  const sig = crypto.sign('sha256', tbs, privateKey);            // DER-encoded ECDSA signature
  return seq(tbs, alg, bits(sig));
}

const toPem = (der, label) => '-----BEGIN ' + label + '-----\n' + der.toString('base64').replace(/(.{64})/g, '$1\n').replace(/\n$/, '') + '\n-----END ' + label + '-----\n';

/** SHA-256 of a certificate (PEM or DER), as lowercase hex: what phones pin. */
function fingerprint(cert) {
  const der = Buffer.isBuffer(cert) ? cert : Buffer.from(String(cert).replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''), 'base64');
  return crypto.createHash('sha256').update(der).digest('hex');
}

const IS_WIN = process.platform === 'win32';
// Reads that fail for a moment (Windows: an antivirus or backup program holding the file; any system: too many open
// files, a disk hiccup) are tried again over about 0.8 s; still failing, this start goes without the certificate and
// the files are left as they are for the next one. Only a pair that's missing or read whole and found broken is made again:
// a new pair is a new fingerprint, and every phone and computer paired with this PC would have to pair again.
const RETRY_MS = [50, 100, 200, 400];
const wait = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (e) { /* no waiting here */ } };
const missing = (e) => !!e && (e.code === 'ENOENT' || e.code === 'ENOTDIR');

// One file's contents; null when it isn't there. Throws when it couldn't be read (the caller tries again).
function readOr(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch (e) { if (missing(e)) return null; throw e; }
}

// The pair, if it belongs together: { key, cert, fp }; null when it doesn't (missing, damaged, half-written).
function check(key, cert) {
  if (key == null || cert == null) return null;
  try {
    const pub = crypto.createPublicKey(crypto.createPrivateKey(key)).export({ type: 'spki', format: 'der' });
    if (new crypto.X509Certificate(cert).publicKey.export({ type: 'spki', format: 'der' }).equals(pub)) return { key, cert, fp: fingerprint(cert) };
  } catch (e) { /* doesn't parse */ }
  return null;
}

// The data in a temp file next to `file`, flushed to disk: renamed over it only once both files of the pair are written
function writeTemp(file, data, mode) {
  const tmp = file + '.tmp';
  const fd = fs.openSync(tmp, 'w', mode);
  // (a temp file left by a crash keeps its old permissions when opened again: the key's are set each time)
  try { if (mode && !IS_WIN) fs.fchmodSync(fd, mode); fs.writeSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  return tmp;
}
function renameRetry(from, to) {
  for (let i = 0; ; i++) {
    try { fs.renameSync(from, to); return; } catch (e) {
      if (i >= RETRY_MS.length || missing(e)) throw e;
      wait(RETRY_MS[i]);
    }
  }
}
// the renames themselves on disk (POSIX; Windows can't open a folder, and its rename is on disk once it returns)
function syncDir(dir) {
  if (IS_WIN) return;
  let fd = null;
  try { fd = fs.openSync(dir, 'r'); fs.fsyncSync(fd); } catch (e) { /* a file system that can't */ } finally { if (fd !== null) try { fs.closeSync(fd); } catch (e) { /* ignore */ } }
}

/**
 * This PC's key and certificate from dir (made the first time). Returns { key, cert, fp } (PEM strings, hex
 * fingerprint), or null if they can't be made or read now (Flick then works over plain connections only, which phones
 * refuse, until it's read later: server.setTls). opts.log(msg): why, when it's null; opts.wait: false to try the read
 * once, without the retries that hold up the caller (a later try in the same run).
 */
function ensure(dir, name, opts = {}) {
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const waits = opts.wait === false ? [] : RETRY_MS;
  const kp = path.join(dir, 'tls-key.pem'), cp = path.join(dir, 'tls-cert.pem');
  let key, cert;
  for (let i = 0; ; i++) {
    try { key = readOr(kp); cert = readOr(cp); break; } catch (e) {
      if (i >= waits.length) { log('certificate not readable now (' + (e.code || e.message) + '): kept as it is'); return null; }
      wait(waits[i]);
    }
  }
  const had = check(key, cert);
  if (had) return had;
  // missing, or read whole and broken (a half-written pair from a crash): a new pair
  const kTmp = kp + '.tmp', cTmp = cp + '.tmp';
  try {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    key = privateKey.export({ type: 'pkcs8', format: 'pem' });
    cert = toPem(selfSigned(privateKey, publicKey, String(name || 'Flick').slice(0, 60)), 'CERTIFICATE');
    fs.mkdirSync(dir, { recursive: true });
    // both written whole and on disk before either is put in place (a full disk stops it here, with nothing changed);
    // certificate first, key last: a crash between the two renames leaves a pair that doesn't match, made again
    writeTemp(cp, cert);
    writeTemp(kp, key, 0o600);
    renameRetry(cTmp, cp);
    renameRetry(kTmp, kp);
    syncDir(dir);
    return { key, cert, fp: fingerprint(cert) };
  } catch (e) {
    for (const t of [cTmp, kTmp]) { try { fs.unlinkSync(t); } catch (x) { /* not there */ } }
    log('certificate not made (' + (e.code || e.message) + ')');
    return null;
  }
}

module.exports = { ensure, fingerprint, selfSigned };
