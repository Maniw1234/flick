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

/**
 * This PC's key and certificate from dir (made the first time). Returns { key, cert, fp } (PEM strings, hex
 * fingerprint), or null if they can't be made or read (Flick then works over plain connections only).
 */
function ensure(dir, name) {
  const kp = path.join(dir, 'tls-key.pem'), cp = path.join(dir, 'tls-cert.pem');
  try {
    const key = fs.readFileSync(kp, 'utf8'), cert = fs.readFileSync(cp, 'utf8');
    // the pair must still belong together (a half-written pair from a crash is made again)
    const pub = crypto.createPublicKey(crypto.createPrivateKey(key)).export({ type: 'spki', format: 'der' });
    if (new crypto.X509Certificate(cert).publicKey.export({ type: 'spki', format: 'der' }).equals(pub)) return { key, cert, fp: fingerprint(cert) };
  } catch (e) { /* missing or damaged: make a new pair */ }
  try {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const key = privateKey.export({ type: 'pkcs8', format: 'pem' });
    const cert = toPem(selfSigned(privateKey, publicKey, String(name || 'Flick').slice(0, 60)), 'CERTIFICATE');
    fs.mkdirSync(dir, { recursive: true });
    // certificate first, key last: a crash in between leaves a pair that doesn't match, which is made again
    fs.writeFileSync(cp + '.tmp', cert); fs.renameSync(cp + '.tmp', cp);
    fs.writeFileSync(kp + '.tmp', key, { mode: 0o600 }); fs.renameSync(kp + '.tmp', kp);
    return { key, cert, fp: fingerprint(cert) };
  } catch (e) { return null; }
}

module.exports = { ensure, fingerprint, selfSigned };
