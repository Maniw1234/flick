'use strict';
// Two-way folder sync, the PC side (/api/sync/*). Each pair joins a folder on a phone to one on this PC,
// "<save folder>/Flick Sync/<name>". The phone runs the sync (its SyncEngine); this PC lists, serves and stores files:
// strict path checks (no "..", nothing absolute, no Windows device names or ':' streams, no links on the way), every
// write through a temp file renamed into place, marked as downloaded, with the phone's modification time. A file is
// only ever replaced by a newer one; otherwise both are kept ("name (<phone>).ext"). Nothing is ever deleted.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const MAX_FILES = 20000;
const MAX_DEPTH = 32;
const MAX_REL = 1024;
// ':' covers drive letters and alternate data streams; '\' is a separator on Windows (paths come with '/')
// (and the invisible direction marks that can make "photo<RLO>gnp.exe" look like "photoexe.png")
const BAD_CHARS = /[<>:"|?*\\\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)( *\..*)?$/i;
// what a listing leaves out: hidden (dot) files, Windows' own files, and files still being written (ours and others')
const SKIP_NAME = /^(desktop\.ini|thumbs\.db|ehthumbs(_vista)?\.db|\$recycle\.bin|system volume information|~\$.*)$/i;
const SKIP_EXT = /\.(tmp|temp|flickpart|part|partial|crdownload|download)$/i;
const SAME_MS = 2000;           // same size and modified within 2 s: the same file (the phone's rule too)

class SyncError extends Error {
  constructor(status, why) { super(why); this.status = status; this.why = why; }
}

/** A path from a phone ("DCIM/a.jpg", '/'-separated, relative) as its parts, or null if it isn't safe here. */
function relParts(p) {
  if (typeof p !== 'string' || !p || p.length > MAX_REL || p[0] === '/') return null;
  const parts = p.split('/');
  for (const s of parts) {
    if (!s || s === '.' || s === '..' || s.length > 255) return null;
    // Windows drops trailing dots and spaces: "a." would be a second name for "a"
    if (BAD_CHARS.test(s) || /[. ]$/.test(s) || RESERVED.test(s)) return null;
  }
  return parts;
}

/** A folder or file name made safe for Windows (the rules main.js's sanitizeName uses for received files). */
function cleanName(n, fallback) {
  let s = String(n || '').replace(/[<>:"/\\|?*\u0000-\u001f\u007f‎‏‪-‮⁦-⁩]/g, '_').replace(/[. ]+$/, '').trim();
  if (!s) s = fallback || 'Folder';
  if (RESERVED.test(s)) s = '_' + s;
  return s.slice(0, 100).replace(/[. ]+$/, '') || fallback || 'Folder';
}

const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const msOf = (st) => Math.round(st.mtimeMs);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// rename, retried briefly: Windows (an antivirus, the photo viewer) can hold a file for a moment
async function renameRetry(from, to) {
  for (let i = 0; ; i++) {
    try { await fs.promises.rename(from, to); return; } catch (e) {
      if (i >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
      await sleep(100 * (i + 1));
    }
  }
}

// the request body into `file`, exactly `size` bytes
function receive(req, file, size) {
  return new Promise((resolve, reject) => {
    let out;
    try { out = fs.createWriteStream(file, { flags: 'wx', highWaterMark: 1024 * 1024 }); } catch (e) { reject(new SyncError(500, 'disk')); return; }
    let got = 0, done = false;
    const fail = (status, why) => {
      if (done) return;
      done = true;
      out.destroy();
      out.once('close', () => fs.rm(file, { force: true }, () => {}));
      try { req.destroy(); } catch (e) { /* ignore */ }
      reject(new SyncError(status, why));
    };
    out.on('error', (e) => fail(e.code === 'ENOSPC' ? 507 : 500, e.code === 'ENOSPC' ? 'no space' : 'disk'));
    req.on('data', (c) => {
      if (done) return;
      got += c.length;
      if (got > size) return fail(400, 'too long');
      if (!out.write(c)) { req.pause(); out.once('drain', () => { if (!done) req.resume(); }); }
    });
    req.on('error', () => fail(400, 'aborted'));
    req.on('close', () => { if (!req.complete) fail(400, 'aborted'); });
    req.on('end', () => {
      if (done) return;
      if (got !== size) return fail(400, 'short');
      out.end();
      out.once('close', () => { if (!done) { done = true; resolve(); } });   // closed: Windows can rename it now
    });
  });
}

class SyncStore extends EventEmitter {
  /**
   * opts.root(): the save folder (or a promise of it); pairs live in "<root>/Flick Sync"
   * opts.pairs: the stored pairs { id: { device, phone, name, folder, created, last } }, changed in place
   * opts.persist(): save them; opts.markOfWeb(file): mark a stored file as downloaded (Windows)
   * events: 'changed' (pairs or their activity), 'stored' / 'sent' { device, phone, pair, rel, path, size }
   */
  constructor(opts) {
    super();
    this.root = opts.root;
    this.pairs = opts.pairs || {};
    this.persist = opts.persist || (() => {});
    this.markOfWeb = opts.markOfWeb || (() => {});
    this.locks = new Map();
  }

  _pair(device, id) {
    const p = typeof id === 'string' && Object.prototype.hasOwnProperty.call(this.pairs, id) ? this.pairs[id] : null;
    if (!p || p.device !== device) throw new SyncError(404, 'no pair');
    return p;
  }

  _touch(p) { p.last = Date.now(); this.persist(); this.emit('changed'); }

  /** Creates (or reuses) the folder for the phone's folder `name`: { id, folder }. */
  async pair(device, phone, name) {
    if (typeof name !== 'string' || !name.trim() || name.length > 255) throw new SyncError(400, 'bad name');
    const base = cleanName(name, 'Phone folder');
    // the same phone asking for the same folder again (it was added again, or the phone lost its record): same pair
    for (const [id, p] of Object.entries(this.pairs)) {
      if (p.device === device && p.name === base) {
        await fs.promises.mkdir(p.folder, { recursive: true });
        p.phone = phone || p.phone;
        this._touch(p);
        return { id, folder: p.folder };
      }
    }
    const root = path.join(await this.root(), 'Flick Sync');
    let folder = path.join(root, base);
    // another phone's folder of that name: this phone gets one of its own (two phones' cameras don't mix), and never
    // one another phone already has, whatever names the phones give themselves
    const others = (f) => Object.values(this.pairs).some((p) => p.device !== device && samePath(p.folder, f));
    if (others(folder)) {
      const mine = cleanName(base + ' (' + (phone || 'phone') + ')');
      folder = path.join(root, mine);
      for (let i = 2; others(folder); i++) folder = path.join(root, mine + ' (' + i + ')');
    }
    await fs.promises.mkdir(folder, { recursive: true });
    const id = crypto.randomBytes(6).toString('hex');
    this.pairs[id] = { device, phone: phone || '', name: base, folder, created: Date.now(), last: Date.now() };
    this.persist();
    this.emit('changed');
    return { id, folder };
  }

  /** Stops syncing a pair (the files stay). The phone's own pairs only; remove() is the panel's. */
  unpair(device, id) { this._pair(device, id); this.remove(id); }
  remove(id) {
    if (!Object.prototype.hasOwnProperty.call(this.pairs, id)) return false;
    delete this.pairs[id];
    this.persist();
    this.emit('changed');
    return true;
  }

  /** Every file in the pair's folder: { files: [{ p, size, mtime }], more } (more: stopped at MAX_FILES). */
  async list(device, id) {
    const p = this._pair(device, id);
    const files = [];
    let more = false;
    const walk = async (dir, rel, depth) => {
      let ents;
      try { ents = await fs.promises.readdir(dir, { withFileTypes: true }); } catch (e) { return; }
      ents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const ent of ents) {
        if (more) return;
        const n = ent.name;
        if (n.startsWith('.') || SKIP_NAME.test(n) || SKIP_EXT.test(n) || ent.isSymbolicLink()) continue;
        const r = rel ? rel + '/' + n : n;
        if (!relParts(r)) continue;
        const full = path.join(dir, n);
        if (ent.isDirectory()) { if (depth < MAX_DEPTH) await walk(full, r, depth + 1); continue; }
        if (!ent.isFile()) continue;
        let st;
        try { st = await fs.promises.stat(full); } catch (e) { continue; }
        if (files.length >= MAX_FILES) { more = true; return; }
        files.push({ p: r, size: st.size, mtime: msOf(st) });
      }
    };
    await walk(p.folder, '', 0);
    this._touch(p);
    return { files, more };
  }

  // where `rel` is in the pair's folder; nothing on the way may be a link (a junction could lead outside the folder)
  async _resolve(p, rel) {
    const parts = relParts(rel);
    if (!parts) throw new SyncError(400, 'bad path');
    const abs = path.join(p.folder, ...parts);
    const back = path.relative(p.folder, abs);
    if (!back || back.startsWith('..') || path.isAbsolute(back)) throw new SyncError(400, 'bad path');
    let cur = p.folder;
    for (const part of parts) {
      cur = path.join(cur, part);
      let st;
      try { st = await fs.promises.lstat(cur); } catch (e) { break; }        // the rest isn't there yet
      if (st.isSymbolicLink()) throw new SyncError(400, 'bad path');
    }
    return abs;
  }

  /** A file to send to the phone: { fh, size, mtime, path, rel, pair } (the caller streams and closes fh). */
  async open(device, id, rel) {
    const p = this._pair(device, id);
    const abs = await this._resolve(p, rel);
    let fh;
    try { fh = await fs.promises.open(abs, 'r'); } catch (e) { throw new SyncError(404, 'missing'); }
    const st = await fh.stat().catch(() => null);
    if (!st || !st.isFile()) { await fh.close().catch(() => {}); throw new SyncError(404, 'missing'); }
    this._touch(p);
    return { fh, size: st.size, mtime: msOf(st), path: abs, rel, pair: id };
  }

  /** The phone fetched all of a file (for the history). */
  sent(device, phone, f) { this.emit('sent', { device, phone, pair: f.pair, rel: f.rel, path: f.path, size: f.size }); }

  /**
   * Stores a file from the phone (the request body, `size` bytes, modified at `mtime` ms): { stored: '<rel>' }.
   * An existing file is replaced only when it's older than `mtime`; otherwise both are kept and the new one is
   * "name (<phone>).ext". The same file again (same size, modified within 2 s: a retry) isn't stored twice.
   */
  async put(device, phone, id, rel, mtime, size, req) {
    const p = this._pair(device, id);
    const abs = await this._resolve(p, rel);
    const dir = path.dirname(abs);
    try { await fs.promises.mkdir(dir, { recursive: true }); } catch (e) { throw new SyncError(409, 'conflict'); }
    await this._resolve(p, rel);                         // the folders just made are real folders
    const tmp = path.join(dir, '.' + path.basename(abs).slice(0, 80) + '.' + crypto.randomBytes(4).toString('hex') + '.flickpart');
    await receive(req, tmp, size);
    try {
      return await this._lock(abs, async () => {
        const ext = path.extname(abs), stem = abs.slice(0, abs.length - ext.length);
        const tag = cleanName(phone || 'phone', 'phone');
        let target = abs;
        for (let n = 1; ; n++) {
          if (n > 1) target = n === 2 ? `${stem} (${tag})${ext}` : `${stem} (${tag}) (${n - 1})${ext}`;
          if (n > 1000) throw new SyncError(409, 'conflict');
          let st = null;
          try { st = await fs.promises.lstat(target); } catch (e) { /* nothing there */ }
          if (!st) break;                                                      // free: store it here
          if (st.isFile()) {
            const have = msOf(st);
            if (have < mtime) break;                                           // the PC's copy is older: replace it
            if (st.size === size && have - mtime <= SAME_MS) {                // already here (the phone retrying)
              await fs.promises.rm(tmp, { force: true });
              return { stored: this._rel(p, target), same: true };
            }
          }
          // newer here (or a folder of that name): keep both
        }
        await renameRetry(tmp, target);
        await fs.promises.utimes(target, new Date(), new Date(mtime));
        this.markOfWeb(target);
        const stored = this._rel(p, target);
        this._touch(p);
        this.emit('stored', { device, phone, pair: id, rel: stored, path: target, size });
        return { stored };
      });
    } catch (e) {
      fs.rm(tmp, { force: true }, () => {});
      if (e instanceof SyncError) throw e;
      throw new SyncError(['EPERM', 'EBUSY', 'EACCES'].includes(e.code) ? 409 : 500, ['EPERM', 'EBUSY', 'EACCES'].includes(e.code) ? 'busy' : 'disk');
    }
  }

  _rel(p, abs) { return path.relative(p.folder, abs).split(path.sep).join('/'); }

  // one write at a time per file
  _lock(key, fn) {
    key = key.toLowerCase();
    const prev = this.locks.get(key) || Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => {});
    this.locks.set(key, tail);
    tail.then(() => { if (this.locks.get(key) === tail) this.locks.delete(key); });
    return run;
  }
}

module.exports = { SyncStore, SyncError, relParts, cleanName };
