'use strict';
// The phone features on the PC: the desktop side of what server.js / phoneapi.js receive. Several phones and which one
// is in use, clipboard sync (clip.js), links both ways, phone notifications as Windows notifications, the media remote
// (keys.js), "Find my phone", files sent quietly, folder sync (sync.js), the transfer history (history.js), a tray
// item, and the panel's new sections (panel/features.js). main.js attaches it with one call and a few one-line hooks.
const fs = require('fs');
const path = require('path');
const { History } = require('./history');
const { SyncStore } = require('./sync');
const { ClipWatch } = require('./clip');
const { MediaKeys } = require('./keys');
const { cleanUrl, URL_MAX } = require('./phoneapi');
const NOT_LINK = 'That isn’t a web link. Links start with http:// or https://.';
// a link the user gives is read up to this long (a map route, a tracking link), to say it's too long rather than not a link
const LINK_READ_MAX = 64 * 1024;
const { ClipHistory } = require('./cliphist');
const { PhoneBrowse } = require('./browse');
const { AcceptGate } = require('./ask');

const FEATURES_CODE = 20000;    // phone app version code (hello `app`) from which a phone has these features
const RING_SEC = 30;
const SETTINGS = ['clipSync', 'openLinks', 'phoneNotify', 'clipHistory'];   // on unless turned off (store[k] !== false)
const QUIET_WHAT = { screenshot: 'Screenshot', photo: 'Photo' };
const PEER_PNG_MAX = 4400 * 1024;   // a clipboard picture to another device: what it takes (server.js, PeerServer.java)
// the clipboard didn't answer in time (clipfiles.js ask: on Linux, until the program that has it answers, or Flick restarts)
const CLIP_WAIT = 'Flick can’t read the clipboard: the program you copied from isn’t answering. If this goes on, quit Flick and open it again.';

/** What to say when something didn't reach another device (peerlink.js message's why). */
function peerWhy(why, nm) {
  if (why === 'old') return 'Update Flick on ' + nm + ' first.';
  if (why === 'unpaired') return nm + ' isn’t paired with this computer any more.';
  if (why === 'auth') return nm + ' doesn’t know this computer any more. Remove it and pair again.';
  if (why === 'busy') return 'That was a lot at once. Try again in a minute.';
  if (why === 'off') return nm + ' doesn’t take clipboards: it’s turned off there.';
  if (why === 'too big') return 'That’s too big to send.';
  if (why === 'empty' || why === 'bad' || why === 'refused') return nm + ' couldn’t take that.';
  return 'Couldn’t reach ' + nm + '. Make sure Flick is open on it.';
}

/**
 * A notification's text as Linux's notification server is to show it: there the body is markup (Electron hands it on
 * as it is), so a phone app's notification with <a href=…> showed as a link to click, <b> as bold, and an "&" could
 * leave it blank. Windows and macOS show the text as it is.
 */
function noMarkup(s) {
  return process.platform === 'linux' ? s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') : s;
}

