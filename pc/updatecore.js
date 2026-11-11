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

// Flick's offline release keys (ECDSA P-256, SubjectPublicKeyInfo DER in base64). Every release's SHA256SUMS is signed
// with one of them (signing/sign_release.js) and GitHub never sees the private key, so whoever controls the GitHub
// account still can't ship an update. A list, so a new key can be added here before the old one is retired.
// The first signed 1.0.0 to 2.0.0; the second is 2.1.0's and later's (the first one's private key was lost: Flick up
// to 2.0.0 trusts only the first, so it can't take 2.1.0 or later by itself).
const RELEASE_KEYS = [
  'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEUGJiEHyLcmPkuREqLXb7MLtKMKoRBQUNuKb8Gjcw7tIMuDVr0cRSM2Xjpu3SWDM4vdpGOJXnYjVG5Tin5P1DZA==',
  'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAELU1g7gj5eo8f4zxqhHjy5gQg43UxUxZZcyO7xUf6BM6NdT+2PPtFYDLOjpBqdmbSuicuolvb+aVKBvg6zTyVvA==',
];

/**
 * Where downloaded app updates live, per user (no admin rights needed): %LOCALAPPDATA%\Flick\app on Windows,
 * ~/Library/Application Support/Flick/app on macOS, $XDG_DATA_HOME/Flick/app (~/.local/share/Flick/app) on Linux.
 */
function updatesRoot() {
  if (process.env.FLICK_UPDATES_DIR) return process.env.FLICK_UPDATES_DIR;
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) return path.join(process.env.LOCALAPPDATA, 'Flick', 'app');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Flick', 'app');
  if (process.platform === 'linux') {
    const x = process.env.XDG_DATA_HOME;
    return path.join(x && path.isAbsolute(x) ? x : path.join(os.homedir(), '.local', 'share'), 'Flick', 'app');
  }
  return path.join(os.homedir(), '.flick', 'app');
}

/**
 * The app bundle a release carries for a system (process.platform by default): flick-app-<version>.zip is Windows'
 * (the name installed copies have always looked for), flick-app-mac-<version>.zip and flick-app-linux-<version>.zip
 * hold the same app with the Mac's or Linux's own helpers.
 */
function bundleName(version, platform) {
  const p = platform || process.platform;
  return 'flick-app-' + (p === 'darwin' ? 'mac-' : p === 'linux' ? 'linux-' : '') + version + '.zip';
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
    // dir is always a version folder; requiring it to parse as a version rejects "..", ".", and anything path-like
    if (!c || !parseVersion(c.version) || typeof c.dir !== 'string' || !parseVersion(c.dir)) return null;
    c.tries = Math.max(0, +c.tries || 0);
    return c;
  } catch (e) { return null; }
}

