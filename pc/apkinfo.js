'use strict';
// Reads what the PC needs to offer a phone update from an APK file: package name, versionCode, versionName,
// size and SHA-256. Pure Node (zip central directory + Android binary XML), no dependencies.
const fs = require('fs');
const zlib = require('zlib');
const crypto = require('crypto');

const MAX_APK = 200 * 1024 * 1024;
const ATTR_VERSION_CODE = 0x0101021b;
const ATTR_VERSION_NAME = 0x0101021c;

function findEntry(buf, wanted) {
  // end of central directory: last 22..65557 bytes
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad zip directory');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    if (name === wanted) {
      if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) throw new Error('bad zip entry');
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + csize);
      if (method === 0) return Buffer.from(data);
      if (method === 8) return zlib.inflateRawSync(data, { maxOutputLength: 16 * 1024 * 1024 });
      throw new Error('unsupported compression');
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

function readStringPool(b, off) {
  const count = b.readUInt32LE(off + 8);
  const flags = b.readUInt32LE(off + 16);
  const stringsStart = b.readUInt32LE(off + 20);
  const utf8 = (flags & 0x100) !== 0;
  const out = new Array(count);
  for (let i = 0; i < count; i++) {
    let p = off + stringsStart + b.readUInt32LE(off + 28 + i * 4);
    if (utf8) {
      let u16len = b[p++]; if (u16len & 0x80) p++;                         // UTF-16 length (unused)
      let len = b[p++]; if (len & 0x80) len = ((len & 0x7f) << 8) | b[p++];
      out[i] = b.toString('utf8', p, p + len);
    } else {
      let len = b.readUInt16LE(p); p += 2;
      if (len & 0x8000) { len = ((len & 0x7fff) << 16) | b.readUInt16LE(p); p += 2; }
      out[i] = b.toString('utf16le', p, p + len * 2);
    }
  }
  return out;
}

/** <manifest> attributes from a binary AndroidManifest.xml. */
function parseManifest(b) {
  if (b.length < 8 || b.readUInt16LE(0) !== 0x0003) throw new Error('not binary xml');
  let strings = [], resIds = [];
  let p = b.readUInt16LE(2);
  while (p + 8 <= b.length) {
    const type = b.readUInt16LE(p), hsize = b.readUInt16LE(p + 2), size = b.readUInt32LE(p + 4);
    if (size < 8 || p + size > b.length) break;
    if (type === 0x0001) strings = readStringPool(b, p);
    else if (type === 0x0180) { resIds = []; for (let q = p + hsize; q + 4 <= p + size; q += 4) resIds.push(b.readUInt32LE(q)); }
    else if (type === 0x0102) {
      const ext = p + hsize;
      const name = strings[b.readUInt32LE(ext + 4)];
      if (name === 'manifest') {
        const attrStart = b.readUInt16LE(ext + 8), attrSize = b.readUInt16LE(ext + 10), attrCount = b.readUInt16LE(ext + 12);
        const r = { package: null, versionCode: null, versionName: null };
        for (let i = 0; i < attrCount; i++) {
          const a = ext + attrStart + i * attrSize;
          const ni = b.readUInt32LE(a + 4), raw = b.readUInt32LE(a + 8), dtype = b[a + 15], data = b.readUInt32LE(a + 16);
          const id = ni < resIds.length ? resIds[ni] : 0;
          const an = strings[ni] || '';
          const str = raw !== 0xffffffff ? strings[raw] : (dtype === 0x03 ? strings[data] : null);
          if (an === 'package' && !id) r.package = str;
          else if (id === ATTR_VERSION_CODE || (!id && an === 'versionCode')) r.versionCode = (dtype >= 0x10 && dtype <= 0x11) ? data : parseInt(str, 10);
          else if (id === ATTR_VERSION_NAME || (!id && an === 'versionName')) r.versionName = str != null ? String(str) : String(data);
        }
        return r;
      }
    }
    p += size;
  }
  throw new Error('no manifest element');
}

function infoFrom(buf, mtime) {
  const xml = findEntry(buf, 'AndroidManifest.xml');
  if (!xml) throw new Error('no manifest');
  const m = parseManifest(xml);
  if (!m.package || !Number.isFinite(m.versionCode)) throw new Error('incomplete manifest');
  return {
    package: m.package, code: m.versionCode, name: m.versionName || String(m.versionCode),
    size: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex'), mtime,
  };
}

/** { package, code, name, size, sha256, mtime } for an APK, or throws. */
function apkInfo(file) {
  const st = fs.statSync(file);
  if (!st.isFile() || st.size < 100 || st.size > MAX_APK) throw new Error('not an apk');
  return infoFrom(fs.readFileSync(file), st.mtimeMs);
}

async function apkInfoAsync(file, maxBytes) {
  const st = await fs.promises.stat(file);
  if (!st.isFile() || st.size < 100 || st.size > Math.min(MAX_APK, maxBytes || MAX_APK)) throw new Error('not an apk');
  return infoFrom(await fs.promises.readFile(file), st.mtimeMs);
}

module.exports = { apkInfo, apkInfoAsync, parseManifest, findEntry };
