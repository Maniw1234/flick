'use strict';
// The clipboard read straight from the X server (X11, or XWayland), with a connection of Flick's own for each read.
// Used only on Linux while Electron's clipboard isn't answering (clipfiles.js): a program that copied and then quit
// (or hung) while Electron asked it leaves Electron's clipboard waiting for good, and every later read behind it, so
// copied files, the send shortcut and clipboard sync would stay dead until Flick restarted. A read here has its own
// time limit and its own connection, closed after it: one that isn't answered costs only itself.
// What's read is the CLIPBOARD selection, as xclip -o does (ICCCM: ConvertSelection, then the property it lands in;
// large ones come in pieces, INCR).
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX = 8 * 1024 * 1024;          // the most read of one thing (a clipboard picture is sent at most 6 MB)
// The program (its window) that had the clipboard when a read wasn't answered in time. While it still has it, it's
// given only a moment: one that hung isn't waited for again and again (the send shortcut answers at once), and one
// that answers after all (or a new program given the same window number) is read as before.
let stuck = 0;
const STUCK_MS = 300;

// DISPLAY ":1", ":1.0", "unix:1", "localhost:10.0" -> where to connect, and the display's number
function where(display) {
  const m = /^([^:]*):(\d+)(?:\.\d+)?$/.exec(String(display || ''));
  if (!m) return null;
  const host = m[1], n = +m[2];
  if (!host || host === 'unix') return { n, local: true, path: '/tmp/.X11-unix/X' + n };
  return { n, local: false, host, port: 6000 + n };
}

// The cookie the X server wants (MIT-MAGIC-COOKIE-1 from XAUTHORITY or ~/.Xauthority), or none
function cookie(w) {
  let b;
  try { b = fs.readFileSync(process.env.XAUTHORITY || path.join(os.homedir(), '.Xauthority')); } catch (e) { return null; }
  const host = os.hostname();
  let off = 0, any = null;
  const str = () => { if (off + 2 > b.length) throw new Error('short'); const l = b.readUInt16BE(off); const s = b.subarray(off + 2, off + 2 + l); off += 2 + l; return s; };
  try {
    while (off + 2 <= b.length) {
      const family = b.readUInt16BE(off); off += 2;
      const addr = str().toString('latin1'), num = str().toString('latin1'), name = str().toString('latin1'), data = Buffer.from(str());
      if (name !== 'MIT-MAGIC-COOKIE-1' || (num && num !== String(w.n))) continue;
      // FamilyLocal (256) for this computer's name, FamilyWild (65535); over TCP, the first for that display
      if (family === 65535 || (family === 256 && addr === host)) return { name, data };
      if (!any) any = { name, data };
    }
  } catch (e) { /* a damaged file: what was found so far */ }
  return any;
}

const pad = (n) => (4 - (n % 4)) % 4;
const fail = (what) => Object.assign(new Error('X clipboard: ' + what), { code: 'ECLIPX' });

