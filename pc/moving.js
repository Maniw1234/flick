'use strict';
// What's moving between this PC and its other devices, both ways, whatever carries it: a phone's fling, files sent to
// a phone, sends to and from other computers and phones with Flick, Quick Share, browsers. One list, which the window's
// Transfers, the progress card on the screen and the taskbar's progress read (main.js), and the one place Cancel goes
// through from there. Pure Node, so it's tested without Electron.
//
//   start(key, { dir: 'in' | 'out', device, deviceName, kind: 'phone' | 'pc' | 'browser' | 'quickshare', name, files,
//                total (-1 or left out: not known yet), cancel })
//       (again for a key that's moving: what's given is taken, the rest stays; a key that ended starts anew)
//   update(key, done, total)   cheap, as often as wanted: 'change' goes out at most every 200 ms
//   current(key, name)         the file of a batch that's going now
//   state(key, s)              'running' | 'waiting' (for an answer: the other side's user, or this one's) | 'paused'
//   end(key, ok, why)          why: null when ok, 'canceled' for a Cancel, else what went wrong ('failed', 'space', ...)
//   onCancel(key, fn | null)   what Cancel does (null: it can't be stopped now). fn returning false: it couldn't be
//   cancel(key)                the user's Cancel: true when it was passed on (the transfer ends once it has stopped)
//   list()                     { now: [items, oldest first], recent: [items that ended, newest first] }
// item: { key, dir, device, deviceName, kind, name, current, files, done, total, rate (bytes/s), state, canCancel,
//         canceling, ok, why, started, ended, age, ago }   (state of one that ended: 'done' | 'canceled' | 'failed')
//   started/ended: the computer's clock (ms), to show; age/ago: ms since it started/ended, on a clock a change of the
//   computer's clock doesn't move, for what waits on them (ago 0 while moving)
// A key it doesn't know is ignored, and a transfer ends once: a second end, or news of it after its end, changes nothing.
const { EventEmitter } = require('events');

const KINDS = ['phone', 'pc', 'browser', 'quickshare'];
const STATES = ['running', 'waiting', 'paused'];
const NAMED = { phone: 'Phone', pc: 'Computer', browser: 'Browser', quickshare: 'Quick Share' };
const MAX_NOW = 1000;              // (a flood of transfers can't grow it for ever: past that, new ones aren't listed)
// Names come from other devices: text only, without control or direction characters (a name can't turn the words
// around it backwards), cut to what can be shown, never in the middle of a character. The zero-width joiner and
// non-joiner stay: emoji like 👨‍👩‍👧 and Persian words are written with them, and they turn nothing around.
const BAD = /[\u0000-\u001f\u007f-\u009f\u061c\u200b\u200e\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g;
function clean(v, max, fallback) {
  if (typeof v !== 'string') return fallback;
  const s = v.slice(0, max * 4).replace(BAD, '').trim().slice(0, max).replace(/[\ud800-\udbff]$/, '').trim();
  return s && /[^\s\u00ad\u034f\u115f\u1160\u17b4\u17b5\u180b-\u180f\u200c\u200d\u2800\u3164\ufe00-\ufe0f\uffa0]/.test(s) ? s : fallback;   // only invisible marks: none
}
const count = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : NaN);

class Moving extends EventEmitter {
  /** opts: { ms: 200 (between 'change's), keepMs: 10 min, keepMax: 30 (finished ones kept), now: () => ms (tests),
   *  wall: () => ms (started/ended; tests) } */
  constructor(opts = {}) {
    super();
    this.ms = opts.ms == null ? 200 : opts.ms;
    this.keepMs = opts.keepMs || 10 * 60000;
    this.keepMax = opts.keepMax || 30;
    // what waits (between 'change's, speed, Canceling..., how long one that ended stays) goes by a clock that the
    // computer's clock being set back or ahead doesn't move; only started/ended, to show, are the computer's clock
    this.clock = opts.now || (() => performance.now());
    this.wall = opts.wall || opts.now || Date.now;
    this.items = new Map();        // key -> what's moving now
    this.recent = [];              // what ended, newest first
    this.t = null;
    this.last = -Infinity;      // (when the last 'change' went: none yet, so the first goes at once)
  }

  start(key, o) {
    if (typeof key !== 'string' || !key || key.length > 300) return;
    const it = this.items.get(key);
    if (it) { this._take(it, o || {}); this._changed(); return; }
    if (this.items.size >= MAX_NOW) return;
    // a key that ended and starts again ("Try again" on a phone keeps its transfer's id) is a transfer of its own
    this.recent = this.recent.filter((x) => x.key !== key);
    const now = this.clock();
    const fresh = { key, dir: 'in', device: '', deviceName: '', kind: 'phone', name: 'File', current: '', files: 1, done: 0, total: -1,
      rate: 0, state: 'running', canceling: 0, ok: null, why: null, started: this.wall(), ended: 0, t0: now, t1: 0, cancel: null, rt: null, rs: 0, moved: now };
    this._take(fresh, o || {}, true);
    this.items.set(key, fresh);
    this._changed();
  }