class Features {
  /**
   * o: { electron, server, store, saveStore(), log(), userDir, appDir, testMode,
   *      saveReceived(tmp, name) -> { name, path, where }  (main.js webSave: the same rules as every received file)
   *      saveDirNow(), markOfWeb(file), openAfterArrival(file), panelSend(ch, data), getPanel(), sendFiles(paths),
   *      updateTray() }
   */
  constructor(o) {
    this.o = o;
    this.server = o.server;
    this.store = o.store;
    this.log = o.log || (() => {});
    this.el = o.electron || {};
    this.shown = [];            // the last notifications shown (the test control reads them)
    this.live = new Set();      // notifications on screen (kept referenced so their clicks still work)
    this.notes = new Map();     // "device|key" -> the Windows notification of a phone notification
    this.media = [];            // the last media keys asked for
    this.ringing = null;
    this.peerLinks = [];        // links other devices sent lately (the test control reads them)

    // The window's History view follows what's added while it's open (a big folder sync changes it all the time); it asks
    // for a fresh copy when it opens. Otherwise only the summary on the main view goes, with every state: the list of 200
    // with each file looked up on the disk was sent after every change while the window was up, History open or not.
    this.histOpen = false;
    this.histThere = new Map();      // history item id -> whether its file was there when last looked up
    this.history = new History(path.join(o.userDir, 'history.json'), { log: this.log, onChange: () => this._soon('h', () => { if (this.histOpen && this._panelShown()) this._pushHistory(); else this._push(); }, 250) });
    this.sync = new SyncStore({
      root: () => o.saveDirNow(), pairs: this.store.syncPairs || {}, gone: this.store.syncGone || {}, markOfWeb: o.markOfWeb || (() => {}),
      persist: () => { this.store.syncPairs = this.sync.pairs; this.store.syncGone = this.sync.gone; o.saveStore(); },
    });
    this.sync.on('changed', () => this._push());
    this.sync.on('stored', (x) => this.record({ dir: 'in', path: x.path, size: x.size, device: x.device, deviceName: x.phone, how: 'sync' }));
    this.sync.on('sent', (x) => this.record({ dir: 'out', path: x.path, size: x.size, device: x.device, deviceName: x.phone, how: 'sync' }));
    this.keys = new MediaKeys({ exe: path.join(o.appDir, 'bin', process.platform === 'win32' ? 'flick-keys.exe' : 'flick-keys'), log: this.log, onTrouble: (why) => this._remoteTrouble(why) });
    this.clip = new ClipWatch({
      clipboard: this.el.clipboard, ClipboardItem: this.el.ClipboardItem, nativeImage: this.el.nativeImage, log: this.log,
      wanted: () => this._on('clipSync') && this._hasFeatures(this.server.eventTarget()),
      send: (m) => { const d = this.server.eventTarget(); const ok = this.server.sendEvent(d, m); if (ok) this._clipKeep('out', d, m); return ok; },
      onLink: () => o.updateTray(),
    });
    // the last 20 clipboards that went through Flick (cliphist.js), on this PC only
    this.cliph = new ClipHistory(path.join(o.userDir, 'cliphist'), { log: this.log, onChange: () => this._soon('c', () => { this._pushClips(); this._push(); }, 80), thumb: (png) => this._thumb(png) });
    // "Ask each time" per phone (ask.js): the questions show in the window, in front of whatever the user is doing
    this.ask = new AcceptGate({ store: this.store, saveStore: o.saveStore, log: this.log, ms: o.askMs });
    this.ask.on('change', (a) => { this.o.panelSend('panel:ask', this.ask.list()); if (o.front) o.front(this.ask.asks.length > 0, !!a); });
    // Browse phone (browse.js)
    this.browse = new PhoneBrowse({
      server: this.server, log: this.log, panelSend: o.panelSend, saveReceived: o.saveReceived, record: (e) => this.record(e),
      hasFeatures: (d) => this._hasFeatures(d), nameOf: (d) => this._name(d), panelInFront: () => this._panelInFront(),
      notify: (n) => this.toast(n), showItem: (p) => { try { this.el.shell.showItemInFolder(p); } catch (e) { /* ignore */ } },
      onJob: o.onBrowseJob,               // (Transfers lists its copies)
    });

    const s = this.server;
    s.sync = this.sync;
    s.browse = this.browse;          // phoneapi.js hands /api/browse to it
    s.quietSave = (f) => this._quiet(f);
    this._apply();
    for (const ev of ['connected', 'disconnected', 'active', 'stream', 'phone-hello', 'devices-changed']) s.on(ev, () => this._phonesChanged());
    s.on('devices-changed', (devs) => { for (const d of Object.keys(this.store.acceptMode || {})) if (!devs || !devs[d]) this.ask.forget(d); });
    s.on('clip-in', (m) => this._clipIn(m));
    s.on('link-in', (m) => this._linkIn(m));
    // from another of the user's computers (server.js: peer-clip, peer-link)
    s.on('peer-clip', (m) => this._peerClipIn(m));
    s.on('peer-link', (m) => this._peerLinkIn(m));
    s.on('notify-in', (m) => this._notifyIn(m));
    s.on('media', (m) => { this.media.push(m.key); if (this.media.length > 50) this.media.shift(); this.keys.press(m.key); });
    s.on('ring-found', (m) => { if (this.ringing && this.ringing.device === m.device) { this._note(this.ringing.name + ' stopped ringing.'); this._ringEnd(); } });
    // a file the PC offered was fetched in full: "sent" in the history
    s.on('download-done', ({ fid }) => {
      const f = s.outgoing.get(fid);
      if (f && !f.inHistory) { f.inHistory = true; this.record({ dir: 'out', path: f.path, name: f.name, size: f.size, device: f.device || '', how: 'pc' }); }
    });
    // only from the panel's own window: the other windows share its preload, and these send files and answer questions
    const ipc = this.el.ipcMain;
    if (ipc) ipc.on('panel:feat', (e, m) => { if (m && typeof m === 'object' && this._fromPanel(e)) this._action(m); });
  }

  _fromPanel(e) { const p = this.o.getPanel(); return !!(p && !p.isDestroyed() && e && e.sender === p.webContents); }

  _on(k) { return this.store[k] !== false; }

  // the PC's settings, where the server checks them (an incoming clipboard or notification while off: 409 'off')
  _apply() {
    this.server.api.feat.clip = this._on('clipSync');
    this.server.api.feat.notify = this._on('phoneNotify');
    this._clipCheck();
  }

  // ---------- phones ----------
  _hasFeatures(device) {
    if (!device) return false;
    const s = this.server._pageFor(device);
    if (s) return (s.app || 0) >= FEATURES_CODE && this.server._v5ok(s.device, s.chan);   // and paired securely, on an encrypted link
    return this.server.api.streams.has(device);              // only a phone app with these features keeps a background link
  }

  /** Every phone the PC can reach: connected (Flick open there) or in the background, and the one in use. */
  phones() {
    const s = this.server, out = [];
    for (const p of s.phones()) out.push({ device: p.device, name: p.name, page: true, bg: s.api.streams.has(p.device), feat: (p.app || 0) >= FEATURES_CODE, via: p.via || '' });
    for (const d of s.api.streamDevices()) if (!out.some((x) => x.device === d)) out.push({ device: d, name: s.api.nameOf(d), page: false, bg: true, feat: true, via: '' });
    const target = s.eventTarget();
    for (const x of out) x.active = x.device === target;
    return out;
  }