// One connection: requests and their replies, and the events that come
class Conn {
  constructor(sock) {
    this.sock = sock; this.buf = Buffer.alloc(0); this.seq = 0; this.wait = new Map(); this.events = []; this.onEvent = null;
    this.setup = null; this.dead = null;
    sock.on('data', (d) => { this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d; this._read(); });
    const gone = (e) => this._fail(e || fail('closed'));
    sock.on('error', gone); sock.on('close', () => gone());
  }
  _fail(e) {
    if (this.dead) return;
    this.dead = e;
    for (const w of this.wait.values()) w.reject(e);
    this.wait.clear();
    if (this.setupWait) this.setupWait.reject(e);
    if (this.onEvent) this.onEvent(null);
  }
  _read() {
    if (!this.setup) {
      if (this.buf.length < 8) return;
      const len = 8 + this.buf.readUInt16LE(6) * 4;
      if (this.buf.length < len) return;
      const b = this.buf.subarray(0, len); this.buf = this.buf.subarray(len);
      if (b[0] !== 1) { this._fail(fail('not allowed by the X server')); return; }
      const vlen = b.readUInt16LE(24), nfmt = b[29];
      const screen = 40 + vlen + pad(vlen) + 8 * nfmt;
      if (b.length < screen + 4) { this._fail(fail('bad setup')); return; }
      this.setup = { base: b.readUInt32LE(12), root: b.readUInt32LE(screen) };
      if (this.setupWait) this.setupWait.resolve();
    }
    while (this.buf.length >= 32) {
      const t = this.buf[0];
      let len = 32;
      if (t === 1) len = 32 + this.buf.readUInt32LE(4) * 4;
      // (no answer to what's asked here is longer than MAX: one that says it is isn't kept while it comes)
      if (len > MAX + 64) { this._fail(fail('answer too large')); return; }
      if (this.buf.length < len) return;
      const b = this.buf.subarray(0, len); this.buf = this.buf.subarray(len);
      if (t === 1 || t === 0) {
        const seq = b.readUInt16LE(2), w = this.wait.get(seq);
        if (w) { this.wait.delete(seq); if (t === 1) w.resolve(b); else w.reject(fail('error ' + b[1])); }
        else if (t === 0) this._fail(fail('error ' + b[1]));       // (of a request with no reply: CreateWindow, ConvertSelection)
      } else {
        this.events.push(b);
        if (this.onEvent) this.onEvent(b);
      }
    }
  }
  ready() { return this.setup ? Promise.resolve() : new Promise((resolve, reject) => { this.setupWait = { resolve, reject }; }); }
  // a request; its reply (reply: true) as a promise
  req(b, reply) {
    if (this.dead) return Promise.reject(this.dead);
    this.seq = (this.seq + 1) & 0xffff;
    this.sock.write(b);
    if (!reply) return null;
    return new Promise((resolve, reject) => { this.wait.set(this.seq, { resolve, reject }); });
  }
  // the next event that fits, or null when the connection went
  next(fits) {
    const i = this.events.findIndex(fits);
    if (i >= 0) return Promise.resolve(this.events.splice(i, 1)[0]);
    if (this.dead) return Promise.resolve(null);
    return new Promise((resolve) => {
      this.onEvent = (e) => {
        if (e === null) { this.onEvent = null; resolve(null); return; }
        if (!fits(e)) return;
        this.events.splice(this.events.indexOf(e), 1); this.onEvent = null; resolve(e);
      };
    });
  }
  atom(name, onlyIfExists) {
    const n = Buffer.from(name, 'latin1');
    const b = Buffer.alloc(8 + n.length + pad(n.length));
    b[0] = 16; b[1] = onlyIfExists ? 1 : 0; b.writeUInt16LE(b.length / 4, 2); b.writeUInt16LE(n.length, 4); n.copy(b, 8);
    return this.req(b, true).then((r) => r.readUInt32LE(8));
  }
  selOwner(sel) {
    const b = Buffer.alloc(8); b[0] = 23; b.writeUInt16LE(2, 2); b.writeUInt32LE(sel, 4);
    return this.req(b, true).then((r) => { this.owner = r.readUInt32LE(8); return this.owner; });
  }
  atomName(a) {
    const b = Buffer.alloc(8); b[0] = 17; b.writeUInt16LE(2, 2); b.writeUInt32LE(a, 4);
    return this.req(b, true).then((r) => r.subarray(32, 32 + r.readUInt16LE(8)).toString('latin1'));
  }
  window() {
    const wid = this.setup.base | 1;
    const b = Buffer.alloc(36);
    b[0] = 1; b[1] = 0; b.writeUInt16LE(9, 2); b.writeUInt32LE(wid, 4); b.writeUInt32LE(this.setup.root, 8);
    b.writeUInt16LE(1, 16); b.writeUInt16LE(1, 18); b.writeUInt16LE(2, 22);   // 1x1, InputOnly
    b.writeUInt32LE(0x800, 28); b.writeUInt32LE(0x400000, 32);              // its events: PropertyChange (INCR)
    this.req(b, false);
    return wid;
  }
  convert(win, sel, target, prop) {
    const b = Buffer.alloc(24); b[0] = 24; b.writeUInt16LE(6, 2);
    b.writeUInt32LE(win, 4); b.writeUInt32LE(sel, 8); b.writeUInt32LE(target, 12); b.writeUInt32LE(prop, 16);
    this.req(b, false);
  }
  // the property, deleted as it's read: { type, format, data, more }
  take(win, prop) {
    const b = Buffer.alloc(24); b[0] = 20; b[1] = 1; b.writeUInt16LE(6, 2);
    b.writeUInt32LE(win, 4); b.writeUInt32LE(prop, 8); b.writeUInt32LE(MAX / 4, 20);
    return this.req(b, true).then((r) => {
      const format = r[1], n = r.readUInt32LE(16) * (format / 8);
      return { type: r.readUInt32LE(8), format, more: r.readUInt32LE(12), data: Buffer.from(r.subarray(32, 32 + n)) };
    });
  }
}

