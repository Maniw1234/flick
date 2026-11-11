'use strict';
// Send feedback (the PC window: Send feedback). A bug report or an idea, an optional email address and, if the user
// leaves it ticked, the device info shown under the box, posted to a Google Form (application/x-www-form-urlencoded to
// .../formResponse, one entry.<id> per field). Nothing is sent but what the window shows. Without a connection the
// message waits in userData/feedback-outbox.json and goes later; the user is told when it went.

// ======================================================================================================================
// THE GOOGLE FORM. Fill these in from the form's pre-filled link (Form > ... > Get pre-filled link: the address it
// gives has /forms/d/e/<FORM_ID>/viewform and one entry.<number>=... per question). The phone app has the same block in
// android/src/com/flick/app/FeedbackForm.java. While FORM_ID is the placeholder, the window says feedback isn't set up
// yet and nothing is sent.
const FORM = {
  // the long id between /forms/d/e/ and /viewform
  id: '1FAIpQLScAFSO2yq4_jbLiibQxTC_76whukL88i0pqRyAApD0KPK5-iA',
  type: 'entry.749821100',   // "Bug" or "Idea" (a multiple-choice question with exactly those two choices)
  message: 'entry.263938692',
  email: 'entry.284337267',
  device: 'entry.827076895',   // app version and Windows version (empty when the user unticks it)
};
// ======================================================================================================================

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const MESSAGE_MAX = 5000;
const OUTBOX_MAX = 20;
const RETRY_MS = 5 * 60 * 1000;
const sleepSync = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (e) { /* ignore */ } };
const HELD = 'held';                            // a file that's there but can't be read now (see _load)
const HELD_WAITS = [50, 100, 200, 300, 350];    // (about a second)

const ready = (f) => !/PLACEHOLDER/.test(f.id + f.type + f.message + f.email + f.device);
const formUrl = (f) => 'https://docs.google.com/forms/d/e/' + encodeURIComponent(f.id) + '/formResponse';

/** "Windows 11 Pro (10.0.22631)": Node names Windows 11 "Windows 10" (the registry still says so), the build doesn't lie. */
function windowsName() {
  const rel = os.release();
  if (process.platform !== 'win32') return os.type() + ' ' + rel;
  let v = '';
  try { v = os.version() || ''; } catch (e) { v = ''; }
  const build = +String(rel).split('.')[2] || 0;
  if (!v) v = 'Windows';
  if (build >= 22000) v = v.replace(/Windows 10/, 'Windows 11');
  return v + ' (' + rel + ')';
}

class Feedback {
  /**
   * o: { version, userDir, log(), fetch(url, opts), onSent(item) (a message that waited went), testUrl (FLICK_TEST
   *      only: a local stand-in for Google; the placeholders are then allowed) }
   */
  constructor(o) {
    this.o = o;
    this.log = o.log || (() => {});
    this.file = path.join(o.userDir, 'feedback-outbox.json');
    this.refusedFile = path.join(o.userDir, 'feedback-refused.json');
    this.rereadMs = o.rereadMs || 2000;
    this.outbox = this._load();
    this._refused = this._loadRefused();
    this.busy = false;
    this.timer = setInterval(() => { if (this.outbox.length) this.flush(); }, RETRY_MS);
    if (this.timer.unref) this.timer.unref();
    if (this.outbox.length) setTimeout(() => this.flush(), 30000).unref();
  }

  get form() { return FORM; }
  get ready() { return !!this.o.testUrl || ready(FORM); }
  _url() { return this.o.testUrl || formUrl(FORM); }

  /** What the window shows next to "Include device info": exactly what goes in that field. */
  deviceInfo() { return 'Flick ' + this.o.version + ' · ' + windowsName() + ' · ' + os.arch(); }

  info() {
    const r = this.refused;
    return { ready: this.ready, device: this.deviceInfo(), waiting: this.outbox.length, refused: r ? { type: r.type, message: r.message, email: r.email } : null };
  }

