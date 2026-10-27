'use strict';
// The files copied on this PC (Ctrl+C or Cmd+C in File Explorer, Finder or a Linux file manager), for Air grab's catch
// (pc/air.js): Windows through PowerShell (the clipboard's file list), macOS through osascript (the pasteboard items'
// file URLs), Linux through wl-paste or xclip (text/uri-list, or GNOME's own list). Only a real list of copied files
// counts: never text that looks like a path (a phone can put text on this clipboard, and must not pick files that way).
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { fileURLToPath } = require('url');

const MAX = 500;

function run(cmd, args, opts) {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, Object.assign({ timeout: 6000, windowsHide: true, maxBuffer: 4 * 1024 * 1024, encoding: 'buffer' }, opts || {}),
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

const PS = '$ErrorActionPreference="SilentlyContinue";[Console]::OutputEncoding=[Text.Encoding]::UTF8;' +
  'Add-Type -AssemblyName System.Windows.Forms;foreach($f in [Windows.Forms.Clipboard]::GetFileDropList()){[Console]::Out.WriteLine($f)}';
async function windows() {
  const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const out = await run(exists(ps) ? ps : 'powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', PS]);
  return String(out || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

// each pasteboard item's own file URL (public.file-url: what Finder puts there), never one made from plain text
const JXA = 'ObjC.import("AppKit");var it=$.NSPasteboard.generalPasteboard.pasteboardItems;var r=[];' +
  'if(it&&!it.isNil()){for(var i=0;i<it.count;i++){var s=it.objectAtIndex(i).stringForType("public.file-url");' +
  'if(!s||s.isNil())continue;var u=$.NSURL.URLWithString(s);if(!u||u.isNil())continue;var f=u.filePathURL;' +
  'if(f&&!f.isNil())r.push(ObjC.unwrap(f.path));}}r.join("\\n");';
async function mac() {
  const out = await run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', JXA]);
  return String(out || '').split('\n').map((l) => l.trim()).filter((l) => l.startsWith('/'));
}

async function linux() {
  const tries = [];
  if (process.env.WAYLAND_DISPLAY) {
    tries.push(['wl-paste', ['--no-newline', '--type', 'text/uri-list']], ['wl-paste', ['--no-newline', '--type', 'x-special/gnome-copied-files']]);
  }
  tries.push(['xclip', ['-selection', 'clipboard', '-o', '-t', 'text/uri-list']], ['xclip', ['-selection', 'clipboard', '-o', '-t', 'x-special/gnome-copied-files']]);
  for (const [cmd, args] of tries) {
    const out = await run(cmd, args, { timeout: 3000 });
    const list = fromUriList(out);
    if (list.length) return list;
  }
  return [];
}

/**
 * The copied files, existing ones only (at most 500).
 * @returns {Promise<string[]>}
 */
async function clipFiles() {
  let list = [];
  try { list = process.platform === 'win32' ? await windows() : process.platform === 'darwin' ? await mac() : await linux(); }
  catch (e) { list = []; }
  const seen = new Set();
  return list.filter((p) => path.isAbsolute(p) && !seen.has(p) && seen.add(p) && exists(p)).slice(0, MAX);
}

module.exports = { clipFiles, fromUriList };