// Runs job(conn) on a new connection to the X server, with a time limit for all of it; the connection is closed after
function session(job, ms, display) {
  const w = where(display === undefined ? process.env.DISPLAY : display);
  if (!w) return Promise.reject(fail('no X display'));
  return new Promise((resolve, reject) => {
    let sock, c = null, done = false, t = null;
    const t0 = performance.now();
    const end = (e, v) => {
      if (done) return;
      done = true; clearTimeout(t);
      if (e && e.late && c && c.owner) stuck = c.owner;
      try { sock.destroy(); } catch (x) { /* gone */ }
      if (e) reject(e); else resolve(v);
    };
    const late = () => end(Object.assign(fail('no answer in time'), { late: true }));
    t = setTimeout(late, ms);
    const start = (opts, again) => {
      sock = net.connect(opts);
      c = new Conn(sock);
      c.shorten = (m) => { clearTimeout(t); t = setTimeout(late, m); };
      c.unshorten = () => { clearTimeout(t); t = setTimeout(late, Math.max(0, t0 + ms - performance.now())); };
      sock.once('connect', () => {
        const a = cookie(w);
        const name = a ? Buffer.from(a.name, 'latin1') : Buffer.alloc(0), data = a ? a.data : Buffer.alloc(0);
        const h = Buffer.alloc(12 + name.length + pad(name.length) + data.length + pad(data.length));
        h[0] = 0x6c; h.writeUInt16LE(11, 2); h.writeUInt16LE(name.length, 6); h.writeUInt16LE(data.length, 8);
        name.copy(h, 12); data.copy(h, 12 + name.length + pad(name.length));
        sock.write(h);
        c.ready().then(() => job(c)).then((v) => end(null, v), (e) => end(e));
      });
      // (Linux: the X server's socket may be only in the abstract namespace)
      sock.once('error', (e) => { if (!c.setup && again) { try { sock.destroy(); } catch (x) { /* */ } start(again, null); } else end(e); });
    };
    if (w.local) start({ path: w.path }, process.platform === 'linux' ? { path: '\0' + w.path } : null);
    else start({ host: w.host, port: w.port }, null);
  });
}

