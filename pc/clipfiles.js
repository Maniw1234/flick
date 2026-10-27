'use strict';
// The files copied in a Linux file manager (Copy, or Ctrl+C), for Air grab on the PC (selwatch.js): Linux file managers
// don't say what's selected, so what's copied stands for it. Read through wl-paste or xclip (text/uri-list, or GNOME's
// own list). Only a real list of copied files counts, never text that looks like a path.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { fileURLToPath } = require('url');

const MAX = 500;

function run(cmd, args, opts) {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, Object.assign({ timeout: 3000, maxBuffer: 4 * 1024 * 1024, encoding: 'buffer' }, opts || {}),
        (err, out) => resolve(err ? null : Buffer.from(out || '').toString('utf8')));
    } catch (e) { resolve(null); }
  });
}
const exists = (p) => { try { fs.accessSync(p); return true; } catch (e) { return false; } };

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
  const tries = [];
  if (process.env.WAYLAND_DISPLAY) {
    tries.push(['wl-paste', ['--no-newline', '--type', 'text/uri-list']], ['wl-paste', ['--no-newline', '--type', 'x-special/gnome-copied-files']]);
  }
  tries.push(['xclip', ['-selection', 'clipboard', '-o', '-t', 'text/uri-list']], ['xclip', ['-selection', 'clipboard', '-o', '-t', 'x-special/gnome-copied-files']]);
  let list = [];
  for (const [cmd, args] of tries) {
    list = fromUriList(await run(cmd, args));
    if (list.length) break;
  }
  const seen = new Set();
  return list.filter((p) => path.isAbsolute(p) && !seen.has(p) && seen.add(p) && exists(p)).slice(0, MAX);
}

module.exports = { clipFiles, fromUriList };
