'use strict';
// The files copied in a Linux file manager (Copy, or Ctrl+C), for Air grab on the PC (selwatch.js) and the send
// shortcut (selnow.js): Linux file managers don't say what's selected, so what's copied stands for it. Read through
// Flick's own clipboard (Electron's, in its main process: X11, or XWayland, which every big Wayland desktop runs), so
// nothing has to be installed for it; where that isn't there (Node alone, as in tests; a clipboard that isn't
// answering, below), through xclip, else the X server itself (clipx11.js), else wl-paste (text/uri-list, or GNOME's own
// list). Only a real list of copied
// files counts, never text that looks like a path.
// This is asked every second while a phone is ready, so never in a way that shows: on GNOME's Wayland (no clipboard
// protocol for tools) wl-paste takes the keyboard focus for a moment each time it reads, so there it isn't used.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { fileURLToPath } = require('url');
const clipx11 = require('./clipx11');

const MAX = 500;

// Electron's clipboard, when this runs in Flick's main process (most computers have no xclip: without this, copied
// files could never be sent from them)
let ownClipboard = null;
try {
  const e = require('electron');
  if (e && typeof e === 'object' && e.clipboard && typeof e.clipboard.has === 'function' && typeof e.clipboard.read === 'function') ownClipboard = e.clipboard;
} catch (e) { /* Node alone */ }
// (GNOME's own list, as Electron names a format of the system's that isn't one of the web's)
const GNOME_LIST = 'electron application/osclipboard;format="x-special/gnome-copied-files"';

// Electron's clipboard asks the program that copied for what it has. One that never answers (it hung, or was closed
// while asked) leaves that read waiting for good, and every later read of what another program copied waits behind it,
// for the rest of Flick's run: the send shortcut, Air grab and clipboard sync would wait forever. So each read has a
// time limit, and while one is still waiting past it no other is started (it would only wait too). Meanwhile, on
// Linux, Flick's own clipboard is read from the X server with a connection of Flick's own for each read (clipx11.js:
// a program that doesn't answer it costs only that read), so all of those go on; elsewhere the programs' way asks
// afresh. If the answer comes after all, the clipboard is asked again.
// f(c): the read, of the clipboard c it's given (the one asked, or what stands in for it).
const waiting = new WeakMap();            // clipboard -> its read still waiting past its time
const notAnswering = () => Object.assign(new Error('the clipboard isn’t answering'), { code: 'ECLIPWAIT' });
let x11 = null;
const x11Clip = () => (x11 = x11 || clipx11.clipboard({ names: { [GNOME_LIST]: 'x-special/gnome-copied-files' } }));
const standIn = (cb) => (cb && cb === ownClipboard && clipx11.usable() ? x11Clip() : null);
function ask(cb, f, ms) {
  if (waiting.has(cb)) {
    const s = standIn(cb);
    if (!s) return Promise.reject(notAnswering());
    // (each of its reads ends in its own time: an error is that it wasn't answered either)
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(notAnswering()), ms);
      Promise.resolve().then(() => f(s)).then((v) => { clearTimeout(t); resolve(v); }, () => { clearTimeout(t); reject(notAnswering()); });
    });
  }
  return new Promise((resolve, reject) => {
    let late = false;
    const p = Promise.resolve().then(() => f(cb));
    const t = setTimeout(() => {
      late = true;
      waiting.set(cb, p);
      const back = () => { if (waiting.get(cb) === p) waiting.delete(cb); };
      p.then(back, back);
      reject(notAnswering());
    }, ms);
    p.then((v) => { if (!late) { clearTimeout(t); resolve(v); } }, (e) => { if (!late) { clearTimeout(t); reject(e); } });
  });
}
// the copied files' list through Electron's clipboard: text/uri-list, else GNOME's own. Asking whether one is there
// is cheap; only then is it read.
async function viaClipboard(cb) {
  const want = (await ask(cb, (c) => c.has('text/uri-list'), 2000)) ? 'text/uri-list' : (await ask(cb, (c) => c.has(GNOME_LIST), 2000)) ? GNOME_LIST : null;
  if (!want) return [];
  for (const it of (await ask(cb, (c) => c.read(), 2000)) || []) {
    if (!(it.types || []).includes(want)) continue;
    const b = await ask(cb, () => it.getType(want), 5000);
    return fromUriList(Buffer.isBuffer(b) ? b.toString('utf8') : typeof b === 'string' ? b : await b.text());
  }
  return [];
}

