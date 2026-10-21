'use strict';
const { app, BrowserWindow, Tray, Menu, nativeImage, screen, ipcMain, desktopCapturer, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile, spawn } = require('child_process');
const { FlickServer, lanAddresses, rid } = require('./server');
const { apkInfoAsync } = require('./apkinfo');
const tlscert = require('./tlscert');
const { Updater } = require('./updater');

const VERSION = require('./package.json').version;
const IS_WIN = process.platform === 'win32';
const HIDDEN_START = process.argv.includes('--hidden');
// The test control server runs arbitrary JS in a window, so it must never be reachable in a shipped build, even if
// someone sets the env var: a packaged app refuses it outright.
const TEST_MODE = process.env.FLICK_TEST === '1' && !app.isPackaged;

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
  id: null, name: null, side: 'right', anchor: 0.5, size: 1, saveDir: 'desktop', sound: true,
  startup: true, edgeSend: true, devices: {}, firstRun: true, displayId: null, theme: 'roadster',
  openAfter: false, showSpeed: true, sendTo: true, autoUpdate: true, bluetooth: false, quickShare: false,
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
    const genericHost = !host || /^(DESKTOP|LAPTOP|WIN|PC)-[A-Z0-9]{5,}$/i.test(host);
    const fallback = looksLikeName ? first(user) + "'s PC" : (!genericHost ? host : (user ? first(user) + "'s PC" : 'My PC'));
    if (!IS_WIN || !user) return resolve(fallback);
    execFile('net', ['user', os.userInfo().username], { windowsHide: true, timeout: 4000 }, (err, out) => {
      if (err || !out) return resolve(fallback);
      // value must be on the same line (an empty "Full Name" used to swallow the next line, e.g. "Comment")
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
    webPreferences: { preload: PRELOAD, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required', spellcheck: false },
  });
  overlay.setAlwaysOnTop(true, 'screen-saver');
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
// night grading), while the overlay is still hidden so it can never photograph itself.
const SHOT_FIRST = { lift: true, hold: true, outgoing: true, demo: true, 'edge-hover': true, preview: true, connect: true };
// once the overlay hides, its desktop photo is out of date: drop it so no later effect paints an old screen
function dropShot() { lastShot = 0; if (overlay) overlay.webContents.send('fx:noshot'); }
let revealT = null;
function reveal() {
  clearTimeout(revealT); revealT = null;
  if (!overlay || overlayShown) return;
  overlay.setBounds(overlayBounds());
  overlay.showInactive();
  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlayShown = true;
}
function ensureShown(withShot) {
  if (!overlay || overlayShown || revealT) return;
  if (withShot && Date.now() - lastShot > 1500) {
    // photograph the desktop first and only then show the overlay, so the picture never contains the overlay itself;
    // a very slow capture is abandoned (the effects then run without it) rather than holding the animation back
    let done = false;
    const go = () => { if (done) return; done = true; reveal(); };
    revealT = setTimeout(() => { shotAbandoned = true; go(); }, 1100);
    shotAbandoned = false;
    captureShot().then(go, go);
  } else reveal();
}
let lastFx = 0;
function fx(type, data) {
  if (!overlay) return;
  lastFx = Date.now();
  overlay.webContents.send('fx:' + type, data);
  ensureShown(!!SHOT_FIRST[type]);
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
    } else if (t.state === 'dropped' && t.upload !== 'done' && quiet > 45000) {
      log('transfer', t.tid, 'stalled for', Math.round(quiet / 1000) + 's: fail');
      if (t.qs && qs) { qs.cancel(t.tid.slice(3), 'stalled'); if (!transfers.has(t.tid)) continue; }   // its failure path cleans up
      fx('failed', { tid: t.tid });
      if (!t.qs && server) { server.pushToPhone({ t: 'failed', tid: t.tid, why: 'stalled' }); server.abortUpload(t.tid); }
      clearTimeout(t.failT);
      discard(t);
    }
  }
  const active = [...transfers.values()].some((t) => !t.done && (t.state === 'lifted' || t.state === 'dropped'));
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
    if (IS_WIN && (kind === 'image' || kind === 'video' || extOf(p) === 'pdf')) {
      const t = await nativeImage.createThumbnailFromPath(p, { width: 360, height: 360 });
      if (t && !t.isEmpty()) return { url: 'data:image/jpeg;base64,' + t.toJPEG(82).toString('base64'), w: t.getSize().width, h: t.getSize().height };
    }
  } catch (e) { /* no thumb */ }
  return null;
}

