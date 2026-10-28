'use strict';
// The files selected right now, for the send shortcut (Ctrl+Alt+F; Cmd+Option+F on a Mac: main.js):
//   Windows  File Explorer's window in front (the tab in front, on Windows 11) or the desktop: a PowerShell helper
//            answers each time it's asked (selwatch.js PS_ASK). It takes a second or two to start, so it stays half an
//            hour after the last press (the presses after the first answer at once), and someone who has used the
//            shortcut before gets it started a little after Flick starts (warm).
//   macOS    Finder's selection, when Finder is in front (macOS asks once to let Flick ask Finder)
//   Linux    the copied files (Copy, or Ctrl+C): file managers there don't say what's selected (clipfiles.js)
// Resolves { kind: 'folder' | 'desktop' | 'copied' | 'denied' | 'other', paths } (at most 100 paths).
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { PS_ASK } = require('./selwatch');
const { clipFiles } = require('./clipfiles');

const MAX = 100;
const KEEP_MS = 30 * 60000;
const ASK_MS = 8000;

const JXA_ONCE = [
  'var finder=Application("Finder"),kind="other",paths=[];',
  'try{if(finder.frontmost()){kind="folder";var sel=finder.selection();',
  'for(var i=0;i<sel.length&&i<100;i++){try{var u=String(sel[i].url()||"");if(u.indexOf("file://")===0)paths.push(decodeURIComponent(u.slice(7)).replace(/\\/$/,""));}catch(e){}}}',
  '}catch(e){if(e&&e.errorNumber===-1743)kind="denied";}',
  'JSON.stringify({kind:kind,paths:paths});',
].join('');

const clean = (list) => (list || []).filter((p) => typeof p === 'string' && p && path.isAbsolute(p)).slice(0, MAX);

class SelNow {
  /** o: { log, platform } */
  constructor(o) {
    this.o = o || {};
    this.plat = this.o.platform || process.platform;
    this.p = null;            // the Windows helper
    this.waiting = [];        // answers it owes, in order
    this.buf = '';
    this.cur = null;
    this.idleT = null;
  }

  /** @returns {Promise<{kind: string, paths: string[]}>} */
  ask() {
    if (this.plat === 'linux') return clipFiles().then((l) => ({ kind: l.length ? 'copied' : 'other', paths: clean(l) }), () => ({ kind: 'other', paths: [] }));
    if (this.plat === 'darwin') return this._mac();
    if (this.plat === 'win32') return this._win();
    return Promise.resolve({ kind: 'other', paths: [] });
  }

  /** Windows: the helper started ahead of a press (nothing elsewhere) */
  warm() {
    if (this.plat !== 'win32' || this.p) return;
    if (this._helper()) this._keep();
  }

  _keep() {
    clearTimeout(this.idleT);
    this.idleT = setTimeout(() => this.stop(), KEEP_MS);
    if (this.idleT.unref) this.idleT.unref();
  }

  stop() {
    clearTimeout(this.idleT);
    if (this.p) { try { this.p.stdin.end(); this.p.kill(); } catch (e) { /* ignore */ } this.p = null; }
    for (const w of this.waiting.splice(0)) w.done({ kind: 'other', paths: [] });
  }

  _mac() {
    return new Promise((resolve) => {
      execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', JXA_ONCE], { timeout: ASK_MS, encoding: 'utf8' }, (err, out) => {
        if (err) { this._log('Finder: ' + (err.message || err).toString().split('\n')[0]); return resolve({ kind: 'other', paths: [] }); }
        try { const r = JSON.parse(String(out).trim()); resolve({ kind: r.kind || 'other', paths: clean(r.paths) }); } catch (e) { resolve({ kind: 'other', paths: [] }); }
      });
    });
  }

  _win() {
    return new Promise((resolve) => {
      const p = this._helper();
      if (!p) return resolve({ kind: 'other', paths: [] });
      const w = { done: null };
      // (no answer in time: the helper is stuck; the next press starts a new one)
      const t = setTimeout(() => { this._log('no answer'); this.stop(); }, ASK_MS);
      w.done = (r) => { clearTimeout(t); resolve(r); };
      this.waiting.push(w);
      try { p.stdin.write('?\n'); } catch (e) { this.waiting.pop(); w.done({ kind: 'other', paths: [] }); }
      this._keep();
    });
  }

  _helper() {
    if (this.p) return this.p;
    const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const cmd = fs.existsSync(ps) ? ps : 'powershell.exe';
    const args = ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(PS_ASK, 'utf16le').toString('base64')];
    let p;
    try { p = spawn(cmd, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); } catch (e) { this._log('could not start: ' + e.message); return null; }
    this.p = p;
    this.buf = ''; this.cur = null;
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', (d) => {
      this.buf += d;
      let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).replace(/^\uFEFF/, '').replace(/\r$/, '');
        this.buf = this.buf.slice(i + 1);
        if (line.startsWith('@ ')) this.cur = { kind: line.slice(2).trim(), paths: [] };
        else if (line === '.') { const r = this.cur || { kind: 'other', paths: [] }; this.cur = null; const w = this.waiting.shift(); if (w) w.done({ kind: r.kind, paths: clean(r.paths) }); }
        else if (this.cur && line) this.cur.paths.push(line);
      }
    });
    p.stderr.on('data', () => {});
    p.stdin.on('error', () => {});
    p.on('error', (e) => this._log('error: ' + e.message));
    p.on('exit', () => {
      if (this.p !== p) return;
      this.p = null;
      for (const w of this.waiting.splice(0)) w.done({ kind: 'other', paths: [] });
    });
    return p;
  }

  _log(s) { if (this.o.log) this.o.log('send shortcut: ' + s); }
}

module.exports = { SelNow, JXA_ONCE };