// A folder's own entries on disk (POSIX: until then a power cut can undo a rename or lose a new file's name). Windows
// can't open a folder to do it (and what it renames is on disk once that returns).
function syncDirSync(dir) {
  if (process.platform === 'win32') return;
  let fd = null;
  try { fd = fs.openSync(dir, 'r'); fs.fsyncSync(fd); } catch (e) { /* a file system that can't: as it is */ } finally { if (fd !== null) try { fs.closeSync(fd); } catch (e) { /* ignore */ } }
}
async function syncDir(dir) {
  if (process.platform === 'win32') return;
  let fh = null;
  try { fh = await fs.promises.open(dir, 'r'); await fh.sync(); } catch (e) { /* as above */ } finally { if (fh) await fh.close().catch(() => {}); }
}
// a small file written whole and on disk before it's used
function writeSyncedSync(file, data) {
  const fd = fs.openSync(file, 'w');
  try { fs.writeSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

/**
 * On disk before this returns, whole (durable: the update's files with it, see installFiles). A power cut just after an
 * update was made ready must never leave Flick pointed at a version whose files never reached the disk: such a copy
 * starts as nothing at all (an empty main.js is no error), three times, before it's skipped. The count of tries each
 * start writes is flushed too: where a rename that wasn't flushed comes back after a power cut as an empty file (NTFS,
 * XFS), the next start couldn't read current.json, would run the installed version and tidy the update away. (A small
 * file: a few ms at most, and only when a downloaded version starts.) Not written when it says that already.
 */
function writeCurrent(root, c) {
  const file = path.join(root, 'current.json'), text = JSON.stringify(c);
  try { if (fs.readFileSync(file, 'utf8') === text) return; } catch (e) { /* not there, or can't be read: written */ }
  fs.mkdirSync(root, { recursive: true });
  const tmp = path.join(root, 'current.json.tmp');
  writeSyncedSync(tmp, text);
  fs.renameSync(tmp, file);
  syncDirSync(root);
}

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

/** sha256, a few MB at a time with other work let in between (all of a large bundle at once would hold Flick up) */
async function sha256Async(buf) {
  const h = crypto.createHash('sha256');
  const step = 4 * 1024 * 1024;
  for (let i = 0; i < buf.length; i += step) {
    h.update(buf.subarray(i, i + step));
    await new Promise((r) => setImmediate(r));
  }
  return h.digest('hex');
}

/** What a release signature covers: this header naming the version (like "1.0.0"), then SHA256SUMS byte for byte. */
function releaseMessage(version, sums) {
  return Buffer.concat([Buffer.from('flick-release-v1\nversion ' + version + '\n', 'utf8'), Buffer.from(sums)]);
}

/** true when sig (the SHA256SUMS.sig asset: base64 DER ECDSA/SHA-256) signs this version's SHA256SUMS with a trusted key. */
function verifyRelease(version, sums, sig, keys) {
  if (!parseVersion(version) || String(version).startsWith('v') || sums == null || typeof sig !== 'string') return false;
  const der = Buffer.from(sig.trim(), 'base64');
  const msg = releaseMessage(version, sums);
  for (const k of keys || RELEASE_KEYS) {
    try {
      const key = crypto.createPublicKey({ key: Buffer.from(k, 'base64'), format: 'der', type: 'spki' });
      if (key.asymmetricKeyType === 'ec' && crypto.verify('sha256', msg, { key, dsaEncoding: 'der' }, der)) return true;
    } catch (e) { /* not a usable key or signature: try the next key */ }
  }
  return false;
}

/** SHA256SUMS (sha256sum's format) as a Map name -> lowercase hex; null when a line doesn't parse or a name repeats. */
function parseSums(text) {
  const out = new Map();
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    const m = /^([0-9a-fA-F]{64}) [ *](\S.*?)\r?$/.exec(line);
    if (!m || out.has(m[2])) return null;
    out.set(m[2], m[1].toLowerCase());
  }
  return out;
}

/** The signed SHA256SUMS kept in dir, when it is valid for this version: { sums (Buffer), sig, list } or null. */
function readProof(dir, version, keys) {
  try {
    const sums = fs.readFileSync(path.join(dir, 'SHA256SUMS'));
    const sig = fs.readFileSync(path.join(dir, 'SHA256SUMS.sig'), 'utf8');
    const list = verifyRelease(version, sums, sig, keys) ? parseSums(sums.toString('utf8')) : null;
    return list ? { sums, sig, list } : null;
  } catch (e) { return null; }
}

function writeProof(dir, p) {
  fs.mkdirSync(dir, { recursive: true });
  writeSyncedSync(path.join(dir, 'SHA256SUMS'), p.sums);
  writeSyncedSync(path.join(dir, 'SHA256SUMS.sig'), p.sig);
  syncDirSync(dir);
}

/**
 * Any program the user runs can write in the update folder, and Flick runs what's there at its next start, with what the
 * user allowed Flick alone (its firewall rule, a Mac's camera): so a downloaded version is started only if it is still
 * what Flick's release key signed. Its signed SHA256SUMS names the bundle's sha256, the bundle kept with it has it, and
 * every file in the folder is the bundle's own, byte for byte, with nothing added (a file "x" beside "x.js" would be
 * loaded in its place). Returns null when it is, else what isn't.
 */
function checkUpdate(dir, version, keys) {
  const proof = readProof(dir, version, keys);
  if (!proof) return 'no signed SHA256SUMS';
  const zipName = bundleName(version);
  const sum = proof.list.get(zipName);
  if (!sum) return 'its bundle isn\'t in SHA256SUMS';
  let entries;
  try {
    const zip = fs.readFileSync(path.join(dir, zipName));
    if (sha256(zip) !== sum) return 'its bundle isn\'t the signed one';
    entries = new Map(zipEntries(zip).map((e) => [e.name, e]));
  } catch (e) { return 'its bundle: ' + e.message; }
  const own = new Set(['SHA256SUMS', 'SHA256SUMS.sig', zipName]);
  let found = 0;
  const walk = (d, rel) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const name = rel + ent.name;
      if (ent.isDirectory()) { const why = walk(path.join(d, ent.name), name + '/'); if (why) return why; continue; }
      if (!rel && own.has(name)) continue;
      // (what Finder or Explorer leave in a folder someone looked into: nothing ever loads them)
      if (/^(\.DS_Store|Thumbs\.db|desktop\.ini)$/i.test(ent.name) && !entries.has(name) && ent.isFile()) continue;
      const e = entries.get(name);
      if (!e || !ent.isFile()) return 'not in its bundle: ' + name;
      const data = e.method === 0 ? e.raw : zlib.inflateRawSync(e.raw, { maxOutputLength: MAX_ENTRY });
      if (!data.equals(fs.readFileSync(path.join(d, ent.name)))) return 'changed: ' + name;
      found++;
    }
    return null;
  };
  try {
    const why = walk(dir, '');
    if (why) return why;
  } catch (e) { return e.message; }
  return found === entries.size ? null : 'files missing';
}

/**
 * Every file in a zip, as [{ name, data, exec }]; refuses anything that could land outside the target folder. exec: the
 * zip was made on Unix with the file executable (a helper program on macOS needs that to run).
 */
