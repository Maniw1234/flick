'use strict';
// Air grab, the PC side (the phone's features/air.js picks files up with the hand over its front camera).
// Phone to PC:
//   lift (air)  the file waits at the screen's edge on the phone's side, and this PC's camera (when it has one and the
//               user lets Flick use it) starts looking for the hand
//   the hand    seen in front of the PC holding the file (a fist), the file follows it; when it opens, the phone is
//               told ('air-land') and the file lands right there
//   air-go      the phone let go: the file lands where the camera sees the hand open (within a moment), or comes in
//               from the edge as a throw does. A video that was playing carries on here from the same second.
// PC to phone:
//   air-ready   a phone has Air grab on and Flick open: selecting files on this PC (selwatch.js) turns the camera on
//               for a few seconds
//   the hand    an open hand closing into a fist in front of the screen picks the selected files up: their card
//               follows the fist, and waits at the screen's edge on the phone's side once the hand has left
//   air-catch   a fist that opened over the phone: the files it carries go there (or 'air-none')
// The camera runs in a hidden window (air/air.html) only for those few seconds (half a minute at most, 45 s in any 2
// minutes). Its pictures never leave that window: the hand tracker (the phone app's, hand/) only reports where a hand is.
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { SelWatch } = require('./selwatch');

const HAND_FILE = /^[a-z0-9-]+\.(wasm|fhm|js)$/;
const WAIT_MS = 1800;        // after the phone let go, how long the camera may still see the hand open
const SEEN_MS = 2500;        // a hand that opened this recently counts for a file the phone lets go of now
const CAM_MAX_MS = 30000;    // the camera never runs longer than this at a time
const FOLLOW_MAX_MS = 10000; // a file following a fist in front of the PC lands after this even if it never opens
const LIFT_MAX_MS = 90000;   // a file held this long without being let go of is put back
const CAM_BUDGET_MS = 45000; // the camera runs at most this long in any 2 minutes (however many grabs ask for it)
const ARM_MS = 10000;        // selecting files: the camera looks for the grab this long
const HELD_MS = 20000;       // files picked up on the PC wait this long for the phone to catch them
const HAND_MORE_MS = 4000;   // a hand in view while the camera waits for the grab: it waits this much longer
const BACK_MS = 700;         // a hand opening in front of the PC puts the files back after this, unless the phone
                             // catches them first (a phone the PC's camera sees too, under the hand)
const MIN_RUN_MS = 3000;     // less camera time than this left: it rests (a blink of its light helps no one)
const THUMB_WAIT_MS = 1500;  // the picked-up card waits at most this long for its picture
const IDLE_CLOSE_MS = 3 * 60000;

/**
 * o: { electron, store, log, fx(type, data), server, preload, appDir, isMac, overlaySize() -> {width, height},
 *      side() -> 'left'|'right', phoneScreen() -> {w, h}, land(t, msg), expire(t), sendPaths(paths, opts), thumbFor(p),
 *      kindOf(name), changed(), liftMaxMs, camMaxMs, debug, selwatch (tests: a stand-in) }
 */
