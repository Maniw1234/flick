'use strict';
const { app, BrowserWindow, Tray, Menu, nativeImage, screen, ipcMain, desktopCapturer, shell, dialog, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const { FlickServer, lanAddresses, rid } = require('./server');
const { apkInfoAsync } = require('./apkinfo');
const tlscert = require('./tlscert');
const { ReceivedIndex } = require('./have');
const { smallPicture } = require('./imgsize');
const { safeSegment } = require('./bundle');
const { Updater } = require('./updater');
const { readProof, writeProof } = require('./updatecore');

const VERSION = require('./package.json').version;
const IS_WIN = process.platform === 'win32';
// Windows' own programs go by their full path: Windows looks for a bare name in the current folder first, and Flick can be
// started in one anything may be saved to (Send to or Open with, from the Downloads folder or the Desktop)
const winSys = (...p) => path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', ...p);
const plat = require('./platform');          // what macOS and Linux do differently (Windows' own code stays here)
const { IS_MAC, IS_LINUX } = plat;
const HIDDEN_START = process.argv.includes('--hidden');
// The test control server runs arbitrary JS in a window, so it must never be reachable in a shipped build, even if
// someone sets the env var: a packaged app refuses it outright.
const TEST_MODE = process.env.FLICK_TEST === '1' && !app.isPackaged;
// Releases must be signed with Flick's release key (updatecore.js); only a test run may trust its own throwaway key.
const TEST_RELEASE_KEYS = TEST_MODE && process.env.FLICK_TEST_RELEASE_KEYS ? process.env.FLICK_TEST_RELEASE_KEYS.split(',') : undefined;
// How long a transfer has been quiet is timed by a clock that only moves forward: with the wall clock set back an hour
// a stopped transfer counted as moving for that hour (updates waited), and set ahead, live ones were ended as stalled.
// (What History shows keeps the wall clock.)
const mono = () => performance.now();

if (process.env.FLICK_USERDATA) app.setPath('userData', process.env.FLICK_USERDATA);
if (!app.requestSingleInstanceLock()) {
  // boot.js counted this start against a downloaded version; it isn't one (Flick is already running), so give it back
  try {
    const b = global.FLICK_BOOT;
    if (b && b.dir) {
      const core = require('./updatecore');
      const cur = core.readCurrent(b.root);
      if (cur && cur.dir === b.dir && cur.tries > 0) { cur.tries -= 1; core.writeCurrent(b.root, cur); }
    }
  } catch (e) { /* ignore */ }
  app.quit(); process.exit(0);
}
app.setAppUserModelId('com.flick.pc');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// macOS: files dropped on Flick in the Dock or opened with it from Finder go to the phone, like Windows' Send to. They
// can come before Flick is ready (they started it), so they wait for it; a drop of several arrives one by one, and
// goes out as one batch.
let openFiles = [], openFilesT = null, startedAt = 0;
app.on('open-file', (e, p) => {
  e.preventDefault();
  if (typeof p === 'string' && path.isAbsolute(p)) openFiles.push(p);
  clearTimeout(openFilesT);
  openFilesT = setTimeout(sendOpenFiles, 300);
});
function sendOpenFiles() {
  if (!startedAt || !openFiles.length) return;
  queueForPhone(openFiles.splice(0).slice(0, MAX_SEND + 1));
}
// macOS: a click on Flick in the Dock (or opening it again) shows the panel; Flick's own start isn't such a click
app.on('activate', () => { if (startedAt && Date.now() - startedAt > 2000) showPanel(); });

// Flick's windows only ever show their own local pages. Never let one navigate elsewhere or spawn a new window, so a
// bug that put attacker text into a page can't turn into "load a remote origin into a window that has the preload".
app.on('web-contents-created', (_e, contents) => {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (ev, url) => { if (url !== contents.getURL()) ev.preventDefault(); });
  contents.on('will-attach-webview', (ev) => ev.preventDefault());
});