function unzipAll(buf) {
  return zipEntries(buf).map((e) => {
    const data = e.method === 0 ? Buffer.from(e.raw) : zlib.inflateRawSync(e.raw, { maxOutputLength: MAX_ENTRY });
    return { name: e.name, data: checked(e, data), exec: e.exec };
  });
}

/** unzipAll, with the inflating done off the main thread (an update unpacks while Flick keeps working) */
async function unzipAllAsync(buf) {
  const out = [];
  for (const e of zipEntries(buf)) {
    const data = e.method === 0 ? Buffer.from(e.raw) : await new Promise((resolve, reject) => {
      zlib.inflateRaw(e.raw, { maxOutputLength: MAX_ENTRY }, (err, d) => (err ? reject(err) : resolve(d)));
    });
    out.push({ name: e.name, data: checked(e, data), exec: e.exec });
  }
  return out;
}

// an entry's unpacked data, if it's whole
function checked(e, data) {
  const crcOk = !zlib.crc32 || zlib.crc32(data) >>> 0 === e.crc >>> 0;
  if (data.length !== e.usize || !crcOk) throw new Error('damaged entry ' + e.name);
  return data;
}

// the zip's entries, checked, still packed: [{ name, method, raw, usize, crc, exec }]
function zipEntries(buf) {
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
    const exec = (buf.readUInt16LE(p + 4) >> 8) === 3 && ((buf.readUInt32LE(p + 38) >>> 16) & 0o111) !== 0;
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen).replace(/\\/g, '/');
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;                                   // folder entry
    if (flags & 1) throw new Error('encrypted entry');
    const segs = name.split('/');
    if (!name || name.startsWith('/') || /^[a-zA-Z]:/.test(name) || segs.some((s) => !s || s === '.' || s === '..')) throw new Error('bad path ' + name);
    if (usize > MAX_ENTRY) throw new Error('entry too big');
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) throw new Error('bad zip entry');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    if (method !== 0 && method !== 8) throw new Error('unsupported compression');
    out.push({ name, method, raw: buf.subarray(start, start + csize), usize, crc, exec });
  }
  return out;
}

// the bundle's package.json, if the files are a Flick app of that version
function bundleMeta(files, version) {
  const pkg = files.find((f) => f.name === 'package.json');
  const main = files.find((f) => f.name === 'main.js');
  if (!pkg || !main) throw new Error('not a Flick bundle');
  const meta = JSON.parse(pkg.data.toString('utf8'));
  if (meta.version !== version) throw new Error('bundle is ' + meta.version + ', expected ' + version);
  return meta;
}

/** installBundle from files already unpacked (unzipAllAsync), written in the background, and on disk (each file, and each
 * folder's entries) before the folder is renamed into place: see writeCurrent */
async function installFiles(root, version, files) {
  const meta = bundleMeta(files, version);
  await fs.promises.mkdir(root, { recursive: true });
  const tmp = path.join(root, '.tmp-' + version + '-' + crypto.randomBytes(4).toString('hex'));
  const dest = path.join(root, version);
  try {
    const dirs = new Set([tmp]);
    for (const f of files) {
      const full = path.join(tmp, ...f.name.split('/'));
      if (!full.startsWith(tmp + path.sep)) throw new Error('bad path');
      for (let d = path.dirname(full); d.startsWith(tmp) && !dirs.has(d); d = path.dirname(d)) dirs.add(d);
      await fs.promises.mkdir(path.dirname(full), { recursive: true });
      const fh = await fs.promises.open(full, 'w', f.exec ? 0o755 : 0o666);
      try { await fh.writeFile(f.data); await fh.sync(); } finally { await fh.close(); }
    }
    for (const d of [...dirs].sort((a, b) => b.length - a.length)) await syncDir(d);      // (deepest first)
    await fs.promises.rm(dest, { recursive: true, force: true });
    await fs.promises.rename(tmp, dest);
    await syncDir(root);
  } catch (e) {
    await fs.promises.rm(tmp, { recursive: true, force: true }).catch(() => {});
    throw e;
  }
  return { dir: version, files: files.length, meta };
}

/** Unpacks a verified app bundle into root/<version> (via a temporary folder, so a half-written copy is never used). */
function installBundle(root, version, zipBuf) {
  const files = unzipAll(zipBuf);
  const meta = bundleMeta(files, version);
  fs.mkdirSync(root, { recursive: true });
  const tmp = path.join(root, '.tmp-' + version + '-' + crypto.randomBytes(4).toString('hex'));
  const dest = path.join(root, version);
  try {
    for (const f of files) {
      const full = path.join(tmp, ...f.name.split('/'));
      if (!full.startsWith(tmp + path.sep)) throw new Error('bad path');
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, f.data, f.exec ? { mode: 0o755 } : undefined);
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

module.exports = {
  updatesRoot, bundleName, parseVersion, newer, readCurrent, writeCurrent, sha256, unzipAll, installBundle, pruneUpdates,
  RELEASE_KEYS, releaseMessage, verifyRelease, parseSums, readProof, writeProof, sha256Async, unzipAllAsync, installFiles,
  checkUpdate,
};
