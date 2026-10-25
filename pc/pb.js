'use strict';
// A tiny Protocol Buffers codec (proto2 wire format), driven by plain schemas:
//   { fieldName: [number, type, schema-or-undefined, 'rep' (repeated)] }
// types: 'u32' 'i32' 'enum' 'bool' (varint), 'i64' 'u64' (varint, as BigInt), 'bytes', 'string', 'msg', 'float'.
// Unknown fields are skipped when decoding. Enough for Quick Share's messages (see quickshare.js).

function varint(n) {
  let v = BigInt.asUintN(64, BigInt(n));
  const out = [];
  do { let b = Number(v & 0x7fn); v >>= 7n; if (v) b |= 0x80; out.push(b); } while (v);
  return Buffer.from(out);
}

function key(num, wire) { return varint((num << 3) | wire); }

function encode(schema, obj) {
  const parts = [];
  for (const [name, def] of Object.entries(schema)) {
    const [num, type, sub, rep] = def;
    let v = obj[name];
    if (v === undefined || v === null) continue;
    const vals = rep ? v : [v];
    for (const x of vals) {
      switch (type) {
        case 'u32': case 'i32': case 'enum': case 'i64': case 'u64':
          parts.push(key(num, 0), varint(type === 'i32' && x < 0 ? BigInt(x) : x)); break;
        case 'bool': parts.push(key(num, 0), varint(x ? 1 : 0)); break;
        case 'float': { const b = Buffer.alloc(4); b.writeFloatLE(x, 0); parts.push(key(num, 5), b); break; }
        case 'bytes': case 'string': case 'msg': {
          const b = type === 'msg' ? encode(sub, x) : type === 'string' ? Buffer.from(String(x), 'utf8') : Buffer.from(x);
          parts.push(key(num, 2), varint(b.length), b);
          break;
        }
        default: throw new Error('bad type ' + type);
      }
    }
  }
  return Buffer.concat(parts);
}

function readVarint(buf, off) {
  let v = 0n, shift = 0n, b;
  do {
    if (off >= buf.length) throw new Error('truncated varint');
    b = buf[off++];
    v |= BigInt(b & 0x7f) << shift;
    shift += 7n;
    if (shift > 70n) throw new Error('varint too long');
  } while (b & 0x80);
  return [v, off];
}

// field number -> [name, def], built once per schema
const INDEX = new WeakMap();
function indexOf(schema) {
  let byNum = INDEX.get(schema);
  if (!byNum) { byNum = {}; for (const [name, def] of Object.entries(schema)) byNum[def[0]] = [name, def]; INDEX.set(schema, byNum); }
  return byNum;
}

// Zero-copy: 'bytes' fields and nested messages are views into `buf` (code that keeps bytes beyond the life of the
// frame copies them itself, e.g. quickshare.js's clientInitRaw).
function decode(schema, buf) {
  const byNum = indexOf(schema);
  const out = {};
  let off = 0;
  if (!Buffer.isBuffer(buf)) buf = ArrayBuffer.isView(buf) ? Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength) : Buffer.from(buf);
  while (off < buf.length) {
    let k;
    [k, off] = readVarint(buf, off);
    const num = Number(k >> 3n), wire = Number(k & 7n);
    let raw;
    if (wire === 0) [raw, off] = readVarint(buf, off);
    else if (wire === 1) { if (off + 8 > buf.length) throw new Error('truncated'); raw = buf.subarray(off, off + 8); off += 8; }
    else if (wire === 5) { if (off + 4 > buf.length) throw new Error('truncated'); raw = buf.subarray(off, off + 4); off += 4; }
    else if (wire === 2) {
      let len;
      [len, off] = readVarint(buf, off);
      len = Number(len);
      if (off + len > buf.length) throw new Error('truncated field');
      raw = buf.subarray(off, off + len); off += len;
    } else throw new Error('bad wire type ' + wire);
    const f = byNum[num];
    if (!f) continue;
    const [name, [, type, sub, rep]] = f;
    // a field whose wire type doesn't fit its definition is treated as unknown (as protobuf itself does)
    if (wire !== (type === 'float' ? 5 : type === 'bytes' || type === 'string' || type === 'msg' ? 2 : 0)) continue;
    let v;
    switch (type) {
      case 'u32': case 'enum': v = Number(BigInt.asUintN(32, raw)); break;
      case 'i32': v = Number(BigInt.asIntN(32, raw)); break;
      case 'bool': v = raw !== 0n; break;
      case 'i64': v = BigInt.asIntN(64, raw); break;
      case 'u64': v = BigInt.asUintN(64, raw); break;
      case 'float': v = raw.readFloatLE(0); break;
      case 'bytes': v = raw; break;
      case 'string': v = raw.toString('utf8'); break;
      case 'msg': v = decode(sub, raw); break;
      default: continue;
    }
    if (rep) (out[name] = out[name] || []).push(v); else out[name] = v;
  }
  return out;
}

module.exports = { encode, decode, varint };
