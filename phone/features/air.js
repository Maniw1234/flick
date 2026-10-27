/* Air grab: pick files up with your hand and send them to the PC, seen by the front camera.
 * Hold your open hand over the phone and the file under it lights up. Pinch (thumb and index) to select it; keep the
 * pinch and move to select more. Make a fist to grab: the file open full screen, else the selection, else the file
 * that is lit up. Their upload starts at once. Take the fist away toward the PC and they go: they land where the PC's
 * camera sees your hand open, or come in from the screen's edge on a PC without one. Opening your hand over the phone
 * again puts them back. The other way round: with this on and Flick open, select files on the PC (copy them, on Linux),
 * close your open hand into a fist in front of its screen, then bring it over the phone and open it.
 * The camera runs only while this is on (Settings), Flick is open on screen and a PC is connected. The hand tracking
 * runs on the phone (phone/hand/: MediaPipe's hand models on Flick's own engine); no picture leaves the phone. */
(window.FlickFeatures = window.FlickFeatures || []).push(function (A, X) {
  'use strict';
  if (!A.has('cameraState')) return;                     // a phone app without the camera bridge
  const h = X.h;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const BASE = 'https://flick.local/hand/';              // served by the app: a file:// page can't fetch files
  const FILES = ['hand-simd.wasm', 'hand.wasm', 'palm.fhm', 'landmark.fhm'];
  const AIR_PROTO = 8;                                    // PCs that know Air grab
  const camOk = () => A.nc('cameraState') === 'granted';

  let on = A.pref.get('air', '') === '1';
  let paused = false;                                     // Flick is in the background
  let cam = null, stream = null, building = null, camState = 'off', deniedSaid = false;

  // ---- what you see: a soft spot where the hand is, a light on the file under it, what the fist carries
  const layer = h('div', 'airlayer');
  const spot = h('div', 'airspot');
  const held = h('div', 'airheld');
  spot.hidden = held.hidden = true;
  layer.append(spot, held);
  document.body.appendChild(layer);
  let hovered = null, hoveredEl = null;

  // the middle of the camera's view covers the screen (a little lower: the camera sits at the top of the phone)
  const toScreen = (p) => [clamp((p[0] - 0.15) / 0.7, 0, 1) * innerWidth, clamp((p[1] - 0.2) / 0.7, 0, 1) * innerHeight];
  // el's centre at (x, y)
  function place(el, x, y, s) { el.style.transform = 'translate3d(' + x.toFixed(1) + 'px,' + y.toFixed(1) + 'px,0)' + (s ? ' scale(' + s.toFixed(3) + ')' : ''); }
  const cardEl = (id) => document.querySelector('.card[data-id="' + (window.CSS && CSS.escape ? CSS.escape(String(id)) : String(id).replace(/["\\]/g, '\\$&')) + '"]');
  function setHover(it) {
    if (it === hovered) return;
    if (hoveredEl) hoveredEl.classList.remove('airhov');
    hovered = it;
    hoveredEl = it ? cardEl(it.id) : null;
    if (hoveredEl) hoveredEl.classList.add('airhov');
  }
  const preview = () => (X.preview && X.preview.open() ? X.preview.item() : null);
  const isSel = (it) => A.selecting && A.selected().some((x) => x.id === it.id);
  // the file grid is on screen with nothing over it (Settings, a sheet, a full page)
  function gridFree() {
    if (A.st.screen !== 'main' || A.sheetOpen) return false;
    for (const id of ['settings', 'ask']) { const e = document.getElementById(id); if (e && !e.hidden) return false; }
    return !document.querySelector('.fpage:not([hidden]), .fring:not([hidden]), .ftips:not([hidden])');
  }

  // ---- the hand. Modes: idle | hover (a hand over the phone) | carry (a fist holding files) | away (carrying, out of
  // view for a moment) | sent (they went; the hand is still in view) | catch (a fist that came in from outside: files
  // from the PC when it opens). pos, size: the hand in the camera's view (0..1); x, y: on the screen
  const M = { mode: 'idle', wasOpen: false, x: 0, y: 0, pos: [0.5, 0.5], size: 0, grabPos: null, grabSize: 0, tid: null, items: null, video: null,
    catchT: 0, goT: 0, hideT: 0, inT: 0, touch: 0, paint: null, painted: null, hint: 0 };

  function onEvent(type, e) {
    if (type === 'move') move(e);
    else if (type === 'enter') enter(e);
    else if (type === 'pose') pose(e);
    else if (type === 'pinch') pinch();
    else if (type === 'leave') leave(e);
  }

  function enter(e) {
    if (M.mode === 'away') {                              // back before the files went
      clearTimeout(M.goT);
      held.classList.remove('gone');
      M.mode = 'carry';
      if (e.pose === 'open') released(e.pos);
      return;
    }
    if (M.mode === 'carry') return;
    M.wasOpen = e.pose === 'open';
    M.mode = e.pose === 'fist' ? 'catch' : 'hover';
    M.catchT = Date.now();
  }

  function pose(e) {
    if (e.pose === 'open') M.wasOpen = true;
    if (M.mode === 'hover' && e.pose === 'fist') grab();
    else if (M.mode === 'carry' && e.pose === 'open') released(e.pos);
    else if (M.mode === 'catch' && e.pose === 'open') {
      // a fist held over the phone for a moment, then opened (a hand that only passes through a fist doesn't count)
      const ms = Date.now() - M.catchT;
      if (ms >= 250 && ms < 4000) catchFromPc();
      M.mode = 'hover';
    }
  }

  // the send a hand carries ended without it (the PC put it back after a very long hold, the link dropped)
  function carryOver() {
    if (!M.tid || A.st.pending.has(M.tid)) return false;
    Object.assign(M, { tid: null, mode: 'hover', video: null });
    clearTimeout(M.goT);
    hideHeld();
    return true;
  }

  function move(e) {
    const [x, y] = toScreen(e.pos);
    M.x = x; M.y = y;
    M.pos = e.pos; M.size = e.size || 0;
    if (M.mode === 'carry' && carryOver()) return;
    if (M.mode === 'carry') { place(held, x, y); return; }
    if (M.mode !== 'hover') return;
    const pv = preview();
    const free = pv || gridFree();
    spot.hidden = !free;
    place(spot, x, y);
    spot.classList.toggle('fist', e.pose === 'fist');
    spot.classList.toggle('pinch', !!e.pinch);
    if (!free || pv || Date.now() - M.touch < 600) { setHover(null); return; }
    if (e.pinch && M.paint != null) {                     // a pinch moved across files: they follow the first one
      const it = A.itemAt(x, y);
      if (it && !M.painted.has(it.id)) { M.painted.add(it.id); if (isSel(it) !== M.paint) A.selectToggle(it); }
      setHover(it);
      return;
    }
    if (!e.pinch) M.paint = null;
    if (e.pose !== 'fist') setHover(A.itemAt(x, y));     // a closing hand keeps what it was over
  }

  function pinch() {
    if (M.mode !== 'hover' || preview() || !gridFree()) return;
    const it = hovered || A.itemAt(M.x, M.y);
    if (!it) return;
    A.selectToggle(it);
    M.paint = isSel(it);
    M.painted = new Set([it.id]);
    spot.classList.remove('pop'); void spot.offsetWidth; spot.classList.add('pop');
  }

  function grab() {
    if (Date.now() - M.touch < 600 || !M.wasOpen) return;  // a finger on the screen is touching, not grabbing
    const pv = preview();
    if (!pv && !gridFree()) return;
    let items = [], rect = null;
    if (pv) { items = [pv]; rect = X.preview.rect(); }
    else if (A.selecting && A.selected().length) items = A.selected();
    else if (hovered) items = [hovered];
    if (!items.length) {
      if (Date.now() - M.hint > 60000) { M.hint = Date.now(); A.toast('Hold your open hand over a file, then make a fist', 2600); }
      return;
    }
    if (!A.st.connected) { A.toast('Connect to your PC first', 2000); return; }
    if ((A.st.pcProto || 1) < AIR_PROTO) { A.toast(X.OLD_PC, 2600); return; }
    if (!rect) rect = A.cardRect(items[0].id);
    // a playing video carries on from the same second on the PC
    const v = pv && X.preview.video();
    const video = v && !v.paused && !v.ended ? { t: v.currentTime } : null;
    const tid = A.airLift(items, rect);
    if (!tid) return;
    if (video) v.pause();
    Object.assign(M, { mode: 'carry', tid, items, video, paint: null, grabPos: M.pos.slice(), grabSize: M.size });
    spot.hidden = true;
    setHover(null);
    showHeld(items, rect);
  }

  function showHeld(items, rect) {
    clearTimeout(M.hideT);                                // an earlier carry's exit mustn't hide this one
    clearTimeout(M.inT);
    held.textContent = '';
    // the picture its card already shows, else the phone's thumbnail
    const card = cardEl(items[0].id), ci = card && card.querySelector('.thumb img.ok');
    const th = (ci && ci.currentSrc) || (items[0].kind === 'image' || items[0].kind === 'video' ? A.nativeThumb(items[0]) : null);
    if (th) { const im = h('img'); im.src = th; im.alt = ''; held.appendChild(im); }
    else held.appendChild(h('b', '', items[0].dir ? 'Folder' : (String(items[0].name).split('.').pop() || 'File').slice(0, 4).toUpperCase()));
    if (items.length > 1) held.appendChild(h('span', 'n', items.length > 99 ? '99+' : String(items.length)));
    held.className = 'airheld';
    held.hidden = false;
    // out of the file's place into the hand
    const r = rect || { left: M.x - 42, top: M.y - 42, width: 84, height: 84 };
    held.style.transition = 'none';
    place(held, r.left + r.width / 2, r.top + r.height / 2, clamp(r.width / 84, 0.6, 3));
    void held.offsetWidth;
    held.style.transition = '';
    held.classList.add('in');                             // a slower move into the hand, then it follows the hand
    place(held, M.x, M.y);
    M.inT = setTimeout(() => held.classList.remove('in'), 300);
  }
  function hideHeld() { clearTimeout(M.hideT); held.hidden = true; held.className = 'airheld'; held.textContent = ''; }
  function hideHeldIn(ms) { clearTimeout(M.hideT); M.hideT = setTimeout(hideHeld, ms); }

  function leave(e) {
    spot.hidden = true;
    setHover(null);
    M.paint = null;
    if (M.mode === 'carry') {
      if (e.edge) { M.mode = 'idle'; go(); return; }
      // gone from the middle of the view: the tracker may have lost it for a moment; it goes unless it's back soon
      M.mode = 'away';
      held.classList.add('gone');
      clearTimeout(M.goT);
      M.goT = setTimeout(() => { if (M.mode === 'away') { M.mode = 'idle'; go(); } }, 600);
      return;
    }
    if (M.mode !== 'away') M.mode = 'idle';
    M.wasOpen = false;
  }

  // the hand opened while carrying: over the phone, where it grabbed, it puts the files back; moved well away (toward
  // the PC, which this camera may still see) or up, it lets them go
  const movedAway = (pos) => {
    const g = M.grabPos || pos;
    return Math.hypot(pos[0] - g[0], pos[1] - g[1]) > 0.28 || !!(M.grabSize && M.size && M.size < M.grabSize * 0.6);
  };
  function released(pos) {
    if (movedAway(pos)) { go(); M.mode = 'sent'; } else putBack();
  }

  function go() {
    const tid = M.tid;
    M.tid = null;
    M.wasOpen = false;
    clearTimeout(M.goT);
    const video = M.video;
    M.video = null;
    // (the send may be over already: the PC put it back after a very long hold, or the link dropped)
    if (!tid || !A.airGo(tid, { video })) { hideHeld(); return; }
    // off the side of the phone that faces the PC
    held.classList.remove('gone');
    held.classList.add('thrown');
    place(held, A.st.side === 'right' ? -90 : innerWidth + 90, M.y, 0.7);
    hideHeldIn(420);
  }

  function putBack() {
    const tid = M.tid, items = M.items || [];
    Object.assign(M, { tid: null, mode: 'hover', wasOpen: true });
    clearTimeout(M.goT);
    if (tid) A.airCancel(tid);
    const pv = preview();
    if (M.video && pv) { const v = X.preview.video(); if (v) { const p = v.play(); if (p && p.catch) p.catch(() => {}); } }
    M.video = null;
    const r = pv ? X.preview.rect() : items[0] ? A.cardRect(items[0].id) : null;
    held.classList.add('back');
    if (r) place(held, r.left + r.width / 2, r.top + r.height / 2, clamp(r.width / 84, 0.6, 3));
    else held.classList.add('gone');
    hideHeldIn(360);
    A.haptic('soft');
  }

  // the PC gets ready for a grab in front of it (selecting files there turns its camera on) only while this phone can
  // catch: Air grab on, Flick open, the camera watching
  let saidReady = null;
  function tellReady(force) {
    const r = camState === 'on' && A.st.connected && (A.st.pcProto || 1) >= AIR_PROTO;
    if (r === saidReady && !force) return;
    saidReady = r;
    if (A.st.connected) A.wsSend({ t: 'air-ready', on: r });
  }

  function catchFromPc() {
    if (!A.st.connected) return;
    if ((A.st.pcProto || 1) < AIR_PROTO) { A.toast(X.OLD_PC, 2600); return; }
    A.wsSend({ t: 'air-catch' });
    const r = h('div', 'aircatch');
    layer.appendChild(r);
    place(r, M.x, M.y);
    setTimeout(() => r.remove(), 900);
    A.haptic('tick');
  }

  A.on('ws', (m) => {
    if (m.t === 'air-none') {
      // nothing picked up on the PC: how to, or why it can't be done there
      const pc = X.pcName();
      A.toast(m.why === 'camoff' ? 'Air grab is off in Flick’s window on ' + pc + ': turn it on to grab files there'
        : m.why === 'nocamera' ? pc + ' has no camera Flick can use, so files there can’t be grabbed by hand'
          : (m.how === 'copy' ? 'Copy files on ' : 'Select files on ') + pc + ', grab them with a fist in front of the screen, then open it here', 3200);
    } else if (m.t === 'air-held') {
      // a fist picked files up in front of the PC: they come here when it opens over the phone
      if (+m.n > 0) A.toast((+m.n > 1 ? m.n + ' files' : String(m.name || 'A file')) + ' in your hand: open it over the phone', 3200);
    } else if (m.t === 'air-land' && m.tid && m.tid === M.tid) {
      // the PC's camera saw the fist open in front of it: the files go there. Out of this camera's view, at once; still
      // in view, only if the hand moved well away from where it grabbed (this camera knows best where it is)
      if (M.mode === 'away') { M.mode = 'idle'; go(); }
      else if (M.mode === 'carry' && movedAway(M.pos)) { go(); M.mode = 'sent'; }
    }
  });

  // a finger on the screen: the hand the camera sees is touching, not grabbing
  document.addEventListener('pointerdown', () => { M.touch = Date.now(); }, true);
  document.addEventListener('pointermove', (e) => { if (e.buttons) M.touch = Date.now(); }, true);

  // ---- the camera: on only while it is useful
  function files() {
    return Promise.all(FILES.map((n) => fetch(BASE + n).then((r) => (r.ok ? r.arrayBuffer() : null), () => null))).then((bufs) => {
      const o = {};
      FILES.forEach((n, i) => { if (bufs[i]) o[n] = bufs[i]; });
      return o;
    });
  }
  function script(src) {
    return new Promise((res) => { const s = document.createElement('script'); s.src = src; s.onload = s.onerror = () => res(); document.head.appendChild(s); });
  }
  // the tracker in a worker built from hand.js + worker.js; where that can't be made, on the page
  let workerUrl = null;
  async function workerMaker() {
    try {
      const parts = await Promise.all(['hand.js', 'worker.js'].map((n) => fetch(BASE + n).then((r) => { if (!r.ok) throw new Error(n); return r.text(); })));
      workerUrl = URL.createObjectURL(new Blob(parts, { type: 'text/javascript' }));
      new Worker(workerUrl).terminate();
      return () => new Worker(workerUrl);
    } catch (e) {
      if (!window.FlickHandWorker) { await script('hand/hand.js'); await script('hand/worker.js'); }
      return () => window.FlickHandWorker.inline();
    }
  }
  function build() {
    if (!building) {
      building = (async () => {
        if (!window.FlickHandCam) await script('hand/camera.js');
        if (!window.FlickHandStream) await script('hand/stream.js');
        const worker = await workerMaker();
        stream = new window.FlickHandStream({ mirror: true, onEvent });
        cam = new window.FlickHandCam({
          worker, files, facing: 'user',
          onResult: (r) => stream.push(r),
          onState: (s, d) => {
            camState = s;
            tellReady();
            // said once until Flick comes back to the screen: no camera, a camera Android won't give, one that's busy
            if ((s === 'denied' || s === 'nocamera' || s === 'error') && !deniedSaid) {
              deniedSaid = true;
              A.toast(s === 'nocamera' ? 'Air grab needs a front camera' : s === 'denied' ? 'Flick can’t use the camera' : 'The camera is busy (another app may be using it)', 2600);
            }
            if (s === 'error' || s === 'nocamera') console.log('air: ' + s + ' ' + (d || ''));
          },
        });
        // frames the tracker skipped (nothing moving) still let a hand that went out of view leave
        setInterval(() => { if (stream && camState === 'on') stream.push({ t: performance.now() }); }, 200);
        return cam;
      })();
      building.catch(() => { building = null; });
    }
    return building;
  }

  const wanted = () => on && !paused && !document.hidden && A.st.connected && camOk();
  async function update() {
    if (wanted()) {
      try { await build(); } catch (e) { console.log('air: ' + e); return; }
      if (wanted() && camState !== 'on' && camState !== 'starting' && !/denied|nocamera/.test(camState)) cam.start();
      return;
    }
    if (!cam || camState === 'off') return;
    cam.stop();
    if (M.mode === 'carry' || M.mode === 'away') putBack();
    M.mode = 'idle';
    spot.hidden = true;
    setHover(null);
    stream.reset();
  }

  A.on('conn', () => { saidReady = null; update(); tellReady(true); });
  A.on('native', (e) => {
    if (e.t === 'pause') { paused = true; update(); }
    else if (e.t === 'resume') { paused = false; deniedSaid = false; if (/denied|nocamera|error/.test(camState)) camState = 'off'; update(); }
    else if (e.t === 'camera') {
      on = camOk();
      A.pref.set('air', on ? '1' : '');
      if (on) A.toast('Air grab is on: make a fist over a file, then move it to your PC', 3200);
      update();
      const s = document.getElementById('settings');
      if (s && !s.hidden && !s.classList.contains('closing')) A.renderSettings();
    }
  });
  document.addEventListener('visibilitychange', () => update());
  setTimeout(update, 1200);

  // ---- Settings
  A.on('settings', (body) => {
    const state = A.nc('cameraState');
    const g = h('section', 'sgroup');
    g.appendChild(h('h3', '', 'Air grab'));
    const card = h('div', 'scard');
    const row = h('div', 'srow');
    const lab = h('div', 'sl');
    lab.appendChild(h('b', '', 'Grab files with your hand'));
    lab.appendChild(h('small', '', state === 'blocked' && !on
      ? 'Allow the camera for Flick in Android’s settings first'
      : 'Make a fist over a file, then move it to your PC. Uses the front camera while Flick is open; no picture leaves the phone.'));
    row.appendChild(lab);
    const l = h('label', 'stog');
    const i = h('input');
    i.type = 'checkbox';
    i.checked = on && state === 'granted';
    i.setAttribute('aria-label', 'Air grab');
    i.onchange = () => {
      A.haptic('tick');
      if (!i.checked) { on = false; A.pref.set('air', ''); update(); return; }
      if (camOk()) { on = true; A.pref.set('air', '1'); update(); return; }
      i.checked = false;
      A.nc('askCamera');                                  // Android asks once; its answer comes back as 'camera'
    };
    l.append(i, h('span'));
    row.appendChild(l);
    card.appendChild(row);
    if (on && camState === 'on' && A.st.connected) {
      const n = h('div', 'srow fsnote airtip');
      n.appendChild(h('span', '', 'Pinch over a file to select it, and keep pinching across more. To bring files here, select them on ' + X.pcName() + ', make a fist in front of its screen, then open it over the phone.'));
      card.appendChild(n);
    }
    g.appendChild(card);
    body.appendChild(g);
  });

  X.air = { state: () => ({ on, camState, mode: M.mode }), stats: () => (cam ? cam.stats : null) };
});
