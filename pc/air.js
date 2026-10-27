'use strict';
// Air grab, the PC side (the phone's features/air.js picks files up with the hand over its front camera):
//   lift (air)  the file waits at the screen's edge on the phone's side, and this PC's camera (when it has one and the
//               user lets Flick use it) starts looking for the hand
//   the hand    seen in front of the PC holding the file (a fist), the file follows it; when it opens, the phone is
//               told ('air-land') and the file lands right there
//   air-go      the phone let go: the file lands where the camera sees the hand open (within a moment), or comes in
//               from the edge as a throw does. A video that was playing carries on here from the same second.
//   air-catch   a fist that opened over the phone: the files copied on this PC go to it (or 'air-none')
// The camera runs in a hidden window (air/air.html) only from a lift until the file has landed (half a minute at
// most). Its pictures never leave that window: the hand tracker (the phone app's, hand/) only reports where a hand is.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { clipFiles } = require('./clipfiles');

const HAND_FILE = /^[a-z0-9-]+\.(wasm|fhm|js)$/;
const WAIT_MS = 1800;        // after the phone let go, how long the camera may still see the hand open
const SEEN_MS = 2500;        // a hand that opened this recently counts for a file the phone lets go of now
const CAM_MAX_MS = 30000;    // the camera never runs longer than this for one grab
const FOLLOW_MAX_MS = 10000; // a file following a fist in front of the PC lands after this even if it never opens
const LIFT_MAX_MS = 90000;   // a file held this long without being let go of is put back
const CAM_BUDGET_MS = 45000; // the camera runs at most this long in any 2 minutes (however many grabs ask for it)
const IDLE_CLOSE_MS = 3 * 60000;

/**
 * o: { electron, store, log, fx(type, data), server, preload, appDir, isMac, overlaySize() -> {width, height},
 *      side() -> 'left'|'right', phoneScreen() -> {w, h}, land(t, msg), expire(t), sendPaths(paths), tmpDir,
 *      changed(), clipShared() -> bool, clipFromPhone() -> Promise<bool> }
 */