// ------------------------------------------------------------ settings
const userDir = app.getPath('userData');
const SETTINGS = path.join(userDir, 'settings.json');
const LOG = path.join(userDir, 'flick.log');
// (what other devices say, their names above all, goes in as it is: nothing in it can start a line of its own or look
// like something else in the log)
const logSafe = (x) => x.replace(/[\u0000-\u001f\u007f\u061c\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
// One kind of line coming again and again (something on the network failing to sign in over and over, say) is written
// at most 20 times a minute, and how many more came is said in one line once that minute is over: such a flood can't
// push the rest of the log out of flick.log and flick.log.1 (512 KB each), nor keep the main process writing to disk.
// A kind is the same text (but for its time); lines with what a device that may not be paired says of itself (its name)
// are one kind by where they come from (logAs). Different lines, however many, are all written.
const LOG_KIND_MAX = 20, LOG_KIND_MS = 60000;
const logKinds = new Map();      // kind -> { at: its minute's start, n: written, more: not written, last: the last of those }
function logWrite(text) {
  const line = new Date().toISOString() + ' ' + text + '\n';
  try {
    if (fs.existsSync(LOG) && fs.statSync(LOG).size > 512 * 1024) fs.renameSync(LOG, LOG + '.1');
    fs.appendFileSync(LOG, line);
  } catch (e) { /* ignore */ }
  if (TEST_MODE) process.stdout.write(line);
}
// a kind's minute is over: how many of it weren't written, if any
function logMore(kind) {
  const k = logKinds.get(kind);
  if (!k) return;
  logKinds.delete(kind);
  clearTimeout(k.t);
  if (k.more) logWrite(k.last + ' [' + k.more + ' more like this in that minute]');
}
function logFlush() { for (const kind of [...logKinds.keys()]) logMore(kind); }
function logLine(kind, text) {
  const now = Date.now();
  let k = logKinds.get(kind);
  if (k && now - k.at >= LOG_KIND_MS) { logMore(kind); k = null; }
  if (!k) {
    // (a great many different lines in a minute: those that are still under their limit are forgotten, so the list
    // stays short)
    if (logKinds.size >= 2000) {
      for (const [x, v] of [...logKinds]) if (!v.more || now - v.at >= LOG_KIND_MS) logMore(x);
      for (const x of [...logKinds.keys()].slice(0, Math.max(0, logKinds.size - 1000))) logMore(x);
    }
    k = { at: now, n: 0, more: 0, last: '', t: null };
    logKinds.set(kind, k);
  }
  if (k.n < LOG_KIND_MAX) { k.n++; logWrite(text); return; }
  k.more++; k.last = text;
  if (!k.t) { k.t = setTimeout(() => logMore(kind), k.at + LOG_KIND_MS - now); if (k.t.unref) k.t.unref(); }
}
const logText = (a) => a.map((x) => logSafe(typeof x === 'string' ? x : String(JSON.stringify(x)))).join(' ');
/** A line with what another device says of itself in it (its name, its address): all lines of one kind count together. */
function logAs(kind, ...a) { logLine('\u0001' + kind, logText(a)); }
function log(...a) {
  const text = logText(a);
  logLine(text, text);
}

// An unexpected error must never put an error box on the user's screen: note it in the log and carry on.
let inFault = false;
function fault(kind, e) {
  if (inFault || (e && e.code === 'EPIPE')) return;   // never loop on a broken log pipe
  inFault = true;
  try { log(kind, String((e && e.stack) || e).split('\n').map((l) => l.trim()).join(' | ')); } catch (x) { /* ignore */ }
  inFault = false;
}
process.on('uncaughtException', (e) => fault('uncaught', e));
process.on('unhandledRejection', (e) => fault('unhandled', e));
if (process.stdout && process.stdout.on) process.stdout.on('error', () => {});

const DEFAULTS = {
  // received files land on the desktop, except on Linux, where desktops often show no files at all
  id: null, name: null, side: 'right', anchor: 0.5, size: 1, saveDir: IS_LINUX ? 'downloads' : 'desktop', sound: true,
  startup: true, edgeSend: true, devices: {}, firstRun: true, displayId: null, theme: 'meteor',
  volume: 0.7,                 // the animations' sound (0..1)
  reduceFx: false,             // the light version of the animations (it's also used on its own on a slow PC)
  reduceFxSet: false,          // the user set Reduce effects: until then it follows the system's "reduce motion"
  zoom: 1,                     // the window's text size (Ctrl+Plus/Minus, Ctrl+mouse wheel): 1 to 2
  hotkey: true,                // Ctrl+Alt+F (Cmd+Option+F) sends the selected files to the phone
  openAfter: false, showSpeed: true, sendTo: true, autoUpdate: true, bluetooth: false, quickShare: false,
  airCam: true,                // Air grab: this PC's camera sees where the hand opens, and a fist picking files up (air.js)
  // the animations on the screen. A new install starts with them off (see freshInstall); settings from an older Flick
  // have no fx, and keep them on
  fx: true,
  tourDone: true,              // the window's first-time tour was shown (a new install: not yet)
  // the window's look the tour was last shown for: a Flick whose window changed (TOUR_V) shows it once more to a user
  // updating to it
  tourV: 0,
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// settings.json holds the pairings' tokens (one is enough to sign in here as that phone): on a Mac or Linux computer
// other users may share, it and its copies are for this user only, and so is Flick's folder (a folder or a file left
// readable by an older Flick is closed now). Windows keeps a user's profile to that user.
const PRIVATE = 0o600;
if (!IS_WIN) {
  for (const [f, m] of [[userDir, 0o700], [SETTINGS, PRIVATE], [SETTINGS + '.bak', PRIVATE]]) {
    try { if (fs.statSync(f).mode & 0o077) fs.chmodSync(f, m); } catch (e) { /* not there yet */ }
  }
}
// What reading a settings file found: { o } (read whole: settings are an object, anything else, a list too, is a
// damaged file), { missing }, { damaged } (read whole, not settings), or { held: code }: it couldn't be read just now
// (Windows: held a moment by an antivirus, backup or sync program; EMFILE, EIO), tried again for about 1.5 s first.
// Such a file is still the user's settings: it is never taken as damaged, nor written over (see settingsHeld).
const sleepSync = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (e) { /* ignore */ } };
function readSettings(f, waits = [50, 100, 150, 200, 250, 300, 400]) {
  let text;
  for (let i = 0; ; i++) {
    try { text = fs.readFileSync(f, 'utf8'); break; } catch (e) {
      if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return { missing: true };
      if (i >= waits.length) return { held: e.code || String(e.message) };
      sleepSync(waits[i]);
    }
  }
  try { const o = JSON.parse(text); if (o && typeof o === 'object' && !Array.isArray(o)) return { o }; } catch (e) { /* damaged */ }
  return { damaged: true };
}
// settings.json, or its last good copy if it was damaged (a crash or power cut mid-save must not lose the pairings)
const settingsRead = readSettings(SETTINGS);
const onDisk = settingsRead.o || null;
// settings.json is there but couldn't be read: this run goes on with its last good copy (or the defaults) and writes
// nothing over it, and Flick starts again on it once it reads (see watchHeldSettings)
let settingsHeld = !!settingsRead.held;
if (settingsRead.held === 'EACCES' && !IS_WIN) {
  // (not a moment's lock on a Mac or Linux: a file this user isn't allowed to read, say left by Flick run as root. Put
  // aside, never deleted, so Flick can keep its settings again)
  try { fs.renameSync(SETTINGS, SETTINGS + '.unreadable'); settingsHeld = false; log('settings could not be read (EACCES): put aside as settings.json.unreadable'); } catch (e) { /* stays held */ }
}
if (settingsHeld) log('settings could not be read (' + settingsRead.held + '): running on ' + (fs.existsSync(SETTINGS + '.bak') ? 'the last good copy' : 'the defaults') + ', nothing is saved until they can be read');
if (settingsRead.damaged) {
  // kept as it was, for whoever wants to look into it, before a save writes over it
  try { fs.copyFileSync(SETTINGS, SETTINGS + '.damaged'); if (!IS_WIN) fs.chmodSync(SETTINGS + '.damaged', PRIVATE); } catch (e) { /* ignore */ }
  log('settings were damaged: kept as settings.json.damaged, ' + (fs.existsSync(SETTINGS + '.bak') ? 'the last good copy is used' : 'starting from the defaults'));
}
let store = Object.assign({}, DEFAULTS, onDisk || readSettings(SETTINGS + '.bak').o || {});
// (no welcome window nor "what's new" for a user Flick only can't read the settings of just now)
if (settingsHeld) store.firstRun = false;
// A new install: no settings, nor a last good copy of them (one damaged, held or put aside is a user's own). It starts
// with the animations off and shows the window's tour once. An update keeps what it had: animations on, no tour.
// (test copies start on an empty folder each: they're a new install only when a test asks, FLICK_TEST_NEW_INSTALL=1)
const freshInstall = !!settingsRead.missing && !settingsHeld && !fs.existsSync(SETTINGS + '.bak')
  && (!TEST_MODE || process.env.FLICK_TEST_NEW_INSTALL === '1');
if (freshInstall) { store.fx = false; store.tourDone = false; }
// (2: the bar at the bottom, Settings and Advanced settings as pages)
const TOUR_V = 2;
if (!settingsHeld && !settingsRead.missing && !(store.tourV >= TOUR_V)) store.tourDone = false;   // (an update: settings were there)
// What each entry's fields are: [kind, what a field of another kind becomes]. DROP: the entry can't work without it.
// Absent fix: the field goes. (tls: a phone paired over a secure link stays held to one: anything but true there would
// let it in over a plain link.) Fields not named here are left as they are (a newer version's).
const DROP = Symbol('drop');
const ENTRY_FIELDS = {
  devices: { token: ['string', DROP], name: ['string', (d) => (d.peer ? 'Flick device' : 'Phone')], added: ['number'], back: ['number'], homeProv: ['number'], phoneProv: ['number'],
    tls: ['boolean', true], peer: ['boolean', (d) => !!d.peer], kind: ['string', 'pc'] },
  peerLinks: { fp: ['string', DROP], token: ['string', DROP], name: ['string', 'Flick device'], kind: ['string', 'pc'], addrs: ['array', []], added: ['number'] },
  syncPairs: { folder: ['string', DROP], device: ['string', DROP], name: ['string', (p) => path.basename(p.folder)], phone: ['string', ''], created: ['number'], last: ['number'] },
  syncGone: { folder: ['string', DROP], device: ['string'], name: ['string', (p) => path.basename(p.folder)], at: ['number'] },
  notifyApps: { app: ['string'], last: ['number'], muted: ['boolean', (a) => a.muted === true] },
};
// A settings file edited by hand (or by another program) can hold a value of the wrong kind: such a setting goes back
// to its default, and an entry that isn't one (a phone, another computer's link) is dropped, so a stray value can't
// keep Flick or its window from working.
function sanitizeStore(s) {
  const fixed = [];
  const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
  for (const [k, def] of Object.entries(DEFAULTS)) {
    if (def === null || s[k] === undefined) continue;
    if (isObj(def) ? isObj(s[k]) : typeof s[k] === typeof def && (typeof def !== 'number' || Number.isFinite(s[k]))) continue;
    s[k] = isObj(def) ? {} : def;
    fixed.push(k);
  }
  const set = (k, v) => { s[k] = v; fixed.push(k); };
  if (s.side !== 'left' && s.side !== 'right') set('side', DEFAULTS.side);
  if (!(s.anchor >= 0 && s.anchor <= 1)) set('anchor', DEFAULTS.anchor);
  if (!(s.size > 0)) set('size', DEFAULTS.size);
  else if (s.size < 0.7 || s.size > 1.5) set('size', Math.max(0.7, Math.min(1.5, s.size)));      // (the window's slider's range)
  if (!(s.zoom >= 1 && s.zoom <= 2)) set('zoom', DEFAULTS.zoom);
  if (s.saveDir !== 'desktop' && s.saveDir !== 'downloads' && !path.isAbsolute(s.saveDir)) set('saveDir', DEFAULTS.saveDir);
  if (s.lastDir != null && !(typeof s.lastDir === 'string' && path.isAbsolute(s.lastDir))) set('lastDir', null);
  for (const k of ['id', 'name']) if (s[k] != null && typeof s[k] !== 'string') set(k, null);
  if (s.displayId != null && typeof s.displayId !== 'number') set('displayId', null);
  if (s.target != null && !isObj(s.target)) set('target', null);
  for (const k of ['peerLinks', 'acceptMode', 'syncPairs', 'syncGone', 'notifyApps']) if (s[k] != null && !isObj(s[k])) { delete s[k]; fixed.push(k); }
  for (const k of ['devices', 'peerLinks', 'syncPairs', 'syncGone', 'notifyApps']) {
    if (isObj(s[k])) for (const [id, v] of Object.entries(s[k])) if (!isObj(v)) { delete s[k][id]; fixed.push(k + ' entry'); }
  }
  // Each entry's fields too: one of the wrong kind showed as "Paired Invalid Date", a phone named "42" or a synced folder
  // "[object Object]". A field an entry can't work without (a phone's token, a synced folder) drops the entry; any other
  // goes back to what Flick would have put there, or goes (and the window shows that entry without it).
  for (const [k, fields] of Object.entries(ENTRY_FIELDS)) {
    if (!isObj(s[k])) continue;
    for (const [id, v] of Object.entries(s[k])) {
      let bad = false;
      for (const [f, [type, fix]] of Object.entries(fields)) {
        const x = v[f];
        if (x === undefined && fix !== DROP) continue;
        if (type === 'array' ? Array.isArray(x) : typeof x === type && (type !== 'number' || Number.isFinite(x))) continue;
        bad = true;
        if (fix === DROP) { delete s[k][id]; break; }
        if (fix === undefined) delete v[f]; else v[f] = typeof fix === 'function' ? fix(v) : fix;
      }
      if (bad) fixed.push(k + ' entry');
    }
  }
  return fixed;
}
const fixedSettings = sanitizeStore(store);
if (fixedSettings.length) log('settings of the wrong kind set back:', [...new Set(fixedSettings)].join(', '));
if (!store.id) store.id = rid(8);
// settings.json on disk is whole (it read fine, or Flick wrote it whole since): it may become the last good copy
let storeWhole = !!onDisk;
// Settings are written in the background, one write at a time: a temp file, flushed to disk, then renamed over
// settings.json (the copy that was there is kept first as settings.json.bak).
let saveTimer = null, saving = null, saveAgain = false;
function saveStore() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(writeStore, 150);
}
function writeStore() {
  saveTimer = null;
  if (settingsHeld) return;                         // (settings.json couldn't be read: never written over)
  if (saving) { saveAgain = true; return; }
  saving = (async () => {
    do {
      saveAgain = false;
      const tmp = SETTINGS + '.tmp';
      try {
        await fs.promises.mkdir(userDir, { recursive: true, mode: 0o700 });
        // (for this user only: see PRIVATE; one left from before is closed too. The copies take its mode.)
        const fh = await fs.promises.open(tmp, 'w', PRIVATE);
        try { if (!IS_WIN) await fh.chmod(PRIVATE); await fh.writeFile(JSON.stringify(store, null, 2)); await fh.sync(); } finally { await fh.close(); }
        if (app.isQuitting) return;                     // quitting: writeStoreNow writes it, and has the newest
        if (storeWhole) await fs.promises.copyFile(SETTINGS, SETTINGS + '.bak').catch(() => {});
        if (app.isQuitting) return;                     // (it may have come meanwhile: this copy is older than its)
        storeWhole = false;
        // (briefly locked by an antivirus: copied instead)
        try { await fs.promises.rename(tmp, SETTINGS); }
        catch (e) { await fs.promises.copyFile(tmp, SETTINGS); await fs.promises.unlink(tmp).catch(() => {}); }
        storeWhole = true;
      } catch (e) { log('save failed', e.message); }
    } while (saveAgain && !app.isQuitting);
  })().finally(() => { saving = null; });
}
// on quit, at once (the process ends right after)
function writeStoreNow() {
  clearTimeout(saveTimer); saveTimer = null;
  if (settingsHeld) return;
  try {
    fs.mkdirSync(userDir, { recursive: true, mode: 0o700 });
    const tmp = SETTINGS + '.tmpq';
    const fd = fs.openSync(tmp, 'w', PRIVATE);
    try { if (!IS_WIN) fs.fchmodSync(fd, PRIVATE); fs.writeSync(fd, JSON.stringify(store, null, 2)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    if (storeWhole) { try { fs.copyFileSync(SETTINGS, SETTINGS + '.bak'); } catch (e) { /* ignore */ } }
    try { fs.renameSync(tmp, SETTINGS); }
    catch (e) { fs.copyFileSync(tmp, SETTINGS); fs.unlinkSync(tmp); }     // briefly locked (antivirus): copy instead
  } catch (e) { log('save failed', e.message); }
}
// settings.json couldn't be read at the start: read again now and then. Once it reads, Flick starts again on it (when
// nothing is moving, as for an update): what this run changed meanwhile isn't kept, the pairings and settings are. If it
// is gone or damaged by then, there's nothing to keep and this run's settings are saved from now on.
function watchHeldSettings() {
  let tries = 0;
  function next() { setTimeout(check, (TEST_MODE && +process.env.FLICK_TEST_HELD_MS) || (tries < 12 ? 5000 : 60000)).unref(); }
  function check() {
    tries++;
    const r = readSettings(SETTINGS, []);
    if (r.held) return next();
    if (r.o) { log('settings can be read now: Flick starts again on them'); scheduleRestart('its settings'); return; }
    if (r.damaged) { try { fs.copyFileSync(SETTINGS, SETTINGS + '.damaged'); } catch (e) { /* ignore */ } }
    log('settings ' + (r.damaged ? 'were damaged (kept as settings.json.damaged)' : 'are gone') + ': this run\'s are saved from now on');
    settingsHeld = false; storeWhole = false;
    saveStore();
  }
  next();
}
if (settingsHeld) watchHeldSettings();

function defaultName() {
  return new Promise((resolve) => {
    let user = '';
    try { user = (os.userInfo().username || '').replace(/[^\p{L}\p{N} ._-]/gu, '').trim(); } catch (e) { /* ignore */ }
    const host = os.hostname() || '';
    const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
    const first = (s) => cap(String(s).trim().split(/[\s._-]+/)[0] || '');
    // A real-looking account name ("Alex Morgan") beats a generated host name ("DESKTOP-4F2K9QX")
    const looksLikeName = /^\p{L}[\p{L} .'-]{1,40}$/u.test(user) && !/^(user|admin|administrator|owner|pc)$/i.test(user) && !/^(desktop|laptop|win)\b/i.test(user);
    const genericHost = !host || /^(DESKTOP|LAPTOP|WIN|PC)-[A-Z0-9]{5,}$/i.test(host) || /^localhost(\.|$)/i.test(host);
    const pc = IS_MAC ? "'s Mac" : "'s PC";
    const fallback = looksLikeName ? first(user) + pc : (!genericHost ? host : (user ? first(user) + pc : IS_MAC ? 'My Mac' : 'My PC'));
    // the name the user gave this Mac; on Linux the account's full name (Windows: net user's "Full Name", below)
    if (IS_MAC) return plat.macName().then((n) => resolve(n && n.length <= 40 ? n : fallback));
    if (IS_LINUX && user) return plat.fullName(os.userInfo().username).then((full) => resolve(full.length > 1 ? first(full) + pc : fallback));
    if (!IS_WIN || !user) return resolve(fallback);
    execFile(winSys('net.exe'), ['user', os.userInfo().username], { windowsHide: true, timeout: 4000 }, (err, out) => {
      if (err || !out) return resolve(fallback);
      // value must be on the same line (otherwise an empty "Full Name" would take the next line, e.g. "Comment")
      const m = out.match(/^Full Name[ \t]+(\S[^\r\n]*)$/im);
      const full = m && m[1].trim();
      if (full && full.length > 1 && !/^comment$/i.test(full)) return resolve(first(full) + "'s PC");
      resolve(fallback);
    });
  });
}

// A chosen folder can be on a network drive that's offline, where even checking it can hang: that check runs in the
// background, and labels use its last answer. Saving checks it again (with a time limit) right before using it.
let customDir = { dir: null, ok: null };
function checkCustomDir() {
  const d = store.saveDir;
  if (!d || d === 'desktop' || d === 'downloads') return;
  if (customDir.dir !== d) customDir = { dir: d, ok: null };
  fs.stat(d, (e, st) => {
    if (customDir.dir !== d) return;
    const ok = !e && st.isDirectory();
    if (ok !== customDir.ok) { customDir.ok = ok; pushPanelState(); updateStage(); }
  });
}
setInterval(() => { checkCustomDir(); updateStage(); }, 30000).unref();
// Downloads. On Linux without the XDG user folders (no ~/.config/user-dirs.dirs), Electron gives the home folder itself
// for it: files would land loose in the home folder while the window says Downloads. ~/Downloads there.
function downloadsDir() {
  const d = app.getPath('downloads'), home = app.getPath('home');
  return IS_LINUX && path.resolve(d) === path.resolve(home) ? path.join(home, 'Downloads') : d;
}
function saveDirPath() {
  if (store.saveDir === 'desktop') return app.getPath('desktop');
  if (store.saveDir === 'downloads') return downloadsDir();
  if (store.saveDir && customDir.dir === store.saveDir && customDir.ok === true) return store.saveDir;
  if (store.saveDir && (customDir.dir !== store.saveDir || customDir.ok === null)) checkCustomDir();
  return app.getPath('desktop');
}
async function saveDirNow() {
  const d = store.saveDir;
  if (!d || d === 'desktop' || d === 'downloads') return saveDirPath();
  const ok = await Promise.race([
    fs.promises.stat(d).then((st) => st.isDirectory(), () => false),
    new Promise((r) => setTimeout(() => r(false), 5000)),
  ]);
  customDir = { dir: d, ok };
  return ok ? d : app.getPath('desktop');
}
// files Flick saved, for "Skip files already on the PC" (have.js)
const received = new ReceivedIndex(path.join(app.getPath('userData'), 'received.json'));
function saveDirLabel() {
  if (store.saveDir === 'desktop') return 'Desktop';
  if (store.saveDir === 'downloads') return 'Downloads';
  return path.basename(saveDirPath()) || 'folder';
}
// the folder of the user's own chosen last (the setting now, or before Desktop or Downloads was picked again): the
// window offers it back without the dialog
function lastFolder() {
  const d = store.saveDir !== 'desktop' && store.saveDir !== 'downloads' ? store.saveDir : store.lastDir;
  return typeof d === 'string' && path.isAbsolute(d) ? d : null;
}

// Where incoming files are staged until they're complete. Putting a file in place is a rename on the same drive, but
// from the folder they're staged in (below) to a save folder on another drive (D:, a network drive) it would copy
// every file a second time, with nothing on screen meanwhile. So for a save folder on another drive, files are staged
// on that drive, in a hidden ".flick-incoming" inside it (made when needed, removed when Flick is done with it); the
// free-space check before a transfer (server.js _roomFor) then looks at that drive too.
// Each user's files are staged in a folder of their own, closed to others (its owner is checked, and that it's no link:
// one someone else made first would refuse this user's files, or hold them where that someone can read and swap them
// before they're put in place), on disk. Windows and macOS give each user a temp folder of their own, on the system's
// drive: there. Linux has one for every user of the computer (/tmp), often in memory, where a big file finds no room or
// takes the memory: in the user's cache folder (~/.cache/flick), on the drive of the home folder's Desktop and
// Downloads. If that can't be had, in Flick's own folder.
const OWN_DIRS = !IS_WIN && typeof process.getuid === 'function';
// dir, made if it isn't there, when it's this user's alone; null when it's someone else's (or a link)
function ownDir(dir) {
  if (!OWN_DIRS) { fs.mkdirSync(dir, { recursive: true }); return dir; }
  fs.mkdirSync(path.dirname(dir), { recursive: true, mode: 0o700 });
  try { fs.mkdirSync(dir, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  const st = fs.lstatSync(dir);
  if (!st.isDirectory() || st.uid !== process.getuid()) return null;
  if (st.mode & 0o077) fs.chmodSync(dir, 0o700);
  return dir;
}
// The same for the hidden one on another drive (below), checked in the background: that drive can be a network one
// that hangs. A drive that can't close a folder (FAT, exFAT, a Windows drive: every folder on it is as open) is used
// anyway. { dir, made } or null.
async function ownDirThere(dir) {
  const made = await fs.promises.mkdir(dir, { mode: 0o700 }).then(() => true, (e) => { if (e.code === 'EEXIST') return false; throw e; });
  if (!OWN_DIRS) return { dir, made };
  const st = await fs.promises.lstat(dir);
  if (!st.isDirectory() || st.uid !== process.getuid()) return null;
  if (st.mode & 0o077) await fs.promises.chmod(dir, 0o700).catch(() => {});      // (one made by an older Flick: closed now)
  return { dir, made };
}
function cacheHome() { const x = process.env.XDG_CACHE_HOME; return x && path.isAbsolute(x) ? x : path.join(app.getPath('home'), '.cache'); }
// kind: 'incoming' (what phones and other computers send) or 'quickshare'
function stageIn(kind) {
  const first = IS_LINUX ? path.join(cacheHome(), 'flick', kind) : path.join(app.getPath('temp'), 'flick-' + kind);
  for (const d of [first, path.join(userDir, kind)]) {
    try { if (ownDir(d)) return d; } catch (e) { /* the next */ }
  }
  return path.join(userDir, kind);
}
let TEMP_STAGE = stageIn('incoming');
let QS_STAGE = stageIn('quickshare');
let stage = { save: null, dir: TEMP_STAGE }, stageQ = Promise.resolve();
const stageRefused = new Set();     // staging folders on another drive found to be someone else's (said once each)
const qsStage = () => (stage.dir === TEMP_STAGE ? QS_STAGE : stage.dir);
// ".flick-incoming-" and a name made from a key kept in this user's settings (0600) and the save folder: the same each
// time (what's left in it from before is swept as usual), unknown to anyone else
function stageName(save) {
  const crypto = require('crypto');
  if (typeof store.stageKey !== 'string' || !/^[0-9a-f]{32}$/.test(store.stageKey)) { store.stageKey = crypto.randomBytes(16).toString('hex'); saveStore(); }
  return '.flick-incoming-' + crypto.createHash('sha256').update(store.stageKey + '\0' + save).digest('hex').slice(0, 12);
}
function updateStage() {
  stageQ = stageQ.then(stageFor).catch((e) => log('staging', e.message));
  return stageQ;
}
async function stageFor() {
  const save = saveDirPath();
  let dir = TEMP_STAGE;
  try {
    const [a, b] = await Promise.all([fs.promises.stat(save), fs.promises.stat(path.dirname(TEMP_STAGE))]);
    if (a.dev !== b.dev) dir = path.join(save, '.flick-incoming');
  } catch (e) { /* the save folder can't be reached now: the temp folder it is */ }
  if (dir !== TEMP_STAGE) {
    try {
      let own = await ownDirThere(dir);
      if (!own) {
        // (someone else's, or a link to elsewhere: anyone who can write in the save folder could have made it first)
        if (!stageRefused.has(dir)) { stageRefused.add(dir); log('staging:', dir, 'isn’t this user’s own folder: not used'); }
        // Then one by a name only this user's Flick knows, so nobody can make it first: staged in the temp folder, every
        // item would be copied across drives into the save folder, and a copy sets modes by path there
        // (that name is seen in the save folder once made: should someone take it, a new key gives a new one)
        for (let i = 0; !own && i < (OWN_DIRS ? 3 : 0); i++) {
          if (i) { store.stageKey = null; log('staging: a folder by this user\'s own name was someone else\'s: a new one'); }
          const alt = path.join(save, stageName(save));
          own = await ownDirThere(alt).catch(() => null);
          if (own) dir = alt;
        }
      }
      if (!own) dir = TEMP_STAGE;
      else if (own.made && IS_WIN) execFile(winSys('attrib.exe'), ['+h', dir], { windowsHide: true }, () => {});
    } catch (e) { dir = TEMP_STAGE; }
  }
  try {
    // (made again if someone deleted it, as a cleanup of the temp folder does: still this user's alone)
    if (dir === TEMP_STAGE && !ownDir(TEMP_STAGE)) { TEMP_STAGE = stageIn('incoming'); QS_STAGE = stageIn('quickshare'); dir = TEMP_STAGE; }
  } catch (e) { /* as it is */ }
  const old = stage.dir;
  stage = { save, dir };
  if (server) server.tmpDir = dir;
  if (qs) qs.tmpDir = qsStage();
  if (old === dir) return;
  log('incoming files are staged in', dir);
  if (old !== TEMP_STAGE) fs.rmdir(old, () => {});                       // only once nothing is left in it
  // leftovers of transfers that never finished go as they do in temp (in Flick's first minute: what's from before)
  if (dir !== TEMP_STAGE) sweepDir(dir, !!startedAt && Date.now() - startedAt > 60000);
}

// ------------------------------------------------------------ windows
const PRELOAD = path.join(__dirname, 'preload.js');
let overlay = null, overlayShown = false, overlayReady = false, overlayLite = false;
let panel = null, catcher = null, tray = null;
let server = null;

// Every Flick window has the same preload, so any of them could send any message. What acts for the user (pairing,
// sending files, sharing, settings) is taken only from the window it belongs to; the test control passes TEST_EV.
const TEST_EV = { test: true };
const fromWin = (e, w) => !!e && (e === TEST_EV || (!!w && !w.isDestroyed() && e.sender === w.webContents));
const fromPanel = (e) => fromWin(e, panel);

function displays() { return screen.getAllDisplays(); }
function targetDisplay() {
  const ds = displays();
  if (store.displayId) { const d = ds.find((x) => x.id === store.displayId); if (d) return d; }
  return ds.reduce((best, d) => {
    if (store.side === 'right') return (d.bounds.x + d.bounds.width > best.bounds.x + best.bounds.width) ? d : best;
    return d.bounds.x < best.bounds.x ? d : best;
  }, ds[0]);
}

function overlayBounds() {
  const b = targetDisplay().bounds;
  return { x: b.x, y: b.y, width: b.width, height: b.height - 1 }; // 1px short so Windows never treats it as a fullscreen app
}

function kFactor() { return 0.66 * (store.size || 1); }

function phoneScreen() {
  return (server && server.session && server.session.screen) || { w: 412, h: 915, dpr: 2.6 };
}

// Reduce effects: the user's setting once set, else the system's "reduce motion" (see sysReduceNow)
let sysReduce = false;
const reduceFx = () => (store.reduceFxSet ? !!store.reduceFx : !!store.reduceFx || sysReduce);
function overlayConfig() {
  const d = targetDisplay();
  const ob = overlayBounds();
  const taskbar = Math.max(0, (d.bounds.y + d.bounds.height) - (d.workArea.y + d.workArea.height));
  return { W: ob.width, H: ob.height, dispW: d.bounds.width, dispH: d.bounds.height, dpr: d.scaleFactor || 1,
    side: store.side, anchor: store.anchor, k: kFactor(), sound: !!store.sound, volume: volumeOf(), reduceFx: reduceFx(),
    taskbar: taskbar || 0, saveLabel: saveDirLabel(), theme: themeName(), fx: fxOn() };
}

// What the overlay page reports (graphics or a sound that failed, the light version taken, an error in an animation) goes
// to Flick's log, so a user's log shows it: each message once, and at most 40 a run, so a page failing every frame
// can't fill the disk or slow Flick down.
const OVL_MAX = 40;
const ovlSeen = new Set();
let ovlCount = 0;
function overlayConsole(e, lvl, msg, line, src) {
  // (Electron 35 and newer give the details on the event; older versions, as arguments)
  const message = e && typeof e.message === 'string' ? e.message : msg;
  const level = e && typeof e.level === 'string' ? e.level : ['debug', 'info', 'warning', 'error'][lvl] || 'info';
  if (typeof message !== 'string' || !message.trim() || level === 'debug' || ovlCount > OVL_MAX) return;
  const at = (e && e.sourceId) || src, ln = (e && e.lineNumber) || line;
  const where = level === 'error' && at ? ' (' + String(at).split(/[\\/]/).pop() + (ln ? ':' + ln : '') + ')' : '';
  const text = (level === 'error' ? 'overlay error: ' : 'overlay: ') + message.replace(/\s+/g, ' ').trim().slice(0, 300) + where;
  if (ovlSeen.has(text)) return;
  ovlSeen.add(text);
  if (++ovlCount > OVL_MAX) return log('overlay: more messages, not logged');
  log(text);
}

// Linux under X11 with no compositing window manager (Openbox, i3 and other tiling ones, Xfce or MATE with compositing
// off): no window can be see-through there, and the overlay's empty screen would be a black screen over everything for
// as long as an effect plays (and the see-through parts of the card and the edge strip black). There the effects don't
// play (what one says that matters is said another way: fxPlain), and the card and the strip are opaque. Compositing
// can be turned on or off while Flick runs: it's asked again before an effect, at most every 10 s. (Wayland, XWayland
// included, is always composited, as Windows and macOS are; an X server that can't be asked is taken to be too.)
// (test copies run on a virtual screen with no window manager at all: they play the effects as before, unless a test
// asks for the check with FLICK_TEST_CM_CHECK=1)
let noComp = false, compAt = -Infinity, compAsk = null, compErr = false;
const compAsked = !TEST_MODE || process.env.FLICK_TEST_CM_CHECK === '1';
function compCheck(force) {
  if (!IS_LINUX || WAYLAND || !compAsked || compAsk || (!force && mono() - compAt < 10000)) return;
  compAt = mono();
  compAsk = require('./clipx11').composited().then((v) => !v, (e) => { if (!compErr) log('compositor check:', e.message); compErr = true; return false; })
    .then((off) => {
      compAsk = null;
      if (off === noComp) return;
      noComp = off;
      log(off ? 'no compositing on this desktop: effects off, card and edge strip opaque' : 'compositing on' + (store.fx ? ': effects back' : ''));
      if (off) fxStop();
      // (their windows are made again, see-through or not)
      if (card) { dropCard(); cardTick(); }
      if (catcher) { if (hoverOn) catcherLeave(); const c = catcher; catcher = null; c.destroy(); ensureCatcher(); }
    });
}
// The animations play: on (Settings › Advanced settings › Look and sound › Animations) and a desktop that can show them
const fxOn = () => !!store.fx && !noComp;
// what an effect said that matters, without it: a hint in the window's note (or the system's notification while the
// window is shut); the card shows what came in and how it went (cardTick), and the window says a look can't show.
// With the card turned off too, and the window shut, a file saved or one that didn't arrive is a notification.
function plainNote(text) {
  try {
    const { Notification } = require('electron');
    if (Notification.isSupported()) new Notification({ title: 'Flick', body: text, silent: true }).show();
  } catch (e) { log('notification failed', e.message); }
}
function fxPlain(type, data) {
  if (type === 'hint' && data && data.text) {
    if (panelUp()) panelSend('panel:note', { text: data.text });
    else plainNote(data.text);
  } else if (type === 'demo') {
    panelSend('panel:note', { text: noComp ? 'The animations can’t show on this desktop: turn on compositing (desktop effects) in its settings to see them.'
      : 'Animations are off. Turn them on in Settings › Advanced settings › Look and sound to see them.' });
  } else if ((type === 'saved' || type === 'failed') && data && store.xferCard === false && !panelUp()) {
    const t = transfers.get(data.tid), name = (data && data.name) || (t && t.name) || '';
    if (type === 'saved') plainNote((name ? name + ' saved' : 'Saved') + (data.where ? ' to ' + data.where : '') + (data.note ? '. ' + data.note : ''));
    else plainNote(name ? name + ' didn’t arrive.' : 'A file didn’t arrive.');
  }
}
// The animations turned off (here, or by the desktop): an effect that's playing stops and the overlay goes
function fxStop() {
  if (!overlay || !(overlayShown || revealT)) return;
  clearTimeout(revealT); revealT = null; held = null;
  overlay.webContents.send('fx:reset');
  if (overlayShown) { overlay.hide(); overlayShown = false; dropShot(); }
}

function createOverlay() {
  compCheck(true);
  const ob = overlayBounds();
  overlay = new BrowserWindow({
    x: ob.x, y: ob.y, width: ob.width, height: ob.height,
    transparent: true, frame: false, resizable: false, movable: false, minimizable: false, maximizable: false,
    fullscreenable: false, skipTaskbar: true, focusable: false, show: false, hasShadow: false, alwaysOnTop: true,
    thickFrame: false, backgroundColor: '#00000000', title: 'Flick Overlay',
    // macOS: a panel never takes focus and can float over full-screen apps; the whole screen, menu bar included
    ...(IS_MAC ? { type: 'panel', enableLargerThanScreen: true } : {}),
    webPreferences: { preload: PRELOAD, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required', spellcheck: false },
  });
  overlay.setAlwaysOnTop(true, 'screen-saver');
  // on whichever desktop (Space, workspace) the user is on
  if (!IS_WIN) overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  overlay.setIgnoreMouseEvents(true);
  overlay.setMenu(null);
  overlay.webContents.on('console-message', overlayConsole);
  overlay.loadFile(path.join(__dirname, 'overlay', 'overlay.html'));
  overlay.on('closed', () => { overlay = null; overlayShown = false; overlayReady = false; overlayLite = false; });
  // the overlay's renderer died (GPU process crash, out of memory): start a fresh one
  overlay.webContents.on('render-process-gone', (_e, d) => {
    log('overlay renderer gone:', d && d.reason);
    const o = overlay; overlay = null; overlayShown = false; overlayReady = false; overlayLite = false;
    try { o.destroy(); } catch (e) { /* ignore */ }
    setTimeout(() => { if (!overlay && !app.isQuitting) createOverlay(); }, 1000);
  });
}

// The GPU was reset: reload the overlay page so its effects work again. At most once per 10 s, in case the GPU keeps
// failing, but a loss in that time (a second reset right after the first: docking, a driver update) is put off, never
// dropped: the page it happened to draws nothing until it's loaded again.
let lostAt = 0, lostT = null;
ipcMain.on('fx:lost', () => {
  if (!overlay || lostT) return;
  const wait = Math.max(500, lostAt + 10000 - Date.now());
  log('overlay graphics reset: reloading it' + (wait > 500 ? ' in ' + Math.round(wait / 1000) + ' s' : ''));
  overlayReady = false; overlayLite = false;
  if (overlayShown) { overlay.hide(); overlayShown = false; }
  lostT = setTimeout(() => { lostT = null; lostAt = Date.now(); if (overlay) overlay.webContents.reload(); }, wait);
});

function placeOverlay() {
  if (!overlay) return;
  const ob = overlayBounds();
  overlay.setBounds(ob);
  overlay.webContents.send('fx:config', overlayConfig());
}

// the animations (pc/overlay/looks); 'surprise': one of them at random for each flick. An older setting (Roadster,
// Liquid, Teleport, Halo: gone) is Meteor now.
const THEMES = ['meteor', 'volt', 'warp', 'glitch', 'surprise'];
function themeName() { return THEMES.includes(store.theme) ? store.theme : 'meteor'; }
// the look a card leaves this PC with (Surprise me: a different one each time, never the same twice running); the
// device it goes to plays the same as it arrives
// Where this PC's sends go (the shortcut, the screen's edge, files dropped on the window, Send files): the phone in use,
// as always, or another computer picked in the window (store.target), while it's paired
function targetPc() {
  const t = store.target;
  return t && t.kind === 'pc' && peers && store.peerLinks && store.peerLinks[t.id] ? t.id : null;
}
// A send to a computer that's still taking an earlier one (the shortcut, the screen's edge or Explorer's Send to used
// again meanwhile) waits for it and goes right after, in turn; one for a computer removed meanwhile doesn't go
const pcWaiting = new Map();           // computer id -> the paths of each send waiting for it
function sendToPc(id, paths) {
  const l = store.peerLinks && store.peerLinks[id];
  if (!peers || !l || !paths || !paths.length) return;
  if (peers.busy.has(id) || pcWaiting.has(id)) {
    const q = pcWaiting.get(id) || [];
    if (q.length >= 20) { panelSend('panel:note', { text: 'Wait until what’s going to ' + l.name + ' is sent.' }); return; }
    q.push(paths.slice(0, 1000));
    pcWaiting.set(id, q);
    log('a send waits for the one going to', id);
    const what = paths.length === 1 ? path.basename(String(paths[0])) : paths.length.toLocaleString() + ' items';
    panelSend('panel:note', { text: what + (paths.length === 1 ? ' goes' : ' go') + ' to ' + l.name + ' right after what’s going there now.' });
    return;
  }
  peers.send(id, paths.slice(0, 1000), { look: sendLook() });
}
// (each time the list of devices changes: a send that ended lets the next one go)
function sendWaiting() {
  for (const [id, q] of pcWaiting) {
    if (!peers || !store.peerLinks || !store.peerLinks[id]) { pcWaiting.delete(id); log('sends waiting for a computer removed meanwhile didn’t go'); continue; }
    if (peers.busy.has(id)) continue;
    const paths = q.shift();
    if (!q.length) pcWaiting.delete(id);
    peers.send(id, paths, { look: sendLook() });
  }
}
let lastLook = null;
function sendLook() {
  const th = themeName();
  if (th !== 'surprise') return th;
  const opts = ['meteor', 'volt', 'warp', 'glitch'].filter((l) => l !== lastLook);
  lastLook = opts[Math.floor(Math.random() * opts.length)];
  return lastLook;
}
function volumeOf() { const v = +store.volume; return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.7; }

// Moments that start from a quiet screen take a fresh photo of the desktop first (bent, dimmed and lit by the
// animations), while the overlay is still hidden so it can never photograph itself.
const SHOT_FIRST = { lift: true, hold: true, outgoing: true, demo: true, 'edge-hover': true, preview: true, connect: true, hint: true };
const SHOT_MS = 600;            // a slower photo is given up on: the effects run without it rather than wait
// once the overlay hides, its desktop photo is out of date: drop it so no later effect paints an old screen
function dropShot() { lastShot = 0; if (overlay) overlay.webContents.send('fx:noshot'); }
// Effects that come while the photo is being taken wait for it here: the overlay's clock starts when it gets them,
// so sent at once they'd play (partly or wholly) while it's still hidden. They go the moment it shows.
let revealT = null, held = null;
function reveal() {
  clearTimeout(revealT); revealT = null;
  if (!fxOn()) { held = null; return; }
  if (overlay && !overlayShown) {
    overlay.setBounds(overlayBounds());
    overlay.showInactive();
    overlay.setAlwaysOnTop(true, 'screen-saver');
    overlayShown = true;
  }
  const q = held;
  held = null;
  if (q && overlay) for (const [type, data] of q) overlay.webContents.send('fx:' + type, data);
}
function ensureShown(withShot) {
  if (!overlay || overlayShown || revealT) return;
  if (withShot && shotAllowed() && Date.now() - lastShot > 1500) {
    // photograph the desktop first and only then show the overlay, so the picture never contains the overlay itself;
    // a slow capture is abandoned (the effects then run without it) rather than holding the animation back for long
    let done = false;
    const go = () => { if (done) return; done = true; reveal(); };
    held = [];
    revealT = setTimeout(() => { shotAbandoned = true; go(); }, SHOT_MS);
    shotAbandoned = false;
    captureShot().then(go, go);
  } else reveal();
}
let lastFx = 0;
function fx(type, data) {
  compCheck();
  if (!fxOn()) { fxPlain(type, data); return; }
  // (no overlay just now, its page being made again a moment after it died: what matters is said the plain way, so a
  // hint, or a file saved or not arrived, isn't lost. Not a demo: that would say the animations are off.)
  if (!overlay) { if (type !== 'demo') fxPlain(type, data); return; }
  lastFx = mono();
  ensureShown(!!SHOT_FIRST[type]);
  if (held) held.push([type, data]);
  else overlay.webContents.send('fx:' + type, data);
}

// Nothing may stay on screen without a reason: a drag the phone never finished, a transfer that stopped sending, or
// an overlay that is up with nothing going on is cleared within a minute.
// A thrown file whose upload hasn't started waits its turn on the phone (it sends a couple at a time): that isn't a
// stall. It's forgotten quietly after hours; if it starts after that, the phone says it was sent and it comes in anew.
const QUEUED_KEEP_MS = 6 * 3600 * 1000;
function watchdog() {
  const now = mono();
  for (const t of [...transfers.values()]) {
    if (t.done) continue;
    // the end-of-transfer check reads the whole file back: nothing arrives meanwhile, but it's alive
    if (t.state === 'dropped' && server && server.uploadChecking(t.tid)) { t.seen = now; continue; }
    const quiet = now - (t.seen || t.t0);
    if (t.state === 'dropped' && t.upload === 'none') {
      // another Flick device sends what it announced right away (it never keeps it for later, as a phone does): one
      // that doesn't within a minute went (its app closed, its network dropped) and its card goes too
      if ((t.peer || (server && server.isPeerTransfer(t.tid))) && quiet > 60000) {
        log('transfer', t.tid, 'announced by another device and never sent: cancel');
        fx('cancel', { tid: t.tid });
        server.pushToPhone({ t: 'failed', tid: t.tid, why: 'stalled' });
        clearTimeout(t.failT);
        discard(t);
      } else if (quiet > QUEUED_KEEP_MS) { log('transfer', t.tid, 'never started: forgotten'); discard(t); }
    } else if (t.state === 'lifted' && quiet > 60000) {
      log('transfer', t.tid, 'lifted with no news for', Math.round(quiet / 1000) + 's: cancel');
      fx('cancel', { tid: t.tid });
      if (server) server.abortUpload(t.tid);
      clearTimeout(t.failT);
      discard(t);
    } else if (t.state !== 'lifted' && t.state !== 'dropped' && quiet > 10 * 60000) {
      discard(t);                                        // a leftover (should not happen): don't let it block updates
    } else if (t.state === 'dropped' && t.upload !== 'done' && quiet > 45000 && !(server && server.uploadPaused(t.tid))) {
      // (a paused one waits for its phone to come back: the server gives up on it after hours, see 'upload-failed')
      log('transfer', t.tid, 'stalled for', Math.round(quiet / 1000) + 's: fail');
      movingEnd(t, false, 'stalled');
      if (t.qs && qs) { qs.cancel(t.tid.slice(3), 'stalled'); if (!transfers.has(t.tid)) continue; }   // its failure path cleans up
      fx('failed', { tid: t.tid });
      if (!t.qs && server) { server.pushToPhone({ t: 'failed', tid: t.tid, why: 'stalled' }); server.abortUpload(t.tid); hist({ dir: 'in', tid: t.tid, name: t.name, size: 0, ok: false, how: 'fling' }); }
      clearTimeout(t.failT);
      discard(t);
    }
  }
  const active = [...transfers.values()].some((t) => !t.done && !t.paused && (t.state === 'lifted' || t.state === 'dropped'));
  if (overlay && overlayShown && !active && now - lastFx > 20000) {
    log('overlay up with nothing going on: cleared');
    overlay.webContents.send('fx:reset');
    overlay.hide();
    overlayShown = false;
    dropShot();
  }
}
setInterval(watchdog, 5000).unref();
// (the edge strip stays up with no effect to ask again: it's asked a minute on)
setInterval(() => { if (catcher && mono() - compAt > 60000) compCheck(); }, 15000).unref();

// The system's "reduce motion" (Windows: Animation effects off; macOS: Reduce motion), as Chromium sees it in the
// overlay's page (it says so as it loads and when it changes; Electron's own reading as well): Reduce effects follows it
// until the user sets the switch.
function sysReduceNow(fromPage) {
  let os = false;
  try { const a = require('electron').systemPreferences.getAnimationSettings(); os = !!(a && a.prefersReducedMotion); } catch (e) { /* not there */ }
  const v = os || !!fromPage;
  if (v === sysReduce) return;
  sysReduce = v;
  log('system reduce motion:', v);
  placeOverlay();
  pushPanelState();
}
ipcMain.on('fx:motion', (e, m) => { if (fromWin(e, overlay) && m && typeof m === 'object') sysReduceNow(m.reduce === true); });
ipcMain.on('fx:ready', () => { overlayReady = true; overlayLite = false; if (overlay) overlay.webContents.send('fx:config', overlayConfig()); });
// The overlay's effects do without the desktop photo where they're drawn by the processor (no graphics chip) or can't
// be shown: it says so once its graphics are set up, after each load of its page. No photo is taken for it then, so a
// flick from a quiet screen isn't held back for one (a few hundred ms there). Until it has said: a photo, as before.
ipcMain.on('fx:lite', (e, m) => { if (fromWin(e, overlay) && m && typeof m === 'object') overlayLite = m.lite === true; });
ipcMain.on('fx:idle', () => {
  if (overlay && overlayShown) { overlay.hide(); overlayShown = false; dropShot(); }
});
// a card from the phone just hit the desktop: the phone that threw it gives a short thud
ipcMain.on('fx:landed', (e, m) => {
  if (!fromWin(e, overlay) || !m || typeof m.tid !== 'string' || !server) return;
  if (transfers.has(m.tid)) server.pushToPhone({ t: 'landed', tid: m.tid });
});

// ------------------------------------------------------------ the send shortcut
// Ctrl+Alt+F (Cmd+Option+F on a Mac) sends the files selected in File Explorer or Finder (on Linux, where file managers
// don't say what's selected: the files copied) to the phone, as Send to does. Settings can turn it off (another app
// may want the keys; some keyboards type a character with AltGr+F, which Windows sees as Ctrl+Alt+F).
const HOTKEY = 'CommandOrControl+Alt+F';
let hotkeyOk = false, hotkeyBusy = false, selNow = null;
function applyHotkey() {
  const want = store.hotkey !== false;
  if (want && !hotkeyOk) {
    try { hotkeyOk = globalShortcut.register(HOTKEY, () => { onHotkey(); }); } catch (e) { hotkeyOk = false; }
    if (!hotkeyOk) log('send shortcut: another app has', HOTKEY);
  } else if (!want && hotkeyOk) {
    try { globalShortcut.unregister(HOTKEY); } catch (e) { /* ignore */ }
    hotkeyOk = false;
    if (selNow) selNow.stop();
  }
}
// Under Wayland (Linux), Flick runs through X11, and keys it registers only reach it while one of its own windows is in
// front. A keyboard shortcut set in the system's settings can run Flick with this switch instead: it does what the keys
// do. (A second start hands it to the running Flick.)
const SEND_SWITCH = '--send-shortcut';
const WAYLAND = IS_LINUX && !!(process.env.WAYLAND_DISPLAY || process.env.XDG_SESSION_TYPE === 'wayland');
function sendCommand() {
  const p = process.env.APPIMAGE || path.join(path.dirname(process.execPath), 'flick');      // the AppImage, or the tar.gz's flick
  return (/\s/.test(p) ? '"' + p + '"' : p) + ' ' + SEND_SWITCH;
}
async function onHotkey() {
  if (hotkeyBusy) return;
  hotkeyBusy = true;
  try {
    fx('hint', { pulse: true });                   // heard: the phone's edge lights up at once
    if (!selNow) { const { SelNow } = require('./selnow'); selNow = new SelNow({ log }); }
    const sel = await selNow.ask();
    log('send shortcut:', sel.paths.length, 'file(s)', sel.kind);
    if (sel.paths.length) {
      if (!store.hotkeyUsed) { store.hotkeyUsed = true; saveStore(); }
      queueForPhone(sel.paths);
      return;
    }
    const text = sel.kind === 'denied' ? 'Let Flick use Finder: System Settings › Privacy & Security › Automation'
      : sel.kind === 'unanswered' ? 'Flick can’t read the clipboard. Quit and reopen Flick, then try again'
        : IS_LINUX ? 'Copy files first (Ctrl+C), then press Ctrl+Alt+F'
          : IS_MAC ? 'Select files in Finder first' : 'Select files in File Explorer first';
    fx('hint', { text });
  } catch (e) { log('send shortcut failed', e.message); }
  finally { hotkeyBusy = false; }
}

// The photo of the desktop needs Screen Recording permission on macOS, which Flick doesn't ask for (the effects do
// without it unless the user gave it), and under Wayland every capture would ask through a dialog of its own.
function shotAllowed() {
  if (overlayLite) return false;
  if (IS_MAC) { try { return require('electron').systemPreferences.getMediaAccessStatus('screen') === 'granted'; } catch (e) { return false; } }
  return !(IS_LINUX && (process.env.WAYLAND_DISPLAY || process.env.XDG_SESSION_TYPE === 'wayland'));
}

// full-resolution photo of the desktop (raw BGRA pixels, so it lines up pixel-for-pixel with the real screen)
let shotBusy = null, lastShot = 0, shotAbandoned = false;
function captureShot() {
  if (!overlay) return Promise.resolve();
  if (shotBusy) return shotBusy;
  shotBusy = (async () => {
    try {
      const d = targetDisplay();
      const w = Math.round(d.size.width * d.scaleFactor), h = Math.round(d.size.height * d.scaleFactor);
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: w, height: h } });
      const src = sources.find((s) => String(s.display_id) === String(d.id)) || sources[0];
      if (shotAbandoned) {
        // the overlay went up before this picture was taken: it may contain the overlay, and the old one is stale
        log('shot too slow, effects run without it');
        if (overlay) overlay.webContents.send('fx:noshot');
      } else if (src && src.thumbnail && !src.thumbnail.isEmpty() && overlay) {
        const sz = src.thumbnail.getSize();
        lastShot = Date.now();
        overlay.webContents.send('fx:shot', { bgra: src.thumbnail.toBitmap(), w: sz.width, h: sz.height });
      }
    } catch (e) { log('shot failed', e.message); }
  })();
  shotBusy.finally(() => { shotBusy = null; });
  return shotBusy;
}

// ------------------------------------------------------------ catcher (drag a PC file to the screen edge -> phone)
function catcherBounds() {
  // 1px strip on the phone-side screen edge, only as tall as the phone (so the rest of the edge stays untouched)
  const b = targetDisplay().bounds;
  const h = Math.round(Math.min(b.height, Math.max(260, phoneScreen().h * kFactor() * 1.15)));
  const y = Math.round(b.y + Math.max(0, Math.min(b.height - h, store.anchor * b.height - h / 2)));
  const x = store.side === 'right' ? b.x + b.width - 1 : b.x;
  return { x, y, width: 1, height: h };
}
let catcherYieldT = null, catcherGoneAt = 0, catcherReviveT = null;
let hoverOn = false;       // (a drag is over the strip: the phone's edge is lit)
ipcMain.on('catcher:yield', () => {
  // The user clicked the very edge pixel: get out of the way for a few seconds.
  if (!catcher) return;
  catcher.setIgnoreMouseEvents(true);
  clearTimeout(catcherYieldT);
  catcherYieldT = setTimeout(() => { if (catcher) catcher.setIgnoreMouseEvents(false); }, 5000);
});
function ensureCatcher() {
  const want = store.edgeSend && ((server && server.connected) || !!targetPc());
  if (!want) { if (catcher) { catcher.destroy(); catcher = null; } return; }
  if (catcher) { catcher.setBounds(catcherBounds()); return; }
  const cb = catcherBounds();
  catcher = new BrowserWindow({
    x: cb.x, y: cb.y, width: cb.width, height: cb.height, frame: false, transparent: !noComp, resizable: false, movable: false,
    minimizable: false, maximizable: false, fullscreenable: false, skipTaskbar: true, focusable: false, show: false,
    hasShadow: false, alwaysOnTop: true, thickFrame: false, backgroundColor: noComp ? '#202020' : '#01000000', title: 'Flick Edge',
    webPreferences: { preload: PRELOAD, backgroundThrottling: false, spellcheck: false },
  });
  catcher.setAlwaysOnTop(true, 'screen-saver');
  if (!IS_WIN) catcher.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  catcher.setMenu(null);
  catcher.loadFile(path.join(__dirname, 'catcher', 'catcher.html'));
  catcher.once('ready-to-show', () => { if (catcher) { catcher.showInactive(); catcher.setBounds(catcherBounds()); } });
  const me = catcher;
  catcher.on('closed', () => { if (catcher === me) catcher = null; });
  // Its page died (out of memory, a GPU or driver fault, an antivirus): the dead strip would stay on top doing nothing,
  // so it's made anew in a moment, as the overlay is. One that keeps dying is made again less often.
  catcher.webContents.on('render-process-gone', (_e, d) => {
    if (catcher !== me) return;
    log('edge strip page gone:', d && d.reason);
    catcher = null;
    if (hoverOn) catcherLeave();   // (a drag it was showing ends: the phone's edge doesn't stay lit)
    try { me.destroy(); } catch (e) { /* ignore */ }
    const wait = Date.now() - catcherGoneAt < 30000 ? 15000 : 1000;
    catcherGoneAt = Date.now();
    clearTimeout(catcherReviveT);
    catcherReviveT = setTimeout(() => { catcherReviveT = null; if (!catcher && !app.isQuitting) ensureCatcher(); }, wait);
  });
}

function overlayYFromScreenY(sy) { return sy - overlayBounds().y; }
function phoneYFromOverlayY(oy) {
  const ps = phoneScreen();
  const H = overlayBounds().height;
  return (oy - store.anchor * H) / kFactor() + ps.h / 2;
}

ipcMain.on('catcher:hover', (_e, d) => {
  if (!catcher || (!targetPc() && (!server || !server.connected))) return;
  const sy = catcher.getBounds().y + ((d && d.y) || 0);
  const oy = overlayYFromScreenY(sy);
  fx('edge-hover', { on: true, y: oy, h: phoneScreen().h * kFactor() * 0.55 });
  if (!targetPc() && (!hoverOn || Math.random() < 0.5)) server.pushToPhone({ t: 'edge', on: true, y: phoneYFromOverlayY(oy) });
  hoverOn = true;
});
function catcherLeave() {
  hoverOn = false;
  fx('edge-hover', { on: false });
  if (server) server.pushToPhone({ t: 'edge', on: false });
}
ipcMain.on('catcher:leave', catcherLeave);

const MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', heic: 'image/heic', heif: 'image/heif', svg: 'image/svg+xml',
  mp4: 'video/mp4', mov: 'video/quicktime', mkv: 'video/x-matroska', webm: 'video/webm', avi: 'video/x-msvideo', m4v: 'video/mp4', '3gp': 'video/3gpp',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg', flac: 'audio/flac', aac: 'audio/aac',
  pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json', html: 'text/html', htm: 'text/html',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  zip: 'application/zip', rar: 'application/vnd.rar', '7z': 'application/x-7z-compressed', apk: 'application/vnd.android.package-archive',
};
function extOf(name) { const m = /\.([^.]+)$/.exec(name || ''); return m ? m[1].toLowerCase() : ''; }
function kindOf(name) {
  const m = MIME[extOf(name)] || '';
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  return 'doc';
}

// A small picture of a file for a card that flies, or null. Windows and macOS have the system's own thumbnails (often
// made already). Linux has none to ask for: a photo is decoded by the overlay's page, in the background there, rather
// than here, where decoding a large photo would hold up every transfer and message for its whole length.
async function thumbFor(p) {
  const kind = kindOf(p);
  try {
    if ((IS_WIN || IS_MAC) && (kind === 'image' || kind === 'video' || extOf(p) === 'pdf')) {
      const t = await nativeImage.createThumbnailFromPath(p, { width: 360, height: 360 });
      if (t && !t.isEmpty()) return { url: 'data:image/jpeg;base64,' + t.toJPEG(82).toString('base64'), w: t.getSize().width, h: t.getSize().height };
    } else if (kind === 'image') return await pageThumb(p);
  } catch (e) { /* no thumb */ }
  return null;
}
let thumbN = 0;
const thumbWait = new Map();       // request id -> resolve
ipcMain.on('fx:thumbed', (e, m) => {
  const done = m && fromWin(e, overlay) && thumbWait.get(m.id);
  const ok = done && typeof m.url === 'string' && m.url.startsWith('data:image/jpeg;base64,') && m.w > 0 && m.h > 0;
  if (done) done(ok ? { url: m.url, w: m.w, h: m.h } : null);
});
async function pageThumb(p) {
  if (!overlay || !overlayReady) return null;
  const st = await fs.promises.stat(p);
  if (!st.isFile() || st.size > 40 * 1024 * 1024) return null;
  const data = await fs.promises.readFile(p);
  if (!overlay) return null;
  const id = ++thumbN;
  return new Promise((resolve) => {
    const done = (v) => { clearTimeout(t); thumbWait.delete(id); resolve(v); };
    const t = setTimeout(() => done(null), 5000);
    thumbWait.set(id, done);
    overlay.webContents.send('fx:thumb', { id, data, max: 360 });
  });
}

ipcMain.on('catcher:drop', async (e, d) => {
  if (!fromWin(e, catcher)) return;
  hoverOn = false;
  // to another computer picked in the window: it goes there (its cards leave this screen in the same look)
  if (targetPc()) { fx('edge-hover', { on: false }); sendToPc(targetPc(), (d && d.paths) || []); return; }
  if (!server || !server.connected) return;
  const sy = catcher ? catcher.getBounds().y + ((d && d.y) || 0) : overlayBounds().y + store.anchor * overlayBounds().height;
  fx('edge-hover', { on: false });
  const n = await sendPathsToPhone((d && d.paths) || [], sy);
  if (!n) server.pushToPhone({ t: 'edge', on: false });
});

// files (folders are opened up, up to max files (MAX_SEND: what goes to a phone at once), DEPTH_SEND folders down) in
// the order given; .more: there were more than that; .deep: files further down were left out. Inside a folder, links (symbolic links, Windows junctions)
// aren't followed, as peerlink.js walk doesn't: what goes is what's in the folder, never a file somewhere else, nor
// the folder again (a link to itself inside sent each file over and over). What the user picked is followed if it's
// a link: they picked it.
const MAX_SEND = 100, DEPTH_SEND = 6;
function expandPaths(list, max = MAX_SEND) {
  const out = [];
  out.more = false; out.deep = false; out.max = max;
  const have = new Set();     // a file given twice (a folder and a file in it, the same path again) counts and goes once
  // Is there a file in this folder (names: what's in it) or further down? Links aren't followed, as above: only real files
  // left out are said to be. (Looked through up to a few thousand entries; past that, taken that there is.)
  function fileBelow(dir, names) {
    let budget = 4000;
    const look = (d, list) => {
      for (const n of list) {
        if (--budget < 0) return true;
        const p = path.join(d, n);
        let st;
        try { st = fs.lstatSync(p); } catch (e) { continue; }
        if (st.isFile()) return true;
        if (!st.isDirectory()) continue;
        let kids = [];
        try { kids = fs.readdirSync(p).filter((k) => !k.startsWith('.')); } catch (e) { continue; }
        if (look(p, kids)) return true;
      }
      return false;
    };
    return look(dir, names);
  }
  const walk = (p, depth) => {
    if (out.more) return;
    let st;
    try { st = depth === 0 ? fs.statSync(p) : fs.lstatSync(p); } catch (e) { return; }
    if (st.isFile()) {
      const k = path.resolve(p);
      if (have.has(k)) return;
      if (out.length < max) { have.add(k); out.push(p); } else out.more = true;
      return;
    }
    if (!st.isDirectory()) return;
    let names = [];
    try { names = fs.readdirSync(p).filter((n) => !n.startsWith('.')); } catch (e) { return; }
    if (depth > DEPTH_SEND) { if (!out.deep && fileBelow(p, names)) out.deep = true; return; }
    for (const n of names.sort()) walk(path.join(p, n), depth + 1);
  };
  for (const p of list) walk(String(p), 0);
  return out;
}
// more files than go at once were picked, or some were too far down: said, so nobody takes it that the rest went too
// lead: words said before them, in the same note (Share with a browser's own limit)
function onlyFirst(what, f, lead) {
  const more = !f || f.more;
  const title = more ? 'Only the first ' + ((f && f.max) || MAX_SEND) + ' files ' + what : 'Some files were left out';
  const body = ((more ? 'Send the rest after them. ' : '') + (f && f.deep ? 'Some files deeper than ' + DEPTH_SEND + ' folders were left out.' : '')).trim();
  panelSend('panel:note', { text: (lead ? lead + ' ' : '') + (more ? title + '. ' : '') + body });
  if (feats && !(panel && panel.isVisible())) feats.toast({ title, body, silent: true });
}

// Files waiting for the phone (sent from Explorer while no phone was connected); they go out when it connects, unless
// that's more than 10 minutes later (then the user is told they didn't go: a send long after would surprise)
const QUEUE_MS = (TEST_MODE && +process.env.FLICK_TEST_QUEUE_MS) || 10 * 60000;
let sendQueue = [];
function queueForPhone(paths) {
  if (targetPc()) { sendToPc(targetPc(), paths); return; }     // (another computer picked in the window)
  const files = expandPaths(paths);
  if (!files.length) return;
  if (server && server.connected) { sendPathsToPhone(files); if (files.more || files.deep) onlyFirst('go to the phone', files); return; }
  const cut = files.more || sendQueue.length + files.length > MAX_SEND;
  sendQueue = sendQueue.concat(files).slice(0, MAX_SEND);
  sendQueue.at = Date.now();
  log('queued', files.length, 'file(s) for the phone');
  showPanel();
  if (panel) panelSend('panel:note', { text: 'Connect your phone and ' + (files.length === 1 ? path.basename(files[0]) : files.length + ' files') + ' will be sent.' + (cut ? ' (Only the first ' + MAX_SEND + ' files: send the rest after them.)' : '') + (files.deep ? ' Some files deeper than ' + DEPTH_SEND + ' folders were left out.' : '') });
}
function flushSendQueue() {
  if (!sendQueue.length || !server || !server.connected) return;
  const fresh = Date.now() - (sendQueue.at || 0) < QUEUE_MS;
  const q = sendQueue; sendQueue = [];
  if (fresh) {
    if (panel) panelSend('panel:note', { text: '' });
    setTimeout(() => {
      if (server && server.connected) { sendPathsToPhone(q); return; }
      // the phone went again in that moment: they keep waiting for it, as picked (and said so again)
      const at = sendQueue.length ? sendQueue.at : q.at;
      sendQueue = q.concat(sendQueue).slice(0, MAX_SEND);
      sendQueue.at = at;
      log('the phone left before queued file(s) went: they wait for it');
      panelSend('panel:note', { text: 'Connect your phone and ' + (sendQueue.length === 1 ? path.basename(sendQueue[0]) : sendQueue.length + ' files') + ' will be sent.' });
    }, 1200);
    return;
  }
  log('queued file(s) not sent: picked', Math.round((Date.now() - q.at) / 60000), 'min ago');
  const what = q.length === 1 ? path.basename(q[0]) : q.length + ' files';
  const why = 'Picked to send more than ' + Math.round(QUEUE_MS / 60000) + ' minutes ago. Send ' + (q.length === 1 ? 'it' : 'them') + ' again now.';
  panelSend('panel:note', { text: what + ' didn’t go to the phone. ' + why });
  if (feats && !(panel && panel.isVisible())) feats.toast({ title: what + ' didn’t go to the phone', body: why, silent: true });
}

// opts: { fx: false (their cards already fly: Air grab), device (to that phone, not the one in use) }
// The first dozen files fly across the screen with a picture, which the phone needs in the offer (its own card shows
// it). Pictures never hold the offers up for long: they're made ahead (several at once where the system makes them
// in the background), each card goes as soon as its picture is there, and once THUMB_MS have gone by the rest go
// without one. The files after the dozen go right after, with no card (the phone makes its own picture of a file).
const THUMB_MS = 900;
const THUMBS_AHEAD = IS_WIN ? 0 : 3;              // Windows makes its thumbnails on this thread: one at a time there
// the phone shows its cards coming in as this screen's leave it (the animations take 0.75 s to send a card off the edge)
const FLY_OUT_MS = 650;
async function sendPathsToPhone(list, screenY, opts) {
  if (!server || !server.connected) return 0;
  const device = (opts && opts.device) || undefined;
  const paths = expandPaths(list);
  if (!paths.length) return 0;
  if (paths.more || paths.deep) onlyFirst('go to the phone', paths);
  const sy = typeof screenY === 'number' ? screenY : overlayBounds().y + store.anchor * overlayBounds().height;
  const oy = overlayYFromScreenY(sy);
  const files = [];
  for (const p of paths) {
    const name = path.basename(p), ext = extOf(name), mime = MIME[ext] || 'application/octet-stream';
    // a file that's gone (or can't be read) since it was picked is left out; the others still go
    try { files.push({ p, name, ext, mime, kind: kindOf(name), offer: server.offerFile(p, mime, device) }); }
    catch (e) { log('offer failed', name, e.code || e.message); }
  }
  if (!files.length) return 0;
  movingToPhone(files, device);
  const shown = Math.min(files.length, 12);        // the first dozen fly across the screen; the rest just go
  const t0 = Date.now();
  const look = sendLook();                          // (they leave here, and land there, in the same look)
  const thumbs = [];
  const make = (k) => { if (k < shown && !thumbs[k]) thumbs[k] = thumbFor(files[k].p).catch(() => null); };
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    let th = null;
    const left = THUMB_MS - (Date.now() - t0);
    if (i < shown && left > 0) {
      for (let k = i; k <= i + THUMBS_AHEAD; k++) make(k);
      th = await Promise.race([thumbs[i], sleep(left).then(() => null)]);
    }
    const aspect = th ? th.w / th.h : 0.72;
    const cw = 150, ch = Math.round(Math.max(110, Math.min(220, cw / Math.max(0.55, Math.min(1.8, aspect)))));
    const y = oy + Math.min(i, shown) * 22;
    if (i < shown && !(opts && opts.fx === false)) {
      fx('outgoing', { fid: f.offer.fid, name: f.name, thumb: th && th.url, kind: f.kind, look,
        badge: f.kind === 'doc' ? (f.ext || 'file').toUpperCase().slice(0, 4) : '', y, card: { w: cw, h: ch } });
    }
    server.pushToPhone({
      t: 'incoming', fid: f.offer.fid, name: f.name, size: f.offer.size, mime: f.mime, kind: f.kind, ext: f.ext, look,
      thumb: th && th.url, aspect, y: phoneYFromOverlayY(y), url: '/api/file/' + encodeURIComponent(f.offer.fid),
      // the phone's cards fly 90 ms apart, after this screen's have left: time already spent here on pictures counts
      delay: Math.max(0, (overlay && overlayReady && fxOn() ? FLY_OUT_MS : 0) + Math.min(i, shown) * 90 - (Date.now() - t0)),
    }, device);
    log('offer', f.name, f.offer.size);
    if (i < shown) await new Promise((r) => setImmediate(r));    // downloads and messages run between cards
  }
  return files.length;
}

// ------------------------------------------------------------ extra ways in: Bluetooth and Quick Share (see bt.js, quickshare.js)
let btState = 'off', qsState = 'off';
let bt = null;
function applyBluetooth() {
  if (!server || !server.http) return;
  if (store.bluetooth && IS_WIN) {
    if (!bt) {
      const { BtBridge } = require('./bt');
      bt = new BtBridge({ exe: path.join(__dirname, 'bin', 'flick-bt.exe'), http: server.http, log });
      bt.on('state', (st) => { btState = st; log('bluetooth', st); pushPanelState(); });
    }
    bt.start();
  } else {
    if (bt) bt.stop();
    btState = store.bluetooth ? 'unsupported' : 'off';
    pushPanelState();
  }
}
// Quick Share: the PC appears in Android's own Quick Share menu (quickshare.js). Incoming shares are asked about
// in the panel (with the code the phone shows), fly in like a Flick transfer, and are saved to the same folder.
let qs = null;
const qsTransfers = new Map();   // share id -> transfer id
function applyQuickShare() {
  if (store.quickShare) {
    if (!qs) {
      const { QuickShare } = require('./quickshare');
      qs = new QuickShare({ name: (server && server.name) || store.name || 'Flick PC', tmpDir: qsStage(), log });
      qs.on('state', (st) => { qsState = st; pushPanelState(); });
      qs.on('request', onQsRequest);
      qs.on('accepted', onQsAccepted);
      qs.on('progress', (m) => onQsProgress(m));
      qs.on('done', (m) => onQsDone(m).catch((e) => log('quick share save failed', e.message)));
      qs.on('failed', onQsFailed);
    }
    qs.start();
  } else {
    if (qs) { qs.stop(); qs = null; }
    qsState = 'off';
    pushPanelState();
  }
}
let qsAsking = null;
const qsWaiting = [];            // shares that came while another was being asked about: asked about next, in turn
let pairAsking = null;           // the pairing question in the window (server.js 'pair-request'), until it's answered or goes
const qsOffers = new Map();      // share id -> what the phone offered (names, types) for the fly-in card
// The window asks about one share at a time. One that comes meanwhile waits its turn: anyone nearby can ask, and a new
// request must never knock the user's own question away (nor two people sharing at once lose the first). A few wait
// at most, one from each device (address): one device sending share after share can't fill the line ahead of the
// user's own. Any more are told no at once.
function onQsRequest(m) {
  logAs('qs-request', 'quick share request from', m.from, m.files.length, 'file(s)', m.texts.length, 'text(s)');
  qsOffers.set(m.id, m);
  m.came = Date.now();
  if (qsAsking && qsAsking.id !== m.id) {
    if (qsWaiting.length >= 3 || qsWaiting.some((x) => x.addr === m.addr)) answerQs(m.id, false, 'busy');
    else qsWaiting.push(m);
    return;
  }
  qsAsk(m);
}
function qsAsk(m) {
  qsAsking = m;
  showPanel();
  if (panel) {
    panel.setAlwaysOnTop(true, 'floating');
    panel.show(); panel.focus(); panel.flashFrame(true);
    panelSend('panel:qs', m);
  }
  // nobody answered: decline, so the phone doesn't wait forever (one that waited its turn has had some of its time)
  clearTimeout(onQsRequest.t);
  onQsRequest.t = setTimeout(() => { if (qsAsking && qsAsking.id === m.id) answerQs(m.id, false, 'timeout'); }, Math.max(15000, 58000 - (Date.now() - m.came)));
}
function answerQs(id, accept, why) {
  if (!qs) return;
  const w = qsWaiting.findIndex((x) => x.id === id);
  if (w >= 0) qsWaiting.splice(w, 1);
  if (qsAsking && qsAsking.id === id) {
    qsAsking = null;
    if (panel) { panel.setAlwaysOnTop(false); panel.flashFrame(false); panelSend('panel:qs-done', { id }); }
  }
  if (!accept) qsOffers.delete(id);
  qs.answer(id, accept, why);
  qsNext();
}
// the next share waiting its turn, once nothing is being asked about
function qsNext() {
  if (qsAsking || !qsWaiting.length) return;
  qsAsk(qsWaiting.shift());
}
ipcMain.on('panel:qs-answer', (e, m) => { if (fromPanel(e) && m) answerQs(m.id, !!m.accept); });
// what a share of only a link or some text is called on its card
const qsTextName = (texts) => (texts.length === 1 ? (texts[0].type === 2 ? 'Link' : 'Text') : texts.length + ' items');
function onQsAccepted(m) {
  const tid = 'qs-' + m.id;
  qsTransfers.set(m.id, tid);
  const t = tState(tid);
  const offer = qsOffers.get(m.id);
  qsOffers.delete(m.id);
  const files = (offer && offer.files) || [];
  t.name = m.files === 1 && files[0] ? files[0].name : m.files ? m.files + ' files' : qsTextName((offer && offer.texts) || []);
  log('quick share accepted:', t.name, Math.round(m.total / 1024) + ' KB');
  t.mk = 'qs-in:' + m.id;                         // (what's moving: see moving.js)
  moving.start(t.mk, { dir: 'in', deviceName: offer && offer.from, kind: 'quickshare', name: t.name, files: m.files || 1, total: m.total,
    cancel: () => { if (qs) qs.cancel(m.id, 'canceled'); } });
  t.state = 'dropped'; t.upload = 'uploading'; t.seen = mono(); t.qs = true;
  // fly in from the phone's side of the screen, like a throw
  const ps = phoneScreen(), w = 150, h = 150;
  fx('lift', { tid, name: t.name, kind: m.files === 1 && files[0] && /^image\//.test(files[0].mime) ? 'image' : 'doc', badge: '', thumb: null, thumbs: [], count: Math.max(1, m.files), folder: false, size: m.total, card: { w, h } });
  const x = store.side === 'right' ? -w * 0.55 : ps.w - w * 0.45;
  setTimeout(() => fx('drop', { tid, x, y: ps.h / 2 - h / 2, w, h, r: 0, vx: store.side === 'right' ? -2.6 : 2.6, vy: 0, pw: ps.w, ph: ps.h }), 140);
}
function onQsProgress(m) {
  moving.update('qs-in:' + m.id, m.got, m.total);
  const tid = qsTransfers.get(m.id);
  const t = tid && transfers.get(tid);
  if (!t || !m.total) return;
  const now = mono();
  if (now - (t.qsShown || 0) < 40 && m.got < m.total) return;   // one update per frame or two, like the Wi-Fi path
  t.qsShown = now;
  if (!t.rt) { t.rt = now; t.rs = m.got; } else if (now - t.rt > 400) { const inst = Math.max(0, m.got - t.rs) / ((now - t.rt) / 1000); t.rate = t.rate ? t.rate * 0.6 + inst * 0.4 : inst; t.rt = now; t.rs = m.got; }
  t.seen = now;
  fx('progress', { tid, p: m.got / m.total, rate: store.showSpeed ? t.rate || 0 : 0 });
}
async function onQsDone(m) {
  const tid = qsTransfers.get(m.id);
  qsTransfers.delete(m.id);
  const t = tid && transfers.get(tid);
  const who = m.from || 'Quick Share';
  let dir = null;
  try { dir = await saveDirNow(); await fs.promises.mkdir(dir, { recursive: true }); }
  catch (e) { log('quick share: no folder to save in', e.message); dir = null; }
  // The phone shows the share as sent once it's all here: a file that can't be saved where it belongs is kept in
  // "Not saved" (see keepUnsaved), never left in the temp folder to be swept away, and the others still go
  const placed = [], kept = [], gone = [];
  for (const f of m.files) {
    let dest = null;
    try {
      if (!dir) throw new Error('no folder to save in');
      dest = uniquePath(dir, sanitizeName(f.name));
      await placeItem(f.tmpPath, dest, { touch: true });
    } catch (e) {
      release(dest);
      log('could not save', f.name, e.message);
      const k = await keepUnsaved(f.tmpPath, f.name, true);
      if (k) kept.push(k); else gone.push(f.name);
      hist({ dir: 'in', name: f.name, size: 0, ok: false, how: 'quickshare', why: 'save', path: k, deviceName: who });
      continue;
    }
    release(dest);
    markOfWeb(dest);
    placed.push(dest);
    hist({ dir: 'in', path: dest, deviceName: who, how: 'quickshare' });
  }
  for (const x of m.texts) {
    if (!x.value) continue;
    // links and text are put on the clipboard (never opened by themselves), through clipboard sync like text from a
    // phone, so it isn't sent back to the phone in use
    try {
      if (feats) await feats.clip.put('text', x.value);
      else await require('electron').clipboard.writeText(x.value);
    } catch (e) { log('clipboard write failed', e.message); }
    if (panel) panelSend('panel:note', { text: (m.from || 'Your phone') + ' sent ' + (x.type === 2 ? 'a link' : 'some text') + ', now on your clipboard: ' + x.value.slice(0, 200) });
  }
  // (after the note about a link: this one matters more)
  if (kept.length) toldUnsaved(kept.length === 1 ? path.basename(kept[0]) : kept.length + ' files', kept[kept.length - 1], kept.length > 1);
  if (gone.length) toldUnsaved(gone.length === 1 ? gone[0] : gone.length + ' files', null, gone.length > 1);
  log('quick share saved', placed.length, 'file(s) from', m.from, kept.length ? '(' + kept.length + ' could not be saved)' : '');
  moving.end('qs-in:' + m.id, placed.length > 0 || (!kept.length && m.texts.some((x) => x.value)), kept.length ? 'save' : 'failed');
  if (store.openAfter && placed.length === 1 && !kept.length) setTimeout(() => openGuestFile(placed[0]), 900);
  if (t) {
    t.done = true;
    const texts = m.texts.filter((x) => x.value);
    if (placed.length) fx('saved', { tid, name: placed.length === 1 ? path.basename(placed[0]) : placed.length + ' items', where: saveDirLabel() });
    else if (!kept.length && texts.length) fx('saved', { tid, name: qsTextName(texts), note: 'On your clipboard' });
    else fx('failed', { tid });
    setTimeout(() => transfers.delete(tid), 5000);
  }
}
function onQsFailed(m) {
  log('quick share failed', m.why);
  if (m.why === 'no space') panelSend('panel:note', { text: 'Not enough free space on this PC to receive that.' });
  else if (/^disk/.test(m.why)) panelSend('panel:note', { text: 'Couldn’t receive that: this PC couldn’t write the files.' });
  qsOffers.delete(m.id);
  // (its phone gave up, or left: its question goes, or its place in the line)
  const w = qsWaiting.findIndex((x) => x.id === m.id);
  if (w >= 0) qsWaiting.splice(w, 1);
  if (qsAsking && qsAsking.id === m.id) { qsAsking = null; if (panel) { panel.setAlwaysOnTop(false); panel.flashFrame(false); panelSend('panel:qs-done', { id: m.id }); } qsNext(); }
  const tid = qsTransfers.get(m.id);
  qsTransfers.delete(m.id);
  // (Cancel in the window: its card goes, and History doesn't take it for a failure)
  const mine = m.why === 'canceled';
  moving.end('qs-in:' + m.id, false, mine || m.why === 'canceled on the phone' ? 'canceled' : m.why === 'no space' ? 'space' : m.why === 'stalled' ? 'stalled' : 'failed');
  if (tid && transfers.get(tid)) { fx(mine ? 'cancel' : 'failed', { tid }); if (!mine) hist({ dir: 'in', name: transfers.get(tid).name, size: 0, ok: false, how: 'quickshare' }); transfers.delete(tid); }
}

// Windows shows a desktop app's notifications only under an app id it knows: one on a Start menu shortcut, or one
// registered for the user. Flick's installer makes a plain shortcut, so its id (setAppUserModelId above) is registered
// here, with the name and icon its notifications show.
function registerAppId() {
  if (!IS_WIN || !app.isPackaged) return;
  const key = 'HKCU\\Software\\Classes\\AppUserModelId\\com.flick.pc';
  const icon = path.join(path.dirname(process.execPath), 'Flick.ico');
  const add = (name, value, then) => execFile(winSys('reg.exe'), ['add', key, '/v', name, '/t', 'REG_SZ', '/d', value, '/f'], { windowsHide: true, timeout: 15000 }, (e) => {
    if (e) log('notifications: app id not registered', e.message);
    else if (then) then();
  });
  add('DisplayName', 'Flick', () => fs.access(icon, (e) => { if (!e) add('IconUri', icon); }));
}

// Explorer's right-click "Send to" menu gets "Flick (phone)" (a shortcut that starts Flick with --send <files>)
function sendToShortcut() { return path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'SendTo', 'Flick (phone).lnk'); }
function applySendTo() {
  if (IS_LINUX) { linuxEntries(); return; }        // Linux: Open With, in the same setting
  if (!IS_WIN) return;                             // macOS: Open With and the Dock icon always work (Info.plist)
  const lnk = sendToShortcut();
  try {
    if (store.sendTo) {
      shell.writeShortcutLink(lnk, fs.existsSync(lnk) ? 'replace' : 'create', {
        target: process.execPath, args: '--send', description: 'Send to your phone with Flick', icon: process.execPath, iconIndex: 0,
      });
    } else if (fs.existsSync(lnk)) fs.unlinkSync(lnk);
  } catch (e) { log('send-to shortcut', e.message); }
}
// Linux: Flick in the applications menu, in file managers' Open With (sendTo) and started at login (startup). A copy
// run from source leaves the user's menus alone, except under test (its home folder is a test one).
function linuxEntries() {
  if (!app.isPackaged && !TEST_MODE) return;
  plat.linuxEntries({ cmd: plat.startCommand(app.isPackaged ? null : app.getAppPath()), icon: path.join(__dirname, 'assets', 'icon.png'),
    openWith: !!store.sendTo, startup: !!store.startup, log });
}
// Files on the command line after --send. Windows may reorder the arguments, so: every absolute path that exists,
// except Flick itself.
function sendArgs(argv) {
  if (!argv.includes('--send')) return [];
  const self = [path.resolve(app.getAppPath()), path.resolve(process.execPath), path.resolve(argv[0] || '')].map((p) => p.toLowerCase());
  return argv.slice(1).filter((a) => {
    if (!a || a.startsWith('-') || !path.isAbsolute(a)) return false;
    if (/^\\\\/.test(a) || /^\/\//.test(a)) return false;         // no UNC paths: statting one leaks Windows credentials to a remote host
    if (self.includes(path.resolve(a).toLowerCase())) return false;
    try { fs.statSync(a); return true; } catch (e) { return false; }
  });
}

// ------------------------------------------------------------ panel (status + settings)
// Where the panel opens: by the tray icon. Windows' taskbar is at the bottom of the screen; the macOS menu bar (and a
// Linux panel, when there's one at the top and none at the bottom) at the top. Never taller than the screen has room
// for (a 1920x1080 laptop at 150% has 672 pixels above the taskbar): shorter there, its content scrolls, and its top,
// with the close button, is always on the screen.
const PANEL_W = 420, PANEL_H = 680;
function panelSpot() {
  const d = screen.getPrimaryDisplay(), wa = d.workArea, b = d.bounds;
  const top = IS_MAC || (IS_LINUX && wa.y > b.y && wa.y + wa.height >= b.y + b.height);
  const h = Math.max(240, Math.min(PANEL_H, wa.height - 24));
  return { x: Math.max(wa.x, wa.x + wa.width - PANEL_W - 16), y: Math.max(wa.y, top ? wa.y + 8 : wa.y + wa.height - h - 16), w: PANEL_W, h };
}
// unseen: made ahead of its first open (panelSoon). Its page knows it's hidden, as it does once the window is closed
// (one drawn for a screen it isn't on keeps the graphics busy, about 1% of a core for as long as Flick runs), and is
// drawn once.
function createPanel(unseen) {
  const at = panelSpot();
  panel = new BrowserWindow({
    width: at.w, height: at.h, x: at.x, y: at.y, paintWhenInitiallyHidden: !unseen,
    frame: false, resizable: false, maximizable: false, fullscreenable: false, show: false, backgroundColor: '#202020',
    title: 'Flick', icon: path.join(__dirname, 'assets', IS_WIN ? 'icon.ico' : 'icon.png'),
    webPreferences: { preload: PRELOAD, spellcheck: false },
  });
  panel.setMenu(null);
  panelZoomKeys(panel);
  panel.loadFile(path.join(__dirname, 'panel', 'panel.html'));
  // (drawn once: a picture of it is taken and dropped, its page counting as shown only for that moment)
  if (unseen) panel.webContents.once('did-finish-load', () => setTimeout(() => { if (panel && !panel.isDestroyed() && !panel.isVisible()) panel.webContents.capturePage().catch(() => {}); }, 1000));
  panel.on('close', (e) => { if (!app.isQuitting) { e.preventDefault(); panel.hide(); sendPreview(false); } });
  panel.on('closed', () => { panel = null; updateReady(); });
  for (const ev of ['show', 'hide', 'minimize', 'restore']) panel.on(ev, updateReady);
  for (const ev of ['show', 'hide', 'minimize', 'restore']) panel.on(ev, movingPanel);     // (what's moving: see moving.js)
  movingPanel();
  panelLoaded = false;
  const me = panel;
  panel.webContents.on('did-finish-load', () => {
    panelLoaded = true;
    pushPanelState();
    flushPanel();
    // a page loaded anew after the last one died: the questions that were on it are asked again (the window's parts
    // ask for the rest of what they show as they start)
    if (panelRevived) {
      panelRevived = false;
      if (pairAsking) panelSend('panel:pair', pairAsking);
      if (qsAsking) panelSend('panel:qs', qsAsking);
    }
  });
  // (the page can still count as loading for a moment after it finished: what waited then goes once it stops)
  panel.webContents.on('did-stop-loading', flushPanel);
  // Its page died (out of memory, a GPU or driver fault, an antivirus): it's loaded again in a moment, so the window
  // works when it's next opened, as the overlay and the progress card come back by themselves. One that keeps dying is
  // loaded again less often.
  panel.webContents.on('render-process-gone', (_e, d) => {
    if (panel !== me) return;
    log('window page gone:', d && d.reason);
    panelLoaded = false; panelRevived = true;
    const wait = Date.now() - panelGoneAt < 30000 ? 15000 : 1000;
    panelGoneAt = Date.now();
    clearTimeout(panelReviveT);
    panelReviveT = setTimeout(revivePanel, wait);
  });
}
// Bigger text in the window, for whoever needs it: Ctrl+Plus / Ctrl+Minus / Ctrl+0 (Cmd on a Mac) and Ctrl+mouse wheel,
// from 100% to 200%, kept for next time. The window has no menu, so Chromium's own zoom keys aren't there.
const ZOOMS = [1, 1.1, 1.25, 1.5, 1.75, 2];
function panelZoomKeys(w) {
  const wc = w.webContents;
  const now = () => { const z = wc.getZoomFactor(); return ZOOMS.reduce((a, b) => (Math.abs(b - z) < Math.abs(a - z) ? b : a)); };
  const step = (d) => {
    const z = d === 0 ? 1 : ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, ZOOMS.indexOf(now()) + d))];
    wc.setZoomFactor(z);
    if (store.zoom !== z) { store.zoom = z; saveStore(); }
  };
  wc.on('before-input-event', (e, i) => {
    if (i.type !== 'keyDown' || !(IS_MAC ? i.meta : i.control) || i.alt) return;
    const d = i.key === '=' || i.key === '+' ? 1 : i.key === '-' || i.key === '_' ? -1 : i.key === '0' ? 0 : null;
    if (d === null) return;
    e.preventDefault();
    step(d);
  });
  wc.on('zoom-changed', (_e, dir) => step(dir === 'in' ? 1 : -1));
  // (each load of the page starts at 100%: the size chosen is put back)
  wc.on('did-finish-load', () => { if (wc.getZoomFactor() !== store.zoom) wc.setZoomFactor(store.zoom); });
}
let panelGoneAt = 0, panelReviveT = null, panelRevived = false;
function revivePanel() {
  clearTimeout(panelReviveT); panelReviveT = null;
  if (panel && !panel.isDestroyed() && panel.webContents.isCrashed()) panel.webContents.reload();
}

let panelLoaded = false, panelQueue = [];
// the number of the window's last change taken here (panel:set): its states say it, so a switch clicked since keeps what
// it shows until its own change is taken (panel.js set)
let panelSetN = 0;
// What only says how something is now goes once, the latest: a window that's slow to load (or loads anew) doesn't
// pile them up
const PANEL_LATEST = new Set(['panel:state', 'panel:moving', 'panel:peers', 'panel:connect', 'panel:web', 'panel:feat-state',
  'panel:feat-history', 'panel:clips', 'panel:ask', 'panel:browse', 'panel:browse-job']);
// What the window's parts asked for while it was loading (each asks for its state as it starts) goes once it's loaded.
// It used to be sent through panelSend again, which could put it back in the queue, never to leave.
function flushPanel() {
  if (!panel || panel.isDestroyed() || !panelLoaded || panel.webContents.isLoading() || !panelQueue.length) return;
  const q = panelQueue; panelQueue = [];
  for (const [ch, data] of q) panel.webContents.send(ch, data);
}
function panelSend(ch, data) {
  if (!panel || panel.isDestroyed()) return;
  if (!panelLoaded || panel.webContents.isLoading()) {
    if (PANEL_LATEST.has(ch)) panelQueue = panelQueue.filter((x) => x[0] !== ch);
    panelQueue.push([ch, data]);
    return;
  }
  flushPanel();
  panel.webContents.send(ch, data);
}

function showPanel() {
  if (!panel) createPanel();
  else if (panel.webContents.isCrashed()) revivePanel();          // (opened again: its page comes back now)
  // (where it goes, and how tall, again each time: the screen, its scaling or the taskbar may have changed since)
  const at = panelSpot();
  panel.setBounds({ x: at.x, y: at.y, width: at.w, height: at.h });
  panel.show();
  panel.focus();
  pushPanelState();
}
// After a start without the window (at login), it's made a little later, unseen (made, it stays anyway): its first
// open then only has to show a page that's ready, not load it, which left the window empty on the screen for most of
// a second. Not if it was opened meanwhile.
function panelSoon() {
  setTimeout(() => { if (!panel && !app.isQuitting) createPanel(true); }, TEST_MODE && process.env.FLICK_TEST_PANEL_SOON_MS ? +process.env.FLICK_TEST_PANEL_SOON_MS : 15000).unref();
}
function togglePanel() { if (panel && panel.isVisible()) panel.hide(); else showPanel(); }
// Flick's window is open on screen: discovery answers say so ("ready"), so a device whose user holds Connect nearby
// takes this PC for the one meant when several answer
function updateReady() { if (server) server.ready = !!(panel && !panel.isDestroyed() && panel.isVisible() && !panel.isMinimized()); }

// the user's Windows accent color, lightened the way Windows 11 does it on dark surfaces
function accentColors() {
  let hex = '0078d4';
  try { const { systemPreferences } = require('electron'); const a = systemPreferences.getAccentColor && systemPreferences.getAccentColor(); if (a && /^[0-9a-f]{6}/i.test(a)) hex = a.slice(0, 6); } catch (e) { /* default */ }
  const n = parseInt(hex, 16);
  const mix = (c) => Math.round(c + (255 - c) * 0.42);
  const r = mix((n >> 16) & 255), g = mix((n >> 8) & 255), b = mix(n & 255);
  // black or white, whichever stands out more on it as the eye sees it (WCAG's luminance): a plain average of r, g and b
  // put white on the pinks and purples, where black reads twice as well
  const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const L = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return { accent: `rgb(${r},${g},${b})`, onAccent: (L + 0.05) / 0.05 >= 1.05 / (L + 0.05) ? '#000' : '#fff' };
}

function panelState() {
  const s = server && server.session;
  const ac = accentColors();
  return {
    accent: ac.accent, onAccent: ac.onAccent,
    version: VERSION, name: server ? server.name : store.name, port: server ? server.port : null,
    ips: lanAddresses().map((a) => a.address),
    connected: !!(server && server.connected), phone: s && s.connected ? s.name : null,
    phoneApp: server && server.phoneApp ? { name: server.phoneApp.name, code: server.phoneApp.code } : null,
    phoneHas: s && s.connected ? { code: s.app || 0, name: s.appName || '' } : null,
    update: { state: updateInfo.state, version: updateInfo.version || '', checking: updateBusy, asked: updateAsked },
    side: store.side, anchor: store.anchor, size: store.size, saveDir: store.saveDir, saveDirLabel: saveDirLabel(), saveDirPath: saveDirPath(),
    // (the folder chosen, by its own name, and whether it's there: missing, files go to the Desktop meanwhile)
    folder: lastFolder() ? { name: path.basename(lastFolder()) || lastFolder(), missing: store.saveDir === lastFolder() && customDir.dir === store.saveDir && customDir.ok === false } : null,
    sound: store.sound, volume: volumeOf(), reduceFx: reduceFx(), reduceFxSys: !store.reduceFxSet && !store.reduceFx && sysReduce, hotkey: store.hotkey !== false, hotkeyOk, sendCmd: WAYLAND ? sendCommand() : null,
    startup: store.startup, edgeSend: store.edgeSend, isWin: IS_WIN, os: IS_WIN ? 'win' : IS_MAC ? 'mac' : 'linux', theme: themeName(),
    openAfter: store.openAfter, showSpeed: store.showSpeed, sendTo: store.sendTo, autoUpdate: store.autoUpdate,
    bluetooth: store.bluetooth, btState: btState, quickShare: store.quickShare, qsState: qsState, airCam: store.airCam !== false, airCamState: air ? air.camState : 'off',
    via: s && s.connected ? s.via || '' : '',
    // (your other devices are listed in their own view, Devices: devices.js)
    devices: Object.entries(store.devices || {}).filter(([, d]) => !d.peer).map(([id, d]) => ({ id, name: d.name, added: d.added, waiting: !!d.phoneProv, ask: !!(store.acceptMode && store.acceptMode[id] === 'ask') })),
    displays: displays().map((d, i) => ({ id: d.id, label: `Display ${i + 1} (${d.size.width}×${d.size.height})`, primary: d.id === screen.getPrimaryDisplay().id })),
    displayId: store.displayId, firstRun: store.firstRun, news: newsPending(),
    fx: !!store.fx, fxCant: noComp, tour: !store.tourDone && panelUp(),
    // where sends from here go: the phone in use, or another computer (pcs: the paired ones to pick from)
    target: targetPc(), pcs: Object.entries(store.peerLinks || {}).filter(([, l]) => l && l.kind !== 'phone').map(([id, l]) => ({ id, name: l.name })),
    setN: panelSetN,
  };
}

// What's new: the first time Flick starts after updating to a version with something to tell, a card at the top of its
// window and, once, a notification pointing to it (a new install gets the intro instead, and nothing to catch up on)
const NEWS = '2.1';
function newsPending() { return !settingsHeld && !store.firstRun && store.seenNews !== NEWS; }
function newsToast() {
  if (!newsPending() || store.newsToast === NEWS) return;
  store.newsToast = NEWS;
  saveStore();
  if (panel && !panel.isDestroyed() && panel.isVisible()) return;       // the card is already in front of them
  if (feats) feats.toast({ title: 'Flick 2.1', body: 'Computer to computer, phone to phone, one Connect button, and more. Click to see what’s new.', click: () => showPanel() });
}

function pushPanelState() { if (panel && !panel.isDestroyed()) panelSend('panel:state', panelState()); updateTray(); }

let previewOn = false;
function sendPreview(on) {
  if (on === previewOn) return;
  previewOn = on;
  fx('preview', { on, ph: phoneScreen().h });
}

ipcMain.on('panel:set', (e, m) => {
  if (!fromPanel(e) || !m) return;
  if (Number.isSafeInteger(m.n) && m.n > 0) panelSetN = m.n;
  const { key, value } = m;
  switch (key) {
    case 'name': {
      const v = String(value || '').trim().slice(0, 40);
      if (v) { store.name = v; if (server) server.setName(v); if (qs) qs.setName(v); if (peers) peers.setName(v); }
      break;
    }
    case 'side': if (value === 'left' || value === 'right') { store.side = value; } break;
    case 'anchor': store.anchor = Math.max(0.15, Math.min(0.85, +value || 0.5)); break;
    case 'size': store.size = Math.max(0.7, Math.min(1.5, +value || 1)); break;
    case 'sound': store.sound = !!value; break;
    case 'volume': { const v = +value; if (Number.isFinite(v)) store.volume = Math.round(Math.max(0, Math.min(1, v)) * 100) / 100; break; }
    case 'reduceFx': store.reduceFx = !!value; store.reduceFxSet = true; break;
    // the animations on or off: off, one playing stops; on, the one chosen plays once, as picking it does
    case 'fx': store.fx = !!value; if (store.fx) setTimeout(() => fx('demo', {}), 120); else fxStop(); cardTick(); break;
    case 'hotkey': store.hotkey = !!value; applyHotkey(); break;
    case 'edgeSend': store.edgeSend = !!value; break;
    case 'displayId': store.displayId = value || null; break;
    case 'saveDir':
      // (a folder of the user's own picked before is remembered: it stays in the list, one choice away)
      if (value === 'desktop' || value === 'downloads') { if (lastFolder()) store.lastDir = lastFolder(); store.saveDir = value; updateStage(); }
      // (the folder chosen last, back from Desktop or Downloads without the dialog: only that one, never a path the
      // window names)
      else if (value === 'custom' && lastFolder()) { store.saveDir = lastFolder(); checkCustomDir(); updateStage(); }
      break;
    case 'theme': if (THEMES.includes(value)) { store.theme = value; setTimeout(() => fx('demo', {}), 120); } break;
    case 'startup': store.startup = !!value; applyStartup(); break;
    case 'openAfter': store.openAfter = !!value; break;
    case 'showSpeed': store.showSpeed = !!value; break;
    case 'sendTo': store.sendTo = !!value; applySendTo(); break;
    case 'autoUpdate': store.autoUpdate = !!value; break;
    case 'bluetooth': store.bluetooth = !!value; applyBluetooth(); break;
    case 'quickShare': store.quickShare = !!value; applyQuickShare(); break;
    case 'airCam': store.airCam = !!value; if (air) air.settingChanged(); break;
    // where this PC's sends go (the shortcut, the screen's edge, the window): the phone in use, or another computer
    case 'target': {
      const id = typeof value === 'string' ? value.slice(0, 64) : '';
      store.target = id && store.peerLinks && store.peerLinks[id] ? { kind: 'pc', id } : null;
      if (feats) feats._push(true);               // (the link field and the clipboard's Send follow it)
      break;
    }
    default: return;
  }
  saveStore();
  if (server) server.setSettings({ side: store.side, anchor: store.anchor, theme: themeName() });
  placeOverlay();
  ensureCatcher();
  pushPanelState();
  if (key === 'anchor' || key === 'side' || key === 'size' || key === 'displayId') {
    sendPreview(true);
    clearTimeout(ipcMain._pv); ipcMain._pv = setTimeout(() => sendPreview(false), 1400);
  }
});

// Help > Open-source notices: a part's license, the file that came with this copy of Flick (a built copy keeps
// Electron's next to the program or in its resources, and the hand tracker's in hand/); its page on the web if this
// copy has no such file (Flick's own license isn't inside the app). Windows has nothing to open a file without an
// extension with (Electron's "LICENSE": it would ask which app to use): its page on the web there too.
const LICENSES = {
  flick: { web: 'https://github.com/Maniw1234/flick/blob/main/LICENSE' },
  electron: { files: () => [path.join(path.dirname(process.execPath), 'LICENSE'), path.join(process.resourcesPath || '', 'LICENSE')], web: 'https://github.com/electron/electron/blob/main/LICENSE' },
  chromium: { files: () => [path.join(path.dirname(process.execPath), 'LICENSES.chromium.html'), path.join(process.resourcesPath || '', 'LICENSES.chromium.html')], web: 'https://source.chromium.org/chromium/chromium/src/+/main:LICENSE' },
  inter: { files: () => [path.join(__dirname, 'assets', 'fonts', 'Inter-LICENSE.txt')], web: 'https://github.com/rsms/inter/blob/master/LICENSE.txt' },
  saira: { files: () => [path.join(__dirname, 'assets', 'fonts', 'Saira-OFL.txt')], web: 'https://github.com/Omnibus-Type/Saira/blob/master/OFL.txt' },
  mediapipe: { files: () => [path.join(__dirname, 'hand', 'LICENSE-MediaPipe.txt'), path.join(__dirname, '..', 'phone', 'hand', 'LICENSE-MediaPipe.txt')], web: 'https://github.com/google-ai-edge/mediapipe/blob/master/LICENSE' },
};
function openLicense(key) {
  const l = Object.prototype.hasOwnProperty.call(LICENSES, key) ? LICENSES[key] : null;
  if (!l) return;
  const file = (l.files ? l.files() : []).find((f) => { try { return !(IS_WIN && !path.extname(f)) && fs.statSync(f).isFile(); } catch (e) { return false; } });
  if (file) shell.openPath(file).then((err) => { if (err) shell.openExternal(l.web); });
  else shell.openExternal(l.web);
}

ipcMain.on('panel:action', async (e, m) => {
  if (!fromPanel(e) || !m) return;
  const { what, arg } = m;
  switch (what) {
    case 'hide': if (panel) panel.hide(); sendPreview(false); break;
    case 'show': showPanel(); break;
    case 'quit': quitAsked(); break;
    case 'quit-sure': app.isQuitting = true; app.quit(); break;
    case 'quit-no': quitNotAsked(); break;
    case 'openFolder': shell.openPath(saveDirPath()); break;
    case 'chooseFolder': {
      const r = await dialog.showOpenDialog(panel, { properties: ['openDirectory', 'createDirectory'], defaultPath: saveDirPath() });
      if (!r.canceled && r.filePaths[0]) {
        store.saveDir = store.lastDir = r.filePaths[0];
        checkCustomDir();                         // (staging follows once it's known to be there: updateStage)
        saveStore();
      }
      pushPanelState();                           // (canceled: the window shows the setting as it is again)
      break;
    }
    case 'forget': if (server) server.forget(arg); break;
    case 'fixFirewall': fixFirewall(); break;
    case 'testFx': fx('connect', {}); break;
    case 'demo': fx('demo', {}); break;
    // the volume slider let go: the animation's sound at the new volume (sound only, nothing on the screen)
    case 'soundTest': if (overlay && overlayReady && store.sound && fxOn()) overlay.webContents.send('fx:sound', {}); break;
    case 'dismissIntro': store.firstRun = false; store.seenNews = store.newsToast = NEWS; saveStore(); pushPanelState(); break;
    case 'tourDone': store.tourDone = true; store.tourV = TOUR_V; saveStore(); pushPanelState(); break;
    case 'dismissNews': store.seenNews = store.newsToast = NEWS; saveStore(); pushPanelState(); break;
    case 'openLog': shell.openPath(LOG); break;
    case 'openLicense': openLicense(arg); break;
    case 'openRelease': shell.openExternal(updateInfo.page && /^https:\/\/github\.com\//.test(updateInfo.page) ? updateInfo.page : 'https://github.com/Maniw1234/flick/releases/latest'); break;
    case 'checkUpdates': runUpdateCheck(true); break;
    case 'sendFiles': {
      const pc = targetPc();
      if (!pc && (!server || !server.connected)) break;
      const r = await dialog.showOpenDialog(panel, { title: pc ? 'Send to ' + store.peerLinks[pc].name : 'Send to your phone', properties: ['openFile', 'multiSelections'] });
      if (r.canceled || !r.filePaths.length) break;
      // (the phone may have gone while the files were picked: they wait for it, as files sent from Explorer do, and the
      // window says so; a computer unpaired meanwhile is said too)
      if (!pc) queueForPhone(r.filePaths);
      else if (store.peerLinks && store.peerLinks[pc]) sendToPc(pc, r.filePaths);
      else panelSend('panel:note', { text: 'That computer isn’t paired any more: nothing was sent.' });
      break;
    }
    case 'sendPaths': if (Array.isArray(arg)) queueForPhone(arg.slice(0, MAX_SEND + 1)); break;
    default: break;
  }
});

ipcMain.on('panel:pair-answer', (e, m) => {
  if (!server || !fromPanel(e) || !m) return;
  if (m.allow) server.approve(m.device); else server.deny(m.device);
});

function fixFirewall() {
  if (!IS_WIN) {
    // macOS: Local Network privacy (and the firewall, if it's on); Linux: the firewall's ports. Said in the window, under
    // the link clicked, until closed (with a command to copy, on Linux)
    // (every port Flick may take: the next ones are taken on a start where its own is taken)
    const h = plat.connectHelp({ tcp: server ? [server.basePort, server.lastPort] : [47860, 47865], udp: server ? server.discoveryPort : 47870 });
    if (h.url) shell.openExternal(h.url).catch(() => {});
    panelSend('panel:help', { text: h.text, cmd: h.cmd || '' });
    return;
  }
  const exe = process.execPath;
  // All profiles on purpose: Windows calls a phone hotspot, USB tethering and many home networks "Public", and those are
  // exactly where the phone has to reach this PC. Nothing is written to a file and no .cmd runs: cmd.exe reads a .cmd,
  // and netsh writes what it says, in the old DOS code page, so a path with a letter like the é of "José" came out
  // garbled both ways (a rule for no program, and a rule not found after). Both scripts go to PowerShell as
  // -EncodedCommand (UTF-16, as Windows passes a command line), and Flick's path inside them as base64 of its UTF-8:
  // every character arrives as it is, and no quote, %, &, ^ or apostrophe (O'Brien, or a curly one PowerShell also
  // takes for a quote) in it can end a string early.
  const b64 = (t) => Buffer.from(t, 'utf8').toString('base64');
  const enc = (script) => Buffer.from(script, 'utf16le').toString('base64');
  const exeIn = `$exe = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(exe)}'))`;
  // run as admin: the old rule (by its name, as netsh made it before) goes, and the new one for this Flick
  const admin = [
    "$ErrorActionPreference = 'Stop'",
    'try {',
    '  ' + exeIn,
    "  Get-NetFirewallRule -DisplayName 'Flick' -ErrorAction SilentlyContinue | Remove-NetFirewallRule",
    "  New-NetFirewallRule -DisplayName 'Flick' -Direction Inbound -Action Allow -Program $exe -Profile Any -Enabled True | Out-Null",
    '  exit 0',
    '} catch { exit 1 }',
  ].join('\r\n');
  // after, not as admin: a rule named Flick, on, letting in this Flick (a path's letters may differ in case; one written
  // with %ProgramFiles% and the like counts too). Said as
  // an exit code and a word in plain ASCII, so no code page comes into it.
  const check = [
    "$ErrorActionPreference = 'Stop'",
    'try {',
    '  ' + exeIn,
    "  $r = @(Get-NetFirewallRule -DisplayName 'Flick' -ErrorAction SilentlyContinue | Where-Object { [string]$_.Enabled -eq 'True' -and [string]$_.Direction -eq 'Inbound' -and [string]$_.Action -eq 'Allow' } | Get-NetFirewallApplicationFilter | Where-Object { [string]$_.Program -ieq $exe -or [Environment]::ExpandEnvironmentVariables([string]$_.Program) -ieq $exe })",
    "  if ($r.Count) { 'allowed'; exit 0 } else { 'none'; exit 2 }",
    '} catch { exit 1 }',
  ].join('\r\n');
  const psExe = winSys('WindowsPowerShell', 'v1.0', 'powershell.exe');     // (by its full path, here and as admin)
  const psArgs = (script) => ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc(script)];
  // (-Wait: the answer, and the rule, are known when it ends, however long the prompt waits for an answer)
  const ask = `try { $p = Start-Process -FilePath '${psExe.replace(/['\u2018-\u201b]/g, '$&$&')}' -ArgumentList '${psArgs(admin).join("','")}' -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ErrorAction Stop; exit $p.ExitCode } catch { exit 1 }`;
  // Said in the window as for macOS and Linux: before (Windows' own prompt comes up), and after, from the rule itself (the
  // prompt answered No, closed, or PowerShell missing all leave it as it was)
  const say = (text) => panelSend('panel:help', { text, cmd: '' });
  // (busy: on the function itself, Windows' prompt up for it)
  if (fixFirewall.busy) { say('Windows asks to let Flick through its firewall: click Yes.'); return; }   // (asking already)
  fixFirewall.busy = true;
  say('Windows asks to let Flick through its firewall: click Yes.');
  execFile(psExe, psArgs(ask), { windowsHide: true, timeout: 10 * 60e3 }, (err) => {
    const no = () => { fixFirewall.busy = false; say('Not changed: Windows said no, or something stopped it.'); };
    if (err) { log('firewall: not changed', err.code || err.message); no(); return; }
    execFile(psExe, psArgs(check), { windowsHide: true, timeout: 30000 }, (e2, out) => {
      if (e2 || !/^allowed\s*$/m.test(String(out || ''))) { log('firewall: no rule for Flick after it'); no(); return; }
      fixFirewall.busy = false;
      log('firewall: Flick allowed');
      say('Allowed: phones can reach Flick now.');
    });
  });
}

function applyStartup() {
  if (IS_LINUX) { linuxEntries(); return; }       // ~/.config/autostart/flick.desktop
  if (!app.isPackaged) return;
  // macOS takes neither a path nor arguments for a login item: openedAtLogin() tells such a start apart
  const o = IS_MAC ? { openAtLogin: !!store.startup } : { openAtLogin: !!store.startup, path: process.execPath, args: ['--hidden'], name: 'Flick' };
  try { app.setLoginItemSettings(o); } catch (e) { log('startup failed', e.message); }
}
function openedAtLogin() {
  if (!IS_MAC) return false;
  try { return !!app.getLoginItemSettings().wasOpenedAtLogin; } catch (e) { return false; }
}

// ------------------------------------------------------------ tray
function updateTray() {
  if (!tray) return;
  const s = server && server.session;
  const status = server && server.connected ? `Connected to ${s.name}` : 'Waiting for your phone';
  tray.setToolTip(`Flick — ${status}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: status, enabled: false },
    { type: 'separator' },
    ...(feats ? feats.trayItems() : []),             // "Send clipboard link to phone", when the clipboard holds a link
    { label: 'Open Flick', click: showPanel },
    { label: `Open ${saveDirLabel()}`, click: () => shell.openPath(saveDirPath()) },
    { type: 'separator' },
    { label: 'Quit Flick', click: quitAsked },
  ]));
}
function createTray() {
  // macOS draws menu-bar icons itself from a black-and-clear template (and its @2x), for light and dark menu bars
  const img = nativeImage.createFromPath(path.join(__dirname, 'assets', IS_WIN ? 'tray.ico' : IS_MAC ? 'trayTemplate.png' : 'tray.png'));
  if (IS_MAC && !img.isEmpty()) img.setTemplateImage(true);
  tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img);
  tray.on('click', togglePanel);
  tray.on('double-click', showPanel);
  // macOS: files dropped on the menu-bar icon go to the phone
  if (IS_MAC) tray.on('drop-files', (_e, files) => { if (Array.isArray(files)) queueForPhone(files.slice(0, MAX_SEND + 1)); });
  updateTray();
}

// ------------------------------------------------------------ phone app updates (over Wi-Fi, from this PC)
// Candidates: the phone app that ships inside this PC app, plus any Flick APK in Downloads\Flick (so a newer phone
// build can be dropped there without reinstalling the PC app). The highest version code wins; the phone itself checks
// package, version, size, SHA-256 and signature before it offers to install.
const PHONE_PKG = 'com.flick.app';
const BUNDLED_APK = process.env.FLICK_PHONE_APK || path.join(__dirname, 'phone-app', 'Flick.apk');
function apkDir() { return process.env.FLICK_APK_DIR || path.join(downloadsDir(), 'Flick'); }
const apkCache = new Map(); // path -> { size, mtime, info }

async function scanPhoneApps() {
  const cands = [BUNDLED_APK];
  try {
    for (const n of await fs.promises.readdir(apkDir())) if (/\.apk$/i.test(n)) cands.push(path.join(apkDir(), n));
  } catch (e) { /* no Downloads\Flick folder */ }
  let best = null;
  for (const p of cands) {
    let st;
    try { st = await fs.promises.stat(p); } catch (e) { apkCache.delete(p); continue; }
    if (!st.isFile()) continue;
    let c = apkCache.get(p);
    if (!c || c.size !== st.size || c.mtime !== st.mtimeMs) {
      let info = null;
      try { info = await apkInfoAsync(p, 64 * 1024 * 1024); } catch (e) { /* not an app (or still being written) */ }
      c = { size: st.size, mtime: st.mtimeMs, info };
      apkCache.set(p, c);
    }
    const i = c.info;
    if (!i || i.package !== PHONE_PKG) continue;
    if (!best || i.code > best.code) best = Object.assign({ path: p }, i);
  }
  return best;
}

// Phones install a phone app only with the signed SHA256SUMS of the Flick release that lists it. This PC hands
// out the pair of the release it runs: kept with a downloaded version (updater.js), or, for a copy installed with
// Flick-Setup.exe, fetched once from GitHub and kept in userData. An APK it doesn't list goes out without them.
const PROOF_DIR = path.join(userDir, 'release', VERSION);
let proof = null, proofAt = 0, proofBusy = false;
function releaseProof(asked) {     // asked: a phone's "Check for updates" may ask GitHub again after a minute
  if (!proof) proof = readProof(__dirname, VERSION, TEST_RELEASE_KEYS) || readProof(PROOF_DIR, VERSION, TEST_RELEASE_KEYS);
  if (!proof && updater && !proofBusy && Date.now() - proofAt > (asked ? 60000 : 30 * 60000) && process.env.FLICK_NO_UPDATES !== '1') {
    proofBusy = true;
    proofAt = Date.now();
    updater.releaseProof(VERSION).then((p) => {
      proofBusy = false;
      if (!p) { log('no signed SHA256SUMS for', VERSION, 'yet'); return; }
      try {
        fs.rmSync(path.dirname(PROOF_DIR), { recursive: true, force: true });   // only this version's is kept
        writeProof(PROOF_DIR, p);
      } catch (e) { log('keeping SHA256SUMS failed', e.message); }
      proof = p;
      refreshPhoneApp();
    });
  }
  return proof;
}

let appScan = null;
async function refreshPhoneApp(always) {
  if (!server) return;
  while (appScan) await appScan;
  appScan = scanPhoneApps().catch((e) => { log('phone app scan failed', e.message); return null; });
  const best = await appScan;
  appScan = null;
  const p = best && releaseProof(!!always);
  if (p && p.list.get('Flick-' + best.name + '.apk') === best.sha256) Object.assign(best, { sums: p.sums.toString('utf8'), sig: p.sig });
  const prev = server.phoneApp;
  if ((!prev) !== (!best) || (prev && best && (prev.sha256 !== best.sha256 || prev.path !== best.path || prev.sig !== (best.sig || '')))) {
    log('phone app', best ? `${best.name} (${best.code}) ${best.path}${best.sig ? ', signed release' : ''}` : 'none');
  }
  server.setPhoneApp(best, !!always);
  pushPanelState();
}
setInterval(() => { if (server && server.connected) refreshPhoneApp(); }, 20000);

// ------------------------------------------------------------ updates from GitHub (this PC app; the phone follows)
const BOOT = global.FLICK_BOOT || null;     // set by boot.js: which copy of the app is running
let updater = null, updateBusy = false, restartT = null, healthy = false;
let updateInfo = { state: 'idle' };
// Check now was clicked: what the check finds is said in the window (up to date, couldn't check...), not only a new
// version as after the checks Flick makes by itself
let updateAsked = false;

// Files moving, or waiting on the user, in any of the ways they move: thrown or sent (and their questions), sent
// quietly, folder sync, Browse phone copies, Quick Share, browsers, files the phone is fetching from here. A thrown
// file still waiting its turn on the phone after a minute doesn't count: it comes in anew when it starts.
function filesBusy() {
  const now = mono();
  const moving = [...transfers.values()].some((t) => !t.done && (t.state === 'lifted' ||
    (t.state === 'dropped' && !(t.upload === 'none' && now - (t.seen || t.t0) > 60000))));
  return moving || !!(server && (server.receiving() || server.outgoingBusy())) || !!(feats && feats.busy()) ||
    !!(web && web.busy()) || !!qsAsking ||          // (a phone waiting for an answer about its Quick Share, too)
    !!(peers && peers.busy.size);                    // sending to another computer (or pairing with one)
}

async function runUpdateCheck(manual) {
  if (!updater || process.env.FLICK_NO_UPDATES === '1') return;
  // (Check now while a check runs: that one's answer is said)
  if (manual) { updateAsked = true; if (updateBusy) { pushPanelState(); return; } }
  if (updateBusy) return;
  if (!manual && store.autoUpdate === false) return;
  // not while files move: the download would compete with them for the network, the unpacking for the disk
  if (!manual && filesBusy()) {
    clearTimeout(runUpdateCheck.t);
    runUpdateCheck.t = setTimeout(runUpdateCheck, 2 * 60000);
    return;
  }
  if (!manual) updateAsked = false;           // (a check of Flick's own, later: an old answer isn't said as new)
  updateBusy = true;
  pushPanelState();                            // ("Checking…" when asked)
  try {
    updateInfo = await updater.check();
    if (updateInfo.state === 'error') log('update check:', updateInfo.version || '', updateInfo.why);
    if (updateInfo.state === 'ready') scheduleRestart(updateInfo.version);
  } catch (e) {
    log('update check failed', e.message);
    if (updateInfo.state !== 'ready') updateInfo = { state: 'error', why: e.message };   // (one downloaded still is)
  }
  updateBusy = false;
  pushPanelState();
}

// restart into the new version, but never in the middle of a transfer or an animation
function scheduleRestart(ver) {
  if (restartT) return;
  const dueAt = mono();                  // (this run ends with the restart: nothing to set back)
  const tryNow = () => {
    restartT = null;
    const queued = sendQueue.length > 0 && Date.now() - (sendQueue.at || 0) < QUEUE_MS;   // a queue goes stale after 10 min
    // (this PC's own Wi-Fi network is on: a phone may be connected over it, or about to be, and a restart takes it down.
    // Not for ever: a PC always used over that network would never update, so after 6 hours it no longer waits for it)
    const ownNet = (hotspot.state === 'on' || hotspot.state === 'starting') && mono() - dueAt < 6 * 3600000;
    const busy = filesBusy() || queued || overlayShown || (panel && panel.isVisible() && panel.isFocused()) || ownNet;
    if (busy) { restartT = setTimeout(tryNow, 30000); return; }
    log('restarting into', ver);
    // only --hidden: the original command line may hold "--send <files>" from Explorer, which must not be sent again
    // (on Linux the launcher's switches go along, and an AppImage restarts from its own file)
    const args = ['--hidden'];
    app.relaunch(plat.relaunch(args));
    app.isQuitting = true;
    app.quit();
  };
  restartT = setTimeout(tryNow, TEST_MODE ? 1500 : 5000);
}

function startUpdater() {
  updater = new Updater({
    version: VERSION, electron: process.versions.electron, log, keys: TEST_RELEASE_KEYS,
    fetch: (url, opts) => require('electron').net.fetch(url, opts),
    // (a new version on its way: the window says so while it downloads)
    onState: (st) => { if (st && st.state === 'downloading') { updateInfo = st; pushPanelState(); } },
  });
  if (BOOT && BOOT.failed) log('downloaded version failed to load, using the installed one:', BOOT.failed);
  log('running', VERSION, BOOT && BOOT.dir ? 'from ' + path.join(BOOT.root, BOOT.dir) : '(installed copy)');
  setTimeout(() => { healthy = true; updater.markHealthy(BOOT); }, TEST_MODE ? 4000 : 6000);
  setTimeout(runUpdateCheck, TEST_MODE ? 6000 : 20000);
  setInterval(runUpdateCheck, 30 * 60 * 1000);
}

// ------------------------------------------------------------ transfers (phone -> PC)
const transfers = new Map(); // tid -> state
const gone = new Map();      // tid -> when it was canceled: late events for it are ignored
// The phone features (features.js: several phones, clipboard, links, notifications, remote, sync, history); set once started
let feats = null;
function hist(e) { if (feats) feats.record(e); }   // a transfer history entry
// Air grab (air.js): where a file a hand carried from the phone lands, and the files a hand catches from here
let air = null;
function isGone(tid) {
  const now = Date.now();
  for (const [k, at] of gone) if (now - at > 5 * 60000) gone.delete(k);
  return gone.has(tid);
}
// (kept for 5 minutes, and never more than a couple of thousand: a device can't grow it by canceling made-up transfers)
function markGone(tid) {
  isGone(tid);
  gone.delete(tid);
  gone.set(tid, Date.now());
  if (gone.size > 2000) { let n = gone.size - 2000; for (const k of gone.keys()) { gone.delete(k); if (--n <= 0) break; } }
}

// Windows' device names in every spelling it takes for one ("con.txt", "con .txt", "COM¹.png", "CONIN$"): a file named
// so can't be opened or deleted in Explorer (sync.js has the same rule)
const DEVICE_NAME = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)( *\..*)?$/i;
// A name fits when Windows takes it (255 UTF-16 units) and so do macOS and Linux (255 bytes: 85 letters of Chinese,
// 127 of Hebrew or Russian), with room left for " (2)"
const fitsName = (s) => s.length <= 180 && (IS_WIN || Buffer.byteLength(s) <= 230);
// a name is cut to this before anything else is done to it, so any name costs the same little time (a sender can send
// one hundreds of thousands of characters long)
const NAME_MAX = 1000;
// without the dots and white space at its end, which Windows can't keep there (a name ending "report." can't be opened)
function stripEnd(s) {
  let i = s.length;
  while (i > 0 && (s[i - 1] === '.' || /\s/.test(s[i - 1]))) i--;
  return i === s.length ? s : s.slice(0, i);
}
function sanitizeName(n) {
  let s = String(n || 'file');
  if (s.length > NAME_MAX) { const e = path.extname(s); s = e.length <= 16 ? s.slice(0, NAME_MAX - e.length) + e : s.slice(0, NAME_MAX); }
  // also drop invisible direction-control characters, which can make "photo\u202Egnp.exe" read as "photoexe.png"
  s = stripEnd(s.replace(/[<>:"/\\|?*\u0000-\u001f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '_').trim());
  if (!s) s = 'file';
  if (s.startsWith('.')) s = '_' + s.slice(1);         // what arrives is never hidden (a name starting with a dot is, on a Mac or Linux)
  if (DEVICE_NAME.test(s)) s = '_' + s;
  if (!fitsName(s)) {
    let e = path.extname(s);
    if (e.length > 16) e = '';                         // a "dot near the start" isn't an extension worth keeping
    // shortened by whole characters: half an emoji would leave a broken one in the name
    const cs = Array.from(s.slice(0, Math.min(180, s.length - e.length)).replace(/[\ud800-\udbff]$/, ''));
    while (cs.length && !fitsName(cs.join('') + e)) cs.pop();
    s = (stripEnd(cs.join('')) || 'file') + e;
    // (what's left can be one: "nul", spaces, "x.txt" is "nul.txt"; and still fit)
    if (DEVICE_NAME.test(s)) { s = '_' + s; const z = path.extname(s); while (!fitsName(s) && s.length > z.length + 4) s = s.slice(0, s.length - z.length - 1) + z; }
  }
  return s;
}
// Names picked for saves still in progress, so two files with the same name saved at the same moment can't both
// take it (Windows names are case-insensitive, so are the keys). Released once the file is in place.
const reserved = new Set();
const taken = (p) => reserved.has(p.toLowerCase()) || fs.existsSync(p);
function release(p) { if (p) reserved.delete(p.toLowerCase()); }
function uniquePath(dir, name) {
  const ext = path.extname(name), base = name.slice(0, name.length - ext.length);
  let p = path.join(dir, name), i = 2;
  while (taken(p)) p = path.join(dir, `${base} (${i++})${ext}`);
  reserved.add(p.toLowerCase());
  return p;
}

// Programs, scripts and shortcuts that run code when opened. Flick never auto-launches these, and marks everything it
// receives as downloaded so Windows SmartScreen / Office Protected View still warn if the user opens one by hand.
const RISKY_EXT = new Set(['.exe', '.msi', '.msp', '.bat', '.cmd', '.com', '.scr', '.pif', '.cpl', '.ps1', '.psm1',
  '.vbs', '.vbe', '.js', '.jse', '.wsf', '.wsh', '.hta', '.lnk', '.url', '.reg', '.jar', '.msc', '.inf', '.scf',
  '.application', '.gadget', '.ws', '.vb', '.jnlp', '.chm', '.sct', '.appref-ms',
  // and what opens into something that runs or reaches out: disk images (mounted, their files unmarked), app
  // packages and installers, Excel add-ins, remote desktop and search/library/settings shortcuts, themes
  '.iso', '.img', '.vhd', '.vhdx', '.appx', '.appxbundle', '.msix', '.msixbundle', '.appinstaller', '.msu', '.diagcab',
  '.xll', '.rdp', '.wsb', '.settingcontent-ms', '.library-ms', '.search-ms', '.searchconnector-ms', '.theme', '.themepack',
  '.deskthemepack', '.website', '.xbap', '.psd1', '.ps1xml', '.psc1']);
// and their macOS and Linux kin: apps, installers, disk images, scripts, launchers (on a Mac a folder of one of these
// names is an app or something the system offers to install: screen savers, settings panes, Automator actions)
if (!IS_WIN) for (const x of ['.app', '.pkg', '.mpkg', '.dmg', '.command', '.tool', '.terminal', '.workflow', '.saver', '.prefpane', '.action', '.scpt', '.scptd', '.applescript',
  '.sh', '.bash', '.zsh', '.csh', '.ksh', '.fish', '.py', '.pl', '.rb', '.desktop', '.appimage', '.run', '.bin', '.deb', '.rpm', '.flatpakref',
  '.fileloc', '.inetloc', '.webloc']) RISKY_EXT.add(x);
const riskyExt = (p) => RISKY_EXT.has(path.extname(p).toLowerCase());

function markOfWeb(dest) {
  if (IS_MAC) { plat.quarantine(dest); return; }   // macOS' own mark (Gatekeeper); Linux has none
  if (!IS_WIN) return;
  fs.writeFile(dest + ':Zone.Identifier', '[ZoneTransfer]\r\nZoneId=3\r\n', () => {});
}

// The files of a received folder are marked two at a time: thousands of marks started at once would take all of
// Node's few disk threads, and transfers still writing would wait behind them.
// Programs and scripts go first (the ones that matter most if opened right away), wherever they are in the folder.
const markQ = { risky: [], rest: [], at: { risky: 0, rest: 0 } };
let marking = 0;
function nextMark() {
  for (const k of ['risky', 'rest']) {
    const q = markQ[k];
    if (markQ.at[k] < q.length) {
      const f = q[markQ.at[k]++];
      if (markQ.at[k] === q.length) { q.length = 0; markQ.at[k] = 0; }   // (taken from the front without moving the rest)
      return f;
    }
  }
  return null;
}
function pumpMarks() {
  let f;
  while (marking < 2 && (f = nextMark())) {
    marking++;
    fs.writeFile(f + ':Zone.Identifier', '[ZoneTransfer]\r\nZoneId=3\r\n', () => { marking--; pumpMarks(); });
  }
}

// mark a received file, or every file inside a received folder (best-effort): all of them, however many (whoever sent
// them can't leave some unmarked by putting them after the first few thousand)
function markTree(dest) {
  if (IS_MAC) { plat.quarantine(dest, true); return; }
  if (!IS_WIN) return;
  (async () => {
    const st = await fs.promises.stat(dest);
    if (st.isFile()) return markOfWeb(dest);
    if (!st.isDirectory()) return;
    const walk = async (d) => {
      let ents;
      try { ents = await fs.promises.readdir(d, { withFileTypes: true }); } catch (e) { return; }
      for (const ent of ents) {
        const full = path.join(d, ent.name);
        if (ent.isDirectory()) await walk(full);
        else if (ent.isFile()) { (riskyExt(full) ? markQ.risky : markQ.rest).push(full); pumpMarks(); }
      }
    };
    await walk(dest);
  })().catch(() => {});
}

// "open after it arrives" (and Open in History, and a click on a received file's notification): pictures, videos, music,
// documents and plain text open; anything else (a program, a script, a shortcut, whatever the computer would run it
// with: Python, Perl, AutoHotkey...) is shown in its folder instead, to be opened there only if the user means to.
// A list of what opens, not of what doesn't: a runtime the list doesn't know can't slip through.
// A received folder opens (the file manager shows what's in it), unless its name makes it a program: on a Mac a folder
// "Evil.app" is an app, and opening it launches it.
const OPENABLE = /\.(jpe?g|png|gif|webp|heic|heif|avif|bmp|tiff?|mp4|mov|m4v|webm|mkv|avi|3gp|mp3|m4a|aac|wav|flac|ogg|opus|pdf|txt|docx?|xlsx?|pptx?|odt|ods|odp|rtf|csv|md|epub)$/i;
function openAfterArrival(dest) {
  let dir = false;
  try { dir = fs.statSync(dest).isDirectory(); } catch (e) { /* gone: shown in its folder, which says so */ }
  if (riskyExt(dest) || (!dir && !OPENABLE.test(dest))) { try { shell.showItemInFolder(dest); } catch (e) { /* ignore */ } return; }
  shell.openPath(dest);
}
// ...and from a guest (a browser, Quick Share from any phone nearby, not a paired one): only pictures, videos, music,
// PDFs and plain text open; anything else is shown in its folder
const GUEST_OPENABLE = /\.(jpe?g|png|gif|webp|heic|heif|bmp|tiff?|mp4|mov|m4v|webm|mkv|avi|mp3|m4a|aac|wav|flac|ogg|opus|pdf|txt)$/i;
function openGuestFile(p) {
  if (GUEST_OPENABLE.test(p)) openAfterArrival(p);
  else { try { shell.showItemInFolder(p); } catch (e) { /* ignore */ } }
}

// what the overlay needs to draw the card: a photo, a document, a folder, or a stack of several items
// What a phone says of a card (its size on the phone's screen, where it is, how fast it goes, how big that screen is,
// in the phone's pixels): numbers in reason, as for another computer's (server.js). One that isn't would keep the card
// from being drawn, or throw it far off the screen.
const cardSide = (v) => { v = +v; return Number.isFinite(v) && v > 0 ? Math.max(40, Math.min(400, Math.round(v))) : 160; };
const CARD_NUMS = { x: [-1e5, 1e5, 0], y: [-1e5, 1e5, 0], r: [-1e3, 1e3, 0], s: [0.1, 10, 1], vx: [-1e3, 1e3, 0], vy: [-1e3, 1e3, 0], pw: [100, 1e4, 412], ph: [100, 1e4, 915] };
function cardMove(m) {
  const o = Object.assign({}, m);
  for (const [k, [lo, hi, d]] of Object.entries(CARD_NUMS)) if (k in o) { const v = +o[k]; o[k] = Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d; }
  if ('w' in o) o.w = cardSide(o.w);
  if ('h' in o) o.h = cardSide(o.h);
  return o;
}
function liftInfo(m, t) {
  const f = m.file || {};
  // (pictures carried in the message only, and small ones: never an address to fetch, nor one too big to hold)
  const thumbs = Array.isArray(m.thumbs) ? m.thumbs.filter((x) => typeof x === 'string' && x.length < 400000 && smallPicture(x)).slice(0, 2) : [];
  return {
    tid: m.tid, name: t.name, kind: f.kind, badge: f.badge, thumb: typeof m.thumb === 'string' && m.thumb.length < 400000 && smallPicture(m.thumb) ? m.thumb : null, thumbs,
    count: Math.max(1, Math.min(100000, +f.count || 1)), folder: !!f.folder,
    size: f.size || 0, card: { w: cardSide(m.w), h: cardSide(m.h) },
    look: typeof m.look === 'string' ? m.look.slice(0, 12) : undefined,     // the animation the phone chose (Surprise me)
  };
}

function uniqueDirPath(dir, name) {
  let p = path.join(dir, name), i = 2;
  while (taken(p)) p = path.join(dir, `${name} (${i++})`);
  reserved.add(p.toLowerCase());
  return p;
}

// Received files are staged for this user alone (files 0600, folders 0700). In place they get the mode any new file of
// the user's gets (as a browser's downloads do), so a file received isn't the one that others the user shares a
// folder with can't open. They get it while still staged, and nothing is changed or looked into through a path in the
// save folder once they're there: in a folder other accounts can write in (a shared one without the sticky bit) one of
// them could put a link in a received folder's place between its change of mode and the look inside it, and have the
// user's own files (the home folder, its keys) opened up instead.
const UMASK = (() => { try { const m = /^Umask:\s*([0-7]+)/m.exec(fs.readFileSync('/proc/self/status', 'utf8')); if (m) return parseInt(m[1], 8); } catch (e) { /* not Linux */ } return 0o022; })();
// Linux: a staged item is reached through its staging folder's own descriptor (/proc/self/fd/<n>/...), so no folder
// above it can be swapped for another meanwhile (the hidden one on another drive sits in the save folder itself)
const PROC_FD = IS_LINUX && (() => { try { return fs.statSync('/proc/self/fd').isDirectory(); } catch (e) { return false; } })();
const { O_RDONLY, O_DIRECTORY, O_NOFOLLOW } = fs.constants;
const MAX_LISTED = 20000;           // files of one received folder told to have.js (its own cap)
// The usual mode for p, a staged file or folder, and everything in it (o.touch: dated now, as it arrives; o.files: its
// files' { rel, size } are listed there, and o.listed says so). Modes are left as staged on Windows, and where the
// staging folder isn't this user's alone (a drive whose folders are all as open, FAT say, where modes don't apply).
async function usualMode(p, o) {
  const touch = (q) => { const now = new Date(); return (IS_WIN ? fs.promises.utimes : fs.promises.lutimes)(q, now, now).catch(() => {}); };
  if (IS_WIN) { if (o && o.touch) await touch(p); return; }
  let anchor = null, top = p, own = true;
  if (PROC_FD) {
    try {
      anchor = await fs.promises.open(path.dirname(p), O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
      const st = await anchor.stat();
      own = st.uid === process.getuid() && !(st.mode & 0o022);
      top = '/proc/self/fd/' + anchor.fd + '/' + path.basename(p);
    } catch (e) { if (anchor) await anchor.close().catch(() => {}); return; }
  }
  try {
    if (o && o.touch) await touch(top);
    if (!own) return;
    await modeTree([[top, '']], o && o.files);
    if (o && o.files) o.listed = true;
  } finally { if (anchor) await anchor.close().catch(() => {}); }
}
// (a level at a time, several at once: a folder of thousands of files is in place a moment later than it arrived)
async function modeTree(level, files) {
  const next = [];
  let i = 0;
  const one = async () => {
    while (i < level.length) {
      const [p, rel] = level[i++];
      let st;
      try { st = await fs.promises.lstat(p); } catch (e) { continue; }
      if (st.isDirectory()) {
        await fs.promises.chmod(p, 0o777 & ~UMASK).catch(() => {});
        let names = [];
        try { names = await fs.promises.readdir(p); } catch (e) { /* none */ }
        for (const n of names) next.push([path.join(p, n), rel ? path.join(rel, n) : n]);
      } else if (st.isFile()) {
        await fs.promises.chmod(p, (st.mode & 0o111 ? 0o777 : 0o666) & ~UMASK).catch(() => {});
        if (files && files.length < MAX_LISTED) files.push({ rel, size: st.size });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, level.length) }, one));
  if (next.length) await modeTree(next, files);
}

// Move one staged file or folder into place (with the usual mode, above, given first). Windows can hold a fresh file
// for a moment (an antivirus or a thumbnailer reading it): the move is tried again for a few seconds. Across drives, or
// when it stays locked, it's copied instead.
// held for a moment (an antivirus, a search indexer): tried again. On Windows that can show as access denied; on Linux and
// a Mac it means the folder can't be written, which doesn't pass (it only kept the browser waiting ~4.7 s to hear so)
const LOCKED = IS_WIN ? ['EBUSY', 'EACCES', 'EPERM'] : ['EBUSY'];
async function placeItem(src, dest, o) {
  await usualMode(src, o);
  await moveInPlace(src, dest);
}
const CP = { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true };
async function moveInPlace(src, dest) {
  for (let i = 0; ; i++) {
    try { await fs.promises.rename(src, dest); return; }
    catch (e) {
      if (LOCKED.includes(e.code) && i < 5) { await sleep(150 * 2 ** i); continue; }     // 150 ms ... 2.4 s
      if (!['EXDEV', 'ENOTEMPTY'].concat(LOCKED).includes(e.code)) throw e;
      break;
    }
  }
  await copyInPlace(src, dest);
  await fs.promises.rm(src, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
}
// A copy sets each folder's and file's mode and time by its path as it goes. On Linux it's made in a folder of its own
// beside where it goes (this user's alone, reached through its descriptor: nothing in it can be swapped while it
// fills) and moved into place from there in one go; one that someone swapped as it was made is tried again under a
// new name. Without one, it's copied straight there only when nobody else can put anything in the save folder (this
// user's, closed to others, or this user's with the sticky bit): otherwise it isn't saved there (EOPENDIR: it's kept
// in "Not saved" and the user is told why). On a Mac, straight there.
// what was refused that way (its staged path), and where it was then kept: the user is told why for those, and only those
const openRefused = new Set(), keptOpen = new Set();
async function copyInPlace(src, dest) {
  // no half copy is left behind (the staged one is still whole); one that was there before is someone else's
  const fail = async (e, at, theirs) => {
    if (!theirs || (e.code !== 'ERR_FS_CP_EEXIST' && e.code !== 'EEXIST')) await fs.promises.rm(at, { recursive: true, force: true }).catch(() => {});
    throw e;
  };
  let hold = null, fh = null;
  for (let i = 0; !fh && i < (PROC_FD ? 3 : 0); i++) {
    hold = path.join(path.dirname(dest), '.flick-placing-' + require('crypto').randomBytes(6).toString('hex'));
    await fs.promises.mkdir(hold, { mode: 0o700 });
    try {
      fh = await fs.promises.open(hold, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
      const st = await fh.stat();
      if (st.uid !== process.getuid() || (st.mode & 0o077)) { await fh.close(); fh = null; }
    } catch (e) { if (fh) await fh.close().catch(() => {}); fh = null; }
    if (!fh) { await fs.promises.rmdir(hold).catch(() => {}); hold = null; }
  }
  if (!fh) {
    if (PROC_FD) {
      // (the folder itself, also when the user chose it through a link: it's who can write in that folder that counts)
      const st = await fs.promises.stat(path.dirname(dest));
      const mine = st.isDirectory() && st.uid === process.getuid();
      if (!mine || ((st.mode & 0o022) && !(st.mode & 0o1000))) {
        if (openRefused.size < 1000) openRefused.add(src);
        const e = new Error('other accounts can change what’s in ' + path.dirname(dest) + ': not copied there');
        e.code = 'EOPENDIR';
        throw e;
      }
    }
    try { await fs.promises.cp(src, dest, CP); } catch (e) { await fail(e, dest, true); }
    return;
  }
  const inner = '/proc/self/fd/' + fh.fd + '/' + path.basename(dest);
  try {
    try { await fs.promises.cp(src, inner, CP); } catch (e) { await fail(e, inner); }
    // into place without replacing anything that's there by now: a file by a second name (refused if one exists), a
    // folder by renaming it over the name, refused unless it's free
    const there = await fs.promises.lstat(dest).then(() => true, () => false);
    if (there) { const e = new Error('already there: ' + dest); e.code = 'EEXIST'; await fail(e, inner); }
    const st = await fs.promises.lstat(inner);
    try {
      if (st.isDirectory()) await fs.promises.rename(inner, dest);
      else { await fs.promises.link(inner, dest); await fs.promises.unlink(inner).catch(() => {}); }
    } catch (e) { await fail(e, inner); }
  } finally {
    await fh.close().catch(() => {});
    fs.promises.rmdir(hold).catch(() => {});                           // (empty by now)
  }
}

// A received file (or what's left of a received folder) that couldn't be saved where it belongs. Its phone was told it
// arrived and won't send it again, so it's never deleted: it goes under its own name into "Not saved" and the user is
// told where (quiet: the caller tells, once for several). It's kept for good, so not in a temp folder (Linux empties
// /tmp at boot, Windows' Disk Cleanup and macOS clear theirs): in Flick's own folder (on Windows the local one, not
// the profile that may roam with the user), where moving it there is a rename; one staged on its save folder's own
// drive (".flick-incoming") stays on that drive, beside it. If even that fails it stays where it is. null: it's gone
// (its drive was taken out, or its folder deleted), as the user is told.
const KEPT_DIR = 'Not saved';
const KEPT_HOME = path.join(IS_WIN && process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Flick') : userDir, KEPT_DIR);
const within = (p, dir) => { const r = path.relative(dir, p); return !!r && !r.startsWith('..') && !path.isAbsolute(r); };
async function keepUnsaved(src, name, quiet) {
  if (!(await fs.promises.lstat(src).then(() => true, () => false))) {
    log('could not save', name, '- what had arrived is gone');
    updateStage();                                                      // (the folder it was staged in may be gone too)
    if (!quiet) toldUnsaved(name, null);
    return null;
  }
  let dest = src;
  // (it, or something of it, couldn't be copied into the save folder because other accounts can change what's in it)
  let open = false;
  for (const p of openRefused) if (p === src || within(p, src)) { open = true; openRefused.delete(p); }
  // (if it can't go there, the other of the two places: "Not saved" in the folder it's staged in, which the sweep of
  // leftovers leaves alone (sweepDir), or Flick's own. Left loose in the staging folder, that sweep took it hours later.)
  const stagedIn = [TEMP_STAGE, QS_STAGE].find((d) => within(src, d));
  const dirs = stagedIn ? [KEPT_HOME, path.join(stagedIn, KEPT_DIR)] : [path.join(path.dirname(src), KEPT_DIR), KEPT_HOME];
  for (const dir of dirs) {
    try {
      await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
      const d = uniquePath(dir, sanitizeName(name));
      try { await placeItem(src, d); dest = d; } finally { release(d); }
      break;
    } catch (e) { /* the next place; if there's none, it stays where it is */ }
  }
  // marked as downloaded, as a saved file is: opened from there, a program still gets SmartScreen's (or Gatekeeper's) look
  markTree(dest);
  log('could not save', name, '- kept in', dest);
  if (open) { if (keptOpen.size >= 1000) keptOpen.clear(); keptOpen.add(dest); }
  if (!quiet) toldUnsaved(name, dest);
  return dest;
}
// what couldn't be saved (a name, or "3 files") and where it is now (dest: the last of them; null: gone)
function toldUnsaved(what, dest, several) {
  const they = several ? 'They’re' : 'It’s';
  const body = dest ? they + ' kept in ' + path.dirname(dest) : 'What had arrived of ' + (several ? 'them' : 'it') + ' is gone: its drive was taken out, or its folder deleted';
  // (one that wasn't copied into the save folder because other accounts on this computer can change what's in it)
  const why = dest && keptOpen.delete(dest) ? ': other accounts on this computer can change what’s in it' : '';
  panelSend('panel:note', { text: 'Couldn’t save ' + what + ' in ' + saveDirLabel() + why + '. ' + body + '.' });
  if (feats) feats.toast({ title: 'Couldn’t save ' + what, body: (why ? 'Other accounts on this computer can change what’s in ' + saveDirLabel() + '. ' : '') + body, click: dest ? () => shell.showItemInFolder(dest) : undefined });
}
// Files an older Flick kept in "Not saved" in the temp folder, which the system empties, go where they're kept now
// (this user's own: in /tmp, another user's are left alone)
async function moveOldKept() {
  for (const dir of ['flick-incoming', 'flick-quickshare'].map((n) => path.join(app.getPath('temp'), n, KEPT_DIR))) {
    let names;
    try {
      const st = await fs.promises.lstat(dir);
      if (!st.isDirectory() || (OWN_DIRS && st.uid !== process.getuid())) continue;
      names = await fs.promises.readdir(dir);
    } catch (e) { continue; }
    for (const n of names) {
      const src = path.join(dir, n);
      let d = null;
      try {
        if (OWN_DIRS && (await fs.promises.lstat(src)).uid !== process.getuid()) continue;
        await fs.promises.mkdir(KEPT_HOME, { recursive: true, mode: 0o700 });
        d = uniquePath(KEPT_HOME, n);
        await placeItem(src, d);
        log('kept file moved out of the temp folder:', d);
      } catch (e) { log('could not move kept file', n, e.message); }
      finally { release(d); }
    }
    fs.rmdir(dir, () => {});                                            // (once it's empty)
  }
}

async function finalizeBundle(t, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const placed = [];
  let lost = 0;
  try {
    // everything that's in the staging folder goes out (not just the names the manifest listed)
    let tops = t.bundle.tops.slice();
    // (with sets: a list of thousands looked up item by item took seconds)
    try { const have = await fs.promises.readdir(t.tmpPath); const hs = new Set(have), ts = new Set(tops); tops = tops.filter((x) => hs.has(x)).concat(have.filter((x) => !ts.has(x))); } catch (e) { /* keep the list */ }
    for (const top of tops) {
      const src = path.join(t.tmpPath, top);
      let st;
      try { st = await fs.promises.lstat(src); } catch (e) { lost++; log('could not save', top, e.message); continue; }
      const nm = top.startsWith('.') ? '_' + top.slice(1) : top;   // (never hidden where it lands; inside a folder, kept as it is)
      const dest = st.isDirectory() ? uniqueDirPath(dir, nm) : uniquePath(dir, nm);
      try {
        const o = { touch: true, files: [] };
        await placeItem(src, dest, o);
        markTree(dest);
        received.addTree(dest, server.ownerOf(t.tid), o.listed ? o.files : null);   // (who sent it: only that device is told it's here, have.js)
        placed.push(path.basename(dest));
        hist({ dir: 'in', tid: t.tid, path: dest, how: 'fling' });
      } catch (e) { lost++; log('could not save', top, e.message); }
      finally { release(dest); }
    }
  } finally {
    // what couldn't be put in place is kept (see keepUnsaved); otherwise the staging folder goes
    if (lost) t.kept = await keepUnsaved(t.tmpPath, t.name && t.name !== 'file' ? t.name : 'Files');
    else {
      fs.rm(t.tmpPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }, () => {});
      t.tmpPath = null;                                  // (nothing was left in it to keep)
    }
  }
  if (!placed.length) throw new Error('nothing received');
  if (lost) {
    const name = lost + (lost === 1 ? ' item' : ' items');
    hist({ dir: 'in', tid: t.tid, name, size: 0, ok: false, how: 'fling', why: 'save', path: t.kept });
  }
  log('saved', placed.length, 'item(s) in', dir, t.bundle.files, 'files', lost ? '(' + lost + ' could not be saved)' : '');
  return placed.length === 1 ? placed[0] : placed.length + ' items';
}

function tState(tid) {
  let t = transfers.get(tid);
  if (!t) { t = { tid, state: 'lifted', upload: 'none', name: 'file', t0: mono() }; transfers.set(tid, t); }
  return t;
}

// the overlay messages that fly a transfer's card in from the phone's side (a send from the phone's menu, a transfer
// that carries on after a pause)
function flyInMsgs(tid, info, pw, ph) {
  const ps = { w: pw ? cardMove({ pw }).pw : phoneScreen().w, h: ph ? cardMove({ ph }).ph : phoneScreen().h };
  const w = (info && info.card && info.card.w) || 160, h = (info && info.card && info.card.h) || 160;
  const lift = Object.assign({}, info || { tid, name: 'file' }, { tid, card: { w, h } });
  const x = store.side === 'right' ? -w * 0.55 : ps.w - w * 0.45;
  const drop = { tid, x, y: ps.h / 2 - h / 2, w, h, r: 0, vx: store.side === 'right' ? -2.6 : 2.6, vy: 0, pw: ps.w, ph: ps.h };
  return { lift, drop };
}

// Air grab: the card of a transfer a hand let go of flies to where it lands (msg: an overlay drop, with land: { x, y }
// where the hand opened in front of the PC)
function airLand(t, msg) {
  if (t.state !== 'canceled') fx('drop', msg);
}

// "Ask each time" (a setting per phone, ask.js): once the user has thrown or sent it, a transfer from that phone waits
// for Accept in the window; finalize saves nothing until then. Decline or 60 s without an answer: the phone is told
// ('failed' with why declined | timeout), the upload is stopped and what arrived is deleted.
// again: asked once more, about what really came (see askedFor)
function askFirst(t, again) {
  if (!feats || t.ask || t.qs || t.web) return;
  const device = server.ownerOf(t.tid);
  if (!device || feats.ask.mode(device) !== 'ask') return;
  t.ask = 'wait';
  movingSync(t);
  const info = t.info || {}, b = t.bundleInfo;
  if (!again) server.pushToPhone({ t: 'asking', tid: t.tid }, device);
  const tops = t.bundle ? t.bundle.tops : null;
  const q = again ? {
    device, deviceName: server.api.nameOf(device), tid: t.tid, kind: 'fling',
    name: tops ? (tops.length === 1 ? tops[0] : tops.length + ' items') : t.name, count: tops ? tops.length : 1, size: tops ? t.bundle.bytes : t.size || 0, names: tops || [],
  } : {
    device, deviceName: server.api.nameOf(device), name: t.name, tid: t.tid, kind: 'fling',
    count: b && b.count ? b.count : info.count || 1, size: b ? b.bytes : +info.size || 0, names: b ? b.roots : [],
  };
  // what the question shows (the window cuts it the same way): what the user's yes is about
  t.asked = { name: String(q.name || 'a file').slice(0, 200), full: String(q.name || '').slice(0, 1000), count: Math.max(1, Math.floor(+q.count || 1)), names: (q.names || []).slice(0, 50).map((x) => String(x).slice(0, 200)) };
  feats.ask.ask(q).then((r) => {
    if (transfers.get(t.tid) !== t || t.done) return;
    if (r.yes) { t.ask = 'yes'; t.shown = r.shown || t.asked; t.seen = mono(); movingSync(t); if (t.state === 'dropped' && t.upload === 'done') finalize(t); return; }
    t.ask = 'no';
    log('transfer', t.tid, r.why);
    movingEnd(t, false, r.why);
    server.pushToPhone({ t: 'failed', tid: t.tid, why: r.why }, device);    // before the upload is cut: the phone won't retry it
    markGone(t.tid);
    fx('cancel', { tid: t.tid });
    clearTimeout(t.failT); clearTimeout(t.timer);
    server.abortUpload(t.tid, r.why);
    if (r.why === 'declined' || r.why === 'timeout') hist({ dir: 'in', tid: t.tid, name: t.name, size: 0, ok: false, how: 'fling', why: r.why });
    discard(t);
  });
}
function unask(t) { if (feats && t && t.ask === 'wait') feats.ask.withdraw((a) => a.tid === t.tid, 'canceled'); }
// What the user said yes to is what came: the name the question showed, or the items it listed (a question answered
// before a batch's list arrived showed how many). A sender that announced one thing and sent another ("holiday.jpg",
// then "holiday.jpg.exe"; a folder, then a program next to it) is asked about again, with what it really sent.
// A batch's items are compared as they're staged: cleaned the same way (a name Windows can't take changes), and " (2)"
// when two came out as one name; against the batch's whole list (the question showed its first 50, and how many).
function askedFor(t) {
  const sh = t.shown;
  if (!sh) return true;
  const cut = (x) => String(x).slice(0, 200);
  const count = sh.count || 1;
  if (!t.bundle) return count === 1 && cut(t.name) === cut(sh.name);
  const got = t.bundle.tops;
  if (got.length !== count) return false;
  const key = (x) => safeSegment(String(x)).toLowerCase();
  const unnum = (x) => String(x).replace(/ \(\d+\)(\.[^.]*)?$/, '$1');
  const among = (x, set) => set.has(key(x)) || set.has(key(unnum(x)));
  // (asked before its list came: one item is the one it was announced as; more, how many)
  if (!(sh.names && sh.names.length)) return count !== 1 || among(got[0], new Set([key(t.asked && t.asked.full ? t.asked.full : sh.name)]));
  const names = new Set((t.bundleInfo && t.bundleInfo.all && t.bundleInfo.all.length ? t.bundleInfo.all : sh.names).map(key));
  return got.slice(0, 500).every((x) => among(x, names));
}
// the questions show in the window, in front of whatever the user is doing (like a phone asking to pair)
function askFront(on, fresh) {
  if (on && fresh) {
    showPanel();
    if (panel) { panel.setAlwaysOnTop(true, 'floating'); panel.show(); panel.focus(); panel.flashFrame(true); }
  } else if (!on && panel && !panel.isDestroyed()) { panel.setAlwaysOnTop(false); panel.flashFrame(false); }
}

async function finalize(t) {
  if (t.done || t.ask === 'wait' || t.ask === 'no') return;
  if (t.ask === 'yes' && !t.reasked && !askedFor(t)) {
    log('transfer', t.tid, 'is not what the user accepted: asked again');
    t.reasked = true; t.ask = null;
    askFirst(t, true);
    if (t.ask === 'wait') return;
  }
  t.done = true;
  t.paused = false;
  if (t.mk) moving.onCancel(t.mk, null);         // (all of it is here and being saved: too late to stop)
  if (t.already) {
    // the phone sent nothing: this PC has the file(s) already (see have.js)
    const name = t.already.name || t.name;
    movingSaved(t, name);
    fx('saved', { tid: t.tid, name, where: saveDirLabel(), note: 'Already on this PC' });
    if (server) server.pushToPhone({ t: 'saved', tid: t.tid, name, where: saveDirLabel(), already: true });
    setTimeout(() => transfers.delete(t.tid), 5000);
    return;
  }
  let dest = null;
  try {
    const dir = await saveDirNow();
    if (t.bundle) {
      const name = await finalizeBundle(t, dir);
      movingSaved(t, name);
      fx('saved', { tid: t.tid, name, where: saveDirLabel() });
      if (server) server.pushToPhone({ t: 'saved', tid: t.tid, name, where: saveDirLabel() });
      setTimeout(() => transfers.delete(t.tid), 5000);
      return;
    }
    fs.mkdirSync(dir, { recursive: true });
    dest = uniquePath(dir, sanitizeName(t.name));
    const o = { touch: true, files: [] };
    await placeItem(t.tmpPath, dest, o);
    release(dest);
    markOfWeb(dest);
    received.addTree(dest, server.ownerOf(t.tid), o.listed ? o.files : null);   // (who sent it: only that device is told it's here, have.js)
    log('saved', dest);
    hist({ dir: 'in', tid: t.tid, path: dest, how: 'fling' });
    // a video that was playing on the phone (Air grab) carries on here from the same second
    if (t.video && air && kindOf(dest) === 'video') setTimeout(() => air.playAt(dest, t.video.t, () => openAfterArrival(dest)), 700);
    else if (store.openAfter) setTimeout(() => openAfterArrival(dest), 900);
    movingSaved(t, path.basename(dest));
    fx('saved', { tid: t.tid, name: path.basename(dest), where: saveDirLabel() });
    if (server) server.pushToPhone({ t: 'saved', tid: t.tid, name: path.basename(dest), where: saveDirLabel() });
  } catch (e) {
    log('finalize failed', e.message);
    release(dest);
    // the phone already heard its upload arrived and won't send it again: the received copy is kept, never deleted
    if (t.tmpPath && !t.kept) t.kept = await keepUnsaved(t.tmpPath, t.name && t.name !== 'file' ? t.name : 'Files');
    hist({ dir: 'in', tid: t.tid, name: t.name, size: 0, ok: false, how: 'fling', why: 'save', path: t.kept });
    movingEnd(t, false, e && (e.code === 'ENOSPC' || e.code === 'EDQUOT') ? 'space' : 'save');
    fx('failed', { tid: t.tid });
    // (another Flick device says "not enough space" when that's why)
    if (server) server.pushToPhone({ t: 'failed', tid: t.tid, why: t.peer && e && (e.code === 'ENOSPC' || e.code === 'EDQUOT') ? 'space' : 'save' });
  }
  setTimeout(() => transfers.delete(t.tid), 5000);
}

function discard(t) {
  movingEnd(t, false, 'canceled');               // (unless it ended already, with what went wrong)
  unask(t);
  if (air) air.cancel(t.tid);                    // a card a hand held (Air grab) stops waiting too
  if (t.tmpPath && t.bundle) fs.rm(t.tmpPath, { recursive: true, force: true }, () => {});
  else if (t.tmpPath) fs.unlink(t.tmpPath, () => {});
  transfers.delete(t.tid);
}

function wireServer() {
  server.on('log', (m) => log(m));
  // (it started on another port, its own being taken: it has its own back, the window says so)
  server.on('port', (p) => { log('listening', p, 'too'); pushPanelState(); });
  // (any device may say hello, paired or not, as often as it likes and under any name: see logAs)
  server.on('phone-hello', (s) => { logAs('hello', 'hello', s.name, s.address, 'app', s.appName || 'unknown'); pushPanelState(); });
  server.on('app-check', () => refreshPhoneApp(true));
  server.on('app-download', (a) => log('phone downloading app update', a.code, a.size));
  server.on('hold', ({ p }) => {
    fx('hold', { p, ph: phoneScreen().h });
  });
  server.on('connected', (s) => {
    log('connected', s.name, s.via ? 'over ' + s.via : '');
    if (s.via === 'usb') usbConnected(s.device, s.name);
    flushSendQueue();
    fx('connect', { name: s.name });
    pushPanelState();
    ensureCatcher();
    refreshPhoneApp();
  });
  server.on('disconnected', (s) => {
    logAs('disconnected', 'disconnected', s && s.name);
    pushPanelState();
    ensureCatcher();
    // cards still held by the phone that left (another connected phone's stay)
    for (const t of transfers.values()) if (t.state === 'lifted' && (!s || !server.ownerOf(t.tid) || server.ownerOf(t.tid) === s.device)) { if (air) air.cancel(t.tid); fx('cancel', { tid: t.tid }); discard(t); }
    if (air && s) air.phoneReady(s.device, false);
  });
  server.on('active', () => { pushPanelState(); ensureCatcher(); });   // another phone is in use: its name, its height
  server.on('pair-request', (s) => {
    logAs('pair request', 'pair request', s.name);
    pairAsking = s;
    showPanel();
    if (panel) {
      // make sure the "Allow" prompt is really in front of whatever the user is doing
      panel.setAlwaysOnTop(true, 'floating');
      panel.show();
      panel.focus();
      panel.flashFrame(true);
      panelSend('panel:pair', s);
    }
  });
  server.on('pair-cancel', (device) => {
    if (pairAsking && pairAsking.device === device) pairAsking = null;
    if (panel) {
      panel.setAlwaysOnTop(false);
      panel.flashFrame(false);
      panelSend('panel:pair-cancel', { device });
    }
  });
  // A Flick from before the code on both screens (1.8.0 and older) asked to pair and was refused (server.js): its user,
  // holding Connect there, is told why here, in the window while it's open. Anyone on the network can ask so, from
  // address after address: one note a minute at most, never over a question that's up, and the window isn't opened
  // for it. (Its name is as the server cleaned it when it said hello.)
  let oldSaidAt = -Infinity;
  server.on('pair-refused', (s) => {
    logAs('pair refused', 'pair refused (an older Flick):', s && s.name);
    if (!s || s.why !== 'old' || !panelUp() || pairAsking || qsAsking || webAsking || mono() - oldSaidAt < 60000) return;
    oldSaidAt = mono();
    panelSend('panel:note', { text: (String(s.name || '').slice(0, 60) || 'A device') + ' needs a newer Flick before it can pair with this PC.' });
  });
  server.on('devices-changed', (devs) => { store.devices = devs; saveStore(); pushPanelState(); });

  server.on('lift', (m) => {
    updateStage();                     // (a save folder whose drive was taken out since: staged elsewhere before the bytes come)
    const t = tState(m.tid);
    t.name = (m.file && m.file.name) || t.name;
    if (m.file) t.info = m.file;                   // name, size, count: what "Ask each time" shows
    t.state = 'lifted';
    t.seen = mono();
    t.info = liftInfo(m, t);
    fx('lift', t.info);
    t.air = !!m.air;
    if (m.air && air) air.lifted(t, m);            // picked up by a hand: it waits at the edge (air.js)
  });
  // Air grab: the hand let go of what it lifted. The transfer goes on as a dropped one; its card lands where this PC's
  // camera sees the hand open, or comes in from the edge (air.js calls airLand)
  server.on('air-go', (m) => {
    const t = transfers.get(m.tid);
    if (!t || t.state !== 'lifted') return;
    t.state = 'dropped';
    t.seen = mono();
    if (air) t.video = air.go(t, m);
    else airLand(t, flyInMsgs(m.tid, t.info).drop);
    movingIn(t);
    askFirst(t);
    if (t.upload === 'done') finalize(t);
    clearTimeout(t.timer);
  });
  // a fist that opened over the phone: the files a fist picked up in front of this PC go to it
  server.on('air-catch', (m) => { if (air) air.catchFiles(m.device); });
  // a phone with Air grab on and Flick open: selecting files here gets the camera ready for a grab (air.js)
  server.on('air-ready', (m) => { if (air) air.phoneReady(m.device, !!m.on); });
  server.on('move', (m) => { const t = transfers.get(m.tid); if (t) t.seen = mono(); fx('move', cardMove(m)); });
  server.on('drop', (m) => {
    const t = tState(m.tid);
    t.state = 'dropped';
    t.seen = mono();
    fx('drop', cardMove(m));
    movingIn(t);
    askFirst(t);
    if (t.upload === 'done') finalize(t);
    clearTimeout(t.timer);   // a dropped transfer now lives as long as bytes keep arriving (see watchdog)
  });
  server.on('send', (m) => { // programmatic send (from the phone menu): fly in from the phone edge
    const t = tState(m.tid);
    if (m.peer) t.peer = true;                     // (another Flick device's: it never sends it later, as a phone can)
    t.name = (m.file && m.file.name) || t.name;
    if (m.file) t.info = m.file;
    t.state = 'dropped';
    t.info = liftInfo(m, t);
    movingIn(t);
    askFirst(t);
    const f = flyInMsgs(m.tid, t.info, m.pw, m.ph);
    fx('lift', f.lift);
    setTimeout(() => fx('drop', f.drop), 140);
    if (t.upload === 'done') finalize(t);
  });
  server.on('cancel', (m) => {
    if (air) air.cancel(m.tid);
    const t = transfers.get(m.tid);
    if (!t) { markGone(m.tid); return; }          // never seen (its upload never started): nothing to undo
    // everything arrived and is being put in place (or is): a late cancel (a sender that stopped waiting for the answer)
    // undoes nothing, and above all doesn't delete what's being saved (kept: its sender isn't told it failed)
    if (t.done) { m.kept = true; return; }
    const wasDropped = t.state === 'dropped';
    t.state = 'canceled';
    fx(m.failed && wasDropped ? 'failed' : 'cancel', { tid: m.tid });
    clearTimeout(t.failT); clearTimeout(t.timer);
    if (t.upload === 'uploading') server.abortUpload(m.tid);
    // (another Flick device's Cancel comes as failed too: it says why; a drive here that filled up is said as such. One
    // cut short because Flick was closed there goes in History, as it does there)
    const quit = m.failed && m.why === 'quit';
    movingEnd(t, false, !(m.failed && m.why !== 'canceled') ? 'canceled' : t.noSpace || m.why === 'space' ? 'space' : quit ? 'quit' : 'failed');
    if (quit) hist({ dir: 'in', tid: m.tid, name: t.name, size: 0, ok: false, how: 'fling', why: 'quit' });
    discard(t);
    markGone(m.tid);
  });
  server.on('upload-start', ({ tid, name, total, committed, again }) => {
    // late bytes of a transfer canceled or declined here are refused; "Try again" on the phone (again) starts it anew
    if (isGone(tid)) { if (!again) { server.abortUpload(tid); return; } gone.delete(tid); }
    const fresh = !transfers.has(tid);
    const t = tState(tid);
    // thrown a while ago, it waited its turn on the phone and its card has gone: it comes back now that it's moving
    const waited = !fresh && t.state === 'dropped' && t.upload === 'none' && mono() - (t.seen || t.t0) > 20000;
    t.upload = 'uploading'; t.seen = mono();
    if (!t.peer && server.isPeerTransfer(tid)) t.peer = true;   // (its upload can start before its 'send' is read here)
    clearTimeout(t.failT);
    if (name && t.name === 'file') t.name = name;
    if (waited) {
      const f = flyInMsgs(tid, t.info || { tid, name: t.name });
      fx('resumed', { tid, lift: f.lift, drop: f.drop });
    }
    // one the user sent before this PC restarted, starting over now: its card flies in as if just sent
    if (committed && fresh) {
      t.state = 'dropped';
      t.info = { tid, name: name === 'bundle' ? 'Files' : t.name, kind: name === 'bundle' ? 'folder' : 'file', size: total || 0, count: 1, card: { w: 160, h: 160 } };
      askFirst(t);
      const f = flyInMsgs(tid, t.info);
      fx('lift', f.lift);
      setTimeout(() => fx('drop', f.drop), 140);
    }
    movingIn(t);
  });
  server.on('upload-progress', ({ tid, received, total }) => {
    const t = transfers.get(tid);
    if (!t) return;
    const now = mono();
    if (!t.rt) { t.rt = now; t.rs = received; }
    else if (now - t.rt > 400) { const inst = Math.max(0, received - t.rs) / ((now - t.rt) / 1000); t.rate = t.rate ? t.rate * 0.6 + inst * 0.4 : inst; t.rt = now; t.rs = received; }
    t.seen = now;
    if (t.state === 'dropped' && total) fx('progress', { tid, p: received / total, rate: store.showSpeed ? t.rate || 0 : 0 });
    movingIn(t);
    if (t.mk) moving.update(t.mk, received, total || -1);
  });
  // a resumable transfer stopped (its phone's app was closed, its Wi-Fi dropped): it waits for the phone to come back
  server.on('upload-paused', ({ tid }) => {
    moving.state('quiet-in:' + tid, 'paused');          // (one sent quietly, as auto-send does: its row is all there is)
    const t = transfers.get(tid);
    if (!t || t.done) return;
    log('transfer', tid, 'paused: waiting for the phone');
    t.paused = true; t.seen = mono();
    movingSync(t);
    if (t.state === 'dropped') fx('paused', { tid });
  });
  server.on('upload-resumed', ({ tid }) => {
    moving.state('quiet-in:' + tid, 'running');
    const t = transfers.get(tid);
    if (!t || t.done) return;
    log('transfer', tid, 'carries on');
    t.paused = false; t.seen = mono();
    movingSync(t);
    if (t.state === 'dropped') { const f = flyInMsgs(tid, t.info || { tid, name: t.name }); fx('resumed', { tid, lift: f.lift, drop: f.drop }); }
  });
  // the phone has nothing to send: this PC has the file(s) already
  server.on('already-have', ({ tid, name }) => {
    if (isGone(tid)) return;
    const t = tState(tid);
    log('transfer', tid, 'already on this PC:', name);
    t.upload = 'done'; t.already = { name }; t.seen = mono();
    clearTimeout(t.failT);
    if (t.state === 'dropped') finalize(t);
    else if (t.state === 'canceled') discard(t);
    else { clearTimeout(t.timer); t.timer = setTimeout(() => { if (t.state === 'lifted') discard(t); }, 120000); }
  });
  server.on('bundle-manifest', ({ tid, files, bytes, roots, count }) => {
    fx('info', { tid, size: bytes, files });
    const t = transfers.get(tid);
    if (t) {
      const all = Array.isArray(roots) ? roots.map((x) => String(x).slice(0, 1000)) : [];
      // (count: how many items it holds, which the list only starts: the question shows the first 50)
      t.bundleInfo = { files, bytes, roots: all.slice(0, 50), all, count: Math.max(all.length, +count || 0) };
      if (t.mk) moving.start(t.mk, { files: files || 1 });
      if (t.ask === 'wait' && feats && all.length) {
        feats.ask.update(tid, { count: t.bundleInfo.count, size: bytes, names: t.bundleInfo.roots });
        if (t.asked) Object.assign(t.asked, { count: t.bundleInfo.count, names: t.bundleInfo.roots.map((x) => String(x).slice(0, 200)) });
      }
    }
  });
  server.on('upload-done', ({ tid, tmpPath, name, bundle, size, ms }) => {
    if (isGone(tid)) { fs.rm(tmpPath, { recursive: true, force: true }, () => {}); return; }   // canceled meanwhile
    const t = tState(tid);
    if (size && ms) log('received', size, 'bytes in', (ms / 1000).toFixed(1) + 's', (size / Math.max(1, ms) / 1000).toFixed(1) + ' MB/s');
    t.upload = 'done'; t.tmpPath = tmpPath; t.seen = mono(); if (name) t.name = name; t.size = size || 0;
    clearTimeout(t.failT);
    if (bundle) t.bundle = bundle;
    if (t.state === 'dropped') finalize(t);
    else if (t.state === 'canceled') discard(t);
    else { clearTimeout(t.timer); t.timer = setTimeout(() => { if (t.state === 'lifted') discard(t); }, 120000); }
  });
  server.on('upload-failed', ({ tid, why }) => {
    const t = transfers.get(tid);
    log('upload failed', tid, why);
    if (/ENOENT/.test(String(why))) updateStage();      // the staging folder was deleted: made again for the retry
    if (!t) return;
    t.upload = 'failed';
    // (the drive it was written to filled up: the row says so, and another Flick device is told so too)
    const space = t.noSpace = /no space|ENOSPC|EDQUOT/.test(String(why));
    // the phone retries once by itself (same transfer); only give up if no new attempt starts soon (another Flick device
    // doesn't: its card goes within a moment)
    clearTimeout(t.failT);
    t.failT = setTimeout(() => {
      if (transfers.get(tid) !== t || t.upload !== 'failed' || t.done) return;
      if (t.state === 'dropped') { fx('failed', { tid }); server.pushToPhone({ t: 'failed', tid, why: space && t.peer ? 'space' : 'upload' }); hist({ dir: 'in', tid, name: t.name, size: 0, ok: false, how: 'fling' }); }
      else if (t.state === 'lifted') {
        fx('cancel', { tid });
        // a hand still holds it on the phone: told, and a later attempt of it is turned away (as for a cancel)
        if (t.air) { server.pushToPhone({ t: 'failed', tid, why: 'upload' }); markGone(tid); }
      }
      if (air) air.cancel(tid);
      unask(t);
      movingEnd(t, false, space ? 'space' : 'failed');
      transfers.delete(tid);
    }, t.peer ? 500 : 15000);                     // (another device's Cancel closes the upload, then says so: a moment)
  });
  server.on('set-theme', (name) => {
    if (!THEMES.includes(name)) return;
    store.theme = name; saveStore();
    server.setSettings({ side: store.side, anchor: store.anchor, theme: themeName() });
    placeOverlay(); pushPanelState();
    // show it on the PC right away (with the animations off here, nothing: the note that they're off is for a look
    // picked in this window, not one picked on the phone)
    setTimeout(() => { if (store.fx) fx('demo', {}); }, 150);
  });
  server.on('set-side', (side) => {
    store.side = side; saveStore();
    server.setSettings({ side: store.side, anchor: store.anchor, theme: themeName() });
    placeOverlay(); ensureCatcher(); pushPanelState();
  });
}

// ------------------------------------------------------------ share with a browser (webshare.js, qr.js)
// An iPhone, iPad, Mac or any other device on the same network sends and receives files in its web browser, with no
// app: the panel shows a QR code for a page this PC serves, and each browser has to be allowed here first. Files from
// a browser are saved exactly like files from the phone and fly in on the screen like a Quick Share.
const { WebShare, shareAddresses } = require('./webshare');
const QR = require('./qr');
const { Hotspot } = require('./hotspot');
let web = null, webAddr = null, webAsking = null, webAddrsSig = '';
let webQr = { url: '', qr: null };
// "On another Wi-Fi?": this PC's own Wi-Fi network for devices that aren't on its network (hotspot.js)
const hotspot = new Hotspot(Object.assign({ log: (m) => log(m) }, TEST_MODE && process.env.FLICK_FAKE_HOTSPOT ? {
  // tests: a NetworkManager that works (or, with FLICK_FAKE_HOTSPOT=fail, one that can't)
  platform: 'linux',
  run: async (what) => (what === 'nm-devices' ? { ok: true, out: 'wlan0:wifi:connected\n' } : { ok: process.env.FLICK_FAKE_HOTSPOT !== 'fail', out: '', err: 'Error: Connection activation failed: No suitable device found' }),
} : {}));
let hotQr = { text: '', qr: null }, hotAddr = null, hotLost = false;
// what it's on for: 'web' (Share with a browser) and 'connect' (Connect, for a phone on another Wi-Fi); off when neither
const hotUse = new Set();
function hotRelease(who) {
  hotUse.delete(who);
  if (!hotUse.size && hotspot.state !== 'off') { hotspot.stop(); hotAddr = null; }
}
function hotQrOf(text) {
  if (hotQr.text !== text) hotQr = { text, qr: text ? QR.svgPath(QR.encode(text, { ecl: 'M' }), 4) : null };
  return hotQr.qr;
}
hotspot.on('state', () => { pushWebState(); if (hotUse.has('connect')) pushConnect(); });
const webCards = new Map();     // batch id -> the transfer whose card is on screen

function webState() {
  const addrs = shareAddresses(lanAddresses());
  // the PC's own Wi-Fi network is on: the page's address is the one on it
  const hot = hotspot.view();
  if (hot.state === 'on' && hotAddr && addrs.some((a) => a.address === hotAddr)) webAddr = hotAddr;
  if (!addrs.some((a) => a.address === webAddr)) webAddr = addrs.length ? addrs[0].address : null;
  const on = !!(web && web.active);
  const url = on && webAddr ? web.urlFor(webAddr) : '';
  if (webQr.url !== url) webQr = { url, qr: url ? QR.svgPath(QR.encode(url, { ecl: 'M' }), 4) : null };
  hotQrOf(hot.wifi);
  return {
    on, url, qr: webQr.qr, addrs, addr: webAddr, ended: web ? web.endedWhy : '', idleMin: web ? Math.round(web.limits.idleMs / 60000) : 30, isWin: IS_WIN,
    browsers: on ? web.browsers() : [], files: on ? web.sharedFiles() : [], texts: on ? web.texts : [], asking: webAsking,
    hot: { can: hot.can, state: hot.state, kind: hot.kind, ssid: hot.ssid, pass: hot.pass, why: hot.why, qr: hotQr.qr, ready: hot.state === 'on' && webAddr === hotAddr, lost: hotLost },
  };
}

// The PC's own Wi-Fi network: on, then the address it has there (a new network adapter shows up for it)
async function startHotspot() {
  hotLost = false;
  const before = new Set(lanAddresses().map((a) => a.address));
  const v = await hotspot.start();
  if (v.state !== 'on') return;
  const known = /^192\.168\.137\.|^10\.42\.0\./;
  for (let i = 0; i < 40 && hotspot.state === 'on'; i++) {
    const now = lanAddresses().map((a) => a.address);
    const hit = now.find((a) => known.test(a)) || now.find((a) => !before.has(a));
    if (hit) { hotAddr = hit; webAddr = hit; log('PC Wi-Fi network', v.ssid, 'at', hit); break; }
    await new Promise((r) => setTimeout(r, 300));
  }
  if (!hotAddr && hotspot.state === 'on') hotLost = true;     // its address never showed: the user picks it under Network
  pushWebState();
}
function pushWebState() { panelSend('panel:web', webState()); }
setInterval(() => {
  // Wi-Fi changed while sharing: the QR code must show an address that works
  if (!web || !web.active) return;
  const sig = JSON.stringify(shareAddresses(lanAddresses()));
  if (sig !== webAddrsSig) { webAddrsSig = sig; pushWebState(); }
}, 5000).unref();

// a file from a browser lands like one from the phone: the same folder, a safe unique name, marked as downloaded
async function webSave(tmpPath, name) {
  const dir = await saveDirNow();
  fs.mkdirSync(dir, { recursive: true });
  const dest = uniquePath(dir, sanitizeName(name));
  try { await placeItem(tmpPath, dest, { touch: true }); } finally { release(dest); }
  markOfWeb(dest);
  log('saved', dest);
  return { name: path.basename(dest), path: dest, where: saveDirLabel() };
}

function onWebAsk(a) {
  // like a phone asking to pair: make sure the question is really in front of whatever the user is doing
  webAsking = a;
  showPanel();
  if (panel) {
    panel.setAlwaysOnTop(true, 'floating');
    panel.show(); panel.focus(); panel.flashFrame(true);
    panelSend('panel:web-ask', a);
  }
}
function onWebAskDone({ id }) {
  if (webAsking && webAsking.id === id) webAsking = null;
  if (panel) { panel.setAlwaysOnTop(false); panel.flashFrame(false); panelSend('panel:web-ask-done', { id }); }
}

// the files a browser sends together fly in as one card, from the phone's side of the screen
function onWebIncoming(g) {
  const tid = 'web-' + g.gid;
  const t = tState(tid);
  webCards.set(g.gid, t);
  t.name = g.count === 1 ? g.name : g.count + ' files';
  t.state = 'dropped'; t.upload = 'uploading'; t.seen = mono(); t.web = true; t.liftAt = Date.now();
  log('receiving from a browser:', g.device, g.count === 1 ? '1 file' : g.count + ' files');
  t.mk = 'web-in:' + g.gid;                       // (what's moving: see moving.js)
  moving.start(t.mk, { dir: 'in', deviceName: g.device, kind: 'browser', name: t.name, files: g.count, total: g.total });
  const ps = phoneScreen(), w = 150, h = 150;
  fx('lift', { tid, name: t.name, kind: 'doc', badge: g.count === 1 ? (extOf(g.name) || 'file').toUpperCase().slice(0, 4) : '', thumb: null, thumbs: [],
    count: Math.max(1, g.count), folder: false, size: g.total, card: { w, h } });
  const x = store.side === 'right' ? -w * 0.55 : ps.w - w * 0.45;
  setTimeout(() => fx('drop', { tid, x, y: ps.h / 2 - h / 2, w, h, r: 0, vx: store.side === 'right' ? -2.6 : 2.6, vy: 0, pw: ps.w, ph: ps.h }), 140);
}
function onWebProgress(g) {
  moving.update('web-in:' + g.gid, g.received, g.total);
  const t = webCards.get(g.gid);
  if (!t || transfers.get(t.tid) !== t || !g.total) return;
  const now = mono();
  if (!t.rt) { t.rt = now; t.rs = g.received; } else if (now - t.rt > 400) { const inst = Math.max(0, g.received - t.rs) / ((now - t.rt) / 1000); t.rate = t.rate ? t.rate * 0.6 + inst * 0.4 : inst; t.rt = now; t.rs = g.received; }
  t.seen = now;
  fx('progress', { tid: t.tid, p: Math.min(1, g.received / g.total), rate: store.showSpeed ? t.rate || 0 : 0 });
}
function onWebDone(g) {
  const t = webCards.get(g.gid);
  webCards.delete(g.gid);
  const n = g.saved.length;
  log('from a browser:', n + ' saved', g.failed ? g.failed + ' not' : '');
  // the ones the save folder wouldn't take (webshare.js: unsaved, kept in "Not saved" where they could be) are said,
  // as a phone's are: not only "Couldn't receive"
  const bad = Array.isArray(g.unsaved) ? g.unsaved : [];
  moving.end('web-in:' + g.gid, n > 0, bad.some((u) => u.why === 'space') ? 'space' : bad.length ? 'save' : 'failed');
  if (bad.length) toldUnsaved(bad.length === 1 ? bad[0].name : bad.length + ' files', bad[bad.length - 1].kept || null, bad.length > 1);
  // "open after it arrives", for a browser (a guest's device): see openGuestFile
  if (store.openAfter && n === 1 && !g.failed) {
    const p = g.saved[0].path;
    setTimeout(() => openGuestFile(p), 900);
  }
  if (!t || transfers.get(t.tid) !== t) return;
  t.done = true;
  // a quick batch can be over before its card has even been thrown (the drop follows the lift): never answer before it
  setTimeout(() => {
    if (n) fx('saved', { tid: t.tid, name: n === 1 ? g.saved[0].name : n + ' files', where: saveDirLabel() });
    else fx('failed', { tid: t.tid });
  }, Math.max(0, (t.liftAt || 0) + 400 - Date.now()));
  setTimeout(() => transfers.delete(t.tid), 5000);
}

// files added to Share with a browser (f: expandPaths up to the share's own limit, not a phone send's); what didn't fit
// is said (it stops taking files at its limit), with what the folders left out, in one note: one limit, the one that
// cut the pick (it said the share's 200 and a phone send's 100 together, "remove some" and "send the rest"). (Files
// already shared, given again, aren't left out.)
function webAdd(f) {
  web.addFiles(f);
  const shared = new Set([...web.files.values()].map((x) => x.path));
  // (a pick cut at the share's own limit is said so, in the share's words, even when files in it were shared already)
  const full = f.more || (web.files.size >= web.limits.files && f.some((p) => !shared.has(p)));
  const limit = full ? 'Only the first ' + web.limits.files + ' files are shared. Remove some to add more.' : '';
  if (limit && f.deep) onlyFirst('are shared', { more: false, deep: true }, limit);
  else if (limit) panelSend('panel:note', { text: limit });
  else if (f.more || f.deep) onlyFirst('are shared', f);
}
ipcMain.on('panel:web', async (e, m) => {
  if (!web || !fromPanel(e) || !m || typeof m !== 'object') return;
  switch (m.what) {
    case 'start': web.start(); break;
    case 'stop': web.stop('user'); hotRelease('web'); break;
    case 'hot-start': hotUse.add('web'); startHotspot(); break;
    case 'hot-stop': hotUse.clear(); hotspot.stop(); hotAddr = null; if (CONNECT.phase === 'hot') connectCancel(); break;   // (the user turned it off)
    case 'addr': if (typeof m.addr === 'string') webAddr = m.addr; break;
    case 'pick': {
      if (!web.active) break;
      const r = await dialog.showOpenDialog(panel, { title: 'Share with browsers', properties: ['openFile', 'multiSelections'] });
      if (!r.canceled && r.filePaths.length) { webAdd(expandPaths(r.filePaths, web.limits.files)); }
      break;
    }
    case 'add': {
      if (!web.active || !Array.isArray(m.paths)) break;
      webAdd(expandPaths(m.paths.filter((p) => typeof p === 'string').slice(0, web.limits.files + 1), web.limits.files));
      break;
    }
    case 'remove': web.removeFile(String(m.id)); break;
    case 'answer': if (m.allow) web.allow(String(m.id)); else web.deny(String(m.id)); break;
    case 'kick': web.kick(String(m.id)); break;
    case 'copy': {
      const t = m.text ? web.texts.find((x) => x.id === m.text) : null;
      const v = t ? t.text : m.url ? webState().url : '';
      if (v) require('electron').clipboard.writeText(v);
      break;
    }
    case 'drop-text': web.removeText(String(m.id)); break;
    default: break;                               // 'hello': the panel (re)loaded and needs the state
  }
  pushWebState();
});

function startWeb() {
  // (a file the save folder wouldn't take is kept as a phone's is, in "Not saved", and said: onWebDone)
  web = new WebShare({ server, save: webSave, keep: (tmp, name) => keepUnsaved(tmp, name, true), where: saveDirLabel });
  server.web = web;                             // server.js hands /w/ requests to it
  web.on('log', (m) => log(m));
  // sharing ended (by itself, after a while with no browser): the PC's own Wi-Fi network goes with it
  web.on('state', () => { if (!web.active) hotRelease('web'); pushWebState(); });
  web.on('ask', onWebAsk);
  web.on('ask-done', onWebAskDone);
  web.on('incoming-start', onWebIncoming);
  web.on('incoming-progress', onWebProgress);
  web.on('incoming-done', onWebDone);
  web.on('text', (t) => { showPanel(); panelSend('panel:web-text', { id: t.id }); });
}

// ------------------------------------------------------------ cables
// A phone over its USB cable (tethering on there), or another computer at the other end of one: "USB connected. Ready
// to transfer." at once, in the window (and as a notification when the window isn't in front). Once per cable (a
// device seen over one in the last minute isn't said again).
const usbSaid = new Map();
function usbConnected(id, name) {
  const at = usbSaid.get(id) || 0;
  usbSaid.set(id, Date.now());
  if (Date.now() - at < 60000) return;
  log('usb: connected to', name);
  panelSend('panel:note', { text: 'USB connected. Ready to transfer with ' + name + '.' });
  const front = panel && !panel.isDestroyed() && panel.isVisible() && panel.isFocused();
  if (feats && !front) feats.toast({ title: 'USB connected', body: name + ' is ready to transfer over the cable.', silent: true, click: () => showPanel() });
}
// a new network here (a cable plugged in, a phone's USB tethering turned on): devices are looked for at once, so the
// one at the other end shows up (and is said) within a moment instead of at the next look
function watchCables() {
  const sig = () => Object.entries(os.networkInterfaces()).map(([n, l]) => n + '=' + (l || []).filter((a) => (a.family === 'IPv4' || a.family === 4) && !a.internal).map((a) => a.address).join(',')).sort().join('|');
  let was = sig();
  const t = setInterval(() => {
    const now = sig();
    if (now === was) return;
    was = now;
    if (peers) peers.scanFor(15000);
  }, 2500);
  if (t.unref) t.unref();
}

// ------------------------------------------------------------ your other devices (peerlink.js)
// Flick on another computer (or a phone that takes files from other devices): found on the network, paired once with
// the code (both ways), then either one sends to the other. What they send here comes through this PC's own receiver
// (server.js, as a "peer") and lands like a file thrown from a phone.
let peers = null;
function startPeers() {
  if (!server || !server.port) return;
  const { Peers } = require('./peerlink');
  if (!store.peerLinks || typeof store.peerLinks !== 'object') store.peerLinks = {};
  peers = new Peers({
    me: { id: store.id, name: store.name || os.hostname(), kind: 'pc' }, links: store.peerLinks, save: saveStore, saveNow: () => { writeStoreNow(); saveStore(); },
    // pairing goes both ways: the other device gets a token for this PC's receiver
    grant: (id, info) => {
      // (one it was given a token for here a moment ago, from pairing the other way at the same time, keeps it: one token
      // a way. A pairing from before doesn't pass its token on.)
      const was = server.devices[id];
      const at = was ? Math.max(+was.added || 0, +was.back || 0) : 0;
      const keep = was && was.peer && was.tls === true && /^[0-9a-f]{32}$/.test(String(was.token || '')) && Date.now() >= at && Date.now() - at < 10 * 60000;
      const token = keep ? was.token : require('crypto').randomBytes(16).toString('hex');
      // back: given now, as this PC's user confirmed the code with it (a request of its own allowed here in a moment
      // keeps this token: see server.js approve). A pairing that was waiting for that confirmation has it now.
      server.devices[id] = { name: String(info.name || 'Flick device').slice(0, 60), token, added: (keep && was.added) || Date.now(), tls: true, peer: true, kind: info.kind === 'phone' ? 'phone' : 'pc', back: Date.now() };
      server.emit('devices-changed', server.devices);
      return { token, fp: server.fp, port: server.port };
    },
    revoke: (id) => { if (server.devices[id] && server.devices[id].peer) server.forget(id); },
    kindOf, thumbFor: (p) => thumbFor(p),
    discoveryPort: server.discoveryPort,
    // tests run several copies on one machine, each listening for discovery on its own port
    extraPorts: TEST_MODE ? String(process.env.FLICK_TEST_PEER_PORTS || '').split(',').map(Number).filter((n) => n > 0) : [],
    // (tests only: a copy started with FLICK_TEST_SAME_CODE=1 says Same code by itself, as its user would)
    sameCode: TEST_MODE && process.env.FLICK_TEST_SAME_CODE === '1',
    log,
  });
  peers.on('state', pushPeers);
  peers.on('state', sendWaiting);
  peers.on('state', () => { if (CONNECT.phase === 'asking') { connectPairedCheck(); pushConnect(); } });   // (the code, once it shows)
  // (a phone asked from here, allowed here as it asked this PC: it's one of this PC's phones now)
  server.on('devices-changed', () => setImmediate(connectPairedCheck));
  // another computer at the other end of a cable (USB4, Thunderbolt, a transfer cable): said at once
  peers.on('state', () => { for (const d of peers.state().devices) if (d.paired && d.nearby && d.via === 'usb' && d.kind !== 'phone') usbConnected(d.id, d.name); });
  watchCables();
  // a computer paired or removed: what sends from here can go to (the window's list, the screen's edge)
  let linksSig = '';
  peers.on('state', () => {
    const sig = Object.keys(store.peerLinks || {}).join();
    if (sig === linksSig) return;
    linksSig = sig;
    if (store.target && !targetPc()) { store.target = null; saveStore(); }
    ensureCatcher();
    pushPanelState();
  });
  // the first files' cards leave this screen as the other device's fly in (as files sent to the phone do)
  peers.on('start', (m) => {
    (m.cards || []).slice(0, 3).forEach((c, i) => fx('outgoing', { fid: m.tid + '-' + i, name: c.name, kind: c.kind, thumb: c.thumb || null, look: m.look,
      badge: c.kind === 'doc' ? (extOf(c.name) || 'file').toUpperCase().slice(0, 4) : '', y: overlayYFromScreenY(overlayBounds().y + store.anchor * overlayBounds().height) + i * 22, card: { w: 150, h: 150 } }));
  });
  peers.on('sent', (m) => {
    hist({ dir: 'out', path: m.path, name: m.name, size: m.size, device: m.id, deviceName: m.to, how: 'peer' });
    // (what didn't go is said: files that changed or went since they were picked, past the most one send takes, folders
    // too deep to be taken)
    const notes = [];
    // (one that couldn't be read can be a whole folder: items, then)
    if (m.left) notes.push(m.left.toLocaleString() + (m.unread ? (m.left === 1 ? ' item' : ' items') : (m.left === 1 ? ' file' : ' files')) + ' couldn’t be read and didn’t go.');
    if (m.more) notes.push('Only the first ' + m.files.toLocaleString() + ' files went. Send the rest separately.');
    if (m.deep) notes.push('Folders more than 62 levels deep were left out.');
    if (m.unconfirmed) notes.push('The connection closed before ' + m.to + ' said it saved them.');
    const body = notes.length ? notes.join(' ') : m.files === 1 ? m.name : m.files.toLocaleString() + ' files';
    if (feats && (notes.length || !peersShown()) && !app.isQuitting) feats.toast({ title: 'Sent to ' + m.to, body, silent: !notes.length });
  });
  // a send that didn't go: in History, and said unless Devices is showing it. (One its user canceled there
  // isn't something that went wrong: as one canceled here, it's only its row in Transfers, saying Canceled.)
  peers.on('failed', (m) => {
    if (m.code === 'ECANCELEDTHERE') return;
    // (one cut short by quitting Flick: in History as such, from before Flick goes; nothing on the screen. One cut short
    // by quitting it on the other computer: in History as such, and said)
    const quit = m.code === 'EQUIT';
    // (one the other computer's user declined, or didn't answer in time, says so in History as it does in Transfers)
    const why = quit || m.code === 'EQUITTHERE' ? 'quit' : m.code === 'EDECLINED' ? 'declined' : 'send';
    hist({ dir: 'out', path: m.path, name: m.name, size: 0, device: m.id, deviceName: m.to, how: 'peer', ok: false, why });
    if (feats && !peersShown() && !quit) feats.toast({ title: 'Not sent to ' + m.to, body: m.why });
  });
  // a paired device that signed in under a new name: this PC calls it that from now on
  server.on('peer-name', (m) => peers.rename(m.device, m.name));
  server.on('peer-back', (m) => peers.addLink(m.device, { name: m.name, kind: m.kind, fp: m.fp, token: m.token, ip: m.address, port: m.port }));
  server.on('peer-forget', (m) => { peers.forget(m.device, false); log('peer removed this PC:', m.device); });
  server.on('peer-hello', (s) => logAs('peer hello', 'peer hello', s.name, s.address));
  server.on('peer-connected', (s) => { log('peer connected', s.name); pushPeers(); });
  server.on('peer-disconnected', (s) => { log('peer left', s && s.name); pushPeers(); });
  // this PC's phones are in the list too
  for (const ev of ['connected', 'disconnected', 'active', 'devices-changed']) server.on(ev, pushPeers);
}
// the one list of where files can go from here: this PC's phones first (connected or not), then the other computers
const isPhone = (id) => !!(server && id && Object.prototype.hasOwnProperty.call(server.devices, id) && !server.devices[id].peer);
function peersState() {
  const st = peers ? peers.state() : { scanning: false, devices: [] };
  for (const d of st.devices) d.ask = !!(store.acceptMode && store.acceptMode[d.id] === 'ask');
  if (server) {
    const live = new Map(server.phones().map((p) => [p.device, p]));
    const phones = [];
    for (const [id, dv] of Object.entries(server.devices || {})) {
      if (!dv || dv.peer) continue;
      const p = live.get(id);
      // (waiting: allowed here a moment ago, its user still checking the code there: server.js approve)
      phones.push({ id, name: (p && p.name) || dv.name || 'Phone', kind: 'phone', phone: true, paired: true, nearby: !!p, active: !!(p && p.active), waiting: !!dv.phoneProv });
    }
    phones.sort((a, b) => b.nearby - a.nearby || String(a.name).localeCompare(String(b.name)));
    // Paired one way: a device that can send here, but this PC can't send to it (the pairing wasn't finished on it, or
    // it never said how to reach it). It's listed, so it can be removed, or paired from here too.
    for (const [id, dv] of Object.entries(server.devices || {})) {
      if (!dv || !dv.peer || (store.peerLinks && store.peerLinks[id])) continue;
      // (allowed here a moment ago, its user still checking the code there: said so, not "can send files here")
      const waiting = !!dv.prov;
      const d = st.devices.find((x) => x.id === id);
      if (d) Object.assign(d, { paired: true, oneWay: true, waiting });
      else st.devices.push({ id, name: dv.name || 'Flick device', kind: dv.kind === 'phone' ? 'phone' : 'pc', os: '', paired: true, oneWay: true, waiting, nearby: false, busy: null, error: null, ask: !!(store.acceptMode && store.acceptMode[id] === 'ask') });
    }
    st.devices = phones.concat(st.devices);
  }
  st.me = store.name;
  return st;
}
async function pickForPhone(id, folders) {
  if (!panel || !isPhone(id)) return;
  const r = await dialog.showOpenDialog(panel, { title: 'Send to ' + (server.devices[id].name || 'your phone'), properties: folders ? ['openDirectory', 'multiSelections'] : ['openFile', 'multiSelections'] });
  if (!r.canceled && r.filePaths.length) sendToPhone(id, r.filePaths);
}
// to one phone of this PC's: files, or a folder's files (as when they're dropped on this window)
function sendToPhone(id, paths) {
  if (!server || !server.phones().some((p) => p.device === id)) { panelSend('panel:note', { text: 'Open Flick on ' + ((server && server.devices[id] && server.devices[id].name) || 'the phone') + ' to send to it.' }); return; }
  sendPathsToPhone(paths, null, { device: id });
}
function pushPeers() { if (panel && !panel.isDestroyed()) panelSend('panel:peers', peersState()); }
// Devices is open in the window (its rows say how sends go): a send's end needs no notification then
let peersView = false;
const peersShown = () => !!(peersView && panel && !panel.isDestroyed() && panel.isVisible());
async function pickForPeer(id, folders) {
  const l = store.peerLinks && store.peerLinks[id];
  if (!l || !panel) return;
  const r = await dialog.showOpenDialog(panel, { title: 'Send to ' + l.name, properties: folders ? ['openDirectory', 'multiSelections'] : ['openFile', 'multiSelections'] });
  // (through sendToPc: one going to it already, they go right after it, and the window says so, as from the shortcut)
  if (!r.canceled && r.filePaths.length) sendToPc(id, r.filePaths);
}
ipcMain.on('panel:peers', (e, m) => {
  if (!peers || !fromPanel(e) || !m || typeof m !== 'object') return;
  const id = typeof m.id === 'string' ? m.id.slice(0, 64) : '';
  switch (m.what) {
    case 'open': peersView = true; peers.scan(true); break;          // looking for devices only while the list is open
    case 'close': peersView = false; peers.scan(false); break;
    case 'pair': peers.pair(id); break;
    case 'confirm': peers.confirm(id, m.same === true); break;
    case 'cancel': peers.cancel(id); break;
    case 'forget': peers.forget(id); break;
    case 'pick': if (isPhone(id)) pickForPhone(id); else pickForPeer(id, false); break;
    // (a phone's row has Send a folder too: its folder goes as one dropped on the window does)
    case 'pick-folder': if (isPhone(id)) pickForPhone(id, true); else pickForPeer(id, true); break;
    case 'send': {
      if (!Array.isArray(m.paths)) break;
      const paths = m.paths.filter((p) => typeof p === 'string').slice(0, 1000);
      if (isPhone(id)) sendToPhone(id, paths); else sendToPc(id, paths);
      break;
    }
    default: break;                                // 'hello': the panel (re)loaded and needs the state
  }
  pushPeers();
});

// ------------------------------------------------------------ Connect: hold it here, Allow on the other device
// Holding Connect in Flick's window reaches a new device, a computer or a phone alike: every Flick device nearby is
// looked for (every 300 ms while it's held) and the one meant is asked: the only one there, else the one on a cable,
// else the one whose Connect screen (or Flick window) is showing, else the user picks it from a short list. That device
// asks its user (Allow / Don't allow, with the same code on both screens); once it's allowed there, the user here says
// it's the same code (Same code: anyone nearby could have answered as the device meant, and allowed itself), and both
// are paired. Over a cable (the device on the other end of it) its Allow is enough. A computer pairs as computers do
// (peerlink.js pair: both ways); a phone becomes one of this PC's phones (peerlink.js invite) and connects here right
// after, as if its user had held Connect on it.
// (hot: what's going on started with this PC's own Wi-Fi network, made for it: see hotDone. near: nothing could be asked,
// though something answered: see connectNear)
// (diff: the user here said Different code to the one asked)
// (at, and the network's hotSeenAt: by mono(), the clock that only moves forward. With the wall clock set back, "Looking
// for devices nearby" stayed for the hour and this PC's Wi-Fi network was kept; set ahead, Connect was canceled at once.)
const CONNECT = { phase: 'idle', target: null, list: [], why: '', lookT: null, fastT: null, doneT: null, at: 0, hot: false, near: null, diff: false };
function connectState() {
  const t = CONNECT.target, b = t && peers ? peers.busy.get(t.id) : null;
  const h = hotspot.view();
  return {
    phase: CONNECT.phase, why: CONNECT.why, code: b && b.code ? b.code : null,
    // allowed there: the user here says whether it's the same code (codeOk: said, or not needed: on a cable)
    allowed: !!(b && b.what === 'pairing' && b.allowed), codeOk: !!(b && b.codeOk),
    target: t ? { id: t.id, name: t.name, kind: t.kind } : null,
    list: CONNECT.phase === 'choose' ? CONNECT.list.map((c) => ({ id: c.id, name: c.name, kind: c.kind, ready: !!c.ready })) : [],
    // this PC's own Wi-Fi, for a phone on another one (Mac: an app can't make one). Offered whatever was found here: an
    // older Flick, one paired already or other devices on this network don't say the phone meant isn't elsewhere. Not
    // once on that network already (a device that showed up there is being asked, or picked from).
    hotCan: h.can && !CONNECT.hot,
    near: CONNECT.phase === 'none' ? CONNECT.near : null,
    hot: CONNECT.phase === 'hot' ? { state: h.state, ssid: h.ssid, pass: h.pass, qr: h.state === 'on' ? hotQrOf(h.wifi) : null, kind: h.kind } : null,
    // that network, still on after Connect (for a phone connected over it, or a new hold from its "Which one?" that found
    // nothing): said, with a way to turn it off (shown while nothing is being looked for or asked: see connect.js)
    hotStays: hotUse.has('connect') && h.state === 'on' && CONNECT.phase !== 'hot' ? { ssid: h.ssid } : null,
  };
}
function pushConnect() { panelSend('panel:connect', connectState()); }
// (on for a while after the hold too: answers on their way still count)
function connectFast(on) {
  if (!peers) return;
  clearTimeout(CONNECT.fastT);
  if (on) { peers.scanAny(true); CONNECT.fastT = setTimeout(() => peers.scanAny(false), 20000); }
  else CONNECT.fastT = setTimeout(() => peers.scanAny(false), 1500);
}
const connectCands = () => (peers ? peers.candidates((home) => isPhone(home)) : []);
// The one meant, when it's clear: the only one; else the one on a cable, else the one whose Connect screen (Flick's
// window) is showing (one on a cable with it showing comes first): the single best, if it shows either
function connectPick(list) {
  if (list.length === 1) return list[0];
  const score = (c) => (c.via === 'usb' ? 4 : 0) + (c.ready ? 2 : 0);
  let best = null, top = 0, n = 0;
  for (const c of list) { const s = score(c); if (s > top) { best = c; top = s; n = 1; } else if (s === top) n++; }
  return top > 0 && n === 1 ? best : null;
}
// Nothing to ask, though something answered: what it is is said, not "No device found nearby". A computer with a Flick
// from before 2.1 can't pair (and this PC's own Wi-Fi isn't offered: that one is right here); one paired already has
// nothing more to connect.
function connectNear() {
  const o = peers ? peers.nearbyOthers((home) => isPhone(home)) : [];
  const old = o.filter((x) => x.why === 'old');
  CONNECT.near = old.length ? 'old' : o.length ? 'paired' : null;
  if (old.length) CONNECT.why = old.length === 1 ? old[0].name + ' has an older Flick. Update Flick there to connect.' : 'The computers nearby have an older Flick. Update Flick there to connect.';
  else if (o.length) CONNECT.why = o.length === 1 ? o[0].name + ' is paired already. Send to it in Devices.' : 'The devices nearby are paired already. Send to them in Devices.';
}
// the hold is complete (or Connect was clicked, or pressed with the keyboard)
function connectGo() {
  if (!peers || CONNECT.phase === 'asking' || CONNECT.phase === 'hot') return;   // (on this PC's Wi-Fi: looking already)
  clearTimeout(CONNECT.doneT);
  CONNECT.target = null; CONNECT.why = ''; CONNECT.near = null;
  const list = connectCands();
  if (list.length) { connectChoose(list); return; }
  // nothing seen yet: answers can take a moment (Flick just opened there, a slow network)
  CONNECT.phase = 'looking'; CONNECT.at = mono();
  pushConnect();
  clearInterval(CONNECT.lookT);
  CONNECT.lookT = setInterval(() => {
    const l = connectCands();
    if (!l.length && mono() - CONNECT.at < 4000) return;
    clearInterval(CONNECT.lookT);
    if (l.length) { connectChoose(l); return; }
    connectFast(false);
    CONNECT.phase = 'none';
    connectNear();
    pushConnect();
  }, 250);
}
// (a list nobody picks from, the window closed or its user gone, goes after 2 minutes: it would keep this PC's own Wi-Fi
// network on, and offer devices that left long ago)
function connectChoose(list) {
  const one = connectPick(list);
  if (one) { connectAsk(one); return; }
  connectFast(false);
  CONNECT.phase = 'choose'; CONNECT.list = list.slice(0, 12);
  clearTimeout(CONNECT.doneT);
  CONNECT.doneT = setTimeout(() => { if (CONNECT.phase === 'choose') connectCancel(); }, 2 * 60000);
  pushConnect();
}
async function connectAsk(c) {
  clearTimeout(CONNECT.doneT);
  CONNECT.phase = 'asking'; CONNECT.target = c; CONNECT.why = ''; CONNECT.list = []; CONNECT.diff = false;
  connectFast(false);
  pushConnect();
  let ok = false, why = null;
  // (listed a while ago, "Which one?": one that has stopped answering since, or that this PC is asking already from Your
  // other devices, isn't asked: said in words)
  const gone = c.kind === 'pc' ? !peers.found.has(c.id) : !peers.phones.has(c.id);
  if (gone) why = c.name + ' isn’t answering any more. Hold Connect again.';
  else if (peers.busy.has(c.id)) why = c.name + ' is busy with another request. Try again in a moment.';
  else {
    try {
      if (c.kind === 'pc') { ok = await peers.pair(c.id, { auto: true }); why = ok ? null : peers.errors.get(c.id) || null; }
      else { const r = await peers.invite(c.id, grantHome); ok = r.ok; why = r.why; }
    } catch (e) { why = 'Connecting to ' + c.name + ' didn’t work. Try again.'; }
  }
  if (CONNECT.target !== c) return;              // (canceled meanwhile)
  // Different code here: not paired, and said so for a moment (as the phone says it). That wins: a pairing made the other
  // way meanwhile (its user held Connect there too, and it was allowed here) goes with it (for a computer, pair() undoes
  // it); nothing ends as "Connected" after the user here said the codes differ.
  const diff = !ok && CONNECT.diff;
  if (diff) {
    if (c.kind !== 'pc' && c.home && isPhone(c.home)) { log('connect: Different code: the phone paired the other way meanwhile goes too'); server.forget(c.home); }
    why = why || 'Not paired with ' + c.name + ': the codes didn’t match.';
  } else if (!ok && connectPairedNow(c)) { ok = true; why = null; }   // (paired the other way meanwhile: what was asked for)
  CONNECT.phase = ok ? 'done' : why ? 'failed' : 'idle';
  CONNECT.why = why || '';
  if (!ok && !why) CONNECT.target = null;
  // (asked over this PC's own network: paired, it's kept while the phone is connected over it; not paired, it goes)
  if (ok) CONNECT.hot = false; else if (CONNECT.hot) hotDone();
  pushConnect();
  pushPeers();
  if (ok || why) CONNECT.doneT = setTimeout(() => { if (CONNECT.target === c) { CONNECT.phase = 'idle'; CONNECT.target = null; CONNECT.why = ''; pushConnect(); } }, ok || diff ? 6000 : 15000);
}
function connectCancel() {
  const c = CONNECT.target;
  clearInterval(CONNECT.lookT);
  clearTimeout(CONNECT.doneT);
  if (CONNECT.phase === 'asking' && c && peers) peers.cancel(c.id);
  // (with this PC's Wi-Fi made for it: it goes off, unless a phone is connected over it or something else uses it)
  if (CONNECT.hot) hotDone();
  CONNECT.phase = 'idle'; CONNECT.target = null; CONNECT.list = []; CONNECT.why = ''; CONNECT.near = null;
  connectFast(false);
  pushConnect();
}
// Paired with c the other way: a computer this PC now has a link to, or a phone that's now one of this PC's (allowed
// here, and its user said Same code there; not one given this PC's pairing a moment ago as it was asked: that's this
// asking itself)
function connectPairedNow(c) {
  if (c.kind === 'pc') return !!(store.peerLinks && store.peerLinks[c.id]);
  const d = c.home && server && Object.prototype.hasOwnProperty.call(server.devices, c.home) ? server.devices[c.home] : null;
  return !!(d && !d.peer && !d.homeProv && !d.phoneProv);
}
// While asking: paired the other way meanwhile (its user held Connect there too, and it was allowed here). The request
// from here is taken back, which takes it off the other device's screen too, and Connect says it's connected (see
// connectAsk). (Not once the other device allowed the request from here: that pairing is finishing by itself.)
function connectPairedCheck() {
  const c = CONNECT.target;
  if (CONNECT.phase !== 'asking' || !c || !peers || !connectPairedNow(c)) return;
  const b = peers.busy.get(c.id);
  if (!b || b.what !== 'pairing' || b.allowed || b.canceled) return;
  log('connect: paired the other way meanwhile');
  peers.cancel(c.id);
}

// "Phone on another Wi-Fi?" (nothing was found, or not the one meant): this PC makes a Wi-Fi network of its own (hotspot.js), the phone joins
// it from a code its camera reads, and the first device that shows up there with Flick open is asked, as if found at
// once. The network stays while a phone connected over it is here, and goes 2 minutes after the last one leaves (or
// after 10 minutes with none). Connect canceled, or the device asked not paired, it goes at once (unless a phone is
// connected over it).
async function connectHot() {
  if (!peers || !hotspot.can || CONNECT.phase === 'hot' || CONNECT.hot) return;
  // (from "Asking …", a device on this PC's network asked at once: that request is taken back first, as Cancel does, and
  // its answer is then ignored (connectAsk). Not once it was allowed there: that pairing is finishing.)
  if (CONNECT.phase === 'asking') {
    const c = CONNECT.target, b = c ? peers.busy.get(c.id) : null;
    if (b && b.allowed) return;
    if (c) peers.cancel(c.id);
  }
  clearInterval(CONNECT.lookT);
  clearTimeout(CONNECT.doneT);
  CONNECT.phase = 'hot'; CONNECT.target = null; CONNECT.why = ''; CONNECT.list = []; CONNECT.at = mono(); CONNECT.hot = true; CONNECT.near = null;
  hotUse.add('connect');
  hotWatch();
  pushConnect();
  startHotspot();                                    // (its address on it comes a moment later: looked for meanwhile)
  let fastAt = -Infinity;
  CONNECT.lookT = setInterval(() => {
    if (CONNECT.phase !== 'hot') { clearInterval(CONNECT.lookT); return; }
    if (hotspot.state === 'starting') return;
    if (hotspot.state !== 'on') {
      clearInterval(CONNECT.lookT);
      CONNECT.phase = 'none'; CONNECT.why = hotspot.why || 'Couldn’t start this PC’s Wi-Fi network'; CONNECT.hot = false;
      hotRelease('connect');
      pushConnect();
      return;
    }
    if (mono() - CONNECT.at > 10 * 60e3) { connectCancel(); return; }
    if (mono() - fastAt > 15000) { fastAt = mono(); connectFast(true); }   // (still looking)
    // Only a device on this PC's network is the one meant: the PC can be on its usual network at the same time (Windows),
    // where someone else's phone or computer may have Flick open. Nobody is asked until this PC's address on it shows (a
    // moment); if it never does, there's no telling, and whoever shows up is.
    if (!hotAddr && !hotLost) return;
    const pre = hotNet();
    const l = connectCands().filter((c) => !pre || onHotNet(pre, c.ip));
    if (l.length) { clearInterval(CONNECT.lookT); connectChoose(l); }
  }, 500);
}
// this PC's own network: the addresses on it start as this PC's own there does (192.168.137. on Windows, 10.42.0. with
// NetworkManager); null while that isn't known
const hotNet = () => (hotAddr ? hotAddr.slice(0, hotAddr.lastIndexOf('.') + 1) : null);
const onHotNet = (pre, a) => !!(pre && a && String(a).replace(/^::ffff:/, '').startsWith(pre));
// A phone connected over that network now (an address on it). While its address isn't known (it never showed), any
// phone connected counts: there's no telling, and cutting a phone off is worse than the network staying (the Connect card
// says it's on, with a way to turn it off).
function hotPhone() {
  if (!server) return false;
  if (!hotAddr && hotspot.state === 'on') {
    // (it can show late: looked for again)
    const a = lanAddresses().find((x) => /^192\.168\.137\.|^10\.42\.0\./.test(x.address));
    if (a) { hotAddr = a.address; hotLost = false; log('PC Wi-Fi network at', hotAddr); }
  }
  const pre = hotNet();
  return server.phones().some((p) => !pre || onHotNet(pre, p.address));
}
// The network made for Connect: kept while it's looking or asking, or a phone connected over it is here. Not for "Which
// one?" waiting for a pick: that list goes by itself.
let hotWatchT = null, hotSeenAt = 0;
function hotWatch() {
  hotSeenAt = mono();
  if (hotWatchT) return;
  hotWatchT = setInterval(() => {
    if (!hotUse.has('connect') || hotspot.state === 'off') { clearInterval(hotWatchT); hotWatchT = null; return; }
    const used = CONNECT.phase === 'hot' || CONNECT.phase === 'asking' || hotPhone();
    if (used) hotSeenAt = mono();
    else if (mono() - hotSeenAt > 2 * 60e3) { log('PC Wi-Fi network: no phone on it any more'); hotRelease('connect'); clearInterval(hotWatchT); hotWatchT = null; pushConnect(); }
  }, 10000);
  hotWatchT.unref();
}
// Connect is done with the network it made (canceled; the device asked didn't pair): it goes now, unless a phone is
// connected over it (it then stays while that one is here, said in the Connect card)
function hotDone() {
  CONNECT.hot = false;
  if (!hotUse.has('connect')) return;
  if (hotPhone()) { hotSeenAt = mono(); return; }
  log('PC Wi-Fi network: Connect is done with it');
  hotRelease('connect');
}
// A phone this PC asked (Connect) and whose user allowed it there: one of this PC's phones from now on. It's kept once
// it signs in here with this pairing (server.js 'auth' clears homeProv); one that never does (it never got it, or went
// away) is dropped in a moment.
function grantHome(device, name) {
  if (!server || !/^[A-Za-z0-9_-]{1,64}$/.test(String(device || ''))) return null;
  // A phone or computer paired with this PC already keeps its pairing: a device asked to become one of its phones can't
  // take its place by saying it's that one (its id is only what it says). (One given a pairing here a moment ago that
  // never connected with it may be given a new one.)
  const was = server.devices[device];
  if (was && !was.homeProv) return { exists: true };
  const token = require('crypto').randomBytes(16).toString('hex');
  server.devices[device] = { name: String(name || 'Phone').slice(0, 60), token, added: Date.now(), tls: true, homeProv: Date.now() };
  server.emit('devices-changed', server.devices);
  setTimeout(() => {
    const d = server.devices[device];
    if (d && d.homeProv && d.token === token) { log('the phone never connected with its pairing:', name); server.forget(device); }
  }, 150000).unref();
  return { token, fp: server.fp, port: server.port, addrs: lanAddresses().map((a) => a.address).slice(0, 8) };
}
ipcMain.on('panel:connect', (e, m) => {
  if (!peers || !fromPanel(e) || !m || typeof m !== 'object') return;
  switch (m.what) {
    case 'hold':                                     // held down: everything nearby is looked for, fast
      if (CONNECT.phase !== 'asking') { connectFast(true); if (CONNECT.phase !== 'choose' && CONNECT.phase !== 'hot') { CONNECT.phase = 'idle'; CONNECT.why = ''; } }
      break;
    case 'let-go': if (CONNECT.phase === 'idle') connectFast(false); break;   // (let go too soon)
    case 'go': connectGo(); break;
    case 'pick': { const c = CONNECT.list.find((x) => x.id === m.id); if (c && CONNECT.phase === 'choose') connectAsk(c); break; }
    case 'cancel': connectCancel(); break;
    // Same code / Different code, once the device asked allowed it (the pairing counts only with Same code)
    case 'confirm':
      if (CONNECT.phase === 'asking' && CONNECT.target) { if (m.same !== true) CONNECT.diff = true; peers.confirm(CONNECT.target.id, m.same === true); }
      break;
    case 'hot': connectHot(); break;                 // a phone on another Wi-Fi: this PC's own network, and its code
    // that network, still on after Connect: turned off (a share with a browser using it keeps it). Not while Connect looks
    // or asks over it, where the card doesn't offer it.
    case 'hot-off':
      if (hotUse.has('connect') && /^(idle|none|done|failed)$/.test(CONNECT.phase)) { CONNECT.hot = false; log('PC Wi-Fi network: turned off in Connect'); hotRelease('connect'); }
      break;
    default: break;                                  // 'hello': the window (re)loaded and needs the state
  }
  pushConnect();
});

// ------------------------------------------------------------ what's moving (moving.js)
// Every transfer between this PC and another device, both ways, while it moves: listed at the top of the window's main
// view (Transfers), shown on a small card in a corner of the screen while the window isn't open, and as the taskbar's
// (the Dock's) progress. Each way files move tells it: files coming in from a phone or another device (transfers),
// files offered to a phone (as it fetches them), sends to other devices (peerlink.js), Quick Share and browsers.
const { Moving } = require('./moving');
const moving = new Moving();
// Quit Flick (the window's or the tray's) while files are moving asks first, in the window, as Remove and Clear ask
// once more: quitting cuts them (a phone starts over, a browser's or another computer's send must be sent again). Only
// files actually moving count (as listed in Transfers): with none, as with a card only lifted on a phone or a question
// waiting, it quits at once, as 2.0 did. While it asks, what it says follows the transfers (they may all end meanwhile).
let quitAsking = false;
function quitAsked() {
  const n = moving.list().now.length;
  if (!n) { app.isQuitting = true; app.quit(); return; }
  quitAsking = true;
  showPanel();
  panelSend('panel:quit-ask', { n });
}
function quitNotAsked() { quitAsking = false; }       // (Cancel, or Escape)

// Files coming in from a phone or another device: listed once they're on their way here (thrown or sent, and their
// bytes coming), not while a phone still holds them (they can go back). Quick Share and browsers list their own (t.mk).
function movingIn(t) {
  if (!t || t.done || t.qs || t.web || t.already || t.state !== 'dropped' || (t.upload !== 'uploading' && t.upload !== 'done') || !server) return;
  const name = t.name === 'bundle' || t.name === 'file' ? (t.info && t.info.name) || 'Files' : t.name;
  if (t.mk) { if (t.mkName !== name) { t.mkName = name; moving.start(t.mk, { name }); } return; }   // (its name came later)
  const dev = server.ownerOf(t.tid);
  const d = dev && Object.prototype.hasOwnProperty.call(server.devices, dev) ? server.devices[dev] : null;
  const peer = !!(t.peer || (d && d.peer));
  const info = t.info || {};
  const size = t.upload === 'done' && t.size ? t.size : +info.size > 0 ? +info.size : -1;
  t.mk = (peer ? 'peer-in:' : 'phone-in:') + t.tid;
  t.mkName = name;
  moving.start(t.mk, {
    dir: 'in', device: dev || '', deviceName: dev ? server.api.nameOf(dev) : '', kind: peer && !(d && d.kind === 'phone') ? 'pc' : 'phone',
    name, files: Math.max(1, +info.count || 1), total: size, cancel: () => cancelIn(t),
  });
  if (t.upload === 'done' && t.size) moving.update(t.mk, t.size, t.size);
  movingSync(t);
}
// waiting for this PC's user to accept it ("Ask each time"), paused (its phone went), or coming
function movingSync(t) { if (t && t.mk) moving.state(t.mk, t.ask === 'wait' ? 'waiting' : t.paused ? 'paused' : 'running'); }
function movingEnd(t, ok, why) { if (t && t.mk) moving.end(t.mk, ok, why); }
// saved, under the name it has here ("IMG (2).jpg", "3 items")
function movingSaved(t, name) { if (t && t.mk) { if (name) moving.start(t.mk, { name }); moving.end(t.mk, true); } }
// Cancel on files coming in: turned down the way "Ask each time" turns them down (their sender is told, and doesn't send
// them again; what arrived goes). Not once all of it is here and being saved. canceled: the sender says Canceled on
// this PC, not that they weren't accepted (one from before that takes it as declined, as it always did).
function cancelIn(t) {
  if (transfers.get(t.tid) !== t || t.done || !server) return false;
  const device = server.ownerOf(t.tid);
  log('transfer', t.tid, 'canceled in the window');
  if (device) server.pushToPhone({ t: 'failed', tid: t.tid, why: 'declined', canceled: true }, device);   // (before the upload is cut: it isn't sent again)
  markGone(t.tid);
  fx('cancel', { tid: t.tid });
  clearTimeout(t.failT); clearTimeout(t.timer);
  server.abortUpload(t.tid, 'declined', true);
  movingEnd(t, false, 'canceled');
  discard(t);
  return true;
}

// Files offered to a phone: one row for the ones sent together, filled in as the phone fetches them. A phone that stops
// fetching (it went away, its Wi-Fi dropped) can't say so: a batch with nothing fetched for a while ends as not sent.
// (There's no stopping a phone's download from here: no Cancel.)
const outBatches = new Map();          // offer id -> its batch
const OUT_QUIET_MS = (TEST_MODE && +process.env.FLICK_TEST_OUT_QUIET_MS) || 90000;     // (tests can shorten it)
function movingToPhone(files, device) {
  if (!server || !files.length) return;
  const dev = device || (server.session && server.session.device) || '';
  const b = { key: 'phone-out:' + files[0].offer.fid, device: dev, left: new Set(), got: new Map(), size: new Map(), names: new Map(), total: 0, seen: mono(), stopped: false };
  for (const f of files) {
    b.left.add(f.offer.fid); b.size.set(f.offer.fid, f.offer.size); b.names.set(f.offer.fid, f.name); b.total += f.offer.size;
    outBatches.set(f.offer.fid, b);
  }
  moving.start(b.key, { dir: 'out', device: dev, deviceName: dev ? server.api.nameOf(dev) : '', kind: 'phone',
    name: files.length === 1 ? files[0].name : files.length + ' files', files: files.length, total: b.total });
}
function movingFetched(fid, sent, done) {
  const b = outBatches.get(fid);
  if (!b) return;
  b.seen = mono();
  const size = b.size.get(fid);
  b.got.set(fid, done ? size : Math.min(+sent || 0, size));
  let n = 0;
  for (const v of b.got.values()) n += v;
  moving.update(b.key, n, b.total);
  if (b.size.size > 1 && !done) moving.current(b.key, b.names.get(fid));
  if (!done) return;
  outBatches.delete(fid);
  b.left.delete(fid);
  if (!b.left.size) moving.end(b.key, !b.stopped && !b.changed, b.changed ? 'changed' : b.stopped ? 'canceled' : null);
}
// Copies from a phone's files (Browse phone): listed as coming in, with Cancel (what arrived stays)
const browseRows = new Set();
function movingBrowse(st) {
  if (!st || !st.id) return;
  const key = 'browse-in:' + st.id;
  if (st.state === 'running') {
    if (!browseRows.has(key)) {
      browseRows.add(key);
      moving.start(key, { dir: 'in', device: st.device || '', deviceName: st.deviceName || '', kind: 'phone', name: st.n === 1 ? st.first : st.n + ' files',
        files: st.n, total: st.bytes > 0 ? st.bytes : -1, cancel: () => { if (feats && feats.browse) feats.browse.stop(); } });
    }
    moving.update(key, st.doneBytes || 0, st.bytes > 0 ? st.bytes : -1);
    if (st.current && st.n > 1) moving.current(key, st.current);
  } else if (browseRows.has(key)) {
    browseRows.delete(key);
    moving.end(key, st.state === 'done', st.state === 'done' ? null : st.state === 'stopped' ? 'canceled' : st.state === 'stalled' ? 'stalled' : 'failed');
  }
}
// the phone stopped fetching one of them (its user's Cancel there): Canceled here too, once nothing else of it is left.
// why 'changed': it gave up because the file changed on this PC while it came (server.js answers the rest 409): the row
// says that file changed here and to send it again (several that changed: "N files", them)
function movingStopped(fid, device, why) {
  const b = outBatches.get(fid);
  if (!b || (b.device && device !== b.device)) return;
  outBatches.delete(fid);
  b.left.delete(fid);
  b.seen = mono();
  // (the row of several files is then named after the ones that changed: they're the ones to send again)
  if (why === 'changed') {
    (b.changed = b.changed || []).push(b.names.get(fid));
    if (b.size.size > 1) moving.start(b.key, { name: b.changed.length === 1 ? b.changed[0] : b.changed.length + ' files', files: b.changed.length });
  } else b.stopped = true;
  if (!b.left.size) moving.end(b.key, false, b.changed ? 'changed' : 'canceled');
}

// Sends to other devices (peerlink.js): listed once what goes is known (a big folder is looked through first), with the
// other device's user being asked about them, and Cancel
const peerRows = new Map();            // row key -> the device they go to
const PEER_WHY = { EDECLINED: 'declined', ECANCELEDTHERE: 'canceled', ENOSPACE: 'space', EAUTH: 'unpaired', EUNCONFIRMED: 'unconfirmed', EOLD: 'old', EQUITTHERE: 'quit' };
const peerWhy = (code) => PEER_WHY[code] || (/^E(UNREACH|TIMEDOUT|CONNREFUSED|HOSTUNREACH|NETUNREACH|CONNRESET|OTHER|PIPE)$/.test(code || '') ? 'unreachable' : 'failed');
function movingPeers() {
  if (!peers) return;
  const seen = new Set();
  for (const [id, b] of peers.busy) {
    if (!b || b.what !== 'sending' || !b.tid || !b.name) continue;
    const key = 'peer-out:' + id + ':' + b.tid;
    seen.add(key);
    if (!peerRows.has(key)) {
      const l = store.peerLinks && store.peerLinks[id];
      peerRows.set(key, id);
      moving.start(key, { dir: 'out', device: id, deviceName: l && l.name, kind: l && l.kind === 'phone' ? 'phone' : 'pc', name: b.name, files: b.files || 1,
        total: b.total, cancel: () => { if (peers) peers.cancel(id); } });
    }
    moving.update(key, b.sent || 0, b.total);
    moving.state(key, b.asking ? 'waiting' : 'running');
    if (b.now) moving.current(key, String(b.now).split('/').pop());
  }
  // gone without a word (canceled: 'sent' and 'failed' say the rest)
  for (const [key, id] of peerRows) {
    if (seen.has(key)) continue;
    peerRows.delete(key);
    moving.end(key, false, store.peerLinks && store.peerLinks[id] ? 'canceled' : 'unpaired');
  }
}
// A send that ended: its row says how. One that was over before its row was made (a small file goes in a moment, and the
// list above is made from what peerlink.js says a few times a second) gets one now, ended at once: it's listed too.
function movingPeerEnd(m, ok, why) {
  const key = 'peer-out:' + m.id + ':' + m.tid;
  if (m.tid && !peerRows.has(key) && !moving.has(key)) {
    const l = store.peerLinks && store.peerLinks[m.id];
    peerRows.set(key, m.id);
    moving.start(key, { dir: 'out', device: m.id, deviceName: m.to || (l && l.name), kind: l && l.kind === 'phone' ? 'phone' : 'pc', name: m.name, files: m.files || 1, total: m.size });
  }
  for (const [k, d] of peerRows) if (d === m.id) { peerRows.delete(k); moving.end(k, ok, why); }
}

// a row nothing will end any more (its transfer went some way not seen here) ends; a batch the phone stopped fetching too
function movingCheck() {
  const live = new Set();
  for (const t of transfers.values()) if (t.mk) live.add(t.mk);
  for (const x of moving.list().now) {
    if (/^(phone|peer|qs|web)-in:/.test(x.key) && !live.has(x.key)) moving.end(x.key, false, 'failed');
    else if (x.key.startsWith('peer-out:') && !peerRows.has(x.key)) moving.end(x.key, false, 'failed');
  }
  const now = mono();
  for (const b of new Set(outBatches.values())) {
    if (now - b.seen < OUT_QUIET_MS) continue;
    for (const fid of b.left) outBatches.delete(fid);
    log('files offered to the phone: nothing fetched for', Math.round((now - b.seen) / 1000) + 's');
    moving.end(b.key, false, 'stalled');
  }
}

// ---- the window: Transfers (panel/transfers.js), with what moved in the last minute
// (the window's page has a clock of its own: it's told how long ago each ended (ago), never this process's times)
function movingView(l) {
  return { now: l.now, recent: l.recent.filter((x) => x.ago < 65000), speed: !!store.showSpeed, card: store.xferCard !== false };
}
function pushMoving(l) { if (panel && !panel.isDestroyed()) panelSend('panel:moving', movingView(l || moving.list())); }
ipcMain.on('panel:moving', (e, m) => {
  if (!fromPanel(e) || !m || typeof m !== 'object') return;
  if (m.what === 'cancel' && typeof m.key === 'string') moving.cancel(m.key.slice(0, 300));
  else if (m.what === 'card' && typeof m.on === 'boolean') { store.xferCard = m.on; saveStore(); }
  pushMoving();                                  // ('hello': the window (re)loaded and needs the list)
  cardTick();
});

// ---- the taskbar (the Dock): how far everything moving has got, all together (indeterminate while a size isn't
// known, paused when all of it is). Windows shows it on the window's button, so only while the window is there. One
// that ends while others still move stays in it, as all done (nothing of it is left to go), until nothing moves: the
// bar doesn't go back as one ends.
let barSig = '', barFrom = 0;
function movingBar(l) {
  if (!panel || panel.isDestroyed()) return;
  const now = l.now;
  const at = mono();
  if (!now.length) barFrom = 0; else if (!barFrom) barFrom = at;
  let v = -1, mode = 'none';
  if (now.some((x) => x.total < 0)) { v = 2; mode = 'indeterminate'; }
  else if (now.length) {
    let total = now.reduce((s, x) => s + x.total, 0), done = now.reduce((s, x) => s + Math.min(x.done, x.total), 0);
    for (const x of l.recent) if (at - x.ago >= barFrom && x.total > 0) { total += x.total; done += x.total; }
    v = total > 0 ? done / total : 0;
    mode = now.every((x) => x.state === 'paused') ? 'paused' : 'normal';
  }
  const sig = mode + (mode === 'normal' || mode === 'paused' ? ':' + Math.round(v * 100) : '');
  if (sig === barSig) return;
  barSig = sig;
  try { panel.setProgressBar(v, { mode }); } catch (e) { /* (no taskbar to show it on) */ }
}
// the window was made, shown or hidden: its taskbar button gets the progress, and the card goes while it's open
function movingPanel() { barSig = ''; const l = moving.list(); movingBar(l); cardTick(l); }

// ---- the progress card: a small window in a corner of the screen the animations play on, like a phone's progress
// notification, while Flick's window isn't open (that one has Transfers, in the same corner). It never takes the focus
// and catches no click outside itself. It comes once a transfer has gone on for a moment (a small file doesn't flash it)
// and goes a few seconds after the last one ends, each with a check or what went wrong. A click on it opens the window.
const CARD = { w: 320, row: 50, pad: 6, more: 24, warm: 300, after: 700, linger: 4000, rows: 3, margin: 12 };
let card = null, cardLoaded = false, cardUp = false, cardSig = '', cardT = null, cardHideT = null, cardIdleT = null, cardAccent = null;
const panelUp = () => !!(panel && !panel.isDestroyed() && panel.isVisible() && !panel.isMinimized());
function cardBounds(h) {
  const wa = targetDisplay().workArea;
  // (a Mac's corner is up by the menu bar, under it; Windows' and Linux's down by the taskbar)
  const y = IS_MAC ? wa.y + CARD.margin : wa.y + wa.height - h - CARD.margin;
  return { x: Math.round(wa.x + wa.width - CARD.w - CARD.margin), y: Math.round(y), width: CARD.w, height: Math.round(h) };
}
function makeCard() {
  card = new BrowserWindow({
    width: CARD.w, height: 120, frame: false, transparent: !noComp, resizable: false, movable: false, minimizable: false, maximizable: false,
    fullscreenable: false, skipTaskbar: true, focusable: false, show: false, hasShadow: IS_MAC, alwaysOnTop: true, thickFrame: false,
    backgroundColor: noComp ? '#2b2b2b' : '#00000000', title: 'Flick transfers',      // (card.css's --card, where nothing can be see-through)
    ...(IS_MAC ? { type: 'panel' } : {}),        // (macOS: a panel never takes the focus)
    webPreferences: { preload: PRELOAD, backgroundThrottling: false, spellcheck: false },
  });
  card.setAlwaysOnTop(true, 'floating');
  if (!IS_WIN) card.setVisibleOnAllWorkspaces(true, { skipTransformProcessType: true });
  card.setMenu(null);
  cardLoaded = false; cardSig = '';
  const me = card;
  card.webContents.on('did-finish-load', () => { if (card !== me) return; cardLoaded = true; cardSig = ''; cardTick(); });
  card.webContents.on('render-process-gone', () => { if (card === me) dropCard(); });      // (made again when needed)
  card.on('closed', () => { if (card === me) { card = null; cardUp = false; cardLoaded = false; } });
  card.loadFile(path.join(__dirname, 'panel', 'card.html'));
}
// (let go of first: nothing may reach a window that's being destroyed)
function dropCard() {
  const c = card;
  card = null; cardUp = false; cardLoaded = false; cardSig = '';
  clearTimeout(cardHideT); cardHideT = null;
  clearTimeout(cardIdleT); cardIdleT = null;
  try { if (c && !c.isDestroyed()) c.destroy(); } catch (e) { /* gone */ }
}
// A transfer that paused (its phone went, to carry on when it's back: that can be hours away) doesn't keep the card on
// the screen: it says Paused for a moment, as one that ended says how it went, and the card goes once nothing else is
// moving (the window's Transfers and the taskbar still show it)
const cardPaused = new Map();          // key -> when the card saw it paused
function cardTick(l) {
  clearTimeout(cardT); cardT = null;
  l = l || moving.list();
  const now = mono();
  let next = Infinity, ripe = false, warm = false;
  for (const k of cardPaused.keys()) if (!l.now.some((x) => x.key === k && x.state === 'paused')) cardPaused.delete(k);
  const live = [], paused = [];
  for (const x of l.now) {
    if (x.state === 'paused') {
      if (!cardPaused.has(x.key)) cardPaused.set(x.key, now);
      const left = CARD.linger - (now - cardPaused.get(x.key));
      if (left > 0) { paused.push(x); next = Math.min(next, left); }
      continue;
    }
    live.push(x);
    const age = x.age;
    if (age >= CARD.after) ripe = true; else next = Math.min(next, CARD.after - age);
    if (age >= CARD.warm) warm = true; else next = Math.min(next, CARD.warm - age);
  }
  const ended = l.recent.filter((x) => x.ago < CARD.linger);
  for (const x of ended) next = Math.min(next, CARD.linger - x.ago);
  const can = store.xferCard !== false && !panelUp();
  // (with no effects to show it, one over in a moment is shown too, as it ends: what came in, or that it failed)
  const want = can && (ripe || ((cardUp || !fxOn()) && (live.length > 0 || paused.length > 0 || ended.length > 0)));
  // (its window is made a moment ahead, so it has its page by the time it shows; never for a file over in a moment)
  if (can && warm && !card) makeCard();
  if (next < Infinity) { cardT = setTimeout(() => cardTick(), next + 30); cardT.unref(); }
  if (!want) { cardHide(); return; }
  const items = l.now.filter((x) => x.state !== 'paused' || paused.includes(x)).concat(ended);
  cardShow(items.slice(0, CARD.rows), items.length - CARD.rows);
}
function cardShow(items, more) {
  if (!card) makeCard();
  if (!cardLoaded) return;                       // (its page loads first: then it's ticked again)
  clearTimeout(cardHideT); cardHideT = null;
  clearTimeout(cardIdleT); cardIdleT = null;
  if (!cardUp || !cardAccent) cardAccent = accentColors().accent;
  const rows = items.map((x) => ({ key: x.key, dir: x.dir, name: x.name, device: x.deviceName, state: x.state, why: x.why, canceling: x.canceling,
    pct: x.total > 0 ? Math.min(100, Math.floor((x.done / x.total) * 100)) : -1 }));
  const b = cardBounds(2 + CARD.pad * 2 + rows.length * CARD.row + (more > 0 ? CARD.more : 0));
  const sig = JSON.stringify([rows, more, cardAccent]);
  if (sig !== cardSig) { cardSig = sig; card.webContents.send('app:card', { what: 'show', rows, more: Math.max(0, more), accent: cardAccent, top: IS_MAC }); }
  const was = card.getBounds();
  if (was.x !== b.x || was.y !== b.y || was.width !== b.width || was.height !== b.height) card.setBounds(b);
  if (!cardUp || !card.isVisible()) {
    card.showInactive();
    card.setAlwaysOnTop(true, 'floating');
    cardUp = true;
  }
}
function cardHide() {
  if (cardUp) {
    cardUp = false; cardSig = '';
    if (card) {
      card.webContents.send('app:card', { what: 'hide' });
      clearTimeout(cardHideT);
      cardHideT = setTimeout(() => { cardHideT = null; if (card && !cardUp) card.hide(); }, 220);   // (after its short fade)
    }
  }
  // a card not needed for a few minutes is closed, and made again when it is (its page holds memory meanwhile)
  if (card && !cardIdleT) {
    cardIdleT = setTimeout(() => { cardIdleT = null; if (card && !cardUp) dropCard(); }, 3 * 60000);
    cardIdleT.unref();
  }
}
ipcMain.on('app:card', (e, m) => { if (fromWin(e, card) && m && m.what === 'open') showPanel(); });

function movingChanged() {
  const l = moving.list();
  if (quitAsking) panelSend('panel:quit-ask', { n: l.now.length, again: true });
  pushMoving(l);
  movingBar(l);
  cardTick(l);
}
function startMoving() {
  moving.on('change', movingChanged);
  if (server) {
    server.on('download-progress', (m) => movingFetched(m.fid, m.sent, false));
    server.on('download-done', (m) => movingFetched(m.fid, 0, true));
    server.on('incoming-stopped', (m) => movingStopped(m.fid, m.device));
    server.on('incoming-failed', (m) => movingStopped(m.fid, m.device, m.why));
    // files a phone sends without the fling (auto-send, its tile or widget, Share to Flick): listed too
    server.on('quiet-start', (m) => moving.start('quiet-in:' + m.tid, { dir: 'in', device: m.device, deviceName: m.device ? server.api.nameOf(m.device) : '', kind: 'phone', name: m.name, files: 1, total: m.total > 0 ? m.total : -1 }));
    server.on('quiet-progress', (m) => moving.update('quiet-in:' + m.tid, m.received, m.total > 0 ? m.total : -1));
    server.on('quiet-end', (m) => moving.end('quiet-in:' + m.tid, !!m.ok, m.ok ? null : m.why === 'declined' ? 'declined' : m.why === 'save' ? 'save' : 'failed'));
  }
  if (peers) {
    peers.on('state', movingPeers);
    peers.on('start', movingPeers);                // (listed as it goes, not only at the next look)
    peers.on('sent', (m) => movingPeerEnd(m, true));
    peers.on('failed', (m) => movingPeerEnd(m, false, peerWhy(m.code)));
  }
  // files a browser downloads from "Share with a browser" (webshare.js; no Cancel: a browser's download can't be stopped
  // cleanly from here)
  if (web) {
    web.on('download-start', (m) => moving.start('web-out:' + m.id, { dir: 'out', deviceName: m.device, kind: 'browser', name: m.name, total: m.total }));
    web.on('download-progress', (m) => moving.update('web-out:' + m.id, m.sent, m.total));
    web.on('download-end', (m) => moving.end('web-out:' + m.id, !!m.ok, 'failed'));
  }
  for (const ev of ['display-metrics-changed', 'display-added', 'display-removed']) screen.on(ev, () => cardTick());
  setInterval(movingCheck, 3000).unref();
}
// tests: the list, the card (its state, its page, a picture of it) and Cancel
async function movingTest(u, res) {
  const live = card && !card.isDestroyed() ? card : null;
  if (u.pathname === '/moving') {
    res.end(JSON.stringify(Object.assign(moving.list(), {
      card: { up: cardUp, visible: !!(live && live.isVisible()), bounds: live ? live.getBounds() : null, focusable: live ? live.isFocusable() : null,
        onTop: live ? live.isAlwaysOnTop() : null, workArea: targetDisplay().workArea },
      bar: barSig, batches: outBatches.size, peerRows: [...peerRows.keys()], setting: store.xferCard !== false,
    })));
    return true;
  }
  if (u.pathname === '/moving-card') {
    if (!live) { res.statusCode = 404; res.end('no card'); return true; }
    const out = u.searchParams.get('out');
    if (out) { fs.writeFileSync(out, (await live.webContents.capturePage()).toPNG()); res.end('ok'); return true; }
    res.end(JSON.stringify(await live.webContents.executeJavaScript(u.searchParams.get('js') || 'null')));
    return true;
  }
  if (u.pathname === '/moving-cancel') { res.end(JSON.stringify(moving.cancel(String(u.searchParams.get('key') || '')))); return true; }
  return false;
}

// ------------------------------------------------------------ send feedback (feedback.js)
let fb = null;
function startFeedback() {
  const { Feedback } = require('./feedback');
  fb = new Feedback({
    version: VERSION, userDir, log, fetch: (url, opts) => require('electron').net.fetch(url, opts),
    testUrl: (TEST_MODE && process.env.FLICK_TEST_FEEDBACK_URL) || null,     // a local stand-in for Google, in tests only
    onSent: () => {                                                           // a message that waited for a connection went
      panelSend('panel:feedback', Object.assign({ later: true }, fb.info()));
      if (feats) feats.toast({ title: 'Feedback sent', body: 'Thanks. Your message has been sent.', silent: true });
    },
    onRefused: () => {                                                        // ... and the form didn't take it
      panelSend('panel:feedback', fb.info());
      if (feats) feats.toast({ title: 'Feedback not sent', body: 'The feedback form didn’t take the message Flick kept for later. It’s back in Send feedback.', click: () => showPanel() });
    },
  });
}
ipcMain.on('panel:feedback', async (e, m) => {
  if (!fb || !fromPanel(e) || !m || typeof m !== 'object') return;
  if (m.what === 'send') {
    const r = await fb.send({ type: m.type === 'idea' ? 'idea' : 'bug', message: String(m.message || ''), email: String(m.email || ''), device: m.device === true });
    panelSend('panel:feedback', Object.assign({ result: r }, fb.info()));
    return;
  }
  if (m.what === 'refused-seen') { fb.refused = null; return; }     // (the window has put it back in the form)
  panelSend('panel:feedback', fb.info());        // 'hello': the form was opened
  fb.flush();
});

// ------------------------------------------------------------ app
app.on('second-instance', (_e, argv) => {
  // a second start counted against this version's start attempts; it's clearly running, so clear them again
  if (healthy && updater) updater.markHealthy(BOOT);
  if ((argv || []).includes(SEND_SWITCH)) { onHotkey(); return; }
  const files = sendArgs(argv || []);
  if (files.length) queueForPhone(files);
  else showPanel();
});
app.on('window-all-closed', (e) => { /* keep running in tray */ });
app.on('will-quit', () => {
  try { globalShortcut.unregisterAll(); } catch (e) { /* ignore */ }
  try { if (selNow) selNow.stop(); } catch (e) { /* ignore */ }
  // (what ended while Flick was closing, after History was written out in before-quit: a file that finished being saved)
  try { if (feats) feats.history.flush(); } catch (e) { /* ignore */ }
  try { received.flush(); } catch (e) { /* ignore */ }     // (files saved in the last moments: "Skip files already on the PC")
  try { logFlush(); } catch (e) { /* ignore */ }       // (how many lines of a kind there were that weren't written)
});
// The PC's own Wi-Fi network, if Flick started it, is taken down before Flick goes: that takes a moment (nmcli, PowerShell),
// and a step left for after Flick has gone never runs (on Linux a "Flick" connection would be left behind). At most 5 s.
let hotQuit = false, saveWaited = false;
app.on('before-quit', (e) => {
  app.isQuitting = true;
  if (!hotQuit && hotspot.state !== 'off') {
    hotQuit = true;
    e.preventDefault();
    let t = null;
    // (one still starting is undone once it's up: that's waited for too)
    const down = Promise.resolve().then(() => hotspot.stop()).then(() => hotspot.pending).catch(() => {});
    Promise.race([down, new Promise((r) => { t = setTimeout(r, 5000); })]).then(() => { clearTimeout(t); app.quit(); });
    return;
  }
  // Settings being written in the background right now: that write is let end first (a moment; it stops at its next step
  // now that Flick is quitting). One whose last step was already on its way could land after the copy written below,
  // and put the settings of a moment before back over it. At most 2 s (a disk that hangs): then as before.
  if (!saveWaited && saving) {
    saveWaited = true;
    e.preventDefault();
    let t = null;
    Promise.race([saving, new Promise((r) => { t = setTimeout(r, 2000); })]).then(() => { clearTimeout(t); app.quit(); });
    return;
  }
  try { if (bt) bt.stop(); } catch (e) { /* ignore */ }
  try { if (qs) qs.stop(); } catch (e) { /* ignore */ }
  // sends to other computers end now, each said as cut short by the quit: in History before it's written out (below)
  try { if (peers && typeof peers.quit === 'function') peers.quit(); } catch (e) { /* ignore */ }
  // and so do sends from them that weren't all here yet (their senders hear so: server.stop, below), once each (its
  // upload cut off a moment later says nothing more). A phone's starts over by itself when Flick is back (its History
  // entry comes then), so only other computers' are said here.
  try {
    for (const t of [...transfers.values()]) {
      if (!t.peer || t.done || t.state === 'canceled') continue;
      hist({ dir: 'in', tid: t.tid, name: t.name, size: 0, ok: false, how: 'fling', why: 'quit' });
      discard(t);
    }
  } catch (e) { /* ignore */ }
  try { if (feats) feats.stop(); } catch (e) { /* ignore */ }      // (folder sync's latest activity goes into the store)
  if (saveTimer || saving || saveWaited) writeStoreNow();           // don't lose a setting changed just before quitting
  try { if (air) air.stop(); } catch (e) { /* ignore */ }
  try { hotspot.stop(); } catch (e) { /* ignore */ }                // the PC's own Wi-Fi network, if Flick started it
  try { if (fb) fb.stop(); } catch (e) { /* ignore */ }
  try { server && server.stop(); } catch (e) { /* ignore */ }
  try { if (stage.dir !== TEMP_STAGE) fs.rmdirSync(stage.dir); } catch (e) { /* not empty: kept for next time */ }
});

// Leftovers from a crash or power cut (half-received files, staging folders) in Flick's own temp folders, and of
// transfers that never finished: at start, anything older than 10 minutes; while Flick runs (every 30
// minutes), files untouched for six hours (a file still arriving is written to all the time; folders are left to the
// transfers that own them)
// (the files kept because they couldn't be saved, in "Not saved", stay: see keepUnsaved)
// before: only what was last written before then (what a crash left just before this start, once 10 minutes old)
function sweepDir(dir, running, before) {
  const now = Date.now(), age = running ? 6 * 3600000 : 10 * 60000;
  fs.readdir(dir, (e, names) => {
    if (e) return;
    for (const n of names) {
      if (n === KEPT_DIR) continue;
      const full = path.join(dir, n);
      fs.stat(full, (er, st) => {
        const old = !er && now - st.mtimeMs > age && (!running || st.isFile()) && !(before && st.mtimeMs >= before);
        if (old) fs.rm(full, { recursive: true, force: true }, () => {});
      });
    }
  });
}
function sweepTemp(running, before) {
  for (const dir of new Set([TEMP_STAGE, QS_STAGE, stage.dir])) sweepDir(dir, running, before);
  if (running || before) return;
  fs.readdir(app.getPath('userData'), (e, names) => {
    if (!e) for (const n of names) if (/^flick-fw-.*\.cmd$/.test(n)) fs.unlink(path.join(app.getPath('userData'), n), () => {});
  });
}

app.whenReady().then(async () => {
  sweepTemp();
  moveOldKept().catch((e) => log('kept files:', e.message));
  // what a crash or power cut left minutes before this start goes too, once it's 10 minutes old (nothing of this run is)
  const boot = Date.now();
  setTimeout(() => sweepTemp(false, boot), 11 * 60000).unref();
  setInterval(() => sweepTemp(true), 30 * 60000).unref();
  // a Windows account without a full name could leave the PC named "Comment's PC": fix it automatically
  if (!store.name || store.name === "Comment's PC") { store.name = await defaultName(); saveStore(); }
  // this PC's certificate (made the first time): phones talk to it only over links encrypted with it
  const tlsId = tlscert.ensure(app.getPath('userData'), 'Flick ' + store.id, { log });
  if (!tlsId) log('no certificate: encrypted links are off');
  // a phone this PC asked (Connect) that never signed in with the pairing it was given before Flick quit: it never got
  // it, or went away (see grantHome)
  for (const [id, d] of Object.entries(store.devices || {})) if (d && d.homeProv) delete store.devices[id];
  // and a computer allowed here that hadn't said Same code yet when Flick quit or stopped: that can only be confirmed on
  // the link it was allowed on, gone now, so it would show as waiting for ever (the other computer kept nothing)
  let unconfirmed = 0;
  for (const [id, d] of Object.entries(store.devices || {})) if (d && d.peer && d.prov) { delete store.devices[id]; unconfirmed++; }
  if (unconfirmed) { log('pairing not confirmed before Flick last closed, dropped:', unconfirmed); saveStore(); }
  server = new FlickServer({
    // test runs can move the ports (several copies under test on one machine); real installs always use the defaults
    id: store.id, name: store.name, port: (TEST_MODE && +process.env.FLICK_PORT) || 47860,
    discoveryPort: (TEST_MODE && +process.env.FLICK_DISCOVERY_PORT) || 47870, version: VERSION,
    tmpDir: TEMP_STAGE, devices: store.devices,
    settings: { side: store.side, anchor: store.anchor, theme: themeName() },
    allowOrigin: TEST_MODE ? /^http:\/\/127\.0\.0\.1:\d+$/ : null,   // test harnesses serve the phone page over http
    tls: tlsId,
    haveFiles: (items, device) => received.lookup(items, device),
  });
  // the certificate couldn't be read (held a moment by another program; see tlscert.js): read again in the background,
  // and encrypted links start as soon as it can be (paired devices keep their pinned key: nothing new is made over it)
  if (!tlsId) {
    let tries = 0;
    const again = () => setTimeout(() => {
      const t = tlscert.ensure(app.getPath('userData'), 'Flick ' + store.id, { log, wait: false });
      if (t && server && server.setTls(t)) { log('certificate read: encrypted links are on'); return; }
      if (++tries < 20) again(); else log('certificate still not readable: encrypted links stay off until Flick starts again');
    }, (TEST_MODE && +process.env.FLICK_TEST_TLS_RETRY_MS) || 30000).unref();
    again();
  }
  updateReady();
  wireServer();
  updateStage();                                // staged on the save folder's drive when it's another one
  try { const port = await server.start(); log('listening', port, lanAddresses().map((a) => a.address).join(',')); }
  catch (e) { log('server failed', e.message); dialog.showErrorBox('Flick', 'Flick could not start its connection service.\n\n' + e.message); }
  startWeb();
  startPeers();
  startMoving();
  feats = require('./features').attach({
    electron: require('electron'), server, store, saveStore, log, userDir, appDir: __dirname,
    saveReceived: webSave, saveDirNow, markOfWeb, openAfterArrival, panelSend, getPanel: () => panel,
    sendFiles: (paths) => queueForPhone(paths), updateTray, pushState: pushPanelState, front: askFront,
    // History's Send again for files that went to another computer: to that computer
    sendTo: (id, paths) => {
      const l = store.peerLinks && store.peerLinks[id];
      if (!peers || !l) { panelSend('panel:note', { text: 'That computer isn’t paired with this one any more.' }); return; }
      if (peers.busy.has(id)) { panelSend('panel:note', { text: 'Wait until what’s going to ' + l.name + ' is sent.' }); return; }
      panelSend('panel:note', { text: 'Sending to ' + l.name + '…' });
      peers.send(id, paths, { look: sendLook() });
    },
    askMs: (TEST_MODE && +process.env.FLICK_TEST_ASK_MS) || undefined,   // tests can shorten the 60 s
    // the clipboard and links to another computer: over its link (peerlink.js), to the one picked in Send to
    peers: () => peers, targetPc, peerName: (id) => (store.peerLinks && store.peerLinks[id] && store.peerLinks[id].name) || '',
    onBrowseJob: (st) => movingBrowse(st),
  });
  feats.watchWeb(web);                          // files from browsers go into the history too
  startFeedback();
  refreshPhoneApp();
  startUpdater();

  createOverlay();
  air = require('./air').attach({
    electron: require('electron'), store, log, fx, server, preload: PRELOAD, appDir: __dirname, isMac: IS_MAC,
    tmpDir: app.getPath('temp'), side: () => store.side, phoneScreen,
    overlaySize: () => { const b = overlayBounds(); return { width: b.width, height: b.height }; },
    land: (t, msg) => airLand(t, msg), changed: () => pushPanelState(), thumbFor, kindOf,
    // files a fist picked up here, caught by the phone: their card already flies (opts.fx false), from its height
    sendPaths: (paths, opts) => sendPathsToPhone(paths, opts && typeof opts.y === 'number' ? overlayBounds().y + opts.y : undefined, opts),
    // held without being let go of for very long: put back, and the phone is told (it shows the file wasn't sent)
    expire: (t) => {
      if (transfers.get(t.tid) !== t || t.state !== 'lifted') return;     // (a newer transfer may have its id now)
      log('transfer', t.tid, 'held by a hand too long: put back');
      fx('cancel', { tid: t.tid });
      if (server) { server.pushToPhone({ t: 'failed', tid: t.tid, why: 'held' }); server.abortUpload(t.tid); }
      clearTimeout(t.failT);
      markGone(t.tid);
      discard(t);
    },
    liftMaxMs: (TEST_MODE && +process.env.FLICK_TEST_AIR_HOLD_MS) || undefined,      // tests can shorten the 90 s
    camMaxMs: (TEST_MODE && +process.env.FLICK_TEST_AIR_CAM_MS) || undefined,        // and the camera's half minute
    debug: TEST_MODE,                                                                  // tests: hand events in the log
  });
  createTray();
  applyStartup();
  applyHotkey();
  // Windows: someone who uses the send shortcut gets its helper started ahead (it takes a second or two)
  if (IS_WIN && store.hotkeyUsed && store.hotkey !== false) setTimeout(() => {
    if (!hotkeyOk) return;
    if (!selNow) { const { SelNow } = require('./selnow'); selNow = new SelNow({ log }); }
    selNow.warm();
  }, 20000).unref();
  screen.on('display-metrics-changed', () => { placeOverlay(); ensureCatcher(); });
  screen.on('display-added', () => { placeOverlay(); ensureCatcher(); });
  screen.on('display-removed', () => { placeOverlay(); ensureCatcher(); });

  applySendTo();
  registerAppId();
  applyBluetooth();
  applyQuickShare();
  // macOS: the menu bar's Edit menu is what makes copy and paste work in the panel's fields (Electron's default menu
  // would also offer reloading the windows and their developer tools)
  if (IS_MAC) Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]));
  startedAt = Date.now();
  const startFiles = sendArgs(process.argv);
  if (process.argv.includes(SEND_SWITCH)) setTimeout(onHotkey, 1500);
  else if (startFiles.length) setTimeout(() => queueForPhone(startFiles), 1500);
  else if (openFiles.length) setTimeout(sendOpenFiles, 1500);
  else if (!(HIDDEN_START || openedAtLogin()) || store.firstRun) showPanel();
  if (!panel) panelSoon();
  if (newsPending() && store.newsToast !== NEWS) setTimeout(newsToast, TEST_MODE ? 1500 : 10000);
  if (TEST_MODE) startTestControl();
});

// ------------------------------------------------------------ test-only control port (never enabled in normal use)
function startTestControl() {
  require('http').createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    try {
      if (u.pathname.startsWith('/f/') && feats) return feats.test(u, res);    // the phone features (features.js)
      if (u.pathname.startsWith('/moving') && await movingTest(u, res)) return;   // what's moving (moving.js)
      if (u.pathname === '/fb/state' && fb) return res.end(JSON.stringify(Object.assign({ outbox: fb.outbox, url: fb._url() }, fb.info())));
      if (u.pathname === '/air' && air) { air.testHand(JSON.parse(u.searchParams.get('ev') || '{}')); return res.end('ok'); }   // a hand the camera "sees"
      if (u.pathname === '/air-select' && air) { air.testSelect(JSON.parse(u.searchParams.get('paths') || '[]'), u.searchParams.get('first') === '1'); return res.end('ok'); }   // files "selected"
      if (u.pathname === '/air-state' && air) return res.end(JSON.stringify(air.state));
      if (u.pathname === '/hotkey') { await onHotkey(); return res.end(JSON.stringify({ ok: hotkeyOk })); }   // the send shortcut, pressed
      if (u.pathname === '/fb/flush' && fb) { await fb.flush(); return res.end(JSON.stringify(fb.info())); }
      if (u.pathname === '/capture') {
        const w = u.searchParams.get('w') === 'panel' ? panel : u.searchParams.get('w') === 'air' && air ? air.window : overlay;
        const img = await w.webContents.capturePage();
        fs.writeFileSync(u.searchParams.get('out'), img.toPNG());
        return res.end('ok');
      }
      if (u.pathname === '/state') {
        return res.end(JSON.stringify({
          overlayShown, overlayReady, composited: !noComp, connected: !!(server && server.connected),
          transfers: [...transfers.values()].map((t) => ({ tid: t.tid, state: t.state, upload: t.upload, done: !!t.done, paused: !!t.paused })),
          panel: !!(panel && panel.isVisible()), catcher: !!catcher, catcherBounds: catcher && catcher.getBounds(),
          overlayBounds: overlay && overlay.getBounds(), saveDir: saveDirPath(), name: server && server.name,
          version: VERSION, boot: BOOT, update: updateInfo, qsPort: qs && qs.port, qsState, btState,
        }));
      }
      if (u.pathname === '/eval') {
        const w = u.searchParams.get('w') === 'panel' ? panel : u.searchParams.get('w') === 'air' && air ? air.window : overlay;
        const r = await w.webContents.executeJavaScript(u.searchParams.get('js'));
        return res.end(JSON.stringify(r));
      }
      if (u.pathname === '/set') {
        ipcMain.emit('panel:set', TEST_EV, { key: u.searchParams.get('key'), value: u.searchParams.get('value') });
        return res.end('ok');
      }
      if (u.pathname === '/action') {
        const arg = u.searchParams.get('arg');
        ipcMain.emit('panel:action', TEST_EV, { what: u.searchParams.get('what'), arg: arg ? JSON.parse(arg) : undefined });
        return res.end('ok');
      }
      if (u.pathname === '/catcher-drop') {
        ipcMain.emit('catcher:drop', TEST_EV, { paths: [u.searchParams.get('path')], y: +(u.searchParams.get('y') || 300) });
        return res.end('ok');
      }
      if (u.pathname === '/pair') {
        const dev = u.searchParams.get('device');
        if (u.searchParams.get('allow') === '1') server.approve(dev); else server.deny(dev);
        return res.end('ok');
      }
      // your other devices (peerlink.js): their list as the panel gets it, and sending paths (a file dialog can't be
      // driven from a test)
      if (u.pathname === '/peers' && peers) {
        return res.end(JSON.stringify(Object.assign(peersState(), { links: store.peerLinks, devices2: Object.keys(server.devices).filter((k) => server.devices[k].peer), sessions: server.peerSessions() })));
      }
      if (u.pathname === '/peers-send' && peers) {
        const r = await peers.send(u.searchParams.get('id'), JSON.parse(u.searchParams.get('paths') || '[]'), { look: u.searchParams.get('look') || sendLook() });
        return res.end(JSON.stringify(r));
      }
      if (u.pathname === '/peers-action') {
        ipcMain.emit('panel:peers', TEST_EV, JSON.parse(u.searchParams.get('m') || '{}'));
        return res.end('ok');
      }
      // Connect (hold it here): what it shows, what it could reach, and the panel's messages to it
      if (u.pathname === '/connect') {
        return res.end(JSON.stringify(Object.assign(connectState(), { hotspot: hotspot.view(), hotUse: [...hotUse], cands: connectCands(), ready: !!(server && server.ready), devices: Object.keys(server.devices).map((k) => Object.assign({ id: k }, server.devices[k], { token: undefined })) })));
      }
      if (u.pathname === '/connect-action') {
        ipcMain.emit('panel:connect', TEST_EV, JSON.parse(u.searchParams.get('m') || '{}'));
        return res.end('ok');
      }
      res.statusCode = 404; res.end();
    } catch (e) { res.statusCode = 500; res.end(String(e && e.stack)); }
  }).listen((TEST_MODE && +process.env.FLICK_TEST_PORT) || 47999, '127.0.0.1');
}
