'use strict';
const { app, BrowserWindow, Tray, Menu, nativeImage, screen, ipcMain, desktopCapturer, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile, spawn } = require('child_process');
const { FlickServer, lanAddresses, rid } = require('./server');
const { apkInfoAsync } = require('./apkinfo');
const tlscert = require('./tlscert');
const { ReceivedIndex } = require('./have');
const { Updater } = require('./updater');
const { readProof, writeProof } = require('./updatecore');

const VERSION = require('./package.json').version;
const IS_WIN = process.platform === 'win32';
const plat = require('./platform');          // what macOS and Linux do differently (Windows' own code stays here)
const { IS_MAC, IS_LINUX } = plat;
const HIDDEN_START = process.argv.includes('--hidden');
// The test control server runs arbitrary JS in a window, so it must never be reachable in a shipped build, even if
// someone sets the env var: a packaged app refuses it outright.
const TEST_MODE = process.env.FLICK_TEST === '1' && !app.isPackaged;
// Releases must be signed with Flick's release key (updatecore.js); only a test run may trust its own throwaway key.
const TEST_RELEASE_KEYS = TEST_MODE && process.env.FLICK_TEST_RELEASE_KEYS ? process.env.FLICK_TEST_RELEASE_KEYS.split(',') : undefined;

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
  queueForPhone(openFiles.splice(0).slice(0, MAX_SEND));
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
function log(...a) {
  const line = new Date().toISOString() + ' ' + a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') + '\n';
  try {
    if (fs.existsSync(LOG) && fs.statSync(LOG).size > 512 * 1024) fs.renameSync(LOG, LOG + '.1');
    fs.appendFileSync(LOG, line);
  } catch (e) { /* ignore */ }
  if (TEST_MODE) process.stdout.write(line);
}

// An unexpected error must never put an error box on the user's screen: note it in the log and carry on.
let inFault = false;
function fault(kind, e) {
  if (inFault || (e && e.code === 'EPIPE')) return;   // never loop on a broken log pipe
  inFault = true;
  try { log(kind, (e && e.stack) || String(e)); } catch (x) { /* ignore */ }
  inFault = false;
}
process.on('uncaughtException', (e) => fault('uncaught', e));
process.on('unhandledRejection', (e) => fault('unhandled', e));
if (process.stdout && process.stdout.on) process.stdout.on('error', () => {});