  _phonesChanged() {
    if (!this.store.seenFeat && this.phones().some((x) => x.feat)) { this.store.seenFeat = true; this.o.saveStore(); }
    this._clipCheck();
    this._push();
    this.o.updateTray();
    this.browse.phonesChanged();
  }

  // the clipboard is looked at only while a phone that has these features is reachable
  _clipCheck() {
    const want = this._hasFeatures(this.server.eventTarget());
    if (want && !this.clip.running) this.clip.start();
    else if (!want && this.clip.running) { this.clip.stop(); if (this.clip.link) { this.clip.link = false; this.o.updateTray(); } }
  }

  _name(device) { return device ? this.server.api.nameOf(device) : 'Your phone'; }

  // ---------- the panel ----------
  state() {
    const phones = this.phones();
    const apps = Object.entries(this.store.notifyApps || {}).map(([pkg, a]) => ({ pkg, app: a.app || pkg, muted: !!a.muted, last: a.last || 0 }))
      .sort((a, b) => b.last - a.last).slice(0, 40);
    const pairs = Object.entries(this.sync.pairs).map(([id, p]) => ({ id, phone: p.phone || 'Phone', name: p.name, folder: p.folder, last: p.last || p.created || 0 }))
      .sort((a, b) => b.last - a.last);
    const h = this.history.items[0];
    const c = this.cliph.items[0];
    const pc = this.o.targetPc ? this.o.targetPc() : null;
    return {
      phones, target: phones.find((x) => x.active) || null,
      pcTarget: pc ? { id: pc, name: this._peerNm(pc) } : null,     // Send to: another computer (links go there)
      ringing: this.ringing ? { device: this.ringing.device, name: this.ringing.name, until: this.ringing.until } : null,
      clipSync: this._on('clipSync'), openLinks: this._on('openLinks'), phoneNotify: this._on('phoneNotify'), clipHistory: this._on('clipHistory'),
      apps, pairs, seenFeat: !!this.store.seenFeat || phones.some((x) => x.feat),
      last: h ? { name: h.name, dir: h.dir, deviceName: h.deviceName, time: h.time, ok: h.ok, why: h.why || '' } : null, count: this.history.items.length,
      clips: this.cliph.items.length, clipLast: c ? { kind: c.kind, preview: c.preview || '', blank: !!c.blank, time: c.time } : null,
      setN: this.setN || 0,
    };
  }

  _soon(k, fn, ms) {
    this.t = this.t || {};
    if (this.t[k]) return;
    this.t[k] = setTimeout(() => { this.t[k] = null; fn(); }, ms);
  }

  _push(now) {
    if (now) { this.o.panelSend('panel:feat-state', this.state()); return; }
    this._soon('s', () => this.o.panelSend('panel:feat-state', this.state()), 60);
  }

  // the history for the panel: the newest 200, each with whether its file is still there (Send again needs it). Every
  // file is looked up when History opens (fresh: files are moved and deleted meanwhile); while it's open, only the ones
  // added since.
  async _pushHistory(fresh) {
    const items = this.history.items.slice(0, 200);
    const known = fresh ? new Map() : this.histThere;
    const there = await Promise.all(items.map((it) => (!it.path ? false : known.has(it.id) ? known.get(it.id) : fs.promises.access(it.path).then(() => true, () => false))));
    const now = new Map();
    items.forEach((it, i) => now.set(it.id, there[i]));
    this.histThere = now;
    this.o.panelSend('panel:feat-history', { items: items.map((it, i) => Object.assign({}, it, { there: there[i] })), total: this.history.items.length });
    this._push();
  }

  _note(text) { this.o.panelSend('panel:note', { text }); }

  _panelInFront() { const p = this.o.getPanel(); return !!(p && !p.isDestroyed() && p.isVisible() && p.isFocused()); }
  _panelShown() { const p = this.o.getPanel(); return !!(p && !p.isDestroyed() && p.isVisible()); }

  /** A Windows notification. click / onAction: what clicking it (or its button) does. */
  toast({ title, body, click, action, onAction, silent }) {
    this.shown.unshift({ title, body: body || '', at: Date.now() });
    if (this.shown.length > 30) this.shown.length = 30;
    const N = this.el.Notification;
    if (!N || (typeof N.isSupported === 'function' && !N.isSupported())) return null;
    let n;
    try {
      n = new N({ title: String(title).slice(0, 120), body: noMarkup(String(body || '').slice(0, 250)), silent: !!silent, actions: action ? [{ type: 'button', text: action }] : [] });
    } catch (e) { this.log('notification failed: ' + e.message); return null; }
    this.live.add(n);
    const drop = () => this.live.delete(n);
    n.on('close', drop);
    n.on('click', () => { drop(); if (click) click(); });
    n.on('action', () => { drop(); if (onAction) onAction(); else if (click) click(); });
    try { n.show(); } catch (e) { drop(); return null; }
    const t = setTimeout(drop, 15 * 60000);
    if (t.unref) t.unref();
    return n;
  }

  _open(url) {
    try { Promise.resolve(this.el.shell.openExternal(url)).catch((e) => this.log('could not open a link: ' + e.message)); } catch (e) { this.log('could not open a link: ' + e.message); }
  }

