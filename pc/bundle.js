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
   * @param {object} hooks { onManifest(m), onProgress(received, total), onFile({i, p, size, from}), onEntry({i, p, size, dir}) }
   *   onFile: a file entry's file is open and its bytes come next; onEntry: an entry is complete (on disk, closed).
   *   i: the entry's number in the phone's list for this stream (its "i"; else counted from opts.first)
   * @param {object} [shared] { taken, tops, assigned }: state shared by the streams of one striped bundle
   * @param {object} [opts] { first, resume: { p, from } }: first: the number of this body's first entry (a stream sent
   *   again from its skip-th entry); resume: this stream continues a file entry that was cut off: its first entry must be
   *   that file (already staged, see `assigned`), whose bytes from `from` on are all that follow its header
   */
  constructor(root, hooks, shared, opts) {
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
    this.aborted = false;
    this.resume = (opts && opts.resume && opts.resume.from > 0) ? opts.resume : null;
    this.first = true;                // the next entry is the stream's first
    this.nextNo = (opts && opts.first) || 0;   // the number an entry without its own "i" gets
    this.pos = 0;                     // where the open file's next bytes go
    this.dirs = new Set();            // folders made already (each file doesn't make its folder again)
  }

  async _mkdir(d) {
    if (this.dirs.has(d)) return;
    await fs.promises.mkdir(d, { recursive: true });
    this.dirs.add(d);
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
    const no = Number.isSafeInteger(h.i) && h.i >= 0 ? h.i : this.nextNo;
    this.nextNo = no + 1;
    // a stream continuing a file that was cut off starts with that file's entry
    const resume = this.first ? this.resume : null;
    this.first = false;
    this.resume = null;
    if (resume && (h.d || String(h.p) !== resume.p)) throw new Error('resume mismatch');
    if (h.d || segs.length > 1) this._top(segs[0]);   // a top-level file is recorded under the name it's actually staged as
    if (h.d) {
      await this._mkdir(full);
      this.stage = 'hlen'; this.need = 4;
      if (this.hooks.onEntry) this.hooks.onEntry({ i: no, p: String(h.p), size: 0, dir: true });
      return;
    }
    const size = Math.max(0, Math.floor(+h.s || 0));
    let dest = this.assigned && this.assigned.get(String(h.p));
    let fd;
    if (resume) {
      // the file staged before, continued where it was cut off
      if (!dest || resume.from > size) throw new Error('resume mismatch');
      fd = await fs.promises.open(dest, 'r+');
      this.pos = resume.from;
    } else {
      await this._mkdir(path.dirname(full));
      const ext = path.extname(full), base = full.slice(0, full.length - ext.length);
      if (!dest) {
        // a name not taken: made new here ('wx': a file already there, from an earlier attempt, is never written over)
        dest = full; let i = 2;
        for (;;) {
          if (!this.taken.has(this._key(dest))) {
            try { fd = await fs.promises.open(dest, 'wx'); break; } catch (e) { if (e.code !== 'EEXIST') throw e; }
          }
          dest = base + ' (' + i++ + ')' + ext;
        }
        this.taken.set(this._key(dest), true);
        if (this.assigned) this.assigned.set(String(h.p), dest);
      } else fd = await fs.promises.open(dest, 'w');
      this.pos = 0;
    }
    if (segs.length === 1) this._top(path.basename(dest));
    // abort() can come while the file is being opened: close it here, or nothing ever would
    if (this.aborted) { await fd.close().catch(() => {}); throw new Error('aborted'); }
    this.fd = fd;
    this.cur = { path: dest, mtime: +h.m || 0, i: no, p: String(h.p), size, written: this.pos };
    this.left = size - this.pos;
    if (this.hooks.onFile) this.hooks.onFile({ i: no, p: String(h.p), size, from: this.pos });
    if (this.left === 0) await this._closeFile();
    else this.stage = 'data';
  }

  async _closeFile() {
    const fd = this.fd, cur = this.cur;
    this.fd = null; this.cur = null;
    // the phone's date, set on the open file (no second open by name)
    if (fd && cur && cur.mtime > 0) { const t = new Date(cur.mtime); await fd.utimes(t, t).catch(() => {}); }
    if (fd) await fd.close();
    this.stage = 'hlen'; this.need = 4;
    if (cur && this.hooks.onEntry) this.hooks.onEntry({ i: cur.i, p: cur.p, size: cur.size, dir: false });
  }

  /** Feed the next chunk of the request body (await before feeding the next one). */
  async push(chunk) {
    let off = 0;
    while (off < chunk.length && !this.done) {
      if (this.aborted) throw new Error('aborted');
      if (this.stage === 'data') {
        const n = Math.min(this.left, chunk.length - off);
        const slice = chunk.subarray(off, off + n);
        let w = 0;
        while (w < slice.length) { const r = await this.fd.write(slice, w, slice.length - w, this.pos + w); w += r.bytesWritten; }
        off += n; this.left -= n; this.received += n; this.pos += n;
        if (this.cur) this.cur.written = this.pos;
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
        if (n === 0) {
          if (this.resume) throw new Error('resume mismatch');   // the file it was to continue never came
          this.done = true; this.stage = 'end'; return;
        }
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
    this.aborted = true;
    const fd = this.fd; this.fd = null;
    if (fd) await fd.close().catch(() => {});
  }
}

module.exports = { BundleReceiver, safeSegment, safeRelative, MAGIC };
