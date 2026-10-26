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
    this.list = [];             // [{ p, s }] oldest first
    this.fps = new Map();       // "path|size|mtime" -> fingerprint
    this.saveT = null;
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(j.files)) this.list = j.files.filter((x) => x && typeof x.p === 'string' && x.s > 0).slice(-MAX_INDEX);
    } catch (e) { /* none yet */ }
  }

  _save() {
    if (this.saveT) return;
    this.saveT = setTimeout(() => {
      this.saveT = null;
      const tmp = this.file + '.tmp';
      fs.writeFile(tmp, JSON.stringify({ v: 1, files: this.list }), (e) => { if (!e) fs.rename(tmp, this.file, () => {}); });
    }, 1500);
    if (this.saveT.unref) this.saveT.unref();
  }

  _push(p, s) {
    if (!(s > 0)) return;
    const k = p.toLowerCase();
    const i = this.list.findIndex((x) => x.p.toLowerCase() === k);
    if (i >= 0) this.list.splice(i, 1);
    this.list.push({ p, s });
    if (this.list.length > MAX_INDEX) this.list.splice(0, this.list.length - MAX_INDEX);
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

  /**
   * items: [{ k, name, size }] → { k: [fingerprint, ...] } for the items with a likely copy here.
   */
  async lookup(items) {
    const bySize = new Map();
    for (const x of this.list) { const a = bySize.get(x.s); if (a) a.push(x.p); else bySize.set(x.s, [x.p]); }
    const dir = this.saveDir();
    const out = {};
    let gone = false;
    for (const it of items) {
      const cands = new Set(bySize.get(it.size) || []);
      const name = path.basename(String(it.name || ''));
      if (dir && name && name !== '.' && name !== '..') {
        const ext = path.extname(name), base = name.slice(0, name.length - ext.length);
        cands.add(path.join(dir, name));
        for (let i = 2; i <= 9; i++) cands.add(path.join(dir, base + ' (' + i + ')' + ext));
      }
      const fps = new Set();
      let n = 0;
      for (const p of cands) {
        if (n >= MAX_CANDIDATES) break;
        const fp = await this._fp(p, it.size);
        if (fp) { fps.add(fp); n++; }
        else if (bySize.has(it.size) && bySize.get(it.size).includes(p)) {
          // a saved file that's gone or changed: forget it
          const i = this.list.findIndex((x) => x.p === p);
          if (i >= 0) { this.list.splice(i, 1); gone = true; }
        }
      }
      if (fps.size) out[it.k] = [...fps];
    }
    if (gone) this._save();
    return out;
  }
}

module.exports = { fingerprint, ReceivedIndex, EDGE };