  // ---------- from the phone ----------
  async _clipIn(m) {
    let ok = false;
    try { ok = await this.clip.put(m.kind, m.kind === 'text' ? m.text : m.png); } catch (e) { this.log('clipboard write failed: ' + e.message); }
    if (!ok) return;
    if (!m.priv) this._clipKeep('in', m.device, m);     // one the phone marked as private is never kept
    this._note('Copied from ' + m.name + '. ' + (m.kind === 'text' ? 'The text' : 'The picture') + ' is on your clipboard.');
    // the content itself isn't shown in the notification (it may be a password)
    if (!this._panelInFront()) this.toast({ title: 'Copied from ' + m.name, body: (m.kind === 'text' ? 'Text' : 'A picture') + ' is on your clipboard.', silent: true });
  }

  // a clipboard another computer sent (its user asked there): onto this one's, like one from the phone
  async _peerClipIn(m) {
    let ok = false;
    try { ok = await this.clip.put(m.kind, m.kind === 'text' ? m.text : m.png); } catch (e) { this.log('clipboard write failed: ' + e.message); }
    if (!ok) return;
    if (!m.priv) this._clipKeep('in', m.device, m, m.name);      // one marked private there (a password) is never kept
    this._note('Copied from ' + m.name + '. ' + (m.kind === 'text' ? 'The text' : 'The picture') + ' is on your clipboard.');
    if (!this._panelInFront()) this.toast({ title: 'Copied from ' + m.name, body: (m.kind === 'text' ? 'Text' : 'A picture') + ' is on your clipboard.', silent: true });
  }

  // a link another device sent: never opened by itself (it may be someone else's computer): the notification opens it
  _peerLinkIn(m) {
    this.peerLinks.unshift({ name: m.name, url: m.url, at: Date.now() });
    if (this.peerLinks.length > 20) this.peerLinks.length = 20;
    this._note('Link from ' + m.name + ': ' + m.url + '. Click the notification to open it.');
    this.toast({ title: 'Link from ' + m.name, body: 'Click to open ' + m.url, action: 'Open', click: () => this._open(m.url) });
  }

  _linkIn(m) {
    if (this._on('openLinks')) { this._open(m.url); this._note('Opened a link from ' + m.name + '.'); return; }
    // Electron shows notification buttons on macOS only: on Windows the notification itself is the Open button
    this.toast({ title: 'Link from ' + m.name, body: 'Click to open ' + m.url, action: 'Open', click: () => this._open(m.url) });
  }

  _notifyIn(m) {
    const apps = this.store.notifyApps || (this.store.notifyApps = {});
    // (a name every object has, "__proto__" say, can't be a key of the list: it named the list's prototype, and what
    // was kept for it landed on every object there is. No app is called that: kept under a name of its own.)
    const named = (m.pkg || m.app || 'app').slice(0, 200);
    const pkg = Object.prototype.hasOwnProperty.call(Object.prototype, named) ? 'app:' + named : named;
    let a = apps[pkg];
    if (!a || (m.app && a.app !== m.app)) {
      a = apps[pkg] = Object.assign(a || { muted: false }, { app: (m.app || (a && a.app) || pkg).slice(0, 100), last: Date.now() });
      // the list in the panel keeps the 60 apps heard from most recently
      const keys = Object.keys(apps);
      if (keys.length > 60) { keys.sort((x, y) => (apps[x].last || 0) - (apps[y].last || 0)); for (const k of keys.slice(0, keys.length - 60)) delete apps[k]; }
      this.o.saveStore();
      this._push();
    }
    a.last = Date.now();
    const k = m.device + '|' + m.key;
    const prev = this.notes.get(k);
    if (m.removed) { if (prev) { this.notes.delete(k); try { prev.close(); } catch (e) { /* ignore */ } } return; }
    if (a.muted) return;
    if (prev) { try { prev.close(); } catch (e) { /* ignore */ } }       // an update replaces the older one
    const text = m.text.length > 200 ? m.text.slice(0, 199).trimEnd() + '…' : m.text;
    const n = this.toast({ title: [a.app, m.title].filter(Boolean).join(' · ') || m.name, body: text });
    if (n) {
      this.notes.set(k, n);
      n.on('close', () => { if (this.notes.get(k) === n) this.notes.delete(k); });
      if (this.notes.size > 200) this.notes.delete(this.notes.keys().next().value);
    }
  }

  // The phone's remote can't tell whether this computer can press media keys: the first key that can't be pressed
  // says here what it takes (once per reason while Flick runs)
  _remoteTrouble(why) {
    if (this.remoteSaid === why) return;
    this.remoteSaid = why;
    const text = why === 'untrusted' ? 'To use your phone as a media remote, allow Flick in System Settings > Privacy & Security > Accessibility.'
      : why === 'playerctl' ? 'To use your phone as a media remote, install playerctl (for example: sudo apt install playerctl).'
        : 'The media remote doesn’t work on this computer.';
    this._note(text);
    if (!this._panelInFront()) this.toast({ title: 'Media remote', body: text, silent: true });
  }

