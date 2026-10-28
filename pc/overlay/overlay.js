'use strict';
/* Flick overlay controller — events from the phone/main process → cards → active theme → GPU renderer. */
(function () {
  const api = window.flick || { on() {}, send() {} };
  const handlers = {};
  const on = (ch, fn) => { handlers[ch] = fn; api.on(ch, fn); };
  window.__fx = (ch, d) => { if (handlers[ch]) handlers[ch](d); };   // test hook
  window.__cards = () => [...cards.values()].map((c) => ({ id: c.id, state: c.state, x: Math.round(c.pose.x), y: Math.round(c.pose.y),
    target: c.target ? { x: Math.round(c.target.x), y: Math.round(c.target.y) } : null, edge: !!c.airEdge }));   // test hook

  const R = window.GFX, A = window.SFX;
  const canvas = document.getElementById('gl');
  const hud = document.getElementById('hud');
  const GL_OK = R.init(canvas);

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  const damp = (cur, target, dt, ms) => target + (cur - target) * Math.exp(-dt / ms);
  const now = () => performance.now();
  const rnd = (a, b) => a + Math.random() * (b - a);

  // ------------------------------------------------------------------ settings
  const S = { W: innerWidth, H: innerHeight, dispW: innerWidth, dispH: innerHeight + 1, dpr: devicePixelRatio || 1,
    side: 'right', anchor: 0.5, k: 0.66, sound: true, taskbar: 48, saveLabel: 'Desktop', theme: 'roadster', iconSize: 56 };

  // dirty: something drawn changed outside the cards' own state (a picture loaded, a new card, the canvas resized, which
  // blanks it): the next frame draws, whatever else (see frame)
  let dirty = true;
  function applySize() { R.resize(S.W, S.H, S.dpr, S.dispW, S.dispH); dirty = true; }
  applySize();

  // ------------------------------------------------------------------ shared particle systems (themes spawn into these)
  const puffs = [];     // vapor / smoke
  const glows = [];     // lights, sparks, lamps
  const segs = [];      // light streak segments
  const MAX_PUFFS = 1800, MAX_GLOWS = 1600, MAX_SEGS = 900;

  const E = {
    S, R, A, clamp, lerp, sstep, damp, rnd,
    now: () => clock,
    dirIn: () => (S.side === 'right' ? -1 : 1),
    edgeX: () => (S.side === 'right' ? S.W : 0),
    mapX: (px, pw) => (S.side === 'right' ? S.W + px * S.k : (px - pw) * S.k),
    mapY: (py, ph) => S.anchor * S.H + (py - ph / 2) * S.k,
    phoneH: () => phoneScreen.h * S.k,
    floorY: () => S.H - S.taskbar,
    puff(o) {
      if (puffs.length >= MAX_PUFFS) puffs.shift();
      const p = Object.assign({ x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, s0: 8, s1: 60, grow: 0.28, drag: 0.16, life: 1, alpha: 0.25, seed: Math.random(),
        rot: Math.random() * 6.28, spin: rnd(-0.6, 0.6), layer: 'under', color: [0.96, 0.975, 1], age: 0, ground: true, kind: 1 }, o);
      puffs.push(p); return p;
    },
    glow(o) {
      if (glows.length >= MAX_GLOWS) glows.shift();
      const g = Object.assign({ x: 0, y: 0, z: 0, vx: 0, vy: 0, drag: 0, size: 20, alpha: 1, color: [1, 1, 1], kind: 0, life: 1, age: 0, layer: 'over',
        fadeIn: 0.02, twinkle: 0, seed: Math.random(), grow: 0 }, o);
      glows.push(g); return g;
    },
    seg(o) {
      if (segs.length >= MAX_SEGS) segs.shift();
      const s = Object.assign({ w: 5, core: 1.2, color: [1, 1, 1], alpha: 1, life: 0.4, age: 0, a0: 1, a1: 1 }, o);
      segs.push(s); return s;
    },
    shake: { amp: 0, t0: 0, dur: 0 },
    hud,
    cards: null,
  };

  // ------------------------------------------------------------------ themes
  const THEMES = window.FLICK_THEMES || {};
  let theme = null;
  function setTheme(name) {
    const next = THEMES[name] || THEMES.roadster || Object.values(THEMES)[0];
    if (!next || next === theme) return;
    // anything still on screen belongs to the old animation's physics: clear it before the new one takes over
    if (theme) resetAll();
    theme = next;
    if (!theme.ready && theme.init) { try { theme.init(E); } catch (e) { console.log('theme init failed ' + e.message); } theme.ready = true; }
  }
  setTheme(S.theme);

  // ------------------------------------------------------------------ desktop capture (for blur / refraction)
  on('fx:noshot', () => { if (GL_OK) R.dropDesk(); });
  on('fx:shot', (m) => {
    if (!GL_OK || !m) return;
    if (m.bgra) { R.setDesk({ bgra: m.bgra, w: m.w, h: m.h, rgba: !!m.rgba }); return; }
    if (m.url) {
      const img = new Image();
      img.onload = () => { R.setDesk(img); kick(); };
      img.src = m.url;
    }
  });

  // ------------------------------------------------------------------ cards
  const cards = new Map();
  E.cards = cards;
  let phoneScreen = { w: 412, h: 915 };

  function docCanvas(info, w, h) {
    const sc = 3;
    const cv = document.createElement('canvas');
    cv.width = Math.max(8, Math.round(w * sc)); cv.height = Math.max(8, Math.round(h * sc));
    const c = cv.getContext('2d');
    c.scale(sc, sc);
    c.fillStyle = '#fbfbfd'; c.fillRect(0, 0, w, h);
    c.fillStyle = 'rgba(60,60,67,0.20)';
    for (let y = h * 0.12; y < h * 0.72; y += 6) c.fillRect(w * 0.13, y, w * 0.74 * (0.6 + 0.4 * Math.abs(Math.sin(y * 1.7))), 1.4);
    const badge = String(info.badge || '').slice(0, 4);
    if (badge) {
      c.font = '700 ' + Math.round(Math.max(7, w * 0.075)) + 'px "Segoe UI", system-ui, sans-serif';
      const tw = c.measureText(badge).width;
      const bx = w * 0.08, by = h - w * 0.08 - w * 0.12, bh = w * 0.12;
      c.fillStyle = 'rgba(28,28,30,0.88)';
      const r = bh * 0.3;
      c.beginPath(); c.moveTo(bx + r, by); c.arcTo(bx + tw + bh * 0.8, by, bx + tw + bh * 0.8, by + bh, r); c.arcTo(bx + tw + bh * 0.8, by + bh, bx, by + bh, r);
      c.arcTo(bx, by + bh, bx, by, r); c.arcTo(bx, by, bx + tw + bh, by, r); c.fill();
      c.fillStyle = '#fff'; c.textBaseline = 'middle'; c.fillText(badge, bx + bh * 0.4, by + bh / 2 + 0.5);
    }
    return cv;
  }

  // ---- card faces drawn on a canvas: a photo cover-fitted, a folder tile (as on the phone), and the count of a stack
  const FACE_SC = 4;
  function faceCanvas(w, h) {
    const cv = document.createElement('canvas');
    cv.width = Math.max(8, Math.round(w * FACE_SC)); cv.height = Math.max(8, Math.round(h * FACE_SC));
    const c = cv.getContext('2d');
    c.scale(cv.width / w, cv.height / h);
    return { cv, c };
  }
  function coverCanvas(img, w, h) {
    const { cv, c } = faceCanvas(w, h);
    const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
    const ia = iw / ih, ca = w / h;
    let sw = iw, sh = ih, sx = 0, sy = 0;
    if (ia > ca) { sw = sh * ca; sx = (iw - sw) / 2; } else { sh = sw / ca; sy = (ih - sh) / 2; }
    c.imageSmoothingQuality = 'high';
    c.drawImage(img, sx, sy, sw, sh, 0, 0, w, h);
    return cv;
  }
  function folderCanvas(w, h) {
    const { cv, c } = faceCanvas(w, h);
    const g = c.createLinearGradient(0, 0, w * 0.45, h);
    g.addColorStop(0, '#2a2a30'); g.addColorStop(1, '#1b1b20');
    c.fillStyle = g; c.fillRect(0, 0, w, h);
    const fw = w * 0.46, k = fw / 64, fh = 52 * k;
    c.save();
    c.translate((w - fw) / 2, (h - fh) / 2); c.scale(k, k);
    c.fillStyle = '#3a5fcc';
    c.fill(new Path2D('M4 9a5 5 0 0 1 5-5h14l6 6h26a5 5 0 0 1 5 5v28a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5z'));
    const fg = c.createLinearGradient(0, 13, 0, 48);
    fg.addColorStop(0, '#8fb4ff'); fg.addColorStop(1, '#4c7dff');
    c.fillStyle = fg;
    c.fill(new Path2D('M4 18a5 5 0 0 1 5-5h46a5 5 0 0 1 5 5v25a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5z'));
    c.restore();
    return cv;
  }
  function plainCanvas(w, h, color) { const { cv, c } = faceCanvas(w, h); c.fillStyle = color; c.fillRect(0, 0, w, h); return cv; }
  function badgeOn(cv, w, h, n) {
    const c = cv.getContext('2d');
    c.setTransform(cv.width / w, 0, 0, cv.height / h, 0, 0);
    const txt = n > 999 ? '999+' : String(n);
    const m = Math.min(w, h);
    const fs = Math.max(7, m * 0.15);
    c.font = '700 ' + fs.toFixed(1) + 'px "Segoe UI", system-ui, sans-serif';
    const bh = fs * 1.6, bw = Math.max(bh, c.measureText(txt).width + fs * 1.0);
    const x = w - bw - m * 0.07, y = m * 0.07;
    c.save();
    c.shadowColor = 'rgba(0,0,0,0.35)'; c.shadowBlur = fs * 0.6; c.shadowOffsetY = fs * 0.12;
    c.fillStyle = '#ffffff';
    c.beginPath(); c.roundRect(x, y, bw, bh, bh / 2); c.fill();
    c.restore();
    c.fillStyle = '#111114'; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText(txt, x + bw / 2, y + bh / 2 + fs * 0.05);
    return cv;
  }
  function loadImage(src) {
    return new Promise((res) => { const img = new Image(); img.onload = () => res(img); img.onerror = () => res(null); img.src = src; });
  }

  // stacked sheets behind the top card (local offsets in the card's own plane)
  const SHEETS = [{ dx: -0.04, dy: 0.065, rz: -0.08, z: -1.6 }, { dx: 0.05, dy: 0.04, rz: 0.065, z: -0.8 }];
  function sheetPose(p, o, w, h) {
    const q = R.apply(R.model(p), o.dx * w, o.dy * h, o.z);
    return { x: q[0], y: q[1], z: q[2], rx: p.rx || 0, ry: p.ry || 0, rz: (p.rz || 0) + o.rz, sx: p.sx || 1, sy: p.sy || 1 };
  }
  function drawSheets(c) {
    const n = Math.min(2, (c.info.count || 1) - 1);
    for (let i = 2 - n; i < 2; i++) {
      const sh = c.sheets[i] || {};
      R.drawCard({
        tex: sh.tex || null, texW: sh.w || 0, texH: sh.h || 0, w: c.w, h: c.h, radius: c.radius,
        pose: sheetPose(c.pose, SHEETS[i], c.w, c.h), prev: sheetPose(c.prev || c.pose, SHEETS[i], c.w, c.h),
        opacity: c.opacity, gloss: c.gloss, back: c.back, sat: c.sat, bright: (c.bright == null ? 1 : c.bright) * 0.9,
        reveal: c.reveal, revealMode: c.revealMode, revealAxis: c.revealAxis, revealColor: c.revealColor, noBlur: c.noBlur,
      });
    }
  }

  class Card {
    constructor(id, info) {
      this.id = id;
      this.info = info || {};
      const cw = (this.info.card && this.info.card.w) || 160, ch = (this.info.card && this.info.card.h) || 160;
      this.w = cw * S.k; this.h = ch * S.k;
      this.radius = Math.max(5, 14 * S.k);
      this.pose = { x: -9999, y: -9999, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1 };
      this.prev = null;
      this.opacity = 1; this.visible = true; this.gloss = 0.55; this.back = 0;
      this.state = 'track'; this.t0 = now(); this.msg = null; this.msgT = 0;
      this.shadowK = 1;
      this.saved = null; this.progress = 0;
      this.liftAt = now(); this.dropAt = 0; this.savedAt = 0;
      this.size = this.info.size || 0;
      this.tex = null; this.texW = 0; this.texH = 0;
      this.label = null;
      this.loadTexture();
    }
    loadTexture() {
      const info = this.info;
      const n = info.count || 1;
      const w = this.w, h = this.h;
      const setTex = (src, tw, th) => { if (!GL_OK || this.gone) return; R.freeTex(this.tex); this.tex = R.texFrom(src); this.texW = tw; this.texH = th; kick(); };
      const face = (cv) => { if (n > 1) badgeOn(cv, w, h, n); setTex(cv, cv.width, cv.height); };
      if (info.folder) face(folderCanvas(w, h));
      else if (info.thumb) {
        loadImage(info.thumb).then((img) => {
          if (!img) return face(docCanvas(info, w, h));
          if (n > 1) face(coverCanvas(img, w, h));
          else setTex(img, img.naturalWidth, img.naturalHeight);
        });
      } else face(docCanvas(info, w, h));
      // a stack shows up to two more items underneath
      if (n > 1) {
        this.sheets = [{}, {}];
        const thumbs = info.thumbs || [];
        for (let i = 0; i < 2; i++) {
          const slot = 1 - i;                          // the next item sits right under the top card
          const put = (cv) => { if (!GL_OK || this.gone) return; this.sheets[slot] = { tex: R.texFrom(cv), w: cv.width, h: cv.height }; kick(); };
          if (thumbs[i]) loadImage(thumbs[i]).then((img) => put(img ? coverCanvas(img, w, h) : plainCanvas(w, h, '#2c2c2e')));
          else put(plainCanvas(w, h, '#2c2c2e'));
        }
      }
    }
    resize(cw, ch) {
      const w = cw * S.k, h = ch * S.k;
      if (Math.abs(w - this.w) > 0.5 || Math.abs(h - this.h) > 0.5) { this.w = w; this.h = h; }
    }
    onMove(m) { this.msg = m; this.msgT = now(); if (m.w && m.h) this.resize(m.w, m.h); if (m.pw && m.ph) phoneScreen = { w: m.pw, h: m.ph }; }
    // proximity of the tracked card to the phone's PC-side edge (0..1)
    proximity() {
      const m = this.msg; if (!m) return 0;
      const pw = m.pw || 400;
      const dist = S.side === 'right' ? m.x : pw - (m.x + m.w);
      return sstep(0, 1, 1 - clamp(dist / (pw * 0.62), 0, 1));
    }
    remove() {
      this.gone = true;
      R.freeTex(this.tex);
      if (this.sheets) for (const sh of this.sheets) if (sh && sh.tex) R.freeTex(sh.tex);
      if (this.label) this.label.remove();
      if (this.extraEls) for (const el of this.extraEls) el.remove();
      cards.delete(this.id);
    }
  }
  E.Card = Card;

  // ------------------------------------------------------------------ desktop label (Windows-style) for a landed file
  function makeLabel(card) {
    const d = document.createElement('div');
    d.className = 'label';
    const a = document.createElement('div');
    a.className = 'name';
    a.textContent = card.info.name || (card.saved && card.saved.name) || '';
    d.appendChild(a);
    const where = card.saved && card.saved.where;
    if (card.saved && card.saved.note) {
      const b = document.createElement('div');
      b.className = 'where';
      b.textContent = card.saved.note;
      d.appendChild(b);
    } else if (where && where !== 'Desktop') {
      const b = document.createElement('div');
      b.className = 'where';
      b.textContent = 'in ' + where;
      d.appendChild(b);
    }
    hud.appendChild(d);
    return d;
  }

  function toIcon(card) {
    card.state = 'icon';
    card.t0 = now();
    card.iconFrom = { x: card.pose.x, y: card.pose.y, s: card.pose.sx || 1 };
    card.iconScale = Math.min(S.iconSize / card.w, S.iconSize / card.h);
    card.label = makeLabel(card);
    if (theme.toIcon) theme.toIcon(E, card);
  }

  // ------------------------------------------------------------------ approach (a card on the phone nearing the PC edge)
  const AP = { p: 0, y: S.H / 2, crossing: false, card: null, hold: 0, hover: 0, hoverY: S.H / 2 };

  // ------------------------------------------------------------------ events
  on('fx:config', (c) => {
    if (!c) return;
    const prevTheme = S.theme;
    Object.assign(S, c);
    S.W = c.W || innerWidth; S.H = c.H || innerHeight;
    S.dispW = c.dispW || S.W; S.dispH = c.dispH || (S.H + 1);
    S.dpr = c.dpr || devicePixelRatio || 1;
    A.enabled = S.sound !== false;
    applySize();
    if (c.theme && c.theme !== prevTheme) setTheme(c.theme); else if (!theme) setTheme(S.theme);
  });
  on('fx:theme', (m) => { if (m && m.theme) { S.theme = m.theme; setTheme(m.theme); } });
  on('fx:hold', (m) => {
    AP.hold = clamp((m && m.p) || 0, 0, 1);
    AP.holdAt = now();
    if (m && m.ph) phoneScreen.h = m.ph;
    kick();
  });
  on('fx:connect', (m) => {
    AP.hold = 0;
    if (theme.connect) theme.connect(E, m || {});
    kick();
  });
  on('fx:lift', (m) => {
    if (!m || !m.tid) return;
    let c = cards.get(m.tid);
    if (c) c.remove();
    c = new Card(m.tid, m);
    cards.set(m.tid, c);
    if (theme.lift) theme.lift(E, c);
    kick();
  });
  on('fx:move', (m) => {
    const c = m && cards.get(m.tid);
    if (c && c.state === 'track') { c.onMove(m); kick(); }
  });
  // Air grab (pc/air.js): the card follows the hand the PC's camera sees ({ x, y } on this screen), or ({ off })
  // goes back to waiting at the edge
  on('fx:air', (m) => {
    const c = m && cards.get(m.tid);
    if (!c) return;
    if (m.off) { if (c.state === 'air') { c.state = 'track'; c.t0 = now(); } kick(); return; }
    if (c.state !== 'track' && c.state !== 'air') return;
    if (c.state === 'track') { c.state = 'air'; c.t0 = now(); }
    c.air = handAt(c.air, m);
    kick();
  });
  // where the hand is, with its speed (px per ms, smoothed): between the camera's reports (15 to 30 a second) the card
  // carries on a little the way the hand moves, so it keeps up with it
  function handAt(prev, m) {
    const t = now(), x = +m.x || 0, y = +m.y || 0;
    const a = { x, y, at: t, vx: 0, vy: 0 };
    if (prev && t - prev.at > 0 && t - prev.at < 150) {
      const k = 0.5, dt = t - prev.at;
      a.vx = (prev.vx || 0) * (1 - k) + ((x - prev.x) / dt) * k;
      a.vy = (prev.vy || 0) * (1 - k) + ((y - prev.y) / dt) * k;
    }
    return a;
  }
  // the hand's place now: the last report, carried on for at most 40 ms
  const handNow = (a, t) => { const k = Math.min(40, Math.max(0, t - a.at)); return [a.x + (a.vx || 0) * k, a.y + (a.vy || 0) * k]; };
  // Air grab, PC to phone (pc/air.js): files a fist picked up in front of the screen. Their card follows the fist
  // ({ x, y } on this screen), waits at the edge on the phone's side once the hand has left ({ edge }), goes into the
  // phone when it catches them ({ go }), or is put back ({ drop }). The first message carries the card's face.
  on('fx:air-out', (m) => {
    if (!m || !m.id) return;
    let c = cards.get(m.id);
    if (m.drop) { if (c && c.state === 'airout') { c.state = 'fade'; c.t0 = now(); } kick(); return; }
    if (m.go) {
      if (c && c.state === 'airout') { c.state = 'out'; c.t0 = now(); if (theme.outgoing) theme.outgoing(E, c); }
      kick();
      return;
    }
    if (!c) {
      if (!m.name) return;                              // its face hasn't come yet
      c = new Card(m.id, m);
      cards.set(m.id, c);
      c.state = 'airout'; c.t0 = now();
      c.pose.x = +m.x || 0; c.pose.y = +m.y || 0;
      c.pose.sx = c.pose.sy = 0.6;                       // grows into the hand
      c.prev = Object.assign({}, c.pose);
      c.air = { x: c.pose.x, y: c.pose.y, at: now() };
      E.A.tone && E.A.tone({ type: 'sine', f0: 520, f1: 880, sweep: 0.12, dur: 0.16, gain: 0.02, attack: 0.005 });
    }
    if (c.state !== 'airout') return;
    if (m.edge) c.airEdge = now();
    else if (typeof m.x === 'number') { c.air = handAt(c.air, m); c.airEdge = 0; }
    kick();
  });
  on('fx:drop', (m) => {
    if (!m) return;
    let c = cards.get(m.tid);
    if (!c) { c = new Card(m.tid, m); cards.set(m.tid, c); }
    const fromHand = c.state === 'air';      // it takes off from where the hand held it
    c.onMove(m);
    const pw = m.pw || 400, ph = m.ph || 860;
    if (!fromHand) {
      c.pose.x = E.mapX(m.x + m.w / 2, pw); c.pose.y = E.mapY(m.y + m.h / 2, ph);
      c.pose.rz = ((m.r || 0) * Math.PI) / 180;
    }
    c.prev = Object.assign({}, c.pose);
    c.state = 'flight';
    c.t0 = now();
    c.dropAt = now();
    const vx = (m.vx || 0) * S.k, vy = (m.vy || 0) * S.k;   // DIP per ms
    c.launch = { x0: c.pose.x, y0: c.pose.y, vx, vy, r0: c.pose.rz, s0: c.pose.sx || 1 };
    // Air grab: where the hand opened in front of the PC; otherwise where the throw carries it
    c.target = m.land ? { x: clamp(+m.land.x || 0, c.w / 2 + 30, S.W - c.w / 2 - 30), y: clamp(+m.land.y || 0, c.h / 2 + 30, E.floorY() - c.h / 2 - 30) }
      : landingSpot(c, vx, vy);
    theme.launch(E, c);
    kick();
  });
  on('fx:cancel', (m) => { const c = m && cards.get(m.tid); if (c) { c.state = 'cancel'; c.t0 = now(); if (theme.cancel) theme.cancel(E, c); } kick(); });
  on('fx:info', (m) => {      // a folder's real size arrives once the phone has walked it
    const c = m && cards.get(m.tid);
    if (!c) return;
    if (m.size) c.size = m.size;
    if (m.files) c.info.files = m.files;
  });
  on('fx:progress', (m) => { const c = m && cards.get(m.tid); if (c) { c.progress = m.p; c.rate = m.rate || 0; c.progT = now(); c.paused = false; } });
  // a transfer whose phone left (its app closed, its Wi-Fi dropped) waits to carry on: "Paused" under its card
  on('fx:paused', (m) => { const c = m && cards.get(m.tid); if (c) { c.paused = true; kick(); } });
  // ...and carries on: the card if it's still here, otherwise a new one flies in from the phone's side
  on('fx:resumed', (m) => {
    if (!m || !m.tid) return;
    const c = cards.get(m.tid);
    if (c && !c.gone && (c.state === 'flight' || c.state === 'rest')) { c.paused = false; c.progT = now(); kick(); return; }
    if (!m.lift || !m.drop) return;
    handlers['fx:lift'](m.lift);
    setTimeout(() => handlers['fx:drop'](m.drop), 140);
  });
  on('fx:saved', (m) => {
    const c = m && cards.get(m.tid);
    if (!c) return;
    c.progress = 1; c.saved = m || {}; c.savedAt = now();
    if (c.state === 'rest') toIcon(c);
    kick();
  });
  on('fx:failed', (m) => { const c = m && cards.get(m.tid); if (c) { c.state = 'fail'; c.t0 = now(); if (theme.fail) theme.fail(E, c); } kick(); });
  on('fx:edge-hover', (m) => { AP.hover = m && m.on ? 1 : 0; AP.hoverAt = now(); AP.hoverCap = 8000; if (m && typeof m.y === 'number') AP.hoverY = m.y; kick(); });
  on('fx:preview', (m) => { AP.hover = m && m.on ? 0.8 : 0; AP.hoverAt = now(); AP.hoverCap = 120000; AP.hoverY = S.anchor * S.H; kick(); });
  on('fx:outgoing', (m) => {
    if (!m) return;
    const id = 'out-' + (m.fid || Math.random());
    const c = new Card(id, m);
    cards.set(id, c);
    c.state = 'out';
    c.t0 = now();
    c.pose.x = E.edgeX() + E.dirIn() * (c.w / 2 + 14);
    c.pose.y = clamp(typeof m.y === 'number' ? m.y : S.anchor * S.H, c.h / 2 + 12, S.H - c.h / 2 - 12);
    c.prev = Object.assign({}, c.pose);
    AP.hover = 0;
    if (theme.outgoing) theme.outgoing(E, c);
    kick();
  });
  on('fx:reset', () => resetAll());
  on('fx:demo', (m) => demo(m || {}));

  // where a thrown card comes to rest
  function landingSpot(c, vx, vy) {
    const dir = E.dirIn();
    const sp = Math.hypot(vx, vy);
    const reach = clamp(260 + sp * 150, 300, S.W * 0.58);
    const minIn = c.w / 2 + 90;
    let tx = E.edgeX() + dir * Math.max(minIn, reach);
    tx = clamp(tx, c.w / 2 + 40, S.W - c.w / 2 - 40);
    const ty = clamp(c.pose.y + vy * 220, c.h / 2 + 40, E.floorY() - c.h / 2 - 40);
    return { x: tx, y: ty };
  }
  E.landingSpot = landingSpot;

  // scripted transfer for the settings preview: a card dragged off the phone and thrown in
  function demo(m) {
    const id = 'demo-' + Date.now();
    const thumb = m.thumb || 'demo.jpg';
    const ph = phoneScreen.h || 915, pw = phoneScreen.w || 412;
    const cw = 176, ch = 132;
    const lift = { tid: id, name: m.name || 'Sunset.jpg', kind: 'image', thumb, card: { w: cw, h: ch }, size: 2480000 };
    handlers['fx:lift'](lift);
    const startX = S.side === 'right' ? 120 : pw - 120 - cw;
    const y = ph * 0.42;
    const t0 = now();
    const dur = 420;
    const dir = S.side === 'right' ? -1 : 1;
    function step() {
      const u = clamp((now() - t0) / dur, 0, 1);
      const e = u * u * (3 - 2 * u) * 0.6 + u * u * 0.4;
      const x = startX + dir * e * (startX + cw * 0.45 + (S.side === 'right' ? 0 : pw - startX));
      const vx = dir * (0.4 + u * 1.6);
      const msg = { tid: id, x, y, w: cw, h: ch, r: dir * 4 * u, s: 1.06, vx, vy: 0.05, pw, ph };
      if (u < 1) { handlers['fx:move'](msg); requestAnimationFrame(step); }
      else {
        handlers['fx:drop'](Object.assign({}, msg, { vx: dir * 2.4 }));
        setTimeout(() => handlers['fx:saved']({ tid: id, name: lift.name, where: S.saveLabel || 'Desktop' }), 260);
      }
    }
    requestAnimationFrame(step);
  }

  // ------------------------------------------------------------------ frame loop
  // slowT: nothing on screen changes (a card resting while its file arrives: only its progress line moves, and that's
  // not drawn here), so the next frame comes after a short wait instead of at once; any event brings it back at once.
  let raf = 0, last = 0, clock = 0, idleSince = 0, idleSent = true, themeBusySince = 0, drawnLook = null, slowT = 0;
  function kick() {
    idleSince = 0;
    idleSent = false;
    dirty = true;
    if (slowT) { clearTimeout(slowT); slowT = 0; raf = 0; }
    if (!raf) { last = now(); raf = requestAnimationFrame(frame); }
  }
  E.kick = kick;

  function resetAll() {
    for (const c of [...cards.values()]) c.remove();
    puffs.length = 0; glows.length = 0; segs.length = 0;
    AP.p = 0; AP.hold = 0; AP.hover = 0;
    if (theme && theme.reset) theme.reset(E);
    if (GL_OK) R.clear();
    drawnLook = null;
  }

  function updateParticles(dt) {
    const s = dt / 1000;
    for (let i = puffs.length - 1; i >= 0; i--) {
      const p = puffs[i];
      p.age += s;
      if (p.age >= p.life) { puffs.splice(i, 1); continue; }
      const f = Math.exp(-s / p.drag);
      p.vx *= f; p.vy *= f; p.vz *= f;
      if (p.ax) { p.vx += p.ax * s; p.vy += p.ay * s; }
      p.x += p.vx * s; p.y += p.vy * s; p.z += p.vz * s;
      if (p.ground && p.z < 0) {
        // hits the desktop: spread sideways
        const sp = -p.vz * 0.7;
        const a = Math.atan2(p.y - (p.cy == null ? p.y : p.cy), p.x - (p.cx == null ? p.x : p.cx)) + rnd(-0.5, 0.5);
        p.vx += Math.cos(a) * sp; p.vy += Math.sin(a) * sp;
        p.z = 0; p.vz = 0;
      }
      p.rot += p.spin * s;
    }
    for (let i = glows.length - 1; i >= 0; i--) {
      const g = glows[i];
      g.age += s;
      if (g.age >= g.life) { glows.splice(i, 1); continue; }
      if (g.drag) { const f = Math.exp(-s / g.drag); g.vx *= f; g.vy *= f; }
      g.x += g.vx * s; g.y += g.vy * s;
      if (g.update) g.update(g, s);
    }
    for (let i = segs.length - 1; i >= 0; i--) {
      segs[i].age += s;
      if (segs[i].age >= segs[i].life) segs.splice(i, 1);
    }
  }

  // particles go straight into packed sprite buffers (R.pack), not an object each per frame
  const vapPack = R.spritePack(), sprPack = R.spritePack();
  function puffSprites(layer, pk) {
    for (const p of puffs) {
      if (p.layer !== layer) continue;
      const u = p.age / p.life;
      const size = p.s0 + (p.s1 - p.s0) * (1 - Math.exp(-p.age / p.grow));
      // gas thins out as it expands
      const thin = Math.pow(Math.max(p.s0, 1) / size, 0.35);
      const a = p.alpha * thin * sstep(0, 0.05, p.age) * (1 - sstep(0.3, 1, u));
      if (a < 0.003) continue;
      // fast gas near the nozzle is streaky, slow gas is round
      const sp = Math.hypot(p.vx, p.vy);
      const st = 1 + Math.min(sp / 900, 1.3);
      const rot = sp > 40 ? Math.atan2(p.vy, p.vx) : p.rot;
      R.pack(pk, p.x, p.y, p.z, size, rot, st, 1 / Math.sqrt(st), p.color, a, p.seed, p.kind, u);
    }
  }
  function glowSprites(layer, pk) {
    for (const g of glows) {
      if (g.layer !== layer) continue;
      const u = g.age / g.life;
      let a = g.alpha * sstep(0, g.fadeIn, g.age) * (1 - sstep(g.fadeOut == null ? 0.55 : g.fadeOut, 1, u));
      if (g.twinkle) a *= 0.55 + 0.45 * Math.sin(g.age * g.twinkle + g.seed * 20);
      if (a < 0.003) continue;
      R.pack(pk, g.x, g.y, g.z, g.size * (1 + g.grow * g.age), g.rot, g.stx, g.sty, g.color, a, g.seed, g.kind, u);
    }
  }
  function segList() {
    const out = [];
    for (const s of segs) {
      const u = s.age / s.life;
      const f = Math.pow(1 - u, 1.6) * s.alpha;
      if (f < 0.004) continue;
      const taper = s.taper ? 1 - u * 0.65 : 1;
      out.push({ x0: s.x0, y0: s.y0, x1: s.x1, y1: s.y1, w: s.w * taper, core: s.core * taper, color: s.color, a0: s.a0 * f, a1: s.a1 * f });
    }
    return out;
  }

  // shadow under a card for its pose
  function shadowFor(c) {
    const p = c.pose;
    const z = Math.max(0, p.z || 0);
    const cosR = Math.abs(Math.cos(p.rx || 0)), cosP = Math.abs(Math.cos(p.ry || 0));
    const hw = (c.w / 2) * Math.max(0.08, cosP) * (p.sx || 1), hh = (c.h / 2) * Math.max(0.08, cosR) * (p.sy || 1);
    const k = c.shadowK * (c.opacity == null ? 1 : c.opacity);
    // tight contact shadow fades as soon as the card leaves the desktop
    const contact = Math.exp(-z / 10) * 0.30 * k;
    R.drawShadow(p.x + 0.6, p.y + 1.6, hw, hh, p.rz || 0, c.radius, 1.6, contact);
    // soft cast shadow: drifts, grows and softens with height
    const soft = 0.24 * k / (1 + z / 260);
    R.drawShadow(p.x + 2 + z * 0.16, p.y + 5 + z * 0.26, hw * (1 + z / 1800), hh * (1 + z / 1800), p.rz || 0, c.radius + z * 0.02, 9 + z * 0.075, soft);
  }
  E.drawShadowFor = shadowFor;

  function updateCard(c, t, dt) {
    switch (c.state) {
      case 'track': {
        const m = c.msg;
        if (!m) { c.visible = false; if (t - c.t0 > 60000) { c.remove(); return; } break; }
        // the phone stopped reporting this drag (and never dropped or canceled it): let it go
        if (t - c.msgT > 45000) { c.state = 'cancel'; c.t0 = t; break; }
        c.visible = true;
        const age = Math.min(t - c.msgT, 34);
        const pw = m.pw || 400, ph = m.ph || 860;
        c.pose.x = E.mapX(m.x + m.w / 2 + (m.vx || 0) * age, pw);
        c.pose.y = E.mapY(m.y + m.h / 2 + (m.vy || 0) * age, ph);
        c.pose.rz = ((m.r || 0) * Math.PI) / 180;
        c.pose.sx = c.pose.sy = m.s || 1.06;
        c.pose.z = 0; c.pose.rx = 0; c.pose.ry = 0;
        break;
      }
      case 'air': {
        // held by the hand in front of the PC: it floats where the hand is
        const a = c.air;
        c.visible = true;
        if (c.pose.x < -9000) { c.pose.x = a.x; c.pose.y = a.y; }
        const [hx, hy] = handNow(a, t);
        c.pose.x = damp(c.pose.x, hx, dt, 38);
        c.pose.y = damp(c.pose.y, hy + Math.sin(t / 240) * 3, dt, 38);
        c.pose.z = damp(c.pose.z || 0, 26, dt, 120);
        c.pose.sx = c.pose.sy = damp(c.pose.sx || 1, 0.92, dt, 120);
        c.pose.rz = damp(c.pose.rz || 0, 0, dt, 90); c.pose.rx = 0; c.pose.ry = 0;
        if (t - a.at > 45000) { c.state = 'cancel'; c.t0 = t; }
        break;
      }
      case 'airout': {
        // picked up in front of the PC: in the hand, or waiting at the edge on the phone's side for the phone to catch it
        c.visible = true;
        let tx, ty;
        if (c.airEdge) {
          tx = E.edgeX() + E.dirIn() * (c.w * 0.18);       // two thirds of it past the edge, toward the phone
          ty = clamp(c.air.y, c.h / 2 + 30, E.floorY() - c.h / 2 - 30) + Math.sin(t / 210) * 4;
        } else { const [hx, hy] = handNow(c.air, t); tx = hx; ty = hy + Math.sin(t / 240) * 3; }
        c.pose.x = damp(c.pose.x, tx, dt, c.airEdge ? 110 : 38);
        c.pose.y = damp(c.pose.y, ty, dt, c.airEdge ? 60 : 38);
        c.pose.z = damp(c.pose.z || 0, c.airEdge ? 0 : 26, dt, 120);
        c.pose.sx = c.pose.sy = damp(c.pose.sx || 1, c.airEdge ? 1 : 0.92, dt, 90);
        c.pose.rz = damp(c.pose.rz || 0, 0, dt, 90); c.pose.rx = 0; c.pose.ry = 0;
        if (t - c.t0 > 60000) { c.state = 'fade'; c.t0 = t; }   // pc/air.js lets it go well before this
        break;
      }
      case 'flight': {
        if (theme.fly(E, c, (t - c.t0) / 1000, dt) || t - c.t0 > 6000) {
          c.state = 'rest'; c.t0 = t;
          if (theme.landed) theme.landed(E, c);
          if (c.saved) c.pendingIcon = true;
        }
        break;
      }
      case 'rest': {
        if (theme.rest) theme.rest(E, c, (t - c.t0) / 1000, dt);
        const hold = theme.restHold == null ? 0.25 : theme.restHold;
        if ((c.pendingIcon || c.saved) && t - c.t0 > hold * 1000) { c.pendingIcon = false; toIcon(c); }
        // a large file still arriving keeps its card (and its progress line) until it's in
        else if (t - c.t0 > 25000 && !(c.progress > 0 && c.progress < 1 && !c.paused && t - (c.progT || 0) < 30000)) { c.state = 'fade'; c.t0 = t; }
        break;
      }
      case 'icon': {
        const u = clamp((t - c.t0) / 460, 0, 1);
        const e = 1 - Math.pow(1 - u, 3);
        const s = lerp(c.iconFrom.s, c.iconScale, e);
        c.pose.sx = c.pose.sy = s;
        c.pose.z = damp(c.pose.z, 0, dt, 60);
        c.pose.rx = damp(c.pose.rx, 0, dt, 60); c.pose.ry = damp(c.pose.ry, 0, dt, 60); c.pose.rz = damp(c.pose.rz, 0, dt, 80);
        if (c.label) {
          const lh = (c.h * s) / 2;
          c.label.style.transform = `translate3d(${c.pose.x}px, ${c.pose.y + lh + 5}px, 0) translateX(-50%)`;
          c.label.style.opacity = String(sstep(0.3, 1, u));
        }
        if (t - c.t0 > 2400) { c.state = 'fade'; c.t0 = t; }
        break;
      }
      case 'fade': {
        const u = clamp((t - c.t0) / 420, 0, 1);
        c.opacity = 1 - u;
        if (c.label) c.label.style.opacity = String(1 - u);
        if (u >= 1) { c.remove(); return; }
        break;
      }
      case 'cancel': {
        const done = theme.cancelFly ? theme.cancelFly(E, c, (t - c.t0) / 1000, dt) : genericCancel(c, (t - c.t0) / 1000, dt);
        if (done) { c.remove(); return; }
        break;
      }
      case 'fail': {
        const u = clamp((t - c.t0) / 700, 0, 1);
        c.sat = 1 - u * 0.8;
        c.pose.z = damp(c.pose.z, 0, dt, 70);
        c.pose.x += Math.sin(u * 46) * 2.2 * (1 - u);
        c.pose.rx = damp(c.pose.rx, 0, dt, 80);
        c.opacity = 1 - sstep(0.55, 1, u);
        if (u >= 1) { c.remove(); return; }
        break;
      }
      case 'out': {
        if (theme.flyOut(E, c, (t - c.t0) / 1000, dt)) { c.remove(); return; }
        break;
      }
      default: break;
    }
    // progress line for large files still uploading after landing
    if ((c.state === 'rest' || c.state === 'flight') && c.progress > 0 && c.progress < 1 && !c.saved) {
      if (!c.bar) { c.bar = document.createElement('div'); c.bar.className = 'bar'; c.bar.appendChild(document.createElement('i')); hud.appendChild(c.bar); (c.extraEls = c.extraEls || []).push(c.bar); }
      c.bar.style.width = c.w + 'px';
      c.bar.style.transform = `translate3d(${c.pose.x - c.w / 2}px, ${c.pose.y + c.h / 2 + 8}px, 0)`;
      c.bar.firstChild.style.transform = `scaleX(${clamp(c.progress, 0, 1)})`;
      c.bar.style.opacity = '1';
      // transfer speed under the line (large files only: it needs a moment to be meaningful), or that it's paused
      if (c.rate > 0 || c.paused) {
        if (!c.rateEl) { c.rateEl = document.createElement('div'); c.rateEl.className = 'rate'; hud.appendChild(c.rateEl); (c.extraEls = c.extraEls || []).push(c.rateEl); }
        const r = c.rate;
        c.rateEl.textContent = c.paused ? 'Paused, waiting for the phone' : (r >= 1e7 ? Math.round(r / 1e6) : (r / 1e6).toFixed(1)) + ' MB/s';
        c.rateEl.style.transform = `translate3d(${c.pose.x}px, ${c.pose.y + c.h / 2 + 15}px, 0) translateX(-50%)`;
        c.rateEl.style.opacity = '1';
      }
    } else {
      if (c.bar) c.bar.style.opacity = '0';
      if (c.rateEl) c.rateEl.style.opacity = '0';
    }
  }
  function genericCancel(c, ts) {
    const u = clamp(ts / 0.32, 0, 1);
    c.pose.x += -E.dirIn() * (0.4 + u * 2.6) * 16;
    c.pose.z = 0;
    const half = c.w / 2;
    return S.side === 'right' ? c.pose.x - half > S.W + 4 : c.pose.x + half < -4;
  }

  function frame(t) {
    const dt = Math.min(50, Math.max(1, t - last));
    last = t;
    clock = t;
    R.setTime(t / 1000);

    // approach state from tracked cards
    let prox = 0, py = S.anchor * S.H, crossing = false, tc = null;
    for (const c of cards.values()) {
      if (c.state === 'track' && c.msg) {
        const p = c.proximity();
        if (p >= prox) { prox = p; py = clamp(E.mapY(c.msg.y + c.msg.h / 2, c.msg.ph || 860), 0, S.H); tc = c; }
        const half = (c.w * (c.pose.sx || 1)) / 2;
        const cx = E.mapX(c.msg.x + c.msg.w / 2, c.msg.pw || 400);
        if (S.side === 'right' ? cx - half < S.W : cx + half > 0) crossing = true;
      }
    }
    AP.p = damp(AP.p, prox, dt, prox > AP.p ? 40 : 110);
    AP.y = prox > 0.001 ? damp(AP.y, py, dt, 30) : AP.y;
    AP.crossing = crossing; AP.card = tc;

    const prevPoses = new Map();
    for (const c of cards.values()) prevPoses.set(c, Object.assign({}, c.pose));
    for (const c of [...cards.values()]) updateCard(c, t, dt);
    if (theme.update) theme.update(E, AP, dt / 1000);
    updateParticles(dt);

    // ---- draw, when what's drawn changes. While effects run (particles, the theme's own, an approach, a hologram)
    // that's every frame; otherwise only when a card's look changes, and then the theme has nothing to draw.
    const live = !!(puffs.length || glows.length || segs.length || AP.p > 0.003 || AP.hold > 0 || AP.hover > 0 ||
      (theme.busy && theme.busy(E)) || [...cards.values()].some((c) => c.revealMode === 2 && c.visible && !c.hiddenOnPC));
    const look = live ? null : lookOf(prevPoses);
    const draw = GL_OK && (live || dirty || look !== drawnLook);
    if (draw) {
      R.clear();
      if (live && theme.drawBackground) theme.drawBackground(E, AP);
      for (const c of cards.values()) if (c.visible && !c.hiddenOnPC) shadowFor(c);
      vapPack.n = 0; puffSprites('under', vapPack); R.drawVapor(vapPack);
      sprPack.n = 0; glowSprites('under', sprPack); R.drawSprites(sprPack);
      R.drawStreaks(segList());
      if (live && theme.drawUnder) theme.drawUnder(E, AP);
      for (const c of cards.values()) {
        if (!c.visible || c.hiddenOnPC) continue;
        if (c.state === 'track' && c.msg) {
          // skip cards that are still entirely on the phone
          const half = (c.w * (c.pose.sx || 1)) / 2 + 4;
          if (S.side === 'right' ? c.pose.x - half > S.W : c.pose.x + half < 0) continue;
        }
        c.prev = prevPoses.get(c) || c.pose;
        if (c.sheets) drawSheets(c);
        R.drawCard(c);
      }
      sprPack.n = 0; puffSprites('over', sprPack); glowSprites('over', sprPack); R.drawSprites(sprPack);
      if (live && theme.drawOver) theme.drawOver(E, AP);
      drawnLook = look;
    }
    dirty = false;

    // a hold or hover the PC/phone stopped reporting fades out instead of staying on screen
    if (AP.hold > 0 && t - (AP.holdAt || 0) > 4000) AP.hold = 0;
    if (AP.hover > 0 && t - (AP.hoverAt || 0) > (AP.hoverCap || 8000)) AP.hover = 0;
    // an animation's own effects never outlive the cards they belong to by more than a few seconds
    let themeBusy = !!(theme.busy && theme.busy(E));
    if (themeBusy && !cards.size) {
      if (!themeBusySince) themeBusySince = t;
      else if (t - themeBusySince > 8000) { if (theme.reset) theme.reset(E); themeBusy = false; themeBusySince = 0; }
    } else themeBusySince = 0;
    const busy = cards.size || puffs.length || glows.length || segs.length || AP.p > 0.003 || AP.hold > 0 || AP.hover > 0 || themeBusy;
    if (busy) {
      idleSince = 0;
      // nothing on screen changed (a card resting while its file arrives): look again in a moment, not every frame
      if (!draw && !live) {
        raf = -1;
        slowT = setTimeout(() => { slowT = 0; raf = requestAnimationFrame(frame); }, 100);
        return;
      }
      raf = requestAnimationFrame(frame);
      return;
    }
    if (!idleSince) idleSince = t;
    if (t - idleSince > 300) {
      raf = 0;
      if (GL_OK) R.clear();
      drawnLook = null;
      if (!idleSent) { idleSent = true; requestAnimationFrame(() => api.send('fx:idle')); }
      return;
    }
    raf = requestAnimationFrame(frame);
  }

  // what the cards on screen look like, rounded below what can be seen (a damped value creeping toward its end isn't a
  // change); "m": the card moved this frame, so it was drawn blurred and is drawn again once it stops
  const q = (v, k) => Math.round((v == null ? 0 : v) * k);
  const poseKey = (p) => q(p.x, 50) + ',' + q(p.y, 50) + ',' + q(p.z, 50) + ',' + q(p.rx, 1e4) + ',' + q(p.ry, 1e4) +
    ',' + q(p.rz, 1e4) + ',' + q(p.sx == null ? 1 : p.sx, 1e4) + ',' + q(p.sy == null ? 1 : p.sy, 1e4);
  function lookOf(prevPoses) {
    let s = '';
    for (const c of cards.values()) {
      if (!c.visible || c.hiddenOnPC) continue;
      const k = poseKey(c.pose), b = prevPoses.get(c);
      s += c.id + ':' + k + (b && poseKey(b) !== k ? 'm' : '') + ',' + q(c.opacity, 1e3) + ',' + q(c.sat, 1e3) + ',' +
        q(c.bright, 1e3) + ',' + q(c.reveal, 1e3) + ',' + (c.revealMode || 0) + ',' + q(c.gloss, 1e3) + ',' +
        (c.back || 0) + ',' + q(c.w, 50) + ',' + q(c.h, 50) + ',' + q(c.shadowK, 1e3) + ';';
    }
    return s;
  }

  window.addEventListener('resize', () => { S.W = innerWidth; S.H = innerHeight; applySize(); });
  api.send('fx:ready');
})();
