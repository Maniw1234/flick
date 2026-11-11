'use strict';
(function () {
  const api = window.flick;
  const $ = (id) => document.getElementById(id);
  let S = null;
  let pairDevice = null, pairShownAt = 0;
  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  // the page's own words are Windows'; on a Mac or Linux these lines name what is there instead
  const OS_TEXT = {
    mac: {
      hotkeyLbl: 'Send selected files with ⌘⌥F',
      newsNet: 'No shared Wi-Fi needed between phones: they find each other over Bluetooth.',
      sendSub: 'Or drop files on this window, or on Flick in the menu bar or the Dock. In Finder, right-click a file and choose Open With > Flick.',
      startupLbl: 'Open Flick when you log in',
      fNotifySub: 'As notifications on this Mac. Turn it on in Flick on the phone too.',
    },
    linux: {
      hotkeyLbl: 'Send copied files with Ctrl+Alt+F',
      sendSub: 'Or drop files on this window. In your file manager, right-click a file and choose Open With > Flick.',
      sendToLbl: 'Add Flick to your file manager’s Open With menu',
      startupLbl: 'Start Flick when you log in',
      fNotifySub: 'As desktop notifications. Turn it on in Flick on the phone too.',
    },
  };

  // A switch shows what it was last clicked to until the main process has taken that click. A state main sent before it
  // took it (Quick Share starting, a phone connecting) used to put the switch back for a moment, and a click then turned
  // it where it already was. Each change is numbered, and a state says the number of the last one main took (setN).
  let sets = 0;
  const unsure = new Map();          // key -> the number of its last change, until a state says main took it
  function set(key, value) { unsure.set(key, ++sets); api.send('panel:set', { key, value, n: sets }); }
  function act(what, arg) { api.send('panel:action', { what, arg }); }
  // what a screen reader says a slider is at, rather than its bare number ("0.5")
  function sayValues() {
    const a = +$('anchor').value, at = Math.round((a - 0.15) / 0.7 * 100);
    $('anchor').setAttribute('aria-valuetext', a <= 0.16 ? 'Top' : a >= 0.84 ? 'Bottom' : Math.abs(a - 0.5) < 0.015 ? 'Middle' : at + '% of the way down');
    $('size').setAttribute('aria-valuetext', Math.round(+$('size').value * 100) + '%');
    $('volume').setAttribute('aria-valuetext', Math.round(+$('volume').value * 100) + '%');
  }
  // the one picked (a side, an animation): drawn, and said to a screen reader
  function picked(b, on) { b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); }

  function render(s) {
    S = s;
    // (a page loaded anew numbers its changes on from the last one main took)
    sets = Math.max(sets, s.setN || 0);
    const sw = (id, on) => { if (unsure.get(id) > (s.setN || 0)) return; unsure.delete(id); $(id).checked = on; };
    if (s.accent) {
      document.documentElement.style.setProperty('--accent', s.accent);
      document.documentElement.style.setProperty('--on-accent', s.onAccent || '#000');
    }
    const VIA = { wifi: 'Wi-Fi', usb: 'USB cable', hotspot: 'hotspot', direct: 'a direct link', ethernet: 'Ethernet', bluetooth: 'Bluetooth' };
    $('statusText').textContent = s.connected ? `Connected to ${s.phone}` + (s.via && VIA[s.via] ? ` over ${VIA[s.via]}` : '') : 'Waiting for your phone';
    $('dot').classList.toggle('on', !!s.connected);
    // (Home follows it: Connect while nothing is connected, sending once something is: nav.css)
    document.body.classList.toggle('linked', !!s.connected);
    $('hint').textContent = s.connected
      ? 'Drag a file off the edge of your phone toward this screen.'
      : 'Hold Connect below, or on your phone.';
    const scene = $('scene');
    scene.classList.toggle('right', s.side === 'right');
    scene.classList.toggle('left', s.side === 'left');
    scene.classList.toggle('on', !!s.connected);
    document.querySelector('.scene .phone').style.top = (14 + (s.anchor - 0.5) * 30) + 'px';
    for (const b of $('themes').querySelectorAll('.theme')) picked(b, b.dataset.v === s.theme);
    for (const b of $('side').querySelectorAll('button')) picked(b, b.dataset.v === s.side);
    if (document.activeElement !== $('anchor')) $('anchor').value = s.anchor;
    if (document.activeElement !== $('size')) $('size').value = s.size;
    // (the card's size is the flying card's, and with it how tall the strip at the screen's edge is that takes dragged
    // files, main.js catcherBounds: with the animations and edge sending both off it sizes nothing, and isn't offered)
    $('sizeRow').hidden = !s.fx && !s.edgeSend;
    // Save files to: Desktop, Downloads, the folder of the user's own chosen last (by its name, also once Desktop or
    // Downloads is picked again: one choice away, not lost), and a way to choose another one straight from it
    const sd = $('saveDir'), f = s.folder;
    let custom = sd.querySelector('option[value=custom]');
    if (f && !custom) { custom = document.createElement('option'); custom.value = 'custom'; sd.insertBefore(custom, sd.querySelector('option[value=choose]')); }
    if (!f && custom) { custom.remove(); custom = null; }
    if (custom) custom.textContent = f.name + (f.missing ? ' (not found)' : '');
    sd.querySelector('option[value=choose]').textContent = f ? 'Choose another folder…' : 'Choose folder…';
    sd.value = s.saveDir === 'desktop' || s.saveDir === 'downloads' ? s.saveDir : 'custom';
    // (gone: unplugged, or deleted; said, rather than "Desktop" showing as if it were the choice)
    const miss = f && f.missing ? f.name + ' isn’t there. Files go to the Desktop until it’s back.' : '';
    if ($('saveDirSub').textContent !== miss) $('saveDirSub').textContent = miss;
    $('saveDirSub').hidden = !miss;
    sw('sound', !!s.sound);
    if (document.activeElement !== $('volume')) $('volume').value = s.volume == null ? 0.7 : s.volume;
    sayValues();
    $('volume').disabled = !$('sound').checked;
    $('volumeRow').classList.toggle('off', !$('sound').checked);
    sw('reduceFx', !!s.reduceFx);
    // the animations: off on a new install; on a desktop that can't show them, said
    sw('fx', !!s.fx);
    const fxt = s.fx && s.fxCant ? 'On, but this desktop can’t show them: turn on compositing (desktop effects) in its settings. Until then a small card in the corner shows what arrived.'
      : 'Files fly across the screen as they come and go. When off, a small card in the corner shows what arrived.';
    if ($('fxSub').textContent !== fxt) $('fxSub').textContent = fxt;
    $('fxSub').className = 'sub0' + (s.fx && s.fxCant ? ' warn' : '');
    $('fxOpts').classList.toggle('off', !s.fx);
    playClips(document.hasFocus());
    // (on because the system asks for less motion, not because it was set here: said)
    const rfx = s.reduceFxSys ? 'On because your system is set to reduce motion. Lighter animations.' : 'Lighter animations. Flick also switches to them on its own on a PC that can’t keep up.';
    if ($('reduceFxSub').textContent !== rfx) $('reduceFxSub').textContent = rfx;
    sw('hotkey', s.hotkey !== false);
    const hk = $('hotkeySub');
    hk.className = 'sub0' + (s.hotkey !== false && !s.hotkeyOk ? ' warn' : '');
    hk.textContent = s.hotkey !== false && !s.hotkeyOk ? 'Another app is using these keys, so Flick can’t.'
      : s.os === 'mac' ? 'Select files in Finder, then press Command-Option-F.'
        : s.os === 'linux' && s.sendCmd ? 'Copy files in your file manager (Ctrl+C), then press Ctrl+Alt+F. Under Wayland the keys only reach Flick while its window is in front: to use them anywhere, add them as a custom shortcut in your system’s keyboard settings, with this command: ' + s.sendCmd
        : s.os === 'linux' ? 'Copy files in your file manager (Ctrl+C), then press Ctrl+Alt+F.'
          : 'Select files in File Explorer or on the desktop, then press Ctrl+Alt+F.';
    sw('openAfter', !!s.openAfter);
    sw('showSpeed', !!s.showSpeed);
    sw('airCam', s.airCam !== false);
    // a camera Flick tried and couldn't use (none, or the system doesn't allow it): files come in from the edge, and
    // nothing here can be picked up by hand
    $('airCamSub').textContent = s.airCam !== false && s.airCamState === 'denied'
      ? (s.os === 'mac' ? 'macOS doesn’t let Flick use the camera: allow it in System Settings › Privacy & Security › Camera.'
        : s.os === 'win' ? 'Windows doesn’t let Flick use the camera: turn on “Let desktop apps access your camera” in Settings › Privacy & security › Camera.'
          : 'Flick can’t use this PC’s camera: files from your phone come in from the edge, and files here can’t be grabbed by hand.')
      : s.airCam !== false && s.airCamState === 'nocamera' ? 'This PC has no camera Flick can use: files from your phone come in from the edge, and files here can’t be grabbed by hand.'
        : 'Files from your phone land where your hand opens, and a fist picks up the files you select here. The camera turns on for a few seconds only, while Flick is open on your phone.';
    sw('sendTo', !!s.sendTo);
    $('sendToRow').hidden = !s.isWin && s.os !== 'linux';     // a Mac always has Open With and the Dock icon
    const words = OS_TEXT[s.os];
    if (words) for (const id of Object.keys(words)) $(id).textContent = words[id];
    $('btRow').hidden = !s.isWin;                             // Flick's Bluetooth link is a Windows helper
    sw('autoUpdate', s.autoUpdate !== false);
    sw('bluetooth', !!s.bluetooth);
    sw('quickShare', !!s.quickShare);
    const status = (el, on, st, offText) => {
      const txt = { off: offText, starting: 'Starting…', on: on, 'no-radio': 'This PC has no Bluetooth (or it’s turned off).', unsupported: 'Needs Windows.',
        'no-mdns': 'Phones can’t see this PC: another app is using the network port Quick Share needs (5353).' };
      // (it couldn't start: said with a way to the log, which says why. Made once, not with every state: the keyboard
      // stays on it)
      if (st !== 'error') el.textContent = txt[st] || offText;
      else if (!el.querySelector('.loglink')) {
        el.textContent = 'Couldn’t start. ';
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'link loglink'; b.textContent = 'Open the log';
        b.onclick = () => act('openLog');
        el.appendChild(b);
      }
      el.className = 'sub0' + (st === 'on' ? ' ok' : st === 'no-radio' || st === 'error' || st === 'no-mdns' ? ' warn' : '');
    };
    status($('btSub'), 'On. Pair your phone with this PC in Windows Bluetooth settings, then turn on Bluetooth in Flick on the phone.', s.btState, 'For when there’s no network. Much slower.');
    status($('qsSub'), 'On. In any app on the phone, tap Share > Quick Share and pick ' + (s.name || 'this PC') + '.', s.qsState, 'Show this PC in Android’s own Quick Share menu.');
    $('verLine').textContent = 'Flick ' + s.version;
    // where sends from here go: the phone in use, or another computer picked here (the shortcut and the screen's edge too)
    const pcs = s.pcs || [], tgt = s.target ? pcs.find((p) => p.id === s.target) : null;
    $('sendRow').hidden = !s.connected && !tgt;
    $('sendToBox').hidden = !pcs.length;
    const sel = $('sendTarget');
    const opts = [['', s.connected && s.phone ? s.phone : 'Your phone']].concat(pcs.map((p) => [p.id, p.name]));
    const osig = JSON.stringify(opts);
    if (sel.dataset.sig !== osig) {
      sel.dataset.sig = osig;
      sel.textContent = '';
      for (const [v, t] of opts) { const o = document.createElement('option'); o.value = v; o.textContent = t; sel.appendChild(o); }
    }
    if (document.activeElement !== sel) sel.value = tgt ? tgt.id : '';
    // (the big button: another computer picked here, else the phone in use, which features.js names when several are
    // connected: both write their part, and the words come from both)
    const sl = window.flickSendLabel = window.flickSendLabel || {};
    sl.pc = tgt ? tgt.name : null;
    $('sendFiles').textContent = sl.pc ? 'Send files to \u2068' + sl.pc + '\u2069' : sl.phone ? 'Send files to \u2068' + sl.phone + '\u2069' : 'Send files to phone';
    // (a phone connected and the Connect card left Home, nav.css: the keyboard on it goes to Send files, not to the page)
    if (s.connected && $('cn').contains(document.activeElement) && !$('cn').getClientRects().length) $('sendFiles').focus();
    sw('edgeSend', !!s.edgeSend);
    sw('startup', !!s.startup);
    $('startupRow').hidden = !s.isWin && s.os !== 'mac' && s.os !== 'linux';
    if (document.activeElement !== $('name')) $('name').value = s.name || '';
    // (as typed on the phone: Flick's usual port goes without saying, another one (taken here: the next one) as ip:port)
    const pt = s.port && s.port !== 47860 ? ':' + s.port : '';
    $('addr').textContent = s.ips && s.ips.length ? s.ips.slice(0, 3).map((ip) => ip + pt).join(', ') : 'No network';
    $('ver').textContent = 'Flick ' + s.version;
    // updates from GitHub
    const u = s.update || {};
    const ut = u.state === 'ready' ? 'Update ' + u.version + ' is downloaded. Flick restarts into it when it isn\u2019t busy.'
      : u.state === 'installer' ? 'Flick ' + u.version + ' is out and needs the full installer.' : '';
    $('upd').hidden = !ut;
    $('updText').textContent = ut;
    // in Updates: what a check is doing, or what the one asked for (Check now) found
    const us = u.state === 'downloading' ? 'Downloading Flick ' + u.version + '…'
      : u.checking ? (u.asked ? 'Checking for updates…' : '')
        : !u.asked ? ''
          : u.state === 'current' ? 'Flick is up to date.'
            : u.state === 'unsigned' ? 'Flick ' + u.version + ' is out, but it can’t be installed yet. Flick tries again later.'
              : u.state === 'error' ? (u.version ? 'Couldn’t get Flick ' + u.version + '. Flick tries again later.' : 'Couldn’t check for updates. Try again later.')
                : '';
    if ($('updSub').textContent !== us) $('updSub').textContent = us;
    $('updSub').hidden = !us;
    // (not disabled while it checks: the keyboard stays on it, rather than being dropped to the page; a press meanwhile
    // does nothing)
    if (u.checking) $('checkNow').setAttribute('aria-disabled', 'true'); else $('checkNow').removeAttribute('aria-disabled');
    $('updLink').hidden = u.state !== 'installer';
    $('updLink').textContent = 'Get it';
    if (s.phoneApp) {
      // the phone app this PC hands out over Wi-Fi
      const line = document.createElement('div');
      const waiting = s.phoneHas && s.phoneHas.code && s.phoneHas.code < s.phoneApp.code;
      line.textContent = 'Phone app ' + s.phoneApp.name + (waiting ? ' (update waiting on your phone)' : '');
      $('ver').appendChild(line);
    }
    $('intro').hidden = !s.firstRun;
    $('news').hidden = !s.news;
    const dr = $('displayRow');
    dr.hidden = !(s.displays && s.displays.length > 1);
    if (!dr.hidden) {
      // (made again only when the screens change: every state used to rebuild it, closing it under the user's pointer)
      const sel = $('display');
      // (the screen picked isn't connected now, unplugged or docked elsewhere: said, and kept for when it's back, rather
      // than an empty box while Flick uses Automatic)
      const gone = s.displayId && !s.displays.some((d) => d.id === s.displayId) ? s.displayId : null;
      const dsig = JSON.stringify([s.displays, gone]);
      if (sel.dataset.sig !== dsig) {
        sel.dataset.sig = dsig;
        sel.textContent = '';
        const auto = document.createElement('option'); auto.value = ''; auto.textContent = 'Automatic'; sel.appendChild(auto);
        for (const d of s.displays) { const o = document.createElement('option'); o.value = String(d.id); o.textContent = d.label + (d.primary ? ', main' : ''); sel.appendChild(o); }
        if (gone) { const o = document.createElement('option'); o.value = String(gone); o.textContent = 'The screen picked (not connected: Automatic until it is)'; sel.appendChild(o); }
      }
      if (document.activeElement !== sel) sel.value = s.displayId ? String(s.displayId) : '';
    }
    const list = $('devices');
    $('devicesCard').hidden = !(s.devices && s.devices.length);
    const sig = JSON.stringify(s.devices || []);
    if (list.dataset.sig === sig) return;      // unchanged: an open "Ask each time" list stays open
    list.dataset.sig = sig;
    // (drawn anew: the keyboard stays on the same control of the same phone, else of the one that took its place, as
    // in History's lists; it used to be dropped to the page after each choice or Remove)
    const a = document.activeElement, was = a && list.contains(a) && a.closest('[data-id]');
    const keep = was ? { id: was.dataset.id, k: a.dataset.k || '', at: [...list.children].indexOf(was) } : null;
    list.innerHTML = '';
    for (const d of s.devices || []) {
      const row = document.createElement('div'); row.className = 'dev'; row.dataset.id = d.id;
      const l = document.createElement('div');
      const n = document.createElement('div'); n.textContent = d.name;
      // (allowed here a moment ago, its user still checking the code there: it stays once it says Same code)
      const dd = document.createElement('div'); dd.className = 'd';
      dd.textContent = d.waiting ? 'Allowed here. Waiting for ⁨' + d.name + '⁩ to confirm the code there…' : (Number.isFinite(d.added) && d.added > 0 ? 'Paired ' + new Date(d.added).toLocaleDateString() : 'Paired');
      l.appendChild(n); l.appendChild(dd);
      // files from this phone: saved as they come (as always), or after Accept here
      const sel = document.createElement('select'); sel.className = 'devask'; sel.dataset.k = 'ask';
      sel.setAttribute('aria-label', 'Files from ' + d.name);
      for (const [v, t] of [['always', 'Always accept'], ['ask', 'Ask each time']]) { const o = document.createElement('option'); o.value = v; o.textContent = t; sel.appendChild(o); }
      sel.value = d.ask ? 'ask' : 'always';
      sel.onchange = () => api.send('panel:feat', { what: 'accept', device: d.id, mode: sel.value });
      // (Remove asks once more, as Clear does in History: the phone has to be paired again, with Connect, to come back)
      const b = document.createElement('button'); b.className = 'link danger'; b.dataset.k = 'remove';
      let armedAt = 0;
      const armed = () => Date.now() - armedAt < 4000;
      const paint = () => { b.textContent = armed() ? 'Remove?' : 'Remove'; b.setAttribute('aria-label', armed() ? 'Remove ' + d.name + '? Press again to remove it' : 'Remove ' + d.name); };
      b.onclick = () => {
        if (armed()) { armedAt = 0; act('forget', d.id); return; }
        armedAt = Date.now(); paint();
        setTimeout(() => { if (b.isConnected) paint(); }, 4100);
      };
      paint();
      row.appendChild(l); row.appendChild(sel); row.appendChild(b);
      list.appendChild(row);
    }
    if (keep) {
      const rows = [...list.children];
      const r = rows.find((x) => x.dataset.id === keep.id) || rows[Math.min(keep.at, rows.length - 1)];
      const f = r && r.querySelector('[data-k="' + keep.k + '"]');
      if (f) f.focus();
      else {
        // (the last phone removed: on to what follows the list)
        const scope = $('devicesCard').closest('.wbody') || $('main');
        const next = [...scope.querySelectorAll('button, input, select, [tabindex="0"]')]
          .find((el) => ($('devicesCard').compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) && !el.disabled && el.getClientRects().length);
        if (next) next.focus();
        else { scope.tabIndex = -1; scope.focus(); }
      }
    }
  }

  // preview clips play while the window is open, Advanced settings › Look and sound is showing and the animations are
  // on (paused with reduced motion)
  const videos = [...document.querySelectorAll('.theme video')];
  function playClips(on) {
    on = on && !reduceMotion && !$('advView').hidden && !$('advLook').hidden && !!(S && S.fx);
    for (const v of videos) { if (on) { if (v.paused) { const p = v.play(); if (p && p.catch) p.catch(() => {}); } } else if (!v.paused) v.pause(); }
  }
  // (Advanced settings is its own page, opened from Settings: nav.js calls this as Look and sound opens or closes)
  window.flickClips = () => playClips(document.hasFocus());
  // only while someone is looking at this window: an open but unfocused panel costs nothing
  document.addEventListener('visibilitychange', () => playClips(!document.hidden && document.hasFocus()));
  window.addEventListener('focus', () => playClips(true));
  window.addEventListener('blur', () => playClips(false));
  playClips(document.hasFocus());

  api.on('panel:state', render);
  const PAIR_ICO = {
    phone: '<rect x="15" y="6" width="18" height="36" rx="4"/><path d="M21 37h6"/>',
    pc: '<rect x="6" y="9" width="36" height="24" rx="3"/><path d="M17 40h14M24 33v7"/>',
  };
  api.on('panel:pair', (s) => {
    pairDevice = s.device;
    // another of your devices (a computer with Flick, or a phone sending to other devices): pairing goes both ways
    const peer = !!s.peer;
    $('pairName').textContent = s.name || (peer ? 'A device' : 'A phone');
    $('pairWhat').textContent = 'wants to connect';
    $('pairIco').innerHTML = PAIR_ICO[peer && s.kind !== 'phone' ? 'pc' : 'phone'];
    // the phone shows the same code: a different one means something else is answering in your PC's place
    const sub = $('pairSub');
    sub.textContent = '';
    if (s.code && /^\d{6}$/.test(s.code)) {
      const b = document.createElement('b');
      b.className = 'pin';
      b.textContent = s.code.slice(0, 3) + ' ' + s.code.slice(3);
      // a phone paired without a code: confirmed once with one
      if (s.upgrade) sub.append('This phone was paired without a code, so it is confirmed once with one. ');
      // (a device of that name paired already: allowing this one replaces that pairing, which is worth knowing)
      if (peer) sub.append('Code ', b, '. Allow it if \u2068' + (s.name || 'the other device') + '\u2069 shows the same code. Then you can send each other files.' + (s.again ? ' It’s paired with this PC already: allowing it replaces that pairing.' : ''));
      else sub.append('Code ', b, '. Allow it if \u2068' + (s.name || 'your phone') + '\u2069 shows the same code.');
    } else {
      sub.textContent = 'Allow it to send files to this PC?';
    }
    $('pair').hidden = false;
    pairShownAt = Date.now();
    // focus starts on "Don't allow" (and Allow ignores clicks for a moment): a keystroke or click meant for something
    // else mustn't pair a stranger's phone
    $('deny').focus();
  });
  api.on('panel:pair-cancel', (d) => { if (d && d.device === pairDevice) { $('pair').hidden = true; pairDevice = null; } });

  // Quick Share: someone's phone wants to send files. Any phone nearby can ask, and the question comes to the front
  // by itself: focus starts on Decline and Accept ignores clicks for a moment (as for pairing), so a keystroke or
  // click meant for something else can't accept a stranger's files.
  let qsId = null, qsShownAt = 0;
  const fmt = (n) => (n >= 1e9 ? (n / 1e9).toFixed(1) + ' GB' : n >= 1e6 ? (n / 1e6).toFixed(1) + ' MB' : n >= 1e3 ? Math.round(n / 1e3) + ' KB' : n + ' bytes');
  api.on('panel:qs', (m) => {
    qsId = m.id;
    $('qsFrom').textContent = m.from || 'A phone';
    const n = m.files.length, t = m.texts.length;
    $('qsWhat').textContent = n ? (n === 1 ? m.files[0].name : n + ' files') : t === 1 ? (m.texts[0].type === 2 ? 'a link' : 'some text') : t + ' items';
    $('qsPin').textContent = m.pin || '';
    const list = $('qsList');
    list.innerHTML = '';
    for (const f of m.files.slice(0, 50)) {
      const r = document.createElement('div');
      const a = document.createElement('span'); a.textContent = f.name;
      const b = document.createElement('span'); b.textContent = fmt(f.size || 0);
      r.appendChild(a); r.appendChild(b); list.appendChild(r);
    }
    list.hidden = n < 2;
    $('qs').hidden = false;
    qsShownAt = Date.now();
    $('qsDeny').focus();
  });
  api.on('panel:qs-done', (m) => { if (!m || m.id === qsId) { $('qs').hidden = true; qsId = null; } });
  $('qsAllow').onclick = () => { if (Date.now() - qsShownAt < 1000) return; if (qsId) api.send('panel:qs-answer', { id: qsId, accept: true }); $('qs').hidden = true; qsId = null; };
  $('qsDeny').onclick = () => { if (qsId) api.send('panel:qs-answer', { id: qsId, accept: false }); $('qs').hidden = true; qsId = null; };

  $('allow').onclick = () => { if (Date.now() - pairShownAt < 1000) return; if (pairDevice) api.send('panel:pair-answer', { device: pairDevice, allow: true }); $('pair').hidden = true; pairDevice = null; };
  $('deny').onclick = () => { if (pairDevice) api.send('panel:pair-answer', { device: pairDevice, allow: false }); $('pair').hidden = true; pairDevice = null; };
  $('close').onclick = () => act('hide');
  $('quit').onclick = () => act('quit');
  // Quit while files are moving (from here or the tray): main asks here first; Cancel (or Escape) keeps them going
  // (again: the transfers changed while it asks: its words follow them, and it isn't opened by that)
  api.on('panel:quit-ask', (m) => {
    const n = (m && m.n) || 0;
    if (m && m.again && $('quitAsk').hidden) return;
    const t = n ? 'Files are still moving. Quit anyway?' : 'Files have finished moving.';
    const sub = n > 1 ? 'Quitting Flick stops ' + n + ' transfers.' : n ? 'Quitting Flick stops it.' : 'Nothing is moving now.';
    if ($('quitAskTitle').textContent !== t) $('quitAskTitle').textContent = t;
    if ($('quitAskSub').textContent !== sub) $('quitAskSub').textContent = sub;
    $('quitAsk').hidden = false;
  });
  const quitNo = () => { $('quitAsk').hidden = true; act('quit-no'); };
  $('quitNo').onclick = quitNo;
  $('quitYes').onclick = () => { $('quitAsk').hidden = true; act('quit-sure'); };
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('quitAsk').hidden) { e.stopImmediatePropagation(); quitNo(); } }, true);
  $('updLink').onclick = () => act(S && S.update && S.update.state === 'installer' ? 'openRelease' : 'checkUpdates');
  $('openFolder').onclick = () => act('openFolder');
  $('firewall').onclick = () => act('fixFirewall');
  // its answer (a Mac, Linux): right under it, where the user is, until closed; its command can be selected and copied
  api.on('panel:help', (h) => {
    $('fwHelpText').textContent = (h && h.text) || '';
    $('fwHelpCmd').textContent = (h && h.cmd) || '';
    $('fwHelpCmd').hidden = !(h && h.cmd);
    $('fwHelp').hidden = !(h && (h.text || h.cmd));
    if (!$('fwHelp').hidden) $('fwHelp').scrollIntoView({ block: 'nearest' });
  });
  $('fwHelpClose').onclick = () => { $('fwHelp').hidden = true; $('firewall').focus(); };
  $('introOk').onclick = () => act('dismissIntro');
  // Flick on Google Play: false until its page there is public (the day it is: true here, and the README's step 2).
  // Then the welcome card sends the phone to Google Play first; the .apk on GitHub stays as the other way.
  const PLAY_LIVE = false;
  if (PLAY_LIVE) {
    const li = $('introPhone');
    li.textContent = '';
    const mono = document.createElement('span');
    mono.className = 'mono';
    mono.textContent = 'github.com/Maniw1234/flick/releases';
    li.append('Install the Flick app on your Android phone (Android 9 or newer): on the phone, search Google Play for “Flick: Phone to PC Transfer”. Or open ', mono, ' and install the latest Flick .apk.');
  }
  // Open-source notices: the list opens under its link; each line opens that part's license (a file of this copy)
  $('ossOpen').onclick = () => {
    const show = $('ossNote').hidden;
    $('ossNote').hidden = !show;
    $('ossOpen').setAttribute('aria-expanded', String(show));
    if (show) $('ossNote').scrollIntoView({ block: 'nearest' });
  };
  for (const b of $('ossNote').querySelectorAll('[data-lic]')) b.onclick = () => act('openLicense', b.dataset.lic);
  $('newsOk').onclick = () => act('dismissNews');
  $('newsAll').onclick = () => act('openRelease');
  $('playFx').onclick = () => act('demo');
  for (const b of $('themes').querySelectorAll('.theme')) b.onclick = () => {
    for (const o of $('themes').querySelectorAll('.theme')) picked(o, o === b);
    set('theme', b.dataset.v);
  };
  for (const b of $('side').querySelectorAll('button')) b.onclick = () => set('side', b.dataset.v);
  $('anchor').addEventListener('input', sayValues);
  $('size').addEventListener('input', sayValues);
  $('volume').addEventListener('input', sayValues);
  $('anchor').oninput = (e) => { set('anchor', parseFloat(e.target.value)); document.querySelector('.scene .phone').style.top = (14 + (parseFloat(e.target.value) - 0.5) * 30) + 'px'; };
  $('size').oninput = (e) => set('size', parseFloat(e.target.value));
  $('sound').onchange = (e) => set('sound', e.target.checked);
  $('volume').oninput = (e) => set('volume', parseFloat(e.target.value));
  $('volume').onchange = () => act('soundTest');
  $('reduceFx').onchange = (e) => set('reduceFx', e.target.checked);
  $('fx').onchange = (e) => { $('fxOpts').classList.toggle('off', !e.target.checked); set('fx', e.target.checked); };
  $('hotkey').onchange = (e) => set('hotkey', e.target.checked);
  $('openAfter').onchange = (e) => set('openAfter', e.target.checked);
  $('showSpeed').onchange = (e) => set('showSpeed', e.target.checked);
  $('airCam').onchange = (e) => set('airCam', e.target.checked);
  $('sendTo').onchange = (e) => set('sendTo', e.target.checked);
  $('autoUpdate').onchange = (e) => set('autoUpdate', e.target.checked);
  $('bluetooth').onchange = (e) => set('bluetooth', e.target.checked);
  $('quickShare').onchange = (e) => set('quickShare', e.target.checked);
  $('checkNow').onclick = () => { if ($('checkNow').getAttribute('aria-disabled') !== 'true') act('checkUpdates'); };
  $('sendFiles').onclick = () => act('sendFiles');
  $('sendTarget').onchange = (e) => set('target', e.target.value);
  api.on('panel:note', (n) => {
    const el = $('note'); el.textContent = (n && n.text) || ''; el.hidden = !el.textContent; clearTimeout(el._t); el._t = setTimeout(() => { el.hidden = true; }, 15000);
    // a screen reader says it too (emptied first: the same words again are said again)
    const live = $('noteLive'), text = el.textContent;
    live.textContent = '';
    clearTimeout(live._t);
    if (text) live._t = setTimeout(() => { live.textContent = text; }, 60);
  });
  // (the note is over the bar at the bottom, in sight on Home and on every view: the views end above it, by its height
  // as it is now, shown, hidden, or wrapped anew at another text size: nav.css)
  new ResizeObserver(() => {
    const el = $('note');
    document.documentElement.style.setProperty('--note-h', el.hidden ? '0px' : (el.offsetHeight + 8) + 'px');
  }).observe($('note'));

  // One thing in front at a time, for the keyboard and a screen reader as for the eyes: a view (History, Devices…)
  // covers the main one, which can't be reached behind it; a question (pairing, Quick Share, a browser asking,
  // Accept, the ringing) covers everything, and Tab stays in it until it's answered, when the keyboard goes back where
  // it was. (What a screen reader says as it happens, the notes and the transfers that ended, is never covered.)
  const covered = [...document.body.children].filter((x) => x.tagName !== 'SCRIPT' && x.getAttribute('role') !== 'status');
  const questions = [...document.querySelectorAll('.modal')], views = [...document.querySelectorAll('.wview')];
  const asking = () => questions.filter((m) => !m.hidden).pop() || null;      // (the last one is drawn on top)
  let outside = null, before = null;                   // what last had the keyboard outside a question; when one came
  let inMain = null, wasView = false;                  // what last had it in the main view (a view's entry, once one opens)
  document.addEventListener('focusin', (e) => {
    if (!questions.some((m) => m.contains(e.target))) outside = e.target;
    if ($('main').contains(e.target)) inMain = e.target;
  });
  // A control to give the keyboard back to, also once its list was drawn anew (the lists are, with each news from main;
  // or it was disabled meanwhile, as Find my phone is while the phone rings): the same one, else the one in its place,
  // by its row (data-id) and part (data-k), or its id. Tried for a moment while it's still disabled or not drawn yet.
  const spot = (x) => (x && x !== document.body ? { el: x, id: x.id || '', row: (x.closest('[data-id]') || { dataset: {} }).dataset.id || '', k: (x.dataset && x.dataset.k) || '' } : null);
  const usable = (x) => x && x.isConnected && !x.disabled && !x.closest('[hidden], [inert]');
  function giveBack(sp, tries) {
    const a = document.activeElement;
    if (!sp || (a && a !== document.body && !a.closest('[hidden]'))) return;     // (it has a place already)
    let x = sp.el;
    if (!usable(x)) {
      x = (sp.id && document.getElementById(sp.id)) || (sp.row && sp.k && [...document.querySelectorAll('[data-id]')]
        .filter((r) => r.dataset.id === sp.row).map((r) => r.querySelector('[data-k="' + sp.k + '"]')).find(Boolean)) || x;
    }
    if (usable(x)) x.focus();
    else if (tries > 0) setTimeout(() => giveBack(sp, tries - 1), 100);
  }
  // (the first-time tour covers everything but a question, which comes on top of it)
  const tour = $('tour');
  function front() {
    const q = asking();
    const view = views.some((v) => !v.hidden);
    const touring = !tour.hidden;
    if (q && !before) before = spot(outside) || 'body';
    // (Settings is a view too, and is itself covered by the ones opened from it: Advanced settings, Send feedback.
    // Only while it shows: one left out of reach while hidden couldn't take the keyboard as it next opens, nav.js)
    const over = !$('setView').hidden && views.some((v) => v.id !== 'setView' && !v.hidden);
    for (const x of covered) { const off = q ? x !== q : touring ? x !== tour : (x.id === 'main' && view) || (x.id === 'setView' && over); if (x.inert !== off) x.inert = off; }
    if (q) {
      // (its own safe answer has the keyboard: Don't allow, Decline, Stop)
      if (!q.contains(document.activeElement)) { const b = q.querySelector('.pbtns .ghost') || q.querySelector('button'); if (b) b.focus(); }
      return;
    }
    const b = before;
    before = null;
    // (the answer clicked is in what was just hidden: it has the keyboard until the page next lays itself out)
    if (b && b !== 'body') giveBack(b, 10);
    // a view closed: the keyboard goes back to what had it on Home (the entry that opened Browse, Share or Clipboard
    // history; nav.js gives it to the bar when nothing there had it, as after Devices or History)
    if (wasView && !view) giveBack(spot(inMain), 10);
    wasView = view;
  }
  const seen = new MutationObserver(front);
  for (const x of questions.concat(views, [tour])) seen.observe(x, { attributes: true, attributeFilter: ['hidden'] });
  // (Tab goes round the question's own buttons, never out of it)
  window.addEventListener('keydown', (e) => {
    const q = e.key === 'Tab' ? asking() : null;
    if (!q) return;
    const f = [...q.querySelectorAll('button, input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter((x) => !x.disabled && x.getClientRects().length);
    const i = f.indexOf(document.activeElement);
    if (!f.length) e.preventDefault();
    else if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); }
    else if (!e.shiftKey && (i < 0 || i === f.length - 1)) { e.preventDefault(); f[0].focus(); }
  }, true);
  // drop files anywhere on this window to send them to the phone
  let dragDepth = 0;
  const hasFiles = (e) => e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files');
  window.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; $('drop').hidden = false; });
  window.addEventListener('dragover', (e) => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('drop').hidden = true; });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); dragDepth = 0; $('drop').hidden = true;
    const paths = [...e.dataTransfer.files].map((f) => api.pathFor(f)).filter(Boolean);
    if (paths.length) act('sendPaths', paths);
  });
  $('edgeSend').onchange = (e) => set('edgeSend', e.target.checked);
  $('startup').onchange = (e) => set('startup', e.target.checked);
  $('display').onchange = (e) => set('displayId', e.target.value ? Number(e.target.value) : null);
  $('saveDir').onchange = (e) => {
    // (the dialog's answer comes as the setting; meanwhile, and if it's canceled, the select shows the setting as it is)
    if (e.target.value === 'choose') { act('chooseFolder'); if (S) e.target.value = S.saveDir === 'desktop' || S.saveDir === 'downloads' ? S.saveDir : 'custom'; }
    else set('saveDir', e.target.value);           // desktop, downloads, or custom: the folder chosen last
  };
  $('name').onchange = (e) => set('name', e.target.value);
  $('name').onkeydown = (e) => { if (e.key === 'Enter') e.target.blur(); };
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && $('pair').hidden && $('qs').hidden && $('askBox').hidden && $('quitAsk').hidden) act('hide'); });
})();
