'use strict';
// Clipboard history, the PC side: the last 20 clipboards that went through Flick (sent to a phone or taken from one),
// kept on this PC only (userData/cliphist/). Text, links and pictures. A clipboard a password manager marked as
// private never gets here: the PC never sends one (clip.js), and the phone marks one it was asked to send anyway.
// index.json holds the list (newest first, with a short preview and a small thumbnail for pictures); each item's full
// content is a file of its own (<id>.txt or <id>.png), read only to copy or send it again. Written like history.js:
// a temp file, flushed, then renamed over the old one.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX = 20;
const SEEN = /[^\s\p{Z}\p{Cc}\p{Cf}\u034F\u115F\u1160\u2800\u3164\uFFA0]/u;   // something to see in a text
const PREVIEW = 300;                       // characters of text kept in the index
const TEXT_MAX = 1024 * 1024;              // what a clipboard can carry (clip.js / phoneapi.js)
const PNG_MAX = 6 * 1024 * 1024;
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const sha = (b) => crypto.createHash('sha1').update(b).digest('hex');
const sleepSync = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (e) { /* ignore */ } };
const HELD = 'held';                            // a list that's there but can't be read now (see _load)
const HELD_WAITS = [50, 100, 200, 300, 350];    // (about a second)

/** Is this text one http(s) link (and nothing else)? */
function isLink(t) {
  const s = String(t || '').trim();
  if (!s || s.length > 4096 || /\s/.test(s)) return false;
  // (not one with a name before the host: "https://bank.example@evil.example" reads as one site and opens another;
  // phoneapi.js cleanUrl refuses it, and so do the phone and its page)
  try { const u = new URL(s); return (u.protocol === 'http:' || u.protocol === 'https:') && !u.username && !u.password; } catch (e) { return false; }
}

// t cut to at most n UTF-16 units, at the end of a whole character as it's seen: an emoji is two units or more (a family
// or a flag several), an accented letter can be two. Cut inside one, the list showed a broken character (and kept it in
// index.json). As the phone cuts (ClipStore.cut).
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
function cut(t, n) {
  if (t.length <= n) return t;
  let end = 0;
  for (const s of GRAPHEMES.segment(t.slice(0, n + 64))) {     // (what's around the cut is enough: a text can be 1 MB)
    if (s.index + s.segment.length > n) break;
    end = s.index + s.segment.length;
  }
  // (one "character" longer than all of it, accents piled on one letter: cut there, but never inside an emoji's pair)
  if (end <= 0) end = /[\uD800-\uDBFF]/.test(t[n - 1]) ? n - 1 : n;
  return t.slice(0, end);
}

const valid = (e) => !!e && typeof e === 'object' && typeof e.id === 'string' && /^[0-9a-f]{12}$/.test(e.id) && (e.kind === 'text' || e.kind === 'link' || e.kind === 'image');

class ClipHistory {
  /** opts: { max, log(msg), onChange(), thumb(png) -> data URL | null (a small picture for the list), rereadMs (a list
   *  held at the start: read again after) } */
  constructor(dir, opts = {}) {
    this.dir = dir;
    this.file = path.join(dir, 'index.json');
    this.max = opts.max || MAX;
    this.log = opts.log || (() => {});
    this.onChange = opts.onChange || (() => {});
    this.thumb = opts.thumb || (() => null);
    this.rereadMs = opts.rereadMs || 2000;
    this.q = Promise.resolve();            // writes one at a time
    this.items = this._load();
    // content files no entry points to (a crash or power cut between a clip's file and the list, or between the list and
    // removing a clip that dropped off it) go, in the background
    if (!this.held) this._serial(() => this._sweep());
  }

  // The list. One that's there but can't be read now (Windows: held a moment by an antivirus, a backup or sync program;
  // EMFILE, EIO) is tried again for about a second, then left as it is: this run starts with an empty list and writes
  // nothing over it until it reads (_reread), when this run's clips go on top of it. (None yet, or damaged: start empty.)
  _load() {
    const a = this._readDisk(HELD_WAITS);
    if (a !== HELD) return a;
    this.held = true;
    this.log('clipboard history: its list could not be read now: kept as it is, read again in a moment');
    this._reread();
    return [];
  }

