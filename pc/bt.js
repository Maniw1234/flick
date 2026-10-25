'use strict';
// Bluetooth for when there is no network: a small Windows helper (bin/flick-bt.exe, native/flick-bt.c) offers an
// RFCOMM service and relays each phone's link to a local port here; each link carries Flick's usual HTTP and WebSocket
// traffic through mux.js. Much slower than Wi-Fi, but it works anywhere the PC and phone are paired.
const net = require('net');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const { MuxLink } = require('./mux');

class BtBridge extends EventEmitter {
  /** opts: { exe, http (the FlickServer's http.Server), log } */
  constructor(opts) {
    super();
    this.exe = opts.exe;
    this.http = opts.http;
    this.log = opts.log || (() => {});
    this.state = 'off';
    this.links = new Set();
    this.child = null;
    this.relay = null;
    this.stopped = true;
  }

  _set(state) { if (state !== this.state) { this.state = state; this.emit('state', state); } }

  async start() {
    if (!this.stopped) return;
    this.stopped = false;
    if (!this.exe || !fs.existsSync(this.exe)) { this._set('unsupported'); return; }
    this._set('starting');
    this.relay = net.createServer((sock) => this._link(sock));
    await new Promise((res, rej) => { this.relay.once('error', rej); this.relay.listen(0, '127.0.0.1', res); }).catch((e) => { this.log('bt relay', e.message); });
    if (!this.relay.address()) { this._set('error'); return; }
    this._spawn();
  }

  _spawn() {
    this.respawnT = null;
    if (this.stopped || this.child || !this.relay || !this.relay.address()) return;   // never two helpers at once
    const port = this.relay.address().port;
    const args = process.env.FLICK_BT_TCP ? ['--tcp', process.env.FLICK_BT_TCP, String(port)] : [String(port)];
    let child;
    try { child = spawn(this.exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { this.log('bt helper', e.message); this._set('error'); return; }
    this.child = child;
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (line) this._line(line); }
    });
    child.stderr.on('data', (d) => this.log('bt helper:', d.toString('utf8').trim().slice(0, 200)));
    child.on('error', (e) => { this.log('bt helper', e.message); this._set('error'); });
    child.on('exit', (code) => {
      if (this.child !== child) return;                 // an older helper (stopped and restarted since): ignore it
      this.child = null;
      if (this.stopped) return;
      // the radio may come back (Bluetooth turned on, a dongle plugged in): try again in a while
      this.log('bt helper exited', code);
      if (this.state !== 'no-radio') this._set('error');
      clearTimeout(this.respawnT);
      this.respawnT = setTimeout(() => this._spawn(), code === 3 ? 15000 : 5000);
    });
  }

  // helper status lines: "listening <channel>", "no-radio", "client <address>", "gone <address>", "error <what>"
  _line(line) {
    const [word] = line.split(' ');
    if (word === 'listening') { this._set('on'); this.log('bluetooth ready,', line); }
    else if (word === 'no-radio') this._set('no-radio');
    else if (word === 'client') this.log('bluetooth phone connected', line.slice(7));
    else if (word === 'gone') this.log('bluetooth phone left', line.slice(5));
    else if (word === 'error') { this.log('bluetooth', line); }
  }

  _link(sock) {
    const link = new MuxLink(sock, 'bluetooth');
    this.links.add(link);
    link.on('stream', (s) => this.http.emit('connection', s));
    link.on('close', () => this.links.delete(link));
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.respawnT); this.respawnT = null;
    if (this.child) { try { this.child.kill(); } catch (e) { /* ignore */ } this.child = null; }
    for (const l of this.links) l.close();
    this.links.clear();
    if (this.relay) { try { this.relay.close(); } catch (e) { /* ignore */ } this.relay = null; }
    this._set('off');
  }
}

module.exports = { BtBridge };
