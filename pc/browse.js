'use strict';
// Browse phone: the PC window shows the phone's photos, videos, downloads, documents and folders, with thumbnails, and
// copies the files picked there into the save folder. The PC can't open connections to the phone, so it asks over the
// link the phone keeps open (its page's WebSocket, or the background link): {t:'browse', id, op, ...}. The phone
// answers by posting to /api/browse (phoneapi.js: the phone's token, paired with the code, over an encrypted link)
// and sends the files it is asked for as quiet uploads (kind=pull, tid pl<job>-<n>), which are saved like any
// received file. Read only: the only things to ask a phone for are listings, thumbnails and copies, and the phone
// answers only while "Let your PC browse this phone" is on in its Settings. Requests are rate-limited both ways.
//
// To the phone:   {t:'browse', id, op:'list', cat: photos|videos|docs|downloads|storage|dir, path?, offset, limit}
//                 {t:'browse', id, op:'thumbs', items:[{path, mtime, mid, mt}]}
//                 {t:'browse', id, op:'pull', job, files:[{i, path, name}]}     {t:'browse', id, op:'stop', job}
// From the phone: {id, ok:true, cat, path, name, parent, items, total, more} or {id, ok:false, error}
//                 {id, thumbs:{path: dataURL}, last?}       {id, ok} (a copy started, or not: error)
//                 {job, i, sent, total} (progress)    {job, i, ok:false, why} (a file it couldn't send)    {job, end:true}
const path = require('path');
const crypto = require('crypto');

const CATS = ['photos', 'videos', 'downloads', 'docs', 'storage'];
const KINDS = new Set(['image', 'video', 'audio', 'pdf', 'text', 'doc', 'apk']);
const THUMB_KINDS = new Set(['image', 'video', 'pdf', 'apk', 'audio']);
const LIMIT = 60;                     // items per page
const ANSWER_MS = 9000;               // a listing that hasn't come by then: the phone didn't answer
const THUMBS_MS = 45000;              // thumbnails keep coming for a page this long at most
const THUMB_MAX = 120 * 1024;         // one thumbnail (a data URL)
const THUMB_CACHE = 900;
const PULL_MAX = 200;                 // files in one copy
const PULL_IDLE_MS = 120000;          // a copy with no news for that long has stopped
const OUT_RATE = { n: 40, ms: 10000 };    // requests to one phone
const IN_RATE = { n: 120, ms: 10000 };    // answers from one phone (pages, thumbnail batches, progress)

const rid = () => crypto.randomBytes(6).toString('hex');
const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
const num = (v) => (Number.isFinite(+v) && +v >= 0 ? Math.floor(+v) : 0);

class PhoneBrowse {
  /**
   * o: { server, log(), panelSend(ch, data), saveReceived(tmp, name) -> {name, path, where}, record(entry),
   *      hasFeatures(device), nameOf(device), notify({title, body, click}), panelInFront(), showItem(path) }
   */
  constructor(o) {
    this.o = o;
    this.s = o.server;
    this.log = o.log || (() => {});
    this.pending = new Map();         // request id -> { device, op, at, timer }
    this.thumbs = new Map();          // "device|path|mtime" -> data URL (oldest first: LRU)
    this.jobs = new Map();            // job id -> a copy
    this.ended = new Map();           // job id -> { device, at }: copies that are over (late files of theirs are refused)
    this.rate = new Map();            // "out|device" / "in|device" -> times
    this.view = null;                 // what the window shows (null: the view is closed)
  }

  // ---------------- limits ----------------
  _allow(kind, device, r) {
    const k = kind + '|' + device, now = Date.now();
    const a = (this.rate.get(k) || []).filter((t) => now - t < r.ms);
    if (a.length >= r.n) { this.rate.set(k, a); return false; }
    a.push(now);
    this.rate.set(k, a);
    return true;
  }

  // ---------------- asking the phone ----------------
  _ask(device, msg, op, ms) {
    if (!this._allow('out', device, OUT_RATE)) return { error: 'slow' };
    const id = 'b' + rid();
    const p = { device, op, at: Date.now(), timer: null };
    p.timer = setTimeout(() => { this.pending.delete(id); this._timeout(id, p); }, ms || ANSWER_MS);
    this.pending.set(id, p);
    if (!this.s.sendEvent(device, Object.assign({ t: 'browse', id, op }, msg))) {
      clearTimeout(p.timer); this.pending.delete(id);
      return { error: 'unreachable' };
    }
    return { id, p };
  }

