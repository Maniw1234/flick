'use strict';
// Which of a phone's files are on this PC already, so they aren't sent twice ("Skip files already on the PC").
//
// A file's fingerprint is the SHA-256 of "flick-fp1|<size>|" followed by its first and last 256 KB (the whole file when
// it's 512 KB or smaller), as hex, cut to 32 characters. It is cheap to take on both sides, and two different photos
// or videos of the same size practically never share one. The phone (Have.java) computes it the same way.
//
// The phone asks with names and sizes only. For each file this PC answers with the fingerprints of its likely copies:
// files Flick saved before with that exact size (an index kept in received.json, so renamed ones count too) and files of
// that name (or "name (2)" ...) with that size in the folder files are saved to. The phone then fingerprints only those
// of its files that have a candidate, and skips the ones that match.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const EDGE = 256 * 1024;
const MAX_INDEX = 50000;       // saved files remembered (newest kept)
const MAX_TREE = 20000;        // files of one received folder added
const MAX_CANDIDATES = 8;      // copies fingerprinted per file asked about

async function readFully(fd, buf, len, pos) {
  let off = 0;
  while (off < len) {
    const { bytesRead } = await fd.read(buf, off, len - off, pos + off);
    if (!bytesRead) break;
    off += bytesRead;
  }
  return off;
}

/** The fingerprint of a file, or null when it can't be read (or isn't `size` bytes long, when given). */
async function fingerprint(file, size) {
  let fd;
  try { fd = await fs.promises.open(file, 'r'); } catch (e) { return null; }
  try {
    const st = await fd.stat();
    if (!st.isFile() || (size != null && st.size !== size)) return null;
    const h = crypto.createHash('sha256');
    h.update('flick-fp1|' + st.size + '|');
    if (st.size <= 2 * EDGE) {
      const b = Buffer.allocUnsafe(st.size);
      const n = await readFully(fd, b, st.size, 0);
      if (n !== st.size) return null;
      h.update(b);
    } else {
      const b = Buffer.allocUnsafe(EDGE);
      if (await readFully(fd, b, EDGE, 0) !== EDGE) return null;
      h.update(b);
      if (await readFully(fd, b, EDGE, st.size - EDGE) !== EDGE) return null;
      h.update(b);
    }
    return h.digest('hex').slice(0, 32);
  } catch (e) { return null; }
  finally { await fd.close().catch(() => {}); }
}

class ReceivedIndex {
  constructor(file, opts) {
    this.file = file;
    this.saveDir = (opts && opts.saveDir) || (() => null);
    this.map = new Map();       // lower-cased path -> { p, s }, oldest first (a file saved again moves to the end)
    this.fps = new Map();       // "path|size|mtime" -> fingerprint
    this.saveT = null;
    this.dirList = null;        // { dir, at, names: Set of lower-cased names }: the save folder, read once for a while
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(j.files)) for (const x of j.files.slice(-MAX_INDEX)) if (x && typeof x.p === 'string' && x.s > 0) this.map.set(x.p.toLowerCase(), { p: x.p, s: x.s });
    } catch (e) { /* none yet */ }
  }

  get list() { return [...this.map.values()]; }

  _save() {
    if (this.saveT) return;
    this.saveT = setTimeout(() => {
      this.saveT = null;
      const tmp = this.file + '.tmp';
      fs.writeFile(tmp, JSON.stringify({ v: 1, files: this.list }), (e) => { if (!e) fs.rename(tmp, this.file, () => {}); });
    }, 1500);
    if (this.saveT.unref) this.saveT.unref();
  }

  // (a map lookup, not a scan of the whole list: receiving a folder of thousands of files adds thousands)
  _push(p, s) {
    if (!(s > 0)) return;
    const k = p.toLowerCase();
    this.map.delete(k);
    this.map.set(k, { p, s });
    this.dirList = null;
    if (this.map.size > MAX_INDEX) {
      let drop = this.map.size - MAX_INDEX;
      for (const key of this.map.keys()) { if (drop-- <= 0) break; this.map.delete(key); }
    }
  }

  /** A file Flick just saved. */
  add(file) {
    fs.stat(file, (e, st) => { if (!e && st.isFile()) { this._push(file, st.size); this._save(); } });
  }

  /** A file or folder Flick just saved: its files (bounded). */
  addTree(dest) {
    let budget = MAX_TREE;
    const walk = async (p) => {
      let st;
      try { st = await fs.promises.stat(p); } catch (e) { return; }
      if (st.isFile()) { if (budget-- > 0) this._push(p, st.size); return; }
      if (!st.isDirectory()) return;
      let names;
      try { names = await fs.promises.readdir(p); } catch (e) { return; }
      for (const n of names) { if (budget <= 0) return; await walk(path.join(p, n)); }
    };
    walk(dest).then(() => this._save(), () => {});
  }

  async _fp(p, size) {
    let st;
    try { st = await fs.promises.stat(p); } catch (e) { return null; }
    if (!st.isFile() || st.size !== size) return null;
    const key = p + '|' + size + '|' + st.mtimeMs;
    if (this.fps.has(key)) return this.fps.get(key);
    const fp = await fingerprint(p, size);
    if (fp) {
      if (this.fps.size > 20000) this.fps.clear();
      this.fps.set(key, fp);
    }
    return fp;
  }

  // the names in the save folder (lower-cased), read once and kept a few seconds: one listing instead of a look for
  // each possible name of each file asked about
  async _names(dir) {
    const now = Date.now();
    if (this.dirList && this.dirList.dir === dir && now - this.dirList.at < 5000) return this.dirList.names;
    let names = null;
    try { names = new Set((await fs.promises.readdir(dir)).map((n) => n.toLowerCase())); } catch (e) { names = null; }
    this.dirList = { dir, at: now, names };
    return names;
  }

  /**
   * items: [{ k, name, size }] → { k: [fingerprint, ...] } for the items with a likely copy here.
   */
  async lookup(items) {
    const bySize = new Map();
    for (const x of this.map.values()) { const a = bySize.get(x.s); if (a) a.push(x.p); else bySize.set(x.s, [x.p]); }
    const dir = this.saveDir();
    const names = dir ? await this._names(dir) : null;
    const out = {};
    const gone = [];
    // the likely copies of each file: saved before with its size, or in the save folder under its name (or "name (2)"...);
    // only those that exist are looked at, several files at a time
    const one = async (it) => {
      const cands = new Set(bySize.get(it.size) || []);
      const name = path.basename(String(it.name || ''));
      if (dir && name && name !== '.' && name !== '..') {
        const ext = path.extname(name), base = name.slice(0, name.length - ext.length);
        for (let i = 1; i <= 9; i++) {
          const n = i === 1 ? name : base + ' (' + i + ')' + ext;
          if (!names || names.has(n.toLowerCase())) cands.add(path.join(dir, n));
        }
      }
      const fps = new Set();
      let n = 0;
      for (const p of cands) {
        if (n >= MAX_CANDIDATES) break;
        const fp = await this._fp(p, it.size);
        if (fp) { fps.add(fp); n++; }
        else if (bySize.has(it.size) && bySize.get(it.size).includes(p)) gone.push(p);   // a saved file that's gone or changed
      }
      if (fps.size) out[it.k] = [...fps];
    };
    let next = 0;
    const worker = async () => { while (next < items.length) await one(items[next++]); };
    await Promise.all(Array.from({ length: Math.min(16, items.length) }, worker));
    if (gone.length) {
      for (const p of gone) this.map.delete(p.toLowerCase());
      this._save();
    }
    return out;
  }
}

module.exports = { fingerprint, ReceivedIndex, EDGE };
