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
  id: 'PLACEHOLDER_FORM_ID',        // the long id between /forms/d/e/ and /viewform
  type: 'entry.PLACEHOLDER_TYPE',   // "Bug" or "Idea" (a multiple-choice question with exactly those two choices)
  message: 'entry.PLACEHOLDER_MESSAGE',
  email: 'entry.PLACEHOLDER_EMAIL',
  device: 'entry.PLACEHOLDER_DEVICE',   // app version and Windows version (empty when the user unticks it)
};
// ======================================================================================================================

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const MESSAGE_MAX = 5000;
const OUTBOX_MAX = 20;
const RETRY_MS = 5 * 60 * 1000;

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
    this.outbox = this._load();
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

  info() { return { ready: this.ready, device: this.deviceInfo(), waiting: this.outbox.length }; }

  _load() {
    try {
      const a = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (Array.isArray(a)) return a.filter((x) => x && typeof x.message === 'string' && x.message).slice(0, OUTBOX_MAX);
    } catch (e) { /* nothing waits */ }
    return [];
  }

  _save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      if (!this.outbox.length) { fs.rmSync(this.file, { force: true }); return; }
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.outbox));
      fs.renameSync(tmp, this.file);
    } catch (e) { this.log('feedback not kept: ' + e.message); }
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
        this._save();
        if (r === 'ok' && this.o.onSent) this.o.onSent(item);
      }
    } finally { this.busy = false; }
  }

  stop() { clearInterval(this.timer); }
}

module.exports = { Feedback, FORM, ready, formUrl, windowsName };