  // a file sent without the gesture: saved like any received file, a notification, a history entry
  async _quiet(f) {
    if (f.kind === 'pull') {
      const c = this.browse.claim(f);
      if (c && c.refuse) throw Object.assign(new Error(c.refuse), { status: 409, why: c.refuse });   // that copy was stopped
      if (c) return this.browse.pulled(f, c);       // a file Browse phone asked for: saved, no notification of its own
      f.kind = 'share';                              // nothing here asked for it: like any file sent quietly
    }
    if (this.ask.mode(f.device) === 'ask') {
      // "Ask each time": nothing is saved before the user accepts (the phone waits for the answer to its upload)
      this.server.sendEvent(f.device, { t: 'asking', name: f.name });
      const a = await this.ask.ask({ device: f.device, deviceName: f.phone, name: f.name, count: 1, size: f.size, kind: 'quiet', tid: f.tid });
      if (!a.yes) {
        this.history.add({ dir: 'in', name: f.name, size: f.size, device: f.device, deviceName: f.phone, how: f.kind === 'share' ? 'share' : 'auto', ok: false, why: a.why });
        throw Object.assign(new Error(a.why), { status: 409, why: a.why });
      }
    }
    const r = await this.o.saveReceived(f.tmpPath, f.name);
    this.history.add({ dir: 'in', name: r.name, path: r.path, size: f.size, device: f.device, deviceName: f.phone, how: f.kind === 'share' ? 'share' : 'auto' });
    if (this.store.openAfter) setTimeout(() => this.o.openAfterArrival(r.path), 900);
    this.toast({ title: (QUIET_WHAT[f.kind] || 'File') + ' from ' + f.phone, body: r.name + ' · saved to ' + (r.where || 'your folder'), click: () => this.o.openAfterArrival(r.path) });
    this.log('saved quietly from', f.phone + ':', r.path);
    return r;
  }

  // ---------- to the phone ----------
  /** Sends a link to the phone in use (the panel's field, the tray), or to the computer picked in Send to. */
  sendLink(text) {
    const url = this._link(text);
    if (!url) return false;
    const pc = this.o.targetPc ? this.o.targetPc() : null;
    if (pc) { this.linkTo(pc, url); return true; }
    const d = this.server.eventTarget();
    if (d && !this._hasFeatures(d)) { this._note('Update Flick on ' + this._name(d) + ' to send it links.'); return false; }
    if (!d || !this.server.sendEvent(d, { t: 'link', url })) { this._note('Your phone isn’t reachable. Open Flick on it, or turn on “Stay connected in the background” there.'); return false; }
    this._note('Link sent to ' + this._name(d) + '.');
    return true;
  }

  /** The link the user gave, as one that goes, or null (and said why). A web link with a space in it (copied from a
   * PDF or a chat) goes as a browser takes it (%20); one longer than phones and other computers take is said to be too
   * long, not "not a web link". */
  _link(text) {
    let s = String(text || '').trim();
    if (s && !/^[a-z][a-z0-9+.-]*:/i.test(s) && /^[^\s/]+\.[^\s/]{2,}(\/|$)/.test(s)) s = 'https://' + s;   // "example.com/x"
    const long = () => { this._note('That link is too long to send (over ' + URL_MAX.toLocaleString('en-US') + ' characters).'); return null; };
    if (s.length > LINK_READ_MAX && /^https?:\/\/[^\s/]/i.test(s)) return long();
    const url = cleanUrl(s.replace(/ /g, '%20'), LINK_READ_MAX);
    if (!url) { this._note(NOT_LINK); return null; }
    return url.length > URL_MAX ? long() : url;
  }

  // ---------- to another computer (Your other devices, Send to) ----------
  _peerNm(id) { return (this.o.peerName && this.o.peerName(id)) || 'that computer'; }

  /** A link to another computer: it shows there as a notification that opens it. */
  async linkTo(id, url) {
    const P = this.o.peers && this.o.peers(), nm = this._peerNm(id);
    if (!P) return false;
    const r = await P.message(id, 'link', { t: 'link', url });
    this._note(r.ok ? 'Link sent to ' + nm + '.' : peerWhy(r.why, nm));
    return r.ok;
  }

  /** What's on this computer's clipboard, to another computer (its user asked: one marked private goes too, unkept). */
  async clipTo(id) {
    const P = this.o.peers && this.o.peers(), nm = this._peerNm(id);
    if (!P) return false;
    let msg = null, big = false, wait = false;
    try {
      const text = await this.clip._text();
      if (text) { if (Buffer.byteLength(text, 'utf8') <= 1024 * 1024) msg = { t: 'clip', kind: 'text', text }; else big = true; }
      else {
        const im = await this.clip._readImage();
        const png = im ? await im.png(PEER_PNG_MAX) : null;
        if (png) msg = { t: 'clip', kind: 'image', png: png.toString('base64') }; else if (im) big = true;
      }
    } catch (e) { wait = e && e.code === 'ECLIPWAIT'; this.log('clipboard read failed: ' + e.message); }
    if (!msg) { this._note(wait ? CLIP_WAIT : big ? 'What’s on your clipboard is too big to send.' : 'Your clipboard is empty.'); return false; }
    const priv = await this.clip._private().catch(() => false);
    if (priv) msg.private = true;                           // (so the other computer doesn't keep it either)
    const r = await P.message(id, 'clip', msg);
    this._note(r.ok ? 'Clipboard sent to ' + nm + '.' : peerWhy(r.why, nm));
    if (r.ok && !priv) this._clipKeep('out', id, msg, nm);
    return r.ok;
  }

