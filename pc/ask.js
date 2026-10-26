'use strict';
// "Always accept" or "Ask each time", a setting per paired phone (store.acceptMode: device -> 'ask'; anything else is
// Always accept, which is how Flick has always worked). With Ask each time, a file or batch from that phone waits for
// Accept in the PC window before it is saved: a fling or Send (main.js holds the transfer at finalize), and a file
// sent without the gesture (auto-send, a tile, the widget: features.js holds the quiet upload). Decline, or no answer
// within 60 seconds, and the phone is told why. Files the PC asked for itself (Browse phone) and synced folders don't
// ask: the user set those up on this PC.
const { EventEmitter } = require('events');
const crypto = require('crypto');

const ASK_MS = 60000;
const MAX_WAITING = 20;          // more than that at once (a phone gone wild): the newest are declined at once

class AcceptGate extends EventEmitter {
  /** o: { store, saveStore(), log(), ms } ('change' is emitted when the list of questions changes) */
  constructor(o) {
    super();
    this.store = o.store;
    this.saveStore = o.saveStore || (() => {});
    this.log = o.log || (() => {});
    this.ms = o.ms || ASK_MS;
    this.asks = [];              // waiting for an answer, oldest first
  }

  mode(device) {
    const m = this.store.acceptMode;
    return device && m && typeof m === 'object' && m[device] === 'ask' ? 'ask' : 'always';
  }

  setMode(device, mode) {
    if (typeof device !== 'string' || !device) return false;
    const m = this.store.acceptMode && typeof this.store.acceptMode === 'object' ? this.store.acceptMode : (this.store.acceptMode = {});
    if (mode === 'ask') m[device] = 'ask'; else delete m[device];
    this.saveStore();
    return true;
  }

  /** The phone's pairing was removed: its setting goes, and what it was waiting for is declined. */
  forget(device) {
    if (this.store.acceptMode && this.store.acceptMode[device]) { delete this.store.acceptMode[device]; this.saveStore(); }
    this.withdraw((a) => a.device === device, 'gone');
  }

  /**
   * Asks the user. info: { device, deviceName, name, count, size, names[], kind: 'fling' | 'quiet', tid }.
   * Resolves { yes: true } or { yes: false, why: 'declined' | 'timeout' | 'busy' | 'gone' | 'canceled' }.
   */
  ask(info) {
    return new Promise((resolve) => {
      if (this.asks.length >= MAX_WAITING) { resolve({ yes: false, why: 'busy' }); return; }
      const now = Date.now();
      const a = {
        id: crypto.randomBytes(6).toString('hex'), device: String(info.device || ''), deviceName: String(info.deviceName || 'Your phone').slice(0, 60),
        name: String(info.name || 'a file').slice(0, 200), count: Math.max(1, Math.floor(+info.count || 1)), size: Math.max(0, +info.size || 0),
        names: Array.isArray(info.names) ? info.names.slice(0, 50).map((x) => String(x).slice(0, 200)) : [],
        kind: info.kind === 'quiet' ? 'quiet' : 'fling', tid: info.tid ? String(info.tid) : '', at: now, until: now + this.ms,
      };
      a.done = (r) => { clearTimeout(a.timer); const i = this.asks.indexOf(a); if (i >= 0) this.asks.splice(i, 1); this.emit('change'); resolve(r); };
      a.timer = setTimeout(() => { this.log('nobody answered for', a.name, 'from', a.deviceName); a.done({ yes: false, why: 'timeout' }); }, this.ms);
      this.asks.push(a);
      this.log('asking about', a.count === 1 ? a.name : a.count + ' items', 'from', a.deviceName);
      this.emit('change', a);
    });
  }

  /** The user's answer (Accept / Decline in the window). */
  answer(id, yes) {
    const a = this.asks.find((x) => x.id === id);
    if (!a) return false;
    a.done(yes ? { yes: true } : { yes: false, why: 'declined' });
    return true;
  }

  /** More is known about a transfer that is being asked about (a batch's list arrived): the question shows it. */
  update(tid, info) {
    const a = tid && this.asks.find((x) => x.tid === tid);
    if (!a) return;
    if (info.count) a.count = Math.max(1, Math.floor(+info.count));
    if (info.size) a.size = Math.max(0, +info.size);
    if (Array.isArray(info.names) && info.names.length) a.names = info.names.slice(0, 50).map((x) => String(x).slice(0, 200));
    this.emit('change');
  }

  /** Questions that no longer need an answer (the phone canceled, the transfer failed): answered "no" quietly. */
  withdraw(match, why) {
    for (const a of this.asks.filter(match)) a.done({ yes: false, why: why || 'canceled' });
  }

  /** What the window shows: the oldest question first. */
  list() {
    return this.asks.map((a) => ({ id: a.id, device: a.device, deviceName: a.deviceName, name: a.name, count: a.count, size: a.size, names: a.names, kind: a.kind, until: a.until }));
  }

  stop() { this.withdraw(() => true, 'gone'); }
}

module.exports = { AcceptGate, ASK_MS };