  _timeout(id, p) {
    const v = this.view;
    if (p.op === 'list' && v && v.req === id) {
      v.req = null; v.loading = false;
      if (!v.items.length || v.status === 'loading') v.status = 'noanswer';
      this._push();
    }
    if (p.op === 'pull' && p.job) this._jobEnd(p.job, 'noanswer');
  }

  // ---------------- the view (panel) ----------------
  /** The window's Browse phone view was opened (or the phone in use changed): start at Photos. */
  open(cat) {
    const device = this.s.eventTarget();
    const old = this.view;
    if (old && old.req) this._drop(old.req);
    this.view = {
      device, name: device ? this.o.nameOf(device) : '', status: 'loading', cat: CATS.includes(cat) ? cat : (old && old.device === device ? old.cat : 'photos'),
      path: '', root: '', rootName: '', parent: null, items: [], total: 0, more: false, loading: false, req: null, want: null, sent: new Set(),
    };
    if (!device) { this.view.status = 'none'; this._push(); return; }
    if (!this.o.hasFeatures(device)) { this.view.status = 'old'; this._push(); return; }
    this._list({ cat: this.view.cat, offset: 0 });
  }

  close() { if (this.view && this.view.req) this._drop(this.view.req); this.view = null; }

  _drop(id) { const p = this.pending.get(id); if (p) { clearTimeout(p.timer); this.pending.delete(id); } }

  _list(q) {
    const v = this.view;
    if (!v || !v.device) return;
    if (v.req) { this._drop(v.req); v.req = null; }
    const msg = { cat: q.cat, offset: q.offset || 0, limit: LIMIT };
    if (q.cat === 'dir') msg.path = q.path;
    const r = this._ask(v.device, msg, 'list');
    if (r.error) { v.status = r.error; v.loading = false; this._push(); return; }
    v.req = r.id;
    v.loading = true;
    v.want = q;
    if (!q.offset) { v.status = 'loading'; v.items = []; v.total = 0; v.more = false; }
    this._push();
  }

  cat(c) {
    const v = this.view;
    if (!v || !CATS.includes(c)) return;
    if (['none', 'old'].includes(v.status)) { this.open(c); return; }
    v.cat = c; v.path = ''; v.root = ''; v.rootName = ''; v.parent = null;
    this._list({ cat: c, offset: 0 });
  }

  dir(p) {
    const v = this.view;
    if (!v || typeof p !== 'string' || !p || p.length > 1024) return;
    // only places this listing came from: a folder shown in it, or a step back toward where the category starts
    const known = v.items.some((x) => x.dir && x.path === p) || (v.parent && p === v.parent && p.startsWith(v.root)) ||
      (v.root && (p === v.root || (p.startsWith(v.root + '/') && (v.path + '/').startsWith(p + '/'))));
    if (!known) return;
    v.path = p;
    this._list({ cat: 'dir', path: p, offset: 0 });
  }

  up() {
    const v = this.view;
    if (!v || !v.path || !v.parent || v.path === v.root) return;
    this.dir(v.parent);
  }

  more() {
    const v = this.view;
    if (!v || !v.more || v.loading || !v.want) return;
    this._list(Object.assign({}, v.want, { offset: v.items.length }));
  }

  refresh() {
    const v = this.view;
    if (!v) return;
    if (v.device !== this.s.eventTarget() || ['none', 'old', 'unreachable', 'noanswer', 'slow'].includes(v.status) || !v.want) { this.open(v.cat); return; }
    this._list(Object.assign({}, v.want, { offset: 0 }));
  }

  /** The whole view, for the panel; thumbnails it has had already aren't sent again. */
  state() {
    const v = this.view;
    if (!v) return { open: false, job: this._jobState() };
    const crumbs = [];
    if (v.root && v.path && v.path !== v.root && v.path.startsWith(v.root + '/')) {
      let acc = v.root;
      for (const part of v.path.slice(v.root.length + 1).split('/').filter(Boolean)) { acc += '/' + part; crumbs.push({ name: part, path: acc }); }
    }
    const thumbs = {};
    for (const x of v.items) {
      const k = this._tk(v.device, x), t = this.thumbs.get(k);
      if (t && !v.sent.has(k)) { thumbs[x.path] = t; v.sent.add(k); }
    }
    return {
      open: true, device: v.device, name: v.name, status: v.status, cat: v.cat, path: v.path, root: v.root, rootName: v.rootName, crumbs,
      items: v.items.map((x) => { const o = Object.assign({}, x); delete o.mid; delete o.mt; return o; }), thumbs,
      total: v.total, more: v.more, loading: v.loading, job: this._jobState(),
    };
  }

