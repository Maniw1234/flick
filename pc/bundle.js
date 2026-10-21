'use strict';
// Receives a "Flick bundle": many files and folders streamed from the phone in one request.
//
//   "FLKB1\n"
//   [u32 len][manifest JSON]            {"v":1,"files":N,"bytes":B,"roots":[...]}
//   repeated:
//   [u32 len][entry JSON]               {"p":"Folder/sub/file.jpg","s":size,"m":mtimeMs}   or   {"p":"Folder/empty","d":1}
//   [size bytes]                        (files only)
//   [u32 0]                             end
//
// Every path is rebuilt segment by segment with Windows-safe names, so nothing can land outside `root`.
const fs = require('fs');
const path = require('path');

const MAGIC = Buffer.from('FLKB1\n', 'latin1');
const MAX_JSON = 256 * 1024;
const MAX_ENTRIES = 200000;
const MAX_DEPTH = 64;

function safeSegment(n) {
  let s = String(n || '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '').trim();
  if (!s || s === '.' || s === '..') s = '_';
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(s)) s = '_' + s;
  if (s.length > 150) { const e = path.extname(s).slice(0, 20); s = s.slice(0, 150 - e.length) + e; }
  return s;
}

/** "a/b/../c.txt" → ["a","b","_","c.txt"]: every segment becomes a plain, Windows-safe name. */
function safeRelative(p) {
  const segs = String(p || '').split(/[\\/]+/).filter((x) => x.length > 0);
  if (!segs.length || segs.length > MAX_DEPTH) return null;
  return segs.map(safeSegment);
}

class BundleReceiver {
  /**
   * @param {string} root  empty staging folder for this transfer
   * @param {object} hooks { onManifest(m), onProgress(received, total) }
   * @param {object} [shared] { taken, tops, assigned }: state shared by the streams of one striped bundle
   */
  constructor(root, hooks, shared) {
    this.root = path.resolve(root);
    this.hooks = hooks || {};
    this.stage = 'magic';
    this.pend = Buffer.alloc(0);      // bytes of a fixed-size field split across chunks
    this.need = MAGIC.length;
    this.manifest = null;
    this.entries = 0;
    this.received = 0;               // file bytes written
    this.total = 0;
    this.fd = null; this.left = 0; this.cur = null;
    this.tops = shared ? shared.tops : [];          // top-level names, in arrival order
    this.taken = shared ? shared.taken : new Map(); // lower-cased staged file paths
    this.assigned = shared ? shared.assigned : null; // requested path -> staged path: a stream sent again rewrites its own files
    this.done = false;
  }

  _top(seg0) { if (!this.tops.includes(seg0)) this.tops.push(seg0); }

  _resolve(segs) {
    const full = path.resolve(this.root, ...segs);
    if (!full.startsWith(this.root + path.sep)) throw new Error('bad path');
    return full;
  }

  // Windows names are case-insensitive: "IMG.jpg" and "img.JPG" from one Android folder must not overwrite each other
  _key(full) { return path.relative(this.root, full).split(path.sep).join('/').toLowerCase(); }

  async _header(json) {
    let h;
    try { h = JSON.parse(json); } catch (e) { throw new Error('bad entry'); }
    if (++this.entries > MAX_ENTRIES) throw new Error('too many entries');
    const segs = safeRelative(h.p);
    if (!segs) throw new Error('bad path');
    const full = this._resolve(segs);
    if (h.d || segs.length > 1) this._top(segs[0]);   // a top-level file is recorded under the name it's actually staged as
    if (h.d) {
      await fs.promises.mkdir(full, { recursive: true });
      this.stage = 'hlen'; this.need = 4;
      return;
    }
    const size = Math.max(0, Math.floor(+h.s || 0));
    await fs.promises.mkdir(path.dirname(full), { recursive: true });
    const ext = path.extname(full), base = full.slice(0, full.length - ext.length);
    let dest = this.assigned && this.assigned.get(String(h.p));
    if (!dest) {
      dest = full; let i = 2;
      while (this.taken.has(this._key(dest)) || fs.existsSync(dest)) dest = base + ' (' + i++ + ')' + ext;
      this.taken.set(this._key(dest), true);
      if (this.assigned) this.assigned.set(String(h.p), dest);
    }
    if (segs.length === 1) this._top(path.basename(dest));
    this.fd = await fs.promises.open(dest, 'w');
    this.cur = { path: dest, mtime: +h.m || 0 };
    this.left = size;
    if (size === 0) await this._closeFile();
    else this.stage = 'data';
  }

  async _closeFile() {
    const fd = this.fd, cur = this.cur;
    this.fd = null; this.cur = null;
    if (fd) await fd.close();
    if (cur && cur.mtime > 0) { const t = new Date(cur.mtime); await fs.promises.utimes(cur.path, t, t).catch(() => {}); }
    this.stage = 'hlen'; this.need = 4;
  }

  /** Feed the next chunk of the request body (await before feeding the next one). */
  async push(chunk) {
    let off = 0;
    while (off < chunk.length && !this.done) {
      if (this.stage === 'data') {
        const n = Math.min(this.left, chunk.length - off);
        const slice = chunk.subarray(off, off + n);
        let w = 0;
        while (w < slice.length) { const r = await this.fd.write(slice, w, slice.length - w); w += r.bytesWritten; }
        off += n; this.left -= n; this.received += n;
        if (this.hooks.onProgress) this.hooks.onProgress(this.received, this.total);
        if (this.left === 0) await this._closeFile();
        continue;
      }
      // fixed-size fields: magic, lengths, JSON blocks
      const take = Math.min(this.need - this.pend.length, chunk.length - off);
      this.pend = this.pend.length ? Buffer.concat([this.pend, chunk.subarray(off, off + take)]) : Buffer.from(chunk.subarray(off, off + take));
      off += take;
      if (this.pend.length < this.need) break;
      const field = this.pend; this.pend = Buffer.alloc(0);
      await this._field(field);
    }
  }

  async _field(b) {
    switch (this.stage) {
      case 'magic':
        if (!b.equals(MAGIC)) throw new Error('not a Flick bundle');
        this.stage = 'mlen'; this.need = 4; return;
      case 'mlen': {
        const n = b.readUInt32BE(0);
        if (n < 2 || n > MAX_JSON) throw new Error('bad manifest');
        this.stage = 'manifest'; this.need = n; return;
      }
      case 'manifest': {
        try { this.manifest = JSON.parse(b.toString('utf8')); } catch (e) { throw new Error('bad manifest'); }
        this.total = Math.max(0, +this.manifest.bytes || 0);
        if (this.hooks.onManifest) this.hooks.onManifest(this.manifest);
        this.stage = 'hlen'; this.need = 4; return;
      }
      case 'hlen': {
        const n = b.readUInt32BE(0);
        if (n === 0) { this.done = true; this.stage = 'end'; return; }
        if (n > MAX_JSON) throw new Error('bad entry');
        this.stage = 'header'; this.need = n; return;
      }
      case 'header':
        await this._header(b.toString('utf8'));
        return;
      default:
        throw new Error('unexpected data');
    }
  }

  /** Close anything still open (after an error). */
  async abort() {
    const fd = this.fd; this.fd = null;
    if (fd) await fd.close().catch(() => {});
  }
}

module.exports = { BundleReceiver, safeSegment, safeRelative, MAGIC };
