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
const PREVIEW = 300;                       // characters of text kept in the index
const TEXT_MAX = 1024 * 1024;              // what a clipboard can carry (clip.js / phoneapi.js)
const PNG_MAX = 6 * 1024 * 1024;
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const sha = (b) => crypto.createHash('sha1').update(b).digest('hex');

/** Is this text one http(s) link (and nothing else)? */
function isLink(t) {
  const s = String(t || '').trim();
  if (!s || s.length > 4096 || /\s/.test(s)) return false;
  try { const u = new URL(s); return u.protocol === 'http:' || u.protocol === 'https:'; } catch (e) { return false; }
}

const valid = (e) => !!e && typeof e === 'object' && typeof e.id === 'string' && /^[0-9a-f]{12}$/.test(e.id) && (e.kind === 'text' || e.kind === 'link' || e.kind === 'image');

class ClipHistory {
  /** opts: { max, log(msg), onChange(), thumb(png) -> data URL | null (a small picture for the list) } */
  constructor(dir, opts = {}) {
    this.dir = dir;
    this.file = path.join(dir, 'index.json');
    this.max = opts.max || MAX;
    this.log = opts.log || (() => {});
    this.onChange = opts.onChange || (() => {});
    this.thumb = opts.thumb || (() => null);
    this.items = this._load();
    this.q = Promise.resolve();            // writes one at a time
  }

  _load() {
    try {
      const a = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (Array.isArray(a)) return a.filter((e) => valid(e) && fs.existsSync(this._payload(e))).slice(0, this.max);
    } catch (e) { /* none yet, or unreadable: start empty */ }
    return [];
  }

  _payload(e) { return path.join(this.dir, e.id + (e.kind === 'image' ? '.png' : '.txt')); }

  _serial(fn) {
    const p = this.q.then(fn);
    this.q = p.catch((e) => this.log('clipboard history: ' + (e && e.message)));
    return p;
  }

  /** The list for the panel: no full contents. */
  list() {
    return this.items.map((e) => ({ id: e.id, kind: e.kind, preview: e.preview || '', thumb: e.thumb || null, w: e.w || 0, h: e.h || 0, bytes: e.bytes || 0, dir: e.dir, deviceName: e.deviceName || '', time: e.time }));
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
        e.preview = t.length > PREVIEW ? t.slice(0, PREVIEW - 1) + '…' : t;
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
      let names = [];
      try { names = await fs.promises.readdir(this.dir); } catch (e) { names = []; }
      for (const n of names) if (/^[0-9a-f]{12}\.(txt|png)(\.tmp)?$|^index\.json(\.tmp)?$/.test(n)) await fs.promises.rm(path.join(this.dir, n), { force: true }).catch(() => {});
      if (had) this._changed();
    });
  }

  _changed() { try { this.onChange(); } catch (e) { /* ignore */ } }

  async _writeIndex() {
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

  /** Waits for the writes queued so far (tests, quitting). */
  flush() { return this.q.then(() => {}, () => {}); }
}

module.exports = { ClipHistory, isLink, MAX };