// { out: its output (null when it failed), missing: not installed, late: stopped at its time limit (the program that
// has the clipboard didn't answer: asking it for another kind won't be answered either) }
function run(cmd, args, opts) {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, Object.assign({ timeout: 3000, maxBuffer: 4 * 1024 * 1024, encoding: 'buffer' }, opts || {}),
        (err, out) => resolve({ out: err ? null : Buffer.from(out || '').toString('utf8'), missing: !!(err && err.code === 'ENOENT'), late: !!(err && err.killed) }));
    } catch (e) { resolve({ out: null, missing: true }); }
  });
}
const TYPES = ['text/uri-list', 'x-special/gnome-copied-files'];
const exists = (p) => { try { fs.accessSync(p); return true; } catch (e) { return false; } };
const isGnome = () => /gnome/i.test([process.env.XDG_CURRENT_DESKTOP, process.env.XDG_SESSION_DESKTOP, process.env.DESKTOP_SESSION].join(':'));

/** file:// lines of a text/uri-list (or GNOME's "copy\nfile://..."), as paths */
function fromUriList(text) {
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const l = raw.trim();
    if (!l || l.startsWith('#') || !/^file:\/\//i.test(l)) continue;
    try { out.push(fileURLToPath(l)); } catch (e) { /* not a local file */ }
  }
  return out;
}

/**
 * The copied files, existing ones only (at most 500), and whether the clipboard didn't answer in time (unanswered: the
 * programs' way was asked instead). o.clipboard: the clipboard to read (tests; null: the programs' way), Electron's own
 * by default.
 * @returns {Promise<{ paths: string[], unanswered: boolean }>}
 */
async function copied(o) {
  let list = [], xclip = false, done = false, unanswered = false, x11Asked = false;
  const cb = o && 'clipboard' in o ? o.clipboard : ownClipboard;
  if (cb) {
    const was = waiting.has(cb);
    try { list = await viaClipboard(cb); done = true; } catch (e) { list = []; unanswered = !!e && e.code === 'ECLIPWAIT'; }      // (else the programs' way)
    // (it has just stopped answering: what stands in for it now is asked at once)
    x11Asked = was && !!standIn(cb);
    if (unanswered && !was && waiting.has(cb) && standIn(cb)) { x11Asked = true; try { list = await viaClipboard(cb); done = true; unanswered = false; } catch (e) { /* not either */ } }
  }
  // (not when the X server was just asked: the program that has the clipboard didn't answer it, nor would it xclip)
  if (!done && !x11Asked && process.env.DISPLAY) {
    for (const t of TYPES) {
      const r = await run('xclip', ['-selection', 'clipboard', '-o', '-t', t]);
      if (r.missing) break;
      xclip = true;
      list = fromUriList(r.out);
      if (list.length || r.late) break;
    }
  }
  // (no xclip: the X server itself, as xclip would; Node alone, or a clipboard of Flick's that isn't answering)
  if (!done && !xclip && !x11Asked && clipx11.usable()) {
    try { list = await viaX11(); done = true; } catch (e) { /* no X server to read from */ }
  }
  // (wl-paste only where xclip can't be used)
  if (!done && !xclip && process.env.WAYLAND_DISPLAY && !isGnome()) {
    for (const t of TYPES) {
      const r = await run('wl-paste', ['--no-newline', '--type', t]);
      if (r.missing) break;
      list = fromUriList(r.out);
      if (list.length || r.late) break;
    }
  }
  // (each one looked up on the disk only until there are enough: this runs every second while files are copied)
  const seen = new Set(), out = [];
  for (const p of list) {
    if (out.length >= MAX) break;
    if (!path.isAbsolute(p) || seen.has(p)) continue;
    seen.add(p);
    if (exists(p)) out.push(p);
  }
  return { paths: out, unanswered };
}
// the copied files' list read from the X server (each read in its own time, 2 s)
async function viaX11() {
  const c = x11Clip();
  const want = (await c.has('text/uri-list')) ? 'text/uri-list' : (await c.has(GNOME_LIST)) ? GNOME_LIST : null;
  if (!want) return [];
  const b = await (await c.read())[0].getType(want);
  return fromUriList(b.toString('utf8'));
}

/** The copied files (copied()'s paths) @returns {Promise<string[]>} */
const clipFiles = (o) => copied(o).then((r) => r.paths);

/** The files a file manager copied, as they're on the clipboard cb (none: []), whether or not they're still there. */
const filesOn = (cb) => viaClipboard(cb);

module.exports = { copied, clipFiles, fromUriList, ask, filesOn };