  /** Find my phone: it rings for 30 s (or until it's stopped here or on the phone). */
  ring(device) {
    if (this.ringing) this.ringStop();
    const name = this._name(device);
    if (this.server._pageFor(device) && !this._hasFeatures(device)) { this._note('Update Flick on ' + name + ' to find it from here.'); return false; }
    if (!this.server.sendEvent(device, { t: 'ring', sec: RING_SEC })) {
      this._note(name + ' isn’t reachable. Open Flick on it, or turn on “Stay connected in the background” there.');
      return false;
    }
    this.ringing = { device, name, until: Date.now() + RING_SEC * 1000 };
    clearTimeout(this.ringT);
    this.ringT = setTimeout(() => this._ringEnd(), RING_SEC * 1000 + 1000);
    this._push(true);
    return true;
  }

  ringStop() {
    if (!this.ringing) return;
    this.server.sendEvent(this.ringing.device, { t: 'ring-stop' });
    this._ringEnd();
  }

  _ringEnd() { clearTimeout(this.ringT); this.ringing = null; this._push(true); }

  // ---------- history ----------
  /** A history entry; tid finds the phone that sent it, path its size. */
  record(e) {
    const device = e.device || (e.tid ? this.server.ownerOf(e.tid) : '') || '';
    let size = e.size, folder = false;
    if (e.path && size == null) {
      try { const st = fs.statSync(e.path); folder = st.isDirectory(); size = folder ? 0 : st.size; } catch (x) { size = 0; }
    }
    return this.history.add(Object.assign({}, e, { device, deviceName: e.deviceName || (device ? this._name(device) : ''), size: size || 0, folder }));
  }

  // ---------- clipboard history (cliphist.js) ----------
  // m: a clipboard message ({kind:'text', text} or {kind:'image', png: Buffer | base64}) that went to or came from device
  _clipKeep(dir, device, m, name) {
    if (!this._on('clipHistory') || !m) return;
    const c = m.kind === 'image' ? { kind: 'image', png: Buffer.isBuffer(m.png) ? m.png : Buffer.from(String(m.png || ''), 'base64') } : { kind: 'text', text: m.text };
    this.cliph.add(c, { dir, device, deviceName: name || (device ? this._name(device) : '') });
  }

  // a small picture for the list (the clipboard's own picture can be a whole screenshot)
  _thumb(png) {
    const ni = this.el.nativeImage;
    if (!ni || typeof ni.createFromBuffer !== 'function') return null;
    const im = ni.createFromBuffer(png);
    if (!im || im.isEmpty()) return null;
    const { width, height } = im.getSize();
    const r = Math.min(1, 96 / Math.max(width, height, 1));
    const t = r < 1 ? im.resize({ width: Math.max(1, Math.round(width * r)), height: Math.max(1, Math.round(height * r)), quality: 'good' }) : im;
    const jpg = t.toJPEG(82);
    return jpg && jpg.length ? 'data:image/jpeg;base64,' + jpg.toString('base64') : null;
  }

  _pushClips() { this.o.panelSend('panel:clips', { on: this._on('clipHistory'), items: this.cliph.list(), target: this._clipTarget() }); }

  // where "Send to phone" goes: the computer picked in Send to, or the phone in use, if it takes the clipboard
  _clipTarget() {
    const pc = this.o.targetPc ? this.o.targetPc() : null;
    if (pc) return { device: pc, name: this._peerNm(pc), ok: true, pc: true };
    const d = this.server.eventTarget();
    return d ? { device: d, name: this._name(d), ok: this._hasFeatures(d) } : null;
  }

  async _clipCopy(id) {
    const c = await this.cliph.get(id);
    if (!c) { this._note('That item isn’t there any more.'); this._pushClips(); return; }
    let ok = false;
    // put on the clipboard as if it came from the phone: it isn't sent back by itself
    try { ok = await this.clip.put(c.kind, c.kind === 'text' ? c.text : c.png); } catch (e) { this.log('clipboard write failed: ' + e.message); }
    this._note(ok ? (c.kind === 'text' ? 'Copied. The text is on your clipboard.' : 'Copied. The picture is on your clipboard.') : 'Couldn’t copy that.');
  }

