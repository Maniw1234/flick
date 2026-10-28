'use strict';
// The transfer history (userData/history.json): every file received from a phone (a fling, sent quietly, Quick Share,
// a browser, folder sync) and every file sent to one, newest first, at most 500. Written a moment after a change (one
// write for a burst of them, as in a folder sync), in the background and atomically: a temp file, flushed to disk, then
// renamed over the old one, so a crash mid-write never leaves half a file.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX = 500;

const valid = (e) => !!e && typeof e === 'object' && typeof e.id === 'string' && (e.dir === 'in' || e.dir === 'out') && typeof e.name === 'string';

class History {
  /** opts: { max, delay (ms before a change is written), log(msg), onChange() } */
  constructor(file, opts = {}) {
    this.file = file;
    this.max = opts.max || MAX;
    this.delay = opts.delay == null ? 1500 : opts.delay;
    this.log = opts.log || (() => {});
    this.onChange = opts.onChange || (() => {});
    this.items = this._load();
    this.t = null;
    this.saving = null; this.again = false; this.flushes = 0;
  }

  _load() {
    try {
      const a = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (Array.isArray(a)) return a.filter(valid).slice(0, this.max);
    } catch (e) { /* none yet, or unreadable: start empty */ }
    return [];
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
    if (e.why && it.ok === false) it.why = String(e.why).slice(0, 20);     // declined | timeout (Ask each time)
    this.items.unshift(it);
    if (this.items.length > this.max) this.items.length = this.max;
    this._changed();
    return it;
  }

  get(id) { return this.items.find((x) => x.id === id) || null; }

  remove(id) {
    const n = this.items.length;
    this.items = this.items.filter((x) => x.id !== id);
    if (n !== this.items.length) this._changed();
  }

  clear() { if (!this.items.length) return; this.items = []; this._changed(); }

  _changed() {
    this.onChange();
    clearTimeout(this.t);
    this.t = setTimeout(() => this.save(), this.delay);
  }

  /** Writes it in the background (one write at a time; a change meanwhile is written right after). */
  save() {
    clearTimeout(this.t); this.t = null;
    if (this.saving) { this.again = true; return this.saving; }
    this.saving = (async () => {
      do {
        this.again = false;
        const tmp = this.file + '.tmp', n = this.flushes;
        try {
          await fs.promises.mkdir(path.dirname(this.file), { recursive: true });
          const fh = await fs.promises.open(tmp, 'w');
          try { await fh.writeFile(JSON.stringify(this.items)); await fh.sync(); } finally { await fh.close(); }
          if (this.flushes !== n) return;                // flush() wrote a newer one meanwhile
          // (briefly locked by an antivirus: copied instead)
          try { await fs.promises.rename(tmp, this.file); }
          catch (e) { await fs.promises.copyFile(tmp, this.file); await fs.promises.unlink(tmp).catch(() => {}); }
        } catch (e) {
          this.log('history not saved: ' + e.message);
          await fs.promises.unlink(tmp).catch(() => {});
        }
      } while (this.again);
    })().finally(() => { this.saving = null; });
    return this.saving;
  }

  /** Writes it now (on quit). */
  flush() {
    this.flushes++;
    clearTimeout(this.t); this.t = null;
    const tmp = this.file + '.tmpq';
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const fd = fs.openSync(tmp, 'w');
      try { fs.writeSync(fd, JSON.stringify(this.items)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      try { fs.renameSync(tmp, this.file); }
      catch (e) { fs.copyFileSync(tmp, this.file); fs.unlinkSync(tmp); }     // briefly locked (antivirus): copy instead
      return true;
    } catch (e) {
      this.log('history not saved: ' + e.message);
      try { fs.unlinkSync(tmp); } catch (x) { /* ignore */ }
      return false;
    }
  }
}

module.exports = { History, MAX };
