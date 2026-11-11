'use strict';
/* The first-time tour: the window dims and each real control in turn is lit, with an arrow and a line on what it does.
 * Shown once on a new install and once more after updating to this layout, when the window is first seen (main: tour),
 * and again from Settings › Show the tour again. Esc skips it. A question
 * (pairing, Quick Share, files to accept) comes on top of it: panel.js front() keeps the tour under any question and
 * gives the keyboard back to it after. */
(function () {
  const api = window.flick;
  const $ = (id) => document.getElementById(id);
  const el = $('tour'), hole = $('tourHole'), arrow = $('tourArrow'), box = $('tourBox');
  const count = $('tourCount'), title = $('tourTitle'), text = $('tourText');
  const back = $('tourBack'), next = $('tourNext'), skip = $('tourSkip'), fxBtn = $('tourFx');
  const fxOff = () => !!(window.flickState && !window.flickState.fx);

  // what each step lights, if it shows (Send files and Transfers show for the tour even with nothing connected or
  // moving: body.touring, tour.css; Connect even with a phone connected: start()). Devices, History and Settings are
  // on the bar (nav.js). (Clipboard sync is named once Advanced settings has it: a phone with the features connected)
  const STEPS = [
    { at: ['cnBtn'], t: 'Connect a device', d: 'Press and hold Connect here, or on your phone. The other device asks to allow it: check that both show the same code.' },
    { at: ['sendFiles'], t: 'Send files', d: 'Once a device is connected, pick files to send here. You can also drop files anywhere on this window.' },
    { at: ['xf'], t: 'Transfers', d: 'Files on the move show here, at the top of the window, with how far each one has got.' },
    { at: ['tabDevices'], t: 'Devices', d: 'Your phones and your other computers with Flick. Drop files on a device there to send them to it.' },
    { at: ['tabHistory'], t: 'History', d: 'Every file you send and receive is listed here.' },
    { at: ['tabSettings'], t: 'Settings and Advanced', d: () => 'Where received files are saved, this PC’s name, notifications and updates. At the bottom, Advanced settings has the fun extras: animations, Air grab, ' + ($('advRowPhone').hidden ? '' : 'clipboard sync, ') + 'keyboard shortcuts and more.' + (fxOff() ? ' Animations are off to start with.' : '') },
  ];
  let step = -1, target = null, lastRect = '', tick = 0, before = null, wanted = false;
  const words = text.parentNode;       // (the step's words: they scroll when the box can't hold them, very large text)
  const isOpen = () => !el.hidden;
  const shown = (x) => x && x.getClientRects().length > 0 && !x.closest('[hidden]:not(#xf):not(#sendRow)');
  const question = () => [...document.querySelectorAll('.modal')].some((m) => !m.hidden);

  function start() {
    if (isOpen()) return;
    before = document.activeElement;
    api.send('panel:action', { what: 'tourDone' });      // (once, also if Flick is closed halfway through it)
    document.body.classList.add('touring');
    // (Connect shows for the tour with a phone connected too, when Home has it out of the way, nav.css: its first
    // step has it to light. Put back as it was after)
    wanted = !$('cn').classList.contains('want');
    $('cn').classList.add('want');
    el.hidden = false;
    go(0);
  }
  function end(done) {
    if (!isOpen()) return;
    el.hidden = true;
    document.body.classList.remove('touring');
    clearInterval(tick); tick = 0;
    step = -1; target = null; lastRect = '';
    if (wanted) $('cn').classList.remove('want');
    wanted = false;
    // (the keyboard goes back where it was, if that still shows (nothing had it on a first start; Show the tour again's
    // link is in Settings, closed for the tour); else to Connect, or with a phone connected to Send files, on Home)
    const ok = (x) => x && x !== document.body && x.isConnected && x.getClientRects().length > 0;
    const b = [before, $('cnBtn'), $('sendFiles'), $('tabHome')].find(ok);
    before = null;
    setTimeout(() => { if (b && !question()) try { b.focus({ preventScroll: !done }); } catch (e) { /* ignore */ } }, 0);
  }
  function go(i) {
    step = Math.max(0, Math.min(STEPS.length - 1, i));
    const s = STEPS[step];
    target = s.at.map((id) => $(id)).find(shown) || null;
    count.textContent = 'Step ' + (step + 1) + ' of ' + STEPS.length;
    title.textContent = s.t;
    text.textContent = typeof s.d === 'function' ? s.d() : s.d;
    back.hidden = step === 0;
    skip.hidden = step === STEPS.length - 1;
    // (the last step, the animations off: one tap turns them on, and the chosen one plays)
    fxBtn.hidden = step !== STEPS.length - 1 || !fxOff();
    next.textContent = step === STEPS.length - 1 ? 'Done' : 'Next';
    words.scrollTop = 0;
    // (a control taller than half the window, Settings at large text: its top is lit, at the top, with room for the box)
    if (target) target.scrollIntoView({ block: target.offsetHeight > window.innerHeight * 0.45 ? 'start' : 'center' });
    lastRect = '';
    place();
    clearInterval(tick);
    tick = setInterval(place, 250);     // (the window's text size, a list drawn anew: the light follows its control)
    if (!question()) next.focus({ preventScroll: true });
  }
  // the light on the control, and the box with the arrow pointing at it: under it if there's room, else over it
  function place() {
    if (!isOpen()) return;
    const W = window.innerWidth, H = window.innerHeight, pad = 6, gap = 14;
    let r = target && target.getBoundingClientRect();
    if (!r || !r.width) r = null;
    const key = r ? [r.left, r.top, r.width, r.height, W, H].map(Math.round).join() : 'none' + W + 'x' + H;
    if (key === lastRect) return;
    lastRect = key;
    box.style.maxHeight = '';
    if (!r) { hole.hidden = true; arrow.hidden = true; box.style.top = Math.max(8, (H - box.offsetHeight) / 2) + 'px'; return; }
    const top = Math.max(2, r.top - pad), bottom = Math.min(H - 2, r.bottom + pad, r.height > H * 0.45 ? top + H * 0.32 : Infinity);
    const left = Math.max(2, r.left - pad), right = Math.min(W - 2, r.right + pad);
    hole.hidden = false; arrow.hidden = false;
    Object.assign(hole.style, { left: left + 'px', top: top + 'px', width: (right - left) + 'px', height: Math.max(0, bottom - top) + 'px' });
    // under the control if it fits there, else over it if it fits there, else on the side with more room, made to fit it
    // (its words scroll): it never covers the control it's about
    const below = H - bottom - gap - 8, above = top - gap - 8;
    const bh0 = box.offsetHeight;
    const down = !(below >= bh0 || (above < bh0 && below >= above));
    if (bh0 > (down ? above : below)) box.style.maxHeight = Math.max(110, down ? above : below) + 'px';
    const bh = box.offsetHeight;
    const y = down ? Math.max(8, top - gap - bh) : Math.min(bottom + gap, H - bh - 8);
    box.style.top = Math.max(8, y) + 'px';
    // the arrow: between the box and the light, at the control's middle (kept over the box)
    const bx = box.getBoundingClientRect();
    const ax = Math.max(bx.left + 18, Math.min(bx.right - 18, (left + right) / 2));
    arrow.classList.toggle('up', !down);
    arrow.style.left = (ax - 9) + 'px';
    arrow.style.top = (down ? bx.bottom - 1 : bx.top - 9) + 'px';
  }

  back.onclick = () => go(step - 1);
  next.onclick = () => (step >= STEPS.length - 1 ? end(true) : go(step + 1));
  skip.onclick = () => end(false);
  fxBtn.onclick = () => {
    api.send('panel:set', { key: 'fx', value: true });
    if (window.flickState) window.flickState.fx = true;
    fxBtn.hidden = true;
    text.textContent = 'Animations are on. Change or turn them off any time in Settings › Advanced settings › Look and sound.';
    next.focus();
  };
  // Esc skips (a question on top answers Esc itself); Tab goes round the tour's own buttons; the up and down arrows
  // and Page Up and Down scroll the step's words when the box can't hold them (very large text: the keyboard is on a
  // button, outside them, where those keys would scroll nothing)
  window.addEventListener('keydown', (e) => {
    if (!isOpen() || question()) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); end(false); return; }
    const page = Math.max(20, words.clientHeight - 20);
    const by = { ArrowDown: 20, ArrowUp: -20, PageDown: page, PageUp: -page }[e.key];
    if (by && !e.ctrlKey && !e.altKey && !e.metaKey && words.scrollHeight > words.clientHeight) { e.preventDefault(); words.scrollTop += by; return; }
    if (e.key === 'ArrowRight' && document.activeElement && box.contains(document.activeElement)) { e.preventDefault(); if (step < STEPS.length - 1) go(step + 1); return; }
    if (e.key === 'ArrowLeft' && document.activeElement && box.contains(document.activeElement)) { e.preventDefault(); if (step > 0) go(step - 1); return; }
    if (e.key !== 'Tab') return;
    const f = [skip, fxBtn, back, next].filter((x) => !x.hidden);
    const i = f.indexOf(document.activeElement);
    e.preventDefault();
    f[(i < 0 ? 0 : i + (e.shiftKey ? f.length - 1 : 1)) % f.length].focus();
  }, true);
  window.addEventListener('resize', () => { lastRect = ''; place(); });

  // once, when main says so (a new install, or the first start after updating: with the first state that comes while
  // the window is seen); Settings › Show the tour again any time (nav.js)
  let asked = false;
  api.on('panel:state', (s) => { window.flickState = s; if (s.tour && !asked) { asked = true; setTimeout(start, 400); } });
  window.flickTour = { start, end, isOpen };
})();