  async _clipSend(id) {
    const pc = this.o.targetPc ? this.o.targetPc() : null;
    if (pc) {
      const c = await this.cliph.get(id);
      if (!c) { this._note('That item isn’t there any more.'); this._pushClips(); return; }
      const P = this.o.peers && this.o.peers(), nm = this._peerNm(pc);
      if (!P) return;
      if (c.kind === 'image' && c.png.length > PEER_PNG_MAX) { this._note('That picture is too big to send.'); return; }
      const msg = c.kind === 'text' ? { t: 'clip', kind: 'text', text: c.text } : { t: 'clip', kind: 'image', png: c.png.toString('base64') };
      const r = await P.message(pc, 'clip', msg);
      this._note(r.ok ? 'Sent to ' + nm + '.' : peerWhy(r.why, nm));
      if (r.ok && this._on('clipHistory')) this.cliph.add(c, { dir: 'out', device: pc, deviceName: nm });
      return;
    }
    const d = this.server.eventTarget();
    if (d && !this._hasFeatures(d)) { this._note('Update Flick on ' + this._name(d) + ' to send it the clipboard.'); return; }
    const c = await this.cliph.get(id);
    if (!c) { this._note('That item isn’t there any more.'); this._pushClips(); return; }
    const msg = c.kind === 'text' ? { t: 'clip', kind: 'text', text: c.text } : { t: 'clip', kind: 'image', png: c.png.toString('base64') };
    if (!d || !this.server.sendEvent(d, msg)) { this._note('Your phone isn’t reachable. Open Flick on it, or turn on “Stay connected in the background” there.'); return; }
    this._note('Sent to ' + this._name(d) + '.');
    if (this._on('clipHistory')) this.cliph.add(c, { dir: 'out', device: d, deviceName: this._name(d) });
  }

  /** Files a browser sent from the "Share with a browser" page (webshare.js 'incoming-done'). */
  watchWeb(web) {
    if (!web) return;
    web.on('incoming-done', (g) => {
      const who = g.device || 'A browser';
      for (const f of g.saved || []) this.record({ dir: 'in', path: f.path, name: f.name, deviceName: who, how: 'browser' });
      // (each one the save folder wouldn't take by its name, and where it's kept; the rest that didn't come as a count)
      const bad = Array.isArray(g.unsaved) ? g.unsaved : [];
      for (const u of bad) this.record({ dir: 'in', name: u.name, path: u.kept || undefined, deviceName: who, ok: false, why: u.why === 'space' ? 'space' : 'save', how: 'browser', size: 0 });
      const lost = (g.failed || 0) - bad.length;
      if (lost > 0) this.record({ dir: 'in', name: lost === 1 ? '1 file' : lost + ' files', deviceName: who, ok: false, how: 'browser', size: 0 });
    });
  }

  // ---------- the tray ----------
  /** "Send clipboard link to phone", while the clipboard holds one and a phone takes links. */
  trayItems() {
    const d = this.server.eventTarget();
    if (!d || !this.clip.link || !this._hasFeatures(d)) return [];
    // (read in its time: see clip.js)
    const click = async () => {
      let t = '';
      try { t = await this.clip._text(); } catch (e) { this._note(CLIP_WAIT); return; }
      this.sendLink(t);
    };
    return [{ label: 'Send clipboard link to phone', click: () => { click(); } }, { type: 'separator' }];
  }

  // ---------- panel actions ----------
  _action(m) {
    const str = (v) => (typeof v === 'string' ? v : '');
    // (the number of the window's last switch change taken here: its states say it, so a switch clicked since keeps what
    // it shows until its own change is taken: the panel's features.js change)
    if (Number.isSafeInteger(m.n) && m.n > 0) this.setN = m.n;
    const item = () => this.history.get(str(m.id));
    const there = (it, then) => {
      if (!it || !it.path) return;
      fs.promises.access(it.path).then(then, () => { this._note('That file isn’t there any more.'); this._pushHistory(true); });
    };
    switch (m.what) {
      // (the window just loaded: its History view is closed)
      case 'hello': this.histOpen = false; this._push(true); this._pushClips(); this.o.panelSend('panel:ask', this.ask.list()); this.browse.resend(); break;
      // History opened (or shown again): a fresh list, then what's added while it's open
      case 'hist-view': this.histOpen = true; this._pushHistory(true); break;
      case 'hist-leave': this.histOpen = false; break;
      case 'use': if (this.server.use(str(m.device))) this._push(true); break;
      case 'ring': this.ring(str(m.device)); break;
      case 'ring-stop': this.ringStop(); break;
      case 'set':
        if (!SETTINGS.includes(m.key)) break;
        this.store[m.key] = !!m.value;
        this.o.saveStore();
        this._apply();
        if (m.key === 'clipHistory' && !m.value) this.cliph.clear();      // off: nothing is kept, not even what was
        this._push(true);
        this._pushClips();
        break;
      // clipboard history
      case 'c-hello': this._pushClips(); break;
      case 'c-copy': this._clipCopy(str(m.id)); break;
      case 'c-send': this._clipSend(str(m.id)); break;
      case 'c-remove': this.cliph.remove(str(m.id)); break;
      case 'c-clear': this.cliph.clear(); break;
      // "Always accept" / "Ask each time", and the answer to a question
      case 'accept': if (this.server.devices[str(m.device)] && this.ask.setMode(str(m.device), m.mode === 'ask' ? 'ask' : 'always')) this.o.pushState(); break;
      case 'ask-answer': this.ask.answer(str(m.id), m.yes === true); break;
      // Browse phone
      case 'b-open': this.browse.open(str(m.cat)); break;
      case 'b-close': this.browse.close(); break;
      case 'b-cat': this.browse.cat(str(m.cat)); break;
      case 'b-dir': this.browse.dir(str(m.path)); break;
      case 'b-up': this.browse.up(); break;
      case 'b-more': this.browse.more(); break;
      case 'b-refresh': this.browse.refresh(); break;
      case 'b-copy': this.browse.pull(Array.isArray(m.paths) ? m.paths.filter((p) => typeof p === 'string') : []); break;
      case 'b-stop': this.browse.stop(); break;
      case 'b-show': this.browse.show(); break;
      case 'mute': {
        const a = this.store.notifyApps && this.store.notifyApps[str(m.pkg)];
        if (a) { a.muted = !!m.on; this.o.saveStore(); this._push(true); }
        break;
      }
      case 'link': this.sendLink(str(m.url)); break;
      // to another computer, from its row in Your other devices
      case 'p-clip': if (str(m.device)) this.clipTo(str(m.device)); break;
      case 'p-link': if (str(m.device)) { const u = this._link(str(m.url)); if (u) this.linkTo(str(m.device), u); } break;
      case 'h-open': there(item(), () => this.o.openAfterArrival(item().path)); break;
      case 'h-show': there(item(), () => { try { this.el.shell.showItemInFolder(item().path); } catch (e) { /* ignore */ } }); break;
      // Send again: to the computer it went to (another of the user's); anything else, to the phone
      case 'h-send': { const it = item(); there(it, () => (it.dir === 'out' && it.how === 'peer' && it.device && this.o.sendTo ? this.o.sendTo(it.device, [it.path]) : this.o.sendFiles([it.path]))); break; }
      case 'h-remove': this.history.remove(str(m.id)); break;
      case 'h-clear': this.history.clear(); break;
      case 'pair-open': { const p = this.sync.pairs[str(m.id)]; if (p) fs.promises.mkdir(p.folder, { recursive: true }).then(() => this.el.shell.openPath(p.folder), () => {}); break; }
      case 'pair-stop': this.sync.remove(str(m.id)); break;
      default: break;
    }
  }

