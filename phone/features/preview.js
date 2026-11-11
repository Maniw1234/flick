/* A file full screen before sending it: photos (pinch or double-tap to zoom), videos (play), any other file as its
 * thumbnail. Swipe sideways (or Previous file / Next file, ← →) for the next or previous file of the view, down to
 * close; Send to <PC> sends it, and so does flicking it upward. app.js opens it through the 'preview' hook (a file's
 * menu › Preview, or two fingers spread on its card); the whole file comes from the app (mediaUrl: an address the page
 * may load it from). */
(window.FlickFeatures = window.FlickFeatures || []).push(function (A, X) {
  'use strict';
  const h = X.h;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const ease = 'cubic-bezier(.2,.9,.25,1)';
  const GAP = 18;                                   // between two files while swiping
  const SVG = {
    send: '<svg viewBox="0 0 24 24"><path d="M4 12h13M12 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    play: '<svg viewBox="0 0 24 24"><path d="M8.2 5.6v12.8a.8.8 0 0 0 1.2.7l10-6.4a.8.8 0 0 0 0-1.4l-10-6.4a.8.8 0 0 0-1.2.7z" fill="currentColor"/></svg>',
    pause: '<svg viewBox="0 0 24 24"><rect x="6.2" y="5" width="4.2" height="14" rx="1.3" fill="currentColor"/><rect x="13.6" y="5" width="4.2" height="14" rx="1.3" fill="currentColor"/></svg>',
    up: '<svg viewBox="0 0 24 24"><path d="M12 19V6M6.5 11.5L12 6l5.5 5.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    prev: '<svg viewBox="0 0 24 24"><path d="M14.5 5.5L8 12l6.5 6.5" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    next: '<svg viewBox="0 0 24 24"><path d="M9.5 5.5L16 12l-6.5 6.5" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  };

  // ---- the page: the black behind, three slides (previous, current, next), the bars on top
  const el = h('section', 'fpv');
  el.id = 'fPv'; el.hidden = true;
  el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true'); el.setAttribute('aria-label', 'Preview');
  const bg = h('div', 'pvbg');
  const track = h('div', 'pvtrack');
  const hint = h('div', 'pvhint');
  const hintT = h('span');
  hint.append(A.svgEl(SVG.up), hintT);
  const top = h('header', 'pvtop');
  const xBtn = h('button', 'pvx');
  xBtn.setAttribute('aria-label', 'Close');
  xBtn.appendChild(A.svgEl(X.SVG.close));
  const tName = X.nm('b'), tSub = h('small');
  const tBox = h('div', 'pvt');
  tBox.append(tName, tSub);
  // (a screen reader says the file and where it is in the view as they change: the next file's name, after Next file)
  tBox.setAttribute('aria-live', 'polite'); tBox.setAttribute('aria-atomic', 'true');
  // The previous and next file for a keyboard (← and → too) and a screen reader: a sideways swipe is a finger's, and
  // TalkBack's swipes move its own focus, so with either the preview showed one file and the rest of the view was out of
  // reach from it
  const prevBtn = h('button', 'pvx pvnav'), nextBtn = h('button', 'pvx pvnav');
  prevBtn.setAttribute('aria-label', 'Previous file'); prevBtn.appendChild(A.svgEl(SVG.prev));
  nextBtn.setAttribute('aria-label', 'Next file'); nextBtn.appendChild(A.svgEl(SVG.next));
  top.append(xBtn, tBox, prevBtn, nextBtn);
  const bot = h('footer', 'pvbot');
  const vBar = h('div', 'pvvbar');
  const vPlay = h('button', 'pvvp');
  const vNow = h('span', 'pvtime', '0:00'), vDur = h('span', 'pvtime', '0:00');
  const vSeek = h('input', 'pvseek');
  vSeek.type = 'range'; vSeek.min = '0'; vSeek.max = '1000'; vSeek.step = '1'; vSeek.value = '0';
  vSeek.setAttribute('aria-label', 'Position');
  vBar.append(vPlay, vNow, vSeek, vDur);
  const info = h('div', 'pvinfo');
  const openBtn = h('button', 'pvopen');
  openBtn.setAttribute('aria-label', 'Open in another app');
  openBtn.appendChild(A.svgEl(A.icons.open));
  const sendBtn = h('button', 'pvsend');
  const sendT = h('span');
  sendBtn.append(A.svgEl(SVG.send), sendT);
  const btns = h('div', 'pvbtns');
  btns.append(openBtn, sendBtn);
  bot.append(vBar, info, btns);
  el.append(bg, track, hint, top, bot);
  document.body.appendChild(el);
  const slides = [0, 1, 2].map(() => {
    const s = h('div', 'pvslide'), z = h('div', 'pvz');
    s.appendChild(z);
    s._z = z;
    track.appendChild(s);
    return s;
  });

  const S = { open: false, list: [], i: 0, it: null, W: innerWidth, H: innerHeight, dx: 0, busy: false, going: false, view: '', raf: 0, tapT: 0, last: null, seeking: false };
  const anims = [];                                // (see settle)
  const Z = { s: 1, x: 0, y: 0 };                   // the current slide's zoom and position
  const sent = new Set();                           // ids sent from here, until the PC has them
  const cur = () => slides[1];
  const kind = (it) => (it.kind === 'image' ? 'image' : it.kind === 'video' ? 'video' : 'file');
  const viewSig = () => A.V.cat + '|' + (A.V.path || '');
  const screens = () => ['pair', 'main', 'settings'].map((id) => document.getElementById(id));
  function mediaUrl(it) {
    const u = A.nc('mediaUrl', it.path || '', it.path ? '' : String(it.id || ''));
    return typeof u === 'string' ? u : '';
  }

  // ---- slides
  function fill(s, it) {
    if (s._it === it && it) return;
    unload(s);
    s._it = it || null; s._full = ''; s._thBad = false; s._card = null;
    s.className = 'pvslide';
    s.style.clipPath = '';
    const z = s._z;
    z.innerHTML = ''; z.style.transform = ''; z.style.opacity = ''; z.className = 'pvz';
    if (!it) return;
    const k = kind(it), th = A.thumbUrl(it);
    s.classList.add('k-' + k);
    if (k === 'image') {
      const img = h('img', 'pvimg');
      img.alt = ''; img.draggable = false; img.decoding = 'async';
      // (no thumbnail: the photo itself, once it comes; if it can't, its card: unseen)
      img.onerror = () => { if (s._img !== img) return; img.classList.add('bad'); s._thBad = true; unseen(s, it); };
      if (th) img.src = th; else s._thBad = true;
      s._img = img;
      z.appendChild(img);
    } else if (k === 'video') {
      const v = document.createElement('video');
      v.className = 'pvvid'; v.preload = 'none'; v.playsInline = true; v.setAttribute('playsinline', '');
      v.disablePictureInPicture = true;
      if (th) v.poster = th;
      const now = () => { if (s === cur() && s._it === it) renderVideo(); };
      for (const ev of ['play', 'pause', 'ended', 'loadedmetadata', 'durationchange']) v.addEventListener(ev, now);
      v.addEventListener('timeupdate', () => { if (s === cur() && s._it === it) renderTime(); });
      v.addEventListener('error', () => { if (s._it === it && v.getAttribute('src')) { s.classList.add('bad'); now(); } });
      const pb = h('div', 'pvplay');
      pb.appendChild(A.svgEl(SVG.play));
      s._vid = v;
      z.append(v, pb);
    } else z.appendChild(docCard(it, th));         // a document, an app, a song…: its thumbnail as a page, or its type
  }
  function docCard(it, th, note) {
    const card = h('div', 'pvdoc');
    const pic = h('div', 'pvdpic' + (it.kind === 'apk' || it.kind === 'audio' ? ' app' : ''));
    const ext = h('span', 'pvext', String(it.ext || (/\.([a-z0-9]{1,5})$/i.exec(it.name || '') || [])[1] || '').toUpperCase().slice(0, 4) || 'FILE');
    pic.appendChild(ext);
    if (th) {
      const img = h('img');
      img.alt = ''; img.draggable = false;
      img.onload = () => ext.remove();
      img.onerror = () => img.remove();
      img.src = th;
      pic.appendChild(img);
    }
    card.append(pic, X.nm('b', '', it.name));
    if (note) card.appendChild(h('small', '', note));
    return card;
  }
  // A photo nothing of which can be shown (no thumbnail, and the file itself doesn't load: 0 bytes, damaged): its card, as
  // a document has, saying so. It was a black screen, a broken picture's little icon in its corner
  function unseen(s, it) {
    if (s._it !== it || s._full || !s._thBad || s._noWhole !== it || s._card) return;
    s._card = docCard(it, '', 'This photo can’t be shown here');
    s._z.appendChild(s._card);
  }
  function unload(s) {
    const v = s._vid;
    if (v) { try { v.pause(); v.removeAttribute('src'); v.load(); } catch (e) { /* ignore */ } }
    s._vid = null; s._img = null;
  }
  // The photo at the size the screen shows it (a thumbnail shows until it has loaded), and the whole of it once zoomed
  // in. A phone's 12 MP photo is 48 MB once decoded: loaded whole, a few of them took the page past half a gigabyte
  // (a phone short of memory closes it) and each was slow to open. The app makes the screen's size (the thumbnail's
  // address with s=<longest side in device pixels>, or id= for Flick's list; turned as its EXIF says); it answers 404
  // for anything that isn't a still photo, and that (a GIF, an animated WebP), a size it couldn't make, or an older
  // app's thumbnail in its place is shown from the whole file. "" from the app: the thumbnail is all there is.
  // s._full: '' / 'sized' / 'whole'. s._loading: the file whose photo is on its way (whole: s._loadingWhole); a slide
  // given another file meanwhile loads that one's own (when it was only "loading", a photo swiped to quickly kept its
  // blurry thumbnail)
  // The size asked for: the longest side the photo is shown at unzoomed, in device pixels, with the phone held either
  // way (turned, it needs no other), in steps of 256 (the app keeps each size it made); the screen's longest side when
  // the photo's own size isn't known
  function sizeFor(it) {
    const a = Math.min(S.W, S.H), b = Math.max(S.W, S.H), w = +it.w, ht = +it.h;
    const f = (W, H) => Math.max(w, ht) * Math.min(W / w, H / ht);
    const px = (w > 0 && ht > 0 ? Math.max(f(a, b), f(b, a)) : b) * (window.devicePixelRatio || 1);
    return clamp(Math.ceil(px / 256) * 256, 256, 4096);
  }
  function sizedUrl(it, px) {
    if (/^(gif|svg)$/i.test(it.ext || '') || /gif|svg/i.test(it.mime || '')) return '';
    const t = it.path ? A.thumbUrl(it) : '';
    if (t && t.indexOf('https://flick.local/t?') === 0) return t + '&s=' + px;
    return !it.path && it.id ? 'https://flick.local/t?id=' + encodeURIComponent(String(it.id)) + '&s=' + px : '';
  }
  function loadFull(s, whole) {
    const it = s._it;
    if (!it || kind(it) !== 'image' || s._full === 'whole' || (s._full && !whole)) return;
    if ((s._loading === it && (s._loadingWhole || !whole)) || (whole && s._noWhole === it)) return;
    const px = sizeFor(it);
    const sized = whole ? '' : sizedUrl(it, px);
    const url = sized || mediaUrl(it);
    if (!url) { if (whole) { s._noWhole = it; unseen(s, it); } return; }
    s._loading = it; s._loadingWhole = !sized;
    const im = new Image();
    im.decoding = 'async';
    const done = () => { if (s._loading === it && s._loadingWhole === !sized) s._loading = null; };
    im.onload = () => {
      const show = () => {
        done();
        if (s._it !== it || !s._img || s._full === 'whole') return;
        let as = 'whole';
        if (sized) {
          // (only a file's own size says the photo is no bigger: a Flick-list item's w and h are its thumbnail's, so a
          // 12 MP photo of the list counted as whole at the screen's size, and zoomed in it stayed that, upscaled)
          const n = Math.max(im.naturalWidth, im.naturalHeight), known = !!it.path && +it.w > 0 && +it.h > 0;
          if (known && n >= Math.max(+it.w, +it.h) * 0.98) as = 'whole';
          else if (n >= px * 0.9) as = 'sized';
          else { loadFull(s, true); return; }
        }
        im.className = 'pvimg'; im.alt = ''; im.draggable = false;
        s._img.replaceWith(im);
        s._img = im; s._full = as;
        if (as === 'sized' && s === cur() && Z.s > 1.01) loadFull(s, true);     // zoomed in meanwhile
      };
      if (im.decode) im.decode().then(show, show); else show();
    };
    im.onerror = () => { done(); if (!sized) { s._noWhole = it; unseen(s, it); } else if (s._it === it) loadFull(s, true); };
    im.src = url;
  }
  function place(dx) {
    S.dx = dx;
    for (let k = 0; k < 3; k++) slides[k].style.transform = 'translate3d(' + ((k - 1) * (S.W + GAP) + dx).toFixed(1) + 'px,0,0)';
  }
  // the size the current photo (or video, or its thumbnail) is shown at, unzoomed
  function fit(s) {
    const it = s._it || {};
    let w = 0, ht = 0;
    if (s._img && s._img.naturalWidth) { w = s._img.naturalWidth; ht = s._img.naturalHeight; }
    else if (s._vid && s._vid.videoWidth) { w = s._vid.videoWidth; ht = s._vid.videoHeight; }
    else if (+it.w > 0 && +it.h > 0) { w = +it.w; ht = +it.h; }
    else { w = S.W; ht = S.W; }
    const k = Math.min(S.W / w, S.H / ht);
    return { w: w * k, h: ht * k };
  }

  // ---- open, close
  A.on('preview', (o) => { if (o && o.item) open(o.item, o.rect); });
  // for Air grab (air.js): the file on screen, its video (to carry on from the same second on the PC), closing
  X.preview = {
    open: () => S.open,
    item: () => (S.open ? S.it : null),
    video: () => (S.open ? cur()._vid : null),
    rect: () => { const z = cur() && cur()._z; const r = z && (z.querySelector('img,video') || z).getBoundingClientRect(); return r && r.width ? r : null; },
    close: (fade) => { if (S.open) close(fade); },
  };
  function open(it, rect) {
    if (S.open || !it || it.dir) return;
    let list = A.viewFiles();
    let i = list.findIndex((x) => x.id === it.id);
    if (i < 0) { list = [it]; i = 0; }
    S.list = list; S.i = i; S.open = true; S.busy = false; S.going = false; S.view = viewSig();
    S.W = innerWidth; S.H = innerHeight;
    settle();                                       // (closed a moment ago: what its closing left behind)
    el.hidden = false;
    el.classList.remove('nochrome');
    fill(slides[0], list[i - 1]); fill(slides[1], list[i]); fill(slides[2], list[i + 1]);
    place(0);
    activate();
    X.block('preview', screens(), true);
    A.haptic('soft');
    const s = cur();
    if (rect && kind(it) !== 'file') {
      // grows out of its card
      const f = fit(s), to = cardTf(rect, f);
      ani(s, [{ clipPath: to.clip }, { clipPath: 'inset(0px 0px 0px 0px round 0px)' }], { duration: 300, easing: ease });
      ani(s._z, [{ transform: to.tf }, { transform: 'translate3d(0px,0px,0) scale(1)' }], { duration: 300, easing: ease });
    } else ani(s._z, [{ opacity: 0, transform: 'scale(.94)' }, { opacity: 1, transform: 'scale(1)' }], { duration: 240, easing: ease });
    for (const e of [bg, top, bot]) ani(e, [{ opacity: 0 }, { opacity: 1 }], { duration: 260, easing: 'ease-out' });
    setTimeout(() => { if (S.open) xBtn.focus({ preventScroll: true }); }, 60);
  }
  // where a card (rect) is, as the current slide's clip and zoom
  function cardTf(r, f) {
    const sc = Math.max(r.width / f.w, r.height / f.h);
    const tx = r.left + r.width / 2 - S.W / 2, ty = r.top + r.height / 2 - S.H / 2;
    return {
      tf: 'translate3d(' + tx.toFixed(1) + 'px,' + ty.toFixed(1) + 'px,0) scale(' + sc.toFixed(4) + ')',
      clip: 'inset(' + r.top.toFixed(1) + 'px ' + (S.W - r.right).toFixed(1) + 'px ' + (S.H - r.bottom).toFixed(1) + 'px ' + r.left.toFixed(1) + 'px round 14px)',
    };
  }
  // (fade: it fades where it is, instead of going back onto its card: the Connect screen takes the files' place)
  function close(fade) {
    if (!S.open) return false;
    S.open = false;
    clearTimeout(S.tapT); S.last = null;
    cancelAnimationFrame(S.raf);
    const s = cur(), it = s._it;
    if (s._vid) s._vid.pause();
    hint.style.opacity = '0';
    X.block('preview', screens(), false);
    // back onto its card, when it's a picture shown whole; otherwise it fades
    let r = null;
    if (!fade && it && kind(it) !== 'file' && Z.s <= 1.01 && Math.abs(S.dx) < 2) { A.showItem(it.id); r = A.cardRect(it.id); }
    const from = getComputedStyle(s._z).transform, fromO = getComputedStyle(bg).opacity;
    const ms = 260;
    if (r) {
      const to = cardTf(r, fit(s));
      ani(s, [{ clipPath: 'inset(0px 0px 0px 0px round 0px)' }, { clipPath: to.clip }], { duration: ms, easing: ease, fill: 'forwards' });
      ani(s._z, [{ transform: from === 'none' ? 'none' : from }, { transform: to.tf }], { duration: ms, easing: ease, fill: 'forwards' });
    } else ani(s._z, [{ opacity: getComputedStyle(s._z).opacity }, { opacity: 0, transform: (from === 'none' ? '' : from + ' ') + 'scale(.94)' }], { duration: 200, easing: 'ease-in', fill: 'forwards' });
    ani(bg, [{ opacity: fromO }, { opacity: 0 }], { duration: ms, easing: 'ease-out', fill: 'forwards' });
    for (const e of [top, bot]) ani(e, [{ opacity: getComputedStyle(e).opacity }, { opacity: 0 }], { duration: 160, fill: 'forwards' });
    setTimeout(() => {
      if (S.open) return;                          // opened again meanwhile
      el.hidden = true;
      settle();
      for (const x of slides) fill(x, null);
      S.list = []; S.it = null;
    }, ms + 20);
    return true;
  }
  // (its own animations are kept as they start: Element.getAnimations is newer than Android 9's WebView, and calling it
  // there stopped the preview opening at all)
  function ani(x, k, o) { const a = x.animate(k, o); anims.push(a); return a; }
  function settle() {
    for (const a of anims.splice(0)) a.cancel();
    if (el.getAnimations) for (const x of [el, bg, top, bot].concat(slides, slides.map((y) => y._z))) for (const a of x.getAnimations()) a.cancel();
    bg.style.opacity = '';
  }

  // ---- the current file: bars, the whole photo, the video
  function activate() {
    const s = cur(), it = s._it;
    S.it = it;
    // (the files beside it, off the screen until a swipe brings them, are out of a screen reader's reach: TalkBack read
    // the next file's name as part of this one, and moving onto it scrolled the preview sideways, half onto that file)
    for (const x of slides) { const away = x !== s; x.inert = away; if (away) x.setAttribute('aria-hidden', 'true'); else x.removeAttribute('aria-hidden'); }
    Z.s = 1; Z.x = 0; Z.y = 0;
    applyZ(false);
    for (const x of [slides[0], slides[2]]) { if (x._vid) x._vid.pause(); x._z.style.transform = ''; }
    if (!it) return;
    tName.textContent = it.name;
    renderSub();
    const bits = [A.fmtSize(it.size), A.fmtWhen(it.mtime || it.added)];
    if (it.kind === 'image' && it.path && it.w && it.h) bits.push(it.w + ' × ' + it.h);   // (a list item's are its thumbnail's)
    if (it.kind === 'video' && it.dur) bits.push(A.fmtDur(it.dur));
    info.textContent = bits.join(' · ');
    renderSend();
    const k = kind(it);
    el.classList.toggle('isvideo', k === 'video');
    if (k === 'image') loadFull(s);
    if (k === 'video' && s._vid && !s._vid.getAttribute('src')) {
      const u = mediaUrl(it);
      if (u) { s._vid.preload = 'metadata'; s._vid.src = u; } else s.classList.add('bad');
    }
    if (k === 'video') renderVideo();
    // the next photo is ready before it's swiped to
    setTimeout(() => { if (S.open && S.it === it && slides[2]._it) loadFull(slides[2]); }, 450);
    if (S.i >= S.list.length - 4) A.moreFiles();     // the next page of a long category
  }
  const dim = (b, off) => { if (off) b.setAttribute('aria-disabled', 'true'); else b.removeAttribute('aria-disabled'); };
  function renderSub() {
    const V = A.V, more = V.more && V.cat !== 'dir' && V.cat !== 'shelf';
    const total = more ? Math.max(S.list.length, V.total || 0) : S.list.length;
    const sub = total > 1 ? A.fmtNum(S.i + 1) + ' of ' + A.fmtNum(total) : '';
    if (tSub.textContent !== sub) tSub.textContent = sub;     // (unchanged, it isn't said again)
    // (at either end its button stays where it was, and in reach, dimmed: a disabled one dropped the keyboard's focus)
    prevBtn.hidden = nextBtn.hidden = total < 2;
    dim(prevBtn, S.i <= 0);
    dim(nextBtn, S.i >= S.list.length - 1);
  }
  // (a PC this phone isn't paired with, or not any more: "Send to a PC", which opens Connect)
  function renderSend() {
    sendT.textContent = X.sendLabel('Send to ');
    sendBtn.classList.toggle('off', !A.st.connected);
  }
  A.on('conn', () => { if (S.open) renderSend(); });
  // the view's files again (a page more of a category, a file sent away): S.i follows the current one
  function resync() {
    const list = A.viewFiles(), it = S.it;
    const i = it ? list.findIndex((x) => x.id === it.id) : -1;
    if (i >= 0) { S.list = list; S.i = i; }
    renderSub();
  }
  // A page more of a long category came while a file shows: the files beside it are the view's now. They were taken
  // again only on the next move, so a file at the end of what had come (swiped to before the next page did) stayed the
  // last one: a swipe at it only bounced, and it took no other way on
  function more() {
    if (!S.open || S.busy) return;                  // (a move under way takes them again as it ends)
    resync();
    fill(slides[0], S.list[S.i - 1]); fill(slides[2], S.list[S.i + 1]);
  }

  function renderVideo() {
    const s = cur(), v = s._vid;
    const playing = !!(v && !v.paused && !v.ended);
    s.classList.toggle('playing', playing);
    vPlay.innerHTML = '';
    vPlay.appendChild(A.svgEl(playing ? SVG.pause : SVG.play));
    vPlay.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    renderTime();
  }
  function renderTime() {
    const v = cur()._vid;
    if (!v) return;
    const d = isFinite(v.duration) && v.duration > 0 ? v.duration : S.it && S.it.dur ? S.it.dur / 1000 : 0;
    vNow.textContent = A.fmtDur(v.currentTime * 1000);
    vDur.textContent = A.fmtDur(d * 1000);
    const p = d ? clamp(v.currentTime / d, 0, 1) : 0;
    if (!S.seeking) vSeek.value = String(Math.round(p * 1000));
    vSeek.style.setProperty('--p', (+vSeek.value / 10).toFixed(1) + '%');
  }
  function toggleVideo() {
    const s = cur(), v = s._vid;
    if (!v) return;
    if (s.classList.contains('bad')) { A.toast('This video can’t play here. Tap Open to watch it in another app', 3000); return; }
    if (v.paused || v.ended) {
      const p = v.play();
      if (p && p.catch) p.catch((e) => { if (e && e.name === 'NotSupportedError') { s.classList.add('bad'); renderVideo(); } });
    } else v.pause();
  }
  vPlay.onclick = toggleVideo;
  vSeek.addEventListener('input', () => {
    const v = cur()._vid;
    if (!v || !isFinite(v.duration)) return;
    S.seeking = true;
    v.currentTime = v.duration * (+vSeek.value) / 1000;
    renderTime();
  });
  vSeek.addEventListener('change', () => { S.seeking = false; });

  // ---- zoom
  function applyZ(anim) {
    const z = cur()._z;
    z.classList.toggle('tw', !!anim);
    z.style.transform = 'translate3d(' + Z.x.toFixed(1) + 'px,' + Z.y.toFixed(1) + 'px,0) scale(' + Z.s.toFixed(4) + ')';
    el.classList.toggle('zoomed', Z.s > 1.01);
    if (Z.s > 1.01 && S.it && kind(S.it) === 'image' && cur()._full !== 'whole') loadFull(cur(), true);   // (zoomed in: the whole photo)
  }
  // how far a photo zoomed to s may move (none while it fits the screen); rubber: past that, but harder
  function bound(s, x, y, rubber) {
    const f = fit(cur()), bx = Math.max(0, (f.w * s - S.W) / 2), by = Math.max(0, (f.h * s - S.H) / 2);
    const c = (v, b) => (!rubber ? clamp(v, -b, b) : v > b ? b + (v - b) * 0.35 : v < -b ? -b + (v + b) * 0.35 : v);
    return { x: c(x, bx), y: c(y, by) };
  }
  function zoomAt(s, px, py) {                      // px, py: from the middle of the screen; that point stays put
    const qx = (px - Z.x) / Z.s, qy = (py - Z.y) / Z.s;
    const b = bound(s, px - s * qx, py - s * qy);
    Z.s = s; Z.x = b.x; Z.y = b.y;
  }
  const zoomable = () => !!(S.it && kind(S.it) === 'image' && !cur()._card);   // (a photo shown as its card isn't)
  function doubleTap(x, y) {
    if (!zoomable()) return;
    if (Z.s > 1.01) { Z.s = 1; Z.x = 0; Z.y = 0; } else zoomAt(2.5, x - S.W / 2, y - S.H / 2);
    applyZ(true);
    A.haptic('soft');
  }

  // ---- gestures. One finger: unzoomed, sideways = next/previous, up = send, down = close; zoomed, it moves the photo.
  // Two fingers: zoom (pinch in past the screen's size to close). A tap shows or hides the bars (a video: plays).
  let G = null;
  const pt = (t) => ({ x: t.clientX, y: t.clientY });
  function velocity(sm) {
    const a = sm[sm.length - 1];
    let i = sm.length - 1;
    while (i > 0 && a.t - sm[i - 1].t < 90) i--;
    const b = sm[Math.max(0, i - 1)], dt = Math.max(8, a.t - b.t);
    if (performance.now() - a.t > 100) return { x: 0, y: 0 };
    return { x: (a.x - b.x) / dt, y: (a.y - b.y) / dt };
  }
  el.addEventListener('touchstart', (e) => {
    if (!S.open || S.busy) return;
    if (e.target.closest && e.target.closest('.pvtop, .pvbot')) return;   // the buttons and the video's bar
    if (e.cancelable) e.preventDefault();
    if (e.touches.length === 2 && zoomable()) {
      const a = pt(e.touches[0]), b = pt(e.touches[1]);
      if (G && G.mode === 'swipe') place(0);
      G = { mode: 'pinch', d0: Math.max(20, Math.hypot(a.x - b.x, a.y - b.y)), s0: Z.s, x0: Z.x, y0: Z.y, mx: (a.x + b.x) / 2 - S.W / 2, my: (a.y + b.y) / 2 - S.H / 2 };
      return;
    }
    if (e.touches.length !== 1) return;
    const p = pt(e.touches[0]);
    G = { mode: '', x0: p.x, y0: p.y, t0: performance.now(), ts: e.timeStamp, zx: Z.x, zy: Z.y, sm: [{ t: performance.now(), x: p.x, y: p.y }] };
  }, { passive: false });
  el.addEventListener('touchmove', (e) => {
    if (!G || !S.open) return;
    if (e.cancelable) e.preventDefault();
    if (G.mode === 'pinch') {
      if (e.touches.length < 2) return;
      const a = pt(e.touches[0]), b = pt(e.touches[1]);
      const s = clamp(G.s0 * Math.hypot(a.x - b.x, a.y - b.y) / G.d0, 0.5, 6);
      const mx = (a.x + b.x) / 2 - S.W / 2, my = (a.y + b.y) / 2 - S.H / 2;
      // the point that was between the fingers stays between them
      const qx = (G.mx - G.x0) / G.s0, qy = (G.my - G.y0) / G.s0;
      const bd = s < 1 ? { x: mx - s * qx, y: my - s * qy } : bound(s, mx - s * qx, my - s * qy, true);
      Z.s = s; Z.x = bd.x; Z.y = bd.y;
      applyZ(false);
      bg.style.opacity = String(clamp(0.4 + (s - 0.5) * 1.2, 0.4, 1));
      return;
    }
    const t = e.touches[0];
    if (!t) return;
    const p = pt(t), dx = p.x - G.x0, dy = p.y - G.y0;
    G.sm.push({ t: performance.now(), x: p.x, y: p.y });
    if (G.sm.length > 30) G.sm.splice(0, G.sm.length - 30);
    if (!G.mode) {
      if (Math.hypot(dx, dy) < 8) return;
      G.mode = Z.s > 1.01 ? 'pan' : Math.abs(dx) > Math.abs(dy) ? 'swipe' : dy < 0 ? 'up' : 'down';
      if (G.mode === 'up' && !A.st.connected) G.mode = 'down0';         // nothing to send to: it only gives a little
    }
    if (G.mode === 'pan') {
      const b = bound(Z.s, G.zx + dx, G.zy + dy, true);
      Z.x = b.x; Z.y = b.y;
      applyZ(false);
    } else if (G.mode === 'swipe') {
      const edge = (dx > 0 && S.i === 0) || (dx < 0 && S.i >= S.list.length - 1);
      place(edge ? dx * 0.3 : dx);
    } else if (G.mode === 'up' || G.mode === 'down0') {
      const y = G.mode === 'up' ? Math.min(0, dy) : dy * 0.25;
      Z.y = y; Z.s = 1 - Math.min(0.22, -Math.min(0, y) / S.H * 0.6);
      applyZ(false);
      const go = y < -110;
      hint.style.opacity = G.mode === 'up' ? String(clamp(-y / 70, 0, 1)) : '0';
      hint.classList.toggle('go', go);
      hintT.textContent = go ? 'Release to send' : 'Flick up to send to ' + X.pcName();
    } else if (G.mode === 'down') {
      const y = Math.max(0, dy);
      Z.y = y; Z.x = dx * 0.6; Z.s = 1 - Math.min(0.3, y / S.H * 0.5);
      applyZ(false);
      bg.style.opacity = String(clamp(1 - y / (S.H * 0.55), 0.15, 1));
      el.classList.add('nochrome');
    }
  }, { passive: false });
  function touchEnd(e) {
    if (!G || !S.open) return;
    if (e.touches && e.touches.length) {
      // one finger of two lifted: pinched in that far it closes, otherwise the other finger moves the photo
      if (G.mode === 'pinch' && e.touches.length === 1) {
        if (Z.s < 0.8) { G = null; bg.style.opacity = ''; close(); return; }
        const p = pt(e.touches[0]);
        G = { mode: 'pan', x0: p.x, y0: p.y, zx: Z.x, zy: Z.y, sm: [{ t: performance.now(), x: p.x, y: p.y }] };
        endPinch();
        G.zx = Z.x; G.zy = Z.y;
      }
      return;
    }
    const g = G;
    G = null;
    if (g.mode === 'pinch') { endPinch(); return; }
    const v = g.sm ? velocity(g.sm) : { x: 0, y: 0 };
    const last = g.sm ? g.sm[g.sm.length - 1] : { x: g.x0, y: g.y0 };
    const dx = last.x - g.x0, dy = last.y - g.y0;
    if (!g.mode) {
      // (timed by the touches' own times: a tap that came while the page was busy is still a tap)
      const held = e.timeStamp > 0 && g.ts > 0 ? e.timeStamp - g.ts : performance.now() - g.t0;
      if (held < 350) tap(g.x0, g.y0);
      return;
    }
    if (g.mode === 'pan') {
      const b = bound(Z.s, Z.x + v.x * 120, Z.y + v.y * 120);      // a little glide, then inside the edges
      Z.x = b.x; Z.y = b.y;
      applyZ(true);
    } else if (g.mode === 'swipe') {
      if ((dx < -S.W * 0.22 || v.x < -0.45) && S.i < S.list.length - 1) go(1);
      else if ((dx > S.W * 0.22 || v.x > 0.45) && S.i > 0) go(-1);
      else slideTo(0);
    } else if (g.mode === 'up' || g.mode === 'down0') {
      hint.style.opacity = '0';
      if (g.mode === 'up' && (dy < -110 || v.y < -0.75)) send('up');
      else { Z.s = 1; Z.x = 0; Z.y = 0; applyZ(true); if (g.mode === 'down0' && dy < -40) A.toast('Not connected to your PC', 2200); }
    } else if (g.mode === 'down') {
      if (dy > 120 || v.y > 0.75) close();
      else { Z.s = 1; Z.x = 0; Z.y = 0; applyZ(true); bg.style.opacity = ''; el.classList.remove('nochrome'); }
    }
  }
  el.addEventListener('touchend', touchEnd);
  el.addEventListener('touchcancel', touchEnd);
  // The preview never scrolls: the files beside the current one (moved out of sight) made it wider than the screen, and
  // anything brought into view in it (a screen reader's focus, the keyboard's) slid the whole of it sideways, the files
  // behind showing at the edge. (features.css clips it; a WebView older than that is put back here)
  el.addEventListener('scroll', () => { if (el.scrollLeft || el.scrollTop) { el.scrollLeft = 0; el.scrollTop = 0; } });
  function endPinch() {
    bg.style.opacity = '';
    if (Z.s < 0.8) { close(); return; }
    if (Z.s <= 1) { Z.s = 1; Z.x = 0; Z.y = 0; } else { const b = bound(Z.s, Z.x, Z.y); Z.x = b.x; Z.y = b.y; }
    applyZ(true);
  }
  // one tap shows or hides the bars (on a video it plays or pauses); two taps zoom a photo
  function tap(x, y) {
    if (S.it && kind(S.it) === 'video') { toggleVideo(); return; }
    const t = performance.now(), l = S.last;
    if (l && t - l.t < 300 && Math.hypot(x - l.x, y - l.y) < 40) { clearTimeout(S.tapT); S.last = null; doubleTap(x, y); return; }
    S.last = { t, x, y };
    clearTimeout(S.tapT);
    S.tapT = setTimeout(() => { S.last = null; if (S.open) el.classList.toggle('nochrome'); }, 280);
  }

  // ---- next, previous
  function slideTo(to, done) {
    const from = S.dx, t0 = performance.now(), ms = 240;
    cancelAnimationFrame(S.raf);
    (function step(t) {
      const u = clamp((t - t0) / ms, 0, 1), e = 1 - Math.pow(1 - u, 3);
      place(from + (to - from) * e);
      if (u < 1) S.raf = requestAnimationFrame(step); else if (done) done();
    })(performance.now());
  }
  function go(d) {
    const ni = S.i + d;
    // (one move at a time: another press while one slides is let go. It sent this one's slide back, its end never came,
    // and the preview took no swipe, key or Send again until it was closed)
    if (S.going) return;
    if (S.busy || ni < 0 || ni >= S.list.length) { slideTo(0); return; }
    S.busy = true; S.going = true;
    if (cur()._vid) cur()._vid.pause();
    A.haptic('tick');
    slideTo(-d * (S.W + GAP), () => {
      if (d > 0) slides.push(slides.shift()); else slides.unshift(slides.pop());
      S.i = ni; S.it = cur()._it;
      resync();
      fill(slides[0], S.list[S.i - 1]); fill(slides[2], S.list[S.i + 1]);
      place(0);
      S.busy = false; S.going = false;
      activate();
    });
  }
  // the buttons and ← →: at either end the file gives a little, as a swipe there does
  function step(d) {
    if (!S.open || S.going || !S.it) return;
    const ni = S.i + d;
    if (ni >= 0 && ni < S.list.length) { go(d); return; }
    if (S.busy) return;
    place(-d * 28);
    slideTo(0);
  }
  prevBtn.onclick = () => step(-1);
  nextBtn.onclick = () => step(1);
  // ← and → anywhere in the preview, but on the video's position (they move it there); also with nothing focused (a tap
  // on the photo leaves the focus nowhere), unless a menu or question is open over it
  document.addEventListener('keydown', (e) => {
    if (!S.open || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const t = e.target;
    const nowhere = t === document.body || t === document.documentElement;
    if (t === vSeek || el.inert || (!el.contains(t) && (!nowhere || A.sheetOpen))) return;
    e.preventDefault();
    step(e.key === 'ArrowRight' ? 1 : -1);
  });

  // ---- sending: the button, or a flick upward. It leaves the screen; a file that stays on the phone comes back.
  function send(how) {
    const it = S.it, s = cur(), z = s._z;
    if (!it || S.busy) return;
    if (!A.st.connected) { Z.s = 1; Z.x = 0; Z.y = 0; applyZ(true); A.toast('Not connected to your PC', 2200); A.haptic('reject'); return; }
    S.busy = true;
    if (s._vid) s._vid.pause();
    // the card the PC shows: about the grid's size, the shape of the file
    const f = fit(s), w = Math.min(220, S.W * 0.52), hh = clamp(w * f.h / Math.max(1, f.w), w * 0.56, w * 1.5);
    const from = { left: (S.W - w) / 2, top: (S.H - hh) / 2, width: w, height: hh, right: (S.W + w) / 2, bottom: (S.H + hh) / 2 };
    sent.add(it.id);
    A.sendItems([it], { quiet: true, from, say: true });   // (said once it is on the PC: app.js onSaved)
    A.toast('Sending to ' + X.pcName() + '…', 1800);
    const side = A.st.side === 'right' ? -1 : 1;     // where the PC is
    z.classList.remove('tw');
    z.classList.add('fly');
    z.style.opacity = '0';
    z.style.transform = how === 'up'
      ? 'translate3d(' + Z.x.toFixed(1) + 'px,' + (-S.H * 0.9).toFixed(1) + 'px,0) scale(.72)'
      : 'translate3d(' + (side * S.W).toFixed(1) + 'px,' + Z.y.toFixed(1) + 'px,0) rotate(' + (side * -6) + 'deg) scale(.8)';
    const stays = !!it.path || !!A.st.keep;           // Flick-list files leave the list once sent (Settings)
    setTimeout(() => {
      z.classList.remove('fly');
      if (!S.open || S.it !== it) { S.busy = false; return; }
      if (stays) {
        Z.s = 0.92; Z.x = 0; Z.y = 0;
        applyZ(false);
        void z.offsetWidth;
        z.style.opacity = '';
        Z.s = 1;
        applyZ(true);
        S.busy = false;
        return;
      }
      // gone from the view: the next file takes its place
      S.list = S.list.filter((x) => x.id !== it.id);
      if (!S.list.length) { S.busy = false; z.style.opacity = ''; close(); return; }
      S.i = Math.min(S.i, S.list.length - 1);
      fill(slides[1], S.list[S.i]); fill(slides[0], S.list[S.i - 1]); fill(slides[2], S.list[S.i + 1]);
      place(0);
      S.busy = false;
      activate();
      ani(cur()._z, [{ opacity: 0, transform: 'scale(.94)' }, { opacity: 1, transform: 'scale(1)' }], { duration: 220, easing: ease });
    }, 320);
  }
  sendBtn.onclick = () => { A.haptic('tick'); if (X.sendPc()) send('btn'); else X.toConnect(); };
  A.on('sent', (items) => {
    const mine = (items || []).filter((x) => sent.has(x.id));
    for (const x of mine) sent.delete(x.id);
    if (mine.length && S.open) A.toast('Sent to ' + X.pcName(), 1800);
  });
  openBtn.onclick = () => {
    const it = S.it;
    if (!it) return;
    if (cur()._vid) cur()._vid.pause();
    const r = it.path ? A.nc('openPath', it.path) : A.nc('open', String(it.id));
    if (r === false || r === null) A.toast('Couldn’t open this file', 2200);
  };
  xBtn.onclick = () => { A.haptic('soft'); close(); };

  // ---- the rest of the app
  X.back(80, () => close());
  A.on('native', (e) => {
    if ((e.t === 'pause' || e.t === 'locked') && S.open && cur()._vid) cur()._vid.pause();
  });
  A.on('view', () => { if (S.open && viewSig() !== S.view) close(); else more(); });   // another tab or folder; a page more
  window.addEventListener('resize', () => {
    if (!S.open) return;
    S.W = innerWidth; S.H = innerHeight;
    place(0);
    const b = bound(Z.s, Z.x, Z.y);
    Z.x = b.x; Z.y = b.y;
    applyZ(false);
  });
});
