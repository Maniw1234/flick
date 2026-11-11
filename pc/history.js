'use strict';
// The transfer history (userData/history.json): every file received from a phone (a fling, sent quietly, Quick Share,
// a browser, folder sync) and every file sent to one, newest first, at most 500. Written a moment after a change (one
// write for a burst of them, as in a folder sync), in the background and so that a crash or a power cut mid-write never
// costs it: a temp file, flushed to disk, renamed over the old one, and the rename itself flushed to disk (the folder).
// Where the rename can't be done (Windows: an antivirus holding the file a moment longer than the retries), the temp file
// is copied over it and only then removed: a crash during that copy leaves the temp file whole, and it's read instead.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX = 500;
const IS_WIN = process.platform === 'win32';
const LOCKED = ['EBUSY', 'EACCES', 'EPERM'];

const valid = (e) => !!e && typeof e === 'object' && typeof e.id === 'string' && (e.dir === 'in' || e.dir === 'out') && typeof e.name === 'string';
// an entry's time that isn't one (history.json from another program, or edited by hand) is read as one if it can be
// (a number or a date in words), else it's left out, and the window shows the entry without a time
const timed = (e) => {
  if (typeof e.time === 'number' && Number.isFinite(e.time)) return e;
  const n = typeof e.time === 'string' ? (Number.isFinite(+e.time) && e.time.trim() ? +e.time : Date.parse(e.time)) : NaN;
  if (Number.isFinite(n)) e.time = n; else delete e.time;
  return e;
};
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const sleepSync = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (e) { /* ignore */ } };
const HELD = 'held';                            // a file that's there but can't be read now (see _load)
const HELD_WAITS = [50, 100, 200, 300, 350];    // (about a second)

// The folder's own entry for the file, on disk (POSIX: until then a power cut can undo a rename). Windows can't open a
// folder to do it (and its rename is on disk once it returns).
async function syncDir(dir) {
  if (IS_WIN) return;
  let fh = null;
  try { fh = await fs.promises.open(dir, 'r'); await fh.sync(); } catch (e) { /* a file system that can't: as it is */ } finally { if (fh) await fh.close().catch(() => {}); }
}
function syncDirNow(dir) {
  if (IS_WIN) return;
  let fd = null;
  try { fd = fs.openSync(dir, 'r'); fs.fsyncSync(fd); } catch (e) { /* as above */ } finally { if (fd !== null) try { fs.closeSync(fd); } catch (e) { /* ignore */ } }
}

class History {
  /** opts: { max, delay (ms before a change is written), log(msg), onChange(), rereadMs (a file held at the start: read again after) } */
  constructor(file, opts = {}) {
    this.file = file;
    this.max = opts.max || MAX;
    this.delay = opts.delay == null ? 1500 : opts.delay;
    this.rereadMs = opts.rereadMs || 2000;
    this.log = opts.log || (() => {});
    this.onChange = opts.onChange || (() => {});
    this.items = this._load();
    this.t = null;
    this.saving = null; this.again = false; this.flushes = 0;
    this.changes = 0; this.written = 0;            // changes made, and how many of them are on disk
  }

  // history.json; if a crash or power cut left it unreadable, the temp copy written whole just before (see above: the
  // newer, if both are there). A file that's there but can't be read now (Windows: held a moment by an antivirus, a
  // backup or sync program; EMFILE, EIO) is tried again for about a second, then left as it is: this run starts with
  // an empty list and writes nothing over it until it reads (_reread), when what this run added goes on top of it.
  _load() {
    const got = this._readDisk(HELD_WAITS);
    if (got !== HELD) return got;
    this.held = true;
    this.log('history: ' + path.basename(this.file) + ' could not be read now: kept as it is, read again in a moment');
    this._reread();
    return [];
  }

  _readDisk(waits) {
    const read = (f) => {
      let text;
      for (let i = 0; ; i++) {
        try { text = fs.readFileSync(f, 'utf8'); break; } catch (e) {
          if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return null;      // none
          if (i >= waits.length) return HELD;
          sleepSync(waits[i]);
        }
      }
      let at = 0;
      try { at = fs.statSync(f).mtimeMs; } catch (e) { /* ignore */ }
      try { const a = JSON.parse(text); return Array.isArray(a) ? { a, at } : null; } catch (e) { return null; }   // cut short
    };
    let got = read(this.file);
    if (got === HELD) return HELD;
    if (!got) {
      got = [read(this.file + '.tmp'), read(this.file + '.tmpq')].filter((x) => x && x !== HELD).sort((x, y) => y.at - x.at)[0] || null;
      if (got && fs.existsSync(this.file)) this.log('history: ' + path.basename(this.file) + ' was cut short: read from the copy written before it');
    }
    return got ? got.a.filter(valid).slice(0, this.max).map(timed) : [];
  }

  // (history.json couldn't be read at the start) read again now and then; once it reads, this run's entries go on top
  // of it (those removed or cleared meanwhile stay gone) and it is saved
  _reread() {
    this.rereadT = setTimeout(() => {
      this.rereadT = null;
      this.rereadTries = (this.rereadTries || 0) + 1;
      if (!this._tryRead()) this._reread();
    }, Math.min(60000, this.rereadMs * 2 ** Math.min(6, this.rereadTries || 0)));
    if (this.rereadT.unref) this.rereadT.unref();
  }