  // The messages waiting. A file that's there but can't be read now (Windows: held a moment by an antivirus, a backup or
  // sync program; EMFILE, EIO) is tried again for about a second, then left as it is: nothing is written over it until
  // it reads (_reread), when what this run kept goes with it. (None, or damaged: nothing waits.)
  _load() {
    const a = this._readDisk(HELD_WAITS);
    if (a !== HELD) return a;
    this.held = true;
    this.log('feedback: the messages waiting could not be read now: kept as they are, read again in a moment');
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
      if (Array.isArray(a)) return a.filter((x) => x && typeof x.message === 'string' && x.message).slice(0, OUTBOX_MAX);
    } catch (e) { /* damaged */ }
    return [];
  }

  _reread() {
    this.rereadT = setTimeout(() => {
      this.rereadT = null;
      this.rereadTries = (this.rereadTries || 0) + 1;
      if (!this._tryRead()) this._reread();
    }, Math.min(60000, this.rereadMs * 2 ** Math.min(6, this.rereadTries || 0)));
    if (this.rereadT.unref) this.rereadT.unref();
  }

  // the waiting messages read at last: those on disk first (older), then this run's; written if this run kept any
  _tryRead() {
    if (!this.held) return true;
    const disk = this._readDisk([]);
    if (disk === HELD) return false;
    this.held = false;
    clearTimeout(this.rereadT); this.rereadT = null;
    const mine = this.outbox, ids = new Set(mine.map((x) => x.id)), sent = this.heldSent || new Set();
    this.outbox = disk.filter((x) => !ids.has(x.id) && !sent.has(x.id)).concat(mine).slice(-OUTBOX_MAX);
    this.heldSent = null;
    if (mine.length || sent.size) this._save();
    this.log('feedback: the messages waiting were read now');
    if (this.outbox.length && !this.busy) setTimeout(() => this.flush(), 1000).unref();
    return true;
  }

  _save() {
    if (this.held) { this._tryRead(); return; }     // (never written over while it can't be read: see _load; once it reads, written there)
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      if (!this.outbox.length) { fs.rmSync(this.file, { force: true }); return; }
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.outbox));
      fs.renameSync(tmp, this.file);
    } catch (e) { this.log('feedback not kept: ' + e.message); }
  }

  // A waiting message the form refused, offered back in Send feedback until the window has put it back in the form: on
  // disk, so a restart before the user opens the window (an update, a reboot) doesn't lose the text
  get refused() { return this._refused; }
  set refused(item) {
    this._refused = item || null;
    try {
      if (!item) { fs.rmSync(this.refusedFile, { force: true }); return; }
      fs.mkdirSync(path.dirname(this.refusedFile), { recursive: true });
      const tmp = this.refusedFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(item));
      fs.renameSync(tmp, this.refusedFile);
    } catch (e) { this.log('feedback: the refused message not kept: ' + e.message); }
  }

  _loadRefused() {
    try {
      const x = JSON.parse(fs.readFileSync(this.refusedFile, 'utf8'));
      if (x && typeof x === 'object' && typeof x.message === 'string' && x.message) return x;
    } catch (e) { /* none */ }
    return null;
  }

  /** The form's fields from what the user filled in: the device info only if it was left ticked. */
  fields(m) {
    const type = m.type === 'idea' ? 'Idea' : 'Bug';
    const f = {};
    f[FORM.type] = type;
    f[FORM.message] = String(m.message || '').slice(0, MESSAGE_MAX);
    f[FORM.email] = String(m.email || '').trim().slice(0, 200);
    f[FORM.device] = m.device ? String(m.deviceText || this.deviceInfo()).slice(0, 2000) : '';
    return f;
  }

  /**
   * Sends it now, or keeps it for later when there's no connection. m: { type: 'bug'|'idea', message, email, device }.
   * Resolves { ok: true } (sent), { ok: false, queued: true } (kept, goes later) or { ok: false, why } (not sent).
   */
  async send(m) {
    if (!this.ready) return { ok: false, why: 'not set up' };
    const message = String((m && m.message) || '').trim();
    if (!message) return { ok: false, why: 'empty' };
    const email = String((m && m.email) || '').trim();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, why: 'email' };
    const item = { id: crypto.randomBytes(6).toString('hex'), at: Date.now(), type: m.type === 'idea' ? 'idea' : 'bug', message: message.slice(0, MESSAGE_MAX), email, device: !!m.device };
    if (item.device) item.deviceText = this.deviceInfo();     // what the user saw, kept with it if it has to wait
    const r = await this._post(item);
    if (r === 'ok') return { ok: true };
    if (r === 'refused') return { ok: false, why: 'refused' };
    this.outbox.push(item);
    this.outbox = this.outbox.slice(-OUTBOX_MAX);
    this._save();
    return { ok: false, queued: true };
  }

  // 'ok' | 'refused' (the form said no: sending again won't help) | 'offline'
  async _post(item) {
    const body = new URLSearchParams(this.fields(item)).toString();
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 20000);
      let res;
      try {
        res = await this.o.fetch(this._url(), { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body, signal: ctl.signal });
        try { await res.arrayBuffer(); } catch (e) { /* the page Google answers with isn't needed */ }
      } finally { clearTimeout(t); }
      // a form that wants a Google sign-in sends the post to the sign-in page: that isn't a response
      let host = '';
      try { host = new URL(res.url || this._url()).hostname; } catch (e) { host = ''; }
      if (res.status >= 200 && res.status < 300 && host !== 'accounts.google.com') return 'ok';
      this.log('feedback: the form answered ' + res.status + (host === 'accounts.google.com' ? ' (it needs a sign-in)' : ''));
      return res.status >= 500 || res.status === 429 || res.status === 408 ? 'offline' : 'refused';
    } catch (e) {
      this.log('feedback: not sent now (' + (e && e.message) + ')');
      return 'offline';
    }
  }

  /** Messages that waited: tried again (on a timer, and when the window opens the form). */
  async flush() {
    if (this.busy || !this.outbox.length || !this.ready) return;
    this.busy = true;
    try {
      for (const item of this.outbox.slice()) {
        const r = await this._post(item);
        if (r === 'offline') break;
        this.outbox = this.outbox.filter((x) => x.id !== item.id);
        if (this.held) (this.heldSent = this.heldSent || new Set()).add(item.id);
        this._save();
        if (r === 'ok' && this.o.onSent) this.o.onSent(item);
        // (the form doesn't take it: sending it again won't help. The user, told it would go, is told it didn't, and
        // finds it back in the form, not lost)
        if (r === 'refused') { this.refused = item; if (this.o.onRefused) this.o.onRefused(item); }
      }
    } finally { this.busy = false; }
  }

  stop() { clearInterval(this.timer); clearTimeout(this.rereadT); }
}

module.exports = { Feedback, FORM, ready, formUrl, windowsName };
