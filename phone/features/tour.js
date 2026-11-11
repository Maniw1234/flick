/* The first-time tour: the screen dims and the real buttons are lit one at a time, each with an arrow and a line on what
 * it does: Connect, sending files, Transfers, your devices and History (in the ••• menu), Settings and Advanced settings.
 * Once, the first time Flick opens after a new install (the app marks it: pref newInstall '1'; pref 'tour' '1' once
 * shown), once nothing of the user's own is over the screens; Settings › Help › Show the tour again brings it back.
 * Esc or Back skips it. A question (a device asking to
 * pair, files waiting for Accept) comes on top of it (phones.js: .fphask, above it; it blocks .ftour like the rest).
 * Written for Android 9's WebView (Chromium 66): no inert (Tab is kept in here by hand), no :focus-visible, no flex gap,
 * no optional chaining, no replaceChildren or getAnimations. */
(window.FlickFeatures = window.FlickFeatures || []).push(function (A, X) {
  'use strict';
  const h = X.h;
  const $ = (id) => document.getElementById(id);
  const fxOff = () => A.settings.effects === false;
  // a ••• menu item by its words (the menu is the app's own, opened for the tour)
  const item = (label) => () => Array.from(document.querySelectorAll('#sheetItems .sitem')).find((b) => {
    const s = b.querySelector('span'); return !!s && s.textContent === label;
  }) || null;
  const visible = (e) => !!e && e.offsetWidth > 0 && e.offsetHeight > 0;

  const ALL = [
    { scene: () => (A.st.connected ? 'main' : 'pair'), at: () => $(A.st.connected ? 'pcBtn' : 'connect'), t: 'Connect a device',
      d: () => (A.st.connected ? 'You’re connected. Tap here to see the connection, or to send to another device.'
        : 'Hold Connect, then tap Allow on your PC or other phone. Check that both show the same code.') },
    { scene: 'main', at: () => $('addBtn'), t: 'Send files', d: 'Tap + to add photos and files. To send one, drag it off the edge of the screen toward your PC.' },
    { scene: 'main', at: () => (visible($('count')) ? $('count') : document.querySelector('#toolbar .pill')), t: 'Transfers',
      d: 'While files are sending, how far they’ve got shows here. Tap it to see every transfer.' },
    { scene: 'menu', at: item('Other phones'), t: 'Your devices', d: 'Tap ••• for this menu. Other phones lists the phones you’ve connected: send them files, or make one ring to find it.', only: () => A.has('peerState') },
    { scene: 'menu', at: item('History'), t: 'History', d: 'Files you’ve sent and received are listed here.', only: () => A.has('history') },
    // (the Google Play version has no Updates in Settings: Play updates it)
    { scene: 'menu', at: item('Settings'), t: 'Settings', d: 'This phone’s name, where files from your PC are saved' + (A.INFO.store === 'play' ? ' and notifications.' : ', notifications and updates.') },
    { scene: 'settings', at: () => $('setAdvBtn'), t: 'Advanced settings',
      d: () => 'The fun extras are in here: animations, Air grab, clipboard sync, auto-send and more.' + (fxOff() ? ' Animations are off to start with: turn them on here.' : '') },
  ];
  let STEPS = ALL;

  // ---- the overlay: the light (a hole in the dimming), the arrow, and the box
  let el = null, hole = null, arrow = null, box = null, count = null, title = null, text = null, back = null, next = null, skip = null, fxBtn = null;
  let step = -1, scene = null, from = null, lastKey = '', tick = 0, waitT = 0;
  // mine: the screen the tour showed last (the app showing another since is left alone); wasConn: connected as it began;
  // before: where the keyboard was; blocked: what it put out of reach
  let mine = null, wasConn = false, before = null, blocked = [];
  function build() {
    el = h('div', 'ftour');
    el.hidden = true;
    hole = h('div', 'trhole'); hole.setAttribute('aria-hidden', 'true');
    arrow = h('div', 'trarrow'); arrow.setAttribute('aria-hidden', 'true');
    box = h('div', 'trbox');
    box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-labelledby', 'fTourT'); box.setAttribute('aria-describedby', 'fTourD');
    const say = h('div', 'trsay');
    say.setAttribute('aria-live', 'polite'); say.setAttribute('aria-atomic', 'true');
    count = h('div', 'trcount');
    title = h('div', 'trtitle'); title.id = 'fTourT';
    text = h('div', 'trtext'); text.id = 'fTourD';
    say.append(count, title, text);
    const btns = h('div', 'trbtns');
    skip = h('button', 'trskip', 'Skip tour');
    fxBtn = h('button', 'trfx', 'Turn on animations');
    // (the last step, the animations off: one tap turns them on)
    fxBtn.onclick = () => {
      A.haptic('tick');
      A.setEffects(true);                           // (as the switch in Advanced settings does: app.js)
      fxBtn.hidden = true;
      text.textContent = 'Animations are on. Change or turn them off any time in Advanced settings.';
      try { next.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
    };
    back = h('button', 'trback', 'Back');
    next = h('button', 'trnext', 'Next');
    skip.onclick = () => { A.haptic('soft'); finish(); };
    back.onclick = () => { A.haptic('tick'); go(step - 1); };
    next.onclick = () => { A.haptic('tick'); if (step >= STEPS.length - 1) finish(); else go(step + 1); };
    btns.append(skip, fxBtn, h('span', 'trgap'), back, next);
    box.append(say, btns);
    el.append(hole, arrow, box);
    document.body.appendChild(el);
  }
  const isOpen = () => !!(el && !el.hidden);
  const question = () => !!document.querySelector('.fphask');

  // what each step shows under it: the Connect screen, the files, the ••• menu or Settings (the app's own, as a tap would)
  // (the screen is looked at with every step, not remembered: the app may have shown the other one meanwhile, a PC
  // that connected or one whose code is being checked, and the step's button wasn't there to light)
  function screenTo(name) { if (A.st.screen !== name) A.showScreen(name); mine = name; }
  function setScene(sc) {
    const fresh = sc !== scene;
    if (fresh && scene === 'menu' && A.sheetOpen) A.closeSheet();
    if (fresh && scene === 'settings') A.closeSettings();
    scene = sc;
    if (sc === 'pair' || sc === 'main') screenTo(sc);
    else if (sc === 'menu') {
      screenTo('main');
      const m = $('moreBtn');
      if ((fresh || !A.sheetOpen) && m && typeof m.onclick === 'function') m.onclick();
    } else if (sc === 'settings') {
      if (fresh || $('settings').hidden || $('settings').classList.contains('closing')) A.openSettings();
    }
  }

  // something of the user's own over the screens (a page, a file full screen, the address prompt, the tips, the ringing
  // screen): the tour waits for it, as for a question. It opened over the page, its light on a button under it
  const covered = () => !!document.querySelector('.fpage:not([hidden]), .fpv:not([hidden]), .ftips:not([hidden]), .fring:not([hidden])') || !!($('ask') && !$('ask').hidden);
  function show() {
    clearTimeout(waitT);
    if (isOpen()) return;
    // (a device asking to pair is answered first; then the tour)
    if (question() || covered()) { waitT = setTimeout(show, 800); return; }
    A.pref.set('tour', '1');                        // once, even if Flick is closed halfway
    if (!el) build();
    STEPS = ALL.filter((s) => !s.only || s.only());
    from = mine = A.st.screen;
    wasConn = !!A.st.connected;
    before = document.activeElement;
    scene = null;
    if (A.sheetOpen) A.closeSheet();
    A.closeSettings();
    el.hidden = false;
    // (not the shield a closing Settings leaves for a moment, "Show the tour again": taken off the page while out of
    // reach, it stayed so, and let taps through from then on)
    blocked = Array.from(document.body.children).filter((c) => c !== el && c.id !== 'toast' && c.id !== 'said' && c.tagName !== 'SCRIPT' && !c.classList.contains('fshield'));
    X.block('tour', blocked, true);
    go(0);
    clearInterval(tick);
    tick = setInterval(place, 250);                 // (a menu sliding in, Settings drawn anew: the light follows its button)
  }
  function finish() {
    if (!isOpen()) return false;
    clearInterval(tick); tick = 0;
    el.hidden = true;
    X.block('tour', blocked.concat(Array.from(document.body.children)), false);
    blocked = [];
    if (scene === 'menu' && A.sheetOpen) A.closeSheet();
    if (scene === 'settings') A.closeSettings();
    // Back where it began, unless the app showed another screen since the tour last did (a PC connected: the files; a
    // code being checked: the Connect screen), or a PC connected meanwhile: it ended on "Hold Connect", connected
    if (A.st.screen === mine) {
      const to = from === 'pair' && A.st.connected && !wasConn ? 'main' : from;
      if (to && A.st.screen !== to) A.showScreen(to);
    }
    // (a code to check that came meanwhile, a PC's or a phone's: the Connect screen shows it now; it waited behind the
    // tour, as behind Settings or a page: app.js covered)
    if (A.uncovered) A.uncovered();
    scene = null; step = -1; lastKey = '';
    // the keyboard and a screen reader go back where they were, or to the screen: they were left on a button that is gone
    const a = document.activeElement;
    if (!a || a === document.body || el.contains(a)) {
      const to = before && before !== document.body && before.isConnected && visible(before) && !before.closest('[data-fblock]') ? before : A.st.screen === 'pair' ? $('connect') : $('htitle');
      if (to && to.id === 'htitle' && !to.hasAttribute('tabindex')) to.tabIndex = -1;
      if (to) { try { to.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }
    }
    before = null;
    return true;
  }
  // (Android's Back, and Esc: after a question on top, which answers them first)
  X.back(90.5, finish);                 // (under a question: phones.js, 91 and 92)

  function go(i) {
    step = Math.max(0, Math.min(STEPS.length - 1, i));
    const s = STEPS[step];
    setScene(typeof s.scene === 'function' ? s.scene() : s.scene);
    count.textContent = 'Step ' + (step + 1) + ' of ' + STEPS.length;
    title.textContent = s.t;
    text.textContent = typeof s.d === 'function' ? s.d() : s.d;
    back.style.visibility = step === 0 ? 'hidden' : '';
    back.setAttribute('aria-hidden', String(step === 0));
    back.tabIndex = step === 0 ? -1 : 0;
    skip.hidden = step === STEPS.length - 1;
    fxBtn.hidden = step !== STEPS.length - 1 || !fxOff();
    next.textContent = step === STEPS.length - 1 ? 'Done' : 'Next';
    lastKey = '';
    place();
    // (Settings and the menu take the keyboard as they open: it comes back here once they have)
    for (const ms of [0, 160, 420]) setTimeout(keyHere, ms);
  }
  function keyHere() {
    if (!isOpen() || question() || box.contains(document.activeElement)) return;
    try { next.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
  }
  function target() {
    const s = STEPS[step];
    const t = s && s.at();
    if (t && scene === 'settings' && !t._seen) { t._seen = true; try { t.scrollIntoView({ block: 'center' }); } catch (e) { /* ignore */ } }
    return visible(t) ? t : null;
  }
  // the light on the button, and the box with its arrow under it if there's room, else over it
  function place() {
    if (!isOpen() || step < 0) return;
    const W = window.innerWidth, H = window.innerHeight, pad = 6, gap = 14;
    const cs = getComputedStyle(document.documentElement);
    const top0 = (parseFloat(cs.getPropertyValue('--top')) || 0) + 6, bot0 = (parseFloat(cs.getPropertyValue('--bottom')) || 0) + 6;
    const t = target();
    const r = t ? t.getBoundingClientRect() : null;
    const key = r ? [r.left, r.top, r.width, r.height, W, H, box.offsetHeight].map(Math.round).join() : 'none' + W + 'x' + H;
    if (key === lastKey) return;
    lastKey = key;
    box.style.maxHeight = '';
    // (no button to light: the dimming is the light's own shadow, so the overlay dims the screen itself)
    el.classList.toggle('nolight', !r);
    if (!r) { hole.hidden = true; arrow.hidden = true; box.style.top = Math.max(top0, (H - box.offsetHeight) / 2) + 'px'; return; }
    const top = Math.max(2, r.top - pad), left = Math.max(2, r.left - pad), right = Math.min(W - 2, r.right + pad);
    const bottom = Math.min(H - 2, r.bottom + pad, r.height > H * 0.45 ? top + H * 0.32 : Infinity);
    hole.hidden = false; arrow.hidden = false;
    hole.style.left = left + 'px'; hole.style.top = top + 'px';
    hole.style.width = (right - left) + 'px'; hole.style.height = Math.max(0, bottom - top) + 'px';
    // under the button if it fits there, else over it if it fits there, else on the side with more room, made to fit it
    // (its words scroll): it never covers the button it's about
    const below = H - bot0 - bottom - gap, above = top - gap - top0;
    const bh0 = box.offsetHeight;
    const over = !(below >= bh0 || (above < bh0 && below >= above));
    if (bh0 > (over ? above : below)) box.style.maxHeight = Math.max(120, over ? above : below) + 'px';
    const bh = box.offsetHeight;
    const y = over ? Math.max(top0, top - gap - bh) : Math.min(bottom + gap, H - bot0 - bh);
    box.style.top = Math.max(top0, y) + 'px';
    const b = box.getBoundingClientRect();
    const ax = Math.max(b.left + 20, Math.min(b.right - 20, (left + right) / 2));
    arrow.classList.toggle('up', !over);
    arrow.style.left = (ax - 10) + 'px';
    arrow.style.top = (over ? b.bottom - 1 : b.top - 11) + 'px';
  }
  window.addEventListener('resize', () => { lastKey = ''; place(); });
  // Esc skips; the arrow keys move between the steps; Tab goes round the tour's own buttons (nothing behind it is inert
  // on Android 9: Tab is kept here by hand)
  window.addEventListener('keydown', (e) => {
    if (!isOpen() || question()) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); finish(); return; }
    const inBox = box.contains(document.activeElement);
    if (inBox && e.key === 'ArrowRight') { e.preventDefault(); e.stopImmediatePropagation(); if (step < STEPS.length - 1) go(step + 1); return; }
    if (inBox && e.key === 'ArrowLeft') { e.preventDefault(); e.stopImmediatePropagation(); if (step > 0) go(step - 1); return; }
    if (e.key !== 'Tab') return;
    e.preventDefault(); e.stopImmediatePropagation();
    const f = [skip, fxBtn, back, next].filter((x) => !x.hidden && x.tabIndex >= 0);
    const i = f.indexOf(document.activeElement);
    f[(i < 0 ? 0 : i + (e.shiftKey ? f.length - 1 : 1)) % f.length].focus();
  }, true);

  // ---- when: the first time Flick opens after a new install, once its first screen is up
  if (A.pref.get('newInstall', '0') === '1' && !A.pref.get('tour', '')) waitT = setTimeout(show, 900);

  // ---- Settings › Help: Show the tour again, first
  A.on('settings-end', (body) => {
    const row = h('button', 'srow nav');
    const lab = h('div', 'sl');
    lab.append(h('b', '', 'Show the tour again'), h('small', '', 'Where everything is: Connect, sending, Transfers, History, Settings'));
    row.appendChild(lab);
    row.onclick = () => { A.haptic('soft'); A.closeSettings(); setTimeout(show, 240); };
    const card = X.helpCard(body);
    card.insertBefore(row, card.firstChild);
  });
});