ipcMain.on('catcher:drop', async (_e, d) => {
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

async function sendPathsToPhone(list, screenY) {
  if (!server || !server.connected) return 0;
  const paths = expandPaths(list);
  if (!paths.length) return 0;
  const sy = typeof screenY === 'number' ? screenY : overlayBounds().y + store.anchor * overlayBounds().height;
  let oy = overlayYFromScreenY(sy);
  const shown = Math.min(paths.length, 12);        // the first dozen fly across the screen; the rest just go
  for (let i = 0; i < paths.length; i++) {
    const p = paths[i];
    const name = path.basename(p);
    const mime = MIME[extOf(name)] || 'application/octet-stream';
    const offer = server.offerFile(p, mime);
    // only the cards that fly across the screen need a picture (the phone makes its own once a file has arrived).
    // Thumbnails decode on this thread, so let downloads and messages run between files.
    const th = i < shown ? await thumbFor(p) : null;
    await new Promise((r) => setImmediate(r));
    const ext = extOf(name);
    const kind = kindOf(name);
    const aspect = th ? th.w / th.h : 0.72;
    const cw = 150, ch = Math.round(Math.max(110, Math.min(220, cw / Math.max(0.55, Math.min(1.8, aspect)))));
    const y = oy + Math.min(i, shown) * 22;
    if (i < shown) fx('outgoing', { fid: offer.fid, name, thumb: th && th.url, kind, badge: kind === 'doc' ? (ext || 'file').toUpperCase().slice(0, 4) : '', y, card: { w: cw, h: ch } });
    server.pushToPhone({
      t: 'incoming', fid: offer.fid, name, size: offer.size, mime, kind, ext,
      thumb: th && th.url, aspect, y: phoneYFromOverlayY(y), url: '/api/file/' + encodeURIComponent(offer.fid), delay: Math.min(i, shown) * 90,
    });
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
ipcMain.on('panel:qs-answer', (_e, { id, accept }) => answerQs(id, !!accept));
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
  if (tid && transfers.get(tid)) { fx('failed', { tid }); transfers.delete(tid); }
}

// Explorer's right-click "Send to" menu gets "Flick (phone)" (a shortcut that starts Flick with --send <files>)
function sendToShortcut() { return path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'SendTo', 'Flick (phone).lnk'); }
function applySendTo() {
  if (!IS_WIN) return;
  const lnk = sendToShortcut();
  try {
    if (store.sendTo) {
      shell.writeShortcutLink(lnk, fs.existsSync(lnk) ? 'replace' : 'create', {
        target: process.execPath, args: '--send', description: 'Send to your phone with Flick', icon: process.execPath, iconIndex: 0,
      });
    } else if (fs.existsSync(lnk)) fs.unlinkSync(lnk);
  } catch (e) { log('send-to shortcut', e.message); }
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
function createPanel() {
  const wa = screen.getPrimaryDisplay().workArea;
  const W = 420, H = 680;
  panel = new BrowserWindow({
    width: W, height: H, x: wa.x + wa.width - W - 16, y: wa.y + wa.height - H - 16,
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
  const wa = screen.getPrimaryDisplay().workArea;
  const [W, H] = panel.getSize();
  panel.setPosition(wa.x + wa.width - W - 16, wa.y + wa.height - H - 16);
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
    sound: store.sound, startup: store.startup, edgeSend: store.edgeSend, isWin: IS_WIN, theme: themeName(),
    openAfter: store.openAfter, showSpeed: store.showSpeed, sendTo: store.sendTo, autoUpdate: store.autoUpdate,
    bluetooth: store.bluetooth, btState: btState, quickShare: store.quickShare, qsState: qsState,
    via: s && s.connected ? s.via || '' : '',
    devices: Object.entries(store.devices || {}).map(([id, d]) => ({ id, name: d.name, added: d.added })),
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

ipcMain.on('panel:set', (_e, { key, value }) => {
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

ipcMain.on('panel:action', async (_e, { what, arg }) => {
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

ipcMain.on('panel:pair-answer', (_e, { device, allow }) => {
  if (!server) return;
  if (allow) server.approve(device); else server.deny(device);
});

ipcMain.on('panel:preview', (_e, d) => sendPreview(!!(d && d.on)));

function fixFirewall() {
  if (!IS_WIN) return;
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
  if (!IS_WIN || !app.isPackaged) return;
  try { app.setLoginItemSettings({ openAtLogin: !!store.startup, path: process.execPath, args: ['--hidden'], name: 'Flick' }); } catch (e) { log('startup failed', e.message); }
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
    { label: 'Open Flick', click: showPanel },
    { label: `Open ${saveDirLabel()}`, click: () => shell.openPath(saveDirPath()) },
    { type: 'separator' },
    { label: 'Quit Flick', click: () => { app.isQuitting = true; app.quit(); } },
  ]));
}
function createTray() {
  const img = nativeImage.createFromPath(path.join(__dirname, 'assets', IS_WIN ? 'tray.ico' : 'tray.png'));
  tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img);
  tray.on('click', togglePanel);
  tray.on('double-click', showPanel);
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

let appScan = null;
async function refreshPhoneApp(always) {
  if (!server) return;
  while (appScan) await appScan;
  appScan = scanPhoneApps().catch((e) => { log('phone app scan failed', e.message); return null; });
  const best = await appScan;
  appScan = null;
  const prev = server.phoneApp;
  if ((!prev) !== (!best) || (prev && best && (prev.sha256 !== best.sha256 || prev.path !== best.path))) {
    log('phone app', best ? `${best.name} (${best.code}) ${best.path}` : 'none');
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
    const busy = moving || queued || (server && server.outgoingBusy()) || overlayShown || (panel && panel.isVisible() && panel.isFocused());
    if (busy) { restartT = setTimeout(tryNow, 30000); return; }
    log('restarting into', ver);
    // only --hidden: the original command line may hold "--send <files>" from Explorer, which must not be sent again
    const args = ['--hidden'];
    app.relaunch({ args });
    app.isQuitting = true;
    app.quit();
  };
  restartT = setTimeout(tryNow, TEST_MODE ? 1500 : 5000);
}

function startUpdater() {
  updater = new Updater({
    version: VERSION, electron: process.versions.electron, log,
    fetch: (url, opts) => require('electron').net.fetch(url, opts),
  });
  if (BOOT && BOOT.failed) log('downloaded version failed to load, using the installed one:', BOOT.failed);
  log('running', VERSION, BOOT && BOOT.dir ? 'from ' + BOOT.root + '\\' + BOOT.dir : '(installed copy)');
  setTimeout(() => { healthy = true; updater.markHealthy(BOOT); }, TEST_MODE ? 4000 : 6000);
  setTimeout(runUpdateCheck, TEST_MODE ? 6000 : 20000);
  setInterval(runUpdateCheck, 30 * 60 * 1000);
}

// ------------------------------------------------------------ transfers (phone -> PC)
const transfers = new Map(); // tid -> state
const gone = new Map();      // tid -> when it was canceled: late events for it are ignored
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
const riskyExt = (p) => RISKY_EXT.has(path.extname(p).toLowerCase());

function markOfWeb(dest) {
  if (!IS_WIN) return;
  fs.writeFile(dest + ':Zone.Identifier', '[ZoneTransfer]\r\nZoneId=3\r\n', () => {});
}

// mark a received file, or every file inside a received folder (bounded, best-effort)
function markTree(dest) {
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
        placed.push(path.basename(dest));
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

async function finalize(t) {
  if (t.done) return;
  t.done = true;
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
    log('saved', dest);
    if (store.openAfter) setTimeout(() => openAfterArrival(dest), 900);
    fx('saved', { tid: t.tid, name: path.basename(dest), where: saveDirLabel() });
    if (server) server.pushToPhone({ t: 'saved', tid: t.tid, name: path.basename(dest), where: saveDirLabel() });
  } catch (e) {
    log('finalize failed', e.message);
    release(dest);
    if (t.tmpPath) fs.rm(t.tmpPath, { recursive: true, force: true }, () => {});   // don't leave the received copy in temp
    fx('failed', { tid: t.tid });
    if (server) server.pushToPhone({ t: 'failed', tid: t.tid, why: 'save' });
  }
  setTimeout(() => transfers.delete(t.tid), 5000);
}

function discard(t) {
  if (t.tmpPath && t.bundle) fs.rm(t.tmpPath, { recursive: true, force: true }, () => {});
  else if (t.tmpPath) fs.unlink(t.tmpPath, () => {});
  transfers.delete(t.tid);
}

function wireServer() {
  server.on('log', (m) => log(m));
  server.on('phone-hello', (s) => { log('hello', s.name, s.address, 'app', s.appName || 'before 1.4'); pushPanelState(); });
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
    for (const t of transfers.values()) if (t.state === 'lifted') { fx('cancel', { tid: t.tid }); discard(t); }
  });
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
    t.state = 'lifted';
    t.seen = Date.now();
    fx('lift', liftInfo(m, t));
  });
  server.on('move', (m) => { const t = transfers.get(m.tid); if (t) t.seen = Date.now(); fx('move', m); });
  server.on('drop', (m) => {
    const t = tState(m.tid);
    t.state = 'dropped';
    t.seen = Date.now();
    fx('drop', m);
    if (t.upload === 'done') finalize(t);
    clearTimeout(t.timer);   // a dropped transfer now lives as long as bytes keep arriving (see watchdog)
  });
  server.on('send', (m) => { // programmatic send (from the phone menu): fly in from the phone edge
    const t = tState(m.tid);
    t.name = (m.file && m.file.name) || t.name;
    t.state = 'dropped';
    const ps = { w: m.pw || phoneScreen().w, h: m.ph || phoneScreen().h };
    const w = m.w || 160, h = m.h || 160;
    fx('lift', Object.assign(liftInfo(m, t), { card: { w, h } }));
    const x = store.side === 'right' ? -w * 0.55 : ps.w - w * 0.45;
    setTimeout(() => fx('drop', { tid: m.tid, x, y: ps.h / 2 - h / 2, w, h, r: 0, vx: store.side === 'right' ? -2.6 : 2.6, vy: 0, pw: ps.w, ph: ps.h }), 140);
    if (t.upload === 'done') finalize(t);
  });
  server.on('cancel', (m) => {
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
  server.on('upload-start', ({ tid, name }) => {
    if (isGone(tid)) { server.abortUpload(tid); return; }
    const t = tState(tid);
    t.upload = 'uploading'; t.seen = Date.now();
    clearTimeout(t.failT);
    if (name && t.name === 'file') t.name = name;
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
  server.on('bundle-manifest', ({ tid, files, bytes }) => {
    fx('info', { tid, size: bytes, files });
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
      if (t.state === 'dropped') { fx('failed', { tid }); server.pushToPhone({ t: 'failed', tid, why: 'upload' }); }
      else if (t.state === 'lifted') fx('cancel', { tid });
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
  try { server && server.stop(); } catch (e) { /* ignore */ }
});

// Leftovers from a crash or power cut (half-received files, staging folders) in Flick's own temp folders.
// Nothing can be in flight at startup, so anything older than a few minutes goes.
function sweepTemp() {
  const now = Date.now();
  for (const dir of [path.join(app.getPath('temp'), 'flick-incoming'), path.join(app.getPath('temp'), 'flick-quickshare')]) {
    fs.readdir(dir, (e, names) => {
      if (e) return;
      for (const n of names) {
        const full = path.join(dir, n);
        fs.stat(full, (er, st) => { if (!er && now - st.mtimeMs > 10 * 60000) fs.rm(full, { recursive: true, force: true }, () => {}); });
      }
    });
  }
  fs.readdir(app.getPath('userData'), (e, names) => {
    if (!e) for (const n of names) if (/^flick-fw-.*\.cmd$/.test(n)) fs.unlink(path.join(app.getPath('userData'), n), () => {});
  });
}

app.whenReady().then(async () => {
  sweepTemp();
  // 1.0.0 could name the PC "Comment's PC" (Windows account without a full name): fix it automatically
  if (!store.name || store.name === "Comment's PC") { store.name = await defaultName(); saveStore(); }
  // this PC's certificate (made the first time): phones from 1.9 on talk to it only over links encrypted with it
  const tlsId = tlscert.ensure(app.getPath('userData'), 'Flick ' + store.id);
  if (!tlsId) log('no certificate: encrypted links are off');
  server = new FlickServer({
    id: store.id, name: store.name, port: 47860, discoveryPort: 47870, version: VERSION,
    tmpDir: path.join(app.getPath('temp'), 'flick-incoming'), devices: store.devices,
    settings: { side: store.side, anchor: store.anchor, theme: themeName() },
    allowOrigin: TEST_MODE ? /^http:\/\/127\.0\.0\.1:\d+$/ : null,   // test harnesses serve the phone page over http
    tls: tlsId,
  });
  wireServer();
  try { const port = await server.start(); log('listening', port, lanAddresses().map((a) => a.address).join(',')); }
  catch (e) { log('server failed', e.message); dialog.showErrorBox('Flick', 'Flick could not start its connection service.\n\n' + e.message); }
  refreshPhoneApp();
  startUpdater();

  createOverlay();
  createTray();
  applyStartup();
  screen.on('display-metrics-changed', () => { placeOverlay(); ensureCatcher(); });
  screen.on('display-added', () => { placeOverlay(); ensureCatcher(); });
  screen.on('display-removed', () => { placeOverlay(); ensureCatcher(); });

  applySendTo();
  applyBluetooth();
  applyQuickShare();
  const startFiles = sendArgs(process.argv);
  if (startFiles.length) setTimeout(() => queueForPhone(startFiles), 1500);
  else if (!HIDDEN_START || store.firstRun) showPanel();
  if (TEST_MODE) startTestControl();
});

// ------------------------------------------------------------ test-only control port (never enabled in normal use)
function startTestControl() {
  require('http').createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    try {
      if (u.pathname === '/capture') {
        const w = u.searchParams.get('w') === 'panel' ? panel : overlay;
        const img = await w.webContents.capturePage();
        fs.writeFileSync(u.searchParams.get('out'), img.toPNG());
        return res.end('ok');
      }
      if (u.pathname === '/state') {
        return res.end(JSON.stringify({
          overlayShown, overlayReady, connected: !!(server && server.connected),
          transfers: [...transfers.values()].map((t) => ({ tid: t.tid, state: t.state, upload: t.upload, done: !!t.done })),
          panel: !!(panel && panel.isVisible()), catcher: !!catcher, catcherBounds: catcher && catcher.getBounds(),
          overlayBounds: overlay && overlay.getBounds(), saveDir: saveDirPath(), name: server && server.name,
          version: VERSION, boot: BOOT, update: updateInfo, qsPort: qs && qs.port, qsState, btState,
        }));
      }
      if (u.pathname === '/eval') {
        const w = u.searchParams.get('w') === 'panel' ? panel : overlay;
        const r = await w.webContents.executeJavaScript(u.searchParams.get('js'));
        return res.end(JSON.stringify(r));
      }
      if (u.pathname === '/set') {
        ipcMain.emit('panel:set', {}, { key: u.searchParams.get('key'), value: u.searchParams.get('value') });
        return res.end('ok');
      }
      if (u.pathname === '/action') {
        const arg = u.searchParams.get('arg');
        ipcMain.emit('panel:action', {}, { what: u.searchParams.get('what'), arg: arg ? JSON.parse(arg) : undefined });
        return res.end('ok');
      }
      if (u.pathname === '/catcher-drop') {
        ipcMain.emit('catcher:drop', {}, { paths: [u.searchParams.get('path')], y: +(u.searchParams.get('y') || 300) });
        return res.end('ok');
      }
      if (u.pathname === '/pair') {
        const dev = u.searchParams.get('device');
        if (u.searchParams.get('allow') === '1') server.approve(dev); else server.deny(dev);
        return res.end('ok');
      }
      res.statusCode = 404; res.end();
    } catch (e) { res.statusCode = 500; res.end(String(e && e.stack)); }
  }).listen(47999, '127.0.0.1');
}