  /** The panel (re)loaded: it has none of the thumbnails. */
  resend() { if (this.view) this.view.sent = new Set(); this._push(); }

  _push() { this.o.panelSend('panel:browse', this.state()); }
  _pushJob() { this.o.panelSend('panel:browse-job', this._jobState()); }
  _tk(device, x) { return device + '|' + x.path + '|' + (x.mtime || 0); }

  // ---------------- answers from the phone (POST /api/browse) ----------------
  /** { ok } or { code, error } */
  reply(device, b) {
    if (!this._allow('in', device, IN_RATE)) return { code: 429, error: 'slow down' };
    if (typeof b.job === 'string' && typeof b.id !== 'string') return this._jobNews(device, b);
    const id = typeof b.id === 'string' ? b.id : '';
    const p = this.pending.get(id);
    if (!p || p.device !== device) return { code: 409, error: 'unknown' };
    if (p.op === 'list') { this._drop(id); this._listed(id, device, b); return { ok: true }; }
    if (p.op === 'thumbs') { this._thumbed(device, p, b); if (b.last === true || b.ok === false) this._drop(id); return { ok: true }; }
    if (p.op === 'pull' || p.op === 'stop') {
      this._drop(id);
      if (b.ok === false && p.job) this._jobEnd(p.job, ['off', 'busy', 'storage'].includes(b.error) ? b.error : 'failed');
      return { ok: true };
    }
    return { code: 409, error: 'unknown' };
  }

  _listed(id, device, b) {
    const v = this.view;
    if (!v || v.req !== id || v.device !== device) return;          // the user went elsewhere meanwhile
    v.req = null;
    v.loading = false;
    if (b.ok !== true) {
      const e = str(b.error, 40);
      v.status = ['off', 'storage', 'busy', 'notfound'].includes(e) ? e : 'error';
      this._push();
      return;
    }
    const items = (Array.isArray(b.items) ? b.items : []).slice(0, LIMIT * 2).map((x) => this._item(x)).filter(Boolean);
    const first = !(v.want && v.want.offset);
    if (first) {
      v.items = items;
      if (v.want && v.want.cat !== 'dir') { v.root = str(b.path, 1024); v.rootName = str(b.name, 120); v.path = v.root; }
      else v.path = str(b.path, 1024) || v.path;
    } else {
      const seen = new Set(v.items.map((x) => x.path));
      for (const x of items) if (!seen.has(x.path)) v.items.push(x);
    }
    v.parent = typeof b.parent === 'string' && b.parent ? b.parent.slice(0, 1024) : null;
    v.total = Math.max(num(b.total), v.items.length);
    v.more = b.more === true && items.length > 0;
    v.status = 'ready';
    this._push();
    // thumbnails for what this page brought that aren't known yet
    const want = items.filter((x) => !x.dir && THUMB_KINDS.has(x.kind) && !this.thumbs.has(this._tk(device, x))).slice(0, LIMIT);
    if (want.length) {
      const r = this._ask(device, { items: want.map((x) => ({ path: x.path, mtime: x.mtime, mid: x.mid || 0, mt: x.mt || 0 })) }, 'thumbs', THUMBS_MS);
      if (r.p) r.p.items = new Map(want.map((x) => [x.path, x.mtime || 0]));
    }
  }

  _item(x) {
    if (!x || typeof x !== 'object') return null;
    const p = str(x.path, 1024), name = str(x.name, 255);
    if (!p || !name || !p.startsWith('/') || /[\u0000-\u001f]/.test(p + name)) return null;
    const it = { name, path: p, mtime: num(x.mtime) };
    if (x.dir === true) { it.dir = true; it.count = num(x.count); return it; }
    it.size = num(x.size);
    it.kind = KINDS.has(x.kind) ? x.kind : 'doc';
    const m = /\.([A-Za-z0-9]{1,8})$/.exec(name);
    it.ext = m ? m[1].toLowerCase() : '';
    if (num(x.w) && num(x.h)) { it.w = num(x.w); it.h = num(x.h); }
    if (num(x.dur)) it.dur = num(x.dur);
    if (num(x.mid)) { it.mid = num(x.mid); it.mt = num(x.mt); }
    return it;
  }