function attach(o) {
  const { BrowserWindow, ipcMain, session, systemPreferences, clipboard, nativeImage } = o.electron;
  const log = (...a) => o.log('air:', ...a);
  // the hand tracker's files: in a built app next to this file (hand/), when run from the source the phone app's
  const HAND = [path.join(o.appDir, 'hand'), path.join(o.appDir, '..', 'phone', 'hand')].find((d) => fs.existsSync(path.join(d, 'hand.js')));
  const camOn = () => o.store.airCam !== false && !!HAND;

  let win = null, ready = null, camState = 'off', idleT = null, camT = null, macAsked = false;
  const lifted = new Map();    // tid -> { t, m, peek, at, go, waitT, video, device }
  let lastOpen = null;         // { x, y, at }: where the camera last saw a hand open
  let lastCatch = 0;
  let hand = null;             // { x, y, pose, at }: the hand the camera sees now
  const camRuns = [];          // [from, to] (to: null while on): when the camera ran, for its budget
  function camUsed(now) {
    let ms = 0;
    for (const [a, b] of camRuns) ms += Math.max(0, (b || now) - Math.max(a, now - 120000));
    while (camRuns.length && camRuns[0][1] && camRuns[0][1] < now - 120000) camRuns.shift();
    return ms;
  }

  // ---- the camera window
  function ensureWin() {
    if (win && !win.isDestroyed()) return ready;
    win = new BrowserWindow({
      width: 320, height: 240, show: false, frame: false, skipTaskbar: true, focusable: false, title: 'Flick Air grab',
      webPreferences: { preload: o.preload, backgroundThrottling: false, spellcheck: false },
    });
    win.setMenu(null);
    ready = new Promise((resolve) => {
      win.webContents.once('did-finish-load', () => resolve(true));
      win.webContents.once('did-fail-load', () => resolve(false));
    });
    win.loadFile(path.join(__dirname, 'air', 'air.html'), { query: { hand: pathToFileURL(HAND).href } });
    win.on('closed', () => { win = null; ready = null; camState = 'off'; });
    return ready;
  }
  function send(ch, d) { if (win && !win.isDestroyed()) win.webContents.send(ch, d); }
  function closeLater() {
    clearTimeout(idleT);
    idleT = setTimeout(() => { if (!lifted.size && win && !win.isDestroyed()) win.destroy(); }, IDLE_CLOSE_MS);
    if (idleT.unref) idleT.unref();
  }

  // only this window may use a camera (and never a microphone); every other request is answered as Electron does
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb, details) => {
    if (permission !== 'media') return cb(true);
    const types = (details && details.mediaTypes) || [];
    cb(!!(win && !win.isDestroyed() && wc === win.webContents) && !types.includes('audio'));
  });

  ipcMain.handle('air:file', (e, name) => {
    if (!win || e.sender !== win.webContents || !HAND_FILE.test(String(name))) return null;
    try { return fs.readFileSync(path.join(HAND, String(name))); } catch (err) { return null; }
  });
  ipcMain.on('air:state', (e, d) => {
    if (!win || e.sender !== win.webContents) return;
    const was = camState;
    camState = String((d && d.state) || 'off');
    if (/denied|nocamera|error/.test(camState)) log('camera', camState, (d && d.detail) || '');
    if (was !== camState && o.changed) o.changed();     // the panel says when there's no camera Flick can use
  });
  ipcMain.on('air:event', (e, ev) => { if (win && e.sender === win.webContents && ev) onHand(ev); });

  async function startCam() {
    if (!camOn()) return false;
    // macOS asks the user once (with Info.plist's NSCameraUsageDescription); a no stays a no
    if (o.isMac && systemPreferences && systemPreferences.getMediaAccessStatus) {
      const denied = () => { if (camState !== 'denied') { camState = 'denied'; if (o.changed) o.changed(); } return false; };
      const st = systemPreferences.getMediaAccessStatus('camera');
      if (st === 'denied' || st === 'restricted') return denied();
      if (st === 'not-determined') {
        if (macAsked) return false;
        macAsked = true;
        try { if (!(await systemPreferences.askForMediaAccess('camera'))) return denied(); } catch (err) { return false; }
      }
    }
    // never on for long: however many grabs ask for it, at most CAM_BUDGET_MS in any 2 minutes
    if (camUsed(Date.now()) >= CAM_BUDGET_MS) { log('camera: resting (it ran ' + Math.round(camUsed(Date.now()) / 1000) + ' s in 2 minutes)'); stopCam(); return false; }
    clearTimeout(idleT);
    if (!(await ensureWin())) return false;
    // (macOS' question can take a while: the file may have landed meanwhile)
    if (![...lifted.values()].some((x) => !x.landed)) { closeLater(); return false; }
    send('air:start');
    if (!camRuns.length || camRuns[camRuns.length - 1][1]) camRuns.push([Date.now(), null]);
    clearTimeout(camT);
    camT = setTimeout(stopCam, Math.max(1000, Math.min(CAM_MAX_MS, CAM_BUDGET_MS - camUsed(Date.now()))));
    return true;
  }
  function stopCam() {
    clearTimeout(camT);
    hand = null;
    const r = camRuns[camRuns.length - 1];
    if (r && !r[1]) r[1] = Date.now();
    send('air:stop');
    closeLater();
  }
  function stopCamIfIdle() { if (![...lifted.values()].some((a) => !a.landed)) stopCam(); }

  // ---- where a hand in the camera's view is on the screen. The camera faces the user: the view is mirrored, so the
  // hand moves on the screen the way it moves in front of it. Held in front of the screen, the hand fills the middle of
  // the camera's view across, and its lower part down (the camera sits at the top of the screen); a card following
  // the fist shows where it will land.
  function toScreen(pos) {
    const s = o.overlaySize();
    const cl = (v) => Math.max(0, Math.min(1, v));
    return { x: cl((pos[0] - 0.2) / 0.6) * s.width, y: cl((pos[1] - 0.3) / 0.65) * s.height };
  }
  const newest = () => { let b = null; for (const a of lifted.values()) if (!a.landed && (!b || a.at > b.at)) b = a; return b; };

  function onHand(ev) {
    const now = Date.now();
    const a = newest();
    if (o.debug && ev.type !== 'move') log('hand', ev.type, ev.pose || '', a ? a.t.tid + (a.go ? ' (let go)' : '') + (a.sawFist ? ' fist seen' : '') : '-');
    if (ev.type === 'leave') {
      hand = null;
      if (!a) return;
      a.sawFist = 0;                                     // a hand coming back is a new one until seen as a fist
      // the fist it followed went out of view: the file goes back to waiting at the edge
      if (a.follow) { a.follow = false; o.fx('air', { tid: a.t.tid, off: true }); bob(a); }
      return;
    }
    if (!Array.isArray(ev.pos)) return;
    const p = toScreen(ev.pos);
    hand = { x: p.x, y: p.y, pose: ev.pose, at: now };
    if (!a) return;
    if (ev.pose === 'fist') {
      a.sawFist = now;                                   // the hand carrying it, in front of this PC
      // once the phone has let go, the fist carries the file here: it follows, and lands where the hand opens
      if (a.go) {
        a.follow = true;
        a.followAt = p;
        o.fx('air', { tid: a.t.tid, x: p.x, y: p.y });
        clearTimeout(a.waitT);
        a.waitT = setTimeout(() => land(a, a.follow ? a.followAt : null), WAIT_MS);
      }
      return;
    }
    if (ev.pose !== 'open' || (ev.type !== 'pose' && ev.type !== 'enter')) return;
    // once the phone has let go, a hand opening (or coming into view open) picks where it lands
    if (a.go) { lastOpen = { x: p.x, y: p.y, at: now }; land(a, p); return; }
    // before that, only the fist this camera saw (without it leaving the view) opening tells the phone to let go:
    // another hand, or one never seen closed, sends nothing
    if (ev.type !== 'pose' || !a.sawFist) return;
    lastOpen = a.landAt = { x: p.x, y: p.y, at: now };
    if (o.server) o.server.pushToPhone({ t: 'air-land', tid: a.t.tid }, a.device);
  }

  // the file waits at the edge (a third of it in view), bobbing a little
  function peekMsg(a, bob) {
    const m = a.m, ps = o.phoneScreen();
    const pw = m.pw || ps.w, ph = m.ph || ps.h;
    const w = m.w || 160, h = m.h || 160;
    const y0 = typeof m.y === 'number' ? Math.max(40, Math.min(ph - h - 40, m.y)) : ph / 2 - h / 2;
    const x = o.side() === 'right' ? -w * 0.32 : pw - w * 0.68;
    return { tid: a.t.tid, x, y: y0 + (bob || 0), w, h, r: 0, s: 1.04, vx: 0, vy: 0, pw, ph };
  }
  function bob(a) {
    clearInterval(a.bobT);
    const t0 = Date.now();
    a.bobT = setInterval(() => {
      if (a.landed || a.follow || !lifted.has(a.t.tid)) { clearInterval(a.bobT); return; }
      a.t.seen = Date.now();                             // held by a hand: not a drag the phone forgot (main.js)
      o.fx('move', peekMsg(a, Math.sin((Date.now() - t0) / 210) * 5));
    }, 60);
  }
  function forget(a) {
    clearTimeout(a.waitT);
    clearTimeout(a.maxT);
    clearTimeout(a.expireT);
    clearInterval(a.bobT);
    lifted.delete(a.t.tid);
  }

  function land(a, p) {
    if (a.landed) return;
    a.landed = true;
    forget(a);
    const peek = peekMsg(a);
    const dir = o.side() === 'right' ? -1 : 1;
    o.land(a.t, Object.assign(peek, { vx: dir * (p ? 1.6 : 2.6), vy: 0 }, p ? { land: { x: p.x, y: p.y } } : {}));
    stopCamIfIdle();
  }

  return {
    get camState() { return camState; },
    get handDir() { return HAND; },
    get window() { return win; },                          // tests (main.js' test control)
    /** tests (main.js' test control): a hand event as the camera window would send it */
    testHand(ev) { onHand(ev); },

    /** a file picked up by a hand over the phone */
    lifted(t, m) {
      const old = lifted.get(t.tid);
      if (old) forget(old);
      const a = { t, m, at: Date.now(), go: false, landed: false, device: m.device };
      lifted.set(t.tid, a);
      o.fx('move', peekMsg(a));
      bob(a);
      // held on to for very long: put back (the phone is told)
      a.expireT = setTimeout(() => { if (!a.go && lifted.get(t.tid) === a) { forget(a); stopCamIfIdle(); if (o.expire) o.expire(a.t); } }, o.liftMaxMs || LIFT_MAX_MS);
      startCam().then((ok) => { a.cam = ok; if (a.go && !a.landed && !ok) land(a, null); }, () => { a.cam = false; });
    },

    /** the phone let it go: it lands where the hand opens (seen now or within a moment), or comes in from the edge */
    go(t, m) {
      let a = lifted.get(t.tid);
      if (!a) { a = { t, m: Object.assign({}, m), at: Date.now(), device: m.device }; lifted.set(t.tid, a); }
      clearTimeout(a.expireT);
      a.go = true;
      a.goAt = Date.now();
      a.video = m.video && Number.isFinite(+m.video.t) ? { t: Math.max(0, +m.video.t) } : null;
      const now = Date.now();
      // where the hand opened (just now, or a moment ago), or an open hand the camera sees right now
      const seen = (a.landAt && now - a.landAt.at < SEEN_MS && a.landAt) || (lastOpen && lastOpen.at > a.at && now - lastOpen.at < 900 && lastOpen)
        || (hand && hand.pose === 'open' && now - hand.at < 600 && hand);
      if (seen) { land(a, seen); return a.video; }
      // no camera to see the hand: in from the edge now; otherwise the hand has a moment to reach the PC and open
      if (a.cam === false || !camOn() || /denied|nocamera|error/.test(camState)) { land(a, null); return a.video; }
      a.waitT = setTimeout(() => land(a, null), WAIT_MS);
      a.maxT = setTimeout(() => land(a, a.follow ? a.followAt : null), FOLLOW_MAX_MS);   // a fist that never opens
      return a.video;
    },

    cancel(tid) {
      const a = lifted.get(tid);
      if (!a) return;
      forget(a);
      stopCamIfIdle();
    },

    /** a fist opened over the phone: the files copied here go to it (one catch every 2 seconds at most) */
    async catchFiles(device) {
      const now = Date.now();
      if (now - lastCatch < 2000) return 0;
      lastCatch = now;
      const none = (why) => { if (o.server) o.server.pushToPhone({ t: 'air-none', why }, device); log('catch: ' + (why === 'off' ? 'Clipboard sync is off' : 'nothing copied')); return 0; };
      // the clipboard is shared with phones only while Clipboard sync is on (Flick's window, Phone features)
      if (o.clipShared && !o.clipShared()) return none('off');
      // what a phone put on the clipboard (Clipboard sync) isn't something the user copied here
      if (o.clipFromPhone && (await o.clipFromPhone())) return none('empty');
      let paths = await clipFiles();
      if (!paths.length) paths = await clipPicture();
      if (!paths.length) return none('empty');
      log('catch', paths.length, 'file(s)');
      o.sendPaths(paths);
      return paths.length;
    },

    /** a video that was playing on the phone, received here: it carries on from that second in a window of its own */
    playAt(file, t, fallback) {
      const p = new BrowserWindow({
        width: 960, height: 540, show: false, backgroundColor: '#000000', title: path.basename(file), autoHideMenuBar: true,
        webPreferences: { preload: o.preload, spellcheck: false },
      });
      p.setMenu(null);
      const giveUp = setTimeout(() => done({ error: true }), 5000);
      function done(d) {
        clearTimeout(giveUp);
        if (p.isDestroyed()) return;
        if (d.error || !d.w || !d.h) { p.destroy(); log('player: the PC\'s own player opens it'); if (fallback) fallback(); return; }
        // as large as the video, within 70% of the screen it opens on
        const wa = o.electron.screen.getDisplayNearestPoint(o.electron.screen.getCursorScreenPoint()).workArea;
        const k = Math.min(1, (wa.width * 0.7) / d.w, (wa.height * 0.7) / d.h);
        const w = Math.max(320, Math.round(d.w * k)), h = Math.max(180, Math.round(d.h * k));
        p.setContentSize(w, h);
        p.setBounds({ x: Math.round(wa.x + (wa.width - p.getBounds().width) / 2), y: Math.round(wa.y + (wa.height - p.getBounds().height) / 2) });
        p.show();
        p.focus();
        log('player shows', path.basename(file), 'from', Math.round((+t || 0) * 10) / 10);
      }
      p.webContents.on('ipc-message', (_e, ch, d) => { if (ch === 'air:player') done(d || {}); });
      p.loadFile(path.join(__dirname, 'air', 'player.html'), { query: { src: pathToFileURL(file).href, t: String(Math.max(0, +t || 0)), name: path.basename(file) } });
    },

    stop() { for (const tid of [...lifted.keys()]) this.cancel(tid); if (win && !win.isDestroyed()) win.destroy(); },
  };

  // a picture copied on its own (a screenshot, an image copied from a page): saved as a PNG to send
  async function clipPicture() {
    try {
      let png = null;
      if (typeof clipboard.read === 'function' && typeof clipboard.has === 'function') {
        if (await clipboard.has('image/png')) {
          for (const it of (await clipboard.read()) || []) {
            if (!(it.types || []).includes('image/png')) continue;
            const b = await it.getType('image/png');
            png = Buffer.isBuffer(b) ? b : Buffer.from(await b.arrayBuffer());
            break;
          }
        }
      } else if (typeof clipboard.readImage === 'function') {
        const img = clipboard.readImage();
        if (img && !img.isEmpty()) png = img.toPNG();
      }
      if (!png || !png.length) return [];
      const dir = path.join(o.tmpDir || os.tmpdir(), 'flick-air');
      fs.mkdirSync(dir, { recursive: true });
      for (const f of fs.readdirSync(dir)) { try { const p = path.join(dir, f); if (Date.now() - fs.statSync(p).mtimeMs > 86400000) fs.unlinkSync(p); } catch (e) { /* ignore */ } }
      const d = new Date(), two = (n) => String(n).padStart(2, '0');
      const name = `Copied picture ${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}.${two(d.getMinutes())}.${two(d.getSeconds())}.png`;
      const p = path.join(dir, name);
      fs.writeFileSync(p, png);
      return [p];
    } catch (e) { log('clipboard picture', e.message); return []; }
  }
}

module.exports = { attach };
