/* First-run walkthrough: four short steps with a small animated hand, once, after this phone first connects to a PC
 * it has just paired with: flick a file, select several, send from the PC, Settings. Skippable; Settings › Show tips
 * again shows it any time. pref 'tips': '1' = shown, 'old' = a phone paired before this version (not shown by itself). */
(window.FlickFeatures = window.FlickFeatures || []).push(function (A, X) {
  'use strict';
  const h = X.h;
  const last = A.pref.get('lastPc', '');
  if (!A.pref.get('tips', '') && last && A.pref.get('token:' + last, '')) A.pref.set('tips', 'old');

  const HAND = '<svg viewBox="0 0 40 54" aria-hidden="true"><g fill="#f5f5f7" stroke="#1c1c1e" stroke-width="1.6" stroke-linejoin="round">' +
    '<rect x="1.5" y="26" width="9" height="17" rx="4.5" transform="rotate(-36 6 34.5)"/><rect x="8" y="19" width="28" height="27" rx="9"/>' +
    '<rect x="27.5" y="17.5" width="8" height="13" rx="4"/><rect x="20" y="14.5" width="8.5" height="15" rx="4.25"/>' +
    '<rect x="11.5" y="1.5" width="9.5" height="29" rx="4.75"/><rect x="12" y="44" width="20" height="9" rx="2.5"/></g></svg>';
  const CURSOR = '<svg viewBox="0 0 18 24" aria-hidden="true"><path d="M2 2v17.5l4.6-4.3 3.1 6.8 3-1.4-3.1-6.6 6.3-.4z" fill="#fff" stroke="#1c1c1e" stroke-width="1.5" stroke-linejoin="round"/></svg>';
  const STEPS = [
    { title: 'Flick files to your PC', line: 'Drag a file off the edge of the screen, toward your PC.', stage: flickStage },
    { title: 'Send several at once', line: 'Press and hold a file, then tap more. Drag them together.', stage: selectStage },
    { title: 'Send from your PC', line: 'Drag a file to the edge of your PC screen, on your phone’s side.', stage: pcStage },
    { title: 'Settings and more', line: 'Tap ••• for Settings, History and the media remote.', stage: menuStage },
  ];

  // ---- the illustrations (drawn for a phone to the right of its PC; mirrored when it's on the left)
  const d = (cls, parent) => { const e = h('div', cls); if (parent) parent.appendChild(e); return e; };
  function phone(stage, cls) {
    const p = d('tph ' + (cls || ''), stage);
    for (let i = 0; i < 8; i++) d('tc g' + (i % 6) + ' c' + i, p);
    return p;
  }
  function pc(stage) {
    const m = d('tpc', stage);
    d('tneck', stage); d('tbase', stage);
    return m;
  }
  function hand(stage, cls) { const e = d('thand ' + cls, stage); e.appendChild(A.svgEl(HAND)); return e; }
  function flickStage(stage) {
    const m = pc(stage);
    d('tglow', m); d('tc tland g0', m);
    phone(stage, 'right lift1');
    d('tc g0 tfly', stage);
    hand(stage, 'h1');
  }
  function selectStage(stage) {
    const p = phone(stage, 'mid sel');
    for (const i of [0, 3, 4]) d('tchk k' + i, p.querySelector('.c' + i));
    d('tpill', p);
    d('tring', stage);
    hand(stage, 'h2');
  }
  function pcStage(stage) {
    const m = pc(stage);
    d('tfile', m);
    const c = d('tcur', m);
    c.appendChild(A.svgEl(CURSOR));
    phone(stage, 'right');
    d('tedge', stage);
    d('tc g5 tnew', stage);
  }
  function menuStage(stage) {
    const p = phone(stage, 'mid menu');
    d('tbar', p); const mo = d('tmore', p);
    for (let i = 0; i < 3; i++) d('tdot', mo);
    const sh = d('tsheet', p);
    for (let i = 0; i < 4; i++) { const r = d('trow r' + i, sh); d('tri', r); d('trl', r); }
    hand(stage, 'h4');
  }

  // ---- the overlay
  let el = null, step = 0, waitT = 0, sx = null;
  function build() {
    el = h('div', 'ftips');
    el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true'); el.setAttribute('aria-labelledby', 'fTipsT');
    const box = d('tbox', el);
    const skip = h('button', 'tskip', 'Skip');
    skip.onclick = () => { A.haptic('soft'); finish(); };
    const sbox = d('tstagebox', box);
    const stage = d('tstage', sbox);
    const t = h('div', 'tt'); t.id = 'fTipsT';
    const l = h('div', 'tl');
    const foot = d('tfoot');
    const dots = d('tdots', foot);
    for (let i = 0; i < STEPS.length; i++) dots.appendChild(h('i'));
    const next = h('button', 'tnext');
    next.onclick = () => { A.haptic('tick'); if (step < STEPS.length - 1) go(step + 1); else finish(); };
    foot.append(skip, next);
    box.append(t, l, foot);
    el._p = { stage, t, l, dots, next, skip };
    // a swipe sideways also moves between the steps
    box.addEventListener('touchstart', (e) => { const p = e.touches[0]; sx = e.touches.length === 1 ? { x: p.clientX, y: p.clientY } : null; }, { passive: true });
    box.addEventListener('touchend', (e) => {
      const p = e.changedTouches[0];
      if (!sx || !p) return;
      const dx = p.clientX - sx.x, dy = p.clientY - sx.y;
      sx = null;
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.4) go(dx < 0 ? Math.min(STEPS.length - 1, step + 1) : Math.max(0, step - 1));
    }, { passive: true });
    document.body.appendChild(el);
  }
  function go(i) {
    const p = el._p, s = STEPS[i];
    const fwd = i >= step;
    step = i;
    p.stage.innerHTML = '';
    p.stage.className = 'tstage st' + (i + 1) + (A.st.side === 'left' && (i === 0 || i === 2) ? ' flip' : '');
    s.stage(p.stage);
    p.t.textContent = s.title;
    p.l.textContent = s.line;
    for (let k = 0; k < p.dots.children.length; k++) p.dots.children[k].classList.toggle('on', k === i);
    p.next.textContent = i < STEPS.length - 1 ? 'Next' : 'Done';
    p.skip.hidden = i === STEPS.length - 1;
    for (const e of [p.stage, p.t, p.l]) e.animate([{ opacity: 0, transform: 'translateX(' + (fwd ? 18 : -18) + 'px)' }, { opacity: 1, transform: 'none' }], { duration: 260, easing: 'cubic-bezier(.2,.9,.25,1)' });
  }
  function isOpen() { return !!(el && !el.hidden && !el.classList.contains('closing')); }
  function show() {
    clearTimeout(waitT);
    A.pref.set('tips', '1');                          // once, even if Flick is closed halfway
    if (!el) build();
    el.hidden = false;
    el.classList.remove('closing');
    X.block('tips', Array.from(document.body.children).filter((c) => c !== el && c.id !== 'toast' && c.tagName !== 'SCRIPT'), true);
    step = 0;
    go(0);
    setTimeout(() => { if (isOpen()) el._p.next.focus({ preventScroll: true }); }, 60);
  }
  function finish() {
    if (!isOpen()) return false;
    el.classList.add('closing');
    X.block('tips', Array.from(document.body.children), false);
    setTimeout(() => { if (el.classList.contains('closing')) { el.hidden = true; el.classList.remove('closing'); el._p.stage.innerHTML = ''; } }, 220);
    return true;
  }
  X.back(90, finish);

  // ---- when: the first time a PC this phone paired with is connected, once the file browser is on screen
  function busy() {
    const open = (id) => { const e = document.getElementById(id); return !!(e && !e.hidden); };
    return A.st.screen !== 'main' || A.sheetOpen || open('settings') || open('fPv') || open('fRing') || open('ask') || !!document.querySelector('.fpage:not([hidden])');
  }
  function later(n) {
    clearTimeout(waitT);
    waitT = setTimeout(() => {
      if (A.pref.get('tips', '') || !A.st.connected) return;
      if (busy()) { if (n < 40) later(n + 1); return; }
      show();
    }, n ? 1500 : 1300);
  }
  A.on('conn', () => { if (A.st.connected && !A.pref.get('tips', '')) later(0); });

  // ---- Settings › Help, the last section (shared with Send feedback, features/feedback.js): Show tips again comes first
  A.on('settings-end', (body) => {
    const row = h('button', 'srow nav');
    const lab = h('div', 'sl');
    lab.append(h('b', '', 'Show tips again'), h('small', '', 'How to flick files, select several and more'));
    row.appendChild(lab);
    row.onclick = () => { A.haptic('soft'); A.closeSettings(); setTimeout(show, 240); };
    const card = X.helpCard(body);
    card.insertBefore(row, card.firstChild);
  });
});