  // what start() was told about a transfer (all of it the first time; later only what's given)
  _take(it, o, first) {
    const has = (k) => first || Object.prototype.hasOwnProperty.call(o, k);
    if (has('dir')) it.dir = o.dir === 'out' ? 'out' : 'in';
    if (has('kind')) it.kind = KINDS.includes(o.kind) ? o.kind : 'pc';
    if (has('device')) it.device = typeof o.device === 'string' ? o.device.slice(0, 100) : '';
    if (has('deviceName') || has('kind')) it.deviceName = clean(has('deviceName') ? o.deviceName : it.deviceName, 60, NAMED[it.kind]);
    if (has('name')) it.name = clean(o.name, 200, it.name || 'File');
    if (has('files')) { const n = count(o.files); it.files = n >= 1 ? Math.floor(n) : 1; }
    if (has('total')) { const n = count(o.total); it.total = n >= 0 ? Math.floor(n) : -1; }
    if (has('cancel')) it.cancel = typeof o.cancel === 'function' ? o.cancel : null;
  }

  update(key, done, total) {
    const it = this.items.get(key);
    if (!it) return;
    const t = count(total);
    if (t >= 0) it.total = Math.floor(t);
    const d = count(done);
    if (!(d >= 0)) { this._changed(); return; }
    // (a sender that counts again what it sends again, or ranges fetched twice, can't make it more than all of it)
    const now = this.clock();
    const v = it.total >= 0 ? Math.min(d, it.total) : d;
    if (v < it.done) { it.rt = now; it.rs = v; it.rate = 0; }          // it started over: the speed starts over too
    if (v > it.done) it.moved = now;
    it.done = v;
    // speed: what came over the last half second or more, smoothed (a burst or a pause doesn't swing it about)
    if (it.rt === null) { it.rt = now; it.rs = v; }
    else if (now - it.rt >= 500) {
      const inst = Math.max(0, v - it.rs) / ((now - it.rt) / 1000);
      it.rate = it.rate ? it.rate * 0.7 + inst * 0.3 : inst;
      it.rt = now; it.rs = v;
    }
    this._changed();
  }

  current(key, name) {
    const it = this.items.get(key);
    if (!it) return;
    const n = clean(name, 200, '');
    if (n === it.current) return;
    it.current = n;
    this._changed();
  }

  state(key, s) {
    const it = this.items.get(key);
    if (!it || !STATES.includes(s) || it.state === s) return;
    it.state = s;
    if (s !== 'running') it.rate = 0;
    it.rt = null;
    this._changed();
  }

  onCancel(key, fn) {
    const it = this.items.get(key);
    if (!it) return;
    it.cancel = typeof fn === 'function' ? fn : null;
    if (!it.cancel) it.canceling = 0;
    this._changed();
  }

  cancel(key) {
    const it = this.items.get(key);
    if (!it || !it.cancel || this._canceling(it)) return false;
    let r;
    try { r = it.cancel(); } catch (e) { r = false; }
    if (r === false || !this.items.has(key)) return r !== false;      // (it may have ended at once)
    it.canceling = this.clock();
    this._changed();
    return true;
  }
  // a Cancel that's on its way (one that came to nothing in 15 s can be tried again)
  _canceling(it) { return !!it.canceling && this.clock() - it.canceling < 15000; }

  end(key, ok, why) {
    const it = this.items.get(key);
    if (!it) return;
    this.items.delete(key);
    const now = this.clock();
    it.ok = !!ok;
    it.why = ok ? null : clean(why, 40, 'failed');
    it.state = ok ? 'done' : it.why === 'canceled' ? 'canceled' : 'failed';
    it.ended = this.wall(); it.t1 = now;
    it.cancel = null; it.canceling = 0; it.rate = 0; it.current = '';
    if (ok) { if (it.total >= 0) it.done = it.total; else it.total = it.done; }
    this.recent = [it].concat(this.recent.filter((x) => x.key !== key));
    this._prune(now);
    this._changed();
  }

  _prune(now) {
    if (this.recent.length > this.keepMax) this.recent.length = this.keepMax;
    while (this.recent.length && now - this.recent[this.recent.length - 1].t1 > this.keepMs) this.recent.pop();
  }

  _pub(x, now) {
    const moving = !x.ended;
    return {
      key: x.key, dir: x.dir, device: x.device, deviceName: x.deviceName, kind: x.kind, name: x.name, current: x.current, files: x.files,
      done: x.done, total: x.total,
      // (nothing came for a few seconds: no speed to speak of)
      rate: moving && x.state === 'running' && now - x.moved < 3000 ? Math.round(x.rate) : 0,
      state: x.state, canCancel: moving && !!x.cancel, canceling: moving && this._canceling(x), ok: x.ok, why: x.why, started: x.started, ended: x.ended,
      age: Math.max(0, now - x.t0), ago: moving ? 0 : Math.max(0, now - x.t1),
    };
  }

  list() {
    const now = this.clock();
    this._prune(now);
    return { now: [...this.items.values()].map((x) => this._pub(x, now)), recent: this.recent.map((x) => this._pub(x, now)) };
  }

  /** Whether a transfer with this key is moving now. */
  has(key) { return this.items.has(key); }

  // 'change' at most every this.ms: the first change after a quiet moment goes out at once, the rest follow together
  _changed() {
    if (this.t) return;
    const wait = Math.max(0, this.last + this.ms - this.clock());
    this.t = setTimeout(() => { this.t = null; this.last = this.clock(); this.emit('change'); }, wait);
    if (this.t.unref) this.t.unref();
  }
}

module.exports = { Moving, clean };
