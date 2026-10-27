'use strict';
// The files copied in a Linux file manager (Copy, or Ctrl+C), for Air grab on the PC (selwatch.js): Linux file managers
// don't say what's selected, so what's copied stands for it. Read through xclip (X11, or XWayland, which every big
// Wayland desktop runs), else wl-paste (text/uri-list, or GNOME's own list). Only a real list of copied files counts,
// never text that looks like a path.
// This is asked every second while a phone is ready, so never in a way that shows: on GNOME's Wayland (no clipboard
// protocol for tools) wl-paste takes the keyboard focus for a moment each time it reads, so there it isn't used.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { fileURLToPath } = require('url');

const MAX = 500;

// { out: its output (null when it failed), missing: not installed }
function run(cmd, args, opts) {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, Object.assign({ timeout: 3000, maxBuffer: 4 * 1024 * 1024, encoding: 'buffer' }, opts || {}),
        (err, out) => resolve({ out: err ? null : Buffer.from(out || '').toString('utf8'), missing: !!(err && err.code === 'ENOENT') }));
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
 * The copied files, existing ones only (at most 500).
 * @returns {Promise<string[]>}
 */
async function clipFiles() {
  let list = [], xclip = false;
  if (process.env.DISPLAY) {
    for (const t of TYPES) {
      const r = await run('xclip', ['-selection', 'clipboard', '-o', '-t', t]);
      if (r.missing) break;
      xclip = true;
      list = fromUriList(r.out);
      if (list.length) break;
    }
  }
  // (wl-paste only where xclip can't be used)
  if (!xclip && process.env.WAYLAND_DISPLAY && !isGnome()) {
    for (const t of TYPES) {
      const r = await run('wl-paste', ['--no-newline', '--type', t]);
      if (r.missing) break;
      list = fromUriList(r.out);
      if (list.length) break;
    }
  }
  const seen = new Set();
  return list.filter((p) => path.isAbsolute(p) && !seen.has(p) && seen.add(p) && exists(p)).slice(0, MAX);
}

module.exports = { clipFiles, fromUriList };