const DEFAULTS = {
  // received files land on the desktop, except on Linux, where desktops often show no files at all
  id: null, name: null, side: 'right', anchor: 0.5, size: 1, saveDir: IS_LINUX ? 'downloads' : 'desktop', sound: true,
  startup: true, edgeSend: true, devices: {}, firstRun: true, displayId: null, theme: 'roadster',
  openAfter: false, showSpeed: true, sendTo: true, autoUpdate: true, bluetooth: false, quickShare: false,
  airCam: true,                // Air grab: this PC's camera sees where the hand opens, and a fist picking files up (air.js)
};
const readJson = (f) => { try { const o = JSON.parse(fs.readFileSync(f, 'utf8')); return o && typeof o === 'object' ? o : null; } catch (e) { return null; } };
// settings.json, or its last good copy if it was damaged (a crash or power cut mid-save must not lose the pairings)
let store = Object.assign({}, DEFAULTS, readJson(SETTINGS) || readJson(SETTINGS + '.bak') || {});
if (!store.id) store.id = rid(8);
let saveTimer = null;
function writeStoreNow() {
  saveTimer = null;
  try {
    fs.mkdirSync(userDir, { recursive: true });
    const tmp = SETTINGS + '.tmp';
    const fd = fs.openSync(tmp, 'w');
    try { fs.writeSync(fd, JSON.stringify(store, null, 2)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    if (readJson(SETTINGS)) { try { fs.copyFileSync(SETTINGS, SETTINGS + '.bak'); } catch (e) { /* ignore */ } }
    try { fs.renameSync(tmp, SETTINGS); }
    catch (e) { fs.copyFileSync(tmp, SETTINGS); fs.unlinkSync(tmp); }     // briefly locked (antivirus): copy instead
  } catch (e) { log('save failed', e.message); }
}
function saveStore() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(writeStoreNow, 150);
}

function defaultName() {
  return new Promise((resolve) => {
    let user = '';
    try { user = (os.userInfo().username || '').replace(/[^\p{L}\p{N} ._-]/gu, '').trim(); } catch (e) { /* ignore */ }
    const host = os.hostname() || '';
    const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
    const first = (s) => cap(String(s).trim().split(/[\s._-]+/)[0] || '');
    // A real-looking account name ("Mani Weinstein") beats a generated host name ("DESKTOP-4F2K9QX")
    const looksLikeName = /^\p{L}[\p{L} .'-]{1,40}$/u.test(user) && !/^(user|admin|administrator|owner|pc)$/i.test(user) && !/^(desktop|laptop|win)\b/i.test(user);
    const genericHost = !host || /^(DESKTOP|LAPTOP|WIN|PC)-[A-Z0-9]{5,}$/i.test(host) || /^localhost(\.|$)/i.test(host);
    const pc = IS_MAC ? "'s Mac" : "'s PC";
    const fallback = looksLikeName ? first(user) + pc : (!genericHost ? host : (user ? first(user) + pc : IS_MAC ? 'My Mac' : 'My PC'));
    // the name the user gave this Mac; on Linux the account's full name (Windows: net user's "Full Name", below)
    if (IS_MAC) return plat.macName().then((n) => resolve(n && n.length <= 40 ? n : fallback));
    if (IS_LINUX && user) return plat.fullName(os.userInfo().username).then((full) => resolve(full.length > 1 ? first(full) + pc : fallback));
    if (!IS_WIN || !user) return resolve(fallback);
    execFile('net', ['user', os.userInfo().username], { windowsHide: true, timeout: 4000 }, (err, out) => {
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
  fs.stat(d, (e, st) => { if (customDir.dir === d) { const ok = !e && st.isDirectory(); if (ok !== customDir.ok) { customDir.ok = ok; pushPanelState(); } } });
}
setInterval(checkCustomDir, 30000).unref();
function saveDirPath() {
  if (store.saveDir === 'desktop') return app.getPath('desktop');
  if (store.saveDir === 'downloads') return app.getPath('downloads');
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
const received = new ReceivedIndex(path.join(app.getPath('userData'), 'received.json'), { saveDir: () => saveDirPath() });
function saveDirLabel() {
  if (store.saveDir === 'desktop') return 'Desktop';
  if (store.saveDir === 'downloads') return 'Downloads';
  return path.basename(saveDirPath()) || 'folder';
}

// ------------------------------------------------------------ windows
const PRELOAD = path.join(__dirname, 'preload.js');
let overlay = null, overlayShown = false, overlayReady = false;
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

function overlayConfig() {
  const d = targetDisplay();
  const ob = overlayBounds();
  const taskbar = Math.max(0, (d.bounds.y + d.bounds.height) - (d.workArea.y + d.workArea.height));
  return { W: ob.width, H: ob.height, dispW: d.bounds.width, dispH: d.bounds.height, dpr: d.scaleFactor || 1,
    side: store.side, anchor: store.anchor, k: kFactor(), sound: !!store.sound, taskbar: taskbar || 0, saveLabel: saveDirLabel(), theme: themeName() };
}

function createOverlay() {
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
  overlay.loadFile(path.join(__dirname, 'overlay', 'overlay.html'));
  overlay.on('closed', () => { overlay = null; overlayShown = false; overlayReady = false; });
  // the overlay's renderer died (GPU process crash, out of memory): start a fresh one
  overlay.webContents.on('render-process-gone', (_e, d) => {
    log('overlay renderer gone:', d && d.reason);
    const o = overlay; overlay = null; overlayShown = false; overlayReady = false;
    try { o.destroy(); } catch (e) { /* ignore */ }
    setTimeout(() => { if (!overlay && !app.isQuitting) createOverlay(); }, 1000);
  });
}

// the GPU was reset: reload the overlay page so its effects work again
let lostAt = 0;
ipcMain.on('fx:lost', () => {
  if (!overlay || Date.now() - lostAt < 10000) return;      // at most once per 10 s, in case the GPU keeps failing
  lostAt = Date.now();
  log('overlay graphics reset: reloading it');
  overlayReady = false;
  if (overlayShown) { overlay.hide(); overlayShown = false; }
  setTimeout(() => { if (overlay) overlay.webContents.reload(); }, 500);
});

function placeOverlay() {
  if (!overlay) return;
  const ob = overlayBounds();
  overlay.setBounds(ob);
  overlay.webContents.send('fx:config', overlayConfig());
}

const THEMES = ['roadster', 'liquid', 'teleport', 'halo'];
function themeName() { return THEMES.includes(store.theme) ? store.theme : 'roadster'; }

// Moments that start from a quiet screen take a fresh photo of the desktop first (used for blur, refraction and
// night grading), while the overlay is still hidden so it can never photograph itself. Teleport uses no photo.
const SHOT_FIRST = { lift: true, hold: true, outgoing: true, demo: true, 'edge-hover': true, preview: true, connect: true };
const SHOT_MS = 600;            // a slower photo is given up on: the effects run without it rather than wait
// once the overlay hides, its desktop photo is out of date: drop it so no later effect paints an old screen
function dropShot() { lastShot = 0; if (overlay) overlay.webContents.send('fx:noshot'); }
// Effects that come while the photo is being taken wait for it here: the overlay's clock starts when it gets them,
// so sent at once they'd play (partly or wholly) while it's still hidden. They go the moment it shows.
let revealT = null, held = null;
function reveal() {
  clearTimeout(revealT); revealT = null;
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
  if (withShot && themeName() !== 'teleport' && shotAllowed() && Date.now() - lastShot > 1500) {
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
  if (!overlay) return;
  lastFx = Date.now();
  ensureShown(!!SHOT_FIRST[type]);
  if (held) held.push([type, data]);
  else overlay.webContents.send('fx:' + type, data);
}

// Nothing may stay on screen without a reason: a drag the phone never finished, a transfer that stopped sending, or
// an overlay that is up with nothing going on is cleared within a minute.
function watchdog() {
  const now = Date.now();
  for (const t of [...transfers.values()]) {
    if (t.done) continue;
    const quiet = now - (t.seen || t.t0);
    if (t.state === 'lifted' && quiet > 60000) {
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

ipcMain.on('fx:ready', () => { overlayReady = true; if (overlay) overlay.webContents.send('fx:config', overlayConfig()); });
ipcMain.on('fx:idle', () => {
  if (overlay && overlayShown) { overlay.hide(); overlayShown = false; dropShot(); }
});

// The photo of the desktop needs Screen Recording permission on macOS, which Flick doesn't ask for (the effects do
// without it unless the user gave it), and under Wayland every capture would ask through a dialog of its own.
function shotAllowed() {
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
let catcherYieldT = null;
ipcMain.on('catcher:yield', () => {
  // The user clicked the very edge pixel: get out of the way for a few seconds.
  if (!catcher) return;
  catcher.setIgnoreMouseEvents(true);
  clearTimeout(catcherYieldT);
  catcherYieldT = setTimeout(() => { if (catcher) catcher.setIgnoreMouseEvents(false); }, 5000);
});
function ensureCatcher() {
  const want = store.edgeSend && server && server.connected;
  if (!want) { if (catcher) { catcher.destroy(); catcher = null; } return; }
  if (catcher) { catcher.setBounds(catcherBounds()); return; }
  const cb = catcherBounds();
  catcher = new BrowserWindow({
    x: cb.x, y: cb.y, width: cb.width, height: cb.height, frame: false, transparent: true, resizable: false, movable: false,
    minimizable: false, maximizable: false, fullscreenable: false, skipTaskbar: true, focusable: false, show: false,
    hasShadow: false, alwaysOnTop: true, thickFrame: false, backgroundColor: '#01000000', title: 'Flick Edge',
    webPreferences: { preload: PRELOAD, backgroundThrottling: false, spellcheck: false },
  });
  catcher.setAlwaysOnTop(true, 'screen-saver');
  if (!IS_WIN) catcher.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  catcher.setMenu(null);
  catcher.loadFile(path.join(__dirname, 'catcher', 'catcher.html'));
  catcher.once('ready-to-show', () => { if (catcher) { catcher.showInactive(); catcher.setBounds(catcherBounds()); } });
  catcher.on('closed', () => { catcher = null; });
}

function overlayYFromScreenY(sy) { return sy - overlayBounds().y; }
function phoneYFromOverlayY(oy) {
  const ps = phoneScreen();
  const H = overlayBounds().height;
  return (oy - store.anchor * H) / kFactor() + ps.h / 2;
}

let hoverOn = false;
ipcMain.on('catcher:hover', (_e, d) => {
  if (!server || !server.connected || !catcher) return;
  const sy = catcher.getBounds().y + ((d && d.y) || 0);
  const oy = overlayYFromScreenY(sy);
  fx('edge-hover', { on: true, y: oy, h: phoneScreen().h * kFactor() * 0.55 });
  if (!hoverOn || Math.random() < 0.5) server.pushToPhone({ t: 'edge', on: true, y: phoneYFromOverlayY(oy) });
  hoverOn = true;
});
ipcMain.on('catcher:leave', () => {
  hoverOn = false;
  fx('edge-hover', { on: false });
  if (server) server.pushToPhone({ t: 'edge', on: false });
});

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

async function thumbFor(p) {
  const kind = kindOf(p);
  try {
    if (kind === 'image' && !IS_WIN) {
      const img = nativeImage.createFromPath(p);
      if (!img.isEmpty()) { const s = img.getSize(); const r = Math.min(1, 360 / Math.max(s.width, s.height)); const t = img.resize({ width: Math.max(1, Math.round(s.width * r)), height: Math.max(1, Math.round(s.height * r)) }); return { url: 'data:image/jpeg;base64,' + t.toJPEG(82).toString('base64'), w: t.getSize().width, h: t.getSize().height }; }
    }
    if ((IS_WIN || IS_MAC) && (kind === 'image' || kind === 'video' || extOf(p) === 'pdf')) {
      const t = await nativeImage.createThumbnailFromPath(p, { width: 360, height: 360 });
      if (t && !t.isEmpty()) return { url: 'data:image/jpeg;base64,' + t.toJPEG(82).toString('base64'), w: t.getSize().width, h: t.getSize().height };
    }
  } catch (e) { /* no thumb */ }
  return null;
}

ipcMain.on('catcher:drop', async (e, d) => {
  if (!fromWin(e, catcher)) return;
  hoverOn = false;
  if (!server || !server.connected) return;
  const sy = catcher ? catcher.getBounds().y + ((d && d.y) || 0) : overlayBounds().y + store.anchor * overlayBounds().height;
  fx('edge-hover', { on: false });
  const n = await sendPathsToPhone((d && d.paths) || [], sy);
  if (!n) server.pushToPhone({ t: 'edge', on: false });
});

// files (folders are opened up, up to MAX_SEND files) in the order given
const MAX_SEND = 100;
function expandPaths(list) {
  const out = [];
  const walk = (p, depth) => {
    if (out.length >= MAX_SEND) return;
    let st;
    try { st = fs.statSync(p); } catch (e) { return; }
    if (st.isFile()) { out.push(p); return; }
    if (!st.isDirectory() || depth > 6) return;
    let names = [];
    try { names = fs.readdirSync(p); } catch (e) { return; }
    for (const n of names.sort()) { if (!n.startsWith('.')) walk(path.join(p, n), depth + 1); }
  };
  for (const p of list) walk(String(p), 0);
  return out;
}

// Files waiting for the phone (sent from Explorer while no phone was connected); they go out when it connects.
let sendQueue = [];
function queueForPhone(paths) {
  const files = expandPaths(paths);
  if (!files.length) return;
  if (server && server.connected) { sendPathsToPhone(files); return; }
  sendQueue = sendQueue.concat(files).slice(0, MAX_SEND);
  sendQueue.at = Date.now();
  log('queued', files.length, 'file(s) for the phone');
  showPanel();
  if (panel) panelSend('panel:note', { text: 'Connect your phone and ' + (files.length === 1 ? path.basename(files[0]) : files.length + ' files') + ' will be sent.' });
}
function flushSendQueue() {
  if (!sendQueue.length || !server || !server.connected) return;
  const fresh = Date.now() - (sendQueue.at || 0) < 10 * 60 * 1000;
  const q = sendQueue; sendQueue = [];
  if (panel) panelSend('panel:note', { text: '' });
  if (fresh) setTimeout(() => sendPathsToPhone(q), 1200);
}

// opts: { fx: false (their cards already fly: Air grab), device (to that phone, not the one in use) }
async function sendPathsToPhone(list, screenY, opts) {
  if (!server || !server.connected) return 0;
  const device = (opts && opts.device) || undefined;
  const paths = expandPaths(list);
  if (!paths.length) return 0;
  const sy = typeof screenY === 'number' ? screenY : overlayBounds().y + store.anchor * overlayBounds().height;
  let oy = overlayYFromScreenY(sy);
  const shown = Math.min(paths.length, 12);        // the first dozen fly across the screen; the rest just go
  for (let i = 0; i < paths.length; i++) {
    const p = paths[i];
    const name = path.basename(p);
    const mime = MIME[extOf(name)] || 'application/octet-stream';
    const offer = server.offerFile(p, mime, device);
    // only the cards that fly across the screen need a picture (the phone makes its own once a file has arrived).
    // Thumbnails decode on this thread, so let downloads and messages run between files.
    const th = i < shown ? await thumbFor(p) : null;
    await new Promise((r) => setImmediate(r));
    const ext = extOf(name);
    const kind = kindOf(name);
    const aspect = th ? th.w / th.h : 0.72;
    const cw = 150, ch = Math.round(Math.max(110, Math.min(220, cw / Math.max(0.55, Math.min(1.8, aspect)))));
    const y = oy + Math.min(i, shown) * 22;
    if (i < shown && !(opts && opts.fx === false)) fx('outgoing', { fid: offer.fid, name, thumb: th && th.url, kind, badge: kind === 'doc' ? (ext || 'file').toUpperCase().slice(0, 4) : '', y, card: { w: cw, h: ch } });
    server.pushToPhone({
      t: 'incoming', fid: offer.fid, name, size: offer.size, mime, kind, ext,
      thumb: th && th.url, aspect, y: phoneYFromOverlayY(y), url: '/api/file/' + encodeURIComponent(offer.fid), delay: Math.min(i, shown) * 90,
    }, device);
    log('offer', name, offer.size);
  }
  return paths.length;
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
      qs = new QuickShare({ name: (server && server.name) || store.name || 'Flick PC', tmpDir: path.join(app.getPath('temp'), 'flick-quickshare'), log });
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
const qsOffers = new Map();      // share id -> what the phone offered (names, types) for the fly-in card
function onQsRequest(m) {
  log('quick share request from', m.from, m.files.length, 'file(s)', m.texts.length, 'text(s)');
  // the panel asks about one share at a time: an older unanswered one is declined so its phone isn't left waiting
  if (qsAsking && qsAsking.id !== m.id) answerQs(qsAsking.id, false);
  qsAsking = m;
  qsOffers.set(m.id, m);
  showPanel();
  if (panel) {
    panel.setAlwaysOnTop(true, 'floating');
    panel.show(); panel.focus(); panel.flashFrame(true);
    panelSend('panel:qs', m);
  }
  // nobody answered: decline, so the phone doesn't wait forever
  clearTimeout(onQsRequest.t);
  onQsRequest.t = setTimeout(() => { if (qsAsking && qsAsking.id === m.id) answerQs(m.id, false, 'timeout'); }, 58000);
}
function answerQs(id, accept, why) {
  if (!qs) return;
  if (qsAsking && qsAsking.id === id) {
    qsAsking = null;
    if (panel) { panel.setAlwaysOnTop(false); panel.flashFrame(false); panelSend('panel:qs-done', { id }); }
  }
  if (!accept) qsOffers.delete(id);
  qs.answer(id, accept, why);
}
ipcMain.on('panel:qs-answer', (e, m) => { if (fromPanel(e) && m) answerQs(m.id, !!m.accept); });
function onQsAccepted(m) {
  const tid = 'qs-' + m.id;
  qsTransfers.set(m.id, tid);
  const t = tState(tid);
  const offer = qsOffers.get(m.id);
  qsOffers.delete(m.id);
  const files = (offer && offer.files) || [];
  t.name = m.files === 1 && files[0] ? files[0].name : m.files + (m.files === 1 ? ' file' : ' files');
  log('quick share accepted:', t.name, Math.round(m.total / 1024) + ' KB');
  t.state = 'dropped'; t.upload = 'uploading'; t.seen = Date.now(); t.qs = true;
  // fly in from the phone's side of the screen, like a throw
  const ps = phoneScreen(), w = 150, h = 150;
  fx('lift', { tid, name: t.name, kind: m.files === 1 && files[0] && /^image\//.test(files[0].mime) ? 'image' : 'doc', badge: '', thumb: null, thumbs: [], count: Math.max(1, m.files), folder: false, size: m.total, card: { w, h } });
  const x = store.side === 'right' ? -w * 0.55 : ps.w - w * 0.45;
  setTimeout(() => fx('drop', { tid, x, y: ps.h / 2 - h / 2, w, h, r: 0, vx: store.side === 'right' ? -2.6 : 2.6, vy: 0, pw: ps.w, ph: ps.h }), 140);
}
function onQsProgress(m) {
  const tid = qsTransfers.get(m.id);
  const t = tid && transfers.get(tid);
  if (!t || !m.total) return;
  const now = Date.now();
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
  const dir = await saveDirNow();
  fs.mkdirSync(dir, { recursive: true });
  const placed = [];
  for (const f of m.files) {
    const dest = uniquePath(dir, sanitizeName(f.name));
    try { await placeItem(f.tmpPath, dest); } finally { release(dest); }
    const now = new Date(); fs.utimes(dest, now, now, () => {});
    markOfWeb(dest);
    placed.push(dest);
    hist({ dir: 'in', path: dest, deviceName: m.from || 'Quick Share', how: 'quickshare' });
  }
  for (const x of m.texts) {
    if (!x.value) continue;
    // links and text are put on the clipboard (never opened by themselves)
    require('electron').clipboard.writeText(x.value);
    if (panel) panelSend('panel:note', { text: (m.from || 'Your phone') + ' sent ' + (x.type === 2 ? 'a link' : 'some text') + ', now on your clipboard: ' + x.value.slice(0, 200) });
  }
  log('quick share saved', placed.length, 'file(s) from', m.from);
  if (store.openAfter && placed.length === 1) setTimeout(() => openAfterArrival(placed[0]), 900);
  if (t) {
    t.done = true;
    const name = placed.length === 1 ? path.basename(placed[0]) : placed.length ? placed.length + ' items' : 'Link copied';
    fx('saved', { tid, name, where: placed.length ? saveDirLabel() : 'Clipboard' });
    setTimeout(() => transfers.delete(tid), 5000);
  }
}
function onQsFailed(m) {
  log('quick share failed', m.why);
  if (m.why === 'no space') panelSend('panel:note', { text: 'Not enough free space on this PC to receive that.' });
  qsOffers.delete(m.id);
  if (qsAsking && qsAsking.id === m.id) { qsAsking = null; if (panel) { panel.setAlwaysOnTop(false); panelSend('panel:qs-done', { id: m.id }); } }
  const tid = qsTransfers.get(m.id);
  qsTransfers.delete(m.id);
  if (tid && transfers.get(tid)) { fx('failed', { tid }); hist({ dir: 'in', name: transfers.get(tid).name, size: 0, ok: false, how: 'quickshare' }); transfers.delete(tid); }
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
// Linux panel, when there's one at the top and none at the bottom) at the top.
function panelSpot(W, H) {
  const d = screen.getPrimaryDisplay(), wa = d.workArea, b = d.bounds;
  const top = IS_MAC || (IS_LINUX && wa.y > b.y && wa.y + wa.height >= b.y + b.height);
  return { x: wa.x + wa.width - W - 16, y: top ? wa.y + 8 : wa.y + wa.height - H - 16 };
}
function createPanel() {
  const W = 420, H = 680;
  const at = panelSpot(W, H);
  panel = new BrowserWindow({
    width: W, height: H, x: at.x, y: at.y,
    frame: false, resizable: false, maximizable: false, fullscreenable: false, show: false, backgroundColor: '#202020',
    title: 'Flick', icon: path.join(__dirname, 'assets', IS_WIN ? 'icon.ico' : 'icon.png'),
    webPreferences: { preload: PRELOAD, spellcheck: false },
  });
  panel.setMenu(null);
  panel.loadFile(path.join(__dirname, 'panel', 'panel.html'));
  panel.on('close', (e) => { if (!app.isQuitting) { e.preventDefault(); panel.hide(); sendPreview(false); } });
  panel.on('closed', () => { panel = null; });
  panelLoaded = false;
  panel.webContents.on('did-finish-load', () => {
    panelLoaded = true;
    pushPanelState();
    const q = panelQueue; panelQueue = [];
    for (const [ch, data] of q) panelSend(ch, data);
  });
}

let panelLoaded = false, panelQueue = [];
function panelSend(ch, data) {
  if (!panel || panel.isDestroyed()) return;
  if (!panelLoaded || panel.webContents.isLoading()) { panelQueue.push([ch, data]); return; }
  panel.webContents.send(ch, data);
}

function showPanel() {
  if (!panel) createPanel();
  const [W, H] = panel.getSize();
  const at = panelSpot(W, H);
  panel.setPosition(at.x, at.y);
  panel.show();
  panel.focus();
  pushPanelState();
}
function togglePanel() { if (panel && panel.isVisible()) panel.hide(); else showPanel(); }

// the user's Windows accent color, lightened the way Windows 11 does it on dark surfaces
function accentColors() {
  let hex = '0078d4';
  try { const { systemPreferences } = require('electron'); const a = systemPreferences.getAccentColor && systemPreferences.getAccentColor(); if (a && /^[0-9a-f]{6}/i.test(a)) hex = a.slice(0, 6); } catch (e) { /* default */ }
  const n = parseInt(hex, 16);
  const mix = (c) => Math.round(c + (255 - c) * 0.42);
  const r = mix((n >> 16) & 255), g = mix((n >> 8) & 255), b = mix(n & 255);
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return { accent: `rgb(${r},${g},${b})`, onAccent: lum > 0.55 ? '#000' : '#fff' };
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
    update: { state: updateInfo.state, version: updateInfo.version || '' },
    side: store.side, anchor: store.anchor, size: store.size, saveDir: store.saveDir, saveDirLabel: saveDirLabel(), saveDirPath: saveDirPath(),
    sound: store.sound, startup: store.startup, edgeSend: store.edgeSend, isWin: IS_WIN, os: IS_WIN ? 'win' : IS_MAC ? 'mac' : 'linux', theme: themeName(),
    openAfter: store.openAfter, showSpeed: store.showSpeed, sendTo: store.sendTo, autoUpdate: store.autoUpdate,
    bluetooth: store.bluetooth, btState: btState, quickShare: store.quickShare, qsState: qsState, airCam: store.airCam !== false, airCamState: air ? air.camState : 'off',
    via: s && s.connected ? s.via || '' : '',
    devices: Object.entries(store.devices || {}).map(([id, d]) => ({ id, name: d.name, added: d.added, ask: !!(store.acceptMode && store.acceptMode[id] === 'ask') })),
    displays: displays().map((d, i) => ({ id: d.id, label: `Display ${i + 1} (${d.size.width}×${d.size.height})`, primary: d.id === screen.getPrimaryDisplay().id })),
    displayId: store.displayId, firstRun: store.firstRun,
  };
}
function pushPanelState() { if (panel && !panel.isDestroyed()) panel.webContents.send('panel:state', panelState()); updateTray(); }

let previewOn = false;
function sendPreview(on) {
  if (on === previewOn) return;
  previewOn = on;
  fx('preview', { on, ph: phoneScreen().h });
}

ipcMain.on('panel:set', (e, m) => {
  if (!fromPanel(e) || !m) return;
  const { key, value } = m;
  switch (key) {
    case 'name': {
      const v = String(value || '').trim().slice(0, 40);
      if (v) { store.name = v; if (server) server.setName(v); if (qs) qs.setName(v); }
      break;
    }
    case 'side': if (value === 'left' || value === 'right') { store.side = value; } break;
    case 'anchor': store.anchor = Math.max(0.15, Math.min(0.85, +value || 0.5)); break;
    case 'size': store.size = Math.max(0.7, Math.min(1.5, +value || 1)); break;
    case 'sound': store.sound = !!value; break;
    case 'edgeSend': store.edgeSend = !!value; break;
    case 'displayId': store.displayId = value || null; break;
    case 'saveDir': if (value === 'desktop' || value === 'downloads') store.saveDir = value; break;
    case 'theme': if (THEMES.includes(value)) { store.theme = value; setTimeout(() => fx('demo', {}), 120); } break;
    case 'startup': store.startup = !!value; applyStartup(); break;
    case 'openAfter': store.openAfter = !!value; break;
    case 'showSpeed': store.showSpeed = !!value; break;
    case 'sendTo': store.sendTo = !!value; applySendTo(); break;
    case 'autoUpdate': store.autoUpdate = !!value; break;
    case 'bluetooth': store.bluetooth = !!value; applyBluetooth(); break;
    case 'quickShare': store.quickShare = !!value; applyQuickShare(); break;
    case 'airCam': store.airCam = !!value; if (air) air.settingChanged(); break;
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

ipcMain.on('panel:action', async (e, m) => {
  if (!fromPanel(e) || !m) return;
  const { what, arg } = m;
  switch (what) {
    case 'hide': if (panel) panel.hide(); sendPreview(false); break;
    case 'show': showPanel(); break;
    case 'quit': app.isQuitting = true; app.quit(); break;
    case 'openFolder': shell.openPath(saveDirPath()); break;
    case 'chooseFolder': {
      const r = await dialog.showOpenDialog(panel, { properties: ['openDirectory', 'createDirectory'], defaultPath: saveDirPath() });
      if (!r.canceled && r.filePaths[0]) { store.saveDir = r.filePaths[0]; saveStore(); pushPanelState(); }
      break;
    }
    case 'forget': if (server) server.forget(arg); break;
    case 'fixFirewall': fixFirewall(); break;
    case 'testFx': fx('connect', {}); break;
    case 'demo': fx('demo', {}); break;
    case 'dismissIntro': store.firstRun = false; saveStore(); pushPanelState(); break;
    case 'openLog': shell.openPath(LOG); break;
    case 'openRelease': shell.openExternal(updateInfo.page && /^https:\/\/github\.com\//.test(updateInfo.page) ? updateInfo.page : 'https://github.com/Maniw1234/flick/releases/latest'); break;
    case 'checkUpdates': runUpdateCheck(true); break;
    case 'sendFiles': {
      if (!server || !server.connected) break;
      const r = await dialog.showOpenDialog(panel, { title: 'Send to your phone', properties: ['openFile', 'multiSelections'] });
      if (!r.canceled && r.filePaths.length) sendPathsToPhone(r.filePaths);
      break;
    }
    case 'sendPaths': if (Array.isArray(arg)) queueForPhone(arg.slice(0, MAX_SEND)); break;
    default: break;
  }
});

ipcMain.on('panel:pair-answer', (e, m) => {
  if (!server || !fromPanel(e) || !m) return;
  if (m.allow) server.approve(m.device); else server.deny(m.device);
});

ipcMain.on('panel:preview', (e, d) => { if (fromPanel(e)) sendPreview(!!(d && d.on)); });

function fixFirewall() {
  if (!IS_WIN) {
    // macOS: Local Network privacy (and the firewall, if it's on); Linux: the firewall's ports. Said in the panel.
    const h = plat.connectHelp({ tcp: server ? server.port || server.basePort : 47860, udp: server ? server.discoveryPort : 47870 });
    if (h.url) shell.openExternal(h.url).catch(() => {});
    panelSend('panel:note', { text: h.text });
    return;
  }
  const exe = process.execPath;
  // All profiles on purpose: Windows calls a phone hotspot, USB tethering and many home networks "Public", and those are
  // exactly where the phone has to reach this PC. Write the elevated script to our own per-user folder under a random
  // name (not a shared, predictable temp path someone could pre-create or swap before it runs elevated).
  const cmdFile = path.join(app.getPath('userData'), 'flick-fw-' + rid(6) + '.cmd');
  const body = [
    '@echo off',
    'netsh advfirewall firewall delete rule name="Flick" >nul 2>&1',
    `netsh advfirewall firewall add rule name="Flick" dir=in action=allow program="${exe}" enable=yes profile=any`,
  ].join('\r\n');
  try { fs.writeFileSync(cmdFile, body, { mode: 0o600 }); } catch (e) { return; }
  const ps = `Start-Process -FilePath '${cmdFile.replace(/'/g, "''")}' -Verb RunAs -WindowStyle Hidden`;
  spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
  setTimeout(() => fs.unlink(cmdFile, () => {}), 20000);
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
    { label: 'Quit Flick', click: () => { app.isQuitting = true; app.quit(); } },
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
  if (IS_MAC) tray.on('drop-files', (_e, files) => { if (Array.isArray(files)) queueForPhone(files.slice(0, MAX_SEND)); });
  updateTray();
}

// ------------------------------------------------------------ phone app updates (over Wi-Fi, from this PC)
// Candidates: the phone app that ships inside this PC app, plus any Flick APK in Downloads\Flick (so a newer phone
// build can be dropped there without reinstalling the PC app). The highest version code wins; the phone itself checks
// package, version, size, SHA-256 and signature before it offers to install.
const PHONE_PKG = 'com.flick.app';
const BUNDLED_APK = process.env.FLICK_PHONE_APK || path.join(__dirname, 'phone-app', 'Flick.apk');
function apkDir() { return process.env.FLICK_APK_DIR || path.join(app.getPath('downloads'), 'Flick'); }
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

async function runUpdateCheck(manual) {
  if (!updater || updateBusy || process.env.FLICK_NO_UPDATES === '1') return;
  if (!manual && store.autoUpdate === false) return;
  updateBusy = true;
  try {
    updateInfo = await updater.check();
    if (updateInfo.state === 'error') log('update check:', updateInfo.version || '', updateInfo.why);
    if (updateInfo.state === 'ready') scheduleRestart(updateInfo.version);
  } catch (e) { log('update check failed', e.message); }
  updateBusy = false;
  pushPanelState();
}

// restart into the new version, but never in the middle of a transfer or an animation
function scheduleRestart(ver) {
  if (restartT) return;
  const tryNow = () => {
    restartT = null;
    const moving = [...transfers.values()].some((t) => !t.done && (t.state === 'lifted' || t.state === 'dropped'));
    const queued = sendQueue.length > 0 && Date.now() - (sendQueue.at || 0) < 10 * 60000;   // a queue goes stale after 10 min
    const busy = moving || queued || (server && server.outgoingBusy()) || overlayShown || (panel && panel.isVisible() && panel.isFocused()) || (web && web.busy());
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

function sanitizeName(n) {
  // also drop invisible direction-control characters, which can make "photo\u202Egnp.exe" read as "photoexe.png"
  let s = String(n || 'file').replace(/[<>:"/\\|?*\u0000-\u001f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '_').replace(/[. ]+$/, '').trim();
  if (!s) s = 'file';
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(s)) s = '_' + s;
  if (s.length > 180) {
    let e = path.extname(s);
    if (e.length > 16) e = '';                         // a "dot near the start" isn't an extension worth keeping
    s = s.slice(0, 180 - e.length) + e;
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
  '.application', '.gadget', '.ws', '.vb', '.jnlp', '.chm', '.sct', '.appref-ms']);
// and their macOS and Linux kin: apps, installers, disk images, scripts, launchers
if (!IS_WIN) for (const x of ['.app', '.pkg', '.mpkg', '.dmg', '.command', '.tool', '.terminal', '.workflow', '.scpt', '.applescript',
  '.sh', '.bash', '.zsh', '.csh', '.ksh', '.fish', '.py', '.pl', '.rb', '.desktop', '.appimage', '.run', '.bin', '.deb', '.rpm', '.flatpakref']) RISKY_EXT.add(x);
const riskyExt = (p) => RISKY_EXT.has(path.extname(p).toLowerCase());

function markOfWeb(dest) {
  if (IS_MAC) { plat.quarantine(dest); return; }   // macOS' own mark (Gatekeeper); Linux has none
  if (!IS_WIN) return;
  fs.writeFile(dest + ':Zone.Identifier', '[ZoneTransfer]\r\nZoneId=3\r\n', () => {});
}

// mark a received file, or every file inside a received folder (bounded, best-effort)
function markTree(dest) {
  if (IS_MAC) { plat.quarantine(dest, true); return; }
  if (!IS_WIN) return;
  fs.stat(dest, (e, st) => {
    if (e) return;
    if (st.isFile()) return markOfWeb(dest);
    if (!st.isDirectory()) return;
    let budget = 5000;
    const walk = (d) => fs.readdir(d, { withFileTypes: true }, (er, ents) => {
      if (er) return;
      for (const ent of ents) {
        if (budget-- <= 0) return;
        const full = path.join(d, ent.name);
        if (ent.isDirectory()) walk(full); else if (ent.isFile()) markOfWeb(full);
      }
    });
    walk(dest);
  });
}

// "open after it arrives": fine for a document or photo, but never launch a program/script/shortcut — reveal it instead
function openAfterArrival(dest) {
  if (riskyExt(dest)) { try { shell.showItemInFolder(dest); } catch (e) { /* ignore */ } return; }
  shell.openPath(dest);
}

// what the overlay needs to draw the card: a photo, a document, a folder, or a stack of several items
function liftInfo(m, t) {
  const f = m.file || {};
  const thumbs = Array.isArray(m.thumbs) ? m.thumbs.filter((x) => typeof x === 'string' && x.startsWith('data:image/')).slice(0, 2) : [];
  return {
    tid: m.tid, name: t.name, kind: f.kind, badge: f.badge, thumb: m.thumb || null, thumbs,
    count: Math.max(1, Math.min(100000, +f.count || 1)), folder: !!f.folder,
    size: f.size || 0, card: { w: m.w || 160, h: m.h || 160 },
  };
}

function uniqueDirPath(dir, name) {
  let p = path.join(dir, name), i = 2;
  while (taken(p)) p = path.join(dir, `${name} (${i++})`);
  reserved.add(p.toLowerCase());
  return p;
}

// move one staged file or folder into place; across drives (or when Windows briefly locks a fresh file) copy instead
async function placeItem(src, dest) {
  try { await fs.promises.rename(src, dest); return; }
  catch (e) { if (!['EXDEV', 'EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY'].includes(e.code)) throw e; }
  await fs.promises.cp(src, dest, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
  await fs.promises.rm(src, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
}

async function finalizeBundle(t, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const placed = [];
  let lost = 0;
  try {
    // everything that's in the staging folder goes out (not just the names the manifest listed)
    let tops = t.bundle.tops.slice();
    try { const have = await fs.promises.readdir(t.tmpPath); tops = tops.filter((x) => have.includes(x)).concat(have.filter((x) => !tops.includes(x))); } catch (e) { /* keep the list */ }
    for (const top of tops) {
      const src = path.join(t.tmpPath, top);
      let st;
      try { st = await fs.promises.stat(src); } catch (e) { continue; }
      const dest = st.isDirectory() ? uniqueDirPath(dir, top) : uniquePath(dir, top);
      try {
        await placeItem(src, dest);
        const now = new Date(); fs.utimes(dest, now, now, () => {});
        markTree(dest);
        received.addTree(dest);
        placed.push(path.basename(dest));
        hist({ dir: 'in', tid: t.tid, path: dest, how: 'fling' });
      } catch (e) { lost++; log('could not save', top, e.message); }
      finally { release(dest); }
    }
  } finally {
    fs.rm(t.tmpPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }, () => {});
  }
  if (!placed.length) throw new Error('nothing received');
  log('saved', placed.length, 'item(s) in', dir, t.bundle.files, 'files', lost ? '(' + lost + ' could not be saved)' : '');
  return placed.length === 1 ? placed[0] : placed.length + ' items';
}

function tState(tid) {
  let t = transfers.get(tid);
  if (!t) { t = { tid, state: 'lifted', upload: 'none', name: 'file', t0: Date.now() }; transfers.set(tid, t); }
  return t;
}

// the overlay messages that fly a transfer's card in from the phone's side (a send from the phone's menu, a transfer
// that carries on after a pause)
function flyInMsgs(tid, info, pw, ph) {
  const ps = { w: pw || phoneScreen().w, h: ph || phoneScreen().h };
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
function askFirst(t) {
  if (!feats || t.ask || t.qs || t.web) return;
  const device = server.ownerOf(t.tid);
  if (!device || feats.ask.mode(device) !== 'ask') return;
  t.ask = 'wait';
  const info = t.info || {}, b = t.bundleInfo;
  server.pushToPhone({ t: 'asking', tid: t.tid }, device);
  feats.ask.ask({
    device, deviceName: server.api.nameOf(device), name: t.name, tid: t.tid, kind: 'fling',
    count: b && b.roots.length ? b.roots.length : info.count || 1, size: b ? b.bytes : +info.size || 0, names: b ? b.roots : [],
  }).then((r) => {
    if (transfers.get(t.tid) !== t || t.done) return;
    if (r.yes) { t.ask = 'yes'; t.seen = Date.now(); if (t.state === 'dropped' && t.upload === 'done') finalize(t); return; }
    t.ask = 'no';
    log('transfer', t.tid, r.why);
    server.pushToPhone({ t: 'failed', tid: t.tid, why: r.why }, device);    // before the upload is cut: the phone won't retry it
    gone.set(t.tid, Date.now());
    fx('cancel', { tid: t.tid });
    clearTimeout(t.failT); clearTimeout(t.timer);
    server.abortUpload(t.tid, r.why);
    if (r.why === 'declined' || r.why === 'timeout') hist({ dir: 'in', tid: t.tid, name: t.name, size: 0, ok: false, how: 'fling', why: r.why });
    discard(t);
  });
}
function unask(t) { if (feats && t && t.ask === 'wait') feats.ask.withdraw((a) => a.tid === t.tid, 'canceled'); }
// the questions show in the window, in front of whatever the user is doing (like a phone asking to pair)
function askFront(on, fresh) {
  if (on && fresh) {
    showPanel();
    if (panel) { panel.setAlwaysOnTop(true, 'floating'); panel.show(); panel.focus(); panel.flashFrame(true); }
  } else if (!on && panel && !panel.isDestroyed()) { panel.setAlwaysOnTop(false); panel.flashFrame(false); }
}

async function finalize(t) {
  if (t.done || t.ask === 'wait' || t.ask === 'no') return;
  t.done = true;
  t.paused = false;
  if (t.already) {
    // the phone sent nothing: this PC has the file(s) already (see have.js)
    const name = t.already.name || t.name;
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
      fx('saved', { tid: t.tid, name, where: saveDirLabel() });
      if (server) server.pushToPhone({ t: 'saved', tid: t.tid, name, where: saveDirLabel() });
      setTimeout(() => transfers.delete(t.tid), 5000);
      return;
    }
    fs.mkdirSync(dir, { recursive: true });
    dest = uniquePath(dir, sanitizeName(t.name));
    try { await fs.promises.rename(t.tmpPath, dest); }
    catch (e) {
      if (e.code === 'EXDEV' || e.code === 'EPERM') { await fs.promises.copyFile(t.tmpPath, dest); await fs.promises.unlink(t.tmpPath).catch(() => {}); }
      else throw e;
    }
    release(dest);
    const now = new Date(); fs.utimes(dest, now, now, () => {});
    markOfWeb(dest);
    received.add(dest);
    log('saved', dest);
    hist({ dir: 'in', tid: t.tid, path: dest, how: 'fling' });
    // a video that was playing on the phone (Air grab) carries on here from the same second
    if (t.video && air && kindOf(dest) === 'video') setTimeout(() => air.playAt(dest, t.video.t, () => openAfterArrival(dest)), 700);
    else if (store.openAfter) setTimeout(() => openAfterArrival(dest), 900);
    fx('saved', { tid: t.tid, name: path.basename(dest), where: saveDirLabel() });
    if (server) server.pushToPhone({ t: 'saved', tid: t.tid, name: path.basename(dest), where: saveDirLabel() });
  } catch (e) {
    log('finalize failed', e.message);
    hist({ dir: 'in', tid: t.tid, name: t.name, size: 0, ok: false, how: 'fling' });
    release(dest);
    if (t.tmpPath) fs.rm(t.tmpPath, { recursive: true, force: true }, () => {});   // don't leave the received copy in temp
    fx('failed', { tid: t.tid });
    if (server) server.pushToPhone({ t: 'failed', tid: t.tid, why: 'save' });
  }
  setTimeout(() => transfers.delete(t.tid), 5000);
}

function discard(t) {
  unask(t);
  if (air) air.cancel(t.tid);                    // a card a hand held (Air grab) stops waiting too
  if (t.tmpPath && t.bundle) fs.rm(t.tmpPath, { recursive: true, force: true }, () => {});
  else if (t.tmpPath) fs.unlink(t.tmpPath, () => {});
  transfers.delete(t.tid);
}

function wireServer() {
  server.on('log', (m) => log(m));
  server.on('phone-hello', (s) => { log('hello', s.name, s.address, 'app', s.appName || 'unknown'); pushPanelState(); });
  server.on('app-check', () => refreshPhoneApp(true));
  server.on('app-download', (a) => log('phone downloading app update', a.code, a.size));
  server.on('hold', ({ p }) => {
    fx('hold', { p, ph: phoneScreen().h });
  });
  server.on('connected', (s) => {
    log('connected', s.name, s.via ? 'over ' + s.via : '');
    flushSendQueue();
    fx('connect', { name: s.name });
    pushPanelState();
    ensureCatcher();
    refreshPhoneApp();
  });
  server.on('disconnected', (s) => {
    log('disconnected', s && s.name);
    pushPanelState();
    ensureCatcher();
    // cards still held by the phone that left (another connected phone's stay)
    for (const t of transfers.values()) if (t.state === 'lifted' && (!s || !server.ownerOf(t.tid) || server.ownerOf(t.tid) === s.device)) { if (air) air.cancel(t.tid); fx('cancel', { tid: t.tid }); discard(t); }
    if (air && s) air.phoneReady(s.device, false);
  });
  server.on('active', () => { pushPanelState(); ensureCatcher(); });   // another phone is in use: its name, its height
  server.on('pair-request', (s) => {
    log('pair request', s.name);
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
    if (panel) {
      panel.setAlwaysOnTop(false);
      panel.flashFrame(false);
      panelSend('panel:pair-cancel', { device });
    }
  });
  server.on('devices-changed', (devs) => { store.devices = devs; saveStore(); pushPanelState(); });

  server.on('lift', (m) => {
    const t = tState(m.tid);
    t.name = (m.file && m.file.name) || t.name;
    if (m.file) t.info = m.file;                   // name, size, count: what "Ask each time" shows
    t.state = 'lifted';
    t.seen = Date.now();
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
    t.seen = Date.now();
    if (air) t.video = air.go(t, m);
    else airLand(t, flyInMsgs(m.tid, t.info).drop);
    askFirst(t);
    if (t.upload === 'done') finalize(t);
    clearTimeout(t.timer);
  });
  // a fist that opened over the phone: the files a fist picked up in front of this PC go to it
  server.on('air-catch', (m) => { if (air) air.catchFiles(m.device); });
  // a phone with Air grab on and Flick open: selecting files here gets the camera ready for a grab (air.js)
  server.on('air-ready', (m) => { if (air) air.phoneReady(m.device, !!m.on); });
  server.on('move', (m) => { const t = transfers.get(m.tid); if (t) t.seen = Date.now(); fx('move', m); });
  server.on('drop', (m) => {
    const t = tState(m.tid);
    t.state = 'dropped';
    t.seen = Date.now();
    fx('drop', m);
    askFirst(t);
    if (t.upload === 'done') finalize(t);
    clearTimeout(t.timer);   // a dropped transfer now lives as long as bytes keep arriving (see watchdog)
  });
  server.on('send', (m) => { // programmatic send (from the phone menu): fly in from the phone edge
    const t = tState(m.tid);
    t.name = (m.file && m.file.name) || t.name;
    if (m.file) t.info = m.file;
    t.state = 'dropped';
    t.info = Object.assign(liftInfo(m, t), { card: { w: m.w || 160, h: m.h || 160 } });
    askFirst(t);
    const f = flyInMsgs(m.tid, t.info, m.pw, m.ph);
    fx('lift', f.lift);
    setTimeout(() => fx('drop', f.drop), 140);
    if (t.upload === 'done') finalize(t);
  });
  server.on('cancel', (m) => {
    if (air) air.cancel(m.tid);
    const t = transfers.get(m.tid);
    if (!t) { gone.set(m.tid, Date.now()); return; }          // never seen (its upload never started): nothing to undo
    const wasDropped = t.state === 'dropped';
    t.state = 'canceled';
    fx(m.failed && wasDropped ? 'failed' : 'cancel', { tid: m.tid });
    clearTimeout(t.failT); clearTimeout(t.timer);
    if (t.upload === 'uploading') server.abortUpload(m.tid);
    discard(t);
    gone.set(m.tid, Date.now());
  });
  server.on('upload-start', ({ tid, name, total, committed, again }) => {
    // late bytes of a transfer canceled or declined here are refused; "Try again" on the phone (again) starts it anew
    if (isGone(tid)) { if (!again) { server.abortUpload(tid); return; } gone.delete(tid); }
    const fresh = !transfers.has(tid);
    const t = tState(tid);
    t.upload = 'uploading'; t.seen = Date.now();
    clearTimeout(t.failT);
    if (name && t.name === 'file') t.name = name;
    // one the user sent before this PC restarted, starting over now: its card flies in as if just sent
    if (committed && fresh) {
      t.state = 'dropped';
      t.info = { tid, name: name === 'bundle' ? 'Files' : t.name, kind: name === 'bundle' ? 'folder' : 'file', size: total || 0, count: 1, card: { w: 160, h: 160 } };
      askFirst(t);
      const f = flyInMsgs(tid, t.info);
      fx('lift', f.lift);
      setTimeout(() => fx('drop', f.drop), 140);
    }
  });
  server.on('upload-progress', ({ tid, received, total }) => {
    const t = transfers.get(tid);
    if (!t) return;
    const now = Date.now();
    if (!t.rt) { t.rt = now; t.rs = received; }
    else if (now - t.rt > 400) { const inst = Math.max(0, received - t.rs) / ((now - t.rt) / 1000); t.rate = t.rate ? t.rate * 0.6 + inst * 0.4 : inst; t.rt = now; t.rs = received; }
    t.seen = now;
    if (t.state === 'dropped' && total) fx('progress', { tid, p: received / total, rate: store.showSpeed ? t.rate || 0 : 0 });
  });
  // a resumable transfer stopped (its phone's app was closed, its Wi-Fi dropped): it waits for the phone to come back
  server.on('upload-paused', ({ tid }) => {
    const t = transfers.get(tid);
    if (!t || t.done) return;
    log('transfer', tid, 'paused: waiting for the phone');
    t.paused = true; t.seen = Date.now();
    if (t.state === 'dropped') fx('paused', { tid });
  });
  server.on('upload-resumed', ({ tid }) => {
    const t = transfers.get(tid);
    if (!t || t.done) return;
    log('transfer', tid, 'carries on');
    t.paused = false; t.seen = Date.now();
    if (t.state === 'dropped') { const f = flyInMsgs(tid, t.info || { tid, name: t.name }); fx('resumed', { tid, lift: f.lift, drop: f.drop }); }
  });
  // the phone has nothing to send: this PC has the file(s) already
  server.on('already-have', ({ tid, name }) => {
    if (isGone(tid)) return;
    const t = tState(tid);
    log('transfer', tid, 'already on this PC:', name);
    t.upload = 'done'; t.already = { name }; t.seen = Date.now();
    clearTimeout(t.failT);
    if (t.state === 'dropped') finalize(t);
    else if (t.state === 'canceled') discard(t);
    else { clearTimeout(t.timer); t.timer = setTimeout(() => { if (t.state === 'lifted') discard(t); }, 120000); }
  });
  server.on('bundle-manifest', ({ tid, files, bytes, roots }) => {
    fx('info', { tid, size: bytes, files });
    const t = transfers.get(tid);
    if (t) {
      t.bundleInfo = { files, bytes, roots: Array.isArray(roots) ? roots.slice(0, 50) : [] };
      if (t.ask === 'wait' && feats) feats.ask.update(tid, { count: t.bundleInfo.roots.length, size: bytes, names: t.bundleInfo.roots });
    }
  });
  server.on('upload-done', ({ tid, tmpPath, name, bundle, size, ms }) => {
    if (isGone(tid)) { fs.rm(tmpPath, { recursive: true, force: true }, () => {}); return; }   // canceled meanwhile
    const t = tState(tid);
    if (size && ms) log('received', size, 'bytes in', (ms / 1000).toFixed(1) + 's', (size / Math.max(1, ms) / 1000).toFixed(1) + ' MB/s');
    t.upload = 'done'; t.tmpPath = tmpPath; t.seen = Date.now(); if (name) t.name = name;
    clearTimeout(t.failT);
    if (bundle) t.bundle = bundle;
    if (t.state === 'dropped') finalize(t);
    else if (t.state === 'canceled') discard(t);
    else { clearTimeout(t.timer); t.timer = setTimeout(() => { if (t.state === 'lifted') discard(t); }, 120000); }
  });
  server.on('upload-failed', ({ tid, why }) => {
    const t = transfers.get(tid);
    log('upload failed', tid, why);
    if (!t) return;
    t.upload = 'failed';
    // the phone retries once by itself (same transfer); only give up if no new attempt starts soon
    clearTimeout(t.failT);
    t.failT = setTimeout(() => {
      if (transfers.get(tid) !== t || t.upload !== 'failed' || t.done) return;
      if (t.state === 'dropped') { fx('failed', { tid }); server.pushToPhone({ t: 'failed', tid, why: 'upload' }); hist({ dir: 'in', tid, name: t.name, size: 0, ok: false, how: 'fling' }); }
      else if (t.state === 'lifted') {
        fx('cancel', { tid });
        // a hand still holds it on the phone: told, and a later attempt of it is turned away (as for a cancel)
        if (t.air) { server.pushToPhone({ t: 'failed', tid, why: 'upload' }); gone.set(tid, Date.now()); }
      }
      if (air) air.cancel(tid);
      unask(t);
      transfers.delete(tid);
    }, 15000);
  });
  server.on('set-theme', (name) => {
    if (!THEMES.includes(name)) return;
    store.theme = name; saveStore();
    server.setSettings({ side: store.side, anchor: store.anchor, theme: themeName() });
    placeOverlay(); pushPanelState();
    setTimeout(() => fx('demo', {}), 150);         // show it on the PC right away
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
hotspot.on('state', () => pushWebState());
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
  if (hotQr.text !== hot.wifi) hotQr = { text: hot.wifi, qr: hot.wifi ? QR.svgPath(QR.encode(hot.wifi, { ecl: 'M' }), 4) : null };
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
  try { await placeItem(tmpPath, dest); } finally { release(dest); }
  const now = new Date(); fs.utimes(dest, now, now, () => {});
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
  t.state = 'dropped'; t.upload = 'uploading'; t.seen = Date.now(); t.web = true; t.liftAt = Date.now();
  log('receiving from a browser:', g.device, g.count === 1 ? '1 file' : g.count + ' files');
  const ps = phoneScreen(), w = 150, h = 150;
  fx('lift', { tid, name: t.name, kind: 'doc', badge: g.count === 1 ? (extOf(g.name) || 'file').toUpperCase().slice(0, 4) : '', thumb: null, thumbs: [],
    count: Math.max(1, g.count), folder: false, size: g.total, card: { w, h } });
  const x = store.side === 'right' ? -w * 0.55 : ps.w - w * 0.45;
  setTimeout(() => fx('drop', { tid, x, y: ps.h / 2 - h / 2, w, h, r: 0, vx: store.side === 'right' ? -2.6 : 2.6, vy: 0, pw: ps.w, ph: ps.h }), 140);
}
function onWebProgress(g) {
  const t = webCards.get(g.gid);
  if (!t || transfers.get(t.tid) !== t || !g.total) return;
  const now = Date.now();
  if (!t.rt) { t.rt = now; t.rs = g.received; } else if (now - t.rt > 400) { const inst = Math.max(0, g.received - t.rs) / ((now - t.rt) / 1000); t.rate = t.rate ? t.rate * 0.6 + inst * 0.4 : inst; t.rt = now; t.rs = g.received; }
  t.seen = now;
  fx('progress', { tid: t.tid, p: Math.min(1, g.received / g.total), rate: store.showSpeed ? t.rate || 0 : 0 });
}
const WEB_OPENABLE = /\.(jpe?g|png|gif|webp|heic|heif|bmp|tiff?|mp4|mov|m4v|webm|mkv|avi|mp3|m4a|aac|wav|flac|ogg|opus|pdf|txt)$/i;
function onWebDone(g) {
  const t = webCards.get(g.gid);
  webCards.delete(g.gid);
  const n = g.saved.length;
  log('from a browser:', n + ' saved', g.failed ? g.failed + ' not' : '');
  // "open after it arrives", for a browser (a guest's device): only pictures, videos, music, PDFs and plain text open;
  // anything else is shown in its folder
  if (store.openAfter && n === 1 && !g.failed) {
    const p = g.saved[0].path;
    setTimeout(() => { if (WEB_OPENABLE.test(p)) openAfterArrival(p); else { try { shell.showItemInFolder(p); } catch (e) { /* ignore */ } } }, 900);
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

ipcMain.on('panel:web', async (e, m) => {
  if (!web || !fromPanel(e) || !m || typeof m !== 'object') return;
  switch (m.what) {
    case 'start': web.start(); break;
    case 'stop': web.stop('user'); hotspot.stop(); hotAddr = null; break;
    case 'hot-start': startHotspot(); break;
    case 'hot-stop': hotspot.stop(); hotAddr = null; break;
    case 'addr': if (typeof m.addr === 'string') webAddr = m.addr; break;
    case 'pick': {
      if (!web.active) break;
      const r = await dialog.showOpenDialog(panel, { title: 'Share with browsers', properties: ['openFile', 'multiSelections'] });
      if (!r.canceled && r.filePaths.length) web.addFiles(expandPaths(r.filePaths));
      break;
    }
    case 'add': if (web.active && Array.isArray(m.paths)) web.addFiles(expandPaths(m.paths.filter((p) => typeof p === 'string').slice(0, MAX_SEND))); break;
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
  web = new WebShare({ server, save: webSave, where: saveDirLabel });
  server.web = web;                             // server.js hands /w/ requests to it
  web.on('log', (m) => log(m));
  // sharing ended (by itself, after a while with no browser): the PC's own Wi-Fi network goes with it
  web.on('state', () => { if (!web.active && hotspot.state !== 'off') { hotspot.stop(); hotAddr = null; } pushWebState(); });
  web.on('ask', onWebAsk);
  web.on('ask-done', onWebAskDone);
  web.on('incoming-start', onWebIncoming);
  web.on('incoming-progress', onWebProgress);
  web.on('incoming-done', onWebDone);
  web.on('text', (t) => { showPanel(); panelSend('panel:web-text', { id: t.id }); });
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
  });
}
ipcMain.on('panel:feedback', async (e, m) => {
  if (!fb || !fromPanel(e) || !m || typeof m !== 'object') return;
  if (m.what === 'send') {
    const r = await fb.send({ type: m.type === 'idea' ? 'idea' : 'bug', message: String(m.message || ''), email: String(m.email || ''), device: m.device === true });
    panelSend('panel:feedback', Object.assign({ result: r }, fb.info()));
    return;
  }
  panelSend('panel:feedback', fb.info());        // 'hello': the form was opened
  fb.flush();
});

// ------------------------------------------------------------ app
app.on('second-instance', (_e, argv) => {
  // a second start counted against this version's start attempts; it's clearly running, so clear them again
  if (healthy && updater) updater.markHealthy(BOOT);
  const files = sendArgs(argv || []);
  if (files.length) queueForPhone(files);
  else showPanel();
});
app.on('window-all-closed', (e) => { /* keep running in tray */ });
app.on('before-quit', () => {
  app.isQuitting = true;
  if (saveTimer) { clearTimeout(saveTimer); writeStoreNow(); }      // don't lose a setting changed just before quitting
  try { if (bt) bt.stop(); } catch (e) { /* ignore */ }
  try { if (qs) qs.stop(); } catch (e) { /* ignore */ }
  try { if (feats) feats.stop(); } catch (e) { /* ignore */ }
  try { if (air) air.stop(); } catch (e) { /* ignore */ }
  try { hotspot.stop(); } catch (e) { /* ignore */ }                // the PC's own Wi-Fi network, if Flick started it
  try { if (fb) fb.stop(); } catch (e) { /* ignore */ }
  try { server && server.stop(); } catch (e) { /* ignore */ }
});

// Leftovers from a crash or power cut (half-received files, staging folders) in Flick's own temp folders.
// Nothing can be in flight at startup, so anything older than a few minutes goes.
// Leftovers of transfers that never finished: at start, anything older than 10 minutes; while Flick runs (every 30
// minutes), files untouched for six hours (a file still arriving is written to all the time; folders are left to the
// transfers that own them)
function sweepTemp(running) {
  const now = Date.now(), age = running ? 6 * 3600000 : 10 * 60000;
  for (const dir of [path.join(app.getPath('temp'), 'flick-incoming'), path.join(app.getPath('temp'), 'flick-quickshare')]) {
    fs.readdir(dir, (e, names) => {
      if (e) return;
      for (const n of names) {
        const full = path.join(dir, n);
        fs.stat(full, (er, st) => { if (!er && now - st.mtimeMs > age && (!running || st.isFile())) fs.rm(full, { recursive: true, force: true }, () => {}); });
      }
    });
  }
  if (running) return;
  fs.readdir(app.getPath('userData'), (e, names) => {
    if (!e) for (const n of names) if (/^flick-fw-.*\.cmd$/.test(n)) fs.unlink(path.join(app.getPath('userData'), n), () => {});
  });
}

app.whenReady().then(async () => {
  sweepTemp();
  setInterval(() => sweepTemp(true), 30 * 60000).unref();
  // a Windows account without a full name could leave the PC named "Comment's PC": fix it automatically
  if (!store.name || store.name === "Comment's PC") { store.name = await defaultName(); saveStore(); }
  // this PC's certificate (made the first time): phones talk to it only over links encrypted with it
  const tlsId = tlscert.ensure(app.getPath('userData'), 'Flick ' + store.id);
  if (!tlsId) log('no certificate: encrypted links are off');
  server = new FlickServer({
    // test runs can move the ports (several copies under test on one machine); real installs always use the defaults
    id: store.id, name: store.name, port: (TEST_MODE && +process.env.FLICK_PORT) || 47860,
    discoveryPort: (TEST_MODE && +process.env.FLICK_DISCOVERY_PORT) || 47870, version: VERSION,
    tmpDir: path.join(app.getPath('temp'), 'flick-incoming'), devices: store.devices,
    settings: { side: store.side, anchor: store.anchor, theme: themeName() },
    allowOrigin: TEST_MODE ? /^http:\/\/127\.0\.0\.1:\d+$/ : null,   // test harnesses serve the phone page over http
    tls: tlsId,
    haveFiles: (items) => received.lookup(items),
  });
  wireServer();
  try { const port = await server.start(); log('listening', port, lanAddresses().map((a) => a.address).join(',')); }
  catch (e) { log('server failed', e.message); dialog.showErrorBox('Flick', 'Flick could not start its connection service.\n\n' + e.message); }
  startWeb();
  feats = require('./features').attach({
    electron: require('electron'), server, store, saveStore, log, userDir, appDir: __dirname,
    saveReceived: webSave, saveDirNow, markOfWeb, openAfterArrival, panelSend, getPanel: () => panel,
    sendFiles: (paths) => queueForPhone(paths), updateTray, pushState: pushPanelState, front: askFront,
    askMs: (TEST_MODE && +process.env.FLICK_TEST_ASK_MS) || undefined,   // tests can shorten the 60 s
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
      gone.set(t.tid, Date.now());
      discard(t);
    },
    liftMaxMs: (TEST_MODE && +process.env.FLICK_TEST_AIR_HOLD_MS) || undefined,      // tests can shorten the 90 s
    camMaxMs: (TEST_MODE && +process.env.FLICK_TEST_AIR_CAM_MS) || undefined,        // and the camera's half minute
    debug: TEST_MODE,                                                                  // tests: hand events in the log
  });
  createTray();
  applyStartup();
  screen.on('display-metrics-changed', () => { placeOverlay(); ensureCatcher(); });
  screen.on('display-added', () => { placeOverlay(); ensureCatcher(); });
  screen.on('display-removed', () => { placeOverlay(); ensureCatcher(); });

  applySendTo();
  applyBluetooth();
  applyQuickShare();
  // macOS: the menu bar's Edit menu is what makes copy and paste work in the panel's fields (Electron's default menu
  // would also offer reloading the windows and their developer tools)
  if (IS_MAC) Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]));
  startedAt = Date.now();
  const startFiles = sendArgs(process.argv);
  if (startFiles.length) setTimeout(() => queueForPhone(startFiles), 1500);
  else if (openFiles.length) setTimeout(sendOpenFiles, 1500);
  else if (!(HIDDEN_START || openedAtLogin()) || store.firstRun) showPanel();
  if (TEST_MODE) startTestControl();
});

// ------------------------------------------------------------ test-only control port (never enabled in normal use)
function startTestControl() {
  require('http').createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    try {
      if (u.pathname.startsWith('/f/') && feats) return feats.test(u, res);    // the phone features (features.js)
      if (u.pathname === '/fb/state' && fb) return res.end(JSON.stringify(Object.assign({ outbox: fb.outbox, url: fb._url() }, fb.info())));
      if (u.pathname === '/air' && air) { air.testHand(JSON.parse(u.searchParams.get('ev') || '{}')); return res.end('ok'); }   // a hand the camera "sees"
      if (u.pathname === '/air-select' && air) { air.testSelect(JSON.parse(u.searchParams.get('paths') || '[]'), u.searchParams.get('first') === '1'); return res.end('ok'); }   // files "selected"
      if (u.pathname === '/air-state' && air) return res.end(JSON.stringify(air.state));
      if (u.pathname === '/fb/flush' && fb) { await fb.flush(); return res.end(JSON.stringify(fb.info())); }
      if (u.pathname === '/capture') {
        const w = u.searchParams.get('w') === 'panel' ? panel : u.searchParams.get('w') === 'air' && air ? air.window : overlay;
        const img = await w.webContents.capturePage();
        fs.writeFileSync(u.searchParams.get('out'), img.toPNG());
        return res.end('ok');
      }
      if (u.pathname === '/state') {
        return res.end(JSON.stringify({
          overlayShown, overlayReady, connected: !!(server && server.connected),
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
      res.statusCode = 404; res.end();
    } catch (e) { res.statusCode = 500; res.end(String(e && e.stack)); }
  }).listen((TEST_MODE && +process.env.FLICK_TEST_PORT) || 47999, '127.0.0.1');
}
