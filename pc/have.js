'use strict';
// Which of a phone's files are on this PC already, so they aren't sent twice ("Skip files already on the PC").
//
// A file's fingerprint is the SHA-256 of "flick-fp1|<size>|" followed by its first and last 256 KB (the whole file when
// it's 512 KB or smaller), as hex, cut to 32 characters. It is cheap to take on both sides, and two different photos
// or videos of the same size practically never share one. The phone (Have.java) computes it the same way.
//
// The phone asks with names and sizes only. For each file this PC answers with the fingerprints of its likely copies:
// the files Flick saved from that phone before with that exact size (an index kept in received.json, so renamed ones
// count too). The phone then fingerprints only those of its files that have a candidate, and skips the ones that match.
// A device hears only about what it sent itself, never about any other file here: a fingerprint of a small file is a
// hash of all of it, so another phone could otherwise learn what files others sent are here, confirm a guess of their
// content, or whether "passwords.txt" is on the Desktop. Nor is the save folder looked through by name: a name the
// phone sent once (saved as "secret (2).txt") would open the user's own "secret.txt" to it, and a file the phone sent
// and the user then changed would tell it what the file says now at any size it asks. (A file another device sent, one
// saved before Flick kept who sent it, or one the user put there is sent again: a second copy, not a leak.)
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
  constructor(file) {
    this.file = file;
    this.map = new Map();       // lower-cased path -> { p, s, d (who sent it) }, oldest first (a file saved again moves to the end)
    this.fps = new Map();       // "path|size|mtime" -> fingerprint
    this.saveT = null;
    // a file that couldn't be read (Windows: an antivirus holding it; a disk hiccup) is read again before anything is
    // written over it, so what it remembers isn't lost (missing or damaged: started afresh)
    this.unread = !this._read();
  }

  // the saved index, older than what's in memory; false when it's there but couldn't be read now
  _read() {
    let j;
    try { j = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch (e) { return !e.code || e.code === 'ENOENT' || e.code === 'ENOTDIR'; }
    const now = this.map;
    this.map = new Map();
    if (j && Array.isArray(j.files)) {
      for (const x of j.files.slice(-MAX_INDEX)) {
        if (!x || typeof x.p !== 'string' || !(x.s > 0)) continue;
        const e = { p: x.p, s: x.s };
        if (typeof x.d === 'string' && x.d) e.d = x.d;
        this.map.set(x.p.toLowerCase(), e);
      }
    }
    for (const [k, e] of now) { this.map.delete(k); this.map.set(k, e); }
    if (this.map.size > MAX_INDEX) {
      let drop = this.map.size - MAX_INDEX;
      for (const key of this.map.keys()) { if (drop-- <= 0) break; this.map.delete(key); }
    }
    return true;
  }

  get list() { return [...this.map.values()]; }

  _save(ms = 1500) {
    if (this.saveT) return;
    this.saveT = setTimeout(() => {
      this.saveT = null;
      if (this.unread) {
        this.unread = !this._read();
        // still not readable: tried again later (less and less often), never written over
        if (this.unread) { this.unreadTries = (this.unreadTries || 0) + 1; this._save(Math.min(60000, 1500 * 2 ** this.unreadTries)); return; }
      }
      this._write();
    }, ms);
    if (this.saveT.unref) this.saveT.unref();
  }

  // One write at a time (a big index on a slow disk takes a while: two writers in one temp file would leave a mix of
  // both, unreadable), whole and on disk before it's renamed into place; a change meanwhile is written right after.
  _write() {
    if (this.writing) { this.again = true; return this.writing; }
    this.writing = (async () => {
      do {
        this.again = false;
        const tmp = this.file + '.tmp', n = this.flushes || 0;
        try {
          const fh = await fs.promises.open(tmp, 'w');
          try { await fh.writeFile(JSON.stringify({ v: 1, files: this.list })); await fh.sync(); } finally { await fh.close(); }
          if ((this.flushes || 0) !== n) { await fs.promises.unlink(tmp).catch(() => {}); return; }   // flush() wrote a newer one
          await fs.promises.rename(tmp, this.file);
          if ((this.flushes || 0) !== n) this._writeNow();      // (flush() ran while this went in place: its newer one again)
        } catch (e) { await fs.promises.unlink(tmp).catch(() => {}); }
      } while (this.again);
    })().finally(() => { this.writing = null; });
    return this.writing;
  }

  /** Written now if a change is waiting (on quit: the files saved in the last moments before are remembered too). */
  flush() {
    if (!this.saveT && !this.writing) return;
    clearTimeout(this.saveT); this.saveT = null;
    if (this.unread) { this.unread = !this._read(); if (this.unread) return; }     // (still can't be read: never written over)
    this.flushes = (this.flushes || 0) + 1;
    this._writeNow();
  }

  _writeNow() {
    const tmp = this.file + '.tmpq';
    try {
      const fd = fs.openSync(tmp, 'w');
      try { fs.writeSync(fd, JSON.stringify({ v: 1, files: this.list })); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(tmp, this.file);
    } catch (e) { try { fs.unlinkSync(tmp); } catch (x) { /* ignore */ } }
  }

  // (a map lookup, not a scan of the whole list: receiving a folder of thousands of files adds thousands)
  _push(p, s, d) {
    if (!(s > 0)) return;
    const k = p.toLowerCase();
    this.map.delete(k);
    this.map.set(k, typeof d === 'string' && d ? { p, s, d } : { p, s });
    if (this.map.size > MAX_INDEX) {
      let drop = this.map.size - MAX_INDEX;
      for (const key of this.map.keys()) { if (drop-- <= 0) break; this.map.delete(key); }
    }
  }

  /** A file Flick just saved; device: who sent it (the only one told it's here: see lookup). */
  add(file, device) {
    fs.stat(file, (e, st) => { if (!e && st.isFile()) { this._push(file, st.size, device); this._save(); } });
  }

  /**
   * A file or folder Flick just saved: its files (bounded); device: who sent it. files: what they are ({ rel, size },
   * as listed while it was still staged): nothing is looked up in the save folder, where anyone who can write there
   * could have put something else in its place by now.
   */
  addTree(dest, device, files) {
    if (files) {
      for (const f of files.slice(0, MAX_TREE)) this._push(f.rel ? path.join(dest, f.rel) : dest, f.size, device);
      if (files.length) this._save();
      return;
    }
    let budget = MAX_TREE;
    const walk = async (p) => {
      let st;
      try { st = await fs.promises.stat(p); } catch (e) { return; }
      if (st.isFile()) { if (budget-- > 0) this._push(p, st.size, device); return; }
      if (!st.isDirectory()) return;
      let names;
      try { names = await fs.promises.readdir(p); } catch (e) { return; }
      for (const n of names) { if (budget <= 0) return; await walk(path.join(p, n)); }
    };
    walk(dest).then(() => this._save(), () => {});
  }

  // the fingerprint of a saved copy; false when it's gone or changed (forgotten), null when it can't be read now (held
  // by another program, a disk error: kept for next time)
  async _fp(p, size) {
    let st;
    try { st = await fs.promises.stat(p); } catch (e) { return e.code === 'ENOENT' || e.code === 'ENOTDIR' ? false : null; }
    if (!st.isFile() || st.size !== size) return false;
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
   * items: [{ k, name, size }] asked about by device → { k: [fingerprint, ...] } for the items with a likely copy here
   * that device sent: a file Flick saved from it with that size, still that size. (No device: nothing.)
   */
  async lookup(items, device) {
    const mine = typeof device === 'string' && device ? device : null;
    if (this.unread) this.unread = !this._read();         // (couldn't be read at the start: see the constructor)
    const bySize = new Map();
    for (const x of this.map.values()) {
      if (!mine || x.d !== mine) continue;
      const a = bySize.get(x.s); if (a) a.push(x.p); else bySize.set(x.s, [x.p]);
    }
    const out = {};
    const gone = [];
    // the likely copies of each file (saved before with its size): only those that exist are looked at, several files
    // at a time
    const one = async (it) => {
      const fps = new Set();
      let n = 0;
      for (const p of bySize.get(it.size) || []) {
        if (n >= MAX_CANDIDATES) break;
        const fp = await this._fp(p, it.size);
        if (fp) { fps.add(fp); n++; } else if (fp === false) gone.push(p);   // a saved file that's gone or changed
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