  _tryRead(saving) {
    if (!this.held) return true;
    const disk = this._readDisk([]);
    if (disk === HELD) return false;
    this.held = false;
    clearTimeout(this.rereadT); this.rereadT = null;
    if (!this.heldCleared) {
      const have = new Set(this.items.map((x) => x.id)), gone = this.heldRemoved || new Set();
      this.items = this.items.concat(disk.filter((x) => !have.has(x.id) && !gone.has(x.id))).slice(0, this.max);
    }
    this.heldRemoved = null; this.heldCleared = false;
    this.log('history: ' + path.basename(this.file) + ' read now');
    if (this.heldDirty) { this.heldDirty = false; this.changes++; }
    if (!saving && this.changes > this.written) this.save();
    try { this.onChange(); } catch (e) { /* ignore */ }
    return true;
  }

  list() { return this.items; }

  /**
   * e: { dir: 'in'|'out', name?, path?, size?, time?, device?, deviceName?, ok?, how?, folder?, why? }
   * how: fling | auto | quickshare | browser | sync | pc | pull (what moved it)
   */
  add(e) {
    const it = {
      id: crypto.randomBytes(6).toString('hex'),
      dir: e.dir === 'out' ? 'out' : 'in',
      name: String(e.name || (e.path ? path.basename(e.path) : '') || 'file').slice(0, 260),
      size: Math.max(0, Math.floor(+e.size || 0)),
      time: +e.time || Date.now(),
      device: e.device ? String(e.device).slice(0, 64) : '',
      deviceName: String(e.deviceName || '').slice(0, 60),
      path: e.path ? String(e.path) : '',
      ok: e.ok !== false,
      how: e.how ? String(e.how).slice(0, 20) : '',
    };
    if (e.folder) it.folder = true;
    if (e.why && it.ok === false) it.why = String(e.why).slice(0, 20);     // declined | timeout (Ask each time) | save | quit
    this.items.unshift(it);
    if (this.items.length > this.max) this.items.length = this.max;
    this._changed();
    return it;
  }

  get(id) { return this.items.find((x) => x.id === id) || null; }

  remove(id) {
    if (this.held) (this.heldRemoved = this.heldRemoved || new Set()).add(id);
    const n = this.items.length;
    this.items = this.items.filter((x) => x.id !== id);
    if (n !== this.items.length) this._changed();
  }

  clear() {
    if (this.held) { this.heldCleared = true; this.heldDirty = true; }
    if (!this.items.length) return;
    this.items = []; this._changed();
  }

  _changed() {
    this.changes++;
    this.onChange();
    clearTimeout(this.t);
    this.t = setTimeout(() => this.save(), this.delay);
  }

  /** Writes it in the background (one write at a time; a change meanwhile is written right after). */
  save() {
    clearTimeout(this.t); this.t = null;
    if (this.held && !this._tryRead(true)) return Promise.resolve();    // (never written over while it can't be read)
    if (this.saving) { this.again = true; return this.saving; }
    this.saving = (async () => {
      do {
        this.again = false;
        const tmp = this.file + '.tmp', n = this.flushes, upto = this.changes;
        try {
          await fs.promises.mkdir(path.dirname(this.file), { recursive: true });
          const fh = await fs.promises.open(tmp, 'w');
          try { await fh.writeFile(JSON.stringify(this.items)); await fh.sync(); } finally { await fh.close(); }
          if (this.flushes !== n) { await fs.promises.unlink(tmp).catch(() => {}); return; }     // flush() wrote a newer one meanwhile
          await this._replace(tmp);
          // (flush() ran while this went in place, maybe before it: its newer one is written again, to be sure it's the one)
          if (this.flushes !== n) { this._writeNow(); return; }
          this.written = Math.max(this.written, upto);
        } catch (e) {
          this.log('history not saved: ' + e.message);
          await fs.promises.unlink(tmp).catch(() => {});
        }
      } while (this.again);
    })().finally(() => { this.saving = null; });
    return this.saving;
  }

  // tmp (whole, on disk) in history.json's place
  async _replace(tmp) {
    for (let i = 0; ; i++) {
      try { await fs.promises.rename(tmp, this.file); break; } catch (e) {
        if (LOCKED.includes(e.code) && i < 4) { await sleep(100 * 2 ** i); continue; }      // (an antivirus: 0.1 ... 0.8 s)
        // still held: copied over it, made sure of on disk, and only then is the temp copy gone
        await fs.promises.copyFile(tmp, this.file);
        const fh = await fs.promises.open(this.file, 'r+');
        try { await fh.sync(); } finally { await fh.close(); }
        await fs.promises.unlink(tmp).catch(() => {});
        return;
      }
    }
    await syncDir(path.dirname(this.file));
  }

  /** Writes it now, if anything isn't on disk yet (on quit). */
  flush() {
    clearTimeout(this.t); this.t = null;
    if (this.held && !this._tryRead(true)) { this.log('history: not saved, ' + path.basename(this.file) + ' still could not be read'); return false; }
    if (this.written === this.changes && !this.saving) return true;
    this.flushes++;
    return this._writeNow();
  }

  _writeNow() {
    const tmp = this.file + '.tmpq', upto = this.changes;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const fd = fs.openSync(tmp, 'w');
      try { fs.writeSync(fd, JSON.stringify(this.items)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      try {
        fs.renameSync(tmp, this.file);
        syncDirNow(path.dirname(this.file));
      } catch (e) {
        // briefly locked (antivirus): copied instead, on disk before the temp copy goes (see above)
        fs.copyFileSync(tmp, this.file);
        const fd2 = fs.openSync(this.file, 'r+');
        try { fs.fsyncSync(fd2); } finally { fs.closeSync(fd2); }
        fs.unlinkSync(tmp);
      }
      this.written = Math.max(this.written, upto);
      return true;
    } catch (e) {
      this.log('history not saved: ' + e.message);
      try { fs.unlinkSync(tmp); } catch (x) { /* ignore */ }
      return false;
    }
  }
}

module.exports = { History, MAX };
