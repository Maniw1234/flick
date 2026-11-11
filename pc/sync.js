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
const { fitStart } = require('./bundle');

const MAX_FILES = 20000;
const MAX_DEPTH = 32;
const MAX_REL = 1024;
// ':' covers drive letters and alternate data streams; '\' is a separator on Windows (paths come with '/')
// (and the invisible direction marks that can make "photo<RLO>gnp.exe" look like "photoexe.png")
const BAD_CHARS = /[<>:"|?*\\\u0000-\u001f\u007f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)( *\..*)?$/i;
// what a listing leaves out: hidden (dot) files, Windows' own files, and files still being written (ours and others')
const SKIP_NAME = /^(desktop\.ini|thumbs\.db|ehthumbs(_vista)?\.db|\$recycle\.bin|system volume information|~\$.*)$/i;
const SKIP_EXT = /\.(tmp|temp|flickpart|part|partial|crdownload|download)$/i;
const MAX_GONE = 500;           // stopped syncs whose folder is remembered (see pair())
const SAME_MS = 2000;           // same size and modified within 2 s: maybe the same file (its bytes are compared)
const CMP_CHUNK = 1024 * 1024;
const CMP_MAX = 16;             // same-size copies of one name a file that arrives is compared with (see _put)
// A file arriving is written as ".<name>.<8 hex>.flickpart" beside where it goes (see _put). One left by a Flick stopped
// mid-file (killed, a power cut) would stay in the user's folder: it's cleared once nothing has written it for an hour.
const PART_NAME = /^\..+\.[0-9a-f]{8}\.flickpart$/;
const STALE_PART = 60 * 60 * 1000;
const SWEEP_EVERY = 10 * 60 * 1000;   // a folder files arrive in is looked through for those at most this often
// A name's limit: 255 bytes on Linux and macOS (85 letters of Chinese), 255 UTF-16 units on Windows. The temp file's
// name keeps at most 200 bytes of the file's (as the phone's SyncEngine.partFor), whole characters, so with its dot and
// ".<8 hex>.flickpart" it always fits; a kept-both copy's name is cut to fit with its " (<phone>) (n)".
const NAME_LIMIT = 255;
const PART_STEM = 200;
const nameRoom = (s) => (process.platform === 'win32' ? s.length : Buffer.byteLength(s));
// the longest start of s (whole characters) that takes at most `room` of a name's limit here
const fitRoom = (s, room) => (process.platform === 'win32' ? fitStart(s, room, Infinity) : fitStart(s, Infinity, room));

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

/**
 * A folder or file name made safe for Windows (the rules main.js's sanitizeName uses for received files): at most 100
 * characters, and a name's limit here (100 Chinese ones are 300 bytes, over Linux's and a Mac's 255).
 */
function cleanName(n, fallback) {
  let s = String(n || '').replace(/[<>:"/\\|?*\u0000-\u001f\u007f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '_').replace(/[. ]+$/, '').trim();
  if (!s) s = fallback || 'Folder';
  s = fitRoom(fitStart(s, 100, Infinity), NAME_LIMIT).replace(/[. ]+$/, '') || fallback || 'Folder';
  return RESERVED.test(s) ? '_' + s : s;               // (after it's cut: "nul", spaces and more is "nul")
}
// The name Flick 2.1's first versions kept for a folder (cut at 100 UTF-16 units, an emoji's half and all): a pair made
// then is still the same folder when the phone asks again (else a second pair and folder would split its files)
function oldName(n, fallback) {
  let s = String(n || '').replace(/[<>:"/\\|?*\u0000-\u001f\u007f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '_').replace(/[. ]+$/, '').trim();
  if (!s) s = fallback || 'Folder';
  s = s.slice(0, 100).replace(/[. ]+$/, '') || fallback || 'Folder';
  return RESERVED.test(s) ? '_' + s : s;
}

// (a Mac's disk takes a name's two Unicode spellings as one, Windows' and a Mac's any case)
const samePath = (a, b) => path.resolve(a).normalize('NFC').toLowerCase() === path.resolve(b).normalize('NFC').toLowerCase();
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const msOf = (st) => Math.round(st.mtimeMs);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A folder with nothing in it, or none of that name: no file of anyone's would be found in it.
// A name the disk can't take isn't "someone's": said as such (cleanName and pair() keep within it).
async function emptyOrMissing(f) {
  let d;
  try { d = await fs.promises.opendir(f); } catch (e) {
    if (e.code === 'ENAMETOOLONG') throw new SyncError(500, 'folder name too long');
    return e.code === 'ENOENT';
  }
  try { return (await d.read()) === null; } catch (e) { return false; } finally { await d.close().catch(() => {}); }
}

// Whether two files of `size` bytes hold the same bytes: read 1 MB at a time from each (a big file isn't loaded, and
// other requests are answered meanwhile). Anything unreadable: not the same.
async function sameBytes(a, b, size) {
  let fa = null, fb = null;
  try {
    fa = await fs.promises.open(a, 'r');
    fb = await fs.promises.open(b, 'r');
    const len = Math.max(1, Math.min(size, CMP_CHUNK));
    const ba = Buffer.allocUnsafe(len), bb = Buffer.allocUnsafe(len);
    for (let at = 0; at < size;) {
      const want = Math.min(len, size - at);
      const [ra, rb] = await Promise.all([fa.read(ba, 0, want, at), fb.read(bb, 0, want, at)]);
      if (ra.bytesRead !== want || rb.bytesRead !== want || ba.compare(bb, 0, want, 0, want) !== 0) return false;
      at += want;
    }
    return true;
  } catch (e) { return false; } finally {
    if (fa) await fa.close().catch(() => {});
    if (fb) await fb.close().catch(() => {});
  }
}

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
    // syncs stopped since (on the phone or in the window): whose folder each was, as its files stay there
    this.gone = isObj(opts.gone) ? opts.gone : {};
    this.persist = opts.persist || (() => {});
    this.markOfWeb = opts.markOfWeb || (() => {});
    this.locks = new Map();
    this.active = 0;            // files being stored or sent right now
    this.writing = new Set();   // names of the temp files being written now (never cleared away as left over)
    this.swept = new Map();     // folder -> when it was last looked through for left-over temp files
    // (a last sync saved "in the future" before the clock went back: shown as just before this start, not as to come)
    const now = Date.now();
    for (const p of Object.values(this.pairs)) if (isObj(p) && p.last > now) p.last = now - 30000;
  }

  /**
   * A sync is going on: a file on its way, or a pair used in the last half minute (a sync goes file by file). A time
   * still to come (the clock went back since: an NTP fix, a dual-boot PC's clock off by its time zone) isn't one: it
   * would hold update restarts until the clock caught up.
   */
  busy() {
    const now = Date.now();
    return this.active > 0 || Object.values(this.pairs).some((p) => { const d = now - (p.last || 0); return d >= 0 && d < 30000; });
  }

  _pair(device, id) {
    const p = typeof id === 'string' && Object.prototype.hasOwnProperty.call(this.pairs, id) ? this.pairs[id] : null;
    if (!p || p.device !== device) throw this._stopped(device, id) ? new SyncError(410, 'stopped') : new SyncError(404, 'no pair');
    return p;
  }

  /** The folder of this phone's pair, or null when it has none of that id (put() says which). */
  folderOf(device, id) {
    const p = typeof id === 'string' && Object.prototype.hasOwnProperty.call(this.pairs, id) ? this.pairs[id] : null;
    return p && p.device === device && typeof p.folder === 'string' ? p.folder : null;
  }

  // a sync of this phone's stopped here (in the window, say): its phone hears so rather than "no pair", which it would
  // take for a reinstalled Flick and make again
  _stopped(device, id) {
    const g = typeof id === 'string' && Object.prototype.hasOwnProperty.call(this.gone, id) ? this.gone[id] : null;
    return isObj(g) && g.device === device;
  }

  // A pair's last activity (it orders the panel's list) changes with every file: it's kept in memory and saved at most
  // once a minute (and on quit, flush), rather than rewriting the settings for every file synced.
  _touch(p) {
    p.last = Date.now();
    this.emit('changed');
    if (this.touchT) return;
    this.touchT = setTimeout(() => { this.touchT = null; this.persist(); }, 60000);
    if (this.touchT.unref) this.touchT.unref();
  }

  /** Saves the activity not saved yet (Flick is quitting). */
  flush() { if (this.touchT) { clearTimeout(this.touchT); this.touchT = null; this.persist(); } }

  /**
   * Creates (or reuses) the folder for the phone's folder `name`: { id, folder }. again: the phone asks on its own (the
   * PC didn't know its pair): a sync of that folder stopped here stays stopped (410), only its user adding it resumes it.
   */
  async pair(device, phone, name, again) {
    if (typeof name !== 'string' || !name.trim() || name.length > 255) throw new SyncError(400, 'bad name');
    const base = cleanName(name, 'Phone folder');
    const was = oldName(name, 'Phone folder'), named = (n) => n === base || n === was;
    // the same phone asking for the same folder again (it was added again, or the phone lost its record): same pair
    for (const [id, p] of Object.entries(this.pairs)) {
      if (p.device === device && named(p.name)) {
        await fs.promises.mkdir(p.folder, { recursive: true });
        p.phone = phone || p.phone;
        this._touch(p);
        return { id, folder: p.folder };
      }
    }
    if (again && Object.values(this.gone).some((g) => isObj(g) && g.device === device && named(g.name))) throw new SyncError(410, 'stopped');
    const root = path.join(await this.root(), 'Flick Sync');
    // A folder another phone has, syncing or stopped (its files stay), is never this one's: two phones' cameras don't
    // mix, whatever names the phones give themselves, and no phone gets to see or change what another one synced.
    const theirs = Object.values(this.pairs).filter((p) => p.device !== device).map((p) => p.folder)
      .concat(Object.values(this.gone).filter((g) => isObj(g) && g.device !== device && typeof g.folder === 'string').map((g) => g.folder));
    const others = (f) => theirs.some((o) => samePath(o, f));
    // A folder can have more than one name: a link to it, and on Windows its short name ("SCREEN~1" is "Screenshots").
    // One that's there is compared by where it really is with where the other phones' folders really are (looked up
    // once, and only when a folder of the name asked for is there).
    let theirsReal = null;
    const othersReal = async (f) => {
      let real;
      try { real = await fs.promises.realpath(f); } catch (e) { return false; }   // (not there)
      theirsReal = theirsReal || Promise.all(theirs.map((o) => fs.promises.realpath(o).catch(() => null)));
      return (await theirsReal).some((o) => o && samePath(o, real));
    };
    let folder = null;
    // this phone's own folder of that name from a sync of it stopped earlier: it carries on there (no second copy)
    for (const [k, g] of Object.entries(this.gone)) {
      if (isObj(g) && g.device === device && named(g.name) && typeof g.folder === 'string' &&
          samePath(path.dirname(g.folder), root) && !others(g.folder) && !(await othersReal(g.folder))) { folder = g.folder; delete this.gone[k]; break; }
    }
    if (!folder) {
      // else one that's nobody's: not another phone's, and empty or new (one with files in it is the user's own, or a
      // stopped sync's from before Flick kept track of those)
      const free = async (f) => !others(f) && await emptyOrMissing(f) && !(await othersReal(f));
      folder = path.join(root, base);
      if (!(await free(folder))) {
        // "<name> (<phone>)", then "... (2)": the name is cut (whole characters) so that both fit (a long Chinese one
        // would be over 255 bytes, and no folder of it could be made)
        let mine = cleanName(base + ' (' + (phone || 'phone') + ')');
        if (nameRoom(mine) + nameRoom(' (1000)') > NAME_LIMIT) {
          const tag = fitStart(cleanName(phone || 'phone', 'phone'), 40, 80).replace(/[. ]+$/, '') || 'phone';
          const end = ' (' + tag + ')';
          mine = (fitRoom(base, NAME_LIMIT - nameRoom(end + ' (1000)')).replace(/[. ]+$/, '') || 'Phone folder') + end;
        }
        let i = 1;
        for (folder = path.join(root, mine); !(await free(folder)); folder = path.join(root, mine + ' (' + (++i) + ')')) {
          if (i >= 1000) throw new SyncError(500, 'no free folder');
        }
      }
    }
    await fs.promises.mkdir(folder, { recursive: true });
    const id = crypto.randomBytes(6).toString('hex');
    this.pairs[id] = { device, phone: phone || '', name: base, folder, created: Date.now(), last: Date.now() };
    this.persist();
    this.emit('changed');
    return { id, folder };
  }

  /** Stops syncing a pair (the files stay). The phone's own pairs only; remove() is the panel's. */
  unpair(device, id) {
    if (this._stopped(device, id)) return;                // stopped here already
    this._pair(device, id);
    this.remove(id);
  }
  remove(id) {
    if (!Object.prototype.hasOwnProperty.call(this.pairs, id)) return false;
    const p = this.pairs[id];
    delete this.pairs[id];
    // its folder (the files stay) stays that phone's: see pair()
    if (isObj(p) && typeof p.folder === 'string') {
      for (const [k, g] of Object.entries(this.gone)) if (!isObj(g) || (typeof g.folder === 'string' && samePath(g.folder, p.folder))) delete this.gone[k];
      this.gone[id] = { device: p.device, name: p.name, folder: p.folder, at: Date.now() };
      const ks = Object.keys(this.gone);
      if (ks.length > MAX_GONE) ks.sort((a, b) => (this.gone[a].at || 0) - (this.gone[b].at || 0)).slice(0, ks.length - MAX_GONE).forEach((k) => delete this.gone[k]);
    }
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
        if (PART_NAME.test(n)) await this._dropPart(path.join(dir, n));
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

  // A temp file a stopped Flick left (see PART_NAME): only a plain file (not a link, not a folder), not one being
  // written now, untouched for an hour (one "modified" later than now, the clock went back, isn't old). Never throws.
  async _dropPart(full) {
    try {
      const n = path.basename(full);
      if (!PART_NAME.test(n) || this.writing.has(n)) return;
      const st = await fs.promises.lstat(full);
      const age = Date.now() - st.mtimeMs;
      if (!st.isFile() || !(age > STALE_PART) || this.writing.has(n)) return;
      await fs.promises.unlink(full);
    } catch (e) { /* gone, busy or not ours to remove: left */ }
  }

  // the folder a file arrives in, looked through for left-over temp files (at most once in SWEEP_EVERY; never throws)
  async _sweep(dir) {
    try {
      const key = dir.toLowerCase(), now = Date.now(), last = this.swept.get(key);
      if (last !== undefined && now - last >= 0 && now - last < SWEEP_EVERY) return;
      if (this.swept.size >= 1000) this.swept.clear();
      this.swept.set(key, now);
      const d = await fs.promises.opendir(dir);
      for await (const ent of d) if (PART_NAME.test(ent.name)) await this._dropPart(path.join(dir, ent.name));
    } catch (e) { /* not there or unreadable: nothing to clear */ }
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
   * "name (<phone>).ext" (a name of that kind is never replaced). The same file again (same bytes, modified within
   * 2 s: a retry, or the copy kept earlier) isn't stored twice: { stored, same: true }.
   */
  async put(device, phone, id, rel, mtime, size, req) {
    this.active++;
    try { return await this._put(device, phone, id, rel, mtime, size, req); } finally { this.active--; }
  }

  async _put(device, phone, id, rel, mtime, size, req) {
    const p = this._pair(device, id);
    const abs = await this._resolve(p, rel);
    const dir = path.dirname(abs);
    try { await fs.promises.mkdir(dir, { recursive: true }); } catch (e) { throw new SyncError(409, 'conflict'); }
    await this._resolve(p, rel);                         // the folders just made are real folders
    const tmp = path.join(dir, '.' + fitStart(path.basename(abs), PART_STEM, PART_STEM) + '.' + crypto.randomBytes(4).toString('hex') + '.flickpart');
    const tmpName = path.basename(tmp);
    this.writing.add(tmpName);
    this._sweep(dir);
    try {
      await receive(req, tmp, size);
    } catch (e) { this.writing.delete(tmpName); throw e; }
    try {
      return await this._lock(abs, async () => {
        const base = path.basename(abs);
        let ext = path.extname(base);
        if (nameRoom(ext) > 40) ext = '';                                     // not an extension worth keeping whole
        const stem = base.slice(0, base.length - ext.length);
        let tag = cleanName(phone || 'phone', 'phone');                       // (at most 100 characters)
        if (nameRoom(tag) > 100) tag = fitStart(tag, 100, 100).replace(/[. ]+$/, '') || 'phone';
        let target = abs, cmp = 0;
        for (let n = 1; ; n++) {
          if (n > 1) {
            // "<name> (<phone>)<ext>", "<name> (<phone>) (2)<ext>"...: the name is cut (whole characters) to fit
            const end = (n === 2 ? ` (${tag})` : ` (${tag}) (${n - 1})`) + ext;
            const room = NAME_LIMIT - nameRoom(end);
            const cut = process.platform === 'win32' ? fitStart(stem, room, Infinity) : fitStart(stem, Infinity, room);
            target = path.join(dir, cut + end);
          }
          if (n > 1000) throw new SyncError(409, 'conflict');
          let st = null;
          try { st = await fs.promises.lstat(target); } catch (e) {
            if (e.code === 'ENAMETOOLONG') continue;                          // can't be there, nor stored there
          }
          if (!st) break;                                                      // free: store it here
          if (st.isFile()) {
            const have = msOf(st);
            // the PC's copy is older: replace it. Only at the file's own name: a kept-both name holds another file (an
            // earlier conflict's copy, or the user's own of that name), never replaced.
            if (n === 1 && have < mtime) break;
            // already here (the phone retrying, or a copy kept both earlier): the same only if the bytes are (a same-size
            // edit on a phone whose clock is a second behind would otherwise be taken for the PC's file and lost)
            // (the first CMP_MAX same-size copies are read: past that it's kept as one more copy, not read against
            // hundreds of them for every file that comes)
            if (st.size === size && (n > 1 || have - mtime <= SAME_MS) && cmp++ < CMP_MAX && await sameBytes(tmp, target, size)) {
              await fs.promises.rm(tmp, { force: true });
              return { stored: this._rel(p, target), same: true };
            }
          }
          // newer here, other content (or a folder of that name): keep both
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
    } finally { this.writing.delete(tmpName); }
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
