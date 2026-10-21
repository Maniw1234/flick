'use strict';
// Pieces of the PC self-updater that don't need Electron: versions, the update folder, and unpacking an app bundle.
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const MAX_BUNDLE = 80 * 1024 * 1024;       // a whole app bundle, zipped
const MAX_ENTRY = 120 * 1024 * 1024;       // one unpacked file
const MAX_FILES = 2000;

/** Where downloaded app updates live: %LOCALAPPDATA%\Flick\app on Windows (no admin rights needed). */
function updatesRoot() {
  if (process.env.FLICK_UPDATES_DIR) return process.env.FLICK_UPDATES_DIR;
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) return path.join(process.env.LOCALAPPDATA, 'Flick', 'app');
  return path.join(os.homedir(), '.flick', 'app');
}

function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(v || '').trim());
  return m ? [+m[1], +m[2], +m[3]] : null;
}

/** true when version a is newer than b */
function newer(a, b) {
  const x = parseVersion(a), y = parseVersion(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

function readCurrent(root) {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(root, 'current.json'), 'utf8'));
    if (!c || !parseVersion(c.version) || typeof c.dir !== 'string' || !/^[\w.-]+$/.test(c.dir)) return null;
    c.tries = Math.max(0, +c.tries || 0);
    return c;
  } catch (e) { return null; }
}

function writeCurrent(root, c) {
  fs.mkdirSync(root, { recursive: true });
  const tmp = path.join(root, 'current.json.tmp');
  fs.writeFileSync(tmp, JSON.stringify(c));
  fs.renameSync(tmp, path.join(root, 'current.json'));
}

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

/** Every file in a zip, as [{ name, data }]; refuses anything that could land outside the target folder. */
function unzipAll(buf) {
  if (buf.length > MAX_BUNDLE) throw new Error('bundle too big');
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('not a zip');
  const count = buf.readUInt16LE(eocd + 10);
  if (count > MAX_FILES) throw new Error('too many files');
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad zip directory');
    const flags = buf.readUInt16LE(p + 8), method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16), csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen).replace(/\\/g, '/');
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;                                   // folder entry
    if (flags & 1) throw new Error('encrypted entry');
    const segs = name.split('/');
    if (!name || name.startsWith('/') || /^[a-zA-Z]:/.test(name) || segs.some((s) => !s || s === '.' || s === '..')) throw new Error('bad path ' + name);
    if (usize > MAX_ENTRY) throw new Error('entry too big');
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) throw new Error('bad zip entry');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + csize);
    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = zlib.inflateRawSync(raw, { maxOutputLength: MAX_ENTRY });
    else throw new Error('unsupported compression');
    if (data.length !== usize || (zlib.crc32 && zlib.crc32(data) >>> 0 !== crc >>> 0)) throw new Error('damaged entry ' + name);
    out.push({ name, data });
  }
  return out;
}

/** Unpacks a verified app bundle into root/<version> (via a temporary folder, so a half-written copy is never used). */
function installBundle(root, version, zipBuf) {
  const files = unzipAll(zipBuf);
  const pkg = files.find((f) => f.name === 'package.json');
  const main = files.find((f) => f.name === 'main.js');
  if (!pkg || !main) throw new Error('not a Flick bundle');
  const meta = JSON.parse(pkg.data.toString('utf8'));
  if (meta.version !== version) throw new Error('bundle is ' + meta.version + ', expected ' + version);
  fs.mkdirSync(root, { recursive: true });
  const tmp = path.join(root, '.tmp-' + version + '-' + crypto.randomBytes(4).toString('hex'));
  const dest = path.join(root, version);
  try {
    for (const f of files) {
      const full = path.join(tmp, ...f.name.split('/'));
      if (!full.startsWith(tmp + path.sep)) throw new Error('bad path');
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, f.data);
    }
    fs.rmSync(dest, { recursive: true, force: true });
    fs.renameSync(tmp, dest);
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
  return { dir: version, files: files.length, meta };
}

/** Remove every update folder except the one in use (and the one about to be used). */
function pruneUpdates(root, keep) {
  let names = [];
  try { names = fs.readdirSync(root); } catch (e) { return; }
  for (const n of names) {
    if (n === 'current.json' || keep.includes(n)) continue;
    fs.rmSync(path.join(root, n), { recursive: true, force: true });
  }
}

module.exports = { updatesRoot, parseVersion, newer, readCurrent, writeCurrent, sha256, unzipAll, installBundle, pruneUpdates };