  _thumbed(device, p, b) {
    if (!b.thumbs || typeof b.thumbs !== 'object' || !p.items) return;
    const v = this.view;
    const got = {};
    for (const [fp, url] of Object.entries(b.thumbs).slice(0, 40)) {
      if (!p.items.has(fp)) continue;                                 // only what was asked for
      if (typeof url !== 'string' || url.length > THUMB_MAX || !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(url)) continue;
      const key = device + '|' + fp + '|' + p.items.get(fp);
      this.thumbs.delete(key);
      this.thumbs.set(key, url);
      if (v && v.device === device && v.items.some((x) => x.path === fp && this._tk(device, x) === key)) { got[fp] = url; v.sent.add(key); }
    }
    while (this.thumbs.size > THUMB_CACHE) this.thumbs.delete(this.thumbs.keys().next().value);
    if (Object.keys(got).length) this.o.panelSend('panel:browse-thumbs', { device, thumbs: got });
  }

  // ---------------- copying to the PC ----------------
  /** Copy these files (paths from the current listing) into the save folder. */
  pull(paths) {
    const v = this.view;
    if (!v || !v.device || !Array.isArray(paths)) return;
    if (this._running()) { this._note('A copy is already running.'); return; }
    const files = [];
    for (const p of paths.slice(0, PULL_MAX)) {
      const x = typeof p === 'string' && v.items.find((y) => !y.dir && y.path === p);
      if (x && !files.some((f) => f.path === x.path)) files.push({ i: files.length, path: x.path, name: x.name, size: x.size || 0 });
    }
    if (!files.length) return;
    const job = {
      id: rid(), device: v.device, deviceName: v.name, files, done: new Set(), bad: new Map(), state: 'running', at: Date.now(), last: Date.now(),
      cur: null, saved: [], where: '', bytes: files.reduce((n, f) => n + f.size, 0),
    };
    const r = this._ask(v.device, { job: job.id, files: files.map((f) => ({ i: f.i, path: f.path, name: f.name })) }, 'pull', ANSWER_MS);
    if (r.error) { this._note(r.error === 'slow' ? 'Wait a moment, then try again.' : v.name + ' isn’t reachable right now.'); return; }
    r.p.job = job.id;
    const now = Date.now();
    for (const [k, e] of this.ended) if (now - e.at > 30 * 60000) this.ended.delete(k);
    for (const [k, j] of this.jobs) if (j.state !== 'running') { this.ended.set(k, { device: j.device, at: j.end || now }); this.jobs.delete(k); }
    this.jobs.set(job.id, job);
    job.idle = setInterval(() => { if (job.state === 'running' && Date.now() - job.last > PULL_IDLE_MS) this._jobEnd(job.id, 'stalled'); }, 5000);
    if (job.idle.unref) job.idle.unref();
    this.log('copying', files.length, 'file(s) from', v.name);
    this._pushJob();
  }

  /** Stop the running copy: what arrived stays. */
  stop() {
    const job = [...this.jobs.values()].find((j) => j.state === 'running');
    if (!job) return;
    this._ask(job.device, { job: job.id }, 'stop', ANSWER_MS);
    this._jobEnd(job.id, 'stopped');
  }

  _running() { return [...this.jobs.values()].some((j) => j.state === 'running'); }

  _jobNews(device, b) {
    const job = this.jobs.get(b.job);
    if (!job || job.device !== device) return { code: 409, error: 'unknown' };
    if (job.state !== 'running') return { ok: true, stopped: true };     // the phone stops when it reads this
    job.last = Date.now();
    if (b.end === true) { this._jobFinish(job); return { ok: true }; }
    const i = Number.isInteger(b.i) ? b.i : -1;
    if (i >= 0 && i < job.files.length && !job.done.has(i)) {
      if (b.ok === false) {
        job.bad.set(i, str(b.why, 60) || 'error');
        if (job.done.size + job.bad.size >= job.files.length) this._jobFinish(job); else this._pushJob();
        return { ok: true };
      }
      job.cur = { i, sent: num(b.sent), total: num(b.total) || job.files[i].size };
      this._pushSoon();
    }
    return { ok: true };
  }

  /**
   * A quiet upload of kind=pull: a file of a copy this PC asked for? { job, i }; { refuse } for one of a copy that was
   * stopped or is over (the user said no more); null for anything else (then it's an ordinary file sent quietly).
   */
  claim(f) {
    const m = /^pl([0-9a-f]{12})-(\d{1,4})$/.exec(String(f.tid || ''));
    if (!m) return null;
    const job = this.jobs.get(m[1]);
    const over = this.ended.get(m[1]);
    if ((job && job.state !== 'running' && job.device === f.device) || (!job && over && over.device === f.device)) return { refuse: 'stopped' };
    if (!job || job.state !== 'running' || job.device !== f.device) return null;
    const i = +m[2];
    const want = job.files[i];
    if (want && job.done.has(i)) return { refuse: 'have' };              // sent again (a retry): it's here already
    if (!want || want.name !== String(f.name || '')) return null;
    return { job, i };
  }