function attach(o) {
  const { BrowserWindow, ipcMain, session, systemPreferences } = o.electron;
  const log = (...a) => o.log('air:', ...a);
  // the hand tracker's files: in a built app next to this file (hand/), when run from the source the phone app's
  const HAND = [path.join(o.appDir, 'hand'), path.join(o.appDir, '..', 'phone', 'hand')].find((d) => fs.existsSync(path.join(d, 'hand.js')));
  const camOn = () => o.store.airCam !== false && !!HAND;
  const CAM_RUN_MS = o.camMaxMs || CAM_MAX_MS;          // (tests shorten it)

  let win = null, ready = null, camState = 'off', idleT = null, camT = null, macAsked = false;
  // a camera Flick tried and couldn't use ('denied', 'nocamera', 'error') stays so until one works: the camera window
  // says 'off' each time it stops, and the panel and the phone still need to know why nothing is seen
  let camProblem = null;
  const camSays = () => camProblem || camState;
  const lifted = new Map();    // tid -> { t, m, at, go, landed, waitT, video, device }: files a hand carries from a phone
  let lastOpen = null;         // { x, y, at }: where the camera last saw the carrying fist open
  let hand = null;             // { x, y, pose, at }: the hand the camera sees now
  const camRuns = [];          // [from, to] (to: null while on): when the camera ran, for its budget
  function camUsed(now) {
    let ms = 0;
    for (const [a, b] of camRuns) ms += Math.max(0, (b || now) - Math.max(a, now - 120000));
    while (camRuns.length && camRuns[0][1] && camRuns[0][1] < now - 120000) camRuns.shift();
    return ms;
  }

  // PC to phone: the phones ready to catch, what's selected, and what a fist picked up
  const phones = new Set();    // devices with Air grab on and Flick open
  const G = { sel: [], armedAt: 0, armedUntil: 0, armT: null, open: false, held: null, n: 0 };
  const sel = o.selwatch || new SelWatch({ log: o.log });
  sel.on('change', (s) => onSelection(s));
  function watchSelection() {
    if (phones.size && camOn()) sel.start();
    else { sel.stop(); disarm(); }
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
    idleT = setTimeout(() => { if (!needCam() && win && !win.isDestroyed()) win.destroy(); }, IDLE_CLOSE_MS);
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
    const was = camSays();
    camState = String((d && d.state) || 'off');
    if (camState === 'on') camProblem = null;
    else if (/denied|nocamera|error/.test(camState)) { camProblem = camState; log('camera', camState, (d && d.detail) || ''); }
    if (was !== camSays() && o.changed) o.changed();     // the panel says when there's no camera Flick can use
  });
  ipcMain.on('air:event', (e, ev) => { if (win && e.sender === win.webContents && ev) onHand(ev); });

  // the camera is wanted while a hand carries a phone's file here, for a few seconds after files are selected, and
  // while a fist in view holds files it picked up
  function needCam() {
    return [...lifted.values()].some((x) => !x.landed) || Date.now() < G.armedUntil || !!(G.held && (G.held.state === 'hand' || G.held.state === 'back'));
  }

  async function startCam() {
    if (!camOn()) return false;
    // macOS asks the user once (with Info.plist's NSCameraUsageDescription); a no stays a no
    if (o.isMac && systemPreferences && systemPreferences.getMediaAccessStatus) {
      const denied = () => { if (camSays() !== 'denied') { camState = camProblem = 'denied'; if (o.changed) o.changed(); } return false; };
      const st = systemPreferences.getMediaAccessStatus('camera');
      if (st === 'denied' || st === 'restricted') return denied();
      if (st === 'not-determined') {
        if (macAsked) return false;
        macAsked = true;
        try { if (!(await systemPreferences.askForMediaAccess('camera'))) return denied(); } catch (err) { return false; }
      }
    }
    // never on for long: half a minute a run (however many grabs and selections ask for it while it's on), and at most
    // CAM_BUDGET_MS in any 2 minutes
    if (!camRunning() && camLeft() < MIN_RUN_MS) { log('camera: resting (it ran ' + Math.round(camUsed(Date.now()) / 1000) + ' s in 2 minutes)'); return false; }
    clearTimeout(idleT);
    if (!(await ensureWin())) return false;
    // (macOS' question can take a while: it may not be wanted any more)
    if (!needCam()) { closeLater(); return false; }
    const left = camLeft();
    if (left <= 0) { stopCam(); return false; }
    send('air:start');
    if (!camRunning()) camRuns.push([Date.now(), null]);
    clearTimeout(camT);
    camT = setTimeout(stopCam, left);
    return true;
  }
  const camRunning = () => camRuns.length > 0 && !camRuns[camRuns.length - 1][1];
  // how much longer the camera may run now: what's left of this run's half minute, and of the 2 minutes' budget
  function camLeft() {
    const now = Date.now();
    const run = camRunning() ? camRuns[camRuns.length - 1] : null;
    return Math.min(CAM_RUN_MS - (run ? now - run[0] : 0), CAM_BUDGET_MS - camUsed(now));
  }
  function stopCam() {
    clearTimeout(camT);
    hand = null;
    G.open = false;
    const r = camRuns[camRuns.length - 1];
    if (r && !r[1]) r[1] = Date.now();
    send('air:stop');
    closeLater();
    // files in a fist the camera can't follow any more: they wait at the edge for the phone to catch them
    if (G.held && G.held.state === 'hand') toEdge(G.held, true);
  }
  function stopCamIfIdle() { if (!needCam()) stopCam(); }

  // ---- where a hand in the camera's view is on the screen. The camera faces the user: the view is mirrored, so the
  // hand moves on the screen the way it moves in front of it. Held in front of the screen, the hand fills the middle of
  // the camera's view across, and its lower part down (the camera sits at the top of the screen); a card following
  // the fist shows where it is.
  function toScreen(pos) {
    const s = o.overlaySize();
    const cl = (v) => Math.max(0, Math.min(1, v));
    return { x: cl((pos[0] - 0.2) / 0.6) * s.width, y: cl((pos[1] - 0.3) / 0.65) * s.height };
  }
  const newest = () => { let b = null; for (const a of lifted.values()) if (!a.landed && (!b || a.at > b.at)) b = a; return b; };

  function onHand(ev) {
    const now = Date.now();
    const a = newest();
    if (o.debug && ev.type !== 'move') log('hand', ev.type, ev.pose || '', a ? a.t.tid + (a.go ? ' (let go)' : '') + (a.sawFist ? ' fist seen' : '') : G.held ? 'holding ' + G.held.state : Date.now() < G.armedUntil ? 'armed' : '-');
    if (ev.type === 'leave') hand = null;
    else if (Array.isArray(ev.pos)) { const p = toScreen(ev.pos); hand = { x: p.x, y: p.y, pose: ev.pose, at: now }; }
    if (a) onCarry(ev, a, now);         // a phone's file on its way here comes first
    else onPick(ev, now);
  }

  // ---- phone to PC: the hand carrying a phone's file
  function onCarry(ev, a, now) {
    if (ev.type === 'leave') {
      a.sawFist = 0;                                     // a hand coming back is a new one until seen as a fist
      // the fist it followed went out of view: the file goes back to waiting at the edge
      if (a.follow) { a.follow = false; o.fx('air', { tid: a.t.tid, off: true }); bob(a); }
      return;
    }
    if (!hand) return;
    const p = hand;
    if (ev.pose === 'fist') {
      a.sawFist = now;                                   // the hand carrying it, in front of this PC
      // once the phone has let go, the fist carries the file here: it follows, and lands where the hand opens
      if (a.go) {
        a.follow = true;
        a.followAt = { x: p.x, y: p.y };
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
  function peekMsg(a, bobY) {
    const m = a.m, ps = o.phoneScreen();
    const pw = m.pw || ps.w, ph = m.ph || ps.h;
    const w = m.w || 160, h = m.h || 160;
    const y0 = typeof m.y === 'number' ? Math.max(40, Math.min(ph - h - 40, m.y)) : ph / 2 - h / 2;
    const x = o.side() === 'right' ? -w * 0.32 : pw - w * 0.68;
    return { tid: a.t.tid, x, y: y0 + (bobY || 0), w, h, r: 0, s: 1.04, vx: 0, vy: 0, pw, ph };
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

  // ---- PC to phone: selecting files, picking them up, and the phone catching them
  function onSelection(s) {
    G.sel = (s && s.paths) || [];
    if (!G.sel.length || !phones.size) { disarm(); return; }
    // what was selected already when the watching started isn't a selection just made: the next one turns it on
    if (s.first) return;
    // just selected, or a window with files selected brought to the front (copied, on Linux): the camera looks for the
    // grab for a few seconds
    G.armedAt = Date.now();
    armUntil(G.armedAt + ARM_MS);
    if (o.debug) log('selected', G.sel.length, 'file(s): the camera looks for a grab');
    startCam();
  }
  function armUntil(t) {
    G.armedUntil = t;
    clearTimeout(G.armT);
    G.armT = setTimeout(stopCamIfIdle, Math.max(0, t - Date.now()) + 50);
  }
  function disarm() {
    G.armedUntil = 0;
    clearTimeout(G.armT);
    stopCamIfIdle();
  }
  function tellPhones(msg) { if (o.server) for (const d of phones) o.server.pushToPhone(msg, d); }

  function onPick(ev, now) {
    const h = G.held;
    if (ev.type === 'leave') {
      G.open = false;
      // the fist went out of view with the files: they wait at the edge on the phone's side for the phone to catch them
      if (h && h.state === 'hand') toEdge(h);
      return;
    }
    if (!hand) return;
    // a hand in view while the camera waits for the grab: a few more seconds (within the camera's half minute)
    if (!h && now < G.armedUntil) {
      const t = Math.min(G.armedAt + CAM_RUN_MS, now + HAND_MORE_MS);
      if (t > G.armedUntil + 500) armUntil(t);
    }
    if (ev.type === 'enter') G.open = ev.pose === 'open';
    if (ev.pose === 'open' && (ev.type === 'pose' || ev.type === 'enter')) {
      G.open = true;
      if (h && h.state === 'hand') backSoon(h);          // opened in front of the PC again: put back
      return;
    }
    // closed again before they were put back (or the camera took a hand opening near the phone for one in front of it)
    if (h && h.state === 'back' && ev.pose === 'fist') { clearTimeout(h.backT); h.state = 'hand'; }
    if (h && h.state === 'hand') {
      if (ev.type === 'move' || ev.type === 'pose') { h.x = hand.x; h.y = hand.y; o.fx('air-out', { id: h.id, x: hand.x, y: hand.y }); }
      return;
    }
    // the grab: an open hand closing into a fist, a moment after files were selected, with a phone ready to catch
    if (ev.type === 'pose' && ev.pose === 'fist' && G.open && now < G.armedUntil && G.sel.length && phones.size && !h) pick(hand);
  }

  async function pick(p) {
    const paths = G.sel.filter((f) => { try { fs.accessSync(f); return true; } catch (e) { return false; } }).slice(0, 100);
    if (!paths.length) return;
    const h = G.held = { id: 'air-out-' + (++G.n), paths, at: Date.now(), state: 'hand', x: p.x, y: p.y };
    armUntil(Date.now() + HELD_MS);                      // the camera keeps watching the fist (put back, or gone)
    h.expireT = setTimeout(() => { if (G.held === h) drop(h, 'not caught in time'); }, HELD_MS);
    const name = path.basename(paths[0]);
    log('picked up', paths.length, 'file(s)');
    tellPhones({ t: 'air-held', n: paths.length, name });
    let th = null;
    try {
      th = o.thumbFor ? await Promise.race([o.thumbFor(paths[0]), new Promise((r) => setTimeout(() => r(null), THUMB_WAIT_MS))]) : null;
    } catch (e) { th = null; }
    if (G.held !== h) return;                            // put back or caught while the picture was being made
    const aspect = th ? th.w / th.h : 0.72;
    const cw = 150, ch = Math.round(Math.max(110, Math.min(220, cw / Math.max(0.55, Math.min(1.8, aspect)))));
    const kind = o.kindOf ? o.kindOf(name) : 'doc';
    const ext = (/\.([^.]+)$/.exec(name) || [])[1] || '';
    // (the hand may have left the view meanwhile: the card goes straight to the edge)
    o.fx('air-out', {
      id: h.id, x: h.x, y: h.y, edge: h.state === 'edge', name: paths.length > 1 ? paths.length + ' items' : name, count: paths.length, kind,
      badge: kind === 'doc' ? (ext || 'file').toUpperCase().slice(0, 4) : '', thumb: th && th.url, card: { w: cw, h: ch },
    });
  }
  // (fromStop: the camera has just stopped)
  function toEdge(h, fromStop) {
    h.state = 'edge';
    o.fx('air-out', { id: h.id, edge: true });
    G.armedUntil = 0;
    clearTimeout(G.armT);
    if (!fromStop) stopCamIfIdle();
  }
  // opened in front of the PC: put back in a moment, unless the phone catches them first or the hand closes again
  function backSoon(h) {
    h.state = 'back';
    clearTimeout(h.backT);
    h.backT = setTimeout(() => { if (G.held === h && h.state === 'back') putBack(h); }, BACK_MS);
  }
  // (the camera stays on a moment, for a grab again)
  function putBack(h) { armUntil(Math.min(G.armedUntil, Date.now() + HAND_MORE_MS)); drop(h, 'put back'); }
  function drop(h, why) {
    clearTimeout(h.expireT);
    clearTimeout(h.backT);
    if (G.held === h) G.held = null;
    o.fx('air-out', { id: h.id, drop: true });
    tellPhones({ t: 'air-held', n: 0 });
    log('files', why);
    stopCamIfIdle();
  }

  return {
    get camState() { return camSays(); },
    get handDir() { return HAND; },
    get window() { return win; },                          // tests (main.js' test control)
    /** tests (main.js' test control): a hand event as the camera window would send it, a selection as selwatch.js would */
    testHand(ev) { onHand(ev); },
    testSelect(paths, first) { onSelection({ kind: 'folder', paths, first: !!first }); },
    get state() {
      return { phones: [...phones], armed: Date.now() < G.armedUntil, held: G.held && { n: G.held.paths.length, state: G.held.state }, sel: G.sel.length,
        watching: sel.running, cam: camRunning(), camState: camSays() };
    },

    /** a phone has Air grab on and Flick open (or not any more): selecting files here gets ready for a grab */
    phoneReady(device, on) {
      if (!device) return;
      if (on) phones.add(device); else phones.delete(device);
      watchSelection();
    },
    /** the camera setting changed (Flick's window): watching or not, and a camera that failed is tried afresh */
    settingChanged() {
      if (camProblem) { camProblem = null; if (o.changed) o.changed(); }
      watchSelection();
    },

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
      if (a.cam === false || !camOn() || /denied|nocamera|error/.test(camSays())) { land(a, null); return a.video; }
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

    /** a fist opened over the phone: the files a fist picked up here go to it */
    catchFiles(device) {
      const h = G.held;
      if (!h) {
        // nothing picked up: the phone says how (select files, or copy them on Linux), or why it can't be done here
        // (the camera off, or none Flick can use)
        const why = o.store.airCam === false ? 'camoff' : !HAND || /denied|nocamera|error/.test(camSays()) ? 'nocamera' : 'nothing';
        if (o.server) o.server.pushToPhone({ t: 'air-none', why, how: (o.platform || process.platform) === 'linux' ? 'copy' : 'select' }, device);
        log('catch: nothing picked up' + (why === 'nothing' ? '' : ' (' + why + ')'));
        return 0;
      }
      clearTimeout(h.expireT);
      clearTimeout(h.backT);
      G.held = null;
      o.fx('air-out', { id: h.id, go: true });          // the card goes into the phone
      log('caught', h.paths.length, 'file(s)');
      o.sendPaths(h.paths, { fx: false, y: h.y, device });   // to the phone that caught them
      // done: a grab again takes files selected again
      G.armedUntil = 0;
      clearTimeout(G.armT);
      stopCamIfIdle();
      return h.paths.length;
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

    stop() {
      sel.stop();
      for (const tid of [...lifted.keys()]) this.cancel(tid);
      if (G.held) drop(G.held, 'Flick closed');
      if (win && !win.isDestroyed()) win.destroy();
    },
  };
}

module.exports = { attach };
