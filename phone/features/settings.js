/* Settings › Features. The switches are the app's (features() / setFeature()), except "Clipboard sync",
 * which is this page's own (it sends the clipboard when Flick opens). A hint shows when Android still needs an OK. */
(window.FlickFeatures = window.FlickFeatures || []).push(function (A, X) {
  'use strict';
  const h = X.h;
  const chosen = new Map();        // name -> { v, at }: what the user just picked, shown until the app reports it
  let redrawT = 0;

  function redraw() {
    const s = document.getElementById('settings');
    if (s && !s.hidden && !s.classList.contains('closing')) A.renderSettings();
  }
  function redrawSoon(ms) { clearTimeout(redrawT); redrawT = setTimeout(redraw, ms); }
  function set(name, v) {
    chosen.set(name, { v, at: Date.now() });
    A.nc('setFeature', name, v);
    redrawSoon(450);                // after the switch has moved: hints follow what the app reports
  }
  // the app's value, or the user's pick of the last few seconds while the app catches up
  function val(name, fromApp) {
    const c = chosen.get(name);
    if (c && Date.now() - c.at < 3000) return c.v;
    chosen.delete(name);
    return fromApp;
  }
  A.on('native', (e) => { if (e.t === 'features' || e.t === 'resume' || e.t === 'storage') redrawSoon(250); });

  A.on('settings', (body) => {
    if (!A.has('features') || !A.has('setFeature')) return;
    const f = A.njson('features') || {};
    const clipFromPc = val('clipFromPc', f.clipFromPc !== false ? '1' : '0') === '1';
    // "Show notifications on your PC": the app says (features().notify) or, if it doesn't, the last choice made here
    const notify = val('notify', typeof f.notify === 'boolean' ? (f.notify ? '1' : '0') : A.pref.get('notifyOn', '0')) === '1';
    const auto = val('autoSend', /^(screenshots|photos)$/.test(f.autoSend) ? f.autoSend : 'off');
    const bg = val('bg', f.bg ? '1' : '0') === '1';
    const rows = [];
    if (A.st.connected && !X.newPc()) rows.push({ note: 'Update Flick on your PC to use these' });
    if (A.has('clipRead')) {
      rows.push({ label: 'Clipboard sync', sub: 'Sends what you copy here to your PC when Flick opens', on: !!A.settings.clipSync,
        set: (v) => { A.settings.clipSync = v; A.saveSettings(); } });
    }
    rows.push({ label: 'Clipboard from your PC', sub: 'What you copy on your PC is copied here too', on: clipFromPc, set: (v) => set('clipFromPc', v ? '1' : '0') });
    if (A.has('clipHistory')) {
      rows.push({ label: 'Clipboard history', sub: 'Keeps the last 20 things copied through Flick, on this phone only',
        on: val('clipHistory', f.clipHistory !== false ? '1' : '0') === '1', set: (v) => set('clipHistory', v ? '1' : '0') });
    }
    rows.push({ label: 'Show notifications on your PC', sub: 'Your phone’s notifications pop up on your PC', on: notify,
      set: (v) => { A.pref.set('notifyOn', v ? '1' : '0'); set('notify', v ? '1' : '0'); } });
    if (notify && f.notifyAccess === false) {
      // Android 13 and newer greys out notification access for an app installed from a downloaded APK ("Restricted
      // setting") until it is allowed in the app's own settings: nothing said how
      const restricted = (+f.sdk || +A.INFO.sdk || 0) >= 33
        ? '. If Android says it’s restricted: Settings\u00a0› Apps\u00a0› Flick\u00a0› ⋮\u00a0› Allow restricted settings, then try again' : '';   // (no line starts with ›)
      rows.push({ hint: 'Flick needs notification access', sub: 'Turn on Flick in the list Android shows' + restricted, action: 'Allow', run: () => set('notify', '1') });
    }
    rows.push({ label: 'Auto-send to your PC', sub: 'New screenshots, or new photos and videos from the camera, go to your PC by themselves',
      seg: [['off', 'Off'], ['screenshots', 'Screenshots'], ['photos', 'Photos']], value: auto, set: (v) => set('autoSend', v) });
    if (auto !== 'off' && !A.stg.granted) {
      rows.push({ hint: 'Flick needs access to your photos', sub: 'So that new ones can go to your PC', action: 'Allow', run: () => A.nc('askStorage') });
    }
    if (A.has('browse')) {
      const browse = val('browse', f.browse ? '1' : '0') === '1';
      rows.push({ label: 'Let your PC browse this phone', sub: 'Your PC can see and copy photos, videos and files. It can’t change or delete them.',
        on: browse, set: (v) => set('browse', v ? '1' : '0') });
      if (browse && !A.stg.granted) {
        rows.push({ hint: 'Flick needs access to your files', sub: 'So that your PC can see them', action: 'Allow', run: () => A.nc('askStorage') });
      }
    }
    rows.push({ label: 'Stay connected in the background', sub: 'Links, the clipboard and Find my phone work while Flick is closed', on: bg, set: (v) => set('bg', v ? '1' : '0') });
    if (bg && (+f.sdk || 0) >= 33 && f.notifyPerm === false) {
      rows.push({ hint: 'Allow notifications', sub: 'Android shows a small note while Flick stays connected', action: 'Allow', run: () => set('bg', '1') });
    }
    body.appendChild(section('Features', rows));
  });

  // the same rows as the rest of Settings (app.css: .sgroup, .scard, .srow, .stog, .sseg, .sbtn)
  function section(title, rows) {
    const g = h('section', 'sgroup');
    g.appendChild(h('h3', '', title));
    const card = h('div', 'scard');
    for (const r of rows) {
      if (r.note) { const n = h('div', 'srow fsnote'); n.appendChild(h('span', '', r.note)); card.appendChild(n); continue; }
      const row = h('div', 'srow' + (r.seg ? ' fcol' : '') + (r.hint ? ' fhint' : ''));
      const lab = h('div', 'sl');
      lab.appendChild(h('b', '', r.label || r.hint));
      if (r.sub) lab.appendChild(h('small', '', r.sub));
      row.appendChild(lab);
      if ('on' in r) row.appendChild(toggle(r));
      if (r.seg) row.appendChild(seg(r));
      if (r.action) {
        const b = h('button', 'sbtn', r.action);
        b.setAttribute('aria-label', r.action + ': ' + r.hint);
        b.onclick = (e) => { e.stopPropagation(); A.haptic('tick'); r.run(); };
        row.appendChild(b);
      }
      card.appendChild(row);
    }
    g.appendChild(card);
    return g;
  }
  function toggle(r) {
    const l = h('label', 'stog');
    const i = h('input');
    i.type = 'checkbox'; i.checked = !!r.on;
    i.setAttribute('aria-label', r.label);
    i.onchange = () => { r.set(i.checked); A.haptic('tick'); };
    l.append(i, h('span'));
    return l;
  }
  function seg(r) {
    const s = h('div', 'sseg');
    s.setAttribute('role', 'radiogroup');
    s.setAttribute('aria-label', r.label);
    for (const [v, text] of r.seg) {
      const b = h('button', r.value === v ? 'on' : '', text);
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(r.value === v));
      b.onclick = (e) => { e.stopPropagation(); if (r.value === v) return; A.haptic('tick'); r.set(v); A.renderSettings(); };
      s.appendChild(b);
    }
    return s;
  }
});