  _readDisk(waits) {
    let text;
    for (let i = 0; ; i++) {
      try { text = fs.readFileSync(this.file, 'utf8'); break; } catch (e) {
        if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return [];
        if (i >= waits.length) return HELD;
        sleepSync(waits[i]);
      }
    }
    try {
      const a = JSON.parse(text);
      if (Array.isArray(a)) return a.filter((e) => valid(e) && fs.existsSync(this._payload(e))).slice(0, this.max);
    } catch (e) { /* damaged */ }
    return [];
  }

  _reread() {
    this.rereadT = setTimeout(() => {
      this.rereadT = null;
      this.rereadTries = (this.rereadTries || 0) + 1;
      this._serial(async () => { if (!(await this._tryRead())) this._reread(); });
    }, Math.min(60000, this.rereadMs * 2 ** Math.min(6, this.rereadTries || 0)));
    if (this.rereadT.unref) this.rereadT.unref();
  }

  // (in _serial) the list read at last: this run's clips first, then the older ones not the same (a clip cleared meanwhile
  // goes with its file), written, and the files nothing points to removed
  async _tryRead() {
    if (!this.held) return true;
    const disk = this._readDisk([]);
    if (disk === HELD) return false;
    this.held = false;
    const hashes = new Set(this.items.map((x) => x.hash)), ids = new Set(this.items.map((x) => x.id));
    const older = this.heldCleared ? [] : disk.filter((x) => !ids.has(x.id) && !hashes.has(x.hash));
    this.heldCleared = false;
    this.items = this.items.concat(older).slice(0, this.max);
    await this._writeIndex();
    await this._sweep();
    this.log('clipboard history: its list was read now');
    this._changed();
    return true;
  }

  // (in _serial) removes the content files and temp files no entry points to
  async _sweep() {
    if (this.held) return;
    let names;
    try { names = await fs.promises.readdir(this.dir); } catch (e) { return; }
    const keep = new Set(this.items.map((e) => path.basename(this._payload(e))));
    for (const n of names) {
      if ((/^[0-9a-f]{12}\.(txt|png)(\.tmp)?$/.test(n) && !keep.has(n)) || n === 'index.json.tmp') await fs.promises.rm(path.join(this.dir, n), { force: true }).catch(() => {});
    }
  }

  _payload(e) { return path.join(this.dir, e.id + (e.kind === 'image' ? '.png' : '.txt')); }

  _serial(fn) {
    const p = this.q.then(fn);
    this.q = p.catch((e) => this.log('clipboard history: ' + (e && e.message)));
    return p;
  }

  /** The list for the panel: no full contents. */
  list() {
    return this.items.map((e) => ({ id: e.id, kind: e.kind, preview: e.preview || '', blank: !!e.blank, thumb: e.thumb || null, w: e.w || 0, h: e.h || 0, bytes: e.bytes || 0, dir: e.dir, deviceName: e.deviceName || '', time: e.time }));
  }