// The selection converted to one target: { type (name), data } or null (nothing copied, or not as that)
async function convertOn(c, targetName) {
  const [sel, target, prop, incr] = await Promise.all([c.atom('CLIPBOARD'), c.atom(targetName), c.atom('FLICK_CLIP'), c.atom('INCR')]);
  if (!(await c.selOwner(sel))) return null;                                                                // nothing copied
  if (c.owner === stuck) c.shorten(STUCK_MS);
  const win = c.win || (c.win = c.window());
  c.convert(win, sel, target, prop);
  const ev = await c.next((e) => (e[0] & 0x7f) === 31 && e.readUInt32LE(8) === win);        // SelectionNotify
  if (!ev) throw fail('closed');
  if (c.owner === stuck) { stuck = 0; c.unshorten(); }      // (it answers again: the rest of the read has its own time)
  if (ev.readUInt32LE(20) === 0) return null;                                              // refused (property None)
  // (the property's news so far, its INCR being put there among them, came before it's taken: not a piece. Dropped
  // now, not once the answer is in: the first piece's news can come in the same read as that answer)
  const isProp = (e) => (e[0] & 0x7f) === 28 && e.readUInt32LE(4) === win && e.readUInt32LE(8) === prop;
  c.events = c.events.filter((e) => !isProp(e));
  let r = await c.take(win, prop);
  if (r.type === incr) {
    // in pieces: each one appears on the property (PropertyNotify, NewValue) after the last was taken; an empty one ends
    const parts = []; let size = 0;
    for (;;) {
      const pe = await c.next((e) => isProp(e) && e[16] === 0);
      if (!pe) throw fail('closed');
      r = await c.take(win, prop);
      if (!r.data.length) break;
      size += r.data.length;
      if (size > MAX) return null;
      parts.push(r.data);
    }
    return { data: Buffer.concat(parts) };
  }
  if (r.more) return null;                                                                  // (larger than MAX)
  return { data: r.data };
}

// the targets (formats) on offer now, by name
async function targetsOn(c) {
  const r = await convertOn(c, 'TARGETS');
  if (!r) return [];
  const atoms = [];
  for (let i = 0; i + 4 <= r.data.length && atoms.length < 200; i += 4) atoms.push(r.data.readUInt32LE(i));
  return Promise.all(atoms.map((a) => c.atomName(a).catch(() => '')));
}

/** The clipboard as Electron's is used (has / readText / read), read from the X server. names: Electron's name of a
 * format -> the X server's (x-special/gnome-copied-files has a name of Electron's own). Each call: ms at most. */
function clipboard(opts) {
  const o = opts || {}, ms = o.ms || 2000, display = o.display;
  const toX = (n) => (o.names && o.names[n]) || n;
  const fromX = (x) => { for (const k of Object.keys(o.names || {})) if (o.names[k] === x) return k; return x; };
  return {
    has: (f) => session((c) => targetsOn(c), ms, display).then((ts) => ts.includes(toX(f))),
    readText: () => session(async (c) => (await convertOn(c, 'UTF8_STRING')) || (await convertOn(c, 'STRING')), ms, display)
      .then((r) => (r ? r.data.toString('utf8') : '')),
    read: () => session((c) => targetsOn(c), ms, display).then((ts) => [{
      types: ts.filter(Boolean).map(fromX),
      getType: (t) => session((c) => convertOn(c, toX(t)), ms, display).then((r) => (r ? r.data : Buffer.alloc(0))),
    }]),
  };
}

/** Does a compositing manager run on the display's screen (it owns the selection _NET_WM_CM_S<screen>, as EWMH says)?
 * Only then can a window there be see-through. true or false; an error when the X server couldn't be asked. */
function composited(opts) {
  const o = opts || {}, display = o.display === undefined ? process.env.DISPLAY : o.display;
  const m = /:\d+\.(\d+)$/.exec(String(display || ''));
  return session(async (c) => {
    const sel = await c.atom('_NET_WM_CM_S' + (m ? +m[1] : 0), true);
    return sel !== 0 && (await c.selOwner(sel)) !== 0;          // (no such name yet: no compositor ever ran)
  }, o.ms || 1000, display);
}

/** Is there an X display to read from? */
const usable = () => process.platform === 'linux' && !!where(process.env.DISPLAY);

module.exports = { clipboard, composited, usable, where };