  /** Saves a claimed file like any received file; resolves the result for the phone. */
  async pulled(f, c) {
    const { job, i } = c;
    job.done.add(i);                        // a second copy of the same file isn't taken
    job.last = Date.now();
    let r;
    try { r = await this.o.saveReceived(f.tmpPath, job.files[i].name); }
    catch (e) { job.done.delete(i); job.bad.set(i, 'save'); this._pushJob(); throw e; }
    job.saved.push(r.path);
    job.where = r.where || job.where;
    if (job.cur && job.cur.i === i) job.cur = null;
    this.o.record({ dir: 'in', name: r.name, path: r.path, size: f.size, device: f.device, deviceName: job.deviceName, how: 'pull' });
    if (job.done.size + job.bad.size >= job.files.length) this._jobFinish(job);
    else this._pushJob();
    return r;
  }

  _jobFinish(job) {
    if (job.state !== 'running') return;
    // the phone said it's done; a file it sent may still be being saved here: wait for it a moment
    const missing = job.files.filter((f) => !job.done.has(f.i) && !job.bad.has(f.i));
    if (!missing.length) { this._jobEnd(job.id, 'done'); return; }
    if (job.finishing) return;
    job.finishing = setTimeout(() => {
      job.finishing = null;
      for (const f of job.files) if (!job.done.has(f.i) && !job.bad.has(f.i)) job.bad.set(f.i, 'missing');
      this._jobEnd(job.id, 'done');
    }, 15000);
  }

  _jobEnd(id, how) {
    const job = this.jobs.get(id);
    if (!job || job.state !== 'running') return;
    clearTimeout(job.finishing); clearInterval(job.idle);
    job.state = how === 'done' ? (job.done.size ? 'done' : 'failed') : how;
    job.end = Date.now();
    job.cur = null;
    this.log('copy from', job.deviceName, job.state + ':', job.done.size, 'of', job.files.length);
    this._pushJob();
    if (job.done.size && !this.o.panelInFront()) {
      const first = job.saved[0];
      this.o.notify({ title: 'Copied from ' + job.deviceName, body: (job.done.size === 1 ? path.basename(first) : job.done.size + ' files') + ' · saved to ' + (job.where || 'your folder'), click: () => this.o.showItem(first) });
    }
  }

  _jobState() {
    const job = [...this.jobs.values()].sort((a, b) => b.at - a.at)[0];
    if (!job) return null;
    const doneBytes = job.files.filter((f) => job.done.has(f.i)).reduce((n, f) => n + f.size, 0) + (job.cur ? Math.min(job.cur.sent, job.cur.total) : 0);
    return {
      id: job.id, state: job.state, n: job.files.length, done: job.done.size, bad: job.bad.size, why: job.bad.size ? [...job.bad.values()][0] : '',
      bytes: job.bytes, doneBytes, where: job.where, deviceName: job.deviceName, current: job.cur ? job.files[job.cur.i].name : '', last: job.saved[job.saved.length - 1] || '',
    };
  }

  /** "Show in folder" for what was copied last. */
  show() {
    const job = [...this.jobs.values()].sort((a, b) => b.at - a.at)[0];
    if (job && job.saved.length) this.o.showItem(job.saved[job.saved.length - 1]);
  }

  _pushSoon() {
    if (this.soonT) return;
    this.soonT = setTimeout(() => { this.soonT = null; this._pushJob(); }, 250);
  }

  _note(text) { this.o.panelSend('panel:note', { text }); }

  /** The phone in use changed or a phone came or went: the view follows. */
  phonesChanged() {
    const v = this.view;
    if (!v) return;
    const t = this.s.eventTarget();
    const old = !!(t && !this.o.hasFeatures(t));
    if (t !== v.device || old !== (v.status === 'old') || (!t) !== (v.status === 'none')) this.open(v.cat);
  }

  shutdown() {
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
    for (const j of this.jobs.values()) { clearTimeout(j.finishing); clearInterval(j.idle); }
    clearTimeout(this.soonT);
  }
}

module.exports = { PhoneBrowse, CATS, LIMIT, PULL_MAX };