  /**
   * Something went through Flick: c = { kind: 'text', text } | { kind: 'image', png (Buffer) }, dir 'in' (from a
   * phone) or 'out' (to one), device, deviceName. The same content again moves to the top. Resolves the entry.
   */
  add(c, meta = {}) {
    let body, kind;
    if (c && c.kind === 'text' && typeof c.text === 'string' && c.text.length) {
      if (Buffer.byteLength(c.text, 'utf8') > TEXT_MAX) return Promise.resolve(null);
      body = Buffer.from(c.text, 'utf8');
      kind = isLink(c.text) ? 'link' : 'text';
    } else if (c && c.kind === 'image' && Buffer.isBuffer(c.png) && c.png.length >= 8 && c.png.length <= PNG_MAX && c.png.subarray(0, 8).equals(PNG_SIG)) {
      body = c.png;
      kind = 'image';
    } else return Promise.resolve(null);
    const hash = sha(body);
    const who = { dir: meta.dir === 'out' ? 'out' : 'in', device: String(meta.device || '').slice(0, 64), deviceName: String(meta.deviceName || '').slice(0, 60), time: Date.now() };
    return this._serial(async () => {
      const have = this.items.find((x) => x.hash === hash);
      if (have) {
        Object.assign(have, who);
        this.items = [have].concat(this.items.filter((x) => x !== have));
        await this._writeIndex();
        this._changed();
        return have;
      }
      const e = Object.assign({ id: crypto.randomBytes(6).toString('hex'), kind, hash, bytes: body.length }, who);
      if (kind === 'image') {
        e.w = body.readUInt32BE(16); e.h = body.readUInt32BE(20);
        try { e.thumb = this.thumb(body) || null; } catch (x) { e.thumb = null; }
      } else {
        const t = c.text.replace(/\s+/g, ' ').trim();
        e.preview = t.length > PREVIEW ? cut(t, PREVIEW - 1) + '…' : t;
        // only blanks or invisible characters (an empty table cell, a tab, a zero-width space): named so, as the phone
        // does (ClipStore.blank), not an empty row
        if (!SEEN.test(c.text)) { const n = Array.from(c.text).length; e.preview = 'Blank text (' + n + (n === 1 ? ' character)' : ' characters)'); e.blank = true; }
      }
      await fs.promises.mkdir(this.dir, { recursive: true });
      await this._atomic(this._payload(e), body);
      this.items.unshift(e);
      const gone = this.items.splice(this.max);
      await this._writeIndex();
      for (const g of gone) await fs.promises.rm(this._payload(g), { force: true }).catch(() => {});
      this._changed();
      return e;
    });
  }

  /** The full content of an entry: { kind: 'text', text } | { kind: 'image', png } | null. */
  async get(id) {
    const e = this.items.find((x) => x.id === id);
    if (!e) return null;
    try {
      const b = await fs.promises.readFile(this._payload(e));
      if (e.kind === 'image') return b.length >= 8 && b.subarray(0, 8).equals(PNG_SIG) ? { kind: 'image', png: b } : null;
      return { kind: 'text', text: b.toString('utf8') };
    } catch (x) { return null; }
  }

  remove(id) {
    return this._serial(async () => {
      const e = this.items.find((x) => x.id === id);
      if (!e) return false;
      this.items = this.items.filter((x) => x !== e);
      await this._writeIndex();
      await fs.promises.rm(this._payload(e), { force: true }).catch(() => {});
      this._changed();
      return true;
    });
  }

  /** Everything goes (Clear, or the setting turned off): the files too. */
  clear() {
    return this._serial(async () => {
      const had = this.items.length;
      this.items = [];
      if (this.held) this.heldCleared = true;  // (what the list held goes too, once it reads)
      let names = [];
      try { names = await fs.promises.readdir(this.dir); } catch (e) { names = []; }
      for (const n of names) if (/^[0-9a-f]{12}\.(txt|png)(\.tmp)?$|^index\.json(\.tmp)?$/.test(n)) await fs.promises.rm(path.join(this.dir, n), { force: true }).catch(() => {});
      if (had) this._changed();
    });
  }

  _changed() { try { this.onChange(); } catch (e) { /* ignore */ } }

  async _writeIndex() {
    if (this.held) return;                 // (never written over while it can't be read: see _load)
    await fs.promises.mkdir(this.dir, { recursive: true });
    await this._atomic(this.file, Buffer.from(JSON.stringify(this.items)));
  }

  async _atomic(file, buf) {
    const tmp = file + '.tmp';
    const fh = await fs.promises.open(tmp, 'w');
    try { await fh.writeFile(buf); await fh.sync(); } finally { await fh.close(); }
    try { await fs.promises.rename(tmp, file); }
    catch (e) { await fs.promises.copyFile(tmp, file); await fs.promises.unlink(tmp).catch(() => {}); }   // briefly locked (antivirus)
  }

  /** Waits for the writes queued so far (tests, quitting); a list that couldn't be read is tried once more. */
  flush() {
    if (this.held) this._serial(() => this._tryRead());
    return this.q.then(() => {}, () => {});
  }
}

module.exports = { ClipHistory, isLink, MAX };
