'use strict';
/* The bar at the bottom: Home, Devices, History, Settings. Home is the main view; the others are views over it
 * (Devices, History, and Settings with its own page, Advanced settings, in five groups). A view opened from
 * Home (Share with a browser, Browse your phone, Clipboard history) counts as Home; Send feedback, opened from
 * Settings, as Settings. Each module says how to close its view (window.flickViews); one place at a time. */
(function () {
  const $ = (id) => document.getElementById(id);
  const tabs = [...document.querySelectorAll('#tabs .tab')];
  const setView = $('setView'), advView = $('advView'), advList = $('advList');
  const groups = [...document.querySelectorAll('#advBody .advg')];
  const views = () => window.flickViews || {};
  const shown = (id) => !$(id).hidden;
  const question = () => [...document.querySelectorAll('.modal')].some((m) => !m.hidden);

  // which place is showing: worked out from the views, however they were opened or closed
  function current() {
    if (shown('setView') || shown('advView')) return 'settings';
    if (shown('peerView')) return 'devices';
    if (shown('fHistView')) return 'history';
    return 'home';
  }
  let place = 'home';
  function mark() {
    const c = current(), was = place;
    place = c;
    for (const t of tabs) { if (t.dataset.tab === c) t.setAttribute('aria-current', 'page'); else t.removeAttribute('aria-current'); }
    // (Devices or History closed onto Home by itself, with Escape: the keyboard, left in it, goes to its place on the
    // bar, not to the page, where a screen reader says nothing. Not when something has it already: panel.js front())
    if (c === 'home' && (was === 'devices' || was === 'history')) setTimeout(() => {
      const a = document.activeElement;
      if (current() !== 'home' || question() || (window.flickTour && window.flickTour.isOpen())) return;
      if (!a || a === document.body || !a.getClientRects().length) $(was === 'devices' ? 'tabDevices' : 'tabHistory').focus();
    }, 0);
  }

  // Settings, and Advanced settings with one of its groups (or its list of them)
  function showSet(on) { setView.hidden = !on; if (!on) showAdv(false); }
  let group = null;
  function showAdv(on, g) {
    advView.hidden = !on;
    group = on && g ? g : null;
    advList.hidden = !!group;
    for (const s of groups) s.hidden = s.dataset.g !== group;
    $('advTitle').textContent = group ? groups.find((s) => s.dataset.g === group).dataset.title : 'Advanced settings';
    $('advBody').scrollTop = 0;
    if (window.flickClips) window.flickClips();
  }

  function closeAll() {
    const v = views();
    for (const k of Object.keys(v)) try { v[k](false); } catch (e) { /* ignore */ }
    showSet(false);
  }
  function go(tab) {
    if (question()) return;
    const was = current();
    closeAll();
    if (tab === 'devices' && views().peer) views().peer(true);
    else if (tab === 'history' && views().hist) views().hist(true);
    // (in reach at once, for the keyboard: it was out of it if Send feedback was over it a moment ago, panel.js front())
    else if (tab === 'settings') { showSet(true); setView.inert = false; setView.querySelector('.wbody').scrollTop = 0; setView.focus(); }
    else if (tab === 'home' && was === 'home') $('main').scrollTo({ top: 0 });
    mark();
  }
  for (const t of tabs) t.onclick = () => { go(t.dataset.tab); if (t.dataset.tab !== 'settings' || !shown('setView')) t.focus(); };

  // Advanced settings: the list, then a group; Back goes from the group to the list, then to Settings
  $('advBtn').onclick = () => { showAdv(true); advView.focus(); };
  for (const r of advList.querySelectorAll('.advrow')) r.onclick = () => { showAdv(true, r.dataset.g); advView.focus(); };
  function advBack() {
    if (group) { const g = group; showAdv(true); const r = advList.querySelector('[data-g="' + g + '"]'); if (r) r.focus(); return; }
    showAdv(false);
    setView.inert = false;             // (in reach again at once, for the keyboard: panel.js front() says the same a moment later)
    $('advBtn').focus();
  }
  $('advBack').onclick = advBack;
  // (Phone features shows once a phone with the features has connected, as it did in Settings: features.js; the line
  // under Advanced settings names clipboard sync only then)
  const phoneRow = () => {
    $('advRowPhone').hidden = $('fSetBox').hidden;
    $('advSub').textContent = 'Animations, placement, shortcuts, Air grab' + ($('fSetBox').hidden ? '' : ', clipboard sync') + ' and connections';
    if (group === 'phone' && $('fSetBox').hidden) showAdv(true);
  };
  new MutationObserver(phoneRow).observe($('fSetBox'), { attributes: true, attributeFilter: ['hidden'] });
  phoneRow();

  // Send feedback closes back onto Settings: the keyboard goes back to its link there
  new MutationObserver(() => { if ($('fbView').hidden && shown('setView') && advView.hidden) setTimeout(() => { if (!question()) $('fbOpen').focus(); }, 0); })
    .observe($('fbView'), { attributes: true, attributeFilter: ['hidden'] });

  // the bar follows every view, however it opened or closed
  const watch = new MutationObserver(mark);
  for (const v of document.querySelectorAll('.wview')) watch.observe(v, { attributes: true, attributeFilter: ['hidden'] });
  mark();

  // a dot on Devices while files go to one of them (devices.js); on Settings while an update waits (their lines are on
  // those pages), and also while What's new waits at its top
  const setDot = () => { $('tabSettingsDot').hidden = $('upd').hidden && $('news').hidden; };
  for (const id of ['upd', 'news']) new MutationObserver(setDot).observe($(id), { attributes: true, attributeFilter: ['hidden'] });
  setDot();

  // Cards on Home (Browse your phone, Share with a browser, Clipboard history): each can be hidden from Home, and
  // Settings › Help brings them back. (Kept by this PC's panel; Browse and Clipboard history still show only once
  // there's something in them: browse.js, clips.js)
  const KEY = 'flick.homeHidden';
  const hiddenCards = () => { try { const v = JSON.parse(localStorage.getItem(KEY) || '[]'); return Array.isArray(v) ? v : []; } catch (e) { return []; } };
  function drawCards() {
    const off = hiddenCards();
    for (const c of document.querySelectorAll('.hcard')) c.classList.toggle('gone', off.includes(c.dataset.card));
    $('homeCards').hidden = !off.length;
  }
  for (const x of document.querySelectorAll('.hx')) x.onclick = () => {
    const off = hiddenCards(); if (!off.includes(x.dataset.card)) off.push(x.dataset.card);
    try { localStorage.setItem(KEY, JSON.stringify(off)); } catch (e) { /* ignore */ }
    // (the keyboard goes to the next card still showing, else to Home itself)
    const card = x.closest('.hcard');
    drawCards();
    let n = card.nextElementSibling;
    while (n && !(n.classList.contains('hcard') && n.getClientRects().length)) n = n.nextElementSibling;
    const f = n && n.querySelector('.wentry');
    if (f) f.focus(); else { $('main').tabIndex = -1; $('main').focus(); }
    say('Hidden from Home. Settings › Help › Show hidden cards on Home brings it back.');
  };
  $('homeCards').onclick = () => {
    try { localStorage.removeItem(KEY); } catch (e) { /* ignore */ }
    drawCards();
    $('tourAgain').focus();
    say('The cards are back on Home.');
  };
  // (said to a screen reader)
  function say(t) { const l = $('navSay'); l.textContent = ''; setTimeout(() => { l.textContent = t; }, 30); }
  drawCards();

  // Show the tour again: on Home, where the controls it lights are (Connect too, for the tour: tour.js)
  $('tourAgain').onclick = () => { go('home'); if (window.flickTour) window.flickTour.start(); };

  // Escape: out of a group, out of Advanced settings, out of Settings (before panel.js would hide the window). The other
  // views, and Send feedback over Settings, answer Escape themselves first.
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || question() || (window.flickTour && window.flickTour.isOpen())) return;
    if (!$('fbView').hidden) return;
    if (!advView.hidden) { e.stopImmediatePropagation(); advBack(); return; }
    if (!setView.hidden) { e.stopImmediatePropagation(); go('home'); $('tabSettings').focus(); }
  }, true);
  // Ctrl+1..4 go to the four places
  window.addEventListener('keydown', (e) => {
    if (!e.ctrlKey || e.altKey || e.shiftKey || e.metaKey || question() || (window.flickTour && window.flickTour.isOpen())) return;
    const t = tabs[Number(e.key) - 1];
    if (!t) return;
    e.preventDefault();
    t.click();
  });

  // (Advanced settings, at one of its groups: from Can't find your phone?'s Bluetooth, connect.js)
  function adv(g) { go('settings'); if (current() !== 'settings') return; showAdv(true, g); advView.focus(); }
  // (clear: every view closed, onto Home: Share with a browser, opening by itself for a note, share.js)
  window.flickNav = { go, current, adv, clear: closeAll };
})();
