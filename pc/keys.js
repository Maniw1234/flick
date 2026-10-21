'use strict';
// The phone as a media remote (WS 'media'): a small Windows helper (bin/flick-keys.exe, native/flick-keys.c) presses the
// media keys with SendInput. One helper, started with the first key and started again if it has died; it reads one key
// name per line and exits when its input closes.
const fs = require('fs');
const { spawn } = require('child_process');

const KEYS = new Set(['play', 'next', 'prev', 'vol-up', 'vol-down', 'mute']);

class MediaKeys {
  /** opts: { exe, log, cmd?: [program, ...args] to run instead of exe (tests: under Wine) } */
  constructor(opts) {
    this.exe = opts.exe;
    this.cmd = opts.cmd || null;
    this.log = opts.log || (() => {});
    this.child = null;
    this.recent = [];
    this.starts = [];
    this.pressed = [];        // the last keys passed on (for the test control)
  }

  /** Presses `key` on this PC; false when it can't (not Windows, helper missing, too many at once). */
  press(key) {
    if (!KEYS.has(key)) return false;
    const now = Date.now();
    this.recent = this.recent.filter((t) => now - t < 1000);
    if (this.recent.length >= 20) return false;          // a flood (or a stuck button) isn't passed on
    this.recent.push(now);
    const c = this._helper();
    if (!c) return false;
    try { c.stdin.write(key + '\n'); } catch (e) { return false; }
    this.pressed.push(key);
    if (this.pressed.length > 50) this.pressed.shift();
    return true;
  }

  _helper() {
    if (this.child) return this.child;
    const [prog, ...args] = this.cmd || [this.exe];
    if (!this.cmd && (!this.exe || !fs.existsSync(this.exe))) {
      if (!this.warned) { this.warned = true; this.log('media keys: no helper here (' + this.exe + ')'); }
      return null;
    }
    // a helper that keeps dying isn't started more than 3 times a minute
    const now = Date.now();
    this.starts = this.starts.filter((t) => now - t < 60000);
    if (this.starts.length >= 3) return null;
    this.starts.push(now);
    let child;
    try { child = spawn(prog, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] }); }
    catch (e) { this.log('media keys: ' + e.message); return null; }
    this.child = child;
    child.stdin.on('error', () => {});
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (line && !/^sent /.test(line)) this.log('media keys: ' + line.slice(0, 120)); }
    });
    const gone = () => { if (this.child === child) this.child = null; };
    child.on('error', (e) => { this.log('media keys: ' + e.message); gone(); });
    child.on('exit', (code) => { if (code) this.log('media keys helper exited ' + code); gone(); });
    return child;
  }

  stop() {
    const c = this.child;
    this.child = null;
    if (c) { try { c.stdin.end(); } catch (e) { /* ignore */ } setTimeout(() => { try { c.kill(); } catch (e) { /* ignore */ } }, 2000).unref(); }
  }
}

module.exports = { MediaKeys, KEYS };