  /** Something here is moving files or waiting on the user: folder sync, a Browse phone copy, a question asked. */
  busy() { return this.sync.busy() || this.browse._running() || this.ask.asks.length > 0; }

  stop() {
    this.sync.flush();
    this.history.flush();
    this.clip.stop();
    this.keys.stop();
    this.ask.stop();
    this.browse.shutdown();
  }

  // ---------- test control (FLICK_TEST only: main.js routes /f/... here) ----------
  test(u, res) {
    const q = u.searchParams;
    switch (u.pathname) {
      case '/f/state':
        return res.end(JSON.stringify({ state: this.state(), shown: this.shown, history: this.history.items.slice(0, 50), media: this.media,
          clip: { running: this.clip.running, link: this.clip.link, sent: this.clip.sent }, tray: this.trayItems().map((x) => x.label || x.type), pairs: this.sync.pairs, peerLinks: this.peerLinks }));
      case '/f/clip-text':     // the user copies text on the PC
        Promise.resolve(this.el.clipboard.writeText(q.get('text') || '')).then(() => res.end('ok'), (e) => res.end('error ' + e.message));
        return undefined;
      case '/f/clip-image': {   // the user copies a picture on the PC
        const w = +q.get('w') || 64, h = +q.get('h') || 48, c = q.get('rgb') || '3366cc';
        const px = Buffer.alloc(w * h * 4);
        for (let i = 0; i < w * h; i++) { px[i * 4] = parseInt(c.slice(4, 6), 16); px[i * 4 + 1] = parseInt(c.slice(2, 4), 16); px[i * 4 + 2] = parseInt(c.slice(0, 2), 16); px[i * 4 + 3] = 255; }
        const png = this.el.nativeImage.createFromBitmap(px, { width: w, height: h }).toPNG();
        const cb = this.el.clipboard;
        const p = this.el.ClipboardItem && typeof cb.write === 'function' ? cb.write([new this.el.ClipboardItem({ 'image/png': new Blob([png], { type: 'image/png' }) })])
          : cb.writeImage(this.el.nativeImage.createFromBuffer(png));
        Promise.resolve(p).then(() => res.end('ok'), (e) => res.end('error ' + e.message));
        return undefined;
      }
      case '/f/clip-read':      // what the PC clipboard holds
        (async () => {
          const text = await this.clip._text();
          const im = await this.clip._image();
          const png = im ? await im.png() : null;
          res.end(JSON.stringify({ text, image: png ? { width: png.readUInt32BE(16), height: png.readUInt32BE(20), bytes: png.length } : null }));
        })().catch((e) => res.end(JSON.stringify({ error: e.message })));
        return undefined;
      case '/f/action': this._action(JSON.parse(q.get('json') || '{}')); return res.end('ok');
      case '/f/more': {          // clipboard history, questions, Browse phone
        const b = this.browse.view ? Object.assign({}, this.browse.view, { sent: undefined }) : null;
        return res.end(JSON.stringify({ clips: this.cliph.list(), asks: this.ask.list(), acceptMode: this.store.acceptMode || {}, browse: b, job: this.browse._jobState(),
          pending: [...this.browse.pending.values()].map((p) => p.op), thumbs: this.browse.thumbs.size }));
      }
      default: res.statusCode = 404; return res.end();
    }
  }
}

function attach(o) { return new Features(o); }

module.exports = { attach, Features, FEATURES_CODE };
